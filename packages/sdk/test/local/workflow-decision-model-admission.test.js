/** Real save/run rows, recording dispatch only: no controller, claim on refusal, or provider execution. */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { AGENT_OVERRIDE, AVAILABLE_DECISION, DECISION_DEFAULT, DECISION_OVERRIDE, STALE_DECISION, UNSET_DECISION,
    agentWorkflowYaml, decisionWorkflowYaml, effectiveDecisionModels } from "../helpers/workflow-decision-models.js";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { workflowAgentModelsText } from "../../src/workflow/agent-models.ts";
import { applyWorkflowUpdate, createWorkflow } from "../../src/workflow/service.ts";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { workflowDefinitionFromTool } from "../../src/workflow/definition-tool.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "decision-model-admission" };
const ACTOR = { kind: "system", name: "decision-model-admission" };
const UNAVAILABLE = "WORKFLOW_DECISION_MODEL_UNAVAILABLE";

async function withHost(options, body) {
    const h = await openWorkflowStore(getEnv());
    try {
        const session = randomUUID();
        await h.catalog.createSession(session, { owner: OWNER, model: "chat:inherited", reasoningEffort: "high", contextTier: "long_context" });
        let current = structuredClone(options.capability ?? AVAILABLE_DECISION);
        const claims = [], dispatched = [], agentChecks = [];
        let capabilityReads = 0;
        const catalog = new Proxy(h.catalog, { get(target, name) {
            if (name === "createWorkflowSession") return async (...args) => { claims.push(args[0]); return target.createWorkflowSession(...args); };
            return typeof target[name] === "function" ? target[name].bind(target) : target[name];
        } });
        const host = { catalog, store: h.store, duroxideClient: {
            startOrchestrationVersioned: async id => { dispatched.push(id); },
            getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {},
        }, checkAgentModel: async (choice, owner) => {
            agentChecks.push({ choice, owner });
            return choice.model === AGENT_OVERRIDE ? null : "not in the owning session's chat catalog";
        } };
        // The capability getter is the only new host seam this suite requires; its value must be read for each fresh admission.
        if (options.capabilityHost !== false) host.decisionCapability = async () => { capabilityReads++; return structuredClone(current); };
        const f = {
            h, host, session, claims, dispatched, agentChecks,
            setCapability: value => { current = structuredClone(value); },
            capabilityReads: () => capabilityReads,
            save: async (yaml = decisionWorkflowYaml(), name = "decision-models", extra = {}) => (await saveSessionWorkflowDefinition(host, {
                ownerSessionId: session, name, yaml, expected: null, actor: { kind: "session", sessionId: session },
                operationId: randomUUID(), by: "session", ...extra,
            })).receipt,
            start: (definitionId, extra = {}) => startSessionWorkflowDefinition(host, {
                ownerSessionId: session, definition: { definitionId }, inputs: {}, actor: ACTOR, owner: OWNER,
                operationId: randomUUID(), ...extra,
            }),
            tool: async args => JSON.parse(await workflowDefinitionFromTool(args, {
                callerSessionId: session, host, owner: OWNER, toolCallId: randomUUID(), binding: async () => null,
            })),
        };
        await body(f);
    } finally { await h.stop(); }
}

async function footprint(f) {
    const [row] = await f.h.q(`SELECT
        (SELECT count(*)::int FROM SCHEMA.sessions WHERE parent_session_id = $1 AND session_kind = 'workflow') AS sessions,
        (SELECT count(*)::int FROM SCHEMA.workflow_definitions WHERE parent_session_id = $1) AS definitions,
        (SELECT count(*)::int FROM SCHEMA.workflow_runs WHERE workflow_session_id IN
            (SELECT session_id FROM SCHEMA.sessions WHERE parent_session_id = $1)) AS runs`, [f.session]);
    return { ...row, claims: f.claims.length, dispatched: f.dispatched.length };
}

async function refusedBeforeCreation(f, work, code = UNAVAILABLE) {
    const before = await footprint(f);
    await expect(work()).rejects.toMatchObject({ code });
    expect(await footprint(f)).toEqual(before);
}

async function storedModels(f, started, models) {
    const run = await f.h.store.readRun(started.runId);
    expect(run.agentModels).toBe(workflowAgentModelsText(models));
    expect(started.agentModels).toEqual(models);
    expect(Object.hasOwn(started, "decisionModels")).toBe(false);
}

async function expectInvalidChildDecision(f, workflowSessionId, receipt) {
    expect(receipt).toMatchObject({ state: "draft", valid: false, irSha256: null, publishedRevision: null, run: null });
    expect(receipt.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ severity: "error", code: UNAVAILABLE, path: "states.route.type" }),
    ]));
    const revision = await f.h.store.readRevision(workflowSessionId, receipt.revision);
    expect(revision).toMatchObject({ valid: false, irSha256: null, diagnostics: receipt.diagnostics });
    await expect(f.h.store.readRevisionIr(workflowSessionId, receipt.revision)).rejects.toMatchObject({ code: "DEFINITION_INVALID" });
    expect(await f.h.store.readDefinition(workflowSessionId)).toMatchObject({ state: "draft", publishedRevision: null });
    expect(await f.h.store.listRuns(workflowSessionId)).toEqual([]);
}

describe("Decision save capability diagnostics", () => {
    for (const [label, options] of [["no capability host", { capabilityHost: false }], ["unset default", { capability: UNSET_DECISION }],
        ["stale default", { capability: STALE_DECISION }]]) {
        it(`save stores a structurally valid Decision definition as invalid with ${label}`, { timeout: TIMEOUT }, () => withHost(options, async f => {
            const yaml = decisionWorkflowYaml();
            const compiled = compileWorkflow(yaml);
            expect(compiled.valid).toBe(true);
            const saved = await f.save(yaml, "decision-models", { compiled });
            expect(saved.valid).toBe(false);
            const errors = saved.diagnostics.filter(item => item.severity === "error");
            expect(errors.map(({ code, path }) => ({ code, path }))).toEqual([{ code: UNAVAILABLE, path: "states.route.type" }]);
            expect(errors[0].message).toMatch(/cluster decision default/i);
            expect(errors[0].message).toMatch(/configure|admin settings/i);
            expect(errors[0].message).toMatch(/replace/i);
            const revision = await f.h.store.sessionDefinitions.readRevision(saved.definitionId, saved.revision);
            expect(revision.valid).toBe(false);
            expect(revision.diagnostics).toEqual(saved.diagnostics);
            expect(await f.h.store.sessionDefinitions.readRevisionIr(saved.definitionId, saved.revision)).toBeNull();
            expect(compiled.valid).toBe(true, "host validation must not mutate the caller's structural compilation");
            expect(compiled.diagnostics.some(item => item.code === UNAVAILABLE)).toBe(false);
            expect(await footprint(f)).toEqual({ sessions: 0, definitions: 0, runs: 0, claims: 0, dispatched: 0 });
        }));
    }

    it("an eligible available default saves valid without materializing a run or changing structural IR", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const yaml = decisionWorkflowYaml();
        const compiled = compileWorkflow(yaml);
        const saved = await f.save(yaml);
        expect(saved.valid).toBe(true);
        expect(saved.diagnostics.some(item => item.code === UNAVAILABLE)).toBe(false);
        expect(await f.h.store.sessionDefinitions.readRevisionIr(saved.definitionId, 1)).toEqual(compiled.ir);
        expect(await footprint(f)).toEqual({ sessions: 0, definitions: 0, runs: 0, claims: 0, dispatched: 0 });
    }));

    it("a Start-only override in either alias cannot rescue an unavailable save", { timeout: TIMEOUT }, () => withHost({ capability: UNSET_DECISION }, async f => {
        for (const alias of ["agent_models", "decision_models"]) {
            const name = `save-${alias}`;
            const answer = await f.tool({ operation: "save", name, yaml: decisionWorkflowYaml(name), [alias]: { route: { model: DECISION_OVERRIDE } } });
            expect(answer).toMatchObject({ ok: true, valid: false, errors: [{ code: UNAVAILABLE, path: "states.route.type" }] });
        }
        expect(await footprint(f)).toEqual({ sessions: 0, definitions: 0, runs: 0, claims: 0, dispatched: 0 });
    }));
});

describe("Decision child save and publication capability diagnostics", () => {
    it("create keeps an unavailable Decision as an invalid draft, including publish-only, and replays that receipt", { timeout: TIMEOUT }, () => withHost({ capability: UNSET_DECISION }, async f => {
        for (const publish of [false, true]) {
            const workflowSessionId = randomUUID();
            const request = { workflowSessionId, parentSessionId: f.session, owner: OWNER,
                yaml: decisionWorkflowYaml(`child-create-${publish ? "publish" : "draft"}`), actor: ACTOR,
                operationId: randomUUID(), publish };
            const created = await createWorkflow(f.host, request);
            expect(created.replayed).toBe(false);
            await expectInvalidChildDecision(f, workflowSessionId, created.receipt);
            if (publish) {
                f.setCapability(AVAILABLE_DECISION);
                const reads = f.capabilityReads();
                const replay = await createWorkflow(f.host, request);
                expect(replay).toMatchObject({ replayed: true, receipt: created.receipt });
                expect(f.capabilityReads()).toBe(reads, "an admitted creation replay must not consult the changed catalog");
                await expectInvalidChildDecision(f, workflowSessionId, replay.receipt);
            }
        }
        expect(f.dispatched).toEqual([]);
    }));

    it("replace_definition stores the same unavailable-Decision diagnostics and drops its IR", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const workflowSessionId = randomUUID();
        const yaml = decisionWorkflowYaml("child-replace");
        const created = await createWorkflow(f.host, { workflowSessionId, parentSessionId: f.session, owner: OWNER,
            yaml, actor: ACTOR, operationId: randomUUID() });
        expect(created.receipt.valid).toBe(true);
        f.setCapability(STALE_DECISION);
        const replaced = await applyWorkflowUpdate(f.host, workflowSessionId,
            { operation: "replace_definition", expectedRevision: 1, yaml: `${yaml}\n# revision two\n` },
            { actor: ACTOR, operationId: randomUUID() });
        expect(replaced.replayed).toBe(false);
        expect(replaced.receipt.revision).toBe(2);
        expect(replaced.receipt.diagnostics[0]).toMatchObject({ code: UNAVAILABLE, path: "states.route.type" });
        await expectInvalidChildDecision(f, workflowSessionId, replaced.receipt);
    }));

    for (const operation of ["publish", "publish_and_start"]) {
        it(`${operation} revalidates the current catalog, invalidates the draft and never promotes or starts it`, { timeout: TIMEOUT }, () => withHost({}, async f => {
            const workflowSessionId = randomUUID();
            const created = await createWorkflow(f.host, { workflowSessionId, parentSessionId: f.session, owner: OWNER,
                yaml: decisionWorkflowYaml(`child-${operation}`), actor: ACTOR, operationId: randomUUID() });
            expect(created.receipt.valid).toBe(true);
            f.setCapability(operation === "publish" ? UNSET_DECISION : STALE_DECISION);
            const command = operation === "publish"
                ? { operation, expectedRevision: 1, definitionHash: created.receipt.yamlSha256 }
                : { operation, expectedRevision: 1, definitionHash: created.receipt.yamlSha256, inputs: {} };
            await expect(applyWorkflowUpdate(f.host, workflowSessionId, command, { actor: ACTOR, operationId: randomUUID() }))
                .rejects.toMatchObject({ code: UNAVAILABLE, details: { revision: 1 } });
            await expectInvalidChildDecision(f, workflowSessionId, { ...created.receipt, valid: false, irSha256: null,
                diagnostics: (await f.h.store.readRevision(workflowSessionId, 1)).diagnostics });
            expect(f.dispatched).toEqual([]);
        }));
    }
});

describe("Decision Start availability and effective canonical map", () => {
    it("materializes every top-level and nested Decision using the configured default, never chat or the first eligible model", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save(decisionWorkflowYaml("decision-models", { full: true }));
        const started = await f.start(saved.definitionId);
        await storedModels(f, started, effectiveDecisionModels(DECISION_DEFAULT, { full: true }));
        expect(f.agentChecks).toEqual([], "Decision defaults must not pass through the owner's Agent/chat checker");
        expect(f.claims).toHaveLength(1);
        expect(f.dispatched).toHaveLength(1);
    }));

    for (const [label, capability] of [["unset", UNSET_DECISION], ["stale", STALE_DECISION],
        ["default missing despite an available flag", { ...AVAILABLE_DECISION, defaultModel: null }],
        ["default removed despite an available flag", { ...AVAILABLE_DECISION, models: [DECISION_OVERRIDE] }]]) {
        it(`a saved valid revision refuses fresh Start when the current default is ${label}, even with an override`, { timeout: TIMEOUT }, () => withHost({}, async f => {
            const saved = await f.save();
            f.setCapability(capability);
            for (const agentModels of [undefined, { route: { model: DECISION_OVERRIDE } }]) {
                await refusedBeforeCreation(f, () => f.start(saved.definitionId, { agentModels }));
            }
            expect(await f.h.store.sessionDefinitions.listWorkflows({ definitionId: saved.definitionId })).toEqual([]);
        }));
    }

    it("Start fails closed if the host loses its capability getter after a valid save", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save();
        delete f.host.decisionCapability;
        await refusedBeforeCreation(f, () => f.start(saved.definitionId));
    }));

    it("Start recompiles YAML rather than trusting the revision's saved valid flag and IR", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save();
        const broken = decisionWorkflowYaml().replace("type: decision", "type: not-a-state");
        await f.h.q("UPDATE SCHEMA.session_workflow_revisions SET yaml = $2 WHERE definition_id = $1 AND revision = 1", [saved.definitionId, broken]);
        await refusedBeforeCreation(f, () => f.start(saved.definitionId), "DEFINITION_INVALID");
    }));

    it("a legacy agent_models Decision override uses only an eligible Decision model and preserves Agent settings", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save(decisionWorkflowYaml("decision-models", { full: true }));
        const answer = await f.tool({ operation: "start", definition_id: saved.definitionId, agent_models: {
            route: { model: DECISION_OVERRIDE }, ask: { model: AGENT_OVERRIDE, reasoning_effort: "high", context_tier: "long_context" },
        } });
        expect(answer.ok).toBe(true);
        await storedModels(f, answer, { ...effectiveDecisionModels(DECISION_DEFAULT, { full: true }), route: { model: DECISION_OVERRIDE },
            ask: { model: AGENT_OVERRIDE, reasoningEffort: "high", contextTier: "long_context" } });
        expect(f.agentChecks).toEqual([{ choice: { model: AGENT_OVERRIDE, reasoningEffort: "high", contextTier: "long_context" }, owner: OWNER }]);
    }));

    it("the separate decision_models alias merges disjoint choices into the same stored run map", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save(decisionWorkflowYaml("decision-models", { full: true }));
        const answer = await f.tool({ operation: "start", definition_id: saved.definitionId,
            agent_models: { ask: { model: AGENT_OVERRIDE }, score: { model: DECISION_OVERRIDE } },
            decision_models: { route: { model: DECISION_OVERRIDE } } });
        expect(answer.ok).toBe(true);
        await storedModels(f, answer, { ...effectiveDecisionModels(DECISION_DEFAULT, { full: true }),
            ask: { model: AGENT_OVERRIDE }, score: { model: DECISION_OVERRIDE }, route: { model: DECISION_OVERRIDE } });
    }));

    it("same-node alias overlap is refused before any row or claim even when choices agree", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save();
        for (const model of [DECISION_DEFAULT, DECISION_OVERRIDE]) {
            const before = await footprint(f);
            const answer = await f.tool({ operation: "start", definition_id: saved.definitionId,
                agent_models: { route: { model: DECISION_DEFAULT } }, decision_models: { route: { model } } });
            expect(answer).toMatchObject({ ok: false, error: { code: "AGENT_MODELS_INVALID" } });
            expect(answer.error.message).toMatch(/route/);
            expect(await footprint(f)).toEqual(before);
        }
    }));

    for (const model of [AGENT_OVERRIDE, "team:removed-decision"]) {
        it(`an explicit Decision override outside capability.models (${model}) refuses rather than substituting the default`, { timeout: TIMEOUT }, () => withHost({}, async f => {
            const saved = await f.save();
            await refusedBeforeCreation(f, () => f.start(saved.definitionId, { agentModels: { route: { model } } }));
        }));
    }

    it("decision_models rejects an Agent, terminal, or unknown id of this revision", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save(decisionWorkflowYaml("decision-models", { full: true }));
        for (const id of ["ask", "done", "missing"]) {
            const before = await footprint(f);
            const answer = await f.tool({ operation: "start", definition_id: saved.definitionId, decision_models: { [id]: { model: DECISION_DEFAULT } } });
            expect(answer).toMatchObject({ ok: false, error: { code: "AGENT_MODELS_INVALID" } });
            expect(answer.error.message).toContain(id);
            expect(await footprint(f)).toEqual(before);
        }
    }));

    it("Decision entries in both surfaces refuse reasoning and context, including explicit null fields", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save();
        for (const alias of ["agent_models", "decision_models"]) {
            for (const field of ["reasoningEffort", "reasoning_effort", "contextTier", "context_tier"]) {
                for (const value of [null, field.startsWith("reasoning") ? "high" : "long_context"]) {
                    const before = await footprint(f);
                    const answer = await f.tool({ operation: "start", definition_id: saved.definitionId,
                        [alias]: { route: { model: DECISION_DEFAULT, [field]: value } } });
                    expect(answer).toMatchObject({ ok: false, error: { code: "AGENT_MODELS_INVALID" } });
                    expect(await footprint(f)).toEqual(before);
                }
            }
        }
    }));

    it("direct create-and-Start also refuses unavailable Decision before a Workflow row or creation claim", { timeout: TIMEOUT }, () => withHost({ capability: UNSET_DECISION }, async f => {
        await refusedBeforeCreation(f, () => createWorkflow(f.host, { workflowSessionId: randomUUID(), parentSessionId: f.session, owner: OWNER,
            yaml: decisionWorkflowYaml(), actor: ACTOR, operationId: randomUUID(), publish: true, start: { inputs: {} } }));
    }));
});

describe("Decision receipt-first replay and Run again", () => {
    it("an admitted keyed Start returns its original effective map after availability is revoked without checking capability again", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save();
        const first = await f.start(saved.definitionId, { key: "admitted" });
        await storedModels(f, first, effectiveDecisionModels());
        const before = await footprint(f);
        const reads = f.capabilityReads();
        f.setCapability(UNSET_DECISION);
        f.host.decisionCapability = async () => { throw new Error("an admitted keyed replay must not resolve current Decision capability"); };
        f.host.checkAgentModel = async () => { throw new Error("an admitted keyed replay must not check models again"); };
        const replay = await f.start(saved.definitionId, { key: "admitted" });
        expect(replay).toMatchObject({ workflowId: first.workflowId, runId: first.runId, revision: 1, replayed: true });
        await storedModels(f, replay, effectiveDecisionModels());
        expect(f.capabilityReads()).toBe(reads);
        const after = await footprint(f);
        expect({ ...after, dispatched: before.dispatched }).toEqual(before);
    }));

    it("Run again inherits prior effective Decision choices rather than replacing them with a changed default", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save(decisionWorkflowYaml("decision-models", { full: true }));
        const first = await f.start(saved.definitionId);
        f.setCapability({ ...AVAILABLE_DECISION, defaultModel: DECISION_OVERRIDE });
        const again = await f.start(saved.definitionId, { runAgainOf: first.workflowId });
        expect(again.workflowId).not.toBe(first.workflowId);
        await storedModels(f, again, effectiveDecisionModels(DECISION_DEFAULT, { full: true }));
    }));

    it("Run again revalidates a prior effective model and refuses when it has been removed", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save();
        const first = await f.start(saved.definitionId);
        f.setCapability({ ...AVAILABLE_DECISION, defaultModel: DECISION_OVERRIDE, models: [DECISION_OVERRIDE] });
        await refusedBeforeCreation(f, () => f.start(saved.definitionId, { runAgainOf: first.workflowId }));
    }));

    it("an explicit empty map clears inherited Agent choices but still binds every Decision to the current default", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save(decisionWorkflowYaml("decision-models", { full: true }));
        const first = await f.start(saved.definitionId, { agentModels: { ask: { model: AGENT_OVERRIDE, reasoningEffort: "high", contextTier: "long_context" } } });
        f.setCapability({ ...AVAILABLE_DECISION, defaultModel: DECISION_OVERRIDE, models: [DECISION_OVERRIDE] });
        const checked = f.agentChecks.length;
        const again = await f.start(saved.definitionId, { runAgainOf: first.workflowId, agentModels: {} });
        await storedModels(f, again, effectiveDecisionModels(DECISION_OVERRIDE, { full: true }));
        expect(f.agentChecks).toHaveLength(checked);
        f.setCapability(UNSET_DECISION);
        await refusedBeforeCreation(f, () => f.start(saved.definitionId, { runAgainOf: first.workflowId, agentModels: {} }));
    }));
});

describe("non-Decision regression", () => {
    it("save, Start and Run again need no Decision capability and retain Agent map wire bytes and settings", { timeout: TIMEOUT }, () => withHost({ capabilityHost: false }, async f => {
        f.host.decisionCapability = async () => { throw new Error("a definition without Decision must not resolve Decision capability"); };
        const saved = await f.save(agentWorkflowYaml(), "agent-models-regression");
        expect(saved.valid).toBe(true);
        const plain = await f.start(saved.definitionId);
        expect(Object.hasOwn(plain, "agentModels")).toBe(false);
        expect((await f.h.store.readRun(plain.runId)).agentModels).toBeNull();
        const agentModels = { ask: { model: AGENT_OVERRIDE, reasoningEffort: "high", contextTier: "long_context" } };
        const chosen = await f.start(saved.definitionId, { agentModels });
        await storedModels(f, chosen, agentModels);
        const inherited = await f.start(saved.definitionId, { runAgainOf: chosen.workflowId });
        await storedModels(f, inherited, agentModels);
        const cleared = await f.start(saved.definitionId, { runAgainOf: chosen.workflowId, agentModels: {} });
        expect(Object.hasOwn(cleared, "agentModels")).toBe(false);
        expect((await f.h.store.readRun(cleared.runId)).agentModels).toBeNull();
    }));
});
