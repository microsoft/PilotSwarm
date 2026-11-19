/** Decision binding uses the existing run map; availability is not a structural compiler input. */
import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow } from "../../dist/workflow/compiler.js";
import { agentModelsDigestPart, parseWorkflowAgentModels, readStoredAgentModels, requireAgentModelsForRevision,
    workflowAgentModelsText, workflowSaveCompilation } from "../../dist/workflow/agent-models.js";
import { startAgentModelsOf } from "../../dist/workflow/session-definitions.js";
import { workflowDefinitionFromTool, WORKFLOW_DEFINITION_TOOL_SPEC } from "../../dist/workflow/definition-tool.js";
import { AGENT_OVERRIDE, DECISION_DEFAULT, UNSET_DECISION, agentWorkflowYaml, decisionWorkflowYaml,
    effectiveDecisionModels } from "../helpers/workflow-decision-models.js";

test("Decision compilation remains host-independent and produces no availability diagnostic", () => {
    const result = compileWorkflow(decisionWorkflowYaml("decision-models", { full: true }));
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(Object.values(result.ir.nodes).filter(node => node.type === "decision").map(node => node.id).sort(),
        ["nested", "route", "score"]);
    assert.equal(result.diagnostics.some(item => item.code === "WORKFLOW_DECISION_MODEL_UNAVAILABLE"), false);
});

test("save-time validation invalidates Decision IR without mutating structural compilation or reading non-Decision capability", async () => {
    const compiled = compileWorkflow(decisionWorkflowYaml());
    const saved = await workflowSaveCompilation(compiled, async () => UNSET_DECISION);
    assert.equal(saved.valid, false);
    assert.equal(saved.ir, null);
    assert.equal(saved.irSha256, null);
    assert.deepEqual(saved.diagnostics.map(item => [item.code, item.path]), [["WORKFLOW_DECISION_MODEL_UNAVAILABLE", "states.route.type"]]);
    assert.equal(compiled.valid, true);
    assert.notEqual(compiled.ir, null);

    const agent = compileWorkflow(agentWorkflowYaml());
    const plain = await workflowSaveCompilation(agent, async () => { throw new Error("non-Decision save read capability"); });
    assert.equal(plain.valid, true);
    assert.equal(plain.ir, agent.ir);
});

test("Decision entries are accepted in the same canonical agentModels map as Agent entries", () => {
    const compiled = compileWorkflow(decisionWorkflowYaml("decision-models", { full: true }));
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    const models = parseWorkflowAgentModels({ ...effectiveDecisionModels(), ask: {
        model: AGENT_OVERRIDE, reasoning_effort: "high", context_tier: "long_context",
    } });
    assert.doesNotThrow(() => requireAgentModelsForRevision(models, compiled.ir, "revision 1 of decision-models"));
    assert.equal(workflowAgentModelsText(models), '{"ask":{"contextTier":"long_context","model":"chat:chosen","reasoningEffort":"high"},"route":{"model":"team:decision-main"}}');
    assert.deepEqual(readStoredAgentModels(workflowAgentModelsText(models)), { models });
});

test("the legacy Agent map and absent or empty map keep their exact stored and digest shapes", () => {
    const models = parseWorkflowAgentModels({ ask: { model: AGENT_OVERRIDE, reasoning_effort: "high", context_tier: "long_context" } });
    const compiled = compileWorkflow(agentWorkflowYaml());
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    requireAgentModelsForRevision(models, compiled.ir, "revision 1 of agent-models-regression");
    const text = '{"ask":{"contextTier":"long_context","model":"chat:chosen","reasoningEffort":"high"}}';
    assert.equal(workflowAgentModelsText(models), text);
    assert.deepEqual(agentModelsDigestPart(models), { agentModels: text });
    for (const given of [undefined, null, {}]) {
        assert.equal(workflowAgentModelsText(parseWorkflowAgentModels(given)), null);
        assert.deepEqual(agentModelsDigestPart(parseWorkflowAgentModels(given)), {});
    }
});

test("unknown ids and non-model-bearing node types are refused rather than silently dropped", () => {
    const compiled = compileWorkflow(decisionWorkflowYaml("decision-models", { full: true }));
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    for (const id of ["missing", "fan", "done", "item_done"]) {
        assert.throws(() => requireAgentModelsForRevision({ [id]: { model: DECISION_DEFAULT } }, compiled.ir, "revision 1"),
            error => error.code === "AGENT_MODELS_INVALID" && error.message.includes(id));
    }
});

test("Run again reads Decision choices from the existing live agentModels column, and an explicit empty map clears choices", async () => {
    const models = effectiveDecisionModels(DECISION_DEFAULT, { full: true });
    const reads = [];
    const host = { store: { listRuns: async id => { reads.push(id); return [
        { mode: "test", agentModels: '{"route":{"model":"test:not-live"}}' },
        { mode: "live", agentModels: workflowAgentModelsText(models) },
    ]; } } };
    assert.deepEqual(await startAgentModelsOf(host, { runAgainOf: "prior" }), models);
    assert.equal(await startAgentModelsOf(host, { runAgainOf: "prior", agentModels: {} }), null);
    assert.deepEqual(reads, ["prior"], "clearing choices must not read or inherit the prior map");
});

test("workflow_definition declares the additive decision_models alias without requiring it", () => {
    const spec = WORKFLOW_DEFINITION_TOOL_SPEC.parameters;
    assert.equal(spec.properties.decision_models?.type, "object");
    assert.equal(spec.required.includes("decision_models"), false);
    assert.equal(spec.properties.agent_models.type, "object");
});

const untouched = new Proxy({}, { get: (_target, name) => { throw new Error(`store.${String(name)} must not be read`); } });
const call = async args => JSON.parse(await workflowDefinitionFromTool({ operation: "start", name: "decision-models", ...args }, {
    callerSessionId: "chat", host: { store: untouched, catalog: untouched }, owner: null, toolCallId: "start-1", binding: async () => null,
}));

test("a malformed decision_models alias is refused before any store or catalog read", async () => {
    for (const value of ["model", [], { route: DECISION_DEFAULT }, { route: { model: "unqualified" } }]) {
        const result = await call({ decision_models: value });
        assert.equal(result.ok, false);
        assert.equal(result.error.code, "AGENT_MODELS_INVALID", result.error.message);
    }
});

test("overlapping agent_models and decision_models refuse the same node even when the models agree", async () => {
    const result = await call({ agent_models: { route: { model: DECISION_DEFAULT } }, decision_models: { route: { model: DECISION_DEFAULT } } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "AGENT_MODELS_INVALID", result.error.message);
    assert.match(result.error.message, /route/);
});

test("Decision alias entries take only model, including when reasoning or context is explicitly null", async () => {
    for (const field of ["reasoningEffort", "reasoning_effort", "contextTier", "context_tier"]) {
        for (const value of [null, field.startsWith("reasoning") ? "high" : "long_context"]) {
            const result = await call({ decision_models: { route: { model: DECISION_DEFAULT, [field]: value } } });
            assert.equal(result.ok, false);
            assert.equal(result.error.code, "AGENT_MODELS_INVALID", `${field}: ${result.error.message}`);
        }
    }
});
