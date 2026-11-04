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

// Adversarial review RT-2 and its verifications (VR-1..3, tests M-08; E1b, tests E1-T1..T8; E1c, tests E1b-T2, T5..T8): the
// script states of one workflow share its native tool session. Their tool calls run one at a time, each checked when its
// turn comes, after its authorization and just before it runs; a close aborts only its own running call and stops only
// the background tasks its own calls started while others hold the session; the last close tears the session down. Only
// the share that holds the session in the current worker generation removes its warm handle, releases its folders or
// raises its failure barrier; late work that ends and is cleaned up lifts the barrier it raised.

const ECHO = { name: "echo", input_schema: { type: "object" } };
const toolBinding = { parentSessionId: "parent", policy: "p", boundAgentFingerprint: "f", config: {}, tools: [workflowToolGrant(ECHO)], excludedTools: [] };
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

function gate() {
    let open, fail;
    const opened = new Promise((resolve, reject) => { open = resolve; fail = reject; });
    return { opened, open, fail };
}

async function until(check, label) {
    for (let i = 0; i < 400; i++) {
        if (check()) return;
        await tick(5);
    }
    throw new Error(`timed out waiting for ${label}`);
}

/**
 * A manager whose native sessions are fakes. Each setup makes a new session (n), kept as the warm handle; `calls`
 * records what happens, in order. A tool call: `hold` makes it wait on a gate; `background` starts a task with an id and
 * its start time (none with `untimed`); `write` and `read` set and read one shared flag; `moveTask` moves a task's start
 * time into this call; `delay` makes it take that many milliseconds. `authorize`, `createHold(n)`, `factoryHold(n)` and `metadataHold()` make an authorization, a setup,
 * a tool catalog check or a call's catalog read wait. A cancel with `select` ("cancel-own") stops the tasks it selects;
 * one without ("cancel") stops all. `listFails` makes listing the tasks fail.
 */
function shareFixture({ authorize = async () => {}, createFails = null, createHold = () => null, factoryHold = () => null, metadataHold = () => null,
    cancelGate = null, cancelFails = false, cancelFailsFor = () => false, ownCancelFails = false, listFails = false,
    listHold = { label: null, gate: null }, release = { released: false, cancelled: 0 } } = {}) {
    const calls = [];
    const sessions = [];
    const flag = { written: false };
    let tasks = 0;
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
        let catalogChecked = false;
        const cli = { rpc: { tools: {
            initializeAndValidate: async () => { const held = factoryHold(n); if (held) await held; },
            getCurrentMetadata: async () => {
                if (catalogChecked) { const held = metadataHold(); if (held) await held; }
                catalogChecked = true;
                return { tools: [ECHO] };
            },
            execute: async ({ arguments: args }) => {
                calls.push(`execute:${n}:${args.label}`);
                if (args.background) session.tasks.push({ id: `task-${++tasks}`, label: args.label, startedAt: args.untimed ? undefined : Date.now(), running: true });
                if (args.moveTask) session.tasks.find(task => task.label === args.moveTask).startedAt = Date.now();
                if (args.write) flag.written = true;
                if (args.delay) await tick(args.delay);
                if (args.hold) await args.hold;
                const text = args.read ? (flag.written ? "ready" : "not yet") : `done ${args.label} on ${n}`;
                return { resultType: "success", textResultForLlm: text };
            },
        } }, abort: async () => { session.aborted += 1; calls.push(`abort:${n}`); } };
        const handle = {
            n,
            prepareWorkflowTools: async () => { calls.push(`prepare:${n}`); },
            getWorkflowToolSession: () => cli,
            activeBackgroundTasks: async () => {
                if (listFails) throw new Error("tasks cannot be listed");
                const listed = session.tasks.filter(task => task.running).map(task => ({ id: task.id, type: "shell" }));
                // `listHold`: the listing after the call that started the task labelled so waits for its gate.
                if (listHold.gate && session.tasks.some(task => task.label === listHold.label)) await listHold.gate.opened;
                return listed;
            },
            cancelBackgroundTasks: async ({ select } = {}) => {
                if (select) {
                    calls.push(`cancel-own:${n}`);
                    if (ownCancelFails) throw new Error("background shell remains");
                    for (const task of session.tasks) if (task.running && select({ id: task.id, startedAt: task.startedAt })) task.running = false;
                    return 0;
                }
                calls.push(`cancel:${n}`);
                if (cancelGate) await cancelGate.opened;
                if (cancelFails || cancelFailsFor(n)) throw new Error("background shell remains");
                for (const task of session.tasks) task.running = false;
                return 0;
            },
            destroy: async () => { calls.push(`disconnect:${n}`); },
        };
        manager.sessions.set("child", handle);
        return handle;
    };
    manager.releaseWorkspace = async () => { calls.push("release"); return release; };
    manager.clients.set("fixture", { stop: async () => { calls.push("client-stop"); return []; } });
    const open = (step, options) => manager.openWorkflowToolExecutor("child", toolBinding, step, options);
    const running = label => sessions.flatMap(session => session.tasks).find(task => task.label === label)?.running;
    return { manager, calls, sessions, open, running, owners: () => manager.workflowToolShares.get("child")?.owners ?? 0,
        barrier: () => manager.workflowExecutorFailures.get("child") ?? null };
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
    const refused = assert.rejects(queued, /closed/);
    await tick();
    await other.close();
    await refused;
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
    const outcome = running.then(value => ({ value }), error => ({ error }));
    await tick();
    const closing = holder.close();
    await tick();
    assert.equal(f.sessions[0].aborted, 1);
    assert.equal(f.owners(), 2, "not released while its call runs");
    held.open();
    await closing;
    // A call whose turn began settles with its own outcome (G1b); this fake's aborted call still returns.
    assert.deepEqual(await outcome, { value: "done long on 1" });
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

test("VR-3: a close stops only the background tasks its own calls started while another state keeps the session", async () => {
    const f = shareFixture();
    const first = await f.open(1);
    const second = await f.open(2);
    await first.call("echo", { label: "first-bg", background: true });
    await second.call("echo", { label: "second-bg", background: true });
    await first.close();
    assert.deepEqual([f.running("first-bg"), f.running("second-bg")], [false, true]);
    assert.ok(f.calls.includes("cancel-own:1"));
    assert.equal(f.calls.includes("disconnect:1"), false);
    assert.equal(await second.call("echo", { label: "still" }), "done still on 1");
    await second.close();
    assert.deepEqual([f.running("first-bg"), f.running("second-bg")], [false, false]);
    assert.deepEqual(f.calls.slice(-3), ["cancel:1", "disconnect:1", "release"]);
});

test("VR-3 (E1c): a task claimed by one owner's call is never another's, even when its start time falls in the other's call", async () => {
    const f = shareFixture();
    const first = await f.open(1);
    const second = await f.open(2);
    await first.call("echo", { label: "first-bg", background: true });
    // The second's call moves the first's task's start time into its own window, and starts one of its own.
    await second.call("echo", { label: "second-bg", background: true, moveTask: "first-bg" });
    await second.close();
    assert.deepEqual([f.running("first-bg"), f.running("second-bg")], [true, false], "the first's task is the first's alone");
    await first.close();
    assert.equal(f.running("first-bg"), false);
});

test("VR-3 (E1c): a task no listing caught and with no start time is left to the last owner's teardown", async () => {
    const f = shareFixture({ listFails: true });
    const first = await f.open(1);
    const second = await f.open(2);
    await first.call("echo", { label: "untimed", background: true, untimed: true });
    await first.call("echo", { label: "timed", background: true, delay: 5 });
    await first.close();
    // Not listed: the timed one is the first's by its start time; the untimed one is nobody's until the end.
    assert.deepEqual([f.running("untimed"), f.running("timed")], [true, false]);
    await second.close();
    assert.equal(f.running("untimed"), false);
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

test("E1b-T5: a sibling's cleanup that fails while another call waits for its authority stops that call before it runs", async () => {
    let hold = null;
    const f = shareFixture({ authorize: async () => { if (hold) await hold.opened; }, ownCancelFails: true });
    const first = await f.open(1);
    const second = await f.open(2);
    await second.call("echo", { label: "bg", background: true });
    hold = gate();
    const waiting = first.call("echo", { label: "after-barrier" });
    await tick();
    await assert.rejects(second.close(), /background shell remains/);
    assert.ok(f.barrier());
    hold.open();
    await assert.rejects(waiting, /requires recovery/);
    assert.equal(f.calls.includes("execute:1:after-barrier"), false);
    hold = null;
    await first.close();
});

test("E1b-T5: a barrier raised while a call reads the tool catalog stops it just before it runs", async () => {
    let metadata = null;
    const f = shareFixture({ metadataHold: () => metadata?.opened ?? null, ownCancelFails: true });
    const first = await f.open(1);
    const second = await f.open(2);
    await second.call("echo", { label: "bg", background: true });
    metadata = gate();
    const reading = first.call("echo", { label: "late" });
    await tick();
    await assert.rejects(second.close(), /background shell remains/);
    metadata.open();
    await assert.rejects(reading, /requires recovery/);
    assert.equal(f.calls.includes("execute:1:late"), false);
    await first.close();
});

test("E1b-T2: a close or a script's end at each stage: nothing runs after it, and each reservation is released", async () => {
    // During the opening's authorization: the script's end stops it at once.
    let hold = gate();
    const f = shareFixture({ authorize: async () => { if (hold) await hold.opened; } });
    const stop = new AbortController();
    const opening = f.open(1, { signal: stop.signal });
    await tick();
    stop.abort();
    await assert.rejects(opening, /script ended before its workflow tools were available/);
    await until(() => f.owners() === 0, "the reservation to be released");
    hold.open();
    hold = null;

    // During a call's authorization, and during its catalog read: the call's turn has begun, so the close waits for it,
    // and its next check refuses it ("was cancelled"); it never runs natively.
    const executor = await f.open(2);
    hold = gate();
    const inAuthorize = executor.call("echo", { label: "in-authorize" });
    const authorizeRefused = assert.rejects(inAuthorize, /cancelled/);
    await tick();
    const closing = executor.close();
    await tick();
    hold.open();
    hold = null;
    await authorizeRefused;
    await closing;
    assert.equal(f.calls.some(call => call.includes("in-authorize")), false);
    assert.equal(f.owners(), 0);

    let metadata = null;
    const g = shareFixture({ metadataHold: () => metadata?.opened ?? null });
    const reader = await g.open(1);
    metadata = gate();
    const inMetadata = reader.call("echo", { label: "in-metadata" });
    const metadataRefused = assert.rejects(inMetadata, /cancelled/);
    await tick();
    const shut = reader.close();
    await tick();
    metadata.open();
    await metadataRefused;
    await shut;
    assert.equal(g.calls.some(call => call.includes("in-metadata")), false);
    assert.equal(g.owners(), 0);
});

test("E1b-T8, E1-R2: an authorization that hangs fails within its deadline, at the opening and at a call, and the turn moves on", async () => {
    let hangs = 0;
    const f = shareFixture({ authorize: () => {
        if (hangs > 0) { hangs -= 1; return new Promise(() => {}); }
        return Promise.resolve();
    } });
    f.manager.workflowToolSetupDeadlineMs = 50;
    // The opening's own authorization hangs (the setup's does not).
    hangs = 1;
    await assert.rejects(f.open(1), /workflow authorization did not finish within 50 ms/);
    await until(() => f.owners() === 0, "the reservation to be released");
    const first = await f.open(2);
    const second = await f.open(3);
    const stop = new AbortController();
    const third = await f.open(4, { signal: stop.signal });
    // A call's authorization hangs: it fails within the deadline.
    hangs = 1;
    await assert.rejects(first.call("echo", { label: "hung" }), /workflow authorization did not finish within 50 ms/);
    // The script's end stops a hung authorization at once.
    hangs = 1;
    const stopped = third.call("echo", { label: "stopped" });
    await tick();
    stop.abort();
    await assert.rejects(stopped, /script ended; its workflow tool call did not run/);
    // The turn moved on.
    assert.equal(await second.call("echo", { label: "next" }), "done next on 2");
    assert.equal(f.calls.some(call => call.includes("hung") || call.includes("stopped")), false);
    for (const executor of [first, second, third]) await executor.close();
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

test("E1-T2, E1b-T7: a setup that hangs fails within its deadline; when it ends and is torn down, its barrier is lifted", async () => {
    const hold = gate();
    const f = shareFixture({ createHold: n => (n === 1 ? hold.opened : null) });
    f.manager.workflowToolSetupDeadlineMs = 50;
    await assert.rejects(f.open(1), /workflow tool setup did not finish within 50 ms/);
    assert.equal(f.owners(), 0);
    // It may have left native state behind: later openings are refused at once, not left waiting.
    await assert.rejects(f.open(2), /requires recovery: A workflow tool setup did not finish in time/);
    hold.open();
    await until(() => f.calls.includes("disconnect:1") && f.barrier() === null, "the late setup's teardown and recovery");
    assert.ok(f.calls.includes("release"));
    const next = await f.open(3);
    assert.equal(await next.call("echo", { label: "recovered" }), "done recovered on 2");
    await next.close();
});

test("E1-T2: a tool catalog check that hangs fails its opening within its deadline and tears its session down", async () => {
    const f = shareFixture({ factoryHold: () => new Promise(() => {}) });
    f.manager.workflowToolSetupDeadlineMs = 50;
    await assert.rejects(f.open(1), /workflow tool catalog check did not finish within 50 ms/);
    assert.equal(f.owners(), 0);
    assert.ok(f.calls.includes("disconnect:1"));
    // The check never ended: its barrier stays.
    await assert.rejects(f.open(2), /requires recovery/);
    assert.equal(f.manager.workflowExecutors.size, 0);
});

test("E1b-T7: a tool catalog check that ends late lifts its barrier once its session is torn down", async () => {
    const hold = gate();
    const f = shareFixture({ factoryHold: n => (n === 1 ? hold.opened : null) });
    f.manager.workflowToolSetupDeadlineMs = 50;
    await assert.rejects(f.open(1), /workflow tool catalog check did not finish within 50 ms/);
    await assert.rejects(f.open(2), /requires recovery/);
    hold.open();
    await until(() => f.barrier() === null, "the late check's recovery");
    const next = await f.open(3);
    await next.close();
});

test("E1b-R3: a barrier of an earlier worker generation is lifted at the next start", async () => {
    const f = shareFixture({ cancelFails: true });
    const first = await f.open(1);
    await assert.rejects(first.close(), /background shell remains/);
    await assert.rejects(f.open(2), /requires recovery/);
    await f.manager.shutdown();
    f.manager.startWorkflowTools();
    assert.equal(f.barrier(), null);
    const next = await f.open(3);
    assert.equal(await next.call("echo", { label: "after-restart" }), "done after-restart on 2");
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

test("E1b-T6, E1b-R1: an earlier generation's late work cleans only its own handle, never the new share's", async () => {
    const held = gate();
    const f = shareFixture({ factoryHold: n => (n === 1 ? held.opened : null), cancelFails: false });
    const old = f.open(1);
    await tick();
    await f.manager.shutdown();
    f.manager.startWorkflowTools();
    const fresh = await f.open(2);
    const current = f.manager.sessions.get("child");
    assert.equal(current.n, 2);
    const releases = f.calls.filter(call => call === "release").length;
    // The old opening ends now: it disconnects its own session 1 only.
    held.open();
    await assert.rejects(old, /shutting down/);
    await until(() => f.calls.includes("disconnect:1"), "the old session's own cleanup");
    assert.equal(f.manager.sessions.get("child"), current, "the new warm handle stays");
    assert.equal(f.calls.filter(call => call === "release").length, releases, "no folder of the new share is released");
    assert.equal(f.barrier(), null);
    assert.equal(f.calls.includes("disconnect:2"), false);
    assert.equal(await fresh.call("echo", { label: "still" }), "done still on 2");
    await fresh.close();
    assert.deepEqual(f.calls.slice(-3), ["cancel:2", "disconnect:2", "release"]);
});

test("E1b-T6, E1b-R1: an earlier generation's late cleanup that fails raises no barrier for the new share", async () => {
    const held = gate();
    const f = shareFixture({ factoryHold: n => (n === 1 ? held.opened : null), cancelFailsFor: n => n === 1 });
    const old = f.open(1);
    await tick();
    await f.manager.shutdown();
    f.manager.startWorkflowTools();
    const fresh = await f.open(2);
    held.open();
    await assert.rejects(old, /shutting down/);
    await until(() => f.calls.includes("cancel:1") && f.calls.includes("disconnect:1"), "the old session's own cleanup");
    await tick(20);
    assert.equal(f.barrier(), null, "an earlier generation's failure blocks nothing now");
    assert.equal(await fresh.call("echo", { label: "ok" }), "done ok on 2");
    await fresh.close();
    assert.deepEqual(f.calls.slice(-3), ["cancel:2", "disconnect:2", "release"]);
});

test("M-08 shutdown with a call running and another waiting for its turn: both executors close, the waiting call never runs", async () => {
    const f = shareFixture();
    const holder = await f.open(1);
    const other = await f.open(2);
    const held = gate();
    const inFlight = holder.call("echo", { label: "long", hold: held.opened });
    await tick();
    const queued = other.call("echo", { label: "queued" });
    const refused = assert.rejects(queued, /closed/);
    await tick();
    const shutdown = f.manager.shutdown();
    await tick();
    held.open();
    await shutdown;
    await inFlight.catch(() => undefined);
    await refused;
    assert.equal(f.calls.includes("execute:1:queued"), false);
    // Closed as their own generation's: the session is torn down and its folders released.
    assert.ok(f.calls.includes("cancel:1") && f.calls.includes("disconnect:1") && f.calls.includes("release"));
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

// Verification of E1c (E1d): the barrier is a set of causes, each lifted only by the work that raised it (E1c-R1); a close
// waits for its call's whole turn, so the tasks the call started are its own when it disposes (E1c-R2).
test("E1c-R1: two late catalog checks, the later one ending first, keep the barrier up until both have ended", async () => {
    const gates = [gate(), gate()];
    let next = 0;
    const f = shareFixture({ factoryHold: () => gates[next++]?.opened ?? null });
    f.manager.workflowToolSetupDeadlineMs = 50;
    const first = f.open(1);
    const second = f.open(2);
    await assert.rejects(first, /workflow tool catalog check did not finish within 50 ms/);
    await assert.rejects(second, /workflow tool catalog check did not finish within 50 ms/);
    assert.equal(f.barrier().size, 2);
    gates[1].open();
    await until(() => f.barrier()?.size === 1, "the later check's cause to be lifted");
    await assert.rejects(f.open(3), /requires recovery: A workflow tool catalog check did not finish in time/);
    gates[0].open();
    await until(() => f.barrier() === null, "the earlier check's cause to be lifted");
    const next3 = await f.open(4);
    await next3.close();
});

test("E1c-R1: a failed owner cleanup followed by a late catalog check keeps the cleanup's cause when the check ends", async () => {
    const hold = gate();
    let checks = 0;
    const f = shareFixture({ ownCancelFails: true, factoryHold: () => (++checks === 3 ? hold.opened : null) });
    f.manager.workflowToolSetupDeadlineMs = 50;
    const first = await f.open(1);
    const second = await f.open(2);
    await second.call("echo", { label: "bg", background: true });
    const third = f.open(3);
    await tick();
    await assert.rejects(second.close(), /background shell remains/);
    await assert.rejects(third, /workflow tool catalog check did not finish within 50 ms/);
    assert.equal(f.barrier().size, 2);
    hold.open();
    await until(() => f.barrier()?.size === 1, "the late check's own cause to be lifted");
    await assert.rejects(f.open(4), /requires recovery: background shell remains/);
    await first.close();
});

test("E1c-R2: a close after the native call returned and before its tasks were listed waits, then stops the call's new task", async () => {
    const listHold = { label: "late-bg", gate: gate() };
    const f = shareFixture({ listHold });
    const first = await f.open(1);
    const second = await f.open(2);
    await second.call("echo", { label: "other-bg", background: true });
    const calling = first.call("echo", { label: "late-bg", background: true });
    await until(() => f.calls.includes("execute:1:late-bg"), "the native call");
    await tick();
    let closed = false;
    const closing = first.close().then(() => { closed = true; });
    await tick(20);
    assert.equal(closed, false, "the close waits for the call's turn");
    assert.equal(f.running("late-bg"), true);
    listHold.gate.open();
    listHold.gate = null;
    await closing;
    await calling.catch(() => undefined);
    assert.equal(f.running("late-bg"), false, "the call's own task was stopped by its close");
    assert.equal(f.running("other-bg"), true, "the other owner's task runs on");
    await second.close();
});
