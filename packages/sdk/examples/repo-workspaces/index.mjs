/**
 * Session workspaces on a repo pod: the worker side of the reference
 * deployment (docs/proposals/session-workspaces.md, sections 5 and 12.1).
 * Load it with the worker's extension-module hook:
 *
 *   PILOTSWARM_EXTENSION_MODULES=/app/examples/repo-workspaces/index.mjs
 *   PS_WORKSPACE_ROOTS=a=/ws/a                 repo roots: name = path on this pod (comma list)
 *   REPO_SERVICE_URL=http://repo-cache:8080    the repo service (per root: REPO_SERVICE_URL_<NAME>)
 *   PS_PLAIN_ROOTS=shared=/ws/shared           optional plain roots (comma list): folders with no
 *                                              repo service, such as a shared folder or a log
 *                                              share, served by PilotSwarm's built-in provider.
 *                                              Sessions use them as extra folders (section 4.10).
 *
 * register(worker) sets the workspace provider and adds the clone tools.
 * The repo service itself runs on the repo pod: repo-service.mjs.
 */
import { combineWorkspaceProviders, createBuiltInWorkspaceProvider } from "pilotswarm-sdk";
import { createRepoWorkspaceProvider } from "./provider.mjs";
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
 * The worker's one provider: the repo roots, plus the plain roots when there
 * are any. A root name listed twice stops the worker at start.
 */
export function createWorkspaceProvider({ roots, serviceUrls, plainRoots = [] }) {
    const repoProvider = createRepoWorkspaceProvider({ roots, serviceUrls });
    if (plainRoots.length === 0) return repoProvider;
    const names = new Set(roots.map((root) => root.name));
    for (const root of plainRoots) {
        if (names.has(root.name)) throw new Error(`PS_PLAIN_ROOTS: root "${root.name}" is also a repo root`);
        names.add(root.name);
    }
    return combineWorkspaceProviders([repoProvider, createBuiltInWorkspaceProvider(plainRoots)]);
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
    worker.setWorkspaceProvider(createWorkspaceProvider({ roots, serviceUrls, plainRoots }));
    worker.registerTools(createRepoTools({ serviceUrl: env.REPO_SERVICE_URL, getCatalog: () => worker.catalog }));
    context.log?.(`repo workspaces: roots ${roots.map((root) => `${root.name}=${root.path}`).join(", ")}`
        + (plainRoots.length > 0 ? `; plain roots ${plainRoots.map((root) => `${root.name}=${root.path}`).join(", ")}` : ""));
}
