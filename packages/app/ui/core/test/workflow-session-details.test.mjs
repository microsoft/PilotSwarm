/**
 * Batch 8 (d-1): the session details box of a workflow session shows what the workflow runs (Workflow, Revision, Run,
 * Started by, Steps) instead of a chat's Model, Context, Cron and Agent; an agent session that runs one of a workflow's
 * steps shows "Step of" instead of Cron. The values come from what the portal already holds; nothing is fetched.
 *
 * Run: node --test test/workflow-session-details.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { workflowSessionDetails, workflowStepParent } from "../src/workflow-v2-view.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const SESSION = "wf-session-1";
const PARENT = "parent-session-1";

const graphStates = count => Array.from({ length: count }, (_, i) => ({ id: `s${i}`, type: i === count - 1 ? "terminal" : "send" }));

function readModel({ state = "draft", currentRevision = 3, publishedRevision = null, name = "Triage", semver = "1.2.0", runs = [], steps = 4 } = {}) {
    return {
        revision: { name },
        definition: { state, currentRevision, publishedRevision, semver },
        runs,
        graph: { states: graphStates(steps) },
    };
}

function stateWith(view, sessions = {}) {
    return { ui: { workflowViews: view ? { [SESSION]: view } : {} }, sessions: { byId: sessions } };
}

const workflowSession = (extra = {}) => ({ sessionId: SESSION, sessionKind: "workflow", title: "Workflow: Triage", ...extra });

test("a draft: name and version, 'N · draft', no run yet, the step count", () => {
    const details = workflowSessionDetails(stateWith({ readModel: readModel() }), workflowSession());
    assert.deepEqual(details, { workflow: "Triage 1.2.0", revision: "3 · draft", run: "Not started", steps: "4", startedBy: null });
});

test("a published workflow shows its published revision and its live run's status and outcome", () => {
    const runs = [
        { runId: "t1", mode: "test", status: "completed", outcome: "failed" },
        { runId: "l1", mode: "live", status: "completed", outcome: "succeeded" },
    ];
    const details = workflowSessionDetails(stateWith({ readModel: readModel({ state: "published", currentRevision: 5, publishedRevision: 2, runs, steps: 6 }) }),
        workflowSession());
    assert.equal(details.revision, "2 · published");
    assert.equal(details.run, "Completed · succeeded");
    assert.equal(details.steps, "6");
});

// Review 19:27Z: the Workflow's state in its one word, never the raw status; a status it does not know reads "Not certain".
test("a live run without an outcome shows its state; without a status, 'Not certain'", () => {
    const running = workflowSessionDetails(stateWith({ readModel: readModel({ runs: [{ runId: "l1", mode: "live", status: "running" }] }) }), workflowSession());
    assert.equal(running.run, "Running");
    const blank = workflowSessionDetails(stateWith({ readModel: readModel({ runs: [{ runId: "l1", mode: "live", status: " " }] }) }), workflowSession());
    assert.equal(blank.run, "Not certain");
});

test("only test runs: 'No live run yet'", () => {
    const runs = [{ runId: "t1", mode: "test", status: "completed", outcome: "succeeded" }, null, "x"];
    const details = workflowSessionDetails(stateWith({ readModel: readModel({ runs }) }), workflowSession());
    assert.equal(details.run, "Not started · tests only");
});

test("a deleted workflow says so; an unknown state shows no revision", () => {
    assert.equal(workflowSessionDetails(stateWith({ readModel: readModel({ state: "deleted" }) }), workflowSession()).revision, "deleted");
    assert.equal(workflowSessionDetails(stateWith({ readModel: readModel({ state: "other" }) }), workflowSession()).revision, null);
    assert.equal(workflowSessionDetails(stateWith({ readModel: readModel({ currentRevision: "3" }) }), workflowSession()).revision, null);
});

test("a version is optional: the name alone", () => {
    const details = workflowSessionDetails(stateWith({ readModel: readModel({ semver: "" }) }), workflowSession());
    assert.equal(details.workflow, "Triage");
});

test("before the workflow screen has read anything: the title without its 'Workflow: ' prefix, the rest not loaded", () => {
    const details = workflowSessionDetails(stateWith(null), workflowSession({ title: "Workflow: Nightly report" }));
    assert.deepEqual(details, { workflow: "Nightly report", revision: null, run: null, steps: null, startedBy: null });
    const plain = workflowSessionDetails(stateWith(null), workflowSession({ title: "Nightly report" }));
    assert.equal(plain.workflow, "Nightly report");
    const none = workflowSessionDetails(stateWith(null), workflowSession({ title: null }));
    assert.equal(none.workflow, null);
});

test("a version 1 definition without a read model: its name, version and steps", () => {
    const definition = { name: "watch", version: "0.1.0", states: graphStates(3) };
    const details = workflowSessionDetails(stateWith({ definition }), workflowSession());
    assert.deepEqual(details, { workflow: "watch 0.1.0", revision: null, run: null, steps: "3", startedBy: null });
});

test("the read model's name wins over the definition's and the title", () => {
    const view = { readModel: readModel({ name: "From model", semver: "2.0.0" }), definition: { shape: "v2", name: "From definition", version: "9" } };
    const details = workflowSessionDetails(stateWith(view), workflowSession());
    assert.equal(details.workflow, "From model 2.0.0");
});

test("Started by: the parent session (its title when its row is loaded); none for a workflow a person started", () => {
    const sessions = { [PARENT]: { sessionId: PARENT, title: "Coordinator" } };
    const withParent = workflowSessionDetails(stateWith(null, sessions), workflowSession({ parentSessionId: PARENT }));
    assert.deepEqual(withParent.startedBy, { sessionId: PARENT, title: "Coordinator" });
    const notLoaded = workflowSessionDetails(stateWith(null), workflowSession({ parentSessionId: PARENT }));
    assert.deepEqual(notLoaded.startedBy, { sessionId: PARENT, title: null });
    const blankTitle = workflowSessionDetails(stateWith(null, { [PARENT]: { sessionId: PARENT, title: "  " } }), workflowSession({ parentSessionId: PARENT }));
    assert.deepEqual(blankTitle.startedBy, { sessionId: PARENT, title: null });
    assert.equal(workflowSessionDetails(stateWith(null), workflowSession()).startedBy, null);
    assert.equal(workflowSessionDetails(stateWith(null), workflowSession({ parentSessionId: "" })).startedBy, null);
});

test("no session or no state: every value not loaded", () => {
    assert.deepEqual(workflowSessionDetails(null, null), { workflow: null, revision: null, run: null, steps: null, startedBy: null });
    assert.deepEqual(workflowSessionDetails(undefined, { sessionId: SESSION }), { workflow: null, revision: null, run: null, steps: null, startedBy: null });
});

test("workflowStepParent: an agent session whose parent is a workflow session shows 'Step of' that workflow", () => {
    const sessions = { [SESSION]: { sessionId: SESSION, sessionKind: "workflow", title: "Workflow: Triage" } };
    const state = { sessions: { byId: sessions } };
    assert.deepEqual(workflowStepParent(state, { sessionId: "agent-1", parentSessionId: SESSION }), { sessionId: SESSION, title: "Workflow: Triage" });
    const untitled = { sessions: { byId: { [SESSION]: { sessionId: SESSION, sessionKind: "workflow" } } } };
    assert.deepEqual(workflowStepParent(untitled, { sessionId: "agent-1", parentSessionId: SESSION }), { sessionId: SESSION, title: null });
});

test("workflowStepParent: none for a chat parent, an unloaded parent, no parent, a workflow session or a group", () => {
    const sessions = {
        [SESSION]: { sessionId: SESSION, sessionKind: "workflow", title: "Workflow: Triage" },
        [PARENT]: { sessionId: PARENT, title: "Chat" },
    };
    const state = { sessions: { byId: sessions } };
    assert.equal(workflowStepParent(state, { sessionId: "agent-1", parentSessionId: PARENT }), null);
    assert.equal(workflowStepParent(state, { sessionId: "agent-1", parentSessionId: "missing" }), null);
    assert.equal(workflowStepParent(state, { sessionId: "agent-1" }), null);
    assert.equal(workflowStepParent(state, { sessionId: "wf-2", sessionKind: "workflow", parentSessionId: SESSION }), null);
    assert.equal(workflowStepParent(state, { sessionId: "g", isGroup: true, parentSessionId: SESSION }), null);
    assert.equal(workflowStepParent(null, { sessionId: "agent-1", parentSessionId: SESSION }), null);
});

test("the details box keeps ten rows for a workflow and shows the run, not a %, when collapsed", () => {
    const webApp = read("../../react/src/web-app.js");
    const rows = webApp.match(/\.\.\.\(workflow \? \[\s*([\s\S]*?)\] : \[\s*([\s\S]*?)\]\),/);
    assert.ok(rows, "the workflow rows replace the chat rows");
    const labels = text => [...text.matchAll(/field\("([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(labels(rows[1]), ["Workflow", "Revision", "Run", "Steps"]);
    assert.match(rows[1], /startedBy,/);
    assert.deepEqual(labels(rows[2]), ["Model", "Context", "Cron", "Agent"]);
    assert.match(rows[2], /stepOf \? sessionField\("Step of", stepOf\)/);
    assert.match(webApp, /workflow \? null : field\("Children", children\)/);
    assert.match(webApp, /sessionField\("Started by", workflow\.startedBy\)/);
    assert.match(webApp, /field\("Started by", viewerKey && viewerKey === ownerKeyForOwner\(session\?\.owner\) \? "You"/);
    assert.match(webApp, /if \(workflow\) \{\s*if \(workflow\.run\) marks\.push/);
});
