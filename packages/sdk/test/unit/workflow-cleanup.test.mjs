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

// Adversarial review RT-2: the executors of one workflow's parallel script states share one native tool session.

const ECHO = { name: "echo", input_schema: { type: "object" } };
const toolBinding = { parentSessionId: "parent", policy: "p", boundAgentFingerprint: "f", config: {}, tools: [workflowToolGrant(ECHO)], excludedTools: [] };

function gate() {
    let open;
    const opened = new Promise(resolve => { open = resolve; });
    return { opened, open };
}

function sharedFixture({ setupGate = null, destroyGate = null } = {}) {
    const calls = [];
    let running = 0;
    let maxRunning = 0;
    const manager = new SessionManager(undefined, null, {});
    manager.sessionCatalog = { getSession: async () => ({ rootSessionId: "parent" }) };
    manager.authorizeWorkflowTools = async () => {};
    const cli = { rpc: { tools: {
        initializeAndValidate: async () => {},
        getCurrentMetadata: async () => ({ tools: [ECHO] }),
        execute: async ({ arguments: args, toolCallId }) => {
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            calls.push(`execute:${args.label}`);
            if (args.hold) await args.hold;
            running -= 1;
            return { resultType: "success", textResultForLlm: `done ${args.label} ${toolCallId.split("/")[1]}` };
        },
    } }, abort: async () => { calls.push("abort"); } };
    manager.getOrCreate = async () => {
        calls.push("create");
        if (setupGate) await setupGate.opened;
        return {
            prepareWorkflowTools: async () => { calls.push("prepare"); },
            getWorkflowToolSession: () => cli,
            cancelBackgroundTasks: async () => { calls.push("cancel"); },
            destroy: async () => { calls.push("disconnect"); if (destroyGate) await destroyGate.opened; },
        };
    };
    manager.releaseWorkspace = async () => { calls.push("release"); return { released: false, cancelled: 0 }; };
    return { manager, calls, maxRunning: () => maxRunning };
}

test("two parallel script states of one workflow both get an executor; one native session, set up once", async () => {
    const f = sharedFixture();
    const first = await f.manager.openWorkflowToolExecutor("child", toolBinding, 1);
    const second = await f.manager.openWorkflowToolExecutor("child", toolBinding, 2);
    assert.equal(f.calls.filter(call => call === "create").length, 1);
    assert.equal(f.calls.filter(call => call === "prepare").length, 1);
    assert.equal(f.manager.workflowExecutors.size, 2);
    assert.equal(await first.call("echo", { label: "a" }), "done a 1");
    assert.equal(await second.call("echo", { label: "b" }), "done b 2");
    // One close does not tear the shared session down; the last one does, once.
    await first.close();
    assert.ok(!f.calls.includes("cancel") && !f.calls.includes("disconnect"));
    assert.equal(await second.call("echo", { label: "c" }), "done c 2");
    await second.close();
    assert.deepEqual(f.calls.filter(call => ["cancel", "disconnect", "release"].includes(call)), ["cancel", "disconnect", "release"]);
    assert.equal(f.manager.workflowExecutors.size, 0);
});

test("overlapping tool calls of two states both succeed, one at a time on the shared session", async () => {
    const f = sharedFixture();
    const first = await f.manager.openWorkflowToolExecutor("child", toolBinding, 1);
    const second = await f.manager.openWorkflowToolExecutor("child", toolBinding, 2);
    const release = gate();
    const a = first.call("echo", { label: "a", hold: release.opened });
    const b = second.call("echo", { label: "b" });
    await new Promise(resolve => setTimeout(resolve, 20));
    release.open();
    assert.deepEqual(await Promise.all([a, b]), ["done a 1", "done b 2"]);
    assert.equal(f.maxRunning(), 1);
    await Promise.all([first.close(), second.close()]);
});

test("two openings racing through setup share one session; neither close destroys the other's", async () => {
    const setupGate = gate();
    const f = sharedFixture({ setupGate });
    const opening = [f.manager.openWorkflowToolExecutor("child", toolBinding, 1), f.manager.openWorkflowToolExecutor("child", toolBinding, 2)];
    await new Promise(resolve => setTimeout(resolve, 10));
    setupGate.open();
    const [first, second] = await Promise.all(opening);
    assert.equal(f.calls.filter(call => call === "create").length, 1);
    // A close while the other state's call is in flight neither aborts the session nor disconnects it.
    const release = gate();
    const inFlight = second.call("echo", { label: "b", hold: release.opened });
    const closing = first.close();
    await closing;
    assert.ok(!f.calls.includes("abort") && !f.calls.includes("disconnect"));
    release.open();
    assert.equal(await inFlight, "done b 2");
    await second.close();
    assert.equal(f.calls.filter(call => call === "disconnect").length, 1);
});

test("an executor for other tools is refused while a share lives; a new share waits for the old one's teardown", async () => {
    const destroyGate = gate();
    const f = sharedFixture({ destroyGate });
    const first = await f.manager.openWorkflowToolExecutor("child", toolBinding, 1);
    await assert.rejects(f.manager.openWorkflowToolExecutor("child", { ...toolBinding, tools: [] }, 2), /other tools is already active/);
    const closing = first.close();
    await new Promise(resolve => setTimeout(resolve, 10));
    const reopening = f.manager.openWorkflowToolExecutor("child", toolBinding, 3);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.calls.filter(call => call === "create").length, 1, "the new share waits for the old disconnect");
    destroyGate.open();
    await closing;
    const again = await reopening;
    assert.equal(f.calls.filter(call => call === "create").length, 2);
    assert.ok(f.calls.lastIndexOf("release") < f.calls.lastIndexOf("create"));
    await again.close();
});
