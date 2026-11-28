// Phase 3 I7 (design §7.2; Unit 3D Task 13): "Re-run from here…" in a real browser over a mocked backend (page.route stubs
// over the shared stub server; no deployed stack, no model), on a desktop (1280 x 800) and a phone (390 x 844):
//   - the entry points: the failure banner, the Node panel and (desktop) the timeline in history;
//   - the sheet opens on the source revision; choosing the newer revision that fits reads the plan again for it; OQ1's
//     inherited tool grant is said;
//   - supply end to end: #2's timed-out provision step supplied as 'provisioned' with schema-guided fields (Fields | JSON),
//     Start off while Why is blank, Start's 422 problems inline, the same operation id for a repeat (N5) and a new one once the
//     output is edited, never an output or a note in a plan read's query (M6), then #3 shows its reused steps (✓ Reused), its
//     supplied step (✎ Supplied), the Log's supplied line, the timeline's hatched band and the Node panel's Reason;
//   - H1: Start waits for the plan of the choice shown: a plan read that fails keeps it off and sends nothing until Try again
//     reads that choice; plan reads answered out of order drop the late answer;
//   - the keyboard (Tab stays in the sheet, Escape closes it), the phone sheet's 16 px fields and 44 px targets, the reused
//     and supplied words at 4.5:1 in a dark and a light theme, and no page or console error.
// Selector: npx playwright test test/e2e/workflow-rerun.spec.mjs (from packages/app/web, after build).
// PS_E2E_SHOT_DIR, when set, receives screenshots of each state for review.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { startStubServer } from "./stub-server.mjs";
import { collectPageErrors } from "./page-errors.mjs";

const AGENT_ID = "11111110-2222-3333-4444-555555555557";
const W1 = "d1111111-2222-3333-4444-555555555555";
const W2 = "d2222222-2222-3333-4444-555555555555";
const W3 = "d3333333-2222-3333-4444-555555555555";
const SHOTS = process.env.PS_E2E_SHOT_DIR || null;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const now = Date.now();
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
const SESSION = { sessionId: AGENT_ID, title: "Cluster provisioner", status: "idle", model: "test:test-model", createdAt: now - 900_000, updatedAt: now - 60_000 };
const SESSION_ACTOR = { kind: "session", sessionId: AGENT_ID };
const PERSON_ACTOR = { kind: "user", provider: "dev", subject: "affan", display: "Affan Dar" };

const STATES = [
    { id: "validate", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["ok"], next: { ok: "plan" } },
    { id: "plan", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["ok"], next: { ok: "provision" } },
    { id: "provision", type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["provisioned", "failed"],
        next: { provisioned: "configure", failed: "failed" } },
    { id: "configure", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["configured"], next: { configured: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const SCHEMA = { type: "object", required: ["resourceId", "objectId"], properties: { resourceId: { type: "string" }, objectId: { type: "string" } } };
const VISITS = { "nx-validate-1": "validate", "nx-plan-1": "plan", "nx-provision-1": "provision" };
const ORDER = ["nx-validate-1", "nx-plan-1", "nx-provision-1"];
const GOOD_ID = "/subscriptions/0000/resourceGroups/rg-pg/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg1";
const BAD_ID = "rg-pg1";
const OBJECT_ID = "0f1e2d3c-aaaa";
const WHY = "Server pg1 finished provisioning in Azure after the timeout.";
const REV4_WARNING = "Revision 4 changes configure; it runs as revision 4 defines it.";
const PLAN_FAILED = "The plan could not be read just now.";
const BAD_GATEWAY = "console: Failed to load resource: the server responded with a status of 502 (Bad Gateway)";

async function shot(page, name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const row = (stateId, ordinal, extra = {}) => ({ nodeExecutionId: `nx-${stateId}-${ordinal}`, stateId, ordinal, state: "completed", outcome: "ok",
    resultKind: "business", winner: "controller", attempts: 0, kvRevision: 1, ...extra });

/** The re-run plan a server would give for `query` (rerun.ts › previewRerun's shape), from #2's visit it names. */
function planFor(query) {
    const executionId = query.executionId ?? "nx-provision-1";
    const stateId = VISITS[executionId];
    const mode = query.mode ?? (executionId === "nx-provision-1" ? "run_again" : "continue");
    const target = query.revision ?? 3;
    const before = ORDER.slice(0, ORDER.indexOf(executionId)).map((id) => VISITS[id]);
    const supplyContract = stateId === "provision" ? { outcomes: ["provisioned", "failed"], outputSchemaName: null, resolvedOutputSchema: SCHEMA,
        maxOutputBytes: 262_144, nextByOutcome: { provisioned: { stateId: "configure", visit: 1 }, failed: null } } : null;
    const outcome = mode === "supply" ? query.outcome ?? null : null;
    const next = outcome ? supplyContract?.nextByOutcome[outcome] ?? null : null;
    const supply = outcome ? { outcome, valid: next !== null, next,
        problems: next ? [] : [{ code: "no_route", stateId, visit: 1, message: `No route from ${stateId} for outcome '${outcome}'.` }] } : null;
    const warnings = [
        ...(target === 4 ? [{ code: "changed_step", stateId: "configure", message: REV4_WARNING }] : []),
        ...(outcome ? [{ code: "result_supplied", stateId, message: `${stateId} · visit 1 does not run. Its result is supplied as '${outcome}'.` }] : []),
    ];
    return {
        of: { workflowId: W2, runId: `run-${W2}`, revision: 3, status: "failed", number: 2 },
        from: { executionId, stateId, visit: 1, picked: query.executionId ? "requested" : "failed_visit" },
        mode, modesAvailable: stateId === "provision" ? ["run_again", "continue", "supply"] : ["run_again", "continue"],
        supplyContract, supply,
        revision: { target, source: 3, newestValid: 4, newestValidFits: true, newestValidProblem: null, fits: true, problems: [], changedReusedSteps: [] },
        reused: { visits: before.length, bytes: 120, steps: before.map((id) => ({ stateId: id, visits: 1 })), requests: [] },
        carried: { count: 0, contracts: [] },
        runs: { first: mode === "run_again" ? { stateId, visit: 1 } : next },
        dropped: [], warnings, allowed: true, blockedReason: null, grantSource: "inherited",
    };
}

/**
 * The session, its definition provision-cluster (revision 3 by the session, 4 by Affan Dar; #1 completed and #2 failed with
 * provision timed out, both on revision 3) and the routes, each recorded: plan reads (`plans`: their raw URLs and queries) and
 * Starts (`starts`). Start refuses a supplied resourceId that is not an ARM id with 422 RERUN_SUPPLIED_RESULT_INVALID and
 * its problems, and otherwise starts #3 (W3), a re-run that reused validate and plan and was supplied provision.
 * `rerunDone`: #3 is there from the start. `holdStart`: a promise each Start's answer waits for. `planFault`: a function of a
 * plan read's query giving what its answer waits for (`wait`, a promise) and whether it then fails with 502 (`fail`).
 */
async function routeRerun(page, { rerunDone = false } = {}) {
    const revision = (number, actor) => ({ definitionId: "def-pc", revision: number, valid: true, semver: `1.${number - 1}.0`, yamlSha256: `y${number}`,
        irSha256: `ir${number}`, basedOn: number > 1 ? number - 1 : null, actor, imported: false, createdAt: iso(-800_000 + number * 60_000), errorCount: 0 });
    const state = {
        definition: {
            definitionId: "def-pc", ownerSessionId: AGENT_ID, name: "provision-cluster", source: "session", createdAt: iso(-800_000), updatedAt: iso(-500_000),
            deletedAt: null, currentRevision: 4, newestValidRevision: 4, revisions: [revision(3, SESSION_ACTOR), revision(4, PERSON_ACTOR)],
            workflows: [
                { workflowSessionId: W1, definitionId: "def-pc", revision: 3, runStatus: "completed", createdAt: iso(-400_000) },
                { workflowSessionId: W2, definitionId: "def-pc", revision: 3, runStatus: "failed", createdAt: iso(-300_000) },
            ],
        },
        rows: [
            { sessionId: W1, title: "Workflow: provision-cluster", status: "completed", sessionKind: "workflow", parentSessionId: AGENT_ID,
                createdAt: now - 400_000, updatedAt: now - 380_000 },
            { sessionId: W2, title: "Workflow: provision-cluster", status: "failed", sessionKind: "workflow", parentSessionId: AGENT_ID,
                createdAt: now - 300_000, updatedAt: now - 280_000 },
        ],
        plans: [], starts: [], receipts: new Map(), supplied: null, holdStart: null, planFault: null,
    };
    const start = (supplied) => {
        state.supplied = supplied;
        if (state.definition.workflows.some((item) => item.workflowSessionId === W3)) return;
        state.definition.workflows.push({ workflowSessionId: W3, definitionId: "def-pc", revision: 3, runStatus: "completed", createdAt: iso(-100_000) });
        state.rows.push({ sessionId: W3, title: "Workflow: provision-cluster", status: "completed", sessionKind: "workflow", parentSessionId: AGENT_ID,
            createdAt: now - 100_000, updatedAt: now - 90_000 });
    };
    if (rerunDone) start({ outcome: "provisioned", output: { resourceId: GOOD_ID, objectId: OBJECT_ID }, note: WHY });
    const graph = { revision: 3, initial: "validate", states: STATES };
    const base = (id) => ({
        workflowId: id,
        definition: { state: "published", semver: "1.2.0", currentRevision: 1, publishedRevision: 1, publishedDefinitionHash: `h-${id}` },
        revision: { revision: 1, definitionHash: `h-${id}`, valid: true, irSha256: "ir", name: "provision-cluster", diagnostics: [] },
        graph,
    });
    const at = (seconds, from) => new Date(from + seconds * 1000).toISOString();
    const t2 = now - 300_000, t3 = now - 100_000;
    const models = {
        [W1]: () => ({ ...base(W1), runs: [{ runId: `run-${W1}`, mode: "live", status: "completed", revision: 3, outcome: "succeeded" }],
            run: { runId: `run-${W1}`, mode: "live", status: "completed", outcome: "succeeded", terminalState: "done", output: null, error: null,
                kvRevision: 1, kv: "{}", inputs: {}, nodeExecutions: [], inbox: [], outbox: [] } }),
        [W2]: () => ({ ...base(W2), runs: [{ runId: `run-${W2}`, mode: "live", status: "failed", revision: 3, outcome: null }],
            run: { runId: `run-${W2}`, mode: "live", status: "failed", outcome: null, terminalState: "provision", output: null,
                error: JSON.stringify({ code: "timed_out", message: "State 'provision' timed out after 300 s and has no route for it.",
                    details: { nodeExecutionId: "nx-provision-1" } }),
                kvRevision: 1, kv: "{}", inputs: { server: "pg1" },
                nodeExecutions: [
                    row("validate", 1, { enteredAt: at(1, t2), endedAt: at(2, t2), outputPreview: '{"ok":true}' }),
                    row("plan", 1, { predecessorId: "nx-validate-1", enteredAt: at(3, t2), endedAt: at(5, t2), outputPreview: '{"sku":"D4s"}' }),
                    row("provision", 1, { predecessorId: "nx-plan-1", enteredAt: at(6, t2), endedAt: at(306, t2), outcome: "timed_out",
                        resultKind: "runtime_error", winner: "effect",
                        errorPreview: JSON.stringify({ code: "timed_out", message: "provision timed out after 300 s." }) }),
                ],
                inbox: [], outbox: [] },
            ...(state.supplied ? { reruns: [{ workflowId: W3, runId: `run-${W3}`, mode: "supply", fromExecutionId: "nx-provision-1", status: "completed",
                createdAt: iso(-100_000) }] } : {}) }),
        [W3]: () => {
            const supplied = state.supplied;
            return { ...base(W3), runs: [{ runId: `run-${W3}`, mode: "live", status: "completed", revision: 3, outcome: "succeeded" }],
                run: { runId: `run-${W3}`, mode: "live", status: "completed", outcome: "succeeded", terminalState: "done", output: null, error: null,
                    kvRevision: 1, kv: "{}", inputs: { server: "pg1" },
                    rerunOf: { workflowId: W2, runId: `run-${W2}`, executionId: "nx-provision-1", mode: "supply", stateId: "provision", visit: 1, revision: 3 },
                    nodeExecutions: [
                        row("validate", 1, { enteredAt: at(1, t2), endedAt: at(2, t2), outputPreview: '{"ok":true}',
                            reused: { workflowId: W2, runId: `run-${W2}`, executionId: "nx-validate-1", reusedAt: at(0, t3) } }),
                        row("plan", 1, { predecessorId: "nx-validate-1", enteredAt: at(3, t2), endedAt: at(5, t2), outputPreview: '{"sku":"D4s"}',
                            reused: { workflowId: W2, runId: `run-${W2}`, executionId: "nx-plan-1", reusedAt: at(0, t3) } }),
                        row("provision", 1, { predecessorId: "nx-plan-1", enteredAt: at(1, t3), endedAt: at(1, t3), outcome: supplied.outcome,
                            outputPreview: JSON.stringify(supplied.output),
                            supplied: { from: { workflowId: W2, runId: `run-${W2}`, executionId: "nx-provision-1" }, by: { kind: "user", name: "Affan Dar" },
                                note: supplied.note, at: at(1, t3) } }),
                        row("configure", 1, { predecessorId: "nx-provision-1", enteredAt: at(2, t3), endedAt: at(8, t3), outcome: "configured" }),
                        row("done", 1, { predecessorId: "nx-configure-1", enteredAt: at(9, t3), endedAt: at(9, t3), outcome: "succeeded" }),
                    ],
                    inbox: [], outbox: [] } };
        },
    };
    const events = {
        [W2]: () => [
            { sessionId: W2, seq: 1, eventType: "workflow.started", createdAt: at(0, t2), data: { runId: `run-${W2}`, mode: "live", revision: 3,
                definitionHash: `h-${W2}`, irSha256: "ir", name: "provision-cluster", version: "1.2.0", initial: "validate", states: STATES } },
            { sessionId: W2, seq: 2, eventType: "workflow.failed", createdAt: at(307, t2), data: { runId: `run-${W2}`, stateId: "provision", outcome: null,
                error: { code: "timed_out", message: "provision timed out after 300 s." } } },
        ],
        [W3]: () => {
            const data = (stateId, extra = {}) => ({ runId: `run-${W3}`, nodeExecutionId: `nx-${stateId}-1`, stateId, scopeId: "root", ordinal: 1, type: "script", ...extra });
            const reused = (stateId, seq) => ({ sessionId: W3, seq, eventType: "workflow.state_reused", createdAt: at(0, t3), data: data(stateId, {
                outcome: "ok", resultKind: "business", reusedFrom: { workflowId: W2, runId: `run-${W2}`, executionId: `nx-${stateId}-1` } }) });
            return [
                { sessionId: W3, seq: 1, eventType: "workflow.started", createdAt: at(0, t3), data: { runId: `run-${W3}`, mode: "live", revision: 3,
                    definitionHash: `h-${W3}`, irSha256: "ir", name: "provision-cluster", version: "1.2.0", initial: "validate", states: STATES } },
                reused("validate", 2), reused("plan", 3),
                { sessionId: W3, seq: 4, eventType: "workflow.state_supplied", createdAt: at(1, t3), data: data("provision", { outcome: state.supplied.outcome,
                    resultKind: "business", by: { kind: "user", provider: "dev", subject: "affan", displayName: "Affan Dar" }, note: state.supplied.note,
                    suppliedAt: at(1, t3) }) },
                { sessionId: W3, seq: 5, eventType: "workflow.state_started", createdAt: at(2, t3), data: data("configure", { step: 4, kvRevision: 1 }) },
                { sessionId: W3, seq: 6, eventType: "workflow.state_completed", createdAt: at(8, t3), data: data("configure", { step: 4, outcome: "configured",
                    resultKind: "business", durationMs: 6000 }) },
                { sessionId: W3, seq: 7, eventType: "workflow.completed", createdAt: at(9, t3), data: { runId: `run-${W3}`, name: "provision-cluster",
                    stateId: "done", outcome: "succeeded" } },
            ];
        },
    };
    await page.routeWebSocket("**/api/v1/ws", () => {});
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const pathname = url.pathname;
        const answer = (result) => route.fulfill({ json: { ok: true, result } });
        const refuse = (status, code, message, details) => route.fulfill({ status, json: { ok: false, error: { code, message, ...(details ? { details } : {}) } } });
        const sessions = [SESSION, ...state.rows];
        // A server that takes re-runs says so in its bootstrap (M1): without it the client sends no rerunFrom or rerunPlan.
        if (pathname === "/api/v1/bootstrap") return route.fulfill({ json: { ok: true, workflows: { schema: 1, enabled: true, rerun: true } } });
        if (pathname.endsWith("/models")) return answer([{ providerId: "test", modelName: "test-model", qualifiedName: "test:test-model" }]);
        if (pathname.endsWith("/providers")) return answer({ providers: [{ name: "test", typeId: "test", class: "shared", hasCredential: true, usableByMe: true }] });
        if (pathname.endsWith("/providers/status")) return answer({ providers: [] });
        if (pathname.endsWith("/defaults")) return answer({});
        if (pathname.endsWith("/management/sessions")) return answer({ sessions, hasMore: false, nextCursor: null });
        if (pathname.endsWith("/sessions") && req.method() === "GET") return answer({ sessions, hasMore: false });
        const view = () => ({ ...state.definition, current: state.definition.revisions.find((entry) => entry.revision === state.definition.currentRevision) });
        if (pathname.endsWith(`/sessions/${AGENT_ID}/workflow-definitions`) && req.method() === "GET") return answer([view()]);
        if (pathname.endsWith(`/sessions/${AGENT_ID}/workflow-definition`) && req.method() === "GET") {
            const number = JSON.parse(url.searchParams.get("revision") ?? "null");
            const summary = state.definition.revisions.find((entry) => entry.revision === number);
            if (!summary) return refuse(404, "REVISION_NOT_FOUND", `provision-cluster has no revision ${number}.`);
            return answer({ ...view(), revision: { ...summary, yaml: `apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: provision-cluster }\n# ${number}\n`,
                diagnostics: [] }, graph: { ...graph, revision: number }, personCommands: true, viewer: { allowed: true, reason: null } });
        }
        if (pathname.endsWith(`/sessions/${AGENT_ID}/workflow-definitions/start`) && req.method() === "POST") {
            const body = req.postDataJSON();
            state.starts.push(body);
            if (state.holdStart) await state.holdStart;
            if (state.receipts.has(body.operationId)) return answer({ ...state.receipts.get(body.operationId), replayed: true });
            const rerunFrom = body.rerunFrom ?? {};
            if (rerunFrom.mode === "supply" && !String(rerunFrom.result?.output?.resourceId ?? "").startsWith("/subscriptions/")) {
                return refuse(422, "RERUN_SUPPLIED_RESULT_INVALID", "The supplied output does not match provision's outputSchema.",
                    { problems: [{ path: "/output/resourceId", message: "must match pattern \"^/subscriptions/\"" }] });
            }
            start({ outcome: rerunFrom.result?.outcome, output: rerunFrom.result?.output, note: rerunFrom.note });
            const receipt = { operation: "start", definitionId: "def-pc", name: "provision-cluster", revision: body.revision ?? 3, workflowId: W3,
                runId: `run-${W3}`, replayed: false };
            state.receipts.set(body.operationId, receipt);
            return answer(receipt);
        }
        if (pathname.includes(`/sessions/${AGENT_ID}/events`)) return answer([]);
        if (pathname.endsWith(`/sessions/${AGENT_ID}`)) return answer({ ...SESSION, events: [], messages: [] });
        for (const item of state.rows) {
            if (pathname.endsWith(`/sessions/${item.sessionId}/workflow`) && req.method() === "GET") {
                const rerunPlan = url.searchParams.get("rerunPlan");
                if (rerunPlan !== null) {
                    const query = JSON.parse(rerunPlan);
                    state.plans.push({ url: req.url(), query });
                    const fault = state.planFault?.(query) ?? null;
                    if (fault?.wait) await fault.wait;
                    if (fault?.fail) return refuse(502, "UPSTREAM_UNAVAILABLE", PLAN_FAILED);
                    return answer({ ...models[item.sessionId](), rerunPlan: planFor(query) });
                }
                return answer(models[item.sessionId]());
            }
            if (pathname.includes(`/sessions/${item.sessionId}/events`)) return answer(events[item.sessionId]?.() ?? []);
            if (pathname.endsWith(`/sessions/${item.sessionId}`)) return answer({ ...item, events: [], messages: [] });
        }
        return route.fallback();
    });
    return state;
}

const workflowTab = (page) => page.locator(".ps-wf-tab").filter({ visible: true }).first();
const graphOf = (main) => main.getByRole("group", { name: "Workflow graph" });
const sheetOf = (page) => page.getByRole("dialog", { name: /^Re-run provision-cluster/ });
const panelTab = (main, name) => main.getByRole("tablist", { name: "Workflow panel" }).getByRole("tab", { name, exact: true });

/** Page errors and console errors, both kept from the start (the spec's last word: there are none). */
function watchErrors(page) {
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    return errors;
}

/** The session's Workflow tab, its Workflows view, and Workflow #`number` open. */
async function openWorkflow(page, number) {
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    const shown = page.locator(".ps-wf-tab").filter({ visible: true }).first();
    await shown.waitFor({ state: "visible", timeout: 10_000 }).catch(() => page.getByRole("button", { name: /^Workflow( —|$)/ }).click());
    const main = workflowTab(page);
    await expect(main).toHaveAttribute("data-session-definitions", "true");
    await main.getByRole("group", { name: "Definition or Workflows" }).getByRole("button", { name: "Workflows", exact: true }).click();
    await main.getByRole("table", { name: "Workflows of provision-cluster" }).getByRole("button", { name: `Open provision-cluster #${number}`, exact: true }).click();
    await expect(main.locator(`.ps-wf-body[data-session-id="${{ 1: W1, 2: W2, 3: W3 }[number]}"]`)).toBeVisible();
    await expect(graphOf(main)).toHaveAttribute("data-renderer", "flow");
    return main;
}

/** A step's Node panel: a click on a desktop; on a phone a tap selects it and a second tap opens the panel as a sheet. */
async function inspect(main, id, phone) {
    const card = graphOf(main).getByRole("button", { name: `Inspect ${id}`, exact: true });
    await card.click();
    if (phone) {
        const sheet = main.locator(".ps-wf-panel.is-sheet");
        if (!(await sheet.waitFor({ state: "visible", timeout: 500 }).then(() => true, () => false))) {
            await expect(card).toHaveAttribute("aria-pressed", "true");
            await card.click();
        }
        await expect(sheet).toBeVisible();
    }
    const panel = main.locator(".ps-wf-node").filter({ visible: true });
    await expect(panel.locator(".ps-wf-node-head strong")).toHaveText(id);
    return panel;
}

/** Every control of the open sheet a finger uses, and every field one types in: { what, width, height, fontSize }. */
const sheetTargets = (sheet) => sheet.evaluate((dialog) => {
    const out = [];
    for (const element of dialog.querySelectorAll("button, select, input[type=text], textarea, .ps-wf-choice, summary")) {
        const box = element.getBoundingClientRect();
        if (!box.width || !box.height || getComputedStyle(element).visibility === "hidden") continue;
        out.push({ what: `${element.tagName.toLowerCase()}.${element.className || ""}[${(element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 30)}]`,
            tag: element.tagName.toLowerCase(), width: box.width, height: box.height, fontSize: parseFloat(getComputedStyle(element).fontSize) });
    }
    return out;
});

/** The contrast of each element's text on what is painted under it (alpha and color-mix resolved by the browser), for `selectors`. */
const contrasts = (page, selectors) => page.evaluate((list) => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const rgba = (css) => {
        ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "rgba(0,0,0,0)"; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
    };
    const over = (fg, bg) => {
        const a = fg[3] + bg[3] * (1 - fg[3]);
        return a ? [...[0, 1, 2].map((i) => (fg[i] * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / a), a] : [0, 0, 0, 0];
    };
    const ground = (element) => {
        const layers = [];
        for (let node = element; node; node = node.parentElement) layers.push(rgba(getComputedStyle(node).backgroundColor));
        return layers.reduceRight((under, layer) => over(layer, under), [255, 255, 255, 1]);
    };
    const luminance = (color) => color.slice(0, 3).map((c) => c / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const out = [];
    for (const selector of list) {
        for (const element of document.querySelectorAll(selector)) {
            const box = element.getBoundingClientRect();
            if (!box.width || !box.height) continue;
            const bg = ground(element);
            const fg = over(rgba(getComputedStyle(element).color), bg);
            const [l1, l2] = [luminance(fg), luminance(bg)];
            out.push({ selector, text: element.textContent.trim().slice(0, 40), ratio: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100 });
        }
    }
    return out;
}, selectors);

test("entry points (desktop): the failure banner, the Node panel and the timeline in history open the sheet; the source revision is chosen and a newer one that fits is read again", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const errors = watchErrors(page);
    const state = await routeRerun(page);
    const main = await openWorkflow(page, 2);

    // The failure banner: the server picks the visit (an empty plan query).
    const banner = main.locator('[data-action="rerun-from-failure"]');
    await expect(banner).toBeEnabled();
    await expect(banner).toHaveText("Re-run from here…");
    await expect(banner).toHaveAttribute("title", /reusing the steps before this one/);
    await banner.click();
    const sheet = sheetOf(page);
    await expect(sheet).toHaveAccessibleName("Re-run provision-cluster #2 from here");
    await expect(sheet).not.toHaveClass(/is-sheet/);
    expect(state.plans[0].query).toEqual({});
    await expect(sheet.locator('[data-field="rerun-from"]')).toHaveText("provision · visit 1");
    await expect(sheet.locator(".ps-wf-dialog-sub")).toHaveText("Starts #3. #2 stays as it is.");
    // OQ1: the scripts keep the tools the session gave #2.
    await expect(sheet.locator('[data-field="rerun-grant"]')).toHaveText(/^Scripts use the tools this session gave #2 on \d{4}-\d{2}-\d{2}\.$/);
    // Decision 8: the source revision is chosen; the newest one fits and is offered unchosen.
    const revisions = sheet.locator('[data-field="rerun-revision"]');
    await expect(revisions.getByRole("radio", { name: /^3\s+the one #2 ran$/ })).toBeChecked();
    const newer = revisions.getByRole("radio", { name: /^4\s+newest · Revision 4 also fits$/ });
    await expect(newer).not.toBeChecked();
    await expect(newer).toBeEnabled();
    await expect(sheet.getByRole("radio", { name: "Run this step again", exact: true })).toBeChecked();
    await expect(sheet.locator('[data-field="rerun-effect"]')).toHaveText("Runs provision · visit 1 again.");
    await expect(sheet.locator('[data-field="rerun-reused"] > summary')).toHaveText("Reused: 2 steps");
    await expect(sheet.locator('[data-field="rerun-warnings"]')).toHaveCount(0);
    await shot(page, "rerun-sheet-banner-1280");
    // Choosing revision 4 reads the plan for it; its warning shows. Back to 3, the warning goes.
    await newer.check();
    await expect.poll(() => state.plans.at(-1).query).toEqual({ executionId: "nx-provision-1", mode: "run_again", revision: 4 });
    await expect(sheet.locator('[data-field="rerun-warnings"]')).toHaveText(REV4_WARNING);
    await expect(newer).toBeChecked();
    await revisions.getByRole("radio", { name: /^3\s/ }).check();
    await expect.poll(() => state.plans.at(-1).query).toEqual({ executionId: "nx-provision-1", mode: "run_again", revision: 3 });
    await expect(sheet.locator('[data-field="rerun-warnings"]')).toHaveCount(0);
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(sheet).toHaveCount(0);

    // The Node panel: a visit before the failure.
    const panel = await inspect(main, "plan", false);
    const fromNode = panel.locator('[data-action="rerun-from-node"]');
    await expect(fromNode).toBeEnabled();
    await expect(fromNode).toHaveAttribute("data-execution", "nx-plan-1");
    await fromNode.click();
    await expect.poll(() => state.plans.at(-1).query).toEqual({ executionId: "nx-plan-1" });
    await expect(sheet.locator('[data-field="rerun-from"]')).toHaveText("plan · visit 1");
    await expect(sheet.getByRole("radio", { name: "Keep this step's result and go on", exact: true })).toBeChecked();
    await expect(sheet.getByRole("radio", { name: "Supply this step's result and go on", exact: true })).toHaveCount(0);
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sheet).toHaveCount(0);

    // The timeline: Live offers nothing; a visit shown in history does.
    const timeline = main.getByRole("group", { name: "Timeline" });
    await expect(timeline.locator('[data-action="rerun-from-timeline"]')).toHaveCount(0);
    await timeline.locator('[data-action="replay-back"]').click();
    await expect(timeline).toHaveAttribute("data-mode", "history");
    const fromTimeline = timeline.locator('[data-action="rerun-from-timeline"]');
    await expect(fromTimeline).toBeEnabled();
    await fromTimeline.click();
    const asked = state.plans.at(-1).query;
    expect(Object.keys(VISITS)).toContain(asked.executionId);
    await expect(sheet.locator('[data-field="rerun-from"]')).toHaveText(`${VISITS[asked.executionId]} · visit 1`);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    expect(state.starts).toEqual([]);
    expect(errors).toEqual([]);
});

test("entry points (phone): the failure banner and the Node panel open a bottom sheet; the timeline offers none", async ({ page }) => {
    await page.setViewportSize(PHONE);
    const errors = watchErrors(page);
    const state = await routeRerun(page);
    const main = await openWorkflow(page, 2);
    const banner = main.locator('[data-action="rerun-from-failure"]');
    await expect(banner).toBeVisible();
    expect((await banner.boundingBox()).height).toBeGreaterThanOrEqual(44 - 0.01);
    await banner.click();
    const sheet = sheetOf(page);
    await expect(sheet).toHaveClass(/is-sheet/);
    await expect(sheet.locator('[data-field="rerun-from"]')).toHaveText("provision · visit 1");
    // A bottom sheet: the window's whole width, down to its bottom edge.
    const box = await sheet.boundingBox();
    expect(Math.abs(box.x)).toBeLessThan(1);
    expect(Math.abs(box.width - PHONE.width)).toBeLessThan(1);
    expect(Math.abs(box.y + box.height - PHONE.height)).toBeLessThan(1);
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(sheet).toHaveCount(0);

    const panel = await inspect(main, "provision", true);
    const fromNode = panel.locator('[data-action="rerun-from-node"]');
    await expect(fromNode).toBeEnabled();
    expect((await fromNode.boundingBox()).height).toBeGreaterThanOrEqual(44 - 0.01);
    await fromNode.click();
    await expect.poll(() => state.plans.at(-1).query).toEqual({ executionId: "nx-provision-1" });
    await expect(sheet).toHaveClass(/is-sheet/);
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await main.getByRole("button", { name: "← Graph", exact: true }).click();
    const timeline = main.getByRole("group", { name: "Timeline" });
    await timeline.locator('[data-action="replay-back"]').click();
    await expect(timeline).toHaveAttribute("data-mode", "history");
    await expect(main.locator('[data-action="rerun-from-timeline"]')).toHaveCount(0);
    expect(errors).toEqual([]);
});

for (const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    const phone = viewport === PHONE;
    test(`supply end to end (${label}): the supplied result's checks, Start's 422, operation ids (N5), no output in a plan read (M6), and #3 as reused and supplied`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const errors = watchErrors(page);
        const state = await routeRerun(page);
        const main = await openWorkflow(page, 2);
        await main.locator('[data-action="rerun-from-failure"]').click();
        const sheet = sheetOf(page);
        await expect(sheet.locator('[data-field="rerun-from"]')).toHaveText("provision · visit 1");

        // Supply this step's result: the plan is read again in supply, and the editor shows the step's outcomes.
        await sheet.getByRole("radio", { name: "Supply this step's result and go on", exact: true }).check();
        await expect.poll(() => state.plans.at(-1).query).toEqual({ executionId: "nx-provision-1", mode: "supply", revision: 3 });
        const supply = sheet.locator('[data-field="rerun-supply"]');
        await expect(supply).toBeVisible();
        const start = sheet.locator('[data-action="rerun-start"]');
        await expect(start).toHaveText("Start #3");
        await expect(start).toBeDisabled();
        await expect(start).toHaveAttribute("title", "Choose an outcome.");
        const outcome = supply.locator('[data-field="rerun-outcome"]');
        await expect(outcome.locator("option")).toHaveText(["Choose an outcome…", "provisioned → configure · visit 1", "failed → no route"]);
        await outcome.selectOption("provisioned");
        await expect.poll(() => state.plans.at(-1).query).toEqual({ executionId: "nx-provision-1", mode: "supply", revision: 3, outcome: "provisioned" });
        await expect(sheet.locator('[data-field="rerun-effect"]')).toHaveText("provision · visit 1 does not run; supplied as 'provisioned'. Runs configure next.");

        // The schema's fields (both required), then the same value as JSON and back.
        const field = (name) => supply.locator(`[data-output-field="${name}"]`);
        await expect(supply.locator('[data-action="rerun-output-fields"]')).toHaveAttribute("aria-pressed", "true");
        await expect(supply.getByText("resourceId *", { exact: true })).toBeVisible();
        await field("resourceId").fill(BAD_ID);
        await expect(start).toHaveAttribute("title", "objectId is required.");
        await field("objectId").fill(OBJECT_ID);
        await supply.locator('[data-action="rerun-output-json"]').click();
        await expect(supply.locator('[data-action="rerun-output-json"]')).toHaveAttribute("aria-pressed", "true");
        const json = supply.locator('textarea[data-field="rerun-output-json"]');
        expect(JSON.parse(await json.inputValue())).toEqual({ resourceId: BAD_ID, objectId: OBJECT_ID });
        await expect(supply.locator('[data-field="rerun-schema"] > summary')).toHaveText("Schema hint");
        await supply.locator('[data-action="rerun-output-fields"]').click();
        await expect(field("resourceId")).toHaveValue(BAD_ID);
        await expect(field("objectId")).toHaveValue(OBJECT_ID);

        // Start stays off while Why is blank (spaces too).
        await expect(start).toBeDisabled();
        await expect(start).toHaveAttribute("title", "Say why this result is supplied.");
        const why = supply.locator('[data-field="rerun-note"]');
        await why.fill("   ");
        await expect(start).toBeDisabled();
        await why.fill(WHY);
        await expect(start).toBeEnabled();
        await shot(page, `rerun-supply-filled-${viewport.width}`);

        // Start's 422: its problems under the output, and the sheet stays open.
        await start.click();
        const problems = supply.locator('[data-field="rerun-output-problems"]');
        await expect(problems).toHaveText('/output/resourceId: must match pattern "^/subscriptions/"');
        await expect(sheet.locator('[data-field="rerun-start-error"]')).toContainText("The supplied output does not match provision's outputSchema.");
        expect(state.starts).toHaveLength(1);
        await shot(page, `rerun-supply-422-${viewport.width}`);
        // The same request again keeps its operation id (N5): the server answers a repeat with the first answer.
        await start.click();
        await expect.poll(() => state.starts.length).toBe(2);
        await expect(problems).toBeVisible();
        expect(state.starts[1].operationId).toBe(state.starts[0].operationId);

        // An edited output is a new request: a new operation id; a double-click of it is one request id.
        await field("resourceId").fill(GOOD_ID);
        await expect(problems).toHaveCount(0);
        let release;
        state.holdStart = new Promise((resolve) => { release = resolve; });
        await start.dblclick();
        await expect.poll(() => state.starts.length).toBeGreaterThanOrEqual(3);
        await expect(start).toHaveText("Starting…");
        release();
        await expect(sheet).toHaveCount(0);
        const sent = state.starts.slice(2);
        expect(new Set(sent.map((body) => body.operationId)).size).toBe(1);
        expect(sent[0].operationId).not.toBe(state.starts[0].operationId);
        expect(sent[0]).toEqual({ definitionId: "def-pc", revision: 3, operationId: sent[0].operationId, rerunFrom: { workflowId: W2,
            executionId: "nx-provision-1", mode: "supply", result: { outcome: "provisioned", output: { resourceId: GOOD_ID, objectId: OBJECT_ID } }, note: WHY } });
        // M6: a plan read names a visit, a mode, a revision and an outcome; never an output or a note.
        expect(state.plans.length).toBeGreaterThanOrEqual(3);
        for (const plan of state.plans) {
            expect(Object.keys(plan.query).every((key) => ["executionId", "mode", "revision", "outcome"].includes(key)), plan.url).toBe(true);
            const raw = decodeURIComponent(plan.url);
            for (const secret of [BAD_ID, GOOD_ID, OBJECT_ID, WHY, "output", "note"]) expect(raw, plan.url).not.toContain(secret);
        }

        // #3 opens: what it re-ran, its reused steps (✓ Reused from #2, muted), its supplied step (✎, a dashed edge).
        await expect(main.locator(`.ps-wf-body[data-session-id="${W3}"]`)).toBeVisible();
        await expect(main.locator('[data-field="rerun-of"]')).toHaveText(phone ? "Re-run of #2" : "Re-run of #2 · supplied provision · visit 1");
        const graph = graphOf(main);
        for (const id of ["validate", "plan"]) {
            const card = graph.locator(`.ps-workflow-node[data-node-id="${id}"]`);
            await expect(card).toHaveAttribute("data-reused", "true");
            await expect(card).not.toHaveAttribute("data-supplied", /.*/);
            await expect(card.locator(".ps-workflow-node-meta.is-state")).toHaveText("✓Reused from #2");
        }
        const supplied = graph.locator('.ps-workflow-node[data-node-id="provision"]');
        await expect(supplied).toHaveAttribute("data-supplied", "true");
        await expect(supplied).not.toHaveAttribute("data-reused", /.*/);
        await expect(supplied.locator('.ps-workflow-node-meta.is-state[data-state-mark="supplied"]')).toHaveText("✎Supplied (provisioned)");
        expect(await supplied.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe("dashed");
        await expect(graph.locator('.ps-workflow-node[data-node-id="configure"]')).not.toHaveAttribute("data-reused", /.*/);
        // The timeline's hatched band runs to where the re-run starts, the supplied visit marked at its end.
        const timeline = main.getByRole("group", { name: "Timeline" });
        const band = timeline.locator('[data-field="rerun-band"]');
        await expect(band).toHaveAttribute("title", "2 reused + 1 supplied");
        expect(await band.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain("repeating-linear-gradient");
        const bandBox = await band.boundingBox();
        const marker = await timeline.locator('[data-field="rerun-supplied-marker"]').boundingBox();
        const track = await timeline.locator(".ps-wf-replay-track").boundingBox();
        expect(bandBox.width).toBeGreaterThan(4);
        expect(bandBox.x + bandBox.width).toBeLessThan(track.x + track.width);
        expect(Math.abs(marker.x + marker.width / 2 - (bandBox.x + bandBox.width))).toBeLessThan(3);
        await shot(page, `rerun-three-${viewport.width}`);

        // The Node panel: the supplied visit did not run, who gave it, and why (the Reason callout); Open in #2.
        const panel = await inspect(main, "provision", phone);
        const origin = panel.locator('[data-field="visit-provenance"][data-provenance="supplied"]');
        await expect(origin.locator(".ps-wf-provenance-head")).toHaveText(/^✎ Supplied in #3 \(did not run\) · by Affan Dar · /);
        await expect(origin.locator('[data-field="supplied-reason"]')).toHaveText(`Reason ${WHY}`);
        await expect(origin.locator('[data-action="open-rerun-origin"]')).toHaveText("Open in #2");
        await shot(page, `rerun-three-node-${viewport.width}`);
        if (phone) await main.getByRole("button", { name: "← Graph", exact: true }).click();

        // The Log: the reused lines folded into one, the supplied line its own and in view.
        await panelTab(main, "Log").click();
        const log = main.getByRole("list", { name: "Workflow log" }).filter({ visible: true });
        const fold = log.locator('li.ps-wf-log-fold[data-log="reused"]');
        await expect(fold).toHaveCount(1);
        await expect(fold.locator("details > summary")).toContainText("2 steps reused from #2");
        expect(await fold.locator("details").evaluate((element) => element.open)).toBe(false);
        const line = log.locator(":scope > li", { hasText: "supplied → provisioned" });
        await expect(line).toBeVisible();
        await expect(line).toContainText(`✎ provision · visit 1 supplied → provisioned by Affan Dar (“${WHY}”)`);
        await expect(line).toHaveAttribute("data-level", "warning");
        // The browser logs each refused Start's 422 response itself; nothing else.
        expect(errors).toEqual(Array(2).fill("console: Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)"));
    });
}

/**
 * The sheet of #2's failure banner, open on Run this step again with its plan read: { state, sheet, start, failure (the
 * failed read's alert), failed (it with Try again), retry }.
 */
async function openFailureSheet(page) {
    const state = await routeRerun(page);
    const main = await openWorkflow(page, 2);
    await main.locator('[data-action="rerun-from-failure"]').click();
    const sheet = sheetOf(page);
    await expect(sheet.locator('[data-field="rerun-from"]')).toHaveText("provision · visit 1");
    await expect(sheet.getByRole("radio", { name: "Run this step again", exact: true })).toBeChecked();
    const start = sheet.locator('[data-action="rerun-start"]');
    await expect(start).toBeEnabled();
    const failed = sheet.locator('[data-field="rerun-read-error"]');
    await expect(failed).toHaveCount(0);
    return { state, sheet, start, failure: sheet.getByRole("alert").filter({ hasText: PLAN_FAILED }), failed,
        retry: failed.locator('[data-action="rerun-retry"]') };
}

test("H1: a plan read that fails keeps Start off and sends nothing; Try again reads the plan of the choice shown, and Start sends that", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const errors = watchErrors(page);
    const { state, sheet, start, failure, failed, retry } = await openFailureSheet(page);

    // Keep this step's result: its plan read fails. Run this step again's plan does not let Start go, even pressed.
    state.planFault = () => ({ fail: true });
    const keep = sheet.getByRole("radio", { name: "Keep this step's result and go on", exact: true });
    await keep.check();
    const kept = { executionId: "nx-provision-1", mode: "continue", revision: 3 };
    await expect.poll(() => state.plans.at(-1).query).toEqual(kept);
    await expect(failure).toBeVisible();
    await expect(start).toBeDisabled();
    await expect(start).toHaveAttribute("title", "The plan for this choice could not be read. Try again.");
    await expect(keep).toBeChecked();
    await start.click({ force: true });
    // Try again while the server still fails: the same choice is read again, and Start stays off.
    const reads = state.plans.length;
    await retry.click();
    await expect.poll(() => state.plans.length).toBe(reads + 1);
    expect(state.plans.at(-1).query).toEqual(kept);
    await expect(retry).not.toHaveAttribute("aria-disabled", "true");
    await expect(failed.getByRole("alert")).toHaveText(PLAN_FAILED);
    await expect(start).toBeDisabled();
    await expect(keep).toBeChecked();
    expect(state.starts).toEqual([]);

    // The server answers again: Try again reads Keep this step's result, and Start starts exactly that.
    state.planFault = null;
    await retry.click();
    await expect(failed).toHaveCount(0);
    expect(state.plans.at(-1).query).toEqual(kept);
    await expect(sheet.locator('[data-field="rerun-effect"]')).toHaveText("Keeps provision · visit 1's result.");
    await expect(start).toBeEnabled();
    expect(state.starts).toEqual([]);
    await start.click();
    await expect(sheet).toHaveCount(0);
    expect(state.starts).toEqual([{ definitionId: "def-pc", revision: 3, operationId: state.starts[0].operationId,
        rerunFrom: { workflowId: W2, executionId: "nx-provision-1", mode: "continue" } }]);
    expect(errors).toEqual([BAD_GATEWAY, BAD_GATEWAY]);
});

test("H1: plan reads answered out of order: the late answer is dropped, and never stands in for a newer read that failed", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const errors = watchErrors(page);
    const { state, sheet, start, failure, failed, retry } = await openFailureSheet(page);
    const warnings = sheet.locator('[data-field="rerun-warnings"]');
    const revisions = sheet.locator('[data-field="rerun-revision"]');
    const three = revisions.getByRole("radio", { name: /^3\s/ });
    const four = revisions.getByRole("radio", { name: /^4\s/ });
    const keep = sheet.getByRole("radio", { name: "Keep this step's result and go on", exact: true });
    const held = () => { let release; const wait = new Promise((resolve) => { release = resolve; }); return { wait, release }; };
    // The browser has the answer to the plan read `match` picks, and has had time to use it.
    const answered = async (match, release) => {
        const response = page.waitForResponse((item) => {
            const raw = new URL(item.url()).searchParams.get("rerunPlan");
            return raw !== null && match(JSON.parse(raw));
        });
        release();
        await response;
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    };

    // Revision 4's read is slow; revision 3's, asked after it, comes back first. Revision 4's late answer is dropped.
    const slow = held();
    state.planFault = (query) => (query.revision === 4 ? { wait: slow.wait } : null);
    await four.check();
    await expect.poll(() => state.plans.at(-1).query).toEqual({ executionId: "nx-provision-1", mode: "run_again", revision: 4 });
    await expect(start).toBeDisabled();
    await three.check();
    await expect.poll(() => state.plans.at(-1).query).toEqual({ executionId: "nx-provision-1", mode: "run_again", revision: 3 });
    await expect(start).toBeEnabled();
    await answered((query) => query.revision === 4, slow.release);
    await expect(three).toBeChecked();
    await expect(warnings).toHaveCount(0);
    await expect(start).toBeEnabled();

    // Revision 4's read is slow again, and Keep this step's result, asked after it, fails: the late answer does not let Start go.
    const slower = held();
    state.planFault = (query) => (query.mode === "continue" ? { fail: true } : query.revision === 4 ? { wait: slower.wait } : null);
    await four.check();
    await expect.poll(() => state.plans.at(-1).query).toEqual({ executionId: "nx-provision-1", mode: "run_again", revision: 4 });
    await keep.check();
    const kept = { executionId: "nx-provision-1", mode: "continue", revision: 4 };
    await expect.poll(() => state.plans.at(-1).query).toEqual(kept);
    await expect(failure).toBeVisible();
    await expect(start).toBeDisabled();
    await answered((query) => query.revision === 4 && query.mode === "run_again", slower.release);
    await expect(start).toBeDisabled();
    await expect(warnings).toHaveCount(0);
    await expect(four).toBeChecked();
    await expect(keep).toBeChecked();
    expect(state.starts).toEqual([]);

    // Try again reads Keep this step's result on revision 4, whose warning shows; Start sends that.
    state.planFault = null;
    await retry.click();
    await expect(failed).toHaveCount(0);
    await expect(warnings).toHaveText(REV4_WARNING);
    expect(state.plans.at(-1).query).toEqual(kept);
    await expect(start).toBeEnabled();
    await start.click();
    await expect(sheet).toHaveCount(0);
    expect(state.starts).toEqual([{ definitionId: "def-pc", revision: 4, operationId: state.starts[0].operationId,
        rerunFrom: { workflowId: W2, executionId: "nx-provision-1", mode: "continue" } }]);
    expect(errors).toEqual([BAD_GATEWAY]);
});

test("the keyboard: Tab stays in the sheet, Escape closes it and gives focus back", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const errors = watchErrors(page);
    await routeRerun(page);
    const main = await openWorkflow(page, 2);
    const banner = main.locator('[data-action="rerun-from-failure"]');
    await banner.focus();
    await page.keyboard.press("Enter");
    const sheet = sheetOf(page);
    await expect(sheet.locator('[data-field="rerun-from"]')).toHaveText("provision · visit 1");
    await sheet.getByRole("radio", { name: "Supply this step's result and go on", exact: true }).check();
    await expect(sheet.locator('[data-field="rerun-supply"]')).toBeVisible();
    const inside = () => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
    const seen = new Set();
    for (let i = 0; i < 24; i += 1) {
        await page.keyboard.press("Tab");
        expect(await inside(), `Tab ${i + 1} keeps focus in the sheet`).toBe(true);
        seen.add(await page.evaluate(() => document.activeElement?.getAttribute("data-field") || document.activeElement?.getAttribute("data-action")
            || document.activeElement?.textContent?.trim().slice(0, 20)));
    }
    for (const reached of ["rerun-outcome", "rerun-note", "Cancel"]) expect([...seen], reached).toContain(reached);
    for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press("Shift+Tab");
        expect(await inside(), `Shift+Tab ${i + 1} keeps focus in the sheet`).toBe(true);
    }
    // The outcome's own keys: a select keeps Escape for its list only while open; closed, Escape closes the sheet.
    await sheet.locator('[data-field="rerun-note"]').focus();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(banner).toBeFocused();
    expect(errors).toEqual([]);
});

test("the phone sheet: its fields are 16 px and every target is 44 px, in supply and in JSON", async ({ page }) => {
    await page.setViewportSize(PHONE);
    const errors = watchErrors(page);
    await routeRerun(page);
    const main = await openWorkflow(page, 2);
    await main.locator('[data-action="rerun-from-failure"]').click();
    const sheet = sheetOf(page);
    await expect(sheet).toHaveClass(/is-sheet/);
    await sheet.getByRole("radio", { name: "Supply this step's result and go on", exact: true }).check();
    await expect(sheet.locator('[data-field="rerun-supply"]')).toBeVisible();
    await sheet.locator('[data-field="rerun-outcome"]').selectOption("provisioned");
    await sheet.locator('[data-field="rerun-reused"] > summary').click();
    const check = async (what) => {
        const targets = await sheetTargets(sheet);
        expect(targets.some((item) => item.tag === "textarea"), `${what}: a textarea was measured`).toBe(true);
        expect(targets.some((item) => item.tag === "select"), `${what}: a select was measured`).toBe(true);
        for (const label of ["[Fields]", "[JSON]", "[✕]", "[Cancel]"]) expect(targets.some((item) => item.what.endsWith(label)), `${what}: measured ${label}`).toBe(true);
        const small = targets.filter((item) => item.height < 44 - 0.01 || (item.tag === "button" && item.width < 44 - 0.01));
        expect(small, `${what}: under 44 px`).toEqual([]);
        const fields = targets.filter((item) => ["input", "select", "textarea"].includes(item.tag));
        expect(fields.filter((item) => item.fontSize < 16), `${what}: fields under 16 px`).toEqual([]);
        // Nothing in the sheet is wider than it: its body scrolls up and down only.
        const sideways = await sheet.locator(".ps-wf-dialog-body").evaluate((body) => {
            const right = body.getBoundingClientRect().right;
            return { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth,
                past: [...body.querySelectorAll("*")].filter((element) => element.getBoundingClientRect().right > right + 0.5)
                    .map((element) => `${element.tagName.toLowerCase()}.${element.className || element.getAttribute("data-field") || ""}`).slice(0, 6) };
        });
        expect(sideways.scrollWidth, `${what}: the body scrolls sideways (${JSON.stringify(sideways)})`).toBeLessThanOrEqual(sideways.clientWidth + 1);
    };
    await check("fields");
    // The sheet runs edge to edge; its title, Close, body and Cancel | Start keep an inset from the screen's edges.
    const insets = await sheet.evaluate((dialog) => {
        const edge = dialog.getBoundingClientRect();
        return [".ps-modal-title", ".ps-modal-close", ".ps-wf-dialog-sub", '[data-action="rerun-start"]'].map((selector) => {
            const box = dialog.querySelector(selector).getBoundingClientRect();
            return { selector, left: Math.round(box.left - edge.left), right: Math.round(edge.right - box.right) };
        });
    });
    expect(insets.filter((item) => item.left < 12 || item.right < 12), "flush with the screen's edge").toEqual([]);
    await shot(page, "rerun-phone-sheet-fields");
    await sheet.locator('[data-action="rerun-output-json"]').click();
    await expect(sheet.locator('textarea[data-field="rerun-output-json"]')).toBeVisible();
    await check("json");
    // The sheet scrolls between its title and its Cancel | Start, which stay in the window.
    for (const name of ["Cancel", "Start #3"]) {
        const box = await sheet.getByRole("button", { name, exact: true }).boundingBox();
        expect(box.y + box.height, name).toBeLessThanOrEqual(PHONE.height + 0.5);
    }
    expect(await sheet.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
});

for (const themeId of ["workspace-dark", "github-light"]) {
    test(`${themeId}: ✓ Reused and ✎ Supplied, the re-run chip and the Reason read 4.5:1 or more`, async ({ page }) => {
        await page.setViewportSize(DESKTOP);
        const errors = watchErrors(page);
        await routeRerun(page, { rerunDone: true });
        await page.route("**/me/profile", (route) => route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: { themeId } } } }));
        const main = await openWorkflow(page, 3);
        await expect(page.locator("html")).toHaveAttribute("data-ps-theme", themeId);
        await inspect(main, "provision", false);
        await page.mouse.move(2, 400);
        const measured = await contrasts(page, [
            '.ps-workflow-node[data-reused="true"] .ps-workflow-node-meta.is-state',
            '.ps-workflow-node[data-supplied="true"] .ps-workflow-node-meta.is-state',
            ".ps-wf-rerun-chip.is-supplied",
            ".ps-wf-provenance.is-supplied .ps-wf-provenance-head",
            '[data-field="supplied-reason"]',
        ]);
        for (const selector of ['[data-reused="true"]', '[data-supplied="true"]', ".ps-wf-rerun-chip", ".ps-wf-provenance-head", "supplied-reason"]) {
            expect(measured.some((item) => item.selector.includes(selector)), `${themeId}: measured ${selector}`).toBe(true);
        }
        expect(measured.filter((item) => item.ratio < 4.5), `${themeId}: under 4.5:1`).toEqual([]);
        // The two kinds read apart: the supplied words are drawn in the theme's own accent, not in the reused muted colour.
        const colour = (selector) => main.locator(selector).first().evaluate((element) => getComputedStyle(element).color);
        expect(await colour('.ps-workflow-node[data-supplied="true"] .ps-workflow-node-meta.is-state'))
            .not.toBe(await colour('.ps-workflow-node[data-reused="true"] .ps-workflow-node-meta.is-state'));
        await shot(page, `rerun-three-${themeId}`);
        // #2 says it was re-run as #3.
        await main.locator('[data-field="rerun-of"]').click();
        await expect(main.locator(`.ps-wf-body[data-session-id="${W2}"]`)).toBeVisible();
        await expect(main.locator('[data-field="reruns"]')).toHaveText("Re-run as #3");
        expect(errors).toEqual([]);
    });
}
