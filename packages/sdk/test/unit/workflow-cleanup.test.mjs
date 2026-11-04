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

// Adversarial review RT-2 and its verifications (VR-1..3, tests M-08; E1b, tests E1-T1..T8): the script states of one
// workflow share its native tool session. Their tool calls run one at a time, each checked when its turn comes; a close
// aborts only its own running call and stops only the background work its own calls started while others hold the
// session; the last close tears the session down.

const ECHO = { name: "echo", input_schema: { type: "object" } };
const toolBinding = { parentSessionId: "parent", policy: "p", boundAgentFingerprint: "f", config: {}, tools: [workflowToolGrant(ECHO)], excludedTools: [] };
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

function gate() {
    let open, fail;
    const opened = new Promise((resolve, reject) => { open = resolve; fail = reject; });
    return { opened, open, fail };
}

async function until(check, label) {
    for (let i = 0; i < 200; i++) {
        if (check()) return;
        await tick(5);
    }
    throw new Error(`timed out waiting for ${label}`);
}

/**
 * A manager whose native sessions are fakes. Each setup makes a new session (n); `calls` records what happens, in order.
 * A tool call: `hold` makes it wait on a gate; `background` starts a task (its start time is the call's); `write` and
 * `read` set and read one shared flag. A cancel with time windows ("cancel-own") stops the tasks started in them; one
 * without ("cancel") stops all. `createHold(n)` and `factoryHold(n)` make a setup or a tool catalog check wait.
 */
function shareFixture({ authorize = async () => {}, createFails = null, createHold = () => null, factoryHold = () => null, cancelGate = null,
    cancelFails = false, ownCancelFails = false, release = { released: false, cancelled: 0 } } = {}) {
    const calls = [];
    const sessions = [];
    const flag = { written: false };
    const manager = new SessionManager(undefined, null, {});
    manager.sessionCatalog = { getSession: async () => ({ rootSessionId: "parent" }) };
    manager.authorizeWorkflowTools = (...args) => authorize(...args);
    let created = 0;
    manager.getOrCreate = async () => {
        const n = ++created;
        calls.push(`create:${n}`);
        if (createFails && createFails(n)) throw new Error(`setup ${n} failed`);
        const hold = createHold(n);
        if (hold) await hold;
        const session = { n, tasks: [], aborted: 0 };
        sessions.push(session);
        const cli = { rpc: { tools: {
            initializeAndValidate: async () => { const held = factoryHold(n); if (held) await held; },
            getCurrentMetadata: async () => ({ tools: [ECHO] }),
            execute: async ({ arguments: args }) => {
                calls.push(`execute:${n}:${args.label}`);
                if (args.background) session.tasks.push({ label: args.label, startedAt: Date.now(), running: true });
                if (args.write) flag.written = true;
                if (args.hold) await args.hold;
                const text = args.read ? (flag.written ? "ready" : "not yet") : `done ${args.label} on ${n}`;
                return { resultType: "success", textResultForLlm: text };
            },
        } }, abort: async () => { session.aborted += 1; calls.push(`abort:${n}`); } };
        return {
            prepareWorkflowTools: async () => { calls.push(`prepare:${n}`); },
            getWorkflowToolSession: () => cli,
            cancelBackgroundTasks: async ({ startedWithin } = {}) => {
                if (startedWithin) {
                    calls.push(`cancel-own:${n}`);
                    if (ownCancelFails) throw new Error("background shell remains");
                    for (const task of session.tasks) {
                        if (startedWithin.some(window => task.startedAt >= window.since && task.startedAt <= window.until)) task.running = false;
                    }
                    return 0;
                }
                calls.push(`cancel:${n}`);
                if (cancelGate) await cancelGate.opened;
                if (cancelFails) throw new Error("background shell remains");
                for (const task of session.tasks) task.running = false;
                return 0;
            },
            destroy: async () => { calls.push(`disconnect:${n}`); },
        };
    };
    manager.releaseWorkspace = async () => { calls.push("release"); return release; };
    const open = (step, options) => manager.openWorkflowToolExecutor("child", toolBinding, step, options);
    return { manager, calls, sessions, open, owners: () => manager.workflowToolShares.get("child")?.owners ?? 0 };
}

test("E1-T1: two script states share one session; a state that waits for its sibling's tool call sees it while both stay open", async () => {
    const f = shareFixture();
    const reader = await f.open(1);
    const writer = await f.open(2);
    // The reader polls through its own tool calls until the writer's tool call lands: both make progress.
    const polled = (async () => {
        for (let round = 0; round < 50; round++) {
            if (await reader.call("echo", { label: `read${round}`, read: true }) === "ready") return round;
            await tick(2);
        }
        throw new Error("the sibling's tool call never ran");
    })();
    await tick(15);
    assert.equal(await writer.call("echo", { label: "write", write: true }), "done write on 1");
    assert.ok(await polled > 0);
    assert.equal(f.calls.filter(call => call.startsWith("create:")).length, 1, "one native session for both");
    await reader.close();
    assert.equal(f.calls.includes("disconnect:1"), false, "the session stays while the writer holds it");
    assert.equal(await writer.call("echo", { label: "after" }), "done after on 1");
    await writer.close();
    assert.deepEqual(f.calls.slice(-3), ["cancel:1", "disconnect:1", "release"]);
    assert.equal(f.manager.workflowExecutors.size, 0);
    assert.equal(f.owners(), 0);
});

test("E1-T6, VR-1: a close while its call waits for its turn: the call never runs and the session is not aborted", async () => {
    const f = shareFixture();
    const holder = await f.open(1);
    const other = await f.open(2);
    const held = gate();
    const running = holder.call("echo", { label: "long", hold: held.opened });
    await tick();
    const queued = other.call("echo", { label: "queued" });
    await tick();
    await other.close();
    await assert.rejects(queued, /closed/);
    assert.equal(f.sessions[0].aborted, 0, "the holder's call is not aborted");
    assert.equal(f.owners(), 1);
    held.open();
    assert.equal(await running, "done long on 1");
    await tick();
    assert.equal(f.calls.includes("execute:1:queued"), false);
    await holder.close();
});

test("E1-T6, VR-1: a close while its own call runs aborts it, and releases its share only once the call has ended", async () => {
    const f = shareFixture();
    const holder = await f.open(1);
    const other = await f.open(2);
    const held = gate();
    const running = holder.call("echo", { label: "long", hold: held.opened });
    await tick();
    const closing = holder.close();
    await tick();
    assert.equal(f.sessions[0].aborted, 1);
    await assert.rejects(running, /closed/);
    assert.equal(f.owners(), 2, "not released while its call runs");
    held.open();
    await closing;
    assert.equal(f.owners(), 1);
    assert.equal(await other.call("echo", { label: "after" }), "done after on 1");
    await other.close();
});

test("VR-1: a call waiting for its turn is refused when its turn comes if its authority was revoked or its script ended", async () => {
    let revoked = false;
    const f = shareFixture({ authorize: async () => { if (revoked) throw new Error("A captured parent tool capability was revoked."); } });
    const holder = await f.open(1);
    const stop = new AbortController();
    const ending = await f.open(2, { signal: stop.signal });
    const revokedOne = await f.open(3);
    const held = gate();
    const running = holder.call("echo", { label: "long", hold: held.opened });
    await tick();
    const endedCall = ending.call("echo", { label: "ended" });
    const revokedCall = revokedOne.call("echo", { label: "revoked" });
    await tick();
    stop.abort();
    revoked = true;
    held.open();
    assert.equal(await running, "done long on 1", "a call already in its turn was authorized when its turn came");
    await assert.rejects(endedCall, /script ended/);
    await assert.rejects(revokedCall, /revoked/);
    assert.deepEqual(f.calls.filter(call => call.startsWith("execute:")), ["execute:1:long"]);
    await assert.rejects(ending.call("echo", { label: "again" }), /script ended/);
    revoked = false;
    for (const executor of [holder, ending, revokedOne]) await executor.close();
    assert.equal(f.owners(), 0);
});

test("VR-3: a close stops only the background work its own calls started while another state keeps the session", async () => {
    const f = shareFixture();
    const first = await f.open(1);
    const second = await f.open(2);
    await first.call("echo", { label: "first-bg", background: true });
    await tick(3);
    await second.call("echo", { label: "second-bg", background: true });
    await tick(3);
    await first.close();
    assert.deepEqual(f.sessions[0].tasks.map(task => [task.label, task.running]), [["first-bg", false], ["second-bg", true]]);
    assert.ok(f.calls.includes("cancel-own:1"));
    assert.equal(f.calls.includes("disconnect:1"), false);
    assert.equal(await second.call("echo", { label: "still" }), "done still on 1");
    await second.close();
    assert.deepEqual(f.sessions[0].tasks.map(task => task.running), [false, false]);
    assert.deepEqual(f.calls.slice(-3), ["cancel:1", "disconnect:1", "release"]);
});

test("VR-3: a close whose own cancel leaves work running blocks the workflow's tools until recovery", async () => {
    const f = shareFixture({ ownCancelFails: true });
    const first = await f.open(1);
    const second = await f.open(2);
    await first.call("echo", { label: "bg", background: true });
    await assert.rejects(first.close(), /background shell remains/);
    await assert.rejects(f.open(3), /requires recovery: background shell remains/);
    await assert.rejects(second.call("echo", { label: "blocked" }), /requires recovery/);
    await second.close();
    assert.equal(f.owners(), 0);
});

test("VR-2: an opening that waited on a teardown that then failed is refused, and so are later ones", async () => {
    const cancelGate = gate();
    const f = shareFixture({ cancelGate, cancelFails: true });
    const first = await f.open(1);
    const closing = first.close();
    await tick();
    const waiting = f.open(2);
    await tick();
    cancelGate.open();
    await assert.rejects(closing, /background shell remains/);
    await assert.rejects(waiting, /requires recovery/);
    await assert.rejects(f.open(3), /requires recovery/);
    assert.equal(f.calls.filter(call => call.startsWith("create:")).length, 1);
});

test("E1-T5, VR-2: a folder release that fails blocks the next opening", async () => {
    const f = shareFixture({ release: { released: true, cancelled: 0, detail: "folder still mounted" } });
    const first = await f.open(1);
    await assert.rejects(first.close(), /folder still mounted/);
    await assert.rejects(f.open(2), /requires recovery: folder still mounted/);
});

test("M-08 failed setup: the opening is refused, and the next one sets up its own", async () => {
    const f = shareFixture({ createFails: n => n === 1 });
    await assert.rejects(f.open(1), /setup 1 failed/);
    const next = await f.open(2);
    assert.equal(await next.call("echo", { label: "ok" }), "done ok on 2");
    await next.close();
});

test("E1-T2, E1-R2: a setup that hangs fails its opening within its deadline, releases the share, and is torn down if it ever finishes", async () => {
    const hold = gate();
    const f = shareFixture({ createHold: n => (n === 1 ? hold.opened : null) });
    f.manager.workflowToolSetupDeadlineMs = 50;
    await assert.rejects(f.open(1), /workflow tool setup did not finish within 50 ms/);
    assert.equal(f.owners(), 0);
    // It may have left native state behind: later openings are refused at once, not left waiting.
    await assert.rejects(f.open(2), /requires recovery: A workflow tool setup did not finish in time/);
    hold.open();
    await until(() => f.calls.includes("disconnect:1"), "the late setup's teardown");
});

test("E1-T2, E1-R2: a tool catalog check that hangs fails its opening within its deadline and tears its session down", async () => {
    const f = shareFixture({ factoryHold: () => new Promise(() => {}) });
    f.manager.workflowToolSetupDeadlineMs = 50;
    await assert.rejects(f.open(1), /workflow tool catalog check did not finish within 50 ms/);
    assert.equal(f.owners(), 0);
    assert.ok(f.calls.includes("disconnect:1"));
    await assert.rejects(f.open(2), /requires recovery/);
    assert.equal(f.manager.workflowExecutors.size, 0);
});

test("E1-T3, E1-R3: an executor made after its script ended is never handed out and makes no native call", async () => {
    const held = gate();
    const f = shareFixture({ factoryHold: () => held.opened });
    const stop = new AbortController();
    const opening = f.open(1, { signal: stop.signal });
    await tick();
    stop.abort();
    held.open();
    await assert.rejects(opening, /script ended before its workflow tools were available/);
    assert.equal(f.manager.workflowExecutors.size, 0);
    assert.equal(f.calls.some(call => call.startsWith("execute:")), false);
    assert.ok(f.calls.includes("disconnect:1"));
    assert.equal(f.owners(), 0);
});

test("E1-T4, E1-R3: an executor made after the worker began to shut down is never handed out", async () => {
    const held = gate();
    const f = shareFixture({ factoryHold: () => held.opened });
    f.manager.clients.set("fixture", { stop: async () => { f.calls.push("client-stop"); return []; } });
    const opening = f.open(1);
    await tick();
    await f.manager.shutdown();
    held.open();
    await assert.rejects(opening, /shutting down/);
    assert.equal(f.manager.workflowExecutors.size, 0);
    assert.equal(f.calls.some(call => call.startsWith("execute:")), false);
});

test("E1-T8, E1-R4: after a stop and a start of the same worker, new openings work and one from before the stop takes nothing", async () => {
    const held = gate();
    const f = shareFixture({ factoryHold: n => (n === 1 ? held.opened : null) });
    f.manager.clients.set("fixture", { stop: async () => { f.calls.push("client-stop"); return []; } });
    const old = f.open(1);
    await tick();
    await f.manager.shutdown();
    await assert.rejects(f.open(2), /shutting down/);
    f.manager.startWorkflowTools();
    held.open();
    await assert.rejects(old, /shutting down/);
    const fresh = await f.open(3);
    assert.equal(await fresh.call("echo", { label: "again" }), "done again on 2");
    await fresh.close();
});

test("M-08 shutdown with a call running and another waiting for its turn: both executors close, the waiting call never runs", async () => {
    const f = shareFixture();
    f.manager.clients.set("fixture", { stop: async () => { f.calls.push("client-stop"); return []; } });
    const holder = await f.open(1);
    const other = await f.open(2);
    const held = gate();
    const inFlight = holder.call("echo", { label: "long", hold: held.opened });
    await tick();
    const queued = other.call("echo", { label: "queued" });
    await tick();
    const shutdown = f.manager.shutdown();
    await tick();
    held.open();
    await shutdown;
    await inFlight.catch(() => undefined);
    await assert.rejects(queued, /closed/);
    assert.equal(f.calls.includes("execute:1:queued"), false);
    assert.ok(f.calls.includes("cancel:1") && f.calls.includes("disconnect:1"));
    await assert.rejects(f.manager.openWorkflowToolExecutor("other", toolBinding, 1), /shutting down/);
});

test("E1-R2, E1-R3: a script opens its executor once, checks its stop before each call, and waits a bounded time for a late opening", async () => {
    const { readFileSync } = await import("node:fs");
    const runtime = readFileSync(new URL("../../src/workflow/v2/runtime.ts", import.meta.url), "utf8");
    assert.match(runtime, /tools\.opening \?\?= deps\.openToolExecutor\(run\.workflowSessionId, binding, executed\.ordinal, \{ signal: tools\.stop\.signal \}\);/);
    assert.equal(runtime.match(/if \(scriptDone \|\| tools\.stop\.signal\.aborted\) throw new Error\("The script ended before its tool call ran\."\);/g)?.length, 2);
    assert.match(runtime, /tools\.stop\.abort\(\);\s*const opened = tools\.executor \?\? \(tools\.opening \? await settledWithin\(tools\.opening, WORKFLOW_V2_OPENING_WAIT_MS\) : null\);\s*if \(opened\) await opened\.close\(\);/);
    assert.match(runtime, /cancelTools: async \(\) => \{ tools\.stop\.abort\(\); if \(tools\.executor\) await tools\.executor\.close\(\); \}/);
});
