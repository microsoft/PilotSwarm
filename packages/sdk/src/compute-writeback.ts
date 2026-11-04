import type { CompleteTurnWritebackInput, SessionCatalog } from "./cms.js";
import type { SettleTurnInput } from "./provider-store.js";
import type { TurnResult } from "./types.js";
import type { ComputeExecutionIdentity } from "./compute-execution.js";

export type ComputeStoppedOutcome = Extract<TurnResult, { type: "stopped" }>;

export interface ComputeChargeIdentity {
    ownerUserId: number | null;
    isSystem: boolean;
    ledgerTurnIndex: number;
}

export interface CompleteExecutionTurnWritebackInput {
    turnKey: string;
    transcriptEpoch: number;
    execution: ComputeExecutionIdentity;
    /** Current publisher, which may be adopting an earlier attempt's winning receipt. Not persisted in the receipt. */
    operationIdentity?: ComputeExecutionIdentity;
    turn: CompleteTurnWritebackInput & { stoppedOutcome?: ComputeStoppedOutcome };
    providerCharge?: SettleTurnInput & { ledgerTurnIndex: number };
}

export interface ComputeWritebackReceipt {
    schemaVersion: 1;
    turnKey: string;
    transcriptEpoch: number;
    execution: ComputeExecutionIdentity;
    turn: Omit<CompleteExecutionTurnWritebackInput["turn"], "startedAt" | "endedAt" | "lastActiveAt"> & {
        startedAt: string; endedAt: string; lastActiveAt: string;
    };
    providerCharge?: SettleTurnInput & { ledgerTurnIndex: number };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown) => value === null || typeof value === "string";

export function isComputeStoppedOutcome(value: unknown): value is ComputeStoppedOutcome {
    return record(value) && value.type === "stopped"
        && Object.keys(value).every(key => ["type", "reason", "events", "snapshotVersion", "workspaceAttached"].includes(key))
        && (value.reason === undefined || typeof value.reason === "string")
        && (value.snapshotVersion === undefined || count(value.snapshotVersion))
        && (value.workspaceAttached === undefined || typeof value.workspaceAttached === "boolean")
        && (value.events === undefined || (Array.isArray(value.events) && value.events.every(event =>
            record(event) && typeof event.eventType === "string" && Object.keys(event).every(key => key === "eventType" || key === "data"))));
}

function validReceipt(value: unknown, expected: {
    sessionId: string; turnKey: string; transcriptEpoch: number; turnIndex: number;
}): value is ComputeWritebackReceipt {
    if (!record(value) || value.schemaVersion !== 1 || value.turnKey !== expected.turnKey
        || value.transcriptEpoch !== expected.transcriptEpoch || !record(value.turn)) return false;
    const turn = value.turn;
    const identity = value.execution;
    if (!record(identity) || identity.sessionId !== expected.sessionId || identity.turnKey !== expected.turnKey
        || identity.transcriptEpoch !== expected.transcriptEpoch
        || !["attemptId", "workerNodeId", "generation"].every(key => typeof identity[key] === "string" && identity[key].length > 0)) return false;
    if (turn.sessionId !== expected.sessionId || turn.turnIndex !== expected.turnIndex
        || typeof turn.state !== "string"
        || !["startedAt", "endedAt", "lastActiveAt"].every(key => typeof turn[key] === "string" && Number.isFinite(Date.parse(turn[key])))
        || !["turnIndex", "durationMs", "tokensInput", "tokensOutput", "tokensCacheRead", "tokensCacheWrite",
            "toolCalls", "toolErrors", "currentIteration"].every(key => count(turn[key]))
        || !["agentId", "model", "reasoningEffort", "resultType", "errorMessage", "workerNodeId", "lastError", "waitReason"].every(key => text(turn[key]))
        || (turn.toolNames !== undefined && (!Array.isArray(turn.toolNames) || !turn.toolNames.every(name => typeof name === "string")))) {
        return false;
    }
    if (turn.resultType === "stopped" ? !isComputeStoppedOutcome(turn.stoppedOutcome) : turn.stoppedOutcome !== undefined) return false;
    const charge = value.providerCharge;
    if (charge !== undefined && (!record(charge) || charge.sessionId !== expected.sessionId || charge.turnIndex !== expected.turnIndex
        || !count(charge.ledgerTurnIndex) || !text(charge.providerName) || !text(charge.modelQualified)
        || !(charge.ownerUserId === null || count(charge.ownerUserId))
        || !(charge.agentId === undefined || text(charge.agentId))
        || !["user", "system", "unattributed"].includes(String(charge.chargeClass))
        || !["tokensInput", "tokensOutput", "tokensCacheRead", "tokensCacheWrite"].every(key => count(charge[key])))) {
        return false;
    }
    return true;
}

export function readComputeWriteback(receipt: unknown, expected: {
    sessionId: string; turnKey: string; transcriptEpoch: number; turnIndex: number;
}): CompleteExecutionTurnWritebackInput {
    if (!validReceipt(receipt, expected)) throw new Error("Committed native writeback is invalid or belongs to a different turn");
    const t = receipt.turn, c = receipt.providerCharge;
    return {
        turnKey: expected.turnKey, transcriptEpoch: expected.transcriptEpoch,
        execution: { sessionId: receipt.execution.sessionId, turnKey: receipt.execution.turnKey,
            transcriptEpoch: receipt.execution.transcriptEpoch, attemptId: receipt.execution.attemptId,
            workerNodeId: receipt.execution.workerNodeId, generation: receipt.execution.generation },
        turn: {
            sessionId: t.sessionId, agentId: t.agentId, model: t.model, reasoningEffort: t.reasoningEffort,
            turnIndex: t.turnIndex, startedAt: new Date(t.startedAt), endedAt: new Date(t.endedAt), lastActiveAt: new Date(t.lastActiveAt),
            durationMs: t.durationMs, tokensInput: t.tokensInput, tokensOutput: t.tokensOutput,
            tokensCacheRead: t.tokensCacheRead, tokensCacheWrite: t.tokensCacheWrite, toolCalls: t.toolCalls,
            toolErrors: t.toolErrors, resultType: t.resultType, errorMessage: t.errorMessage, workerNodeId: t.workerNodeId,
            state: t.state, lastError: t.lastError, waitReason: t.waitReason, currentIteration: t.currentIteration,
            ...(t.toolNames ? { toolNames: [...t.toolNames] } : {}),
            ...(t.stoppedOutcome === undefined ? {} : { stoppedOutcome: t.stoppedOutcome }),
        },
        ...(c ? { providerCharge: {
            sessionId: c.sessionId, turnIndex: c.turnIndex, ledgerTurnIndex: c.ledgerTurnIndex,
            providerName: c.providerName ?? null, modelQualified: c.modelQualified ?? null, ownerUserId: c.ownerUserId ?? null,
            chargeClass: c.chargeClass ?? "unattributed", agentId: c.agentId ?? null, tokensInput: c.tokensInput ?? 0,
            tokensOutput: c.tokensOutput ?? 0, tokensCacheRead: c.tokensCacheRead ?? 0, tokensCacheWrite: c.tokensCacheWrite ?? 0,
        } } : {}),
    };
}

export function prepareComputeWriteback(input: CompleteExecutionTurnWritebackInput): ComputeWritebackReceipt {
    const t = input.turn, c = input.providerCharge;
    const receipt: ComputeWritebackReceipt = {
        schemaVersion: 1, turnKey: input.turnKey, transcriptEpoch: input.transcriptEpoch,
        execution: { sessionId: input.execution.sessionId, turnKey: input.execution.turnKey,
            transcriptEpoch: input.execution.transcriptEpoch, attemptId: input.execution.attemptId,
            workerNodeId: input.execution.workerNodeId, generation: input.execution.generation },
        turn: {
            sessionId: t.sessionId, agentId: t.agentId, model: t.model, reasoningEffort: t.reasoningEffort,
            turnIndex: t.turnIndex, startedAt: t.startedAt.toISOString(), endedAt: t.endedAt.toISOString(),
            lastActiveAt: t.lastActiveAt.toISOString(), durationMs: t.durationMs, tokensInput: t.tokensInput,
            tokensOutput: t.tokensOutput, tokensCacheRead: t.tokensCacheRead, tokensCacheWrite: t.tokensCacheWrite,
            toolCalls: t.toolCalls, toolErrors: t.toolErrors, resultType: t.resultType, errorMessage: t.errorMessage,
            workerNodeId: t.workerNodeId, state: t.state, lastError: t.lastError, waitReason: t.waitReason,
            currentIteration: t.currentIteration, ...(t.toolNames ? { toolNames: [...t.toolNames] } : {}),
            ...(t.stoppedOutcome === undefined ? {} : { stoppedOutcome: t.stoppedOutcome }),
        },
        ...(c ? { providerCharge: {
            sessionId: c.sessionId, turnIndex: c.turnIndex, ledgerTurnIndex: c.ledgerTurnIndex,
            providerName: c.providerName ?? null, modelQualified: c.modelQualified ?? null, ownerUserId: c.ownerUserId ?? null,
            chargeClass: c.chargeClass ?? "unattributed", agentId: c.agentId ?? null,
            tokensInput: c.tokensInput ?? 0, tokensOutput: c.tokensOutput ?? 0,
            tokensCacheRead: c.tokensCacheRead ?? 0, tokensCacheWrite: c.tokensCacheWrite ?? 0,
        } } : {}),
    };
    readComputeWriteback(receipt, { sessionId: t.sessionId, turnKey: input.turnKey, transcriptEpoch: input.transcriptEpoch, turnIndex: t.turnIndex });
    return receipt;
}

export async function publishComputeWriteback(catalog: SessionCatalog, receipt: unknown, expected: {
    sessionId: string; turnKey: string; transcriptEpoch: number; turnIndex: number;
}, operationIdentity?: ComputeExecutionIdentity): Promise<boolean> {
    if (!catalog.completeExecutionTurnWriteback) throw new Error("Native compute requires idempotent CMS completion");
    const input = readComputeWriteback(receipt, expected);
    return catalog.completeExecutionTurnWriteback({ ...input, operationIdentity: operationIdentity ?? input.execution });
}
