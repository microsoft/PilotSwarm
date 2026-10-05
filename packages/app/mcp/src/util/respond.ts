/** Shared MCP tool-response helpers — same content shape the existing tool
 * files emit inline; new tool modules use these to cut boilerplate. */

export interface ToolResult {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
    [key: string]: unknown;
}

export function jsonResult(payload: unknown): ToolResult {
    return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    };
}

export function errorResult(message: string, extra?: Record<string, unknown>): ToolResult {
    const text = extra
        ? JSON.stringify({ error: message, ...extra })
        : `Error: ${message}`;
    return {
        content: [{ type: "text" as const, text }],
        isError: true,
    };
}

/** A 403 message that carries no reason: empty, "Forbidden", or "HTTP 403". */
const BARE_403_MESSAGE = /^(?:forbidden|http 403|403(?: forbidden)?)?\.?$/i;

/**
 * Map a thrown error to a tool error result. A Web API 403 keeps the
 * server's own reason. A 403 with no reason says so and does not guess one.
 */
export function errorToResult(err: unknown): ToolResult {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as any)?.status ?? (err as any)?.statusCode;
    if ((err as any)?.code === "MODEL_AMBIGUOUS") {
        return errorResult(message, {
            code: "MODEL_AMBIGUOUS",
            candidates: Array.isArray((err as any)?.candidates) ? (err as any).candidates : [],
        });
    }
    // Match the text only when the error has no numeric status. A 404 or
    // 500 whose message says "forbidden" is not a 403.
    const forbidden = status === 403
        || (typeof status !== "number" && /\b403\b|forbidden/i.test(message));
    if (forbidden) {
        // A 403 that names its rule (AGENT_PACKAGE_FORBIDDEN: only the
        // package creator, an editor, or an admin …) is the answer the model
        // needs. Pass it on as is.
        if (/[A-Z][A-Z_]+_FORBIDDEN:/.test(message)) {
            return errorResult(message, { status: 403, code: "FORBIDDEN" });
        }
        // Many rules end in a 403: owner only, admin scope, admin role.
        // Pass on the server's reason. Never guess which rule it was.
        const details = { status: 403, code: (err as any)?.code ?? "FORBIDDEN" };
        if (BARE_403_MESSAGE.test(message.trim())) {
            return errorResult("The server refused this call (HTTP 403) and gave no reason.", details);
        }
        return errorResult(message, details);
    }
    return errorResult(message);
}

/** Wrap a tool handler with the standard try/catch → errorToResult mapping. */
export function withToolErrors<A extends unknown[]>(
    fn: (...args: A) => Promise<ToolResult>,
): (...args: A) => Promise<ToolResult> {
    return async (...args: A) => {
        try {
            return await fn(...args);
        } catch (err: unknown) {
            return errorToResult(err);
        }
    };
}
