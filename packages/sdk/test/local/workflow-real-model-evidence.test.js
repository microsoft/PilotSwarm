/**
 * The real-model harness's evidence (test/helpers/workflow-real-model-evidence.mjs), over a stand-in catalog and store
 * with the real store's method names and row fields (no database): each saved revision's YAML with its secrets hidden and
 * cut at 8 KB, with its diagnostics; each Workflow's and each test's runs with status, outcome and error; each node
 * execution's state, outcome and error, secrets hidden; a read that fails is recorded, never thrown.
 */
import { describe, it, expect } from "vitest";
import { EVIDENCE_YAML_MAX_BYTES, realModelWorkflowEvidence } from "../helpers/workflow-real-model-evidence.mjs";

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
        chat: {
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
    it("records each revision's YAML (secrets hidden, cut at 8 KB) and diagnostics, and each run's and node execution's end with its error", async () => {
        const evidence = await realModelWorkflowEvidence(standIn(), "chat-1");
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
        const evidence = await realModelWorkflowEvidence(standIn({ failNodes: true }), "chat-1");
        expect(evidence.workflows[0].runs[0].nodes).toBe("unreadable: the node executions could not be read");
        const none = await realModelWorkflowEvidence({ workflowStore: () => { throw new Error("no workflow store"); } }, "chat-1");
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
            const text = JSON.stringify(await realModelWorkflowEvidence(standIn({ fail }), "chat-1"));
            expect(text, JSON.stringify(Object.keys(fail))).toContain("unreadable: could not read:");
            for (const secret of secrets) expect(text, `${Object.keys(fail)[0]}: ${secret}`).not.toContain(secret);
        }
    });
});
