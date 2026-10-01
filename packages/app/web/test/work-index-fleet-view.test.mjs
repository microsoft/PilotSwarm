import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
    new URL("../../ui/react/src/web-app.js", import.meta.url),
    "utf8",
);

test("Work Index exposes fleet scope only to administrators", () => {
    assert.match(source, /role === "admin" \|\| role === "anonymous"/);
    assert.match(source, /isAdmin\s*\?\s*React\.createElement\("button", \{/);
    assert.match(source, /scope === "fleet" \? "Fleet view · read-only" : "My view"/);
});

test("fleet mode requests fleet collections and keeps their panes read-only", () => {
    assert.match(source, /listWorkflowRunsPage\(\{/);
    assert.match(source, /loadPersistedWorkflowGenerators\(transport, catalogScope, \{/);
    assert.match(source, /listSessionsPage\(\{/);
    assert.match(source, /CatalogQueryControls/);
    assert.match(source, /Load more Workflow Runs/);
    assert.match(source, /Load more Workflow Generators/);
    assert.match(source, /Load more Sessions/);
    assert.match(source, /const readOnly = catalogScope === "fleet"/);
    assert.match(source, /getWorkflowDefinition\(workflowRun\.workflowDefinitionId, \{ scope \}\)/);
    assert.match(source, /listWorkflowRunSessions\(workflowRun\.workflowRunId, \{ scope \}\)/);
    assert.match(source, /listWorkflowRunStateRuns\(workflowRun\.workflowRunId, \{ scope \}\)/);
    assert.match(source, /listWorkflowRunJournal\(workflowRun\.workflowRunId, \{ scope \}\)/);
    assert.match(source, /onOverrideCondition: readOnly \? null : onOverrideCondition/);
    assert.match(source, /!readOnly \? React\.createElement\("div", \{ className: "ps-workflow-generator-detail-actions" \}/);
});

test("fleet Session selection opens the transcript without enabling participation", () => {
    assert.match(source, /onSelectSession\) await onSelectSession\(sessionId\)/);
    assert.match(source, /onFleetSessionSelect: selectFleetSession/);
    assert.match(source, /await controller\.openUnlistedSession\(sessionId\)/);
    assert.match(source, /getSession\(sessionId, \{ scope: "fleet" \}\)/);
    assert.match(source, /forceReadOnly: workIndexScope === "fleet"/);
    assert.match(source, /Fleet view is read-only\. Switch to My view to participate in this session\./);
    assert.match(source, /await controller\.loadSession\(restoreSessionId\)\.catch/);
});

test("fleet Workflow transition selection explicitly opens its transcript", () => {
    assert.equal(
        source.match(/onSelectSession: onFleetSessionSelect/g)?.length,
        3,
        "All Fleet Session, Workflow Run, and Workflow Generator selections should use the same transcript path",
    );
    assert.equal(
        source.match(/await onSelectSession\(transition\.sessionId\)/g)?.length,
        2,
        "Both transition trees should open the selected transition Session",
    );
});
