/**
 * "This session has run a turn", for tests of a person's Workflow Start.
 *
 * A worker's first turn in a session records one session.workspace_defaults event, even when the turn used no
 * default folder (session-proxy.ts, noteWorkspaceDefaults). A person's Start (the management client's
 * startSessionWorkflowDefinition) needs that record: without it, and without default folders in the session's
 * creation config, the Start is refused with WORKFLOW_COMMAND_INVALID and asks for one turn first.
 *
 * - A test with a real worker runs a real turn: `await session.sendAndWait(FIRST_TURN_PROMPT, ms)`.
 * - A test with no worker (it writes sessions straight into the store) calls recordSessionRanATurn. It writes the
 *   event a first turn writes for a session with no default folders.
 *
 * Keep firstTurnDefaultsRecord equal to what noteWorkspaceDefaults writes. workspace-setups.test.js (S1) compares
 * it with the event of a real worker's first turn.
 *
 * Do not pass `workspace: "none"` to a Start to get past the refusal: the test would stop covering the inherit path.
 */

/** A first turn for a real model: it needs no tool and changes nothing. */
export const FIRST_TURN_PROMPT = "Reply with the one word READY. Do not call a tool.";

/** The data of the event a first turn records when it used no default folder and the provider has none. */
export function firstTurnDefaultsRecord() {
    return { revision: 1, workingFolder: null, extra: [], capturedDefaults: null };
}

/** Stands for "this session has run a turn": writes the default-folders record of a first turn with no default folders. */
export async function recordSessionRanATurn(catalog, sessionId) {
    await catalog.recordEvents(sessionId, [{ eventType: "session.workspace_defaults", data: firstTurnDefaultsRecord() }], "test-first-turn");
}
