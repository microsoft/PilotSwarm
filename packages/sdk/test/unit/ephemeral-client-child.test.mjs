import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RESET_TOOL, RESET_SEED } from "../../dist/ephemeral-context-reset.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../../dist");
const child = path.join(dist, "ephemeral-client-child.js");

/**
 * Replaces only the Copilot client boundary. Everything the helper does with
 * it — the tool bridge, the event bridge, the rpc dispatch — stays real.
 */
const SOURCE = `
import { CopilotRequestHandler } from "@github/copilot-sdk";

// The helper composes its context-reset barrier over the BYOK shim, so this
// boundary must keep exporting the shim's shape, not just the client factory.
export function needsByokRequestCompatibility(provider) {
    if (!provider || typeof provider !== "object") return false;
    const { type, wireApi } = provider;
    return (!type || type === "openai" || type === "azure") && (!wireApi || wireApi === "completions");
}
export class ByokRequestCompatibility extends CopilotRequestHandler {}

const log = [];
let config;
export function createCopilotClient() {
    return {
        async start() {},
        async stop() { return []; },
        getStatus() { return { version: "1.0.85" }; },
        async createSession(value) {
            config = value;
            return {
                sessionId: "synthetic-session",
                async send(message) {
                    const tool = config.tools.find(entry => entry.name === message.prompt);
                    const result = await tool.handler({ synthetic: true }, { sessionId: "synthetic-session" });
                    return { prompt: message.prompt, result, log };
                },
                async abort() {},
                rpc: {
                    options: { update: async () => ({ success: true }) },
                    tools: { initializeAndValidate: async () => {}, getCurrentMetadata: async () => ({ tools: [] }) },
                    model: { getCurrent: async () => ({ modelId: "model" }) },
                    tasks: { list: async () => ({ tasks: [] }), waitForPending: async () => {},
                        cancel: async () => {}, remove: async () => {} },
                    history: {
                        compact: async input => { log.push(["compact", input]); return { compacted: true }; },
                        cancelBackgroundCompaction: async () => { log.push(["cancel"]); return { cancelled: false }; },
                        clearContext: async input => {
                            log.push(["clearContext", input]);
                            config.onEvent?.({ type: "session.context_cleared", id: "e1", parentId: null,
                                timestamp: new Date().toISOString(),
                                data: { messagesCleared: 12, initialMessage: input.prompt } });
                            return { messagesCleared: 12 };
                        },
                    },
                },
            };
        },
    };
}
`;

/**
 * Runs the real helper module, with only the Copilot client boundary stubbed.
 * That keeps the IPC loop, the dispatch switch and the host-callback bridge
 * under test rather than a re-implementation of them.
 */
async function helper(t) {
    const root = await mkdtemp(path.join(tmpdir(), "ephemeral-child-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const hooks = path.join(root, "hooks.mjs"), entry = path.join(root, "register.mjs");
    await writeFile(entry, `import { register } from "node:module";\n`
        + `register(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
    await writeFile(hooks, `
const real = ${JSON.stringify(pathToFileURL(path.join(dist, "copilot-client.js")).href)};
export async function resolve(specifier, context, next) {
    const resolved = await next(specifier, context);
    return resolved.url === real ? { ...resolved, format: "module", shortCircuit: true } : resolved;
}
export async function load(url, context, next) {
    if (url !== real) return next(url, context);
    return { format: "module", shortCircuit: true, source: ${JSON.stringify(SOURCE)} };
}
`);
    const proc = fork(child, [], {
        execArgv: ["--import", pathToFileURL(entry).href],
        env: { ...process.env, PILOTSWARM_EPHEMERAL_CHILD: "1" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    t.after(() => { if (proc.connected) proc.disconnect(); proc.kill("SIGKILL"); });
    const stderr = [];
    proc.stderr.on("data", value => stderr.push(String(value)));

    let nextId = 0;
    const pending = new Map(), inbox = [], waiters = [];
    proc.on("message", message => {
        if (message.kind === "reply") {
            const waiting = pending.get(message.id);
            pending.delete(message.id);
            if (message.ok) waiting.resolve(message.value); else waiting.reject(new Error("child rejected"));
            return;
        }
        inbox.push(message);
        for (const waiter of waiters.splice(0)) waiter();
    });
    // A helper that dies at module load (a boundary this mock no longer
    // satisfies, say) would otherwise leave every call pending forever and hang
    // the whole unit run with no attribution. Fail the call instead.
    proc.on("exit", code => {
        const reason = new Error(`helper exited (${code}): ${stderr.join("")}`);
        for (const waiting of pending.values()) waiting.reject(reason);
        pending.clear();
        for (const waiter of waiters.splice(0)) waiter();
    });
    const call = (method, input) => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        proc.send({ kind: "call", id, method, input });
    });
    const waitFor = async kind => {
        for (;;) {
            const found = inbox.find(message => message.kind === kind);
            if (found) return found;
            await new Promise(resolve => waiters.push(resolve));
        }
    };
    const initialize = () => ({ options: { baseDirectory: path.join(root, "state"),
        workingDirectory: root, env: {} }, provider: undefined });
    return { proc, call, waitFor, inbox, stderr, initialize,
        reply: (id, value) => proc.send({ kind: "host-reply", id, ok: true, value }) };
}

test("the real helper dispatches history.clearContext while one of its tool calls is still pending", async t => {
    const h = await helper(t);
    assert.equal(await h.call("initialize", h.initialize()), true);
    assert.equal(await h.call("createSession", {
        config: { sessionId: "synthetic-session", tools: [{ name: RESET_TOOL }] },
    }), "synthetic-session");

    // The stub session invokes the tool, whose handler is proxied back to us.
    const sending = h.call("send", { prompt: RESET_TOOL });
    const invocation = await h.waitFor("host");
    assert.deepEqual(invocation.value.method, "tool");
    assert.equal(invocation.value.name, RESET_TOOL);

    // With that host callback outstanding, issue the clear the way the tool
    // handler does. A serialized loop would deadlock here.
    const cleared = await h.call("history.clearContext", { prompt: RESET_SEED });
    assert.deepEqual(cleared, { messagesCleared: 12 });

    // The clear event reaches the host over the same channel, unblocked.
    const event = await h.waitFor("event");
    assert.equal(event.value.type, "session.context_cleared");
    assert.deepEqual(event.value.data, { messagesCleared: 12, initialMessage: RESET_SEED });

    h.reply(invocation.id, "Batch cleared.");
    const result = await sending;
    assert.equal(result.result, "Batch cleared.");
    assert.deepEqual(result.log, [["clearContext", { prompt: RESET_SEED }]]);
    assert.deepEqual(h.stderr, []);
});

test("the helper routes each narrowed history method to its own runtime call", async t => {
    const h = await helper(t);
    await h.call("initialize", h.initialize());
    await h.call("createSession", { config: { sessionId: "synthetic-session", tools: [] } });
    assert.deepEqual(await h.call("history.compact", { instructions: "x" }), { compacted: true });
    assert.deepEqual(await h.call("history.cancelBackgroundCompaction"), { cancelled: false });
    assert.deepEqual(await h.call("history.clearContext", { prompt: "Analyze batch 2." }), { messagesCleared: 12 });
    await assert.rejects(h.call("history.truncate", { count: 1 }), /child rejected/);
    await assert.rejects(h.call("history.rewind", {}), /child rejected/);
    assert.deepEqual(h.stderr, []);
});
