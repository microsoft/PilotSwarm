import type { PermissionRequestResult } from "@github/copilot-sdk";

type PermissionRequestLike = {
    kind?: string;
    commands?: Array<{ identifier?: unknown }>;
    serverName?: unknown;
    toolName?: unknown;
};

type SessionApproval =
    | { kind: "commands"; commandIdentifiers: string[] }
    | { kind: "read" }
    | { kind: "write" }
    | { kind: "mcp"; serverName: string; toolName: string | null }
    | { kind: "mcp-sampling"; serverName: string }
    | { kind: "memory" }
    | { kind: "custom-tool"; toolName: string };

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values));
}

function shellCommandIdentifiers(request: PermissionRequestLike): string[] {
    if (!Array.isArray(request.commands)) return [];
    return uniqueStrings(
        request.commands
            .map((command) => stringOrNull(command?.identifier))
            .filter((identifier): identifier is string => Boolean(identifier)),
    );
}

export function sessionApprovalForPermissionRequest(request?: PermissionRequestLike): SessionApproval | null {
    if (!request || typeof request !== "object") return null;

    switch (request.kind) {
        case "shell":
            return {
                kind: "commands",
                commandIdentifiers: shellCommandIdentifiers(request),
            };
        case "read":
            return { kind: "read" };
        case "write":
            return { kind: "write" };
        case "mcp": {
            const serverName = stringOrNull(request.serverName);
            if (!serverName) return null;
            return {
                kind: "mcp",
                serverName,
                toolName: stringOrNull(request.toolName),
            };
        }
        case "mcp-sampling": {
            const serverName = stringOrNull(request.serverName);
            return serverName ? { kind: "mcp-sampling", serverName } : null;
        }
        case "memory":
            return { kind: "memory" };
        case "custom-tool": {
            const toolName = stringOrNull(request.toolName);
            return toolName ? { kind: "custom-tool", toolName } : null;
        }
        default:
            return null;
    }
}

/**
 * The session configuration of a helper that runs a model over a
 * session's own content and must be able to do nothing else.
 *
 * Title generation and context distillation both hand a model the
 * transcript of a session whose events may have come from somewhere this
 * worker does not trust. They need no tool to do their job — one reads a
 * conversation and writes a line, the other reads it and writes a summary
 * — so they are given none: no built-in tools, no MCP servers, no skills,
 * and a permission handler that refuses whatever is asked for anyway.
 *
 * That holds whether or not the deployment uses compute targets: a helper
 * that cannot run anything cannot be talked into running anything.
 */
export const TOOL_FREE_HELPER_SESSION = {
    availableTools: [] as string[],
    excludedTools: ["*"],
    mcpServers: {} as Record<string, never>,
    skillDirectories: [] as string[],
    onPermissionRequest: refuseAllPermissions,
};

/**
 * Refuse every permission a session asks for.
 *
 * Used by the helpers above. A helper has no tools, so nothing should
 * ever ask; if something does, the answer is no, and the attempt is
 * visible rather than quietly approved.
 */
export function refuseAllPermissions(_request?: PermissionRequestLike): PermissionRequestResult {
    return {
        kind: "reject",
        feedback: "this helper session runs a model over a transcript and may use no tools",
    } as PermissionRequestResult;
}

export function approvePermissionForSession(request?: PermissionRequestLike): PermissionRequestResult {
    const approval = sessionApprovalForPermissionRequest(request);
    if (!approval) return { kind: "approve-once" } as PermissionRequestResult;
    return {
        kind: "approve-for-session",
        approval,
    } as PermissionRequestResult;
}
