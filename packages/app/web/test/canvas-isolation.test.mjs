/**
 * Canvas app registry (issue 181): the one isolated frame contract
 * (ui/react/src/canvas-isolation.js) and its use on every surface that
 * frames a page the portal does not trust.
 *
 * The wrapper's own script is executed here against a fake window, so the
 * relay rules are tested as behaviour: one inner frame; a page cannot forge
 * wrapper-protocol messages; a second inner load ends the relay for good and
 * tells the portal. That the browser actually refuses the inner frame's
 * network and navigation under the wrapper policy is NOT claimed here — it is
 * the job of the browser proof (e2e).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
    CROSS_OWNER_APP_CSP, CROSS_OWNER_WRAPPER_CSP, CROSS_OWNER_WRAPPER_HTML, crossOwnerWrapperHtml,
    CANVAS_WS_UPGRADE_CODE, CANVAS_WS_UPGRADE_ERROR, CANVAS_DOCUMENT_UPGRADE_CODE, CANVAS_DOCUMENT_UPGRADE_ERROR,
    assertPageBytes, buildIsolatedInnerHtml, injectAfterDoctype, isCanvasSlotFilename, isWrapperControlMessage, sha256HexOfBytes,
} from "../../ui/react/src/canvas-isolation.js";
import { createHash } from "node:crypto";

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Run the wrapper's script against a fake window; returns handles to drive it. */
function bootWrapper(html = CROSS_OWNER_WRAPPER_HTML) {
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
    const listeners = [];
    const toParent = [];
    const transfers = [];
    const parent = { postMessage: (m, _origin, transfer) => { toParent.push(m); transfers.push(transfer ?? null); } };
    let inner = null;
    const document = {
        createElement: () => {
            const loadListeners = [];
            const received = [];
            inner = {
                attrs: {}, srcdoc: null, removed: false, received,
                contentWindow: { postMessage: (m) => received.push(m) },
                setAttribute(k, v) { this.attrs[k] = v; },
                addEventListener(type, fn) { if (type === "load") loadListeners.push(fn); },
                remove() { this.removed = true; },
                fireLoad() { loadListeners.forEach((fn) => fn()); },
            };
            return inner;
        },
        body: { appendChild: () => {} },
    };
    const run = new Function("addEventListener", "parent", "document", script);
    run((type, fn) => { if (type === "message") listeners.push(fn); }, parent, document);
    const dispatch = (source, data, ports) => listeners.forEach((fn) => fn({ source, data, ports }));
    return { parent, toParent, transfers, dispatch, inner: () => inner };
}

test("the wrapper document carries no app bytes and refuses frames; the inner policy has no network", () => {
    assert.match(CROSS_OWNER_WRAPPER_CSP, /frame-src 'none'/);
    assert.ok(CROSS_OWNER_WRAPPER_HTML.includes(`content="${CROSS_OWNER_WRAPPER_CSP}"`));
    for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"]) {
        assert.ok(CROSS_OWNER_APP_CSP.includes(directive), directive);
    }
    const inner = buildIsolatedInnerHtml("<!doctype html><html><head><title>x</title></head><body>app</body></html>");
    assert.match(inner, /^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
    assert.ok(inner.indexOf("Content-Security-Policy") < inner.indexOf("<title>"), "the policy comes before anything the page declares");
    assert.equal(injectAfterDoctype("<p>no doctype</p>", "X"), "X<p>no doctype</p>");
});

test("the wrapper makes one inner frame from the portal's text, set as srcdoc, sandboxed", () => {
    const w = bootWrapper();
    assert.deepEqual(w.toParent, [{ type: "pse-wrapper-ready" }]);
    w.dispatch({}, { type: "pse-wrapper-load", html: "<p>forged</p>" });
    assert.equal(w.inner(), null, "a load request from anyone but the parent is ignored");
    w.dispatch(w.parent, { type: "pse-wrapper-load", html: "<p>app</p>" });
    const inner = w.inner();
    assert.equal(inner.srcdoc, "<p>app</p>");
    assert.equal(inner.attrs.sandbox, "allow-scripts");
    w.dispatch(w.parent, { type: "pse-wrapper-load", html: "<p>second</p>" });
    assert.equal(w.inner(), inner, "only one inner frame, ever");
});

test("relay: page <-> portal only; a page cannot forge wrapper-protocol messages either way", () => {
    const w = bootWrapper();
    w.dispatch(w.parent, { type: "pse-wrapper-load", html: "<p>app</p>" });
    const inner = w.inner();
    inner.fireLoad();
    w.dispatch(inner.contentWindow, { type: "canvas-kv", op: "list" });
    w.dispatch(inner.contentWindow, { type: "pse-wrapper-left" });
    w.dispatch(inner.contentWindow, { type: "pse-wrapper-ready" });
    assert.deepEqual(w.toParent.slice(1), [{ type: "canvas-kv", op: "list" }], "forged wrapper messages from the page are dropped");
    w.dispatch(w.parent, { type: "canvas-data", data: { a: 1 } });
    w.dispatch(w.parent, { type: "pse-wrapper-load", html: "<p>again</p>" });
    w.dispatch({}, { type: "canvas-data", data: { stranger: true } });
    assert.deepEqual(inner.received, [{ type: "canvas-data", data: { a: 1 } }], "only the parent's non-protocol messages reach the page");
});

test("a second inner load ends the relay for good and tells the portal", () => {
    const w = bootWrapper();
    w.dispatch(w.parent, { type: "pse-wrapper-load", html: "<p>app</p>" });
    const inner = w.inner();
    inner.fireLoad();
    inner.fireLoad();
    assert.equal(inner.removed, true);
    assert.deepEqual(w.toParent.at(-1), { type: "pse-wrapper-left" });
    const before = w.toParent.length;
    w.dispatch(inner.contentWindow, { type: "canvas-kv", op: "put" });
    w.dispatch(w.parent, { type: "canvas-data", data: { secret: 1 } });
    assert.equal(w.toParent.length, before, "nothing from the replaced page reaches the portal");
    assert.deepEqual(inner.received, [], "nothing from the portal reaches it");
});

test("helpers: wrapper control messages and canvas slot files", () => {
    assert.equal(isWrapperControlMessage({ type: "pse-wrapper-left" }), true);
    assert.equal(isWrapperControlMessage({ type: "canvas-kv" }), false);
    for (const name of ["canvas.html", "canvas2.html", "canvas5.html", "CANVAS.HTML"]) assert.equal(isCanvasSlotFilename(name), true, name);
    for (const name of ["canvas6.html", "canvas1.html", "app-x.html", "canvas.htm", "my-canvas.html"]) assert.equal(isCanvasSlotFilename(name), false, name);
});

test("every surface that frames an untrusted page uses the one contract, never a policy tag alone", () => {
    const WEB_APP = read("../../ui/react/src/web-app.js");
    const APP = read("../src/App.jsx");
    // No surface builds its own policy text any more.
    assert.doesNotMatch(WEB_APP, /http-equiv="Content-Security-Policy"/);
    assert.doesNotMatch(APP, /http-equiv="Content-Security-Policy"/);
    // Session canvas: cross-owner revisions go through the wrapper.
    assert.match(WEB_APP, /crossOwner\s*\?\s*fetchCrossOwnerCanvas\(/);
    assert.match(WEB_APP, /function fetchCrossOwnerCanvas[\s\S]*?createIsolationWrapperUrl\(\)[\s\S]*?buildIsolatedInnerHtml\(/);
    assert.match(WEB_APP, /payload\.type === "pse-wrapper-left"/, "the canvas stops relaying when the wrapper reports its page replaced");
    // Files preview: canvas slot files always go through the wrapper.
    assert.match(WEB_APP, /const isolated = isCanvasSlotFilename\(filename\)/);
    assert.match(WEB_APP, /isolated\s*\?\s*fetchCrossOwnerCanvas\(controller, sessionId, filename\)/);
    assert.match(WEB_APP, /sandbox: isolated \? "allow-scripts" :/);
    // Share viewer: another user's app goes through the wrapper; relay is anchored.
    const share = APP.slice(APP.indexOf("function CanvasShareView"), APP.indexOf("export default function App"));
    assert.match(share, /doc\?\.trust === "cross-owner"[\s\S]*?createIsolationWrapperUrl\(\)[\s\S]*?buildIsolatedInnerHtml\(html\)/);
    assert.match(share, /payload\.type === "pse-wrapper-left"/);
    assert.match(share, /if \(el\.dataset\.loaded\) \{ el\.dataset\.leftPage = "1"/, "a second load is a page that left");
    assert.match(share, /const frame = currentFrame\(\);[\s\S]*?postMessage\(\{ type: "canvas-kv-change"/, "KV changes go to the frame current at delivery time");
    assert.doesNotMatch(share, /iframeRef\.current\?\.contentWindow\?\.postMessage/, "no post to a frame without the current-frame check");
});

test("a canvas is framed only with the bytes its draw event classified", async () => {
    const bytes = new TextEncoder().encode("<p>rev 3</p>").buffer;
    const sha = createHash("sha256").update("<p>rev 3</p>").digest("hex");
    assert.equal(await sha256HexOfBytes(bytes), sha);
    await assertPageBytes(bytes, sha);
    await assertPageBytes(bytes, null); // an old event without a hash: nothing to compare
    await assert.rejects(assertPageBytes(new TextEncoder().encode("<p>rev 4</p>").buffer, sha), /being redrawn/);
    const WEB_APP = read("../../ui/react/src/web-app.js");
    assert.match(WEB_APP, /fetchCrossOwnerCanvas\(controller, sessionId, filename, panelKeys, pageSha256\)/);
    assert.match(WEB_APP, /fetchArtifactHtmlObjectUrl\(controller, sessionId, filename, panelKeys, true, pageSha256\)/);
    const RUNTIME = read("../runtime.js");
    assert.match(RUNTIME, /createHash\("sha256"\)\.update\(body\)\.digest\("hex"\) !== recorded\) trust = "cross-owner"/, "the share door isolates bytes the event did not classify");
});

function fakePort(name) {
    return { name, closed: false, close() { this.closed = true; } };
}

test("a request port from the page reaches the portal unchanged; every other port is closed (issue 184 contract)", () => {
    const w = bootWrapper();
    const forged = fakePort("on-load");
    w.dispatch(w.parent, { type: "pse-wrapper-load", html: "<p>app</p>" }, [forged]);
    assert.equal(forged.closed, true, "ports never ride the load message");
    const inner = w.inner();
    inner.fireLoad();
    const reply = fakePort("reply");
    w.dispatch(inner.contentWindow, { type: "canvas-ws", op: "info" }, [reply]);
    assert.deepEqual(w.toParent.at(-1), { type: "canvas-ws", op: "info" });
    assert.deepEqual(w.transfers.at(-1), [reply], "the same port object, in the transfer list");
    assert.equal(reply.closed, false);
    const spoof = fakePort("spoof");
    w.dispatch(inner.contentWindow, { type: "pse-wrapper-left" }, [spoof]);
    assert.equal(spoof.closed, true, "a forged protocol message's port is closed");
    const stranger = fakePort("stranger");
    w.dispatch({}, { type: "canvas-ws", op: "read" }, [stranger]);
    assert.equal(stranger.closed, true, "a port from anyone but the inner frame is closed");
    const fromPortal = fakePort("portal");
    w.dispatch(w.parent, { type: "canvas-data", data: {} }, [fromPortal]);
    assert.equal(fromPortal.closed, true, "the wrapper never hands portal ports to the page");
    inner.fireLoad();
    const late = fakePort("late");
    w.dispatch(inner.contentWindow, { type: "canvas-ws", op: "read" }, [late]);
    assert.equal(late.closed, true, "after the page was replaced, ports are closed, not relayed");
});

test("with request ports (issue 184), the only canvas-ws* window message the page gets is the fixed upgrade diagnostic", () => {
    const w = bootWrapper(crossOwnerWrapperHtml({ workspaceResults: "upgrade-only" }));
    w.dispatch(w.parent, { type: "pse-wrapper-load", html: "<p>app</p>" });
    const inner = w.inner();
    inner.fireLoad();
    // The exact text issue 184's host sends (rejectLegacyCanvasWorkspaceRequest).
    assert.equal(CANVAS_WS_UPGRADE_ERROR, "Update this canvas workspace helper before using files or commands.");
    const upgrade = { type: "canvas-ws-result", id: 7, ok: false, code: CANVAS_WS_UPGRADE_CODE, error: CANVAS_WS_UPGRADE_ERROR };
    const upgradeNoId = { ...upgrade, id: null };
    const tick = { type: "canvas-data", data: { a: 1 } };
    const action = { type: "canvas-kv-changed", key: "app/x", value: 1 };
    w.dispatch(w.parent, upgrade);
    // Every other canvas-ws* window message is dropped, whatever its type.
    for (const dropped of [
        { type: "canvas-ws-result", id: 8, ok: true, result: { text: "secret" } },
        { type: "canvas-ws-result", id: 9, ok: false, code: "CANVAS_WS_DENIED", error: "may not read work/.env" },
        { ...upgrade, extra: "leak" },
        { ...upgrade, error: "Update this canvas workspace helper: work/.env" },
        { ...upgrade, id: 0 },
        { ...upgrade, id: -3 },
        { ...upgrade, id: 1.5 },
        { ...upgrade, id: "7" },
        { ...upgrade, type: "canvas-ws-v2-result" },
        { type: "canvas-ws-v2", version: 2, id: 3, ok: true, result: { text: "secret" } },
        { type: "canvas-ws-dispose", id: 3 },
        { type: "canvas-ws-watch", path: "work/a" },
        { type: "canvas-ws", id: 4, op: "read" },
    ]) w.dispatch(w.parent, dropped);
    w.dispatch(w.parent, upgradeNoId);
    w.dispatch(w.parent, tick);
    w.dispatch(w.parent, action);
    assert.deepEqual(inner.received, [upgrade, upgradeNoId, tick, action], "the fixed diagnostic and non-workspace messages only");
    // Requests from the page are never filtered: v2 requests and disposals
    // reach the portal unchanged with the exact ports they came with.
    const reqPort = fakePort("v2");
    const v2 = { type: "canvas-ws-v2", version: 2, documentToken: "t", id: 5, op: "read", path: "work/a" };
    w.dispatch(inner.contentWindow, v2, [reqPort]);
    assert.deepEqual(w.toParent.at(-1), v2);
    assert.deepEqual(w.transfers.at(-1), [reqPort]);
    assert.equal(reqPort.closed, false);
    const disposePort = fakePort("dispose");
    const dispose = { type: "canvas-ws-dispose", version: 2, documentToken: "t", id: 6, target: 5 };
    w.dispatch(inner.contentWindow, dispose, [disposePort]);
    assert.deepEqual(w.toParent.at(-1), dispose);
    assert.deepEqual(w.transfers.at(-1), [disposePort]);
    // In the 181-only default the portal's window replies still pass.
    const legacy = bootWrapper();
    legacy.dispatch(legacy.parent, { type: "pse-wrapper-load", html: "<p>app</p>" });
    legacy.inner().fireLoad();
    legacy.dispatch(legacy.parent, { type: "canvas-ws-result", id: 1, ok: true, result: {} });
    assert.equal(legacy.inner().received.length, 1);
});

test("ports-only (composed issue 184 host): no portal window message reaches the page but the three exact upgrade diagnostics", () => {
    const w = bootWrapper(crossOwnerWrapperHtml({ workspaceResults: "ports-only" }));
    w.dispatch(w.parent, { type: "pse-wrapper-load", html: "<p>app</p>" });
    const inner = w.inner();
    inner.fireLoad();
    const upgrade = { type: "canvas-ws-result", id: 7, ok: false, code: CANVAS_WS_UPGRADE_CODE, error: CANVAS_WS_UPGRADE_ERROR };
    const upgradeNoId = { ...upgrade, id: null };
    // The exact constants issue 184's canvas-document-channels.js sends.
    assert.equal(CANVAS_DOCUMENT_UPGRADE_CODE, "CANVAS_DOCUMENT_UPGRADE_REQUIRED");
    assert.equal(CANVAS_DOCUMENT_UPGRADE_ERROR, "Update this canvas helper before using session features.");
    const kvUpgrade = { type: "canvas-kv-result", id: 8, ok: false, code: CANVAS_DOCUMENT_UPGRADE_CODE, error: CANVAS_DOCUMENT_UPGRADE_ERROR };
    const actionUpgrade = { ...kvUpgrade, type: "canvas-action-result", id: null };
    // Every content-bearing message the host posts today (web-app.js, App.jsx),
    // diagnostic look-alikes, and types nobody has invented yet: all dropped,
    // and every port that came with them closed.
    const dropped = [
        { type: "canvas-kv-ready", id: 1, ok: true, keys: ["app/x"] },
        { type: "canvas-kv-result", id: 2, ok: true, entry: { key: "app/x", v: "secret" } },
        { type: "canvas-kv-change", key: "app/x", rev: 3, op: "put", v: "secret", by: "dev:alice" },
        { type: "canvas-ws-result", id: 4, ok: true, result: { text: "secret" } },
        { type: "canvas-ws-result", id: 5, ok: false, code: "CANVAS_WS_DENIED", error: "may not read work/.env" },
        { type: "canvas-ws-change", reason: "approved" },
        { type: "canvas-data", data: { secret: 1 }, dataRev: 2 },
        { type: "canvas-patch", patch: { secret: 2 }, dataRev: 3 },
        { type: "canvas-action-result", id: 6, ok: true },
        { type: "canvas-feed-v2", seq: 1, data: { secret: 3 } },
        { type: "moa-theme", theme: "dark" },
        { type: 42 },
        { noType: true },
        { ...upgrade, extra: "leak" },
        { ...upgrade, error: "Update this canvas workspace helper: work/.env" },
        { ...upgrade, ok: true },
        { ...upgrade, id: 0 },
        { ...upgrade, id: "7" },
        { ...upgrade, type: "canvas-kv-result" },
        { ...upgrade, id: -3 },
        { ...upgrade, id: 1.5 },
        { ...upgrade, id: Infinity },
        { ...upgrade, id: NaN },
        { ...upgrade, id: 2 ** 53 },
        { ...kvUpgrade, extra: "leak" },
        { ...kvUpgrade, code: CANVAS_WS_UPGRADE_CODE },
        { ...kvUpgrade, error: "Update this canvas helper: app/secret" },
        { ...kvUpgrade, ok: true },
        { ...kvUpgrade, id: "8" },
        { ...kvUpgrade, id: 0 },
        { ...kvUpgrade, type: "canvas-kv-change" },
        { ...actionUpgrade, type: "canvas-feed-v2" },
        { ...actionUpgrade, type: "canvas-document-v2" },
        { ...actionUpgrade, code: "CANVAS_ACTION_DENIED" },
    ];
    const ports = [];
    for (const message of dropped) {
        const port = fakePort(String(message.type));
        ports.push(port);
        w.dispatch(w.parent, message, [port]);
    }
    const allowed = [upgrade, upgradeNoId, kvUpgrade, actionUpgrade];
    const allowedPorts = allowed.map((m) => fakePort(`allowed-${m.type}`));
    allowed.forEach((m, i) => w.dispatch(w.parent, m, [allowedPorts[i]]));
    assert.deepEqual(inner.received, allowed, "only the three exact diagnostics, nothing else");
    assert.ok(ports.every((p) => p.closed), "every port the portal sent is closed");
    assert.ok(allowedPorts.every((p) => p.closed), "ports are closed even when the diagnostic itself is forwarded");
    // The page's own requests still reach the portal with their exact ports.
    const reqPort = fakePort("kv-v2");
    const request = { type: "canvas-kv-v2", version: 2, documentToken: "t", id: 9, op: "get", key: "app/x" };
    w.dispatch(inner.contentWindow, request, [reqPort]);
    assert.deepEqual(w.toParent.at(-1), request);
    assert.deepEqual(w.transfers.at(-1), [reqPort]);
    assert.equal(reqPort.closed, false);
    // After the page was replaced, not even the diagnostic gets through.
    inner.fireLoad();
    assert.deepEqual(w.toParent.at(-1), { type: "pse-wrapper-left" });
    const late = fakePort("late");
    w.dispatch(w.parent, upgrade, [late]);
    assert.equal(inner.received.length, allowed.length);
    assert.equal(late.closed, true);
});

test("the three wrapper modes differ only in what the portal may post down", () => {
    const relay = bootWrapper(crossOwnerWrapperHtml());
    const upgradeOnly = bootWrapper(crossOwnerWrapperHtml({ workspaceResults: "upgrade-only" }));
    const portsOnly = bootWrapper(crossOwnerWrapperHtml({ workspaceResults: "ports-only" }));
    assert.equal(crossOwnerWrapperHtml(), CROSS_OWNER_WRAPPER_HTML);
    const tick = { type: "canvas-data", data: { a: 1 }, dataRev: 1 };
    const wsReply = { type: "canvas-ws-result", id: 1, ok: true, result: {} };
    const received = [];
    for (const w of [relay, upgradeOnly, portsOnly]) {
        w.dispatch(w.parent, { type: "pse-wrapper-load", html: "<p>app</p>" });
        w.inner().fireLoad();
        w.dispatch(w.parent, tick);
        w.dispatch(w.parent, wsReply);
        received.push(w.inner().received.map((m) => m.type));
    }
    assert.deepEqual(received, [["canvas-data", "canvas-ws-result"], ["canvas-data"], []]);
});

test("a trusted bootstrap goes after the policy and before the page", () => {
    const html = buildIsolatedInnerHtml("<!doctype html><head><script>page()</script></head>", { bootstrap: "<script>bootstrap()</script>" });
    assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("bootstrap()"));
    assert.ok(html.indexOf("bootstrap()") < html.indexOf("page()"));
    assert.ok(!buildIsolatedInnerHtml("<p>x</p>").includes("bootstrap"), "nothing is injected without one");
});
