import { createHash } from "node:crypto";
import type { GitHubCredential, GitHubCredentialProvider } from "./types.js";

const SAFETY_MS = 10 * 60_000;
const MAX_OPERATION_MS = 40 * 60_000;

/** @internal One worker authority, serialized so a slow acquisition cannot roll back a newer generation. */
export class GitHubCredentialAuthority {
    private tail: Promise<unknown> = Promise.resolve();
    private fingerprints = new Map<string, string>();
    private current?: GitHubCredential;
    private expiries = new Map<string, number>();

    constructor(readonly provider: GitHubCredentialProvider) {}

    private minimumValidity(timeoutMs: number): number {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_OPERATION_MS) {
            throw new Error("GitHub credential operation timeout must be greater than zero and at most 40 minutes");
        }
        return timeoutMs + SAFETY_MS;
    }

    acquire(timeoutMs: number): Promise<string> {
        const minimum = this.minimumValidity(timeoutMs);
        const acquiring = this.tail.then(async () => {
            let result: GitHubCredential;
            try { result = await this.provider.acquire(minimum); }
            catch { throw new Error("GitHub credential acquisition failed"); }
            if (!result || typeof result.token !== "string" || !result.token.trim()
                || typeof result.generation !== "string" || !result.generation.trim()
                || result.scopeId !== this.provider.scopeId || !Number.isFinite(result.expiresAtMs)
                || result.expiresAtMs - Date.now() < minimum) {
                throw new Error("GitHub credential is missing, short-lived, expired or has an unexpected scope");
            }
            const fingerprint = createHash("sha256")
                .update(JSON.stringify([result.token, result.expiresAtMs, result.scopeId])).digest("hex");
            const known = this.fingerprints.get(result.generation);
            if ((known && known !== fingerprint) || (known && this.current?.generation !== result.generation)
                || (this.expiries.has(this.tokenKey(result.token)) && this.current?.generation !== result.generation)) {
                throw new Error("GitHub credential generation is inconsistent or retired");
            }
            this.fingerprints.set(result.generation, fingerprint);
            this.current = { ...result };
            this.expiries.set(this.tokenKey(result.token), result.expiresAtMs);
            return result.token;
        });
        this.tail = acquiring.catch(() => {});
        return acquiring;
    }

    assertValid(token: string, timeoutMs: number): void {
        const minimum = this.minimumValidity(timeoutMs);
        if ((this.expiries.get(this.tokenKey(token)) ?? 0) - Date.now() < minimum) {
            throw new Error("GitHub credential has insufficient remaining validity before model execution");
        }
    }

    private tokenKey(token: string): string { return createHash("sha256").update(token).digest("hex"); }
    isManaged(token: string): boolean { return this.expiries.has(this.tokenKey(token)); }
    isCurrent(token: string): boolean { return this.current?.token === token; }
}
