import { describe, it, expect } from "vitest";
import { FEATURE_ALWAYS_ON_NOTICE, FEATURE_FLAGS, FeatureFlagError, assertFeatureMutable, isAlwaysOn, resolveFeatureDefinition } from "../../src/feature-flags.ts";
import { FeatureFlagCache } from "../../src/feature-flag-cache.ts";

// Generic flag machinery runs on a normal (not always-on) flag.
const key = "debug.enable_model_event_logging";
const owner = { provider: "test", subject: "alice" };
const def = (revision = "1") => ({ featureKey: key, ...FEATURE_FLAGS[key], revision });
const cluster = (enabled, allowUserOverride) => ({ featureKey: key, scope: "cluster", userId: null, enabled, allowUserOverride, revision: "1" });
const user = enabled => ({ featureKey: key, scope: "user", userId: 1, owner, enabled, allowUserOverride: null, revision: "1" });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
    let snapshot = { definitions: [def()], settings: [] }; let failed = false; let reads = 0;
    const store = { revisions: async () => { if (failed) throw new Error("offline"); return snapshot.definitions.map(({ featureKey, revision }) => ({ featureKey, revision })); },
        snapshot: async () => { reads++; return structuredClone(snapshot); } };
    return { cache: new FeatureFlagCache(store), store, set: value => { snapshot = value; }, fail: value => { failed = value; }, reads: () => reads };
}

describe("feature resolution", () => {
    for (const enabled of [false, true]) for (const override of [false, true]) for (const preference of [undefined, false, true]) {
        it(`cluster=${enabled} override=${override} user=${preference}`, () => {
            const decision = resolveFeatureDefinition(def(), cluster(enabled, override), preference === undefined ? undefined : user(preference));
            expect(decision.enabled).toBe(override && preference !== undefined ? preference : enabled);
            expect(decision.source).toBe(override && preference !== undefined ? "user" : "cluster");
        });
    }
    it("published defaults apply only when cluster/user entries are absent", () => {
        expect(resolveFeatureDefinition({ ...def(), defaultEnabled: true }).enabled).toBe(true);
        expect(resolveFeatureDefinition({ ...def(), defaultEnabled: true }, cluster(false, false)).enabled).toBe(false);
    });
    it("requires an explicit fallback or error policy, including runtime callers", () => {
        const { cache } = fixture();
        for (const options of [undefined, {}, { required: false }, { required: true, fallback: false }, { fallback: "false" }]) {
            expect(() => cache.resolve(key, owner, options)).toThrow(TypeError);
        }
        expect(cache.resolve(key, owner, { fallback: true })).toMatchObject({ enabled: true, source: "fallback", reason: "cache_unavailable" });
        expect(cache.resolve(key, owner, { fallback: false }).enabled).toBe(false);
        expect(() => cache.resolve(key, owner, { required: true })).toThrow(/cache_unavailable/);
        expect(cache.resolve("typo", owner, { fallback: false }).reason).toBe("unknown_key");
        expect(() => cache.resolve("typo", owner, { required: true })).toThrow(/unknown_key/);
    });
    it("does not replace a resolved false with fallback true", async () => {
        const { cache } = fixture(); await cache.pollRevisionsAndRefresh();
        expect(cache.resolve(key, owner, { fallback: true })).toMatchObject({ enabled: false, source: "default" });
    });
});

describe("feature worker cache", () => {
    it("adopts scoped changes and deletes across two workers without lookup I/O", async () => {
        const f = fixture(); const second = new FeatureFlagCache(f.store);
        await Promise.all([f.cache.pollRevisionsAndRefresh(), second.pollRevisionsAndRefresh()]);
        f.set({ definitions: [def("2")], settings: [cluster(false, true), user(true)] });
        await f.cache.pollRevisionsAndRefresh();
        expect(f.cache.resolve(key, owner, { required: true }).enabled).toBe(true);
        expect(second.resolve(key, owner, { required: true }).enabled).toBe(false);
        expect(f.cache.resolve(key, { ...owner, subject: "bob" }, { required: true }).enabled).toBe(false);
        await second.pollRevisionsAndRefresh();
        expect(second.resolve(key, owner, { required: true }).enabled).toBe(true);
        const before = f.reads();
        for (let i = 0; i < 100; i++) f.cache.resolve(key, owner, { required: true });
        await f.cache.pollRevisionsAndRefresh(); expect(f.reads()).toBe(before);
        f.set({ definitions: [def("3")], settings: [cluster(false, true)] });
        await f.cache.pollRevisionsAndRefresh();
        expect(f.cache.resolve(key, owner, { required: true }).enabled).toBe(false);
        f.set({ definitions: [], settings: [] }); await f.cache.pollRevisionsAndRefresh();
        expect(f.cache.resolve(key, owner, { fallback: true })).toMatchObject({ enabled: true, reason: "catalog_missing" });
        expect(() => f.cache.resolve(key, owner, { required: true })).toThrow(/catalog_missing/);
    });
    it("retains last good data on errors, retries unchanged desired revisions, rejects stale snapshots", async () => {
        const f = fixture(); f.set({ definitions: [def("2")], settings: [cluster(true, false)] });
        await f.cache.pollRevisionsAndRefresh(); f.fail(true); await f.cache.pollRevisionsAndRefresh();
        expect(f.cache.resolve(key, owner, { fallback: false })).toMatchObject({ enabled: true, stale: true, revision: "2" });
        f.fail(false); f.set({ definitions: [def("1")], settings: [] }); await f.cache.pollRevisionsAndRefresh();
        expect(f.cache.state.lastError).toMatch(/stale/);
        expect(f.cache.resolve(key, owner, { required: true }).revision).toBe("2");
        f.set({ definitions: [def("3")], settings: [cluster(false, false)] });
        const original = f.store.snapshot; f.store.snapshot = async () => { throw new Error("temporary read failure"); };
        await f.cache.pollRevisionsAndRefresh(); expect(f.cache.state.appliedRevisions[key]).toBe("2");
        f.store.snapshot = original; await f.cache.pollRevisionsAndRefresh();
        expect(f.cache.resolve(key, owner, { required: true })).toMatchObject({ enabled: false, revision: "3", stale: false });
    });
    it("does not partially publish invalid settings or alias store objects", async () => {
        const f = fixture(); await f.cache.pollRevisionsAndRefresh();
        const valid = { definitions: [def("2")], settings: [cluster(true, false)] };
        f.store.snapshot = async () => valid; f.set(valid); await f.cache.pollRevisionsAndRefresh();
        valid.settings[0].enabled = false;
        expect(f.cache.resolve(key, owner, { required: true }).enabled).toBe(true);
        const bad = { definitions: [def("3")], settings: [cluster(false, false), cluster(true, true)] };
        f.set(bad); f.store.snapshot = async () => bad; await f.cache.pollRevisionsAndRefresh();
        expect(f.cache.state.lastError).toMatch(/Invalid/);
        expect(f.cache.resolve(key, owner, { required: true }).revision).toBe("2");
    });
    it("coalesces overlapping polls and discards a load completed after shutdown", async () => {
        const load = deferred(); const started = deferred(); let calls = 0; let changes = 0;
        const cache = new FeatureFlagCache({ revisions: async () => [{ featureKey: key, revision: "1" }], snapshot: () => { calls++; started.resolve(); return load.promise; } });
        cache.onChange(() => { changes++; });
        const a = cache.pollRevisionsAndRefresh(); const b = cache.pollRevisionsAndRefresh();
        await started.promise; expect(calls).toBe(1);
        const stopped = cache.stop(); load.resolve({ definitions: [def()], settings: [] });
        await Promise.all([a, b, stopped]); expect(changes).toBe(0); expect(cache.state.initialized).toBe(false);
        await cache.pollRevisionsAndRefresh(); expect(calls).toBe(1);
    });
});


describe("bounded feature cache reads", () => {
    it("fails closed on startup and permits shutdown when a store never responds", async () => {
        const cache = new FeatureFlagCache({ revisions: () => new Promise(() => {}), snapshot: () => new Promise(() => {}) }, 20);
        const pending = cache.pollRevisionsAndRefresh();
        await pending;
        expect(cache.resolve(key, null, { fallback: false })).toMatchObject({ enabled: false, stale: true, reason: "cache_unavailable" });
        expect(cache.state.lastError).toContain("timed out");
        await cache.stop();
    });
});

describe("always-on flags", () => {
    const ALWAYS_ON = ["copilot.native_tasks", "agents.base_v2", "sessions.steering"];
    const ON = { enabled: true, source: "always_on", revision: null, stale: false };
    const aliceOff = alwaysKey => ({ featureKey: alwaysKey, scope: "user", userId: 1, owner, enabled: false, allowUserOverride: null, revision: "1" });
    const clusterOff = alwaysKey => ({ featureKey: alwaysKey, scope: "cluster", userId: null, enabled: false, allowUserOverride: true, revision: "1" });
    const alwaysDef = alwaysKey => ({ featureKey: alwaysKey, ...FEATURE_FLAGS[alwaysKey], defaultEnabled: false, revision: "1" });

    it("the registry marks exactly the code-owned keys; model event logging stays a normal flag", () => {
        expect(Object.keys(FEATURE_FLAGS).filter(isAlwaysOn).sort()).toEqual([...ALWAYS_ON].sort());
        expect(isAlwaysOn(key)).toBe(false);
        expect(FEATURE_FLAGS[key].defaultEnabled).toBe(false);
        expect(isAlwaysOn("typo")).toBe(false);
        expect(FEATURE_ALWAYS_ON_NOTICE).toBe("This switch is now always on and may be removed in a future release.");
    });

    for (const alwaysKey of ALWAYS_ON) {
        it(`${alwaysKey}: on with source always_on before the cache loads, when it is unavailable, and with required:true`, async () => {
            const never = new FeatureFlagCache({ revisions: () => new Promise(() => {}), snapshot: () => new Promise(() => {}) }, 20);
            expect(never.resolve(alwaysKey, owner, { fallback: false })).toEqual(ON);
            expect(never.resolve(alwaysKey, owner, { required: true })).toEqual(ON);
            await never.pollRevisionsAndRefresh();
            expect(never.state.lastError).toContain("timed out");
            expect(never.resolve(alwaysKey, null, { fallback: false })).toEqual(ON);
            expect(never.resolve(alwaysKey, owner, { required: true })).toEqual(ON);
            // Option validation still applies.
            expect(() => never.resolve(alwaysKey, owner, {})).toThrow(TypeError);
            await never.stop();
        });

        it(`${alwaysKey}: on despite a stored cluster Off, a user Off, and a missing catalog row`, async () => {
            let snapshot = { definitions: [alwaysDef(alwaysKey)], settings: [clusterOff(alwaysKey), aliceOff(alwaysKey)] };
            const cache = new FeatureFlagCache({ revisions: async () => snapshot.definitions.map(({ featureKey, revision }) => ({ featureKey, revision })),
                snapshot: async () => structuredClone(snapshot) });
            await cache.pollRevisionsAndRefresh();
            expect(cache.state.initialized).toBe(true);
            expect(cache.resolve(alwaysKey, owner, { required: true })).toEqual(ON);
            expect(cache.resolve(alwaysKey, { ...owner, subject: "bob" }, { fallback: false })).toEqual(ON);
            expect(resolveFeatureDefinition(alwaysDef(alwaysKey), clusterOff(alwaysKey), aliceOff(alwaysKey))).toEqual(ON);
            snapshot = { definitions: [], settings: [] };
            await cache.pollRevisionsAndRefresh();
            expect(cache.state.appliedRevisions[alwaysKey]).toBeUndefined();
            expect(cache.resolve(alwaysKey, owner, { required: true })).toEqual(ON);
            await cache.stop();
        });

        it(`${alwaysKey}: changes are refused with FEATURE_ALWAYS_ON (409) and the notice`, () => {
            let error;
            try { assertFeatureMutable(alwaysKey); } catch (caught) { error = caught; }
            expect(error).toBeInstanceOf(FeatureFlagError);
            expect(error).toMatchObject({ code: "FEATURE_ALWAYS_ON", status: 409 });
            expect(error.message).toContain(FEATURE_ALWAYS_ON_NOTICE);
        });
    }

    it("a normal flag stays mutable and still resolves from stored settings", () => {
        expect(() => assertFeatureMutable(key)).not.toThrow();
        expect(resolveFeatureDefinition(def(), cluster(true, false)).source).toBe("cluster");
    });
});
