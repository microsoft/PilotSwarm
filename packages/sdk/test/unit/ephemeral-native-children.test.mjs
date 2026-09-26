import test from "node:test";
import assert from "node:assert/strict";
import { EphemeralNativeChildren, validateNativeChildren } from "../../dist/ephemeral-native-children.js";
import { EphemeralUsageAccumulator } from "../../dist/ephemeral-usage.js";
import { EphemeralModelRecovery, isRecoverableRateLimit } from "../../dist/ephemeral-model-recovery.js";

const options = (count = 21) => ({ maxConcurrent: 20, assignments: Array.from({ length: count }, (_, i) =>
    ({ id: `batch-${i}`, sessionRefs: [`s${i}`] })), progressStages: ["reading", "classifying"] });
const task = i => ({ name: `batch-${i}`, mode: "background", agent_type: "swarm-task", prompt: "work", description: "Work" });
const model = { model: "model", reasoningEffort: "medium", contextTier: "long_context" };
const started = i => ({ id: `start-${i}`, type: "subagent.started", agentId: `child-${i}`,
    data: { agentDisplayName: `batch-${i}`, agentName: "swarm-task", toolCallId: `call-${i}`, executionMode: "background", model: "model" } });
const complete = i => ({ id: `complete-${i}`, type: "subagent.completed", agentId: `child-${i}`, data: { toolCallId: `call-${i}` } });

test("native rate-limit recovery requires matching telemetry and recoverable hook, with two retries per session", () => {
    const policy = new EphemeralModelRecovery("root");
    const hook = { sessionId: "child", errorContext: "model_call", recoverable: true };
    const failure = i => ({ type: "model.call_failure", id: `failure-${i}`, agentId: "child",
        data: { statusCode: 429, failureKind: "api" } });
    assert.equal(policy.decide(hook).errorHandling, "abort");
    for (let i = 0; i < 3; i++) {
        policy.observe(failure(i));
        policy.observe({ type: "assistant.usage", id: `failed-usage-${i}`, agentId: "child", data: {} });
        policy.observe({ type: "model.call_finished", id: `failed-dispatch-${i}`, agentId: "child", data: { outcome: "error" } });
        assert.equal(policy.decide(hook).errorHandling, i < 2 ? "retry" : "abort");
        policy.observe(failure(i));
        assert.equal(policy.decide(hook).errorHandling, "abort");
    }
    policy.observe({ ...failure("other"), agentId: "other" });
    assert.equal(policy.decide({ ...hook, sessionId: "other" }).errorHandling, "retry");
    policy.observe({ type: "model.call_finished", id: "parent-success", data: { outcome: "success" } });
    policy.observe(failure("still-exhausted"));
    assert.equal(policy.decide(hook).errorHandling, "abort");
    policy.observe({ type: "model.call_finished", id: "success", agentId: "child", data: { outcome: "success" } });
    policy.observe(failure(3));
    assert.deepEqual(policy.decide(hook), { errorHandling: "retry", retryCount: 1, suppressOutput: true });
    policy.observe(failure(4));
    assert.equal(policy.decide({ ...hook, recoverable: false }).errorHandling, "abort");
    policy.observe(failure(5));
    assert.equal(policy.decide({ ...hook, sessionId: "foreign" }).errorHandling, "abort");
    policy.stop();
    assert.equal(policy.decide(hook).errorHandling, "abort");
    policy.observe(failure(6));
    assert.equal(policy.decide(hook).errorHandling, "abort");
    assert.equal(isRecoverableRateLimit({ ...failure(0), data: { statusCode: 401, failureKind: "api" } }), false);
    assert.equal(isRecoverableRateLimit({ ...failure(0), data: { statusCode: 429, failureKind: "network" } }), false);
    const other = new EphemeralModelRecovery("root");
    other.observe({ ...failure(0), agentId: undefined });
    assert.equal(other.decide({ ...hook, sessionId: "root" }).errorHandling, "retry");
    other.observe({ ...failure(1), data: { statusCode: 401, failureKind: "api" } });
    assert.equal(other.decide(hook).errorHandling, "abort");
});

test("strict opt-in copies host assignments and rejects invalid or overlapping authority", () => {
    assert.equal(validateNativeChildren(undefined, undefined), undefined);
    const original = options(), copy = validateNativeChildren(original, async () => {});
    original.assignments[0].sessionRefs.push("changed");
    assert.deepEqual(copy.assignments[0].sessionRefs, ["s0"]);
    for (const change of [{ maxConcurrent: 0 }, { maxConcurrent: 21 }, { maxConcurrent: 1.5 }, { assignments: [] },
        { progressStages: [] }, { progressStages: ["x", "x"] }, { extra: true },
        { assignments: [{ id: "a", sessionRefs: ["x"] }, { id: "b", sessionRefs: ["x"] }] },
        { assignments: [{ id: "a", sessionRefs: ["x", "x"] }] },
        { assignments: [{ id: "a", sessionRefs: ["x"] }, { id: "a", sessionRefs: ["y"] }] }]) {
        assert.throws(() => validateNativeChildren({ ...options(), ...change }, async () => {}), { code: "EPHEMERAL_INVALID_REQUEST" });
    }
    assert.throws(() => validateNativeChildren(options(), undefined), { code: "EPHEMERAL_INVALID_REQUEST" });
});

test("atomic reservations enforce twenty, reject duplicates, and admit remaining work after completion", async () => {
    const children = new EphemeralNativeChildren(options());
    const admissions = await Promise.all(Array.from({ length: 21 }, (_, i) => Promise.resolve(children.reserve(task(i), 1))));
    assert.equal(admissions.filter(value => value === undefined).length, 20);
    assert.match(admissions[20], /capacity/);
    assert.match(children.reserve(task(0), 1), /already/);
    assert.match(children.reserve({ ...task(20), name: "foreign" }, 1), /assigned/);
    for (let i = 0; i < 20; i++) children.observe(started(i), model);
    children.observe(complete(0), model);
    assert.equal(children.reserve(task(20), 1), undefined);
    children.observe(started(20), model);
    for (let i = 1; i < 21; i++) children.observe(complete(i), model);
    children.assertComplete();
});

test("progress trusts runtime identity, rejects spoofing, duplicates and regression, and is cumulative", () => {
    const children = new EphemeralNativeChildren({ ...options(1), assignments: [{ id: "batch-0", sessionRefs: ["s0", "s1"] }] });
    children.reserve(task(0), 3); children.observe(started(0), model);
    const value = { stage: "classifying", completedSessionRefs: ["s0"] };
    assert.equal(children.progress("parent", value), undefined);
    assert.equal(children.progress("child-0", { ...value, assignmentId: "batch-0" }), undefined);
    assert.equal(children.progress("child-0", { ...value, completedSessionRefs: ["foreign"] }), undefined);
    assert.deepEqual({ ...children.progress("child-0", value), updatedAt: null }, {
        assignmentId: "batch-0", childId: "child-0", sequence: 1, iteration: 3,
        ...value, updatedAt: null,
    });
    assert.equal(children.progress("child-0", value), undefined);
    assert.equal(children.progress("child-0", { ...value, stage: "reading" }), undefined);
    assert.equal(children.progress("child-0", { ...value, completedSessionRefs: [] }), undefined);
    assert.equal(children.progress("child-0", { ...value, completedSessionRefs: ["s0", "s0"] }), undefined);
    assert.equal(children.progress("child-0", { ...value, completedSessionRefs: ["s0", "s1"] }).sequence, 2);
    children.observe(complete(0), model);
    assert.equal(children.progress("child-0", value), undefined);
});

test("receipt reads bind from the native registry before start, but progress waits for the matching start event", () => {
    const children = new EphemeralNativeChildren(options(1));
    children.reserve(task(0), 1);
    const nativeTask = { type: "agent", id: "child-0", displayName: "batch-0", toolCallId: "call-0",
        agentType: "swarm-task", executionMode: "background", model: "model", resolvedModel: "model", status: "running" };
    assert.equal(children.authorizeRead("unknown", [nativeTask], "model"), false);
    for (const patch of [{ displayName: "foreign" }, { model: "foreign" }, { resolvedModel: "foreign" },
        { agentType: "other" }, { executionMode: "sync" }]) {
        assert.equal(children.authorizeRead("child-0", [{ ...nativeTask, ...patch }], "model"), false);
    }
    assert.equal(children.authorizeRead("child-0", [nativeTask], "model"), true);
    assert.equal(children.progress("child-0", { stage: "classifying", completedSessionRefs: ["s0"] }), undefined);
    children.observe(started(0), model);
    assert.equal(children.authorizeRead("child-0", [nativeTask], "model"), true);
    assert.equal(children.progress("child-0", { stage: "classifying", completedSessionRefs: ["s0"] }).assignmentId, "batch-0");
    assert.throws(() => children.authorizeRead("different", [{ ...nativeTask, id: "different" }], "model"), { code: "EPHEMERAL_CHILDREN_FAILED" });
    for (const event of [
        { ...started(0), agentId: "different" },
        { ...started(0), data: { ...started(0).data, toolCallId: "different" } },
    ]) {
        const early = new EphemeralNativeChildren(options(1));
        assert.equal(early.authorizeRead("child-0", [nativeTask], "model"), false);
        early.reserve(task(0), 1);
        assert.equal(early.authorizeRead("child-0", [nativeTask], "model"), true);
        assert.throws(() => early.observe(event, model), { code: "EPHEMERAL_CHILDREN_FAILED" });
    }
});

test("missing, cancelled, unknown and model-changed children fail closed", () => {
    const make = () => { const children = new EphemeralNativeChildren(options(1)); children.reserve(task(0), 1); return children; };
    assert.throws(() => make().assertComplete(), { code: "EPHEMERAL_CHILDREN_FAILED" });
    assert.throws(() => make().observe(started(1), model), { code: "EPHEMERAL_CHILDREN_FAILED" });
    const children = make(); children.observe(started(0), model);
    children.observe(started(0), model);
    assert.throws(() => children.observe({ ...complete(0), data: { toolCallId: "call-0", cancelled: true } }, model),
        { code: "EPHEMERAL_CHILDREN_FAILED" });
    assert.throws(() => children.observe({ id: "config", type: "subagent.configured", agentId: "child-0",
        data: { model: "model", reasoningEffort: "low", contextTier: "long_context" } }, model), { code: "EPHEMERAL_MODEL_CHANGED" });
});

test("usage identity collisions are isolated per child and duplicate observations are counted once", () => {
    const usage = new EphemeralUsageAccumulator(true);
    for (const agentId of [undefined, "a", "b"]) {
        const event = { type: "assistant.usage", id: "same-event", agentId, data: {
            apiCallId: "same-call", providerCallId: "same-trace", inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
        } };
        usage.observe(event); usage.observe(event);
    }
    assert.equal(usage.snapshot().usage.apiCalls, 3);
    assert.equal(usage.snapshot().usage.inputTokens, 60);
    usage.observe({ type: "model.call_failure", id: "failed", agentId: "failed-child", data: { apiCallId: "same-call" } });
    assert.equal(usage.snapshot().usage.apiCalls, 4);
    assert.equal(usage.snapshot().usage.inputTokens, null);
    assert.equal(usage.snapshot().usageDiagnostics.observedApiCalls, 4);
});

// CLI 1.0.85 replays a completion for an already-finished child during teardown,
// flagged cancelled, under a fresh event id. That replay carries no new
// information, so it must not be read as a cancelled assignment -- but a
// cancelled FIRST completion, or a replay bound to a different tool call, still
// fails closed.
test("a post-completion teardown replay is absorbed, but only for the bound tool call", () => {
    const make = () => { const children = new EphemeralNativeChildren(options(1)); children.reserve(task(0), 1);
        children.observe(started(0), model); children.observe(complete(0), model); return children; };

    const children = make();
    children.observe({ ...complete(0), id: "teardown", data: { toolCallId: "call-0", cancelled: true } }, model);
    children.assertComplete();

    assert.throws(() => make().observe({ ...complete(0), id: "teardown", data: { toolCallId: "other", cancelled: true } }, model),
        { code: "EPHEMERAL_CHILDREN_FAILED" });

    const late = new EphemeralNativeChildren(options(1)); late.reserve(task(0), 1); late.observe(started(0), model);
    assert.throws(() => late.observe({ ...complete(0), data: { toolCallId: "call-0", cancelled: true } }, model),
        { code: "EPHEMERAL_CHILDREN_FAILED" });
});
