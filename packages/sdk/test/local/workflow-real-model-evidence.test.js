/**
 * The real-model harness's evidence (test/helpers/workflow-real-model-evidence.mjs), over a stand-in catalog and store
 * with the real store's method names and row fields (no database): each saved revision's YAML with its secrets hidden and
 * cut at 8 KB, with its diagnostics; each Workflow's and each test's runs with status, outcome and error; each node
 * execution's state, outcome and error, secrets hidden; a read that fails is recorded, never thrown.
 */
import { describe, it, expect } from "vitest";
import {
    EVIDENCE_MODEL_REQUESTS_MAX, EVIDENCE_RECEIPT_MAX_BYTES, EVIDENCE_SESSION_EVENT_MAX_BYTES,
    EVIDENCE_SESSION_EVENTS_MAX, EVIDENCE_SESSION_MAX_BYTES, EVIDENCE_YAML_MAX_BYTES,
    evidenceText, healthyBetweenTurns, modelRequestEvidence, realModelSessionEvidence, realModelWorkflowEvidence, receiptJson,
} from "../helpers/workflow-real-model-evidence.mjs";

const SECRET = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
const VALID = `apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: counter, version: "1.0.0" }\n# Authorization: ${SECRET}\n`;

function standIn({ failNodes = false, fail = null } = {}) {
    const runs = {
        "wf-1": [{ runId: "run-1", mode: "live", status: "failed", terminalOutcome: "failed", terminalNodeId: null,
            terminalError: { code: "execution_failed", message: `the script said ${SECRET}` } }],
        "bench-1": [{ runId: "run-t", mode: "test", status: "completed", terminalOutcome: "succeeded", terminalNodeId: "done", terminalError: null }],
    };
    const store = {
        listRuns: async id => {
            if (fail?.runs) throw new Error(fail.runs);
            return runs[id] ?? [];
        },
        listNodeExecutions: async runId => {
            if (fail?.nodes) throw new Error(fail.nodes);
            if (failNodes) throw new Error("the node executions could not be read");
            return runId === "run-1" ? [
                { nodeId: "count", ordinal: 1, nodeType: "script", state: "completed", outcome: "execution_failed", resultKind: "runtime_error",
                    winner: "effect", error: { code: "execution_failed", message: `exit 1: ${SECRET}` } },
                { nodeId: "hold", ordinal: 1, nodeType: "wait", state: "pending", outcome: null, resultKind: null, winner: null, error: null },
            ] : [];
        },
        sessionDefinitions: {
            listDefinitions: async () => {
                if (fail?.definitions) throw new Error(fail.definitions);
                return [{ definitionId: "def-1", name: "counter" }];
            },
            listRevisions: async () => [{ revision: 1, valid: false, createdAt: "t1" }, { revision: 2, valid: true, createdAt: "t2" }],
            readRevision: async (_id, revision) => { if (fail?.revision) throw new Error(fail.revision); return (revision === 1
                ? { yaml: `${"x".repeat(EVIDENCE_YAML_MAX_BYTES + 100)}`, diagnostics: [{ severity: "error", code: "WORKFLOW_STATE_TYPE", path: "states.count.type",
                    line: 9, message: "count has an unknown type" }] }
                : { yaml: VALID, diagnostics: [] }); },
            listTests: async () => [{ testId: "bench-1", definitionId: "def-1", revision: 2, verdict: "passed" }],
            listWorkflows: async () => [{ workflowSessionId: "wf-1", definitionId: "def-1", revision: 2, runStatus: "failed" }],
        },
    };
    return { workflowStore: () => store };
}

describe("the real-model receipt's Workflow evidence", () => {
    it("keeps failed-session state, the answer and tool diagnostics even when no Workflow was created", async () => {
        const events = [
            { seq: 0, eventType: "tool.execution_start", data: { toolName: "enable_workflows", args: {} } },
            { seq: 1, eventType: "assistant.message", data: { content: "A counter source is required." } },
            { seq: 2, eventType: "tool.execution_complete", data: {
                toolName: "workflow_definition", success: false, result: "Invalid input", token: "secret-value",
            } },
            { seq: 3, eventType: "session.error", data: { message: "The turn failed." } },
        ];
        const evidence = await realModelSessionEvidence({
            getSession: async () => ({ state: "error", lastError: "The turn failed." }),
            getSessionCapabilities: async () => ({ workflows: true }),
            getSessionEvents: async (id, after, limit, types) => {
                expect(id).toBe("session-1");
                expect(after).toBe(0);
                expect(limit).toBe(EVIDENCE_SESSION_EVENTS_MAX + 1);
                expect(types).toContain("session.error");
                expect(types).toContain("tool.execution_complete");
                return events;
            },
        }, "session-1");
        expect(evidence.session).toEqual({ state: "error", lastError: "The turn failed." });
        expect(evidence.events.map(event => event.type)).toEqual(events.map(event => event.eventType));
        expect(evidence.events[1].data).toContain("A counter source is required.");
        expect(evidence.events[2].data).toContain("Invalid input");
        expect(evidence.enableWorkflowsRan).toBe(true);
        expect(evidence.workflowsOn).toBe(true);
        expect(JSON.stringify(evidence)).not.toContain("secret-value");
    });

    it("bounds session evidence and records each read failure instead of implying a healthy session", async () => {
        const evidence = await realModelSessionEvidence({
            getSession: async () => { throw new Error("session read failed"); },
            getSessionCapabilities: async () => null,
            getSessionEvents: async () => Array.from({ length: EVIDENCE_SESSION_EVENTS_MAX + 1 }, (_, seq) => ({
                seq, eventType: "assistant.message", data: { content: seq === 0 ? "x".repeat(EVIDENCE_SESSION_EVENT_MAX_BYTES + 100) : "ok" },
            })),
        }, "session-1");
        expect(evidence.session).toBe("unreadable: session read failed");
        expect(evidence.events).toHaveLength(EVIDENCE_SESSION_EVENTS_MAX);
        expect(evidence.eventsCut).toContain(String(EVIDENCE_SESSION_EVENTS_MAX));
        expect(evidence.events[0].data).toContain("[cut:");
        const missing = await realModelSessionEvidence({
            getSession: async () => null,
            getSessionEvents: async () => { throw new Error("event read failed"); },
            getSessionCapabilities: async () => { throw new Error("capability read failed"); },
        }, "missing");
        expect(missing).toEqual({ session: null, events: "unreadable: event read failed",
            workflowsOn: "unreadable: capability read failed" });
    });

    it("rejects failed states even when allowed, and lets each case decide whether a question is valid", () => {
        for (const state of ["failed", "error", "cancelled", "input_required"]) {
            expect(() => healthyBetweenTurns({ state, lastError: "A required step failed." }))
                .toThrow(`Session did not settle successfully: ${state}: A required step failed.`);
        }
        for (const state of ["idle", "waiting", "completed"]) expect(healthyBetweenTurns({ state })).toBe(true);
        const withQuestions = new Set(["idle", "input_required"]);
        expect(healthyBetweenTurns({ state: "input_required" }, withQuestions)).toBe(true);
        expect(healthyBetweenTurns({ state: "idle" }, withQuestions)).toBe(true);
        expect(healthyBetweenTurns({ state: "waiting" }, withQuestions)).toBe(false);
        for (const state of ["failed", "error", "cancelled"]) {
            expect(() => healthyBetweenTurns({ state }, new Set([state]))).toThrow(`Session did not settle successfully: ${state}`);
        }
        for (const state of ["running", "pending"]) expect(healthyBetweenTurns({ state })).toBe(false);
        expect(healthyBetweenTurns(null)).toBe(false);
    });

    it("keeps a full tool argument and returned diagnostic within the evidence cap", async () => {
        const args = { name: "counter", yaml: "x".repeat(10_000) };
        const result = { ok: false, error: { code: "WORKFLOW_COMMAND_INVALID", message: "save needs name" } };
        const evidence = await realModelSessionEvidence({
            getSession: async () => ({ state: "idle", lastError: null }),
            getSessionCapabilities: async () => ({ workflows: true }),
            getSessionEvents: async () => [
                { seq: 1, eventType: "tool.execution_start", data: { toolName: "workflow_definition", args } },
                { seq: 2, eventType: "tool.execution_complete", data: { toolName: "workflow_definition", result } },
            ],
        }, "session-1");
        expect(JSON.parse(evidence.events[0].data).args).toEqual(args);
        expect(JSON.parse(evidence.events[1].data).result).toEqual(result);
    });

    it("caps session event bytes and request rows without mutating or hiding recorder errors", async () => {
        const events = await realModelSessionEvidence({
            getSession: async () => ({ state: "idle" }),
            getSessionCapabilities: async () => null,
            getSessionEvents: async () => Array.from({ length: 50 }, (_, seq) => ({
                seq, eventType: "assistant.message", data: { content: "x".repeat(EVIDENCE_SESSION_EVENT_MAX_BYTES) },
            })),
        }, "session-1");
        expect(Buffer.byteLength(JSON.stringify(events.events))).toBeLessThanOrEqual(EVIDENCE_SESSION_MAX_BYTES);
        expect(events.eventsCut).toBeDefined();
        const requests = Array.from({ length: EVIDENCE_MODEL_REQUESTS_MAX + 4 }, (_, request) => ({
            request, model: "fixture", tools: ["workflow_definition"],
        }));
        const recorder = { source: "http-request", requests, cliMetadata: requests,
            errors: ["MODEL_HTTP_429", "ECONNRESET"], cancellations: [] };
        const evidence = modelRequestEvidence(recorder);
        expect(evidence.requests).toHaveLength(EVIDENCE_MODEL_REQUESTS_MAX);
        expect(evidence.requestsOmitted).toBe(4);
        expect(evidence.requestsCount).toBe(requests.length);
        expect(evidence.transportErrors).toEqual(recorder.errors);
        expect(requests).toHaveLength(EVIDENCE_MODEL_REQUESTS_MAX + 4);
        recorder.errors.push("later-error");
        expect(evidence.transportErrors).not.toContain("later-error");
    });

    it("redacts unnamed credential tokens and emits valid JSON within the total receipt byte cap", () => {
        const rawTokens = ["ghp_" + "a".repeat(36), "github_pat_" + "b".repeat(40), "sk-proj-" + "c".repeat(36)];
        const small = receiptJson({ test: "synthetic", verdict: "FAIL", answer: rawTokens.join(" ") });
        for (const token of rawTokens) {
            expect(small).not.toContain(token);
            expect(evidenceText(token)).toBe("<hidden>");
        }
        expect(JSON.parse(small).answer).toContain("<hidden>");
        const json = receiptJson({ test: "large", verdict: "FAIL", answer: rawTokens.join(" "),
            payload: "\u0000\"\\x".repeat(EVIDENCE_RECEIPT_MAX_BYTES) });
        expect(Buffer.byteLength(json + "\n")).toBeLessThanOrEqual(EVIDENCE_RECEIPT_MAX_BYTES);
        expect(JSON.parse(json).receiptTruncated.originalBytes).toBeGreaterThan(EVIDENCE_RECEIPT_MAX_BYTES);
        for (const token of rawTokens) expect(json).not.toContain(token);
    });

    it("records each revision's YAML (secrets hidden, cut at 8 KB) and diagnostics, and each run's and node execution's end with its error", async () => {
        const evidence = await realModelWorkflowEvidence(standIn(), "owner-1");
        const text = JSON.stringify(evidence);
        expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
        const [first, second] = evidence.revisions;
        expect(first).toMatchObject({ definitionId: "def-1", name: "counter", revision: 1, valid: false,
            diagnostics: [{ severity: "error", code: "WORKFLOW_STATE_TYPE", path: "states.count.type", line: 9, message: "count has an unknown type" }] });
        expect(Buffer.byteLength(first.yaml.split("…")[0], "utf8")).toBe(EVIDENCE_YAML_MAX_BYTES);
        expect(first.yaml).toMatch(/… \[cut: \d+ bytes in all\]$/);
        expect(second).toMatchObject({ revision: 2, valid: true, diagnostics: [] });
        expect(second.yaml).toContain("kind: Workflow");
        expect(evidence.workflows).toEqual([{ workflowSessionId: "wf-1", definitionId: "def-1", revision: 2, runs: [{
            runId: "run-1", mode: "live", status: "failed", outcome: "failed", terminalState: null,
            error: { code: "execution_failed", message: expect.any(String) },
            nodes: [
                { nodeId: "count", step: 1, type: "script", state: "completed", outcome: "execution_failed", resultKind: "runtime_error", winner: "effect",
                    error: { code: "execution_failed", message: expect.stringContaining("exit 1:") } },
                { nodeId: "hold", step: 1, type: "wait", state: "pending", outcome: null, resultKind: null, winner: null, error: null },
            ] }] }]);
        expect(evidence.tests).toEqual([{ workflowSessionId: "bench-1", definitionId: "def-1", revision: 2, verdict: "passed",
            runs: [{ runId: "run-t", mode: "test", status: "completed", outcome: "succeeded", terminalState: "done", error: null, nodes: [] }] }]);
    });

    it("records a read that fails instead of throwing", async () => {
        const evidence = await realModelWorkflowEvidence(standIn({ failNodes: true }), "owner-1");
        expect(evidence.workflows[0].runs[0].nodes).toBe("unreadable: the node executions could not be read");
        const none = await realModelWorkflowEvidence({ workflowStore: () => { throw new Error("no workflow store"); } }, "owner-1");
        expect(none).toEqual({ revisions: [], workflows: [], tests: [], error: "unreadable: no workflow store" });
    });

    // Review DSS-002: a read that fails is recorded with its message's secrets hidden before the message is cut, in every
    // failure branch (a run's node executions, a Workflow's runs, a revision, the whole read). Synthetic values only.
    it("DSS-002: a failed read's message keeps no secret, also one the cut would have split", async () => {
        const header = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789";
        const field = '{"token": "tok-abcdefghijklmnopqrstuvwx"}';
        const url = "postgres://evidence-user:evidence-pass-0123456789@db.example.test:5432/app";
        // The second message's credential starts 283 characters in: a 300-character cut would keep its first 17.
        const messages = [`could not read: ${header}; ${field}; ${url}`, `could not read: ${"x".repeat(244)} ${header}`];
        expect(messages[1].indexOf("abcdefghij")).toBe(283);
        const secrets = ["abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmnop", "tok-abcdefghijklmnopqrstuvwx", "evidence-pass-0123456789", "evidence-pass"];
        for (const fail of messages.flatMap(message => [{ nodes: message }, { runs: message }, { revision: message }, { definitions: message }])) {
            const text = JSON.stringify(await realModelWorkflowEvidence(standIn({ fail }), "owner-1"));
            expect(text, JSON.stringify(Object.keys(fail))).toContain("unreadable: could not read:");
            for (const secret of secrets) expect(text, `${Object.keys(fail)[0]}: ${secret}`).not.toContain(secret);
        }
    });
});
