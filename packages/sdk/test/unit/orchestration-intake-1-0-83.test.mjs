/**
 * Orchestration 1.0.83, inactive: the durable workflow intake's carried
 * state (design docs/proposals/workflow-durable-intake.md 5.4, 5.5, 5.7 and
 * section 8, amendment 2; decision intake-inactive-implementation).
 *
 * - 1.0.83 is not registered and nothing outside its tree imports it; its
 *   tree is the frozen 1.0.82 plus the intake files.
 * - Every continue-as-new of 1.0.83 goes through versionedContinueAsNew:
 *   each call site is listed below, and nothing else calls the context's
 *   continue-as-new. Driven with a fake context, it carries the intake state
 *   whatever built the input, adds nothing when the state is empty (the
 *   input is then 1.0.82's), and refuses an older or unreadable target
 *   before any yield.
 * - createInitialState restores the state: absent is empty; a present state
 *   that does not validate fails with the field's path. The carried form is
 *   checked whole, and a carry is a copy.
 * - One item's size is measured exactly, as the JSON it is carried as; a
 *   batch is chosen from those sizes before its bind.
 *
 * Run: node --test test/unit/orchestration-intake-1-0-83.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";
import { createInitialState, deriveOptions, ownedRetryOverrides } from "../../dist/orchestration_1_0_83/state.js";
import { continueInput, continueInputWithPrompt, versionedContinueAsNew } from "../../dist/orchestration_1_0_83/lifecycle.js";
import {
    INTAKE_MAX_HELD, INTAKE_MAX_HELD_ENTRY_BYTES, INTAKE_MAX_UNCLAIMED, IntakeShapeError, assertIntakeContinueAsNewTarget, carriedIntakeBytes,
    carryIntakeState, intakeHeldEntryCapBytes, restoreIntakeState, selectIntakeBatch,
} from "../../dist/orchestration_1_0_83/intake-state.js";
import {
    INTAKE_MAX_INVOCATION_ITEMS_BYTES, INTAKE_MAX_TEXT_BYTES, intakeBoundItem, intakeItemBytes, intakeItemFitsAlone, intakeItemsBytes,
    intakeTextWithinCap,
} from "../../dist/workflow/v2/intake.js";
import { createInitialState as createInitialState82, deriveOptions as deriveOptions82 } from "../../dist/orchestration_1_0_82/state.js";
import { continueInput as continueInput82, versionedContinueAsNew as versionedContinueAsNew82 } from "../../dist/orchestration_1_0_82/lifecycle.js";

const SRC = new URL("../../src/", import.meta.url);
const read = name => readFileSync(new URL(name, SRC), "utf8").replace(/\r\n/g, "\n");
const tsFiles = dir => readdirSync(new URL(`${dir}/`, SRC)).filter(name => name.endsWith(".ts")).sort();

function allSourceFiles(dir = "") {
    const out = [];
    for (const name of readdirSync(new URL(dir || ".", SRC))) {
        const path = dir ? `${dir}/${name}` : name;
        if (statSync(new URL(path, SRC)).isDirectory()) out.push(...allSourceFiles(path));
        else if (name.endsWith(".ts")) out.push(path);
    }
    return out;
}

function importsOf(text) {
    return [...text.matchAll(/^(?:import|export)\b[^\n]*?\sfrom\s+"([^"]+)"|^\}\s+from\s+"([^"]+)"|\bimport\("([^"]+)"\)/gm)]
        .map(match => match[1] ?? match[2] ?? match[3]);
}

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
const bytes = value => Buffer.byteLength(JSON.stringify(value), "utf8");

// ─── Fixtures ────────────────────────────────────────────────

const WF = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const exchange = n => `nx-${sha256(`exchange-${n}`).slice(0, 40)}`;

function ref(n, text) {
    return { exchangeId: exchange(n), claimId: `claim-${n}`, textSha256: sha256(text), clientMessageId: `workflow:${WF}:${RUN}:send:${exchange(n)}` };
}

function held(n, text, cancel = false) {
    const r = ref(n, text);
    return { kind: "held", ...r, itemBytes: intakeItemBytes(intakeBoundItem(r, text)), cancel };
}

function envelope(n) {
    return {
        v: 1, exchangeId: exchange(n), workflowSessionId: WF, runId: RUN, recipientSessionId: "33333333-3333-4333-8333-333333333333",
        contract: "Note@1", payloadSha256: sha256(`payload-${n}`), envelopeSha256: sha256(`envelope-${n}`),
    };
}

function unclaimed(n, cancel = false) {
    return { kind: "unclaimed", claimId: `claim-u${n}`, envelope: envelope(n), retry: { attempts: 1, nextAttemptAtMs: 1_000 }, cancel };
}

/** A holder's decided settle, latched (design 5.2, 5.4; review INTAKE-MACHINE-01). */
function settling(n, { outcome = "cancelled", retry = null } = {}) {
    return { kind: "settling", exchangeId: exchange(n), claimId: `claim-s${n}`, outcome, retry };
}

/** A bound invocation of the given texts (exchanges numbered from `first`). */
function boundInvocation(texts, { first = 100, sent = false, parked = null, settle = null, cancelWrite = null } = {}) {
    const items = texts.map((text, index) => ({ ...ref(first + index, text), text, cancelRequested: false }));
    return {
        invocationId: "inv-1", items, itemBytes: texts.map((text, index) => intakeItemBytes(intakeBoundItem(ref(first + index, text), text))),
        bound: true, sent, parked, bindRetry: null, settle, cancelWrite,
    };
}

/** The same with its first item's cancel latched. */
function latchedFirst(invocation) {
    return { ...invocation, items: invocation.items.map((item, index) => (index === 0 ? { ...item, cancelRequested: true } : item)) };
}

function unboundInvocation(texts, first = 100) {
    const bound = boundInvocation(texts, { first });
    return { ...bound, items: bound.items.map(item => ({ ...item, text: null })), bound: false, bindRetry: { attempts: 1, nextAttemptAtMs: 5_000 } };
}

const TEXT_A = "[SYSTEM: A workflow sent you a typed message.]\n{\"note\":\"ship it\"}";
const TEXT_B = "[SYSTEM: A workflow sent you a typed message.]\n{\"note\":\"héllo 日本 😀 \\\"quoted\\\"\"}";

function carried({ queue = [], invocation = null, heldCancelRetry = null } = {}) {
    return { v: 1, queue, invocation, heldCancelRetry };
}

/** The restored state a carried form stands for. */
const stateOf = carriedForm => ({ queue: carriedForm.queue, invocation: carriedForm.invocation, heldCancelRetry: carriedForm.heldCancelRetry });

const VALID = carried({ queue: [unclaimed(1), held(2, TEXT_A)], invocation: boundInvocation([TEXT_B], { sent: true }) });

// ─── Inactive ────────────────────────────────────────────────

test("1.0.83 is not registered, and nothing outside its tree imports it", () => {
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.filter(entry => entry.version === "1.0.83").length, 0);
    for (const path of allSourceFiles()) {
        if (path.startsWith("orchestration_1_0_83/")) continue;
        for (const specifier of importsOf(read(path))) {
            assert.ok(!specifier.includes("orchestration_1_0_83"), `${path} imports ${specifier}`);
        }
    }
    assert.match(read("orchestration_1_0_83/runtime.ts"), /^export const CURRENT_ORCHESTRATION_VERSION = "1\.0\.83";$/m);
    assert.match(read("orchestration_1_0_83/index.ts"), /export function\* durableSessionOrchestration_1_0_83\(/);
});

/** The lines `a` has that `b` has not, counted (a multiset difference), in `a`'s order. */
function linesOnly(a, b) {
    const counts = new Map();
    for (const line of b.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
    const out = [];
    for (const line of a.split("\n")) {
        const left = counts.get(line) ?? 0;
        if (left > 0) counts.set(line, left - 1);
        else out.push(line);
    }
    return out;
}

/** The lines of the frozen 1.0.82 queue.ts that 1.0.83 changes: one, so that a due intake write is raced, never blocked on. */
const QUEUE_CHANGED_82 = [
    "        !hasFifoItems(runtime)",
];

/**
 * The lines 1.0.83 adds to queue.ts that neither name the intake or the owed
 * retry nor are a comment or structure: the changed line above, the parts of
 * intakeDeadlineFirst and of drain's intake race that reuse 1.0.82's own
 * expressions, decide's return after the intake's own turn, and, for the owed
 * retry (ordinary retry ownership, review Q-W2-7), decide's dispatch, which
 * reuses 1.0.82's processPrompt call shape, and the armed agent-poll timer
 * that drain queues as a fired poll after it.
 */
const QUEUE_ADDED_GENERIC = [
    "        !hasFifoItems(runtime) &&",
    "    const { state } = runtime;",
    "    if (dueAtMs === null) return false;",
    "    const other = nextTimerCandidate(state.activeTimer, state.pendingChildDigest, dueAtMs, {",
    "        batchMs: childUpdateBatchMs(state.subAgents?.length ?? 0),",
    "        digestHasError: pendingChildDigestHasError(runtime),",
    "    });",
    "    return other === null || other.remainingMs > 0;",
    "            const now: number = yield ctx.utcNow();",
    "        return true;",
    "        yield* processPrompt(",
    "            runtime,",
    "        );",
    "    runtime.state.activeTimer = null;",
];

/**
 * The lines of the frozen 1.0.82 turn.ts that 1.0.83 changes: its turns run
 * under the workflow-intake contract, a hydration give-up is noted to the
 * intake, the thrown-turn key is reused only by the attempt the intake asks
 * about (intakeReusesThrownTurnKey), and a failed turn's retry continues as
 * new owed apart from the pending prompt (ordinary retry ownership, review
 * Q-W2-7: state.ts ownedRetryOverrides).
 */
const TURN_CHANGED_82 = [
    '                runtime.session = createSessionProxy(ctx, runtime.input.sessionId, state.affinityKey, state.config, "turn-control-v1");',
    "        if (state.needsHydration) return;",
    "        const reusedTurnKey = state.blobEnabled && state.retryCount > 0 && state.thrownTurnKey",
    '    runtime.session = createSessionProxy(ctx, runtime.input.sessionId, state.affinityKey, state.config, "turn-control-v1");',
    "        yield* versionedContinueAsNew(runtime, continueInput(runtime, retryContinueOverrides(state, rc)));",
    "            ...retryContinueOverrides(state, rc),",
    "    yield* versionedContinueAsNew(runtime, continueInput(runtime, retryContinueOverrides(state, rc)));",
];

/**
 * Lines the file `name` of 1.0.83 adds that neither name the intake or the
 * owed retry (ownedRetry, review Q-W2-7) nor are a comment or structure must
 * be listed in `generic`.
 */
function assertIntakeOnlyAdditions(name, added, generic = []) {
    for (const line of added) {
        assert.ok(/intake|Intake|ownedRetry|OwnedRetry/.test(line) || /^\s*(\}|continue;|\/\/.*|\/\*\*|\*\/|\*( .*)?)?\s*$/.test(line) || generic.includes(line), `${name}: ${line}`);
    }
}

test("1.0.83 is the frozen 1.0.82 plus the intake: the files it does not change are the frozen ones", () => {
    assert.deepEqual(tsFiles("orchestration_1_0_83"), [...tsFiles("orchestration_1_0_82"), "intake-machine.ts", "intake-state.ts", "intake-wiring.ts"].sort());
    for (const name of ["agents.ts", "utils.ts"]) {
        assert.equal(read(`orchestration_1_0_83/${name}`), read(`orchestration_1_0_82/${name}`), name);
    }
    // Every 1.0.83 turn runs under the workflow-intake contract (design section 8): no 1.0.83 file names the turn-control one.
    for (const name of tsFiles("orchestration_1_0_83")) {
        assert.ok(!read(`orchestration_1_0_83/${name}`).includes('"turn-control-v1"'), `${name} names the turn-control contract`);
    }
    // runtime.ts: its version, the workflow-intake contract, and no continue-as-new while an intake write is due (drain races it).
    assert.equal(read("orchestration_1_0_83/runtime.ts"), read("orchestration_1_0_82/runtime.ts")
        .replace('export const CURRENT_ORCHESTRATION_VERSION = "1.0.82";', 'export const CURRENT_ORCHESTRATION_VERSION = "1.0.83";')
        .replaceAll('"turn-control-v1"', '"workflow-intake-v1"')
        .replace('import { decide, drain, settleQueuedWorkAfterDecide, turnsStarted } from "./queue.js";\n',
            'import { decide, drain, settleQueuedWorkAfterDecide, turnsStarted } from "./queue.js";\nimport { intakeDueAtMs } from "./intake-machine.js";\n')
        .replace("        if (state.activeTimer) continue;        // drain will race the timer next iteration\n",
            "        if (state.activeTimer) continue;        // drain will race the timer next iteration\n"
            + "        if (intakeDueAtMs(state.intake) !== null) continue; // 1.0.83: drain will race the intake's due write\n"));
    // queue.ts: only the intake's hooks (arrival in drain and the sweep, the tombstone latch first in both, the intake
    // deadline's own race and its wake, each turn's stimulus and decide's turn for the intake alone) and the owed retry's
    // (drain's sweep while it is owed, its timer release and decide's dispatch of it first; review Q-W2-7). The one
    // frozen line it changes is listed; every line it adds names the intake or the owed retry, is a comment or
    // structure, or is one of the listed reuses of 1.0.82's own expressions.
    const queue82 = read("orchestration_1_0_82/queue.ts");
    const queue83 = read("orchestration_1_0_83/queue.ts");
    assert.deepEqual(linesOnly(queue82, queue83).sort(), [...QUEUE_CHANGED_82].sort());
    assertIntakeOnlyAdditions("queue.ts", linesOnly(queue83, queue82), QUEUE_ADDED_GENERIC);
    // turn.ts: only the intake's hooks (each attempt's carry, its dispatch and outcome, each timer turn's stimulus), the
    // owed retry of a failed turn and the listed frozen lines; every line it adds names the intake or the owed retry or
    // is a comment or structure.
    const turn82 = read("orchestration_1_0_82/turn.ts");
    const turn83 = read("orchestration_1_0_83/turn.ts");
    assert.deepEqual(linesOnly(turn82, turn83).sort(), [...TURN_CHANGED_82].sort());
    assertIntakeOnlyAdditions("turn.ts", linesOnly(turn83, turn82));
    // Its new imports are the intake modules and the capability routing only (and node:crypto for the text hash).
    const frozen = new Set(tsFiles("orchestration_1_0_82").flatMap(name => importsOf(read(`orchestration_1_0_82/${name}`))));
    const added = new Set(tsFiles("orchestration_1_0_83").flatMap(name => importsOf(read(`orchestration_1_0_83/${name}`))).filter(s => !frozen.has(s)));
    assert.deepEqual([...added].sort(), [
        "../activity-routing.js", "../workflow/v2/intake.js", "./intake-machine.js", "./intake-state.js", "./intake-wiring.js", "node:crypto",
    ]);
});

// ─── Every continue-as-new goes through versionedContinueAsNew ──

/** Each call of versionedContinueAsNew in 1.0.83, by file, in source order: the input it is given. */
const CAN_CALL_SITES = {
    "lifecycle.ts": ["continueInputWithPrompt(runtime, `Continue on ${newModelLabel}.`, {", "canInput);"],
    "runtime.ts": ["continueInput(runtime));", "continueInput(runtime));", "continueInput(runtime));"],
    "turn.ts": [
        "continueInput(runtime, ownedRetryOverrides(retryContinueOverrides(state, rc))));",
        "continueInput(runtime, {",
        "continueInput(runtime, ownedRetryOverrides(retryContinueOverrides(state, rc))));",
        "continueInputWithPrompt(runtime, result.forceContinuePrompt, {",
    ],
};

test("every continue-as-new of 1.0.83 goes through versionedContinueAsNew, which carries the intake before any yield", () => {
    for (const name of tsFiles("orchestration_1_0_83")) {
        const text = read(`orchestration_1_0_83/${name}`);
        const calls = [...text.matchAll(/yield\* versionedContinueAsNew\(runtime, ([^\n]*)/g)].map(match => match[1]);
        assert.deepEqual(calls, CAN_CALL_SITES[name] ?? [], `${name}: its continue-as-new call sites`);
        // Called any other way (without yield*, or with another runtime) it would not be listed above.
        const mentions = (text.match(/versionedContinueAsNew\(/g) ?? []).length;
        assert.equal(mentions, calls.length + (name === "lifecycle.ts" ? 1 : 0), `${name}: every mention is a listed call or the definition`);
    }
    // The context's continue-as-new is called in one place: inside versionedContinueAsNew.
    const lifecycle = read("orchestration_1_0_83/lifecycle.ts");
    const start = lifecycle.indexOf("export function* versionedContinueAsNew(");
    const end = lifecycle.indexOf("\n}\n", start);
    const body = lifecycle.slice(start, end);
    for (const name of tsFiles("orchestration_1_0_83")) {
        const text = read(`orchestration_1_0_83/${name}`);
        const direct = (text.match(/\.continueAsNew/g) ?? []).length;
        assert.equal(direct, name === "lifecycle.ts" ? 1 : 0, `${name}: direct continue-as-new calls`);
    }
    assert.equal((body.match(/\.continueAsNewVersioned\(canInput, runtime\.versions\.latestVersion\)/g) ?? []).length, 1);
    // The floor and the carry come before the first yield.
    const firstYield = body.indexOf("yield");
    assert.ok(body.indexOf("assertIntakeContinueAsNewTarget(runtime.versions.currentVersion, runtime.versions.latestVersion)") > 0);
    assert.ok(body.indexOf("assertIntakeContinueAsNewTarget(") < firstYield);
    assert.ok(body.indexOf("carryIntakeState(state.intake)") > 0 && body.indexOf("carryIntakeState(state.intake)") < firstYield);
});

/** A runtime of 1.0.83 (or of the frozen 1.0.82) with a fake context that records the continue-as-new it is asked for. */
function runtimeFor(input, { latestVersion = "1.0.83", frozen = false } = {}) {
    const ctx = {
        continueAsNewVersioned: (canInput, version) => ({ op: "continueAsNew", canInput, version }),
        utcNow: () => ({ op: "utcNow" }),
        traceInfo: () => {},
    };
    const options = (frozen ? deriveOptions82 : deriveOptions)(input);
    const state = (frozen ? createInitialState82 : createInitialState)(input, options);
    return { ctx, input, options, state, versions: { currentVersion: frozen ? "1.0.82" : "1.0.83", latestVersion } };
}

function continuedAsNew(runtime, canInput, can = versionedContinueAsNew) {
    const step = can(runtime, canInput).next();
    assert.equal(step.done, false);
    assert.equal(step.value.op, "continueAsNew");
    return step.value;
}

const INPUT = { sessionId: "44444444-4444-4444-8444-444444444444", config: { model: "m" }, iteration: 3 };
/** An owed retry (ordinary retry ownership, review Q-W2-7): a failed turn's whole prompt contract, its count and key. */
const OWNED = {
    prompt: "the failed turn's prompt", bootstrap: false, requiredTool: "report", cycleOrigin: null, clientMessageIds: ["cm-p"],
    sender: { kind: "user", display: "Ann" }, attachments: [{ filename: "p.png", contentType: "image/png", sizeBytes: 10 }],
    retryCount: 1, thrownTurnKey: null, fresh: false,
};
/**
 * VALID's sent invocation awaits its turn's retry, so an input that carries it carries the retry marker (review
 * D-W2-1) and the owed retry that takes it (review Q-W2-7).
 */
const RETRY = { intakeRetryInvocationId: "inv-1", ownedRetry: OWNED };

test("versionedContinueAsNew carries the intake state whatever built the input, and adds nothing when it is empty", () => {
    const withIntake = runtimeFor({ ...INPUT, intake: VALID, ...RETRY });
    assert.deepEqual(withIntake.state.intake, stateOf(VALID));
    assert.equal(withIntake.state.intakeRetryInvocationId, "inv-1");
    for (const build of [
        runtime => continueInput(runtime),
        runtime => continueInputWithPrompt(runtime, "Continue on another model.", { requiredTool: "x" }),
        // The regeneration path spreads a built input into its own.
        runtime => ({ ...continueInputWithPrompt(runtime, "", { bootstrapPrompt: true }), transcriptEpoch: 2 }),
    ]) {
        const can = continuedAsNew(withIntake, build(withIntake));
        assert.deepEqual(can.canInput.intake, VALID);
        // The retry marker rides every continue-as-new with the owed retry, apart from the pending prompt (review Q-W2-7).
        assert.equal(can.canInput.intakeRetryInvocationId, "inv-1");
        assert.deepEqual(can.canInput.ownedRetry, OWNED);
        assert.notEqual(can.canInput.prompt, OWNED.prompt);
        assert.equal(Object.hasOwn(can.canInput, "intakeArrivalPending"), false);
        assert.equal(can.version, "1.0.83");
        assert.equal(can.canInput.sourceOrchestrationVersion, "1.0.83");
        // The carried form is a copy: changing it changes nothing in the state.
        can.canInput.intake.queue.length = 0;
        assert.equal(withIntake.state.intake.queue.length, 2);
        can.canInput.ownedRetry.clientMessageIds.length = 0;
        assert.deepEqual(withIntake.state.ownedRetry.clientMessageIds, ["cm-p"]);
    }
    // The carried form restores to the same state in the next execution.
    const next = runtimeFor(continuedAsNew(withIntake, continueInput(withIntake)).canInput);
    assert.deepEqual(next.state.intake, withIntake.state.intake);
    assert.equal(next.state.intakeRetryInvocationId, "inv-1");
    assert.deepEqual(next.state.ownedRetry, OWNED);
    assert.equal(next.state.pendingPrompt, undefined);

    // Empty: no intake field, and the input is the one 1.0.82 builds, but for the version that wrote it.
    const empty = runtimeFor(INPUT);
    const frozen = runtimeFor(INPUT, { latestVersion: "1.0.82", frozen: true });
    const ours = continuedAsNew(empty, continueInput(empty)).canInput;
    const theirs = continuedAsNew(frozen, continueInput82(frozen), versionedContinueAsNew82).canInput;
    assert.equal(Object.hasOwn(ours, "intake"), false);
    assert.equal(Object.hasOwn(ours, "intakeRetryInvocationId"), false);
    assert.equal(Object.hasOwn(ours, "ownedRetry"), false);
    assert.equal(Object.hasOwn(ours, "intakeArrivalPending"), false);
    assert.deepEqual({ ...ours, sourceOrchestrationVersion: "1.0.82" }, theirs);
    // Stale intake fields on a built input are not carried for an empty state.
    const stale = continuedAsNew(empty, {
        ...continueInput(empty), intake: VALID, intakeRetryInvocationId: "inv-1", intakeArrivalPending: true,
    }).canInput;
    assert.equal(Object.hasOwn(stale, "intake"), false);
    assert.equal(Object.hasOwn(stale, "intakeRetryInvocationId"), false);
    assert.equal(Object.hasOwn(stale, "ownedRetry"), false);
    assert.equal(Object.hasOwn(stale, "intakeArrivalPending"), false);
});

test("review Q-W2-7: a failed turn's retry continues as new owed apart from the pending prompt, and every later continue-as-new carries both; review O-W2-5: an unanswered arrival's flag rides", () => {
    // A follow-up U is pending with its own fields when turn P fails and retries.
    const U = {
        prompt: "U: a child's summary", clientMessageIds: ["cm-u"], sender: { kind: "agent", display: "child" },
        attachments: [{ filename: "u.png", contentType: "image/png", sizeBytes: 20 }], requiredTool: "other", cycleOrigin: "cron",
        bootstrapPrompt: true,
    };
    const failing = runtimeFor({ ...INPUT, ...U });
    failing.state.retryCount = 2;
    // What 1.0.82 gives P's retry (turn.ts retryContinueOverrides): P's prompt and envelope, its count and the thrown key.
    const retry = {
        prompt: OWNED.prompt, requiredTool: OWNED.requiredTool, clientMessageIds: OWNED.clientMessageIds, sender: OWNED.sender,
        attachments: OWNED.attachments, retryCount: 2, needsHydration: true, thrownTurnKey: "key-T",
    };
    const owed = { ...OWNED, retryCount: 2, thrownTurnKey: "key-T" };
    const can = continuedAsNew(failing, continueInput(failing, ownedRetryOverrides(retry))).canInput;
    // U keeps the top-level prompt and every one of its own fields; P is owed whole, and nothing of either leaks.
    assert.equal(can.prompt, U.prompt);
    assert.deepEqual(can.clientMessageIds, U.clientMessageIds);
    assert.deepEqual(can.sender, U.sender);
    assert.deepEqual(can.attachments, U.attachments);
    assert.equal(can.requiredTool, U.requiredTool);
    assert.equal(can.cycleOrigin, U.cycleOrigin);
    assert.equal(can.bootstrapPrompt, true);
    assert.deepEqual(can.ownedRetry, owed);
    assert.equal(can.needsHydration, true);
    assert.equal(Object.hasOwn(can, "thrownTurnKey"), false);
    // The next execution restores both apart: U pending with its fields, P owed; no attempt holds a key before P's dispatch.
    const held = runtimeFor(can);
    assert.equal(held.state.pendingPrompt, U.prompt);
    assert.deepEqual(held.state.pendingClientMessageIds, U.clientMessageIds);
    assert.deepEqual(held.state.pendingSender, U.sender);
    assert.deepEqual(held.state.pendingAttachments, U.attachments);
    assert.equal(held.state.pendingRequiredTool, U.requiredTool);
    assert.equal(held.state.pendingCycleOrigin, U.cycleOrigin);
    assert.equal(held.state.bootstrapPrompt, true);
    assert.deepEqual(held.state.ownedRetry, owed);
    assert.equal(held.state.thrownTurnKey, null);
    // A later continue-as-new that merges new text (set_model's) merges it into U and carries P unchanged.
    const later = continuedAsNew(held, continueInputWithPrompt(held, "Continue on another model.")).canInput;
    assert.equal(later.prompt, `${U.prompt}\n\nContinue on another model.`);
    assert.deepEqual(later.clientMessageIds, U.clientMessageIds);
    assert.deepEqual(later.ownedRetry, owed);
    // A lossy handoff's retry is fresh: count 0 and no key, so it never adopts a saved turn.
    assert.deepEqual(ownedRetryOverrides(retry, true).ownedRetry, { ...OWNED, retryCount: 0, thrownTurnKey: null, fresh: true });
    // Never two owed retries, and never the marker without one: both are broken invariants and fail the execution.
    const invariant = error => error?.name === "IntakeInvariantError";
    assert.throws(() => versionedContinueAsNew(held, continueInput(held, ownedRetryOverrides(retry))).next(), invariant);
    const orphan = runtimeFor({ ...INPUT, intake: VALID, ...RETRY });
    orphan.state.ownedRetry = null;
    assert.throws(() => versionedContinueAsNew(orphan, continueInput(orphan)).next(), invariant);
    // An empty retry prompt is no retry: it fails at once.
    assert.throws(() => ownedRetryOverrides({ ...retry, prompt: "" }), error => error instanceof IntakeShapeError && error.path === "$.ownedRetry.prompt");
    // The arrival flag rides while set, and restores.
    const arrived = runtimeFor({ ...INPUT, intakeArrivalPending: true });
    assert.equal(arrived.state.intakeArrivalPending, true);
    assert.equal(continuedAsNew(arrived, continueInput(arrived)).canInput.intakeArrivalPending, true);
    arrived.state.intakeArrivalPending = false;
    assert.equal(Object.hasOwn(continuedAsNew(arrived, continueInput(arrived)).canInput, "intakeArrivalPending"), false);
});

test("1.0.83 never continues as new to an older or unreadable version, and stops before any yield", () => {
    for (const latestVersion of ["1.0.82", "1.0.9", "0.9.99", "x", "1.0", "1.0.83.1"]) {
        const runtime = runtimeFor({ ...INPUT, intake: VALID, ...RETRY }, { latestVersion });
        let asked = 0;
        runtime.ctx.continueAsNewVersioned = () => { asked += 1; return { op: "continueAsNew" }; };
        assert.throws(() => versionedContinueAsNew(runtime, continueInput(runtime)).next(), /does not continue as new/, latestVersion);
        assert.equal(asked, 0, latestVersion);
    }
    for (const latestVersion of ["1.0.83", "1.0.84", "1.1.0", "2.0.0"]) {
        assert.equal(continuedAsNew(runtimeFor(INPUT, { latestVersion }), continueInput(runtimeFor(INPUT, { latestVersion }))).version, latestVersion);
    }
    assert.doesNotThrow(() => assertIntakeContinueAsNewTarget("1.0.83", "1.0.100"));
    assert.throws(() => assertIntakeContinueAsNewTarget("1.0.83", "1.0.82"));
});

// ─── Restore: absent is empty, invalid fails with its path ──

test("createInitialState restores the intake state: absent is empty, a valid one is kept, an invalid one fails with its path", () => {
    assert.deepEqual(createInitialState(INPUT, deriveOptions(INPUT)).intake, { queue: [], invocation: null, heldCancelRetry: null });
    assert.deepEqual(createInitialState({ ...INPUT, intake: VALID, ...RETRY }, deriveOptions(INPUT)).intake, stateOf(VALID));
    assert.throws(() => createInitialState({ ...INPUT, intake: { ...VALID, v: 2 }, ...RETRY }, deriveOptions(INPUT)),
        error => error instanceof IntakeShapeError && error.path === "$.intake.v");
    assert.throws(() => createInitialState({ ...INPUT, intake: null }, deriveOptions(INPUT)),
        error => error instanceof IntakeShapeError && error.path === "$.intake");
});

test("the pending prompt's retry marker is restored exactly while a sent invocation awaits its turn's retry, and names it (review D-W2-1)", () => {
    const restore = input => createInitialState({ ...INPUT, ...input }, deriveOptions(INPUT));
    const failsAtMarker = error => error instanceof IntakeShapeError && error.path === "$.intakeRetryInvocationId";
    assert.equal(restore({ intake: VALID, ...RETRY }).intakeRetryInvocationId, "inv-1");
    assert.equal(restore({}).intakeRetryInvocationId, null);
    // A sent invocation that awaits its retry with no marker: its retry would never run, and nothing would end it.
    assert.throws(() => restore({ intake: VALID }), failsAtMarker);
    // A marker with no such invocation, for another one, or that is not an id.
    assert.throws(() => restore({ ...RETRY }), failsAtMarker);
    assert.throws(() => restore({ intake: VALID, intakeRetryInvocationId: "inv-2" }), failsAtMarker);
    for (const raw of ["", 5, null]) assert.throws(() => restore({ intake: VALID, intakeRetryInvocationId: raw }), failsAtMarker, String(raw));
    // An unsent invocation, and a sent one whose end is decided, await no retry: no marker, and none is accepted.
    const unsent = carried({ invocation: boundInvocation([TEXT_B]) });
    const ending = carried({ invocation: boundInvocation([TEXT_B], { sent: true, settle: { outcome: "interrupted", retry: null } }) });
    for (const intake of [unsent, ending]) {
        assert.equal(restore({ intake }).intakeRetryInvocationId, null);
        assert.throws(() => restore({ intake, ...RETRY }), failsAtMarker);
    }
});

test("the owed retry is restored whole, and the marker requires it; a 1.0.82 thrown turn's retry input is owed; the arrival flag is true or absent (reviews Q-W2-7, O-W2-5)", () => {
    const restore = input => createInitialState({ ...INPUT, ...input }, deriveOptions(INPUT));
    const failsAt = path => error => error instanceof IntakeShapeError && error.path === path;
    assert.deepEqual(restore({ intake: VALID, ...RETRY }).ownedRetry, OWNED);
    assert.equal(restore({}).ownedRetry, null);
    // An owed retry needs no marker (a turn that carried no sent invocation), and is never a pending prompt.
    const owedOnly = restore({ ownedRetry: OWNED, prompt: "U", sourceOrchestrationVersion: "1.0.83" });
    assert.deepEqual(owedOnly.ownedRetry, OWNED);
    assert.equal(owedOnly.pendingPrompt, "U");
    assert.equal(owedOnly.thrownTurnKey, null);
    // The marker without an owed retry: nothing would take it.
    assert.throws(() => restore({ intake: VALID, intakeRetryInvocationId: "inv-1" }), failsAt("$.ownedRetry"));
    const { bootstrap: _bootstrap, ...noBootstrap } = OWNED;
    for (const [raw, path] of [
        [null, "$.ownedRetry"],
        [[], "$.ownedRetry"],
        [{ ...OWNED, extra: 1 }, "$.ownedRetry"],
        [noBootstrap, "$.ownedRetry.bootstrap"],
        [{ ...OWNED, prompt: "" }, "$.ownedRetry.prompt"],
        [{ ...OWNED, bootstrap: "yes" }, "$.ownedRetry.bootstrap"],
        [{ ...OWNED, requiredTool: "" }, "$.ownedRetry.requiredTool"],
        [{ ...OWNED, cycleOrigin: "daily" }, "$.ownedRetry.cycleOrigin"],
        [{ ...OWNED, clientMessageIds: ["cm-p", ""] }, "$.ownedRetry.clientMessageIds"],
        [{ ...OWNED, sender: { kind: "robot" } }, "$.ownedRetry.sender"],
        [{ ...OWNED, attachments: [{ filename: "", contentType: "image/png", sizeBytes: 1 }] }, "$.ownedRetry.attachments"],
        [{ ...OWNED, retryCount: -1 }, "$.ownedRetry.retryCount"],
        [{ ...OWNED, retryCount: 1.5 }, "$.ownedRetry.retryCount"],
        [{ ...OWNED, thrownTurnKey: "" }, "$.ownedRetry.thrownTurnKey"],
        // A fresh retry (a lossy handoff's) has count 0 and no key.
        [{ ...OWNED, fresh: true }, "$.ownedRetry.fresh"],
        [{ ...OWNED, retryCount: 0, thrownTurnKey: "key-T", fresh: true }, "$.ownedRetry.fresh"],
    ]) {
        assert.throws(() => restore({ intake: VALID, ...RETRY, ownedRetry: raw }), failsAt(path), JSON.stringify(raw));
    }
    // A 1.0.82 thrown turn's retry continues as new with its prompt as the input's: it is owed, with its key, and not pending.
    const legacy = {
        prompt: "P", requiredTool: "report", clientMessageIds: ["cm-p"], sender: OWNED.sender, attachments: OWNED.attachments,
        retryCount: 2, thrownTurnKey: "key-T", sourceOrchestrationVersion: "1.0.82",
    };
    const converted = restore(legacy);
    assert.deepEqual(converted.ownedRetry, { ...OWNED, prompt: "P", retryCount: 2, thrownTurnKey: "key-T" });
    assert.equal(converted.pendingPrompt, undefined);
    assert.deepEqual(converted.pendingAttachments, []);
    assert.equal(converted.pendingClientMessageIds, undefined);
    assert.equal(converted.pendingSender, undefined);
    assert.equal(converted.pendingRequiredTool, undefined);
    assert.equal(converted.thrownTurnKey, null);
    // Any other such input keeps its prompt pending, as 1.0.82 does: a returned error's retry (no key), a lossy handoff's
    // (count 0), and every input 1.0.83 writes, whose owed retry is only ever `ownedRetry`.
    for (const input of [
        { ...legacy, thrownTurnKey: undefined },
        { ...legacy, retryCount: 0 },
        { ...legacy, sourceOrchestrationVersion: "1.0.83" },
    ]) {
        const kept = restore(input);
        assert.equal(kept.ownedRetry, null, JSON.stringify(input));
        assert.equal(kept.pendingPrompt, "P");
        assert.equal(kept.thrownTurnKey, null);
    }
    // The arrival flag: absent is false; only true is accepted.
    assert.equal(restore({}).intakeArrivalPending, false);
    assert.equal(restore({ intakeArrivalPending: true }).intakeArrivalPending, true);
    for (const raw of [false, 1, "true", null]) {
        assert.throws(() => restore({ intakeArrivalPending: raw }), failsAt("$.intakeArrivalPending"), String(raw));
    }
});

/** [name, a change to a valid carried state, the path the failure names] */
const INVALID = [
    ["null", () => null, "$.intake"],
    ["a list", () => [], "$.intake"],
    ["another format", s => ({ ...s, v: 2 }), "$.intake.v"],
    ["an unknown field", s => ({ ...s, extra: 1 }), "$.intake"],
    ["a missing invocation field", s => ({ v: 1, queue: s.queue }), "$.intake.invocation"],
    ["carried but empty", () => carried(), "$.intake"],
    ["a queue that is not a list", s => ({ ...s, queue: {} }), "$.intake.queue"],
    ["an entry of another kind", s => ({ ...s, queue: [{ ...s.queue[1], kind: "fifo" }] }), "$.intake.queue[0].kind"],
    ["an envelope with another version", s => ({ ...s, queue: [{ ...s.queue[0], envelope: { ...s.queue[0].envelope, v: 2 } }] }), "$.intake.queue[0].envelope.v"],
    ["an envelope without its hash", s => ({ ...s, queue: [{ ...s.queue[0], envelope: { ...s.queue[0].envelope, envelopeSha256: undefined } }] }),
        "$.intake.queue[0].envelope.envelopeSha256"],
    ["an envelope with a bad exchange id", s => ({ ...s, queue: [{ ...s.queue[0], envelope: { ...s.queue[0].envelope, exchangeId: "nx-1" } }] }),
        "$.intake.queue[0].envelope.exchangeId"],
    ["a retry of no attempt", s => ({ ...s, queue: [{ ...s.queue[0], retry: { attempts: 0, nextAttemptAtMs: 1 } }] }), "$.intake.queue[0].retry.attempts"],
    ["a negative due time", s => ({ ...s, queue: [{ ...s.queue[0], retry: { attempts: 1, nextAttemptAtMs: -1 } }] }), "$.intake.queue[0].retry.nextAttemptAtMs"],
    ["a held size of zero", s => ({ ...s, queue: [{ ...s.queue[1], itemBytes: 0 }] }), "$.intake.queue[0].itemBytes"],
    ["a held size no invocation holds", s => ({ ...s, queue: [{ ...s.queue[1], itemBytes: INTAKE_MAX_INVOCATION_ITEMS_BYTES - 1 }] }),
        "$.intake.queue[0].itemBytes"],
    ["a held hash that is not one", s => ({ ...s, queue: [{ ...s.queue[1], textSha256: "ABC" }] }), "$.intake.queue[0].textSha256"],
    ["a held entry over 512 bytes", s => ({ ...s, queue: [{ ...s.queue[1], clientMessageId: "c".repeat(450) }] }), "$.intake.queue[0]"],
    ["a client message id over 512 characters", s => ({ ...s, queue: [{ ...s.queue[1], clientMessageId: "c".repeat(513) }] }),
        "$.intake.queue[0].clientMessageId"],
    ["a claim id used twice", s => ({ ...s, queue: [s.queue[1], { ...held(3, TEXT_A), claimId: s.queue[1].claimId }] }), "$.intake.queue[1].claimId"],
    ["an exchange placed twice", s => ({ ...s, queue: [s.queue[1], { ...held(2, TEXT_A), claimId: "claim-x" }] }), "$.intake.queue[1].exchangeId"],
    ["an exchange held and in the invocation", s => ({ ...s, queue: [{ ...held(100, TEXT_B), claimId: "claim-y" }] }), "$.intake.queue[0].exchangeId"],
    ["too many unclaimed entries", s => ({ ...s, queue: Array.from({ length: INTAKE_MAX_UNCLAIMED + 1 }, (_, n) => unclaimed(n)) }), "$.intake.queue"],
    ["too many held entries", s => ({ ...s, invocation: null, queue: Array.from({ length: INTAKE_MAX_HELD + 1 }, (_, n) => held(n + 1, TEXT_A)) }), "$.intake.queue"],
    ["an invocation without items", s => ({ ...s, invocation: { ...s.invocation, items: [], itemBytes: [] } }), "$.intake.invocation.items"],
    ["an empty batch that is not ending", s => ({ ...s, invocation: { ...s.invocation, sent: false, items: [], itemBytes: [] } }),
        "$.intake.invocation.items"],
    ["an empty batch ending after a send", s => ({ ...s, invocation: { ...s.invocation, items: [], itemBytes: [],
        settle: { outcome: "interrupted", retry: null } } }), "$.intake.invocation.items"],
    ["an empty batch before its bind", s => ({ ...s, invocation: { ...unboundInvocation([TEXT_B]), items: [], itemBytes: [] } }),
        "$.intake.invocation.items"],
    ["sizes that are not one per item", s => ({ ...s, invocation: { ...s.invocation, itemBytes: [] } }), "$.intake.invocation.itemBytes"],
    ["sizes over what an invocation holds", s => ({ ...s, invocation: { ...s.invocation, itemBytes: [INTAKE_MAX_INVOCATION_ITEMS_BYTES] } }),
        "$.intake.invocation.itemBytes"],
    ["a size that is not the one measured at the claim", s => ({ ...s, invocation: { ...s.invocation, itemBytes: [s.invocation.itemBytes[0] + 1] } }),
        "$.intake.invocation.itemBytes[0]"],
    ["a text that is not its hash's", s => ({ ...s, invocation: { ...s.invocation, items: [{ ...s.invocation.items[0], text: TEXT_A }] } }),
        "$.intake.invocation.items[0].text"],
    ["a bound invocation without its text", s => ({ ...s, invocation: { ...s.invocation, items: [{ ...s.invocation.items[0], text: null }] } }),
        "$.intake.invocation.items[0].text"],
    ["an unbound invocation that was sent", s => ({ ...s, invocation: { ...unboundInvocation([TEXT_B]), sent: true } }), "$.intake.invocation.bound"],
    ["an unbound invocation with a text", s => ({ ...s, invocation: { ...unboundInvocation([TEXT_B]), items: s.invocation.items } }),
        "$.intake.invocation.items[0].text"],
    ["an unbound invocation without its retry", s => ({ ...s, invocation: { ...unboundInvocation([TEXT_B]), bindRetry: null } }),
        "$.intake.invocation.bindRetry"],
    ["a bound invocation with a bind retry", s => ({ ...s, invocation: { ...s.invocation, bindRetry: { attempts: 1, nextAttemptAtMs: 1 } } }),
        "$.intake.invocation.bindRetry"],
    ["another park cause", s => ({ ...s, invocation: { ...s.invocation, sent: false, parked: "tired" } }), "$.intake.invocation.parked"],
    ["a parked invocation that was sent", s => ({ ...s, invocation: { ...s.invocation, parked: "gate" } }), "$.intake.invocation.parked"],
    ["a cancel requested before a send", s => ({ ...s, invocation: { ...s.invocation, sent: false,
        items: [{ ...s.invocation.items[0], cancelRequested: true }] } }), "$.intake.invocation.items[0].cancelRequested"],
    ["an unclaimed cancel that is not a boolean", s => ({ ...s, queue: [{ ...s.queue[0], cancel: "yes" }] }), "$.intake.queue[0].cancel"],
    ["an unclaimed entry without its cancel", s => ({ ...s, queue: [{ ...s.queue[0], cancel: undefined }] }), "$.intake.queue[0].cancel"],
    ["a held cancel that is not a boolean", s => ({ ...s, queue: [{ ...s.queue[1], cancel: { retry: null } }] }), "$.intake.queue[0].cancel"],
    ["a held entry without its cancel", s => ({ ...s, queue: [{ ...s.queue[1], cancel: undefined }] }), "$.intake.queue[0].cancel"],
    ["a held cancel retry with no latched held entry", s => ({ ...s, heldCancelRetry: { attempts: 1, nextAttemptAtMs: 9 } }), "$.intake.heldCancelRetry"],
    ["a held cancel retry with a negative due time", s => ({ ...s, queue: [{ ...s.queue[1], cancel: true }], heldCancelRetry: { attempts: 1, nextAttemptAtMs: -1 } }),
        "$.intake.heldCancelRetry.nextAttemptAtMs"],
    ["a missing held cancel retry field", s => ({ v: 1, queue: s.queue, invocation: s.invocation }), "$.intake.heldCancelRetry"],
    ["a settling entry with another outcome", s => ({ ...s, queue: [settling(5, { outcome: "admitted" })] }), "$.intake.queue[0].outcome"],
    ["a settling entry with a negative due time", s => ({ ...s, queue: [settling(5, { retry: { attempts: 1, nextAttemptAtMs: -1 } })] }),
        "$.intake.queue[0].retry.nextAttemptAtMs"],
    ["a settling entry for a placed exchange", s => ({ ...s, queue: [s.queue[1], settling(2)] }), "$.intake.queue[1].exchangeId"],
    ["an exchange settling twice", s => ({ ...s, queue: [settling(5), { ...settling(5), claimId: "claim-s5b" }] }), "$.intake.queue[1].exchangeId"],
    ["too many waiting entries", s => ({ ...s, queue: [...Array.from({ length: 4 }, (_, n) => unclaimed(n)), ...Array.from({ length: 5 }, (_, n) => settling(n + 10))] }),
        "$.intake.queue"],
    ["a latched item on an unsent invocation that is ending",
        s => ({ ...s, invocation: latchedFirst(boundInvocation([TEXT_B], { settle: { outcome: "not_dispatched", retry: null } })) }),
        "$.intake.invocation.items[0].cancelRequested"],
    ["a cancel write with no latched cancel", s => ({ ...s, invocation: { ...s.invocation, cancelWrite: { retry: null } } }), "$.intake.invocation.cancelWrite"],
    ["a cancel write before the bind", s => ({ ...s, invocation: { ...latchedFirst(unboundInvocation([TEXT_B])), cancelWrite: { retry: null } } }),
        "$.intake.invocation.cancelWrite"],
    ["a cancel write with a negative due time",
        s => ({ ...s, invocation: { ...latchedFirst(s.invocation), cancelWrite: { retry: { attempts: 1, nextAttemptAtMs: -1 } } } }),
        "$.intake.invocation.cancelWrite.retry.nextAttemptAtMs"],
    ["an invocation without its cancel write field", s => ({ ...s, invocation: { ...s.invocation, cancelWrite: undefined } }), "$.intake.invocation.cancelWrite"],
    ["not_dispatched after a send", s => ({ ...s, invocation: { ...s.invocation, settle: { outcome: "not_dispatched", retry: null } } }),
        "$.intake.invocation.settle.outcome"],
    ["completed with no send", s => ({ ...s, invocation: { ...s.invocation, sent: false, settle: { outcome: "completed", retry: null } } }),
        "$.intake.invocation.settle.outcome"],
    ["another outcome", s => ({ ...s, invocation: { ...s.invocation, settle: { outcome: "done", retry: null } } }), "$.intake.invocation.settle.outcome"],
    ["an item twice in the batch", s => ({ ...s, invocation: { ...s.invocation, items: [s.invocation.items[0], s.invocation.items[0]],
        itemBytes: [s.invocation.itemBytes[0], s.invocation.itemBytes[0]] } }), "$.intake.invocation.items[1].exchangeId"],
];

test("a carried intake state is checked whole: each malformed part fails with its path, and nothing is read as empty", () => {
    assert.deepEqual(restoreIntakeState(undefined), { queue: [], invocation: null, heldCancelRetry: null });
    assert.deepEqual(restoreIntakeState(JSON.parse(JSON.stringify(VALID))), stateOf(VALID));
    for (const [name, change, path] of INVALID) {
        const raw = JSON.parse(JSON.stringify(change(structuredClone(VALID)) ?? null));
        assert.throws(() => restoreIntakeState(raw), error => {
            assert.ok(error instanceof IntakeShapeError, `${name}: ${error}`);
            assert.equal(error.path, path, `${name}: ${error.message}`);
            return true;
        }, name);
    }
    // The states an invocation passes through all restore: unbound with its retry, bound and ready, parked, sent, settling.
    for (const invocation of [
        unboundInvocation([TEXT_A, TEXT_B]),
        boundInvocation([TEXT_A]),
        boundInvocation([TEXT_A], { parked: "credential" }),
        boundInvocation([TEXT_A], { sent: true }),
        { ...boundInvocation([TEXT_A], { sent: true }), items: [{ ...boundInvocation([TEXT_A]).items[0], cancelRequested: true }] },
        boundInvocation([TEXT_A], { sent: true, settle: { outcome: "interrupted", retry: { attempts: 2, nextAttemptAtMs: 9 } } }),
        boundInvocation([TEXT_A], { settle: { outcome: "not_dispatched", retry: null } }),
        // Every item cancelled before the send: it ends not_dispatched with an empty batch, also while its end is retried.
        { ...boundInvocation([TEXT_A], { settle: { outcome: "not_dispatched", retry: null } }), items: [], itemBytes: [] },
        { ...boundInvocation([TEXT_A], { settle: { outcome: "not_dispatched", retry: { attempts: 1, nextAttemptAtMs: 9 } } }), items: [], itemBytes: [] },
        // Cancels latched (review INTAKE-MACHINE-01 to 03): before the bind; bound and unsent with its cancel write due or
        // failed, also parked; sent with its record due; sent while its end waits.
        latchedFirst(unboundInvocation([TEXT_A, TEXT_B])),
        latchedFirst(boundInvocation([TEXT_A, TEXT_B], { cancelWrite: { retry: null } })),
        latchedFirst(boundInvocation([TEXT_A], { parked: "credential", cancelWrite: { retry: { attempts: 1, nextAttemptAtMs: 9 } } })),
        latchedFirst(boundInvocation([TEXT_A], { sent: true, cancelWrite: { retry: null } })),
        latchedFirst(boundInvocation([TEXT_A], { sent: true, settle: { outcome: "completed", retry: { attempts: 1, nextAttemptAtMs: 9 } },
            cancelWrite: { retry: null } })),
    ]) {
        const state = carried({ invocation });
        assert.deepEqual(restoreIntakeState(JSON.parse(JSON.stringify(state))).invocation, invocation);
    }
    // Settling entries, latched held entries and a waiting copy whose cancel is latched restore.
    for (const queue of [
        [settling(5), held(2, TEXT_A)],
        [settling(5, { outcome: "refused_full", retry: { attempts: 3, nextAttemptAtMs: 9 } }), settling(6, { outcome: "refused_size" })],
        [held(2, TEXT_A, true), held(3, TEXT_A)],
        [unclaimed(1, true), unclaimed(2)],
    ]) {
        assert.deepEqual(restoreIntakeState(JSON.parse(JSON.stringify(carried({ queue })))).queue, queue);
    }
    // The latched held cancels' one write, failed, with its retry at its largest.
    const worst = { attempts: Number.MAX_SAFE_INTEGER, nextAttemptAtMs: Number.MAX_SAFE_INTEGER };
    const latchedHeld = carried({ queue: [held(2, TEXT_A, true), held(3, TEXT_A, true)], heldCancelRetry: worst });
    assert.deepEqual(restoreIntakeState(JSON.parse(JSON.stringify(latchedHeld))), stateOf(latchedHeld));
    // An unclaimed copy of an exchange that is already placed, or settling, may still wait (its claim will find the row).
    assert.doesNotThrow(() => restoreIntakeState(carried({ queue: [unclaimed(2), held(2, TEXT_A)] })));
    assert.doesNotThrow(() => restoreIntakeState(carried({ queue: [unclaimed(5), settling(5)] })));
});

test("a carry is checked and copied, and an empty state carries nothing", () => {
    assert.equal(carryIntakeState({ queue: [], invocation: null }), undefined);
    assert.equal(carriedIntakeBytes({ queue: [], invocation: null }), 0);
    const state = restoreIntakeState(structuredClone(VALID));
    const carriedForm = carryIntakeState(state);
    assert.deepEqual(carriedForm, VALID);
    assert.equal(carriedIntakeBytes(state), bytes(VALID));
    carriedForm.invocation.items[0].text = "changed";
    assert.equal(state.invocation.items[0].text, TEXT_B);
    // A state that would not restore is never carried.
    state.invocation.items[0].text = TEXT_A;
    assert.throws(() => carryIntakeState(state), error => error instanceof IntakeShapeError && error.path === "$.intake.invocation.items[0].text");
});

// ─── One item's exact size, and the batch chosen before the bind ──

test("an item's size is the exact UTF-8 length of the JSON it is carried as, escapes and multi-byte characters included", () => {
    for (const text of ["", "a", TEXT_A, TEXT_B, "\"\\\n\t\u0001\u001f", "日本語".repeat(100), "😀".repeat(50), "</script>\u2028\u2029"]) {
        const item = intakeBoundItem(ref(7, text), text);
        assert.equal(intakeItemBytes(item), bytes(item), JSON.stringify(text));
        // The order the item was built in does not matter: it is measured in the carried order.
        const shuffled = { cancelRequested: false, text, clientMessageId: item.clientMessageId, textSha256: item.textSha256, claimId: item.claimId,
            exchangeId: item.exchangeId };
        assert.equal(intakeItemBytes(shuffled), bytes(item));
    }
    const items = [TEXT_A, TEXT_B, "x"].map((text, index) => intakeBoundItem(ref(index, text), text));
    assert.equal(intakeItemsBytes(items.map(intakeItemBytes)), bytes(items));
    assert.equal(intakeItemsBytes([]), bytes([]));
    // One item fits an invocation alone up to the cap, exactly.
    assert.equal(intakeItemFitsAlone(INTAKE_MAX_INVOCATION_ITEMS_BYTES - 2), true);
    assert.equal(intakeItemFitsAlone(INTAKE_MAX_INVOCATION_ITEMS_BYTES - 1), false);
    assert.equal(intakeItemFitsAlone(0), false);
    assert.equal(intakeItemFitsAlone(1.5), false);
    // A text is within its cap by its UTF-8 bytes, and must be storable.
    assert.equal(intakeTextWithinCap("a".repeat(INTAKE_MAX_TEXT_BYTES)), true);
    assert.equal(intakeTextWithinCap("a".repeat(INTAKE_MAX_TEXT_BYTES + 1)), false);
    assert.equal(intakeTextWithinCap("é".repeat(INTAKE_MAX_TEXT_BYTES / 2 + 1)), false);
    assert.equal(intakeTextWithinCap("a\u0000b"), false);
    assert.equal(intakeTextWithinCap("a\ud800b"), false);
});

test("a batch is the longest arrival-order run of held items that fits one invocation, from the sizes measured at their claims", () => {
    const sized = (n, itemBytes) => ({ ...held(n, TEXT_A), itemBytes });
    assert.deepEqual(selectIntakeBatch([]), []);
    assert.deepEqual(selectIntakeBatch([unclaimed(1)]), []);
    // Unclaimed entries are passed over; held ones keep their order.
    const a = sized(1, 30_000);
    const b = sized(2, 30_000);
    const c = sized(3, 2_000);
    assert.deepEqual(selectIntakeBatch([unclaimed(9), a, unclaimed(8), b, c]), [a, b, c]);
    // The run stops at the first that does not fit, even if a later one would.
    const big = sized(4, 40_000);
    const next = sized(5, INTAKE_MAX_INVOCATION_ITEMS_BYTES - 2 - 40_000 - 1);
    const tiny = sized(6, 100);
    assert.equal(intakeItemsBytes([big.itemBytes, next.itemBytes]), INTAKE_MAX_INVOCATION_ITEMS_BYTES);
    assert.deepEqual(selectIntakeBatch([big, next, tiny]), [big, next]);
    const over = sized(7, next.itemBytes + 1);
    assert.deepEqual(selectIntakeBatch([big, over, tiny]), [big]);
    // The largest item that fits alone is a batch of one.
    const largest = sized(8, INTAKE_MAX_INVOCATION_ITEMS_BYTES - 2);
    assert.deepEqual(selectIntakeBatch([largest, tiny]), [largest]);
    // A held entry whose cancel is latched is never bound: it is passed over, and the run goes on after it.
    assert.deepEqual(selectIntakeBatch([{ ...largest, cancel: true }, tiny]), [tiny]);
    assert.deepEqual(selectIntakeBatch([{ ...tiny, cancel: true }]), []);
});

test("a held reference's cap is measured the same on admission and restore, as placed: 512 bytes fit, cancelled or not; 513 do not", () => {
    // An entry's cap bytes grow one for one with its client id; the one at exactly 512 restores, latched or not.
    const withId = length => ({ ...held(2, TEXT_A), clientMessageId: "c".repeat(length) });
    const fits = INTAKE_MAX_HELD_ENTRY_BYTES - (intakeHeldEntryCapBytes(withId(1)) - 1);
    assert.equal(intakeHeldEntryCapBytes(withId(fits)), INTAKE_MAX_HELD_ENTRY_BYTES);
    assert.equal(bytes(withId(fits)), INTAKE_MAX_HELD_ENTRY_BYTES);
    assert.equal(bytes({ ...withId(fits), cancel: true }), INTAKE_MAX_HELD_ENTRY_BYTES - 1);
    assert.equal(intakeHeldEntryCapBytes({ ...withId(fits), cancel: true }), INTAKE_MAX_HELD_ENTRY_BYTES);
    for (const entry of [withId(fits), { ...withId(fits), cancel: true }]) {
        assert.deepEqual(restoreIntakeState(JSON.parse(JSON.stringify(carried({ queue: [entry] })))).queue, [entry]);
    }
    assert.throws(() => restoreIntakeState(JSON.parse(JSON.stringify(carried({ queue: [withId(fits + 1)] })))),
        error => error instanceof IntakeShapeError && error.path === "$.intake.queue[0]");
});
