/**
 * Code-owned definitions. Publish changes through a versioned CMS migration.
 *
 * `alwaysOn: true` marks a flag as always on. That designation is code-owned
 * and needs no migration: every reader (runtime, APIs, management tools and
 * the UI) treats the flag as on before it reads any stored setting, and
 * refuses changes to it (FEATURE_ALWAYS_ON). Stored definition and setting
 * rows for it are ignored and may stay in the database. To retire a flag,
 * add `alwaysOn: true` to its entry; a later release may remove it entirely.
 */
export const FEATURE_FLAGS = {
    "copilot.native_tasks": {
        displayName: "Native Copilot tasks",
        description: "Allow Copilot to delegate local work to native tasks on the same worker.",
        defaultEnabled: false,
        defaultAllowUserOverride: true,
        requiredCapability: "copilot.native_tasks",
        alwaysOn: true,
    },
    "agents.base_v2": {
        displayName: "Base Agent V2",
        description: "Use the discovery-first base instructions with native tasks. Requires Native Copilot tasks; package tools remain available in either mode.",
        defaultEnabled: false,
        defaultAllowUserOverride: true,
        requiredCapability: "agents.base_v2",
        alwaysOn: true,
    },
    "sessions.steering": {
        displayName: "Steer running turns",
        description: "Let people add guidance to a running turn that the model receives at its next model call. Stop does not depend on this flag. The operator enables it; users may override it only when the operator allows.",
        defaultEnabled: false,
        defaultAllowUserOverride: false,
        requiredCapability: null,
        alwaysOn: true,
    },
    "debug.enable_model_event_logging": {
        displayName: "Model event logging",
        description: "Record the Copilot CLI's model trace events (model.message, model.messages_snapshot, model.tool_execution, model.model_call_success) in the session event log. They repeat the whole conversation on every turn and are large; turn on only for debugging.",
        defaultEnabled: false,
        defaultAllowUserOverride: true,
        requiredCapability: null,
    },
} as const satisfies Record<string, FeatureFlagEntry>;
interface FeatureFlagEntry {
    displayName: string; description: string;
    defaultEnabled: boolean; defaultAllowUserOverride: boolean;
    requiredCapability: string | null;
    /** Code-owned: the flag is on regardless of stored settings and cannot be changed. */
    alwaysOn?: true;
}
export type FeatureKey = keyof typeof FEATURE_FLAGS;
/** Shown wherever an always-on flag is displayed, and in the FEATURE_ALWAYS_ON refusal. */
export const FEATURE_ALWAYS_ON_NOTICE = "This switch is now always on and may be removed in a future release.";
/** True when the registry marks `key` always on (unknown keys are not). */
export function isAlwaysOn(key: string): boolean {
    return Object.hasOwn(FEATURE_FLAGS, key) && (FEATURE_FLAGS[key as FeatureKey] as FeatureFlagEntry).alwaysOn === true;
}
/** The decision for an always-on key; independent of the cache, catalog and settings. */
export function alwaysOnDecision(): FeatureDecision {
    return { enabled: true, source: "always_on", revision: null, stale: false };
}
/** Refuse a change to an always-on key before any row is written. */
export function assertFeatureMutable(key: string): void {
    if (isAlwaysOn(key)) {
        throw new FeatureFlagError("FEATURE_ALWAYS_ON", `${key} cannot be changed. ${FEATURE_ALWAYS_ON_NOTICE}`, 409);
    }
}
export type ResolveOptions = { fallback: boolean; required?: never } | { required: true; fallback?: never };
export interface FeatureOwner { provider: string; subject: string }
export interface FeatureDefinition {
    featureKey: string; displayName: string; description: string;
    defaultEnabled: boolean; defaultAllowUserOverride: boolean;
    requiredCapability: string | null; revision: string;
}
export interface FeatureSetting {
    settingId: string; featureKey: string; scope: "cluster" | "user";
    userId: number | null; enabled: boolean; allowUserOverride: boolean | null;
    revision: string; updatedBy: string; updatedAt: string;
    owner?: FeatureOwner;
}
export interface FeatureSnapshot { definitions: FeatureDefinition[]; settings: FeatureSetting[] }
export interface FeatureDecision {
    enabled: boolean; source: "always_on" | "cluster" | "user" | "default" | "fallback";
    revision: string | null; stale: boolean;
    reason?: "unknown_key" | "catalog_missing" | "cache_unavailable" | "requires_native_tasks";
}
export class FeatureFlagError extends Error {
    constructor(public readonly code: string, message: string, public readonly status = 400) {
        super(message); this.name = "FeatureFlagError";
    }
}
export class FeatureFlagResolutionError extends FeatureFlagError {
    constructor(code: string, key: string) { super(code, `Cannot resolve feature ${key}: ${code}`, 503); this.name = "FeatureFlagResolutionError"; }
}
export function isFeatureKey(key: string): key is FeatureKey { return Object.hasOwn(FEATURE_FLAGS, key); }
export function featureOwnerKey(owner: FeatureOwner): string { return JSON.stringify([owner.provider, owner.subject]); }
export function assertResolveOptions(options: ResolveOptions): void {
    if (!options || typeof options !== "object"
        || !(typeof options.fallback === "boolean" && options.required === undefined
            || options.required === true && options.fallback === undefined)) {
        throw new TypeError("Feature resolution requires either { fallback: boolean } or { required: true }");
    }
}
export function unresolvedFeature(key: string, options: ResolveOptions, reason: FeatureDecision["reason"], stale = false): FeatureDecision {
    if (options.required) throw new FeatureFlagResolutionError(reason!, key);
    return { enabled: options.fallback!, source: "fallback", revision: null, reason, stale };
}
export function resolveFeatureDefinition(definition: FeatureDefinition, cluster?: FeatureSetting, user?: FeatureSetting, stale = false): FeatureDecision {
    if (isAlwaysOn(definition.featureKey)) return alwaysOnDecision();
    const enabled = cluster?.enabled ?? definition.defaultEnabled;
    const allowOverride = cluster?.allowUserOverride ?? definition.defaultAllowUserOverride;
    return { enabled: allowOverride && user ? user.enabled : enabled,
        source: allowOverride && user ? "user" : cluster ? "cluster" : "default",
        revision: definition.revision, stale };
}

/** A narrow prerequisite for the base prompt; saved preferences remain independent. */
export function applyBaseAgentPrerequisite(key: string, decision: FeatureDecision, native: FeatureDecision | undefined): FeatureDecision {
    if (key !== "agents.base_v2" || !decision.enabled || native?.enabled === true) return decision;
    return { ...decision, enabled: false, stale: decision.stale || native?.stale === true, reason: "requires_native_tasks" };
}
