import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowStepCard } from "../../../ui/react/src/workflow-graph.js";
import { workflowGraphNodeHeight } from "../../../ui/core/src/workflow-graph-layout.js";

const css = fs.readFileSync(new URL("../../src/index.css", import.meta.url), "utf8");
const description = "Check the build without changing it";
const card = { row2: true, fact: "Waiting", mark: { word: "running", glyph: "*" },
    badge: { text: "126+", title: "At least 126 visits" } };
const base = { type: "script", kind: "script", state: "running", id: "check_build", label: "Script", stateLabel: "Running", card };
const nodes = [
    { ...base, about: { description, notes: "Read this note in Node." } },
    { ...base, id: "long", about: { description: "LongLabel".repeat(100) } },
    { ...base, id: "done", type: "terminal", kind: "terminal", outcome: "succeeded", state: "done",
        about: { description, notes: "Completed." } },
    { ...base, id: "plain" },
];

for (const [width, theme] of [1440, 390].flatMap(width => ["workspace-dark", "win95"].map(theme => [width, theme]))) {
    test(`Workflow node labels wrap to two lines with metadata and tooltips at ${width}px in ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const html = nodes.map(node => `<div style="width:202px;height:${workflowGraphNodeHeight(node)}px">${
            renderToStaticMarkup(React.createElement(WorkflowStepCard, { node, onSelect() {} }))
        }</div>`).join("");
        await page.setContent(`<html><head><style>${css}</style></head><body data-ps-theme="${theme}">
            <main style="display:grid;gap:20px;padding:20px;justify-content:center">${html}</main></body></html>`);
        for (const id of ["check_build", "done"]) {
            const node = page.locator(`[data-node-id="${id}"]`);
            const name = node.locator(".ps-workflow-node-name");
            await expect(name).toHaveAttribute("title", description);
            await expect(name).toHaveText(description);
            await expect(node.locator(".ps-workflow-node-id")).toBeVisible();
            await expect(node.locator(".ps-workflow-node-id")).toHaveAttribute("title", id);
            await expect(node.locator(".ps-workflow-node-notes")).toBeVisible();
            await expect(node.locator(".ps-workflow-node-visits")).toHaveText("126+");
            const geometry = await node.evaluate(element => {
                const label = element.querySelector(".ps-workflow-node-name");
                const box = label.getBoundingClientRect();
                const card = element.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(label);
                const text = [...range.getClientRects()];
                return {
                    lines: box.height / parseFloat(getComputedStyle(label).lineHeight),
                    allTextFits: text.every(rect => rect.bottom <= box.bottom + 1 && rect.right <= box.right + 1),
                    childrenFit: [...element.querySelectorAll(".ps-workflow-node-text, .ps-workflow-node-icon, .ps-workflow-node-ring")]
                        .every(child => {
                            const rect = child.getBoundingClientRect();
                            return rect.top >= card.top && rect.bottom <= card.bottom + 1 && rect.right <= card.right + 1;
                        }),
                };
            });
            expect(geometry.lines).toBeGreaterThan(0.5);
            expect(geometry.lines).toBeLessThanOrEqual(2.1);
            expect(geometry.allTextFits).toBe(true);
            expect(geometry.childrenFit).toBe(true);
        }
        const long = page.locator('[data-node-id="long"] .ps-workflow-node-name');
        const longGeometry = await long.evaluate(element => ({
            lines: element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight),
            clamp: getComputedStyle(element).webkitLineClamp,
            wraps: getComputedStyle(element).overflowWrap,
        }));
        expect(longGeometry.lines).toBeGreaterThan(1.5);
        expect(longGeometry.lines).toBeLessThanOrEqual(2.1);
        expect(longGeometry.clamp).toBe("2");
        expect(longGeometry.wraps).toBe("anywhere");
        await expect(long).toHaveAttribute("title", "LongLabel".repeat(100));
        const plain = page.locator('[data-node-id="plain"]');
        expect(await plain.evaluate(element => element.getBoundingClientRect().height)).toBe(66);
        await expect(plain.locator(".ps-workflow-node-id")).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (process.env.PS_E2E_SHOT_DIR) {
            fs.mkdirSync(process.env.PS_E2E_SHOT_DIR, { recursive: true });
            await page.screenshot({ path: path.join(process.env.PS_E2E_SHOT_DIR, `workflow-label-wrap-${width}-${theme}.png`) });
        }
    });
}
