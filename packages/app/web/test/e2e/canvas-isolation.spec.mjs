// Canvas app registry (issue 181): the browser proof for the isolated frame
// (decision 5) on every surface that frames another user's app — the session
// canvas, the share-link viewer and the Files preview of canvas files.
//
//   1. zero requests: the page's fetch, image, stylesheet, beacon, window,
//      form and self-navigation (href, replace, meta refresh) never reach a
//      local probe; a positive control (an agent page on the session canvas)
//      reaches it with two kinds of request, so the probe counts;
//   2. the wrapper's own document holds none of the page's bytes, and page
//      text that tries to break out of a tag runs only inside the inner
//      frame, where it cannot touch the portal;
//   3. a link the page asks to open by itself is ignored; a real click asks
//      the person first;
//   4. canvas-ws calls still work through the wrapper.
//
// Every case first proves the page's own script RAN and made every attempt
// (data-ready, data-tried) before it asserts that nothing got out: a page
// that never ran proves nothing. (Attempt 2 at d1ce4172 failed exactly that
// way: an unclosed tag in the old fixture swallowed the page's script.)
//
// That a replaced inner page gets nothing more, and the relay's port and
// result filtering, are tested on the wrapper's own script in
// web/test/canvas-isolation.test.mjs. Not covered here: a pinned MoA panel
// (needs a MoA fixture this file does not have; the trust-from-state path it
// relies on is unit-tested) and inner-reload detection (leftPage).
//
// The server is a fake that records what it was asked; the probe is a
// route that counts requests. A request the browser refuses never reaches
// the route.
import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sessionId = "11111110-2222-3333-4444-555555555550";
const PROBE = "https://probe.example";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const MARKER = "APP-BYTES-MARKER-7f3a";
// Text that would break out of an attribute or a tag if the page's bytes were
// ever placed in the wrapper's markup. It stays the LAST thing in the body:
// its unclosed tag swallows whatever follows it.
const BREAKOUT = `"></iframe><script>try{top.document.title='broken-out';document.body.dataset.breakout='escaped'}catch(e){document.body.dataset.breakout='contained'}</script><iframe src="x`;
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * A page that tries every way out. The script is in <head>, so it is parsed
 * before any body markup. `auto`: make every attempt that does not leave the
 * page on load, then set data-tried; the self-navigations (form, meta
 * refresh, location.replace, location.href) run in the page when the test
 * calls window.navigateAll() after it has seen data-tried. `ws`: send one
 * canvas-ws call once ready.
 */
function hostilePage({ auto = true, ws = false } = {}) {
    return `<!doctype html>
<!-- CANVAS-APP-MANIFEST {"name":"bobs-board","description":"Use when testing isolation.","interface":{"keys":[],"requests":[],"events":[]},"workspace":{"read":["work/**"]}} -->
<html><head><title>${MARKER}</title>
<script>
function tryAll() {
  try { fetch("${PROBE}/fetch").catch(function () {}); } catch (e) {}
  try { new Image().src = "${PROBE}/img"; } catch (e) {}
  try { var l = document.createElement("link"); l.rel = "stylesheet"; l.href = "${PROBE}/css"; document.head.appendChild(l); } catch (e) {}
  try { navigator.sendBeacon && navigator.sendBeacon("${PROBE}/beacon", "x"); } catch (e) {}
  try { window.open("${PROBE}/open"); } catch (e) {}
  try { parent.postMessage({ type: "canvas-open-link", href: "${PROBE}/forged" }, "*"); } catch (e) {}
  document.body.dataset.tried = "yes";
}
// The ways out that leave the page, run only once the test has seen
// data-tried (so a page that left cannot hide that it never tried).
window.navigateAll = function () {
  setTimeout(function () { try { document.getElementById("form").submit(); } catch (e) {} }, 0);
  setTimeout(function () { try { var m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=${PROBE}/refresh"; document.head.appendChild(m); } catch (e) {} }, 300);
  setTimeout(function () { try { location.replace("${PROBE}/replaced"); } catch (e) {} }, 600);
  setTimeout(function () { try { location.href = "${PROBE}/navigated"; } catch (e) {} }, 900);
  return true;
};
window.addEventListener("message", function (e) { if (e.data && e.data.type === "canvas-ws-result") document.getElementById("out").textContent = "ws " + (e.data.ok ? "ok" : e.data.code); });
document.addEventListener("DOMContentLoaded", function () {
  document.body.dataset.ready = "yes";
  ${ws ? 'parent.postMessage({ type: "canvas-ws", id: 1, op: "info" }, "*");' : ""}
  ${auto ? "setTimeout(tryAll, 200);" : ""}
});
</script>
</head><body>
<p id="marker">${MARKER}</p>
<a id="link" href="${PROBE}/clicked">open docs</a>
<form id="form" action="${PROBE}/form" method="post"><input name="a" value="1"></form>
<pre id="out"></pre>
<div id="breakout">${BREAKOUT}`;
}

async function countProbe(context) {
    const hits = [];
    await context.route(`${PROBE}/**`, (route) => { hits.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: "<p>probe</p>" }); });
    return hits;
}

/** The fake server's answers for one drawn canvas; `pageSha256` defaults to the served bytes. */
async function drawCanvas(page, { html, trust, pageSha256 = sha256(html) }) {
    const calls = [];
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return route.fulfill({ json: { ok: true, result: [{ seq: 1, eventType: "session.canvas_updated", data: { slot: 1, rev: 1, sizeBytes: html.length, name: "iso", trust, pageSha256, ...(trust === "cross-owner" ? { app: { name: "bobs-board", version: "1.0.0" } } : {}) } }] } });
        }
        // Raw page bytes only at the download path; JSON operations on the
        // same file fall through to the fake server (or a test's own route).
        if (url.pathname.endsWith("/artifacts/canvas.html/download")) {
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

/** Run the page's own self-navigations (in the page, without a user gesture). */
async function navigateAll(doc) {
    expect(await doc.locator("body").evaluate(() => window.navigateAll())).toBe(true);
}

/** The page ran its own script and made every attempt; its breakout script ran and was contained. */
async function expectRanAndTried(doc, { tried = true } = {}) {
    await expect(doc.locator("#marker")).toHaveText(MARKER);
    await expect(doc.locator("body")).toHaveAttribute("data-ready", "yes");
    await expect(doc.locator("body")).toHaveAttribute("data-breakout", "contained");
    if (tried) await expect(doc.locator("body")).toHaveAttribute("data-tried", "yes");
}

test("session canvas, another user's app: the page tries every way out and no request reaches the network", async ({ page, context }) => {
    const hits = await countProbe(context);
    const { outer } = await drawCanvas(page, { html: hostilePage(), trust: "cross-owner" });
    const inner = outer.frameLocator("iframe");
    await expectRanAndTried(inner);
    await navigateAll(inner);
    await page.waitForTimeout(2500);
    expect(hits, `requests that escaped: ${hits.join(", ")}`).toEqual([]);
    expect(await page.title()).not.toBe("broken-out");
});

test("positive control: an agent's page on the session canvas does reach the probe, with two kinds of request", async ({ page, context }) => {
    const hits = await countProbe(context);
    const { outer } = await drawCanvas(page, { html: hostilePage(), trust: "agent" });
    await expectRanAndTried(outer);
    await expect.poll(() => hits.some((u) => u.endsWith("/fetch")), { timeout: 5000 }).toBe(true);
    await expect.poll(() => hits.some((u) => u.endsWith("/img")), { timeout: 5000 }).toBe(true);
});

test("the wrapper's own document holds none of the page's bytes", async ({ page, context }) => {
    await countProbe(context);
    const { outer } = await drawCanvas(page, { html: hostilePage({ auto: false }), trust: "cross-owner" });
    await expectRanAndTried(outer.frameLocator("iframe"), { tried: false });
    const wrapper = page.frames().find((f) => f.url().startsWith("blob:") && f.childFrames().length === 1);
    expect(wrapper, "the canvas frame is the wrapper with one inner frame").toBeTruthy();
    const wrapperHtml = await wrapper.evaluate(() => document.documentElement.outerHTML.replace(/<iframe[\s\S]*$/i, ""));
    expect(wrapperHtml).not.toContain(MARKER);
    expect(wrapperHtml).toContain("frame-src 'none'");
    expect(await page.title()).not.toBe("broken-out");
});

test("a page whose bytes differ from the drawn revision is not framed", async ({ page, context }) => {
    const hits = await countProbe(context);
    const { outer } = await drawCanvas(page, { html: hostilePage(), trust: "cross-owner", pageSha256: sha256("some other page") });
    await page.waitForTimeout(3000);
    expect(await outer.frameLocator("iframe").locator("#marker").count()).toBe(0);
    expect(await outer.locator("#marker").count()).toBe(0);
    expect(hits, `requests that escaped: ${hits.join(", ")}`).toEqual([]);
});

test("a link the page asks for by itself is ignored; a real click asks the person", async ({ page, context }) => {
    await countProbe(context);
    const dialogs = [];
    page.on("dialog", (dialog) => { dialogs.push(dialog.message()); dialog.dismiss(); });
    const { outer } = await drawCanvas(page, { html: hostilePage({ auto: false }), trust: "cross-owner" });
    const inner = outer.frameLocator("iframe");
    await expectRanAndTried(inner, { tried: false });
    await inner.locator("body").evaluate(() => parent.postMessage({ type: "canvas-open-link", href: "https://probe.example/forged" }, "*"));
    await page.waitForTimeout(500);
    expect(dialogs).toEqual([]);
    await inner.locator("#link").click();
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain(`${PROBE}/clicked`);
});

test("canvas-ws still works through the wrapper", async ({ page, context }) => {
    await countProbe(context);
    const { calls, outer } = await drawCanvas(page, { html: hostilePage({ auto: false, ws: true }), trust: "cross-owner" });
    const inner = outer.frameLocator("iframe");
    await expectRanAndTried(inner, { tried: false });
    await expect(inner.locator("#out")).toHaveText("ws ok");
    expect(calls.at(-1)).toMatchObject({ slot: 1, call: { op: "info", rev: 1 } });
});

test("share viewer, another user's app: the same wrapper, the page tries every way out, and no request reaches the network", async ({ page, context }) => {
    const hits = await countProbe(context);
    const html = hostilePage();
    await page.route("**/api/canvas-share/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/doc")) return route.fulfill({ json: { html, trust: "cross-owner" } });
        if (url.pathname.endsWith("/live")) return route.fulfill({ json: { live: { seq: 1, payload: { secret: "s1" }, docRev: 1 } } });
        return route.fulfill({ json: { entries: [] } });
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?canvasShare=tok123`);
    const outer = page.frameLocator("iframe.ps-share-view-frame");
    const inner = outer.frameLocator("iframe");
    await expectRanAndTried(inner);
    const wrapper = page.frames().find((f) => f.url().startsWith("blob:") && f.childFrames().length === 1);
    expect(wrapper, "the share frame is the wrapper").toBeTruthy();
    await navigateAll(inner);
    await page.waitForTimeout(2500);
    expect(hits, `requests that escaped: ${hits.join(", ")}`).toEqual([]);
});

test("Files preview of a canvas file, full screen, uses the wrapper too", async ({ page, context }) => {
    const hits = await countProbe(context);
    const html = hostilePage();
    // Drawn as another user's page, so the canvas pane (if it stays mounted
    // after the navigation below) cannot itself reach the probe.
    const { outer } = await drawCanvas(page, { html, trust: "cross-owner" });
    await expectRanAndTried(outer.frameLocator("iframe"));
    // The Files view lists, describes and reads canvas.html as the server
    // would; the raw bytes stay at the download path (drawCanvas).
    const entry = { filename: "canvas.html", contentType: "text/html", sizeBytes: Buffer.byteLength(html), uploadedAt: "2026-10-17T00:00:00.000Z", source: "agent", isBinary: false };
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith(`/sessions/${sessionId}/artifacts`)) return route.fulfill({ json: { ok: true, result: [entry] } });
        if (url.pathname.endsWith("/artifacts/canvas.html/meta")) return route.fulfill({ json: { ok: true, result: entry } });
        if (url.pathname.endsWith("/artifacts/canvas.html/text")) return route.fulfill({ json: { ok: true, result: html } });
        return route.fallback();
    });
    hits.length = 0;
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}&artifact=canvas.html&view=full`);
    await expect(page.getByRole("region", { name: "Artifact: canvas.html" })).toBeVisible({ timeout: 10_000 });
    const preview = page.frameLocator("iframe.ps-html-preview-frame:not(.is-staging)").first();
    const previewInner = preview.frameLocator("iframe");
    await expectRanAndTried(previewInner);
    await navigateAll(previewInner);
    await page.waitForTimeout(2500);
    expect(hits, `requests that escaped: ${hits.join(", ")}`).toEqual([]);
});
