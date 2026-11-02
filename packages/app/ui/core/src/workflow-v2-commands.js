/**
 * Workflow v2: a person's run controls in the workflow view (design 04 and 07,
 * mocks M04 and M16; R17, R26; INACTIVE). Pure: nothing here calls anything.
 * The controller sends a control (sendWorkflowRunCommand) as an
 * updateWorkflow command through the transport; this module says which
 * controls a run offers and what the view shows about the last one.
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
    const restriction = isRecord(commands.restriction) ? (() => {
        const reason = text(commands.restriction.reason) ?? "This workflow runs in a workflow agent state's subtree: people can only pause, stop or cancel it.";
        const controlling = text(commands.restriction.controllingSessionId);
        return controlling ? `${reason} Its controlling agent is session ${controlling}.` : reason;
    })() : null;
    return { runId: run.runId, mode: run.mode === "test" ? "test" : "live", controls, busy, restriction, viewerReason: denied };
}

/**
 * The confirm dialog of a control that ends work (stop and cancel; mock M16:
 * neither undoes effects that already happened), or null for one that needs
 * none.
 */
export function workflowV2RunCommandConfirm(operation, runId) {
    const run = `run ${shortId(String(runId ?? ""))}`;
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
export function workflowV2RunCommandAccepted(operation, runId, receipt) {
    const run = `run ${shortId(String(runId ?? ""))}`;
    const again = isRecord(receipt) && receipt.replayed === true ? " It had already been accepted." : "";
    const status = isRecord(receipt) ? text(receipt.status) : null;
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
    if (!isRecord(command) || !LABELS[command.operation] || (command.phase !== "failed" && command.phase !== "unconfirmed")) return null;
    const label = LABELS[command.operation];
    const run = typeof command.runId === "string" ? command.runId : "";
    const given = typeof command.message === "string" && command.message ? command.message : "No reason was given.";
    const message = /[.!?…]$/.test(given) ? given : `${given}.`;
    return command.phase === "failed"
        ? { level: "error", operation: command.operation, runId: run, retry: false,
            text: `${label} was refused for run ${shortId(run)}: ${message}` }
        : { level: "warning", operation: command.operation, runId: run, retry: true,
            text: `${label} for run ${shortId(run)} may not have reached the workflow: ${message} Retry sends the same command again.` };
}
