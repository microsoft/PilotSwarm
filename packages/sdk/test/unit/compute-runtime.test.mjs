/**
 * Driving a remote GHCP runtime (docs/proposals/compute-providers.md): the
 * runtime gets credential placeholders, the worker's request handler swaps
 * them back, and session state stays in the worker's directory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    REMOTE_SESSION_STATE_ROOT,
    WorkerDirectorySessionFs,
    containsWorkerPlaceholder,
    injectSecrets,
    redactProviderSecrets,
} from "../../dist/compute-runtime.js";

test("redaction replaces every credential with a per-session placeholder", async () => {
    const provider = {
        type: "azure",
        baseUrl: "https://example.invalid/openai",
        apiKey: "real-key",
        bearerToken: "real-bearer",
        headers: { "x-api-key": "header-secret" },
        bearerTokenProvider: async () => "fresh-token",
    };
    const { provider: redacted, secrets } = redactProviderSecrets(provider, "s1");
    assert.equal(redacted.baseUrl, provider.baseUrl);
    for (const field of ["apiKey", "bearerToken"]) {
        assert.notEqual(redacted[field], provider[field]);
        assert.ok(containsWorkerPlaceholder(redacted[field]));
        assert.match(redacted[field], /s1$/);
    }
    assert.ok(containsWorkerPlaceholder(redacted.headers["x-api-key"]));
    assert.ok(containsWorkerPlaceholder(await redacted.bearerTokenProvider({ providerName: "default" })));
    assert.equal(JSON.stringify(redacted).includes("real-key"), false);
    assert.equal(secrets.size, 4);
    assert.equal(provider.apiKey, "real-key", "the original config is not changed");

    const other = redactProviderSecrets(provider, "s2").provider;
    assert.notEqual(other.apiKey, redacted.apiKey, "placeholders differ between sessions");
});

test("redaction of no provider is a no-op", () => {
    const { provider, secrets } = redactProviderSecrets(undefined, "s1");
    assert.equal(provider, undefined);
    assert.equal(secrets.size, 0);
});

test("the request handler swaps placeholders back, including fresh tokens", async () => {
    const { provider, secrets } = redactProviderSecrets({ apiKey: "k1", bearerTokenProvider: async () => "t-123" }, "s1");
    const placeholderToken = await provider.bearerTokenProvider({ providerName: "default" });
    const request = new Request("https://example.invalid/v1/chat/completions", {
        method: "POST",
        headers: { "api-key": provider.apiKey, authorization: `Bearer ${placeholderToken}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "m" }),
    });
    const out = await injectSecrets(request, secrets);
    assert.equal(out.headers.get("api-key"), "k1");
    assert.equal(out.headers.get("authorization"), "Bearer t-123");
    assert.equal(await out.text(), JSON.stringify({ model: "m" }));
});

test("a request without placeholders passes through unchanged", async () => {
    const request = new Request("https://example.invalid/x", { headers: { authorization: "Bearer plain" } });
    assert.equal(await injectSecrets(request, new Map()), request);
});

test("a placeholder the worker cannot resolve is refused, never sent", async () => {
    const { provider } = redactProviderSecrets({ apiKey: "k1" }, "other-session");
    const request = new Request("https://example.invalid/x", { headers: { "api-key": provider.apiKey } });
    await assert.rejects(injectSecrets(request, new Map()), /cannot resolve/);
});

test("session state lives in the worker's session directory and cannot escape it", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-sessionfs-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sfs = new WorkerDirectorySessionFs(dir);

    await sfs.writeFile(`${REMOTE_SESSION_STATE_ROOT}/events.jsonl`, "a\n");
    await sfs.appendFile(`${REMOTE_SESSION_STATE_ROOT}/events.jsonl`, "b\n");
    assert.equal(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8"), "a\nb\n");
    assert.equal(await sfs.readFile(`${REMOTE_SESSION_STATE_ROOT}/events.jsonl`), "a\nb\n");

    await sfs.mkdir(`${REMOTE_SESSION_STATE_ROOT}/checkpoints/1`, true);
    await sfs.writeFile(`${REMOTE_SESSION_STATE_ROOT}/checkpoints/1/state.json`, "{}");
    assert.deepEqual((await sfs.readdirWithTypes(REMOTE_SESSION_STATE_ROOT)).sort((a, b) => a.name.localeCompare(b.name)),
        [{ name: "checkpoints", type: "directory" }, { name: "events.jsonl", type: "file" }]);
    const st = await sfs.stat(`${REMOTE_SESSION_STATE_ROOT}/events.jsonl`);
    assert.equal(st.isFile, true);
    assert.equal(st.size, 4);

    await sfs.rename(`${REMOTE_SESSION_STATE_ROOT}/events.jsonl`, `${REMOTE_SESSION_STATE_ROOT}/old/events.jsonl`);
    assert.equal(await sfs.exists(`${REMOTE_SESSION_STATE_ROOT}/events.jsonl`), false);
    assert.equal(await sfs.exists(`${REMOTE_SESSION_STATE_ROOT}/old/events.jsonl`), true);
    await sfs.rm(`${REMOTE_SESSION_STATE_ROOT}/old`, true, false);
    assert.equal(fs.existsSync(path.join(dir, "old")), false);

    await assert.rejects(sfs.readFile(`${REMOTE_SESSION_STATE_ROOT}/../../etc/passwd`), /outside the session directory/);
    await assert.rejects(sfs.writeFile("/../escape.txt", "x"), /outside the session directory/);
});
