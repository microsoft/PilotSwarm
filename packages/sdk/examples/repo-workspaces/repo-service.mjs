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
 *   POST   /v1/clones        { rootSessionId, repo, sessionId? }   make a session clone
 *   GET    /v1/clones?rootSessionId=                     list clones, and the removed ones
 *   DELETE /v1/clones        { rootSessionId, repo }     remove one (refused while a lease entry is live)
 *   POST   /v1/clones/restore { rootSessionId, repo, sessionId }  make again a clone that
 *                                                        idle cleanup removed (the provider calls it)
 *   POST   /v1/leases        { checkout, sessionId, rootSessionId, workerNodeId, turnIndex }
 *   DELETE /v1/leases        { checkout, sessionId, workerNodeId, turnIndex }   only the holder's own entry
 *   POST   /v1/mirrors/fetch { repo }                    fetch the mirror from its remote        (admin token)
 *   POST   /v1/maintenance   { repo, operation }         a named maintenance operation           (admin token)
 *   POST   /v1/token         { protocol, host, path }    a token for a served repo's remote only
 *   GET/POST /git/<repo>.git/...                         a repo's sandbox remote (git smart HTTP,
 *                                                        token in HTTP Basic auth); only for repos
 *                                                        with `sandbox: true`
 *
 * Worker pods, and so agent shells, can reach this port (section 5.2). The
 * two admin endpoints therefore need the admin token, which workers never
 * get; without one configured they are off.
 *
 * Idle cleanup (section 5.3): a clone no session has used for `idleCloneMs`
 * (7 days by default) is removed. "Used" means a lease taken or released.
 * Each removal is logged and kept as a removal record: when, why, the last
 * branch and commit, and whether work was left unpushed. When a session of
 * the tree comes back, the provider asks for the clone again (restore); the
 * new clone is fresh, and every session that used the old one is told once.
 * Pushed branches live in the remote, so they outlast the clone.
 *
 * Run on the pod: node repo-service.mjs (configuration from the environment,
 * see main() at the end). Tests import createRepoService().
 */
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSandboxRemotes } from "./sandbox-remote.mjs";

export const MARKER_FILE = ".pilotswarm-export";
/** The hold window plus the eviction margin (section 5.3): an entry older than this is dead. */
export const DEFAULT_ENTRY_TTL_MS = 40 * 60 * 1000;
/** A clone no session has used for this long is removed (section 5.3). */
export const DEFAULT_IDLE_CLONE_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a removal record is kept. */
export const DEFAULT_REMOVAL_RECORD_MS = 365 * 24 * 60 * 60 * 1000;
/** How many session ids a clone remembers, to tell them after a restore. */
const MAX_CLONE_USERS = 100;
/** Each git call that inspects a clone before its removal. */
const INSPECT_TIMEOUT_MS = 20_000;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** How often the idle pass runs: a twelfth of the idle time, from 1 to 15 minutes. */
export function idleCheckIntervalMs(idleCloneMs) {
    return Math.min(15 * 60 * 1000, Math.max(60 * 1000, Math.floor(idleCloneMs / 12)));
}

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

/**
 * Mirror maintenance (section 5.1), by name only. Callers never pass git
 * arguments: git accepts abbreviated long options (`--prun=now`) and options
 * that undo others (`--no-keep-unreachable`), so no argument filter is safe.
 * Every operation pins gc.pruneExpire=never, so no unreachable object that a
 * session clone may borrow is dropped.
 */
export const MAINTENANCE_OPERATIONS = Object.freeze({
    gc: ["-c", "gc.pruneExpire=never", "gc"],
    "maintenance-run": ["-c", "gc.pruneExpire=never", "maintenance", "run"],
    "repack-keep-unreachable": ["-c", "gc.pruneExpire=never", "repack", "-a", "-d", "-k"],
    "repack-cruft": ["-c", "gc.pruneExpire=never", "repack", "--cruft", "--cruft-expiration=never", "-d"],
});

/**
 * Checks every segment of a path under the root (and the clone's .git when
 * asked): each must be a real directory, never a symlink. The service acts
 * as a more privileged uid than sessions, and a session can plant links.
 */
function segmentsAreReal(root, relative, { withGit = true } = {}) {
    let current = root;
    for (const segment of [...relative.split("/"), ...(withGit ? [".git"] : [])]) {
        current = path.join(current, segment);
        let stat;
        try { stat = fs.lstatSync(current); } catch { return false; }
        if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    }
    return true;
}

/**
 * Runs a command, as `uid` through setpriv when given (the deployment's
 * session uid, 1000). A service that already runs as that uid (a laptop run,
 * where setpriv may not exist) runs the command directly.
 */
function runAs(command, args, { cwd, env, uid, timeoutMs } = {}) {
    const [file, argv] = uid === undefined || uid === process.getuid?.()
        ? [command, args]
        : ["setpriv", [`--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", command, ...args]];
    return new Promise((resolve, reject) => {
        const limits = timeoutMs > 0 ? { timeout: timeoutMs, killSignal: "SIGKILL" } : {};
        execFile(file, argv, { cwd, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024, ...limits }, (error, stdout, stderr) => {
            if (error) reject(Object.assign(new Error(`${command} ${args.join(" ")} failed: ${String(stderr || error.message).trim()}`), { stderr: String(stderr) }));
            else resolve(String(stdout).trim());
        });
    });
}

/** Quotes one word for sh, which runs git's --upload-pack command. */
function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function defaultRunGit(args, opts = {}) {
    return runAs("git", args, opts);
}

const MAX_LOCK_WALK_ENTRIES = 20_000;

/**
 * Removes stale git lock files in a clone's .git, never under objects/.
 * Returns the removed paths. The caller checks the checkout with
 * segmentsAreReal first; the walk never follows a symlink (Dirent types are
 * the link's own) and stops after MAX_LOCK_WALK_ENTRIES entries.
 */
export function removeStaleGitLocks(clonePath) {
    const removed = [];
    let visited = 0;
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (++visited > MAX_LOCK_WALK_ENTRIES) return;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== "objects") walk(full);
            } else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".lock")) {
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
 * @param {Record<string, { remote?: string, upstream?: string, sandbox?: boolean, adopt?: { agents?: boolean, skills?: boolean, instructions?: boolean } }>} options.repos
 *        `remote` is the clones' origin. `upstream`, when given, is where the
 *        mirror fetches from instead. `sandbox: true` makes this service host
 *        the remote itself (sandbox-remote.mjs), at `${publicUrl}/git/<repo>.git`.
 * @param {string} [options.publicUrl]     this service's URL as workers reach it; needed for sandboxes
 * @param {(workerNodeId: string) => (boolean|Promise<boolean>)} [options.isWorkerAlive]
 *        the worker registry; without it, only an entry's age decides
 * @param {number} [options.entryTtlMs]    hold window plus eviction margin
 * @param {(req: { repo: string, url: string }) => (string|null|Promise<string|null>)} [options.mintToken]
 *        a short-lived token for the repo's remote, minted with the deployment identity
 * @param {string} [options.credentialHelper]  the helper each clone sets after clearing others
 * @param {number} [options.cloneUid]      the session uid clone creation runs as (a deployment sets 1000)
 * @param {string} [options.adminToken]    required for mirror fetch and maintenance; without it they are off
 * @param {string} [options.stateFile]     service-private state; never on the export
 * @param {number} [options.idleCloneMs]   remove a clone no session has used for this long
 *        (default 7 days; 0 = never)
 * @param {number} [options.removalRecordMs]  how long removal records are kept (default 1 year)
 * @param {(entry: object) => void} [options.log]  one call per clone event; by default one
 *        JSON line on stdout, which the cluster's log collector keeps
 * @param {() => number} [options.now]
 * @param {Function} [options.runGit]
 */
export function createRepoService(options) {
    const root = path.resolve(options.root);
    const rootName = options.rootName ?? "a";
    // A sandbox repo's remote is this service; fill it in from publicUrl.
    const repos = Object.fromEntries(Object.entries(options.repos ?? {}).map(([name, config]) => {
        if (!config?.sandbox) return [name, config];
        if (!options.publicUrl) throw new Error(`repo "${name}" has a sandbox remote, which needs publicUrl`);
        return [name, { ...config, remote: `${String(options.publicUrl).replace(/\/+$/, "")}/git/${name}.git` }];
    }));
    const entryTtlMs = options.entryTtlMs ?? DEFAULT_ENTRY_TTL_MS;
    const now = options.now ?? (() => Date.now());
    const runGit = options.runGit ?? defaultRunGit;
    const scheduleTimeout = options.setTimeout ?? setTimeout;
    const cancelTimeout = options.clearTimeout ?? clearTimeout;
    const isWorkerAlive = options.isWorkerAlive ?? (() => true);
    const stateFile = options.stateFile ?? null;
    // Sandbox remotes get tokens from this service: random, short-lived, in
    // memory. A deployment with real remotes passes its own mintToken.
    const sandboxTokens = new Map();
    const tokenTtlMs = options.tokenTtlMs ?? 15 * 60 * 1000;
    const mintSandboxToken = () => {
        for (const [token, expiry] of sandboxTokens) if (expiry <= now()) sandboxTokens.delete(token);
        const token = randomBytes(24).toString("base64url");
        sandboxTokens.set(token, now() + tokenTtlMs);
        return token;
    };
    const hasSandbox = Object.values(repos).some((config) => config?.sandbox);
    const sandboxes = hasSandbox ? createSandboxRemotes({
        root,
        runGit: (args) => runGit(args),
        isValidToken: (token) => {
            const expiry = sandboxTokens.get(token);
            return typeof expiry === "number" && expiry > now();
        },
    }) : null;
    const idleCloneMs = options.idleCloneMs ?? DEFAULT_IDLE_CLONE_MS;
    const removalRecordMs = options.removalRecordMs ?? DEFAULT_REMOVAL_RECORD_MS;
    const iso = (ms) => new Date(ms).toISOString();
    const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
    /** One clone event: a JSON line with the time, this component and the event name first. */
    const emit = (event, fields) => {
        try { log({ time: iso(now()), component: "repo-service", event, ...fields }); } catch { /* logging never fails a request */ }
    };
    // clones: checkout -> { rootSessionId, repo, createdAt, lastUsedAt, users, previous? }
    //   users     the sessions that took a lease on it, newest last
    //   previous  set when the clone was made again after a removal: the
    //             removal, the sessions still to tell, and the turn each was told in
    // leases: checkout -> Map(sessionId -> { sessionId, rootSessionId, workerNodeId, turnIndex, time })
    // removals: removal records, oldest first
    const clones = new Map();
    const leases = new Map();
    let removals = [];
    // Checkouts being made, made again or removed: one operation at a time each.
    const busy = new Map();

    if (stateFile && fs.existsSync(stateFile)) {
        const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        for (const [checkout, record] of Object.entries(saved.clones ?? {})) {
            // A clone recorded before idle cleanup existed starts its idle
            // time now: nothing says when a session last used it.
            clones.set(checkout, { ...record, lastUsedAt: record.lastUsedAt ?? now(), users: Array.isArray(record.users) ? record.users : [] });
        }
        for (const [checkout, entries] of Object.entries(saved.leases ?? {})) {
            leases.set(checkout, new Map(entries.map((entry) => [entry.sessionId, entry])));
        }
        removals = Array.isArray(saved.removals) ? saved.removals : [];
    }
    const persist = () => {
        if (!stateFile) return;
        const data = {
            clones: Object.fromEntries(clones),
            leases: Object.fromEntries([...leases].map(([checkout, entries]) => [checkout, [...entries.values()]])),
            removals,
        };
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(data));
        fs.renameSync(`${stateFile}.tmp`, stateFile);
    };
    /** A removal record as the API shows it: times as ISO strings, without the session list. */
    const publicRemoval = (removal) => {
        const { users: _users, removedAt, createdAt, lastUsedAt, recreatedAt, ...rest } = removal;
        return {
            ...rest,
            workspace: { root: rootName, folder: removal.checkout },
            removedAt: iso(removedAt),
            ...(createdAt !== undefined ? { createdAt: iso(createdAt) } : {}),
            ...(lastUsedAt !== undefined ? { lastUsedAt: iso(lastUsedAt) } : {}),
            ...(recreatedAt !== undefined ? { recreatedAt: iso(recreatedAt) } : {}),
        };
    };
    const latestRemoval = (checkout) => {
        for (let i = removals.length - 1; i >= 0; i -= 1) if (removals[i].checkout === checkout) return removals[i];
        return null;
    };
    const idleHours = (ms) => Math.round((ms / (60 * 60 * 1000)) * 10) / 10;

    const repoConfig = (repo) => {
        if (!SEGMENT.test(String(repo || "")) || !Object.hasOwn(repos, repo)) {
            throw new ServiceError(404, "REPO_UNKNOWN", `repo "${repo}" is not served here`);
        }
        return repos[repo];
    };
    const mirrorPath = (repo) => path.join(root, "repos", `${repo}.git`);

    /** Mirror fetch and maintenance: only with the admin token, which workers never get. */
    const requireAdmin = (req) => {
        if (!options.adminToken) throw new ServiceError(403, "ADMIN_DISABLED", "mirror fetch and maintenance are off: no admin token is configured");
        const presented = Buffer.from(String(req?.headers?.authorization ?? "").replace(/^Bearer\s+/i, ""));
        const expected = Buffer.from(options.adminToken);
        if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
            throw new ServiceError(403, "ADMIN_REQUIRED", "this endpoint needs the repo service admin token");
        }
    };

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
            ["remote.origin.url", config.upstream ?? config.remote],
            ["remote.origin.fetch", "+refs/heads/*:refs/heads/*"],
            ["gc.auto", "0"],
            ["maintenance.auto", "false"],
            ["gc.pruneExpire", "never"],
        ]) await runGit(["-C", mirror, "config", key, value]);
        await runGit(["-C", mirror, "config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"]);
        await runGit(["-C", mirror, "fetch", "-q", "--prune", "origin"]);
        await followUpstreamHead(mirror);
        return mirror;
    }

    /**
     * Points the mirror's HEAD at the upstream's default branch. `git init`
     * names its own default (often master); a clone of a mirror whose HEAD
     * names a missing branch checks out nothing.
     */
    async function followUpstreamHead(mirror) {
        const symref = await runGit(["-C", mirror, "ls-remote", "--symref", "origin", "HEAD"]);
        const match = /^ref:\s+(refs\/heads\/\S+)\s+HEAD/m.exec(symref);
        if (!match) throw new Error(`upstream did not advertise a symbolic HEAD for ${mirror}`);
        try {
            await runGit(["-C", mirror, "show-ref", "--verify", "--hash", match[1]]);
        } catch {
            await runGit(["-C", mirror, "fetch", "-q", "origin", `+${match[1]}:${match[1]}`]);
            await runGit(["-C", mirror, "show-ref", "--verify", "--hash", match[1]]);
        }
        await runGit(["-C", mirror, "symbolic-ref", "HEAD", match[1]]);
    }

    /**
     * One operation per checkout at a time. Two makes of one clone share the
     * work: the second waits, then finds the clone. Anything else while a
     * checkout is busy is refused with CLONE_BUSY.
     */
    async function exclusive(checkout, kind, fn) {
        const current = busy.get(checkout);
        if (current) {
            if (kind === "make" && current.kind === "make") {
                await current.done;
                return exclusive(checkout, kind, fn);
            }
            throw new ServiceError(409, "CLONE_BUSY", `${checkout} is being ${current.kind === "remove" ? "removed" : "made"}; ask again shortly`);
        }
        let finish;
        busy.set(checkout, { kind, done: new Promise((resolve) => { finish = resolve; }) });
        try {
            return await fn();
        } finally {
            busy.delete(checkout);
            finish();
        }
    }

    /** Clones the mirror into the checkout, as the session uid. The caller keeps the record. */
    async function makeClone(repo, checkout) {
        const config = repoConfig(repo);
        const target = path.join(root, checkout);
        if (fs.existsSync(target)) throw new ServiceError(409, "CHECKOUT_EXISTS", `${checkout} exists but is not a clone this service made`);
        const mirror = await ensureMirror(repo);
        // sessions/<tree> belongs to the session uid, so the clone step (as that uid) can write in it.
        if (options.cloneUid === undefined) fs.mkdirSync(path.dirname(target), { recursive: true });
        else await runAs("mkdir", ["-p", path.dirname(target)], { uid: options.cloneUid });
        // A symlinked sessions/ or sessions/<tree> would put the clone somewhere else.
        if (!segmentsAreReal(root, path.posix.dirname(checkout), { withGit: false })) {
            throw new ServiceError(409, "CHECKOUT_UNSAFE", `${path.posix.dirname(checkout)} is not a plain folder`);
        }
        try {
            // The clone runs as the session uid, but the mirror belongs to the
            // service. Git refuses to read a repository another uid owns
            // ("dubious ownership"), and a -c before `clone` does not reach
            // the upload-pack that reads the mirror. So the exception is given
            // to that upload-pack only, and names only this mirror.
            const uploadPack = `git -c ${shellQuote(`safe.directory=${mirror}`)} upload-pack`;
            await runGit(["clone", "-q", "--shared", `--upload-pack=${uploadPack}`, mirror, target], { uid: options.cloneUid });
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
        } catch (error) {
            // A half-made clone would refuse every later try (CHECKOUT_EXISTS),
            // and a restore runs without anyone to clean up. The tree folder
            // was checked above, so this removes no link's target.
            await fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        }
        return target;
    }

    /**
     * The record of a clone just made. After a removal it remembers who used
     * the old clone, so each of them is told once (tellAboutPrevious).
     * `tell` picks those sessions: all of them after a restore; all but the
     * caller when a session made the clone itself and saw the answer.
     */
    function recordNewClone(rootSessionId, repo, checkout, removal, tell) {
        const record = { rootSessionId, repo, createdAt: now(), lastUsedAt: now(), users: [] };
        if (removal && !removal.recreatedAt) {
            removal.recreatedAt = now();
            record.previous = { removal: publicRemoval(removal), pending: (removal.users ?? []).filter(tell), told: {} };
        }
        clones.set(checkout, record);
        persist();
        return record;
    }

    /**
     * The removal a session has to hear about: on its first attach for a
     * turn after the clone was made again, and again only for a retry of that
     * same turn. A check (set_session_workspace, spawn_agent) tells no one:
     * the turn after it does.
     */
    function tellAboutPrevious(record, sessionId, turnIndex, purpose) {
        const previous = record.previous;
        if (!previous || purpose === "check") return null;
        const turn = Number.isInteger(turnIndex) ? turnIndex : null;
        if (previous.pending.includes(sessionId)) {
            previous.pending = previous.pending.filter((id) => id !== sessionId);
            previous.told[sessionId] = turn;
            return previous.removal;
        }
        if (turn !== null && Object.hasOwn(previous.told, sessionId) && previous.told[sessionId] === turn) return previous.removal;
        return null;
    }

    /**
     * What a clone held when it was removed: its branch, its commit, and work
     * that no remote has. Git runs as the session uid, never as root: the
     * clone's own config can name commands (a clean filter, for one), and a
     * session writes that config. Each fact that cannot be read is left out
     * and noted in inspectError; the removal goes ahead.
     */
    async function inspectClone(target) {
        const git = (args) => runGit(["-C", target, ...args], { uid: options.cloneUid, timeoutMs: INSPECT_TIMEOUT_MS });
        const facts = { branch: null, head: null };
        const errors = [];
        facts.branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")) || null;
        facts.head = (await git(["rev-parse", "-q", "--verify", "HEAD^{commit}"]).catch(() => "")) || null;
        try {
            // --no-optional-locks: looking must not rewrite the index.
            facts.dirty = (await git(["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=normal"])).length > 0;
        } catch (error) { errors.push(`status: ${String(error?.message ?? error).slice(0, 200)}`); }
        try {
            facts.unpushedCommits = Number(await git(["rev-list", "--count", "--branches", "--not", "--remotes"]));
        } catch (error) { errors.push(`unpushed: ${String(error?.message ?? error).slice(0, 200)}`); }
        return errors.length > 0 ? { ...facts, inspectError: errors.join("; ") } : facts;
    }

    function pruneRemovals() {
        const kept = removals.filter((removal) => now() - removal.removedAt <= removalRecordMs).slice(-10_000);
        const changed = kept.length !== removals.length;
        removals = kept;
        return changed;
    }

    /**
     * Removes a clone: refused while a lease entry is live or through a link.
     * Leaves a removal record and a `clone.removed` log line.
     * `reason`: "idle" (idle cleanup; a session of the tree gets it back by
     * attaching) or "request" (DELETE /v1/clones; it stays removed).
     */
    function removeClone(checkout, { reason, idleFor }) {
        return exclusive(checkout, "remove", async () => {
            const record = clones.get(checkout);
            if (!record) throw new ServiceError(404, "CLONE_UNKNOWN", `no clone ${checkout}`);
            const live = await liveEntries(checkout);
            if (live.length > 0) {
                throw new ServiceError(409, "CHECKOUT_IN_USE", `${checkout} has ${live.length} live lease entr${live.length === 1 ? "y" : "ies"}`);
            }
            const target = path.join(root, checkout);
            const exists = fs.existsSync(target);
            if (exists && !segmentsAreReal(root, checkout)) {
                throw new ServiceError(409, "CHECKOUT_UNSAFE", `${checkout} or its .git is not a plain folder; refusing to delete through a link`);
            }
            const facts = exists ? await inspectClone(target) : { inspectError: "the folder was already gone" };
            await fs.promises.rm(target, { recursive: true, force: true });
            // The tree's folder goes with its last clone. rmdir removes only an
            // empty folder, and segmentsAreReal above checked it is no link.
            try {
                fs.rmdirSync(path.dirname(target));
            } catch (error) {
                if (error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
            }
            const removal = {
                checkout,
                rootSessionId: record.rootSessionId,
                repo: record.repo,
                reason,
                createdAt: record.createdAt,
                lastUsedAt: record.lastUsedAt,
                removedAt: now(),
                ...(idleFor !== undefined ? { idleHours: idleHours(idleFor) } : {}),
                ...facts,
                users: record.users ?? [],
            };
            clones.delete(checkout);
            leases.delete(checkout);
            removals.push(removal);
            pruneRemovals();
            persist();
            emit("clone.removed", publicRemoval(removal));
            return removal;
        });
    }

    /** One idle pass: removes every clone that no session has used for idleCloneMs. */
    async function removeIdleClones() {
        const removed = [];
        if (!(idleCloneMs > 0)) return removed;
        for (const [checkout, record] of [...clones]) {
            if (busy.has(checkout)) continue;
            const idleFor = now() - (record.lastUsedAt ?? record.createdAt ?? now());
            if (idleFor < idleCloneMs) continue;
            if ((await liveEntries(checkout)).length > 0) continue;
            try {
                removed.push(publicRemoval(await removeClone(checkout, { reason: "idle", idleFor })));
            } catch (error) {
                emit("clone.remove_failed", {
                    checkout, rootSessionId: record.rootSessionId, repo: record.repo, reason: "idle",
                    code: error?.code ?? "INTERNAL", message: String(error?.message ?? error),
                });
            }
        }
        if (pruneRemovals()) persist();
        return removed;
    }

    const handlers = {
        async "POST /v1/clones"({ rootSessionId, repo, sessionId }) {
            if (!SEGMENT.test(String(rootSessionId || ""))) throw new ServiceError(400, "BAD_REQUEST", "rootSessionId is required");
            repoConfig(repo);
            const checkout = checkoutFolder(rootSessionId, repo);
            const made = await exclusive(checkout, "make", async () => {
                if (clones.has(checkout)) return { created: false };
                await makeClone(repo, checkout);
                const record = recordNewClone(rootSessionId, repo, checkout, latestRemoval(checkout), (id) => id !== sessionId);
                emit("clone.created", {
                    checkout, rootSessionId, repo,
                    ...(typeof sessionId === "string" ? { sessionId } : {}),
                    ...(record.previous ? { previous: record.previous.removal } : {}),
                });
                return { created: true, ...(record.previous ? { previous: record.previous.removal } : {}) };
            });
            return {
                workspace: { root: rootName, folder: checkout },
                path: path.join(root, checkout),
                ...made,
                ...(idleCloneMs > 0 ? { removedAfterIdleHours: idleHours(idleCloneMs) } : {}),
            };
        },

        async "POST /v1/clones/restore"({ rootSessionId, repo, sessionId }) {
            if (!SEGMENT.test(String(rootSessionId || ""))) throw new ServiceError(400, "BAD_REQUEST", "rootSessionId is required");
            repoConfig(repo);
            const checkout = checkoutFolder(rootSessionId, repo);
            return exclusive(checkout, "make", async () => {
                const answer = { workspace: { root: rootName, folder: checkout }, path: path.join(root, checkout) };
                if (clones.has(checkout)) return { ...answer, restored: false };
                // Only what idle cleanup removed comes back by itself. A clone
                // removed on request stays removed until a session makes it again.
                const removal = latestRemoval(checkout);
                if (!removal || removal.reason !== "idle" || removal.recreatedAt) {
                    throw new ServiceError(404, "NOT_RESTORABLE", `${checkout} was not removed by idle cleanup`);
                }
                await makeClone(repo, checkout);
                recordNewClone(rootSessionId, repo, checkout, removal, () => true);
                emit("clone.restored", {
                    checkout, rootSessionId, repo,
                    ...(typeof sessionId === "string" ? { sessionId } : {}),
                    removedAt: iso(removal.removedAt),
                });
                return { ...answer, restored: true };
            });
        },

        async "GET /v1/clones"(_body, query) {
            const tree = query.get("rootSessionId");
            const mine = (record) => !tree || record.rootSessionId === tree;
            const list = [];
            for (const [checkout, record] of clones) {
                if (!mine(record)) continue;
                const { users: _users, previous, createdAt, lastUsedAt, ...rest } = record;
                const inUse = (await liveEntries(checkout)).length > 0;
                const usedAt = lastUsedAt ?? createdAt;
                list.push({
                    ...rest,
                    workspace: { root: rootName, folder: checkout },
                    createdAt: iso(createdAt),
                    lastUsedAt: iso(usedAt),
                    inUse,
                    // Without a session on it, the clone goes at this time.
                    ...(idleCloneMs > 0 && !inUse ? { removeAfter: iso(usedAt + idleCloneMs) } : {}),
                    ...(previous ? { previous: previous.removal } : {}),
                });
            }
            return {
                clones: list,
                removed: removals.filter(mine).map(publicRemoval),
                ...(idleCloneMs > 0 ? { removedAfterIdleHours: idleHours(idleCloneMs) } : {}),
            };
        },

        async "DELETE /v1/clones"({ rootSessionId, repo }) {
            const removal = await removeClone(checkoutFolder(rootSessionId, repo), { reason: "request" });
            return { deleted: true, removal: publicRemoval(removal) };
        },

        async "POST /v1/leases"({ checkout, sessionId, rootSessionId, workerNodeId, turnIndex, purpose }) {
            if (!parseCheckout(checkout)) throw new ServiceError(400, "BAD_REQUEST", "checkout must be sessions/<rootSessionId>/<repo>");
            const inProgress = busy.get(checkout);
            if (inProgress) {
                return {
                    ok: false, code: "WORKSPACE_ATTACH_FAILED",
                    message: `${checkout} is being ${inProgress.kind === "remove" ? "removed" : "made"}`,
                    retryAfterMs: 30_000,
                };
            }
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
            // The liveness lookups may have let a removal start: it must not
            // delete the clone under the entry this call is about to add.
            if (busy.has(checkout) || clones.get(checkout) !== record) {
                return { ok: false, code: "WORKSPACE_ATTACH_FAILED", message: `${checkout} changed while attaching`, retryAfterMs: 30_000 };
            }
            const dead = states.filter((s) => !s.live).map((s) => s.entry);
            const anyLive = states.some((s) => s.live);
            let removedLocks = [];
            // Lock files are removed only when no live entry remains: a live
            // entry may belong to a git command still running (K15, test R5).
            if (dead.length > 0 && !anyLive && segmentsAreReal(root, checkout)) removedLocks = removeStaleGitLocks(path.join(root, checkout));
            for (const entry of dead) entries.delete(entry.sessionId);
            entries.set(sessionId, { sessionId, rootSessionId, workerNodeId, turnIndex, time: now() });
            leases.set(checkout, entries);
            record.lastUsedAt = now();
            record.users = [...(record.users ?? []).filter((id) => id !== sessionId), sessionId].slice(-MAX_CLONE_USERS);
            const recreated = tellAboutPrevious(record, sessionId, turnIndex, purpose);
            persist();
            return {
                ok: true,
                adopt: repos[record.repo]?.adopt ?? null,
                ...(removedLocks.length ? { removedLocks } : {}),
                // The clone was made again after a removal, and this session used the old one.
                ...(recreated ? { recreated } : {}),
            };
        },

        async "DELETE /v1/leases"({ checkout, sessionId, workerNodeId, turnIndex }) {
            const entries = leases.get(checkout);
            const entry = entries?.get(sessionId);
            if (!entry) return { deleted: false };
            // A release can arrive late, after the session attached on
            // another worker, or again on this one in a newer turn. It must
            // not delete that newer entry: without a live entry, cleanup and
            // stale-lock removal would run under a working session.
            if (workerNodeId !== undefined && entry.workerNodeId !== workerNodeId) {
                return { deleted: false, reason: "another worker holds the entry" };
            }
            if (Number.isInteger(turnIndex) && Number.isInteger(entry.turnIndex) && entry.turnIndex > turnIndex) {
                return { deleted: false, reason: "a newer turn holds the entry" };
            }
            entries.delete(sessionId);
            if (entries.size === 0) leases.delete(checkout);
            // A release is a use: the idle time counts from when the session left.
            const record = clones.get(checkout);
            if (record) record.lastUsedAt = now();
            persist();
            return { deleted: true };
        },

        async "POST /v1/mirrors/fetch"({ repo }, _query, req) {
            requireAdmin(req);
            repoConfig(repo);
            const mirror = await ensureMirror(repo);
            await runGit(["-C", mirror, "fetch", "-q", "--prune", "origin"]);
            await followUpstreamHead(mirror);
            return { fetched: true };
        },

        async "POST /v1/maintenance"({ repo, operation }, _query, req) {
            requireAdmin(req);
            repoConfig(repo);
            if (!Object.hasOwn(MAINTENANCE_OPERATIONS, String(operation))) {
                throw new ServiceError(400, "MAINTENANCE_UNKNOWN", `unknown maintenance operation "${operation}"; use one of ${Object.keys(MAINTENANCE_OPERATIONS).join(", ")}`);
            }
            await runGit(["-C", mirrorPath(repo), ...MAINTENANCE_OPERATIONS[operation]]);
            return { ran: operation };
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
            if (!match) return {};
            if (match[1].sandbox) return { username: "x-token", password: mintSandboxToken() };
            if (!options.mintToken) return {};
            const token = await options.mintToken({ repo: match[0], url: match[1].remote });
            return token ? { username: "x-token", password: token } : {};
        },
    };

    /** Mirrors every repo, and makes its sandbox; at start, before the first clone asks. */
    async function prepare() {
        for (const [repo, config] of Object.entries(repos)) {
            const existed = fs.existsSync(mirrorPath(repo));
            const mirror = await ensureMirror(repo);
            if (existed) await followUpstreamHead(mirror);
            if (config?.sandbox) {
                await sandboxes.ensure(repo, mirror);
                await sandboxes.syncFromMirror(repo, mirror);
            }
        }
    }

    /** Fetches every mirror from its upstream, then brings each sandbox's protected branches up to date. */
    async function refresh() {
        for (const [repo, config] of Object.entries(repos)) {
            const mirror = mirrorPath(repo);
            if (!fs.existsSync(mirror)) continue;
            await runGit(["-C", mirror, "fetch", "-q", "--prune", "origin"]);
            await followUpstreamHead(mirror);
            if (config?.sandbox) await sandboxes.syncFromMirror(repo, mirror);
        }
    }

    const server = http.createServer(async (req, res) => {
        if (sandboxes && sandboxes.handle(req, res)) return;
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
            reply(200, await handler(text ? JSON.parse(text) : {}, url.searchParams, req));
        } catch (error) {
            if (error instanceof ServiceError) return reply(error.status, { error: { code: error.code, message: error.message } });
            reply(500, { error: { code: "INTERNAL", message: String(error?.message ?? error) } });
        }
    });

    let refreshTimer = null;
    let refreshIntervalMs = 0;
    let idleTimer = null;
    let idlePassRunning = false;
    const scheduleRefresh = (log) => {
        refreshTimer = scheduleTimeout(async () => {
            refreshTimer = null;
            try {
                await refresh();
            } catch (error) {
                log(`[repo-service] refresh failed: ${error?.message ?? error}`);
            } finally {
                if (refreshIntervalMs > 0) {
                    scheduleRefresh(log);
                }
            }
        }, refreshIntervalMs);
        refreshTimer.unref?.();
    };
    return {
        server,
        prepare,
        refresh,
        removeIdleClones,
        /** Refreshes every `intervalMs` in the background; errors are logged, not thrown. */
        startRefresh(intervalMs, log = console.error) {
            if (refreshIntervalMs > 0 || !(intervalMs > 0)) return;
            refreshIntervalMs = intervalMs;
            scheduleRefresh(log);
        },
        /** Runs the idle pass every `intervalMs` in the background; off when idleCloneMs is 0. */
        startIdleCleanup(intervalMs = idleCheckIntervalMs(idleCloneMs)) {
            if (idleTimer || !(idleCloneMs > 0) || !(intervalMs > 0)) return;
            idleTimer = setInterval(() => {
                // A slow pass (many large clones) is not run twice at once.
                if (idlePassRunning) return;
                idlePassRunning = true;
                removeIdleClones()
                    .catch((error) => emit("clone.idle_pass_failed", { message: String(error?.message ?? error) }))
                    .finally(() => { idlePassRunning = false; });
            }, intervalMs);
            idleTimer.unref?.();
        },
        /** Test and admin view of the service state. */
        state: () => ({
            clones: Object.fromEntries(clones),
            leases: Object.fromEntries([...leases].map(([checkout, entries]) => [checkout, [...entries.values()]])),
            removals: removals.map((removal) => ({ ...removal })),
        }),
        async listen(port = 0, host = "127.0.0.1") {
            await new Promise((resolve) => server.listen(port, host, resolve));
            const address = server.address();
            return `http://${address.address}:${address.port}`;
        },
        async close() {
            refreshIntervalMs = 0;
            if (refreshTimer) cancelTimeout(refreshTimer);
            refreshTimer = null;
            if (idleTimer) clearInterval(idleTimer);
            idleTimer = null;
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

/**
 * Pod entry point. Environment:
 *   REPO_SERVICE_ROOT        the export root (default /ws/a)
 *   REPO_SERVICE_ROOT_NAME   its name in workspace records (default a)
 *   REPO_SERVICE_REPOS       JSON: { "<repo>": { "remote": "<url>", "upstream"?: "<url>", "sandbox"?: true, "adopt": { ... } } }
 *   REPO_SERVICE_PUBLIC_URL  this service's URL as workers reach it (sandbox remotes need it)
 *   REPO_SERVICE_REFRESH_S   how often mirrors fetch and sandboxes follow them (default 300; 0 = never)
 *   REPO_SERVICE_STATE_FILE  service-private state (default /var/lib/repo-service/state.json)
 *   REPO_SERVICE_PORT        default 8080
 *   REPO_SERVICE_HOST        the address to listen on (default 0.0.0.0; a laptop run uses 127.0.0.1)
 *   REPO_SERVICE_CLONE_UID   the session uid for clone creation (default 1000)
 *   REPO_SERVICE_CREDENTIAL_HELPER  the helper command clones set
 *   REPO_SERVICE_IDLE_CLONE_HOURS   remove a clone no session has used for this many hours
 *                            (default 168 = 7 days; 0 = never)
 *   REPO_SERVICE_ADMIN_TOKEN the admin token for mirror fetch and maintenance (never given to workers)
 * Token minting and the worker registry are deployment-specific; wire them
 * in a wrapper that calls createRepoService() with mintToken and isWorkerAlive.
 */
/** REPO_SERVICE_IDLE_CLONE_HOURS in milliseconds: unset = 7 days, 0 = never. */
export function idleCloneMsFromEnv(value) {
    if (value === undefined || String(value).trim() === "") return DEFAULT_IDLE_CLONE_MS;
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours < 0) throw new Error(`REPO_SERVICE_IDLE_CLONE_HOURS must be a number of hours (0 = never), not "${value}"`);
    return Math.round(hours * 60 * 60 * 1000);
}

async function main() {
    const env = process.env;
    const service = createRepoService({
        root: env.REPO_SERVICE_ROOT || "/ws/a",
        rootName: env.REPO_SERVICE_ROOT_NAME || "a",
        repos: JSON.parse(env.REPO_SERVICE_REPOS || "{}"),
        stateFile: env.REPO_SERVICE_STATE_FILE || "/var/lib/repo-service/state.json",
        cloneUid: env.REPO_SERVICE_CLONE_UID ? Number(env.REPO_SERVICE_CLONE_UID) : 1000,
        credentialHelper: env.REPO_SERVICE_CREDENTIAL_HELPER || undefined,
        adminToken: env.REPO_SERVICE_ADMIN_TOKEN || undefined,
        publicUrl: env.REPO_SERVICE_PUBLIC_URL || undefined,
        idleCloneMs: idleCloneMsFromEnv(env.REPO_SERVICE_IDLE_CLONE_HOURS),
    });
    // Mirror and sandbox every repo before taking requests: a first clone
    // then finds a ready mirror.
    await service.prepare();
    const url = await service.listen(Number(env.REPO_SERVICE_PORT || 8080), env.REPO_SERVICE_HOST || "0.0.0.0");
    service.startRefresh(Number(env.REPO_SERVICE_REFRESH_S ?? 300) * 1000);
    service.startIdleCleanup();
    console.log(`[repo-service] listening at ${url}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
