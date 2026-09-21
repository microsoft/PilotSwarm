import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, test } from "vitest";

import { StickyRepositoryWorkspace } from "../../dist/repository-worker.js";

const ID = [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
];
const temporaryDirectories = [];

function git(directory, args) {
    return execFileSync("git", ["-C", directory, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

function createOrigin() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "repository-worker-test-"));
    temporaryDirectories.push(root);
    const origin = path.join(root, "origin.git");
    const author = path.join(root, "author");
    execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
    execFileSync("git", ["clone", "-q", origin, author], { stdio: "pipe" });
    fs.writeFileSync(path.join(author, "README.md"), "seed\n", "utf8");
    execFileSync("git", [...ID, "-C", author, "add", "README.md"], { stdio: "pipe" });
    execFileSync("git", [...ID, "-C", author, "commit", "-m", "seed"], { stdio: "pipe" });
    execFileSync("git", ["-C", author, "push", "-q", "origin", "main"], { stdio: "pipe" });
    return {
        root,
        origin,
        workspace: path.join(root, "workspace"),
        head: git(author, ["rev-parse", "HEAD"]),
    };
}

function persistedState(workspace) {
    return JSON.parse(
        fs.readFileSync(
            path.join(workspace, ".git", "pilotswarm-repository-worker.json"),
            "utf8",
        ),
    );
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        try {
            fs.rmSync(directory, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup on Windows, where Git may briefly retain file handles.
        }
    }
});

test("initializes a detached persistent checkout at the configured ref", async () => {
    const fixture = createOrigin();
    const workspace = new StickyRepositoryWorkspace({
        repositoryUrl: fixture.origin,
        directory: fixture.workspace,
        targetRef: "main",
    });

    const status = await workspace.initialize();

    assert.equal(status.created, true);
    assert.equal(status.headSha, fixture.head);
    assert.equal(status.sessionId, null);
    assert.equal(git(fixture.workspace, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
    assert.equal(
        fs.readFileSync(path.join(fixture.workspace, "README.md"), "utf8").trim(),
        "seed",
    );
    const state = persistedState(fixture.workspace);
    assert.equal(state.version, 1);
    assert.equal(state.targetRef, "main");
    assert.equal(state.sessionId, null);
    assert.match(state.repositoryFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(state).includes(fixture.origin), false);
});

test("preserves local work and the sticky session claim across restart", async () => {
    const fixture = createOrigin();
    const first = new StickyRepositoryWorkspace({
        repositoryUrl: fixture.origin,
        directory: fixture.workspace,
    });
    await first.acquire("session-a");
    fs.writeFileSync(path.join(fixture.workspace, "local.txt"), "uncommitted\n", "utf8");

    const restarted = new StickyRepositoryWorkspace({
        repositoryUrl: fixture.origin,
        directory: fixture.workspace,
    });
    const status = await restarted.acquire("session-a");

    assert.equal(status.created, false);
    assert.equal(status.sessionId, "session-a");
    assert.equal(fs.readFileSync(path.join(fixture.workspace, "local.txt"), "utf8"), "uncommitted\n");
    assert.equal(persistedState(fixture.workspace).sessionId, "session-a");
});

test("rejects a different session without changing the checkout", async () => {
    const fixture = createOrigin();
    const workspace = new StickyRepositoryWorkspace({
        repositoryUrl: fixture.origin,
        directory: fixture.workspace,
    });
    await workspace.acquire("session-a");
    fs.writeFileSync(path.join(fixture.workspace, "local.txt"), "keep\n", "utf8");

    await assert.rejects(
        workspace.acquire("session-b"),
        /already claimed by session session-a/,
    );

    assert.equal(fs.readFileSync(path.join(fixture.workspace, "local.txt"), "utf8"), "keep\n");
    assert.equal(persistedState(fixture.workspace).sessionId, "session-a");
});

test("serializes competing first claims so only one session wins", async () => {
    const fixture = createOrigin();
    const workspace = new StickyRepositoryWorkspace({
        repositoryUrl: fixture.origin,
        directory: fixture.workspace,
    });

    const results = await Promise.allSettled([
        workspace.acquire("session-a"),
        workspace.acquire("session-b"),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const winner = persistedState(fixture.workspace).sessionId;
    assert.ok(winner === "session-a" || winner === "session-b");
});

test("refuses to adopt unmanaged or differently configured workspaces", async () => {
    const fixture = createOrigin();
    fs.mkdirSync(fixture.workspace);
    await assert.rejects(
        new StickyRepositoryWorkspace({
            repositoryUrl: fixture.origin,
            directory: fixture.workspace,
        }).initialize(),
        /not a managed Git checkout/,
    );

    fs.rmSync(fixture.workspace, { recursive: true, force: true });
    await new StickyRepositoryWorkspace({
        repositoryUrl: fixture.origin,
        directory: fixture.workspace,
        targetRef: "main",
    }).initialize();
    await assert.rejects(
        new StickyRepositoryWorkspace({
            repositoryUrl: fixture.origin,
            directory: fixture.workspace,
            targetRef: "origin/main",
        }).initialize(),
        /configuration does not match/,
    );
});

test("exposes a lifecycle hook that claims the workspace before a turn", async () => {
    const fixture = createOrigin();
    const traces = [];
    const workspace = new StickyRepositoryWorkspace({
        repositoryUrl: fixture.origin,
        directory: fixture.workspace,
    });

    await workspace.beforeTurn({
        sessionId: "session-a",
        config: { provider: "copilot" },
        trace: (message) => traces.push(message),
    });

    assert.equal(persistedState(fixture.workspace).sessionId, "session-a");
    assert.match(traces[0], /workspace ready session=session-a/);
});

test("rejects a session configured for a different working directory", async () => {
    const fixture = createOrigin();
    const workspace = new StickyRepositoryWorkspace({
        repositoryUrl: fixture.origin,
        directory: fixture.workspace,
    });

    await assert.rejects(
        workspace.beforeTurn({
            sessionId: "session-a",
            config: { workingDirectory: path.join(fixture.root, "other") },
            trace: () => {},
        }),
        /sticky repository workers require/,
    );

    assert.equal(fs.existsSync(fixture.workspace), false);
});

test("rejects credential-bearing HTTP repository URLs", () => {
    assert.throws(
        () => new StickyRepositoryWorkspace({
            repositoryUrl: "https://secret@example.invalid/repository.git",
            directory: path.join(os.tmpdir(), "unused-repository-worker"),
        }),
        /must not contain credentials/,
    );
});

test("entrypoint rejects unsafe concurrency before startup", () => {
    const result = spawnSync(
        process.execPath,
        [path.resolve("examples", "repository-worker.js")],
        {
            encoding: "utf8",
            env: {
                ...process.env,
                PILOTSWARM_WORKER_CONCURRENCY: "2",
            },
        },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /require PILOTSWARM_WORKER_CONCURRENCY=1/);
});
