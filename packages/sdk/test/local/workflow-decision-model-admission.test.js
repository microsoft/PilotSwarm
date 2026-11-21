/** Real save/run rows, recording dispatch only: no controller, claim on refusal, or provider execution. */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { AGENT_OVERRIDE, AVAILABLE_DECISION, DECISION_DEFAULT, DECISION_OVERRIDE, FIXTURE_AGENT, STALE_DECISION, UNSET_DECISION,
    agentWorkflowYaml, decisionWorkflowYaml, effectiveDecisionModels } from "../helpers/workflow-decision-models.js";
import { workflowAgentToolOffer } from "../../src/workflow/agent-tools.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { workflowAgentModelsText } from "../../src/workflow/agent-models.ts";
import { canonicalJson, jsonSha256 } from "../../src/workflow/json.ts";
import { applyWorkflowUpdate, createWorkflow, startWorkflowTest } from "../../src/workflow/service.ts";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition, workflowStartOperationId,
    workflowStartSessionId } from "../../src/workflow/session-definitions.ts";
import { startSessionWorkflowTest } from "../../src/workflow/definition-test.ts";
import { workflowDefinitionFromTool } from "../../src/workflow/definition-tool.ts";
import { parseUpdateWorkflowArgs } from "../../src/workflow/tools.ts";
import { workflowRunCommandArgs, workflowRunCommandWire } from "../../../app/ui/core/src/workflow-commands.js";

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
        const claims = [], createdClaims = [], dispatched = [], agentChecks = [], resolutions = [], snapshots = [], ownerReads = [];
        let capabilityReads = 0;
        let loseDispatch = false;
        const catalog = new Proxy(h.catalog, { get(target, name) {
            if (name === "createWorkflowSession") return async (...args) => {
                claims.push(args[0]);
                const claim = await target.createWorkflowSession(...args);
                if (claim.created) createdClaims.push(args[0]);
                return claim;
            };
            if (name === "getSession") return async id => { ownerReads.push(id); return target.getSession(id); };
            return typeof target[name] === "function" ? target[name].bind(target) : target[name];
        } });
        const host = { catalog, store: h.store, duroxideClient: {
            startOrchestrationVersioned: async id => {
                dispatched.push(id);
                if (loseDispatch) { loseDispatch = false; throw new Error("dispatch lost"); }
            },
            getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {},
        }, checkAgentModel: async (choice, owner) => {
            agentChecks.push({ choice, owner });
            return choice.model === AGENT_OVERRIDE ? null : "not in the owning session's chat catalog";
        }, resolveAgent: async name => {
            resolutions.push(name);
            return { name };
        }, describeAgentTools: async (node, binding, _caller, agent) => {
            const offer = workflowAgentToolOffer(node, binding, [], [], {}, agent);
            if (binding?.agentStepTools !== "selections") return offer;
            const snapshot = binding.agentStepBindings?.[node.id] ?? {
                capabilities: binding.capabilities, tools: [], sourceRevisions: {},
            };
            snapshots.push({ node: node.id, agent: agent?.name });
            return { ...offer, binding: snapshot };
        } };
        // Fresh eligibility and the immutable provider incarnation are separate reads on a live Start.
        if (options.capabilityHost !== false) host.decisionCapability = async () => { capabilityReads++; return structuredClone(current); };
        host.resolveDecisionProviderBindings = async models => Object.fromEntries(models.map(model => {
            const separator = model.indexOf(":");
            return [model, current.models.includes(model) && separator > 0 ? {
                providerInstanceId: "00000000-0000-4000-8000-000000000001",
                providerName: model.slice(0, separator),
                providerTypeId: "decision-test-type",
                modelQualified: model,
            } : null];
        }));
        const f = {
            h, host, session, claims, createdClaims, dispatched, agentChecks, resolutions, snapshots, ownerReads,
            loseNextDispatch: () => { loseDispatch = true; },
            setCapability: value => { current = structuredClone(value); },
            admissionReads: () => ({ capability: capabilityReads, catalog: agentChecks.length, resolver: resolutions.length, snapshots: snapshots.length }),
            binding: { policy: "node-parent-tools-v1", parentSessionId: session, owner: OWNER, config: {},
                capabilities: { revision: 1, selections: [] }, tools: [], sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "fixture" },
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
    return { ...row, claims: f.claims.length, createdClaims: f.createdClaims.length, dispatched: f.dispatched.length };
}

function countLiveAdmissionWrites(f) {
    const writes = [];
    f.host.store = new Proxy(f.h.store, { get(target, name) {
        if (name === "publish" || name === "startLive" || name === "invalidateDraftRevision") {
            return async (...args) => { writes.push(name); return target[name](...args); };
        }
        return typeof target[name] === "function" ? target[name].bind(target) : target[name];
    } });
    return writes;
}

async function setReceiptDigest(f, workflowId, operationId, kind, digest) {
    expect(await f.h.q(`UPDATE SCHEMA.workflow_operations SET request_sha256 = $4
        WHERE workflow_session_id = $1 AND operation_id = $2 AND kind = $3 RETURNING request_sha256`,
    [workflowId, operationId, kind, digest])).toEqual([{ request_sha256: digest }]);
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
    if (Object.keys(decisions).length) {
        expect(started.decisionModels).toEqual(decisions);
        const bindings = JSON.parse(run.decisionProviderBindings);
        for (const [stateId, choice] of Object.entries(decisions)) {
            expect(bindings[stateId]).toEqual({
                providerInstanceId: "00000000-0000-4000-8000-000000000001",
                providerName: choice.model.slice(0, choice.model.indexOf(":")),
                providerTypeId: "decision-test-type",
                modelQualified: choice.model,
            });
        }
    } else {
        expect(Object.hasOwn(started, "decisionModels")).toBe(false);
        expect(run.decisionProviderBindings).toBeNull();
    }
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
            expect(await footprint(f)).toEqual({ sessions: 0, definitions: 0, runs: 0, claims: 0, createdClaims: 0, dispatched: 0 });
        }));
    }

    it("an eligible available default saves valid without materializing a run or changing structural IR", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const yaml = decisionWorkflowYaml();
        const compiled = compileWorkflow(yaml);
        const saved = await f.save(yaml);
        expect(saved.valid).toBe(true);
        expect(saved.diagnostics.some(item => item.code === UNAVAILABLE)).toBe(false);
        expect(await f.h.store.sessionDefinitions.readRevisionIr(saved.definitionId, 1)).toEqual(compiled.ir);
        expect(await footprint(f)).toEqual({ sessions: 0, definitions: 0, runs: 0, claims: 0, createdClaims: 0, dispatched: 0 });
    }));

    it("a Start-only override in either alias cannot rescue an unavailable save", { timeout: TIMEOUT }, () => withHost({ capability: UNSET_DECISION }, async f => {
        for (const alias of ["agent_models", "decision_models"]) {
            const name = `save-${alias}`;
            const answer = await f.tool({ operation: "save", name, yaml: decisionWorkflowYaml(name), [alias]: { route: { model: DECISION_OVERRIDE } } });
            expect(answer).toMatchObject({ ok: true, valid: false, errors: [{ code: UNAVAILABLE, path: "states.route.type" }] });
        }
        expect(await footprint(f)).toEqual({ sessions: 0, definitions: 0, runs: 0, claims: 0, createdClaims: 0, dispatched: 0 });
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
                const reads = f.admissionReads().capability;
                const replay = await createWorkflow(f.host, request);
                expect(replay).toMatchObject({ replayed: true, receipt: created.receipt });
                expect(f.admissionReads().capability).toBe(reads, "an admitted creation replay must not consult the changed catalog");
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

describe("Decision capability reader failures", () => {
    it("a failed save read leaves the session definition and revisions unchanged", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const first = await f.save();
        const definitionBefore = await f.h.store.sessionDefinitions.readDefinition(first.definitionId);
        const revisionsBefore = await f.h.store.sessionDefinitions.listRevisions(first.definitionId);
        f.host.decisionCapability = async () => { throw new Error("provider catalog read failed"); };
        await expect(f.save(`${decisionWorkflowYaml()}\n# attempted revision two`, "decision-models", {
            expected: { definitionId: first.definitionId, revision: first.revision },
        })).rejects.toMatchObject({ code: "WORKFLOW_DECISION_CAPABILITY_UNREADABLE", details: { retryable: true } });
        expect(await f.h.store.sessionDefinitions.readDefinition(first.definitionId)).toEqual(definitionBefore);
        expect(await f.h.store.sessionDefinitions.listRevisions(first.definitionId)).toEqual(revisionsBefore);
        expect(await f.h.store.sessionDefinitions.readRevision(first.definitionId, 2)).toBeNull();
    }));

    it("a failed publish read neither invalidates diagnostics nor mutates the draft", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const cases = [];
        for (const operation of ["publish", "publish_and_start"]) {
            const workflowSessionId = randomUUID();
            const { receipt } = await createWorkflow(f.host, { workflowSessionId, parentSessionId: f.session, owner: OWNER,
                yaml: decisionWorkflowYaml(`read-failure-${operation}`), actor: ACTOR, operationId: `save-${operation}` });
            cases.push({ operation, workflowSessionId, receipt,
                definition: await f.h.store.readDefinition(workflowSessionId), revision: await f.h.store.readRevision(workflowSessionId, 1) });
        }
        const writes = countLiveAdmissionWrites(f);
        f.host.decisionCapability = async () => { throw new Error("provider catalog read failed"); };
        const before = await footprint(f);
        for (const item of cases) {
            const command = item.operation === "publish"
                ? { operation: item.operation, expectedRevision: 1, definitionHash: item.receipt.yamlSha256 }
                : { operation: item.operation, expectedRevision: 1, definitionHash: item.receipt.yamlSha256, inputs: {} };
            await expect(applyWorkflowUpdate(f.host, item.workflowSessionId, command,
                { actor: ACTOR, operationId: `attempt-${item.operation}` }))
                .rejects.toMatchObject({ code: "WORKFLOW_DECISION_CAPABILITY_UNREADABLE", details: { retryable: true } });
            expect(await f.h.store.readDefinition(item.workflowSessionId)).toEqual(item.definition);
            expect(await f.h.store.readRevision(item.workflowSessionId, 1)).toEqual(item.revision);
        }
        expect(writes).toEqual([]);
        expect(await footprint(f)).toEqual(before);
    }));
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

    it("Start refuses if the current shared provider incarnation cannot be pinned", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save();
        f.host.resolveDecisionProviderBindings = async models => Object.fromEntries(models.map(model => [model, null]));
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
    it("a keyed Decision+Agent Start replays the original receipt and tool snapshot without readmission", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save(decisionWorkflowYaml("decision-models", { full: true, namedAgent: true }));
        const agentModels = { ask: { model: AGENT_OVERRIDE } };
        const request = { key: "admitted", agentModels };
        const readsBeforeFresh = f.admissionReads();
        const first = await f.start(saved.definitionId, { ...request, binding: f.binding });
        const effective = { ...effectiveDecisionModels(DECISION_DEFAULT, { full: true }), ...agentModels };
        await storedModels(f, first, effective);
        const config = await f.host.catalog.getSessionCreationConfig(first.workflowId);
        expect(config.workflowToolBinding.agentStepBindings.ask).toMatchObject({ capabilities: f.binding.capabilities });
        expect(f.resolutions.slice(readsBeforeFresh.resolver)).toContain(FIXTURE_AGENT);
        expect(f.snapshots.slice(readsBeforeFresh.snapshots)).toContainEqual({ node: "ask", agent: FIXTURE_AGENT });
        expect(f.admissionReads().capability).toBeGreaterThan(readsBeforeFresh.capability);
        expect(f.admissionReads().catalog).toBeGreaterThan(readsBeforeFresh.catalog);

        f.setCapability({ ...AVAILABLE_DECISION, defaultModel: DECISION_OVERRIDE });
        const control = await f.start(saved.definitionId, { ...request, key: "fresh-after-default-change", binding: f.binding });
        await storedModels(f, control, { ...effectiveDecisionModels(DECISION_OVERRIDE, { full: true }), ...agentModels });
        const before = await footprint(f);
        const reads = f.admissionReads();
        let captures = 0;
        const replayRequest = { ...request, binding: async () => { captures++; return f.binding; } };
        await storedModels(f, await f.start(saved.definitionId, replayRequest), effective);
        f.setCapability(UNSET_DECISION);
        const replay = await f.start(saved.definitionId, replayRequest);
        expect(replay).toMatchObject({ workflowId: first.workflowId, runId: first.runId, revision: 1, replayed: true });
        await storedModels(f, replay, effective);
        for (const change of [{ inputs: { changed: true } }, { vars: { changed: true } }, { revision: 2 },
            { decisionModels: { route: { model: DECISION_DEFAULT } } }]) {
            await expect(f.start(saved.definitionId, { ...replayRequest, ...change })).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        }
        expect(captures).toBe(0);
        expect(f.admissionReads()).toEqual(reads);
        expect(await f.host.catalog.getSessionCreationConfig(first.workflowId)).toEqual(config);
        expect(await footprint(f)).toEqual({ ...before, dispatched: before.dispatched + 2 });
        await refusedBeforeCreation(f, () => f.start(saved.definitionId, { ...request, key: "new-while-revoked" }));
    }));

    it("a keyed Start interrupted after storing the Decision+Agent binding resumes its claim", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save(decisionWorkflowYaml("decision-models", { full: true, namedAgent: true }));
        const key = "interrupted-with-snapshot", agentModels = { ask: { model: AGENT_OVERRIDE } };
        const workflowId = workflowStartSessionId(f.session, "interrupted", key);
        const beforeFresh = f.admissionReads();
        f.host.store = new Proxy(f.h.store, { get(target, name) {
            if (name === "createDefinition") return async () => { throw new Error("interrupted after claim"); };
            return typeof target[name] === "function" ? target[name].bind(target) : target[name];
        } });
        try {
            await expect(f.start(saved.definitionId, { key, agentModels, binding: f.binding })).rejects.toThrow("interrupted after claim");
        } finally { f.host.store = f.h.store; }
        expect(await f.h.store.readDefinition(workflowId)).toBeNull();
        const config = await f.host.catalog.getSessionCreationConfig(workflowId);
        expect(config.workflowToolBinding.agentStepBindings.ask).toBeDefined();
        expect(f.resolutions.slice(beforeFresh.resolver)).toContain(FIXTURE_AGENT);
        expect(f.snapshots.slice(beforeFresh.snapshots)).toContainEqual({ node: "ask", agent: FIXTURE_AGENT });
        expect(f.admissionReads().capability).toBeGreaterThan(beforeFresh.capability);
        expect(f.admissionReads().catalog).toBeGreaterThan(beforeFresh.catalog);
        let captures = 0;
        const request = { key, agentModels, binding: async () => { captures++; throw new Error("do not recapture"); } };
        const resumed = await f.start(saved.definitionId, request);
        expect(resumed).toMatchObject({ workflowId, revision: 1, replayed: false });
        expect(await f.host.catalog.getSessionCreationConfig(workflowId)).toEqual(config);
        expect(await f.h.store.listRuns(workflowId)).toHaveLength(1);
        expect(f.dispatched).toHaveLength(1);
        const before = await footprint(f), reads = f.admissionReads();
        f.setCapability(UNSET_DECISION);
        expect(await f.start(saved.definitionId, request)).toMatchObject({ workflowId, runId: resumed.runId, replayed: true });
        expect(captures).toBe(0);
        expect(f.admissionReads()).toEqual(reads);
        expect(await footprint(f)).toEqual({ ...before, dispatched: before.dispatched + 1 });
    }));

    it("an admitted keyed Decision Run again retains its receipt after both Workflows are deleted", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save();
        const earlier = await f.start(saved.definitionId);
        const request = { key: "historical-run-again", runAgainOf: earlier.workflowId };
        const first = await f.start(saved.definitionId, request);
        await f.host.catalog.softDeleteSession(earlier.workflowId);
        await f.host.catalog.softDeleteSession(first.workflowId);
        f.setCapability(UNSET_DECISION);
        const before = await footprint(f), reads = f.admissionReads();
        expect(await f.start(saved.definitionId, request)).toMatchObject({ workflowId: first.workflowId, runId: first.runId, replayed: true });
        await expect(f.start(saved.definitionId, { ...request, runAgainOf: undefined })).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        expect(f.admissionReads()).toEqual(reads);
        expect(await footprint(f)).toEqual(before, "deleted workflows keep the receipt without dispatching their ended runs");
    }));

    it("keyed Decision replays bind the presence and source of Run again even with explicit models", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save();
        const source = await f.start(saved.definitionId);
        const other = await f.start(saved.definitionId);
        const decisionModels = { route: { model: DECISION_OVERRIDE } };
        const withSource = { key: "explicit-with-source", decisionModels, runAgainOf: source.workflowId };
        const withoutSource = { key: "explicit-without-source", decisionModels };
        const first = await f.start(saved.definitionId, withSource);
        const second = await f.start(saved.definitionId, withoutSource);
        const reads = f.admissionReads(), before = await footprint(f);
        f.setCapability(UNSET_DECISION);

        expect(await f.start(saved.definitionId, withSource)).toMatchObject({ runId: first.runId, replayed: true });
        expect(await f.start(saved.definitionId, { ...withoutSource, runAgainOf: null })).toMatchObject({ runId: second.runId, replayed: true });
        for (const changed of [{ ...withSource, runAgainOf: undefined }, { ...withSource, runAgainOf: other.workflowId },
            { ...withoutSource, runAgainOf: source.workflowId }]) {
            await expect(f.start(saved.definitionId, changed)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        }
        expect(f.admissionReads()).toEqual(reads);
        expect(await footprint(f)).toEqual({ ...before, dispatched: before.dispatched + 2 });
    }));

    it.each(["default", "inherited", "explicit"])("2f68 session Start receipt fails closed: %s intent", { timeout: TIMEOUT }, mode => withHost({}, async f => {
        const yaml = decisionWorkflowYaml("legacy-session", { full: true, namedAgent: true });
        const saved = await f.save(yaml, "legacy-session");
        const source = await f.start(saved.definitionId, { decisionModels: { route: { model: DECISION_OVERRIDE } } });
        const request = { operationId: "legacy-session-start", binding: f.binding, inputs: {}, vars: { phase: 1 },
            ...(mode === "default" ? { key: "legacy-default" } : { runAgainOf: source.workflowId }),
            ...(mode === "explicit" ? { key: "legacy-explicit", decisionModels: { route: { model: DECISION_OVERRIDE } } } : {}) };
        const first = await f.start(saved.definitionId, request);
        const run = await f.h.store.readRun(first.runId);
        const { workflowToolBinding } = await f.h.catalog.getSessionCreationConfig(first.workflowId);
        expect(workflowToolBinding.agentStepBindings.ask).toBeDefined();
        const oldIntent = mode === "explicit" ? { explicit: true, models: request.decisionModels }
            : mode === "inherited" ? { runAgainOf: source.workflowId } : { default: true };
        const legacyDigest = jsonSha256({
            kind: "create", yamlSha256: run.yamlSha256, publish: true, start: {
                inputs: request.inputs, vars: canonicalJson(request.vars), agentModels: run.agentModels, modelRequest: jsonSha256(oldIntent),
            },
            parentSessionId: f.session, notifyParent: true, owner: OWNER, binding: jsonSha256(workflowToolBinding),
        });
        const operationId = `start:${workflowStartOperationId(request.operationId, request.key)}`;
        await setReceiptDigest(f, first.workflowId, operationId, "create", legacyDigest);

        const before = await footprint(f), reads = f.admissionReads();
        f.setCapability(UNSET_DECISION);
        await expect(f.start(saved.definitionId, request)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        for (const changed of [
            { inputs: { changed: true } }, { vars: { phase: 2 } }, { notifyParent: false },
            { runAgainOf: mode === "default" ? source.workflowId : undefined },
            { decisionModels: first.decisionModels },
            ...(mode === "inherited" ? [{ binding: { ...f.binding, boundAgentFingerprint: "different grant" } }] : []),
        ]) {
            await expect(f.start(saved.definitionId, { ...request, ...changed })).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        }
        const different = { ...first.agentModels, route: { model: mode === "default" ? DECISION_OVERRIDE : DECISION_DEFAULT } };
        await f.h.q("UPDATE SCHEMA.workflow_runs SET agent_models = $2 WHERE run_id = $1", [run.runId, workflowAgentModelsText(different)]);
        await expect(f.start(saved.definitionId, request)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        await setReceiptDigest(f, first.workflowId, operationId, "create", "f".repeat(64));
        await expect(f.start(saved.definitionId, request)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        expect(f.admissionReads()).toEqual(reads);
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
    it("checks the original session pin even when an atomic Decision receipt exists", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const yaml = decisionWorkflowYaml();
        const saved = await f.save(yaml);
        const request = { workflowSessionId: randomUUID(), parentSessionId: f.session, owner: OWNER, yaml, actor: ACTOR,
            operationId: randomUUID(), start: { inputs: {}, agentModels: { route: { model: DECISION_DEFAULT } } },
            sessionPin: { ownerSessionId: f.session, definitionId: saved.definitionId, revision: 1 } };
        const first = await createWorkflow(f.host, request);
        f.setCapability(UNSET_DECISION);
        const before = await footprint(f), reads = f.admissionReads();
        expect(await createWorkflow(f.host, request)).toMatchObject({ replayed: true, receipt: first.receipt });
        for (const sessionPin of [undefined, { ...request.sessionPin, revision: 2 },
            { ...request.sessionPin, definitionId: randomUUID() }, { ...request.sessionPin, ownerSessionId: randomUUID() }]) {
            await expect(createWorkflow(f.host, { ...request, sessionPin })).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
        }
        await expect(createWorkflow(f.host, { ...request, start: { inputs: {},
            agentModels: { route: { model: DECISION_DEFAULT, contextTier: null } } } }))
            .rejects.toMatchObject({ code: "AGENT_MODELS_INVALID" });
        expect(f.admissionReads()).toEqual(reads);
        expect(await footprint(f)).toEqual({ ...before, dispatched: before.dispatched + 1 });
    }));

    it("a Decision test receipt survives invalidation of the exact draft it tested", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const id = randomUUID();
        const { receipt: draft } = await createWorkflow(f.host, { workflowSessionId: id, parentSessionId: f.session,
            yaml: decisionWorkflowYaml(), actor: ACTOR, operationId: randomUUID() });
        const command = { expectedRevision: draft.revision, definitionHash: draft.yamlSha256, inputs: {}, agentMode: "mocked", fixtures: [] };
        const context = { actor: ACTOR, operationId: randomUUID() };
        const first = await startWorkflowTest(f.host, id, command, context);
        f.setCapability(UNSET_DECISION);
        await expect(applyWorkflowUpdate(f.host, id, { operation: "publish", expectedRevision: draft.revision,
            definitionHash: draft.yamlSha256 }, { actor: ACTOR, operationId: randomUUID() })).rejects.toMatchObject({ code: UNAVAILABLE });
        expect(await f.h.store.readRevision(id, draft.revision)).toMatchObject({ valid: false, irSha256: null });
        const before = await footprint(f), reads = f.admissionReads();
        expect(await startWorkflowTest(f.host, id, command, context)).toMatchObject({ replayed: true, receipt: first.receipt });
        await expect(startWorkflowTest(f.host, id, { ...command, inputs: { changed: true } }, context))
            .rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        await refusedBeforeCreation(f, () => startWorkflowTest(f.host, id, command, { ...context, operationId: randomUUID() }), "DEFINITION_INVALID");
        expect(f.admissionReads()).toEqual(reads);
        expect(await footprint(f)).toEqual({ ...before, dispatched: before.dispatched + 1 });
    }));

    it("a Decision start receipt survives workflow deletion, but a new start still fails", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const id = randomUUID();
        const { receipt: created } = await createWorkflow(f.host, { workflowSessionId: id, parentSessionId: f.session,
            yaml: decisionWorkflowYaml(), actor: ACTOR, operationId: randomUUID(), publish: true });
        const command = { operation: "start", definitionHash: created.yamlSha256, inputs: {} };
        const context = { actor: ACTOR, operationId: randomUUID() };
        const first = await applyWorkflowUpdate(f.host, id, command, context);
        await f.host.catalog.softDeleteSession(id);
        expect((await f.h.store.readDefinition(id)).state).toBe("deleted");
        const before = await footprint(f), reads = f.admissionReads();
        f.setCapability(UNSET_DECISION);
        expect(await applyWorkflowUpdate(f.host, id, command, context)).toMatchObject({ replayed: true, receipt: first.receipt });
        await refusedBeforeCreation(f, () => applyWorkflowUpdate(f.host, id, command, { ...context, operationId: randomUUID() }), "WORKFLOW_DELETED");
        expect(await footprint(f)).toEqual(before, "a deleted workflow keeps its receipt without dispatching an ended run");
        expect(f.admissionReads()).toEqual(reads);
    }));

    it("a malformed fresh publish_and_start leaves a valid draft alone even when Decision capability is unavailable", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const id = randomUUID();
        const { receipt: draft } = await createWorkflow(f.host, { workflowSessionId: id, parentSessionId: f.session,
            yaml: decisionWorkflowYaml(), actor: ACTOR, operationId: randomUUID() });
        f.setCapability(UNSET_DECISION);
        await refusedBeforeCreation(f, () => applyWorkflowUpdate(f.host, id, { operation: "publish_and_start", expectedRevision: draft.revision,
            definitionHash: draft.yamlSha256, inputs: {}, agentModels: ["invalid"] }, { actor: ACTOR, operationId: randomUUID() }), "AGENT_MODELS_INVALID");
        expect(await f.h.store.readRevision(id, draft.revision)).toMatchObject({ valid: true, irSha256: draft.irSha256 });
    }));

    it("a serialized update_workflow Decision alias reaches the parser and live admission", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const id = randomUUID();
        const { receipt: draft } = await createWorkflow(f.host, { workflowSessionId: id, parentSessionId: f.session,
            yaml: decisionWorkflowYaml(), actor: ACTOR, operationId: randomUUID() });
        const decisionModels = { route: { model: DECISION_OVERRIDE } };
        const checked = workflowRunCommandArgs("publish_and_start", {
            expectedRevision: draft.revision, definitionHash: draft.yamlSha256, inputs: {}, decisionModels,
        });
        expect(checked.ok).toBe(true);
        const operationId = randomUUID();
        const wire = workflowRunCommandWire("publish_and_start", null, operationId, checked.args);
        expect(wire.decision_models).toEqual(decisionModels);
        const parsed = parseUpdateWorkflowArgs({ workflow_id: id, ...wire }, { milestone: true, testing: true });
        expect(parsed.command).toMatchObject({ operation: "publish_and_start", decisionModels });
        const started = await applyWorkflowUpdate(f.host, id, parsed.command, { actor: ACTOR, operationId: parsed.operationId });
        expect((await f.h.store.readRun(started.receipt.run.runId)).agentModels)
            .toBe(workflowAgentModelsText(decisionModels));
    }));

    it("atomic create and Start replays the original effective map before any fresh admission", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const workflowSessionId = randomUUID();
        const operationId = randomUUID();
        const yaml = decisionWorkflowYaml("atomic-replay", { full: true, namedAgent: true });
        const request = {
            workflowSessionId, parentSessionId: f.session, owner: OWNER, yaml, actor: ACTOR, operationId,
            publish: true, start: { inputs: {}, vars: { revision: 1 }, agentModels: { ask: { model: AGENT_OVERRIDE } } },
        };
        const freshReads = f.admissionReads();
        const first = await createWorkflow(f.host, request);
        expect(first.replayed).toBe(false);
        const effective = { ...effectiveDecisionModels(DECISION_DEFAULT, { full: true }), ask: { model: AGENT_OVERRIDE } };
        expect((await f.h.store.readRun(first.receipt.run.runId)).agentModels).toBe(workflowAgentModelsText(effective));
        expect(f.resolutions.slice(freshReads.resolver)).toContain(FIXTURE_AGENT);
        expect(f.admissionReads().capability).toBeGreaterThan(freshReads.capability);
        expect(f.admissionReads().catalog).toBeGreaterThan(freshReads.catalog);
        const before = await footprint(f), reads = f.admissionReads();

        f.setCapability({ ...AVAILABLE_DECISION, defaultModel: DECISION_OVERRIDE });
        expect(await createWorkflow(f.host, request)).toMatchObject({ replayed: true, receipt: first.receipt });
        f.setCapability(UNSET_DECISION);
        expect(await createWorkflow(f.host, request)).toMatchObject({ replayed: true, receipt: first.receipt });

        for (const changed of [
            { ...request, yaml: `${yaml}\n# another source\n` },
            { ...request, start: { ...request.start, inputs: { changed: true } } },
            { ...request, start: { ...request.start, vars: { revision: 2 } } },
            { ...request, start: { ...request.start, agentModels: { ask: { model: "chat:other" } } } },
            { ...request, notifyParent: false },
        ]) {
            await expect(createWorkflow(f.host, changed)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        }
        expect(f.admissionReads()).toEqual(reads);
        expect(await footprint(f)).toEqual({ ...before, dispatched: before.dispatched + 2 });
    }));

    it("publish_and_start and published start replay their receipts with the original Decision intent", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const makeDraft = async name => {
            const id = randomUUID();
            const created = await createWorkflow(f.host, {
                workflowSessionId: id, parentSessionId: f.session, owner: OWNER, yaml: decisionWorkflowYaml(name, { full: true, namedAgent: true }),
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
        const freshReads = f.admissionReads();
        const writes = countLiveAdmissionWrites(f);
        const ownersBeforeFresh = f.ownerReads.length;
        const togetherFirst = await applyWorkflowUpdate(f.host, together.id, togetherCommand, { actor: ACTOR, operationId: togetherOperation });
        const startFirst = await applyWorkflowUpdate(f.host, separated.id, startCommand, { actor: ACTOR, operationId: startOperation });
        expect(writes).toEqual(["publish", "startLive"]);
        expect(f.ownerReads.length).toBeGreaterThan(ownersBeforeFresh);
        expect(f.resolutions.slice(freshReads.resolver)).toContain(FIXTURE_AGENT);
        expect(f.admissionReads().capability).toBeGreaterThan(freshReads.capability);
        expect(f.admissionReads().catalog).toBeGreaterThan(freshReads.catalog);
        const before = await footprint(f), reads = f.admissionReads();
        const owners = f.ownerReads.length, writesAfterFresh = writes.length;
        const assertNoAdmission = async () => {
            expect(f.admissionReads()).toEqual(reads);
            expect(f.ownerReads).toHaveLength(owners);
            expect(writes).toHaveLength(writesAfterFresh);
            expect(await footprint(f)).toEqual({ ...before, dispatched: before.dispatched + 4 });
        };
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
        expect(await applyWorkflowUpdate(f.host, together.id, togetherCommand, { actor: ACTOR, operationId: togetherOperation }))
            .toMatchObject({ replayed: true, receipt: togetherFirst.receipt });
        expect(await applyWorkflowUpdate(f.host, separated.id, startCommand, { actor: ACTOR, operationId: startOperation }))
            .toMatchObject({ replayed: true, receipt: startFirst.receipt });
        await assertNoAdmission();

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
        await assertNoAdmission();
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
        await assertNoAdmission();
    }));

    it.each(["publish_and_start", "start"])("Agent-only %s replays only the admitted dispatch", { timeout: TIMEOUT }, operation => withHost({}, async f => {
        const id = randomUUID();
        const { receipt: saved } = await createWorkflow(f.host, { workflowSessionId: id, parentSessionId: f.session, owner: OWNER,
            yaml: agentWorkflowYaml("agent-only-replay"), publish: operation === "start", actor: ACTOR, operationId: "save" });
        const command = { operation, definitionHash: saved.yamlSha256, inputs: {}, agentModels: { ask: { model: AGENT_OVERRIDE } },
            ...(operation === "publish_and_start" ? { expectedRevision: 1 } : {}) };
        const context = { actor: ACTOR, operationId: "agent-only-start" };
        const writes = countLiveAdmissionWrites(f);
        const { receipt } = await applyWorkflowUpdate(f.host, id, command, context);
        expect(writes).toEqual([operation === "start" ? "startLive" : "publish"]);
        expect(f.ownerReads).toContain(id);
        expect(f.agentChecks).toMatchObject([{ choice: command.agentModels.ask, owner: OWNER }]);
        const reads = f.admissionReads(), before = await footprint(f), owners = f.ownerReads.slice();
        const noCatalog = { ...f.host, checkAgentModel: undefined };
        expect(await applyWorkflowUpdate(noCatalog, id, command, context)).toEqual({ receipt, replayed: true });
        await expect(applyWorkflowUpdate(noCatalog, id, { ...command, inputs: { changed: true } }, context))
            .rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        expect(f.admissionReads()).toEqual(reads);
        expect(f.ownerReads).toEqual(owners);
        expect(writes).toHaveLength(1);
        expect(await footprint(f)).toEqual({ ...before, dispatched: before.dispatched + 1 });
        expect(f.dispatched.slice(-2)).toEqual([receipt.run.controllerInstanceId, receipt.run.controllerInstanceId]);
    }));

    it("an exact Agent-only publish answers its receipt after the Workflow is deleted", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const id = randomUUID();
        const { receipt: saved } = await createWorkflow(f.host, { workflowSessionId: id, parentSessionId: f.session, owner: OWNER,
            yaml: agentWorkflowYaml("deleted-publication"), actor: ACTOR, operationId: "save" });
        const command = { operation: "publish", expectedRevision: 1, definitionHash: saved.yamlSha256 };
        const context = { actor: ACTOR, operationId: "publish" };
        const { receipt } = await applyWorkflowUpdate(f.host, id, command, context);
        await f.host.catalog.softDeleteSession(id);
        expect((await f.h.store.readDefinition(id)).state).toBe("deleted");
        const writes = countLiveAdmissionWrites(f);
        const reads = f.admissionReads(), before = await footprint(f);
        expect(await applyWorkflowUpdate(f.host, id, command, context)).toEqual({ receipt, replayed: true });
        await expect(applyWorkflowUpdate(f.host, id, { ...command, definitionHash: "0" }, context))
            .rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        await expect(applyWorkflowUpdate(f.host, id, command, { ...context, operationId: "fresh-publish" }))
            .rejects.toMatchObject({ code: "WORKFLOW_DELETED" });
        expect(writes).toEqual([]);
        expect(f.admissionReads()).toEqual(reads);
        expect(await footprint(f)).toEqual(before);
    }));

    it("2f68 effective-only Decision start receipts cannot prove exact model intent", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const id = randomUUID(), control = randomUUID();
        const make = workflowSessionId => createWorkflow(f.host, { workflowSessionId, parentSessionId: f.session, owner: OWNER,
            yaml: decisionWorkflowYaml("legacy-live"), publish: true, actor: ACTOR, operationId: "save" });
        const { receipt: saved } = await make(id);
        await make(control);
        const command = { operation: "start", definitionHash: saved.yamlSha256, inputs: {} };
        const context = { actor: ACTOR, operationId: "legacy-effective-only" };
        const { receipt } = await applyWorkflowUpdate(f.host, id, command, context);
        const explicit = { route: { model: DECISION_DEFAULT } };
        const { receipt: explicitReceipt } = await applyWorkflowUpdate(f.host, control, { ...command, agentModels: explicit }, context);
        const run = await f.h.store.readRun(receipt.run.runId);
        expect(run.agentModels).toBe(workflowAgentModelsText(explicit));
        expect((await f.h.store.readRun(explicitReceipt.run.runId)).agentModels).toBe(run.agentModels);
        await setReceiptDigest(f, id, context.operationId, "start", jsonSha256({
            kind: "start", definitionHash: saved.yamlSha256, inputs: canonicalJson(command.inputs), agentModels: run.agentModels,
        }));
        const before = await footprint(f), reads = f.admissionReads();
        f.setCapability(UNSET_DECISION);
        // An omitted map and an explicit map naming the old default produced the exact same 2f68 bytes.
        for (const models of [undefined, explicit]) {
            await expect(applyWorkflowUpdate(f.host, id, { ...command, agentModels: models }, context))
                .rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
        }
        expect(f.admissionReads()).toEqual(reads);
        expect(await footprint(f)).toEqual(before);
    }));

    it("mocked and real direct tests replay without admission work and retry the stable controller", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const mockedId = randomUUID();
        const realId = randomUUID();
        const mocked = await createWorkflow(f.host, {
            workflowSessionId: mockedId, parentSessionId: f.session, owner: OWNER, yaml: decisionWorkflowYaml("mocked-test-replay"),
            actor: ACTOR, operationId: randomUUID(),
        });
        const real = await createWorkflow(f.host, {
            workflowSessionId: realId, parentSessionId: f.session, owner: OWNER, yaml: decisionWorkflowYaml("real-test-replay", { full: true, namedAgent: true }),
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
        const freshReads = f.admissionReads();
        const first = {
            mocked: await startWorkflowTest(f.host, mockedId, commands.mocked, context(operations.mocked)),
            real: await startWorkflowTest(f.host, realId, commands.real, context(operations.real)),
        };
        expect((await f.h.store.readRun(first.mocked.receipt.run.runId)).agentModels).toBe(workflowAgentModelsText(effectiveDecisionModels()));
        expect((await f.h.store.readRun(first.real.receipt.run.runId)).agentModels).toBe(workflowAgentModelsText({
            ...effectiveDecisionModels(DECISION_DEFAULT, { full: true }), ask: { model: AGENT_OVERRIDE },
        }));
        expect(f.resolutions.slice(freshReads.resolver)).toContain(FIXTURE_AGENT);
        expect(f.admissionReads().capability).toBeGreaterThan(freshReads.capability);
        expect(f.admissionReads().catalog).toBeGreaterThan(freshReads.catalog);
        const before = await footprint(f), reads = f.admissionReads();

        f.setCapability({ ...AVAILABLE_DECISION, defaultModel: DECISION_OVERRIDE });
        expect(await startWorkflowTest(f.host, mockedId, commands.mocked, context(operations.mocked)))
            .toMatchObject({ replayed: true, receipt: first.mocked.receipt });
        expect(await startWorkflowTest(f.host, realId, commands.real, context(operations.real)))
            .toMatchObject({ replayed: true, receipt: first.real.receipt });
        f.setCapability(UNSET_DECISION);
        expect(await startWorkflowTest(f.host, mockedId, commands.mocked, context(operations.mocked)))
            .toMatchObject({ replayed: true, receipt: first.mocked.receipt });
        expect(await startWorkflowTest(f.host, realId, commands.real, context(operations.real)))
            .toMatchObject({ replayed: true, receipt: first.real.receipt });

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
        expect(f.admissionReads()).toEqual(reads);
        expect(await footprint(f)).toEqual({ ...before, dispatched: before.dispatched + 4 });
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

describe("session test claim and admission are separate", () => {
    function testRequest(f, definitionId, extra = {}) {
        return { ownerSessionId: f.session, definition: { definitionId }, operationId: randomUUID(), actor: ACTOR,
            inputs: {}, fixtures: [], expect: "done", owner: async () => OWNER, binding: async () => null, ...extra };
    }

    it("refuses malformed test input before making a bench claim", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const yaml = decisionWorkflowYaml() + "\ninputs:\n  schema: { type: object, required: [ticket], properties: { ticket: { type: string } } }\n";
        const saved = await f.save(yaml);
        const request = testRequest(f, saved.definitionId);
        await refusedBeforeCreation(f, () => startSessionWorkflowTest(f.host, request), "WORKFLOW_INPUT_INVALID");
        expect(await startSessionWorkflowTest(f.host, { ...request, inputs: { ticket: "incident-id" } })).toMatchObject({
            definitionId: saved.definitionId, runId: expect.any(String),
        });
    }));

    it("a retired Decision bench is not listed but an exact operation still has its receipt", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save();
        const request = testRequest(f, saved.definitionId);
        const first = await startSessionWorkflowTest(f.host, request);
        await f.host.catalog.softDeleteSession(first.testId);
        expect(await f.h.store.sessionDefinitions.listTests(f.session, saved.definitionId)).toEqual([]);
        f.setCapability(UNSET_DECISION);
        const before = await footprint(f), reads = f.admissionReads();
        expect(await startSessionWorkflowTest(f.host, request)).toEqual(first);
        expect(await footprint(f)).toEqual(before, "a retired test receipt is retained but its ended run is not dispatched");
        expect(f.admissionReads()).toEqual(reads);
    }));

    it("resumes a claim-only Decision bench at its pinned revision after createDefinition fails", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save();
        const request = testRequest(f, saved.definitionId);
        f.host.store = new Proxy(f.h.store, { get(target, name) {
            if (name === "createDefinition") return async () => { throw new Error("interrupted bench creation"); };
            return typeof target[name] === "function" ? target[name].bind(target) : target[name];
        } });
        try {
            await expect(startSessionWorkflowTest(f.host, request)).rejects.toThrow("interrupted bench creation");
        } finally { f.host.store = f.h.store; }
        const [benchId] = f.claims;
        const before = await footprint(f);
        expect(before).toMatchObject({ sessions: 1, definitions: 0, runs: 0, dispatched: 0 });
        await f.save(`${decisionWorkflowYaml()}\n# revision two`, "decision-models", { expected: { definitionId: saved.definitionId, revision: 1 } });
        const resumed = await startSessionWorkflowTest(f.host, request);
        expect(resumed).toMatchObject({ testId: benchId, revision: 1, expect: { state: "done" } });
        expect(await footprint(f)).toMatchObject({ sessions: 1, definitions: 1, runs: 1, dispatched: 1 });
        const admitted = await footprint(f), reads = f.admissionReads();
        f.setCapability(UNSET_DECISION);
        expect(await startSessionWorkflowTest(f.host, request)).toEqual(resumed);
        expect(await footprint(f)).toEqual({ ...admitted, dispatched: admitted.dispatched + 1 });
        expect(f.admissionReads()).toEqual(reads);
    }));

    it("a duplicate arriving between the bench claim and definition reaches the same Decision test run", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save();
        const request = testRequest(f, saved.definitionId);
        const claimed = Promise.withResolvers(), release = Promise.withResolvers();
        let held = false;
        const paused = { ...f.host, store: new Proxy(f.h.store, { get(target, name) {
            if (name === "createDefinition") return async input => {
                if (!held) { held = true; claimed.resolve(input.workflowSessionId); await release.promise; }
                return target.createDefinition(input);
            };
            return typeof target[name] === "function" ? target[name].bind(target) : target[name];
        } }) };
        const first = startSessionWorkflowTest(paused, request);
        try {
            const benchId = await Promise.race([claimed.promise, first.then(() => { throw new Error("claim was not paused"); })]);
            expect(await f.h.store.readDefinition(benchId)).toBeNull();
            const second = await startSessionWorkflowTest(f.host, request);
            expect(second.testId).toBe(benchId);
            release.resolve();
            expect(await first).toEqual(second);
            expect(await footprint(f)).toMatchObject({ sessions: 1, definitions: 1, runs: 1, dispatched: 2 });
        } finally { release.resolve(); await Promise.allSettled([first]); }
    }));
});

it.each([false, true])("lost dispatch: replay re-dispatches the stable controller for every admission (Decision=%s)", { timeout: TIMEOUT }, decision =>
    withHost({}, async f => {
        const yaml = name => decision ? decisionWorkflowYaml(name) : agentWorkflowYaml(name);
        const create = (id, name, extra = {}) => createWorkflow(f.host, { workflowSessionId: id, parentSessionId: f.session,
            owner: OWNER, yaml: yaml(name), actor: ACTOR, operationId: `create-${name}`, ...extra });
        const atomic = randomUUID(), together = randomUUID(), published = randomUUID(), direct = randomUUID();
        const togetherDraft = (await create(together, "together-dispatch")).receipt;
        const publishedDraft = (await create(published, "published-dispatch", { publish: true })).receipt;
        const directDraft = (await create(direct, "direct-test-dispatch")).receipt;
        const sessionStart = (await f.save(yaml("session-start-dispatch"), "session-start-dispatch")).definitionId;
        const sessionTest = (await f.save(yaml("session-test-dispatch"), "session-test-dispatch")).definitionId;
        const test = { ownerSessionId: f.session, definition: { definitionId: sessionTest }, inputs: {}, fixtures: [],
            operationId: "session-test-dispatch", actor: ACTOR, owner: async () => OWNER, binding: async () => null };
        for (const [label, attempt] of [
            ["atomic", () => create(atomic, "atomic-dispatch", { start: { inputs: {} } })],
            ["publish_and_start", () => applyWorkflowUpdate(f.host, together, { operation: "publish_and_start", expectedRevision: 1,
                definitionHash: togetherDraft.yamlSha256, inputs: {} }, { actor: ACTOR, operationId: "publish_and_start" })],
            ["start", () => applyWorkflowUpdate(f.host, published, { operation: "start", definitionHash: publishedDraft.yamlSha256, inputs: {} },
                { actor: ACTOR, operationId: "start" })],
            ["test", () => startWorkflowTest(f.host, direct, { expectedRevision: 1, definitionHash: directDraft.yamlSha256, inputs: {},
                agentMode: "mocked", fixtures: [] }, { actor: ACTOR, operationId: "test" })],
            ["keyed", () => f.start(sessionStart, { key: "recoverable-dispatch" })],
            ["bench", () => startSessionWorkflowTest(f.host, test)],
        ]) {
            f.loseNextDispatch();
            await expect(attempt(), label).rejects.toThrow("dispatch lost");
            const before = await footprint(f), failedInstance = f.dispatched.at(-1), reads = f.admissionReads();
            const replay = await attempt();
            expect(replay.runId ?? replay.receipt?.run?.runId, label).toEqual(expect.any(String));
            const after = await footprint(f);
            expect(after, label).toEqual({ ...before, claims: before.claims + (!decision && label === "atomic" ? 1 : 0),
                dispatched: before.dispatched + 1 });
            if (!decision && label === "atomic") expect(f.claims.at(-1)).toBe(atomic);
            expect(f.dispatched.at(-1), label).toBe(failedInstance);
            if (decision) expect(f.admissionReads(), label).toEqual(reads);
        }
    }));

describe("non-Decision regression", () => {
    it("a keyed Agent-only Start refuses decision_models alias switches before fresh or replay receipt reads", { timeout: TIMEOUT }, () => withHost({}, async f => {
        const saved = await f.save(agentWorkflowYaml("agent-only-alias-switch"), "agent-only-alias-switch");
        const models = { ask: { model: AGENT_OVERRIDE } };
        const receiptReads = [];
        f.host.store = new Proxy(f.h.store, { get(target, name) {
            if (name === "readOperationReceipt") return async (...args) => {
                receiptReads.push(args);
                return target.readOperationReceipt(...args);
            };
            return typeof target[name] === "function" ? target[name].bind(target) : target[name];
        } });

        const key = "agent-only-alias-switch";
        const beforeFresh = await footprint(f);
        await expect(f.start(saved.definitionId, { key, decisionModels: models })).rejects.toMatchObject({
            code: "AGENT_MODELS_INVALID", message: expect.stringContaining("decision_models names ask"),
        });
        expect(receiptReads).toEqual([]);
        expect(await footprint(f)).toEqual(beforeFresh);

        const first = await f.start(saved.definitionId, { key, agentModels: models });
        expect(first).toMatchObject({ replayed: false, agentModels: models });
        expect(JSON.stringify(first)).not.toContain("$workflowModelProvenance");
        expect(receiptReads).toEqual([]);
        const beforeReplay = await footprint(f);
        await expect(f.start(saved.definitionId, { key, decisionModels: models })).rejects.toMatchObject({
            code: "AGENT_MODELS_INVALID", message: expect.stringContaining("decision_models names ask"),
        });
        expect(receiptReads).toEqual([]);
        expect(await footprint(f)).toEqual(beforeReplay);
    }));

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
