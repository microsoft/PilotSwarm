/**
 * The real-model harness's evidence (test/helpers/workflow-v2-real-model-evidence.mjs), over a stand-in catalog and store
 * with the real store's method names and row fields (no database): each saved revision's YAML with its secrets hidden and
 * cut at 8 KB, with its diagnostics; each Workflow's and each test's runs with status, outcome and error; each node
 * execution's state, outcome and error, secrets hidden; a read that fails is recorded, never thrown.
 */
import { describe, it, expect } from "vitest";
import { EVIDENCE_YAML_MAX_BYTES, realModelWorkflowEvidence } from "../helpers/workflow-v2-real-model-evidence.mjs";

const SECRET = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
const VALID = `apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: counter, version: "1.0.0" }\n# Authorization: ${SECRET}\n`;

function standIn({ failNodes = false } = {}) {
    const runs = {
        "wf-1": [{ runId: "run-1", mode: "live", status: "failed", terminalOutcome: "failed", terminalNodeId: null,
            terminalError: { code: "execution_failed", message: `the script said ${SECRET}` } }],
        "bench-1": [{ runId: "run-t", mode: "test", status: "completed", terminalOutcome: "succeeded", terminalNodeId: "done", terminalError: null }],
    };
    const store = {
        listRuns: async id => runs[id] ?? [],
        listNodeExecutions: async runId => {
            if (failNodes) throw new Error("the node executions could not be read");
            return runId === "run-1" ? [
                { nodeId: "count", ordinal: 1, nodeType: "script", state: "completed", outcome: "execution_failed", resultKind: "runtime_error",
                    winner: "effect", error: { code: "execution_failed", message: `exit 1: ${SECRET}` } },
                { nodeId: "hold", ordinal: 1, nodeType: "wait", state: "pending", outcome: null, resultKind: null, winner: null, error: null },
            ] : [];
        },
        chat: {
            listDefinitions: async () => [{ definitionId: "def-1", name: "counter" }],
            listRevisions: async () => [{ revision: 1, valid: false, createdAt: "t1" }, { revision: 2, valid: true, createdAt: "t2" }],
            readRevision: async (_id, revision) => (revision === 1
                ? { yaml: `${"x".repeat(EVIDENCE_YAML_MAX_BYTES + 100)}`, diagnostics: [{ severity: "error", code: "WFV2_STATE_TYPE", path: "states.count.type",
                    line: 9, message: "count has an unknown type" }] }
                : { yaml: VALID, diagnostics: [] }),
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
            diagnostics: [{ severity: "error", code: "WFV2_STATE_TYPE", path: "states.count.type", line: 9, message: "count has an unknown type" }] });
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
});
