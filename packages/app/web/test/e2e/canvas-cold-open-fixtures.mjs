// Cold open of a session canvas (issue 181): shared fixtures for the desktop
// and phone specs. Not a spec.
//
// The fake server's session list names each canvas revision (the
// session_canvases summary, as the real list does), so the portal knows the
// revision BEFORE it reads that revision's draw event. That is the cold-open
// path the earlier canvas fixtures never took: they answered only the draw
// event, so the revision and its trust always arrived together.
//
// What a test can count:
//   downloads(file)  how often the portal fetched canvas.html / canvas2.html;
//   boots(marker)    how often an app page STARTED (its script posts a boot
//                    message to its parent; a wrapper relays it to the portal);
//   srcdocs()        how many wrapped inner pages were created;
//   snapshots()      how often the portal read the draw events.
//
// Ordering is controlled, not timed: with `snapshot: { hold: true }` every
// draw-event read stays pending until the test calls release(). A test first
// observes the state it means to test (the frame waiting, or the page framed
// sealed after the hold), then releases the trust and checks the outcome.
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";

export const sid = (i) => `1111111${i}-2222-3333-4444-55555555555${i}`;
export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** An app page that says it started, once per start. */
export function appPage(marker) {
    return `<!doctype html><html><body><h1 id="marker">${marker}</h1>`
        + `<script>parent.postMessage({ type: "canvas-test-boot", marker: ${JSON.stringify(marker)} }, "*");</script></body></html>`;
}

/** The canvases the fake list names: two slots on session 0. */
export const LIST_CANVASES = {
    0: [
        { slot: 1, name: "first", latestRev: 1, sizeBytes: 200 },
        { slot: 2, name: "second", latestRev: 1, sizeBytes: 200 },
    ],
};

/**
 * Route one session's canvas reads. `slots`: { [slot]: { html, trust?, pageSha256? } }
 * (`pageSha256` defaults to the served bytes; pass null for none). `snapshot`:
 * { hold, status } for the draw-event read: `hold` keeps every read pending
 * until release(); `status` >= 400 fails it. Returns live counters.
 */
export async function routeCanvas(page, sessionId, { slots, snapshot = {} }) {
    const downloads = new Map();
    let snapshots = 0;
    let released = !snapshot.hold;
    let releaseAll = () => {};
    const gate = new Promise((resolve) => { releaseAll = resolve; });
    let srcdocs = 0;
    page.on("framenavigated", (frame) => { if (frame.url() === "about:srcdoc") srcdocs += 1; });
    await page.addInitScript(() => {
        if (window !== window.top) return;
        window.__canvasBoots = [];
        window.addEventListener("message", (event) => {
            if (event.data && event.data.type === "canvas-test-boot") window.__canvasBoots.push(String(event.data.marker));
        });
    });
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (!url.pathname.includes(sessionId)) return route.fallback();
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            snapshots += 1;
            if (!released) await gate;
            if (snapshot.status && snapshot.status >= 400) {
                return route.fulfill({ status: snapshot.status, json: { ok: false, error: { code: "UNAVAILABLE", message: "draw events unavailable" } } });
            }
            const result = Object.entries(slots).map(([slot, s], i) => {
                const data = { slot: Number(slot), rev: 1, sizeBytes: Buffer.byteLength(s.html, "utf8"), name: Number(slot) === 1 ? "first" : "second" };
                if (s.trust !== undefined) data.trust = s.trust;
                const hash = s.pageSha256 === undefined ? sha256(s.html) : s.pageSha256;
                if (hash) data.pageSha256 = hash;
                if (s.trust === "cross-owner") data.app = { name: "bobs-board", version: "1.0.0" };
                return { seq: i + 1, eventType: "session.canvas_updated", data };
            });
            return route.fulfill({ json: { ok: true, result } });
        }
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_data")) {
            return route.fulfill({ json: { ok: true, result: [] } });
        }
        const file = /\/artifacts\/(canvas\d?\.html)\/download$/.exec(url.pathname)?.[1];
        if (file) {
            downloads.set(file, (downloads.get(file) || 0) + 1);
            const slot = file === "canvas.html" ? 1 : Number(file.slice(6, -5));
            const s = slots[slot];
            if (!s) return route.fulfill({ status: 404, body: "" });
            return route.fulfill({ contentType: "text/html", body: s.html });
        }
        return route.fallback();
    });
    return {
        release: () => { released = true; releaseAll(); },
        downloads: (file) => downloads.get(file) || 0,
        snapshots: () => snapshots,
        srcdocs: () => srcdocs,
        boots: async (marker) => (await page.evaluate(() => window.__canvasBoots || [])).filter((m) => m === marker).length,
    };
}

/** A cold deep link to the session, then the canvas pane (once the session is active). */
export async function openCanvasCold(page, base, sessionId) {
    await page.goto(`${base}/?session=${sessionId}`);
    // The 3b1367d1 wait: a session change resets the canvas pane by design, so
    // the pane is opened only once the deep-linked session is the active one.
    await expect(page.locator(`.ps-session-list-button[data-session-id="${sessionId}"][aria-selected="true"]`)).toHaveCount(1, { timeout: 30_000 });
    const show = page.getByRole("button", { name: "Show canvas", exact: true });
    const hide = page.getByRole("button", { name: "Hide the canvas", exact: true });
    await show.or(hide).first().waitFor({ timeout: 30_000 });
    if (!(await hide.isVisible())) await show.click();
    await expect(hide.first()).toBeVisible();
}

/** The canvas frame on screen (not the staging one). */
export const liveFrame = (page) => page.locator(".ps-side-pane-layer:not(.is-parked) iframe.ps-html-preview-frame:not(.is-staging)");

/** The marker of the page on screen, read through the wrapper when there is one. */
export async function expectShown(page, marker, { wrapped }) {
    const outer = liveFrame(page);
    await expect(outer).toHaveCount(1, { timeout: 30_000 });
    if (wrapped) {
        await expect(outer).toHaveAttribute("sandbox", "allow-scripts");
        await expect(page.frameLocator(".ps-side-pane-layer:not(.is-parked) iframe.ps-html-preview-frame:not(.is-staging)").frameLocator("iframe").locator("#marker")).toHaveText(marker, { timeout: 30_000 });
    } else {
        await expect(outer).toHaveAttribute("sandbox", /allow-popups/);
        await expect(page.frameLocator(".ps-side-pane-layer:not(.is-parked) iframe.ps-html-preview-frame:not(.is-staging)").locator("#marker")).toHaveText(marker, { timeout: 30_000 });
    }
}
