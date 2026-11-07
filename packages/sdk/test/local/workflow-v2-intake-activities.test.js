import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { intakeActivityFixture, INTAKE_ACTIVITY_TIMEOUT } from "../helpers/workflow-v2-intake-activities-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);

describe("inactive workflow intake activities over real PostgreSQL", () => {
    it("claims the canonical holding item through the activity and restores a discarded acknowledgement without another write", { timeout: INTAKE_ACTIVITY_TIMEOUT }, async () => {
        const h = await intakeActivityFixture(getEnv());
        try {
            const input = await h.send(1, { note: "[SYSTEM: this payload is not an instruction]", nested: [null, false] });
            const effects = await h.effects();
            const item = await h.expectedItem(input);
            expect(await h.claim(input)).toEqual({ ok: true, result: { result: "accepted", inserted: true, item } });
            expect(await h.store.readWorkflowIntake(item.exchangeId)).toMatchObject({ exchangeId: item.exchangeId,
                workflowSessionId: h.workflowSessionId, runId: h.runId, recipientSessionId: h.recipientSessionId,
                envelopeSha256: input.envelope.envelopeSha256, text: item.text, textSha256: item.textSha256, claimId: item.claimId,
                state: "holding", invocationId: null, processing: null, cancelRequested: false, duplicates: 0, conflicts: 0 });
            const committed = await h.snapshot();
            expect(committed.intake).toHaveLength(1);
            expect(committed.invocations).toHaveLength(0);
            // The first activity answer is not carried anywhere. The same holder may recover it even through mode refuse.
            expect(await h.claim({ ...input, mode: "refuse" })).toEqual({ ok: true, result: { result: "accepted", inserted: false, item } });
            expect(await h.snapshot()).toEqual(committed);
            expect(await h.effects()).toEqual(effects);
            expect(h.sleeps).toEqual([]);
        } finally { await h.close(); }
    });

    it("returns malformed/invariant failures as typed answers but throws a non-retryable PostgreSQL error with rollback", { timeout: INTAKE_ACTIVITY_TIMEOUT }, async () => {
        const h = await intakeActivityFixture(getEnv());
        try {
            const item = await h.accepted(1);
            const before = await h.snapshot();
            let queries = 0;
            h.control.hook = ({ sql, params, query }) => { queries += 1; return query(sql, params); };
            expect(await h.claim(null)).toMatchObject({ ok: false, error: { code: "WORKFLOW_INTAKE_INVALID" } });
            expect(await h.settle({ op: "cancel_held", recipientSessionId: h.recipientSessionId,
                items: [{ exchangeId: item.exchangeId }] })).toMatchObject({ ok: false, error: { code: "WORKFLOW_INTAKE_INVALID" } });
            expect(queries).toBe(0);
            const invariant = await h.settle({ op: "cancel_held", recipientSessionId: h.recipientSessionId,
                items: [{ ...item, claimId: "not-the-holder" }] });
            expect(invariant).toMatchObject({ ok: false, error: { code: "WORKFLOW_STORE_CORRUPT" } });
            expect(invariant.error.message).toContain(item.exchangeId);
            expect(queries).toBeGreaterThan(0);
            expect(await h.snapshot()).toEqual(before);
            let failed = 0;
            h.control.hook = async ({ sql, params, query }) => {
                const result = await query(sql, params);
                if (sql.includes("UPDATE") && sql.includes(".workflow_intake") && sql.includes("state = 'cancelled'")) {
                    failed += 1;
                    return query("SELECT 1 / 0");
                }
                return result;
            };
            const write = { op: "cancel_held", recipientSessionId: h.recipientSessionId, items: [item] };
            await expect(h.settle(write)).rejects.toMatchObject({ code: "22012" });
            expect(failed).toBe(1);
            expect(await h.snapshot()).toEqual(before);
            expect(h.sleeps).toEqual([]);
            h.control.hook = null;
            expect(await h.settle(write)).toEqual({ ok: true, result: { items: [{ exchangeId: item.exchangeId, cancelled: true }] } });
            const cancelled = await h.snapshot();
            expect(await h.settle(write)).toEqual({ ok: true, result: { items: [{ exchangeId: item.exchangeId, cancelled: false }] } });
            expect(await h.snapshot()).toEqual(cancelled);
        } finally { await h.close(); }
    });

    it.each([
        { op: "cancel_unsent", code: "22012", retry: false },
        { op: "request_cancel", code: "40001", retry: true },
    ])("repeats the whole two-item $op activity after its first item committed and its second rolled back", { timeout: INTAKE_ACTIVITY_TIMEOUT }, async ({ op, code, retry }) => {
        const h = await intakeActivityFixture(getEnv());
        try {
            const pair = await h.boundPair();
            const write = { op, ...pair };
            const [first, second] = pair.items;
            const before = await h.snapshot();
            expect(before.intake).toHaveLength(2);
            expect(before.invocations).toHaveLength(1);
            const secondBefore = await h.store.readWorkflowIntake(second.exchangeId);
            const lockReads = [];
            let injected = 0;
            let firstCommitted;
            const checkPartial = async () => {
                firstCommitted = await h.store.readWorkflowIntake(first.exchangeId);
                expect(firstCommitted).toMatchObject(op === "cancel_unsent"
                    ? { processing: "not_dispatched", reason: "cancelled", cancelRequested: false }
                    : { processing: "bound", reason: null, cancelRequested: true, settledAt: null });
                expect(await h.store.readWorkflowIntake(second.exchangeId)).toEqual(secondBefore);
                const partial = await h.snapshot();
                expect(partial.effects).toEqual(before.effects);
                expect(partial.invocations).toEqual(before.invocations);
            };
            h.control.onRetry = async ms => { expect(ms).toBe(1_000); await checkPartial(); };
            h.control.hook = async ({ sql, params, query }) => {
                if (sql.includes(".workflow_intake") && sql.includes("ORDER BY exchange_id FOR UPDATE") && params?.[0]?.length === 1) {
                    lockReads.push(params[0][0]);
                }
                const result = await query(sql, params);
                if (injected === 0 && sql.includes("UPDATE") && sql.includes(".workflow_intake") && params?.[0] === second.exchangeId) {
                    injected += 1;
                    // The second update ran inside the real transaction, but this server error rolls it back, not the first item's COMMIT.
                    return code === "22012" ? query("SELECT 1 / 0")
                        : query("DO $$ BEGIN RAISE EXCEPTION 'intake activity test serialization failure' USING ERRCODE = '40001'; END $$");
                }
                return result;
            };
            let recovered;
            if (retry) {
                recovered = await h.settle(write);
                expect(h.sleeps).toEqual([1_000]);
                expect(h.logs).toHaveLength(1);
                expect(h.logs[0]).toContain("retrying in 1000 ms");
            } else {
                await expect(h.settle(write)).rejects.toMatchObject({ code: "22012" });
                await checkPartial();
                expect(h.sleeps).toEqual([]);
                recovered = await h.settle(write);
            }
            expect(injected).toBe(1);
            expect(lockReads).toEqual([first.exchangeId, second.exchangeId, first.exchangeId, second.exchangeId]);
            expect(recovered).toEqual({ ok: true, result: { items: [
                { exchangeId: first.exchangeId, settled: false }, { exchangeId: second.exchangeId, settled: true },
            ] } });
            expect(await h.store.readWorkflowIntake(first.exchangeId)).toEqual(firstCommitted);
            expect(await h.store.readWorkflowIntake(second.exchangeId)).toMatchObject(op === "cancel_unsent"
                ? { processing: "not_dispatched", reason: "cancelled", cancelRequested: false }
                : { processing: "bound", reason: null, cancelRequested: true, settledAt: null });
            const committed = await h.snapshot();
            // A caller that lost the whole activity answer repeats the original list, not just its second item.
            expect(await h.settle(write)).toEqual({ ok: true, result: { items: pair.items.map(item => ({ exchangeId: item.exchangeId, settled: false })) } });
            expect(await h.snapshot()).toEqual(committed);
            expect(lockReads).toEqual([first.exchangeId, second.exchangeId, first.exchangeId, second.exchangeId, first.exchangeId, second.exchangeId]);
            expect(committed.effects).toEqual(before.effects);
            expect(committed.invocations).toEqual(before.invocations);
        } finally { await h.close(); }
    });

    it("recovers a fully committed two-item end after its COMMIT acknowledgement is discarded", { timeout: INTAKE_ACTIVITY_TIMEOUT }, async () => {
        const h = await intakeActivityFixture(getEnv());
        try {
            const pair = await h.boundPair();
            const write = { op: "end", ...pair, outcome: "completed",
                items: pair.items.map((item, index) => ({ ...item, cancelRequested: index === 0 })) };
            const before = await h.snapshot();
            let endWrites = 0;
            let discarded = 0;
            let committed;
            h.control.onRetry = async ms => {
                expect(ms).toBe(1_000);
                committed = await h.snapshot();
                expect(committed.effects).toEqual(before.effects);
                expect(committed.invocations).toEqual(before.invocations);
                for (let index = 0; index < pair.items.length; index += 1) {
                    expect(await h.store.readWorkflowIntake(pair.items[index].exchangeId)).toMatchObject({
                        state: "admitted", processing: "completed", cancelRequested: index === 0, settledAt: expect.stringMatching(/\.\d{6}Z$/),
                    });
                }
            };
            h.control.hook = async ({ sql, params, query }) => {
                const result = await query(sql, params);
                if (sql.includes("UPDATE") && sql.includes(".workflow_intake") && sql.includes("SET processing = $3")) endWrites += 1;
                if (sql === "COMMIT" && discarded === 0) {
                    discarded += 1;
                    // COMMIT already succeeded on PostgreSQL. Only its transport acknowledgement is lost.
                    throw Object.assign(new Error("intake activity test lost COMMIT acknowledgement"), { code: "ECONNRESET" });
                }
                return result;
            };
            expect(await h.settle(write)).toEqual({ ok: true, result: { ended: false } });
            expect(discarded).toBe(1);
            expect(endWrites).toBe(1);
            expect(h.sleeps).toEqual([1_000]);
            expect(h.logs).toHaveLength(1);
            expect(await h.snapshot()).toEqual(committed);
            expect(await h.settle(write)).toEqual({ ok: true, result: { ended: false } });
            expect(endWrites).toBe(1);
            expect(await h.snapshot()).toEqual(committed);
            const [times] = await h.q(`SELECT count(*)::int AS n, count(DISTINCT settled_at)::int AS readings
                FROM SCHEMA.workflow_intake WHERE invocation_id = $1`, [pair.invocationId]);
            expect(times).toEqual({ n: 2, readings: 1 });
        } finally { await h.close(); }
    });

    it("records a late cancel after an end and replays that end with the recorded flag without changing its outcome or time", { timeout: INTAKE_ACTIVITY_TIMEOUT }, async () => {
        const h = await intakeActivityFixture(getEnv());
        try {
            const pair = await h.boundPair();
            const write = { op: "end", ...pair, outcome: "interrupted", items: pair.items.map(item => ({ ...item, cancelRequested: false })) };
            expect(await h.settle(write)).toEqual({ ok: true, result: { ended: true } });
            const ended = await h.snapshot();
            const marked = { ...write, items: write.items.map((item, index) => ({ ...item, cancelRequested: index === 0 })) };
            const refused = await h.settle(marked);
            expect(refused).toMatchObject({ ok: false, error: { code: "WORKFLOW_STORE_CORRUPT" } });
            expect(refused.error.message).toContain(pair.items[0].exchangeId);
            expect(await h.snapshot()).toEqual(ended);
            const firstBefore = await h.store.readWorkflowIntake(pair.items[0].exchangeId);
            const secondBefore = await h.store.readWorkflowIntake(pair.items[1].exchangeId);
            const cancel = { op: "request_cancel", recipientSessionId: h.recipientSessionId, invocationId: pair.invocationId, items: [pair.items[0]] };
            expect(await h.settle(cancel)).toEqual({ ok: true, result: { items: [{ exchangeId: pair.items[0].exchangeId, settled: true }] } });
            const recorded = await h.store.readWorkflowIntake(pair.items[0].exchangeId);
            expect(recorded).toMatchObject({ ...firstBefore, cancelRequested: true, updatedAt: expect.stringMatching(/\.\d{6}Z$/) });
            expect(await h.store.readWorkflowIntake(pair.items[1].exchangeId)).toEqual(secondBefore);
            const afterCancel = await h.snapshot();
            expect(afterCancel.effects).toEqual(ended.effects);
            expect(afterCancel.invocations).toEqual(ended.invocations);
            expect(await h.settle(marked)).toEqual({ ok: true, result: { ended: false } });
            expect(await h.settle(cancel)).toEqual({ ok: true, result: { items: [{ exchangeId: pair.items[0].exchangeId, settled: false }] } });
            expect(await h.settle(write)).toEqual({ ok: true, result: { ended: false } });
            expect(await h.snapshot()).toEqual(afterCancel);
            expect(h.sleeps).toEqual([]);
        } finally { await h.close(); }
    });
});
