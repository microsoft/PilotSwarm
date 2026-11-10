/**
 * Workflow Simplified stage 2.1b: the Workflow tab on a session's own Workflow Definitions (spec "definitions" R1, R6;
 * "editing" E2-2, E2-3, E2-5, E2-8; the coordinator's 2.1 readings Q5, Q8, Q10). The helpers that turn the server's list
 * and reads into what the tab shows, the reducer's two new cases, and the controller's reads, save, start and delete
 * against a stub transport. The browser specs (workflow-tab.spec.mjs, "session definitions") drive the screens.
 *
 * Run: node --test ui/core/test/workflow-session-definitions.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    SESSION_DEFINITION_READS_MAX, sessionDefinitionDefault, sessionDefinitionFailure, sessionDefinitionOfWorkflow, sessionDefinitionOptionLabel, sessionDefinitionReadKey,
    sessionDefinitionsLoaded, sessionDefinitionsModel, sessionDefinitionsStamp, sessionNextWorkflowNumber, sessionReadAccess, sessionRevisionAuthorWords, sessionRevisionCompare,
    sessionDeleteWords, sessionRevisionOptionLabel, sessionRevisionReadModel, sessionShownRevision, sessionStartControl, sessionLastTestWords, isWorkflowTestBench, WORKFLOW_TEST_BENCH_KIND,
} from "../src/workflow-session-definitions.js";
import { projectWorkflow } from "../src/workflow-view.js";

const OWNER = "owner-1";
const T0 = "2026-11-07T09:00:00.000Z";
const at = minutes => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const rev = (revision, extra = {}) => ({ definitionId: "def-hn", revision, valid: true, semver: "1.0.0", yamlSha256: `sha-${revision}`, irSha256: `ir-${revision}`,
    basedOn: revision > 1 ? revision - 1 : null, actor: { kind: "session", sessionId: OWNER }, imported: false, createdAt: at(revision), errorCount: 0, ...extra });
const HN = {
    definitionId: "def-hn", ownerSessionId: OWNER, name: "hn-top-watch", currentRevision: 3, source: "session", createdAt: at(1), updatedAt: at(3), deletedAt: null,
    newestValidRevision: 2,
    revisions: [rev(1), rev(2, { actor: { kind: "user", provider: "aad", subject: "s-1", display: "Affan Dar" }, semver: "1.1.0" }),
        rev(3, { valid: false, errorCount: 2, irSha256: null })],
    workflows: [
        { workflowSessionId: "wf-a", definitionId: "def-hn", revision: 1, runStatus: "completed", createdAt: at(10) },
        { workflowSessionId: "wf-draft", definitionId: "def-hn", revision: 1, runStatus: null, createdAt: at(11) },
        { workflowSessionId: "wf-b", definitionId: "def-hn", revision: 2, runStatus: "running", createdAt: at(12) },
    ],
};
const ALPHA = { definitionId: "def-alpha", ownerSessionId: OWNER, name: "alpha", currentRevision: 1, source: "session", createdAt: at(0), updatedAt: at(1),
    deletedAt: null, newestValidRevision: 1, revisions: [rev(1, { definitionId: "def-alpha" })], workflows: [] };
const GONE_EMPTY = { ...ALPHA, definitionId: "def-gone", name: "gone", deletedAt: at(5), workflows: [] };
const GONE_KEPT = { ...ALPHA, definitionId: "def-old", name: "older", deletedAt: at(6),
    workflows: [{ workflowSessionId: "wf-old", definitionId: "def-old", revision: 1, runStatus: "completed", createdAt: at(2) }] };
const LIST = [HN, GONE_KEPT, GONE_EMPTY, ALPHA];

test("the list becomes the tab's definitions: live by name, a deleted one only while it has Workflows, revisions newest first", () => {
    const model = sessionDefinitionsModel(LIST);
    assert.deepEqual(model.map(item => [item.name, item.deleted]), [["alpha", false], ["hn-top-watch", false], ["older", true]]);
    const hn = model[1];
    assert.deepEqual(hn.revisions.map(item => item.revision), [3, 2, 1]);
    assert.equal(hn.currentRevision, 3);
    assert.equal(hn.newestValidRevision, 2);
    // Only Workflows that started are numbered (R1: each runs its revision); a stage 1 child that never ran is its revision (Q5).
    assert.deepEqual(hn.workflows.map(item => [item.sessionId, item.number, item.revision, item.runStatus]),
        [["wf-a", 1, 1, "completed"], ["wf-b", 2, 2, "running"]]);
    assert.deepEqual(hn.drafts.map(item => [item.sessionId, item.revision]), [["wf-draft", 1]]);
    assert.equal(hn.newestId, "wf-b");
    assert.equal(sessionNextWorkflowNumber(hn), 3);
    assert.equal(sessionDefinitionOptionLabel(model[2]), "older · deleted");
    assert.equal(sessionDefinitionOptionLabel(hn), "hn-top-watch");
    // Not a list: not loaded (the tab keeps the stage 1 grouping).
    assert.equal(sessionDefinitionsLoaded({ items: LIST }), true);
    assert.equal(sessionDefinitionsLoaded({ unsupported: true }), false);
    assert.equal(sessionDefinitionsLoaded(null), false);
    assert.deepEqual(sessionDefinitionsModel({}), []);
    assert.deepEqual(sessionDefinitionsModel([null, { name: "x" }, { definitionId: "y" }]), []);
});

test("the default definition is the live one saved most recently; a Workflow finds its definition, a never-started child its revision", () => {
    const model = sessionDefinitionsModel(LIST);
    assert.equal(sessionDefinitionDefault(model).name, "hn-top-watch");
    assert.equal(sessionDefinitionDefault([]), null);
    const found = sessionDefinitionOfWorkflow(model, "wf-b");
    assert.equal(found.definition.name, "hn-top-watch");
    assert.equal(found.workflow.number, 2);
    const draft = sessionDefinitionOfWorkflow(model, "wf-draft");
    assert.equal(draft.workflow, null);
    assert.equal(draft.draft.revision, 1);
    assert.equal(sessionDefinitionOfWorkflow(model, "wf-old").definition.deleted, true);
    assert.equal(sessionDefinitionOfWorkflow(model, "nope"), null);
    assert.equal(sessionDefinitionOfWorkflow(model, null), null);
});

test("each revision says who saved it and when (E2-2); the shown revision is the one chosen, else the newest", () => {
    const hn = sessionDefinitionsModel(LIST)[1];
    assert.equal(sessionRevisionAuthorWords(hn.revisions[0]), "by the session");
    assert.equal(sessionRevisionAuthorWords(hn.revisions[1]), "by Affan Dar");
    assert.equal(sessionRevisionAuthorWords({ imported: true }), "imported");
    assert.equal(sessionRevisionAuthorWords({ actor: { kind: "system", name: "imported" } }), "imported");
    assert.equal(sessionRevisionAuthorWords({ actor: { kind: "user", provider: "p", subject: "s" } }), "by a person");
    assert.equal(sessionRevisionOptionLabel(hn.revisions[0], { time: "09:03:00 UTC", current: true }),
        "Revision 3 · newest · by the session · 09:03:00 UTC · not valid · version 1.0.0");
    assert.equal(sessionRevisionOptionLabel(hn.revisions[1], { time: null }), "Revision 2 · by Affan Dar · version 1.1.0");
    assert.equal(sessionShownRevision(hn, 2), 2);
    assert.equal(sessionShownRevision(hn, 9), 3, "a revision that does not exist shows the newest");
    assert.equal(sessionShownRevision(hn, null), 3);
    assert.equal(sessionShownRevision(null, 1), null);
});

test("Start starts the revision shown: refused, with why, for one with errors (E2-5), a deleted definition, or a caller who may not", () => {
    const [alpha, hn, older] = sessionDefinitionsModel(LIST);
    assert.deepEqual(sessionStartControl(hn, 2), { enabled: true, revision: 2, title: null });
    assert.equal(sessionStartControl(hn, 3).enabled, false);
    assert.equal(sessionStartControl(hn, 3).title, "Revision 3 has errors, so it cannot start.");
    assert.equal(sessionStartControl(older, 1).title, "older was deleted, so it cannot start.");
    assert.match(sessionStartControl(alpha, 1, { personCommands: false }).title, /does not take Workflow commands from people/);
    assert.equal(sessionStartControl(alpha, 1, { allowed: false, reason: "Only this workflow's owner or an admin can command it." }).title,
        "Only this workflow's owner or an admin can command it.");
    assert.equal(sessionStartControl(alpha, null).enabled, false);
});

test("a revision's read draws its graph as a Workflow's view does; a reader gets no YAML", () => {
    const hn = sessionDefinitionsModel(LIST)[1];
    const value = {
        ...HN, revision: { ...rev(2), yaml: "apiVersion: pilotswarm.dev/v1\n", diagnostics: [] },
        graph: { revision: 2, initial: "poll", states: [{ id: "poll", type: "script", outcomes: ["done"], next: { done: "done" } }, { id: "done", type: "terminal", outcome: "succeeded" }],
            inputsSchema: { type: "object", properties: { topic: { type: "string" } } } },
        personCommands: true, viewer: { allowed: true, reason: null },
    };
    const model = sessionRevisionReadModel(hn, value);
    assert.equal(model.workflowId, "def-hn");
    assert.equal(model.revision.revision, 2);
    assert.equal(model.revision.name, "hn-top-watch");
    const projection = projectWorkflow({ definition: null, readModel: null, workflowModel: model, selectedRunId: null, events: [] });
    assert.deepEqual(projection.nodes.map(node => node.id), ["poll", "done"]);
    assert.equal(projection.definition.initial, "poll");
    assert.deepEqual(sessionReadAccess(value), { allowed: true, reason: null, personCommands: true, yaml: "apiVersion: pilotswarm.dev/v1\n" });
    const reader = { ...value, revision: { ...rev(2), diagnostics: [] }, viewer: { allowed: false, reason: "Only this workflow's owner or an admin can command it." } };
    assert.deepEqual(sessionReadAccess(reader), { allowed: false, reason: "Only this workflow's owner or an admin can command it.", personCommands: true, yaml: null });
    // A revision with errors has no graph; its diagnostics stay.
    const broken = sessionRevisionReadModel(hn, { ...value, revision: { ...rev(3, { valid: false }), yaml: "x", diagnostics: [{ severity: "error", code: "E", message: "bad", line: 2 }] }, graph: null });
    const brokenProjection = projectWorkflow({ definition: null, readModel: null, workflowModel: broken, selectedRunId: null, events: [] });
    assert.equal(brokenProjection.definition, null);
    assert.equal(brokenProjection.diagnostics.length, 1);
    assert.equal(sessionRevisionReadModel(hn, null), null);
});

test("Compare shows any two revisions (E2-8): their line diff, a failed read, or that this caller cannot read the YAML", () => {
    const read = (yaml, revision) => ({ phase: "ready", value: { revision: { revision, valid: true, ...(yaml === null ? {} : { yaml }) } } });
    const compared = sessionRevisionCompare(read("a\nb\n", 1), read("a\nc\n", 2), 1, 2);
    assert.equal(compared.ready, true);
    assert.equal(compared.summary, "Revision 1 → 2: +1 −1 lines");
    assert.equal(sessionRevisionCompare(read("a", 1), read("a", 2), 1, 2).summary, "Revisions 1 and 2 are the same.");
    assert.equal(sessionRevisionCompare(read("a", 1), { phase: "loading" }, 1, 2).summary, "Reading revisions 1 and 2…");
    assert.equal(sessionRevisionCompare(read("a", 1), { phase: "failed", error: "gone" }, 1, 2).summary, "Revision 2 could not be read: gone");
    const hidden = sessionRevisionCompare(read(null, 1), read(null, 2), 1, 2);
    assert.equal(hidden.ready, false);
    assert.equal(hidden.summary, "Only people who can change this definition can read its YAML.");
});

test("a stale save says who saved the newer revision and when, in this screen's time (E2-3); no answer may be sent again", () => {
    const stale = Object.assign(new Error("Revision 6 was saved by the session at 2026-11-07T09:41:00.000Z. Reload to edit it. Nothing was saved."),
        { code: "REVISION_STALE", status: 409, details: { definitionId: "def-hn", currentRevision: 6, expectedRevision: 5,
            savedBy: { kind: "session", sessionId: OWNER }, savedAt: "2026-11-07T09:41:00.000Z" } });
    const failure = sessionDefinitionFailure(stale, { timeOf: () => "9:41 AM" });
    assert.equal(failure.phase, "failed");
    assert.equal(failure.code, "REVISION_STALE");
    assert.equal(failure.stale, 6);
    assert.equal(failure.message, "Revision not saved: revision 6 was saved by the session at 9:41 AM. Reload to edit it.");
    const byPerson = sessionDefinitionFailure(Object.assign(new Error("x"), { code: "REVISION_STALE", status: 409,
        details: { currentRevision: 4, savedBy: { kind: "user", provider: "p", subject: "s", display: "Affan Dar" }, savedAt: null } }));
    assert.equal(byPerson.message, "Revision not saved: revision 4 was saved by Affan Dar. Reload to edit it.");
    const inUse = sessionDefinitionFailure(Object.assign(new Error("hn-top-watch has a Workflow still running. Stop it first, then delete it."),
        { code: "DEFINITION_IN_USE", status: 409 }));
    assert.equal(inUse.phase, "failed");
    assert.equal(inUse.stale, null);
    assert.equal(inUse.message, "hn-top-watch has a Workflow still running. Stop it first, then delete it.");
    // UX2D-F1: a stale refusal without its details (an older server) still offers Reload, with no machine time.
    const bare = sessionDefinitionFailure(Object.assign(new Error("Revision 6 was saved by the session at 2026-11-07T09:41:00.000Z. Reload to edit it. Nothing was saved."),
        { code: "REVISION_STALE", status: 409 }));
    assert.equal(bare.stale, "newest");
    assert.equal(bare.message, "Revision not saved: a newer revision was saved by someone else. Reload to edit it.");
    const lost = sessionDefinitionFailure(new Error("socket hang up"));
    assert.equal(lost.phase, "unconfirmed");
    assert.match(lost.message, /^No answer came, so it may or may not have happened: socket hang up/);
});

test("the list is asked again when the session's row or one of its Workflows changes, not otherwise", () => {
    const byId = {
        [OWNER]: { sessionId: OWNER, updatedAt: 1, status: "idle" },
        "wf-a": { sessionId: "wf-a", sessionKind: "workflow", parentSessionId: OWNER, updatedAt: 5, status: "completed" },
        other: { sessionId: "other", updatedAt: 9 },
    };
    const before = sessionDefinitionsStamp(byId, OWNER);
    assert.equal(sessionDefinitionsStamp({ ...byId, other: { sessionId: "other", updatedAt: 10 } }, OWNER), before);
    assert.notEqual(sessionDefinitionsStamp({ ...byId, [OWNER]: { ...byId[OWNER], updatedAt: 2 } }, OWNER), before);
    assert.notEqual(sessionDefinitionsStamp({ ...byId, "wf-b": { sessionId: "wf-b", sessionKind: "workflow", parentSessionId: OWNER, updatedAt: 6 } }, OWNER), before);
    assert.equal(sessionDefinitionsStamp(byId, null), "");
});

test("the reducer keeps each session's list and its revision reads, at most SESSION_DEFINITION_READS_MAX per session, the oldest going first", () => {
    let state = createInitialState({ mode: "api" });
    state = appReducer(state, { type: "ui/sessionDefinitions", ownerId: OWNER, patch: { items: LIST, at: 1, error: null } });
    assert.equal(state.ui.sessionDefinitions[OWNER].items, LIST);
    const same = appReducer(state, { type: "ui/sessionDefinitions", ownerId: OWNER, patch: { items: LIST } });
    assert.equal(same, state, "an unchanged patch changes nothing");
    state = appReducer(state, { type: "ui/sessionDefinitions", ownerId: OWNER, patch: { error: "boom" } });
    assert.equal(state.ui.sessionDefinitions[OWNER].items, LIST, "a failure keeps the last list");
    for (let revision = 1; revision <= SESSION_DEFINITION_READS_MAX + 3; revision += 1) {
        state = appReducer(state, { type: "ui/sessionDefinitionRead", ownerId: OWNER, key: sessionDefinitionReadKey("def-hn", revision),
            entry: { phase: "ready", value: { revision: { revision } }, error: null, at: revision } });
    }
    const keys = Object.keys(state.ui.sessionDefinitionReads[OWNER]);
    assert.equal(keys.length, SESSION_DEFINITION_READS_MAX);
    assert.equal(keys.includes("def-hn:1"), false);
    assert.equal(keys.includes(`def-hn:${SESSION_DEFINITION_READS_MAX + 3}`), true);
    assert.equal(appReducer(state, { type: "ui/sessionDefinitionRead", ownerId: OWNER, key: "", entry: {} }), state);
});

test("selecting a Workflow row forgets the revision chosen in the tab, so the Definition view shows the revision that Workflow runs", () => {
    let state = createInitialState({ mode: "api" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: OWNER, title: "chat", updatedAt: 1 },
        { sessionId: "wf-b", sessionKind: "workflow", parentSessionId: OWNER, title: "Workflow: hn-top-watch", updatedAt: 2, status: "running" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: OWNER });
    state = appReducer(state, { type: "ui/workflowTab", ownerId: OWNER, patch: { view: "definition", sessionRevision: 3, sessionDefinitionId: "def-hn" } });
    state = appReducer(state, { type: "sessions/selected", sessionId: "wf-b" });
    const tab = state.ui.workflowTabs[OWNER];
    assert.equal(tab.view, "workflows");
    assert.equal(tab.workflowId, "wf-b");
    assert.equal("sessionRevision" in tab, false);
});

function harness({ transport = {} } = {}) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: OWNER, title: "chat", updatedAt: 1 }] });
    store.dispatch({ type: "sessions/selected", sessionId: OWNER });
    return { store, controller, state: () => store.getState() };
}

test("the controller reads a session's definitions once at a time; a connection without them, or an answer that is not a list, keeps stage 1", async () => {
    const { controller, state } = harness();
    await controller.ensureSessionWorkflowDefinitions(OWNER);
    assert.equal(state().ui.sessionDefinitions[OWNER].unsupported, true, "no operation on this connection");

    let calls = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const listing = harness({ transport: { async listSessionWorkflowDefinitions(sessionId, options) {
        calls += 1;
        assert.equal(sessionId, OWNER);
        assert.deepEqual(options, { includeDeleted: true });
        if (calls === 1) await gate;
        return LIST;
    } } });
    const first = listing.controller.ensureSessionWorkflowDefinitions(OWNER);
    const second = listing.controller.ensureSessionWorkflowDefinitions(OWNER);
    release();
    await first;
    await second;
    assert.equal(calls, 2, "an ask while a read is in flight reads once more after it, not in parallel");
    assert.equal(listing.state().ui.sessionDefinitions[OWNER].items, LIST);
    assert.equal(sessionDefinitionsLoaded(listing.state().ui.sessionDefinitions[OWNER]), true);

    const odd = harness({ transport: { async listSessionWorkflowDefinitions() { return undefined; } } });
    await odd.controller.ensureSessionWorkflowDefinitions(OWNER);
    assert.equal(sessionDefinitionsLoaded(odd.state().ui.sessionDefinitions[OWNER]), false);
    assert.equal(odd.state().ui.sessionDefinitions[OWNER].unsupported, true);

    let fail = false;
    const flaky = harness({ transport: { async listSessionWorkflowDefinitions() { if (fail) throw new Error("network down"); return LIST; } } });
    await flaky.controller.ensureSessionWorkflowDefinitions(OWNER);
    fail = true;
    await flaky.controller.ensureSessionWorkflowDefinitions(OWNER);
    assert.equal(flaky.state().ui.sessionDefinitions[OWNER].items, LIST, "a failed read keeps the last list");
    assert.equal(flaky.state().ui.sessionDefinitions[OWNER].error, "network down");
    // A Workflow session owns no definitions: nothing is read for it.
    assert.equal(await flaky.controller.ensureSessionWorkflowDefinitions("missing"), null);
});

test("a revision is read once (it never changes); a failed read is read again when asked", async () => {
    let calls = 0;
    let fail = true;
    const { controller, state } = harness({ transport: { async readSessionWorkflowDefinition(sessionId, ref) {
        calls += 1;
        assert.equal(sessionId, OWNER);
        assert.deepEqual(ref, { definitionId: "def-hn", revision: 2 });
        if (fail) throw Object.assign(new Error("Session not found."), { code: "NOT_FOUND", status: 404 });
        return { ...HN, revision: { ...rev(2), yaml: "y", diagnostics: [] }, graph: null, viewer: { allowed: true, reason: null }, personCommands: true };
    } } });
    const key = sessionDefinitionReadKey("def-hn", 2);
    await controller.readSessionWorkflowRevision(OWNER, "def-hn", 2);
    assert.equal(state().ui.sessionDefinitionReads[OWNER][key].phase, "failed");
    assert.equal(state().ui.sessionDefinitionReads[OWNER][key].error, "Session not found.");
    fail = false;
    await controller.readSessionWorkflowRevision(OWNER, "def-hn", 2);
    assert.equal(state().ui.sessionDefinitionReads[OWNER][key].phase, "ready");
    await controller.readSessionWorkflowRevision(OWNER, "def-hn", 2);
    assert.equal(calls, 2, "a revision read that succeeded is kept");
    assert.equal(await controller.readSessionWorkflowRevision(OWNER, "def-hn", 0), null);
});

test("Save sends the revision it was based on; a stale save is refused in words, a lost answer is sent again with the same operation id", async () => {
    const sent = [];
    let answer = null;
    let lists = 0;
    const { controller, state } = harness({ transport: {
        async listSessionWorkflowDefinitions() { lists += 1; return LIST; },
        async saveSessionWorkflowDefinition(sessionId, request) {
            sent.push({ sessionId, ...request });
            if (answer instanceof Error) throw answer;
            return answer;
        },
    } });
    const edit = { definitionId: "def-hn", name: "hn-top-watch", yaml: "apiVersion: pilotswarm.dev/v1\n", expectedRevision: 3 };
    answer = new Error("socket hang up");
    const lost = await controller.saveSessionWorkflowDefinition(OWNER, edit);
    assert.equal(lost.ok, false);
    assert.equal(lost.phase, "unconfirmed");
    answer = { operation: "save", definitionId: "def-hn", name: "hn-top-watch", revision: 4, valid: true, replayed: true };
    const saved = await controller.saveSessionWorkflowDefinition(OWNER, edit);
    assert.equal(saved.ok, true);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].operationId, sent[1].operationId, "the same request after no answer reuses its operation id");
    assert.deepEqual({ ...sent[1], operationId: undefined }, { sessionId: OWNER, ...edit, operationId: undefined });
    assert.equal(state().ui.statusText, "Saved hn-top-watch revision 4.");
    // A new save after one that was answered is a new operation.
    answer = Object.assign(new Error("Revision 5 was saved by the session at 2026-11-07T09:41:00.000Z. Reload to edit it. Nothing was saved."),
        { code: "REVISION_STALE", status: 409, details: { currentRevision: 5, savedBy: { kind: "session", sessionId: OWNER }, savedAt: "2026-11-07T09:41:00.000Z" } });
    const stale = await controller.saveSessionWorkflowDefinition(OWNER, edit);
    assert.notEqual(sent[2].operationId, sent[1].operationId);
    assert.equal(stale.ok, false);
    assert.equal(stale.stale, 5);
    assert.match(stale.message, /^Revision not saved: revision 5 was saved by the session at .+\. Reload to edit it\.$/);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(lists >= 1, "the list is read again after each answer");
    // A save with errors is saved and says it cannot start (E2-5).
    answer = { operation: "save", definitionId: "def-hn", name: "hn-top-watch", revision: 6, valid: false };
    await controller.saveSessionWorkflowDefinition(OWNER, { ...edit, expectedRevision: 5 });
    assert.equal(state().ui.statusText, "Saved hn-top-watch revision 6: it has errors, so it cannot start until they are fixed.");
});

test("Start and Run again name the revision or the Workflow they repeat; the new Workflow's row is read; Delete's refusal is the server's words", async () => {
    const sent = [];
    let refreshed = 0;
    const { controller, state } = harness({ transport: {
        async listSessionWorkflowDefinitions() { return LIST; },
        async startSessionWorkflowDefinition(sessionId, request) {
            sent.push({ sessionId, ...request });
            return { operation: "start", definitionId: "def-hn", name: "hn-top-watch", revision: request.revision ?? 2, workflowId: "wf-new", runId: "r", replayed: false };
        },
        async deleteSessionWorkflowDefinition(sessionId, request) {
            sent.push({ sessionId, delete: true, ...request });
            throw Object.assign(new Error("hn-top-watch has a Workflow still running. Stop it first, then delete it."),
                { code: "DEFINITION_IN_USE", status: 409, details: { workflowSessionIds: ["wf-b"] } });
        },
    } });
    controller.refreshSessions = async () => { refreshed += 1; };
    const started = await controller.startSessionWorkflowDefinition(OWNER, { definitionId: "def-hn", revision: 2, inputs: { topic: "ai" } });
    assert.equal(started.ok, true);
    assert.equal(started.receipt.workflowId, "wf-new");
    assert.equal(sent[0].revision, 2);
    assert.equal(sent[0].runAgainOf, null);
    assert.deepEqual(sent[0].inputs, { topic: "ai" });
    assert.match(sent[0].operationId, /^ui-start-/);
    assert.equal(refreshed, 1);
    assert.equal(state().ui.statusText, "Started hn-top-watch from revision 2.");
    const again = await controller.startSessionWorkflowDefinition(OWNER, { definitionId: "def-hn", runAgainOf: "wf-a", inputs: {} });
    assert.equal(again.ok, true);
    assert.equal(sent[1].runAgainOf, "wf-a");
    assert.equal(sent[1].revision, null, "Run again pins the revision of the Workflow it repeats, on the server");
    assert.notEqual(sent[1].operationId, sent[0].operationId);
    const refused = await controller.deleteSessionWorkflowDefinition(OWNER, { definitionId: "def-hn" });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "DEFINITION_IN_USE");
    assert.equal(refused.message, "hn-top-watch has a Workflow still running. Stop it first, then delete it.");
    const none = await harness().controller.deleteSessionWorkflowDefinition(OWNER, { definitionId: "def-hn" });
    assert.equal(none.ok, false);
    assert.equal(none.message, "This connection cannot change Workflow Definitions.");
});

// Stage 2.2: an agent's test of a revision, on request. The list says each revision's last test; the Definition view says it
// only after a test ran; a test bench (a service session) is never a row nor a Workflow.
test("stage 2.2: a revision's last test in words, only after one ran", () => {
    const tested = { ...HN, revisions: [rev(1), { ...rev(2), lastTest: { testId: "bench-1", verdict: "passed", at: "2026-11-07T09:42:00.000Z" } },
        { ...rev(3, { valid: false }), lastTest: { testId: "bench-2", verdict: "running", at: "2026-11-07T09:50:00.000Z" } }] };
    const [model] = sessionDefinitionsModel([tested]);
    const byRevision = new Map(model.revisions.map(item => [item.revision, item]));
    assert.deepEqual(byRevision.get(2).lastTest, { testId: "bench-1", verdict: "passed", at: "2026-11-07T09:42:00.000Z" });
    assert.equal(byRevision.get(1).lastTest, null);
    assert.equal(sessionLastTestWords(byRevision.get(2), () => "09:42"), "Last test · passed 09:42");
    assert.equal(sessionLastTestWords({ lastTest: { verdict: "failed", at: "x" } }, () => "09:43"), "Last test · failed 09:43");
    assert.equal(sessionLastTestWords(byRevision.get(3)), "Test running");
    assert.equal(sessionLastTestWords(byRevision.get(1)), null);
    assert.equal(sessionLastTestWords(null), null);
    // A verdict the screen does not know is not shown.
    assert.equal(sessionDefinitionsModel([{ ...HN, revisions: [{ ...rev(1), lastTest: { verdict: "maybe" } }] }])[0].revisions[0].lastTest, null);
});

test("stage 2.2: a test bench is never a row nor a Workflow, whichever way it arrives", () => {
    assert.equal(WORKFLOW_TEST_BENCH_KIND, "workflow-test");
    const bench = { sessionId: "bench-1", sessionKind: "workflow", parentSessionId: OWNER, title: "Workflow: hn-top-watch", serviceKind: WORKFLOW_TEST_BENCH_KIND,
        status: "running", updatedAt: 3 };
    assert.equal(isWorkflowTestBench(bench), true);
    assert.equal(isWorkflowTestBench({ ...bench, serviceKind: null }), false);
    let state = createInitialState({ mode: "api" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: OWNER, title: "chat", updatedAt: 1 }, bench] });
    assert.equal(state.sessions.byId["bench-1"], undefined);
    state = appReducer(state, { type: "sessions/merged", session: bench });
    assert.equal(state.sessions.byId["bench-1"], undefined);
    assert.equal(sessionDefinitionsStamp(state.sessions.byId, OWNER), sessionDefinitionsStamp({ [OWNER]: state.sessions.byId[OWNER] }, OWNER));
});

// Formal L1 (stage 2 review): a person's copy of a package's definition records what it was copied from, and its view says so.
test("L1: a copy's source, from the list, in words; any other definition has none", async () => {
    const { sessionDefinitionsModel: model, sessionCopiedFromWords } = await import("../src/workflow-session-definitions.js");
    const [copy, own] = model([
        { definitionId: "def-copy", name: "release-watch", currentRevision: 1, source: "copy", revisions: [{ revision: 1 }], workflows: [],
            copiedFrom: { definitionId: "def-pkg", name: "release-tools/release-watch", revision: 2,
                package: { packageId: "p", packageName: "release-tools", semver: "1.3.0", sha256: "s" } } },
        { definitionId: "def-own", name: "zz-own", currentRevision: 1, source: null, revisions: [{ revision: 1 }], workflows: [] },
    ]);
    assert.deepEqual(copy.copiedFrom, { name: "release-tools/release-watch", revision: 2, packageName: "release-tools", semver: "1.3.0" });
    assert.equal(sessionCopiedFromWords(copy), "Copied from release-tools/release-watch revision 2 (release-tools 1.3.0)");
    assert.equal(own.copiedFrom, null);
    assert.equal(sessionCopiedFromWords(own), null);
    const [bare] = model([{ definitionId: "d", name: "x", currentRevision: 1, revisions: [{ revision: 1 }], workflows: [],
        copiedFrom: { name: "tools/x", revision: 1, package: null } }]);
    assert.equal(sessionCopiedFromWords(bare), "Copied from tools/x revision 1");
});

// Stage 2 review CO-1: the Definition view's change controls follow who may change the session's definitions as the last read
// said (changeAccess), not the revision read now in progress, so they stay while another revision is read.
test("CO-1: the change controls follow the last access read; a deleted definition or a deployment without person commands has none", async () => {
    const { sessionDefinitionChangeControls: controls } = await import("../src/workflow-session-definitions.js");
    const definition = { name: "release-tools/release-watch", deleted: false };
    assert.deepEqual(controls(definition, { allowed: true, personCommands: true, reason: null }),
        { commands: true, mayChange: true, deleteEnabled: true, deleteTitle: "delete release-tools/release-watch; its finished Workflows keep their copies" });
    assert.deepEqual(controls(definition, { allowed: false, personCommands: true, reason: "Only Alice can change it." }),
        { commands: true, mayChange: false, deleteEnabled: false, deleteTitle: "Only Alice can change it." });
    assert.equal(controls(definition, { allowed: true, personCommands: false }).commands, false);
    assert.equal(controls({ ...definition, deleted: true }, { allowed: true, personCommands: true }).commands, false);
    // Nothing read yet: no controls.
    assert.deepEqual(controls(definition, null), { commands: false, mayChange: false, deleteEnabled: false,
        deleteTitle: "Only this session's owner or an admin can delete it." });
});

// Stage 2 review S2UI-F1: a save never discards text typed while it waited.
test("S2UI-F1: after a save, the text typed while it waited stays, unsaved, based on the revision saved", async () => {
    const { sessionEditorAfterSave } = await import("../src/workflow-session-definitions.js");
    assert.deepEqual(sessionEditorAfterSave({ base: 3, text: "A", dirty: true }, "A", 4), { base: 4, text: "A", dirty: false });
    assert.deepEqual(sessionEditorAfterSave({ base: 3, text: "B", dirty: true }, "A", 4), { base: 4, text: "B", dirty: true });
    assert.deepEqual(sessionEditorAfterSave(null, "A", 4), { base: 4, text: "A", dirty: false });
});

// Review S2UI-F2: the reads on screen (the revision shown and Compare's two) are never evicted, whatever else is read.
test("S2UI-F2: the revision on screen and Compare's two reads stay in the cache past the limit; others go oldest first", () => {
    let state = createInitialState({ mode: "api" });
    const read = (revision, at) => appReducer(state, { type: "ui/sessionDefinitionRead", ownerId: OWNER, key: sessionDefinitionReadKey("def-hn", revision),
        entry: { phase: "ready", value: { revision: { revision } }, error: null, at } });
    state = read(30, 1);
    state = read(29, 2);
    state = read(28, 3);
    for (const [role, revision] of [["main", 30], ["from", 28], ["to", 29]]) {
        state = appReducer(state, { type: "ui/sessionDefinitionShown", ownerId: OWNER, role, key: sessionDefinitionReadKey("def-hn", revision) });
    }
    for (let revision = 1; revision <= SESSION_DEFINITION_READS_MAX + 5; revision += 1) state = read(revision, 10 + revision);
    const keys = Object.keys(state.ui.sessionDefinitionReads[OWNER]);
    assert.equal(keys.length, SESSION_DEFINITION_READS_MAX);
    for (const shown of ["def-hn:30", "def-hn:29", "def-hn:28"]) assert.ok(keys.includes(shown), shown);
    assert.ok(keys.includes(`def-hn:${SESSION_DEFINITION_READS_MAX + 5}`));
    assert.equal(keys.includes("def-hn:1"), false);
    // No longer shown: it may go.
    state = appReducer(state, { type: "ui/sessionDefinitionShown", ownerId: OWNER, role: "from", key: null });
    for (let revision = 100; revision < 100 + SESSION_DEFINITION_READS_MAX; revision += 1) state = read(revision, 1_000 + revision);
    const after = Object.keys(state.ui.sessionDefinitionReads[OWNER]);
    assert.ok(after.includes("def-hn:30") && after.includes("def-hn:29"));
    assert.equal(after.includes("def-hn:28"), false);
    // An unchanged or invalid shown action changes nothing.
    assert.equal(appReducer(state, { type: "ui/sessionDefinitionShown", ownerId: OWNER, role: "main", key: "def-hn:30" }), state);
    assert.equal(appReducer(state, { type: "ui/sessionDefinitionShown", ownerId: OWNER, role: "elsewhere", key: "x" }), state);
});

// Review S2UI-F3: Make a copy moves to the copy as the picker would: no Workflow selected or remembered, the session selected
// when a Workflow is the session shown.
test("S2UI-F3: choosing a definition (the picker, or Make a copy's copy) clears the Workflow and selects the session when one is shown", async () => {
    const { sessionDefinitionChoice } = await import("../src/workflow-session-definitions.js");
    assert.deepEqual(sessionDefinitionChoice("def-copy", { workflowShown: true, view: "definition" }),
        { patch: { sessionDefinitionId: "def-copy", sessionRevision: null, workflowId: null, definitionPanel: null, view: "definition" }, selectOwner: true });
    assert.deepEqual(sessionDefinitionChoice("def-hn"), { patch: { sessionDefinitionId: "def-hn", sessionRevision: null, workflowId: null, definitionPanel: null },
        selectOwner: false });
    // With the choice applied, the tab shows the copy even though a Workflow was remembered for the session.
    const definitions = sessionDefinitionsModel([
        { definitionId: "def-pkg", name: "tools/x", currentRevision: 1, locked: true, revisions: [{ revision: 1 }],
            workflows: [{ workflowSessionId: "wf-1", revision: 1, runStatus: "running" }] },
        { definitionId: "def-copy", name: "x", currentRevision: 1, revisions: [{ revision: 1 }], workflows: [] },
    ]);
    const tab = { workflowId: "wf-1", sessionDefinitionId: "def-pkg", ...sessionDefinitionChoice("def-copy", { view: "definition" }).patch };
    const found = sessionDefinitionOfWorkflow(definitions, tab.workflowId);
    assert.equal(found, null, "no Workflow is remembered");
    assert.equal(definitions.find(item => item.definitionId === tab.sessionDefinitionId).name, "x");
});

// Review S2UI-F4: a session whose definitions list is empty but that has Workflow children (stage 1 Workflows 0107 did not
// import) keeps the stage 1 grouping, so they stay reachable; a session with neither gets its own (empty) tab.
test("S2UI-F4: an empty definitions list with Workflow children shows the stage 1 grouping; with none, the session's own tab", async () => {
    const { sessionWorkflowTabKind } = await import("../src/workflow-session-definitions.js");
    const child = { sessionId: "wf-old", parentSessionId: OWNER, sessionKind: "workflow" };
    assert.equal(sessionWorkflowTabKind([], { ownerId: OWNER, byId: { [OWNER]: { sessionId: OWNER }, "wf-old": child } }), "stage1");
    assert.equal(sessionWorkflowTabKind([], { ownerId: OWNER, byId: { [OWNER]: { sessionId: OWNER } } }), "definitions");
    // A test bench or a deleted child is not one.
    assert.equal(sessionWorkflowTabKind([], { ownerId: OWNER, byId: { b: { ...child, sessionId: "b", serviceKind: "workflow-test" } } }), "definitions");
    assert.equal(sessionWorkflowTabKind([], { ownerId: OWNER, byId: { d: { ...child, sessionId: "d", deletedAt: "x" } } }), "definitions");
    // As before: no list read, or a Workflow shown that no definition lists.
    assert.equal(sessionWorkflowTabKind(null, { ownerId: OWNER }), "stage1");
    const definitions = sessionDefinitionsModel(LIST);
    assert.equal(sessionWorkflowTabKind(definitions, { ownerId: OWNER, workflowId: "unlisted" }), "stage1");
    assert.equal(sessionWorkflowTabKind(definitions, { ownerId: OWNER, byId: { "wf-old": child } }), "definitions");
});

// UX2D-F8: on a phone the closed revision picker cut its author and time ("Revision 23…"): its label there puts who and
// when right after the number, and leaves the version out. c0bb4171 DEV: "3 · newest · the session · 22:18:01 · not valid" was
// still 422 px in 320 px, so "not valid" was cut: validity comes first, the clock has no seconds, and "newest" is left out.
test("UX2D-F8: a phone's revision label is the number, validity, who and when; the full label is unchanged", () => {
    const person = { revision: 23, valid: true, semver: "1.22.0", actor: { kind: "user", provider: "p", subject: "s", display: "Alice Anderson" } };
    assert.equal(sessionRevisionOptionLabel(person, { time: "08:21:05", current: true, compact: true }), "23 · Alice Anderson · 08:21");
    assert.equal(sessionRevisionOptionLabel({ revision: 3, valid: false, semver: "1.3.0", actor: { kind: "session", sessionId: OWNER } }, { time: "22:18:01", current: true, compact: true }),
        "3 · not valid · the session · 22:18");
    assert.equal(sessionRevisionOptionLabel({ revision: 4, valid: false, semver: "1.3.0", actor: { kind: "session", sessionId: OWNER } }, { time: "2026-11-06 09:41:00", compact: true }),
        "4 · not valid · the session · 11-06 09:41");
    assert.equal(sessionRevisionOptionLabel(person, { time: "08:21", current: true }), "Revision 23 · newest · by Alice Anderson · 08:21 · version 1.22.0");
});

// UX2D-F10: the Delete dialog said "Its 3 Workflows keep the revision it ran." and "A definition with a running Workflow
// cannot be deleted." even when none ran.
test("UX2D-F10: the Delete dialog's words agree in number, and say a Workflow not ended blocks it only when there is one", () => {
    const revisions = [{ revision: 2 }, { revision: 1 }];
    const done = status => ({ sessionId: `w-${status}`, runStatus: status });
    assert.deepEqual(sessionDeleteWords({ name: "ux-defs", revisions, workflows: [done("completed"), done("failed"), done("cancelled")] }), {
        what: "ux-defs and its 2 revisions leave this session's definitions: the session can no longer change or start it.",
        keep: "Each of its 3 Workflows keeps the revision it ran." });
    assert.equal(sessionDeleteWords({ name: "ux-defs", revisions: [{ revision: 1 }], workflows: [done("completed")] }).keep, "Its Workflow keeps the revision it ran.");
    assert.equal(sessionDeleteWords({ name: "ux-defs", revisions: [{ revision: 1 }], workflows: [done("completed")] }).what,
        "ux-defs and its revision leave this session's definitions: the session can no longer change or start it.");
    assert.equal(sessionDeleteWords({ name: "ux-defs", revisions, workflows: [done("completed"), done("running")] }).keep,
        "Each of its 2 Workflows keeps the revision it ran. One of them has not ended, so it cannot be deleted until it ends.");
    assert.equal(sessionDeleteWords({ name: "ux-defs", revisions, workflows: [done("paused"), done("running"), done("completed")] }).keep,
        "Each of its 3 Workflows keeps the revision it ran. 2 of them have not ended, so it cannot be deleted until they end.");
    assert.equal(sessionDeleteWords({ name: "ux-defs", revisions, workflows: [] }).keep, "It has no Workflows.");
});
