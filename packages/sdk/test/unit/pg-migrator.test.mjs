import assert from "node:assert/strict";
import test from "node:test";
import { runMigrations, validateMigrationEntries } from "../../src/pg-migrator.ts";

test("migration entries require exactly one non-empty execution mode", () => {
    assert.throws(
        () => validateMigrationEntries([{ version: "0001", name: "none" }]),
        /exactly one execution mode/,
    );
    assert.throws(
        () => validateMigrationEntries([{ version: "0001", name: "both", sql: "SELECT 1", steps: ["SELECT 2"] }]),
        /exactly one execution mode/,
    );
    assert.throws(
        () => validateMigrationEntries([{ version: "0001", name: "empty", steps: [] }]),
        /at least one statement/,
    );
    assert.throws(
        () => validateMigrationEntries([
            { version: "0001", name: "first", sql: "SELECT 1" },
            { version: "0001", name: "duplicate", sql: "SELECT 2" },
        ]),
        /Duplicate migration version/,
    );
});

test("invalid migration definitions fail before acquiring a pool connection", async () => {
    let connected = false;
    const pool = { connect: async () => { connected = true; throw new Error("should not connect"); } };
    await assert.rejects(
        runMigrations(pool, "test_schema", [{ version: "0001", name: "invalid", sql: "", steps: [] }], 42),
        /exactly one execution mode/,
    );
    assert.equal(connected, false);
});

test("non-transactional steps rerun from the top after partial failure", async () => {
    const executed = [];
    const applied = new Set();
    let failSecondStep = true;
    let lockAttempt = 0;
    const client = {
        async query(sql, params = []) {
            if (sql === "SELECT pg_try_advisory_lock($1) AS locked") {
                lockAttempt += 1;
                return { rows: [{ locked: lockAttempt > 1 }] };
            }
            if (sql.includes("SELECT version FROM")) {
                return { rows: [...applied].map((version) => ({ version })) };
            }
            if (sql.includes("INSERT INTO") && sql.includes("schema_migrations")) {
                applied.add(params[0]);
                return { rows: [] };
            }
            if (sql === "STEP_ONE") {
                executed.push(sql);
                return { rows: [] };
            }
            if (sql === "STEP_TWO") {
                executed.push(sql);
                if (failSecondStep) {
                    failSecondStep = false;
                    throw new Error("step two failed");
                }
                return { rows: [] };
            }
            return { rows: [] };
        },
        release() {},
    };
    const pool = { connect: async () => client };
    const migrations = [{ version: "0029", name: "stepped", steps: ["STEP_ONE", "STEP_TWO"] }];

    await assert.rejects(runMigrations(pool, "test_schema", migrations, 42), /step two failed/);
    assert.equal(applied.has("0029"), false, "failed stepped migration stays unrecorded");

    lockAttempt = 1;
    await runMigrations(pool, "test_schema", migrations, 42);
    assert.deepEqual(executed, ["STEP_ONE", "STEP_TWO", "STEP_ONE", "STEP_TWO"]);
    assert.equal(applied.has("0029"), true, "successful rerun records the migration");
});

/** A migration client stub: the lock is free, no migration is recorded; `fail` names statements that throw. */
function stubClient(fail) {
    const calls = [];
    const released = [];
    const client = {
        async query(sql) {
            calls.push(sql);
            if (sql === "SELECT pg_try_advisory_lock($1) AS locked") return { rows: [{ locked: true }] };
            if (fail[sql]) throw fail[sql];
            return { rows: [] };
        },
        release(error) { released.push(error); },
    };
    return { client, calls, released, pool: { connect: async () => client } };
}

// Review CI-114 (HorizonDB): after a migration failed, its ROLLBACK failed too (a server error), and the connection went
// back to the pool inside an aborted transaction: the next query on the pool failed with "current transaction is aborted".
// A connection whose ROLLBACK or unlock failed is closed (release with the error), never handed back.
test("a connection whose ROLLBACK fails is closed, not handed back to the pool", async () => {
    const lockTimeout = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
    for (const migration of [
        { version: "0111", name: "stepped", steps: ["STEP"] },
        { version: "0112", name: "transactional", sql: "STEP" },
    ]) {
        const h = stubClient({ STEP: lockTimeout, ROLLBACK: new Error("ResourceOwnerEnlarge called after release started") });
        await assert.rejects(runMigrations(h.pool, "test_schema", [migration], 42), (error) => error === lockTimeout);
        assert.equal(h.released.length, 1);
        assert.match(String(h.released[0]?.message), /ResourceOwnerEnlarge/, `${migration.name}: released with the error`);
        assert.equal(h.calls.includes("SELECT pg_advisory_unlock($1)"), false, "no statement on the aborted connection after it");
    }
});

test("a connection whose unlock fails is closed; a clean run hands its connection back", async () => {
    const failing = stubClient({ "SELECT pg_advisory_unlock($1)": new Error("connection lost") });
    await runMigrations(failing.pool, "test_schema", [{ version: "0001", name: "one", sql: "SELECT 1" }], 42);
    assert.match(String(failing.released[0]?.message), /connection lost/);

    const clean = stubClient({});
    await runMigrations(clean.pool, "test_schema", [{ version: "0001", name: "one", sql: "SELECT 1" }], 42);
    assert.deepEqual(clean.released, [undefined]);
    assert.equal(clean.calls.includes("SELECT pg_advisory_unlock($1)"), true);
});
