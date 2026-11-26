import type { ChargeClass, ProviderStore } from "./provider-store.js";
import type { ClaudeKeepWarmPing } from "./copilot-client.js";

/** The provider-ledger store calls a keep-warm ping makes: a claim before the send and a settle after it. */
export type KeepWarmLedgerStore = Pick<ProviderStore, "claimInferenceOperation" | "settleInferenceOperation" | "sessionChargeFacts">;

export interface KeepWarmClaim {
    sessionId: string;
    /** When the replayed request was captured (ms since the epoch). */
    capturedAt: number;
    /** The 1-based number of the ping about to be sent. */
    ping: number;
    /** The provider the admission check named. */
    providerName: string;
    /** The session's normalized model reference. */
    modelQualified: string;
    /** The provider row's immutable id read when the request was captured; none: the claim links to the current row by name. */
    providerInstanceId?: string;
}

/**
 * Records each Claude keep-warm ping as one `keep_warm` inference operation of the provider ledger, so its tokens move
 * the provider's meters and usage totals like any inference call. A ping is not a turn: nothing here touches the turn
 * ledger.
 */
export class KeepWarmLedger {
    constructor(private readonly providers: KeepWarmLedgerStore) {}

    /** The ledger key of one ping: the request it replays and its number in the idle gap. */
    static operationId(sessionId: string, capturedAt: number, ping: number): string {
        return `keepwarm:${sessionId}:${capturedAt}:${ping}`;
    }

    /**
     * Claim the ping before it is sent. False means the claimed provider row is no longer the one captured with the
     * request (deleted, or created again under the same name), or the ping is already claimed: no ping may be sent.
     * The row's `updated_at` is not passed: it also changes on a hold or limit edit, and that would stop every ping
     * after one. A throw (the database is unreachable) is left to the caller.
     */
    async claim(input: KeepWarmClaim): Promise<boolean> {
        const facts = await this.providers.sessionChargeFacts(input.sessionId);
        const chargeClass: ChargeClass = facts.isSystem ? "system" : "user";
        return this.providers.claimInferenceOperation({
            operationId: KeepWarmLedger.operationId(input.sessionId, input.capturedAt, input.ping),
            attempt: 1,
            capability: "keep_warm",
            purpose: "prompt_cache_ping",
            sessionId: input.sessionId,
            providerName: input.providerName,
            providerInstanceId: input.providerInstanceId ?? null,
            providerUpdatedAt: null,
            modelQualified: input.modelQualified,
            ownerUserId: facts.ownerUserId,
            chargeClass,
        });
    }

    /**
     * Settle the claimed ping once. The counts are the reply's when it was a readable 2xx; a ping with another status,
     * an unreadable reply or no reply settles with no counts (unknown, not zero). A throw is left to the caller: the
     * replay then stops as `usage-write-failed`.
     */
    async settle(ping: ClaudeKeepWarmPing): Promise<boolean> {
        const readable = ping.status !== undefined && ping.status >= 200 && ping.status < 300 && ping.usage !== undefined;
        return this.providers.settleInferenceOperation({
            operationId: KeepWarmLedger.operationId(ping.sessionId, ping.capturedAt, ping.ping),
            attempt: 1,
            tokensInput: readable ? ping.usage!.input : null,
            tokensOutput: readable ? ping.usage!.output : null,
            tokensCacheRead: readable ? ping.usage!.cacheRead : null,
            tokensCacheWrite: readable ? ping.usage!.cacheWrite : null,
            latencyMs: ping.latencyMs ?? null,
        });
    }
}
