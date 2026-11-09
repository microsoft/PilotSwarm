/**
 * Stage 2 review fixes, without a database (fake stores record what they are asked):
 * - S2RT-F7: a repeat of the definition tool's first save (same tool call id) is answered from its receipt, before the name
 *   it saved is found and asked for a guard (REVISION_REQUIRED);
 * - S2RT-F9: a test read again by its id is refused where tests cannot run, before the test is looked up, its clock
 *   advanced or it is ended;
 * - S2RT-F10: a repeat of Make a copy is answered from its receipt before the source's newest revision is chosen again;
 *   another source or revision under the same operation is refused.
 *
 * Run: node --test test/unit/workflow-review-replays.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { workflowDefinitionFromTool } from "../../dist/workflow/v2/definition-tool.js";
import { copyChatPackageWorkflow } from "../../dist/workflow/v2/chat-definitions.js";

const YAML = `apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: waiter, version: "1.0.0" }\ninitial: hold\n`
    + `states:\n  hold: { type: wait, seconds: 30, transition: { next: { elapsed: done } } }\n  done: { type: terminal, outcome: succeeded }\n`;
const untouchable = (what) => new Proxy({}, { get: (_target, name) => { throw new Error(`${what}.${String(name)} was used`); } });

test("S2RT-F7: the same first save again is answered from its receipt, not refused for the name it saved", async () => {
    const receipt = { operation: "save", definitionId: "def-1", name: "waiter", revision: 1, basedOn: null, created: true, valid: true, semver: "1.0.0",
        diagnostics: [], yamlSha256: "y" };
    const calls = [];
    const chat = {
        readStoredOperation: async (owner, operationId) => (operationId === "definition:call-1" ? { kind: "save", receipt } : null),
        readDefinitionByName: async () => { calls.push("name"); return { definitionId: "def-1", currentRevision: 1 }; },
        save: async (input) => { calls.push(["save", input.operationId, input.expected]); return { receipt, replayed: true }; },
    };
    const host = { catalog: untouchable("catalog"), store: { chat, readWorkflowLineage: async () => null }, scripts: true };
    const call = (toolCallId) => workflowDefinitionFromTool({ operation: "save", name: "waiter", yaml: YAML },
        { callerSessionId: "chat", host, toolCallId, owner: null, binding: async () => null }).then((text) => JSON.parse(text));
    const again = await call("call-1");
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual({ definitionId: again.definitionId, revision: again.revision, replayed: again.replayed }, { definitionId: "def-1", revision: 1, replayed: true });
    assert.deepEqual(calls, [["save", "definition:call-1", null]]);
    // Another call for the same name still needs the guard.
    const other = await call("call-2");
    assert.equal(other.error?.code, "REVISION_REQUIRED");
});

test("S2RT-F9: reading a test again by its id is refused where tests cannot run, before anything of the test is read", async () => {
    for (const requests of [false, undefined]) {
        const host = { catalog: untouchable("catalog"), store: untouchable("store"), requests };
        const answer = JSON.parse(await workflowDefinitionFromTool({ operation: "test", test_id: "bench-1" },
            { callerSessionId: "chat", host, toolCallId: "call-9", owner: null, binding: async () => null }));
        assert.equal(answer.error?.code, "WORKFLOW_TEST_UNAVAILABLE", JSON.stringify(answer));
    }
});

test("S2RT-F10: a repeated Make a copy answers its receipt (the copy names its source); another source or revision is refused", async () => {
    const receipt = { operation: "save", definitionId: "def-copy", name: "release-watch", revision: 1, created: true, valid: true };
    const copy = { definitionId: "def-copy", ownerSessionId: "chat", name: "release-watch", locked: false, deletedAt: null,
        copiedFrom: { definitionId: "def-pkg", name: "release-tools/release-watch", revision: 1, package: null } };
    const host = { store: { readWorkflowLineage: async () => null, chat: {
        readStoredOperation: async (owner, operationId) => (operationId === "copy-1" ? { kind: "save", receipt } : null),
        readDefinition: async (id) => (id === "def-copy" ? copy : { definitionId: "def-pkg", ownerSessionId: "chat", name: "release-tools/release-watch",
            locked: true, currentRevision: 2, deletedAt: null }),
        readRevision: async () => { throw new Error("the source's revision was read again"); },
    } } };
    const request = { ownerSessionId: "chat", definitionId: "def-pkg", actor: { kind: "user", provider: "dev", subject: "ada" }, operationId: "copy-1" };
    assert.deepEqual(await copyChatPackageWorkflow(host, request), { receipt, replayed: true });
    assert.deepEqual(await copyChatPackageWorkflow(host, { ...request, revision: 1 }), { receipt, replayed: true });
    for (const other of [{ revision: 2 }, { definitionId: "def-other" }]) {
        await assert.rejects(copyChatPackageWorkflow(host, { ...request, ...other }), (error) => error.code === "OPERATION_CONFLICT", JSON.stringify(other));
    }
});
