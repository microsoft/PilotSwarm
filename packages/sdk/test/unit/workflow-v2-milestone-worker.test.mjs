/**
 * The full-engine worker module (workflow/v2/milestone-worker.ts): what every worker serves since 1.0.83 is the latest
 * version (owner decision 2026-11-08T15:30Z).
 *
 * - Its activity tag is the workflow-request capability; every worker adds it to its tag filter (worker.ts).
 * - It registers 1.0.83's two intake activities, and no orchestration: the registry registers 1.0.83 as the latest.
 * - A client starts sessions at the latest version unless a test tells it to start them at another registered version
 *   (an upgrade test), and refuses a version that is not registered.
 * - A stored reasoning effort is used only when it names one.
 *
 * Run: node --test test/unit/workflow-v2-milestone-worker.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WORKFLOW_MILESTONE_WORKER_TAGS, registerWorkflowMilestoneSessions } from "../../dist/workflow/v2/milestone-worker.js";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../dist/activity-routing.js";
import { DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";
import { WORKFLOW_INTAKE_ACTIVITIES } from "../../dist/workflow/v2/intake.js";
import { WORKFLOW_AGENT_TURN_FAILURE_ACTIVITY } from "../../dist/workflow/v2/agent-turn-failure.js";
import { PilotSwarmClient } from "../../dist/client.js";
import { isReasoningEffort } from "../../dist/model-providers.js";

const WORKER = readFileSync(new URL("../../src/worker.ts", import.meta.url), "utf8");

test("every worker declares the workflow-request tag and serves the full engine, with no test option", () => {
    assert.deepEqual([...WORKFLOW_MILESTONE_WORKER_TAGS], [WORKFLOW_REQUEST_CAPABILITY]);
    assert.match(WORKER, /const milestone = await import\("\.\/workflow\/v2\/milestone-worker\.js"\);/);
    assert.match(WORKER, /\.\.\.milestone\.WORKFLOW_MILESTONE_WORKER_TAGS\]/);
    assert.match(WORKER, /\n\s+agentNodes: milestone\.workflowMilestoneAgentNodes\(/);
    assert.doesNotMatch(WORKER, /workflowRequests/);
});

test("it registers 1.0.83's intake activities, its failed-turn report and no orchestration; the registry's latest version is 1.0.83", () => {
    const orchestrations = [];
    const activities = [];
    registerWorkflowMilestoneSessions({
        registerOrchestrationVersioned: (name, version) => orchestrations.push({ name, version }),
        registerActivity: name => activities.push(name),
    }, { store: null });
    assert.deepEqual(orchestrations, []);
    assert.deepEqual(activities, [WORKFLOW_INTAKE_ACTIVITIES.claim, WORKFLOW_INTAKE_ACTIVITIES.settle, WORKFLOW_AGENT_TURN_FAILURE_ACTIVITY]);
    assert.equal(DURABLE_SESSION_LATEST_VERSION, "1.0.83");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).version, DURABLE_SESSION_LATEST_VERSION);
});

test("a client starts sessions at the latest version unless a test names another registered one, and refuses any other", () => {
    const client = new PilotSwarmClient({ store: "postgres://unused.invalid/pilotswarm" });
    for (const version of ["1.0.84", "1.0.46", ""]) {
        assert.throws(() => client._startSessionsAt(version), /New sessions start at a registered version/, version);
    }
    client._startSessionsAt("1.0.82");
    client._startSessionsAt(DURABLE_SESSION_LATEST_VERSION);
});

test("a stored reasoning effort is used only when it names one", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) assert.equal(isReasoningEffort(effort), true, effort);
    for (const value of ["", "HIGH", "extreme", null, undefined, 3]) assert.equal(isReasoningEffort(value), false, String(value));
});
