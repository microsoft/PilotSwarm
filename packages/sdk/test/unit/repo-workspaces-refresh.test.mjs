import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRepoService } from "../../examples/repo-workspaces/repo-service.mjs";

const cleanups = [];
afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups.length = 0;
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("repo service: background refresh", () => {
    it("waits for each pass to finish, then continues after success or failure", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-repo-refresh-"));
        fs.mkdirSync(path.join(root, "repos", "app.git"), { recursive: true });
        cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

        const timers = [];
        const cleared = [];
        const setTimeout = (callback, intervalMs) => {
            const timer = { callback, intervalMs, unref() {} };
            timers.push(timer);
            return timer;
        };
        const clearTimeout = (timer) => {
            cleared.push(timer);
            const index = timers.indexOf(timer);
            if (index >= 0) timers.splice(index, 1);
        };

        const passes = [deferred(), deferred(), deferred()];
        let fetchCalls = 0;
        let inFlight = 0;
        let maxInFlight = 0;
        const logs = [];
        const service = createRepoService({
            root,
            repos: { app: { remote: "https://example.invalid/app" } },
            setTimeout,
            clearTimeout,
            runGit: async (args) => {
                if (args.includes("ls-remote")) return "ref: refs/heads/main\tHEAD\nabc\tHEAD";
                if (args.includes("show-ref")) return "abc";
                if (args.includes("symbolic-ref")) return "";
                assert.ok(args.includes("fetch"), `unexpected git command: ${args.join(" ")}`);
                const pass = passes[fetchCalls++];
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                try {
                    return await pass.promise;
                } finally {
                    inFlight -= 1;
                }
            },
        });
        cleanups.push(() => service.close());

        service.startRefresh(1000, (message) => logs.push(message));
        service.startRefresh(10, (message) => logs.push(message));
        assert.equal(timers.length, 1, "starting twice still schedules one refresh loop");
        assert.equal(timers[0].intervalMs, 1000);

        const first = timers.shift().callback();
        await Promise.resolve();
        assert.equal(fetchCalls, 1);
        assert.equal(timers.length, 0, "no next pass is scheduled while the current pass is running");
        passes[0].resolve();
        await first;
        assert.equal(timers.length, 1, "success schedules the next pass");

        const second = timers.shift().callback();
        await Promise.resolve();
        passes[1].reject(new Error("fetch failed"));
        await second;
        assert.deepEqual(logs, ["[repo-service] refresh failed: fetch failed"]);
        assert.equal(timers.length, 1, "failure also schedules the next pass");

        const third = timers.shift().callback();
        await Promise.resolve();
        passes[2].resolve();
        await third;
        assert.equal(fetchCalls, 3);
        assert.equal(maxInFlight, 1);
        assert.equal(timers.length, 1);

        await service.close();
        assert.equal(timers.length, 0);
        assert.equal(cleared.length, 1, "closing cancels the pending refresh");
        cleanups.pop();
    });
});
