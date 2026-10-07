import { test, expect, chromium, webkit, devices } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sessionId = "11111110-2222-3333-4444-555555555550";
const otherId = "11111111-2222-3333-4444-555555555551";
const actor = { kind: "user", provider: "none", subject: "test" };
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

async function open(page, mobile = false, viewport = null) {
    await page.setViewportSize(viewport || { width: mobile ? 390 : 1440, height: 844 });
    await page.route("**/api/v1/bootstrap", async route => {
        const response = await route.fetch();
        const payload = await response.json();
        const bootstrap = payload.result || payload;
        bootstrap.auth = { principal: { provider: actor.provider, subject: actor.subject, displayName: "Test User" },
            authorization: { allowed: true, role: "user" } };
        await route.fulfill({ json: payload });
    });

    const events = [1, 2].map(seq => ({ sessionId, seq, eventType: "user.message",
        createdAt: 1000 + seq, data: { content: `Own input ${seq}`, sender: actor,
            ...(seq === 2 ? { steering: { requestId: "delivered-guidance", revision: 2 } } : {}) } }));
    events.push({ sessionId, seq: 3, eventType: "user.message", createdAt: 1003,
        data: { content: "Other writer text", sender: { ...actor, subject: "other" } } });
    await page.route(`**/sessions/${sessionId}/events?*`, route => route.fulfill({ json: { ok: true, result: events } }));
    await page.route(`**/sessions/${otherId}/events?*`, route => route.fulfill({ json: { ok: true, result: [] } }));
    await page.route(`**/sessions/${sessionId}/messages`, route => route.fulfill({ json: { ok: true, result: { queued: true } } }));
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    const input = page.getByTestId("session-prompt");
    await expect(input).toBeVisible();
    await expect(page.locator(".ps-chat-panel")).toContainText("Other writer text");
    return input;
}

test("iPad hardware arrows recall and restore drafts with the keyboard viewport open", async () => {
    const browser = await webkit.launch();
    const context = await browser.newContext({ ...devices["iPad (gen 7)"] });
    try {
        const page = await context.newPage();
        const input = await open(page, true, { width: 810, height: 600 });
        await input.fill("Tablet draft");
        await input.press("ArrowUp");
        await expect(input).toHaveValue("Own input 2");
        await input.press("ArrowDown");
        await expect(input).toHaveValue("Tablet draft");
        await page.setViewportSize({ width: 1080, height: 600 });
        await input.press("ArrowUp");
        await expect(input).toHaveValue("Own input 2");
        await input.press("ArrowDown");
        await expect(input).toHaveValue("Tablet draft");
    } finally {
        await context.close();
        await browser.close();
    }
});

function browserCase(browserName, run) {
    return async () => {
        const browser = await ({ chromium, webkit })[browserName].launch();
        try { await run(await browser.newPage()); }
        finally { await browser.close(); }
    };
}

async function reloadWithHistoryReady(page, input, texts) {
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    const pattern = `**/sessions/${sessionId}/events?*`;
    const holdHistory = async route => {
        entered.resolve();
        await released.promise;
        await route.fallback();
    };
    await page.route(pattern, holdHistory);
    try {
        await page.reload();
        await expect(input).toBeVisible();
        await entered.promise;
        const transcript = page.locator(".ps-chat-panel .ps-scroll-panel");
        await expect(transcript.getByText(texts[0], { exact: true })).toHaveCount(0);
        released.resolve();
        // A rendered authoritative transcript page also supplies the recall
        // selector's events. Input visibility or a network response alone does not.
        for (const text of texts) await expect(transcript.getByText(text, { exact: true })).toBeVisible();
    } finally {
        released.resolve();
        await page.unroute(pattern, holdHistory);
    }
}

for (const browserName of ["chromium", "webkit"]) test.describe(browserName, () => {
test("desktop recalls own ordinary and delivered steering input, protects draft, and exits on edit", browserCase(browserName, async page => {
    const input = await open(page);
    await input.fill("Unsent draft");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Own input 2");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Own input 1");
    await input.press("ArrowDown");
    await expect(input).toHaveValue("Own input 2");
    await input.press("ArrowDown");
    await expect(input).toHaveValue("Unsent draft");
    await input.press("ArrowUp");
    await input.press("End");
    await input.press("!");
    await input.press("ArrowDown");
    await expect(input).toHaveValue("Own input 2!");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Own input 2");
    await input.press("ArrowDown");
    await expect(input).toHaveValue("Own input 2!");
}));

test("desktop only captures first/last visual lines and respects reference menus", browserCase(browserName, async page => {
    const input = await open(page);
    await input.fill("first line\nlast line");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("first line\nlast line");
    await input.press("Home");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Own input 2");
    await input.fill("This long line should wrap inside the composer. ".repeat(12));
    const long = await input.inputValue();
    await input.press("ArrowUp");
    await expect(input).toHaveValue(long);
    await input.fill("@artifact");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("@artifact");
}));

test("IME composition retains the draft instead of recalling history", browserCase(browserName, async page => {
    const input = await open(page);
    await input.fill("Composition draft");
    await input.evaluate(node => node.addEventListener("keydown", event => {
        node.dataset.observedComposition = String(event.isComposing);
    }, { once: true }));
    await input.dispatchEvent("keydown", { key: "ArrowUp", code: "ArrowUp", isComposing: true });
    await expect(input).toHaveAttribute("data-observed-composition", "true");
    await expect(input).toHaveValue("Composition draft");
}));

test("composition lifecycle and legacy composing keycode retain drafts before Enter and Steer shortcuts", browserCase(browserName, async page => {
    const input = await open(page);
    const messages = [];
    page.on("request", request => {
        if (request.url().endsWith(`/sessions/${sessionId}/messages`)) messages.push(request);
    });
    await input.fill("Composition lifecycle draft");
    await input.dispatchEvent("compositionstart", { data: "draft" });
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter" });
    await input.dispatchEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true });
    await input.dispatchEvent("keydown", { key: "ArrowUp", code: "ArrowUp" });
    await expect(input).toHaveValue("Composition lifecycle draft");
    await input.dispatchEvent("compositionend", { data: "draft" });
    await input.dispatchEvent("keydown", { key: "ArrowUp", code: "ArrowUp", keyCode: 229 });
    await expect(input).toHaveValue("Composition lifecycle draft");
    expect(messages).toHaveLength(0);
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Own input 2");
}));

test("reload recalls the viewer's accepted receipt before delivery and never another writer's receipt", browserCase(browserName, async page => {
    const input = await open(page);
    const own = {
        schemaVersion: 1, sessionId, requestId: "accepted-own", clientRequestId: "caller-own",
        expectedTarget: "old-target", sequence: 1, acceptedAt: new Date(2).toISOString(), actor,
        text: "Own accepted pending guidance", revision: 1, status: "pending", disposition: "accepted",
        eligibility: { state: "pending", reason: "awaiting_handoff" },
        inclusion: { state: "not_included", snapshotVersion: null }, recoveryFlags: [],
        attempts: { total: 0, items: [], nextCursor: null },
    };
    const events = [
        { sessionId, seq: 1, eventType: "user.message", createdAt: 1, data: {
            content: "Own ordinary before receipt", sender: actor, clientMessageIds: ["ordinary-one"],
        } },
        { sessionId, seq: 2, eventType: "session.steering_accepted", createdAt: 2, data: { receipt: own } },
        { sessionId, seq: 3, eventType: "session.steering_accepted", createdAt: 3, data: { receipt: {
            ...own, requestId: "accepted-other", sequence: 2, actor: { ...actor, subject: "other" }, text: "Other accepted private guidance",
        } } },
    ];
    await page.route(`**/sessions/${sessionId}/events?*`, route => route.fulfill({ json: { ok: true, result: events } }));
    await reloadWithHistoryReady(page, input, ["Own accepted pending guidance", "Own ordinary before receipt"]);
    await input.fill("Reload unsent draft");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Own accepted pending guidance");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Own ordinary before receipt");
    await input.press("ArrowDown");
    await input.press("ArrowDown");
    await expect(input).toHaveValue("Reload unsent draft");
}));

test("selected ranges and active suggestion menus retain native arrows", browserCase(browserName, async page => {
    const input = await open(page);
    await input.fill("Composition draft");
    await input.evaluate(node => node.setSelectionRange(0, 5));
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Composition draft");
    await input.evaluate(node => { node.setSelectionRange(0, 0); node.setAttribute("aria-activedescendant", "fixture-option"); });
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Composition draft");
    await input.evaluate(node => node.removeAttribute("aria-activedescendant"));
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Own input 2");
}));

test("reload reconstructs viewer-owned input history without exposing the other participant", browserCase(browserName, async page => {
    const input = await open(page);
    await input.fill("Draft before reload");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Own input 2");
    await reloadWithHistoryReady(page, input, ["Own input 1", "Other writer text"]);
    await input.fill("Fresh reload draft");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Own input 2");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Own input 1");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Own input 1");
    await input.press("ArrowDown");
    await input.press("ArrowDown");
    await expect(input).toHaveValue("Fresh reload draft");
}));

test("accepted input enters recall immediately; session changes reset navigation", browserCase(browserName, async page => {
    const input = await open(page);
    await input.fill("New accepted input");
    const sent = page.waitForResponse(response => response.url().endsWith(`/sessions/${sessionId}/messages`));
    await input.press("Enter");
    await sent;
    await expect(input).toHaveValue("");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("New accepted input");
    await page.locator(`.ps-session-list-button[data-session-id="${otherId}"]`).click();
    await input.fill("Other draft");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Other draft");
    await input.press("ArrowDown");
    await expect(input).toHaveValue("Other draft");
}));

test("mobile textarea arrows do not enable history recall", browserCase(browserName, async page => {
    const input = await open(page, true);
    await input.fill("Mobile draft");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Mobile draft");
}));
});
