/**
 * Phase 3 I7 (design §7, Unit 3D Task 12): the portal's re-run in markup.
 * - RerunDialog: the source revision checked, the modes, the supply editor (Outcome, schema-guided Output with Fields | JSON,
 *   a required Why), the Reused disclosure with carried messages, OQ1's note, a refused reader's reason in place of Start;
 *   on a phone a bottom sheet whose fields are 16 px and whose targets are 44 px;
 * - the graph's reused (✓ Reused) and supplied (✎ Supplied) cards, in a colour each theme reads at 4.5:1;
 * - the timeline's hatched band with the supplied marker, the Node panel's Reason callout and origin, the Log's folded
 *   reused lines and its own supplied line;
 * - the header's "Re-run of #2" and "Re-run as #3", and Re-run from here… in the failure banner.
 *
 * Run: node --test ui/core/test/workflow-rerun-render.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { appReducer, contrastRatio, createInitialState, getTheme, listThemes, themeWorkflowColors } from "../src/index.js";
import { projectWorkflow, workflowReplayFrames } from "../src/workflow-view.js";
import { workflowVisitIo } from "../src/workflow-visit-io.js";
import { workflowRerunTimeline } from "../src/workflow-rerun.js";
import { selectWorkflowTabContext } from "../src/workflow-owner.js";
import { sessionDefinitionReadKey, sessionDefinitionsModel } from "../src/workflow-session-definitions.js";
import { ReplayBar, RerunDialog, WorkflowLog, WorkflowRunView } from "../../react/src/workflow-tab.js";
import { WorkflowStepCard } from "../../react/src/workflow-graph.js";
import { WorkflowNodeSummary } from "../../react/src/workflow-panels.js";
import { WorkflowVisitSection } from "../../react/src/workflow-visit-io.js";
import { SessionWorkflowTab } from "../../react/src/workflow-session-tab.js";
import { done, readModel } from "./workflow-fixtures.mjs";

process.env.TZ = "UTC";
const h = React.createElement;
const T = minutes => new Date(Date.parse("2026-11-27T09:00:00.000Z") + minutes * 60_000).toISOString();
const numberOf = id => ({ "wf-1": 1, "wf-2": 2, "wf-3": 3 })[id] ?? null;
const SCHEMA = { type: "object", required: ["resourceId", "objectId"], properties: { resourceId: { type: "string" }, objectId: { type: "string" } } };
const plan = (over = {}) => ({
    of: { workflowId: "wf-2", runId: "run-2", revision: 3, status: "failed", number: null },
    from: { executionId: "nx-provision-1", stateId: "provision", visit: 1, picked: "explicit" },
    mode: "supply", modesAvailable: ["continue", "supply"],
    supplyContract: { outcomes: ["provisioned", "failed"], outputSchemaName: null, resolvedOutputSchema: SCHEMA, maxOutputBytes: 262_144,
        nextByOutcome: { provisioned: { stateId: "configure", visit: 1 }, failed: null } },
    supply: null,
    revision: { target: 3, source: 3, newestValid: 4, newestValidFits: true, newestValidProblem: null, fits: true, problems: [], changedReusedSteps: [] },
    reused: { visits: 2, bytes: 120, steps: [{ stateId: "validate", visits: 1 }, { stateId: "plan", visits: 1 }], requests: [], approvals: [] },
    carried: { count: 1, contracts: ["Ack@1"] }, runs: { first: null }, dropped: [],
    warnings: [{ code: "result_supplied", stateId: "provision", message: "provision · visit 1 does not run. Its result is supplied as 'provisioned'." }],
    allowed: true, blockedReason: null, grantSource: "inherited", ...over,
});
const dialog = (props = {}) => renderToStaticMarkup(h(RerunDialog, { controller: {}, ownerId: "owner-1", definitionId: "def-1", name: "provision-cluster",
    sourceWorkflowId: "wf-2", sourceNumber: 2, nextNumber: 3, sourceStartedAt: T(0), plan: plan(), onClose() {}, onStarted() {}, ...props }));

test("RerunDialog: the source revision checked, the modes, and the supply editor's Outcome, Output fields and required Why", () => {
    const html = dialog();
    assert.match(html, /role="dialog"/);
    assert.match(html, /class="ps-modal is-narrow ps-wf-dialog is-rerun"/);
    assert.match(html, />Re-run provision-cluster #2 from here</);
    assert.match(html, />Starts #3\. #2 stays as it is\.</);
    assert.match(html, /data-field="rerun-grant"[^>]*>Scripts use the tools this session gave #2 on 2026-11-27\.</);
    assert.match(html, /<input type="radio" name="[^"]+-revision" checked="" value="3"/);
    assert.match(html, /<input type="radio" name="[^"]+-revision" value="4"\/?>/);
    assert.match(html, />4  newest · Revision 4 also fits</);
    assert.match(html, /<input type="radio" name="[^"]+-mode" checked="" value="supply"/);
    assert.match(html, />Supply this step&#x27;s result and go on</);
    assert.match(html, /<select[^>]*data-field="rerun-outcome"/);
    assert.match(html, /<option value="provisioned">provisioned → configure · visit 1<\/option>/);
    assert.match(html, /data-action="rerun-output-fields"[^>]*aria-pressed="true"/);
    assert.match(html, /data-action="rerun-output-json"[^>]*aria-pressed="false"/);
    assert.match(html, /<input[^>]*data-output-field="resourceId"/);
    assert.match(html, />resourceId \*</);
    assert.match(html, /<textarea[^>]*data-field="rerun-note"[^>]*placeholder="Why is this result supplied\?"/);
    assert.match(html, /<details class="ps-wf-rerun-reused"[^>]*><summary>Reused: 2 steps<\/summary>/);
    assert.doesNotMatch(html, /<details class="ps-wf-rerun-reused"[^>]* open/);
    assert.match(html, /data-field="rerun-carried"[^>]*>Carried inputs: 1 \(Ack@1\)</);
    assert.match(html, /data-action="rerun-start"[^>]*disabled=""[^>]*>Start #3</);
    // JSON for a nested schema, with its schema hint.
    const nested = { type: "object", required: ["server"], properties: { server: { type: "object" } } };
    const json = dialog({ plan: plan({ supplyContract: { ...plan().supplyContract, resolvedOutputSchema: nested } }) });
    assert.match(json, /<textarea[^>]*data-field="rerun-output-json"[^>]*>\{\n {2}&quot;server&quot;: \{\}\n\}<\/textarea>/);
    assert.match(json, /<details class="ps-wf-rerun-schema"[^>]*><summary>Schema hint<\/summary>/);
    assert.doesNotMatch(json, /data-action="rerun-output-fields"/);
    // Run again: no supply editor.
    const again = dialog({ plan: plan({ mode: "run_again", modesAvailable: ["run_again", "continue"], supplyContract: null, grantSource: "none",
        from: { executionId: "nx-provision-2", stateId: "provision", visit: 2, picked: "explicit" } }) });
    assert.doesNotMatch(again, /data-field="rerun-supply"/);
    assert.match(again, /data-field="rerun-effect"[^>]*>Runs provision · visit 2 again\.</);
    assert.doesNotMatch(again, /data-action="rerun-start"[^>]*disabled=""/);
});

test("RerunDialog: a refused reader's reason replaces Start; on a phone it is a bottom sheet", () => {
    const refused = dialog({ plan: plan({ allowed: false, grantSource: "none", blockedReason: "Choose approve · visit 1 or an earlier step. Only the owner in the portal can reuse an approval." }) });
    assert.match(refused, /data-field="rerun-blocked"[^>]*>Choose approve · visit 1 or an earlier step\. Only the owner in the portal can reuse an approval\.</);
    assert.doesNotMatch(refused, /data-action="rerun-start"/);
    assert.doesNotMatch(refused, /data-field="rerun-grant"/);
    const phone = dialog({ phone: true });
    assert.match(phone, /class="ps-modal is-narrow ps-wf-dialog is-rerun is-sheet"/);
    assert.match(phone, /data-field="rerun-outcome"/);
    assert.match(phone, /data-field="rerun-note"/);
    const css = fs.readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8");
    const sheet = css.slice(css.indexOf("/* Phase 3 I7: Re-run from here"));
    assert.ok(sheet.length > 0 && css.includes("/* Phase 3 I7: Re-run from here"), "the re-run rules are in the stylesheet");
    for (const needle of [
        ".ps-wf-dialog.is-rerun.is-sheet input,",
        ".ps-wf-dialog.is-rerun.is-sheet select,",
        ".ps-wf-dialog.is-rerun.is-sheet textarea { font-size: 16px; }",
        ".ps-wf-dialog.is-rerun.is-sheet button,",
        "min-height: 44px;",
        ".ps-modal.ps-wf-dialog.is-rerun.is-sheet {",
    ]) assert.ok(sheet.includes(needle), needle);
});

const STATES = [
    { id: "validate", type: "script", runtime: "node", outcomes: ["ok"], next: { ok: "provision" } },
    { id: "provision", type: "script", runtime: "node", outcomes: ["provisioned", "failed"], next: { provisioned: "configure", failed: "failed" } },
    { id: "configure", type: "script", runtime: "node", outcomes: ["configured"], next: { configured: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const SUPPLIED = { from: { workflowId: "wf-2", runId: "run-2", executionId: "nx-provision-src" }, by: { kind: "user", name: "Affan Dar" },
    note: "Server pg1 finished provisioning in Azure after timeout.", at: T(5) };
const rerunModel = () => readModel({
    graph: { revision: 3, initial: "validate", states: STATES },
    run: { runId: "run-3", status: "completed", outcome: "succeeded", terminalState: "done",
        rerunOf: { workflowId: "wf-2", runId: "run-2", executionId: "nx-provision-src", mode: "supply", stateId: "provision", visit: 1, revision: 3 } },
    runs: [{ runId: "run-3", mode: "live", status: "completed", revision: 3, outcome: "succeeded" }],
    nodeExecutions: [
        done("validate", 1, "ok", { enteredAt: T(0), endedAt: T(1), reused: { workflowId: "wf-2", runId: "run-2", executionId: "nx-validate-src", reusedAt: T(5) } }),
        done("provision", 1, "provisioned", { predecessorId: "nx-validate-1", enteredAt: T(5), endedAt: T(5), outputPreview: '{"resourceId":"r","objectId":"o"}',
            supplied: SUPPLIED }),
        done("configure", 1, "configured", { predecessorId: "nx-provision-1", enteredAt: T(6), endedAt: T(7) }),
        done("done", 1, "succeeded", { predecessorId: "nx-configure-1", enteredAt: T(7), endedAt: T(7) }),
    ],
});

test("the graph's cards: ✓ Reused muted, ✎ Supplied in each theme's own colour at 4.5:1 on its card", () => {
    const projection = projectWorkflow({ readModel: rerunModel(), numberOf });
    const card = id => renderToStaticMarkup(h(WorkflowStepCard, { node: projection.nodes.find(node => node.id === id), onSelect() {} }));
    assert.match(card("validate"), /data-reused="true"/);
    assert.match(card("validate"), />Reused from #2</);
    assert.doesNotMatch(card("validate"), /data-supplied/);
    assert.match(card("provision"), /data-supplied="true"/);
    assert.match(card("provision"), /data-state-mark="supplied"/);
    assert.match(card("provision"), />✎</);
    assert.match(card("provision"), />Supplied \(provisioned\)</);
    assert.doesNotMatch(card("configure"), /data-reused|data-supplied/);
    const css = fs.readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8");
    for (const needle of [
        '.ps-workflow-node[data-supplied="true"] { border-style: dashed; border-color: var(--ps-wf-supplied, #ffa657); }',
        '.ps-workflow-node-meta.is-state[data-state-mark="supplied"] { color: var(--ps-wf-supplied, #ffa657); }',
        '.ps-workflow-node[data-reused="true"] .ps-workflow-node-meta.is-state { color: var(--ps-wf-meta, var(--ps-muted)); }',
    ]) assert.ok(css.includes(needle), needle);
    const mix = (from, to, share) => `#${[1, 3, 5].map(at => Math.round(parseInt(from.slice(at, at + 2), 16) * (1 - share)
        + parseInt(to.slice(at, at + 2), 16) * share).toString(16).padStart(2, "0")).join("")}`;
    const full = value => (/^#[0-9a-f]{3}$/i.test(value) ? `#${value.slice(1).split("").map(c => c + c).join("")}` : value).toLowerCase();
    const low = [];
    for (const theme of listThemes()) {
        const colours = themeWorkflowColors(theme);
        if (!colours.supplied) { low.push(`${theme.id}: no supplied colour`); continue; }
        const surface = full(theme.tui.surface || theme.tui.background);
        const grounds = [mix(surface, full(theme.tui.foreground), 0.06), surface, full(theme.page?.workflowGround ?? theme.tui.background)];
        for (const ground of grounds) if (!(contrastRatio(colours.supplied, ground) >= 4.5)) low.push(`${theme.id}: ${colours.supplied} on ${ground}`);
    }
    assert.deepEqual(low, []);
    assert.ok(getTheme("github-light") && themeWorkflowColors(getTheme("github-light")).supplied !== themeWorkflowColors(getTheme("workspace-dark")).supplied);
});

test("the timeline's hatched band ends where the re-run starts, with the supplied visit marked; history offers Re-run from here…", () => {
    const projection = projectWorkflow({ readModel: rerunModel(), numberOf });
    const frames = workflowReplayFrames(projection.allExecutions);
    const band = workflowRerunTimeline(frames, { sourceNumber: 2 });
    const bar = props => renderToStaticMarkup(h(ReplayBar, { frames, index: null, playing: false, ended: true, startMs: frames[0].atMs,
        onGo() {}, onPlay() {}, onPause() {}, rerun: { band, button: null }, ...props }));
    const live = bar();
    assert.match(live, /data-field="rerun-band"[^>]*title="1 reused \+ 1 supplied"/);
    assert.match(live, /data-field="rerun-supplied-marker"/);
    assert.match(live, /data-field="rerun-start-marker"[^>]*title="Re-run starts"/);
    assert.doesNotMatch(live, /data-action="rerun-from-timeline"/);
    const history = bar({ index: 2, rerun: { band, button: { enabled: true, title: "Start a new Workflow that reuses the steps before this one.", open() {} } } });
    assert.match(history, /data-action="rerun-from-timeline"[^>]*>Re-run from here…</);
    // A run that is not a re-run has no band.
    assert.doesNotMatch(bar({ rerun: null }), /rerun-band/);
    const css = fs.readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8");
    assert.ok(/\.ps-wf-replay-band \{[^}]*repeating-linear-gradient/.test(css), "the band is hatched");
});

test("the Node panel: a supplied visit's Reason callout and origin, a reused visit's origin, and Re-run from here…", () => {
    const projection = projectWorkflow({ readModel: rerunModel(), numberOf });
    const node = id => projection.nodes.find(item => item.id === id);
    const section = id => renderToStaticMarkup(h(WorkflowVisitSection, {
        io: workflowVisitIo(node(id), node(id).current, { numberOf, workflowNumber: 3, now: Date.parse(T(10)) }), onOpenOrigin() {} }));
    const supplied = section("provision");
    assert.match(supplied, /data-provenance="supplied"/);
    assert.match(supplied, />✎ Supplied in #3 \(did not run\) · by Affan Dar · 09:05:00</);
    assert.match(supplied, /data-field="supplied-reason"[^>]*><strong>Reason<\/strong>[^<]*<span>Server pg1 finished provisioning in Azure after timeout\.<\/span>/);
    assert.match(supplied, />Replaced #2&#x27;s visit</);
    assert.match(supplied, /data-action="open-rerun-origin"[^>]*data-session="wf-2"[^>]*>Open in #2</);
    const reused = section("validate");
    assert.match(reused, /data-provenance="reused"/);
    assert.match(reused, />Reused from #2 · ran 09:00:00 · took 1 min</);
    assert.doesNotMatch(reused, /supplied-reason/);
    assert.doesNotMatch(section("configure"), /data-provenance/);
    const summary = renderToStaticMarkup(h(WorkflowNodeSummary, { selected: node("provision"), nodes: projection.nodes, select() {}, runId: "run-3",
        rerun: { stateOf: () => ({ enabled: false, title: "This Workflow is still running. Stop it first.", mode: null }), open() {}, numberOf, workflowNumber: 3 } }));
    assert.match(summary, /data-action="rerun-from-node"[^>]*disabled=""[^>]*title="This Workflow is still running\. Stop it first\."[^>]*>Re-run from here…</);
    assert.match(summary, /data-provenance="supplied"/);
});

test("the Log folds the reused lines into one and keeps the supplied line its own", () => {
    const reused = (stateId, seq) => ({ seq, eventType: "workflow.state_reused", createdAt: T(5), data: { runId: "run-3", nodeExecutionId: `nx-${stateId}-1`,
        stateId, scopeId: "root", ordinal: 1, type: "script", outcome: "ok", resultKind: "business", reusedFrom: { workflowId: "wf-2", runId: "run-2", executionId: `src-${seq}` } } });
    const events = [
        { seq: 1, eventType: "workflow.started", createdAt: T(5), data: { runId: "run-3", mode: "live", revision: 3, name: "provision-cluster", initial: "validate", states: STATES } },
        reused("validate", 2), reused("plan", 3),
        { seq: 4, eventType: "workflow.state_supplied", createdAt: T(5), data: { runId: "run-3", nodeExecutionId: "nx-provision-1", stateId: "provision", scopeId: "root",
            ordinal: 1, outcome: "provisioned", resultKind: "business", by: { kind: "user", provider: "entra", subject: "0000-1111" }, note: SUPPLIED.note, suppliedAt: T(5) } },
        { seq: 5, eventType: "workflow.state_started", createdAt: T(6), data: { runId: "run-3", nodeExecutionId: "nx-configure-1", stateId: "configure", ordinal: 1 } },
    ];
    const html = renderToStaticMarkup(h(WorkflowLog, { events, runId: "run-3", runs: [{ runId: "run-3", mode: "live" }], numberOf }));
    assert.match(html, /<li class="ps-wf-log-fold" data-log="reused"><details><summary>(<time[^>]*>[^<]*<\/time>)?<span>2 steps reused from #2<\/span><\/summary>/);
    assert.match(html, /<li[^>]*><span>✓ plan reused<\/span><\/li>/);
    assert.match(html, /<li data-level="warning"[^>]*>(<time[^>]*>[^<]*<\/time>)?<span>✎ provision · visit 1 supplied → provisioned by a person \(“Server pg1 finished provisioning in Azure after timeout\.”\)<\/span><\/li>/);
    assert.doesNotMatch(html, /0000-1111/);
    // The supplied line is not inside the fold.
    const fold = html.slice(html.indexOf('data-log="reused"'), html.indexOf("</details>"));
    assert.doesNotMatch(fold, /supplied/);
});

// ─── The header and the failure banner, in the session's Workflow tab ───────────────────────────────────────────────

const OWNER = "owner-1";
const AT = "2026-11-27T09:00:00.000Z";
const DEFINITIONS = sessionDefinitionsModel([{
    definitionId: "def-1", ownerSessionId: OWNER, name: "provision-cluster", source: "session", currentRevision: 3, newestValidRevision: 3,
    createdAt: AT, updatedAt: AT, deletedAt: null,
    revisions: [{ definitionId: "def-1", revision: 3, valid: true, semver: "1.0.0", createdAt: AT, errorCount: 0 }],
    workflows: [
        { workflowSessionId: "wf-1", definitionId: "def-1", revision: 3, runStatus: "completed", createdAt: AT },
        { workflowSessionId: "wf-2", definitionId: "def-1", revision: 3, runStatus: "failed", createdAt: AT },
        { workflowSessionId: "wf-3", definitionId: "def-1", revision: 3, runStatus: "completed", createdAt: AT },
    ],
}]);

function tab(workflowId, model, { ownerStatus = "idle", view = {}, withoutRerun = false } = {}) {
    let state = createInitialState({ mode: "api" });
    const dispatch = action => { state = appReducer(state, action); };
    dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: OWNER, title: "Owner session", status: ownerStatus, createdAt: AT, updatedAt: AT },
        ...["wf-1", "wf-2", "wf-3"].map(id => ({ sessionId: id, title: "Workflow: provision-cluster", sessionKind: "workflow", parentSessionId: OWNER,
            status: id === "wf-2" ? "failed" : "completed", createdAt: AT, updatedAt: AT })),
    ] });
    dispatch({ type: "sessions/selected", sessionId: OWNER });
    dispatch({ type: "ui/workflowTab", ownerId: OWNER, patch: { sessionDefinitionId: "def-1", view: "workflows", workflowId } });
    dispatch({ type: "ui/sessionDefinitionRead", ownerId: OWNER, key: sessionDefinitionReadKey("def-1", 3), entry: { phase: "ready", value: {
        definition: { definitionId: "def-1", name: "provision-cluster" }, revision: { revision: 3, valid: true, yaml: null, diagnostics: [] },
        graph: { revision: 3, initial: "validate", states: STATES }, viewer: { allowed: true }, personCommands: true } } });
    dispatch({ type: "ui/workflowView", sessionId: workflowId, view: { readModel: model, ...view } });
    const controller = { getState: () => state, subscribe: () => () => {}, dispatch };
    if (withoutRerun) return renderToStaticMarkup(h(WorkflowRunView, {
        controller, definition: { name: "provision-cluster", workflows: [] }, workflow: { sessionId: workflowId, number: 3 }, tab: {},
        extraActions: h("button", { "data-action": "run-again-dialog" }, "Run again…"),
    }));
    return renderToStaticMarkup(h(SessionWorkflowTab, { controller, mobile: false, context: selectWorkflowTabContext(state), definitions: DEFINITIONS }));
}

test("the header names a re-run's source and a source's re-run; the failure banner offers Re-run from here…", () => {
    const three = tab("wf-3", rerunModel());
    assert.match(three, /data-field="rerun-of"[^>]*>Re-run of #2 · supplied provision · visit 1</);
    const failed = readModel({ graph: { revision: 3, initial: "validate", states: STATES },
        run: { runId: "run-2", status: "failed", outcome: null, error: { code: "timed_out", message: "provision timed out after 300 s." } },
        runs: [{ runId: "run-2", mode: "live", status: "failed", revision: 3, outcome: null }],
        nodeExecutions: [done("validate", 1, "ok", { enteredAt: T(0), endedAt: T(1) })] });
    const two = tab("wf-2", { ...failed, reruns: [{ workflowId: "wf-3", runId: "run-3", mode: "supply", fromExecutionId: "nx-provision-1", status: "completed", createdAt: AT }] });
    assert.match(two, /data-field="reruns"[^>]*>Re-run as #3</);
    assert.match(two, /data-action="rerun-from-failure"[^>]*>Re-run from here…</);
    assert.doesNotMatch(two, /data-action="rerun-from-failure"[^>]*disabled=""/);
    // The owning session ended: the button is off and says why.
    assert.match(tab("wf-2", failed, { ownerStatus: "completed" }),
        /data-action="rerun-from-failure"[^>]*disabled=""[^>]*title="The session that owns this Workflow has ended\."/);
});

test("the Run again split control offers the selected visit for an ended run, with the shared refusal for an active run", () => {
    const view = { selectedNodeId: "provision" };
    const model = rerunModel();
    const ended = tab("wf-3", model, { view });
    assert.match(ended, /data-action="run-again-dialog".*aria-label="Re-run options"[^>]*aria-haspopup="menu"[^>]*data-action="run-again-menu"/s);
    assert.match(ended, /role="menuitem"[^>]*data-action="run-again-rerun"[^>]*data-execution="nx-provision-1"[^>]*aria-disabled="false"[^>]*>.*?Re-run from provision · visit 1…/s);
    const active = tab("wf-3", { ...model, run: { ...model.run, status: "running" } }, { view });
    assert.match(active, /data-action="run-again-rerun"[^>]*aria-disabled="true"[^>]*title="This Workflow is still running\. Stop it first\."/);
    assert.match(tab("wf-3", model), /data-action="run-again-rerun"[^>]*aria-disabled="true"[^>]*title="Select a node on the graph first\."/);
});

test("the caret uses the selected visit rather than the newest one", () => {
    const model = rerunModel();
    const withLaterVisit = { ...model, run: { ...model.run, nodeExecutions: [...model.run.nodeExecutions,
        done("provision", 2, "provisioned", { predecessorId: "nx-configure-1", enteredAt: T(7), endedAt: T(8) })] } };
    const view = { selectedNodeId: "provision" };
    assert.match(tab("wf-3", withLaterVisit, { view }), /data-action="run-again-rerun"[^>]*data-execution="nx-provision-2"/);
    const html = tab("wf-3", withLaterVisit, {
        view: { ...view, selectedExecution: { stateId: "provision", runId: "run-3", executionId: "nx-provision-1" } },
    });
    assert.match(html, /data-action="run-again-rerun"[^>]*data-execution="nx-provision-1"[^>]*>.*?Re-run from provision · visit 1…/s);
});

test("the caret offers failure recovery without a selection and is absent without rerun capability", () => {
    const model = rerunModel();
    const failed = { ...model, run: { ...model.run, status: "failed" } };
    assert.match(tab("wf-2", failed), /data-action="run-again-rerun-failure"[^>]*aria-disabled="false"[^>]*>.*?Re-run from the failure…/s);
    const unsupported = tab("wf-3", model, { withoutRerun: true });
    assert.match(unsupported, /data-action="run-again-dialog"/);
    assert.doesNotMatch(unsupported, /data-action="run-again-menu"/);
});

test("the Node panel offers Re-run from here before its visit input", () => {
    const model = rerunModel();
    const selected = projectWorkflow({ readModel: model, numberOf }).nodes.find(node => node.id === "provision");
    const html = renderToStaticMarkup(h(WorkflowNodeSummary, { selected, nodes: [selected], select() {}, runId: "run-3",
        rerun: { stateOf: () => ({ enabled: true, title: "", mode: null }), open() {} } }));
    assert.match(html, /data-action="rerun-from-node".*data-field="visit-input"/s);
});
