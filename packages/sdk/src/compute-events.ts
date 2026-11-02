/**
 * Which session events are PilotSwarm's own word, and what happens when a
 * remote agent runtime claims one of them
 * (docs/proposals/compute-providers.md, "What the worker takes from a
 * host").
 *
 * A session's events are read as a record of what happened, and some of
 * them do more than record: the worker acts on them, and a reader takes
 * them as PilotSwarm saying so. A runtime that runs as the worker's own
 * child process is the worker's own code, so there was never a question of
 * where an event came from. A runtime on a compute host is not: it is
 * model-chosen code on somebody else's machine, and everything it sends
 * back is checked here.
 *
 * So the types below are the worker's to emit. A remote runtime that sends
 * one is not refused — refusing it would lose the fact that it happened —
 * but it is recorded under a name that says plainly who said it, and
 * nothing acts on it.
 *
 * Everything else a runtime sends is its own to send: the assistant's
 * messages, its tool calls, its usage, its idle and its errors. Those are
 * what a runtime is for.
 */

/** What a claimed event is recorded as. */
export const CLAIMED_EVENT_PREFIX = "unverified.";

/**
 * Event types the worker emits about a session, which a remote runtime
 * must not put its own name to.
 *
 * Built by hand from the worker's own `onEvent` calls rather than by a
 * pattern, because two namespaces are shared: a runtime legitimately sends
 * `session.idle`, `session.error`, `session.usage_info`,
 * `session.compaction_start`, `session.compaction_complete` and
 * `session.background_tasks_changed`, and the worker reads those as the
 * runtime's report of itself.
 *
 * Adding an event the worker emits means adding it here. The test for this
 * file checks the two that drive CMS state directly, which is where a
 * forged one would do most.
 */
export const WORKER_OWNED_EVENT_TYPES: ReadonlySet<string> = new Set([
    // These two change what the CMS says the session is doing, and what a
    // person is shown as the reason.
    "session.wait_started",
    "session.input_required_started",
    // The rest of the worker's own account of a session's life.
    "session.wait_completed",
    "session.cron_started",
    "session.cron_fired",
    "session.command_received",
    "session.command_completed",
    "session.agent_spawned",
    "session.lossy_handoff",
    "session.turn_started",
    "session.hydrated",
    "session.dehydrated",
    "session.hydration",
    "session.dehydration",
    "session.affinity_released",
    "session.snapshot_unpublished",
    "session.snapshot_store_empty",
    "session.snapshot_regressed",
    "session.budget_paused",
    "session.bound_agent_restored",
    "session.model_resolved",
    "session.model_mismatch",
    "session.prompt_sections",
    "session.prompt_layers",
    "session.artifact_presented",
    "session.canvas_updated",
    "session.canvas_presented",
    "session.canvas_data",
    "session.canvas_app_published",
    "session.workspace_opened",
    "session.workspace_released",
    "session.workspace_unavailable",
    "session.workspace_adopted",
    "session.workspace_defaults",
    "session.native_tasks_tick",
    "session.compute_capabilities",
    "session.compute_bound",
    "session.compute_connected",
    "session.compute_host_replaced",
    "session.compute_released",
    "pending_messages.cancelled",
    "assistant.live_tick",
    "runtime.tool_call_as_text",
    "runtime.required_tool_not_invoked",
    "runtime.attachment_dropped",
]);

/**
 * Whether this type is the worker's to emit. Everything under `system.` is
 * too: that namespace is PilotSwarm telling a session something, and a
 * runtime has no business writing in it.
 */
export function isWorkerOwnedEventType(eventType: string): boolean {
    return typeof eventType === "string"
        && (eventType.startsWith("system.") || WORKER_OWNED_EVENT_TYPES.has(eventType));
}

/**
 * The name one event from a remote runtime is recorded under: its own when
 * the runtime may send it, and a marked one when it may not.
 */
export function remoteRuntimeEventType(eventType: string): string {
    return isWorkerOwnedEventType(eventType) ? `${CLAIMED_EVENT_PREFIX}${eventType}` : eventType;
}
