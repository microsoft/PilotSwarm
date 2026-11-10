/**
 * spawn_workflow's compatibility path (Workflow Simplified stage 2.1, D2) names its save and start by the key (or the
 * tool call) and the YAML (aa5bb84a run; coordinator ruling): an exact repeat is the same operation (answered from its
 * receipt), and a corrected YAML under the same key is another operation, so it saves the next revision and starts it, as
 * stage 1 allowed, instead of conflicting with the first (OPERATION_CONFLICT). The database side is
 * test/local/workflow-spawn-refusal.test.js.
 *
 * Run: node --test test/unit/workflow-spawn-compat-operation.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnWorkflowFromTool } from "../../dist/workflow/spawn.js";
import { sha256Hex } from "../../dist/workflow/json.js";

const YAML = next => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: one-second, version: "1.0.0" }
initial: pause
states:
  pause: { type: wait, seconds: 1${next} }
  done: { type: terminal, outcome: succeeded }
`;
const INVALID = YAML("");
const VALID = YAML(", transition: { next: { elapsed: done } }");

/** The operation id each call's save reaches the store with (the save is then refused, so nothing else runs). */
async function saveOperation(args, toolCallId = "call-1") {
    const seen = [];
    const host = {
        catalog: {}, duroxideClient: {},
        // PRS-002: this session is in no Workflow (the definitions guard reads the lineage first).
        store: { readWorkflowLineage: async () => null, sessionDefinitions: {
            // Code check G2: the compat path reads its save receipt by operation id first; none here.
            readStoredOperation: async () => null,
            readDefinitionByName: async () => null,
            save: async input => { seen.push(input.operationId); throw Object.assign(new Error("stop here"), { code: "TEST_STOP" }); },
        } },
    };
    const answer = await spawnWorkflowFromTool(args, { toolCallId }, {
        parentSessionId: "owner-1", enabled: () => true, resolveOwner: async () => null,
        captureToolBinding: async () => ({}), workflowHost: async () => host,
    });
    assert.equal(seen.length, 1, answer);
    return seen[0];
}

test("the compat operation is the key and the YAML: a repeat is the same operation, a corrected YAML another", async () => {
    const first = await saveOperation({ yaml: INVALID, key: "one-second", state: "published", start: true });
    const repeat = await saveOperation({ yaml: INVALID, key: "one-second", state: "published", start: true }, "call-2");
    const corrected = await saveOperation({ yaml: VALID, key: "one-second", state: "published", start: true }, "call-3");
    assert.equal(first, `spawn:key:one-second:${sha256Hex(INVALID).slice(0, 32)}:save`);
    assert.equal(repeat, first, "the same key and YAML is the same operation, whatever the call");
    assert.equal(corrected, `spawn:key:one-second:${sha256Hex(VALID).slice(0, 32)}:save`);
    assert.notEqual(corrected, first);
    // Without a key: the call and the YAML.
    assert.equal(await saveOperation({ yaml: VALID }, "call-9"), `spawn:call:call-9:${sha256Hex(VALID).slice(0, 32)}:save`);
});
