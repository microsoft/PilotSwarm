/**
 * Orchestration 1.0.83: a queued prompt cancelled at dispatch gives back the owed work it took (formal finding
 * rn.late-cancel, session-orchestration model so2; owner decision 2026-11-08T03:29Z, option A: fixed in 1.0.83 itself).
 *
 * After a lossy hand-off the session continues as new with a rehydration notice. A user prompt that interrupts the
 * shouldRehydrate wait takes the notice into its text (and a buffered child digest with it) and is queued. Before 1.0.83
 * fixed it, a cancel tombstone for that prompt arriving after the pass that queued it (in a later drain, or in the
 * pre-dispatch sweep) dropped the prompt at dispatch (decide-fifo, or decide-merge for a prompt merged behind another)
 * and the notice and the digest were gone: the model was never told. Now the queued item carries them, and the drop
 * gives them back under giveBackCarriedWork's rule: the notice only while none is pending, the digest merged with the
 * pending one. The next turn carries each exactly once.
 *
 * so4b (formal finding so4b, decision 2026-11-08T04:15Z; fixed in 1.0.83 in place):
 * - F1a: a late give-back merges the digest by when each update was observed: with two prompts cancelled late, the
 *   pending digest no longer keeps the older entry over the newer one (a child's "completed" over its later "failed").
 * - F1b: a late give-back leaves to a prompt queued after the dropped one what it carries: a child's entry when that
 *   prompt carries a later entry for the child of the same or a higher rank (never a lifecycle update for a later
 *   progress note), and the notice when that prompt carries one.
 * - F2: the pre-dispatch sweep runs while the prompt is still queued, so a set_model it handles (a continue-as-new)
 *   carries the prompt in the FIFO, and the next execution runs it on the new model, once.
 *
 * Drives the real 1.0.83 drain/decide generators and run loop against a fake durable context (as fifo-queue-drain does
 * for 1.0.82): a Map for KV, a message list for the durable queue, and a clock that moves only when a timer wins.
 * Messages in `sweepMessages` arrive at the first pre-dispatch sweep's read (after drain's pass ended); `onTurn` runs
 * while a turn runs (messages it pushes arrive during the turn).
 *
 * Run: npx vitest run test/local/fifo-late-cancel-1-0-83.test.js
 */
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { createRuntime, runLoop } from "../../src/orchestration_1_0_83/runtime.ts";
import { appendToFifo, drain } from "../../src/orchestration_1_0_83/queue.ts";
import { bufferChildUpdate, continueInput } from "../../src/orchestration_1_0_83/lifecycle.ts";
import { FIFO_BUCKET_COUNT, MAX_FIFO_ITEM_BYTES, PREDISPATCH_CANCEL_SWEEP_MS } from "../../src/orchestration_1_0_83/state.ts";

const { MAX_KV_VALUE_BYTES } = createRequire(import.meta.url)("duroxide");

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: (ctx, sessionId, affinity, config, contract) => ctx.proxy("session", contract),
    createSessionManagerProxy: (ctx, contract) => ctx.proxy("manager", contract),
}));

const NOTE = "REHYDRATED-NOTE: the previous worker lost the live session";
const START_MS = 1_750_000_000_000;

/** `kv`: the KV of an earlier execution, which a continue-as-new keeps (the FIFO is KV). */
function harness(overrides = {}, { kv = new Map(), onTurn = null } = {}) {
    const calls = [];
    const turns = [];
    const turnModels = [];
    const results = [];
    const messages = [];
    const sweepMessages = [];
    let runtimeRef = null;
    const clock = { now: START_MS };
    let guid = 0;
    const ctx = {
        traceInfo() {},
        traceWarn() {},
        traceError() {},
        setCustomStatus() {},
        getValue: key => kv.get(key) ?? null,
        setValue: (key, value) => {
            if (Buffer.byteLength(value, "utf8") > MAX_KV_VALUE_BYTES) throw new Error("KV value exceeds size limit");
            kv.set(key, value);
        },
        clearValue: key => kv.delete(key),
        utcNow: () => ({ effect: "now" }),
        newGuid: () => ({ effect: "guid" }),
        scheduleTimer: ms => ({ effect: "timer", ms }),
        dequeueEvent: name => ({ effect: "dequeue", name }),
        race: (left, right) => ({ effect: "race", left, right }),
        continueAsNewVersioned: (input, version) => ({ effect: "can", input, version }),
        proxy(prefix) {
            return new Proxy({}, { get: (_, name) => (...args) => ({ effect: `${prefix}.${String(name)}`, args }) });
        },
    };
    function resolve(effect, { fireTimers = false } = {}) {
        if (effect == null) return undefined;
        calls.push(effect);
        switch (effect.effect) {
            case "now": return clock.now;
            case "guid": return `guid-${++guid}`;
            case "timer": clock.now += effect.ms; return undefined;
            case "dequeue":
                if (!messages.length) throw new Error("unexpected blocking dequeue");
                return JSON.stringify(messages.shift());
            case "race":
                if (effect.left?.effect === "session.runTurn") return { index: 0, value: resolve(effect.left) };
                if (effect.left?.effect === "dequeue") {
                    if (effect.right?.ms === PREDISPATCH_CANCEL_SWEEP_MS && sweepMessages.length) messages.push(...sweepMessages.splice(0));
                    if (messages.length) return { index: 0, value: JSON.stringify(messages.shift()) };
                    if (!fireTimers && effect.right.ms >= 1000) throw new Error("parked");
                    clock.now += effect.right.ms;
                    return { index: 1 };
                }
                throw new Error(`unexpected race: ${JSON.stringify(effect)}`);
            case "session.runTurn": {
                turns.push(effect.args);
                turnModels.push(runtimeRef?.state.config.model);
                onTurn?.(turns.length);
                return results.shift() ?? { type: "completed", content: "ok" };
            }
            case "manager.listChildSessions": return JSON.stringify([]);
            case "manager.getSessionStatus": return JSON.stringify({ status: "running" });
            case "manager.getDescendantSessionIds": return [];
            case "manager.getWorkerSessionPolicy": return { policy: null, allowedAgentNames: [] };
            case "manager.resolveAgentConfig": return null;
            case "manager.getOrchestrationStats": return { historySizeBytes: 0 };
            default: return undefined;
        }
    }
    function drive(gen) {
        let value;
        let failure;
        for (let step = 0; step < 4000; step++) {
            const next = failure ? gen.throw(failure) : gen.next(value);
            failure = undefined;
            if (next.done) return next.value;
            try { value = resolve(next.value); } catch (error) { failure = error; }
        }
        throw new Error("generator exceeded bound");
    }
    const runtime = drive(createRuntime(ctx, {
        sessionId: "late-cancel-fixture", config: {}, iteration: 4, isSystem: true, blobEnabled: false, ...overrides,
    }, { currentVersion: "1.0.83", latestVersion: "1.0.83" }));
    runtimeRef = runtime;
    const fifo = () => {
        const out = [];
        for (let i = 0; i < FIFO_BUCKET_COUNT; i++) {
            const raw = kv.get(`fifo.${i}`);
            if (raw) out.push(...JSON.parse(raw));
        }
        return out;
    };
    const arm = (type, remainingMs, extra = {}) => {
        runtime.state.activeTimer = { deadlineMs: clock.now + remainingMs, originalDurationMs: Math.max(remainingMs, 1000), reason: `${type} reason`, type, ...extra };
    };
    /**
     * The real run loop until `turnCount` turns ran in all, or the session parks. Timers fire only with `fireTimers`
     * (each race with a timer of a second or more is then won by its timer, as when no message comes).
     */
    const run = ({ turnCount = Infinity, fireTimers = false } = {}) => {
        const gen = runLoop(runtime);
        let value;
        let failure;
        for (let n = 0; n < 8000; n++) {
            if (turns.length >= turnCount) return { stopped: "turns" };
            const next = failure ? gen.throw(failure) : gen.next(value);
            failure = undefined;
            if (next.done) return { stopped: "done" };
            const effect = next.value;
            if (effect?.effect === "race" && effect.left?.effect === "dequeue" && !messages.length && effect.right?.ms >= 1000 && !fireTimers) {
                return { stopped: "parked", ms: effect.right.ms };
            }
            if (effect?.effect === "dequeue" && !messages.length) return { stopped: "blocking" };
            if (effect?.effect === "can") return { stopped: "can", input: effect.input };
            try { value = resolve(effect, { fireTimers }); } catch (error) { failure = error; }
        }
        throw new Error("run loop did not stop");
    };
    return { runtime, kv, clock, calls, turns, turnModels, results, messages, sweepMessages, drive, fifo, arm, run };
}

const count = (text, mark) => text.split(mark).length - 1;
const turnText = turn => JSON.stringify(turn);
/** The child digest a prompt takes: one completed child, with a mark the turn's text shows. */
const digest = mark => ({
    startedAtMs: START_MS - 1_000, ready: true,
    updates: [{ sessionId: "child-a", updateType: "completed", content: mark, observedAtMs: START_MS - 1_000 }],
});

/**
 * A lossy hand-off's session, as its continue-as-new starts it: the notice is pending, the session needs hydrating (so its
 * next turn says the notice, wrapWithResumeContext), and a shouldRehydrate wait is armed.
 */
const HANDOFF = { rehydrationMessage: NOTE, needsHydration: true, blobEnabled: true };
function afterHandoff(extra = {}) {
    const h = harness({ ...HANDOFF, ...extra });
    h.arm("wait", 600_000, { shouldRehydrate: true });
    return h;
}

/** A user prompt interrupts the wait and is queued; it took what was owed. */
function queuePrompt(h, id, text = `${id} please`) {
    h.messages.push({ prompt: text, clientMessageIds: [id] });
    h.drive(drain(h.runtime));
}

describe("1.0.83: a queued prompt cancelled at dispatch gives back the notice and the child digest it took", () => {
    it("the queued prompt took the notice: its item carries it, and nothing is pending", () => {
        const h = afterHandoff();
        queuePrompt(h, "p1");
        const [item] = h.fifo();
        expect(item.prompt).toContain(NOTE);
        expect(item.carriedRehydrationMessage).toBe(NOTE);
        expect(h.runtime.state.pendingRehydrationMessage).toBeUndefined();
    });

    it("decide-fifo: a tombstone in a later pass drops the prompt; the notice is given back and the next turn carries it once", () => {
        const h = afterHandoff();
        queuePrompt(h, "p1");
        // The tombstone comes after the pass that queued the prompt; the prompt is dropped at dispatch.
        h.messages.push({ cancelPending: ["p1"] });
        h.run();
        expect(h.turns).toHaveLength(0);
        expect(h.fifo()).toEqual([]);
        expect(h.runtime.state.pendingRehydrationMessage).toBe(NOTE);
        // The next turn (the resumed wait's, when its timer fires) carries the notice, once.
        h.run({ turnCount: 1, fireTimers: true });
        expect(h.turns).toHaveLength(1);
        expect(count(turnText(h.turns[0]), "REHYDRATED-NOTE")).toBe(1);
        expect(h.runtime.state.pendingRehydrationMessage).toBeUndefined();
    });

    it("decide-fifo: a tombstone caught by the pre-dispatch sweep drops the prompt; the next prompt's turn carries the notice once", () => {
        const h = afterHandoff();
        queuePrompt(h, "p1");
        // Dispatch starts with no message waiting; the sweep then reads the tombstone and a new prompt.
        h.messages.push({ cancelPending: ["p1"] }, { prompt: "p2 next", clientMessageIds: ["p2"] });
        h.run({ turnCount: 1 });
        expect(h.turns).toHaveLength(1);
        const text = turnText(h.turns[0]);
        expect(text).toContain("p2 next");
        expect(text).not.toContain("p1 please");
        expect(count(text, "REHYDRATED-NOTE")).toBe(1);
    });

    it("decide-merge: a cancelled prompt behind the dispatched one is dropped and its notice joins that turn once", () => {
        // The notice was taken by p1, queued behind p0 (as drain stores it: the text and the marker); none is pending.
        const h = harness({ needsHydration: true, blobEnabled: true });
        appendToFifo(h.runtime, [
            { kind: "prompt", prompt: "p0 first", bootstrap: false, clientMessageIds: ["p0"] },
            { kind: "prompt", prompt: `p1 please\n\n[SYSTEM: ${NOTE}\n]`, bootstrap: false, clientMessageIds: ["p1"], carriedRehydrationMessage: NOTE },
        ]);
        expect(h.runtime.state.pendingRehydrationMessage).toBeUndefined();
        h.runtime.state.cancelledMessageIds.add("p1");
        h.run({ turnCount: 1 });
        const text = turnText(h.turns[0]);
        expect(text).toContain("p0 first");
        expect(text).not.toContain("p1 please");
        expect(count(text, "REHYDRATED-NOTE")).toBe(1);
    });

    it("the item's markers survive a continue-as-new (the FIFO is KV): the drop after it still gives the notice back", () => {
        const before = afterHandoff();
        queuePrompt(before, "p1");
        // The session continues as new with the prompt still queued; the next execution reads the same KV.
        const input = continueInput(before.runtime);
        expect(input.rehydrationMessage).toBeUndefined();
        const h = harness(input, { kv: before.kv });
        expect(h.fifo().map(item => item.carriedRehydrationMessage)).toEqual([NOTE]);
        h.messages.push({ cancelPending: ["p1"] }, { prompt: "p2 next", clientMessageIds: ["p2"] });
        h.run({ turnCount: 1 });
        const text = turnText(h.turns[0]);
        expect(text).toContain("p2 next");
        expect(count(text, "REHYDRATED-NOTE")).toBe(1);
    });

    it("a newer notice pending at the drop is kept, and the old one is not given back: never two copies", () => {
        const h = afterHandoff();
        queuePrompt(h, "p1");
        h.runtime.state.pendingRehydrationMessage = "NEWER-NOTE";
        h.messages.push({ cancelPending: ["p1"] });
        h.run();
        expect(h.runtime.state.pendingRehydrationMessage).toBe("NEWER-NOTE");
        h.run({ turnCount: 1, fireTimers: true });
        const text = turnText(h.turns[0]);
        expect(count(text, "NEWER-NOTE")).toBe(1);
        expect(count(text, "REHYDRATED-NOTE")).toBe(0);
    });

    it("the child digest the prompt took is given back at the drop and delivered exactly once", () => {
        const h = afterHandoff({ pendingChildDigest: digest("DIGESTMARK-A") });
        queuePrompt(h, "p1");
        const [item] = h.fifo();
        expect(item.prompt).toContain("DIGESTMARK-A");
        expect(item.carriedChildDigest?.updates.map(u => u.content)).toEqual(["DIGESTMARK-A"]);
        expect(h.runtime.state.pendingChildDigest).toBeNull();
        h.messages.push({ cancelPending: ["p1"] });
        h.run({ turnCount: 1, fireTimers: true });
        const delivered = h.turns.map(turnText).join("\n");
        expect(count(delivered, "DIGESTMARK-A")).toBe(1);
        expect(delivered).not.toContain("p1 please");
    });

    it("a given-back digest keeps the newer update a child sent after the prompt took it, and the other child's", () => {
        const taken = digest("OLD-RESULT-A");
        taken.updates.push({ sessionId: "child-b", updateType: "completed", content: "RESULT-B", observedAtMs: START_MS - 1_000 });
        const h = afterHandoff({ pendingChildDigest: taken });
        queuePrompt(h, "p1");
        // Child a's newer update arrives while the prompt waits in the FIFO.
        h.runtime.state.pendingChildDigest = { startedAtMs: START_MS, updates: [{ sessionId: "child-a", updateType: "completed", content: "NEW-RESULT-A", observedAtMs: START_MS }] };
        h.messages.push({ cancelPending: ["p1"] });
        h.run();
        expect(h.runtime.state.pendingChildDigest?.updates.map(u => [u.sessionId, u.content]).sort())
            .toEqual([["child-a", "NEW-RESULT-A"], ["child-b", "RESULT-B"]]);
    });

    it("the markers never make a prompt too large to queue: the digest's goes first, then the notice's", () => {
        // The digest's text in the prompt is clipped; its marker is the whole digest.
        const h = afterHandoff({ pendingChildDigest: digest(`DIGESTMARK-B ${"d".repeat(14_000)}`) });
        // A prompt that fits with the notice and the digest in its text, but not with the digest's marker as well.
        const text = `p1 ${"w".repeat(MAX_FIFO_ITEM_BYTES - 9_000)}`;
        queuePrompt(h, "p1", text);
        const [item] = h.fifo();
        expect(item.prompt).toContain("DIGESTMARK-B");
        expect(item.carriedChildDigest).toBeUndefined();
        expect(item.carriedRehydrationMessage).toBe(NOTE);
        expect(Buffer.byteLength(JSON.stringify([item]), "utf8")).toBeLessThanOrEqual(MAX_FIFO_ITEM_BYTES);
    });
});

/** A child update as the drain buffers it, observed `atMs` after the start. */
const childUpdate = (h, updateType, content, atMs) =>
    bufferChildUpdate(h.runtime, { sessionId: "child-x", updateType, content }, START_MS + atMs);
const delivered = h => h.turns.map(turnText).join("\n");

describe("so4b: a late give-back keeps a child's newest update and leaves to a later queued prompt what it carries", () => {
    it("F1a: completed, then failed, each taken by a queued prompt, both cancelled: the next digest says failed", () => {
        const h = afterHandoff();
        childUpdate(h, "completed", "X-COMPLETED", 1);
        queuePrompt(h, "pA");
        childUpdate(h, "failed", "X-FAILED", 2);
        queuePrompt(h, "pB");
        expect(h.fifo().map(item => item.carriedChildDigest?.updates.map(u => u.content))).toEqual([["X-COMPLETED"], ["X-FAILED"]]);
        h.messages.push({ cancelPending: ["pA", "pB"] });
        h.run();
        expect(h.fifo()).toEqual([]);
        expect(h.runtime.state.pendingChildDigest?.updates.map(u => [u.sessionId, u.updateType])).toEqual([["child-x", "failed"]]);
        h.run({ turnCount: 1, fireTimers: true });
        expect(count(delivered(h), "X-FAILED")).toBe(1);
        expect(delivered(h)).not.toContain("X-COMPLETED");
    });

    it("F1b digest: progress taken by A, completed taken by B, A cancelled, B runs: no later progress entry for that child", () => {
        const h = afterHandoff();
        childUpdate(h, "progress", "X-PROGRESS", 1);
        queuePrompt(h, "pA");
        childUpdate(h, "completed", "X-COMPLETED", 2);
        queuePrompt(h, "pB");
        h.messages.push({ cancelPending: ["pA"] });
        h.run({ turnCount: 1 });
        expect(h.turns).toHaveLength(1);
        expect(turnText(h.turns[0])).toContain("pB please");
        expect(count(delivered(h), "X-COMPLETED")).toBe(1);
        // A's older progress note is not given back to come after B's completed.
        expect(h.runtime.state.pendingChildDigest?.updates.some(u => u.sessionId === "child-x") ?? false).toBe(false);
        h.run({ turnCount: 2, fireTimers: true });
        expect(delivered(h)).not.toContain("X-PROGRESS");
    });

    it("F1b notice: two lossy hand-offs, notices taken by A and B, A cancelled, B runs: the notice is delivered once", () => {
        // Each prompt took one hand-off's notice, as drain stores it (the text and the marker); none is pending, and the
        // session still needs hydrating, so a pending notice would join the next turn.
        const SECOND = `${NOTE} (second hand-off)`;
        const h = harness({ needsHydration: true, blobEnabled: true });
        appendToFifo(h.runtime, [
            { kind: "prompt", prompt: `pA please\n\n[SYSTEM: ${NOTE}\n]`, bootstrap: false, clientMessageIds: ["pA"], carriedRehydrationMessage: NOTE },
            { kind: "prompt", prompt: `pB please\n\n[SYSTEM: ${SECOND}\n]`, bootstrap: false, clientMessageIds: ["pB"], carriedRehydrationMessage: SECOND },
        ]);
        h.messages.push({ cancelPending: ["pA"] });
        h.run({ turnCount: 1 });
        expect(h.turns).toHaveLength(1);
        expect(turnText(h.turns[0])).toContain("pB please");
        expect(turnText(h.turns[0])).not.toContain("pA please");
        expect(h.runtime.state.pendingRehydrationMessage).toBeUndefined();
        h.run({ turnCount: 2, fireTimers: true });
        expect(count(delivered(h), "REHYDRATED-NOTE")).toBe(1);
    });

    it("a carried lifecycle update is never dropped for a later progress note: completed taken by A, progress by B, A cancelled: completed still reaches the parent", () => {
        const h = afterHandoff();
        childUpdate(h, "completed", "X-COMPLETED", 1);
        queuePrompt(h, "pA");
        childUpdate(h, "progress", "X-PROGRESS", 2);
        queuePrompt(h, "pB");
        h.messages.push({ cancelPending: ["pA"] });
        h.run({ turnCount: 2, fireTimers: true });
        expect(turnText(h.turns[0])).toContain("pB please");
        expect(count(delivered(h), "X-PROGRESS")).toBe(1);
        expect(count(delivered(h), "X-COMPLETED")).toBe(1);
    });
});

describe("so4b F2: a set_model the pre-dispatch sweep handles keeps the queued prompt", () => {
    it("while a turn runs, prompt P (with a client message id) and then set_model arrive: P runs on the new model, once", () => {
        const before = harness({ config: { model: "old-model" } }, { onTurn: () => {
            // During the first turn: P is sent, then the model change, which arrives after drain's pass that queues P.
            before.messages.push({ prompt: "P please", clientMessageIds: ["pP"] });
            before.sweepMessages.push({ type: "cmd", cmd: "set_model", id: "set-1", args: { model: "new-model" } });
        } });
        before.messages.push({ prompt: "first please", clientMessageIds: ["p0"] });
        const ended = before.run();
        expect(before.turns).toHaveLength(1);
        expect(ended.stopped).toBe("can");
        expect(ended.input.config.model).toBe("new-model");
        // P is still queued in the FIFO (KV), which the next execution reads.
        expect(before.fifo().map(item => item.clientMessageIds)).toEqual([["pP"]]);
        const after = harness(ended.input, { kv: before.kv });
        after.run({ turnCount: 3, fireTimers: true });
        const withP = after.turns.map(turnText).filter(text => text.includes("P please"));
        expect(withP).toHaveLength(1);
        expect(after.turnModels[after.turns.map(turnText).findIndex(text => text.includes("P please"))]).toBe("new-model");
        // Not taken for a duplicate of its own client message id.
        expect(after.calls.some(call => JSON.stringify(call).includes("session.message_duplicate_suppressed"))).toBe(false);
        expect(after.fifo()).toEqual([]);
    });
});
