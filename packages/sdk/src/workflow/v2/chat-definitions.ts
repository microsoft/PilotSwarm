/**
 * A definition belongs to the chat (Workflow Simplified stage 2.1; spec "definitions", "editing", "tools"; the
 * coordinator's readings Q1–Q10, F2–F4): the service the agent tool (workflow_definition), the spawn_workflow
 * compatibility path (D2) and a person's commands (management client) share.
 *
 * - save: revision N+1 of the chat's definition, guarded by the definition and the revision it was based on (E2-3, Q1).
 *   A not-valid revision is saved with its errors (E2-5). A person's save leaves a note the chat reads on its next turn;
 *   it does not wake the chat (E2-4).
 * - start: a new Workflow from a revision (Q10: default the newest valid one; Run again names the revision of the Workflow
 *   it repeats). The Workflow's own definition is that revision's YAML, pinned (R1); Start is refused for a chat that is
 *   not live, a definition that is deleted, or a revision that is not valid, under their locks (Q3).
 * - read and list: definitions, revisions, diagnostics, YAML and the Workflows started from each. A read by the chat
 *   records what it has seen (Q2).
 * - delete: a person's only (Q8), refused while one of its Workflows is active (R6).
 *
 * Stage 2.3 (P2–P6, E2-7; chat-packages.ts): a package's Workflow Definition is attached to a chat as its locked definition
 * `<package>/<name>` (attachChatPackageWorkflow); Start then works as for the chat's own. A newer package version is
 * attached for the next Workflow only (P6). A person's Make a copy saves the package YAML as the chat's own, editable
 * definition (copyChatPackageWorkflow). A2: a save, and a Start, of a definition whose agent state uses an agent that
 * brings definitions is refused.
 */
import { systemChildAgentUUID } from "../../agent-loader.js";
import { WORKFLOW_CHILD_BUDGET_MAX } from "../../child-budget.js";
import type { SessionOwnerInfo } from "../../types.js";
import type { WorkflowToolBinding } from "../tool-policy.js";
import { canonicalJson, isJsonObject, sha256Hex, type JsonObject, type JsonValue } from "./json.js";
import { WorkflowStoreError, type WorkflowActor, type WorkflowDefinitionReceipt } from "./store.js";
import { WORKFLOW_HUMAN_INPUT_DENIED, workflowHumanInputError } from "./input-policy.js";
import { parseWorkflowAgentModels, readStoredAgentModels, type WorkflowAgentModels } from "./agent-models.js";
import { compileWorkflowV2ForHost, createWorkflowV2, requireNoAgentBringsWorkflows, type WorkflowV2Host } from "./service.js";
import { requireWorkflowScripts } from "./scripts-gate.js";
import { WORKFLOW_V2_MILESTONE_IR_VERSION, type WorkflowCompileResult } from "./compiler.js";
import { workflowV2GraphJson } from "./tools.js";
import {
    chatSaveRequestSha256, lockedRefusal, type ChatAttachReceipt, type ChatDefinitionActor, type ChatDefinitionRow, type ChatDeleteReceipt, type ChatRevisionRow,
    type ChatRevisionSummary, type ChatSaveReceipt, type ChatWorkflowRow, type StoredChatOperation, type ChatCopiedFrom,
} from "./chat-definition-store.js";
import { packageVersionIsNewer, type PackageViewer, type PackageWorkflowEntry, type PackageWorkflowSource } from "./chat-packages.js";
import {
    parseWorkflowPackageRef, readWorkflowCard, workflowCardInterface, workflowCardWords, workflowEffectFacts, type WorkflowCard, type WorkflowCardInterface,
    type WorkflowEffectFacts,
} from "./package-card.js";

/**
 * Stage 2.4 (PR 235 2b893906): Start keeps spawn_agent's limits. A Workflow is a child of its chat, one level deeper,
 * and no session may be deeper than WORKFLOW_START_MAX_NESTING_LEVEL (spawn_agent's ordinary limit: 0 the root, 1 a
 * child, 2 a grandchild); a chat's running sub-agents and active Workflows share one budget of
 * WORKFLOW_START_MAX_RUNNING_CHILDREN.
 */
export const WORKFLOW_START_MAX_NESTING_LEVEL = 2;
export const WORKFLOW_START_MAX_RUNNING_CHILDREN = WORKFLOW_CHILD_BUDGET_MAX;

/**
 * Start's limits (above), before anything is made. The chat's nesting level is derived from its stored lineage for every
 * Start, a person's included (S2RT-F4); a level the caller gives (the chat's own tools know theirs) is used when deeper.
 * The budget is counted again, atomically, when the Workflow is claimed (S2RT-F3).
 */
export async function requireWorkflowStartLimits(host: Pick<WorkflowV2Host, "store">, ownerSessionId: string, given: number | null = null)
    : Promise<void> {
    const derived = await host.store.chat.nestingLevel(ownerSessionId);
    const nestingLevel = Math.max(derived, Number.isSafeInteger(given) ? given as number : 0);
    if (nestingLevel + 1 > WORKFLOW_START_MAX_NESTING_LEVEL) {
        throw new WorkflowStoreError("WORKFLOW_NESTING_LIMIT", `This chat is at nesting level ${nestingLevel} (max ${WORKFLOW_START_MAX_NESTING_LEVEL}), `
            + "and a Workflow it starts would be one level deeper than any session may be. Ask a chat nearer the top to start it. Nothing was started.",
        { nestingLevel, maxNestingLevel: WORKFLOW_START_MAX_NESTING_LEVEL });
    }
    const running = await host.store.chat.runningChildren(ownerSessionId);
    if (running >= WORKFLOW_START_MAX_RUNNING_CHILDREN) {
        throw new WorkflowStoreError("CHILD_LIMIT", `This chat already has ${running} running sub-agents and Workflows (max `
            + `${WORKFLOW_START_MAX_RUNNING_CHILDREN}). Wait for some to end before starting another. Nothing was started.`,
        { running, max: WORKFLOW_START_MAX_RUNNING_CHILDREN });
    }
}

/** A definition name: as metadata.name allows (1–128 characters: letters, digits, dot, dash, underscore). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ChatStartReceipt {
    operation: "start";
    definitionId: string;
    name: string;
    revision: number;
    workflowId: string;
    runId: string | null;
    replayed: boolean;
    /** OF-S2-7: the agent nodes' models chosen at start, by state id; absent when every agent node uses the chat's. */
    agentModels?: WorkflowAgentModels;
}

/**
 * OF-S2-7: Run again reuses the models the Workflow it repeats was started with, unless the request gives its own (an empty
 * map: none, every agent node uses the chat's). Null when that Workflow had none.
 */
async function runAgainAgentModels(host: Pick<WorkflowV2Host, "store">, workflowSessionId: string): Promise<WorkflowAgentModels | null> {
    const runs = await host.store.listRuns(workflowSessionId);
    const live = runs.find(run => run.mode === "live") ?? null;
    if (!live) return null;
    // A stored map that cannot be read refuses Run again in words; it is never dropped for the chat's models.
    const read = readStoredAgentModels(live.agentModels);
    if ("error" in read) throw new WorkflowStoreError("AGENT_MODELS_INVALID", `${read.error} Give agentModels (an empty map: the chat's models) to run it again.`);
    return read.models;
}

/** The models a start uses: the request's own when it names them (an empty map is none), else Run again's. */
export async function startAgentModelsOf(host: Pick<WorkflowV2Host, "store">, request: { agentModels?: unknown; runAgainOf?: string | null })
    : Promise<WorkflowAgentModels | null> {
    if (request.agentModels !== undefined && request.agentModels !== null) return parseWorkflowAgentModels(request.agentModels);
    return request.runAgainOf ? runAgainAgentModels(host, request.runAgainOf) : null;
}

export interface ChatDefinitionView {
    definitionId: string;
    name: string;
    currentRevision: number;
    source: string | null;
    /** L1: a person's copy of a package's definition: what it was copied from (source 'copy'). */
    copiedFrom: ChatCopiedFrom | null;
    /** Stage 2.3: a package's definition, locked (E2-7), and its package. */
    locked: boolean;
    packageName: string | null;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    /** The newest revision's facts (null before the first save). */
    current: ChatRevisionSummary | null;
    /** The newest valid revision (Start's default), or null. */
    newestValidRevision: number | null;
    revisions: ChatRevisionSummary[];
    workflows: ChatWorkflowRow[];
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

function requireName(name: unknown): string {
    if (typeof name !== "string" || !NAME.test(name)) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID",
            "name must be 1-128 characters: letters, digits, dot, dash or underscore, starting with a letter or digit (the YAML's metadata.name).");
    }
    return name;
}

/** The definition named by id or by name, the chat's own and live, or the refusal that says why not. */
export async function definitionOf(host: Pick<WorkflowV2Host, "store">, ownerSessionId: string, ref: { definitionId?: string | null; name?: string | null })
    : Promise<ChatDefinitionRow> {
    const found = ref.definitionId
        ? await host.store.chat.readDefinition(ref.definitionId)
        : ref.name ? await host.store.chat.readDefinitionByName(ownerSessionId, ref.name) : null;
    if (!found || found.ownerSessionId !== ownerSessionId) {
        throw new WorkflowStoreError("DEFINITION_NOT_FOUND", ref.name ? `This chat has no Workflow Definition named ${ref.name}.`
            : `This chat has no Workflow Definition ${ref.definitionId ?? ""}.`);
    }
    if (found.deletedAt !== null) throw new WorkflowStoreError("DEFINITION_DELETED", `${found.name} was deleted.`, { definitionId: found.definitionId });
    return found;
}

/**
 * Save revision N+1 (E2-1..E2-6). `expected`: the definition and revision the save was based on (Q1), or null for the
 * first save of `name`. The YAML's metadata.name, when it has one, must be `name`. A host whose workers run no scripts
 * refuses a definition with a script node (scripts-gate.ts). `by`: "chat" (the chat's own tool: it has seen what it saved)
 * or "person" (a note for the chat, `personWords` naming them).
 */
/**
 * Review PRS-002: a chat's Workflow Definitions change only for a chat that is not inside a Workflow. A session that runs an
 * agent step (or is a descendant of one) takes no human input (input-policy.ts), and a definition change would queue a note
 * into its next prompt: save, start, test, copy, a package's attach or update, and delete are refused for it
 * (WORKFLOW_HUMAN_INPUT_DENIED, 403), by its stored lineage, before anything is read or written; reads stay allowed.
 * The one guard for every caller: a person's management or HTTP call, and the chat's own tool (which A1 refuses first).
 */
export async function requireChatDefinitionsWritable(host: Pick<WorkflowV2Host, "store">, ownerSessionId: string): Promise<void> {
    const lineage = await host.store.readWorkflowLineage(ownerSessionId);
    if (!lineage?.agentRoot) return;
    const denied = workflowHumanInputError(ownerSessionId, "definitions", lineage);
    throw new WorkflowStoreError(WORKFLOW_HUMAN_INPUT_DENIED, `${denied.message} Nothing was changed.`, denied.details as JsonValue);
}

export async function saveChatWorkflowDefinition(host: WorkflowV2Host, request: {
    ownerSessionId: string;
    name: string;
    yaml: string;
    expected: { definitionId: string; revision: number } | null;
    actor: ChatDefinitionActor;
    operationId: string;
    by: "chat" | "person";
    personWords?: string | null;
    /** The YAML as a caller already compiled it with this host, to run the scripts gate before anything else (d52e5ed2). */
    compiled?: WorkflowCompileResult;
    /** L1: this first save is a Make a copy of `copiedFrom`. */
    copiedFrom?: ChatCopiedFrom | null;
}): Promise<StoredChatOperation<ChatSaveReceipt>> {
    requireOperationId(request.operationId);
    await requireChatDefinitionsWritable(host, request.ownerSessionId);
    // DS-1 (TEST check at 406550a9): a save aimed at a package's locked definition (by its id, or by its <package>/<name>)
    // is refused as locked, in words that say Make a copy, before its name or YAML is checked. The store refuses it again
    // under its lock.
    const target = typeof request.expected?.definitionId === "string" && request.expected.definitionId
        ? await host.store.chat.readDefinition?.(request.expected.definitionId)
        : typeof request.name === "string" && request.name.includes("/") ? await host.store.chat.readDefinitionByName?.(request.ownerSessionId, request.name.trim())
            : null;
    if (target && target.ownerSessionId === request.ownerSessionId && target.deletedAt === null && target.locked) throw lockedRefusal(target);
    const name = requireName(request.name);
    if (typeof request.yaml !== "string" || !request.yaml.trim()) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "yaml is required.");
    if (request.expected !== null && (typeof request.expected?.definitionId !== "string" || !Number.isSafeInteger(request.expected?.revision)
        || request.expected.revision < 1)) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "The revision guard needs the definition id and the revision the save was based on.");
    }
    const compiled = request.compiled ?? compileWorkflowV2ForHost(host, request.yaml);
    if (compiled.name && compiled.name !== name) {
        throw new WorkflowStoreError("WORKFLOW_NAME_MISMATCH", `The YAML's metadata.name is ${compiled.name}, not ${name}. Nothing was saved.`);
    }
    requireWorkflowScripts(host, compiled.ir, "save");
    // A2 (stage 2.3): an agent state may not use an agent that brings definitions.
    await requireNoAgentBringsWorkflows(host, compiled.ir, request.ownerSessionId, "Nothing was saved.");
    return host.store.chat.save({
        ownerSessionId: request.ownerSessionId, name, yaml: request.yaml, compiled, expected: request.expected, actor: request.actor,
        operationId: request.operationId, requestSha256: chatSaveRequestSha256({ name, yamlSha256: compiled.yamlSha256, expected: request.expected }),
        seenByChat: request.by === "chat", ...(request.by === "person" ? { noteBy: request.personWords ?? "A person" } : {}),
        ...(request.copiedFrom ? { copiedFrom: request.copiedFrom } : {}),
    });
}

/**
 * Start a new Workflow from a revision of a chat's definition (Q10). `revision` absent: the newest valid one; `runAgainOf`:
 * the revision a Workflow of this definition pinned (Run again). The Workflow's id follows from the operation id, so a
 * repeated call is answered from its receipt. The scripts gate (stage 2.0, one switch) decides once the revision is known,
 * before anything else: the chat's tool binding (`binding`, a value or the function that captures it) is captured only
 * after it, so a host that runs no scripts refuses a script node without asking the chat's session for anything.
 */
/**
 * S2RT-F5: the definition and revision a Start operation pinned when it first ran: from its Workflow's stored definition
 * (the pin written with it), else from its claim (the creation marker records the pin, for a Start interrupted between its
 * claim and its admission); null when the operation has not run.
 */
export async function storedStartPin(host: Pick<WorkflowV2Host, "store" | "catalog">, workflowSessionId: string)
    : Promise<{ definitionId: string; revision: number } | null> {
    const row = await host.store.readDefinition(workflowSessionId);
    if (row && typeof row.chatDefinitionId === "string" && Number.isSafeInteger(row.chatRevision)) {
        return { definitionId: row.chatDefinitionId, revision: row.chatRevision as number };
    }
    const creation = await host.catalog.getSessionCreationConfig?.(workflowSessionId) ?? null;
    const marker = isJsonObject(creation) && isJsonObject((creation as JsonObject).workflowV2) ? (creation as JsonObject).workflowV2 as JsonObject : null;
    const pin = marker && isJsonObject(marker.chatPin) ? marker.chatPin as JsonObject : null;
    return pin && typeof pin.definitionId === "string" && Number.isSafeInteger(pin.revision)
        ? { definitionId: pin.definitionId, revision: Number(pin.revision) } : null;
}

/** A Start operation that already ran: its pinned revision again (refused when the request names another), then its receipt. */
async function replayChatStart(host: WorkflowV2Host, request: Parameters<typeof startChatWorkflowDefinition>[1], workflowSessionId: string,
    prior: { definitionId: string; revision: number }): Promise<ChatStartReceipt> {
    const pinned = await host.store.chat.readDefinition(prior.definitionId);
    const conflict = (what: string) => new WorkflowStoreError("OPERATION_CONFLICT", `Operation ${request.operationId} started ${pinned?.name ?? "a definition"} `
        + `revision ${prior.revision}, not ${what}; use another operation id.`, { definitionId: prior.definitionId, revision: prior.revision });
    if (!pinned || pinned.ownerSessionId !== request.ownerSessionId) {
        throw new WorkflowStoreError("WORKFLOW_EXISTS", `Workflow ${workflowSessionId} was created by a different request; use another operation id.`);
    }
    if (request.definition.definitionId && request.definition.definitionId !== prior.definitionId) throw conflict(`definition ${request.definition.definitionId}`);
    if (!request.definition.definitionId && request.definition.name && request.definition.name !== pinned.name) throw conflict(request.definition.name);
    if (Number.isSafeInteger(request.revision) && request.revision !== prior.revision) throw conflict(`revision ${request.revision}`);
    if (request.runAgainOf) {
        const earlier = (await host.store.chat.listWorkflows({ definitionId: prior.definitionId })).find(item => item.workflowSessionId === request.runAgainOf);
        if (!earlier || earlier.revision !== prior.revision) throw conflict(`a run again of ${request.runAgainOf}`);
    }
    const saved = await host.store.chat.readRevision(prior.definitionId, prior.revision);
    if (!saved) throw new WorkflowStoreError("REVISION_NOT_FOUND", `${pinned.name} has no revision ${prior.revision}.`);
    const binding = typeof request.binding === "function" ? await request.binding() : request.binding ?? null;
    const agentModels = await startAgentModelsOf(host, request);
    const stored = await createWorkflowV2(host, {
        workflowSessionId, parentSessionId: request.ownerSessionId, ...(request.owner ? { owner: request.owner } : {}), yaml: saved.yaml,
        actor: request.actor, operationId: `start:${request.operationId}`, publish: true,
        start: { inputs: request.inputs, ...(request.vars ? { vars: request.vars } : {}), ...(agentModels ? { agentModels } : {}) },
        notifyParent: request.notifyParent !== false, ...(binding ? { binding } : {}),
        chatPin: { ownerSessionId: request.ownerSessionId, definitionId: prior.definitionId, revision: prior.revision },
    });
    return { operation: "start", definitionId: prior.definitionId, name: pinned.name, revision: prior.revision, workflowId: stored.receipt.workflowSessionId,
        runId: stored.receipt.run?.runId ?? null, replayed: stored.replayed, ...(agentModels ? { agentModels } : {}) };
}

export async function startChatWorkflowDefinition(host: WorkflowV2Host, request: {
    ownerSessionId: string;
    definition: { definitionId?: string | null; name?: string | null };
    revision?: number | null;
    runAgainOf?: string | null;
    inputs: JsonValue;
    vars?: { [key: string]: JsonValue } | null;
    notifyParent?: boolean;
    actor: WorkflowActor;
    operationId: string;
    owner?: SessionOwnerInfo | null;
    binding?: WorkflowToolBinding | null | (() => Promise<WorkflowToolBinding | null>);
    /** Stage 2.4: the chat's nesting level, when the caller knows it (the chat's own tools do); the depth limit needs it. */
    nestingLevel?: number | null;
    /**
     * OF-S2-7: agent node models chosen at start, by state id (agent-models.ts); checked against the revision started and the
     * owning chat's catalog. Absent with runAgainOf: the models the repeated Workflow was started with.
     */
    /** As given (parsed by the start): an explicit empty map clears Run again's choices (OF7-R4). */
    agentModels?: unknown;
}): Promise<ChatStartReceipt> {
    requireOperationId(request.operationId);
    await requireChatDefinitionsWritable(host, request.ownerSessionId);
    const workflowSessionId = systemChildAgentUUID(request.ownerSessionId, `workflow:start:${request.operationId}`);
    // S2RT-F5: a Start is receipt-first. When this operation already made its Workflow (or claimed it and was interrupted
    // before admitting it), it continues with the definition and revision it pinned then, never with a default chosen again
    // (a later save would otherwise select another revision); a request that names another one is refused.
    const prior = await storedStartPin(host, workflowSessionId);
    if (prior) return replayChatStart(host, request, workflowSessionId, prior);
    const definition = await definitionOf(host, request.ownerSessionId, request.definition);
    let revision: number | null = request.revision ?? null;
    if (request.runAgainOf) {
        const workflows = await host.store.chat.listWorkflows({ definitionId: definition.definitionId });
        const earlier = workflows.find(item => item.workflowSessionId === request.runAgainOf) ?? null;
        if (!earlier) throw new WorkflowStoreError("WORKFLOW_NOT_FOUND", `Workflow ${request.runAgainOf} was not started from ${definition.name}.`);
        revision = earlier.revision;
    }
    if (revision === null) {
        revision = await host.store.chat.newestValidRevision(definition.definitionId);
        if (revision === null) {
            throw new WorkflowStoreError("DEFINITION_INVALID", `${definition.name} has no valid revision yet, so it cannot start. Save a fixed revision first.`);
        }
    }
    if (!Number.isSafeInteger(revision) || revision < 1) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "revision must be a revision number.");
    const saved = await host.store.chat.readRevision(definition.definitionId, revision);
    if (!saved) throw new WorkflowStoreError("REVISION_NOT_FOUND", `${definition.name} has no revision ${revision}.`);
    if (!saved.valid) {
        throw new WorkflowStoreError("DEFINITION_INVALID", `Revision ${revision} of ${definition.name} is not valid, so it cannot start. Save a fixed revision first.`);
    }
    // Owner 2026-11-09T06:30Z: a Start compiles the revision's YAML again. One this build no longer compiles (an agent state's
    // `chat:`, now `session:`) is refused with its first error, so the one save it needs is plain.
    const again = compileWorkflowV2ForHost(host, saved.yaml);
    if (!again.valid) {
        const first = again.diagnostics.find(item => item.severity !== "warning");
        throw new WorkflowStoreError("DEFINITION_INVALID", `Revision ${revision} of ${definition.name} does not compile in this version`
            + `${first ? ` (${first.path}): ${first.message}` : "."} Save it again with that change. Nothing was started.`, { revision });
    }
    if (host.scripts === false) {
        requireWorkflowScripts(host, await host.store.chat.readRevisionIr(definition.definitionId, revision, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION }), "start");
    }
    // Stage 2.4: spawn_agent's depth limit and its shared budget of running children, after the scripts gate. A repeated
    // start (the same operation) was answered from its receipt above, so a retry is never refused by the Workflow it made.
    await requireWorkflowStartLimits(host, request.ownerSessionId, request.nestingLevel ?? null);
    const binding = typeof request.binding === "function" ? await request.binding() : request.binding ?? null;
    // OF-S2-7: checked against this revision and the owning chat's catalog by createWorkflowV2, before anything is written.
    const agentModels = await startAgentModelsOf(host, request);
    const stored = await createWorkflowV2(host, {
        workflowSessionId, parentSessionId: request.ownerSessionId, ...(request.owner ? { owner: request.owner } : {}), yaml: saved.yaml,
        actor: request.actor, operationId: `start:${request.operationId}`, publish: true,
        start: { inputs: request.inputs, ...(request.vars ? { vars: request.vars } : {}), ...(agentModels ? { agentModels } : {}) },
        notifyParent: request.notifyParent !== false, ...(binding ? { binding } : {}),
        chatPin: { ownerSessionId: request.ownerSessionId, definitionId: definition.definitionId, revision },
        // S2RT-F3: the budget again, under the chat's exclusive lock, in the claim's transaction.
        childBudget: { max: WORKFLOW_START_MAX_RUNNING_CHILDREN },
    });
    const receipt: WorkflowDefinitionReceipt = stored.receipt;
    return { operation: "start", definitionId: definition.definitionId, name: definition.name, revision, workflowId: receipt.workflowSessionId,
        runId: receipt.run?.runId ?? null, replayed: stored.replayed, ...(agentModels ? { agentModels } : {}) };
}

/** One definition as the tool, the Web API and the screens read it. */
async function viewOf(host: Pick<WorkflowV2Host, "store">, definition: ChatDefinitionRow): Promise<ChatDefinitionView> {
    const [listed, workflows, newestValidRevision, tests] = await Promise.all([
        host.store.chat.listRevisions(definition.definitionId),
        host.store.chat.listWorkflows({ definitionId: definition.definitionId }),
        host.store.chat.newestValidRevision(definition.definitionId),
        host.store.chat.listTests(definition.ownerSessionId, definition.definitionId),
    ]);
    // Stage 2.2: each revision's newest agent test (tests are listed newest first), only when one ran.
    const revisions = listed.map(item => {
        const test = tests.find(row => row.revision === item.revision);
        return test ? { ...item, lastTest: { testId: test.testId, verdict: test.verdict, at: test.endedAt ?? test.startedAt } } : item;
    });
    return { ...definition, current: revisions.find(item => item.revision === definition.currentRevision) ?? null, newestValidRevision, revisions, workflows };
}

/** The chat's definitions (deleted ones only when asked). `forChat`: the chat read them, so it has seen each newest revision. */
export async function listChatWorkflowDefinitions(host: Pick<WorkflowV2Host, "store">, ownerSessionId: string,
    options: { forChat?: boolean; includeDeleted?: boolean } = {}): Promise<ChatDefinitionView[]> {
    const definitions = await host.store.chat.listDefinitions(ownerSessionId, { includeDeleted: options.includeDeleted === true });
    const views = await Promise.all(definitions.map(definition => viewOf(host, definition)));
    if (options.forChat) await host.store.chat.markSeen(ownerSessionId, views.filter(view => view.deletedAt === null)
        .map(view => ({ definitionId: view.definitionId, revision: view.currentRevision })));
    return views;
}

/**
 * One definition (by id, or the chat's live one of that name) with a revision's YAML and diagnostics (default the newest).
 * A deleted definition is read by its id (its Workflows keep their copies). `forChat`: the chat has seen its newest revision.
 * `graph` (the screens' read, stage 2.1b): the revision's graph as a Workflow's view draws it (workflowV2GraphJson), for a
 * valid revision; null for one with errors.
 */
export async function readChatWorkflowDefinition(host: Pick<WorkflowV2Host, "store" | "requests">, ownerSessionId: string,
    ref: { definitionId?: string | null; name?: string | null }, options: { revision?: number | null; forChat?: boolean; graph?: boolean } = {})
    : Promise<ChatDefinitionView & { revision: ChatRevisionRow | null; graph?: { [key: string]: JsonValue } | null }> {
    const definition = ref.definitionId ? await host.store.chat.readDefinition(ref.definitionId)
        : ref.name ? await host.store.chat.readDefinitionByName(ownerSessionId, ref.name) : null;
    if (!definition || definition.ownerSessionId !== ownerSessionId) {
        throw new WorkflowStoreError("DEFINITION_NOT_FOUND", ref.name ? `This chat has no Workflow Definition named ${ref.name}.` : "This chat has no such Workflow Definition.");
    }
    const view = await viewOf(host, definition);
    const number = options.revision ?? definition.currentRevision;
    const revision = number >= 1 ? await host.store.chat.readRevision(definition.definitionId, number) : null;
    if (options.revision != null && !revision) throw new WorkflowStoreError("REVISION_NOT_FOUND", `${definition.name} has no revision ${options.revision}.`);
    if (options.forChat && definition.deletedAt === null) {
        await host.store.chat.markSeen(ownerSessionId, [{ definitionId: definition.definitionId, revision: definition.currentRevision }]);
    }
    if (!options.graph) return { ...view, revision };
    // Owner 2026-11-09T07:03Z: the graph shows what a Start runs. A Start compiles the revision's YAML again, so a revision
    // saved before an agent session's default changed shows it as a Start runs it. A YAML this build no longer compiles
    // (one with `chat:`, now `session:`) shows the graph stored with it; its Start is refused in words.
    const again = revision?.valid && typeof revision.yaml === "string" ? compileWorkflowV2ForHost(host, revision.yaml) : null;
    const ir = again?.valid && again.ir ? again.ir : revision?.valid && revision.irSha256
        ? await host.store.chat.readRevisionIr(definition.definitionId, revision.revision, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION }) : null;
    return { ...view, revision, graph: ir ? workflowV2GraphJson(ir, revision!.revision) : null };
}

/** A person deletes a definition (Q8); refused while one of its Workflows is active (R6). */
export async function deleteChatWorkflowDefinition(host: Pick<WorkflowV2Host, "store">, request: {
    ownerSessionId: string; definitionId: string; actor: ChatDefinitionActor; operationId: string;
}): Promise<StoredChatOperation<ChatDeleteReceipt>> {
    requireOperationId(request.operationId);
    await requireChatDefinitionsWritable(host, request.ownerSessionId);
    return host.store.chat.deleteDefinition({ ...request, requestSha256: sha256Hex(canonicalJson({ kind: "delete", definitionId: request.definitionId })) });
}

/**
 * R4: a chat cannot complete while one of its Workflows is active. The refusal names them (WORKFLOW_ACTIVE, 409); null
 * when the chat may complete. Its cancel, failure and deletion end its Workflows instead (migration 0107's trigger).
 */
export async function chatCompletionRefusal(host: Pick<WorkflowV2Host, "store">, ownerSessionId: string): Promise<WorkflowStoreError | null> {
    const active = await host.store.chat.activeWorkflowsOfChat(ownerSessionId);
    if (!active.length) return null;
    const names = active.slice(0, 3).map(item => (item.title ?? item.workflowSessionId).replace(/^Workflow: /, ""));
    return new WorkflowStoreError("WORKFLOW_ACTIVE",
        `This chat cannot complete while ${active.length === 1 ? "its Workflow" : `${active.length} of its Workflows`} ${names.join(", ")}`
        + `${active.length > 3 ? ` and ${active.length - 3} more` : ""} ${active.length === 1 ? "is" : "are"} still running. Stop ${active.length === 1 ? "it" : "them"} first, `
        + "or cancel the chat, which cancels them.", { workflowSessionIds: active.map(item => item.workflowSessionId) });
}

// ─── Stage 2.3: package Workflow Definitions in a chat ─────────────────────────────────────────

function requirePackages(host: Pick<WorkflowV2Host, "packageWorkflows">): PackageWorkflowSource {
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
export async function findPackageWorkflow(host: Pick<WorkflowV2Host, "packageWorkflows">, ref: string, viewer: PackageViewer | null)
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
 * Attach the package's active version of `ref` to the chat (P2, P5, P6): its locked definition `ref`, a new revision when
 * that version is not already its newest. The YAML comes from the package's checked bytes and must compile on this host
 * (PACKAGE_WORKFLOW_UNSUPPORTED otherwise: the package was checked with every node type when it was published).
 * `workflowRef`: the chat is the coordinating chat made for it (P2). `version`: the exact package version (its package id
 * and content hash) the chat was prepared from (stage 2 review S2SF-F3: its instructions describe that version); when the
 * active version is another one, or the package is gone, nothing is attached (PACKAGE_VERSION_CHANGED,
 * PACKAGE_WORKFLOW_NOT_FOUND).
 */
export async function attachChatPackageWorkflow(host: WorkflowV2Host, request: {
    ownerSessionId: string;
    ref: string;
    viewer: PackageViewer | null;
    actor: ChatDefinitionActor;
    operationId: string;
    by: "chat" | "person" | "system";
    workflowRef?: string | null;
    version?: { packageId: string; sha256: string } | null;
    /**
     * S2SF-F6 / L4: a person's or the chat's "newer version" (Use it for the next Workflow, start with update): a definition
     * the chat has already takes only the same package's strictly greater version (PACKAGE_NOT_NEWER otherwise); the same
     * version is no change.
     */
    newerOnly?: boolean;
}): Promise<StoredChatOperation<ChatAttachReceipt>> {
    requireOperationId(request.operationId);
    await requireChatDefinitionsWritable(host, request.ownerSessionId);
    const parsedRef = requirePackageRef(request.ref).ref;
    // Formal L2 (as G2 for a save): a retry of an attach that was stored is answered from its receipt, before the registry is
    // read again: its active version may have moved since (a republish), which would make the same call another request.
    const stored = await host.store.chat.readStoredOperation<ChatAttachReceipt>(request.ownerSessionId, request.operationId);
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
        throw new WorkflowStoreError("PACKAGE_VERSION_CHANGED", `${entry.ref} changed after this chat was prepared: the package's active version is now `
            + `${entry.semver}, not the one its instructions describe. Nothing was attached; make the chat again.`,
        { ref: entry.ref, semver: entry.semver });
    }
    const yaml = await requirePackages(host).readYaml(entry);
    const compiled = compileWorkflowV2ForHost(host, yaml);
    if (!compiled.valid || !compiled.ir) {
        const first = compiled.diagnostics.find(item => item.severity !== "warning");
        throw new WorkflowStoreError("PACKAGE_WORKFLOW_UNSUPPORTED", `This server cannot run ${entry.ref} ${entry.semver}`
            + `${first ? `: ${first.path}: ${first.message}` : ""}. Nothing was attached.`, { ref: entry.ref, semver: entry.semver });
    }
    return host.store.chat.attachPackage({
        ownerSessionId: request.ownerSessionId, name: entry.ref, yaml, compiled,
        package: { packageId: entry.packageId, packageName: entry.packageName, semver: entry.semver, sha256: entry.sha256, cardDigest: entry.workflow.cardDigest },
        card: entry.workflow.card as unknown as JsonValue, actor: request.actor, operationId: request.operationId,
        requestSha256: sha256Hex(canonicalJson({ kind: "attach", ref: entry.ref, packageId: entry.packageId, sha256: entry.sha256,
            workflowRef: request.workflowRef ?? null })),
        seenByChat: request.by === "chat", ...(request.workflowRef ? { workflowRef: request.workflowRef } : {}),
        ...(request.newerOnly ? { newerOnly: true } : {}),
    });
}

/**
 * E2-7 / P5: a person's Make a copy. The locked definition's revision (default its newest) is saved as the chat's own,
 * editable definition at revision 1, named as its YAML names it (metadata.name), with a note for the chat (E2-4). A name the
 * chat already has refuses it (DEFINITION_EXISTS), as any first save does.
 */
export async function copyChatPackageWorkflow(host: WorkflowV2Host, request: {
    ownerSessionId: string;
    definitionId: string;
    revision?: number | null;
    actor: ChatDefinitionActor;
    operationId: string;
    personWords?: string | null;
}): Promise<StoredChatOperation<ChatSaveReceipt>> {
    requireOperationId(request.operationId);
    await requireChatDefinitionsWritable(host, request.ownerSessionId);
    // S2RT-F10: a repeat of this copy is answered from its receipt, before the source's newest revision is chosen again (a
    // newer package version attached since would make the same request another one). The copy records its source (L1).
    const stored = await host.store.chat.readStoredOperation?.<ChatSaveReceipt>(request.ownerSessionId, request.operationId);
    if (stored) {
        const copy = stored.kind === "save" ? await host.store.chat.readDefinition(stored.receipt.definitionId) : null;
        const from = copy?.copiedFrom ?? null;
        if (!from || from.definitionId !== request.definitionId || (request.revision != null && request.revision !== from.revision)) {
            throw new WorkflowStoreError("OPERATION_CONFLICT", `Operation ${request.operationId} was used for a different request; use another operation id.`);
        }
        return { receipt: stored.receipt, replayed: true };
    }
    const definition = await definitionOf(host, request.ownerSessionId, { definitionId: request.definitionId });
    if (!definition.locked) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `${definition.name} is this chat's own definition; it is changed by saving it, not copied.`);
    }
    const revision = await host.store.chat.readRevision(definition.definitionId, request.revision ?? definition.currentRevision);
    if (!revision) throw new WorkflowStoreError("REVISION_NOT_FOUND", `${definition.name} has no revision ${request.revision ?? definition.currentRevision}.`);
    const compiled = compileWorkflowV2ForHost(host, revision.yaml);
    if (!compiled.name) throw new WorkflowStoreError("DEFINITION_INVALID", `${definition.name} has no metadata.name to name its copy.`);
    // L1: the copy records where it came from (source 'copy'): the locked definition, the revision and its package version.
    const copiedFrom: ChatCopiedFrom = { definitionId: definition.definitionId, name: definition.name, revision: revision.revision,
        package: revision.package ? { packageId: revision.package.packageId, packageName: revision.package.packageName, semver: revision.package.semver,
            sha256: revision.package.sha256 } : null };
    return saveChatWorkflowDefinition(host, {
        ownerSessionId: request.ownerSessionId, name: compiled.name, yaml: revision.yaml, expected: null, actor: request.actor,
        operationId: request.operationId, by: "person", personWords: request.personWords ?? "A person", compiled, copiedFrom,
    });
}

/** What a chat reads about a package definition: its card, as words and as fields, with the package version (P3, P4). */
export interface PackageWorkflowCardView {
    ref: string;
    packageName: string;
    semver: string;
    /** The attached definition's newest revision, when the chat has it. */
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
 * The card of `ref` for the chat: of its attached revision when it has one (what Start runs), else of the package's active
 * version as `viewer` sees it.
 */
export async function readPackageWorkflowCard(host: WorkflowV2Host, ownerSessionId: string, ref: string, viewer: PackageViewer | null)
    : Promise<PackageWorkflowCardView> {
    const parsed = requirePackageRef(ref);
    const attached = await host.store.chat.readDefinitionByName(ownerSessionId, parsed.ref);
    const entry = host.packageWorkflows ? await host.packageWorkflows.find(parsed, viewer) : null;
    if (attached && attached.currentRevision >= 1) {
        const revision = await host.store.chat.readRevision(attached.definitionId, attached.currentRevision);
        const card = revision ? readWorkflowCard(revision.card) : null;
        if (revision && card && revision.package) {
            const ir = revision.valid
                ? await host.store.chat.readRevisionIr(attached.definitionId, revision.revision, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION }) : null;
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
export async function withPackageUpdates<T extends ChatDefinitionView>(host: Pick<WorkflowV2Host, "packageWorkflows">, views: T[], viewer: PackageViewer | null)
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
export function refuseLockedSave(definition: ChatDefinitionRow): never {
    throw lockedRefusal(definition);
}
