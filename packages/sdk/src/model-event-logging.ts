/**
 * Recording of the Copilot CLI's large `model.*` trace events in the CMS.
 *
 * The CLI emits `model.*` events that copy the conversation: the full
 * message list sent to the model on every turn (`model.messages_snapshot`),
 * each message again (`model.message`), each tool execution and each model
 * call result. Nothing in PilotSwarm reads them, and the same content is
 * already recorded as `user.message`, `assistant.message`,
 * `tool.execution_start`, `tool.execution_complete` and so on. They made up
 * most of the session event log, so by default the CMS skips them.
 *
 * The feature flag `debug.enable_model_event_logging` turns their recording
 * back on, for the cluster or for one person's sessions (resolved by the
 * session owner, like every feature flag).
 */

import type { FeatureFlagCache } from "./feature-flag-cache.js";
import type { FeatureOwner } from "./feature-flags.js";

export const MODEL_EVENT_LOGGING_FEATURE = "debug.enable_model_event_logging";

/**
 * Event types the CMS records only while model event logging is on.
 * `hook.start` is left out on purpose: it is recorded either way.
 */
export const MODEL_EVENT_TYPES_RECORDED_WHEN_LOGGING: ReadonlySet<string> = new Set([
    "model.message",
    "model.messages_snapshot",
    "model.tool_execution",
    "model.model_call_success",
]);

/**
 * Whether the CMS records MODEL_EVENT_TYPES_RECORDED_WHEN_LOGGING for a
 * session with this owner. Reads the worker's in-memory feature cache (no
 * database read). Off when the cache is missing or not loaded yet. A session
 * without an owner follows the cluster setting.
 */
export function modelEventLoggingEnabled(
    cache: Pick<FeatureFlagCache, "resolve"> | null | undefined,
    owner: { provider?: string | null; subject?: string | null } | null | undefined,
): boolean {
    if (!cache) return false;
    const featureOwner: FeatureOwner | null = owner?.provider && owner?.subject
        ? { provider: owner.provider, subject: owner.subject }
        : null;
    return cache.resolve(MODEL_EVENT_LOGGING_FEATURE, featureOwner, { fallback: false }).enabled === true;
}
