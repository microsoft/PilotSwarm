// Native rate-limit recovery for a reset-enabled leaf session.
//
// A leaf session — one opted into `contextReset`, which forbids native children
// — runs the same batch work a native root does, over the same provider, at the
// same concurrency. It earns the same bounded 429 recovery the runtime already
// gives a root, and withholding it turned an ordinary transient rate limit into
// a terminal EPHEMERAL_INVOCATION_FAILED.
//
// Recovery is a retry of the model call, so it is unsafe in exactly one window:
// the reset boundary. A replayed call there could call the reset tool a second
// time, or repeat the continuation the clear seeds. That window is closed at
// the helper — the only place that can authorize a retry — rather than being
// left to the host's failure handling to win a race against.
//
// A live model cannot be made to hit a rate limit on cue, so every path here is
// driven through a real scripted endpoint whose reply, or refusal, is chosen by
// the test. No paid provider is contacted and no database is used.
import { describe, it, expect } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { createEphemeralSessionRunner } from "../../dist/ephemeral-session.js";
import { createEphemeralClient } from "../../dist/ephemeral-client.js";
import { loadProviderTypes } from "../../src/provider-catalog.ts";
import { WIRES, createScriptedWire } from "../helpers/scripted-wires.mjs";

const MODEL = "gpt-5.6-terra";
const WIRE = WIRES.openai;
const SEEDED_REPLY = "Ready for the next instruction.";

/** A transient rate limit, with the backoff the test wants to observe. */
const rateLimit = retryAfter => ({ status: 429, headers: { "retry-after": String(retryAfter) },
    body: { error: { message: "Synthetic provider limit", type: "rate_limit_error" } } });

function credentialCatalog() {
    return {
        async getUserRole() { return { role: "user", roleSeenAt: null }; },
        providers: {
            async lookupUserId() { return 1; },
            async getCredential() {
                return { name: "synthetic", typeId: "template", class: "shared",
                    ownerUserId: null, baseUrl: null, secretRef: { value: "synthetic-only-key" } };
            },
        },
    };
}

/**
 * Drives one two-batch leaf run, faulting whichever scripted turns the caller
 * names. `faults` maps a phase to the occurrences of that phase that should
 * fail, so "the first reset prompt" and "the continuation seeded by the clear"
 * can be singled out precisely.
 */
async function runLeaf({ faults = {}, contextReset = true, batches = 2, gateFault, turnTimeoutMs = 120000 } = {}) {
    const root = path.resolve(`.ephemeral-leaf-recovery-${randomUUID()}`);
    const cwd = path.join(root, "workspace"), scratch = path.join(root, "sdk");
    await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });

    const prompts = Array.from({ length: batches }, (_v, i) => `BATCH ${i} WORK ${randomUUID().slice(0, 8)}`);
    const canaries = Array.from({ length: batches }, (_v, i) => `CANARY-${i}-${randomUUID().slice(0, 8)}`);
    const phases = [], events = [], retryFlags = [], gate = [];
    const counts = new Map();

    // Every scripted turn announces its phase, then asks whether this
    // occurrence of that phase is meant to fail. Counting occurrences is what
    // makes "it was not retried" observable: a retry is a second request in the
    // same phase, and it is never anything else.
    const faulted = phase => {
        const seen = (counts.get(phase) ?? 0) + 1;
        counts.set(phase, seen);
        phases.push(phase);
        return faults[phase]?.(seen);
    };

    const server = await createScriptedWire(WIRE, (messages, tools) => {
        const last = messages.at(-1) ?? {};
        const index = prompts.findIndex(prompt => String(last.content ?? "").includes(prompt));
        if (index >= 0) return faulted(`batch-${index}`) ?? { content: `Finished batch ${index}. ${canaries[index]}` };
        if (messages.some(message => message.toolCalls > 0)) return faulted("reset-seeded") ?? { content: SEEDED_REPLY };
        const tool = tools.find(entry => typeof entry === "string" && entry.includes("context_reset"));
        if (tool) return faulted("reset-call") ?? { tool };
        phases.push("unexpected"); return { content: "UNEXPECTED" };
    });

    const types = loadProviderTypes({ providers: [
        { id: "template", type: WIRE.type, baseUrl: server.baseUrl, models: [MODEL] }] });
    try {
        const run = createEphemeralSessionRunner(credentialCatalog(), () => types, {
            scratchRoot: scratch, turnTimeoutMs,
            createClient: (options, provider) => {
                const client = createEphemeralClient(options, provider, () => {}, () => {});
                return { ...client, async createSession(config, retryModelRateLimits) {
                    retryFlags.push(retryModelRateLimits);
                    const session = await client.createSession({ ...config, onEvent(event) {
                        events.push(event); config.onEvent?.(event);
                    } }, retryModelRateLimits);
                    // Whether the barrier reopened recovery is a property of
                    // the run, not something to infer from request counts.
                    return { ...session, setModelRecoveryGate(gated) {
                        gate.push(gated);
                        // The helper's IPC call owns no timeout, so a child that
                        // simply never answers is the realistic hang. Model it
                        // directly rather than trusting that it cannot happen.
                        if (gateFault?.hop === gated) {
                            return gateFault.mode === "reject"
                                ? Promise.reject(new Error("gate rpc refused"))
                                : new Promise(() => {});
                        }
                        return session.setModelRecoveryGate(gated);
                    } };
                } };
            },
        });
        let turn = 0;
        const outcome = await run({
            actor: { provider: "fixture", subject: "test" }, executionId: randomUUID(),
            model: `synthetic:${MODEL}`, workingDirectory: cwd,
            systemMessage: "Private synthetic system", prompt: prompts[0],
            ...(contextReset ? { contextReset: true } : {}),
            onResponse: async () => { turn++;
                return contextReset && turn < batches
                    ? { action: "clear_context", prompt: prompts[turn] } : { action: "complete" }; },
        }).then(result => ({ result }), error => ({ error }));
        const count = phase => phases.filter(entry => entry === phase).length;
        const cleared = events.filter(event => event.type === "session.context_cleared").length;
        return { ...outcome, phases, count, cleared, events, server, canaries, prompts, retryFlags, gate };
    } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
    }
}

describe("ephemeral leaf sessions keep the runtime's bounded rate-limit recovery", () => {
    it.concurrent("a batch turn recovers from a transient limit on both sides of a reset boundary",
        { timeout: 180000 }, async () => {
            // Both batches hit a rate limit on their first attempt: one before
            // any reset has happened, one after the boundary has closed and
            // reopened the helper's recovery.
            const run = await runLeaf({ faults: {
                "batch-0": seen => seen === 1 ? rateLimit(1) : undefined,
                "batch-1": seen => seen === 1 ? rateLimit(1) : undefined,
            } });
            expect(run.error).toBeUndefined();

            // The session opted in, so the helper was built with recovery.
            expect(run.retryFlags).toEqual([true]);

            // Each limited turn was retried exactly once, in the same session,
            // and then produced the batch's real answer.
            expect(run.count("batch-0")).toBe(2);
            expect(run.count("batch-1")).toBe(2);
            expect(run.count("unexpected")).toBe(0);

            // The run finished normally: both batches ran and the boundary
            // between them still cleared exactly once.
            expect(run.result.turnCount).toBe(2);
            expect(run.result.text).toContain(run.canaries[1]);
            expect(run.cleared).toBe(1);
            expect(run.count("reset-call")).toBe(1);

            // A limited call spends without reporting counters, so the run
            // says so rather than publishing a total it cannot stand behind.
            expect(run.result.usageUncertain).toBe(true);

            // Closed once for the barrier and reopened once, after it was
            // verified. The recovered batch-1 limit above is what proves the
            // reopen actually restored recovery rather than merely being sent.
            expect(run.gate).toEqual([true, false]);
        });

    it.concurrent("a limit on the reset prompt fails closed and is never retried",
        { timeout: 180000 }, async () => {
            // The limit is one the runtime does retry — proven by the batch
            // case above — so a second reset request is authorized here unless
            // something refuses it. Requests are counted once the run is over,
            // so a retry cannot escape the count by arriving late.
            const run = await runLeaf({ faults: { "reset-call": seen => seen === 1 ? rateLimit(1) : undefined } });
            expect(run.result).toBeUndefined();
            expect(run.error?.code).toBe("EPHEMERAL_RESET_FAILED");

            // Exactly one reset request: the helper refused to replay it, and
            // the boundary did not spend another attempt on a provider error.
            expect(run.count("reset-call")).toBe(1);
            expect(run.cleared).toBe(0);
            expect(run.count("batch-1")).toBe(0);
            expect(run.count("reset-seeded")).toBe(0);
            // One batch request and one reset request, and nothing after.
            expect(run.server.requests.length).toBe(2);

            // The barrier failed, so recovery stays shut until teardown. A
            // hook decision arriving late therefore has no reopened window to
            // land in, rather than being merely unlikely to.
            expect(run.gate).toEqual([true]);
        });

    it.concurrent("a limit on the continuation seeded by an observed clear fails closed and is never replayed",
        { timeout: 180000 }, async () => {
            // The hardest case: the clear has already happened, so a replay
            // would repeat a turn against a window that no longer exists.
            const run = await runLeaf({ faults: { "reset-seeded": seen => seen === 1 ? rateLimit(1) : undefined } });
            expect(run.result).toBeUndefined();
            expect(run.error?.code).toBe("EPHEMERAL_RESET_FAILED");

            // The clear really did land before the failure.
            expect(run.cleared).toBe(1);
            expect(run.count("reset-call")).toBe(1);

            // And the seeded turn ran exactly once: not replayed, and not
            // followed by a second reset or by the next batch.
            expect(run.count("reset-seeded")).toBe(1);
            expect(run.count("batch-1")).toBe(0);
            expect(run.gate).toEqual([true]);
        });

    it.concurrent("stays closed across a declined attempt and reopens once the retry succeeds",
        { timeout: 180000 }, async () => {
            // A model that answers in prose instead of calling the tool leaves
            // the window untouched, so the barrier asks again. No model call
            // runs between those attempts, and recovery must not flicker open
            // in the gap.
            const run = await runLeaf({ faults: {
                "reset-call": seen => seen === 1 ? { content: "I would rather not." } : undefined } });
            expect(run.error).toBeUndefined();
            expect(run.count("reset-call")).toBe(2);
            expect(run.cleared).toBe(1);
            expect(run.gate).toEqual([true, false]);
        });

    it.concurrent("a gate hop that never answers is bounded by the turn deadline rather than hanging the run",
        { timeout: 180000 }, async () => {
            // The helper's IPC `call` carries no timeout of its own, so the only
            // thing standing between a wedged child and an unbounded await is
            // the armed turn deadline. Hang the reopen — the last await of the
            // barrier, and the one that used to run with the timer cleared.
            const started = Date.now();
            const run = await runLeaf({ gateFault: { hop: false, mode: "hang" }, turnTimeoutMs: 8000 });
            const elapsed = Date.now() - started;

            // It ended, and it ended because the deadline fired.
            expect(run.result).toBeUndefined();
            expect(run.error?.code).toBe("EPHEMERAL_ABORTED");
            expect(elapsed).toBeLessThan(60000);

            // The barrier itself had completed, so the hang is genuinely in the
            // reopen and not somewhere earlier.
            expect(run.cleared).toBe(1);
            expect(run.gate).toEqual([true, false]);
            // Recovery never came back, so the next batch never ran.
            expect(run.count("batch-1")).toBe(0);
        });

    it.concurrent("a gate close that never answers is bounded before any reset prompt is spent",
        { timeout: 180000 }, async () => {
            // The close guards the whole barrier, so a hang there must stop the
            // run before the first reset request rather than after it.
            const run = await runLeaf({ gateFault: { hop: true, mode: "hang" }, turnTimeoutMs: 8000 });
            expect(run.result).toBeUndefined();
            expect(run.error?.code).toBe("EPHEMERAL_ABORTED");
            expect(run.gate).toEqual([true]);
            expect(run.count("reset-call")).toBe(0);
            expect(run.cleared).toBe(0);
        });

    it.concurrent("a reopen that fails outright fails the run instead of leaving the next batch unrecovered",
        { timeout: 180000 }, async () => {
            // The failed-open case: were this swallowed, the run would continue
            // into the next batch with recovery still shut and no sign of it.
            const run = await runLeaf({ gateFault: { hop: false, mode: "reject" } });
            expect(run.result).toBeUndefined();
            expect(run.error).toBeDefined();
            expect(run.cleared).toBe(1);
            expect(run.gate).toEqual([true, false]);
            expect(run.count("batch-1")).toBe(0);
        });

    it.concurrent("an ordinary session without a reset boundary is unchanged",
        { timeout: 180000 }, async () => {
            // No opt-in, so no recovery is constructed and a limit stays
            // terminal exactly as it was before leaf recovery existed.
            const run = await runLeaf({ contextReset: false, batches: 1,
                faults: { "batch-0": seen => seen === 1 ? rateLimit(1) : undefined } });
            expect(run.result).toBeUndefined();
            expect(run.error?.code).toBe("EPHEMERAL_INVOCATION_FAILED");
            expect(run.retryFlags).toEqual([false]);
            expect(run.count("batch-0")).toBe(1);
            // No barrier, so nothing ever touches the gate.
            expect(run.gate).toEqual([]);
        });
});
