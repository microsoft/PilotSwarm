/**
 * Horizon Dawn: the Azure HorizonDB GA theme's header scenery.
 *
 * The header carries no words (the scenery speaks); it stays compact; every layer (sky,
 * Orion, mountains, the animated mark) and the bundled Sora font load from the
 * bundle, not the network; reduced motion swaps in the still art; the sky sits
 * behind the land; and the phone header keeps Orion and the line on screen.
 */
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
const sessionId = "11111110-2222-3333-4444-555555555551";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2, transcriptTurns: 1 }); });
test.afterAll(async () => { if (stub) await new Promise(resolve => stub.server.close(resolve)); });

async function openTheme(page, viewport, soundOn = true) {
    const failed = [];
    page.on("requestfailed", request => failed.push(request.url()));
    page.on("response", response => { if (response.status() >= 400 && /horizon-dawn|sora|\.svg|\.woff2/i.test(response.url())) failed.push(`${response.status()} ${response.url()}`); });
    await page.route("**/api/v1/**", route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/me/profile")) return route.fulfill({ json: { ok: true, result: { profileSettings: {
            themeId: "horizon-dawn", themeSound: { on: soundOn, volume: 40 }, themeSoundMobile: { on: soundOn, volume: 40 },
        } } } });
        return route.fallback();
    });
    await page.setViewportSize(viewport);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await expect(page.locator("html")).toHaveAttribute("data-ps-theme", "horizon-dawn");
    await page.evaluate(() => document.fonts.ready);
    return failed;
}

const layers = page => page.locator(".portal-header").evaluate(header => getComputedStyle(header, "::before").backgroundImage);
// Each art file carries a root id (hd-<name>); Vite inlines the small ones as data URIs and emits
// the large ones as hashed files, so a layer is found by either form.
const art = name => new RegExp(`hd-${name}(?![-a-z])|/${name}-[A-Za-z0-9_-]{8}\\.svg`);
const where = (images, name) => images.search(art(name));

for (const soundOn of [true, false]) test(`cyan accent: appearance cue respects sounds ${soundOn ? "on" : "off"}`, async ({ page }) => {
    await page.addInitScript(() => {
        Math.random = () => 0;
        window.accentSweeps = 0;
        const create = AudioContext.prototype.createOscillator;
        AudioContext.prototype.createOscillator = function () {
            const osc = create.call(this), frequencies = [];
            const set = osc.frequency.setValueAtTime.bind(osc.frequency);
            const ramp = osc.frequency.exponentialRampToValueAtTime.bind(osc.frequency);
            osc.frequency.setValueAtTime = (value, time) => { frequencies.push(value); return set(value, time); };
            osc.frequency.exponentialRampToValueAtTime = (value, time) => { frequencies.push(value); return ramp(value, time); };
            const start = osc.start.bind(osc);
            osc.start = (...args) => {
                if (frequencies[0] === 660 && frequencies[1] === 1320) window.accentSweeps += 1;
                return start(...args);
            };
            return osc;
        };
    });
    await page.clock.install();
    await openTheme(page, { width: 390, height: 844 }, soundOn);
    await page.locator(".portal-header-brand").click();
    await page.clock.runFor(500);
    await page.clock.fastForward(30_001);
    await expect(page.locator(".portal-header-accent")).toHaveAttribute("data-active", "true");
    expect(await page.evaluate(() => window.accentSweeps)).toBe(soundOn ? 1 : 0);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`cyan accent ${viewport.width}px: solid dot and fading trail stay in the header without changing geometry`, async ({ page }) => {
        await openTheme(page, viewport);
        const accent = page.locator(".portal-header-accent");
        await expect(accent).toHaveAttribute("aria-hidden", "true");
        const before = await page.locator(".portal-header").boundingBox();
        await accent.evaluate(el => { el.dataset.active = "true"; });
        const look = await accent.evaluate(el => {
            const style = node => getComputedStyle(node);
            const box = el.getBoundingClientRect(), header = el.parentElement.getBoundingClientRect();
            const dot = el.querySelector(".portal-header-accent-dot"), tail = el.querySelector(".portal-header-accent-trail");
            return {
                pointerEvents: style(el).pointerEvents, inside: box.top >= header.top && box.bottom <= header.bottom,
                dotWidth: style(dot).width, dotHeight: style(dot).height, color: style(dot).backgroundColor,
                trailWidth: style(tail).width, animation: style(el.querySelector(".portal-header-accent-pass")).animationName,
            };
        });
        expect(look).toEqual({
            pointerEvents: "none", inside: true, dotWidth: "5px", dotHeight: "5px",
            color: "rgb(201, 250, 255)", trailWidth: "120px", animation: "portal-header-accent-cross",
        });
        expect(await page.locator(".portal-header").boundingBox()).toEqual(before);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    });
}

test("cyan accent: no early pass or immediate repeat, and reduced motion cancels it", async ({ page }) => {
    await page.addInitScript(() => { Math.random = () => 0; });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.install();
    await openTheme(page, { width: 1440, height: 900 });
    const accent = page.locator(".portal-header-accent");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(accent).toHaveAttribute("data-enabled", "true");
    await page.clock.fastForward(29_000);
    await expect(accent).not.toHaveAttribute("data-active", "true");
    await page.clock.runFor(1_500);
    await expect(accent).toHaveAttribute("data-active", "true");
    await page.clock.runFor(5_500);
    await expect(accent).toHaveAttribute("data-active", "false");
    await page.clock.fastForward(29_000);
    await expect(accent).not.toHaveAttribute("data-active", "true");
    await page.clock.runFor(1_500);
    await expect(accent).toHaveAttribute("data-active", "true");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(accent).toBeHidden();
    await expect(accent).toHaveAttribute("data-active", "false");
});

test("desktop: no words in the scenery, a compact header, and every layer from the bundle", async ({ page }) => {
    const failed = await openTheme(page, { width: 1440, height: 900 });
    const header = page.locator(".portal-header");
    expect(await header.evaluate(el => getComputedStyle(el, "::after").content)).toBe("none");
    const box = await header.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(93);
    expect(box.height).toBeLessThanOrEqual(110);
    const images = await layers(page);
    const order = ["mountains-front", "mountains-back", "orion", "sky"].map(name => where(images, name));
    expect(order.every(index => index >= 0), images).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order); // land is drawn over the sky
    expect(images).not.toMatch(/googleapis|gstatic/);
    expect(await page.locator(".portal-logo-frame").evaluate(el => getComputedStyle(el).backgroundImage)).toMatch(art("logo"));
    expect(await page.evaluate(() => document.fonts.check('600 13px "PS Sora"'))).toBe(true);
    await page.waitForTimeout(500);
    expect(failed).toEqual([]);
});

for (const width of [1920, 1600, 1440]) test(`desktop ${width}px: Orion sits between the brand and the middle buttons`, async ({ page }) => {
    await openTheme(page, { width, height: 900 });
    const gap = await page.evaluate(() => {
        const header = document.querySelector(".portal-header");
        const brand = document.querySelector(".portal-header-brand").getBoundingClientRect();
        const nav = document.querySelector(".portal-header .ps-toolbar-navigation").getBoundingClientRect();
        // The constellation layer's x offset, resolved in px by a probe; its stars span 117-174 px of the tile.
        const x = getComputedStyle(header, "::before").backgroundPosition.split(",")[2].trim().split(/\s(?![^(]*\))/)[0];
        const probe = document.createElement("div");
        probe.style.cssText = `position:absolute;left:0;width:${x}`;
        header.append(probe);
        const left = header.getBoundingClientRect().left + probe.getBoundingClientRect().width;
        probe.remove();
        return { brandRight: brand.right, navLeft: nav.left, first: left + 117, last: left + 174 };
    });
    expect(gap.first).toBeGreaterThan(gap.brandRight + 40);
    expect(gap.last).toBeLessThan(gap.navLeft - 40);
    const middle = (gap.first + gap.last) / 2, wanted = (gap.brandRight + gap.navLeft) / 2;
    expect(Math.abs(middle - wanted)).toBeLessThan(40);
});

test("state signals survive the theme: focused pane, focused composer, pressed toggle, current tab", async ({ page }) => {
    await openTheme(page, { width: 1440, height: 900 });
    const states = await page.evaluate(() => {
        const style = (el) => { const s = getComputedStyle(el); return `${s.borderTopColor}|${s.backgroundColor}|${s.boxShadow}`; };
        const focused = document.querySelector(".ps-panel.is-focused");
        const unfocused = document.querySelector(".ps-panel:not(.is-focused)");
        const button = document.querySelector(".portal-header .ps-toolbar-button:not(.is-active)");
        const rest = style(button);
        button.classList.add("is-active"); const pressed = style(button); button.classList.remove("is-active");
        const row = document.createElement("div"); row.className = "ps-tab-row-icons";
        const tab = document.createElement("button"); tab.className = "ps-toolbar-button is-active"; row.append(tab); document.body.append(row);
        const tabShadow = getComputedStyle(tab).boxShadow; row.remove();
        return { focused: focused && style(focused), unfocused: unfocused && style(unfocused), rest, pressed, tabShadow };
    });
    expect(states.focused, "a pane is focused at start").toBeTruthy();
    expect(states.focused).not.toBe(states.unfocused);
    expect(states.pressed).not.toBe(states.rest);
    expect(states.tabShadow).toMatch(/0px -2px 0px 0px inset/);
    const input = page.locator(".ps-prompt-input").first();
    await input.focus();
    expect(await input.evaluate(el => getComputedStyle(el).borderTopColor)).toBe("rgb(92, 200, 242)");
});

test("reduced motion: still art for the mark, Orion and the sky", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openTheme(page, { width: 1440, height: 900 });
    const images = await layers(page);
    expect(images).toMatch(art("orion-still"));
    expect(images).toMatch(art("sky-still"));
    expect(images).not.toMatch(art("orion"));
    expect(await page.locator(".portal-logo-frame").evaluate(el => getComputedStyle(el).backgroundImage)).toMatch(art("logo-still"));
});

test("phone: Orion stays on screen, nothing scrolls sideways", async ({ page }) => {
    const failed = await openTheme(page, { width: 390, height: 844 });
    const images = await layers(page);
    expect(images).toMatch(art("orion-phone"));
    const header = await page.locator(".portal-header").boundingBox();
    expect(header.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.waitForTimeout(500);
    expect(failed).toEqual([]);
});


test("full-screen canvas: the header controls sit on a solid plate with bright text", async ({ page }) => {
    const PAGE = "<!doctype html><html><body style='margin:0;background:#123'><h1 style='color:#fff'>Canvas</h1></body></html>";
    await page.route("**/api/v1/**", route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return route.fulfill({ json: { ok: true, result: [{ seq: 1, eventType: "session.canvas_updated", data: { slot: 1, rev: 3, sizeBytes: PAGE.length, name: "Code browser" } }] } });
        }
        if (url.pathname.includes("/artifacts/") && url.pathname.includes("canvas.html")) return route.fulfill({ contentType: "text/html", body: PAGE });
        if (url.pathname.endsWith("/me/profile")) return route.fulfill({ json: { ok: true, result: { profileSettings: { themeId: "horizon-dawn" } } } });
        return route.fallback();
    });
    await page.setViewportSize({ width: 1450, height: 900 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}&view=canvas&max=1`);
    const slot = page.locator(".portal-header .ps-toolbar-canvas-slot");
    await expect(slot).toBeVisible({ timeout: 15_000 });
    await expect(slot.getByRole("button", { name: "Restore canvas" })).toBeVisible();
    const look = await slot.evaluate((el) => {
        const alpha = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); const p = m ? m[1].split(",").map(Number) : []; return p.length === 4 ? p[3] : 1; };
        const lum = (c) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map((v) => Number(v) / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const plate = getComputedStyle(el).backgroundColor;
        // The controls' text and icons: the Canvas/Workspace switch is always there.
        const text = getComputedStyle(el.querySelector(".ps-side-pane-tab:not(.is-on)") || el.querySelector(".ps-side-pane-tab")).color;
        const restore = getComputedStyle(el.querySelector('[aria-label="Restore canvas"]'));
        const a = lum(text), b = lum(plate);
        return { plateAlpha: alpha(plate), contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), restoreBorder: restore.borderTopWidth, restoreColor: restore.color, width: el.getBoundingClientRect().width };
    });
    expect(look.plateAlpha).toBeGreaterThan(0.9);
    // WCAG AA for normal text.
    expect(look.contrast).toBeGreaterThan(4.5);
    expect(parseFloat(look.restoreBorder)).toBeGreaterThan(0);
    // The plate hugs its controls rather than filling the header's left side.
    const lastRight = await slot.evaluate((el) => Math.max(...[...el.children].map((c) => c.getBoundingClientRect().right)) - el.getBoundingClientRect().left);
    expect(look.width - lastRight).toBeLessThan(16);
});
