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
import type { ClientConfig } from "pg";
import type { TurnControl, TurnLookInput, TurnLookRow } from "./types.js";
import { TURN_CONTROL_CHANNEL, TURN_CONTROL_EVENT_TYPES, TURN_CONTROL_LOOK_INTERVAL_MS } from "./turn-control-contract.js";

/** State of a turn's send gate (owned by ManagedSession). */
export type SteerGateState = "none" | "pending" | "open" | "closed";

/** What the live loop needs from the model run (implemented by ManagedSession). */
export interface TurnControlSessionPort {
    steerGateState(): SteerGateState;
    closeSteerGate(): void;
    /** Send a steer with mode "immediate". Resolves when sent; `onConfirmed` runs when the run confirms it. */
    sendSteer(text: string, onConfirmed: (messageId: string) => void): Promise<void>;
    /** Fail the running turn (a steer that could not be sent). */
    failTurn(err: unknown): void;
}

/**
 * The binding a running turn hands to ManagedSession.runTurn so that controls
 * arriving before the initial prompt is sent are held (plan P21).
 */
export interface TurnControlBinding {
    /** The reason of a Stop that arrived before the initial send, if any. ManagedSession then does not send. */
    heldStop(): string | null;
    /** ManagedSession opened the send gate after the initial send; held controls may now be applied. */
    gateOpened(): void;
}

export interface LiveTurnControlOptions {
    sessionId: string;
    turn: number;
    /** Position up to which controls are already taken (folded into the prompt, or saved). */
    start: number;
    port: TurnControlSessionPort;
    /** Abort the running model run (today's lock-bypassing abort). */
    abort: (reason: string) => Promise<unknown>;
    /** Best-effort durable record of a confirmed steer (session.steer_confirmed). */
    record?: (eventType: string, data: Record<string, unknown>) => Promise<void>;
    trace?: (message: string) => void;
}

export class LiveTurnControl implements TurnControlBinding {
    readonly sessionId: string;
    readonly turn: number;
    /** The last control taken from the CMS (sent, applied or held). */
    sent: number;
    /** The last steer the model run confirmed; saved with the turn. */
    cursor: number;
    private chain: Promise<void> = Promise.resolve();
    private held: TurnControl[] = [];
    private stopReason: string | null = null;
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

    /** Apply new controls, one at a time and in position order. */
    enqueue(controls: TurnControl[]): Promise<void> {
        const sorted = [...controls].sort((a, b) => a.seq - b.seq);
        this.chain = this.chain
            .then(() => this.apply(sorted))
            .catch((err) => this.opts.port.failTurn(err));
        return this.chain;
    }

    /** Resolves when every control enqueued so far has been applied. */
    idle(): Promise<void> {
        return this.chain;
    }

    heldStop(): string | null {
        return this.stopReason;
    }

    gateOpened(): void {
        const held = this.held;
        this.held = [];
        this.chain = this.chain
            .then(() => this.applyNow(held))
            .catch((err) => this.opts.port.failTurn(err));
    }

    private async apply(controls: TurnControl[]): Promise<void> {
        for (const control of controls) {
            if (control.seq <= this.sent) continue;              // a duplicate wake-up
            const gate = this.opts.port.steerGateState();
            if (gate === "closed") return;                       // settling or stopping: turn end labels the rest
            this.sent = control.seq;
            if (gate === "none" || gate === "pending") {
                // Before the initial prompt is sent: hold in order (plan P21).
                this.held.push(control);
                if (control.kind === "stop" && this.stopReason === null) this.stopReason = control.text;
                continue;
            }
            if (!(await this.applyOne(control))) return;
        }
    }

    private async applyNow(controls: TurnControl[]): Promise<void> {
        for (const control of controls) {
            if (this.opts.port.steerGateState() !== "open") return;
            if (!(await this.applyOne(control))) return;
        }
    }

    /** Applies one control to an open gate. Returns false when nothing more may be sent. */
    private async applyOne(control: TurnControl): Promise<boolean> {
        if (control.kind === "stop") {
            // Never send after an abort (spike cell C5b): close first.
            this.opts.port.closeSteerGate();
            this.opts.trace?.(`[turn-control] stop session=${this.sessionId} turn=${this.turn} seq=${control.seq}`);
            await this.opts.abort(control.text);
            return false;
        }
        await this.opts.port.sendSteer(control.text, (messageId) => this.confirmed(control, messageId));
        return true;
    }

    private confirmed(control: TurnControl, messageId: string): void {
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

export interface TurnControlHubOptions {
    catalog: { turnLook(turns: TurnLookInput[]): Promise<TurnLookRow[]> };
    /** The CMS schema; notifications from other schemas are ignored. */
    schema: string;
    /** Creates the LISTEN connection; null runs without notifications (periodic look only). */
    createClient?: (() => TurnControlListenClient | Promise<TurnControlListenClient>) | null;
    lookIntervalMs?: number;
    log?: (message: string) => void;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

export class TurnControlHub {
    private readonly live = new Map<string, LiveTurnControl>();
    private readonly opts: TurnControlHubOptions;
    private listener: TurnControlListenClient | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectDelayMs = RECONNECT_MIN_MS;
    private stopped = true;
    private connectedOnce = false;
    private lookCount = 0;

    constructor(opts: TurnControlHubOptions) {
        this.opts = opts;
    }

    /** Number of look queries made (diagnostics and tests). */
    get looks(): number {
        return this.lookCount;
    }

    /** Whether the LISTEN connection is up. */
    get listening(): boolean {
        return this.listener !== null;
    }

    async start(): Promise<void> {
        if (!this.stopped) return;
        this.stopped = false;
        const interval = this.opts.lookIntervalMs ?? TURN_CONTROL_LOOK_INTERVAL_MS;
        this.timer = setInterval(() => {
            if (this.live.size > 0) void this.lookAll();
        }, interval);
        (this.timer as any).unref?.();
        await this.connect();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        const listener = this.listener;
        this.listener = null;
        if (listener) await listener.end().catch(() => {});
    }

    /** Track a running turn and look once for controls that arrived before it registered. */
    register(turn: LiveTurnControl): void {
        this.live.set(turn.key, turn);
        void this.look([turn]);
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
        this.lookCount += 1;
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

    private async connect(): Promise<void> {
        const create = this.opts.createClient;
        if (!create || this.stopped) return;
        let client: TurnControlListenClient | null = null;
        try {
            client = await create();
            client.on("notification", (message) => {
                if (message.channel !== TURN_CONTROL_CHANNEL) return;
                let payload: { schema?: string; sessionId?: string } = {};
                try { payload = JSON.parse(message.payload ?? "{}"); } catch { return; }
                if (payload.schema !== this.opts.schema) return;
                void this.lookAll(payload.sessionId);
            });
            const lost = () => this.connectionLost(client!);
            client.on("error", lost);
            client.on("end", lost);
            await client.connect();
            await client.query(`LISTEN ${TURN_CONTROL_CHANNEL}`);
            if (this.stopped) {
                await client.end().catch(() => {});
                return;
            }
            this.listener = client;
            this.reconnectDelayMs = RECONNECT_MIN_MS;
            // After a reconnect, a notification may have been missed.
            if (this.connectedOnce) void this.lookAll();
            this.connectedOnce = true;
        } catch (err) {
            // A provider without LISTEN, or a database that is down: keep the
            // periodic look and try again later. Never fail the worker.
            this.opts.log?.(`[turn-control] LISTEN unavailable, using the ${this.opts.lookIntervalMs ?? TURN_CONTROL_LOOK_INTERVAL_MS} ms look: ${String((err as Error)?.message ?? err)}`);
            if (client) await client.end().catch(() => {});
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
        if (this.stopped || this.reconnectTimer) return;
        const delay = this.reconnectDelayMs;
        this.reconnectDelayMs = Math.min(RECONNECT_MAX_MS, this.reconnectDelayMs * 2);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);
        (this.reconnectTimer as any).unref?.();
    }
}

/** Build the LISTEN connection factory from a pg client config. */
export function pgListenClientFactory(config: ClientConfig): () => Promise<TurnControlListenClient> {
    return async () => {
        const { default: pg } = await import("pg");
        return new pg.Client({ application_name: "pilotswarm-turn-control", ...config, keepAlive: true }) as unknown as TurnControlListenClient;
    };
}

function turnKey(sessionId: string, turn: number): string {
    return `${sessionId}/${turn}`;
}
