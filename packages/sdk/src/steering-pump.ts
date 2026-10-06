/**
 * Session steering: the admission gate and the steering pump that runs
 * inside one `ManagedSession.runTurn()` (docs/proposals/session-steering.md
 * §6a.4, §6a.5, §7.6).
 *
 * The pump is storage-agnostic: it talks to a `SteeringChannel` that the
 * runTurn activity implements with the `cms_steer_*` procedures.
 *
 * Invariants (names from §7.6):
 *  - INV-P0  No hand-off after an idle, Stop, terminal turn boundary or release.
 *  - INV-P1  The gate is re-checked after every awaited call.
 *  - INV-P2  The durable write-ahead marker commits BEFORE send().
 *  - INV-P3  The attempt is registered locally before send().
 *  - INV-P4  No await between the final gate check and send().
 *  - INV-P5  Delivery evidence is idempotent per SDK message id.
 *  - INV-P6  reconcileAfterIdle never returns with live registered work unless
 *            the session was positively quiesced.
 *  - INV-P8  Absence of evidence is recorded as unconfirmed, never as "not delivered".
 *  - INV-P9  Quiescence is bounded and positively confirmed, or it throws.
 *  - INV-P11 A wall-clock cap or watchdog stays a failure.
 *  - INV-P12 An unavailable history read is never a hit.
 *  - INV-P13 After release no startup can arm a lease, open the gate or start a sender.
 */

import { isNativeChildEvent } from "./native-subagents.js";
import { buildSteeringPrompt } from "./steering-prompt.js";
import type {
    SteerRecoveredRow,
    SteerRow,
    SteeringChannel,
    SteeringDeliveryKind,
    SteeringManifest,
} from "./steering-types.js";

/** The only answer to "may we call send() now?" Closed once, never reopened in a turn. */
export class SteeringGate {
    private state: "closed" | "open" | "closing" = "closed";
    open(): void { if (this.state === "closed") this.state = "open"; }
    /** Synchronous. After this, open() is a no-op for the rest of the turn. */
    close(): void { this.state = "closing"; }
    get isOpen(): boolean { return this.state === "open"; }
    get hasClosed(): boolean { return this.state === "closing"; }
}

/**
 * Raised when quiescence of the warm session cannot be confirmed. The message
 * matches the orchestration's connection-closed classifier, so the turn takes
 * the existing retry path on a fresh session and the untrusted local state is
 * not committed.
 */
export class SteeringQuiesceFailedError extends Error {
    constructor(detail = "steering quiescence was not confirmed") {
        super(`Connection is closed: ${detail}; the warm session was discarded and the turn will be retried`);
        this.name = "SteeringQuiesceFailedError";
    }
}

/** The narrow CopilotSession surface the pump uses. */
export interface SteeringSdkSession {
    on(eventType: string, handler: (event: any) => void): () => void;
    send(options: { prompt: string; displayPrompt?: string; mode?: "enqueue" | "immediate" }): Promise<string>;
    getEvents(): Promise<any[]>;
}

export interface SteeringPumpOptions {
    /** A user Stop was requested for this turn. */
    stopping(): boolean;
    /** A control tool recorded a terminal turn boundary (wait / ask_user / ...). */
    turnBoundaryScheduled(): boolean;
    /** Lock-held, per-session disconnect of the warm handle. True only when it resolved. */
    quiesceWarmSession(): Promise<boolean>;
    /** Re-check the original actor's write access before hand-off (NFR-10). */
    authorize?(row: SteerRow): Promise<boolean>;
    trace?(message: string): void;
    scanMs?: number;
    claimBatch?: number;
    maxUnconfirmed?: number;
    sendTimeoutMs?: number;
    settleMs?: number;
    quiesceMs?: number;
    ioTimeoutMs?: number;
    renewMs?: number;
}

const DEFAULTS = {
    scanMs: 1_000,
    claimBatch: 5,
    maxUnconfirmed: 5,
    sendTimeoutMs: 5_000,
    settleMs: 30_000,
    quiesceMs: 10_000,
    ioTimeoutMs: 5_000,
    renewMs: 2_000,
};

const TIMEOUT: unique symbol = Symbol("timeout");
type Bounded<T> = T | typeof TIMEOUT;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        (t as any).unref?.();
    });
}

/** Race a promise against a timer; returns TIMEOUT instead of hanging. Rejections become TIMEOUT too. */
async function bounded<T>(p: Promise<T> | undefined, ms: number): Promise<Bounded<T | undefined>> {
    if (!p) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race<Bounded<T>>([
            p.catch((): typeof TIMEOUT => TIMEOUT),
            new Promise<typeof TIMEOUT>((resolve) => {
                timer = setTimeout(() => resolve(TIMEOUT), ms);
                (timer as any).unref?.();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Serialized, awaited receipt writes with a bounded retry. Failures are counted and traced, never hidden. */
class SerialWrites {
    private tail: Promise<void> = Promise.resolve();
    failures = 0;
    constructor(private readonly trace: (m: string) => void) {}
    push(label: string, fn: () => Promise<unknown>): Promise<void> {
        const run = async () => {
            let lastErr: unknown;
            for (const delay of [0, 100, 400]) {
                if (delay) await sleep(delay);
                try { await fn(); return; } catch (err) { lastErr = err; }
            }
            this.failures++;
            this.trace(`[steering] receipt write failed (${label}): ${(lastErr as any)?.message ?? String(lastErr)}`);
        };
        this.tail = this.tail.then(run, run);
        return this.tail;
    }
    drain(): Promise<void> { return this.tail; }
}

interface Attempt {
    row: SteerRow;
    attemptId: string;
    sdkMessageId?: string;
    event?: any;
    /** Correlated by id but with no recognized delivery kind: evidence-only, so unconfirmed. */
    uncertain?: boolean;
}

const DELIVERY_KINDS = new Set<SteeringDeliveryKind>(["steering", "queued", "idle"]);

export class SteeringPump {
    readonly gate = new SteeringGate();
    private readonly o: Required<Omit<SteeringPumpOptions, "authorize" | "trace">> & Pick<SteeringPumpOptions, "authorize">;
    private readonly trace: (m: string) => void;
    private readonly attempts = new Map<string, Attempt>();
    private readonly byMessageId = new Map<string, string>();
    private readonly earlyEvents = new Map<string, any>();
    private readonly seen = new Set<string>();
    private readonly unsubs: Array<() => void> = [];
    private readonly writes: SerialWrites;
    private waiters: Array<() => void> = [];
    private wakeLoop: (() => void) | null = null;
    private idleCount = 0;
    private runsStartedBySteer = 0;
    private mainPromptId?: string;
    private mainPromptSeen = false;
    private startup?: Promise<void>;
    private loop?: Promise<void>;
    private leaseTimer?: ReturnType<typeof setInterval>;
    private windowOpened = false;
    /** Steers found in resumed LOCAL state on recovery: in this attempt's conversation, so in its manifest. */
    private readonly recoveredLocal: Array<{ requestId: string; sdkMessageId: string; kind: SteeringDeliveryKind | null }> = [];
    private needsQuiesce = false;
    private quiesced = false;
    private released = false;
    /** Diagnostics for tests and traces. */
    readonly stats = {
        scans: 0, claimed: 0, sent: 0, delivered: 0, sendTimeouts: 0, sendErrors: 0, released: 0, wakes: 0,
        leaseLost: 0, startupFailed: 0, authorizationRefused: 0, quiesced: 0, quiesceFailed: 0, unclassified: 0,
    };

    constructor(private readonly session: SteeringSdkSession, private readonly ch: SteeringChannel, options: SteeringPumpOptions) {
        this.o = {
            ...DEFAULTS,
            ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)),
        } as any;
        this.trace = options.trace ?? (() => {});
        this.writes = new SerialWrites(this.trace);
        // Attached BEFORE the main send (§6a.4): nothing the CLI emits can be missed.
        this.unsubs.push(session.on("user.message", (e: any) => { if (!isNativeChildEvent(e)) this.onUserMessage(e); }));
        this.unsubs.push(session.on("session.idle", (e: any) => {
            if (isNativeChildEvent(e)) return;
            this.idleCount++;
            this.gate.close();
            this.notify();
        }));
        if (ch.onWake) this.unsubs.push(ch.onWake(() => { this.stats.wakes++; this.wake(); }));
    }

    /** Called with the id the main prompt's send() returned. */
    noteMainPrompt(sdkMessageId: string): void {
        this.mainPromptId = sdkMessageId;
        if (this.earlyEvents.delete(sdkMessageId)) this.mainPromptSeen = true;
        if (this.mainPromptSeen) this.beginStartup();
    }

    /** True once the window opened and the gate was opened at least once. */
    get windowWasOpened(): boolean { return this.windowOpened; }

    private beginStartup(): void {                                    // exactly one tracked startup
        if (this.startup) return;
        this.startup = this.start().catch((err) => {
            this.stats.startupFailed++;
            this.gate.close();
            this.trace(`[steering] startup failed: ${err?.message ?? String(err)}`);
        });
    }

    private stillEligible(): boolean {                                // INV-P0
        return !this.released && this.idleCount === 0 && !this.o.stopping() && !this.o.turnBoundaryScheduled();
    }

    private canSend(): boolean { return this.gate.isOpen && this.stillEligible(); }

    private async start(): Promise<void> {
        if (this.loop || !this.stillEligible()) return;
        const opened = await this.ch.openWindow();
        this.windowOpened = opened.ok;
        if (!opened.ok) {
            this.trace(`[steering] window not opened: ${opened.reason ?? "refused"}`);
            return;
        }
        if (!this.stillEligible()) return;                            // INV-P13; settle quiesces it
        const withIds = opened.recovered.filter((r) => r.sdkMessageId);
        if (withIds.length > 0) await this.recoveryCheck(withIds);
        if (!this.stillEligible()) return;                            // INV-P13
        this.leaseTimer = setInterval(() => void this.renewLease(), this.o.renewMs);
        (this.leaseTimer as any).unref?.();
        this.gate.open();
        this.loop = this.run();
    }

    /** D-28: one complete read of the restored conversation; a failed read never permits a resend. */
    private async recoveryCheck(rows: SteerRecoveredRow[]): Promise<void> {
        let history: any[] | null = null;
        try { history = await this.session.getEvents(); } catch { history = null; }
        for (const row of rows) {
            if (history === null || !Array.isArray(history)) {
                await this.ch.recordRecoveryCheck(row.requestId, "failed");   // INV-P7
                continue;
            }
            const ids = new Set(row.sdkMessageIds.length > 0 ? row.sdkMessageIds : [row.sdkMessageId!]);
            const hit = history.find((h) => h?.type === "user.message" && ids.has(h?.data?.messageId) && !isNativeChildEvent(h));
            if (!hit) { await this.ch.recordRecoveryCheck(row.requestId, "absent"); continue; }
            if (this.ch.recoverySource === "restored") {
                await this.ch.recordRecoveryCheck(row.requestId, "present", hit.data.messageId);   // stored base: included
                continue;
            }
            // Local state this activity resumed: delivered, not resent; inclusion follows this commit.
            await this.ch.recordRecoveryCheck(row.requestId, "present_local", hit.data.messageId);
            const raw = hit?.data?.delivery;
            this.recoveredLocal.push({
                requestId: row.requestId,
                sdkMessageId: hit.data.messageId,
                kind: DELIVERY_KINDS.has(raw) ? raw : null,
            });
        }
    }

    private async renewLease(): Promise<void> {
        if (this.released) { if (this.leaseTimer) clearInterval(this.leaseTimer); return; }   // INV-P13
        const ok = await this.ch.renew().catch(() => false);
        if (!ok && !this.released) {
            this.stats.leaseLost++;
            this.trace("[steering] lease renewal refused; closing admission for this turn");
            this.gate.close();
            this.wake();
        }
    }

    private unconfirmedCount(): number {
        let n = 0;
        for (const a of this.attempts.values()) if (!a.event) n++;   // uncertain attempts still count
        return n;
    }

    private async run(): Promise<void> {
        try {
            while (this.gate.isOpen) {
                if (!this.stillEligible()) { this.gate.close(); break; }
                this.stats.scans++;
                const room = this.o.maxUnconfirmed - this.unconfirmedCount();
                if (room > 0) {
                    let rows: SteerRow[] = [];
                    try { rows = await this.ch.claim(Math.min(this.o.claimBatch, room)); }
                    catch (err: any) { this.trace(`[steering] claim failed: ${err?.message ?? err}`); }
                    this.stats.claimed += rows.length;
                    for (const row of rows) {
                        if (!this.canSend()) break;                   // claimed rows close as never invoked
                        if (this.o.authorize) {
                            const allowed = await this.o.authorize(row).catch(() => false);
                            if (!allowed) {
                                this.stats.authorizationRefused++;
                                this.trace(`[steering] request ${row.requestId}: author no longer has write access; not handed off`);
                                continue;
                            }
                            if (!this.canSend()) break;               // INV-P1
                        }
                        let ws: { attemptId: string } | null = null;
                        try { ws = await this.ch.markSubmitting(row.requestId); }  // INV-P2
                        catch (err: any) { this.trace(`[steering] write-ahead failed: ${err?.message ?? err}`); }
                        if (!ws) continue;
                        const attemptId = ws.attemptId;
                        if (!this.canSend()) {                        // INV-P1
                            this.stats.released++;
                            await this.writes.push("released", () => this.ch.markReleased(attemptId));
                            break;
                        }
                        const a: Attempt = { row, attemptId };
                        this.attempts.set(attemptId, a);              // INV-P3
                        // INV-P4: no await between canSend() above and this call.
                        let call: Promise<string>;
                        try {
                            call = Promise.resolve(this.session.send({
                                prompt: buildSteeringPrompt(row), displayPrompt: row.text, mode: "immediate",
                            }));
                        } catch (err) {
                            call = Promise.reject(err);
                        }
                        this.stats.sent++;
                        call.then((id) => this.bind(a, id), () => {});    // a timed-out call can still return an id
                        const outcome = await Promise.race([
                            call.then((id) => ({ kind: "ok" as const, id }), (err) => ({ kind: "error" as const, err })),
                            sleep(this.o.sendTimeoutMs).then(() => ({ kind: "timeout" as const })),
                        ]);
                        if (outcome.kind === "ok") { this.bind(a, outcome.id); continue; }
                        // Unknown: the call may still start a run (timeout) or never reached the CLI (error).
                        this.writes.push("unconfirmed", () => this.ch.markUnconfirmed(attemptId));
                        if (outcome.kind === "timeout") { this.stats.sendTimeouts++; this.needsQuiesce = true; }
                        else { this.stats.sendErrors++; this.trace(`[steering] send failed: ${(outcome.err as any)?.message ?? outcome.err}`); }
                        this.gate.close();
                        break;
                    }
                }
                if (!this.gate.isOpen) break;
                await this.sleepOrWake(this.o.scanMs);
            }
        } catch (err: any) {
            this.gate.close();
            this.trace(`[steering] pump loop failed: ${err?.message ?? String(err)}`);
        }
    }

    private sleepOrWake(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const t = setTimeout(done, ms);
            (t as any).unref?.();
            const self = this;
            function done() { clearTimeout(t); if (self.wakeLoop === done) self.wakeLoop = null; resolve(); }
            this.wakeLoop = done;
        });
    }

    private wake(): void { const w = this.wakeLoop; this.wakeLoop = null; w?.(); }

    private notify(): void {
        const ws = this.waiters;
        this.waiters = [];
        for (const w of ws) w();
    }

    private nextChange(): Promise<void> { return new Promise((resolve) => this.waiters.push(resolve)); }

    private onUserMessage(e: any): void {
        const id: string | undefined = e?.data?.messageId;
        if (!id) return;
        if (!this.mainPromptSeen && id === this.mainPromptId) {
            this.mainPromptSeen = true;
            this.beginStartup();
            return;
        }
        const attemptId = this.byMessageId.get(id);
        if (!attemptId) {                                             // before send() resolved, or not ours
            if (this.earlyEvents.size < 256) this.earlyEvents.set(id, e);
            return;
        }
        this.recordDelivery(this.attempts.get(attemptId)!, e);
    }

    private bind(a: Attempt, sdkMessageId: string): void {
        if (a.sdkMessageId || typeof sdkMessageId !== "string" || !sdkMessageId) return;
        a.sdkMessageId = sdkMessageId;
        this.byMessageId.set(sdkMessageId, a.attemptId);
        this.writes.push("submitted", () => this.ch.markSubmitted(a.attemptId, sdkMessageId));
        const early = this.earlyEvents.get(sdkMessageId);
        if (early) { this.earlyEvents.delete(sdkMessageId); this.recordDelivery(a, early); }
        this.notify();
    }

    private recordDelivery(a: Attempt, e: any): void {
        if (!a.sdkMessageId || this.seen.has(a.sdkMessageId)) return; // INV-P5
        this.seen.add(a.sdkMessageId);
        const raw = e?.data?.delivery;
        if (!DELIVERY_KINDS.has(raw)) {
            // Labels are evidence-only (D-17): never guess the timing. The steer may have
            // started its own run (an unrecognized `idle`), so ownership ends with quiescence.
            this.trace(`[steering] user.message without a recognized delivery kind (${String(raw)}); recorded as unconfirmed`);
            a.uncertain = true;
            this.stats.unclassified++;
            this.needsQuiesce = true;
            const attemptId = a.attemptId;
            this.writes.push("unconfirmed", () => this.ch.markUnconfirmed(attemptId));
            this.notify();
            return;
        }
        a.event = e;
        const kind = raw as SteeringDeliveryKind;
        if (kind === "idle") this.runsStartedBySteer++;               // a late send started a new run (S-4 C4c)
        this.stats.delivered++;
        const id = a.sdkMessageId;
        this.writes.push("delivered", () => this.ch.markDelivered(a.attemptId, id, kind));
        this.notify();
    }

    private unresolved(): Attempt[] {
        return [...this.attempts.values()].filter((a) => !a.event && !a.uncertain);
    }

    /**
     * After the turn's first session.idle, before the correction loops. Not
     * called when stopping. Waits until every registered send has its
     * correlated event and every run a late send started has ended, raced
     * against the turn guards and the settle deadline (D-11).
     */
    async reconcileAfterIdle(o: { guards: Promise<void>[] }): Promise<void> {
        this.gate.close();
        this.wake();
        const settled = (): boolean => this.unresolved().length === 0 && this.idleCount >= 1 + this.runsStartedBySteer;
        // An unconfirmed hand-off (send timeout, unclassified delivery) may still run: ownership
        // ends only with positively confirmed quiescence, never by returning early (INV-P6).
        if (settled() && !this.needsQuiesce) return;
        let stop = false;
        const done = (async () => {
            while (!stop && !settled()) await this.nextChange();
            return "settled" as const;
        })();
        let guardError: unknown;
        const outcome = await Promise.race([
            done,
            sleep(this.o.settleMs).then(() => "deadline" as const),
            ...o.guards.map((g) => g.then(() => "guard" as const, (err) => { guardError = err; return "guard" as const; })),
        ]);
        stop = true;
        this.notify();
        if (outcome !== "settled" || this.needsQuiesce) {
            this.trace(`[steering] settle ${outcome}: ${this.unresolved().length} send(s) without evidence; quiescing the session`);
            await this.quiesceSession();                              // INV-P6
        }
        if (outcome === "guard") throw guardError;                    // INV-P11
    }

    private async findInHistory(sdkMessageId: string): Promise<any | null> {
        const events = await this.session.getEvents();
        if (!Array.isArray(events)) throw new Error("history unavailable");
        return events.find((e) => e?.type === "user.message" && e?.data?.messageId === sdkMessageId && !isNativeChildEvent(e)) ?? null;
    }

    private async quiesceSession(): Promise<void> {                  // INV-P9
        if (this.quiesced) return;
        const ok = await Promise.race([
            this.o.quiesceWarmSession().catch(() => false),
            sleep(this.o.quiesceMs).then(() => false),
        ]);
        if (!ok) { this.stats.quiesceFailed++; throw new SteeringQuiesceFailedError(); }
        this.stats.quiesced++;
        this.quiesced = true;
    }

    /**
     * Ends the pump for this turn. Returns the manifest of delivered steers,
     * or undefined when stopping or when no window was opened.
     */
    async settle(o: { stopping: boolean }): Promise<SteeringManifest | undefined> {
        try {
            return await this.settleInner(o);
        } finally {
            await this.flushCounters();
        }
    }

    /** Durable §11 counters, once per turn; bounded and best-effort (never fails the turn). */
    private countersFlushed = false;
    private async flushCounters(): Promise<void> {
        if (this.countersFlushed || !this.ch.recordCounters) return;
        this.countersFlushed = true;
        if (!this.startup && this.stats.scans === 0) return;          // no steering activity this turn
        const s = this.stats;
        const counts: Record<string, number> = {
            "pump:turns": 1, "pump:scans": s.scans, "pump:claimed": s.claimed, "pump:sent": s.sent,
            "pump:delivered": s.delivered, "pump:wakes": s.wakes, "pump:released": s.released,
            "pump:send_timeouts": s.sendTimeouts, "pump:send_errors": s.sendErrors,
            "pump:receipt_write_failures": this.writes.failures, "pump:lease_lost": s.leaseLost,
            "pump:startup_failed": s.startupFailed, "pump:authorization_refused": s.authorizationRefused,
            "pump:unclassified_delivery": s.unclassified, "pump:quiesced": s.quiesced, "pump:quiesce_failed": s.quiesceFailed,
        };
        const r = await bounded(this.ch.recordCounters(counts).catch((err) => {
            this.trace(`[steering] counter write failed: ${err?.message ?? String(err)}`);
        }), this.o.ioTimeoutMs);
        if (r === TIMEOUT) this.trace("[steering] counter write timed out");
    }

    private async settleInner(o: { stopping: boolean }): Promise<SteeringManifest | undefined> {
        this.released = true;                                         // INV-P13: before any await
        this.gate.close();
        if (this.leaseTimer) clearInterval(this.leaseTimer);
        this.wake();
        if ((await bounded(this.startup, this.o.ioTimeoutMs)) === TIMEOUT) {
            // openWindow is not cancelled: tombstone the target so a late open can never commit (§6a.9).
            if ((await bounded(this.ch.abandonWindow(), this.o.ioTimeoutMs)) === TIMEOUT) this.needsQuiesce = true;
        }
        if ((await bounded(this.loop, this.o.sendTimeoutMs + this.o.ioTimeoutMs)) === TIMEOUT) this.needsQuiesce = true;
        for (const a of this.unresolved()) {
            let hit: any | null = null;
            if (a.sdkMessageId) {
                const read = await bounded(this.findInHistory(a.sdkMessageId), this.o.ioTimeoutMs);
                hit = read === TIMEOUT || read == null ? null : read;   // INV-P12
            }
            if (hit) this.recordDelivery(a, hit);                     // an unrecognized kind stays uncertain
            else this.writes.push("unconfirmed", () => this.ch.markUnconfirmed(a.attemptId));   // INV-P8
            // Without positive evidence, or found only as an `idle` delivery, the send may
            // still start or continue a run: ownership ends only with quiescence.
            if (!hit || hit?.data?.delivery === "idle") this.needsQuiesce = true;
        }
        if (this.needsQuiesce && !this.quiesced) {
            if (o.stopping) {
                await this.quiesceSession().catch((err) => this.trace(`[steering] quiesce during Stop failed: ${err?.message ?? err}`));
            } else {
                await this.quiesceSession();                          // throws (INV-P9)
            }
        }
        if ((await bounded(this.writes.drain(), this.o.ioTimeoutMs)) === TIMEOUT) {
            this.trace("[steering] receipt writes did not drain in time; unresolved evidence stays unconfirmed");
        }
        if (!o.stopping && this.windowOpened) {
            if ((await bounded(this.ch.quiesce(), this.o.ioTimeoutMs)) === TIMEOUT) {
                this.trace("[steering] window quiesce did not complete in time");
            }
        }
        if (o.stopping || !this.windowOpened) return undefined;
        const delivered: SteeringManifest["delivered"] = [...this.attempts.values()]
            .filter((a) => a.event && a.sdkMessageId)
            .map((a) => ({
                requestId: a.row.requestId,
                attemptId: a.attemptId,
                sdkMessageId: a.sdkMessageId!,
                kind: a.event.data.delivery as SteeringDeliveryKind,
            }));
        const handedOff = new Set(delivered.map((d) => d.requestId));
        for (const r of this.recoveredLocal) {
            if (!handedOff.has(r.requestId)) delivered.push({ ...r, attemptId: null, recovered: true });
        }
        return { delivered };
    }

    /** Number of receipt writes that failed after retry. */
    get writeFailures(): number { return this.writes.failures; }

    dispose(): void {
        this.released = true;
        this.gate.close();
        if (this.leaseTimer) clearInterval(this.leaseTimer);
        for (const u of this.unsubs.splice(0)) { try { u(); } catch {} }
        this.wake();
        this.notify();
        this.earlyEvents.clear();
    }
}
