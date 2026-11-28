/**
 * Phase 3 I7 (design §7, Unit 3D Task 11): the portal's "Re-run from here…" sheet as one shared model, and the reused and
 * supplied visits of a re-run in the graph, Node panel, timeline and Log.
 * - the button's six disabled states, each in one sentence; a first visit stays enabled when it can be continued or supplied;
 * - the sheet always preselects the source Workflow's revision, offers a newer revision that fits as an unselected choice
 *   and one that does not as a disabled one with its reason, and says how a locked package gets a newer one (N8);
 * - OQ1's inherited tool grant note, and a refused reader's reason in place of Start;
 * - carried messages inside the Reused disclosure (R2-S6);
 * - a plan read sends an outcome only, never an output (M6); the output is checked here for JSON syntax, size and depth with
 *   no schema library (R2-S4), and Start's 422 problems are shown with it;
 * - one operation id per sheet, new whenever the mode, revision, outcome, output or note changes (N5);
 * - the schema-guided supply editor: flat fields or JSON, and a required Why.
 *
 * Run: node --test ui/core/test/workflow-rerun-ui.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
    WORKFLOW_RERUN_TIPS, workflowRerunButtonState, workflowRerunCanStart, workflowRerunChip, workflowRerunDraft, workflowRerunDraftChange,
    workflowRerunDraftOutput, workflowRerunLogRows, workflowRerunNumbers, workflowRerunOutputCheck, workflowRerunOutputSkeleton,
    workflowRerunPlanQuery, workflowRerunReruns, workflowRerunSelectionKey, workflowRerunSheet, workflowRerunStartProblems, workflowRerunStartRequest,
    workflowRerunSupplyFields, workflowRerunTimeline,
} from "../src/workflow-rerun.js";
import { PilotSwarmUiController, WORKFLOW_EVENT_TYPES, appReducer, createInitialState, createStore, describeWorkflowEvent, formatWorkflowEventText }
    from "../src/index.js";
import { projectWorkflow, workflowActivity, workflowReplayFrames } from "../src/workflow-view.js";
import { workflowVisitIo } from "../src/workflow-visit-io.js";
import { done, readModel } from "./workflow-fixtures.mjs";

process.env.TZ = "UTC";

const T = minutes => new Date(Date.parse("2026-11-27T09:00:00.000Z") + minutes * 60_000).toISOString();
const NUMBERS = { "wf-1": 1, "wf-2": 2, "wf-3": 3 };
const numberOf = id => NUMBERS[id] ?? null;

const SCHEMA = { type: "object", required: ["resourceId", "objectId"], additionalProperties: false,
    properties: { resourceId: { type: "string" }, objectId: { type: "string" }, cores: { type: "integer" }, region: { enum: ["westus3", "eastus"] },
        ready: { type: "boolean" } } };

/** A re-run plan as readWorkflowRerunPlan returns it (packages/sdk/src/workflow/rerun.ts › buildRerunPlan; session-definitions.ts adds reused.approvals). */
const plan = (over = {}) => ({
    of: { workflowId: "wf-2", runId: "run-2", revision: 3, status: "failed", number: null },
    from: { executionId: "nx-provision-1", stateId: "provision", visit: 1, picked: "explicit" },
    mode: "supply",
    modesAvailable: ["continue", "supply"],
    supplyContract: { outcomes: ["provisioned", "failed"], outputSchemaName: null, resolvedOutputSchema: SCHEMA, maxOutputBytes: 262_144,
        nextByOutcome: { provisioned: { stateId: "configure", visit: 1 }, failed: null } },
    supply: null,
    revision: { target: 3, source: 3, newestValid: 4, newestValidFits: true, newestValidProblem: null, fits: true, problems: [], changedReusedSteps: [] },
    reused: { visits: 2, bytes: 120, steps: [{ stateId: "validate", visits: 1 }, { stateId: "plan", visits: 1 }], requests: [], approvals: [] },
    carried: { count: 0, contracts: [] },
    runs: { first: null },
    dropped: [],
    warnings: [{ code: "result_supplied", stateId: "provision", message: "provision · visit 1 does not run. Its result is supplied as 'provisioned'." }],
    allowed: true,
    blockedReason: null,
    grantSource: "none",
    ...over,
});

let counter = 0;
const mint = () => `op-${++counter}`;

test("a completed decision offers supply and Start sends only its outcome and Why", () => {
    const button = workflowRerunButtonState({
        runStatus: "failed", visit: { id: "nx-choose-1", status: "completed", outcome: "uncertain", ordinal: 1 },
        node: { id: "choose", type: "decision", initial: true },
    });
    assert.equal(button.mode, "supply");
    const decisionPlan = plan({
        supplyContract: { outcomes: ["agent", "uncertain"], outcomeOnly: true },
        supply: { outcome: "agent", valid: true, next: { stateId: "review", visit: 1 } },
    });
    const draft = workflowRerunDraft(decisionPlan, { mint });
    assert.equal(draft.view, null);
    assert.equal(workflowRerunCanStart(draft, decisionPlan).reason, "Choose an outcome.");
    const selected = { ...draft, outcome: "agent", outputText: "not JSON" };
    assert.equal(workflowRerunCanStart(selected, decisionPlan).reason, "Say why this result is supplied.");
    const ready = { ...selected, note: "Checked the route" };
    assert.equal(workflowRerunCanStart(ready, decisionPlan).ok, true);
    const { rerunFrom } = workflowRerunStartRequest(ready, { plan: decisionPlan });
    assert.deepEqual(rerunFrom.result, { outcome: "agent" });
    assert.equal(rerunFrom.note, "Checked the route");
});

// ─── 1. The button: six disabled states, and visit 1 ────────────────────────────────────────────────────────────────

test("the button says each of its six disabled states in one sentence, and is enabled otherwise", () => {
    const script = { id: "provision", type: "script", initial: false };
    const later = { id: "nx-provision-2", stateId: "provision", ordinal: 2, status: "completed", outcome: "failed", resultKind: "business", predecessorId: "nx-a" };
    const on = workflowRerunButtonState({ runStatus: "failed", visit: later, node: script });
    assert.deepEqual([on.enabled, on.title, on.mode], [true, WORKFLOW_RERUN_TIPS.enabled, null]);
    const tip = input => workflowRerunButtonState({ runStatus: "failed", visit: later, node: script, ...input });
    for (const status of ["admitted", "running", "paused"]) {
        assert.deepEqual([tip({ runStatus: status }).enabled, tip({ runStatus: status }).title], [false, "This Workflow is still running. Stop it first."]);
    }
    assert.equal(tip({ viewerAllowed: false }).title, "Only the owner or an admin can start a Workflow.");
    for (const status of ["completed", "cancelled", "failed", "deleted"]) {
        assert.equal(tip({ ownerStatus: status }).title, "The session that owns this Workflow has ended.");
    }
    assert.equal(tip({ visit: { ...later, scopeId: "nx-fan-1#0", branch: { parallelNodeExecutionId: "nx-fan-1", index: 0 } } }).title,
        "To re-run this lane, choose the parallel step.");
    assert.equal(tip({ deleted: true }).title, "This Workflow was cleaned up. Use Run again… instead.");
    // A cancelled wait at visit 1 of the run: no run_again (no step before it), no continue (no result), no supply (a wait).
    const wait = { id: "pause", type: "wait", initial: true };
    const cancelled = { id: "nx-pause-1", stateId: "pause", ordinal: 1, status: "completed", outcome: "cancelled", resultKind: "runtime_error", winner: "cancel" };
    const first = workflowRerunButtonState({ runStatus: "cancelled", visit: cancelled, node: wait });
    assert.deepEqual([first.enabled, first.title], [false, "This is the first step. Use Run again… instead."]);
    // The failure banner names no visit: the server picks it.
    assert.equal(workflowRerunButtonState({ runStatus: "failed" }).enabled, true);
    for (const state of [tip({ runStatus: "running" }), tip({ viewerAllowed: false }), tip({ deleted: true }), first]) {
        assert.ok(Object.values(WORKFLOW_RERUN_TIPS).includes(state.title));
    }
});

test("visit 1 stays enabled when it can be supplied or continued, and opens in that mode", () => {
    const provision = { id: "provision", type: "script", initial: true };
    const timedOut = { id: "nx-provision-1", stateId: "provision", ordinal: 1, status: "completed", outcome: "timed_out", resultKind: "runtime_error", winner: "deadline" };
    const supply = workflowRerunButtonState({ runStatus: "failed", visit: timedOut, node: provision });
    assert.deepEqual([supply.enabled, supply.mode], [true, "supply"]);
    // supply: never on the step: it can still be continued (it has a result).
    const never = workflowRerunButtonState({ runStatus: "failed", visit: timedOut, node: { ...provision, supply: "never" } });
    assert.deepEqual([never.enabled, never.mode], [true, "continue"]);
    // A receive at visit 1 that completed with a message: continue.
    const receive = workflowRerunButtonState({ runStatus: "stopped", node: { id: "await", type: "messaging", mode: "receive", initial: true },
        visit: { id: "nx-await-1", stateId: "await", ordinal: 1, status: "completed", outcome: "received", resultKind: "business" } });
    assert.deepEqual([receive.enabled, receive.mode], [true, "continue"]);
    // A visit 1 the run end cancelled with supply: never: nothing to keep, nothing to supply.
    const off = workflowRerunButtonState({ runStatus: "cancelled", node: { ...provision, supply: "never" },
        visit: { ...timedOut, outcome: "cancelled", winner: "cancel" } });
    assert.equal(off.enabled, false);
});

// ─── 2. Source revision preselected; a newer one offered (N8) ───────────────────────────────────────────────────────

test("the sheet always preselects the source revision and offers a newer revision that fits as an unselected choice", () => {
    const draft = workflowRerunDraft(plan(), { mint });
    assert.equal(draft.revision, 3);
    const sheet = workflowRerunSheet(plan(), { draft, name: "provision-cluster", sourceNumber: 2, nextNumber: 3 });
    assert.equal(sheet.title, "Re-run provision-cluster #2 from here");
    assert.equal(sheet.sub, "Starts #3. #2 stays as it is.");
    assert.equal(sheet.from, "provision · visit 1");
    assert.deepEqual(sheet.revisions.map(option => [option.value, option.label, option.checked, option.disabled]), [
        [3, "3  the one #2 ran", true, false],
        [4, "4  newest · Revision 4 also fits", false, false],
    ]);
    assert.equal(sheet.revisionNote, null);
    assert.equal(sheet.start, "Start #3");
    // Choosing 4 checks it; the source stays offered.
    const four = workflowRerunSheet(plan({ revision: { ...plan().revision, target: 4 } }),
        { draft: workflowRerunDraftChange(draft, { revision: 4 }, { mint }), name: "provision-cluster", sourceNumber: 2, nextNumber: 3 });
    assert.deepEqual(four.revisions.map(option => option.checked), [false, true]);
});

test("a newer revision that does not fit is shown disabled with its one-line reason; a locked package says how to attach one", () => {
    const problem = { code: "step_missing", stateId: "provision", visit: 1, message: "Step provision is not in revision 4." };
    const misfit = plan({ revision: { ...plan().revision, newestValidFits: false, newestValidProblem: problem } });
    const sheet = workflowRerunSheet(misfit, { draft: workflowRerunDraft(misfit, { mint }), name: "p", sourceNumber: 2, nextNumber: 3 });
    assert.deepEqual(sheet.revisions[1], { value: 4, label: "4  newest · does not fit: Step provision is not in revision 4.", checked: false, disabled: true,
        reason: "Step provision is not in revision 4." });
    // Nothing newer: the source only.
    const same = plan({ revision: { ...plan().revision, newestValid: 3 } });
    assert.equal(workflowRerunSheet(same, { draft: workflowRerunDraft(same, { mint }), sourceNumber: 2, nextNumber: 3 }).revisions.length, 1);
    // N8: a locked package's definition offers the revisions already attached; Update on the Definition tab attaches a newer one.
    const locked = workflowRerunSheet(same, { draft: workflowRerunDraft(same, { mint }), sourceNumber: 2, nextNumber: 3, locked: true });
    assert.equal(locked.revisionNote, "This package's revisions attached to the session are offered. Use Update on the Definition tab to attach a newer version.");
});

// ─── 3. OQ1 grant note vs a refused reader ──────────────────────────────────────────────────────────────────────────

test("OQ1: an inherited tool grant is said with the source Workflow's date; a refused reader's reason replaces Start", () => {
    const inherited = plan({ grantSource: "inherited" });
    const sheet = workflowRerunSheet(inherited, { draft: workflowRerunDraft(inherited, { mint }), sourceNumber: 2, nextNumber: 3, sourceStartedAt: T(0) });
    assert.equal(sheet.grantNote, "Scripts use the tools this session gave #2 on 2026-11-27.");
    assert.equal(sheet.blocked, null);
    const admin = plan({ allowed: false, blockedReason: "provision-cluster calls tools in its scripts, and this Start cannot hand them over (only the owning person may inherit a tool grant). Ask the session to re-run it." });
    const refused = workflowRerunSheet(admin, { draft: workflowRerunDraft(admin, { mint }), sourceNumber: 2, nextNumber: 3, sourceStartedAt: T(0) });
    assert.equal(refused.grantNote, null);
    assert.equal(refused.blocked, admin.blockedReason);
    assert.deepEqual(workflowRerunCanStart(workflowRerunDraft(admin, { mint }), admin), { ok: false, reason: admin.blockedReason });
    // A session's own grant says nothing.
    assert.equal(workflowRerunSheet(plan({ grantSource: "session" }), { draft: workflowRerunDraft(plan(), { mint }), sourceNumber: 2, nextNumber: 3 }).grantNote, null);
});

// ─── 4. Carried messages in the Reused disclosure (R2-S6) ───────────────────────────────────────────────────────────

test("R2-S6: carried messages are listed inside the collapsed Reused disclosure", () => {
    const carried = plan({ carried: { count: 2, contracts: ["Ack@1", "Note@1"] } });
    const sheet = workflowRerunSheet(carried, { draft: workflowRerunDraft(carried, { mint }), sourceNumber: 2, nextNumber: 3 });
    assert.deepEqual(sheet.reused, { summary: "Reused: 2 steps", lines: ["validate · 1 visit", "plan · 1 visit"], carried: "Carried inputs: 2 (Ack@1, Note@1)" });
    assert.equal(workflowRerunSheet(plan(), { draft: workflowRerunDraft(plan(), { mint }), sourceNumber: 2, nextNumber: 3 }).reused.carried, null);
    assert.deepEqual(sheet.warnings, ["provision · visit 1 does not run. Its result is supplied as 'provisioned'."]);
});

// ─── 5. M6 outcome-only plan reads; R2-S4 local checks; Start's 422 problems ────────────────────────────────────────

test("M6: a plan read names a visit, mode, revision and (in supply) an outcome, never an output or a note", async () => {
    assert.deepEqual(workflowRerunPlanQuery({ executionId: "nx-provision-1", mode: "supply", revision: 4, outcome: "provisioned",
        output: { resourceId: "x" }, note: "why", result: { outcome: "x" } }), { executionId: "nx-provision-1", mode: "supply", revision: 4, outcome: "provisioned" });
    assert.deepEqual(workflowRerunPlanQuery({ mode: "continue", outcome: "provisioned" }), { mode: "continue" });
    assert.deepEqual(workflowRerunPlanQuery({}), {});
    const reads = [];
    const transport = { readWorkflow: async (sessionId, options) => { reads.push([sessionId, options]); return { workflowId: sessionId, rerunPlan: plan() }; } };
    const controller = new PilotSwarmUiController({ store: createStore(appReducer, createInitialState({ mode: "remote" })), transport });
    const read = await controller.readWorkflowRerunPlan("wf-2", { executionId: "nx-provision-1", mode: "supply", outcome: "provisioned", output: { a: 1 } });
    assert.equal(read.ok, true);
    assert.equal(read.plan.from.stateId, "provision");
    assert.deepEqual(reads, [["wf-2", { rerunPlan: { executionId: "nx-provision-1", mode: "supply", outcome: "provisioned" } }]]);
    assert.ok(!JSON.stringify(reads).includes("output"));
    const refused = new PilotSwarmUiController({ store: createStore(appReducer, createInitialState({ mode: "remote" })),
        transport: { readWorkflow: async () => { throw Object.assign(new Error("#2 is still running. Stop it first."), { status: 409, code: "RERUN_SOURCE_ACTIVE" }); } } });
    const failed = await refused.readWorkflowRerunPlan("wf-2", {});
    assert.deepEqual([failed.ok, failed.code], [false, "RERUN_SOURCE_ACTIVE"]);
});

test("R2-S4: the output is checked here for JSON syntax, its size and a nesting depth of at most 64, with no schema library", async () => {
    assert.deepEqual(workflowRerunOutputCheck("", { maxBytes: 100 }), { ok: true, value: null, bytes: 4, problems: [] });
    const bad = workflowRerunOutputCheck("{ resourceId: 1 }", { maxBytes: 100 });
    assert.equal(bad.ok, false);
    assert.match(bad.problems[0].message, /^Not valid JSON: /);
    const big = workflowRerunOutputCheck(JSON.stringify({ text: "x".repeat(200) }), { maxBytes: 100 });
    assert.deepEqual(big.problems, [{ path: "/output", message: "The output is 211 bytes; the limit is 100 bytes." }]);
    const nest = levels => `${"[".repeat(levels)}1${"]".repeat(levels)}`;
    assert.equal(workflowRerunOutputCheck(nest(64), { maxBytes: 1_000 }).ok, true);
    assert.deepEqual(workflowRerunOutputCheck(nest(65), { maxBytes: 1_000 }).problems, [{ path: "/output", message: "The output is nested more than 64 levels deep." }]);
    // Multi-byte characters count as UTF-8 bytes.
    assert.equal(workflowRerunOutputCheck(JSON.stringify("é"), { maxBytes: 100 }).bytes, 4);
    const source = await readFile(new URL("../src/workflow-rerun.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /ajv/i);
});

test("Start's pre-claim 422 problems are shown with the output, and the controller sends the sheet's own operation id", async () => {
    const error = Object.assign(new Error("Supplied result.output does not match provision's outputSchema: must have required property 'objectId'"),
        { status: 422, code: "RERUN_SUPPLIED_RESULT_INVALID", details: { reason: "schema", outputSchema: "Out", problems: [
            { path: "/output", message: "must have required property 'objectId'" }, { path: "/output/cores", message: "must be integer" }] } });
    assert.deepEqual(workflowRerunStartProblems(error), [{ path: "/output", message: "must have required property 'objectId'" },
        { path: "/output/cores", message: "must be integer" }]);
    assert.deepEqual(workflowRerunStartProblems(Object.assign(new Error("Supplied result.output is 300 bytes; the limit for provision is 200 bytes."),
        { status: 422, code: "RERUN_SUPPLIED_RESULT_INVALID", details: { reason: "too_large", bytes: 300, maxBytes: 200 } })),
    [{ path: "/output", message: "Supplied result.output is 300 bytes; the limit for provision is 200 bytes." }]);
    assert.deepEqual(workflowRerunStartProblems(Object.assign(new Error("no"), { status: 409, code: "RERUN_SOURCE_ACTIVE" })), []);
    const sent = [];
    let answer = error;
    const transport = { startSessionWorkflowDefinition: async (ownerId, request) => { sent.push([ownerId, request]); if (answer) throw answer; return { workflowId: "wf-3", revision: 3, name: "p" }; },
        listSessionWorkflowDefinitions: async () => [] };
    const controller = new PilotSwarmUiController({ store: createStore(appReducer, createInitialState({ mode: "remote" })), transport });
    const request = { definitionId: "def-1", revision: 3, operationId: "op-sheet-1",
        rerunFrom: { workflowId: "wf-2", executionId: "nx-provision-1", mode: "supply", result: { outcome: "provisioned", output: { resourceId: "r" } }, note: "why" } };
    const refused = await controller.startWorkflowRerun("owner-1", request);
    assert.deepEqual([refused.ok, refused.code, refused.problems.length], [false, "RERUN_SUPPLIED_RESULT_INVALID", 2]);
    answer = null;
    const started = await controller.startWorkflowRerun("owner-1", request);
    assert.deepEqual([started.ok, started.receipt.workflowId], [true, "wf-3"]);
    assert.deepEqual(sent.map(([owner, body]) => [owner, body.operationId, body.rerunFrom.mode]), [["owner-1", "op-sheet-1", "supply"], ["owner-1", "op-sheet-1", "supply"]]);
    assert.equal(Object.hasOwn(sent[0][1], "inputs"), false);
});

// ─── 6. N5: one operation id per intent ─────────────────────────────────────────────────────────────────────────────

test("N5: the operation id is minted on open and minted again whenever the mode, revision, outcome, output or note changes", () => {
    let n = 0;
    const ids = () => `id-${++n}`;
    const open = workflowRerunDraft(plan(), { mint: ids });
    assert.equal(open.operationId, "id-1");
    // The same values again (a double-click, a retry with the same inputs): the same id.
    assert.equal(workflowRerunDraftChange(open, { outcome: null, note: "" }, { mint: ids }).operationId, "id-1");
    const outcome = workflowRerunDraftChange(open, { outcome: "provisioned" }, { mint: ids });
    assert.equal(outcome.operationId, "id-2");
    const field = workflowRerunDraftChange(outcome, { values: { ...outcome.values, resourceId: "/subscriptions/s/pg1" } }, { mint: ids, plan: plan() });
    assert.equal(field.operationId, "id-3");
    const note = workflowRerunDraftChange(field, { note: "Server pg1 exists." }, { mint: ids, plan: plan() });
    assert.equal(note.operationId, "id-4");
    const revision = workflowRerunDraftChange(note, { revision: 4 }, { mint: ids, plan: plan() });
    assert.equal(revision.operationId, "id-5");
    const mode = workflowRerunDraftChange(revision, { mode: "continue" }, { mint: ids, plan: plan() });
    assert.equal(mode.operationId, "id-6");
    // Fields | JSON with the same value is the same output: the same id.
    const fields = workflowRerunDraftChange(open, { outcome: "provisioned", values: { resourceId: "r", objectId: "o" } }, { mint: ids, plan: plan() });
    const json = workflowRerunDraftChange(fields, { view: "json", outputText: JSON.stringify({ objectId: "o", resourceId: "r" }, null, 2) }, { mint: ids, plan: plan() });
    assert.equal(json.operationId, fields.operationId);
    const edited = workflowRerunDraftChange(json, { outputText: JSON.stringify({ objectId: "o2", resourceId: "r" }) }, { mint: ids, plan: plan() });
    assert.notEqual(edited.operationId, json.operationId);
});

// ─── 7. The schema-guided supply editor ─────────────────────────────────────────────────────────────────────────────

test("a flat object outputSchema is edited as fields; anything else as JSON with a skeleton of its required keys", () => {
    assert.deepEqual(workflowRerunSupplyFields(SCHEMA), [
        { name: "resourceId", type: "string", options: null, required: true, label: "resourceId *", hint: "text · required" },
        { name: "objectId", type: "string", options: null, required: true, label: "objectId *", hint: "text · required" },
        { name: "cores", type: "integer", options: null, required: false, label: "cores", hint: "whole number" },
        { name: "region", type: "enum", options: ["westus3", "eastus"], required: false, label: "region", hint: "one of westus3, eastus" },
        { name: "ready", type: "boolean", options: null, required: false, label: "ready", hint: "yes or no" },
    ]);
    const nested = { type: "object", required: ["server"], properties: { server: { type: "object", properties: { id: { type: "string" } } }, tags: { type: "array" } } };
    assert.equal(workflowRerunSupplyFields(nested), null);
    assert.equal(workflowRerunSupplyFields(null), null);
    assert.equal(workflowRerunOutputSkeleton(nested), '{\n  "server": {}\n}');
    assert.equal(workflowRerunOutputSkeleton(SCHEMA), '{\n  "resourceId": "",\n  "objectId": ""\n}');
    assert.equal(workflowRerunOutputSkeleton(null), "");
    // A draft opens on Fields for a flat schema, on JSON otherwise, with the Why empty.
    const draft = workflowRerunDraft(plan(), { mint });
    assert.deepEqual([draft.mode, draft.view, draft.outcome, draft.note], ["supply", "fields", null, ""]);
    assert.equal(workflowRerunDraft(plan({ supplyContract: { ...plan().supplyContract, resolvedOutputSchema: nested } }), { mint }).view, "json");
});

test("Start needs an outcome, an output that checks, and a non-blank Why of at most 2,000 characters", () => {
    const p = plan();
    let draft = workflowRerunDraft(p, { mint });
    assert.deepEqual(workflowRerunCanStart(draft, p), { ok: false, reason: "Choose an outcome." });
    draft = workflowRerunDraftChange(draft, { outcome: "provisioned" }, { mint, plan: p });
    assert.deepEqual(workflowRerunCanStart(draft, p), { ok: false, reason: "resourceId is required." });
    draft = workflowRerunDraftChange(draft, { values: { resourceId: "/subscriptions/s/pg1", objectId: "9f4e", cores: "4", region: "westus3", ready: true } }, { mint, plan: p });
    assert.deepEqual(workflowRerunDraftOutput(draft, p).value, { resourceId: "/subscriptions/s/pg1", objectId: "9f4e", cores: 4, region: "westus3", ready: true });
    assert.deepEqual(workflowRerunCanStart(draft, p), { ok: false, reason: "Say why this result is supplied." });
    assert.equal(workflowRerunCanStart(workflowRerunDraftChange(draft, { note: "   " }, { mint, plan: p }), p).ok, false);
    assert.deepEqual(workflowRerunCanStart(workflowRerunDraftChange(draft, { note: "x".repeat(2_001) }, { mint, plan: p }), p),
        { ok: false, reason: "The reason is longer than 2,000 characters." });
    const ready = workflowRerunDraftChange(draft, { note: "Server pg1 finished provisioning in Azure after the script timed out." }, { mint, plan: p });
    assert.deepEqual(workflowRerunCanStart(ready, p), { ok: true, reason: null });
    assert.equal(workflowRerunCanStart(workflowRerunDraftChange(ready, { values: { ...ready.values, cores: "four" } }, { mint, plan: p }), p).reason,
        "cores must be a whole number.");
    // The plan's own outcome preview refusing it stops Start too.
    const unrouted = plan({ supply: { outcome: "failed", valid: false, next: null, problems: [{ code: "no_route", stateId: "provision", visit: 1, message: "No route from provision for outcome 'failed'." }] } });
    assert.deepEqual(workflowRerunCanStart(workflowRerunDraftChange(ready, { outcome: "failed" }, { mint, plan: unrouted }), unrouted),
        { ok: false, reason: "No route from provision for outcome 'failed'." });
    // Start's request: the visit the plan previewed, its mode, the supplied result and the Why; no inputs.
    assert.deepEqual(workflowRerunStartRequest(ready, { plan: p, definitionId: "def-1" }), {
        definitionId: "def-1", revision: 3, operationId: ready.operationId,
        rerunFrom: { workflowId: "wf-2", executionId: "nx-provision-1", mode: "supply",
            result: { outcome: "provisioned", output: { resourceId: "/subscriptions/s/pg1", objectId: "9f4e", cores: 4, region: "westus3", ready: true } },
            note: "Server pg1 finished provisioning in Azure after the script timed out." } });
    const again = plan({ mode: "run_again", modesAvailable: ["run_again", "continue"], supplyContract: null, from: { ...p.from, visit: 2, executionId: "nx-provision-2" } });
    const runAgain = workflowRerunDraft(again, { mint });
    assert.deepEqual(workflowRerunCanStart(runAgain, again), { ok: true, reason: null });
    assert.deepEqual(workflowRerunStartRequest(runAgain, { plan: again, definitionId: "def-1" }).rerunFrom,
        { workflowId: "wf-2", executionId: "nx-provision-2", mode: "run_again" });
    // The sheet's effect line follows the mode.
    assert.equal(workflowRerunSheet(p, { draft: ready, sourceNumber: 2, nextNumber: 3 }).effect,
        "provision · visit 1 does not run; supplied as 'provisioned'. Runs configure next.");
    assert.equal(workflowRerunSheet(again, { draft: runAgain, sourceNumber: 2, nextNumber: 3 }).effect, "Runs provision · visit 2 again.");
    assert.deepEqual(workflowRerunSheet(p, { draft: ready, sourceNumber: 2, nextNumber: 3 }).modes.map(m => [m.value, m.label]),
        [["continue", "Keep this step's result and go on"], ["supply", "Supply this step's result and go on"]]);
    assert.deepEqual(workflowRerunSheet(p, { draft: ready, sourceNumber: 2, nextNumber: 3 }).outcomes,
        [{ value: "provisioned", label: "provisioned → configure · visit 1" }, { value: "failed", label: "failed → no route" }]);
    const never = plan({ modesAvailable: ["continue"], mode: "continue", supplyContract: null });
    assert.equal(workflowRerunSheet(never, { draft: workflowRerunDraft(never, { mint }), sourceNumber: 2, nextNumber: 3, supplyNever: true }).supplyNote,
        "This step sets supply: never.");
});

test("H1: Start waits for a plan read for the draft's own visit, mode, revision and (in supply) outcome; an older plan never stands in", () => {
    const key = selection => workflowRerunSelectionKey({ executionId: "nx-provision-1", revision: 3, ...selection });
    // The outcome is part of the choice in supply only; none and "" are the same choice, and not any outcome.
    assert.equal(key({ mode: "continue", outcome: "provisioned" }), key({ mode: "continue" }));
    assert.equal(key({ mode: "supply", outcome: "" }), key({ mode: "supply", outcome: null }));
    for (const other of [key({ mode: "run_again" }), key({ mode: "continue", revision: 4 }), key({ mode: "continue", executionId: "nx-plan-1" })]) {
        assert.notEqual(other, key({ mode: "continue" }));
    }
    assert.notEqual(key({ mode: "supply", outcome: "provisioned" }), key({ mode: "supply", outcome: "failed" }));
    assert.notEqual(key({ mode: "supply", outcome: "provisioned" }), key({ mode: "supply" }));

    // A good plan for Keep this step's result: Start may go.
    const kept = plan({ mode: "continue", supply: null });
    const open = workflowRerunDraft(kept, { mint });
    assert.deepEqual(workflowRerunCanStart(open, kept, { previewed: key({ mode: "continue" }) }), { ok: true, reason: null });
    // No plan read yet, or a new mode or revision whose read is on its way or failed: that plan does not let Start go.
    assert.deepEqual(workflowRerunCanStart(open, kept, { previewed: null }), { ok: false, reason: "Reading the plan…" });
    for (const patch of [{ mode: "run_again" }, { revision: 4 }]) {
        assert.deepEqual(workflowRerunCanStart(workflowRerunDraftChange(open, patch, { mint, plan: kept }), kept, { previewed: key({ mode: "continue" }) }),
            { ok: false, reason: "Reading the plan…" }, JSON.stringify(patch));
    }

    // Supply: the plan read for 'provisioned' does not let Start send 'failed', or a cleared outcome.
    const p = plan({ supply: { outcome: "provisioned", valid: true, next: { stateId: "configure", visit: 1 }, problems: [] } });
    let ready = workflowRerunDraftChange(workflowRerunDraft(p, { mint }), { outcome: "provisioned" }, { mint, plan: p });
    ready = workflowRerunDraftChange(ready, { values: { resourceId: "/subscriptions/s/pg1", objectId: "9f4e" }, note: "pg1 exists." }, { mint, plan: p });
    const shown = key({ mode: "supply", outcome: "provisioned" });
    assert.deepEqual(workflowRerunCanStart(ready, p, { previewed: shown }), { ok: true, reason: null });
    for (const outcome of ["failed", null, ""]) {
        assert.equal(workflowRerunCanStart(workflowRerunDraftChange(ready, { outcome }, { mint, plan: p }), p, { previewed: shown }).ok, false, String(outcome));
    }
    // Once the plan for 'failed' is read, its own preview decides.
    const failed = plan({ supply: { outcome: "failed", valid: false, next: null, problems: [{ code: "no_route", message: "No route from provision for outcome 'failed'." }] } });
    assert.deepEqual(workflowRerunCanStart(workflowRerunDraftChange(ready, { outcome: "failed" }, { mint, plan: failed }), failed,
        { previewed: key({ mode: "supply", outcome: "failed" }) }), { ok: false, reason: "No route from provision for outcome 'failed'." });
});

// ─── 8. Reused and supplied in the Log, timeline, graph and Node panel ──────────────────────────────────────────────

const STATES = [
    { id: "validate", type: "script", runtime: "node", outcomes: ["ok"], next: { ok: "provision" } },
    { id: "provision", type: "script", runtime: "node", outcomes: ["provisioned", "failed"], next: { provisioned: "configure", failed: "failed" } },
    { id: "configure", type: "script", runtime: "node", outcomes: ["configured"], next: { configured: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const REUSED = { workflowId: "wf-2", runId: "run-2", executionId: "nx-validate-src", reusedAt: T(5) };
const SUPPLIED = { from: { workflowId: "wf-2", runId: "run-2", executionId: "nx-provision-src" }, by: { kind: "user", name: "Affan Dar" },
    note: "Server pg1 finished provisioning in Azure after timeout.", at: T(5) };
const rerunModel = () => readModel({
    graph: { revision: 3, initial: "validate", states: STATES },
    run: { runId: "run-3", status: "completed", outcome: "succeeded", terminalState: "done",
        rerunOf: { workflowId: "wf-2", runId: "run-2", executionId: "nx-provision-src", mode: "supply", stateId: "provision", visit: 1, revision: 3,
            supplied: { outcome: "provisioned", note: SUPPLIED.note, at: T(5) } } },
    runs: [{ runId: "run-3", mode: "live", status: "completed", revision: 3, outcome: "succeeded" }],
    nodeExecutions: [
        done("validate", 1, "ok", { enteredAt: T(0), endedAt: T(1), reused: REUSED }),
        done("provision", 1, "provisioned", { predecessorId: "nx-validate-1", enteredAt: T(5), endedAt: T(5), outputPreview: '{"resourceId":"r","objectId":"o"}',
            supplied: SUPPLIED }),
        done("configure", 1, "configured", { predecessorId: "nx-provision-1", enteredAt: T(6), endedAt: T(7) }),
        done("done", 1, "succeeded", { predecessorId: "nx-configure-1", enteredAt: T(7), endedAt: T(7) }),
    ],
});

test("the two re-run events are workflow events; reused lines fold into one, a supplied line stays its own", () => {
    for (const type of ["workflow.state_reused", "workflow.state_supplied"]) assert.ok(WORKFLOW_EVENT_TYPES.includes(type), type);
    const reused = (stateId, n, seq) => ({ seq, eventType: "workflow.state_reused", createdAt: T(5), data: { runId: "run-3", nodeExecutionId: `nx-${stateId}-1`,
        stateId, scopeId: "root", ordinal: 1, type: "script", outcome: "ok", resultKind: "business", reusedFrom: { workflowId: "wf-2", runId: "run-2", executionId: `src-${n}` } } });
    const supplied = { seq: 3, eventType: "workflow.state_supplied", createdAt: T(5), data: { runId: "run-3", nodeExecutionId: "nx-provision-1", stateId: "provision",
        scopeId: "root", ordinal: 1, outcome: "provisioned", resultKind: "business", suppliedFrom: { workflowId: "wf-2", runId: "run-2", executionId: "src-p" },
        by: { kind: "user", displayName: "Affan Dar" }, note: "Server pg1 finished provisioning in Azure after timeout.", suppliedAt: T(5) } };
    const started = { seq: 4, eventType: "workflow.state_started", createdAt: T(6), data: { runId: "run-3", nodeExecutionId: "nx-configure-1", stateId: "configure", ordinal: 1 } };
    const rows = workflowActivity([reused("validate", 1, 1), reused("plan", 2, 2), supplied, started], { runId: "run-3", limit: Infinity });
    const folded = workflowRerunLogRows(rows, { numberOf });
    assert.deepEqual(folded.map(item => item.fold ?? item.eventType), ["workflow.state_started", "workflow.state_supplied", "reused"]);
    assert.equal(folded[2].what, "2 steps reused from #2");
    assert.deepEqual(folded[2].rows.map(item => item.what), ["✓ plan reused", "✓ validate reused"]);
    assert.equal(folded[1].what, "✎ provision · visit 1 supplied → provisioned by Affan Dar (“Server pg1 finished provisioning in Azure after timeout.”)");
    assert.equal(workflowRerunLogRows(rows.slice(3), { numberOf: () => null })[0].what, "1 step reused from an earlier Workflow");
    // The step log (the transcript): its own lines.
    assert.match(formatWorkflowEventText(supplied), /^✎ `provision` supplied → \*\*provisioned\*\*/);
    assert.equal(describeWorkflowEvent(reused("validate", 1, 1)).color, "gray");
    assert.equal(describeWorkflowEvent(supplied).color, "yellow");
});

test("the timeline knows its reused and supplied visits: a band before the re-run starts, with the supplied visit marked", () => {
    const projection = projectWorkflow({ readModel: rerunModel(), numberOf });
    const frames = workflowReplayFrames(projection.allExecutions);
    assert.deepEqual(frames.map(frame => [frame.stateId, frame.reused === true, frame.supplied === true]),
        [["validate", true, false], ["provision", false, true], ["configure", false, false], ["done", false, false]]);
    assert.deepEqual(workflowRerunTimeline(frames, { sourceNumber: 2 }), { reused: 1, supplied: 1, end: 1, suppliedIndex: 1, label: "1 reused + 1 supplied" });
    assert.equal(workflowRerunTimeline(frames.slice(0, 1), { sourceNumber: 2 }).label, "1 reused from #2");
    assert.equal(workflowRerunTimeline(frames.slice(2)), null);
});

test("the graph and the Node panel tell a reused visit from a supplied one, never as one that ran", () => {
    const projection = projectWorkflow({ readModel: rerunModel(), numberOf });
    const node = id => projection.nodes.find(item => item.id === id);
    assert.equal(node("validate").provenance.kind, "reused");
    assert.deepEqual([node("validate").card.provenance, node("validate").card.fact, node("validate").card.mark.glyph], ["reused", "Reused from #2", "✓"]);
    assert.match(node("validate").card.title, /Reused from #2/);
    assert.deepEqual([node("provision").card.provenance, node("provision").card.fact, node("provision").card.mark.glyph],
        ["supplied", "Supplied (provisioned)", "✎"]);
    assert.equal(node("configure").card.provenance, undefined);
    const supplied = workflowVisitIo(node("provision"), node("provision").current, { numberOf, workflowNumber: 3, now: Date.parse(T(10)) });
    assert.deepEqual(supplied.provenance, { kind: "supplied", head: "✎ Supplied in #3 (did not run) · by Affan Dar · 09:05:00",
        reason: "Server pg1 finished provisioning in Azure after timeout.", origin: "Replaced #2's visit", workflowId: "wf-2", executionId: "nx-provision-src",
        open: "Open in #2", gone: false });
    const reused = workflowVisitIo(node("validate"), node("validate").current, { numberOf, workflowNumber: 3, now: Date.parse(T(10)) });
    assert.deepEqual(reused.provenance, { kind: "reused", head: "Reused from #2 · ran 09:00:00 · took 1 min", reason: null, origin: null,
        workflowId: "wf-2", executionId: "nx-validate-src", open: "Open in #2", gone: false });
    assert.equal(workflowVisitIo(node("configure"), node("configure").current).provenance, null);
    // A swept origin cannot be opened.
    const gone = workflowVisitIo(node("validate"), { ...node("validate").current, reused: { ...REUSED, originGone: true } }, { numberOf });
    assert.deepEqual([gone.provenance.gone, gone.provenance.open], [true, null]);
});

test("the header says what a Workflow re-ran and what re-ran it", () => {
    const run = rerunModel().run;
    assert.equal(workflowRerunChip(run.rerunOf, { numberOf }), "Re-run of #2 · supplied provision · visit 1");
    assert.equal(workflowRerunChip({ ...run.rerunOf, mode: "run_again", stateId: "finish", supplied: undefined }, { numberOf }), "Re-run of #2 from finish · visit 1");
    assert.equal(workflowRerunChip(run.rerunOf, { numberOf, phone: true }), "Re-run of #2");
    assert.equal(workflowRerunChip(null), null);
    assert.equal(workflowRerunReruns([{ workflowId: "wf-3", mode: "supply" }, { workflowId: "wf-9" }], { numberOf }), "Re-run as #3");
    assert.equal(workflowRerunReruns([], { numberOf }), null);
    // A definition's Workflows by number.
    const numbers = workflowRerunNumbers({ workflows: [{ sessionId: "wf-a", number: 1 }, { sessionId: "wf-b", number: 2 }] });
    assert.deepEqual([numbers("wf-b"), numbers("wf-x")], [2, null]);
});
