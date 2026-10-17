/**
 * Canvas documents (issue 181) are written only by a draw. The Node SDK
 * transport — under the portal runtime and the TUI alike — refuses uploads,
 * local-file uploads and copies that target canvas.html … canvas5.html, and
 * passes everything else to the store unchanged.
 *
 * Run: node --test tui/test/canvas-document-reservation.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeSdkTransport } from "../src/node-sdk-transport.js";

function transportWithStore() {
    const writes = [];
    const transport = Object.create(NodeSdkTransport.prototype);
    transport.artifactStore = {
        uploadArtifact: async (sessionId, filename) => { writes.push(["upload", sessionId, filename]); return { filename }; },
        uploadArtifactFromFile: async (sessionId, filename) => { writes.push(["file", sessionId, filename]); return { filename }; },
        copyArtifact: async (from, fromName, to, toName) => { writes.push(["copy", to, toName]); return { filename: toName }; },
    };
    return { transport, writes };
}

test("uploads and copies never target a canvas document", async () => {
    const { transport, writes } = transportWithStore();
    for (const filename of ["canvas.html", "canvas2.html", "CANVAS5.html", "dir/canvas3.html"]) {
        await assert.rejects(transport.uploadArtifactContent("s1", filename, "<p>x</p>", "text/html"), (error) => error.code === "CANVAS_FILE_RESERVED", filename);
    }
    await assert.rejects(transport.copyArtifact("s1", "page.html", "s1", "canvas.html"), (error) => error.code === "CANVAS_FILE_RESERVED");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-reserve-"));
    try {
        const local = path.join(dir, "canvas.html");
        fs.writeFileSync(local, "<p>x</p>");
        await assert.rejects(transport.uploadArtifactFromPath("s1", local), (error) => error.code === "CANVAS_FILE_RESERVED");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(writes, [], "nothing reached the store");
    await transport.uploadArtifactContent("s1", "canvas6.html", "<p>x</p>", "text/html");
    await transport.copyArtifact("s1", "canvas.html", "s1", "app-board.html");
    assert.deepEqual(writes.map((w) => w[0]), ["upload", "copy"], "other names, and canvas.html as a SOURCE, are unchanged");
});

test("canvas app byte spaces are absent on every generic artifact route", async () => {
    const SPACE = "app-space-id";
    const { transport, writes } = transportWithStore();
    Object.assign(transport.artifactStore, {
        listArtifacts: async () => { writes.push(["list"]); return []; },
        statArtifact: async () => { writes.push(["stat"]); return null; },
        setArtifactPinned: async () => { writes.push(["pin"]); return {}; },
        deleteArtifact: async () => { writes.push(["delete"]); return true; },
        downloadArtifactText: async () => { writes.push(["text"]); return ""; },
        downloadArtifact: async () => { writes.push(["binary"]); return { body: Buffer.from("") }; },
    });
    transport.mgmt = { isCanvasAppStorage: async (id) => id === SPACE };
    const refused = (error) => error.code === "NOT_FOUND";
    await assert.rejects(transport.listArtifacts(SPACE), refused);
    await assert.rejects(transport.getArtifactMetadata(SPACE, "x.html"), refused);
    await assert.rejects(transport.readArtifactBase64(SPACE, "x.html", 10), refused);
    await assert.rejects(transport.downloadArtifact(SPACE, "x.html"), refused);
    await assert.rejects(transport.downloadArtifactBinary(SPACE, "x.html"), refused);
    await assert.rejects(transport.deleteArtifact(SPACE, "x.html"), refused);
    await assert.rejects(transport.setArtifactPinned(SPACE, "x.html", true), refused);
    await assert.rejects(transport.uploadArtifactContent(SPACE, "x.html", "x"), refused);
    await assert.rejects(transport.copyArtifact(SPACE, "x.html", "s1", "y.html"), refused, "copy out");
    await assert.rejects(transport.copyArtifact("s1", "y.html", SPACE, "x.html"), refused, "copy in");
    assert.deepEqual(writes, [], "the store was never asked");
    await transport.listArtifacts("s1");
    assert.deepEqual(writes, [["list"]], "an ordinary session is unaffected");
});

test("a copy with an omitted or empty destination name is the source name, and is refused for a canvas document", async () => {
    const { transport, writes } = transportWithStore();
    for (const [source, dest] of [["canvas.html", undefined], ["canvas.html", ""], ["Canvas2.HTML", null], ["dir/canvas5.html", undefined]]) {
        await assert.rejects(transport.copyArtifact("s1", source, "s2", dest), (error) => error.code === "CANVAS_FILE_RESERVED", `${source} -> ${dest}`);
    }
    assert.deepEqual(writes, [], "nothing reached the store");
    await transport.copyArtifact("s1", "app-board.html", "s2", undefined);
    await transport.copyArtifact("s1", "canvas.html", "s2", "app-board.html");
    assert.deepEqual(writes.map((w) => w[0]), ["copy", "copy"], "an ordinary source, and save-as under another name, still copy");
});
