import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
    CopilotRuntimeMonitor,
    copilotRuntimeExitMessage,
    isCopilotTransportLossMessage,
    transportLossMessage,
} from "../../dist/copilot-runtime-monitor.js";

const IDLE = "setInterval(() => {}, 1000)";

function spawnRuntime() {
    return spawn(process.execPath, ["-e", IDLE, "--", "--headless", "--stdio"], { stdio: "ignore" });
}

function spawnTool() {
    return spawn(process.execPath, ["-e", IDLE], { stdio: "ignore" });
}

function exited(child) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return once(child, "exit");
}

function harness() {
    const lost = [];
    const monitor = new CopilotRuntimeMonitor((client, exit) => lost.push({ client, exit }));
    const children = [];
    const started = (fn) => (...args) => { const child = fn(...args); children.push(child); return child; };
    const cleanup = () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
    return { monitor, lost, runtime: started(spawnRuntime), tool: started(spawnTool), cleanup };
}

test("a start claims only its first runtime spawn, never a tool spawn or a spawn outside the start", async (t) => {
    const h = harness();
    t.after(h.cleanup);
    const client = {};
    const outside = h.runtime();
    let tool;
    let runtime;
    await h.monitor.start(client, async () => {
        tool = h.tool();
        runtime = h.runtime();
        h.runtime();
    });
    assert.equal(h.monitor.pid(client), runtime.pid);
    assert.notEqual(h.monitor.pid(client), tool.pid);
    assert.notEqual(h.monitor.pid(client), outside.pid);

    const later = {};
    h.runtime();
    assert.equal(h.monitor.pid(later), null);
    assert.equal(h.monitor.watch(later).exit(), null);
    assert.equal(h.monitor.isLost(later), false);
});

test("a runtime killed after startup is lost: its watch and the manager hear the exit code and signal", async (t) => {
    const h = harness();
    t.after(h.cleanup);
    const client = {};
    let runtime;
    await h.monitor.start(client, async () => { runtime = h.runtime(); });
    const watch = h.monitor.watch(client);
    const heard = new Promise((resolve) => watch.onExit(resolve));
    assert.equal(h.monitor.isLost(client), false);

    runtime.kill("SIGKILL");
    const exit = await heard;
    assert.equal(exit.pid, runtime.pid);
    assert.equal(exit.signal, "SIGKILL");
    assert.equal(exit.requested, false);
    assert.equal(exit.duringStartup, false);
    assert.equal(h.monitor.isLost(client), true);
    assert.equal(h.lost.length, 1);
    assert.equal(h.lost[0].client, client);
    assert.deepEqual(watch.exit(), exit);

    let late;
    h.monitor.watch(client).onExit((value) => { late = value; });
    assert.deepEqual(late, exit, "a listener on an exited runtime hears it at once");
    assert.match(copilotRuntimeExitMessage(exit), new RegExp(`^Copilot runtime exited \\(pid ${runtime.pid}, code none, signal SIGKILL\\) during the turn: Connection is closed\\.$`));
});

test("a runtime that exits before its start settles is reported as a startup exit", async (t) => {
    const h = harness();
    t.after(h.cleanup);
    const client = {};
    await assert.rejects(h.monitor.start(client, async () => {
        const runtime = h.runtime();
        runtime.kill("SIGKILL");
        await exited(runtime);
        throw new Error("CLI server exited");
    }), /CLI server exited/);
    assert.equal(h.lost.length, 1);
    assert.equal(h.lost[0].exit.duringStartup, true);
    assert.equal(h.monitor.isLost(client), true);
});

test("an exit the manager requested is not a loss", async (t) => {
    const h = harness();
    t.after(h.cleanup);
    const client = {};
    let runtime;
    await h.monitor.start(client, async () => { runtime = h.runtime(); });
    const watch = h.monitor.watch(client);
    h.monitor.markStopping(client);
    runtime.kill("SIGKILL");
    await exited(runtime);
    assert.equal(watch.exit().requested, true);
    assert.equal(h.monitor.isLost(client), false);
    assert.equal(h.lost.length, 0);
});

test("a watch stays bound to its own runtime after the client starts another", async (t) => {
    const h = harness();
    t.after(h.cleanup);
    const client = {};
    let first;
    await h.monitor.start(client, async () => { first = h.runtime(); });
    const oldWatch = h.monitor.watch(client);
    let second;
    await h.monitor.start(client, async () => { second = h.runtime(); });
    const newWatch = h.monitor.watch(client);
    assert.equal(h.monitor.pid(client), second.pid);

    first.kill("SIGKILL");
    await exited(first);
    assert.equal(oldWatch.exit()?.pid, first.pid);
    assert.equal(newWatch.exit(), null);
    assert.equal(h.monitor.isLost(client), false, "the old runtime is not the client's current one");
    assert.equal(h.lost.length, 0);

    second.kill("SIGKILL");
    await exited(second);
    assert.equal(newWatch.exit()?.pid, second.pid);
    assert.equal(h.monitor.isLost(client), true);
});

test("transport-loss messages: closed, disposed, not connected, disconnected sessions and runtime exits, but not the inactivity watchdog", () => {
    for (const message of [
        "Connection is closed.",
        "Connection is disposed.",
        "Pending response rejected since connection got disposed",
        "Client not connected. Call start() first.",
        "Session is disconnected",
        "Session disconnected while waiting for a response",
        "Copilot runtime exited (pid 1, code 137, signal none) during the turn: Connection is closed.",
    ]) {
        assert.equal(isCopilotTransportLossMessage(message), true, message);
    }
    for (const message of [
        undefined,
        "",
        "Session not found: abc",
        "Turn timed out: no SDK events for 300s (connection is closed or the subprocess is wedged)",
        "rate limited",
    ]) {
        assert.equal(isCopilotTransportLossMessage(message), false, String(message));
    }
    assert.equal(transportLossMessage("Connection is closed."), "Connection is closed.");
    assert.match(transportLossMessage("Connection is disposed."), /^Connection is disposed\. \(Connection is closed: /);
});
