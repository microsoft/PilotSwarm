/**
 * The deployment's agent package capability policy (issue 311): what kinds of
 * content an agent package may contain. Publishing refuses a package that
 * breaks it, and worker package loading refuses to load one.
 *
 * Two capabilities exist:
 *
 *  - `mcpServers: "deployment-only"` — a package may not DEFINE MCP servers
 *    (`.mcp.json`, or an `mcp-servers/` folder). Its agents still name the
 *    deployment's own servers, subject to their `allowedAgents`.
 *  - `workerModules: "disabled"` — a package may not ship worker code
 *    (`tools/worker-module.js`).
 *
 * ADDING A CAPABILITY is one entry in each of three places, and no new
 * mechanism:
 *
 *  1. `AGENT_PACKAGE_CAPABILITY_VALUES` — its name and allowed values, the
 *     first value being the default that changes nothing;
 *  2. `CAPABILITY_RULES` — the one rule: which restricted value refuses, and
 *     which path in the package's installed layout shows the package has it;
 *  3. its environment variable, which follows from the name:
 *     `PILOTSWARM_AGENT_PACKAGES_<NAME_IN_UPPER_SNAKE_CASE>`.
 *
 * The option type, the environment parsing, the evaluator, the refusal code
 * and every place that enforces it pick the new entry up from there.
 *
 * The evaluator reads file PRESENCE only, never contents and never package
 * code. Its input is the package's final installed layout — the canonical
 * archive's entries on publish, the unpacked directory on a worker, folders
 * included even when empty — so publish and load see the same thing.
 */

/** Every capability, its allowed values, and (first) its default. */
export const AGENT_PACKAGE_CAPABILITY_VALUES = {
    mcpServers: ["enabled", "deployment-only"],
    workerModules: ["enabled", "disabled"],
} as const;

/** A capability the policy can restrict. */
export type AgentPackageCapability = keyof typeof AGENT_PACKAGE_CAPABILITY_VALUES;

/** `PilotSwarmWorkerOptions.agentPackages.capabilities`: unset fields mean `"enabled"`. */
export type AgentPackageCapabilities = {
    [C in AgentPackageCapability]?: (typeof AGENT_PACKAGE_CAPABILITY_VALUES)[C][number];
};

/** The policy with every field decided. */
export type ResolvedAgentPackageCapabilities = Required<AgentPackageCapabilities>;

/** The stable code for a package the policy refuses. */
export const PACKAGE_CAPABILITY_REFUSED = "PACKAGE_CAPABILITY_REFUSED";

/** Why a package is refused. Carries no file content. */
export interface AgentPackageCapabilityRefusal {
    code: typeof PACKAGE_CAPABILITY_REFUSED;
    capability: AgentPackageCapability;
    /** The configured value that refuses it. */
    setting: string;
    /** The package path that shows the package has the capability. */
    path: string;
    /** One sentence for a person. */
    reason: string;
}

export const AGENT_PACKAGE_CAPABILITIES = Object.keys(AGENT_PACKAGE_CAPABILITY_VALUES) as AgentPackageCapability[];

/** `mcpServers` → `PILOTSWARM_AGENT_PACKAGES_MCP_SERVERS`. */
export function agentPackageCapabilityEnvVar(capability: AgentPackageCapability): string {
    return `PILOTSWARM_AGENT_PACKAGES_${capability.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
}

function allowedValue(capability: AgentPackageCapability, raw: unknown, source: string): string {
    const allowed = AGENT_PACKAGE_CAPABILITY_VALUES[capability] as readonly string[];
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    // The bad value is not echoed: an environment value can be anything.
    if (!allowed.includes(value)) throw new Error(`${source} must be one of: ${allowed.join(", ")}`);
    return value;
}

/**
 * The policy a host runs with: the SDK option first, then the environment
 * variable, then the default. Values are case-insensitive after trimming. An
 * invalid value or an unknown capability throws an error naming the setting.
 */
export function resolveAgentPackageCapabilities(
    option?: AgentPackageCapabilities | null,
    env: Record<string, string | undefined> = process.env,
): ResolvedAgentPackageCapabilities {
    for (const key of Object.keys(option ?? {})) {
        if (!Object.hasOwn(AGENT_PACKAGE_CAPABILITY_VALUES, key)) {
            throw new Error(`agentPackages.capabilities.${key} is not a known capability; known: ${AGENT_PACKAGE_CAPABILITIES.join(", ")}`);
        }
    }
    const resolved: Record<string, string> = {};
    for (const capability of AGENT_PACKAGE_CAPABILITIES) {
        const fromOption = option?.[capability];
        const variable = agentPackageCapabilityEnvVar(capability);
        const fromEnv = env[variable];
        if (fromOption !== undefined && fromOption !== null) {
            resolved[capability] = allowedValue(capability, fromOption, `agentPackages.capabilities.${capability}`);
        } else if (fromEnv !== undefined) {
            // Set but blank is a mistake, not "unset": fail rather than quietly enable.
            if (fromEnv.trim() === "") throw new Error(`${variable} is set but blank; set one of: ${AGENT_PACKAGE_CAPABILITY_VALUES[capability].join(", ")}, or unset it`);
            resolved[capability] = allowedValue(capability, fromEnv, variable);
        } else {
            resolved[capability] = AGENT_PACKAGE_CAPABILITY_VALUES[capability][0];
        }
    }
    return resolved as ResolvedAgentPackageCapabilities;
}

/** True when any capability is restricted, i.e. a package's layout has to be read at all. */
export function agentPackageCapabilitiesRestrict(policy: ResolvedAgentPackageCapabilities): boolean {
    return AGENT_PACKAGE_CAPABILITIES.some(capability => policy[capability] !== AGENT_PACKAGE_CAPABILITY_VALUES[capability][0]);
}

/** A one-line, comparable form of the policy (`mcpServers=deployment-only;workerModules=enabled`). */
export function agentPackageCapabilitiesFingerprint(policy: ResolvedAgentPackageCapabilities): string {
    return AGENT_PACKAGE_CAPABILITIES.map(capability => `${capability}=${policy[capability]}`).join(";");
}

/**
 * A package's installed layout: every file and every folder, by normalized
 * package-relative path. A folder is given with a trailing `/`, and every
 * parent of a path is a folder too; any other path is a file. Paths are
 * compared case-insensitively, so a name that only a case-insensitive file
 * system would load (`.MCP.json`) cannot slip past the rule for it.
 */
export class AgentPackageLayout {
    private readonly files = new Set<string>();
    private readonly folders = new Set<string>();

    constructor(paths: Iterable<string>) {
        for (const raw of paths) {
            const text = String(raw).replace(/\\/g, "/");
            const parts = text.split("/").filter(part => part !== "" && part !== ".");
            if (parts.length === 0) continue;
            for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/").toLowerCase());
            const leaf = parts.join("/").toLowerCase();
            if (text.endsWith("/")) this.folders.add(leaf);
            else this.files.add(leaf);
        }
    }

    /**
     * Whether the layout holds `relPath`: a folder when it ends with `/`
     * (`mcp-servers/`), otherwise a file or a folder of that name.
     */
    has(relPath: string): boolean {
        const key = relPath.toLowerCase();
        if (key.endsWith("/")) return this.folders.has(key.slice(0, -1));
        return this.files.has(key) || this.folders.has(key);
    }
}

/**
 * The capability rules: one per capability. A rule fires only when the policy
 * holds `refuses` for its capability, and refuses the package when the layout
 * holds any of `paths`.
 */
const CAPABILITY_RULES: ReadonlyArray<{
    capability: AgentPackageCapability;
    refuses: string;
    paths: readonly string[];
    what: string;
}> = [
    // `mcp-servers/` is the folder only (even empty); a plain file of that name defines nothing.
    { capability: "mcpServers", refuses: "deployment-only", paths: [".mcp.json", "mcp-servers/"], what: "defines MCP servers" },
    { capability: "workerModules", refuses: "disabled", paths: ["tools/worker-module.js"], what: "ships a worker module" },
];

/**
 * THE evaluator. Publishing and worker loading both call it, on the same
 * installed layout, so they cannot disagree. Pure: no file system, no logging.
 * Returns null when the package may load.
 */
export function evaluateAgentPackageCapabilities(
    policy: ResolvedAgentPackageCapabilities,
    layout: AgentPackageLayout | Iterable<string>,
): AgentPackageCapabilityRefusal | null {
    const installed = layout instanceof AgentPackageLayout ? layout : new AgentPackageLayout(layout);
    for (const rule of CAPABILITY_RULES) {
        if (policy[rule.capability] !== rule.refuses) continue;
        const match = rule.paths.find(candidate => installed.has(candidate));
        if (match === undefined) continue;
        const found = match.replace(/\/$/, "");
        return {
            code: PACKAGE_CAPABILITY_REFUSED,
            capability: rule.capability,
            setting: rule.refuses,
            path: found,
            reason: `This package ${rule.what} (${found}), and this deployment's agent package policy sets `
                + `${rule.capability} to "${rule.refuses}". The whole package is refused.`,
        };
    }
    return null;
}

/** The text recorded on a quarantined package and in its error. */
export function agentPackageCapabilityRefusalText(refusal: AgentPackageCapabilityRefusal): string {
    return `${refusal.code}: ${refusal.capability}: package contains ${refusal.path}; policy is ${refusal.setting}`;
}

/** An error carrying a refusal: thrown at publish and at session use. */
export class AgentPackageCapabilityRefusedError extends Error {
    readonly code = PACKAGE_CAPABILITY_REFUSED;
    readonly capability: AgentPackageCapability;
    readonly refusal: AgentPackageCapabilityRefusal;
    /** A client error: the Web API answers 400 with this code, not a server failure. */
    readonly status = 400;
    /** The structured part is safe to show: capability, setting and the package path. */
    readonly exposeDetails = true;
    readonly details: { capability: AgentPackageCapability; setting: string; path: string };

    constructor(refusal: AgentPackageCapabilityRefusal, subject?: string) {
        super(`${agentPackageCapabilityRefusalText(refusal)}${subject ? ` (${subject})` : ""}. ${refusal.reason}`);
        this.name = "AgentPackageCapabilityRefusedError";
        this.capability = refusal.capability;
        this.refusal = refusal;
        this.details = { capability: refusal.capability, setting: refusal.setting, path: refusal.path };
    }
}
