import assert from "node:assert/strict";
import test from "node:test";
import {
    applyWorkflowRunCatalogView,
    buildVisibleWorkflowGeneratorTreeRows,
    workflowGeneratorTreeSelectionKey,
    navigateWorkflowGeneratorTree,
    toWorkflowRunCatalog,
    toWorkflowRunCatalogRow,
    workflowRunOrigin,
} from "../../ui/react/src/workflow-generator-tree-navigation.js";

const generators = [
    {
        id: "generator-1",
        workflowRuns: [
            {
                id: "workflowRun-1",
                transitions: [
                    { id: "transition-1" },
                    { id: "transition-2" },
                ],
            },
            {
                id: "workflowRun-2",
                transitions: [],
            },
        ],
    },
    {
        id: "generator-2",
        workflowRuns: [],
    },
];

test("visible rows follow expanded generator and WorkflowRun state", () => {
    assert.deepEqual(
        buildVisibleWorkflowGeneratorTreeRows(generators, new Set(), new Set())
            .map((row) => row.key),
        ["generator:generator-1", "generator:generator-2"],
    );

    assert.deepEqual(
        buildVisibleWorkflowGeneratorTreeRows(
            generators,
            new Set(["generator-1"]),
            new Set(["workflowRun-1"]),
        ).map((row) => row.key),
        [
            "generator:generator-1",
            "workflowRun:generator-1:workflowRun-1",
            "transition:generator-1:workflowRun-1:transition-1",
            "transition:generator-1:workflowRun-1:transition-2",
            "workflowRun:generator-1:workflowRun-2",
            "generator:generator-2",
        ],
    );
});

test("up and down move through visible rows", () => {
    const rows = buildVisibleWorkflowGeneratorTreeRows(
        generators,
        new Set(["generator-1"]),
        new Set(["workflowRun-1"]),
    );
    assert.equal(
        navigateWorkflowGeneratorTree(rows, "workflowRun:generator-1:workflowRun-1", "ArrowDown").row.key,
        "transition:generator-1:workflowRun-1:transition-1",
    );
    assert.equal(
        navigateWorkflowGeneratorTree(
            rows,
            "transition:generator-1:workflowRun-1:transition-1",
            "ArrowUp",
        ).row.key,
        "workflowRun:generator-1:workflowRun-1",
    );
});

test("right expands or enters children and left collapses or returns to parent", () => {
    const collapsedRows = buildVisibleWorkflowGeneratorTreeRows(
        generators,
        new Set(),
        new Set(),
    );
    assert.equal(
        navigateWorkflowGeneratorTree(
            collapsedRows,
            "generator:generator-1",
            "ArrowRight",
        ).type,
        "expand",
    );

    const expandedRows = buildVisibleWorkflowGeneratorTreeRows(
        generators,
        new Set(["generator-1"]),
        new Set(["workflowRun-1"]),
    );
    assert.equal(
        navigateWorkflowGeneratorTree(
            expandedRows,
            "generator:generator-1",
            "ArrowRight",
        ).row.key,
        "workflowRun:generator-1:workflowRun-1",
    );
    assert.equal(
        navigateWorkflowGeneratorTree(
            expandedRows,
            "workflowRun:generator-1:workflowRun-1",
            "ArrowLeft",
        ).type,
        "collapse",
    );
    assert.equal(
        navigateWorkflowGeneratorTree(
            expandedRows,
            "transition:generator-1:workflowRun-1:transition-1",
            "ArrowLeft",
        ).row.key,
        "workflowRun:generator-1:workflowRun-1",
    );
});

test("right expands containers with no children so their empty state is reachable", () => {
    const collapsedRows = buildVisibleWorkflowGeneratorTreeRows(
        generators,
        new Set(),
        new Set(),
    );
    // Generator with zero materialized workflowRuns still expands (reveals the
    // "No materialized workflowRuns" empty state) instead of being a dead leaf.
    assert.equal(
        navigateWorkflowGeneratorTree(
            collapsedRows,
            "generator:generator-2",
            "ArrowRight",
        ).type,
        "expand",
    );

    // Once expanded, an empty generator has no child to descend into.
    const expandedEmptyGenerator = buildVisibleWorkflowGeneratorTreeRows(
        generators,
        new Set(["generator-2"]),
        new Set(),
    );
    assert.equal(
        navigateWorkflowGeneratorTree(
            expandedEmptyGenerator,
            "generator:generator-2",
            "ArrowRight",
        ),
        null,
    );
    assert.equal(
        navigateWorkflowGeneratorTree(
            expandedEmptyGenerator,
            "generator:generator-2",
            "ArrowLeft",
        ).type,
        "collapse",
    );

    // A workflowRun with zero lifecycle state runs is likewise expandable.
    const expandedGenerator = buildVisibleWorkflowGeneratorTreeRows(
        generators,
        new Set(["generator-1"]),
        new Set(),
    );
    assert.equal(
        navigateWorkflowGeneratorTree(
            expandedGenerator,
            "workflowRun:generator-1:workflowRun-2",
            "ArrowRight",
        ).type,
        "expand",
    );
});

test("selection keys match each tree level", () => {
    assert.equal(
        workflowGeneratorTreeSelectionKey({ kind: "generator", workflowGeneratorId: "g1" }),
        "generator:g1",
    );
    assert.equal(
        workflowGeneratorTreeSelectionKey({ kind: "workflowRun", workflowGeneratorId: "g1", workflowRunId: "j1" }),
        "workflowRun:g1:j1",
    );
    assert.equal(
        workflowGeneratorTreeSelectionKey({
            kind: "transition",
            workflowGeneratorId: "g1",
            workflowRunId: "j1",
            transitionId: "t1",
        }),
        "transition:g1:j1:t1",
    );
});

test("maps a direct Workflow Run into a lightweight catalog row", () => {
    const row = toWorkflowRunCatalogRow({
        workflowRunId: "run-1",
        workflowRunKey: "issue:123",
        workflowDefinitionId: "definition-1",
        workflowType: "FixIssue",
        lifecycleState: "active",
        currentState: "Investigate",
        stateRevision: 2,
        owner: { provider: "system", subject: "system", displayName: "System" },
        requestedBy: { provider: "dev", displayName: "Ada Lovelace", subject: "ada" },
        origin: "direct",
        effectiveConfig: {
            affinities: {
                repo: "microsoft/PilotSwarm",
                compute: "cluster",
            },
        },
        createdAt: "2026-09-24T10:00:00Z",
        updatedAt: "2026-09-24T11:00:00Z",
    });

    assert.equal(row.id, "run-1");
    assert.equal(row.key, "issue:123");
    assert.equal(row.origin, "Direct");
    assert.equal(row.ownerLabel, "Ada Lovelace");
    assert.equal(row.repository, "microsoft/PilotSwarm");
    assert.equal(row.compute, "cluster");
});

test("filters Workflow Run catalog rows independently by every table column", () => {
    const rows = [
        toWorkflowRunCatalogRow({
            workflowRunId: "run-1",
            workflowRunKey: "issue:123",
            workflowType: "FixIssue",
            lifecycleState: "active",
            currentState: "Investigate",
            owner: { displayName: "Ada Lovelace" },
            origin: "direct",
            updatedAt: "2026-09-24T11:00:00Z",
        }),
        toWorkflowRunCatalogRow({
            workflowRunId: "run-2",
            workflowRunKey: "pr:456",
            workflowType: "ReviewPullRequest",
            lifecycleState: "completed",
            currentState: "Complete",
            owner: { displayName: "Grace Hopper" },
            origin: "workflow_generator",
            workflowGeneratorId: "generator-1",
            updatedAt: "2026-09-23T10:00:00Z",
        }),
    ];

    const filters = [
        ["status", "running", "run-1"],
        ["workflow", "review", "run-2"],
        ["key", "123", "run-1"],
        ["currentState", "complete", "run-2"],
        ["origin", "generator", "run-2"],
        ["owner", "ada", "run-1"],
        ["updated", "24t11", "run-1"],
    ];
    for (const [column, value, expectedId] of filters) {
        const filtered = applyWorkflowRunCatalogView(rows, {
            filters: { [column]: value },
        });
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].id, expectedId);
    }
});

test("sorts Workflow Run catalog rows by text and updated time without mutating input", () => {
    const rows = [
        toWorkflowRunCatalogRow({
            workflowRunId: "run-2",
            workflowRunKey: "issue:20",
            workflowType: "Triage",
            lifecycleState: "completed",
            updatedAt: "2026-09-24T12:00:00Z",
        }),
        toWorkflowRunCatalogRow({
            workflowRunId: "run-1",
            workflowRunKey: "issue:3",
            workflowType: "Build",
            lifecycleState: "active",
            updatedAt: "2026-09-23T12:00:00Z",
        }),
    ];

    assert.deepEqual(
        applyWorkflowRunCatalogView(rows, {
            sortColumn: "key",
            sortDirection: "asc",
        }).map((row) => row.id),
        ["run-1", "run-2"],
    );
    assert.deepEqual(
        applyWorkflowRunCatalogView(rows, {
            sortColumn: "updated",
            sortDirection: "desc",
        }).map((row) => row.id),
        ["run-2", "run-1"],
    );
    assert.deepEqual(rows.map((row) => row.id), ["run-2", "run-1"]);
});

test("recognizes generator provenance when the backend exposes a generator id", () => {
    assert.equal(
        workflowRunOrigin({ workflowGeneratorId: "generator-1" }),
        "Workflow Generator",
    );
});

test("keeps current API rows usable before provenance is added", () => {
    const rows = toWorkflowRunCatalog([
        {
            workflowRunId: "run-1",
            workflowRunKey: "issue:123",
            workflowType: "FixIssue",
            lifecycleState: "pending_session",
            currentState: "Investigate",
        },
        { workflowRunKey: "missing-id" },
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, "Origin unavailable");
    assert.equal(rows[0].ownerLabel, "Unknown owner");
});
