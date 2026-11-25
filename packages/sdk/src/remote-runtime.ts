/**
 * A Copilot runtime that runs outside the worker.
 *
 * The worker stays the trusted side: it keeps the model credentials (compute-runtime.ts) and decides what the session may do. A remote runtime is reached through a
 * Copilot client whose only transport is the connection the provider's executor admitted; the session manager binds that client for ONE turn, creates or resumes the
 * native session on it, and releases it when the turn ends. This module is only the shape of that binding: nothing here knows a provider, a state policy or a host.
 */
import type { CopilotClient } from "@github/copilot-sdk";

/** The binding of one turn: a STARTED Copilot client. The party that opened it closes it; the session manager only stops using it. */
export interface RemoteRuntimeBinding {
    readonly client: CopilotClient;
}

/** Opaque handle returned by `bindRemoteRuntime`; pass back to `releaseRemoteRuntime` to prevent ABA release of a later turn's binding. */
export type RemoteRuntimeBindingToken = symbol;

export const REMOTE_RUNTIME_ERROR_CODES = Object.freeze([
    "REMOTE_RUNTIME_INVALID",
    "REMOTE_RUNTIME_BOUND",
    "REMOTE_RUNTIME_UNAVAILABLE",
    "REMOTE_RUNTIME_REFUSED",
] as const);

export type RemoteRuntimeErrorCode = (typeof REMOTE_RUNTIME_ERROR_CODES)[number];

/** A typed, fixed-text refusal. `terminal`: repeating the turn cannot help (the configuration is what is wrong). */
export class RemoteRuntimeError extends Error {
    readonly code: RemoteRuntimeErrorCode;
    readonly terminal: boolean;

    constructor(code: RemoteRuntimeErrorCode, message: string, options: { terminal?: boolean } = {}) {
        super(`${code}: ${message}`);
        this.name = "RemoteRuntimeError";
        this.code = code;
        this.terminal = options.terminal !== false;
    }
}

export function isRemoteRuntimeError(error: unknown): error is RemoteRuntimeError {
    if (error instanceof RemoteRuntimeError) return true;
    if (typeof error !== "object" || error === null) return false;
    const candidate = error as { name?: unknown; code?: unknown; terminal?: unknown };
    return candidate.name === "RemoteRuntimeError"
        && typeof candidate.code === "string"
        && (REMOTE_RUNTIME_ERROR_CODES as readonly string[]).includes(candidate.code)
        && typeof candidate.terminal === "boolean";
}

/** The binding, checked for the one thing the session manager needs: a client that can create and resume a native session. */
export function assertRemoteRuntimeBinding(value: unknown): RemoteRuntimeBinding {
    const client = (value as { client?: unknown } | null)?.client as { createSession?: unknown; resumeSession?: unknown } | null | undefined;
    if (!client || typeof client !== "object" || typeof client.createSession !== "function" || typeof client.resumeSession !== "function") {
        throw new RemoteRuntimeError("REMOTE_RUNTIME_INVALID", "a remote runtime binding needs a Copilot client that can create and resume a session");
    }
    return value as RemoteRuntimeBinding;
}
