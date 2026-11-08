/**
 * Workflow Simplified stage 2.3 (spec "Packages and Agent Smith": P1, P2, P5, P6, E2-7, D7, D8): the portal and terminal
 * on a package's Workflow Definitions.
 * - The new-session picker lists the packages' Workflow Definitions after the agents, under headings, only while
 *   Workflows are on; search finds them; their card is the details; choosing one makes a chat for it on the chosen model.
 * - A chat made for one wears the Workflow badge in the session list.
 * - A locked definition: the tab's words ("From <package> <version> · locked", a newer version), the picker's label, and
 *   the controller's Make a copy and newer version, each one operation sent once.
 * The browser spec (workflow-tab.spec.mjs, "stage 2.3") drives the screens.
 *
 * Run: node --test ui/core/test/workflow-package-picker.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmUiController, appReducer, createInitialState, createStore, selectSessionAgentPickerModal, selectSessionRows } from "../src/index.js";
import { buildAgentPickerItems, workflowPickerItems } from "../src/controller.js";
import { workflowPickerDetailsLines } from "../src/selectors.js";
import { WORKFLOW_SESSION_GLYPH } from "../src/workflow-sessions.js";
import { chatDefinitionOptionLabel, chatDefinitionsModel, chatPackageDefinitionWords } from "../src/workflow-chat-definitions.js";

const WATCH = {
    ref: "release-tools/release-watch", name: "release-watch", package: "release-tools", packageTitle: "Release Tools", semver: "1.2.0", scope: "shared",
    mine: false, description: "Watches a release train and reports blockers.", whenToUse: "A release train is rolling out.", model: "azure-openai:gpt-5.6-terra",
    inputs: [{ name: "train", required: true }, { name: "intervalMinutes", required: false }],
    outcomes: { clear: "No blocker.", blocked: "A blocker.", failed: "Could not check." }, asks: { approve_note: "Whether to post the note." },
    effects: "No scripts; one request.",
};
const DIGEST = { ref: "ops-kit/incident-digest", name: "incident-digest", package: "ops-kit", semver: "0.4.1", scope: "shared", mine: false,
    description: "Collects the day's incidents.", inputs: [], outcomes: { done: "Written." }, asks: {}, effects: "None.", model: null };

function makeController({ workflowsEnabled = true, workflows = [WATCH, DIGEST], agents = [{ name: "alpha", title: "Alpha" }], overrides = {} } = {}) {
    const calls = { listCreatableWorkflows: 0, createWorkflowChat: [], copy: [], update: [], list: 0 };
    const transport = {
        listSessions: async () => [],
        getSession: async () => null,
        subscribeSession: () => () => {},
        createSession: async () => ({ sessionId: "generic-1", status: "idle" }),
        listCreatableAgents: async () => agents,
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        listCreatableWorkflows: async () => { calls.listCreatableWorkflows += 1; return workflows; },
        createWorkflowChat: async (ref, options) => {
            calls.createWorkflowChat.push([ref, options]);
            return { sessionId: "chat-wf-1", model: options.model ?? "default-model", workflowRef: ref, title: "release-watch · release-tools" };
        },
        copyChatWorkflowDefinition: async (ownerId, request) => { calls.copy.push([ownerId, request]); return { name: "release-watch", revision: 1, definitionId: "def-copy" }; },
        updateChatWorkflowPackage: async (ownerId, request) => { calls.update.push([ownerId, request]); return { name: "release-tools/release-watch", revision: 2, package: { semver: "1.3.0" } }; },
        listChatWorkflowDefinitions: async () => { calls.list += 1; return []; },
        ...overrides,
    };
    const store = createStore(appReducer, createInitialState({ workflowsEnabled }));
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, store, calls };
}

test("P1: with Workflows on the picker lists the packages' definitions after the agents, under headings; off, it never asks", async () => {
    const { controller, store, calls } = makeController();
    await controller.openSessionAgentPicker();
    const modal = store.getState().ui.modal;
    assert.equal(calls.listCreatableWorkflows, 1);
    assert.deepEqual(modal.items.map(item => [item.kind, item.id]),
        [["generic", "__generic__"], ["agent", "alpha"], ["workflow", "workflow:ops-kit/incident-digest"], ["workflow", "workflow:release-tools/release-watch"]]);
    assert.equal(modal.title, "Select an agent or a Workflow for the new session");
    const view = selectSessionAgentPickerModal(store.getState());
    // Two headings that no key lands on (-1), the rows still map 1:1 to the items.
    assert.deepEqual(view.rowItemIndexes, [-1, 0, 1, -1, 2, 3]);
    assert.deepEqual([view.rows[0][0].text, view.rows[3][0].text], ["AGENTS", "WORKFLOWS"]);
    const watchRow = view.rows[5].map(run => run.text).join("");
    assert.ok(watchRow.includes(`${WORKFLOW_SESSION_GLYPH} release-watch`) && watchRow.includes("Release Tools 1.2.0"), watchRow);

    const off = makeController({ workflowsEnabled: false });
    await off.controller.openSessionAgentPicker();
    assert.equal(off.calls.listCreatableWorkflows, 0);
    assert.ok(!off.store.getState().ui.modal.items.some(item => item.kind === "workflow"));
    assert.ok(!selectSessionAgentPickerModal(off.store.getState()).rowItemIndexes.includes(-1), "no headings without Workflows");
    // A list that cannot be read leaves the agents as they are.
    const failing = makeController({ overrides: { listCreatableWorkflows: async () => { throw new Error("down"); } } });
    await failing.controller.openSessionAgentPicker();
    assert.deepEqual(failing.store.getState().ui.modal.items.map(item => item.kind), ["generic", "agent"]);
});

test("search finds a Workflow by its words or package; with no agents the Workflows still open the picker", async () => {
    const { controller, store } = makeController();
    await controller.openSessionAgentPicker();
    controller.setAgentPickerQuery("release train");
    assert.deepEqual(store.getState().ui.modal.items.map(item => item.id), ["workflow:release-tools/release-watch"]);
    controller.setAgentPickerQuery("ops-kit");
    assert.deepEqual(store.getState().ui.modal.items.map(item => item.id), ["workflow:ops-kit/incident-digest"]);
    controller.setAgentPickerQuery("");
    controller.setAgentPickerSort("package");
    assert.deepEqual(store.getState().ui.modal.items.filter(item => item.kind === "workflow").map(item => item.packageName), ["ops-kit", "release-tools"]);

    const none = makeController({ agents: [], overrides: { getSessionCreationPolicy: () => ({ creation: { allowGeneric: false } }) } });
    await none.controller.openSessionAgentPicker();
    assert.equal(none.store.getState().ui.modal?.type, "sessionAgentPicker");
    assert.deepEqual(none.store.getState().ui.modal.items.map(item => item.kind), ["workflow", "workflow"]);
});

test("the details are the Workflow's card; the model is the chosen one, else your default, with the card's suggestion shown", () => {
    const [item] = workflowPickerItems([WATCH]);
    const words = lines => lines.map(line => line.map(run => run.text).join("")).join("\n");
    const shown = words(workflowPickerDetailsLines(item));
    for (const want of ["release-watch", "Workflow Definition · release-tools 1.2.0", "Watches a release train", "When to use it: A release train is rolling out.",
        "Inputs: train · optional: intervalMinutes", "Ends: clear · blocked · failed", "Asks you: Whether to post the note.",
        "Author's stated effects: No scripts; one request.",
        "Model: your default · its card suggests azure-openai:gpt-5.6-terra", "Creates a chat that runs this Workflow"]) {
        assert.ok(shown.includes(want), `${want}\n${shown}`);
    }
    assert.ok(words(workflowPickerDetailsLines(item, "azure-openai:gpt-5.6-terra")).includes("Model: azure-openai:gpt-5.6-terra\n"));
    // A row without a <package>/<name> reference is not a Workflow row.
    assert.deepEqual(workflowPickerItems([{ name: "x" }, { ref: "noslash" }, null]), []);
    // buildAgentPickerItems keeps them last and never counts them as agents.
    const items = buildAgentPickerItems([{ id: "a", kind: "agent", agentName: "a", builtin: true }], { workflowItems: workflowPickerItems([WATCH]), usage: { "release-watch": 9 } });
    assert.deepEqual(items.map(entry => [entry.kind, entry.usageCount]), [["agent", 0], ["workflow", 0]]);
});

// Stage 2 review S2SF-F4: the details say what the definition itself shows of its effects, before the card's own words.
test("S2SF-F4: the details give the checked facts, then the card's effects as its author's words", () => {
    const checked = "Checked from the definition: it runs scripts (step poll). A script runs code on a worker: it can reach the network, and use the "
        + "tools of the chat that starts it, which can read and write files and run processes. It has no agent steps.";
    const [item] = workflowPickerItems([{ ...WATCH, effects: "No network.", checked: { scripts: ["poll"], agents: [], words: checked } }]);
    assert.equal(item.checked, checked);
    const lines = workflowPickerDetailsLines(item).map(line => line.map(run => run.text).join(""));
    const at = lines.indexOf(checked);
    assert.ok(at > 0, lines.join("\n"));
    assert.equal(lines[at + 1], "Author's stated effects: No network.");
    // Packages lens (1024 px): the checked facts are safety words, right under the name and the package line, before the
    // description, so a short dialog never hides them below its fold.
    assert.equal(at, 2, lines.join("\n"));
    assert.ok(lines.findIndex(line => line.startsWith("Watches a release train")) > at + 1, lines.join("\n"));
    // A server that gives no checked facts: the card's words only, still labeled.
    const [older] = workflowPickerItems([WATCH]);
    assert.equal(older.checked, null);
    assert.ok(!workflowPickerDetailsLines(older).some(line => line.map(run => run.text).join("").startsWith("Checked from")));
});

test("P2, D8: choosing a Workflow makes a chat for it on the chosen model, and opens it", async () => {
    const { controller, store, calls } = makeController();
    await controller.openSessionAgentPicker({ model: "azure-openai:gpt-5.6-terra", reasoningEffort: "medium", workspace: { root: "x" } });
    const index = store.getState().ui.modal.items.findIndex(item => item.id === "workflow:release-tools/release-watch");
    store.dispatch({ type: "ui/modalSelection", index });
    await controller.confirmModal();
    assert.deepEqual(calls.createWorkflowChat, [["release-tools/release-watch", { model: "azure-openai:gpt-5.6-terra", reasoningEffort: "medium" }]]);
    assert.equal(store.getState().ui.modal, null);
    assert.equal(store.getState().sessions.activeSessionId, "chat-wf-1");
    // No model chosen: none is sent (the deployment's default), whatever the card suggests.
    const plain = makeController();
    await plain.controller.openSessionAgentPicker();
    plain.store.dispatch({ type: "ui/modalSelection", index: plain.store.getState().ui.modal.items.findIndex(item => item.kind === "workflow") });
    await plain.controller.confirmModal();
    assert.deepEqual(plain.calls.createWorkflowChat.map(([, options]) => options), [{}]);
    // A refusal is a status, never a throw.
    const refused = makeController({ overrides: { createWorkflowChat: async () => { throw Object.assign(new Error("No package you can use has it."), { code: "PACKAGE_WORKFLOW_NOT_FOUND" }); } } });
    assert.equal(await refused.controller.createWorkflowChat("x/y"), null);
    assert.match(refused.store.getState().ui.statusText, /No package you can use has it/);
});

test("P2: a chat made for a package's Workflow wears the Workflow badge in the session list", () => {
    const { store } = makeController();
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "chat-wf-1", title: "release-watch · release-tools", status: "idle", workflowRef: "release-tools/release-watch" },
        { sessionId: "chat-2", title: "Plain", status: "idle" },
    ] });
    const rows = selectSessionRows(store.getState());
    const kindRun = row => (row.titleRuns || row.runs || []).find(run => run?.role === "sessionKind");
    assert.deepEqual(kindRun(rows.find(row => row.sessionId === "chat-wf-1")), { text: `${WORKFLOW_SESSION_GLYPH} `, color: "cyan", bold: true, role: "sessionKind",
        workflowRef: "release-tools/release-watch" });
    assert.equal(kindRun(rows.find(row => row.sessionId === "chat-2")), undefined);
});

// Review S2UI-F9: with Workflows off (and before the bootstrap says on: the client starts off), a coordinating chat is an
// ordinary chat row: no Workflow badge, no tooltip.
test("S2UI-F9: Workflows off, or before the bootstrap, the coordinating chat's row has no Workflow badge", () => {
    // Off, and the client's first state before any bootstrap (createInitialState starts with Workflows off).
    for (const store of [makeController({ workflowsEnabled: false }).store, createStore(appReducer, createInitialState())]) {
        const workflowsEnabled = store.getState().ui.workflowsEnabled;
        store.dispatch({ type: "sessions/loaded", sessions: [
            { sessionId: "chat-wf-1", title: "release-watch · release-tools", status: "idle", workflowRef: "release-tools/release-watch" },
        ] });
        const [row] = selectSessionRows(store.getState());
        const runs = row.titleRuns || row.runs || [];
        assert.equal(runs.find(run => run?.role === "sessionKind"), undefined, String(workflowsEnabled));
        assert.equal(runs.some(run => run?.workflowRef), false);
        assert.equal(row.sessionId, "chat-wf-1", "the chat row itself stays");
    }
});

const LOCKED = {
    definitionId: "def-pkg", ownerSessionId: "chat-wf-1", name: "release-tools/release-watch", currentRevision: 2, source: "package", locked: true,
    packageName: "release-tools", createdAt: "2026-11-07T09:00:00.000Z", updatedAt: "2026-11-07T09:05:00.000Z", deletedAt: null, newestValidRevision: 2,
    packageUpdate: { semver: "1.3.0", sha256: "x" },
    revisions: [1, 2].map(revision => ({ definitionId: "def-pkg", revision, valid: true, semver: revision === 1 ? "1.2.0" : "1.2.1", yamlSha256: `y${revision}`,
        irSha256: `i${revision}`, basedOn: revision - 1 || null, actor: { kind: "chat", sessionId: "chat-wf-1" }, imported: false,
        createdAt: `2026-11-07T09:0${revision}:00.000Z`, errorCount: 0,
        package: { packageId: "p", packageName: "release-tools", semver: revision === 1 ? "1.2.0" : "1.2.1", sha256: `s${revision}`, cardDigest: `c${revision}` } })),
    workflows: [],
};

test("E2-7, P5, P6: a locked definition says where it comes from, at the revision shown, and offers a newer version", () => {
    const [model] = chatDefinitionsModel([LOCKED]);
    assert.equal(model.locked, true);
    assert.equal(model.packageName, "release-tools");
    assert.deepEqual(model.packageUpdate, { semver: "1.3.0" });
    assert.deepEqual(model.revisions.map(item => item.package?.semver), ["1.2.1", "1.2.0"]);
    assert.equal(chatDefinitionOptionLabel(model), "release-tools/release-watch · locked");
    assert.deepEqual(chatPackageDefinitionWords(model, 1), { line: "From release-tools 1.2.0 · locked", semver: "1.2.0", update: "Version 1.3.0 is available" });
    assert.deepEqual(chatPackageDefinitionWords(model, 2), { line: "From release-tools 1.2.1 · locked", semver: "1.2.1", update: "Version 1.3.0 is available" });
    const [own] = chatDefinitionsModel([{ ...LOCKED, locked: false, packageName: null, packageUpdate: null, name: "release-watch",
        revisions: LOCKED.revisions.map(item => ({ ...item, package: null })) }]);
    assert.equal(chatPackageDefinitionWords(own, 1), null);
    assert.equal(own.revisions[0].package, null);
    assert.equal(chatDefinitionOptionLabel(own), "release-watch");
});

test("Make a copy and a newer version: one operation each, the list read again, a status in words", async () => {
    const { controller, store, calls } = makeController();
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "chat-wf-1", title: "release-watch · release-tools", status: "idle",
        workflowRef: "release-tools/release-watch" }] });
    const copied = await controller.copyChatWorkflowDefinition("chat-wf-1", { definitionId: "def-pkg", revision: 2 });
    assert.equal(copied.ok, true);
    assert.equal(calls.copy.length, 1);
    assert.deepEqual({ ...calls.copy[0][1], operationId: undefined }, { definitionId: "def-pkg", revision: 2, operationId: undefined });
    assert.match(calls.copy[0][1].operationId, /^ui-copy-/);
    assert.match(store.getState().ui.statusText, /Made release-watch, an editable copy at revision 1/);
    const updated = await controller.updateChatWorkflowPackage("chat-wf-1", { definitionId: "def-pkg" });
    assert.equal(updated.ok, true);
    assert.match(calls.update[0][1].operationId, /^ui-update-/);
    assert.match(store.getState().ui.statusText, /The next Workflow of release-tools\/release-watch starts version 1\.3\.0\./);
    assert.ok(calls.list >= 2, "the list is read again after each");
    // A connection without them says so.
    const old = makeController({ overrides: { copyChatWorkflowDefinition: undefined, updateChatWorkflowPackage: undefined } });
    assert.deepEqual(await old.controller.copyChatWorkflowDefinition("chat-wf-1", { definitionId: "def-pkg" }),
        { ok: false, phase: "failed", code: null, stale: null, message: "This connection cannot change Workflow Definitions." });
});

test("stage 2.4 (PR 235): a running Workflow session offers no Stop: it has no turn", async () => {
    const { canStopSessionTurn } = await import("../src/selectors.js");
    assert.equal(canStopSessionTurn({ sessionId: "wf", status: "running", sessionKind: "workflow" }), false);
    assert.equal(canStopSessionTurn({ sessionId: "chat", status: "running" }), true);
    assert.equal(canStopSessionTurn({ sessionId: "chat", status: "idle" }), false);
});

test("stage 2.4: a clock wait is labelled and described by its time", async () => {
    const { workflowV2NodeLabel, workflowV2ClockWaitShort } = await import("../src/workflow-v2-view.js");
    const { workflowNodeWhat } = await import("../src/workflow-node-summary.js");
    const node = { id: "hold", type: "wait", seconds: null, at: { minute: 0, hour: 9, tz: "America/Los_Angeles" },
        until: "the next 09:00 (America/Los_Angeles)", outcomes: ["elapsed"], next: { elapsed: "done" } };
    assert.equal(workflowV2NodeLabel(node), "Wait · until 09:00");
    assert.equal(workflowNodeWhat({ ...node, kind: "wait" }), "Waits until the next 09:00 (America/Los_Angeles).");
    assert.equal(workflowV2ClockWaitShort({ minute: 30, tz: "UTC" }), "until :30");
    assert.equal(workflowV2ClockWaitShort({ minute: 5, hour: 6, dayOfWeek: 1, tz: "UTC" }), "until Mon 06:05");
    assert.equal(workflowV2ClockWaitShort({ minute: 0, hour: 0, dayOfMonth: 1, tz: "UTC" }), "until day 1 00:00");
    assert.equal(workflowV2NodeLabel({ ...node, at: undefined, until: undefined, seconds: 90 }), "Wait · 1 min 30 s");
});

test("stage 2.4 (FU-25): a script's tool call window is in the Log in words", async () => {
    const { workflowEventText } = await import("../src/workflow-v2-view.js");
    const base = { runId: "r", nodeExecutionId: "nx", stateId: "poll", step: 1, call: 2, tool: "read_build" };
    assert.equal(workflowEventText("workflow.tool_call_started", { ...base, startedAt: "2026-11-07T09:00:00.000Z" }).text, "poll · tool 2 read_build started");
    assert.equal(workflowEventText("workflow.tool_call_ended", { ...base, ok: true, durationMs: 340 }).text, "poll · tool 2 read_build done · 340 ms");
    assert.equal(workflowEventText("workflow.tool_call_ended", { ...base, ok: true, durationMs: 2500 }).text, "poll · tool 2 read_build done · 3 s");
    const failed = workflowEventText("workflow.tool_call_ended", { ...base, ok: false, durationMs: null, error: "denied" });
    assert.deepEqual(failed, { text: "poll · tool 2 read_build failed: denied", level: "warning" });
});
