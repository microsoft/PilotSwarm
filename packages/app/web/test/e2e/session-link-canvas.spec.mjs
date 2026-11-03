// The session Copy link dialog's "Include canvas" option, in a real browser.
//
//   opening the dialog copies the plain session link, exactly as before
//   ticking the box shows AND copies the link with view=canvas&slot=<n>
//   the picker re-points the link at another canvas, and copies it
//   every click opens a fresh dialog: the box never stays ticked over a plain link
//   the produced link opens the session with that canvas beside the chat
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const CANVAS = "<!doctype html><html><body style=\"background:#123;color:#fff\"><h1 id=\"t\">canvas</h1></body></html>";

// Two drawn canvases, slots 1 and 3, named so the picker has something to show.
async function withCanvases(page) {
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return route.fulfill({ json: { ok: true, result: [
                { seq: 1, eventType: "session.canvas_updated", data: { slot: 1, rev: 1, sizeBytes: CANVAS.length, name: "Release board" } },
                { seq: 2, eventType: "session.canvas_updated", data: { slot: 3, rev: 1, sizeBytes: CANVAS.length, name: "Latency chart" } },
            ] } });
        }
        if (url.pathname.includes("/artifacts/") && url.pathname.includes("canvas")) {
            return route.fulfill({ contentType: "text/html", body: CANVAS });
        }
        return route.fallback();
    });
}

async function openSession(page) {
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await page.getByRole("button", { name: "Show canvas", exact: true })
        .or(page.getByRole("button", { name: "Hide the canvas", exact: true })).first().waitFor();
}

const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
const copyLinkButton = (page) => page.getByRole("button", { name: /^Copy link — copy a direct link to this session/ }).first();

test("Include canvas changes the shown and copied link; unticked it is the plain link", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await withCanvases(page);
    await openSession(page);
    const plain = `http://127.0.0.1:${stub.port}/?session=${sessionId}`;

    await copyLinkButton(page).click();
    const dialog = page.locator(".ps-link-modal");
    const box = dialog.getByRole("textbox", { name: "Session link" });
    const include = dialog.getByRole("checkbox", { name: /Include canvas/ });
    await expect(box).toHaveValue(plain);
    await expect.poll(() => clipboard(page)).toBe(plain);
    await expect(include).not.toBeChecked();

    await include.check();
    const picker = dialog.getByRole("combobox", { name: "Canvas to open" });
    await expect(picker).toBeEnabled();
    const chosen = Number(await picker.inputValue());
    expect([1, 3]).toContain(chosen);
    await expect(box).toHaveValue(`${plain}&view=canvas&slot=${chosen}`);
    await expect.poll(() => clipboard(page)).toBe(`${plain}&view=canvas&slot=${chosen}`);

    const other = chosen === 1 ? 3 : 1;
    await picker.selectOption(String(other));
    await expect(box).toHaveValue(`${plain}&view=canvas&slot=${other}`);
    await expect.poll(() => clipboard(page)).toBe(`${plain}&view=canvas&slot=${other}`);
    // The whole link is visible: the box wraps instead of hiding the end.
    const wraps = await box.evaluate((el) => getComputedStyle(el).whiteSpace);
    expect(wraps).toBe("pre-wrap");

    await include.uncheck();
    await expect(box).toHaveValue(plain);
    await expect.poll(() => clipboard(page)).toBe(plain);
});

test("each Copy link click opens a fresh dialog with the box unticked", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await withCanvases(page);
    await openSession(page);
    await copyLinkButton(page).click();
    const dialog = page.locator(".ps-link-modal");
    await dialog.getByRole("checkbox", { name: /Include canvas/ }).check();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    await copyLinkButton(page).click();
    await expect(page.locator(".ps-link-modal").getByRole("checkbox", { name: /Include canvas/ })).not.toBeChecked();
    await expect.poll(() => clipboard(page)).toBe(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
});

test("the produced link opens the session with the chosen canvas beside the chat", async ({ page }) => {
    await withCanvases(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}&view=canvas&slot=3`);
    await expect(page.getByRole("button", { name: "Hide the canvas", exact: true }).first()).toBeVisible();
    // Beside the chat, not covering it: the composer is still on screen.
    await expect(page.locator(".ps-prompt-input").first()).toBeVisible();
});
