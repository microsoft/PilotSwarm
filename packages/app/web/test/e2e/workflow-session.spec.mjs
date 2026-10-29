// Script workflow sessions in the portal, in a real browser:
//   - the session list marks a workflow session (⛓) beside agent sessions
//   - its transcript is the execution log, and the composer says why there
//     is no chat box
//   - New → "Script workflow instead" opens the YAML editor, Create sends the
//     YAML and inputs and opens the new session, and a refusal keeps the text
//
// PS_E2E_SHOT_DIR, when set, receives screenshots of each state for review.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { startStubServer } from "./stub-server.mjs";

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
        entry: "collect",
        nodes: [
            { id: "collect", runtime: "python", timeoutSeconds: 300, next: { found: "report", empty: null, failure: null } },
            { id: "report", runtime: "node", timeoutSeconds: 300, next: { done: null } },
        ],
    }, 0),
    ev("workflow.node_started", { nodeId: "collect", runtime: "python", step: 1 }, 100),
    ev("workflow.node_completed", {
        nodeId: "collect", step: 1, outcome: "found", resultSource: "reported", exitCode: 0, durationMs: 1840,
        toolCalls: [{ name: "read_facts", ok: true, durationMs: 40 }], outputPreview: "{\"count\":3}",
    }, 2000),
    ev("workflow.node_started", { nodeId: "report", runtime: "node", step: 2 }, 2100),
    ev("workflow.node_completed", {
        nodeId: "report", step: 2, outcome: "done", resultSource: "reported", exitCode: 0, durationMs: 420,
        toolCalls: [{ name: "store_fact", ok: true, durationMs: 30 }], outputPreview: "{\"count\":3}",
    }, 2600),
    ev("workflow.completed", { name: "nightly-report", steps: 2, outcome: "done", terminalNodeId: "report", outputPreview: "{\"count\":3}" }, 2700),
];

let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

async function shot(page, name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

async function routeApi(page, { onCreate } = {}) {
    await page.routeWebSocket("**/api/v1/ws", () => {});
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const pathname = new URL(req.url()).pathname;
        const answer = (result) => route.fulfill({ json: { ok: true, result } });
        if (pathname.endsWith("/models")) return answer([{ providerId: "test", modelName: "test-model", qualifiedName: "test:test-model" }]);
        if (pathname.endsWith("/providers")) return answer({ providers: [{ name: "test", typeId: "test", class: "shared", hasCredential: true, usableByMe: true }] });
        if (pathname.endsWith("/providers/status")) return answer({ providers: [] });
        if (pathname.endsWith("/defaults")) return answer({});
        if (pathname.endsWith("/management/sessions")) return answer({ sessions: SESSIONS, hasMore: false, nextCursor: null });
        if (pathname.endsWith("/sessions") && req.method() === "GET") return answer({ sessions: SESSIONS, hasMore: false });
        if (pathname.endsWith("/sessions/workflow") && req.method() === "POST") return onCreate(route, req.postDataJSON());
        if (pathname.includes(`/sessions/${WORKFLOW_ID}/events`)) return answer(WORKFLOW_EVENTS);
        if (pathname.includes(`/sessions/${CREATED_ID}/events`)) return answer([]);
        if (pathname.endsWith(`/sessions/${WORKFLOW_ID}`)) return answer({ ...SESSIONS[1], events: [], messages: [] });
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
    await expect(workflowRow).toContainText("⛓");
    await expect(page.locator(".ps-session-row-content", { hasText: "Release triage agent" }).first()).not.toContainText("⛓");

    const chat = page.locator(".ps-chat-panel");
    await expect(chat).toContainText("Workflow nightly-report started: 2 nodes, entry collect");
    await expect(chat).toContainText("found → report, empty → end, failure → end");
    await expect(chat).toContainText("Step 1: collect → found in 1.8 s · 1 tool call (read_facts)");
    await expect(chat).toContainText("Step 2: report → done");
    await expect(chat).toContainText("Workflow nightly-report completed after 2 steps with outcome done at report");

    await expect(page.locator(".ps-composer-readonly")).toContainText("Workflow session — it runs a script graph");
    await expect(page.locator(".ps-prompt-input")).toHaveCount(0);
    await shot(page, "1-workflow-session-execution-log");
    expect(errors).toEqual([]);
});

test("New → Script workflow opens the editor, creates the session and opens it", async ({ page }) => {
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
    await page.getByRole("button", { name: "⛓ Script workflow instead" }).click();

    const yaml = page.locator("#ps-workflow-yaml");
    await expect(yaml).toBeVisible();
    await expect(yaml).toHaveValue(/kind: ScriptWorkflow/);
    await expect(yaml).toHaveValue(/runtime: python/);
    // Typing in the editor must stay in the editor: "n" is the global
    // new-session shortcut, and Enter confirms other dialogs.
    await page.locator("#ps-workflow-inputs").fill("");
    await page.locator("#ps-workflow-inputs").type("{\"keyPattern\": \"metrics/%\"}");
    await yaml.press("End");
    await yaml.press("Enter");
    await expect(page.locator(".ps-workflow-modal")).toBeVisible();
    await shot(page, "3-workflow-editor");

    await page.getByRole("button", { name: "Create workflow" }).click();
    await expect.poll(() => created.length).toBe(1);
    expect(created[0].yaml).toMatch(/kind: ScriptWorkflow/);
    expect(created[0].inputs).toEqual({ keyPattern: "metrics/%" });
    await expect(page.locator(".ps-workflow-modal")).toHaveCount(0);
    await expect(page.locator(".ps-composer-readonly")).toContainText("Workflow session");
    await shot(page, "4-created-workflow-session");
    expect(errors).toEqual([]);
});

test("a refused workflow keeps the editor open with the reason and the text", async ({ page }) => {
    await routeApi(page, {
        onCreate: (route) => route.fulfill({
            status: 400,
            json: { ok: false, error: { code: "WORKFLOW_INVALID", message: "Invalid workflow: spec.nodes.collect.type must be 'script'; agent nodes are not supported." } },
        }),
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    await page.getByRole("button", { name: "New session — choose model and agent", exact: true }).click();
    await page.getByRole("button", { name: "⛓ Script workflow instead" }).click();
    const yaml = page.locator("#ps-workflow-yaml");
    await yaml.fill(String(await yaml.inputValue()).replace("type: script", "type: agent"));
    await page.getByRole("button", { name: "Create workflow" }).click();
    await expect(page.locator(".ps-workflow-modal [role=alert]")).toContainText("agent nodes are not supported");
    await expect(yaml).toHaveValue(/type: agent/);
    await shot(page, "5-workflow-editor-refusal");
});
