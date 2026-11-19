/**
 * An immutable Workflow workspace: one Start-time selection for every
 * script and agent node, with no later parent/default-folder drift.
 *
 * Run: npm run build && node --test test/unit/workflow-workspace.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    applySessionWorkspaceSelection, applyWorkspaceDefaults, readWorkflowWorkspace, workflowWorkspaceDefaults, workflowWorkspaceSnapshot,
} from "../../dist/workspace.js";
import { workflowCreateRequestSha256 } from "../../dist/workflow/service.js";
import { resolveWorkflowStartWorkspace } from "../../dist/workflow/definition-tool.js";
import { pinWorkflowWorkspaceConfig } from "../../dist/session-manager.js";
import { workingFolderOf } from "../../dist/workspace-check.js";

const BASE = { schema: 1, root: "repos", folder: "project", extra: { logs: { root: "logs", folder: "build", required: false } } };
const DEFAULTS = {
    workingFolder: null,
    extra: [
        { name: "home", root: "home", folder: "users/alice", home: true, required: false },
        { name: "shared", root: "shared", required: true },
    ],
};

test("a Workflow snapshot keeps the explicit record and the folders/default semantics of the Start turn", () => {
    const snapshot = workflowWorkspaceSnapshot(BASE, DEFAULTS);
    assert.deepEqual(snapshot, { workspace: BASE, defaults: DEFAULTS });
    assert.notEqual(snapshot.workspace, BASE);
    assert.notEqual(snapshot.defaults, DEFAULTS);
    const effective = applyWorkspaceDefaults(snapshot.workspace, workflowWorkspaceDefaults(snapshot.defaults));
    assert.deepEqual(effective.workspace, {
        ...BASE,
        extra: {
            ...BASE.extra,
            home: { root: "home", folder: "users/alice", required: false },
            shared: { root: "shared", required: true },
        },
    });
});

test("an inherited workspace-less Start preserves the raw parent working directory; explicit null clears it", () => {
    const inherited = pinWorkflowWorkspaceConfig({ workspaceAttach: { path: "/parent/home" }, workingDirectory: "/parent/home" },
        { workspace: null, defaults: null, workingDirectory: "/parent/home" });
    assert.equal(inherited.workingDirectory, "/parent/home");
    assert.equal(inherited.workspaceAttach, undefined);

    const explicit = pinWorkflowWorkspaceConfig({ workspaceAttach: { path: "/parent/home" }, workingDirectory: "/parent/home" },
        { workspace: null, defaults: null });
    assert.equal(explicit.workspace, undefined);
    assert.equal(explicit.workspaceAttach, undefined);
    assert.equal(explicit.workingDirectory, undefined);
    assert.equal(explicit.workspaceDefaults, null);
});

test("an explicit null selection clears a parent's derived working directory and attach", () => {
    const pinned = pinWorkflowWorkspaceConfig({ workspaceAttach: { path: "/parent/home" }, workingDirectory: "/parent/home" },
        { workspace: null, defaults: null });
    assert.equal(pinned.workspace, undefined);
    assert.equal(pinned.workspaceAttach, undefined);
    assert.equal(pinned.workingDirectory, undefined);
    assert.equal(pinned.workspaceDefaults, null);
});

test("a workspace-less parent pins its raw working directory for inherited scripts", () => {
    const snapshot = workflowWorkspaceSnapshot(null, null, "/ws/legacy-session");
    assert.deepEqual(snapshot, { workspace: null, defaults: null, workingDirectory: "/ws/legacy-session" });
    assert.deepEqual(readWorkflowWorkspace({ workflowWorkspace: snapshot }), snapshot);
    assert.equal(pinWorkflowWorkspaceConfig({ workingDirectory: "/ws/legacy-session" }, snapshot).workingDirectory, "/ws/legacy-session");
});

test("working-folder validation does not count deployment-default extras", () => {
    const fourExtras = Object.fromEntries(["a", "b", "c", "d"].map(name => [name, { root: name, required: false }]));
    const merged = applyWorkspaceDefaults({ schema: 1, root: "repo", extra: fourExtras }, {
        home: { name: "home", root: "home", required: false }, extra: { shared: { root: "shared", required: true } },
    }).workspace;
    assert.deepEqual(workingFolderOf(merged), { schema: 1, root: "repo" });
    assert.equal(Object.keys(merged.extra).length, 6);
});

test("a default home working folder is pinned even when the parent has no explicit workspace record", () => {
    const defaults = { workingFolder: { root: "home", folder: "users/alice", required: false }, extra: [] };
    const snapshot = workflowWorkspaceSnapshot(null, defaults);
    assert.deepEqual(applyWorkspaceDefaults(snapshot.workspace, workflowWorkspaceDefaults(snapshot.defaults)).workspace, {
        schema: 1, root: "home", folder: "users/alice",
    });
    assert.deepEqual(readWorkflowWorkspace({ workflowWorkspace: snapshot }), snapshot);
});

test("Workflow Start accepts omitted, object, null and none with distinct default-folder semantics", async () => {
    const moved = { schema: 1, root: "repos", folder: "draft" };
    const capture = async () => ({ workspace: BASE, defaults: DEFAULTS });
    assert.deepEqual(await resolveWorkflowStartWorkspace({}, { workspace: capture }), {
        workspace: BASE, workspaceDefaults: DEFAULTS, workspaceInherited: true,
    });
    assert.deepEqual(await resolveWorkflowStartWorkspace({ workspace: moved }, { workspace: capture, workspaceInherited: true }), {
        workspace: moved, workspaceDefaults: DEFAULTS, workspaceInherited: true,
    });
    assert.deepEqual(await resolveWorkflowStartWorkspace({ workspace: moved }, { workspace: capture }), {
        workspace: moved, workspaceDefaults: DEFAULTS, workspaceInherited: false,
    });
    assert.deepEqual(await resolveWorkflowStartWorkspace({ workspace: null }, { workspace: capture }), {
        workspace: null, workspaceDefaults: DEFAULTS, workspaceInherited: false,
    });
    assert.deepEqual(await resolveWorkflowStartWorkspace({ workspace: "none" }, { workspace: capture }), {
        workspace: null, workspaceDefaults: null, workspaceInherited: false,
    });
});

test("optional and required default-folder semantics survive the snapshot round trip", () => {
    const applied = applyWorkspaceDefaults(BASE, {
        home: { name: "home", root: "home" }, extra: { shared: { root: "shared", required: true } },
    });
    const record = {
        workingFolder: null,
        extra: applied.defaultNames.map(name => ({
            name,
            root: applied.workspace.extra[name].root,
            ...(applied.workspace.extra[name].folder ? { folder: applied.workspace.extra[name].folder } : {}),
            ...(applied.homeExtra === name ? { home: true } : {}),
            required: applied.workspace.extra[name].required === true,
        })),
    };
    const restored = workflowWorkspaceDefaults(record);
    assert.equal(restored.home.required, false);
    assert.equal(restored.extra.shared.required, true);
});

test("spawn workspace selection preserves defaults for null and inherits none for omitted descendants", () => {
    const source = { workspace: BASE, workspaceDefaults: DEFAULTS, workingDirectory: "/raw-parent" };
    assert.deepEqual(applySessionWorkspaceSelection(source, undefined), source);
    assert.deepEqual(applySessionWorkspaceSelection(source, null), {});
    assert.deepEqual(applySessionWorkspaceSelection(source, null, true), { workspaceDefaults: DEFAULTS });
    const noneParent = applySessionWorkspaceSelection(source, "none");
    assert.deepEqual(noneParent, { workspaceDefaults: null });
    assert.deepEqual(applySessionWorkspaceSelection(noneParent, undefined), noneParent);
    assert.deepEqual(applySessionWorkspaceSelection(noneParent, null), {});
});

test("an explicit no-default snapshot cannot pick up new deployment defaults later", () => {
    const snapshot = workflowWorkspaceSnapshot(null, null);
    assert.equal(applyWorkspaceDefaults(snapshot.workspace, workflowWorkspaceDefaults(snapshot.defaults)).workspace, null);
    assert.deepEqual(readWorkflowWorkspace({ workflowWorkspace: snapshot }), snapshot);
    assert.equal(readWorkflowWorkspace({}), null);
});

test("the durable creation digest changes when either the Start workspace or its defaults change", () => {
    const request = {
        workflowSessionId: "W", parentSessionId: "P", yaml: "yaml", actor: { kind: "system", name: "test" }, operationId: "start:o",
        publish: true, start: { inputs: {} }, workspace: workflowWorkspaceSnapshot(BASE, DEFAULTS),
    };
    const digest = workflowCreateRequestSha256(request, "yaml-hash", true, {});
    assert.notEqual(digest, workflowCreateRequestSha256({ ...request, workspace: workflowWorkspaceSnapshot(
        { ...BASE, folder: "other" }, DEFAULTS,
    ) }, "yaml-hash", true, {}));
    assert.notEqual(digest, workflowCreateRequestSha256({ ...request, workspace: workflowWorkspaceSnapshot(BASE, {
        ...DEFAULTS, extra: [{ ...DEFAULTS.extra[0], folder: "users/bob" }, DEFAULTS.extra[1]],
    }) }, "yaml-hash", true, {}));
});
