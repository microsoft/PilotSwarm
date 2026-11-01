import type { ComputeFailure } from "./compute.js";

export interface ClassifiedComputeFailure {
    code: string;
    permanent: boolean;
    message: string;
    action: string;
}

const reasons: Readonly<Record<string, { permanent: boolean; reason: string; action: string }>> = {
    COMPUTE_TARGET_NOT_FOUND: { permanent: true, reason: "The compute target is gone or cannot be found.", action: "Choose an available compute target, then resend your prompt." },
    COMPUTE_TARGET_DISABLED: { permanent: true, reason: "The compute target is disabled.", action: "Ask its manager to enable it, or choose another target, then resend your prompt." },
    COMPUTE_TARGET_FORBIDDEN: { permanent: true, reason: "This session no longer has access to the compute target.", action: "Ask its manager to restore access, or choose another target, then resend your prompt." },
    COMPUTE_TARGET_INVALID: { permanent: true, reason: "The compute target configuration is invalid.", action: "Correct the target configuration, then resend your prompt." },
    COMPUTE_TARGET_CONFLICT: { permanent: true, reason: "The compute target conflicts with an existing target.", action: "Choose a different target name or correct the configuration, then resend your prompt." },
    COMPUTE_KIND_UNKNOWN: { permanent: true, reason: "This deployment has no provider for the compute target's kind.", action: "Ask an administrator to register a provider, or choose another target, then resend your prompt." },
    COMPUTE_UNSUPPORTED: { permanent: true, reason: "The compute target does not support this session's configuration.", action: "Choose a supported model or compute target, then resend your prompt." },
    COMPUTE_HOST_MODEL_UNAVAILABLE: { permanent: true, reason: "The compute target no longer offers this session's model.", action: "Choose a model the target offers, then resend your prompt." },
    COMPUTE_ENDPOINT_REFUSED: { permanent: true, reason: "The worker refused the compute endpoint.", action: "Ask its manager to correct the endpoint configuration, then resend your prompt." },
    COMPUTE_HANDSHAKE_FAILED: { permanent: true, reason: "The worker could not verify the compute host.", action: "Ask its manager to correct the host's identity and binding configuration, then resend your prompt." },
    COMPUTE_SERVICE_IDENTITY_REFUSED: { permanent: true, reason: "The worker refused the provider service's identity.", action: "Ask an administrator to correct the registered service identity, then resend your prompt." },
    COMPUTE_UNAVAILABLE: { permanent: false, reason: "The compute host or provider is temporarily unavailable.", action: "If the host is offline, start it; otherwise wait for capacity or service recovery, then resend if retries end." },
};

/** Keep provider classifications across the activity's string-only error boundary. */
export function formatComputeFailure(failure: ComputeFailure): string {
    const marker = !Object.hasOwn(reasons, failure.code) && typeof failure.permanent === "boolean"
        ? `[${failure.permanent ? "permanent" : "temporary"}] `
        : "";
    return `${failure.code}: ${marker}${failure.message}`;
}

/** Only a coded prefix is a compute failure; prose and ordinary runtime errors are not. */
export function classifyComputeFailure(failure: string | ComputeFailure): ClassifiedComputeFailure | null {
    const raw = typeof failure === "string" ? failure : formatComputeFailure(failure);
    // Activity rejections preserve the coded message inside this runtime envelope.
    const text = raw.replace(/^Activity '[^']+' JS execution failed: [^,\r\n]+, Error:\s*/, "");
    const match = /^([A-Z][A-Z0-9_]*):\s*(?:\[(permanent|temporary)\]\s*)?([\s\S]*)$/.exec(text);
    if (!match) return null;
    const [, code, marker, detail] = match;
    const builtIn = Object.hasOwn(reasons, code) ? reasons[code] : undefined;
    if (!builtIn && !code.startsWith("COMPUTE_") && !marker) return null;
    const permanent = builtIn?.permanent ?? marker === "permanent";
    const action = builtIn?.action ?? (permanent
        ? "Correct the provider's configuration, or choose another compute target, then resend your prompt."
        : "Wait for the provider to recover, then resend your prompt if retries end.");
    const reason = builtIn?.reason ?? (permanent ? "The compute provider refused this turn." : "The compute provider is temporarily unavailable.");
    return { code, permanent, action, message: `${code}: ${reason}${detail.trim() ? ` ${detail.trim()}` : ""} ${action}` };
}
