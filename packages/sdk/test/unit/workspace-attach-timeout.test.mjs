import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { setImmediate } from "node:timers/promises";
import { registerActivities } from "../../dist/session-proxy.js";
import { PilotSwarmWorker } from "../../dist/worker.js";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";

const request = {
    sessionId: "attach-timeout-test",
    workspace: { root: "repo" },
    revision: 1,
    turnIndex: 1,
};

function activityFixture(t, timeoutMs, { extra = false } = {}) {
    const provider = createFakeWorkspaceProvider({ roots: [{ name: "repo", path: os.tmpdir() }] });
    t.after(() => provider.reset());
    provider.script({ type: "hang" }, extra ? { attachment: "reference" } : {});
    let started;
    const attaching = new Promise(resolve => { started = resolve; });
    provider.onCall((call, phase) => {
        if (phase === "call" && call.method === "ensureAttached"
            && (!extra || call.req.attachment === "reference")) started();
    });
    const activities = new Map();
    const manager = {
        getModelSummary: async () => null,
        getWorkspaceProvider: () => provider,
        withRunTurnLock: async (_sessionId, _operation, fn) => fn(),
        holdWorkspaceFolders: () => {},
        settleCheckAttaches: async () => {},
    };
    registerActivities({
        registerActivity: (name, handler) => activities.set(name, handler),
    }, manager, null, undefined, null, undefined, undefined, undefined,
    { workspaceAttachTimeoutMs: timeoutMs });
    const workspace = extra
        ? { root: "repo", extra: { reference: { root: "repo", required: true } } }
        : request.workspace;
    return {
        attaching,
        check: () => activities.get("checkWorkspace")({ traceInfo() {} }, {
            ...request, workspace, ...(extra ? { previous: request.workspace } : {}),
        }),
        turn: () => activities.get("runTurn")({ traceInfo() {} }, {
            sessionId: request.sessionId, prompt: "must not reach a model",
            config: { workspace }, turnIndex: 1,
        }),
    };
}

for (const [label, configured, deadline] of [["default", undefined, 30_000], ["configured", 90_000, 90_000]]) {
    test(`the real runTurn activity uses the ${label} workspace attachment deadline`, async t => {
        const fixture = activityFixture(t, configured);
        t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
        let settled = false;
        const pending = fixture.turn().then(result => { settled = true; return result; });
        await Promise.race([fixture.attaching, pending.then(result => assert.fail(`turn ended before attachment: ${JSON.stringify(result)}`))]);
        t.mock.timers.tick(deadline - 1);
        await setImmediate();
        assert.equal(settled, false);
        t.mock.timers.tick(1);
        const result = await pending;
        assert.equal(result.type, "wait");
        assert.equal(result.gate, "workspace");
        assert.equal(result.code, "WORKSPACE_ATTACH_TIMEOUT");
        assert.match(result.reason, new RegExp(`${deadline} ms`));
    });
}

for (const activity of ["turn", "check"]) {
    for (const extra of [false, true]) {
        if (activity === "turn" && !extra) continue;
        test(`the configured deadline reaches ${activity} ${extra ? "extra" : "working"} folder preparation`, async t => {
            const fixture = activityFixture(t, 200, { extra });
            t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
            const pending = fixture[activity]();
            await Promise.race([fixture.attaching, pending.then(result => assert.fail(`activity ended before attachment: ${JSON.stringify(result)}`))]);
            t.mock.timers.tick(200);
            const result = await pending;
            assert.equal(result.code, "WORKSPACE_ATTACH_TIMEOUT");
            assert.match(result.message ?? result.reason, /200 ms/);
        });
    }
}

test("workers reject attachment deadlines that disable or overflow a finite timer", () => {
    for (const timeout of [0, -1, 0.5, NaN, Infinity, 2_147_483_648, null, "90000"]) {
        assert.throws(() => new PilotSwarmWorker({
            store: "unused", workspaceAttachTimeoutMs: timeout,
        }), /workspaceAttachTimeoutMs must be an integer between 1 and 2147483647/);
    }
});
