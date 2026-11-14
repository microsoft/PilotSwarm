import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { WORKFLOW_CONTROLLER_REGISTRY } from "../../dist/workflow/controller-registry.js";
import { WORKFLOW_CONTROLLER_VERSION, WORKFLOW_CONTROLLER_VERSIONS } from "../../dist/workflow/controller-version.js";

const copies = {
    "workflow/commands.ts": ["WORKFLOW_COMMAND_QUEUE", "ACTIVITY_ERROR_PREFIX", "workflowErrorMessage", "parseWorkflowCommand"],
    "workflow/compiler.ts": ["FAILURE_ROUTE", "PARALLEL_JOINED", "WORKFLOW_PARALLEL_MAX_ITEMS"],
    "workflow/parallel.ts": ["branchScopeId", "parseBranchScope", "BRANCH_CANCEL_WINNERS", "BranchCancelReason"],
    "activity-routing.ts": ["WORKFLOW_REQUEST_CAPABILITY"],
    "workflow/store.ts": ["WorkflowRunStatus", "ACTIVE_RUN_STATUSES"],
};

function declarations(path) {
    const text = readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const result = new Map();
    for (const statement of source.statements) {
        const names = ts.isVariableStatement(statement)
            ? statement.declarationList.declarations.map(declaration => declaration.name.getText(source))
            : statement.name ? [statement.name.getText(source)] : [];
        for (const name of names) result.set(name, statement.getText(source).replace(/^export\s+/, ""));
    }
    return result;
}

test("each controller version has one distinct, correctly named handler and live is newest", () => {
    assert.deepEqual(WORKFLOW_CONTROLLER_REGISTRY.map(entry => entry.version), WORKFLOW_CONTROLLER_VERSIONS);
    assert.equal(new Set(WORKFLOW_CONTROLLER_REGISTRY.map(entry => entry.handler)).size, WORKFLOW_CONTROLLER_REGISTRY.length);
    for (const { version, handler } of WORKFLOW_CONTROLLER_REGISTRY) {
        assert.equal(handler.name, `workflowController_${version.replaceAll(".", "_")}`);
    }
    assert.equal(WORKFLOW_CONTROLLER_REGISTRY.at(-1).version, WORKFLOW_CONTROLLER_VERSION);
});

test("live controller protocol helpers cannot drift from the shared activity contracts", () => {
    const live = declarations("workflow/controller/runtime.ts");
    for (const [path, names] of Object.entries(copies)) {
        const canonical = declarations(path);
        for (const name of names) {
            assert.ok(live.has(name), `${name} missing from live controller`);
            assert.ok(canonical.has(name), `${name} missing from ${path}`);
            assert.equal(live.get(name), canonical.get(name), `${name} differs from ${path}; update the live controller, never a frozen tree`);
        }
    }
});
