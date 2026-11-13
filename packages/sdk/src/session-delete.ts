import type { SessionCatalog, SessionRow } from "./cms.js";
import { CMS_RETRY_SETTLE_DELAYS_MS, isTransientCmsError } from "./cms-retry.js";
import { systemSessionProtectedError } from "./types.js";

export const SESSION_DELETE_BUDGET_MS = 50_000;
const ATTEMPT_MS = 3_000;

/** One activity-side budget, shared by every node and retry in a delete request. */
export class SessionDeleteBudget {
    readonly deadlineAtMs: number;

    constructor(deadlineAtMs = Date.now() + SESSION_DELETE_BUDGET_MS) {
        if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= 0) throw new Error("Invalid session deletion deadline");
        this.deadlineAtMs = deadlineAtMs;
    }

    async run<T>(operation: (signal: AbortSignal, deadlineAtMs: number) => Promise<T>, attemptMs?: number): Promise<T> {
        const remaining = this.deadlineAtMs - Date.now();
        const deadlineError = () => Object.assign(new Error("Session deletion deadline exceeded; the subtree was not confirmed deleted."),
            { code: "SESSION_DELETE_DEADLINE" });
        if (remaining <= 0) throw deadlineError();
        const timeoutMs = Math.min(remaining, attemptMs ?? remaining);
        const attemptDeadlineAtMs = Date.now() + timeoutMs;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const expired = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                const error = timeoutMs === remaining ? deadlineError()
                    : Object.assign(new Error("Session deletion attempt timed out"), { code: "ETIMEDOUT" });
                controller.abort(error);
                reject(error);
            }, timeoutMs);
        });
        try {
            return await Promise.race([Promise.resolve().then(() => {
                controller.signal.throwIfAborted();
                return operation(controller.signal, attemptDeadlineAtMs);
            }), expired]);
        } finally { clearTimeout(timer!); }
    }

    async retry<T>(label: string, operation: (signal: AbortSignal, deadlineAtMs: number) => Promise<T>): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            try { return await this.run(operation, ATTEMPT_MS); }
            catch (error) {
                if (!isTransientCmsError(error) || attempt >= CMS_RETRY_SETTLE_DELAYS_MS.length) throw error;
                const pause = CMS_RETRY_SETTLE_DELAYS_MS[attempt];
                console.warn(`[session-delete] ${label}: transient failure; retrying in ${pause}ms`);
                await this.run(signal => new Promise<void>((resolve, reject) => {
                    const abort = () => { clearTimeout(timer); reject(signal.reason); };
                    const timer = setTimeout(() => {
                        signal.removeEventListener("abort", abort);
                        resolve();
                    }, pause);
                    signal.addEventListener("abort", abort, { once: true });
                }));
            }
        }
    }
}

/** Snapshot first; a failed node blocks its ancestors, not its independent siblings. */
export async function deleteSessionSubtree(
    catalog: SessionCatalog,
    rootId: string,
    budget: SessionDeleteBudget,
    deleteOne: (id: string) => Promise<void>,
): Promise<void> {
    const read = (id: string) => budget.retry(`read ${id}`, (signal, deadlineAtMs) => catalog.getSession(id, undefined, { signal, deadlineAtMs }));
    const root = await read(rootId);
    if (!root) return;
    if (root.isSystem) throw systemSessionProtectedError("delete");
    const ids = await budget.retry(`list ${rootId}`, (signal, deadlineAtMs) => catalog.getDescendantSessionIds(rootId, { signal, deadlineAtMs }));
    const rows = new Map<string, SessionRow>([[rootId, root]]);
    for (const id of ids) {
        const row = await read(id);
        if (row) rows.set(id, row);
    }

    const children = new Map<string, string[]>();
    for (const [id, row] of rows) {
        if (id === rootId) continue;
        if (!row.parentSessionId || !rows.has(row.parentSessionId)) {
            throw new Error(`Session deletion snapshot changed at ${id}; retry without deleting its ancestors.`);
        }
        const siblings = children.get(row.parentSessionId) ?? [];
        siblings.push(id);
        children.set(row.parentSessionId, siblings);
    }
    const order: string[] = [], visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string): void => {
        if (visiting.has(id)) throw new Error("Session deletion snapshot contains a parent cycle");
        if (visited.has(id)) return;
        visiting.add(id);
        for (const child of children.get(id) ?? []) visit(child);
        visiting.delete(id);
        visited.add(id);
        order.push(id);
    };
    visit(rootId);
    if (visited.size !== rows.size) throw new Error("Session deletion snapshot contains unreachable descendants");

    const blocked = new Set<string>();
    const failures: Array<{ id: string; error: unknown }> = [];
    for (const id of order) {
        if (blocked.has(id)) continue;
        try {
            if (rows.get(id)!.isSystem) throw systemSessionProtectedError("delete");
            await deleteOne(id);
        } catch (error) {
            failures.push({ id, error });
            let ancestor = rows.get(id)?.parentSessionId;
            while (ancestor && rows.has(ancestor)) {
                blocked.add(ancestor);
                ancestor = rows.get(ancestor)?.parentSessionId;
            }
        }
    }
    if (failures.length) {
        const detail = failures.slice(0, 5).map(({ id, error }) =>
            `${id}: ${error instanceof Error ? error.message : String(error)}`).join("; ");
        throw new AggregateError(failures.map(item => item.error),
            `Session subtree deletion failed for ${failures.length} node(s); ancestors were retained. ` +
            `Some retained sessions may already be cancelled; retry deletion. ${detail}`);
    }
}

/** A cancellation timeout has an unknown outcome: never proceed to soft-delete after it. */
export async function endSessionBeforeDelete(
    budget: SessionDeleteBudget,
    end: () => Promise<unknown>,
    status: () => Promise<{ status: string }>,
): Promise<void> {
    try { await budget.run(end); }
    catch (error) {
        if (error && typeof error === "object" && "code" in error
            && (error.code === "SESSION_DELETE_DEADLINE" || error.code === "ETIMEDOUT")) throw error;
        const observed = await budget.run(status);
        if (!["NotFound", "Completed", "Failed", "Cancelled"].includes(observed.status)) throw error;
    }
}
