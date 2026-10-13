/**
 * Session turn control (Stop and Steer through the CMS): the constants and
 * helpers shared by the worker, the orchestration and the client surfaces.
 * See docs/proposals/session-turn-control.md.
 */

/** Session event types written for turn control. */
export const TURN_CONTROL_EVENT_TYPES = {
    /** A Steer request: `UserSteerEventData`. */
    steer: "user.steer",
    /** A Stop request: `UserStopEventData`. */
    stop: "user.stop",
    /** The one outcome of a Stop or Steer: `ControlOutcomeEventData`. */
    outcome: "session.control_outcome",
    /** The model run confirmed a steer (not a transcript item): `SteerConfirmedEventData`. */
    steerConfirmed: "session.steer_confirmed",
    /** Carried steers left the session's pending state: `CarriedSteersClosedEventData`. */
    carriedSteersClosed: "session.carried_steers_closed",
} as const;

/** PostgreSQL notification channel that wakes the worker running a turn. Payload: `{ schema, sessionId }`. */
export const TURN_CONTROL_CHANNEL = "pilotswarm_turn_control";

/** Open controls allowed on one turn; the next is refused as `too_many`. */
export const TURN_CONTROL_MAX_OPEN = 20;

/** Interval of the worker's batched look while it runs at least one turn. */
export const TURN_CONTROL_LOOK_INTERVAL_MS = 5_000;

/** Interval at which a Stop request polls for its outcome. */
export const TURN_CONTROL_OUTCOME_POLL_MS = 250;

/** Default time a Stop request waits for its outcome. */
export const TURN_CONTROL_STOP_TIMEOUT_MS = 30_000;

/** Feature flag that gates Steer. Stop is never gated. */
export const STEERING_FEATURE_KEY = "sessions.steering";

/**
 * The prompt of a turn that only runs carried steers. The worker replaces it
 * with the carried text, so the model never sees it, and it is never recorded
 * as a user message.
 */
export const CARRIED_STEERS_WAKE_PROMPT =
    "[SYSTEM: Running the user's guidance that arrived after the previous turn finished. The user did not send a new message.]";

/**
 * Whether a session's running turn accepts Stop and Steer through the CMS:
 * a turn is running and it started on the turn-control path.
 */
export function acceptsTurnControl(row: { activeTurnIndex?: number | null; turnHigh?: number | null } | null | undefined): boolean {
    if (!row) return false;
    const active = row.activeTurnIndex;
    return typeof active === "number" && row.turnHigh === active;
}

/**
 * Thrown by a session catalog whose schema does not have the turn-control
 * procedures yet.
 */
export class TurnControlUnavailableError extends Error {
    readonly code = "TURN_CONTROL_UNAVAILABLE";
    constructor(operation: string) {
        super(`Turn control is not available in this session catalog: ${operation}`);
        this.name = "TurnControlUnavailableError";
    }
}
