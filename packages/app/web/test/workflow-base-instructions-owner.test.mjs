/**
 * A Workflow agent's whole base instructions (`base-instructions-<sha256 prefix>.md` on the Workflow's session) are its
 * owner's (review SF-3): reading, listing, copying or writing such a file needs session:manage (its owner or an
 * admin), enforced whatever the ownership switch says. A reader the Workflow is shared with reads every other file
 * of it, but not this one, and is not shown its name; a writer it is shared with cannot plant one. Exercised through
 * PortalRuntime.call (the /api/v1 and /api/rpc enforcement point) and its bespoke download routes.
 *
 * Run: node --test web/test/workflow-base-instructions-owner.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PortalRuntime } from "../runtime.js";

const NAME = "base-instructions-0123456789abcdef.md";
const TEXT = "You are the GitHub Copilot CLI, a terminal assistant built by GitHub.\n\nThe whole composed text.";

/** alice's sessions: wf (shared_read), wfw (shared_write), mine (bob's own, private), s1 (alice's, private). */
function runtimeWith({ enforce }) {
    const reads = [];
    const writes = [];
    const audits = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce };
    const alice = { provider: "dev", subject: "alice" };
    const bob = { provider: "dev", subject: "bob" };
    const ownerOf = sessionId => (sessionId === "mine" ? bob : alice);
    const visibility = { wf: "shared_read", wfw: "shared_write", mine: "private", s1: "private" };
    const files = new Map([["wf", [NAME, "notes.md"]], ["wfw", [NAME]], ["mine", ["notes.md"]], ["s1", [NAME]]]);
    runtime.transport = {
        getSessionAccess: async (sessionId, viewer) => (!visibility[sessionId] ? null : {
            rootSessionId: sessionId,
            isSystem: false,
            visibility: visibility[sessionId],
            owner: { ...ownerOf(sessionId), displayName: ownerOf(sessionId).subject },
            viewerIsOwner: viewer.provider === ownerOf(sessionId).provider && viewer.subject === ownerOf(sessionId).subject,
            viewerShareAccess: null,
        }),
        recordAuthzAudit: async entry => { audits.push(entry); },
        listArtifacts: async sessionId => (files.get(sessionId) ?? []).map(filename => ({ filename, sizeBytes: 1 })),
        getArtifactMetadata: async (sessionId, filename) => { reads.push(["meta", sessionId, filename]); return { filename, sha256: "x" }; },
        downloadArtifact: async (sessionId, filename) => { reads.push(["text", sessionId, filename]); return filename === NAME ? TEXT : "notes"; },
        downloadArtifactBinary: async (sessionId, filename) => { reads.push(["binary", sessionId, filename]); return { filename, body: Buffer.from(TEXT) }; },
        readArtifactBase64: async (sessionId, filename) => { reads.push(["base64", sessionId, filename]); return { content: Buffer.from(TEXT).toString("base64") }; },
        uploadArtifactContent: async (sessionId, filename) => { writes.push(["upload", sessionId, filename]); return { filename }; },
        copyArtifact: async (from, fromFilename, to, toFilename) => { writes.push(["copy", from, fromFilename, to, toFilename]); return { filename: toFilename }; },
        deleteArtifact: async (sessionId, filename) => { writes.push(["delete", sessionId, filename]); return true; },
        setArtifactPinned: async (sessionId, filename) => { writes.push(["pin", sessionId, filename]); return { filename }; },
    };
    return { runtime, reads, writes, audits };
}

const as = (subject, role = "user") => ({ principal: { provider: "dev", subject }, authorization: { role } });
const forbidden = error => error.status === 403 && error.code === "FORBIDDEN";
const notFound = error => error.status === 404 && error.code === "NOT_FOUND";

for (const enforce of [true, false]) {
    test(`a shared reader reads the Workflow's other files but not its base instructions, nor sees their name (ownership switch ${enforce ? "on" : "off"})`, async () => {
        const { runtime, reads, writes, audits } = runtimeWith({ enforce });
        // The owner and an admin read them, through every read.
        assert.equal(await runtime.call("downloadArtifact", { sessionId: "wf", filename: NAME }, as("alice")), TEXT);
        assert.equal(await runtime.call("downloadArtifact", { sessionId: "wf", filename: NAME }, as("ada", "admin")), TEXT);
        assert.deepEqual((await runtime.call("listArtifacts", { sessionId: "wf" }, as("alice"))).map(entry => entry.filename), [NAME, "notes.md"]);
        assert.equal(await runtime.downloadArtifact("wf", NAME, as("alice")), TEXT);

        // A reader it is shared with: refused, through every read and every route; its other files are as before.
        reads.length = 0;
        const calls = [["downloadArtifact", { sessionId: "wf", filename: NAME }], ["getArtifactMetadata", { sessionId: "wf", filename: NAME }],
            ["readArtifactBase64", { sessionId: "wf", filename: NAME }], ["downloadArtifact", { sessionId: "wf", filename: ` dir/${NAME}` }],
            ["downloadArtifact", { sessionId: "wf", filename: NAME.toUpperCase().replace(".MD", ".md") }]];
        for (const [method, params] of calls) {
            await assert.rejects(runtime.call(method, params, as("bob")), forbidden, `${method} ${params.filename}`);
        }
        await assert.rejects(runtime.downloadArtifact("wf", NAME, as("bob")), forbidden);
        await assert.rejects(runtime.getArtifactMetadata("wf", NAME, as("bob")), forbidden);
        await assert.rejects(runtime.downloadArtifactBinary("wf", NAME, as("bob")), forbidden);
        assert.deepEqual(reads, [], "nothing was read for the shared reader");
        assert.equal(await runtime.call("downloadArtifact", { sessionId: "wf", filename: "notes.md" }, as("bob")), "notes");
        assert.deepEqual((await runtime.call("listArtifacts", { sessionId: "wf" }, as("bob"))).map(entry => entry.filename), ["notes.md"]);
        assert.ok(audits.some(entry => entry.action === "downloadArtifact" && entry.sessionId === "wf" && entry.decision === "deny"));

        // Someone the Workflow is not shared with learns nothing: not found.
        await assert.rejects(runtime.call("downloadArtifact", { sessionId: "s1", filename: NAME }, as("bob")), notFound);
        await assert.rejects(runtime.call("downloadArtifact", { sessionId: "gone", filename: NAME }, as("alice")), notFound);

        // Copying them out to one's own session, under their name or another: refused.
        writes.length = 0;
        for (const toFilename of [undefined, "copy.md"]) {
            await assert.rejects(runtime.call("copyArtifact", { fromSessionId: "wf", fromFilename: NAME, toSessionId: "mine", toFilename }, as("bob")), forbidden);
        }
        assert.deepEqual(writes, []);
    });

    test(`a shared writer cannot plant, replace, pin or delete a Workflow's base instructions (ownership switch ${enforce ? "on" : "off"})`, async () => {
        const { runtime, writes } = runtimeWith({ enforce });
        await assert.rejects(runtime.call("uploadArtifact", { sessionId: "wfw", filename: NAME, content: "forged" }, as("bob")), forbidden);
        await assert.rejects(runtime.call("copyArtifact", { fromSessionId: "mine", fromFilename: "notes.md", toSessionId: "wfw", toFilename: NAME },
            as("bob")), forbidden);
        await assert.rejects(runtime.call("setArtifactPinned", { sessionId: "wfw", filename: NAME, pinned: true }, as("bob")), forbidden);
        await assert.rejects(runtime.call("deleteArtifact", { sessionId: "wfw", filename: NAME }, as("bob")), forbidden);
        assert.deepEqual(writes, []);
        // Another file is written as before; the owner writes this one.
        await runtime.call("uploadArtifact", { sessionId: "wfw", filename: "notes.md", content: "ok" }, as("bob"));
        await runtime.call("uploadArtifact", { sessionId: "wfw", filename: NAME, content: "kept" }, as("alice"));
        assert.deepEqual(writes, [["upload", "wfw", "notes.md"], ["upload", "wfw", NAME]]);
    });
}
