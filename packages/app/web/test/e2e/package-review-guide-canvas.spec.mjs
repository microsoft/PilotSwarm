import { test, expect } from "@playwright/test";
import { renderPackageReviewGuideHtml } from "../../../../sdk/dist/package-review-guide-canvas.js";

test.use({ channel: "msedge" });

// The package-reviewer's guided review canvas: a platform template filled
// from a saved report and the verified diff. Package text must stay inert.
const HOSTILE = '</script><script>globalThis.pwned = 1</script><img src=x onerror="globalThis.pwned = 2">';
const sha = (c) => c.repeat(64);

function page(content) {
    return renderPackageReviewGuideHtml({
        diff: {
            candidate: { packageId: "pkg", versionId: "v2", sha256: sha("b"), semver: "2.0.0", name: "kit" },
            baseline: { packageId: "pkg", versionId: "v1", sha256: sha("a"), semver: "1.0.0" },
            baselineSource: "approved",
            changes: [
                { path: "tools/q.mjs", status: "modified", group: "executable", additions: 1, deletions: 1,
                    diff: `--- a/tools/q.mjs\n+++ b/tools/q.mjs\n@@ -1 +1 @@\n-export const a = 1;\n+${HOSTILE}` },
                { path: "plugin.json", status: "modified", group: "precheck-policy", additions: 1, deletions: 1, changedKeys: ["cronPrechecks"],
                    diff: "--- a/plugin.json\n+++ b/plugin.json\n@@ -1 +1 @@\n-{}\n+{\"cronPrechecks\":{}}" },
            ],
        },
        report: {
            reportId: "rep-1", packageId: "pkg", versionId: "v2", sha256: sha("b"), baseline: { versionId: "v1", sha256: sha("a") },
            sessionId: "s1", author: { provider: "entra", subject: "admin" }, createdAt: new Date("2026-01-02T03:04:05Z"),
            content,
        },
    });
}

const content = {
    analysis: `The tool changes. ${HOSTILE}`,
    facts: ["tools/q.mjs changed", HOSTILE],
    guide: [
        { step: "Read the executable change", detail: "Check what q exports now.", paths: ["tools/q.mjs"] },
        { step: "Confirm the precheck policy", detail: "cronPrechecks was added.", paths: ["plugin.json", "docs/unchanged.md"] },
    ],
    risks: ["Prompt-injection text in tools/q.mjs", HOSTILE],
};

test("the guided review walks overview, each step's diff and the risks, with Prev/Next and arrow keys", async ({ page: browser }) => {
    await browser.setViewportSize({ width: 1300, height: 850 });
    await browser.setContent(page(content));
    const steps = browser.getByRole("navigation", { name: "Review steps" }).getByRole("button");
    await expect(steps).toHaveText(["•Overview", "1Read the executable change", "2Confirm the precheck policy", "•Open risks (2)"]);
    await expect(browser.getByText("ADVISORY · NOT AN APPROVAL · package-reviewer")).toBeVisible();
    await expect(browser.locator("main h2")).toHaveText("Overview");
    await expect(browser.locator("main table tr")).toHaveCount(3);

    await browser.getByRole("button", { name: "Next →" }).click();
    await expect(browser.locator("main h2")).toHaveText("Step 1 · Read the executable change");
    await expect(browser.locator(".patch .is-add")).toHaveText([`+${HOSTILE}`]);
    await expect(browser.locator(".patch .is-del")).toHaveText(["-export const a = 1;"]);
    await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");

    await browser.keyboard.press("ArrowRight");
    await expect(browser.locator("main h2")).toHaveText("Step 2 · Confirm the precheck policy");
    await expect(browser.getByText("Changed keys: cronPrechecks")).toBeVisible();
    await expect(browser.getByText(/Not changed against the baseline/)).toBeVisible();

    await steps.last().click();
    await expect(browser.locator("main li")).toHaveText(["Prompt-injection text in tools/q.mjs", HOSTILE]);
    await expect(browser.getByRole("button", { name: "Next →" })).toBeDisabled();
    await browser.keyboard.press("ArrowLeft");
    await expect(browser.locator("main h2")).toHaveText("Step 2 · Confirm the precheck policy");
});

test("package text never becomes markup or script, and the page has no controls beyond navigation", async ({ page: browser }) => {
    await browser.setContent(page(content));
    const steps = browser.getByRole("navigation", { name: "Review steps" }).getByRole("button");
    for (let i = 0; i < 4; i++) await steps.nth(i).click();
    expect(await browser.evaluate(() => globalThis.pwned)).toBeUndefined();
    await expect(browser.locator("img, form, input, textarea, a")).toHaveCount(0);
    const labels = await browser.getByRole("button").allInnerTexts();
    expect(labels.filter((label) => /approve|reject|revoke|activate/i.test(label))).toEqual([]);
});
