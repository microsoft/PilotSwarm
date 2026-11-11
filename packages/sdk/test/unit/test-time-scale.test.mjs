/**
 * CI run 114: the scale the local suite applies to a test's fixed waits and limits (test/helpers/time-scale.js): 1 on
 * PostgreSQL, 10 on HorizonDB, PS_TEST_TIME_SCALE when it is a positive number.
 *
 * Run: node --test test/unit/test-time-scale.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runtimeProviderFromEnv, timeScaleFor, timeScaler, vitestTimeouts } from "../helpers/time-scale.js";

test("the scale per provider, and the override", () => {
    assert.equal(timeScaleFor("postgres", {}), 1);
    assert.equal(timeScaleFor("horizondb", {}), 10);
    assert.equal(timeScaleFor("unknown", {}), 1);
    assert.equal(timeScaleFor("postgres", { PS_TEST_TIME_SCALE: "4" }), 4);
    assert.equal(timeScaleFor("horizondb", { PS_TEST_TIME_SCALE: "1.5" }), 1.5);
    for (const ignored of ["", "0", "-2", "fast"]) assert.equal(timeScaleFor("horizondb", { PS_TEST_TIME_SCALE: ignored }), 10, ignored);
});

test("a scaler rounds up to whole milliseconds and seconds", () => {
    const scaled = timeScaler(1.5);
    assert.equal(scaled.scale, 1.5);
    assert.equal(scaled.ms(1_001), 1_502);
    assert.equal(scaled.seconds(3), 5);
    assert.equal(timeScaler(1).ms(250), 250);
});

test("the provider an environment selects, as the storage config resolves it", () => {
    assert.equal(runtimeProviderFromEnv({}), "postgres");
    assert.equal(runtimeProviderFromEnv({ HORIZON_DATABASE_URL: "postgres://h" }), "horizondb");
    assert.equal(runtimeProviderFromEnv({ HORIZON_DATABASE_URL: "  " }), "postgres");
    assert.equal(runtimeProviderFromEnv({ PILOTSWARM_RUNTIME_PROVIDER: "horizon" }), "horizondb");
    assert.equal(runtimeProviderFromEnv({ PILOTSWARM_RUNTIME_PROVIDER: "pg", HORIZON_DATABASE_URL: "postgres://h" }), "postgres");
    assert.equal(runtimeProviderFromEnv({ PILOTSWARM_RUNTIME_PROVIDER: "horizondb" }), "horizondb");
});

test("vitest limits grow by the time scale on HorizonDB only, at most threefold", () => {
    assert.deepEqual(vitestTimeouts("postgres", {}), { testTimeout: 300_000, hookTimeout: 120_000 });
    assert.deepEqual(vitestTimeouts("postgres", { PS_TEST_TIME_SCALE: "4" }), { testTimeout: 300_000, hookTimeout: 120_000 });
    assert.deepEqual(vitestTimeouts("horizondb", {}), { testTimeout: 900_000, hookTimeout: 360_000 });
    assert.deepEqual(vitestTimeouts("horizondb", { PS_TEST_TIME_SCALE: "50" }), { testTimeout: 900_000, hookTimeout: 360_000 });
    assert.deepEqual(vitestTimeouts("horizondb", { PS_TEST_TIME_SCALE: "3" }), { testTimeout: 900_000, hookTimeout: 360_000 });
    assert.deepEqual(vitestTimeouts("horizondb", { PS_TEST_TIME_SCALE: "2" }), { testTimeout: 600_000, hookTimeout: 240_000 });
    assert.deepEqual(vitestTimeouts("horizondb", { PS_TEST_TIME_SCALE: "0.5" }), { testTimeout: 150_000, hookTimeout: 60_000 });
});
