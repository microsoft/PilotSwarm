import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager, packageContentKey } from "../../dist/session-manager.js";
import { registerActivities } from "../../dist/session-proxy.js";

const alice = { provider: "test", subject: "alice" };
const bob = { provider: "test", subject: "bob" };
const input = {
    sessionId: "s1", precheck: "queue", packageId: "pkg",
    packageIdentity: { packageId: "pkg", versionId: "v1", sha256: "a".repeat(64) },
    packageBindingRevision: 1,
    reason: "poll", intervalSeconds: 300,
    agent: { boundAgentName: "poller", boundAgentPackageId: "pkg" },
};

function fixture({ scope = "shared", lookup = true, catalogAvailable = true } = {}) {
    const copy = {
        kind: "app-agent", prompt: "", packageId: "pkg",
        packageVersionId: "v1", packageSha256: "a".repeat(64),
        packageExecutable: true, packageActive: true,
        packageScope: scope, ...(scope === "user" ? { packageOwner: alice } : {}),
    };
    const defaults = { agentPromptLookup: lookup ? { poller: copy } : {} };
    const manager = new SessionManager(undefined, null, defaults);
    let currentOwner = alice;
    let currentRow = true;
    let callbacks = 0;
    let action = "skip";
    let binding = { ...input.packageIdentity, agentName: "poller", revision: 1, allowed: true, executable: true };
    const events = [];
    const catalog = {
        getSession: async () => currentRow ? { owner: currentOwner } : null,
        getSessionCapabilities: async () => ({ revision: 0, selections: [] }),
        recordEvents: async (_id, rows) => events.push(...rows),
        packageReviews: { getSessionBinding: async () => binding },
        packageRuntime: { context: async () => ({}) },
    };
    if (catalogAvailable) manager.setSessionCatalog(catalog);
    manager.getOrCreate = () => { throw new Error("must not hydrate the model"); };
    manager.setPackageCronPrechecks(new Map([[packageContentKey("pkg", "v1", "a".repeat(64)), new Map([["queue", {
        name: "queue", check: () => { callbacks++; return { action }; },
    }]])]]));
    manager.addCronPrecheck({ name: "trusted", check: () => { callbacks++; return { action }; } });
    const handlers = new Map();
    registerActivities({ registerActivity: (name, handler) => handlers.set(name, handler) },
        manager, null, undefined, catalogAvailable ? catalog : null);
    return {
        call: (overrides = {}) => handlers.get("runCronPrecheck")({ traceInfo() {} }, { ...input, ...overrides }),
        defaults, events, manager,
        callbacks: () => callbacks,
        setOwner: (owner) => { currentOwner = owner; },
        removeSession: () => { currentRow = false; },
        setBinding: value => { binding = value; },
        setAction: value => { action = value; },
    };
}

for (const scope of ["user", "shared"]) {
    test(`actual activity admits an authorized ${scope} callback without an MCP call`, async () => {
        const f = fixture({ scope });
        assert.equal((await f.call()).skip, true);
        assert.equal(f.callbacks(), 1);
        assert.equal(f.events[0].data.outcome, "skip");
    });

    test(`${scope} declarative static prechecks need no pin, ignore stale declarative rows and never hydrate`, async () => {
        for (const binding of [null, { ...input.packageIdentity, executable: false, allowed: false, revision: 1 }]) {
            const f = fixture({ scope });
            f.defaults.agentPromptLookup.poller.packageExecutable = false;
            f.setBinding(binding);
            const staticInput = { packageId: undefined, packageIdentity: undefined, packageBindingRevision: undefined, precheck: "trusted" };
            assert.equal((await f.call(staticInput)).skip, true);
            f.setAction("run");
            assert.equal((await f.call(staticInput)).outcome, "run");
            assert.equal(f.callbacks(), 2);
        }
    });

    test(`trusted static checks preserve ${scope} visibility without imposing executable pins`, async () => {
        const f = fixture({ scope });
        f.defaults.agentPromptLookup.poller.packageExecutable = false;
        f.setBinding(null);
        f.setOwner(null);
        if (scope === "shared") assert.equal((await f.call({ precheck: "trusted", packageId: undefined })).skip, true);
        else await assert.rejects(f.call({ precheck: "trusted", packageId: undefined }), { code: "BOUND_AGENT_PACKAGE_UNAVAILABLE" });
        assert.equal(f.callbacks(), scope === "shared" ? 1 : 0);
    });

    test(`${scope} retained executable v1 stays exact after activation, but cannot survive rebind or revocation`, async () => {
        const f = fixture({ scope });
        const old = { ...f.defaults.agentPromptLookup.poller, packageActive: false };
        const active = { ...old, packageActive: true, packageVersionId: "v2", packageSha256: "b".repeat(64) };
        f.defaults.agentPromptLookup.poller = { ...active, copies: [active, old] };
        assert.equal((await f.call()).skip, true);
        f.defaults.agentPromptLookup.poller.copies = [old];
        assert.equal((await f.call()).skip, true, "removing the old agent name from the active version does not erase an authorized exact pin");
        f.defaults.agentPromptLookup.poller.copies = [active, old];
        f.setBinding({ ...input.packageIdentity, versionId: "v2", sha256: "b".repeat(64),
            executable: true, allowed: true, agentName: "poller", revision: 2 });
        await assert.rejects(f.call(), { code: "BOUND_AGENT_PACKAGE_UNAVAILABLE" });
        f.setBinding({ ...input.packageIdentity, executable: true, allowed: false, agentName: "poller", revision: 1 });
        await assert.rejects(f.call(), { code: "BOUND_AGENT_PACKAGE_UNAVAILABLE" });
        assert.equal(f.callbacks(), 2);
    });

    test(`${scope} static callbacks cannot bypass either direction of an executable/declarative transition`, async () => {
        for (const transition of ["to-code", "from-code"]) {
            const f = fixture({ scope });
            f.defaults.agentPromptLookup.poller.packageExecutable = transition === "to-code";
            f.setBinding(transition === "to-code" ? null : {
                ...input.packageIdentity, executable: true, allowed: false, agentName: "poller", revision: 1,
            });
            await assert.rejects(f.call({ precheck: "trusted", packageId: undefined }), { code: "BOUND_AGENT_PACKAGE_UNAVAILABLE" });
            assert.equal(f.callbacks(), 0);
            assert.equal(f.events.length, 0);
        }
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
