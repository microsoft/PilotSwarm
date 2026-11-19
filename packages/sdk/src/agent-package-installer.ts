/**
 * Agent package installer — materializes the registry's install manifest into
 * a local cache directory and loads package worker modules.
 *
 * Used by PilotSwarmWorker at startup and on every registry-epoch refresh
 * (and by the portal for its catalog/workspace needs). Per-package failures
 * quarantine that package only — a corrupted tarball or a broken
 * worker-module must never take the worker down or block other packages.
 *
 * Cache layout: <cacheDir>/<name>@<semver>.<sha12>/ with a
 * .pilotswarm-meta.json sidecar carrying the verified sha256. A directory
 * whose sidecar matches the registry sha is reused without downloading —
 * this is the "never re-pull the same package" guarantee.
 */

import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import type { ArtifactStore } from "./session-store.js";
import type { AgentPackageInstallEntry, SessionCatalog } from "./cms.js";
import { extractAgentPackageTarGz } from "./agent-package-format.js";
import { fetchAgentPackageTarGz } from "./agent-package-service.js";

const META_FILENAME = ".pilotswarm-meta.json";

export interface InstalledAgentPackage {
    /** Registry row identity — stable across versions, unique across scopes/owners. */
    packageId: string;
    name: string;
    semver: string;
    sha256: string;
    scope: "shared" | "user";
    owner: { provider: string; subject: string } | null;
    manifest: Record<string, unknown>;
    /** Absolute unpacked directory (loadable as a plugin dir). */
    dir: string;
    /** Absolute path to tools/worker-module.js when the package ships tools. */
    workerModulePath: string | null;
    status: "ok" | "error";
    error?: string;
}

export interface AgentPackageInstallResult {
    epoch: number;
    packages: InstalledAgentPackage[];
    /** Plugin dirs of every OK package, install-manifest order. */
    pluginDirs: string[];
}

/**
 * Cache directory name for one installed package.
 *
 * The OWNER DISCRIMINATOR is load-bearing, not cosmetic. With per-user
 * namespaces (migration 0043) two people can publish the same `name`, and if
 * their content is byte-identical the old `name@semver.sha` key resolved to
 * the SAME directory for both. That collapses package provenance — and
 * provenance is the only thing keeping a user-scope agent private, because the
 * worker holds every tenant's packages at once. Two owners sharing a directory
 * meant one of them being denied their own agent.
 *
 * Shared packages keep the historical bare `name@semver.sha` shape, so
 * existing caches for them stay valid and are not needlessly re-downloaded.
 */
function cacheDirNameFor(entry: AgentPackageInstallEntry): string {
    const base = `${entry.name}@${entry.semver}.${entry.sha256.slice(0, 12)}`;
    if (entry.scope !== "user" || !entry.owner) return base;
    // Short, stable, filesystem-safe: the package id already IS the identity
    // of (scope, owner, name), so it needs no further encoding.
    return `${base}.u${String(entry.packageId).replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`;
}

/** The GC key for a cache dir: everything before the version marker. */
function cacheDirPackageName(dirName: string): string {
    return dirName.split("@")[0];
}

function readMetaSha(dir: string): string | null {
    try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILENAME), "utf8"));
        // A copy unpacked before folders were materialized lacks the empty
        // ones, which are part of the layout the capability policy reads:
        // unpack it once more rather than trust it.
        if (meta?.layout !== INSTALLED_LAYOUT_VERSION) return null;
        return typeof meta?.sha256 === "string" ? meta.sha256 : null;
    } catch {
        return null;
    }
}

/** How old a `.tmp-*` or `.retired-*` leftover in the cache must be before it is removed. */
export const INSTALL_LEFTOVER_MAX_AGE_MS = 60 * 60 * 1000;

/** Bumped when the unpacked layout changes; older copies are unpacked again. */
const INSTALLED_LAYOUT_VERSION = 2;

/**
 * An installed package's layout, as the capability policy reads it: every
 * file and folder under `dir` (folders with a trailing `/`), without the
 * installer's own sidecar.
 *
 * Only regular files and real folders can be in it. A package archive cannot
 * carry a link (readAgentPackageTarGz refuses one), so a link or any other
 * special entry in an installed tree means the tree was changed after it was
 * unpacked — by package code that ran while it was allowed, for example,
 * pointing `tools` at another folder so the policy sees no
 * `tools/worker-module.js` while the import follows the link. That is not
 * read past: this throws, and so does a directory that cannot be read. The
 * caller refuses rather than guess.
 */
export function installedAgentPackageLayout(dir: string): string[] {
    const out: string[] = [];
    const walk = (abs: string, rel: string, depth: number): void => {
        if (depth > 64) throw new Error("installed package layout is too deep to read");
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                out.push(`${childRel}/`);
                walk(path.join(abs, entry.name), childRel, depth + 1);
            } else if (entry.isFile()) {
                if (!rel && entry.name === META_FILENAME) continue;
                out.push(childRel);
            } else {
                throw new Error(`installed package contains a link or special file (${childRel}); it was changed after it was unpacked`);
            }
        }
    };
    walk(dir, "", 0);
    return out;
}

/** True when `dir` holds only regular files and real folders: a copy the installer may reuse. */
function installedTreeIsPristine(dir: string): boolean {
    try {
        installedAgentPackageLayout(dir);
        return true;
    } catch {
        return false;
    }
}

/**
 * Materialize every enabled package's active version into cacheDir.
 * Reads the epoch FIRST so a mutation that lands mid-install makes the next
 * poll see a newer epoch and re-converge (never lost, at worst one interval
 * late).
 */
/**
 * Install one registry entry into `cacheDir` (download, verify, unpack once;
 * a directory whose sidecar already carries the entry's sha is reused). A
 * failure is reported on the result, never thrown: it quarantines only this
 * package. `installAgentPackages` installs the registry's active versions
 * this way; a worker installs an exact earlier version the same way into a
 * cache of its own (agent-package-pins.ts).
 */
export async function installAgentPackageEntry(
    entry: AgentPackageInstallEntry,
    cacheDir: string,
    artifactStore: ArtifactStore,
): Promise<InstalledAgentPackage> {
    fs.mkdirSync(cacheDir, { recursive: true });
    const dir = path.join(cacheDir, cacheDirNameFor(entry));
    const installed: InstalledAgentPackage = {
        packageId: entry.packageId,
        name: entry.name,
        semver: entry.semver,
        sha256: entry.sha256,
        scope: entry.scope,
        owner: entry.owner,
        manifest: entry.manifest,
        dir,
        workerModulePath: null,
        status: "ok",
    };
    try {
        // A cached copy is reused only when its sidecar matches AND its tree
        // still holds nothing but regular files and folders. Anything else
        // was changed after unpacking; it is unpacked again from the
        // verified archive instead of trusted.
        if (readMetaSha(dir) !== entry.sha256 || !installedTreeIsPristine(dir)) {
            const targz = await fetchAgentPackageTarGz(
                artifactStore, entry.artifactFilename, entry.sha256,
            );
            // Unpack to a sibling tmp dir, stamp the sidecar, then rename
            // into place so a crash mid-unpack never yields a half dir
            // that passes the sidecar check.
            //
            // The live directory is NEVER deleted in place. Workers can share
            // one cache, and another worker may be reading this exact path
            // for its capability check: a recursive delete leaves a
            // half-deleted tree there (prohibited files gone, root still
            // readable) that a check could admit just before the complete
            // tree is renamed back. The old tree is renamed aside, the
            // complete replacement renamed in, and only then is the retired
            // tree deleted under its own name. At any instant the live path
            // is a complete tree or briefly absent, never a partial one.
            const tmp = fs.mkdtempSync(path.join(cacheDir, ".tmp-"));
            const retired = path.join(cacheDir, `.retired-${path.basename(tmp).slice(".tmp-".length)}`);
            try {
                extractAgentPackageTarGz(targz, tmp);
                fs.writeFileSync(
                    path.join(tmp, META_FILENAME),
                    JSON.stringify({ sha256: entry.sha256, semver: entry.semver, layout: INSTALLED_LAYOUT_VERSION, installedAt: new Date().toISOString() }),
                );
                let movedAside = false;
                try {
                    try {
                        fs.renameSync(dir, retired);
                        movedAside = true;
                    } catch (error: any) {
                        if (error?.code !== "ENOENT") throw error;
                    }
                    try {
                        fs.renameSync(tmp, dir);
                    } catch (raceError) {
                        // Shared-cache race (local multi-worker): if a
                        // concurrent installer won and the dir now carries the
                        // right sha, that IS success — content is identical.
                        if (readMetaSha(dir) === entry.sha256 && installedTreeIsPristine(dir)) {
                            fs.rmSync(tmp, { recursive: true, force: true });
                        } else {
                            throw raceError;
                        }
                    }
                } finally {
                    if (movedAside) fs.rmSync(retired, { recursive: true, force: true });
                }
            } catch (error) {
                fs.rmSync(tmp, { recursive: true, force: true });
                throw error;
            }
        }
        const workerModule = path.join(dir, "tools", "worker-module.js");
        installed.workerModulePath = fs.existsSync(workerModule) ? workerModule : null;
    } catch (error: any) {
        installed.status = "error";
        installed.error = String(error?.message ?? error);
    }
    return installed;
}

export async function installAgentPackages(opts: {
    catalog: SessionCatalog;
    artifactStore: ArtifactStore;
    cacheDir: string;
}): Promise<AgentPackageInstallResult> {
    const epoch = await opts.catalog.agentRegistryEpoch();
    const manifest = await opts.catalog.getAgentPackagesInstallManifest();
    fs.mkdirSync(opts.cacheDir, { recursive: true });

    const packages: InstalledAgentPackage[] = [];
    for (const entry of manifest) {
        packages.push(await installAgentPackageEntry(entry, opts.cacheDir, opts.artifactStore));
    }

    // Prune cache dirs whose PACKAGE no longer exists in the manifest at all.
    // Old-version dirs of live packages are kept deliberately: warm sessions'
    // stdio MCP servers may still run from them; pods recycle the rest.
    //
    // Keyed on the package NAME rather than the full dir key, because the key
    // now carries an owner discriminator: pruning on the whole key would
    // delete every older version the moment one was superseded.
    const liveNames = new Set(manifest.map((entry) => entry.name));
    try {
        for (const dirName of fs.readdirSync(opts.cacheDir)) {
            if (dirName.startsWith(".")) {
                // A crashed install or repair can leave its temporary tree
                // (`.tmp-*`) or the tree it moved aside (`.retired-*`). Remove
                // those whose folder modification time is over an hour old;
                // a younger one may belong to a repair still running here or
                // on another worker sharing this cache. This is an age rule,
                // not a lease. A retired folder keeps the old tree's time and
                // may go at once, which is harmless: its repair deletes it.
                if (/^\.(tmp|retired)-/.test(dirName)) {
                    const leftover = path.join(opts.cacheDir, dirName);
                    try {
                        if (Date.now() - fs.lstatSync(leftover).mtimeMs > INSTALL_LEFTOVER_MAX_AGE_MS) {
                            fs.rmSync(leftover, { recursive: true, force: true });
                        }
                    } catch { /* gone already, or another worker removed it */ }
                }
                continue;
            }
            if (!liveNames.has(cacheDirPackageName(dirName))) {
                fs.rmSync(path.join(opts.cacheDir, dirName), { recursive: true, force: true });
            }
        }
    } catch { /* best-effort GC */ }

    return {
        epoch,
        packages,
        pluginDirs: packages.filter((p) => p.status === "ok").map((p) => p.dir),
    };
}

/**
 * Import a package worker-module and return its tools.
 *
 * The import URL is cache-busted by the package sha, so a refreshed package
 * version gets a genuinely fresh module while an unchanged one reuses the
 * ESM cache. Module contract (same as the CLI --worker module):
 *   export default { createTools({ workerNodeId }) => Tool[] }  // or
 *   export default { tools: Tool[] }                            // or
 *   export const tools = [...]
 */
export async function loadAgentPackageTools(
    pkg: InstalledAgentPackage,
    context: { workerNodeId?: string },
): Promise<any[]> {
    if (!pkg.workerModulePath) return [];
    const url = `${pathToFileURL(pkg.workerModulePath).href}?v=${pkg.sha256.slice(0, 12)}`;
    const mod: any = await import(url);
    const surface = mod?.default ?? mod;
    let tools: any[] = [];
    if (typeof surface?.createTools === "function") {
        tools = await surface.createTools({ workerNodeId: context.workerNodeId });
    } else if (Array.isArray(surface?.tools)) {
        tools = surface.tools;
    } else if (Array.isArray(mod?.tools)) {
        tools = mod.tools;
    }
    if (!Array.isArray(tools)) return [];
    return tools.filter((t) => t && typeof (t as any).name === "string");
}
