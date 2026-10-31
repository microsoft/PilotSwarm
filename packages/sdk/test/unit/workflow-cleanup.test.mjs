import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../dist/session-manager.js";

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
    f.manager.workflowExecutors.set("child", { close: async () => { throw new Error("cleanup failed"); } });
    f.manager.clients.set("fixture", { stop: async () => { f.calls.push("client-stop"); return []; } });
    await f.manager.shutdown();
    assert.deepEqual(f.calls, ["client-stop"]);
});
