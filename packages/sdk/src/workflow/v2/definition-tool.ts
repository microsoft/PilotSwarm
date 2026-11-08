/**
 * The chat's Workflow Definition tool (Workflow Simplified stage 2.1; spec "tools"): workflow_definition, with the
 * operations save, start, read and list. It replaces spawn_workflow for changing and starting definitions: a change is a
 * new revision of the same definition, and Start makes a Workflow from a revision. read_workflow and update_workflow stay
 * for one Workflow's run (read, pause, resume, stop, cancel, set_vars). Deleting a definition is a person's (Q8).
 *
 * spawn_workflow stays one release (D2), mapped to save then start (spawnWorkflowCompatFromTool): its save is guarded by
 * the newest revision the chat has seen of that definition (Q2), and its start pins exactly the revision it saved (F4).
 *
 * Stage 2.3 (P3–P6, D7): a package's definition is named `<package>/<name>`. The chat may start the ones its agent names
 * (its workflows list; a bare name is its own package's), the one its coordinating chat was made for, and any already
 * attached to it: Start attaches the package's version the first time (and, with update, a newer one), then starts it.
 * card reads a definition's interface card. A package's definition is locked: save refuses it (DEFINITION_LOCKED).
 */
import type { SessionOwnerInfo } from "../../types.js";
import type { WorkflowToolBinding } from "../tool-policy.js";
import type { JsonValue } from "./json.js";
import { WorkflowStoreError, type WorkflowActor } from "./store.js";
import { compileWorkflowV2ForHost, type WorkflowV2Host } from "./service.js";
import { requireWorkflowScripts } from "./scripts-gate.js";
import {
    listChatWorkflowDefinitions, readChatWorkflowDefinition, saveChatWorkflowDefinition, startChatWorkflowDefinition, type ChatDefinitionView,
} from "./chat-definitions.js";
import { workflowToolErrorPayload } from "./tools.js";
import { chatTestBench, requireTestHost, startChatWorkflowTest, waitChatWorkflowTest } from "./chat-test.js";
import { parseTestFixtures } from "./test-mode.js";
import type { ChatRevisionRow, ChatSaveReceipt } from "./chat-definition-store.js";
import {
    attachChatPackageWorkflow, readPackageWorkflowCard, refuseLockedSave, requirePackageRef, withPackageUpdates,
} from "./chat-definitions.js";
import type { PackageViewer } from "./chat-packages.js";
import { parseWorkflowPackageRef } from "./package-card.js";
import { parseWorkflowAgentModels, requireAgentModelsForRevision, workflowChosenModelsWords as chosenModelsWords } from "./agent-models.js";

export const WORKFLOW_DEFINITION_TOOL = "workflow_definition";

/**
 * Stage 2.5: the tool's declaration where its host can (`tests`, a workflow request turn: chat-test.ts requires
 * host.requests) or cannot run a Workflow test. Without tests the operation test, its fixtures and test_id are not
 * declared, so the model is never offered an operation that always refuses; a call of it is still refused
 * (WORKFLOW_TEST_UNAVAILABLE).
 */
export function workflowDefinitionToolSpec(options: { tests?: boolean } = {}) {
    const tests = options.tests !== false;
    return {
        description:
            "Your Workflow Definitions: each is named, belongs to this chat, and has revisions 1, 2, 3 (each save is a new revision; a "
            + "Workflow runs the revision it started with). Operations: "
            + "list (your definitions, each with its definition_id and current revision); "
            + "read (name or definition_id; optional revision, default the newest: its YAML, errors and the Workflows started from it); "
            + "save (name and yaml; to change an existing definition also give definition_id and expected_revision, the revision you read: a "
            + "save based on an older revision is refused, so read again and redo your change; a revision with errors is saved and shown "
            + "with its errors, but cannot start); "
            + "start (name or definition_id; optional revision, default the newest valid one; inputs; vars: a new Workflow from that revision; "
            + "to run a definition again, start it again; agent_models, optional: leave it out, so every agent node uses this chat's model, "
            + "reasoning and context; give it only when the person asks for a model, or a package card's model hint for a node asks for a "
            + "kind of model, reasoning or context: then map that agent node's id, its key under states: (one key for all items of a For "
            + "each), to { model: an exact provider:model from list_available_models (the owning chat's catalog), reasoning_effort?, "
            + "context_tier? (each one the model lists) } and say what you chose; an id that is not an agent node of that revision, or a "
            + "model, effort or tier the owning chat's catalog does not have, refuses the start); "
            + (tests
                ? "test (only when the user asks you to test it, or before you publish it in a package; never on your own, and Start never needs a "
                    + "test: name or definition_id; optional "
                    + "revision; inputs; vars; fixtures, the prepared answers for its tool calls, agent steps, sends and requests: each { operation?: "
                    + "tool.call (default) | agent | send | request, tool (a tool call's) or state (another step's), arguments? (absent: any arguments), "
                    + "response: { kind: success | error | cancel, value } }; the success value by kind: a tool call's result, an agent step's "
                    + "{ outcome: one of its outcomes, output }, a request step's { response: <the answer> } or { decline: { reason } }, a send "
                    + "step's any value; an error's value is { code: a runtime error code such as execution_failed, message }. For example, an "
                    + "agent step classify and a request step approve: [{ operation: agent, state: classify, response: { kind: success, value: "
                    + "{ outcome: bug, output: { label: \"bug\" } } } }, { operation: request, state: approve, response: { kind: success, value: "
                    + "{ response: { approved: true } } } }]. A prepared answer of the wrong shape fails the test, which says the shape it needs. "
                    + "It runs that revision "
                    + "to its end in a hidden test (scripts run for real; waits pass at once; a call with no prepared answer fails the test, which names "
                    + "it) and returns a report; if it is still running after a few minutes, read it again with test_id); "
                : "Workflow tests do not run here, so there is no test operation: if the user asks for a test, say a test cannot run here. ")
            + "card (name <package>/<name>: a package's Workflow Definition's interface card: what it does, its inputs with an example, how it ends, "
            + "what it asks and sends you). A package's definition is named <package>/<name> (such as release-tools/release-watch) and is locked: "
            + "you start it, you never save it. list shows under canStart the package definitions you may start; read a card before you start one, "
            + "ask the person for any input you lack, and start it by its <package>/<name> (update: true starts the package's newer version when "
            + "list shows one). Change a Workflow = save a new "
            + "revision, then start it. Recurring or polling work is one Workflow with a wait node looping back, never a timer that starts a "
            + "Workflow each time. Returns JSON.",
        parameters: {
            type: "object",
            properties: {
                operation: { type: "string", enum: tests ? ["list", "read", "save", "start", "test", "card"] : ["list", "read", "save", "start", "card"],
                    description: "What to do." },
                name: { type: "string", description: "The definition's name (its YAML's metadata.name), or <package>/<name> for a package's definition." },
                definition_id: { type: "string", description: "The definition's id, from list, read or a save. Needed to save over an existing one." },
                expected_revision: { type: "integer", description: "save: the revision your change is based on (from read or list)." },
                yaml: { type: "string", description: "save: the whole definition YAML (apiVersion pilotswarm.dev/v2-draft)." },
                revision: { type: "integer", description: "read or start: a revision number; default the newest (start: the newest valid)." },
                inputs: { type: "object", description: "start: the run's inputs, as the definition's inputs schema asks." },
                vars: { type: "object", description: "start: the run's initial variables." },
                notify_on_completion: { type: "boolean", description: "start: tell this chat when the Workflow ends. Default true." },
                agent_models: { type: "object", description: "start, optional (OF-S2-7): agent node id (its key under states:) → { model: "
                    + "exact provider:model from list_available_models (the owning chat's catalog), reasoning_effort?, context_tier? }. Leave it out to use this chat's "
                    + "model; give it only when the person asks, or a package card's hint asks for a kind of model." },
                ...(tests ? {
                    fixtures: { type: "array", items: { type: "object" }, description: "test: the prepared answers, each { operation?, tool or state, "
                        + "arguments?, response: { kind, value } }: an agent step's value { outcome, output }, a request step's { response } or "
                        + "{ decline: { reason } }, a send step's any value, a tool call's its result (see the operation test for an example)." },
                    test_id: { type: "string", description: "test: read a test that was still running (its test_id from the earlier answer)." },
                } : {}),
                update: { type: "boolean", description: "start of a package's definition: start the package's newer version (list shows it as newerVersion)." },
            },
            required: ["operation"],
        },
    } as const;
}

/** The declaration with the test operation (a host that runs Workflow tests). */
export const WORKFLOW_DEFINITION_TOOL_SPEC = workflowDefinitionToolSpec();

type Args = Record<string, unknown>;

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function objectArg(args: Args, key: string): { [key: string]: JsonValue } | null {
    const value = args[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `${key} must be a JSON object.`);
    return value as { [key: string]: JsonValue };
}

function intArg(args: Args, key: string): number | null {
    const value = args[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `${key} must be a revision number.`);
    return value;
}

function revisionJson(revision: ChatRevisionRow | null, includeYaml: boolean): { [key: string]: JsonValue } | null {
    if (!revision) return null;
    return {
        revision: revision.revision, valid: revision.valid, version: revision.semver, basedOn: revision.basedOn, savedAt: revision.createdAt,
        savedBy: revision.actor.kind === "chat" ? "this chat" : revision.actor.kind === "user" ? (revision.actor.display ?? "a person") : "imported",
        errors: revision.diagnostics.filter(item => item.severity !== "warning").map(item => ({ code: item.code, path: item.path, message: item.message,
            ...(Number.isSafeInteger(item.line) ? { line: item.line as number } : {}) })),
        ...(includeYaml ? { yaml: revision.yaml } : {}),
    };
}

function definitionJson(view: ChatDefinitionView): { [key: string]: JsonValue } {
    return {
        definitionId: view.definitionId, name: view.name, currentRevision: view.currentRevision, newestValidRevision: view.newestValidRevision,
        currentValid: view.current?.valid ?? null, version: view.current?.semver ?? null,
        // Stage 2.3: a package's definition is locked; its package version, and a newer one offered for the next Workflow (P6).
        ...(view.locked ? { locked: true, package: { name: view.packageName ?? "", version: view.current?.package?.semver ?? null },
            ...(view.packageUpdate ? { newerVersion: view.packageUpdate.semver } : {}) } : {}),
        workflows: view.workflows.map(item => ({ workflowId: item.workflowSessionId, revision: item.revision, status: item.runStatus })),
        // L1: a person's copy of a package's definition says which revision and package version it was copied from.
        ...(view.copiedFrom ? { copiedFrom: { name: view.copiedFrom.name, revision: view.copiedFrom.revision,
            ...(view.copiedFrom.package ? { packageVersion: view.copiedFrom.package.semver } : {}) } } : {}),
    };
}

function saveJson(receipt: ChatSaveReceipt, replayed: boolean): { [key: string]: JsonValue } {
    return {
        ok: true, operation: "save", replayed, definitionId: receipt.definitionId, name: receipt.name, revision: receipt.revision,
        basedOn: receipt.basedOn, valid: receipt.valid, version: receipt.semver,
        errors: receipt.diagnostics.filter(item => item.severity !== "warning").map(item => ({ code: item.code, path: item.path, message: item.message,
            ...(Number.isSafeInteger(item.line) ? { line: item.line as number } : {}) })),
        message: receipt.valid
            ? `Saved ${receipt.name} revision ${receipt.revision}. Start it with operation start when the user wants a Workflow of it.`
            : `Saved ${receipt.name} revision ${receipt.revision} with errors; it cannot start. Fix them and save again (expected_revision ${receipt.revision}).`,
    };
}

export interface WorkflowDefinitionToolContext {
    callerSessionId: string;
    host: WorkflowV2Host;
    /** The tool call's id: the operation id of a save or start, so a repeated call is answered from its receipt. */
    toolCallId: string | null;
    owner: SessionOwnerInfo | null;
    /** Captured for a start's script steps (as spawn_workflow does); null when the host cannot capture it. */
    binding: () => Promise<WorkflowToolBinding | null>;
    /** Stage 2.2: how a test call waits (tests only; default chat-test.ts's). */
    testWait?: { waitMs?: number; pollMs?: number; graceMs?: number };
    /** Stage 2.4: the chat's nesting level, for Start's depth limit (spawn_agent's). */
    nestingLevel?: number | null;
    /**
     * Stage 2.3 (P4): the chat's bound agent's workflows list and its package (bare names are that package's). Absent or
     * empty: the chat may start only what is already attached and, for a coordinating chat, its own definition.
     */
    agentWorkflows?: () => Promise<{ packageName: string | null; refs: string[] }>;
}

/** The package definitions this chat may start (P4, P2): its agent's (bare names in its own package) and its coordinating ref. */
async function allowedPackageRefs(context: WorkflowDefinitionToolContext): Promise<string[]> {
    const allowed = new Set<string>();
    const agent = context.agentWorkflows ? await context.agentWorkflows() : { packageName: null, refs: [] };
    for (const ref of agent.refs) {
        const parsed = parseWorkflowPackageRef(ref, agent.packageName);
        if (parsed) allowed.add(`${parsed.packageName}/${parsed.name}`);
    }
    const chat = await context.host.catalog.getSession(context.callerSessionId);
    const coordinating = (chat as { workflowRef?: string | null } | null)?.workflowRef ?? null;
    if (coordinating) allowed.add(coordinating);
    return [...allowed];
}

function viewerOf(context: WorkflowDefinitionToolContext): PackageViewer | null {
    return context.owner ? { provider: context.owner.provider, subject: context.owner.subject } : null;
}

/** workflow_definition for the chat `callerSessionId`. Every answer is JSON; a refusal carries its code and words. */
export async function workflowDefinitionFromTool(args: Args, context: WorkflowDefinitionToolContext): Promise<string> {
    try {
        const operation = text(args.operation);
        const chat = context.callerSessionId;
        const chatActor = { kind: "chat" as const, sessionId: chat };
        const engineActor: WorkflowActor = { kind: "agent", sessionId: chat } as WorkflowActor;
        if (operation === "list") {
            const views = await withPackageUpdates(context.host, await listChatWorkflowDefinitions(context.host, chat, { forChat: true }), viewerOf(context));
            // Stage 2.3 (P4): the package definitions this chat may start, with what each is for.
            const allowed = await allowedPackageRefs(context);
            const canStart: JsonValue[] = [];
            if (allowed.length && context.host.packageWorkflows) {
                const visible = await context.host.packageWorkflows.list(viewerOf(context)).catch(() => []);
                for (const ref of allowed) {
                    const entry = visible.find(item => item.ref === ref);
                    canStart.push(entry ? { name: ref, version: entry.semver, description: entry.workflow.description,
                        attached: views.some(view => view.name === ref && view.deletedAt === null) }
                        : { name: ref, available: false, note: "No package you can use has it now." });
                }
            }
            return JSON.stringify({ ok: true, operation: "list", definitions: views.map(definitionJson), ...(canStart.length ? { canStart } : {}) });
        }
        if (operation === "card") {
            const name = text(args.name);
            if (!name) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "card needs name: <package>/<name>.");
            const card = await readPackageWorkflowCard(context.host, chat, requirePackageRef(name).ref, viewerOf(context));
            return JSON.stringify({ ok: true, operation: "card", name: card.ref, package: card.packageName, version: card.semver,
                attached: card.attached !== null, ...(card.newerVersion ? { newerVersion: card.newerVersion } : {}),
                inputsSchema: card.interface?.inputSchema ?? null, exampleInputs: card.card.inputs.example, outcomes: card.card.outcomes,
                card: card.words });
        }
        const ref = { definitionId: text(args.definition_id), name: text(args.name) };
        if (operation === "read") {
            if (!ref.definitionId && !ref.name) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "read needs name or definition_id.");
            const [view] = await withPackageUpdates(context.host,
                [await readChatWorkflowDefinition(context.host, chat, ref, { revision: intArg(args, "revision"), forChat: true })], viewerOf(context));
            return JSON.stringify({ ok: true, operation: "read", ...definitionJson(view), deleted: view.deletedAt !== null,
                revisions: view.revisions.map(item => ({ revision: item.revision, valid: item.valid, version: item.semver, savedAt: item.createdAt,
                    savedBy: item.actor.kind === "chat" ? "this chat" : item.actor.kind === "user" ? (item.actor.display ?? "a person") : "imported" })),
                shown: revisionJson(view.revision, true) });
        }
        if (operation === "save") {
            if (!context.toolCallId) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "save needs a tool call id.");
            const name = text(args.name);
            if (!name) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "save needs name (the YAML's metadata.name).");
            // Stage 2.3 (E2-7): a package's definition (<package>/<name>) is locked.
            if (name.includes("/")) {
                const attached = await context.host.store.chat.readDefinitionByName(chat, name);
                if (attached?.locked) refuseLockedSave(attached);
                throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "A name with a slash names a package's Workflow Definition, which is locked. "
                    + "Save your own definition under a name without a slash (its YAML's metadata.name).");
            }
            const yaml = String(args.yaml ?? "");
            // The scripts gate first (d52e5ed2): a host that runs no scripts refuses a script node before anything is read.
            const compiled = yaml.trim() ? compileWorkflowV2ForHost(context.host, yaml) : undefined;
            if (compiled) requireWorkflowScripts(context.host, compiled.ir, "save");
            const expectedRevision = intArg(args, "expected_revision");
            let expected: { definitionId: string; revision: number } | null = null;
            if (ref.definitionId || expectedRevision !== null) {
                if (!ref.definitionId || expectedRevision === null) {
                    throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "To save over a definition give both definition_id and expected_revision.");
                }
                expected = { definitionId: ref.definitionId, revision: expectedRevision };
            } else {
                // S2RT-F7: a repeat of this call (its operation stored) is answered by the store from its receipt (or refused as
                // another request), before the name it saved is found and asked for a guard.
                const repeat = context.toolCallId ? await context.host.store.chat.readStoredOperation?.(chat, `definition:${context.toolCallId}`) : null;
                // A name the chat already has needs the guard: say which definition and revision to read.
                const existing = repeat ? null : await context.host.store.chat.readDefinitionByName(chat, name);
                if (existing) {
                    throw new WorkflowStoreError("REVISION_REQUIRED", `This chat already has ${name} (revision ${existing.currentRevision}). Read it, then save with `
                        + `definition_id ${existing.definitionId} and expected_revision ${existing.currentRevision}.`,
                        { definitionId: existing.definitionId, currentRevision: existing.currentRevision });
                }
            }
            const stored = await saveChatWorkflowDefinition(context.host, { ownerSessionId: chat, name, yaml, expected,
                actor: chatActor, operationId: `definition:${context.toolCallId}`, by: "chat", ...(compiled ? { compiled } : {}) });
            return JSON.stringify(saveJson(stored.receipt, stored.replayed));
        }
        if (operation === "start") {
            if (!context.toolCallId) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "start needs a tool call id.");
            if (!ref.definitionId && !ref.name) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "start needs name or definition_id.");
            const inputs = objectArg(args, "inputs") ?? {};
            const vars = objectArg(args, "vars");
            let revision = intArg(args, "revision");
            // OF-S2-7: agent node models chosen at start: their shape is checked before anything is read or attached; the start
            // checks them against the revision it starts and this chat's catalog.
            const agentModels = parseWorkflowAgentModels(args.agent_models);
            let startRef: { definitionId?: string | null; name?: string | null } = ref;
            // Stage 2.3 (P2, P4–P6): a package's definition is attached first when this chat does not have it yet (or, with
            // update, when the package has a newer version); the start then pins exactly the revision attached.
            if (!ref.definitionId && ref.name && ref.name.includes("/")) {
                const packageRef = requirePackageRef(ref.name).ref;
                const attached = await context.host.store.chat.readDefinitionByName(chat, packageRef);
                if (!attached || args.update === true) {
                    if (!attached && !(await allowedPackageRefs(context)).includes(packageRef)) {
                        throw new WorkflowStoreError("PACKAGE_WORKFLOW_NOT_ALLOWED", `This chat may not start ${packageRef}: its agent does not name it. `
                            + "list shows under canStart the package definitions it may start.", { ref: packageRef });
                    }
                    // update on a definition the chat has: only the same package's strictly greater version (S2SF-F6 / L4).
                    const stored = await attachChatPackageWorkflow(context.host, { ownerSessionId: chat, ref: packageRef, viewer: viewerOf(context),
                        actor: chatActor, operationId: `definition:${context.toolCallId}:attach`, by: "chat", ...(attached ? { newerOnly: true } : {}) });
                    startRef = { definitionId: stored.receipt.definitionId };
                    if (revision === null) revision = stored.receipt.revision;
                }
            }
            // The binding is captured after the scripts gate, by the start itself (d52e5ed2).
            const started = await startChatWorkflowDefinition(context.host, { ownerSessionId: chat, definition: startRef, revision,
                inputs, vars, notifyParent: args.notify_on_completion !== false, actor: engineActor, operationId: `definition:${context.toolCallId}`,
                owner: context.owner, binding: context.binding, nestingLevel: context.nestingLevel ?? null, ...(agentModels ? { agentModels } : {}) });
            return JSON.stringify({ ok: true, operation: "start", replayed: started.replayed, definitionId: started.definitionId, name: started.name,
                revision: started.revision, workflowId: started.workflowId, runId: started.runId,
                ...(started.agentModels ? { agentModels: started.agentModels as unknown as JsonValue } : {}),
                message: `Started a Workflow of ${started.name} revision ${started.revision}. `
                    + chosenModelsWords(started.agentModels)
                    + (args.notify_on_completion === false ? "You will not be told when it ends." : "You will be told when it ends; do not poll for it.") });
        }
        if (operation === "test") {
            // Stage 2.2 (chat-test.ts): only when the person asks; a hidden test of a revision with prepared answers, and its report.
            const actor: WorkflowActor = { kind: "agent", sessionId: chat } as WorkflowActor;
            // S2RT-F9: tests run only where they can, a test read again by its id too.
            requireTestHost(context.host);
            const testId = text(args.test_id);
            if (testId) {
                const bench = await chatTestBench(context.host, chat, testId);
                return JSON.stringify(await waitChatWorkflowTest(context.host, bench, { actor, ...context.testWait }));
            }
            if (!context.toolCallId) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "test needs a tool call id.");
            if (!ref.definitionId && !ref.name) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "test needs name or definition_id.");
            const fixtures = parseTestFixtures(args.fixtures);
            const started = await startChatWorkflowTest(context.host, { ownerSessionId: chat, definition: ref, revision: intArg(args, "revision"),
                inputs: objectArg(args, "inputs") ?? {}, vars: objectArg(args, "vars"), fixtures, operationId: `definition:${context.toolCallId}`, actor,
                owner: async () => context.owner, binding: context.binding });
            return JSON.stringify(await waitChatWorkflowTest(context.host, started, { actor, ...context.testWait }));
        }
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "operation must be list, read, save, start or test.");
    } catch (error) {
        return workflowToolErrorPayload(error);
    }
}

/**
 * spawn_workflow for a v2 document, one release (D2): save to the chat's definition of the YAML's metadata.name, then, with
 * state published and start true, start the revision this call saved (F4). The save is guarded by the newest revision of
 * that definition this chat has seen (Q2): when another save landed since (a person's), it is refused, and the chat is told
 * to read and redo its change. Without start it is only a save (there are no drafts: a revision is not started until
 * Start).
 */
export async function spawnWorkflowCompatFromTool(
    args: { yaml: string; inputs?: Record<string, unknown>; vars?: Record<string, unknown>; notify_on_completion?: boolean; key?: string; state?: string; start?: boolean;
        agent_models?: unknown },
    context: {
        callerSessionId: string; operationId: string; host: WorkflowV2Host;
        /** The chat's owner and tool binding, each read only after the scripts gate and only for a start (d52e5ed2). */
        owner: () => Promise<SessionOwnerInfo | null>;
        binding: () => Promise<WorkflowToolBinding>;
        /** Stage 2.4: the chat's nesting level, for Start's depth limit (spawn_agent's). */
        nestingLevel?: number | null;
    },
): Promise<string> {
    try {
        if (args.state !== undefined && args.state !== "draft" && args.state !== "published") throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "state must be draft or published.");
        if (args.start === true && args.state !== "published") throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "start needs state: published.");
        const chat = context.callerSessionId;
        const compiled = compileWorkflowV2ForHost(context.host, args.yaml);
        const name = compiled.name ?? (() => { throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "The YAML needs metadata.name: it names the definition."); })();
        // A host that runs no scripts refuses a definition with a script node before anything else (d52e5ed2: before the
        // chat's tool binding is captured, its owner read or its definitions read), in the words of what was asked (a save,
        // or a save and a start).
        requireWorkflowScripts(context.host, compiled.ir, args.start === true ? "start" : "save");
        // OF-S2-7: agent node models are for a start, checked against this YAML before anything is saved (the start checks them
        // again against the revision it starts, and against this chat's catalog).
        const agentModels = parseWorkflowAgentModels(args.agent_models);
        if (agentModels && args.start !== true) throw new WorkflowStoreError("AGENT_MODELS_INVALID", "agent_models applies only with start: true.");
        if (compiled.ir) requireAgentModelsForRevision(agentModels, compiled.ir, name);
        // A start needs the chat's tool binding: captured now, so a chat whose tools are not ready saves nothing either.
        const binding = args.start === true ? await context.binding() : null;
        const owner = args.start === true ? await context.owner() : null;
        // Code check G2: an exact repeat (the same key, or call, and YAML: the same operation id) is answered from the save's
        // receipt, read by operation id before the guard: the guard comes from what the chat has seen, which the first save
        // moved on, so a recomputed guard would make it another request (OPERATION_CONFLICT). After a crash between the save
        // and the start, the repeat starts the revision that save made. The guard still applies to a first execution.
        const saveOperationId = `${context.operationId}:save`;
        const stored = await context.host.store.chat.readStoredOperation<ChatSaveReceipt>(chat, saveOperationId);
        let saved: { receipt: ChatSaveReceipt; replayed: boolean };
        if (stored) {
            if (stored.kind !== "save" || stored.receipt.name !== name || stored.receipt.yamlSha256 !== compiled.yamlSha256) {
                throw new WorkflowStoreError("OPERATION_CONFLICT", `Operation ${saveOperationId} was used for a different request; use another key.`);
            }
            saved = { receipt: stored.receipt, replayed: true };
        } else {
            const existing = await context.host.store.chat.readDefinitionByName(chat, name);
            let expected: { definitionId: string; revision: number } | null = null;
            if (existing) {
                const seen = await context.host.store.chat.seenRevision(chat, existing.definitionId);
                expected = { definitionId: existing.definitionId, revision: seen ?? 0 };
                if (seen === null) {
                    throw new WorkflowStoreError("REVISION_STALE", `${name} has revision ${existing.currentRevision}, which this chat has not read. Read it with `
                        + `workflow_definition (operation read), redo your change on it, and save it with operation save. Nothing was saved.`,
                        { definitionId: existing.definitionId, currentRevision: existing.currentRevision });
                }
            }
            try {
                saved = await saveChatWorkflowDefinition(context.host, { ownerSessionId: chat, name, yaml: args.yaml, expected,
                    actor: { kind: "chat", sessionId: chat }, operationId: saveOperationId, by: "chat", compiled });
            } catch (error) {
                if (error instanceof WorkflowStoreError && error.code === "REVISION_STALE") {
                    throw new WorkflowStoreError("REVISION_STALE", `${error.message} Read ${name} with workflow_definition (operation read), redo your change on `
                        + "its newest revision, and save it with operation save.", error.details);
                }
                throw error;
            }
        }
        const receipt = saved.receipt;
        if (args.start !== true) {
            return JSON.stringify({ ...saveJson(receipt, saved.replayed),
                note: "spawn_workflow is kept for one release; use workflow_definition (save, then start)." });
        }
        if (!receipt.valid) {
            return JSON.stringify({ ...saveJson(receipt, saved.replayed), started: false,
                note: "Not started: this revision has errors. spawn_workflow is kept for one release; use workflow_definition." });
        }
        const inputs = args.inputs === undefined ? {} : args.inputs;
        if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "inputs must be a JSON object.");
        const started = await startChatWorkflowDefinition(context.host, { ownerSessionId: chat, definition: { definitionId: receipt.definitionId },
            revision: receipt.revision, inputs: inputs as { [key: string]: JsonValue }, vars: (args.vars ?? null) as { [key: string]: JsonValue } | null,
            notifyParent: args.notify_on_completion !== false, actor: { kind: "agent", sessionId: chat } as WorkflowActor,
            operationId: `${context.operationId}:start`, owner, binding, nestingLevel: context.nestingLevel ?? null, ...(agentModels ? { agentModels } : {}) });
        return JSON.stringify({ ok: true, operation: "save_and_start", replayed: saved.replayed && started.replayed, definitionId: receipt.definitionId,
            name: receipt.name, revision: receipt.revision, workflowId: started.workflowId, runId: started.runId,
            ...(started.agentModels ? { agentModels: started.agentModels as unknown as JsonValue } : {}),
            message: `Saved ${receipt.name} revision ${receipt.revision} and started a Workflow of it. ${chosenModelsWords(started.agentModels)}`
                + "You will be told when it ends; do not poll for it.",
            note: "spawn_workflow is kept for one release; use workflow_definition (save, then start)." });
    } catch (error) {
        return workflowToolErrorPayload(error);
    }
}
