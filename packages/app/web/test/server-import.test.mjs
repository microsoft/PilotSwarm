import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("importing the public web server from a different launcher named server.js never starts a portal", async () => {
    const serverUrl = new URL("../server.js", import.meta.url).href;
    const script = `process.argv[1] = "/synthetic/launcher/server.js";
        const web = await import(${JSON.stringify(serverUrl)});
        const publicWeb = await import("pilotswarm/web");
        const sdk = await import("pilotswarm-sdk");
        if (publicWeb !== web) throw new Error("Public web export must resolve the same server module");
        if ("PORTAL_APP_PAGE_API_VERSION" in web) throw new Error("Removed page hosting marker remains public");
        if (typeof web.startServer !== "function"
            || typeof sdk.PilotSwarmWorker.prototype.getHostServices !== "function"
            || typeof sdk.PilotSwarmManagementClient.prototype.getHostServices !== "function")
            throw new Error("Ordinary server and SDK host services must remain public");
        console.log("safe-import");`;
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
        timeout: 15000,
        env: { ...process.env, DATABASE_URL: "", WORKERS: "0", PORTAL_TUI_MODE: "remote" },
    });
    assert.match(result.stdout, /safe-import/);
    assert.doesNotMatch(result.stdout + result.stderr, /\[portal\]/);
});

test("ordinary server entry and routes contain no page host contract", async () => {
    for (const file of ["server.js", "runtime.js", "auth/index.js"]) {
        const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
        assert.doesNotMatch(source, /PortalAppPage|appPages|app-pages|\/api\/v1\/apps|\/app-assets|getVerifiedPrincipal|isVerifiedBearerRequest/);
    }
});

test("public server preserves cold health, auth discovery and repeated stop without starting a runtime", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "pilotswarm-server-contract-"));
    const serverUrl = new URL("../server.js", import.meta.url).href;
    const apiUrl = import.meta.resolve("pilotswarm-sdk/api");
    const script = `
            import assert from "node:assert/strict";
            const { startServer } = await import(${JSON.stringify(serverUrl)});
            const { ApiClient } = await import(${JSON.stringify(apiUrl)});
            const before = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
            const server = await startServer({ host: "127.0.0.1", port: 0, workers: 0 });
            const port = server.address().port;
            try {
                const activeListeners = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
                await assert.rejects(startServer({ host: "127.0.0.1", port, workers: 0 }),
                    error => error.code === "EADDRINUSE");
                for (const signal of Object.keys(before)) assert.equal(process.listenerCount(signal), activeListeners[signal]);
                const origin = "http://127.0.0.1:" + port;
                const api = new ApiClient({ apiUrl: origin });
                assert.equal((await api.health()).started, false);
                const config = await api.getAuthConfig();
                assert.equal(config.provider, "dev");
                assert.deepEqual(config.client.users.map(user => user.id), ["fixture-admin"]);
                await assert.rejects(api.getAuthContext(), error => error.status === 401);
                await assert.rejects(api.request("GET", "/api/v1/apps"), error => error.status === 401);
                assert.equal((await api.health()).started, false);
            } finally {
                await Promise.all([server.stopPortal(), server.stopPortal()]);
            }
            assert.equal(server.listening, false);
            for (const signal of Object.keys(before)) assert.equal(process.listenerCount(signal), before[signal]);
            const restarted = await startServer({ host: "127.0.0.1", port, workers: 0 });
            await restarted.stopPortal();
            assert.equal(restarted.listening, false);
            for (const signal of Object.keys(before)) assert.equal(process.listenerCount(signal), before[signal]);
            console.log("public-server-contract-ok");
    `;
    try {
        const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
            timeout: 20000,
            cwd: home,
            env: {
                PATH: process.env.PATH, HOME: home, TMPDIR: home,
                DATABASE_URL: "", PORTAL_TUI_MODE: "remote", WORKERS: "0",
                PORTAL_AUTH_PROVIDER: "dev", PORTAL_AUTH_DEV_ALLOW: "true",
                PORTAL_AUTH_DEV_USERS: "fixture-admin:admin",
            },
        });
        assert.match(result.stdout, /public-server-contract-ok/);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
