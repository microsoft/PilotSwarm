/**
 * Start sessions at a pinned orchestration version.
 *
 * PilotSwarmClient always starts a session at DURABLE_SESSION_LATEST_VERSION.
 * Tests that must prove a frozen version still runs (C4 in
 * docs/proposals/session-workspaces.md) wrap the client's Duroxide client so
 * the next session start uses the given version. Workers register every
 * frozen handler, so no recorded history is needed.
 */
import { DURABLE_SESSION_ORCHESTRATION_NAME, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../src/orchestration-registry.ts";

/**
 * Pin session starts on a started client to `version`.
 *
 * @param {object} client  - a started PilotSwarmClient
 * @param {string} version - a registered version, for example "1.0.78"
 * @param {object} [opts]
 * @param {string} [opts.sessionId] - pin only this session; default: every session
 * @returns {{ starts: Array<{ orchestrationId, requested, used }>, restore: () => void }}
 */
export function pinSessionStartVersion(client, version, { sessionId } = {}) {
    if (!DURABLE_SESSION_ORCHESTRATION_REGISTRY.some((entry) => entry.version === version)) {
        throw new Error(`orchestration version ${version} is not registered`);
    }
    const duroxide = client._getDuroxideClient();
    if (!duroxide) throw new Error("start the client before pinning a version");
    const original = duroxide.startOrchestrationVersioned;
    const starts = [];
    duroxide.startOrchestrationVersioned = function (orchestrationId, name, input, requested) {
        const pinned = name === DURABLE_SESSION_ORCHESTRATION_NAME
            && (!sessionId || orchestrationId === `session-${sessionId}`);
        const used = pinned ? version : requested;
        starts.push({ orchestrationId, requested, used });
        return original.call(this, orchestrationId, name, input, used);
    };
    return {
        starts,
        restore() {
            duroxide.startOrchestrationVersioned = original;
        },
    };
}

/** The version a session orchestration runs, from Duroxide's instance record. */
export async function sessionOrchestrationVersion(client, sessionId) {
    const info = await client._getDuroxideClient().getInstanceInfo(`session-${sessionId}`);
    return info?.orchestrationVersion ?? null;
}
