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
        instructions: "How severe is this incident?",
        criteria: ["Cosmetic", "Minor", "Major", "Critical"],
    },
    next: { scored: "done", failure: "done" },
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
    score: 2.37,
    levels: [
        { label: "Cosmetic", probability: 0.01 },
        { label: "Minor", probability: 0.07 },
        { label: "Major", probability: 0.42 },
        { label: "Critical", probability: 0.5 },
    ],
    model: { qualified: DECISION_REVIEW },
};

const SCORE_TRANSPORT_FIELDS = {
    attemptId: "score-attempt-secret",
    requestId: "score-request-secret",
    providerPayload: { raw: "score-provider-secret" },
    latencyMs: 321,
    usage: { total: 77 },
};

function semanticSummary(output, truncated = false) {
    return {
        questionType: output.questionType,
        outcome: output.outcome,
        selection: output.selection ?? null,
        confidence: output.confidence ?? null,
        score: output.score ?? null,
        probabilities: Object.entries(output.probabilities ?? {}).map(([label, probability]) => ({ label, probability })),
        levels: output.levels ?? [],
        policy: output.policy ?? null,
        model: output.model.qualified,
        truncated,
    };
}

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

function completedModel(states, output, { decisionSummary = semanticSummary(output), outputPreview = null,
    decisionInference = undefined } = {}) {
    const state = states[0];
    const raw = JSON.stringify(output);
    const nodeExecutionId = `nx-${state.id}-1`;
    const wholeResult = { kind: "output", bytes: Buffer.byteLength(raw, "utf8"), whole: true, value: output };
    return {
        ...startModel(states),
        runs: [{ runId: "run-decision-1", mode: "live", status: "completed", revision: 1, outcome: "succeeded" }],
        run: {
            runId: "run-decision-1", mode: "live", status: "completed", outcome: "succeeded", terminalState: "done",
            output: null, error: null, kvRevision: 1, kv: "{}", inbox: [], outbox: [],
            nodeExecutions: [{
                nodeExecutionId, stateId: state.id, ordinal: 1, state: "completed",
                outcome: output.outcome, resultKind: "business", winner: "effect", attempts: 1, kvRevision: 1,
                outputPreview: outputPreview ?? (raw.length > 500 ? `${raw.slice(0, 500)}…` : raw),
                decisionSummary,
                ...(decisionInference ? { decisionInference } : {}),
            }],
        },
        personCommands: { operations: [], viewer: { allowed: true } },
        wholeResult: { nodeExecutionId, result: wholeResult },
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
            const executionId = url.searchParams.get("executionId");
            if (executionId && model.wholeResult?.nodeExecutionId === executionId) {
                return answer(route, {
                    workflowId: WORKFLOW_ID, runId: model.run.runId,
                    execution: { nodeExecutionId: executionId, state: "completed", result: model.wholeResult.result },
                });
            }
            const { wholeResult, ...readModel } = model;
            const revision = Number(url.searchParams.get("definitionRevision"));
            const shown = Number.isSafeInteger(revision) && revision > 0
                ? { ...readModel, definitionRevision: {
                    revision, definitionHash: "hash-decision",
                    yaml: "apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: decision-demo, version: 1.0.0 }\n",
                } }
                : readModel;
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

// Owner 2026-11-20 (negative cases): the page showed Decision available, but the Cluster Decision Default was cleared or its
// model removed before Start reached the server. The server's refusal is shown in the dialog in its own words, the dialog stays
// open, and nothing says the Workflow started.
test("a Start the server refuses for an unavailable Cluster Decision Default says why and starts nothing", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const refusal = "Decision nodes are unavailable because no eligible Cluster Decision Default is configured. "
        + "Configure an eligible Decision model in Admin Settings, or replace the Decision node. Nothing was started.";
    const commands = [];
    const tab = await openDefinition(page);
    await page.route(`**/api/v1/sessions/${WORKFLOW_ID}/workflow/commands`, async (route) => {
        commands.push(route.request().postDataJSON());
        await route.fulfill({ status: 409, json: { ok: false, error: { code: "WORKFLOW_DECISION_MODEL_UNAVAILABLE", message: refusal } } });
    });
    await tab.getByRole("button", { name: "Start…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Start decision-demo", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-operation="start"]').click();
    await expect(dialog).toContainText(`Start refused: ${refusal}`);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-operation="start"]')).toBeEnabled();
    expect(commands).toHaveLength(1);
    expect(commands[0].command?.operation ?? commands[0].operation).toBe("start");
    await expect(page.getByText(/^Started /)).toHaveCount(0);
    expect(errors).toEqual([]);
});

// Owner 2026-11-20: "Just like script and other nodes have icons, I want decision nodes to have icons as well. Also the node
// tab should display, like the script node, full info (maybe collapsed) on the decision prompts etc."
const LONG_INSTRUCTIONS = [
    "Which team should handle this ticket? Read the whole ticket, not only its title.",
    "Route outages to engineering even when the customer mentions a refund.",
];
const LONG_CHOICE_STATES = [{ ...CHOICE_STATE, question: { ...CHOICE_STATE.question, instructions: LONG_INSTRUCTIONS.join("\n") } }, DONE_STATE];

async function openDefinitionNode(page, states, nodeId) {
    const tab = await openDefinition(page, { model: startModel(states) });
    const node = tab.getByRole("button", { name: `Inspect ${nodeId}`, exact: true });
    await expect(node).toBeVisible();
    await node.click();
    const panel = tab.locator('section[aria-label="Node"]');
    await expect(panel).toBeVisible();
    return { tab, node, panel };
}

test("a Decision card has its own icon, in the decision colour", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const tab = await openDefinition(page);
    const node = tab.getByRole("button", { name: "Inspect route_ticket", exact: true });
    await expect(node).toBeVisible();
    await expect(node).toHaveAttribute("data-kind", "decision");
    const icon = node.locator(".ps-workflow-node-icon");
    await expect(icon).toBeVisible();
    await expect(icon.locator("svg.ps-workflow-node-glyph")).toHaveCount(1);
    await expect(icon.locator("svg.ps-workflow-node-glyph")).toHaveAttribute("aria-hidden", "true");
    await expect(icon.locator('svg path[d="M12 2l10 10-10 10L2 12z"]')).toHaveCount(1);
    const colours = await icon.evaluate((element) => {
        const resolve = (value) => {
            const probe = document.createElement("span");
            probe.style.color = value;
            document.body.append(probe);
            const colour = getComputedStyle(probe).color;
            probe.remove();
            return colour;
        };
        const root = getComputedStyle(document.documentElement);
        return {
            actual: getComputedStyle(element).color,
            decision: resolve(root.getPropertyValue("--ps-wf-icon-decision").trim() || "#34d399"),
            other: resolve(root.getPropertyValue("--ps-wf-icon-other").trim() || "rgb(0, 0, 0)"),
        };
    });
    expect(colours.actual).toBe(colours.decision);
    expect(colours.actual).not.toBe(colours.other);
    expect(errors).toEqual([]);
});

test("a Decision node's Node panel shows its whole question, closed until opened, with its threshold and model", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const { panel } = await openDefinitionNode(page, LONG_CHOICE_STATES, "route_ticket");
    // The first sentence stays as its one-line summary.
    await expect(panel.locator('[data-node-what="true"]')).toHaveText("Runs a Decision model: “Which team should handle this ticket?”");
    await expect(panel.locator('[data-fact="decision-confidence-threshold"] span')).toHaveText("Confidence threshold");
    await expect(panel.locator('[data-fact="decision-confidence-threshold"] strong')).toHaveText("Below 80% confidence → uncertain");
    await expect(panel.locator('[data-fact="decision-model"] strong')).toHaveText(`${DECISION_DEFAULT} · Cluster Decision Default`);
    const question = panel.locator('details[data-section="decision-question"]');
    await expect(question).toHaveCount(1);
    await expect(question).toHaveJSProperty("open", false);
    await expect(question.locator(":scope > summary")).toHaveText("Decision question · Choice · 3 options");
    await expect(question.locator(".ps-wf-decision-instructions")).toBeHidden();
    await question.locator(":scope > summary").click();
    await expect(question).toHaveJSProperty("open", true);
    const instructions = question.locator('[data-field="decision-instructions"] .ps-wf-decision-instructions');
    await expect(instructions).toBeVisible();
    for (const sentence of LONG_INSTRUCTIONS) await expect(instructions).toContainText(sentence);
    const criteria = question.locator('[data-field="decision-criteria"]');
    await expect(criteria.locator(".ps-wf-decision-heading")).toHaveText("Options");
    await expect(criteria.locator("thead th")).toHaveText(["Option", "Description"]);
    const rows = await criteria.locator("tbody tr").evaluateAll((items) => items.map((row) => [...row.children].map((cell) => cell.textContent)));
    expect(rows).toEqual(Object.entries(CHOICE_STATE.question.criteria));
    // Its routes are as before; no wire names reach the words.
    await expect(panel.locator('[data-route="uncertain"]')).toHaveText("uncertain → done");
    const words = await panel.innerText();
    for (const wire of ["minimumProbability", "noul", "questionType", "timeoutSeconds"]) expect(words, wire).not.toContain(wire);
    // The panel never scrolls sideways.
    expect(await panel.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
});

test("a yes-or-no question and a score say their answers and levels in words", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const yesNo = {
        id: "is_urgent", type: "decision", input: "${input}",
        question: { type: "noul", instructions: "Does this ticket need a person within the hour?" },
        next: { yes: "done", no: "done", failure: "done" },
    };
    const { panel } = await openDefinitionNode(page, [yesNo, DONE_STATE], "is_urgent");
    const question = panel.locator('details[data-section="decision-question"]');
    await expect(question.locator(":scope > summary")).toHaveText("Decision question · Yes or no");
    await question.locator(":scope > summary").click();
    await expect(question.locator(".ps-wf-decision-heading").nth(1)).toHaveText("Answers");
    await expect(question.locator(".ps-wf-decision-note")).toHaveText("No descriptions of yes and no: the instructions alone decide.");
    await expect(panel.locator('[data-fact="decision-confidence-threshold"] strong')).toHaveText("No confidence threshold");
    expect(await panel.innerText()).not.toContain("noul");
    expect(errors).toEqual([]);
});

test("a score's levels are listed in order with their place, 0 first", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const { panel } = await openDefinitionNode(page, SCORE_STATES, "score_ticket");
    const question = panel.locator('details[data-section="decision-question"]');
    await expect(question.locator(":scope > summary")).toHaveText("Decision question · Score · 4 levels");
    await question.locator(":scope > summary").click();
    const criteria = question.locator('[data-field="decision-criteria"]');
    await expect(criteria.locator("thead th")).toHaveText(["Score", "Level"]);
    const rows = await criteria.locator("tbody tr").evaluateAll((items) => items.map((row) => [...row.children].map((cell) => cell.textContent)));
    expect(rows).toEqual([["0", "Cosmetic"], ["1", "Minor"], ["2", "Major"], ["3", "Critical"]]);
    await expect(criteria.locator(".ps-wf-decision-note")).toHaveText("The score is a number from 0 (Cosmetic) to 3 (Critical).");
    await expect(panel.locator('[data-fact="decision-confidence-threshold"]')).toHaveCount(0);
    expect(errors).toEqual([]);
});

test("a Workflow's Node panel keeps the Decision question closed beside its result", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const details = await openNode(page, completedModel(LONG_CHOICE_STATES, CHOICE_OUTPUT), "route_ticket");
    const question = details.locator('details[data-section="decision-question"]');
    await expect(question).toHaveJSProperty("open", false);
    await expect(question.locator(":scope > summary")).toHaveText("Decision question · Choice · 3 options");
    await question.locator(":scope > summary").click();
    for (const sentence of LONG_INSTRUCTIONS) await expect(question.locator(".ps-wf-decision-instructions")).toContainText(sentence);
    await expect(question.locator('tr[data-criterion="billing"] td')).toHaveText("Payments and refunds");
    // The run's semantic result is unchanged beside it.
    await expect(details.locator('[data-fact="decision-outcome"] strong')).toHaveText("Uncertain");
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

test("a completed score node renders the production shape, provider level order, and no transport fields", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    expect(SCORE_OUTPUT).toEqual({
        questionType: "score",
        outcome: "scored",
        score: 2.37,
        levels: [
            { label: "Cosmetic", probability: 0.01 },
            { label: "Minor", probability: 0.07 },
            { label: "Major", probability: 0.42 },
            { label: "Critical", probability: 0.5 },
        ],
        model: { qualified: DECISION_REVIEW },
    });
    const details = await openNode(page, completedModel(SCORE_STATES, { ...SCORE_OUTPUT, ...SCORE_TRANSPORT_FIELDS }), "score_ticket");
    await expect(details.locator('[data-fact="decision-model"] strong')).toHaveText(DECISION_REVIEW);
    await expect(details.locator('[data-fact="decision-score"] strong')).toHaveText("2.37");
    await expect(details.locator('[data-fact="decision-levels"] strong'))
        .toHaveText("Cosmetic 1% · Minor 7% · Major 42% · Critical 50%");
    await expect(details.locator('[data-fact="result"]'))
        .toContainText("Scored · score 2.37 · Cosmetic 1% · Minor 7% · Major 42% · Critical 50%");
    const rendered = await details.innerText();
    for (const hidden of [
        "questionType", "policy", "attemptId", "requestId", "providerPayload", "latencyMs", "usage",
        "score-attempt-secret", "score-request-secret", "score-provider-secret",
    ]) expect(rendered, hidden).not.toContain(hidden);
    expect(errors).toEqual([]);
});

test("a completed score over the 500-character preview renders from its semantic read summary", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const longLevel = `Cosmetic ${"x".repeat(620)}`;
    const output = { ...SCORE_OUTPUT, levels: [{ label: longLevel, probability: 0.42 }, ...SCORE_OUTPUT.levels.slice(1)] };
    const model = completedModel(SCORE_STATES, output);
    expect(JSON.stringify(output).length).toBeGreaterThan(500);
    expect(model.run.nodeExecutions[0].outputPreview.endsWith("…")).toBe(true);
    const details = await openNode(page, model, "score_ticket");
    await expect(details.locator('[data-fact="now"] strong')).toContainText("Done");
    await expect(details.locator('[data-fact="decision-score"] strong')).toHaveText("2.37");
    await expect(details.locator('[data-fact="decision-levels"] strong')).toContainText(longLevel);
    await expect(details.locator('[data-fact="decision-outcome"] strong')).toHaveText("scored");
    await expect(details).not.toContainText("Not run");
    await expect(details).not.toContainText("No Decision result yet");
    expect(errors).toEqual([]);
});

test("a truncated Decision summary keeps completion and reads the whole semantic value", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const output = { ...SCORE_OUTPUT, levels: [{ label: `Critical ${"z".repeat(12_000)}`, probability: 1 }] };
    const decisionSummary = semanticSummary(output, true);
    decisionSummary.levels = [{ label: `${decisionSummary.levels[0].label.slice(0, 160)}…`, probability: 1 }];
    const model = completedModel(SCORE_STATES, output, { decisionSummary });
    const details = await openNode(page, model, "score_ticket");
    await expect(details.locator('[data-fact="now"] strong')).toContainText("Done");
    await expect(details.locator('[data-fact="decision-score"] strong')).toHaveText("2.37");
    await expect(details).not.toContainText("Not run");
    const showAll = details.getByRole("button", { name: "Show all", exact: true });
    await expect(showAll).toBeVisible();
    await showAll.click();
    await expect(details.locator('[data-whole-value="value"]')).toContainText(`Critical ${"z".repeat(80)}`);
    expect(errors).toEqual([]);
});

test("a completed call with exhausted settlement shows the durable usage warning", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const decisionInference = [{ nodeExecutionId: "nx-route_ticket-1", attempt: 1,
        usageKnown: null, usageState: "settlement_incomplete" }];
    const details = await openNode(page, completedModel(CHOICE_STATES, CHOICE_OUTPUT, { decisionInference }), "route_ticket");
    const warning = details.locator('[data-field="decision-warning"]');
    await expect(warning).toContainText("Usage settlement is incomplete");
    await expect(warning).toContainText("may be missing from usage totals");
    await expect(warning).not.toContainText("Usage was not reported");
    expect(errors).toEqual([]);
});

// Owner 2026-11-20: a node's details show the visit's Input and Output, and follow the timeline. A Decision visit's Output
// is its semantic result in words (selection, confidence against the threshold, probabilities), never its raw output.
// Stepped back to the visit's own moment, the facts say what was known then (running; no outcome, confidence or
// provider-call warning recorded when it ended), and the Output it recorded later is still shown, labelled with when.
// Selector: npx playwright test test/e2e/decision-node.spec.mjs -g "Decision visit's Input and Output" (from packages/app/web).
test("a Decision visit's Input and Output: its semantic result live, and at its own moment only what was known then", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const at = seconds => new Date(Date.parse("2026-11-07T15:00:00.000Z") + seconds * 1000).toISOString();
    const model = completedModel(CHOICE_STATES, CHOICE_OUTPUT, {
        decisionInference: [{ nodeExecutionId: "nx-route_ticket-1", attempt: 2, usageKnown: true, usageState: "known" }],
    });
    const [decision] = model.run.nodeExecutions;
    model.run.nodeExecutions = [
        { ...decision, enteredAt: at(0), endedAt: at(5), inputPreview: JSON.stringify({ ticket: "Checkout returns 500" }) },
        { nodeExecutionId: "nx-done-1", stateId: "done", ordinal: 1, state: "completed", outcome: "succeeded", resultKind: "business",
            winner: "controller", attempts: 0, kvRevision: 1, enteredAt: at(5), endedAt: at(5), inputPreview: "\"engineering\"" },
    ];
    const details = await openNode(page, model, "route_ticket");
    const bar = workflowTab(page).getByRole("group", { name: "Timeline" });
    const head = details.locator('[data-field="visit-head"]');
    const input = details.locator('[data-field="visit-input"] pre');
    const output = details.locator('[data-field="visit-output"]');
    const after = details.locator('[data-field="visit-recorded-after"]');
    const words = "Uncertain · selected engineering · 75% confidence · threshold 80% · engineering 75% · billing 12.5% · support 12.5%";

    // Latest: the visit ended; its input as formatted JSON; its output the semantic result in words, the node's result.
    await expect(bar).toHaveAttribute("data-mode", "live");
    await expect(head).toHaveText(/^Visit 1 of 1 · entered .+ · ended .+$/);
    await expect(input).toHaveText('{ "ticket": "Checkout returns 500" }');
    await expect(output.locator("h3")).toHaveText("Decision result");
    await expect(output.locator("pre")).toHaveText(words);
    await expect(output).toHaveAttribute("data-fact", "result");
    await expect(after).toHaveCount(0);
    await expect(details.locator('[data-fact="decision-outcome"] strong')).toHaveText("Uncertain");
    await expect(details.locator('[data-fact="decision-confidence"] strong')).toHaveText("75%");
    await expect(details.locator('[data-field="decision-warning"]')).toContainText("A second provider call was used.");
    for (const hidden of ["questionType", "policy", "attempt-secret", "request-secret", "provider-secret"]) {
        await expect(output, hidden).not.toContainText(hidden);
    }

    // Step back to the Decision's own moment: it was running, so no outcome, confidence or warning is shown as then.
    await bar.getByRole("button", { name: "Step back", exact: true }).click();
    await expect(bar).toHaveAttribute("data-mode", "history");
    await expect(bar.locator(".ps-wf-replay-label")).toContainText("route_ticket visit 1 · 1 newer");
    await expect(head).toHaveText(/^Visit 1 of 1 · entered .+ · running$/);
    await expect(details.locator('[data-fact="now"] strong')).toContainText("Running");
    await expect(details.locator('[data-fact="decision-outcome"] strong')).toHaveText("Not run");
    for (const fact of ["decision-confidence", "decision-probabilities", "decision-uncertain"]) {
        await expect(details.locator(`[data-fact="${fact}"]`), fact).toHaveCount(0);
    }
    await expect(details.locator('[data-field="decision-warning"]')).toHaveCount(0);
    // Its input, and the output it recorded when it ended, labelled with when.
    await expect(input).toHaveText('{ "ticket": "Checkout returns 500" }');
    await expect(output.locator("pre")).toHaveText(words);
    await expect(after).toHaveText(/^Recorded \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b.*, after this point$/);

    // The terminal at the same moment was not reached: selecting it shows no visit.
    await workflowTab(page).getByRole("button", { name: "Inspect done", exact: true }).click();
    await expect(details.locator('[data-field="visit-head"]')).toHaveCount(0);
    // Latest again: the result as it is now.
    await bar.locator('[data-action="replay-live"]').click();
    await expect(bar).toHaveAttribute("data-mode", "live");
    await workflowTab(page).getByRole("button", { name: "Inspect route_ticket", exact: true }).click();
    await expect(head).toHaveText(/^Visit 1 of 1 · entered .+ · ended .+$/);
    await expect(after).toHaveCount(0);
    await expect(details.locator('[data-fact="decision-outcome"] strong')).toHaveText("Uncertain");
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

async function routeDecisionAdmin(page, {
    decisionModels = ADMIN_DECISION_MODELS,
    clusterDecision = { configured: configured(DECISION_DEFAULT), effective: effective(DECISION_DEFAULT, "cluster_decision_default"), error: null },
} = {}) {
    const writes = [];
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const pathname = new URL(req.url()).pathname;
        if (pathname.endsWith("/providers") && req.method() === "GET") return answer(route, { providers: ADMIN_PROVIDERS });
        if (pathname.endsWith("/models/by-provider") && req.method() === "GET") {
            return answer(route, [{ providerId: "shared-chat", type: "github-copilot", models: ADMIN_CHAT_MODELS }]);
        }
        if (pathname.endsWith("/models/decision") && req.method() === "GET") return answer(route, decisionModels);
        if (pathname.endsWith("/model-defaults")) {
            if (req.method() === "PUT") {
                writes.push(req.postDataJSON());
                return answer(route, {});
            }
            return answer(route, {
                userSession: { configured: configured(CHAT_MODEL), effective: effective(CHAT_MODEL, "user_default") },
                clusterSession: { configured: configured(CHAT_MODEL), effective: effective(CHAT_MODEL, "cluster_default") },
                clusterDecision,
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
        await expect.poll(() => optionValues(chatDefault)).toContain(CHAT_MODEL);
        await expect.poll(() => optionValues(systemDefault)).toContain(CHAT_MODEL);
        for (const decisionModel of DECISION_MODELS) {
            await expect(chatDefault.locator(`option[value="${decisionModel}"]`)).toHaveCount(0);
            await expect(systemDefault.locator(`option[value="${decisionModel}"]`)).toHaveCount(0);
        }
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


test("Admin shows and clears a stale Cluster Decision Default after catalog rerender", async ({ page }) => {
    const server = await startProviderBudgetStub({ admin: true });
    try {
        await page.setViewportSize({ width: 1440, height: 900 });
        const errors = [];
        page.on("pageerror", collectPageErrors(errors));
        const stale = "shared-decision:retired-decision";
        const writes = await routeDecisionAdmin(page, {
            decisionModels: [],
            clusterDecision: {
                configured: configured(stale), effective: null,
                error: "The configured Cluster Decision Default is no longer eligible.",
            },
        });
        await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "networkidle" });
        await page.locator(".ps-session-list-button").first().waitFor();
        await page.locator(`button[aria-label="Admin console"]`).click();
        await page.getByRole("button", { name: "Shared Providers", exact: true }).click();

        const decisionDefault = page.getByRole("combobox", { name: "Cluster Decision Default", exact: true });
        await expect(decisionDefault).toBeVisible();
        await expect(decisionDefault).toHaveValue(stale);
        await expect(decisionDefault.locator(`option[value="${stale}"]`)).toContainText("no longer eligible");
        await page.getByRole("button", { name: "Clear Cluster Decision Default", exact: true }).click();
        await expect.poll(() => writes.length).toBe(1);
        expect(writes[0]).toMatchObject({
            scope: "cluster_decision", provider: null, model: null,
            reasoningEffort: null, contextTier: null,
        });
        expect(errors).toEqual([]);
    } finally {
        await server.close();
    }
});
