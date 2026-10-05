/**
 * Which events a turn result carries.
 *
 * The runTurn activity returns a TurnResult. duroxide stores it in the
 * orchestrator queue and then in the orchestration history, and every later
 * fetch of the orchestration loads it again until the next continue-as-new.
 * The session lifecycle also writes it to `.ps-turn-commit.json`, which is
 * part of the session snapshot.
 *
 * The orchestration reads only a few event types from `TurnResult.events`
 * (ORCHESTRATION_TURN_EVENT_TYPES). Nothing in `events` is sent to the model:
 * the conversation lives in the Copilot session itself. The CMS and live
 * viewers get every event through `onEvent` while the turn runs. So the
 * activity result keeps only what the orchestration reads. Before, one tool
 * call with a large argument streamed thousands of
 * `assistant.tool_call_delta` events into it, and turn results reached
 * 100–400 MB (issue #121).
 */

import type { CapturedEvent } from "./types.js";

/**
 * Streaming fragments and live ticks. Live consumers (onEvent) see them; they
 * are never written to the CMS and never part of a turn result.
 */
export const STREAMING_EVENT_TYPES: ReadonlySet<string> = new Set([
    "assistant.live_tick",
    "session.native_tasks_tick",
    "session.background_tasks_changed",
    "native.session.background_tasks_changed",
    "assistant.message_delta",
    "assistant.streaming_delta",
    "assistant.reasoning_delta",
    "reasoning_delta",
    // Tool-call argument streaming fragments. The assembled call is recorded
    // as tool.execution_start.
    "assistant.tool_call_delta",
]);

/**
 * Event types ManagedSession does not keep in a turn's collected events: the
 * streaming types, and `model.messages_snapshot`, a full copy of the
 * conversation (1–14 MB each in the data behind #121). Nothing in the turn
 * reads them back. Live consumers still get them through `onEvent`.
 */
export const TURN_RESULT_EXCLUDED_EVENT_TYPES: ReadonlySet<string> = new Set([
    ...STREAMING_EVENT_TYPES,
    "model.messages_snapshot",
]);

/**
 * Event types the orchestration reads from `TurnResult.events`, in every
 * registered version: context-usage numbers (`updateContextUsageFromEvents`)
 * and the failed-model-switch check (`detectFailedModelSwitch`). The runTurn
 * activity result keeps these and no others.
 */
export const ORCHESTRATION_TURN_EVENT_TYPES: ReadonlySet<string> = new Set([
    "session.usage_info",
    "assistant.usage",
    "session.compaction_start",
    "session.compaction_complete",
    "tool.execution_complete",
]);

/** A turn result larger than this is logged as a warning. Nothing is dropped. */
export const TURN_RESULT_WARNING_BYTES = 4 * 1024 * 1024;

/** The warning names at most this many event types. */
const MAX_TYPES_IN_WARNING = 5;

function serializedBytes(value: unknown): number {
    try {
        return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    } catch {
        return 0;
    }
}

/**
 * The turn result with `events` cut down to ORCHESTRATION_TURN_EVENT_TYPES.
 * Returns the same object when nothing is removed.
 */
export function keepOrchestrationTurnEvents<T>(result: T): T {
    const events = (result as { events?: unknown } | null | undefined)?.events;
    if (!Array.isArray(events)) return result;
    const kept = events.filter((event: CapturedEvent | undefined) =>
        ORCHESTRATION_TURN_EVENT_TYPES.has(String(event?.eventType ?? "")));
    if (kept.length === events.length) return result;
    return { ...result, events: kept };
}

/**
 * One warning line when the serialized turn result is over `limitBytes`:
 * its size, the bytes in `events` and the largest event types. Null under
 * the limit.
 */
export function turnResultSizeWarning(result: unknown, limitBytes: number = TURN_RESULT_WARNING_BYTES): string | null {
    const bytes = serializedBytes(result);
    if (bytes <= limitBytes) return null;
    const events = (result as { events?: unknown } | null | undefined)?.events;
    const byType = new Map<string, { count: number; bytes: number }>();
    let eventBytes = 0;
    if (Array.isArray(events)) {
        for (const event of events as CapturedEvent[]) {
            const size = serializedBytes(event);
            eventBytes += size;
            const type = String(event?.eventType ?? "unknown");
            const entry = byType.get(type) ?? { count: 0, bytes: 0 };
            entry.count++;
            entry.bytes += size;
            byType.set(type, entry);
        }
    }
    const largest = [...byType.entries()]
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .slice(0, MAX_TYPES_IN_WARNING)
        .map(([type, entry]) => `${type} x${entry.count} = ${entry.bytes} bytes`)
        .join(", ");
    return `turn result is ${bytes} bytes (warning above ${limitBytes}); events ${eventBytes} bytes`
        + (largest ? ` (${largest})` : "")
        + `; other fields ${Math.max(0, bytes - eventBytes)} bytes`;
}
