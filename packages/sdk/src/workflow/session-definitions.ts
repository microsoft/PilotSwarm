/**
 * A definition belongs to the session (Workflow Simplified stage 2.1; spec "definitions", "editing", "tools"; the
 * coordinator's readings Q1–Q10, F2–F4): the service the agent tool (workflow_definition), the spawn_workflow
 * compatibility path (D2) and a person's commands (management client) share.
 *
 * - save: revision N+1 of the session's definition, guarded by the definition and the revision it was based on (E2-3, Q1).
 *   A not-valid revision is saved with its errors (E2-5). A person's save leaves a note the session reads on its next turn;
 *   it does not wake the session (E2-4).
 * - start: a new Workflow from a revision (Q10: default the newest valid one; Run again names the revision of the Workflow
 *   it repeats). The Workflow's own definition is that revision's YAML, pinned (R1); Start is refused for a session that is
 *   not live, a definition that is deleted, or a revision that is not valid, under their locks (Q3).
 * - read and list: definitions, revisions, diagnostics, YAML and the Workflows started from each. A read by the session
 *   records what it has seen (Q2).
 * - delete: the session (its own definitions only) or a person deletes a definition; refused while one of its Workflows is active (R6).
 *
 * Stage 2.3 (P2–P6, E2-7; session-packages.ts): a package's Workflow Definition is attached to a session as its locked definition
 * `<package>/<name>` (attachSessionPackageWorkflow); Start then works as for the session's own. A newer package version is
 * attached for the next Workflow only (P6). A person's Make a copy saves the package YAML as the session's own, editable
 * definition (copySessionPackageWorkflow). A2: a save, and a Start, of a definition whose agent state uses an agent that
 * brings definitions is refused.
 */
import { randomUUID } from "node:crypto";
import { systemChildAgentUUID } from "../agent-loader.js";
import { WORKFLOW_CHILD_BUDGET_MAX } from "../child-budget.js";
import type { SessionOwnerInfo, SessionWorkspace, WorkflowWorkspace, WorkspaceDefaultsRecord } from "../types.js";
import { readWorkflowWorkspace, sameDefaultsRecord, workflowWorkspaceSnapshot } from "../workspace.js";
import { sameWorkspace, validateWorkspaceText } from "../workspace-check.js";
import { WORKFLOW_PARENT_CONTEXT_UNAVAILABLE, readWorkflowToolBinding, type WorkflowToolBinding } from "./tool-policy.js";
import { EMPTY_CAPABILITY_STATE } from "../capability-catalog.js";
import { canonicalJson, isJsonObject, isStorableText, sha256Hex, type JsonObject, type JsonValue } from "./json.js";
import {
    WorkflowStoreError, parseDefinitionReceipt, type RerunAdmissionSpec, type RerunInboxCut, type WorkflowActor, type WorkflowDefinitionReceipt,
    type WorkflowStore,
} from "./store.js";
import {
    buildRerunResume, checkRerunCompatibility, mapRerunExecutions, mapRerunSuppliedExecution, partitionRerunVisits,
    pickRerunTarget, rerunCutKvRevision, validateRerunSupply, type WorkflowRerunMode,
} from "./rerun.js";
import {
    effectiveChildLevel, sessionInsideWorkflow, SESSION_MAX_NESTING_LEVEL, WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT, WORKFLOW_DEFINITION_TOOLS_REFUSED,
    WORKFLOW_HUMAN_INPUT_DENIED, workflowHumanInputError,
} from "./input-policy.js";
import { mergeWorkflowAgentModels, parseWorkflowAgentModels, parseWorkflowDecisionModels, readStoredAgentModels,
    requireAgentModelsForRevision, workflowAgentModelsText, workflowDecisionModelRequestDigest, workflowDecisionModelsForRevision, workflowDecisionNodes,
    workflowDecisionSaveDiagnostics, workflowSaveCompilation, WORKFLOW_DECISION_MODEL_UNAVAILABLE, type WorkflowAgentModels } from "./agent-models.js";
import { createWorkflow, dispatchWorkflowRun, readWorkflowCreateReceipt, requireNoAgentBringsWorkflows, workflowCreateRequestSha256, workflowAgentOffers,
    type CreateWorkflowRequest, type RerunClaimPin, type WorkflowHost } from "./service.js";
import { requireWorkflowScripts, workflowScriptNodes } from "./scripts-gate.js";
import { compileWorkflow, type WorkflowCompileResult, type WorkflowDiagnostic, type WorkflowIR } from "./compiler.js";
import { workflowGraphJson } from "./tools.js";
import { requireWorkflowToolRequirements, workflowToolDiagnostics } from "./tool-requirements.js";
import {
    sessionSaveRequestSha256, lockedRefusal, type SessionAttachReceipt, type SessionDefinitionActor, type SessionDefinitionRow, type SessionDeleteReceipt, type SessionRevisionRow,
    type SessionRevisionSummary, type SessionSaveReceipt, type SessionWorkflowRow, type StoredSessionOperation, type SessionCopiedFrom,
} from "./session-definition-store.js";
import { packageVersionIsNewer, type PackageViewer, type PackageWorkflowEntry, type PackageWorkflowSource } from "./session-packages.js";
import {
    parseWorkflowPackageRef, readWorkflowCard, workflowCardInterface, workflowCardWords, workflowEffectFacts, type WorkflowCard, type WorkflowCardInterface,
    type WorkflowEffectFacts,
} from "./package-card.js";

/**
 * Stage 2.4 / I9: Start keeps spawn_agent's depth and child-budget limits under one effectiveLevel rule.
 * Nothing goes past WORKFLOW_START_MAX_NESTING_LEVEL (2): the first Workflow in a chain is free (+0), each later
 * Workflow adds +1, and an agent step sits at its Workflow's level (+0). A session's running sub-agents and active
 * Workflows share one budget of WORKFLOW_START_MAX_RUNNING_CHILDREN.
 */
export const WORKFLOW_START_MAX_NESTING_LEVEL = SESSION_MAX_NESTING_LEVEL;
export const WORKFLOW_START_MAX_RUNNING_CHILDREN = WORKFLOW_CHILD_BUDGET_MAX;

/**
 * Start's limits (above), before anything is made. The session's nesting level is derived from its stored lineage for every
 * Start, a person's included (S2RT-F4); a level the caller gives (the session's own tools know theirs) is used when deeper.
 * The budget is counted again, atomically, when the Workflow is claimed (S2RT-F3).
 */
export async function requireWorkflowStartLimits(host: Pick<WorkflowHost, "store">, ownerSessionId: string, given: number | null = null,
    options: { claimedWorkflowSessionId?: string } = {}): Promise<void> {
    const lineage = await host.store.readWorkflowLineage(ownerSessionId);
    if (lineage === null || lineage.level === null) {
        throw new WorkflowStoreError(
            "WORKFLOW_NESTING_LIMIT",
            `This session's delegation chain cannot be verified, and nothing goes past level ${WORKFLOW_START_MAX_NESTING_LEVEL}. Nothing was started.`,
            { nestingLevel: null, maxNestingLevel: WORKFLOW_START_MAX_NESTING_LEVEL },
        );
    }
    const hasWorkflow = lineage.hasWorkflow !== false;
    const callerLevel = Math.max(lineage.level, Number.isSafeInteger(given) ? given as number : 0);
    const workflowLevel = effectiveChildLevel({ level: callerLevel, hasWorkflow }, "workflow");
    if (workflowLevel > WORKFLOW_START_MAX_NESTING_LEVEL) {
        throw new WorkflowStoreError(
            "WORKFLOW_NESTING_LIMIT",
            `This session is at level ${callerLevel}, and the Workflow it starts would be at level ${workflowLevel}. `
            + `Nothing goes past level ${WORKFLOW_START_MAX_NESTING_LEVEL}: each sub-agent or Workflow is one level below whoever started it, `
            + "but the first Workflow in a chain is free, and an agent step sits at its Workflow's level. "
            + "Start this Workflow from a session nearer the top. Nothing was started.",
            { nestingLevel: callerLevel, workflowLevel, maxNestingLevel: WORKFLOW_START_MAX_NESTING_LEVEL },
        );
    }
    const running = options.claimedWorkflowSessionId
        ? await host.store.sessionDefinitions.runningChildren(ownerSessionId, options.claimedWorkflowSessionId)
        : await host.store.sessionDefinitions.runningChildren(ownerSessionId);
    if (running >= WORKFLOW_START_MAX_RUNNING_CHILDREN) {
        throw new WorkflowStoreError("CHILD_LIMIT", `This session already has ${running} running sub-agents and Workflows (max `
            + `${WORKFLOW_START_MAX_RUNNING_CHILDREN}). Wait for some to end before starting another. Nothing was started.`,
        { running, max: WORKFLOW_START_MAX_RUNNING_CHILDREN });
    }
}

/** A definition name: as metadata.name allows (1–128 characters: letters, digits, dot, dash, underscore). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SessionStartRerunFrom {
    workflowId: string;
    executionId?: string | null;
    mode?: WorkflowRerunMode | null;
    result?: unknown;
    note?: unknown;
    /** Test-only hook: skip the pre-admission C1..C9 fit check to verify runtime divergence guards. */
    _skipFitCheckForTest?: boolean;
}

export interface SessionStartReceipt {
    operation: "start";
    definitionId: string;
    name: string;
    revision: number;
    workflowId: string;
    runId: string | null;
    replayed: boolean;
    warnings?: WorkflowDiagnostic[];
    /** Compatibility field: the canonical effective Agent + Decision map stored with the run. */
    agentModels?: WorkflowAgentModels;
    /** Additive presentation field: the Decision-only subset of agentModels, identified from the exact revision. */
    decisionModels?: WorkflowAgentModels;
    delegated?: JsonObject[];
    /** Phase 3 I7: present on re-runs started with rerunFrom. */
    rerun?: {
        ofWorkflowId: string;
        ofRunId: string;
        fromExecutionId: string;
        mode: WorkflowRerunMode;
        reused: number;
        grant?: "inherited";
        supplied?: { outcome: string; outputSha256: string; note: string };
    };
}

function startReceiptModelFields(models: WorkflowAgentModels | null, ir: WorkflowIR | null | undefined)
    : Pick<SessionStartReceipt, "agentModels" | "decisionModels"> {
    if (!models) return {};
    // Internal alias provenance participates in revision validation, but never leaves through a public receipt.
    const stored = readStoredAgentModels(workflowAgentModelsText(models));
    if (!("models" in stored) || !stored.models) return {};
    const decisions = workflowDecisionModelsForRevision(stored.models, ir);
    return { agentModels: stored.models, ...(decisions ? { decisionModels: decisions } : {}) };
}

/**
 * OF-S2-7: Run again reuses the models the Workflow it repeats was started with, unless the request gives its own (an empty
 * map: none, every agent node uses the session's). Null when that Workflow had none.
 */
async function runAgainAgentModels(host: Pick<WorkflowHost, "store">, workflowSessionId: string): Promise<WorkflowAgentModels | null> {
    const runs = await host.store.listRuns(workflowSessionId);
    const live = runs.find(run => run.mode === "live") ?? null;
    if (!live) return null;
    // A stored map that cannot be read refuses Run again in words; it is never dropped for the session's models.
    const read = readStoredAgentModels(live.agentModels);
    if ("error" in read) throw new WorkflowStoreError("AGENT_MODELS_INVALID", `${read.error} Give agentModels (an empty map: the session's models) to run it again.`);
    return read.models;
}

/** The models a start uses: explicit aliases when either is named (an empty map clears inheritance), else Run again's. */
/** Select one part of a compatibility run map by the exact revision node types. */
function modelPartForRevision(models: WorkflowAgentModels | null, ir: WorkflowIR | null | undefined,
    kind: "agent" | "decision"): WorkflowAgentModels | null {
    if (!models || !ir) return null;
    const selected = Object.fromEntries(Object.entries(models).filter(([id]) =>
        kind === "decision" ? ir.nodes[id]?.type === "decision" : ir.nodes[id]?.type !== "decision"));
    return Object.keys(selected).length ? selected : null;
}

/**
 * The models a Start uses. With Run again, a non-empty Agent map replaces the Agent part and inherits the Decision part, and
 * a Decision map (empty or not) replaces only the Decision part. An empty Agent map clears every inherited choice, Decision
 * ones too, as it did before Decision existed: each Decision then uses the current Cluster Decision Default. The canonical
 * Agent map remains accepted for compatibility, so a Decision entry named through it also replaces that inherited entry.
 */
export async function startAgentModelsOf(host: Pick<WorkflowHost, "store">,
    request: { agentModels?: unknown; decisionModels?: unknown; runAgainOf?: string | null }, ir?: WorkflowIR | null, what?: string)
    : Promise<WorkflowAgentModels | null> {
    const hasAgent = request.agentModels !== undefined && request.agentModels !== null;
    const hasDecision = request.decisionModels !== undefined && request.decisionModels !== null;
    const agentModels = parseWorkflowAgentModels(request.agentModels);
    const decisionModels = parseWorkflowDecisionModels(request.decisionModels);
    let selected: WorkflowAgentModels | null;
    if (hasAgent && hasDecision) {
        selected = mergeWorkflowAgentModels(agentModels, decisionModels);
    } else if (!hasAgent && !hasDecision) {
        selected = request.runAgainOf ? await runAgainAgentModels(host, request.runAgainOf) : null;
    } else if (!request.runAgainOf || !ir) {
        selected = mergeWorkflowAgentModels(agentModels, decisionModels);
    } else if (hasAgent && agentModels === null) {
        selected = null;
    } else if (hasAgent && workflowDecisionNodes(ir).length === 0) {
        selected = agentModels;
    } else {
        const prior = await runAgainAgentModels(host, request.runAgainOf);
        if (hasDecision) {
            selected = mergeWorkflowAgentModels(modelPartForRevision(prior, ir, "agent"), decisionModels);
        } else {
            const priorDecision = modelPartForRevision(prior, ir, "decision");
            const inheritedDecision = priorDecision && agentModels
                ? Object.fromEntries(Object.entries(priorDecision).filter(([id]) => !Object.hasOwn(agentModels, id)))
                : priorDecision;
            selected = mergeWorkflowAgentModels(agentModels,
                inheritedDecision && Object.keys(inheritedDecision).length ? inheritedDecision : null);
        }
    }
    if (!selected) return null;
    if (ir && (hasAgent || hasDecision)) requireAgentModelsForRevision(selected, ir, what ?? "the requested Workflow revision");
    const stored = readStoredAgentModels(workflowAgentModelsText(selected));
    if ("error" in stored) throw new WorkflowStoreError("AGENT_MODELS_INVALID", stored.error);
    return stored.models;
}

/** A Decision Start's original model intent is part of keyed replay identity, separate from materialized defaults. */
function decisionModelRequestDigest(request: { agentModels?: unknown; decisionModels?: unknown; runAgainOf?: string | null },
    ir: WorkflowIR | null, explicitModels?: WorkflowAgentModels | null): string | undefined {
    const hasAgent = request.agentModels !== undefined && request.agentModels !== null;
    const hasDecision = request.decisionModels !== undefined && request.decisionModels !== null;
    const explicit = hasAgent || hasDecision;
    const models = explicit
        ? explicitModels !== undefined
            ? explicitModels
            : mergeWorkflowAgentModels(parseWorkflowAgentModels(request.agentModels), parseWorkflowDecisionModels(request.decisionModels))
        : undefined;
    return workflowDecisionModelRequestDigest(ir, { explicit, models, runAgainOf: request.runAgainOf ?? null });
}

export interface SessionDefinitionView {
    definitionId: string;
    name: string;
    currentRevision: number;
    source: string | null;
    /** L1: a person's copy of a package's definition: what it was copied from (source 'copy'). */
    copiedFrom: SessionCopiedFrom | null;
    /** Stage 2.3: a package's definition, locked (E2-7), and its package. */
    locked: boolean;
    packageName: string | null;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    /** The newest revision's facts (null before the first save). */
    current: SessionRevisionSummary | null;
    /** The newest valid revision (Start's default), or null. */
    newestValidRevision: number | null;
    revisions: SessionRevisionSummary[];
    workflows: SessionWorkflowRow[];
    /**
     * Stage 2.3 (P6): for a locked definition, the package's active version when it is not the newest revision's (it is
     * offered for the next Workflow); null otherwise, or when it was not looked up.
     */
    packageUpdate?: { semver: string; sha256: string } | null;
}

function requireOperationId(operationId: string): void {
    if (typeof operationId !== "string" || !operationId.trim() || operationId.length > 256 || operationId.includes("\u0000")) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "operation_id must be 1-256 characters without NUL characters.");
    }
}

/** An explicit key is session-scoped and exact; preserve all pre-existing unkeyed operation identities. */
export function workflowStartOperationId(operationId: string, key?: unknown): string {
    requireOperationId(operationId);
    if (key === undefined) return operationId;
    if (typeof key !== "string" || !key.trim() || [...key].length > 128 || !isStorableText(key)) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "key must be 1-128 characters of valid Unicode text without NUL characters; it cannot be blank.");
    }
    return `definition-key:${sha256Hex(key)}`;
}

export function workflowStartSessionId(ownerSessionId: string, operationId: string, key?: unknown): string {
    return systemChildAgentUUID(ownerSessionId, `workflow:start:${workflowStartOperationId(operationId, key)}`);
}

function requireName(name: unknown): string {
    if (typeof name !== "string" || !NAME.test(name)) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID",
            "name must be 1-128 characters: letters, digits, dot, dash or underscore, starting with a letter or digit (the YAML's metadata.name).");
    }
    return name;
}

/** The definition named by id or by name, the session's own and live, or the refusal that says why not. */
export async function definitionOf(host: Pick<WorkflowHost, "store">, ownerSessionId: string, ref: { definitionId?: string | null; name?: string | null })
    : Promise<SessionDefinitionRow> {
    const found = ref.definitionId
        ? await host.store.sessionDefinitions.readDefinition(ref.definitionId)
        : ref.name ? await host.store.sessionDefinitions.readDefinitionByName(ownerSessionId, ref.name) : null;
    if (!found || found.ownerSessionId !== ownerSessionId) {
        throw new WorkflowStoreError("DEFINITION_NOT_FOUND", ref.name ? `This session has no Workflow Definition named ${ref.name}.`
            : `This session has no Workflow Definition ${ref.definitionId ?? ""}.`);
    }
    if (ref.definitionId && ref.name && found.name !== ref.name) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID",
            `definition_id ${ref.definitionId} is ${found.name}, not ${ref.name}. Pass either definition_id or name, or matching values.`);
    }
    if (found.deletedAt !== null) throw new WorkflowStoreError("DEFINITION_DELETED", `${found.name} was deleted.`, { definitionId: found.definitionId });
    return found;
}

/**
 * SF-2 for session Workflow Definition mutations/starts: when a caller passes `originatingSessionId`
 * (e.g. an MCP server or API call acting on behalf of an agent session), refuse with 403
 * WORKFLOW_DEFINITION_TOOLS_REFUSED if that session's stored lineage is inside a Workflow.
 */
export async function refuseSessionDefinitionFromInsideWorkflow(
    store: Pick<WorkflowStore, "readWorkflowLineage"> | null | undefined,
    originatingSessionId: unknown,
): Promise<void> {
    if (originatingSessionId === undefined || originatingSessionId === null) return;
    if (typeof originatingSessionId !== "string" || !originatingSessionId.trim() || originatingSessionId.length > 256) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "originatingSessionId, when given, must be a session id of 1 to 256 characters.");
    }
    if (!store) {
        throw new WorkflowStoreError("WORKFLOW_STORE_UNAVAILABLE", "Cannot verify originatingSessionId lineage because the workflow store is unavailable.");
    }
    if (await sessionInsideWorkflow(store, originatingSessionId)) {
        throw new WorkflowStoreError(WORKFLOW_DEFINITION_TOOLS_REFUSED, WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT);
    }
}

/**
 * Save revision N+1 (E2-1..E2-6). `expected`: the definition and revision the save was based on (Q1), or null for the
 * first save of `name`. The YAML's metadata.name, when it has one, must be `name`. A host whose workers run no scripts
 * refuses a definition with a script node (scripts-gate.ts). `by`: "session" (the session's own tool: it has seen what it saved)
 * or "person" (a note for the session, `personWords` naming them).
 */
/**
 * Review PRS-002: a session's Workflow Definitions change only for a session that is not inside a Workflow. A session that runs an
 * agent step (or is a descendant of one) takes no human input (input-policy.ts), and a definition change would queue a note
 * into its next prompt: save, start, test, copy, a package's attach or update, and delete are refused for it
 * (WORKFLOW_HUMAN_INPUT_DENIED, 403), by its stored lineage, before anything is read or written; reads stay allowed.
 * The one guard for every caller: a person's management or HTTP call, and the session's own tool (which A1 refuses first).
 */
export async function requireSessionDefinitionsWritable(host: Pick<WorkflowHost, "store">, ownerSessionId: string): Promise<void> {
    const lineage = await host.store.readWorkflowLineage(ownerSessionId);
    if (!lineage?.agentRoot) return;
    const denied = workflowHumanInputError(ownerSessionId, "definitions", lineage);
    throw new WorkflowStoreError(WORKFLOW_HUMAN_INPUT_DENIED, `${denied.message} Nothing was changed.`, denied.details as JsonValue);
}

export async function saveSessionWorkflowDefinition(host: WorkflowHost, request: {
    ownerSessionId: string;
    name: string;
    yaml: string;
    expected: { definitionId: string; revision: number } | null;
    actor: SessionDefinitionActor;
    operationId: string;
    by: "session" | "person";
    personWords?: string | null;
    /** The YAML as a caller already compiled it with this host, to run the scripts gate before anything else (d52e5ed2). */
    compiled?: WorkflowCompileResult;
    /** Save warns using the current grant when known; Start captures and checks authority again. */
    binding?: () => Promise<WorkflowToolBinding | null>;
    /** L1: this first save is a Make a copy of `copiedFrom`. */
    copiedFrom?: SessionCopiedFrom | null;
}): Promise<StoredSessionOperation<SessionSaveReceipt>> {
    requireOperationId(request.operationId);
    await requireSessionDefinitionsWritable(host, request.ownerSessionId);
    // DS-1 (TEST check at 406550a9): a save aimed at a package's locked definition (by its id, or by its <package>/<name>)
    // is refused as locked, in words that say Make a copy, before its name or YAML is checked. The store refuses it again
    // under its lock.
    const target = typeof request.expected?.definitionId === "string" && request.expected.definitionId
        ? await host.store.sessionDefinitions.readDefinition?.(request.expected.definitionId)
        : typeof request.name === "string" && request.name.includes("/") ? await host.store.sessionDefinitions.readDefinitionByName?.(request.ownerSessionId, request.name.trim())
            : null;
    if (target && target.ownerSessionId === request.ownerSessionId && target.deletedAt === null && target.locked) throw lockedRefusal(target);
    const name = requireName(request.name);
    if (typeof request.yaml !== "string" || !request.yaml.trim()) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "yaml is required.");
    if (request.expected !== null && (typeof request.expected?.definitionId !== "string" || !Number.isSafeInteger(request.expected?.revision)
        || request.expected.revision < 1)) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "The revision guard needs the definition id and the revision the save was based on.");
    }
    const compiled = request.compiled ?? compileWorkflow(request.yaml);
    if (compiled.name && compiled.name !== name) {
        throw new WorkflowStoreError("WORKFLOW_NAME_MISMATCH", `The YAML's metadata.name is ${compiled.name}, not ${name}. Nothing was saved.`);
    }
    requireWorkflowScripts(host, compiled.ir, "save");
    // A2 (stage 2.3): an agent state may not use an agent that brings definitions.
    await requireNoAgentBringsWorkflows(host, compiled.ir, request.ownerSessionId, "Nothing was saved.");
    let binding: WorkflowToolBinding | null = null;
    let grantKnown = false;
    if (request.binding && Object.values(compiled.ir?.nodes ?? {}).some(node => node.type === "script" || node.type === "agent")) {
        try { binding = await request.binding(); grantKnown = true; }
        catch { grantKnown = false; }
    }
    const offers = await workflowAgentOffers(host, compiled.ir, binding ? { ...binding, agentStepTools: "selections" } : null, request.ownerSessionId, true);
    const spawnWarnings: WorkflowDiagnostic[] = [];
    if (compiled.ir && host.store.sessionDefinitions.readDefinitionByName) {
        for (const node of Object.values(compiled.ir.nodes)) {
            if (node.type !== "spawn" || node.definition === name) continue;
            const found = await host.store.sessionDefinitions.readDefinitionByName(request.ownerSessionId, node.definition);
            if (!found || found.deletedAt !== null) {
                spawnWarnings.push({
                    severity: "warning",
                    code: "WORKFLOW_SPAWN_DEFINITION_MISSING",
                    path: `states.${node.id}.definition`,
                    message: `definition '${node.definition}' is not saved on this session yet; save a valid revision before this spawn state runs.`,
                });
            }
        }
    }
    const persistedCompiled = await workflowSaveCompilation(compiled, host.decisionCapability,
        [...workflowToolDiagnostics(compiled.ir, binding, grantKnown, offers), ...spawnWarnings]);
    return host.store.sessionDefinitions.save({
        ownerSessionId: request.ownerSessionId, name, yaml: request.yaml,
        compiled: persistedCompiled, expected: request.expected, actor: request.actor,
        operationId: request.operationId, requestSha256: sessionSaveRequestSha256({ name, yamlSha256: compiled.yamlSha256, expected: request.expected }),
        seenBySession: request.by === "session", ...(request.by === "person" ? { noteBy: request.personWords ?? "A person" } : {}),
        ...(request.copiedFrom ? { copiedFrom: request.copiedFrom } : {}),
    });
}

/**
 * Start a new Workflow from a revision of a session's definition (Q10). `revision` absent: the newest valid one; `runAgainOf`:
 * the revision a Workflow of this definition pinned (Run again). The Workflow's id follows from the operation id, so a
 * repeated call is answered from its receipt. The scripts gate (stage 2.0, one switch) decides once the revision is known,
 * before anything else: the session's tool binding (`binding`, a value or the function that captures it) is captured only
 * after it, so a host that runs no scripts refuses a script node without asking the session for anything.
 */
function parseRerunClaimPin(value: unknown): RerunClaimPin | null {
    if (!isJsonObject(value)) return null;
    if (typeof value.sourceWorkflowId !== "string" || typeof value.sourceRunId !== "string"
        || typeof value.fromExecutionId !== "string"
        || (value.mode !== "run_again" && value.mode !== "continue" && value.mode !== "supply")
        || !Number.isSafeInteger(value.revision) || !Number.isSafeInteger(value.reusedCount)) {
        return null;
    }
    const sup = isJsonObject(value.supplied)
        && typeof value.supplied.outcome === "string"
        && typeof value.supplied.outputSha256 === "string"
        && typeof value.supplied.noteSha256 === "string"
        && typeof value.supplied.note === "string"
        ? {
            outcome: value.supplied.outcome,
            outputSha256: value.supplied.outputSha256,
            noteSha256: value.supplied.noteSha256,
            note: value.supplied.note,
        }
        : undefined;
    return {
        sourceWorkflowId: value.sourceWorkflowId,
        sourceRunId: value.sourceRunId,
        fromExecutionId: value.fromExecutionId,
        mode: value.mode,
        revision: Number(value.revision),
        reusedCount: Number(value.reusedCount),
        ...(value.grant === "inherited" ? { grant: "inherited" as const } : {}),
        ...(sup ? { supplied: sup } : {}),
    };
}

function rerunReceiptFromPin(pin: RerunClaimPin): NonNullable<SessionStartReceipt["rerun"]> {
    return {
        ofWorkflowId: pin.sourceWorkflowId,
        ofRunId: pin.sourceRunId,
        fromExecutionId: pin.fromExecutionId,
        mode: pin.mode,
        reused: pin.reusedCount,
        ...(pin.grant === "inherited" ? { grant: "inherited" as const } : {}),
        ...(pin.supplied ? { supplied: { outcome: pin.supplied.outcome, outputSha256: pin.supplied.outputSha256, note: pin.supplied.note } } : {}),
    };
}

function validateRerunStartArguments(request: Parameters<typeof startSessionWorkflowDefinition>[1]): SessionStartRerunFrom {
    const rf = request.rerunFrom!;
    if (!rf || typeof rf !== "object" || typeof rf.workflowId !== "string" || !rf.workflowId.trim()) {
        throw new WorkflowStoreError("RERUN_ARGUMENT_REFUSED", "rerunFrom.workflowId must name a Workflow of this definition.");
    }
    if (request.runAgainOf) {
        throw new WorkflowStoreError("RERUN_ARGUMENT_REFUSED", "rerunFrom cannot be combined with runAgainOf.");
    }
    if (request.spawn) {
        throw new WorkflowStoreError("RERUN_ARGUMENT_REFUSED", "rerunFrom cannot be used on a spawned child Workflow.");
    }
    if (request.parentSessionId && request.parentSessionId !== request.ownerSessionId) {
        throw new WorkflowStoreError("RERUN_ARGUMENT_REFUSED", "rerunFrom must start directly under the owning session.");
    }
    if (request.inputs !== undefined && request.inputs !== null) {
        if (!isJsonObject(request.inputs) || Object.keys(request.inputs).length > 0) {
            throw new WorkflowStoreError("RERUN_ARGUMENT_REFUSED", "rerunFrom inherits the source Workflow's inputs and does not accept inputs.");
        }
    }
    if (request.workspace !== undefined && request.workspaceInherited !== true) {
        throw new WorkflowStoreError("RERUN_ARGUMENT_REFUSED", "rerunFrom inherits the source Workflow's workspace and does not accept workspace.");
    }
    if (rf.mode !== undefined && rf.mode !== null && rf.mode !== "run_again" && rf.mode !== "continue" && rf.mode !== "supply") {
        throw new WorkflowStoreError("RERUN_ARGUMENT_REFUSED", `rerunFrom.mode must be 'run_again', 'continue', or 'supply' (got '${String(rf.mode)}').`);
    }
    if (rf.mode !== "supply" && (rf.result !== undefined && rf.result !== null || rf.note !== undefined && rf.note !== null)) {
        throw new WorkflowStoreError("RERUN_ARGUMENT_REFUSED", "rerunFrom.result and rerunFrom.note are only allowed when mode is 'supply'.");
    }
    if (rf.mode === "supply") {
        if (!isJsonObject(rf.result) || typeof rf.result.outcome !== "string" || !rf.result.outcome.trim()) {
            throw new WorkflowStoreError("RERUN_ARGUMENT_REFUSED", "mode 'supply' requires result: { outcome, output? } with a non-empty string outcome.");
        }
        if (typeof rf.note !== "string" || !rf.note.trim()) {
            throw new WorkflowStoreError("RERUN_ARGUMENT_REFUSED", "mode 'supply' requires a non-empty note.");
        }
    }
    return rf;
}

function sameRerunPinRequest(pin: RerunClaimPin, rf: SessionStartRerunFrom | null | undefined): boolean {
    if (!rf) return false;
    if (rf.workflowId !== pin.sourceWorkflowId) return false;
    if (rf.executionId != null && rf.executionId !== pin.fromExecutionId) return false;
    if (rf.mode != null && rf.mode !== pin.mode) return false;
    if (pin.mode === "supply") {
        if (!pin.supplied || !isJsonObject(rf.result) || typeof rf.result.outcome !== "string" || typeof rf.note !== "string") return false;
        const outVal = rf.result.output === undefined ? null : rf.result.output as JsonValue;
        if (rf.result.outcome !== pin.supplied.outcome) return false;
        if (sha256Hex(canonicalJson(outVal)) !== pin.supplied.outputSha256) return false;
        if (sha256Hex(rf.note.trim()) !== pin.supplied.noteSha256) return false;
    }
    return true;
}

function capabilitiesCoverSelections(current: { selections: Array<{ sourceId: string; sourceRef?: string; tools: string[]; mcpServers: string[] }> },
    required: Array<{ sourceId: string; sourceRef?: string; tools: string[]; mcpServers: string[] }>): boolean {
    for (const req of required) {
        const cur = current.selections.find(sel => sel.sourceId === req.sourceId);
        if (!cur) return false;
        if (req.sourceRef !== undefined && cur.sourceRef !== req.sourceRef) return false;
        const curTools = new Set(cur.tools);
        for (const t of req.tools) if (!curTools.has(t)) return false;
        const curMcps = new Set(cur.mcpServers);
        for (const m of req.mcpServers) if (!curMcps.has(m)) return false;
    }
    return true;
}

async function resolveRerunToolBinding(host: WorkflowHost, request: Parameters<typeof startSessionWorkflowDefinition>[1],
    sourceWorkflowId: string, targetIr: WorkflowIR, defName: string)
    : Promise<{ binding: WorkflowToolBinding | null; inherited: boolean; sourceWorkspace: WorkflowWorkspace | null }> {
    const sourceCreation = await host.catalog.getSessionCreationConfig?.(sourceWorkflowId) ?? null;
    const sourceWorkspace = readWorkflowWorkspace(sourceCreation);
    if (request.binding !== undefined && request.binding !== null) {
        const captured = await startToolBinding(request.binding, targetIr, defName);
        return { binding: captured ? { ...captured, agentStepTools: "selections" as const } : null, inherited: false, sourceWorkspace };
    }
    const sourceBinding = readWorkflowToolBinding(sourceCreation?.workflowToolBinding);
    if (!sourceBinding) {
        return { binding: null, inherited: false, sourceWorkspace };
    }
    const needsGrant = workflowToolDiagnostics(targetIr, null, true, {}).some(d =>
        d.code === "WORKFLOW_TOOL_NOT_GRANTED" || d.code === "WORKFLOW_TOOLS_DYNAMIC" || d.code === "WORKFLOW_TOOLS_UNCHECKED");
    const refusal = await inheritedGrantRefusal(host, request, sourceBinding);
    if (refusal) {
        if (needsGrant) {
            throw new WorkflowStoreError("WORKFLOW_TOOLS_UNAVAILABLE",
                `${defName} cannot inherit the source Workflow's tool grant (${refusal}). Nothing was started.`);
        }
        return { binding: null, inherited: false, sourceWorkspace };
    }
    const { agentStepBindings: _dropOldSnapshots, ...cleanSourceBinding } = sourceBinding;
    return { binding: { ...cleanSourceBinding, agentStepTools: "selections" as const }, inherited: true, sourceWorkspace };
}

/**
 * OQ1 narrow 5-condition owner tool-grant inheritance: why this caller may not use `binding` as an inherited grant now, or
 * null when it may. Fresh Start checks the source Workflow's binding; recovery of a bare claim checks the grant its claim
 * pinned (B1), so both apply the same rules to the caller and the owning session's current policy.
 */
async function inheritedGrantRefusal(host: WorkflowHost, request: Parameters<typeof startSessionWorkflowDefinition>[1],
    binding: WorkflowToolBinding): Promise<string | null> {
    if (request.actor.kind !== "user") return "only the owning person may inherit a tool grant";
    if (request.originatingSessionId != null) return "proxied agent calls cannot inherit a tool grant";
    const ownerSession = await host.catalog.getSession(request.ownerSessionId);
    if (!ownerSession || ownerSession.deletedAt || ownerSession.isSystem) return "the owning session is not live";
    if (!ownerSession.owner || ownerSession.owner.provider !== request.actor.provider || ownerSession.owner.subject !== request.actor.subject) {
        return "the caller is not the owning session's owner";
    }
    if (binding.owner.provider !== request.actor.provider || binding.owner.subject !== request.actor.subject) {
        return "the source binding belongs to another owner";
    }
    if (binding.parentSessionId !== request.ownerSessionId) return "spawned-child bindings cannot be inherited";
    if (binding.inMemory !== undefined) return "in-memory worker tool bindings cannot be inherited";
    const [ownerCaps, ownerCreation] = await Promise.all([
        host.catalog.getSessionCapabilities ? host.catalog.getSessionCapabilities(request.ownerSessionId) : Promise.resolve(EMPTY_CAPABILITY_STATE),
        host.catalog.getSessionCreationConfig ? host.catalog.getSessionCreationConfig(request.ownerSessionId) : Promise.resolve(null),
    ]);
    if (!capabilitiesCoverSelections(ownerCaps, binding.capabilities.selections)) {
        return "the owning session's capability selections no longer cover the source grant";
    }
    if (isJsonObject(ownerCreation)) {
        const ceiling = Array.isArray(ownerCreation.toolCeiling)
            ? ownerCreation.toolCeiling.filter((x): x is string => typeof x === "string") : null;
        if (ceiling !== null) {
            const allowed = new Set(ceiling);
            for (const tool of binding.tools) {
                if (!allowed.has(tool.name) && !allowed.has(`custom:${tool.name}`)) {
                    return `tool '${tool.name}' is outside the owning session's tool ceiling`;
                }
            }
        }
        const excluded = Array.isArray(ownerCreation.excludedTools)
            ? ownerCreation.excludedTools.filter((x): x is string => typeof x === "string") : null;
        if (excluded !== null) {
            const blocked = new Set(excluded);
            for (const tool of binding.tools) {
                if (blocked.has(tool.name)) return `tool '${tool.name}' is now excluded on the owning session`;
            }
        }
    }
    return null;
}

/**
 * S2RT-F5: the definition and revision a Start operation pinned when it first ran: from its Workflow's stored definition
 * (the pin written with it), else from its claim (the creation marker records the pin, for a Start interrupted between its
 * claim and its admission); null when the operation has not run.
 */
export async function storedStartPin(host: Pick<WorkflowHost, "store" | "catalog">, workflowSessionId: string)
    : Promise<{ definitionId: string; revision: number; rerunPin?: RerunClaimPin | null } | null> {
    const [row, creation] = await Promise.all([
        host.store.readDefinition(workflowSessionId),
        host.catalog.getSessionCreationConfig?.(workflowSessionId) ?? Promise.resolve(null),
    ]);
    const marker = isJsonObject(creation) && isJsonObject((creation as JsonObject).workflow) ? (creation as JsonObject).workflow as JsonObject : null;
    const rerunPin = marker ? parseRerunClaimPin(marker.rerunPin) : null;
    if (row && typeof row.sessionDefinitionId === "string" && Number.isSafeInteger(row.sessionRevision)) {
        return { definitionId: row.sessionDefinitionId, revision: row.sessionRevision as number, ...(rerunPin ? { rerunPin } : {}) };
    }
    const pin = marker && isJsonObject(marker.sessionPin) ? marker.sessionPin as JsonObject : null;
    return pin && typeof pin.definitionId === "string" && Number.isSafeInteger(pin.revision)
        ? { definitionId: pin.definitionId, revision: Number(pin.revision), ...(rerunPin ? { rerunPin } : {}) } : null;
}

/** A Start operation that already ran: its pinned revision again (refused when the request names another), then its receipt. */
async function replaySessionStart(host: WorkflowHost, request: Parameters<typeof startSessionWorkflowDefinition>[1], workflowSessionId: string,
    prior: { definitionId: string; revision: number; rerunPin?: RerunClaimPin | null }): Promise<SessionStartReceipt> {
    const parentSessionId = request.parentSessionId ?? request.ownerSessionId;
    const createOpId = request.spawn ? `spawn:${request.spawn.nodeExecutionId}` : `start:${request.operationId}`;
    const pinned = await host.store.sessionDefinitions.readDefinition(prior.definitionId);
    const conflict = (what: string) => new WorkflowStoreError("OPERATION_CONFLICT",
        `${request.key !== undefined ? "This key" : `Operation ${request.operationId}`} started ${pinned?.name ?? "a definition"} `
        + `revision ${prior.revision}, not ${what}; use ${request.key !== undefined ? "a new key" : "another operation id"}.`,
    { definitionId: prior.definitionId, revision: prior.revision });
    if (!pinned || pinned.ownerSessionId !== request.ownerSessionId) {
        throw new WorkflowStoreError("WORKFLOW_EXISTS", `Workflow ${workflowSessionId} was created by a different request; use `
            + `${request.key !== undefined ? "a new key" : "another operation id"}.`);
    }
    if (request.definition.definitionId && request.definition.definitionId !== prior.definitionId) throw conflict(`definition ${request.definition.definitionId}`);
    if (request.definition.name && request.definition.name !== pinned.name) throw conflict(request.definition.name);
    if (Number.isSafeInteger(request.revision) && request.revision !== prior.revision) throw conflict(`revision ${request.revision}`);
    const saved = await host.store.sessionDefinitions.readRevision(prior.definitionId, prior.revision);
    if (!saved) throw new WorkflowStoreError("REVISION_NOT_FOUND", `${pinned.name} has no revision ${prior.revision}.`);
    // Review PRA-F2: a Start interrupted after its claim, before its Workflow was stored, is checked again as a first Start
    // is (the build or the session may have changed since): the revision compiles in this version, the scripts gate, and the
    // depth limit and budget, its own claim not counted. One whose Workflow was stored is answered from what it made.
    const admitted = await host.store.readDefinition(workflowSessionId);
    // R2-M1 / R3-S1: a bare claim shell swept before admission ends as WORKFLOW_DELETED (404), never SESSION_EXISTS.
    if (!admitted && (prior.rerunPin || request.rerunFrom)) {
        const liveShell = await host.catalog.getSession(workflowSessionId);
        if (!liveShell || liveShell.deletedAt) {
            throw new WorkflowStoreError("WORKFLOW_DELETED",
                "The Workflow for this key was deleted before it started. Use a new key or operationId for another attempt.");
        }
    }
    if (prior.rerunPin) {
        if (!request.rerunFrom) throw conflict("a fresh Start without rerunFrom");
        validateRerunStartArguments(request);
        if (!sameRerunPinRequest(prior.rerunPin, request.rerunFrom)) {
            throw conflict(`a different re-run request (${request.rerunFrom.workflowId})`);
        }
    } else if (request.rerunFrom) {
        throw conflict("a re-run Start");
    }
    const replayCompile = admitted ? compileWorkflow(saved.yaml) : null;
    const pinnedIr = admitted
        ? replayCompile?.valid && replayCompile.ir
            ? replayCompile.ir
            : saved.irSha256 ? await host.store.sessionDefinitions.readRevisionIr(prior.definitionId, prior.revision) : null
        : null;
    const admittedDecision = workflowDecisionNodes(pinnedIr).length > 0;
    const deleted = () => new WorkflowStoreError("WORKFLOW_DELETED", "The Workflow for this key was deleted. Use a new key for another attempt.");
    if (request.key !== undefined && admitted?.state === "deleted" && !admittedDecision) throw deleted();
    // The Decision digest already binds the original Run again id. Its source Workflow need not still be live.
    if (request.runAgainOf && !admittedDecision) {
        const earlier = (await host.store.sessionDefinitions.listWorkflows({ definitionId: prior.definitionId }))
            .find(item => item.workflowSessionId === request.runAgainOf);
        if (!earlier || earlier.revision !== prior.revision) throw conflict(`a run again of ${request.runAgainOf}`);
    }
    const resumedClaim = !admitted;
    let resumedIr: WorkflowIR | null = null;
    if (resumedClaim) {
        const again = compileWorkflow(saved.yaml);
        if (!again.valid) {
            const first = again.diagnostics.find(item => item.severity !== "warning");
            throw new WorkflowStoreError("DEFINITION_INVALID", `Revision ${prior.revision} of ${pinned.name} does not compile in this version`
                + `${first ? ` (${first.path}): ${first.message}` : "."} Save it again with that change. Nothing was started.`, { revision: prior.revision });
        }
        requireWorkflowScripts(host, again.ir, "start");
        await requireWorkflowStartLimits(host, parentSessionId, request.nestingLevel ?? null, { claimedWorkflowSessionId: workflowSessionId });
        resumedIr = again.ir;
    }
    let replayRerunSpec: RerunAdmissionSpec | null = null;
    let replayRunId: string | undefined;
    let replayStartInputs: JsonValue = request.inputs;
    if (prior.rerunPin) {
        if (admitted) {
            const runs = await host.store.listRuns(workflowSessionId);
            const admittedRun = runs[0] ?? null;
            if (admittedRun) replayStartInputs = admittedRun.inputs;
            const rf = request.rerunFrom!;
            const supObj = prior.rerunPin.mode === "supply" && isJsonObject(rf.result)
                ? {
                    newExecutionId: "",
                    newPredecessorId: null,
                    sourceExecutionId: prior.rerunPin.fromExecutionId,
                    outcome: String(rf.result.outcome),
                    outputText: canonicalJson(rf.result.output === undefined ? null : rf.result.output as JsonValue),
                    note: String(rf.note ?? "").trim(),
                    at: new Date(),
                }
                : null;
            replayRerunSpec = {
                sourceWorkflowSessionId: prior.rerunPin.sourceWorkflowId,
                sourceRunId: prior.rerunPin.sourceRunId,
                fromExecutionId: prior.rerunPin.fromExecutionId,
                mode: prior.rerunPin.mode,
                resume: admittedRun?.rerunResume ?? {
                    v: 1, mode: prior.rerunPin.mode, stateId: "", ordinal: 1, scopeId: "root",
                    arrivalRoute: null, predecessorId: null, cutKvRevision: 1, sameIr: true,
                    expectedInputSha256: null, expectedCarrySha256: null, recordedInputSha256: null,
                    supplied: null, fromStateId: "", fromVisit: 1, sourceRevision: prior.revision,
                },
                actor: request.actor,
                mapped: [],
                unwalkedCount: 0,
                supplied: supObj,
                cutKvRevision: 1,
                inboxCutAt: { sourceRunEnd: true },
                reusedSpawnChildIds: [],
                approvalOwnerCheck: null,
            };
        } else {
            const prepared = await prepareRerunStart(host, request, pinned, request.rerunFrom!, {
                revision: prior.revision,
                executionId: prior.rerunPin.fromExecutionId,
                mode: prior.rerunPin.mode,
            });
            replayRerunSpec = prepared.rerunSpec;
            replayRunId = prepared.newRunId;
            replayStartInputs = prepared.sourceInputs;
        }
    }
    // FB-008: a resumed claim has started nothing yet, so its grant is required as a first Start's is; a stored Workflow is
    // answered from what it made, and its grant is only compared.
    const creation = await host.catalog.getSessionCreationConfig?.(workflowSessionId) ?? null;
    const recordedBinding = readWorkflowToolBinding(creation?.workflowToolBinding);
    // B1: a re-run that inherited its grant carries the pinned grant again on a retry that names none (a keyed retry always
    // does). A stored Workflow is answered from its receipt; a bare claim has admitted nothing, so its pinned grant must pass
    // the fresh-Start inheritance rules again, for this caller and the owner's current policy, or the claim is refused.
    const inheritedGrant = prior.rerunPin?.grant === "inherited"
        && (request.key !== undefined || request.binding === undefined || request.binding === null);
    if (inheritedGrant && resumedClaim) {
        const refusal = recordedBinding ? await inheritedGrantRefusal(host, request, recordedBinding) : "the claim recorded no tool grant";
        if (refusal) {
            const marker = isJsonObject(creation) && isJsonObject(creation.workflow) ? creation.workflow : null;
            if (marker && marker.operationId === createOpId) {
                try {
                    await host.store.softDeleteRefusedClaimShell({ workflowSessionId, operationId: createOpId,
                        requestSha256: typeof marker.requestSha256 === "string" ? marker.requestSha256 : null });
                } catch {
                    // The refusal is the answer; a shell this could not remove is collected by the Sweeper after its grace period.
                }
            }
            throw new WorkflowStoreError("WORKFLOW_TOOLS_UNAVAILABLE",
                `${pinned.name} cannot inherit the source Workflow's tool grant (${refusal}). Nothing was started.`);
        }
    }
    const captured = request.key !== undefined || inheritedGrant ? recordedBinding : await startToolBinding(request.binding, resumedIr, pinned.name);
    const binding = captured ? { ...captured,
        ...(recordedBinding ? { config: {
            ...captured.config,
            workspace: recordedBinding.config.workspace,
            workspaceDefaults: recordedBinding.config.workspaceDefaults,
            workingDirectory: recordedBinding.config.workingDirectory,
        } } : {}),
    } : null;
    if (binding) {
        if (recordedBinding?.agentStepTools === "selections") binding.agentStepTools = "selections";
        else delete binding.agentStepTools;
    }
    const warnings = resumedClaim ? requireWorkflowToolRequirements(resumedIr, binding, pinned.name,
        await workflowAgentOffers(host, resumedIr, binding, request.ownerSessionId)) : [];
    const recordedWorkspace = readWorkflowWorkspace(creation);
    const explicitWorkspace = startWorkspaceArg(request.workspace);
    if (recordedWorkspace && request.workspaceInherited !== true && explicitWorkspace !== undefined) {
        const normalizedWorkspace = explicitWorkspace === "none" ? null : explicitWorkspace;
        const explicitDefaults = explicitWorkspace === "none" ? null
            : request.workspaceDefaults !== undefined ? request.workspaceDefaults : recordedWorkspace.defaults;
        const explicitWorkingDirectory = request.workspaceWorkingDirectory ?? undefined;
        if (!sameWorkspace(recordedWorkspace.workspace, normalizedWorkspace)
            || !sameDefaultsRecord(recordedWorkspace.defaults, explicitDefaults)
            || recordedWorkspace.workingDirectory !== explicitWorkingDirectory) {
            throw conflict("a different workspace");
        }
    }
    const workspace = recordedWorkspace ?? undefined;
    if (binding && workspace) binding.workspace = workspace;
    const decisionIr = resumedIr ?? pinnedIr;
    const hasExplicitModels = request.agentModels != null || request.decisionModels != null;
    let requestedModels: WorkflowAgentModels | null;
    try {
        requestedModels = hasExplicitModels || !admittedDecision
            ? await startAgentModelsOf(host, request, decisionIr ?? resumedIr, `revision ${prior.revision} of ${pinned.name}`)
            : null;
        if (decisionIr && hasExplicitModels) {
            requireAgentModelsForRevision(requestedModels, decisionIr, `revision ${prior.revision} of ${pinned.name}`);
        }
    } catch (error) {
        // A keyed repeat whose Agent map does not fit the revision this key started cannot be that start (the original passed
        // the same check), so it is the key's conflict, as it was before this check ran here. A decision_models alias that
        // names the wrong kind of state keeps its own refusal.
        if (request.key !== undefined && admitted && request.agentModels != null && request.decisionModels == null
            && error instanceof WorkflowStoreError && error.code === "AGENT_MODELS_INVALID") {
            throw new WorkflowStoreError("OPERATION_CONFLICT", "This key was used for a different Workflow start. Use a new key for another attempt.");
        }
        throw error;
    }
    const modelRequest = decisionModelRequestDigest(request, decisionIr, requestedModels);
    const agentModels = admittedDecision ? null : requestedModels;
    const modelsFromRunAgain = Boolean(request.runAgainOf) && !hasExplicitModels;
    const createRequest: CreateWorkflowRequest = {
        workflowSessionId, parentSessionId, ...(request.owner ? { owner: request.owner } : {}), yaml: saved.yaml,
        actor: request.actor, operationId: createOpId, publish: true,
        start: { inputs: replayStartInputs, ...(request.vars ? { vars: request.vars } : {}),
            ...(agentModels ? { agentModels, ...(modelsFromRunAgain ? { agentModelsFromRunAgain: true } : {}) } : {}),
            ...(modelRequest ? { modelRequest } : {}),
            ...(replayRunId ? { runId: replayRunId } : {}),
            ...(replayRerunSpec ? { rerun: replayRerunSpec } : {}) },
        ...(prior.rerunPin ? { rerunPin: prior.rerunPin } : {}),
        notifyParent: request.notifyParent !== false, ...(binding ? { binding } : {}),
        ...(workspace ? { workspace } : {}),
        sessionPin: { ownerSessionId: request.ownerSessionId, definitionId: prior.definitionId, revision: prior.revision },
        ...(request.spawn ? { spawn: request.spawn } : {}),
        ...(resumedClaim ? { childBudget: { max: WORKFLOW_START_MAX_RUNNING_CHILDREN } } : {}),
    };
    if (request.key !== undefined && admitted) {
        // The catalog hides deleted sessions. For exact Decision replay the pinned definition still proves the parent,
        // and the receipt digest below still verifies the original owner, grant and intent.
        const row = admitted.state === "deleted" ? null : await host.catalog.getSession(workflowSessionId);
        const owner = request.owner ?? null;
        if (row?.deletedAt && !modelRequest) throw deleted();
        const owned = admitted.state === "deleted" ? admitted.parentSessionId === parentSessionId
            : row?.parentSessionId === parentSessionId && row.sessionKind === "workflow"
                && row.owner?.provider === owner?.provider && row.owner?.subject === owner?.subject;
        if (!owned) {
            throw new WorkflowStoreError("WORKFLOW_EXISTS", "The Workflow for this key no longer belongs to this session and owner.");
        }
        const yamlSha256 = sha256Hex(saved.yaml);
        const digest = workflowCreateRequestSha256(createRequest, yamlSha256, true, replayStartInputs);
        let recorded;
        try { recorded = await readWorkflowCreateReceipt(host, createRequest, yamlSha256, digest); }
        catch (error) {
            if (error instanceof WorkflowStoreError && error.code === "OPERATION_CONFLICT") {
                throw new WorkflowStoreError("OPERATION_CONFLICT", "This key was used for a different Workflow start. Use a new key for another attempt.");
            }
            throw error;
        }
        if (recorded === null) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "The Workflow for this key has no stored Start receipt.");
        const receipt = parseDefinitionReceipt(recorded);
        await dispatchWorkflowRun(host, receipt);
        const effectiveModels = admittedDecision && receipt.run ? await runAgainAgentModels(host, workflowSessionId) : agentModels;
        return { operation: "start", definitionId: prior.definitionId, name: pinned.name, revision: prior.revision,
            workflowId: receipt.workflowSessionId, runId: receipt.run?.runId ?? null, replayed: true,
            ...(prior.rerunPin ? { rerun: rerunReceiptFromPin(prior.rerunPin) } : {}),
            ...startReceiptModelFields(effectiveModels, decisionIr ?? compileWorkflow(saved.yaml).ir),
            ...(await delegatedAnswer(host, workflowSessionId)) };
    }
    let stored;
    try { stored = await createWorkflow(host, createRequest); }
    catch (error) {
        if ((request.key !== undefined || Boolean(request.spawn)) && error instanceof WorkflowStoreError && error.code === "WORKFLOW_EXISTS") {
            throw new WorkflowStoreError("OPERATION_CONFLICT", "This key was used for a different Workflow start. Use a new key for another attempt.");
        }
        throw error;
    }
    const effectiveModels = stored.receipt.run ? await runAgainAgentModels(host, stored.receipt.workflowSessionId) : null;
    return { operation: "start", definitionId: prior.definitionId, name: pinned.name, revision: prior.revision, workflowId: stored.receipt.workflowSessionId,
        runId: stored.receipt.run?.runId ?? null, replayed: stored.replayed, ...(warnings.length ? { warnings } : {}),
        ...(prior.rerunPin ? { rerun: rerunReceiptFromPin(prior.rerunPin) } : {}),
        ...(await delegatedAnswer(host, workflowSessionId)),
        ...startReceiptModelFields(effectiveModels, decisionIr ?? compileWorkflow(saved.yaml).ir) };
}

async function prepareRerunStart(
    host: WorkflowHost,
    request: Parameters<typeof startSessionWorkflowDefinition>[1],
    definition: SessionDefinitionRow,
    rf: SessionStartRerunFrom,
    pinned?: { revision: number; executionId: string; mode: WorkflowRerunMode },
): Promise<{
    newRunId: string;
    revision: number;
    saved: SessionRevisionRow;
    targetIr: WorkflowIR;
    sourceInputs: JsonValue;
    rerunSpec: RerunAdmissionSpec;
    rerunPin: RerunClaimPin;
}> {
    const sourceDef = await host.store.readDefinition(rf.workflowId);
    if (!sourceDef || sourceDef.sessionDefinitionId !== definition.definitionId || !Number.isSafeInteger(sourceDef.sessionRevision)) {
        throw new WorkflowStoreError("WORKFLOW_NOT_FOUND", `Workflow ${rf.workflowId} was not started from ${definition.name}.`);
    }
    const srcSession = await host.catalog.getSession(rf.workflowId);
    if (!srcSession || srcSession.deletedAt || sourceDef.state === "deleted") {
        throw new WorkflowStoreError("RERUN_SOURCE_GONE", `Source Workflow ${rf.workflowId} has been deleted and cannot be re-run.`);
    }
    const sourceRuns = await host.store.listRuns(rf.workflowId);
    const sourceRun = sourceRuns.find(r => r.mode === "live") ?? null;
    if (!sourceRun) {
        throw new WorkflowStoreError("RERUN_NOT_A_WORKFLOW", `Workflow ${rf.workflowId} has no live run to re-run.`);
    }
    if (!sourceRun.finishedAt || sourceRun.status === "admitted" || sourceRun.status === "running" || sourceRun.status === "paused") {
        throw new WorkflowStoreError("RERUN_SOURCE_ACTIVE", `Source Workflow ${rf.workflowId} is still ${sourceRun.status}; wait for it to finish before re-running.`);
    }
    // Decision 8: default revision is the source run's revision (NOT newestValidRevision).
    const sourceRevision = sourceDef.sessionRevision as number;
    const revision = pinned?.revision ?? (request.revision != null ? request.revision : sourceRevision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "revision must be a revision number.");
    }
    const saved = await host.store.sessionDefinitions.readRevision(definition.definitionId, revision);
    if (!saved) throw new WorkflowStoreError("REVISION_NOT_FOUND", `${definition.name} has no revision ${revision}.`);
    if (!saved.valid) {
        throw new WorkflowStoreError("DEFINITION_INVALID", `Revision ${revision} of ${definition.name} is not valid, so it cannot start. Save a fixed revision first.`);
    }
    const targetCompile = compileWorkflow(saved.yaml);
    if (!targetCompile.valid || !targetCompile.ir) {
        const first = targetCompile.diagnostics.find(item => item.severity !== "warning");
        throw new WorkflowStoreError("DEFINITION_INVALID", `Revision ${revision} of ${definition.name} does not compile in this version`
            + `${first ? ` (${first.path}): ${first.message}` : "."} Save it again with that change. Nothing was started.`, { revision });
    }
    const targetIr = targetCompile.ir;
    const sourceSaved = sourceRevision === revision
        ? saved
        : await host.store.sessionDefinitions.readRevision(definition.definitionId, sourceRevision);
    const sourceCompile = sourceRevision === revision
        ? targetCompile
        : (sourceSaved ? compileWorkflow(sourceSaved.yaml) : null);
    const sourceIr = sourceCompile?.ir ?? await host.store.sessionDefinitions.readRevisionIr(definition.definitionId, sourceRevision);
    const sourceIrSha256 = sourceCompile?.irSha256 ?? sourceSaved?.irSha256 ?? targetCompile.irSha256 ?? "";
    if (!sourceIr) {
        throw new WorkflowStoreError("RERUN_INCOMPATIBLE", `Source revision ${sourceRevision} of ${definition.name} cannot be loaded for re-run compatibility.`);
    }
    const keys = await host.store.listRerunKeys(sourceRun.runId);
    const picked = pickRerunTarget(sourceRun, keys, {
        executionId: pinned?.executionId ?? rf.executionId ?? null,
        mode: pinned?.mode ?? rf.mode ?? null,
        sourceIr,
        targetIr,
    });
    const part = partitionRerunVisits(keys, picked.chosen.nodeExecutionId, picked.mode);
    const supplyCheck = picked.mode === "supply"
        ? validateRerunSupply({
            chosen: picked.chosen,
            reused: part.reused,
            sourceIr,
            targetIr,
            result: rf.result,
            note: rf.note,
            requireResultAndNote: true,
        })
        : null;
    const validatedSupply = supplyCheck?.validated ?? null;
    if (rf._skipFitCheckForTest !== true) {
        const fit = checkRerunCompatibility({
            sourceIr,
            targetIr,
            reused: part.reused,
            reusedTop: part.reusedTop,
            chosen: picked.chosen,
            mode: picked.mode,
            sourceControllerVersion: sourceRun.controllerVersion,
            suppliedOutcome: validatedSupply?.outcome ?? null,
        });
        if (!fit.fits) {
            throw new WorkflowStoreError("RERUN_INCOMPATIBLE",
                `Revision ${revision} of ${definition.name} is not compatible with the reused history (${fit.problems[0]?.message ?? "incompatible graph"}).`,
                { revision, problems: fit.problems.map(p => ({ ...p })) as unknown as JsonValue });
        }
    }
    // OQ5 / M3 / R2-N8: answered approval reuse gate.
    const reusedApprovals = part.reused.filter(v => v.nodeType === "approval" && (v.outcome === "approved" || v.outcome === "rejected"));
    const directOwner = request.actor.kind === "user" && request.originatingSessionId == null && request.viaMcp !== true
        ? { provider: request.actor.provider, subject: request.actor.subject } : null;
    if (reusedApprovals.length > 0) {
        if (!directOwner) {
            throw new WorkflowStoreError("RERUN_APPROVAL_REUSED",
                "Re-running past a decided approval is only allowed for the owning person directly (not via MCP or an agent).");
        }
        const ownerSession = await host.catalog.getSession(request.ownerSessionId);
        if (!ownerSession || !ownerSession.owner
            || ownerSession.owner.provider !== directOwner.provider || ownerSession.owner.subject !== directOwner.subject) {
            throw new WorkflowStoreError("RERUN_APPROVAL_REUSED",
                "Re-running past a decided approval requires the owning person of the session.");
        }
        const approvalRows = await host.store.readReusedApprovalsForRerun(sourceRun.runId, reusedApprovals.map(a => a.nodeExecutionId));
        if (approvalRows.length !== reusedApprovals.length) {
            throw new WorkflowStoreError("RERUN_APPROVAL_REUSED",
                "Cannot verify approver provenance for every reused approval.");
        }
        for (const app of approvalRows) {
            if (!app.decidedBy || app.decidedBy.provider !== directOwner.provider || app.decidedBy.subject !== directOwner.subject) {
                throw new WorkflowStoreError("RERUN_APPROVAL_REUSED",
                    "Every reused approval must have been decided by the person starting this re-run.");
            }
        }
    }
    const newRunId = randomUUID();
    const mapped = mapRerunExecutions(newRunId, part.reused);
    const cutKvRevision = rerunCutKvRevision({
        mode: picked.mode, chosen: picked.chosen, reused: part.reused, firstDroppedTop: part.firstDroppedTop, sourceKvRevision: sourceRun.kvRevision,
    });
    const now = new Date();
    const nowIso = now.toISOString();
    let suppliedSpec: RerunAdmissionSpec["supplied"] = null;
    let resumeSupplied: Parameters<typeof buildRerunResume>[0]["supplied"] = null;
    if (picked.mode === "supply" && validatedSupply) {
        const mappedSup = mapRerunSuppliedExecution(newRunId, picked.chosen, mapped);
        const nextEntry = supplyCheck?.contract.nextByOutcome[validatedSupply.outcome] ?? null;
        const nextStateId = nextEntry?.stateId ?? null;
        const nextOrdinal = nextEntry?.visit ?? null;
        const outputText = validatedSupply.outputText ?? "null";
        const outputSha256 = validatedSupply.outputSha256 ?? sha256Hex(outputText);
        const note = validatedSupply.note ?? "";
        suppliedSpec = {
            newExecutionId: mappedSup.newId,
            newPredecessorId: mappedSup.newPredecessorId,
            sourceExecutionId: picked.chosen.nodeExecutionId,
            outcome: validatedSupply.outcome,
            outputText,
            note,
            at: now,
        };
        resumeSupplied = {
            mappedSuppliedId: mappedSup.newId,
            outcome: validatedSupply.outcome,
            outputSha256,
            note,
            at: nowIso,
            nextStateId,
            nextOrdinal,
        };
    }
    let mappedPredecessorId: string | null;
    if (picked.mode === "continue") {
        // In continue mode V is the last reused top-level visit, so it is always mapped; a miss is a broken partition.
        const mappedChosen = mapped.find(m => m.source.nodeExecutionId === picked.chosen.nodeExecutionId);
        if (!mappedChosen) {
            throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT",
                `The chosen visit ${picked.chosen.nodeExecutionId} is missing from the reused visits of a continue re-run.`,
                { reason: "missing_chosen", executionId: picked.chosen.nodeExecutionId });
        }
        mappedPredecessorId = mappedChosen.newId;
    } else {
        mappedPredecessorId = picked.chosen.predecessorId === null
            ? null
            : (mapped.find(m => m.source.nodeExecutionId === picked.chosen.predecessorId)?.newId ?? null);
    }
    const resume = buildRerunResume({
        mode: picked.mode,
        chosen: picked.chosen,
        mappedPredecessorId,
        cutKvRevision,
        sourceRevision,
        sourceIrSha256,
        targetIrSha256: targetCompile.irSha256 ?? "",
        supplied: resumeSupplied,
    });
    // Design §5.4 / §3.5.2: run_again cuts at V's entry; continue and supply cut at the first dropped top-level visit
    // after V, or at the source run's end when V was its last top-level visit. The store reads that time exactly (D-I1).
    const inboxCutAt: RerunInboxCut = picked.mode === "run_again"
        ? { enteredAtOf: picked.chosen.nodeExecutionId }
        : (part.firstDroppedTop ? { enteredAtOf: part.firstDroppedTop.nodeExecutionId } : { sourceRunEnd: true });
    const reusedSpawnChildIds = part.reused
        .filter(v => v.nodeType === "spawn" && typeof v.spawnChildWorkflowId === "string" && v.spawnChildWorkflowId.length > 0)
        .map(v => v.spawnChildWorkflowId!);
    const rerunSpec: RerunAdmissionSpec = {
        sourceWorkflowSessionId: rf.workflowId,
        sourceRunId: sourceRun.runId,
        fromExecutionId: picked.chosen.nodeExecutionId,
        mode: picked.mode,
        resume,
        actor: request.actor,
        mapped,
        unwalkedCount: part.reused.length - part.reusedTop.length,
        supplied: suppliedSpec,
        cutKvRevision,
        varsOverlay: request.vars ?? null,
        inboxCutAt,
        reusedSpawnChildIds,
        approvalOwnerCheck: reusedApprovals.length > 0 ? directOwner : null,
    };
    const rerunPin: RerunClaimPin = {
        sourceWorkflowId: rf.workflowId,
        sourceRunId: sourceRun.runId,
        fromExecutionId: picked.chosen.nodeExecutionId,
        mode: picked.mode,
        revision,
        reusedCount: part.reused.length,
        ...(suppliedSpec ? {
            supplied: {
                outcome: suppliedSpec.outcome,
                outputSha256: sha256Hex(suppliedSpec.outputText),
                noteSha256: sha256Hex(suppliedSpec.note),
                note: suppliedSpec.note,
            },
        } : {}),
    };
    return { newRunId, revision, saved, targetIr, sourceInputs: sourceRun.inputs, rerunSpec, rerunPin };
}

/**
 * FB-008: the session's tool grant for a Start. Only script states call tools, through this grant. When the grant cannot be
 * captured, a revision with a script state is refused (WORKFLOW_PARENT_CONTEXT_UNAVAILABLE, as spawn_workflow refuses), so
 * no run starts whose scripts would fail at their first tool call; a revision with none starts without it. `ir` null: the
 * grant is not required (a stored Workflow's replay). A caller that passes no capture (a person's Start) passes no grant.
 */
function startWorkspaceArg(value: unknown): SessionWorkspace | null | "none" | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === "none") return value;
    const checked = validateWorkspaceText(value);
    if (!checked.ok) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `workspace is invalid: ${checked.code}: ${checked.message}`);
    return checked.workspace;
}

function startWorkspaceSelection(binding: WorkflowToolBinding | null, request: {
    workspace?: SessionWorkspace | null | "none"; workspaceDefaults?: WorkspaceDefaultsRecord | null; workspaceInherited?: boolean;
    workspaceWorkingDirectory?: string;
}): WorkflowWorkspace {
    const explicitNoDefaults = request.workspace === "none";
    const requestedWorkspace = request.workspace === "none" ? null : request.workspace;
    const workspace = requestedWorkspace !== undefined ? requestedWorkspace : binding?.config.workspace ?? null;
    return workflowWorkspaceSnapshot(workspace,
        explicitNoDefaults ? null
            : request.workspaceDefaults !== undefined ? request.workspaceDefaults : binding?.config.workspaceDefaults ?? null,
        request.workspaceInherited === true && workspace === null ? request.workspaceWorkingDirectory ?? binding?.config.workingDirectory : undefined);
}

async function startToolBinding(binding: WorkflowToolBinding | null | undefined | (() => Promise<WorkflowToolBinding | null>),
    ir: Pick<WorkflowIR, "nodes"> | null | undefined, name: string): Promise<WorkflowToolBinding | null> {
    if (typeof binding !== "function") return binding ?? null;
    try {
        return await binding();
    } catch {
        const scriptNodes = workflowScriptNodes(ir);
        if (!scriptNodes.length) return null;
        const list = scriptNodes.slice(0, 5).join(", ") + (scriptNodes.length > 5 ? `, and ${scriptNodes.length - 5} more` : "");
        throw new WorkflowStoreError(WORKFLOW_PARENT_CONTEXT_UNAVAILABLE, `${name} was not started: this session's tools could not be `
            + `handed to it, and its script state${scriptNodes.length === 1 ? "" : "s"} (${list}) can call tools only through them. `
            + "Nothing was started. Call workflow_definition start again; if it is refused again, tell the user.", { scriptNodes });
    }
}

export async function startSessionWorkflowDefinition(host: WorkflowHost, request: {
    /** The session that owns the saved definition (nearest non-Workflow ancestor). */
    ownerSessionId: string;
    /** The parent of the started Workflow; defaults to ownerSessionId (set to the parent Workflow for a spawn state). */
    parentSessionId?: string | null;
    /** Internal spawn mode: selects the spawn key namespace and exact parent-run lock. */
    spawn?: { nodeExecutionId: string } | null;
    definition: { definitionId?: string | null; name?: string | null };
    revision?: number | null;
    runAgainOf?: string | null;
    inputs: JsonValue;
    vars?: { [key: string]: JsonValue } | null;
    notifyParent?: boolean;
    actor: WorkflowActor;
    operationId: string;
    /** Exact idempotency key, scoped to the owning session. New key: a deliberate new attempt. */
    key?: string;
    owner?: SessionOwnerInfo | null;
    binding?: WorkflowToolBinding | null | (() => Promise<WorkflowToolBinding | null>);
    /** Omit to inherit; null keeps captured defaults without a record; "none" clears record and defaults. */
    workspace?: unknown;
    /** Internal person/agent bridge value: the parent's defaults captured for this Start. */
    workspaceDefaults?: WorkspaceDefaultsRecord | null;
    /** Internal raw directory for a workspace-less inherited Start; absent for an explicit null. */
    workspaceWorkingDirectory?: string;
    /** Internal marker: the bridge derived workspace from the parent, so an idempotent replay keeps the recorded one. */
    workspaceInherited?: boolean;
    /** Stage 2.4: the session's nesting level, when the caller knows it (the session's own tools do); the depth limit needs it. */
    nestingLevel?: number | null;
    /**
     * OF-S2-7: agent node models chosen at start, by state id (agent-models.ts); checked against the revision started and the
     * owning session's catalog. Absent with runAgainOf: the models the repeated Workflow was started with.
     */
    /** As given (parsed by the start): an explicit empty map clears Run again's choices (OF7-R4). */
    agentModels?: unknown;
    /** Additive Decision-only tool alias, merged with explicit agentModels before revision validation. */
    decisionModels?: unknown;
    /** Phase 3 I7: re-run from a chosen visit of an ended Workflow of this definition. */
    rerunFrom?: SessionStartRerunFrom | null;
    /** Phase 3 I7 (OQ5): true when invoked through MCP; refuses reusing answered approvals even for the owner. */
    viaMcp?: boolean;
    /** Phase 3 I7 (M3): set when proxied through an agent session; refuses OQ1 grant inheritance and approval reuse. */
    originatingSessionId?: string | null;
}): Promise<SessionStartReceipt> {
    const parentSessionId = request.parentSessionId ?? request.ownerSessionId;
    request = { ...request, operationId: workflowStartOperationId(request.operationId, request.key) };
    await requireSessionDefinitionsWritable(host, request.ownerSessionId);
    // A keyed attempt belongs to the session, not to the surface (agent tool or person API) that submitted it.
    if (request.key !== undefined) request = { ...request, owner: (await host.catalog.getSession(request.ownerSessionId))?.owner ?? null };
    const workflowSessionId = systemChildAgentUUID(parentSessionId, `workflow:start:${request.operationId}`);
    // S2RT-F5: a Start is receipt-first. When this operation already made its Workflow (or claimed it and was interrupted
    // before admitting it), it continues with the definition and revision it pinned then, never with a default chosen again
    // (a later save would otherwise select another revision); a request that names another one is refused.
    const prior = await storedStartPin(host, workflowSessionId);
    if (prior) return replaySessionStart(host, request, workflowSessionId, prior);
    if (request.rerunFrom) {
        const rf = validateRerunStartArguments(request);
        const definition = await definitionOf(host, request.ownerSessionId, request.definition);
        const prepared = await prepareRerunStart(host, request, definition, rf);
        if (host.scripts === false) {
            requireWorkflowScripts(host, prepared.targetIr, "start");
        }
        await requireWorkflowStartLimits(host, parentSessionId, request.nestingLevel ?? null);
        const resolvedGrant = await resolveRerunToolBinding(host, request, rf.workflowId, prepared.targetIr, definition.name);
        const binding = resolvedGrant.binding;
        const workspace = resolvedGrant.sourceWorkspace ?? startWorkspaceSelection(binding, {
            ...(request.workspaceDefaults !== undefined ? { workspaceDefaults: request.workspaceDefaults } : {}),
            ...(request.workspaceWorkingDirectory !== undefined ? { workspaceWorkingDirectory: request.workspaceWorkingDirectory } : {}),
            ...(request.workspaceInherited !== undefined ? { workspaceInherited: request.workspaceInherited } : {}),
        });
        if (binding) binding.workspace = workspace;
        const offers = await workflowAgentOffers(host, prepared.targetIr, binding, request.ownerSessionId);
        const warnings = requireWorkflowToolRequirements(prepared.targetIr, binding, definition.name, offers);
        const rerunPin: RerunClaimPin = {
            ...prepared.rerunPin,
            ...(resolvedGrant.inherited ? { grant: "inherited" as const } : {}),
        };
        const agentModels = await startAgentModelsOf(host, request, prepared.targetIr, `revision ${prepared.revision} of ${definition.name}`);
        const modelRequest = decisionModelRequestDigest(request, prepared.targetIr, agentModels);
        const createOpId = `start:${request.operationId}`;
        let stored;
        try {
            stored = await createWorkflow(host, {
                workflowSessionId,
                parentSessionId,
                ...(request.owner ? { owner: request.owner } : {}),
                yaml: prepared.saved.yaml,
                actor: request.actor,
                operationId: createOpId,
                publish: true,
                start: {
                    inputs: prepared.sourceInputs,
                    ...(request.vars ? { vars: request.vars } : {}),
                    ...(agentModels ? { agentModels } : {}),
                    ...(modelRequest ? { modelRequest } : {}),
                    runId: prepared.newRunId,
                    rerun: prepared.rerunSpec,
                },
                rerunPin,
                notifyParent: request.notifyParent !== false,
                ...(binding ? { binding } : {}),
                workspace,
                sessionPin: { ownerSessionId: request.ownerSessionId, definitionId: definition.definitionId, revision: prepared.revision },
                childBudget: { max: WORKFLOW_START_MAX_RUNNING_CHILDREN },
            });
        } catch (error) {
            if (request.key !== undefined && error instanceof WorkflowStoreError && error.code === "WORKFLOW_EXISTS") {
                throw new WorkflowStoreError("OPERATION_CONFLICT", "This key was used for a different Workflow start. Use a new key for another attempt.");
            }
            throw error;
        }
        const receipt: WorkflowDefinitionReceipt = stored.receipt;
        const effectiveModels = receipt.run ? await runAgainAgentModels(host, receipt.workflowSessionId) : null;
        return {
            operation: "start",
            definitionId: definition.definitionId,
            name: definition.name,
            revision: prepared.revision,
            workflowId: receipt.workflowSessionId,
            runId: receipt.run?.runId ?? null,
            replayed: stored.replayed,
            rerun: rerunReceiptFromPin(rerunPin),
            ...(warnings.length ? { warnings } : {}),
            ...(await delegatedAnswer(host, workflowSessionId)),
            ...startReceiptModelFields(effectiveModels, prepared.targetIr),
        };
    }
    const definition = await definitionOf(host, request.ownerSessionId, request.definition);
    let revision: number | null = request.revision ?? null;
    if (request.runAgainOf) {
        const workflows = await host.store.sessionDefinitions.listWorkflows({ definitionId: definition.definitionId });
        const earlier = workflows.find(item => item.workflowSessionId === request.runAgainOf) ?? null;
        if (!earlier) throw new WorkflowStoreError("WORKFLOW_NOT_FOUND", `Workflow ${request.runAgainOf} was not started from ${definition.name}.`);
        revision = earlier.revision;
    }
    if (revision === null) {
        revision = await host.store.sessionDefinitions.newestValidRevision(definition.definitionId);
        if (revision === null) {
            throw new WorkflowStoreError("DEFINITION_INVALID", `${definition.name} has no valid revision yet, so it cannot start. Save a fixed revision first.`);
        }
    }
    if (!Number.isSafeInteger(revision) || revision < 1) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "revision must be a revision number.");
    const saved = await host.store.sessionDefinitions.readRevision(definition.definitionId, revision);
    if (!saved) throw new WorkflowStoreError("REVISION_NOT_FOUND", `${definition.name} has no revision ${revision}.`);
    if (!saved.valid) {
        throw new WorkflowStoreError("DEFINITION_INVALID", `Revision ${revision} of ${definition.name} is not valid, so it cannot start. Save a fixed revision first.`);
    }
    // Owner 2026-11-09T06:30Z: a Start compiles the revision's YAML again. One this build no longer compiles is refused with its
    // first error, so the one save it needs is plain.
    const again = compileWorkflow(saved.yaml);
    if (!again.valid) {
        const first = again.diagnostics.find(item => item.severity !== "warning");
        throw new WorkflowStoreError("DEFINITION_INVALID", `Revision ${revision} of ${definition.name} does not compile in this version`
            + `${first ? ` (${first.path}): ${first.message}` : "."} Save it again with that change. Nothing was started.`, { revision });
    }
    if (host.scripts === false) {
        requireWorkflowScripts(host, await host.store.sessionDefinitions.readRevisionIr(definition.definitionId, revision), "start");
    }
    // Stage 2.4: spawn_agent's depth limit and its shared budget of running children, after the scripts gate. A repeated
    // start (the same operation) was answered from its receipt above, so a retry is never refused by the Workflow it made.
    await requireWorkflowStartLimits(host, parentSessionId, request.nestingLevel ?? null);
    const captured = await startToolBinding(request.binding, again.ir, definition.name);
    const binding = captured ? { ...captured, agentStepTools: "selections" as const } : null;
    const explicitWorkspace = startWorkspaceArg(request.workspace);
    const workspace = startWorkspaceSelection(binding, {
        ...(explicitWorkspace !== undefined ? { workspace: explicitWorkspace } : {}),
        ...(request.workspaceDefaults !== undefined ? { workspaceDefaults: request.workspaceDefaults } : {}),
        ...(request.workspaceWorkingDirectory !== undefined ? { workspaceWorkingDirectory: request.workspaceWorkingDirectory } : {}),
        ...(request.workspaceInherited !== undefined ? { workspaceInherited: request.workspaceInherited } : {}),
    });
    if (binding) binding.workspace = workspace;
    const offers = await workflowAgentOffers(host, again.ir, binding, request.ownerSessionId);
    const warnings = requireWorkflowToolRequirements(again.ir, binding, definition.name, offers);
    // OF-S2-7: checked against this revision and the owning session's catalog by createWorkflow, before anything is written.
    const agentModels = await startAgentModelsOf(host, request, again.ir, `revision ${revision} of ${definition.name}`);
    const modelsFromRunAgain = Boolean(request.runAgainOf) && request.agentModels == null && request.decisionModels == null;
    const modelRequest = decisionModelRequestDigest(request, again.ir, agentModels);
    const createOpId = request.spawn ? `spawn:${request.spawn.nodeExecutionId}` : `start:${request.operationId}`;
    let stored;
    try { stored = await createWorkflow(host, {
        workflowSessionId, parentSessionId, ...(request.owner ? { owner: request.owner } : {}), yaml: saved.yaml,
        actor: request.actor, operationId: createOpId, publish: true,
        start: { inputs: request.inputs, ...(request.vars ? { vars: request.vars } : {}),
            ...(agentModels ? { agentModels, ...(modelsFromRunAgain ? { agentModelsFromRunAgain: true } : {}) } : {}),
            ...(modelRequest ? { modelRequest } : {}) },
        notifyParent: request.notifyParent !== false, ...(binding ? { binding } : {}), workspace,
        sessionPin: { ownerSessionId: request.ownerSessionId, definitionId: definition.definitionId, revision },
        ...(request.spawn ? { spawn: request.spawn } : {}),
        // S2RT-F3: the budget again, under the session's exclusive lock, in the claim's transaction.
        childBudget: { max: WORKFLOW_START_MAX_RUNNING_CHILDREN },
    }); } catch (error) {
        if ((request.key !== undefined || Boolean(request.spawn)) && error instanceof WorkflowStoreError && error.code === "WORKFLOW_EXISTS") {
            throw new WorkflowStoreError("OPERATION_CONFLICT", "This key was used for a different Workflow start. Use a new key for another attempt.");
        }
        throw error;
    }
    const receipt: WorkflowDefinitionReceipt = stored.receipt;
    const effectiveModels = receipt.run ? await runAgainAgentModels(host, receipt.workflowSessionId) : null;
    return { operation: "start", definitionId: definition.definitionId, name: definition.name, revision, workflowId: receipt.workflowSessionId,
        runId: receipt.run?.runId ?? null, replayed: stored.replayed, ...(warnings.length ? { warnings } : {}),
        ...(await delegatedAnswer(host, workflowSessionId)),
        ...startReceiptModelFields(effectiveModels, again.ir) };
}

async function delegatedAnswer(host: Pick<WorkflowHost, "store">, workflowSessionId: string): Promise<{ delegated?: JsonObject[] }> {
    const delegated = await host.store.readWorkflowToolsDelegated(workflowSessionId);
    return delegated === null ? {} : { delegated };
}

/** One definition as the tool, the Web API and the screens read it. */
async function viewOf(host: Pick<WorkflowHost, "store">, definition: SessionDefinitionRow): Promise<SessionDefinitionView> {
    const [listed, workflows, newestValidRevision, tests] = await Promise.all([
        host.store.sessionDefinitions.listRevisions(definition.definitionId),
        host.store.sessionDefinitions.listWorkflows({ definitionId: definition.definitionId }),
        host.store.sessionDefinitions.newestValidRevision(definition.definitionId),
        host.store.sessionDefinitions.listTests(definition.ownerSessionId, definition.definitionId),
    ]);
    // Stage 2.2: each revision's newest agent test (tests are listed newest first), only when one ran.
    const revisions = listed.map(item => {
        const test = tests.find(row => row.revision === item.revision);
        return test ? { ...item, lastTest: { testId: test.testId, verdict: test.verdict, at: test.endedAt ?? test.startedAt } } : item;
    });
    return { ...definition, current: revisions.find(item => item.revision === definition.currentRevision) ?? null, newestValidRevision, revisions, workflows };
}

/** The session's definitions (deleted ones only when asked). `forSession`: the session read them, so it has seen each newest revision. */
export async function listSessionWorkflowDefinitions(host: Pick<WorkflowHost, "store">, ownerSessionId: string,
    options: { forSession?: boolean; includeDeleted?: boolean } = {}): Promise<SessionDefinitionView[]> {
    const definitions = await host.store.sessionDefinitions.listDefinitions(ownerSessionId, { includeDeleted: options.includeDeleted === true });
    const views = await Promise.all(definitions.map(definition => viewOf(host, definition)));
    if (options.forSession) await host.store.sessionDefinitions.markSeen(ownerSessionId, views.filter(view => view.deletedAt === null)
        .map(view => ({ definitionId: view.definitionId, revision: view.currentRevision })));
    return views;
}

/**
 * One definition (by id, or the session's live one of that name) with a revision's YAML and diagnostics (default the newest).
 * A deleted definition is read by its id (its Workflows keep their copies). `forSession`: the session has seen its newest revision.
 * `graph` (the screens' read, stage 2.1b): the revision's graph as a Workflow's view draws it (workflowGraphJson), for a
 * valid revision; null for one with errors.
 */
export async function readSessionWorkflowDefinition(host: Pick<WorkflowHost, "store">, ownerSessionId: string,
    ref: { definitionId?: string | null; name?: string | null }, options: { revision?: number | null; forSession?: boolean; graph?: boolean } = {})
    : Promise<SessionDefinitionView & { revision: SessionRevisionRow | null; graph?: { [key: string]: JsonValue } | null }> {
    const definition = ref.definitionId ? await host.store.sessionDefinitions.readDefinition(ref.definitionId)
        : ref.name ? await host.store.sessionDefinitions.readDefinitionByName(ownerSessionId, ref.name) : null;
    if (!definition || definition.ownerSessionId !== ownerSessionId) {
        throw new WorkflowStoreError("DEFINITION_NOT_FOUND", ref.name ? `This session has no Workflow Definition named ${ref.name}.` : "This session has no such Workflow Definition.");
    }
    const view = await viewOf(host, definition);
    const number = options.revision ?? definition.currentRevision;
    const revision = number >= 1 ? await host.store.sessionDefinitions.readRevision(definition.definitionId, number) : null;
    if (options.revision != null && !revision) throw new WorkflowStoreError("REVISION_NOT_FOUND", `${definition.name} has no revision ${options.revision}.`);
    if (options.forSession && definition.deletedAt === null) {
        await host.store.sessionDefinitions.markSeen(ownerSessionId, [{ definitionId: definition.definitionId, revision: definition.currentRevision }]);
    }
    if (!options.graph) return { ...view, revision };
    // Owner 2026-11-09T07:03Z: the graph shows what a Start runs. A Start compiles the revision's YAML again, so a revision
    // saved before an agent session's default changed shows it as a Start runs it. A YAML this build no longer compiles
    // shows the graph stored with it; its Start is refused in words.
    const again = revision?.valid && typeof revision.yaml === "string" ? compileWorkflow(revision.yaml) : null;
    const ir = again?.valid && again.ir ? again.ir : revision?.valid && revision.irSha256
        ? await host.store.sessionDefinitions.readRevisionIr(definition.definitionId, revision.revision) : null;
    return { ...view, revision, graph: ir ? workflowGraphJson(ir, revision!.revision) : null };
}

/**
 * Resolve a delete target by `definitionId` and/or `name` with receipt-first idempotent replay safety
 * (shared by Unit F's agent `workflow_definition` `delete` tool with `allowLocked: false` and person/MCP
 * `deleteSessionWorkflowDefinition` where `allowLocked` is unset so a person may delete locked package definitions).
 */
export async function resolveDeleteTarget(
    host: Pick<WorkflowHost, "store">,
    ownerSessionId: string,
    ref: { definitionId?: string | null; name?: string | null },
    operationId: string,
    options: { allowLocked?: boolean } = {},
): Promise<string> {
    const definitionId = typeof ref.definitionId === "string" && ref.definitionId.trim() ? ref.definitionId.trim() : null;
    const name = typeof ref.name === "string" && ref.name.trim() ? ref.name.trim() : null;
    if (!definitionId && !name) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "delete needs name or definition_id.");
    }
    const storedOp = await host.store.sessionDefinitions.readStoredOperation?.<SessionDeleteReceipt>(ownerSessionId, operationId);
    if (storedOp) {
        if (storedOp.kind !== "delete") {
            throw new WorkflowStoreError("OPERATION_CONFLICT", `Operation ${operationId} was used for a different request; use another operation id.`);
        }
        const matchesId = !definitionId || storedOp.receipt.definitionId === definitionId;
        const matchesName = !name || storedOp.receipt.name === name;
        if (!matchesId || !matchesName) {
            throw new WorkflowStoreError("OPERATION_CONFLICT", `Operation ${operationId} was used for a different request; use another operation id.`);
        }
        return storedOp.receipt.definitionId;
    }
    if (options.allowLocked === false && name && name.includes("/") && !definitionId) {
        const attached = await host.store.sessionDefinitions.readDefinitionByName?.(ownerSessionId, name);
        if (attached?.locked) {
            throw new WorkflowStoreError("DEFINITION_LOCKED",
                `${attached.name} comes from the package ${attached.packageName ?? "it was published in"} and is locked: a session can only delete its own definitions, not package definitions. Nothing was deleted.`,
                { definitionId: attached.definitionId, packageName: attached.packageName });
        }
        throw new WorkflowStoreError("DEFINITION_LOCKED",
            `${name} names a package Workflow Definition, which is locked: a session can only delete its own definitions, not package definitions. Nothing was deleted.`);
    }
    if (definitionId && name) {
        const existing = await host.store.sessionDefinitions.readDefinition(definitionId);
        if (existing && existing.ownerSessionId === ownerSessionId && existing.name !== name) {
            throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID",
                `definition_id ${definitionId} is ${existing.name}, not ${name}. Pass either definition_id or name, or matching values. Nothing was deleted.`);
        }
        return definitionId;
    }
    if (definitionId) return definitionId;
    const live = await host.store.sessionDefinitions.readDefinitionByName(ownerSessionId, name!);
    if (live) return live.definitionId;
    const all = await host.store.sessionDefinitions.listDefinitions(ownerSessionId, { includeDeleted: true });
    const deleted = all.filter(item => item.name === name && item.deletedAt !== null).at(-1) ?? null;
    if (deleted) return deleted.definitionId;
    throw new WorkflowStoreError("DEFINITION_NOT_FOUND", `This session has no Workflow Definition named ${name}.`);
}

/** Delete a definition (the session for its own definitions with `allowLocked: false`, or a person); refused while one of its Workflows is active (R6). */
export async function deleteSessionWorkflowDefinition(host: Pick<WorkflowHost, "store">, request: {
    ownerSessionId: string; definitionId?: string | null; name?: string | null; actor: SessionDefinitionActor; operationId: string; allowLocked?: boolean;
}): Promise<StoredSessionOperation<SessionDeleteReceipt>> {
    requireOperationId(request.operationId);
    await requireSessionDefinitionsWritable(host, request.ownerSessionId);
    const definitionId = await resolveDeleteTarget(
        host,
        request.ownerSessionId,
        { definitionId: request.definitionId ?? null, name: request.name ?? null },
        request.operationId,
        { allowLocked: request.allowLocked },
    );
    return host.store.sessionDefinitions.deleteDefinition({
        ownerSessionId: request.ownerSessionId,
        definitionId,
        actor: request.actor,
        operationId: request.operationId,
        requestSha256: sha256Hex(canonicalJson({ kind: "delete", definitionId })),
        ...(request.allowLocked !== undefined ? { allowLocked: request.allowLocked } : {}),
    });
}

// ─── Stage 2.3: package Workflow Definitions in a session ─────────────────────────────────────────

function requirePackages(host: Pick<WorkflowHost, "packageWorkflows">): PackageWorkflowSource {
    if (!host.packageWorkflows) {
        throw new WorkflowStoreError("PACKAGE_WORKFLOWS_UNAVAILABLE", "This server cannot read packages' Workflow Definitions. Nothing was changed.");
    }
    return host.packageWorkflows;
}

/** `<package>/<name>`, parsed, or the refusal that says how to name one (D7). */
export function requirePackageRef(ref: unknown): { packageName: string; name: string; ref: string } {
    const parsed = parseWorkflowPackageRef(ref);
    if (!parsed) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID",
            "A package's Workflow Definition is named <package>/<name>, such as release-tools/release-watch.");
    }
    return { ...parsed, ref: `${parsed.packageName}/${parsed.name}` };
}

/** The package definition `ref` as `viewer` sees it in the agent registry, or PACKAGE_WORKFLOW_NOT_FOUND. */
export async function findPackageWorkflow(host: Pick<WorkflowHost, "packageWorkflows">, ref: string, viewer: PackageViewer | null)
    : Promise<PackageWorkflowEntry> {
    const parsed = requirePackageRef(ref);
    const entry = await requirePackages(host).find(parsed, viewer);
    if (!entry) {
        throw new WorkflowStoreError("PACKAGE_WORKFLOW_NOT_FOUND", `No package you can use has a Workflow Definition ${parsed.ref}. Nothing was changed.`,
            { ref: parsed.ref });
    }
    return entry;
}

/**
 * Attach the package's active version of `ref` to the session (P2, P5, P6): its locked definition `ref`, a new revision when
 * that version is not already its newest. The YAML comes from the package's checked bytes and must compile on this host
 * (PACKAGE_WORKFLOW_UNSUPPORTED otherwise: the package was checked with every node type when it was published).
 * `workflowRef`: the session is the coordinating session made for it (P2). `version`: the exact package version (its package id
 * and content hash) the session was prepared from (stage 2 review S2SF-F3: its instructions describe that version); when the
 * active version is another one, or the package is gone, nothing is attached (PACKAGE_VERSION_CHANGED,
 * PACKAGE_WORKFLOW_NOT_FOUND).
 */
export async function attachSessionPackageWorkflow(host: WorkflowHost, request: {
    ownerSessionId: string;
    ref: string;
    viewer: PackageViewer | null;
    actor: SessionDefinitionActor;
    operationId: string;
    by: "session" | "person" | "system";
    workflowRef?: string | null;
    version?: { packageId: string; sha256: string } | null;
    /**
     * S2SF-F6 / L4: a person's or the session's "newer version" (Use it for the next Workflow, start with update): a definition
     * the session has already takes only the same package's strictly greater version (PACKAGE_NOT_NEWER otherwise); the same
     * version is no change.
     */
    newerOnly?: boolean;
}): Promise<StoredSessionOperation<SessionAttachReceipt>> {
    requireOperationId(request.operationId);
    await requireSessionDefinitionsWritable(host, request.ownerSessionId);
    const parsedRef = requirePackageRef(request.ref).ref;
    // Formal L2 (as G2 for a save): a retry of an attach that was stored is answered from its receipt, before the registry is
    // read again: its active version may have moved since (a republish), which would make the same call another request.
    const stored = await host.store.sessionDefinitions.readStoredOperation<SessionAttachReceipt>(request.ownerSessionId, request.operationId);
    if (stored) {
        const receipt = stored.receipt;
        if (stored.kind !== "attach" || receipt?.name !== parsedRef || (request.version
            && (receipt.package?.packageId !== request.version.packageId || receipt.package?.sha256 !== request.version.sha256))) {
            throw new WorkflowStoreError("OPERATION_CONFLICT", `Operation ${request.operationId} was used for a different request; use another operation id.`);
        }
        return { receipt, replayed: true };
    }
    const entry = await findPackageWorkflow(host, request.ref, request.viewer);
    if (request.version && (entry.packageId !== request.version.packageId || entry.sha256 !== request.version.sha256)) {
        throw new WorkflowStoreError("PACKAGE_VERSION_CHANGED", `${entry.ref} changed after this session was prepared: the package's active version is now `
            + `${entry.semver}, not the one its instructions describe. Nothing was attached; make the session again.`,
        { ref: entry.ref, semver: entry.semver });
    }
    const yaml = await requirePackages(host).readYaml(entry);
    const compiled = compileWorkflow(yaml);
    if (!compiled.valid || !compiled.ir) {
        const first = compiled.diagnostics.find(item => item.severity !== "warning");
        throw new WorkflowStoreError("PACKAGE_WORKFLOW_UNSUPPORTED", `This server cannot run ${entry.ref} ${entry.semver}`
            + `${first ? `: ${first.path}: ${first.message}` : ""}. Nothing was attached.`, { ref: entry.ref, semver: entry.semver });
    }
    return host.store.sessionDefinitions.attachPackage({
        ownerSessionId: request.ownerSessionId, name: entry.ref, yaml, compiled,
        package: { packageId: entry.packageId, packageName: entry.packageName, semver: entry.semver, sha256: entry.sha256, cardDigest: entry.workflow.cardDigest },
        card: entry.workflow.card as unknown as JsonValue, actor: request.actor, operationId: request.operationId,
        requestSha256: sha256Hex(canonicalJson({ kind: "attach", ref: entry.ref, packageId: entry.packageId, sha256: entry.sha256,
            workflowRef: request.workflowRef ?? null })),
        seenBySession: request.by === "session", ...(request.workflowRef ? { workflowRef: request.workflowRef } : {}),
        ...(request.newerOnly ? { newerOnly: true } : {}),
    });
}

/**
 * E2-7 / P5: a person's Make a copy. The locked definition's revision (default its newest) is saved as the session's own,
 * editable definition at revision 1, named as its YAML names it (metadata.name), with a note for the session (E2-4). A name the
 * session already has refuses it (DEFINITION_EXISTS), as any first save does.
 */
export async function copySessionPackageWorkflow(host: WorkflowHost, request: {
    ownerSessionId: string;
    definitionId?: string | null;
    name?: string | null;
    revision?: number | null;
    actor: SessionDefinitionActor;
    operationId: string;
    personWords?: string | null;
}): Promise<StoredSessionOperation<SessionSaveReceipt>> {
    requireOperationId(request.operationId);
    await requireSessionDefinitionsWritable(host, request.ownerSessionId);
    const reqDefId = typeof request.definitionId === "string" && request.definitionId.trim() ? request.definitionId.trim() : null;
    const reqName = typeof request.name === "string" && request.name.trim() ? request.name.trim() : null;
    if (!reqDefId && !reqName) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "copy needs name or definition_id.");
    }
    // S2RT-F10: a repeat of this copy is answered from its receipt, before the source's newest revision is chosen again (a
    // newer package version attached since would make the same request another one). The copy records its source (L1).
    const stored = await host.store.sessionDefinitions.readStoredOperation?.<SessionSaveReceipt>(request.ownerSessionId, request.operationId);
    if (stored) {
        const copy = stored.kind === "save" ? await host.store.sessionDefinitions.readDefinition(stored.receipt.definitionId) : null;
        const from = copy?.copiedFrom ?? null;
        const matchesId = !reqDefId || from?.definitionId === reqDefId;
        const matchesName = !reqName || from?.name === reqName;
        if (!from || !matchesId || !matchesName || (request.revision != null && request.revision !== from.revision)) {
            throw new WorkflowStoreError("OPERATION_CONFLICT", `Operation ${request.operationId} was used for a different request; use another operation id.`);
        }
        return { receipt: stored.receipt, replayed: true };
    }
    const definition = await definitionOf(host, request.ownerSessionId, { definitionId: reqDefId, name: reqName });
    if (!definition.locked) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `${definition.name} is this session's own definition; it is changed by saving it, not copied.`);
    }
    const revision = await host.store.sessionDefinitions.readRevision(definition.definitionId, request.revision ?? definition.currentRevision);
    if (!revision) throw new WorkflowStoreError("REVISION_NOT_FOUND", `${definition.name} has no revision ${request.revision ?? definition.currentRevision}.`);
    const compiled = compileWorkflow(revision.yaml);
    if (!compiled.name) throw new WorkflowStoreError("DEFINITION_INVALID", `${definition.name} has no metadata.name to name its copy.`);
    // L1: the copy records where it came from (source 'copy'): the locked definition, the revision and its package version.
    const copiedFrom: SessionCopiedFrom = { definitionId: definition.definitionId, name: definition.name, revision: revision.revision,
        package: revision.package ? { packageId: revision.package.packageId, packageName: revision.package.packageName, semver: revision.package.semver,
            sha256: revision.package.sha256 } : null };
    return saveSessionWorkflowDefinition(host, {
        ownerSessionId: request.ownerSessionId, name: compiled.name, yaml: revision.yaml, expected: null, actor: request.actor,
        operationId: request.operationId, by: "person", personWords: request.personWords ?? "A person", compiled, copiedFrom,
    });
}

/** What a session reads about a package definition: its card, as words and as fields, with the package version (P3, P4). */
export interface PackageWorkflowCardView {
    ref: string;
    packageName: string;
    semver: string;
    /** The attached definition's newest revision, when the session has it. */
    attached: { definitionId: string; revision: number; semver: string } | null;
    /** The registry's active version when it is not the attached one (P6), or null. */
    newerVersion: string | null;
    card: WorkflowCard;
    cardDigest: string;
    interface: WorkflowCardInterface | null;
    /** S2SF-F4: what the definition shows of its effects (its script and agent steps), or null when it could not be read. */
    facts: WorkflowEffectFacts | null;
    words: string;
}

/** S2SF-F4: a package definition's checked effect facts, or null when its source cannot read them (never refuses a read). */
export async function packageWorkflowFacts(source: PackageWorkflowSource | null | undefined, entry: PackageWorkflowEntry): Promise<WorkflowEffectFacts | null> {
    if (!source?.readFacts) return null;
    try {
        return await source.readFacts(entry);
    } catch {
        return null;
    }
}

/**
 * The card of `ref` for the session: of its attached revision when it has one (what Start runs), else of the package's active
 * version as `viewer` sees it.
 */
export async function readPackageWorkflowCard(host: WorkflowHost, ownerSessionId: string, ref: string, viewer: PackageViewer | null)
    : Promise<PackageWorkflowCardView> {
    const parsed = requirePackageRef(ref);
    const attached = await host.store.sessionDefinitions.readDefinitionByName(ownerSessionId, parsed.ref);
    const entry = host.packageWorkflows ? await host.packageWorkflows.find(parsed, viewer) : null;
    if (attached && attached.currentRevision >= 1) {
        const revision = await host.store.sessionDefinitions.readRevision(attached.definitionId, attached.currentRevision);
        const card = revision ? readWorkflowCard(revision.card) : null;
        if (revision && card && revision.package) {
            const ir = revision.valid
                ? await host.store.sessionDefinitions.readRevisionIr(attached.definitionId, revision.revision) : null;
            const face = ir ? workflowCardInterface(ir) : null;
            const facts = ir ? workflowEffectFacts(ir) : null;
            return {
                ref: parsed.ref, packageName: parsed.packageName, semver: revision.package.semver,
                attached: { definitionId: attached.definitionId, revision: revision.revision, semver: revision.package.semver },
                newerVersion: entry && packageVersionIsNewer(revision.package, entry) ? entry.semver : null,
                card, cardDigest: revision.package.cardDigest, interface: face, facts,
                words: workflowCardWords(parsed.ref, revision.package.semver, card, face, facts),
            };
        }
    }
    if (!entry) {
        requirePackages(host);
        throw new WorkflowStoreError("PACKAGE_WORKFLOW_NOT_FOUND", `No package you can use has a Workflow Definition ${parsed.ref}.`, { ref: parsed.ref });
    }
    const facts = await packageWorkflowFacts(host.packageWorkflows, entry);
    return {
        ref: parsed.ref, packageName: parsed.packageName, semver: entry.semver, attached: null, newerVersion: null, card: entry.workflow.card,
        cardDigest: entry.workflow.cardDigest, interface: entry.workflow.interface, facts, words: workflowCardWords(parsed.ref, entry.semver, entry.workflow.card,
            entry.workflow.interface, facts),
    };
}

/**
 * P6: each locked view's package update: the registry's active version when it is the same package's strictly greater
 * version than the newest revision's (S2SF-F6 / L4: not a rollback, not another package of the same name).
 */
export async function withPackageUpdates<T extends SessionDefinitionView>(host: Pick<WorkflowHost, "packageWorkflows">, views: T[], viewer: PackageViewer | null)
    : Promise<T[]> {
    if (!host.packageWorkflows || !views.some(view => view.locked && view.deletedAt === null)) return views;
    let entries: PackageWorkflowEntry[];
    try {
        entries = await host.packageWorkflows.list(viewer);
    } catch {
        return views;
    }
    return views.map(view => {
        if (!view.locked || view.deletedAt !== null) return view;
        const entry = entries.find(item => item.ref === view.name);
        const current = view.current?.package ?? null;
        return { ...view, packageUpdate: entry && current && packageVersionIsNewer(current, entry) ? { semver: entry.semver, sha256: entry.sha256 } : null };
    });
}

/** A locked definition refuses a save (E2-7); for the tool's save by name. */
export function refuseLockedSave(definition: SessionDefinitionRow): never {
    throw lockedRefusal(definition);
}
