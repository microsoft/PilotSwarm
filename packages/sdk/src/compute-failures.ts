import type { ComputeFailure } from "./compute.js";

/** One compute failure as the single line a turn carries: `CODE: message`. */
export function formatComputeFailure(failure: Pick<ComputeFailure, "code" | "message">): string {
    return `${failure.code}: ${failure.message}`;
}

/**
 * The message of a failure being raised again from an error that already
 * carries its own code, with that prefix taken off, so it is never
 * formatted twice as `CODE: CODE: ...`.
 */
export function computeFailureMessage(code: string, raw: unknown): string {
    const text = String((raw as Error)?.message ?? raw ?? "").trim();
    const prefix = new RegExp(`^${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*`);
    return text.replace(prefix, "");
}

/**
 * One compute failure as the Error the worker throws. Every compute error
 * the worker raises is built here, so it is always `CODE: message`, with
 * the code and any retry hint attached.
 */
export function computeFailureError(failure: Pick<ComputeFailure, "code" | "message" | "retryAfterMs">): Error {
    const code = typeof failure?.code === "string" && failure.code.trim() ? failure.code.trim() : "COMPUTE_UNAVAILABLE";
    const message = typeof failure?.message === "string" ? failure.message.trim() : "";
    return Object.assign(new Error(formatComputeFailure({ code, message })), {
        code,
        ...(failure?.retryAfterMs ? { retryAfterMs: failure.retryAfterMs } : {}),
    });
}
