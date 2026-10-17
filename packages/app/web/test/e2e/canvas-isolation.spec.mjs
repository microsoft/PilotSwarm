// Canvas app registry (issue 181): the browser proof for the isolated frame
// (decision 5) on every surface that frames another user's app — the session
// canvas, the share-link viewer and the Files preview of canvas files.
//
//   1. zero requests: the page's fetch, image, stylesheet, form, window and
//      self-navigation never reach a local probe; a positive control (an
//      agent page on the session canvas) does reach it, so the probe works;
//   2. the wrapper's own document holds none of the page's bytes, and page
//      text that tries to break out of an attribute or a tag runs nowhere
//      but in the inner frame;
//   3. a link the page asks to open by itself is ignored; a real click asks
//      the person first;
//   4. KV and canvas-ws calls still work through the wrapper.
//
// That a replaced inner page gets nothing more, and the relay's port and
// result filtering, are tested on the wrapper's own script in
// web/test/canvas-isolation.test.mjs; this file proves what only a browser
// can: that the policy really refuses the network and self-navigation.
//
// The server is a fake that records what it was asked; the probe is a
// route that counts requests. A request the browser refuses never reaches
// the route.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sessionId = "11111110-2222-3333-4444-555555555550";
const PROBE = "https://probe.example";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const MARKER = "APP-BYTES-MARKER-7f3a";
const BREAKOUT = `"></iframe><script>parent.document.title='broken-out'</script><iframe src="x`;

/** A page that tries every way out once it has loaded (or on demand). */
function hostilePage({ auto = true } = {}) {
    return `<!doctype html>
<!-- CANVAS-APP-MANIFEST {"name":"bobs-board","description":"Use when testing isolation.","interface":{"keys":[],"requests":[],"events":[]},"workspace":{"read":["work/**"]}} -->
<html><head><title>${MARKER}</title></head><body>
<p id="marker">${MARKER}</p>
<div id="breakout">${BREAKOUT}</div>
<a id="link" href="${PROBE}/clicked">open docs</a>
<form id="form" action="${PROBE}/form" method="post"><input name="a" value="1"></form>
<pre id="out"></pre>
<script>
function tryAll() {
  try { fetch("${PROBE}/fetch").catch(() => {}); } catch (e) {}
  try { new Image().src = "${PROBE}/img"; } catch (e) {}
  try { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "${PROBE}/css"; document.head.appendChild(l); } catch (e) {}
  try { navigator.sendBeacon && navigator.sendBeacon("${PROBE}/beacon", "x"); } catch (e) {}
  try { window.open("${PROBE}/open"); } catch (e) {}
  try { document.getElementById("form").submit(); } catch (e) {}
  try { parent.postMessage({ type: "canvas-open-link", href: "${PROBE}/forged" }, "*"); } catch (e) {}
}
window.addEventListener("message", (e) => { if (e.data && e.data.type === "canvas-ws-result") document.getElementById("out").textContent = "ws " + (e.data.ok ? "ok" : e.data.code); });
${auto ? "setTimeout(tryAll, 200); setTimeout(() => { location.href = '" + PROBE + "/navigated'; }, 600);" : ""}
document.body.dataset.ready = "yes";
</script>
</body></html>`;
}

async function countProbe(context) {
    const hits = [];
    await context.route(`${PROBE}/**`, (route) => { hits.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: "<p>probe</p>" }); });
    return hits;
}

async function drawCanvas(page, { html, trust }) {
    const calls = [];
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return route.fulfill({ json: { ok: true, result: [{ seq: 1, eventType: "session.canvas_updated", data: { slot: 1, rev: 1, sizeBytes: html.length, name: "iso", trust, ...(trust === "cross-owner" ? { app: { name: "bobs-board", version: "1.0.0" } } : {}) } }] } });
        }
        if (url.pathname.includes("/artifacts/") && url.pathname.includes("canvas.html")) {
            return route.fulfill({ contentType: "text/html", body: html });
        }
        if (url.pathname.endsWith(`/management/sessions/${sessionId}/canvas-workspace`)) {
            calls.push(route.request().postDataJSON());
            return route.fulfill({ json: { ok: true, result: { folders: [], read: ["work/**"], write: [], watch: false, commands: {}, commandsEnabled: false } } });
        }
        return route.fallback();
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    const show = page.getByRole("button", { name: "Show canvas", exact: true });
    await show.or(page.getByRole("button", { name: "Hide the canvas", exact: true })).first().waitFor();
    if (await show.isVisible()) await show.click();
    return { calls, outer: page.frameLocator(".ps-side-pane-layer:not(.is-parked) iframe.ps-html-preview-frame:not(.is-staging)") };
}

test("session canvas, another user's app: no request reaches the network, and the page cannot leave", async ({ page, context }) => {
    const hits = await countProbe(context);
    const { outer } = await drawCanvas(page, { html: hostilePage(), trust: "cross-owner" });
    const inner = outer.frameLocator("iframe");
    await expect(inner.locator("#marker")).toHaveText(MARKER);
    await page.waitForTimeout(2000);
    expect(hits, `requests that escaped: ${hits.join(", ")}`).toEqual([]);
    expect(await page.title()).not.toBe("broken-out");
});

test("positive control: an agent's page on the session canvas does reach the probe", async ({ page, context }) => {
    const hits = await countProbe(context);
    const { outer } = await drawCanvas(page, { html: hostilePage(), trust: "agent" });
    await expect(outer.locator("#marker")).toHaveText(MARKER);
    await expect.poll(() => hits.some((u) => u.endsWith("/fetch")), { timeout: 5000 }).toBe(true);
});

test("the wrapper's own document holds none of the page's bytes", async ({ page, context }) => {
    await countProbe(context);
    const { outer } = await drawCanvas(page, { html: hostilePage({ auto: false }), trust: "cross-owner" });
    await expect(outer.frameLocator("iframe").locator("#marker")).toHaveText(MARKER);
    const wrapper = page.frames().find((f) => f.url().startsWith("blob:") && f.childFrames().length === 1);
    expect(wrapper, "the canvas frame is the wrapper with one inner frame").toBeTruthy();
    const wrapperHtml = await wrapper.evaluate(() => document.documentElement.outerHTML.replace(/<iframe[\s\S]*$/i, ""));
    expect(wrapperHtml).not.toContain(MARKER);
    expect(wrapperHtml).toContain("frame-src 'none'");
    expect(await page.title()).not.toBe("broken-out");
});

test("a link the page asks for by itself is ignored; a real click asks the person", async ({ page, context }) => {
    await countProbe(context);
    const dialogs = [];
    page.on("dialog", (dialog) => { dialogs.push(dialog.message()); dialog.dismiss(); });
    const { outer } = await drawCanvas(page, { html: hostilePage({ auto: false }), trust: "cross-owner" });
    const inner = outer.frameLocator("iframe");
    await expect(inner.locator("body")).toHaveAttribute("data-ready", "yes");
    await inner.locator("body").evaluate(() => parent.postMessage({ type: "canvas-open-link", href: "https://probe.example/forged" }, "*"));
    await page.waitForTimeout(500);
    expect(dialogs).toEqual([]);
    await inner.locator("#link").click();
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain(`${PROBE}/clicked`);
});

test("canvas-ws still works through the wrapper", async ({ page, context }) => {
    await countProbe(context);
    const html = hostilePage({ auto: false }).replace("document.body.dataset.ready", `parent.postMessage({ type: "canvas-ws", id: 1, op: "info" }, "*"); document.body.dataset.ready`);
    const { calls, outer } = await drawCanvas(page, { html, trust: "cross-owner" });
    await expect(outer.frameLocator("iframe").locator("#out")).toHaveText("ws ok");
    expect(calls.at(-1)).toMatchObject({ slot: 1, call: { op: "info", rev: 1 } });
});

test("share viewer, another user's app: the same wrapper, and no request reaches the network", async ({ page, context }) => {
    const hits = await countProbe(context);
    const posted = [];
    await page.route("**/api/canvas-share/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/doc")) return route.fulfill({ json: { html: hostilePage(), trust: "cross-owner" } });
        if (url.pathname.endsWith("/live")) return route.fulfill({ json: { live: { seq: 1, payload: { secret: "s1" }, docRev: 1 } } });
        posted.push(url.pathname);
        return route.fulfill({ json: { entries: [] } });
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?canvasShare=tok123`);
    const outer = page.frameLocator("iframe.ps-share-view-frame");
    await expect(outer.frameLocator("iframe").locator("#marker")).toHaveText(MARKER);
    await page.waitForTimeout(2000);
    expect(hits, `requests that escaped: ${hits.join(", ")}`).toEqual([]);
    const wrapper = page.frames().find((f) => f.url().startsWith("blob:") && f.childFrames().length === 1);
    expect(wrapper, "the share frame is the wrapper").toBeTruthy();
});

test("Files preview of a canvas file, full screen, uses the wrapper too", async ({ page, context }) => {
    const hits = await countProbe(context);
    const { outer } = await drawCanvas(page, { html: hostilePage(), trust: "agent" });
    await expect(outer.locator("#marker")).toHaveText(MARKER);
    hits.length = 0;
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}&artifact=canvas.html&view=full`);
    const preview = page.frameLocator("iframe.ps-html-preview-frame:not(.is-staging)").first();
    await expect(preview.frameLocator("iframe").locator("#marker")).toHaveText(MARKER, { timeout: 10_000 });
    await page.waitForTimeout(2000);
    expect(hits, `requests that escaped: ${hits.join(", ")}`).toEqual([]);
});
