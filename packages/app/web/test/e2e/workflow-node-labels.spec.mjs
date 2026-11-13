import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowStepCard } from "../../../ui/react/src/workflow-graph.js";
import { workflowGraphNodeHeight } from "../../../ui/core/src/workflow-graph-layout.js";

const css = fs.readFileSync(new URL("../../src/index.css", import.meta.url), "utf8");
const description = "Check the build before release";
const longDescription = "Check the build without changing it. ".repeat(4).slice(0, 119);
const fontFiles = new Map(["latin", "latin-ext", "italic-latin", "italic-latin-ext"].map(subset => {
    const filename = `jetbrains-mono-${subset}.woff2`;
    return [`/assets/fonts/jetbrains-mono/${filename}`, fileURLToPath(new URL(`../../src/assets/fonts/jetbrains-mono/${filename}`, import.meta.url))];
}));
const parentFonts = [
    ["macOS stack", "SFMono-Regular, Menlo, monospace"],
    ["Windows stack", 'Consolas, "Courier New", monospace'],
    ["Linux stack", '"Liberation Mono", monospace'],
];
const card = { row2: true, fact: "Waiting", mark: { word: "running", glyph: "*" },
    badge: { text: "126+", title: "At least 126 visits" } };
const base = { type: "script", kind: "script", state: "running", id: "check_build", label: "Script", stateLabel: "Running", card };
const nodes = [
    { ...base, about: { description, notes: "Read this note in Node." } },
    { ...base, id: "long", about: { description: "LongLabel".repeat(100) } },
    { ...base, id: "sentence", about: { description: longDescription } },
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
        const documentHtml = `<html data-ps-theme="${theme}"><head><style>${css}</style></head><body>
            <main style="display:grid;gap:20px;padding:20px;justify-content:center">${html}</main></body></html>`;
        await page.route("https://workflow-labels.test/**", route => {
            const pathname = new URL(route.request().url()).pathname;
            if (pathname === "/") return route.fulfill({ contentType: "text/html", body: documentHtml });
            const font = fontFiles.get(pathname);
            return font ? route.fulfill({ contentType: "font/woff2", path: font }) : route.abort();
        });
        await page.goto("https://workflow-labels.test/");
        const loadedFaces = await page.evaluate(async () => {
            const faces = await document.fonts.load('600 13px "PS JetBrains Mono"', "Check the build");
            await document.fonts.ready;
            return faces.map(face => ({ family: face.family, status: face.status }));
        });
        expect(loadedFaces.length).toBeGreaterThan(0);
        expect(loadedFaces.every(face => face.family.includes("PS JetBrains Mono") && face.status === "loaded")).toBe(true);
        // These are parent stack choices, not native macOS/Windows browser coverage.
        for (const [platform, font] of parentFonts) {
            await page.evaluate(font => document.documentElement.style.setProperty("--ps-mono", font), font);
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
                    const rows = [...element.querySelector(".ps-workflow-node-text").children].map(row => row.getBoundingClientRect());
                    const range = document.createRange();
                    range.selectNodeContents(label);
                    const text = [...range.getClientRects()];
                    return {
                        font: getComputedStyle(label).fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, ""),
                        rowGaps: rows.slice(1).map((row, i) => row.top - rows[i].bottom),
                        lines: box.height / parseFloat(getComputedStyle(label).lineHeight),
                        allTextFits: text.every(rect => rect.bottom <= box.bottom + 1 && rect.right <= box.right + 1),
                        childrenFit: [...element.querySelectorAll(".ps-workflow-node-text, .ps-workflow-node-icon, .ps-workflow-node-ring")]
                            .every(child => {
                                const rect = child.getBoundingClientRect();
                                return rect.top >= card.top && rect.bottom <= card.bottom + 1 && rect.right <= card.right + 1;
                            }),
                    };
                });
                expect(geometry.font, platform).toBe("PS JetBrains Mono");
                expect(geometry.rowGaps.every(gap => gap >= 3.9), platform).toBe(true);
                expect(geometry.lines).toBeGreaterThan(0.5);
                expect(geometry.lines).toBeLessThanOrEqual(2.1);
                expect(geometry.allTextFits).toBe(true);
                expect(geometry.childrenFit).toBe(true);
            }
        }
        for (const [id, title] of [["long", "LongLabel".repeat(100)], ["sentence", longDescription]]) {
            const long = page.locator(`[data-node-id="${id}"] .ps-workflow-node-name`);
            const longGeometry = await long.evaluate(element => ({
                lines: element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight),
                clamp: getComputedStyle(element).webkitLineClamp,
                wraps: getComputedStyle(element).overflowWrap,
            }));
            expect(longGeometry.lines).toBeGreaterThan(1.5);
            expect(longGeometry.lines).toBeLessThanOrEqual(2.1);
            expect(longGeometry.clamp).toBe("2");
            expect(longGeometry.wraps).toBe("anywhere");
            await expect(long).toHaveAttribute("title", title);
        }
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
