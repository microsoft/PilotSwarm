import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mock } from "node:test";

const { root, config, failure } = JSON.parse(process.argv[2]);
const legacyLogFile = "/tmp/duroxide-tui.log";
const tracing = [];
const events = [];
const writes = [];
const restoredCalls = [];
const rendered = Promise.withResolvers();
const fixtureError = Object.assign(new Error(`fixture ${failure} failure`), { code: "EACCES" });

// The legacy name is virtual: even an unmodified host cannot touch a real
// shared log or the operator's config. Every physical write stays test-owned.
function ownedPath(file) {
    const destination = file === legacyLogFile
        ? path.join(root, "legacy.log")
        : path.resolve(file);
    const relative = path.relative(root, destination);
    assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative), `Unowned path: ${file}`);
    return destination;
}

mock.module("node:fs", {
    defaultExport: {
        ...fs,
        readFileSync: (file, ...args) => fs.readFileSync(ownedPath(file), ...args),
        mkdirSync: (dir, ...args) => fs.mkdirSync(ownedPath(dir), ...args),
        writeFileSync(file, ...args) {
            writes.push(file);
            if (failure === "write") throw fixtureError;
            return fs.writeFileSync(ownedPath(file), ...args);
        },
        appendFileSync(file, ...args) {
            writes.push(file);
            return fs.appendFileSync(ownedPath(file), ...args);
        },
    },
});
mock.module("duroxide", {
    namedExports: {
        initTracing(options) {
            tracing.push(options);
            if (failure === "tracing") throw fixtureError;
            fs.appendFileSync(ownedPath(options.logFile), "[native] fixture trace\n");
        },
    },
});
mock.module("react", {
    defaultExport: { createElement: (component, props) => ({ component, props }) },
});
mock.module("ink", {
    namedExports: {
        render(element, options) {
            events.push("render");
            assert.equal(options.exitOnCtrlC, false);
            if (failure === "render") throw fixtureError;
            rendered.resolve(element.props);
            return {
                clear: () => events.push("clear"),
                unmount: () => events.push("unmount"),
                cleanup() {
                    events.push("cleanup");
                    console.log("fixture cleanup");
                },
            };
        },
    },
});
mock.module(new URL("../../src/app.js", import.meta.url).href, {
    namedExports: { PilotSwarmTuiApp() {} },
});
mock.module(new URL("../../src/platform.js", import.meta.url).href, {
    namedExports: {
        createTuiPlatform() {
            if (failure === "platform") throw fixtureError;
            return {};
        },
    },
});
mock.module(new URL("../../src/node-sdk-transport.js", import.meta.url).href, {
    namedExports: { NodeSdkTransport: class {} },
});
mock.module(new URL("../../src/auth/cli.js", import.meta.url).href, {
    namedExports: {
        bootstrapApiAuth: async () => ({ getAccessToken: async () => "fixture-token" }),
    },
});
mock.module(new URL("../../src/http-transport-host.js", import.meta.url).href, {
    namedExports: { createHttpTransportHost: () => ({}) },
});
mock.module("pilotswarm/ui-core", {
    namedExports: {
        appReducer() {},
        createInitialState: () => ({ ui: {}, sessions: {} }),
        // The host reads and writes the per-viewer Admin tree state
        // (tui/src/admin-tree-config.js).
        normalizeStoredAdminCollapsed: (value) => (Array.isArray(value) ? value.filter((id) => typeof id === "string") : []),
        createStore: (_reducer, state) => ({
            getState: () => state,
            subscribe() {},
            dispatch() {},
        }),
        PilotSwarmUiController: class {
            setViewport() {}
            async stop() {
                events.push("stop");
                console.log("fixture controller stop");
                if (failure === "stop") throw fixtureError;
            }
        },
    },
});

for (const method of ["log", "warn", "error"]) {
    mock.method(console, method, () => restoredCalls.push(method));
}
mock.method(process.stderr, "write", (_chunk, _encoding, cb) => {
    restoredCalls.push("stderr");
    cb?.();
    return true;
});
mock.method(process, "emitWarning", () => restoredCalls.push("warning"));
mock.method(process, "exit", (code) => events.push(`exit:${code}`));

const { startTuiApp } = await import("pilotswarm");
const startup = startTuiApp(config);
const outcome = await Promise.race([
    rendered.promise.then((props) => ({ props })),
    startup.then(() => ({}), (error) => ({ error })),
]);
let error = outcome.error;
let stderrCallback = false;
if (outcome.props) {
    console.log("fixture console log", { fixture: true });
    console.warn("fixture console warn");
    console.error(new Error("fixture console error"));
    process.stderr.write(Buffer.from("fixture stderr\n"), "utf8", () => {
        stderrCallback = true;
    });
    process.emitWarning("fixture warning", { code: "FIXTURE_WARNING" });
    await outcome.props.onRequestExit();
    try {
        await startup;
    } catch (startupError) {
        error = startupError;
    }
}

console.log("after restore");
console.warn("after restore");
console.error("after restore");
process.stderr.write("after restore", "utf8", () => {});
process.emitWarning("after restore");
process.stdout.write(JSON.stringify({
    error: error ? { name: error.name, message: error.message, code: error.code } : null,
    sameError: error === fixtureError,
    tracing,
    writes,
    events,
    restoredCalls,
    stderrCallback,
}));
