// Shared helpers for the "Publish as app" browser specs (desktop and phone).
// Not a spec file: playwright.config.mjs only collects *.spec.mjs.
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";

export const sessionId = "11111110-2222-3333-4444-555555555550";
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** A drawn canvas the active session owns, served by route. */
export async function drawOwnCanvas(page, base) {
    const html = "<!doctype html><!-- CANVAS-APP-MANIFEST {\"name\":\"Team-Board\",\"interface\":{\"keys\":[],\"requests\":[],\"events\":[]}} --><p>board</p>";
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return route.fulfill({ json: { ok: true, result: [{ seq: 1, eventType: "session.canvas_updated", data: { slot: 1, rev: 1, sizeBytes: Buffer.byteLength(html, "utf8"), name: "board", trust: "owner", pageSha256: sha256(html) } }] } });
        }
        if (url.pathname.endsWith("/artifacts/canvas.html/download")) return route.fulfill({ contentType: "text/html", body: html });
        return route.fallback();
    });
    await page.goto(`${base}/?session=${sessionId}`);
    // Wait until the deep-linked session is the active one. The canvas toggle
    // is on screen while the app is still starting, and a session change
    // resets the phone's canvas pane by design (web-app.js: the canvas
    // remounts fresh per session), so a click before then is undone.
    await expect(page.locator(`.ps-session-list-button[data-session-id="${sessionId}"][aria-selected="true"]`)).toHaveCount(1, { timeout: 30_000 });
    const show = page.getByRole("button", { name: "Show canvas", exact: true });
    const hide = page.getByRole("button", { name: "Hide the canvas", exact: true });
    await show.or(hide).first().waitFor();
    if (await show.isVisible()) await show.click();
    await expect(hide.first()).toBeVisible();
}

export async function publishFlow(page, stub) {
    const button = page.getByRole("button", { name: "Publish as app" }).first();
    await expect(button).toBeVisible();
    await button.click();
    const dialog = page.locator("form.ps-canvas-publish");
    await expect(dialog.locator(".ps-canvas-publish__check")).toContainText("Manifest check passed");
    // The check is the only call so far, and it is checkOnly.
    expect(stub.canvasAppCalls).toEqual([expect.objectContaining({ op: "publishCanvasApp", sessionId, slot: 1, checkOnly: true })]);
    await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("team-board");
    await expect(dialog.getByRole("textbox", { name: /Version/ })).toHaveValue("1.4.0");
    await expect(dialog.getByRole("textbox", { name: /Tags/ })).toHaveValue("team, board");
    await dialog.getByRole("radio", { name: /Shared/ }).check();
    await dialog.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(dialog).toContainText("Published team-board@1.4.0 (shared)");
    expect(stub.canvasAppCalls[1]).toMatchObject({ op: "publishCanvasApp", sessionId, slot: 1, name: "team-board", scope: "shared", version: "1.4.0", tags: ["team", "board"] });
    expect(stub.canvasAppCalls[1].checkOnly).toBeUndefined();
    return dialog;
}

