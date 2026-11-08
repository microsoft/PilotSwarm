/**
 * OF-S2-7 (owner 2026-11-07T21:32Z), DB-less: per-node models. A definition never names a model; a start may map agent
 * nodes (by state id) to { model, reasoningEffort?, contextTier? }.
 *
 * - The map's shape: an object of node ids to choices (the tool's snake_case too); every other shape is refused in words.
 * - It is checked against exactly the revision started: an unknown id, or a node that is not an agent node, is refused,
 *   never ignored; an agent node in a For each body is one key for all its items.
 * - It is checked against the starter's catalog: a model it cannot use refuses the start, naming the node and the model.
 * - Stored as canonical JSON with the run; read back without throwing; the request digest is unchanged without one.
 * - Run again reuses the map of the Workflow it repeats unless the request gives its own (an empty map: none).
 * - At spawn: a chosen model wins; an unset node inherits model, reasoning effort AND context tier from its chat; a chosen
 *   model that cannot be resolved fails the node in words (no fallback), and another failure is not dressed up.
 * - The definition tool and spawn_workflow refuse a malformed map before anything is read or saved.
 *
 * Run: node --test test/unit/workflow-agent-models.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    agentModelsDigestPart, parseWorkflowAgentModels, readWorkflowAgentModels, requireAgentModelsForRevision, requireUsableAgentModels,
    workflowAgentModelsText, workflowAgentModelWords, workflowChosenModelsWords, readStoredAgentModels,
} from "../../dist/workflow/v2/agent-models.js";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { resolveRuntimeModelSelection } from "../../dist/provider-catalog.js";
import { parseRunCommandArgs, parseUpdateWorkflowArgs, updateWorkflowFromTool } from "../../dist/workflow/v2/tools.js";
import { PilotSwarmClient } from "../../dist/client.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { compileWorkflowV2 } from "../../dist/workflow/v2/compiler.js";
import { createWorkflowAgentNodeHost } from "../../dist/workflow/v2/agent-host.js";
import { startAgentModelsOf } from "../../dist/workflow/v2/chat-definitions.js";
import { workflowDefinitionFromTool } from "../../dist/workflow/v2/definition-tool.js";
import { spawnWorkflowFromTool } from "../../dist/workflow/spawn.js";
import { workflowCommandStatus } from "../../dist/workflow/v2/human-commands.js";

const ALL = { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true };

const YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: models, version: "1.0.0" }
initialInput: { items: [1, 2] }
initial: classify
states:
  classify:
    type: agent
    invoke: { prompt: "Classify it." }
    timeoutSeconds: 600
    transition: { next: { done: fan, failure: failed } }
  fan:
    type: parallel
    forEach: \${input.items}
    body:
      initial: review
      states:
        review:
          type: agent
          invoke: { prompt: "Review it." }
          timeoutSeconds: 600
          transition: { next: { done: item_done } }
        item_done: { type: terminal, outcome: succeeded }
    transition: { next: { joined: pause, blocked: failed, failure: failed } }
  pause: { type: wait, seconds: 5, transition: { next: { elapsed: finished } } }
  finished: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const untouchable = what => new Proxy({}, { get: (_target, name) => { throw new Error(`${what}.${String(name)} was used`); } });

test("the map's shape: node ids to { model, reasoningEffort?, contextTier? }, the tool's snake_case too; anything else refused in words", () => {
    assert.equal(parseWorkflowAgentModels(undefined), null);
    assert.equal(parseWorkflowAgentModels(null), null);
    assert.equal(parseWorkflowAgentModels({}), null, "an empty map is none");
    assert.deepEqual(parseWorkflowAgentModels({ classify: { model: " azure:gpt-5 ", reasoning_effort: "low", context_tier: "long_context" },
        review: { model: "anthropic:claude", reasoningEffort: "high" } }),
    { classify: { model: "azure:gpt-5", reasoningEffort: "low", contextTier: "long_context" }, review: { model: "anthropic:claude", reasoningEffort: "high" } });
    const refusals = [
        ["models", /must be an object of agent node ids/],
        [[{ model: "a:b" }], /must be an object of agent node ids/],
        [{ "1bad": { model: "a:b" } }, /key "1bad" is not a node id/],
        [{ classify: "a:b" }, /agentModels\.classify must be \{ model, reasoningEffort\?, contextTier\? \}/],
        [{ classify: { model: "a:b", temperature: 1 } }, /unknown field "temperature"/],
        [{ classify: { model: "gpt-5" } }, /model must be an exact provider:model from list_available_models/],
        [{ classify: {} }, /model must be an exact provider:model/],
        [{ classify: { model: "a:b", reasoningEffort: "extreme" } }, /reasoningEffort must be one of none, minimal, low, medium, high, xhigh, max/],
        [{ classify: { model: "a:b", contextTier: "huge" } }, /contextTier must be one of default, long_context/],
        [Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`n${i}`, { model: "a:b" }])), /names 65 nodes; at most 64/],
        // Review OF7-R7: each setting is one text value, in either spelling; never an array, object, number or boolean.
        [{ classify: { model: "a:b", reasoningEffort: ["high"] } }, /classify\.reasoningEffort must be one of none, .+, as text\./],
        [{ classify: { model: "a:b", reasoning_effort: ["high"] } }, /classify\.reasoningEffort must be one of/],
        [{ classify: { model: "a:b", contextTier: ["long_context"] } }, /classify\.contextTier must be one of default, long_context, as text\./],
        [{ classify: { model: "a:b", context_tier: { tier: "long_context" } } }, /classify\.contextTier must be one of/],
        [{ classify: { model: "a:b", reasoningEffort: 3 } }, /reasoningEffort must be one of/],
        [{ classify: { model: "a:b", contextTier: true } }, /contextTier must be one of/],
        [{ classify: { model: ["a:b"] } }, /model must be an exact provider:model/],
        [{ classify: { model: "a:b", reasoningEffort: "low", reasoning_effort: "high" } }, /gives reasoningEffort twice/],
    ];
    for (const [value, message] of refusals) {
        assert.throws(() => parseWorkflowAgentModels(value), error => error.code === "AGENT_MODELS_INVALID" && message.test(error.message), JSON.stringify(value));
    }
});

test("checked against exactly the revision started: an unknown id or a node that is not an agent node is refused; a For each body's agent is one key", () => {
    const compiled = compileWorkflowV2(YAML, ALL);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    const ir = compiled.ir;
    requireAgentModelsForRevision(null, ir, "revision 1 of models");
    requireAgentModelsForRevision({ classify: { model: "a:b" }, review: { model: "c:d" } }, ir, "revision 1 of models");
    assert.throws(() => requireAgentModelsForRevision({ summarize: { model: "a:b" } }, ir, "revision 1 of models"),
        error => error.code === "AGENT_MODELS_INVALID" && error.message === "agentModels names summarize, which is not a node of revision 1 of models. "
            + "Use the agent nodes' ids (their keys under states:).");
    assert.throws(() => requireAgentModelsForRevision({ pause: { model: "a:b" } }, ir, "revision 1 of models"),
        error => error.code === "AGENT_MODELS_INVALID" && error.message === "agentModels names pause, a wait node of revision 1 of models; only agent nodes take a model.");
    // A definition still never names a model: a model key on a node is an unknown field.
    const named = compileWorkflowV2(YAML.replace("invoke: { prompt: \"Classify it.\" }", "invoke: { prompt: \"Classify it.\" }\n    model: azure:gpt-5"), ALL);
    assert.equal(named.valid, false);
    assert.ok(named.diagnostics.some(item => item.code === "WORKFLOW_FIELD_UNKNOWN"), JSON.stringify(named.diagnostics));
});

test("checked against the owning chat's catalog: a model it cannot use refuses the start; a host without a checker refuses any map", async () => {
    // Fail closed: no checker, no map (nothing without a map is refused).
    await requireUsableAgentModels(null, undefined, null);
    await assert.rejects(requireUsableAgentModels({ classify: { model: "a:b" } }, undefined, null),
        error => error.code === "AGENT_MODEL_UNAVAILABLE" && error.message === "This host cannot check models against the owning chat's catalog, "
            + "so it takes no agentModels. Leave them out so every agent node uses the chat's model.");
    const asked = [];
    const check = async (choice, owner) => { asked.push([choice.model, owner?.subject ?? null]); return choice.model === "a:gone" ? "no provider serves it." : null; };
    await requireUsableAgentModels({ classify: { model: "a:b", reasoningEffort: "high" } }, check, { provider: "p", subject: "alice" });
    await assert.rejects(requireUsableAgentModels({ classify: { model: "a:b" }, review: { model: "a:gone", contextTier: "long_context" } }, check, null),
        error => error.code === "AGENT_MODEL_UNAVAILABLE" && error.message === "The model chosen for review, a:gone · long context, cannot be used "
            + "with the owning chat's catalog: no provider serves it. Choose one from list_available_models, or leave the node out so it uses the chat's model.");
    assert.deepEqual(asked, [["a:b", "alice"], ["a:b", null], ["a:gone", null]]);
});

test("stored as canonical JSON with the run, read back without throwing; the digest is unchanged without a map", () => {
    const models = { review: { model: "c:d" }, classify: { model: "a:b", reasoningEffort: "low" } };
    const text = workflowAgentModelsText(models);
    assert.equal(text, '{"classify":{"model":"a:b","reasoningEffort":"low"},"review":{"model":"c:d"}}');
    assert.equal(workflowAgentModelsText(null), null);
    assert.deepEqual(readWorkflowAgentModels(text), { classify: { model: "a:b", reasoningEffort: "low" }, review: { model: "c:d" } });
    assert.deepEqual(readWorkflowAgentModels(JSON.parse(text)), readWorkflowAgentModels(text));
    for (const stored of [null, undefined, "not json", "[]", '{"x":{"model":"nope"}}']) assert.equal(readWorkflowAgentModels(stored), null, String(stored));
    // A spawn reads it strictly: a stored value that cannot be read is an error in words, never "none" (review ruling).
    assert.deepEqual(readStoredAgentModels(null), { models: null });
    assert.deepEqual(readStoredAgentModels(text), { models: { classify: { model: "a:b", reasoningEffort: "low" }, review: { model: "c:d" } } });
    for (const stored of ["not json", "[]", '{"x":{"model":"nope"}}']) {
        assert.match(readStoredAgentModels(stored).error, /^The agent models stored with this run cannot be read \(AGENT_MODELS_INVALID\): /, stored);
    }
    assert.deepEqual(agentModelsDigestPart(null), {});
    assert.deepEqual(agentModelsDigestPart(undefined), {});
    assert.deepEqual(agentModelsDigestPart(models), { agentModels: text });
    // DEV at ead83d68: the receipt said the model and effort but no context tier in words.
    assert.equal(workflowAgentModelWords({ model: "a:b", reasoningEffort: "high", contextTier: "long_context" }), "a:b · high · long context");
    assert.equal(workflowAgentModelWords({ model: "a:b", contextTier: "default" }), "a:b · default context");
    assert.equal(workflowAgentModelWords({ model: "a:b" }), "a:b");
    assert.equal(workflowChosenModelsWords({ classify: { model: "azure-openai:gpt-5.6-terra", reasoningEffort: "low", contextTier: "long_context" },
        review: { model: "a:b" } }), "Agent nodes with a model chosen at start: classify: azure-openai:gpt-5.6-terra · low · long context; review: a:b; "
        + "the others use this chat's model. ");
    assert.equal(workflowChosenModelsWords(null), "");
});

test("Run again reuses the map of the Workflow it repeats, unless the request gives its own (an empty map: none)", async () => {
    const stored = '{"classify":{"model":"a:b"}}';
    const host = { store: { listRuns: async id => (id === "wf-1"
        ? [{ mode: "test", agentModels: '{"classify":{"model":"t:t"}}' }, { mode: "live", agentModels: stored }] : [{ mode: "live", agentModels: null }]) } };
    assert.deepEqual(await startAgentModelsOf(host, { runAgainOf: "wf-1" }), { classify: { model: "a:b" } }, "the live run's, never a test run's");
    assert.deepEqual(await startAgentModelsOf(host, { runAgainOf: "wf-1", agentModels: { classify: { model: "x:y" } } }), { classify: { model: "x:y" } });
    assert.equal(await startAgentModelsOf(host, { runAgainOf: "wf-1", agentModels: {} }), null);
    assert.equal(await startAgentModelsOf(host, { runAgainOf: "wf-2" }), null);
    assert.equal(await startAgentModelsOf({ store: untouchable("store") }, {}), null, "a start that is not Run again reads nothing");
});

/** An agent host over fake rows: chat P (model, effort, tier), Workflow W under it; createChild records or throws. */
function agentHost(createChild) {
    const sessions = {
        P: { parentSessionId: null, owner: { provider: "test", subject: "alice" }, model: "azure:chat-model", reasoningEffort: "medium", contextTier: "long_context" },
        W: { parentSessionId: "P", owner: null, sessionKind: "workflow" },
    };
    const created = [];
    const host = createWorkflowAgentNodeHost({
        getSession: async id => sessions[id] ?? null,
        resolveAgent: async () => null,
        createChild: async spec => { created.push(spec); if (createChild) await createChild(spec); },
    });
    return { host, created };
}
const spawnRequest = (fields = {}) => ({
    childSessionId: "child-1", workflowSessionId: "W", controllingSessionId: "P", runId: "run-1", nodeExecutionId: "nx-1", stateId: "classify",
    task: { source: "prompt", prompt: "Classify it." }, prompt: "[SYSTEM: wrapper]\n{}", clientMessageId: "workflow:W:run-1:agent:nx-1",
    deadlineAt: "2026-11-07T08:00:00.000Z", ...fields,
});

test("at spawn: an unset node inherits model, reasoning effort AND context tier from its chat; a chosen model wins, whole", async () => {
    const inherited = agentHost();
    // Review OF7-R8: the spawn says what the visit's chat runs on, from its session row once made (none here: no row).
    assert.deepEqual(await inherited.host.spawn(spawnRequest()), { spawned: true });
    assert.deepEqual([inherited.created[0].model, inherited.created[0].reasoningEffort, inherited.created[0].contextTier],
        ["azure:chat-model", "medium", "long_context"]);
    const chosen = agentHost();
    await chosen.host.spawn(spawnRequest({ agentModel: { model: "anthropic:fast", reasoningEffort: "low" } }));
    assert.equal(chosen.created[0].model, "anthropic:fast");
    assert.equal(chosen.created[0].reasoningEffort, "low");
    assert.equal(chosen.created[0].contextTier, undefined, "a choice without a tier takes the model's default, not the chat's");
});

test("review OF7-R8: a spawn reports what the visit's chat runs on, from its session row, and whether the start chose it", async () => {
    const rows = {
        P: { parentSessionId: null, owner: { provider: "test", subject: "alice" }, model: "azure:chat-model", reasoningEffort: "medium", contextTier: null },
        W: { parentSessionId: "P", owner: null, sessionKind: "workflow" },
    };
    const host = createWorkflowAgentNodeHost({
        getSession: async id => rows[id] ?? null,
        resolveAgent: async () => null,
        // The client resolves the child's model and stores its row (here: the tier the model defaults to).
        createChild: async spec => { rows[spec.sessionId] = { parentSessionId: "W", model: spec.model, reasoningEffort: spec.reasoningEffort ?? null, contextTier: "default" }; },
    });
    assert.deepEqual(await host.spawn(spawnRequest({ childSessionId: "c-1" })),
        { spawned: true, used: { model: "azure:chat-model", reasoningEffort: "medium", contextTier: "default", source: "chat" } });
    assert.deepEqual(await host.spawn(spawnRequest({ childSessionId: "c-2", agentModel: { model: "anthropic:fast", reasoningEffort: "low" } })),
        { spawned: true, used: { model: "anthropic:fast", reasoningEffort: "low", contextTier: "default", source: "start" } });
});

test("review OF7-R6: an explicit effort or tier must be one the chosen model lists; a model that lists none takes none", () => {
    const types = new ModelProviderRegistry({ providers: [{ id: "azure-openai", type: "openai", baseUrl: "https://example.test/v1", apiKey: "KEY", models: [
        { name: "listed", supportedReasoningEfforts: ["low", "high"], supportedContextTiers: ["default", "long_context"] },
        { name: "bare" },
    ] }] });
    const shared = [{ name: "team", typeId: "azure-openai", class: "shared", ownerUserId: null, baseUrl: null, secretRef: { kind: "apiKey", value: "K" } }];
    const pick = (model, reasoning, context) => resolveRuntimeModelSelection(types, shared, { requestedModel: model, requestedReasoning: reasoning,
        requestedContext: context, eligible: () => true, strictExplicitSettings: true });
    assert.equal(pick("team:listed", "high", "long_context").model, "team:listed");
    assert.equal(pick("team:bare", null, null).model, "team:bare", "omitted settings take the model's defaults");
    assert.throws(() => pick("team:listed", "max", null), /does not offer reasoning effort 'max' \(it offers low, high\)/);
    assert.throws(() => pick("team:bare", "high", null), /does not offer reasoning effort 'high' \(it offers none to choose\)/);
    assert.throws(() => pick("team:bare", null, "long_context"), /does not offer context tier 'long_context' \(it offers none to choose\)/);
    // Without the strict rule a model that lists none takes any (and its session would drop it): why the check asks for it.
    assert.equal(resolveRuntimeModelSelection(types, shared, { requestedModel: "team:bare", requestedContext: "long_context", eligible: () => true }).model,
        "team:bare");
});

test("review OF7-R3: update_workflow start and publish_and_start take agent_models; any other operation refuses them; a malformed map is refused", () => {
    const base = { workflow_id: "wf", operation_id: "op", definition_hash: "h", inputs: {} };
    assert.deepEqual(parseUpdateWorkflowArgs({ ...base, operation: "start", agent_models: { classify: { model: "a:b" } } }).command.agentModels,
        { classify: { model: "a:b" } });
    assert.deepEqual(parseUpdateWorkflowArgs({ ...base, operation: "publish_and_start", expected_revision: 1, agent_models: {} }).command.agentModels, {});
    assert.equal(Object.hasOwn(parseUpdateWorkflowArgs({ ...base, operation: "start" }).command, "agentModels"), false);
    assert.throws(() => parseUpdateWorkflowArgs({ ...base, operation: "publish", expected_revision: 1, agent_models: { classify: { model: "a:b" } } }),
        error => error.code === "AGENT_MODELS_INVALID" && error.message === "agent_models applies to publish_and_start and start only.");
    assert.throws(() => parseUpdateWorkflowArgs({ ...base, operation: "start", agent_models: { classify: { model: "gpt-5" } } }),
        error => error.code === "AGENT_MODELS_INVALID");
});

test("at spawn: a chosen model that cannot be resolved fails the node in words (no fallback); another failure is not dressed up", async () => {
    const unresolved = agentHost(async () => { throw Object.assign(new Error("Model 'anthropic:gone' is not in your catalog."), { code: "MODEL_UNRESOLVED" }); });
    const answer = await unresolved.host.spawn(spawnRequest({ agentModel: { model: "anthropic:gone", contextTier: "default" } }));
    assert.deepEqual(answer, { refused: { code: "unavailable", message: "Node classify cannot start its agent: the model chosen at start, anthropic:gone · default context, "
        + "cannot be used now: Model 'anthropic:gone' is not in your catalog." } });
    assert.equal(unresolved.created.length, 1, "one try; nothing else is created");
    // Without a choice the chat's model failing is not this rule's: it throws as before.
    const plain = agentHost(async () => { throw Object.assign(new Error("Model gone"), { code: "MODEL_UNRESOLVED" }); });
    await assert.rejects(plain.host.spawn(spawnRequest()), /Model gone/);
    const other = agentHost(async () => { throw Object.assign(new Error("database away"), { code: "ECONNRESET" }); });
    await assert.rejects(other.host.spawn(spawnRequest({ agentModel: { model: "a:b" } })), /database away/);
});

test("the definition tool and spawn_workflow refuse a malformed or misplaced map before anything is read or saved", async () => {
    const host = { store: untouchable("store"), catalog: untouchable("catalog"), duroxideClient: untouchable("duroxide"), requests: true };
    const started = JSON.parse(await workflowDefinitionFromTool({ operation: "start", name: "models", agent_models: { classify: { model: "gpt-5" } } },
        { callerSessionId: "chat", host, toolCallId: "call-1", owner: null, binding: async () => null }));
    assert.equal(started.error.code, "AGENT_MODELS_INVALID");
    assert.match(started.error.message, /classify\.model must be an exact provider:model/);
    const spawn = async args => JSON.parse(await spawnWorkflowFromTool({ yaml: YAML, key: "models", ...args }, { toolCallId: "call-1" }, {
        parentSessionId: "chat", enabled: () => true, getSession: async () => null, resolveOwner: async () => { throw new Error("owner read"); },
        captureToolBinding: async () => { throw new Error("binding read"); }, createWorkflowSession: async () => { throw new Error("v1"); },
        workflowV2Host: async () => host,
    }));
    const saveOnly = await spawn({ state: "published", agent_models: { classify: { model: "a:b" } } });
    assert.equal(saveOnly.error.code, "AGENT_MODELS_INVALID");
    assert.equal(saveOnly.error.message, "agent_models applies only with start: true.");
    const unknown = await spawn({ state: "published", start: true, agent_models: { pause: { model: "a:b" } } });
    assert.equal(unknown.error.code, "AGENT_MODELS_INVALID");
    assert.equal(unknown.error.message, "agentModels names pause, a wait node of models; only agent nodes take a model.");
    const v1 = await spawnWorkflowFromTool({ yaml: "kind: Workflow\n", agent_models: {} }, { toolCallId: "call-1" }, {
        parentSessionId: "chat", enabled: () => true, getSession: async () => null, resolveOwner: async () => null,
        captureToolBinding: async () => ({}), createWorkflowSession: async () => { throw new Error("v1"); }, workflowV2Host: async () => host,
    });
    assert.match(v1, /state, start, vars and agent_models apply to apiVersion pilotswarm\.dev\/v2-draft workflows only/);
});

test("a person's start refused for its models answers 400 (not agent nodes of that revision, or not shaped as a map) or 422 (a model they cannot use)", () => {
    assert.equal(workflowCommandStatus("AGENT_MODELS_INVALID"), 400);
    assert.equal(workflowCommandStatus("AGENT_MODEL_UNAVAILABLE"), 422);
});

// The check of fed7e7ac (fact pse/wfs/reviews/of-s2-7-ead83d68/fix-verify-fed7e7ac): D3, D6, D7 and D8.

test("review D3: run commands, test_advance, test_respond and recover refuse agent_models; they never ignore it", async () => {
    const base = { workflow_id: "wf", operation_id: "op", agent_models: { classify: { model: "a:b" } } };
    for (const args of [{ operation: "pause" }, { operation: "cancel" }, { operation: "set_vars", set: { a: 1 }, expected_kv_revision: 1 }]) {
        assert.throws(() => parseRunCommandArgs({ ...base, ...args }), error => error.code === "AGENT_MODELS_INVALID"
            && error.message === `agent_models applies to publish_and_start, start and a test with agent_mode real, not to ${args.operation}.`, args.operation);
    }
    // Refused before anything is read.
    const host = { store: untouchable("store"), catalog: untouchable("catalog"), duroxideClient: untouchable("duroxide"), requests: true, testMode: true };
    for (const operation of ["test_advance", "test_respond", "recover"]) {
        const answer = JSON.parse(await updateWorkflowFromTool({ ...base, operation, run_id: "run-1", seconds: 5, interception_id: "i-1",
            response: { kind: "success", value: 1 } }, { callerSessionId: "chat", host }));
        assert.equal(answer.error?.code, "AGENT_MODELS_INVALID", `${operation}: ${JSON.stringify(answer)}`);
        assert.match(answer.error.message, new RegExp(`not to ${operation}\\.$`));
    }
});

test("review D7: a spawn says chosen at start only when the chat runs the chosen model; else it is the chat's", async () => {
    const rows = {
        P: { parentSessionId: null, owner: { provider: "test", subject: "alice" }, model: "azure:chat-model" },
        W: { parentSessionId: "P", owner: null, sessionKind: "workflow" },
        // A continued chat that was switched to another model since its first visit.
        "c-1": { parentSessionId: "W", model: "azure:switched", reasoningEffort: null, contextTier: null },
    };
    const host = createWorkflowAgentNodeHost({ getSession: async id => rows[id] ?? null, resolveAgent: async () => null, createChild: async () => {} });
    assert.deepEqual((await host.spawn(spawnRequest({ childSessionId: "c-1", agentModel: { model: "anthropic:fast" } }))).used,
        { model: "azure:switched", reasoningEffort: null, contextTier: null, source: "chat" });
});

/** A catalog with one model listing efforts and tiers, a shared provider and one only the system may use. */
function catalogFixture() {
    const types = new ModelProviderRegistry({ providers: [{ id: "azure-openai", type: "openai", baseUrl: "https://example.test/v1", apiKey: "KEY", models: [
        { name: "listed", supportedReasoningEfforts: ["low", "high"], supportedContextTiers: ["default", "long_context"] }] }] });
    const credentials = [
        { name: "team", typeId: "azure-openai", class: "shared", ownerUserId: null, baseUrl: null, secretRef: { kind: "apiKey", value: "K" } },
        { name: "sysonly", typeId: "azure-openai", class: "personal", ownerUserId: "u-other", systemUseEnabled: true, baseUrl: null,
            secretRef: { kind: "apiKey", value: "S" } },
    ];
    const providers = { lookupUserId: async () => null, getDefaults: async () => ({ mine: null, cluster: null, system: null }), allCredentials: async () => credentials };
    return { types, providers };
}

test("review D6, OF7-R6: the worker's check resolves as the spawn does (never the system's providers) and wants listed settings", async () => {
    const { types, providers } = catalogFixture();
    const fake = { _catalog: { providers }, _modelProviderTypes: types, _resolveCreationModel: PilotSwarmClient.prototype._resolveCreationModel };
    const check = PilotSwarmClient.prototype._workflowAgentModelCheck.call(fake);
    const SYSTEM = { provider: "system", subject: "workflows" };
    assert.equal(await check({ model: "team:listed", reasoningEffort: "high", contextTier: "long_context" }, SYSTEM), null);
    // Only the system may use sysonly; a node's chat is created as its owner (createSession), so it is refused here too.
    assert.match(await check({ model: "sysonly:listed" }, SYSTEM), /No usable provider serves model|cannot run model|sysonly/);
    assert.match(await check({ model: "team:listed", reasoningEffort: "max" }, SYSTEM), /does not offer reasoning effort 'max' \(it offers low, high\)/);
    // Without a model catalog it cannot check, so it refuses.
    const bare = PilotSwarmClient.prototype._workflowAgentModelCheck.call({ _catalog: null, _resolveCreationModel: PilotSwarmClient.prototype._resolveCreationModel });
    assert.equal(await bare({ model: "team:listed" }, SYSTEM), "this deployment has no model catalog to check it against.");
});

test("review D6, OF7-R6: the management check resolves as the spawn does and wants listed settings; no catalog, no check", async () => {
    const { types, providers } = catalogFixture();
    const check = (choice, owner, fake = { _catalog: { providers }, _modelProviders: types }) =>
        PilotSwarmManagementClient.prototype._checkWorkflowAgentModel.call(fake, choice, owner);
    const SYSTEM = { provider: "system", subject: "workflows" };
    assert.equal(await check({ model: "team:listed", contextTier: "default" }, SYSTEM), null);
    assert.match(await check({ model: "sysonly:listed" }, SYSTEM), /No usable provider serves model|cannot run model|sysonly/);
    assert.match(await check({ model: "team:listed", contextTier: "huge" }, SYSTEM), /does not offer context tier 'huge'/);
    assert.equal(await check({ model: "team:listed" }, SYSTEM, { _catalog: { providers }, _modelProviders: null }),
        "this deployment has no model catalog to check it against.");
});

test("review D8: a person's package publication is validated with the configured catalog's model ids and names", () => {
    const { types } = catalogFixture();
    const validation = PilotSwarmManagementClient.prototype._agentPackageValidation.call({ _modelProviders: types }, { reservedAgentNames: ["x"] });
    assert.deepEqual(validation.reservedAgentNames, ["x"]);
    assert.deepEqual([...validation.knownModelNames].sort(), ["azure-openai:listed", "listed"]);
    assert.deepEqual(PilotSwarmManagementClient.prototype._agentPackageValidation.call({ _modelProviders: null }).knownModelNames, []);
});
