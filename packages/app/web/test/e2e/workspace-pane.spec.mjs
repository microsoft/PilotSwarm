// The side pane's Workspace tab, against an in-memory folder behind the two
// Web API calls it makes (listSessionWorkspaceFolders, sessionWorkspaceFiles).
// No server-side files, no worker, no model: the pane's own behavior.
//
//   the tab, the tree, open, edit and save
//   a save after someone else's change: the dialog, Keep mine, Keep both
//   markdown preview: images blocked until the person asks
//   upload (button and drop), name clashes, download (a file and a .zip)
//   move by dragging, rename, delete, new file, new folder
//   the divider: drag, keys, reset, kept across a reload; stacked on a phone
//   no Workspace tab when the portal serves no folders; the empty states
//   Win95: a raised window with a title bar and white wells; other themes unchanged
import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { listThemes } from "../../../ui/core/src/themes/index.js";

const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const etagOf = (bytes) => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const DOT_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** One folder in memory: path -> { kind: "dir" } or { kind: "file", bytes }. */
class Folder {
    constructor(files) {
        this.nodes = new Map([["", { kind: "dir" }]]);
        for (const [path, content] of Object.entries(files)) {
            const parts = path.split("/");
            for (let i = 1; i < parts.length; i++) this.nodes.set(parts.slice(0, i).join("/"), { kind: "dir" });
            this.nodes.set(path, content === null ? { kind: "dir" } : { kind: "file", bytes: Buffer.from(content) });
        }
        this.calls = [];
        this.maxBytes = Infinity;
    }
    text(path) { return this.nodes.get(path)?.bytes?.toString("utf8"); }
    set(path, text) { this.nodes.set(path, { kind: "file", bytes: Buffer.from(text) }); }
    children(dir) {
        const prefix = dir ? `${dir}/` : "";
        return [...this.nodes.keys()].filter((p) => p && p.startsWith(prefix) && !p.slice(prefix.length).includes("/"));
    }
    handle(call) {
        this.calls.push(call);
        const path = call.path ?? "";
        const node = this.nodes.get(path);
        const locked = (p) => p.split("/").includes(".git");
        const fail = (status, code, message, extra = {}) => ({ status, body: { ok: false, error: { code, message, ...extra } } });
        const ok = (result) => ({ status: 200, body: { ok: true, result } });
        switch (call.op) {
            case "list":
                if (node?.kind !== "dir") return fail(404, "WORKSPACE_FILES_NOT_FOUND", "no such folder");
                return ok({
                    entries: this.children(path).map((p) => {
                        const n = this.nodes.get(p);
                        return { name: p.split("/").pop(), kind: n.kind, size: n.bytes?.length ?? 0, mtimeMs: 1, ...(locked(p) ? { readOnly: true } : {}) };
                    }).sort((a, b) => (a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1) || a.name.localeCompare(b.name)),
                    truncated: false,
                    readOnly: false,
                });
            case "stat":
                if (!node) return fail(404, "WORKSPACE_FILES_NOT_FOUND", "no such file or folder");
                return ok({ kind: node.kind, size: node.bytes?.length ?? 0, mtimeMs: 1, ...(node.bytes ? { etag: etagOf(node.bytes) } : {}) });
            case "read":
                if (!node) return fail(404, "WORKSPACE_FILES_NOT_FOUND", "no such file or folder");
                if (node.kind !== "file") return fail(400, "WORKSPACE_FILES_NOT_A_FILE", "not a file");
                if (node.bytes.length > this.maxBytes) return fail(413, "WORKSPACE_FILES_TOO_LARGE", "larger than the limit", { size: node.bytes.length });
                return ok({ contentBase64: node.bytes.toString("base64"), size: node.bytes.length, mtimeMs: 1, etag: etagOf(node.bytes), readOnly: locked(path) });
            case "write": {
                if (locked(path)) return fail(403, "WORKSPACE_FILES_READ_ONLY", "files inside .git are read-only here");
                if (node && call.ifMatch === null) return fail(409, "WORKSPACE_FILES_EXISTS", "already there");
                if (node && typeof call.ifMatch === "string" && call.ifMatch !== etagOf(node.bytes)) return fail(409, "WORKSPACE_FILES_CONFLICT", "changed", { etag: etagOf(node.bytes) });
                if (!node && typeof call.ifMatch === "string") return fail(409, "WORKSPACE_FILES_CONFLICT", "the file was deleted since it was read", { etag: null });
                const bytes = Buffer.from(call.contentBase64, "base64");
                this.nodes.set(path, { kind: "file", bytes });
                return ok({ etag: etagOf(bytes), size: bytes.length, created: !node });
            }
            case "mkdir":
                if (node) return fail(409, "WORKSPACE_FILES_EXISTS", "already there");
                this.nodes.set(path, { kind: "dir" });
                return ok({});
            case "move": {
                if (!node) return fail(404, "WORKSPACE_FILES_NOT_FOUND", "no such file or folder");
                if (this.nodes.has(call.toPath)) return fail(409, "WORKSPACE_FILES_EXISTS", "already there");
                for (const p of [...this.nodes.keys()]) {
                    if (p === path || p.startsWith(`${path}/`)) {
                        this.nodes.set(call.toPath + p.slice(path.length), this.nodes.get(p));
                        this.nodes.delete(p);
                    }
                }
                return ok({});
            }
            case "delete":
                if (!node) return fail(404, "WORKSPACE_FILES_NOT_FOUND", "no such file or folder");
                if (node.kind === "dir" && this.children(path).length && !call.recursive) return fail(409, "WORKSPACE_FILES_NOT_EMPTY", "not empty");
                for (const p of [...this.nodes.keys()]) if (p === path || p.startsWith(`${path}/`)) this.nodes.delete(p);
                return ok({});
            case "zip": {
                // Like the server: files only, .git left out and said so.
                const inGit = (p) => p.split("/").includes(".git");
                const under = (p) => p && (!path || p === path || p.startsWith(`${path}/`));
                const all = [...this.nodes.keys()].filter((p) => (call.paths ? call.paths.some((q) => p === q || p.startsWith(`${q}/`)) : under(p)));
                const files = all.filter((p) => this.nodes.get(p).kind === "file" && !inGit(p)).length;
                return ok({ contentBase64: Buffer.from(`PK-fake-zip:${(call.paths || [path]).join(",")}`).toString("base64"), size: 11, files, ...(all.some(inGit) ? { skipped: [".git"] } : {}) });
            }
            case "find": {
                const words = String(call.query || "").toLowerCase().split(/\s+/).filter(Boolean);
                const matches = [...this.nodes.keys()]
                    .filter((p) => p && !p.split("/").includes(".git"))
                    .filter((p) => words.length && words.every((w) => (w.includes("/") ? p.toLowerCase() : p.split("/").pop().toLowerCase()).includes(w)))
                    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
                    .map((p) => ({ path: p, kind: this.nodes.get(p).kind }));
                return ok({ matches, truncated: false });
            }
            default:
                return fail(400, "WORKSPACE_FILES_PATH_INVALID", "unknown");
        }
    }
}

const FOLDERS = [
    { id: "working", name: "app", role: "working", home: false, root: "a", folder: "sessions/s1/app", available: true, base: "/ws/a/sessions/s1/app" },
    { id: "extra:shared", name: "shared", role: "extra", home: false, root: "shared", folder: "", available: false },
];

async function routeWorkspace(page, folder, { enabled = true, folders = FOLDERS, workspaceTab = true, others = {}, writeDelayMs = 0 } = {}) {
    await page.route("**/api/portal-config", (route) => route.fulfill({ json: { ok: true, portal: { branding: { title: "PilotSwarm", pageTitle: "PilotSwarm" }, workspaceFiles: workspaceTab } } }));
    await page.route(`**/management/sessions/${sessionId}/workspace/folders`, (route) => route.fulfill({ json: { ok: true, result: { enabled, maxBytes: 20 * 1024 * 1024, folders } } }));
    await page.route(`**/management/sessions/${sessionId}/workspace/files`, async (route) => {
        const call = route.request().postDataJSON().call;
        const target = others[call.folder] ?? folder;
        if (call.op === "write" && writeDelayMs) await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
        const { status, body } = target.handle(call);
        return route.fulfill({ status, json: body });
    });
}
const TWO_FOLDERS = [
    FOLDERS[0],
    { id: "extra:shared", name: "shared", role: "extra", home: false, root: "shared", folder: "", opened: true, available: true, base: "/ws/shared" },
];

async function openWorkspace(page) {
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await showWorkspaceTab(page);
}

// The side pane closes on a reload (the stub keeps no settings); the tab choice is kept.
async function showWorkspaceTab(page) {
    await page.getByRole("button", { name: "Show canvas" }).click();
    await page.getByRole("tab", { name: "Workspace" }).click();
}

const tree = (page) => page.getByRole("tree", { name: "Files in app" });
const row = (page, name) => tree(page).getByRole("treeitem").filter({ has: page.locator(".ps-ws-row-name", { hasText: new RegExp(`^${name.replace(/[.()]/g, "\\$&")}$`) }) });
const editor = (page) => page.locator(".ps-ws-viewer .cm-content");

test("a running turn's folders show up within seconds, not at the next 10 s check", async ({ page }) => {
    // The session runs its first turn. Its folder is listed but not open, and
    // the server refuses its files, until the turn opens it.
    await routeWorkspace(page, new Folder({ "README.md": "# App\n" }));
    let reads = 0;
    let open = false;
    await page.route(`**/management/sessions/${sessionId}/workspace/folders`, (route) => {
        reads += 1;
        if (reads >= 2) open = true;
        const folders = open ? FOLDERS : [{ ...FOLDERS[0], opened: false, available: false }];
        return route.fulfill({ json: { ok: true, result: { enabled: true, maxBytes: 20 * 1024 * 1024, folders } } });
    });
    await page.route(`**/management/sessions/${sessionId}/workspace/files`, (route) => (open
        ? route.fallback()
        : route.fulfill({ status: 409, json: { ok: false, error: { code: "WORKSPACE_FILES_NOT_OPENED", message: "the session's worker has not opened \"app\" yet" } } })));
    await openWorkspace(page);
    await expect(page.getByRole("tab", { name: /^app/ })).toBeDisabled();
    await expect(row(page, "README.md")).toBeVisible({ timeout: 5_000 });
    // Once a folder is open, the list goes back to the regular check.
    const after = reads;
    await page.waitForTimeout(4_500);
    expect(reads - after).toBeLessThanOrEqual(1);
});

test("the tab, the tree, open, edit and save", async ({ page }) => {
    const folder = new Folder({ ".git/HEAD": "ref: refs/heads/main\n", "src/a.ts": "export const a = 1;\n", "README.md": "# App\n" });
    await routeWorkspace(page, folder);
    await openWorkspace(page);

    await expect(page.getByRole("tab", { name: /^app/ })).toHaveAttribute("aria-selected", "true");
    const shared = page.getByRole("tab", { name: /^shared/ });
    await expect(shared).toBeDisabled();
    await expect(shared).toHaveAttribute("title", /does not serve the "shared" root/);

    // Folders first, dotfiles shown, .git locked.
    await expect(tree(page).locator(":scope > .ps-ws-row .ps-ws-row-name")).toHaveText([".git", "src", "README.md"]);
    await expect(row(page, ".git").locator(".ps-ws-row-lock")).toHaveCount(1);

    await row(page, "src").dblclick();
    await row(page, "a.ts").click();
    await expect(editor(page)).toHaveText("export const a = 1;");
    const opened = etagOf(Buffer.from("export const a = 1;\n"));
    await editor(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("// saved\n");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => folder.text("src/a.ts")).toBe("export const a = 1;\n// saved\n");
    expect(folder.calls.find((c) => c.op === "write")).toMatchObject({ folder: "working", path: "src/a.ts", ifMatch: opened });
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("a save after someone else's change asks; Keep mine and Keep both", async ({ page }) => {
    const folder = new Folder({ "notes.txt": "one\ntwo\nthree\n" });
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    await row(page, "notes.txt").click();
    await expect(editor(page)).toContainText("three");

    // Theirs changes line 1; mine changes line 3.
    folder.set("notes.txt", "ONE\ntwo\nthree\n");
    await page.locator(".ps-ws-viewer .cm-line", { hasText: "three" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+Home");
    await page.keyboard.type("THREE");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "The file changed" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Keep both" }).click();
    await expect.poll(() => folder.text("notes.txt")).toBe("ONE\ntwo\nTHREE\n");

    // Again, and this time mine wins whole.
    folder.set("notes.txt", "theirs\n");
    await page.locator(".ps-ws-viewer .cm-line", { hasText: "two" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("dialog", { name: "The file changed" }).getByRole("button", { name: "Keep mine" }).click();
    await expect.poll(() => folder.text("notes.txt")).toBe("ONE\ntwo!\nTHREE\n");
});

test("a save conflict: Compare shows both with the file name in view, then Save mine; Take theirs", async ({ page }) => {
    // The width the bug was seen at: the side pane at its default size.
    await page.setViewportSize({ width: 1500, height: 900 });
    const name = "docs/guides/a-long-file-name-for-compare.txt";
    const folder = new Folder({ [name]: "one\ntwo\n" });
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    await row(page, "docs").dblclick();
    await row(page, "guides").dblclick();
    await row(page, "a-long-file-name-for-compare.txt").click();
    await expect(editor(page)).toContainText("two");
    folder.set(name, "ONE\ntwo\n");
    await page.locator(".ps-ws-viewer .cm-line", { hasText: "two" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const changed = page.getByRole("dialog", { name: "The file changed" });
    await expect(changed.getByRole("button", { name: "Keep both" }), "the safe choice has focus").toBeFocused();
    await expect(changed).toHaveAttribute("aria-modal", "true");
    await changed.getByRole("button", { name: "Compare" }).click();
    await expect(page.getByRole("note")).toHaveText("Left: on disk now. Right: yours. The arrows copy a change into yours.");
    const shown = await page.locator(".ps-ws-crumbs").evaluate((crumbs) => {
        const leaf = crumbs.querySelector(".ps-ws-crumb-leaf");
        const cut = leaf.getBoundingClientRect().right > crumbs.getBoundingClientRect().right + 1 || leaf.scrollWidth > leaf.clientWidth + 1;
        return { cut, bar: crumbs.parentElement.clientWidth, crumbs: crumbs.clientWidth, leaf: leaf.clientWidth, name: leaf.scrollWidth };
    });
    expect(shown.cut, `the file name is not cut: ${JSON.stringify(shown)}`).toBe(false);
    await page.getByRole("button", { name: "Save mine" }).click();
    await expect.poll(() => folder.text(name)).toBe("one\ntwo!\n");

    // Again, and this time theirs wins: the editor shows what is on disk.
    folder.set(name, "theirs only\n");
    await page.locator(".ps-ws-viewer .cm-line", { hasText: "two!" }).click();
    await page.keyboard.type("?");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("dialog", { name: "The file changed" }).getByRole("button", { name: "Take theirs" }).click();
    await expect(editor(page)).toHaveText("theirs only");
    expect(folder.text(name)).toBe("theirs only\n");
});

test("markdown preview shows no image until the person asks", async ({ page }) => {
    const folder = new Folder({ "README.md": "# Title\n\n![logo](https://images.example.test/logo.png)\n\n![dot](img/dot.png)\n", "img/dot.png": DOT_PNG });
    const remote = [];
    await page.route("https://images.example.test/**", (route) => { remote.push(route.request().url()); return route.fulfill({ body: DOT_PNG, contentType: "image/png" }); });
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    await row(page, "README.md").click();
    await expect(page.getByRole("group", { name: "Markdown view" }).getByRole("button", { name: "Edit" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Preview" }).click();

    const preview = page.locator(".ps-ws-md-preview");
    await expect(preview.getByRole("heading", { name: "Title" })).toBeVisible();
    await expect(preview.locator(".ps-ws-img-blocked")).toHaveCount(2);
    await expect(preview.locator("img")).toHaveCount(0);
    await expect(preview.getByRole("status")).toContainText("2 images are not shown");
    expect(remote).toEqual([]);

    await preview.getByRole("button", { name: "Show images" }).click();
    await expect(preview.locator("img")).toHaveCount(2);
    await expect(preview.locator('img[src^="https://images.example.test/"]')).toHaveCount(1);
    await expect(preview.locator('img[src^="blob:"]')).toHaveCount(1);
    await expect.poll(() => remote.length).toBeGreaterThan(0);
    await preview.getByRole("button", { name: "Hide images" }).click();
    await expect(preview.locator("img")).toHaveCount(0);
});

test("upload by button and by drop, a name clash, and downloads", async ({ page }) => {
    const folder = new Folder({ "notes.md": "notes\n", "docs/guide.md": "guide\n" });
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    await expect(row(page, "notes.md")).toBeVisible();

    await page.locator(".ps-ws-pane input[type=file]").setInputFiles({ name: "up.txt", mimeType: "text/plain", buffer: Buffer.from("uploaded\n") });
    await expect.poll(() => folder.text("up.txt")).toBe("uploaded\n");
    await expect(row(page, "up.txt")).toBeVisible();

    const drop = (name, text) => tree(page).evaluate((node, [fileName, body]) => {
        const data = new DataTransfer();
        data.items.add(new File([body], fileName, { type: "text/plain" }));
        for (const type of ["dragenter", "dragover", "drop"]) node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    }, [name, text]);
    await drop("dropped.txt", "dropped\n");
    await expect.poll(() => folder.text("dropped.txt")).toBe("dropped\n");

    await drop("up.txt", "second\n");
    const clash = page.getByRole("dialog", { name: "File exists" });
    await expect(clash).toBeVisible();
    await expect(clash.getByRole("button", { name: "Keep both" }), "keeping both is the default, not replacing").toBeFocused();
    await clash.getByRole("button", { name: "Keep both" }).click();
    await expect.poll(() => folder.text("up (1).txt")).toBe("second\n");
    expect(folder.text("up.txt")).toBe("uploaded\n");

    await row(page, "notes.md").hover();
    const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download notes.md" }).click()]);
    expect(file.suggestedFilename()).toBe("notes.md");
    expect((await streamText(await file.createReadStream()))).toBe("notes\n");
    const [zip] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download the folder as .zip" }).click()]);
    expect(zip.suggestedFilename()).toBe("app.zip");
});

test("a folder zip's toast counts its files and says .git was left out", async ({ page }) => {
    await routeWorkspace(page, new Folder({ ".git/HEAD": "ref: refs/heads/main\n", "one.txt": "1\n" }));
    await openWorkspace(page);
    await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download the folder as .zip" }).click()]);
    await expect(page.getByText("Downloaded app.zip (1 file; .git left out)")).toBeVisible();
});

async function streamText(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

test("move by dragging, rename, delete, new file and new folder", async ({ page }) => {
    const folder = new Folder({ "notes.md": "notes\n", "docs/guide.md": "guide\n" });
    await routeWorkspace(page, folder);
    await openWorkspace(page);

    await row(page, "notes.md").dragTo(row(page, "docs"));
    await expect.poll(() => folder.text("docs/notes.md")).toBe("notes\n");
    expect(folder.nodes.has("notes.md")).toBe(false);

    await row(page, "docs").dblclick();
    await row(page, "guide.md").hover();
    await page.getByRole("button", { name: "Rename guide.md" }).click();
    const newName = page.getByRole("textbox", { name: "New name" });
    await expect(newName).toBeFocused();
    expect(await newName.evaluate((input) => input.value.slice(input.selectionStart, input.selectionEnd)), "the name is selected, not the extension").toBe("guide");
    await newName.fill("manual.md");
    await page.keyboard.press("Enter");
    await expect.poll(() => folder.text("docs/manual.md")).toBe("guide\n");

    await row(page, "manual.md").hover();
    await page.getByRole("button", { name: "Delete manual.md" }).click();
    await page.getByRole("dialog", { name: "Delete" }).getByRole("button", { name: "Delete" }).click();
    await expect.poll(() => folder.nodes.has("docs/manual.md")).toBe(false);

    await page.getByRole("button", { name: "New folder" }).click();
    await page.getByRole("textbox", { name: "New folder name" }).fill("drafts");
    await page.keyboard.press("Enter");
    await expect.poll(() => folder.nodes.get("drafts")?.kind).toBe("dir");

    await page.getByRole("button", { name: "New file", exact: true }).click();
    await page.getByRole("textbox", { name: "New file name" }).fill("todo.md");
    await page.keyboard.press("Enter");
    await expect.poll(() => folder.text("todo.md")).toBe("");
});

test("the divider: drag, keys, double-click, and kept across a reload", async ({ page }) => {
    const folder = new Folder({ "README.md": "# App\n" });
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    const separator = page.getByRole("separator", { name: "Resize the file list" });
    await expect(separator).toHaveAttribute("aria-orientation", "vertical");
    const width = () => tree(page).evaluate((node) => Math.round(node.getBoundingClientRect().width));
    const start = await width();

    const box = await separator.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(width).toBe(start + 100);

    await separator.focus();
    // A focusable separator says its size, and its range.
    const valueNow = async () => Number(await separator.getAttribute("aria-valuenow"));
    await expect.poll(valueNow).toBeGreaterThan(0);
    expect(Number(await separator.getAttribute("aria-valuemax"))).toBeGreaterThan(Number(await separator.getAttribute("aria-valuemin")));
    const before = await valueNow();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(width).toBe(start + 76);
    await expect.poll(valueNow).toBe(before - 24);

    await page.reload();
    await showWorkspaceTab(page);
    await expect.poll(width).toBe(start + 76);

    await page.getByRole("separator", { name: "Resize the file list" }).dblclick();
    await expect.poll(width).toBe(start);
});

test("on a phone a long file scrolls in its own space, and a button opens Find in file", async ({ browser }) => {
    // A narrow window, as the phone pass measured it (no touch emulation).
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
        const long = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
        await routeWorkspace(page, new Folder({ "long.txt": long }));
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
        await page.getByRole("button", { name: "Show canvas" }).click();
        await page.getByRole("tab", { name: "The session's folders and files" }).click();
        await row(page, "long.txt").click();
        await expect(page.locator(".ps-ws-viewer .cm-content")).toContainText("line 1");
        const sizes = await page.evaluate(() => {
            const viewer = document.querySelector(".ps-ws-viewer").getBoundingClientRect();
            const main = document.querySelector(".ps-ws-main").getBoundingClientRect();
            const scroller = document.querySelector(".ps-ws-viewer .cm-scroller");
            return { viewerBottom: viewer.bottom, mainBottom: main.bottom, viewerHeight: Math.round(viewer.height), mainHeight: Math.round(main.height), scrolls: scroller.scrollHeight > scroller.clientHeight + 10 };
        });
        expect(sizes.viewerBottom, `the viewer stays in its space: ${JSON.stringify(sizes)}`).toBeLessThanOrEqual(sizes.mainBottom + 1);
        expect(sizes.scrolls, "the editor scrolls the file").toBe(true);
        await page.getByRole("button", { name: "Find in file" }).click();
        const find = page.getByRole("textbox", { name: "Find in file" });
        await expect(find).toBeFocused();
        await expect(find).toBeInViewport();
        // Going to a match far down scrolls the file, not the whole pane.
        await find.fill("line 190");
        await page.keyboard.press("Enter");
        await expect(page.locator(".ps-ws-viewer .cm-line", { hasText: /^line 190$/ })).toBeInViewport();
        await expect(page.getByRole("tablist", { name: "The session's folders" })).toBeInViewport();
        await expect(find).toBeInViewport();
    } finally {
        await context.close();
    }
});

test("on a phone the viewer bar keeps its buttons whole; the path gives way", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await context.newPage();
    try {
        await routeWorkspace(page, new Folder({ "notes/long-phone-name.md": "# N\n" }));
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
        await page.getByRole("button", { name: "Show canvas" }).click();
        await page.getByRole("tab", { name: "The session's folders and files" }).click();
        await row(page, "notes").dblclick();
        await row(page, "long-phone-name.md").click();
        await expect(page.locator(".ps-ws-viewer .cm-content")).toContainText("# N");
        const layout = await page.locator(".ps-ws-viewer-bar").evaluate((bar) => {
            const box = (el) => el.getBoundingClientRect();
            const buttons = [...bar.querySelectorAll(":scope > button, .ps-ws-seg button")].map((b) => ({ name: b.textContent || b.getAttribute("aria-label"), left: box(b).left, right: box(b).right, whole: b.scrollWidth <= b.clientWidth + 1 }));
            const seg = bar.querySelector(".ps-ws-seg");
            const clipped = seg ? box(seg).right < Math.max(...[...seg.querySelectorAll("button")].map((b) => box(b).right)) - 1 : false;
            const barRight = box(bar).right;
            return { buttons, clipped, outside: buttons.filter((b) => b.right > barRight + 1).map((b) => b.name) };
        });
        expect(layout.clipped, `Edit and Preview whole: ${JSON.stringify(layout)}`).toBe(false);
        expect(layout.outside, "every button inside the bar").toEqual([]);
        const sorted = [...layout.buttons].sort((a, b) => a.left - b.left);
        for (let i = 1; i < sorted.length; i++) expect(sorted[i].left, `${sorted[i].name} does not overlap ${sorted[i - 1].name}`).toBeGreaterThanOrEqual(sorted[i - 1].right - 1);
    } finally {
        await context.close();
    }
});

test("on a phone the list sits above the file, and the divider moves up and down", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
        const folder = new Folder({ "README.md": "# App\n", "src/a.ts": "export const a = 1;\n" });
        await routeWorkspace(page, folder);
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
        await page.getByRole("button", { name: "Show canvas" }).click();
        await page.getByRole("tab", { name: "The session's folders and files" }).click();
        await row(page, "README.md").click();
        await expect(page.locator(".ps-ws-viewer .cm-content")).toHaveText("# App");

        const treeBox = await tree(page).boundingBox();
        const viewerBox = await page.locator(".ps-ws-viewer").boundingBox();
        expect(treeBox.y + treeBox.height).toBeLessThanOrEqual(viewerBox.y + 1);
        expect(Math.abs(treeBox.width - viewerBox.width)).toBeLessThanOrEqual(1);
        // Nothing runs off the side of the screen.
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
        for (const selector of [".ps-ws-pane", ".ps-ws-toolbar", ".ps-ws-viewer-bar"]) {
            const b = await page.locator(selector).boundingBox();
            expect(b.x + b.width, selector).toBeLessThanOrEqual(391);
        }

        const separator = page.getByRole("separator", { name: "Resize the file list" });
        await expect(separator).toHaveAttribute("aria-orientation", "horizontal");
        const height = () => tree(page).evaluate((node) => Math.round(node.getBoundingClientRect().height));
        const start = await height();
        const box = await separator.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 4 });
        await page.mouse.up();
        await expect.poll(height).toBe(start + 60);
    } finally {
        await context.close();
    }
});

test("no Workspace tab when the portal serves no folders", async ({ page }) => {
    await routeWorkspace(page, new Folder({}), { workspaceTab: false });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await page.getByRole("button", { name: "Show canvas" }).click();
    await expect(page.getByText("Nothing on the canvas yet.")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Workspace" })).toHaveCount(0);
    await expect(page.locator(".ps-ws-pane")).toHaveCount(0);
});

test("the empty states: no folders, and a portal that serves none", async ({ page }) => {
    await routeWorkspace(page, new Folder({}), { folders: [] });
    await openWorkspace(page);
    await expect(page.locator(".ps-ws-message")).toHaveText(/^This session has no folders\./);

    await page.unroute(`**/management/sessions/${sessionId}/workspace/folders`);
    await page.route(`**/management/sessions/${sessionId}/workspace/folders`, (route) => route.fulfill({ json: { ok: true, result: { enabled: false, maxBytes: 0, folders: [] } } }));
    await page.reload();
    await showWorkspaceTab(page);
    await expect(page.locator(".ps-ws-message")).toHaveText("Workspace files are not set up on this portal.");
});

test("find in a file: no Replace, a match count, and Escape closes only the find box", async ({ page }) => {
    const folder = new Folder({ "notes.txt": "alpha beta\nbeta gamma\n" });
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    await page.getByRole("button", { name: "Zen mode" }).click();
    await expect(page.getByRole("button", { name: "Leave zen mode" })).toBeVisible();
    await row(page, "notes.txt").click();
    await expect(editor(page)).toContainText("gamma");
    await editor(page).click();
    await page.keyboard.press("ControlOrMeta+f");
    const find = page.getByRole("textbox", { name: "Find in file" });
    await expect(find).toBeFocused();
    await find.fill("beta");
    await expect(page.locator(".ps-ws-find-count")).toHaveText("2");
    await page.keyboard.press("Enter");
    await expect(page.locator(".ps-ws-find-count")).toHaveText(/^\d of 2$/);
    // Find only: no replace field, no replace buttons.
    await expect(page.locator(".ps-ws-viewer input")).toHaveCount(1);
    await expect(page.locator(".ps-ws-viewer").getByRole("button", { name: /replace/i })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(find).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Leave zen mode" }), "Escape closed the find box, not zen").toBeVisible();
    // Typing in the editor: Escape is the editor's.
    await editor(page).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Leave zen mode" })).toBeVisible();
    // Anywhere else, Escape still steps down out of zen.
    await page.locator(".ps-ws-folder-path").click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Zen mode" })).toBeVisible();
});

test("keys on a focused tree row stay in the pane: no session command", async ({ page }) => {
    const folder = new Folder({ "notes.txt": "n\n", "docs/a.md": "a\n" });
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    await row(page, "docs").click();
    await expect(row(page, "docs")).toBeFocused();
    // The portal's single-key shortcuts: d completes, c cancels, Shift+D deletes the session.
    for (const key of ["d", "c", "Shift+D"]) await page.keyboard.press(key);
    await expect(page.getByText(/^(Complete|Cancel|Delete) session "/)).toHaveCount(0);
});

test("Escape from the page itself steps down out of full screen, then zen", async ({ page }) => {
    await routeWorkspace(page, new Folder({ "notes.txt": "n\n" }));
    await openWorkspace(page);
    await page.getByRole("button", { name: "Zen mode" }).click();
    await expect(page.getByRole("button", { name: "Leave zen mode" })).toBeVisible();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Zen mode" })).toBeVisible();
    await page.getByRole("button", { name: "Full screen canvas" }).click();
    await expect(page.getByRole("button", { name: "Full screen canvas" })).toHaveCount(0);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Full screen canvas" })).toBeVisible();
});

test("a save over a file deleted on disk offers Save as new; a too-large file says its size", async ({ page }) => {
    const folder = new Folder({ "draft.txt": "one\n", "big.bin": "x".repeat(3000) });
    folder.maxBytes = 1000;
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    await row(page, "big.bin").click();
    await expect(page.locator(".ps-ws-viewer")).toContainText("big.bin is 2.9 KB.");
    await row(page, "draft.txt").click();
    await expect(editor(page)).toContainText("one");
    await editor(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("two");
    folder.nodes.delete("draft.txt");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "The file was deleted" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Save as new" }).click();
    await expect.poll(() => folder.text("draft.txt")).toBe("one\ntwo");
});

test("leaving the page with unsaved edits asks first", async ({ page }) => {
    await routeWorkspace(page, new Folder({ "notes.txt": "n\n" }));
    await openWorkspace(page);
    await row(page, "notes.txt").click();
    await expect(editor(page)).toContainText("n");
    await editor(page).click();
    await page.keyboard.type("x");
    const asked = new Promise((resolve) => page.once("dialog", (dialog) => { resolve(dialog.type()); dialog.dismiss().catch(() => {}); }));
    await page.close({ runBeforeUnload: true });
    expect(await asked).toBe("beforeunload");
});

test("full screen: the Workspace tab is solid, nothing shows through", async ({ page }) => {
    await routeWorkspace(page, new Folder({ "notes.txt": "n\n" }));
    await openWorkspace(page);
    await page.getByRole("button", { name: "Full screen canvas" }).click();
    const background = await page.locator(".ps-side-pane-layer:not(.is-parked) .ps-ws-pane").evaluate((el) => getComputedStyle(el).backgroundColor);
    const alpha = /rgba\([^)]*,\s*([\d.]+)\)/.exec(background)?.[1];
    expect(background === "transparent" || (alpha !== undefined && Number(alpha) < 1), `background ${background}`).toBe(false);
});

const computed = (locator, ...names) => locator.evaluate((el, names) => {
    const style = getComputedStyle(el);
    return Object.fromEntries(names.map((name) => [name, style[name]]));
}, names);

async function useTheme(page, themeId) {
    await page.route("**/api/v1/me/profile**", (route) => route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: { themeId } } } }));
}

test("Win95: the side pane is a raised window with a navy title bar, white wells and navy selection", async ({ page }) => {
    await useTheme(page, "win95");
    await routeWorkspace(page, new Folder({ "src/a.ts": "export const a = 1;\n", "README.md": "# App\n" }));
    await openWorkspace(page);
    await expect(page.locator("html")).toHaveAttribute("data-ps-theme", "win95");

    // The title bar has the panel header's gradient; the chosen tab is pressed in.
    expect((await computed(page.locator(".ps-canvas-pane > .ps-artifact-pane-bar"), "backgroundImage")).backgroundImage)
        .toMatch(/^linear-gradient\(90deg, rgb\(0, 0, 128\)/);
    expect(await computed(page.getByRole("tab", { name: "Workspace" }), "borderTopColor", "borderBottomColor"))
        .toEqual({ borderTopColor: "rgb(0, 0, 0)", borderBottomColor: "rgb(255, 255, 255)" });
    expect(await computed(page.getByRole("tab", { name: "Canvas" }), "borderTopColor", "backgroundColor"))
        .toEqual({ borderTopColor: "rgb(255, 255, 255)", backgroundColor: "rgb(192, 192, 192)" });

    // The tree and the viewer are white wells; the open file's row is navy with white text.
    expect((await computed(tree(page), "backgroundColor")).backgroundColor).toBe("rgb(255, 255, 255)");
    await row(page, "README.md").click();
    await expect(row(page, "README.md")).toHaveClass(/is-selected/);
    expect(await computed(row(page, "README.md"), "backgroundColor", "color")).toEqual({ backgroundColor: "rgb(0, 0, 128)", color: "rgb(255, 255, 255)" });
    expect((await computed(page.locator(".ps-ws-viewer-body"), "backgroundColor")).backgroundColor).toBe("rgb(255, 255, 255)");
    expect((await computed(page.locator(".ps-ws-chip.is-on"), "backgroundColor", "color"))).toEqual({ backgroundColor: "rgb(0, 0, 128)", color: "rgb(255, 255, 255)" });
    await page.screenshot({ path: test.info().outputPath("win95-workspace.png") });

    // The find field removes the browser's focus ring, so focus shows as a navy outline.
    await page.getByPlaceholder("Find files").click();
    expect(await computed(page.locator(".ps-ws-finder"), "outlineStyle", "outlineColor")).toEqual({ outlineStyle: "solid", outlineColor: "rgb(0, 0, 128)" });
});

test("Win95: a disabled primary button, such as Save while it saves, is grey, not navy", async ({ page }) => {
    await useTheme(page, "win95");
    await routeWorkspace(page, new Folder({ "notes.txt": "n\n" }), { writeDelayMs: 1500 });
    await openWorkspace(page);
    await row(page, "notes.txt").click();
    await editor(page).click();
    await page.keyboard.type("x");
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(save).toHaveClass(/is-primary/);
    expect((await computed(save, "backgroundColor")).backgroundColor).toBe("rgb(0, 0, 128)");
    await save.click();
    await expect(save).toBeDisabled();
    await expect(save).toHaveClass(/is-primary/);
    expect(await computed(save, "backgroundColor", "color")).toEqual({ backgroundColor: "rgb(192, 192, 192)", color: "rgb(128, 128, 128)" });
});

test("Win95 on a phone: the list and the file fit the screen, and the thin top strip keeps its look", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
        await useTheme(page, "win95");
        await routeWorkspace(page, new Folder({ "README.md": "# App\n", "src/a.ts": "export const a = 1;\n" }));
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
        await expect(page.locator("html")).toHaveAttribute("data-ps-theme", "win95");
        await page.getByRole("button", { name: "Show canvas" }).click();
        await page.getByRole("tab", { name: "The session's folders and files" }).click();
        await row(page, "README.md").click();
        await expect(page.locator(".ps-ws-viewer .cm-content")).toHaveText("# App");

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
        for (const selector of [".ps-ws-pane", ".ps-ws-toolbar", ".ps-ws-viewer-bar", ".ps-ws-tree", ".ps-ws-viewer-body"]) {
            const b = await page.locator(selector).boundingBox();
            expect(b.x + b.width, selector).toBeLessThanOrEqual(391);
        }
        expect((await computed(tree(page), "backgroundColor")).backgroundColor).toBe("rgb(255, 255, 255)");
        const strip = page.locator(".ps-canvas-pane > .ps-artifact-pane-bar.is-rev-strip");
        await expect(strip).toHaveCount(1);
        expect((await computed(strip, "backgroundImage")).backgroundImage).toBe("none");
        await page.screenshot({ path: test.info().outputPath("win95-workspace-phone.png") });
    } finally {
        await context.close();
    }
});

test("other themes keep their own side pane: no title bar gradient, no white wells", async ({ page }) => {
    await routeWorkspace(page, new Folder({ "README.md": "# App\n" }));
    await openWorkspace(page);
    await expect(page.locator("html")).not.toHaveAttribute("data-ps-theme", "win95");
    expect((await computed(page.locator(".ps-canvas-pane > .ps-artifact-pane-bar"), "backgroundImage")).backgroundImage).toBe("none");
    expect((await computed(tree(page), "backgroundColor")).backgroundColor).not.toBe("rgb(255, 255, 255)");
});

test("markdown preview links: #heading scrolls, a file link opens the file, a web link opens a new tab", async ({ page }) => {
    const guide = `# Guide\n\n[Jump](#install-it) [License](../LICENSE) [Web](https://example.com/x) [Out](../../x.md)\n\n${"filler\n\n".repeat(80)}## Install it\n\nsteps\n`;
    await routeWorkspace(page, new Folder({ "docs/guide.md": guide, "LICENSE": "MIT License\n" }));
    await openWorkspace(page);
    await row(page, "docs").dblclick();
    await row(page, "guide.md").click();
    await page.getByRole("button", { name: "Preview" }).click();
    const body = page.locator(".ps-ws-md-body");
    await expect(body.getByRole("link", { name: "Web" })).toHaveAttribute("target", "_blank");
    const address = page.url();
    await body.getByRole("link", { name: "Jump" }).click();
    await expect(body.locator("#user-content-install-it")).toBeInViewport();
    expect(page.url(), "the portal's address did not change").toBe(address);
    await body.getByRole("link", { name: "Out" }).click();
    await expect(page.getByText("That link points outside this folder.")).toBeVisible();
    await body.getByRole("link", { name: "License" }).click();
    await expect(editor(page)).toContainText("MIT License");
    await expect(row(page, "LICENSE")).toHaveAttribute("aria-selected", "true");
    expect(page.url()).toBe(address);
});

test("New folder and New file go into the picked folder, or next to the picked file", async ({ page }) => {
    const folder = new Folder({ "docs/guide.md": "g\n", "top.txt": "t\n" });
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    await row(page, "docs").click();
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    await page.getByRole("textbox", { name: "New folder name" }).fill("drafts");
    await page.keyboard.press("Enter");
    await expect.poll(() => folder.nodes.get("docs/drafts")?.kind).toBe("dir");
    await expect(row(page, "drafts"), "focus comes back to the new folder").toBeFocused();
    await row(page, "guide.md").click();
    await page.getByRole("button", { name: "New file", exact: true }).click();
    await page.getByRole("textbox", { name: "New file name" }).fill("next.md");
    await page.keyboard.press("Enter");
    await expect.poll(() => folder.nodes.has("docs/next.md")).toBe(true);
});

test("the tree: one tab stop, levels, and the arrow keys move, open and close", async ({ page }) => {
    await routeWorkspace(page, new Folder({ "docs/a.md": "a\n", "docs/b.md": "b\n", "z.txt": "z\n" }));
    await openWorkspace(page);
    await expect(row(page, "docs")).toBeVisible();
    await expect(tree(page).locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
    await expect(row(page, "docs")).toHaveAttribute("aria-level", "1");
    await row(page, "docs").focus();
    await page.keyboard.press("ArrowRight");
    await expect(row(page, "docs")).toHaveAttribute("aria-expanded", "true");
    await expect(row(page, "a.md")).toHaveAttribute("aria-level", "2");
    await page.keyboard.press("ArrowDown");
    await expect(row(page, "a.md")).toBeFocused();
    await page.keyboard.press("End");
    await expect(row(page, "z.txt")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(row(page, "docs")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowLeft");
    await expect(row(page, "docs"), "ArrowLeft on a file goes to its folder").toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(row(page, "docs")).toHaveAttribute("aria-expanded", "false");
    await expect(tree(page).locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
});

test("a script without an extension is colored by its #! line", async ({ page }) => {
    await routeWorkspace(page, new Folder({ "run": "#!/usr/bin/env bash\nset -e\necho \"hi\"\n", "plain": "just words\n" }));
    await openWorkspace(page);
    await row(page, "plain").click();
    await expect(editor(page)).toContainText("just words");
    await expect(page.locator(".ps-ws-viewer .cm-line span")).toHaveCount(0);
    await row(page, "run").click();
    await expect(editor(page)).toContainText("echo");
    await expect(page.locator(".ps-ws-viewer .cm-line span").first()).toBeVisible();
});

test("someone who is not the session's owner is told so, with no Retry", async ({ page }) => {
    await routeWorkspace(page, new Folder({}));
    await page.route(`**/management/sessions/${sessionId}/workspace/folders`, (route) => route.fulfill({ status: 403, json: { ok: false, error: { code: "FORBIDDEN", message: "only the session's owner can use its files" } } }));
    await openWorkspace(page);
    await expect(page.locator(".ps-ws-message")).toHaveText("Only the session's owner can see its folders.");
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
});

test("an SVG shows from a data: address, never a same-origin blob: one", async ({ page }) => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>window.parent.hacked=1</script><rect width="4" height="4"/></svg>';
    await routeWorkspace(page, new Folder({ "logo.svg": svg, "README.md": "# R\n\n![logo](logo.svg)\n" }));
    await openWorkspace(page);
    await row(page, "logo.svg").click();
    await expect(page.locator(".ps-ws-image img")).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/);
    await row(page, "README.md").click();
    await page.getByRole("button", { name: "Preview" }).click();
    await page.getByRole("button", { name: "Show images" }).click();
    await expect(page.locator(".ps-ws-md-body img")).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/);
});

test("markdown preview: no portal classes, no image maps, and a file's ids are prefixed", async ({ page }) => {
    const md = [
        '<div class="ps-modal-backdrop" id="ps-toolbar-canvas-slot">Your session has expired</div>',
        '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" usemap="#m" width="50" height="50"><map name="m"><area shape="rect" coords="0,0,50,50" href="https://evil.example/phish"></map>',
        "",
    ].join("\n\n");
    await routeWorkspace(page, new Folder({ "trap.md": md }));
    await openWorkspace(page);
    await row(page, "trap.md").click();
    await page.getByRole("button", { name: "Preview" }).click();
    const body = page.locator(".ps-ws-md-body");
    await expect(body).toContainText("Your session has expired");
    await expect(body.locator(".ps-modal-backdrop")).toHaveCount(0);
    await expect(body.locator("[class]")).toHaveCount(0);
    await expect(body.locator("area, map, [usemap]")).toHaveCount(0);
    await expect(page.locator("#ps-toolbar-canvas-slot.ps-modal-backdrop, .ps-ws-md-body #ps-toolbar-canvas-slot")).toHaveCount(0);
    await expect(body.locator("#user-content-ps-toolbar-canvas-slot")).toHaveCount(1);
});

test("a file that is not UTF-8 opens for download only, so a save cannot change its bytes", async ({ page }) => {
    await routeWorkspace(page, new Folder({ "legacy.txt": Buffer.from([0x63, 0x61, 0x66, 0xE9, 0x0A]) }));
    await openWorkspace(page);
    await row(page, "legacy.txt").click();
    await expect(page.locator(".ps-ws-viewer")).toContainText("legacy.txt is not UTF-8 text (5 B), so it cannot be edited here");
    await expect(editor(page)).toHaveCount(0);
});

test("a save keeps CRLF line ends and a byte-order mark", async ({ page }) => {
    const folder = new Folder({ "win.txt": "one\r\ntwo\r\n", "bom.cs": Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("class A {}\n")]) });
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    await row(page, "win.txt").click();
    await page.locator(".ps-ws-viewer .cm-line", { hasText: "two" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => folder.text("win.txt")).toBe("one\r\ntwo!\r\n");
    await row(page, "bom.cs").click();
    await expect(page.locator(".ps-ws-viewer .cm-line").first()).toHaveText("class A {}");
    await page.locator(".ps-ws-viewer .cm-line").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" // b");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => [...folder.nodes.get("bom.cs").bytes.subarray(0, 3)]).toEqual([0xEF, 0xBB, 0xBF]);
    expect(folder.nodes.get("bom.cs").bytes.subarray(3).toString("utf8")).toBe("class A {} // b\n");
});

test("text typed while a save is on its way stays, even after opening another file", async ({ page }) => {
    const folder = new Folder({ "a.txt": "alpha\n", "b.txt": "beta\n" });
    await routeWorkspace(page, folder, { writeDelayMs: 1500 });
    await openWorkspace(page);
    await row(page, "a.txt").click();
    await page.locator(".ps-ws-viewer .cm-line", { hasText: "alpha" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type("1");
    await page.keyboard.press("ControlOrMeta+s");
    await page.keyboard.type("2");
    await row(page, "b.txt").click();
    await expect(editor(page)).toContainText("beta");
    await expect.poll(() => folder.text("a.txt"), { timeout: 5000 }).toBe("alpha1\n");
    await row(page, "a.txt").click();
    await expect(editor(page)).toContainText("alpha12");
});

test("deleting a file drops its unsaved edits", async ({ page }) => {
    const folder = new Folder({ "notes.txt": "old\n" });
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    await row(page, "notes.txt").click();
    await page.locator(".ps-ws-viewer .cm-line", { hasText: "old" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" SECRET DRAFT");
    await row(page, "notes.txt").hover();
    await page.getByRole("button", { name: "Delete notes.txt" }).click();
    await page.getByRole("dialog", { name: "Delete" }).getByRole("button", { name: "Delete" }).click();
    await expect.poll(() => folder.nodes.has("notes.txt")).toBe(false);
    await page.getByRole("button", { name: "New file", exact: true }).click();
    await page.getByRole("textbox", { name: "New file name" }).fill("notes.txt");
    await page.keyboard.press("Enter");
    await expect.poll(() => folder.nodes.has("notes.txt")).toBe(true);
    await expect(page.locator(".ps-ws-viewer .cm-content")).not.toContainText("SECRET DRAFT");
});

test("a rename that fails does not take focus later; Escape outside the pane leaves its dialog", async ({ page }) => {
    const folder = new Folder({ "a.md": "a\n" });
    await routeWorkspace(page, folder);
    // The move does not answer in time; the new name shows up later anyway.
    await page.route(`**/management/sessions/${sessionId}/workspace/files`, (route) => (route.request().postDataJSON().call.op === "move"
        ? route.fulfill({ status: 504, json: { ok: false, error: { code: "WORKSPACE_FILES_TIMEOUT", message: "the folder did not answer within 30 s" } } })
        : route.fallback()));
    await openWorkspace(page);
    await row(page, "a.md").hover();
    await page.getByRole("button", { name: "Rename a.md" }).click();
    await page.getByRole("textbox", { name: "New name" }).fill("b.md");
    await page.keyboard.press("Enter");
    await expect(page.getByText("The folder did not answer in time.")).toBeVisible();
    const finder = page.getByRole("combobox", { name: "Find files in app" });
    await finder.click();
    await page.keyboard.type("zz");
    folder.set("b.md", "b\n");
    await finder.fill("");
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent("pilotswarm:workspace-files-changed", { detail: { sessionId: id, source: "canvas" } })), sessionId);
    await expect(row(page, "b.md")).toBeVisible();
    await expect(finder, "the late b.md row does not take focus").toBeFocused();

    await row(page, "a.md").hover();
    await page.getByRole("button", { name: "Delete a.md" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete" });
    await expect(dialog).toBeVisible();
    await page.locator("textarea.ps-prompt-input").first().focus();
    await page.keyboard.press("Escape");
    await expect(dialog, "Escape in the chat is the chat's").toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
});

test("a folder on a root this portal does not serve gets the regular check, not the 2 s one", async ({ page }) => {
    await routeWorkspace(page, new Folder({}), { folders: [{ ...FOLDERS[0], opened: true, available: false }] });
    let reads = 0;
    page.on("request", (request) => { if (request.url().includes("/workspace/folders")) reads += 1; });
    await openWorkspace(page);
    await expect(page.getByRole("tab", { name: /^app/ })).toBeDisabled();
    const start = reads;
    await page.waitForTimeout(5000);
    expect(reads - start, "no 2-second checks for a folder that cannot open here").toBeLessThanOrEqual(1);
});

test("Delete deletes the focused row, from the keyboard alone or after a click elsewhere", async ({ page }) => {
    await routeWorkspace(page, new Folder({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" }));
    await openWorkspace(page);
    await row(page, "a.txt").focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Delete");
    const dialog = page.getByRole("dialog", { name: "Delete" });
    await expect(dialog).toContainText("Delete b.txt?");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await row(page, "a.txt").click();
    await row(page, "a.txt").focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Delete");
    await expect(dialog, "the focused row, not the last clicked one").toContainText("Delete c.txt?");
});

test("the tab runs one check at a time, so checks cannot pile up on a slow folder", async ({ page }) => {
    await routeWorkspace(page, new Folder({ "a.txt": "a\n" }));
    let lists = 0;
    await page.route(`**/management/sessions/${sessionId}/workspace/files`, async (route) => {
        if (route.request().postDataJSON().call.op === "list") {
            lists += 1;
            await new Promise((resolve) => setTimeout(resolve, 2500));
        }
        return route.fallback();
    });
    await openWorkspace(page);
    await expect(row(page, "a.txt")).toBeVisible({ timeout: 10_000 });
    const before = lists;
    for (let i = 0; i < 3; i++) {
        await page.evaluate((id) => window.dispatchEvent(new CustomEvent("pilotswarm:workspace-files-changed", { detail: { sessionId: id, source: "canvas" } })), sessionId);
        await page.waitForTimeout(700);
    }
    await page.waitForTimeout(3000);
    expect(lists - before, "the second and third checks wait for the first").toBeLessThanOrEqual(2);
});

test("find files by name: pick one, and the tree shows it open", async ({ page }) => {
    const folder = new Folder({ "README.md": "# r\n", "docs/guide.md": "g\n", "docs/deep/guide-extra.md": "x\n", "src/a.ts": "a\n" });
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    const finder = page.getByRole("combobox", { name: "Find files in app" });
    await finder.fill("guide");
    const results = page.getByRole("listbox", { name: "Files matching guide" });
    await expect(results.getByRole("option")).toHaveText([/^guide\.md\s*docs$/, /^guide-extra\.md\s*docs\/deep$/]);
    await expect(results.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(editor(page)).toHaveText("x");
    await expect(finder).toHaveValue("");
    await expect(row(page, "guide-extra.md")).toHaveAttribute("aria-selected", "true");
    await expect(row(page, "deep")).toHaveAttribute("aria-expanded", "true");

    await finder.fill("nothing-like-this");
    await expect(page.getByRole("listbox", { name: "Files matching nothing-like-this" })).toContainText("No file or folder name has these words.");
    await page.keyboard.press("Escape");
    await expect(finder).toHaveValue("");
    await expect(tree(page)).toBeVisible();
});

test("each session's view is remembered, and a file that is gone leaves the default view", async ({ page }) => {
    const folder = new Folder({ "docs/guide.md": "# Guide\n", "README.md": "# App\n" });
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    await row(page, "docs").dblclick();
    await row(page, "guide.md").click();
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.locator(".ps-ws-md-preview").getByRole("heading", { name: "Guide" })).toBeVisible();

    await page.reload();
    await showWorkspaceTab(page);
    await expect(page.locator(".ps-ws-md-preview").getByRole("heading", { name: "Guide" })).toBeVisible();
    await expect(row(page, "guide.md")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");

    folder.nodes.delete("docs/guide.md");
    await page.reload();
    await showWorkspaceTab(page);
    await expect(row(page, "docs")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".ps-ws-viewer .ps-ws-message")).toHaveText(/^Pick a file to open it/);
    await expect(page.locator(".ps-ws-viewer .is-error")).toHaveCount(0);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("pilotswarm.workspace.views") || "{}"));
    expect(Object.values(saved)[0].folders.working.file, "the missing file is forgotten").toBeNull();
});

// Every piece of text in the Workspace tab, measured against what is really
// behind it (translucent fills composited), in every theme.
async function textContrast(page) {
    return page.evaluate(() => {
        const parse = (value) => {
            let match = /^rgba?\(([^)]+)\)$/.exec(value);
            if (match) {
                const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
                return [parts[0], parts[1], parts[2], parts[3] ?? 1];
            }
            match = /^color\(srgb ([^)]+)\)$/.exec(value);
            if (match) {
                const parts = match[1].split(/[\s/]+/).filter(Boolean).map(Number);
                return [parts[0] * 255, parts[1] * 255, parts[2] * 255, parts[3] ?? 1];
            }
            return null;
        };
        const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
        const luminance = (c) => {
            const [r, g, b] = c.slice(0, 3).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (a, b) => { const la = luminance(a); const lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
        const behind = (element) => {
            const layers = [];
            for (let node = element; node; node = node.parentElement) {
                const colour = parse(getComputedStyle(node).backgroundColor);
                if (colour && colour[3] > 0) {
                    layers.push(colour);
                    if (colour[3] >= 1) break;
                }
            }
            let base = layers.length && layers[layers.length - 1][3] >= 1 ? layers.pop() : [0, 0, 0, 1];
            while (layers.length) base = over(layers.pop(), base);
            return base;
        };
        const root = document.querySelector('[aria-label="Session canvas"]');
        const results = [];
        const seen = new Set();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            const element = text.parentElement;
            if (!text.textContent.trim() || !element || seen.has(element)) continue;
            seen.add(element);
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            if (box.width < 1 || box.height < 1 || style.visibility === "hidden") continue;
            if (element.closest("[disabled], [aria-disabled='true'], .is-parked, [inert]")) continue;
            let opacity = 1;
            for (let node = element; node && node !== root.parentElement; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
            const background = behind(element);
            let colour = parse(style.color);
            if (!colour) continue;
            colour = over([...colour.slice(0, 3), colour[3] * opacity], background);
            results.push({ text: text.textContent.trim().slice(0, 24), where: String(element.className || element.tagName).slice(0, 36), ratio: Math.round(ratio(colour, background) * 100) / 100 });
        }
        return results;
    });
}

for (const theme of listThemes()) {
    test(`${theme.id}: every piece of text in the Workspace tab is readable`, async ({ page }) => {
        await page.route("**/api/v1/me/profile", (route) => route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: { themeId: theme.id } } } }));
        const folder = new Folder({
            ".git/HEAD": "ref\n",
            "src/app.js": "// a comment\nconst name = \"text\";\nfunction answer() { return 42; }\n",
            "guide.md": "# Guide\n\nSee [the docs](https://example.test).\n",
        });
        await routeWorkspace(page, folder);
        await openWorkspace(page);
        await expect(page.locator("html")).toHaveAttribute("data-ps-theme", theme.id);
        await row(page, "src").dblclick();
        await row(page, "app.js").click();
        await expect(page.locator(".ps-ws-viewer .cm-content")).toContainText("return 42");
        await editor(page).click();
        await page.keyboard.press("ControlOrMeta+f");
        await page.getByRole("textbox", { name: "Find in file" }).fill("name");
        await expect(page.locator(".ps-ws-find-count")).toHaveText(/1/);
        const first = await textContrast(page);

        await page.getByRole("combobox", { name: "Find files in app" }).fill("guide");
        await expect(page.getByRole("listbox", { name: "Files matching guide" }).getByRole("option")).toHaveCount(1);
        const second = await textContrast(page);
        await page.getByRole("combobox", { name: "Find files in app" }).fill("");
        await row(page, "guide.md").click();
        await page.getByRole("button", { name: "Preview" }).click();
        await expect(page.locator(".ps-ws-md-preview a")).toHaveText("the docs");
        await row(page, "guide.md").hover();
        await page.getByRole("button", { name: "Delete guide.md" }).click();
        await expect(page.getByRole("dialog", { name: "Delete" })).toBeVisible();
        const third = await textContrast(page);

        const all = [...first, ...second, ...third];
        expect(all.length, "measured the tab's text").toBeGreaterThan(20);
        const faint = all.filter((item) => item.ratio < 4.5).map((item) => `"${item.text}" (${item.where}) ${item.ratio}:1`);
        expect([...new Set(faint)], "text below 4.5:1").toEqual([]);
    });
}

test("each folder keeps its own file and place; switching chips brings them back", async ({ page }) => {
    const long = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const work = new Folder({ "long.txt": long, "b.txt": "b\n" });
    const shared = new Folder({ "notes.md": "# Shared notes\n" });
    await routeWorkspace(page, work, { folders: TWO_FOLDERS, others: { "extra:shared": shared } });
    await openWorkspace(page);
    await row(page, "long.txt").click();
    await expect(editor(page)).toContainText("line 1");
    const scroller = page.locator(".ps-ws-viewer .cm-scroller");
    await scroller.evaluate((node) => { node.scrollTop = 3000; });
    await page.waitForTimeout(500);
    const before = await scroller.evaluate((node) => node.scrollTop);
    expect(before).toBeGreaterThan(2000);

    await page.getByRole("tab", { name: /^shared/ }).click();
    const sharedTree = page.getByRole("tree", { name: "Files in shared" });
    await sharedTree.getByRole("treeitem", { name: /notes\.md/ }).click();
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.locator(".ps-ws-md-preview").getByRole("heading", { name: "Shared notes" })).toBeVisible();

    await page.getByRole("tab", { name: /^app/ }).click();
    await expect(editor(page)).toContainText("line");
    await expect(row(page, "long.txt")).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(before - 60);

    await page.getByRole("tab", { name: /^shared/ }).click();
    await expect(page.locator(".ps-ws-md-preview").getByRole("heading", { name: "Shared notes" }), "shared's file, in Preview").toBeVisible();

    // A reload brings back the folder, its file, and the place.
    await page.getByRole("tab", { name: /^app/ }).click();
    await expect(editor(page)).toContainText("line");
    await page.reload();
    await showWorkspaceTab(page);
    await expect(row(page, "long.txt")).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => page.locator(".ps-ws-viewer .cm-scroller").evaluate((node) => node.scrollTop)).toBeGreaterThan(before - 60);
});

test("the tree keeps its scroll; a file found by name is selected and brought to the middle", async ({ page }) => {
    // Folders list first: the target sits after sixty of them and eighty files.
    const files = {};
    for (let i = 0; i < 60; i++) files[`d${String(i).padStart(2, "0")}/x.txt`] = "x\n";
    for (let i = 0; i < 80; i++) files[`f${String(i).padStart(2, "0")}.txt`] = `${i}\n`;
    files["zz/er/target.md"] = "# Target\n";
    const folder = new Folder(files);
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    await expect(row(page, "d00")).toBeVisible();
    await tree(page).evaluate((node) => { node.scrollTop = 600; });
    await page.waitForTimeout(500);
    await page.reload();
    await showWorkspaceTab(page);
    await expect.poll(() => tree(page).evaluate((node) => node.scrollTop)).toBeGreaterThan(550);

    await page.getByRole("combobox", { name: "Find files in app" }).fill("target");
    await expect(page.getByRole("listbox", { name: "Files matching target" }).getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    const target = row(page, "target.md");
    await expect(target).toHaveAttribute("aria-selected", "true");
    await expect(editor(page)).toHaveText("# Target");
    const place = await target.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const view = node.closest("[role=tree]").getBoundingClientRect();
        return { inside: box.top >= view.top && box.bottom <= view.bottom, offCenter: Math.abs((box.top + box.bottom) / 2 - (view.top + view.bottom) / 2) };
    });
    expect(place.inside, "the found file shows in the tree").toBe(true);
    expect(place.offCenter, "and near the middle").toBeLessThan(80);
});

test("pick several: Cmd/Ctrl-click, Shift-click, download, drag, delete, Escape", async ({ page }) => {
    const folder = new Folder({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "d.txt": "d\n", "box/keep.txt": "k\n" });
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    await row(page, "a.txt").click();
    await row(page, "c.txt").click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByRole("toolbar", { name: "Selected items" })).toContainText("2 selected");
    await row(page, "d.txt").click({ modifiers: ["Shift"] });
    await expect(page.getByRole("toolbar", { name: "Selected items" })).toContainText("2 selected", { timeout: 1000 }).catch(() => {});
    // Shift-click from the last one picked (c) to d: c and d.
    await expect(tree(page).locator(".ps-ws-row.is-picked .ps-ws-row-name")).toHaveText(["c.txt", "d.txt"]);
    await row(page, "a.txt").click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByRole("toolbar", { name: "Selected items" })).toContainText("3 selected");

    const [zip] = await Promise.all([page.waitForEvent("download"), page.getByRole("toolbar", { name: "Selected items" }).getByRole("button", { name: "Download" }).click()]);
    expect(zip.suggestedFilename()).toBe("app-3-items.zip");
    expect(folder.calls.at(-1)).toMatchObject({ op: "zip", paths: ["a.txt", "c.txt", "d.txt"] });

    // Drag one of them: all three go.
    await row(page, "c.txt").dragTo(row(page, "box"));
    await expect.poll(() => ["a.txt", "c.txt", "d.txt"].map((n) => folder.nodes.has(`box/${n}`))).toEqual([true, true, true]);

    await row(page, "box").dblclick();
    await row(page, "keep.txt").click();
    await row(page, "b.txt").click({ modifiers: ["ControlOrMeta"] });
    await tree(page).press("Delete");
    const dialog = page.getByRole("dialog", { name: "Delete" });
    await expect(dialog.getByRole("button", { name: "Cancel" }), "Delete opens on Cancel, not on Delete").toBeFocused();
    await expect(dialog).toContainText("Delete 2 items?");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect.poll(() => [folder.nodes.has("box/keep.txt"), folder.nodes.has("b.txt")]).toEqual([false, false]);

    await row(page, "a.txt").click({ modifiers: ["ControlOrMeta"] });
    await expect(tree(page).locator(".ps-ws-row.is-picked")).not.toHaveCount(0);
    await tree(page).press("Escape");
    await expect(tree(page).locator(".ps-ws-row.is-picked")).toHaveCount(0);
});

test("typing while a save is on its way is kept, and stays unsaved", async ({ page }) => {
    const folder = new Folder({ "notes.txt": "start\n" });
    await routeWorkspace(page, folder, { writeDelayMs: 700 });
    await openWorkspace(page);
    await row(page, "notes.txt").click();
    await editor(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("one ");
    await page.keyboard.press("ControlOrMeta+s");
    await page.keyboard.type("two");
    await expect.poll(() => folder.text("notes.txt")).toBe("start\none ");
    await expect(editor(page)).toContainText("one two");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => folder.text("notes.txt")).toBe("start\none two");
});

test("renaming the folder of the open file: the file follows, and saving works", async ({ page }) => {
    const folder = new Folder({ "docs/guide.md": "guide\n" });
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    await row(page, "docs").dblclick();
    await row(page, "guide.md").click();
    await editor(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("more");
    await row(page, "docs").hover();
    await page.getByRole("button", { name: "Rename docs" }).click();
    await page.getByRole("textbox", { name: "New name" }).fill("manual");
    await page.keyboard.press("Enter");
    await expect(page.locator(".ps-ws-crumbs")).toContainText("manual");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => folder.text("manual/guide.md")).toBe("guide\nmore");
});

test("a first load that fails can be tried again", async ({ page }) => {
    const folder = new Folder({ "a.txt": "a\n" });
    await routeWorkspace(page, folder);
    let fails = 1;
    await page.route(`**/management/sessions/${sessionId}/workspace/folders`, (route) => {
        if (fails-- > 0) return route.fulfill({ status: 504, json: { ok: false, error: { code: "WORKSPACE_FILES_TIMEOUT", message: "slow" } } });
        return route.fulfill({ json: { ok: true, result: { enabled: true, maxBytes: 20971520, folders: FOLDERS } } });
    });
    await openWorkspace(page);
    await expect(page.locator(".ps-ws-message")).toContainText("did not answer in time");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(row(page, "a.txt")).toBeVisible();
});

test("an image button in markdown loads nothing either", async ({ page }) => {
    const folder = new Folder({ "README.md": "# T\n\n<input type=\"image\" src=\"https://images.example.test/pixel.png\">\n" });
    const remote = [];
    await page.route("https://images.example.test/**", (route) => { remote.push(route.request().url()); return route.fulfill({ body: DOT_PNG, contentType: "image/png" }); });
    await routeWorkspace(page, folder);
    await openWorkspace(page);
    await row(page, "README.md").click();
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.locator(".ps-ws-md-preview").getByRole("heading", { name: "T" })).toBeVisible();
    await expect(page.locator(".ps-ws-md-preview input")).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(remote).toEqual([]);
});


test("a folder that is not on disk keeps its message while each check asks again (no blinking)", async ({ page }) => {
    await routeWorkspace(page, new Folder({}));
    let delay = 0;
    await page.route(`**/management/sessions/${sessionId}/workspace/files`, async (route) => {
        const call = route.request().postDataJSON().call;
        if (call.op !== "list" || call.path) return route.fallback();
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        return route.fulfill({ status: 404, json: { ok: false, error: { code: "WORKSPACE_FILES_NOT_FOUND", message: "no such file or folder" } } });
    });
    await openWorkspace(page);
    const gone = tree(page).locator(".ps-ws-row.is-error");
    await expect(gone).toHaveText("This folder is not on disk: a/sessions/s1/app. It may have been removed; the session's next turn can bring it back.");
    // A check (here: Refresh) asks again, slowly. Every state the tree goes
    // through is recorded: the message must never give way to "Loading…".
    await page.evaluate(() => {
        window.__treeTexts = [];
        const tree = document.querySelector(".ps-ws-tree");
        new MutationObserver(() => window.__treeTexts.push(tree.textContent)).observe(tree, { childList: true, subtree: true, characterData: true });
    });
    delay = 1_000;
    let lists = 0;
    page.on("request", (request) => { if (request.url().endsWith("/workspace/files") && request.postDataJSON()?.call?.op === "list") lists += 1; });
    await page.locator(".ps-ws-toolbar").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => lists).toBeGreaterThan(0);
    await page.waitForTimeout(1_500);
    await expect(gone).toBeVisible();
    const texts = await page.evaluate(() => window.__treeTexts);
    expect(texts.filter((text) => text.includes("Loading…"))).toEqual([]);
});

test("a first click selects a folder; a second click within 8 s opens it, the next closes it; its arrow opens at once", async ({ page }) => {
    await page.clock.install();
    await routeWorkspace(page, new Folder({ "docs/guide.md": "# Guide\n", "README.md": "# App\n" }));
    await openWorkspace(page);
    const docs = row(page, "docs");
    await docs.click();
    await expect(docs).toHaveAttribute("aria-expanded", "false");
    await expect(docs).toHaveClass(/is-picked/);
    await docs.click();
    await expect(docs).toHaveAttribute("aria-expanded", "true");
    await expect(row(page, "guide.md")).toBeVisible();
    await docs.click();
    await expect(docs).toHaveAttribute("aria-expanded", "false");
    // Later than 8 s: the click only selects again; the next one opens.
    await page.clock.fastForward(9_000);
    await docs.click();
    await expect(docs).toHaveAttribute("aria-expanded", "false");
    await docs.click();
    await expect(docs).toHaveAttribute("aria-expanded", "true");
    // Clicking another row starts over.
    await row(page, "README.md").click();
    await expect(editor(page)).toContainText("# App");
    await docs.click();
    await expect(docs).toHaveAttribute("aria-expanded", "true");
    // The arrow opens and closes at once.
    await docs.locator(".ps-ws-twisty").click();
    await expect(docs).toHaveAttribute("aria-expanded", "false");
});
