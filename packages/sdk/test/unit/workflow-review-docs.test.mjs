/**
 * Review PRA-F4 and PRA-F5 (adversarial review of a00f9c32): the docs say what the code does.
 * - The API reference's rows for createSession, createSessionForAgent, startSessionWorkflowDefinition and updateWorkflow name
 *   every parameter protocol.js declares for them (the reference says its tables are generated from that file).
 * - The configuration reference lists the Workflow test-mode and shutdown variables the PR points readers to.
 * - Two stale statements are gone: a 1.0.82 turn does declare `test`, and workflow publication is on in every deployment.
 *
 * Run: node --test test/unit/workflow-review-docs.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OPERATIONS } from "../../api/src/protocol.js";

const doc = (path) => fs.readFileSync(new URL(`../../../../docs/${path}`, import.meta.url), "utf8");

test("PRA-F5: the reference rows of the four operations the review named list every parameter protocol.js declares", () => {
    const reference = doc("api/reference.md");
    for (const name of ["createSession", "createSessionForAgent", "startSessionWorkflowDefinition", "updateWorkflow"]) {
        const operation = OPERATIONS.find(op => op.name === name);
        assert.ok(operation, name);
        const row = reference.split("\n").find(line => line.startsWith(`| ${name} | `));
        assert.ok(row, `${name} has a row`);
        const parameters = row.split(" | ")[2];
        const missing = Object.keys(operation.params ?? {}).filter(key => !new RegExp(`\\b${key}\\b`).test(parameters));
        assert.deepEqual(missing, [], `${name}: ${parameters}`);
    }
});

test("PRA-F4: the configuration reference lists the test-mode and shutdown variables", () => {
    const configuration = doc("developer/reference/configuration.md");
    for (const variable of ["PILOTSWARM_WORKFLOW_TEST_MODE", "PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS", "PILOTSWARM_PORTAL_SHUTDOWN_TIMEOUT_MS"]) {
        assert.match(configuration, new RegExp(`^\\| \`${variable}\` \\|`, "m"), variable);
    }
});

test("PRA-F4: no doc says a 1.0.82 turn lacks the test operation, or that workflow publication is not enabled yet", () => {
    const sessions = doc("developer/building/workflow-sessions.md").replace(/\s+/g, " ");
    assert.doesNotMatch(sessions, /still on 1\.0\.82 declares `workflow_definition` without it/);
    assert.match(sessions, /Every turn declares `test`/);
    assert.doesNotMatch(doc("building-agent-packages.md"), /not enabled in deployments yet/);
});

test("Phase 3 I7 (S8, S9, N12): the docs say how to re-run from a step, its v1 limits, and the 0104 deploy and rollback rule", () => {
    const flat = (text) => text.replace(/\s+/g, " ");
    const guide = flat(doc("user-guide/workflows.md"));
    assert.match(guide, /## Go on from a step that failed/);
    assert.match(guide, /### Current limits of a re-run/);
    for (const want of ["To keep a message a step already received, re-run from the step after it.", "Re-run the whole parallel step",
        "That step and every step after it run again", "Supply only values you checked", "5 minutes to 6 hours", "256 MiB",
        "rerun_from", "rerun_plan", "workflow-rerun"]) {
        assert.ok(guide.includes(want), `workflows.md: ${want}`);
    }
    const sessions = flat(doc("developer/building/workflow-sessions.md"));
    for (const want of ["## Re-running from a step", "rerun_from", "rerun_plan", "rerunFrom", "rerunPlan", "`viaMcp`", "workflows.rerun",
        "`visit.reused`", "`visit.supplied`", "`run.rerunOf`", "workflow-rerun", "To keep a message a step already received, re-run from the step after it."]) {
        assert.ok(sessions.includes(want), `workflow-sessions.md: ${want}`);
    }
    const mcp = flat(fs.readFileSync(new URL("../../../app/mcp/README.md", import.meta.url), "utf8"));
    for (const want of ["rerun_from", "rerun_plan", "403 RERUN_APPROVAL_REUSED", "workflows.rerun: true", "workflow-rerun"]) {
        assert.ok(mcp.includes(want), `mcp/README.md: ${want}`);
    }
    const drain = "rerun_of_run_id IS NOT NULL AND status IN ('admitted', 'running', 'paused')";
    const changelog = flat(fs.readFileSync(new URL("../../../../CHANGELOG.md", import.meta.url), "utf8"));
    for (const [name, text] of [["aks.md", flat(doc("developer/deploy/aks.md"))], ["CHANGELOG.md", changelog]]) {
        assert.match(text, /`0104`/, `${name}: migration 0104`);
        assert.match(text, /[Ss]cale every worker, the portal and any Web-mode MCP deployment to `0`/, `${name}: scale to 0 before 0104`);
        assert.ok(text.includes(drain), `${name}: drain active re-runs before a rollback`);
    }
});
