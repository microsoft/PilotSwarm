/** Audience requested from a caller-owned credential provider. */
export interface RequiredAudience {
    appIdUri: string;
    scope: string;
}

/** Resolve a caller-owned token for one audience, or null when unavailable. */
export type CallerTokenProvider = (
    required: RequiredAudience,
) => Promise<string | null>;

export function appIdUriFromScope(scope: string): string {
    const noDefault = scope.endsWith("/.default")
        ? scope.slice(0, -"/.default".length)
        : scope;
    const schemeIndex = noDefault.indexOf("://");
    if (schemeIndex < 0) {
        const slash = noDefault.indexOf("/");
        return slash < 0 ? noDefault : noDefault.slice(0, slash);
    }
    const slash = noDefault.indexOf("/", schemeIndex + 3);
    return slash < 0 ? noDefault : noDefault.slice(0, slash);
}

export function normalizeAudience(audience: string): string {
    return audience
        .replace(/^api:\/\//i, "")
        .replace(/\/+$/, "")
        .toLowerCase();
}

export function multiTokenProvider(
    audienceTokens: Record<string, string> | null | undefined,
): CallerTokenProvider {
    const byAudience = new Map<string, string>();
    for (const [audience, token] of Object.entries(audienceTokens ?? {})) {
        if (typeof token === "string" && token.length > 0) {
            byAudience.set(normalizeAudience(audience), token);
        }
    }
    return async ({ appIdUri }) =>
        byAudience.get(normalizeAudience(appIdUri)) ?? null;
}
