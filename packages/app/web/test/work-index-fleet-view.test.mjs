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

test("fleet mode requests the Session collection and keeps participation read-only", () => {
    assert.match(source, /listSessionsPage\(\{/);
    assert.match(source, /CatalogQueryControls/);
    assert.match(source, /Load more Sessions/);
    assert.doesNotMatch(source, /\{ id: "workflowRuns", label: "Workflow Runs" \}/);
    assert.doesNotMatch(source, /\{ id: "workflowGenerators", label: "Workflow Generators" \}/);
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

test("workflow-specific Work Index navigation is absent", () => {
    assert.equal(
        source.match(/onSelectSession: onFleetSessionSelect/g)?.length,
        1,
        "Only Fleet Session selection should use the transcript path",
    );
    assert.doesNotMatch(source, /await onSelectSession\(transition\.sessionId\)/);
});
