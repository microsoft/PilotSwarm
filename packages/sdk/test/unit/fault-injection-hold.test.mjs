// Session-scoped fault holds (turn control, P23): only the armed session
// blocks, hit counts are per (point, session), the hold is bounded, and the
// exit/throw actions share session-scoped counting across sync/async calls.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { faultPoint, faultPointAsync, armFaultHold, resetFaultHolds } from "../../dist/fault-injection.js";

const moduleUrl = new URL("../../dist/fault-injection.js", import.meta.url).href;
// Runs `calls` in a child process with PILOTSWARM_FAULT_INJECT=spec. Each call
// prints "passed <n>" when the point returns, so stdout shows the hit at which
// the process died.
const runChild = (spec, calls, extraEnv = {}) => {
    const script = `
        const { faultPoint, faultPointAsync } = await import(${JSON.stringify(moduleUrl)});
        let n = 0;
        for (const call of ${JSON.stringify(calls)}) {
            n += 1;
            if (call.async) await faultPointAsync(call.point, call.sessionId ? { sessionId: call.sessionId } : {});
            else faultPoint(call.point, call.sessionId);
            console.log("passed " + n);
        }
        console.log("finished");
    `;
    const env = { ...process.env, PILOTSWARM_FAULT_INJECT: spec, ...extraEnv };
    delete env.PILOTSWARM_FAULT_RELEASE_DIR;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
    return { status: run.status, passed: run.stdout.trim().split("\n").filter(Boolean), stderr: run.stderr };
};

const withEnv = async (vars, fn) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try { return await fn(); } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        resetFaultHolds();
    }
};
const settled = async (promise, ms) => Promise.race([promise.then(() => "done", (e) => `error:${e.message}`), new Promise((r) => setTimeout(() => r("pending"), ms))]);

test("an armed hold blocks only its session until the release file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-hold-"));
    try {
        await withEnv({ PILOTSWARM_FAULT_RELEASE_DIR: dir }, async () => {
            armFaultHold("turn.control.before-writeback", "s1");
            const held = faultPointAsync("turn.control.before-writeback", { sessionId: "s1" });
            assert.equal(await settled(faultPointAsync("turn.control.before-writeback", { sessionId: "s2" }), 200), "done", "another session passes");
            assert.equal(await settled(faultPointAsync("turn.control.before-send", { sessionId: "s1" }), 200), "done", "another point passes");
            assert.equal(await settled(held, 200), "pending");
            writeFileSync(join(dir, "turn.control.before-writeback.s1"), "");
            assert.equal(await settled(held, 2000), "done");
        });
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("environment entries arm a hold for one session, counted per session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-hold-"));
    try {
        await withEnv({ PILOTSWARM_FAULT_RELEASE_DIR: dir, PILOTSWARM_FAULT_INJECT: "turn.control.before-send:hold@s1:2" }, async () => {
            faultPoint("turn.control.before-send");
            assert.equal(await settled(faultPointAsync("turn.control.before-send", { sessionId: "s2" }), 200), "done");
            assert.equal(await settled(faultPointAsync("turn.control.before-send", { sessionId: "s2" }), 200), "done", "s2 hits do not count for s1");
            assert.equal(await settled(faultPointAsync("turn.control.before-send", { sessionId: "s1" }), 200), "done", "first s1 hit passes");
            const held = faultPointAsync("turn.control.before-send", { sessionId: "s1" });
            assert.equal(await settled(held, 200), "pending", "second s1 hit holds");
            writeFileSync(join(dir, "turn.control.before-send.s1"), "");
            assert.equal(await settled(held, 2000), "done");
        });
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a hold that is never released throws after the bound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-hold-"));
    try {
        await withEnv({ PILOTSWARM_FAULT_RELEASE_DIR: dir, PILOTSWARM_FAULT_HOLD_MAX_MS: "300" }, async () => {
            armFaultHold("turn.control.before-send", "s1");
            await assert.rejects(faultPointAsync("turn.control.before-send", { sessionId: "s1" }), /was not released within 300 ms/);
        });
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a hold without a release folder fails loudly", async () => {
    await withEnv({ PILOTSWARM_FAULT_RELEASE_DIR: "" }, async () => {
        delete process.env.PILOTSWARM_FAULT_RELEASE_DIR;
        armFaultHold("turn.control.before-send", "s1");
        await assert.rejects(faultPointAsync("turn.control.before-send", { sessionId: "s1" }), /PILOTSWARM_FAULT_RELEASE_DIR/);
    });
});

test("throw entries still fire through faultPointAsync and faultPoint", async () => {
    await withEnv({ PILOTSWARM_FAULT_INJECT: "unit.hold.throw-point:throw" }, async () => {
        assert.throws(() => faultPoint("unit.hold.throw-point"), /fault-injection: unit.hold.throw-point/);
    });
    await withEnv({ PILOTSWARM_FAULT_INJECT: "unit.hold.throw-point2:throw" }, async () => {
        await assert.rejects(faultPointAsync("unit.hold.throw-point2", { sessionId: "s1" }), /fault-injection: unit.hold.throw-point2/);
    });
});

test("with nothing armed, points are no-ops", async () => {
    await withEnv({ PILOTSWARM_FAULT_INJECT: "" }, async () => {
        delete process.env.PILOTSWARM_FAULT_INJECT;
        faultPoint("turn.control.before-send");
        await faultPointAsync("turn.control.before-send", { sessionId: "s1" });
        await faultPointAsync("turn.control.before-send");
    });
});

test("exit (explicit and default) still ends the process with 137 at the configured hit", () => {
    const p = "unit.exit.point";
    const sync = (n) => Array.from({ length: n }, () => ({ point: p }));
    assert.deepEqual(runChild(`${p}:exit`, sync(3)).status, 137);
    assert.deepEqual(runChild(`${p}:exit`, sync(3)).passed, []);
    assert.deepEqual(runChild(p, sync(3)).status, 137, "exit is the default action");
    const third = runChild(`${p}:exit:3`, sync(5));
    assert.equal(third.status, 137);
    assert.deepEqual(third.passed, ["passed 1", "passed 2"], "dies on the 3rd hit");
    assert.equal(runChild(`${p}:exit`, [{ point: "unit.other.point" }]).status, 0, "other points are untouched");
});

test("exit fires through the async entry point as well", () => {
    const p = "unit.exit.async";
    const run = runChild(`${p}:exit:2`, [{ point: p, async: true, sessionId: "s1" }, { point: p, async: true, sessionId: "s1" }, { point: p, async: true }]);
    assert.equal(run.status, 137);
    assert.deepEqual(run.passed, ["passed 1"]);
});

test("a hold entry at the same point does not change exit counting", () => {
    const p = "unit.exit.coexist";
    const syncRun = runChild(`${p}:hold@s9,${p}:exit:2`, [{ point: p }, { point: p }, { point: p }]);
    assert.equal(syncRun.status, 137);
    assert.deepEqual(syncRun.passed, ["passed 1"], "exit still fires on the 2nd process-wide hit");
    const asyncRun = runChild(`${p}:exit:2,${p}:hold@s9`, [{ point: p, async: true, sessionId: "s1" }, { point: p, async: true, sessionId: "s2" }]);
    assert.equal(asyncRun.status, 0, "each session has only one hit");
    assert.deepEqual(asyncRun.passed, ["passed 1", "passed 2", "finished"]);
    const unarmed = runChild(`${p}:hold@s9`, [{ point: p }, { point: p, async: true, sessionId: "s1" }]);
    assert.equal(unarmed.status, 0, "a hold entry alone never exits");
    assert.deepEqual(unarmed.passed, ["passed 1", "passed 2", "finished"]);
});

for (const async of [false, true]) {
    test(`${async ? "async" : "sync"} exit timing ignores other sessions, points and unscoped hits`, () => {
        const p = "unit.exit.scoped";
        const call = (sessionId, point = p) => ({ point, sessionId, async });
        const run = runChild(`${p}:exit:3,unit.other:exit:3`, [
            call("other"), call("target"), call(), call("other"), call("target", "unit.other"),
            call("target"), call(), call("target"), call("target"),
        ]);
        assert.equal(run.status, 137);
        assert.deepEqual(run.passed, Array.from({ length: 7 }, (_, i) => `passed ${i + 1}`),
            "only target's third hit at this point exits");
        const lines = run.stderr.trim().split(/\r?\n/);
        assert.equal(lines.length, 8, "every armed hit is logged, not just the firing hit");
        assert.match(lines[1], /hit=1\/3 session=target fired=false$/);
        assert.match(lines[2], /hit=1\/3 session=<process> fired=false$/);
        assert.match(lines[5], /hit=2\/3 session=target fired=false$/);
        assert.match(lines[7], /hit=3\/3 session=target fired=true$/);
    });
}

test("sync and async share a session's counter but not the legacy counter", () => {
    const p = "unit.exit.mixed";
    const run = runChild(`${p}:exit:2`, [
        { point: p, sessionId: "target" },
        { point: p, async: true },
        { point: p, sessionId: "other", async: true },
        { point: p, sessionId: "target", async: true },
    ]);
    assert.equal(run.status, 137);
    assert.deepEqual(run.passed, ["passed 1", "passed 2", "passed 3"]);
    const legacy = runChild(`${p}:exit:2`, [{ point: p }, { point: p, async: true }]);
    assert.equal(legacy.status, 137, "no-session calls retain shared process-wide counting");
    assert.deepEqual(legacy.passed, ["passed 1"]);
});

test("throw and log actions use scoped counters and retain post-threshold behavior", async () => {
    for (const async of [false, true]) {
        const point = `unit.throw.scoped.${async}`;
        await withEnv({ PILOTSWARM_FAULT_INJECT: `${point}:throw:2` }, async () => {
            const call = (sessionId) => async ? faultPointAsync(point, { sessionId }) : faultPoint(point, sessionId);
            await call("other");
            await call("target");
            if (async) {
                await assert.rejects(call("target"), new RegExp(`fault-injection: ${point}`));
                await assert.rejects(call("target"), new RegExp(`fault-injection: ${point}`));
            } else {
                assert.throws(() => call("target"), new RegExp(`fault-injection: ${point}`));
                assert.throws(() => call("target"), new RegExp(`fault-injection: ${point}`));
            }
        });
    }
    const p = "unit.log.scoped";
    const run = runChild(`${p}:log:2`, [
        { point: p, sessionId: "other" }, { point: p, sessionId: "target" },
        { point: p, sessionId: "target", async: true }, { point: p, sessionId: "target" },
    ]);
    assert.equal(run.status, 0);
    assert.deepEqual(run.passed, ["passed 1", "passed 2", "passed 3", "passed 4", "finished"]);
    assert.match(run.stderr, /hit=1\/2 session=other fired=false/);
    assert.match(run.stderr, /hit=1\/2 session=target fired=false/);
    assert.match(run.stderr, /hit=2\/2 session=target fired=true/);
    assert.match(run.stderr, /hit=3\/2 session=target fired=true/);
});

test("disabled and unmatched points do not count or log", () => {
    for (const spec of ["", "unit.unrelated:exit"]) {
        const run = runChild(spec, [{ point: "unit.disabled", sessionId: "s1" }, { point: "unit.disabled", async: true }]);
        assert.equal(run.status, 0);
        assert.equal(run.stderr, "");
    }
});

test("a throw entry at a held point throws before the hold waits", () => {
    const p = "unit.throw.coexist";
    const run = runChild(`${p}:hold@s1,${p}:throw`, [{ point: p, async: true, sessionId: "s1" }]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /fault-injection: unit.throw.coexist/);
    assert.doesNotMatch(run.stderr, /hold point=/);
});
