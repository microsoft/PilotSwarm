import { parseArgs } from "node:util";
import {
    createTokenProvider,
    fetchAuthConfig,
    getSignedInAccount,
    signIn,
    signOut,
} from "./entra-auth.js";

/**
 * `pilotswarm auth login|status|logout --api-url <url>`
 *
 * Pre-provision or inspect the per-origin token cache used by the TUI's
 * API mode. The TUI triggers the same sign-in lazily on start, so
 * `auth login` is optional.
 */

function resolveApiUrl(flags) {
    const apiUrl = String(flags["api-url"] || process.env.PILOTSWARM_API_URL || "").trim();
    if (!apiUrl) {
        throw new Error("An API URL is required: pass --api-url <url> or set PILOTSWARM_API_URL.");
    }
    return apiUrl.replace(/\/+$/, "");
}

// Shared dispatch only: resolving a provider must not acquire tokens or
// start an interactive flow (in particular for `auth status`).
function resolveAuthMode(authConfig, apiUrl) {
    if (!authConfig?.enabled || authConfig?.provider === "none") {
        return { provider: "none" };
    }
    if (authConfig.provider === "dev") {
        // Dev roster provider (multi-user test deployments): the bearer token
        // is `dev:<persona>`. Explicit opt-in via env — no default identity.
        const persona = String(process.env.PILOTSWARM_DEV_USER || "").trim().toLowerCase();
        if (!persona) {
            throw new Error(
                `${apiUrl} uses the dev auth provider. Set PILOTSWARM_DEV_USER to a persona id `
                + `(e.g. PILOTSWARM_DEV_USER=alice) to choose who you sign in as.`,
            );
        }
        // The server rejects personas outside its published roster; fail here
        // instead of on the first API request.
        const roster = authConfig.client?.users;
        if (!Array.isArray(roster)) {
            return { provider: "dev", persona, rosterChecked: false };
        }
        const known = roster.map((user) => String(user?.id ?? "").trim().toLowerCase());
        if (!known.includes(persona)) {
            throw new Error(
                `Dev persona '${persona}' is not in the roster of ${apiUrl}. `
                + `Set PILOTSWARM_DEV_USER to one of: ${known.join(", ")}.`,
            );
        }
        return { provider: "dev", persona, rosterChecked: true };
    }
    if (authConfig.provider !== "entra") {
        throw new Error(`Unsupported auth provider '${authConfig.provider}' reported by ${apiUrl}.`);
    }
    return { provider: "entra" };
}

/**
 * Discover auth for TUI startup before the Ink app renders. Entra signs in
 * silent-first, then browser/device code, and returns a token supplier.
 */
export async function bootstrapApiAuth(apiUrl, { output = console.error, interactive = true, useDeviceCode = false } = {}) {
    const authConfig = await fetchAuthConfig(apiUrl);
    const mode = resolveAuthMode(authConfig, apiUrl);
    if (mode.provider === "none") {
        return { authConfig, getAccessToken: async () => null };
    }
    if (mode.provider === "dev") {
        output(`Signed in to ${apiUrl} as dev persona '${mode.persona}'.`);
        return { authConfig, getAccessToken: async () => `dev:${mode.persona}` };
    }
    if (interactive) {
        await signIn(apiUrl, authConfig, { output, useDeviceCode });
    }
    const getAccessToken = await createTokenProvider(apiUrl, authConfig);
    return { authConfig, getAccessToken };
}

export async function runAuthCommand(argv) {
    const { values: flags, positionals } = parseArgs({
        options: {
            "api-url": { type: "string" },
            "device-code": { type: "boolean" },
            env: { type: "string", short: "e" },
            help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
        strict: false,
        args: argv,
    });

    const action = positionals[0];
    if (flags.help || !["login", "status", "logout"].includes(action)) {
        console.log(`
pilotswarm auth — manage Web API sign-in

USAGE
  pilotswarm auth login  --api-url <url>   Sign in (opens your browser) and cache tokens
  pilotswarm auth status --api-url <url>   Show the signed-in account
  pilotswarm auth logout --api-url <url>   Drop cached tokens for that origin

FLAGS
      --device-code    Use the device-code flow instead of the browser
                       (headless hosts; only where the tenant permits it —
                       many corp tenants block device code via Conditional Access)

  PILOTSWARM_API_URL can replace --api-url.
  Dev-auth deployments: set PILOTSWARM_DEV_USER=<persona>; no browser sign-in.
`.trim());
        return flags.help ? 0 : 1;
    }

    const apiUrl = resolveApiUrl(flags);

    if (action === "logout") {
        const cacheFile = await signOut(apiUrl);
        console.log(`Signed out of ${apiUrl} (removed ${cacheFile}).`);
        return 0;
    }

    const authConfig = await fetchAuthConfig(apiUrl);
    const mode = resolveAuthMode(authConfig, apiUrl);
    if (mode.provider === "none") {
        console.log(`${apiUrl} does not require sign-in (auth provider: ${authConfig?.provider || "none"}).`);
        return 0;
    }
    if (mode.provider === "dev") {
        console.log(`Selected dev persona '${mode.persona}' for ${apiUrl}; no interactive sign-in is needed.`);
        console.log(mode.rosterChecked
            ? "The persona is in the deployment's dev roster."
            : "The deployment published no dev roster, so the persona was not checked.");
        return 0;
    }

    if (action === "login") {
        const result = await signIn(apiUrl, authConfig, { output: console.log, useDeviceCode: Boolean(flags["device-code"]) });
        const username = result?.account?.username || result?.account?.name || "signed in";
        console.log(`Signed in to ${apiUrl} as ${username}.`);
        return 0;
    }

    // status
    const account = await getSignedInAccount(apiUrl, authConfig);
    if (!account) {
        console.log(`Not signed in to ${apiUrl}. Run: pilotswarm auth login --api-url ${apiUrl}`);
        return 1;
    }
    console.log(`Signed in to ${apiUrl} as ${account.username || account.name}.`);
    const getAccessToken = await createTokenProvider(apiUrl, authConfig);
    const token = await getAccessToken();
    console.log(token ? "Token cache is valid (silent acquisition succeeded)." : "Token cache is stale — run: pilotswarm auth login");
    return token ? 0 : 1;
}
