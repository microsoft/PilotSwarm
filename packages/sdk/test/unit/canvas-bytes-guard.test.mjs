/**
 * Canvas app registry (issue 181): the artifact tools' byte guard checks
 * every read small enough to be an app page, whatever its filename or
 * content type says, and refuses a copy of another owner's app page.
 *
 * This is defense in depth, not the authority boundary: it withholds bytes
 * the registry identifies (exact page bytes, same workspace block) from the
 * artifact tools only. A near-copy, and other channels (folders, web,
 * messages), are not covered; workspace access is decided by the owner's
 * positive approval instead (see canvas-workspace-approval.test.js).
 *
 * Run: node --test test/unit/canvas-bytes-guard.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createArtifactTools } from "../../dist/artifact-tools.js";
import { FilesystemArtifactStore } from "../../dist/session-store.js";

const FOREIGN = "<!doctype html><!-- CANVAS-APP-MANIFEST {} --><html><body>bob's app</body></html>";

function harness() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-canvas-guard-"));
    const store = new FilesystemArtifactStore(path.join(dir, "store"));
    const seen = [];
    const canvasBytesGuard = async ({ bytes }) => {
        const text = bytes == null ? null : Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
        seen.push(text);
        return text === FOREIGN ? "these bytes are the canvas app \"bobs-app\" of another user" : null;
    };
    const tools = createArtifactTools({ blobStore: store, canvasBytesGuard });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const call = async (name, params) => JSON.parse(String(await byName[name].handler(params, { durableSessionId: "alice-session" })));
    return { dir, store, seen, call, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

for (const [filename, contentType] of [["page.html", "text/html"], ["notes.txt", "text/plain"], ["data.json", "application/json"], ["blob.bin", "application/octet-stream"]]) {
    test(`a read of another owner's page is refused when it is labelled ${filename} (${contentType})`, async () => {
        const h = harness();
        try {
            await h.store.uploadArtifact("bob-session", filename, FOREIGN, contentType);
            const inline = await h.call("read_artifact", { sessionId: "bob-session", filename });
            assert.equal(inline.error, "CANVAS_APP_BYTES");
            const base64 = await h.call("read_artifact", { sessionId: "bob-session", filename, encoding: "base64" });
            assert.equal(base64.error, "CANVAS_APP_BYTES");
            const dest = path.join(h.dir, "out", filename);
            const toFile = await h.call("read_artifact", { sessionId: "bob-session", filename, toFile: dest });
            assert.equal(toFile.error, "CANVAS_APP_BYTES");
            assert.equal(fs.existsSync(dest), false, "nothing is written");
        } finally { h.cleanup(); }
    });
}

test("a copy of another owner's page fails and leaves no copy, whatever the label", async () => {
    const h = harness();
    try {
        await h.store.uploadArtifact("bob-session", "notes.txt", FOREIGN, "text/plain");
        const copy = await h.call("write_artifact", { fromArtifact: { sessionId: "bob-session", filename: "notes.txt" }, filename: "mine.txt" });
        assert.equal(copy.error, "CANVAS_APP_BYTES");
        assert.equal(await h.store.statArtifact("alice-session", "mine.txt"), null, "the copy was removed");
    } finally { h.cleanup(); }
});

test("ordinary reads and copies are unchanged", async () => {
    const h = harness();
    try {
        await h.store.uploadArtifact("bob-session", "notes.txt", "hello", "text/plain");
        const read = await h.call("read_artifact", { sessionId: "bob-session", filename: "notes.txt" });
        assert.equal(read.content, "hello");
        const copy = await h.call("write_artifact", { fromArtifact: { sessionId: "bob-session", filename: "notes.txt" }, filename: "mine.txt" });
        assert.equal(copy.success, true);
    } finally { h.cleanup(); }
});

test("a near-copy is NOT recognized: the guard is accident reduction, not lineage", async () => {
    const h = harness();
    try {
        await h.store.uploadArtifact("bob-session", "page.html", `${FOREIGN} `, "text/html");
        const read = await h.call("read_artifact", { sessionId: "bob-session", filename: "page.html" });
        assert.equal(read.error, undefined, "one extra byte reads normally; workspace approval, not this guard, is the boundary");
    } finally { h.cleanup(); }
});

test("canvas documents are written only by a draw: write_artifact refuses canvas.html … canvas5.html by any source", async () => {
    const h = harness();
    try {
        await h.store.uploadArtifact("alice-session", "canvas.html", "<p>drawn page</p>", "text/html");
        for (const filename of ["canvas.html", "canvas2.html", "canvas5.html", "CANVAS3.HTML"]) {
            const inline = await h.call("write_artifact", { filename, content: "<p>swapped</p>" });
            assert.equal(inline.error, "CANVAS_FILE_RESERVED", filename);
        }
        const local = path.join(h.dir, "canvas.html");
        fs.writeFileSync(local, "<p>swapped</p>");
        const fromFile = await h.call("write_artifact", { fromFile: local });
        assert.equal(fromFile.error, "CANVAS_FILE_RESERVED", "a local file named canvas.html");
        await h.store.uploadArtifact("bob-session", "canvas.html", "<p>bob</p>", "text/html");
        const copied = await h.call("write_artifact", { fromArtifact: { sessionId: "bob-session", filename: "canvas.html" } });
        assert.equal(copied.error, "CANVAS_FILE_RESERVED", "a copy whose default name is canvas.html");
        assert.equal(await h.store.downloadArtifactText("alice-session", "canvas.html"), "<p>drawn page</p>", "the drawn page is untouched");
        // The save-as recipe still works: canvas.html is the source, not the target.
        const saved = await h.call("write_artifact", { fromArtifact: { filename: "canvas.html" }, filename: "app-board.html" });
        assert.equal(saved.success, true);
    } finally { h.cleanup(); }
});

test("another user's PRIVATE app page is absent in every read mode, metadata and listing included", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-canvas-guard-private-"));
    const store = new FilesystemArtifactStore(path.join(dir, "store"));
    const PRIVATE = "<!doctype html><!-- CANVAS-APP-MANIFEST {\"name\":\"secret\"} --><html><body>alice private</body></html>";
    const crypto = await import("node:crypto");
    const privateSha = crypto.createHash("sha256").update(PRIVATE).digest("hex");
    const canvasBytesGuard = async ({ bytes, sha256 }) => {
        const text = bytes == null ? null : Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
        if (text === PRIVATE || (text == null && sha256 === privateSha)) return "artifact not found";
        return null;
    };
    const tools = Object.fromEntries(createArtifactTools({ blobStore: store, canvasBytesGuard }).map((t) => [t.name, t]));
    const call = async (name, params) => JSON.parse(String(await tools[name].handler(params, { durableSessionId: "bob-session" })));
    try {
        await store.uploadArtifact("alice-session", "saved.txt", PRIVATE, "text/plain");
        await store.uploadArtifact("alice-session", "notes.md", "# hello", "text/markdown");
        for (const mode of [{}, { encoding: "base64" }, { manifestOnly: true }, { metaOnly: true }]) {
            const out = await call("read_artifact", { sessionId: "alice-session", filename: "saved.txt", ...mode });
            assert.equal(out.error, "ARTIFACT_NOT_FOUND", JSON.stringify(mode));
        }
        const listed = await call("list_artifacts", { sessionId: "alice-session" });
        assert.deepEqual(listed.filenames, ["notes.md"], "the private page is not listed");
        const meta = await call("read_artifact", { sessionId: "alice-session", filename: "notes.md", metaOnly: true });
        assert.equal(meta.success, true, "ordinary files keep their metadata");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("private legacy artifacts without a stored sha are absent in metadata and lists; ordinary legacy files and the owner keep them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-canvas-guard-legacy-"));
    const store = new FilesystemArtifactStore(path.join(dir, "store"));
    const PRIVATE = "<!doctype html><!-- CANVAS-APP-MANIFEST {\"name\":\"secret\"} --><html><body>alice private</body></html>";
    const guardCalls = [];
    // The registry's answer: these bytes are Alice's private app; foreign to
    // everyone but the owner's own session.
    const canvasBytesGuard = async ({ callerSessionId, bytes, sha256, privateOnly }) => {
        guardCalls.push({ callerSessionId, bytes: bytes != null, sha256: sha256 ?? null, privateOnly: privateOnly === true });
        if (callerSessionId === "alice-session") return null;
        const text = bytes == null ? null : Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
        return text === PRIVATE ? "artifact not found" : null;
    };
    const tools = Object.fromEntries(createArtifactTools({ blobStore: store, canvasBytesGuard }).map((t) => [t.name, t]));
    const callAs = (caller) => async (name, params) => JSON.parse(String(await tools[name].handler(params, { durableSessionId: caller })));
    const bob = callAs("bob-session");
    const ownerless = callAs(null);
    const alice = callAs("alice-session");
    try {
        // Legacy shapes the upload path no longer produces: a sidecar with no
        // sha256 (content type only), and no sidecar at all (sniffed).
        await store.uploadArtifact("alice-session", "app-secret.html", PRIVATE, "text/html");
        await store.uploadArtifact("alice-session", "old-copy.txt", PRIVATE, "text/plain");
        await store.uploadArtifact("alice-session", "readme.md", "# hello", "text/markdown");
        const sidecar = (filename) => path.join(dir, "store", "alice-session", `${filename}.meta.json`);
        for (const filename of ["app-secret.html", "readme.md"]) {
            assert.ok(fs.existsSync(sidecar(filename)), `sidecar for ${filename}`);
            const legacy = JSON.parse(fs.readFileSync(sidecar(filename), "utf8"));
            delete legacy.sha256;
            fs.writeFileSync(sidecar(filename), JSON.stringify(legacy));
        }
        fs.rmSync(sidecar("old-copy.txt"));
        for (const filename of ["app-secret.html", "old-copy.txt", "readme.md"]) {
            assert.equal((await store.statArtifact("alice-session", filename)).sha256, undefined, `${filename} has no stored sha256`);
        }
        for (const caller of [bob, ownerless]) {
            const listed = await caller("list_artifacts", { sessionId: "alice-session" });
            assert.deepEqual(listed.filenames, ["readme.md"], "neither copy of the private page is listed");
            for (const filename of ["app-secret.html", "old-copy.txt"]) {
                const meta = await caller("read_artifact", { sessionId: "alice-session", filename, metaOnly: true });
                assert.equal(meta.error, "ARTIFACT_NOT_FOUND", `${filename} metadata`);
                const content = await caller("read_artifact", { sessionId: "alice-session", filename });
                assert.equal(content.error, "ARTIFACT_NOT_FOUND", `${filename} content`);
            }
            const ordinary = await caller("read_artifact", { sessionId: "alice-session", filename: "readme.md", metaOnly: true });
            assert.equal(ordinary.success, true, "an ordinary legacy file keeps its metadata");
        }
        assert.ok(guardCalls.some((c) => c.bytes && c.privateOnly), "the guard was asked by the bytes, not by a missing sha");
        // The owner's own session still sees everything.
        const own = await alice("list_artifacts", { sessionId: "alice-session" });
        assert.deepEqual(own.filenames.sort(), ["app-secret.html", "old-copy.txt", "readme.md"]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a legacy entry whose bytes cannot be read is hidden from metadata and lists (fail closed)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-canvas-guard-unreadable-"));
    const real = new FilesystemArtifactStore(path.join(dir, "store"));
    try {
        await real.uploadArtifact("alice-session", "page.html", "<p>x</p>", "text/html");
        const store = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
            statArtifact: async (...a) => { const m = await real.statArtifact(...a); delete m.sha256; return m; },
            listArtifacts: async (...a) => (await real.listArtifacts(...a)).map(({ sha256: _s, ...m }) => m),
            downloadArtifactText: async () => { throw new Error("simulated storage outage"); },
        });
        const tools = Object.fromEntries(createArtifactTools({ blobStore: store, canvasBytesGuard: async () => null }).map((t) => [t.name, t]));
        const call = async (name, params) => JSON.parse(String(await tools[name].handler(params, { durableSessionId: "bob-session" })));
        assert.deepEqual((await call("list_artifacts", { sessionId: "alice-session" })).filenames, []);
        assert.equal((await call("read_artifact", { sessionId: "alice-session", filename: "page.html", metaOnly: true })).error, "ARTIFACT_NOT_FOUND");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// The canvas app transition (issue 181): an old app's exact page is read as on
// main, decided by the old catalog when the read happens.
test("canvasBytesRefusal: an old app's exact bytes are never refused while the transition says so; otherwise the registry's rule", async () => {
    const { canvasBytesRefusal } = await import("../../dist/canvas-app-registry.js");
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(FOREIGN, "utf8").digest("hex");
    const store = {
        isSpace: async () => false,
        foreignBytes: async () => "bobs-app",
        matchBySha: async () => [],
    };
    const resolveViewer = async () => ({ principal: { provider: "dev", subject: "alice" }, resourceAdmin: false });
    const input = { callerSessionId: "alice-session", artifactSessionId: "bob-session", bytes: FOREIGN };
    // Off (no check given): the registry's rule.
    assert.match(String(await canvasBytesRefusal({ store, resolveViewer }, input)), /bobs-app/);
    // On, and the old catalog has these bytes now.
    let inSet = true;
    const asked = [];
    const isLegacySha256 = async (s) => { asked.push(s); return inSet; };
    assert.equal(await canvasBytesRefusal({ store, resolveViewer, isLegacySha256 }, input), null);
    assert.equal(await canvasBytesRefusal({ store, resolveViewer, isLegacySha256 }, { ...input, bytes: null, sha256: sha.toUpperCase() }), null, "metadata reads too");
    assert.deepEqual(asked, [sha, sha]);
    // The card changed since (or the catalog cannot be read): refused again.
    inSet = false;
    assert.match(String(await canvasBytesRefusal({ store, resolveViewer, isLegacySha256 }, input)), /bobs-app/);
    const failing = async () => { throw new Error("facts store down"); };
    assert.match(String(await canvasBytesRefusal({ store, resolveViewer, isLegacySha256: failing }, input)), /bobs-app/);
    // An app's own storage space is never an old app's page.
    const space = { ...store, isSpace: async () => true };
    assert.match(String(await canvasBytesRefusal({ store: space, resolveViewer, isLegacySha256: async () => true }, { ...input, artifactSessionId: "d8927a3e-1021-8000-8000-000000000000" })), /canvas app storage/);
});

test("a partial enumeration (read cap reached): the old card it read keeps its bytes readable; an unreached card's bytes are refused", async () => {
    const { canvasBytesRefusal } = await import("../../dist/canvas-app-registry.js");
    const { CanvasLegacyCatalog } = await import("../../dist/canvas-legacy.js");
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(FOREIGN, "utf8").digest("hex");
    const card = (key) => ({ key, shared: true, deletedAt: null, updatedAt: new Date("2026-09-18T12:00:00Z"),
        value: { name: key.slice(5), source: { sessionId: "s-old", filename: "app.html", sha256: sha } } });
    const capped = (rootCards) => ({
        reads: 0,
        async readFacts(query) {
            this.reads++;
            if (query.scopeKeys) return { count: 0, facts: [] };
            const prefix = query.keyPattern.slice(0, -1);
            const filler = Array.from({ length: 1000 }, (_, i) => ({ key: `${prefix}/x${i}`, shared: true, deletedAt: null, updatedAt: new Date(), value: {} }));
            const facts = prefix === "apps/" ? [...rootCards, ...filler].slice(0, 1000) : filler;
            return { count: facts.length, facts };
        },
    });
    const store = { isSpace: async () => false, foreignBytes: async () => "bobs-app", matchBySha: async () => [] };
    const resolveViewer = async () => ({ principal: { provider: "dev", subject: "alice" }, resourceAdmin: false });
    const input = { callerSessionId: "alice-session", artifactSessionId: "bob-session", bytes: FOREIGN };
    const installedAt = async () => new Date("2026-10-20T08:00:00Z");
    const facts = capped([card("apps/old-board")]);
    const reachable = new CanvasLegacyCatalog({ factStore: facts, installedAt });
    assert.equal(await canvasBytesRefusal({ store, resolveViewer, isLegacySha256: (s) => reachable.isExemptSha256(s) }, input), null);
    assert.equal(await reachable.isComplete(), false, "the walk reached its cap");
    assert.ok(facts.reads >= 200);
    const unreachedCatalog = new CanvasLegacyCatalog({ factStore: capped([]), installedAt });
    assert.match(String(await canvasBytesRefusal({ store, resolveViewer, isLegacySha256: (s) => unreachedCatalog.isExemptSha256(s) }, input)), /bobs-app/);
});
