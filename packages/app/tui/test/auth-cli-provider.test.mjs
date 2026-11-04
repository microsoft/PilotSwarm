import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/tui.js", import.meta.url));
// `--import` takes a module specifier; a Windows path would parse as a `c:` URL.
const probeUrl = new URL("./fixtures/auth-cli-probe.mjs", import.meta.url);
const probe = fileURLToPath(probeUrl);
const entra = {
    enabled: true, provider: "entra",
    client: { clientId: "synthetic-client", authority: "https://login.example.invalid/tenant" },
};

async function fixture(t, config) {
    const home = await mkdtemp(path.join(tmpdir(), "auth-cli-test-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const requests = [];
    const server = createServer((request, response) => {
        requests.push(request.url);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(config));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return { home, requests, apiUrl: `http://127.0.0.1:${server.address().port}` };
}

async function run(f, action, { persona, mocked = true, scenario = "valid", bootstrap, extra = [] } = {}) {
    // Deliberate allowlist: no inherited tokens, proxies, NODE_OPTIONS or config.
    const env = {
        HOME: f.home, USERPROFILE: f.home, XDG_CONFIG_HOME: f.home,
        PILOTSWARM_API_URL: f.apiUrl, AUTH_PROBE_SCENARIO: scenario,
    };
    for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"]) {
        if (process.env[key]) env[key] = process.env[key];
    }
    if (persona !== undefined) env.PILOTSWARM_DEV_USER = persona;
    if (bootstrap) env.AUTH_PROBE_BOOTSTRAP = bootstrap;
    const args = mocked
        ? ["--experimental-test-module-mocks", "--no-warnings=ExperimentalWarning", "--import", probeUrl.href]
        : [];
    args.push(...(bootstrap ? [probe] : [cli, "auth", action, ...extra]));
    const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
            cwd: f.home, env, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    assert.equal(result.signal, null, JSON.stringify(result));
    const match = result.stdout.match(/^AUTH_PROBE:(.*)$/m);
    result.trace = match ? JSON.parse(match[1]) : null;
    result.output = result.stdout.replace(/^AUTH_PROBE:.*\n?/m, "") + result.stderr;
    assert.doesNotMatch(result.output, /dev:alice|dev:bob|synthetic-entra-token/);
    return result;
}

function expect(result, code, output, calls) {
    assert.equal(result.code, code, JSON.stringify(result));
    assert.match(result.output, output);
    if (calls) assert.deepEqual(result.trace.calls, calls);
}

test("real CLI login/status select normalized dev personas without Entra configuration", async (t) => {
    const f = await fixture(t, { enabled: true, provider: "dev", client: null });
    for (const [persona, name] of [[" Alice ", "alice"], ["BOB", "bob"]]) {
        for (const action of ["status", "login"]) {
            const result = await run(f, action, { persona, mocked: false });
            expect(result, 0, new RegExp(`Selected dev persona '${name}'`));
            assert.match(result.output, /no dev roster, so the persona was not checked/);
            assert.doesNotMatch(result.output, /Entra|browser|Token cache is valid/);
        }
    }
    assert.deepEqual(f.requests, Array(4).fill("/api/v1/auth/config"));
    assert.deepEqual(await readdir(f.home), [], "dev must not create auth cache files");
});

test("dev commands and startup share persona resolution and never enter MSAL", async (t) => {
    const f = await fixture(t, { enabled: true, provider: "dev", client: { users: [{ id: "alice" }, { id: "bob" }] } });
    for (const [persona, name] of [[" Alice ", "alice"], ["BOB", "bob"]]) {
        for (const action of ["login", "status"]) {
            const result = await run(f, action, { persona, extra: ["--device-code"] });
            expect(result, 0, new RegExp(`'${name}'`), []);
            assert.match(result.output, /in the deployment's dev roster/);
        }
        const boot = await run(f, null, { persona, bootstrap: "interactive" });
        assert.equal(boot.code, 0);
        assert.deepEqual(boot.trace.calls, []);
        assert.equal(boot.trace.bootstrap.token, `dev:${name}`);
    }
    for (const [persona, error] of [
        [undefined, /Set PILOTSWARM_DEV_USER to a persona id/],
        ["  ", /Set PILOTSWARM_DEV_USER to a persona id/],
        // The server rejects personas outside its roster, so success here would end in 401s.
        ["mallory", /'mallory' is not in the roster .*one of: alice, bob/],
        ["alice bob", /'alice bob' is not in the roster/],
    ]) {
        for (const action of ["login", "status", null]) {
            const result = await run(f, action, { persona, bootstrap: action === null ? "interactive" : undefined });
            expect(result, 1, error, []);
        }
    }
});

test("disabled/none take precedence for commands and bootstrap without MSAL", async (t) => {
    for (const config of [
        { enabled: true, provider: "none" },
        { enabled: false, provider: "dev" },
        { enabled: false, provider: "entra" },
        { enabled: false, provider: "unknown" },
    ]) {
        const f = await fixture(t, config);
        for (const action of ["login", "status"]) {
            expect(await run(f, action), 0, /does not require sign-in/, []);
        }
        const boot = await run(f, null, { bootstrap: "interactive" });
        assert.equal(boot.code, 0);
        assert.equal(boot.trace.bootstrap.token, null);
        assert.deepEqual(boot.trace.calls, []);
    }
});

test("unsupported providers fail clearly in commands and bootstrap, never as Entra", async (t) => {
    for (const provider of ["proxy", "unknown", "Dev"]) {
        const f = await fixture(t, { enabled: true, provider, client: null });
        for (const action of ["login", "status", null]) {
            const result = await run(f, action, { bootstrap: action === null ? "interactive" : undefined });
            expect(result, 1, new RegExp(`Unsupported auth provider '${provider}'`), []);
            assert.doesNotMatch(result.output, /Entra|PORTAL_AUTH_ENTRA/);
        }
    }
});

test("Entra status stays silent-only for valid, absent, stale and failed acquisition", async (t) => {
    const f = await fixture(t, entra);
    for (const [scenario, code, output, calls] of [
        ["valid", 0, /Token cache is valid/, ["msal", "accounts", "msal", "accounts", "silent"]],
        ["absent", 1, /Not signed in/, ["msal", "accounts"]],
        ["stale", 1, /Token cache is stale/, ["msal", "accounts", "msal", "accounts", "silent"]],
        ["silent-failure", 1, /Token cache is stale/, ["msal", "accounts", "msal", "accounts", "silent"]],
    ]) {
        expect(await run(f, "status", { scenario, extra: ["--device-code"] }), code, output, calls);
    }
});

test("Entra login preserves silent-first, browser/device-code fallback and bootstrap", async (t) => {
    const f = await fixture(t, entra);
    expect(await run(f, "login"), 0, /fixture@example.invalid/, ["msal", "accounts", "silent"]);
    for (const [extra, method] of [[[], "interactive"], [["--device-code"], "device-code"]]) {
        expect(await run(f, "login", { scenario: "absent", extra }), 0, /fixture@example.invalid/,
            ["msal", "accounts", method]);
    }
    for (const bootstrap of ["interactive", "silent"]) {
        const boot = await run(f, null, { bootstrap });
        assert.equal(boot.code, 0);
        assert.equal(boot.trace.bootstrap.token, "synthetic-entra-token");
        assert.deepEqual(boot.trace.calls, bootstrap === "interactive"
            ? ["msal", "accounts", "silent", "msal", "accounts", "silent"]
            : ["msal", "accounts", "silent"]);
    }
    const missingClient = await fixture(t, { enabled: true, provider: "entra", client: null });
    for (const action of ["login", "status"]) {
        expect(await run(missingClient, action), 1, /reports Entra auth but no public client configuration/, []);
    }
});

test("real logout remains offline and removes only the synthetic origin cache", async (t) => {
    const f = await fixture(t, {});
    const cache = path.join(f.home, "pilotswarm", "auth");
    await mkdir(cache, { recursive: true });
    const ownFile = path.join(cache, `http_127.0.0.1_${new URL(f.apiUrl).port}.json`);
    const otherFile = path.join(cache, "unrelated.json");
    await writeFile(ownFile, "synthetic cache");
    await writeFile(otherFile, "unrelated synthetic cache");
    for (let attempt = 0; attempt < 2; attempt++) {
        expect(await run(f, "logout", { mocked: false }), 0, /Signed out/);
        assert.deepEqual(await readdir(cache), ["unrelated.json"]);
    }
    assert.equal(await readFile(otherFile, "utf8"), "unrelated synthetic cache");
    // The fixture serves discovery; logout must not request it.
    assert.deepEqual(f.requests, []);
});
