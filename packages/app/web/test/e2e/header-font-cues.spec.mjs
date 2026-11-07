import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
let stub, base;
test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 3, transcriptTurns: 8 });
    base = `http://127.0.0.1:${stub.port}`;
});
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });
const sid = i => `1111111${i}-2222-3333-4444-55555555555${i}`;

test("the desktop toolbar changes from two rows to one at 1040 container pixels", async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.goto(base);
    const slot = page.locator(".portal-header-slot");
    const toolbar = slot.locator(".ps-toolbar:not(.is-mobile)");
    await expect(toolbar).toBeVisible();
    for (const [width, rows] of [[1039, 2], [1041, 1]]) {
        await slot.evaluate((el, width) => {
            el.style.flex = `0 0 ${width}px`;
            el.style.width = `${width}px`;
        }, width);
        expect(Math.round((await slot.boundingBox()).width)).toBe(width);
        await expect.poll(() => toolbar.evaluate(el => getComputedStyle(el).gridTemplateRows.split(" ").length)).toBe(rows);
    }
});

test("code uses the bundled mono face and loadingdone remeasures pane columns", async ({ page }) => {
    await page.route("**/api/v1/me/profile", route => route.fulfill({ json: { ok: true, result: {
        profileSettings: { codeFont: "jetbrains" },
    } } }));
    const externalFonts = [];
    const bundledFonts = [];
    page.on("request", req => {
        if (req.resourceType() !== "font") return;
        if (new URL(req.url()).origin !== base) externalFonts.push(req.url());
        else bundledFonts.push(req.url());
    });
    await page.goto(base + `/?session=${sid(0)}`);
    await expect(page.locator("html")).toHaveAttribute("data-ps-mono", "jetbrains");
    const code = page.locator(".ps-chat-panel code").first();
    await expect(code).toBeVisible();
    const font = await code.evaluate(el => getComputedStyle(el).fontFamily);
    expect(font.split(",")[0].trim().replace(/^["']|["']$/g, "")).toBe("PS JetBrains Mono");
    const faces = await page.evaluate(async () => {
        await document.fonts.ready;
        await document.fonts.load('14px "PS JetBrains Mono"');
        return [...document.fonts].filter(face => face.family.includes("PS JetBrains Mono")).map(face => face.status);
    });
    expect(faces.length).toBeGreaterThan(0);
    expect(faces).toContain("loaded");
    expect(externalFonts).toEqual([]);
    const css = await page.locator('link[rel="stylesheet"]').first().evaluate(async el => (await fetch(el.href)).text());
    expect(css).toMatch(/font-family:["']?PS JetBrains Mono/);
    expect(bundledFonts.some(url => /\/assets\/jetbrains-mono-.*\.woff2$/.test(url))).toBe(true);
    // Observe the real measurement primitive, not a product-only test hook.
    await page.evaluate(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.columnProbes = 0;
        const original = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function (...args) {
            if (this.tagName === "SPAN" && this.textContent === "0".repeat(100)) window.columnProbes++;
            return original.apply(this, args);
        };
        document.fonts.dispatchEvent(new Event("loadingdone"));
    });
    await expect.poll(() => page.evaluate(() => window.columnProbes)).toBeGreaterThan(0);
});

async function soundFixture(page) {
    await page.addInitScript(() => {
        window.audioNotes = [];
        const param = () => ({ value: 0, cancelScheduledValues() {}, setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
        const node = extra => ({ connect() {}, disconnect() {}, ...extra });
        class AudioContext {
            constructor() { this.sampleRate = 100; this.currentTime = 0; this.state = "running"; this.destination = node(); }
            createGain() { return node({ gain: param() }); }
            createDynamicsCompressor() { return node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }); }
            createBuffer(_channels, length) { return { length, getChannelData: () => new Float32Array(length) }; }
            createBufferSource() { return node({ start() {}, stop() {} }); }
            createBiquadFilter() { return node({ frequency: param(), Q: param() }); }
            createConvolver() { return node(); }
            createOscillator() {
                let at = 0;
                const osc = node({ frequency: param(), detune: param(), start(time) { at = time; }, stop(end) {
                    if (end !== undefined) window.audioNotes.push({ frequency: osc.frequency.value, duration: end - at });
                } });
                return osc;
            }
            resume() { return Promise.resolve(); }
            close() { return Promise.resolve(); }
        }
        window.AudioContext = AudioContext;
    });
    await page.route("**/api/v1/me/profile", route => route.fulfill({ json: { ok: true, result: {
        profileSettings: { themeId: "horizon-dawn", themeSound: { on: true, volume: 40 } },
    } } }));
    await page.route("**/api/v1/bootstrap", route => route.fulfill({ json: { ok: true, result: {
        auth: { principal: { provider: "none", subject: "test", email: "test@example.com" }, authorization: { role: "user", allowed: true } },
    } } }));
    await page.route("**/access", route => route.fulfill({ json: { ok: true, result: { canManage: true, canWrite: true, relation: "owner", owner: { provider: "none", subject: "test" } } } }));
    await page.goto(base + `/?session=${sid(0)}`);
    await expect(page.locator(".ps-chat-panel textarea")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.audioNotes.length)).toBeGreaterThan(0);
}
const cueNotes = (page, name) => page.evaluate(name => window.audioNotes.filter(note => {
    if (name === "tick") return note.frequency >= 2300 && note.frequency <= 2800 && note.duration < 0.2;
    if (name === "send") return note.frequency === 880 && note.duration < 1;
    return note.frequency === 293.66 && note.duration < 3;
}).length, name);

test("an empty Send has no cue, while an enabled tab ticks", async ({ page }) => {
    await soundFixture(page);
    const sends = await cueNotes(page, "send");
    await page.locator(".ps-chat-panel .ps-send-button").click();
    expect(await cueNotes(page, "send")).toBe(sends);
    const ticks = await cueNotes(page, "tick");
    await page.locator(`.ps-session-list-button[data-session-id="${sid(0)}"]`).click();
    await page.getByRole("button", { name: /^Manage session/ }).first().click();
    const beforeTab = await cueNotes(page, "tick");
    await page.getByRole("tab", { name: "General", exact: true }).click();
    await expect.poll(() => cueNotes(page, "tick")).toBeGreaterThan(beforeTab);
    await expect.poll(() => cueNotes(page, "tick")).toBeGreaterThan(ticks);
    await page.locator(".ps-share-modal").getByRole("button", { name: "Close", exact: true }).click();
    await page.locator(".ps-chat-panel textarea").fill("a real outgoing message");
    await page.locator(".ps-chat-panel .ps-send-button").click();
    await expect.poll(() => cueNotes(page, "send")).toBeGreaterThan(sends);
});

test("a transition from another session's running turn to an idle session does not chime", async ({ page }) => {
    let completed = false;
    await page.route(url => /\/api\/v1\/sessions(?:\/[^/]+)?$/.test(url.pathname), async route => {
        if (route.request().method() !== "GET") return route.fallback();
        const response = await route.fetch();
        const json = await response.json();
        const update = session => session.sessionId === sid(1)
            ? { ...session, status: completed ? "idle" : "running", title: completed ? "Finished background turn" : session.title }
            : session;
        if (json.result?.sessions) json.result.sessions = json.result.sessions.map(update);
        else if (json.result?.sessionId) json.result = update(json.result);
        return route.fulfill({ response, json });
    });
    await soundFixture(page);
    const done = await cueNotes(page, "done");
    const activeTitle = await page.locator(".ps-chat-panel .ps-panel-title").first().textContent();
    completed = true;
    await page.getByRole("button", { name: "Refresh session order", exact: true }).click();
    await expect(page.locator(`.ps-session-list-button[data-session-id="${sid(1)}"]`)).toContainText("Finished background turn");
    await expect(page.locator(".ps-chat-panel .ps-panel-title").first()).toHaveText(activeTitle);
    expect(await cueNotes(page, "done")).toBe(done);
    await page.locator(`.ps-session-list-button[data-session-id="${sid(1)}"]`).click();
    await expect(page.locator(".ps-chat-panel .ps-panel-title").first()).toContainText("Finished background turn");
    expect(await cueNotes(page, "done")).toBe(done);
});
