import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ComputeExecutionAuthority, ComputeExecutionIdentity, ComputeExecutionStatus } from "./compute-execution.js";
import { sameComputeIdentity } from "./compute-native-state.js";

/** PostgreSQL's normal transactional semantics, independent of the compute/deployment provider. */
export class PgComputeExecutionAuthority implements ComputeExecutionAuthority {
    private readonly schema: string;
    constructor(private readonly pool: Pick<Pool, "query">, schema: string) {
        this.schema = `"${schema.replace(/"/g, '""')}"`;
    }

    async acquire(request: Omit<ComputeExecutionIdentity, "generation">): Promise<ComputeExecutionIdentity> {
        const identity = { ...request, generation: randomUUID() };
        await this.pool.query(`SELECT ${this.schema}.cms_compute_execution_acquire($1::jsonb)`, [JSON.stringify(identity)]);
        return identity;
    }

    async runCurrent<T>(identity: ComputeExecutionIdentity, operationId: string, operation: () => Promise<T>): Promise<T> {
        await this.pool.query(`SELECT ${this.schema}.cms_compute_execution_begin($1::jsonb,$2)`, [JSON.stringify(identity), operationId]);
        let value: T;
        try { value = await operation(); }
        catch (error) {
            // A failed asynchronous effect may have reached its destination.
            // Its durable operation remains unknown until evidence-driven reconciliation.
            try {
                await this.pool.query(`SELECT ${this.schema}.cms_compute_execution_end($1::jsonb,$2,$3)`,
                    [JSON.stringify(identity), operationId, false]);
            } catch (recordingError) { throw new AggregateError([error, recordingError], "Compute effect and uncertainty recording failed"); }
            throw error;
        }
        await this.pool.query(`SELECT ${this.schema}.cms_compute_execution_end($1::jsonb,$2,$3)`,
            [JSON.stringify(identity), operationId, true]);
        return value;
    }

    async seal(identity: ComputeExecutionIdentity): Promise<void> {
        await this.finishPhase(identity, "sealed");
    }
    async finish(identity: ComputeExecutionIdentity, phase: "committed" | "unknown" | "released"): Promise<void> {
        await this.finishPhase(identity, phase);
    }
    private async finishPhase(identity: ComputeExecutionIdentity, phase: string): Promise<void> {
        await this.pool.query(`SELECT ${this.schema}.cms_compute_execution_phase($1::jsonb,$2)`, [JSON.stringify(identity), phase]);
    }
    async inspect(sessionId: string): Promise<ComputeExecutionStatus | null> {
        const { rows } = await this.pool.query(`SELECT ${this.schema}.cms_compute_execution_inspect($1) AS status`, [sessionId]);
        return rows[0]?.status ?? null;
    }
    async recordBinding(identity: ComputeExecutionIdentity, binding: NonNullable<ComputeExecutionStatus["binding"]>): Promise<void> {
        await this.pool.query(`SELECT ${this.schema}.cms_compute_execution_binding($1::jsonb,$2::jsonb)`,
            [JSON.stringify(identity), JSON.stringify(binding)]);
    }
    async requestReconciliation(sessionId: string): Promise<void> {
        await this.pool.query(`SELECT ${this.schema}.cms_compute_execution_request_reconcile($1)`, [sessionId]);
    }
    async recordFailure(identity: ComputeExecutionIdentity, detail: string): Promise<void> {
        await this.pool.query(`SELECT ${this.schema}.cms_compute_execution_failure($1::jsonb,$2)`,
            [JSON.stringify(identity), detail.slice(0, 4_000)]);
    }
    async listReconciliationRequests(): Promise<ComputeExecutionStatus[]> {
        const { rows } = await this.pool.query(`SELECT status FROM ${this.schema}.cms_compute_execution_reconcile_requests()`);
        return rows.map(row => row.status);
    }
    async reconcile(identity: ComputeExecutionIdentity, verify: (status: ComputeExecutionStatus) => Promise<"retired" | "unknown">): Promise<boolean> {
        const status = await this.inspect(identity.sessionId);
        if (!status || !sameComputeIdentity(status.identity, identity) || status.pendingOperations !== 0) return false;
        if (await verify(status) !== "retired") return false;
        const { rows } = await this.pool.query(`SELECT ${this.schema}.cms_compute_execution_reconciled($1::jsonb) AS released`, [JSON.stringify(identity)]);
        return rows[0]?.released === true;
    }
}
