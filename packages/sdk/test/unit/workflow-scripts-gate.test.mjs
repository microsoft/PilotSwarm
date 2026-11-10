/**
 * Workflows are always on (owner 2026-11-08T08:03Z); PILOTSWARM_WORKFLOW_SCRIPTS decides only whether script nodes run. A host whose workers run no scripts
 * (`scripts: false`) refuses a definition with a script node at save and at Start, in words naming the setting, before
 * anything is written; a host that does not know (`scripts` absent) does not refuse. A definition without script nodes is
 * not affected. The database side is test/local/workflow-v2-scripts-gate.test.js.
 *
 * Run: node --test test/unit/workflow-scripts-gate.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    WORKFLOW_SCRIPTS_DISABLED, requireWorkflowScripts, requireWorkflowScriptsInYaml, workflowScriptsDisabledText, workflowScriptsOptionFromEnv,
    workflowV2ScriptNodes,
} from "../../dist/workflow/v2/scripts-gate.js";
import { compileWorkflowV2 } from "../../dist/workflow/v2/compiler.js";
import { createWorkflowV2, updateWorkflowV2 } from "../../dist/workflow/v2/service.js";
import { spawnWorkflowFromTool } from "../../dist/workflow/spawn.js";
import { workflowDefinitionFromTool } from "../../dist/workflow/v2/definition-tool.js";
import { startChatWorkflowDefinition } from "../../dist/workflow/v2/chat-definitions.js";
import * as sdk from "../../dist/index.js";

const SCRIPT_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: poller, version: "1.0.0" }
initial: poll
states:
  poll: { type: script, runtime: node, source: "return { outcome: 'done' };", timeoutSeconds: 30, transition: { next: { done: finish } } }
  finish: { type: terminal, outcome: succeeded }
`;
const WAIT_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: waiter, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 5, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;
const ACTOR = { kind: "system", name: "scripts-gate-test" };

/** A store or catalog any use of which fails the test: a refusal must come before anything is read or written. */
const untouchable = what => new Proxy({}, { get: (_target, name) => { throw new Error(`${what}.${String(name)} was used`); } });
/**
 * A catalog that answers only the read of a Start operation's own claim (none: S2RT-F5, receipt-first); anything else
 * fails the test.
 */
const claimReadsOnly = () => new Proxy({ getSessionCreationConfig: async () => null },
    { get: (target, name) => { if (name in target) return target[name]; throw new Error(`catalog.${String(name)} was used`); } });

/** A store that has one revision of `yaml` (draft, or published) and fails on anything that would write. */
function storeOf(yaml, { published = false } = {}) {
    const compiled = compileWorkflowV2(yaml);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    return {
        readRevision: async () => ({ revision: 1, valid: true, irSha256: compiled.irSha256, yamlSha256: compiled.yamlSha256 }),
        readRevisionIr: async () => compiled.ir,
        readRevisionIrVersion: async () => compiled.ir.irVersion ?? 1,
        readDefinition: async () => ({ state: published ? "published" : "draft", publishedRevision: published ? 1 : null,
            publishedIrSha256: published ? compiled.irSha256 : null, parentSessionId: "p" }),
        publish: async () => { throw new Error("publish was reached"); },
        startLive: async () => { throw new Error("startLive was reached"); },
        replaceDraft: async () => { throw new Error("replaceDraft was reached"); },
    };
}

async function refusal(promise) {
    let caught = null;
    try { await promise; } catch (error) { caught = error; }
    return caught;
}

test("the script nodes of a definition, the refusal's words, and the code", () => {
    assert.deepEqual(workflowV2ScriptNodes(compileWorkflowV2(SCRIPT_YAML).ir), ["poll"]);
    assert.deepEqual(workflowV2ScriptNodes(compileWorkflowV2(WAIT_YAML).ir), []);
    assert.deepEqual(workflowV2ScriptNodes(null), []);
    assert.equal(WORKFLOW_SCRIPTS_DISABLED, "WORKFLOW_SCRIPTS_DISABLED");
    assert.equal(sdk.WORKFLOW_SCRIPTS_DISABLED, WORKFLOW_SCRIPTS_DISABLED);
    assert.equal(workflowScriptsDisabledText(["poll"], "save"),
        "This workflow has script node (poll), and script nodes are turned off on this server: an operator turned them off with "
        + "PILOTSWARM_WORKFLOW_SCRIPTS=0. Nothing was saved.");
    assert.match(workflowScriptsDisabledText(["a", "b", "c", "d", "e", "f", "g"], "start"), /script nodes \(a, b, c, d, e, and 2 more\).*Nothing was started\.$/);
    const ir = compileWorkflowV2(SCRIPT_YAML).ir;
    assert.doesNotThrow(() => requireWorkflowScripts({}, ir, "save"), "not known: no refusal");
    assert.doesNotThrow(() => requireWorkflowScripts({ scripts: true }, ir, "save"));
    assert.throws(() => requireWorkflowScripts({ scripts: false }, ir, "start"),
        error => error.code === WORKFLOW_SCRIPTS_DISABLED && error.details.setting === "PILOTSWARM_WORKFLOW_SCRIPTS" && /Nothing was started\.$/.test(error.message));
    assert.doesNotThrow(() => requireWorkflowScripts({ scripts: false }, compileWorkflowV2(WAIT_YAML).ir, "start"));
});

test("save: creating or replacing a definition with a script node is refused before anything is read or written", async () => {
    const host = { catalog: untouchable("catalog"), store: untouchable("store"), duroxideClient: untouchable("duroxide"), scripts: false };
    for (const [publish, start, when] of [[false, null, "saved"], [true, null, "saved"], [true, { inputs: {} }, "started"]]) {
        const error = await refusal(createWorkflowV2(host, { workflowSessionId: "w1", parentSessionId: "p", yaml: SCRIPT_YAML, actor: ACTOR,
            operationId: "op-1", publish, ...(start ? { start } : {}) }));
        assert.equal(error?.code, WORKFLOW_SCRIPTS_DISABLED, error?.message);
        assert.match(error.message, new RegExp(`Nothing was ${when}\\.$`));
    }
    const replaced = await refusal(updateWorkflowV2(host, "w1", { operation: "replace_definition", yaml: SCRIPT_YAML, expectedRevision: 1 },
        { actor: ACTOR, operationId: "op-2" }));
    assert.equal(replaced?.code, WORKFLOW_SCRIPTS_DISABLED);
    // Without script nodes the request goes on (it reaches the store, here a stand-in that throws its own error).
    const waits = await refusal(createWorkflowV2(host, { workflowSessionId: "w1", parentSessionId: "p", yaml: WAIT_YAML, actor: ACTOR, operationId: "op-3" }));
    assert.match(String(waits?.message), /was used$/);
});

test("Start: publishing and starting, or starting, a stored definition with a script node is refused before the store writes", async () => {
    const at = (published) => ({ catalog: untouchable("catalog"), store: storeOf(SCRIPT_YAML, { published }), duroxideClient: untouchable("duroxide"), scripts: false });
    const context = { actor: ACTOR, operationId: "op-4" };
    const definitionHash = "h";
    for (const [host, command, when] of [
        [at(false), { operation: "publish_and_start", expectedRevision: 1, definitionHash, inputs: {} }, "started"],
        [at(false), { operation: "publish", expectedRevision: 1, definitionHash }, "saved"],
        [at(true), { operation: "start", definitionHash, inputs: {} }, "started"],
    ]) {
        const error = await refusal(updateWorkflowV2(host, "w1", command, context));
        assert.equal(error?.code, WORKFLOW_SCRIPTS_DISABLED, `${command.operation}: ${error?.message}`);
        assert.match(error.message, new RegExp(`Nothing was ${when}\\.$`));
    }
    // A host that runs scripts, or does not know, goes on to the store.
    for (const scripts of [true, undefined]) {
        const host = { ...at(true), ...(scripts === undefined ? {} : { scripts }) };
        if (scripts === undefined) delete host.scripts;
        const error = await refusal(updateWorkflowV2(host, "w1", { operation: "start", definitionHash, inputs: {} }, context));
        assert.equal(error?.message, "startLive was reached", String(scripts));
    }
});

// Owner 2026-11-08T15:45Z (pse/decision/scripts-default-on): PILOTSWARM_WORKFLOW_SCRIPTS is an opt-out, read the same way
// by the worker, the portal and the MCP server.
test("a management client's option from this process's PILOTSWARM_WORKFLOW_SCRIPTS: on unless it turns them off", () => {
    for (const on of [undefined, "", " ", "1", "true", "yes", " TRUE "]) {
        assert.deepEqual(workflowScriptsOptionFromEnv(on === undefined ? {} : { PILOTSWARM_WORKFLOW_SCRIPTS: on }), { workflowScripts: true }, JSON.stringify(on));
    }
    for (const off of ["0", "false", "no", "off", " No "]) {
        assert.deepEqual(workflowScriptsOptionFromEnv({ PILOTSWARM_WORKFLOW_SCRIPTS: off }), { workflowScripts: false }, off);
    }
});

test("an unknown PILOTSWARM_WORKFLOW_SCRIPTS value keeps scripts on, with one warning per process that does not echo it", () => {
    sdk.resetWorkflowScriptsWarning();
    const warned = [];
    const warn = message => warned.push(message);
    assert.equal(sdk.workflowScriptsEnabledFromEnv({ PILOTSWARM_WORKFLOW_SCRIPTS: "enabled-please" }, warn), true);
    assert.equal(sdk.workflowScriptsEnabledFromEnv({ PILOTSWARM_WORKFLOW_SCRIPTS: "maybe" }, warn), true);
    assert.deepEqual(warned, [sdk.WORKFLOW_SCRIPTS_UNKNOWN_VALUE_WARNING]);
    assert.ok(!warned[0].includes("enabled-please"));
    assert.equal(sdk.workflowScriptsEnabledFromEnv({ PILOTSWARM_WORKFLOW_SCRIPTS: "0" }, warn), false);
    assert.equal(warned.length, 1);
    sdk.resetWorkflowScriptsWarning();
});

// d52e5ed2 (executor diagnosis 2): the chat's save and start paths captured the chat's tool binding before the scripts gate,
// so a host whose session manager could not capture one answered WORKFLOW_ERROR instead of the gate's refusal. The gate
// now decides first: before the binding is captured, the owner read or the store read (a start reads only the revision it
// gates).
test("d52e5ed2: the scripts gate decides before the chat's tool binding, its owner or its store on spawn_workflow and workflow_definition", async () => {
    const never = what => async () => { throw new Error(`${what} must not be reached`); };
    const host = { catalog: untouchable("catalog"), store: untouchable("store"), duroxideClient: untouchable("duroxide"), scripts: false };
    const deps = { parentSessionId: "chat", enabled: () => false, resolveOwner: never("resolveOwner"),
        captureToolBinding: never("captureToolBinding"), workflowV2Host: async () => host };
    for (const [args, when] of [[{ yaml: SCRIPT_YAML, key: "a" }, "saved"], [{ yaml: SCRIPT_YAML, key: "b", state: "published", start: true, inputs: {} }, "started"]]) {
        const answer = JSON.parse(await spawnWorkflowFromTool(args, { toolCallId: "call-1" }, deps));
        assert.equal(answer.error?.code, WORKFLOW_SCRIPTS_DISABLED, JSON.stringify(answer));
        assert.match(answer.error.message, new RegExp(`Nothing was ${when}\\.$`));
    }
    const saved = JSON.parse(await workflowDefinitionFromTool({ operation: "save", name: "poller", yaml: SCRIPT_YAML },
        { callerSessionId: "chat", host, toolCallId: "call-2", owner: null, binding: never("binding") }));
    assert.equal(saved.error?.code, WORKFLOW_SCRIPTS_DISABLED, JSON.stringify(saved));
    assert.match(saved.error.message, /Nothing was saved\.$/);
    // Without a script node the call goes on (here to a store that throws its own error).
    const waits = JSON.parse(await workflowDefinitionFromTool({ operation: "save", name: "waiter", yaml: WAIT_YAML },
        { callerSessionId: "chat", host, toolCallId: "call-3", owner: null, binding: never("binding") }));
    assert.match(String(waits.error?.message), /store\.chat was used/);
});

test("d52e5ed2: a chat definition's Start gates the revision it would start before the binding is captured or anything is written", async () => {
    const compiled = compileWorkflowV2(SCRIPT_YAML);
    const chat = {
        readDefinition: async () => ({ definitionId: "def-1", ownerSessionId: "chat", name: "poller", currentRevision: 1, deletedAt: null }),
        readRevision: async () => ({ definitionId: "def-1", revision: 1, valid: true, irSha256: compiled.irSha256, yaml: SCRIPT_YAML }),
        readRevisionIr: async () => compiled.ir,
        newestValidRevision: async () => 1,
        listWorkflows: async () => [],
        // Stage 2.4: Start's limits read the chat's running children and (S2RT-F4) its stored nesting level after the gate.
        runningChildren: async () => 0,
        nestingLevel: async () => 0,
    };
    // Its chat definitions read, and whether this start's Workflow exists (none); anything else of the store (what creating
    // the Workflow would use) fails the test.
    const store = new Proxy({ chat, readDefinition: async () => null, readWorkflowLineage: async () => null },
        { get: (target, name) => { if (name in target) return target[name]; throw new Error(`store.${String(name)} was used`); } });
    const host = { catalog: claimReadsOnly(), store, duroxideClient: untouchable("duroxide"), scripts: false };
    let captured = 0;
    const error = await refusal(startChatWorkflowDefinition(host, { ownerSessionId: "chat", definition: { definitionId: "def-1" }, inputs: {}, actor: ACTOR,
        operationId: "op-start", binding: async () => { captured += 1; return null; } }));
    assert.equal(error?.code, WORKFLOW_SCRIPTS_DISABLED, error?.message);
    assert.match(error.message, /Nothing was started\.$/);
    assert.equal(captured, 0);
    // A host that runs scripts captures the binding, then goes on to create the Workflow (here a store that throws).
    const on = await refusal(startChatWorkflowDefinition({ ...host, scripts: true }, { ownerSessionId: "chat", definition: { definitionId: "def-1" },
        inputs: {}, actor: ACTOR, operationId: "op-start-2", binding: async () => { captured += 1; return null; } }));
    assert.equal(captured, 1);
    assert.match(String(on?.message), /was used$/);
});

// Stage 2.4 (PR 235 2b893906): Start keeps spawn_agent's limits, after the scripts gate and before the binding is captured or
// anything is made: a chat at the deepest level starts no Workflow, and a chat with 50 running children (sub-agents and
// active Workflows) starts no more. A repeat of a start that made its Workflow is not refused by it.
test("stage 2.4: Start keeps spawn_agent's depth limit and its budget of 50 running children", async () => {
    const compiled = compileWorkflowV2(WAIT_YAML);
    let running = 0;
    let made = null;
    const chat = {
        readDefinition: async () => ({ definitionId: "def-1", ownerSessionId: "chat", name: "waiter", currentRevision: 1, deletedAt: null }),
        readRevision: async () => ({ definitionId: "def-1", revision: 1, valid: true, irSha256: compiled.irSha256, yaml: WAIT_YAML }),
        newestValidRevision: async () => 1,
        listWorkflows: async () => [],
        runningChildren: async () => running,
        nestingLevel: async () => level,
    };
    let level = 0;
    const store = new Proxy({ chat, readDefinition: async () => made, readWorkflowLineage: async () => null },
        { get: (target, name) => { if (name in target) return target[name]; throw new Error(`store.${String(name)} was used`); } });
    const host = { catalog: claimReadsOnly(), store, duroxideClient: untouchable("duroxide"), scripts: true };
    let captured = 0;
    const start = (extra = {}) => refusal(startChatWorkflowDefinition(host, { ownerSessionId: "chat", definition: { definitionId: "def-1" }, inputs: {},
        actor: ACTOR, operationId: "op-limit", binding: async () => { captured += 1; return null; }, ...extra }));
    const deep = await start({ nestingLevel: 2 });
    assert.equal(deep?.code, "WORKFLOW_NESTING_LIMIT");
    assert.match(deep.message, /^This chat is at nesting level 2 \(max 2\), .* Nothing was started\.$/);
    running = 50;
    const full = await start({ nestingLevel: 1 });
    assert.equal(full?.code, "CHILD_LIMIT");
    assert.match(full.message, /^This chat already has 50 running sub-agents and Workflows \(max 50\)\. .* Nothing was started\.$/);
    assert.equal(captured, 0, "refused before the binding is captured");
    // A level-1 chat with 49 running children goes on (to the store that throws here).
    running = 49;
    assert.match(String((await start({ nestingLevel: 1 }))?.message), /was used$/);
    assert.equal(captured, 1);
    // S2RT-F4: the chat's own stored level counts when the caller gives none (a person's Start), and when it gives less.
    running = 0;
    level = 2;
    for (const given of [{}, { nestingLevel: 0 }, { nestingLevel: null }]) {
        const stored = await start(given);
        assert.equal(stored?.code, "WORKFLOW_NESTING_LIMIT", JSON.stringify(given));
        assert.match(stored.message, /^This chat is at nesting level 2 \(max 2\)/);
    }
    level = 0;
    // A repeat of a start whose Workflow exists is answered as before, whatever the budget now (S2RT-F5: from its pin).
    running = 50;
    made = { workflowSessionId: "w", state: "published", chatDefinitionId: "def-1", chatRevision: 1 };
    assert.match(String((await start({ nestingLevel: 1 }))?.message), /was used$/);
});

// The e02ec6f8 run (then workflows-switch.test.js:244, now workflows-always-on.test.js): on a turn whose workflow host could not be made (no inline client), a
// script-node spawn with scripts off answered WORKFLOW_ERROR ("No storeUrl"), because the gate came after the host. The gate
// now decides from the YAML alone, on the worker's setting, before the host is made.
test("e02ec6f8: the scripts gate decides from the YAML alone, before the host is made, on the worker's setting", async () => {
    assert.throws(() => requireWorkflowScriptsInYaml(false, SCRIPT_YAML, "save"),
        error => error.code === WORKFLOW_SCRIPTS_DISABLED && /Nothing was saved\.$/.test(error.message));
    assert.throws(() => requireWorkflowScriptsInYaml(false, SCRIPT_YAML, "start"), /Nothing was started\.$/);
    for (const [scripts, yaml] of [[true, SCRIPT_YAML], [undefined, SCRIPT_YAML], [false, WAIT_YAML], [false, "not: [yaml"], [false, ""], [false, 7]]) {
        assert.doesNotThrow(() => requireWorkflowScriptsInYaml(scripts, yaml, "save"), `${scripts} ${String(yaml).slice(0, 20)}`);
    }
    // A script node beside node types only some hosts take (an agent state) is still found.
    const withAgent = SCRIPT_YAML.replace("  finish: { type: terminal, outcome: succeeded }",
        "  finish: { type: terminal, outcome: succeeded }\n  ask: { type: agent, invoke: { prompt: \"x\" }, timeoutSeconds: 60, transition: { next: { ok: finish } } }");
    assert.throws(() => requireWorkflowScriptsInYaml(false, withAgent, "save"), error => error.code === WORKFLOW_SCRIPTS_DISABLED);

    const never = what => async () => { throw new Error(`${what} must not be reached`); };
    const deps = { parentSessionId: "chat", enabled: () => false, resolveOwner: never("resolveOwner"),
        captureToolBinding: never("captureToolBinding"),
        workflowV2Host: async () => { throw new Error("No storeUrl — cannot create PilotSwarmClient"); } };
    for (const [args, when] of [[{ yaml: SCRIPT_YAML, key: "scripted-draft" }, "saved"],
        [{ yaml: SCRIPT_YAML, key: "scripted-start", state: "published", start: true, inputs: {} }, "started"]]) {
        const text = await spawnWorkflowFromTool(args, { toolCallId: "call-1" }, deps);
        const answer = JSON.parse(text);
        assert.equal(answer.error?.code, WORKFLOW_SCRIPTS_DISABLED, text);
        assert.match(answer.error.message, new RegExp(`PILOTSWARM_WORKFLOW_SCRIPTS=0\\. Nothing was ${when}\\.$`));
    }
    // Without a script node the call goes on to the host (here one that cannot be made: its coded answer, as before).
    const waits = JSON.parse(await spawnWorkflowFromTool({ yaml: WAIT_YAML, key: "waits" }, { toolCallId: "call-3" }, deps));
    assert.equal(waits.error?.code, "WORKFLOW_ERROR");
});
