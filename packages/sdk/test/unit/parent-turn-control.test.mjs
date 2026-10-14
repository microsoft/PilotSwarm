// Session turn control: a parent agent's controls of a sub-agent's running
// turn (message_agent deliver "now", stop_agent_turn). A fake port stands in
// for the management client's Steer and Stop paths.
import test from "node:test";
import assert from "node:assert/strict";
import {
    PARENT_STOP_TIMEOUT_MS,
    parentControlRequestId,
    steerChildTurn,
    stopChildTurn,
} from "../../dist/parent-turn-control.js";

const CALLER = {
    sender: { kind: "agent", sessionId: "parent-1", display: "Coordinator" },
    viewer: { principal: { provider: "test", subject: "owner" }, isAdmin: false },
};

function fakePort({ steer, stop } = {}) {
    const calls = { steer: [], stop: [] };
    return {
        calls,
        async steerSessionTurn(sessionId, opts) { calls.steer.push({ sessionId, opts }); return steer; },
        async stopSessionTurn(sessionId, opts) { calls.stop.push({ sessionId, opts }); return stop; },
    };
}

function steerInput(queued) {
    return {
        childSessionId: "child-1",
        agentLabel: "session-child-1",
        text: "use metric units",
        requestId: parentControlRequestId("steer", "parent-1", "call-1"),
        caller: CALLER,
        queue: async () => { queued.count++; },
    };
}

test("the request id is one per tool call and kind, and fits the catalog's limit", () => {
    const steer = parentControlRequestId("steer", "parent-1", "call-1");
    assert.equal(parentControlRequestId("steer", "parent-1", "call-1"), steer);
    assert.notEqual(parentControlRequestId("steer", "parent-1", "call-2"), steer);
    assert.notEqual(parentControlRequestId("stop", "parent-1", "call-1"), steer);
    assert.notEqual(parentControlRequestId("steer", "parent-2", "call-1"), steer);
    assert.ok(parentControlRequestId("steer", "8f8b8c1e-0000-4000-8000-000000000000", "y".repeat(500)).length <= 200);
});

test("an accepted steer reports its control seq and queues nothing; a repeat reports the same seq", async () => {
    for (const steer of [{ outcome: "accepted", steerId: 41, turn: 3 }, { outcome: "accepted", steerId: 41, turn: 3, repeat: true }]) {
        const queued = { count: 0 };
        const port = fakePort({ steer });
        const result = await steerChildTurn(port, steerInput(queued));
        assert.match(result, /Steered into the running turn of sub-agent session-child-1 \(control seq 41\)/);
        assert.equal(queued.count, 0);
        assert.deepEqual(port.calls.steer, [{
            sessionId: "child-1",
            opts: { text: "use metric units", requestId: parentControlRequestId("steer", "parent-1", "call-1"), caller: CALLER },
        }]);
    }
});

test("a refused steer goes to the next turn once, and the result says why", async () => {
    const cases = {
        no_turn: /Not steered: the sub-agent had no running turn\. Queued the message for the next turn/,
        legacy_turn: /Not steered: the sub-agent's running turn does not take steers/,
        steering_disabled: /Not steered: steering is turned off for this session's owner/,
        too_many: /Not steered: the sub-agent's running turn already has 20 open steers/,
    };
    for (const [outcome, expected] of Object.entries(cases)) {
        const queued = { count: 0 };
        const result = await steerChildTurn(fakePort({ steer: { outcome } }), steerInput(queued));
        assert.match(result, expected, outcome);
        assert.equal(queued.count, 1, outcome);
    }
});

test("not_found and request_id_reused fail and send nothing", async () => {
    for (const outcome of ["not_found", "request_id_reused"]) {
        const queued = { count: 0 };
        await assert.rejects(steerChildTurn(fakePort({ steer: { outcome } }), steerInput(queued)), new RegExp(`refused \\(${outcome}\\); nothing was sent`));
        assert.equal(queued.count, 0);
    }
});

test("stop_agent_turn reports each Stop outcome with its control seq and a bounded wait", async () => {
    const cases = [
        [{ outcome: "stopped", turnIndex: 2, controlSeq: 7 }, /Stopped the current turn of sub-agent session-child-1 \(control seq 7\)\. The sub-agent stays alive/],
        [{ outcome: "stop_forced", turnIndex: 2 }, /Stopped the current turn of sub-agent session-child-1\. The sub-agent stays alive/],
        [{ outcome: "too_late", turnIndex: 2, controlSeq: 8 }, /Too late to stop: .*finished its model run when the Stop arrived \(control seq 8\)/],
        [{ outcome: "timeout", turnIndex: 2, controlSeq: 9 }, /was accepted \(control seq 9\), but its turn had not stopped within 15 s/],
        [{ outcome: "no_active_turn", detail: "no turn is running" }, /Nothing to stop: sub-agent session-child-1 has no running turn \(no turn is running\)/],
    ];
    for (const [stop, expected] of cases) {
        const port = fakePort({ stop });
        const requestId = parentControlRequestId("stop", "parent-1", "call-9");
        const result = await stopChildTurn(port, {
            childSessionId: "child-1", agentLabel: "session-child-1", reason: "wrong file", requestId, caller: CALLER,
        });
        assert.match(result, expected, stop.outcome);
        assert.deepEqual(port.calls.stop, [{
            sessionId: "child-1",
            opts: { reason: "wrong file", requestId, caller: CALLER, timeoutMs: PARENT_STOP_TIMEOUT_MS },
        }]);
    }
    assert.equal(PARENT_STOP_TIMEOUT_MS, 15_000);
});
