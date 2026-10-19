/**
 * Admin Console → Canvas Apps and the collapsible Packages / Canvas Apps tree
 * (issue 181 R23, R24, R25, R29).
 *
 * Both hosts render selectAdminConsole and send the same controller intents,
 * so these tests are the parity floor for the portal and the TUI.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    selectAdminConsole,
    selectCanvasPublishDialog,
    canvasAppInterfaceCard,
    windowAdminTreeRows,
    normalizeStoredAdminCollapsed,
} from "../src/index.js";

const ALICE = { provider: "test", subject: "alice", email: "alice@test", displayName: "Alice", isAdmin: true };
const BOB = { provider: "test", subject: "bob", email: "bob@test", displayName: "Bob", isAdmin: false };

const CARD = {
    interface: {
        keys: [{ key: "app/item/<id>", writer: "page", shape: { title: "string" }, note: "one row per item" }],
        requests: [{ op: "summarize", args: { ids: ["id"] }, result: { text: "string" } }],
        events: [{ key: "evt/<n>", note: "status lines" }],
    },
    responseContract: { actions: { vote: { item: "string", weight: "number?" } } },
    workspace: { read: ["**/*.md"], write: ["notes/*.md"], watch: false, commands: { status: {} } },
};

function app(name, scope, owner, extra = {}) {
    return {
        appId: `id-${scope}-${owner?.subject ?? "x"}-${name}`,
        name, scope, owner,
        ownerEmail: owner ? `${owner.subject}@test` : null,
        ownerDisplayName: owner ? owner.subject[0].toUpperCase() + owner.subject.slice(1) : null,
        description: `Use when testing ${name}.`,
        tags: ["test"], enabled: true, createdBy: null,
        createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
        activeVersionId: `v-${name}`, version: "1.0.0", sha256: "a".repeat(64), sizeBytes: 2048,
        card: CARD, canEdit: true, canManage: owner?.subject === "alice", shadowed: false,
        ...extra,
    };
}

const LIST = [
    app("board", "shared", { provider: "test", subject: "alice" }),
    app("poll", "shared", { provider: "test", subject: "bob" }, { canManage: false, canEdit: false }),
    app("notes", "user", { provider: "test", subject: "alice" }),
    app("draft", "user", { provider: "test", subject: "bob" }),
];

function makeController(principal = ALICE, overrides = {}) {
    const calls = [];
    const record = (op, result) => async (args) => { calls.push({ op, args }); return typeof result === "function" ? result(args) : result; };
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getCurrentUserProfile: async () => ({ ...principal, githubCopilotKeySet: false, profileSettings: {} }),
        listCreatableAgents: async () => [],
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        listAgentPackages: async () => [],
        listCanvasApps: record("listCanvasApps", LIST),
        getCanvasApp: record("getCanvasApp", (args) => {
            const found = LIST.find((a) => a.name === args.name && a.scope === args.scope);
            return { ...found, versions: [
                { versionId: `v-${args.name}`, version: "1.0.0", sha256: "a".repeat(64), sizeBytes: 2048, card: CARD, createdBy: "test:alice", createdAt: "2026-10-01T00:00:00Z" },
                { versionId: `v0-${args.name}`, version: "0.9.0", sha256: "b".repeat(64), sizeBytes: 1024, card: {}, createdBy: "test:alice", createdAt: "2026-09-01T00:00:00Z" },
            ] };
        }),
        listCanvasAppEditors: record("listCanvasAppEditors", [{ provider: "test", subject: "dev", email: "dev@test", displayName: "Dev", grantedAt: "2026-10-01T00:00:00Z" }]),
        getCanvasAppLoads: record("getCanvasAppLoads", { rows: [{ loadId: "l1", appName: "board", version: "1.0.0", sessionId: "s1", user: { provider: "test", subject: "bob" }, userEmail: "bob@test", userDisplayName: "Bob", loadedAt: "2026-10-03T10:00:00Z" }], total30d: 1234, nextCursor: null }),
        getCanvasAppHtml: record("getCanvasAppHtml", { name: "board", version: "1.0.0", sha256: "a".repeat(64), html: "<p>board</p>" }),
        setCanvasAppScope: record("setCanvasAppScope", { ok: true }),
        setCanvasAppEnabled: record("setCanvasAppEnabled", { ok: true }),
        pinCanvasAppVersion: record("pinCanvasAppVersion", { ok: true }),
        deleteCanvasApp: record("deleteCanvasApp", { deleted: true }),
        exportCanvasApp: record("exportCanvasApp", { filename: "board.canvas-app.tar.gz", sha256: "c".repeat(64), contentBase64: "AAAA" }),
        uploadCanvasApp: record("uploadCanvasApp", { status: "published", version: "1.0.0", scope: "user" }),
        importCanvasApp: record("importCanvasApp", { name: "board", scope: "user", versions: [{ version: "1.0.0", status: "imported" }] }),
        publishCanvasApp: record("publishCanvasApp", (args) => (args.checkOnly
            ? { checkOnly: true, ok: true, code: null, error: null, sizeBytes: 900, manifest: { name: "Board", version: "2.0.0", description: "Use when a team signs off.", tags: ["review", "team"] }, workspace: false }
            : { status: "published", version: "2.0.0", scope: args.scope })),
        saveCanvasAppDownload: record("saveCanvasAppDownload", {}),
        ...overrides,
    };
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "admin/visibility", visible: true });
    store.dispatch({ type: "admin/profile/loaded", profile: { ...principal, githubCopilotKeySet: false, profileSettings: {} } });
    return { controller, store, calls };
}

const tree = (store) => selectAdminConsole(store.getState()).settingsTree;
const ids = (store) => tree(store).map((row) => row.id);

test("Canvas Apps sits next to Packages with Shared, Private and Other users groups", async () => {
    const { controller, store } = makeController();
    await controller.refreshAdminCanvasApps();
    const rows = tree(store);
    const sections = rows.filter((r) => r.kind === "section").map((r) => r.label);
    assert.equal(sections.indexOf("Canvas Apps"), sections.indexOf("Packages") + 1);
    const groups = rows.filter((r) => r.parentId === "canvasApps");
    assert.deepEqual(groups.map((g) => [g.label, g.count]), [["Shared", 2], ["Private", 1], ["Other users", 1]]);
    assert.deepEqual(rows.filter((r) => r.parentId === "capps:shared").map((r) => r.label), ["board", "poll"]);
    assert.deepEqual(rows.filter((r) => r.parentId === "capps:mine").map((r) => r.label), ["notes"]);
    assert.deepEqual(rows.filter((r) => r.parentId === "capps:others").map((r) => [r.label, r.ownerLabel]), [["draft", "Bob"]]);
    assert.equal(rows.find((r) => r.id === "canvasApps").count, 4);
});

test("a non-admin sees no Other users group", async () => {
    const { controller, store } = makeController(BOB, { listCanvasApps: async () => LIST.filter((a) => a.scope === "shared" || a.owner.subject === "bob") });
    await controller.refreshAdminCanvasApps();
    const groups = tree(store).filter((r) => r.parentId === "canvasApps").map((r) => r.label);
    assert.deepEqual(groups, ["Shared", "Private"]);
});

test("collapse hides children, keeps the count, and Enter/Left/Right follow the rules", async () => {
    const { controller, store } = makeController();
    await controller.refreshAdminCanvasApps();
    controller.setAdminSection("canvasApps");
    // Enter on a group toggles it.
    await controller.activateAdminTreeNode("capps:shared");
    let rows = tree(store);
    const shared = rows.find((r) => r.id === "capps:shared");
    assert.equal(shared.collapsed, true);
    assert.equal(shared.count, 2);
    assert.equal(rows.some((r) => r.parentId === "capps:shared"), false);
    // Right expands, Left collapses.
    controller.expandAdminTreeNode("capps:shared");
    assert.equal(tree(store).find((r) => r.id === "capps:shared").collapsed, false);
    controller.collapseAdminTreeNode("capps:shared");
    assert.equal(tree(store).find((r) => r.id === "capps:shared").collapsed, true);
    // Left on a closed group moves the cursor to its section.
    controller.collapseAdminTreeNode("capps:shared");
    assert.equal(selectAdminConsole(store.getState()).treeCursor, "canvasApps");
    // Collapsing the section hides the groups but the section keeps its count.
    await controller.activateAdminTreeNode("canvasApps");
    rows = tree(store);
    assert.equal(rows.some((r) => r.parentId === "canvasApps"), false);
    assert.equal(rows.find((r) => r.id === "canvasApps").count, 4);
    assert.deepEqual(store.getState().admin.tree.collapsed, ["capps:shared", "canvasApps"]);
});

test("Packages groups collapse with the same rules", () => {
    const { controller, store } = makeController();
    store.dispatch({ type: "admin/packages/loaded", list: [
        { name: "kit", scope: "shared", enabled: true, owner: null, active: { semver: "1.0.0" } },
        { name: "mine", scope: "user", enabled: true, owner: { provider: "test", subject: "alice" }, active: { semver: "0.1.0" } },
    ] });
    controller.toggleAdminTreeNode("group:shared");
    const rows = tree(store);
    assert.equal(rows.find((r) => r.id === "group:shared").collapsed, true);
    assert.equal(rows.find((r) => r.id === "group:shared").count, 1);
    assert.equal(rows.some((r) => r.id === "pkg:shared:kit"), false);
    assert.equal(rows.find((r) => r.id === "agents").count, 2);
    // Model Providers never collapses.
    assert.equal(controller.toggleAdminTreeNode("providers"), false);
});

test("j/k move over visible Packages and Canvas Apps rows and select items", async () => {
    const { controller, store } = makeController();
    await controller.refreshAdminCanvasApps();
    controller.setAdminSection("canvasApps");
    controller.setAdminTreeCursor("canvasApps");
    await controller.moveAdminTreeCursor(1);
    assert.equal(selectAdminConsole(store.getState()).treeCursor, "capps:shared");
    await controller.moveAdminTreeCursor(1);
    const view = selectAdminConsole(store.getState());
    assert.equal(view.treeCursor, "capp:shared::board");
    assert.equal(view.canvasApps.detail.name, "board");
    // Hidden rows are skipped.
    controller.toggleAdminTreeNode("capps:mine");
    controller.setAdminTreeCursor("capps:mine");
    await controller.moveAdminTreeCursor(1);
    assert.equal(selectAdminConsole(store.getState()).treeCursor, "capps:others");
    // Providers rows are not navigable by the tree keys.
    assert.equal(tree(store).find((r) => r.id === "providers").navigable, false);
});

test("selecting an app in a collapsed group opens its group and section", async () => {
    const { controller, store } = makeController();
    await controller.refreshAdminCanvasApps();
    controller.setAdminTreeCollapsed(["canvasApps", "capps:mine", "group:shared"]);
    await controller.selectAdminCanvasApp({ name: "notes", scope: "user", ownerProvider: "test", ownerSubject: "alice" });
    assert.deepEqual(store.getState().admin.tree.collapsed, ["group:shared"]);
    const view = selectAdminConsole(store.getState());
    assert.equal(view.treeCursor, "capp:user:alice:notes");
    assert.equal(tree(store).find((r) => r.id === "capp:user:alice:notes").selected, true);
});

test("the detail page: header, description, interface card with workspace warning, versions, contributors, loads", async () => {
    const { controller, store, calls } = makeController();
    await controller.refreshAdminCanvasApps();
    await controller.selectAdminCanvasApp({ name: "board", scope: "shared" });
    const d = selectAdminConsole(store.getState()).canvasApps.detail;
    assert.equal(d.name, "board");
    assert.equal(d.scopeLabel, "Shared");
    assert.equal(d.ownerLabel, "Alice");
    assert.equal(d.version, "1.0.0");
    assert.equal(d.enabled, true);
    assert.deepEqual(d.tags, ["test"]);
    assert.equal(d.description, "Use when testing board.");
    assert.deepEqual(d.interfaceCard.actions, [{ name: "vote", fields: [{ name: "item", type: "string", optional: false }, { name: "weight", type: "number", optional: true }] }]);
    assert.equal(d.interfaceCard.keys[0].key, "app/item/<id>");
    assert.equal(d.interfaceCard.requests[0].op, "summarize");
    assert.match(d.interfaceCard.requests[0].result, /text/);
    assert.equal(d.interfaceCard.events[0].key, "evt/<n>");
    assert.match(d.interfaceCard.workspaceWarning, /workspace folders.*change files.*status/);
    assert.deepEqual(d.versions.map((v) => [v.version, v.active]), [["1.0.0", true], ["0.9.0", false]]);
    assert.deepEqual(d.contributors.map((c) => [c.role, c.label]), [["owner", "Alice"], ["contributor", "Dev"]]);
    assert.equal(d.loads.visible, true);
    assert.equal(d.loads.total30d, 1234);
    assert.equal(d.loads.total30dText, "1,234 in the last 30 days");
    assert.equal(d.loads.rows[0].userLabel, "Bob");
    // The copy is named exactly on every read.
    assert.deepEqual(calls.find((c) => c.op === "getCanvasApp").args, { name: "board", scope: "shared" });
    assert.deepEqual(calls.find((c) => c.op === "getCanvasAppLoads").args, { name: "board", scope: "shared", limit: 20 });
});

test("loads refused to a non-owner are hidden, not shown as an error", async () => {
    const forbidden = Object.assign(new Error("only the owner"), { code: "FORBIDDEN", status: 403 });
    const { controller, store } = makeController(BOB, { getCanvasAppLoads: async () => { throw forbidden; } });
    await controller.refreshAdminCanvasApps();
    await controller.selectAdminCanvasApp({ name: "board", scope: "shared" });
    const loads = selectAdminConsole(store.getState()).canvasApps.detail.loads;
    assert.equal(loads.visible, false);
    assert.equal(loads.error, null);
});

test("a private copy is targeted with its owner", async () => {
    const { controller, calls } = makeController();
    await controller.refreshAdminCanvasApps();
    await controller.selectAdminCanvasApp({ name: "draft", scope: "user", ownerProvider: "test", ownerSubject: "bob" });
    assert.deepEqual(calls.find((c) => c.op === "getCanvasApp").args, { name: "draft", scope: "user", ownerProvider: "test", ownerSubject: "bob" });
    assert.equal(calls.some((c) => c.op === "listCanvasAppEditors"), false);
});

test("actions: share, enable, pin, preview, download, export, delete", async () => {
    const { controller, store, calls } = makeController();
    await controller.refreshAdminCanvasApps();
    await controller.selectAdminCanvasApp({ name: "notes", scope: "user", ownerProvider: "test", ownerSubject: "alice" });
    await controller.runAdminCanvasAppAction("disable");
    assert.deepEqual(calls.filter((c) => c.op === "setCanvasAppEnabled").at(-1).args, { name: "notes", scope: "user", ownerProvider: "test", ownerSubject: "alice", enabled: false });
    await controller.runAdminCanvasAppAction("pin", "0.9.0");
    assert.equal(calls.filter((c) => c.op === "pinCanvasAppVersion").at(-1).args.version, "0.9.0");
    assert.equal(selectAdminConsole(store.getState()).canvasApps.detail.notice, "Version 0.9.0 is now active.");
    await controller.previewAdminCanvasApp();
    assert.equal(selectAdminConsole(store.getState()).canvasApps.detail.preview.html, "<p>board</p>");
    await controller.runAdminCanvasAppAction("download");
    assert.deepEqual(calls.filter((c) => c.op === "saveCanvasAppDownload").length, 1);
    await controller.runAdminCanvasAppAction("export");
    assert.equal(calls.some((c) => c.op === "exportCanvasApp"), true);
    await controller.runAdminCanvasAppAction("share");
    assert.deepEqual(calls.filter((c) => c.op === "setCanvasAppScope").at(-1).args, { name: "notes", scope: "user", ownerProvider: "test", ownerSubject: "alice", targetScope: "shared" });
    assert.deepEqual(store.getState().admin.canvasApps.selected, { name: "notes", scope: "shared", ownerProvider: null, ownerSubject: null });
    await controller.runAdminCanvasAppAction("delete");
    assert.equal(store.getState().admin.canvasApps.selected, null);
    assert.match(store.getState().admin.canvasApps.action.notice, /Deleted notes/);
});

test("a failed action is shown and leaves the selection", async () => {
    const { controller, store } = makeController(ALICE, { setCanvasAppEnabled: async () => { throw new Error("FORBIDDEN: no"); } });
    await controller.refreshAdminCanvasApps();
    await controller.selectAdminCanvasApp({ name: "board", scope: "shared" });
    await controller.runAdminCanvasAppAction("disable");
    const d = selectAdminConsole(store.getState()).canvasApps.detail;
    assert.equal(d.actionError, "FORBIDDEN: no");
    assert.equal(d.name, "board");
});

test("Add canvas app uploads .html or imports .tar.gz", async () => {
    const { controller, store, calls } = makeController();
    controller.openAdminAddCanvasApp("html");
    controller.setAdminAddCanvasAppField("content", "<html>x</html>");
    controller.setAdminAddCanvasAppField("name", "Fresh");
    controller.setAdminAddCanvasAppField("tags", "a, b");
    controller.setAdminAddCanvasAppField("scope", "shared");
    assert.equal(selectAdminConsole(store.getState()).canvasApps.addDialog.canSubmit, true);
    await controller.submitAdminAddCanvasApp();
    assert.deepEqual(calls.find((c) => c.op === "uploadCanvasApp").args, { html: "<html>x</html>", name: "fresh", scope: "shared", tags: ["a", "b"] });
    assert.equal(store.getState().admin.canvasApps.addDialog.open, false);

    controller.openAdminAddCanvasApp("archive");
    controller.setAdminAddCanvasAppField("content", "QUJD");
    await controller.submitAdminAddCanvasApp();
    assert.deepEqual(calls.find((c) => c.op === "importCanvasApp").args, { contentBase64: "QUJD", scope: "user" });
});

test("an import with failed versions keeps the dialog open with the reason", async () => {
    const { controller, store } = makeController(ALICE, {
        importCanvasApp: async () => ({ name: "board", versions: [{ version: "1.0.0", status: "imported" }, { version: "2.0.0", status: "failed", code: "BAD_REQUEST" }] }),
    });
    controller.openAdminAddCanvasApp("archive");
    controller.setAdminAddCanvasAppField("content", "QUJD");
    await controller.submitAdminAddCanvasApp();
    const dialog = selectAdminConsole(store.getState()).canvasApps.addDialog;
    assert.equal(dialog.open, true);
    assert.match(dialog.error, /1 version failed to import: 2\.0\.0 \(BAD_REQUEST\)/);
});

test("Publish as app: the check prefills the dialog and writes nothing; publish sends the fields", async () => {
    const { controller, store, calls } = makeController();
    await controller.openCanvasPublishDialog("s-1", 2);
    // The only call so far is the check.
    assert.deepEqual(calls.map((c) => c.op), ["publishCanvasApp"]);
    assert.deepEqual(calls[0].args, { sessionId: "s-1", slot: 2, checkOnly: true });
    let dialog = selectCanvasPublishDialog(store.getState());
    assert.equal(dialog.check.ok, true);
    assert.match(dialog.check.text, /Manifest check passed/);
    assert.equal(dialog.name, "board");
    assert.equal(dialog.version, "2.0.0");
    assert.equal(dialog.tags, "review, team");
    assert.equal(dialog.canSubmit, true);
    controller.setCanvasPublishField("scope", "shared");
    await controller.submitCanvasPublish();
    assert.deepEqual(calls[1].args, { sessionId: "s-1", slot: 2, name: "board", scope: "shared", description: "Use when a team signs off.", tags: ["review", "team"], version: "2.0.0" });
    dialog = selectCanvasPublishDialog(store.getState());
    assert.match(dialog.result.text, /Published board@2\.0\.0 \(shared\)/);
});

test("Publish as app: a failed check blocks publishing and shows why", async () => {
    const { controller, store } = makeController(ALICE, {
        publishCanvasApp: async () => ({ checkOnly: true, ok: false, code: "BAD_REQUEST", error: "the manifest has no `interface` block.", sizeBytes: 10, manifest: null, workspace: false }),
    });
    await controller.openCanvasPublishDialog("s-1", 1);
    const dialog = selectCanvasPublishDialog(store.getState());
    assert.equal(dialog.check.ok, false);
    assert.match(dialog.check.text, /Manifest check failed: the manifest has no `interface` block/);
    controller.setCanvasPublishField("name", "board");
    assert.equal(selectCanvasPublishDialog(store.getState()).canSubmit, false);
});

test("collapsed state is per viewer: Alice's change does not change Bob's", () => {
    // Each viewer's portal profile (and TUI config entry) is their own; the
    // state each store applies is the one its viewer saved.
    const profiles = new Map([["alice", { adminCollapsed: [] }], ["bob", { adminCollapsed: ["capps:others"] }]]);
    const alice = makeController(ALICE);
    const bob = makeController(BOB);
    alice.store.dispatch({ type: "profileSettings/apply", settings: profiles.get("alice") });
    bob.store.dispatch({ type: "profileSettings/apply", settings: profiles.get("bob") });
    alice.controller.toggleAdminTreeNode("capps:shared");
    profiles.set("alice", { adminCollapsed: alice.store.getState().admin.tree.collapsed });
    bob.store.dispatch({ type: "profileSettings/apply", settings: profiles.get("bob") });
    assert.deepEqual(alice.store.getState().admin.tree.collapsed, ["capps:shared"]);
    assert.deepEqual(bob.store.getState().admin.tree.collapsed, ["capps:others"]);
    assert.deepEqual(profiles.get("bob").adminCollapsed, ["capps:others"]);
    // A different person signing in on the same screen starts from nothing,
    // never from the previous person's state.
    alice.store.dispatch({ type: "auth/context", principal: { provider: "test", subject: "alice" }, authorization: null });
    alice.store.dispatch({ type: "auth/context", principal: { provider: "test", subject: "bob" }, authorization: null });
    assert.deepEqual(alice.store.getState().admin.tree.collapsed, []);
});

test("stored collapsed ids are normalized", () => {
    assert.deepEqual(normalizeStoredAdminCollapsed(["a", "a", " b ", 3, "", null]), ["a", "b"]);
    assert.deepEqual(normalizeStoredAdminCollapsed("agents"), []);
    assert.equal(normalizeStoredAdminCollapsed(Array.from({ length: 100 }, (_, i) => `g${i}`)).length, 64);
    const state = createInitialState({ adminCollapsed: ["agents"] });
    assert.deepEqual(state.admin.tree.collapsed, ["agents"]);
});

test("the TUI window keeps the cursor row in view", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}` }));
    const top = windowAdminTreeRows(rows, "r0", 10);
    assert.deepEqual([top.rows[0].id, top.above, top.below], ["r0", 0, 20]);
    const mid = windowAdminTreeRows(rows, "r15", 10);
    assert.ok(mid.rows.some((r) => r.id === "r15"));
    assert.equal(mid.above + mid.rows.length + mid.below, 30);
    const end = windowAdminTreeRows(rows, "r29", 10);
    assert.deepEqual([end.rows.at(-1).id, end.below], ["r29", 0]);
});

test("an app without an interface or workspace has an empty card and no warning", () => {
    const card = canvasAppInterfaceCard({});
    assert.equal(card.empty, true);
    assert.equal(card.workspaceWarning, null);
});

test("Publish as app is offered to the session owner only", async () => {
    const { selectCanvasPublishAvailable } = await import("../src/index.js");
    const base = createInitialState();
    const withSession = (owner, principal) => ({
        ...base,
        auth: { principal, authorization: null },
        sessions: { ...base.sessions, activeSessionId: "s1", byId: { s1: { sessionId: "s1", owner } } },
    });
    const alice = { provider: "test", subject: "alice" };
    assert.equal(selectCanvasPublishAvailable(withSession(alice, alice)), true);
    assert.equal(selectCanvasPublishAvailable(withSession(alice, { provider: "test", subject: "bob" })), false);
    assert.equal(selectCanvasPublishAvailable(withSession(null, null)), true);
    assert.equal(selectCanvasPublishAvailable(withSession(alice, null)), false);
    assert.equal(selectCanvasPublishAvailable({ ...base }), false);
});
