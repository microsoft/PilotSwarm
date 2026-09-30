import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runWithTurnLifecycleProviders } from "../../dist/index.js";

const context = {
    sessionId: "session-1",
    turnIndex: 4,
    config: { model: "fixture:test" },
    trace() {},
};

test("preserves behavior when no providers are registered", async () => {
    let bodyCalls = 0;
    const result = await runWithTurnLifecycleProviders({
        context,
        run: () => {
            bodyCalls++;
            return { type: "completed", content: "done" };
        },
    });
    assert.equal(bodyCalls, 1);
    assert.deepEqual(result, { type: "completed", content: "done" });
});

test("enters providers in order and unwinds them in reverse order", async () => {
    const calls = [];
    const provider = (name) => ({
        name,
        beforeTurn: () => calls.push(`${name}:before`),
        afterTurn: () => calls.push(`${name}:after`),
    });

    await runWithTurnLifecycleProviders({
        context,
        providers: [
            provider("first"),
            provider("second"),
            provider("third"),
        ],
        run: () => {
            calls.push("turn");
            return { type: "completed" };
        },
    });

    assert.deepEqual(calls, [
        "first:before",
        "second:before",
        "third:before",
        "turn",
        "third:after",
        "second:after",
        "first:after",
    ]);
});

test("unwinds entered providers after partial setup failure", async () => {
    const calls = [];
    const setupError = new Error("third provider unavailable");
    let bodyCalls = 0;

    await assert.rejects(
        runWithTurnLifecycleProviders({
            context,
            providers: [
                {
                    beforeTurn: () => calls.push("first:before"),
                    afterTurn: ({ status, error }) => {
                        calls.push(["first:after", status, error]);
                    },
                },
                {
                    beforeTurn: () => calls.push("second:before"),
                    afterTurn: ({ status, error }) => {
                        calls.push(["second:after", status, error]);
                    },
                },
                {
                    beforeTurn: () => {
                        calls.push("third:before");
                        throw setupError;
                    },
                    afterTurn: () => calls.push("third:after"),
                },
            ],
            run: () => {
                bodyCalls++;
                return { type: "completed" };
            },
        }),
        (error) => error === setupError,
    );

    assert.equal(bodyCalls, 0);
    assert.deepEqual(calls, [
        "first:before",
        "second:before",
        "third:before",
        ["second:after", "failed", setupError],
        ["first:after", "failed", setupError],
    ]);
});

test("attempts every unwind and aggregates setup and cleanup failures", async () => {
    const setupError = new Error("third provider unavailable");
    const secondError = new Error("second provider cleanup failed");
    const firstError = new Error("first provider cleanup failed");
    const calls = [];

    await assert.rejects(
        runWithTurnLifecycleProviders({
            context,
            providers: [
                {
                    beforeTurn() {},
                    afterTurn() {
                        calls.push("first:after");
                        throw firstError;
                    },
                },
                {
                    beforeTurn() {},
                    afterTurn() {
                        calls.push("second:after");
                        throw secondError;
                    },
                },
                {
                    beforeTurn() {
                        throw setupError;
                    },
                },
            ],
            run: () => assert.fail("turn must not run"),
        }),
        (error) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [
                setupError,
                secondError,
                firstError,
            ]);
            return true;
        },
    );
    assert.deepEqual(calls, [
        "second:after",
        "first:after",
    ]);
});

test("reports completed, cancelled, stopped, and returned-error outcomes", async () => {
    for (const [result, expectedStatus] of [
        [{ type: "completed" }, "completed"],
        [{ type: "cancelled" }, "cancelled"],
        [{ type: "stopped" }, "cancelled"],
        [{ type: "error", message: "failed" }, "failed"],
    ]) {
        let seen;
        assert.equal(await runWithTurnLifecycleProviders({
            context,
            providers: [{ afterTurn: (value) => { seen = value; } }],
            run: () => result,
        }), result);
        assert.equal(seen.status, expectedStatus);
        assert.equal(seen.result, result);
        assert.equal(Object.hasOwn(seen, "error"), false);
    }
});

test("turn failures unwind every provider and preserve error precedence", async () => {
    const turnError = new Error("turn failed");
    const thirdError = new Error("third provider cleanup failed");
    const firstError = new Error("first provider cleanup failed");
    const calls = [];

    await assert.rejects(
        runWithTurnLifecycleProviders({
            context,
            providers: [
                {
                    beforeTurn() {},
                    afterTurn() {
                        calls.push("first:after");
                        throw firstError;
                    },
                },
                {
                    beforeTurn() {},
                    afterTurn() {
                        calls.push("second:after");
                    },
                },
                {
                    beforeTurn() {},
                    afterTurn() {
                        calls.push("third:after");
                        throw thirdError;
                    },
                },
            ],
            run: () => {
                throw turnError;
            },
        }),
        (error) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [
                turnError,
                thirdError,
                firstError,
            ]);
            return true;
        },
    );
    assert.deepEqual(calls, [
        "third:after",
        "second:after",
        "first:after",
    ]);
});

test("preserves undefined as a thrown primary failure", async () => {
    let seen;
    let rejected = false;
    try {
        await runWithTurnLifecycleProviders({
            context,
            providers: [{ afterTurn: (value) => { seen = value; } }],
            run: () => { throw undefined; },
        });
    } catch (error) {
        rejected = true;
        assert.equal(error, undefined);
    }
    assert.equal(rejected, true);
    assert.equal(seen.status, "failed");
    assert.equal(Object.hasOwn(seen, "error"), true);
    assert.equal(seen.error, undefined);
    assert.equal(Object.hasOwn(seen, "result"), false);
});

test("both real turn aliases use the lifecycle wrapper", () => {
    const source = fs.readFileSync(
        new URL("../../src/session-proxy.ts", import.meta.url),
        "utf8",
    );

    assert.match(
        source,
        /const runTurnHandler = async \([\s\S]*runWithTurnLifecycleProviders\(/,
    );
    assert.match(
        source,
        /registerHandoffActivity\(runtime, "runTurn", runTurnHandler\)/,
    );
    assert.match(
        source,
        /registerHandoffActivity\(runtime, "runTurn2", runTurnHandler\)/,
    );
    assert.match(
        source,
        /runtime\.registerActivity\("abortTurn", async \(/,
    );
});
