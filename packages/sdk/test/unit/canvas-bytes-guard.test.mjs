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
