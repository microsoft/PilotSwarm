/**
 * Store-owned remote state (`statePolicy: "store-owned"`): the session store owns the state under `store-wins` and the remote sandbox is a disposable warm cache.
 *
 * What is held to (and what is NOT claimed):
 *   - a turn on one sandbox, a destroyed sandbox, and the next turn on a brand-new sandbox that hydrates the stored opaque archive, against the real filesystem store, with nothing
 *     written to the worker's own session directory;
 *   - a sandbox that already holds the stored head `(version, contentHash)` is reused without reading the archive; any other state hydrates;
 *   - a turn key the head already carries answers from the worker-owned record without contacting a sandbox;
 *   - a `store-wins` conflict does not brick the session: the warm cache is invalidated, the turn is reported unpublished, and the next turn rehydrates the winner;
 *   - an oversized archive is refused before the store is touched; a sandbox whose head is not the stored head never runs the turn; a later turn with no stored state is held;
 *   - phase deadlines, and an `abort` that only invalidates and closes (it never replaces the error that ended the turn).
 * Fakes only. These prove nothing about a real sandbox, a real provider, or Blob Storage.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { createComputeRegistry } from "../../src/compute-target.ts";
import { OpaqueArchiveError, REMOTE_SNAPSHOT_ARCHIVE_MAX_BYTES } from "../../src/snapshot-protocol.ts";
import {
    StoreOwnedError,
    beginStoreOwnedTurn,
    checkStoreOwnedTurn,
    classifyStoreOwnedSessionFailure,
    parseStoreOwnedTarget,
    runStoreOwnedRemoteTurn,
} from "../../src/remote-store-owned.ts";
import { REMOTE_NO_STORE, runTurnCommit, runTurnPreamble } from "../../src/session-lifecycle.ts";

const SESSION = "sess-store-owned";
const roots = [];
afterAll(() => {
    for (const root of roots) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
});

const bytes = (text) => new Uint8Array(Buffer.from(text, "utf8"));
const text = (archive) => Buffer.from(archive).toString("utf8");

async function rejection(promise) {
    try { await promise; } catch (error) { return error; }
    return null;
}

function makeStore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-store-owned-"));
    roots.push(root);
    const sessionStateDir = path.join(root, "session-state");
    fs.mkdirSync(sessionStateDir, { recursive: true });
    return { store: new FilesystemSessionStore(path.join(root, "store"), sessionStateDir), sessionStateDir };
}

function targetConfig(extra = {}) {
    const { storeOwned, config, ...rest } = extra;
    return {
        id: "target-1",
        name: "target-1",
        kind: "fake-kind",
        class: "shared",
        statePolicy: "store-owned",
        displayName: null,
        enabled: true,
        ...(storeOwned !== undefined ? { storeOwned } : {}),
        config: config ?? {},
        ...rest,
    };
}

function makeTarget(storeOwned) {
    return parseStoreOwnedTarget(targetConfig(storeOwned ? { storeOwned } : {}));
}

/** A ComputeProvider over in-memory sandboxes. `use(id)` picks the sandbox the next open lands on; `destroy(id)` removes it. */
function makeProvider(kind = "fake-kind") {
    const sandboxes = new Map();
    const calls = { opens: 0, reads: 0, closes: 0, invalidations: [], resumes: 0, creates: 0, requests: [], releases: [], disposes: 0 };
    let current = "A";
    return {
        kind,
        supportedStatePolicies: ["store-owned"],
        calls,
        sandboxes,
        use(id) { current = id; },
        destroy(id) { sandboxes.delete(id); },
        async openStoreOwned(request) {
            calls.opens++;
            calls.requests.push({ expectedHead: request.expectedHead, hasSignal: request.signal instanceof AbortSignal });
            let sandbox = sandboxes.get(current);
            let reusedWarm = false;
            if (sandbox?.head && request.expectedHead && sandbox.head.version === request.expectedHead.version && sandbox.head.contentHash === request.expectedHead.contentHash) {
                reusedWarm = true;
            } else {
                sandbox = { state: "", head: null };
                sandboxes.set(current, sandbox);
                if (request.expectedHead) {
                    const archive = await request.readArchive();
                    calls.reads++;
                    sandbox.state = text(archive.archiveBytes);
                    sandbox.head = { version: archive.version, contentHash: archive.contentHash };
                }
            }
            const hostId = current;
            return {
                client: {
                    createSession: async () => { calls.creates++; return {}; },
                    resumeSession: async () => { calls.resumes++; return {}; },
                },
                hostId,
                reusedWarm,
                hydratedHead: sandbox.head,
                dehydrateArchive: async () => ({ archiveBytes: bytes(sandbox.state), codec: "gzip", rawSizeBytes: sandbox.state.length }),
                invalidateWarmCache: (reason) => { calls.invalidations.push(reason); sandbox.head = null; },
                acknowledgeCommit: (head) => { sandbox.head = head; },
                close: async () => { calls.closes++; },
            };
        },
        async releaseSession(req) {
            calls.releases.push(req);
        },
        async dispose() {
            calls.disposes++;
        },
    };
}

/** Runs one turn that appends `label` to the sandbox's state (the "native files"), creating or resuming the native session as the runner says. */
function turn(env, label, options = {}) {
    return runStoreOwnedRemoteTurn({
        sessionId: SESSION,
        epoch: options.epoch ?? 0,
        turnKey: options.turnKey ?? `turn-${label}`,
        target: options.target ?? makeTarget(),
        store: env.store,
        provider: env.provider,
        requestHandler: {},
        ...(options.requireHead ? { requireHead: true } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        runBody: async (lease, context) => {
            if (context.resume) await lease.client.resumeSession(SESSION, {}); else await lease.client.createSession({});
            if (options.during) await options.during(lease, context);
            const sandbox = env.provider.sandboxes.get(lease.hostId);
            sandbox.state = sandbox.state ? `${sandbox.state}|${label}` : label;
            return { type: "completed", content: `answer ${label}`, ...(options.result ?? {}) };
        },
    });
}

function setup() {
    const { store, sessionStateDir } = makeStore();
    const provider = makeProvider();
    return { store, sessionStateDir, provider, executor: provider };
}

describe("store-owned turn runner", () => {
    it("fails over across sandboxes: turn 1 on A commits v1, A is destroyed, turn 2 hydrates the opaque archive on a new sandbox B and commits v2", async () => {
        const env = setup();
        const first = await turn(env, "t1");
        expect(first.status).toBe("committed");
        expect(first.version).toBe(1);
        expect(first.hostId).toBe("A");
        expect(env.executor.calls.creates).toBe(1);
        expect(env.executor.calls.reads).toBe(0);
        // The worker's own session directory never held the state.
        expect(fs.existsSync(path.join(env.sessionStateDir, SESSION))).toBe(false);
        expect(fs.readdirSync(env.sessionStateDir)).toEqual([]);

        env.executor.destroy("A");
        env.executor.use("B");
        const second = await turn(env, "t2");
        expect(second.status).toBe("committed");
        expect(second.version).toBe(2);
        expect(second.hostId).toBe("B");
        expect(second.reusedWarm).toBe(false);
        expect(env.executor.calls.reads).toBe(1);
        expect(env.executor.calls.resumes).toBe(1);
        expect(env.executor.sandboxes.get("B").state).toBe("t1|t2");
        const stored = await env.store.readSnapshotArchive(SESSION, 0);
        expect(text(stored.archiveBytes)).toBe("t1|t2");
        expect(stored.version).toBe(2);
        expect(fs.readdirSync(env.sessionStateDir)).toEqual([]);
        expect(env.executor.calls.closes).toBe(2);
    });

    it("reuses a warm sandbox that holds exactly the stored head without reading the archive", async () => {
        const env = setup();
        await turn(env, "t1");
        const second = await turn(env, "t2");
        expect(second.status).toBe("committed");
        expect(second.reusedWarm).toBe(true);
        expect(second.version).toBe(2);
        expect(env.executor.calls.reads).toBe(0);
        expect(env.executor.calls.resumes).toBe(1);
        expect(env.executor.calls.requests[1].expectedHead.version).toBe(1);
    });

    it("hydrates when the warm sandbox's head is not the stored head (a foreign advance)", async () => {
        const env = setup();
        await turn(env, "t1");
        const probe = await env.store.probeSnapshotArchive(SESSION, 0);
        await env.store.commitSnapshotArchive(SESSION, { baseVersion: 1, turnKey: "foreign", archiveBytes: bytes("foreign-state"), codec: "gzip", expectedEtag: probe.etag }, 0);
        const second = await turn(env, "t2");
        expect(second.status).toBe("committed");
        expect(second.reusedWarm).toBe(false);
        expect(env.executor.calls.reads).toBe(1);
        expect(env.executor.sandboxes.get("A").state).toBe("foreign-state|t2");
        expect(second.version).toBe(3);
    });

    it("answers a turn key the head already carries from the worker-owned record, with no executor.open", async () => {
        const env = setup();
        const first = await turn(env, "t1", { result: { extra: "kept" } });
        const opens = env.executor.calls.opens;
        const retry = await turn(env, "t1");
        expect(retry.status).toBe("stored");
        expect(retry.sandboxContacted).toBe(false);
        expect(retry.version).toBe(first.version);
        expect(retry.result).toEqual(first.result);
        expect(retry.result.extra).toBe("kept");
        expect(env.executor.calls.opens).toBe(opens);
        const start = await checkStoreOwnedTurn({ store: env.store, sessionId: SESSION, epoch: 0, turnKey: "turn-t1" });
        expect(start).toMatchObject({ kind: "stored", version: 1 });
        const fresh = await checkStoreOwnedTurn({ store: env.store, sessionId: SESSION, epoch: 0, turnKey: "turn-next" });
        expect(fresh).toEqual({ kind: "open", baseVersion: 1 });
    });

    it("a store-wins conflict does not brick the session: the cache is invalidated, the turn is unpublished, and the next turn rehydrates the winner", async () => {
        const env = setup();
        await turn(env, "t1");
        let foreignVersion = 0;
        const conflicted = await turn(env, "t2", {
            during: async () => {
                const probe = await env.store.probeSnapshotArchive(SESSION, 0);
                const won = await env.store.commitSnapshotArchive(SESSION, { baseVersion: 1, turnKey: "foreign", archiveBytes: bytes("winner"), codec: "gzip", expectedEtag: probe.etag }, 0);
                foreignVersion = won.version;
            },
        });
        expect(conflicted.status).toBe("unpublished");
        expect(conflicted.unpublishedReason).toBe("conflict");
        expect(conflicted.version).toBe(foreignVersion);
        expect(conflicted.storedTurnKey).toBe("foreign");
        expect(conflicted.result.type).toBe("completed");
        expect(env.executor.calls.invalidations).toContain("snapshot-conflict");
        expect((await env.store.probeSnapshotArchive(SESSION, 0)).turnKey).toBe("foreign");

        const next = await turn(env, "t3");
        expect(next.status).toBe("committed");
        expect(next.version).toBe(foreignVersion + 1);
        expect(env.executor.sandboxes.get("A").state).toBe("winner|t3");
    });

    it("refuses an oversized archive before the store is touched and invalidates the cache", async () => {
        const env = setup();
        await turn(env, "t1");
        const small = makeTarget({ maxArchiveBytes: 16 });
        const error = await rejection(turn(env, "t2-way-too-long-state", { target: small }));
        expect(error).toBeInstanceOf(OpaqueArchiveError);
        expect(error.code).toBe("ARCHIVE_TOO_LARGE");
        expect((await env.store.probeSnapshotArchive(SESSION, 0)).version).toBe(1);
        expect(env.executor.calls.invalidations).toContain("archive-rejected");
        expect(() => makeTarget({ maxArchiveBytes: REMOTE_SNAPSHOT_ARCHIVE_MAX_BYTES + 1 })).toThrow(/STORE_OWNED_INVALID/);
    });

    it("never runs the turn when the sandbox does not hold the stored head", async () => {
        const env = setup();
        await turn(env, "t1");
        const lying = {
            kind: "fake-kind",
            supportedStatePolicies: ["store-owned"],
            calls: { invalidations: [], closes: 0 },
            async openStoreOwned() {
                return {
                    client: { createSession: async () => ({}), resumeSession: async () => ({}) },
                    hostId: "L",
                    reusedWarm: true,
                    hydratedHead: { version: 7, contentHash: "0".repeat(64) },
                    dehydrateArchive: async () => ({ archiveBytes: bytes("x"), codec: "gzip" }),
                    invalidateWarmCache: (reason) => { lying.calls.invalidations.push(reason); },
                    close: async () => { lying.calls.closes++; },
                };
            },
        };
        let ran = false;
        const error = await rejection(runStoreOwnedRemoteTurn({
            sessionId: SESSION, epoch: 0, turnKey: "turn-x", target: makeTarget(), store: env.store, provider: lying, requestHandler: {},
            runBody: async () => { ran = true; return {}; },
        }));
        expect(error).toBeInstanceOf(StoreOwnedError);
        expect(error.code).toBe("STORE_OWNED_HYDRATE_MISMATCH");
        expect(error.terminal).toBe(false);
        expect(ran).toBe(false);
        expect(lying.calls.invalidations).toEqual(["hydrate-mismatch"]);
        expect(lying.calls.closes).toBe(1);
    });

    it("refuses the archive read when the stored head moved after the turn started", async () => {
        const env = setup();
        await turn(env, "t1");
        env.executor.destroy("A");
        let readError = null;
        const probeFirst = await env.store.probeSnapshotArchive(SESSION, 0);
        const provider = {
            kind: "fake-kind",
            supportedStatePolicies: ["store-owned"],
            async openStoreOwned(request) {
                await env.store.commitSnapshotArchive(SESSION, { baseVersion: 1, turnKey: "moved", archiveBytes: bytes("moved"), codec: "gzip", expectedEtag: probeFirst.etag }, 0);
                readError = await rejection(request.readArchive());
                throw readError;
            },
        };
        const error = await rejection(runStoreOwnedRemoteTurn({
            sessionId: SESSION, epoch: 0, turnKey: "turn-y", target: makeTarget(), store: env.store, provider, requestHandler: {}, runBody: async () => ({}),
        }));
        expect(readError).toBeInstanceOf(StoreOwnedError);
        expect(readError.code).toBe("STORE_OWNED_HYDRATE_MISMATCH");
        expect(error).toBe(readError);
    });

    it("holds a later turn that finds no stored state instead of starting an empty conversation", async () => {
        const env = setup();
        const error = await rejection(turn(env, "t5", { requireHead: true }));
        expect(error.code).toBe("STORE_OWNED_STATE_MISSING");
        expect(env.executor.calls.opens).toBe(0);
    });

    it("works in a regenerated epoch without touching the epoch 0 chain", async () => {
        const env = setup();
        await turn(env, "t1");
        const e2 = await turn(env, "e2-t1", { epoch: 2 });
        expect(e2.status).toBe("committed");
        expect(e2.version).toBe(1);
        const e2Next = await turn(env, "e2-t2", { epoch: 2 });
        expect(e2Next.version).toBe(2);
        expect((await env.store.probeSnapshotArchive(SESSION, 0)).version).toBe(1);
        expect((await env.store.probeSnapshotArchive(SESSION, 2)).version).toBe(2);
    });

    it("abandons an open that outlives its deadline and closes a lease that arrives late", async () => {
        const env = setup();
        const closed = [];
        const provider = {
            kind: "fake-kind",
            supportedStatePolicies: ["store-owned"],
            async openStoreOwned() {
                await new Promise((resolve) => setTimeout(resolve, 60));
                return {
                    client: { createSession: async () => ({}), resumeSession: async () => ({}) },
                    hostId: "slow", reusedWarm: false, hydratedHead: null,
                    dehydrateArchive: async () => ({ archiveBytes: bytes("x"), codec: "gzip" }),
                    close: async () => { closed.push("slow"); },
                };
            },
        };
        const error = await rejection(runStoreOwnedRemoteTurn({
            sessionId: SESSION, epoch: 0, turnKey: "turn-slow", target: makeTarget({ deadlinesMs: { open: 15 } }), store: env.store, provider, requestHandler: {}, runBody: async () => ({}),
        }));
        expect(error.code).toBe("STORE_OWNED_DEADLINE");
        expect(error.terminal).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(closed).toEqual(["slow"]);
        expect((await env.store.probeSnapshotArchive(SESSION, 0)).exists).toBe(false);
    });

    it("refuses a turn whose signal is already aborted before any store or provider call", async () => {
        const env = setup();
        const controller = new AbortController();
        controller.abort();
        const error = await rejection(turn(env, "t1", { signal: controller.signal }));
        expect(error.code).toBe("STORE_OWNED_ABORTED");
        expect(env.executor.calls.opens).toBe(0);
    });
});

describe("store-owned turn bridge", () => {
    function begin(env, extra = {}) {
        const bound = [];
        const released = [];
        const input = {
            sessionId: SESSION,
            transcriptEpoch: 0,
            turnKey: extra.turnKey ?? "turn-b1",
            target: makeTarget(),
            provider: env.provider,
            store: env.store,
            requestHandler: {},
            bindRuntime: (binding, hints) => { bound.push({ binding, hints }); },
            releaseRuntime: async () => { released.push(true); },
            trace: () => undefined,
            ...extra,
        };
        return { bound, released, started: beginStoreOwnedTurn(input) };
    }

    it("binds the lease's client with the resume hint and commits on request", async () => {
        const env = setup();
        const first = begin(env);
        const policy = await first.started;
        expect(first.bound).toHaveLength(1);
        expect(first.bound[0].hints).toEqual({ resume: false });
        expect(policy.baseVersion).toBe(0);
        env.executor.sandboxes.get("A").state = "b1";
        await policy.quiesce();
        expect(first.released).toHaveLength(1);
        const outcome = await policy.commit({ type: "completed", content: "ok" });
        expect(outcome.status).toBe("committed");
        expect(outcome.version).toBe(1);

        const second = begin(env, { turnKey: "turn-b2" });
        const nextPolicy = await second.started;
        expect(second.bound[0].hints).toEqual({ resume: true });
        expect(nextPolicy.baseVersion).toBe(1);
        await nextPolicy.abort(new Error("body failed"));
    });

    it("abort only invalidates the cache and closes the lease: it neither throws nor replaces the error that ended the turn", async () => {
        const env = setup();
        const started = begin(env);
        const policy = await started.started;
        const cut = new Error("TURN_CUT_BY_SHUTDOWN");
        await expect(policy.abort(cut)).resolves.toBeUndefined();
        expect(env.executor.calls.invalidations).toEqual(["turn-failed"]);
        expect(env.executor.calls.closes).toBe(1);
        await expect(policy.abort(cut)).resolves.toBeUndefined();
        expect(env.executor.calls.closes).toBe(1);
        expect((await env.store.probeSnapshotArchive(SESSION, 0)).exists).toBe(false);
    });

    it("refuses with a retryable error when the turn key was committed while the turn was starting", async () => {
        const env = setup();
        await turn(env, "t1", { turnKey: "turn-b1" });
        const error = await rejection(begin(env, { turnKey: "turn-b1" }).started);
        expect(error.code).toBe("STORE_OWNED_TURN_ALREADY_COMMITTED");
        expect(error.terminal).toBe(false);
    });

    it("holds the turn with a retryable error when the provider does not implement openStoreOwned", async () => {
        const env = setup();
        const error = await rejection(begin(env, { provider: null }).started);
        expect(error.code).toBe("STORE_OWNED_EXECUTOR_UNAVAILABLE");
        expect(error.terminal).toBe(false);
    });
});

describe("store-owned targets and multi-provider routing", () => {
    it("accepts only an explicit top-level store-owned opt-in; provider config stays opaque", () => {
        expect(parseStoreOwnedTarget(targetConfig({ config: { providerSetting: "x" } })).target.config.providerSetting).toBe("x");
        for (const statePolicy of [undefined, "managed", "Store-Owned", ""]) {
            expect(() => parseStoreOwnedTarget({ ...targetConfig(), statePolicy })).toThrow(/STORE_OWNED_INVALID/);
        }
        expect(() => parseStoreOwnedTarget({ ...targetConfig(), enabled: false })).toThrow(/STORE_OWNED_INVALID/);
        expect(() => parseStoreOwnedTarget({ ...targetConfig(), id: "bad id" })).toThrow(/STORE_OWNED_INVALID/);
        expect(() => parseStoreOwnedTarget(targetConfig({ storeOwned: { unknown: 1 } }))).toThrow(/storeOwned is exactly/);
        expect(() => parseStoreOwnedTarget(targetConfig({ storeOwned: { deadlinesMs: { commit: 0 } } }))).toThrow(/deadline/);
    });

    it("a ComputeRegistry routes multiple target kinds to their respective providers and validates openStoreOwned", () => {
        const providerA = makeProvider("provider-alpha");
        const providerB = makeProvider("provider-beta");
        const registry = createComputeRegistry({
            targets: [
                targetConfig({ id: "target-a", name: "target-a", kind: "provider-alpha" }),
                targetConfig({ id: "target-b", name: "target-b", kind: "provider-beta" }),
            ],
            providers: [providerA, providerB],
        });
        expect(registry.targetIds().sort()).toEqual(["target-a", "target-b"]);
        const resA = registry.resolveTarget("target-a");
        const resB = registry.resolveTarget("target-b");
        expect(resA?.parsed.maxArchiveBytes).toBe(REMOTE_SNAPSHOT_ARCHIVE_MAX_BYTES);
        expect(resA?.provider).toBe(providerA);
        expect(resB?.provider).toBe(providerB);
        expect(registry.resolveTarget("some-other-target")).toBeUndefined();
        expect(() => createComputeRegistry({ targets: [targetConfig(), targetConfig()] })).toThrow(/configured twice/);
    });

    it("classifies failures: broker refusals and duplicate tools are permanent, anything else retries from the stored head", () => {
        const broker = classifyStoreOwnedSessionFailure(undefined, "refusing a model request to https://x: this session's model provider is https://y");
        expect(broker).toBeInstanceOf(StoreOwnedError);
        expect(broker.code).toBe("STORE_OWNED_BROKER_REFUSED");
        expect(broker.terminal).toBe(true);
        expect(classifyStoreOwnedSessionFailure(new Error("Duplicate tool name: wait")).terminal).toBe(true);
        const transient = classifyStoreOwnedSessionFailure(new Error("socket hang up"));
        expect(transient.code).toBe("STORE_OWNED_SESSION_UNAVAILABLE");
        expect(transient.terminal).toBe(false);
        const typed = new StoreOwnedError("STORE_OWNED_INVALID", "x");
        expect(classifyStoreOwnedSessionFailure(typed)).toBe(typed);
    });
});

describe("store-owned lifecycle seam", () => {
    function ctx(env, policy) {
        const traces = [];
        return {
            traces,
            value: {
                store: REMOTE_NO_STORE,
                sessionStateDir: env.sessionStateDir,
                sessionId: SESSION,
                transcriptEpoch: 0,
                expectedVersion: 0,
                turnKey: "turn-l1",
                dropWarmSession: async () => undefined,
                trace: (message) => traces.push(message),
                storeOwned: {
                    check: () => checkStoreOwnedTurn({ store: env.store, sessionId: SESSION, epoch: 0, turnKey: "turn-l1" }),
                    policy,
                },
            },
        };
    }

    it("REMOTE_NO_STORE refuses every use of the ordinary protocol's store", () => {
        expect(() => REMOTE_NO_STORE.probeSnapshot(SESSION)).toThrow(/STORE_OWNED_UNSUPPORTED/);
        expect(() => REMOTE_NO_STORE.hydrateSnapshot(SESSION)).toThrow(/no local snapshot chain/);
    });

    it("the preamble reads the store only: an unseen turn is warm, a committed turn key returns its stored result, and the session directory is never created", async () => {
        const env = setup();
        const open = await runTurnPreamble(ctx(env, null).value);
        expect(open).toEqual({ kind: "warm", baseVersion: 0, storeOwned: true });
        await turn(env, "t1", { turnKey: "turn-l1" });
        const stored = await runTurnPreamble(ctx(env, null).value);
        expect(stored.kind).toBe("already-committed");
        expect(stored.version).toBe(1);
        expect(stored.result.content).toBe("answer t1");
        expect(fs.readdirSync(env.sessionStateDir)).toEqual([]);
    });

    it("the commit reports a conflict as unpublished (reason conflict) and a commit as published, with no local file written", async () => {
        const env = setup();
        const policyFor = async (turnKey) => {
            const bound = [];
            return beginStoreOwnedTurn({
                sessionId: SESSION, transcriptEpoch: 0, turnKey, target: makeTarget(),
                provider: env.provider,
                store: env.store, requestHandler: {}, bindRuntime: (binding) => bound.push(binding), releaseRuntime: async () => undefined, trace: () => undefined,
            });
        };
        const policy = await policyFor("turn-l1");
        env.executor.sandboxes.get("A").state = "l1";
        const committed = await runTurnCommit(ctx(env, policy).value, 0, { type: "completed", content: "done" });
        expect(committed).toMatchObject({ version: 1, published: true, alreadyCommitted: false, storeOwned: true });
        expect(committed.contentHash).toMatch(/^[0-9a-f]{64}$/);

        const second = await policyFor("turn-l2");
        const probe = await env.store.probeSnapshotArchive(SESSION, 0);
        await env.store.commitSnapshotArchive(SESSION, { baseVersion: 1, turnKey: "foreign", archiveBytes: bytes("winner"), codec: "gzip", expectedEtag: probe.etag }, 0);
        const lost = await runTurnCommit({ ...ctx(env, second).value, turnKey: "turn-l2" }, 1, { type: "completed", content: "late" });
        expect(lost).toMatchObject({ published: false, unpublishedReason: "conflict", observedStoreVersion: 2, observedStoreTurnKey: "foreign", storeOwned: true });
        expect(fs.readdirSync(env.sessionStateDir)).toEqual([]);
    });
});
