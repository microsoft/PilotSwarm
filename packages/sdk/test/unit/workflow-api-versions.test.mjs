/**
 * The apiVersion routing table: spawn_workflow and createWorkflowSession
 * read a document's apiVersion first, run the engine registered for it,
 * and refuse any other version up front with one clear message.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    WORKFLOW_API_VERSION_UNSUPPORTED,
    WORKFLOW_ENGINES,
    readWorkflowApiVersion,
    routeWorkflowApiVersion,
} from "../../dist/workflow/api-versions.js";
import { spawnWorkflowFromTool } from "../../dist/workflow/spawn.js";
import { PilotSwarmClient } from "../../dist/client.js";

const BODY = `kind: Workflow
metadata: { name: routed, version: 1.0.0 }
initial: only
states:
  only:
    type: script
    runtime: node
    source: x
    completion: { outcomes: [success] }
    transition: { next: { success: done } }
  done: { type: terminal, outcome: succeeded }
`;
const doc = (apiVersionLine) => `${apiVersionLine ? `${apiVersionLine}\n` : ""}${BODY}`;
const SUPPORTED = "Supported: pilotswarm.dev/v1alpha1.";

test("one engine is registered today: pilotswarm.dev/v1alpha1", () => {
    assert.deepEqual([...WORKFLOW_ENGINES.keys()], ["pilotswarm.dev/v1alpha1"]);
});

test("apiVersion is read without compiling, in the forms YAML allows", () => {
    assert.deepEqual(readWorkflowApiVersion(doc("apiVersion: pilotswarm.dev/v1alpha1")), { apiVersion: "pilotswarm.dev/v1alpha1" });
    assert.deepEqual(readWorkflowApiVersion(doc('apiVersion: "pilotswarm.dev/v2-draft"  # next')), { apiVersion: "pilotswarm.dev/v2-draft" });
    assert.deepEqual(readWorkflowApiVersion(doc("apiVersion: 'x/y'")), { apiVersion: "x/y" });
    assert.deepEqual(readWorkflowApiVersion("{ apiVersion: pilotswarm.dev/v1alpha1, kind: Workflow }"), { apiVersion: "pilotswarm.dev/v1alpha1" });
    assert.deepEqual(readWorkflowApiVersion(doc(null)), { apiVersion: null });
    assert.deepEqual(readWorkflowApiVersion("kind: [unclosed"), { apiVersion: null, malformed: true });
});

test("v1alpha1 routes to the current engine; v2-draft, an unknown value and a missing apiVersion are refused", () => {
    const routed = routeWorkflowApiVersion(doc("apiVersion: pilotswarm.dev/v1alpha1"));
    assert.equal(routed.ok, true);
    assert.equal(routed.engine.compile(doc("apiVersion: pilotswarm.dev/v1alpha1")).name, "routed");
    for (const [line, shown] of [
        ["apiVersion: pilotswarm.dev/v2-draft", "pilotswarm.dev/v2-draft"],
        ["apiVersion: example.com/v9", "example.com/v9"],
        [null, "(missing)"],
    ]) {
        assert.deepEqual(routeWorkflowApiVersion(doc(line)), {
            ok: false,
            code: WORKFLOW_API_VERSION_UNSUPPORTED,
            message: `This worker does not support workflow apiVersion ${shown}. ${SUPPORTED}`,
        });
    }
});

function spawnDeps() {
    const created = [];
    return {
        created,
        deps: {
            parentSessionId: "parent",
            stateTypes: () => new Set(["script"]),
            getSession: async () => null,
            resolveOwner: async () => null,
            captureToolBinding: async () => ({ policy: "parent-tools-v1", tools: [{ name: "bash", schemaHash: "h" }] }),
            createWorkflowSession: async (config) => { created.push(config); return { sessionId: config.sessionId, workflowName: "routed" }; },
        },
    };
}

test("spawn_workflow refuses an unsupported apiVersion plainly, before anything else", async () => {
    const { created, deps } = spawnDeps();
    assert.equal(
        await spawnWorkflowFromTool({ yaml: doc("apiVersion: pilotswarm.dev/v2-draft") }, { toolCallId: "a" }, deps),
        `[SYSTEM: spawn_workflow refused — This worker does not support workflow apiVersion pilotswarm.dev/v2-draft. ${SUPPORTED} Nothing was started.]`,
    );
    assert.match(await spawnWorkflowFromTool({ yaml: doc(null) }, { toolCallId: "b" }, deps), /apiVersion \(missing\)/);
    assert.equal(created.length, 0);
    assert.match(await spawnWorkflowFromTool({ yaml: doc("apiVersion: pilotswarm.dev/v1alpha1") }, { toolCallId: "c" }, deps), /^\[SYSTEM: started workflow session/);
    assert.equal(created.length, 1);
});

test("malformed YAML still gets the compiler's own error", async () => {
    const { deps } = spawnDeps();
    const broken = "apiVersion: pilotswarm.dev/v1alpha1\nkind: Workflow\nstates: [unclosed\n";
    assert.match(await spawnWorkflowFromTool({ yaml: broken }, { toolCallId: "d" }, deps), /refused — the workflow is not valid: /);
    assert.match(await spawnWorkflowFromTool({ yaml: "kind: [unclosed" }, { toolCallId: "e" }, deps), /refused — the workflow is not valid: /);
});

test("createWorkflowSession refuses an unsupported apiVersion with its code, before touching the store", async () => {
    const client = new PilotSwarmClient({ store: "postgres://unused" });
    const calls = [];
    client._catalog = new Proxy({}, { get: (_t, name) => async () => { calls.push(name); return null; } });
    client.duroxideClient = {};
    await assert.rejects(client.createWorkflowSession({ yaml: doc("apiVersion: pilotswarm.dev/v2-draft"), parentSessionId: "parent" }), (error) => {
        assert.equal(error.code, WORKFLOW_API_VERSION_UNSUPPORTED);
        assert.equal(error.status, 400);
        assert.equal(error.message, `This worker does not support workflow apiVersion pilotswarm.dev/v2-draft. ${SUPPORTED}`);
        return true;
    });
    assert.deepEqual(calls, []);
});
