import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Git setup for the session-workspaces tests (proposal section 9,
 * "createGitFixture()"). One temp root laid out like section 5.1:
 *
 *   <root>/remotes/<name>.git   bare "GitHub" with a pre-receive hook
 *   <root>/repos/<name>.git     mirror with the production fetch and gc settings
 *   <root>/sessions/<rootSessionId>/<clone>   clone --shared, relative alternates
 *   <root>/markers/             files that repo hooks and MCP servers append to when they run
 *
 * Every git child process gets an isolated env: no global or system config,
 * a fixed identity, no prompts, no proxy.
 */

export const PRE_RECEIVE_MESSAGES = Object.freeze({
    deletion: "fixture-pre-receive: deleting a branch is not allowed",
    protectedBranch: "fixture-pre-receive: pushes to a protected branch are not allowed",
    nonFastForward: "fixture-pre-receive: non-fast-forward updates are not allowed",
});

/** Repo MCP config files the fixture ships, each starting a marker server. */
export const MCP_CONFIG_FILES = Object.freeze([".mcp.json", ".github/mcp.json", ".vscode/mcp.json"]);

/** The marker server's name in one MCP config file, for example "fixture-marker-github-mcp". */
export function mcpServerName(file) {
    return `fixture-marker-${file.replace(/^\./, "").replace(/[^a-z0-9]+/gi, "-").replace(/-json$/, "")}`;
}

/** Env for every git child process. Callers may add keys, never remove the isolation. */
export function gitEnv(extra = {}) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        // An inherited GIT_DIR, GIT_ASKPASS (VS Code sets one) or
        // GIT_CONFIG_* would leak the host's repo or credentials into the fixture.
        if (key.startsWith("GIT_") || key === "SSH_ASKPASS") continue;
        env[key] = value;
    }
    return {
        ...env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_TERMINAL_PROMPT: "0",
        // Messages are asserted on; keep them untranslated.
        LC_ALL: "C",
        // The token server listens on loopback; a host proxy must not intercept it.
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        ...extra,
    };
}

/** Runs git and resolves { ok, code, stdout, stderr } without throwing. Async so an in-process HTTP server keeps serving. */
export function tryGit(args, { cwd, env } = {}) {
    return new Promise(resolve => {
        execFile("git", args, { cwd, env: gitEnv(env), maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
            resolve({ ok: !error, code, stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

/** Runs git and resolves trimmed stdout; throws with stderr on failure. */
export async function git(args, opts = {}) {
    const result = await tryGit(args, opts);
    if (!result.ok) {
        throw new Error(`git ${args.join(" ")} failed (${result.code}) in ${opts.cwd ?? process.cwd()}:\n${result.stderr}${result.stdout}`);
    }
    return result.stdout.trim();
}

/** `git count-objects -v` as numbers. Counts only the repo's own store, never its alternates. */
export async function countObjects(repo) {
    const out = await git(["-C", repo, "count-objects", "-v"]);
    const fields = Object.fromEntries(out.split("\n").map(line => {
        const [key, value] = line.split(":").map(s => s.trim());
        return [key, Number(value)];
    }));
    return { loose: fields.count, packed: fields["in-pack"], total: fields.count + fields["in-pack"] };
}

function preReceiveScript() {
    // Mirrors the server rules of proposal section 5.4: protected branches,
    // no force pushes, no deletions. Plain sh so it runs on stock Linux and macOS.
    return `#!/bin/sh
status=0
while read old new ref; do
    case "$new" in
        *[!0]*) ;;
        *) echo "${PRE_RECEIVE_MESSAGES.deletion}: $ref" >&2; status=1; continue ;;
    esac
    case "$ref" in
        refs/heads/main|refs/heads/release/*)
            echo "${PRE_RECEIVE_MESSAGES.protectedBranch}: $ref" >&2; status=1; continue ;;
    esac
    case "$old" in
        *[!0]*)
            if ! git merge-base --is-ancestor "$old" "$new"; then
                echo "${PRE_RECEIVE_MESSAGES.nonFastForward}: $ref" >&2; status=1
            fi ;;
    esac
done
exit $status
`;
}

function fixtureFiles({ markers, agentsMarker }) {
    const hookCommand = event => ({
        type: "command",
        // Append the event name so a proof run can tell which event fired.
        bash: `echo ${event} >> '${markers.hook}'`,
        timeoutSec: 10,
    });
    return {
        "README.md": "# Fixture repo\n\nContent for the session-workspaces git tests.\n",
        "AGENTS.md": `# Agent instructions\n\n${agentsMarker}\n`,
        ".github/agents/reviewer.agent.md": [
            "---",
            "name: reviewer",
            "description: Reviews changes in the fixture repo and reports problems.",
            'tools: ["read", "search"]',
            "---",
            "",
            "You are the fixture reviewer. Read the changed files and list any problems you find.",
            "",
        ].join("\n"),
        ".github/skills/build/SKILL.md": [
            "---",
            "name: build",
            "description: Builds the fixture project from the repo root.",
            "---",
            "",
            "Run `make build` from the repo root and report the result.",
            "",
        ].join("\n"),
        // Copilot CLI repo hook format (version 1, per-event arrays of command hooks).
        ".github/hooks/fixture-marker.json": JSON.stringify({
            version: 1,
            hooks: {
                sessionStart: [hookCommand("sessionStart")],
                userPromptSubmitted: [hookCommand("userPromptSubmitted")],
            },
        }, null, 2) + "\n",
        // Repo MCP config in every place a client might read it. Copilot CLI
        // 1.0.83 reads .mcp.json and .github/mcp.json (key mcpServers) and has
        // dropped .vscode/mcp.json (key servers). Each server appends its file
        // name to markers.mcp, so a test can tell which file was started.
        ...Object.fromEntries(MCP_CONFIG_FILES.map(file => [file, JSON.stringify({
            [file === ".vscode/mcp.json" ? "servers" : "mcpServers"]: {
                // One name per file, so a client that merges the files keeps all three.
                [mcpServerName(file)]: { type: "stdio", command: "sh", args: ["-c", `echo ${file} >> '${markers.mcp}'`] },
            },
        }, null, 2) + "\n"])),
    };
}

function writeFiles(dir, files) {
    for (const [rel, content] of Object.entries(files)) {
        const file = path.join(dir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
}

function walk(dir, visit) {
    visit(dir, true);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, visit);
        else visit(full, false);
    }
}

/**
 * Builds the fixture. `layout` picks where the mirror keeps objects it
 * fetches: "loose" or "packed" (G2 needs both, because the forbidden
 * maintenance commands break them differently).
 */
export async function createGitFixture({ name = "app", layout = "loose" } = {}) {
    if (layout !== "loose" && layout !== "packed") throw new Error(`unknown layout ${layout}`);
    // realpath: macOS tmpdir is a symlink, and relative alternates must be computed on real paths.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-git-fixture-")));
    if (root.includes("'")) throw new Error(`fixture root must not contain a quote: ${root}`);
    const remote = path.join(root, "remotes", `${name}.git`);
    const mirror = path.join(root, "repos", `${name}.git`);
    const sessionsDir = path.join(root, "sessions");
    const upstreamWork = path.join(root, "upstream-work");
    const markersDir = path.join(root, "markers");
    const markers = { hook: path.join(markersDir, "hook-ran"), mcp: path.join(markersDir, "mcp-ran") };
    const agentsMarker = `Fixture instruction marker ${randomBytes(6).toString("hex")}.`;
    for (const dir of [path.dirname(remote), path.dirname(mirror), sessionsDir, markersDir]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, ".pilotswarm-export"), "");

    let readOnlyModes = null;

    async function setMirrorReadOnly(readOnly) {
        if (readOnly && !readOnlyModes) {
            // Simulates section 5.1: repos/ and the mirror owned by another uid,
            // so the session user can read but not delete, rename or add files.
            readOnlyModes = new Map();
            const lock = (p, isDir) => {
                const mode = fs.statSync(p).mode & 0o7777;
                readOnlyModes.set(p, mode);
                fs.chmodSync(p, isDir ? 0o555 : mode & ~0o222);
            };
            walk(mirror, lock);
            lock(path.dirname(mirror), true);
        } else if (!readOnly && readOnlyModes) {
            // Parents first, so children are reachable again.
            const entries = [...readOnlyModes].sort((a, b) => a[0].length - b[0].length);
            for (const [p, mode] of entries) fs.chmodSync(p, mode);
            readOnlyModes = null;
        }
    }

    async function commitIn(worktree, files, message) {
        writeFiles(worktree, files);
        await git(["-C", worktree, "add", "-A"]);
        await git(["-C", worktree, "commit", "-q", "--allow-empty", "-m", message]);
        return git(["-C", worktree, "rev-parse", "HEAD"]);
    }

    /**
     * Commits on top of `parent` (default: the branch tip, or main for a new
     * branch) and moves the upstream branch there. The objects arrive by a
     * `fetch` run inside the bare remote, which, like update-ref, runs no
     * pre-receive hook: this is the "someone pushed upstream" stand-in.
     */
    async function pushUpstream({ branch, files = {}, message, parent } = {}) {
        if (!branch) throw new Error("pushUpstream needs a branch");
        const existing = await tryGit(["-C", remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
        const base = parent ?? (existing.ok ? existing.stdout.trim() : await git(["-C", remote, "rev-parse", "refs/heads/main"]));
        await git(["-C", upstreamWork, "fetch", "-q", remote, "+refs/heads/*:refs/remotes/upstream/*"]);
        await git(["-C", upstreamWork, "checkout", "-q", "--detach", base]);
        const content = Object.keys(files).length ? files : { [`upstream/${randomBytes(4).toString("hex")}.txt`]: `${randomBytes(16).toString("hex")}\n` };
        const sha = await commitIn(upstreamWork, content, message ?? `upstream change on ${branch}`);
        await git(["-C", upstreamWork, "update-ref", "refs/heads/fixture-outgoing", sha]);
        await git(["-C", remote, "fetch", "-q", upstreamWork, `+refs/heads/fixture-outgoing:refs/heads/${branch}`]);
        return sha;
    }

    /**
     * Moves an upstream branch to any commit, including backwards (a force
     * push). `update-ref` runs inside the bare remote and never goes through
     * receive-pack, so the pre-receive hook does not see it.
     */
    async function rewriteUpstream({ branch, toCommit }) {
        await git(["-C", remote, "update-ref", `refs/heads/${branch}`, toCommit]);
    }

    /** What the repo service does: fetch every branch and tag, pruning deleted ones. */
    function fetchMirror() {
        return git(["-C", mirror, "fetch", "-q", "--prune", "origin"]);
    }

    /**
     * Pushes a commit upstream, lets the mirror fetch it, calls `prepare(sha)`
     * so a test can make a session clone depend on it, then force-pushes the
     * branch back and fetches with --prune. Afterwards the mirror still holds
     * the commit (loose or packed, per layout) but no ref reaches it.
     */
    async function createUnreachableObjects({ branch = "feature/unreachable", prepare } = {}) {
        const base = await git(["-C", remote, "rev-parse", "refs/heads/main"]);
        const commit = await pushUpstream({
            branch,
            parent: base,
            files: { [`unreachable/${randomBytes(4).toString("hex")}.txt`]: `${randomBytes(32).toString("hex")}\n` },
            message: "commit that upstream will force-push away",
        });
        await fetchMirror();
        const tree = await git(["-C", mirror, "rev-parse", `${commit}^{tree}`]);
        const blobs = (await git(["-C", mirror, "diff-tree", "-r", "--no-commit-id", "--diff-filter=A", base, commit]))
            .split("\n").filter(Boolean).map(line => line.split(/\s+/)[3]);
        await prepare?.(commit);
        await rewriteUpstream({ branch, toCommit: base });
        await fetchMirror();
        return { commit, objects: [commit, tree, ...blobs], restoredTo: base };
    }

    /**
     * Makes <root>/sessions/<rootSessionId>/<name> the way the repo service
     * would: clone --shared from the mirror, then alternates made relative and
     * origin pointed at the real remote (or `originUrl`, e.g. the token server).
     * `shared: false` makes a normal clone with its own objects, for G5.
     */
    async function cloneSession({ rootSessionId, name: cloneName = name, originUrl = remote, shared = true } = {}) {
        if (!rootSessionId) throw new Error("cloneSession needs a rootSessionId");
        const clone = path.join(sessionsDir, rootSessionId, cloneName);
        fs.mkdirSync(path.dirname(clone), { recursive: true });
        await git(["clone", "-q", shared ? "--shared" : "--no-local", mirror, clone]);
        if (shared) {
            const objectsDir = path.join(clone, ".git", "objects");
            // Git resolves a relative alternate against the clone's objects directory.
            const relative = path.relative(objectsDir, path.join(mirror, "objects"));
            fs.writeFileSync(path.join(objectsDir, "info", "alternates"), `${relative}\n`);
        }
        await git(["-C", clone, "remote", "set-url", "origin", originUrl]);
        return clone;
    }

    async function cleanup() {
        try { await setMirrorReadOnly(false); } catch { /* the tree may already be gone */ }
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }

    try {
        await git(["init", "-q", "--bare", "-b", "main", remote]);
        fs.writeFileSync(path.join(remote, "hooks", "pre-receive"), preReceiveScript(), { mode: 0o755 });

        await git(["init", "-q", "-b", "main", upstreamWork]);
        const initial = await commitIn(upstreamWork, fixtureFiles({ markers, agentsMarker }), "initial fixture content");
        await git(["-C", remote, "fetch", "-q", upstreamWork, "refs/heads/main:refs/heads/main", "refs/heads/main:refs/heads/release/1"]);

        await git(["init", "-q", "--bare", "-b", "main", mirror]);
        for (const [key, value] of [
            ["remote.origin.url", remote],
            ["remote.origin.fetch", "+refs/heads/*:refs/heads/*"],
            ["gc.auto", "0"],
            ["maintenance.auto", "false"],
            ["gc.pruneExpire", "never"],
            // Test-only knob: at or above the limit a fetch keeps the pack,
            // below it the objects are unpacked loose.
            ["fetch.unpackLimit", layout === "packed" ? "1" : "1000000"],
        ]) await git(["-C", mirror, "config", key, value]);
        await git(["-C", mirror, "config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"]);
        await fetchMirror();

        return {
            root, name, layout, remote, mirror, sessionsDir, markers, agentsMarker,
            commits: { initial },
            git, tryGit, countObjects,
            cloneSession, pushUpstream, rewriteUpstream, fetchMirror, createUnreachableObjects,
            setMirrorReadOnly, cleanup,
        };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
