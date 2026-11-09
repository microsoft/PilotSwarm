// The Workflow tab on a chat's own Workflow Definitions (Workflow Simplified stage 2.1b; spec "definitions" R1, R6;
// "editing" E2-1..E2-5, E2-8; the coordinator's 2.1 readings Q8, Q10), in a real browser over a mocked backend (page.route
// stubs over the shared stub server; no deployed stack, no model):
//   - the header picks a definition (one option each); the Definition view picks a revision, each saying who saved it and
//     when; a revision with errors says why Start refuses it, and a valid one draws its graph and starts (Start…, #3);
//   - the YAML editor saves the next revision naming the one it edited; a newer revision saved meanwhile refuses it in
//     words that say who saved it and when, Reload shows the newest, and a save on it goes through (mouse and keyboard);
//   - Compare shows any two revisions side by side;
//   - a Workflow says the revision it runs, Run again… starts that revision again (runAgainOf), and Delete… asks first,
//     shows the server's refusal while a Workflow runs, then deletes;
//   - a person who can read the chat but not change it sees no YAML, and Start and Delete say why they are off.
// A connection whose list is not there keeps the stage 1 tab (every test of workflow-tab.spec.mjs runs that way).
//
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs (from packages/app/web, after build).
// PS_E2E_SHOT_DIR, when set, receives screenshots of each state for review.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { startStubServer } from "./stub-server.mjs";
import { collectPageErrors } from "./page-errors.mjs";
import { listThemes } from "../../../ui/core/src/themes/index.js";

const AGENT_ID = "11111110-2222-3333-4444-555555555551";
const W1 = "c1111111-2222-3333-4444-555555555555";
const W2 = "c2222222-2222-3333-4444-555555555555";
const W3 = "c3333333-2222-3333-4444-555555555555";
const BENCH = "c4444444-2222-3333-4444-555555555555";
const SHOTS = process.env.PS_E2E_SHOT_DIR || null;
const now = Date.now();
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
const CHAT = { sessionId: AGENT_ID, title: "Hacker News watcher", status: "idle", model: "test:test-model", createdAt: now - 600_000, updatedAt: now - 60_000 };

const STATES = [
    { id: "poll", type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["changed", "unchanged"], next: { changed: "done", unchanged: "pause" } },
    { id: "pause", type: "wait", seconds: 30, outcomes: ["elapsed"], next: { elapsed: "poll" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
];
const INPUTS = { type: "object", required: ["topic"], properties: { topic: { type: "string" } } };
const yamlOf = (revision) => revision === 3
    ? "apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: hn-top-watch, version: \"1.2.0\" }\ninitial: nowhere\nstates: {}\n"
    : `apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: hn-top-watch, version: "1.${revision - 1}.0" }\ninitial: poll\n# wait ${revision * 10}\n`;
const CHAT_ACTOR = { kind: "chat", sessionId: AGENT_ID };
const PERSON_ACTOR = { kind: "user", provider: "dev", subject: "affan", display: "Affan Dar" };

async function shot(page, name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const workflowTab = (page) => page.locator(".ps-wf-tab").filter({ visible: true }).first();
const viewSwitch = (tab, name) => tab.getByRole("group", { name: "Definition or Workflows" }).getByRole("button", { name, exact: true });

/**
 * The chat, its two definitions (hn-top-watch: revision 1 by the chat, 2 by Affan Dar, 3 by the chat with errors; Workflows
 * #1 on revision 1, completed, and #2 on revision 2, running; alpha: one revision, no Workflows) and the definition routes,
 * each recorded. `reader`: the signed-in person can read the chat but not change it. `controls`: a running Workflow offers
 * the person its run controls (Pause, Stop…), as the server does.
 */
async function routeChat(page, { reader = false, tested = false, emptyList = false, controls = false } = {}) {
    const revision = (number, actor, valid = true) => ({ definitionId: "def-hn", revision: number, valid, semver: `1.${number - 1}.0`, yamlSha256: `y${number}`,
        irSha256: valid ? `ir${number}` : null, basedOn: number > 1 ? number - 1 : null, actor, imported: false, createdAt: iso(-300_000 + number * 60_000),
        errorCount: valid ? 0 : 1 });
    const hn = {
        definitionId: "def-hn", ownerSessionId: AGENT_ID, name: "hn-top-watch", source: "chat", createdAt: iso(-300_000), updatedAt: iso(-100_000), deletedAt: null,
        currentRevision: 3, newestValidRevision: 2,
        revisions: [revision(1, CHAT_ACTOR), { ...revision(2, PERSON_ACTOR),
            // Stage 2.2: the chat tested revision 2 when the person asked.
            ...(tested ? { lastTest: { testId: BENCH, verdict: "passed", at: iso(-120_000) } } : {}) }, revision(3, CHAT_ACTOR, false)],
        workflows: [
            { workflowSessionId: W1, definitionId: "def-hn", revision: 1, runStatus: "completed", createdAt: iso(-200_000) },
            { workflowSessionId: W2, definitionId: "def-hn", revision: 2, runStatus: "running", createdAt: iso(-150_000) },
        ],
    };
    const alpha = { definitionId: "def-alpha", ownerSessionId: AGENT_ID, name: "alpha", source: "chat", createdAt: iso(-500_000), updatedAt: iso(-400_000),
        deletedAt: null, currentRevision: 1, newestValidRevision: 1, revisions: [{ ...revision(1, CHAT_ACTOR), definitionId: "def-alpha" }], workflows: [] };
    const yamls = new Map([[1, yamlOf(1)], [2, yamlOf(2)], [3, yamlOf(3)]]);
    const rows = [
        { sessionId: W1, title: "Workflow: hn-top-watch", status: "completed", sessionKind: "workflow", parentSessionId: AGENT_ID, createdAt: now - 200_000, updatedAt: now - 120_000 },
        { sessionId: W2, title: "Workflow: hn-top-watch", status: "running", sessionKind: "workflow", parentSessionId: AGENT_ID, createdAt: now - 150_000, updatedAt: now - 10_000 },
    ];
    const state = { hn, alpha, yamls, rows, inUse: true, reads: [], saves: [], starts: [], deletes: [], list: null, chat: null, listReads: 0, view: null,
        others: [] };
    const view = (item) => ({ ...item, current: item.revisions.find((entry) => entry.revision === item.currentRevision) ?? null });
    state.view = view;
    // Review S2UI-F4: a chat whose list is empty (its Workflows are stage 1 children 0107 did not import).
    // OF-S2-4: a test may give the list itself (`state.list`) and count its reads (`state.listReads`).
    const listed = () => (state.list ? state.list() : emptyList ? [] : [view(alpha), view(hn)]);
    // Final review FUI-F2: a Workflow listed failed has its poll visit ended in a runtime error, and its run says so.
    const FAILED_ERROR = JSON.stringify({ code: "execution_failed", message: "the feed did not answer" });
    const modelOf = (row) => {
        const live = state.hn.workflows.find((item) => item.workflowSessionId === row.sessionId);
        const status = live?.runStatus === "completed" ? "completed" : live?.runStatus === "failed" ? "failed" : "running";
        const failed = status === "failed";
        return {
            workflowId: row.sessionId,
            definition: { state: "published", semver: "1.0.0", currentRevision: 1, publishedRevision: 1, publishedDefinitionHash: `h-${row.sessionId}` },
            revision: { revision: 1, definitionHash: `h-${row.sessionId}`, valid: true, irSha256: "ir", name: "hn-top-watch", diagnostics: [] },
            graph: { revision: 1, initial: "poll", states: STATES, inputsSchema: INPUTS },
            runs: [{ runId: `run-${row.sessionId}`, mode: "live", status, revision: 1, outcome: status === "completed" ? "succeeded" : null }],
            run: { runId: `run-${row.sessionId}`, mode: "live", status, outcome: status === "completed" ? "succeeded" : null, terminalState: failed ? "poll" : null,
                output: null, error: failed ? JSON.stringify({ code: "execution_failed",
                    message: "State 'poll' ended with runtime error 'execution_failed' and has no route for it.", details: { nodeExecutionId: "nx-poll-1" } }) : null,
                kvRevision: 1, kv: "{}", inputs: { topic: "rust" },
                nodeExecutions: failed ? [{ nodeExecutionId: "nx-poll-1", stateId: "poll", ordinal: 1, state: "completed", outcome: "execution_failed",
                    resultKind: "runtime_error", errorPreview: FAILED_ERROR, winner: "effect", attempts: 0, kvRevision: 1 }] : [],
                inbox: [], outbox: [] },
            ...(controls && status === "running" ? { personCommands: { operations: ["pause", "resume", "stop", "cancel"], viewer: { allowed: true },
                run: { runId: `run-${row.sessionId}`, stop: true } } } : {}),
        };
    };
    await page.routeWebSocket("**/api/v1/ws", () => {});
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const pathname = url.pathname;
        const answer = (result) => route.fulfill({ json: { ok: true, result } });
        const refuse = (status, code, message, details) => route.fulfill({ status, json: { ok: false, error: { code, message, ...(details ? { details } : {}) } } });
        // Stage 2.2: a test bench as an older server might list it; the screen never shows it.
        const sessions = [state.chat ?? CHAT, ...state.others, ...state.rows, ...(tested ? [{ sessionId: BENCH, title: "Workflow: hn-top-watch", status: "completed", sessionKind: "workflow",
            parentSessionId: AGENT_ID, serviceKind: "workflow-test", serviceOf: "def-hn", createdAt: now - 130_000, updatedAt: now - 120_000 }] : [])];
        if (pathname.endsWith("/models")) return answer([{ providerId: "test", modelName: "test-model", qualifiedName: "test:test-model" }]);
        if (pathname.endsWith("/providers")) return answer({ providers: [{ name: "test", typeId: "test", class: "shared", hasCredential: true, usableByMe: true }] });
        if (pathname.endsWith("/providers/status")) return answer({ providers: [] });
        if (pathname.endsWith("/defaults")) return answer({});
        // OF-S2-4: the chat's status as last served to the browser (the list or its detail), so a simulated turn changes it.
        const served = (answer) => (result) => { state.servedStatus = (state.chat ?? CHAT).status; return answer(result); };
        if (pathname.endsWith("/management/sessions")) return served(answer)({ sessions, hasMore: false, nextCursor: null });
        if (pathname.endsWith("/sessions") && req.method() === "GET") return served(answer)({ sessions, hasMore: false });
        if (pathname.endsWith(`/sessions/${AGENT_ID}/workflow-definitions`) && req.method() === "GET") {
            state.listReads = (state.listReads || 0) + 1;
            return answer(listed());
        }
        if (pathname.endsWith(`/sessions/${AGENT_ID}/workflow-definition`) && req.method() === "GET") {
            const definitionId = url.searchParams.get("definitionId");
            const number = JSON.parse(url.searchParams.get("revision") ?? "null");
            state.reads.push({ definitionId, revision: number });
            const item = definitionId === "def-alpha" ? state.alpha : state.hn;
            const summary = item.revisions.find((entry) => entry.revision === number);
            if (!summary) return refuse(404, "REVISION_NOT_FOUND", `${item.name} has no revision ${number}.`);
            const yaml = item === state.alpha ? yamlOf(1).replace("hn-top-watch", "alpha") : state.yamls.get(number);
            const diagnostics = summary.valid ? [] : [{ severity: "error", code: "WORKFLOW_INITIAL_UNKNOWN", path: "initial", line: 4,
                message: "initial names no state: nowhere" }];
            return answer({ ...view(item),
                revision: { ...summary, ...(reader ? {} : { yaml }), diagnostics: reader && diagnostics.length
                    ? [{ severity: "error", code: "WORKFLOW_INITIAL_UNKNOWN", message: "This version has an error. People who can change this workflow see where and why." }]
                    : diagnostics },
                graph: summary.valid ? { revision: number, initial: "poll", states: STATES, inputsSchema: INPUTS } : null,
                personCommands: true,
                viewer: reader ? { allowed: false, reason: "Only this workflow's owner or an admin can command it." } : { allowed: true, reason: null } });
        }
        if (pathname.endsWith(`/sessions/${AGENT_ID}/workflow-definitions/save`) && req.method() === "POST") {
            const body = req.postDataJSON();
            state.saves.push(body);
            // Review S2UI-F1: a test may hold a save's answer until it releases it.
            if (state.holdSave) await state.holdSave;
            const item = state.hn;
            if (body.expectedRevision !== item.currentRevision) {
                const newest = item.revisions.find((entry) => entry.revision === item.currentRevision);
                return refuse(409, "REVISION_STALE", `Revision ${item.currentRevision} was saved by the chat at ${newest.createdAt}. Reload to edit it. Nothing was saved.`,
                    { definitionId: item.definitionId, currentRevision: item.currentRevision, expectedRevision: body.expectedRevision, savedBy: newest.actor,
                        savedAt: newest.createdAt });
            }
            const number = item.currentRevision + 1;
            const valid = !String(body.yaml).includes("nowhere");
            item.revisions.push({ ...revision(number, PERSON_ACTOR, valid), basedOn: body.expectedRevision, createdAt: new Date().toISOString() });
            item.currentRevision = number;
            if (valid) item.newestValidRevision = number;
            item.updatedAt = new Date().toISOString();
            state.yamls.set(number, body.yaml);
            return answer({ operation: "save", definitionId: item.definitionId, name: item.name, revision: number, basedOn: body.expectedRevision,
                created: false, valid, semver: null, diagnostics: [], savedAt: item.updatedAt, replayed: false });
        }
        if (pathname.endsWith(`/sessions/${AGENT_ID}/workflow-definitions/start`) && req.method() === "POST") {
            const body = req.postDataJSON();
            state.starts.push(body);
            const item = state.hn;
            const number = body.runAgainOf ? item.workflows.find((entry) => entry.workflowSessionId === body.runAgainOf).revision
                : body.revision ?? item.newestValidRevision;
            const summary = item.revisions.find((entry) => entry.revision === number);
            if (!summary?.valid) return refuse(422, "DEFINITION_INVALID", `Revision ${number} of ${item.name} is not valid, so it cannot start. Save a fixed revision first.`);
            item.workflows.push({ workflowSessionId: W3, definitionId: item.definitionId, revision: number, runStatus: "running", createdAt: new Date().toISOString() });
            state.rows.push({ sessionId: W3, title: "Workflow: hn-top-watch", status: "running", sessionKind: "workflow", parentSessionId: AGENT_ID,
                createdAt: Date.now(), updatedAt: Date.now() });
            return answer({ operation: "start", definitionId: item.definitionId, name: item.name, revision: number, workflowId: W3, runId: `run-${W3}`, replayed: false });
        }
        if (pathname.endsWith(`/sessions/${AGENT_ID}/workflow-definitions/delete`) && req.method() === "POST") {
            const body = req.postDataJSON();
            state.deletes.push(body);
            if (state.inUse) {
                return refuse(409, "DEFINITION_IN_USE", "hn-top-watch has a Workflow still running. Stop it first, then delete it.",
                    { definitionId: "def-hn", workflowSessionIds: [W2] });
            }
            state.hn.deletedAt = new Date().toISOString();
            return answer({ operation: "delete", definitionId: "def-hn", name: "hn-top-watch", deletedAt: state.hn.deletedAt, replayed: false });
        }
        if (pathname.includes(`/sessions/${AGENT_ID}/events`)) return answer([]);
        // OF-S2-4d: another chat of the person's, with no definition.
        for (const other of state.others) {
            if (pathname.endsWith(`/sessions/${other.sessionId}/workflow-definitions`) && req.method() === "GET") return answer([]);
            if (pathname.includes(`/sessions/${other.sessionId}/events`)) return answer([]);
            if (pathname.endsWith(`/sessions/${other.sessionId}`)) return answer({ ...other, events: [], messages: [] });
        }
        // The chat's detail agrees with the list (a1ac03ce :908: it answered the constant CHAT, so a turn was never seen).
        if (pathname.endsWith(`/sessions/${AGENT_ID}`)) return served(answer)({ ...(state.chat ?? CHAT), events: [], messages: [] });
        for (const row of state.rows) {
            if (pathname.endsWith(`/sessions/${row.sessionId}/workflow`) && req.method() === "GET") {
                // OF-S2-8: a definitionRevision read answers the Workflow's YAML (its Node panel's script and samples).
                const wanted = url.searchParams.get("definitionRevision");
                if (wanted) {
                    state.workflowYamlReads = (state.workflowYamlReads || 0) + 1;
                    return answer({ ...modelOf(row), definitionRevision: { revision: Number(wanted), yaml: state.workflowYaml ?? yamlOf(1), definitionHash: `h-${row.sessionId}` } });
                }
                return answer(modelOf(row));
            }
            // FUI-F2: a test may give a Workflow's events (its Whole Workflow Log).
            if (pathname.includes(`/sessions/${row.sessionId}/events`)) return answer(state.events?.[row.sessionId] ?? []);
            if (pathname.endsWith(`/sessions/${row.sessionId}`)) return answer({ ...row, events: [], messages: [] });
        }
        return route.fallback();
    });
    return state;
}

/**
 * OF-S2-4d: a chat whose Workflow panel never showed opens it by itself on arrival, once its definitions are read (these
 * stubs keep no receipt, so every chat with a definition does); the Workflow button opens it otherwise.
 */
async function showPanel(page) {
    const tab = page.locator(".ps-wf-tab").filter({ visible: true }).first();
    await tab.waitFor({ state: "visible", timeout: 10_000 }).catch(() => page.getByRole("button", { name: /^Workflow( —|$)/ }).click());
    return workflowTab(page);
}

async function openTab(page) {
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    await showPanel(page);
    const main = workflowTab(page);
    await expect(main).toHaveAttribute("data-chat-definitions", "true");
    return main;
}

test("chat definitions: one option per definition; each revision says who saved it; a revision with errors says why Start refuses it; a valid one draws and starts", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routeChat(page);
    const main = await openTab(page);
    // The definition picker: one option per definition, by name (no versions); OF-S2-8: no option asks the chat for a new one.
    const definitions = main.getByRole("combobox", { name: "Definition", exact: true });
    await expect.poll(() => definitions.locator("option").allTextContents()).toEqual(["alpha", "hn-top-watch"]);
    // The one saved most recently is shown, at its newest revision.
    await expect(definitions.locator("option:checked")).toHaveText("hn-top-watch");
    await expect(main).toHaveAttribute("data-revision", "3");
    const revisions = main.getByRole("combobox", { name: "Revision", exact: true });
    const labels = await revisions.locator("option").allTextContents();
    expect(labels).toHaveLength(3);
    expect(labels[0]).toMatch(/^Revision 3 · newest · by the chat · .+ · not valid · version 1\.2\.0$/);
    expect(labels[1]).toMatch(/^Revision 2 · by Affan Dar · .+ · version 1\.1\.0$/);
    expect(labels[2]).toMatch(/^Revision 1 · by the chat · .+ · version 1\.0\.0$/);
    // Revision 3 has errors: one line says why, no graph, and Start is off and says why (E2-5), pointing at revision 2.
    await expect(main.locator(".ps-wf-line.is-error").first()).toHaveText("Revision 3 not valid · line 4: initial names no state: nowhere.");
    await expect(main.getByRole("group", { name: "Workflow graph" })).toHaveCount(0);
    const start = main.locator('.ps-wf-head-actions [data-action="start"]');
    await expect(start).toBeDisabled();
    await expect(start).toHaveAttribute("data-title", "Revision 3 has errors, so it cannot start. Revision 2 can: choose it in the revision list.");
    await shot(page, "s21b-revision-with-errors-1440");

    // Revision 2 by the keyboard: its graph is drawn, and Start opens the form for #3 from revision 2.
    await revisions.focus();
    await page.keyboard.press("ArrowDown");
    await expect(main).toHaveAttribute("data-revision", "2");
    await expect(main.getByRole("group", { name: "Workflow graph" })).toBeVisible();
    await expect(start).toBeEnabled();
    await start.click();
    const dialog = page.getByRole("dialog", { name: "Start hn-top-watch", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Workflow #3 runs revision 2.");
    await dialog.getByLabel(/^topic · text · required/).fill("ai agents");
    await shot(page, "s21b-start-form-1440");
    await dialog.locator('[data-action="start-revision"]').click();
    await expect(dialog).toHaveCount(0);
    expect(state.starts).toHaveLength(1);
    expect(state.starts[0]).toMatchObject({ definitionId: "def-hn", revision: 2, runAgainOf: null, inputs: { topic: "ai agents" } });
    expect(state.starts[0].operationId).toMatch(/^ui-start-/);
    // The new Workflow is shown once its row is read: #3, running revision 2.
    await expect(viewSwitch(main, "Workflows")).toHaveAttribute("aria-pressed", "true");
    await expect(main.locator(`.ps-wf-body[data-session-id="${W3}"]`)).toBeVisible({ timeout: 15_000 });
    await expect(main.locator(".ps-wf-picker.is-number .ps-wf-picker-face")).toHaveText("#3 of 3");
    await expect(main.locator(".ps-wf-bar.is-run .ps-wf-bar-text")).toHaveText(/^revision 2/);
    expect(errors).toEqual([]);
});

test("save: the editor names the revision it edited; a newer one saved meanwhile is refused with who and when, Reload shows it, and the next save goes through", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routeChat(page);
    const main = await openTab(page);
    await main.getByRole("button", { name: "YAML", exact: true }).click();
    const box = main.getByRole("textbox", { name: "Workflow YAML", exact: true });
    await expect(box).toHaveValue(yamlOf(3));
    // Revision 3's errors are marked in the editor (E2-5).
    await expect(main.locator(".ps-workflow-yaml-marks li")).toHaveCount(1);
    const save = main.locator('[data-action="save"]');
    await expect(save).toBeDisabled();
    // The person fixes it; meanwhile the chat saves revision 4.
    const fixed = yamlOf(3).replace("initial: nowhere\nstates: {}", "initial: poll");
    await box.fill(fixed);
    await expect(main.locator(".ps-wf-chat-editor .ps-wf-bar-text")).toHaveText("Editing revision 3 · not saved");
    state.hn.revisions.push({ ...state.hn.revisions[0], revision: 4, valid: true, semver: "1.3.0", basedOn: 3, createdAt: new Date().toISOString() });
    state.hn.currentRevision = 4;
    state.hn.newestValidRevision = 4;
    state.yamls.set(4, yamlOf(4));
    await save.click();
    // E2-3: refused, with who saved it and when, in this screen's time; nothing is saved.
    const notice = main.locator('[data-field="save-notice"]');
    await expect(notice).toHaveAttribute("role", "alert");
    // Review 21:15Z: a refusal begins with what was not done.
    await expect(notice).toHaveText(/^Revision not saved: revision 4 was saved by the chat at \d{1,2}:\d{2}:\d{2}.*\. Reload to edit it\. Reload$/);
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]).toMatchObject({ definitionId: "def-hn", name: "hn-top-watch", yaml: fixed, expectedRevision: 3 });
    await shot(page, "s21b-stale-save-1440");
    // Reload shows the newest revision, by the keyboard.
    await notice.getByRole("button", { name: "Reload", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(box).toHaveValue(yamlOf(4));
    await expect(main).toHaveAttribute("data-revision", "4");
    // An edit of revision 4, saved by the keyboard: revision 5, based on 4, by the person.
    await box.fill(`${yamlOf(4)}# tuned\n`);
    await save.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => state.saves.length).toBe(2);
    expect(state.saves[1]).toMatchObject({ expectedRevision: 4, yaml: `${yamlOf(4)}# tuned\n` });
    expect(state.saves[1].operationId).not.toBe(state.saves[0].operationId);
    await expect(main).toHaveAttribute("data-revision", "5");
    await expect(main.getByRole("combobox", { name: "Revision", exact: true }).locator("option").first())
        .toHaveText(/^Revision 5 · newest · by Affan Dar · /);
    await expect(box).toHaveValue(`${yamlOf(4)}# tuned\n`);
    await expect(save).toBeDisabled();
    expect(errors).toEqual([]);
});

// Review S2UI-F1: text typed while a save waits for its answer is not discarded when the answer comes: it stays, unsaved,
// based on the revision just saved, and Save is offered for it.
test("S2UI-F1: typing while a save is pending: the later edit stays unsaved on the saved revision, and Save saves it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routeChat(page);
    const main = await openTab(page);
    await main.getByRole("button", { name: "YAML", exact: true }).click();
    const box = main.getByRole("textbox", { name: "Workflow YAML", exact: true });
    await expect(box).toHaveValue(yamlOf(3));
    const first = yamlOf(3).replace("initial: nowhere\nstates: {}", "initial: poll");
    await box.fill(first);
    let release;
    state.holdSave = new Promise((resolve) => { release = resolve; });
    await main.locator('[data-action="save"]').click();
    await expect.poll(() => state.saves.length).toBe(1);
    // While the answer is held, the person types more.
    const second = `${first}# typed while saving\n`;
    await box.fill(second);
    release();
    state.holdSave = null;
    await expect(main).toHaveAttribute("data-revision", "4");
    await expect(box).toHaveValue(second);
    await expect(main.locator(".ps-wf-chat-editor .ps-wf-bar-text")).toHaveText("Editing revision 4 · not saved");
    const save = main.locator('[data-action="save"]');
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(() => state.saves.length).toBe(2);
    expect(state.saves[1]).toMatchObject({ expectedRevision: 4, yaml: second });
    await expect(main).toHaveAttribute("data-revision", "5");
    await expect(box).toHaveValue(second);
    await expect(save).toBeDisabled();
    expect(errors).toEqual([]);
});

// Review S2UI-F4: an empty definitions list does not hide the chat's stage 1 Workflow children: the tab groups them by name,
// as stage 1 does, before any is selected.
test("S2UI-F4: an empty definitions list with Workflow children shows them grouped by name", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    await routeChat(page, { emptyList: true });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    const main = await showPanel(page);
    await expect(main).toHaveAttribute("data-definition", "hn-top-watch");
    await expect(main).not.toHaveAttribute("data-chat-definitions", "true");
    await expect(page.getByText("No definitions yet.", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
});

test("compare: any two revisions side by side (E2-8), chosen by mouse and by keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    await routeChat(page);
    const main = await openTab(page);
    await main.getByRole("button", { name: "Compare", exact: true }).click();
    const compare = main.locator('.ps-workflow-compare[data-compare="revisions"]');
    await expect(compare).toBeVisible();
    // By default: the revision shown (3) and the one before it.
    await expect(compare).toHaveAttribute("data-from", "2");
    await expect(compare).toHaveAttribute("data-to", "3");
    const summary = compare.getByRole("status").first();
    await expect(summary).toHaveText(/^Revision 2 → 3: \+\d+ −\d+ lines$/);
    // Mouse: From revision 1.
    await compare.locator('[data-field="compare-from"]').selectOption("1");
    await expect(compare).toHaveAttribute("data-from", "1");
    await expect(summary).toHaveText(/^Revision 1 → 3: /);
    // Keyboard: To revision 2 (one step down the list, newest first).
    await compare.locator('[data-field="compare-to"]').focus();
    await page.keyboard.press("ArrowDown");
    await expect(compare).toHaveAttribute("data-to", "2");
    await expect(summary).toHaveText("Revision 1 → 2: +2 −2 lines");
    await shot(page, "s21b-compare-1440");
    expect(errors).toEqual([]);
});

test("a Workflow says the revision it runs; Run again… starts that revision; Delete… asks, shows the refusal while one runs, then deletes", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routeChat(page);
    const main = await openTab(page);
    await viewSwitch(main, "Workflows").click();
    const list = main.getByRole("table", { name: "Workflows of hn-top-watch" });
    await expect(list.locator(".ps-wf-list-row:not(.is-head)")).toHaveCount(2);
    await expect(list.locator(`[data-session-id="${W2}"] .ps-wf-list-version`)).toHaveText("revision 2");
    await expect(list.locator(`[data-session-id="${W1}"] .ps-wf-list-version`)).toHaveText("revision 1");
    await list.getByRole("button", { name: "Open hn-top-watch #1", exact: true }).click();
    await expect(main.locator(`.ps-wf-body[data-session-id="${W1}"]`)).toBeVisible();
    await expect(main.locator(".ps-wf-bar.is-run .ps-wf-bar-text")).toHaveText(/^revision 1/);
    // Its read model is in (its graph is drawn), so its inputs are known.
    await expect(main.getByRole("group", { name: "Workflow graph" })).toBeVisible();
    // Run again: the same revision, filled with #1's inputs; the request names #1, not a revision (Q10).
    const again = main.locator('[data-action="run-again-dialog"]');
    await expect(again).toBeEnabled();
    await again.click();
    const dialog = page.getByRole("dialog", { name: "Run hn-top-watch again", exact: true });
    await expect(dialog).toContainText("Filled with the inputs of #1.");
    await expect(dialog.getByLabel(/^topic · text · required/)).toHaveValue("rust");
    await expect(dialog).toContainText("Workflow #3 runs revision 1.");
    await shot(page, "s21b-run-again-1440");
    await dialog.locator('[data-action="run-again"]').click();
    await expect(dialog).toHaveCount(0);
    expect(state.starts).toHaveLength(1);
    expect(state.starts[0]).toMatchObject({ definitionId: "def-hn", runAgainOf: W1, revision: null, inputs: { topic: "rust" } });
    await expect(main.locator(`.ps-wf-body[data-session-id="${W3}"]`)).toBeVisible({ timeout: 15_000 });
    await expect(main.locator(".ps-wf-bar.is-run .ps-wf-bar-text")).toHaveText(/^revision 1/);

    // Delete… asks first; Keep it sends nothing.
    await viewSwitch(main, "Definition").click();
    const remove = main.locator('[data-action="delete"]');
    await remove.click();
    const confirm = page.getByRole("dialog", { name: "Delete hn-top-watch", exact: true });
    await expect(confirm).toContainText("hn-top-watch and its 3 revisions leave this chat's definitions");
    // UX2D-F10: in agreeing number; #2 and #3 run, so it says why Delete will be refused.
    await expect(confirm.locator('[data-field="delete-keep"]')).toHaveText(
        "Each of its 3 Workflows keeps the revision it ran. 2 of them have not ended, so it cannot be deleted until they end.");
    await confirm.getByRole("button", { name: "Keep it", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    expect(state.deletes).toEqual([]);
    // Refused while a Workflow runs (R6), in the server's words; the dialog stays.
    await remove.click();
    await confirm.locator('[data-action="confirm-delete"]').click();
    await expect(confirm.getByRole("alert")).toHaveText("Delete refused: hn-top-watch has a Workflow still running. Stop it first, then delete it.");
    expect(state.deletes).toHaveLength(1);
    await shot(page, "s21b-delete-refused-1440");
    // Once none runs, by the keyboard: deleted; its finished Workflows keep their copies, so it stays listed as deleted.
    state.inUse = false;
    await confirm.locator('[data-action="confirm-delete"]').focus();
    await page.keyboard.press("Enter");
    await expect(confirm).toHaveCount(0);
    expect(state.deletes).toHaveLength(2);
    expect(state.deletes[1].operationId).not.toBe(state.deletes[0].operationId);
    const definitions = main.getByRole("combobox", { name: "Definition", exact: true });
    await expect.poll(() => definitions.locator("option").allTextContents()).toEqual(["alpha", "hn-top-watch · deleted"]);
    expect(errors).toEqual([]);
});

// UX2D-F2: a refused Delete left the keyboard with no way out: its button, disabled while the request ran, lost focus to
// the page behind the backdrop, so Escape (and Tab) did nothing. The busy button now keeps focus (aria-disabled), and
// any Workflow dialog takes Escape and Tab from the page while it is open: Escape closes it, Tab goes back into it.
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "UX2D-F2" (from packages/app/web, after build).
test("UX2D-F2: after a refused Delete the keyboard keeps the dialog: focus stays, Escape closes it; with focus on the page too, and Start's", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routeChat(page);
    const main = await openTab(page);
    const confirm = page.getByRole("dialog", { name: "Delete hn-top-watch", exact: true });
    const remove = main.locator('[data-action="delete"]');
    // By the keyboard: open, go to Delete, press it; the server refuses; focus is still on it; Escape closes the dialog.
    await remove.focus();
    await page.keyboard.press("Enter");
    await expect(confirm).toBeVisible();
    await confirm.locator('[data-action="confirm-delete"]').focus();
    await page.keyboard.press("Enter");
    await expect(confirm.getByRole("alert")).toHaveText("Delete refused: hn-top-watch has a Workflow still running. Stop it first, then delete it.");
    expect(state.deletes).toHaveLength(1);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-action") ?? null)).toBe("confirm-delete");
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    // Focus on the page itself while the dialog is open: Tab goes back into it, and Escape closes it.
    await remove.click();
    await expect(confirm).toBeVisible();
    await page.evaluate(() => { document.activeElement?.blur?.(); });
    await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.keyboard.press("Tab");
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest?.('[role="dialog"]')))).toBe(true);
    await page.evaluate(() => { document.activeElement?.blur?.(); });
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    // The Start dialog (the same Dialog) too, from revision 2 (revision 3 has errors).
    await main.getByRole("combobox", { name: "Revision", exact: true }).selectOption("2");
    await expect(main).toHaveAttribute("data-revision", "2");
    await main.locator('.ps-wf-head-actions [data-action="start"]').click();
    const start = page.getByRole("dialog", { name: "Start hn-top-watch", exact: true });
    await expect(start).toBeVisible();
    await page.evaluate(() => { document.activeElement?.blur?.(); });
    await page.keyboard.press("Escape");
    await expect(start).toHaveCount(0);
    expect(state.starts).toEqual([]);
    expect(errors).toEqual([]);
});

test("a person who can read the chat but not change it sees no YAML, and Start, Delete and Run again say why they are off", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routeChat(page, { reader: true });
    const main = await openTab(page);
    const revisions = main.getByRole("combobox", { name: "Revision", exact: true });
    await revisions.selectOption("2");
    await expect(main.getByRole("group", { name: "Workflow graph" })).toBeVisible();
    const start = main.locator('.ps-wf-head-actions [data-action="start"]');
    await expect(start).toBeDisabled();
    await expect(start).toHaveAttribute("data-title", "Only this workflow's owner or an admin can command it.");
    await expect(main.locator('[data-action="delete"]')).toBeDisabled();
    await expect(main.locator('[data-action="delete"]')).toHaveAttribute("data-title", "Only this workflow's owner or an admin can command it.");
    await main.getByRole("button", { name: "YAML", exact: true }).click();
    await expect(main.locator('[data-field="yaml-hidden"]')).toHaveText("Only this chat's owner or an admin can read this definition's YAML.");
    await expect(main.getByRole("textbox", { name: "Workflow YAML", exact: true })).toHaveCount(0);
    await main.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(main.locator(".ps-workflow-compare").getByRole("alert")).toHaveText("Only people who can change this definition can read its YAML.");
    await viewSwitch(main, "Workflows").click();
    await main.getByRole("button", { name: "Open hn-top-watch #2", exact: true }).click();
    await expect(main.locator('[data-action="run-again-dialog"]')).toBeDisabled();
    expect(state.saves).toEqual([]);
    expect(state.starts).toEqual([]);
    expect(state.deletes).toEqual([]);
    await shot(page, "s21b-reader-1440");
    expect(errors).toEqual([]);
});

test("stage 2.2: the revision the chat tested says its last test; others say nothing; the test is neither a row nor a Workflow", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    await routeChat(page, { tested: true });
    const main = await openTab(page);
    const lastTest = main.locator("[data-last-test]");
    // Revision 3 (the newest, shown first) was never tested: no line.
    await expect(main).toHaveAttribute("data-revision", "3");
    await expect(lastTest).toHaveCount(0);
    // Revision 2, by the keyboard: its last test passed.
    await main.getByRole("combobox", { name: "Revision", exact: true }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(main).toHaveAttribute("data-revision", "2");
    await expect(lastTest).toHaveAttribute("data-last-test", "passed");
    await expect(lastTest).toHaveText(/^Last test · passed \d{1,2}:\d{2}:\d{2}/);
    await shot(page, "s22-last-test-1440");
    // Revision 1 by the mouse: none again.
    await main.getByRole("combobox", { name: "Revision", exact: true }).selectOption("1");
    await expect(lastTest).toHaveCount(0);
    // The test bench is no Workflow of the definition and no row of the session list.
    await viewSwitch(main, "Workflows").click();
    await expect(main.getByRole("table", { name: "Workflows of hn-top-watch" }).locator(".ps-wf-list-row:not(.is-head)")).toHaveCount(2);
    await expect(page.locator(`[data-session-id="${BENCH}"]`)).toHaveCount(0);
    expect(errors).toEqual([]);
});

// ─── Stage 2.3: a package's Workflow Definitions (spec "Packages and Agent Smith" P1, P2, P5, P6, E2-7, D8) ──────────────

const COORD_ID = "c5555555-2222-3333-4444-555555555555";
/** A Workflow of the coordinating chat's locked definition (review S2UI-F3: Make a copy while it is selected). */
const W_PKG = "c6666666-2222-3333-4444-555555555555";
const WATCH_CARD = {
    ref: "release-tools/release-watch", name: "release-watch", package: "release-tools", packageTitle: "Release Tools", semver: "1.2.0", scope: "shared",
    mine: false, description: "Watches a release train and reports blockers.", whenToUse: "A release train is rolling out.", model: "test:suggested-model",
    inputs: [{ name: "train", required: true }], outcomes: { clear: "No blocker.", blocked: "A blocker." }, asks: {}, effects: "No scripts; one wait.",
    // Stage 2 review S2SF-F4: what the definition itself shows of its effects.
    checked: { scripts: [], agents: [], words: "Checked from the definition: it runs no scripts and has no agent steps." },
};
const WATCH_YAML = "apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: release-watch, version: \"1.2.0\" }\ninitial: poll\n";

/**
 * The new-session picker's catalog (one agent and one package Workflow), the chat it makes for the Workflow, and that
 * chat's locked definition: revision 1 is release-tools 1.2.0, and 1.3.0 is offered. Make a copy adds the chat's own
 * release-watch; Use it for the next Workflow adds revision 2 (1.3.0). Each request is recorded.
 */
async function routePackages(page) {
    const pkgRevision = (number, semver) => ({ definitionId: "def-pkg", revision: number, valid: true, semver, yamlSha256: `p${number}`, irSha256: `pi${number}`,
        basedOn: number > 1 ? number - 1 : null, actor: { kind: "system", name: "management-client" }, imported: false, createdAt: iso(-60_000 + number * 1000),
        errorCount: 0, package: { packageId: "pkg-1", packageName: "release-tools", semver, sha256: `s${number}`, cardDigest: `c${number}` } });
    const state = {
        created: [], copies: [], updates: [], made: false,
        locked: { definitionId: "def-pkg", ownerSessionId: COORD_ID, name: "release-tools/release-watch", source: "package", locked: true, packageName: "release-tools",
            createdAt: iso(-60_000), updatedAt: iso(-59_000), deletedAt: null, currentRevision: 1, newestValidRevision: 1,
            packageUpdate: { semver: "1.3.0", sha256: "s2" }, revisions: [pkgRevision(1, "1.2.0")], workflows: [] },
        copy: null,
    };
    const coordinating = () => ({ sessionId: COORD_ID, title: "release-watch · release-tools", status: "idle", model: "test:test-model",
        workflowRef: "release-tools/release-watch", createdAt: now - 60_000, updatedAt: now - 59_000 });
    const view = (item) => ({ ...item, current: item.revisions.find((entry) => entry.revision === item.currentRevision) ?? null,
        workflows: item === state.locked && state.withWorkflow ? [{ workflowSessionId: W_PKG, revision: 1, runStatus: "running", createdAt: iso(-30_000) }]
            : item.workflows });
    const workflowRow = () => ({ sessionId: W_PKG, title: "Workflow: release-watch", status: "running", sessionKind: "workflow", parentSessionId: COORD_ID,
        createdAt: now - 30_000, updatedAt: now - 20_000 });
    await page.routeWebSocket("**/api/v1/ws", () => {});
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const pathname = url.pathname;
        const answer = (result) => route.fulfill({ json: { ok: true, result } });
        const sessions = [CHAT, ...(state.made ? [coordinating()] : []), ...(state.withWorkflow ? [workflowRow()] : [])];
        if (pathname.endsWith("/models")) return answer([{ providerId: "test", modelName: "test-model", qualifiedName: "test:test-model" }]);
        if (pathname.endsWith("/providers")) return answer({ providers: [{ name: "test", typeId: "test", class: "shared", hasCredential: true, usableByMe: true }] });
        if (pathname.endsWith("/providers/status")) return answer({ providers: [] });
        if (pathname.endsWith("/defaults")) return answer({});
        if (pathname.endsWith("/api/v1/agents")) return answer([{ name: "alpha", title: "Alpha", description: "An agent." }]);
        if (pathname.endsWith("/workflow-definitions/catalog")) return answer([WATCH_CARD]);
        if (pathname.endsWith("/sessions/for-workflow") && req.method() === "POST") {
            state.created.push(req.postDataJSON());
            state.made = true;
            return answer({ sessionId: COORD_ID, model: "test:test-model", workflowRef: "release-tools/release-watch", title: "release-watch · release-tools" });
        }
        if (pathname.endsWith("/management/sessions")) return answer({ sessions, hasMore: false, nextCursor: null });
        if (pathname.endsWith("/sessions") && req.method() === "GET") return answer({ sessions, hasMore: false });
        if (pathname.endsWith(`/sessions/${COORD_ID}/workflow-definitions`) && req.method() === "GET") {
            return answer([view(state.locked), ...(state.copy ? [view(state.copy)] : [])]);
        }
        if (pathname.endsWith(`/sessions/${COORD_ID}/workflow-definition`) && req.method() === "GET") {
            const definitionId = url.searchParams.get("definitionId");
            const number = JSON.parse(url.searchParams.get("revision") ?? "null");
            const item = definitionId === "def-copy" ? state.copy : state.locked;
            const summary = item.revisions.find((entry) => entry.revision === number);
            // CO-1: a slow read of the locked definition's revision 2, so the test sees the view while it is being read.
            if (state.readDelayMs && item === state.locked && number === 2) await new Promise((resolve) => setTimeout(resolve, state.readDelayMs));
            return answer({ ...view(item), revision: { ...summary, yaml: WATCH_YAML, diagnostics: [] },
                graph: { revision: number, initial: "poll", states: STATES, inputsSchema: INPUTS }, personCommands: true, viewer: { allowed: true, reason: null } });
        }
        if (pathname.endsWith(`/sessions/${COORD_ID}/workflow-definitions/copy`) && req.method() === "POST") {
            state.copies.push(req.postDataJSON());
            const copiedRevision = state.locked.revisions.find((entry) => entry.revision === (req.postDataJSON().revision ?? state.locked.currentRevision));
            state.copy = { definitionId: "def-copy", ownerSessionId: COORD_ID, name: "release-watch", source: "copy", locked: false, packageName: null,
                copiedFrom: { definitionId: "def-pkg", name: "release-tools/release-watch", revision: copiedRevision.revision,
                    package: { packageId: "pkg-1", packageName: "release-tools", semver: copiedRevision.package.semver, sha256: copiedRevision.package.sha256 } },
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null, currentRevision: 1, newestValidRevision: 1, packageUpdate: null,
                revisions: [{ ...pkgRevision(1, "1.2.0"), definitionId: "def-copy", package: null, actor: { kind: "user", provider: "dev", subject: "affan", display: "Affan Dar" },
                    createdAt: new Date().toISOString() }], workflows: [] };
            return answer({ operation: "save", definitionId: "def-copy", name: "release-watch", revision: 1, created: true, valid: true, replayed: false });
        }
        if (pathname.endsWith(`/sessions/${COORD_ID}/workflow-definitions/update-package`) && req.method() === "POST") {
            state.updates.push(req.postDataJSON());
            state.locked.revisions.push(pkgRevision(2, "1.3.0"));
            state.locked.currentRevision = 2;
            state.locked.newestValidRevision = 2;
            state.locked.packageUpdate = null;
            return answer({ operation: "attach", definitionId: "def-pkg", name: "release-tools/release-watch", revision: 2, changed: true,
                package: { packageName: "release-tools", semver: "1.3.0" }, replayed: false });
        }
        if (pathname.includes(`/sessions/${COORD_ID}/events`) || pathname.includes(`/sessions/${AGENT_ID}/events`)) return answer([]);
        if (pathname.endsWith(`/sessions/${COORD_ID}`)) return answer({ ...coordinating(), events: [], messages: [] });
        if (state.withWorkflow) {
            if (pathname.endsWith(`/sessions/${W_PKG}/workflow`) && req.method() === "GET") {
                return answer({ workflowId: W_PKG,
                    definition: { state: "published", semver: "1.2.0", currentRevision: 1, publishedRevision: 1, publishedDefinitionHash: "h-pkg" },
                    revision: { revision: 1, definitionHash: "h-pkg", valid: true, irSha256: "ir", name: "release-watch", diagnostics: [] },
                    graph: { revision: 1, initial: "poll", states: STATES, inputsSchema: INPUTS },
                    runs: [{ runId: `run-${W_PKG}`, mode: "live", status: "running", revision: 1, outcome: null }],
                    run: { runId: `run-${W_PKG}`, mode: "live", status: "running", outcome: null, terminalState: null, output: null, error: null, kvRevision: 1,
                        kv: "{}", inputs: { train: "M70" }, nodeExecutions: [], inbox: [], outbox: [] } });
            }
            if (pathname.includes(`/sessions/${W_PKG}/events`)) return answer([]);
            if (pathname.endsWith(`/sessions/${W_PKG}`)) return answer({ ...workflowRow(), events: [], messages: [] });
        }
        if (pathname.endsWith(`/sessions/${AGENT_ID}`)) return answer({ ...CHAT, events: [], messages: [] });
        return route.fallback();
    });
    return state;
}

test("stage 2.3: the new-session picker lists a package's Workflow with its card; choosing it makes a chat with the Workflow badge", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routePackages(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    await expect(page.locator(".ps-prompt-input")).toBeVisible();
    await page.getByRole("button", { name: "New session — choose model and agent", exact: true }).click();
    await expect(page.getByText("Select model for new session", { exact: true })).toBeVisible();
    await page.keyboard.press("Enter");
    // The picker: agents, then Workflows, each under its heading.
    await expect(page.getByText("Select an agent or a Workflow for the new session", { exact: true })).toBeVisible();
    const headings = page.locator(".ps-modal-list-heading-line");
    await expect(headings).toHaveText(["AGENTS", "WORKFLOWS"]);
    const row = page.locator(".ps-modal-list-button", { hasText: "release-watch" });
    await expect(row).toContainText("Release Tools 1.2.0");
    await row.click();
    const details = page.locator(".ps-modal-details");
    await expect(details).toContainText("Workflow card");
    await expect(details).toContainText("Workflow Definition · release-tools 1.2.0");
    await expect(details).toContainText("Inputs: train");
    await expect(details).toContainText("Checked from the definition: it runs no scripts and has no agent steps.");
    await expect(details).toContainText("Author's stated effects: No scripts; one wait.");
    await expect(details).toContainText("Model: test:test-model · its card suggests test:suggested-model");
    await shot(page, "s23-picker-1440");
    await page.getByRole("button", { name: "Create Session", exact: true }).click();
    await expect.poll(() => state.created.length).toBe(1);
    expect(state.created[0]).toMatchObject({ ref: "release-tools/release-watch", model: "test:test-model" });
    // The chat is open, and its row wears the Workflow badge naming its Workflow.
    await expect(page.locator(`.ps-session-list-button[data-session-id="${COORD_ID}"] [data-workflow-ref="release-tools/release-watch"]`).first()).toBeVisible();
    expect(errors).toEqual([]);
});

// Packages lens at 4124eb6c (1024 px): the picker card's checked-effects sentence ended at "it" behind the dialog's footer,
// so its warning (a script can reach the network, files and processes) could not be read. It is safety wording: it now
// comes right under the card's name and package line, and is wholly inside the details pane as it opens.
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "picker card's safety" (from packages/app/web, after build).
test("the picker card's safety words are wholly visible as the details open, at 1024 and 1440 px", async ({ page }) => {
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    await routePackages(page);
    const checked = "Checked from the definition: it runs scripts (steps poll, notify). A script runs code on a worker: it can reach the network, "
        + "and use the tools of the chat that starts it, which can read and write files and run processes. It has agent steps (summarize): each one asks a model.";
    await page.route("**/workflow-definitions/catalog", (route) => route.fulfill({ json: { ok: true, result: [{ ...WATCH_CARD,
        description: "Watches a release train and reports blockers. ".repeat(4).trim(), whenToUse: "A release train is rolling out. ".repeat(3).trim(),
        checked: { scripts: ["notify", "poll"], agents: ["summarize"], words: checked } }] } }));
    for (const [width, height] of [[1024, 768], [1440, 900]]) {
        await page.setViewportSize({ width, height });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
        await expect(page.locator(".ps-prompt-input")).toBeVisible();
        await page.getByRole("button", { name: "New session — choose model and agent", exact: true }).click();
        await expect(page.getByText("Select model for new session", { exact: true })).toBeVisible();
        await page.keyboard.press("Enter");
        await page.locator(".ps-modal-list-button", { hasText: "release-watch" }).click();
        const details = page.locator(".ps-modal-details");
        const line = details.locator(".ps-modal-detail-line", { hasText: "Checked from the definition" });
        await expect(line).toHaveText(checked);
        const [pane, words, footer] = [await details.boundingBox(), await line.boundingBox(), await page.locator(".ps-modal-footer").boundingBox()];
        expect(await details.evaluate((element) => element.scrollTop)).toBe(0);
        expect(words.y, `${width}: below the pane's top`).toBeGreaterThanOrEqual(pane.y - 1);
        expect(words.y + words.height, `${width}: inside the pane`).toBeLessThanOrEqual(pane.y + pane.height + 1);
        expect(words.y + words.height, `${width}: above the footer`).toBeLessThanOrEqual(footer.y + 1);
        await shot(page, `picker-safety-words-${width}`);
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    expect(errors).toEqual([]);
});

// Review S2UI-F8: on a phone a package definition's Make a copy and Use it for the next Workflow are 44 px targets.
test("S2UI-F8: at 390 px the locked definition's Make a copy and Use it for the next Workflow are 44 px targets", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routePackages(page);
    state.made = true;
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${COORD_ID}`);
    const main = await showPanel(page);
    const banner = main.locator('[data-chat-definition="locked"]');
    await expect(banner.locator('[data-field="package"]')).toHaveText("from release-tools 1.2.0 · locked");
    for (const action of ["copy", "use-newer"]) {
        const box = await banner.locator(`[data-action="${action}"]`).boundingBox();
        expect(box.width, action).toBeGreaterThanOrEqual(44 - 0.01);
        expect(box.height, action).toBeGreaterThanOrEqual(44 - 0.01);
    }
    expect(errors).toEqual([]);
});



// Final review FUI-F1: on a phone held sideways (844 x 390, a touch screen) a chat's definition keeps its 44 px targets as at
// 390 px: the Start dialog's controls (portalled out of the tab), the Delete… at the end of the line under the pickers, and a
// package definition's Make a copy and Use it for the next Workflow.
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "FUI-F1" (from packages/app/web, after build).
test.describe("FUI-F1: a chat's definition on a phone held sideways (844 x 390, touch)", () => {
    test.use({ hasTouch: true, isMobile: true });
    const target = async (locator, label) => {
        const box = await locator.boundingBox();
        expect(box, label).not.toBeNull();
        expect(box.width, `${label}: width`).toBeGreaterThanOrEqual(44 - 0.01);
        expect(box.height, `${label}: height`).toBeGreaterThanOrEqual(44 - 0.01);
    };

    test("FUI-F1 sideways: the Start dialog's controls and Delete… are 44 px targets", async ({ page }) => {
        await page.setViewportSize({ width: 844, height: 390 });
        const errors = [];
        page.on("pageerror", collectPageErrors(errors));
        await routeChat(page);
        const main = await openTab(page);
        await main.getByRole("combobox", { name: "Revision", exact: true }).selectOption("2");
        await target(main.locator('[data-field="revision-info"] [data-action="delete"]'), "Delete…");
        await main.locator('.ps-wf-head-actions [data-action="start"]').click();
        const start = page.getByRole("dialog", { name: "Start hn-top-watch", exact: true });
        await expect(start).toBeVisible();
        await target(start.locator('[data-action="start-revision"]'), "Start #");
        await target(start.getByRole("button", { name: "Cancel", exact: true }), "Cancel");
        await target(start.getByRole("button", { name: "Close", exact: true }), "Close");
        await target(start.getByRole("button", { name: "Add", exact: true }), "Add");
        await shot(page, "fui-f1-start-dialog-sideways");
        await start.getByRole("button", { name: "Cancel", exact: true }).click();
        expect(errors).toEqual([]);
    });

    test("FUI-F1 sideways: a locked definition's Make a copy and Use it for the next Workflow are 44 px targets", async ({ page }) => {
        await page.setViewportSize({ width: 844, height: 390 });
        const errors = [];
        page.on("pageerror", collectPageErrors(errors));
        const state = await routePackages(page);
        state.made = true;
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${COORD_ID}`);
        const main = await showPanel(page);
        const banner = main.locator('[data-chat-definition="locked"]');
        await expect(banner.locator('[data-field="package"]')).toHaveText("from release-tools 1.2.0 · locked");
        for (const action of ["copy", "use-newer"]) await target(banner.locator(`[data-action="${action}"]`), action);
        expect(errors).toEqual([]);
    });
});

// UX2D-F6: a revision saved from another page (the chat's row and its Workflows do not change) was not known here until
// Save was refused or the page reloaded. The list is read again when the page is shown again or the window takes focus,
// so the editor says a newer revision was saved before the person saves.
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "UX2D-F6" (from packages/app/web, after build).
test("UX2D-F6: a revision saved from another page is known when this page is shown again or takes focus", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routeChat(page);
    const main = await openTab(page);
    await main.getByRole("button", { name: "YAML", exact: true }).click();
    const box = main.getByRole("textbox", { name: "Workflow YAML", exact: true });
    await expect(box).toHaveValue(yamlOf(3));
    await box.fill(yamlOf(3).replace("initial: nowhere\nstates: {}", "initial: poll"));
    await expect(main.locator(".ps-wf-chat-editor .ps-wf-bar-text")).toHaveText("Editing revision 3 · not saved");
    // Another page saves revision 4.
    state.hn.revisions.push({ ...state.hn.revisions[1], revision: 4, basedOn: 3, createdAt: new Date().toISOString() });
    state.hn.currentRevision = 4;
    state.yamls.set(4, yamlOf(4));
    const newer = main.locator('[data-field="newer-revision"]');
    await expect(newer).toHaveCount(0);
    // The window takes focus again (the person comes back from the other page).
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(newer).toBeVisible();
    await expect(newer).toContainText("Revision 4 was saved after the one you are editing.");
    // And when the page is shown again: revision 5.
    state.hn.revisions.push({ ...state.hn.revisions[1], revision: 5, basedOn: 4, createdAt: new Date().toISOString() });
    state.hn.currentRevision = 5;
    state.yamls.set(5, yamlOf(5));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(newer).toContainText("Revision 5 was saved after the one you are editing.");
    expect(errors).toEqual([]);
});
// UX round UX2D-F3, F4, F5: on a phone (390 px) every control of a chat's definition is a 44 px target: the panel tabs and
// the Compare pickers, the Start and Delete dialogs' buttons, their Close and Add, the Maximize toggle and the graph's
// zoom, fit and move buttons (measured raw, within float precision).
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "UX2D-F3" (from packages/app/web, after build).
test("UX2D-F3, F4, F5: at 390 px the panel tabs, Compare pickers, dialog buttons, Close, Add, Maximize and graph controls are 44 px targets", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    await routeChat(page);
    const main = await openTab(page);
    const target = async (locator, label) => {
        const box = await locator.boundingBox();
        expect(box, label).not.toBeNull();
        expect(box.width, `${label}: width`).toBeGreaterThanOrEqual(44 - 0.01);
        expect(box.height, `${label}: height`).toBeGreaterThanOrEqual(44 - 0.01);
    };
    await target(main.locator(".ps-wf-tab-head").getByRole("button", { name: "Maximize canvas", exact: true }), "Maximize");
    await main.getByRole("combobox", { name: "Revision", exact: true }).selectOption("2");
    // The graph shows a still picture first and loads React Flow after it; its controls come with React Flow (DEV run of
    // b1652e70: counted before it loaded, none were there).
    await expect(main.getByRole("group", { name: "Workflow graph" })).toHaveAttribute("data-renderer", "flow");
    const controls = main.getByRole("group", { name: "Graph view" }).getByRole("button");
    await expect(controls.first()).toBeVisible();
    expect(await controls.count()).toBeGreaterThan(2);
    for (const button of await controls.all()) await target(button, `graph control ${await button.getAttribute("aria-label")}`);
    const tabs = main.getByRole("tablist", { name: "Workflow panel" }).getByRole("tab");
    for (const tab of await tabs.all()) await target(tab, `panel tab ${await tab.textContent()}`);
    await main.getByRole("tablist", { name: "Workflow panel" }).getByRole("tab", { name: "Revisions", exact: true }).click();
    for (const field of ["compare-from", "compare-to"]) await target(main.locator(`[data-field="${field}"]`), field);
    for (const tab of await main.getByRole("tablist", { name: "Workflow panel" }).getByRole("tab").all()) await target(tab, `sheet tab ${await tab.textContent()}`);
    await shot(page, "ux2d-f3-compare-390");
    await main.getByRole("button", { name: "← Graph", exact: true }).click();
    // The Start dialog: Start, Cancel, Close and Add.
    await main.locator('.ps-wf-head-actions [data-action="start"]').click();
    const start = page.getByRole("dialog", { name: "Start hn-top-watch", exact: true });
    await expect(start).toBeVisible();
    await target(start.locator('[data-action="start-revision"]'), "Start #");
    await target(start.getByRole("button", { name: "Cancel", exact: true }), "Cancel");
    await target(start.getByRole("button", { name: "Close", exact: true }), "Close");
    await target(start.getByRole("button", { name: "Add", exact: true }), "Add");
    await shot(page, "ux2d-f4-start-dialog-390");
    await start.getByRole("button", { name: "Cancel", exact: true }).click();
    // The Delete dialog: Keep it and Delete.
    await main.locator('[data-action="delete"]').click();
    const remove = page.getByRole("dialog", { name: "Delete hn-top-watch", exact: true });
    await target(remove.getByRole("button", { name: "Keep it", exact: true }), "Keep it");
    await target(remove.locator('[data-action="confirm-delete"]'), "Delete");
    await remove.getByRole("button", { name: "Keep it", exact: true }).click();
    expect(errors).toEqual([]);
});

// OF-S2-8 (owner, 2026-11-07T23:18Z, confirmed 23:19Z): the header is one row, "Definition" and its picker, "Rev" and its
// picker, the view icons, YAML, Compare, and Start… at its end; the closed pickers show the name and the number alone, and
// who saved the revision, when, its version and "not valid" are the dimmed line under the row. A phone wraps the row to
// two lines (Definition with full screen, then Rev, the icons and Start…) and keeps "not valid" in view. (Supersedes
// UX2D-F8: the revision picker no longer carries its author and time.) The Workflow picker says "Workflow" too.
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "OF-S2-8" (from packages/app/web, after build).
const centerY = (box) => box.y + box.height / 2;
async function headParts(main, { phone = false } = {}) {
    const head = main.locator(".ps-wf-tab-head");
    return {
        head,
        definitionLabel: head.locator("label", { hasText: /^Definition$/ }),
        definitions: main.getByRole("combobox", { name: "Definition", exact: true }),
        definitionFace: head.locator(".ps-wf-picker.is-definition .ps-wf-picker-face"),
        revLabel: head.locator("label", { hasText: /^Rev$/ }),
        revisions: main.getByRole("combobox", { name: "Revision", exact: true }),
        revisionFace: head.locator(".ps-wf-picker.is-revision .ps-wf-picker-face"),
        icons: head.getByRole("group", { name: "Definition or Workflows" }),
        start: head.locator('.ps-wf-head-actions [data-action="start"]'),
        // Full screen at the end of the row: a desktop's "Full screen canvas", a phone's "Maximize canvas".
        maximize: head.getByRole("button", { name: phone ? "Maximize canvas" : "Full screen canvas", exact: true }),
        info: main.locator('[data-field="revision-info"]'),
    };
}

test("OF-S2-8: at 1440 px Definition, Rev, the view icons, YAML, Compare and Start… are one labelled row; the detail is the line under it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    await routeChat(page);
    const main = await openTab(page);
    const parts = await headParts(main);
    await expect(parts.definitionLabel).toBeVisible();
    await expect(parts.revLabel).toBeVisible();
    await expect(parts.definitionFace).toHaveText("hn-top-watch");
    await expect(parts.revisionFace).toHaveText("3");
    await expect.poll(() => parts.definitions.locator("option").allTextContents()).toEqual(["alpha", "hn-top-watch"]);
    // The open list keeps each revision's detail.
    await expect(parts.revisions.locator("option").first()).toHaveText(/^Revision 3 · newest · by the chat · .+ · not valid · version 1\.2\.0$/);
    // One line, in the owner's order.
    const boxes = {};
    for (const name of ["definitionLabel", "definitionFace", "revLabel", "revisionFace", "icons", "start", "maximize"]) boxes[name] = await parts[name].boundingBox();
    const order = ["definitionLabel", "definitionFace", "revLabel", "revisionFace", "icons", "start", "maximize"];
    for (let index = 1; index < order.length; index += 1) {
        expect(boxes[order[index]].x, `${order[index]} after ${order[index - 1]}`).toBeGreaterThan(boxes[order[index - 1]].x);
        expect(Math.abs(centerY(boxes[order[index]]) - centerY(boxes.definitionFace)), `${order[index]} on the same line`).toBeLessThanOrEqual(4);
    }
    // The revision's face is short.
    expect(boxes.revisionFace.width).toBeLessThan(80);
    // The dimmed line: who, when (no seconds), version, newest, not valid.
    await expect(parts.info).toHaveText(/^by the chat · \d{1,2}:\d{2} · version 1\.2\.0 · newest · not valid/);
    await expect(parts.info.locator('[data-field="not-valid"]')).toBeVisible();
    expect((await parts.info.boundingBox()).y).toBeGreaterThanOrEqual(boxes.definitionFace.y + boxes.definitionFace.height - 1);
    // Real labels: a click on one focuses its picker.
    await parts.revLabel.click();
    await expect(parts.revisions).toBeFocused();
    await parts.definitionLabel.click();
    await expect(parts.definitions).toBeFocused();
    // Revision 2: its own detail on the line, by Affan Dar, not the newest.
    await parts.revisions.selectOption("2");
    await expect(parts.revisionFace).toHaveText("2");
    await expect(parts.info).toHaveText(/^by Affan Dar · \d{1,2}:\d{2} · version 1\.1\.0(?! · newest)/);
    await shot(page, "of-s2-8-definition-row-1440");
    // The row is the tab's: the Workflows icon keeps the focus when it changes the view, and the Definition picker stays.
    await viewSwitch(main, "Workflows").focus();
    await page.keyboard.press("Enter");
    await expect(main).toHaveAttribute("data-view", "workflows");
    await expect(viewSwitch(main, "Workflows")).toBeFocused();
    await expect(parts.definitionLabel).toBeVisible();
    await expect(parts.revLabel).toHaveCount(0);
    await expect(parts.start).toHaveCount(0);
    // A Workflow opened: its picker says "Workflow" in words, and the label is its name.
    await main.getByRole("button", { name: "Open hn-top-watch #2", exact: true }).click();
    const workflowLabel = main.locator(".ps-wf-bar.is-run label", { hasText: /^Workflow$/ });
    await expect(workflowLabel).toBeVisible();
    await expect(main.getByRole("combobox", { name: "Workflow", exact: true })).toBeVisible();
    await expect(main.locator(".ps-wf-picker.is-number .ps-wf-picker-face")).toHaveText("#2 of 2");
    await shot(page, "of-s2-8-workflow-label-1440");
    expect(errors).toEqual([]);
});

test("OF-S2-8: at 390 px the row wraps to two lines, Definition with full screen, then Rev, the icons and Start…; not valid stays in view", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    await routeChat(page);
    const main = await openTab(page);
    const parts = await headParts(main, { phone: true });
    await expect(parts.revisionFace).toHaveText("3");
    const boxes = {};
    for (const name of ["definitionLabel", "definitionFace", "maximize", "revLabel", "revisionFace", "icons", "start"]) boxes[name] = await parts[name].boundingBox();
    // First line: Definition and full screen.
    expect(Math.abs(centerY(boxes.maximize) - centerY(boxes.definitionFace))).toBeLessThanOrEqual(4);
    expect(Math.abs(centerY(boxes.definitionLabel) - centerY(boxes.definitionFace))).toBeLessThanOrEqual(4);
    // Second line: Rev, the icons and Start…, below the first.
    for (const name of ["revLabel", "revisionFace", "icons", "start"]) {
        expect(boxes[name].y, `${name} on the second line`).toBeGreaterThanOrEqual(boxes.definitionFace.y + boxes.definitionFace.height - 1);
        expect(Math.abs(centerY(boxes[name]) - centerY(boxes.revisionFace)), `${name} on one line with Rev`).toBeLessThanOrEqual(4);
    }
    // The boxes keep their size: the definition's name is not cut to make room, and every target is 44 px.
    expect(boxes.definitionFace.width).toBeGreaterThan(200);
    for (const name of ["definitionFace", "revisionFace", "start", "maximize"]) expect(boxes[name].height, name).toBeGreaterThanOrEqual(44 - 0.01);
    for (const box of [boxes.definitionFace, boxes.revisionFace, boxes.start, boxes.maximize]) expect(box.x + box.width).toBeLessThanOrEqual(390);
    // Two lines only.
    const head = await parts.head.boundingBox();
    expect(head.height).toBeLessThan(2 * 44 + 30);
    // "not valid" is on the line under the row, wholly in view.
    const notValid = parts.info.locator('[data-field="not-valid"]');
    await expect(notValid).toBeVisible();
    const box = await notValid.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await expect(parts.info).toHaveText(/^by the chat · \d{1,2}:\d{2} · version 1\.2\.0 · newest · not valid/);
    await shot(page, "of-s2-8-definition-rows-390");
    expect(errors).toEqual([]);
});

// OF-S2-8 (owner, 2026-11-07T23:12Z, 23:13Z): a script node's Node panel has a Script section and every node with a
// schema a Sample input and a Sample output, each closed until opened, each sample saying it is one and keeping its schema
// in a Schema row; the YAML (viewer and editor), the samples and the scripts are highlighted in the theme's code colours,
// and the editor stays a plain textarea (typing, undo) under the colours.
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "OF-S2-8" (from packages/app/web, after build).
const SCRIPT_YAML = `apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: hn-top-watch, version: "1.1.0" }
schemas:
  Topic:
    type: object
    required: [topic]
    properties:
      topic: { type: string, examples: [rust] }
      limit: { type: integer, minimum: 3 }
initial: poll
states:
  poll:
    type: script
    timeoutSeconds: 300
    inputSchema: { $ref: "#/schemas/Topic" }
    outputSchema: { type: object, properties: { changed: { type: boolean } } }
    outcomes: [changed, unchanged]
    source: |
      // read the top stories
      const top = await callTool("hn_top", { topic: context.input.topic });
      await setResult(top.changed ? "changed" : "unchanged", { changed: top.changed });
    transition: { next: { changed: done, unchanged: pause } }
  pause: { type: wait, seconds: 30, transition: { next: { elapsed: poll } } }
  done: { type: terminal, outcome: succeeded }
${Array.from({ length: 40 }, (_, index) => `# padding line ${index + 1}`).join("\n")}
`;

async function checkNodeSections(page, panel) {
    const script = panel.locator('details[data-section="script"]');
    await expect(script).toBeVisible();
    await expect(script).toHaveJSProperty("open", false);
    await expect(script.locator("summary")).toHaveText("Script · JavaScript · 3 lines");
    for (const field of ["sample-input", "sample-output"]) {
        await expect(panel.locator(`details[data-section="${field}"]`)).toHaveJSProperty("open", false);
    }
    await expect(panel.locator('details[data-section="sample-input"] > summary')).toHaveText("Sample input");
    await expect(panel.locator('details[data-section="sample-output"] > summary')).toHaveText("Sample output");
    // Opened: the script itself, highlighted, read-only.
    await script.locator("summary").click();
    const text = script.locator('[data-field="script-text"]');
    await expect(text).toBeVisible();
    await expect(text).toContainText('const top = await callTool("hn_top"');
    await expect(text).toHaveAttribute("data-highlighted", "true");
    await expect(text.locator(".ps-code-keyword").first()).toHaveText("const");
    await expect(text.locator(".ps-code-comment").first()).toHaveText("// read the top stories");
    // The samples say they are samples, are JSON from the schema, and keep the schema closed under them.
    const input = panel.locator('details[data-section="sample-input"]');
    await input.locator(":scope > summary").click();
    await expect(input.locator(".ps-wf-sample-note")).toHaveText("A sample made from the node's input schema, not real data.");
    const inputJson = input.locator('[data-field="sample-input-json"]');
    await expect(inputJson).toHaveAttribute("data-highlighted", "true");
    expect(JSON.parse(await inputJson.textContent())).toEqual({ topic: "rust", limit: 3 });
    await expect(inputJson.locator(".ps-code-property").first()).toHaveText('"topic"');
    const schema = input.locator('details[data-section="sample-input-schema"]');
    await expect(schema).toHaveJSProperty("open", false);
    await schema.locator("summary").click();
    expect(JSON.parse(await schema.locator("pre").textContent())).toEqual({ $ref: "#/schemas/Topic" });
    const output = panel.locator('details[data-section="sample-output"]');
    await output.locator(":scope > summary").click();
    expect(JSON.parse(await output.locator('[data-field="sample-output-json"]').textContent())).toEqual({ changed: false });
}

test("OF-S2-8: a script node's Node panel shows its script and sample input and output, each closed until opened, highlighted", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routeChat(page);
    state.yamls.set(2, SCRIPT_YAML);
    state.workflowYaml = SCRIPT_YAML;
    const main = await openTab(page);
    await main.getByRole("combobox", { name: "Revision", exact: true }).selectOption("2");
    await main.getByRole("button", { name: "Inspect poll", exact: true }).click();
    const panel = main.locator('section[aria-label="Node"]');
    await checkNodeSections(page, panel);
    // A wait node has no script and no schema: no sections.
    await main.getByRole("button", { name: "Inspect pause", exact: true }).click();
    await expect(main.locator('section[aria-label="Node"] details[data-section]')).toHaveCount(0);
    await shot(page, "of-s2-8-node-sections-1440");
    // The same sections in a Workflow's Node panel (its own YAML, read once).
    await viewSwitch(main, "Workflows").click();
    await main.getByRole("button", { name: "Open hn-top-watch #2", exact: true }).click();
    await main.getByRole("button", { name: "Inspect poll", exact: true }).click();
    const runPanel = main.locator('section[aria-label="Node details"]');
    await checkNodeSections(page, runPanel);
    expect(state.workflowYamlReads).toBe(1);
    expect(errors).toEqual([]);
});

test("OF-S2-8: the YAML viewer and editor are highlighted; the editor stays a plain textarea for typing and undo, in step when scrolled", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routeChat(page);
    state.yamls.set(2, SCRIPT_YAML);
    const main = await openTab(page);
    // Revision 2, read-only: highlighted.
    await main.getByRole("combobox", { name: "Revision", exact: true }).selectOption("2");
    await main.getByRole("button", { name: "YAML", exact: true }).click();
    const box = main.getByRole("textbox", { name: "Workflow YAML", exact: true });
    await expect(box).toHaveAttribute("data-highlighted", "true");
    const paint = main.locator(".ps-workflow-yaml-paint");
    await expect(paint.locator(".ps-code-property").first()).toHaveText("apiVersion");
    // A YAML comment (the script's own "// …" comment, coloured as JavaScript, comes first in the text).
    await expect(paint.locator(".ps-code-comment").filter({ hasText: /^# padding line 1$/ })).toHaveCount(1);
    await expect(paint.locator(".ps-code-comment").filter({ hasText: /^\/\/ read the top stories$/ })).toHaveCount(1);
    await expect(paint.locator(".ps-code-keyword", { hasText: "await" }).first()).toBeVisible();
    // The copy is the text, in the same font, line height and padding; the textarea's own letters are transparent.
    const geometry = await page.evaluate(() => {
        const area = document.querySelector('.ps-wf-tab textarea[aria-label="Workflow YAML"]');
        const copy = document.querySelector(".ps-wf-tab .ps-workflow-yaml-paint");
        const a = getComputedStyle(area), c = getComputedStyle(copy);
        return { same: ["fontFamily", "fontSize", "lineHeight", "paddingTop", "paddingLeft", "letterSpacing", "tabSize"].filter((key) => a[key] !== c[key]),
            color: a.color, text: copy.textContent, value: area.value };
    });
    expect(geometry.same).toEqual([]);
    expect(geometry.color).toBe("rgba(0, 0, 0, 0)");
    expect(geometry.text).toBe(`${geometry.value}\n`);
    // Scrolled, the copy follows.
    await box.evaluate((area) => { area.scrollTop = 200; area.dispatchEvent(new Event("scroll")); });
    await expect.poll(() => paint.evaluate((copy) => copy.scrollTop)).toBe(await box.evaluate((area) => area.scrollTop));
    await shot(page, "of-s2-8-yaml-viewer-1440");
    // The newest revision, editable: typing and undo are the textarea's, and the colours follow the text.
    await main.getByRole("combobox", { name: "Revision", exact: true }).selectOption("3");
    await expect(box).toHaveValue(yamlOf(3));
    await expect(box).toHaveAttribute("data-highlighted", "true");
    await box.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("# typed\n");
    await expect(box).toHaveValue(`${yamlOf(3)}# typed\n`);
    await expect(paint.locator(".ps-code-comment").filter({ hasText: /^# typed$/ })).toHaveCount(1);
    await expect.poll(() => paint.textContent()).toBe(`${yamlOf(3)}# typed\n\n`);
    // Undo is the textarea's: the browser may group the typing into one step or a few, so undo until the text is back.
    for (let step = 0; step < 10 && (await box.inputValue()) !== yamlOf(3); step += 1) {
        await page.keyboard.press("Control+z");
        await page.waitForTimeout(50);
    }
    await expect(box).toHaveValue(yamlOf(3));
    await expect.poll(() => paint.textContent()).toBe(`${await box.inputValue()}\n`);
    expect(errors).toEqual([]);
});

// OF-S2-8 (owner, 2026-11-07T23:14Z): "see the wf viewer in all the themes and make sure proper contrasting happens. e.g.
// the win95 theme it is too grayed out." In every theme, measured as drawn (each colour over what is really behind it,
// translucent layers and opacity included): the viewer's text reads 4.5:1 or more (pickers and their labels, the line
// under them, node names and type lines, edge labels, the Node panel's words, the script's and samples' highlighted
// code, the YAML's), and its parts 3:1 or more (node card edges, node-kind icons on their wells, edge lines, the Start
// marker, end rings), in the Definition view and in a Workflow's view (its nodes not reached).
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "OF-S2-8 contrast" (from packages/app/web, after build).
const viewerContrast = (page) => page.evaluate(() => {
    const parse = (value) => {
        let match = /^rgba?\(([^)]+)\)/.exec(value ?? "");
        if (match) {
            const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
            return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
        }
        match = /^color\(srgb ([^)]+)\)/.exec(value ?? "");
        if (match) {
            const parts = match[1].split(/[\s/]+/).filter(Boolean).map(Number);
            return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts.length > 3 ? parts[3] : 1 };
        }
        return null;
    };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a),
        b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const lum = (c) => [c.r, c.g, c.b].map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    // What is behind an element (and the element's own fill), composited from the page up; and the opacity on it.
    const behind = (element) => {
        const layers = [];
        let opacity = 1;
        for (let at = element; at; at = at.parentElement) {
            const style = getComputedStyle(at);
            opacity *= Number(style.opacity);
            const color = parse(style.backgroundColor);
            if (color && color.a > 0) { layers.push(color); if (color.a >= 1) break; }
        }
        let ground = { r: 255, g: 255, b: 255, a: 1 };
        for (const color of layers.reverse()) ground = over(color, ground);
        return { ground, opacity };
    };
    const tab = [...document.querySelectorAll(".ps-wf-tab")].find(t => t.getBoundingClientRect().width > 0);
    const out = [];
    const visible = element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
    const measure = (what, element, colour, under, min) => {
        if (!colour) return;
        const { ground, opacity } = under;
        const fg = over({ ...colour, a: colour.a * opacity }, ground);
        out.push({ what, text: (element.textContent || element.getAttribute("class") || "").trim().slice(0, 24), ratio: Math.round(ratio(fg, ground) * 100) / 100, min });
    };
    // Final review FUI-F2: the danger words (a failed last test, a failed Workflow's reason in the list, an error result, a
    // Log's error line and an agent Log's) and every code box's highlighted code (a result's, a whole value's, the variables').
    const TEXT = [".ps-wf-picker-label", ".ps-wf-picker-face-text", '[data-field="revision-info"] > .ps-wf-info-text > span', ".ps-workflow-node-name",
        ".ps-workflow-node-meta", ".ps-workflow-node-start > span", ".ps-wf-what", ".ps-wf-fact span", ".ps-wf-fact strong", ".ps-wf-more > summary",
        ".ps-wf-sample-note", ".ps-wf-code span[class^='ps-code-']", ".ps-workflow-yaml-paint span[class^='ps-code-']", ".ps-wf-panel-tabs button",
        ".ps-wf-line.is-error", ".ps-wf-bar-text", ".ps-wf-last-test.is-failed", ".ps-wf-list-reason", ".ps-wf-result.is-error pre",
        '.ps-wf-alog-row[data-level="error"]', '.ps-wf-log li[data-level="error"]', ".ps-wf-code-inline span[class^='ps-code-']"];
    for (const element of tab.querySelectorAll(TEXT.join(", "))) {
        if (!visible(element) || !(element.textContent || "").trim()) continue;
        const before = out.length;
        measure("text", element, parse(getComputedStyle(element).color), behind(element), 4.5);
        // Every selector it matches: the failed last test is also a span of the line under the pickers (DEV run of 5d5b8841).
        if (out.length > before) out.at(-1).selectors = TEXT.filter(selector => element.matches(selector));
    }
    for (const text of tab.querySelectorAll(".ps-workflow-edge-label text")) {
        const rect = text.parentElement.querySelector("rect");
        const fill = parse(getComputedStyle(rect).fill);
        const under = behind(text.closest("svg").parentElement);
        measure("edge label", text, parse(getComputedStyle(text).fill), { ground: fill ? over(fill, under.ground) : under.ground, opacity: under.opacity }, 4.5);
    }
    for (const node of tab.querySelectorAll(".ps-workflow-node:not(.is-terminal)")) {
        if (!visible(node)) continue;
        const style = getComputedStyle(node);
        const canvas = behind(node.parentElement);
        // A card is seen by its edge or its fill.
        const edge = Math.max(ratio(over(parse(style.borderTopColor), canvas.ground), canvas.ground), ratio(over(parse(style.backgroundColor), canvas.ground), canvas.ground));
        out.push({ what: "card edge", text: node.dataset.nodeId, ratio: Math.round(edge * 100) / 100, min: 3 });
    }
    for (const icon of tab.querySelectorAll(".ps-workflow-node-icon")) {
        if (!visible(icon)) continue;
        measure("icon", icon, parse(getComputedStyle(icon).color), behind(icon), 3);
    }
    for (const path of tab.querySelectorAll(".ps-workflow-edge-path")) {
        measure("edge line", path, parse(getComputedStyle(path).stroke), behind(path.closest("svg").parentElement), 3);
    }
    for (const start of tab.querySelectorAll(".ps-workflow-node-start")) {
        measure("Start marker", start, parse(getComputedStyle(start).borderTopColor), behind(start.closest(".ps-workflow-node").parentElement), 3);
    }
    for (const ring of tab.querySelectorAll(".ps-workflow-node-ring")) {
        measure("end ring", ring, parse(getComputedStyle(ring).borderTopColor), behind(ring.closest(".ps-workflow-node").parentElement), 3);
    }
    return out;
});

for (const theme of listThemes()) {
    test(`OF-S2-8 contrast: the Workflow viewer's text reads 4.5:1 and its parts 3:1 or more, ${theme.id}`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const errors = [];
        page.on("pageerror", collectPageErrors(errors));
        const state = await routeChat(page);
        state.yamls.set(2, SCRIPT_YAML);
        state.workflowYaml = SCRIPT_YAML;
        await page.route("**/me/profile", (route) => route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: { themeId: theme.id } } } }));
        const main = await openTab(page);
        await expect(page.locator("html")).toHaveAttribute("data-ps-theme", theme.id);
        // The Definition view: revision 2's graph, the poll node's panel with its script and sample open.
        await main.getByRole("combobox", { name: "Revision", exact: true }).selectOption("2");
        await main.getByRole("button", { name: "Inspect poll", exact: true }).click();
        const panel = main.locator('section[aria-label="Node"]');
        await panel.locator('details[data-section="script"] > summary').click();
        await expect(panel.locator('[data-field="script-text"]')).toHaveAttribute("data-highlighted", "true");
        await panel.locator('details[data-section="sample-input"] > summary').click();
        await expect(panel.locator('[data-field="sample-input-json"]')).toHaveAttribute("data-highlighted", "true");
        await page.mouse.move(2, 400);
        if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
        const definition = await viewerContrast(page);
        if (SHOTS) await main.screenshot({ path: path.join(SHOTS, `of-s2-8-contrast-definition-${theme.id}.png`) });
        // The YAML, highlighted.
        await main.getByRole("button", { name: "YAML", exact: true }).click();
        await expect(main.getByRole("textbox", { name: "Workflow YAML", exact: true })).toHaveAttribute("data-highlighted", "true");
        const yaml = await viewerContrast(page);
        if (SHOTS) await main.screenshot({ path: path.join(SHOTS, `of-s2-8-contrast-yaml-${theme.id}.png`) });
        await main.getByRole("button", { name: "YAML", exact: true }).click();
        // A Workflow's view: its nodes not reached (dimmed) and its end.
        await viewSwitch(main, "Workflows").click();
        await main.getByRole("button", { name: "Open hn-top-watch #2", exact: true }).click();
        await expect(main.locator(".ps-workflow-node.is-not-reached").first()).toBeVisible();
        const run = await viewerContrast(page);
        if (SHOTS) await main.screenshot({ path: path.join(SHOTS, `of-s2-8-contrast-run-${theme.id}.png`) });
        const all = [...definition.map(item => ({ ...item, view: "definition" })), ...yaml.map(item => ({ ...item, view: "yaml" })),
            ...run.map(item => ({ ...item, view: "run" }))];
        for (const what of ["text", "edge label", "card edge", "icon", "edge line", "Start marker", "end ring"]) {
            expect(all.some(item => item.what === what), `${theme.id}: measured ${what}`).toBe(true);
        }
        expect(yaml.filter(item => item.what === "text").length, `${theme.id}: the YAML's colours were measured`).toBeGreaterThan(5);
        const low = all.filter(item => item.ratio < item.min);
        expect(low, `${theme.id}: under the target`).toEqual([]);
        expect(errors).toEqual([]);
    });
}

// Final review FUI-F2: in every theme the danger words read 4.5:1 or more on what they are drawn on (gruvbox-dark and ms-dos
// read 2.5:1 to 2.7:1 with the theme's own danger colour), and in win95 a failed step's error result sits in a white well as
// the other code boxes do. Measured as drawn (viewerContrast): a failed last test under the pickers, a failed Workflow's
// reason in the Workflows list, its failed step's error result in the Node panel, and its Log's error line.
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "FUI-F2 contrast" (from packages/app/web, after build).
for (const theme of listThemes()) {
    test(`FUI-F2 contrast: a failed Workflow's danger words and error result read 4.5:1 or more, ${theme.id}`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const errors = [];
        page.on("pageerror", collectPageErrors(errors));
        const state = await routeChat(page, { tested: true });
        state.hn.revisions[1].lastTest.verdict = "failed";
        state.hn.workflows[0].runStatus = "failed";
        state.rows[0].status = "failed";
        const at = seconds => new Date(now - 200_000 + seconds * 1_000).toISOString();
        state.events = { [W1]: [
            { sessionId: W1, seq: 1, eventType: "workflow.started", createdAt: at(0), data: { runId: `run-${W1}`, mode: "live", revision: 1,
                definitionHash: `h-${W1}`, irSha256: "ir", name: "hn-top-watch", version: "1.0.0", initial: "poll", states: STATES } },
            { sessionId: W1, seq: 2, eventType: "workflow.state_started", createdAt: at(1), data: { runId: `run-${W1}`, nodeExecutionId: "nx-poll-1",
                stateId: "poll", scopeId: "root", ordinal: 1, type: "script", step: 1, kvRevision: 1 } },
            { sessionId: W1, seq: 3, eventType: "workflow.failed", createdAt: at(4), data: { runId: `run-${W1}`, stateId: "poll", outcome: null,
                error: { code: "execution_failed", message: "the feed did not answer" } } },
        ] };
        await page.route("**/me/profile", (route) => route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: { themeId: theme.id } } } }));
        const main = await openTab(page);
        await expect(page.locator("html")).toHaveAttribute("data-ps-theme", theme.id);
        await main.getByRole("combobox", { name: "Revision", exact: true }).selectOption("2");
        await expect(main.locator('[data-last-test="failed"]')).toBeVisible();
        await page.mouse.move(2, 400);
        const definition = await viewerContrast(page);
        // The Workflows list: #1 failed, its reason under its state.
        await viewSwitch(main, "Workflows").click();
        const list = main.getByRole("table", { name: "Workflows of hn-top-watch" });
        await expect(list.locator(`[data-session-id="${W1}"] .ps-wf-list-reason`)).toBeVisible();
        const listed = await viewerContrast(page);
        // #1: its failed step's error result, then its Log.
        await list.getByRole("button", { name: "Open hn-top-watch #1", exact: true }).click();
        await expect(main.locator(`.ps-wf-body[data-session-id="${W1}"]`)).toBeVisible();
        await main.getByRole("group", { name: "Workflow graph" }).getByRole("button", { name: "Inspect poll", exact: true }).click();
        await expect(main.locator(".ps-wf-result.is-error pre")).toBeVisible();
        await page.mouse.move(2, 400);
        const result = await viewerContrast(page);
        if (SHOTS) await main.screenshot({ path: path.join(SHOTS, `fui-f2-result-${theme.id}.png`) });
        // win95: the error result sits in a white well (read while the Node panel shows it; the Log replaces the panel).
        if (theme.id === "win95") {
            const well = await main.locator(".ps-wf-result.is-error pre").evaluate(element => getComputedStyle(element).backgroundColor);
            expect(well, "win95: the error result is a white well").toBe("rgb(255, 255, 255)");
        }
        await main.getByRole("tablist", { name: "Workflow panel" }).getByRole("tab", { name: "Log", exact: true }).click();
        await expect(main.locator('.ps-wf-log li[data-level="error"]').first()).toBeVisible();
        const log = await viewerContrast(page);
        if (SHOTS) await main.screenshot({ path: path.join(SHOTS, `fui-f2-log-${theme.id}.png`) });
        const all = [...definition, ...listed, ...result, ...log];
        for (const selector of [".ps-wf-last-test.is-failed", ".ps-wf-list-reason", ".ps-wf-result.is-error pre", '.ps-wf-log li[data-level="error"]']) {
            expect(all.some(item => item.selectors?.includes(selector)), `${theme.id}: measured ${selector}`).toBe(true);
        }
        const low = all.filter(item => item.ratio < item.min);
        expect(low, `${theme.id}: under the target`).toEqual([]);
        expect(errors).toEqual([]);
    });
}

// UX2D-F11: at 1024 px, with the Workflow tab open, the narrow session column showed a chat's Workflow rows as
// "… Completed [+1]": the state chip and the [+N] badge kept their width and the title gave all of its away. The title
// keeps its start (about 12 characters), and the chip gives way first.
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "UX2D-F11" (from packages/app/web, after build).
test("UX2D-F11: at 1024 px a Workflow row in the session list keeps its name and number; the state chip gives way first", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    await routeChat(page);
    await openTab(page);
    await expect(page.locator(".ps-workspace-main-grid")).toHaveClass(/is-session-wrap/);
    // A chat's children are collapsed by default: open its row so its Workflow rows show.
    const chatRow = page.locator(`.ps-session-list-button[data-session-id="${AGENT_ID}"]`).first();
    await chatRow.click();
    await expect(chatRow).not.toContainText("[+2]");
    for (const id of [W1, W2]) {
        const row = page.locator(`.ps-session-list-button[data-session-id="${id}"]`).first();
        await expect(row).toBeVisible();
        const shown = await row.locator(".ps-session-row-title").evaluate((title) => {
            const probe = document.createElement("span");
            probe.textContent = "0".repeat(10);
            probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
            title.appendChild(probe);
            const tenCh = probe.getBoundingClientRect().width;
            probe.remove();
            return { width: title.getBoundingClientRect().width, tenCh, text: title.textContent };
        });
        expect(shown.text, id).toMatch(/hn-top-watch #\d/);
        expect(shown.width, `${id}: the title keeps at least ten characters (${JSON.stringify(shown)})`).toBeGreaterThanOrEqual(shown.tenCh - 1);
    }
    await shot(page, "ux2d-f11-session-list-1024");
    expect(errors).toEqual([]);
});

// UX2D-F12: on a phone the Workflows list wrapped "revision 2" and its start time onto two lines each, and the run bar's
// state pill read "Running · …", its time taken cut. The list now takes two lines per Workflow with nothing wrapped, and
// the pill cuts its label, never the time.
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "UX2D-F12" (from packages/app/web, after build).
test("UX2D-F12: at 390 px the Workflows list wraps nothing, and the run bar's pill keeps the time taken", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    await routeChat(page);
    // #2 has run for 2 h 03 min 04 s: its start event.
    const startedAt = new Date(Date.now() - (2 * 3600 + 3 * 60 + 4) * 1000).toISOString();
    await page.route(`**/api/v1/**/sessions/${W2}/events**`, (route) => route.fulfill({ json: { ok: true, result: [
        { sessionId: W2, seq: 1, eventType: "workflow.started", createdAt: startedAt, data: { runId: `run-${W2}`, mode: "live", name: "hn-top-watch" } },
    ] } }));
    const main = await openTab(page);
    await viewSwitch(main, "Workflows").click();
    const list = main.getByRole("table", { name: "Workflows of hn-top-watch" });
    await expect(list.locator(".ps-wf-list-row:not(.is-head)")).toHaveCount(2);
    const oneLine = (cell) => cell.evaluate((element) => {
        const style = getComputedStyle(element);
        const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3;
        return { height: element.getBoundingClientRect().height, line, text: element.textContent };
    });
    for (const id of [W1, W2]) {
        const row = list.locator(`[data-session-id="${id}"]`);
        for (const field of ["ps-wf-list-version", "ps-wf-list-started", "ps-wf-list-took"]) {
            const cell = await oneLine(row.locator(`.${field}`));
            expect(cell.height, `${id} ${field}: one line (${JSON.stringify(cell)})`).toBeLessThan(cell.line * 1.6);
        }
    }
    await expect(list.locator(`[data-session-id="${W2}"] .ps-wf-list-took`)).toHaveText(/^2:03:\d{2}$/);
    await shot(page, "ux2d-f12-list-390");
    // The run bar: the pill keeps the time whole.
    await list.getByRole("button", { name: "Open hn-top-watch #2", exact: true }).click();
    const pill = main.locator(".ps-wf-bar.is-run .ps-wf-state");
    await expect(pill).toHaveText(/^Running · 2:03:\d{2}$/);
    const time = pill.locator(".ps-wf-state-time");
    const [pillBox, timeBox] = [await pill.boundingBox(), await time.boundingBox()];
    expect(timeBox.width).toBeGreaterThan(20);
    expect(timeBox.x + timeBox.width, "the time is inside the pill, not cut").toBeLessThanOrEqual(pillBox.x + pillBox.width + 1);
    const fits = await time.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
    expect(fits).toBe(true);
    await shot(page, "ux2d-f12-run-bar-390");
    expect(errors).toEqual([]);
});

// UXP-TL-01 (owner, TEST at 390 x 844, a running Workflow): the run bar's state chip collapsed to an empty pill ("·") beside
// Pause, Stop… and Run again…. The chip keeps its words and its time: the Workflow picker gives way first, then the buttons
// go to a line of their own; nothing overlaps and everything stays inside the screen.
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "UXP-TL-01" (from packages/app/web, after build).
test.describe("UXP-TL-01: a phone (390 x 844, touch)", () => {
    test.use({ hasTouch: true, isMobile: true });

    test("UXP-TL-01: a running Workflow's state chip keeps its words beside Pause, Stop… and Run again…", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        const errors = [];
        page.on("pageerror", collectPageErrors(errors));
        await routeChat(page, { controls: true });
        const startedAt = new Date(Date.now() - (2 * 3600 + 3 * 60 + 4) * 1000).toISOString();
        await page.route(`**/api/v1/**/sessions/${W2}/events**`, (route) => route.fulfill({ json: { ok: true, result: [
            { sessionId: W2, seq: 1, eventType: "workflow.started", createdAt: startedAt, data: { runId: `run-${W2}`, mode: "live", name: "hn-top-watch" } },
        ] } }));
        const main = await openTab(page);
        await viewSwitch(main, "Workflows").click();
        await main.getByRole("table", { name: "Workflows of hn-top-watch" }).getByRole("button", { name: "Open hn-top-watch #2", exact: true }).click();
        const bar = main.locator(".ps-wf-bar.is-run");
        const buttons = ["Pause", "Stop…", "Run again…"].map((name) => bar.getByRole("button", { name, exact: true }));
        for (const button of buttons) await expect(button).toBeVisible();
        const chip = bar.locator(".ps-wf-state");
        await expect(chip).toHaveText(/^Running · 2:03:\d{2}$/);
        await expect(chip.locator(".ps-wf-state-label")).toHaveText("Running");
        const cut = (locator) => locator.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
        for (const part of [chip, chip.locator(".ps-wf-state-label"), chip.locator(".ps-wf-state-time")]) {
            const size = await cut(part);
            expect(size.scroll, `not cut: ${JSON.stringify(size)}`).toBeLessThanOrEqual(size.client + 1);
        }
        const face = bar.locator(".ps-wf-picker.is-number");
        const boxes = [await face.boundingBox(), await chip.boundingBox(), ...await Promise.all(buttons.map((button) => button.boundingBox()))];
        for (const box of boxes) expect(box.x + box.width, "inside the screen").toBeLessThanOrEqual(390 + 0.5);
        const apart = (a, b) => a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5;
        for (let i = 0; i < boxes.length; i += 1) {
            for (let j = i + 1; j < boxes.length; j += 1) expect(apart(boxes[i], boxes[j]), `boxes ${i} and ${j} do not overlap`).toBe(true);
        }
        for (const button of buttons) {
            const box = await button.boundingBox();
            expect(Math.min(box.width, box.height), "44 px target").toBeGreaterThanOrEqual(44 - 0.01);
        }
        await shot(page, "uxp-tl-01-run-bar-390");
        expect(errors).toEqual([]);
    });
});
// Review S2UI-F3: Make a copy while a Workflow of the locked definition is the session shown opens the copy, as choosing it
// in the picker would.
test("S2UI-F3: Make a copy with the package Workflow's own row selected opens the editable copy", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routePackages(page);
    state.made = true;
    state.withWorkflow = true;
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${W_PKG}`);
    const main = workflowTab(page);
    await expect(main).toHaveAttribute("data-definition", "release-tools/release-watch");
    await main.getByRole("button", { name: "Definition", exact: true }).click();
    const banner = main.locator('[data-chat-definition="locked"]');
    await expect(banner.locator('[data-field="package"]')).toHaveText("from release-tools 1.2.0 · locked");
    await banner.locator('[data-action="copy"]').click();
    await expect.poll(() => state.copies.length).toBe(1);
    await expect(main).toHaveAttribute("data-definition", "release-watch");
    await expect(main.locator('[data-chat-definition="locked"]')).toHaveCount(0);
    // Formal L1: the copy says where it came from.
    await expect(main.locator('[data-field="copied-from"]')).toHaveText("Copied from release-tools/release-watch revision 1 (release-tools 1.2.0)");
    expect(errors).toEqual([]);
});

test("stage 2.3: a package's definition is locked: where it comes from, read-only YAML, Make a copy, and its newer version for the next Workflow", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routePackages(page);
    state.made = true;
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${COORD_ID}`);
    const main = await showPanel(page);
    await expect(main).toHaveAttribute("data-chat-definitions", "true");
    await expect(main.getByRole("combobox", { name: "Definition", exact: true }).locator("option:checked")).toHaveText("release-tools/release-watch · locked");
    const banner = main.locator('[data-chat-definition="locked"]');
    await expect(banner.locator('[data-field="package"]')).toHaveText("from release-tools 1.2.0 · locked");
    await expect(banner.locator('[data-field="package-update"]')).toHaveText("Version 1.3.0 is available");
    // Its YAML is shown read-only (the box every read-only revision uses) and says how to change it; there is no editor:
    // no chat editor (the editable case's .ps-wf-chat-editor), no YAML editor region and no Save.
    await main.getByRole("button", { name: "YAML", exact: true }).click();
    await expect(main.locator('[data-field="yaml-read-only"]')).toContainText("is locked: it cannot be changed here. Make a copy to change it.");
    const yaml = main.getByRole("textbox", { name: "Workflow YAML", exact: true });
    await expect(yaml).toHaveValue(WATCH_YAML);
    await expect(yaml).toHaveAttribute("readonly", "");
    await expect(yaml).not.toBeEditable();
    await expect(main.locator(".ps-wf-chat-editor")).toHaveCount(0);
    await expect(main.getByRole("region", { name: "YAML editor", exact: true })).toHaveCount(0);
    await expect(main.locator('[data-action="save"]')).toHaveCount(0);
    await shot(page, "s23-locked-1440");
    // The newer version, for the next Workflow: revision 2 is release-tools 1.3.0, and no newer one is offered.
    state.readDelayMs = 1_500;
    await banner.locator('[data-action="use-newer"]').click();
    await expect.poll(() => state.updates.length).toBe(1);
    expect(state.updates[0]).toMatchObject({ definitionId: "def-pkg" });
    expect(state.updates[0].operationId).toMatch(/^ui-update-/);
    await expect(banner.locator('[data-field="package"]')).toHaveText("from release-tools 1.3.0 · locked");
    await expect(banner.locator('[data-field="package-update"]')).toHaveCount(0);
    // Review CO-1: while revision 2 is read, Make a copy and Delete… stay as the last read said (they do not go and come back).
    await expect(main.locator(".ps-wf-yaml").getByText("Reading revision 2…", { exact: true })).toBeVisible();
    await expect(banner.locator('[data-action="copy"]')).toBeVisible({ timeout: 300 });
    await expect(main.locator('.ps-wf-info [data-action="delete"]')).toBeVisible({ timeout: 300 });
    await expect(main.locator('[data-field="yaml-read-only"]')).toBeVisible();
    // Make a copy (by the keyboard): the chat's own release-watch is shown, editable.
    await banner.locator('[data-action="copy"]').focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => state.copies.length).toBe(1);
    expect(state.copies[0]).toMatchObject({ definitionId: "def-pkg", revision: 2 });
    await expect(main).toHaveAttribute("data-definition", "release-watch");
    await expect(main.locator('[data-chat-definition="locked"]')).toHaveCount(0);
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// OF-S2-4 B and C (owner, 2026-11-07T19:14Z): "the first time a wf definition is created, just pop open the wf panel. and
// from then on if the user shuts it down, just put a yellow dot whenever there is a lifecycle event". With the panel
// closed, the portal reads the chat's definitions in the background (when the chat's rows change, at least every 30 s).
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "OF-S2-4" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
async function lifecycleChat(page) {
    const state = await routeChat(page, { emptyList: true });
    state.list = () => [];
    state.rows.length = 0;
    // The chat's agent works and stops (its status changes) as it saves: the session list's poll sees that, and the portal
    // reads the list then (review F3: statuses, not a row's update, make it read again). The status flips against the one
    // the browser last saw, so two saves between two polls (4 s) cannot cancel each other out.
    state.touch = () => {
        const busy = (state.servedStatus ?? (state.chat ?? CHAT).status) === "running";
        state.chat = { ...CHAT, status: busy ? "idle" : "running", updatedAt: Date.now() };
    };
    // The chat's first definition, saved by its agent now.
    state.fresh = () => {
        const made = new Date().toISOString();
        state.hn.createdAt = made;
        state.hn.revisions = [{ ...state.hn.revisions[0], createdAt: made }];
        state.hn.currentRevision = 1;
        state.hn.newestValidRevision = 1;
        state.hn.workflows = [];
        state.list = () => [state.view(state.hn)];
    };
    return state;
}

test("OF-S2-4: the chat's first definition opens the panel; closed, every lifecycle change lights the Workflow dot until it is opened", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await lifecycleChat(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    const button = page.getByRole("button", { name: /^(Workflow|Workflow — needs attention|Hide the Workflow tab)$/ });
    await expect(button).toHaveAccessibleName("Workflow");
    // The panel closed, the empty list is read in the background.
    await expect.poll(() => state.listReads, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(page.locator(".ps-wf-tab")).toHaveCount(0);

    // B: the agent saves the chat's first definition: the panel opens on it.
    state.fresh();
    state.touch();
    await expect(workflowTab(page)).toBeVisible({ timeout: 20_000 });
    await expect(workflowTab(page).getByRole("combobox", { name: "Definition", exact: true })).toBeVisible();
    await expect(button).toHaveAccessibleName("Hide the Workflow tab");
    await shot(page, "of-s2-4-auto-open-1440");
    // The person closes it.
    await button.click();
    await expect(page.locator(".ps-wf-tab")).toHaveCount(0);
    await expect(button).toHaveAccessibleName("Workflow");

    const dot = page.locator(".ps-toolbar .ps-canvas-badge");
    const expectDot = async (what) => {
        await expect(button, what).toHaveAccessibleName("Workflow — needs attention", { timeout: 20_000 });
        await expect(dot, what).toHaveCount(1);
        // Opened, it clears; closed again, no dot.
        await button.click();
        await expect(workflowTab(page)).toBeVisible();
        await expect(dot).toHaveCount(0);
        await button.click();
        await expect(page.locator(".ps-wf-tab")).toHaveCount(0);
        await expect(button).toHaveAccessibleName("Workflow");
    };
    // C: a new revision.
    const later = () => new Date(Date.now() + 1_000).toISOString();
    state.hn.revisions.push({ ...state.hn.revisions[0], revision: 2, createdAt: later(), basedOn: 1 });
    state.hn.currentRevision = 2;
    state.hn.newestValidRevision = 2;
    state.touch();
    await expectDot("a new revision");
    // C: a Workflow started.
    const startedAt = Date.now() + 1_000;
    state.hn.workflows.push({ workflowSessionId: W3, definitionId: "def-hn", revision: 2, runStatus: "running", createdAt: new Date(startedAt).toISOString() });
    state.rows.push({ sessionId: W3, title: "Workflow: hn-top-watch", status: "running", sessionKind: "workflow", parentSessionId: AGENT_ID,
        createdAt: startedAt, updatedAt: startedAt });
    await expectDot("a Workflow started");
    // A node visit (its row changes, its state does not): no dot.
    state.rows[0] = { ...state.rows[0], updatedAt: Date.now() + 2_000 };
    state.touch();
    await expect.poll(() => state.listReads, { timeout: 15_000 }).toBeGreaterThan(state.listReads);
    await expect(button).toHaveAccessibleName("Workflow");
    await expect(dot).toHaveCount(0);
    // C: paused, then canceled.
    state.rows[0] = { ...state.rows[0], status: "waiting", updatedAt: Date.now() + 3_000 };
    await expectDot("a Workflow paused");
    state.rows[0] = { ...state.rows[0], status: "cancelled", updatedAt: Date.now() + 4_000 };
    state.hn.workflows[0] = { ...state.hn.workflows[0], runStatus: "cancelled" };
    await expectDot("a Workflow canceled");
    await shot(page, "of-s2-4-dot-1440");
    expect(errors).toEqual([]);
});

test("OF-S2-4: on a phone the chat's first definition brings the Workflow pane up", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await lifecycleChat(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    await expect.poll(() => state.listReads, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(page.locator(".ps-wf-tab").filter({ visible: true })).toHaveCount(0);
    state.fresh();
    state.touch();
    await expect(workflowTab(page)).toBeVisible({ timeout: 20_000 });
    await shot(page, "of-s2-4-auto-open-390");
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// OF-S2-4d (owner, 19:45Z): "if I switch to a chat with a yellow dot on the workflow and it was the first time the dot had
// appeared then I want the panel to auto open. Follow the same behavior as canvas". The panel opens once per chat, the
// first time it has a change the person has not seen: on arrival (a switch or a page load) when it happened elsewhere.
// Once the panel was on screen (its receipt), later changes only light the dot.
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "OF-S2-4d" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
const OTHER_ID = "11111110-2222-3333-4444-555555555552";
const OTHER = { sessionId: OTHER_ID, title: "Release notes chat", status: "idle", model: "test:test-model", createdAt: now - 900_000, updatedAt: now - 30_000 };

test("OF-S2-4d: a definition saved while the person is in another chat opens the panel when they switch to it, once", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await lifecycleChat(page);
    state.others.push(OTHER);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${OTHER_ID}`);
    const button = page.getByRole("button", { name: /^(Workflow|Workflow — needs attention|Hide the Workflow tab)$/ });
    await expect(button).toHaveAccessibleName("Workflow");
    // The agent of the other chat saves its first definition; the person is not there.
    state.fresh();
    state.touch();
    await page.waitForTimeout(1_500);
    await expect(page.locator(".ps-wf-tab")).toHaveCount(0);
    // They switch to it: the panel opens on its definition.
    const reads = state.listReads;
    await page.locator(".ps-session-row-content", { hasText: CHAT.title }).first().click();
    await expect(workflowTab(page)).toHaveAttribute("data-chat-definitions", "true", { timeout: 15_000 });
    expect(state.listReads).toBeGreaterThan(reads);
    await expect(button).toHaveAccessibleName("Hide the Workflow tab");
    await shot(page, "of-s2-4d-arrival-1440");
    // Closed by hand, it stays closed: away and back.
    await button.click();
    await expect(page.locator(".ps-wf-tab")).toHaveCount(0);
    // Arriving reads the chat's list at once, so the count is taken before the switch (only this chat's reads are counted).
    const back = state.listReads;
    await page.locator(".ps-session-row-content", { hasText: OTHER.title }).first().click();
    await page.locator(".ps-session-row-content", { hasText: CHAT.title }).first().click();
    await expect.poll(() => state.listReads, { timeout: 15_000 }).toBeGreaterThan(back);
    await page.waitForTimeout(1_000);
    await expect(page.locator(".ps-wf-tab")).toHaveCount(0);
    await expect(button).toHaveAccessibleName("Workflow");
    // A new change lights the dot; the panel does not open.
    state.hn.revisions.push({ ...state.hn.revisions[0], revision: 2, createdAt: new Date(Date.now() + 1_000).toISOString(), basedOn: 1 });
    state.hn.currentRevision = 2;
    state.hn.newestValidRevision = 2;
    state.touch();
    await expect(button).toHaveAccessibleName("Workflow — needs attention", { timeout: 20_000 });
    await expect(page.locator(".ps-wf-tab")).toHaveCount(0);
    expect(errors).toEqual([]);
});

test("OF-S2-4d: a page load onto a chat whose panel never showed, with a definition, opens it; a chat with nothing does not", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routeChat(page);
    state.others.push(OTHER);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${OTHER_ID}`);
    await expect.poll(() => page.evaluate(() => document.querySelectorAll(".ps-session-row-content").length)).toBeGreaterThan(1);
    await page.waitForTimeout(1_500);
    await expect(page.locator(".ps-wf-tab")).toHaveCount(0);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    await expect(workflowTab(page)).toHaveAttribute("data-chat-definitions", "true", { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Hide the Workflow tab", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
});

test("OF-S2-4d: on a phone, arriving at a chat whose panel never showed brings the Workflow pane up", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    await routeChat(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    await expect(workflowTab(page)).toHaveAttribute("data-chat-definitions", "true", { timeout: 15_000 });
    await shot(page, "of-s2-4d-arrival-390");
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// OF-S2-5 (owner, 2026-11-07T20:58Z): "The subagent sessions did grow workflows but the icon doesn't show it. Need to
// workflow icon next to the session title if the session has grown a workflow." A sub-agent's row wears the Workflow glyph
// beside its title ("Has Workflows") once the session list says it owns a live definition: after its first save, without
// the person opening it or its definitions being read, and again after a reload. It is not a Workflow row's own mark.
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "OF-S2-5" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
const HELPER_ID = "11111110-2222-3333-4444-555555555553";

test("OF-S2-5: a sub-agent row shows the Workflow mark after its first save, unopened, and keeps it after a reload", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routeChat(page);
    const helper = { sessionId: HELPER_ID, title: "Release helper", status: "idle", model: "test:test-model", parentSessionId: OTHER_ID,
        createdAt: now - 800_000, updatedAt: now - 40_000, hasWorkflowDefinitions: false };
    state.others.push(OTHER, helper);
    // The person's settings name no collapsed row, so the sub-agent's row shows under its parent.
    await page.route("**/me/profile", (route) => route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: { collapsedSessionIds: [] } } } }));
    const helperDefinitionReads = [];
    page.on("request", (request) => { if (request.url().includes(`/sessions/${HELPER_ID}/workflow-definitions`)) helperDefinitionReads.push(request.url()); });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${OTHER_ID}`);
    const row = () => page.locator(`.ps-session-list-button[data-session-id="${HELPER_ID}"]`).first();
    await expect(row()).toBeVisible({ timeout: 15_000 });
    await expect(row().locator("[data-workflow-owner]")).toHaveCount(0);
    // The sub-agent saves its first definition; the next list read says so.
    helper.hasWorkflowDefinitions = true;
    helper.updatedAt = Date.now();
    const mark = row().locator('[data-workflow-owner="true"]');
    await expect(mark).toBeVisible({ timeout: 15_000 });
    await expect(mark).toHaveAttribute("title", "Has Workflows");
    await expect(mark).toHaveAccessibleName("Has Workflows");
    // Beside the title, and not a Workflow row's own (coloured, leading) mark.
    await expect(row().locator(".ps-workflow-kind")).toHaveCount(0);
    await expect(row().locator(".ps-session-row-title .ps-workflow-owner-mark")).toHaveCount(1);
    expect(helperDefinitionReads, "the mark comes from the list, not from opening the sub-agent").toEqual([]);
    await expect(page.locator(`.ps-session-list-button[data-session-id="${HELPER_ID}"].is-active, .ps-session-list-button[data-session-id="${HELPER_ID}"][aria-current="true"]`)).toHaveCount(0);
    await shot(page, "of-s2-5-sub-agent-row-1440");
    await page.reload();
    await expect(page.locator(`.ps-session-list-button[data-session-id="${HELPER_ID}"] [data-workflow-owner="true"]`).first()).toBeVisible({ timeout: 15_000 });
    expect(errors).toEqual([]);
});

// OF-S2-5, fixed in passing: the session list's own state lacked whether Workflows are on, so a package-made chat's badge never
// drew; with it, and the "Has Workflows" mark, the chat's title says it too.
// The chat's own header shows only below 921 px (index.css: on a desktop the session list names the chat and the header is
// hidden), so its mark is checked on a phone, on a chat whose Workflow pane does not come up by itself (the server's flag,
// nothing loaded); on a desktop the list row wears it (3d5ffa53 DEV: the header's mark was hidden at 1440 px by design).
test("OF-S2-5: the open chat's title wears the mark when it has grown Workflows", async ({ page }) => {
    test.setTimeout(60_000);
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routeChat(page);
    state.others.push({ ...OTHER, hasWorkflowDefinitions: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${OTHER_ID}`);
    await expect(page.locator(`.ps-session-list-button[data-session-id="${OTHER_ID}"] [data-workflow-owner="true"]`).first()).toBeVisible({ timeout: 15_000 });
    await page.setViewportSize({ width: 390, height: 844 });
    const title = page.locator(".ps-chat-panel .ps-panel-title").filter({ hasText: /Release notes/ }).first();
    const mark = title.locator('[data-workflow-owner="true"]');
    await expect(mark).toBeVisible({ timeout: 15_000 });
    await expect(mark).toHaveAttribute("title", "Has Workflows");
    await shot(page, "of-s2-5-header-390");
    expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------
// The UX round's three product findings (UX packages lens, replay r2):
// UX2R-F1: after a Workflow ran, the chat's Workflow tab opened on the Definition view with no word of it. It now names the
//   definition's newest Workflow and its state, and one click shows it.
// UX2P-F3: the YAML button's tooltip covered the "Copied from" and revision lines under the bar. The header's and the bar's
//   tooltips show above their buttons.
// UX2P-F1: on a 390 px phone the picker's Workflow row was 31.66 px tall and Create Session 34 px. Both are 44 px targets.
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "UX2" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
test("UX2R-F1: the tab opened on the Definition view names the newest Workflow and its state; View it shows it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    await routeChat(page);
    const main = await openTab(page);
    await expect(main).toHaveAttribute("data-view", "definition");
    const latest = main.locator('[data-field="latest-workflow"]');
    await expect(latest).toHaveText("Workflow #2 · Running · View it");
    await shot(page, "ux2r-f1-latest-1440");
    await latest.getByRole("button", { name: "View Workflow #2", exact: true }).click();
    await expect(workflowTab(page)).toHaveAttribute("data-view", "workflows");
    await expect(page.locator(`.ps-session-list-button[data-session-id="${W2}"]`).first()).toBeVisible();
    // Chosen by hand, the Definition view says nothing more.
    await viewSwitch(workflowTab(page), "Definition").click();
    await expect(workflowTab(page).locator('[data-field="latest-workflow"]')).toHaveCount(0);
    expect(errors).toEqual([]);
});

test("UX2P-F3: the bar's and the header's tooltips show above their buttons, never over the lines under the bar", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    await routeChat(page);
    const main = await openTab(page);
    for (const name of ["YAML", "Compare", "Definition"]) {
        const button = main.getByRole("button", { name, exact: true }).first();
        await button.hover();
        const tip = page.locator(".ps-icon-tooltip").filter({ hasText: name });
        await expect(tip).toBeVisible();
        const [tipBox, buttonBox] = [await tip.boundingBox(), await button.boundingBox()];
        expect(tipBox.y + tipBox.height, `${name}: the tooltip ends above its button`).toBeLessThanOrEqual(buttonBox.y + 1);
        await page.mouse.move(0, 0);
        await expect(tip).toHaveCount(0);
    }
    expect(errors).toEqual([]);
});

test("UX2P-F1: at 390 px the picker's rows and its dialog buttons are 44 px targets", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await routeChat(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
    await expect(page.locator(".ps-prompt-input")).toBeVisible();
    const heights = await page.evaluate(() => {
        const out = {};
        for (const [name, className] of [["row", "ps-list-button ps-modal-list-button"], ["create", "ps-modal-button is-primary"]]) {
            const button = document.createElement("button");
            button.className = className;
            button.textContent = name;
            document.body.appendChild(button);
            out[name] = button.getBoundingClientRect().height;
            button.remove();
        }
        return out;
    });
    expect(heights.row).toBeGreaterThanOrEqual(44);
    expect(heights.create).toBeGreaterThanOrEqual(44);
});

// ------------------------------------------------------------------------------------------------------------
// OF-S2-5-F1 (3d5ffa53 deployed check): at 1440 px the row's "Has Workflows" mark came after the whole row text (an untitled
// row's id · age · model), and the clamped title clipped it off the row (mark at x 319-345, row ending at 324). The mark
// now sits right after the title and never shrinks: the title takes the ellipsis, the rest gives way first. Its box is
// inside the row's visible box for a long title and for an untitled row, at 1440 and 390 px, and in the phone's header.
// Selector: npx playwright test test/e2e/workflow-chat-definitions.spec.mjs -g "OF-S2-5-F1" (from packages/app/web, after build).
// ------------------------------------------------------------------------------------------------------------
const LONG_ID = "11111110-2222-3333-4444-555555555554";
const UNTITLED_ID = "11111110-2222-3333-4444-555555555555";

/** Whether the mark of row `id` lies inside the row's visible box (and the list's, which clips it). */
async function markInsideRow(page, scope, id) {
    return page.locator(`${scope} .ps-session-list-button[data-session-id="${id}"]`).first().evaluate((row) => {
        const mark = row.querySelector('[data-workflow-owner="true"]');
        if (!mark) return { ok: false, why: "no mark" };
        const box = mark.getBoundingClientRect();
        let visible = row.getBoundingClientRect();
        // Every ancestor that clips narrows what is on screen.
        for (let node = mark.parentElement; node && node !== document.body; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.overflowX !== "visible" || style.overflow !== "visible") {
                const clip = node.getBoundingClientRect();
                visible = { left: Math.max(visible.left, clip.left), right: Math.min(visible.right, clip.right) };
            }
        }
        const ok = box.width > 0 && box.left >= visible.left - 0.5 && box.right <= visible.right + 0.5;
        return { ok, mark: [Math.round(box.left), Math.round(box.right)], visible: [Math.round(visible.left), Math.round(visible.right)] };
    });
}

test("OF-S2-5-F1: the mark stays on screen right after a long title and an untitled row's id, at 1440 and 390 px", async ({ page }) => {
    test.setTimeout(90_000);
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    const state = await routeChat(page);
    state.others.push(
        { sessionId: LONG_ID, title: "Quarterly release readiness review for the storage and networking teams, with every follow-up",
            status: "idle", model: "test:test-model", createdAt: now - 700_000, updatedAt: now - 20_000, hasWorkflowDefinitions: true },
        { sessionId: UNTITLED_ID, title: null, status: "idle", model: "test:test-model", createdAt: now - 650_000, updatedAt: now - 25_000,
            hasWorkflowDefinitions: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${OTHER_ID}`);
    for (const id of [LONG_ID, UNTITLED_ID]) {
        await expect(page.locator(`.ps-session-list-button[data-session-id="${id}"] [data-workflow-owner="true"]`).first()).toBeVisible({ timeout: 15_000 });
        const shown = await markInsideRow(page, "", id);
        expect(shown.ok, `1440 ${id}: ${JSON.stringify(shown)}`).toBe(true);
    }
    // The untitled row's mark follows its id, before its age and model.
    const untitledText = await page.locator(`.ps-session-list-button[data-session-id="${UNTITLED_ID}"] .ps-session-row-title`).first()
        .evaluate((title) => [...title.children].map((child) => child.className || child.tagName).join(" | "));
    expect(untitledText).toMatch(/ps-session-row-title__text \| ps-workflow-owner-mark \| ps-session-row-title__rest/);
    await shot(page, "of-s2-5-f1-rows-1440");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${LONG_ID}`);
    // The phone's header names the chat: a long title takes the ellipsis, the mark stays.
    const header = page.locator(".ps-chat-panel .ps-panel-title.has-owner-mark").first();
    await expect(header.locator('[data-workflow-owner="true"]')).toBeVisible({ timeout: 15_000 });
    const inHeader = await header.evaluate((title) => {
        const mark = title.querySelector('[data-workflow-owner="true"]').getBoundingClientRect();
        const box = title.getBoundingClientRect();
        return { ok: mark.width > 0 && mark.left >= box.left - 0.5 && mark.right <= box.right + 0.5, mark: [mark.left, mark.right], box: [box.left, box.right] };
    });
    expect(inHeader.ok, `390 header: ${JSON.stringify(inHeader)}`).toBe(true);
    // c0bb4171 DEV: the rows were measured while the slide-over was still off screen (visible box [8,0]). Open it, and
    // measure once it is on screen.
    const slideover = page.locator(".ps-mobile-session-slideover");
    await expect.poll(async () => {
        if (!/\bis-open\b/.test((await slideover.getAttribute("class")) ?? "")) await page.getByRole("button", { name: "Sessions", exact: true }).click();
        const box = await slideover.boundingBox();
        return Boolean(box && box.width > 0 && box.x >= -0.5 && box.x + box.width <= 390.5);
    }, { timeout: 15_000, message: "the session list is open and on screen" }).toBe(true);
    for (const id of [LONG_ID, UNTITLED_ID]) {
        await expect(page.locator(`.ps-mobile-session-slideover .ps-session-list-button[data-session-id="${id}"] [data-workflow-owner="true"]`).first())
            .toBeVisible({ timeout: 15_000 });
        await expect.poll(async () => (await markInsideRow(page, ".ps-mobile-session-slideover", id)).ok, { timeout: 5_000 }).toBe(true);
        const shown = await markInsideRow(page, ".ps-mobile-session-slideover", id);
        expect(shown.ok, `390 ${id}: ${JSON.stringify(shown)}`).toBe(true);
    }
    await shot(page, "of-s2-5-f1-rows-390");
    expect(errors).toEqual([]);
});
