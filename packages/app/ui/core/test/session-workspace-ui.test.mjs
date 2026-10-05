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
 *   - default folders (section 4.11), which are not in the record: the
 *     person's own folder when the session has none, and default extra
 *     folders, in the stats tab and in the portal's Workspace row
 *   - issue #103: the clear hint says it asks first, and a cancelled
 *     confirm says so; the Set dialog lists the roots for the owner; the
 *     Workspace tab opens from Manage session while the side pane is hidden
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
    describeSessionWorkspace,
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

// ── Default folders (section 4.11) ───────────────────────────────

const HOME_DEFAULTS = {
    ...NONE,
    defaults: { workingFolder: { root: "home", folder: "users/ada_example.com" }, extra: [{ name: "shared", root: "shared" }] },
};
const REPO_DEFAULTS = {
    ...READY,
    defaults: { workingFolder: null, extra: [{ name: "home", root: "home", folder: "users/ada_example.com", home: true }, { name: "shared", root: "shared" }] },
};

test("default folders: the person's folder when the session has none, and the default extra folders", async () => {
    const none = selectSessionWorkspace((await seeded(HOME_DEFAULTS)).state());
    assert.equal(none.status, "none", "the record is still empty");
    assert.deepEqual(none.defaults, {
        workingFolder: { label: "home/users/ada_example.com" },
        extras: [{ name: "shared", label: "shared", home: false }],
    });
    const text = statsText((await seeded(HOME_DEFAULTS)).state());
    assert.match(text, /\nWorkspace\nFolder\s+home\/users\/ada_example\.com \(your folder\)\n/);
    assert.match(text, /Extra\s+shared: shared \(default\)\n/);
    assert.doesNotMatch(text, /Status|Revision/, "no status rows: nothing is set");

    const repoText = statsText((await seeded(REPO_DEFAULTS)).state());
    assert.match(repoText, /Folder\s+a\/repo-x\n/);
    assert.match(repoText, /Extra\s+home: home\/users\/ada_example\.com \(default\)\n[\s\S]*Extra\s+shared: shared \(default\)/);
    assert.equal(selectSessionWorkspace((await seeded(NONE)).state()).defaults, null, "none reported: none shown");
    assert.doesNotMatch(statsText((await seeded(NONE)).state()), /Workspace/);
    assert.equal(selectSessionWorkspace((await seeded({ ...NONE, defaults: { workingFolder: null, extra: [{ name: 7 }] } })).state()).defaults, null,
        "a malformed entry is dropped");
});

test("the portal's Workspace row names the person's folder and the default extra folders", async () => {
    assert.deepEqual(describeSessionWorkspace(selectSessionWorkspace((await seeded(HOME_DEFAULTS)).state())), {
        current: "home/users/ada_example.com (your folder)",
        defaults: "Default extra folders: shared (shared)",
    });
    assert.deepEqual(describeSessionWorkspace(selectSessionWorkspace((await seeded(REPO_DEFAULTS)).state())), {
        current: "a/repo-x",
        defaults: "Default extra folders: home (home/users/ada_example.com), shared (shared)",
    });
    assert.deepEqual(describeSessionWorkspace(selectSessionWorkspace((await seeded(HELD)).state())),
        { current: "a/repo-x · unavailable (WORKSPACE_FOLDER_MISSING)", defaults: null });
    assert.deepEqual(describeSessionWorkspace(selectSessionWorkspace((await seeded(NONE)).state())), { current: "none", defaults: null });
    assert.deepEqual(describeSessionWorkspace(null), { current: "none", defaults: null });
});

// ── Small gaps from an end-to-end test (issue #103) ──────────────

test("the clear hint says it asks first, and cancelling the confirm says the workspace was not cleared", async () => {
    const h = await seeded(HELD);
    await h.controller.handleCommand(UI_COMMANDS.OPEN_SET_WORKSPACE);
    h.controller.setSetWorkspaceValue("");
    const hint = selectSessionWorkspaceModal(h.state()).helpLines.map(lineText).join("\n");
    assert.match(hint, /Enter clear \(asks first\)/);
    assert.match(selectStatusBar(h.state()).right, /empty clears \(asks first\)/);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(h.state().ui.modal?.action, "clearSessionWorkspace");
    // A click outside the confirm, Escape or Cancel: all close the modal.
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.equal(h.state().ui.modal, null);
    assert.equal(h.state().ui.statusText, "Workspace not cleared (cancelled)");
    assert.equal(h.calls.filter((c) => c[0] === "set").length, 0, "nothing was cleared");

    // Closing any other modal still says Connected.
    await h.controller.handleCommand(UI_COMMANDS.OPEN_SET_WORKSPACE);
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.equal(h.state().ui.statusText, "Connected");
});

test("the Set dialog lists the roots when the folder list answers; none when it fails", async () => {
    const listed = [];
    const owner = await seeded(READY, {
        listSessionWorkspaceFolders: async (id) => { listed.push(id); return { enabled: true, maxBytes: 1, folders: [], roots: ["a", "shared"] }; },
    });
    await owner.controller.handleCommand(UI_COMMANDS.OPEN_SET_WORKSPACE);
    assert.deepEqual(listed, [SID]);
    const help = selectSessionWorkspaceModal(owner.state()).helpLines.map(lineText).join("\n");
    assert.match(help, /\nRoots: a, shared\n/);
    assert.equal(owner.state().ui.modal.value, "a/repo-x", "the value is kept");

    // Not the owner: the call is refused, and the dialog lists none.
    const viewer = await seeded(READY, {
        listSessionWorkspaceFolders: async () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); },
    });
    await viewer.controller.handleCommand(UI_COMMANDS.OPEN_SET_WORKSPACE);
    assert.equal(viewer.state().ui.modal?.type, "sessionWorkspace", "the dialog still opens");
    assert.doesNotMatch(selectSessionWorkspaceModal(viewer.state()).helpLines.map(lineText).join("\n"), /Roots:/);

    // No folder list at all (the TUI without workspace files): none.
    const plain = await seeded(READY);
    await plain.controller.handleCommand(UI_COMMANDS.OPEN_SET_WORKSPACE);
    assert.doesNotMatch(selectSessionWorkspaceModal(plain.state()).helpLines.map(lineText).join("\n"), /Roots:/);
});

test("the Workspace tab can be opened from Manage session while the side pane is hidden", async () => {
    const h = await seeded(READY);
    assert.notEqual(h.state().ui.canvasOpen, true, "the pane starts hidden");
    await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKSPACE_FILES);
    assert.equal(h.state().ui.canvasOpen, true, "the side pane shows");
    assert.equal(h.state().ui.sidePaneTab, "workspace", "on its Workspace tab");
    const web = readFileSync(fileURLToPath(new URL("../../react/src/web-app.js", import.meta.url)), "utf8");
    assert.match(web, /portalWorkspaceFiles \? React\.createElement\("button", \{[\s\S]{0,300}UI_COMMANDS\.OPEN_WORKSPACE_FILES/,
        "the Manage dialog's Workspace row has the Files button");
});
