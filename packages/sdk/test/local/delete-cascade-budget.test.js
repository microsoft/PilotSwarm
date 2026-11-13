import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDeleteBudget, deleteSessionSubtree, endSessionBeforeDelete } from "../../src/session-delete.ts";
import { deleteTransaction } from "../../src/cms-delete-transaction.ts";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("delete budget cuts work, not only retry delays", () => {
    it("cuts a hung attempt at the remaining deadline, without a fresh full attempt budget", async () => {
        vi.useFakeTimers();
        const start = Date.now(), signals = [];
        const budget = new SessionDeleteBudget(start + 500);
        const result = budget.retry("hung", signal => {
            signals.push(signal);
            return new Promise(() => {});
        }).catch(error => error);
        await vi.runAllTimersAsync();
        expect(await result).toMatchObject({ code: "SESSION_DELETE_DEADLINE" });
        expect(Date.now() - start).toBe(500);
        expect(signals).toHaveLength(1);
        expect(signals[0].aborted).toBe(true);
    });

    it("uses one budget across siblings and never starts a later node after it expires", async () => {
        vi.useFakeTimers();
        const budget = new SessionDeleteBudget(Date.now() + 100);
        const nodes = new Map([
            ["root", { sessionId: "root", parentSessionId: null }],
            ["a", { sessionId: "a", parentSessionId: "root" }],
            ["b", { sessionId: "b", parentSessionId: "root" }],
        ]);
        const attempted = [];
        const result = deleteSessionSubtree({
            getSession: async id => nodes.get(id),
            getDescendantSessionIds: async () => ["a", "b"],
        }, "root", budget, id => budget.run(() => {
            attempted.push(id);
            return new Promise(() => {});
        })).catch(error => error);
        await vi.runAllTimersAsync();
        expect(await result).toBeInstanceOf(AggregateError);
        expect(attempted).toEqual(["a"]);
    });

    it("does not treat a cancellation timeout as an absent orchestration", async () => {
        vi.useFakeTimers();
        const status = vi.fn(async () => ({ status: "NotFound" }));
        const result = endSessionBeforeDelete(new SessionDeleteBudget(Date.now() + 100),
            () => new Promise(() => {}), status).catch(error => error);
        await vi.runAllTimersAsync();
        expect(await result).toMatchObject({ code: "SESSION_DELETE_DEADLINE" });
        expect(status).not.toHaveBeenCalled();
    });
});

describe("deadline-aware catalog transactions do not leave queued writes", () => {
    it("releases a connection acquired after timeout without issuing a statement", async () => {
        vi.useFakeTimers();
        const acquired = Promise.withResolvers();
        const client = { query: vi.fn(), release: vi.fn() };
        const work = vi.fn();
        const result = new SessionDeleteBudget(Date.now() + 100).retry("connect",
            (signal, deadline) => deleteTransaction({ connect: () => acquired.promise }, signal, work, deadline))
            .catch(error => error);
        await vi.runAllTimersAsync();
        expect(await result).toMatchObject({ code: "SESSION_DELETE_DEADLINE" });
        acquired.resolve(client);
        await Promise.resolve();
        await Promise.resolve();
        expect(client.release).toHaveBeenCalledTimes(1);
        expect(client.query).not.toHaveBeenCalled();
        expect(work).not.toHaveBeenCalled();
    });

    it("destroys an aborted transaction and does not issue its late follow-up or COMMIT", async () => {
        const blocked = Promise.withResolvers(), entered = Promise.withResolvers();
        const client = {
            release: vi.fn(),
            query: vi.fn(async query => {
                if (query.text === "blocked statement") {
                    entered.resolve();
                    return blocked.promise;
                }
                return { rows: [] };
            }),
        };
        const controller = new AbortController();
        const result = deleteTransaction({ connect: async () => client }, controller.signal, async query => {
            await query("blocked statement");
            await query("must not run");
        }).catch(error => error);
        await entered.promise;
        controller.abort(new Error("deadline"));
        expect(await result).toMatchObject({ message: "deadline" });
        blocked.resolve({ rows: [] });
        await Promise.resolve();
        await Promise.resolve();
        expect(client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
        expect(client.query.mock.calls.map(([query]) => query.text)).not.toContain("must not run");
        expect(client.query.mock.calls.map(([query]) => query.text)).not.toContain("COMMIT");
    });

    it("reports a COMMIT acknowledgement failure as unknown, never as success", async () => {
        const client = {
            release: vi.fn(),
            query: vi.fn(async query => {
                if (query.text === "COMMIT") throw new Error("commit acknowledgement lost");
                return { rows: [] };
            }),
        };
        await expect(deleteTransaction({ connect: async () => client }, new AbortController().signal,
            query => query("delete statement"))).rejects.toThrow("commit acknowledgement lost");
        expect(client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    });
});
