import test from "node:test";
import assert from "node:assert/strict";
import { PgSessionCatalog } from "../../dist/cms.js";

function createCatalogHarness() {
    const calls = [];
    const pool = {
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql.includes("workflow_projections WHERE")) {
                return {
                    rows: [{
                        workflow_session_id: "workflow-1",
                        graph_id: "graph-1",
                        status: "running",
                        current_state_id: "inspect",
                        current_execution_sequence: "3",
                        waiting_on: "agent-result",
                        terminal_outcome: null,
                        result_json: null,
                        completed_at: null,
                        updated_at: "2026-10-07T20:00:00.000Z",
                    }],
                };
            }
            if (sql.includes("workflow_state_executions")) {
                return {
                    rows: [{
                        workflow_session_id: "workflow-1",
                        execution_sequence: "3",
                        graph_id: "graph-1",
                        state_id: "inspect",
                        child_session_id: "child-1",
                        waiting_on: "agent-result",
                        status: "accepted",
                        outcome: "succeeded",
                        output_json: { commit: "abc123" },
                        admitted_at: "2026-10-07T19:59:00.000Z",
                        accepted_at: "2026-10-07T20:00:00.000Z",
                        updated_at: "2026-10-07T20:00:00.000Z",
                    }],
                };
            }
            return { rows: [] };
        },
    };
    return {
        catalog: new PgSessionCatalog(pool, "workflow_test"),
        calls,
    };
}

test("catalog writes authoritative workflow facts through migration procedures", async () => {
    const { catalog, calls } = createCatalogHarness();

    await catalog.recordWorkflowExecution({
        workflowSessionId: "workflow-1",
        executionSequence: 3,
        graphId: "graph-1",
        stateId: "inspect",
        childSessionId: "child-1",
        waitingOn: "agent-result",
    });
    await catalog.acceptWorkflowExecution({
        workflowSessionId: "workflow-1",
        executionSequence: 3,
        graphId: "graph-1",
        stateId: "inspect",
        childSessionId: "child-1",
        outcome: "succeeded",
        output: { commit: "abc123" },
    });
    await catalog.completeWorkflowProjection({
        workflowSessionId: "workflow-1",
        parentSessionId: "parent-1",
        graphId: "graph-1",
        terminalStateId: "done",
        outcome: "succeeded",
        summary: "Done.",
        result: { outcome: "succeeded" },
        completedAt: new Date("2026-10-07T20:01:00.000Z"),
    });
    await catalog.rebuildWorkflowProjection("workflow-1");

    assert.match(calls[0].sql, /cms_record_workflow_execution/);
    assert.deepEqual(calls[0].params, [
        "workflow-1", 3, "graph-1", "inspect", "child-1", "agent-result",
    ]);
    assert.match(calls[1].sql, /cms_accept_workflow_execution/);
    assert.equal(calls[1].params[6], JSON.stringify({ commit: "abc123" }));
    assert.match(calls[2].sql, /cms_complete_workflow/);
    assert.equal(calls[2].params[6], JSON.stringify({ outcome: "succeeded" }));
    assert.match(calls[3].sql, /cms_rebuild_workflow_projection/);
});

test("catalog maps workflow projections and executions for API consumers", async () => {
    const { catalog } = createCatalogHarness();

    const projection = await catalog.getWorkflowProjection("workflow-1");
    const executions = await catalog.listWorkflowExecutions("workflow-1");

    assert.deepEqual(projection, {
        workflowSessionId: "workflow-1",
        graphId: "graph-1",
        status: "running",
        currentStateId: "inspect",
        currentExecutionSequence: 3,
        waitingOn: "agent-result",
        terminalOutcome: null,
        result: null,
        completedAt: null,
        updatedAt: new Date("2026-10-07T20:00:00.000Z"),
    });
    assert.deepEqual(executions, [{
        workflowSessionId: "workflow-1",
        executionSequence: 3,
        graphId: "graph-1",
        stateId: "inspect",
        childSessionId: "child-1",
        waitingOn: "agent-result",
        status: "accepted",
        outcome: "succeeded",
        output: { commit: "abc123" },
        admittedAt: new Date("2026-10-07T19:59:00.000Z"),
        acceptedAt: new Date("2026-10-07T20:00:00.000Z"),
        updatedAt: new Date("2026-10-07T20:00:00.000Z"),
    }]);
});
