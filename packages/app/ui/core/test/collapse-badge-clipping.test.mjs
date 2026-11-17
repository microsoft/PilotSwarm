/**
 * The [+N] hidden-descendant badge is tagged, and a row's suffixes come in one order.
 *
 * Plan 4 (F1): the desktop portal no longer clips a row. It draws the full
 * title, then the suffixes in the order ui/core gives them in titleRuns: the
 * "Has Workflows" mark, a Workflow's state, the [+N] badge, the pause and
 * timer marks; then the context %. The badge's tag (`role: "collapseBadge"`)
 * is what lets the portal draw it as its own element (the one the Terminated
 * row shares, Plan 3), and the badge stays inside titleRuns, right after the
 * title, so the TUI's flat runs keep it inline exactly where it was.
 *
 * History: the portal used to clamp `.ps-session-row-title__text` with an
 * ellipsis. The badge trailed the title, so on a narrow session pane it was
 * the FIRST thing cut, and a collapsed parent with four sub-agents rendered
 * exactly like a childless leaf. The tag first let the portal pin it beside
 * the ctx column.
 *
 * Run: node --test test/collapse-badge-clipping.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { selectSessionRows } from "../src/selectors.js";

const PARENT = { sessionId: "p", title: "HDB Test Lead Builder · Agent Manager", createdAt: 100, updatedAt: 100 };
const KIDS = [1, 2, 3, 4].map((i) => ({
    sessionId: `k${i}`,
    title: `kid${i}`,
    parentSessionId: "p",
    createdAt: 200 + i,
    updatedAt: 200 + i,
}));

function collapsedParentRow() {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [PARENT, ...KIDS] });
    state = appReducer(state, { type: "profileSettings/apply", settings: { collapsedSessionIds: ["p"] } });
    return selectSessionRows(state).find((row) => row.sessionId === "p");
}

test("the collapse badge is tagged so the portal can draw it as its own element", () => {
    const row = collapsedParentRow();
    const badges = row.titleRuns.filter((run) => run?.role === "collapseBadge");

    assert.equal(badges.length, 1, "expected exactly one tagged collapse-badge run");
    assert.match(badges[0].text, /\[\+4\]/, "badge should report the four hidden children");
});

test("splitting on the tag leaves the title intact and the badge whole", () => {
    const row = collapsedParentRow();
    // What the portal does: the runs before the badge are the title, the badge is its own element.
    const titleRuns = row.titleRuns.filter((run) => run?.role !== "collapseBadge");
    const badgeRuns = row.titleRuns.filter((run) => run?.role === "collapseBadge");

    const titleText = titleRuns.map((run) => run.text).join("");
    assert.ok(titleText.includes("HDB Test Lead Builder"), "title text must survive the split");
    assert.ok(!titleText.includes("[+4]"), "badge must not remain in the title's span");
    assert.match(badgeRuns.map((run) => run.text).join(""), /\[\+4\]/, "the badge's element carries the badge");
});

test("the badge stays inline in titleRuns for renderers that do not clip", () => {
    const row = collapsedParentRow();
    // The TUI renders the flat `runs`; the badge must still sit right after the
    // title there, not be relocated to the end of the row.
    const titleIndex = row.titleRuns.findIndex((run) => String(run?.text || "").includes("HDB Test Lead Builder"));
    const badgeIndex = row.titleRuns.findIndex((run) => run?.role === "collapseBadge");

    assert.ok(titleIndex >= 0 && badgeIndex >= 0, "both runs present");
    assert.equal(badgeIndex, titleIndex + 1, "badge should directly follow the title run");
    assert.match(row.runs.map((run) => run.text).join(""), /HDB Test Lead Builder · Agent Manager \[\+4\]/);
});

test("an expanded parent shows no badge (nothing is hidden)", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [PARENT, ...KIDS] });
    // Parents load collapsed, so expanding is explicit: with every child
    // visible in its own row there is nothing hidden left to count.
    state = appReducer(state, { type: "profileSettings/apply", settings: { collapsedSessionIds: [] } });
    const row = selectSessionRows(state).find((r) => r.sessionId === "p");

    assert.equal(
        row.titleRuns.filter((run) => run?.role === "collapseBadge").length,
        0,
        "expanded parent hides no children, so it must not carry a badge",
    );
});

test("Plan 4 (F1): a row's suffixes follow its title in one order: mark, state, [+N] badge, pause, timer", () => {
    const parent = { sessionId: "p", title: "Quarterly release readiness review", createdAt: 100, updatedAt: 100, status: "waiting",
        pauseState: { kind: "hold" }, cronActive: true, cronInterval: 3600 };
    const flow = { sessionId: "w", title: "Workflow: nightly-build", sessionKind: "workflow", parentSessionId: "p", status: "waiting",
        pauseState: { kind: "hold" }, createdAt: 200, updatedAt: 200 };
    const kid = { sessionId: "k", title: "Log reader", parentSessionId: "p", createdAt: 300, updatedAt: 300 };
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [parent, flow, kid] });
    state = appReducer(state, { type: "profileSettings/apply", settings: { collapsedSessionIds: ["p"] } });
    const at = (runs, test) => runs.findIndex(test);
    const closed = selectSessionRows(state).find((row) => row.sessionId === "p").titleRuns;
    const order = [
        at(closed, (run) => run?.text === parent.title),
        at(closed, (run) => run?.role === "workflowOwner"),
        at(closed, (run) => run?.role === "collapseBadge"),
        at(closed, (run) => String(run?.text || "").includes("paused")),
        at(closed, (run) => String(run?.text || "").includes("⏱")),
    ];
    assert.ok(order.every((index) => index >= 0), `every suffix is there: ${JSON.stringify(closed)}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `title, mark, badge, pause, timer: ${JSON.stringify(closed)}`);

    state = appReducer(state, { type: "profileSettings/apply", settings: { collapsedSessionIds: [] } });
    const flowRuns = selectSessionRows(state).find((row) => row.sessionId === "w").titleRuns;
    const flowOrder = [
        at(flowRuns, (run) => String(run?.text || "").includes("nightly-build")),
        at(flowRuns, (run) => run?.role === "workflowState"),
        at(flowRuns, (run) => String(run?.text || "").includes("paused")),
    ];
    assert.ok(flowOrder.every((index) => index >= 0), `every suffix is there: ${JSON.stringify(flowRuns)}`);
    assert.deepEqual([...flowOrder].sort((a, b) => a - b), flowOrder, `title, state, pause: ${JSON.stringify(flowRuns)}`);
});
