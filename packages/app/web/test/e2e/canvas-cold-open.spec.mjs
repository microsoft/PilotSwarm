// Cold open of a session canvas (issue 181), desktop. The session list names
// the canvas revision before the portal reads its draw event. Before the fix
// the portal framed that revision at once, sealed (its trust unknown), then
// downloaded and framed it AGAIN when the draw event arrived: an owner page
// went sealed -> direct, another user's app sealed -> sealed (its page hash
// arrived). The app started twice and its first calls were cancelled.
//
// Now the frame waits for the trust, so the first frame is the final one:
// exactly one download and one start per page, for any trust and any slot.
// If the trust does not come within the hold (3 s), the page is framed sealed
// (fail closed); a late "another user's page" whose hash matches the bytes on
// screen is re-bound without a reload; a late owner or agent trust reframes
// once, sealed -> direct (accepted: it started fail-closed).
//
// Every draw-event read is HELD until the test has seen the state it tests
// (the frame waiting with nothing downloaded, or the page framed sealed after
// the hold), then released: the ordering is proven, not assumed from timers.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { appPage, expectShown, LIST_CANVASES, liveFrame, openCanvasCold, routeCanvas, sha256, sid } from "./canvas-cold-open-fixtures.mjs";

let stub, base;
test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 1, canvases: LIST_CANVASES });
    base = `http://127.0.0.1:${stub.port}`;
});
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const S = sid(0);
const HELD = { hold: true };
const placeholder = (page) => page.locator('[data-canvas-hold="trust"]');
const sealedNotice = (page) => page.locator('[data-canvas-sealed="unconfirmed"]');

/** The frame waits: the placeholder is up, nothing was downloaded, nothing started. */
async function expectWaiting(page, c, file, marker) {
    await expect(placeholder(page), "the frame waits for the trust").toBeVisible();
    expect(c.downloads(file), "nothing downloaded while the trust is unknown").toBe(0);
    expect(await c.boots(marker)).toBe(0);
}

test("owner page, cold deep link: held, then framed once, directly", async ({ page }) => {
    const c = await routeCanvas(page, S, { slots: { 1: { html: appPage("owner-slot-1"), trust: "owner" }, 2: { html: appPage("unused-2"), trust: "owner" } }, snapshot: HELD });
    await openCanvasCold(page, base, S);
    await expectWaiting(page, c, "canvas.html", "owner-slot-1");
    c.release();
    await expectShown(page, "owner-slot-1", { wrapped: false });
    await expect.poll(() => c.boots("owner-slot-1")).toBe(1);
    await page.waitForTimeout(800);
    expect(c.downloads("canvas.html"), "one download").toBe(1);
    expect(c.srcdocs(), "never wrapped").toBe(0);
    expect(await c.boots("owner-slot-1"), "the page started once").toBe(1);
    await expect(placeholder(page)).toHaveCount(0);
    await expect(sealedNotice(page)).toHaveCount(0);
});

test("another user's app with a recorded page hash, cold deep link: held, then one wrapper, no reframe", async ({ page }) => {
    const c = await routeCanvas(page, S, { slots: { 1: { html: appPage("cross-slot-1"), trust: "cross-owner" }, 2: { html: appPage("unused-2"), trust: "owner" } }, snapshot: HELD });
    await openCanvasCold(page, base, S);
    await expectWaiting(page, c, "canvas.html", "cross-slot-1");
    c.release();
    await expectShown(page, "cross-slot-1", { wrapped: true });
    await expect.poll(() => c.boots("cross-slot-1")).toBe(1);
    await page.waitForTimeout(800);
    expect(c.downloads("canvas.html"), "one download").toBe(1);
    expect(c.srcdocs(), "exactly one wrapper").toBe(1);
    expect(await c.boots("cross-slot-1"), "the app started once").toBe(1);
});

for (const trust of ["cross-owner", "owner"]) {
    test(`slot 2 (${trust === "owner" ? "owner page" : "another user's app"}), chosen before the trust arrives: one download, one start`, async ({ page }) => {
        const marker = `slot-2-${trust}`;
        const c = await routeCanvas(page, S, { slots: { 1: { html: appPage("slot-1"), trust: "owner" }, 2: { html: appPage(marker), trust } }, snapshot: HELD });
        await openCanvasCold(page, base, S);
        // The list named both slots, so the chooser is there before the draw events are read.
        await page.getByLabel("Choose canvas").selectOption("2");
        await expectWaiting(page, c, "canvas2.html", marker);
        expect(c.downloads("canvas.html"), "slot 1 was never loaded either").toBe(0);
        c.release();
        await expectShown(page, marker, { wrapped: trust === "cross-owner" });
        await expect.poll(() => c.boots(marker)).toBe(1);
        await page.waitForTimeout(800);
        expect(c.downloads("canvas2.html"), "one download of canvas2.html").toBe(1);
        expect(await c.boots(marker), "the slot-2 page started once").toBe(1);
        expect(c.srcdocs(), "a wrapper only for another user's app").toBe(trust === "cross-owner" ? 1 : 0);
    });
}

test("the list names rev 1 before its draw event; the live draw event for rev 1 then classifies it: one download, direct, no sealed fallback", async ({ page }) => {
    // The draw-event read stays held for the whole test: only the LIVE event
    // (the session's websocket) can say whose page rev 1 is. Before the fix
    // the store dropped that event (same revision as the list's), so an owner
    // page stayed unclassified and fell back to sealed.
    const OWNER = appPage("live-after-seed");
    const sockets = [];
    let subscribed = false;
    await page.routeWebSocket("**/api/v1/ws", (ws) => {
        sockets.push(ws);
        ws.onMessage((raw) => { try { if (JSON.parse(raw).type === "subscribeSession") subscribed = true; } catch { /* not ours */ } });
    });
    const c = await routeCanvas(page, S, { slots: { 1: { html: OWNER, trust: "owner" }, 2: { html: appPage("unused-2"), trust: "owner" } }, snapshot: HELD });
    try {
        await openCanvasCold(page, base, S);
        await expectWaiting(page, c, "canvas.html", "live-after-seed");
        await expect.poll(() => subscribed, { message: "the session's live channel is open" }).toBe(true);
        await expect(sealedNotice(page), "still inside the hold when the live event arrives").toHaveCount(0);
        const event = {
            sessionId: S, seq: 9001, eventType: "session.canvas_updated", createdAt: new Date().toISOString(),
            data: { slot: 1, rev: 1, sizeBytes: Buffer.byteLength(OWNER, "utf8"), name: "first", trust: "owner", pageSha256: sha256(OWNER) },
        };
        for (const ws of sockets) ws.send(JSON.stringify({ type: "sessionEvent", sessionId: S, event }));
        await expectShown(page, "live-after-seed", { wrapped: false });
        await expect.poll(() => c.boots("live-after-seed")).toBe(1);
        await page.waitForTimeout(3500);
        expect(c.downloads("canvas.html"), "one download").toBe(1);
        expect(c.srcdocs(), "never wrapped").toBe(0);
        expect(await c.boots("live-after-seed"), "the page started once").toBe(1);
        await expect(sealedNotice(page), "no sealed fallback").toHaveCount(0);
    } finally {
        // The proof is complete: let the held draw-event reads finish, so no
        // intercepted request is left waiting at teardown.
        c.release();
    }
});

test("a revision drawn before trust was recorded (no trust, no hash) is framed sealed, once", async ({ page }) => {
    const c = await routeCanvas(page, S, { slots: { 1: { html: appPage("legacy-slot-1"), trust: undefined, pageSha256: null }, 2: { html: appPage("unused-2"), trust: "owner" } }, snapshot: HELD });
    await openCanvasCold(page, base, S);
    await expectWaiting(page, c, "canvas.html", "legacy-slot-1");
    c.release();
    await expectShown(page, "legacy-slot-1", { wrapped: true });
    await expect.poll(() => c.boots("legacy-slot-1")).toBe(1);
    await page.waitForTimeout(800);
    expect(c.downloads("canvas.html")).toBe(1);
    expect(c.srcdocs()).toBe(1);
    await expect(sealedNotice(page), "its trust is known (sealed), not unconfirmed").toHaveCount(0);
});

test.describe("the trust arrives after the hold", () => {
    /** Held past the 3 s hold: the page is framed sealed, once, and says so. */
    async function expectSealedFallback(page, c, marker) {
        await expectWaiting(page, c, "canvas.html", marker);
        await expect(sealedNotice(page), "after the hold: sealed, and it says so").toBeVisible({ timeout: 10_000 });
        await expectShown(page, marker, { wrapped: true });
        await expect.poll(() => c.boots(marker)).toBe(1);
        expect(c.downloads("canvas.html")).toBe(1);
    }

    test("another user's app, matching hash: sealed after the hold, then re-bound, not reloaded", async ({ page }) => {
        const c = await routeCanvas(page, S, { slots: { 1: { html: appPage("late-cross-match"), trust: "cross-owner" }, 2: { html: appPage("unused-2"), trust: "owner" } }, snapshot: HELD });
        await openCanvasCold(page, base, S);
        await expectSealedFallback(page, c, "late-cross-match");
        // The trust lands with the hash of exactly these bytes.
        c.release();
        await expect(sealedNotice(page)).toHaveCount(0, { timeout: 10_000 });
        await page.waitForTimeout(1000);
        expect(c.downloads("canvas.html"), "no reload").toBe(1);
        expect(c.srcdocs(), "the same wrapper").toBe(1);
        expect(await c.boots("late-cross-match"), "the app was not restarted").toBe(1);
    });

    test("another user's app, different hash: the sealed frame stays; the new bytes are refused", async ({ page }) => {
        const c = await routeCanvas(page, S, {
            slots: { 1: { html: appPage("late-cross-other"), trust: "cross-owner", pageSha256: sha256("<!doctype html><p>another revision</p>") }, 2: { html: appPage("unused-2"), trust: "owner" } },
            snapshot: HELD,
        });
        await openCanvasCold(page, base, S);
        await expectSealedFallback(page, c, "late-cross-other");
        c.release();
        // The recorded hash differs from the bytes on screen: load again, and
        // the byte check refuses them (once, then the one quiet retry).
        await expect(page.locator(".ps-canvas-load-error", { hasText: "Couldn't load rev 1" })).toBeVisible({ timeout: 15_000 });
        expect(c.downloads("canvas.html"), "the sealed load, the reload and its one retry").toBe(3);
        await expect(liveFrame(page)).toHaveAttribute("sandbox", "allow-scripts");
        expect(await c.boots("late-cross-other"), "refused bytes never start").toBe(1);
    });

    test("owner page: sealed after the hold, then framed directly once its trust arrives (accepted reframe)", async ({ page }) => {
        const c = await routeCanvas(page, S, { slots: { 1: { html: appPage("late-owner"), trust: "owner" }, 2: { html: appPage("unused-2"), trust: "owner" } }, snapshot: HELD });
        await openCanvasCold(page, base, S);
        await expectSealedFallback(page, c, "late-owner");
        c.release();
        await expect(liveFrame(page)).toHaveAttribute("sandbox", /allow-popups/, { timeout: 10_000 });
        await expectShown(page, "late-owner", { wrapped: false });
        await expect.poll(() => c.boots("late-owner")).toBe(2);
        expect(c.downloads("canvas.html"), "sealed, then direct").toBe(2);
        await expect(sealedNotice(page)).toHaveCount(0);
    });

    test("draw events unavailable (500): sealed after the hold, with a retry that reads them again", async ({ page }) => {
        const c = await routeCanvas(page, S, { slots: { 1: { html: appPage("snapshot-500"), trust: "owner" }, 2: { html: appPage("unused-2"), trust: "owner" } }, snapshot: { status: 500 } });
        await openCanvasCold(page, base, S);
        await expect(placeholder(page)).toBeVisible();
        await expect(sealedNotice(page)).toBeVisible({ timeout: 10_000 });
        await expectShown(page, "snapshot-500", { wrapped: true });
        expect(c.downloads("canvas.html")).toBe(1);
        // The sessions poll (every 4 s) reads the draw events too. Right after
        // one of its reads, the next read within a second is the Retry's.
        const seen = c.snapshots();
        await expect.poll(() => c.snapshots(), { timeout: 6_000 }).toBeGreaterThan(seen);
        const before = c.snapshots();
        await sealedNotice(page).getByRole("button", { name: "Retry", exact: true }).click();
        await expect.poll(() => c.snapshots(), { timeout: 1_000, message: "Retry reads the draw events again" }).toBeGreaterThan(before);
        await expect(sealedNotice(page), "still unconfirmed, still sealed").toBeVisible();
    });
});
