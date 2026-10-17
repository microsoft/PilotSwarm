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
