/**
 * Session workspaces on a repo pod: the worker side of the reference
 * deployment (docs/proposals/session-workspaces.md, sections 5 and 12.1).
 * Load it with the worker's extension-module hook:
 *
 *   PILOTSWARM_EXTENSION_MODULES=/app/packages/sdk/examples/repo-workspaces/index.mjs
 *   PS_WORKSPACE_ROOTS=a=/ws/a                 repo roots: name = path on this pod (comma list)
 *   REPO_SERVICE_URL=http://repo-cache:8080    the repo service (per root: REPO_SERVICE_URL_<NAME>)
 *   PS_PLAIN_ROOTS=shared=/ws/shared           optional plain roots (comma list): folders with no
 *                                              repo service, such as a shared folder or a log
 *                                              share. Each needs the .pilotswarm-export marker.
 *                                              Sessions use them as extra folders (section 4.10).
 *   ATTACHER_SOCKET=/run/pilotswarm-attacher/sock   optional: the node attacher (attacher.mjs);
 *                                              a root that is not mounted in this pod is
 *                                              mounted through it on first use
 *
 * register(worker) sets the workspace provider and adds the clone tools.
 * The repo service itself runs on the repo pod: repo-service.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { combineWorkspaceProviders } from "pilotswarm-sdk";
import { callAttacher, isMountedAt } from "./attacher.mjs";
import { createPlainRootProvider, createRepoWorkspaceProvider } from "./provider.mjs";
import { createRepoTools } from "./tools.mjs";

/** "a=/ws/a,b=/ws/b" -> [{ name: "a", path: "/ws/a" }, ...] */
export function parseRoots(value) {
    return String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
        const eq = entry.indexOf("=");
        if (eq <= 0) throw new Error(`PS_WORKSPACE_ROOTS entry "${entry}" must be name=path`);
        return { name: entry.slice(0, eq).trim(), path: entry.slice(eq + 1).trim() };
    });
}

/**
 * The attach options for the node attacher at `socketPath`: a root that is
 * not a mount point in this pod is mounted through it; a stale one is
 * remounted.
 */
export function attacherOptions(socketPath) {
    return {
        isMounted: (root) => isMountedAt(root.path, fs.readFileSync("/proc/self/mountinfo", "utf8")),
        attach: async (root) => { await callAttacher(socketPath, "POST", "/mount", { root: root.name }); },
        remount: async (root) => { await callAttacher(socketPath, "POST", "/remount", { root: root.name }); },
    };
}

/**
 * The worker's one provider: the repo roots, plus the plain roots when there
 * are any. A root name listed twice stops the worker at start.
 */
export function createWorkspaceProvider({ roots, serviceUrls, plainRoots = [], attach, isMounted, remount }) {
    const mountOptions = { ...(attach ? { attach } : {}), ...(isMounted ? { isMounted } : {}), ...(remount ? { remount } : {}) };
    const repoProvider = createRepoWorkspaceProvider({ roots, serviceUrls, ...mountOptions });
    if (plainRoots.length === 0) return repoProvider;
    const names = new Set(roots.map((root) => root.name));
    // A plain root has no leases. One that is, holds or sits inside a repo
    // root would reach session clones around the lease rules
    // (WORKSPACE_IN_USE), so it stops the worker at start.
    const inside = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : `${b}${path.sep}`);
    for (const root of plainRoots) {
        if (names.has(root.name)) throw new Error(`PS_PLAIN_ROOTS: root "${root.name}" is also a repo root`);
        names.add(root.name);
        const plain = path.resolve(root.path);
        for (const repo of roots) {
            const repoPath = path.resolve(repo.path);
            if (inside(plain, repoPath) || inside(repoPath, plain)) {
                throw new Error(`PS_PLAIN_ROOTS: root "${root.name}" (${root.path}) overlaps repo root "${repo.name}" (${repo.path})`);
            }
        }
    }
    return combineWorkspaceProviders([repoProvider, createPlainRootProvider({ roots: plainRoots, ...mountOptions })]);
}

export async function register(worker, context = {}) {
    const env = context.env ?? process.env;
    const roots = parseRoots(env.PS_WORKSPACE_ROOTS || "a=/ws/a");
    const plainRoots = parseRoots(env.PS_PLAIN_ROOTS || "");
    if (!env.REPO_SERVICE_URL) throw new Error("REPO_SERVICE_URL is required");
    const serviceUrls = Object.fromEntries(roots.map((root) => [
        root.name,
        env[`REPO_SERVICE_URL_${root.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] || env.REPO_SERVICE_URL,
    ]));
    worker.setWorkspaceProvider(createWorkspaceProvider({
        roots, serviceUrls, plainRoots,
        ...(env.ATTACHER_SOCKET ? attacherOptions(env.ATTACHER_SOCKET) : {}),
    }));
    worker.registerTools(createRepoTools({ serviceUrl: env.REPO_SERVICE_URL, getCatalog: () => worker.catalog }));
    context.log?.(`repo workspaces: roots ${roots.map((root) => `${root.name}=${root.path}`).join(", ")}`
        + (plainRoots.length > 0 ? `; plain roots ${plainRoots.map((root) => `${root.name}=${root.path}`).join(", ")}` : ""));
}
