import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRepoService } from "../../examples/repo-workspaces/repo-service.mjs";
import { createGitFixture, git } from "../helpers/git-fixture.mjs";

const cleanups = [];
afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups.length = 0;
});

async function fixtureAndService(extra = {}) {
    const fixture = await createGitFixture();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-repo-head-")));
    const service = createRepoService({
        root,
        publicUrl: "http://repo-service.invalid",
        repos: { app: { upstream: fixture.remote, sandbox: true } },
        runGit: (args) => git(args),
        ...extra,
    });
    cleanups.push(() => service.close());
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    cleanups.push(() => fixture.cleanup());
    return {
        fixture,
        root,
        service,
        mirror: path.join(root, "repos", "app.git"),
        sandbox: path.join(root, "remotes", "app.git"),
    };
}

async function assertHeads(repo, expected = "refs/heads/main") {
    assert.equal(await git(["-C", repo, "symbolic-ref", "HEAD"]), expected);
    assert.ok(await git(["-C", repo, "show-ref", "--verify", "--hash", expected]));
}

describe("repo service: default branch HEAD", () => {
    it("repairs stale mirror and existing sandbox HEADs during prepare and refresh", async () => {
        const fx = await fixtureAndService();
        await fx.service.prepare();

        for (const repo of [fx.mirror, fx.sandbox]) {
            await git(["-C", repo, "symbolic-ref", "HEAD", "refs/heads/master"]);
            await git(["-C", repo, "update-ref", "-d", "refs/heads/main"]);
        }
        await fx.service.prepare();
        await assertHeads(fx.mirror);
        await assertHeads(fx.sandbox);

        for (const repo of [fx.mirror, fx.sandbox]) {
            await git(["-C", repo, "symbolic-ref", "HEAD", "refs/heads/master"]);
        }
        await fx.service.refresh();
        await assertHeads(fx.mirror);
        await assertHeads(fx.sandbox);
    });

    it("fails prepare when the upstream default branch cannot be discovered", async () => {
        const fx = await fixtureAndService();
        await fx.service.prepare();
        const failed = createRepoService({
            root: fx.root,
            publicUrl: "http://repo-service.invalid",
            repos: { app: { upstream: fx.fixture.remote, sandbox: true } },
            runGit: (args) => args.includes("ls-remote")
                ? Promise.reject(new Error("default branch lookup failed"))
                : git(args),
        });
        cleanups.push(() => failed.close());

        await assert.rejects(failed.prepare(), /default branch lookup failed/);
    });
});
