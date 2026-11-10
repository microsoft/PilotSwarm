/**
 * Durable recipient intake (1.0.83, the latest version): the claim and settle activities
 * (workflow/v2/intake-activities.ts; design docs/proposals/workflow-durable-intake.md
 * 5.2, 5.4 and section 8, amendment 2), driven over a recording fake store
 * with recorded waits.
 *
 * - Only a test registers them, under their design names, and the full-engine
 *   worker module (workflow/v2/milestone-worker.ts, which every worker
 *   loads); no other production
 *   source imports their module or registers them, their names are written
 *   once in the shared intake definition, and only that module declares the
 *   workflow-request capability for a worker (the Workflow controller routes its own
 *   activities with it).
 * - The claim renders with the sender's own renderer; every settlement goes
 *   to its one store write with exactly the fields given.
 * - A transient store error is retried after 1 s, 5 s and 15 s, then thrown;
 *   a failure no retry can fix (a programming error, a PostgreSQL error of
 *   class 22, 23 or 42) is thrown at once, marked WORKFLOW_INTAKE_NON_RETRYABLE
 *   in its message; any other failure and a worker without a store throw at
 *   once, unmarked; the store's refusal of a broken invariant or a malformed
 *   input is an answer, `{ ok: false, error }`, and a malformed activity
 *   input reaches no store.
 *
 * Run: node --test test/unit/workflow-v2-intake-activities.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import {
    WORKFLOW_INTAKE_ACTIVITIES, WORKFLOW_INTAKE_RETRY_DELAYS_MS, WorkflowIntakeUnavailableError, registerWorkflowIntakeActivities,
    runWorkflowIntakeClaim, runWorkflowIntakeSettle, workflowIntakeRender,
} from "../../dist/workflow/v2/intake-activities.js";
import { workflowSendClientMessageId, workflowSendPrompt } from "../../dist/workflow/v2/runtime.js";
import { WorkflowStoreError } from "../../dist/workflow/v2/store.js";
import { IntakeShapeError, intakeEnvelopeClientMessageId } from "../../dist/workflow/v2/intake.js";

const SRC = new URL("../../src/", import.meta.url);

function allSourceFiles(dir = "") {
    const out = [];
    for (const name of readdirSync(new URL(dir || ".", SRC))) {
        const path = dir ? `${dir}/${name}` : name;
        if (statSync(new URL(path, SRC)).isDirectory()) out.push(...allSourceFiles(path));
        else if (name.endsWith(".ts")) out.push(path);
    }
    return out;
}

/** A source file's import and re-export specifiers, static and dynamic. */
function importsOf(text) {
    return [...text.matchAll(/^(?:import|export)\b[^\n]*?\sfrom\s+"([^"]+)"|^\}\s+from\s+"([^"]+)"|\bimport\("([^"]+)"\)/gm)]
        .map(match => match[1] ?? match[2] ?? match[3]);
}

/** A source file's code without its comments (block comments, and line comments not inside a URL), so prose names nothing. */
const withoutComments = text => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

const METHODS = ["claimWorkflowIntake", "bindWorkflowIntake", "endWorkflowIntake", "cancelHeldWorkflowIntake", "cancelUnsentWorkflowIntake",
    "requestCancelWorkflowIntake", "refuseHeldWorkflowIntake"];

/**
 * A store whose intake methods record each call and answer from `script`:
 * per method, a value, an error to throw, or a function of (input, the
 * method's call count) giving either.
 */
function fakeStore(script = {}) {
    const calls = [];
    const store = {};
    for (const name of METHODS) {
        store[name] = async input => {
            calls.push({ name, input });
            const entry = script[name];
            const step = typeof entry === "function" ? entry(input, calls.filter(call => call.name === name).length) : entry;
            if (step instanceof Error) throw step;
            return step ?? { method: name };
        };
    }
    return { store, calls };
}

function harness(script = {}) {
    const { store, calls } = fakeStore(script);
    const sleeps = [];
    const logs = [];
    const deps = { store, sleep: async ms => { sleeps.push(ms); } };
    return { deps, calls, sleeps, logs, log: message => logs.push(message) };
}

const transient = () => Object.assign(new Error("could not serialize access due to concurrent update"), { code: "40001" });
const X1 = `nx-${"1".repeat(40)}`;
const X2 = `nx-${"2".repeat(40)}`;
const ENVELOPE = {
    v: 1, exchangeId: X1, workflowSessionId: "wf", runId: "run", recipientSessionId: "me", contract: "Note@1",
    payloadSha256: "a".repeat(64), envelopeSha256: "b".repeat(64),
};
const CLAIM = { recipientSessionId: "me", envelope: ENVELOPE, claimId: "claim-1", mode: "accept" };

async function refused(promise, code) {
    const answer = await promise;
    assert.equal(answer.ok, false, JSON.stringify(answer));
    assert.equal(answer.error.code, code, answer.error.message);
    return answer.error;
}

// ─── Registration ────────────────────────────────────────────

test("only a test or the full-engine worker module registers the intake activities; no other production source imports their module or registers them, their names live in the shared definition, and only that worker module declares the capability that routes them", async () => {
    assert.deepEqual({ ...WORKFLOW_INTAKE_ACTIVITIES }, { claim: "claimWorkflowIntake", settle: "settleWorkflowIntake" });
    const registered = new Map();
    const h = harness({ claimWorkflowIntake: { result: "duplicate", state: "holding" } });
    registerWorkflowIntakeActivities({ registerActivity: (name, fn) => registered.set(name, fn) }, h.deps);
    assert.deepEqual([...registered.keys()], ["claimWorkflowIntake", "settleWorkflowIntake"]);
    const traced = [];
    const actx = { traceWarn: message => traced.push(message), traceInfo: message => traced.push(message) };
    assert.deepEqual(await registered.get("claimWorkflowIntake")(actx, CLAIM), { ok: true, result: { result: "duplicate", state: "holding" } });
    assert.deepEqual(await registered.get("settleWorkflowIntake")(actx, { op: "refuse", recipientSessionId: "me", exchangeId: X1, claimId: "claim-1",
        outcome: "refused_full" }), { ok: true, result: { method: "refuseHeldWorkflowIntake" } });
    const MILESTONE = "workflow/v2/milestone-worker.ts";
    const namedIn = [];
    for (const path of allSourceFiles()) {
        if (path === "workflow/v2/intake-activities.ts") continue;
        const text = readFileSync(new URL(path, SRC), "utf8");
        const code = withoutComments(text);
        // The activities' module (their handlers over the store) is imported, and the activities registered, only by the
        // test-only milestone worker module.
        assert.equal(importsOf(text).some(specifier => /(?:^|\/)intake-activities(?:\.js)?$/.test(specifier)), path === MILESTONE,
            `${path} imports the intake activities`);
        assert.equal(code.includes("registerWorkflowIntakeActivities"), path === MILESTONE, `${path} registers the intake activities`);
        // Their names are written once, in the shared intake definition; the inactive 1.0.83 tree schedules them by that constant.
        if (/["'`](?:claimWorkflowIntake|settleWorkflowIntake)["'`]/.test(code)) namedIn.push(path);
        // The capability that routes them is defined once. The Workflow controller routes its own activities with it
        // (workflow/v2/runtime.ts), and only the milestone worker module declares it for a worker; the inactive 1.0.83 tree,
        // and the session proxy for the turns of its workflow-intake contract, route with routeWorkflowRequestActivity.
        if (!["activity-routing.ts", "workflow/v2/runtime.ts", MILESTONE].includes(path)) {
            assert.ok(!code.includes("WORKFLOW_REQUEST_CAPABILITY") && !code.includes("pilotswarm.workflow-request.v1"), `${path} names the workflow-request capability`);
        }
        if (path !== "activity-routing.ts" && !path.startsWith("orchestration/") && path !== "session-proxy.ts") {
            assert.ok(!code.includes("routeWorkflowRequestActivity"), `${path} routes with the workflow-request capability`);
        }
        // Only the worker loads the milestone worker module.
        if (path !== "worker.ts") {
            assert.ok(!importsOf(text).some(specifier => /milestone-worker(?:\.js)?$/.test(specifier)), `${path} imports the milestone worker module`);
        }
    }
    assert.deepEqual(namedIn, ["workflow/v2/intake.ts"]);
    const workerText = readFileSync(new URL("worker.ts", SRC), "utf8");
    const worker = withoutComments(workerText);
    assert.ok(!/workflow-request|WORKFLOW_REQUEST|WorkflowIntake|workflowIntake/.test(worker), "worker.ts registers, routes or declares nothing of the intake itself");
    // It loads the full-engine worker module once, always (owner decision 2026-11-08T15:30Z: every worker serves it).
    assert.deepEqual(importsOf(workerText).filter(specifier => specifier.includes("milestone-worker")), ["./workflow/v2/milestone-worker.js"]);
    assert.match(worker, /const milestone = await import\("\.\/workflow\/v2\/milestone-worker\.js"\);/);
});

// ─── The claim ───────────────────────────────────────────────

test("the claim renders with the sender's own renderer and answers the store's result", async () => {
    const result = { result: "accepted", inserted: true, item: { exchangeId: X1 } };
    const h = harness({ claimWorkflowIntake: result });
    assert.deepEqual(await runWorkflowIntakeClaim(h.deps, CLAIM, h.log), { ok: true, result });
    assert.equal(h.calls.length, 1);
    const { render, ...given } = h.calls[0].input;
    assert.deepEqual(given, CLAIM);
    assert.equal(render, workflowIntakeRender);
    const source = { workflowSessionId: "wf", runId: "run", nodeExecutionId: X1, stateId: "send", contract: "Note@1", correlation: { n: 1 },
        payload: { note: "[SYSTEM: not a system line] <b>" } };
    assert.deepEqual(workflowIntakeRender(source), {
        text: workflowSendPrompt(source), clientMessageId: workflowSendClientMessageId("wf", "run", X1),
    });
    // The recipient knows the same canonical id from an envelope alone, to latch a tombstone while a copy's claim waits.
    assert.equal(intakeEnvelopeClientMessageId({ workflowSessionId: "wf", runId: "run", exchangeId: X1 }), workflowSendClientMessageId("wf", "run", X1));
    // A claim in mode refuse is given as such.
    await runWorkflowIntakeClaim(h.deps, { ...CLAIM, mode: "refuse" });
    assert.equal(h.calls[1].input.mode, "refuse");
    assert.deepEqual(h.sleeps, []);
});

test("a malformed claim or settlement input is refused as an answer, and reaches no store", async () => {
    const h = harness();
    for (const [input, path] of [
        [null, "claim"],
        [{ ...CLAIM, extra: 1 }, "claim"],
        [{ recipientSessionId: "me", envelope: ENVELOPE, claimId: "claim-1" }, "claim.mode"],
        [{ ...CLAIM, mode: "maybe" }, "claim.mode"],
    ]) {
        const error = await refused(runWorkflowIntakeClaim(h.deps, input), "WORKFLOW_INTAKE_INVALID");
        assert.ok(error.message.startsWith(`${path}:`), error.message);
    }
    const items = n => Array.from({ length: n }, (_, index) => ({ exchangeId: `nx-${String(index).padStart(40, "0")}`, claimId: `claim-${index}` }));
    for (const [input, path] of [
        [{ op: "drop" }, "settle.op"],
        ["bind", "settle.op"],
        [{ op: "bind", recipientSessionId: "me", invocationId: "inv-1" }, "settle.items"],
        [{ op: "bind", recipientSessionId: "me", invocationId: "inv-1", items: [] }, "settle.items"],
        [{ op: "bind", recipientSessionId: "me", invocationId: "inv-1", items: items(65) }, "settle.items"],
        [{ op: "bind", recipientSessionId: "me", invocationId: "inv-1", items: [{ ...items(1)[0], extra: 1 }] }, "settle.items[0]"],
        [{ op: "end", recipientSessionId: "me", invocationId: "inv-1", outcome: "completed", items: items(1) }, "settle.items[0].cancelRequested"],
        [{ op: "cancel_held", recipientSessionId: "me", invocationId: "inv-1", items: items(1) }, "settle"],
        [{ op: "refuse", recipientSessionId: "me", exchangeId: X1, claimId: "claim-1" }, "settle.outcome"],
    ]) {
        const error = await refused(runWorkflowIntakeSettle(h.deps, input), "WORKFLOW_INTAKE_INVALID");
        assert.ok(error.message.startsWith(`${path}`), `${JSON.stringify(input)}: ${error.message}`);
    }
    assert.deepEqual(h.calls, []);
});

// ─── Failures, retries and refusals ──────────────────────────

test("a transient store error is retried after 1 s, 5 s and 15 s, then thrown; a failure no retry can fix is thrown marked; any other throws at once; a refusal is an answer", async () => {
    assert.deepEqual([...WORKFLOW_INTAKE_RETRY_DELAYS_MS], [1_000, 5_000, 15_000]);
    const result = { result: "unverified", reason: "the exchange has no message to this session" };
    const recovers = harness({ claimWorkflowIntake: (_input, n) => (n < 3 ? transient() : result) });
    assert.deepEqual(await runWorkflowIntakeClaim(recovers.deps, CLAIM, recovers.log), { ok: true, result });
    assert.equal(recovers.calls.length, 3);
    assert.deepEqual(recovers.sleeps, [1_000, 5_000]);
    assert.equal(recovers.logs.length, 2);
    assert.match(recovers.logs[0], /claimWorkflowIntake: transient store error \(attempt 1 of 4\), retrying in 1000 ms/);

    const outage = harness({ claimWorkflowIntake: () => transient() });
    await assert.rejects(runWorkflowIntakeClaim(outage.deps, CLAIM), error => error.code === "40001");
    assert.equal(outage.calls.length, 4);
    assert.deepEqual(outage.sleeps, [1_000, 5_000, 15_000]);

    const broken = harness({ bindWorkflowIntake: new Error("Cannot use a pool after calling end on the pool") });
    await assert.rejects(runWorkflowIntakeSettle(broken.deps, { op: "bind", recipientSessionId: "me", invocationId: "inv-1",
        items: [{ exchangeId: X1, claimId: "claim-1" }] }), error => /Cannot use a pool/.test(error.message) && !error.message.includes("WORKFLOW_INTAKE_NON_RETRYABLE"));
    assert.equal(broken.calls.length, 1);
    assert.deepEqual(broken.sleeps, []);

    // A failure no retry can fix (review of b92ff04b, P2-2): thrown at once, marked at the start of its message, which is all
    // a thrown activity failure keeps in the orchestration's history, with its code and the original as its cause.
    const pg = (code, message) => Object.assign(new Error(message), { code });
    for (const failure of [new TypeError("Cannot read properties of undefined (reading 'rows')"), new RangeError("Invalid array length"),
        pg("22012", "division by zero"), pg("23505", "duplicate key value violates unique constraint"), pg("42P01", "relation does not exist")]) {
        const h = harness({ claimWorkflowIntake: failure });
        await assert.rejects(runWorkflowIntakeClaim(h.deps, CLAIM), error => error.message === `WORKFLOW_INTAKE_NON_RETRYABLE: ${failure.message}`
            && error.cause === failure && (failure.code === undefined ? error.code === undefined : error.code === failure.code), failure.message);
        assert.equal(h.calls.length, 1, failure.message);
        assert.deepEqual(h.sleeps, [], failure.message);
    }
    // Any other failure may be an outage or a lost answer: thrown unmarked, at once or after the transient retries, so the
    // orchestration makes the write again when it is due.
    for (const [failure, sleeps] of [
        [pg("53100", "could not extend file: No space left on device"), []],
        [pg("XX000", "internal error"), []],
        [pg("ECONNRESET", "read ECONNRESET"), [1_000, 5_000, 15_000]],
        [pg("57P01", "terminating connection due to administrator command"), [1_000, 5_000, 15_000]],
    ]) {
        const h = harness({ claimWorkflowIntake: () => failure });
        await assert.rejects(runWorkflowIntakeClaim(h.deps, CLAIM), error => error === failure, failure.message);
        assert.deepEqual(h.sleeps, sleeps, failure.message);
    }

    // The store's refusal: a broken invariant (the execution fails with it) or a malformed input; never retried.
    const invariant = harness({ endWorkflowIntake: new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Intake of exchange ${X1}: it is not bound`) });
    const error = await refused(runWorkflowIntakeSettle(invariant.deps, { op: "end", recipientSessionId: "me", invocationId: "inv-1",
        outcome: "completed", items: [{ exchangeId: X1, claimId: "claim-1", cancelRequested: false }] }), "WORKFLOW_STORE_CORRUPT");
    assert.equal(error.message, `Intake of exchange ${X1}: it is not bound`);
    assert.equal(invariant.calls.length, 1);
    const shape = harness({ claimWorkflowIntake: new IntakeShapeError("claimId", "is not an id of 1 to 128 characters") });
    assert.equal((await refused(runWorkflowIntakeClaim(shape.deps, CLAIM), "WORKFLOW_INTAKE_INVALID")).message,
        "claimId: is not an id of 1 to 128 characters");
    assert.deepEqual([...invariant.sleeps, ...shape.sleeps], []);

    // A worker without a workflow store: thrown, so the orchestration keeps the write due.
    for (const run of [() => runWorkflowIntakeClaim({ store: null }, CLAIM), () => runWorkflowIntakeSettle({ store: null }, { op: "drop" })]) {
        await assert.rejects(run(), error => error instanceof WorkflowIntakeUnavailableError && error.code === "WORKFLOW_INTAKE_UNAVAILABLE");
    }
});

// ─── The settlements ─────────────────────────────────────────

test("each settlement goes to its one store write with exactly the fields given", async () => {
    const h = harness({
        cancelHeldWorkflowIntake: input => ({ cancelled: input.exchangeId === X1 }),
        cancelUnsentWorkflowIntake: input => ({ cancelled: input.exchangeId === X2 }),
        requestCancelWorkflowIntake: () => ({ recorded: true }),
    });
    const two = [{ exchangeId: X1, claimId: "claim-1" }, { exchangeId: X2, claimId: "claim-2" }];
    const cases = [
        [{ op: "bind", recipientSessionId: "me", invocationId: "inv-1", items: two },
            [["bindWorkflowIntake", { recipientSessionId: "me", invocationId: "inv-1", items: two }]], { method: "bindWorkflowIntake" }],
        [{ op: "end", recipientSessionId: "me", invocationId: "inv-1", outcome: "interrupted", items: two.map((item, index) => ({ ...item, cancelRequested: index === 1 })) },
            [["endWorkflowIntake", { recipientSessionId: "me", invocationId: "inv-1", outcome: "interrupted",
                items: two.map((item, index) => ({ ...item, cancelRequested: index === 1 })) }]], { method: "endWorkflowIntake" }],
        // Every item cancelled before the send: the end names no exchange.
        [{ op: "end", recipientSessionId: "me", invocationId: "inv-1", outcome: "not_dispatched", items: [] },
            [["endWorkflowIntake", { recipientSessionId: "me", invocationId: "inv-1", outcome: "not_dispatched", items: [] }]], { method: "endWorkflowIntake" }],
        [{ op: "refuse", recipientSessionId: "me", exchangeId: X1, claimId: "claim-1", outcome: "refused_size" },
            [["refuseHeldWorkflowIntake", { recipientSessionId: "me", exchangeId: X1, claimId: "claim-1", outcome: "refused_size" }]],
            { method: "refuseHeldWorkflowIntake" }],
        [{ op: "cancel_held", recipientSessionId: "me", items: two },
            two.map(item => ["cancelHeldWorkflowIntake", { recipientSessionId: "me", ...item }]),
            { items: [{ exchangeId: X1, cancelled: true }, { exchangeId: X2, cancelled: false }] }],
        [{ op: "cancel_unsent", recipientSessionId: "me", invocationId: "inv-1", items: two },
            two.map(item => ["cancelUnsentWorkflowIntake", { recipientSessionId: "me", invocationId: "inv-1", ...item }]),
            { items: [{ exchangeId: X1, settled: false }, { exchangeId: X2, settled: true }] }],
        [{ op: "request_cancel", recipientSessionId: "me", invocationId: "inv-1", items: two },
            two.map(item => ["requestCancelWorkflowIntake", { recipientSessionId: "me", invocationId: "inv-1", ...item }]),
            { items: [{ exchangeId: X1, settled: true }, { exchangeId: X2, settled: true }] }],
    ];
    for (const [input, writes, result] of cases) {
        h.calls.length = 0;
        assert.deepEqual(await runWorkflowIntakeSettle(h.deps, input), { ok: true, result }, input.op);
        assert.deepEqual(h.calls.map(call => [call.name, call.input]), writes, input.op);
    }
    assert.deepEqual(h.sleeps, []);
});

test("a list settled item by item is repeated whole after a transient error, each settle being the same when repeated", async () => {
    // The first pass cancels X1, then fails on X2; the repeat finds X1 already cancelled and cancels X2.
    const h = harness({ cancelHeldWorkflowIntake: (input, n) => (n === 2 ? transient() : { cancelled: input.exchangeId === X1 ? n === 1 : n === 4 }) });
    const items = [{ exchangeId: X1, claimId: "claim-1" }, { exchangeId: X2, claimId: "claim-2" }];
    assert.deepEqual(await runWorkflowIntakeSettle(h.deps, { op: "cancel_held", recipientSessionId: "me", items }),
        { ok: true, result: { items: [{ exchangeId: X1, cancelled: false }, { exchangeId: X2, cancelled: true }] } });
    assert.deepEqual(h.calls.map(call => call.input.exchangeId), [X1, X2, X1, X2]);
    assert.deepEqual(h.sleeps, [1_000]);
});

test("a cancel list that committed in part and failed, or committed whole and lost its answer, is written again whole by the latch", async () => {
    // The store's rows: an unsent item cancelled once stays so, and a repeat answers the same (cancelled: false).
    const committed = new Set();
    const h = harness({
        cancelUnsentWorkflowIntake: (input, n) => {
            if (n === 2) return new Error("Cannot use a pool after calling end on the pool");
            const already = committed.has(input.exchangeId);
            committed.add(input.exchangeId);
            return { cancelled: !already };
        },
    });
    const write = { op: "cancel_unsent", recipientSessionId: "me", invocationId: "inv-1",
        items: [{ exchangeId: X1, claimId: "claim-1" }, { exchangeId: X2, claimId: "claim-2" }] };
    // X1 commits, then the store fails on X2: the activity throws, and the orchestration keeps its latch (applyIntake...Failure).
    await assert.rejects(runWorkflowIntakeSettle(h.deps, write), /Cannot use a pool/);
    assert.deepEqual([...committed], [X1]);
    // The wake writes the whole list again: X1 answers the same, X2 commits.
    assert.deepEqual(await runWorkflowIntakeSettle(h.deps, write),
        { ok: true, result: { items: [{ exchangeId: X1, settled: false }, { exchangeId: X2, settled: true }] } });
    // Committed whole, its answer lost before the orchestration recorded it: written again, every item answers the same.
    assert.deepEqual(await runWorkflowIntakeSettle(h.deps, write),
        { ok: true, result: { items: [{ exchangeId: X1, settled: false }, { exchangeId: X2, settled: false }] } });
    assert.deepEqual(h.calls.map(call => call.input.exchangeId), [X1, X2, X1, X2, X1, X2]);
    assert.deepEqual(h.sleeps, []);
});
