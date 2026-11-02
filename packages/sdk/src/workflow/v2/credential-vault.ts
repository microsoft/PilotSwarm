import { inspect } from "node:util";
import type { WorkflowCredentialAudience } from "./store.js";

/**
 * Workflow v2: a trusted runtime's credential vault (design 04 scoped
 * invocation credentials; INACTIVE: only a runtime created with a test-only
 * option holds one).
 *
 * A runtime that runs a holder session's work outside its in-process tools
 * (for example an MCP server acting for an external agent) answers a
 * workflow's request or completes an agent state with an invocation
 * credential. The vault keeps those credentials in the runtime's own memory:
 *
 * - It acts only for the holder sessions the runtime was configured to serve
 *   (trusted configuration, never a model's or a caller's claim); any other
 *   holder is refused before anything is issued.
 * - It obtains a credential from the host's issuer (the direct management
 *   client) when it holds none for the effect, or when the one it holds is
 *   about to expire; after a refusal that says the credential itself is
 *   stale (expired, revoked, invalid) it obtains one more and tries once
 *   more. A credential whose effect was decided is dropped.
 * - The token reaches only the action it authorizes (`withCredential`'s
 *   callback, which sends it as the request's credential field). Nothing the
 *   vault returns, serializes, inspects or logs contains a token: model
 *   prompts, transcripts, tool results, scripts, YAML and logs never see one.
 */

export interface WorkflowCredentialBinding {
    audience: WorkflowCredentialAudience;
    nodeExecutionId: string;
    holderSessionId: string;
}

export interface WorkflowCredentialIssuer {
    (input: WorkflowCredentialBinding & { ttlSeconds?: number }): Promise<{ token: string; credential: { credentialId: string; expiresAt: string | Date } }>;
}

export interface WorkflowCredentialVaultOptions {
    /** The holder sessions this runtime acts for (trusted configuration). */
    holderSessionIds: Iterable<string>;
    /** The host's issuer (the direct management client's issueWorkflowInvocationCredential). */
    issue: WorkflowCredentialIssuer;
    /** The lifetime asked for (seconds; the host caps it, and never past the effect's deadline). */
    ttlSeconds?: number;
    /** Obtain a new credential this long before the held one expires (default 30 seconds). */
    refreshMarginMs?: number;
    /** The clock (tests). */
    now?: () => number;
}

/** Codes of a refusal that says the credential itself is stale: one more is obtained and the action tried once more. */
const STALE_CODES: ReadonlySet<string> = new Set(["CREDENTIAL_EXPIRED", "CREDENTIAL_REVOKED", "CREDENTIAL_INVALID"]);

const keyOf = (binding: WorkflowCredentialBinding) => JSON.stringify([binding.audience, binding.nodeExecutionId, binding.holderSessionId]);

export class WorkflowCredentialVault {
    readonly #holders: ReadonlySet<string>;
    readonly #issue: WorkflowCredentialIssuer;
    readonly #ttlSeconds: number | undefined;
    readonly #refreshMarginMs: number;
    readonly #now: () => number;
    readonly #held = new Map<string, { binding: WorkflowCredentialBinding; token: string; credentialId: string; expiresAtMs: number }>();

    constructor(options: WorkflowCredentialVaultOptions) {
        this.#holders = new Set([...options.holderSessionIds].filter(id => typeof id === "string" && id.length > 0));
        this.#issue = options.issue;
        this.#ttlSeconds = options.ttlSeconds;
        this.#refreshMarginMs = options.refreshMarginMs ?? 30_000;
        this.#now = options.now ?? Date.now;
    }

    /** Whether this runtime acts for `holderSessionId`. */
    serves(holderSessionId: string): boolean {
        return this.#holders.has(holderSessionId);
    }

    /**
     * Run `act` with a credential for `binding` (see the class's comment) and
     * return its result. Throws CREDENTIAL_HOLDER_NOT_SERVED (403) for a holder
     * this runtime does not act for, the issuer's refusal, or the action's.
     */
    async withCredential<T>(binding: WorkflowCredentialBinding, act: (token: string) => Promise<T>): Promise<T> {
        if (!this.#holders.has(binding.holderSessionId)) {
            throw Object.assign(new Error(`This runtime does not act for session ${binding.holderSessionId}.`),
                { code: "CREDENTIAL_HOLDER_NOT_SERVED", status: 403 });
        }
        const key = keyOf(binding);
        for (let attempt = 0; ; attempt += 1) {
            const token = await this.#tokenFor(key, binding, attempt > 0);
            try {
                const result = await act(token);
                return result;
            } catch (error) {
                const code = (error as { code?: unknown })?.code;
                if (typeof code === "string" && (STALE_CODES.has(code) || code === "CREDENTIAL_CLOSED")) this.#held.delete(key);
                if (attempt === 0 && typeof code === "string" && STALE_CODES.has(code)) continue;
                throw error;
            }
        }
    }

    /** Drop what the vault holds for an effect (after its decision); returns how many credentials were dropped. */
    forget(nodeExecutionId: string): number {
        let dropped = 0;
        for (const [key, entry] of this.#held) {
            if (entry.binding.nodeExecutionId === nodeExecutionId) { this.#held.delete(key); dropped += 1; }
        }
        return dropped;
    }

    /** What the vault holds, without any token. */
    describe(): Array<WorkflowCredentialBinding & { credentialId: string; expiresAt: string }> {
        return [...this.#held.values()].map(entry => ({ ...entry.binding, credentialId: entry.credentialId, expiresAt: new Date(entry.expiresAtMs).toISOString() }));
    }

    toJSON(): unknown {
        return { holders: [...this.#holders], held: this.describe() };
    }

    [inspect.custom](): unknown {
        return this.toJSON();
    }

    async #tokenFor(key: string, binding: WorkflowCredentialBinding, fresh: boolean): Promise<string> {
        const held = this.#held.get(key);
        if (!fresh && held && held.expiresAtMs - this.#refreshMarginMs > this.#now()) return held.token;
        const issued = await this.#issue({ ...binding, ...(this.#ttlSeconds !== undefined ? { ttlSeconds: this.#ttlSeconds } : {}) });
        const expiresAtMs = new Date(issued.credential.expiresAt).getTime();
        this.#held.set(key, { binding: { ...binding }, token: issued.token, credentialId: issued.credential.credentialId, expiresAtMs });
        return issued.token;
    }
}
