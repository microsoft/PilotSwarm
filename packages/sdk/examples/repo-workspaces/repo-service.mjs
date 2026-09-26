/**
 * Reference repo service for session workspaces
 * (docs/proposals/session-workspaces.md, sections 5.1 to 5.4).
 *
 * It runs on the repo pod, next to the NFS server, and is the only thing
 * that runs git on a mirror. It owns one root:
 *
 *   <root>/.pilotswarm-export            the marker the provider checks
 *   <root>/repos/<repo>.git              mirrors; sessions only read them
 *   <root>/sessions/<rootSessionId>/<repo>   session clones (clone --shared)
 *
 * Leases live here, in the service's own state file, never on the export.
 *
 *   POST   /v1/clones        { rootSessionId, repo }     make a session clone
 *   GET    /v1/clones?rootSessionId=                     list clones
 *   DELETE /v1/clones        { rootSessionId, repo }     remove one (refused while a lease entry is live)
 *   POST   /v1/leases        { checkout, sessionId, rootSessionId, workerNodeId, turnIndex }
 *   DELETE /v1/leases        { checkout, sessionId }
 *   POST   /v1/mirrors/fetch { repo }                    fetch the mirror from its remote
 *   POST   /v1/maintenance   { repo, args }              allowed mirror maintenance only
 *   POST   /v1/token         { protocol, host, path }    a token for a clone's own remote only
 *
 * Run on the pod: node repo-service.mjs (configuration from the environment,
 * see main() at the end). Tests import createRepoService().
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER_FILE = ".pilotswarm-export";
/** The hold window plus the eviction margin (section 5.3): an entry older than this is dead. */
export const DEFAULT_ENTRY_TTL_MS = 40 * 60 * 1000;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class ServiceError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/** The checkout folder of a session clone, relative to the root. */
export function checkoutFolder(rootSessionId, repo) {
    return `sessions/${rootSessionId}/${repo}`;
}

/** Parses `sessions/<rootSessionId>/<repo>`; null for anything else. */
export function parseCheckout(folder) {
    const parts = String(folder || "").split("/");
    if (parts.length !== 3 || parts[0] !== "sessions" || !SEGMENT.test(parts[1]) || !SEGMENT.test(parts[2])) return null;
    return { rootSessionId: parts[1], repo: parts[2] };
}

/** Expands `-adk` into `-a -d -k`; long flags pass through. */
function expandFlags(args) {
    const out = [];
    for (const arg of args) {
        if (/^-[A-Za-z]{2,}$/.test(arg)) for (const letter of arg.slice(1)) out.push(`-${letter}`);
        else out.push(arg);
    }
    return out;
}

/**
 * Mirror maintenance allowlist (section 5.1). Everything that can drop an
 * unreachable object a session clone may still borrow is refused.
 *
 *   allowed:   git gc, git maintenance run, git repack -A -d,
 *              git repack --cruft -d, git repack -a -d -k, git repack -d
 *   forbidden: git prune, git gc --prune=<time>, git repack -a -d without -A or -k
 */
export function checkMaintenanceCommand(args) {
    if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== "string")) {
        return { ok: false, reason: "args must be a non-empty list of strings" };
    }
    const [command, ...rest] = args;
    const flags = expandFlags(rest);
    if (command === "gc") {
        if (flags.some((flag) => flag.startsWith("--prune") && flag !== "--prune=never")) {
            return { ok: false, reason: "git gc --prune=<time> drops unreachable objects that session clones may borrow" };
        }
        return { ok: true };
    }
    if (command === "maintenance") {
        return flags[0] === "run" ? { ok: true } : { ok: false, reason: "only git maintenance run is allowed" };
    }
    if (command === "repack") {
        const has = (flag) => flags.includes(flag);
        if (has("-a") && has("-d") && !has("-A") && !has("-k") && !has("--cruft")) {
            return { ok: false, reason: "git repack -a -d without -A or -k drops unreachable objects that session clones may borrow" };
        }
        return { ok: true };
    }
    if (command === "prune") return { ok: false, reason: "git prune drops unreachable objects that session clones may borrow" };
    return { ok: false, reason: `git ${command} is not an allowed mirror maintenance command` };
}

function defaultRunGit(args, { cwd, env, uid } = {}) {
    // A deployment runs clone creation as the session uid (1000) with setpriv.
    const [file, argv] = uid === undefined
        ? ["git", args]
        : ["setpriv", [`--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "git", ...args]];
    return new Promise((resolve, reject) => {
        execFile(file, argv, { cwd, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) reject(Object.assign(new Error(`git ${args.join(" ")} failed: ${String(stderr || error.message).trim()}`), { stderr: String(stderr) }));
            else resolve(String(stdout).trim());
        });
    });
}

/** Removes stale git lock files in a clone's .git, never under objects/. Returns the removed paths. */
export function removeStaleGitLocks(clonePath) {
    const removed = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== "objects") walk(full);
            } else if (entry.name.endsWith(".lock")) {
                try { fs.unlinkSync(full); removed.push(path.relative(clonePath, full)); } catch { /* already gone */ }
            }
        }
    };
    walk(path.join(clonePath, ".git"));
    return removed;
}

/**
 * @param {object} options
 * @param {string} options.root            the export root on this pod
 * @param {string} [options.rootName]      the root's name in workspace records (default "a")
 * @param {Record<string, { remote: string, adopt?: { agents?: boolean, skills?: boolean, instructions?: boolean } }>} options.repos
 * @param {(workerNodeId: string) => (boolean|Promise<boolean>)} [options.isWorkerAlive]
 *        the worker registry; without it, only an entry's age decides
 * @param {number} [options.entryTtlMs]    hold window plus eviction margin
 * @param {(req: { repo: string, url: string }) => (string|null|Promise<string|null>)} [options.mintToken]
 *        a short-lived token for the repo's remote, minted with the deployment identity
 * @param {string} [options.credentialHelper]  the helper each clone sets after clearing others
 * @param {number} [options.cloneUid]      the session uid clone creation runs as (a deployment sets 1000)
 * @param {string} [options.stateFile]     service-private state; never on the export
 * @param {() => number} [options.now]
 * @param {Function} [options.runGit]
 */
export function createRepoService(options) {
    const root = path.resolve(options.root);
    const rootName = options.rootName ?? "a";
    const repos = options.repos ?? {};
    const entryTtlMs = options.entryTtlMs ?? DEFAULT_ENTRY_TTL_MS;
    const now = options.now ?? (() => Date.now());
    const runGit = options.runGit ?? defaultRunGit;
    const isWorkerAlive = options.isWorkerAlive ?? (() => true);
    const stateFile = options.stateFile ?? null;
    // clones: checkout -> { rootSessionId, repo, createdAt }
    // leases: checkout -> Map(sessionId -> { sessionId, rootSessionId, workerNodeId, turnIndex, time })
    const clones = new Map();
    const leases = new Map();

    if (stateFile && fs.existsSync(stateFile)) {
        const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        for (const [checkout, record] of Object.entries(saved.clones ?? {})) clones.set(checkout, record);
        for (const [checkout, entries] of Object.entries(saved.leases ?? {})) {
            leases.set(checkout, new Map(entries.map((entry) => [entry.sessionId, entry])));
        }
    }
    const persist = () => {
        if (!stateFile) return;
        const data = {
            clones: Object.fromEntries(clones),
            leases: Object.fromEntries([...leases].map(([checkout, entries]) => [checkout, [...entries.values()]])),
        };
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(data));
        fs.renameSync(`${stateFile}.tmp`, stateFile);
    };

    const repoConfig = (repo) => {
        if (!SEGMENT.test(String(repo || "")) || !Object.hasOwn(repos, repo)) {
            throw new ServiceError(404, "REPO_UNKNOWN", `repo "${repo}" is not served here`);
        }
        return repos[repo];
    };
    const mirrorPath = (repo) => path.join(root, "repos", `${repo}.git`);

    async function isLive(entry) {
        if (now() - entry.time > entryTtlMs) return false;
        try { return Boolean(await isWorkerAlive(entry.workerNodeId)); } catch { return true; }
    }

    async function liveEntries(checkout) {
        const entries = leases.get(checkout);
        if (!entries) return [];
        const live = [];
        for (const entry of entries.values()) if (await isLive(entry)) live.push(entry);
        return live;
    }

    async function ensureMirror(repo) {
        const config = repoConfig(repo);
        const mirror = mirrorPath(repo);
        if (fs.existsSync(mirror)) return mirror;
        fs.mkdirSync(path.dirname(mirror), { recursive: true });
        await runGit(["init", "-q", "--bare", mirror]);
        for (const [key, value] of [
            ["remote.origin.url", config.remote],
            ["remote.origin.fetch", "+refs/heads/*:refs/heads/*"],
            ["gc.auto", "0"],
            ["maintenance.auto", "false"],
            ["gc.pruneExpire", "never"],
        ]) await runGit(["-C", mirror, "config", key, value]);
        await runGit(["-C", mirror, "config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"]);
        await runGit(["-C", mirror, "fetch", "-q", "--prune", "origin"]);
        return mirror;
    }

    const handlers = {
        async "POST /v1/clones"({ rootSessionId, repo }) {
            if (!SEGMENT.test(String(rootSessionId || ""))) throw new ServiceError(400, "BAD_REQUEST", "rootSessionId is required");
            const config = repoConfig(repo);
            const checkout = checkoutFolder(rootSessionId, repo);
            const target = path.join(root, checkout);
            const existing = clones.get(checkout);
            if (existing) return { workspace: { root: rootName, folder: checkout }, path: target, created: false };
            if (fs.existsSync(target)) throw new ServiceError(409, "CHECKOUT_EXISTS", `${checkout} exists but is not a clone this service made`);
            const mirror = await ensureMirror(repo);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            await runGit(["clone", "-q", "--shared", mirror, target], { uid: options.cloneUid });
            // Relative alternates keep the clone valid at the same path on every pod.
            const objectsDir = path.join(target, ".git", "objects");
            fs.writeFileSync(path.join(objectsDir, "info", "alternates"), `${path.relative(objectsDir, path.join(mirror, "objects"))}\n`);
            await runGit(["-C", target, "remote", "set-url", "origin", config.remote], { uid: options.cloneUid });
            if (options.credentialHelper) {
                // An empty helper first clears every inherited one, URL-scoped
                // ones from a shared HOME included; then only this clone's helper.
                await runGit(["-C", target, "config", "credential.helper", ""], { uid: options.cloneUid });
                await runGit(["-C", target, "config", "--add", "credential.helper", options.credentialHelper], { uid: options.cloneUid });
                await runGit(["-C", target, "config", "credential.useHttpPath", "true"], { uid: options.cloneUid });
            }
            clones.set(checkout, { rootSessionId, repo, createdAt: now() });
            persist();
            return { workspace: { root: rootName, folder: checkout }, path: target, created: true };
        },

        async "GET /v1/clones"(_body, query) {
            const tree = query.get("rootSessionId");
            return {
                clones: [...clones].filter(([, record]) => !tree || record.rootSessionId === tree)
                    .map(([checkout, record]) => ({ ...record, workspace: { root: rootName, folder: checkout } })),
            };
        },

        async "DELETE /v1/clones"({ rootSessionId, repo }) {
            const checkout = checkoutFolder(rootSessionId, repo);
            if (!clones.has(checkout)) throw new ServiceError(404, "CLONE_UNKNOWN", `no clone ${checkout}`);
            const live = await liveEntries(checkout);
            if (live.length > 0) {
                throw new ServiceError(409, "CHECKOUT_IN_USE", `${checkout} has ${live.length} live lease entr${live.length === 1 ? "y" : "ies"}`);
            }
            fs.rmSync(path.join(root, checkout), { recursive: true, force: true });
            clones.delete(checkout);
            leases.delete(checkout);
            persist();
            return { deleted: true };
        },

        async "POST /v1/leases"({ checkout, sessionId, rootSessionId, workerNodeId, turnIndex }) {
            const record = clones.get(checkout);
            if (!record) return { ok: false, code: "WORKSPACE_FOLDER_MISSING", message: `${checkout} is not a session clone` };
            // A clone belongs to one session tree until cleanup deletes it,
            // whether or not the tree holds a live entry (section 5.3).
            if (record.rootSessionId !== rootSessionId) {
                return { ok: false, code: "WORKSPACE_IN_USE", message: `${checkout} belongs to session tree ${record.rootSessionId}` };
            }
            const entries = leases.get(checkout) ?? new Map();
            const states = [];
            for (const entry of entries.values()) states.push({ entry, live: await isLive(entry) });
            const dead = states.filter((s) => !s.live).map((s) => s.entry);
            const anyLive = states.some((s) => s.live);
            let removedLocks = [];
            // Lock files are removed only when no live entry remains: a live
            // entry may belong to a git command still running (K15, test R5).
            if (dead.length > 0 && !anyLive) removedLocks = removeStaleGitLocks(path.join(root, checkout));
            for (const entry of dead) entries.delete(entry.sessionId);
            entries.set(sessionId, { sessionId, rootSessionId, workerNodeId, turnIndex, time: now() });
            leases.set(checkout, entries);
            persist();
            return { ok: true, adopt: repos[record.repo]?.adopt ?? null, ...(removedLocks.length ? { removedLocks } : {}) };
        },

        async "DELETE /v1/leases"({ checkout, sessionId }) {
            const entries = leases.get(checkout);
            const deleted = Boolean(entries?.delete(sessionId));
            if (entries && entries.size === 0) leases.delete(checkout);
            persist();
            return { deleted };
        },

        async "POST /v1/mirrors/fetch"({ repo }) {
            repoConfig(repo);
            const mirror = await ensureMirror(repo);
            await runGit(["-C", mirror, "fetch", "-q", "--prune", "origin"]);
            return { fetched: true };
        },

        async "POST /v1/maintenance"({ repo, args }) {
            repoConfig(repo);
            const checked = checkMaintenanceCommand(args);
            if (!checked.ok) throw new ServiceError(403, "MAINTENANCE_REFUSED", checked.reason);
            await runGit(["-C", mirrorPath(repo), ...args]);
            return { ran: args };
        },

        async "POST /v1/token"({ protocol, host, path: repoPath }) {
            // Only a configured remote gets a token, so a push to any other
            // host cannot carry one out (section 5.4).
            const asked = `${protocol}://${host}/${String(repoPath || "").replace(/^\/+/, "")}`.replace(/\.git$/, "");
            const match = Object.entries(repos).find(([, config]) => {
                try {
                    const url = new URL(config.remote);
                    return `${url.protocol.replace(/:$/, "")}://${url.host}/${url.pathname.replace(/^\/+/, "")}`.replace(/\.git$/, "") === asked;
                } catch { return false; }
            });
            if (!match || !options.mintToken) return {};
            const token = await options.mintToken({ repo: match[0], url: match[1].remote });
            return token ? { username: "x-token", password: token } : {};
        },
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://repo-service");
        const handler = handlers[`${req.method} ${url.pathname}`];
        const reply = (status, body) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
        };
        if (!handler) return reply(404, { error: { code: "NOT_FOUND", message: `${req.method} ${url.pathname}` } });
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const text = Buffer.concat(chunks).toString();
            reply(200, await handler(text ? JSON.parse(text) : {}, url.searchParams));
        } catch (error) {
            if (error instanceof ServiceError) return reply(error.status, { error: { code: error.code, message: error.message } });
            reply(500, { error: { code: "INTERNAL", message: String(error?.message ?? error) } });
        }
    });

    return {
        server,
        /** Test and admin view of the service state. */
        state: () => ({
            clones: Object.fromEntries(clones),
            leases: Object.fromEntries([...leases].map(([checkout, entries]) => [checkout, [...entries.values()]])),
        }),
        async listen(port = 0, host = "127.0.0.1") {
            await new Promise((resolve) => server.listen(port, host, resolve));
            const address = server.address();
            return `http://${address.address}:${address.port}`;
        },
        async close() {
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

/**
 * Pod entry point. Environment:
 *   REPO_SERVICE_ROOT        the export root (default /ws/a)
 *   REPO_SERVICE_ROOT_NAME   its name in workspace records (default a)
 *   REPO_SERVICE_REPOS       JSON: { "<repo>": { "remote": "<url>", "adopt": { ... } } }
 *   REPO_SERVICE_STATE_FILE  service-private state (default /var/lib/repo-service/state.json)
 *   REPO_SERVICE_PORT        default 8080
 *   REPO_SERVICE_CLONE_UID   the session uid for clone creation (default 1000)
 *   REPO_SERVICE_CREDENTIAL_HELPER  the helper command clones set
 * Token minting and the worker registry are deployment-specific; wire them
 * in a wrapper that calls createRepoService() with mintToken and isWorkerAlive.
 */
async function main() {
    const env = process.env;
    const service = createRepoService({
        root: env.REPO_SERVICE_ROOT || "/ws/a",
        rootName: env.REPO_SERVICE_ROOT_NAME || "a",
        repos: JSON.parse(env.REPO_SERVICE_REPOS || "{}"),
        stateFile: env.REPO_SERVICE_STATE_FILE || "/var/lib/repo-service/state.json",
        cloneUid: env.REPO_SERVICE_CLONE_UID ? Number(env.REPO_SERVICE_CLONE_UID) : 1000,
        credentialHelper: env.REPO_SERVICE_CREDENTIAL_HELPER || undefined,
    });
    const url = await service.listen(Number(env.REPO_SERVICE_PORT || 8080), "0.0.0.0");
    console.log(`[repo-service] listening at ${url}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
