/**
 * Compute target, provider and registry unit tests: validates neutral target parsing, provider registration,
 * multi-provider routing by kind, fail-closed startup checks, session release and disposal.
 *
 * Run: node --test test/unit/compute-registry.test.mjs   (requires a prior build)
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    COMPUTE_ARCHIVE_MAX_BYTES,
    ComputeRegistry,
    ComputeTargetError,
    STORE_OWNED_DEFAULT_DEADLINES_MS,
    createComputeRegistry,
    parseComputeTarget,
} from "../../dist/compute-target.js";

function sampleTarget(overrides = {}) {
    return {
        id: "target-alpha-1",
        name: "alpha",
        kind: "provider-alpha",
        class: "shared",
        statePolicy: "store-owned",
        displayName: "Alpha Remote Pool",
        enabled: true,
        config: { region: "east" },
        ...overrides,
    };
}

function sampleProvider(overrides = {}) {
    return {
        kind: "provider-alpha",
        supportedStatePolicies: ["store-owned"],
        ...overrides,
    };
}

test("parseComputeTarget: freezes target, applies default bounds and enforces lower-only archive cap", () => {
    const parsed = parseComputeTarget(sampleTarget());
    assert.equal(parsed.target.id, "target-alpha-1");
    assert.equal(parsed.target.statePolicy, "store-owned");
    assert.equal(parsed.maxArchiveBytes, COMPUTE_ARCHIVE_MAX_BYTES);
    assert.deepEqual(parsed.deadlinesMs, STORE_OWNED_DEFAULT_DEADLINES_MS);
    assert.equal(Object.isFrozen(parsed.target), true);
    assert.equal(Object.isFrozen(parsed.target.config), true);

    const bounded = parseComputeTarget(sampleTarget({
        storeOwned: { maxArchiveBytes: 4096, deadlinesMs: { open: 10_000, dehydrate: 15_000 } },
    }));
    assert.equal(bounded.maxArchiveBytes, 4096);
    assert.equal(bounded.deadlinesMs.open, 10_000);
    assert.equal(bounded.deadlinesMs.read, STORE_OWNED_DEFAULT_DEADLINES_MS.read);
    assert.equal(bounded.deadlinesMs.dehydrate, 15_000);
    assert.equal(bounded.deadlinesMs.commit, STORE_OWNED_DEFAULT_DEADLINES_MS.commit);

    assert.throws(
        () => parseComputeTarget(sampleTarget({ storeOwned: { maxArchiveBytes: COMPUTE_ARCHIVE_MAX_BYTES + 1 } })),
        ComputeTargetError,
    );
    assert.throws(
        () => parseComputeTarget(sampleTarget({ storeOwned: { unknown: true } })),
        ComputeTargetError,
    );
    assert.throws(
        () => parseComputeTarget(sampleTarget({ statePolicy: "unsupported" })),
        ComputeTargetError,
    );
    assert.throws(
        () => parseComputeTarget(sampleTarget({ kind: "UPPER_BAD" })),
        ComputeTargetError,
    );
});

test("ComputeRegistry: routes multiple target kinds to their matching providers and ignores disabled targets", () => {
    const alpha = sampleProvider({ kind: "provider-alpha" });
    const beta = sampleProvider({ kind: "provider-beta" });
    const registry = createComputeRegistry({
        targets: [
            sampleTarget({ id: "t-a", kind: "provider-alpha" }),
            sampleTarget({ id: "t-b", kind: "provider-beta" }),
            sampleTarget({ id: "t-disabled", kind: "provider-missing", enabled: false }),
        ],
        providers: [alpha],
    });
    registry.registerProvider(beta);

    assert.deepEqual(registry.targetIds(), ["t-a", "t-b", "t-disabled"]);
    assert.deepEqual(registry.providerKinds(), ["provider-alpha", "provider-beta"]);

    const resolvedA = registry.resolveTarget("t-a");
    assert.equal(resolvedA?.provider, alpha);
    assert.equal(resolvedA?.target.id, "t-a");

    const resolvedB = registry.resolveTarget("t-b");
    assert.equal(resolvedB?.provider, beta);

    assert.equal(registry.resolveTarget("t-disabled"), undefined);
    assert.equal(registry.resolveTarget("t-unknown"), undefined);

    const verified = [];
    registry.validateForStart((r) => verified.push(`${r.target.id}:${r.provider.kind}`));
    assert.deepEqual(verified, ["t-a:provider-alpha", "t-b:provider-beta"]);
});

test("ComputeRegistry: fails closed on duplicate ids/kinds and missing provider at start", () => {
    assert.throws(
        () => new ComputeRegistry({ targets: [sampleTarget({ id: "dup" }), sampleTarget({ id: "dup" })] }),
        ComputeTargetError,
    );
    const registry = new ComputeRegistry({ targets: [sampleTarget({ id: "t1", kind: "provider-alpha" })] });
    assert.throws(() => registry.validateForStart(), /unregistered provider kind provider-alpha/);

    registry.registerProvider(sampleProvider({ kind: "provider-alpha" }));
    assert.throws(() => registry.registerProvider(sampleProvider({ kind: "provider-alpha" })), ComputeTargetError);
});

test("ComputeRegistry: releaseSession targets the matching provider or broadcasts when targetId is omitted", async () => {
    const seen = [];
    const alpha = sampleProvider({
        kind: "provider-alpha",
        async releaseSession(req) { seen.push(`alpha:${req.sessionId}:${req.reason}`); },
    });
    const beta = sampleProvider({
        kind: "provider-beta",
        async releaseSession(req) { seen.push(`beta:${req.sessionId}:${req.reason}`); throw new Error("advisory failure"); },
    });
    const registry = createComputeRegistry({
        targets: [
            sampleTarget({ id: "t-a", kind: "provider-alpha" }),
            sampleTarget({ id: "t-b", kind: "provider-beta" }),
        ],
        providers: [alpha, beta],
    });

    await registry.releaseSession({ sessionId: "s1", targetId: "t-a", reason: "deleted" });
    assert.deepEqual(seen, ["alpha:s1:deleted"]);

    await registry.releaseSession({ sessionId: "s2", reason: "deleted" });
    assert.deepEqual(seen, ["alpha:s1:deleted", "alpha:s2:deleted", "beta:s2:deleted"]);
});

test("ComputeRegistry: disposeAll calls every provider even when one throws and surfaces the failure", async () => {
    const disposed = [];
    const registry = createComputeRegistry({
        providers: [
            sampleProvider({ kind: "provider-a", async dispose() { disposed.push("a"); throw new Error("boom-a"); } }),
            sampleProvider({ kind: "provider-b", async dispose() { disposed.push("b"); } }),
        ],
    });

    await assert.rejects(() => registry.disposeAll(), /boom-a/);
    assert.deepEqual(disposed, ["a", "b"]);
});

test("parseComputeTarget: deep-freezes nested config and refuses non-JSON values or cycles", () => {
    const nested = { nested: { list: [1, { deep: "ok" }] } };
    const parsed = parseComputeTarget(sampleTarget({ config: nested }));
    assert.equal(Object.isFrozen(parsed.target.config), true);
    assert.equal(Object.isFrozen(parsed.target.config.nested), true);
    assert.equal(Object.isFrozen(parsed.target.config.nested.list), true);
    assert.equal(Object.isFrozen(parsed.target.config.nested.list[1]), true);
    nested.nested.list[1].deep = "mutated";
    assert.equal(parsed.target.config.nested.list[1].deep, "ok");

    assert.throws(() => parseComputeTarget(sampleTarget({ config: { fn: () => {} } })), ComputeTargetError);
    assert.throws(() => parseComputeTarget(sampleTarget({ config: { undef: undefined } })), ComputeTargetError);
    assert.throws(() => parseComputeTarget(sampleTarget({ config: { n: Number.NaN } })), ComputeTargetError);
    const cycle = {};
    cycle.self = cycle;
    assert.throws(() => parseComputeTarget(sampleTarget({ config: cycle })), ComputeTargetError);
});

test("ComputeRegistry: snapshots provider metadata and refuses mutations once sealed", () => {
    const policies = ["store-owned"];
    const mutableProvider = sampleProvider({ kind: "provider-alpha", supportedStatePolicies: policies });
    const registry = createComputeRegistry({
        targets: [sampleTarget({ id: "t1", kind: "provider-alpha" })],
        providers: [mutableProvider],
    });
    policies.length = 0;
    assert.equal(registry.resolveTarget("t1")?.provider, mutableProvider, "mutating caller array does not alter snapshotted policies");

    registry.seal();
    assert.equal(registry.isSealed(), true);
    assert.throws(() => registry.registerProvider(sampleProvider({ kind: "provider-beta" })), /sealed/);
    assert.throws(() => registry.addTarget(sampleTarget({ id: "t2" })), /sealed/);
});
