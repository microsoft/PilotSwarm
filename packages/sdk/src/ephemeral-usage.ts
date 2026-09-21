import type { EphemeralSessionUsage, EphemeralSessionUsageDiagnostics, EphemeralUsageUnknownReason } from "./host-services.js";
import { EphemeralSessionError } from "./ephemeral-errors.js";

const COUNTERS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
type Counter = typeof COUNTERS[number];
type CallUsage = {
    counters: Partial<Record<Counter, number | null>>;
    invalidCounters: Set<Counter>;
    conflictingCounters: Set<Counter>;
};
type WeakCallUsage = {
    usage: CallUsage;
    aliases: Set<string>;
    compactionIds: Set<string>;
};
const REASONS: readonly EphemeralUsageUnknownReason[] = [
    "no_usage_observed", "missing_counter", "conflicting_counter", "missing_call_identity",
    "interrupted_call", "missing_compaction_usage", "invalid_counter",
];

const ordered = (reasons: Iterable<EphemeralUsageUnknownReason>): EphemeralUsageUnknownReason[] => {
    const set = new Set(reasons);
    return REASONS.filter(reason => set.has(reason));
};

/** @internal Each returned object is independent of accumulator/callback state. */
export function emptyUsageDiagnostics(): EphemeralSessionUsageDiagnostics {
    return { observedApiCalls: 0, apiCallCountReasons: [],
        counterReasons: { inputTokens: [], outputTokens: [], cacheReadTokens: [], cacheWriteTokens: [] } };
}

/** @internal Finalized iterations are distinct; notifications within one iteration are not. */
export function sumUsageDiagnostics(
    a: EphemeralSessionUsageDiagnostics, b: EphemeralSessionUsageDiagnostics,
): EphemeralSessionUsageDiagnostics {
    const result = emptyUsageDiagnostics();
    result.observedApiCalls = a.observedApiCalls + b.observedApiCalls;
    if (!Number.isSafeInteger(result.observedApiCalls)) throw new EphemeralSessionError("EPHEMERAL_INVALID_USAGE");
    result.apiCallCountReasons = ordered([...a.apiCallCountReasons, ...b.apiCallCountReasons]);
    for (const name of COUNTERS) result.counterReasons[name] = ordered([...a.counterReasons[name], ...b.counterReasons[name]]);
    return result;
}

function merge(target: CallUsage, incoming: CallUsage): void {
    for (const name of incoming.invalidCounters) target.invalidCounters.add(name);
    for (const name of incoming.conflictingCounters) target.conflictingCounters.add(name);
    for (const name of COUNTERS) {
        const value = incoming.counters[name];
        if (value === undefined) continue;
        const previous = target.counters[name];
        if (previous != null && value !== null && previous !== value) target.conflictingCounters.add(name);
        target.counters[name] = previous === undefined || previous === value ? value : null;
    }
}

function emptyCallUsage(): CallUsage {
    return { counters: {}, invalidCounters: new Set(), conflictingCounters: new Set() };
}

/** @internal Only per-call usage is additive, never session/native-task totals. */
export class EphemeralUsageAccumulator {
    constructor(private readonly scopeAgents = false) {}
    private readonly primaryCalls = new Map<string, CallUsage>();
    private readonly primaryAliases = new Map<string, Set<string>>();
    private readonly weakCalls = new Map<string, WeakCallUsage>();
    private readonly weakAliases = new Map<string, string>();
    private readonly events = new Set<string>();
    private readonly callCountReasons = new Set<EphemeralUsageUnknownReason>();
    private readonly invalidUnidentifiedCounters = new Set<Counter>();
    private observed = false;

    markIncomplete(): void {
        // An interrupted call can spend before emitting its final usage event.
        this.callCountReasons.add("interrupted_call");
    }

    observe(event: { type: string; id?: string; agentId?: string; data?: Record<string, unknown> }): void {
        const compaction = event.type === "session.compaction_complete";
        if (event.type !== "assistant.usage" && event.type !== "model.call_failure" && !compaction) return;
        this.observed = true;
        let data = event.data ?? {};
        if (compaction) {
            if (data.success !== true) this.markIncomplete();
            if (!data.compactionTokensUsed || typeof data.compactionTokensUsed !== "object") {
                this.callCountReasons.add("missing_compaction_usage");
                return;
            }
            // Pinned CLI compaction calls emit metrics here, not assistant.usage.
            // Correlate provider IDs when present; otherwise this completion event
            // identifies the distinct compaction call, not a session-total snapshot.
            data = { ...data.compactionTokensUsed as Record<string, unknown>,
                apiCallId: data.apiCallId, providerCallId: data.providerCallId,
                serviceRequestId: data.serviceRequestId, compactionEventId: event.id };
        }
        // Parallel sessions may reuse request/event identifiers. The opt-in
        // scopes correlation per agent; legacy synchronous correlation is unchanged.
        const scoped = (id: string) => this.scopeAgents ? JSON.stringify([event.agentId ?? null, id]) : id;
        const primaryId = typeof data.apiCallId === "string" && data.apiCallId ? scoped(data.apiCallId) : undefined;
        const ids = ["providerCallId", "serviceRequestId", "compactionEventId"]
            .flatMap(key => typeof data[key] === "string" && data[key] ? [scoped(`${key}:${data[key]}`)] : []);
        if (event.id) {
            if (this.events.has(scoped(event.id))) return;
            this.events.add(scoped(event.id));
        }
        if (!primaryId && !ids.length) {
            this.callCountReasons.add("missing_call_identity");
            for (const name of COUNTERS) {
                const value = data[name];
                if (value == null) continue;
                if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
                    this.invalidUnidentifiedCounters.add(name);
                    throw new EphemeralSessionError("EPHEMERAL_INVALID_USAGE");
                }
            }
            return;
        }
        let call: CallUsage;
        if (primaryId) {
            call = this.primaryCalls.get(primaryId) ?? emptyCallUsage();
            this.primaryCalls.set(primaryId, call);
            for (const id of ids) {
                const primaries = this.primaryAliases.get(id) ?? new Set<string>();
                primaries.add(primaryId);
                this.primaryAliases.set(id, primaries);
            }
        } else {
            const existing = [...new Set(ids.flatMap(id => this.weakAliases.has(id) ? [this.weakAliases.get(id)!] : []))];
            const key = existing[0] ?? ids[0]!;
            const weak = this.weakCalls.get(key) ?? { usage: emptyCallUsage(), aliases: new Set<string>(), compactionIds: new Set<string>() };
            for (const duplicate of existing.slice(1)) {
                const other = this.weakCalls.get(duplicate)!;
                merge(weak.usage, other.usage);
                for (const id of other.aliases) weak.aliases.add(id);
                for (const id of other.compactionIds) weak.compactionIds.add(id);
                this.weakCalls.delete(duplicate);
            }
            for (const id of ids) weak.aliases.add(id);
            if (compaction && event.id) weak.compactionIds.add(event.id);
            for (const id of weak.aliases) this.weakAliases.set(id, key);
            this.weakCalls.set(key, weak);
            call = weak.usage;
        }
        if (event.type === "assistant.usage" || compaction) {
            for (const name of COUNTERS) {
                const value = data[name];
                if (value === undefined || value === null) continue;
                if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
                    call.counters[name] = null;
                    call.invalidCounters.add(name);
                    throw new EphemeralSessionError("EPHEMERAL_INVALID_USAGE");
                }
                // Conflicting snapshots of one call do not become two calls.
                merge(call, { counters: { [name]: value }, invalidCounters: new Set<Counter>(), conflictingCounters: new Set<Counter>() });
            }
        }
    }

    snapshot(): { usage: EphemeralSessionUsage; usageDiagnostics: EphemeralSessionUsageDiagnostics } {
        const primaries = new Map<string, CallUsage>();
        for (const [id, usage] of this.primaryCalls) {
            const copy = emptyCallUsage();
            merge(copy, usage);
            primaries.set(id, copy);
        }
        const calls = [...primaries.values()], ambiguous: CallUsage[] = [];
        const correlated = new Map<string, WeakCallUsage[]>();
        const callCountReasons = new Set(this.callCountReasons);
        // Resolve weak observations afresh: a later trace collision must be able
        // to withdraw a tentative correlation without corrupting either primary.
        for (const weak of this.weakCalls.values()) {
            const matches = new Set([...weak.aliases].flatMap(id => [...this.primaryAliases.get(id) ?? []]));
            if (matches.size > 1 || weak.compactionIds.size > 1
                || (!matches.size && weak.usage.conflictingCounters.size > 0)) {
                callCountReasons.add("missing_call_identity");
                ambiguous.push(weak.usage);
            } else if (matches.size === 1) {
                const id = matches.values().next().value!;
                const observations = correlated.get(id) ?? [];
                observations.push(weak);
                correlated.set(id, observations);
            } else {
                calls.push(weak.usage);
            }
        }
        for (const [id, observations] of correlated) {
            const compactionIds = new Set(observations.flatMap(weak => [...weak.compactionIds]));
            for (const weak of observations) {
                if (compactionIds.size > 1 && weak.compactionIds.size) {
                    callCountReasons.add("missing_call_identity");
                    ambiguous.push(weak.usage);
                } else {
                    merge(primaries.get(id)!, weak.usage);
                }
            }
        }
        const known = (name: Counter) => {
            let sum = 0;
            for (const call of calls) sum += call.counters[name] ?? 0;
            if (!Number.isSafeInteger(sum)) throw new EphemeralSessionError("EPHEMERAL_INVALID_USAGE");
            return sum;
        };
        const total = (name: Counter) => callCountReasons.size || !calls.length
            || calls.some(call => call.counters[name] == null) ? null : known(name);
        const usageDiagnostics = emptyUsageDiagnostics();
        usageDiagnostics.observedApiCalls = calls.length;
        usageDiagnostics.apiCallCountReasons = ordered([
            ...callCountReasons, ...(!this.observed ? ["no_usage_observed" as const] : []),
        ]);
        for (const name of COUNTERS) {
            const reasons = new Set(usageDiagnostics.apiCallCountReasons);
            if (this.invalidUnidentifiedCounters.has(name)) reasons.add("invalid_counter");
            for (const call of [...calls, ...ambiguous]) {
                if (call.counters[name] === undefined) reasons.add("missing_counter");
                else if (call.counters[name] === null) {
                    if (call.invalidCounters.has(name)) reasons.add("invalid_counter");
                    if (call.conflictingCounters.has(name)) reasons.add("conflicting_counter");
                }
            }
            usageDiagnostics.counterReasons[name] = ordered(reasons);
        }
        return {
            usageDiagnostics,
            usage: {
                inputTokens: total("inputTokens"),
                outputTokens: total("outputTokens"),
                cacheReadTokens: total("cacheReadTokens"),
                cacheWriteTokens: total("cacheWriteTokens"),
                apiCalls: callCountReasons.size || !calls.length ? null : calls.length,
            },
        };
    }
}
