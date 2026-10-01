import { test } from "node:test";
import assert from "node:assert/strict";

import {
    runStartupStage,
    runStartupStageSync,
} from "../../dist/startup-diagnostics.js";

test("runStartupStage reports asynchronous completion", async () => {
    const messages = [];
    const result = await runStartupStage(
        "provider connection",
        async () => 42,
        {
            prefix: "[worker]",
            heartbeatMs: 0,
            log: (message) => messages.push(message),
        },
    );

    assert.equal(result, 42);
    assert.match(messages[0], /^\[worker\] startup stage "provider connection" started$/);
    assert.match(messages[1], /^\[worker\] startup stage "provider connection" completed in \d+ms$/);
});

test("runStartupStage reports and preserves asynchronous failures", async () => {
    const failures = [];
    const expected = new Error("connection refused");

    await assert.rejects(
        runStartupStage(
            "provider connection",
            async () => { throw expected; },
            {
                prefix: "[worker]",
                heartbeatMs: 0,
                log: () => {},
                logError: (message, error) => failures.push({ message, error }),
            },
        ),
        expected,
    );

    assert.match(failures[0].message, /^\[worker\] startup stage "provider connection" failed after \d+ms$/);
    assert.equal(failures[0].error, expected);
});

test("runStartupStageSync reports synchronous substages", () => {
    const messages = [];
    const result = runStartupStageSync(
        "hard reset",
        () => "ok",
        {
            prefix: "[git-runner]",
            category: "reconcile stage",
            log: (message) => messages.push(message),
        },
    );

    assert.equal(result, "ok");
    assert.match(messages[0], /^\[git-runner\] reconcile stage "hard reset" started$/);
    assert.match(messages[1], /^\[git-runner\] reconcile stage "hard reset" completed in \d+ms$/);
});
