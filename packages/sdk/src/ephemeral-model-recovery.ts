import type { SessionConfig, SessionEvent } from "@github/copilot-sdk";

type ErrorHook = NonNullable<NonNullable<SessionConfig["hooks"]>["onErrorOccurred"]>;
type ErrorInput = Parameters<ErrorHook>[0];
type ErrorDecision = Exclude<Awaited<ReturnType<ErrorHook>>, void>;

/** Only the native error hook can authorize recovery; failure events are telemetry. */
export function isRecoverableRateLimit(event: SessionEvent): boolean {
    return event.type === "model.call_failure" && event.data.statusCode === 429
        && event.data.failureKind === "api";
}

/** @internal Bounded native retries retain the same child, turn and provider call path. */
export class EphemeralModelRecovery {
    private readonly pending = new Set<string>();
    private readonly retries = new Map<string, number>();
    private readonly events = new Set<string>();
    private stopped = false;
    private gated = false;

    constructor(private readonly rootSessionId: string) {}

    /**
     * Host-closed window in which no retry may be authorized. A context reset
     * and the continuation seeded by its clear must fail closed: replaying a
     * model call there could re-run the reset tool or repeat the seeded turn,
     * so the host closes the gate before the reset prompt is sent and reopens
     * it once that window has settled.
     *
     * Three things hold the window, deliberately overlapping, because the
     * runtime gives no per-call identity to attribute a decision by: no credit
     * is recorded while the gate is closed, none is spent while it is closed,
     * and any credit is dropped on both edges. The third is what covers the
     * ordering a real run actually produces — measured on CLI 1.0.85, a failed
     * call's event arrives while the gate is still closed but the error hook's
     * decision lands after the host has already reopened it — and the first
     * two cover a decision that arrives early, inside the window.
     *
     * The limit of this is worth stating: it assumes a failed call's event
     * reaches `observe` no later than the hook that decides it, which is the
     * same ordering recovery already depends on to work at all, since credit
     * has to exist by the time the hook runs.
     */
    setGate(gated: boolean): void {
        this.gated = gated;
        this.pending.clear();
    }

    observe(event: SessionEvent): void {
        if (this.stopped || this.gated || !["model.call_failure", "model.call_finished"].includes(event.type)) return;
        const sessionId = event.agentId ?? this.rootSessionId;
        const identity = JSON.stringify([sessionId, event.id]);
        if (this.events.has(identity)) return;
        this.events.add(identity);
        if (event.type === "model.call_finished" && event.data.outcome === "success") {
            this.pending.delete(sessionId);
            this.retries.delete(sessionId);
        } else if (isRecoverableRateLimit(event)) {
            this.pending.add(sessionId);
        } else if (event.type === "model.call_failure") {
            this.pending.delete(sessionId);
        }
    }

    decide(input: ErrorInput): ErrorDecision {
        if (this.gated) return { errorHandling: "abort", suppressOutput: true };
        const pending = this.pending.delete(input.sessionId);
        const count = this.retries.get(input.sessionId) ?? 0;
        if (!this.stopped && pending && input.recoverable && input.errorContext === "model_call" && count < 2) {
            this.retries.set(input.sessionId, count + 1);
            // The pinned native runtime owns retry backoff.
            // Authorize one attempt per hook, never replay tools or respawn a child.
            return { errorHandling: "retry", retryCount: 1, suppressOutput: true };
        }
        return { errorHandling: "abort", suppressOutput: true };
    }

    stop(): void {
        this.stopped = true;
        this.pending.clear();
    }
}
