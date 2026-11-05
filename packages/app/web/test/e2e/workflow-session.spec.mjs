// Workflow sessions in the portal, in a real browser:
//   - the main pane preserves branching topology, with a resizable log below
//   - node selection opens details in the canvas; the footer is read-only
//   - new workflows are child-first and ordinary agent/canvas behavior stays
//
// PS_E2E_SHOT_DIR, when set, receives screenshots of each state for review.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { startStubServer } from "./stub-server.mjs";
import { buildWorkflowCanvasHtml, compileWorkflow, foldWorkflowCanvasState } from "../../../../sdk/dist/workflow/index.js";

const AGENT_ID = "11111110-2222-3333-4444-555555555550";
const WORKFLOW_ID = "77777777-2222-3333-4444-555555555555";
const CREATED_ID = "88888888-2222-3333-4444-555555555555";
const SHOTS = process.env.PS_E2E_SHOT_DIR || null;

const now = Date.now();
const SESSIONS = [
    { sessionId: AGENT_ID, title: "Release triage agent", status: "idle", model: "test:test-model", createdAt: now - 60_000, updatedAt: now - 60_000 },
    {
        sessionId: WORKFLOW_ID, title: "Workflow: nightly-report", status: "completed", sessionKind: "workflow",
        parentSessionId: AGENT_ID, createdAt: now - 30_000, updatedAt: now - 20_000,
    },
];

let seq = 0;
const ev = (eventType, data, offsetMs) => ({ seq: ++seq, sessionId: WORKFLOW_ID, eventType, data, timestamp: now - 30_000 + offsetMs });
const WORKFLOW_EVENTS = [
    ev("workflow.started", {
        name: "nightly-report",
        version: "1.0.0",
        initial: "collect",
        states: [
            { id: "collect", type: "script", runtime: "python", timeoutSeconds: 300, next: { found: "report", empty: "nothing", failure: "failed" } },
            { id: "report", type: "script", runtime: "node", timeoutSeconds: 300, next: { done: "published" } },
            { id: "published", type: "terminal", outcome: "succeeded" },
            { id: "nothing", type: "terminal", outcome: "blocked" },
            { id: "failed", type: "terminal", outcome: "failed" },
        ],
    }, 0),
    ev("workflow.state_started", { stateId: "collect", runtime: "python", step: 1 }, 100),
    ev("workflow.state_completed", {
        stateId: "collect", step: 1, outcome: "found", resultSource: "reported", exitCode: 0, durationMs: 1840,
        toolCalls: [{ name: "read_facts", ok: true, durationMs: 40 }], outputPreview: "{\"count\":3}",
    }, 2000),
    ev("workflow.state_started", { stateId: "report", runtime: "node", step: 2 }, 2100),
    ev("workflow.state_completed", {
        stateId: "report", step: 2, outcome: "done", resultSource: "reported", exitCode: 0, durationMs: 420,
        toolCalls: [{ name: "store_fact", ok: true, durationMs: 30 }], outputPreview: "{\"count\":3}",
    }, 2600),
    ev("workflow.completed", { name: "nightly-report", steps: 2, stateId: "published", outcome: "succeeded", summary: "Report published.", outputPreview: "{\"count\":3}" }, 2700),
];

let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

/** A phone's way back from the details layer (the canvas) to the workflow: the toolbar's canvas toggle (0.8.9). */
async function hideCanvas(page) {
    await page.getByRole("button", { name: "Hide the canvas", exact: true }).click();
}

async function shot(page, name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

async function routeApi(page, { onCreate, workflowEvents = WORKFLOW_EVENTS, onSocket = () => {}, workflowState = {}, onReadWorkflow = null } = {}) {
    await page.routeWebSocket("**/api/v1/ws", onSocket);
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const pathname = new URL(req.url()).pathname;
        const answer = (result) => route.fulfill({ json: { ok: true, result } });
        const sessions = SESSIONS.map(session => session.sessionId === WORKFLOW_ID ? { ...session, ...workflowState } : session);
        // readWorkflow: a test that needs a v2 read model answers it; otherwise the stub answers as for a version 1 workflow.
        if (onReadWorkflow && pathname.endsWith(`/sessions/${WORKFLOW_ID}/workflow`) && req.method() === "GET") return onReadWorkflow(route);
        if (pathname.endsWith("/models")) return answer([{ providerId: "test", modelName: "test-model", qualifiedName: "test:test-model" }]);
        if (pathname.endsWith("/providers")) return answer({ providers: [{ name: "test", typeId: "test", class: "shared", hasCredential: true, usableByMe: true }] });
        if (pathname.endsWith("/providers/status")) return answer({ providers: [] });
        if (pathname.endsWith("/defaults")) return answer({});
        if (pathname.endsWith("/management/sessions")) return answer({ sessions, hasMore: false, nextCursor: null });
        if (pathname.endsWith("/sessions") && req.method() === "GET") return answer({ sessions, hasMore: false });
        if (pathname.endsWith("/sessions/workflow") && req.method() === "POST") return onCreate(route, req.postDataJSON());
        if (pathname.includes(`/sessions/${WORKFLOW_ID}/events`)) return answer(workflowEvents);
        if (pathname.includes(`/sessions/${CREATED_ID}/events`)) return answer([]);
        if (pathname.endsWith(`/sessions/${WORKFLOW_ID}`)) return answer({ ...sessions[1], events: [], messages: [] });
        if (pathname.endsWith(`/sessions/${CREATED_ID}`)) {
            return answer({ sessionId: CREATED_ID, sessionKind: "workflow", title: "Workflow: example-workflow", status: "running", events: [], messages: [] });
        }
        return route.fallback();
    });
}

test("a workflow session is marked in the list, shows its execution log and has no chat box", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeApi(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);

    const workflowRow = page.locator(".ps-session-row-content", { hasText: "Workflow: nightly-report" }).first();
    await expect(workflowRow).toBeVisible();
    await expect(workflowRow.getByRole("img", { name: "Workflow" })).toBeVisible();
    await expect(page.locator(".ps-session-row-content", { hasText: "Release triage agent" }).first().locator(".ps-workflow-glyph")).toHaveCount(0);

    // Batch 5 (g-03): the pane opens with the graph only; the Step log button opens the execution log below it.
    const main = page.locator(".ps-workflow-main");
    await expect(main.locator(".ps-workflow-log")).toHaveCount(0);
    const logButton = main.getByRole("button", { name: "Step log", exact: true });
    await expect(logButton).toHaveAttribute("aria-expanded", "false");
    await logButton.click();
    await expect(logButton).toHaveAttribute("aria-expanded", "true");
    const chat = page.locator(".ps-chat-panel");
    await chat.locator(".ps-system-notice-summary", { hasText: "Workflow: nightly-report" }).click();
    await expect(chat).toContainText("Workflow nightly-report 1.0.0 started: 5 steps, first step collect");
    await expect(chat).toContainText("found → report, empty → nothing, failure → failed");
    await expect(chat).toContainText("ends: succeeded");
    await expect(chat).toContainText("Step 1: collect → found in 1.8 s · 1 tool call (read_facts)");
    await expect(chat).toContainText("Step 2: report → done");
    await expect(chat).toContainText("Workflow nightly-report reached published after 2 steps: outcome succeeded. Report published.");

    // flow-09: the workflow screen has no static composer bar; nobody types into it.
    await expect(page.locator(".ps-workflow-main .ps-composer-readonly")).toHaveCount(0);
    await expect(page.locator(".ps-prompt-input")).toHaveCount(0);
    await shot(page, "1-workflow-session-execution-log");
    expect(errors).toEqual([]);
});

test("the new-session dialog offers no workflow start: an agent starts workflows (flow-05)", async ({ page }) => {
    const errors = [];
    const created = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeApi(page, {
        onCreate: (route, body) => {
            created.push(body);
            return route.fulfill({ json: { ok: true, result: { sessionId: CREATED_ID, sessionKind: "workflow", workflowName: "example-workflow" } } });
        },
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    await expect(page.locator(".ps-prompt-input")).toBeVisible();

    await page.getByRole("button", { name: "New session — choose model and agent", exact: true }).click();
    await expect(page.getByText("Select model for new session", { exact: true })).toBeVisible();
    await shot(page, "2-new-session-model-step");
    await expect(page.getByRole("button", { name: /Workflows? start/ })).toHaveCount(0);
    expect(created).toHaveLength(0);
    // Leaving the dialog leaves the ordinary agent conversation as it was.
    await page.keyboard.press("Escape");
    await expect(page.locator(".ps-prompt-input")).toBeVisible();
    expect(errors).toEqual([]);
});

test("failed process results remain failed and node output is rendered as text", async ({ page }) => {
    const events = [
        WORKFLOW_EVENTS[0],
        { sessionId: WORKFLOW_ID, seq: 2, eventType: "workflow.state_started", data: { stateId: "collect", step: 1 } },
        { sessionId: WORKFLOW_ID, seq: 3, eventType: "workflow.state_completed", data: {
            stateId: "collect", step: 1, outcome: "timeout", resultSource: "timeout", exitCode: null,
            outputPreview: "<img src=x onerror=alert(1)>", stderrTail: "connection timed out",
        } },
    ];
    await routeApi(page, { workflowEvents: events, workflowState: { status: "running" } });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const node = page.getByRole("button", { name: "Inspect collect", exact: true });
    await expect(node).toHaveClass(/is-failed/);
    await node.click();
    const details = page.locator(".ps-workflow-node-details");
    await details.getByRole("tab", { name: "Output", exact: true }).click();
    await expect(details).toContainText("<img src=x onerror=alert(1)>");
    await expect(details).toContainText("connection timed out");
    await expect(details.locator("img")).toHaveCount(0);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`quiet polling stays in one updating row at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        let nextSeq = 0;
        const event = (eventType, data) => ({ sessionId: WORKFLOW_ID, seq: ++nextSeq,
            eventType, data, createdAt: new Date().toISOString() });
        const rows = [event("workflow.started", { name: "query-watch", version: "1", initial: "poll_query", states: [
            { id: "poll_query", type: "script", runtime: "node", next: { unchanged: "poll_query", changed: "end" } },
            { id: "end", type: "terminal", outcome: "succeeded" },
        ] })];
        const start = step => event("workflow.state_started", { stateId: "poll_query", runtime: "node", step });
        const complete = (step, outcome = "unchanged") => event("workflow.state_completed", {
            stateId: "poll_query", step, outcome, durationMs: 120, resultSource: "reported",
            toolCalls: [{ name: "demo_query_snapshot", ok: true }], outputPreview: '{"count":1}',
        });
        for (let step = 1; step <= 28; step++) rows.push(start(step), complete(step));
        const sockets = [];
        let subscribed = false;
        const workflowState = { status: "running", title: "Workflow: query-watch" };
        await routeApi(page, { workflowEvents: rows, workflowState, onSocket: socket => {
            sockets.push(socket);
            socket.onMessage(raw => { if (JSON.parse(raw).type === "subscribeSession") subscribed = true; });
        } });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
        // Batch 5 (g-03): the step log opens from its button.
        const openLog = () => page.locator(".ps-workflow-main").getByRole("button", { name: "Step log", exact: true }).click();
        await openLog();
        const summary = page.locator(".ps-workflow-progress");
        await expect(summary).toHaveCount(1);
        await expect(summary.locator("summary")).toContainText("Waiting for changes");
        await expect(summary.locator("summary")).toContainText("28 checks");
        await expect(summary.locator(".ps-system-notice-summary-text")).toHaveAttribute("aria-live", "polite");
        await expect(summary.locator(".ps-workflow-glyph")).toHaveAttribute("aria-hidden", "true");
        await expect(summary).not.toHaveAttribute("open", "");
        await expect(page.locator(".ps-workflow-main .ps-chat-composer")).toHaveCount(0);
        const bounds = await summary.boundingBox();
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
        await shot(page, `poll-waiting-${viewport.width}`);
        await expect.poll(() => subscribed).toBe(true);
        await summary.locator("summary").click();
        await expect(summary).toHaveAttribute("open", "");
        for (const item of [start(29), complete(29)]) {
            rows.push(item);
            for (const socket of sockets) socket.send(JSON.stringify({ type: "sessionEvent", sessionId: WORKFLOW_ID, event: item }));
        }

        await expect(summary.locator("summary")).toContainText("29 checks");
        await expect(summary).toHaveAttribute("open", "");
        await expect(summary.locator(".ps-system-notice-body")).toContainText("Latest output");
        await shot(page, `poll-details-${viewport.width}`);
        for (const item of [start(30), complete(30, "changed"),
            event("workflow.completed", { name: "query-watch", stateId: "end", steps: 30, outcome: "succeeded" })]) {
            rows.push(item);
            for (const socket of sockets) socket.send(JSON.stringify({ type: "sessionEvent", sessionId: WORKFLOW_ID, event: item }));
        }
        await expect(summary.locator("summary")).toContainText("Polling ended");
        await expect(page.locator(".ps-chat-panel")).toContainText("poll_query → changed");
        await expect(summary).toHaveCount(1);
        workflowState.status = "completed";
        await page.reload();
        await openLog();
        await expect(page.locator(".ps-workflow-progress")).toHaveCount(1);
        await expect(page.locator(".ps-workflow-progress summary")).toContainText("29 checks");
        await shot(page, `poll-summary-${viewport.width}`);
        expect(errors).toEqual([]);
    });
}

const QUALITY_EVENTS = [
    { eventType: "workflow.started", data: {
        name: "branching-workflow-test", version: "1.0.0", initial: "collect_metrics", states: [
            { id: "collect_metrics", type: "script", runtime: "node", next: { success: "evaluate_quality", failure: "failed" } },
            { id: "evaluate_quality", type: "script", runtime: "node", next: { approved: "approved", blocked: "blocked", failure: "failed" } },
            { id: "approved", type: "terminal", outcome: "succeeded" },
            { id: "blocked", type: "terminal", outcome: "blocked" },
            { id: "failed", type: "terminal", outcome: "failed" },
        ],
    } },
    { eventType: "workflow.state_started", data: { stateId: "collect_metrics", step: 1 } },
    { eventType: "workflow.state_completed", data: { stateId: "collect_metrics", step: 1, outcome: "success",
        resultSource: "reported", exitCode: 0, outputPreview: '{"coverage":84,"criticalFindings":0}' } },
    { eventType: "workflow.state_started", data: { stateId: "evaluate_quality", step: 2 } },
    { eventType: "workflow.state_completed", data: { stateId: "evaluate_quality", step: 2, outcome: "failure",
        resultSource: "exit", exitCode: 1, stderrTail: "ReferenceError: input is not defined" } },
    { eventType: "workflow.failed", data: { stateId: "failed", steps: 2, outcome: "failed" } },
].map((event, index) => ({ ...event, sessionId: WORKFLOW_ID, seq: index + 1, createdAt: new Date().toISOString() }));

// Batch 5 T8: React Flow draws the graph. These read what it shows: the view's translation and scale, the edges it draws
// (a path with a real `d`), and the view once it has settled (two reads in a row agree).
const viewOf = graph => graph.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, scale: matrix.a };
});
const drawnEdges = graph => graph.locator(".react-flow__edges .ps-workflow-edge-path")
    .evaluateAll(paths => paths.filter(path => (path.getAttribute("d") || "").trim().length > 1).length);
/** How many Step details boxes are on screen: laid out, not hidden, and inside the window. */
const detailsOnScreen = page => page.locator(".ps-workflow-node-details").evaluateAll(boxes => boxes.filter(box => {
    const rect = box.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(box).visibility !== "hidden"
        && rect.right > 0 && rect.left < window.innerWidth && rect.bottom > 0 && rect.top < window.innerHeight;
}).length);
/** The unique step-to-step routes of a definition's states (what the graph draws as edges). */
const edgeCount = states => {
    const ids = new Set(states.map(state => state.id));
    return new Set(states.flatMap(state => Object.values(state.next || {}).filter(target => ids.has(target)).map(target => `${state.id}->${target}`))).size;
};
async function flowReady(graph) {
    await expect(graph).toHaveAttribute("data-renderer", "flow");
    await expect.poll(() => graph.locator(".react-flow__node")
        .evaluateAll(nodes => nodes.length > 0 && nodes.every(node => getComputedStyle(node).visibility === "visible"))).toBe(true);
}
/** Every edge is drawn, and stays drawn while React Flow measures the steps (it used to drop them once measured). */
async function expectEdgesDrawn(graph, count) {
    await expect.poll(() => drawnEdges(graph)).toBe(count);
    for (let i = 0; i < 5; i += 1) {
        await graph.page().waitForTimeout(150);
        expect(await drawnEdges(graph)).toBe(count);
    }
}
/**
 * The view once it stops moving. Zoom and Fit animate (up to 200 ms) from the next frame, so a read right after the
 * click still shows the old view: wait the animation out first, then poll until two reads 150 ms apart agree.
 */
async function settledView(graph) {
    await graph.page().waitForTimeout(350);
    let last = await viewOf(graph);
    await expect.poll(async () => {
        await graph.page().waitForTimeout(150);
        const now = await viewOf(graph);
        const same = Math.abs(now.x - last.x) < 0.5 && Math.abs(now.y - last.y) < 0.5 && Math.abs(now.scale - last.scale) < 0.0005;
        last = now;
        return same;
    }, { intervals: [150, 150, 250, 250, 500] }).toBe(true);
    return last;
}
const QUALITY_EDGES = edgeCount(QUALITY_EVENTS[0].data.states);

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`the quality gate is a real branching graph, top to bottom, at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await routeApi(page, { workflowEvents: QUALITY_EVENTS,
            workflowState: { title: "Workflow: branching-workflow-test", status: "failed" } });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
        const main = page.locator(".ps-workflow-main");
        const graph = main.getByRole("group", { name: "Workflow graph" });
        // Batch 5 (g-02): React Flow draws it once loaded, every edge included (T8: edges vanished once steps were measured).
        await flowReady(graph);
        await expect(graph.locator(".ps-workflow-node")).toHaveCount(5);
        await expect(graph.locator(".ps-workflow-edge")).toHaveCount(5);
        await expectEdgesDrawn(graph, QUALITY_EDGES);
        await expect(graph.locator('[data-from="failed"], [data-from="approved"], [data-from="blocked"]')).toHaveCount(0);
        await settledView(graph);
        // Top to bottom (g-01): each step's box is below the box of the step that leads to it; the three ends share a row.
        const box = id => graph.locator(`[data-node-id="${id}"]`).boundingBox();
        const collect = await box("collect_metrics"), evaluate = await box("evaluate_quality");
        const terminals = await Promise.all(["approved", "blocked", "failed"].map(box));
        expect(evaluate.y).toBeGreaterThan(collect.y + collect.height - 1);
        for (const end of terminals) expect(end.y).toBeGreaterThan(evaluate.y + evaluate.height - 1);
        expect(new Set(terminals.map(end => Math.round(end.y))).size).toBe(1);
        expect(new Set(terminals.map(end => Math.round(end.x))).size).toBe(3);
        // Fitted: every step is inside the graph's area when it opens.
        const area = await graph.boundingBox();
        for (const step of [collect, evaluate, ...terminals]) {
            expect(step.x).toBeGreaterThanOrEqual(area.x - 1);
            expect(step.x + step.width).toBeLessThanOrEqual(area.x + area.width + 1);
            expect(step.y).toBeGreaterThanOrEqual(area.y - 1);
            expect(step.y + step.height).toBeLessThanOrEqual(area.y + area.height + 1);
        }
        await expect(graph.getByRole("button", { name: "Inspect evaluate_quality", exact: true })).toHaveClass(/is-failed/);
        // The old picture's controls are gone.
        await expect(main.getByRole("button", { name: "100%", exact: true })).toHaveCount(0);
        await expect(main.getByText("Full graph · scroll to explore")).toHaveCount(0);
        await shot(page, `quality-branches-fit-${viewport.width}`);
        await graph.getByRole("button", { name: "Inspect blocked", exact: true }).click();
        if (viewport.width < 920) {
            // On a phone a tap only selects the step; Step details opens it (flow-04).
            await expect(graph).toBeVisible();
            await main.getByRole("button", { name: "Step details", exact: true }).click();
        }
        await expect(page.locator(".ps-workflow-node-details").filter({ visible: true }).locator("h2")).toHaveText("blocked");
        await shot(page, `quality-branch-details-${viewport.width}`);
    });

    // Batch 5 (g-04, g-05): Zoom in, Zoom out, Fit to screen and the hand (Move the graph). With the hand on, dragging the
    // background moves the graph; with it off the graph stays still under a drag and the wheel, and a step still selects.
    // Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "zooms, fits and moves" (from packages/app/web, after build).
    test(`the graph zooms, fits and moves with the hand, and stays still without it, at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await routeApi(page, { workflowEvents: QUALITY_EVENTS,
            workflowState: { title: "Workflow: branching-workflow-test", status: "failed" } });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
        const main = page.locator(".ps-workflow-main");
        const graph = main.getByRole("group", { name: "Workflow graph" });
        await flowReady(graph);
        const viewportOf = () => viewOf(graph);
        const controls = graph.getByRole("group", { name: "Graph view", exact: true });
        await expect(controls.getByRole("button")).toHaveCount(4);
        // The fitted view, once the first fit has settled (T8: it was read before the fit had happened).
        const fitted = await settledView(graph);
        await controls.getByRole("button", { name: "Zoom in", exact: true }).click();
        await expect.poll(async () => (await viewportOf()).scale).toBeGreaterThan(fitted.scale * 1.05);
        await controls.getByRole("button", { name: "Zoom out", exact: true }).click();
        await controls.getByRole("button", { name: "Zoom out", exact: true }).click();
        await expect.poll(async () => (await viewportOf()).scale).toBeLessThan(fitted.scale * 0.95);
        await controls.getByRole("button", { name: "Fit to screen", exact: true }).click();
        await expect.poll(async () => Math.abs((await viewportOf()).scale - fitted.scale)).toBeLessThan(0.01);
        await expect.poll(async () => Math.abs((await viewportOf()).x - fitted.x)).toBeLessThan(2);

        // The hand is on by default: a drag on the background (the area's top-left corner, outside every step) moves the graph.
        const hand = controls.getByRole("button", { name: "Move the graph", exact: true });
        await expect(hand).toHaveAttribute("aria-pressed", "true");
        const area = await graph.boundingBox();
        const drag = async (dx, dy) => {
            await page.mouse.move(area.x + 10, area.y + 10);
            await page.mouse.down();
            await page.mouse.move(area.x + 10 + dx / 2, area.y + 10 + dy / 2, { steps: 4 });
            await page.mouse.move(area.x + 10 + dx, area.y + 10 + dy, { steps: 4 });
            await page.mouse.up();
        };
        const before = await viewportOf();
        await drag(60, 40);
        await expect.poll(async () => (await viewportOf()).x - before.x).toBeGreaterThan(40);
        const moved = await viewportOf();
        expect(moved.y - before.y).toBeGreaterThan(20);

        // Off: the graph stays still under a drag and the wheel; clicking a step still selects it.
        await hand.click();
        await expect(hand).toHaveAttribute("aria-pressed", "false");
        await drag(80, 60);
        await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
        await page.mouse.wheel(0, -300);
        await page.waitForTimeout(250);
        const still = await viewportOf();
        expect(Math.abs(still.x - moved.x)).toBeLessThan(1);
        expect(Math.abs(still.y - moved.y)).toBeLessThan(1);
        expect(Math.abs(still.scale - moved.scale)).toBeLessThan(0.001);
        await graph.getByRole("button", { name: "Inspect blocked", exact: true }).click();
        await expect(graph.getByRole("button", { name: "Inspect blocked", exact: true })).toHaveAttribute("aria-pressed", "true");
        // The controls explain themselves on hover, as the other workflow tools do.
        await hand.hover();
        await expect(page.locator(".ps-icon-tooltip")).toHaveText(/^Move the graph — The graph stays still/);
        await shot(page, `graph-controls-${viewport.width}`);
        expect(errors).toEqual([]);
    });

    // Batch 5 T8: with the hand on, every edge stays drawn once React Flow has measured the steps and after a step is
    // selected, and a step answers a click (1440: its details open) or a tap (390: the first tap selects, the second
    // opens; flow-04). Selector: -g "stay drawn" (from packages/app/web, after build).
    test(`edges stay drawn and a step answers a click or tap with the hand on, at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await routeApi(page, { workflowEvents: QUALITY_EVENTS,
            workflowState: { title: "Workflow: branching-workflow-test", status: "failed" } });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
        const main = page.locator(".ps-workflow-main");
        const graph = main.getByRole("group", { name: "Workflow graph" });
        await flowReady(graph);
        await expectEdgesDrawn(graph, QUALITY_EDGES);
        await expect(graph.getByRole("button", { name: "Move the graph", exact: true })).toHaveAttribute("aria-pressed", "true");
        const step = graph.getByRole("button", { name: "Inspect collect_metrics", exact: true });
        const details = page.locator(".ps-workflow-node-details").filter({ visible: true });
        await step.click();
        await expect(step).toHaveAttribute("aria-pressed", "true");
        if (viewport.width < 920) {
            await expect(details).toHaveCount(0);
            await expectEdgesDrawn(graph, QUALITY_EDGES);
            await step.click();
        } else {
            await expectEdgesDrawn(graph, QUALITY_EDGES);
        }
        await expect(details.locator("h2")).toHaveText("collect_metrics");
        await shot(page, `graph-edges-after-select-${viewport.width}`);
        expect(errors).toEqual([]);
    });

    // Batch 6 (f-03): a drag that starts on a step moves that step's box by the drag distance; it does not move the graph
    // and does not select the step. A press that moves less than 4px is a click and selects it. With the hand on or off.
    // Selector: -g "starts on a step" (from packages/app/web, after build).
    test(`a drag that starts on a step moves the step, not the graph, and does not select it, at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await routeApi(page, { workflowEvents: QUALITY_EVENTS,
            workflowState: { title: "Workflow: branching-workflow-test", status: "failed" } });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
        const main = page.locator(".ps-workflow-main");
        const graph = main.getByRole("group", { name: "Workflow graph" });
        await flowReady(graph);
        await settledView(graph);
        const hand = graph.getByRole("button", { name: "Move the graph", exact: true });
        for (const handOn of [true, false]) {
            if (!handOn) await hand.click();
            await expect(hand).toHaveAttribute("aria-pressed", String(handOn));
            const id = handOn ? "evaluate_quality" : "collect_metrics";
            const step = graph.getByRole("button", { name: `Inspect ${id}`, exact: true });
            const pressed = await step.getAttribute("aria-pressed");
            const shownBefore = await page.locator(".ps-workflow-node-details").filter({ visible: true }).locator("h2").allTextContents();
            const before = await settledView(graph);
            const box = await step.boundingBox();
            const x = box.x + box.width / 2, y = box.y + box.height / 2;
            await page.mouse.move(x, y);
            await page.mouse.down();
            // The drag begins where the pointer first passes the 4-pixel click distance (React Flow's nodeDragThreshold),
            // and the box follows the pointer from there: a first step of 5 pixels begins it (a first step of 10 left the
            // box 10 pixels behind the pointer, as the early full run showed).
            await page.mouse.move(x + 5, y);
            await page.mouse.move(x + 40, y + 30, { steps: 4 });
            await page.mouse.move(x + 80, y + 60, { steps: 4 });
            const during = await viewOf(graph);
            await page.mouse.up();
            const after = await settledView(graph);
            // The graph did not move.
            for (const view of [during, after]) {
                expect(Math.abs(view.x - before.x)).toBeLessThan(1);
                expect(Math.abs(view.y - before.y)).toBeLessThan(1);
                expect(Math.abs(view.scale - before.scale)).toBeLessThan(0.001);
            }
            // The step's box moved with the pointer.
            const moved = await step.boundingBox();
            expect(Math.abs(moved.x - box.x - 80)).toBeLessThan(6);
            expect(Math.abs(moved.y - box.y - 60)).toBeLessThan(6);
            // It was not selected, and Step details did not switch to it.
            await expect(step).toHaveAttribute("aria-pressed", pressed ?? "false");
            expect(await page.locator(".ps-workflow-node-details").filter({ visible: true }).locator("h2").allTextContents()).toEqual(shownBefore);
        }
        // A press that moves under 4px is a click: it selects the step.
        const blocked = graph.getByRole("button", { name: "Inspect blocked", exact: true });
        const small = await blocked.boundingBox();
        const cx = small.x + small.width / 2, cy = small.y + small.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 2, cy + 1, { steps: 2 });
        await page.mouse.up();
        await expect(blocked).toHaveAttribute("aria-pressed", "true");
        const still = await blocked.boundingBox();
        expect(Math.abs(still.x - small.x)).toBeLessThan(3);
        // Control: with the hand on, the same drag from the background does move the graph.
        await hand.click();
        await expect(hand).toHaveAttribute("aria-pressed", "true");
        const view = await settledView(graph);
        const area = await graph.boundingBox();
        await page.mouse.move(area.x + 10, area.y + 10);
        await page.mouse.down();
        await page.mouse.move(area.x + 50, area.y + 40, { steps: 4 });
        await page.mouse.move(area.x + 90, area.y + 70, { steps: 4 });
        await page.mouse.up();
        await expect.poll(async () => (await viewOf(graph)).x - view.x).toBeGreaterThan(40);
        await shot(page, `graph-drag-step-${viewport.width}`);
        expect(errors).toEqual([]);
    });
}

// Batch 6 (f-02): a workflow has no mobile zen. Its step log (in the details layer) has no "Enter mobile zen", the details
// layer has no maximize toggle, and there is no composer bar; a step's details are reachable from the graph.
test("mobile: a workflow has no zen entry, no maximize toggle and no composer bar, and node details are reachable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeApi(page, { workflowEvents: QUALITY_EVENTS,
        workflowState: { title: "Workflow: branching-workflow-test", status: "failed" } });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const main = page.locator(".ps-workflow-main");
    await main.getByRole("button", { name: "Step log", exact: true }).click();
    const log = page.locator('.ps-workflow-side-panel[data-panel="log"]').filter({ visible: true });
    await expect(log.locator(".ps-workflow-log")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enter mobile zen", exact: true })).toHaveCount(0);
    await expect(page.locator(".ps-mobile-zen")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Maximize canvas", exact: true })).toHaveCount(0);
    await expect(page.locator(".ps-composer-readonly")).toHaveCount(0);
    await shot(page, "quality-mobile-no-zen");
    await log.getByRole("button", { name: "Back to Step details", exact: true }).click();
    const details = page.locator(".ps-workflow-node-details").filter({ visible: true });
    await expect(details).toBeVisible();
    // A phone has no Sessions mode button (0.8.9): the canvas toggle leads back from the details layer to the workflow.
    await hideCanvas(page);
    await main.getByRole("button", { name: "Inspect evaluate_quality", exact: true }).click();
    await main.getByRole("button", { name: "Inspect evaluate_quality", exact: true }).click();
    await expect(details.locator("h2")).toHaveText("evaluate_quality");
    await details.getByRole("tab", { name: "Output", exact: true }).click();
    await expect(details).toContainText("ReferenceError: input is not defined");
    expect(errors).toEqual([]);
});

// ── The live canvas ────────────────────────────────────────────────

const LIVE_ID = "66666666-2222-3333-4444-555555555555";
const LIVE_YAML = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: nightly-report, version: 1.0.0 }
initial: collect
states:
  collect: { type: script, runtime: python, source: x, completion: { outcomes: [found, empty] }, transition: { next: { found: summarize, empty: nothing } } }
  summarize: { type: script, runtime: node, source: x, completion: { outcomes: [again, done, failure] }, transition: { next: { again: summarize, done: publish, failure: failed } } }
  publish: { type: script, runtime: powershell, source: x, completion: { outcomes: [success] }, transition: { next: { success: published } } }
  published: { type: terminal, outcome: succeeded, summary: Report published. }
  nothing: { type: terminal, outcome: blocked }
  failed: { type: terminal, outcome: failed }
`;

test("the main workflow graph follows live ticks and selection drives canvas node details", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const graph = compileWorkflow(LIVE_YAML);
    const html = buildWorkflowCanvasHtml(graph, foldWorkflowCanvasState([], graph));
    const log = [
        { eventType: "workflow.started", data: { name: "nightly-report", initial: graph.initial,
            states: Object.values(graph.states).map(n => ({ id: n.id, type: n.type, runtime: n.runtime, next: n.next, outcome: n.outcome })) } },
        { eventType: "workflow.state_started", data: { stateId: "collect", step: 1 } },
        { eventType: "workflow.state_completed", data: { stateId: "collect", step: 1, outcome: "found", resultSource: "reported", durationMs: 1840, toolCalls: [{ name: "read_facts", ok: true }] } },
        { eventType: "workflow.state_started", data: { stateId: "summarize", step: 2 } },
        { eventType: "workflow.state_completed", data: { stateId: "summarize", step: 2, outcome: "again", resultSource: "reported", durationMs: 920, toolCalls: [] } },
        { eventType: "workflow.state_started", data: { stateId: "summarize", step: 3 } },
    ];
    const running = foldWorkflowCanvasState(log);
    const sockets = [];
    let subscribed = false;
    const session = { sessionId: LIVE_ID, title: "Workflow: nightly-report", status: "running", sessionKind: "workflow", createdAt: now - 10_000, updatedAt: now };
    await page.routeWebSocket("**/api/v1/ws", (socket) => {
        sockets.push(socket);
        socket.onMessage((raw) => { if (JSON.parse(raw).type === "subscribeSession") subscribed = true; });
    });
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        const answer = (result) => route.fulfill({ json: { ok: true, result } });
        if (url.pathname.endsWith("/events-before") && url.search.includes("workflow.started")) return answer([log[0]]);
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return answer([{ seq: 1, eventType: "session.canvas_updated", data: { slot: 1, rev: 1, sizeBytes: html.length, name: "Workflow" } }]);
        }
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_data")) {
            return answer([{ seq: 2, eventType: "session.canvas_data", data: { slot: 1, dataRev: 1, payload: running } }]);
        }
        if (url.pathname.includes("/artifacts/") && url.pathname.includes("canvas.html")) {
            return route.fulfill({ contentType: "text/html", body: html });
        }
        if (url.pathname.endsWith("/management/sessions")) return answer({ sessions: [session], hasMore: false, nextCursor: null });
        if (url.pathname.endsWith("/sessions") && route.request().method() === "GET") return answer({ sessions: [session], hasMore: false });
        if (url.pathname.endsWith(`/sessions/${LIVE_ID}`)) return answer({ ...session, events: [], messages: [] });
        if (url.pathname.endsWith("/events")) return answer([]);
        return route.fallback();
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${LIVE_ID}`);

    const main = page.locator(".ps-workflow-main");
    const graphView = main.locator(".ps-workflow-graph");
    await expect(main.locator(".ps-workflow-status")).toHaveText("running");
    await expect(graphView.locator(".ps-workflow-node.is-done")).toHaveCount(1);
    await expect(graphView.locator(".ps-workflow-node.is-running")).toHaveCount(1);
    await expect(graphView.locator(".ps-workflow-node.is-running")).toContainText("summarize");
    await expect(graphView.locator(".ps-workflow-node.is-running")).toContainText("×2");
    // Batch 5 T8: every edge is drawn once React Flow has measured the steps, after a step is selected and after a tick.
    await flowReady(graphView);
    const liveEdges = edgeCount(log[0].data.states);
    await expectEdgesDrawn(graphView, liveEdges);
    await graphView.getByRole("button", { name: "Inspect summarize", exact: true }).click();
    const details = page.getByRole("region", { name: "Session canvas" }).locator(".ps-workflow-node-details");
    await expect(details.locator("h2")).toHaveText("summarize");
    await expect(details).toContainText("again → summarize");
    await expect(page.locator(".ps-canvas-pane iframe")).toHaveCount(0);
    await expectEdgesDrawn(graphView, liveEdges);
    await shot(page, "6-live-workflow-main-running");

    // A live tick: the run finishes.
    await expect.poll(() => subscribed).toBe(true);
    const done = foldWorkflowCanvasState([
        ...log,
        { eventType: "workflow.state_completed", data: { stateId: "summarize", step: 3, outcome: "done", resultSource: "reported", durationMs: 610, toolCalls: [] } },
        { eventType: "workflow.state_started", data: { stateId: "publish", step: 4 } },
        { eventType: "workflow.state_completed", data: { stateId: "publish", step: 4, outcome: "success", resultSource: "reported", durationMs: 300, toolCalls: [{ name: "write_artifact", ok: true }] } },
        { eventType: "workflow.completed", data: { name: "nightly-report", steps: 4, stateId: "published", outcome: "succeeded", summary: "Report published.", outputPreview: "{\"rows\":3}" } },
    ]);
    for (const socket of sockets) {
        socket.send(JSON.stringify({ type: "sessionEvent", sessionId: LIVE_ID, event: {
            sessionId: LIVE_ID, seq: 3, eventType: "session.canvas_data", createdAt: new Date().toISOString(),
            data: { slot: 1, dataRev: 2, payload: done },
        } }));
    }
    await expect(main.locator(".ps-workflow-status")).toHaveText("completed");
    await expect(graphView.locator(".ps-workflow-node.is-done")).toHaveCount(4);
    await expect(graphView.locator(".ps-workflow-node.is-running")).toHaveCount(0);
    await expectEdgesDrawn(graphView, liveEdges);
    await expect(details.locator("h2")).toHaveText("summarize");
    await graphView.getByRole("button", { name: "Inspect published", exact: true }).click();
    await expect(details.locator("h2")).toHaveText("published");
    await expect(details).toContainText("succeeded");
    await shot(page, "7-live-workflow-main-completed");
    expect(errors).toEqual([]);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`workflow graph, the step log in the side pane and node detail navigation at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await routeApi(page);
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
        const main = page.locator(".ps-workflow-main");
        await expect(main.locator(".ps-workflow-graph")).toBeVisible();
        // Batch 6 (r-3): the step log is a side-pane panel; the main pane never holds it, and it has no divider.
        await expect(main.locator(".ps-workflow-log")).toHaveCount(0);
        await expect(page.getByRole("separator", { name: "Resize the step log" })).toHaveCount(0);
        await main.getByRole("button", { name: "Step log", exact: true }).click();
        const sideLog = page.locator('.ps-workflow-side-panel[data-panel="log"]').filter({ visible: true });
        await expect(sideLog.locator(".ps-workflow-log .ps-chat-panel")).toBeVisible();
        await expect(main.locator(".ps-workflow-log")).toHaveCount(0);
        await expect(page.getByRole("separator", { name: "Resize the step log" })).toHaveCount(0);
        // A phone: back from the details layer to the graph.
        if (viewport.width < 920) await hideCanvas(page);
        await main.getByRole("button", { name: "Inspect collect", exact: true }).click();
        if (viewport.width < 920) {
            // On a phone a tap only selects the step and keeps the workflow on screen (flow-04), even for collect, the step
            // the view selects by default; a second tap on it opens its details.
            await expect(main.locator(".ps-workflow-graph")).toBeVisible();
            // The phone's hidden details layer is moved off screen by a transform (0.8.9: it keeps its state), so it is
            // still "visible" to a locator: what counts is that no step details are on screen.
            await expect.poll(() => detailsOnScreen(page)).toBe(0);
            await main.getByRole("button", { name: "Inspect collect", exact: true }).click();
        }
        const details = page.locator(".ps-workflow-node-details").filter({ visible: true });
        await expect(details.locator("h2")).toHaveText("collect");
        await expect(details).toContainText("read_facts");
        await details.getByRole("tab", { name: "Output", exact: true }).click();
        await expect(details.locator("pre")).toHaveText('{"count":3}');
        await shot(page, `node-details-${viewport.width}`);
        if (viewport.width < 920) {
            await hideCanvas(page);
            await expect(main.locator(".ps-workflow-graph")).toBeVisible();
        }
        await page.reload();
        await expect(main.locator(".ps-workflow-graph")).toBeVisible();
        await expect(page.locator(".ps-prompt-input")).toHaveCount(0);
        await shot(page, `workflow-main-${viewport.width}`);
        if (viewport.width < 920) {
            // Step details opens the step the view selects by default, with no tap first.
            await main.getByRole("button", { name: "Step details", exact: true }).click();
            await expect(page.locator(".ps-workflow-node-details").filter({ visible: true }).locator("h2")).toHaveText("collect");
        }
        expect(errors).toEqual([]);
    });
}

// of-03: the right-most pane (Step details beside the workflow) resizes. The seam between the workflow and Step details
// moves the pane at once while dragging, and the width is remembered for this session across a reload (the profile
// store below keeps what the page saves). The arrow keys move it by 24 pixels and stop at chat's floor without storing
// a width the screen cannot show, so the first key back moves it; a double-click puts it back at its opening width.
// With Diagnostics open too on a window too narrow for both opening widths, the seam moves itself (the canvas gives up
// the pixels) and Diagnostics keeps its width; it used to move the inner seam instead, or nothing at all, and a drag or
// keys toward the workflow grew the canvas over Diagnostics. A Diagnostics column a narrower window squeezed out gets
// its width back first. The zen chat rail's seam resets on a double-click.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "of-03" (from packages/app/web, after build).
const rightBlock = (page) => page.evaluate(() => {
    const width = (selector) => document.querySelector(selector)?.getBoundingClientRect().width ?? null;
    return {
        host: width(".ps-workspace-column-host"),
        canvas: width(".ps-canvas-layer:not(.is-hidden)"),
        diagnostics: width(".ps-workspace-column-host > .ps-workspace-column:not(.is-artifact)"),
        chat: width(".ps-workspace-main-grid > .ps-workspace-pane-slot:last-child"),
    };
});
/** A profile store for one test, so what the page saves comes back after a reload. Registered after routeApi: it answers first. */
async function routeProfile(page) {
    const store = { settings: {} };
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const pathname = new URL(req.url()).pathname;
        const reply = (result) => route.fulfill({ json: { ok: true, result } });
        if (pathname.endsWith("/me/profile/settings")) { store.settings = req.postDataJSON().settings; return reply({ profileSettings: store.settings }); }
        if (pathname.endsWith("/me/profile")) return reply({ isAdmin: false, profileSettings: store.settings });
        return route.fallback();
    });
    return store;
}
async function dragSeam(page, seam, dx, check = null) {
    const box = await seam.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y, { steps: 5 });
    if (check) await check();
    await page.mouse.move(x + dx, y, { steps: 5 });
    await page.mouse.up();
}

test("of-03: the Step details pane resizes by drag, keys and double-click at 1440px, and keeps its width after a reload", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeApi(page);
    const profile = await routeProfile(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const main = page.locator(".ps-workflow-main");
    await main.getByRole("button", { name: "Inspect collect", exact: true }).click();
    const details = page.locator(".ps-workflow-node-details").filter({ visible: true });
    await expect(details.locator("h2")).toHaveText("collect");
    const pane = async () => Math.round((await rightBlock(page)).canvas ?? 0);
    await expect.poll(pane).toBe(640);
    const seam = page.getByRole("button", { name: "Resize the right column", exact: true });
    // Both halves of the seam's grab band are the seam's, beside the workflow and beside Step details.
    const box = await seam.boundingBox();
    const hits = await page.evaluate(([cx, cy]) => [cx - 3, cx + 3]
        .map((px) => Boolean(document.elementFromPoint(px, cy)?.closest(".ps-column-resizer"))), [box.x + box.width / 2, box.y + box.height / 2]);
    expect(hits).toEqual([true, true]);

    // Drag: the pane follows the pointer while dragging, and 150 pixels to the left widen it by 150.
    await dragSeam(page, seam, -150, async () => { await expect.poll(pane).toBeGreaterThan(700); });
    await expect.poll(pane).toBeGreaterThanOrEqual(788);
    expect(await pane()).toBeLessThanOrEqual(792);
    // Step details fills the right side it was given: no empty strip beside it (of-03-A).
    const filled = await rightBlock(page);
    expect(filled.host - filled.canvas).toBeLessThanOrEqual(2);

    // Keys: one step each way.
    await seam.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(pane).toBeLessThanOrEqual(768);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(pane).toBeGreaterThanOrEqual(788);
    // Growing by keys stops at chat's floor, and the first key back moves the pane at once: nothing hidden was stored.
    for (let i = 0; i < 40; i += 1) await page.keyboard.press("ArrowLeft");
    const widest = await rightBlock(page);
    expect(widest.chat).toBeGreaterThanOrEqual(200);
    await page.keyboard.press("ArrowRight");
    await expect.poll(pane).toBeLessThanOrEqual(Math.round(widest.canvas) - 22);
    await expect(seam).toBeFocused();

    // Double-click: back to the opening width.
    await seam.dblclick();
    await expect.poll(pane).toBe(640);

    // Remembered: drag again, let the page save, reload, and the pane comes back at the dragged width.
    await dragSeam(page, seam, -150);
    await expect.poll(pane).toBeGreaterThanOrEqual(788);
    await expect.poll(() => profile.settings?.sessionViews?.[WORKFLOW_ID]?.desktop?.layout?.canvasPaneAdjust ?? 0).toBeGreaterThanOrEqual(148);
    await shot(page, "of-03-step-details-widened");
    await page.reload();
    await expect(details.locator("h2")).toHaveText("collect");
    await expect.poll(pane).toBeGreaterThanOrEqual(788);
    expect(await pane()).toBeLessThanOrEqual(792);
    expect(errors).toEqual([]);
});

test("of-03: with Diagnostics open on a narrow window the seam beside Step details moves itself, and Diagnostics keeps its width", async ({ page }) => {
    // The session list keeps its width beside an open column (0.8.9), so 1440px is already too narrow for both opening
    // widths: Diagnostics opens at about 190px. (At 1100px it is squeezed to 0px, the documented squeeze below the snap.)
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeApi(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    await page.locator(".ps-workflow-main").getByRole("button", { name: "Inspect collect", exact: true }).click();
    await expect(page.locator(".ps-workflow-node-details").filter({ visible: true }).locator("h2")).toHaveText("collect");
    await page.getByRole("button", { name: /Show diagnostics/i }).first().click();
    await expect.poll(async () => (await rightBlock(page)).diagnostics ?? 0).toBeGreaterThan(50);
    const before = await rightBlock(page);
    // The window cannot show both opening widths (640 + 320): the grid gives Diagnostics less than its own width.
    expect(before.diagnostics).toBeLessThan(318);
    const seam = page.getByRole("button", { name: "Resize the right column", exact: true });
    // Chat is at its floor, so neither a drag toward the workflow nor the arrow keys widen Step details, and Diagnostics
    // is never squeezed to make room (of-03-B: the canvas grew and Diagnostics went to 0 px).
    await dragSeam(page, seam, -150);
    await seam.focus();
    for (let i = 0; i < 12; i += 1) await page.keyboard.press("ArrowLeft");
    const held = await rightBlock(page);
    expect(Math.abs(held.diagnostics - before.diagnostics)).toBeLessThanOrEqual(3);
    expect(Math.abs(held.canvas - before.canvas)).toBeLessThanOrEqual(3);
    await dragSeam(page, seam, 100);
    await expect.poll(async () => before.host - ((await rightBlock(page)).host ?? 0)).toBeGreaterThanOrEqual(90);
    const after = await rightBlock(page);
    expect(before.canvas - after.canvas).toBeGreaterThanOrEqual(90);
    expect(Math.abs(after.diagnostics - before.diagnostics)).toBeLessThanOrEqual(3);
    await shot(page, "of-03-both-columns-narrow");
    expect(errors).toEqual([]);
});

test("of-03: Diagnostics squeezed by a narrower window gets its width back first when the seam beside Step details moves", async ({ page }) => {
    // Wide enough for both opening widths beside the session list, which keeps its width (0.8.9).
    await page.setViewportSize({ width: 1700, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeApi(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    await page.locator(".ps-workflow-main").getByRole("button", { name: "Inspect collect", exact: true }).click();
    await expect(page.locator(".ps-workflow-node-details").filter({ visible: true }).locator("h2")).toHaveText("collect");
    await page.getByRole("button", { name: /Show diagnostics/i }).first().click();
    await expect.poll(async () => (await rightBlock(page)).diagnostics ?? 0).toBeGreaterThan(300);
    const seam = page.getByRole("button", { name: "Resize the right column", exact: true });
    // Step details as wide as chat allows, then a narrower window: the grid squeezes Diagnostics out.
    await seam.focus();
    for (let i = 0; i < 30; i += 1) await page.keyboard.press("ArrowLeft");
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect.poll(async () => (await rightBlock(page)).diagnostics ?? 0).toBeLessThan(120);
    // Moving the seam does not remember the squeeze: Diagnostics takes back the pixels Step details gives up.
    await dragSeam(page, seam, 200);
    await expect.poll(async () => (await rightBlock(page)).diagnostics ?? 0).toBeGreaterThanOrEqual(150);
    expect(errors).toEqual([]);
});

// A workflow has no zen (batch 6, f-02), so the zen chat rail is exercised from a chat.
test("of-03: the zen chat rail resizes by drag and a double-click puts it back at 380px", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeApi(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    await page.getByRole("button", { name: "Show canvas", exact: true }).click();
    await page.getByRole("region", { name: "Session canvas" }).getByRole("button", { name: "Zen mode", exact: true }).click();
    const rail = async () => Math.round(await page.locator(".ps-workspace-main-grid").evaluate((element) => element.getBoundingClientRect().width));
    await expect.poll(rail).toBe(380);
    const seam = page.getByRole("button", { name: "Resize the zen chat rail", exact: true });
    await dragSeam(page, seam, 100);
    await expect.poll(rail).toBeGreaterThanOrEqual(470);
    await seam.dblclick();
    await expect.poll(rail).toBe(380);
    expect(errors).toEqual([]);
});

// READ-WIRE-02: a version 2 workflow whose authorized read model (GET /sessions/:id/workflow) cannot be read shows the
// failure beside its graph, drawn from its events, and Retry reads it again at once, in a mounted browser.
const V2_STATES = [
    { id: "poll", type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["changed", "unchanged"],
        next: { changed: "done", unchanged: "pause", failure: "failed" } },
    { id: "pause", type: "wait", seconds: 30, outcomes: ["elapsed"], next: { elapsed: "poll" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const V2_EVENTS = [{ sessionId: WORKFLOW_ID, seq: 1, eventType: "workflow.started", createdAt: new Date().toISOString(), data: {
    runId: "run-1", mode: "live", revision: 1, definitionHash: "hash-1", irSha256: "ir-1", name: "watch-v2", version: "1.0.0",
    initial: "poll", states: V2_STATES,
} }];
const V2_READ_MODEL = {
    workflowId: WORKFLOW_ID,
    definition: { state: "published", semver: "1.0.0", currentRevision: 1, publishedRevision: 1, publishedDefinitionHash: "hash-1" },
    revision: { revision: 1, definitionHash: "hash-1", valid: true, irSha256: "ir-1", name: "watch-v2", diagnostics: [] },
    graph: { revision: 1, initial: "poll", states: V2_STATES },
    runs: [{ runId: "run-1", mode: "live", status: "running", revision: 1, outcome: null }],
    run: { runId: "run-1", mode: "live", status: "running", outcome: null, terminalState: null, output: null, error: null, kvRevision: 1, kv: "{}",
        nodeExecutions: [{ nodeExecutionId: "nx-poll-1", stateId: "poll", ordinal: 1, state: "completed", outcome: "changed",
            resultKind: "business", winner: "controller", attempts: 0, kvRevision: 1 }],
        inbox: [], outbox: [] },
};

test("a v2 workflow's read model failure is shown beside its graph, and Retry reads it again", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let failReads = true;
    let reads = 0;
    await routeApi(page, {
        workflowEvents: V2_EVENTS,
        workflowState: { title: "Workflow: watch-v2", status: "running" },
        onReadWorkflow: (route) => {
            reads += 1;
            return failReads
                ? route.fulfill({ status: 503, json: { ok: false, error: { code: "SERVICE_UNAVAILABLE", message: "The workflow store is not reachable." } } })
                : route.fulfill({ json: { ok: true, result: V2_READ_MODEL } });
        },
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const main = page.locator(".ps-workflow-main");
    const graph = main.getByRole("group", { name: "Workflow graph" });
    // Batch 6 (r-3): the Notices button says there is an error; its panel in the side pane shows it, with Retry.
    const noticesButton = main.getByRole("button", { name: "Notices", exact: true });
    await expect(noticesButton.locator(".ps-workflow-tool-badge")).toHaveAttribute("data-level", "error");
    await noticesButton.click();
    const alert = page.locator('.ps-workflow-side-panel[data-panel="notices"] .ps-workflow-read-error');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(alert).toContainText("could not be read: The workflow store is not reachable.");
    await expect(graph.locator(".ps-workflow-node")).toHaveCount(4);
    await expect(graph).not.toContainText("Done · changed");
    await shot(page, "v2-read-model-failed");
    const failed = reads;
    expect(failed).toBeGreaterThan(0);
    failReads = false;
    await alert.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(alert).toHaveCount(0);
    await expect(graph).toContainText("Done · changed");
    expect(reads).toBeGreaterThan(failed);
    await shot(page, "v2-read-model-retried");
    expect(errors).toEqual([]);
});

// A person's workflow commands in the portal (adapted from the browser test design 090ad919-r1; design 04, 07; mocks M04,
// M16, M19; R17, R19, R26, R27; T116): the browser with a mocked backend (page.route stubs over the shared stub server), not
// a deployed stack, no model. Run stop confirm, dismiss and refusal at 1440 and 390 pixels with a keyboard pause; an
// unconfirmed pause retried with the same operation id; the virtual clock's checks and one exact advance; a workflow agent
// state's chat read-only beside an ordinary one; a lost draft save kept and resent unchanged.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "v2 commands:" (from packages/app/web, after build).
// The confirm modal's dialog role, modal marking, name, description and focus are asserted (owner decision q18 changed
// what a failed access read shows: "Could not check…" with Retry instead of the ordinary composer; owner decision q17
// added the dialog semantics).
const V2_COMMANDS_PATH = `/api/v1/sessions/${WORKFLOW_ID}/workflow/commands`;
/** A v2 read model that offers the person's run controls for run-1 (fixture contract: personCommands shape from
 *  workflowV2RunControls; everything else is the file's V2_READ_MODEL). */
const V2_WITH_CONTROLS = {
    ...V2_READ_MODEL,
    personCommands: { operations: ["pause", "resume", "stop", "cancel"], viewer: { allowed: true }, run: { runId: "run-1", stop: true } },
};

/** routeApi for a v2 workflow whose read model is `readModel()`, plus a command route that calls `onCommand`. */
async function routeV2(page, { readModel = () => V2_WITH_CONTROLS, onCommand, events = V2_EVENTS } = {}) {
    const reads = { count: 0 };
    await routeApi(page, {
        workflowEvents: events,
        workflowState: { title: "Workflow: watch-v2", status: "running" },
        onReadWorkflow: (route) => { reads.count += 1; return route.fulfill({ json: { ok: true, result: readModel() } }); },
    });
    const commands = [];
    await page.route(`**${V2_COMMANDS_PATH}`, async (route) => {
        const body = route.request().postDataJSON();
        commands.push(body.command);
        return onCommand(route, body.command, commands.length);
    });
    return { reads, commands };
}
const refuse = (route, status, code, message, details) =>
    route.fulfill({ status, json: { ok: false, error: { code, message, ...(details ? { details } : {}) } } });
const accept = (route, command, extra = {}) =>
    route.fulfill({ json: { ok: true, result: { operation: command.operation, runId: command.run_id, operationId: command.operation_id, ...extra } } });

// ------------------------------------------------------------------------------------------------------------
// B1 — run controls: review/confirm, dismiss sends nothing, confirmed stop sends one exact command, a 409 refusal
// keeps the server's reason (no Retry) and re-reads; pause needs no confirm. 1440 and 390.
// ------------------------------------------------------------------------------------------------------------
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`v2 commands: run controls confirm stop, keep a refusal's reason and re-read at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const { reads, commands } = await routeV2(page, {
            onCommand: (route, command) => command.operation === "stop"
                ? refuse(route, 409, "RUN_NOT_ACTIVE", "The run already ended.")
                : accept(route, command, { status: "paused" }),
        });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
        const main = page.locator(".ps-workflow-main");
        const controls = main.getByRole("group", { name: "Run controls", exact: true });
        await expect(controls).toBeVisible();
        await expect(controls).toHaveAttribute("data-run-id", "run-1");
        // A running run offers Pause, Stop, Cancel (not Resume), each an icon button named by its old text (of-04) and
        // enabled with its explanation, which its tooltip shows.
        await expect(controls.getByRole("button")).toHaveCount(3);
        for (const [index, name] of ["Pause", "Stop", "Cancel"].entries()) {
            await expect(controls.getByRole("button").nth(index)).toHaveAttribute("aria-label", name);
        }
        await expect(controls.locator('[data-operation="stop"]')).toHaveAttribute("data-title", /^Stop the run gracefully/);
        await expect(controls.locator('[data-operation="cancel"]')).toHaveClass(/is-danger/);
        // Hover and keyboard focus show the tooltip: the name and the explanation.
        await controls.locator('[data-operation="stop"]').hover();
        await expect(page.locator(".ps-icon-tooltip")).toHaveText(/^Stop — Stop the run gracefully/);
        await page.mouse.move(0, 0);
        await expect(page.locator(".ps-icon-tooltip")).toHaveCount(0);
        await controls.locator('[data-operation="pause"]').focus();
        await page.keyboard.press("Tab");
        await expect(page.locator(".ps-icon-tooltip")).toHaveText(/^Stop/);
        await page.keyboard.press("Escape");
        await expect(page.locator(".ps-icon-tooltip")).toHaveCount(0);

        // Review: Stop opens the confirm dialog with the run named; dismissing it sends nothing (negative control).
        await controls.getByRole("button", { name: "Stop", exact: true }).click();
        const dialog = page.locator(".ps-modal.is-narrow");
        await expect(dialog.locator(".ps-modal-title")).toHaveText("Stop Workflow Run");
        await expect(dialog.locator(".ps-modal-body p")).toHaveText("Stop run run-1? No new step starts; work already started may finish until its grace period ends, and then the run ends as stopped. A stop does not undo effects that already happened.");
        // The confirm box is a dialog for screen readers (owner decision q17): named by its title, described by its
        // message, modal, and focused while it is open.
        const named = page.getByRole("dialog", { name: "Stop Workflow Run", exact: true });
        await expect(named).toHaveAttribute("aria-modal", "true");
        await expect(named).toHaveAccessibleDescription(/^Stop run run-1\? No new step starts/);
        await expect(named).toBeFocused();
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        // Focus goes back to the control that opened it.
        await expect(controls.getByRole("button", { name: "Stop", exact: true })).toBeFocused();
        expect(commands).toEqual([]);

        // Confirm: exactly one stop command for run-1, with a UI operation id.
        const readsBefore = reads.count;
        await controls.getByRole("button", { name: "Stop", exact: true }).click();
        await dialog.getByRole("button", { name: "Stop Run", exact: true }).click();
        const notice = page.locator(".ps-workflow-run-command-notice");
        await expect(notice).toHaveAttribute("role", "alert");
        await expect(notice).toHaveAttribute("data-level", "error");
        await expect(notice.locator("span").first()).toHaveText("Stop was refused for run run-1: The run already ended.");
        await expect(notice.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
        expect(commands).toHaveLength(1);
        expect(commands[0]).toEqual({ operation: "stop", operation_id: expect.stringMatching(/^ui-stop-/), run_id: "run-1" });
        // A 409 reads the workflow again so the view shows what the server saw.
        await expect.poll(() => reads.count).toBeGreaterThan(readsBefore);
        await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
        await expect(notice).toHaveCount(0);
        // On a phone the refusal came up in the details layer (r-3); back to the workflow and its run controls.
        if (viewport.width < 920) await hideCanvas(page);

        // Positive control + keyboard: Pause needs no confirm; Enter on the focused native button sends one pause.
        await controls.getByRole("button", { name: "Pause", exact: true }).focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => commands.length).toBe(2);
        expect(commands[1]).toEqual({ operation: "pause", operation_id: expect.stringMatching(/^ui-pause-/), run_id: "run-1" });
        expect(commands[1].operation_id).not.toBe(commands[0].operation_id);
        await expect(page.locator(".ps-modal.is-narrow")).toHaveCount(0);
        await expect(notice).toHaveCount(0);
        await shot(page, `v2-run-controls-${viewport.width}`);
        expect(errors).toEqual([]);
    });
}

// ------------------------------------------------------------------------------------------------------------
// B2 — a lost answer: while pending every control is disabled with the server-side reason; a 503 is "unconfirmed";
// Retry sends the SAME command with the SAME operation id and the server's replay clears the notice.
// ------------------------------------------------------------------------------------------------------------
test("v2 commands: an unconfirmed pause is retried with the same operation id, never as a second command", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const { commands } = await routeV2(page, {
        onCommand: async (route, command, n) => {
            if (n === 1) { await held; return refuse(route, 503, "SERVICE_UNAVAILABLE", "The workflow store is not reachable."); }
            return accept(route, command, { status: "paused", replayed: true });
        },
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const main = page.locator(".ps-workflow-main");
    const controls = main.getByRole("group", { name: "Run controls", exact: true });
    await controls.getByRole("button", { name: "Pause", exact: true }).click();

    // Pending: the sent control shows its pending label; every control is disabled and says why; the group is busy.
    await expect(controls.locator('[data-operation="pause"]')).toHaveAttribute("aria-label", "Pausing…");
    await expect(controls).toHaveAttribute("aria-busy", "true");
    await expect(controls.locator('[data-operation="pause"]')).toBeDisabled();
    await expect(controls.locator('[data-operation="pause"]')).toHaveAttribute("data-title", "This command is being sent.");
    await expect(controls.locator('[data-operation="cancel"]')).toBeDisabled();
    await expect(controls.locator('[data-operation="cancel"]')).toHaveAttribute("data-title", "Another command for this workflow is being sent.");
    release();

    const notice = page.locator(".ps-workflow-run-command-notice");
    await expect(notice).toHaveAttribute("data-level", "warning");
    await expect(notice.locator("span").first()).toHaveText(
        "Pause for run run-1 may not have reached the workflow: The workflow store is not reachable. Retry sends the same command again.");
    await expect(controls.locator('[data-operation="pause"]')).toBeEnabled();
    await notice.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(notice).toHaveCount(0);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]); // same operation, run and operation id: the server de-duplicates
    expect(commands[0]).toEqual({ operation: "pause", operation_id: expect.stringMatching(/^ui-pause-/), run_id: "run-1" });
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// B3 — a test run's virtual clock: a value outside 1..2592000 is refused in the page (no request); a valid advance
// sends exactly {operation:test_advance, run_id, seconds}; a 4xx refusal keeps its reason in the notice.
// ------------------------------------------------------------------------------------------------------------
const V2_TEST_EVENTS = [{ ...V2_EVENTS[0], data: { ...V2_EVENTS[0].data, mode: "test" } }];
const V2_TEST_MODEL = {
    ...V2_READ_MODEL,
    runs: [{ runId: "run-1", mode: "test", status: "running", revision: 1, outcome: null }],
    run: { ...V2_READ_MODEL.run, mode: "test", test: { interceptions: [], virtualClock: { elapsedSeconds: 0 } } },
    personCommands: { operations: ["test_advance"], viewer: { allowed: true } },
};
test("v2 commands: the virtual clock refuses an invalid advance locally and sends one exact advance", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { commands } = await routeV2(page, {
        events: V2_TEST_EVENTS,
        readModel: () => V2_TEST_MODEL,
        onCommand: (route, command, n) => n === 1
            ? accept(route, command, { seconds: command.seconds, decided: [] })
            : refuse(route, 409, "TEST_CLOCK_CONFLICT_ANY", "The test run ended."),
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const main = page.locator(".ps-workflow-main");
    // Batch 6 (r-3): the Test calls panel is in the side pane.
    const clock = page.getByRole("group", { name: "Virtual clock", exact: true });
    // Batch 5 (g-03): the clock is with the test run's calls, behind the Test calls button.
    await expect(clock).toHaveCount(0);
    await main.getByRole("button", { name: "Test calls", exact: true }).click();
    await expect(clock).toBeVisible();
    await expect(clock).toContainText("Script clocks are real.");
    // No run controls are offered: the model offers only test_advance (negative control for B1's group).
    await expect(main.getByRole("group", { name: "Run controls", exact: true })).toHaveCount(0);

    const seconds = clock.getByRole("spinbutton", { name: "Seconds to advance", exact: true });
    for (const bad of ["0", "2592001", "1.5"]) {
        await seconds.fill(bad);
        await clock.getByRole("button", { name: "Advance", exact: true }).click();
        await expect(clock.getByRole("alert")).toHaveText("Advance by a whole number of seconds from 1 to 2592000.");
    }
    expect(commands).toEqual([]);

    await seconds.fill("120");
    await seconds.press("Tab");
    await page.keyboard.press("Enter"); // focus is now on the Advance button (next tabbable in the group)
    await expect.poll(() => commands.length).toBe(1);
    expect(commands[0]).toEqual({ operation: "test_advance", operation_id: expect.stringMatching(/^ui-test_advance-/), run_id: "run-1", seconds: 120 });
    await expect(clock.getByRole("alert")).toHaveCount(0);

    // A refusal is shown with the server's reason (generic code: the mapping is not code-specific).
    await clock.getByRole("button", { name: "Advance", exact: true }).click();
    const notice = page.locator(".ps-workflow-run-command-notice");
    await expect(notice.locator("span").first()).toHaveText("The clock advance was refused for run run-1: The test run ended.");
    expect(commands).toHaveLength(2);
    expect(commands[1].operation_id).not.toBe(commands[0].operation_id);
    expect(errors).toEqual([]);
});

// Batch 5 (g-03): the pane opens with its header and the graph only; the step log, the run's activity, the notices and a
// test run's calls each open and close from their own icon button (aria-expanded), Notices with its count tinted by its
// most serious notice. The test run here has started, so it has activity ("Test run started"; T8: the run's activity is
// shown whenever the run has any, as before batch 5, not only once it ended).
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "graph only" (from packages/app/web, after build).
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`the workflow pane opens with the graph only, and each panel opens in the side pane from its own button, at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await routeV2(page, { events: V2_TEST_EVENTS, readModel: () => V2_TEST_MODEL, onCommand: (route, command) => accept(route, command) });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
        const main = page.locator(".ps-workflow-main");
        await expect(main.getByRole("group", { name: "Workflow graph" })).toBeVisible();
        for (const selector of [".ps-workflow-log", ".ps-workflow-banners", ".ps-workflow-test-calls", ".ps-workflow-run-activity", ".ps-workflow-side-panel"]) {
            await expect(main.locator(selector)).toHaveCount(0);
        }
        await shot(page, `graph-only-${viewport.width}`);
        const desktop = viewport.width >= 920;
        for (const [name, panel, selector] of [["Step log", "log", ".ps-workflow-log"], ["Run activity", "activity", ".ps-workflow-run-activity"],
            ["Notices", "notices", ".ps-workflow-banners"], ["Test calls", "calls", ".ps-workflow-test-calls"]]) {
            const button = main.getByRole("button", { name, exact: true });
            await expect(button).toHaveAttribute("aria-expanded", "false");
            await button.click();
            const shown = page.locator(`.ps-workflow-side-panel[data-panel="${panel}"]`).filter({ visible: true });
            await expect(shown).toBeVisible();
            await expect(shown.locator("h2")).toHaveText(name);
            await expect(shown.getByRole("button", { name: "Back to Step details", exact: true })).toBeVisible();
            await expect(shown.locator(selector)).toBeVisible();
            // One panel at a time, never in the main pane.
            await expect(page.locator(".ps-workflow-side-panel").filter({ visible: true })).toHaveCount(1);
            await expect(main.locator(selector)).toHaveCount(0);
            if (name === "Run activity") await expect(shown.locator(selector)).toContainText("Activity of this run (1)");
            if (desktop) {
                // Pressed only while the side pane shows it; a second press goes back to Step details.
                await expect(button).toHaveAttribute("aria-expanded", "true");
                await button.click();
                await expect(button).toHaveAttribute("aria-expanded", "false");
                await expect(shown).toHaveCount(0);
                await expect(page.locator(".ps-workflow-node-details").filter({ visible: true })).toBeVisible();
            } else {
                // A phone: the details layer shows the panel; Back to Step details shows the step, and the toolbar returns to
                // the graph.
                await shown.getByRole("button", { name: "Back to Step details", exact: true }).click();
                await expect(shown).toHaveCount(0);
                await hideCanvas(page);
                await expect(main.getByRole("group", { name: "Workflow graph" })).toBeVisible();
            }
        }
        const badge = main.getByRole("button", { name: "Notices", exact: true }).locator(".ps-workflow-tool-badge");
        await expect(badge).toHaveText(/^[1-9]\d*$/);
        await expect(badge).toHaveAttribute("data-level", "warning");
        expect(errors).toEqual([]);
    });
}

// Batch 5 (g-06, g-07): with no run, "No run yet" is said once (the status; no run picker, no notice repeating it), and
// the empty step log says "No step output yet." instead of the splash art.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "said once" (from packages/app/web, after build).
const NO_RUN_MODEL = { ...V2_READ_MODEL, runs: [], run: null };
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`with no run 'No run yet' is said once, and an empty step log says so in words, at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await routeV2(page, { events: [], readModel: () => NO_RUN_MODEL, onCommand: (route, command) => accept(route, command) });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
        const main = page.locator(".ps-workflow-main");
        await expect(main.getByRole("group", { name: "Workflow graph" })).toBeVisible();
        await expect(main.locator(".ps-workflow-status")).toHaveText("No run yet");
        await expect(main.getByRole("combobox", { name: "Workflow run" })).toHaveCount(0);
        await expect(main.getByRole("button", { name: "Notices", exact: true })).toHaveCount(0);
        // Said once in the workflow pane (checked before the step log, which covers the pane on a phone).
        await expect(main.getByText(/No runs? yet/)).toHaveCount(1);
        await main.getByRole("button", { name: "Step log", exact: true }).click();
        // Batch 6 (r-3): the step log is a side-pane panel.
        const log = page.locator('.ps-workflow-side-panel[data-panel="log"] .ps-workflow-log').filter({ visible: true });
        await expect(log).toContainText("No step output yet.");
        await expect(log).not.toContainText("No messages yet.");
        await expect(log.locator(".is-splash-desktop, .is-splash-mobile")).toHaveCount(0);
        if (viewport.width >= 920) await expect(main.getByText(/No runs? yet/)).toHaveCount(1);
        await shot(page, `no-run-${viewport.width}`);
        expect(errors).toEqual([]);
    });
}

// ------------------------------------------------------------------------------------------------------------
// of-07 — one theme-consistent style for the workflow screen's edit boxes: the variables form's Name and Value boxes
// have the theme's background, text colour and shared corner radius; the JSON Value box is monospace; a value that
// does not parse is marked aria-invalid with the problem under the box (its accessible description) and nothing is
// sent; valid JSON clears the mark; focus shows the ring.
// ------------------------------------------------------------------------------------------------------------
test("v2 commands: the workflow screen's edit boxes share one theme style and mark invalid JSON under the box (of-07)", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { commands } = await routeV2(page, {
        readModel: () => ({ ...V2_WITH_CONTROLS,
            personCommands: { ...V2_WITH_CONTROLS.personCommands, operations: [...V2_WITH_CONTROLS.personCommands.operations, "set_vars"] } }),
        onCommand: (route, command) => accept(route, command),
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const main = page.locator(".ps-workflow-main");
    await main.getByRole("button", { name: "Variables", exact: true }).click();
    // Batch 6 (r-3): the Variables panel is in the side pane.
    const form = page.getByRole("form", { name: "Set or remove a variable", exact: true });
    const name = form.getByRole("textbox", { name: "Name", exact: true });
    const value = form.getByRole("textbox", { name: "Value (JSON)", exact: true });
    await expect(name).toHaveClass(/\bps-workflow-input\b/);
    await expect(value).toHaveClass(/\bps-workflow-input\b.*\bis-code\b/);
    const theme = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.background = "var(--ps-background)";
        probe.style.color = "var(--ps-foreground)";
        document.body.appendChild(probe);
        const style = getComputedStyle(probe);
        const out = { background: style.backgroundColor, color: style.color };
        probe.remove();
        return out;
    });
    const look = (element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color, radius: style.borderTopLeftRadius, font: style.fontFamily, shadow: style.boxShadow };
    };
    for (const box of [name, value]) {
        const style = await box.evaluate(look);
        expect(style.background).toBe(theme.background);
        expect(style.color).toBe(theme.color);
        expect(style.radius).toBe("6px");
    }
    expect((await value.evaluate(look)).font).toMatch(/mono/i);

    await name.fill("limit");
    await value.fill("{oops");
    await expect(value).toHaveAttribute("aria-invalid", "true");
    const problem = form.locator(".ps-workflow-field-error");
    await expect(problem).toHaveText(/^The value is not valid JSON: /);
    await expect(value).toHaveAccessibleDescription(/^The value is not valid JSON: /);
    expect(commands).toEqual([]);
    await value.fill("3");
    await expect(problem).toHaveCount(0);
    expect(await value.getAttribute("aria-invalid")).toBeNull();
    await value.focus();
    expect((await value.evaluate(look)).shadow).not.toBe("none");
    await shot(page, "v2-edit-boxes");
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// B4 — a workflow agent state's child chat is read-only in the rendered DOM with the server's reason; the ordinary
// agent session (positive control) keeps its prompt input; no prompt request is sent from the read-only one.
// 1440 and 390.
// Source: web-app.js SessionComposer / main composer: readOnly when access.canSendPrompt === false; text =
// workflowInputNote(access) = `${workflowInput.reason} Its controlling agent is session ${shortSessionId(controllingSessionId)}.`;
// access from GET /api/v1/sessions/:id/access (protocol getSessionAccess). An ordinary session: the stub answers
// {ok:true} with no flags (not denied).
// ------------------------------------------------------------------------------------------------------------
const CHILD_ID = "99999999-2222-3333-4444-555555555555";
const CHILD_REASON = "This session runs a step of a workflow. People cannot send it prompts, answers or instructions; message the workflow's parent agent instead.";
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`v2 commands: a workflow agent state's chat is read-only with the server's reason; an ordinary chat is not, at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await routeApi(page);
        const child = { sessionId: CHILD_ID, title: "Workflow step: review", status: "idle", model: "test:test-model",
            parentSessionId: WORKFLOW_ID, createdAt: now - 10_000, updatedAt: now - 10_000 };
        const sessions = [...SESSIONS, child];
        const prompts = [];
        await page.route("**/api/v1/**", async (route) => {
            const req = route.request();
            const pathname = new URL(req.url()).pathname;
            const answer = (result) => route.fulfill({ json: { ok: true, result } });
            if (pathname.endsWith("/management/sessions")) return answer({ sessions, hasMore: false, nextCursor: null });
            if (pathname.endsWith("/sessions") && req.method() === "GET") return answer({ sessions, hasMore: false });
            if (pathname.endsWith(`/sessions/${CHILD_ID}/access`)) {
                return answer({ sessionId: CHILD_ID, rootSessionId: AGENT_ID, canWrite: true, canManage: true, canSendPrompt: false, canAnswer: false,
                    canSteer: false, workflowInput: { reason: CHILD_REASON, workflowSessionId: WORKFLOW_ID, controllingSessionId: AGENT_ID } });
            }
            if (pathname.includes(`/sessions/${CHILD_ID}/events`)) return answer([]);
            if (pathname.endsWith(`/sessions/${CHILD_ID}`)) return answer({ ...child, events: [], messages: [] });
            // protocol.js: sendMessage POST /sessions/:id/messages, sendAnswer POST /sessions/:id/answers,
            // steerSessionTurn POST /management/sessions/:id/steer. Recorded only; any such call fails the test below.
            if (req.method() === "POST" && (pathname.endsWith(`/sessions/${CHILD_ID}/messages`) || pathname.endsWith(`/sessions/${CHILD_ID}/answers`)
                || pathname.endsWith(`/management/sessions/${CHILD_ID}/steer`))) prompts.push(pathname);
            return route.fallback();
        });

        await page.goto(`http://127.0.0.1:${stub.port}/?session=${CHILD_ID}`);
        const readonly = page.locator(".ps-composer-readonly").filter({ visible: true });
        await expect(readonly).toHaveText(`${CHILD_REASON} Its controlling agent is session ${AGENT_ID.slice(0, 8)}.`);
        await expect(page.locator(".ps-prompt-input")).toHaveCount(0);
        await expect(page.locator(".ps-chat-composer.is-workflow")).toHaveCount(0); // a child chat is not a workflow session
        await shot(page, `v2-child-readonly-${viewport.width}`);

        // Positive control: the ordinary agent session in the same page keeps its prompt input.
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
        await expect(page.locator(".ps-prompt-input").filter({ visible: true })).toBeVisible();
        await expect(page.locator(".ps-composer-readonly").filter({ visible: true })).toHaveCount(0);
        expect(prompts).toEqual([]);
        expect(errors).toEqual([]);
    });
}

// Owner decision q18: a session that may be a workflow step waits for the server's word; a failed access read shows that
// it could not check, with Retry, and no message box; Retry reads again and the server's answer decides.
test("v2 commands: a failed access check says it could not check, with Retry, and no message box until the server answers", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeApi(page);
    const child = { sessionId: CHILD_ID, title: "Workflow step: review", status: "idle", model: "test:test-model",
        parentSessionId: WORKFLOW_ID, createdAt: now - 10_000, updatedAt: now - 10_000 };
    const sessions = [...SESSIONS, child];
    let accessReads = 0;
    let failAccess = true;
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const pathname = new URL(req.url()).pathname;
        const answer = (result) => route.fulfill({ json: { ok: true, result } });
        if (pathname.endsWith("/management/sessions")) return answer({ sessions, hasMore: false, nextCursor: null });
        if (pathname.endsWith("/sessions") && req.method() === "GET") return answer({ sessions, hasMore: false });
        if (pathname.endsWith(`/sessions/${CHILD_ID}/access`)) {
            accessReads += 1;
            if (failAccess) return route.fulfill({ status: 503, json: { ok: false, error: { code: "UNAVAILABLE", message: "try later" } } });
            return answer({ sessionId: CHILD_ID, rootSessionId: AGENT_ID, canWrite: true, canManage: true, canSendPrompt: false, canAnswer: false,
                canSteer: false, workflowInput: { reason: CHILD_REASON, workflowSessionId: WORKFLOW_ID, controllingSessionId: AGENT_ID } });
        }
        if (pathname.includes(`/sessions/${CHILD_ID}/events`)) return answer([]);
        if (pathname.endsWith(`/sessions/${CHILD_ID}`)) return answer({ ...child, events: [], messages: [] });
        return route.fallback();
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${CHILD_ID}`);
    const readonly = page.locator(".ps-composer-readonly").filter({ visible: true });
    await expect(readonly).toHaveText("Could not check whether you can send messages here. Retry");
    await expect(readonly).toHaveAttribute("role", "alert");
    await expect(page.locator(".ps-prompt-input").filter({ visible: true })).toHaveCount(0);
    const failedReads = accessReads;
    failAccess = false;
    await readonly.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(readonly).toHaveText(`${CHILD_REASON} Its controlling agent is session ${AGENT_ID.slice(0, 8)}.`);
    expect(accessReads).toBeGreaterThan(failedReads);
    await expect(page.locator(".ps-prompt-input").filter({ visible: true })).toHaveCount(0);
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// B5 — draft edit whose save answer is lost: the edit is kept, the notice offers Retry, and Retry sends the SAME
// replace_definition (same operation id, expected_revision and YAML); the replayed receipt and the new read model
// (revision 2) settle the editor. Negative control: an unchanged draft cannot be saved (button disabled, reason title).
// Source: workflow-workspace.js the YAML tab (batch 6, r-2) / workflow-v2-panels.js WorkflowV2DraftEditor
// (section aria-label "Draft editor" data-revision; textarea aria-label "Workflow YAML"; button
// [data-operation=replace_definition] "Save draft"/"Saving…", title = reason; status "Unsaved changes");
// workflow-v2-commands.js workflowV2DraftEditor (needs definition.state "draft", personCommands.draft
// {revision, yaml, definitionHash} and operations incl. replace_definition), workflowV2DraftEdit ("Nothing changed."),
// workflowV2RunCommandWire (definition command: operation, operation_id, expected_revision, yaml), NOTICE_LABELS
// replace_definition = "Saving the draft" (no run target).
// Fixture contract note: the file's V2_READ_MODEL run is kept so the graph renders; a draft definition with a run is a
// fixture simplification, not a product claim.
// ------------------------------------------------------------------------------------------------------------
const DRAFT_YAML_1 = "apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: watch-v2, version: 1.0.0 }\n";
const DRAFT_YAML_2 = `${DRAFT_YAML_1}# edited\n`;
const draftModel = (revision, yaml) => ({
    ...V2_READ_MODEL,
    definition: { state: "draft", semver: "1.0.0", currentRevision: revision, publishedRevision: null, publishedDefinitionHash: null },
    personCommands: { operations: ["replace_definition"], viewer: { allowed: true }, draft: { revision, definitionHash: `hash-${revision}`, yaml } },
});
test("v2 commands: a draft save whose answer is lost keeps the edit and Retry sends the same replace_definition", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let saved = false;
    const { commands } = await routeV2(page, {
        readModel: () => saved ? draftModel(2, DRAFT_YAML_2) : draftModel(1, DRAFT_YAML_1),
        onCommand: (route, command, n) => {
            if (n === 1) return route.abort("failed"); // no answer: the browser cannot know whether it was stored
            saved = true;
            return route.fulfill({ json: { ok: true, result: { revision: 2, valid: true, diagnostics: [], replayed: true } } });
        },
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const main = page.locator(".ps-workflow-main");
    // Batch 6 (r-2): the draft is edited in the YAML tab (it was the "Edit draft" panel).
    const yamlTab = main.getByRole("tablist", { name: "Workflow view" }).getByRole("tab", { name: "YAML", exact: true });
    await expect(yamlTab).toHaveAttribute("aria-selected", "false");
    await yamlTab.click();
    await expect(yamlTab).toHaveAttribute("aria-selected", "true");
    const editor = main.getByRole("region", { name: "Draft editor", exact: true });
    await expect(editor).toHaveAttribute("data-revision", "1");
    const save = editor.locator('[data-operation="replace_definition"]');
    // Negative control: nothing changed -> cannot save, and the title says why.
    await expect(save).toBeDisabled();
    await expect(save).toHaveAttribute("title", "Nothing changed.");

    const yaml = editor.getByRole("textbox", { name: "Workflow YAML", exact: true });
    await yaml.fill(DRAFT_YAML_2);
    await expect(editor.getByRole("status")).toHaveText("Unsaved changes");
    await expect(save).toBeEnabled();
    await save.click();

    const notice = page.locator(".ps-workflow-run-command-notice");
    await expect(notice).toHaveAttribute("data-level", "warning");
    await expect(notice.locator("span").first()).toHaveText(/^Saving the draft may not have reached the workflow: .+ Retry sends the same command again\.$/);
    await expect(yaml).toHaveValue(DRAFT_YAML_2); // the edit survives the lost answer
    expect(commands).toEqual([{ operation: "replace_definition", operation_id: expect.stringMatching(/^ui-replace_definition-/), expected_revision: 1, yaml: DRAFT_YAML_2 }]);

    await notice.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(notice).toHaveCount(0);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    await expect(editor).toHaveAttribute("data-revision", "2"); // the new read model's revision is taken (edit == saved yaml)
    await expect(yaml).toHaveValue(DRAFT_YAML_2);
    await expect(save).toBeDisabled();
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// Batch 6 (f-03): step boxes can be moved, and where a person put them is kept in their profile (workflowLayouts,
// keyed by the workflow's session). Moving a box redraws the edges that touch it as curves between the boxes; edges
// between unmoved boxes keep their route. One profile save after the drop; a reload puts the box where it was dropped;
// Reset layout (only once a box moved) puts every box back and the next save has no entry for the workflow; Fit to
// screen fits the boxes where they are. A new revision keeps the places of steps it still has, a new step takes its
// automatic place, and a removed step's place is dropped on the next save.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "f-03:" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
/** The profile, kept for one test: every save the page makes is recorded, and a reload reads the last one back. */
async function routeProfileSaves(page) {
    const profile = { stored: {}, saves: [] };
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const pathname = new URL(req.url()).pathname;
        const reply = (result) => route.fulfill({ json: { ok: true, result } });
        if (pathname.endsWith("/me/profile/settings")) {
            profile.stored = req.postDataJSON().settings;
            profile.saves.push(profile.stored);
            return reply({ profileSettings: profile.stored });
        }
        if (pathname.endsWith("/me/profile")) return reply({ isAdmin: false, profileSettings: profile.stored });
        return route.fallback();
    });
    return profile;
}
const flowNodeAt = (graph, id) => graph.locator(`.react-flow__node[data-id="${id}"]`).evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, width: element.offsetWidth, height: element.offsetHeight };
});
const edgePath = (graph, from, to) => graph.locator(`.ps-workflow-edge[data-from="${from}"][data-to="${to}"] .ps-workflow-edge-path`).getAttribute("d");
const edgeLabelAt = (graph, from, to) => graph.locator(`.ps-workflow-edge[data-from="${from}"][data-to="${to}"] .ps-workflow-edge-label`)
    .evaluate(element => { const matrix = element.transform.baseVal.consolidate()?.matrix; return { x: matrix?.e ?? 0, y: matrix?.f ?? 0 }; });
const pathEnds = d => {
    const numbers = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    return { start: { x: numbers[0], y: numbers[1] }, end: { x: numbers[numbers.length - 2], y: numbers[numbers.length - 1] } };
};
async function dragStep(page, graph, id, dx, dy) {
    const box = await graph.getByRole("button", { name: `Inspect ${id}`, exact: true }).boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
    await page.mouse.move(x + dx, y + dy, { steps: 4 });
    await page.mouse.up();
}
const LAYOUT_KEY = `session:${WORKFLOW_ID}`;
const placesSaved = (profile) => profile.saves.filter(settings => settings?.workflowLayouts?.[LAYOUT_KEY]);
const without = (settings, key) => Object.fromEntries(Object.entries(settings || {}).filter(([name]) => name !== key));
const REV2_STATES = [
    { id: "poll", type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["changed", "unchanged"],
        next: { changed: "review", unchanged: "pause" } },
    { id: "pause", type: "wait", seconds: 30, outcomes: ["elapsed"], next: { elapsed: "poll" } },
    { id: "review", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["ok"], next: { ok: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
];

test("f-03: a moved step is saved once in the profile, comes back after a reload, and Reset layout puts it back", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let model = V2_READ_MODEL;
    await routeV2(page, { readModel: () => model, onCommand: (route, command) => accept(route, command) });
    const profile = await routeProfileSaves(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const graph = page.locator(".ps-workflow-main").getByRole("group", { name: "Workflow graph" });
    await flowReady(graph);
    await settledView(graph);
    const controls = graph.getByRole("group", { name: "Graph view", exact: true });
    // Reset layout is offered only once a box has moved.
    await expect(controls.getByRole("button", { name: "Reset layout", exact: true })).toHaveCount(0);
    const automatic = await flowNodeAt(graph, "pause");
    const untouched = { done: await edgePath(graph, "poll", "done"), failed: await edgePath(graph, "poll", "failed") };
    const into = await edgePath(graph, "poll", "pause");
    const before = profile.saves.at(-1) ?? null;

    // Drag "pause" 120px right: the box moves; the edges that touch it follow it as curves; the others keep their route.
    await dragStep(page, graph, "pause", 120, 0);
    const placed = await flowNodeAt(graph, "pause");
    expect(placed.x).toBeGreaterThan(automatic.x + 20);
    expect(Math.abs(placed.y - automatic.y)).toBeLessThan(2);
    await expect.poll(() => edgePath(graph, "poll", "pause")).not.toBe(into);
    expect(await edgePath(graph, "poll", "done")).toBe(untouched.done);
    expect(await edgePath(graph, "poll", "failed")).toBe(untouched.failed);
    // The edge into it ends at its top centre and the edge out of it starts at its bottom centre; the label is at the middle.
    const inbound = pathEnds(await edgePath(graph, "poll", "pause"));
    expect(Math.abs(inbound.end.x - (placed.x + placed.width / 2))).toBeLessThan(3);
    expect(Math.abs(inbound.end.y - placed.y)).toBeLessThan(12);
    const outbound = pathEnds(await edgePath(graph, "pause", "poll"));
    expect(Math.abs(outbound.start.x - (placed.x + placed.width / 2))).toBeLessThan(3);
    expect(Math.abs(outbound.start.y - (placed.y + placed.height))).toBeLessThan(12);
    const label = await edgeLabelAt(graph, "poll", "pause");
    expect(Math.abs(label.x - (inbound.start.x + inbound.end.x) / 2)).toBeLessThan(6);
    expect(Math.abs(label.y - (inbound.start.y + inbound.end.y) / 2)).toBeLessThan(6);
    await expect(controls.getByRole("button", { name: "Reset layout", exact: true })).toBeVisible();

    // One save after the drop, carrying the place as whole pixels; the other profile keys are as they were.
    await page.waitForTimeout(1_000);
    expect(placesSaved(profile)).toHaveLength(1);
    const saved = placesSaved(profile)[0];
    const place = saved.workflowLayouts[LAYOUT_KEY].steps.pause;
    expect(place).toEqual([Math.round(placed.x), Math.round(placed.y)]);
    expect(Object.keys(saved.workflowLayouts[LAYOUT_KEY].steps)).toEqual(["pause"]);
    if (before) expect(without(saved, "workflowLayouts")).toEqual(without(before, "workflowLayouts"));
    await shot(page, "f03-step-moved");

    // Reload: the box is where it was dropped, from the profile.
    await page.reload();
    await flowReady(graph);
    const reloaded = await flowNodeAt(graph, "pause");
    expect(Math.abs(reloaded.x - place[0])).toBeLessThan(1);
    expect(Math.abs(reloaded.y - place[1])).toBeLessThan(1);
    await expect(controls.getByRole("button", { name: "Reset layout", exact: true })).toBeVisible();

    // Fit to screen fits the boxes where they are: a box moved past the right edge comes back inside the fitted view.
    // The pointer stops just inside the graph's right edge (a drag released outside the window is not one a person can
    // make), so the moved box's right half is past that edge.
    const area = await graph.boundingBox();
    const start = await graph.getByRole("button", { name: "Inspect done", exact: true }).boundingBox();
    await dragStep(page, graph, "done", Math.floor(area.x + area.width - 2 - (start.x + start.width / 2)), 0);
    const outside = await graph.getByRole("button", { name: "Inspect done", exact: true }).boundingBox();
    expect(outside.x + outside.width).toBeGreaterThan(area.x + area.width);
    await controls.getByRole("button", { name: "Fit to screen", exact: true }).click();
    await settledView(graph);
    for (const id of ["poll", "pause", "done", "failed"]) {
        const box = await graph.getByRole("button", { name: `Inspect ${id}`, exact: true }).boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(area.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width + 1);
    }

    // Reset layout: every box back in its automatic place; the next save has no entry for this workflow.
    const savesBeforeReset = profile.saves.length;
    await controls.getByRole("button", { name: "Reset layout", exact: true }).click();
    await expect.poll(async () => Math.abs((await flowNodeAt(graph, "pause")).x - automatic.x)).toBeLessThan(1);
    await expect(controls.getByRole("button", { name: "Reset layout", exact: true })).toHaveCount(0);
    await expect.poll(() => profile.saves.length).toBeGreaterThan(savesBeforeReset);
    expect(profile.saves.at(-1).workflowLayouts?.[LAYOUT_KEY]).toBeUndefined();
    expect(errors).toEqual([]);
});

test("f-03: a new revision keeps the places of the steps it still has; a removed step's place is dropped on the next save", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let model = V2_READ_MODEL;
    await routeV2(page, { readModel: () => model, onCommand: (route, command) => accept(route, command) });
    const profile = await routeProfileSaves(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const graph = page.locator(".ps-workflow-main").getByRole("group", { name: "Workflow graph" });
    await flowReady(graph);
    await settledView(graph);
    await dragStep(page, graph, "pause", 100, 0);
    await dragStep(page, graph, "failed", 100, 0);
    await expect.poll(() => Object.keys(placesSaved(profile).at(-1)?.workflowLayouts[LAYOUT_KEY].steps ?? {}).sort()).toEqual(["failed", "pause"]);
    const pausePlace = placesSaved(profile).at(-1).workflowLayouts[LAYOUT_KEY].steps.pause;

    // Revision 2: "failed" is gone and "review" is new.
    model = {
        ...V2_READ_MODEL,
        definition: { ...V2_READ_MODEL.definition, currentRevision: 2, publishedRevision: 2, publishedDefinitionHash: "hash-2" },
        revision: { ...V2_READ_MODEL.revision, revision: 2, definitionHash: "hash-2", irSha256: "ir-2" },
        graph: { revision: 2, initial: "poll", states: REV2_STATES },
    };
    await page.reload();
    await flowReady(graph);
    await expect(graph.locator(".ps-workflow-node")).toHaveCount(4);
    const pause = await flowNodeAt(graph, "pause");
    expect(Math.abs(pause.x - pausePlace[0])).toBeLessThan(1);
    expect(Math.abs(pause.y - pausePlace[1])).toBeLessThan(1);
    await expect(graph.getByRole("button", { name: "Inspect review", exact: true })).toBeVisible();
    await expect(graph.locator('.react-flow__node[data-id="failed"]')).toHaveCount(0);

    // The next save keeps "pause", adds the step just moved, and drops "failed".
    const count = placesSaved(profile).length;
    await dragStep(page, graph, "done", 60, 0);
    await expect.poll(() => placesSaved(profile).length).toBeGreaterThan(count);
    const steps = placesSaved(profile).at(-1).workflowLayouts[LAYOUT_KEY].steps;
    expect(Object.keys(steps).sort()).toEqual(["done", "pause"]);
    expect(steps.pause).toEqual(pausePlace);
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// Batch 6 (r-1, r-2): Graph | YAML in the header. Graph by default; a click or ArrowLeft/ArrowRight/Home/End switch and
// move focus; the choice is kept per workflow. The graph stays mounted while the YAML shows (same zoom and place after).
// A draft is edited in the YAML tab at full height, with Save, Discard and Unsaved in one strip and Draft tools in the
// side pane; an unsaved edit survives switching tabs and sessions. A published revision is shown read-only; a person
// who may not change the workflow is told the YAML is for those who can.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "r-1" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
const PUBLISHED_YAML = "apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: watch-v2, version: 1.0.0 }\n# published\n";
/** routeApi for a v2 workflow whose read model is `model()`; a definitionRevision read answers that revision's YAML. */
async function routeV2Revisions(page, model, yaml = PUBLISHED_YAML) {
    const reads = [];
    await routeApi(page, {
        workflowEvents: V2_EVENTS,
        workflowState: { title: "Workflow: watch-v2", status: "running" },
        onReadWorkflow: (route) => {
            const revision = new URL(route.request().url()).searchParams.get("definitionRevision");
            reads.push(revision);
            const result = revision ? { ...model(), definitionRevision: { revision: Number(revision), yaml, definitionHash: `hash-${revision}` } } : model();
            return route.fulfill({ json: { ok: true, result } });
        },
    });
    await page.route(`**${V2_COMMANDS_PATH}`, (route) => accept(route, route.request().postDataJSON().command));
    return reads;
}
const workflowTabs = main => main.getByRole("tablist", { name: "Workflow view" });
const openSession = (page, title) => page.locator(".ps-session-row-content", { hasText: title }).first().click();
/**
 * The chat the workflows belong to, opened by its id, not its title. routeApi lists it as "Release triage agent", but its
 * own read (GET /sessions/<id>, which the portal makes for a workflow's parent on each list refresh, every 4 s) comes
 * from the stub server, whose title for that id differs. After the first refresh the row shows that title, except for a
 * few milliseconds after each list, so a title locator waited up to 22 s for that window (f-06).
 */
const openAgent = (page) => page.locator(`.ps-session-list-button[data-session-id="${AGENT_ID}"] .ps-session-row-content`).first().click();

test("r-1: Graph | YAML switch by click and keys, keep the choice per workflow, and keep the graph's view", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeV2Revisions(page, () => V2_READ_MODEL);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const main = page.locator(".ps-workflow-main");
    const tabs = workflowTabs(main);
    const graphTab = tabs.getByRole("tab", { name: "Graph", exact: true });
    const yamlTab = tabs.getByRole("tab", { name: "YAML", exact: true });
    await expect(graphTab).toHaveAttribute("aria-selected", "true");
    await expect(yamlTab).toHaveAttribute("aria-selected", "false");
    const graph = main.getByRole("group", { name: "Workflow graph" });
    await flowReady(graph);
    await graph.getByRole("button", { name: "Zoom in", exact: true }).click();
    const zoomed = await settledView(graph);

    await yamlTab.click();
    await expect(yamlTab).toHaveAttribute("aria-selected", "true");
    await expect(main.getByRole("tabpanel").filter({ visible: true })).toHaveCount(1);
    await expect(graph).toBeHidden();
    // Keys: ArrowLeft and ArrowRight go round, Home and End go to the ends; focus moves with the choice.
    await yamlTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(graphTab).toHaveAttribute("aria-selected", "true");
    await expect(graphTab).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(yamlTab).toHaveAttribute("aria-selected", "true");
    await expect(yamlTab).toBeFocused();
    await page.keyboard.press("Home");
    await expect(graphTab).toHaveAttribute("aria-selected", "true");
    await expect(graphTab).toBeFocused();
    await page.keyboard.press("End");
    await expect(yamlTab).toHaveAttribute("aria-selected", "true");
    await expect(yamlTab).toBeFocused();

    // The choice is kept for this workflow: another session and back shows the YAML again.
    await openAgent(page);
    await expect(main).toHaveCount(0);
    await openSession(page, "Workflow: watch-v2");
    await expect(workflowTabs(page.locator(".ps-workflow-main")).getByRole("tab", { name: "YAML", exact: true })).toHaveAttribute("aria-selected", "true");

    // The graph stayed mounted: back on Graph, the zoom and place are as they were.
    await workflowTabs(main).getByRole("tab", { name: "Graph", exact: true }).click();
    await flowReady(graph);
    const back = await settledView(graph);
    expect(Math.abs(back.x - zoomed.x)).toBeLessThan(1);
    expect(Math.abs(back.y - zoomed.y)).toBeLessThan(1);
    expect(Math.abs(back.scale - zoomed.scale)).toBeLessThan(0.001);
    expect(errors).toEqual([]);
});

test("r-2: a draft is edited in the YAML tab at full height, with one strip, Draft tools in the side pane, and an edit kept until saved", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let saved = false;
    await routeV2(page, {
        readModel: () => saved ? draftModel(2, DRAFT_YAML_2) : draftModel(1, DRAFT_YAML_1),
        onCommand: (route, command) => { saved = true; return route.fulfill({ json: { ok: true, result: { revision: 2, valid: true, diagnostics: [] } } }); },
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const main = page.locator(".ps-workflow-main");
    await workflowTabs(main).getByRole("tab", { name: "YAML", exact: true }).click();
    const editor = main.getByRole("region", { name: "Draft editor", exact: true });
    const yaml = editor.getByRole("textbox", { name: "Workflow YAML", exact: true });
    await expect(yaml).toHaveValue(DRAFT_YAML_1);
    await expect(yaml).not.toHaveAttribute("readonly", "");

    // Save, Discard and Unsaved in one strip.
    const strip = editor.locator(".ps-workflow-yaml-strip");
    await expect(strip.locator('[data-operation="replace_definition"]')).toHaveText("Save draft");
    await expect(strip.locator('[data-action="discard"]')).toHaveText("Discard edits");
    await yaml.fill(DRAFT_YAML_2);
    await expect(strip.getByRole("status")).toHaveText("Unsaved changes");

    // The box fills the tab: it grows with the window and scrolls inside.
    const short = (await yaml.boundingBox()).height;
    await page.setViewportSize({ width: 1440, height: 1100 });
    await expect.poll(async () => (await yaml.boundingBox()).height).toBeGreaterThan(short + 100);
    const tab = main.locator(".ps-workflow-yaml-tab");
    const tabBox = await tab.boundingBox();
    expect((await yaml.boundingBox()).y + (await yaml.boundingBox()).height).toBeLessThanOrEqual(tabBox.y + tabBox.height + 1);
    expect(await yaml.evaluate(element => getComputedStyle(element).overflowY)).not.toBe("visible");
    await page.setViewportSize({ width: 1440, height: 900 });

    // Draft tools opens the side pane on Draft tools.
    await strip.getByRole("button", { name: "Draft tools", exact: true }).click();
    const side = page.locator(".ps-canvas-pane");
    await expect(side.locator('[data-panel="draft"]')).toBeVisible();
    await expect(side.locator('[data-panel="draft"] h2')).toHaveText("Draft tools");

    // The unsaved edit survives Graph -> YAML and another session -> back.
    await workflowTabs(main).getByRole("tab", { name: "Graph", exact: true }).click();
    await workflowTabs(main).getByRole("tab", { name: "YAML", exact: true }).click();
    await expect(editor.getByRole("textbox", { name: "Workflow YAML", exact: true })).toHaveValue(DRAFT_YAML_2);
    await expect(editor.locator(".ps-workflow-yaml-strip").getByRole("status")).toHaveText("Unsaved changes");
    await openAgent(page);
    await openSession(page, "Workflow: watch-v2");
    const again = page.locator(".ps-workflow-main").getByRole("region", { name: "Draft editor", exact: true });
    await expect(again.getByRole("textbox", { name: "Workflow YAML", exact: true })).toHaveValue(DRAFT_YAML_2);
    await expect(again.locator(".ps-workflow-yaml-strip").getByRole("status")).toHaveText("Unsaved changes");

    // Save clears it.
    await again.locator('[data-operation="replace_definition"]').click();
    await expect(again).toHaveAttribute("data-revision", "2");
    await expect(again.locator(".ps-workflow-yaml-strip").getByRole("status")).toHaveCount(0);
    await shot(page, "r2-yaml-tab-draft");
    expect(errors).toEqual([]);
});

test("r-2: a published revision's YAML is read-only, and a person who may not change the workflow is told who sees it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let allowed = true;
    const reads = await routeV2Revisions(page, () => ({ ...V2_READ_MODEL,
        personCommands: { operations: ["pause", "resume", "stop", "cancel"], viewer: allowed ? { allowed: true } : { allowed: false, reason: "Not yours." },
            run: { runId: "run-1", stop: true } } }));
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const main = page.locator(".ps-workflow-main");
    await workflowTabs(main).getByRole("tab", { name: "YAML", exact: true }).click();
    const view = main.getByRole("region", { name: "Workflow YAML", exact: true });
    await expect(view).toContainText("Published revision 1 is fixed. A new version needs a new workflow, made as a draft.");
    const box = view.getByRole("textbox", { name: "Workflow YAML", exact: true });
    await expect(box).toHaveValue(PUBLISHED_YAML);
    await expect(box).toHaveAttribute("readonly", "");
    expect(reads).toContain("1");
    await expect(main.getByRole("region", { name: "Draft editor", exact: true })).toHaveCount(0);

    allowed = false;
    await page.reload();
    await workflowTabs(page.locator(".ps-workflow-main")).getByRole("tab", { name: "YAML", exact: true }).click();
    const denied = page.locator(".ps-workflow-main").getByRole("region", { name: "Workflow YAML", exact: true });
    await expect(denied.getByRole("status")).toHaveText("The YAML is shown to people who can change this workflow.");
    await expect(denied.getByRole("textbox")).toHaveCount(0);
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// Batch 6 (r-3): the side pane hosts every panel. Selecting a step shows Step details again; the step log fills the
// side pane with no second "Step log" header; a refused run control brings the side pane up with the notice above what
// it shows.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "r-3:" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
test("r-3: the step log fills the side pane, a step on the graph shows Step details again, and a refusal shows above it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeV2(page, { onCommand: (route) => refuse(route, 409, "RUN_NOT_ACTIVE", "The run already ended.") });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const main = page.locator(".ps-workflow-main");
    const graph = main.getByRole("group", { name: "Workflow graph" });
    await flowReady(graph);
    const side = page.getByRole("region", { name: "Session canvas" });

    await main.getByRole("button", { name: "Step log", exact: true }).click();
    const log = side.locator('.ps-workflow-side-panel[data-panel="log"]');
    await expect(log).toBeVisible();
    await expect(log.getByText("Step log", { exact: true })).toHaveCount(1);
    const body = await side.locator(".ps-side-pane-body").boundingBox();
    const shown = await log.locator(".ps-workflow-log").boundingBox();
    expect(shown.height).toBeGreaterThan(body.height * 0.75);

    // Selecting a step on the graph shows Step details again.
    await graph.getByRole("button", { name: "Inspect pause", exact: true }).click();
    await expect(log).toHaveCount(0);
    await expect(side.locator(".ps-workflow-node-details h2")).toHaveText("pause");
    await expect(main.getByRole("button", { name: "Step log", exact: true })).toHaveAttribute("aria-expanded", "false");

    // A refused pause: the notice shows in the side pane, above what it shows.
    await main.getByRole("group", { name: "Run controls", exact: true }).locator('[data-operation="pause"]').click();
    const notice = side.locator(".ps-workflow-run-command-notice");
    await expect(notice).toBeVisible();
    await expect(notice.locator("span").first()).toHaveText("Pause was refused for run run-1: The run already ended.");
    const noticeBox = await notice.boundingBox();
    const detailsBox = await side.locator(".ps-workflow-node-details").boundingBox();
    expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(detailsBox.y + 1);
    await shot(page, "r3-side-pane-notice");
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// Batch 6 (f-02): a workflow has neither zen nor full screen. Its side pane header has neither button (a chat's has
// both); zen or full screen turned on from a chat reads as off while a workflow is shown (normal layout: the session
// list and the workflow pane, no maximized canvas), and the chat's zen (saved with its view) comes back as it was left;
// Escape in a workflow with stored zen on is not swallowed by zen.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "f-02:" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
test("f-02: a workflow's side pane has no Zen or Full screen, and a chat's zen comes back as it was left", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeApi(page, { workflowEvents: QUALITY_EVENTS, workflowState: { title: "Workflow: branching-workflow-test", status: "failed" } });
    const profile = await routeProfile(page);
    const side = page.getByRole("region", { name: "Session canvas" });
    const zenButton = side.getByRole("button", { name: /^(Zen mode|Leave zen mode)$/ });
    const fullScreenButton = side.getByRole("button", { name: "Full screen canvas", exact: true });
    const sessionRows = page.locator(".ps-session-row-content");

    // The chat: its side pane has Zen and Full screen.
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    await page.getByRole("button", { name: "Show canvas", exact: true }).click();
    await expect(zenButton).toBeVisible();
    await expect(fullScreenButton).toBeVisible();

    // The workflow: neither.
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    await page.locator(".ps-workflow-main").getByRole("button", { name: "Step log", exact: true }).click();
    await expect(side).toBeVisible();
    await expect(zenButton).toHaveCount(0);
    await expect(fullScreenButton).toHaveCount(0);

    // Zen on from the chat, then the workflow: normal layout; back on the chat, zen is on again.
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    // A load shows the chat's canvas column only once its toggle asks for it (0.8.9).
    await expect(page.getByRole("button", { name: /^(Show canvas|Hide the canvas)$/ })).toBeVisible();
    if (await page.getByRole("button", { name: "Show canvas", exact: true }).count()) await page.getByRole("button", { name: "Show canvas", exact: true }).click();
    await zenButton.click();
    await expect(side.getByRole("button", { name: "Leave zen mode", exact: true })).toBeVisible();
    await expect(sessionRows.first()).toBeHidden();
    // The chat's zen is part of its saved view (the page saves 400 ms after a change): let it save before the next load.
    await expect.poll(() => profile.settings?.sessionViews?.[AGENT_ID]?.desktop?.zen ?? false).toBe(true);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    await expect(page.locator(".ps-workflow-main")).toBeVisible();
    await expect(sessionRows.filter({ hasText: "Workflow: branching-workflow-test" }).first()).toBeVisible();
    // Escape is not taken by zen in a workflow: it goes to the sessions (the list is the focused pane; 0.8.9 moves DOM
    // focus to the row only when the focused pane changes), and the chat's zen is still on when it is opened again.
    await page.locator(".ps-workflow-main").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest("[class*='ps-session']")
        || document.querySelector(".ps-session-pane.is-focused")))).toBe(true);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    await expect(side.getByRole("button", { name: "Leave zen mode", exact: true })).toBeVisible();
    await side.getByRole("button", { name: "Leave zen mode", exact: true }).click();

    // Full screen from the chat, then the workflow: not maximized. (Full screen is not part of a saved view in 0.8.9: a
    // page load starts without it, so it is not checked again on the chat after the load.)
    await fullScreenButton.click();
    await expect(page.getByRole("button", { name: "Restore canvas", exact: true }).first()).toBeVisible();
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    await expect(page.locator(".ps-workflow-main")).toBeVisible();
    await expect(sessionRows.filter({ hasText: "Workflow: branching-workflow-test" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore canvas", exact: true })).toHaveCount(0);
    await shot(page, "f02-workflow-not-full-screen");
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// Batch 6 (f-04): compact review panels. Publish review's property rows are a two-column grid without row dividers,
// with one short note and its buttons in one row (two on a phone); a JSON box is as tall as its text, from 2 to 8 rows, and scrolls
// inside past that. Accessible names and data-field values are unchanged.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "f-04:" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
const PUBLISH_MODEL = {
    ...V2_READ_MODEL,
    definition: { state: "draft", semver: "1.0.0", currentRevision: 1, publishedRevision: null, publishedDefinitionHash: null },
    personCommands: { operations: ["replace_definition", "publish", "publish_and_start"], viewer: { allowed: true },
        draft: { revision: 1, definitionHash: "hash-1", yaml: DRAFT_YAML_1 } },
};
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`f-04: Publish review is compact, and a JSON box is as tall as its text, at ${viewport.width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize(viewport);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const { commands } = await routeV2(page, { readModel: () => PUBLISH_MODEL, onCommand: (route, command) => accept(route, command) });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
        await page.locator(".ps-workflow-main").getByRole("button", { name: "Publish…", exact: true }).click();
        const review = page.getByRole("region", { name: "Publish review", exact: true }).filter({ visible: true });
        await expect(review).toBeVisible();

        // Property rows: two columns, no dividers.
        const rows = review.locator(".ps-workflow-property");
        expect(await rows.count()).toBeGreaterThan(1);
        for (const style of await rows.evaluateAll(elements => elements.map(element => {
            const css = getComputedStyle(element);
            return { display: css.display, columns: css.gridTemplateColumns.trim().split(/\s+/).length, top: css.borderTopWidth, bottom: css.borderBottomWidth };
        }))) {
            expect(style).toEqual({ display: "grid", columns: 2, top: "0px", bottom: "0px" });
        }
        // One short note; the buttons in one row (a phone's touch-size buttons, 0.8.9, may take a second row).
        await expect(review.locator(".ps-workflow-side-note")).toHaveCount(1);
        expect(((await review.locator(".ps-workflow-side-note").textContent()) || "").length).toBeLessThan(120);
        const tops = await review.locator(".ps-workflow-panel-actions button").evaluateAll(buttons => buttons.map(button => Math.round(button.getBoundingClientRect().top)));
        expect(tops.length).toBeGreaterThan(1);
        const buttonRows = [...tops].sort((a, b) => a - b).filter((top, i, sorted) => i === 0 || top - sorted[i - 1] > 2).length;
        expect(buttonRows).toBeLessThanOrEqual(viewport.width < 920 ? 2 : 1);
        const height = (await review.boundingBox()).height;
        testInfo.annotations.push({ type: "publish-review-height", description: `${Math.round(height)}px at ${viewport.width}px` });

        // Names and fields as before.
        const inputs = review.getByRole("textbox", { name: "Inputs (JSON object)", exact: true });
        await expect(inputs).toHaveAttribute("data-field", "inputs");
        await expect(review.getByRole("textbox", { name: "Initial variables (JSON object, optional)", exact: true })).toHaveAttribute("data-field", "vars");
        await expect(review.locator('[data-operation="publish"]')).toBeVisible();

        // A JSON box: "{}" 2 rows, 5 lines 5 rows, 20 lines 8 rows with an inner scrollbar.
        await expect(inputs).toHaveValue("{}");
        await expect(inputs).toHaveAttribute("rows", "2");
        await inputs.fill(["{", "  \"a\": 1,", "  \"b\": 2,", "  \"c\": 3", "}"].join("\n"));
        await expect(inputs).toHaveAttribute("rows", "5");
        const twenty = ["{", ...Array.from({ length: 18 }, (_, i) => `  "k${i}": ${i}${i < 17 ? "," : ""}`), "}"].join("\n");
        await inputs.fill(twenty);
        await expect(inputs).toHaveAttribute("rows", "8");
        expect(await inputs.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
        await shot(page, `f04-publish-review-${viewport.width}`);
        expect(commands).toEqual([]);
        expect(errors).toEqual([]);
    });
}

// ------------------------------------------------------------------------------------------------------------
// Batch 6 (f-06): the graph is fitted once, when first shown with no remembered view. Opening, closing or resizing the
// side pane and resizing the window keep the zoom and the graph's place; only Fit to screen fits again. Graph -> YAML ->
// Graph, a side panel and another session and back give the exact same view. A new revision's graph is fitted once.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "f-06:" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
const sameView = (a, b) => {
    expect(Math.abs(a.x - b.x)).toBeLessThan(1);
    expect(Math.abs(a.y - b.y)).toBeLessThan(1);
    expect(Math.abs(a.scale - b.scale)).toBeLessThan(0.001);
};
async function expectFitted(graph) {
    const area = await graph.boundingBox();
    for (const node of await graph.locator(".ps-workflow-node").all()) {
        const box = await node.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(area.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width + 1);
        expect(box.y).toBeGreaterThanOrEqual(area.y - 1);
        expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height + 1);
    }
}

test("f-06: the graph is fitted once and keeps its view through the side pane, the window, tabs and sessions", async ({ page }) => {
    // Twelve settled views (each waits out the zoom/fit animation and needs two equal reads): more than the default 30 s
    // leaves on a slow runner.
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let model = V2_READ_MODEL;
    await routeV2Revisions(page, () => model);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const main = page.locator(".ps-workflow-main");
    const graph = main.getByRole("group", { name: "Workflow graph" });
    await flowReady(graph);
    const fitted = await settledView(graph);
    await expectFitted(graph);

    // The side pane opens (a panel), closes and opens again; the window is resized: the view stays.
    await main.getByRole("button", { name: "Step log", exact: true }).click();
    await expect(page.getByRole("region", { name: "Session canvas" })).toBeVisible();
    sameView(await settledView(graph), fitted);
    await page.getByRole("button", { name: "Hide the canvas", exact: true }).click();
    await expect(page.getByRole("region", { name: "Session canvas" })).toHaveCount(0);
    sameView(await settledView(graph), fitted);
    await page.getByRole("button", { name: "Show canvas", exact: true }).click();
    sameView(await settledView(graph), fitted);
    await page.setViewportSize({ width: 1280, height: 760 });
    sameView(await settledView(graph), fitted);
    await page.setViewportSize({ width: 1440, height: 900 });
    sameView(await settledView(graph), fitted);

    // Only Fit to screen fits again (here, into the narrower area beside the side pane).
    await page.getByRole("button", { name: "Hide the canvas", exact: true }).click();
    await page.setViewportSize({ width: 1600, height: 900 });
    const wide = await settledView(graph);
    sameView(wide, fitted);
    await graph.getByRole("button", { name: "Fit to screen", exact: true }).click();
    await expect.poll(async () => {
        const now = await viewOf(graph);
        return Math.abs(now.x - fitted.x) > 1 || Math.abs(now.scale - fitted.scale) > 0.001;
    }).toBe(true);
    await expectFitted(graph);

    // Zoom and move, then Graph -> YAML -> Graph, a side panel, another session and back: the same view exactly.
    await graph.getByRole("button", { name: "Zoom in", exact: true }).click();
    const area = await graph.boundingBox();
    await page.mouse.move(area.x + 10, area.y + 10);
    await page.mouse.down();
    await page.mouse.move(area.x + 40, area.y + 30, { steps: 4 });
    await page.mouse.up();
    const chosen = await settledView(graph);
    await workflowTabs(main).getByRole("tab", { name: "YAML", exact: true }).click();
    await workflowTabs(main).getByRole("tab", { name: "Graph", exact: true }).click();
    await flowReady(graph);
    sameView(await settledView(graph), chosen);
    await main.getByRole("button", { name: "Step log", exact: true }).click();
    sameView(await settledView(graph), chosen);
    await openAgent(page);
    await openSession(page, "Workflow: watch-v2");
    await flowReady(graph);
    sameView(await settledView(graph), chosen);

    // A new revision with a different graph is fitted once.
    model = { ...V2_READ_MODEL,
        definition: { ...V2_READ_MODEL.definition, currentRevision: 2, publishedRevision: 2, publishedDefinitionHash: "hash-2" },
        revision: { ...V2_READ_MODEL.revision, revision: 2, definitionHash: "hash-2", irSha256: "ir-2" },
        graph: { revision: 2, initial: "poll", states: REV2_STATES } };
    await page.reload();
    await flowReady(graph);
    await expect(graph.locator(".ps-workflow-node")).toHaveCount(4);
    await settledView(graph);
    await expectFitted(graph);
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// Batch 8 (d-1): the session details of a workflow show Title, ID, Owner, Workflow, Revision, Run, Started by, Steps,
// Updated and Access (ten rows, the same box height as a chat's), not Model, Context, Cron or Agent. Started by is a link
// that selects the parent; a workflow a person started says "You" for its owner. Collapsed, the line shows the run, no
// percentage. An agent session that runs a workflow's step shows "Step of" (a link to the workflow) instead of Cron.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "d-1:" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
const STEP_ID = "99999999-2222-3333-4444-555555555555";
const detailLabels = page => page.locator(".ps-session-detail-box .ps-session-detail-label").allTextContents();
/** The session details box opens folded (sessionDetailCollapsed defaults to true); unfold it when it is. */
async function openDetails(page) {
    const box = page.locator(".ps-session-detail-box");
    await expect(box).toBeVisible();
    if (await box.evaluate(element => element.classList.contains("is-collapsed"))) await box.locator(".ps-session-detail-summary").click();
    await expect(box).not.toHaveClass(/is-collapsed/);
}
const detailValue = (page, label) => page.locator(".ps-session-detail-field").filter({ has: page.locator(".ps-session-detail-label", { hasText: new RegExp(`^${label}$`) }) })
    .locator(".ps-session-detail-value");

test("d-1: a workflow's session details say what it runs, link its parent, and fold to its run", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeV2(page, { onCommand: (route, command) => accept(route, command) });
    // A third session: an agent running one of the workflow's steps.
    const step = { sessionId: STEP_ID, title: "Workflow step: review", status: "idle", model: "test:test-model", parentSessionId: WORKFLOW_ID,
        agentId: "reviewer", createdAt: now - 10_000, updatedAt: now - 5_000 };
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const pathname = new URL(req.url()).pathname;
        const answer = (result) => route.fulfill({ json: { ok: true, result } });
        const sessions = [...SESSIONS.map(session => session.sessionId === WORKFLOW_ID ? { ...session, title: "Workflow: watch-v2", status: "running" } : session), step];
        if (pathname.endsWith("/management/sessions")) return answer({ sessions, hasMore: false, nextCursor: null });
        if (pathname.endsWith("/sessions") && req.method() === "GET") return answer({ sessions, hasMore: false });
        if (pathname.includes(`/sessions/${STEP_ID}/events`)) return answer([]);
        if (pathname.endsWith(`/sessions/${STEP_ID}`)) return answer({ ...step, events: [], messages: [] });
        return route.fallback();
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    await flowReady(page.locator(".ps-workflow-main").getByRole("group", { name: "Workflow graph" }));
    await openDetails(page);

    await expect.poll(() => detailLabels(page)).toEqual(["Title", "ID", "Owner", "Workflow", "Revision", "Run", "Started by", "Steps", "Updated", "Access"]);
    await expect(detailValue(page, "Workflow")).toHaveText("watch-v2 1.0.0");
    await expect(detailValue(page, "Revision")).toHaveText("1 · published");
    await expect(detailValue(page, "Run")).toHaveText("running");
    await expect(detailValue(page, "Steps")).toHaveText("4");
    const startedBy = detailValue(page, "Started by");
    await expect(startedBy).toHaveText("Release triage agent");
    const workflowHeight = Math.round((await page.locator(".ps-session-detail-box").boundingBox()).height);
    await shot(page, "d1-workflow-details");

    // Collapsed: the run, no percentage.
    await page.locator(".ps-session-detail-collapse").click();
    const marks = page.locator(".ps-session-detail-box.is-collapsed .ps-session-detail-marks");
    await expect(marks).toContainText("running");
    await expect(marks).not.toContainText("%");
    await page.locator(".ps-session-detail-summary").click();

    // Started by selects the parent: a chat, whose details have the chat rows and the same height.
    await startedBy.click();
    await expect(page.locator(".ps-workflow-main")).toHaveCount(0);
    await expect.poll(() => detailLabels(page)).toEqual(["Title", "ID", "Owner", "Model", "Context", "Cron", "Agent", "Updated", "Children", "Access"]);
    expect(Math.round((await page.locator(".ps-session-detail-box").boundingBox()).height)).toBe(workflowHeight);

    // The step's agent session: "Step of" the workflow, a link, instead of Cron.
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${STEP_ID}`);
    await openDetails(page);
    await expect.poll(() => detailLabels(page)).toEqual(["Title", "ID", "Owner", "Model", "Context", "Step of", "Agent", "Updated", "Children", "Access"]);
    const stepOf = detailValue(page, "Step of");
    await expect(stepOf).toHaveText("Workflow: watch-v2");
    await stepOf.click();
    await expect(page.locator(".ps-workflow-main")).toBeVisible();
    expect(errors).toEqual([]);
});

const TEST_OWNER = { provider: "none", subject: "test", email: "test@example.com", displayName: "Test User" };
/** The stub's bootstrap names no signed-in person; this one does, so "You" can be decided. */
async function routeViewer(page, principal) {
    await page.route("**/api/v1/bootstrap", route => route.fulfill({ json: { ok: true, result: {
        auth: { principal, authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] } },
    } } }));
}
const personStarted = (page) => routeApi(page, {
    workflowEvents: V2_EVENTS,
    workflowState: { title: "Workflow: watch-v2", status: "running", parentSessionId: null, owner: TEST_OWNER },
    onReadWorkflow: (route) => route.fulfill({ json: { ok: true, result: { ...V2_READ_MODEL, runs: [], run: null } } }),
});

test("d-1: a workflow a person started says 'You' as its starter, for its owner", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await personStarted(page);
    await routeViewer(page, TEST_OWNER);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    await openDetails(page);
    await expect(detailValue(page, "Started by")).toHaveText("You");
    await expect(detailValue(page, "Run")).toHaveText("No run yet");
    await page.locator(".ps-session-detail-collapse").click();
    await expect(page.locator(".ps-session-detail-box.is-collapsed .ps-session-detail-marks")).toContainText("No run yet");
    await page.locator(".ps-session-detail-summary").click();
});

// A viewer who is not the owner (here the stub's bootstrap, which names no one) sees the owner's name, not "You".
test("d-1: a workflow a person started names its owner as its starter, for a viewer who is not its owner", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await personStarted(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    await openDetails(page);
    await expect(detailValue(page, "Started by")).toHaveText("Test User <test@example.com>");
});

// ------------------------------------------------------------------------------------------------------------
// Batch 7 (f-05): a run's Inputs box is filled from the workflow's input schema (the read model's graph.inputsSchema):
// Publish and start, Start and Test review show the sample untouched; typing stops the refill; Sample fills it again.
// Without a schema the box is "{}" and there is no Sample button.
// Batch 7 (n-2): Run activity says when the parent agent was not told that the live run ended.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "f-05:|n-2:" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
const INPUTS_SCHEMA = {
    type: "object", required: ["buildId", "state"],
    properties: { buildId: { type: "integer", examples: [7] }, state: { type: "string", enum: ["running", "succeeded"] } },
};
const SAMPLE = { buildId: 7, state: "running" };
const withSchema = (model, schema = INPUTS_SCHEMA) => ({ ...model, graph: { ...model.graph, ...(schema ? { inputsSchema: schema } : {}) } });
const PUBLISHED_START_MODEL = { ...V2_READ_MODEL, runs: [], run: null,
    personCommands: { operations: ["start"], viewer: { allowed: true } } };
const DRAFT_TEST_MODEL = { ...PUBLISH_MODEL,
    personCommands: { ...PUBLISH_MODEL.personCommands, operations: [...PUBLISH_MODEL.personCommands.operations, "test"] } };

for (const [name, model, button, region] of [
    ["Publish and start", withSchema(PUBLISH_MODEL), "Publish…", "Publish review"],
    ["Start", withSchema(PUBLISHED_START_MODEL), "Start…", "Start the live run"],
    ["Test review", withSchema(DRAFT_TEST_MODEL), "Test…", null],
]) {
    test(`f-05: ${name} shows the Inputs sample from the schema; typing stops the refill and Sample fills it again`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const { commands } = await routeV2(page, { events: name === "Start" ? [] : V2_EVENTS, readModel: () => model, onCommand: (route, command) => accept(route, command) });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
        await page.locator(".ps-workflow-main").getByRole("button", { name: button, exact: true }).click();
        const panel = region ? page.getByRole("region", { name: region, exact: true }) : page.locator('.ps-workflow-side-panel[data-panel="test"]');
        const inputs = panel.getByRole("textbox", { name: "Inputs (JSON object)", exact: true });
        await expect.poll(async () => { try { return JSON.parse(await inputs.inputValue()); } catch { return null; } }).toEqual(SAMPLE);
        const sample = panel.locator('[data-action="sample-inputs"]');
        await expect(sample).toBeVisible();
        // Typing stops the refill: the person's text stays.
        await inputs.fill("{ \"buildId\": 9 }");
        await page.waitForTimeout(500);
        await expect(inputs).toHaveValue("{ \"buildId\": 9 }");
        // An emptied box is the person's too until Sample: it is not refilled by itself.
        await inputs.fill("");
        await page.waitForTimeout(300);
        await expect(inputs).toHaveValue("");
        // Sample fills it again.
        await sample.click();
        await expect.poll(async () => JSON.parse(await inputs.inputValue())).toEqual(SAMPLE);
        expect(commands).toEqual([]);
        expect(errors).toEqual([]);
    });
}

test("f-05: without an input schema the Inputs box is {} and there is no Sample button", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeV2(page, { readModel: () => PUBLISH_MODEL, onCommand: (route, command) => accept(route, command) });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    await page.locator(".ps-workflow-main").getByRole("button", { name: "Publish…", exact: true }).click();
    const review = page.getByRole("region", { name: "Publish review", exact: true });
    await expect(review.getByRole("textbox", { name: "Inputs (JSON object)", exact: true })).toHaveValue("{}");
    await expect(review.locator('[data-action="sample-inputs"]')).toHaveCount(0);
});

test("n-2: Run activity says the parent agent was not told when notifications are off", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const ended = { ...V2_READ_MODEL,
        runs: [{ runId: "run-1", mode: "live", status: "completed", revision: 1, outcome: "succeeded" }],
        run: { ...V2_READ_MODEL.run, status: "completed", outcome: "succeeded", terminalState: "done" } };
    const at = new Date().toISOString();
    const events = [
        ...V2_EVENTS,
        { sessionId: WORKFLOW_ID, seq: 2, eventType: "workflow.completed", createdAt: at, data: { runId: "run-1", stateId: "done", outcome: "succeeded" } },
        { sessionId: WORKFLOW_ID, seq: 3, eventType: "workflow.parent_notification_skipped", createdAt: at, data: { runId: "run-1", reason: "notifications are off" } },
    ];
    await routeV2(page, { events, readModel: () => ended, onCommand: (route, command) => accept(route, command) });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    await page.locator(".ps-workflow-main").getByRole("button", { name: "Run activity", exact: true }).click();
    const activity = page.locator('.ps-workflow-side-panel[data-panel="activity"] .ps-workflow-run-activity');
    await expect(activity).toContainText("The parent agent was not told: notifications are off.");
    expect(errors).toEqual([]);
});

// Batch 6 (f-03): a moved step's own loop is drawn as a curve out beside it (its right edge), not the automatic route.
// Selector: -g "own loop" (from packages/app/web, after build).
test("f-03: a moved step's own loop curves beside it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const loopEvents = [{ sessionId: WORKFLOW_ID, seq: 1, eventType: "workflow.started", createdAt: new Date().toISOString(), data: {
        name: "query-watch", version: "1", initial: "poll_query", states: [
            { id: "poll_query", type: "script", runtime: "node", next: { unchanged: "poll_query", changed: "end" } },
            { id: "end", type: "terminal", outcome: "succeeded" },
        ] } }];
    await routeApi(page, { workflowEvents: loopEvents, workflowState: { title: "Workflow: query-watch", status: "running" } });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const graph = page.locator(".ps-workflow-main").getByRole("group", { name: "Workflow graph" });
    await flowReady(graph);
    await settledView(graph);
    const automatic = await edgePath(graph, "poll_query", "poll_query");
    await dragStep(page, graph, "poll_query", 120, 0);
    await expect.poll(() => edgePath(graph, "poll_query", "poll_query")).not.toBe(automatic);
    const node = await flowNodeAt(graph, "poll_query");
    const numbers = ((await edgePath(graph, "poll_query", "poll_query")).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    // M start C control1 control2 end: both control points lie right of the box; it starts at its bottom and ends at its top.
    expect(numbers).toHaveLength(8);
    expect(numbers[2]).toBeGreaterThan(node.x + node.width);
    expect(numbers[4]).toBeGreaterThan(node.x + node.width);
    expect(Math.abs(numbers[1] - (node.y + node.height))).toBeLessThan(12);
    expect(Math.abs(numbers[7] - node.y)).toBeLessThan(12);
});

// ------------------------------------------------------------------------------------------------------------
// Adversarial review UI-6: the person's saved step places can arrive after the graph's first fit (the profile read after
// the workflow's). Then, once, while the person has not touched the view and none was remembered, the graph is fitted
// again to where the boxes are, so a far-moved box is on screen.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "UI-6:" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
test("UI-6: saved places that arrive after the first fit are fitted once", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeV2(page, { onCommand: (route, command) => accept(route, command) });
    const saved = { workflowLayouts: { [LAYOUT_KEY]: { at: Date.now(), steps: { done: [4000, 2400] } } } };
    await page.route("**/api/v1/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.endsWith("/me/profile")) {
            await new Promise(resolve => setTimeout(resolve, 2_500));
            return route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: saved } } });
        }
        if (pathname.endsWith("/me/profile/settings")) return route.fulfill({ json: { ok: true, result: { profileSettings: saved } } });
        return route.fallback();
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const graph = page.locator(".ps-workflow-main").getByRole("group", { name: "Workflow graph" });
    await flowReady(graph);
    // The places arrive: the box moves far away, and the graph is fitted again to show it.
    await expect.poll(async () => (await flowNodeAt(graph, "done")).x, { timeout: 15_000 }).toBe(4000);
    await settledView(graph);
    await expectFitted(graph);
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// Owed M-13 (verification of UI-1): two draft workflows at the same revision with different YAML, switched A -> B -> A
// in the mounted portal, with B's read held while the switch happens. Each editor shows only its own workflow's YAML,
// A's unsaved edit survives the round trip, and each Save sends its own workflow's text to its own workflow.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "M-13" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
const WORKFLOW_B = "77777777-2222-3333-4444-555555555556";
test("M-13: switching A -> B -> A at equal revisions never shows or saves one workflow's YAML in the other", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const yamlA = "apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: watch-a, version: 1.0.0 }\n# A\n";
    const yamlB = "apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: watch-b, version: 1.0.0 }\n# B\n";
    const models = { [WORKFLOW_ID]: { ...draftModel(1, yamlA), workflowId: WORKFLOW_ID }, [WORKFLOW_B]: { ...draftModel(1, yamlB), workflowId: WORKFLOW_B } };
    let holdB = null;
    const saves = [];
    await routeApi(page, {
        workflowEvents: V2_EVENTS,
        workflowState: { title: "Workflow: watch-a", status: "running" },
        onReadWorkflow: (route) => route.fulfill({ json: { ok: true, result: models[WORKFLOW_ID] } }),
    });
    // Workflow B beside A: its row, its events and its read (held while `holdB` is set), and the commands of both.
    const rowB = { sessionId: WORKFLOW_B, title: "Workflow: watch-b", status: "running", sessionKind: "workflow", parentSessionId: AGENT_ID,
        createdAt: now - 20_000, updatedAt: now - 10_000 };
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const pathname = new URL(req.url()).pathname;
        const answer = (result) => route.fulfill({ json: { ok: true, result } });
        const sessions = [...SESSIONS.map(session => session.sessionId === WORKFLOW_ID ? { ...session, title: "Workflow: watch-a", status: "running" } : session), rowB];
        if (pathname.endsWith("/management/sessions")) return answer({ sessions, hasMore: false, nextCursor: null });
        if (pathname.endsWith("/sessions") && req.method() === "GET") return answer({ sessions, hasMore: false });
        if (pathname.endsWith(`/sessions/${WORKFLOW_B}/workflow`) && req.method() === "GET") {
            if (holdB) await holdB.promise;
            return answer(models[WORKFLOW_B]);
        }
        if (pathname.includes(`/sessions/${WORKFLOW_B}/events`)) return answer([{ ...V2_EVENTS[0], sessionId: WORKFLOW_B }]);
        if (pathname.endsWith(`/sessions/${WORKFLOW_B}`)) return answer({ ...rowB, events: [], messages: [] });
        const command = /\/sessions\/([^/]+)\/workflow\/commands$/.exec(pathname);
        if (command && req.method() === "POST") {
            saves.push({ sessionId: command[1], command: req.postDataJSON().command });
            return answer({ revision: 2, valid: true, diagnostics: [] });
        }
        return route.fallback();
    });
    const main = page.locator(".ps-workflow-main");
    const editor = main.getByRole("region", { name: "Draft editor", exact: true });
    const box = editor.getByRole("textbox", { name: "Workflow YAML", exact: true });
    const yamlTab = () => workflowTabs(main).getByRole("tab", { name: "YAML", exact: true });

    // B first, on its YAML tab (the tab is kept per workflow), clean.
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_B}`);
    await yamlTab().click();
    await expect(box).toHaveValue(yamlB);
    // A, on its YAML tab, with an unsaved edit.
    await openSession(page, "Workflow: watch-a");
    await yamlTab().click();
    await expect(box).toHaveValue(yamlA);
    const editedA = `${yamlA}# edited in A\n`;
    await box.fill(editedA);
    await expect(editor.locator(".ps-workflow-yaml-strip").getByRole("status")).toHaveText("Unsaved changes");

    // B again while its read is held: its editor shows its own YAML, before and after the read, never A's.
    let release;
    holdB = { promise: new Promise(resolve => { release = resolve; }) };
    await openSession(page, "Workflow: watch-b");
    await expect(editor).toBeVisible();
    await expect(box).toHaveValue(yamlB);
    release();
    holdB = null;
    await page.waitForTimeout(300);
    await expect(box).toHaveValue(yamlB);
    await expect(editor.locator(".ps-workflow-yaml-strip").getByRole("status")).toHaveCount(0);
    // B's own edit, saved: the payload is B's text, at B's revision, to B.
    const editedB = `${yamlB}# edited in B\n`;
    await box.fill(editedB);
    await editor.locator('[data-operation="replace_definition"]').click();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]).toEqual({ sessionId: WORKFLOW_B,
        command: { operation: "replace_definition", operation_id: expect.stringMatching(/^ui-replace_definition-/), expected_revision: 1, yaml: editedB } });

    // A again: its unsaved edit came back, and its Save sends A's text to A.
    await openSession(page, "Workflow: watch-a");
    await expect(box).toHaveValue(editedA);
    await expect(editor.locator(".ps-workflow-yaml-strip").getByRole("status")).toHaveText("Unsaved changes");
    await editor.locator('[data-operation="replace_definition"]').click();
    await expect.poll(() => saves.length).toBe(2);
    expect(saves[1]).toEqual({ sessionId: WORKFLOW_ID,
        command: { operation: "replace_definition", operation_id: expect.stringMatching(/^ui-replace_definition-/), expected_revision: 1, yaml: editedA } });
    expect(saves.every(save => !(save.sessionId === WORKFLOW_B && save.command.yaml.includes("# A")) && !(save.sessionId === WORKFLOW_ID && save.command.yaml.includes("# B")))).toBe(true);
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// Owed M-17 (verification of UI-6): the one late fit of saved places happens only while the person has not touched the
// view and none was remembered. (A) A zoom before the profile arrives: the places are taken, the view stays where the
// person put it (the far box stays off screen). (B) A remembered view (the person zoomed, went to another session and
// came back): the new graph starts from it, and the late places do not refit it. The profile is held until released.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "M-17" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
/** The profile, held until `release()`: then it answers with the saved place of `done` far away. */
async function heldProfile(page) {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const saved = { workflowLayouts: { [LAYOUT_KEY]: { at: Date.now(), steps: { done: [4000, 2400] } } } };
    await page.route("**/api/v1/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.endsWith("/me/profile")) {
            await held;
            return route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: saved } } });
        }
        if (pathname.endsWith("/me/profile/settings")) return route.fulfill({ json: { ok: true, result: { profileSettings: saved } } });
        return route.fallback();
    });
    return { release: () => release() };
}

/** Whether the step's box is outside the graph's area (the view was not fitted to it). */
async function offScreen(graph, id) {
    const area = await graph.boundingBox();
    const box = await graph.locator(`[data-node-id="${id}"]`).boundingBox();
    return !box || box.x >= area.x + area.width || box.y >= area.y + area.height || box.x + box.width <= area.x || box.y + box.height <= area.y;
}

test("M-17 (UI-6): saved places that arrive after the person zoomed are taken without a refit", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeV2(page, { onCommand: (route, command) => accept(route, command) });
    const profile = await heldProfile(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const graph = page.locator(".ps-workflow-main").getByRole("group", { name: "Workflow graph" });
    await flowReady(graph);
    const fitted = await settledView(graph);
    await graph.getByRole("button", { name: "Zoom in", exact: true }).click();
    const zoomed = await settledView(graph);
    expect(zoomed.scale).toBeGreaterThan(fitted.scale * 1.05);
    profile.release();
    // The places are taken (the box moves far away) and the view stays where the person put it.
    await expect.poll(async () => (await flowNodeAt(graph, "done")).x, { timeout: 15_000 }).toBe(4000);
    sameView(await settledView(graph), zoomed);
    expect(await offScreen(graph, "done")).toBe(true);
    expect(errors).toEqual([]);
});

test("M-17 (UI-6): a remembered view is where the graph starts again, and saved places that arrive later do not refit it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeV2(page, { onCommand: (route, command) => accept(route, command) });
    const profile = await heldProfile(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const graph = page.locator(".ps-workflow-main").getByRole("group", { name: "Workflow graph" });
    await flowReady(graph);
    await settledView(graph);
    await graph.getByRole("button", { name: "Zoom in", exact: true }).click();
    const remembered = await settledView(graph);
    // Another session and back: a new graph, started from the remembered view, which no one has touched since.
    await openAgent(page);
    await openSession(page, "Workflow: watch-v2");
    await flowReady(graph);
    sameView(await settledView(graph), remembered);
    profile.release();
    await expect.poll(async () => (await flowNodeAt(graph, "done")).x, { timeout: 15_000 }).toBe(4000);
    sameView(await settledView(graph), remembered);
    expect(await offScreen(graph, "done")).toBe(true);
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// Owed M-17 (verification of UI-7): the run's confirm dialog through the portal's own key handling. Tab and Shift+Tab
// stay inside it, go round its Close, Cancel and Stop Run in order and skip a disabled control and a hidden one; Enter
// or Space on its Cancel button cancels (the portal's Enter does not confirm); Escape cancels; each time nothing is sent
// and focus goes back to Stop; Enter on the dialog itself confirms, and exactly one stop is sent. (A control inside a
// hidden parent is not covered: a known limit of the dialog's focus filter, which checks a control's own hidden flag.)
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "M-17 \\(UI-7\\)" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
test("M-17 (UI-7): the confirm dialog keeps Tab inside, skips disabled and hidden controls, cancels on Enter on Cancel and on Escape, confirms on Enter", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { commands } = await routeV2(page, { onCommand: (route, command) => accept(route, command, { status: "stopping" }) });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const controls = page.locator(".ps-workflow-main").getByRole("group", { name: "Run controls", exact: true });
    const stop = controls.getByRole("button", { name: "Stop", exact: true });
    const dialog = page.getByRole("dialog", { name: "Stop Workflow Run", exact: true });
    /** The focused element: its name (its label, else its text), and whether it is inside the dialog. */
    const focused = () => page.evaluate(() => {
        const active = document.activeElement;
        const box = document.querySelector('[role="dialog"]');
        return { text: active?.getAttribute("aria-label") || active?.textContent?.trim() || "", inside: Boolean(box && box.contains(active)), dialog: active === box };
    });
    const CONTROLS = ["Close", "Cancel", "Stop Run"];

    await stop.click();
    await expect(dialog).toBeFocused();
    // A disabled and a hidden control in the dialog: never focused.
    await dialog.evaluate((box) => {
        const disabled = document.createElement("button");
        disabled.textContent = "Disabled extra";
        disabled.disabled = true;
        const hidden = document.createElement("button");
        hidden.textContent = "Hidden extra";
        hidden.hidden = true;
        box.append(disabled, hidden);
    });
    const forward = [];
    for (let i = 0; i < 5; i += 1) {
        await page.keyboard.press("Tab");
        forward.push(await focused());
    }
    // From the dialog, Tab goes to its first control and then cycles through its enabled, shown controls, in order.
    expect(forward.every(item => item.inside)).toBe(true);
    expect(forward.map(item => item.text)).toEqual([...CONTROLS, ...CONTROLS.slice(0, 2)]);
    const back = [];
    for (let i = 0; i < 3; i += 1) {
        await page.keyboard.press("Shift+Tab");
        back.push(await focused());
    }
    // Shift+Tab goes back, around from the first to the last.
    expect(back.every(item => item.inside)).toBe(true);
    expect(back.map(item => item.text)).toEqual(["Close", "Stop Run", "Cancel"]);

    // Enter on Cancel cancels: nothing sent, focus back on Stop.
    await dialog.getByRole("button", { name: "Cancel", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(stop).toBeFocused();
    expect(commands).toEqual([]);

    // Escape cancels.
    await stop.click();
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(stop).toBeFocused();
    expect(commands).toEqual([]);

    // Space on Cancel cancels too.
    await stop.click();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).focus();
    await page.keyboard.press(" ");
    await expect(dialog).toHaveCount(0);
    expect(commands).toEqual([]);

    // Enter on the dialog itself confirms: exactly one stop.
    await stop.click();
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => commands.length).toBe(1);
    expect(commands[0]).toEqual({ operation: "stop", operation_id: expect.stringMatching(/^ui-stop-/), run_id: "run-1" });
    await page.waitForTimeout(300);
    expect(commands).toHaveLength(1);
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// Owed M-18 (verification of UI-8): the run picker and the step log, mounted, with the same step's distinct results in a
// live run and a test run. The log shows the chosen run's entries only, through live appends and after a reload (the
// history rebuilt), and keeps the session's own notice (no run id) in every choice, never as a run's entry.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "M-18" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
test("M-18 (UI-8): the step log shows the chosen run's results only, through live appends and a reload; the session's notice stays in each", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let seqs = 0;
    const event = (eventType, data) => ({ sessionId: WORKFLOW_ID, seq: ++seqs, eventType, createdAt: new Date().toISOString(), data });
    const step = (runId, n, value, outcome = "changed") => [
        event("workflow.state_started", { runId, nodeExecutionId: `nx-${runId}-poll-${n}`, stateId: "poll", scopeId: "root", ordinal: n, type: "script", step: n, kvRevision: 1 }),
        event("workflow.state_completed", { runId, nodeExecutionId: `nx-${runId}-poll-${n}`, stateId: "poll", step: n, outcome, resultKind: "business",
            outputPreview: JSON.stringify({ v: value }) }),
    ];
    const started = (runId, mode) => event("workflow.started", { ...V2_EVENTS[0].data, runId, mode });
    const events = [
        started("run-1", "live"), ...step("run-1", 1, "live-1"),
        started("run-t", "test"), ...step("run-t", 1, "test-1"),
        // The session's own notice: no run id.
        event("workflow.recovered", { action: "none", requestedBy: "agent-session-1" }),
    ];
    const runs = [{ runId: "run-1", mode: "live", status: "running", revision: 1, outcome: null },
        { runId: "run-t", mode: "test", status: "running", revision: 1, outcome: null }];
    const runModel = (runId, mode, value) => ({ ...V2_READ_MODEL, runs,
        run: { ...V2_READ_MODEL.run, runId, mode, ...(mode === "test" ? { test: { interceptions: [], virtualClock: { elapsedSeconds: 0 } } } : {}),
            nodeExecutions: [{ ...V2_READ_MODEL.run.nodeExecutions[0], nodeExecutionId: `nx-${runId}-poll-1`, outputPreview: JSON.stringify({ v: value }) }] } });
    const sockets = [];
    let subscribed = false;
    await routeApi(page, {
        workflowEvents: events,
        workflowState: { title: "Workflow: watch-v2", status: "running" },
        onSocket: (socket) => {
            sockets.push(socket);
            socket.onMessage((raw) => { if (JSON.parse(raw).type === "subscribeSession") subscribed = true; });
        },
        onReadWorkflow: (route) => {
            const runId = new URL(route.request().url()).searchParams.get("runId");
            return route.fulfill({ json: { ok: true, result: runId === "run-t" ? runModel("run-t", "test", "test-1") : runModel("run-1", "live", "live-1") } });
        },
    });
    const main = page.locator(".ps-workflow-main");
    const picker = main.getByRole("combobox", { name: "Workflow run" });
    const log = page.locator('.ps-workflow-side-panel[data-panel="log"] .ps-workflow-log').filter({ visible: true });
    /** The log shows exactly the values of `shown` (and none of `hidden`), and the session's notice. */
    const expectLog = async (shown, hidden) => {
        for (const value of shown) await expect(log).toContainText(value);
        for (const value of hidden) await expect(log).not.toContainText(value);
        await expect(log).toContainText(/recovery requested/i);
    };
    const open = async () => {
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
        await expect(picker).toBeVisible();
        await main.getByRole("button", { name: "Step log", exact: true }).click();
    };

    await open();
    await expect(picker).toHaveValue("");
    await expectLog(["live-1"], ["test-1"]);
    await picker.selectOption("run-t");
    await expectLog(["test-1"], ["live-1"]);

    // Live appends of both runs while the test run is chosen: only its own shows.
    await expect.poll(() => subscribed).toBe(true);
    const appended = [...step("run-t", 2, "test-2", "unchanged"), ...step("run-1", 2, "live-2", "unchanged")];
    events.push(...appended);
    for (const socket of sockets) {
        for (const item of appended) socket.send(JSON.stringify({ type: "sessionEvent", sessionId: WORKFLOW_ID, event: item }));
    }
    await expectLog(["test-1", "test-2"], ["live-1", "live-2"]);
    await picker.selectOption("");
    await expectLog(["live-1", "live-2"], ["test-1", "test-2"]);

    // A reload rebuilds the history from the stored events: the same split.
    await open();
    await expectLog(["live-1", "live-2"], ["test-1", "test-2"]);
    await picker.selectOption("run-t");
    await expectLog(["test-1", "test-2"], ["live-1", "live-2"]);
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// The parallel fixture: a v2 workflow with a parallel step (a join of the first 2 of 3, a 30 s time limit) mounted in
// React Flow. Its branch box holds its body steps, its join bar says the rule and the time limit, its edges are drawn,
// and the graph is worked with the keyboard: each step card and the join bar are reached with Tab, Enter or Space
// selects (the join bar selects the parallel step), a body step's details pick its branch, and the view's buttons zoom.
// At 390 px the same graph mounts. Branch 1 succeeded, branch 2 runs its first step, branch 3 has not started.
// Selector: npx playwright test test/e2e/workflow-session.spec.mjs -g "parallel fixture" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
const PARALLEL_STATES = [
    { id: "fan", type: "parallel", forEach: { count: 3, sha256: "a".repeat(64) }, concurrency: 2, join: { first: 2 }, failFast: false, timeoutSeconds: 30,
        body: { initial: "prepare", states: ["prepare", "reviewed"] }, outcomes: ["joined", "blocked"],
        next: { joined: "done", blocked: "stuck", timed_out: "late" } },
    { id: "prepare", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["ready"], next: { ready: "reviewed" }, parallel: "fan" },
    { id: "reviewed", type: "terminal", outcome: "succeeded", parallel: "fan" },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "stuck", type: "terminal", outcome: "blocked" },
    { id: "late", type: "terminal", outcome: "blocked" },
];
const PARALLEL_EVENTS = [{ ...V2_EVENTS[0], data: { ...V2_EVENTS[0].data, name: "review-fan", initial: "fan", states: PARALLEL_STATES } }];
const branchRow = (stateId, index, state, extra = {}) => ({ nodeExecutionId: `nx-${stateId}-b${index}`, stateId, ordinal: 1, state,
    outcome: null, resultKind: null, winner: null, attempts: 0, kvRevision: 1, scopeId: `nx-fan-1#${index}`,
    branch: { parallelNodeExecutionId: "nx-fan-1", index }, ...extra });
const PARALLEL_MODEL = {
    ...V2_READ_MODEL,
    revision: { ...V2_READ_MODEL.revision, name: "review-fan" },
    graph: { revision: 1, initial: "fan", states: PARALLEL_STATES },
    run: { ...V2_READ_MODEL.run, nodeExecutions: [
        { nodeExecutionId: "nx-fan-1", stateId: "fan", ordinal: 1, state: "pending", outcome: null, resultKind: null, winner: null, attempts: 0, kvRevision: 1,
            scopeId: "root", branches: 3 },
        branchRow("prepare", 0, "completed", { outcome: "ready", resultKind: "business", winner: "controller", outputPreview: "{\"ok\":true}" }),
        branchRow("reviewed", 0, "completed", { outcome: "succeeded", resultKind: "business", winner: "controller", outputPreview: "null" }),
        branchRow("prepare", 1, "pending"),
    ] },
};

test("parallel fixture: a parallel step mounts in React Flow with its branch box, join bar and edges, and is worked with the keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeV2(page, { events: PARALLEL_EVENTS, readModel: () => PARALLEL_MODEL, onCommand: (route, command) => accept(route, command) });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const graph = page.locator(".ps-workflow-main").getByRole("group", { name: "Workflow graph" });
    await flowReady(graph);
    // Mounted: six step cards, the branch box around the body steps, the join bar with its rule and its time limit.
    await expect(graph.locator(".ps-workflow-node")).toHaveCount(6);
    const group = graph.getByRole("group", { name: /^Each branch of fan/ });
    await expect(group).toBeVisible();
    const join = graph.getByRole("button", { name: /^Join of fan: join · first 2 of 3/ });
    await expect(join).toBeVisible();
    await expect(join).toContainText("first 2 of 3");
    await expect(join).toContainText("time limit");
    const groupBox = await group.boundingBox();
    for (const id of ["prepare", "reviewed"]) {
        const box = await graph.getByRole("button", { name: `Inspect ${id}`, exact: true }).boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(groupBox.x - 1);
        expect(box.y).toBeGreaterThanOrEqual(groupBox.y - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(groupBox.x + groupBox.width + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(groupBox.y + groupBox.height + 1);
    }
    const edges = await graph.locator(".ps-workflow-edge").count();
    expect(edges).toBeGreaterThan(0);
    await expectEdgesDrawn(graph, edges);
    await settledView(graph);
    await expectFitted(graph);

    // The keyboard: Enter on a body step selects it; its details pick its branch.
    const prepare = graph.getByRole("button", { name: "Inspect prepare", exact: true });
    await prepare.focus();
    await page.keyboard.press("Enter");
    await expect(prepare).toHaveAttribute("aria-pressed", "true");
    const details = page.locator(".ps-workflow-node-details").filter({ visible: true });
    await expect(details.locator("h2")).toHaveText("prepare");
    const branchPicker = details.locator('select[data-field="branch"]');
    await expect(branchPicker.locator("option")).toHaveText(["Branch 1 · ended 'ready'", "Branch 2 · running"]);
    // Tab moves on to another card of the graph, and Shift+Tab back.
    await prepare.focus();
    await page.keyboard.press("Tab");
    const next = await page.evaluate(() => {
        const active = document.activeElement;
        return { inGraph: Boolean(active?.closest('[aria-label="Workflow graph"]')), card: Boolean(active?.matches(".ps-workflow-node, .ps-workflow-join")),
            label: active?.getAttribute("aria-label") ?? "" };
    });
    expect(next).toMatchObject({ inGraph: true, card: true });
    expect(next.label).not.toBe("Inspect prepare");
    await page.keyboard.press("Shift+Tab");
    await expect(prepare).toBeFocused();
    // Space on the join bar selects the parallel step.
    await join.focus();
    await page.keyboard.press(" ");
    await expect(join).toHaveAttribute("aria-pressed", "true");
    await expect(details.locator("h2")).toHaveText("fan");
    // The view's buttons work from the keyboard.
    const before = await settledView(graph);
    await graph.getByRole("button", { name: "Zoom in", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await viewOf(graph)).scale).toBeGreaterThan(before.scale * 1.05);
    await shot(page, "parallel-fixture-1440");
    expect(errors).toEqual([]);
});

test("parallel fixture: the same graph mounts on a phone, its join bar selects the parallel step", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeV2(page, { events: PARALLEL_EVENTS, readModel: () => PARALLEL_MODEL, onCommand: (route, command) => accept(route, command) });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const main = page.locator(".ps-workflow-main");
    const graph = main.getByRole("group", { name: "Workflow graph" });
    await flowReady(graph);
    await expect(graph.locator(".ps-workflow-node")).toHaveCount(6);
    await expect(graph.getByRole("group", { name: /^Each branch of fan/ })).toBeVisible();
    const join = graph.getByRole("button", { name: /^Join of fan: join · first 2 of 3/ });
    await settledView(graph);
    await join.click();
    await expect(join).toHaveAttribute("aria-pressed", "true");
    // On a phone a tap only selects; Step details opens it (flow-04).
    await main.getByRole("button", { name: "Step details", exact: true }).click();
    await expect(page.locator(".ps-workflow-node-details").filter({ visible: true }).locator("h2")).toHaveText("fan");
    await shot(page, "parallel-fixture-390");
    expect(errors).toEqual([]);
});
