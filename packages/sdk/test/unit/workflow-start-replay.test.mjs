/**
 * Stage 2 review S2RT-F5: a chat definition's Start is receipt-first. When its operation already made its Workflow (the
 * pin stored with it) or claimed it and was interrupted (the pin its claim records), it goes on with that definition and
 * revision, never with a default chosen again after a save; a request that names another one is refused
 * (OPERATION_CONFLICT). Without a database: the store and catalog record what they are asked.
 *
 * Run: node --test test/unit/workflow-start-replay.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startChatWorkflowDefinition, storedStartPin, WORKFLOW_START_MAX_RUNNING_CHILDREN } from "../../dist/workflow/v2/chat-definitions.js";

const ACTOR = { kind: "agent", sessionId: "chat" };
const YAML = (seconds) => `apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: waiter, version: "1.0.0" }\ninitial: hold\n`
    + `states:\n  hold: { type: wait, seconds: ${seconds}, transition: { next: { elapsed: done } } }\n  done: { type: terminal, outcome: succeeded }\n`;

/**
 * A chat with definition def-1 at revisions 1 (stored with the Workflow) and 2 (saved since); `pinnedBy` where the pin is.
 * `yaml`: revision 1's YAML; `running`: the budget count, which excludes the Workflow named second (its own claim).
 */
function hostWith(pinnedBy, { yaml = null, running = 0, requests = false } = {}) {
    const reads = [];
    const chat = {
        readDefinition: async (id) => (id === "def-1" ? { definitionId: "def-1", ownerSessionId: "chat", name: "waiter", currentRevision: 2, deletedAt: null } : null),
        readRevision: async (id, revision) => { reads.push(["revision", revision]); return { definitionId: id, revision, valid: true,
            yaml: revision === 1 && yaml ? yaml : YAML(revision * 10) }; },
        newestValidRevision: async () => { reads.push(["newest"]); return 2; },
        listWorkflows: async () => [{ workflowSessionId: "w-earlier", revision: 1 }, { workflowSessionId: "w-later", revision: 2 }],
        runningChildren: async (_owner, exclude) => { reads.push(exclude === undefined ? ["budget"] : ["budget", "own claim excluded"]); return running; },
        nestingLevel: async () => 0,
    };
    // PRS-002: these chats are in no Workflow (the definitions guard reads the lineage first).
    const store = new Proxy({ chat, readWorkflowLineage: async () => null, readDefinition: async () => (pinnedBy === "row"
        ? { workflowSessionId: "w", parentSessionId: "chat", state: "published", chatDefinitionId: "def-1", chatRevision: 1 } : null) },
    { get: (target, name) => { if (name in target) return target[name]; throw new Error(`store.${String(name)} was used`); } });
    const catalog = new Proxy({ getSessionCreationConfig: async () => (pinnedBy === "claim"
        ? { workflowV2: { fingerprint: 3, requestSha256: "x", operationId: "start:op", chatPin: { definitionId: "def-1", revision: 1 } } } : null) },
    { get: (target, name) => { if (name in target) return target[name]; throw new Error(`catalog.${String(name)} was used`); } });
    return { host: { catalog, store, duroxideClient: {}, scripts: true, ...(requests ? { requests: true } : {}) }, reads };
}

const refusal = (promise) => promise.then(() => null, (error) => error);
const start = (host, extra = {}) => refusal(startChatWorkflowDefinition(host, { ownerSessionId: "chat", definition: { definitionId: "def-1" }, inputs: {},
    actor: ACTOR, operationId: "op", binding: null, ...extra }));

test("the pin of an operation that ran: from its Workflow's stored definition, else from its claim, else none", async () => {
    assert.deepEqual(await storedStartPin(hostWith("row").host, "w"), { definitionId: "def-1", revision: 1 });
    assert.deepEqual(await storedStartPin(hostWith("claim").host, "w"), { definitionId: "def-1", revision: 1 });
    assert.equal(await storedStartPin(hostWith(null).host, "w"), null);
});

test("S2RT-F5: a repeated Start goes on with its pinned revision 1, not the newest (2); one whose Workflow was stored never counts the budget again", async () => {
    for (const pinnedBy of ["row", "claim"]) {
        const { host, reads } = hostWith(pinnedBy);
        const error = await start(host);
        // It went on to create the Workflow from revision 1 (here the catalog refuses anything else).
        assert.match(String(error?.message), /was used$/, `${pinnedBy}: ${error?.message}`);
        // PRA-F2: a claim without its Workflow is checked again, its own claim not counted.
        assert.deepEqual(reads, pinnedBy === "row" ? [["revision", 1]] : [["revision", 1], ["budget", "own claim excluded"]], pinnedBy);
        // The same revision named explicitly, and a Run again of a revision-1 Workflow, are the same request.
        for (const extra of [{ revision: 1 }, { runAgainOf: "w-earlier" }, { definition: { name: "waiter" } }]) {
            assert.match(String((await start(host, extra))?.message), /was used$/, JSON.stringify(extra));
        }
    }
});

test("S2RT-F5: a repeated Start that names another revision, definition or Workflow to run again is refused", async () => {
    const { host } = hostWith("row");
    for (const extra of [{ revision: 2 }, { definition: { definitionId: "def-2" } }, { definition: { name: "other" } }, { runAgainOf: "w-later" }]) {
        const error = await start(host, extra);
        assert.equal(error?.code, "OPERATION_CONFLICT", JSON.stringify(extra));
        assert.match(error.message, /^Operation op started waiter revision 1, not .*; use another operation id\.$/);
    }
});

test("a Start that has not run resolves the newest valid revision and counts the budget", async () => {
    const { host, reads } = hostWith(null);
    await start(host);
    assert.deepEqual(reads.slice(0, 3), [["newest"], ["revision", 2], ["budget"]]);
});

// Review PRA-F2: a Start interrupted after its claim, before its Workflow was stored, is checked again as a first Start is.
const CHAT_KEY_YAML = `apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: waiter, version: "1.0.0" }\ninitial: ask\n`
    + `states:\n  ask:\n    type: agent\n    invoke: { prompt: "Say one thing." }\n    chat: new\n    timeoutSeconds: 600\n`
    + `    transition: { next: { said: done, failure: done } }\n  done: { type: terminal, outcome: succeeded }\n`;

test("PRA-F2: a resumed claim whose revision no longer compiles is refused in Start's words, before the budget is read", async () => {
    const claimed = hostWith("claim", { yaml: CHAT_KEY_YAML, requests: true });
    const error = await start(claimed.host);
    assert.equal(error?.code, "DEFINITION_INVALID", error?.message);
    assert.match(error.message, /^Revision 1 of waiter does not compile in this version \(.*\): .*`chat` is now `session`.* Nothing was started\.$/);
    assert.deepEqual(claimed.reads, [["revision", 1]]);
});

test("PRA-F2: a resumed claim is refused when the chat's budget is full without it; its own claim alone never refuses it", async () => {
    const full = hostWith("claim", { running: WORKFLOW_START_MAX_RUNNING_CHILDREN });
    const error = await start(full.host);
    assert.equal(error?.code, "CHILD_LIMIT", error?.message);
    assert.match(error.message, /Nothing was started\.$/);
    const room = hostWith("claim", { running: WORKFLOW_START_MAX_RUNNING_CHILDREN - 1 });
    assert.match(String((await start(room.host))?.message), /was used$/);
    assert.deepEqual(room.reads, [["revision", 1], ["budget", "own claim excluded"]]);
});
