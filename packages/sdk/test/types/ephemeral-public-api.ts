import {
    EphemeralSessionError,
    type EphemeralNativeChildrenOptions, type EphemeralNativeChildAssignment, type EphemeralNativeChildProgress,
    type EphemeralSessionErrorCode, type EphemeralSessionRequest, type EphemeralSessionResult,
    type EphemeralSessionProgress, type EphemeralSessionUsage, type EphemeralSessionUsageUpdate, type EphemeralSessionDecision,
    type EphemeralSessionUsageDiagnostics, type EphemeralUsageUnknownReason,
    type PilotSwarmHostServices, type PilotSwarmWorker, type PilotSwarmManagementClient,
} from "pilotswarm-sdk";

const code: EphemeralSessionErrorCode = "EPHEMERAL_RUNTIME_UNQUALIFIED";
const error: Error = new EphemeralSessionError(code);
void error;
const integrityCode: EphemeralSessionErrorCode = "EPHEMERAL_UNEXPECTED_CONTEXT_CLEAR";
const integrityError: Error = new EphemeralSessionError(integrityCode);
void integrityError;
const assignment: EphemeralNativeChildAssignment = { id: "batch-0", sessionRefs: ["s0"] };
const nativeChildren: EphemeralNativeChildrenOptions = { maxConcurrent: 20, assignments: [assignment], progressStages: ["classifying"] };
const unknownUsage: EphemeralSessionUsage = {
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, apiCalls: null,
};
void unknownUsage;
const reason: EphemeralUsageUnknownReason = "missing_counter";
const diagnostics: EphemeralSessionUsageDiagnostics = {
    observedApiCalls: 1, apiCallCountReasons: [],
    counterReasons: { inputTokens: [reason], outputTokens: [], cacheReadTokens: [], cacheWriteTokens: [] },
};
// @ts-expect-error Arbitrary provider error text is not completeness metadata.
const privateReason: EphemeralUsageUnknownReason = "private provider error";
void privateReason;
// @ts-expect-error Never use arbitrary failure content as a diagnostic code.
new EphemeralSessionError("private provider error");
// @ts-expect-error Ephemeral execution has no durable duplicate claim or replay guard.
new EphemeralSessionError("EPHEMERAL_ALREADY_STARTED");
// @ts-expect-error There is no provider accounting settlement.
new EphemeralSessionError("EPHEMERAL_SETTLEMENT_FAILED");
declare const services: PilotSwarmHostServices;
declare const worker: PilotSwarmWorker;
declare const management: PilotSwarmManagementClient;
const actor = { provider: "fixture", subject: "owner" };
worker.getHostServices();
management.getHostServices();
// @ts-expect-error Host service binding takes no options.
worker.getHostServices({ actor });
// @ts-expect-error Host service binding takes no options.
management.getHostServices({ actor });
const request: EphemeralSessionRequest = {
    actor, executionId: "execution", model: "selected:model",
    workingDirectory: "/private/host-workspace", systemMessage: "instructions", prompt: "initial",
    reasoningEffort: "max", contextTier: "long_context", progressStages: ["working"],
    onProgress: async (event: EphemeralSessionProgress) => { const sequence: number = event.sequence; void sequence; },
    nativeChildren,
    onChildProgress: async (event: EphemeralNativeChildProgress) => {
        const refs: string[] = event.completedSessionRefs;
        const id: string = event.assignmentId;
        void [refs, id];
    },
    onUsage: async (update: EphemeralSessionUsageUpdate) => {
        const calls: number | null = update.usage.apiCalls;
        const observed: number | undefined = update.usageDiagnostics?.observedApiCalls;
        void [calls, observed];
    },
    onResponse: async response => {
        const completeness: EphemeralSessionUsageDiagnostics | undefined = response.usageDiagnostics;
        void completeness;
        return response.iteration < 5 ? { action: "continue", prompt: "repair" } : { action: "complete" };
    },
};
const result: Promise<EphemeralSessionResult> | undefined = services.runEphemeralSession?.(request);
void result;
const resetRequest: EphemeralSessionRequest = {
    ...request, nativeChildren: undefined, onChildProgress: undefined,
    contextReset: true,
    onResponse: async response => response.iteration < 2
        ? { action: "clear_context", prompt: "next host-owned batch" }
        : { action: "complete" },
};
const resetResult: Promise<EphemeralSessionResult> | undefined = services.runEphemeralSession?.(resetRequest);
void resetResult;
const legacyResult: EphemeralSessionResult = {
    text: "", resolvedModel: "selected:model", usage: unknownUsage, usageUncertain: true, turnCount: 1,
};
const currentResult: EphemeralSessionResult = { ...legacyResult, usageDiagnostics: diagnostics };
void currentResult;
// @ts-expect-error Optional capability must be tested.
services.runEphemeralSession(request);
// @ts-expect-error Removed capability has no compatibility alias.
services.invokeNoTools;
// @ts-expect-error Metadata surface from the retired pipeline is removed.
services.describeNoToolsModel;
// @ts-expect-error No provider credentials in requests.
request.apiKey = "secret";
// @ts-expect-error No invocation or retry cap in requests.
request.maxCalls = 3;
// @ts-expect-error Model-supplied decisions cannot introduce arbitrary actions.
const invalid: EphemeralSessionDecision = { action: "retry" };
void invalid;
