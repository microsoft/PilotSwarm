// Real React/browser lifecycle checks without a server or a build on disk.
// In particular, never replace/restart a developer's running portal for these.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

let browser;
let script;
test.before(async () => {
    const built = await build({
        absWorkingDir: fileURLToPath(new URL("../../../../", import.meta.url)),
        stdin: {
            resolveDir: fileURLToPath(new URL("../../../../", import.meta.url)),
            contents: `
                import React from "react";
                import { createRoot } from "react-dom/client";
                import { WorkspacePane } from "./packages/app/ui/react/src/workspace-pane.js";
                const calls = window.calls = [];
                const changes = window.changes = [];
                window.addEventListener("pilotswarm:workspace-files-changed", event => changes.push(event.detail));
                const files = window.files = new Map();
                const transfers = new Map();
                let next = 0;
                let release;
                let releaseComplete;
                window.holdParts = false;
                window.releasePart = () => release?.();
                window.releaseComplete = () => releaseComplete?.();
                const state = { sessions: { byId: {} }, history: { bySessionId: new Map() } };
                const controller = {
                    getState: () => state, subscribe: () => () => {},
                    transport: {
                        listSessionWorkspaceFolders: async sid => ({
                            enabled: true, maxBytes: 20971520,
                            upload: { partBytes: 524288, legacyMaxBytes: 65536 },
                            folders: [
                                { id: "working", name: "app", role: "working", available: true, root: "root", folder: sid, uploads: true },
                                { id: "shared", name: "shared", role: "extra", available: true, root: "root", folder: "shared", uploads: true },
                            ]
                        }),
                        sessionWorkspaceFiles: async (sid, input) => {
                            calls.push(["files", sid, input]);
                            const key = sid + "/" + input.folder + "/" + input.path;
                            if (input.op === "list") return { entries: [{ name: "notes.txt", kind: "file", size: 9, mtimeMs: 1 }] };
                            if (input.op === "read") return { contentBase64: btoa("original\\n"), size: 9, etag: "old", mtimeMs: 1 };
                            if (input.op === "stat") return { kind: "file", size: 9, etag: "old", mtimeMs: 1 };
                            if (input.op === "write") {
                                files.set(key, atob(input.contentBase64));
                                return { etag: "new", size: atob(input.contentBase64).length, created: false };
                            }
                            throw new Error("Unexpected call " + input.op);
                        },
                        startSessionWorkspaceUpload: async (sid, input) => {
                            const id = "u" + (++next);
                            calls.push(["start", sid, input, id]);
                            transfers.set(id, { sid, input, parts: [] });
                            return { uploadId: id, partBytes: 524288, partCount: Math.ceil(input.size / 524288) };
                        },
                        putSessionWorkspaceUploadPart: async (sid, id, part, bytes, { signal }) => {
                            calls.push(["part", sid, id, part, bytes.length]);
                            if (window.holdParts) await new Promise((resolve, reject) => {
                                release = resolve;
                                signal.addEventListener("abort", () => reject(Object.assign(new Error("cancel"), { name: "AbortError" })), { once: true });
                            });
                            transfers.get(id).parts.push(bytes);
                            return { part, bytes: bytes.length };
                        },
                        completeSessionWorkspaceUpload: async (sid, id) => {
                            calls.push(["complete", sid, id]);
                            if (window.uncertain) throw Object.assign(new Error("no receipt"), { code: "WORKSPACE_FILES_UPLOAD_COMMIT_UNKNOWN" });
                            const upload = transfers.get(id);
                            if (window.existing && upload.input.path === "large.bin" && upload.input.ifMatch === null) {
                                throw Object.assign(new Error("already there"), { code: "WORKSPACE_FILES_EXISTS" });
                            }
                            if (window.holdComplete) await new Promise(resolve => { releaseComplete = resolve; });
                            const blob = new Blob(upload.parts);
                            files.set(sid + "/" + upload.input.folder + "/" + upload.input.path, await blob.text());
                            return { etag: "new", size: blob.size, created: true, ...window.receiptFlags };
                        },
                        abortSessionWorkspaceUpload: async (sid, id) => {
                            calls.push(["abort", sid, id]);
                            return { state: "aborted" };
                        },
                    }
                };
                const root = createRoot(document.getElementById("root"));
                window.renderPane = (sid = "s1", visible = true) => root.render(React.createElement(WorkspacePane, { controller, sessionId: sid, visible }));
                window.unmountPane = () => root.unmount();
                window.renderPane();
            `,
        },
        bundle: true, write: false, format: "iife", platform: "browser", minify: true,
        define: { "process.env.NODE_ENV": '"production"' },
    });
    script = built.outputFiles[0].text;
    browser = await chromium.launch({ headless: true });
});
test.after(async () => { await browser?.close(); });

async function setup(t) {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.setContent(`<style>
        .ps-ws-main { display: flex; }
        .ps-ws-viewer { width: 800px; }
        .ps-ws-editor { height: 400px; }
    </style><div id="root"></div>`);
    await page.addScriptTag({ content: script });
    await page.waitForSelector(".ps-ws-pane input[type=file]", { state: "attached" });
    return page;
}

async function startHeld(page) {
    await page.evaluate(() => { window.holdParts = true; });
    await page.locator("input[type=file]").setInputFiles({
        name: "large.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(524_289, 33),
    });
    await page.waitForFunction(() => window.calls.some(([kind]) => kind === "part"));
}

for (const navigation of ["session", "folder", "dashboard", "unmount"]) {
    test(`a ${navigation} switch aborts original staging without late state/notices`, async (t) => {
        const page = await setup(t);
        await startHeld(page);
        if (navigation === "folder") await page.getByRole("tab", { name: /^shared/ }).click();
        else await page.evaluate((kind) => {
            if (kind === "unmount") window.unmountPane();
            else window.renderPane(kind === "session" ? "s2" : "s1", kind !== "dashboard");
        }, navigation);
        await page.waitForFunction(() => window.calls.some(([kind]) => kind === "abort"));
        await page.evaluate(() => window.releasePart());
        const summary = await page.evaluate(() => ({
            calls: window.calls, changes: window.changes, files: [...window.files.keys()],
            notices: document.querySelectorAll(".ps-ws-notice").length,
            progress: document.querySelectorAll('[data-testid="workspace-upload-progress"]').length,
        }));
        assert.deepEqual(summary.calls.find(([kind]) => kind === "abort"), ["abort", "s1", "u1"]);
        assert.ok(!summary.calls.some(([kind]) => kind === "complete"));
        assert.ok(!summary.calls.some(([kind, , input]) => kind === "files" && input.op === "write"));
        assert.deepEqual(summary.files, []);
        assert.deepEqual(summary.changes, []);
        assert.equal(summary.notices, 0);
        assert.equal(summary.progress, 0);
    });
}

test("byte progress, cancel, and known commit announcements in a real browser", async (t) => {
    const page = await setup(t);
    await startHeld(page);
    const progress = page.getByRole("progressbar", { name: "Upload large.bin" });
    assert.equal(await progress.getAttribute("aria-valuemax"), "524289");
    await page.getByRole("button", { name: "Cancel upload", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".ps-ws-notice")?.textContent === "Upload cancelled.");
    assert.deepEqual(await page.evaluate(() => window.changes), []);
    await page.evaluate(() => { window.holdParts = false; });
    await page.locator("input[type=file]").setInputFiles({
        name: "large.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(524_289, 33),
    });
    await page.waitForFunction(() => window.changes.length === 1);
    const result = await page.evaluate(() => ({
        changes: window.changes, text: window.files.get("s1/working/large.bin"), calls: window.calls,
    }));
    assert.equal(result.text.length, 524_289);
    assert.deepEqual(result.changes, [{ sessionId: "s1", source: "pane" }]);
    assert.ok(!result.calls.some(([kind, , input]) => kind === "files" && input.op === "write"));
});

test("a large editor save uses a Blob upload and keeps its matching etag", async (t) => {
    const page = await setup(t);
    await page.evaluate(() => { window.receiptFlags = { receiptPersistenceFailed: true }; });
    await page.locator(".ps-ws-row-name", { hasText: "notes.txt" }).click();
    const editor = page.locator(".ps-ws-viewer .cm-content");
    await editor.waitFor();
    const text = `${`${"saved ".repeat(170)}\n`.repeat(70)}tail\n`;
    await editor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(text);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => window.files.has("s1/working/notes.txt"));
    const result = await page.evaluate(() => ({ calls: window.calls, changes: window.changes, text: window.files.get("s1/working/notes.txt") }));
    assert.equal(result.text, text);
    assert.equal(result.calls.find(([kind]) => kind === "start")[2].ifMatch, "old");
    assert.ok(!result.calls.some(([kind, , input]) => kind === "files" && input.op === "write"));
    assert.equal(result.changes.length, 1);
    await page.waitForFunction(() => document.querySelector(".ps-ws-notice[role=status]")?.textContent.includes("Saved notes.txt"));
    assert.match(await page.getByTestId("workspace-upload-warning").textContent(), /File saved, but receipt persistence failed.*committed/);
});

test("post-publication warnings survive upload completion status and clear on view change", async (t) => {
    const page = await setup(t);
    await page.evaluate(() => { window.receiptFlags = { notificationFailed: true, receiptPersistenceFailed: true }; });
    await page.locator("input[type=file]").setInputFiles({
        name: "warn.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(524_288, 33),
    });
    await page.waitForFunction(() => document.querySelector(".ps-ws-notice[role=status]")?.textContent.includes("Uploaded 1 file"));
    assert.match(await page.getByTestId("workspace-upload-warning").textContent(), /File uploaded, but notification and receipt persistence failed.*committed/);
    assert.equal(await page.evaluate(() => window.changes.length), 1);
    assert.equal(await page.evaluate(() => window.calls.filter(([kind]) => kind === "complete").length), 1);
    assert.equal(await page.evaluate(() => window.calls.filter(([kind]) => kind === "abort").length), 0);
    await page.evaluate(() => window.renderPane("s2"));
    await page.waitForFunction(() => window.calls.some(([kind, sid, input]) => kind === "files" && sid === "s2" && input.op === "list"));
    assert.equal(await page.getByTestId("workspace-upload-warning").count(), 0);
});

for (const choice of ["Replace", "Keep both"]) {
    test(`${choice} after a chunked name clash uses a new immutable upload`, async (t) => {
        const page = await setup(t);
        await page.evaluate(() => { window.existing = true; });
        await page.locator("input[type=file]").setInputFiles({
            name: "large.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(524_289, 33),
        });
        const dialog = page.getByRole("dialog", { name: "File exists" });
        await dialog.waitFor();
        await dialog.getByRole("button", { name: choice, exact: true }).click();
        await page.waitForFunction(() => window.changes.length === 1);
        const result = await page.evaluate(() => ({ calls: window.calls, files: [...window.files.keys()], changes: window.changes }));
        const starts = result.calls.filter(([kind]) => kind === "start");
        assert.equal(starts.length, 2);
        assert.deepEqual(starts.map((entry) => [entry[2].path, entry[2].ifMatch]),
            choice === "Replace" ? [["large.bin", null], ["large.bin", "old"]] : [["large.bin", null], ["large (1).bin", null]]);
        assert.deepEqual(result.calls.find(([kind]) => kind === "abort"), ["abort", "s1", "u1"]);
        assert.deepEqual(result.files, [`s1/working/${choice === "Replace" ? "large.bin" : "large (1).bin"}`]);
        assert.equal(result.changes.length, 1);
    });
}

test("a late known completion stays in its original session without new-view notices", async (t) => {
    const page = await setup(t);
    await page.evaluate(() => { window.holdComplete = true; window.receiptFlags = { notificationFailed: true }; });
    await page.locator("input[type=file]").setInputFiles({
        name: "late.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(524_288, 33),
    });
    await page.waitForFunction(() => window.calls.some(([kind]) => kind === "complete"));
    assert.equal(await page.getByRole("button", { name: "Cancel upload", exact: true }).isDisabled(), true);
    await page.evaluate(() => window.renderPane("s2"));
    await page.waitForFunction(() => window.calls.some(([kind, sid, input]) => kind === "files" && sid === "s2" && input.op === "list"));
    await page.evaluate(() => window.releaseComplete());
    await page.waitForFunction(() => window.changes.length === 1);
    const result = await page.evaluate(() => ({
        files: [...window.files.keys()], changes: window.changes, notices: document.querySelectorAll(".ps-ws-notice").length,
    }));
    assert.deepEqual(result.files, ["s1/working/late.bin"]);
    assert.deepEqual(result.changes, [{ sessionId: "s1", source: "pane" }]);
    assert.equal(result.notices, 0);
});

test("uncertain completion refreshes the captured target, not a success notice", async (t) => {
    const page = await setup(t);
    await page.evaluate(() => { window.uncertain = true; });
    await page.locator("input[type=file]").setInputFiles({
        name: "uncertain.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(524_288),
    });
    await page.waitForFunction(() => document.querySelector(".ps-ws-notice")?.textContent.includes("completion is uncertain"));
    const result = await page.evaluate(() => ({ calls: window.calls, changes: window.changes }));
    assert.deepEqual(result.calls.find(([kind, , input]) => kind === "files" && input.op === "stat"),
        ["files", "s1", { op: "stat", folder: "working", path: "uncertain.bin" }]);
    assert.equal(result.calls.filter(([kind]) => kind === "complete").length, 1);
    assert.equal(result.calls.filter(([kind]) => kind === "abort").length, 0);
    assert.deepEqual(result.changes, []);
});
