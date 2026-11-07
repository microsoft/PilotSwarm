/**
 * A Workflow agent's whole base instructions are its Workflow owner's (review SF-3): the kept text has its secrets
 * hidden (redactWorkflowSecrets) before it is hashed and saved, every surface names such a file owner-only
 * (isOwnerOnlyArtifact), and the agent artifact tools, which act for any session and check no owner, neither read,
 * copy nor write one. The portal's gate (session:manage) is tested in packages/app/web/test.
 *
 * Run: node --test test/unit/workflow-simplified-base-instructions-owner.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    SDK_SYSTEM_PROMPT_PREFIX, workflowBaseInstructionsArtifact, workflowBaseInstructionsRef, workflowBaseInstructionsText,
} from "../../dist/workflow/v2/base-instructions.js";
import { createArtifactTools } from "../../dist/artifact-tools.js";
import { FilesystemArtifactStore } from "../../dist/session-store.js";
import { isOwnerOnlyArtifact } from "../../api/src/session-authz.js";
import { isOwnerOnlyArtifact as exported } from "../../api/index.js";

const SECRET_URL = "postgres://admin:hunter2-very-secret@db.example.com:5432/app";
const ECHO = `${SDK_SYSTEM_PROMPT_PREFIX}\n\nConnect with ${SECRET_URL}.\napi_key=sk-live-0123456789abcdef\nAuthorization: Bearer abcdefghijklmnop\nBe helpful.`;

test("the kept text has its secrets hidden; its sha256 and artifact name are the hidden text's", () => {
    const kept = workflowBaseInstructionsText(ECHO);
    assert.ok(kept.startsWith(SDK_SYSTEM_PROMPT_PREFIX));
    for (const secret of ["hunter2-very-secret", "admin:", "sk-live-0123456789abcdef", "abcdefghijklmnop"]) {
        assert.ok(!kept.includes(secret), `the kept text does not hold ${secret}`);
    }
    assert.ok(kept.includes("postgres://<hidden>@db.example.com:5432/app") && kept.includes("Be helpful."));
    const ref = workflowBaseInstructionsRef("wf-1", kept);
    const sha = createHash("sha256").update(kept).digest("hex");
    assert.equal(ref.sha256, sha);
    assert.equal(ref.artifact, workflowBaseInstructionsArtifact(sha));
    assert.equal(ref.chars, kept.length);
    // A text with nothing secret is kept as it is.
    const plain = `${SDK_SYSTEM_PROMPT_PREFIX}\n\nYou are an interactive agent.`;
    assert.equal(workflowBaseInstructionsText(plain), plain);
});

test("a base-instructions artifact is owner-only on every surface; other names are not", () => {
    const name = workflowBaseInstructionsArtifact("0123456789abcdef".repeat(4));
    assert.equal(isOwnerOnlyArtifact(name), true);
    assert.equal(exported(name), true, "the API package exports the same predicate");
    // As the stores take a name: its last path part, trimmed; any letter case.
    assert.equal(isOwnerOnlyArtifact(` x/${name} `), true);
    assert.equal(isOwnerOnlyArtifact(name.toUpperCase().replace(".MD", ".md")), true);
    for (const other of ["canvas.html", "report.md", "base-instructions-.md", "base-instructions-xyz.md", "my-base-instructions-0123456789abcdef.md", null, 42]) {
        assert.equal(isOwnerOnlyArtifact(other), false, String(other));
    }
});

function harness() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-owner-only-"));
    const store = new FilesystemArtifactStore(path.join(dir, "store"));
    const byName = Object.fromEntries(createArtifactTools({ blobStore: store }).map(tool => [tool.name, tool]));
    const call = async (name, params, context = { durableSessionId: "sess-agent" }) => JSON.parse(String(await byName[name].handler(params, context)));
    return { dir, store, call, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("the agent artifact tools neither read, copy nor write a Workflow's base instructions", async () => {
    const h = harness();
    try {
        const name = workflowBaseInstructionsArtifact("0123456789abcdef".repeat(4));
        await h.store.uploadArtifact("wf-1", name, "The whole composed text.", "text/markdown");
        await h.store.uploadArtifact("sess-agent", "notes.md", "forged", "text/markdown");
        for (const params of [{ sessionId: "wf-1", filename: name }, { sessionId: "wf-1", filename: name, metaOnly: true },
            { sessionId: "wf-1", filename: name, manifestOnly: true }, { sessionId: "wf-1", filename: name, encoding: "base64" }]) {
            const out = await h.call("read_artifact", params);
            assert.equal(out.error, "ARTIFACT_OWNER_ONLY", JSON.stringify(params));
            assert.ok(!JSON.stringify(out).includes("The whole composed text."));
        }
        // Copied out of the Workflow under its own name or another, or written under its name (a forgery): refused.
        assert.equal((await h.call("write_artifact", { fromArtifact: { sessionId: "wf-1", filename: name } })).error, "ARTIFACT_OWNER_ONLY");
        assert.equal((await h.call("write_artifact", { fromArtifact: { sessionId: "wf-1", filename: name }, filename: "copy.md" })).error, "ARTIFACT_OWNER_ONLY");
        assert.equal((await h.call("write_artifact", { filename: name, content: "forged" })).error, "ARTIFACT_OWNER_ONLY");
        assert.equal((await h.call("write_artifact", { fromArtifact: { sessionId: "sess-agent", filename: "notes.md" }, filename: name })).error,
            "ARTIFACT_OWNER_ONLY");
        assert.equal(await h.store.statArtifact("sess-agent", name), null, "nothing was written");
        // Every other file is as before.
        assert.equal((await h.call("read_artifact", { sessionId: "sess-agent", filename: "notes.md" })).content, "forged");
    } finally { h.cleanup(); }
});
