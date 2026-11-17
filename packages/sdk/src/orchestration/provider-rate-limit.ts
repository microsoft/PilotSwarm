const FIRST_WAIT_MS = 75_000;
const MAX_WAIT_MS = 5 * 60_000;

export const PROVIDER_RATE_LIMIT_WAIT_BUDGET_MS = 30 * 60_000;

export function isProviderRateLimitError(message: string): boolean {
    return /(?:\b429\b|too[_ -]?many[_ -]?requests|rate[_ -]?limit(?:_exceeded|ed|ing)?|throttl(?:e|ed|ing)?)/i.test(message);
}

export function providerRateLimitDelayMs(sessionId: string, retryAttempt: number): number {
    const attempt = Math.max(1, Math.floor(retryAttempt));
    const baseMs = Math.min(FIRST_WAIT_MS * 2 ** Math.min(attempt - 1, 8), MAX_WAIT_MS);
    let hash = 0x811c9dc5;
    const seed = sessionId + ":" + attempt;
    for (const character of seed) {
        hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
    }
    const jitter = 0.9 + ((hash >>> 0) % 2001) / 10_000;
    return Math.min(MAX_WAIT_MS, Math.round(baseMs * jitter));
}
