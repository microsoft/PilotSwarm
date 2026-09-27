/**
 * Session workspaces in the shared UI (docs/proposals/session-workspaces.md,
 * test B12, the unit half).
 *
 *   - the view loads with the session stats (getSessionWorkspace), and the
 *     shared selector reports root, folder, status, revision, adopted
 *     content, and which actions apply
 *   - the stats tab shows a Workspace block only for a session with one
 *   - set, clear and retry send the revision the view was read at
 *   - both hosts reach the same three commands: the TUI through W (set, or
 *     clear with an empty value) and Y (retry); the portal through its
 *     Manage dialog
 *
 * Run: node --test test/session-workspace-ui.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.js";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { PilotSwarmUiController } from "../src/controller.js";
import { UI_COMMANDS } from "../src/commands.js";
import {
    buildHelpModalRows,
    selectInspector,
    selectSessionWorkspace,
    selectSessionWorkspaceModal,
    selectStatusBar,
} from "../src/selectors.js";

const SID = "session-workspace-ui";
const HELD = {
    workspace: { schema: 1, root: "a", folder: "repo-x" },
    revision: 3,
    path: "/ws/a/repo-x",
    status: "unavailable",
    lastError: { code: "WORKSPACE_FOLDER_MISSING", message: "folder does not exist" },
    heldPrompts: 2,
    adopted: { agents: ["reviewer"], skills: ["build"], skipped: [] },
};
const READY = { ...HELD, status: "ready", lastError: null, heldPrompts: 0 };
const NONE = { workspace: null, revision: 4, path: null, status: "none", lastError: null, heldPrompts: 0, adopted: null };

async function seeded(view, transportOverrides = {}) {
    const calls = [];
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            listSessions: async () => [],
            subscribeSession: () => () => {},
            getSessionMetricSummary: async () => ({ sessionId: SID }),
            getSessionWorkspace: async (id) => { calls.push(["get", id]); return view; },
            setSessionWorkspace: async (id, input) => {
                calls.push(["set", id, input]);
                return { status: "changed", revision: input.expectedRevision + 1, workspace: input.workspace };
            },
            retrySessionWorkspace: async (id) => { calls.push(["retry", id]); return { status: "retried" }; },
            ...transportOverrides,
        },
    });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "Workspace UI", status: "idle", createdAt: 1, updatedAt: 1 }] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    await controller.ensureSessionStats({ force: true });
    return { controller, store, calls, state: () => store.getState() };
}

const lineText = (line) => (Array.isArray(line) ? line.map((run) => run?.text ?? "").join("")
    : typeof line === "string" ? line
        : line?.text ?? (Array.isArray(line?.runs) ? line.runs.map((run) => run?.text ?? "").join("") : ""));
const statsText = (state) => {
    const inspector = selectInspector({ ...state, ui: { ...state.ui, inspectorTab: "stats" } }, { width: 90 });
    return inspector.lines.map(lineText).join("\n");
};

test("the selector reports the workspace and which actions apply", async () => {
    const held = await seeded(HELD);
    const view = selectSessionWorkspace(held.state());
    assert.deepEqual(held.calls[0], ["get", SID], "the view loads with the session stats");
    assert.equal(view.label, "a/repo-x");
    assert.deepEqual([view.root, view.folder, view.status, view.revision, view.path], ["a", "repo-x", "unavailable", 3, "/ws/a/repo-x"]);
    assert.equal(view.lastError.code, "WORKSPACE_FOLDER_MISSING");
    assert.equal(view.heldPrompts, 2);
    assert.deepEqual([view.adoptedAgents, view.adoptedSkills], [["reviewer"], ["build"]]);
    assert.deepEqual(view.actions, { set: true, clear: true, retry: true });

    assert.deepEqual(selectSessionWorkspace((await seeded(READY)).state()).actions, { set: true, clear: true, retry: false });
    const none = selectSessionWorkspace((await seeded(NONE)).state());
    assert.deepEqual([none.label, none.status, none.actions], ["", "none", { set: true, clear: false, retry: false }]);

    const unsupported = await seeded(HELD, { getSessionWorkspace: undefined });
    assert.equal(selectSessionWorkspace(unsupported.state()), null, "no view without the operation");
});

test("the stats tab shows a Workspace block only for a session with one", async () => {
    const text = statsText((await seeded(HELD)).state());
    assert.match(text, /\nWorkspace\nFolder\s+a\/repo-x\n/);
    assert.match(text, /Status\s+unavailable\n/);
    assert.match(text, /Held\s+2 prompts\n/);
    assert.match(text, /Code\s+WORKSPACE_FOLDER_MISSING\n/);
    assert.match(text, /Revision\s+3/);
    assert.match(text, /Agents\s+reviewer/);
    assert.match(text, /Skills\s+build/);
    assert.match(text, /W set or clear · Y retry now/);
    assert.doesNotMatch(statsText((await seeded(READY)).state()), /Y retry now/, "no retry hint when nothing is held");
    assert.doesNotMatch(statsText((await seeded(NONE)).state()), /Workspace/, "nothing for a session without one");
});

test("set, clear and retry send the revision the view was read at", async () => {
    const h = await seeded(HELD);
    await h.controller.handleCommand(UI_COMMANDS.OPEN_SET_WORKSPACE);
    assert.equal(h.state().ui.modal.type, "sessionWorkspace");
    assert.equal(h.state().ui.modal.value, "a/repo-x", "prefilled with the current workspace");
    assert.equal(selectSessionWorkspaceModal(h.state()).confirmLabel, "Set");
    h.controller.setSetWorkspaceValue("a/repo-y");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.deepEqual(h.calls.find((c) => c[0] === "set"), ["set", SID, { expectedRevision: 3, workspace: { root: "a", folder: "repo-y" } }]);
    assert.equal(h.state().ui.modal, null);
    assert.ok(h.calls.filter((c) => c[0] === "get").length >= 2, "the view reloads after the change");

    await h.controller.handleCommand(UI_COMMANDS.OPEN_SET_WORKSPACE);
    h.controller.setSetWorkspaceValue("b");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.deepEqual(h.calls.filter((c) => c[0] === "set").at(-1)[2].workspace, { root: "b" }, "a root alone has no folder");

    // An empty value clears, behind a confirm.
    await h.controller.handleCommand(UI_COMMANDS.OPEN_SET_WORKSPACE);
    h.controller.setSetWorkspaceValue("   ");
    assert.equal(selectSessionWorkspaceModal(h.state()).confirmLabel, "Clear");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(h.state().ui.modal?.type, "confirm");
    assert.equal(h.state().ui.modal.action, "clearSessionWorkspace");
    const setsBefore = h.calls.filter((c) => c[0] === "set").length;
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const clear = h.calls.filter((c) => c[0] === "set");
    assert.equal(clear.length, setsBefore + 1);
    assert.deepEqual(clear.at(-1), ["set", SID, { expectedRevision: 3, workspace: null }]);

    await h.controller.handleCommand(UI_COMMANDS.RETRY_WORKSPACE);
    assert.deepEqual(h.calls.filter((c) => c[0] === "retry"), [["retry", SID]]);
});

test("retry and clear refuse when they do not apply; no support means no dialog", async () => {
    const ready = await seeded(READY);
    await ready.controller.handleCommand(UI_COMMANDS.RETRY_WORKSPACE);
    assert.equal(ready.calls.filter((c) => c[0] === "retry").length, 0);
    assert.match(ready.state().ui.statusText ?? JSON.stringify(ready.state().ui), /not held/);

    const none = await seeded(NONE);
    await none.controller.handleCommand(UI_COMMANDS.CLEAR_WORKSPACE);
    assert.equal(none.calls.filter((c) => c[0] === "set").length, 0);
    assert.equal(none.state().ui.modal, null);

    const unsupported = await seeded(HELD, { setSessionWorkspace: undefined });
    await unsupported.controller.handleCommand(UI_COMMANDS.OPEN_SET_WORKSPACE);
    assert.equal(unsupported.state().ui.modal, null);
});

test("the dialog has a footer hint, and the help lists the keys", async () => {
    const h = await seeded(HELD);
    await h.controller.handleCommand(UI_COMMANDS.OPEN_SET_WORKSPACE);
    assert.match(selectStatusBar(h.state()).right, /empty clears/);
    const help = buildHelpModalRows().map(lineText).join("\n");
    assert.match(help, /W \/ Y\s+workspace — set or clear \/ retry now/);
});

test("both hosts reach the same three commands", () => {
    const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const tui = read("../../../tui/src/app.js");
    const web = read("../../react/src/web-app.js");
    // TUI: W opens the dialog (set, or clear with an empty value); Y retries.
    assert.match(tui, /if \(plainShortcut && isShiftW\) \{\s*controller\.handleCommand\(UI_COMMANDS\.OPEN_SET_WORKSPACE\)/);
    assert.match(tui, /if \(plainShortcut && isShiftY\) \{\s*controller\.handleCommand\(UI_COMMANDS\.RETRY_WORKSPACE\)/);
    assert.match(tui, /modal\.type === "sessionWorkspace"\) \{/, "the TUI edits the dialog like the other text dialogs");
    // Portal: the Manage dialog's Workspace row, gated by the selector's actions.
    assert.ok(web.includes("controller.handleCommand(UI_COMMANDS.OPEN_SET_WORKSPACE)"));
    assert.match(web, /workspace\?\.actions\.clear \? React\.createElement\("button", \{[\s\S]{0,200}UI_COMMANDS\.CLEAR_WORKSPACE/);
    assert.match(web, /workspace\?\.actions\.retry \? React\.createElement\("button", \{[\s\S]{0,200}UI_COMMANDS\.RETRY_WORKSPACE/);
});

// ── Extra folders (section 4.10) ─────────────────────────────────

const WITH_EXTRAS = {
    ...READY,
    workspace: { schema: 1, root: "a", folder: "repo-x", extra: { logs: { root: "logs", folder: "svc", required: false }, shared: { root: "shared" } } },
    extraPaths: { logs: "/ws/logs/svc", gone: "/ws/old" },
};

test("the selector reports extra folders with their paths when known; the stats tab lists them", async () => {
    const h = await seeded(WITH_EXTRAS);
    const view = selectSessionWorkspace(h.state());
    assert.deepEqual(view.extras, [
        { name: "logs", label: "logs/svc", required: false, path: "/ws/logs/svc" },
        { name: "shared", label: "shared", required: true, path: null },
    ]);
    const text = statsText(h.state());
    assert.match(text, /Extra\s+logs: logs\/svc \(optional\)\n/);
    assert.match(text, /Extra\s+shared: shared\n/);
    assert.deepEqual(selectSessionWorkspace((await seeded(READY)).state()).extras, [], "none without extra folders");
});

test("setting the working folder from the dialog keeps the extra folders; the dialog says so", async () => {
    const h = await seeded(WITH_EXTRAS);
    await h.controller.handleCommand(UI_COMMANDS.OPEN_SET_WORKSPACE);
    const modal = selectSessionWorkspaceModal(h.state());
    const details = modal.detailsLines.map(lineText).join("\n");
    assert.match(details, /Extra folders: logs, shared \(kept\)/);
    h.controller.setSetWorkspaceValue("a/repo-y");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.deepEqual(h.calls.find((c) => c[0] === "set")[2].workspace, {
        root: "a", folder: "repo-y", extra: WITH_EXTRAS.workspace.extra,
    }, "the whole-record set carries the extra folders, so none is dropped");

    await h.controller.handleCommand(UI_COMMANDS.OPEN_SET_WORKSPACE);
    h.controller.setSetWorkspaceValue("");
    assert.match(selectSessionWorkspaceModal(h.state()).detailsLines.map(lineText).join("\n"), /Extra folders: logs, shared \(cleared too\)/);
    // The Clear confirm says the extra folders go too.
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(h.state().ui.modal?.type, "confirm");
    assert.match(h.state().ui.modal.message, /its extra folders too/);
});
