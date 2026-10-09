import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
    loadTurnLifecycleHooksFromEnv,
    runWithTurnLifecycleHooks,
    TURN_LIFECYCLE_HOOK_MODULE_ENV,
} from "../../dist/index.js";

test("returns no hooks when the module environment variable is absent", async () => {
    assert.equal(await loadTurnLifecycleHooksFromEnv({}), undefined);
});

test("loads named non-Git hooks from a relative module path", async () => {
    const beforeTurn = () => {};
    const afterTurn = () => {};
    let importedSpecifier;
    const cwd = path.resolve("worker-root");

    const hooks = await loadTurnLifecycleHooksFromEnv(
        { [TURN_LIFECYCLE_HOOK_MODULE_ENV]: "./hooks/turn-hooks.mjs" },
        {
            cwd,
            importModule: async (specifier) => {
                importedSpecifier = specifier;
                return { beforeTurn, afterTurn };
            },
        },
    );

    assert.equal(
        importedSpecifier,
        pathToFileURL(path.resolve(cwd, "hooks/turn-hooks.mjs")).href,
    );
    assert.equal(hooks.beforeTurn, beforeTurn);
    assert.equal(hooks.afterTurn, afterTurn);
    assert.equal(hooks.beforeRunTurn, undefined);
    assert.equal(hooks.afterRunTurn, undefined);
});

test("loads durable Git pre/post hooks from the standard module", async () => {
    const beforeRunTurn = () => {};
    const afterRunTurn = () => {};
    const hooks = await loadTurnLifecycleHooksFromEnv(
        { [TURN_LIFECYCLE_HOOK_MODULE_ENV]: "durable-git-hooks" },
        {
            importModule: async () => ({ beforeRunTurn, afterRunTurn }),
        },
    );

    assert.equal(hooks.beforeTurn, undefined);
    assert.equal(hooks.afterTurn, undefined);
    assert.equal(hooks.beforeRunTurn, beforeRunTurn);
    assert.equal(hooks.afterRunTurn, afterRunTurn);
});

test("converts an absolute module path to a file URL", async () => {
    let importedSpecifier;
    const absolutePath = path.resolve("hooks", "turn-hooks.mjs");

    await loadTurnLifecycleHooksFromEnv(
        { [TURN_LIFECYCLE_HOOK_MODULE_ENV]: absolutePath },
        {
            importModule: async (specifier) => {
                importedSpecifier = specifier;
                return { beforeTurn() {} };
            },
        },
    );

    assert.equal(importedSpecifier, pathToFileURL(absolutePath).href);
});

test("passes package specifiers through to the module loader", async () => {
    let importedSpecifier;
    const beforeTurn = () => {};
    const hooks = await loadTurnLifecycleHooksFromEnv(
        { [TURN_LIFECYCLE_HOOK_MODULE_ENV]: "@contoso/worker-turn-hooks" },
        {
            importModule: async (specifier) => {
                importedSpecifier = specifier;
                return { beforeTurn };
            },
        },
    );

    assert.equal(importedSpecifier, "@contoso/worker-turn-hooks");
    assert.equal(hooks.beforeTurn, beforeTurn);
    assert.equal(hooks.afterTurn, undefined);
});

test("imports and executes a real ESM hook module", async () => {
    const moduleUrl = new URL(
        "../fixtures/turn-lifecycle-hooks/trace-hooks.mjs",
        import.meta.url,
    ).href;
    const hooks = await loadTurnLifecycleHooksFromEnv({
        [TURN_LIFECYCLE_HOOK_MODULE_ENV]: moduleUrl,
    });
    const trace = [];

    const result = await runWithTurnLifecycleHooks({
        ...hooks,
        context: {
            sessionId: "fixture-session",
            turnIndex: 1,
            config: {},
            trace: (message) => trace.push(message),
        },
        run: () => ({ type: "completed" }),
    });

    assert.deepEqual(result, { type: "completed" });
    assert.deepEqual(trace, [
        "fixture-before:fixture-session",
        "fixture-after:fixture-session:completed",
    ]);
});

test("fails closed when the configured module cannot be imported", async () => {
    const importError = new Error("module missing");
    await assert.rejects(
        loadTurnLifecycleHooksFromEnv(
            { [TURN_LIFECYCLE_HOOK_MODULE_ENV]: "./missing.mjs" },
            { importModule: async () => { throw importError; } },
        ),
        (error) => {
            assert.match(error.message, /Failed to load turn lifecycle hook module/);
            assert.equal(error.cause, importError);
            return true;
        },
    );
});

test("fails closed when the module exports no lifecycle hooks", async () => {
    await assert.rejects(
        loadTurnLifecycleHooksFromEnv(
            { [TURN_LIFECYCLE_HOOK_MODULE_ENV]: "empty-hooks" },
            { importModule: async () => ({}) },
        ),
        /must export beforeTurn, afterTurn, beforeRunTurn, or afterRunTurn/,
    );
});

test("fails closed when a lifecycle hook export is not a function", async () => {
    await assert.rejects(
        loadTurnLifecycleHooksFromEnv(
            { [TURN_LIFECYCLE_HOOK_MODULE_ENV]: "invalid-hooks" },
            { importModule: async () => ({ beforeTurn: "not-a-function" }) },
        ),
        /export beforeTurn must be a function/,
    );
});

test("the standard worker loads hooks before construction and passes them through", async () => {
    const source = await readFile(
        new URL("../../examples/worker.js", import.meta.url),
        "utf8",
    );
    const loadIndex = source.indexOf("await loadTurnLifecycleHooksFromEnv()");
    const constructionIndex = source.indexOf("new PilotSwarmWorker");

    assert.notEqual(loadIndex, -1, "worker entrypoint must load lifecycle hooks");
    assert.notEqual(constructionIndex, -1, "worker entrypoint must construct the worker");
    assert.ok(loadIndex < constructionIndex, "hooks must load before worker construction");
    assert.match(source, /\.\.\.turnLifecycleHooks/);
});

test("the standard worker publishes readiness only after startup and clears it before draining", async () => {
    const source = await readFile(
        new URL("../../examples/worker.js", import.meta.url),
        "utf8",
    );
    const startIndex = source.indexOf("await worker.start()");
    const markReadyIndex = source.indexOf("markReady()", startIndex);
    const shutdownIndex = source.indexOf("async function shutdown");
    const clearReadyIndex = source.indexOf("clearReady()", shutdownIndex);
    const drainIndex = source.indexOf("await worker.gracefulShutdown()", shutdownIndex);
    const exitCleanupIndex = source.indexOf('process.once("exit", clearReady)');
    const fatalExitIndex = source.indexOf("function fatalExit");
    const signalHandlerIndex = source.indexOf('process.on("SIGTERM"');

    assert.notEqual(startIndex, -1);
    assert.ok(markReadyIndex > startIndex, "readiness must follow successful worker startup");
    assert.ok(signalHandlerIndex < startIndex, "shutdown handlers must be active during startup");
    assert.ok(fatalExitIndex < startIndex, "fatal cleanup must be active during startup");
    assert.ok(exitCleanupIndex < startIndex, "process exit must clear readiness");
    assert.ok(clearReadyIndex > shutdownIndex, "shutdown must clear readiness");
    assert.ok(clearReadyIndex < drainIndex, "readiness must clear before graceful drain");
});
