import path from "node:path";

export function resolveCopilotHome(
    sessionStateDir: string,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const configuredHome = env.COPILOT_HOME?.trim();
    return configuredHome ? path.resolve(configuredHome) : path.dirname(sessionStateDir);
}

export function hasSignedInCopilotUserConfig(raw: string): boolean {
    const hasLoginMetadata = (config: {
        copilotTokens?: unknown;
        loggedInUsers?: unknown;
    }): boolean => {
        const tokens = config?.copilotTokens;
        if (tokens && typeof tokens === "object" && !Array.isArray(tokens)
            && Object.keys(tokens as object).length > 0) {
            return true;
        }
        return Array.isArray(config?.loggedInUsers)
            && config.loggedInUsers.some((entry) => (
                !!entry
                && typeof entry === "object"
                && typeof (entry as { login?: unknown }).login === "string"
                && !!(entry as { login: string }).login.trim()
            ));
    };

    try {
        return hasLoginMetadata(JSON.parse(raw));
    } catch {
        // Copilot config is JSONC. Detect only the two known login metadata
        // shapes without reading or exposing their credential values.
        return /"copilotTokens"\s*:\s*\{\s*"/.test(raw)
            || /"loggedInUsers"\s*:\s*\[\s*\{[\s\S]*?"login"\s*:\s*"[^"]+"/.test(raw);
    }
}
