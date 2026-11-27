import test from "node:test";
import assert from "node:assert/strict";
import {
    WORKFLOW_LEGIBLE_ZOOM, WORKFLOW_READABLE_ZOOM, WORKFLOW_VIEW_MARGIN_PX, workflowFirstViewport, workflowMainPathBounds, workflowRevealViewport,
} from "../src/workflow-graph-fit.js";
import { layoutWorkflowGraphTB, workflowGraphPlaces } from "../src/workflow-graph-layout.js";
import { workflowDefinition } from "../src/workflow-view.js";

const M = WORKFLOW_VIEW_MARGIN_PX;
// Where a graph point is drawn in a view.
const at = (view, gx, gy) => ({ x: gx * view.zoom + view.x, y: gy * view.zoom + view.y });

test("G1: a graph that fits legibly keeps the whole-graph fit (a full screen view of a medium graph is as before)", () => {
    const whole = { x: 10, y: 20, zoom: 0.9 };
    assert.deepEqual(workflowFirstViewport({ whole, bounds: { x: 0, y: 0, width: 400, height: 600 }, area: { width: 600, height: 700 } }), whole);
    // issue-to-pr full screen (1,457 x 1,064 into 1,400 x 700): 0.62, kept whole.
    const full = { x: 0, y: 0, zoom: 0.62 };
    assert.deepEqual(workflowFirstViewport({ whole: full, bounds: { x: 0, y: 0, width: 1457, height: 1064 }, area: { width: 1400, height: 700 } }), full);
    assert.ok(WORKFLOW_LEGIBLE_ZOOM < WORKFLOW_READABLE_ZOOM);
});

test("G1: a large graph's first view shows the main path's top at a readable zoom, centred on it, with the graph's edges at or past the area's", () => {
    // 21 steps: a 1,700 x 2,600 graph, its main path a 260-wide column at x 1,100; a 575 x 420 area (the default three columns).
    const bounds = { x: 0, y: 0, width: 1700, height: 2600 };
    const focus = { x: 1100, y: 0, width: 260, height: 2600 };
    const area = { width: 575, height: 420 };
    const view = workflowFirstViewport({ whole: { x: 0, y: 0, zoom: 0.16 }, bounds, focus, area });
    assert.equal(view.zoom, WORKFLOW_READABLE_ZOOM);
    // The main path's top sits at the area's top, inside the margin; its middle at the area's middle across.
    assert.equal(at(view, 1230, 0).y, M);
    assert.equal(at(view, 1230, 0).x, area.width / 2);
    // Its right edge (1,700) is past the area's right edge, its left edge (0) past the left: no empty side.
    assert.ok(at(view, 1700, 0).x >= area.width - M && at(view, 0, 0).x <= M);
});

test("G1: a readable view starts at the graph's top, so the Start mark above the first step shows", () => {
    const view = workflowFirstViewport({ whole: { x: 0, y: 0, zoom: 0.16 }, bounds: { x: 0, y: 0, width: 1700, height: 2600 },
        focus: { x: 1100, y: 32, width: 260, height: 2500 }, area: { width: 575, height: 420 } });
    assert.equal(at(view, 1230, 0).y, M);
});

test("G1: a main path near the graph's right edge is not centred past it: the graph's right edge stays at the area's", () => {
    const bounds = { x: 0, y: 0, width: 1700, height: 2600 };
    const focus = { x: 1500, y: 0, width: 200, height: 2600 };
    const view = workflowFirstViewport({ whole: { x: 0, y: 0, zoom: 0.16 }, bounds, focus, area: { width: 575, height: 420 } });
    assert.equal(at(view, 1700, 0).x, 575 - M);
});

test("G1: a main path that fits readably is shown whole, centred; a graph without one uses the whole graph as its main path", () => {
    const bounds = { x: 0, y: 0, width: 2000, height: 700 };
    const focus = { x: 800, y: 0, width: 260, height: 600 };
    const area = { width: 800, height: 700 };
    const view = workflowFirstViewport({ whole: { x: 0, y: 0, zoom: 0.38 }, bounds, focus, area });
    assert.ok(view.zoom >= WORKFLOW_READABLE_ZOOM && view.zoom <= 1);
    assert.equal(at(view, 930, 300).y, area.height / 2);
    // No main path: the top of the whole graph, readable, centred across.
    const plain = workflowFirstViewport({ whole: { x: 0, y: 0, zoom: 0.2 }, bounds: { x: 0, y: 0, width: 600, height: 3000 }, area });
    assert.equal(plain.zoom, WORKFLOW_READABLE_ZOOM);
    assert.equal(at(plain, 300, 0).x, area.width / 2);
    assert.equal(at(plain, 300, 0).y, M);
    // Missing or unusable inputs give the whole-graph fit back as it is.
    assert.equal(workflowFirstViewport({ whole: null, bounds, area }), null);
    assert.deepEqual(workflowFirstViewport({ whole: { x: 1, y: 2, zoom: 0.3 }, bounds, area: { width: 0, height: 100 } }), { x: 1, y: 2, zoom: 0.3 });
});

test("G1: the main path is the happy path's boxes where they are drawn", () => {
    const definition = workflowDefinition({ revision: 1, initial: "fetch", states: [
        { id: "fetch", type: "script", outcomes: ["ok", "closed"], next: { ok: "review", closed: "rejected" } },
        { id: "review", type: "script", outcomes: ["accepted", "retry"], next: { accepted: "done", retry: "fetch" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "rejected", type: "terminal", outcome: "blocked" },
    ] });
    const layout = layoutWorkflowGraphTB(definition);
    const places = workflowGraphPlaces(layout, new Map());
    const main = workflowMainPathBounds(layout, places);
    const fetch = places.get("fetch"), done = places.get("done");
    assert.ok(main && main.y <= fetch.y && main.y + main.height >= done.y + done.height, JSON.stringify(main));
    assert.ok(main.x <= fetch.x && main.x + main.width >= fetch.x + fetch.width);
    // fetch's end chip (closed → rejected) is beside it: the main path's box takes its room, so a readable view keeps it.
    assert.ok(layout.chipRoom.get("fetch") > 0);
    assert.ok(main.x + main.width >= fetch.x + fetch.width + layout.chipRoom.get("fetch"));
    assert.equal(workflowMainPathBounds({ edges: [] }, places), null);
});

test("G1 (review GU-07, GU-12): a join bar on the main path takes its parallel step's chip room; bad numbers never make a view", () => {
    const places = new Map([["a", { x: 0, y: 0, width: 200, height: 60 }], ["join:p", { x: 0, y: 100, width: 300, height: 10 }]]);
    const layout = { edges: [{ spine: true, from: "a", to: "join:p" }], chipRoom: new Map([["p", 50]]),
        joins: new Map([["join:p", { id: "join:p", parallel: "p" }]]) };
    assert.deepEqual(workflowMainPathBounds(layout, places), { x: 0, y: 0, width: 350, height: 110 });
    // An unusable chip room counts as none; an extent that is not finite gives no main path.
    assert.equal(workflowMainPathBounds({ ...layout, chipRoom: new Map([["p", Infinity]]) }, places).width, 300);
    assert.equal(workflowMainPathBounds(layout, new Map([["a", { x: 0, y: 0, width: Number.MAX_VALUE, height: 1 }],
        ["join:p", { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1 }]])), null);
    // NaN options fall back to the defaults; a result that is not finite gives the whole-graph fit back.
    const whole = { x: 0, y: 0, zoom: 0.16 };
    const args = { whole, bounds: { x: 0, y: 0, width: 1700, height: 2600 }, area: { width: 575, height: 420 } };
    assert.deepEqual(workflowFirstViewport({ ...args, maxZoom: NaN, margin: NaN, readable: NaN, legible: NaN }), workflowFirstViewport(args));
    assert.deepEqual(workflowFirstViewport({ ...args, bounds: { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: Number.MAX_VALUE } }), whole);
    assert.notEqual(workflowRevealViewport({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 500, width: 10, height: 10 }, { width: 100, height: 100 }, NaN), null);
});

test("G1, P2: a selected step out of view is brought into view by the smallest pan, keeping the zoom", () => {
    const view = { x: 0, y: 0, zoom: 0.5 };
    const visible = { width: 400, height: 300 };
    // In view: nothing to do.
    assert.equal(workflowRevealViewport(view, { x: 100, y: 100, width: 200, height: 66 }, visible), null);
    // Below the visible part (the Node panel opened under it): moved up just enough.
    const below = workflowRevealViewport(view, { x: 100, y: 600, width: 200, height: 66 }, visible);
    assert.equal(below.zoom, 0.5);
    assert.equal(below.x, 0);
    assert.equal(at(below, 100, 666).y, visible.height - M);
    // Left of it: moved right just enough.
    const left = workflowRevealViewport({ x: -200, y: 0, zoom: 1 }, { x: 50, y: 10, width: 100, height: 50 }, visible);
    assert.equal(at(left, 50, 10).x, M);
    // A phone's sheet leaves only the top 120 px: the step goes into that part.
    const sheet = workflowRevealViewport({ x: 0, y: 0, zoom: 1 }, { x: 10, y: 150, width: 100, height: 60 }, { width: 400, height: 120 });
    assert.ok(at(sheet, 10, 150).y >= M && at(sheet, 10, 210).y <= 120 - M);
    // A step larger than the room keeps its top left in view.
    const big = workflowRevealViewport({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 500, width: 100, height: 400 }, { width: 400, height: 300 });
    assert.equal(at(big, 0, 500).y, M);
    assert.equal(workflowRevealViewport(null, { x: 0, y: 0, width: 1, height: 1 }, visible), null);
    assert.equal(workflowRevealViewport(view, null, visible), null);
});
