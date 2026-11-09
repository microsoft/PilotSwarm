/**
 * CI run 114: the scale the local suite applies to a test's fixed waits and limits (test/helpers/time-scale.js): 1 on
 * PostgreSQL, 10 on HorizonDB, PS_TEST_TIME_SCALE when it is a positive number.
 *
 * Run: node --test test/unit/test-time-scale.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { timeScaleFor, timeScaler } from "../helpers/time-scale.js";

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
