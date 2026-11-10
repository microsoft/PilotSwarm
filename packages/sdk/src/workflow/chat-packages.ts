/**
 * Package Workflow Definitions for chats (Workflow Simplified stage 2.3; spec "Packages and Agent Smith": P1–P6, D7, D8).
 *
 * A published package exports its Workflow Definitions in its manifest (agent-package-format.ts: name, card, digests and
 * interface; the YAML stays in the package's bytes). This module reads them as a chat's owner sees them:
 *
 * - visible: the agent registry's enabled packages at their active versions (getAgentPackagesInstallManifest), shared or
 *   the owner's own; when both have a package of one name, the owner's own copy is the one (as for agents);
 * - read: a definition's YAML comes out of that package version's bytes, which are checked against the registry's content
 *   hash (fetchAgentPackageTarGz) and against the YAML hash the manifest exported, so what a chat attaches is exactly what
 *   was published and checked with its card (P7);
 * - a chat names one `<package>/<name>` (D7); an agent's bare name means its own package (P4).
 *
 * The chat side (attach, start, the card, what a chat may start) is in chat-definitions.ts and definition-tool.ts.
 */
import type { AgentPackageInstallEntry, SessionCatalog } from "../cms.js";
import type { ArtifactStore } from "../session-store.js";
import type { AgentPackageWorkflowExport } from "../agent-package-format.js";
import { compareSemver, isValidSemver, readAgentPackageTarGz } from "../agent-package-format.js";
import { fetchAgentPackageTarGz } from "../agent-package-service.js";
import { isJsonObject, sha256Hex } from "./json.js";
import { readWorkflowCard, workflowEffectFacts, workflowPackageRef, type WorkflowEffectFacts } from "./package-card.js";
import { compileWorkflow } from "./compiler.js";
import { WorkflowStoreError } from "./store.js";

/** Whose packages a chat sees: its owner (null: shared packages only). */
export interface PackageViewer {
    provider: string;
    subject: string;
}

/** One package Workflow Definition as a viewer sees it. */
export interface PackageWorkflowEntry {
    /** `<package>/<name>`. */
    ref: string;
    packageId: string;
    packageName: string;
    /** plugin.json title, when it has one. */
    packageTitle: string | null;
    /** The package version. */
    semver: string;
    /** The package version's content hash. */
    sha256: string;
    artifactFilename: string;
    scope: "shared" | "user";
    /** The viewer's own package. */
    mine: boolean;
    workflow: AgentPackageWorkflowExport;
}

export interface PackageWorkflowSource {
    /** Every package Workflow Definition the viewer sees, by reference. */
    list(viewer: PackageViewer | null): Promise<PackageWorkflowEntry[]>;
    /** One by package and name, or null. */
    find(ref: { packageName: string; name: string }, viewer: PackageViewer | null): Promise<PackageWorkflowEntry | null>;
    /** Its YAML, from the package version's checked bytes. */
    readYaml(entry: PackageWorkflowEntry): Promise<string>;
    /** S2SF-F4: what its YAML shows of its effects (its script and agent steps), whatever its card says. */
    readFacts?(entry: PackageWorkflowEntry): Promise<WorkflowEffectFacts>;
}

const YAML_CACHE_MAX = 64;

/** A manifest's exported definitions that are well formed (an older or damaged manifest exports none). */
export function manifestWorkflows(manifest: unknown): AgentPackageWorkflowExport[] {
    const list = isJsonObject(manifest) ? (manifest as { workflows?: unknown }).workflows : undefined;
    if (!Array.isArray(list)) return [];
    return list.flatMap((item: unknown) => {
        if (!isJsonObject(item)) return [];
        const value = item as Record<string, unknown>;
        const card = readWorkflowCard(value.card);
        if (typeof value.name !== "string" || typeof value.yamlSha256 !== "string" || typeof value.irSha256 !== "string"
            || typeof value.cardDigest !== "string" || !card || !isJsonObject(value.interface)) return [];
        return [{
            name: value.name, version: typeof value.version === "string" ? value.version : "", description: card.description,
            yamlSha256: value.yamlSha256, irSha256: value.irSha256, card, cardDigest: value.cardDigest,
            interface: value.interface as unknown as AgentPackageWorkflowExport["interface"],
        }];
    });
}

/**
 * Stage 2 review S2SF-F6 / formal L4: whether `candidate` is a newer version of the package version `attached`: the same
 * package (its package id: not another package of the same name, such as an owner's own copy that shadows a shared one)
 * with a strictly greater semver. An older active version (a rollback) or another package is never "newer".
 */
export function packageVersionIsNewer(attached: { packageId: string; semver: string } | null | undefined,
    candidate: { packageId: string; semver: string } | null | undefined): boolean {
    if (!attached || !candidate || attached.packageId !== candidate.packageId) return false;
    if (!isValidSemver(attached.semver) || !isValidSemver(candidate.semver)) return false;
    return compareSemver(candidate.semver, attached.semver) > 0;
}

/** A manifest agent's workflows list, as published. */
export function manifestAgentWorkflows(manifest: unknown, agentName: string): string[] {
    const agents = isJsonObject(manifest) ? (manifest as { agents?: unknown }).agents : undefined;
    if (!Array.isArray(agents)) return [];
    const agent = agents.find((item: unknown) => isJsonObject(item) && (item as { name?: unknown }).name === agentName) as { workflows?: unknown } | undefined;
    return Array.isArray(agent?.workflows) ? agent!.workflows.filter((ref): ref is string => typeof ref === "string") : [];
}

function visibleTo(entry: AgentPackageInstallEntry, viewer: PackageViewer | null): { visible: boolean; mine: boolean } {
    if (entry.scope !== "user") return { visible: true, mine: false };
    const mine = viewer !== null && entry.owner?.provider === viewer.provider && entry.owner?.subject === viewer.subject;
    return { visible: mine, mine };
}

/** The registry's package definitions over `catalog` and the package bytes in `artifactStore`. */
export function createPackageWorkflowSource(deps: {
    catalog: Pick<SessionCatalog, "getAgentPackagesInstallManifest">;
    artifactStore: ArtifactStore;
}): PackageWorkflowSource {
    const yamlCache = new Map<string, string>();
    const factsCache = new Map<string, WorkflowEffectFacts>();
    const list = async (viewer: PackageViewer | null): Promise<PackageWorkflowEntry[]> => {
        const entries = await deps.catalog.getAgentPackagesInstallManifest();
        // One copy per package name: the viewer's own, else the shared one.
        const chosen = new Map<string, { entry: AgentPackageInstallEntry; mine: boolean }>();
        for (const entry of entries) {
            const { visible, mine } = visibleTo(entry, viewer);
            if (!visible) continue;
            const current = chosen.get(entry.name);
            if (!current || (mine && !current.mine)) chosen.set(entry.name, { entry, mine });
        }
        const out: PackageWorkflowEntry[] = [];
        for (const { entry, mine } of [...chosen.values()].sort((a, b) => a.entry.name.localeCompare(b.entry.name))) {
            const title = isJsonObject(entry.manifest) && typeof (entry.manifest as { title?: unknown }).title === "string"
                ? String((entry.manifest as { title?: unknown }).title) : null;
            for (const workflow of manifestWorkflows(entry.manifest)) {
                out.push({ ref: workflowPackageRef(entry.name, workflow.name), packageId: entry.packageId, packageName: entry.name, packageTitle: title,
                    semver: entry.semver, sha256: entry.sha256, artifactFilename: entry.artifactFilename, scope: entry.scope === "user" ? "user" : "shared",
                    mine, workflow });
            }
        }
        return out;
    };
    return {
        list,
        async find(ref, viewer) {
            return (await list(viewer)).find(item => item.packageName === ref.packageName && item.workflow.name === ref.name) ?? null;
        },
        async readYaml(entry) {
            const key = `${entry.sha256}/${entry.workflow.name}`;
            const cached = yamlCache.get(key);
            if (cached !== undefined) return cached;
            let files;
            try {
                files = readAgentPackageTarGz(await fetchAgentPackageTarGz(deps.artifactStore, entry.artifactFilename, entry.sha256));
            } catch (error) {
                throw new WorkflowStoreError("PACKAGE_UNAVAILABLE", `The package ${entry.packageName} ${entry.semver} could not be read: `
                    + `${error instanceof Error ? error.message : String(error)}. Nothing was changed; try again.`, { packageId: entry.packageId, retryable: true });
            }
            const file = files.find(item => item.name === `workflows/${entry.workflow.name}/workflow.yaml`);
            const yaml = file ? file.body.toString("utf8") : null;
            if (yaml === null || sha256Hex(yaml) !== entry.workflow.yamlSha256) {
                throw new WorkflowStoreError("PACKAGE_UNAVAILABLE", `The package ${entry.packageName} ${entry.semver} does not hold the ${entry.workflow.name} it `
                    + "published. Nothing was changed.", { packageId: entry.packageId });
            }
            if (yamlCache.size >= YAML_CACHE_MAX) yamlCache.delete(yamlCache.keys().next().value as string);
            yamlCache.set(key, yaml);
            return yaml;
        },
        async readFacts(entry) {
            const key = `${entry.sha256}/${entry.workflow.name}`;
            const cached = factsCache.get(key);
            if (cached) return cached;
            // Compiled as publication compiles it (every node type), from the checked bytes.
            const compiled = compileWorkflow(await this.readYaml(entry));
            if (!compiled.ir) {
                throw new WorkflowStoreError("PACKAGE_UNAVAILABLE", `The package ${entry.packageName} ${entry.semver}'s ${entry.workflow.name} does not compile here.`,
                    { packageId: entry.packageId });
            }
            const facts = workflowEffectFacts(compiled.ir);
            if (factsCache.size >= YAML_CACHE_MAX) factsCache.delete(factsCache.keys().next().value as string);
            factsCache.set(key, facts);
            return facts;
        },
    };
}
