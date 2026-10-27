/**
 * Canvas app registry (issue 181): the ONE trusted frame contract for a page
 * the portal does not trust — another user's app on a canvas, and every
 * canvas slot file previewed outside the canvas pane. The session canvas, the
 * share-link viewer and the Files preview all use it; none may frame such a
 * page with a policy tag alone.
 *
 * Shape:
 *   portal iframe (sandbox="allow-scripts", no allow-same-origin)
 *     └─ WRAPPER: a portal-authored blob document with NO app bytes in its
 *        markup. Its policy is the app policy plus `frame-src 'none'`.
 *          └─ INNER frame (sandbox="allow-scripts"), its `srcdoc` PROPERTY set
 *             from text the portal handed over by postMessage. An
 *             about:srcdoc child inherits the wrapper's policy, so it gets no
 *             network, and any navigation of it is a frame load that the
 *             wrapper's `frame-src 'none'` refuses.
 *
 * The policy is not the only guard, and nothing here claims that a policy
 * alone proves the network is denied (that is the browser proof's job). The
 * relay is anchored too:
 *   - the wrapper forwards only between the portal (its parent) and the ONE
 *     inner frame it created; it drops wrapper-protocol messages a page forges;
 *   - a MessagePort the page transfers with a request (issue 184's per-request
 *     reply port) is passed to the portal unchanged, in the same transfer
 *     list; ports on anything else (forged protocol messages, other sources,
 *     the portal's own messages, a dead relay) are closed, never kept;
 *   - after the inner page's first load the wrapper tells the portal
 *     (`pse-wrapper-inner-loaded`), which replays the current tick state:
 *     a state posted when the wrapper frame itself loaded may have arrived
 *     before the page existed;
 *   - the inner frame loads exactly once; a second load means it was replaced,
 *     so the wrapper removes it, stops relaying for good and tells the portal
 *     (`pse-wrapper-left`);
 *   - the portal posts only to the current frame element's window for the
 *     current revision and stops posting once that frame has left its page.
 */

export const CROSS_OWNER_APP_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
export const CROSS_OWNER_WRAPPER_CSP = `${CROSS_OWNER_APP_CSP}; frame-src 'none'`;

/** Inside the inner frame, a link click asks the portal (which confirms with the person). */
export const CROSS_OWNER_LINK_GUARD = `<script>addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href],area[href]');if(!a||e.defaultPrevented)return;var h=a.getAttribute('href')||'';if(!h||h.charAt(0)==='#'||/^javascript:/i.test(h))return;e.preventDefault();try{parent.postMessage({type:'canvas-open-link',href:new URL(h,document.baseURI).href},'*')}catch(x){}},true);</script>`;

/** MoA panel keys (Tab/Escape) forwarded to the portal, as for ordinary canvases. */
export const CANVAS_PANEL_KEYS = `<script>window.addEventListener('keydown',function(e){if(e.isTrusted&&!e.altKey&&!e.metaKey&&!e.ctrlKey&&(e.key==='Tab'||e.key==='Escape')){e.preventDefault();e.stopImmediatePropagation();parent.postMessage({type:'moa-panel-key',key:e.key,backwards:e.shiftKey},'*')}},true);</script>`;

/**
 * The fixed, content-free canvas-ws diagnostic (issue 184): the only
 * workspace message a window may receive once workspace replies travel on
 * request ports.
 */
export const CANVAS_WS_UPGRADE_CODE = "CANVAS_WS_UPGRADE_REQUIRED";
export const CANVAS_WS_UPGRADE_ERROR = "Update this canvas workspace helper before using files or commands.";
/**
 * The fixed, content-free legacy KV and action diagnostics (issue 184's
 * canvas-document-channels.js): a canvas-kv-result or canvas-action-result
 * with exactly these code and error values.
 */
export const CANVAS_DOCUMENT_UPGRADE_CODE = "CANVAS_DOCUMENT_UPGRADE_REQUIRED";
export const CANVAS_DOCUMENT_UPGRADE_ERROR = "Update this canvas helper before using session features.";

/**
 * The wrapper document. `workspaceResults` says which `canvas-ws-result`
 * messages from the portal it passes to the page:
 *  - "relay"  (issue 181 alone): window replies, as the portal sends them
 *    today; the wrapped inner frame cannot be navigated, and a replaced inner
 *    frame ends the relay;
 *  - "upgrade-only" (with issue 184's request ports): of all window messages
 *    whose type starts with "canvas-ws", only the exact fixed diagnostic
 *    {type:"canvas-ws-result", id, ok:false, code, error} passes, with the
 *    fixed code and error text and a positive safe-integer or null id. Every
 *    other canvas-ws* message is dropped. Other types (KV ticks, actions)
 *    pass unchanged, and requests from the page to the portal are never
 *    filtered: they keep their exact ports.
 *  - "ports-only" (the composed issue 184 host, where replies, KV changes,
 *    workspace notices and ticks travel only on the page's own ports): of
 *    all window messages from the portal, only three exact diagnostics reach
 *    the page: the workspace one above, and the KV and action ones
 *    ({type:"canvas-kv-result"|"canvas-action-result", id, ok:false,
 *    code:CANVAS_DOCUMENT_UPGRADE_CODE, error:CANVAS_DOCUMENT_UPGRADE_ERROR}),
 *    each with exactly those five own keys (an array or an object with a
 *    symbol or non-enumerable key is not a diagnostic). Everything else is dropped, whatever
 *    its type, so no session content ever crosses the wrapper as a window
 *    message.
 */
export function crossOwnerWrapperHtml({ workspaceResults = "relay" } = {}) {
    const exact = (type, code, error) => `(d.type===${JSON.stringify(type)}&&d.code===${JSON.stringify(code)}&&d.error===${JSON.stringify(error)})`;
    const DIAGNOSTIC = (kinds) => `function diag(d){if(Reflect.ownKeys(d).length!==5)return false;var k=Object.keys(d).sort().join(',');return k==='code,error,id,ok,type'&&d.ok===false&&(d.id===null||(Number.isSafeInteger(d.id)&&d.id>0))&&(${kinds.join("||")})}`;
    const WS = exact("canvas-ws-result", CANVAS_WS_UPGRADE_CODE, CANVAS_WS_UPGRADE_ERROR);
    const DOWN_FILTER = workspaceResults === "ports-only"
        ? `${DIAGNOSTIC([WS, exact("canvas-kv-result", CANVAS_DOCUMENT_UPGRADE_CODE, CANVAS_DOCUMENT_UPGRADE_ERROR), exact("canvas-action-result", CANVAS_DOCUMENT_UPGRADE_CODE, CANVAS_DOCUMENT_UPGRADE_ERROR)])}function downOk(d){return diag(d)}`
        : workspaceResults === "upgrade-only"
            ? `${DIAGNOSTIC([WS])}function downOk(d){return !(typeof d.type==='string'&&d.type.indexOf('canvas-ws')===0)||diag(d)}`
            : "function downOk(){return true}";
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CROSS_OWNER_WRAPPER_CSP}"><style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><script>(function(){var inner=null,dead=false,loads=0;function own(d){return typeof d.type==='string'&&d.type.indexOf('pse-wrapper')===0}${DOWN_FILTER}function shut(ps){for(var i=0;ps&&i<ps.length;i++){try{ps[i].close()}catch(x){}}}addEventListener('message',function(e){var d=e.data,ps=e.ports;if(dead||!d||typeof d!=='object'){shut(ps);return;}if(e.source===parent&&d.type==='pse-wrapper-load'){shut(ps);if(inner)return;inner=document.createElement('iframe');inner.setAttribute('sandbox','allow-scripts');inner.setAttribute('allow','autoplay *');inner.setAttribute('referrerpolicy','no-referrer');inner.addEventListener('load',function(){loads+=1;if(loads===1){try{parent.postMessage({type:'pse-wrapper-inner-loaded'},'*')}catch(x){}}if(loads>1){dead=true;try{inner.remove()}catch(x){}inner=null;try{parent.postMessage({type:'pse-wrapper-left'},'*')}catch(x){}}});inner.srcdoc=String(d.html||'');document.body.appendChild(inner);return;}if(inner&&e.source===inner.contentWindow){if(own(d)){shut(ps);return;}try{parent.postMessage(d,'*',ps?Array.prototype.slice.call(ps):[])}catch(x){shut(ps)}return;}if(inner&&e.source===parent&&!own(d)){shut(ps);if(!downOk(d))return;try{inner.contentWindow.postMessage(d,'*')}catch(x){}return;}shut(ps);});parent.postMessage({type:'pse-wrapper-ready'},'*');})();</script></body></html>`;
}

export const CROSS_OWNER_WRAPPER_HTML = crossOwnerWrapperHtml();

/** Put the given text right after the doctype (or first, when there is none). */
export function injectAfterDoctype(html, injected) {
    const text = String(html ?? "");
    const prolog = /^(?:\uFEFF|\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(text)?.[0] || "";
    return text.slice(0, prolog.length) + injected + text.slice(prolog.length);
}

/** The inner page: the app policy, optional panel keys, then the link guard, ahead of the page's own head. */
/**
 * The inner page: the app policy, an optional TRUSTED bootstrap supplied by
 * the portal (issue 184's workspace document binding; never page-supplied),
 * optional panel keys, then the link guard, ahead of the page's own head.
 */
export function buildIsolatedInnerHtml(text, { panelKeys = false, bootstrap = "" } = {}) {
    return injectAfterDoctype(text, `<meta http-equiv="Content-Security-Policy" content="${CROSS_OWNER_APP_CSP}">${bootstrap || ""}${panelKeys ? CANVAS_PANEL_KEYS : ""}${CROSS_OWNER_LINK_GUARD}`);
}

/** A fresh object URL for the wrapper document. The caller revokes it. */
export function createIsolationWrapperUrl(options = {}) {
    return URL.createObjectURL(new Blob([crossOwnerWrapperHtml(options)], { type: "text/html;charset=utf-8" }));
}

/** Messages that only the wrapper itself may send to the portal. */
export function isWrapperControlMessage(payload) {
    return Boolean(payload && typeof payload === "object" && typeof payload.type === "string" && payload.type.startsWith("pse-wrapper"));
}

/** Canvas slot files: canvas.html, canvas2.html … canvas5.html. */
export function isCanvasSlotFilename(filename) {
    return /^canvas[2-5]?\.html$/i.test(String(filename ?? ""));
}

const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * SHA-256 in plain JavaScript (FIPS 180-4). WebCrypto exists only in secure
 * contexts, so a portal served over http on a host other than localhost has
 * no crypto.subtle; the page-bytes check must still run there.
 */
export function sha256HexJs(input) {
    const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
    const bitLength = bytes.length * 8;
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(padded.length - 4, bitLength >>> 0);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, k] = h;
        for (let i = 0; i < 64; i++) {
            const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + k) >>> 0;
    }
    return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
}

/**
 * Hex SHA-256 of an ArrayBuffer: WebCrypto when the context has it, else
 * {@link sha256HexJs}. Only an ABSENT digest falls back; a native digest that
 * fails still rejects, and the page-bytes check stays fail-closed.
 */
export async function sha256HexOfBytes(bytes, subtle = globalThis.crypto?.subtle) {
    if (typeof subtle?.digest !== "function") return sha256HexJs(bytes);
    const digest = await subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A canvas file must hold the page its draw event classified: a redraw
 * uploads the next page before it records its event, and in that window the
 * file is already the next page. Mismatched bytes are not framed under the
 * old revision's trust; the caller retries once the event lands.
 *
 * Resolves to the hex SHA-256 of the bytes, so a frame can record which page
 * it holds. With no expected hash there is nothing to refuse: the hash is
 * still taken when it can be (null when the digest fails).
 */
export async function assertPageBytes(bytes, expectedSha256) {
    if (typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
        try { return await sha256HexOfBytes(bytes); } catch { return null; }
    }
    const actual = await sha256HexOfBytes(bytes);
    if (actual !== expectedSha256) {
        throw new Error("the canvas is being redrawn; loading the new revision");
    }
    return actual;
}

/**
 * The session canvas waits this long for a revision's trust before it frames
 * the page anyway, sealed as another user's page (fail closed).
 */
export const CANVAS_TRUST_HOLD_MS = 3000;

/**
 * Whether a frame already shows what a fetch would load, so the fetch is
 * skipped (issue 181). Only one case qualifies: the session canvas framed a
 * page sealed while its trust was unknown (no page hash), and the trust that
 * arrives later says "another user's page" with the hash of exactly the bytes
 * that frame holds. Reloading it would restart the app and cancel its calls
 * for nothing. Any other change (a new revision, a retry, a different trust,
 * other bytes) loads again.
 *
 * `previous` and `next`: { sessionId, slot, rev, retryTick, panelKeys,
 * crossOwner, pageSha256 } of the last and the new fetch. `frame`: the frame
 * on screen, { sessionId, rev, crossOwner, sha }.
 */
export function canvasHashRebind(previous, next, frame) {
    if (!previous || !next || !frame) return false;
    for (const key of ["sessionId", "slot", "rev", "retryTick", "panelKeys", "crossOwner"]) {
        if (previous[key] !== next[key]) return false;
    }
    if (next.crossOwner !== true || previous.pageSha256 !== null) return false;
    if (typeof next.pageSha256 !== "string" || !/^[0-9a-f]{64}$/.test(next.pageSha256)) return false;
    return frame.sessionId === next.sessionId && frame.rev === next.rev
        && frame.crossOwner === true && frame.sha === next.pageSha256;
}
