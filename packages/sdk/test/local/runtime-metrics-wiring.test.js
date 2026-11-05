import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const observed = vi.hoisted(() => ({ records: [] }));
vi.mock("@opentelemetry/api", async importOriginal => {
    const original = await importOriginal();
    return { ...original, metrics: { getMeter: () => ({
        createCounter: name => ({ add: (value, attributes) => observed.records.push({ name, value, attributes }) }),
        createHistogram: name => ({ record: (value, attributes) => observed.records.push({ name, value, attributes }) }),
    }) } };
});
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";
import { runTurnPreamble, runTurnCommit } from "../../src/session-lifecycle.ts";
import { SnapshotConflictError, writeTurnCommitFile } from "../../src/snapshot-protocol.ts";
import { SESSION_STATE_MISSING_PREFIX } from "../../src/types.ts";

const records = name => observed.records.filter(record => record.name === name);
const context = { traceInfo() {}, traceWarn() {} };
beforeEach(() => { observed.records.length = 0; });

describe("actual runTurn metric wiring", () => {
    it.each([true, false])("records usage and tool outcomes once with catalog=%s", async withCatalog => {
        const h = makeRunTurnHarness({ withCatalog, turn: async opts => {
            for (const inputTokens of [11, 13]) opts.onEvent({
                eventType: "assistant.usage",
                data: { inputTokens, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 },
            });
            for (const success of [true, false]) {
                opts.onEvent({ eventType: "tool.execution_start", data: { toolName: "PRIVATE_TOOL", arguments: "PRIVATE_ARGS" } });
                opts.onEvent({ eventType: "tool.execution_complete", data: { success, output: "PRIVATE_OUTPUT" } });
            }
            return { type: "completed", content: "PRIVATE_CONTENT" };
        } });
        expect((await h.runTurn("private-session")).type).toBe("completed");
        expect(records("pilotswarm.turns")).toEqual([{ name: "pilotswarm.turns", value: 1, attributes: { result: "completed" } }]);
        expect(Object.fromEntries(records("pilotswarm.tokens").map(record => [record.attributes.direction, record.value])))
            .toEqual({ input: 24, output: 6, cache_read: 4, cache_write: 2 });
        expect(records("pilotswarm.tool.calls").map(record => record.attributes.result)).toEqual(["success", "error"]);
        expect(JSON.stringify(observed.records)).not.toMatch(/PRIVATE_|private-session|owner|model|toolName/);
    });

    it.each([
        ["error", "error"], ["wait", "yielded"], ["input_required", "yielded"],
        ["cancelled", "cancelled"], ["stopped", "stopped"],
    ])("classifies returned %s as %s", async (type, result) => {
        const h = makeRunTurnHarness({ turn: async () => ({ type, message: "test", seconds: 1, question: "test", reason: "test" }) });
        await h.runTurn();
        expect(records("pilotswarm.turns")).toHaveLength(1);
        expect(records("pilotswarm.turns")[0].attributes).toEqual({ result });
    });

    it.each([false, true])("records thrown partial usage once, cancelled=%s", async cancelled => {
        const h = makeRunTurnHarness({ cancelled: () => cancelled, turn: async opts => {
            opts.onEvent({ eventType: "assistant.usage", data: { inputTokens: 17, outputTokens: 2 } });
            throw new Error("test failure");
        } });
        await expect(h.runTurn()).rejects.toThrow("test failure");
        expect(records("pilotswarm.turns")[0].attributes.result).toBe(cancelled ? "cancelled" : "error");
        expect(records("pilotswarm.tokens").find(record => record.attributes.direction === "input").value).toBe(17);
    });

    it("records failures before lock acquisition without inventing token usage", async () => {
        const h = makeRunTurnHarness({ managerExtras: { getModelSummary: () => { throw new Error("test preamble failure"); } } });
        await expect(h.runTurn()).rejects.toThrow("test preamble failure");
        expect(records("pilotswarm.turns").map(record => record.attributes)).toEqual([{ result: "error" }]);
        expect(records("pilotswarm.tokens")).toEqual([]);
    });

    it("does not duplicate tokens when CMS writes retry", async () => {
        const recordEvents = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValue(undefined);
        const h = makeRunTurnHarness({
            catalogExtras: { recordEvents },
            turn: async opts => {
                opts.onEvent({ eventType: "assistant.usage", data: { inputTokens: 9, outputTokens: 1 } });
                return { type: "completed", content: "ok" };
            },
        });
        await h.runTurn();
        expect(records("pilotswarm.tokens").find(record => record.attributes.direction === "input").value).toBe(9);
    });

    it("counts actual recovery model usage without duplicating the logical turn", async () => {
        let attempt = 0;
        const h = makeRunTurnHarness({ turn: async opts => {
            attempt++;
            opts.onEvent({ eventType: "assistant.usage", data: { inputTokens: attempt * 10, outputTokens: 1 } });
            return attempt === 1 ? { type: "error", message: "Session not found" } : { type: "completed", content: "ok" };
        } });
        expect((await h.runTurn()).type).toBe("completed");
        expect(h.session.runTurn).toHaveBeenCalledTimes(2);
        expect(records("pilotswarm.turns")).toHaveLength(1);
        expect(records("pilotswarm.tokens").find(record => record.attributes.direction === "input").value).toBe(30);
    });

    it("marks fresh recreation after lost resumable state as lossy hydration", async () => {
        const h = makeRunTurnHarness();
        h.sessionManager.getOrCreate.mockRejectedValueOnce(new Error(`${SESSION_STATE_MISSING_PREFIX} missing test state`));
        expect((await h.runTurn("test-session", { turnIndex: 7 })).type).toBe("completed");
        expect(records("pilotswarm.lifecycle.operations").map(record => record.attributes))
            .toEqual([{ operation: "hydration", result: "lossy_handoff" }]);
    });
});

describe("legacy lifecycle activity metric wiring", () => {
    it.each(["completed", "error", "lossy_handoff", "checkpoint_fallback"])("dehydrate records %s rather than false success", async result => {
        const h = makeRunTurnHarness({ managerExtras: { dehydrate: async (_id, _reason, options) => {
            if (result === "error") throw new Error("test store failure");
            if (result === "lossy_handoff") throw new Error("Session state directory not ready during dehydrate");
            if (result === "checkpoint_fallback") options.onCheckpointFallback();
        } } });
        const call = h.handlers.dehydrateSession(context, { sessionId: "private-id", reason: "private-reason" });
        if (result === "error") await expect(call).rejects.toThrow("test store failure");
        else await call;
        expect(records("pilotswarm.lifecycle.operations").map(record => record.attributes))
            .toEqual([{ operation: "dehydration", result }]);
    });
    it.each(["completed", "error"])("hydrate records %s", async result => {
        const h = makeRunTurnHarness({ managerExtras: { hydrate: async () => {
            if (result === "error") throw new Error("test store failure");
        } } });
        const call = h.handlers.hydrateSession(context, { sessionId: "private-id" });
        if (result === "error") await expect(call).rejects.toThrow("test store failure");
        else await call;
        expect(records("pilotswarm.lifecycle.operations").map(record => record.attributes))
            .toEqual([{ operation: "hydration", result }]);
    });
});

describe("modern snapshot lifecycle metric wiring", () => {
    async function snapshot(run) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-otel-lifecycle-"));
        const sessionId = "test-session";
        const dir = path.join(root, sessionId);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "workspace.yaml"), "{}");
        const ctx = {
            sessionStateDir: root, sessionId, transcriptEpoch: 0, expectedVersion: 1, turnKey: "test-turn",
            dropWarmSession: async () => {}, trace() {},
            store: {
                probeSnapshot: async () => ({ exists: true, version: 1, contentHash: "test-hash" }),
                hydrateSnapshot: async () => ({ version: 1, contentHash: "test-hash" }),
                commitSnapshot: async () => ({ version: 2, contentHash: "next-hash", alreadyCommitted: false }),
            },
        };
        try { await run(ctx, dir); } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
    it("records hydration and commit, but not warm preambles or stopped non-commits", async () => {
        await snapshot(async ctx => {
            await runTurnPreamble(ctx);
            await runTurnPreamble(ctx);
            await runTurnCommit(ctx, 1, { type: "stopped" });
            await runTurnCommit(ctx, 1, { type: "completed" });
        });
        expect(records("pilotswarm.lifecycle.operations").map(record => record.attributes)).toEqual([
            { operation: "hydration", result: "completed" }, { operation: "dehydration", result: "completed" },
        ]);
    });
    it("records failed hydration and superseded commit as failures, not completed", async () => {
        await snapshot(async ctx => {
            ctx.store.hydrateSnapshot = async () => { throw new Error("test hydrate failure"); };
            await expect(runTurnPreamble(ctx)).rejects.toThrow("test hydrate failure");
            ctx.store.commitSnapshot = async () => { throw new SnapshotConflictError(ctx.sessionId, 1, 2); };
            await runTurnCommit(ctx, 1, { type: "completed" });
        });
        expect(records("pilotswarm.lifecycle.operations").map(record => record.attributes)).toEqual([
            { operation: "hydration", result: "error" }, { operation: "dehydration", result: "superseded" },
        ]);
    });
    it("restores already-committed state without invoking the model or adding tokens", async () => {
        await snapshot(async (ctx, dir) => {
            ctx.store.probeSnapshot = async () => ({ exists: true, version: 1, turnKey: ctx.turnKey });
            writeTurnCommitFile(dir, ctx.turnKey, { type: "completed", content: "stored" });
            expect((await runTurnPreamble(ctx)).kind).toBe("already-committed");
        });
        expect(records("pilotswarm.tokens")).toEqual([]);
        expect(records("pilotswarm.lifecycle.operations").map(record => record.attributes))
            .toEqual([{ operation: "hydration", result: "completed" }]);
    });
    it("counts transient commit retries as one logical dehydration and reports exhausted failure", async () => {
        await snapshot(async ctx => {
            let attempt = 0;
            ctx.store.commitSnapshot = async () => {
                if (++attempt < 3) throw new Error("transient test failure");
                return { version: 2, contentHash: "next-hash", alreadyCommitted: false };
            };
            await runTurnCommit(ctx, 1, { type: "completed" });
            expect(attempt).toBe(3);
            ctx.store.commitSnapshot = async () => { throw new Error("persistent test failure"); };
            await expect(runTurnCommit(ctx, 2, { type: "completed" })).rejects.toThrow("persistent test failure");
        });
        expect(records("pilotswarm.lifecycle.operations").map(record => record.attributes)).toEqual([
            { operation: "dehydration", result: "completed" }, { operation: "dehydration", result: "error" },
        ]);
    });
});
