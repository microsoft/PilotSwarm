import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { requireWorkflowScripts } from "./scripts-gate.js";
import { WORKFLOW_TEST_BENCH_KIND } from "./test-bench.js";
import { resolveEffectiveSpawnOwner, type SessionCatalog } from "../../cms.js";
import type { SessionOwnerInfo } from "../../types.js";
import type { WorkflowToolBinding } from "../tool-policy.js";
import {
    compileWorkflowV2, declaredSemver, WORKFLOW_V2_API_VERSION, WORKFLOW_V2_MAX_YAML_BYTES, WORKFLOW_V2_MILESTONE_IR_VERSION, WORKFLOW_V2_RUNNABLE_IR_VERSION,
    type WorkflowCompileResult, type WorkflowIR,
} from "./compiler.js";
import { boundedCanonicalJson, canonicalJson, isJsonObject, isStorableText, jsonbSafeText, jsonSha256, WorkflowJsonError, type JsonValue } from "./json.js";
import { TYPED_INPUT_REFUSALS, typedInputAuthority } from "./authority.js";
import { redactThenClip, redactWorkflowSecrets } from "./redact.js";
import { schemaSetFor, WorkflowSchemaError, type WorkflowSchemaSet } from "./schema.js";
import {
    correlationTextOf,
    WORKFLOW_V2_CONTROLLER_NAME,
    WORKFLOW_V2_CONTROLLER_VERSION,
    WORKFLOW_V2_MAX_CORRELATION_BYTES,
    WORKFLOW_V2_NOTIFY_NAME,
    endWorkflowV2RunChats,
    workflowV2TurnStopOf,
    workflowV2RunEndRequester,
    WORKFLOW_V2_NOTIFY_VERSION,
    WORKFLOW_V2_REQUEST_CONTROLLER_VERSION,
    WORKFLOW_V2_STOP_CONTROLLER_VERSIONS,
    WORKFLOW_V2_TAGGED_ORCHESTRATION_VERSION,
    workflowLiveControllerInstanceId,
    workflowNotifyInstanceId,
    workflowTestControllerInstanceId,
    type ControllerInput,
} from "./runtime.js";
import { testResultFor, workflowTestAnsweredProjection, type WorkflowTestFixture, type WorkflowTestResponse } from "./test-mode.js";
import { readWorkflowInterfaceExport, workflowInterfaceMismatches } from "./package-interface.js";
import type { PackageWorkflowSource } from "./chat-packages.js";
import { agentModelsDigestPart, parseWorkflowAgentModels, requireAgentModelsForRevision, requireUsableAgentModels, workflowAgentModelsText,
    type WorkflowAgentModelCheck, type WorkflowAgentModels } from "./agent-models.js";
import { requireBenchLiveLocked } from "./chat-definition-store.js";
import { WORKFLOW_COMMAND_QUEUE } from "../orchestration.js";
import {
    ACTIVE_RUN_STATUSES,
    commandEndOf,
    ADMITTING_RUN_STATUSES,
    checkedKvText,
    isKvKey,
    parseSessionCommandReceipt,
    runNotBegun,
    typedInputRequestSha256,
    WORKFLOW_V2_INPUT_TTL_SECONDS,
    WorkflowStoreError,
    type RunAdmission,
    type StoredOperation,
    type WorkflowActor,
    type WorkflowDefinitionReceipt,
    type WorkflowInboxLimits,
    type WorkflowInputReceipt,
    type WorkflowOutboxMessage,
    type WorkflowRunCommandReceipt,
    type WorkflowRunRow,
    type WorkflowRunStatus,
    type WorkflowSessionCommandReceipt,
    type WorkflowStore,
    type WorkflowNodeExecutionRow,
    type WorkflowTestAdvanceReceipt,
    type WorkflowTestInterception,
    requirePublishable,
} from "./store.js";

export { WORKFLOW_V2_INPUT_TTL_SECONDS } from "./store.js";

/**
 * Workflow v2 commands shared by the agent tools, the SDK and (later) the
 * Web API. The caller supplies a host-derived actor; nothing here trusts an
 * actor claim from request JSON. Authorization of that actor against the
 * workflow container is the caller's adapter's job and is checked before
 * these functions run.
 */

export interface WorkflowV2Host {
    catalog: Pick<SessionCatalog, "getSession" | "getSessionCreationConfig" | "createWorkflowSessionV2">;
    store: WorkflowStore;
    duroxideClient: {
        startOrchestrationVersioned(instanceId: string, name: string, input: unknown, version: string): Promise<void>;
        getStatus(instanceId: string): Promise<{ status: string; error?: string }>;
        enqueueEvent(instanceId: string, queueName: string, data: string): Promise<void>;
    };
    /**
     * Request states (design workflow-messaging-request.md 8.4; every worker
     * sets it): a definition
     * compiles with request states enabled (IR 7), and runs start at
     * controller 1.9.0 with the 1.1.0 notifier. Absent or false: a request
     * state keeps a definition an invalid draft, and runs start at 1.8.0.
     */
    requests?: boolean;
    /**
     * Workflow test mode (spec 16; test-mode-switch.ts): whether this host takes the test operations (test,
     * test_respond, test_advance) beside requests. Absent: the deployment flag PILOTSWARM_WORKFLOW_TEST_MODE, off
     * unless it is exactly `on`. Off, each is refused in words and stop stays.
     */
    testMode?: boolean;
    /**
     * Script nodes (stage 2.0, scripts-gate.ts): false on a host whose workers run no scripts
     * (PILOTSWARM_WORKFLOW_SCRIPTS off); a definition with a script node is then refused when it is saved and when it is
     * started, before anything is written (WORKFLOW_SCRIPTS_DISABLED, naming the setting). Absent: not known, no refusal.
     */
    scripts?: boolean;
    /**
     * Resolve a named agent as an agent state's child would be bound to it
     *: the definition the caller's
     * owner sees by that name, among the agents of `packageName` when the
     * state names one, or null. When the host has it, publication pins every
     * named agent state of the published revision to what it returns
     * (WorkflowStore publication, migration 0103) and refuses one it cannot
     * resolve (AGENT_UNAVAILABLE), also when the resolution itself fails.
     * The hosts that run controller 1.9.0 resolve with agent-resolver.ts: a
     * package agent at the registry's exact revision.
     */
    resolveAgent?: (name: string, callerSessionId: string, packageName?: string | null) => Promise<WorkflowPublicationAgent | null>;
    /**
     * The test-run retention policy (design 05 cleanup; applied by a host
     * that runs tests): after each test admission, the workflow's
     * ended test runs beyond the newest `keep` that ended at least
     * `graceSeconds` ago, and whose controller has finished, are deleted
     * (WorkflowStore.pruneTestRun). Defaults: WORKFLOW_V2_TEST_RUNS_RETAINED
     * and WORKFLOW_V2_TEST_RUN_RETENTION_GRACE_SECONDS.
     */
    testRetention?: { keep?: number; graceSeconds?: number };
    /**
     * Workflow Simplified stage 2.3 (chat-packages.ts): the agent registry's package Workflow Definitions, so a chat can
     * attach and start one. Absent: a host that cannot read packages refuses them (PACKAGE_WORKFLOWS_UNAVAILABLE).
     */
    packageWorkflows?: PackageWorkflowSource;
    /**
     * OF-S2-7: whether the owner of the chat that owns a Workflow (its agent nodes spend as them) may use an agent node's
     * chosen model (their catalog; agent-models.ts). Absent: the host refuses every agent model map (fail closed).
     */
    checkAgentModel?: WorkflowAgentModelCheck;
}

/** How many ended test runs a workflow keeps by default (design 05 cleanup; D07: a configurable default). */
export const WORKFLOW_V2_TEST_RUNS_RETAINED = 20;
/** How long an ended test run is kept at least, so that its controller's notice and its effects settle first. */
export const WORKFLOW_V2_TEST_RUN_RETENTION_GRACE_SECONDS = 300;

/** A named agent as the host resolves it at publication. */
export interface WorkflowPublicationAgent {
    name: string;
    system?: boolean;
    creatable?: boolean;
    packageId?: string;
    packageName?: string;
    packageVersion?: string;
    /** The content hash of the exact package version (R18): pinned with it, so a run keeps that revision after a republish. */
    packageRevision?: string;
    /**
     * The workflow interface the package agent exports at that revision, as
     * the agent registry keeps it (absent when it exports none). A state that
     * names an interface is published only when its contract matches it.
     */
    workflowInterface?: JsonValue;
    /**
     * Workflow Simplified stage 2.3 (A2): the agent names Workflow Definitions its chat may start (its workflows list). An
     * agent state may not use it: refused at save and at Start (AGENT_HAS_WORKFLOWS).
     */
    bringsWorkflows?: boolean;
}

/** A2 (stage 2.3): the refusal of an agent state whose agent brings definitions. */
export function agentBringsWorkflowsRefusal(stateId: string, agentName: string, nothing: string): WorkflowStoreError {
    return new WorkflowStoreError("AGENT_HAS_WORKFLOWS", `State '${stateId}' uses agent "${agentName}", which names Workflow Definitions it can start. `
        + `An agent step cannot use an agent that brings definitions: use another agent, or a prompt. ${nothing}`, { stateId, agent: agentName });
}

/**
 * A2 at save (stage 2.3): each agent state whose agent this host resolves, and which brings definitions, refuses the save.
 * An agent that does not resolve here is not refused at save (Start pins every named agent and refuses it then).
 */
export async function requireNoAgentBringsWorkflows(host: Pick<WorkflowV2Host, "resolveAgent">, ir: WorkflowIR | null, callerSessionId: string,
    nothing: string): Promise<void> {
    if (!ir || !host.resolveAgent) return;
    for (const node of Object.values(ir.nodes)) {
        if (node.type !== "agent" || !("agent" in node.invoke)) continue;
        let resolved: WorkflowPublicationAgent | null = null;
        try {
            resolved = await host.resolveAgent(node.invoke.agent.name, callerSessionId, node.invoke.agent.package);
        } catch {
            continue;
        }
        if (resolved?.bringsWorkflows) throw agentBringsWorkflowsRefusal(node.id, node.invoke.agent.name, nothing);
    }
}

/**
 * The agent pins of a revision to publish (design 03, 02 publication;
 * T011, T018, T071, mock M17): for each agent state that names an agent,
 * what the host resolves it to for the workflow's parent (the agent states'
 * controlling agent), as the child's binding would: its agent, package,
 * package version and package id. A named agent that the host cannot
 * resolve, that is a worker-managed system agent, or that does not match
 * the package or version the state names refuses the publication
 * (AGENT_UNAVAILABLE); a generic agent is never substituted. A state that
 * names a workflow interface (`interface: name@version`) is pinned only
 * when the agent exports that interface at the resolved revision and the
 * state's outcomes and schemas are exactly the interface's
 * (package-interface.ts); otherwise the publication is refused
 * (CONTRACT_MISMATCH, with each problem), and on a match the pin also holds
 * the interface's name, version and digest. Null when the revision has no
 * named agent state or the host does not resolve agents (its children are
 * then bound when they are created, as before); such a host refuses a state
 * that names an interface (AGENT_UNAVAILABLE), since it cannot check it.
 */
async function publicationAgentPins(host: Pick<WorkflowV2Host, "resolveAgent">, ir: WorkflowIR | null, callerSessionId: string): Promise<string | null> {
    if (!ir) return null;
    if (!host.resolveAgent) {
        const unchecked = Object.values(ir.nodes).find(node => node.type === "agent" && "agent" in node.invoke && node.invoke.agent.interface !== undefined);
        if (unchecked) {
            throw new WorkflowStoreError("AGENT_UNAVAILABLE", `State '${unchecked.id}' names a workflow interface, and this host does not resolve `
                + "package agents, so it cannot check it. Nothing was changed.", { stateId: unchecked.id });
        }
        return null;
    }
    const pins: { [stateId: string]: JsonValue } = {};
    for (const node of Object.values(ir.nodes)) {
        if (node.type !== "agent" || !("agent" in node.invoke)) continue;
        const named = node.invoke.agent;
        const about = { stateId: node.id, agent: named.name, package: named.package, version: named.version };
        const refuse = (message: string): never => {
            throw new WorkflowStoreError("AGENT_UNAVAILABLE", message, about);
        };
        let resolved: WorkflowPublicationAgent | null;
        try {
            resolved = await host.resolveAgent(named.name, callerSessionId, named.package);
        } catch (error) {
            // The host's own refusal keeps its reason; any other failure (the agent registry could not be read) refuses
            // too. Either way nothing is written, and a retry of the same request may succeed.
            if (error instanceof WorkflowStoreError && error.code === "AGENT_UNAVAILABLE") {
                throw new WorkflowStoreError("AGENT_UNAVAILABLE", `State '${node.id}': ${error.message}`,
                    { ...(isJsonObject(error.details) ? error.details : {}), ...about });
            }
            throw new WorkflowStoreError("AGENT_UNAVAILABLE", `Agent "${named.name}" of state '${node.id}' could not be resolved: `
                + "the agent registry could not be read. Nothing was changed; try again.", { ...about, retryable: true });
        }
        if (!resolved) refuse(`Agent "${named.name}" of state '${node.id}' is not available to this workflow's owner; publication pins every named agent.`);
        else {
            if (resolved.system && resolved.creatable === false) refuse(`Agent "${named.name}" of state '${node.id}' is a worker-managed system agent; a workflow cannot run it.`);
            // A2 (stage 2.3): an agent that brings definitions is never an agent state's agent.
            if (resolved.bringsWorkflows) throw agentBringsWorkflowsRefusal(node.id, named.name, "Nothing was changed.");
            if (named.package !== null && resolved.packageName !== named.package) {
                refuse(`Agent "${named.name}" of state '${node.id}' is not available from package "${named.package}".`);
            }
            if (named.version !== null && resolved.packageVersion !== named.version) {
                refuse(`Agent "${named.name}" of state '${node.id}' is not available at version ${named.version} (it is at ${resolved.packageVersion ?? "no version"}).`);
            }
            let interfacePin: JsonValue | undefined;
            if (named.interface !== undefined) {
                const wanted = named.interface;
                const label = `${wanted.name}@${wanted.version}`;
                const problems = workflowInterfaceMismatches(node, ir, wanted, resolved.workflowInterface);
                const exported = problems.length === 0 ? readWorkflowInterfaceExport(resolved.workflowInterface) : null;
                if (exported === null) {
                    throw new WorkflowStoreError("CONTRACT_MISMATCH", `State '${node.id}' does not match the workflow interface ${label} of agent `
                        + `"${named.name}" of package "${named.package}" (version ${resolved.packageVersion ?? "unknown"}): `
                        + `${(problems.length > 0 ? problems : ["its interface could not be read"]).join("; ")}. Nothing was changed.`,
                    { ...about, interface: label, packageVersion: resolved.packageVersion ?? null, problems });
                }
                interfacePin = { name: exported.name, version: exported.version, digest: exported.digest };
            }
            pins[node.id] = {
                name: resolved.name, package: resolved.packageName ?? null, version: resolved.packageVersion ?? null, packageId: resolved.packageId ?? null,
                // The exact revision (R18), when the host knows it; a run of this publication then keeps it after a republish.
                ...(resolved.packageId && resolved.packageRevision ? { revision: resolved.packageRevision } : {}),
                // The interface the state matched at that revision (its digest covers its schemas and outcomes).
                ...(interfacePin !== undefined ? { interface: interfacePin } : {}),
            };
        }
    }
    return Object.keys(pins).length > 0 ? canonicalJson(pins) : null;
}

/**
 * The controller version a host starts runs at (WorkflowV2Host.requests). Every production host has `requests: true`
 * (every worker's turn host and the management client's default; owner decision 2026-11-08T15:30Z), so every run starts
 * at 1.9.0. Controller 1.8.0 stays registered but is unreachable: only a test host without `requests` still starts it.
 * Its deletion (with its untagged 1.0.0 orchestrations, the legacy activity names, the `requests: false` paths and
 * WORKFLOW_V2_UNSUPPORTED_CONTROLLER_VERSIONS) is a follow-up cleanup PR (ruling pse/wfs/stage2/release-1083-plan-rulings,
 * item 3).
 */
function controllerVersionFor(host: Pick<WorkflowV2Host, "requests">): string {
    return host.requests === true ? WORKFLOW_V2_REQUEST_CONTROLLER_VERSION : WORKFLOW_V2_CONTROLLER_VERSION;
}

/**
 * The controller version a run was admitted for (migration 0100; a run
 * admitted before it records none, and 1.8.0 was then the only version). A
 * run is started, recovered and reported only at its own version, never at
 * the version of the host that acts on it: design 02 never points a
 * new-version run at a legacy interpreter, nor an older run at a newer one.
 */
function runControllerVersion(run: Pick<WorkflowRunRow, "controllerVersion">): string {
    return run.controllerVersion ?? WORKFLOW_V2_CONTROLLER_VERSION;
}

/** The notifier version of a run's controller: a 1.9.0 run reports through the tagged 1.1.0 notifier. */
function runNotifyVersion(run: Pick<WorkflowRunRow, "controllerVersion">): string {
    return runControllerVersion(run) === WORKFLOW_V2_REQUEST_CONTROLLER_VERSION ? WORKFLOW_V2_TAGGED_ORCHESTRATION_VERSION : WORKFLOW_V2_NOTIFY_VERSION;
}

/**
 * The run's controller version when this host runs it; otherwise
 * CONTROLLER_UNAVAILABLE before anything changes (design 02 compatibility,
 * T121, T122): a 1.9.0 run is started or recovered only by a host that starts
 * 1.9.0 runs (WorkflowV2Host.requests), and never handed to 1.8.0.
 */
function requireRunsController(host: Pick<WorkflowV2Host, "requests">, run: Pick<WorkflowRunRow, "runId" | "controllerVersion">): string {
    const version = runControllerVersion(run);
    if (version === WORKFLOW_V2_CONTROLLER_VERSION || (version === WORKFLOW_V2_REQUEST_CONTROLLER_VERSION && host.requests === true)) return version;
    throw new WorkflowStoreError("CONTROLLER_UNAVAILABLE",
        `Run ${run.runId} was admitted for workflow controller ${version}, which this build does not run; a build that runs it starts or recovers it.`,
        { runId: run.runId, controllerVersion: version, hostControllerVersion: controllerVersionFor(host) });
}

/**
 * Refuse, before anything is written, to publish or start a revision whose IR
 * this host does not run (design 02 compatibility: reader support precedes
 * new writes; T121): IR 7 and 8 (request, agent or parallel states, or a run
 * deadline) need controller 1.9.0, so a host that starts 1.8.0 runs answers
 * CONTROLLER_UNAVAILABLE and neither publishes nor admits anything; a host
 * that starts 1.9.0 runs does both. A revision that does not exist, or has no
 * compiled IR, is left to the store's own refusal.
 */
async function requireRunsRevision(host: Pick<WorkflowV2Host, "store" | "requests">, workflowSessionId: string, revision: number | null): Promise<void> {
    if (host.requests === true || revision === null) return;
    const irVersion = await host.store.readRevisionIrVersion(workflowSessionId, revision);
    if (irVersion === null || irVersion <= WORKFLOW_V2_RUNNABLE_IR_VERSION) return;
    throw new WorkflowStoreError("CONTROLLER_UNAVAILABLE",
        `Revision ${revision} has IR version ${irVersion} (request, agent or parallel states, a run deadline, or a clock wait), which needs workflow controller `
            + `${WORKFLOW_V2_REQUEST_CONTROLLER_VERSION}; this build runs ${WORKFLOW_V2_CONTROLLER_VERSION}, so it neither publishes nor starts it.`,
        { revision, irVersion, controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, hostControllerVersion: WORKFLOW_V2_CONTROLLER_VERSION });
}

/** A definition as a host compiles it (WorkflowV2Host.requests): a host that starts 1.9.0 runs compiles request, agent and parallel states. */
export function compileWorkflowV2ForHost(host: Pick<WorkflowV2Host, "requests">, yaml: string): WorkflowCompileResult {
    return compileWorkflowV2(yaml, host.requests === true ? { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true,
        enableClockWaits: true } : {});
}

/** How a host reads stored IR: a host that starts 1.9.0 runs reads its request, agent and parallel states (IR 7 and 8). */
function irOptionsFor(host: Pick<WorkflowV2Host, "requests">): { maxIrVersion?: number } {
    return host.requests === true ? { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION } : {};
}

export interface CreateWorkflowV2Request {
    workflowSessionId: string;
    parentSessionId: string | null;
    owner?: SessionOwnerInfo | null;
    yaml: string;
    actor: WorkflowActor;
    operationId: string;
    /** Publish revision 1 now (requires a valid definition). */
    publish?: boolean;
    /** Start the live run now (requires publish). */
    /**
     * inputs: static run inputs; vars: the initial open KV map (revision 1); agentModels (OF-S2-7): the agent nodes' models
     * chosen at start, by state id (agent-models.ts), checked against this revision and the owning chat's catalog.
     */
    start?: { inputs: JsonValue; vars?: { [key: string]: JsonValue }; agentModels?: WorkflowAgentModels | null } | null;
    notifyParent?: boolean;
    /** Host-captured tool grant for scripts; never from YAML or a public payload. */
    binding?: WorkflowToolBinding | null;
    /**
     * SEMVER_REUSED (WorkflowStore.requireVersionFree): refuse a new Workflow whose metadata.name and version another
     * Workflow of the same parent has with other YAML (or is being created with). Set by spawn_workflow; checked inside the
     * claim's transaction under a lock on (parent, name), and a refusal rolls the claim back.
     */
    refuseVersionReuse?: boolean;
    /**
     * S2RT-F3: a chat Start counted toward the chat's budget of running children: the chat's row is locked exclusively and
     * the budget counted in the claim's transaction (a full one rolls the claim back: CHILD_LIMIT). A replay (its claim
     * exists) is not counted again: the claim is its reservation.
     */
    childBudget?: { max: number } | null;
    /**
     * Stage 2.1: the Workflow starts a chat's definition at this revision (chat-definitions.ts). Its own definition is that
     * revision's YAML, pinned (R1); the chat, the definition and the revision are checked under their locks in the
     * transaction that admits the run (requireChatStartLocked).
     */
    chatPin?: { ownerSessionId: string; definitionId: string; revision: number } | null;
    /**
     * Stage 2.2: the Workflow is an agent's test bench for this revision of a chat's definition (chat-test.ts): a service
     * session (service_kind workflow-test; its definition and revision in its creation config) that no list shows, never a Workflow of the definition.
     * G4: `expect`, the end its test must reach (a terminal state or an outcome), kept with them for its report.
     */
    testBench?: { definitionId: string; revision: number; expect?: { state: string } | { outcome: string } | null } | null;
}

/** Operation ids are stored as TEXT and compared exactly; refuse text PostgreSQL would reject or rewrite. */
function requireOperationId(operationId: string): void {
    if (typeof operationId !== "string" || !operationId.trim() || operationId.length > 256 || !isStorableText(operationId)) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID",
            "operation_id must be 1-256 characters of valid Unicode text without NUL characters.");
    }
}

/** A definition is stored as TEXT; NUL or lone surrogates cannot be stored exactly, even as a draft. */
function requireStorableYaml(yaml: string): void {
    if (typeof yaml !== "string" || !isStorableText(yaml)) {
        throw new WorkflowStoreError("WORKFLOW_YAML_INVALID", "Workflow YAML must be valid Unicode text without NUL characters.");
    }
    // Adversarial review R2-SF-5: a text over the limit is refused before it is read or anything is written (the compiler
    // only reports it, and a draft would still be saved with it); the workflow's revisions stay as they were. The store
    // refuses it too.
    if (Buffer.byteLength(yaml, "utf8") > WORKFLOW_V2_MAX_YAML_BYTES) {
        throw new WorkflowStoreError("WORKFLOW_YAML_TOO_LARGE", `Workflow YAML must be at most ${WORKFLOW_V2_MAX_YAML_BYTES.toLocaleString("en-US")} bytes `
            + "(256 KiB). Nothing was saved.");
    }
}

/**
 * A run's inputs checked against its revision's inputs.schema (`ir` and its hash; nothing to check without a schema).
 * A revision saved before workflow schemas refused `pattern` and `patternProperties` (owner decision Q1 (d)) does not
 * start: its schemas are refused here as WORKFLOW_SCHEMA_INVALID, inputs schema or not.
 */
function validateRunInputs(ir: WorkflowIR | null, irSha256: string | null, inputs: JsonValue): void {
    if (!ir || !irSha256) return;
    let schemas: WorkflowSchemaSet;
    try {
        schemas = schemaSetFor(irSha256, ir.schemaDefs);
    } catch (error) {
        if (error instanceof WorkflowSchemaError) throw new WorkflowStoreError(error.code, error.message);
        throw error;
    }
    if (!ir.inputsSchema) return;
    const problems = schemas.validate(ir.inputsSchema, inputs);
    if (problems.length) {
        throw new WorkflowStoreError("WORKFLOW_INPUT_INVALID", "Workflow inputs do not match inputs.schema.",
            problems.map(problem => ({ path: problem.path, message: problem.message })));
    }
}

/**
 * A live run's admission, for the controller version this host starts runs at (stored with the run, migration 0100), with
 * the agent nodes' models chosen at start (migration 0110), when any.
 */
function liveAdmission(host: Pick<WorkflowV2Host, "requests">, workflowSessionId: string, inputs: JsonValue, vars: { [key: string]: JsonValue } | null,
    agentModels: WorkflowAgentModels | null = null): RunAdmission {
    const agentModelsText = workflowAgentModelsText(agentModels);
    return {
        runId: randomUUID(), mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
        inputsText: boundedCanonicalJson(inputs, "Workflow inputs"), kvText: checkedKvText(vars ?? {}), testAgentMode: null,
        controllerVersion: controllerVersionFor(host), ...(agentModelsText ? { agentModelsText } : {}),
    };
}

/**
 * OF-S2-7 review OF7-R1: the identity a Workflow's agent nodes spend as, and so the catalog a start's choices are checked
 * against: the effective owner of the Workflow (its own owner, else its lineage's: the owner of the chat that owns it), as
 * the agent host resolves it at spawn. Never the caller's (a person or an administrator starting another owner's Workflow).
 * `workflowSessionId` when the Workflow exists; else its owner as it will be made (`owner`) or its parent chat's.
 */
export async function workflowSpendingOwner(host: Pick<WorkflowV2Host, "catalog">, at: { workflowSessionId?: string | null;
    owner?: SessionOwnerInfo | null; parentSessionId?: string | null }): Promise<SessionOwnerInfo | null> {
    const getSession = (id: string) => host.catalog.getSession(id);
    if (at.workflowSessionId) {
        const existing = await host.catalog.getSession(at.workflowSessionId);
        if (existing) return resolveEffectiveSpawnOwner(getSession, at.workflowSessionId);
    }
    if (at.owner?.provider && at.owner.subject) return at.owner;
    return at.parentSessionId ? resolveEffectiveSpawnOwner(getSession, at.parentSessionId) : null;
}

/**
 * OF-S2-7: a start's agent node models, checked before anything is written: their shape, and that each names an agent node
 * of exactly the revision being started (`ir`, `what` in words). Pure: the catalog is startCatalogCheck's.
 */
function startAgentModels(given: unknown, ir: WorkflowIR | null, what: string): WorkflowAgentModels | null {
    const models = parseWorkflowAgentModels(given);
    if (!models) return null;
    if (!ir) throw new WorkflowStoreError("AGENT_MODELS_INVALID", `agentModels needs a valid revision to check against; ${what} has none.`);
    requireAgentModelsForRevision(models, ir, what);
    return models;
}

/**
 * OF-S2-7: that `spender` (workflowSpendingOwner: the owner of the chat that owns the Workflow) may use each chosen model.
 * Review D4: only for a request no stored receipt answers yet: a repeat of an admitted start returns its receipt, even when
 * the owner can no longer use a model it chose (its run already has it).
 */
async function startCatalogCheck(host: Pick<WorkflowV2Host, "checkAgentModel">, models: WorkflowAgentModels | null,
    spender: () => Promise<SessionOwnerInfo | null>): Promise<void> {
    if (models) await requireUsableAgentModels(models, host.checkAgentModel, await spender());
}

/**
 * Initial KV as part of a request digest: absent when empty, so a request
 * without vars keeps the digest earlier builds recorded for it.
 */
function varsDigestPart(vars: { [key: string]: JsonValue } | null | undefined): { vars?: string } {
    return vars && Object.keys(vars).length > 0 ? { vars: canonicalJson(vars) } : {};
}

/**
 * Start (or re-dispatch, idempotently) the controller of an admitted run named
 * by a receipt. Safety does not rest on this check: a controller started for
 * a run that was cancelled or deleted meanwhile finds it inactive at begin,
 * under the session and run locks, and admits nothing.
 */
export async function dispatchWorkflowV2Run(host: WorkflowV2Host, receipt: WorkflowDefinitionReceipt): Promise<void> {
    const admitted = receipt.run;
    if (!admitted) return;
    const run = await host.store.readRun(admitted.runId);
    if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) return;
    const input: ControllerInput = { v: 2, workflowSessionId: receipt.workflowSessionId, runId: admitted.runId };
    // At the version the run was admitted for (a replayed admission may reach a host that does not run it: refused).
    await host.duroxideClient.startOrchestrationVersioned(admitted.controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME, input, requireRunsController(host, run));
}

/** duroxide statuses after which an orchestration does no more work. */
const ENDED_ORCHESTRATION_STATUSES: readonly string[] = ["Completed", "Failed", "Terminated"];

/** What a run's controller says about the run, without changing anything. */
export interface WorkflowV2ControllerView {
    status: string;
    error: string | null;
    /**
     * The run is active but its controller can no longer end it (it ended,
     * or its instance is gone), or the run was admitted and never started.
     * update_workflow operation recover acts on it.
     */
    needsRecovery: boolean;
}

export async function inspectWorkflowV2Controller(host: Pick<WorkflowV2Host, "duroxideClient">, run: WorkflowRunRow): Promise<WorkflowV2ControllerView> {
    const controller = await host.duroxideClient.getStatus(run.controllerInstanceId);
    const ended = controller.status === "NotFound" || ENDED_ORCHESTRATION_STATUSES.includes(controller.status);
    return {
        status: controller.status,
        // SF-6 verification: a controller's error is shown in reads and stored in recover receipts with its secrets hidden.
        error: controller.error === undefined ? null : jsonbSafeText(redactWorkflowSecrets(controller.error), 2_000),
        needsRecovery: ACTIVE_RUN_STATUSES.includes(run.status) && ended,
    };
}

/** The receipt of update_workflow operation recover. */
export interface WorkflowV2RecoverReceipt {
    runId: string;
    action: "none" | "dispatched" | "ended";
    status: WorkflowRunStatus;
    controller: WorkflowV2ControllerView;
}

function recoverReceiptJson(receipt: WorkflowV2RecoverReceipt): JsonValue {
    return {
        runId: receipt.runId, action: receipt.action, status: receipt.status,
        controller: { status: receipt.controller.status, error: receipt.controller.error, needsRecovery: receipt.controller.needsRecovery },
    };
}

const RUN_STATUSES: readonly WorkflowRunStatus[] = [...ACTIVE_RUN_STATUSES, "completed", "failed", "cancelled", "stopped"];

function parseRecoverReceipt(value: JsonValue): WorkflowV2RecoverReceipt {
    const corrupt = () => new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "Stored recover receipt has an invalid shape.");
    if (!isJsonObject(value)) throw corrupt();
    const { runId, action, status, controller } = value;
    const parsedAction = action === "none" || action === "dispatched" || action === "ended" ? action : null;
    const parsedStatus = RUN_STATUSES.find(item => item === status);
    if (typeof runId !== "string" || parsedAction === null || parsedStatus === undefined || !isJsonObject(controller)) throw corrupt();
    const { status: controllerStatus, error, needsRecovery } = controller;
    if (typeof controllerStatus !== "string" || typeof needsRecovery !== "boolean") throw corrupt();
    if (error !== null && typeof error !== "string") throw corrupt();
    return { runId, action: parsedAction, status: parsedStatus, controller: { status: controllerStatus, error, needsRecovery } };
}

/**
 * Deliver the run-end notice a terminal live run still owes its parent (adversarial review RT-4): a run whose end was
 * neither told to its parent nor recorded as not told (store.runNoticeRecorded), whose workflow has a parent, and whose
 * end was not the parent's own command (workflowV2RunEndRequester). That holds for a run a recover ended, and for any
 * other terminal run whose controller ended before telling the parent or whose notifier ran out of attempts. The
 * notifier orchestration runs the notification activity (at least once, stable client message id, skip semantics as
 * ever); it is started unless it is running. A notifier instance that already ended is not started again (duroxide
 * would ignore it): a recover starts one of its own, named for its operation id, so a repeat of that recover starts the
 * same one. The stored run is not changed.
 */
async function notifyRecoveredRun(host: Pick<WorkflowV2Host, "store" | "duroxideClient" | "requests">, run: WorkflowRunRow, operationId: string): Promise<void> {
    if (run.mode !== "live" || ACTIVE_RUN_STATUSES.includes(run.status)) return;
    const definition = await host.store.readDefinition(run.workflowSessionId);
    // With notifications off the notifier records that the parent was not told (batch 7, n-2).
    if (!definition?.parentSessionId) return;
    if (workflowV2RunEndRequester(run) === definition.parentSessionId) return;
    if (await host.store.runNoticeRecorded(run.workflowSessionId, run.runId)) return;
    // A controller still running reports its run's end itself.
    const controller = await host.duroxideClient.getStatus(run.controllerInstanceId);
    if (controller.status !== "NotFound" && !ENDED_ORCHESTRATION_STATUSES.includes(controller.status)) return;
    const base = workflowNotifyInstanceId(run.runId);
    const notifier = await host.duroxideClient.getStatus(base);
    if (!ENDED_ORCHESTRATION_STATUSES.includes(notifier.status) && notifier.status !== "NotFound") return;
    const instanceId = notifier.status === "NotFound" ? base : `${base}-recover-${jsonSha256({ operationId }).slice(0, 16)}`;
    await host.duroxideClient.startOrchestrationVersioned(instanceId, WORKFLOW_V2_NOTIFY_NAME, { runId: run.runId }, runNotifyVersion(run));
}

/**
 * Finish a run that a recover ended (or an earlier recover ended), whose controller can do nothing more (adversarial
 * review RT-3): end the children of its decided agent states whose end is still owed, for every run mode (a real-agent
 * test run's included), and make sure its parent's notification was started. Neither waits for the other: the
 * notification is started even when a child could not be ended yet, and then the recover fails, so a later recover
 * ends the children still owed (each end is recorded once, with a stable command id).
 */
async function finishRecoveredRun(host: Pick<WorkflowV2Host, "store" | "duroxideClient" | "requests">
    & { catalog?: Partial<Pick<SessionCatalog, "turnControlAdd">> }, run: WorkflowRunRow, operationId: string): Promise<void> {
    if (ACTIVE_RUN_STATUSES.includes(run.status)) return;
    // Adversarial review R2-RT-2: the session row says the live run's end again, should a status read have written failed
    // over it after its controller failed.
    await host.store.repairEndedRunSessionRow(run.runId);
    let unended: unknown = null;
    try {
        // With the chats that continued across visits (chat: continue), which only a run's end ends.
        // Review G5: a child's running turn is stopped before its cancel (a session takes a command only between turns).
        const stopTurn = workflowV2TurnStopOf(host.catalog);
        await endWorkflowV2RunChats(host.store, host.duroxideClient, run.runId, stopTurn ? { stopTurn } : {});
    } catch (error) {
        unended = error;
    }
    await notifyRecoveredRun(host, run, operationId);
    if (unended !== null) throw unended;
}

/**
 * Start the controller of a run whose recover receipt says it was
 * dispatched, while its controller has not begun it. The
 * receipt was stored first, so a repeat of the request reaches this again
 * after an interruption; duroxide ignores a second start of an instance, and
 * the run's stored controller instance id never changes.
 */
async function dispatchRecoveredRun(host: Pick<WorkflowV2Host, "duroxideClient" | "requests">, run: WorkflowRunRow): Promise<void> {
    if (!runNotBegun(run)) return;
    const input: ControllerInput = { v: 2, workflowSessionId: run.workflowSessionId, runId: run.runId };
    await host.duroxideClient.startOrchestrationVersioned(run.controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME, input, requireRunsController(host, run));
}

/**
 * Report a run that this cancel request ended before it began (no controller
 * ran it), by the controller's rule: the parent is told unless it asked for
 * the cancel itself, through the notifier orchestration (stable client
 * message id, at least once). The requester is the one the run's end
 * records (or attributes, for an earlier build's cancel that begin ended);
 * a repeat sent by the parent itself is not reported to it either. A repeat
 * only makes sure the notifier was started; a run ended by anything else
 * is left alone. The begin activity starts the same notifier when the
 * run's controller starts (workflow-v2-controller begin).
 */
async function notifyCancelledBeforeBegin(host: { store: WorkflowStore; duroxideClient: Pick<WorkflowV2Host["duroxideClient"], "startOrchestrationVersioned"> },
    run: WorkflowRunRow, operationId: string, callerSessionId: string | null): Promise<void> {
    const error = run.terminalError;
    const details = isJsonObject(error) && isJsonObject(error.details) ? error.details : null;
    if (run.mode !== "live" || run.status !== "cancelled" || !details || details.beforeBegin !== true || details.operationId !== operationId) return;
    const definition = await host.store.readDefinition(run.workflowSessionId);
    // With notifications off the notifier records that the parent was not told (batch 7, n-2).
    if (!definition?.parentSessionId) return;
    if (details.requestedBy === definition.parentSessionId || callerSessionId === definition.parentSessionId) return;
    await host.duroxideClient.startOrchestrationVersioned(workflowNotifyInstanceId(run.runId), WORKFLOW_V2_NOTIFY_NAME,
        { runId: run.runId }, runNotifyVersion(run));
}

/**
 * Recover an active run whose controller can no longer end it, on an
 * explicit request (update_workflow operation recover):
 * - not begun (admitted, or paused before it began) with no controller
 *   instance (the dispatch after admission was lost): dispatch it again.
 *   The receipt and the workflow.recovered event are stored before the
 *   start, so the receipt of a request that started the controller always
 *   says dispatched; a repeat starts it again;
 * - the controller ended, or its instance is gone, while the run is still
 *   active (its finalization attempts ran out, it was terminated, or its
 *   history is from an unsupported pre-release controller): end the run as
 *   failed with the controller's state, and notify the parent of that end
 *   when the workflow asked for it. Pending node executions lose to that
 *   end, so a running script's liveness check stops it.
 * A run that is not active, or whose controller is still running, is left as
 * it is. The operation id makes the request idempotent: the first receipt
 * stored for it is returned to every repeat, and a repeat completes the
 * dispatch or the notification that receipt implies. The dispatch and the
 * notification are at least once, not exactly once.
 */
export async function recoverWorkflowV2Run(host: Pick<WorkflowV2Host, "store" | "duroxideClient" | "requests">, runId: string,
    request: { requestedBy: string | null; operationId: string }): Promise<StoredOperation<WorkflowV2RecoverReceipt>> {
    requireOperationId(request.operationId);
    const run = await host.store.readRun(runId);
    if (!run) throw new WorkflowStoreError("RUN_NOT_FOUND", `Workflow run ${runId} does not exist.`);
    const workflowSessionId = run.workflowSessionId;
    const requestSha256 = jsonSha256({ kind: "recover", runId });
    const replay = async (stored: JsonValue): Promise<StoredOperation<WorkflowV2RecoverReceipt>> => {
        const receipt = parseRecoverReceipt(stored);
        const current = await host.store.readRun(runId);
        if (current) {
            if (receipt.action === "dispatched") await dispatchRecoveredRun(host, current);
            await finishRecoveredRun(host, current, request.operationId);
        }
        return { receipt, replayed: true };
    };
    /** The id was recorded meanwhile: a concurrent repeat (its receipt is returned) or another request (OPERATION_CONFLICT). */
    const recordedMeanwhile = async (error: unknown): Promise<StoredOperation<WorkflowV2RecoverReceipt>> => {
        if (!(error instanceof WorkflowStoreError) || error.code !== "OPERATION_CONFLICT") throw error;
        const stored = await host.store.readOperationReceipt(workflowSessionId, request.operationId, "recover", requestSha256);
        if (stored === null) throw error;
        return replay(stored);
    };
    const prior = await host.store.readOperationReceipt(workflowSessionId, request.operationId, "recover", requestSha256);
    if (prior !== null) return replay(prior);

    const controller = await inspectWorkflowV2Controller(host, run);
    let receipt: WorkflowV2RecoverReceipt = { runId, action: "none", status: run.status, controller };
    if (controller.needsRecovery && controller.status === "NotFound" && runNotBegun(run)) {
        // Only a host that runs the run's controller version starts it; nothing is recorded otherwise.
        requireRunsController(host, run);
        const dispatching: WorkflowV2RecoverReceipt = { runId, action: "dispatched", status: run.status, controller };
        let intent: { recorded: boolean; run: WorkflowRunRow };
        try {
            intent = await host.store.recordRecoverDispatch({
                runId,
                receipt: { operationId: request.operationId, kind: "recover", requestSha256, value: recoverReceiptJson(dispatching) },
                projection: {
                    sessionId: workflowSessionId,
                    events: [{ eventType: "workflow.recovered", data: {
                        runId, action: "dispatched", requestedBy: request.requestedBy, operationId: request.operationId,
                    } }],
                },
            });
        } catch (error) {
            return recordedMeanwhile(error);
        }
        if (intent.recorded) {
            await dispatchRecoveredRun(host, intent.run);
            return { receipt: dispatching, replayed: false };
        }
        // Something began or ended the run meanwhile; this request changes nothing.
        receipt = { runId, action: "none", status: intent.run.status, controller };
    } else if (controller.needsRecovery) {
        const message = controller.status === "NotFound"
            ? "The workflow controller no longer exists; the run cannot continue."
            : `The workflow controller ended (${controller.status}) without ending the run.`;
        const ending: WorkflowV2RecoverReceipt = { runId, action: "ended", status: "failed", controller };
        let ended: { ended: boolean; run: WorkflowRunRow };
        try {
            ended = await host.store.finishRun({
                runId, status: "failed", terminalNodeId: null, terminalOutcome: null, outputText: null,
                errorText: canonicalJson({ code: "controller_ended", message,
                    details: { controllerStatus: controller.status, controllerError: controller.error, requestedBy: request.requestedBy } }),
                endPending: { winner: "controller", message: "The workflow run ended before this state finished." },
                receipt: { operationId: request.operationId, kind: "recover", requestSha256, value: recoverReceiptJson(ending) },
                projection: {
                    sessionId: workflowSessionId,
                    events: [{ eventType: "workflow.failed", data: {
                        runId, code: "controller_ended", controllerStatus: controller.status, error: message, requestedBy: request.requestedBy,
                    } }],
                    update: { state: "failed", lastError: message, touch: true },
                },
            });
        } catch (error) {
            return recordedMeanwhile(error);
        }
        if (ended.ended) {
            await finishRecoveredRun(host, ended.run, request.operationId);
            return { receipt: ending, replayed: false };
        }
        receipt = { runId, action: "none", status: ended.run.status, controller };
    }
    const stored = await host.store.recordOperationReceipt(workflowSessionId, request.operationId, "recover", requestSha256, recoverReceiptJson(receipt));
    if (stored.replayed) return replay(stored.receipt);
    // A run an earlier recover ended: make sure its agent children were ended and its notification was started.
    await finishRecoveredRun(host, await host.store.readRun(runId) ?? run, request.operationId);
    return { receipt, replayed: false };
}

/**
 * Digests of one creation request, by the version of the fingerprint that
 * recorded it. A claim marker or receipt is never rewritten; a retry is
 * compared with the digest its record used, and the stored owner, parent
 * and first grant must match the request as well.
 * - 1 (c218d1bc..87549e10): content, parent and notification; the claim
 *   marker held no digest.
 * - 2 (159bdce5, ba30c8c2): version 1 plus the owner; the marker held the
 *   digest without stating its version.
 * - 3: version 2 plus the tool grant. 3a7ca2dd..547d1bf5 wrote it without
 *   stating the version; from 3833ba61 on the marker states `fingerprint: 3`.
 */
export const WORKFLOW_V2_CREATE_FINGERPRINT = 3;

function createFingerprints(request: CreateWorkflowV2Request, yamlSha256: string, publish: boolean, startInputs: JsonValue): { v1: string; v2: string; v3: string } {
    const content = {
        kind: "create", yamlSha256, publish,
        start: request.start ? { inputs: startInputs, ...varsDigestPart(request.start.vars), ...agentModelsDigestPart(request.start.agentModels) } : null,
        parentSessionId: request.parentSessionId, notifyParent: request.notifyParent !== false,
    };
    const owner = request.owner ? { provider: request.owner.provider, subject: request.owner.subject } : null;
    // The tool grant is part of the request: a retry with another grant is
    // another request, so it can never continue (or be told it created) this one.
    const binding = request.binding ? jsonSha256(JSON.parse(JSON.stringify(request.binding))) : null;
    return { v1: jsonSha256(content), v2: jsonSha256({ ...content, owner }), v3: jsonSha256({ ...content, owner, binding }) };
}

/** The same tool grant: both absent, or the same JSON (the stored copy went through JSONB). */
function sameGrant(stored: unknown, requested: WorkflowToolBinding | null | undefined): boolean {
    const storedGrant = stored === undefined || stored === null ? null : canonicalJson(JSON.parse(JSON.stringify(stored)));
    const requestedGrant = requested ? canonicalJson(JSON.parse(JSON.stringify(requested))) : null;
    return storedGrant === requestedGrant;
}

/**
 * A test bench's expected end (G4), as stored in its creation config (agentTest.expect) or requested: { state } or
 * { outcome }; anything else is none, the default (outcome succeeded). chat-test.ts reads a bench's expect with it too.
 */
export function testBenchExpect(value: unknown): { state: string } | { outcome: string } | null {
    if (!isJsonObject(value)) return null;
    if (typeof value.state === "string" && value.state) return { state: value.state };
    if (typeof value.outcome === "string" && value.outcome) return { outcome: value.outcome };
    return null;
}

/**
 * RLR-F6: the same test bench: both none, or the same definition, revision and expected end (none on both: the default,
 * outcome succeeded). Its YAML is in the creation fingerprint; these are not, so a replay is compared with the stored ones.
 */
function sameTestBench(stored: unknown, requested: CreateWorkflowV2Request["testBench"]): boolean {
    const identity = (bench: unknown): string | null => isJsonObject(bench)
        ? canonicalJson({ definitionId: typeof bench.definitionId === "string" ? bench.definitionId : null,
            revision: typeof bench.revision === "number" ? bench.revision : null, expect: testBenchExpect(bench.expect) })
        : null;
    return identity(stored) === identity(requested ? { definitionId: requested.definitionId, revision: requested.revision, expect: requested.expect ?? null } : null);
}

function sameOwner(stored: SessionOwnerInfo | null | undefined, requested: SessionOwnerInfo | null | undefined): boolean {
    if (!stored || !requested) return !stored && !requested;
    return stored.provider === requested.provider && stored.subject === requested.subject;
}

/** Create a workflow child: a draft by default; optionally published and started atomically. */
export async function createWorkflowV2(host: WorkflowV2Host, request: CreateWorkflowV2Request): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
    requireOperationId(request.operationId);
    requireStorableYaml(request.yaml);
    const compiled = compileWorkflowV2ForHost(host, request.yaml);
    // Stage 2.0: script nodes on a host that runs none are refused at save, before the claim (scripts-gate.ts).
    requireWorkflowScripts(host, compiled.ir, request.start ? "start" : "save");
    const publish = request.publish === true || Boolean(request.start);
    // Every refusal of the request itself comes before the claim below, so a refused request leaves no session row and no
    // claim on its key: the corrected request may use the same key (a definition published or started with compile errors
    // is refused here, as the store refuses it).
    requirePublishable(compiled, publish);
    const startInputs = request.start ? request.start.inputs : null;
    if (request.start) validateRunInputs(compiled.ir, compiled.irSha256, request.start.inputs);
    // OF-S2-7: the agent nodes' models chosen at start, against exactly this revision and the owning chat's catalog (the
    // identity that spends: the Workflow's effective owner, never the caller's; OF7-R1).
    const agentModels = request.start
        ? startAgentModels(request.start.agentModels, compiled.ir,
            request.chatPin ? `revision ${request.chatPin.revision} of ${compiled.name ?? "this definition"}` : compiled.name ?? "this Workflow") : null;
    // Built before anything is written: inputs or vars over their limits refuse the request without a claim.
    const admission = request.start ? liveAdmission(host, request.workflowSessionId, request.start.inputs, request.start.vars ?? null, agentModels) : null;
    // A definition published at creation pins its named agents first: one that cannot be resolved refuses the request
    // before anything is written.
    const agentPinsText = publish && compiled.valid ? await publicationAgentPins(host, compiled.ir, request.parentSessionId ?? request.workflowSessionId) : null;
    const fingerprints = createFingerprints(request, compiled.yamlSha256, publish, startInputs);
    const requestSha256 = fingerprints.v3;
    // Digests a stored receipt of this request may carry (receipts are never rewritten).
    let acceptedRequestSha256: string[] = [requestSha256];
    // A deleted workflow keeps its definition tombstone; its id is never reused.
    const tombstone = await host.store.readDefinition(request.workflowSessionId);
    if (tombstone?.state === "deleted") throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow id was deleted and cannot be reused.");
    // The catalog check (review D4): a Workflow that exists already is a repeat of this request (answered from what it made)
    // or another request (refused by the store); only a new one is checked.
    if (!tombstone) {
        await startCatalogCheck(host, agentModels, () => workflowSpendingOwner(host, { workflowSessionId: request.workflowSessionId,
            owner: request.owner ?? null, parentSessionId: request.parentSessionId }));
    }
    // One name and version, one definition, among the parent's Workflows (SEMVER_REUSED): checked inside the claim's
    // transaction, once the row is claimed, under a lock on (parent, name). Two creations at the same moment are serialized,
    // and the later one sees the earlier one's claim; a refusal rolls its own claim back, so it binds no row and no key and
    // the corrected request may use the same id. A replay (the row exists) claims nothing and is not checked.
    const parentId = request.parentSessionId;
    const versionGuard = request.refuseVersionReuse === true && tombstone === null && parentId && compiled.name && compiled.version
        ? { parentSessionId: parentId, workflowSessionId: request.workflowSessionId, name: compiled.name, semver: compiled.version,
            yamlSha256: compiled.yamlSha256, irSha256: compiled.irSha256, nothingSaved: "Nothing was saved." }
        : null;
    // The session row is claimed exclusively: an existing row of any kind,
    // or one a concurrent creator inserts first, is never modified here.
    if (!host.catalog.createWorkflowSessionV2) throw new WorkflowStoreError("WORKFLOW_V2_UNAVAILABLE", "This session catalog cannot create Workflows.");
    const claim = await host.catalog.createWorkflowSessionV2(request.workflowSessionId, {
        parentSessionId: request.parentSessionId,
        owner: request.owner ?? null,
        creationConfig: {
            // The name, version and hashes are what a concurrent creation's version check reads until the definition is stored.
            workflowV2: { apiVersion: WORKFLOW_V2_API_VERSION, fingerprint: WORKFLOW_V2_CREATE_FINGERPRINT, requestSha256, operationId: request.operationId,
                ...(compiled.name ? { name: compiled.name } : {}), ...(compiled.version ? { version: compiled.version } : {}),
                yamlSha256: compiled.yamlSha256, ...(compiled.irSha256 ? { irSha256: compiled.irSha256 } : {}),
                // S2RT-F5: a chat Start's pin is part of its creation's identity: a replay continues only with this pin.
                ...(request.chatPin ? { chatPin: { definitionId: request.chatPin.definitionId, revision: request.chatPin.revision } } : {}) },
            ...(request.binding ? { workflowToolBinding: request.binding } : {}),
            ...(request.testBench ? { agentTest: { definitionId: request.testBench.definitionId, revision: request.testBench.revision,
                ...(request.testBench.expect ? { expect: request.testBench.expect } : {}) } } : {}),
        },
        ...(versionGuard || (request.childBudget && parentId) || (request.testBench && parentId) ? { afterClaim: async (client: PoolClient) => {
            // S2RT-F6: a test bench is made only while its chat is live and its definition is not deleted, under their locks.
            if (request.testBench && parentId) {
                await requireBenchLiveLocked(client, host.store.chat.schema, { ownerSessionId: parentId, definitionId: request.testBench.definitionId });
            }
            if (request.childBudget && parentId) await host.store.chat.requireChildBudgetLocked(client, parentId, request.workflowSessionId, request.childBudget.max);
            if (versionGuard) await host.store.requireVersionFreeLocked(client, versionGuard);
        } } : {}),
        // The bench's definition is its creation config's agentTest; service_of (a session's uuid) names no session here, and an
        // imported definition's id ('imported-…') is not a uuid (e26fbc12 run).
        ...(request.testBench ? { service: { kind: WORKFLOW_TEST_BENCH_KIND, of: null } } : {}),
    });
    if (!claim.created) {
        // Only a retry of this exact creation (interrupted before its
        // definition or receipt) may continue on an existing row.
        const [row, creation] = await Promise.all([
            host.catalog.getSession(request.workflowSessionId),
            host.catalog.getSessionCreationConfig?.(request.workflowSessionId) ?? null,
        ]);
        const marker = creation?.workflowV2;
        if (!row || row.deletedAt || row.sessionKind !== "workflow" || (row.parentSessionId ?? null) !== request.parentSessionId
            || !isJsonObject(marker)) {
            throw new WorkflowStoreError("SESSION_EXISTS",
                `Session ${request.workflowSessionId} already exists and is not this parent's Workflow; nothing was changed.`);
        }
        // Compare with the fingerprint the claim recorded; what it did not
        // cover (the owner, the first grant) must match the stored row.
        const grantMatches = sameGrant(creation?.workflowToolBinding, request.binding);
        // A creation that named no owner took its parent's (the claim inherits it): its replay is compared with that owner.
        const inherited = !request.owner && request.parentSessionId ? (await host.catalog.getSession(request.parentSessionId))?.owner ?? null : null;
        const ownerMatches = sameOwner(row.owner, request.owner ?? inherited);
        let sameRequest: boolean;
        if (marker.fingerprint === WORKFLOW_V2_CREATE_FINGERPRINT) {
            sameRequest = marker.requestSha256 === fingerprints.v3 && marker.operationId === request.operationId && grantMatches && ownerMatches;
        } else if (marker.fingerprint === undefined && typeof marker.requestSha256 === "string") {
            // An unstated version is version 2 or version 3: accept only the
            // digest this request has under one of them.
            const asVersion = marker.requestSha256 === fingerprints.v3 ? 3 : marker.requestSha256 === fingerprints.v2 ? 2 : null;
            sameRequest = asVersion !== null && marker.operationId === request.operationId && grantMatches && ownerMatches;
            acceptedRequestSha256 = asVersion === 2 ? [fingerprints.v3, fingerprints.v2] : [fingerprints.v3];
        } else if (marker.fingerprint === undefined && marker.requestSha256 === undefined && marker.operationId === undefined) {
            sameRequest = grantMatches && ownerMatches;
            acceptedRequestSha256 = [fingerprints.v3, fingerprints.v1];
        } else {
            throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Workflow ${request.workflowSessionId} has a creation record this build cannot read.`);
        }
        // S2RT-F5: a claim that recorded a chat pin continues only with that pin (a claim of an earlier build records none).
        if (sameRequest && isJsonObject(marker.chatPin) && (!request.chatPin || marker.chatPin.definitionId !== request.chatPin.definitionId
            || marker.chatPin.revision !== request.chatPin.revision)) {
            sameRequest = false;
        }
        if (!sameRequest) {
            throw new WorkflowStoreError("WORKFLOW_EXISTS",
                `Workflow ${request.workflowSessionId} was created by a different request; use another key for another workflow.`);
        }
        // RLR-F6: a test bench's test (its definition, revision and expected end) is part of what was asked: a replay that
        // names another is another request, refused before anything else is made (no new run; the stored test is unchanged).
        if (!sameTestBench(creation?.agentTest, request.testBench)) {
            throw new WorkflowStoreError("WORKFLOW_EXISTS", `Test ${request.workflowSessionId} was started by a different request (another revision or `
                + "expect) under this operation; nothing was tested. Start another test for another expectation.");
        }
    }
    const stored = await host.store.createDefinition({
        workflowSessionId: request.workflowSessionId,
        parentSessionId: request.parentSessionId,
        notifyParent: request.notifyParent !== false,
        yaml: request.yaml,
        compiled,
        actor: request.actor,
        operationId: request.operationId,
        requestSha256,
        acceptedRequestSha256,
        publish,
        start: admission,
        title: `Workflow: ${compiled.name ?? "draft"}`,
        ...(agentPinsText !== null ? { agentPinsText } : {}),
        // Review SDK3-F3: a resumed claim (this request found its row) was not checked when it was made, or was made by an
        // earlier build that records no version: its definition is checked when it is stored.
        ...(versionGuard && !claim.created ? { versionGuard: { ...versionGuard, nothingSaved: "Nothing was saved: the claim stays without a definition." } } : {}),
        ...(request.chatPin ? { chatPin: request.chatPin } : {}),
    });
    await dispatchWorkflowV2Run(host, stored.receipt);
    return stored;
}

export type WorkflowV2Command =
    | { operation: "replace_definition"; yaml: string; expectedRevision: number }
    | { operation: "publish"; expectedRevision: number; definitionHash: string }
    | { operation: "publish_and_start"; expectedRevision: number; definitionHash: string; inputs: JsonValue; vars?: { [key: string]: JsonValue }; notifyParent?: boolean;
        /** OF7-R3: agent node models chosen at start (agent-models.ts), as given; checked like every start's. */
        agentModels?: unknown }
    | { operation: "start"; definitionHash: string; inputs: JsonValue; vars?: { [key: string]: JsonValue }; notifyParent?: boolean; agentModels?: unknown };

/**
 * Whether a live start tells the parent the run's result (batch 7, n-1): unless the start says false, a live start turns
 * the workflow's parent notification on (a draft spawned with it off included). Part of the request's digest only when
 * false, so a start without it keeps the digest earlier builds recorded for it.
 */
function notifyDigestPart(notifyParent: boolean | undefined): { notifyParent?: false } {
    return notifyParent === false ? { notifyParent: false } : {};
}

/** Apply one typed definition-lifecycle command with idempotency by operation id. */
export async function updateWorkflowV2(
    host: WorkflowV2Host,
    workflowSessionId: string,
    command: WorkflowV2Command,
    context: { actor: WorkflowActor; operationId: string; refuseVersionReuse?: boolean },
): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
    requireOperationId(context.operationId);
    let stored: StoredOperation<WorkflowDefinitionReceipt>;
    if (command.operation === "replace_definition") {
        requireStorableYaml(command.yaml);
        const compiled = compileWorkflowV2ForHost(host, command.yaml);
        requireWorkflowScripts(host, compiled.ir, "save");
        stored = await host.store.replaceDraft({
            workflowSessionId, expectedRevision: command.expectedRevision, yaml: command.yaml, compiled,
            declaredSemver: compiled.version ?? declaredSemver(command.yaml), actor: context.actor, operationId: context.operationId,
            requestSha256: jsonSha256({ kind: "replace_definition", yamlSha256: compiled.yamlSha256, expectedRevision: command.expectedRevision }),
            title: `Workflow: ${compiled.name ?? "draft"}`,
            ...(context.refuseVersionReuse === true ? { refuseVersionReuse: true } : {}),
        });
        return stored;
    }
    if (command.operation === "publish" || command.operation === "publish_and_start") {
        await requireRunsRevision(host, workflowSessionId, command.expectedRevision);
        // The operation decides whether a run starts; any JSON input, null included, is a value.
        const startInputs: { value: JsonValue } | null = command.operation === "publish_and_start" ? { value: command.inputs } : null;
        // The revision to publish: its inputs are checked for a start, and on a host that resolves agents its named agents
        // are pinned (a publication refused there writes nothing; the store decides the revision, hash and state again).
        const readsIr = command.operation === "publish_and_start" || host.resolveAgent !== undefined || host.scripts === false;
        const revision = readsIr ? await host.store.readRevision(workflowSessionId, command.expectedRevision) : null;
        const revisionIr = revision?.valid && revision.irSha256
            ? await host.store.readRevisionIr(workflowSessionId, command.expectedRevision, revision.irSha256, irOptionsFor(host)) : null;
        if (command.operation === "publish_and_start" && revisionIr && revision?.irSha256) {
            validateRunInputs(revisionIr, revision.irSha256, command.inputs);
        }
        requireWorkflowScripts(host, revisionIr, command.operation === "publish_and_start" ? "start" : "save");
        // OF7-R3: a publish_and_start's agent models, against exactly the revision it publishes and the owning chat's catalog.
        const agentModels = command.operation === "publish_and_start"
            ? startAgentModels(command.agentModels, revisionIr, `revision ${command.expectedRevision}`) : null;
        const definition = revisionIr ? await host.store.readDefinition(workflowSessionId) : null;
        const agentPinsText = revisionIr && definition?.state === "draft"
            ? await publicationAgentPins(host, revisionIr, definition.parentSessionId ?? workflowSessionId) : null;
        const publishSha256 = jsonSha256({ kind: command.operation, expectedRevision: command.expectedRevision, definitionHash: command.definitionHash,
            ...(startInputs ? { inputs: canonicalJson(startInputs.value) } : {}),
            ...(command.operation === "publish_and_start" ? { ...varsDigestPart(command.vars), ...notifyDigestPart(command.notifyParent),
                ...agentModelsDigestPart(agentModels) } : {}) });
        // Review D4: the catalog is checked for a request no stored receipt answers yet.
        if (agentModels && !await host.store.readOperationReceipt(workflowSessionId, context.operationId, command.operation, publishSha256)) {
            await startCatalogCheck(host, agentModels, () => workflowSpendingOwner(host, { workflowSessionId }));
        }
        stored = await host.store.publish({
            workflowSessionId, expectedRevision: command.expectedRevision, definitionHash: command.definitionHash,
            operationId: context.operationId,
            requestSha256: publishSha256,
            start: startInputs ? liveAdmission(host, workflowSessionId, startInputs.value, command.operation === "publish_and_start" ? command.vars ?? null : null,
                agentModels) : null,
            ...(command.operation === "publish_and_start" ? { notifyParent: command.notifyParent !== false } : {}),
            ...(agentPinsText !== null ? { agentPinsText } : {}),
        });
    } else {
        const definition = await host.store.readDefinition(workflowSessionId);
        await requireRunsRevision(host, workflowSessionId, definition?.publishedRevision ?? null);
        let publishedIr: WorkflowIR | null = null;
        if (definition?.state === "published" && definition.publishedRevision !== null && definition.publishedIrSha256) {
            publishedIr = await host.store.readRevisionIr(workflowSessionId, definition.publishedRevision, definition.publishedIrSha256, irOptionsFor(host));
            validateRunInputs(publishedIr, definition.publishedIrSha256, command.inputs);
            requireWorkflowScripts(host, publishedIr, "start");
        }
        // OF7-R3: a start's agent models, against exactly the published revision and the owning chat's catalog.
        const agentModels = startAgentModels(command.agentModels, publishedIr, `revision ${definition?.publishedRevision ?? "(none published)"}`);
        const startSha256 = jsonSha256({ kind: "start", definitionHash: command.definitionHash, inputs: canonicalJson(command.inputs), ...varsDigestPart(command.vars),
            ...notifyDigestPart(command.notifyParent), ...agentModelsDigestPart(agentModels) });
        // Review D4: the catalog is checked for a request no stored receipt answers yet.
        if (agentModels && !await host.store.readOperationReceipt(workflowSessionId, context.operationId, "start", startSha256)) {
            await startCatalogCheck(host, agentModels, () => workflowSpendingOwner(host, { workflowSessionId }));
        }
        stored = await host.store.startLive({
            workflowSessionId, definitionHash: command.definitionHash, operationId: context.operationId,
            requestSha256: startSha256,
            start: liveAdmission(host, workflowSessionId, command.inputs, command.vars ?? null, agentModels),
            notifyParent: command.notifyParent !== false,
        });
    }
    if (stored.receipt.run) await dispatchWorkflowV2Run(host, stored.receipt);
    return stored;
}

export type WorkflowV2RunCommand =
    | { operation: "set_vars"; runId: string | null; set: { [key: string]: JsonValue }; delete: string[]; expectedKvRevision: number }
    | { operation: "pause" | "resume" | "cancel"; runId: string | null; reason: string | null }
    /** A graceful stop (controller 1.9.0 only): graceSeconds null is the default grace. */
    | { operation: "stop"; runId: string | null; reason: string | null; graceSeconds: number | null };

/** The grace a stop gives a run's admitted work to settle when the request names none (design D03; at most WORKFLOW_V2_STOP_MAX_GRACE_SECONDS). */
export const WORKFLOW_V2_STOP_DEFAULT_GRACE_SECONDS = 60;

/** The run a run command targets: the named run of this workflow, or its live run. */
async function commandRun(host: Pick<WorkflowV2Host, "store">, workflowSessionId: string, runId: string | null): Promise<WorkflowRunRow> {
    const runs = await host.store.listRuns(workflowSessionId);
    const run = runId ? runs.find(item => item.runId === runId) : runs.find(item => item.mode === "live");
    if (!run) throw new WorkflowStoreError("RUN_NOT_FOUND", runId ? `Run ${runId} is not a run of this workflow.` : "This workflow has no live run.");
    return run;
}

/**
 * Apply one run command with idempotency by operation id:
 * - set_vars: one atomic set/delete batch on the run's open KV at the
 *   expected revision (null is a value; deletion is explicit);
 * - pause / resume: stop or restart admitting node executions (admitted work
 *   finishes; a cancel, a deletion and KV updates still apply while paused);
 * - cancel: send the run's controller its cancel command. The receipt says
 *   the command was accepted, not that the run has ended: the first
 *   run-ending transaction decides, and read_workflow shows the result;
 * - stop (controller 1.9.0 only; every new run starts there): a graceful
 *   stop. The store records it once, with its deadline
 *   (the store's clock plus the grace), for a run admitted for a controller
 *   that stops (store.requestRunStop): the run admits no new state, its
 *   admitted work may settle until the deadline, and then its controller
 *   ends it stopped, cancelling what is still pending. The controller is
 *   told at once (a hint; its backstop collection finds the stop too). The
 *   receipt says the stop was accepted, not that the run has ended.
 */
export async function controlWorkflowV2Run(
    host: Pick<WorkflowV2Host, "store" | "duroxideClient">,
    workflowSessionId: string,
    command: WorkflowV2RunCommand,
    context: { actor: WorkflowActor; operationId: string },
): Promise<StoredOperation<WorkflowRunCommandReceipt>> {
    requireOperationId(context.operationId);
    const run = await commandRun(host, workflowSessionId, command.runId);
    if (command.operation === "set_vars") {
        for (const key of [...Object.keys(command.set), ...command.delete]) {
            if (!isKvKey(key)) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "KV keys are 1-128 characters of valid text.");
        }
        if (new Set(command.delete).size !== command.delete.length || command.delete.some(key => Object.hasOwn(command.set, key))) {
            throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "delete must list distinct keys that set does not also name.");
        }
        return host.store.setRunVars({
            workflowSessionId, runId: run.runId, set: command.set, delete: command.delete, expectedRevision: command.expectedKvRevision,
            operationId: context.operationId, actor: context.actor,
            requestSha256: jsonSha256({ kind: "set_vars", runId: run.runId, set: canonicalJson(command.set), delete: [...command.delete].sort(),
                expectedRevision: command.expectedKvRevision }),
        });
    }
    if (command.operation === "stop") {
        const graceSeconds = command.graceSeconds ?? WORKFLOW_V2_STOP_DEFAULT_GRACE_SECONDS;
        const stored = await host.store.requestRunStop({
            workflowSessionId, runId: run.runId, operationId: context.operationId, actor: context.actor, reason: command.reason, graceSeconds,
            requestSha256: jsonSha256({ kind: "stop", runId: run.runId, reason: command.reason, graceSeconds }),
            stoppableVersions: WORKFLOW_V2_STOP_CONTROLLER_VERSIONS,
        });
        // The stop is stored first, so a repeat of the request sends this hint again; a wake changes nothing by itself.
        if (ACTIVE_RUN_STATUSES.includes(stored.run.status)) {
            await host.duroxideClient.enqueueEvent(stored.run.controllerInstanceId, WORKFLOW_COMMAND_QUEUE,
                JSON.stringify({ type: "workflow-wake", runId: stored.run.runId, reason: "stop" }));
        }
        return { receipt: stored.receipt, replayed: stored.replayed };
    }
    const requestSha256 = jsonSha256({ kind: command.operation, runId: run.runId, reason: command.reason });
    if (command.operation === "cancel") {
        // Without a reason, the run's end names who cancelled it: its parent agent, a person (updateWorkflow, R26), or an
        // operator's own client (a management client without a principal).
        const reason = command.reason ?? (context.actor.kind === "agent" ? "Cancelled by its parent"
            : context.actor.kind === "user" ? "Cancelled by a person" : "Cancelled by an operator");
        const requestedBy = context.actor.kind === "agent" ? context.actor.sessionId : null;
        const stored = await host.store.recordRunCancelRequest({ workflowSessionId, runId: run.runId, operationId: context.operationId, requestSha256,
            reason, requestedBy, actor: context.actor });
        // S7-DX2: the store ended a begun run as it accepted the cancel. Its controller is told at once (a repeat tells it
        // again): the command, as before, which it applies to the ended run (its post-end work) when it reads it; if this
        // message is late or lost, its next store call finds the run ended and does the same.
        if (ACTIVE_RUN_STATUSES.includes(stored.run.status) || commandEndOf(stored.run)?.operationId === context.operationId) {
            await host.duroxideClient.enqueueEvent(stored.run.controllerInstanceId, WORKFLOW_COMMAND_QUEUE, JSON.stringify({
                type: "cmd", cmd: "cancel", id: `cancel-${context.operationId}`, args: { reason }, requestedBy,
            }));
        } else {
            // The run has ended. When this request ended it before it began, its parent is told by the
            // controller's rule; for any other end this does nothing.
            await notifyCancelledBeforeBegin(host, stored.run, context.operationId, requestedBy);
        }
        return { receipt: stored.receipt, replayed: stored.replayed };
    }
    const stored = await host.store.setRunPaused({
        workflowSessionId, runId: run.runId, pause: command.operation === "pause", operationId: context.operationId,
        requestSha256, actor: context.actor, reason: command.reason,
    });
    // Resume: tell the waiting controller at once (its backstop timer would
    // also find it). The resume is stored first, so a repeat of the request
    // sends this hint again; a wake changes nothing by itself.
    if (command.operation === "resume") {
        const current = await host.store.readRun(run.runId);
        if (current && ADMITTING_RUN_STATUSES.includes(current.status)) {
            await host.duroxideClient.enqueueEvent(run.controllerInstanceId, WORKFLOW_COMMAND_QUEUE,
                JSON.stringify({ type: "workflow-wake", runId: run.runId, reason: "resume" }));
        }
    }
    return stored;
}

/** The operation id prefix of a receipt that a parent session's lifecycle command stored. */
export const SESSION_COMMAND_OPERATION_PREFIX = "session-command:";

/** A lifecycle command a durable session sends to one of its children (cancel_agent, delete_agent, the shutdown cascade). */
function parseSessionLifecycleCommand(raw: unknown): { cmd: "cancel" | "done" | "delete"; id: string; reason: string | null; requestedBy: string | null } | null {
    if (!isJsonObject(raw) || raw.type !== "cmd") return null;
    const { cmd, id, args, requestedBy } = raw;
    if (cmd !== "cancel" && cmd !== "done" && cmd !== "delete") return null;
    if (typeof id !== "string" || !id.trim()) return null;
    const reason = isJsonObject(args) && typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : null;
    return { cmd, id, reason, requestedBy: typeof requestedBy === "string" && requestedBy ? requestedBy : null };
}

/**
 * A lifecycle command (cancel, done or delete) that a parent's durable
 * session sends to a child through the sendCommandToSession activity. The
 * command waits in the child orchestration's queue, but a v2 workflow child
 * may have no controller to read it: its live run has not begun (duroxide
 * drops a queue message for an instance that has not started), or it has no
 * run. So, for a v2 workflow child only:
 * - the caller is the session of the orchestration that runs the activity
 *   (its instance id `session-<id>`, set by the runtime), never the
 *   command's requestedBy alone; it must be the child's parent in both its
 *   session row and its definition, and a requestedBy must name it too;
 * - the store applies the command once per operation id
 *   (SESSION_COMMAND_OPERATION_PREFIX plus the command's id, which the
 *   orchestration derives deterministically), in one transaction
 *   (store.recordSessionCommand): delete always soft-deletes the child (the
 *   deletion trigger tombstones it and ends an active run in that
 *   transaction; a run that already ended keeps its result), then its facts
 *   are removed; cancel and done end an active run there (done keeps its
 *   "Stopped" meaning): one that has not begun as before, one that has
 *   begun as its controller's cancel would (S7-DX2), and then the caller
 *   queues the command for that controller, which finds the run ended and
 *   finishes (it stops cancelled effects, ends agent children, tells the
 *   parent unless the parent asked);
 * - a retry of the activity replays the receipt: it queues a cancel or done
 *   again for the run it ended (or, for a receipt an older build stored as
 *   queued, ends that run if it is still active), and applies an accepted
 *   delete whose child is still live, then the facts cleanup; another request
 *   with that id fails.
 * Every other target (an ordinary agent session, a legacy workflow) returns
 * "enqueue": the caller queues the command as before.
 */
export async function applySessionCommandToWorkflowV2(
    host: WorkflowLifecycleCommandHost,
    request: { callerInstanceId: string; targetSessionId: string; command: unknown },
): Promise<WorkflowLifecycleCommandResult> {
    return applyLifecycleCommandToWorkflowV2(host, { targetSessionId: request.targetSessionId, command: request.command, caller: { instanceId: request.callerInstanceId } });
}

/** The operation id prefix of a receipt that an operator's lifecycle command stored (applyOperatorCommandToWorkflowV2). */
export const OPERATOR_COMMAND_OPERATION_PREFIX = "operator-command:";

/**
 * A lifecycle command (cancel, done or delete) from an operator path that has authorized it itself: the management API's
 * cancelSession, completeSession and deleteSession, and the agent manager's manage_agent_session (S7-DX2 follow-up). For a
 * v2 workflow it is applied in the store as a parent's is (applySessionCommandToWorkflowV2: delete deletes the workflow,
 * cancel and done end an active run), once per command id (OPERATOR_COMMAND_OPERATION_PREFIX), with no requester (the
 * parent is told of the end); the caller then queues the command only when the result says "enqueue". Any other session
 * (an agent, a legacy workflow) returns "enqueue": the caller queues the command as before.
 */
export async function applyOperatorCommandToWorkflowV2(
    host: WorkflowLifecycleCommandHost,
    request: { targetSessionId: string; command: unknown },
): Promise<WorkflowLifecycleCommandResult> {
    return applyLifecycleCommandToWorkflowV2(host, { targetSessionId: request.targetSessionId, command: request.command, caller: null });
}

/**
 * The store, how a deleted workflow session's facts are removed, and (an operator path) the durable client that tells
 * the parent of a run its command ended before the run began, for a lifecycle command.
 */
export interface WorkflowLifecycleCommandHost {
    store: WorkflowStore;
    deleteSessionFacts?: ((sessionId: string) => Promise<unknown>) | null;
    duroxideClient?: Pick<WorkflowV2Host["duroxideClient"], "startOrchestrationVersioned"> | null;
}

/** "enqueue": the caller queues the command; "applied": the store applied it, and nothing is queued. */
export type WorkflowLifecycleCommandResult = { action: "enqueue" } | { action: "applied"; receipt: WorkflowSessionCommandReceipt | null };

/**
 * applySessionCommandToWorkflowV2 and applyOperatorCommandToWorkflowV2: `caller` is the parent's orchestration instance
 * (only the workflow's parent may send it, and a requestedBy must name it), or null for an operator path (no parent check,
 * no requester).
 */
async function applyLifecycleCommandToWorkflowV2(
    host: WorkflowLifecycleCommandHost,
    request: { targetSessionId: string; command: unknown; caller: { instanceId: string } | null },
): Promise<WorkflowLifecycleCommandResult> {
    const command = parseSessionLifecycleCommand(request.command);
    if (!command) return { action: "enqueue" };
    const link = await host.store.readSessionLink(request.targetSessionId);
    if (!link || link.sessionKind !== "workflow") return { action: "enqueue" };
    const definition = await host.store.readDefinition(request.targetSessionId);
    if (!definition) return { action: "enqueue" };
    let caller: string | null = null;
    if (request.caller !== null) {
        const instanceId = request.caller.instanceId;
        caller = instanceId.startsWith("session-") ? instanceId.slice("session-".length) : null;
        if (!caller || link.parentSessionId !== caller || definition.parentSessionId !== caller || (command.requestedBy !== null && command.requestedBy !== caller)) {
            throw new WorkflowStoreError("FORBIDDEN", `Only the session that created workflow ${request.targetSessionId} may send it ${command.cmd}.`);
        }
    }
    const workflowSessionId = request.targetSessionId;
    const operationId = `${request.caller === null ? OPERATOR_COMMAND_OPERATION_PREFIX : SESSION_COMMAND_OPERATION_PREFIX}${command.id}`;
    const requestSha256 = jsonSha256({ kind: `session-${command.cmd}`, reason: command.reason });
    /**
     * The child is deleted: found deleted, or deleted after the link was read
     * (by this command's own earlier attempt, a retry that overlapped it, or
     * another path) and seen when the store took its session lock. Both cases
     * take this one path. A receipt under this operation id for another
     * request is refused (OPERATION_CONFLICT). The child's run has ended (the
     * deletion ended it), which is what a cancel or done asks for; a delete
     * also removes the child's facts, as every deletion path does (it is
     * idempotent), so an attempt lost after its commit and before this
     * cleanup is completed here.
     */
    const deletedChild = async (): Promise<{ action: "applied"; receipt: WorkflowSessionCommandReceipt | null }> => {
        const prior = await host.store.readOperationReceipt(workflowSessionId, operationId, `session-${command.cmd}`, requestSha256);
        if (command.cmd === "delete" && host.deleteSessionFacts) await host.deleteSessionFacts(workflowSessionId);
        return { action: "applied", receipt: prior === null ? null : parseSessionCommandReceipt(prior) };
    };
    if (link.deleted) return deletedChild();
    let stored: Awaited<ReturnType<WorkflowStore["recordSessionCommand"]>>;
    try {
        stored = await host.store.recordSessionCommand({
            workflowSessionId, operationId, requestSha256, command: command.cmd,
            reason: command.reason ?? (command.cmd === "done" ? "Stopped" : command.cmd === "delete" ? "Deleted" : "Cancelled"), requestedBy: caller,
        });
    } catch (error) {
        if (error instanceof WorkflowStoreError && error.code === "WORKFLOW_DELETED") return deletedChild();
        throw error;
    }
    const { receipt, run } = stored;
    if (command.cmd === "delete") {
        // The store deleted the child in this call (or a repeat found an accepted delete and applied it): remove its facts.
        if (host.deleteSessionFacts) await host.deleteSessionFacts(workflowSessionId);
        return { action: "applied", receipt };
    }
    // S7-DX2: a cancel or done that ended a begun run in the store is queued for its controller too (a repeat queues it
    // again), which applies it to the ended run (its post-end work); a run still active (an older receipt the store could
    // not apply) keeps it queued as before.
    if (stored.wake || (receipt.applied === "queued" && run !== null && ACTIVE_RUN_STATUSES.includes(run.status))) return { action: "enqueue" };
    // A run this command ended before it began has no controller to tell its parent: the parent is told here, unless the
    // parent sent it (an operator's command, with the durable client; a repeat tells it again, at least once).
    if (run !== null && host.duroxideClient) await notifyCancelledBeforeBegin({ store: host.store, duroxideClient: host.duroxideClient }, run, operationId, caller);
    return { action: "applied", receipt };
}

/**
 * Bounds on a run's inbox, proposed defaults (D07): unclaimed messages a run
 * holds, of them from one sender, and one sender's inputs to one workflow in
 * the rate window.
 */
export const WORKFLOW_V2_INBOX_LIMITS: WorkflowInboxLimits = { maxUnconsumed: 100, maxUnconsumedPerSender: 20, maxPerSenderPerWindow: 60, windowSeconds: 600 };

/**
 * send_workflow_input: give a run of a v2 workflow one typed input (R07,
 * R08). The sender is the session the adapter names as the caller, never a
 * field of the request, and it must be allowed (authority.ts): the
 * workflow's live parent, or a live session of the same user as the
 * workflow (both owned by that user; unknown or system ownership grants
 * nothing). That is checked here on the catalog's rows, and a fresh input
 * again under the session locks when it is accepted, so a sender deleted
 * in between is refused; a repeat is answered only when the check here
 * allows its sender. The run is
 * the one named, or the live run. Its pinned definition must have a receive
 * state for the contract (an undeclared contract is refused as
 * UNSUPPORTED_CONTRACT), and the payload must satisfy the contract's schema
 * (INPUT_INVALID, nothing stored). The store accepts it once per (workflow,
 * sender, operation id) and a waiting receive takes it in the same
 * transaction (store.acceptInput); an input no receive waits for is kept,
 * in the run's order, until one takes it or it expires. The receipt is the
 * acceptance's, stored with the input: a repeat returns it unchanged. When a
 * receive took the input as it was accepted, the run's controller gets a
 * wake (a hint; its backstop timer finds the result too); a repeat of the
 * request sends the wake again.
 */
export async function sendWorkflowInputV2(host: TypedInputHost, request: TypedInputRequest): Promise<StoredOperation<WorkflowInputReceipt>> {
    return acceptTypedInput(host, request, null);
}

/**
 * A send state's message given to its workflow recipient as typed input,
 * from the sending workflow: send_workflow_input's checks and acceptance with
 * the message's frozen contract, correlation and payload, the exchange id as
 * the operation id, the recipient's live run and the default ttl. The
 * acceptance is bound to the send (store.acceptInput sendExchangeId): the
 * recipient takes no fresh input for a send decided first (SEND_DECIDED), and
 * a repeat of an acceptance made before is answered as any repeat. Only the
 * send's delivery calls this; no public request carries that binding.
 */
export async function acceptSendAsWorkflowInputV2(host: TypedInputHost, message: WorkflowOutboxMessage): Promise<StoredOperation<WorkflowInputReceipt>> {
    return acceptTypedInput(host, {
        workflowSessionId: message.recipientSessionId, senderSessionId: message.workflowSessionId, runId: null, contract: message.contract,
        correlation: message.correlation, payload: message.payload, ttlSeconds: null, operationId: message.exchangeId,
    }, message.exchangeId);
}

type TypedInputHost = { catalog: Pick<SessionCatalog, "getSession">; store: WorkflowStore; duroxideClient: Pick<WorkflowV2Host["duroxideClient"], "enqueueEvent"> };

interface TypedInputRequest {
    workflowSessionId: string;
    senderSessionId: string;
    runId?: string | null;
    contract: string;
    correlation?: JsonValue;
    payload: JsonValue;
    ttlSeconds?: number | null;
    operationId: string;
}

async function acceptTypedInput(host: TypedInputHost, request: TypedInputRequest, sendExchangeId: string | null)
    : Promise<StoredOperation<WorkflowInputReceipt>> {
    requireOperationId(request.operationId);
    const { workflowSessionId, senderSessionId } = request;
    const definition = await host.store.readDefinition(workflowSessionId);
    if (!definition) throw new WorkflowStoreError("WORKFLOW_NOT_FOUND", `Session ${workflowSessionId} is not a durable Workflow.`);
    if (definition.state === "deleted") throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow was deleted.");
    // An earlier refusal on the catalog's rows; a fresh input is decided again
    // when it is accepted, under the session locks (store.acceptInput).
    const authority = await typedInputAuthority(host.catalog, host.store, workflowSessionId, senderSessionId);
    if (authority !== "allowed") throw new WorkflowStoreError("FORBIDDEN", TYPED_INPUT_REFUSALS[authority]);
    const runs = await host.store.listRuns(workflowSessionId);
    const run = request.runId ? runs.find(item => item.runId === request.runId) : runs.find(item => item.mode === "live");
    if (!run) throw new WorkflowStoreError("RUN_NOT_FOUND", request.runId ? `Run ${request.runId} is not a run of this workflow.` : "This workflow has no live run to give input to.");
    if (typeof request.contract !== "string") throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "contract must name a contract, such as BuildEvent@1.");
    // Reading the contracts runs nothing: a run of request or agent states (IR 7 and 8) takes input as any run.
    const ir = await host.store.readRevisionIr(workflowSessionId, run.revision, run.irSha256, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
    const contract = ir.contracts?.[request.contract];
    const received = new Set(Object.values(ir.nodes).flatMap(node => node.type === "messaging" && node.mode === "receive" ? [node.contract] : []));
    if (!contract || !received.has(request.contract)) {
        throw new WorkflowStoreError("UNSUPPORTED_CONTRACT", `This workflow does not receive contract '${request.contract}'.`, { receives: [...received].sort() });
    }
    let payloadText: string;
    try { payloadText = boundedCanonicalJson(request.payload, "The input payload"); }
    catch (error) {
        if (error instanceof WorkflowJsonError) throw new WorkflowStoreError("INPUT_INVALID", error.message);
        throw error;
    }
    const problems = schemaSetFor(run.irSha256, ir.schemaDefs).validate(contract.schema, request.payload);
    if (problems.length) {
        throw new WorkflowStoreError("INPUT_INVALID", `The payload does not match contract ${request.contract}.`,
            problems.map(problem => ({ path: problem.path, message: problem.message })));
    }
    const correlationText = correlationTextOf(request.correlation === undefined || request.correlation === null ? {} : request.correlation);
    if (correlationText === null) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `correlation must be a JSON object of at most ${WORKFLOW_V2_MAX_CORRELATION_BYTES} bytes.`);
    }
    const ttlSeconds = request.ttlSeconds ?? WORKFLOW_V2_INPUT_TTL_SECONDS;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > WORKFLOW_V2_INPUT_TTL_SECONDS) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `ttl_seconds must be an integer from 1 to ${WORKFLOW_V2_INPUT_TTL_SECONDS}.`);
    }
    const requestSha256 = typedInputRequestSha256({ runId: run.runId, contract: request.contract, correlationText, payloadText, ttlSeconds });
    const stored = await host.store.acceptInput({
        workflowSessionId, runId: run.runId, messageId: randomUUID(), senderSessionId, operationId: request.operationId, requestSha256,
        contract: request.contract, correlationText, payloadText, ttlSeconds, limits: WORKFLOW_V2_INBOX_LIMITS,
        ...(sendExchangeId !== null ? { sendExchangeId } : {}),
    });
    if (stored.receipt.claimedBy && ACTIVE_RUN_STATUSES.includes(stored.run.status)) {
        await host.duroxideClient.enqueueEvent(stored.run.controllerInstanceId, WORKFLOW_COMMAND_QUEUE,
            JSON.stringify({ type: "workflow-wake", runId: stored.run.runId, reason: "input" }));
    }
    return { receipt: stored.receipt, replayed: stored.replayed };
}

// ─── Test runs (migration 0102; design 05 tool-mocked testing) ───

/** update_workflow operation test: a test run of the exact current revision. */
export interface WorkflowV2TestCommand {
    expectedRevision: number;
    definitionHash: string;
    inputs: JsonValue;
    vars?: { [key: string]: JsonValue };
    agentMode: "mocked" | "real";
    fixtures: WorkflowTestFixture[];
    /** The scenario the test run is for (migration 0103), kept with its results as evidence; null for none. */
    scenario?: string | null;
    /** OF-S2-7: a real-agent test's agent node models (agent-models.ts); a mocked test spawns no agent and takes none. */
    agentModels?: WorkflowAgentModels | null;
}

/** The operation a host that does not run tests refuses, as an unknown operation is refused. */
function requireTestHost(host: Pick<WorkflowV2Host, "requests">): void {
    if (host.requests !== true) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "This build does not run workflow tests.");
}

/** Tell a run's controller to collect at once (a hint; its backstop finds the change too). */
async function wakeRun(host: Pick<WorkflowV2Host, "duroxideClient">, run: Pick<WorkflowRunRow, "controllerInstanceId" | "runId">, reason: string): Promise<void> {
    await host.duroxideClient.enqueueEvent(run.controllerInstanceId, WORKFLOW_COMMAND_QUEUE, JSON.stringify({ type: "workflow-wake", runId: run.runId, reason }));
}

/**
 * A real-agent test run's agent pins (design 05: package identities are
 * pinned just as a live run's are; R18, R19): a test of the published
 * revision takes its publication's pins; a test of a draft is pinned as its
 * publication would be (publicationAgentPins, for the workflow's parent): a
 * named agent that the workflow's owner cannot use, a worker-managed system
 * agent, or a package or version that does not match refuses the test with
 * AGENT_UNAVAILABLE, and a workflow interface that does not match with
 * CONTRACT_MISMATCH, before anything is written, so a test never runs an
 * agent that its publication could not pin. Null when nothing is pinned (no named
 * agent state, or a host that does not resolve agents: its children are then
 * bound when they are created, by the same visibility rules).
 */
async function testAgentPins(host: Pick<WorkflowV2Host, "store" | "resolveAgent">, workflowSessionId: string, revision: number, ir: WorkflowIR | null)
    : Promise<string | null> {
    const definition = await host.store.readDefinition(workflowSessionId);
    if (!definition) return null;
    if (definition.publishedRevision === revision) return definition.publishedAgentPins === null ? null : canonicalJson(definition.publishedAgentPins);
    return publicationAgentPins(host, ir, definition.parentSessionId ?? workflowSessionId);
}

/**
 * The agent versions publishing would lock, shown before anyone publishes (owner decision q1; mock M03): for the
 * current revision, what each named agent state resolves to now, exactly as publication resolves it (publicationAgentPins,
 * for the workflow's parent): the agent, its package and version and the exact package revision, and a matched workflow
 * interface. Read only: nothing is written or locked, and a later republish of a package can still change what
 * publishing then locks (the publication receipt says what it locked). A state the publication would refuse is reported
 * as `problem` (AGENT_UNAVAILABLE or CONTRACT_MISMATCH, with its message and details), not thrown. An already published
 * current revision shows what its publication locked (`locked: true`). A host that does not resolve agents locks nothing
 * at publication (`resolves: false`; its agent states' children are bound when they are created). An invalid revision
 * has nothing to resolve (`agents: []`).
 */
export async function previewWorkflowV2AgentVersions(host: Pick<WorkflowV2Host, "store" | "resolveAgent" | "requests">, workflowSessionId: string)
    : Promise<{ [key: string]: JsonValue }> {
    const definition = await host.store.readDefinition(workflowSessionId);
    if (!definition) throw new WorkflowStoreError("WORKFLOW_NOT_FOUND", `No Workflow ${workflowSessionId}.`);
    const revisionNumber = definition.currentRevision;
    const revision = await host.store.readRevision(workflowSessionId, revisionNumber);
    if (!revision) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "The current revision is missing.");
    const head = { workflowId: workflowSessionId, revision: revisionNumber, definitionHash: revision.yamlSha256, resolves: host.resolveAgent !== undefined };
    const listed = (pins: JsonValue): JsonValue[] => {
        if (!isJsonObject(pins)) return [];
        return Object.keys(pins).sort().map(stateId => {
            const pin = pins[stateId];
            return { stateId, ...(isJsonObject(pin) ? pin : {}) };
        });
    };
    if (definition.publishedRevision === revisionNumber) {
        return { ...head, locked: true, agents: listed(definition.publishedAgentPins), problem: null };
    }
    if (!revision.valid || !revision.irSha256 || !host.resolveAgent) return { ...head, locked: false, agents: [], problem: null };
    const ir = await host.store.readRevisionIr(workflowSessionId, revisionNumber, revision.irSha256, irOptionsFor(host));
    try {
        const pinsText = await publicationAgentPins(host, ir, definition.parentSessionId ?? workflowSessionId);
        return { ...head, locked: false, agents: pinsText === null ? [] : listed(JSON.parse(pinsText) as JsonValue), problem: null };
    } catch (error) {
        if (error instanceof WorkflowStoreError && (error.code === "AGENT_UNAVAILABLE" || error.code === "CONTRACT_MISMATCH")) {
            return { ...head, locked: false, agents: [],
                problem: { code: error.code, message: error.message.replace(/ Nothing was changed\.?$/, ""), details: (error.details ?? null) as JsonValue } };
        }
        throw error;
    }
}

/**
 * Start a test run (design 05; R19, R20): the exact current
 * revision the request names (expected_revision and definition_hash), draft
 * or published, with its inputs (checked against inputs.schema), its own
 * initial KV, and the fixtures it answers intercepted effects from. The run
 * runs at controller 1.9.0 under its own controller instance; its scripts
 * run normally, its framework effects are intercepted, and its deadlines run
 * on its virtual clock. It never changes the live run, and it is never
 * evidence that the definition is safe to run live.
 *
 * Agent mode mocked (the default): each agent state is intercepted, and the
 * parent (or a fixture) supplies its typed result. Agent mode real: each
 * agent state's child is an ordinary agent session, created and bound as a
 * live run's is (same owner, visibility, depth and system-agent rules, and
 * the package revision pinned at admission: testAgentPins), whose framework
 * tool calls are intercepted instead of running (test-agent-tools.ts). Its
 * deadline is on the run's virtual clock. Neither mode makes a package or a
 * tool available that a live run would not have, and nothing falls back to a
 * live call.
 */
export async function startWorkflowV2Test(host: WorkflowV2Host, workflowSessionId: string, command: WorkflowV2TestCommand,
    context: { actor: WorkflowActor; operationId: string; bench?: { ownerSessionId: string; definitionId: string } | null }): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
    requireOperationId(context.operationId);
    requireTestHost(host);
    if (command.agentMode !== "mocked" && command.agentMode !== "real") {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "agent_mode must be mocked or real.");
    }
    const revision = await host.store.readRevision(workflowSessionId, command.expectedRevision);
    let ir: WorkflowIR | null = null;
    if (revision?.valid && revision.irSha256) {
        ir = await host.store.readRevisionIr(workflowSessionId, command.expectedRevision, revision.irSha256, irOptionsFor(host));
        validateRunInputs(ir, revision.irSha256, command.inputs);
    }
    const fixturesText = canonicalJson(command.fixtures);
    // OF-S2-7: only a real-agent test spawns agents; a mocked test's answers come from its fixtures, so it takes no models.
    if (command.agentMode !== "real" && parseWorkflowAgentModels(command.agentModels)) {
        throw new WorkflowStoreError("AGENT_MODELS_INVALID", "agentModels applies to a test with real agents; a mocked test spawns no agent.");
    }
    // OF7-R1, R2: a real-agent test's choices are checked against the owning chat's catalog before it is admitted (below, once
    // no stored receipt answers the request: review D4).
    const agentModels = command.agentMode === "real" ? startAgentModels(command.agentModels, ir, `revision ${command.expectedRevision}`) : null;
    const agentModelsText = workflowAgentModelsText(agentModels);
    const requestSha256 = jsonSha256({ kind: "test", expectedRevision: command.expectedRevision, definitionHash: command.definitionHash,
        inputs: canonicalJson(command.inputs), agentMode: command.agentMode, fixtures: fixturesText, ...varsDigestPart(command.vars),
        ...(command.scenario ? { scenario: command.scenario } : {}), ...agentModelsDigestPart(agentModels) });
    // A real-agent test is pinned once, when it is admitted; a repeat of its operation returns its receipt (the store reads it
    // again under its lock) and pins nothing again.
    const replay = command.agentMode === "real" ? await host.store.readOperationReceipt(workflowSessionId, context.operationId, "test", requestSha256) : null;
    if (replay === null) await startCatalogCheck(host, agentModels, () => workflowSpendingOwner(host, { workflowSessionId }));
    const testAgentPinsText = command.agentMode === "real" && replay === null
        ? await testAgentPins(host, workflowSessionId, command.expectedRevision, ir) : null;
    const runId = randomUUID();
    const stored = await host.store.startTest({
        workflowSessionId, expectedRevision: command.expectedRevision, definitionHash: command.definitionHash, operationId: context.operationId,
        requestSha256, ...(context.bench ? { bench: context.bench } : {}),
        start: {
            runId, mode: "test", controllerInstanceId: workflowTestControllerInstanceId(runId),
            inputsText: boundedCanonicalJson(command.inputs, "Workflow inputs"), kvText: checkedKvText(command.vars ?? {}), testAgentMode: command.agentMode,
            controllerVersion: controllerVersionFor(host), fixturesText, ...(command.scenario ? { testScenario: command.scenario } : {}),
            ...(testAgentPinsText !== null ? { testAgentPinsText } : {}),
            ...(agentModelsText ? { agentModelsText } : {}),
        },
    });
    if (stored.receipt.run) await dispatchWorkflowV2Run(host, stored.receipt);
    if (!stored.replayed) await retainTestRuns(host, workflowSessionId);
    return stored;
}

/**
 * Apply the test-run retention policy (WorkflowV2Host.testRetention) after a
 * test admission: delete the ended test runs beyond the newest `keep` that
 * ended at least the grace ago and whose controller instance has finished
 * (an ended run's controller may still be telling its parent). Best effort:
 * a failure never refuses the test that was admitted; it is recorded as
 * workflow.test_retention_failed, and the next admission tries again.
 */
async function retainTestRuns(host: Pick<WorkflowV2Host, "store" | "duroxideClient" | "testRetention">, workflowSessionId: string): Promise<void> {
    const keep = host.testRetention?.keep ?? WORKFLOW_V2_TEST_RUNS_RETAINED;
    const graceSeconds = host.testRetention?.graceSeconds ?? WORKFLOW_V2_TEST_RUN_RETENTION_GRACE_SECONDS;
    try {
        for (const run of await host.store.listPrunableTestRuns(workflowSessionId, { keep, graceSeconds })) {
            const controller = await host.duroxideClient.getStatus(run.controllerInstanceId);
            if (!["Completed", "Failed", "Terminated", "NotFound"].includes(controller.status)) continue;
            await host.store.pruneTestRun(run.runId, {
                graceSeconds,
                projection: pruned => ({ sessionId: workflowSessionId, events: [{ eventType: "workflow.test_run_deleted", data: {
                    runId: pruned.runId, revision: pruned.revision, status: pruned.status, scenario: pruned.testScenario,
                    reason: "retention", keep, graceSeconds,
                } }] }),
            });
        }
    } catch (error) {
        await host.store.recordSessionEvents(workflowSessionId, [{ eventType: "workflow.test_retention_failed", data: {
            error: redactThenClip(error instanceof Error ? error.message : String(error), 1_000),
        } }]).catch(() => undefined);
    }
}

/** The test run a test command names (run_id is required: a test command never defaults to the live run). */
async function testRun(host: Pick<WorkflowV2Host, "store">, workflowSessionId: string, runId: string): Promise<WorkflowRunRow> {
    const run = await commandRun(host, workflowSessionId, runId);
    if (run.mode !== "test") throw new WorkflowStoreError("RUN_NOT_TEST", `Run ${run.runId} is not a test run.`);
    return run;
}

/**
 * Answer an intercepted effect of a test run by its interception id (design
 * 05; out of band: this answer is never itself intercepted): a tool call's
 * script receives it; an agent's, send's or request's state is decided by
 * it, checked as the live effect's result would be (testResultFor). An
 * invalid answer is refused with its field errors and the effect stays
 * open; the same answer again is idempotent, another is
 * TEST_RESPONSE_CONFLICT; an answer to an effect whose state was decided
 * otherwise (a virtual deadline, a cancel) is refused.
 */
export async function respondWorkflowV2Test(host: Pick<WorkflowV2Host, "store" | "duroxideClient" | "requests">, workflowSessionId: string,
    command: { runId: string; interceptionId: string; response: WorkflowTestResponse }, context: { actor: WorkflowActor; operationId: string })
    : Promise<{ replayed: boolean; interception: WorkflowTestInterception; node: WorkflowNodeExecutionRow }> {
    requireOperationId(context.operationId);
    requireTestHost(host);
    const run = await testRun(host, workflowSessionId, command.runId);
    const intercepted = await host.store.readInterception(command.interceptionId);
    if (!intercepted || intercepted.runId !== run.runId) {
        throw new WorkflowStoreError("INTERCEPTION_NOT_FOUND", `Interception ${command.interceptionId} is not one of test run ${run.runId}.`);
    }
    const executed = await host.store.readNodeExecution(intercepted.nodeExecutionId);
    if (!executed) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Interception ${command.interceptionId} names no node execution.`);
    const ir = await host.store.readRevisionIr(workflowSessionId, run.revision, run.irSha256, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
    const node = ir.nodes[executed.nodeId];
    if (!node) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `The pinned definition has no state ${executed.nodeId}.`);
    const decide = testResultFor(intercepted, node, ir, run.irSha256, command.response);
    const answered = await host.store.respondInterception({
        workflowSessionId, runId: run.runId, interceptionId: command.interceptionId, kind: command.response.kind,
        valueText: canonicalJson(command.response.value), disposition: "parent", operationId: context.operationId, actor: context.actor, decide,
        projection: record => workflowTestAnsweredProjection(run, executed, record, decide),
    });
    if (decide !== null) await wakeRun(host, run, "test");
    return { replayed: answered.replayed, interception: answered.record, node: answered.node };
}

/**
 * Advance a test run's virtual clock (design 05 timer simulation), once per
 * operation id: what became due is decided in the same transaction, in
 * deadline order (store.advanceTestClock), and the controller is told.
 */
export async function advanceWorkflowV2Test(host: Pick<WorkflowV2Host, "store" | "duroxideClient" | "requests">, workflowSessionId: string,
    command: { runId: string; seconds: number }, context: { actor: WorkflowActor; operationId: string }): Promise<StoredOperation<WorkflowTestAdvanceReceipt>> {
    requireOperationId(context.operationId);
    requireTestHost(host);
    const run = await testRun(host, workflowSessionId, command.runId);
    const stored = await host.store.advanceTestClock({
        workflowSessionId, runId: run.runId, seconds: command.seconds, operationId: context.operationId,
        requestSha256: jsonSha256({ kind: "test_advance", runId: run.runId, seconds: command.seconds }),
        projection: receipt => ({
            sessionId: workflowSessionId,
            events: [
                { eventType: "workflow.test_clock_advanced", data: { runId: run.runId, seconds: receipt.seconds, from: receipt.from,
                    virtualNow: receipt.virtualNow, decidedCount: receipt.decided.length } },
                ...receipt.decided.slice(0, 100).map(item => ({
                    eventType: item.outcome === "timed_out" ? "workflow.state_failed" : "workflow.state_completed",
                    data: { runId: run.runId, nodeExecutionId: item.nodeExecutionId, stateId: item.stateId, outcome: item.outcome,
                        resultKind: item.outcome === "timed_out" ? "runtime_error" : "business", virtualNow: receipt.virtualNow },
                })),
            ],
            update: { touch: true },
        }),
    });
    await wakeRun(host, run, "test");
    return stored;
}
