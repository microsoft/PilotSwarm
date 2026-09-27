/**
 * Reference workspace provider (docs/proposals/session-workspaces.md, 5.3).
 *
 * ensureAttached(req), on the worker that runs the turn:
 *   1. the root is not mounted here -> attach(root)          (a deployment's attacher; optional)
 *   2. child process: stat <root>/.pilotswarm-export         (an empty mount point is not a mount)
 *      and resolve the folder's real path under the root     (symlinks cannot pick the checkout)
 *   3. the real path must be sessions/<tree>/<repo>[/...]; its first three
 *      segments name the checkout -> POST <service>/v1/leases
 *   4. { ok: true, path, adopt }                             (adopt comes from the service's repo config)
 * release(req): DELETE the caller's lease entry for the checkout it attached,
 *   if this worker still holds it. Best effort.
 *
 * The provider serves session clones only: every attach, a subfolder of a
 * clone included, takes a lease on the clone that contains it.
 *
 * File calls on the mount run in child processes with a deadline: a call
 * into a hung NFS mount blocks for as long as the server is gone.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { MARKER_FILE, parseCheckout } from "./repo-service.mjs";

// Marker check, then the folder's real path relative to the root's real path.
const PROBE_SCRIPT = `
const fs = require("fs"), path = require("path");
const [root, folder, marker] = process.argv.slice(1);
const out = (value) => process.stdout.write(JSON.stringify(value));
try { fs.statSync(path.join(root, marker)); } catch (e) { out({ marker: e.code || "ERROR" }); process.exit(0); }
try {
  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(path.join(root, folder)));
  out({ marker: "ok", rel: rel.split(path.sep).join("/") });
} catch (e) { out({ marker: "ok", folderError: e.code || "ERROR" }); }
`;

/** The marker check and real-path probe in a child process, with a deadline. */
export function probeOutOfProcess(rootPath, folder, timeoutMs) {
    return new Promise((resolve) => {
        execFile(process.execPath, ["-e", PROBE_SCRIPT, rootPath, folder, MARKER_FILE], { timeout: timeoutMs, killSignal: "SIGKILL" }, (error, stdout) => {
            if (error && (error.killed || error.signal)) return resolve({ marker: "TIMEOUT" });
            try { resolve(JSON.parse(String(stdout || ""))); } catch { resolve({ marker: "ERROR" }); }
        });
    });
}

/** The checkout (sessions/<tree>/<repo>) that contains a real path under the root, or null. */
export function checkoutOf(relativeRealPath) {
    const parts = String(relativeRealPath || "").split("/");
    if (parts.length < 3 || parts[0] !== "sessions") return null;
    return parseCheckout(parts.slice(0, 3).join("/")) ? parts.slice(0, 3).join("/") : null;
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
    // What each session leased here, per workspace record, so a release names the same checkout.
    const leased = new Map();
    const leaseKey = (sessionId, workspace) => `${sessionId}\0${workspace?.root ?? ""}\0${workspace?.folder ?? ""}`;

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
            const folder = req.workspace.folder ?? "";
            const probe = await probeOutOfProcess(root.path, folder, statTimeoutMs);
            const marker = probe.marker;
            if (marker === "TIMEOUT") return { ...fail("WORKSPACE_ATTACH_TIMEOUT", `root "${root.name}" did not answer within ${statTimeoutMs} ms`), retryAfterMs: 30_000 };
            if (marker === "ESTALE") return { ...fail("WORKSPACE_STALE_MOUNT", `root "${root.name}" has a stale file handle; it needs a remount`), retryAfterMs: 30_000 };
            if (marker !== "ok") return { ...fail("WORKSPACE_NOT_MOUNTED", `root "${root.name}" has no ${MARKER_FILE} marker (${marker})`), retryAfterMs: 30_000 };
            if (probe.folderError) return fail("WORKSPACE_FOLDER_MISSING", `folder "${folder}" is not available (${probe.folderError})`);

            const attachPath = folder ? path.join(root.path, folder) : root.path;
            const checkout = checkoutOf(probe.rel);
            if (!checkout) {
                return fail("WORKSPACE_PATH_INVALID", `folder "${folder}" is not inside a session clone (sessions/<tree>/<repo>)`);
            }

            const serviceUrl = options.serviceUrls[root.name];
            let lease;
            try {
                lease = await callService(fetchImpl, serviceUrl, "POST", "/v1/leases", {
                    checkout,
                    sessionId: req.sessionId,
                    rootSessionId: req.rootSessionId,
                    workerNodeId: req.workerNodeId,
                    turnIndex: req.turnIndex,
                }, serviceTimeoutMs);
            } catch (error) {
                return { ...fail("WORKSPACE_ATTACH_FAILED", `repo service: ${error?.message ?? error}`), retryAfterMs: 30_000 };
            }
            if (!lease.ok) return fail(lease.code || "WORKSPACE_ATTACH_FAILED", lease.message || "the repo service refused the lease");
            leased.set(leaseKey(req.sessionId, req.workspace), { root: root.name, checkout });
            return { ok: true, path: attachPath, ...(lease.adopt ? { adopt: lease.adopt } : {}) };
        },

        async release(req) {
            // The checkout this worker leased; after a restart, resolve it again.
            const key = leaseKey(req.sessionId, req.workspace);
            let target = leased.get(key);
            if (!target && req.workspace) {
                const root = roots.find((candidate) => candidate.name === req.workspace.root);
                const probe = root ? await probeOutOfProcess(root.path, req.workspace.folder ?? "", statTimeoutMs) : null;
                const checkout = probe && !probe.folderError ? checkoutOf(probe.rel) : null;
                if (checkout) target = { root: root.name, checkout };
            }
            if (!target) return;
            leased.delete(key);
            const serviceUrl = options.serviceUrls[target.root];
            if (!serviceUrl) return;
            // The service deletes the entry only if this worker still holds
            // it: a release that arrives after the session moved on must not
            // delete the new worker's entry.
            await callService(fetchImpl, serviceUrl, "DELETE", "/v1/leases", {
                checkout: target.checkout,
                sessionId: req.sessionId,
                workerNodeId: req.workerNodeId,
                turnIndex: req.turnIndex,
            }, serviceTimeoutMs)
                .catch(() => { /* best effort: the entry ages out */ });
        },
    };
}
