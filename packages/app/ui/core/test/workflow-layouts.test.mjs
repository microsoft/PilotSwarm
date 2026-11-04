/**
 * Batch 6 (f-03): where a person moved a workflow's step boxes, kept in their profile settings (`workflowLayouts`).
 * The stored value is bounded (50 workflows by most recent `at`, 200 steps each, 2,000 places in all, whole pixels,
 * bad ids and __proto__ dropped); the reducer records a move or a Reset layout and reads the places back from a
 * profile without letting an absent key reset local places.
 *
 * Run: node --test test/workflow-layouts.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import {
    normalizeWorkflowLayouts,
    normalizeWorkflowLayoutSteps,
    workflowLayoutsWith,
    WORKFLOW_LAYOUTS_MAX_WORKFLOWS,
    WORKFLOW_LAYOUT_MAX_STEPS,
    WORKFLOW_LAYOUTS_MAX_PLACES,
} from "../src/workflow-layouts.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function stepsOf(count, prefix = "s") {
    const steps = {};
    for (let i = 0; i < count; i += 1) steps[`${prefix}${i}`] = [i, i * 2];
    return steps;
}

test("the caps are the documented ones", () => {
    assert.equal(WORKFLOW_LAYOUTS_MAX_WORKFLOWS, 50);
    assert.equal(WORKFLOW_LAYOUT_MAX_STEPS, 200);
    assert.equal(WORKFLOW_LAYOUTS_MAX_PLACES, 2_000);
});

test("a stored value that is not a map reads as no places", () => {
    for (const value of [undefined, null, 0, "x", [], [["session:a", {}]]]) {
        assert.deepEqual(normalizeWorkflowLayouts(value), {});
    }
});

test("places are whole pixels; bad places, bad step ids and __proto__ are dropped", () => {
    const steps = JSON.parse(JSON.stringify({
        a: [10.4, -20.6],
        b: [1, 2, 3],
        c: "1,2",
        d: [100_001, 0],
        e: [0, -100_001],
        f: [100_000, -100_000],
        g: [null, 4],
        "": [1, 1],
        [`x${"y".repeat(128)}`]: [1, 1],
    }));
    // Built with JSON.parse so __proto__ is an own key, as it would be in a stored JSON document.
    const withProto = JSON.parse(`{"__proto__": [5, 5], "h": [7, 8]}`);
    const out = normalizeWorkflowLayoutSteps({ ...steps, ...withProto });
    assert.deepEqual(out, { a: [10, -21], f: [100_000, -100_000], g: [0, 4], h: [7, 8] });
    assert.equal(Object.prototype.hasOwnProperty.call(out, "__proto__"), false);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(normalizeWorkflowLayoutSteps({ b: [1] }), null);
    assert.equal(normalizeWorkflowLayoutSteps([[1, 2]]), null);
});

test("a step id of 128 characters is kept and one of 129 is dropped", () => {
    const ok = "s".repeat(128);
    const long = "s".repeat(129);
    assert.deepEqual(normalizeWorkflowLayoutSteps({ [ok]: [1, 2], [long]: [3, 4] }), { [ok]: [1, 2] });
});

test("bad workflow keys and entries without usable steps are dropped; a bad 'at' reads as 0", () => {
    const stored = JSON.parse(JSON.stringify({
        "session:a": { at: 5.6, steps: { one: [1, 2] } },
        "session:b": { at: "never", steps: { one: [3, 4] } },
        "session:c": { at: 9, steps: { bad: "x" } },
        "session:d": { at: 9 },
        "session:e": [1, 2],
        "": { at: 9, steps: { one: [1, 1] } },
        [`session:${"k".repeat(300)}`]: { at: 9, steps: { one: [1, 1] } },
    }));
    const proto = JSON.parse(`{"__proto__": {"at": 9, "steps": {"one": [1, 1]}}}`);
    const out = normalizeWorkflowLayouts({ ...stored, ...proto });
    assert.deepEqual(Object.keys(out).sort(), ["session:a", "session:b"]);
    assert.deepEqual(out["session:a"], { at: 6, steps: { one: [1, 2] } });
    assert.deepEqual(out["session:b"], { at: 0, steps: { one: [3, 4] } });
});

test("at most 50 workflows, the most recently changed kept", () => {
    const stored = {};
    for (let i = 1; i <= 60; i += 1) stored[`session:w${i}`] = { at: i, steps: { one: [i, i] } };
    const out = normalizeWorkflowLayouts(stored);
    const keys = Object.keys(out);
    assert.equal(keys.length, 50);
    for (let i = 1; i <= 10; i += 1) assert.equal(out[`session:w${i}`], undefined, `w${i} is among the oldest and dropped`);
    for (let i = 11; i <= 60; i += 1) assert.ok(out[`session:w${i}`], `w${i} is kept`);
    assert.equal(keys[0], "session:w60", "most recent first");
});

test("at most 200 steps per workflow", () => {
    const out = normalizeWorkflowLayouts({ "session:big": { at: 1, steps: stepsOf(250) } });
    const steps = out["session:big"].steps;
    assert.equal(Object.keys(steps).length, 200);
    assert.deepEqual(steps.s0, [0, 0]);
    assert.deepEqual(steps.s199, [199, 398]);
    assert.equal(steps.s200, undefined);
});

test("at most 2,000 places in all: a workflow that would pass the cap is skipped, an older smaller one may still fit", () => {
    const stored = {};
    // Eleven workflows of 190 steps: ten fit (1,900 places), the oldest (at 1) would make 2,090 and is skipped.
    for (let i = 1; i <= 11; i += 1) stored[`session:w${i}`] = { at: i + 10, steps: stepsOf(190, `w${i}-`) };
    stored["session:w1"].at = 2;
    // An even older workflow of 100 steps still fits: 1,900 + 100 = 2,000.
    stored["session:small"] = { at: 1, steps: stepsOf(100) };
    const out = normalizeWorkflowLayouts(stored);
    assert.equal(out["session:w1"], undefined);
    assert.ok(out["session:small"]);
    const places = Object.values(out).reduce((sum, entry) => sum + Object.keys(entry.steps).length, 0);
    assert.equal(places, 2_000);
});

test("workflowLayoutsWith records one workflow's places with its time", () => {
    const before = { "session:a": { at: 1, steps: { one: [1, 1] } } };
    const after = workflowLayoutsWith(before, "session:b", { one: [10.2, 20.7], two: [30, 40] }, 50);
    assert.deepEqual(after, {
        "session:b": { at: 50, steps: { one: [10, 21], two: [30, 40] } },
        "session:a": { at: 1, steps: { one: [1, 1] } },
    });
    assert.deepEqual(before, { "session:a": { at: 1, steps: { one: [1, 1] } } }, "the input is not changed");
    // A later move of the same workflow replaces its places (a removed step's place is dropped on this save).
    const moved = workflowLayoutsWith(after, "session:b", { one: [11, 22] }, 60);
    assert.deepEqual(moved["session:b"], { at: 60, steps: { one: [11, 22] } });
});

test("workflowLayoutsWith with no places forgets the workflow (Reset layout)", () => {
    const before = { "session:a": { at: 1, steps: { one: [1, 1] } }, "session:b": { at: 2, steps: { one: [2, 2] } } };
    assert.deepEqual(workflowLayoutsWith(before, "session:a", null, 3), { "session:b": { at: 2, steps: { one: [2, 2] } } });
    assert.deepEqual(workflowLayoutsWith(before, "session:a", {}, 3), { "session:b": { at: 2, steps: { one: [2, 2] } } });
    assert.deepEqual(workflowLayoutsWith(before, "session:a", { bad: "x" }, 3), { "session:b": { at: 2, steps: { one: [2, 2] } } });
    // Nothing to forget: the same object comes back.
    assert.equal(workflowLayoutsWith(before, "session:none", null, 3), before);
    assert.equal(workflowLayoutsWith(undefined, "session:none", null, 3), undefined);
});

test("workflowLayoutsWith ignores an unusable key", () => {
    const before = { "session:a": { at: 1, steps: { one: [1, 1] } } };
    assert.equal(workflowLayoutsWith(before, "", { one: [1, 1] }, 2), before);
    assert.equal(workflowLayoutsWith(before, "__proto__", { one: [1, 1] }, 2), before);
    assert.equal(workflowLayoutsWith(before, "k".repeat(257), { one: [1, 1] }, 2), before);
    assert.equal(workflowLayoutsWith(before, 42, { one: [1, 1] }, 2), before);
});

test("a new workflow at the cap evicts the least recently changed", () => {
    let layouts = {};
    for (let i = 1; i <= 50; i += 1) layouts = workflowLayoutsWith(layouts, `session:w${i}`, { one: [i, i] }, i);
    assert.equal(Object.keys(layouts).length, 50);
    layouts = workflowLayoutsWith(layouts, "session:new", { one: [0, 0] }, 1_000);
    assert.equal(Object.keys(layouts).length, 50);
    assert.ok(layouts["session:new"]);
    assert.equal(layouts["session:w1"], undefined);
    assert.ok(layouts["session:w2"]);
});

test("reducer: ui/workflowLayout records a move and leaves the other settings alone", () => {
    const start = createInitialState({ mode: "web" });
    const state = appReducer(start, { type: "ui/workflowLayout", key: "session:a", steps: { one: [12.6, 3] }, at: 100 });
    assert.deepEqual(state.ui.workflowLayouts, { "session:a": { at: 100, steps: { one: [13, 3] } } });
    for (const key of Object.keys(start.ui)) {
        if (key === "workflowLayouts") continue;
        assert.equal(state.ui[key], start.ui[key], `ui.${key} unchanged`);
    }
    assert.equal(state.sessions, start.sessions);
});

test("reducer: Reset layout forgets the workflow; a Reset with nothing stored is a no-op", () => {
    let state = createInitialState({ mode: "web" });
    assert.equal(appReducer(state, { type: "ui/workflowLayout", key: "session:a", steps: null, at: 1 }), state);
    state = appReducer(state, { type: "ui/workflowLayout", key: "session:a", steps: { one: [1, 2] }, at: 1 });
    state = appReducer(state, { type: "ui/workflowLayout", key: "session:b", steps: { one: [3, 4] }, at: 2 });
    state = appReducer(state, { type: "ui/workflowLayout", key: "session:a", steps: null, at: 3 });
    assert.deepEqual(state.ui.workflowLayouts, { "session:b": { at: 2, steps: { one: [3, 4] } } });
    const same = appReducer(state, { type: "ui/workflowLayout", key: "session:a", at: 4 });
    assert.equal(same, state);
    // The last workflow reset leaves an empty map, so the next save carries no entry for it.
    state = appReducer(state, { type: "ui/workflowLayout", key: "session:b", steps: null, at: 5 });
    assert.deepEqual(state.ui.workflowLayouts, {});
});

test("reducer: a profile read applies the stored places, bounded; an absent or bad key keeps the local places", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "ui/workflowLayout", key: "session:local", steps: { one: [1, 1] }, at: 1 });
    const local = state.ui.workflowLayouts;

    const absent = appReducer(state, { type: "profileSettings/apply", settings: {} });
    assert.equal(absent.ui.workflowLayouts, local);
    const bad = appReducer(state, { type: "profileSettings/apply", settings: { workflowLayouts: [1, 2] } });
    assert.equal(bad.ui.workflowLayouts, local);
    const nullish = appReducer(state, { type: "profileSettings/apply", settings: { workflowLayouts: null } });
    assert.equal(nullish.ui.workflowLayouts, local);

    const stored = { "session:a": { at: 7, steps: { one: [5.5, 6.4], bad: "x" } }, "session:b": { at: 1, steps: {} } };
    const applied = appReducer(state, { type: "profileSettings/apply", settings: { workflowLayouts: stored } });
    assert.deepEqual(applied.ui.workflowLayouts, { "session:a": { at: 7, steps: { one: [6, 6] } } });
});

test("the portal saves and reads back workflowLayouts with the other profile settings", () => {
    const webApp = read("../../react/src/web-app.js");
    assert.match(webApp, /if \(hasOwn\(candidate, "workflowLayouts"\)\) \{\s*normalized\.workflowLayouts = normalizeWorkflowLayouts\(candidate\.workflowLayouts\);/);
    assert.match(webApp, /\{ workflowLayouts: state\.workflowLayouts \}/);
    assert.match(webApp, /hasOwn\(normalizedRemote, "workflowLayouts"\)\s*\?\s*\{ workflowLayouts: normalizedRemote\.workflowLayouts \}/);
    const workspace = read("../../react/src/workflow-workspace.js");
    assert.match(workspace, /const layoutKey = `session:\$\{sessionId\}`;/);
    assert.match(workspace, /type: "ui\/workflowLayout", key: layoutKey, steps, at: Date\.now\(\)/);
});
