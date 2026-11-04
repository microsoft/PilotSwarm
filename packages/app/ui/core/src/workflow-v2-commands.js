import { shortRunId as shortId, shortSessionId as shortSession } from "./formatting.js";
import {
    workflowV2AgentBinding, workflowV2AgentBindingRows, workflowV2AgentTask, workflowV2BranchNumber, workflowV2Clipped, workflowV2RunRows, workflowV2VisitEnding,
} from "./workflow-v2-view.js";

/**
 * Workflow v2: a person's workflow commands in the workflow view (design 04
 * and 07, mocks M03, M04, M15 and M16; R04, R05, R17, R18, R26; INACTIVE): the
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
export const WORKFLOW_V2_RUN_CONTROL_OPERATIONS = Object.freeze(["pause", "resume", "stop", "cancel"]);

const ACTIVE = new Set(["admitted", "running", "paused"]);
const ENDED = new Set(["completed", "failed", "cancelled", "stopped"]);
const LABELS = { pause: "Pause", resume: "Resume", stop: "Stop", cancel: "Cancel" };
/** How a notice names each command. */
const NOTICE_LABELS = { ...LABELS, set_vars: "The variables update", publish: "Publish", publish_and_start: "Publish and start", start: "Start",
    replace_definition: "Saving the draft", test: "Starting the test", test_respond: "The test answer", test_advance: "The clock advance" };
/** The definition's commands: they name no run (a test makes its own). */
const DEFINITION_OPERATIONS = new Set(["replace_definition", "publish", "publish_and_start", "start", "test"]);
/** The longest test scenario name (tools.ts). */
const SCENARIO_MAX = 128;
/** The longest single advance of a test run's virtual clock (store.ts WORKFLOW_V2_TEST_ADVANCE_MAX_SECONDS: 30 days). */
const ADVANCE_MAX_SECONDS = 30 * 86_400;
/** The kinds of a test answer (test-mode.ts parseTestResponse). */
const RESPONSE_KINDS = new Set(["success", "error", "cancel"]);

/**
 * What every test run says, and what a test with real agents adds (the SDK's
 * WORKFLOW_V2_TEST_NOTICE and WORKFLOW_V2_TEST_REAL_AGENT_NOTICE, test-mode.ts):
 * shown before a test starts; the run's own notices come back with its read
 * model once it runs.
 */
export const WORKFLOW_V2_TEST_NOTICE_TEXT = "TEST — workflow tools are mocked, but scripts run normally: their files, network, processes and "
    + "clock are real. A passing test does not show that the workflow is safe to run live.";
export const WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT = "Agent steps run real agent sessions: they spend model tokens and their results vary as a "
    + "model's do. Their workflow tool calls are mocked; their model's own built-in tools (shell, files) run normally; MCP tools are refused.";
/** What the variables panel says about them, in the portal and the terminal (the flow review's plain words). */
export const WORKFLOW_V2_VARIABLES_HELP_TEXT = "Steps read these variables when they start; running steps keep the values they started with.";
/** Why a published workflow offers no test (of-06; the server's TEST_NEEDS_DRAFT says the same). */
export const WORKFLOW_V2_TEST_NEEDS_DRAFT_TEXT = "Only a draft can be tested, and this workflow is published. To test a change, create a new workflow as a draft.";
/** The largest workflow YAML (compiler.ts WORKFLOW_V2_MAX_YAML_BYTES); the server checks it again. */
const YAML_MAX_BYTES = 256 * 1024;
/** The longest KV key (store.ts WORKFLOW_V2_KV_LIMITS.maxKeyLength). */
const KV_KEY_MAX = 128;
/** The longest value shown in the variables list; editing uses the whole value. */
const VALUE_DISPLAY_LIMIT = 300;
const PENDING_LABELS = { pause: "Pausing…", resume: "Resuming…", stop: "Stopping…", cancel: "Cancelling…" };
const TITLES = {
    pause: "Pause the run: no new step starts; work already started finishes and its result is kept.",
    resume: "Resume the run: steps start again from where it was paused.",
    stop: "Stop the run gracefully: no new step starts, work already started may finish until its grace period ends, and then the run ends as stopped.",
    cancel: "Cancel the run: it ends now, and work in progress is interrupted.",
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
export function workflowV2RestrictionText(commands) {
    return isRecord(commands) ? restrictionText(commands) : null;
}

function restrictionText(commands) {
    if (!isRecord(commands.restriction)) return null;
    // The server's reason when it sends one; else one short line, the same in the portal and the terminal.
    const reason = text(commands.restriction.reason) ?? "People can only pause, stop or cancel this workflow.";
    const controlling = text(commands.restriction.controllingSessionId);
    return controlling ? `${reason} Its controlling agent is session ${shortSession(controlling)}.` : reason;
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
export function workflowV2RunControls(model, command = null) {
    if (!isRecord(model) || !isRecord(model.personCommands) || !isRecord(model.run)) return null;
    const run = model.run;
    if (typeof run.runId !== "string" || !run.runId || (!ACTIVE.has(run.status) && !ENDED.has(run.status))) return null;
    const commands = model.personCommands;
    const offered = new Set(Array.isArray(commands.operations) ? commands.operations.filter(item => typeof item === "string") : []);
    const viewer = isRecord(commands.viewer) ? commands.viewer : null;
    const denied = viewer?.allowed === false ? text(viewer.reason) ?? "You cannot command this workflow." : null;
    const stopKnown = isRecord(commands.run) && commands.run.runId === run.runId && typeof commands.run.stop === "boolean";
    const stopUnsupported = stopKnown && commands.run.stop === false;
    const stopping = ACTIVE.has(run.status) && isRecord(run.stop);
    const busy = isRecord(command) && command.phase === "pending";
    const controls = WORKFLOW_V2_RUN_CONTROL_OPERATIONS
        .filter(operation => offered.has(operation) && applies(operation, run.status, stopping))
        .map(operation => {
            const pending = busy && command.operation === operation && command.runId === run.runId;
            const reason = busy ? (pending ? "This command is being sent." : "Another command for this workflow is being sent.")
                : denied ?? (operation === "stop" && stopUnsupported ? "This run's controller cannot stop it gracefully; cancel it instead." : null);
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
export function workflowV2RunCommandArgs(operation, input = {}) {
    if (WORKFLOW_V2_RUN_CONTROL_OPERATIONS.includes(operation)) return { ok: true, args: null };
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
export function workflowV2CommandNamesRun(operation) {
    return !DEFINITION_OPERATIONS.has(operation);
}

/**
 * The updateWorkflow command a checked command is sent as, with its own
 * operation id: a run command always for the named run, a definition command
 * for the revision and hash it names.
 */
export function workflowV2RunCommandWire(operation, runId, operationId, args = null) {
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
export function workflowV2VariableDraft(key, valueText) {
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

/** A variable a person asked to remove, as the delete list it is sent as, or the reason it is not one. */
export function workflowV2VariableRemoval(key) {
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
export function workflowV2VariableBatchDraft(setText, removeText) {
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
export function workflowV2RunVariables(model, command = null) {
    if (!isRecord(model) || !isRecord(model.personCommands) || !isRecord(model.run)) return null;
    const run = model.run;
    if (typeof run.runId !== "string" || !run.runId || (!ACTIVE.has(run.status) && !ENDED.has(run.status))) return null;
    const commands = model.personCommands;
    const offered = Array.isArray(commands.operations) && commands.operations.includes("set_vars");
    const viewer = isRecord(commands.viewer) ? commands.viewer : null;
    const denied = viewer?.allowed === false ? text(viewer.reason) ?? "You cannot command this workflow." : null;
    const revision = Number.isSafeInteger(run.kvRevision) && run.kvRevision >= 1 ? run.kvRevision : null;
    const reason = !offered ? restrictionText(commands) ?? "This workflow does not take variable changes from people."
        : !ACTIVE.has(run.status) ? `This run has ended (${run.status}); its variables no longer change.`
            : denied ?? (revision === null ? "The variables' revision is not known, so they cannot be changed here. Read the workflow again." : null);
    const busy = isRecord(command) && command.phase === "pending";
    return { runId: run.runId, revision, ...variablesOf(run.kv), editable: reason === null, reason, busy,
        pending: busy && command.operation === "set_vars" && command.runId === run.runId };
}

/**
 * A JSON object a person typed for a run's inputs or initial variables, or
 * the reason it is not one. Empty text is `{}` for inputs and nothing (the
 * field is left out) when `optional`.
 */
export function workflowV2JsonObjectDraft(source, { label = "The value", optional = false } = {}) {
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
export function workflowV2DefinitionControls(model, command = null) {
    if (!isRecord(model) || !isRecord(model.personCommands) || !isRecord(model.definition) || !isRecord(model.revision)) return null;
    const definition = model.definition;
    const state = definition.state === "draft" || definition.state === "published" ? definition.state : null;
    if (state === null) return null;
    const commands = model.personCommands;
    const offered = new Set(Array.isArray(commands.operations) ? commands.operations.filter(item => typeof item === "string") : []);
    const viewer = isRecord(commands.viewer) ? commands.viewer : null;
    const denied = viewer?.allowed === false ? text(viewer.reason) ?? "You cannot command this workflow." : null;
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
        const reason = busy ? (pending ? "This command is being sent." : "Another command for this workflow is being sent.")
            : denied ?? (operation !== "start" && !valid ? `Revision ${revision ?? "shown"} has ${errors || "unlisted"} error${errors === 1 ? "" : "s"} and cannot be published; fix them first.`
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
        .map(node => ({ stateId: node.id, task: workflowV2AgentTask(node), rows: workflowV2AgentBindingRows(workflowV2AgentBinding(node, pins)) }));
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
export function workflowV2PublicationEvidenceRows(publication, versionsNow = null) {
    if (!isRecord(publication)) return [];
    const draft = publication.state === "draft";
    const now = draft ? publicationVersionsNow(publication, versionsNow) : null;
    const rows = [];
    if (!publication.graphKnown) rows.push(["Agents", "Not known: the revision has no graph to read"]);
    else if (!publication.agents?.length) rows.push(["Agents", "None: no step runs a named agent"]);
    else if (now?.problem) rows.push(["Publishing would be refused", now.problem]);
    else if (now?.note) rows.push(["Agent versions", now.note]);
    for (const agent of publication.agents ?? []) {
        const pin = agent.rows.find(([label]) => label === "Locked by publishing");
        const lockedNow = now?.byState?.[agent.stateId];
        const draftText = lockedNow ? ` · version now: ${lockedNow}; publishing locks it`
            : now?.agentText ?? " · its exact package revision is locked when this revision is published";
        rows.push([`Agent in '${agent.stateId}'`, `${agent.task}${draft ? draftText : pin ? ` · locked: ${pin[1]}` : " · no lock recorded"}`]);
        for (const [label, value] of agent.rows) if (label !== "Locked by publishing") rows.push([`  ${label}`, value]);
    }
    const tests = publication.tests ?? [];
    rows.push(["Tests of this revision", tests.length
        ? tests.map(run => `${shortId(run.runId)} ${run.status}${run.outcome ? ` · ${run.outcome}` : ""}`).join("; ")
        : "None run. Publishing does not require a test"]);
    return rows;
}

/**
 * What the agent-versions read says about the draft a publication review shows, or null when it was not read for that
 * revision and hash: `agentText` while it is read or after it failed, `note` when the deployment locks no versions,
 * `problem` when publishing would be refused, else `byState` (state id -> the version publishing would lock).
 */
function publicationVersionsNow(publication, versionsNow) {
    if (!isRecord(versionsNow) || versionsNow.revision !== publication.revision) return null;
    if (versionsNow.phase === "loading") return { agentText: " · reading the version publishing would lock…" };
    if (versionsNow.phase === "failed") return { agentText: ` · the version now could not be read: ${text(versionsNow.error) ?? "no reason given"}` };
    const value = isRecord(versionsNow.value) ? versionsNow.value : null;
    if (!value || value.revision !== publication.revision || value.definitionHash !== publication.definitionHash) return null;
    if (value.resolves === false) {
        return { note: "This deployment locks no agent versions when publishing: each agent step uses the version current when it starts." };
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
 * The test review (design 05; mocks M18 to M20; R19, R20, R26, R28) given the
 * view's last command, or null: without `personCommands` (the deployment
 * takes no person's commands), when the workflow takes no test from people (a
 * host that does not run controller 1.9.0, or a workflow agent state's
 * subtree), and unless the definition is a draft (of-06, the owner's decision:
 * a published workflow is not tested). Never throws.
 *
 * A test runs the exact current revision of the draft with its definition
 * hash. Start is disabled, with the reason as its title, for a revision with
 * compile errors, a viewer who may not command the workflow, an unknown
 * revision or hash, and while a command is being sent.
 */
export function workflowV2TestControls(model, command = null) {
    if (!isRecord(model) || !isRecord(model.personCommands) || !isRecord(model.definition) || !isRecord(model.revision)) return null;
    const state = model.definition.state === "draft" ? "draft" : null;
    const commands = model.personCommands;
    if (state === null || !Array.isArray(commands.operations) || !commands.operations.includes("test")) return null;
    const viewer = isRecord(commands.viewer) ? commands.viewer : null;
    const denied = viewer?.allowed === false ? text(viewer.reason) ?? "You cannot command this workflow." : null;
    const busy = isRecord(command) && command.phase === "pending";
    const pending = busy && command.operation === "test";
    const revision = Number.isSafeInteger(model.revision.revision) && model.revision.revision >= 1 ? model.revision.revision : null;
    const definitionHash = text(model.revision.definitionHash);
    const valid = model.revision.valid === true;
    const errors = Array.isArray(model.revision.diagnostics)
        ? model.revision.diagnostics.filter(item => isRecord(item) && item.severity !== "warning").length : 0;
    const reason = busy ? (pending ? "This command is being sent." : "Another command for this workflow is being sent.")
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
export function workflowV2ScenarioDraft(source) {
    const name = typeof source === "string" ? source : "";
    if (!name.trim()) return { ok: true, value: undefined };
    return name.length > SCENARIO_MAX ? { ok: false, error: `A scenario name is at most ${SCENARIO_MAX} characters.` } : { ok: true, value: name };
}

/**
 * A test run's answers and clock (design 05; mocks M18 and M19; R19, R20,
 * R26) given the view's last command, or null: without `personCommands`
 * listing test_respond or test_advance (a host without controller 1.9.0, or
 * a workflow agent state's subtree), or unless the read model shows a test
 * run. `waiting` lists the run's held calls that wait for an answer
 * (`awaiting_parent`), with what the answer must match. `respond` and
 * `advance` say whether a person may answer and move the virtual clock now:
 * not once the run has ended, and not for a viewer who may not command the
 * workflow (`reason` says why). While a command is being sent (`busy`)
 * nothing else is sent.
 */
export function workflowV2TestResponder(model, command = null) {
    if (!isRecord(model) || !isRecord(model.personCommands) || !isRecord(model.run) || model.run.mode !== "test" || !isRecord(model.run.test)) return null;
    const operations = Array.isArray(model.personCommands.operations) ? model.personCommands.operations : [];
    const respond = operations.includes("test_respond"), advance = operations.includes("test_advance");
    if (!respond && !advance) return null;
    const run = model.run;
    if (typeof run.runId !== "string" || !run.runId) return null;
    const viewer = isRecord(model.personCommands.viewer) ? model.personCommands.viewer : null;
    const denied = viewer?.allowed === false ? text(viewer.reason) ?? "You cannot command this workflow." : null;
    const reason = !ACTIVE.has(run.status) ? `Test run ${shortId(run.runId)} has ended (${run.status}); its calls stay unanswered.` : denied;
    const states = Array.isArray(model.graph?.states) ? model.graph.states : [];
    // The run's interceptions as one list: its newest page and the waiting ones the page does not hold (workflowV2RunRows).
    const waiting = workflowV2RunRows(run).interceptions
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
export function workflowV2TestAnswerTemplate(waiting) {
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
export function workflowV2TestResponseDraft(kind, source) {
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
export function workflowV2AdvanceDraft(source) {
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
export function workflowV2DraftEditor(model, command = null) {
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
 * per line in line order ({ line, severity: "error" when any of its diagnostics is one, else "warning", texts: each
 * "CODE: message" }), and how many name no line (`unplaced`). Marks belong to the saved revision: an edit does not move
 * them, and saving checks the new text. Pure.
 */
export function workflowV2DraftMarks(diagnostics) {
    const byLine = new Map();
    let unplaced = 0;
    for (const item of Array.isArray(diagnostics) ? diagnostics : []) {
        if (!isRecord(item)) continue;
        if (!Number.isSafeInteger(item.line) || item.line < 1) { unplaced += 1; continue; }
        const entry = byLine.get(item.line) ?? { line: item.line, severity: "warning", texts: [] };
        if (item.severity !== "warning") entry.severity = "error";
        entry.texts.push(`${text(item.code) ? `${item.code}: ` : ""}${text(item.message) ?? "No message."}`);
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
export function workflowV2DraftEdit(base, textValue, model) {
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
export function workflowV2RunCommandConfirm(operation, runId, args = null) {
    const run = `run ${shortId(String(runId ?? ""))}`;
    if (operation === "set_vars") {
        const removed = Array.isArray(args?.delete) ? args.delete : [];
        if (!removed.length) return null;
        const set = isRecord(args?.set) ? Object.keys(args.set) : [];
        if (set.length) {
            return { title: "Update Workflow Variables", confirmLabel: "Update",
                message: `In one update of the variables of ${run}, set ${keyNames(set)} and remove ${keyNames(removed)}? Every other variable stays as it is. Steps that start from now on see the update; work already running keeps the values it started with.` };
        }
        const plural = removed.length > 1;
        return { title: plural ? "Remove Workflow Variables" : "Remove Workflow Variable", confirmLabel: "Remove",
            message: `Remove ${keyNames(removed)} from the variables of ${run}? Steps that start from now on do not see ${plural ? "them" : "it"}; work already running keeps the values it started with.` };
    }
    if (operation === "stop") {
        return { title: "Stop Workflow Run", confirmLabel: "Stop Run",
            message: `Stop ${run}? No new step starts; work already started may finish until its grace period ends, and then the run ends as stopped. A stop does not undo effects that already happened.` };
    }
    if (operation === "cancel") {
        return { title: "Cancel Workflow Run", confirmLabel: "Cancel Run",
            message: `Cancel ${run}? It ends now, and work in progress is interrupted. A cancel does not undo effects that already happened.` };
    }
    return null;
}

/**
 * The status line for an accepted control. An accepted stop or cancel is a
 * request the run's controller applies; the run's own status says when it
 * has ended.
 */
export function workflowV2RunCommandAccepted(operation, runId, receipt, args = null) {
    const run = `run ${shortId(String(runId ?? ""))}`;
    const again = isRecord(receipt) && receipt.replayed === true ? " It had already been accepted." : "";
    const status = isRecord(receipt) ? text(receipt.status) : null;
    if (operation === "replace_definition") {
        const saved = isRecord(receipt) && Number.isSafeInteger(receipt.revision) ? `revision ${receipt.revision}` : "a new revision";
        const errors = isRecord(receipt) && Array.isArray(receipt.diagnostics)
            ? receipt.diagnostics.filter(item => isRecord(item) && item.severity !== "warning").length : 0;
        const valid = isRecord(receipt) && receipt.valid === false
            ? ` It has ${errors || "unlisted"} error${errors === 1 ? "" : "s"}, so it cannot be published until they are fixed.` : "";
        return `Saved the draft as ${saved}.${valid}${again}`;
    }
    if (operation === "test_respond") {
        const interception = shortId(String(args?.interceptionId ?? receipt?.interceptionId ?? ""));
        const node = isRecord(receipt?.node) ? receipt.node : null;
        const decided = node && node.state !== "pending" && text(node.outcome)
            ? ` Step '${text(node.stateId) ?? "?"}' ended '${node.outcome}'.` : "";
        return `Answered call ${interception} of test ${run}.${decided}${again}`;
    }
    if (operation === "test_advance") {
        const seconds = isRecord(receipt) && Number.isSafeInteger(receipt.seconds) ? receipt.seconds : args?.seconds;
        const count = isRecord(receipt) && Array.isArray(receipt.decided) ? receipt.decided.length : 0;
        return `Advanced the virtual clock of test ${run} by ${seconds} second${seconds === 1 ? "" : "s"}: ${count} deadline${count === 1 ? "" : "s"} came due. Script clocks are real.${again}`;
    }
    if (operation === "test") {
        const tested = isRecord(receipt) && Number.isSafeInteger(receipt.revision) ? receipt.revision : args?.expectedRevision;
        const started = isRecord(receipt) && isRecord(receipt.run) && typeof receipt.run.runId === "string" ? ` ${shortId(receipt.run.runId)}` : "";
        const agents = args?.agentMode === "real" ? "real agents, which spend model tokens" : "mocked agents";
        return `Started test run${started} of revision ${tested ?? "shown"} with ${agents}. A test result is not evidence that the definition is safe to run live.${again}`;
    }
    if (DEFINITION_OPERATIONS.has(operation)) {
        const published = isRecord(receipt) && Number.isSafeInteger(receipt.publishedRevision) ? receipt.publishedRevision : args?.expectedRevision;
        const revision = Number.isSafeInteger(published) ? `revision ${published}` : "the revision";
        const started = isRecord(receipt) && isRecord(receipt.run) && typeof receipt.run.runId === "string" ? shortId(receipt.run.runId) : null;
        if (operation === "publish") return `Published ${revision}. It no longer changes; its live run starts only when someone starts it.${again}`;
        if (operation === "publish_and_start") return `Published ${revision} and started its live run${started ? ` ${started}` : ""}.${again}`;
        return `Started the live run${started ? ` ${started}` : ""} of published ${revision}.${again}`;
    }
    if (operation === "set_vars") {
        const set = isRecord(args?.set) ? Object.keys(args.set) : [];
        const removed = Array.isArray(args?.delete) ? args.delete : [];
        const parts = [set.length ? `set ${keyNames(set)}` : "", removed.length ? `removed ${keyNames(removed)}` : ""].filter(Boolean).join("; ");
        const revision = isRecord(receipt) && Number.isSafeInteger(receipt.kvRevision) ? ` (revision ${receipt.kvRevision})` : "";
        return `Variables of ${run} updated${parts ? `: ${parts}` : ""}${revision}. Steps that start from now on see them.${again}`;
    }
    if (operation === "pause") return `Paused ${run}: no new step starts; work already started finishes.${again}`;
    if (operation === "resume") return `Resumed ${run}${status ? ` (${status})` : ""}.${again}`;
    if (operation === "stop") return `Stop accepted for ${run}: no new step starts, and the run ends as stopped after its grace period.${again}`;
    return `Cancel accepted for ${run}: the run ends when its controller applies it.${again}`;
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
export function workflowV2RunCommandFailure(error) {
    const status = Number(error?.status);
    const refused = Number.isSafeInteger(status) && ((status >= 400 && status < 500) || status === 501);
    // A contract's refusal lists its problems (WORKFLOW_INPUT_INVALID: a list; TEST_RESPONSE_INVALID: { problems }, or the
    // state's outcomes); the first few are shown with it.
    const listed = Array.isArray(error?.details) ? error.details : Array.isArray(error?.details?.problems) ? error.details.problems : [];
    const problems = listed.filter(item => isRecord(item) && typeof item.message === "string")
        .slice(0, 3).map(item => `${typeof item.path === "string" && item.path ? `${item.path}: ` : ""}${item.message}`);
    if (!problems.length && Array.isArray(error?.details?.outcomes)) {
        problems.push(`Its outcomes are ${error.details.outcomes.filter(item => typeof item === "string").join(", ")}`);
    }
    const message = bounded(`${String(error?.message || error || "The request failed.")}${problems.length ? ` ${problems.join("; ")}` : ""}`);
    return { phase: refused ? "failed" : "unconfirmed", message, code: typeof error?.code === "string" ? error.code : null };
}

/**
 * What the view shows about the last control that did not succeed, beside
 * the graph, or null: a refusal with its reason, or an unconfirmed send
 * that Retry sends again (the same command and operation id).
 */
export function workflowV2RunCommandNotice(command) {
    if (!isRecord(command) || !NOTICE_LABELS[command.operation] || (command.phase !== "failed" && command.phase !== "unconfirmed")) return null;
    const label = NOTICE_LABELS[command.operation];
    const run = typeof command.runId === "string" ? command.runId : "";
    // A definition command names no run.
    const target = run ? ` for run ${shortId(run)}` : "";
    const given = typeof command.message === "string" && command.message ? command.message : "No reason was given.";
    const message = /[.!?…]$/.test(given) ? given : `${given}.`;
    return command.phase === "failed"
        ? { level: "error", operation: command.operation, runId: run, retry: false,
            text: `${label} was refused${target}: ${message}` }
        : { level: "warning", operation: command.operation, runId: run, retry: true,
            text: `${label}${target} may not have reached the workflow: ${message} Retry sends the same command again.` };
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
export function workflowV2LineDiff(before, after) {
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
export function workflowV2RevisionCompare(reads, from, to) {
    const side = revision => {
        const entry = isRecord(reads) ? reads[revision] : null;
        const value = isRecord(entry?.value?.definitionRevision) ? entry.value.definitionRevision : null;
        return { revision, phase: entry?.phase ?? "missing", error: text(entry?.error), text: value ? (text(value.formatted) ?? String(value.yaml ?? "")) : null,
            formatted: Boolean(value && text(value.formatted)), valid: value ? value.valid === true : null };
    };
    const before = side(from), after = side(to);
    const failed = [before, after].find(item => item.phase === "failed") ?? null;
    const ready = before.text !== null && after.text !== null;
    const diff = ready ? workflowV2LineDiff(before.text, after.text) : null;
    const summary = failed ? `Revision ${failed.revision} could not be read: ${failed.error ?? "no reason given"}`
        : !ready ? `Reading revisions ${from} and ${to}…`
            : diff.added || diff.removed ? `Revision ${from} → ${to}: ${diff.added} line${diff.added === 1 ? "" : "s"} added, ${diff.removed} removed`
                : `Revisions ${from} and ${to} are the same.`;
    return { before, after, ready, failed, diff, summary };
}

/** What an agent step's input field can take its value from (owner decision q6), in the words the editor shows. */
export const WORKFLOW_V2_STEP_INPUT_SOURCE_LABELS = Object.freeze({
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
 * then waits (workflowV2StepInputLoadWaiting takes it); another step, or unchanged fields, take the reading as it is.
 * Pure.
 */
export function workflowV2StepInputEditorState(previous, { step, value }) {
    if (previous && previous.dirty && previous.step === step) {
        if (!value || previous.waiting === value) return previous;
        return { ...previous, waiting: value };
    }
    if (previous && !previous.dirty && previous.step === step && previous.reading === value) return previous;
    return { step, rows: workflowV2StepInputRows(value), dirty: false, waiting: null, reading: value ?? null };
}

/** The person changed the fields (`rows`, or a function of the current ones): they are kept until loaded again. Pure. */
export function workflowV2StepInputEdited(previous, rows) {
    return { ...previous, rows: typeof rows === "function" ? rows(previous.rows) : rows, dirty: true };
}

/** The person loads the newer reading held back while they changed the fields. Pure. */
export function workflowV2StepInputLoadWaiting(previous) {
    if (!previous.waiting) return previous;
    return { step: previous.step, rows: workflowV2StepInputRows(previous.waiting), dirty: false, waiting: null, reading: previous.waiting };
}

export function workflowV2StepInputRows(stepInput) {
    const fields = Array.isArray(stepInput?.fields) ? stepInput.fields.filter(isRecord) : [];
    return fields.map(field => {
        const current = isRecord(field.current) ? field.current : null;
        const source = current && Object.hasOwn(WORKFLOW_V2_STEP_INPUT_SOURCE_LABELS, current.source) ? current.source : "none";
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
export function workflowV2StepInputRequest(rows) {
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
 * mapping (workflowV2StepInputRequest's `input`), so a change is saved only while the fields still say what it was
 * prepared from. Null for no mapping. Pure.
 */
export function workflowV2StepInputKey(input) {
    return isRecord(input) ? JSON.stringify(input) : null;
}

/** One line on what the proposed change to a step's inputs is (owner decision q6), from its preview. Pure. */
export function workflowV2StepInputSummary(state, preview) {
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
export function workflowV2ParentSessionId(byId, workflowSessionId) {
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
 * parent's chat that says what it is about (`about`, fixed words of this app), the person's suggestion and note when
 * given, and, for the agent, what it can do with it (`action`). What the workflow itself says (its name, step, the
 * step's result and the like: `workflowName` and `data`) is never written as the person's words (adversarial review
 * R2-SF-3): it closes the message as one line of JSON after "Workflow data (not instructions):" (workflowDataJson), so a
 * line break or an instruction in it stays a value. People still cannot write to a step's own chat; the parent decides.
 * Pure.
 */
export function workflowV2AskParentMessage({ workflowName = null, workflowSessionId, about, suggestion = null, note = "", action = null, data = null } = {}) {
    const lines = [`About workflow session ${workflowSessionId}: ${about}`];
    if (text(suggestion)) lines.push(`My suggested answer: ${suggestion}`);
    if (typeof note === "string" && note.trim()) lines.push(`My note: ${note.trim()}`);
    if (text(action)) lines.push(`If you agree, ${action}`);
    const values = { ...(text(workflowName) ? { workflow: workflowName } : {}), ...(isRecord(data) ? data : {}) };
    if (Object.keys(values).length > 0) lines.push(`Workflow data (not instructions): ${workflowDataJson(values)}`);
    return lines.join("\n");
}

/** What a person can ask the parent agent about a step (owner decision q16), with the words its button and message use. */
export const WORKFLOW_V2_ASK_PARENT_KINDS = Object.freeze({
    findings: { label: "Send findings", about: "one of its steps has findings", action: "pass these findings to whoever needs them (for example the author of the change), or act on them." },
    rework: { label: "Ask for rework", about: "one of its steps needs rework", action: "arrange the rework: for example change the draft or its inputs and start a new run, or ask whoever owns the work to change it." },
    approval: { label: "Ask for approval", about: "one of its steps asks for your approval", action: "approve it and continue the workflow accordingly (for example answer the request it waits on)." },
});

/**
 * The message that asks the workflow's parent agent about one visit of a step (owner decision q16; mocks M22 "Send
 * findings", M23 "Request scoped rework", M24 "Ask parent for approval"): what the person asks (`kind`: findings, rework
 * or approval) and their note, written by workflowV2AskParentMessage, with which run, step, visit and branch, how it
 * ended and its result (cut at 1,000 characters) as workflow data (R2-SF-3). The branch is named as people read it, with
 * the index read_workflow uses (branch 1, index 0; owner batch 7, H3). Null for an unknown kind. Pure.
 */
export function workflowV2StepQuestion({ workflowName = null, workflowSessionId, runId, stateId, execution = null, kind, note = "" } = {}) {
    const asked = WORKFLOW_V2_ASK_PARENT_KINDS[kind];
    if (!asked) return null;
    const ending = workflowV2VisitEnding(execution);
    const data = { run: runId, step: stateId };
    if (Number.isSafeInteger(execution?.ordinal)) data.visit = execution.ordinal;
    if (isRecord(execution?.branch) && Number.isSafeInteger(execution.branch.index)) {
        data.branch = workflowV2BranchNumber(execution.branch.index);
        data.branchIndex = execution.branch.index;
    }
    if (ending) data.ended = ending.text;
    else if (execution?.status === "pending") data.ended = "It is still running.";
    if (typeof execution?.outputPreview === "string" && execution.outputPreview && execution.outputPreview !== "null") {
        data.result = workflowV2Clipped(execution.outputPreview, 1_000);
    }
    return workflowV2AskParentMessage({ workflowName, workflowSessionId, about: `${asked.about} (the workflow data below says which step, and how it ended).`,
        note, action: asked.action, data });
}

/**
 * The message that sends a person's answer to a test's held call through the parent agent (owner decision q12; mock
 * M18): the answer the person suggests (a success value, an error or a cancel, as the answer form drafted it,
 * `response`; null for none), their note and the parent's own way to answer it (update_workflow test_respond with exactly
 * these ids and that answer), with the test run, the held call and its step as workflow data (R2-SF-3). A long value is
 * cut. Pure.
 */
export function workflowV2HeldCallQuestion({ workflowName = null, workflowSessionId, runId, call, response = null, note = "" } = {}) {
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
    return workflowV2AskParentMessage({ workflowName, workflowSessionId, about: "a call held in its test run waits for an answer (the workflow data below says which call).",
        suggestion, note, action, data });
}

/** What the status line says once a message reached the parent agent's chat (q12, q16). Pure. */
export function workflowV2AskParentSent(parentSessionId) {
    return `Sent to the parent agent's chat (session ${shortSession(parentSessionId)}). It answers with its own tools; open its chat from the session list.`;
}

/**
 * Where a held call's answer came from, in plain words (the owner's plain-words rule): a prepared answer (stored
 * disposition "fixture") or the parent agent ("parent"); any other value as it is, and `fallback` for none. Display
 * only: the stored value does not change. Pure.
 */
export function workflowV2AnswerSourceText(disposition, fallback = "not known") {
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

/** A sample of one value of `schema`, named `name` (its property name), or undefined when the schema says nothing usable. */
function sampleOf(schema, name, depth, budget) {
    if (depth > SAMPLE_MAX_DEPTH) return null;
    if (schema === true || schema === undefined) return undefined;
    if (!isRecord(schema)) return undefined;
    const sources = [
        Array.isArray(schema.examples) && schema.examples.length ? [schema.examples[0]] : [],
        Object.hasOwn(schema, "default") ? [schema.default] : [],
        Array.isArray(schema.enum) && schema.enum.length ? [schema.enum[0]] : [],
        Object.hasOwn(schema, "const") ? [schema.const] : [],
    ].flat();
    for (const source of sources) {
        const given = givenValue(budget, source);
        if (given !== undefined) return given;
    }
    for (const key of ["oneOf", "anyOf"]) {
        if (Array.isArray(schema[key]) && schema[key].length) {
            const value = sampleOf(schema[key].find(item => !(isRecord(item) && item.type === "null")) ?? schema[key][0], name, depth + 1, budget);
            if (value !== undefined) return value;
        }
    }
    if (Array.isArray(schema.allOf) && schema.allOf.length) {
        const parts = schema.allOf.map(part => sampleOf(part, name, depth + 1, budget)).filter(value => value !== undefined);
        if (parts.length && parts.every(isRecord)) return Object.assign({}, ...parts);
        if (parts.length) return parts[0];
    }
    // A long name gives no longer a text than this (UI-3 verification).
    const words = sampleWords(name).slice(0, 60).trim();
    switch (sampleType(schema)) {
        case "string": {
            const format = typeof schema.format === "string" ? schema.format : "";
            const slug = words.replace(/\s+/g, "-") || "item";
            let value = format === "date-time" ? "2026-01-01T09:00:00Z" : format === "date" ? "2026-01-01" : format === "time" ? "09:00:00"
                : format === "uri" || format === "url" || format === "iri" ? `https://example.com/${slug}`
                    : format === "email" ? `${slug.replace(/-/g, ".")}@example.com`
                        : format === "uuid" ? "00000000-0000-4000-8000-000000000000"
                            : words ? `example ${words}` : "example";
            if (Number.isSafeInteger(schema.maxLength) && schema.maxLength >= 0 && value.length > schema.maxLength) value = value.slice(0, schema.maxLength);
            // UI-3: checked before anything is allocated.
            if (typeof schema.minLength === "number" && schema.minLength > SAMPLE_MAX_STRING) throw SAMPLE_OVER_BUDGET;
            if (Number.isSafeInteger(schema.minLength) && value.length < schema.minLength) value = value.padEnd(schema.minLength, "x");
            chargeSample(budget, value.length + 2);
            return value;
        }
        case "integer":
        case "number": {
            const integer = sampleType(schema) === "integer";
            if (typeof schema.minimum === "number") return integer ? Math.ceil(schema.minimum) : schema.minimum;
            if (typeof schema.exclusiveMinimum === "number") return integer ? Math.floor(schema.exclusiveMinimum) + 1 : schema.exclusiveMinimum + 1;
            if (typeof schema.maximum === "number" && schema.maximum < 1) return integer ? Math.floor(schema.maximum) : schema.maximum;
            return 1;
        }
        case "boolean": return false;
        case "null": return null;
        case "array": {
            const item = sampleOf(Array.isArray(schema.items) ? schema.items[0] : schema.items, name, depth + 1, budget);
            const count = Number.isSafeInteger(schema.minItems) && schema.minItems > 1 ? Math.min(schema.minItems, 3) : 1;
            if (item === undefined) return [];
            // The copies after the first count too (the item's own characters were counted once).
            if (count > 1) chargeSample(budget, (JSON.stringify(item)?.length ?? 4) * (count - 1));
            return Array.from({ length: count }, () => item);
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
                const value = sampleOf(properties[key], key, depth + 1, budget);
                if (value !== undefined) { out[key] = value; continue; }
                const fallback = `example ${sampleWords(key).slice(0, 60).trim() || "value"}`;
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
 * date, time, URL, e-mail address or UUID for those formats), the minimum or 1 for a number, false for a boolean, one
 * sample item for an array, and for an object its required properties (all of them when it has four or fewer). A JSON
 * object, or null when there is no schema or it does not describe an object (the box then keeps "{}"). Pure.
 */
export function workflowV2SampleInputs(schema) {
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

/** The text of a JSON box that a sample may fill: empty, or an empty object as written ("{}" with any spacing). */
export function workflowV2InputsBoxEmpty(textValue) {
    return typeof textValue !== "string" || /^\s*(\{\s*\})?\s*$/.test(textValue);
}
