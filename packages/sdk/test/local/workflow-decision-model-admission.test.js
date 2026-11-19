/** Real save/run rows, recording dispatch only: no controller, claim on refusal, or provider execution. */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { AGENT_OVERRIDE, AVAILABLE_DECISION, DECISION_DEFAULT, DECISION_OVERRIDE, STALE_DECISION, UNSET_DECISION,
    agentWorkflowYaml, decisionWorkflowYaml, effectiveDecisionModels } from "../helpers/workflow-decision-models.js";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { workflowAgentModelsText } from "../../src/workflow/agent-models.ts";
import { applyWorkflowUpdate, createWorkflow, startWorkflowTest } from "../../src/workflow/service.ts";
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
    const decisions = Object.fromEntries(Object.entries(models).filter(([id]) => ["route", "score", "nested"].includes(id)));
    if (Object.keys(decisions).length) expect(started.decisionModels).toEqual(decisions);
    else expect(Object.hasOwn(started, "decisionModels")).toBe(false);
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

    it("a Decision-only tool receipt exposes the pinned model without Agent or chat fallback wording", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save();
        const answer = await f.tool({ operation: "start", definition_id: saved.definitionId });
        expect(answer.ok).toBe(true);
        expect(answer.agentModels).toEqual(effectiveDecisionModels());
        expect(answer.decisionModels).toEqual(effectiveDecisionModels());
        expect(answer.message).toContain(`Decision nodes use their pinned effective Decision models (the Cluster Decision Default when no override was chosen): route: ${DECISION_DEFAULT}`);
        expect(answer.message).toContain("no Decision node inherits the session's chat model.");
        expect(answer.message).not.toMatch(/Agent nodes|the others use this session's model/);
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
        const effective = { ...effectiveDecisionModels(DECISION_DEFAULT, { full: true }), route: { model: DECISION_OVERRIDE },
            ask: { model: AGENT_OVERRIDE, reasoningEffort: "high", contextTier: "long_context" } };
        await storedModels(f, answer, effective);
        expect(answer.decisionModels).toEqual({ route: { model: DECISION_OVERRIDE }, score: { model: DECISION_DEFAULT }, nested: { model: DECISION_DEFAULT } });
        expect(answer.message).toContain(`Agent nodes with a model chosen at start: ask: ${AGENT_OVERRIDE} · high · long context; `
            + "the others use this session's model.");
        expect(answer.message).toContain("Decision nodes use their pinned effective Decision models");
        expect(answer.message).not.toContain(`Agent nodes with a model chosen at start: route:`);
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
        f.host.duroxideClient.startOrchestrationVersioned = async () => { throw new Error("an admitted keyed replay must not dispatch again"); };
        const replay = await f.start(saved.definitionId, { key: "admitted" });
        expect(replay).toMatchObject({ workflowId: first.workflowId, runId: first.runId, revision: 1, replayed: true });
        await storedModels(f, replay, effectiveDecisionModels());
        expect(f.capabilityReads()).toBe(reads);
        expect(await footprint(f)).toEqual(before);
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

describe("lower-level Decision operation replay", () => {
    it("atomic create and Start replays the original effective map before any fresh admission", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const workflowSessionId = randomUUID();
        const operationId = randomUUID();
        const yaml = decisionWorkflowYaml("atomic-replay", { full: true });
        const request = {
            workflowSessionId, parentSessionId: f.session, owner: OWNER, yaml, actor: ACTOR, operationId,
            publish: true, start: { inputs: {}, vars: { revision: 1 }, agentModels: { ask: { model: AGENT_OVERRIDE } } },
        };
        const first = await createWorkflow(f.host, request);
        expect(first.replayed).toBe(false);
        const effective = { ...effectiveDecisionModels(DECISION_DEFAULT, { full: true }), ask: { model: AGENT_OVERRIDE } };
        expect((await f.h.store.readRun(first.receipt.run.runId)).agentModels).toBe(workflowAgentModelsText(effective));
        const before = await footprint(f);

        f.setCapability({ ...AVAILABLE_DECISION, defaultModel: DECISION_OVERRIDE });
        expect(await createWorkflow(f.host, request)).toMatchObject({ replayed: true, receipt: first.receipt });
        f.setCapability(UNSET_DECISION);
        expect(await createWorkflow(f.host, request)).toMatchObject({ replayed: true, receipt: first.receipt });
        f.host.decisionCapability = async () => { throw new Error("an exact atomic replay must not resolve Decision capability"); };
        f.host.checkAgentModel = async () => { throw new Error("an exact atomic replay must not check Agent models"); };
        f.host.resolveAgent = async () => { throw new Error("an exact atomic replay must not resolve agents"); };
        f.host.duroxideClient.startOrchestrationVersioned = async () => { throw new Error("an exact atomic replay must not dispatch"); };
        expect(await createWorkflow(f.host, request)).toMatchObject({ replayed: true, receipt: first.receipt });
        expect(await footprint(f)).toEqual(before);

        for (const changed of [
            { ...request, yaml: `${yaml}\n# another source\n` },
            { ...request, start: { ...request.start, inputs: { changed: true } } },
            { ...request, start: { ...request.start, vars: { revision: 2 } } },
            { ...request, start: { ...request.start, agentModels: { ask: { model: "chat:other" } } } },
            { ...request, notifyParent: false },
        ]) {
            await expect(createWorkflow(f.host, changed)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        }
    }));

    it("publish_and_start and published start replay their receipts with the original Decision intent", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const makeDraft = async name => {
            const id = randomUUID();
            const created = await createWorkflow(f.host, {
                workflowSessionId: id, parentSessionId: f.session, owner: OWNER, yaml: decisionWorkflowYaml(name, { full: true }),
                actor: ACTOR, operationId: `create-${randomUUID()}`,
            });
            return { id, created };
        };
        const together = await makeDraft("publish-and-start-replay");
        const separated = await makeDraft("published-start-replay");
        await applyWorkflowUpdate(f.host, separated.id, {
            operation: "publish", expectedRevision: 1, definitionHash: separated.created.receipt.yamlSha256,
        }, { actor: ACTOR, operationId: `publish-${randomUUID()}` });
        const togetherCommand = {
            operation: "publish_and_start", expectedRevision: 1, definitionHash: together.created.receipt.yamlSha256,
            inputs: {}, vars: { phase: 1 }, agentModels: { ask: { model: AGENT_OVERRIDE } },
        };
        const startCommand = {
            operation: "start", definitionHash: separated.created.receipt.yamlSha256, inputs: {},
            vars: { phase: 1 }, agentModels: { ask: { model: AGENT_OVERRIDE } },
        };
        const togetherOperation = randomUUID();
        const startOperation = randomUUID();
        const togetherFirst = await applyWorkflowUpdate(f.host, together.id, togetherCommand, { actor: ACTOR, operationId: togetherOperation });
        const startFirst = await applyWorkflowUpdate(f.host, separated.id, startCommand, { actor: ACTOR, operationId: startOperation });
        const before = await footprint(f);
        const originalTogether = effectiveDecisionModels(DECISION_DEFAULT, { full: true });
        originalTogether.ask = { model: AGENT_OVERRIDE };
        const originalStart = effectiveDecisionModels(DECISION_DEFAULT, { full: true });
        originalStart.ask = { model: AGENT_OVERRIDE };
        expect((await f.h.store.readRun(togetherFirst.receipt.run.runId)).agentModels).toBe(workflowAgentModelsText(originalTogether));
        expect((await f.h.store.readRun(startFirst.receipt.run.runId)).agentModels).toBe(workflowAgentModelsText(originalStart));

        f.setCapability({ ...AVAILABLE_DECISION, defaultModel: DECISION_OVERRIDE });
        expect(await applyWorkflowUpdate(f.host, together.id, togetherCommand, { actor: ACTOR, operationId: togetherOperation }))
            .toMatchObject({ replayed: true, receipt: togetherFirst.receipt });
        expect(await applyWorkflowUpdate(f.host, separated.id, startCommand, { actor: ACTOR, operationId: startOperation }))
            .toMatchObject({ replayed: true, receipt: startFirst.receipt });
        f.setCapability(UNSET_DECISION);
        f.host.decisionCapability = async () => { throw new Error("an exact update replay must not resolve Decision capability"); };
        f.host.checkAgentModel = async () => { throw new Error("an exact update replay must not check Agent models"); };
        f.host.resolveAgent = async () => { throw new Error("an exact update replay must not resolve agents"); };
        f.host.duroxideClient.startOrchestrationVersioned = async () => { throw new Error("an exact update replay must not dispatch"); };
        expect(await applyWorkflowUpdate(f.host, together.id, togetherCommand, { actor: ACTOR, operationId: togetherOperation }))
            .toMatchObject({ replayed: true, receipt: togetherFirst.receipt });
        expect(await applyWorkflowUpdate(f.host, separated.id, startCommand, { actor: ACTOR, operationId: startOperation }))
            .toMatchObject({ replayed: true, receipt: startFirst.receipt });
        expect(await footprint(f)).toEqual(before);

        for (const command of [
            { ...togetherCommand, inputs: { changed: true } },
            { ...togetherCommand, vars: { phase: 2 } },
            { ...togetherCommand, notifyParent: false },
            { ...togetherCommand, agentModels: { ...togetherCommand.agentModels, route: { model: DECISION_OVERRIDE } } },
            { ...togetherCommand, definitionHash: "0" },
            { ...togetherCommand, expectedRevision: 2 },
        ]) {
            await expect(applyWorkflowUpdate(f.host, together.id, command, { actor: ACTOR, operationId: togetherOperation }))
                .rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        }
        for (const command of [
            { ...startCommand, inputs: { changed: true } },
            { ...startCommand, vars: { phase: 2 } },
            { ...startCommand, notifyParent: false },
            { ...startCommand, agentModels: { ...startCommand.agentModels, route: { model: DECISION_OVERRIDE } } },
            { ...startCommand, definitionHash: "0" },
        ]) {
            await expect(applyWorkflowUpdate(f.host, separated.id, command, { actor: ACTOR, operationId: startOperation }))
                .rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        }
    }));

    it("mocked and real direct tests replay the original bench without model, pin, or dispatch work", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const mockedId = randomUUID();
        const realId = randomUUID();
        const mocked = await createWorkflow(f.host, {
            workflowSessionId: mockedId, parentSessionId: f.session, owner: OWNER, yaml: decisionWorkflowYaml("mocked-test-replay"),
            actor: ACTOR, operationId: randomUUID(),
        });
        const real = await createWorkflow(f.host, {
            workflowSessionId: realId, parentSessionId: f.session, owner: OWNER, yaml: decisionWorkflowYaml("real-test-replay", { full: true }),
            actor: ACTOR, operationId: randomUUID(),
        });
        const commands = {
            mocked: { expectedRevision: 1, definitionHash: mocked.receipt.yamlSha256, inputs: {}, vars: { mode: "mocked" },
                agentMode: "mocked", fixtures: [], scenario: "mocked-replay" },
            real: { expectedRevision: 1, definitionHash: real.receipt.yamlSha256, inputs: {}, vars: { mode: "real" },
                agentMode: "real", fixtures: [], scenario: "real-replay", agentModels: { ask: { model: AGENT_OVERRIDE } } },
        };
        const operations = { mocked: randomUUID(), real: randomUUID() };
        const context = operationId => ({ actor: ACTOR, operationId });
        const first = {
            mocked: await startWorkflowTest(f.host, mockedId, commands.mocked, context(operations.mocked)),
            real: await startWorkflowTest(f.host, realId, commands.real, context(operations.real)),
        };
        expect((await f.h.store.readRun(first.mocked.receipt.run.runId)).agentModels).toBe(workflowAgentModelsText(effectiveDecisionModels()));
        expect((await f.h.store.readRun(first.real.receipt.run.runId)).agentModels).toBe(workflowAgentModelsText({
            ...effectiveDecisionModels(DECISION_DEFAULT, { full: true }), ask: { model: AGENT_OVERRIDE },
        }));
        const before = await footprint(f);

        f.setCapability({ ...AVAILABLE_DECISION, defaultModel: DECISION_OVERRIDE });
        expect(await startWorkflowTest(f.host, mockedId, commands.mocked, context(operations.mocked)))
            .toMatchObject({ replayed: true, receipt: first.mocked.receipt });
        expect(await startWorkflowTest(f.host, realId, commands.real, context(operations.real)))
            .toMatchObject({ replayed: true, receipt: first.real.receipt });
        f.setCapability(UNSET_DECISION);
        f.host.decisionCapability = async () => { throw new Error("an exact test replay must not resolve Decision capability"); };
        f.host.checkAgentModel = async () => { throw new Error("an exact test replay must not check Agent models"); };
        f.host.resolveAgent = async () => { throw new Error("an exact real-test replay must not resolve agents"); };
        f.host.duroxideClient.startOrchestrationVersioned = async () => { throw new Error("an exact test replay must not dispatch"); };
        expect(await startWorkflowTest(f.host, mockedId, commands.mocked, context(operations.mocked)))
            .toMatchObject({ replayed: true, receipt: first.mocked.receipt });
        expect(await startWorkflowTest(f.host, realId, commands.real, context(operations.real)))
            .toMatchObject({ replayed: true, receipt: first.real.receipt });
        expect(await footprint(f)).toEqual(before);

        for (const changed of [
            { ...commands.mocked, inputs: { changed: true } },
            { ...commands.mocked, vars: { mode: "changed" } },
            { ...commands.mocked, fixtures: [{ operation: "decision", state: "route", response: { kind: "success", value: {} } }] },
            { ...commands.mocked, scenario: "changed" },
            { ...commands.mocked, agentMode: "real" },
            { ...commands.mocked, agentModels: { route: { model: DECISION_OVERRIDE } } },
            { ...commands.mocked, definitionHash: "0" },
        ]) {
            await expect(startWorkflowTest(f.host, mockedId, changed, context(operations.mocked)))
                .rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        }
        for (const changed of [
            { ...commands.real, agentModels: { ask: { model: "chat:other" } } },
            { ...commands.real, agentMode: "mocked" },
            { ...commands.real, expectedRevision: 2 },
        ]) {
            await expect(startWorkflowTest(f.host, realId, changed, context(operations.real)))
                .rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        }
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
