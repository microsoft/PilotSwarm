/**
 * Parent controls of a sub-agent's running turn (session turn control,
 * docs/proposals/session-turn-control.md section 4.13): `message_agent` with
 * `deliver: "now"` steers the child's running turn, and `stop_agent_turn`
 * stops it and leaves the child alive. Both use the management client's
 * Steer and Stop paths, so the catalog records them like a person's control,
 * with the parent agent as the actor.
 */
import { createHash } from "node:crypto";
import type {
    SteerTurnOptions,
    SteerTurnResult,
    StopTurnOptions,
    StopTurnResult,
    TurnControlCaller,
    TurnControlRefusal,
} from "./types.js";

/** How long stop_agent_turn waits for the Stop's outcome. */
export const PARENT_STOP_TIMEOUT_MS = 15_000;

export type MessageAgentDelivery = "next_turn" | "now";

/** The management client methods the parent controls use. */
export interface ParentTurnControlPort {
    steerSessionTurn(sessionId: string, opts: SteerTurnOptions): Promise<SteerTurnResult>;
    stopSessionTurn(sessionId: string, opts: StopTurnOptions): Promise<StopTurnResult>;
}

/**
 * One request id per tool call: when the same tool call runs again, the
 * catalog answers with the first result and records nothing new.
 */
export function parentControlRequestId(kind: "steer" | "stop", parentSessionId: string, toolCallId: string): string {
    return `parent-${kind}:${parentSessionId}:${createHash("sha256").update(toolCallId).digest("hex").slice(0, 32)}`;
}

/** Refusals after which the text goes to the child's next turn instead. */
const QUEUED_BECAUSE: Partial<Record<TurnControlRefusal, string>> = {
    no_turn: "the sub-agent had no running turn",
    legacy_turn: "the sub-agent's running turn does not take steers (it started before turn control)",
    steering_disabled: "steering is turned off for this session's owner",
    too_many: "the sub-agent's running turn already has 20 open steers",
};

export async function steerChildTurn(port: ParentTurnControlPort, input: {
    childSessionId: string;
    agentLabel: string;
    text: string;
    requestId: string;
    caller: TurnControlCaller;
    /** The ordinary next-turn message (message_agent's default path). */
    queue: () => Promise<void>;
}): Promise<string> {
    const result = await port.steerSessionTurn(input.childSessionId, {
        text: input.text, requestId: input.requestId, caller: input.caller,
    });
    if (result.outcome === "accepted") {
        return `[SYSTEM: Steered into the running turn of sub-agent ${input.agentLabel} (control seq ${result.steerId}). `
            + `It reads the text at its next model call. Continue your work in this SAME turn.]`;
    }
    const because = QUEUED_BECAUSE[result.outcome];
    if (!because) throw new Error(`the steer was refused (${result.outcome}); nothing was sent`);
    await input.queue();
    return `[SYSTEM: Not steered: ${because}. Queued the message for the next turn of sub-agent ${input.agentLabel}. `
        + `Continue your work in this SAME turn.]`;
}

export async function stopChildTurn(port: ParentTurnControlPort, input: {
    childSessionId: string;
    agentLabel: string;
    reason: string;
    requestId: string;
    caller: TurnControlCaller;
}): Promise<string> {
    const result = await port.stopSessionTurn(input.childSessionId, {
        reason: input.reason, requestId: input.requestId, caller: input.caller, timeoutMs: PARENT_STOP_TIMEOUT_MS,
    });
    const seq = result.controlSeq == null ? "" : ` (control seq ${result.controlSeq})`;
    switch (result.outcome) {
        case "stopped":
        case "stop_forced":
            return `[SYSTEM: Stopped the current turn of sub-agent ${input.agentLabel}${seq}. `
                + `The sub-agent stays alive; give it its next task with message_agent.]`;
        case "too_late":
            return `[SYSTEM: Too late to stop: the turn of sub-agent ${input.agentLabel} had finished its model run when the Stop arrived${seq}. `
                + `That turn completed normally.]`;
        case "timeout":
            return `[SYSTEM: The Stop of sub-agent ${input.agentLabel} was accepted${seq}, but its turn had not stopped `
                + `within ${PARENT_STOP_TIMEOUT_MS / 1000} s. check_agents shows when it does.]`;
        default:
            return `[SYSTEM: Nothing to stop: sub-agent ${input.agentLabel} has no running turn`
                + `${result.detail ? ` (${result.detail})` : ""}.]`;
    }
}
