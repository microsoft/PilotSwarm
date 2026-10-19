/**
 * TUI parity for Admin → Canvas Apps and the collapsible Packages / Canvas
 * Apps tree (issue 181 R23, R24): the keys, the read-only detail, the
 * windowed tree, and the per-viewer collapsed state in the config file.
 *
 * Run: node --test tui/test/admin-canvas-apps.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appReducer, createInitialState, createStore, selectAdminConsole, PilotSwarmUiController } from "pilotswarm/ui-core";
import { buildAdminConsoleLines } from "../../ui/react/src/components.js";
import { adminCollapsedConfigPatch, adminTreeViewerKey, readAdminCollapsedForViewer } from "../src/admin-tree-config.js";

const source = readFileSync(fileURLToPath(new URL("../src/app.js", import.meta.url)), "utf8");
const ALICE = { provider: "test", subject: "alice", email: "alice@test", displayName: "Alice", isAdmin: true };
const BOB = { provider: "test", subject: "bob" };

const text = (lines) => lines.map((line) => line.map((run) => run.text).join("")).join("\n");

function app(name, scope, subject, extra = {}) {
    return {
        appId: `${scope}-${subject}-${name}`, name, scope, owner: { provider: "test", subject },
        ownerEmail: `${subject}@test`, ownerDisplayName: subject[0].toUpperCase() + subject.slice(1),
        description: `Use when testing ${name}.`, tags: ["t"], enabled: true, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
        activeVersionId: `v-${name}`, version: "1.0.0", card: {
            interface: { keys: [{ key: "app/x", writer: "page" }], requests: [{ op: "go", result: "ok" }], events: [] },
            responseContract: { actions: { vote: { item: "string" } } },
            workspace: { read: ["*.md"], write: [], watch: false, commands: {} },
        },
        canEdit: true, canManage: subject === "alice", shadowed: false, ...extra,
    };
}

function store() {
    const s = createStore(appReducer, createInitialState());
    s.dispatch({ type: "admin/visibility", visible: true });
    s.dispatch({ type: "admin/profile/loaded", profile: { ...ALICE, githubCopilotKeySet: false, profileSettings: {} } });
    return s;
}

test("the TUI keys drive the shared tree: j/k, Enter/Space, ←/→ and c", () => {
    assert.match(source, /"packages", "canvasApps", "workers"\]\.includes\(adminState\?\.section\)/);
    assert.match(source, /input === "c" && adminSection !== "canvasApps"[\s\S]*ADMIN_SHOW_CANVAS_APPS/);
    assert.match(source, /adminSection === "packages" \|\| adminSection === "canvasApps"/);
    assert.match(source, /input === "j" \|\| key\.downArrow\)\) \{\s*controller\.handleCommand\(UI_COMMANDS\.ADMIN_TREE_NEXT\)/);
    assert.match(source, /input === "k" \|\| key\.upArrow\)\) \{\s*controller\.handleCommand\(UI_COMMANDS\.ADMIN_TREE_PREV\)/);
    assert.match(source, /key\.return \|\| \(plainShortcut && input === " "\)\) \{\s*controller\.handleCommand\(UI_COMMANDS\.ADMIN_TREE_TOGGLE\)/);
    assert.match(source, /key\.leftArrow\) \{\s*controller\.handleCommand\(UI_COMMANDS\.ADMIN_TREE_COLLAPSE\)/);
    assert.match(source, /key\.rightArrow\) \{\s*controller\.handleCommand\(UI_COMMANDS\.ADMIN_TREE_EXPAND\)/);
});

test("the Canvas Apps detail renders read-only with the interface card and workspace warning", async () => {
    const s = store();
    const transport = {
        listCanvasApps: async () => [app("board", "shared", "alice")],
        getCanvasApp: async () => ({ ...app("board", "shared", "alice"), versions: [{ versionId: "v-board", version: "1.0.0", sha256: "a".repeat(64), sizeBytes: 100, card: app("board", "shared", "alice").card, createdAt: "2026-10-01T00:00:00Z" }] }),
        listCanvasAppEditors: async () => [],
        getCanvasAppLoads: async () => ({ rows: [], total30d: 7, nextCursor: null }),
    };
    const controller = new PilotSwarmUiController({ store: s, transport });
    await controller.refreshAdminCanvasApps();
    await controller.selectAdminCanvasApp({ name: "board", scope: "shared" });
    const out = text(buildAdminConsoleLines(selectAdminConsole(s.getState()), { treeRows: 30 }));
    assert.match(out, /▾ Canvas Apps/);
    assert.match(out, /▾ Shared \(1\)/);
    assert.match(out, /\[S\] board {2}1\.0\.0/);
    assert.match(out, /board {2}1\.0\.0 {2}Shared/);
    assert.match(out, /action {2}vote {2}item: string/);
    assert.match(out, /key {5}app\/x/);
    assert.match(out, /request go {2}→ ok/);
    assert.match(out, /! This app asks for access to the session's workspace folders/);
    assert.match(out, /7 in the last 30 days/);
    // Read-only: the actions are portal-only, and the TUI says so.
    assert.match(out, /Preview, share, enable, download, export and delete are in the portal\./);
    assert.match(out, /Enter\/Space open\/close/);
});

test("a collapsed group shows its count and its rows go away", async () => {
    const s = store();
    const controller = new PilotSwarmUiController({ store: s, transport: { listCanvasApps: async () => [app("board", "shared", "alice"), app("poll", "shared", "bob")] } });
    await controller.refreshAdminCanvasApps();
    controller.setAdminSection("canvasApps");
    controller.toggleAdminTreeNode("capps:shared");
    const out = text(buildAdminConsoleLines(selectAdminConsole(s.getState()), { treeRows: 30 }));
    assert.match(out, /▸ Shared \(2\)/);
    assert.doesNotMatch(out, /\] board/);
});

test("a long tree scrolls and keeps the cursor row in view", async () => {
    const s = store();
    const many = Array.from({ length: 40 }, (_, i) => app(`app-${String(i).padStart(2, "0")}`, "user", "alice"));
    const controller = new PilotSwarmUiController({ store: s, transport: { listCanvasApps: async () => many, getCanvasApp: async () => ({ ...many[39], versions: [] }), getCanvasAppLoads: async () => ({ rows: [], total30d: 0 }) } });
    await controller.refreshAdminCanvasApps();
    await controller.selectAdminCanvasApp({ name: "app-39", scope: "user", ownerProvider: "test", ownerSubject: "alice" });
    const lines = buildAdminConsoleLines(selectAdminConsole(s.getState()), { treeRows: 12 });
    const out = text(lines);
    assert.match(out, /↑ \d+ more/);
    assert.match(out, /› \[P\] app-39/);
    assert.doesNotMatch(out, /\] app-00/);
});

test("the TUI config keeps one collapsed list per viewer: Alice's change does not change Bob's", () => {
    let config = {};
    config = { ...config, ...adminCollapsedConfigPatch(config, BOB, ["capps:others"]) };
    config = { ...config, ...adminCollapsedConfigPatch(config, ALICE, ["agents", "capps:shared"]) };
    assert.deepEqual(readAdminCollapsedForViewer(config, ALICE), ["agents", "capps:shared"]);
    assert.deepEqual(readAdminCollapsedForViewer(config, BOB), ["capps:others"]);
    config = { ...config, ...adminCollapsedConfigPatch(config, ALICE, []) };
    assert.deepEqual(readAdminCollapsedForViewer(config, BOB), ["capps:others"]);
    assert.deepEqual(readAdminCollapsedForViewer(config, ALICE), []);
    assert.equal(adminTreeViewerKey(null), "local");
    assert.equal(adminTreeViewerKey(BOB), "test:bob");
    assert.deepEqual(readAdminCollapsedForViewer({ adminCollapsed: ["not", "a", "map"] }, ALICE), []);
});
