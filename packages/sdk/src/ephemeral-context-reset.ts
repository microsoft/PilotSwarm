import { EphemeralSessionError } from "./ephemeral-errors.js";

/**
 * Internal reset tool.
 *
 * The runtime only honours `history.clearContext` from inside a tool handler —
 * the clear has to drop the results of the tool calls its wipe orphans, and it
 * rejects when no tool call is in flight. This tool exists solely to give the
 * clear a legitimate pending call to run inside. It is offered to the model
 * only during a reset turn, and never surfaces in host callbacks or results.
 */
export const RESET_TOOL = "ephemeral_context_reset";

/**
 * Neutral seed handed to `clearContext`.
 *
 * Never the host's real next prompt. CLI 1.0.85 applies a clear one turn late:
 * the seeded turn still runs against the stale window, so a real batch prompt
 * delivered as the seed would be answered with the previous batch still in
 * view. The host's next batch is sent as a separate turn afterwards, once the
 * window has actually been rebuilt.
 */
export const RESET_SEED = "Acknowledge that you are ready and wait for the next instruction.";

/** Internal prompt that drives the reset turn. Never host-visible. */
export const RESET_PROMPT = `Call the ${RESET_TOOL} tool now.

This is a mechanical step, not a question to consider. Calling the tool is the only valid action for this turn. Do not reply with text, do not explain, do not acknowledge, and do not call any other tool. Call ${RESET_TOOL} immediately.`;

/**
 * Prompts for successive reset attempts, one per attempt.
 *
 * A declined turn leaves its refusal in the window, so re-sending the identical
 * words invites the identical answer — measured against a live model, refusals
 * within a single run were correlated rather than independent. Each attempt is
 * therefore worded differently, so a retry is a new stimulus and not an echo.
 * The last entry is reused if attempts ever outgrow this list.
 */
export const RESET_PROMPTS = [
    RESET_PROMPT,
    `Your previous reply did not call ${RESET_TOOL}. Text replies are not accepted for this turn.

Emit a tool call to ${RESET_TOOL} and nothing else. It takes no arguments.`,
    `This turn cannot end until ${RESET_TOOL} has been called. Nothing you were working on before is relevant to it.

Respond with a single ${RESET_TOOL} tool call. No text, no other tool.`,
];

/** The prompt to use for a 1-based reset attempt. */
export function resetPrompt(attempt: number): string {
    return RESET_PROMPTS[Math.min(Math.max(attempt, 1), RESET_PROMPTS.length) - 1]!;
}

/**
 * How many times a declined reset turn is re-prompted before failing closed.
 *
 * The call is the model's to make and a live model does decline it, so a
 * boundary that asked exactly once would be unreliable. A decline leaves the
 * window untouched, so asking again is safe. Attempts stay bounded: an
 * unprovable window must end the run, never continue on a stale one.
 */
export const RESET_ATTEMPTS = RESET_PROMPTS.length;

/**
 * A reset turn must own the whole window.
 *
 * Native children issue their own model requests and their own per-turn drain,
 * so a clear could land mid-flight against a child's conversation. That
 * combination is not qualified, so it is refused rather than approximated.
 */
export function assertResetSupported(nativeChildren: boolean): void {
    if (nativeChildren) throw new EphemeralSessionError("EPHEMERAL_RESET_UNSUPPORTED");
}
