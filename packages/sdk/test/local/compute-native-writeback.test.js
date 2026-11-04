import { describe, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { PgSessionCatalog } from "../../src/cms.ts";
import { PgComputeExecutionAuthority } from "../../src/compute-execution-store.ts";
import { prepareComputeWriteback, publishComputeWriteback } from "../../src/compute-writeback.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { computeNativeMigration } from "../../src/migrations/compute-native-0089.ts";

// Explicit dedicated test database only: never fall back to a live DATABASE_URL.
const database = process.env.PS_TEST_DATABASE_URL;
async function withCatalog(run, beforeInitialize) {
    const schema = `ps_native_${randomUUID().replaceAll("-", "")}`;
    const pool = new pg.Pool({ connectionString: database });
    const catalog = await PgSessionCatalog.create(database, schema);
    let before;
    try {
        before = await beforeInitialize?.({ catalog, pool, schema });
        await catalog.initialize();
        await run({ catalog, pool, schema, before });
    }
    finally {
        await catalog.close();
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
    }
}

function completion() {
    const at = new Date("2026-01-01T00:00:00Z");
    return {
        turnKey: "fixture-turn", transcriptEpoch: 0,
        execution: { sessionId: "session", transcriptEpoch: 0, turnKey: "fixture-turn", attemptId: "fixture-attempt",
            workerNodeId: "original-worker", generation: "fixture-generation" },
        turn: {
            sessionId: "session", turnIndex: 0, agentId: null, model: "fixture-model", reasoningEffort: null,
            startedAt: at, endedAt: at, lastActiveAt: at, durationMs: 0,
            tokensInput: 11, tokensOutput: 7, tokensCacheRead: 3, tokensCacheWrite: 0, toolCalls: 1, toolErrors: 0,
            resultType: "completed", errorMessage: null, workerNodeId: "original-worker", state: "idle",
            lastError: null, waitReason: null, currentIteration: 0,
        },
        providerCharge: {
            sessionId: "session", turnIndex: 0, ledgerTurnIndex: 100, providerName: "original-provider",
            modelQualified: "original-provider:fixture-model", ownerUserId: null, chargeClass: "system",
            tokensInput: 11, tokensOutput: 7, tokensCacheRead: 3, tokensCacheWrite: 0,
        },
    };
}

describe.skipIf(!database).concurrent("native authority/completion (requires explicit PS_TEST_DATABASE_URL)", () => {
    it("upgrades main 0087 through both compute migrations without changing local sessions or MOTD data", async () => {
        await withCatalog(async ({ catalog, pool, schema, before }) => {
            expect((await catalog.getSession("local-before-native")).isSystem).toBe(true);
            expect((await pool.query(`SELECT data FROM "${schema}".session_events WHERE session_id='local-before-native'`)).rows[0].data).toEqual({ retained: true });
            expect((await pool.query(`SELECT max(version) AS version FROM "${schema}".schema_migrations`)).rows[0].version).toBe("0089");
            expect((await pool.query(`SELECT * FROM "${schema}".schema_migrations WHERE version <= '0087' ORDER BY version`)).rows).toEqual(before.migrations);
            expect((await pool.query(`SELECT * FROM "${schema}".motds`)).rows).toEqual(before.motds);
            const target = await catalog.computeTargets.create({ name: "shared/upgrade", kind: "fixture" }, null, true);
            expect(target.name).toBe("shared/upgrade");
            catalog.defaultComputeTarget = "shared/upgrade";
            await catalog.createSession("default-target-system", { isSystem: true });
            expect((await catalog.getSessionCreationConfig("default-target-system")).computeTargetId).toBe(target.id);
            await pool.query(computeNativeMigration(schema));
            expect(await catalog.computeExecution.inspect("local-before-native")).toBeNull();
        }, async ({ catalog, pool, schema }) => {
            await runMigrations(pool, schema, CMS_MIGRATIONS(schema).filter(migration => migration.version <= "0087"), 0x636d73);
            await catalog.createSession("local-before-native", { isSystem: true });
            await catalog.recordEvents("local-before-native", [{ eventType: "session.fixture", data: { retained: true } }]);
            await catalog.motds.create({ principal: { provider: "test", subject: "migration-admin" }, isAdmin: true }, {
                bodyMd: "Preserved message", requestId: randomUUID(), fromAt: "2020-01-01T00:00:00Z",
            });
            return { migrations: (await pool.query(`SELECT * FROM "${schema}".schema_migrations ORDER BY version`)).rows,
                motds: (await pool.query(`SELECT * FROM "${schema}".motds`)).rows };
        });
    });

    it("deduplicates concurrent completion and retains the original admitted ledger coordinate", async () => {
        await withCatalog(async ({ catalog, pool, schema }) => {
            await catalog.createSession("session", { isSystem: true });
            await pool.query(`UPDATE "${schema}".sessions SET provider_ledger_base=200 WHERE session_id='session'`);
            const input = completion();
            const receipt = prepareComputeWriteback(input);
            await Promise.all(Array.from({ length: 8 }, () => publishComputeWriteback(catalog, receipt, {
                sessionId: "session", turnKey: input.turnKey, transcriptEpoch: 0, turnIndex: 0,
            })));
            const count = async table => Number((await pool.query(`SELECT count(*) AS n FROM "${schema}"."${table}" WHERE session_id='session'`)).rows[0].n);
            expect(await count("compute_turn_completions")).toBe(1);
            expect(await count("session_turn_metrics")).toBe(1);
            expect(await count("provider_usage_ledger")).toBe(1);
            const ledger = (await pool.query(`SELECT provider_name,turn_index FROM "${schema}".provider_usage_ledger WHERE session_id='session'`)).rows[0];
            expect(ledger).toEqual({ provider_name: "original-provider", turn_index: 100 });
            expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".session_events WHERE session_id='session' AND event_type='session.turn_completed'`)).rows[0].n).toBe(1);
            console.log("  native completion: one receipt/event/metric/charge at original admitted ledger index");
        });
    });

    it("rolls the whole completion transaction back when settlement is invalid", async () => {
        await withCatalog(async ({ catalog, pool, schema }) => {
            await catalog.createSession("session", { isSystem: true });
            const input = completion();
            input.providerCharge.tokensInput = "invalid";
            await expect(catalog.completeExecutionTurnWriteback(input)).rejects.toThrow();
            for (const table of ["compute_turn_completions", "session_turn_metrics", "provider_usage_ledger"]) {
                expect(Number((await pool.query(`SELECT count(*) AS n FROM "${schema}"."${table}" WHERE session_id='session'`)).rows[0].n)).toBe(0);
            }
        });

    });

    it("preserves the original Stop outcome for replay and rejects corrupt recovery metadata", async () => {
        await withCatalog(async ({ catalog, pool, schema }) => {
            await catalog.createSession("session", { isSystem: true });
            const input = completion();
            input.turn.resultType = "stopped";
            input.turn.stoppedOutcome = { type: "stopped", reason: "owned user Stop", snapshotVersion: 3, workspaceAttached: true,
                events: [{ eventType: "session.fixture", data: { retained: true } }] };
            const receipt = prepareComputeWriteback(input);
            await publishComputeWriteback(catalog, receipt, { sessionId: "session", turnKey: input.turnKey, transcriptEpoch: 0, turnIndex: 0 });
            expect(await catalog.getComputeStoppedOutcome("session", input.turnKey, 0)).toEqual(input.turn.stoppedOutcome);
            expect(await catalog.getComputeStoppedOutcome("session", input.turnKey, 1)).toBeNull();
            await pool.query(`UPDATE "${schema}".compute_turn_completions SET receipt=receipt #- '{turn,stoppedOutcome}' WHERE session_id='session'`);
            await expect(catalog.getComputeStoppedOutcome("session", input.turnKey, 0)).rejects.toThrow(/invalid/);
        });
    });

    it("unknown allocation-only ownership remains held through verified retirement reconciliation", async () => {
        await withCatalog(async ({ catalog, pool, schema }) => {
            const a = catalog.computeExecution, b = new PgComputeExecutionAuthority(pool, schema);
            const request = { sessionId: "session", transcriptEpoch: 0, turnKey: "turn", attemptId: "a", workerNodeId: "worker-a" };
            const identity = await a.acquire(request);
            await a.finish(identity, "unknown");
            await a.recordFailure(identity, "owned failure detail");
            await a.recordFailure(identity, "owned failure detail");
            expect((await b.inspect("session")).detail).toBe("owned failure detail");
            expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".session_events WHERE event_type='session.error'`)).rows[0].n).toBe(1);
            const entered = Promise.withResolvers(), resume = Promise.withResolvers();
            const reconciliation = b.reconcile(identity, async () => { entered.resolve(); await resume.promise; return "retired"; });
            await entered.promise;
            await expect(a.acquire({ ...request, attemptId: "replacement" })).rejects.toThrow(/reconciliation/);
            resume.resolve();
            expect(await reconciliation).toBe(true);
            const replacement = await a.acquire({ ...request, attemptId: "replacement" });
            expect(replacement.generation).not.toBe(identity.generation);
            await expect(b.recordFailure(identity, "stale failure")).rejects.toThrow(/Stale/);
        });
    });

    it("winning-receipt repair settles only known publication/completion operations after an acknowledgement loss", async () => {
        await withCatalog(async ({ catalog, pool, schema }) => {
            await catalog.createSession("session", { isSystem: true });
            const authority = catalog.computeExecution;
            const input = completion();
            input.execution = await authority.acquire({
                sessionId: "session", transcriptEpoch: 0, turnKey: input.turnKey, attemptId: "owned-attempt", workerNodeId: "original-worker",
            });
            const receipt = prepareComputeWriteback(input);
            await pool.query(`SELECT "${schema}".cms_compute_execution_begin($1::jsonb,$2)`,
                [JSON.stringify(input.execution), `publication:${input.turnKey}`]);
            await expect(authority.runCurrent(input.execution, `completion:${input.turnKey}`, async () => {
                await publishComputeWriteback(catalog, receipt, { sessionId: "session", turnKey: input.turnKey, transcriptEpoch: 0, turnIndex: 0 });
                throw new Error("owned acknowledgement lost after database commit");
            })).rejects.toThrow(/acknowledgement lost/);
            expect((await authority.inspect("session")).pendingOperations).toBe(0);
            expect((await authority.inspect("session")).phase).toBe("unknown");
            await publishComputeWriteback(catalog, receipt, { sessionId: "session", turnKey: input.turnKey, transcriptEpoch: 0, turnIndex: 0 });
            expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".provider_usage_ledger`)).rows[0].n).toBe(1);
            expect(await authority.reconcile(input.execution, async () => "retired")).toBe(true);
            console.log("  winning receipt repairs only reserved CAS/completion admissions, with no duplicate charge");
        });
    });

    it("two controllers cannot replace an admitted or unresolved asynchronous operation", async () => {
        await withCatalog(async ({ catalog, pool, schema }) => {
            const a = catalog.computeExecution;
            const b = new PgComputeExecutionAuthority(pool, schema);
            const request = { sessionId: "session", transcriptEpoch: 0, turnKey: "turn", attemptId: "a", workerNodeId: "worker-a" };
            const identity = await a.acquire(request);
            const entered = Promise.withResolvers(), resume = Promise.withResolvers();
            const effect = a.runCurrent(identity, "owned-operation", async () => { entered.resolve(); await resume.promise; });
            await entered.promise;
            await expect(b.acquire({ ...request, attemptId: "b", workerNodeId: "worker-b" })).rejects.toThrow(/reconciliation/);
            await expect(a.seal(identity)).rejects.toThrow(/not settled/);
            resume.resolve();
            await effect;
            await a.seal(identity);
            await a.finish(identity, "committed");
            await a.finish(identity, "released");
            await a.finish(identity, "released");
            await expect(a.finish(identity, "unknown")).rejects.toThrow(/cannot reopen/);
            await expect(a.recordFailure(identity, "late failure after recovery release")).rejects.toThrow(/Stale/);
            await expect(pool.query(`SELECT "${schema}".cms_compute_execution_end($1::jsonb,$2,FALSE)`,
                [JSON.stringify(identity), "owned-operation"])).rejects.toThrow(/stale operation completion/);
            expect((await a.inspect("session")).phase).toBe("released");
            const replacement = await b.acquire({ ...request, attemptId: "b", workerNodeId: "worker-b" });
            await expect(a.runCurrent(identity, "stale", async () => {})).rejects.toThrow(/stale/);
            await expect(b.runCurrent(replacement, "uncertain", async () => { throw new Error("unknown external outcome"); })).rejects.toThrow(/unknown external/);
            expect((await b.inspect("session")).phase).toBe("unknown");
            expect((await b.inspect("session")).pendingOperations).toBe(1);
            let verified = false;
            expect(await b.reconcile(replacement, async () => { verified = true; return "retired"; })).toBe(false);
            expect(verified).toBe(false, "retiring a runtime cannot clear an unresolved worker-side effect");
            console.log("  real database authority refuses stale/two-controller takeover and unresolved effects");
        });
    });
});
