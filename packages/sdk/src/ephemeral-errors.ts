const MESSAGES = {
    EPHEMERAL_INVALID_REQUEST: "Invalid ephemeral session request.",
    EPHEMERAL_UNAVAILABLE: "Ephemeral sessions are unavailable on this host.",
    EPHEMERAL_RUNTIME_UNQUALIFIED: "This native runtime version has not passed ephemeral privacy qualification.",
    EPHEMERAL_MODEL_UNAVAILABLE: "The selected model or credential is not available to this actor.",
    EPHEMERAL_SETTINGS_UNSUPPORTED: "The selected model does not support these settings.",
    EPHEMERAL_ISOLATION_FAILED: "The required ephemeral runtime configuration could not be verified.",
    EPHEMERAL_MODEL_CHANGED: "The runtime did not retain the selected model and settings.",
    EPHEMERAL_INVALID_USAGE: "The runtime supplied invalid usage counters.",
    EPHEMERAL_NO_RESULT: "The model did not return a text response.",
    EPHEMERAL_CHILDREN_FAILED: "Native child assignments did not complete safely.",
    EPHEMERAL_RESET_UNSUPPORTED: "This runtime, provider transport or session shape cannot guarantee an inter-batch context reset.",
    EPHEMERAL_RESET_FAILED: "The inter-batch context reset did not complete on contract; the window was not proven clean.",
    EPHEMERAL_UNEXPECTED_CONTEXT_CLEAR: "The runtime cleared context outside the host reset barrier; the entire run must stop.",
    EPHEMERAL_ABORTED: "The ephemeral session was cancelled.",
    EPHEMERAL_INVOCATION_FAILED: "The ephemeral session failed.",
    EPHEMERAL_CALLBACK_FAILED: "An ephemeral host callback failed.",
    EPHEMERAL_CLEANUP_FAILED: "The ephemeral runtime could not be fully stopped and cleaned up.",
    EPHEMERAL_RUNTIME_LOG_SUPPRESSED: "Ephemeral runtime diagnostics were suppressed.",
} as const;

export type EphemeralSessionErrorCode = keyof typeof MESSAGES;

/** Fixed diagnostics only: never retain SDK exceptions, callback content or causes. */
export class EphemeralSessionError extends Error {
    readonly code: EphemeralSessionErrorCode;
    constructor(code: EphemeralSessionErrorCode) {
        const safe = Object.hasOwn(MESSAGES, code) ? code : "EPHEMERAL_INVOCATION_FAILED";
        super(MESSAGES[safe]);
        this.code = safe;
        this.name = "EphemeralSessionError";
    }
}
