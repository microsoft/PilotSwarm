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
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CROSS_OWNER_WRAPPER_CSP}"><style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><script>(function(){var inner=null,dead=false,loads=0;function own(d){return typeof d.type==='string'&&d.type.indexOf('pse-wrapper')===0}${DOWN_FILTER}function shut(ps){for(var i=0;ps&&i<ps.length;i++){try{ps[i].close()}catch(x){}}}addEventListener('message',function(e){var d=e.data,ps=e.ports;if(dead||!d||typeof d!=='object'){shut(ps);return;}if(e.source===parent&&d.type==='pse-wrapper-load'){shut(ps);if(inner)return;inner=document.createElement('iframe');inner.setAttribute('sandbox','allow-scripts');inner.setAttribute('allow','autoplay *');inner.setAttribute('referrerpolicy','no-referrer');inner.addEventListener('load',function(){loads+=1;if(loads>1){dead=true;try{inner.remove()}catch(x){}inner=null;try{parent.postMessage({type:'pse-wrapper-left'},'*')}catch(x){}}});inner.srcdoc=String(d.html||'');document.body.appendChild(inner);return;}if(inner&&e.source===inner.contentWindow){if(own(d)){shut(ps);return;}try{parent.postMessage(d,'*',ps?Array.prototype.slice.call(ps):[])}catch(x){shut(ps)}return;}if(inner&&e.source===parent&&!own(d)){shut(ps);if(!downOk(d))return;try{inner.contentWindow.postMessage(d,'*')}catch(x){}return;}shut(ps);});parent.postMessage({type:'pse-wrapper-ready'},'*');})();</script></body></html>`;
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

/** Hex SHA-256 of an ArrayBuffer (WebCrypto). */
export async function sha256HexOfBytes(bytes) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A canvas file must hold the page its draw event classified: a redraw
 * uploads the next page before it records its event, and in that window the
 * file is already the next page. Mismatched bytes are not framed under the
 * old revision's trust; the caller retries once the event lands.
 */
export async function assertPageBytes(bytes, expectedSha256) {
    if (typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedSha256)) return;
    if (await sha256HexOfBytes(bytes) !== expectedSha256) {
        throw new Error("the canvas is being redrawn; loading the new revision");
    }
}
