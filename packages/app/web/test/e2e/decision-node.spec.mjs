// Workflow Decision nodes in the mounted Portal. The Web API and bootstrap are
// fixtures over the shared stub server; no model provider or live Azure service
// is used.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { startProviderBudgetStub } from "./providers-budget-stub.mjs";
import { collectPageErrors } from "./page-errors.mjs";

const OWNER_ID = "11111110-2222-3333-4444-555555555550";
const WORKFLOW_ID = "77777777-2222-3333-4444-555555555555";
const CHAT_MODEL = "shared-chat:gpt-chat";
const DECISION_DEFAULT = "shared-decision:ps-decision-1-1";
const DECISION_REVIEW = "shared-decision:review-decision";
const DECISION_MODELS = [DECISION_DEFAULT, DECISION_REVIEW];
const CAPABILITY = {
    available: true,
    defaultModel: DECISION_DEFAULT,
    models: DECISION_MODELS,
    reason: null,
};

const CHOICE_STATE = {
    id: "route_ticket",
    type: "decision",
    input: "${input}",
    question: {
        type: "choice",
        instructions: "Which team should handle this ticket?",
        criteria: {
            engineering: "Bugs and outages",
            billing: "Payments and refunds",
            support: "Account access",
        },
    },
    confidence: { minimumProbability: 0.8 },
    next: { engineering: "done", billing: "done", support: "done", uncertain: "done", failure: "done" },
};
const SCORE_STATE = {
    id: "score_ticket",
    type: "decision",
    input: "${input}",
    question: {
        type: "score",
        instructions: "Score the release risk.",
        levels: ["minor", "moderate", "major"],
    },
    confidence: { minimumProbability: null },
    next: { scored: "done", uncertain: "done", failure: "done" },
};
const DONE_STATE = { id: "done", type: "terminal", outcome: "succeeded" };
const CHOICE_STATES = [CHOICE_STATE, DONE_STATE];
const SCORE_STATES = [SCORE_STATE, DONE_STATE];

const CHOICE_OUTPUT = {
    questionType: "choice",
    outcome: "uncertain",
    selection: "engineering",
    confidence: 0.75,
    probabilities: { engineering: 0.75, billing: 0.125, support: 0.125 },
    policy: { minimumProbability: 0.8, uncertain: true },
    model: { qualified: DECISION_DEFAULT },
    attemptId: "attempt-secret",
    requestId: "request-secret",
    providerPayload: { raw: "provider-secret" },
    latencyMs: 999,
    usage: { total: 100 },
};
const SCORE_OUTPUT = {
    questionType: "score",
    outcome: "scored",
    score: 3.5,
    levels: [
        { level: "minor", probability: 0.1 },
        { level: "moderate", probability: 0.25 },
        { level: "major", probability: 0.65 },
    ],
    policy: { minimumProbability: null, uncertain: false },
    model: { qualified: DECISION_REVIEW },
    attemptId: "score-attempt-secret",
    requestId: "score-request-secret",
    providerPayload: { raw: "score-provider-secret" },
    latencyMs: 321,
    usage: { total: 77 },
};

function startModel(states) {
    return {
        workflowId: WORKFLOW_ID,
        definition: { state: "published", semver: "1.0.0", currentRevision: 1, publishedRevision: 1, publishedDefinitionHash: "hash-decision" },
        revision: { revision: 1, definitionHash: "hash-decision", valid: true, irSha256: "ir-decision", name: "decision-demo", diagnostics: [] },
        graph: { revision: 1, initial: states[0].id, states },
        runs: [],
        run: null,
        personCommands: { operations: ["start"], viewer: { allowed: true } },
    };
}

function completedModel(states, output) {
    const state = states[0];
    return {
        ...startModel(states),
        runs: [{ runId: "run-decision-1", mode: "live", status: "completed", revision: 1, outcome: "succeeded" }],
        run: {
            runId: "run-decision-1", mode: "live", status: "completed", outcome: "succeeded", terminalState: "done",
            output: null, error: null, kvRevision: 1, kv: "{}", inbox: [], outbox: [],
            nodeExecutions: [{
                nodeExecutionId: `nx-${state.id}-1`, stateId: state.id, ordinal: 1, state: "completed",
                outcome: output.outcome, resultKind: "business", winner: "effect", attempts: 1, kvRevision: 1,
                outputPreview: JSON.stringify(output),
            }],
        },
        personCommands: { operations: [], viewer: { allowed: true } },
    };
}

let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1, admin: true }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const workflowTab = (page) => page.locator(".ps-wf-tab").filter({ visible: true }).first();
const viewSwitch = (tab, name) => tab.getByRole("group", { name: "Definition or Workflows" }).getByRole("button", { name, exact: true });
const answer = (route, result) => route.fulfill({ json: { ok: true, result } });

async function routeDecisionPortal(page, { decision = CAPABILITY, model = startModel(CHOICE_STATES) } = {}) {
    const owner = {
        sessionId: OWNER_ID, title: "Release triage", status: "idle", model: CHAT_MODEL,
        createdAt: 1_785_000_000_000, updatedAt: 1_785_000_000_000,
    };
    const workflow = {
        sessionId: WORKFLOW_ID, title: "Workflow: decision-demo", sessionKind: "workflow", parentSessionId: OWNER_ID,
        status: model.run ? "completed" : "pending", model: null,
        createdAt: 1_785_000_001_000, updatedAt: 1_785_000_001_000,
    };
    const sessions = [owner, workflow];
    await page.routeWebSocket("**/api/v1/ws", () => {});
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const pathname = url.pathname;
        if (pathname.endsWith("/bootstrap")) {
            return route.fulfill({ json: {
                ok: true, mode: "remote", workerCount: 1, defaultModel: CHAT_MODEL,
                modelsByProvider: [], logConfig: { available: false, availabilityReason: "decision E2E fixture" },
                auth: {
                    principal: { provider: "dev", subject: "viewer", email: "viewer@example.invalid", displayName: "Decision viewer", groups: [], roles: ["user"] },
                    authorization: { allowed: true, role: "user", reason: "fixture", matchedGroups: [] },
                },
                workflows: { schema: 1, enabled: true, decision },
            } });
        }
        if (pathname.endsWith("/models")) return answer(route, [{ providerId: "shared-chat", modelName: "gpt-chat", qualifiedName: CHAT_MODEL }]);
        if (pathname.endsWith("/providers")) return answer(route, { providers: [] });
        if (pathname.endsWith("/providers/status")) return answer(route, { providers: [] });
        if (pathname.endsWith("/defaults")) return answer(route, {});
        if (pathname.endsWith("/management/sessions")) return answer(route, { sessions, hasMore: false, nextCursor: null });
        if (pathname.endsWith("/sessions") && req.method() === "GET") return answer(route, { sessions, hasMore: false });
        if (pathname.endsWith(`/sessions/${WORKFLOW_ID}/workflow`) && req.method() === "GET") {
            const revision = Number(url.searchParams.get("definitionRevision"));
            const shown = Number.isSafeInteger(revision) && revision > 0
                ? { ...model, definitionRevision: {
                    revision, definitionHash: "hash-decision",
                    yaml: "apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: decision-demo, version: 1.0.0 }\n",
                } }
                : model;
            return answer(route, shown);
        }
        if (pathname.endsWith(`/sessions/${OWNER_ID}/events`) || pathname.endsWith(`/sessions/${WORKFLOW_ID}/events`)) return answer(route, []);
        const session = pathname.endsWith(`/sessions/${WORKFLOW_ID}`) ? workflow
            : pathname.endsWith(`/sessions/${OWNER_ID}`) ? owner : null;
        if (session) return answer(route, { ...session, events: [], messages: [], pendingMessages: [] });
        return route.fallback();
    });
}

async function openDefinition(page, fixture = {}) {
    await routeDecisionPortal(page, fixture);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const tab = workflowTab(page);
    await expect(tab).toBeVisible();
    await viewSwitch(tab, "Definition").click();
    await expect(tab).toHaveAttribute("data-view", "definition");
    return tab;
}

async function openNode(page, model, nodeId) {
    await routeDecisionPortal(page, { model });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${WORKFLOW_ID}`);
    const tab = workflowTab(page);
    const node = tab.getByRole("button", { name: `Inspect ${nodeId}`, exact: true });
    await expect(node).toBeVisible();
    await node.click();
    const details = tab.getByRole("region", { name: "Node details", exact: true });
    await expect(details).toBeVisible();
    return details;
}

async function optionValues(select) {
    return select.locator("option").evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
}

async function expectFits(page, dialog) {
    await expect(dialog).toBeInViewport();
    const geometry = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const body = element.querySelector(".ps-wf-dialog-body");
        const decisionRow = element.querySelector(".ps-wf-decision-model");
        const select = decisionRow?.querySelector("select");
        const rowRect = decisionRow?.getBoundingClientRect();
        const selectRect = select?.getBoundingClientRect();
        return {
            viewport: innerWidth,
            pageWidth: document.documentElement.scrollWidth,
            left: rect.left,
            right: rect.right,
            dialogOverflow: element.scrollWidth - element.clientWidth,
            bodyOverflow: body ? body.scrollWidth - body.clientWidth : 0,
            rowOverflow: decisionRow ? decisionRow.scrollWidth - decisionRow.clientWidth : 0,
            selectInside: !rowRect || !selectRect
                || (selectRect.left >= rowRect.left - 1 && selectRect.right <= rowRect.right + 1),
        };
    });
    expect(geometry.pageWidth, "document width").toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.left, "dialog left edge").toBeGreaterThanOrEqual(0);
    expect(geometry.right, "dialog right edge").toBeLessThanOrEqual(geometry.viewport + 1);
    expect(geometry.dialogOverflow, "dialog horizontal overflow").toBeLessThanOrEqual(1);
    expect(geometry.bodyOverflow, "dialog body horizontal overflow").toBeLessThanOrEqual(1);
    expect(geometry.rowOverflow, "Decision row horizontal overflow").toBeLessThanOrEqual(1);
    expect(geometry.selectInside, "Decision picker stays inside its row").toBe(true);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`available capability exposes only the Decision catalog without clipping at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const errors = [];
        page.on("pageerror", collectPageErrors(errors));
        const tab = await openDefinition(page);
        const start = tab.getByRole("button", { name: "Start…", exact: true });
        await expect(start).toBeEnabled();
        await start.click();
        const dialog = page.getByRole("dialog", { name: "Start decision-demo", exact: true });
        const picker = dialog.getByRole("combobox", { name: "Decision model for route_ticket", exact: true });
        await expect(picker).toBeVisible();
        await expect(picker).toHaveValue("");
        await expect.poll(() => optionValues(picker)).toEqual(DECISION_MODELS);
        await expect(dialog).not.toContainText(CHAT_MODEL);
        await expect(dialog.locator("[data-decision-node='route_ticket']")).toBeVisible();
        await expectFits(page, dialog);
        expect(errors).toEqual([]);
    });
}

test("an unavailable capability explains the Cluster Decision Default and disables Start", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const tab = await openDefinition(page, {
        decision: { available: false, defaultModel: null, models: [], reason: "no_cluster_decision_default" },
    });
    await expect(tab.getByRole("button", { name: "Start…", exact: true })).toBeDisabled();
    const notice = tab.locator('[data-field="decision-availability"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Cluster Decision Default");
    await expect(notice).toContainText("Admin Settings");
    await expect(notice).toContainText("replace or remove the Decision node");
    await expect(page.getByRole("dialog", { name: "Start decision-demo", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
});

test("a completed uncertain choice renders semantic Decision facts and redacts transport detail", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const details = await openNode(page, completedModel(CHOICE_STATES, CHOICE_OUTPUT), "route_ticket");
    await expect(details.locator('[data-fact="decision-type"] strong')).toHaveText("Decision");
    await expect(details.locator('[data-fact="decision-model"] strong')).toHaveText(DECISION_DEFAULT);
    await expect(details.locator('[data-fact="decision-outcome"] strong')).toHaveText("Uncertain");
    await expect(details.locator('[data-fact="decision-uncertain"] strong')).toHaveText("Yes");
    await expect(details.locator('[data-fact="decision-confidence"] strong')).toHaveText("75%");
    await expect(details.locator('[data-fact="decision-threshold"] strong')).toHaveText("80%");
    await expect(details.locator('[data-fact="decision-probabilities"] strong'))
        .toHaveText("engineering 75% · billing 12.5% · support 12.5%");
    await expect(details.locator('[data-fact="result"]')).toContainText("Uncertain · selected engineering · 75% confidence");
    const rendered = await details.innerText();
    for (const hidden of [
        "attemptId", "requestId", "providerPayload", "latencyMs", "usage",
        "attempt-secret", "request-secret", "provider-secret",
    ]) expect(rendered, hidden).not.toContain(hidden);
    expect(errors).toEqual([]);
});

test("a completed score node shows its score and keeps the provider's level order", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const details = await openNode(page, completedModel(SCORE_STATES, SCORE_OUTPUT), "score_ticket");
    await expect(details.locator('[data-fact="decision-score"] strong')).toHaveText("3.5");
    await expect(details.locator('[data-fact="decision-levels"] strong'))
        .toHaveText("minor 10% · moderate 25% · major 65%");
    await expect(details.locator('[data-fact="result"]'))
        .toContainText("Scored · score 3.5 · minor 10% · moderate 25% · major 65%");
    const rendered = await details.innerText();
    for (const hidden of ["attemptId", "requestId", "providerPayload", "latencyMs", "usage", "score-attempt-secret"])
        expect(rendered, hidden).not.toContain(hidden);
    expect(errors).toEqual([]);
});

const ADMIN_PROVIDERS = [
    {
        name: "shared-chat", typeId: "github-copilot", class: "shared", hasCredential: true, usableByMe: true,
        systemUseEnabled: true, systemEligible: true, isClusterDefault: true,
    },
    {
        name: "shared-decision", typeId: "foundry-wif", class: "shared", hasCredential: true, usableByMe: true,
        systemUseEnabled: false, systemEligible: true,
    },
];
const ADMIN_CHAT_MODELS = [{ providerId: "shared-chat", providerType: "github-copilot", modelName: "gpt-chat", qualifiedName: CHAT_MODEL }];
const ADMIN_DECISION_MODELS = DECISION_MODELS.map((qualifiedName, index) => ({
    providerId: "shared-decision", providerType: "foundry-wif", modelName: qualifiedName.split(":")[1], qualifiedName,
    description: index ? "Review routing" : "Workflow decisions",
}));
const configured = (model) => ({ provider: model.split(":")[0], model, reasoning: null, context: null });
const effective = (model, source) => ({ provider: model.split(":")[0], model, reasoningEffort: null, contextTier: null, source });

async function routeDecisionAdmin(page) {
    const writes = [];
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const pathname = new URL(req.url()).pathname;
        if (pathname.endsWith("/providers") && req.method() === "GET") return answer(route, { providers: ADMIN_PROVIDERS });
        if (pathname.endsWith("/models/by-provider") && req.method() === "GET") {
            return answer(route, [{ providerId: "shared-chat", type: "github-copilot", models: ADMIN_CHAT_MODELS }]);
        }
        if (pathname.endsWith("/models/decision") && req.method() === "GET") return answer(route, ADMIN_DECISION_MODELS);
        if (pathname.endsWith("/model-defaults")) {
            if (req.method() === "PUT") {
                writes.push(req.postDataJSON());
                return answer(route, {});
            }
            return answer(route, {
                userSession: { configured: configured(CHAT_MODEL), effective: effective(CHAT_MODEL, "user_default") },
                clusterSession: { configured: configured(CHAT_MODEL), effective: effective(CHAT_MODEL, "cluster_default") },
                clusterDecision: { configured: configured(DECISION_DEFAULT), effective: effective(DECISION_DEFAULT, "cluster_decision_default"), error: null },
                system: { configured: configured(CHAT_MODEL), effective: effective(CHAT_MODEL, "system_default") },
                systemOverrides: [],
            });
        }
        return route.fallback();
    });
    return writes;
}

test("Admin Cluster Decision Default uses the separate Decision catalog and writes a Decision-scoped default", async ({ page }) => {
    const server = await startProviderBudgetStub({ admin: true });
    try {
        await page.setViewportSize({ width: 1440, height: 900 });
        const errors = [];
        page.on("pageerror", collectPageErrors(errors));
        const writes = await routeDecisionAdmin(page);
        await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "networkidle" });
        await page.locator(".ps-session-list-button").first().waitFor();
        await page.locator('button[aria-label="Admin console"]').click();
        await page.getByRole("button", { name: "Shared Providers", exact: true }).click();

        const chatDefault = page.getByRole("combobox", { name: "Cluster Session Default", exact: true });
        const decisionDefault = page.getByRole("combobox", { name: "Cluster Decision Default", exact: true });
        const systemDefault = page.getByRole("combobox", { name: "Model", exact: true });
        await expect(decisionDefault).toBeVisible();
        await expect(decisionDefault).toHaveValue(DECISION_DEFAULT);
        await expect.poll(() => optionValues(decisionDefault)).toEqual(DECISION_MODELS);
        await expect.poll(() => optionValues(chatDefault)).toEqual([CHAT_MODEL]);
        await expect.poll(() => optionValues(systemDefault)).toEqual([CHAT_MODEL]);
        await expect(chatDefault.locator(`option[value="${DECISION_DEFAULT}"]`)).toHaveCount(0);
        await expect(systemDefault.locator(`option[value="${DECISION_DEFAULT}"]`)).toHaveCount(0);
        await expect(decisionDefault.locator(`option[value="${CHAT_MODEL}"]`)).toHaveCount(0);

        await decisionDefault.selectOption(DECISION_REVIEW);
        await expect.poll(() => writes.length).toBe(1);
        expect(writes[0]).toMatchObject({
            scope: "cluster_decision",
            provider: "shared-decision",
            model: DECISION_REVIEW,
            reasoningEffort: null,
            contextTier: null,
        });
        expect(errors).toEqual([]);
    } finally {
        await server.close();
    }
});
