import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const externalViewUrl = process.env.PS_EXTERNAL_VIEW_URL || "/external-view-fixture";
const externalViewHeading = process.env.PS_EXTERNAL_VIEW_HEADING || "SQLmort Workflows";

let stub;
test.beforeAll(async () => {
    stub = await startStubServer(0, {
        admin: true,
        externalViews: [{
            id: "workflows",
            label: "Workflows",
            url: externalViewUrl,
        }],
    });
});

test.afterAll(async () => {
    await new Promise((resolve) => stub.server.close(resolve));
});

test("mounts a deployment-owned page without workflow-specific PilotSwarm tabs", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${stub.port}`);

    await expect(page.getByRole("tab", { name: "Sessions" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Workflows" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Workflow Runs" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Workflow Generators" })).toHaveCount(0);

    await page.getByRole("tab", { name: "Workflows" }).click();
    const frame = page.frameLocator(".ps-external-work-index-frame");
    await expect(frame.getByRole("heading", { name: externalViewHeading })).toBeVisible();
    await expect(page.getByRole("button", { name: /Fleet view/ })).toHaveCount(0);
});
