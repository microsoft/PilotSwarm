import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("controller version timing follows the selected database time scale", () => {
    const text = readFileSync(new URL("../local/workflow-controller-versions.test.js", import.meta.url), "utf8");
    assert.match(text, /const TIMEOUT = testTime\.ms\(120_000\)/);
    assert.match(text, /timeoutMs = testTime\.ms\(60_000\)/);
    assert.match(text, /testTime\.seconds\(20\)/);
    assert.match(text, /waitForOrchestration\(controllerInstanceId, testTime\.ms\(60_000\)\)/);
    assert.doesNotMatch(text, /waitForOrchestration\(controllerInstanceId, 60_000\)/);
});

test("the lock-wait probe returns the blocked backend and its diagnostic fields", async () => {
    const text = readFileSync(new URL("../local/sweeper-final-check.test.js", import.meta.url), "utf8");
    const body = text.slice(text.indexOf("async function untilLockWait("), text.indexOf("/** The catalog,"));
    const probe = new Function(`${body}; return untilLockWait;`)();
    const blocked = { pid: 222, query: "UPDATE fixture SET value = 1", wait_event_type: "Lock", wait_event: "transactionid" };
    let statement;
    const db = { query: async sql => { statement = sql; return { rows: [{ n: 1, ...blocked }] }; } };
    const result = await probe(db, "blocker", 111, new Promise(() => {}));
    assert.deepEqual(result, { n: 1, ...blocked });
    for (const name of ["pid", "query", "wait_event_type", "wait_event"]) assert.ok(statement.includes(name), name);
    assert.match(text, /JSON\.stringify\((?:waited|blocked|wait)\)/);
});
