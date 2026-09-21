import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    dehydrateGitWorkspace,
    hydrateGitWorkspace,
} from "../../dist/git-workspace.js";
import { runWithTurnLifecycleHooks } from "../../dist/turn-lifecycle-hooks.js";

const gitConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-git-config-"));
const gitConfig = path.join(gitConfigRoot, "gitconfig");
fs.writeFileSync(
    gitConfig,
    "[core]\n\tautocrlf = false\n\teol = lf\n[safe]\n\tbareRepository = all\n\tdirectory = *\n",
);
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_SYSTEM = gitConfig;

const git = (cwd, args) => execFileSync("git", ["-c", "safe.bareRepository=all", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
}).trim();

function configureRepository(dir) {
    git(dir, ["config", "user.email", "workspace-test@example.invalid"]);
    git(dir, ["config", "user.name", "Workspace Test"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    git(dir, ["config", "core.autocrlf", "false"]);
}

function makeDurable() {
    const values = new Map();
    const cell = { row: null };
    return {
        blobs: {
            async get(kind) {
                return values.has(kind) ? Buffer.from(values.get(kind)) : null;
            },
            async put(kind, data) {
                values.set(kind, Buffer.from(data));
            },
        },
        state: {
            async get() {
                return cell.row ? { ...cell.row } : null;
            },
            async set(next) {
                cell.row = { ...next };
            },
        },
        values,
        cell,
    };
}

function makeWorld(label) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `pilotswarm-git-workspace-${label}-`));
    const originDir = path.join(root, "origin.git");
    execFileSync("git", ["init", "--bare", "-b", "main", originDir], { stdio: "ignore" });

    const seedDir = path.join(root, "seed");
    execFileSync("git", ["clone", originDir, seedDir], { stdio: "ignore" });
    configureRepository(seedDir);
    fs.writeFileSync(path.join(seedDir, "README.md"), "line1\n");
    git(seedDir, ["add", "README.md"]);
    git(seedDir, ["commit", "-m", "seed"]);
    git(seedDir, ["push", "origin", "main"]);
    git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    return { root, originDir };
}

function cloneWorker(originDir, root, name) {
    const dir = path.join(root, name);
    execFileSync("git", ["clone", originDir, dir], { stdio: "ignore" });
    configureRepository(dir);
    return dir;
}

test("tracked and untracked changes survive restoration on a fresh worker", async () => {
    const { root, originDir } = makeWorld("changes");
    try {
        const durable = makeDurable();
        const first = cloneWorker(originDir, root, "worker-a");
        assert.equal((await hydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        })).mode, "pinned-base");

        fs.appendFileSync(path.join(first, "README.md"), "line2\n");
        fs.writeFileSync(path.join(first, "notes.txt"), "scratch\n");
        await dehydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
        });

        const second = cloneWorker(originDir, root, "worker-b");
        assert.equal((await hydrateGitWorkspace({
            enlistmentDir: second,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        })).mode, "replayed");
        assert.equal(fs.readFileSync(path.join(second, "README.md"), "utf8"), "line1\nline2\n");
        assert.equal(fs.readFileSync(path.join(second, "notes.txt"), "utf8"), "scratch\n");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("unpushed commits and edits on top survive restoration", async () => {
    const { root, originDir } = makeWorld("commits");
    try {
        const durable = makeDurable();
        const first = cloneWorker(originDir, root, "worker-a");
        await hydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });

        fs.writeFileSync(path.join(first, "feature.txt"), "feature\n");
        git(first, ["add", "feature.txt"]);
        git(first, ["commit", "-m", "local feature"]);
        fs.appendFileSync(path.join(first, "README.md"), "pending\n");
        await dehydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
        });

        const second = cloneWorker(originDir, root, "worker-b");
        await hydrateGitWorkspace({
            enlistmentDir: second,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        assert.match(git(second, ["log", "--oneline"]), /local feature/);
        assert.equal(fs.readFileSync(path.join(second, "feature.txt"), "utf8"), "feature\n");
        assert.equal(fs.readFileSync(path.join(second, "README.md"), "utf8"), "line1\npending\n");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("turn hooks compose hydration, work, and dehydration", async () => {
    const { root, originDir } = makeWorld("hooks");
    try {
        const durable = makeDurable();
        const first = cloneWorker(originDir, root, "worker-a");
        await runWithTurnLifecycleHooks({
            context: {
                sessionId: "session-hooks",
                turnIndex: 0,
                config: {},
                trace() {},
            },
            beforeTurn: () => hydrateGitWorkspace({
                enlistmentDir: first,
                blobs: durable.blobs,
                state: durable.state,
                targetRef: "origin/main",
            }),
            run: () => {
                fs.writeFileSync(path.join(first, "result.txt"), "persisted\n");
                return { type: "completed" };
            },
            afterTurn: ({ status }) => {
                assert.equal(status, "completed");
                return dehydrateGitWorkspace({
                    enlistmentDir: first,
                    blobs: durable.blobs,
                    state: durable.state,
                });
            },
        });

        const second = cloneWorker(originDir, root, "worker-b");
        await hydrateGitWorkspace({
            enlistmentDir: second,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        assert.equal(fs.readFileSync(path.join(second, "result.txt"), "utf8"), "persisted\n");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a failed state commit leaves newer artifacts uncommitted and ignored", async () => {
    const { root, originDir } = makeWorld("state-failure");
    try {
        const durable = makeDurable();
        const first = cloneWorker(originDir, root, "worker-a");
        await hydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        fs.writeFileSync(path.join(first, "partial.txt"), "partial\n");

        const commitError = new Error("state commit failed");
        await assert.rejects(dehydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: {
                get: () => durable.state.get(),
                async set(next) {
                    if (next.epoch > 0) throw commitError;
                    await durable.state.set(next);
                },
            },
        }), (error) => error === commitError);
        assert.equal(durable.cell.row.epoch, 0);
        assert.equal(JSON.parse(durable.values.get("meta").toString("utf8")).epoch, 1);

        const second = cloneWorker(originDir, root, "worker-b");
        assert.equal((await hydrateGitWorkspace({
            enlistmentDir: second,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        })).mode, "base-only");
        assert.equal(fs.existsSync(path.join(second, "partial.txt")), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a failed metadata write never advances state", async () => {
    const { root, originDir } = makeWorld("metadata-failure");
    try {
        const durable = makeDurable();
        const first = cloneWorker(originDir, root, "worker-a");
        await hydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        fs.writeFileSync(path.join(first, "partial.txt"), "partial\n");

        const writeError = new Error("metadata write failed");
        await assert.rejects(dehydrateGitWorkspace({
            enlistmentDir: first,
            blobs: {
                get: (kind) => durable.blobs.get(kind),
                async put(kind, data) {
                    if (kind === "meta") throw writeError;
                    await durable.blobs.put(kind, data);
                },
            },
            state: durable.state,
        }), (error) => error === writeError);
        assert.equal(durable.cell.row.epoch, 0);
        assert.equal(durable.values.has("meta"), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a no-op workspace restores cleanly without invented changes", async () => {
    const { root, originDir } = makeWorld("noop");
    try {
        const durable = makeDurable();
        const first = cloneWorker(originDir, root, "worker-a");
        await hydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        await dehydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
        });

        const second = cloneWorker(originDir, root, "worker-b");
        await hydrateGitWorkspace({
            enlistmentDir: second,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        assert.equal(git(second, ["status", "--porcelain"]), "");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
