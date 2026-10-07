import { ApiError } from "./protocol.js";

/** Normalize an old server, without disguising real authorization or storage failures. */
export async function callSteeringOperation(api, name, params) {
    try {
        return await api.call(name, params);
    } catch (error) {
        if (error?.code === "UNKNOWN_OPERATION" || error?.code === "WEB_MODE_UNSUPPORTED"
            || error?.status === 404 && /^Unknown API route:/.test(error.message)
            || /^Unsupported portal RPC method:/.test(error?.message || "")) {
            error = new ApiError("This server does not support session steering.", {
                code: "unsupported", reason: "web_mode_unsupported", status: 409,
            });
        }
        if (name === "steerSessionTurn") {
            const code = { FORBIDDEN: "forbidden", NOT_FOUND: "not_found", INVALID_REQUEST: "invalid", PAYLOAD_TOO_LARGE: "too_large" }[error?.code] || error?.code;
            if (["unsupported", "stale_target", "no_active_turn", "forbidden", "not_found", "invalid",
                "too_large", "rate_limited", "idempotency_conflict"].includes(code)) {
                return {
                    ok: false, code,
                    ...(typeof error.reason === "string" ? { reason: error.reason } : {}),
                    ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
                };
            }
        }
        throw error;
    }
}
