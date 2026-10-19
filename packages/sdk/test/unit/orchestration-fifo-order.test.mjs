/**
 * The FIFO keeps a person's messages in the order they were sent.
 *
 * decide() merges the prompts queued after the dispatched one into the same
 * turn. Since 1.0.82 (issue 192) it reads the FIFO in place: it steps over
 * timer items, stops at an answer, a kickoff next to a person's words or a
 * carried-steers wake, and removes only what it merged. Nothing is popped
 * and put back, so nothing can be reordered.
 *
 * Before 1.0.82 the merge popped the next item to peek at it and had to put
 * a non-mergeable item back. Putting it back by APPENDING (1.0.69 and older)
 * reordered a person's messages:
 *
 *     [KICKOFF, "do X", "cancel X"]  →  dispatch KICKOFF  →  ["cancel X", "do X"]
 *
 * and putting it back at the HEAD (1.0.70 to 1.0.81) left a timer item at
 * the head that stopped every merge (issue 192).
 *
 * Drives the real generator one step against a fake durable context (a Map
 * for the KV store) — the merge is synchronous before the first yield — and
 * reads what the FIFO holds afterwards.
 *
 * Run: node --test test/unit/orchestration-fifo-order.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createInitialState } from "../../dist/orchestration/state.js";
import { decide, appendToFifo } from "../../dist/orchestration/queue.js";
import { FIFO_BUCKET_COUNT, MAX_BUCKET_BYTES } from "../../dist/orchestration/state.js";

function makeRuntime() {
    const kv = new Map();
    // The durable context: a Map for the KV store, tagged objects for the
    // few operations the driver has to answer, and a no-op for anything
    // else decide() touches on the way to its first turn (status writes,
    // tracing). A Proxy, so a new ctx method in the orchestration does not
    // silently turn this into a test of nothing.
    const explicit = {
        getValue: (k) => kv.get(k),
        setValue: (k, v) => { kv.set(k, v); },
        clearValue: (k) => { kv.delete(k); },
        utcNow: () => ({ op: "utcNow" }),
        newGuid: () => ({ op: "newGuid" }),
        dequeueEvent: () => ({ op: "dequeue" }),
        scheduleTimer: () => ({ op: "timer" }),
        race: () => ({ op: "race" }),
    };
    const ctx = new Proxy(explicit, {
        get: (target, prop) => (prop in target ? target[prop] : () => undefined),
    });
    const input = { sessionId: "s1", config: {} };
    const options = {};
    const state = createInitialState(input, options);
    const runtime = {
        ctx, state, options, input,
        session: { runTurn: () => ({ op: "runTurn" }) },
        manager: { recordSessionEvent: () => ({ op: "record" }) },
    };
    return { runtime, kv };
}

function readFifo(kv) {
    const out = [];
    for (let i = 0; i < 64; i += 1) {
        const raw = kv.get(`fifo.${i}`);
        if (raw) out.push(...JSON.parse(raw));
    }
    return out.map((x) => x.prompt);
}

function readItems(kv) {
    const out = [];
    for (let i = 0; i < 64; i += 1) {
        const raw = kv.get(`fifo.${i}`);
        if (raw) out.push(...JSON.parse(raw));
    }
    return out;
}

function usedBuckets(kv) {
    let used = 0;
    for (let i = 0; i < 64; i += 1) if (kv.get(`fifo.${i}`)) used += 1;
    return used;
}

const timerItem = (type) => ({ kind: "timer", timer: { type, deadlineMs: 1, originalDurationMs: 1000, reason: type }, firedAtMs: 1 });

// decide() drains and merges the FIFO SYNCHRONOUSLY, before its first yield
// (the first yield is the race against the message queue). So one next() is
// the whole merge step, and what the FIFO holds afterwards is exactly what
// the next turn will read. Traced, not assumed.
function runMergeStep(runtime) {
    const gen = decide(runtime);
    const first = gen.next();
    assert.equal(first.done, false, "decide() should have yielded, not returned");
    return first.value;
}

const prompt = (text, extra = {}) => ({ kind: "prompt", prompt: text, bootstrap: false, ...extra });

test("three plain prompts merge into one turn, leaving nothing queued", () => {
    const { runtime, kv } = makeRuntime();
    // No clientMessageIds on the FIRST item: ids make decide() run a
    // cancellation sweep that yields before the merge, which the one-step
    // driver would read as "nothing merged". The peeked items may carry ids;
    // only the popped head triggers the sweep.
    appendToFifo(runtime, [
        prompt("A"),
        prompt("B", { clientMessageIds: ["b"] }),
        prompt("C", { clientMessageIds: ["c"] }),
    ]);
    runMergeStep(runtime);
    assert.deepEqual(readFifo(kv), []);
});

test("a kickoff runs alone, and the person's messages behind it keep their order", () => {
    const { runtime, kv } = makeRuntime();
    appendToFifo(runtime, [
        prompt("KICKOFF", { bootstrap: true, sender: { kind: "system", display: "kickoff" } }),
        prompt("B: do X", { clientMessageIds: ["b"] }),
        prompt("C: actually, cancel X", { clientMessageIds: ["c"] }),
    ]);
    runMergeStep(runtime);
    // The kickoff dispatched by itself. The merge stopped at B without moving
    // it, so the next turn reads "do X" and THEN "cancel X", as they were sent.
    assert.deepEqual(readFifo(kv), ["B: do X", "C: actually, cancel X"]);
});

// R2. The first item carries no ids: ids would make decide() yield in the
// cancel sweep before the merge, and the assertion would then hold whatever
// the merge did (the 1.0.81 version of this test had that flaw).
test("an answer stops the merge, and nothing moves", () => {
    const { runtime, kv } = makeRuntime();
    appendToFifo(runtime, [
        prompt("A"),
        { kind: "answer", answer: "yes" },
        prompt("B", { clientMessageIds: ["b"] }),
    ]);
    runMergeStep(runtime);
    assert.deepEqual(readItems(kv).map((x) => x.kind), ["answer", "prompt"]);
    assert.equal(readItems(kv)[1].prompt, "B");
});

// R1. A timer item at the head no longer stops the merge.
test("prompts behind a timer item merge into one turn, and the timer item stays", () => {
    const { runtime, kv } = makeRuntime();
    appendToFifo(runtime, [
        timerItem("cron"),
        prompt("P1"),
        prompt("P2", { clientMessageIds: ["p2"] }),
        prompt("P3", { clientMessageIds: ["p3"] }),
    ]);
    runMergeStep(runtime);
    assert.deepEqual(readItems(kv).map((x) => x.kind), ["timer"]);
});

// Issue 192 review B: an agents-done item (an older version's queued
// follow-up) does not split a person's prompts either; it stays in place.
test("an agents-done item between prompts is stepped over and stays", () => {
    const { runtime, kv } = makeRuntime();
    appendToFifo(runtime, [
        prompt("P1"),
        { kind: "agents-done", summary: "all agents finished" },
        prompt("P2", { clientMessageIds: ["p2"] }),
    ]);
    runMergeStep(runtime);
    assert.deepEqual(readItems(kv).map((x) => x.kind), ["agents-done"]);
});

test("timer items between prompts are stepped over and keep their order", () => {
    const { runtime, kv } = makeRuntime();
    appendToFifo(runtime, [
        prompt("P1"),
        timerItem("cron"),
        prompt("P2", { clientMessageIds: ["p2"] }),
        timerItem("wait"),
        prompt("P3", { clientMessageIds: ["p3"] }),
    ]);
    runMergeStep(runtime);
    assert.deepEqual(readItems(kv).map((x) => x.timer?.type), ["cron", "wait"]);
});

// R7. No size limit: a backlog spread over several buckets runs as one turn.
test("a backlog spread over several buckets merges into one turn", () => {
    const { runtime, kv } = makeRuntime();
    const big = "x".repeat(6 * 1024);
    const items = [prompt(`P0 ${big}`)];
    for (let i = 1; i < 12; i += 1) items.push(prompt(`P${i} ${big}`, { clientMessageIds: [`p${i}`] }));
    appendToFifo(runtime, items);
    assert.ok(usedBuckets(kv) > 4, "the backlog must span several buckets");
    runMergeStep(runtime);
    assert.deepEqual(readItems(kv), []);
});

// R6. The write position no longer runs off the end while earlier buckets are free.
test("an append at a full last bucket compacts and keeps every item, in order", () => {
    const { runtime, kv } = makeRuntime();
    const tail = [];
    let n = 0;
    while (JSON.stringify(tail).length < MAX_BUCKET_BYTES - 600) tail.push(prompt(`old-${n++} ${"y".repeat(200)}`));
    kv.set(`fifo.${FIFO_BUCKET_COUNT - 1}`, JSON.stringify(tail));
    const lost = appendToFifo(runtime, [prompt("new-1 " + "z".repeat(400)), prompt("new-2 " + "z".repeat(400)), prompt("new-3 " + "z".repeat(400))]);
    assert.deepEqual(lost, []);
    const texts = readItems(kv).map((x) => x.prompt.split(" ")[0]);
    assert.deepEqual(texts, [...tail.map((x) => x.prompt.split(" ")[0]), "new-1", "new-2", "new-3"]);
    assert.ok(kv.has("fifo.0"), "the items now start at bucket 0");
});

// R8. A truly full FIFO reports what it could not store.
test("an append to a truly full FIFO returns the items that did not fit", () => {
    const { runtime, kv } = makeRuntime();
    // Every bucket holds as many equal items as fit, so compaction gains nothing.
    for (let b = 0; b < FIFO_BUCKET_COUNT; b += 1) {
        const bucket = [];
        for (let i = 0; ; i += 1) {
            const item = prompt(`b${String(b).padStart(2, "0")}-${String(i).padStart(3, "0")} ${"q".repeat(200)}`);
            if (JSON.stringify([...bucket, item]).length > MAX_BUCKET_BYTES) break;
            bucket.push(item);
        }
        kv.set(`fifo.${b}`, JSON.stringify(bucket));
    }
    const before = readItems(kv).length;
    const lost = appendToFifo(runtime, [prompt("late-1 " + "w".repeat(800)), prompt("late-2 " + "w".repeat(800))]);
    assert.deepEqual(lost.map((x) => x.prompt.split(" ")[0]), ["late-1", "late-2"]);
    assert.equal(readItems(kv).length, before);
});
