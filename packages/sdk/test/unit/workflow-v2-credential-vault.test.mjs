/**
 * Workflow v2: a trusted runtime's credential vault, inactive
 * (workflow/v2/credential-vault.ts; design 04 scoped invocation credentials),
 * with a fake issuer and fake actions.
 *
 * - It acts only for the holder sessions it was configured with; any other
 *   is refused before anything is issued.
 * - It issues once and reuses the credential until it nears expiry; after a
 *   stale refusal (expired, revoked, invalid) it issues one more and tries
 *   once more; a closed one is dropped; another refusal keeps it.
 * - The token reaches only the action: describe, JSON and inspect show the
 *   binding, never a token.
 *
 * Run: node --test test/unit/workflow-v2-credential-vault.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { WorkflowCredentialVault } from "../../dist/workflow/v2/credential-vault.js";

const BINDING = { audience: "workflow.complete", nodeExecutionId: "nx-1", holderSessionId: "C" };

function vaultWith({ holders = ["C"], now = () => 1_000_000, lifetimeMs = 3_600_000 } = {}) {
    const issued = [];
    let count = 0;
    const vault = new WorkflowCredentialVault({
        holderSessionIds: holders, now, ttlSeconds: 600,
        issue: async input => {
            count += 1;
            issued.push(input);
            return { token: `pswic_token-${count}`, credential: { credentialId: `c-${count}`, expiresAt: new Date(now() + lifetimeMs).toISOString() } };
        },
    });
    return { vault, issued };
}

test("acts only for its configured holders, issuing once and reusing the credential while it is fresh", async () => {
    const { vault, issued } = vaultWith();
    await assert.rejects(vault.withCredential({ ...BINDING, holderSessionId: "X" }, async () => "never"),
        error => error.code === "CREDENTIAL_HOLDER_NOT_SERVED" && error.status === 403);
    assert.equal(issued.length, 0);
    assert.equal(vault.serves("C"), true);
    assert.equal(vault.serves("X"), false);
    const seen = [];
    assert.equal(await vault.withCredential(BINDING, async token => { seen.push(token); return "done"; }), "done");
    await vault.withCredential(BINDING, async token => { seen.push(token); });
    assert.deepEqual(seen, ["pswic_token-1", "pswic_token-1"]);
    assert.deepEqual(issued, [{ ...BINDING, ttlSeconds: 600 }]);
    // Another effect gets its own credential.
    await vault.withCredential({ ...BINDING, nodeExecutionId: "nx-2" }, async token => { seen.push(token); });
    assert.equal(seen.at(-1), "pswic_token-2");
});

test("obtains a new credential near expiry, retries once after a stale refusal, drops a closed one and keeps it after other refusals", async () => {
    let clock = 1_000_000;
    const { vault, issued } = vaultWith({ now: () => clock, lifetimeMs: 60_000 });
    await vault.withCredential(BINDING, async () => {});
    clock += 40_000; // within the 30 s margin of its expiry
    const tokens = [];
    await vault.withCredential(BINDING, async token => { tokens.push(token); });
    assert.deepEqual(tokens, ["pswic_token-2"]);
    assert.equal(issued.length, 2);

    // A stale refusal: one more credential, one more try.
    let calls = 0;
    const result = await vault.withCredential(BINDING, async token => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("revoked"), { code: "CREDENTIAL_REVOKED", status: 403 });
        return token;
    });
    assert.equal(result, "pswic_token-3");
    assert.equal(calls, 2);
    // A second stale refusal in a row is the answer.
    await assert.rejects(vault.withCredential(BINDING, async () => { throw Object.assign(new Error("expired"), { code: "CREDENTIAL_EXPIRED" }); }),
        error => error.code === "CREDENTIAL_EXPIRED");
    assert.equal(issued.length, 4);
    // A closed effect drops the credential; an ordinary refusal keeps it.
    await vault.withCredential(BINDING, async () => {});
    await assert.rejects(vault.withCredential(BINDING, async () => { throw Object.assign(new Error("output"), { code: "OUTPUT_INVALID", status: 422 }); }),
        error => error.code === "OUTPUT_INVALID");
    const before = issued.length;
    await vault.withCredential(BINDING, async () => {});
    assert.equal(issued.length, before, "kept after an ordinary refusal");
    await assert.rejects(vault.withCredential(BINDING, async () => { throw Object.assign(new Error("closed"), { code: "CREDENTIAL_CLOSED", status: 409 }); }),
        error => error.code === "CREDENTIAL_CLOSED");
    assert.deepEqual(vault.describe(), []);
});

test("never shows a token: describe, JSON and inspect hold only bindings; forget drops an effect's credentials", async () => {
    const { vault } = vaultWith({ holders: ["C", "P"] });
    await vault.withCredential(BINDING, async () => {});
    await vault.withCredential({ audience: "workflow.respond", nodeExecutionId: "nx-9", holderSessionId: "P" }, async () => {});
    const shown = [JSON.stringify(vault.describe()), JSON.stringify(vault), inspect(vault, { depth: 10, showHidden: true }), String(vault)];
    for (const text of shown) assert.equal(/pswic_/.test(text), false, text);
    assert.deepEqual(vault.describe().map(entry => [entry.audience, entry.nodeExecutionId, entry.holderSessionId, entry.credentialId]),
        [["workflow.complete", "nx-1", "C", "c-1"], ["workflow.respond", "nx-9", "P", "c-2"]]);
    assert.equal(vault.forget("nx-1"), 1);
    assert.deepEqual(vault.describe().map(entry => entry.nodeExecutionId), ["nx-9"]);
});
