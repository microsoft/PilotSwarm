import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { killProcessTree, processStartTimeMs, taskProcessAlive } from "../../dist/process-tree.js";

const ROOT = process.pid + 100_000;
const CHILD = ROOT + 1;
const GRANDCHILD = ROOT + 2;
const snapshot = () => [
    { ProcessId: ROOT, ParentProcessId: 1 },
    { ProcessId: CHILD, ParentProcessId: ROOT },
    { ProcessId: GRANDCHILD, ParentProcessId: CHILD },
    { ProcessId: process.pid, ParentProcessId: 0 },
];

function withWindows(exec, run, kill = () => true) {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const originalExec = childProcess.execFileSync;
    const originalKill = process.kill;
    const calls = [];
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    childProcess.execFileSync = (command, args, options) => {
        calls.push({ command, args, options });
        return exec(command, args, options);
    };
    process.kill = kill;
    syncBuiltinESMExports();
    try {
        return run(calls);
    } finally {
        Object.defineProperty(process, "platform", platform);
        childProcess.execFileSync = originalExec;
        process.kill = originalKill;
        syncBuiltinESMExports();
    }
}

test("Windows creation time comes from a bounded, hidden CIM query", () => {
    withWindows(() => "1700000000123\r\n", calls => {
        assert.equal(processStartTimeMs(ROOT), 1_700_000_000_123);
        assert.equal(calls.length, 1);
        assert.match(calls[0].command, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
        assert.ok(calls[0].args.includes("-NoProfile"));
        assert.ok(calls[0].args.includes("-NonInteractive"));
        assert.match(calls[0].args.at(-1), new RegExp(`ProcessId = ${ROOT}`));
        assert.equal(calls[0].options.windowsHide, true);
        assert.equal(calls[0].options.timeout, 5_000);
    });
});

test("invalid PIDs never reach PowerShell", () => {
    withWindows(() => { throw new Error("must not execute"); }, calls => {
        for (const pid of [0, -1, 1.5, NaN, Infinity, "123; exit"]) {
            assert.equal(processStartTimeMs(pid), undefined);
        }
        assert.equal(calls.length, 0);
    });
});

test("missing, malformed and failed Windows creation-time queries stay unknown", () => {
    for (const output of ["", "not a timestamp", "0", "-1", "null", "Infinity"]) {
        withWindows(() => output, () => assert.equal(processStartTimeMs(ROOT), undefined));
    }
    withWindows(() => { throw new Error("CIM unavailable"); }, () => {
        assert.equal(processStartTimeMs(ROOT), undefined);
    });
});

test("Windows creation time rejects a reused task PID", () => {
    const started = 1_700_000_000_000;
    withWindows(() => String(started), () => {
        assert.equal(taskProcessAlive(ROOT, started), true);
        assert.equal(taskProcessAlive(ROOT, started - 60_000), false);
    });
});

test("Windows tree cleanup uses taskkill only for the validated root PID", () => {
    withWindows(command => {
        if (command.endsWith("taskkill.exe")) return "";
        return JSON.stringify(snapshot());
    }, calls => {
        assert.equal(killProcessTree(ROOT), true);
        const taskkill = calls.find(call => call.command.endsWith("taskkill.exe"));
        assert.ok(taskkill);
        assert.deepEqual(taskkill.args, ["/F", "/T", "/PID", String(ROOT)]);
        assert.equal(taskkill.options.windowsHide, true);
        assert.equal(taskkill.options.timeout, 5_000);
    });
});

test("invalid roots and this process are never killed", () => {
    withWindows(() => { throw new Error("must not execute"); }, calls => {
        for (const pid of [0, 1, -1, 1.5, NaN, Infinity, "123", process.pid]) {
            assert.equal(killProcessTree(pid), false);
        }
        assert.equal(calls.length, 0);
    });
});

test("Windows taskkill cannot terminate an ancestor of this process", () => {
    const rows = snapshot().map(row => row.ProcessId === process.pid
        ? { ...row, ParentProcessId: GRANDCHILD } : row);
    withWindows(() => JSON.stringify(rows), calls => {
        assert.equal(killProcessTree(ROOT), false);
        assert.equal(calls.some(call => call.command.endsWith("taskkill.exe")), false);
    });
});

test("unknown or incomplete Windows process snapshots fail closed", () => {
    for (const output of [
        "", "not json", "null", "[]", "[{}]",
        JSON.stringify(snapshot().slice(0, 3)),
        JSON.stringify(snapshot().filter(row => row.ProcessId !== ROOT)),
    ]) {
        withWindows(() => output, calls => {
            assert.equal(killProcessTree(ROOT), false);
            assert.equal(calls.some(call => call.command.endsWith("taskkill.exe")), false);
        });
    }
    withWindows(() => { throw new Error("CIM unavailable"); }, () => {
        assert.equal(killProcessTree(ROOT), false);
    });
});

test("if a root exits during taskkill, only its snapshotted descendants are killed", () => {
    const killed = [];
    withWindows(command => {
        if (command.endsWith("taskkill.exe")) throw new Error("root already gone");
        return JSON.stringify(snapshot());
    }, () => {
        assert.equal(killProcessTree(ROOT), true);
        assert.deepEqual(killed, [CHILD, GRANDCHILD]);
    }, (pid, signal) => {
        if (signal === 0) return true;
        if (pid === ROOT) throw new Error("root already gone");
        killed.push(pid);
        return true;
    });
});
