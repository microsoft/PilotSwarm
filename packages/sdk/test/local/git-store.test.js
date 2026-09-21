import { afterAll, beforeAll, test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    GitStore,
    Runner,
    makeRunGit,
    normalizeRef,
    resolveTargetRef,
} from "../../dist/git-store.js";

const IDENTITY = [
    "-c", "user.name=Test",
    "-c", "user.email=test@example.com",
    "-c", "commit.gpgsign=false",
];
const runGit = makeRunGit();
let root;
let originDir;
let authorDir;
let storeDir;

function authorCommit(file, contents) {
    fs.writeFileSync(path.join(authorDir, file), contents);
    execFileSync("git", [...IDENTITY, "-C", authorDir, "add", file], { stdio: "pipe" });
    execFileSync("git", [...IDENTITY, "-C", authorDir, "commit", "-m", `add ${file}`], {
        stdio: "pipe",
    });
    execFileSync("git", ["-C", authorDir, "push", "-q", "origin", "main"], {
        stdio: "pipe",
    });
    return execFileSync("git", ["-C", authorDir, "rev-parse", "HEAD"], {
        encoding: "utf8",
    }).trim();
}

function fakeRunGit(script) {
    const run = (cwd, args) => {
        run.calls.push({ cwd, args });
        const key = args.join(" ");
        if (!(key in script)) throw new Error(`unexpected git: ${key}`);
        const value = script[key];
        if (value instanceof Error) throw value;
        return value;
    };
    run.calls = [];
    return run;
}

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "git-store-test-"));
    originDir = path.join(root, "origin.git");
    authorDir = path.join(root, "author");
    storeDir = path.join(root, "store");

    execFileSync("git", ["init", "--bare", "-b", "main", originDir], { stdio: "pipe" });
    execFileSync("git", ["clone", "-q", originDir, authorDir], { stdio: "pipe" });
    authorCommit("A.txt", "A");
    execFileSync("git", ["clone", "-q", originDir, storeDir], { stdio: "pipe" });
});

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

test("normalizeRef maps branches and preserves qualified refs and SHAs", () => {
    assert.equal(normalizeRef("main"), "origin/main");
    assert.equal(normalizeRef("dev/x/y"), "origin/dev/x/y");
    assert.equal(normalizeRef("origin/main"), "origin/main");
    assert.equal(normalizeRef("refs/heads/main"), "refs/heads/main");
    assert.equal(normalizeRef("0123abcd"), "0123abcd");
});

test("normalizeRef rejects option-like and revision-expression inputs", () => {
    for (const ref of [
        "--upload-pack=malicious",
        "refs/heads/main^{commit}",
        "refs/heads/main..other",
        "refs/heads/main:evil",
        "refs/heads/main@{1}",
        "refs/heads/main\\evil",
    ]) {
        assert.throws(() => normalizeRef(ref), /invalid git ref/i);
    }
});

test("resolveTargetRef honors session and environment precedence without git calls", () => {
    const runner = fakeRunGit({});
    assert.equal(
        resolveTargetRef("feature/x", { dir: "/repo", runGit: runner, envRef: "release" }),
        "origin/feature/x",
    );
    assert.equal(
        resolveTargetRef(undefined, { dir: "/repo", runGit: runner, envRef: "release" }),
        "origin/release",
    );
    assert.equal(runner.calls.length, 0);
});

test("resolveTargetRef uses origin HEAD then conventional defaults", () => {
    const fromHead = fakeRunGit({
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
    });
    assert.equal(resolveTargetRef(undefined, { dir: "/repo", runGit: fromHead }), "origin/main");

    const noHead = new Error("no HEAD");
    const fromMaster = fakeRunGit({
        "symbolic-ref --short refs/remotes/origin/HEAD": noHead,
        "rev-parse --verify origin/main": new Error("no main"),
        "rev-parse --verify origin/master": "ok",
    });
    assert.equal(
        resolveTargetRef(undefined, { dir: "/repo", runGit: fromMaster }),
        "origin/master",
    );
});

test("GitStore detects local commits and narrow-fetches a missing ref", () => {
    const store = new GitStore({ dir: storeDir, runGit });
    const initial = store.revParse("origin/main");
    assert.equal(store.hasCommit(initial), true);

    const advanced = authorCommit("B.txt", "B");
    assert.equal(store.hasCommit(advanced), false);
    assert.equal(store.ensureObjects({ ref: "main" }), advanced);
    assert.equal(store.hasCommit(advanced), true);
});

test("ensureObjects does not fetch an already-local SHA", () => {
    const store = new GitStore({ dir: storeDir, runGit });
    const sha = store.revParse("origin/main");
    const saved = runGit(storeDir, ["remote", "get-url", "origin"]);
    runGit(storeDir, ["remote", "set-url", "origin", path.join(root, "missing.git")]);
    try {
        assert.equal(store.ensureObjects({ sha }), sha);
    } finally {
        runGit(storeDir, ["remote", "set-url", "origin", saved]);
    }
});

test("Runner checks out a detached pinned commit", () => {
    const store = new GitStore({ dir: storeDir, runGit });
    const runner = new Runner({ dir: storeDir, runGit });
    const sha = store.revParse("origin/main");
    runner.checkout(sha);
    assert.equal(runner.head(), sha);
    assert.equal(runGit(storeDir, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
});

test("worktree, keepalive, and additive refresh preserve a pinned tree", () => {
    const store = new GitStore({ dir: storeDir, runGit });
    const pinned = store.revParse("origin/main");
    const worktreeDir = path.join(root, "worktree");
    store.addWorktree(worktreeDir, pinned);
    store.keep("session-1", pinned);
    assert.equal(store.revParse("refs/pilotswarm/keep/session-1"), pinned);

    const advanced = authorCommit("C.txt", "C");
    store.tick();
    assert.equal(store.hasCommit(advanced), true);
    assert.equal(runGit(worktreeDir, ["rev-parse", "HEAD"]), pinned);
    assert.equal(fs.existsSync(path.join(worktreeDir, "C.txt")), false);

    store.unkeep("session-1");
    assert.equal(store.hasCommit("refs/pilotswarm/keep/session-1"), false);
});
