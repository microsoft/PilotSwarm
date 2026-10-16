// Type consumer for the session turn-control contract (phase A1). Imports only
// the built public SDK entry point (its .d.ts), as workstreams B and C do.
// Compiled by test/unit/turn-control-types.test.mjs after the build.
import {
    TURN_CONTROL_EVENT_TYPES,
    TURN_CONTROL_CAPABILITY,
    STEERING_FEATURE_KEY,
    CARRIED_STEERS_WAKE_PROMPT,
    acceptsTurnControl,
    TurnControlUnavailableError,
    type OrchestrationInput,
    type TurnResult,
    type StopTurnResult,
    type StopTurnOptions,
    type SteerTurnOptions,
    type SteerTurnResult,
    type TurnControlCaller,
    type TurnControl,
    type TurnControlOutcome,
    type TurnControlRefusal,
    type TurnControlAddResult,
    type TurnStartResult,
    type TurnLookInput,
    type TurnLookRow,
    type TurnEndKind,
    type TurnEndResult,
    type LateSteer,
    type CarriedSteersCloseReason,
    type UserSteerEventData,
    type UserStopEventData,
    type ControlOutcomeEventData,
    type SteerConfirmedEventData,
    type CarriedSteersClosedEventData,
} from "../../dist/index.js";

const steerType: "user.steer" = TURN_CONTROL_EVENT_TYPES.steer;
const closedType: "session.carried_steers_closed" = TURN_CONTROL_EVENT_TYPES.carriedSteersClosed;
const tag: string = TURN_CONTROL_CAPABILITY;
const flag: string = STEERING_FEATURE_KEY;
const wake: string = CARRIED_STEERS_WAKE_PROMPT;
const accepts: boolean = acceptsTurnControl({ activeTurnIndex: 3, turnHigh: 3 });
const unavailable: Error = new TurnControlUnavailableError("turnStart");

const caller: TurnControlCaller = {
    sender: { kind: "user", subject: "alice", provider: "dev" },
    viewer: { principal: { provider: "dev", subject: "alice" }, isAdmin: false },
};
const steer: SteerTurnOptions = { text: "use the v2 API", requestId: "r1", caller };
const convert: SteerTurnOptions = { text: "queued text", requestId: "r3", replacesClientMessageId: "cm-1" };
// @ts-expect-error A steer needs a request id.
const steerWithoutId: SteerTurnOptions = { text: "x" };
const stop: StopTurnOptions = { reason: "wrong way", timeoutMs: 30_000, requestId: "r2", caller };
const stopMinimal: StopTurnOptions = {};

const accepted: SteerTurnResult = { outcome: "accepted", steerId: 31, turn: 5 };
const refused: SteerTurnResult = { outcome: "steering_disabled" };
// @ts-expect-error Unknown refusals are rejected.
const badRefusal: SteerTurnResult = { outcome: "busy" };
const stopResults: StopTurnResult[] = [
    { outcome: "stopped", controlSeq: 32 },
    { outcome: "too_late", controlSeq: 33 },
    { outcome: "timeout", controlSeq: 34 },
    { outcome: "no_active_turn" },
    { outcome: "stop_forced", turnIndex: 4 },
];

const control: TurnControl = { seq: 31, kind: "steer", text: "t", createdAt: "2026-10-13T00:00:00Z" };
// @ts-expect-error Controls are steers or stops.
const badControl: TurnControl = { seq: 1, kind: "pause", text: "t", createdAt: "x" };
const outcomes: TurnControlOutcome[] = ["delivered", "carried", "not_delivered", "stopped", "too_late"];
const refusals: TurnControlRefusal[] = ["no_turn", "legacy_turn", "not_found", "too_many", "request_id_reused", "steering_disabled", "already_received"];
const added: TurnControlAddResult[] = [{ seq: 31, turn: 5 }, { seq: 31, turn: 5, repeat: true }, { refused: "no_turn" }];
const started: TurnStartResult[] = [{ stale: true }, { stopped: false, controls: [control] }];
const look: TurnLookInput = { sessionId: "s", turn: 5, after: 30 };
const lookRow: TurnLookRow = { sessionId: "s", turn: 5, controls: [control] };
const endKinds: TurnEndKind[] = ["stopped", "error", "other"];
const ended: TurnEndResult = { stopped: false, late: [{ seq: 33, text: "late" }], replaced: ["cm-1"] };
const reasons: CarriedSteersCloseReason[] = ["ran", "stopped", "gave_up", "terminal"];

const steerData: UserSteerEventData = { turn: 5, text: "t", requestId: "r1", actor: null, replacesClientMessageId: "cm-1" };
const stopData: UserStopEventData = { turn: 5, text: "reason", requestId: "r2", actor: null };
const outcomeData: ControlOutcomeEventData = { seq: 31, turn: 5, outcome: "delivered" };
const confirmedData: SteerConfirmedEventData = { seq: 31, turn: 5, messageId: "m1" };
const closedData: CarriedSteersClosedEventData = { seqs: [33], turnIndex: 6, reason: "ran" };

const late: LateSteer = { seq: 33, text: "late" };
const completed: TurnResult = {
    type: "completed",
    content: "done",
    lateSteers: [late],
    controlCursor: { turn: 5, cursor: 31 },
    carriedSteersConsumed: true,
    workspaceAttached: true,
    snapshotVersion: 7,
};
const stoppedResult: TurnResult = { type: "stopped", reason: "Stopped by user", carriedSteersConsumed: true, workspaceAttached: true };
// @ts-expect-error carriedSteersConsumed is only ever true.
const notConsumed: TurnResult = { type: "completed", content: "x", carriedSteersConsumed: false };

const input: Pick<OrchestrationInput, "carriedSteers"> = { carriedSteers: [late] };

export const used = [steerType, closedType, tag, flag, wake, accepts, unavailable, steer, convert, steerWithoutId, stop, stopMinimal,
    accepted, refused, badRefusal, stopResults, control, badControl, outcomes, refusals, added, started, look, lookRow,
    endKinds, ended, reasons, steerData, stopData, outcomeData, confirmedData, closedData, completed, stoppedResult,
    notConsumed, input];
