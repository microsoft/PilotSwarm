/**
 * Idle cleanup in the reference repo service and provider
 * (examples/repo-workspaces/, docs/proposals/session-workspaces.md 5.3),
 * against a real git fixture. No worker: the service and the provider are
 * called directly, with a clock the tests move.
 *
 *   I1  a clone records when a session last used it
 *   I2  the idle pass removes only clones no session used for the idle time,
 *       and never one with a live lease entry
 *   I3  a removal leaves a record and a log line: when, why, the last branch
 *       and commit, and what no remote had
 *   I4  restore makes a fresh clone; each session that used the old one is
 *       told once, a retry of the same turn again, a check never
 *   I5  only idle removals come back by themselves
 *   I6  one operation per clone at a time
 *   I7  the state survives a restart
 *   I8  the provider restores on a turn, not on a check, and passes the note
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGitFixture, git } from "../helpers/git-fixture.mjs";
import {
    DEFAULT_IDLE_CLONE_MS,
    createRepoService,
    idleCheckIntervalMs,
    idleCloneMsFromEnv,
} from "../../examples/repo-workspaces/repo-service.mjs";
import { createRepoWorkspaceProvider, recreatedNotice } from "../../examples/repo-workspaces/provider.mjs";
import { createRepoTools } from "../../examples/repo-workspaces/tools.mjs";

const HOUR = 60 * 60 * 1000;
const IDLE = 6 * HOUR;
const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

async function fixture() {
    const fx = await createGitFixture();
    cleanups.push(() => fx.cleanup());
    return fx;
}

async function serviceFor(fx, extra = {}) {
    let clock = Date.parse("2026-09-28T00:00:00Z");
    const events = [];
    const service = createRepoService({
        root: fx.root,
        rootName: "fx",
        repos: { app: { remote: fx.remote } },
        now: () => clock,
        idleCloneMs: IDLE,
        log: (entry) => events.push(entry),
        runGit: (args) => git(args),
        ...extra,
    });
    const url = await service.listen();
    cleanups.push(() => service.close());
    const call = async (method, pathname, body) => {
        const response = await fetch(new URL(pathname, url), {
            method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };
    const lease = (sessionId, turnIndex, extraBody = {}, checkout = "sessions/tree-a/app") =>
        call("POST", "/v1/leases", { checkout, sessionId, rootSessionId: "tree-a", workerNodeId: "w1", turnIndex, ...extraBody }).then((r) => r.body);
    const release = (sessionId, checkout = "sessions/tree-a/app") =>
        call("DELETE", "/v1/leases", { checkout, sessionId, workerNodeId: "w1" }).then((r) => r.body);
    return {
        service, url, call, lease, release, events,
        advance: (ms) => { clock += ms; },
        now: () => clock,
        iso: (ms = clock) => new Date(ms).toISOString(),
    };
}

/** A clone of tree-a with a session's leftovers: one pushed commit, one unpushed, one untracked file. */
async function cloneWithWork(svc, fx) {
    const made = await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const clone = made.body.path;
    const commit = (message) => git(["-C", clone, "-c", "user.name=agent", "-c", "user.email=agent@example.invalid", "commit", "-q", "--allow-empty", "-m", message]);
    await git(["-C", clone, "switch", "-q", "-c", "agent/fix"]);
    await commit("pushed work");
    await git(["-C", clone, "push", "-q", "-u", "origin", "agent/fix"]);
    await commit("unpushed work");
    fs.writeFileSync(path.join(clone, "notes.txt"), "not committed\n");
    return { made: made.body, clone, head: await git(["-C", clone, "rev-parse", "HEAD"]) };
}

describe("repo service: idle cleanup", () => {
    it("I1: a clone records when a session last used it: made, a lease taken, a lease released", async () => {
        const fx = await fixture();
        const svc = await serviceFor(fx);
        const t0 = svc.now();
        const made = await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        assert.equal(made.body.removedAfterIdleHours, 6, "the answer says after how long an unused clone goes");
        const listed = async () => (await svc.call("GET", "/v1/clones?rootSessionId=tree-a")).body;
        let clone = (await listed()).clones[0];
        assert.equal(clone.lastUsedAt, svc.iso(t0));
        assert.equal(clone.inUse, false);
        assert.equal(clone.removeAfter, svc.iso(t0 + IDLE));

        svc.advance(HOUR);
        assert.equal((await svc.lease("s1", 1)).ok, true);
        clone = (await listed()).clones[0];
        assert.equal(clone.lastUsedAt, svc.iso(t0 + HOUR), "a lease taken is a use");
        assert.equal(clone.inUse, true);
        assert.equal(clone.removeAfter, undefined, "a clone in use has no removal time");

        svc.advance(2 * HOUR);
        assert.equal((await svc.release("s1")).deleted, true);
        clone = (await listed()).clones[0];
        assert.equal(clone.lastUsedAt, svc.iso(t0 + 3 * HOUR), "a release is a use: the idle time counts from when the session left");
        assert.equal(clone.removeAfter, svc.iso(t0 + 3 * HOUR + IDLE));
        assert.equal("users" in clone, false, "the session list stays inside the service");
    });

    it("I2: the idle pass removes only clones no session used for the idle time, and never one with a live entry", async () => {
        const fx = await fixture();
        // Entries live longer than the idle time here, so a live entry and an
        // idle clone can meet.
        const svc = await serviceFor(fx, { entryTtlMs: 3 * IDLE });
        await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        await svc.call("POST", "/v1/clones", { rootSessionId: "tree-b", repo: "app" });
        await svc.call("POST", "/v1/clones", { rootSessionId: "tree-c", repo: "app" });
        assert.equal((await svc.lease("c1", 1, { rootSessionId: "tree-c" }, "sessions/tree-c/app")).ok, true, "tree-c holds a live entry");

        svc.advance(IDLE - 1);
        assert.deepEqual(await svc.service.removeIdleClones(), [], "nothing before the idle time");
        await svc.lease("b1", 1, { rootSessionId: "tree-b" }, "sessions/tree-b/app");
        await svc.release("b1", "sessions/tree-b/app");

        svc.advance(1);
        const removed = await svc.service.removeIdleClones();
        assert.deepEqual(removed.map((r) => r.checkout), ["sessions/tree-a/app"], "only the unused clone goes");
        assert.equal(fs.existsSync(path.join(fx.root, "sessions/tree-a")), false, "with its tree folder");
        assert.ok(fs.existsSync(path.join(fx.root, "sessions/tree-b/app")), "a clone used since stays");
        assert.ok(fs.existsSync(path.join(fx.root, "sessions/tree-c/app")), "a clone with a live entry stays, however old its last use");
        assert.equal(svc.events.filter((e) => e.event === "clone.remove_failed").length, 0, "skipping a live clone is no failure");
    });

    it("I3: a removal leaves a record and a log line: when, why, the last branch and commit, and what no remote had", async () => {
        const fx = await fixture();
        const svc = await serviceFor(fx);
        const { head } = await cloneWithWork(svc, fx);
        await svc.lease("s1", 1);
        await svc.release("s1");
        const lastUse = svc.now();
        svc.advance(IDLE + HOUR);
        const [removed] = await svc.service.removeIdleClones();

        const expected = {
            checkout: "sessions/tree-a/app",
            rootSessionId: "tree-a",
            repo: "app",
            reason: "idle",
            idleHours: 7,
            branch: "agent/fix",
            head,
            dirty: true,
            unpushedCommits: 1,
            workspace: { root: "fx", folder: "sessions/tree-a/app" },
            removedAt: svc.iso(),
            lastUsedAt: svc.iso(lastUse),
        };
        for (const [key, value] of Object.entries(expected)) assert.deepEqual(removed[key], value, key);
        assert.equal("users" in removed, false);

        const logged = svc.events.find((e) => e.event === "clone.removed");
        assert.ok(logged, JSON.stringify(svc.events));
        assert.equal(logged.component, "repo-service");
        assert.equal(logged.time, svc.iso());
        for (const [key, value] of Object.entries(expected)) assert.deepEqual(logged[key], value, `log ${key}`);

        const listed = (await svc.call("GET", "/v1/clones?rootSessionId=tree-a")).body;
        assert.deepEqual(listed.clones, []);
        assert.deepEqual(listed.removed.map((r) => [r.checkout, r.reason, r.unpushedCommits]), [["sessions/tree-a/app", "idle", 1]]);
        assert.deepEqual((await svc.call("GET", "/v1/clones?rootSessionId=tree-z")).body.removed, [], "another tree's list is its own");
        assert.equal(await git(["-C", fx.remote, "rev-parse", "--verify", "-q", "refs/heads/agent/fix"]).then(Boolean), true, "the pushed branch outlives the clone");
    });

    it("I4: restore makes a fresh clone; each session that used the old one is told once, a retry of that turn again, a check never", async () => {
        const fx = await fixture();
        const svc = await serviceFor(fx);
        const { clone } = await cloneWithWork(svc, fx);
        for (const id of ["s1", "s2"]) { await svc.lease(id, 1); await svc.release(id); }
        svc.advance(IDLE);
        await svc.service.removeIdleClones();
        assert.equal((await svc.lease("s1", 2)).code, "WORKSPACE_FOLDER_MISSING", "no clone, no lease");

        const restored = await svc.call("POST", "/v1/clones/restore", { rootSessionId: "tree-a", repo: "app", sessionId: "s1" });
        assert.equal(restored.status, 200, JSON.stringify(restored.body));
        assert.equal(restored.body.restored, true);
        assert.equal(fs.existsSync(path.join(clone, "notes.txt")), false, "the old files are gone");
        assert.equal(await git(["-C", clone, "symbolic-ref", "--short", "HEAD"]), "main", "the fresh clone is on the default branch");
        assert.ok(svc.events.some((e) => e.event === "clone.restored" && e.sessionId === "s1"));

        const first = await svc.lease("s1", 2);
        assert.equal(first.ok, true);
        assert.equal(first.recreated?.branch, "agent/fix", JSON.stringify(first));
        assert.equal(first.recreated.reason, "idle");
        assert.equal((await svc.lease("s1", 2)).recreated?.branch, "agent/fix", "a retry of the same turn is told again");
        assert.equal((await svc.lease("s1", 3)).recreated, undefined, "the next turn is not");

        assert.equal((await svc.lease("s2", 7, { purpose: "check" })).recreated, undefined, "a check tells no one");
        assert.equal((await svc.lease("s2", 7)).recreated?.branch, "agent/fix", "the turn after the check is told");
        assert.equal((await svc.lease("s3", 1)).recreated, undefined, "a session that never used the old clone is not told");

        const listed = (await svc.call("GET", "/v1/clones?rootSessionId=tree-a")).body;
        assert.equal(listed.clones[0].previous.branch, "agent/fix", "the list shows what the clone replaced");
        assert.ok(listed.removed[0].recreatedAt, "the removal record says it was made again");
    });

    it("I5: only idle removals come back by themselves; a clone removed on request stays removed until a session makes it", async () => {
        const fx = await fixture();
        const svc = await serviceFor(fx);
        await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        for (const id of ["s1", "s2"]) { await svc.lease(id, 1); await svc.release(id); }
        const deleted = await svc.call("DELETE", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        assert.equal(deleted.body.deleted, true);
        assert.equal(deleted.body.removal.reason, "request");
        assert.ok(svc.events.some((e) => e.event === "clone.removed" && e.reason === "request"), "a removal on request is logged too");

        const refused = await svc.call("POST", "/v1/clones/restore", { rootSessionId: "tree-a", repo: "app", sessionId: "s1" });
        assert.equal(refused.status, 404);
        assert.equal(refused.body.error.code, "NOT_RESTORABLE");
        assert.equal((await svc.call("POST", "/v1/clones/restore", { rootSessionId: "tree-q", repo: "app" })).body.error.code, "NOT_RESTORABLE",
            "nothing to restore for a clone that never was");

        // A session makes it again with the tool: it sees the old removal in
        // the answer; the other session that used the old clone is told.
        const made = await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app", sessionId: "s1" });
        assert.equal(made.body.created, true);
        assert.equal(made.body.previous.reason, "request");
        assert.equal((await svc.lease("s1", 2)).recreated, undefined, "the caller saw it already");
        assert.equal((await svc.lease("s2", 2)).recreated?.reason, "request");
    });

    it("I6: one operation per clone at a time: two restores make one clone; a removal refuses leases and makes until it is done", async () => {
        const fx = await fixture();
        let hold = null;
        let reached = null;
        let holdClone = null;
        let cloneReached = null;
        const reachedStatus = new Promise((resolve) => { reached = resolve; });
        const svc = await serviceFor(fx, {
            runGit: async (args) => {
                // Hold the removal inside its look at the clone.
                if (hold && args.includes("status")) { reached(); await hold; }
                // Hold a restore inside its clone step.
                if (holdClone && args[0] === "clone") { cloneReached?.(); await holdClone; }
                return git(args);
            },
        });
        await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        svc.advance(IDLE);
        await svc.service.removeIdleClones();

        const [a, b] = await Promise.all([
            svc.call("POST", "/v1/clones/restore", { rootSessionId: "tree-a", repo: "app" }),
            svc.call("POST", "/v1/clones/restore", { rootSessionId: "tree-a", repo: "app" }),
        ]);
        assert.deepEqual([a.body.restored, b.body.restored].sort(), [false, true], `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`);
        assert.equal(svc.events.filter((e) => e.event === "clone.restored").length, 1);

        let open;
        hold = new Promise((resolve) => { open = resolve; });
        svc.advance(IDLE);
        const pass = svc.service.removeIdleClones();
        await reachedStatus;
        const refused = await svc.lease("s1", 1);
        assert.equal(refused.ok, false);
        assert.equal(refused.code, "WORKSPACE_ATTACH_FAILED");
        assert.ok(refused.retryAfterMs > 0, "the attach is retried after the removal");
        const busy = await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        assert.equal(busy.status, 409);
        assert.equal(busy.body.error.code, "CLONE_BUSY");
        open();
        assert.equal((await pass).length, 1);
        hold = null;

        // While a restore is making the clone, an attach is told to come back
        // shortly, not that the folder is missing.
        let openClone;
        let cloneStarted;
        const started = new Promise((resolve) => { cloneStarted = resolve; });
        holdClone = new Promise((resolve) => { openClone = resolve; });
        cloneReached = cloneStarted;
        const restoring = svc.call("POST", "/v1/clones/restore", { rootSessionId: "tree-a", repo: "app" });
        await started;
        const early = await svc.lease("s1", 2);
        assert.equal(early.code, "WORKSPACE_ATTACH_FAILED", JSON.stringify(early));
        assert.match(early.message, /being made/);
        assert.ok(early.retryAfterMs > 0);
        openClone();
        holdClone = null;
        assert.equal((await restoring).body.restored, true, "and it comes back after");
    });

    it("I6b: a restore whose clone step fails leaves no half-made folder, so the next try works", async () => {
        const fx = await fixture();
        let failClone = false;
        const svc = await serviceFor(fx, {
            runGit: async (args) => {
                if (failClone && args[0] === "clone") {
                    failClone = false;
                    const target = args.at(-1);
                    fs.mkdirSync(target, { recursive: true });
                    fs.writeFileSync(path.join(target, "partial"), "");
                    throw new Error("the network went away");
                }
                return git(args);
            },
        });
        await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        svc.advance(IDLE);
        await svc.service.removeIdleClones();
        failClone = true;
        const failed = await svc.call("POST", "/v1/clones/restore", { rootSessionId: "tree-a", repo: "app" });
        assert.equal(failed.status, 500, JSON.stringify(failed.body));
        assert.equal(fs.existsSync(path.join(fx.root, "sessions/tree-a/app")), false, "the half-made clone is gone");
        const again = await svc.call("POST", "/v1/clones/restore", { rootSessionId: "tree-a", repo: "app" });
        assert.equal(again.body.restored, true, JSON.stringify(again.body));
    });

    it("I6c: a removal that starts while an attach waits on the worker registry makes that attach fail and retry, not lease a deleted clone", async () => {
        const fx = await fixture();
        let gate = null;
        const svc = await serviceFor(fx, {
            // Entries live long, so the registry decides; w-dead has left it.
            entryTtlMs: 10 * IDLE,
            isWorkerAlive: async (worker) => {
                if (gate) {
                    const held = gate;
                    gate = null;
                    held.entered();
                    await held.open;
                }
                return worker !== "w-dead";
            },
        });
        await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        await svc.lease("s0", 1, { workerNodeId: "w-dead" });
        svc.advance(IDLE);
        let entered;
        let open;
        gate = { entered: () => entered(), open: new Promise((resolve) => { open = resolve; }) };
        const waiting = new Promise((resolve) => { entered = resolve; });
        const attach = svc.lease("s1", 2);
        await waiting;
        assert.equal((await svc.service.removeIdleClones()).length, 1, "the removal runs while the attach waits");
        open();
        const answer = await attach;
        assert.equal(answer.ok, false, JSON.stringify(answer));
        assert.equal(answer.code, "WORKSPACE_ATTACH_FAILED");
        assert.ok(answer.retryAfterMs > 0);
        assert.equal(svc.service.state().leases["sessions/tree-a/app"], undefined, "no entry for a clone that is gone");
        assert.equal(svc.service.state().clones["sessions/tree-a/app"], undefined);
    });

    it("I7: the state survives a restart; a clone recorded before idle cleanup starts its idle time at the restart", async () => {
        const fx = await fixture();
        const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ps-repo-state-")), "state.json");
        cleanups.push(() => fs.rmSync(path.dirname(stateFile), { recursive: true, force: true }));
        const first = await serviceFor(fx, { stateFile });
        await first.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        await first.call("POST", "/v1/clones", { rootSessionId: "tree-b", repo: "app" });
        first.advance(IDLE);
        await first.lease("b1", 1, { rootSessionId: "tree-b" }, "sessions/tree-b/app");
        await first.service.removeIdleClones();
        await first.service.close();

        // tree-b as an older service wrote it: no last use, no sessions.
        const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        delete saved.clones["sessions/tree-b/app"].lastUsedAt;
        delete saved.clones["sessions/tree-b/app"].users;
        fs.writeFileSync(stateFile, JSON.stringify(saved));

        const second = await serviceFor(fx, { stateFile });
        second.advance(30 * 24 * HOUR);
        const restartedAt = second.now();
        const reloaded = createRepoService({ root: fx.root, rootName: "fx", repos: { app: { remote: fx.remote } }, stateFile, now: () => restartedAt, idleCloneMs: IDLE, log: () => {} });
        const state = reloaded.state();
        assert.equal(state.clones["sessions/tree-b/app"].lastUsedAt, restartedAt, "an old record's idle time starts now");
        assert.deepEqual(state.clones["sessions/tree-b/app"].users, []);
        assert.deepEqual(state.removals.map((r) => [r.checkout, r.reason]), [["sessions/tree-a/app", "idle"]], "the removal record was kept");
        assert.equal((await second.call("GET", "/v1/clones?rootSessionId=tree-a")).body.removed.length, 1);
    });

    it("the setting: unset is 7 days, 0 turns cleanup off, a bad value stops the service; the pass runs every 1 to 15 minutes", async () => {
        assert.equal(idleCloneMsFromEnv(undefined), DEFAULT_IDLE_CLONE_MS);
        assert.equal(idleCloneMsFromEnv(""), DEFAULT_IDLE_CLONE_MS);
        assert.equal(DEFAULT_IDLE_CLONE_MS, 7 * 24 * HOUR);
        assert.equal(idleCloneMsFromEnv("6"), 6 * HOUR);
        assert.equal(idleCloneMsFromEnv("0.5"), HOUR / 2);
        assert.equal(idleCloneMsFromEnv("0"), 0);
        assert.throws(() => idleCloneMsFromEnv("six"), /REPO_SERVICE_IDLE_CLONE_HOURS/);
        assert.throws(() => idleCloneMsFromEnv("-1"), /REPO_SERVICE_IDLE_CLONE_HOURS/);
        assert.equal(idleCheckIntervalMs(6 * HOUR), 15 * 60 * 1000);
        assert.equal(idleCheckIntervalMs(DEFAULT_IDLE_CLONE_MS), 15 * 60 * 1000);
        assert.equal(idleCheckIntervalMs(HOUR), 5 * 60 * 1000);
        assert.equal(idleCheckIntervalMs(60 * 1000), 60 * 1000);

        const fx = await fixture();
        const svc = await serviceFor(fx, { idleCloneMs: 0 });
        const made = await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        assert.equal(made.body.removedAfterIdleHours, undefined);
        svc.advance(365 * 24 * HOUR);
        assert.deepEqual(await svc.service.removeIdleClones(), [], "0 = never");
        assert.equal((await svc.call("GET", "/v1/clones")).body.clones[0].removeAfter, undefined);
    });
});

describe("provider: a clone that idle cleanup removed", () => {
    const req = (extra = {}) => ({
        sessionId: "s1", rootSessionId: "tree-a", workerNodeId: "w1", turnIndex: 4, revision: 1, purpose: "turn",
        workspace: { schema: 1, root: "fx", folder: "sessions/tree-a/app" }, ...extra,
    });

    it("I8: a turn brings it back with a note, once; a check does not; a clone removed on request or another tree's path stays missing", async () => {
        const fx = await fixture();
        const svc = await serviceFor(fx);
        const provider = createRepoWorkspaceProvider({ roots: [{ name: "fx", path: fx.root }], serviceUrls: { fx: svc.url } });
        const { head } = await cloneWithWork(svc, fx);
        assert.equal((await provider.ensureAttached(req({ turnIndex: 1 }))).ok, true);
        await provider.release({ ...req({ turnIndex: 1 }), reason: "evicted" });
        svc.advance(IDLE);
        assert.equal((await svc.service.removeIdleClones()).length, 1);

        const check = await provider.ensureAttached(req({ purpose: "check" }));
        assert.equal(check.code, "WORKSPACE_FOLDER_MISSING", "a check does not restore");
        assert.equal(svc.events.some((e) => e.event === "clone.restored"), false);

        const turn = await provider.ensureAttached(req());
        assert.equal(turn.ok, true, JSON.stringify(turn));
        assert.equal(turn.path, path.join(fx.root, "sessions/tree-a/app"));
        assert.ok(fs.existsSync(path.join(turn.path, ".git")), "a fresh clone is there");
        assert.match(turn.notice, /Your clone "sessions\/tree-a\/app" was removed on .* because no session had used it for 6 hours/);
        assert.match(turn.notice, /uncommitted changes and 1 commit that no remote had/);
        assert.ok(turn.notice.includes(`branch "agent/fix" at ${head.slice(0, 12)}`), turn.notice);
        assert.ok(turn.notice.includes("git fetch origin && git switch agent/fix"), turn.notice);
        assert.equal((await provider.ensureAttached(req({ turnIndex: 5 }))).notice, undefined, "told once");

        await provider.release({ ...req({ turnIndex: 5 }), reason: "ended" });
        await svc.call("DELETE", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        assert.equal((await provider.ensureAttached(req({ turnIndex: 6 }))).code, "WORKSPACE_FOLDER_MISSING", "removed on request: not brought back");

        await svc.call("POST", "/v1/clones", { rootSessionId: "tree-b", repo: "app" });
        await svc.call("POST", "/v1/leases", { checkout: "sessions/tree-b/app", sessionId: "b1", rootSessionId: "tree-b", workerNodeId: "w1", turnIndex: 1 });
        await svc.call("DELETE", "/v1/leases", { checkout: "sessions/tree-b/app", sessionId: "b1", workerNodeId: "w1" });
        svc.advance(IDLE);
        await svc.service.removeIdleClones();
        const other = await provider.ensureAttached(req({ workspace: { schema: 1, root: "fx", folder: "sessions/tree-b/app" } }));
        assert.equal(other.code, "WORKSPACE_FOLDER_MISSING", "a session never restores another tree's clone");
        assert.equal(fs.existsSync(path.join(fx.root, "sessions/tree-b/app")), false);
    });

    it("the note says what was lost and where pushed work is, and copes with missing facts", () => {
        const base = { checkout: "sessions/t/app", repo: "app", reason: "idle", idleHours: 6.5, removedAt: "2026-09-28T06:30:00.000Z" };
        const clean = recreatedNotice("sessions/t/app", { ...base, branch: "main", head: "0123456789abcdef", dirty: false, unpushedCommits: 0 });
        assert.equal(clean, [
            'Your clone "sessions/t/app" was removed on 2026-09-28T06:30:00.000Z because no session had used it for 6.5 hours. It has been made again as a fresh clone of app.',
            "Uncommitted changes and unpushed commits in the old clone are gone.",
            'The old clone was on branch "main" at 0123456789ab. If that branch was pushed, get it back with: git fetch origin && git switch main',
        ].join("\n"));
        const detached = recreatedNotice("sessions/t/app", { ...base, reason: "request", branch: null, head: "fedcba9876543210", dirty: true, unpushedCommits: 3 });
        assert.ok(detached.includes("because a session removed it"), detached);
        assert.ok(detached.includes("The old clone had uncommitted changes and 3 commits that no remote had. Those are gone."), detached);
        assert.ok(detached.includes("at commit fedcba987654, on no branch"), detached);
        const unknown = recreatedNotice("sessions/t/app", { ...base, branch: null, head: null, inspectError: "status: timed out" });
        assert.equal(unknown.split("\n").length, 2, "no branch line without facts");
    });

    it("the tools: create passes the caller, so it is not told twice; list shows the removed clones and the idle time", async () => {
        const fx = await fixture();
        const svc = await serviceFor(fx);
        const tools = Object.fromEntries(createRepoTools({ serviceUrl: svc.url, getCatalog: () => ({ getSession: async (id) => ({ sessionId: id, rootSessionId: "tree-a" }) }) })
            .map((tool) => [tool.name, tool]));
        const me = { durableSessionId: "s1" };
        const made = JSON.parse(await tools.create_session_clone.handler({ repo: "app" }, me));
        assert.equal(made.removedAfterIdleHours, 6);
        assert.ok(svc.events.some((e) => e.event === "clone.created" && e.sessionId === "s1"), "the service knows who made it");
        await svc.lease("s1", 1);
        await svc.release("s1");
        svc.advance(IDLE);
        await svc.service.removeIdleClones();
        const listed = JSON.parse(await tools.list_session_clones.handler({}, me));
        assert.deepEqual(listed.clones, []);
        assert.equal(listed.removed[0].reason, "idle");
        assert.equal(listed.removedAfterIdleHours, 6);
        const again = JSON.parse(await tools.create_session_clone.handler({ repo: "app" }, me));
        assert.equal(again.previous.reason, "idle", "the caller learns about the removal from the answer");
        assert.equal((await svc.lease("s1", 2)).recreated, undefined, "and is not told a second time");
        assert.match(tools.create_session_clone.description, /push your branch before you stop/);
    });
});
