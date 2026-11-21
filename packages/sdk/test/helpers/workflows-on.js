/**
 * Workflows on demand (owner 2026-11-08T16:55Z): a session has the Workflow tools only when they are on in it. A test whose
 * scripted model calls a Workflow tool in a new session turns them on first, as enable_workflows would, by saving the session's
 * flag with its capability state (revision-checked). workflow-context-on-demand-e2e.test.js covers enable_workflows itself.
 */
import { withWorkflowsOn } from "../../src/capability-catalog.ts";

/** Turn Workflows on in `sessionId` (the session row must exist: call after createSession, before the first prompt). */
export async function turnWorkflowsOn(catalog, sessionId) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const state = await catalog.getSessionCapabilities(sessionId);
        const next = withWorkflowsOn(state);
        if (next === state || await catalog.saveSessionCapabilities(sessionId, state.revision, next)) return;
    }
    throw new Error(`could not turn Workflows on in ${sessionId}`);
}
