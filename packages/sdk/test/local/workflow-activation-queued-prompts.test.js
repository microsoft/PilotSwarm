/**
 * Workflows on demand, review coverage gap (runtime review of 91def26a): a person's prompt and another agent's prompt arrive
 * while enable_workflows turns Workflows on. The activation turn ends with its continuation (forceContinuePrompt), a
 * continue-as-new; the next execution runs the continuation once, then each queued prompt once, in the order they came
 * (a person's words and another session's message are two turns, FU-9).
 *
 * The activation turn is a real ManagedSession running enable_workflows (a scripted fake CLI session); the orchestration
 * is the real run loop (createRuntime, runLoop) against a fake durable context: a Map for KV (it survives the
 * continue-as-new), a message list for the durable queue (it survives it too), and a clock that moves only when a timer
 * wins a race. The second execution starts from the input the continue-as-new carried.
 *
 * Run: npx vitest run test/local/workflow-activation-queued-prompts.test.js
 */
import { describe, expect, it, vi } from "vitest";
import { createRuntime, runLoop } from "../../src/orchestration/runtime.ts";
import { ManagedSession } from "../../src/managed-session.ts";
import { sendInternalSessionMessage, resetSessionMessageRateLimitsForTests } from "../../src/session-messages.ts";

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: (ctx, sessionId, affinity, config, contract) => ctx.proxy("session", contract),
    createSessionManagerProxy: (ctx, contract) => ctx.proxy("manager", contract),
}));

/**
 * A fake CLI session whose model calls enable_workflows, then tries to go on. `calls` > 1: the model asked for it more than
 * once in one response, which the CLI runs at the same time (seen with CLI 1.0.83).
 */
class ActivationSession {
    constructor(calls = 1) { this.calls = calls; }
    sessionId = "activation-owner";
    registeredTools = [];
    catchAll = [];
    listeners = new Map();
    results = [];
    rpc = { tasks: { list: vi.fn(async () => ({ tasks: [] })), cancel: vi.fn(async () => {}), remove: vi.fn(async () => {}) } };
    registerTools(tools) { this.registeredTools = tools; }
    on(type, handler) {
        if (typeof type === "function") { this.catchAll.push(type); return () => {}; }
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
        return () => {};
    }
    emit(type, data = {}) {
        for (const handler of this.catchAll) handler({ type, data });
        for (const handler of this.listeners.get(type) ?? []) handler({ data });
    }
    async send() {
        queueMicrotask(async () => {
            const tool = this.registeredTools.find(item => item.name === "enable_workflows");
            this.results.push(...await Promise.all(Array.from({ length: this.calls }, () => tool.handler({}, { sessionId: this.sessionId }))));
            this.emit("assistant.message", { content: "Turning Workflows on." });
            this.emit("session.idle");
        });
    }
    abort() {}
    async disconnect() {}
}

/** The activation turn's result, as ManagedSession returns it. */
async function activationTurnResult(calls = 1) {
    let saved = false;
    const enableWorkflows = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        const changed = !saved;
        saved = true;
        return { changed, revision: 1 };
    });
    const session = new ActivationSession(calls);
    const managed = new ManagedSession(session.sessionId, session, { workflowContext: "off", nativeSubagents: "sync",
        capabilityServices: { use: vi.fn(), search: vi.fn(), load: vi.fn(), list: vi.fn(), enableWorkflows } });
    const result = await managed.runTurn("watch the build every minute");
    return { result, enableWorkflows, session };
}

function durableContext() {
    const kv = new Map();
    const messages = [];
    const calls = [];
    const turns = [];
    const results = [];
    const clock = { now: 1_750_000_000_000 };
    let guid = 0;
    const ctx = {
        traceInfo() {},
        traceWarn() {},
        traceError() {},
        setCustomStatus() {},
        getValue: key => kv.get(key) ?? null,
        setValue: (key, value) => { kv.set(key, value); },
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
    function resolve(effect) {
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
                    if (messages.length) return { index: 0, value: JSON.stringify(messages.shift()) };
                    clock.now += effect.right.ms;
                    return { index: 1 };
                }
                throw new Error(`unexpected race: ${JSON.stringify(effect)}`);
            case "session.runTurn": {
                turns.push(effect.args);
                if (!results.length) throw new Error(`unexpected turn: ${String(effect.args[0]).slice(0, 80)}`);
                const next = results.shift();
                return typeof next === "function" ? next() : next;
            }
            case "manager.listChildSessions": return JSON.stringify([]);
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
        for (let step = 0; step < 2000; step++) {
            const next = failure ? gen.throw(failure) : gen.next(value);
            failure = undefined;
            if (next.done) return next.value;
            try { value = resolve(next.value); } catch (error) { failure = error; }
        }
        throw new Error("generator exceeded bound");
    }
    /** One execution: its run loop until it parks (a blocking dequeue, a long timer, or a continue-as-new). */
    function execution(input) {
        const runtime = drive(createRuntime(ctx, input, { currentVersion: "1.0.83", latestVersion: "1.0.83" }));
        const gen = runLoop(runtime);
        let value;
        let failure;
        for (let n = 0; n < 4000; n++) {
            const next = failure ? gen.throw(failure) : gen.next(value);
            failure = undefined;
            if (next.done) return { parked: "done", runtime };
            const effect = next.value;
            if (effect?.effect === "race" && effect.left?.effect === "dequeue" && !messages.length && effect.right?.ms >= 1000) {
                return { parked: "timer", runtime };
            }
            if (effect?.effect === "dequeue" && !messages.length) return { parked: "blocking", runtime };
            if (effect?.effect === "can") return { parked: "can", input: effect.input, runtime };
            try { value = resolve(effect); } catch (error) { failure = error; }
        }
        throw new Error("run loop did not park");
    }
    return { kv, messages, calls, turns, results, execution };
}

describe("enable_workflows with prompts that arrive during activation (review coverage gap)", () => {
    for (const calls of [1, 2]) it(`the continuation runs once, then the person's prompt and the agent's prompt, each once, in order${calls > 1 ? " (enable_workflows twice in one response)" : ""}`, async () => {
        const { result: activation, enableWorkflows, session } = await activationTurnResult(calls);
        expect(activation.forceContinuePrompt).toMatch(/^Workflows are now on in this session/);
        // Another session's message, as send_session_message enqueues it (its sender stamped).
        resetSessionMessageRateLimitsForTests();
        const agentMessages = [];
        await sendInternalSessionMessage({
            catalog: { getSession: async id => ({ sessionId: id, title: id === "peer" ? "Peer session" : "This session", state: "running" }) },
            duroxideClient: { enqueueEvent: async (_i, _q, payload) => { agentMessages.push(JSON.parse(payload)); }, getStatus: async () => ({ status: "Running" }) },
        }, { fromSessionId: "peer", toSessionId: "activation-owner", subject: "status", body: "AGENT-WORDS from the peer session" });
        expect(agentMessages).toHaveLength(1);

        const d = durableContext();
        // The activation turn: while it runs, the person's prompt, then the agent's, reach the durable queue.
        d.results.push(() => {
            d.messages.push({ prompt: "PERSON-WORDS: also check the deploy", clientMessageIds: ["person-1"] }, agentMessages[0]);
            return activation;
        });
        const first = d.execution({ sessionId: "activation-owner", config: {}, iteration: 0, isSystem: false, blobEnabled: false,
            prompt: "watch the build every minute", clientMessageIds: ["person-0"] });
        expect(first.parked).toBe("can");
        expect(d.turns).toHaveLength(1);
        expect(first.input.prompt).toBe(activation.forceContinuePrompt);

        // The next execution, from the carried input: the continuation, then the two queued prompts.
        for (let i = 0; i < 3; i++) d.results.push({ type: "completed", content: `answer ${i + 1}` });
        const second = d.execution(first.input);
        expect(second.parked).not.toBe("can");
        const prompts = d.turns.slice(1).map(args => String(args[0]));
        expect(prompts).toHaveLength(3);
        const count = text => prompts.filter(prompt => prompt.includes(text)).length;
        expect(count("Workflows are now on in this session")).toBe(1);
        expect(count("PERSON-WORDS")).toBe(1);
        expect(count("AGENT-WORDS")).toBe(1);
        const at = text => prompts.findIndex(prompt => prompt.includes(text));
        expect(at("Workflows are now on in this session")).toBe(0);
        expect(at("PERSON-WORDS")).toBeGreaterThan(at("Workflows are now on in this session"));
        expect(at("AGENT-WORDS")).toBeGreaterThan(at("PERSON-WORDS"));
        // FU-9: the person's words and the other session's message are two turns.
        expect(prompts[at("PERSON-WORDS")]).not.toContain("AGENT-WORDS");
        expect(d.messages).toEqual([]);
        expect(d.results).toEqual([]);
        // One activation: one save, one {"workflows":"on"} answer, no second continuation carried as a queued action.
        expect(enableWorkflows).toHaveBeenCalledOnce();
        expect(session.results.filter(text => String(text).startsWith('{"workflows":"on"}'))).toHaveLength(1);
        expect(activation.queuedActions ?? []).toEqual([]);
    });
});
