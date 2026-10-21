import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

test.use({ channel: "msedge" });

let script;
test.beforeAll(async () => {
    const bundle = await build({
        stdin: {
            contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { PackageReviewTabs } from "./packages/app/ui/react/src/package-review-tabs.js";
const candidates = ["alpha", "beta"].map(name => ({
    name, packageId: name, versionId: name + "-v1", sha256: "a".repeat(64),
    semver: "1.0.0", revision: 1, scope: "shared", decision: "pending",
    inspection: { reasons: [], approvalBlockers: [], files: [] }
}));
globalThis.reportRequests = [];
globalThis.launches = [];
const controller = {
    transport: {
        listAgentPackageReviews: async () => candidates,
        getAgentPackageReviewDiff: async input => ({
            candidate: candidates.find(c => c.packageId === input.packageId),
            baseline: null, baselineSource: "none", changes: [],
            summary: { total: 0, executable: 0, dependency: 0, capability: 0, "precheck-policy": 0, declarative: 0, flagged: 0 }
        }),
        getAgentPackageReviewReport: input => new Promise((resolve, reject) => reportRequests.push({ input, resolve, reject }))
    },
    createSessionForAgent: async (name, options) => { launches.push({ name, options }); return { sessionId: "reviewer-session" }; }
};
globalThis.finishReport = (index, mismatch = false) => {
    const request = reportRequests[index];
    const candidate = { ...request.input, ...(mismatch ? { versionId: "other-version" } : {}) };
    request.resolve({
        candidate, baseline: null,
        report: { reportId: String(index), ...candidate, baseline: null,
            content: { facts: [request.input.packageId + " report " + index], analysis: "Analysis", guide: [], risks: [] } }
    });
};
createRoot(document.getElementById("root")).render(
    React.createElement(PackageReviewTabs, { controller, view: { isAdmin: true, settingsTree: [] } }));
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

test.beforeEach(async ({ page }) => {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    await page.getByRole("tab", { name: "Pending Approval" }).click();
});

async function openDiff(page, name, count) {
    await page.locator("article").filter({
        has: page.getByRole("heading", { name: `${name}@1.0.0 · artifact content: pending`, exact: true }),
    }).getByRole("button", { name: "Review diff", exact: true }).click();
    await expect(page.getByRole("heading", { name: `Review diff · ${name}@1.0.0`, exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => reportRequests.length)).toBe(count);
}

async function finishReport(page, index, mismatch = false) {
    await page.evaluate(async ({ index, mismatch }) => {
        finishReport(index, mismatch);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, { index, mismatch });
}

test("a late report for another candidate cannot replace the current report, even with the same digest", async ({ page }) => {
    await openDiff(page, "alpha", 1);
    // An open diff fills the page; switching candidates goes back to the list first.
    await page.getByRole("button", { name: "← Back to Pending Approval", exact: true }).click();
    await openDiff(page, "beta", 2);
    await finishReport(page, 1);
    const report = page.getByRole("region", { name: "Advisory review report" });
    await expect(report).toContainText("beta report 1");
    await finishReport(page, 0);
    await expect(report).toContainText("beta report 1");
    await expect(report).not.toContainText("alpha report");
});

test("report matching checks the version identity, not just identical artifact bytes", async ({ page }) => {
    await openDiff(page, "alpha", 1);
    await finishReport(page, 0, true);
    const report = page.getByRole("region", { name: "Advisory review report" });
    await expect(report).toContainText("No advisory report for this exact candidate and baseline.");
    await expect(report).not.toContainText("alpha report 0");
});

test("the newest refresh wins over an earlier report request", async ({ page }) => {
    await openDiff(page, "alpha", 1);
    await page.getByRole("button", { name: "Refresh report", exact: true }).click();
    await expect.poll(() => page.evaluate(() => reportRequests.length)).toBe(2);
    await finishReport(page, 1);
    await finishReport(page, 0);
    const report = page.getByRole("region", { name: "Advisory review report" });
    await expect(report).toContainText("alpha report 1");
    await expect(report).not.toContainText("alpha report 0");
});

test("closing a diff invalidates its pending report without blocking decisions or agent launch", async ({ page }) => {
    await openDiff(page, "alpha", 1);
    await page.getByRole("button", { name: "Close diff", exact: true }).click();
    await finishReport(page, 0);
    await expect(page.getByRole("region", { name: "Advisory review report" })).toHaveCount(0);
    await openDiff(page, "beta", 2);
    await expect(page.getByRole("button", { name: "Approve this digest", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Ask package-reviewer", exact: true }).click();
    const launches = await page.evaluate(() => launches);
    expect(launches).toHaveLength(1);
    expect(launches[0].name).toBe("package-reviewer");
    expect(launches[0].options.initialPrompt).toContain("package_id: beta");
    expect(launches[0].options.initialPrompt).toContain("version_id: beta-v1");
    expect(launches[0].options.initialPrompt).toContain(`sha256: ${"a".repeat(64)}`);
});
