/**
 * The test-only milestone worker module (workflow/v2/milestone-worker.ts;
 * INACTIVE): what a worker created with testOptions.workflowRequests serves.
 *
 * - Its activity tag is the workflow-request capability, and its activity
 *   options give orchestration 1.0.83's turns the request and agent-state
 *   tools.
 * - It registers 1.0.83 under the durable session name, at the intake
 *   version, with the two intake activities; the registry still has no 1.0.83
 *   and its latest version is another.
 * - A client starts sessions at the latest version unless told to start them
 *   at 1.0.83, and refuses any other version.
 * - A stored reasoning effort is used only when it names one.
 *
 * Run: node --test test/unit/workflow-v2-milestone-worker.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    WORKFLOW_MILESTONE_WORKER_TAGS, registerWorkflowMilestoneSessions, workflowMilestoneActivityOptions,
} from "../../dist/workflow/v2/milestone-worker.js";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../dist/activity-routing.js";
import {
    DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_NAME, DURABLE_SESSION_ORCHESTRATION_REGISTRY,
} from "../../dist/orchestration-registry.js";
import { DURABLE_SESSION_INTAKE_VERSION } from "../../dist/orchestration-version.js";
import { WORKFLOW_INTAKE_ACTIVITIES } from "../../dist/workflow/v2/intake.js";
import { PilotSwarmClient } from "../../dist/client.js";
import { isReasoningEffort } from "../../dist/model-providers.js";

test("the milestone worker declares the workflow-request tag and gives 1.0.83's turns the request and agent-state tools", () => {
    assert.deepEqual([...WORKFLOW_MILESTONE_WORKER_TAGS], [WORKFLOW_REQUEST_CAPABILITY]);
    assert.deepEqual(workflowMilestoneActivityOptions(), { workflowIntakeTurns: true, workflowRequests: true });
});

test("it registers 1.0.83 under the durable session name with the intake activities; the registry has no 1.0.83", () => {
    const orchestrations = [];
    const activities = [];
    registerWorkflowMilestoneSessions({
        registerOrchestrationVersioned: (name, version, handler) => orchestrations.push({ name, version, handler: typeof handler }),
        registerActivity: name => activities.push(name),
    }, { store: null });
    assert.equal(DURABLE_SESSION_INTAKE_VERSION, "1.0.83");
    assert.deepEqual(orchestrations, [{ name: DURABLE_SESSION_ORCHESTRATION_NAME, version: DURABLE_SESSION_INTAKE_VERSION, handler: "function" }]);
    assert.deepEqual(activities, [WORKFLOW_INTAKE_ACTIVITIES.claim, WORKFLOW_INTAKE_ACTIVITIES.settle]);
    assert.ok(!DURABLE_SESSION_ORCHESTRATION_REGISTRY.some(entry => entry.version === DURABLE_SESSION_INTAKE_VERSION));
    assert.notEqual(DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_INTAKE_VERSION);
});

test("a client starts sessions at the latest version unless told to start them at 1.0.83, and refuses any other version", () => {
    const client = new PilotSwarmClient({ store: "postgres://unused.invalid/pilotswarm" });
    for (const version of ["1.0.81", "1.0.84", ""]) {
        assert.throws(() => client._startSessionsAt(version), /New sessions start at/, version);
    }
    client._startSessionsAt(DURABLE_SESSION_INTAKE_VERSION);
    client._startSessionsAt(DURABLE_SESSION_LATEST_VERSION);
});

test("a stored reasoning effort is used only when it names one", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) assert.equal(isReasoningEffort(effort), true, effort);
    for (const value of ["", "HIGH", "extreme", null, undefined, 3]) assert.equal(isReasoningEffort(value), false, String(value));
});
