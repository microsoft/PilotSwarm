/**
 * 3b70e2c5 DEV (session-list-perf: "30 moves issued 35 session requests"): with Workflows always on, the portal read the
 * active chat's Workflow Definitions at once on every chat it arrived at, so moving through the session list with j and k
 * read them once per row. Both readers now wait for the session list's own settle (the controller's SESSION_NAV_SETTLE_MS,
 * the delay of the session's events and detail fetch) and cancel the pending read when the chat changes:
 * - the background read (OF-S2-4 C, web-app.js useWorkflowLifecycleReads), which keeps its 5 s spacing for one chat, and
 * - the Workflow tab's own read when it is open (workflow-tab.js).
 *
 * Run: node --test ui/core/test/workflow-definitions-settle.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SESSION_NAV_SETTLE_MS, WORKFLOW_LIFECYCLE_MIN_GAP_MS, workflowDefinitionsReadDelay } from "../src/index.js";

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const CONTROLLER = read("../src/controller.js");
const WEB_APP = read("../../react/src/web-app.js");
const WORKFLOW_TAB = read("../../react/src/workflow-tab.js");
const SETTLE = SESSION_NAV_SETTLE_MS;

test("one settle: the session fetch's own SESSION_NAV_SETTLE_MS (140 ms), exported; the background reads stay 5 s apart", () => {
    assert.equal(SETTLE, 140);
    assert.match(CONTROLLER, /this\.sessionNavSettleTimer = setTimeout\([\s\S]{0,120}\}, SESSION_NAV_SETTLE_MS\);/, "the list's own fetch uses it");
    assert.equal(WORKFLOW_LIFECYCLE_MIN_GAP_MS, 5_000);
});

test("workflowDefinitionsReadDelay: a chat just arrived at waits for the settle, never 0", () => {
    const now = 1_000_000;
    assert.equal(workflowDefinitionsReadDelay("b", null, SETTLE, now), SETTLE);
    assert.equal(workflowDefinitionsReadDelay("b", { ownerId: null, at: 0 }, SETTLE, now), SETTLE);
    assert.equal(workflowDefinitionsReadDelay("b", { ownerId: "a", at: now - 1 }, SETTLE, now), SETTLE, "another chat read a moment ago");
});

test("workflowDefinitionsReadDelay: the same chat waits out the 5 s since its last read, and at least the settle", () => {
    const now = 1_000_000;
    assert.equal(workflowDefinitionsReadDelay("a", { ownerId: "a", at: now - 1_000 }, SETTLE, now), 4_000);
    assert.equal(workflowDefinitionsReadDelay("a", { ownerId: "a", at: now - 4_950 }, SETTLE, now), SETTLE);
    assert.equal(workflowDefinitionsReadDelay("a", { ownerId: "a", at: now - 60_000 }, SETTLE, now), SETTLE);
});

test("the background read (useWorkflowLifecycleReads) arms its timer with the list's settle and clears it on a move", () => {
    const start = WEB_APP.indexOf("function useWorkflowLifecycleReads(");
    assert.ok(start > 0);
    const body = WEB_APP.slice(start, WEB_APP.indexOf("\n}\n", start));
    assert.match(body, /setTimeout\(read, workflowDefinitionsReadDelay\(ownerId, lastReadRef\.current, SESSION_NAV_SETTLE_MS\)\)/);
    assert.match(body, /return \(\) => clearTimeout\(timer\)/);
    assert.doesNotMatch(body, /:\s*0\);/, "no read at once on arrival");
});

test("the Workflow tab reads its chat's definitions after the list's settle, and clears the timer on a move", () => {
    const start = WORKFLOW_TAB.indexOf("export function WorkflowTab(");
    assert.ok(start > 0);
    const effect = WORKFLOW_TAB.slice(start, WORKFLOW_TAB.indexOf("}, [controller, ownerId, stamp]);", start));
    assert.match(effect, /setTimeout\(\(\) => \{ controller\.ensureChatWorkflowDefinitions\?\.\(ownerId\)\?\.catch\?\.\(\(\) => \{\}\); \}, SESSION_NAV_SETTLE_MS\)/);
    assert.match(effect, /return \(\) => clearTimeout\(timer\);\s*$/);
});
