import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    dehydrateGitWorkspace as dehydrateWorkspace,
    gitWorkspaceBlobKey,
    hydrateGitWorkspace as hydrateWorkspace,
} from "../../dist/git-workspace.js";

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
            async compareAndSet(expected, next) {
                const actual = cell.row
                    ? { epoch: cell.row.epoch, generation: cell.row.generation }
                    : null;
                if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
                cell.row = { ...next };
                return true;
            },
        },
        values,
        cell,
    };
}

function findArtifactKey(durable, epoch, kind) {
    return [...durable.values.keys()].find(
        (key) => key.startsWith(`epoch-${epoch}/`) && key.endsWith(`/${kind}`),
    );
}

const hydratedVersions = new WeakMap();

async function hydrateGitWorkspace(options) {
    const result = await hydrateWorkspace(options);
    hydratedVersions.set(options.state, {
        epoch: result.epoch,
        generation: result.generation,
    });
    return result;
}

async function dehydrateGitWorkspace(options) {
    const expectedState = options.expectedState ?? hydratedVersions.get(options.state);
    assert.ok(expectedState, "dehydrate requires a version returned by hydrate");
    const result = await dehydrateWorkspace({ ...options, expectedState });
    hydratedVersions.set(options.state, {
        epoch: result.epoch,
        generation: result.generation,
    });
    return result;
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
        fs.writeFileSync(path.join(first, "résumé-雪.txt"), "unicode\n");
        fs.writeFileSync(path.join(first, "..env"), "valid filename\n");
        fs.writeFileSync(path.join(first, "staged.txt"), "staged\n");
        git(first, ["add", "staged.txt"]);
        fs.writeFileSync(path.join(first, ".gitignore"), "ignored.txt\n");
        fs.writeFileSync(path.join(first, "ignored.txt"), "force-added\n");
        git(first, ["add", "-f", "ignored.txt"]);
        assert.deepEqual(
            git(first, ["diff", "--cached", "--name-only"]).split("\n").sort(),
            ["ignored.txt", "staged.txt"],
        );
        await dehydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
        });
        assert.equal(
            git(first, ["diff", "--cached", "--name-only"]).split("\n").sort().join("\n"),
            "ignored.txt\nstaged.txt",
            "checkpointing does not rewrite the caller's index",
        );

        const second = cloneWorker(originDir, root, "worker-b");
        assert.equal((await hydrateGitWorkspace({
            enlistmentDir: second,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        })).mode, "replayed");
        assert.equal(fs.readFileSync(path.join(second, "README.md"), "utf8"), "line1\nline2\n");
        assert.equal(fs.readFileSync(path.join(second, "notes.txt"), "utf8"), "scratch\n");
        assert.equal(fs.readFileSync(path.join(second, "résumé-雪.txt"), "utf8"), "unicode\n");
        assert.equal(fs.readFileSync(path.join(second, "..env"), "utf8"), "valid filename\n");
        assert.equal(fs.readFileSync(path.join(second, "staged.txt"), "utf8"), "staged\n");
        assert.equal(fs.readFileSync(path.join(second, "ignored.txt"), "utf8"), "force-added\n");
        assert.equal(
            git(second, ["diff", "--cached", "--name-only"]),
            "",
            "restored uncommitted changes are consistently unstaged",
        );
        await dehydrateGitWorkspace({
            enlistmentDir: second,
            blobs: durable.blobs,
            state: durable.state,
        });
        const third = cloneWorker(originDir, root, "worker-c");
        await hydrateGitWorkspace({
            enlistmentDir: third,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        assert.equal(
            fs.readFileSync(path.join(third, "ignored.txt"), "utf8"),
            "force-added\n",
            "a previously durable ignored file survives later checkpoints",
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("initial hydration removes stale ignored and untracked output", async () => {
    const { root, originDir } = makeWorld("initial-clean");
    try {
        const durable = makeDurable();
        const worker = cloneWorker(originDir, root, "worker");
        fs.appendFileSync(path.join(worker, ".git", "info", "exclude"), "\ncache.tmp\n");
        fs.writeFileSync(path.join(worker, "cache.tmp"), "ignored\n");
        fs.writeFileSync(path.join(worker, "loose.tmp"), "untracked\n");

        await hydrateGitWorkspace({
            enlistmentDir: path.relative(process.cwd(), worker),
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        assert.equal(fs.existsSync(path.join(worker, "cache.tmp")), false);
        assert.equal(fs.existsSync(path.join(worker, "loose.tmp")), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("qualified local branches preserve slash-containing branch names", async () => {
    const { root, originDir } = makeWorld("branch-name");
    try {
        const durable = makeDurable();
        const worker = cloneWorker(originDir, root, "worker");
        git(worker, ["branch", "feature/nested", "origin/main"]);
        const hydrated = await hydrateGitWorkspace({
            enlistmentDir: worker,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "refs/heads/feature/nested",
        });
        assert.equal(hydrated.mode, "pinned-base");
        assert.equal(git(worker, ["rev-parse", "--abbrev-ref", "HEAD"]), "feature/nested");
        assert.equal(durable.cell.row.branch, "feature/nested");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("workspace capture rejects paths beneath a symlink ancestor", async ({ skip }) => {
    const { root, originDir } = makeWorld("capture-symlink");
    try {
        const durable = makeDurable();
        const worker = cloneWorker(originDir, root, "worker");
        await hydrateGitWorkspace({
            enlistmentDir: worker,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        const nested = path.join(worker, "tracked");
        fs.mkdirSync(nested);
        fs.writeFileSync(path.join(nested, "file.txt"), "inside\n");
        git(worker, ["add", "tracked/file.txt"]);
        git(worker, ["commit", "-m", "add nested file"]);

        const outside = path.join(root, "outside");
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, "file.txt"), "outside secret\n");
        fs.rmSync(nested, { recursive: true, force: true });
        try {
            fs.symlinkSync(
                outside,
                nested,
                process.platform === "win32" ? "junction" : "dir",
            );
        } catch (error) {
            if (error?.code === "EPERM" || error?.code === "EACCES") {
                skip();
                return;
            }
            throw error;
        }

        await assert.rejects(dehydrateGitWorkspace({
            enlistmentDir: worker,
            blobs: durable.blobs,
            state: durable.state,
        }), /symbolic path ancestor is not allowed/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("clean and smudge filters preserve actual working-tree bytes", async () => {
    const { root, originDir } = makeWorld("filters");
    try {
        const author = cloneWorker(originDir, root, "filter-author");
        const filterScript = [
            "const mode = process.argv[2];",
            "const chunks = [];",
            "process.stdin.on('data', (chunk) => chunks.push(chunk));",
            "process.stdin.on('end', () => {",
            "  const input = Buffer.concat(chunks).toString('utf8');",
            "  const output = mode === 'clean'",
            "    ? input.replaceAll('worktree-', 'clean-')",
            "    : input.replaceAll('clean-', 'worktree-');",
            "  process.stdout.write(output);",
            "});",
        ].join("\n");
        fs.writeFileSync(path.join(author, "filter.js"), filterScript);
        fs.writeFileSync(path.join(author, ".gitattributes"), "filtered.txt filter=demo\n");
        fs.writeFileSync(path.join(author, "filtered.txt"), "worktree-one\n");
        const authorFilter = path.join(author, "filter.js").replaceAll("\\", "/");
        git(author, ["config", "filter.demo.clean", `node "${authorFilter}" clean`]);
        git(author, ["config", "filter.demo.smudge", `node "${authorFilter}" smudge`]);
        git(author, ["add", ".gitattributes", "filter.js", "filtered.txt"]);
        git(author, ["commit", "-m", "add filtered file"]);
        git(author, ["push", "origin", "main"]);
        assert.equal(git(author, ["show", "HEAD:filtered.txt"]), "clean-one");

        const configureFilter = (dir) => {
            const script = path.join(dir, "filter.js").replaceAll("\\", "/");
            git(dir, ["config", "filter.demo.clean", `node "${script}" clean`]);
            git(dir, ["config", "filter.demo.smudge", `node "${script}" smudge`]);
            fs.rmSync(path.join(dir, "filtered.txt"), { force: true });
            git(dir, ["checkout", "HEAD", "--", "filtered.txt"]);
        };

        const durable = makeDurable();
        const first = cloneWorker(originDir, root, "worker-a");
        configureFilter(first);
        await hydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        assert.equal(fs.readFileSync(path.join(first, "filtered.txt"), "utf8"), "worktree-one\n");
        fs.writeFileSync(path.join(first, "filtered.txt"), "worktree-two\n");
        await dehydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
        });
        fs.appendFileSync(path.join(first, ".git", "info", "exclude"), "\ncache.tmp\n");
        fs.writeFileSync(path.join(first, "cache.tmp"), "stale ignored output\n");
        await hydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        assert.equal(
            fs.existsSync(path.join(first, "cache.tmp")),
            false,
            "hydration removes ignored output that is not part of the durable workspace",
        );

        const second = cloneWorker(originDir, root, "worker-b");
        configureFilter(second);
        await hydrateGitWorkspace({
            enlistmentDir: second,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        assert.equal(fs.readFileSync(path.join(second, "filtered.txt"), "utf8"), "worktree-two\n");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("large untracked sets checkpoint without command-line path expansion", async () => {
    const { root, originDir } = makeWorld("many-untracked");
    try {
        const durable = makeDurable();
        const first = cloneWorker(originDir, root, "worker-a");
        await hydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        const bulk = path.join(first, "bulk");
        fs.mkdirSync(bulk);
        for (let index = 0; index < 400; index++) {
            const name = `${String(index).padStart(4, "0")}-${"x".repeat(80)}.txt`;
            fs.writeFileSync(path.join(bulk, name), `${index}\n`);
        }
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
        assert.equal(fs.readdirSync(path.join(second, "bulk")).length, 400);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("rehydrating a reused workspace replaces its prior untracked files", async () => {
    const { root, originDir } = makeWorld("reused");
    try {
        const durable = makeDurable();
        const worker = cloneWorker(originDir, root, "worker");
        await hydrateGitWorkspace({
            enlistmentDir: worker,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        fs.appendFileSync(path.join(worker, "README.md"), "pending\n");
        fs.writeFileSync(path.join(worker, "notes.txt"), "scratch\n");
        await dehydrateGitWorkspace({
            enlistmentDir: worker,
            blobs: durable.blobs,
            state: durable.state,
        });

        const restored = await hydrateGitWorkspace({
            enlistmentDir: worker,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        assert.equal(restored.mode, "replayed");
        assert.equal(fs.readFileSync(path.join(worker, "README.md"), "utf8"), "line1\npending\n");
        assert.equal(fs.readFileSync(path.join(worker, "notes.txt"), "utf8"), "scratch\n");
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

test("a failed later checkpoint preserves the previous committed workspace", async () => {
    const { root, originDir } = makeWorld("previous-generation");
    try {
        const durable = makeDurable();
        const first = cloneWorker(originDir, root, "worker-a");
        await hydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        fs.writeFileSync(path.join(first, "checkpoint-one.txt"), "committed\n");
        await dehydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
        });
        assert.equal(durable.cell.row.epoch, 1);

        fs.writeFileSync(path.join(first, "checkpoint-two.txt"), "uncommitted\n");
        const commitError = new Error("state commit failed");
        await assert.rejects(dehydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            expectedState: {
                epoch: durable.cell.row.epoch,
                generation: durable.cell.row.generation,
            },
            state: {
                get: () => durable.state.get(),
                async compareAndSet(expected, next) {
                    if (next.epoch === 2) throw commitError;
                    return durable.state.compareAndSet(expected, next);
                },
            },
        }), (error) => error === commitError);
        assert.equal(durable.cell.row.epoch, 1);
        assert.equal(
            durable.values.has(
                gitWorkspaceBlobKey(1, durable.cell.row.generation, "meta"),
            ),
            true,
        );
        assert.ok(findArtifactKey(durable, 2, "meta"));

        const second = cloneWorker(originDir, root, "worker-b");
        assert.equal((await hydrateGitWorkspace({
            enlistmentDir: second,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        })).mode, "replayed");
        assert.equal(
            fs.readFileSync(path.join(second, "checkpoint-one.txt"), "utf8"),
            "committed\n",
        );
        assert.equal(fs.existsSync(path.join(second, "checkpoint-two.txt")), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("concurrent dehydrations publish one complete generation without mixing artifacts", async () => {
    const { root, originDir } = makeWorld("concurrent");
    try {
        const durable = makeDurable();
        const first = cloneWorker(originDir, root, "worker-a");
        await hydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        const second = cloneWorker(originDir, root, "worker-b");
        await hydrateGitWorkspace({
            enlistmentDir: second,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });

        fs.writeFileSync(path.join(first, "winner-a.txt"), "a\n");
        fs.writeFileSync(path.join(second, "winner-b.txt"), "b\n");
        const results = await Promise.allSettled([
            dehydrateGitWorkspace({
                enlistmentDir: first,
                blobs: durable.blobs,
                state: durable.state,
            }),
            dehydrateGitWorkspace({
                enlistmentDir: second,
                blobs: durable.blobs,
                state: durable.state,
            }),
        ]);
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(results.filter((result) => result.status === "rejected").length, 1);
        assert.equal(durable.cell.row.epoch, 1);

        const restored = cloneWorker(originDir, root, "worker-restored");
        await hydrateGitWorkspace({
            enlistmentDir: restored,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        const hasA = fs.existsSync(path.join(restored, "winner-a.txt"));
        const hasB = fs.existsSync(path.join(restored, "winner-b.txt"));
        assert.notEqual(hasA, hasB);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a stale hydrated workspace cannot overwrite a newer checkpoint", async () => {
    const { root, originDir } = makeWorld("stale");
    try {
        const durable = makeDurable();
        const first = cloneWorker(originDir, root, "worker-a");
        const firstVersion = await hydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        const second = cloneWorker(originDir, root, "worker-b");
        const secondVersion = await hydrateGitWorkspace({
            enlistmentDir: second,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });

        fs.writeFileSync(path.join(first, "newer.txt"), "newer\n");
        await dehydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
            expectedState: firstVersion,
        });
        fs.writeFileSync(path.join(second, "stale.txt"), "stale\n");
        await assert.rejects(dehydrateGitWorkspace({
            enlistmentDir: second,
            blobs: durable.blobs,
            state: durable.state,
            expectedState: secondVersion,
        }), /advanced since this workspace was hydrated/);
        assert.equal(durable.cell.row.epoch, 1);

        const restored = cloneWorker(originDir, root, "worker-restored");
        await hydrateGitWorkspace({
            enlistmentDir: restored,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        assert.equal(fs.readFileSync(path.join(restored, "newer.txt"), "utf8"), "newer\n");
        assert.equal(fs.existsSync(path.join(restored, "stale.txt")), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("hydration fails closed when a committed generation is incomplete", async () => {
    const { root, originDir } = makeWorld("incomplete");
    try {
        const durable = makeDurable();
        const first = cloneWorker(originDir, root, "worker-a");
        await hydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        fs.writeFileSync(path.join(first, "required.txt"), "required\n");
        await dehydrateGitWorkspace({
            enlistmentDir: first,
            blobs: durable.blobs,
            state: durable.state,
        });

        const workspaceKey = gitWorkspaceBlobKey(
            durable.cell.row.epoch,
            durable.cell.row.generation,
            "workspace",
        );
        const workspace = durable.values.get(workspaceKey);
        durable.values.delete(workspaceKey);
        const withoutWorkspace = cloneWorker(originDir, root, "worker-without-workspace");
        await assert.rejects(hydrateGitWorkspace({
            enlistmentDir: withoutWorkspace,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        }), /missing its workspace archive/);

        durable.values.set(workspaceKey, workspace);
        const tamperedWorkspace = Buffer.from(workspace);
        tamperedWorkspace[tamperedWorkspace.length - 2] ^= 1;
        durable.values.set(workspaceKey, tamperedWorkspace);
        const withCorruptWorkspace = cloneWorker(originDir, root, "worker-corrupt-workspace");
        await assert.rejects(hydrateGitWorkspace({
            enlistmentDir: withCorruptWorkspace,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        }), /failed integrity validation/);

        durable.values.set(workspaceKey, workspace);
        const metaKey = gitWorkspaceBlobKey(
            durable.cell.row.epoch,
            durable.cell.row.generation,
            "meta",
        );
        const meta = JSON.parse(durable.values.get(metaKey).toString("utf8"));
        delete meta.hasWorkspace;
        durable.values.set(metaKey, Buffer.from(JSON.stringify(meta), "utf8"));
        const withMalformedMeta = cloneWorker(originDir, root, "worker-malformed-meta");
        await assert.rejects(hydrateGitWorkspace({
            enlistmentDir: withMalformedMeta,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        }), /invalid metadata/);

        durable.values.delete(metaKey);
        const withoutMeta = cloneWorker(originDir, root, "worker-without-meta");
        await assert.rejects(hydrateGitWorkspace({
            enlistmentDir: withoutMeta,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        }), /missing metadata/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("dehydration rejects a HEAD that does not descend from the pinned base", async () => {
    const { root, originDir } = makeWorld("divergent");
    try {
        const durable = makeDurable();
        const worker = cloneWorker(originDir, root, "worker");
        await hydrateGitWorkspace({
            enlistmentDir: worker,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        git(worker, ["checkout", "--orphan", "divergent"]);
        git(worker, ["rm", "-rf", "."]);
        fs.writeFileSync(path.join(worker, "divergent.txt"), "divergent\n");
        git(worker, ["add", "divergent.txt"]);
        git(worker, ["commit", "-m", "divergent"]);

        await assert.rejects(dehydrateGitWorkspace({
            enlistmentDir: worker,
            blobs: durable.blobs,
            state: durable.state,
        }), /does not descend from pinned base/);
        assert.equal(durable.cell.row.epoch, 0);
        assert.equal(findArtifactKey(durable, 1, "meta"), undefined);
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
            expectedState: {
                epoch: durable.cell.row.epoch,
                generation: durable.cell.row.generation,
            },
            state: {
                get: () => durable.state.get(),
                async compareAndSet(expected, next) {
                    if (next.epoch > 0) throw commitError;
                    return durable.state.compareAndSet(expected, next);
                },
            },
        }), (error) => error === commitError);
        assert.equal(durable.cell.row.epoch, 0);
        const partialMetaKey = findArtifactKey(durable, 1, "meta");
        assert.ok(partialMetaKey);
        assert.equal(
            JSON.parse(
                durable.values.get(partialMetaKey).toString("utf8"),
            ).epoch,
            1,
        );

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
                    if (kind.endsWith("/meta")) throw writeError;
                    await durable.blobs.put(kind, data);
                },
            },
            state: durable.state,
        }), (error) => error === writeError);
        assert.equal(durable.cell.row.epoch, 0);
        assert.equal(findArtifactKey(durable, 1, "meta"), undefined);
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
