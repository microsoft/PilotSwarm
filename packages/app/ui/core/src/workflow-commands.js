import { workflowOutcomeWord, workflowRunStateWord } from "./workflow-words.js";
import {
    workflowAgentBinding, workflowAgentBindingRows, workflowAgentTask, workflowBranchNumber, workflowClipped, workflowRunRows, workflowVisitEnding,
} from "./workflow-view.js";

/**
 * Workflow: a person's workflow commands in the workflow view (design 04
 * and 07, mocks M03, M04, M15 and M16; R04, R05, R17, R18, R26): the
 * run controls (pause, resume, stop, cancel), the run's variables (set_vars:
 * set or remove a key, or several in one update, at the expected KV
 * revision), the draft's YAML
 * (replace_definition at the revision the edit started from), the
 * definition's publication (publish the exact revision shown, publish it and
 * start its live run, start the published revision's live run), a test of
 * the exact revision shown (test, with its agent mode), and a test run's
 * answers to its held calls and its virtual clock (test_respond,
 * test_advance). Pure: nothing here
 * calls anything. The controller sends a command (sendWorkflowRunCommand) as
 * an updateWorkflow command through the transport; this module says which
 * commands the workflow offers, checks what a person typed, and says what the
 * view shows about the last command.
 *
 * The read model says which commands the workflow takes from people
 * (`personCommands`). A server adds it only when its deployment takes them,
 * so without it there are no controls and the view stays read-only. The
 * server decides every command again (the session gate, the subtree rule,
 * the run's state); this only avoids offering a command it would refuse.
 */

/** The run controls, in the order the view shows them. */
export const WORKFLOW_RUN_CONTROL_OPERATIONS = Object.freeze(["pause", "resume", "stop", "cancel"]);

const ACTIVE = new Set(["admitted", "running", "paused"]);
const ENDED = new Set(["completed", "failed", "cancelled", "stopped"]);
const LABELS = { pause: "Pause", resume: "Resume", stop: "Stop", cancel: "Cancel" };
/** How a notice names each command. */
const NOTICE_LABELS = { ...LABELS, set_vars: "The variables update", publish: "Publish", publish_and_start: "Publish and start", start: "Start",
    replace_definition: "Saving the draft", test: "Starting the test", test_respond: "The test answer", test_advance: "The clock advance" };
/** Review 19:10Z: how a refusal begins, "<label> refused:" or "<thing> not saved:" (never "was refused"). */
const REFUSED_WORDS = { pause: "Pause refused", resume: "Resume refused", stop: "Stop refused", cancel: "Cancel refused",
    set_vars: "Variables not saved", publish: "Publish refused", publish_and_start: "Publish and start refused", start: "Start refused",
    replace_definition: "Draft not saved", test: "Test not started", test_respond: "Test answer refused", test_advance: "Clock advance refused" };
/** The definition's commands: they name no run (a test makes its own). */
const DEFINITION_OPERATIONS = new Set(["replace_definition", "publish", "publish_and_start", "start", "test"]);
/** The longest test scenario name (tools.ts). */
const SCENARIO_MAX = 128;
/** The longest single advance of a test run's virtual clock (store.ts WORKFLOW_TEST_ADVANCE_MAX_SECONDS: 30 days). */
const ADVANCE_MAX_SECONDS = 30 * 86_400;
/** The kinds of a test answer (test-mode.ts parseTestResponse). */
const RESPONSE_KINDS = new Set(["success", "error", "cancel"]);

/**
 * What every test run says, and what a test with real agents adds (the SDK's
 * WORKFLOW_TEST_NOTICE and WORKFLOW_TEST_REAL_AGENT_NOTICE, test-mode.ts):
 * shown before a test starts; the run's own notices come back with its read
 * model once it runs.
 */
export const WORKFLOW_TEST_NOTICE_TEXT = "TEST — workflow tools are mocked, but scripts run normally: their files, network, processes and "
    + "clock are real. A passing test does not show that the workflow is safe to run live.";
export const WORKFLOW_TEST_REAL_AGENT_NOTICE_TEXT = "Agent steps run real agent sessions: they spend model tokens and their results vary as a "
    + "model's do. Their workflow tool calls are mocked; their model's own built-in tools (shell, files) run normally; MCP tools are refused.";
/** What the variables panel says about them, in the portal and the terminal (the flow review's plain words). */
export const WORKFLOW_VARIABLES_HELP_TEXT = "Nodes read these variables when they start; started nodes keep the values they started with.";
/** Why a published workflow offers no test (of-06; the server's TEST_NEEDS_DRAFT says the same). */
export const WORKFLOW_TEST_NEEDS_DRAFT_TEXT = "Only a draft can be tested, and this workflow is published. To test a change, create a new workflow as a draft.";
/** The largest workflow YAML (compiler.ts WORKFLOW_MAX_YAML_BYTES); the server checks it again. */
const YAML_MAX_BYTES = 256 * 1024;
/** The longest KV key (store.ts WORKFLOW_KV_LIMITS.maxKeyLength). */
const KV_KEY_MAX = 128;
/** The longest value shown in the variables list; editing uses the whole value. */
const VALUE_DISPLAY_LIMIT = 300;
const PENDING_LABELS = { pause: "Pausing…", resume: "Resuming…", stop: "Stopping…", cancel: "Canceling…" };
// Reviews 18:45Z and 19:10Z: "started nodes", a stop either way ends as Canceled, and nodes are canceled, not interrupted.
const TITLES = {
    pause: "No new node starts; started nodes finish and their results are kept.",
    resume: "Nodes start again from where it was paused.",
    stop: "Let started nodes finish, then cancel, or cancel now.",
    cancel: "Cancel now: started nodes are canceled.",
};
const MESSAGE_LIMIT = 300;

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value ? value : null;
/** A long id keeps its start and its end; the title or the message carries the whole id where it matters. */
const bounded = value => value.length > MESSAGE_LIMIT ? `${value.slice(0, MESSAGE_LIMIT - 1)}…` : value;

/** "'a'", "'a' and 'b'", "'a', 'b', 'c' and 2 more". */
function keyNames(keys) {
    const shown = keys.slice(0, 3).map(key => `'${key.length > 40 ? `${key.slice(0, 39)}…` : key}'`);
    const more = keys.length - shown.length;
    if (more > 0) return `${shown.join(", ")} and ${more} more`;
    return shown.length < 2 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** Why a workflow in a workflow agent state's subtree takes only a person's brakes, naming its controlling agent, or null. */
export function workflowRestrictionText(commands) {
    return isRecord(commands) ? restrictionText(commands) : null;
}

function restrictionText(commands) {
    if (!isRecord(commands.restriction)) return null;
    // The server's reason when it sends one; else one short line, the same in the portal and the terminal.
    // Review 19:27Z: no session id where a person reads it (the TUI has no tooltip to carry it).
    return text(commands.restriction.reason) ?? "People can only pause, stop or cancel this Workflow.";
}

/** Whether the run's status admits the control (a stopping run takes only cancel). */
function applies(operation, status, stopping) {
    if (stopping) return operation === "cancel";
    if (operation === "pause") return status === "admitted" || status === "running";
    if (operation === "resume") return status === "paused";
    return ACTIVE.has(status);
}

/**
 * The run controls for the run a read model shows, given the view's last
 * command (`runCommand`, the controller's record), or null: without
 * `personCommands` (the deployment takes no person's commands) or without a
 * run. Never throws.
 *
 * A control is listed when the workflow takes it from people (a workflow in
 * a workflow agent state's subtree takes only pause, stop and cancel, and
 * `restriction` says why) and the run's status admits it: pause while the
 * run waits to start or runs, resume while it is paused, stop and cancel
 * until it ends; a stopping run takes only cancel, and an ended run none.
 * It is disabled, with the reason as its title, while a command is being
 * sent, when the signed-in viewer may not command the workflow (the
 * portal's decision, `viewer`), and, for stop, when the run's controller
 * cannot stop it gracefully.
 */
export function workflowRunControls(model, command = null) {
    if (!isRecord(model) || !isRecord(model.personCommands) || !isRecord(model.run)) return null;
    const run = model.run;
    if (typeof run.runId !== "string" || !run.runId || (!ACTIVE.has(run.status) && !ENDED.has(run.status))) return null;
    const commands = model.personCommands;
    const offered = new Set(Array.isArray(commands.operations) ? commands.operations.filter(item => typeof item === "string") : []);
    const viewer = isRecord(commands.viewer) ? commands.viewer : null;
    const denied = viewer?.allowed === false ? text(viewer.reason) ?? "You cannot command this Workflow." : null;
    const stopKnown = isRecord(commands.run) && commands.run.runId === run.runId && typeof commands.run.stop === "boolean";
    const stopUnsupported = stopKnown && commands.run.stop === false;
    const stopping = ACTIVE.has(run.status) && isRecord(run.stop);
    const busy = isRecord(command) && command.phase === "pending";
    const controls = WORKFLOW_RUN_CONTROL_OPERATIONS
        .filter(operation => offered.has(operation) && applies(operation, run.status, stopping))
        .map(operation => {
            const pending = busy && command.operation === operation && command.runId === run.runId;
            const reason = busy ? (pending ? "This command is being sent." : "Another command for this Workflow is being sent.")
                : denied ?? (operation === "stop" && stopUnsupported ? "This Workflow cannot let started nodes finish; cancel it instead." : null);
            return { operation, label: pending ? PENDING_LABELS[operation] : LABELS[operation], enabled: reason === null, pending,
                danger: operation === "cancel", title: reason ?? TITLES[operation] };
        });
    return { runId: run.runId, mode: run.mode === "test" ? "test" : "live", controls, busy, restriction: restrictionText(commands), viewerReason: denied };
}

/**
 * The arguments of a command the view sends, checked, or `{ ok: false }`.
 * A run control takes none (`args` null). set_vars (design 02 open KV) takes
 * a `set` map and a `delete` list (at least one key between them, each named
 * once, 1 to 128 characters) and the KV revision the person saw
 * (`expectedKvRevision`): the server refuses the update if the variables
 * changed since (KV_REVISION_CONFLICT) and checks everything else again.
 */
export function workflowRunCommandArgs(operation, input = {}) {
    if (WORKFLOW_RUN_CONTROL_OPERATIONS.includes(operation)) return { ok: true, args: null };
    if (operation === "approval_respond") {
        if (!isRecord(input) || !text(input.approvalId) || typeof input.contextSha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.contextSha256)
            || (input.decision !== "approved" && input.decision !== "rejected")
            || (input.reason !== undefined && input.reason !== null && (typeof input.reason !== "string" || input.reason.length > 2_000))
            || (input.decision === "rejected" && (typeof input.reason !== "string" || !input.reason.trim()))) return { ok: false };
        return { ok: true, args: { approvalId: input.approvalId, contextSha256: input.contextSha256,
            decision: input.decision, reason: input.reason ?? null } };
    }
    // A test run's answer to one of its held calls, and its virtual clock (design 05).
    if (operation === "test_respond") {
        if (!isRecord(input) || typeof input.interceptionId !== "string" || !input.interceptionId) return { ok: false };
        const response = input.response;
        if (!isRecord(response) || !RESPONSE_KINDS.has(response.kind) || Object.keys(response).some(key => key !== "kind" && key !== "value")) return { ok: false };
        if (response.kind === "cancel" && response.value !== undefined && response.value !== null) return { ok: false };
        return { ok: true, args: { interceptionId: input.interceptionId, response } };
    }
    if (operation === "test_advance") {
        if (!isRecord(input) || !Number.isSafeInteger(input.seconds) || input.seconds < 1 || input.seconds > ADVANCE_MAX_SECONDS) return { ok: false };
        return { ok: true, args: { seconds: input.seconds } };
    }
    if (DEFINITION_OPERATIONS.has(operation)) return definitionArgs(operation, input);
    if (operation !== "set_vars" || !isRecord(input)) return { ok: false };
    const set = input.set === undefined ? {} : input.set;
    const removed = input.delete === undefined ? [] : input.delete;
    if (!isRecord(set) || !Array.isArray(removed) || removed.some(key => typeof key !== "string")) return { ok: false };
    const keys = [...Object.keys(set), ...removed];
    if (keys.length === 0 || keys.some(key => key.length < 1 || key.length > KV_KEY_MAX) || new Set(keys).size !== keys.length) return { ok: false };
    if (!Number.isSafeInteger(input.expectedKvRevision) || input.expectedKvRevision < 1) return { ok: false };
    return { ok: true, args: { set, delete: removed, expectedKvRevision: input.expectedKvRevision } };
}

/**
 * A definition command's arguments (design 04): publish takes the revision
 * shown (`expectedRevision`) and its exact `definitionHash`; publish_and_start
 * also takes the run's `inputs` (a JSON object, `{}` when absent) and,
 * optionally, its initial variables (`vars`, a JSON object); start takes the
 * published revision's `definitionHash`, `inputs` and optional `vars`; test
 * takes the current revision (`expectedRevision`) and its `definitionHash`,
 * `inputs`, optional `vars`, its `agentMode` ("mocked", the default, or
 * "real") and an optional `scenario` name (1 to 128 characters). The server
 * refuses a revision or hash that is no longer current (a stale publish or
 * test), inputs its schema refuses, and anything else it refuses.
 */
function definitionArgs(operation, input) {
    if (!isRecord(input)) return { ok: false };
    // replace_definition: the whole new YAML, at the revision the edit started from (a changed draft is refused).
    if (operation === "replace_definition") {
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) return { ok: false };
        if (typeof input.yaml !== "string" || !input.yaml.trim()) return { ok: false };
        return { ok: true, args: { expectedRevision: input.expectedRevision, yaml: input.yaml } };
    }
    const hash = typeof input.definitionHash === "string" && input.definitionHash ? input.definitionHash : null;
    if (hash === null) return { ok: false };
    if (operation === "publish" || operation === "publish_and_start" || operation === "test") {
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) return { ok: false };
        if (operation === "publish") return { ok: true, args: { expectedRevision: input.expectedRevision, definitionHash: hash } };
    }
    const inputs = input.inputs === undefined ? {} : input.inputs;
    if (!isRecord(inputs) || (input.vars !== undefined && !isRecord(input.vars))) return { ok: false };
    const run = { definitionHash: hash, inputs, ...(input.vars !== undefined ? { vars: input.vars } : {}) };
    if (operation === "test") {
        const agentMode = input.agentMode === undefined ? "mocked" : input.agentMode;
        if (agentMode !== "mocked" && agentMode !== "real") return { ok: false };
        if (input.scenario !== undefined && (typeof input.scenario !== "string" || !input.scenario.trim() || input.scenario.length > SCENARIO_MAX)) {
            return { ok: false };
        }
        return { ok: true, args: { expectedRevision: input.expectedRevision, ...run, agentMode,
            ...(input.scenario !== undefined ? { scenario: input.scenario } : {}) } };
    }
    return { ok: true, args: { ...(operation === "publish_and_start" ? { expectedRevision: input.expectedRevision } : {}), ...run } };
}

/** Whether a command acts on a run (and so needs the run's id): every command but the definition's. */
export function workflowCommandNamesRun(operation) {
    return !DEFINITION_OPERATIONS.has(operation);
}

/**
 * The updateWorkflow command a checked command is sent as, with its own
 * operation id: a run command always for the named run, a definition command
 * for the revision and hash it names.
 */
export function workflowRunCommandWire(operation, runId, operationId, args = null) {
    if (DEFINITION_OPERATIONS.has(operation)) {
        const command = { operation, operation_id: operationId };
        if (args?.expectedRevision !== undefined) command.expected_revision = args.expectedRevision;
        if (operation === "replace_definition") {
            command.yaml = args?.yaml;
            return command;
        }
        command.definition_hash = args?.definitionHash;
        if (args?.inputs !== undefined) command.inputs = args.inputs;
        if (args?.vars !== undefined) command.vars = args.vars;
        if (args?.agentMode !== undefined) command.agent_mode = args.agentMode;
        if (args?.scenario !== undefined) command.scenario = args.scenario;
        return command;
    }
    const command = { operation, operation_id: operationId, run_id: runId };
    if (!args) return command;
    if (operation === "approval_respond") {
        return { ...command, approval_id: args.approvalId, context_sha256: args.contextSha256, decision: args.decision, reason: args.reason };
    }
    if (operation === "test_respond") {
        command.interception_id = args.interceptionId;
        command.response = args.response;
        return command;
    }
    if (operation === "test_advance") {
        command.seconds = args.seconds;
        return command;
    }
    if (Object.keys(args.set).length) command.set = args.set;
    if (args.delete.length) command.delete = args.delete;
    command.expected_kv_revision = args.expectedKvRevision;
    return command;
}

/**
 * A variable a person typed, as the set it is sent as, or the reason it is
 * not one: a name of 1 to 128 characters (kept exactly as typed: spaces are
 * part of a name) and a JSON value (a string needs its quotes; null is a
 * value).
 */
export function workflowVariableDraft(key, valueText) {
    const name = typeof key === "string" ? key : "";
    if (name.length < 1 || name.length > KV_KEY_MAX) return { ok: false, error: `Name the variable (1 to ${KV_KEY_MAX} characters).` };
    const source = typeof valueText === "string" ? valueText : "";
    if (!source.trim()) return { ok: false, error: "Give the value as JSON, for example \"text\", 120, true or null." };
    try {
        // A computed name defines an own property, so any name ("__proto__" included) stays plain data.
        return { ok: true, set: { [name]: JSON.parse(source) } };
    } catch (error) {
        return { ok: false, error: `The value must be JSON (a string needs quotes): ${bounded(String(error?.message || error))}` };
    }
}

/**
 * Adversarial review R2-UI-1: an edit of the variables keeps the revision it started from (`base`) and is sent at it, so
 * a change someone else made meanwhile is refused instead of overwritten. When the variables shown are newer
 * (`revision`), the edit stays and this says so; nothing is sent until the person loads the new values or keeps the edit
 * to save it over them. Null when the edit is at the revision shown, or either is not known. Pure.
 */
export function workflowVariableEditBehind(base, revision) {
    if (!Number.isSafeInteger(base) || !Number.isSafeInteger(revision) || base === revision) return null;
    return { base, revision, text: `The variables changed since you started editing: revision ${base}, now ${revision}.` };
}

/**
 * Adversarial review R3-UI-2: whether a variables update (`input`: { expectedKvRevision, set?, delete? }, as the TUI's
 * forms send it) is exactly the unconfirmed set_vars command it would retry (`command`, the view's last run command): the
 * same run, the same revision and the same set and delete, as sendWorkflowRunCommand compares them (it then reuses that
 * command's operation id). Only such a retry may go out at a revision the view has moved past; any other edit keeps the
 * "behind" check (Keep or Load first). Pure.
 */
export function workflowVariableExactRetry(command, runId, input) {
    if (!isRecord(command) || command.phase !== "unconfirmed" || command.operation !== "set_vars" || (command.runId ?? null) !== (runId ?? null)) return false;
    const checked = workflowRunCommandArgs("set_vars", input);
    return checked.ok && JSON.stringify(command.args ?? null) === JSON.stringify(checked.args);
}

/** The portal's variables form when nothing is typed: no name, no value, no revision of its own (R2-UI-1). */
export const WORKFLOW_VARIABLE_EDIT_EMPTY = Object.freeze({ key: "", value: "", base: null, listed: null, notice: null, generation: 0 });

/** What the form says when a save it sent was accepted after the person had typed on (re-check UI-RC2-6). */
export const WORKFLOW_VARIABLE_EARLIER_SAVED = "Your earlier change was saved. Your newer edit is kept; it is not saved yet.";

/**
 * Re-check RC-1: whether `key` is a listed variable in `variables` (workflowRunVariables' entries and complete): true or
 * false only when the whole list could be read, else null (not known). Pure.
 */
export function workflowVariableListed(variables, key) {
    if (!isRecord(variables) || variables.complete !== true || !Array.isArray(variables.entries)) return null;
    return variables.entries.some(item => isRecord(item) && item.key === key);
}

/**
 * Re-check RC-1: what "Load new values" does to a one-variable edit (`edit`: key, value, base and `listed`, whether the
 * name was a listed variable when the edit started), from the variables shown now (`variables`: entries, complete,
 * revision). It loads only what it can read:
 * - `loaded`: the named variable's value now, at the shown revision;
 * - `removed`: the name was listed when the edit started and is not now: its old value is cleared, so it is not set again
 *   by mistake;
 * - `unset`: the name is not set now and it is not known whether it was: the typed value is cleared too;
 * - `new`: the name was not set when the edit started and is still not set: the new value stays;
 * - `blocked`: the list cannot be read whole (too long for this view, or unreadable): nothing is loaded, the edit stays at
 *   its own revision (still behind), and only Keep or clearing the form moves on.
 * Returns { kind, value, base, listed, notice }; `notice` says what happened in plain words (null for `loaded`). Pure.
 */
export function workflowVariableLoad(edit, variables) {
    const key = String(edit?.key ?? "");
    const value = String(edit?.value ?? "");
    const base = Number.isSafeInteger(edit?.base) ? edit.base : null;
    const listed = edit?.listed === true ? true : edit?.listed === false ? false : null;
    const revision = Number.isSafeInteger(variables?.revision) ? variables.revision : null;
    const name = key ? keyNames([key]) : "This variable";
    if (revision === null || workflowVariableListed(variables, key) === null) {
        const why = isRecord(variables) && typeof variables.preview === "string" && variables.preview.endsWith("…")
            ? "the variables are longer than this view" : "the variables could not be read";
        return { kind: "blocked", value, base, listed,
            notice: `The new values cannot be loaded here: ${why}. Your edit stays at revision ${base ?? "not known"}. Keep it to save it over the new values, or clear the form.` };
    }
    const entry = variables.entries.find(item => isRecord(item) && item.key === key);
    if (entry && typeof entry.valueText === "string") return { kind: "loaded", value: entry.valueText, base: revision, listed: true, notice: null };
    if (listed === false) {
        return { kind: "new", value, base: revision, listed: false, notice: `${name} is still not set at revision ${revision}, so your new value stays.` };
    }
    if (listed === true) {
        return { kind: "removed", value: "", base: revision, listed: false,
            notice: `${name} was removed at revision ${revision}, after you started editing. Its old value is cleared; type a value to set it again.` };
    }
    return { kind: "unset", value: "", base: revision, listed: false,
        notice: `${name} is not set at revision ${revision}; it may have been removed. The value is cleared; type a value to set it again.` };
}

/**
 * The portal's variables form (R2-UI-1): what is typed (`key`, `value`), the revision the edit started from (`base`),
 * whether its name was a listed variable then (`listed`; true, false, or null when not known) and what the last Load
 * said (`notice`), after `action`: `type` (field "key" or "value", its text; a clean form takes the shown `revision` as
 * its own, an emptied one drops it), `copy` (a listed variable's name and value at the shown `revision`), `keep` (the
 * edit stays and is saved over the shown `revision`), `reload` (Load new values: workflowVariableLoad, from the shown
 * `entries`, `complete` and `preview`; re-check RC-1: it never keeps stale values while taking the new revision),
 * `clear`, and `saved` (re-check UI-RC2-6: the answer to an update sent from the edit of `generation`). `type` and `keep`
 * take the shown `entries` and `complete` to know whether the name is listed. Every change of the edit raises its
 * `generation`, so `saved` empties the form only when it answers exactly the edit on screen; after a newer edit it keeps
 * that edit and says the earlier change was saved. A refresh of the workflow changes nothing here. Pure.
 */
export function workflowVariableEdit(edit, action) {
    const current = isRecord(edit) ? {
        key: String(edit.key ?? ""), value: String(edit.value ?? ""), base: Number.isSafeInteger(edit.base) ? edit.base : null,
        listed: edit.listed === true ? true : edit.listed === false ? false : null, notice: typeof edit.notice === "string" && edit.notice ? edit.notice : null,
        generation: Number.isSafeInteger(edit.generation) && edit.generation >= 0 ? edit.generation : 0,
    } : WORKFLOW_VARIABLE_EDIT_EMPTY;
    const revision = Number.isSafeInteger(action?.revision) ? action.revision : null;
    const generation = current.generation + 1;
    switch (action?.type) {
        case "type": {
            const next = { ...current, [action.field === "value" ? "value" : "key"]: String(action.text ?? ""), notice: null, generation };
            const dirty = next.key !== "" || next.value !== "";
            if (!dirty) return { ...next, base: null, listed: null };
            const base = current.base ?? revision;
            // Whether the name is listed is known for the edit's own revision only.
            const relisted = current.base === null || next.key !== current.key;
            const listed = !relisted ? current.listed : base !== null && base === revision ? workflowVariableListed(action, next.key) : null;
            return { ...next, base, listed };
        }
        case "copy":
            return { key: String(action.key ?? ""), value: String(action.value ?? ""), base: revision, listed: true, notice: null, generation };
        case "keep":
            return { ...current, base: revision ?? current.base, listed: revision !== null ? workflowVariableListed(action, current.key) : current.listed,
                notice: null, generation };
        case "reload": {
            const loaded = workflowVariableLoad(current, { entries: action.entries, complete: action.complete, preview: action.preview, revision });
            return { ...current, value: loaded.value, base: loaded.base, listed: loaded.listed, notice: loaded.notice, generation };
        }
        case "clear":
            return { ...WORKFLOW_VARIABLE_EDIT_EMPTY, generation };
        case "saved":
            // Only the edit that was sent is emptied; a newer one stays, with what happened to the earlier one. An empty form
            // (cleared, or a new run's) has nothing newer to keep, and is left as it is.
            if (action.generation === current.generation) return { ...WORKFLOW_VARIABLE_EDIT_EMPTY, generation };
            return current.key === "" && current.value === "" ? current : { ...current, notice: WORKFLOW_VARIABLE_EARLIER_SAVED };
        default:
            return current;
    }
}

/**
 * What the portal's variables form may do now (R2-UI-1): whether anything is typed, the revision an update is sent at
 * (the edit's own; the shown `revision` while nothing is typed), whether the edit is behind the shown revision (then
 * Set and Remove wait for the person to load the new values or keep the edit), and what the last Load said (RC-1). Pure.
 */
export function workflowVariableEditState(edit, revision) {
    const current = workflowVariableEdit(edit, null);
    const dirty = current.key !== "" || current.value !== "";
    const expectedKvRevision = dirty && current.base !== null ? current.base : revision;
    return { dirty, expectedKvRevision, behind: dirty ? workflowVariableEditBehind(expectedKvRevision, revision) : null, notice: current.notice };
}

/** A variable a person asked to remove, as the delete list it is sent as, or the reason it is not one. */
export function workflowVariableRemoval(key) {
    const name = typeof key === "string" ? key : "";
    if (name.length < 1 || name.length > KV_KEY_MAX) return { ok: false, error: `Name the variable to remove (1 to ${KV_KEY_MAX} characters).` };
    return { ok: true, delete: [name] };
}

/**
 * The names a JSON object's text gives more than once at its top level, in order (JSON.parse keeps only the last of
 * them). `source` is the text of a valid JSON object.
 */
function repeatedNames(source) {
    const seen = new Set();
    const repeated = [];
    let depth = 0;
    for (let at = 0; at < source.length; at++) {
        const char = source[at];
        if (char === "{" || char === "[") depth++;
        else if (char === "}" || char === "]") depth--;
        else if (char === "\"") {
            let end = at + 1;
            while (end < source.length && source[end] !== "\"") end += source[end] === "\\" ? 2 : 1;
            let next = end + 1;
            while (next < source.length && " \t\n\r".includes(source[next])) next++;
            // A string directly inside the top-level object and followed by ":" is one of its names.
            if (depth === 1 && source[next] === ":") {
                const name = JSON.parse(source.slice(at, end + 1));
                if (seen.has(name) && !repeated.includes(name)) repeated.push(name);
                seen.add(name);
            }
            at = end;
        }
    }
    return repeated;
}

/** A JSON text a person typed, parsed, or the reason it does not parse (`label` names the field). */
function parsedJson(source, label) {
    try {
        return { ok: true, value: JSON.parse(source) };
    } catch (error) {
        return { ok: false, error: `${label}: ${bounded(String(error?.message || error))}` };
    }
}

/**
 * Several variables a person typed for one update of a run (set_vars as one batch, design 02 open KV), as the `set`
 * map and `delete` list it is sent as, or the reason it is not one. `setText` is a JSON object of names and their JSON
 * values: each name gets its value whole (a new name is added, a value it has is replaced, not merged; null is a
 * value). `removeText` is a JSON list of the names to remove. Either may be empty, not both. Each name is 1 to 128
 * characters, kept exactly as typed and named once: twice in the object (JSON keeps only the last), twice in the list,
 * or in both is refused rather than guessed. Every variable not named stays as it is, and the server applies the whole
 * update at the revision the person saw, or none of it, checking it again.
 */
export function workflowVariableBatchDraft(setText, removeText) {
    const setSource = typeof setText === "string" ? setText : "";
    const removeSource = typeof removeText === "string" ? removeText : "";
    let set = {};
    if (setSource.trim()) {
        const parsed = parsedJson(setSource, "Set must be a JSON object of names and values");
        if (!parsed.ok) return parsed;
        if (!isRecord(parsed.value)) return { ok: false, error: "Set must be a JSON object of names and values, for example {\"limit\": 5, \"mode\": \"fast\"}." };
        const repeated = repeatedNames(setSource);
        if (repeated.length) return { ok: false, error: `Set names ${keyNames(repeated)} more than once; give each name once.` };
        set = parsed.value;
    }
    let removed = [];
    if (removeSource.trim()) {
        const parsed = parsedJson(removeSource, "Remove must be a JSON list of names");
        if (!parsed.ok) return parsed;
        if (!Array.isArray(parsed.value) || parsed.value.some(name => typeof name !== "string")) {
            return { ok: false, error: "Remove must be a JSON list of names, for example [\"old\", \"stale key\"]." };
        }
        const twice = [...new Set(parsed.value.filter((name, index) => parsed.value.indexOf(name) !== index))];
        if (twice.length) return { ok: false, error: `Remove lists ${keyNames(twice)} more than once; give each name once.` };
        removed = parsed.value;
    }
    const names = [...Object.keys(set), ...removed];
    if (!names.length) return { ok: false, error: "Nothing to update: set at least one variable or remove one." };
    if (names.some(name => name.length < 1)) return { ok: false, error: `Each name is 1 to ${KV_KEY_MAX} characters; an empty name is not one.` };
    const long = names.find(name => name.length > KV_KEY_MAX);
    if (long !== undefined) return { ok: false, error: `Each name is 1 to ${KV_KEY_MAX} characters; ${keyNames([long])} has ${long.length}.` };
    const both = removed.filter(name => Object.hasOwn(set, name));
    if (both.length) return { ok: false, error: `${keyNames(both)} ${both.length > 1 ? "are" : "is"} both set and removed; give each name once.` };
    return { ok: true, set, delete: removed };
}

/** The list of variables from the read model's preview of them (canonical JSON of the whole map, cut at 4,000 characters). */
function variablesOf(kv) {
    const unreadable = { entries: [], complete: false, preview: null, note: "The variables could not be read." };
    if (typeof kv !== "string") return unreadable;
    // A whole map ends with "}", so a preview that ends with "…" was cut short.
    if (kv.endsWith("…")) {
        return { entries: [], complete: false, preview: kv,
            note: "The variables are longer than this view, so only their start is shown. A variable you name can still be set or removed." };
    }
    let parsed;
    try {
        parsed = JSON.parse(kv);
    } catch {
        return { ...unreadable, preview: kv };
    }
    if (!isRecord(parsed)) return { ...unreadable, preview: kv };
    const entries = Object.keys(parsed).map(key => {
        const valueText = JSON.stringify(parsed[key]);
        return { key, valueText, displayText: valueText.length > VALUE_DISPLAY_LIMIT ? `${valueText.slice(0, VALUE_DISPLAY_LIMIT - 1)}…` : valueText };
    });
    return { entries, complete: true, preview: null, note: entries.length ? null : "No variables yet." };
}

/**
 * The run's variables (its open KV; R04, R05; mock M15) as the view lists
 * them and a person changes them, given the view's last command, or null:
 * without `personCommands` (the deployment takes no person's commands: the
 * view stays as it was) or without a run. Never throws.
 *
 * The list comes from the read model (`run.kv`, `run.kvRevision`); a person
 * may change it (`editable`) when the workflow takes set_vars from people
 * (never in a workflow agent state's subtree), the run has not ended, the
 * viewer may command the workflow and the revision is known; otherwise
 * `reason` says why. While a command is being sent (`busy`) nothing else is
 * sent; `pending` marks a variables update of this run in flight.
 */
export function workflowRunVariables(model, command = null) {
    if (!isRecord(model) || !isRecord(model.personCommands) || !isRecord(model.run)) return null;
    const run = model.run;
    if (typeof run.runId !== "string" || !run.runId || (!ACTIVE.has(run.status) && !ENDED.has(run.status))) return null;
    const commands = model.personCommands;
    const offered = Array.isArray(commands.operations) && commands.operations.includes("set_vars");
    const viewer = isRecord(commands.viewer) ? commands.viewer : null;
    const denied = viewer?.allowed === false ? text(viewer.reason) ?? "You cannot command this Workflow." : null;
    const revision = Number.isSafeInteger(run.kvRevision) && run.kvRevision >= 1 ? run.kvRevision : null;
    const reason = !offered ? restrictionText(commands) ?? "This Workflow does not take variable changes from people."
        : !ACTIVE.has(run.status) ? "This Workflow has ended; its variables no longer change."
            : denied ?? (revision === null ? "The variables' revision is not known, so they cannot be changed here. Read the Workflow again." : null);
    const busy = isRecord(command) && command.phase === "pending";
    return { runId: run.runId, revision, ...variablesOf(run.kv), editable: reason === null, reason, busy,
        pending: busy && command.operation === "set_vars" && command.runId === run.runId };
}

/**
 * A JSON object a person typed for a run's inputs or initial variables, or
 * the reason it is not one. Empty text is `{}` for inputs and nothing (the
 * field is left out) when `optional`.
 */
export function workflowJsonObjectDraft(source, { label = "The value", optional = false } = {}) {
    const textValue = typeof source === "string" ? source : "";
    if (!textValue.trim()) return optional ? { ok: true, value: undefined } : { ok: true, value: {} };
    let parsed;
    try {
        parsed = JSON.parse(textValue);
    } catch (error) {
        return { ok: false, error: `${label} must be a JSON object: ${bounded(String(error?.message || error))}` };
    }
    return isRecord(parsed) ? { ok: true, value: parsed } : { ok: false, error: `${label} must be a JSON object, for example {"repo": "name"}.` };
}

/**
 * The definition's publication controls (design 04 publish and start; mocks
 * M01 and M03; R17, R18, R26) given the view's last command, or null: without
 * `personCommands` (the deployment takes no person's commands: the view stays
 * as it was) or without a definition in a recognized state. Never throws.
 *
 * A draft offers Publish (the exact revision shown, with its definition hash)
 * and Publish and start (the same, then its live run with the inputs given);
 * a published definition without its live run offers Start (the published
 * revision's hash). Only commands the workflow takes from people are listed:
 * a workflow in a workflow agent state's subtree takes none of them, and
 * `restriction` says why. A control is disabled, with the reason as its
 * title, for a revision with compile errors, a viewer who may not command the
 * workflow, a revision or hash the read model does not give, and while a
 * command is being sent. The server checks the revision and hash again and
 * refuses a stale publish; publishing freezes the revision.
 */
export function workflowDefinitionControls(model, command = null) {
    if (!isRecord(model) || !isRecord(model.personCommands) || !isRecord(model.definition) || !isRecord(model.revision)) return null;
    const definition = model.definition;
    const state = definition.state === "draft" || definition.state === "published" ? definition.state : null;
    if (state === null) return null;
    const commands = model.personCommands;
    const offered = new Set(Array.isArray(commands.operations) ? commands.operations.filter(item => typeof item === "string") : []);
    const viewer = isRecord(commands.viewer) ? commands.viewer : null;
    const denied = viewer?.allowed === false ? text(viewer.reason) ?? "You cannot command this Workflow." : null;
    const busy = isRecord(command) && command.phase === "pending";
    const liveRun = Array.isArray(model.runs) && model.runs.some(run => isRecord(run) && run.mode === "live");
    const revision = Number.isSafeInteger(model.revision.revision) && model.revision.revision >= 1 ? model.revision.revision : null;
    const definitionHash = text(model.revision.definitionHash);
    const publishedRevision = Number.isSafeInteger(definition.publishedRevision) ? definition.publishedRevision : null;
    const publishedDefinitionHash = text(definition.publishedDefinitionHash);
    const valid = model.revision.valid === true;
    const errors = Array.isArray(model.revision.diagnostics)
        ? model.revision.diagnostics.filter(item => isRecord(item) && item.severity !== "warning").length : 0;
    const candidates = state === "draft" ? ["publish", "publish_and_start"] : liveRun ? [] : ["start"];
    const controls = candidates.filter(operation => offered.has(operation)).map(operation => {
        const pending = busy && command.operation === operation;
        const known = operation === "start" ? publishedDefinitionHash !== null : revision !== null && definitionHash !== null;
        const reason = busy ? (pending ? "This command is being sent." : "Another command for this Workflow is being sent.")
            : denied ?? (operation !== "start" && !valid ? `Revision ${revision ?? "shown"} has ${errors || "unlisted"} error${errors === 1 ? "" : "s"} and cannot be started; fix them first.`
                : !known ? "The revision or its definition hash is not known; read the workflow again." : null);
        const label = operation === "publish" ? "Publish only" : operation === "publish_and_start" ? "Publish and start" : "Start live run";
        return { operation, label: pending ? (operation === "start" ? "Starting…" : "Publishing…") : label, enabled: reason === null, pending,
            title: reason ?? (operation === "publish" ? "Publish this exact revision. It no longer changes afterwards; no run starts."
                : operation === "publish_and_start" ? "Publish this exact revision and start its live run with the inputs given. The live run's effects are real."
                    : "Start the live run of the published revision with the inputs given. The live run's effects are real.") };
    });
    const restriction = restrictionText(commands);
    const note = controls.length ? null
        : restriction ?? (state === "published" && liveRun ? "This workflow has its live run; a new live run needs a new workflow."
            : "This workflow takes no publication commands from people.");
    const evidence = publicationEvidence(model, state, state === "draft" ? revision : publishedRevision, publishedRevision);
    return { state, name: text(model.revision.name), semver: text(definition.semver), revision, definitionHash, valid, errors,
        publishedRevision, publishedDefinitionHash, liveRun, controls, busy, note, viewerReason: denied, ...evidence,
        // The inputs a start of the reviewed revision is checked against (f-05): the draft's revision, or the published one.
        inputsSchema: revisionInputsSchema(model, state === "draft" ? revision : publishedRevision) };
}

/**
 * What a publication review shows beside the revision (mock M03 "Pinned package", "Required test evidence"; R18, R28):
 * each named agent state with the agent it names as written and, for a published definition, what publication pinned
 * (`agents`: { stateId, task, rows }); and the test runs of exactly the revision reviewed (`tests`: { runId, status,
 * outcome }), shown as information: publishing requires no test. Read from the model only; nothing is resolved.
 */
function publicationEvidence(model, state, reviewedRevision, publishedRevision) {
    const graph = isRecord(model.graph) && Array.isArray(model.graph.states) ? model.graph : null;
    const pins = state === "published" && isRecord(model.definition.publishedAgentPins) && graph?.revision === publishedRevision
        ? { by: "publication", pins: model.definition.publishedAgentPins } : null;
    const agents = (graph ? graph.states : []).filter(node => isRecord(node) && node.type === "agent" && node.invoke?.source === "agent")
        .map(node => ({ stateId: node.id, task: workflowAgentTask(node), rows: workflowAgentBindingRows(workflowAgentBinding(node, pins)) }));
    const tests = reviewedRevision === null || !Array.isArray(model.runs) ? []
        : model.runs.filter(run => isRecord(run) && run.mode === "test" && run.revision === reviewedRevision && typeof run.runId === "string")
            .map(run => ({ runId: run.runId, status: text(run.status) ?? "unknown", outcome: text(run.outcome) }));
    return { agents, tests, graphKnown: graph !== null };
}

/**
 * The publication review's evidence rows, `[label, value]`, in the same words in the portal and the TUI: each named
 * agent and what is pinned for it, and the tests of exactly this revision (information only: publishing requires none).
 * For a draft, `versionsNow` (the view's `agentVersions`: the agent-versions read, controller.loadWorkflowAgentVersions)
 * adds what publishing would lock now (owner decision q1): each agent's package, version and exact revision, or the
 * problem that would refuse the publication, once it is read for exactly the revision and hash reviewed.
 */
export function workflowPublicationEvidenceRows(publication, versionsNow = null) {
    if (!isRecord(publication)) return [];
    const draft = publication.state === "draft";
    const now = draft ? publicationVersionsNow(publication, versionsNow) : null;
    const rows = [];
    if (!publication.graphKnown) rows.push(["Agents", "Not known: the revision has no graph to read"]);
    else if (!publication.agents?.length) rows.push(["Agents", "None: no node runs a named agent"]);
    else if (now?.problem) rows.push(["Start would be refused", now.problem]);
    else if (now?.note) rows.push(["Agent versions", now.note]);
    for (const agent of publication.agents ?? []) {
        const pin = agent.rows.find(([label]) => label === "Pinned");
        const lockedNow = now?.byState?.[agent.stateId];
        // Plain words (spec draft 3; review UI-4): Start locks the version; there is no separate publishing step.
        const draftText = lockedNow ? ` · version now: ${lockedNow}; Start locks it`
            : now?.agentText ?? " · its exact package revision is locked when this revision starts";
        rows.push([`Agent in '${agent.stateId}'`, `${agent.task}${draft ? draftText : pin ? ` · pinned: ${pin[1]}` : " · no pin recorded"}`]);
        for (const [label, value] of agent.rows) if (label !== "Pinned") rows.push([`  ${label}`, value]);
    }
    // A revision's test runs exist only where test mode is on (hidden by default, spec 16): no row without them.
    const tests = publication.tests ?? [];
    // Review 19:27Z: each test by its state in words, never its run id.
    if (tests.length) rows.push(["Tests of this revision", tests.map(run => `${workflowRunStateWord(run.status) ?? "Not certain"}${run.outcome ? ` · ${workflowOutcomeWord(run.outcome)}` : ""}`).join("; ")]);
    return rows;
}

/**
 * What the agent-versions read says about the draft a publication review shows, or null when it was not read for that
 * revision and hash: `agentText` while it is read or after it failed, `note` when the deployment locks no versions,
 * `problem` when publishing would be refused, else `byState` (state id -> the version publishing would lock).
 */
function publicationVersionsNow(publication, versionsNow) {
    if (!isRecord(versionsNow) || versionsNow.revision !== publication.revision) return null;
    if (versionsNow.phase === "loading") return { agentText: " · reading the version Start would lock…" };
    if (versionsNow.phase === "failed") return { agentText: ` · the version now could not be read: ${text(versionsNow.error) ?? "no reason given"}` };
    const value = isRecord(versionsNow.value) ? versionsNow.value : null;
    if (!value || value.revision !== publication.revision || value.definitionHash !== publication.definitionHash) return null;
    if (value.resolves === false) {
        return { note: "This deployment locks no agent versions at Start: each agent step uses the version current when it starts." };
    }
    if (isRecord(value.problem)) return { problem: text(value.problem.message) ?? text(value.problem.code) ?? "An agent cannot be used.", agentText: "" };
    const byState = {};
    for (const pin of Array.isArray(value.agents) ? value.agents : []) {
        if (isRecord(pin) && typeof pin.stateId === "string") byState[pin.stateId] = agentVersionText(pin);
    }
    return { byState };
}

/** One agent version as the review says it: its package and version (or a deployment agent), its exact revision, a matched interface. */
function agentVersionText(pin) {
    const where = text(pin.package) ? `${pin.package}${text(pin.version) ? ` ${pin.version}` : ""}` : `deployment agent ${text(pin.name) ?? ""}`.trim();
    const revision = text(pin.revision) ? ` (revision ${pin.revision.slice(0, 12)})` : "";
    const matched = isRecord(pin.interface) && text(pin.interface.name) ? ` · interface ${pin.interface.name}@${pin.interface.version}` : "";
    return `${where}${revision}${matched}`;
}

/**
 * Whether a screen shows test runs of this workflow (Workflow Simplified, spec 16: test mode is hidden unless the
 * deployment turns it on). Review UI-5: only the server's explicit word decides, independent of what commands the reader
 * may send: the read model's `testMode: true`, which a server sends only while its test mode is on (and its reads then
 * list test runs). Absent, false or anything else: hidden, also for a commandless or restricted read. Never throws.
 */
export function workflowTestRunsShown(model) {
    return isRecord(model) && model.testMode === true;
}

/**
 * Whether the server lists a test operation for this workflow (its test mode is on and the workflow takes tests from
 * people): only then does the terminal UI take its test keys (t, a, +); otherwise they do nothing (spec 16). Never throws.
 */
export function workflowTestModeListed(model) {
    const operations = isRecord(model) && isRecord(model.personCommands) && Array.isArray(model.personCommands.operations)
        ? model.personCommands.operations : [];
    return operations.some(operation => operation === "test" || operation === "test_respond" || operation === "test_advance");
}

/**
 * The test review (design 05; mocks M18 to M20; R19, R20, R26, R28) given the
 * view's last command, or null: without `personCommands` (the deployment
 * takes no person's commands), when the workflow takes no test from people (a
 * workflow agent state's subtree, or test mode off), and unless the definition is a draft (of-06, the owner's decision:
 * a published workflow is not tested). Never throws.
 *
 * A test runs the exact current revision of the draft with its definition
 * hash. Start is disabled, with the reason as its title, for a revision with
 * compile errors, a viewer who may not command the workflow, an unknown
 * revision or hash, and while a command is being sent.
 */
export function workflowTestControls(model, command = null) {
    if (!isRecord(model) || !isRecord(model.personCommands) || !isRecord(model.definition) || !isRecord(model.revision)) return null;
    const state = model.definition.state === "draft" ? "draft" : null;
    const commands = model.personCommands;
    if (state === null || !Array.isArray(commands.operations) || !commands.operations.includes("test")) return null;
    const viewer = isRecord(commands.viewer) ? commands.viewer : null;
    const denied = viewer?.allowed === false ? text(viewer.reason) ?? "You cannot command this Workflow." : null;
    const busy = isRecord(command) && command.phase === "pending";
    const pending = busy && command.operation === "test";
    const revision = Number.isSafeInteger(model.revision.revision) && model.revision.revision >= 1 ? model.revision.revision : null;
    const definitionHash = text(model.revision.definitionHash);
    const valid = model.revision.valid === true;
    const errors = Array.isArray(model.revision.diagnostics)
        ? model.revision.diagnostics.filter(item => isRecord(item) && item.severity !== "warning").length : 0;
    const reason = busy ? (pending ? "This command is being sent." : "Another command for this Workflow is being sent.")
        : denied ?? (!valid ? `Revision ${revision ?? "shown"} has ${errors || "unlisted"} error${errors === 1 ? "" : "s"} and cannot be tested; fix them first.`
            : revision === null || definitionHash === null ? "The revision or its definition hash is not known; read the workflow again." : null);
    return { state, name: text(model.revision.name), semver: text(model.definition.semver), revision, definitionHash, valid, errors,
        control: { operation: "test", label: pending ? "Starting test…" : "Start test", enabled: reason === null, pending,
            title: reason ?? `Test draft revision ${revision}.` },
        busy, viewerReason: denied, inputsSchema: revisionInputsSchema(model, revision) };
}

/**
 * The input schema of exactly `revision`, its references resolved, as the read model's graph gives it (batch 7, f-05:
 * graph.inputsSchema, of the revision the graph shows); null when the graph is of another revision or has none.
 */
function revisionInputsSchema(model, revision) {
    const graph = isRecord(model?.graph) ? model.graph : null;
    if (!graph || revision === null || graph.revision !== revision || !Object.hasOwn(graph, "inputsSchema")) return null;
    const schema = graph.inputsSchema;
    return isRecord(schema) || typeof schema === "boolean" ? schema : null;
}

/** A scenario name a person typed for a test: absent when empty, else 1 to 128 characters kept as typed. */
export function workflowScenarioDraft(source) {
    const name = typeof source === "string" ? source : "";
    if (!name.trim()) return { ok: true, value: undefined };
    return name.length > SCENARIO_MAX ? { ok: false, error: `A scenario name is at most ${SCENARIO_MAX} characters.` } : { ok: true, value: name };
}

/**
 * A test run's answers and clock (design 05; mocks M18 and M19; R19, R20,
 * R26) given the view's last command, or null: without `personCommands`
 * listing test_respond or test_advance (test mode off, or a workflow agent
 * state's subtree), or unless the read model shows a test
 * run. `waiting` lists the run's held calls that wait for an answer
 * (`awaiting_parent`), with what the answer must match. `respond` and
 * `advance` say whether a person may answer and move the virtual clock now:
 * not once the run has ended, and not for a viewer who may not command the
 * workflow (`reason` says why). While a command is being sent (`busy`)
 * nothing else is sent.
 */
export function workflowTestResponder(model, command = null) {
    if (!isRecord(model) || !isRecord(model.personCommands) || !isRecord(model.run) || model.run.mode !== "test" || !isRecord(model.run.test)) return null;
    const operations = Array.isArray(model.personCommands.operations) ? model.personCommands.operations : [];
    const respond = operations.includes("test_respond"), advance = operations.includes("test_advance");
    if (!respond && !advance) return null;
    const run = model.run;
    if (typeof run.runId !== "string" || !run.runId) return null;
    const viewer = isRecord(model.personCommands.viewer) ? model.personCommands.viewer : null;
    const denied = viewer?.allowed === false ? text(viewer.reason) ?? "You cannot command this Workflow." : null;
    const reason = !ACTIVE.has(run.status) ? `This test has ended: ${workflowRunStateWord(run.status) ?? "Not certain"}; its calls stay unanswered.` : denied;
    const states = Array.isArray(model.graph?.states) ? model.graph.states : [];
    // The run's interceptions as one list: its newest page and the waiting ones the page does not hold (workflowRunRows).
    const waiting = workflowRunRows(run).interceptions
        .filter(item => isRecord(item) && item.state === "awaiting_parent" && typeof item.interceptionId === "string" && item.interceptionId)
        .map(item => {
            const state = states.find(entry => isRecord(entry) && entry.id === item.stateId);
            return { interceptionId: item.interceptionId, operation: text(item.operation) ?? "tool.call", tool: text(item.tool), stateId: text(item.stateId),
                arguments: item.arguments ?? null, responseSchema: item.responseSchema ?? null, virtualAt: text(item.virtualAt),
                outcomes: Array.isArray(state?.outcomes) ? state.outcomes.filter(outcome => typeof outcome === "string") : [] };
        });
    const busy = isRecord(command) && command.phase === "pending";
    const elapsed = run.test.virtualClock?.elapsedSeconds;
    return { runId: run.runId, respond: respond && reason === null, advance: advance && reason === null, waiting, reason, busy,
        pending: busy && command.runId === run.runId ? command.operation : null, elapsedSeconds: Number.isSafeInteger(elapsed) ? elapsed : null };
}

/**
 * A first answer to edit for a waiting interception: an agent state's typed
 * result ({ outcome, output }, with its first outcome), a request's response
 * ({ response }), and null for a tool call or a send.
 */
export function workflowTestAnswerTemplate(waiting) {
    if (waiting?.operation === "agent") return JSON.stringify({ outcome: waiting.outcomes?.[0] ?? "", output: null });
    if (waiting?.operation === "request") return JSON.stringify({ response: null });
    return "null";
}

/**
 * An answer a person typed, as the test_respond response it is sent as, or
 * the reason it is not one: success with any JSON value, error with
 * { code, message, details? } (a message of 1 to 4,000 characters; the code
 * a runtime error code for an agent, send or request), or cancel with no
 * value. The server checks the answer against the effect's contract
 * (TEST_RESPONSE_INVALID, with its problems) and records it once.
 */
export function workflowTestResponseDraft(kind, source) {
    if (!RESPONSE_KINDS.has(kind)) return { ok: false, error: "Choose success, error or cancel." };
    if (kind === "cancel") return { ok: true, response: { kind } };
    const textValue = typeof source === "string" ? source : "";
    if (!textValue.trim()) return { ok: false, error: "Give the answer as JSON (null is a value)." };
    let value;
    try {
        value = JSON.parse(textValue);
    } catch (error) {
        return { ok: false, error: `The answer must be JSON: ${bounded(String(error?.message || error))}` };
    }
    if (kind === "error" && (!isRecord(value) || typeof value.message !== "string" || !value.message.trim() || value.message.length > 4_000)) {
        return { ok: false, error: "An error answer is { \"code\", \"message\", \"details\"? } with a message of 1 to 4,000 characters." };
    }
    return { ok: true, response: { kind, value } };
}

/** Seconds a person typed for a virtual clock advance: an integer from 1 to 30 days. */
export function workflowAdvanceDraft(source) {
    const seconds = Number(typeof source === "string" ? source.trim() : source);
    return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= ADVANCE_MAX_SECONDS
        ? { ok: true, seconds } : { ok: false, error: `Advance by a whole number of seconds from 1 to ${ADVANCE_MAX_SECONDS}.` };
}

/**
 * The draft editor (design 04 replace_definition; mocks M01 and M02; R03,
 * R17, R26) given the view's last command, or null: without
 * `personCommands.draft` (the deployment takes no person's commands, the
 * definition is published, the workflow is in a workflow agent state's
 * subtree, or the caller may not change it: the portal leaves the YAML out)
 * or when it does not name the definition's current revision. Never throws.
 * `revision` and `yaml` are the current revision's: an edit starts from
 * them and is saved at the revision it started from, so a draft another
 * person changed meanwhile is refused (409 REVISION_CONFLICT), not
 * overwritten. While a command is being sent (`busy`) nothing else is sent.
 */
export function workflowDraftEditor(model, command = null) {
    if (!isRecord(model) || !isRecord(model.personCommands) || !isRecord(model.personCommands.draft) || !isRecord(model.definition)) return null;
    const draft = model.personCommands.draft;
    if (model.definition.state !== "draft" || !Number.isSafeInteger(draft.revision) || typeof draft.yaml !== "string") return null;
    const offered = Array.isArray(model.personCommands.operations) && model.personCommands.operations.includes("replace_definition");
    if (!offered) return null;
    const busy = isRecord(command) && command.phase === "pending";
    // The diagnostics of exactly the revision the editor holds (the read model's current revision), for its marks (q5).
    const diagnostics = isRecord(model.revision) && model.revision.revision === draft.revision && Array.isArray(model.revision.diagnostics)
        ? model.revision.diagnostics.filter(isRecord) : [];
    return { revision: draft.revision, definitionHash: text(draft.definitionHash), yaml: draft.yaml, semver: text(model.definition.semver),
        current: draft.revision === model.definition.currentRevision, busy, pending: busy && command.operation === "replace_definition", diagnostics };
}

/**
 * The draft editor's marks (owner decision q5): the diagnostics of the revision being edited that name a line, one entry
 * per line in line order, and how many name no line (`unplaced`). An entry: { line, severity: "error" when any of its
 * diagnostics is one, else "warning", texts, codes }. `texts` are the words a person reads, as the diagnostics list says
 * them (WorkflowDiagnostics: "Warning: " before a warning, then the message; the line is the mark's own "Line N").
 * UXP-GEM-05: the code is not among them; `codes` holds each one's code and path ("CODE · path", or "" when it has
 * neither), for the tooltip only, as that list's. Marks belong to the saved revision: an edit does not move them, and
 * saving checks the new text. Pure.
 */
export function workflowDraftMarks(diagnostics) {
    const byLine = new Map();
    let unplaced = 0;
    for (const item of Array.isArray(diagnostics) ? diagnostics : []) {
        if (!isRecord(item)) continue;
        if (!Number.isSafeInteger(item.line) || item.line < 1) { unplaced += 1; continue; }
        const entry = byLine.get(item.line) ?? { line: item.line, severity: "warning", texts: [], codes: [] };
        if (item.severity !== "warning") entry.severity = "error";
        entry.texts.push(`${item.severity === "warning" ? "Warning: " : ""}${text(item.message) ?? "No message."}`);
        entry.codes.push([text(item.code), text(item.path)].filter(Boolean).join(" · "));
        byLine.set(item.line, entry);
    }
    return { lines: [...byLine.values()].sort((a, b) => a.line - b.line), unplaced };
}

/**
 * What a person's edit is, against the revision it started from (`base`:
 * { revision, yaml }) and the draft the read model shows now (`model`, the
 * editor model): unchanged, changed, or in conflict (the draft moved on to
 * another revision while it was edited; saving would be refused). Saving
 * needs text, a change and no conflict; the text is at most 256 KiB.
 */
export function workflowDraftEdit(base, textValue, model) {
    const edited = typeof textValue === "string" ? textValue : "";
    const changed = isRecord(base) && edited !== base.yaml;
    const conflict = Boolean(isRecord(base) && isRecord(model) && model.revision !== base.revision);
    const bytes = new TextEncoder().encode(edited).length;
    const reason = !edited.trim() ? "The YAML is empty."
        : bytes > YAML_MAX_BYTES ? `The YAML is ${bytes} bytes; a workflow is at most ${YAML_MAX_BYTES}.`
            : conflict ? `The draft is now at revision ${model.revision}; this edit started from revision ${base.revision}. Load revision ${model.revision}, or keep your edits on it, before saving.`
                : !changed ? "Nothing changed." : null;
    return { changed, conflict, canSave: reason === null && !model?.busy, reason };
}

/**
 * The confirm dialog of a command that ends work or loses data, or null for
 * one that needs none: stop and cancel (mock M16: neither undoes effects
 * that already happened), and a variables update that removes keys (with
 * the keys it also sets, when it is one update of several).
 */
export function workflowRunCommandConfirm(operation, runId, args = null) {
    // Review 19:10Z (D-W10): a Workflow has one live run, so a confirm names none; a stop either way ends as Canceled.
    if (operation === "set_vars") {
        const removed = Array.isArray(args?.delete) ? args.delete : [];
        if (!removed.length) return null;
        const set = isRecord(args?.set) ? Object.keys(args.set) : [];
        if (set.length) {
            return { title: "Update Workflow Variables", confirmLabel: "Update",
                message: `In one update of the variables, set ${keyNames(set)} and remove ${keyNames(removed)}? Every other variable stays as it is. Nodes that start from now on see the update; started nodes keep the values they started with.` };
        }
        const plural = removed.length > 1;
        return { title: plural ? "Remove Workflow Variables" : "Remove Workflow Variable", confirmLabel: "Remove",
            message: `Remove ${keyNames(removed)} from the variables? Nodes that start from now on do not see ${plural ? "them" : "it"}; started nodes keep the values they started with.` };
    }
    if (operation === "stop") {
        return { title: "Stop Workflow", confirmLabel: "Stop",
            message: "Let started nodes finish, then cancel? No new node starts; started nodes get up to 60 s, and then it ends as Canceled. A stop does not undo effects that already happened." };
    }
    if (operation === "cancel") {
        return { title: "Cancel Workflow", confirmLabel: "Cancel now",
            message: "Cancel now? Started nodes are canceled, and it ends as Canceled. A cancel does not undo effects that already happened." };
    }
    return null;
}

/**
 * The status line for an accepted control. An accepted stop or cancel is a
 * request the run's controller applies; the run's own status says when it
 * has ended.
 */
export function workflowRunCommandAccepted(operation, runId, receipt, args = null) {
    const again = isRecord(receipt) && receipt.replayed === true ? " It had already been accepted." : "";
    const status = isRecord(receipt) ? text(receipt.status) : null;
    if (operation === "approval_respond") return `Approval answer accepted: ${receipt?.decision === "rejected" ? "rejected" : "approved"}.${again}`;
    if (operation === "replace_definition") {
        const saved = isRecord(receipt) && Number.isSafeInteger(receipt.revision) ? `revision ${receipt.revision}` : "a new revision";
        const errors = isRecord(receipt) && Array.isArray(receipt.diagnostics)
            ? receipt.diagnostics.filter(item => isRecord(item) && item.severity !== "warning").length : 0;
        const valid = isRecord(receipt) && receipt.valid === false
            ? ` It has ${errors || "unlisted"} error${errors === 1 ? "" : "s"}, so it cannot be started until they are fixed.` : "";
        // Review UI-F6: the words people see: a definition is saved and started, not drafted or published.
        return `Saved the definition as ${saved}.${valid}${again}`;
    }
    if (operation === "test_respond") {
        const node = isRecord(receipt?.node) ? receipt.node : null;
        const decided = node && node.state !== "pending" && text(node.outcome)
            ? ` Node ${text(node.stateId) ?? "?"} ended · ${workflowOutcomeWord(node.outcome)}.` : "";
        return `Test answer accepted.${decided}${again}`;
    }
    if (operation === "test_advance") {
        const seconds = isRecord(receipt) && Number.isSafeInteger(receipt.seconds) ? receipt.seconds : args?.seconds;
        const count = isRecord(receipt) && Array.isArray(receipt.decided) ? receipt.decided.length : 0;
        return `Test clock advanced ${seconds} s · ${count} deadline${count === 1 ? "" : "s"} came due. Script clocks are real.${again}`;
    }
    if (operation === "test") {
        const tested = isRecord(receipt) && Number.isSafeInteger(receipt.revision) ? receipt.revision : args?.expectedRevision;
        const agents = args?.agentMode === "real" ? "real agents, which spend model tokens" : "mocked agents";
        return `Test started · revision ${tested ?? "shown"} · ${agents}. A test result is not evidence that the definition is safe to run live.${again}`;
    }
    if (DEFINITION_OPERATIONS.has(operation)) {
        const published = isRecord(receipt) && Number.isSafeInteger(receipt.publishedRevision) ? receipt.publishedRevision : args?.expectedRevision;
        const revision = Number.isSafeInteger(published) ? `revision ${published}` : "the revision";
        if (operation === "publish") return `Published ${revision}. It no longer changes; its live run starts only when someone starts it.${again}`;
        // Review UI-D11: Start in the words people see (spec draft 3: no publish step is shown).
        // Review 19:10Z (D-W10): no run id.
        return `Started ${revision}.${again}`;
    }
    if (operation === "set_vars") {
        const set = isRecord(args?.set) ? Object.keys(args.set) : [];
        const removed = Array.isArray(args?.delete) ? args.delete : [];
        const parts = [set.length ? `set ${keyNames(set)}` : "", removed.length ? `removed ${keyNames(removed)}` : ""].filter(Boolean).join(" · ");
        const revision = isRecord(receipt) && Number.isSafeInteger(receipt.kvRevision) ? ` · revision ${receipt.kvRevision}` : "";
        return `Variables updated${parts ? ` · ${parts}` : ""}${revision}. Nodes that start from now on see them.${again}`;
    }
    // OF-S2-2 part 2 (D-W10): a Workflow has one live run, so its receipts name none; accepted, not yet applied.
    if (operation === "pause") return `Pause accepted: no new node starts; started nodes finish.${again}`;
    if (operation === "resume") return `Resume accepted.${again}`;
    // Review 19:10Z: accepted, not yet applied; a stop either way ends as Canceled.
    if (operation === "stop") return `Stop accepted: no new node starts; it ends as Canceled when started nodes finish.${again}`;
    return `Cancel accepted: it ends as Canceled once applied.${again}`;
}

/** Approval controls require the server's per-caller answer for this exact visit, never management access alone. */
export function workflowApprovalView(model, execution) {
    const approval = isRecord(execution?.approval) ? execution.approval : null;
    if (!approval) return null;
    const command = Array.isArray(model?.personCommands?.approvals)
        ? model.personCommands.approvals.find(item => item.approvalId === approval.approvalId && item.runId === model?.run?.runId) : null;
    const mayAnswer = command?.mayAnswer === true && model?.personCommands?.operations?.includes("approval_respond") === true
        && approval.status === "pending";
    return { ...approval, runId: model?.run?.runId ?? null, mayAnswer,
        answerReason: mayAnswer ? null : text(command?.reason) ?? "Read and answer this approval directly in the portal as its pinned owner.",
        ownerLabel: text(approval.owner?.displayName) ?? "Workflow owner" };
}

/**
 * How a failed send is recorded: a refusal (a 4xx answer, or 501 from a
 * deployment that takes no person's commands: the server decided, and
 * nothing changed) is "failed"; anything else (no answer, or a server
 * failure that may have come after the command was stored) is
 * "unconfirmed", and sending the same control again reuses the operation
 * id, so the server answers with the first command's receipt rather than
 * applying it twice.
 */
export function workflowRunCommandFailure(error) {
    const status = Number(error?.status);
    const refused = Number.isSafeInteger(status) && ((status >= 400 && status < 500) || status === 501);
    // A contract's refusal lists its problems (WORKFLOW_INPUT_INVALID: a list; TEST_RESPONSE_INVALID: { problems }, or the
    // state's outcomes); the first few are shown with it.
    const listed = (Array.isArray(error?.details) ? error.details : Array.isArray(error?.details?.problems) ? error.details.problems : [])
        .filter(item => isRecord(item) && typeof item.message === "string" && item.message.trim());
    const shown = listed.slice(0, 3);
    const problems = shown.map(workflowProblemText);
    const more = listed.length > shown.length ? `and ${listed.length - shown.length} more` : "";
    if (!problems.length && Array.isArray(error?.details?.outcomes)) {
        problems.push(`Its outcomes are ${error.details.outcomes.filter(item => typeof item === "string").join(", ")}`);
    }
    const code = typeof error?.code === "string" ? error.code : null;
    // UXFD (C): inputs that do not match the inputs schema say only what is wrong, in the server's plain words
    // ("Start refused: model is required; sessions needs at least 6 items."), without the schema's name or any JSON.
    const plain = code === "WORKFLOW_INPUT_INVALID" && shown.length > 0 && shown.every(item => !AJV_WORDS.test(item.message.trim()));
    const message = bounded(plain
        ? `${[...problems, more].filter(Boolean).join("; ")}.`
        : `${String(error?.message || error || "The request failed.")}${problems.length ? ` ${[...problems, more].filter(Boolean).join("; ")}` : ""}`);
    return { phase: refused ? "failed" : "unconfirmed", message, code };
}

/**
 * Words for a problem that name no place: Ajv's own (an older server's) begin "must …" ("must be string"), "boolean
 * schema …" or "property name …"; others begin with the verb ("is required"). The server's plain words begin with their
 * place ("repo must be text", "The value must be an object", "items 1 and 2 of tags are the same").
 */
const AJV_WORDS = /^(?:must|is|has|should|boolean schema|property name)\b/i;

/**
 * One problem of a refusal as shown: the server's plain words as they are, without a full stop (several are joined with
 * "; "); words that name no place after it ("/repo: must be string").
 */
export function workflowProblemText(item) {
    const message = String(item?.message ?? "").trim();
    const path = typeof item?.path === "string" && item.path ? item.path : "";
    if (AJV_WORDS.test(message)) return `${path ? `${path}: ` : ""}${message}`;
    return message.replace(/\.$/, "");
}

/**
 * What the view shows about the last control that did not succeed, beside
 * the graph, or null: a refusal with its reason, or an unconfirmed send
 * that Retry sends again (the same command and operation id).
 */
export function workflowRunCommandNotice(command) {
    if (!isRecord(command) || !NOTICE_LABELS[command.operation] || (command.phase !== "failed" && command.phase !== "unconfirmed")) return null;
    const label = NOTICE_LABELS[command.operation];
    const run = typeof command.runId === "string" ? command.runId : "";
    // OF-S2-2 part 2 (D-W10): a Workflow has one live run, so the notice names none (the notice keeps the id for Retry).
    const given = typeof command.message === "string" && command.message ? command.message : "No reason was given.";
    const message = /[.!?…]$/.test(given) ? given : `${given}.`;
    return command.phase === "failed"
        ? { level: "error", operation: command.operation, runId: run, retry: false,
            text: `${REFUSED_WORDS[command.operation] ?? `${label} refused`}: ${message}` }
        : { level: "warning", operation: command.operation, runId: run, retry: true,
            text: `${label} may not have reached the Workflow: ${message} Retry sends the same command again.` };
}

/** Lines of the middle of two texts compared by longest common subsequence; past this, the middle shows as removed then added. */
const LINE_DIFF_MAX_MIDDLE = 1_500;

/**
 * Two versions of a definition's YAML compared line by line (owner decision q4; mocks M01, M02, M20): `rows` in order,
 * each { kind: "same" | "removed" | "added", text, before, after } with its line number on each side (null where it has
 * none), and the counts of `added` and `removed` lines. Lines common to both ends are matched first; the middle is
 * compared by longest common subsequence up to 1500 lines a side, and beyond that shown as removed then added
 * (`approximate`). Pure.
 */
export function workflowLineDiff(before, after) {
    const a = String(before ?? "").split("\n");
    const b = String(after ?? "").split("\n");
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
    const rows = [];
    for (let i = 0; i < start; i++) rows.push({ kind: "same", text: a[i], before: i + 1, after: i + 1 });
    const midA = a.slice(start, endA), midB = b.slice(start, endB);
    const approximate = midA.length > LINE_DIFF_MAX_MIDDLE || midB.length > LINE_DIFF_MAX_MIDDLE;
    if (approximate) {
        midA.forEach((text, i) => rows.push({ kind: "removed", text, before: start + i + 1, after: null }));
        midB.forEach((text, i) => rows.push({ kind: "added", text, before: null, after: start + i + 1 }));
    } else {
        // lengths[i][j]: the longest common subsequence of midA[i..] and midB[j..].
        const lengths = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
        for (let i = midA.length - 1; i >= 0; i--) {
            for (let j = midB.length - 1; j >= 0; j--) {
                lengths[i][j] = midA[i] === midB[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
            }
        }
        let i = 0, j = 0;
        while (i < midA.length || j < midB.length) {
            if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
                rows.push({ kind: "same", text: midA[i], before: start + i + 1, after: start + j + 1 });
                i += 1; j += 1;
            } else if (i < midA.length && (j >= midB.length || lengths[i + 1][j] >= lengths[i][j + 1])) {
                rows.push({ kind: "removed", text: midA[i], before: start + i + 1, after: null });
                i += 1;
            } else {
                rows.push({ kind: "added", text: midB[j], before: null, after: start + j + 1 });
                j += 1;
            }
        }
    }
    for (let k = 0; k < a.length - endA; k++) rows.push({ kind: "same", text: a[endA + k], before: endA + k + 1, after: endB + k + 1 });
    return { rows, added: rows.filter(row => row.kind === "added").length, removed: rows.filter(row => row.kind === "removed").length, approximate };
}

/**
 * What a comparison of two definition revisions shows (owner decision q4), from the view's `definitionRevisions` (the
 * revision reads, controller.loadWorkflowDefinitionRevision): each side's text (properly formatted YAML, or the YAML as
 * saved when it does not parse), whether both are read, the first failure, and a one-line summary. Pure.
 */
export function workflowRevisionCompare(reads, from, to) {
    const side = revision => {
        const entry = isRecord(reads) ? reads[revision] : null;
        const value = isRecord(entry?.value?.definitionRevision) ? entry.value.definitionRevision : null;
        return { revision, phase: entry?.phase ?? "missing", error: text(entry?.error), text: value ? (text(value.formatted) ?? String(value.yaml ?? "")) : null,
            formatted: Boolean(value && text(value.formatted)), valid: value ? value.valid === true : null };
    };
    const before = side(from), after = side(to);
    const failed = [before, after].find(item => item.phase === "failed") ?? null;
    const ready = before.text !== null && after.text !== null;
    const diff = ready ? workflowLineDiff(before.text, after.text) : null;
    const summary = failed ? `Revision ${failed.revision} could not be read: ${failed.error ?? "no reason given"}`
        : !ready ? `Reading revisions ${from} and ${to}…`
            : diff.added || diff.removed ? `Revision ${from} → ${to}: +${diff.added} −${diff.removed} lines`
                : `Revisions ${from} and ${to} are the same.`;
    return { before, after, ready, failed, diff, summary };
}

/**
 * Owner, 2026-11-07T00:03Z: what a comparison of two versions of a definition shows. In stage 1 each version is its own
 * workflow child, so each side is that child's current revision, read as a revision is (loadWorkflowDefinitionRevision);
 * `from` and `to` are { version, read } with `read` the child's `definitionRevisions` entry for that revision. The same
 * shape as workflowRevisionCompare, its words about versions. Pure.
 */
export function workflowVersionCompare(from, to) {
    const side = item => {
        const entry = isRecord(item?.read) ? item.read : null;
        const value = isRecord(entry?.value?.definitionRevision) ? entry.value.definitionRevision : null;
        return { version: text(item?.version), phase: entry?.phase ?? "missing", error: text(entry?.error),
            text: value ? (text(value.formatted) ?? String(value.yaml ?? "")) : null, formatted: Boolean(value && text(value.formatted)),
            valid: value ? value.valid === true : null };
    };
    const before = side(from), after = side(to);
    const name = item => item.version ?? "a version not read yet";
    const failed = [before, after].find(item => item.phase === "failed") ?? null;
    const ready = before.text !== null && after.text !== null;
    const diff = ready ? workflowLineDiff(before.text, after.text) : null;
    const summary = failed ? `Version ${name(failed)} could not be read: ${failed.error ?? "no reason given"}`
        : !ready ? `Reading versions ${name(before)} and ${name(after)}…`
            : diff.added || diff.removed ? `Version ${name(before)} → ${name(after)}: +${diff.added} −${diff.removed} lines`
                : `Versions ${name(before)} and ${name(after)} have the same YAML.`;
    return { before, after, ready, failed, diff, summary };
}

/** What an agent step's input field can take its value from (owner decision q6), in the words the editor shows. */
export const WORKFLOW_STEP_INPUT_SOURCE_LABELS = Object.freeze({
    none: "Not set",
    run_input: "A run input",
    previous_step: "The previous step's result",
    variable: "A workflow variable",
    fixed: "A fixed value",
    keep: "As written in the YAML",
});

/**
 * The step-input editor's rows (owner decision q6), from the step-input read (`stepInput`): one per field, in the read's
 * order, with where its value comes from now and that source's text (`detail`: the run input's or variable's name, the
 * previous step's field path, or a fixed value as JSON, a text value as it is). `keep` is offered only for a field whose
 * value is written in a way the editor does not change (a default, a value built of several parts). Pure.
 */
/**
 * The step-input editor's fields as a value (adversarial review UI-4 and its verification): `step` the step they are
 * of, `rows` the fields shown, `dirty` whether the person changed them, `waiting` a newer reading of the same step held
 * back while they are changed. Given the step chosen and its reading (`value`, null while it is read or when the read
 * failed): the person's changed fields of the same step are kept through a read and its failure, and a new reading
 * then waits (workflowStepInputLoadWaiting takes it); another step, or unchanged fields, take the reading as it is.
 * Pure.
 */
export function workflowStepInputEditorState(previous, { step, value }) {
    if (previous && previous.dirty && previous.step === step) {
        if (!value || previous.waiting === value) return previous;
        return { ...previous, waiting: value };
    }
    if (previous && !previous.dirty && previous.step === step && previous.reading === value) return previous;
    return { step, rows: workflowStepInputRows(value), dirty: false, waiting: null, reading: value ?? null };
}

/** The person changed the fields (`rows`, or a function of the current ones): they are kept until loaded again. Pure. */
export function workflowStepInputEdited(previous, rows) {
    return { ...previous, rows: typeof rows === "function" ? rows(previous.rows) : rows, dirty: true };
}

/** The person loads the newer reading held back while they changed the fields. Pure. */
export function workflowStepInputLoadWaiting(previous) {
    if (!previous.waiting) return previous;
    return { step: previous.step, rows: workflowStepInputRows(previous.waiting), dirty: false, waiting: null, reading: previous.waiting };
}

export function workflowStepInputRows(stepInput) {
    const fields = Array.isArray(stepInput?.fields) ? stepInput.fields.filter(isRecord) : [];
    return fields.map(field => {
        const current = isRecord(field.current) ? field.current : null;
        const source = current && Object.hasOwn(WORKFLOW_STEP_INPUT_SOURCE_LABELS, current.source) ? current.source : "none";
        const detail = source === "run_input" || source === "variable" ? String(current.name ?? "")
            : source === "previous_step" ? String(current.path ?? "")
                : source === "fixed" ? (typeof current.value === "string" && field.type === "string" ? current.value : JSON.stringify(current.value ?? null))
                    : source === "keep" ? String(current.text ?? "") : "";
        return { name: String(field.name ?? ""), required: field.required === true, declared: field.declared !== false, type: text(field.type),
            description: text(field.description), source, detail, keepable: source === "keep", keepText: source === "keep" ? detail : null };
    });
}

/**
 * The step-input read's `input` for the editor's rows (owner decision q6): field -> { source, name | path | value }, a
 * field "Not set" left out. A fixed value is JSON (a number, true or false, null, a list or an object), or for a text field
 * the text as it is. { ok, input } or { ok: false, error } naming the field; `missing` lists the required fields not set
 * (a note, not a refusal: the step's own check runs when it starts). Pure.
 */
export function workflowStepInputRequest(rows) {
    const input = {};
    const missing = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!isRecord(row) || typeof row.name !== "string" || !row.name) continue;
        const detail = typeof row.detail === "string" ? row.detail : "";
        switch (row.source) {
            case "run_input":
            case "variable":
                if (!detail.trim()) return { ok: false, error: `Name the ${row.source === "run_input" ? "run input" : "variable"} for '${row.name}'.`, missing };
                input[row.name] = { source: row.source, name: detail.trim() };
                break;
            case "previous_step":
                input[row.name] = { source: "previous_step", path: detail.trim() };
                break;
            case "fixed": {
                if (row.type === "string" && !detail.trimStart().startsWith("\"")) { input[row.name] = { source: "fixed", value: detail }; break; }
                try { input[row.name] = { source: "fixed", value: JSON.parse(detail) }; } catch {
                    // A field whose type is not known takes what was typed as text; a typed field needs its kind of value.
                    if (!row.type && detail !== "") { input[row.name] = { source: "fixed", value: detail }; break; }
                    return { ok: false, error: `The fixed value for '${row.name}' must be JSON: a number, true or false, null, "text", a list or an object.`, missing };
                }
                break;
            }
            case "keep":
                input[row.name] = { source: "keep" };
                break;
            default:
                if (row.required) missing.push(row.name);
        }
    }
    return { ok: true, input, missing };
}

/**
 * Which input mapping a prepared change to a step's inputs was made from (owner decision q6): the same text for the same
 * mapping (workflowStepInputRequest's `input`), so a change is saved only while the fields still say what it was
 * prepared from. Null for no mapping. Pure.
 */
export function workflowStepInputKey(input) {
    return isRecord(input) ? JSON.stringify(input) : null;
}

/** One line on what the proposed change to a step's inputs is (owner decision q6), from its preview. Pure. */
export function workflowStepInputSummary(state, preview) {
    if (!isRecord(preview)) return null;
    if (preview.phase === "loading") return { level: "info", text: "Preparing the change…" };
    if (preview.phase === "failed") return { level: "error", text: `The change could not be prepared: ${text(preview.error) ?? "no reason given"}` };
    const proposed = isRecord(preview.value) ? preview.value : null;
    if (!proposed) return null;
    if (proposed.changed !== true) return { level: "info", text: `The inputs of step '${state}' are already written this way; there is nothing to save.` };
    const errors = (Array.isArray(proposed.diagnostics) ? proposed.diagnostics : []).filter(item => isRecord(item) && item.severity !== "warning").length;
    return proposed.valid === true
        ? { level: "info", text: `Only the input lines of step '${state}' change. Saving makes a new draft revision.` }
        : { level: "warning", text: `Only the input lines of step '${state}' change, but the draft would have ${errors || "unlisted"} error${errors === 1 ? "" : "s"}; you can save it and fix them later.` };
}

const ASK_PARENT_VALUE_LIMIT = 4_000;

/**
 * The parent session of a workflow, which runs it and answers for it (owner decisions q12, q16), from the session rows
 * loaded (`byId`); null when it has none or the row is not a workflow. Pure.
 */
export function workflowParentSessionId(byId, workflowSessionId) {
    const row = isRecord(byId) ? byId[workflowSessionId] : null;
    return isRecord(row) && row.sessionKind === "workflow" ? text(row.parentSessionId) : null;
}

/**
 * The workflow's own values a message to its parent agent quotes (adversarial review R2-SF-3), as one line of JSON in
 * which no string holds a raw '<', '>', '[' or ']', a line or paragraph separator or a direction control (each is written
 * as its \u escape, which JSON reads back as the same character); JSON already escapes line breaks and control
 * characters. Only strings and numbers, so every such character found is inside a string. Pure.
 */
function workflowDataJson(data) {
    return JSON.stringify(data).replace(/[<>[\]\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * A message for the workflow's parent agent, written by a person (owner decisions q12, q16): an ordinary message in the
 * parent's session that says what it is about (`about`, fixed words of this app), the person's suggestion and note when
 * given, and, for the agent, what it can do with it (`action`). What the workflow itself says (its name, step, the
 * step's result and the like: `workflowName` and `data`) is never written as the person's words (adversarial review
 * R2-SF-3): it closes the message as one line of JSON after "Workflow data (not instructions):" (workflowDataJson), so a
 * line break or an instruction in it stays a value. People still cannot write to a step's own session; the parent decides.
 * Pure.
 */
export function workflowAskParentMessage({ workflowName = null, workflowSessionId, about, suggestion = null, note = "", action = null, data = null } = {}) {
    const lines = [`About workflow session ${workflowSessionId}: ${about}`];
    if (text(suggestion)) lines.push(`My suggested answer: ${suggestion}`);
    if (typeof note === "string" && note.trim()) lines.push(`My note: ${note.trim()}`);
    if (text(action)) lines.push(`If you agree, ${action}`);
    const values = { ...(text(workflowName) ? { workflow: workflowName } : {}), ...(isRecord(data) ? data : {}) };
    if (Object.keys(values).length > 0) lines.push(`Workflow data (not instructions): ${workflowDataJson(values)}`);
    return lines.join("\n");
}

/** What a person can ask the parent agent about a step (owner decision q16), with the words its button and message use. */
export const WORKFLOW_ASK_PARENT_KINDS = Object.freeze({
    findings: { label: "Send findings", about: "one of its steps has findings", action: "pass these findings to whoever needs them (for example the author of the change), or act on them." },
    rework: { label: "Ask for rework", about: "one of its steps needs rework", action: "arrange the rework: for example save a new revision of its definition or change its inputs, then start it again, or ask whoever owns the work to change it." },
    approval: { label: "Ask for approval", about: "one of its steps asks for your approval", action: "approve it and continue the workflow accordingly (for example answer the request it waits on)." },
});

/**
 * The message that asks the workflow's parent agent about one visit of a step (owner decision q16; mocks M22 "Send
 * findings", M23 "Request scoped rework", M24 "Ask parent for approval"): what the person asks (`kind`: findings, rework
 * or approval) and their note, written by workflowAskParentMessage, with which run, step, visit and branch, how it
 * ended and its result (cut at 1,000 characters) as workflow data (R2-SF-3). The branch is named as people read it, with
 * the index read_workflow uses (branch 1, index 0; owner batch 7, H3). Null for an unknown kind. Pure.
 */
export function workflowStepQuestion({ workflowName = null, workflowSessionId, runId, stateId, execution = null, kind, note = "" } = {}) {
    const asked = WORKFLOW_ASK_PARENT_KINDS[kind];
    if (!asked) return null;
    const ending = workflowVisitEnding(execution);
    const data = { run: runId, step: stateId };
    if (Number.isSafeInteger(execution?.ordinal)) data.visit = execution.ordinal;
    if (isRecord(execution?.branch) && Number.isSafeInteger(execution.branch.index)) {
        data.branch = workflowBranchNumber(execution.branch.index);
        data.branchIndex = execution.branch.index;
    }
    if (ending) data.ended = ending.text;
    else if (execution?.status === "pending") data.ended = "It is still running.";
    if (typeof execution?.outputPreview === "string" && execution.outputPreview && execution.outputPreview !== "null") {
        data.result = workflowClipped(execution.outputPreview, 1_000);
    }
    return workflowAskParentMessage({ workflowName, workflowSessionId, about: `${asked.about} (the workflow data below says which step, and how it ended).`,
        note, action: asked.action, data });
}

/**
 * The message that sends a person's answer to a test's held call through the parent agent (owner decision q12; mock
 * M18): the answer the person suggests (a success value, an error or a cancel, as the answer form drafted it,
 * `response`; null for none), their note and the parent's own way to answer it (update_workflow test_respond with exactly
 * these ids and that answer), with the test run, the held call and its step as workflow data (R2-SF-3). A long value is
 * cut. Pure.
 */
export function workflowHeldCallQuestion({ workflowName = null, workflowSessionId, runId, call, response = null, note = "" } = {}) {
    const data = { run: runId, call: `${call?.operation ?? "call"}${call?.tool ? ` · ${call.tool}` : ""}`,
        ...(call?.stateId ? { step: call.stateId } : {}), interceptionId: call?.interceptionId ?? null };
    const json = value => {
        const written = JSON.stringify(value ?? null);
        return written.length > ASK_PARENT_VALUE_LIMIT ? `${written.slice(0, ASK_PARENT_VALUE_LIMIT - 1)}…` : written;
    };
    const suggestion = !isRecord(response) ? null
        : response.kind === "cancel" ? "cancel it"
            : `${response.kind === "error" ? "an error" : "success"} with ${json(response.value)}`;
    const ids = `operation test_respond, run_id ${runId}, interception_id ${call?.interceptionId}`;
    const action = isRecord(response)
        ? `answer it with update_workflow (${ids}, response ${json(response)}).`
        : `answer it with update_workflow (${ids}).`;
    return workflowAskParentMessage({ workflowName, workflowSessionId, about: "a call held in its test run waits for an answer (the workflow data below says which call).",
        suggestion, note, action, data });
}

/** What the status line says once a message reached the parent agent's session (q12, q16). Pure. */
export function workflowAskParentSent(parentSessionId) {
    // Review 19:27Z: no session id where a person reads it.
    return "Sent to the parent agent's session. It answers with its own tools; open its session from the session list.";
}

/**
 * Where a held call's answer came from, in plain words (the owner's plain-words rule): a prepared answer (stored
 * disposition "fixture") or the parent agent ("parent"); any other value as it is, and `fallback` for none. Display
 * only: the stored value does not change. Pure.
 */
export function workflowAnswerSourceText(disposition, fallback = "not known") {
    if (disposition === "fixture") return "prepared answer";
    if (disposition === "parent") return "parent agent";
    return typeof disposition === "string" && disposition ? disposition : fallback;
}

/** How deep a sample follows nested objects and arrays; past it a value is null. */
const SAMPLE_MAX_DEPTH = 6;
/** An object's optional properties join its sample when it has at most this many properties in all. */
const SAMPLE_FEW_PROPERTIES = 4;
/**
 * The budget of a sample (adversarial review UI-3): at most this many characters of JSON in all, and no string longer
 * than SAMPLE_MAX_STRING. A schema that asks for more (a minLength of 2^53, many copies of a large default) gets no
 * sample: the box stays "{}" and can be edited as ever. Nothing is allocated past the budget.
 */
const SAMPLE_MAX_CHARS = 16_384;
const SAMPLE_MAX_STRING = 1_000;
const SAMPLE_OVER_BUDGET = new Error("The sample is over its budget.");

/** Count `chars` more characters of a sample against its budget; past it, give up the whole sample. */
function chargeSample(budget, chars) {
    budget.used += chars;
    if (budget.used > SAMPLE_MAX_CHARS) throw SAMPLE_OVER_BUDGET;
}

/**
 * Whether a value holds a string (or a key) longer than SAMPLE_MAX_STRING, at any depth (UI-3 verification, E2-T7). The
 * walk has a step budget: a value with more parts than a sample may have characters is taken as holding one (it is too
 * large to be a sample). No recursion, so a deep value cannot exhaust the stack.
 */
function holdsLongString(value) {
    const stack = [value];
    let steps = 0;
    while (stack.length > 0) {
        const item = stack.pop();
        steps += 1;
        if (steps > SAMPLE_MAX_CHARS) return true;
        if (typeof item === "string") {
            if (item.length > SAMPLE_MAX_STRING) return true;
            continue;
        }
        if (!item || typeof item !== "object") continue;
        for (const [key, child] of Object.entries(item)) {
            if (key.length > SAMPLE_MAX_STRING) return true;
            stack.push(child);
        }
    }
    return false;
}

/**
 * A value a schema gives as it is (an example, a default, an enum value, a const), charged at its JSON length; undefined
 * when it holds a string longer than SAMPLE_MAX_STRING or is longer than the whole budget (UI-3 verification): the
 * sample then takes the next source, and in the end its type.
 */
function givenValue(budget, value) {
    if (holdsLongString(value)) return undefined;
    const text = JSON.stringify(value);
    if (text === undefined || text.length > SAMPLE_MAX_CHARS) return undefined;
    chargeSample(budget, text.length);
    return value;
}

/** "prUrl", "pr_url" or "pr-url" -> "pr url". */
function sampleWords(name) {
    return String(name ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").trim().toLowerCase();
}

/** A JSON Schema type, or the first that is not null of a list of them. */
function sampleType(schema) {
    const type = Array.isArray(schema.type) ? schema.type.find(item => item !== "null") ?? schema.type[0] : schema.type;
    if (typeof type === "string") return type;
    if (isRecord(schema.properties) || Array.isArray(schema.required)) return "object";
    if (schema.items !== undefined) return "array";
    return null;
}

/** A day `offset` days after 2026-01-01, as an ISO date and time (UTC). */
function sampleDate(offset) {
    return new Date(Date.UTC(2026, 0, 1 + offset, 9, 0, 0)).toISOString().replace(/\.000Z$/, "Z");
}

/**
 * A sample of one value of `schema`, named `name` (its property name), or undefined when the schema says nothing usable.
 * `variant` (UXFD C2): the items of a list whose items must differ (uniqueItems) are variants 0, 1, 2… of its items'
 * sample: the next enum value or example, else the sample by type made different (a number one more, a text with its
 * number, "example tags 2"), so the sample can be submitted as it is.
 */
function sampleOf(schema, name, depth, budget, variant = 0) {
    if (depth > SAMPLE_MAX_DEPTH) return null;
    if (schema === true || schema === undefined) return undefined;
    if (!isRecord(schema)) return undefined;
    const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
    const examples = Array.isArray(schema.examples) ? schema.examples : [];
    const sources = variant === 0 ? [
        examples.length ? [examples[0]] : [],
        // OF-S2-8: an OpenAPI-style single `example` too.
        Object.hasOwn(schema, "example") ? [schema.example] : [],
        Object.hasOwn(schema, "default") ? [schema.default] : [],
        enumValues.length ? [enumValues[0]] : [],
        Object.hasOwn(schema, "const") ? [schema.const] : [],
    ].flat()
        // A later variant: an allowed value must stay one (the next, while there are any); else the next example.
        : enumValues.length ? [enumValues[variant % enumValues.length]]
            : Object.hasOwn(schema, "const") ? [schema.const]
                : examples.length > variant ? [examples[variant]] : [];
    for (const source of sources) {
        const given = givenValue(budget, source);
        if (given !== undefined) return given;
    }
    for (const key of ["oneOf", "anyOf"]) {
        if (Array.isArray(schema[key]) && schema[key].length) {
            const value = sampleOf(schema[key].find(item => !(isRecord(item) && item.type === "null")) ?? schema[key][0], name, depth + 1, budget, variant);
            if (value !== undefined) return value;
        }
    }
    if (Array.isArray(schema.allOf) && schema.allOf.length) {
        const parts = schema.allOf.map(part => sampleOf(part, name, depth + 1, budget, variant)).filter(value => value !== undefined);
        if (parts.length && parts.every(isRecord)) return Object.assign({}, ...parts);
        if (parts.length) return parts[0];
    }
    // A long name gives no longer a text than this (UI-3 verification).
    const words = sampleWords(name).slice(0, 60).trim();
    const tag = variant > 0 ? String(variant + 1) : "";
    switch (sampleType(schema)) {
        case "string": {
            const format = typeof schema.format === "string" ? schema.format : "";
            const slug = words.replace(/\s+/g, "-") || "item";
            let value = format === "date-time" ? sampleDate(variant) : format === "date" ? sampleDate(variant).slice(0, 10)
                : format === "time" ? sampleDate(0).slice(11, 17) + String(variant % 60).padStart(2, "0")
                    : format === "uri" || format === "url" || format === "iri" ? `https://example.com/${slug}${tag ? `-${tag}` : ""}`
                        : format === "email" ? `${slug.replace(/-/g, ".")}${tag}@example.com`
                            : format === "uuid" ? `00000000-0000-4000-8000-${String(variant % 1e12).padStart(12, "0")}`
                                : `${words ? `example ${words}` : "example"}${tag ? ` ${tag}` : ""}`;
            if (Number.isSafeInteger(schema.maxLength) && schema.maxLength >= 0 && value.length > schema.maxLength) {
                // A variant keeps its number at the end, so the cut texts still differ.
                value = tag && schema.maxLength >= tag.length ? `${value.slice(0, schema.maxLength - tag.length)}${tag}` : value.slice(0, schema.maxLength);
            }
            // UI-3: checked before anything is allocated.
            if (typeof schema.minLength === "number" && schema.minLength > SAMPLE_MAX_STRING) throw SAMPLE_OVER_BUDGET;
            if (Number.isSafeInteger(schema.minLength) && value.length < schema.minLength) value = value.padEnd(schema.minLength, "x");
            chargeSample(budget, value.length + 2);
            return value;
        }
        case "integer":
        case "number": {
            const integer = sampleType(schema) === "integer";
            let value = 1;
            if (typeof schema.minimum === "number") value = integer ? Math.ceil(schema.minimum) : schema.minimum;
            else if (typeof schema.exclusiveMinimum === "number") value = integer ? Math.floor(schema.exclusiveMinimum) + 1 : schema.exclusiveMinimum + 1;
            else if (typeof schema.maximum === "number" && schema.maximum < 1) value = integer ? Math.floor(schema.maximum) : schema.maximum;
            if (variant === 0) return value;
            // A later variant counts up from it, or down when that passes the maximum.
            const up = value + variant;
            const over = (typeof schema.maximum === "number" && up > schema.maximum) || (typeof schema.exclusiveMaximum === "number" && up >= schema.exclusiveMaximum);
            return over ? value - variant : up;
        }
        case "boolean": return variant % 2 === 1;
        case "null": return null;
        case "array": {
            const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
            if (schema.maxItems === 0) return [];
            // UXFD (C2): as many items as minItems asks for (a sample offered must be one that can be submitted).
            const count = Number.isSafeInteger(schema.minItems) && schema.minItems > 1 ? schema.minItems : 1;
            // UI-3: every item takes at least its separator; a count past the budget is refused before anything is made.
            if (count * 2 > SAMPLE_MAX_CHARS) throw SAMPLE_OVER_BUDGET;
            const first = sampleOf(itemSchema, name, depth + 1, budget, schema.uniqueItems === true ? variant * count : variant);
            if (first === undefined) return [];
            if (schema.uniqueItems !== true) {
                // The copies after the first count too (the item's own characters were counted once).
                if (count > 1) chargeSample(budget, (JSON.stringify(first)?.length ?? 4) * (count - 1));
                return Array.from({ length: count }, () => first);
            }
            const items = [first];
            for (let index = 1; index < count; index += 1) {
                chargeSample(budget, 1);
                items.push(sampleOf(itemSchema, name, depth + 1, budget, variant * count + index));
            }
            return items;
        }
        case "object": {
            const properties = isRecord(schema.properties) ? schema.properties : {};
            const required = new Set(Array.isArray(schema.required) ? schema.required.filter(key => typeof key === "string") : []);
            const names = Object.keys(properties);
            const all = names.length <= SAMPLE_FEW_PROPERTIES;
            const out = {};
            for (const key of [...names, ...[...required].filter(key => !Object.hasOwn(properties, key))]) {
                if (!required.has(key) && !all) continue;
                // The key as JSON writes it (escapes included), its colon and its separator.
                chargeSample(budget, JSON.stringify(key).length + 2);
                const value = sampleOf(properties[key], key, depth + 1, budget, variant);
                if (value !== undefined) { out[key] = value; continue; }
                const fallback = `example ${sampleWords(key).slice(0, 60).trim() || "value"}${tag ? ` ${tag}` : ""}`;
                chargeSample(budget, JSON.stringify(fallback).length);
                out[key] = fallback;
            }
            return out;
        }
        default: return undefined;
    }
}

/**
 * Sample inputs for a run, built from the workflow's input schema (batch 7, f-05; the read model's graph.inputsSchema,
 * its references already resolved): for each field its first example, else its default, else its first enum value,
 * else a value by its type: a short readable text from the field's name for a string ("example change" for change; a
 * date, time, URL, e-mail address or UUID for those formats; padded to minLength), the minimum or 1 for a number, false
 * for a boolean, for an array as many items as minItems asks for (at least one), all different when uniqueItems asks for
 * that, and for an object its required properties (all of them when it has four or fewer). A JSON
 * object, or null when there is no schema or it does not describe an object (the box then keeps "{}"). Pure.
 */
export function workflowSampleInputs(schema) {
    if (!isRecord(schema)) return null;
    let value;
    try {
        value = sampleOf(schema, "", 0, { used: 0 });
    } catch (error) {
        if (error === SAMPLE_OVER_BUDGET) return null;
        throw error;
    }
    if (!isRecord(value)) return null;
    // UI-3 verification: the text the Inputs box would show (JSON, two-space indent) is within the budget, exactly.
    return JSON.stringify(value, null, 2).length > SAMPLE_MAX_CHARS ? null : value;
}

/**
 * OF-S2-8 (owner, 2026-11-07T23:12Z): a sample of any value a schema describes (a node's input or output), made the way
 * the Start form's sample inputs are (workflowSampleInputs): the schema's example, default, first enum value or
 * const, else a value by its type, honouring minimum, maximum and the length limits, an object's required properties
 * first. { value } (value may be null for a null schema), or null when the schema says nothing usable or asks for a
 * sample over the budget. `schema` has its references resolved (workflowResolvedSchema). Pure.
 */
export function workflowSampleValue(schema) {
    if (schema === true) return { value: {} };
    if (!isRecord(schema)) return null;
    try {
        const value = sampleOf(schema, "", 0, { used: 0 });
        if (value === undefined) return null;
        return JSON.stringify(value, null, 2).length > SAMPLE_MAX_CHARS ? null : { value };
    } catch (error) {
        if (error === SAMPLE_OVER_BUDGET) return null;
        throw error;
    }
}

const DRAWABLE_TYPES = new Set(["string", "number", "integer", "boolean"]);

/** Whether the Start form draws a field for one input property (text, number, yes or no, a list, or one of a list). Pure. */
export function workflowDrawableInput(property) {
    if (!isRecord(property)) return false;
    if (Array.isArray(property.enum)) return property.enum.every(value => ["string", "number", "boolean"].includes(typeof value));
    if (DRAWABLE_TYPES.has(property.type)) return true;
    return property.type === "array" && isRecord(property.items) && ["string", "number", "integer"].includes(property.items.type);
}

/** Keywords that let an object schema ask for input without listing it in `properties` (review UI-13). */
const UNLISTED_INPUT_KEYWORDS = ["oneOf", "anyOf", "allOf", "not", "if", "then", "else", "$ref", "patternProperties", "dependentSchemas",
    "dependentRequired", "propertyNames", "unevaluatedProperties"];

/**
 * How the Start form asks for a definition's inputs (reviews UI-13, UI-D8): "none" when it takes none (no schema, or a
 * closed object schema that lists, requires and allows no field: additionalProperties false), "form" when it lists
 * fields the form can draw, else "json": a JSON box, also for an open object schema (it takes any inputs) and for a
 * schema that asks for input in a way the form cannot draw (fields it cannot draw, oneOf, references, typed
 * additionalProperties, minProperties, a non-object type). Never "none" when input could be given. Pure.
 */
export function workflowInputsShape(schema) {
    if (!isRecord(schema)) return "none";
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const keys = Object.keys(properties);
    if (keys.length > 0) return keys.every(key => workflowDrawableInput(properties[key])) ? "form" : "json";
    const asks = (schema.type !== undefined && schema.type !== "object")
        || (Array.isArray(schema.required) && schema.required.length > 0)
        || (Number.isFinite(schema.minProperties) && schema.minProperties > 0)
        || schema.additionalProperties !== false
        || UNLISTED_INPUT_KEYWORDS.some(keyword => Object.hasOwn(schema, keyword));
    return asks ? "json" : "none";
}

/**
 * The Start form's shape for Start another (reviews UI-D8, UI-F4): the definition's (workflowInputsShape) when its schema
 * is known. A missing schema (the read could not give it) is no contract at all, never proof that no inputs exist: a JSON
 * box, filled with the inputs its Workflow had when they are known (also {}), else the same-inputs fallback. "none" is
 * only for an explicitly closed empty contract. Pure.
 */
export function workflowStartAnotherShape(schema, { schemaKnown = false } = {}) {
    // UX2D-F9: Run again of a session's definition reads the revision it starts; once read, its schema is the contract (no
    // schema: it takes no inputs), so it says what Start says.
    if (schemaKnown) return workflowInputsShape(schema);
    return isRecord(schema) ? workflowInputsShape(schema) : "json";
}

/**
 * The inputs a Workflow's run started with, from its read model (`run.inputs`, a bounded JSON preview; review UI-13):
 * an object, or null when the read has none, or cut them (Start another then says it cannot read them). Pure.
 */
export function workflowRunInputs(model) {
    const preview = isRecord(model) && isRecord(model.run) ? model.run.inputs : undefined;
    if (isRecord(preview)) return preview;
    if (typeof preview !== "string") return null;
    try {
        const value = JSON.parse(preview);
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
}

/** The text of a JSON box that a sample may fill: empty, or an empty object as written ("{}" with any spacing). */
export function workflowInputsBoxEmpty(textValue) {
    return typeof textValue !== "string" || /^\s*(\{\s*\})?\s*$/.test(textValue);
}
