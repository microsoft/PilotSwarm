import { afterEach, describe, expect, it, vi } from "vitest";
import { PilotSwarmClient } from "../../src/client.ts";
import { PilotSwarmManagementClient } from "../../src/management-client.ts";
import { cancelSession } from "../../src/orchestration/agents.ts";
import { createSessionManagerProxy, registerActivities } from "../../src/session-proxy.ts";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";

const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });
const permanent = () => Object.assign(new Error("delete refused"), { code: "42501" });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function drive(generator) {
    let next = generator.next();
    while (!next.done) {
        let result;
        try { result = await next.value; }
        catch (error) { next = generator.throw(error); continue; }
        next = generator.next(result);
    }
}

function orchestration({ listError = false, failed = [] } = {}) {
    const values = new Map(), deleted = [], states = [], statuses = [];
    const runtime = {
        input: { sessionId: "root" }, options: {},
        state: { iteration: 1, subAgents: [], carriedSteers: [], orchestrationResult: null },
        session: { destroy: async () => {} },
        ctx: {
            traceInfo() {}, utcNow: () => 1000,
            getValue: key => values.get(key) ?? null,
            setValue: (key, value) => values.set(key, value),
            setCustomStatus: value => statuses.push(JSON.parse(value)),
        },
        manager: {
            getDescendantSessionIds: async () => {
                if (listError) throw permanent();
                return ["bad", "good"];
            },
            deleteSession: async id => {
                if (failed.includes(id)) throw permanent();
                deleted.push(id);
            },
            recordSessionEvent: async () => {},
            recordSessionEvents: async () => {},
            updateCmsState: async (_id, state) => states.push(state),
        },
    };
    return { runtime, deleted, states, statuses, responses: () => [...values.values()]
        .map(value => { try { return JSON.parse(value); } catch { return null; } })
        .filter(value => value?.cmd === "delete") };
}

describe("FB-037: live 1.0.85 delete reports the whole subtree outcome", () => {
    it("deletes a clean tree and replies only after deleting the root", async () => {
        const h = orchestration();
        await drive(cancelSession(h.runtime, "cleanup", "delete-clean", true));
        expect(h.deleted).toEqual(["bad", "good", "root"]);
        expect(h.responses().map(response => response.result?.ok)).toEqual([true]);
    });

    it.each([
        { failed: ["bad"] },
        { listError: true },
    ])("keeps the root and publishes failure for %j", async options => {
        const h = orchestration(options);
        await drive(cancelSession(h.runtime, "cleanup", "delete-failed", true));
        expect(h.deleted).not.toContain("root");
        if (!options.listError) expect(h.deleted).toContain("good");
        else expect(h.deleted).toEqual([]);
        expect(h.runtime.state.orchestrationResult).toBe("failed");
        expect(h.states).toContain("failed");
        expect(h.statuses.some(status => status.status === "failed")).toBe(true);
        expect(h.responses()).toHaveLength(1);
        expect(h.responses()[0].error).toBeTruthy();
        expect(h.responses()[0].result?.ok).not.toBe(true);
    });
});

function tree({ fail = null, enumerationFails = false, transientFailures = 0 } = {}) {
    const rows = new Map([
        ["root", { sessionId: "root", state: "completed", parentSessionId: null }],
        ["branch", { sessionId: "branch", state: "completed", parentSessionId: "root" }],
        ["leaf", { sessionId: "leaf", state: "completed", parentSessionId: "branch" }],
        ["sibling", { sessionId: "sibling", state: "completed", parentSessionId: "root" }],
    ]);
    const deleted = [], attempts = [];
    // Deliberately neither preorder nor postorder: SQL promises no ordering.
    const descendants = id => ["branch", "sibling", "leaf"].filter(candidate => {
        if (!rows.has(candidate)) return false;
        let parent = rows.get(candidate).parentSessionId;
        while (parent) {
            if (parent === id) return true;
            parent = rows.get(parent)?.parentSessionId;
        }
        return false;
    });
    const catalog = {
        getSession: vi.fn(async id => rows.get(id) ?? null),
        getDescendantSessionIds: vi.fn(async id => {
            if (enumerationFails) throw permanent();
            return descendants(id);
        }),
        updateSession: async () => {},
        softDeleteSession: vi.fn(async id => {
            attempts.push(id);
            if (id === fail) throw permanent();
            if (transientFailures-- > 0) throw deadlock();
            rows.delete(id); deleted.push(id);
        }),
    };
    const sdk = new PilotSwarmClient({});
    sdk._catalog = catalog;
    sdk.duroxideClient = { cancelInstance: vi.fn(async () => {}) };
    const management = new PilotSwarmManagementClient({});
    management._catalog = catalog;
    management._ensureStarted = () => {};
    management.getSession = async id => {
        const row = rows.get(id);
        return row ? { ...row, status: "completed", orchestrationStatus: "Completed" } : null;
    };
    management._duroxideClient = { deleteInstance: vi.fn(async () => {}) };
    return { rows, deleted, attempts, catalog, sdk, management };
}

describe.each(["sdk", "management"])("FB-037: %s cascade preserves reachability", kind => {
    it("deletes leaves before their parents", async () => {
        const h = tree();
        await h[kind].deleteSession("root");
        expect(h.rows.size).toBe(0);
        expect(h.deleted.indexOf("leaf")).toBeLessThan(h.deleted.indexOf("branch"));
        expect(h.deleted.at(-1)).toBe("root");
    });

    it("retains a failed grandchild and every ancestor, but removes an independent sibling", async () => {
        const h = tree({ fail: "leaf" });
        await expect(h[kind].deleteSession("root")).rejects.toThrow();
        expect([...h.rows.keys()].sort()).toEqual(["branch", "leaf", "root"]);
        expect(h.deleted).toEqual(["sibling"]);
    });

    it("does not delete anything when the subtree cannot be enumerated", async () => {
        const h = tree({ enumerationFails: true });
        await expect(h[kind].deleteSession("root")).rejects.toThrow();
        expect(h.deleted).toEqual([]);
    });

    it("keeps a reachable subtree when runtime cancellation cannot be confirmed", async () => {
        const h = tree();
        const runtime = {
            cancelInstance: async () => { throw permanent(); },
            deleteInstance: async () => { throw permanent(); },
            getStatus: async () => ({ status: "Running" }),
        };
        h.sdk.duroxideClient = runtime;
        h.management._duroxideClient = runtime;
        await expect(h[kind].deleteSession("root")).rejects.toThrow();
        expect(h.deleted).toEqual([]);
    });

    it("retains every ancestor when the fallback runtime status read rejects", async () => {
        const h = tree();
        const runtime = {
            cancelInstance: async () => { throw permanent(); },
            deleteInstance: async () => { throw permanent(); },
            getStatus: async () => { throw new Error("runtime status unavailable"); },
        };
        h.sdk.duroxideClient = runtime;
        h.management._duroxideClient = runtime;
        await expect(h[kind].deleteSession("root")).rejects.toThrow();
        expect(h.deleted).toEqual([]);
        expect(h.rows.size).toBe(4);
    });

    it.each(["NotFound", "Completed", "Failed", "Cancelled"])("permits guarded deletion after confirmed %s", async status => {
        const h = tree();
        const runtime = {
            cancelInstance: async () => { throw permanent(); },
            deleteInstance: async () => { throw permanent(); },
            getStatus: vi.fn(async () => ({ status })),
        };
        h.sdk.duroxideClient = runtime;
        h.management._duroxideClient = runtime;
        await h[kind].deleteSession("root");
        expect(h.rows.size).toBe(0);
        expect(runtime.getStatus).toHaveBeenCalledTimes(4);
        expect(h.catalog.softDeleteSession.mock.calls.every(([, opts]) => opts.requireNoLiveChildren)).toBe(true);
    });
});

it("management deletion does not treat a failed status read as proof of deletion", async () => {
    const h = tree();
    h.management.getSession = vi.fn().mockResolvedValueOnce({
        sessionId: "root", status: "running", orchestrationStatus: "Running",
    }).mockRejectedValue(permanent());
    h.management._sendLifecycleCommand = vi.fn(async () => {});
    await expect(h.management.deleteSession("root")).rejects.toThrow("delete refused");
});

describe("FB-038: the registered listing activity's actual retry schedule", () => {
    it("refuses strict enumeration without a catalog instead of returning an empty subtree", async () => {
        const handlers = new Map();
        registerActivities({ registerActivity: (name, fn) => handlers.set(name, fn) }, {}, null);
        await expect(handlers.get("getDescendantSessionIds")({ traceInfo() {} }, { sessionId: "root", strictCascade: true }))
            .rejects.toThrow("catalog");
    });

    it("exhausts below the caller's 65-second settle wait, without an empty-list fallback", async () => {
        vi.useFakeTimers();
        const handlers = new Map();
        const getDescendantSessionIds = vi.fn(async () => { throw deadlock(); });
        registerActivities({ registerActivity: (name, fn) => handlers.set(name, fn) }, {}, null,
            undefined, { getDescendantSessionIds });
        const began = Date.now();
        const result = handlers.get("getDescendantSessionIds")({ traceInfo() {} }, { sessionId: "root", strictCascade: true })
            .then(() => ({ ok: true }), error => ({ ok: false, error }));
        await vi.runAllTimersAsync();
        expect(await result).toMatchObject({ ok: false, error: { code: "40P01" } });
        expect(getDescendantSessionIds).toHaveBeenCalledTimes(5);
        expect(Date.now() - began).toBe(33_000);
        expect(Date.now() - began).toBeLessThan(65_000);
    });

    it("bounds stalled attempts, not just the sleeps between failures", async () => {
        vi.useFakeTimers();
        const handlers = new Map();
        const getDescendantSessionIds = vi.fn(() => new Promise(() => {}));
        registerActivities({ registerActivity: (name, fn) => handlers.set(name, fn) }, {}, null,
            undefined, { getDescendantSessionIds });
        const began = Date.now();
        let outcome;
        handlers.get("getDescendantSessionIds")({ traceInfo() {} }, { sessionId: "root", strictCascade: true })
            .then(() => { outcome = { ok: true }; }, error => { outcome = { ok: false, error }; });
        await vi.runAllTimersAsync();
        expect(outcome).toMatchObject({ ok: false });
        expect(getDescendantSessionIds).toHaveBeenCalledTimes(5);
        expect(Date.now() - began).toBeLessThan(65_000);
    });
});

describe("strict cascade input is live-only", () => {
    it("omits unused options and preserves the frozen input bytes", () => {
        const scheduleActivity = vi.fn();
        const manager = createSessionManagerProxy({ scheduleActivity });
        manager.getDescendantSessionIds("root");
        manager.deleteSession("root", "cleanup");
        expect(JSON.stringify(scheduleActivity.mock.calls)).toBe(
            '[["getDescendantSessionIds",{"sessionId":"root"}],["deleteSession",{"sessionId":"root","reason":"cleanup"}]]');
    });

    it("carries the explicit live guard and a shared deadline without setting selfDelete", () => {
        const scheduleActivity = vi.fn();
        const manager = createSessionManagerProxy({ scheduleActivity });
        manager.deleteSession("child", "cleanup", undefined, { strictCascade: true, deadlineAtMs: 50_000 });
        expect(scheduleActivity).toHaveBeenCalledWith("deleteSession", {
            sessionId: "child", reason: "cleanup", strictCascade: true, deadlineAtMs: 50_000,
        });
    });

    it("drives a frozen-shaped delete activity through exactly the legacy unchecked cascade", async () => {
        const h = tree({ fail: "leaf" });
        vi.spyOn(PilotSwarmClient.prototype, "start").mockImplementation(async function () {
            this._catalog = h.catalog;
            this.duroxideClient = { cancelInstance: async () => {} };
        });
        vi.spyOn(PilotSwarmClient.prototype, "stop").mockResolvedValue();
        const handlers = new Map();
        registerActivities({ registerActivity: (name, fn) => handlers.set(name, fn) }, {}, null,
            undefined, h.catalog, undefined, "fixture://legacy-delete");
        await handlers.get("deleteSession")({ traceInfo() {} }, { sessionId: "root", reason: "cleanup" });
        expect(h.rows.has("root")).toBe(false);
        expect(h.rows.has("leaf")).toBe(true);
        expect(h.catalog.softDeleteSession.mock.calls.every(call => call.length === 1)).toBe(true);
    });

    it("fails a late-dequeued strict delete without starting a client or a database attempt", async () => {
        const start = vi.spyOn(PilotSwarmClient.prototype, "start").mockResolvedValue();
        const handlers = new Map();
        registerActivities({ registerActivity: (name, fn) => handlers.set(name, fn) }, {}, null,
            undefined, {}, undefined, "fixture://late-delete");
        await expect(handlers.get("deleteSession")({ traceInfo() {} },
            { sessionId: "root", strictCascade: true, deadlineAtMs: Date.now() - 1 }))
            .rejects.toMatchObject({ code: "SESSION_DELETE_DEADLINE" });
        expect(start).not.toHaveBeenCalled();
    });

    it.each(["reject", "hang"])("keeps confirmed deletion successful when client stop will %s", async stop => {
        vi.useFakeTimers();
        const h = tree();
        vi.spyOn(PilotSwarmClient.prototype, "start").mockImplementation(async function () {
            this._catalog = h.catalog;
            this.duroxideClient = { cancelInstance: async () => {} };
        });
        vi.spyOn(PilotSwarmClient.prototype, "stop").mockImplementation(() =>
            stop === "hang" ? new Promise(() => {}) : Promise.reject(new Error("client stop failed")));
        const handlers = new Map(), traceInfo = vi.fn();
        registerActivities({ registerActivity: (name, fn) => handlers.set(name, fn) }, {}, null,
            undefined, h.catalog, undefined, "fixture://cleanup-failure");
        const began = Date.now();
        const result = handlers.get("deleteSession")({ traceInfo }, {
            sessionId: "root", strictCascade: true, deadlineAtMs: began + 1000,
        }).then(() => ({ ok: true }), error => ({ ok: false, error }));
        await vi.runAllTimersAsync();
        expect(await result).toEqual({ ok: true });
        expect(h.rows.size).toBe(0);
        expect(traceInfo.mock.calls.some(([message]) =>
            message.includes(stop === "hang" ? "cleanup outlived" : "client stop failed"))).toBe(true);
        expect(Date.now() - began).toBeLessThanOrEqual(1000);
    });
});

describe("FB-039: terminal inline child deletion uses the same bounded retries", () => {
    it("recovers from a transient soft-delete failure without reporting failure or losing descendants", async () => {
        vi.useFakeTimers();
        const h = tree({ transientFailures: 1 });
        vi.spyOn(PilotSwarmClient.prototype, "start").mockImplementation(async function () {
            this._catalog = h.catalog;
            this.duroxideClient = { cancelInstance: async () => {} };
        });
        vi.spyOn(PilotSwarmClient.prototype, "stop").mockResolvedValue();
        vi.spyOn(PilotSwarmClient.prototype, "listSessions").mockResolvedValue([
            { sessionId: "root", parentSessionId: "parent", status: "completed" },
        ]);
        vi.spyOn(PilotSwarmClient.prototype, "_getSessionInfo").mockResolvedValue({
            sessionId: "root", parentSessionId: "parent", status: "completed",
        });
        let response;
        const turn = makeRunTurnHarness({
            catalogExtras: { getChildOutcome: async () => null },
            turn: async opts => {
                response = await opts.controlToolBridge.deleteAgent({ agent_id: "root" });
                return { type: "completed", content: "ok", events: [] };
            },
        });
        registerActivities({ registerActivity: (name, fn) => { turn.handlers[name] = fn; } },
            turn.sessionManager, null, undefined, turn.catalog, undefined, "fixture://delete-cascade");
        const pending = turn.runTurn("parent");
        await vi.runAllTimersAsync();
        await pending;
        expect(response).toContain("has been deleted");
        expect(h.rows.size).toBe(0);
        expect(h.attempts.filter(id => id === h.attempts[0])).toHaveLength(2);
    });
});
