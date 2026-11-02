/**
 * Workflow v2: a person's run commands in the workflow view (design 04 and
 * 07, mocks M04, M15 and M16; R04, R05, R17, R26; INACTIVE): the run controls
 * (pause, resume, stop, cancel) and the run's variables (set_vars: set or
 * remove a key at the expected KV revision). Pure: nothing here calls
 * anything. The controller sends a command (sendWorkflowRunCommand) as an
 * updateWorkflow command through the transport; this module says which
 * commands a run offers, checks what a person typed, and says what the view
 * shows about the last command.
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
const NOTICE_LABELS = { ...LABELS, set_vars: "The variables update" };
/** The longest KV key (store.ts WORKFLOW_V2_KV_LIMITS.maxKeyLength). */
const KV_KEY_MAX = 128;
/** The longest value shown in the variables list; editing uses the whole value. */
const VALUE_DISPLAY_LIMIT = 300;
const PENDING_LABELS = { pause: "Pausing…", resume: "Resuming…", stop: "Stopping…", cancel: "Cancelling…" };
const TITLES = {
    pause: "Pause the run: no new state starts; work already started finishes and its result is kept.",
    resume: "Resume the run: states start again from where it was paused.",
    stop: "Stop the run gracefully: no new state starts, work already started may finish until its grace period ends, and then the run ends as stopped.",
    cancel: "Cancel the run: it ends now, and work in progress is interrupted.",
};
const MESSAGE_LIMIT = 300;

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value ? value : null;
/** A long id keeps its start and its end; the title or the message carries the whole id where it matters. */
const shortId = id => id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
const bounded = value => value.length > MESSAGE_LIMIT ? `${value.slice(0, MESSAGE_LIMIT - 1)}…` : value;

/** "'a'", "'a' and 'b'", "'a', 'b', 'c' and 2 more". */
function keyNames(keys) {
    const shown = keys.slice(0, 3).map(key => `'${key.length > 40 ? `${key.slice(0, 39)}…` : key}'`);
    const more = keys.length - shown.length;
    if (more > 0) return `${shown.join(", ")} and ${more} more`;
    return shown.length < 2 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** Why a workflow in a workflow agent state's subtree takes only a person's brakes, naming its controlling agent, or null. */
function restrictionText(commands) {
    if (!isRecord(commands.restriction)) return null;
    const reason = text(commands.restriction.reason) ?? "This workflow runs in a workflow agent state's subtree: people can only pause, stop or cancel it.";
    const controlling = text(commands.restriction.controllingSessionId);
    return controlling ? `${reason} Its controlling agent is session ${controlling}.` : reason;
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
    if (operation !== "set_vars" || !isRecord(input)) return { ok: false };
    const set = input.set === undefined ? {} : input.set;
    const removed = input.delete === undefined ? [] : input.delete;
    if (!isRecord(set) || !Array.isArray(removed) || removed.some(key => typeof key !== "string")) return { ok: false };
    const keys = [...Object.keys(set), ...removed];
    if (keys.length === 0 || keys.some(key => key.length < 1 || key.length > KV_KEY_MAX) || new Set(keys).size !== keys.length) return { ok: false };
    if (!Number.isSafeInteger(input.expectedKvRevision) || input.expectedKvRevision < 1) return { ok: false };
    return { ok: true, args: { set, delete: removed, expectedKvRevision: input.expectedKvRevision } };
}

/** The updateWorkflow command a checked command is sent as: always for the named run, with its own operation id. */
export function workflowV2RunCommandWire(operation, runId, operationId, args = null) {
    const command = { operation, operation_id: operationId, run_id: runId };
    if (!args) return command;
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
 * The confirm dialog of a command that ends work or loses data, or null for
 * one that needs none: stop and cancel (mock M16: neither undoes effects
 * that already happened), and a variables update that removes keys.
 */
export function workflowV2RunCommandConfirm(operation, runId, args = null) {
    const run = `run ${shortId(String(runId ?? ""))}`;
    if (operation === "set_vars") {
        const removed = Array.isArray(args?.delete) ? args.delete : [];
        if (!removed.length) return null;
        const plural = removed.length > 1;
        return { title: plural ? "Remove Workflow Variables" : "Remove Workflow Variable", confirmLabel: "Remove",
            message: `Remove ${keyNames(removed)} from the variables of ${run}? States that start from now on do not see ${plural ? "them" : "it"}; work already running keeps the values it started with.` };
    }
    if (operation === "stop") {
        return { title: "Stop Workflow Run", confirmLabel: "Stop Run",
            message: `Stop ${run}? No new state starts; work already started may finish until its grace period ends, and then the run ends as stopped. A stop does not undo effects that already happened.` };
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
    if (operation === "set_vars") {
        const set = isRecord(args?.set) ? Object.keys(args.set) : [];
        const removed = Array.isArray(args?.delete) ? args.delete : [];
        const parts = [set.length ? `set ${keyNames(set)}` : "", removed.length ? `removed ${keyNames(removed)}` : ""].filter(Boolean).join("; ");
        const revision = isRecord(receipt) && Number.isSafeInteger(receipt.kvRevision) ? ` (revision ${receipt.kvRevision})` : "";
        return `Variables of ${run} updated${parts ? `: ${parts}` : ""}${revision}. States that start from now on see them.${again}`;
    }
    if (operation === "pause") return `Paused ${run}: no new state starts; work already started finishes.${again}`;
    if (operation === "resume") return `Resumed ${run}${status ? ` (${status})` : ""}.${again}`;
    if (operation === "stop") return `Stop accepted for ${run}: no new state starts, and the run ends as stopped after its grace period.${again}`;
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
    const message = bounded(String(error?.message || error || "The request failed."));
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
    const given = typeof command.message === "string" && command.message ? command.message : "No reason was given.";
    const message = /[.!?…]$/.test(given) ? given : `${given}.`;
    return command.phase === "failed"
        ? { level: "error", operation: command.operation, runId: run, retry: false,
            text: `${label} was refused for run ${shortId(run)}: ${message}` }
        : { level: "warning", operation: command.operation, runId: run, retry: true,
            text: `${label} for run ${shortId(run)} may not have reached the workflow: ${message} Retry sends the same command again.` };
}
