import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const MS = read("../../src/managed-session.ts");
const SPECS = MS.slice(MS.indexOf("const DRAW_CANVAS_TOOL_SPEC"), MS.indexOf("const FIND_CANVAS_APP_TOOL_SPEC"));
const FIVE = /1-5|1–5|slots? 1\.\.5/;

test("canvas tool specs state the slot range from the shared limit", () => {
    assert.ok(SPECS.length > 1000, "the canvas tool spec block was found");
    assert.ok(!FIVE.test(SPECS), "no five-slot text in the canvas tool specs");
    assert.match(SPECS, /CANVAS_SLOT_RANGE/, "the range text comes from the shared constant");
});

for (const rel of [
    "../../plugins/system/prompts/base-v2.md",
    "../../plugins/system/agents/default.agent.md",
    "../../plugins/system/skills/canvas-apps/SKILL.md",
]) {
    test(`${rel.split("/").slice(-2).join("/")} names ten slots`, () => {
        const text = read(rel);
        assert.ok(!FIVE.test(text), "no five-slot text");
        assert.match(text, /1-10/);
    });
}
