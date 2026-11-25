import test from "node:test";
import assert from "node:assert/strict";
import { withKillDiagnostics } from "../helpers/kill-harness.js";

test("kill scenario failures include both workers, late logs and the original cause", async () => {
    const workers = [{ id: "a", logs: Array.from({ length: 40 }, (_, i) => `a-${i}`) }];
    const original = new Error("turn 3 must commit v3");
    await assert.rejects(withKillDiagnostics(workers, async () => {
        workers.push({ id: "b", logs: ["recovered turn", "late failure detail"] });
        throw original;
    }), (error) => {
        assert.equal(error.cause, original);
        assert.match(error.message, /^turn 3 must commit v3/);
        assert.match(error.message, /worker a logs tail:\na-10\n/);
        assert.doesNotMatch(error.message, /\na-9\n/);
        assert.match(error.message, /a-39/);
        assert.match(error.message, /worker b logs tail:\nrecovered turn\nlate failure detail/);
        return true;
    });
});

test("startup failures retain diagnostics from every worker that exists", async () => {
    await assert.rejects(withKillDiagnostics([{ id: "a", logs: [] }], async () => {
        throw new Error("worker a did not start");
    }), /worker a did not start\nworker a logs tail:\n\(no output\)/);
});

test("kill diagnostics do not change successful scenario results", async () => {
    assert.equal(await withKillDiagnostics([], async () => "complete"), "complete");
});
