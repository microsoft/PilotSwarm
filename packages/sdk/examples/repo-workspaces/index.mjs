/**
 * Session workspaces on a repo pod: the worker side of the reference
 * deployment (docs/proposals/session-workspaces.md, sections 5 and 12.1).
 * Load it with the worker's extension-module hook:
 *
 *   PILOTSWARM_EXTENSION_MODULES=/app/examples/repo-workspaces/index.mjs
 *   PS_WORKSPACE_ROOTS=a=/ws/a                 root name = path on this pod (comma list)
 *   REPO_SERVICE_URL=http://repo-cache:8080    the repo service (per root: REPO_SERVICE_URL_<NAME>)
 *
 * register(worker) sets the workspace provider and adds the clone tools.
 * The repo service itself runs on the repo pod: repo-service.mjs.
 */
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

export async function register(worker, context = {}) {
    const env = context.env ?? process.env;
    const roots = parseRoots(env.PS_WORKSPACE_ROOTS || "a=/ws/a");
    if (!env.REPO_SERVICE_URL) throw new Error("REPO_SERVICE_URL is required");
    const serviceUrls = Object.fromEntries(roots.map((root) => [
        root.name,
        env[`REPO_SERVICE_URL_${root.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] || env.REPO_SERVICE_URL,
    ]));
    worker.setWorkspaceProvider(createRepoWorkspaceProvider({ roots, serviceUrls }));
    worker.registerTools(createRepoTools({ serviceUrl: env.REPO_SERVICE_URL, getCatalog: () => worker.catalog }));
    context.log?.(`repo workspaces: roots ${roots.map((root) => `${root.name}=${root.path}`).join(", ")}`);
}
