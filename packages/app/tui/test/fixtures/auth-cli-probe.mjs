import { mock } from "node:test";

// Keep the real discovery, Entra dispatch and CLI entrypoint. Only replace
// MSAL/browser boundaries: never read an operator's cache or contact Entra.
const calls = [];
const scenario = process.env.AUTH_PROBE_SCENARIO || "valid";
mock.module("@azure/msal-node", {
    namedExports: {
        PublicClientApplication: class {
            constructor() { calls.push("msal"); }
            getTokenCache() {
                return {
                    async getAllAccounts() {
                        calls.push("accounts");
                        return scenario === "absent" ? [] : [{ username: "fixture@example.invalid" }];
                    },
                };
            }
            async acquireTokenSilent() {
                calls.push("silent");
                if (scenario === "silent-failure") throw new Error("synthetic silent failure");
                return {
                    account: { username: "fixture@example.invalid" },
                    accessToken: scenario === "stale" ? null : "synthetic-entra-token",
                };
            }
            async acquireTokenInteractive() {
                calls.push("interactive");
                return { account: { username: "fixture@example.invalid" }, accessToken: "synthetic-entra-token" };
            }
            async acquireTokenByDeviceCode() {
                calls.push("device-code");
                return { account: { username: "fixture@example.invalid" }, accessToken: "synthetic-entra-token" };
            }
        },
    },
});
mock.module(new URL("../../src/http-transport-host.js", import.meta.url).href, {
    namedExports: {
        openUrlInDefaultBrowser() {
            calls.push("browser");
            throw new Error("A test must not open a real browser");
        },
    },
});

let bootstrap;
if (process.env.AUTH_PROBE_BOOTSTRAP) {
    const { bootstrapApiAuth } = await import("../../src/auth/cli.js");
    try {
        const output = [];
        const result = await bootstrapApiAuth(process.env.PILOTSWARM_API_URL, {
            output: (line) => output.push(line),
            interactive: process.env.AUTH_PROBE_BOOTSTRAP !== "silent",
        });
        bootstrap = { output, token: await result.getAccessToken() };
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
process.on("beforeExit", () => {
    console.log(`AUTH_PROBE:${JSON.stringify({ calls, bootstrap })}`);
});
