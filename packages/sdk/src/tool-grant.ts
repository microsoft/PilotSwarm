export type CapabilityToolGrant = "all" | "none" | string[];

export const TOOL_CEILING_MAX = 64;
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,127}$/;
const SELECTOR_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type ToolCeiling = "none" | string[];
export const TOOL_GRANT_PARAMETER = {
    description: "Capability tools to give the child: all, none, or names, package:<name> and mcp:<server>. Every entry must be held by this session. Default all for unnamed children, none for named agents. Pins are fixed at spawn. Keep grants small.",
    oneOf: [
        { type: "string", enum: ["all", "none"] },
        { type: "array", items: { type: "string" }, minItems: 1, maxItems: TOOL_CEILING_MAX, uniqueItems: true },
    ],
};
export const TOOL_CEILING_PARAMETER = {
    description: "Maximum tool names the child and every child below it may use, in every category. It removes tools and grants none. Omit for no extra ceiling; none removes all tools.",
    oneOf: [
        { type: "string", enum: ["none"] },
        { type: "array", items: { type: "string" }, minItems: 1, maxItems: TOOL_CEILING_MAX, uniqueItems: true },
    ],
};

export function isToolCeiling(value: unknown): value is ToolCeiling {
    return value === "none" || (Array.isArray(value) && value.length >= 1 && value.length <= TOOL_CEILING_MAX
        && new Set(value).size === value.length && value.every(name => typeof name === "string" && TOOL_NAME_PATTERN.test(name)));
}

export function isCapabilityToolGrant(value: unknown): value is CapabilityToolGrant {
    return value === "all" || value === "none" || (Array.isArray(value)
        && value.length >= 1 && value.length <= TOOL_CEILING_MAX
        && new Set(value).size === value.length && value.every(entry => typeof entry === "string"
            && (entry.startsWith("package:") ? SELECTOR_NAME_PATTERN.test(entry.slice("package:".length))
                : entry.startsWith("mcp:") ? SELECTOR_NAME_PATTERN.test(entry.slice("mcp:".length))
                : TOOL_NAME_PATTERN.test(entry))));
}

export interface HeldCapabilityTool {
    name: string;
    package?: string;
    mcp?: string;
}

export class CapabilityGrantError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CapabilityGrantError";
    }
}

/** The caller supplies capability tools only, never role or identity tools. */
export function selectCapabilityToolGrant(grant: CapabilityToolGrant, held: readonly HeldCapabilityTool[]): Set<string> {
    if (!isCapabilityToolGrant(grant)) {
        throw new CapabilityGrantError("grant must be all, none, or a list of distinct tool, package: or mcp: names.");
    }
    if (grant === "none") return new Set();
    if (grant === "all") return new Set(held.map(tool => tool.name));
    const selected = new Set<string>();
    for (const entry of grant) {
        const matches = held.filter(tool => entry.startsWith("package:") ? tool.package === entry.slice("package:".length)
            : entry.startsWith("mcp:") ? tool.mcp === entry.slice("mcp:".length) : tool.name === entry);
        if (!matches.length) throw new CapabilityGrantError(`grant '${entry}' was refused: the parent does not hold that capability.`);
        for (const tool of matches) selected.add(tool.name);
    }
    return selected;
}
