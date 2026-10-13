// Session-scoped fault holds (turn control, P23): only the armed session
// blocks, hit counts are per (point, session), the hold is bounded, and the
// process-wide exit/throw actions are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { faultPoint, faultPointAsync, armFaultHold, resetFaultHolds } from "../../dist/fault-injection.js";

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
