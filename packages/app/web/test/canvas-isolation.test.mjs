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
    assertPageBytes, buildIsolatedInnerHtml, injectAfterDoctype, isCanvasSlotFilename, isWrapperControlMessage, sha256HexJs, sha256HexOfBytes,
    canvasHashRebind, CANVAS_TRUST_HOLD_MS,
} from "../../ui/react/src/canvas-isolation.js";
import { createHash, randomBytes, randomInt } from "node:crypto";

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
    assert.deepEqual(w.toParent.slice(1), [{ type: "pse-wrapper-inner-loaded" }, { type: "canvas-kv", op: "list" }], "forged wrapper messages from the page are dropped");
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
    assert.match(share, /doc\?\.trust !== "owner" && doc\?\.trust !== "agent"[\s\S]*?createIsolationWrapperUrl\(\)[\s\S]*?buildIsolatedInnerHtml\(html\)/, "the share viewer wraps every page not classified owner or agent (fail closed)");
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
    assert.match(RUNTIME, /const bodySha = createHash\("sha256"\)\.update\(body\)\.digest\("hex"\);\s*if \(typeof recorded === "string" && bodySha !== recorded\) trust = "cross-owner"/, "the share door isolates bytes the event did not classify");
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
        // Five enumerable keys are not five own keys: an array carries a
        // non-enumerable length (a sparse one, an arbitrary number), and a
        // symbol or non-enumerable key is an extra own key too.
        Object.assign([], kvUpgrade),
        Object.assign(new Array(1_000_000), upgrade),
        { ...actionUpgrade, [Symbol("extra")]: "leak" },
        Object.defineProperty({ ...upgrade }, "hidden", { value: "leak", enumerable: false }),
    ];
    const ports = [];
    for (const message of dropped) {
        const port = fakePort(typeof message.type === "string" ? message.type : "untyped");
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

// A portal served over http on a host other than localhost is not a secure
// context, so the browser gives it no crypto.subtle. Before the fallback, every
// canvas whose draw event carried a page hash failed to load there.
async function withoutSubtle(fn) {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: (a) => a }, configurable: true, writable: true });
    try {
        assert.equal(globalThis.crypto.subtle, undefined);
        return await fn();
    } finally {
        Object.defineProperty(globalThis, "crypto", original);
    }
}

const nodeSha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("the JS SHA-256 matches the FIPS 180-4 vectors", () => {
    const enc = new TextEncoder();
    assert.equal(sha256HexJs(enc.encode("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256HexJs(enc.encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(sha256HexJs(enc.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    assert.equal(sha256HexJs(new Uint8Array(1_000_000).fill(0x61)), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("the JS SHA-256 equals node:crypto and native WebCrypto at every padding boundary, the 900 KB cap and random inputs", async () => {
    const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1000, 65_537, 900_000];
    for (const length of lengths) {
        const bytes = Uint8Array.from({ length }, (_, i) => (i * 167 + 13) & 0xff);
        const want = nodeSha(bytes);
        assert.equal(sha256HexJs(bytes.buffer), want, `JS from an ArrayBuffer, ${length} bytes`);
        assert.equal(sha256HexJs(bytes), want, `JS from a Uint8Array, ${length} bytes`);
        const native = await sha256HexOfBytes(bytes.buffer);
        assert.match(native, /^[0-9a-f]{64}$/);
        assert.equal(native, want, `native WebCrypto, ${length} bytes`);
    }
    let seed = 0x181;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (let n = 0; n < 40; n++) {
        const bytes = Uint8Array.from({ length: next() % 4097 }, () => next() >>> 24);
        assert.equal(sha256HexJs(bytes), nodeSha(bytes), `seeded input ${n}, ${bytes.length} bytes`);
    }
    for (let n = 0; n < 20; n++) {
        const bytes = randomBytes(randomInt(0, 4097));
        assert.equal(sha256HexJs(bytes), nodeSha(bytes), `random input of ${bytes.length} bytes: ${bytes.toString("hex").slice(0, 64)}…`);
    }
    const backing = Uint8Array.from({ length: 100 }, (_, i) => i);
    assert.equal(sha256HexJs(new DataView(backing.buffer, 7, 70)), nodeSha(backing.subarray(7, 77)), "a view hashes only its own bytes");
});

// The two canvas fetch paths, taken from web-app.js as written and run against
// a stub transport: the owner/agent path and the cross-owner wrapper path.
function canvasFetchPaths(body) {
    const source = read("../../ui/react/src/web-app.js");
    const fn = (name) => {
        const start = source.indexOf(`function ${name}(`);
        assert.ok(start >= 0, name);
        return source.slice(start, source.indexOf("\n}\n", start) + 2);
    };
    const make = new Function("assertPageBytes", "createIsolationWrapperUrl", "buildIsolatedInnerHtml", "CANVAS_LINK_GUARD",
        `${fn("fetchArtifactHtmlObjectUrl")}
${fn("fetchCrossOwnerCanvas")}
return { fetchArtifactHtmlObjectUrl, fetchCrossOwnerCanvas };`);
    const paths = make(assertPageBytes, () => "blob:wrapper", buildIsolatedInnerHtml, "<script>guard()</script>");
    const controller = { transport: { api: { downloadArtifactResponse: async () => new Response(body) } } };
    return {
        own: (sha) => paths.fetchArtifactHtmlObjectUrl(controller, "s1", "canvas.html", false, true, sha),
        crossOwner: (sha) => paths.fetchCrossOwnerCanvas(controller, "s1", "canvas.html", false, sha),
    };
}

test("without crypto.subtle both canvas fetch paths still check the page bytes and stay fail-closed", async () => {
    const page = "<!doctype html><p>rev 3</p>";
    const sha = nodeSha(page);
    const wrong = nodeSha("<!doctype html><p>rev 4</p>");
    await withoutSubtle(async () => {
        assert.equal(await sha256HexOfBytes(new TextEncoder().encode(page).buffer), sha, "falls back to JS");
        await assertPageBytes(new TextEncoder().encode(page).buffer, sha);
        await assert.rejects(assertPageBytes(new TextEncoder().encode(page).buffer, wrong), /being redrawn/);
        const { own, crossOwner } = canvasFetchPaths(page);
        assert.match(await own(sha), /^blob:/, "own/agent path: the right bytes load");
        const cross = await crossOwner(sha);
        assert.equal(cross.url, "blob:wrapper", "cross-owner path: the right bytes load");
        assert.match(cross.html, /<p>rev 3<\/p>/);
        await assert.rejects(own(wrong), /being redrawn/, "own/agent path: wrong bytes are refused");
        await assert.rejects(crossOwner(wrong), /being redrawn/, "cross-owner path: wrong bytes are refused");
    });
    assert.equal(typeof globalThis.crypto.subtle?.digest, "function", "crypto is restored");
});

test("a native digest failure is not hidden by the fallback", async () => {
    const failing = { digest: () => Promise.reject(new Error("native digest failed")) };
    await assert.rejects(sha256HexOfBytes(new Uint8Array([1]).buffer, failing), /native digest failed/);
});

test("the wrapper tells the portal once when its app page has loaded, so the portal can replay state (review S04)", () => {
    const w = bootWrapper();
    w.dispatch(w.parent, { type: "pse-wrapper-load", html: "<p>app</p>" });
    const inner = w.inner();
    assert.deepEqual(w.toParent, [{ type: "pse-wrapper-ready" }], "nothing before the page loads");
    inner.fireLoad();
    assert.deepEqual(w.toParent, [{ type: "pse-wrapper-ready" }, { type: "pse-wrapper-inner-loaded" }]);
    w.dispatch(inner.contentWindow, { type: "pse-wrapper-inner-loaded" });
    assert.equal(w.toParent.filter((m) => m.type === "pse-wrapper-inner-loaded").length, 1, "the page cannot forge it");
    const WEB_APP = read("../../ui/react/src/web-app.js");
    const APP = read("../src/App.jsx");
    assert.match(WEB_APP, /payload\.type === "pse-wrapper-inner-loaded"[\s\S]{0,600}?fromLive && rev && state !== null[\s\S]{0,200}?type: "canvas-data", data: state, dataRev: rev/, "the session canvas replays its full state to the live frame");
    assert.match(APP, /payload\.type === "pse-wrapper-inner-loaded"[\s\S]{0,300}?postState\(\)/, "the share view replays its live state");
});

test("a workspace call refused for consent from the staging frame answers NOT_READY, so the helper retries on the live frame (review S03)", () => {
    const WEB_APP = read("../../ui/react/src/web-app.js");
    assert.match(WEB_APP, /error\?\.code === "CANVAS_WS_CONSENT_REQUIRED" && !fromLive && !\/declined\/i\.test\(message\)\) \{\s*post\(\{ type: "canvas-ws-result", id, ok: false, error: "the canvas is still loading; retry in a moment", code: "NOT_READY" \}\);\s*return;/);
    assert.match(WEB_APP, /error\?\.code === "CANVAS_WS_CONSENT_REQUIRED" && fromLive && !\/declined\/i\.test\(message\)/, "the live frame still opens the prompt");
});

// ── Cold open (issue 181): one frame per revision ──────────────────────────
//
// The session list names a canvas revision before its draw event is read.
// Framing it at once, sealed, and again when the trust arrives started every
// owner page twice (sealed, then direct) and every other user's app twice
// (sealed, then sealed again, once its page hash arrived). The frame now
// waits for the trust; after CANVAS_TRUST_HOLD_MS it frames the page sealed
// (fail closed), and a late "another user's page" hash that matches the bytes
// it holds is re-bound without a reload.

test("assertPageBytes resolves to the hash of the bytes it checked", async () => {
    const page = "<!doctype html><p>sealed</p>";
    const bytes = new TextEncoder().encode(page).buffer;
    const sha = nodeSha(page);
    assert.equal(await assertPageBytes(bytes, sha), sha, "with an expected hash");
    assert.equal(await assertPageBytes(bytes, null), sha, "with none: still hashed, nothing refused");
    assert.equal(await assertPageBytes(bytes, "not-a-hash"), sha, "a malformed expected hash compares nothing");
    const { crossOwner } = canvasFetchPaths(page);
    assert.equal((await crossOwner(null)).sha, sha, "the sealed fetch reports the hash of the page the wrapper holds");
    assert.equal((await crossOwner(sha)).sha, sha);
});

test("the late-hash re-bind applies only to a sealed frame that holds exactly those bytes", () => {
    const SHA = "c".repeat(64);
    const OTHER = "d".repeat(64);
    const sealed = { sessionId: "s1", slot: 1, rev: 4, retryTick: 0, panelKeys: false, crossOwner: true, pageSha256: null };
    const late = { ...sealed, pageSha256: SHA };
    const frame = { sessionId: "s1", rev: 4, crossOwner: true, sha: SHA };
    assert.equal(canvasHashRebind(sealed, late, frame), true, "the one case: re-bind, no reload");
    // Everything else reloads.
    assert.equal(canvasHashRebind(null, late, frame), false, "no previous fetch");
    assert.equal(canvasHashRebind(sealed, late, null), false, "no frame on screen");
    assert.equal(canvasHashRebind(sealed, late, { ...frame, sha: OTHER }), false, "the frame holds other bytes");
    assert.equal(canvasHashRebind(sealed, late, { ...frame, sha: null }), false, "the frame's bytes were never hashed");
    assert.equal(canvasHashRebind(sealed, late, { ...frame, rev: 3 }), false, "the frame shows another revision");
    assert.equal(canvasHashRebind(sealed, late, { ...frame, sessionId: "s2" }), false, "another session's frame");
    assert.equal(canvasHashRebind(sealed, late, { ...frame, crossOwner: false }), false, "a direct frame is never re-bound");
    assert.equal(canvasHashRebind(sealed, { ...late, crossOwner: false }, frame), false, "the trust became owner or agent: frame it directly");
    assert.equal(canvasHashRebind({ ...sealed, pageSha256: OTHER }, late, frame), false, "a hash that changed is a new page");
    assert.equal(canvasHashRebind(sealed, { ...late, pageSha256: null }, frame), false, "no hash arrived");
    assert.equal(canvasHashRebind(sealed, { ...late, pageSha256: "x".repeat(64) }, frame), false, "a malformed hash");
    for (const key of ["sessionId", "slot", "rev", "retryTick", "panelKeys"]) {
        const changed = { ...late, [key]: key === "panelKeys" ? true : key === "sessionId" ? "s2" : late[key] + 1 };
        assert.equal(canvasHashRebind(sealed, changed, { ...frame, ...(key === "sessionId" ? { sessionId: "s2" } : {}), ...(key === "rev" ? { rev: changed.rev } : {}) }), false, `${key} changed: reload`);
    }
});

test("the session canvas waits for the trust, then frames once; sealed after the hold", () => {
    assert.equal(CANVAS_TRUST_HOLD_MS, 3000);
    const WEB_APP = read("../../ui/react/src/web-app.js");
    const frame = WEB_APP.slice(WEB_APP.indexOf("function CanvasFrame("), WEB_APP.indexOf("\n}\n", WEB_APP.indexOf("function CanvasFrame(")));
    assert.match(frame, /const holding = !trustKnown && !sealedFallback;/);
    assert.match(frame, /setTimeout\(\(\) => setSealedKey\(holdKey\), CANVAS_TRUST_HOLD_MS\)/, "the hold ends sealed, never direct");
    assert.match(frame, /if \(!controller \|\| !sessionId \|\| !latestRev \|\| holding\) return undefined;/, "no fetch while the trust is unknown");
    assert.match(frame, /const trust = trustKnown \? trustEntry\.trust : "cross-owner";/, "an unknown trust frames sealed");
    assert.match(frame, /const crossOwner = !\(trust === "owner" \|\| trust === "agent"\);/, "only owner and agent frame directly, whatever the state holds");
    assert.match(frame, /!fetchingRef\.current && canvasHashRebind\(previous, request, /, "a late matching hash re-binds, with no fetch in flight");
    assert.match(frame, /\[controller, sessionId, slot, latestRev, retryTick, panelKeys, crossOwner, pageSha256, holding\]/);
    assert.match(frame, /holding && !live && !staging[\s\S]{0,400}?"Loading canvas…"/, "a placeholder, only when nothing is on screen");
    assert.match(frame, /sealedFallback && !loadError[\s\S]{0,400}?shown sealed[\s\S]{0,600}?canvas\/snapshotInvalidate[\s\S]{0,200}?ensureCanvasSnapshot/, "the sealed fallback says so and can read the trust again");
});
