// Workflow sessions in the portal, in a real browser:
//   - the session list marks workflow sessions with a flowchart icon
//   - its transcript is the execution log, and the composer says why there
//     is no chat box
//   - New → "Workflow instead" opens the YAML editor, Create sends the
//     YAML and inputs and opens the new session, and a refusal keeps the text
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

async function shot(page, name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

async function routeApi(page, { onCreate, workflowEvents = WORKFLOW_EVENTS, onSocket = () => {}, workflowState = {} } = {}) {
    await page.routeWebSocket("**/api/v1/ws", onSocket);
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const pathname = new URL(req.url()).pathname;
        const answer = (result) => route.fulfill({ json: { ok: true, result } });
        const sessions = SESSIONS.map(session => session.sessionId === WORKFLOW_ID ? { ...session, ...workflowState } : session);
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

    const chat = page.locator(".ps-chat-panel");
    await chat.locator(".ps-system-notice-summary", { hasText: "Workflow: nightly-report" }).click();
    await expect(chat).toContainText("Workflow nightly-report 1.0.0 started: 5 states, initial collect");
    await expect(chat).toContainText("found → report, empty → nothing, failure → failed");
    await expect(chat).toContainText("ends: succeeded");
    await expect(chat).toContainText("Step 1: collect → found in 1.8 s · 1 tool call (read_facts)");
    await expect(chat).toContainText("Step 2: report → done");
    await expect(chat).toContainText("Workflow nightly-report reached published after 2 steps: outcome succeeded. Report published.");

    await expect(page.locator(".ps-composer-readonly")).toHaveText("Workflow session");
    await expect(page.locator(".ps-prompt-input")).toHaveCount(0);
    await shot(page, "1-workflow-session-execution-log");
    expect(errors).toEqual([]);
});

test("new top-level workflows explain the parent requirement without sending a create", async ({ page }) => {
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
    const workflow = page.getByRole("button", { name: /Workflows start from an agent/ });
    await expect(workflow).toBeDisabled();
    await expect(workflow).toHaveAttribute("title", /spawn_workflow/);
    expect(created).toHaveLength(0);
    await expect(page.locator(".ps-workflow-modal")).toHaveCount(0);
    await shot(page, "3-workflow-child-first");
    expect(errors).toEqual([]);
});

test("the child-first restriction leaves the ordinary agent conversation available", async ({ page }) => {
    await routeApi(page, {
        onCreate: (route) => route.fulfill({
            status: 400,
            json: { ok: false, error: { code: "WORKFLOW_INVALID", message: "Invalid workflow: states.collect.type 'agent' is not supported yet; this version runs script and terminal states." } },
        }),
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    await page.getByRole("button", { name: "New session — choose model and agent", exact: true }).click();
    await expect(page.getByRole("button", { name: /Workflows start from an agent/ })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.locator(".ps-prompt-input")).toBeVisible();
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
        const summary = page.locator(".ps-workflow-progress");
        await expect(summary).toHaveCount(1);
        await expect(summary.locator("summary")).toContainText("Waiting for changes");
        await expect(summary.locator("summary")).toContainText("28 checks");
        await expect(summary.locator(".ps-system-notice-summary-text")).toHaveAttribute("aria-live", "polite");
        await expect(summary.locator(".ps-workflow-glyph")).toHaveAttribute("aria-hidden", "true");
        await expect(summary).not.toHaveAttribute("open", "");
        await expect(page.locator(".ps-composer-readonly")).toHaveText("Workflow session");
        const footer = await page.locator(".ps-chat-composer.is-workflow").boundingBox();
        expect(footer.height).toBeLessThan(48);
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
        await expect(page.locator(".ps-workflow-progress")).toHaveCount(1);
        await expect(page.locator(".ps-workflow-progress summary")).toContainText("29 checks");
        await shot(page, `poll-summary-${viewport.width}`);
        expect(errors).toEqual([]);
    });
}

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

test("a workflow's live canvas opens with the session and follows each step", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const graph = compileWorkflow(LIVE_YAML);
    const html = buildWorkflowCanvasHtml(graph, foldWorkflowCanvasState([], graph));
    const log = [
        { eventType: "workflow.started", data: { name: "nightly-report", states: Object.values(graph.states).map((n) => ({ id: n.id, type: n.type })) } },
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

    // No click: a workflow session opens on its canvas.
    const frame = page.frameLocator(".ps-side-pane-layer:not(.is-parked) iframe.ps-html-preview-frame:not(.is-staging)");
    await expect(frame.locator("#status")).toHaveText("running");
    await expect(frame.locator("#where")).toHaveText("step 3 · running summarize");
    await expect(frame.locator("g.node.done")).toHaveCount(1);
    await expect(frame.locator("g.node.running")).toHaveCount(1);
    await expect(frame.locator("g.node.running text").first()).toHaveText("summarize");
    await expect(frame.locator("g.node.running .runs")).toHaveText("×2");
    await expect(frame.locator("g.edge.taken")).toHaveCount(2);
    await expect(frame.locator("#steps tr")).toHaveCount(3);
    await shot(page, "6-live-canvas-running");

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
    await expect(frame.locator("#status")).toHaveText("completed");
    await expect(frame.locator("g.node.done")).toHaveCount(4);
    await expect(frame.locator("g.node.terminal.done text").first()).toHaveText("published");
    await expect(frame.locator("g.node.running")).toHaveCount(0);
    await expect(frame.locator("g.node.terminal")).toHaveCount(3);
    await expect(frame.locator("#note")).toContainText("Outcome succeeded — Report published.");
    await shot(page, "7-live-canvas-completed");
    expect(errors).toEqual([]);
});
