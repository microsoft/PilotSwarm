import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../dist/session-manager.js";
import { workflowToolGrant } from "../../dist/workflow/tool-policy.js";

function fixture(cancelFails = false) {
    const calls = [];
    const manager = new SessionManager(undefined, null, {});
    manager.sessionCatalog = { getSession: async () => ({ rootSessionId: "parent" }) };
    manager.authorizeWorkflowTools = async () => {};
    const cli = { rpc: { tools: {
        initializeAndValidate: async () => {},
        getCurrentMetadata: async () => ({ tools: [] }),
    } }, abort: async () => {} };
    manager.getOrCreate = async () => ({
        prepareWorkflowTools: async () => {},
        getWorkflowToolSession: () => cli,
        cancelBackgroundTasks: async () => { calls.push("cancel"); if (cancelFails) throw new Error("shell remains"); },
        destroy: async () => { calls.push("disconnect"); },
    });
    manager.releaseWorkspace = async () => { calls.push("release"); return { released: false, cancelled: 0 }; };
    return { manager, calls };
}
const binding = { config: {}, tools: [], excludedTools: [] };

test("executor closes native tasks before disconnecting and releasing folders", async () => {
    const f = fixture();
    const executor = await f.manager.openWorkflowToolExecutor("child", binding, 1);
    await executor.close();
    assert.deepEqual(f.calls, ["cancel", "disconnect", "release"]);
    assert.equal(f.manager.workflowExecutors.size, 0);
});

test("failed task cleanup disconnects but holds folders and blocks new state execution", async () => {
    const f = fixture(true);
    const executor = await f.manager.openWorkflowToolExecutor("child", binding, 1);
    await assert.rejects(executor.close(), /shell remains/);
    assert.deepEqual(f.calls, ["cancel", "disconnect"]);
    await assert.rejects(f.manager.openWorkflowToolExecutor("child", binding, 2), /requires recovery/);
});

test("worker shutdown still stops Copilot clients after an executor cleanup rejection", async () => {
    const f = fixture();
    f.manager.workflowExecutors.add({ close: async () => { throw new Error("cleanup failed"); } });
    f.manager.clients.set("fixture", { stop: async () => { f.calls.push("client-stop"); return []; } });
    await f.manager.shutdown();
    assert.deepEqual(f.calls, ["client-stop"]);
});

// Adversarial review RT-2 and its verification (VR-1..3, tests M-08): a workflow's native tool session is held by one
// script state at a time, from its first tool call until its executor closed and the session was torn down; another
// script state of the same workflow waits in line, then sets up its own.

const ECHO = { name: "echo", input_schema: { type: "object" } };
const toolBinding = { parentSessionId: "parent", policy: "p", boundAgentFingerprint: "f", config: {}, tools: [workflowToolGrant(ECHO)], excludedTools: [] };
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

function gate() {
    let open, fail;
    const opened = new Promise((resolve, reject) => { open = resolve; fail = reject; });
    return { opened, open, fail };
}

/**
 * A manager whose native sessions are fakes. Each setup makes a new session (n); `calls` records what happens, in order;
 * `hold` makes a tool call wait on a gate; `background` marks a session as running background work until it is cancelled.
 */
function leaseFixture({ authorize = async () => {}, createFails = null, cancelGate = null, cancelFails = false } = {}) {
    const calls = [];
    const sessions = [];
    const manager = new SessionManager(undefined, null, {});
    manager.sessionCatalog = { getSession: async () => ({ rootSessionId: "parent" }) };
    manager.authorizeWorkflowTools = (...args) => authorize(...args);
    let created = 0;
    manager.getOrCreate = async () => {
        const n = ++created;
        calls.push(`create:${n}`);
        if (createFails && createFails(n)) throw new Error(`setup ${n} failed`);
        const session = { n, background: false, aborted: 0 };
        sessions.push(session);
        const cli = { rpc: { tools: {
            initializeAndValidate: async () => {},
            getCurrentMetadata: async () => ({ tools: [ECHO] }),
            execute: async ({ arguments: args }) => {
                calls.push(`execute:${n}:${args.label}`);
                if (args.background) session.background = true;
                if (args.hold) await args.hold;
                return { resultType: "success", textResultForLlm: `done ${args.label} on ${n}` };
            },
        } }, abort: async () => { session.aborted += 1; calls.push(`abort:${n}`); } };
        return {
            prepareWorkflowTools: async () => { calls.push(`prepare:${n}`); },
            getWorkflowToolSession: () => cli,
            cancelBackgroundTasks: async () => {
                calls.push(`cancel:${n}`);
                if (cancelGate) await cancelGate.opened;
                if (cancelFails) throw new Error("background shell remains");
                session.background = false;
            },
            destroy: async () => { calls.push(`disconnect:${n}`); },
        };
    };
    manager.releaseWorkspace = async () => { calls.push("release"); return { released: false, cancelled: 0 }; };
    return { manager, calls, sessions };
}

test("two script states of one workflow both get their tools: the second waits for the first to close, then sets up its own", async () => {
    const f = leaseFixture();
    const first = await f.manager.openWorkflowToolExecutor("child", toolBinding, 1);
    let secondReady = false;
    const opening = f.manager.openWorkflowToolExecutor("child", toolBinding, 2).then(executor => { secondReady = true; return executor; });
    await tick();
    assert.equal(secondReady, false, "the second waits while the first holds the session");
    assert.equal(await first.call("echo", { label: "a" }), "done a on 1");
    await first.close();
    const second = await opening;
    assert.equal(await second.call("echo", { label: "b" }), "done b on 2");
    await second.close();
    assert.deepEqual(f.calls, ["create:1", "prepare:1", "execute:1:a", "cancel:1", "disconnect:1", "release",
        "create:2", "prepare:2", "execute:2:b", "cancel:2", "disconnect:2", "release"]);
    assert.equal(f.manager.workflowExecutors.size, 0);
});

test("M-08 queued owner closed: an opening whose script ended while it waited takes nothing, and the line moves on", async () => {
    const f = leaseFixture();
    const first = await f.manager.openWorkflowToolExecutor("child", toolBinding, 1);
    const stop = new AbortController();
    const queued = f.manager.openWorkflowToolExecutor("child", toolBinding, 2, { signal: stop.signal });
    const third = f.manager.openWorkflowToolExecutor("child", toolBinding, 3);
    stop.abort();
    await assert.rejects(queued, /script ended before its workflow tools were available/);
    await first.close();
    const next = await third;
    assert.equal(await next.call("echo", { label: "c" }), "done c on 2");
    await next.close();
    assert.equal(f.calls.filter(call => call.startsWith("create:")).length, 2, "the ended script never set a session up");
});

test("M-08 capability revoked while queued: the waiting opening is refused when its turn comes; the next one proceeds", async () => {
    let revoked = false;
    const f = leaseFixture({ authorize: async () => { if (revoked) throw new Error("A captured parent tool capability was revoked."); } });
    const first = await f.manager.openWorkflowToolExecutor("child", toolBinding, 1);
    const queued = f.manager.openWorkflowToolExecutor("child", toolBinding, 2);
    await tick();
    revoked = true;
    await first.close();
    await assert.rejects(queued, /capability was revoked/);
    assert.equal(f.calls.filter(call => call.startsWith("create:")).length, 1);
    revoked = false;
    const later = await f.manager.openWorkflowToolExecutor("child", toolBinding, 3);
    await later.close();
});

test("M-08 VR-1: a call is checked against its owner's authority before it runs; a closed owner's call never runs", async () => {
    let revoked = false;
    const f = leaseFixture({ authorize: async () => { if (revoked) throw new Error("A captured parent tool capability was revoked."); } });
    const executor = await f.manager.openWorkflowToolExecutor("child", toolBinding, 1);
    revoked = true;
    await assert.rejects(executor.call("echo", { label: "late" }), /revoked/);
    revoked = false;
    await executor.close();
    await assert.rejects(executor.call("echo", { label: "closed" }), /closed/);
    assert.ok(!f.calls.some(call => call.startsWith("execute:")));
});

test("M-08 VR-3: a closing owner's background work is stopped before anyone else gets the session", async () => {
    const f = leaseFixture();
    const first = await f.manager.openWorkflowToolExecutor("child", toolBinding, 1);
    await first.call("echo", { label: "bg", background: true });
    assert.equal(f.sessions[0].background, true);
    const queued = f.manager.openWorkflowToolExecutor("child", toolBinding, 2);
    await first.close();
    assert.equal(f.sessions[0].background, false, "the closed owner's background work was cancelled");
    const second = await queued;
    assert.ok(f.calls.indexOf("cancel:1") < f.calls.indexOf("create:2"));
    await second.close();
});

test("M-08 VR-1: closing an owner with a call in flight aborts that call on its own session", async () => {
    const f = leaseFixture();
    const executor = await f.manager.openWorkflowToolExecutor("child", toolBinding, 1);
    const held = gate();
    const inFlight = executor.call("echo", { label: "long", hold: held.opened });
    await tick();
    const closing = executor.close();
    await tick();
    assert.equal(f.sessions[0].aborted, 1);
    held.open();
    await closing;
    await inFlight.catch(() => undefined);
});

test("M-08 VR-2: an opening that waited on a teardown that then failed is refused, and so are later ones", async () => {
    const cancelGate = gate();
    const f = leaseFixture({ cancelGate, cancelFails: true });
    const first = await f.manager.openWorkflowToolExecutor("child", toolBinding, 1);
    const closing = first.close();
    await tick();
    const waiting = f.manager.openWorkflowToolExecutor("child", toolBinding, 2);
    await tick();
    cancelGate.open();
    await assert.rejects(closing, /background shell remains/);
    await assert.rejects(waiting, /requires recovery/);
    await assert.rejects(f.manager.openWorkflowToolExecutor("child", toolBinding, 3), /requires recovery/);
    assert.equal(f.calls.filter(call => call.startsWith("create:")).length, 1);
});

test("M-08 failed setup: the opening is refused, its session is torn down, and the next one sets up its own", async () => {
    const f = leaseFixture({ createFails: n => n === 1 });
    await assert.rejects(f.manager.openWorkflowToolExecutor("child", toolBinding, 1), /setup 1 failed/);
    const next = await f.manager.openWorkflowToolExecutor("child", toolBinding, 2);
    assert.equal(await next.call("echo", { label: "ok" }), "done ok on 2");
    await next.close();
});

test("M-08 shutdown with a holder in a call and an opening in line: the holder is closed, the opening takes nothing", async () => {
    const f = leaseFixture();
    f.manager.clients.set("fixture", { stop: async () => { f.calls.push("client-stop"); return []; } });
    const executor = await f.manager.openWorkflowToolExecutor("child", toolBinding, 1);
    const held = gate();
    const inFlight = executor.call("echo", { label: "long", hold: held.opened });
    const queued = f.manager.openWorkflowToolExecutor("child", toolBinding, 2);
    await tick();
    const shutdown = f.manager.shutdown();
    await tick();
    held.open();
    await shutdown;
    await inFlight.catch(() => undefined);
    await assert.rejects(queued, /shutting down/);
    assert.equal(f.calls.filter(call => call.startsWith("create:")).length, 1);
    assert.ok(f.calls.includes("cancel:1") && f.calls.includes("disconnect:1"));
    await assert.rejects(f.manager.openWorkflowToolExecutor("other", toolBinding, 1), /shutting down/);
});

test("M-08: a script opens its executor once, stops an opening still in line when it ends, and closes one that came late", async () => {
    const { readFileSync } = await import("node:fs");
    const runtime = readFileSync(new URL("../../src/workflow/v2/runtime.ts", import.meta.url), "utf8");
    assert.match(runtime, /tools\.opening \?\?= deps\.openToolExecutor\(run\.workflowSessionId, binding, executed\.ordinal, \{ signal: tools\.stop\.signal \}\);/);
    assert.match(runtime, /if \(scriptDone\) throw new Error\("The script ended before its tool call ran\."\);/);
    assert.match(runtime, /tools\.stop\.abort\(\);\s*const opened = tools\.executor \?\? \(tools\.opening \? await tools\.opening\.catch\(\(\) => null\) : null\);\s*if \(opened\) await opened\.close\(\);/);
    assert.match(runtime, /cancelTools: async \(\) => \{ tools\.stop\.abort\(\); if \(tools\.executor\) await tools\.executor\.close\(\); \}/);
});
