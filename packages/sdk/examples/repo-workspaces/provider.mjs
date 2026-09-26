/**
 * Reference workspace provider (docs/proposals/session-workspaces.md, 5.3).
 *
 * ensureAttached(req), on the worker that runs the turn:
 *   1. the root is not mounted here -> attach(root)          (a deployment's attacher; optional)
 *   2. child process: stat <root>/.pilotswarm-export         (an empty mount point is not a mount)
 *   3. the folder is a session clone -> POST <service>/v1/leases
 *   4. { ok: true, path, adopt }                             (adopt comes from the service's repo config)
 * release(req): DELETE the caller's lease entry. Best effort.
 *
 * File calls on the mount run in child processes with a deadline: a call
 * into a hung NFS mount blocks for as long as the server is gone.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { MARKER_FILE, parseCheckout } from "./repo-service.mjs";

const STAT_SCRIPT = `
const fs = require("fs");
try { fs.statSync(process.argv[1]); process.stdout.write("ok"); }
catch (e) { process.stdout.write(e.code || "ERROR"); }
`;

/** stat in a child process. Resolves "ok", an errno code, or "TIMEOUT". */
export function statOutOfProcess(file, timeoutMs) {
    return new Promise((resolve) => {
        execFile(process.execPath, ["-e", STAT_SCRIPT, file], { timeout: timeoutMs, killSignal: "SIGKILL" }, (error, stdout) => {
            if (error && (error.killed || error.signal)) return resolve("TIMEOUT");
            resolve(String(stdout || "").trim() || "ERROR");
        });
    });
}

async function callService(fetchImpl, baseUrl, method, pathname, body, timeoutMs) {
    const response = await fetchImpl(new URL(pathname, baseUrl), {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw Object.assign(new Error(data?.error?.message || `${method} ${pathname}: HTTP ${response.status}`), { code: data?.error?.code, status: response.status });
    }
    return data;
}

/**
 * @param {object} options
 * @param {Array<{ name: string, path: string }>} options.roots
 * @param {Record<string, string>} options.serviceUrls  root name -> repo service URL
 * @param {(root: { name: string, path: string }) => (boolean|Promise<boolean>)} [options.isMounted]
 * @param {(root: { name: string, path: string }) => Promise<void>} [options.attach]
 * @param {number} [options.statTimeoutMs]
 * @param {number} [options.serviceTimeoutMs]
 */
export function createRepoWorkspaceProvider(options) {
    const roots = options.roots.map((root) => ({ name: root.name, path: root.path }));
    const statTimeoutMs = options.statTimeoutMs ?? 5_000;
    const serviceTimeoutMs = options.serviceTimeoutMs ?? 10_000;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const fail = (code, message) => ({ ok: false, code, message });

    return {
        async listRoots() {
            return roots.map((root) => ({ ...root }));
        },

        async ensureAttached(req) {
            const root = roots.find((candidate) => candidate.name === req.workspace.root);
            if (!root) return fail("WORKSPACE_ROOT_UNKNOWN", `root "${req.workspace.root}" is not served by this provider`);
            if (options.attach && !(await options.isMounted?.(root))) {
                try { await options.attach(root); } catch (error) {
                    return { ...fail("WORKSPACE_ATTACH_FAILED", `attach of root "${root.name}" failed: ${error?.message ?? error}`), retryAfterMs: 30_000 };
                }
            }
            const marker = await statOutOfProcess(path.join(root.path, MARKER_FILE), statTimeoutMs);
            if (marker === "TIMEOUT") return { ...fail("WORKSPACE_ATTACH_TIMEOUT", `root "${root.name}" did not answer within ${statTimeoutMs} ms`), retryAfterMs: 30_000 };
            if (marker === "ESTALE") return { ...fail("WORKSPACE_STALE_MOUNT", `root "${root.name}" has a stale file handle; it needs a remount`), retryAfterMs: 30_000 };
            if (marker !== "ok") return { ...fail("WORKSPACE_NOT_MOUNTED", `root "${root.name}" has no ${MARKER_FILE} marker (${marker})`), retryAfterMs: 30_000 };

            const folder = req.workspace.folder ?? "";
            const attachPath = folder ? path.join(root.path, folder) : root.path;
            if (!parseCheckout(folder)) return { ok: true, path: attachPath };

            const serviceUrl = options.serviceUrls[root.name];
            let lease;
            try {
                lease = await callService(fetchImpl, serviceUrl, "POST", "/v1/leases", {
                    checkout: folder,
                    sessionId: req.sessionId,
                    rootSessionId: req.rootSessionId,
                    workerNodeId: req.workerNodeId,
                    turnIndex: req.turnIndex,
                }, serviceTimeoutMs);
            } catch (error) {
                return { ...fail("WORKSPACE_ATTACH_FAILED", `repo service: ${error?.message ?? error}`), retryAfterMs: 30_000 };
            }
            if (!lease.ok) return fail(lease.code || "WORKSPACE_ATTACH_FAILED", lease.message || "the repo service refused the lease");
            return { ok: true, path: attachPath, ...(lease.adopt ? { adopt: lease.adopt } : {}) };
        },

        async release(req) {
            const folder = req.workspace?.folder ?? "";
            if (!parseCheckout(folder)) return;
            const serviceUrl = options.serviceUrls[req.workspace.root];
            if (!serviceUrl) return;
            await callService(fetchImpl, serviceUrl, "DELETE", "/v1/leases", { checkout: folder, sessionId: req.sessionId }, serviceTimeoutMs)
                .catch(() => { /* best effort: the entry ages out */ });
        },
    };
}
