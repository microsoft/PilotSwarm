import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

test.use({ channel: "msedge" });

// The review diff loads a file list first and each file's patch on demand.
let script;
test.beforeAll(async () => {
    const bundle = await build({
        stdin: {
            contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { PackageReviewTabs } from "./packages/app/ui/react/src/package-review-tabs.js";
const sha = (c) => c.repeat(64);
const candidate = { name: "big-kit", packageId: "pkg", versionId: "v2", sha256: sha("b"), semver: "2.0.0", revision: 1,
    scope: "shared", decision: "pending", inspection: { reasons: [], approvalBlockers: [], files: [] } };
const baseline = { packageId: "pkg", versionId: "v1", sha256: sha("a"), semver: "1.0.0", decision: "approved" };
const paths = Array.from({ length: 40 }, (_, i) => "tools/module-" + String(i).padStart(2, "0") + ".mjs");
const params = new URLSearchParams(location.search);
globalThis.diffRequests = [];
globalThis.fileRequests = [];
globalThis.failNext = params.get("fail") === "1";
globalThis.staleNext = params.get("stale") === "1";
const perFile = params.get("legacy") !== "1";
const longPatch = params.get("long") === "1";
const patchFor = (path) => "--- a/" + path + "\\n+++ b/" + path + "\\n@@ -1,1 +1,1 @@\\n-old " + path + "\\n+new " + path
    + (longPatch ? Array.from({ length: 300 }, (_, i) => "\\n+line " + i + " " + "x".repeat(400)).join("") : "");
const change = (path, withPatch) => ({ path, status: "modified", group: "executable", additions: 1, deletions: 1,
    ...(withPatch ? { diff: patchFor(path) } : { diff: null, patchOmitted: true }) });
const transport = {
    listAgentPackageReviews: async () => [candidate],
    getAgentPackageReviewDiff: async (input) => {
        diffRequests.push(input);
        return { candidate, baseline, baselineSource: "approved", identical: false, advisory: "Review aid only.",
            summary: { executable: paths.length, dependency: 0, capability: 0, "precheck-policy": 0, declarative: 0, flagged: 0, total: paths.length },
            changes: paths.map((path) => change(path, input.patches !== false)), inspectionReasons: [] };
    },
    ...(perFile ? { getAgentPackageReviewFileDiff: async (input) => {
        fileRequests.push(input);
        if (failNext) { failNext = false; throw new Error("temporary outage"); }
        const stale = staleNext;
        return { candidate: { packageId: "pkg", versionId: "v2", sha256: stale ? sha("c") : sha("b") },
            baseline: { versionId: "v1", sha256: sha("a") }, baselineSource: "approved", change: change(input.path, true) };
    } } : {}),
};
createRoot(document.getElementById("root")).render(
    React.createElement(PackageReviewTabs, { controller: { transport }, view: { isAdmin: true, settingsTree: [] } }));
`,
            resolveDir: fileURLToPath(new URL("../../../../../", import.meta.url)),
            loader: "js",
        },
        bundle: true,
        write: false,
        format: "iife",
        define: { "process.env.NODE_ENV": '"test"' },
    });
    script = bundle.outputFiles[0].text;
});

async function open(page, query = "", { styled = false } = {}) {
    await page.route("http://review.local/**", (route) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto(`http://review.local/${query}`);
    if (styled) await page.addStyleTag({ path: fileURLToPath(new URL("../../src/index.css", import.meta.url)) });
    await page.addScriptTag({ content: script });
    await page.getByRole("tab", { name: "Pending Approval" }).click();
    await page.getByRole("button", { name: "Review diff", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Changed files" })).toBeVisible();
}

const fileRow = (page, path) => page.getByRole("navigation", { name: "Changed files" }).getByRole("button", { name: new RegExp(path.replace(/[.]/g, "\\.")) });
const patch = (page) => page.locator(".ps-review-diff__patch");

test("a large review lists every file and loads only the selected file's patch, once", async ({ page }) => {
    await open(page);
    expect((await page.evaluate(() => diffRequests))[0].patches).toBe(false);
    await expect(page.getByRole("navigation", { name: "Changed files" }).getByRole("button")).toHaveCount(40);
    await expect(patch(page)).toContainText("+new tools/module-00.mjs");
    await expect(patch(page).locator(".is-add")).toHaveCount(1);
    await expect(patch(page).locator(".is-del")).toHaveCount(1);
    expect(await page.evaluate(() => fileRequests.map((r) => r.path))).toEqual(["tools/module-00.mjs"]);

    await fileRow(page, "tools/module-07.mjs").click();
    await expect(patch(page)).toContainText("+new tools/module-07.mjs");
    await expect(fileRow(page, "tools/module-07.mjs")).toHaveAttribute("aria-current", "true");
    await fileRow(page, "tools/module-00.mjs").click();
    await expect(patch(page)).toContainText("+new tools/module-00.mjs");
    expect(await page.evaluate(() => fileRequests.map((r) => r.path)), "a revisited file comes from the cache")
        .toEqual(["tools/module-00.mjs", "tools/module-07.mjs"]);
    const request = (await page.evaluate(() => fileRequests))[0];
    expect(request).toMatchObject({ packageId: "pkg", versionId: "v2", sha256: "b".repeat(64), baselineVersionId: null });
    await expect(page.getByRole("button", { name: "Approve this digest", exact: true })).toBeEnabled();
});

test("a failed file load can be retried", async ({ page }) => {
    await open(page, "?fail=1");
    await expect(page.getByRole("alert")).toContainText("Could not load this file: temporary outage");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(patch(page)).toContainText("+new tools/module-00.mjs");
});

test("a file answered for a different digest is refused, never shown", async ({ page }) => {
    await open(page, "?stale=1");
    await expect(page.getByRole("alert")).toContainText("the review changed since this diff was opened");
    await expect(patch(page)).toHaveCount(0);
});

test("a server without per-file loading still shows full patches", async ({ page }) => {
    await open(page, "?legacy=1");
    expect((await page.evaluate(() => diffRequests))[0].patches).toBeUndefined();
    await expect(patch(page)).toContainText("+new tools/module-00.mjs");
    await fileRow(page, "tools/module-03.mjs").click();
    await expect(patch(page)).toContainText("+new tools/module-03.mjs");
});

test("an open diff replaces the review list, and Back returns to the review it came from", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("tablist", { name: "Package catalogs" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Refresh reviews" })).toHaveCount(0);
    const back = page.getByRole("button", { name: "← Back to Pending Approval" });
    await expect(back).toBeFocused();
    await back.click();
    await expect(page.getByRole("navigation", { name: "Changed files" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Pending Approval" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "Review diff", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Review diff", exact: true }).click();
    await page.getByRole("button", { name: "Close diff", exact: true }).click();
    await expect(page.getByRole("button", { name: "Refresh reviews" })).toBeVisible();
});

test("a long, wide patch scrolls inside its pane and never covers the controls below", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await open(page, "?long=1", { styled: true });
    await expect(patch(page)).toContainText("+line 299");
    const box = async (selector) => page.locator(selector).first().boundingBox();
    const body = await box(".ps-review-diff__body");
    const file = await box(".ps-review-diff__file");
    const actions = await page.getByRole("button", { name: "Approve this digest", exact: true }).boundingBox();
    expect(file.y + file.height).toBeLessThanOrEqual(body.y + body.height + 1);
    expect(file.x + file.width).toBeLessThanOrEqual(body.x + body.width + 1);
    expect(actions.y).toBeGreaterThanOrEqual(body.y + body.height);
    const scroll = await page.locator(".ps-review-diff__file").evaluate((el) =>
        ({ vertical: el.scrollHeight > el.clientHeight, horizontal: el.scrollWidth > el.clientWidth }));
    expect(scroll).toEqual({ vertical: true, horizontal: true });
});