import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../dist/session-manager.js";
import { registerActivities } from "../../dist/session-proxy.js";

const alice = { provider: "test", subject: "alice" };
const bob = { provider: "test", subject: "bob" };
const input = {
    sessionId: "s1", precheck: "queue", packageId: "pkg",
    reason: "poll", intervalSeconds: 300,
    agent: { boundAgentName: "poller", boundAgentPackageId: "pkg" },
};

function fixture({ scope = "shared", lookup = true, catalogAvailable = true } = {}) {
    const copy = {
        kind: "app-agent", prompt: "", packageId: "pkg",
        packageScope: scope, ...(scope === "user" ? { packageOwner: alice } : {}),
    };
    const defaults = { agentPromptLookup: lookup ? { poller: copy } : {} };
    const manager = new SessionManager(undefined, null, defaults);
    let currentOwner = alice;
    let currentRow = true;
    let callbacks = 0;
    const events = [];
    const catalog = {
        getSession: async () => currentRow ? { owner: currentOwner } : null,
        getSessionCapabilities: async () => ({ revision: 0, selections: [] }),
        recordEvents: async (_id, rows) => events.push(...rows),
    };
    if (catalogAvailable) manager.setSessionCatalog(catalog);
    manager.getOrCreate = () => { throw new Error("must not hydrate the model"); };
    manager.setPackageCronPrechecks(new Map([["pkg", new Map([["queue", {
        name: "queue", check: () => { callbacks++; return { action: "skip" }; },
    }]])]]));
    const handlers = new Map();
    registerActivities({ registerActivity: (name, handler) => handlers.set(name, handler) },
        manager, null, undefined, catalogAvailable ? catalog : null);
    return {
        call: (overrides = {}) => handlers.get("runCronPrecheck")({ traceInfo() {} }, { ...input, ...overrides }),
        defaults, events,
        callbacks: () => callbacks,
        setOwner: (owner) => { currentOwner = owner; },
        removeSession: () => { currentRow = false; },
    };
}

for (const scope of ["user", "shared"]) {
    test(`actual activity admits an authorized ${scope} callback without an MCP call`, async () => {
        const f = fixture({ scope });
        assert.equal((await f.call()).skip, true);
        assert.equal(f.callbacks(), 1);
        assert.equal(f.events[0].data.outcome, "skip");
    });
}

test("an owner change denies a warm private callback before entering package code", async () => {
    const f = fixture({ scope: "user" });
    assert.equal((await f.call()).skip, true);
    f.setOwner(bob);
    await assert.rejects(f.call(), /no longer available/);
    assert.equal(f.callbacks(), 1, "no new callback after denial");
    assert.equal(f.events.length, 1, "denial must not fabricate an idle decision");
});

test("agent removal and visibility demotion deny warm no-tools callbacks", async () => {
    for (const change of ["removed", "demoted"]) {
        const f = fixture();
        await f.call();
        if (change === "removed") delete f.defaults.agentPromptLookup.poller;
        else Object.assign(f.defaults.agentPromptLookup.poller, { packageScope: "user", packageOwner: bob });
        await assert.rejects(f.call(), /no longer available/);
        assert.equal(f.callbacks(), 1);
        assert.equal(f.events.length, 1);
    }
});

test("unknown session, unavailable catalog and unresolved bindings never enter package callbacks", async () => {
    const missing = fixture();
    missing.removeSession();
    for (const f of [missing, fixture({ catalogAvailable: false }), fixture({ lookup: false })]) {
        await assert.rejects(f.call());
        assert.equal(f.callbacks(), 0);
        assert.equal(f.events.length, 0);
    }
});

test("a schedule cannot select another package or reselect a same-name copy without a pin", async () => {
    for (const agent of [
        { boundAgentName: "poller" },
        { boundAgentName: "poller", boundAgentPackageId: "different" },
        {},
    ]) {
        const f = fixture();
        await assert.rejects(f.call({ agent }));
        assert.equal(f.callbacks(), 0);
        assert.equal(f.events.length, 0);
    }
});
