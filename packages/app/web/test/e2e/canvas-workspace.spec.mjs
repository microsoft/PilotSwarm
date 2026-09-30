// canvas-ws in the browser: a canvas app's calls go through the portal to the
// server with the canvas's own session and slot, and come back to the page.
// The server's checks (the app's declared paths and commands) have their own
// tests in the SDK; here the server is a fake that records what it was asked.
//
//   the page's calls arrive with the slot; results and errors come back
//   a click inside the canvas runs a declared command
//   a download the page asks for is saved by the portal
//   a page that watches hears about changes made in the Workspace tab
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

// The helper agents paste, read from the skill itself so the two never drift.
const SKILL = fs.readFileSync(path.resolve(__dirname, "../../../../sdk/plugins/system/skills/canvas-apps/SKILL.md"), "utf8");
const HELPER = /Paste this helper:\s*```js\n([\s\S]*?)```/.exec(SKILL)[1];

const APP = `<!doctype html>
<!-- CANVAS-APP-MANIFEST
{ "manifestVersion": 1, "name": "ws-test", "workspace": { "read": ["work/**"], "write": ["work/notes.md"], "watch": true,
  "commands": { "history": { "in": "work", "run": ["git", "log", "-n", "{limit}"], "params": { "limit": { "type": "int", "min": 1, "max": 50 } } } } } }
-->
<html><body>
<p id="info">…</p>
<button id="run" type="button">Run history</button>
<button id="save" type="button">Save note</button>
<button id="denied" type="button">Read secret</button>
<button id="get" type="button">Download notes</button>
<button id="big" type="button">Save a big note</button>
<button id="folder" type="button">Download the folder</button>
<pre id="out"></pre>
<p id="changes">changes: 0</p>
<script>
${HELPER}
const ws = CanvasWorkspace();
const out = document.getElementById("out");
let changes = 0;
ws.info().then((info) => { document.getElementById("info").textContent = "commands " + (info.commandsEnabled ? "on" : "off") + ", folders " + info.folders.map((f) => f.name).join(","); });
ws.watch(() => { changes += 1; document.getElementById("changes").textContent = "changes: " + changes; })
  .then(() => { document.body.dataset.watching = "yes"; });
document.getElementById("run").onclick = () => ws.run("history", { limit: 3 }).then((r) => { out.textContent = r.stdout; }, (e) => { out.textContent = "error " + e.code; });
document.getElementById("save").onclick = () => ws.writeText("work/notes.md", "from the canvas", null).then((r) => { out.textContent = "saved " + r.etag; }, (e) => { out.textContent = "error " + e.code; });
document.getElementById("denied").onclick = () => ws.readText("work/.env").then(() => { out.textContent = "read!"; }, (e) => { out.textContent = "error " + e.code; });
document.getElementById("get").onclick = () => ws.download("work/notes.md").then((r) => { out.textContent = "downloaded " + r.filename; }, (e) => { out.textContent = "error " + e.code; });
document.getElementById("big").onclick = () => ws.writeText("work/notes.md", "x".repeat(300000), null).then(() => { out.textContent = "saved big"; }, (e) => { out.textContent = "error " + (e.code || e.message); });
document.getElementById("folder").onclick = () => ws.download("work/docs").then((r) => { out.textContent = "downloaded " + r.filename; }, (e) => { out.textContent = "error " + e.code; });
// A download nobody clicked for.
if (location.hash !== "#quiet") setTimeout(() => ws.download("work/notes.md").then(() => { document.body.dataset.unasked = "downloaded"; }, (e) => { document.body.dataset.unasked = e.code; }), 800);
</script>
</body></html>`;

async function drawApp(page, answers, html = APP) {
    const calls = [];
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return route.fulfill({ json: { ok: true, result: [{ seq: 1, eventType: "session.canvas_updated", data: { slot: 1, rev: 1, sizeBytes: html.length, name: "ws-test" } }] } });
        }
        if (url.pathname.includes("/artifacts/") && url.pathname.includes("canvas.html")) {
            return route.fulfill({ contentType: "text/html", body: html });
        }
        if (url.pathname.endsWith(`/management/sessions/${sessionId}/canvas-workspace`)) {
            const body = route.request().postDataJSON();
            calls.push(body);
            const answer = answers(body.call);
            return route.fulfill({ status: answer.status ?? 200, json: answer.status ? { ok: false, error: answer.error } : { ok: true, result: answer } });
        }
        return route.fallback();
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    const show = page.getByRole("button", { name: "Show canvas", exact: true });
    await show.or(page.getByRole("button", { name: "Hide the canvas", exact: true })).first().waitFor();
    if (await show.isVisible()) await show.click();
    const frame = page.frameLocator(".ps-side-pane-layer:not(.is-parked) iframe.ps-html-preview-frame:not(.is-staging)");
    return { calls, frame };
}

const ANSWERS = (call) => {
    switch (call.op) {
        case "info": return { folders: [{ name: "work", role: "working", home: false, available: true }], read: ["work/**"], write: ["work/notes.md"], watch: true, commands: { history: {} }, commandsEnabled: true, maxBytes: 20971520 };
        case "watch": return { watching: true };
        case "run": return { exitCode: 0, stdout: "abc1234 first commit\n", stderr: "", truncated: false, durationMs: 12 };
        case "write": return { path: call.path, etag: "sha256:feed", size: 15, created: true };
        case "zip": return { path: call.path, contentBase64: Buffer.from("PK-docs").toString("base64"), size: 7, files: 2 };
        case "read":
            if (call.path === "work/.env") return { status: 403, error: { code: "CANVAS_WS_DENIED", message: "this canvas app may not read work/.env" } };
            if (call.path === "work/docs") return { status: 400, error: { code: "WORKSPACE_FILES_NOT_A_FILE", message: "not a file" } };
            return { path: call.path, contentBase64: Buffer.from("from the canvas").toString("base64"), size: 15, etag: "sha256:feed" };
        default: return { status: 400, error: { code: "CANVAS_WS_PARAM_INVALID", message: "unknown" } };
    }
};

test("the page's calls reach the server for this canvas, and a click runs a declared command", async ({ page }) => {
    const { calls, frame } = await drawApp(page, ANSWERS);
    await expect(frame.locator("#info")).toHaveText("commands on, folders work");
    await frame.getByRole("button", { name: "Run history" }).click();
    await expect(frame.locator("#out")).toHaveText("abc1234 first commit");
    const run = calls.find((c) => c.call.op === "run");
    expect(run).toEqual({ slot: 1, call: { op: "run", command: "history", params: { limit: 3 } } });
    await frame.getByRole("button", { name: "Save note" }).click();
    await expect(frame.locator("#out")).toHaveText("saved sha256:feed");
    expect(calls.find((c) => c.call.op === "write").call).toEqual({ op: "write", path: "work/notes.md", contentBase64: Buffer.from("from the canvas").toString("base64"), ifMatch: null });
});

test("a refusal comes back to the page with its code", async ({ page }) => {
    const { frame } = await drawApp(page, ANSWERS);
    await expect(frame.locator("#info")).toHaveText(/commands on/);
    await frame.getByRole("button", { name: "Read secret" }).click();
    await expect(frame.locator("#out")).toHaveText("error CANVAS_WS_DENIED");
});

test("a download the page asks for is saved by the portal", async ({ page }) => {
    const { frame } = await drawApp(page, ANSWERS);
    await expect(frame.locator("#info")).toHaveText(/commands on/);
    const [download] = await Promise.all([page.waitForEvent("download"), frame.getByRole("button", { name: "Download notes" }).click()]);
    expect(download.suggestedFilename()).toBe("notes.md");
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("from the canvas");
    await expect(frame.locator("#out")).toHaveText("downloaded notes.md");
});

test("a page that watches hears about a change made in the Workspace tab", async ({ page }) => {
    const { frame } = await drawApp(page, ANSWERS);
    // The page asked to watch while it loaded; the portal takes the request once the canvas is live.
    await expect(frame.locator("body")).toHaveAttribute("data-watching", "yes");
    await expect(frame.locator("#changes")).toHaveText("changes: 0");
    // The Workspace tab announces its own changes on the window; the canvas passes them on.
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent("pilotswarm:workspace-files-changed", { detail: { sessionId: id, source: "pane" } })), sessionId);
    await expect(frame.locator("#changes")).toHaveText("changes: 1");
    // Another session's change is not this canvas's business.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("pilotswarm:workspace-files-changed", { detail: { sessionId: "someone-else", source: "pane" } })));
    await page.waitForTimeout(400);
    await expect(frame.locator("#changes")).toHaveText("changes: 1");
});

test("a big save goes through (the helper encodes in pieces)", async ({ page }) => {
    const { calls, frame } = await drawApp(page, ANSWERS);
    await expect(frame.locator("#info")).toHaveText(/commands on/);
    await frame.getByRole("button", { name: "Save a big note" }).click();
    await expect(frame.locator("#out")).toHaveText("saved big");
    const write = calls.filter((c) => c.call.op === "write").at(-1);
    expect(Buffer.from(write.call.contentBase64, "base64").length).toBe(300000);
});

test("a download the page starts by itself is refused; a folder downloads as .zip", async ({ page }) => {
    const { frame } = await drawApp(page, ANSWERS);
    await expect(frame.locator("body")).toHaveAttribute("data-unasked", "NOT_ALLOWED");
    const [zip] = await Promise.all([page.waitForEvent("download"), frame.getByRole("button", { name: "Download the folder" }).click()]);
    expect(zip.suggestedFilename()).toBe("docs.zip");
    await expect(frame.locator("#out")).toHaveText("downloaded docs.zip");
});

test("a canvas whose manifest the server refuses says why, outside the page", async ({ page }) => {
    const reason = 'command "history": run[1] must be a git subcommand canvas apps may use';
    await drawApp(page, (call) => (call.op === "info" || call.op === "watch"
        ? { status: 403, error: { code: "CANVAS_WS_UNDECLARED", message: `this canvas app's manifest is broken, so it has no workspace access: ${reason}` } }
        : ANSWERS(call)));
    const notice = page.getByRole("status").filter({ hasText: "its manifest is broken" });
    await expect(notice).toContainText(reason);
    await expect(notice).toContainText("Ask the agent to draw it again.");
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await expect(notice).toHaveCount(0);
});

test("a canvas link opens a new tab; a page the canvas moves to gets nothing from the session", async ({ page }) => {
    // The other page asks the bridge for the session's folders once it has loaded.
    await page.context().route("https://thirdparty.example/**", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><body><p id="away">away</p><script>
        addEventListener("message", (e) => { if (e.data && e.data.type === "canvas-ws-result") document.body.dataset.answer = JSON.stringify(e.data); });
        addEventListener("load", () => setTimeout(() => {
            if (parent !== window) parent.postMessage({ type: "canvas-ws", id: "stolen", op: "info" }, "*");
            setTimeout(() => { document.body.dataset.done = "yes"; }, 1200);
        }, 300));
    </script></body>` }));
    const linking = APP.replace('<pre id="out"></pre>', '<pre id="out"></pre><a id="leave" href="https://thirdparty.example/away.html">docs</a><button id="go" type="button" onclick="location.href=\'https://thirdparty.example/moved.html\'">Move</button>');
    const { calls, frame } = await drawApp(page, ANSWERS, linking);
    await expect(frame.locator("#info")).toHaveText(/commands on/);

    // A plain link: a new tab, the canvas stays.
    const [popup] = await Promise.all([page.waitForEvent("popup"), frame.locator("#leave").click()]);
    await expect(popup).toHaveURL("https://thirdparty.example/away.html");
    await popup.close();
    await expect(frame.locator("#info")).toHaveText(/commands on/);

    // The page moves itself: what loads in the frame is not the canvas.
    const before = calls.length;
    await frame.locator("#go").click();
    await expect(frame.locator("body")).toHaveAttribute("data-done", "yes");
    await expect(frame.locator("body")).not.toHaveAttribute("data-answer", /./);
    expect(calls.slice(before).filter((c) => c.call.op === "info"), "the server never heard from that page").toEqual([]);
    const notice = page.getByRole("status").filter({ hasText: "opened another page here" });
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "Show the canvas again" }).click();
    await expect(frame.locator("#info")).toHaveText(/commands on/);
});
