/**
 * The checked-in example examples/workflows/support-desk (Decision, script and agent states in one Workflow), on PostgreSQL
 * with the Workflow controller on a native runtime. It reads the example from disk and:
 * - compiles it with no errors and no warnings, and checks seed.json (the save and Start payloads) matches it;
 * - saves it as the session definition `support-desk` and runs it through the agent's `workflow_definition test` surface
 *   with the example's fixtures.json: every Decision answer is a synthetic raw provider body and every agent step a mocked
 *   completion, so no provider or model is called. Each of the four tickets is one item of the For each, so the body's
 *   states are visited once per ticket with different inputs and outputs: a clear billing ticket whose draft the refund
 *   guardrail holds, a technical and an account ticket that are answered, and an ambiguous ticket the choice Decision
 *   routes `uncertain` (0.52 < 0.8);
 * - runs it again with a Decision error for one ticket (it goes to a person; the batch still ends `done`) and with a
 *   duplicate ticket id (the first script fails and the run ends at `failed` with the runtime error).
 *
 * Run: npx vitest run test/local/workflow-example-support-desk.test.js
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { parseBranchScope, registerWorkflow, sessionQueueTransport } from "../../src/workflow/runtime.ts";
import { saveSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { workflowDefinitionFromTool } from "../../src/workflow/definition-tool.ts";
import { AVAILABLE_DECISION, DECISION_DEFAULT } from "../helpers/workflow-decision-models.js";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const OWNER = { provider: "test", subject: "workflow-example-support-desk" };
const EXAMPLE = new URL("../../../../examples/workflows/support-desk/", import.meta.url);
const read = file => fs.readFileSync(new URL(file, EXAMPLE), "utf8");
const YAML = read("support-desk.workflow.yaml");
const INPUTS = JSON.parse(read("sample-input.json"));
const FIXTURES = JSON.parse(read("fixtures.json"));
const SEED = JSON.parse(read("seed.json"));
const NAME = "support-desk";

/** A worker-equivalent registration with an eligible Cluster Decision Default; no Decision provider host (a test never calls one). */
async function harness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    const notices = [];
    registerWorkflow({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => ({ tools: [], excludedTools: [] }),
        openToolExecutor: async () => { throw new Error("A test run never opens the live tool executor."); },
        authorizeParentNotification: async () => true,
        notifyParent: async (parentSessionId, text) => { notices.push({ parentSessionId, text }); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        testPollMs: 50,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
    });
    await runtime.start();
    const host = {
        catalog, store, duroxideClient: client, scripts: true,
        decisionCapability: async () => structuredClone(AVAILABLE_DECISION),
        resolveDecisionProviderBindings: async models => Object.fromEntries(models.map(model => [model, {
            providerInstanceId: "00000000-0000-4000-8000-000000000001",
            providerName: model.slice(0, model.indexOf(":")),
            providerTypeId: "foundry-wif",
            modelQualified: model,
        }])),
    };
    const session = randomUUID();
    await catalog.createSession(session, { owner: OWNER });
    const saved = (await saveSessionWorkflowDefinition(host, { ownerSessionId: session, name: NAME, yaml: YAML, expected: null,
        actor: { kind: "session", sessionId: session }, operationId: `save-${randomUUID()}`, by: "session" })).receipt;
    const call = args => workflowDefinitionFromTool({ name: NAME, ...args }, {
        callerSessionId: session, host, toolCallId: randomUUID(), owner: OWNER, binding: async () => null,
        testWait: { waitMs: 120_000, pollMs: 50, graceMs: 10_000 },
    }).then(text => JSON.parse(text));
    /** A test to its end: a report still running is read again by its test_id. */
    const test = async args => {
        let report = await call({ operation: "test", ...args });
        while (report.ok && report.status === "running") report = await call({ operation: "test", test_id: report.testId });
        return report;
    };
    return {
        store, notices, saved, test,
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

/** The run's visits grouped by For each item (ticket id), each as "state:outcome" in order; and the outer visits. */
async function visitsByTicket(store, runId) {
    const nodes = await store.listNodeExecutions(runId, 500);
    const tickets = new Map(), outer = [];
    for (const node of nodes) {
        const scope = parseBranchScope(node.scopeId);
        if (scope === null) { outer.push(node); continue; }
        const id = INPUTS.tickets[scope.index].id;
        if (!tickets.has(id)) tickets.set(id, []);
        tickets.get(id).push(node);
    }
    const routes = Object.fromEntries([...tickets].map(([id, list]) => [id, list.map(node => `${node.nodeId}:${node.outcome}`)]));
    const at = (id, state) => tickets.get(id)?.find(node => node.nodeId === state);
    return { nodes, outer, routes, at };
}

const ANSWERED = ["classify", "assess_severity", "set_priority", "draft_reply", "check_refund_promise", "close_ticket", "ticket_answered"];

describe("example Workflow: support desk triage (Decision, script and agent states)", () => {
    it("compiles with no diagnostics, and seed.json carries the exact YAML and sample input", () => {
        const compiled = compileWorkflow(YAML);
        expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
        expect(compiled.diagnostics).toEqual([]);
        expect(compiled.name).toBe(NAME);
        const types = Object.fromEntries(Object.values(compiled.ir.nodes).map(node => [node.id, node.type]));
        expect(Object.values(types).filter(type => type === "decision")).toHaveLength(3);
        expect(Object.values(types).filter(type => type === "agent")).toHaveLength(2);
        expect(Object.values(types).filter(type => type === "script").length).toBeGreaterThanOrEqual(4);
        expect(Object.values(compiled.ir.nodes).filter(node => node.type === "decision").map(node => node.question.type).sort())
            .toEqual(["choice", "noul", "score"]);
        expect(SEED.save).toEqual({ operation: "save", name: NAME, yaml: YAML });
        expect(SEED.test).toEqual({ operation: "test", name: NAME, inputs: INPUTS, fixtures: FIXTURES, expect: "done" });
        expect(SEED.start).toEqual({ operation: "start", name: NAME, inputs: INPUTS });
    });

    it("the mocked test reaches done with each ticket on its own route through the For each body", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            expect(h.saved.valid, JSON.stringify(h.saved.diagnostics)).toBe(true);
            expect(h.saved.diagnostics).toEqual([]);
            const report = await h.test({ inputs: INPUTS, fixtures: FIXTURES, expect: "done" });
            expect(report, JSON.stringify(report).slice(0, 4_000)).toMatchObject({
                ok: true, status: "passed", run: { status: "completed", outcome: "succeeded", terminalState: "done" },
                firstError: null, unanswered: null, refused: null,
            });
            // 4 + 3 + 3 Decision calls and 3 + 1 agent calls, every one answered by a prepared answer.
            const answered = report.answeredCalls.map(item => `${item.call} by ${item.by}`);
            const countOf = call => answered.filter(item => item === `${call} by prepared answer`).length;
            expect(countOf("Decision step classify")).toBe(4);
            expect(countOf("Decision step assess_severity")).toBe(3);
            expect(countOf("Decision step check_refund_promise")).toBe(3);
            expect(countOf("agent step draft_reply")).toBe(3);
            expect(countOf("agent step write_summary")).toBe(1);
            expect(answered).toHaveLength(14);

            const run = await h.store.readRun(report.runId);
            const { nodes, outer, routes, at } = await visitsByTicket(h.store, report.runId);
            expect(nodes).toHaveLength(29);
            expect(outer.map(node => `${node.nodeId}:${node.outcome}`)).toEqual([
                "prepare_batch:ready", "triage_tickets:joined", "write_summary:written", "publish_summary:published", "done:succeeded",
            ]);
            expect(routes).toEqual({
                "T-1001": ["classify:billing", "assess_severity:scored", "set_priority:prioritized", "draft_reply:drafted",
                    "check_refund_promise:yes", "queue_for_review:queued", "ticket_for_review:succeeded"],
                "T-1002": ANSWERED.map((state, index) => `${state}:${["technical", "scored", "prioritized", "drafted", "no", "answered", "succeeded"][index]}`),
                "T-1003": ANSWERED.map((state, index) => `${state}:${["account", "scored", "prioritized", "drafted", "no", "answered", "succeeded"][index]}`),
                "T-1004": ["classify:uncertain", "queue_for_review:queued", "ticket_for_review:succeeded"],
            });

            // The same state, visited once per ticket, with that ticket's input and output.
            expect(INPUTS.tickets.map(ticket => at(ticket.id, "classify").input)).toEqual(
                INPUTS.tickets.map(ticket => ({ subject: ticket.subject, body: ticket.body })));
            expect(at("T-1004", "classify").output).toMatchObject({
                questionType: "choice", outcome: "uncertain", selection: "billing", confidence: 0.52,
                policy: { minimumProbability: 0.8, uncertain: true }, model: { qualified: DECISION_DEFAULT },
            });
            expect(at("T-1001", "classify").output).toMatchObject({ outcome: "billing", confidence: 0.94 });
            // Carry: the Decision's output is only the semantic result; the ticket rides beside it.
            expect(at("T-1001", "classify").carrySnapshot).toEqual({ stage: "classify", case: { ticket: INPUTS.tickets[0] } });
            expect(at("T-1002", "assess_severity").output).toMatchObject({ questionType: "score", outcome: "scored", score: 2.12 });
            expect(at("T-1002", "assess_severity").output.levels.map(level => level.label)).toEqual(["Low", "Normal", "High", "Critical"]);
            expect(["T-1001", "T-1002", "T-1003"].map(id => at(id, "set_priority").output))
                .toEqual([["Normal", 1.3, "P3", 24], ["High", 2.12, "P2", 8], ["Low", 0.31, "P4", 72]].map(([label, score, priority, slaHours], index) =>
                    ({ ticket: INPUTS.tickets[index], queue: ["billing", "technical", "account"][index], severity: { label, score }, priority, slaHours })));
            expect(at("T-1001", "check_refund_promise").output).toMatchObject({ questionType: "noul", outcome: "yes", probability: 0.93 });
            expect(at("T-1002", "check_refund_promise").output).toMatchObject({ questionType: "noul", outcome: "no", confidence: 0.97 });

            const report2 = run.terminalOutput;
            expect(report2).toMatchObject({
                shift: INPUTS.shift,
                totals: { tickets: 4, answered: 2, needsReview: 2 },
                byQueue: { billing: 1, technical: 1, account: 1, unrouted: 1 },
                byPriority: { P1: 0, P2: 1, P3: 1, P4: 1 },
                headline: "Four tickets triaged: two answered, two waiting for a person",
            });
            expect(report2.tickets.map(ticket => [ticket.ticketId, ticket.status, ticket.queue, ticket.priority, ticket.review?.stage ?? null])).toEqual([
                ["T-1001", "needs_review", "billing", "P3", "guardrail"],
                ["T-1002", "answered", "technical", "P2", null],
                ["T-1003", "answered", "account", "P4", null],
                ["T-1004", "needs_review", null, null, "classify"],
            ]);
            expect(report2.tickets[0].review.reason).toBe("The draft reply promises a refund (93%); a billing lead must approve it.");
            expect(report2.tickets[3].review.reason).toBe("Queue unclear: billing 52%, technical 44%, account 4% (needs 80%).");
            expect(h.notices).toEqual([]);
        } finally { await h.stop(); }
    });

    it("a Decision error sends that ticket to a person and the batch still ends done; a duplicate ticket id fails the run", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const throttled = { operation: "decision", state: "classify", arguments: { subject: INPUTS.tickets[1].subject, body: INPUTS.tickets[1].body },
                response: { kind: "error", value: { code: "unavailable", message: "The Decision provider is throttling requests." } } };
            const report = await h.test({ inputs: INPUTS, fixtures: [throttled, ...FIXTURES], expect: "done" });
            expect(report, JSON.stringify(report).slice(0, 4_000)).toMatchObject({ ok: true, status: "passed", run: { terminalState: "done" } });
            const { routes, at } = await visitsByTicket(h.store, report.runId);
            expect(routes["T-1002"]).toEqual(["classify:unavailable", "queue_for_review:queued", "ticket_for_review:succeeded"]);
            expect(at("T-1002", "queue_for_review").output.review).toEqual({ stage: "classify",
                reason: "Automation stopped at classify (unavailable): The Decision provider is throttling requests." });
            const run = await h.store.readRun(report.runId);
            expect(run.terminalOutput.totals).toEqual({ tickets: 4, answered: 1, needsReview: 3 });

            const duplicate = { ...INPUTS, tickets: [INPUTS.tickets[0], INPUTS.tickets[0]] };
            const failed = await h.test({ inputs: duplicate, fixtures: FIXTURES, expect: "failed" });
            expect(failed, JSON.stringify(failed).slice(0, 4_000)).toMatchObject({
                ok: true, status: "passed", run: { outcome: "failed", terminalState: "failed" },
            });
            const end = await h.store.readRun(failed.runId);
            expect(end.terminalOutput).toMatchObject({ code: "execution_failed" });
            expect(JSON.stringify(end.terminalOutput)).toContain("Ticket T-1001 appears twice in the batch.");
        } finally { await h.stop(); }
    });
});
