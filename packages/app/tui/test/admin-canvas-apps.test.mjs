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
import { appReducer, computeLegacyLayout, createInitialState, createStore, selectAdminConsole, PilotSwarmUiController } from "pilotswarm/ui-core";
import { buildAdminConsoleLines } from "../../ui/react/src/components.js";
import { adminCollapsedConfigPatch, adminTreeViewerKey, readAdminCollapsedForViewer } from "../src/admin-tree-config.js";
import { __testing as panelWrap } from "../src/platform.js";

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

test("Ctrl+D/PgDn and Ctrl+U/PgUp page the Canvas Apps detail (review r1 P4)", () => {
    assert.match(source, /adminSection === "canvasApps" && \(isCtrlD \|\| key\.pageDown\)\) \{\s*controller\.handleCommand\(UI_COMMANDS\.ADMIN_CANVAS_APP_DETAIL_PAGE_DOWN\)/);
    assert.match(source, /adminSection === "canvasApps" && \(isCtrlU \|\| key\.pageUp\)\) \{\s*controller\.handleCommand\(UI_COMMANDS\.ADMIN_CANVAS_APP_DETAIL_PAGE_UP\)/);
});

async function bigAppConsole({ longNames = false } = {}) {
    const s = store();
    const big = app("board", "shared", "alice", {
        description: Array.from({ length: 4 }, (_, i) => `Paragraph ${i} explains when to use the board in a long and wordy sentence that wraps.`).join("\n\n"),
    });
    big.card = {
        ...big.card,
        interface: {
            keys: Array.from({ length: 14 }, (_, i) => ({ key: `app/key-${i}`, writer: "page", note: `key number ${i} with a note` })),
            requests: Array.from({ length: 6 }, (_, i) => ({ op: `op-${i}`, result: { text: "string" } })),
            events: [{ key: "evt/tally", note: "posted on recount" }],
        },
    };
    const versions = Array.from({ length: 9 }, (_, i) => ({ versionId: `v-${i}`, version: `1.${i}.0`, sha256: String(i).repeat(64), sizeBytes: 100 + i, card: big.card, createdAt: "2026-10-01T00:00:00Z" }));
    big.activeVersionId = "v-8";
    // Enough apps that the tree overflows and shows both "more" markers.
    // longNames: valid 64-character slugs (the registry maximum), so neighbouring tree rows would wrap (review r3 R2).
    const extra = Array.from({ length: 30 }, (_, i) => app(longNames ? `${"a".repeat(62)}${String(i).padStart(2, "0")}` : `zz-${String(i).padStart(2, "0")}`, "user", "alice"));
    const transport = {
        listCanvasApps: async () => [big, ...extra],
        getCanvasApp: async () => ({ ...big, versions }),
        listCanvasAppEditors: async () => [{ provider: "test", subject: "carol", displayName: "Carol" }],
        getCanvasAppLoads: async () => ({ rows: Array.from({ length: 5 }, (_, i) => ({ loadId: `l${i}`, version: "1.8.0", user: { provider: "test", subject: "bob" }, userDisplayName: `Loader ${i}`, loadedAt: "2026-10-03T10:00:00Z" })), total30d: 5 }),
    };
    const controller = new PilotSwarmUiController({ store: s, transport });
    await controller.refreshAdminCanvasApps();
    await controller.selectAdminCanvasApp({ name: "board", scope: "shared" });
    return { s, controller, versions };
}

// What the TUI Panel actually draws: its own word wrap at width - 4, clipped to height - 2 rows (tui/src/platform.js).
function panelDraws(lines, width, height) {
    const rows = lines.flatMap((line) => panelWrap.wrapRunsLine(line, Math.max(1, width - 4)).map((r) => (r.runs ? r.runs.map((x) => x.text).join("") : String(r.text ?? ""))));
    return { total: rows.length, shown: rows.slice(0, Math.max(1, height - 2)) };
}

/**
 * Page through the Canvas Apps detail at one Panel size and prove, from what the Panel actually draws
 * (its own wrap at width - 4, clipped at height - 2), that every page fits, the keys and the measured
 * position line are on screen, and every detail row 1..N is drawn on some page (review r2 Q2).
 */
async function pageThrough(width, height, treeRows, { longNames = false, selectLong = false } = {}) {
    const { s, controller, versions } = await bigAppConsole({ longNames });
    if (selectLong) {
        // Select a middle long-named app so its neighbours are long-named too; the detail is still the long card.
        controller.setAdminSection("canvasApps");
        controller.setAdminTreeCursor(`capp:user:test:alice:${"a".repeat(62)}15`);
    }
    const cols = width - 4;
    const byIndex = new Map();
    let total = null;
    let pages = 0;
    let maxPositionRows = 0;
    for (;;) {
        const bounds = { maxOffset: 0, page: 10 };
        const lines = buildAdminConsoleLines(selectAdminConsole(s.getState()), { treeRows, height, width, bounds });
        const drawn = panelDraws(lines, width, height);
        assert.ok(drawn.total <= height - 2, `${width}x${height} page ${pages}: ${drawn.total} rows for a ${height - 2}-row Panel body`);
        assert.equal(drawn.shown.length, drawn.total, "nothing is clipped");
        assert.match(drawn.shown.join("\n"), /\^D\/\^U/, "the paging keys are on screen");
        const positionLine = lines.find((line) => /^lines \d+–\d+ of \d+ · \^D\/\^U page$/.test(line.map((r) => r.text).join("")));
        assert.ok(positionLine, "a position line is rendered");
        const positionText = positionLine.map((r) => r.text).join("");
        const [, from, to, of] = /^lines (\d+)–(\d+) of (\d+)/.exec(positionText).map(Number);
        const positionRows = panelWrap.wrapRunsLine(positionLine, cols).length;
        maxPositionRows = Math.max(maxPositionRows, positionRows);
        const at = drawn.shown.findIndex((row) => row.startsWith("lines "));
        assert.ok(at >= 0, "the position line is on screen");
        const detailRows = drawn.shown.slice(at + positionRows);
        assert.equal(detailRows.length, to - from + 1, `the ${to - from + 1} detail rows the position line names are all drawn (position line ${positionRows} row(s))`);
        detailRows.forEach((row, i) => byIndex.set(from + i, row));
        total = of;
        controller.setAdminCanvasAppDetailBounds(bounds.maxOffset, bounds.page);
        const before = s.getState().admin.canvasApps.detailOffset;
        controller.scrollAdminCanvasAppDetail(1);
        if (s.getState().admin.canvasApps.detailOffset === before) break;
        pages += 1;
        assert.ok(pages < 200, "paging terminates");
    }
    for (let i = 1; i <= total; i += 1) assert.ok(byIndex.has(i), `${width}x${height}: detail row ${i} of ${total} is drawn on some page`);
    const all = [...byIndex.values()].join("\n");
    for (const v of versions) assert.match(all, new RegExp(v.version.replace(/\./g, "\\.")), `version ${v.version} reachable`);
    assert.match(all, /Carol/);
    assert.match(all, /Loader 4/);
    assert.match(all, /app\/key-13/);
    for (let i = 0; i < 200; i += 1) controller.scrollAdminCanvasAppDetail(-1);
    assert.equal(s.getState().admin.canvasApps.detailOffset, 0);
    controller.scrollAdminCanvasAppDetail(1);
    await controller.selectAdminCanvasApp({ name: "board", scope: "shared" });
    assert.equal(s.getState().admin.canvasApps.detailOffset, 0, "another selection starts at the top");
    return { pages, maxPositionRows };
}

// The Panel size a TERMINAL of this size gives the Admin Console (TuiApp: width = layout.totalWidth,
// height = max(10, layout.bodyHeight); treeRows as AdminConsolePanel computes it).
function adminPanelFor(columns, rows) {
    const layout = computeLegacyLayout({ width: columns, height: rows }, 0, 1);
    const height = Math.max(10, layout.bodyHeight);
    return { width: layout.totalWidth, height, treeRows: Math.max(6, Math.floor((height - 8) / 2)) };
}

// Terminal 80x24 (review r2 Q2's case), the narrowest terminal the TUI lays out (40 columns), and a tall one.
for (const [columns, rows] of [[80, 24], [40, 24], [120, 40]]) {
    test(`terminal ${columns}x${rows}: every detail row is drawn on some page, nothing is clipped (review r1 P4, r2 Q2)`, async () => {
        const panel = adminPanelFor(columns, rows);
        const { pages } = await pageThrough(panel.width, panel.height, panel.treeRows);
        assert.ok(pages >= 1, "the long card needed paging");
    });
}

test("a wrapped position line is counted: a 30-column Panel wraps it, and every page still fits (review r2 Q2)", async () => {
    const { maxPositionRows } = await pageThrough(30, 24, 6);
    assert.ok(maxPositionRows >= 2, `the position line wrapped (${maxPositionRows} rows) and was budgeted`);
});

test("terminal 40x24 with neighbouring valid 64-character names: the visible rows hold the position line and detail, and paging reaches all of it (review r3 R2)", async () => {
    const panel = adminPanelFor(40, 24);
    assert.equal(panel.width, 40);
    assert.equal(panel.height, 18);
    const { pages } = await pageThrough(panel.width, panel.height, panel.treeRows, { longNames: true, selectLong: true });
    assert.ok(pages >= 1);
});

test("when no Panel row is free for the detail, no detail window is offered (review r3 R2)", async () => {
    const { s } = await bigAppConsole({ longNames: true });
    // An 8-row Panel (6-row body) cannot hold the compact header, the smallest tree (4 rows), the
    // shortest keys, a position line and a detail row. (The TUI itself never lays out below 18 rows.)
    const bounds = { maxOffset: 9, page: 9 };
    const lines = buildAdminConsoleLines(selectAdminConsole(s.getState()), { treeRows: 6, height: 8, width: 40, bounds });
    const drawn = panelDraws(lines, 40, 8);
    assert.ok(drawn.total <= 6, `${drawn.total} rows for a 6-row body`);
    assert.doesNotMatch(drawn.shown.join("\n"), /^lines \d+/m, "no position line");
    assert.equal(bounds.maxOffset, 0, "no paging bounds are reported");
    assert.match(drawn.shown.join("\n"), /\^D\/\^U/, "the paging key hint is still drawn");
});

test("terminal 40x24, long names, and a profile-load error that wraps: when the header compacts the error stays, with the cursor and ^D/^U, within the body (delta check D1)", async () => {
    const panel = adminPanelFor(40, 24);
    const { s, controller } = await bigAppConsole({ longNames: true });
    controller.setAdminSection("canvasApps");
    const cursorId = `capp:user:test:alice:${"a".repeat(62)}15`;
    controller.setAdminTreeCursor(cursorId);
    const error = "Profile request failed while loading your current settings";
    s.dispatch({ type: "admin/profile/loadFailed", error });
    const view = selectAdminConsole(s.getState());
    assert.equal(view.loadError, error);
    const lines = buildAdminConsoleLines(view, { treeRows: panel.treeRows, height: panel.height, width: panel.width, bounds: {} });
    const drawn = panelDraws(lines, panel.width, panel.height);
    assert.ok(drawn.total <= panel.height - 2, `${drawn.total} rows for a ${panel.height - 2}-row body`);
    const shown = drawn.shown.join("\n");
    // The full header would not fit with the tree, keys and detail: it has compacted.
    assert.doesNotMatch(shown, /^Principal /m, "the header compacted");
    assert.match(shown, /^Signed in as /m);
    assert.match(shown, /^! Profile request failed/m, "the profile-load error is still drawn");
    assert.match(shown, /›/, "the cursor row is drawn");
    assert.match(shown, /\^D\/\^U/, "the paging keys are drawn");
});

test("a failed contributors read is shown, not presented as none (review r1 P8)", async () => {
    const s = store();
    const controller = new PilotSwarmUiController({ store: s, transport: {
        listCanvasApps: async () => [app("board", "shared", "alice")],
        getCanvasApp: async () => ({ ...app("board", "shared", "alice"), versions: [] }),
        listCanvasAppEditors: async () => { throw new Error("upstream timeout"); },
        getCanvasAppLoads: async () => ({ rows: [], total30d: 0 }),
    } });
    await controller.refreshAdminCanvasApps();
    await controller.selectAdminCanvasApp({ name: "board", scope: "shared" });
    const out = text(buildAdminConsoleLines(selectAdminConsole(s.getState()), { treeRows: 30 }));
    assert.match(out, /! Could not load the contributors: upstream timeout/);
});
