/**
 * Session turn control on the worker: the per-worker notification hub and
 * the per-turn live control loop (design sections 4.4 and 4.5).
 *
 * - `TurnControlHub` holds one dedicated PostgreSQL connection that LISTENs
 *   on `pilotswarm_turn_control`. A notification only says "look": the hub
 *   then reads the new controls of the worker's running turns by position.
 *   While at least one turn runs, it also looks every 5 s, so a lost
 *   notification or a dead connection delays a control by at most that long.
 * - `LiveTurnControl` is one running turn. It applies controls in position
 *   order, once each: a Stop closes the send gate and aborts the model run;
 *   a Steer is sent to the run with the CLI's immediate mode. `sent` is the
 *   last control taken; `cursor` is the last steer the run confirmed.
 *
 * The class is named LiveTurnControl because live-turn.ts already exports the
 * streaming LiveTurn* types.
 *
 * @internal
 */
import type { TurnControl, TurnLookInput, TurnLookRow } from "./types.js";
import { TURN_CONTROL_CHANNEL, TURN_CONTROL_EVENT_TYPES, TURN_CONTROL_LOOK_INTERVAL_MS } from "./turn-control-contract.js";

/** State of a turn's send gate (owned by ManagedSession). */
export type SteerGateState = "pending" | "open" | "closed";

/**
 * One model run's send gate, handed by ManagedSession to the live loop when
 * the run starts and detached when it ends. Every call is bound to that run:
 * after the run ended the gate reads "closed", a send is refused, and a
 * failure no longer reaches any turn.
 */
export interface TurnControlSessionPort {
    gate(): SteerGateState;
    close(): void;
    /** Send a steer with mode "immediate". Resolves when sent; `onConfirmed` runs when the run confirms it. */
    sendSteer(text: string, onConfirmed: (messageId: string) => void): Promise<void>;
    /** Fail this run (a steer that could not be sent). No-op once the run ended. */
    failTurn(err: unknown): void;
}

/**
 * The binding a running turn hands to ManagedSession.runTurn. Controls that
 * arrive before the initial prompt is sent are held (plan P21).
 */
export interface TurnControlBinding {
    /** ManagedSession's run started: the port of its send gate. */
    attach(port: TurnControlSessionPort): void;
    /** The reason of a Stop that arrived before the initial send, if any. ManagedSession then does not send. */
    heldStop(): string | null;
    /** ManagedSession opened the send gate after the initial send; held controls may now be applied. */
    gateOpened(): void;
    /** ManagedSession's run ended. */
    detach(): void;
}

export interface LiveTurnControlOptions {
    sessionId: string;
    turn: number;
    /** Position up to which controls are already taken (folded into the prompt, or saved). */
    start: number;
    /** Abort the running model run (today's lock-bypassing abort). */
    abort: (reason: string) => Promise<unknown>;
    /** Best-effort durable record of a confirmed steer (session.steer_confirmed). */
    record?: (eventType: string, data: Record<string, unknown>) => Promise<void>;
    trace?: (message: string) => void;
}

/**
 * One turn's CMS delivery bookkeeping. `sent` deduplicates controls taken
 * during this attempt; only confirmed steers advance the recoverable `cursor`.
 * The activity owns registration and the final outcome write.
 *
 * Controls wait in one queue ordered by position. A drain applies them only
 * while the gate is open, lowest position first, so controls held before a
 * send always go before later ones. A Stop never waits: once the gate is open
 * it closes the gate and aborts at once, also while an earlier steer's send
 * has not returned; steers still queued then are not sent (the stopped turn
 * labels them not delivered). Once the turn is retired, or its run ended,
 * nothing more is sent and no confirmation moves the cursor.
 */
export class LiveTurnControl implements TurnControlBinding {
    readonly sessionId: string;
    readonly turn: number;
    /** The last control taken from the CMS (queued, sent or applied). */
    sent: number;
    /** The last steer the model run confirmed; saved with the turn. */
    cursor: number;
    private chain: Promise<void> = Promise.resolve();
    private readonly queue: TurnControl[] = [];
    private port: TurnControlSessionPort | null = null;
    private runEnded = false;
    private retired = false;
    /** A Stop was applied: nothing more is sent; a late send failure no longer fails the turn. */
    private stopping = false;
    private stopDone: Promise<void> = Promise.resolve();
    private readonly opts: LiveTurnControlOptions;

    constructor(opts: LiveTurnControlOptions) {
        this.opts = opts;
        this.sessionId = opts.sessionId;
        this.turn = opts.turn;
        this.sent = opts.start;
        this.cursor = opts.start;
    }

    get key(): string {
        return turnKey(this.sessionId, this.turn);
    }

    lookArgs(): TurnLookInput {
        return { sessionId: this.sessionId, turn: this.turn, after: this.sent };
    }

    /** Take new controls; they are applied one at a time, in position order. */
    enqueue(controls: TurnControl[]): Promise<void> {
        if (this.retired) return this.chain;
        for (const control of [...controls].sort((a, b) => a.seq - b.seq)) {
            if (control.seq <= this.sent) continue;              // a duplicate wake-up
            this.sent = control.seq;
            this.queue.push(control);
        }
        const stop = this.queue.find((c) => c.kind === "stop");
        if (stop && this.gate() === "open") return this.applyStop(stop);
        return this.drainSoon();
    }

    attach(port: TurnControlSessionPort): void {
        if (this.retired) return;
        this.port = port;
        this.runEnded = false;
    }

    heldStop(): string | null {
        return this.queue.find((c) => c.kind === "stop")?.text ?? null;
    }

    gateOpened(): void {
        void this.drainSoon();
    }

    detach(): void {
        this.runEnded = true;
        this.port = null;
    }

    /**
     * The model run's conversation was lost and the turn re-runs from the
     * start prompt: steers applied to the lost conversation are no longer in
     * it. Later controls continue from `sent`; turn end carries the rest.
     */
    conversationLost(): void {
        this.cursor = this.opts.start;
    }

    /** The turn is over: drop queued controls, send nothing more, ignore late confirmations. */
    retire(): void {
        this.retired = true;
        this.queue.length = 0;
    }

    private gate(): SteerGateState {
        if (this.retired || this.runEnded) return "closed";
        return this.port ? this.port.gate() : "pending";
    }

    private drainSoon(): Promise<void> {
        this.chain = this.chain
            .then(() => this.drain())
            .catch((err) => {
                const port = this.port;
                if (!this.retired && !this.stopping && port) port.failTurn(err);
            });
        return this.chain;
    }

    private async drain(): Promise<void> {
        while (this.queue.length > 0 && !this.stopping) {
            // Pending: before a send (P21). Closed: settling, or the run ended;
            // held until a corrective run opens the gate again, else turn end
            // labels them.
            if (this.gate() !== "open") return;
            const stop = this.queue.find((c) => c.kind === "stop");
            if (stop) {
                await this.applyStop(stop);
                return;
            }
            const control = this.queue.shift()!;
            await this.port!.sendSteer(control.text, (messageId) => this.confirmed(control, messageId));
        }
    }

    /** Close the gate, drop what is queued and abort, independently of any send still in flight. */
    private applyStop(control: TurnControl): Promise<void> {
        const port = this.port;
        if (this.stopping || !port) return this.stopDone;
        this.stopping = true;
        // Never send after an abort (spike cell C5b): close first.
        port.close();
        this.queue.length = 0;
        this.opts.trace?.(`[turn-control] stop session=${this.sessionId} turn=${this.turn} seq=${control.seq}`);
        this.stopDone = this.opts.abort(control.text).then(() => {}, (err) => {
            if (!this.retired) port.failTurn(err);
        });
        return this.stopDone;
    }

    private confirmed(control: TurnControl, messageId: string): void {
        if (this.retired) return;
        this.cursor = Math.max(this.cursor, control.seq);
        this.opts.trace?.(`[turn-control] steer-confirmed session=${this.sessionId} turn=${this.turn} seq=${control.seq} messageId=${messageId}`);
        const record = this.opts.record;
        if (record) {
            void record(TURN_CONTROL_EVENT_TYPES.steerConfirmed, { seq: control.seq, turn: this.turn, messageId }).catch(() => {});
        }
    }
}

/** A pg.Client-like LISTEN connection. */
export interface TurnControlListenClient {
    connect(): Promise<unknown>;
    query(text: string): Promise<unknown>;
    end(): Promise<unknown>;
    on(event: "notification", listener: (message: { channel: string; payload?: string }) => void): unknown;
    on(event: "error" | "end", listener: (err?: unknown) => void): unknown;
}

/** Timers the hub uses; tests replace them to drive the look and the reconnect by hand. */
export interface TurnControlHubTimers {
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const NODE_TIMERS: TurnControlHubTimers = {
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); (h as any).unref?.(); return h; },
    clearInterval: (h) => clearInterval(h as any),
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); (h as any).unref?.(); return h; },
    clearTimeout: (h) => clearTimeout(h as any),
};

export interface TurnControlHubOptions {
    catalog: { turnLook(turns: TurnLookInput[]): Promise<TurnLookRow[]> };
    /** The CMS schema; notifications from other schemas are ignored. */
    schema: string;
    /** Creates the LISTEN connection; null runs without notifications (periodic look only). */
    createClient?: (() => TurnControlListenClient | Promise<TurnControlListenClient>) | null;
    lookIntervalMs?: number;
    log?: (message: string) => void;
    /** Defaults to Node timers, unref'd so the hub never keeps a process alive. */
    timers?: TurnControlHubTimers;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

/**
 * Worker-owned notification listener and registry of running controlled turns.
 * Notifications are hints; the catalog's positional read is authoritative.
 * The activity registers a live loop, then unregisters that exact instance.
 *
 * Connection attempts run one at a time and belong to one start..stop span
 * (the generation): stop() ends a connecting client and waits for the
 * attempt, so no listener is published after stop and none leaks.
 */
export class TurnControlHub {
    private readonly live = new Map<string, LiveTurnControl>();
    private readonly opts: TurnControlHubOptions;
    private readonly timers: TurnControlHubTimers;
    private listener: TurnControlListenClient | null = null;
    private pendingClient: TurnControlListenClient | null = null;
    private connecting: Promise<void> | null = null;
    private starting: { generation: number; ready: Promise<boolean> } | null = null;
    private timer: unknown = null;
    private reconnectTimer: unknown = null;
    private reconnectDelayMs = RECONNECT_MIN_MS;
    private stopped = true;
    private generation = 0;
    private connectedOnce = false;

    constructor(opts: TurnControlHubOptions) {
        this.opts = opts;
        this.timers = opts.timers ?? NODE_TIMERS;
    }

    /** Whether the LISTEN connection is up. */
    get listening(): boolean {
        return this.listener !== null;
    }

    async start(): Promise<void> {
        if (!this.stopped) return;
        // Concurrent starts share one claim on the next generation; stop()
        // invalidates it. Only a claim that is still current when the earlier
        // span's attempt has finished starts the hub, so a stale start never
        // revives a stopped hub nor installs a second interval.
        let claim = this.starting;
        if (!claim || claim.generation !== this.generation) {
            const generation = ++this.generation;
            const ready = this.claim(generation);
            const own = { generation, ready };
            claim = own;
            this.starting = own;
            void ready.finally(() => { if (this.starting === own) this.starting = null; }).catch(() => {});
        }
        if (await claim.ready) await this.connect();
    }

    private async claim(generation: number): Promise<boolean> {
        // An attempt from an earlier start..stop span must finish first.
        while (this.connecting) await this.connecting;
        if (generation !== this.generation || !this.stopped) return false;
        this.stopped = false;
        this.reconnectDelayMs = RECONNECT_MIN_MS;
        const interval = this.opts.lookIntervalMs ?? TURN_CONTROL_LOOK_INTERVAL_MS;
        this.timer = this.timers.setInterval(() => {
            if (this.live.size > 0) void this.lookAll();
        }, interval);
        return true;
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.generation += 1;
        if (this.timer !== null) this.timers.clearInterval(this.timer);
        this.timer = null;
        if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        const listener = this.listener;
        this.listener = null;
        const pending = this.pendingClient;
        this.pendingClient = null;
        // Ending a connecting client makes its connect() or LISTEN fail.
        if (pending) await pending.end().catch(() => {});
        if (listener) await listener.end().catch(() => {});
        if (this.connecting) await this.connecting;
    }

    /** Track a running turn and look once for controls that arrived before it registered. */
    register(turn: LiveTurnControl): Promise<void> {
        this.live.set(turn.key, turn);
        return this.look([turn]);
    }

    unregister(turn: LiveTurnControl): void {
        if (this.live.get(turn.key) === turn) this.live.delete(turn.key);
    }

    /** Look for new controls of every running turn, or of one session's turns. */
    async lookAll(sessionId?: string): Promise<void> {
        const turns = [...this.live.values()].filter((t) => !sessionId || t.sessionId === sessionId);
        await this.look(turns);
    }

    private async look(turns: LiveTurnControl[]): Promise<void> {
        if (turns.length === 0) return;
        let rows: TurnLookRow[];
        try {
            rows = await this.opts.catalog.turnLook(turns.map((t) => t.lookArgs()));
        } catch (err) {
            this.opts.log?.(`[turn-control] look failed: ${String((err as Error)?.message ?? err)}`);
            return;
        }
        for (const row of rows) {
            if (row.controls.length === 0) continue;
            void this.live.get(turnKey(row.sessionId, row.turn))?.enqueue(row.controls);
        }
    }

    /** Single-flight: a second call joins the running attempt. */
    private connect(): Promise<void> {
        if (!this.opts.createClient || this.stopped) return Promise.resolve();
        if (!this.connecting) {
            const generation = this.generation;
            this.connecting = this.attempt(generation).finally(() => { this.connecting = null; });
        }
        return this.connecting;
    }

    private async attempt(generation: number): Promise<void> {
        const current = () => !this.stopped && generation === this.generation;
        let client: TurnControlListenClient | null = null;
        let failed: unknown = null;
        try {
            client = await this.opts.createClient!();
            if (!current()) {
                await client.end().catch(() => {});
                return;
            }
            this.pendingClient = client;
            const own = client;
            own.on("notification", (message) => {
                if (this.listener !== own || message.channel !== TURN_CONTROL_CHANNEL) return;
                let payload: { schema?: string; sessionId?: string } = {};
                try { payload = JSON.parse(message.payload ?? "{}"); } catch { return; }
                if (payload.schema !== this.opts.schema) return;
                void this.lookAll(payload.sessionId);
            });
            const lost = (err?: unknown) => {
                if (this.listener === own) this.connectionLost(own);
                else if (this.pendingClient === own && failed === null) failed = err ?? new Error("connection ended during setup");
            };
            own.on("error", lost);
            own.on("end", lost);
            await own.connect();
            await own.query(`LISTEN ${TURN_CONTROL_CHANNEL}`);
            if (this.pendingClient === own) this.pendingClient = null;
            if (!current() || failed !== null) {
                await own.end().catch(() => {});
                if (failed !== null && current()) throw failed;
                return;
            }
            this.listener = own;
            this.reconnectDelayMs = RECONNECT_MIN_MS;
            // After a reconnect, a notification may have been missed.
            if (this.connectedOnce) void this.lookAll();
            this.connectedOnce = true;
        } catch (err) {
            if (client && this.pendingClient === client) this.pendingClient = null;
            if (client) await client.end().catch(() => {});
            if (!current()) return;
            // A provider without LISTEN, or a database that is down: keep the
            // periodic look and try again later. Never fail the worker.
            this.opts.log?.(`[turn-control] LISTEN unavailable, using the ${this.opts.lookIntervalMs ?? TURN_CONTROL_LOOK_INTERVAL_MS} ms look: ${String((err as Error)?.message ?? err)}`);
            this.scheduleReconnect();
        }
    }

    private connectionLost(client: TurnControlListenClient): void {
        if (this.listener !== client) return;
        this.listener = null;
        void client.end().catch(() => {});
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.reconnectTimer !== null) return;
        const delay = this.reconnectDelayMs;
        this.reconnectDelayMs = Math.min(RECONNECT_MAX_MS, this.reconnectDelayMs * 2);
        this.reconnectTimer = this.timers.setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);
    }
}

function turnKey(sessionId: string, turn: number): string {
    return `${sessionId}/${turn}`;
}
