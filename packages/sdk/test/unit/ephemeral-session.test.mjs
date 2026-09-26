import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, readdir, stat, symlink, writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import path from "node:path";
import { createEphemeralSessionRunner, ephemeralInvocationId, EPHEMERAL_LOCAL_TOOLS } from "../../dist/ephemeral-session.js";
import { RESET_TOOL, RESET_SEED, RESET_ATTEMPTS } from "../../dist/ephemeral-context-reset.js";
import { EphemeralUsageAccumulator, emptyUsageDiagnostics, sumUsageDiagnostics } from "../../dist/ephemeral-usage.js";
import { createEphemeralScratch, removeEphemeralScratch } from "../../dist/ephemeral-scratch.js";
import { EphemeralFilesystem } from "../../dist/ephemeral-filesystem.js";
import { loadProviderTypes } from "../../dist/provider-catalog.js";
import { HostEphemeralLifecycle } from "../../dist/host-services.js";
import { ProviderStore } from "../../dist/provider-store.js";

const actor = { provider: "fixture", subject: "owner" };
const metric = { inputTokens: 100, outputTokens: 11, cacheReadTokens: 30, cacheWriteTokens: 10 };
const event = (type, data = {}, extra = {}) => ({ type, data, id: randomUUID(), parentId: null, timestamp: new Date().toISOString(), ...extra });
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

async function fixture(t, options = {}) {
    const root = path.resolve(`.ephemeral-unit-${randomUUID()}`), cwd = path.join(root, "workspace"), scratchRoot = path.join(root, "sdk");
    await mkdir(root, { mode: 0o700 }); await mkdir(cwd, { mode: 0o700 }); await mkdir(scratchRoot, { mode: 0o700 });
    t.after(() => rm(root, { recursive: true, force: true }));
    const types = loadProviderTypes({ providers: [{
        id: "template", type: options.type ?? "openai", baseUrl: "https://synthetic.invalid/v1",
        apiKey: "unrelated-template-secret", models: [{ name: "model", supportedReasoningEfforts: ["medium", "max"],
            defaultReasoningEffort: "medium", supportedContextTiers: ["default", "long_context"],
            contextWindowSizes: { default: 128000, long_context: 1000000 } }, "plain"],
    }] });
    const selected = { actorUserId: 17, role: "user", credential: {
        name: "selected", typeId: "template", class: "shared", ownerUserId: null, baseUrl: null,
        secretRef: { value: "selected-synthetic-key" },
    } };
    const calls = [], updates = [], captured = {
        recoveryGated: false, recoveryGates: [], recoveryOnSend: [], recoveryOnClear: [],
    }, diagnostics = [];
    const store = {
        async lookupUserId(principal) {
            calls.push("identity");
            assert.deepEqual(principal, options.actor ?? actor);
            return selected.actorUserId;
        },
        async getCredential(name, viewer) {
            calls.push("credential");
            assert.equal(viewer, selected.actorUserId);
            return name === "selected" ? structuredClone(selected.credential) : null;
        },
    };
    const catalog = {
        providers: new Proxy(store, { get(target, name) {
            assert.ok(["lookupUserId", "getCredential"].includes(name), `Unexpected provider accounting access: ${String(name)}`);
            return target[name];
        } }),
        async getUserRole(principal) { assert.deepEqual(principal, options.actor ?? actor); return { role: selected.role }; },
    };
    let sendCount = 0, registry = types;
    const behavior = options.behavior ?? {};
    const deps = {
        scratchRoot, diagnostic: value => diagnostics.push(value),
        createClient(clientOptions) {
            calls.push("client"); captured.clientOptions = clientOptions;
            return {
                async getStatus() { return { version: behavior.version ?? "1.0.85" }; },
                async createSession(config) {
                    calls.push("create"); captured.config = config;
                    await behavior.create?.(config);
                    return {
                        sessionId: config.sessionId,
                        async setModelRecoveryGate(gated) {
                            captured.recoveryGates.push(gated);
                            captured.recoveryGated = gated;
                            calls.push(gated ? "gate:closed" : "gate:open");
                            return true;
                        },
                        rpc: {
                            options: { update: async value => { captured.patch = value; return { success: true }; } },
                            tools: { initializeAndValidate: async () => {}, getCurrentMetadata: async () => ({
                                tools: behavior.tools ?? [...EPHEMERAL_LOCAL_TOOLS, "task"].map(name => ({ name })),
                            }) },
                            model: { getCurrent: async () => ({ modelId: behavior.model ?? config.model,
                                reasoningEffort: config.reasoningEffort, contextTier: config.contextTier }) },
                            history: { cancelBackgroundCompaction: async () => ({ cancelled: Boolean(behavior.lateCompaction) }),
                                clearContext: async input => {
                                    captured.recoveryOnClear.push(captured.recoveryGated);
                                    calls.push("clearContext"); captured.cleared = (captured.cleared ?? []).concat(input);
                                    if (behavior.clearContext) return behavior.clearContext(config, input);
                                    config.onEvent(event("session.context_cleared",
                                        { messagesCleared: 4, initialMessage: input.prompt }));
                                    return { messagesCleared: 4 };
                                } },
                            tasks: { list: async () => ({ tasks: [] }), cancel: async () => {}, remove: async () => {},
                                waitForPending: async () => { await behavior.drain?.(config); }, ...behavior.tasks },
                        },
                        async send(message) {
                            captured.recoveryOnSend.push(captured.recoveryGated);
                            calls.push("send"); sendCount++; captured.message = message;
                            if (behavior.send) return behavior.send(config, message, sendCount);
                            config.onEvent(event("assistant.usage", { apiCallId: `call-${sendCount}`, ...metric }));
                            config.onEvent(event("assistant.message", { messageId: `answer-${sendCount}`, content: "Synthetic answer." }));
                            config.onEvent(event("session.idle")); return "submitted";
                        },
                        async abort() { calls.push("abort"); await behavior.abort?.(); },
                    };
                },
                async stop() { calls.push("stop"); return behavior.stopErrors ?? []; },
                async forceStop() { calls.push("forceStop"); await behavior.forceStop?.(); },
            };
        },
        ...options.deps,
    };
    const run = createEphemeralSessionRunner(catalog, () => registry, deps);
    const request = change => ({ actor: options.actor ?? actor, executionId: "execution", model: "selected:model",
        workingDirectory: cwd, systemMessage: "Synthetic system.", prompt: "Synthetic prompt.",
        onUsage: async update => updates.push(update), onResponse: async () => ({ action: "complete" }), ...change });
    return { run, request, store, selected, calls, updates, captured, diagnostics, root, cwd, scratchRoot,
        behavior, types, setTypes(value) { registry = value; } };
}

test("cleanup events retain terminal usage without rearming turn or inactivity deadlines", async t => {
    const set = globalThis.setTimeout, clear = globalThis.clearTimeout, deadlines = new Set();
    t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
        const timer = set(callback, ms, ...args);
        if (ms === 60_000) deadlines.add(timer);
        return timer;
    });
    t.mock.method(globalThis, "clearTimeout", timer => { deadlines.delete(timer); clear(timer); });
    t.after(() => { for (const timer of deadlines) clear(timer); });
    let config;
    const f = await fixture(t, { deps: { turnTimeoutMs: 60_000, turnInactivityTimeoutMs: 60_000 }, behavior: {
        async send(value) {
            config = value;
            config.onEvent(event("assistant.turn_start"));
            throw new Error("Synthetic invocation failure.");
        },
        async abort() { config.onEvent(event("assistant.usage", { apiCallId: "late", ...metric })); },
        async forceStop() { config.onEvent(event("assistant.usage", { apiCallId: "late", ...metric })); },
    } });
    await assert.rejects(f.run(f.request({
        nativeChildren: { maxConcurrent: 1, assignments: [{ id: "batch", sessionRefs: ["s0"] }], progressStages: ["classifying"] },
        onChildProgress: async () => {},
    })), { code: "EPHEMERAL_INVOCATION_FAILED" });
    assert.equal(f.updates.at(-1).usageDiagnostics.observedApiCalls, 1);
    assert.equal(f.updates.at(-1).usageUncertain, true);
    assert.equal(deadlines.size, 0, "Cleanup events must not leave a host deadline alive.");
});

for (const outcome of ["complete", "missing", "running", "cancelled", "failed", "timeout", "callback"]) {
    test(`parallel children ${outcome}: validation cannot precede drain and cleanup retains partial usage`, async t => {
        const taskStates = [], calls = [], progress = [];
        let config, finalUsage;
        const f = await fixture(t, { deps: outcome === "timeout" ? { turnTimeoutMs: 30 } : {}, behavior: {
            async send(value) {
                config = value;
                const admission = await config.hooks.onPreToolUse({ toolName: "task", sessionId: config.sessionId, toolArgs: {
                    agent_type: "swarm-task", mode: "background", name: "batch", prompt: "work", description: "Work",
                } }, { sessionId: config.sessionId });
                assert.equal(admission.modifiedArgs.model, "model");
                if (outcome !== "missing") {
                    taskStates.push({ id: "child", type: "agent", status: "running" });
                    config.onEvent(event("subagent.started", { agentDisplayName: "batch", agentName: "swarm-task",
                        toolCallId: "task-call", executionMode: "background", model: "model" }, { agentId: "child" }));
                }
                config.onEvent(event("assistant.usage", { apiCallId: "call", ...metric }));
                config.onEvent(event("assistant.message", { messageId: "answer", content: "Premature answer." }));
                config.onEvent(event("session.idle"));
            },
            async drain() {
                calls.push("drain");
                if (outcome === "timeout") { await new Promise(() => {}); return; }
                if (outcome === "missing" || outcome === "running") return;
                config.onEvent(event("assistant.usage", { apiCallId: "call", ...metric }, { agentId: "child" }));
                if (outcome === "callback") {
                    await config.hooks.onPreToolUse({ toolName: "ephemeral_report_child_progress", sessionId: "child",
                        toolArgs: { stage: "classifying", completedSessionRefs: ["s0"] } }, { sessionId: config.sessionId });
                    return;
                }
                taskStates[0].status = outcome === "complete" ? "idle" : outcome;
                config.onEvent(event(outcome === "failed" ? "subagent.failed" : "subagent.completed",
                    { toolCallId: "task-call", ...(outcome === "cancelled" ? { cancelled: true } : {}) }, { agentId: "child" }));
                if (outcome === "complete") {
                    config.onEvent(event("assistant.turn_start"));
                    config.onEvent(event("assistant.message", { messageId: "final", content: "Drained answer." }));
                    config.onEvent(event("session.idle"));
                }
            },
            tasks: {
                list: async () => ({ tasks: taskStates.slice() }),
                cancel: async ({ id }) => { calls.push("cancel"); taskStates.find(task => task.id === id).status = "cancelled"; },
                remove: async ({ id }) => { calls.push("remove"); taskStates.splice(taskStates.findIndex(task => task.id === id), 1); },
            },
        } });
        const run = f.run(f.request({ nativeChildren: { maxConcurrent: 20, assignments: [{ id: "batch", sessionRefs: ["s0"] }],
            progressStages: ["classifying"] },
            onChildProgress: async value => { progress.push(value); throw new Error("synthetic callback"); },
            onUsage: async value => { finalUsage = value; },
            onResponse: async response => { calls.push("validate"); assert.ok(response.text.endsWith("Drained answer."));
                assert.deepEqual(taskStates, []); return { action: "complete" }; },
        }));
        if (outcome === "complete") {
            const result = await run;
            assert.equal(result.usage.apiCalls, 2);
            assert.deepEqual(calls, ["drain", "cancel", "remove", "validate"]);
        } else {
            await assert.rejects(run, { code: outcome === "timeout" ? "EPHEMERAL_ABORTED"
                : outcome === "callback" ? "EPHEMERAL_CALLBACK_FAILED" : "EPHEMERAL_CHILDREN_FAILED" });
            assert.equal(calls.includes("validate"), false);
            assert.equal(finalUsage.completed, false);
            assert.equal(finalUsage.usageUncertain, true);
        }
        assert.deepEqual(taskStates, []);
        assert.ok(f.calls.includes("forceStop"));
        assert.deepEqual(await readdir(f.scratchRoot), []);
    });
}

test("one session reuses context across five repairs with caller-only usage and read-only credential access", async t => {
    const f = await fixture(t), responses = [], updates = [];
    const result = await f.run(f.request({
        onResponse: async response => { responses.push(response); return response.iteration < 6
            ? { action: "continue", prompt: `repair ${response.iteration}` } : { action: "complete" }; },
        onUsage: async update => updates.push(update),
    }));
    assert.equal(result.turnCount, 6);
    assert.equal(result.usage.inputTokens, 600);
    assert.equal(result.usage.apiCalls, 6);
    assert.equal(result.usageUncertain, false);
    assert.deepEqual(result.usageDiagnostics, { ...emptyUsageDiagnostics(), observedApiCalls: 6 });
    assert.deepEqual(responses.map(response => response.usageDiagnostics.observedApiCalls), [1, 1, 1, 1, 1, 1]);
    assert.ok(updates.filter(update => update.completed).every(update =>
        update.usageDiagnostics.observedApiCalls === 1 && update.usageDiagnostics.apiCallCountReasons.length === 0));
    assert.equal(f.calls.filter(call => call === "create").length, 1);
    assert.deepEqual(updates.filter(update => update.completed).map(row => row.invocationId),
        Array.from({ length: 6 }, (_, i) => ephemeralInvocationId("execution", i + 1)));
    assert.deepEqual(responses.map(response => response.iteration), [1, 2, 3, 4, 5, 6]);
    assert.equal(updates.filter(update => update.completed).length, 6);
    assert.equal(new Set(updates.map(update => update.invocationId)).size, 6);
    assert.deepEqual(await readdir(f.scratchRoot), []);
    assert.ok(f.calls.includes("forceStop"));
});

test("private environment and configuration do not inherit credentials, plugins or ordinary persistence", async t => {
    const f = await fixture(t);
    await f.run(f.request({ reasoningEffort: "max", contextTier: "long_context" }));
    const { config, clientOptions } = f.captured;
    assert.equal(config.provider.apiKey, "selected-synthetic-key");
    assert.equal(config.modelCapabilities.limits.max_prompt_tokens, 1000000);
    assert.equal(clientOptions.logLevel, "none");
    assert.equal(clientOptions.useLoggedInUser, false);
    assert.equal(clientOptions.workingDirectory, f.cwd);
    for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "NODE_OPTIONS", "COPILOT_HOME", "COPILOT_CLI_PATH",
        "AZURE_CLIENT_ID", "OTEL_EXPORTER_OTLP_ENDPOINT", "ANTHROPIC_API_KEY", "DATABASE_URL"]) assert.equal(clientOptions.env[name], undefined);
    for (const key of ["enableSessionStore", "enableConfigDiscovery", "enableSessionTelemetry", "enableFileHooks",
        "enableHostGitOperations", "enableSkills", "enableMcpApps", "manageScheduleEnabled", "enableFileChangeTracking"]) assert.equal(config[key], false);
    for (const key of ["mcpServers"]) assert.deepEqual(config[key], {});
    for (const key of ["pluginDirectories", "skillDirectories", "instructionDirectories"]) assert.deepEqual(config[key], []);
    assert.equal(config.infiniteSessions.enabled, true);
    assert.deepEqual(config.largeOutput, { enabled: false });
    assert.equal(config.customAgents.length, 2);
});

test("an unqualified native runtime version refuses inference and reports zero usage", async t => {
    const f = await fixture(t, { behavior: { version: "1.0.84" } });
    await assert.rejects(f.run(f.request()), { code: "EPHEMERAL_RUNTIME_UNQUALIFIED" });
    assert.equal(f.calls.includes("create"), false);
    assert.equal(f.calls.includes("send"), false);
    // The gate reads the version through a started CLI, so rejection must still
    // stop and force-kill the owned process group rather than strand it.
    assert.ok(f.calls.includes("stop"));
    assert.ok(f.calls.includes("forceStop"));
    assert.equal(f.updates.at(-1).completed, false);
    assert.equal(f.updates.at(-1).usage.apiCalls, 0);
    assert.deepEqual(f.updates.at(-1).usageDiagnostics, emptyUsageDiagnostics());
    assert.deepEqual(await readdir(f.scratchRoot), []);
});

for (const type of ["github", "azure", "anthropic", "openai-proxy"]) test(`selected ${type} provider routing is preserved`, async t => {
    const f = await fixture(t, { type });
    await f.run(f.request());
    const { config, clientOptions } = f.captured;
    if (type === "github") {
        assert.equal(clientOptions.gitHubToken, "selected-synthetic-key");
        assert.equal(config.gitHubToken, "selected-synthetic-key"); assert.equal(config.provider, undefined);
    } else assert.equal(config.provider.type, type === "openai-proxy" ? "openai" : type);
});

test("actor and model validation rejects authority/credential/limit overrides before execution", async t => {
    const f = await fixture(t);
    for (const change of [
        { actor: { provider: "none", subject: "unknown" } }, { actor: { ...actor, isAdmin: true } },
        { model: "model" }, { model: "selected:missing" }, { reasoningEffort: "xhigh" }, { contextTier: "future" },
        { model: "selected:plain", reasoningEffort: "max" }, { tools: [] }, { provider: {} }, { maxCalls: 3 }, { signal: {} },
    ]) await assert.rejects(f.run(f.request(change)));
    assert.equal(f.calls.includes("client"), false);
});

test("authenticated actors can use their own credentials but not another owner's", async t => {
    const f = await fixture(t, { actor: { provider: "dev", subject: "ada" } });
    f.selected.credential.class = "personal"; f.selected.credential.ownerUserId = 17;
    await f.run(f.request());
    f.selected.credential.ownerUserId = 18;
    await assert.rejects(f.run(f.request({ executionId: "other" })), { code: "EPHEMERAL_MODEL_UNAVAILABLE" });
});

test("real provider store resolves existing identity and namespace without ledger, meter or spend admission SQL", async t => {
    const f = await fixture(t), queries = [];
    const providers = new ProviderStore({ async query(sql, params) {
        queries.push(sql);
        if (sql === 'SELECT "fixture".cms_provider_user_id($1, $2) AS user_id') {
            assert.deepEqual(params, ["fixture", "owner"]);
            return { rows: [{ user_id: 17 }] };
        }
        assert.equal(sql, 'SELECT * FROM "fixture".cms_provider_in_namespace($1, $2)');
        assert.deepEqual(params, ["selected", 17]);
        return { rows: [{
            name: "selected", type_id: "template", class: "personal", owner_user_id: 17,
            base_url: null, secret_ref: { value: "selected-synthetic-key" },
            hold_indefinite: true, allowance_pct: 0,
        }] };
    } }, "fixture");
    f.store.lookupUserId = providers.lookupUserId.bind(providers);
    f.store.getCredential = providers.getCredential.bind(providers);
    const result = await f.run(f.request({ onUsage: undefined }));
    assert.equal(result.usage.inputTokens, 100);
    assert.equal(result.usage.outputTokens, 11);
    assert.equal(result.usage.cacheReadTokens, 30);
    assert.equal(result.usage.cacheWriteTokens, 10);
    assert.equal(result.usage.apiCalls, 1);
    assert.equal(queries.length, 4);
    assert.equal(f.updates.length, 0);
});

test("credential removal/rotation, actor revocation and catalog changes refuse sends and repairs", async t => {
    for (const mode of ["missing-actor", "role", "key", "rotated-key", "catalog", "repair"]) {
        const f = await fixture(t);
        if (mode === "missing-actor") f.selected.actorUserId = null;
        if (mode === "role") f.behavior.create = () => { f.selected.role = "none"; };
        if (mode === "key") f.behavior.create = () => { f.store.getCredential = async () => null; };
        if (mode === "rotated-key") f.behavior.create = () => { f.selected.credential.secretRef.value = "rotated"; };
        if (mode === "catalog") f.behavior.create = () => f.setTypes(null);
        await assert.rejects(f.run(f.request({ onResponse: async () => {
            f.store.getCredential = async () => null;
            return { action: "continue", prompt: "repair" };
        } })), { code: "EPHEMERAL_MODEL_UNAVAILABLE" });
        assert.equal(f.calls.filter(call => call === "send").length, mode === "repair" ? 1 : 0);
        assert.deepEqual(await readdir(f.scratchRoot), []);
    }
});

test("repeated execution IDs run independently without persistent claims, including changed prompts", async t => {
    const f = await fixture(t);
    const results = await Promise.allSettled([f.run(f.request()), f.run(f.request())]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
    await f.run(f.request());
    await f.run(f.request({ prompt: "changed", onUsage: undefined }));
    assert.equal(f.calls.filter(call => call === "send").length, 4);
    assert.equal(new Set(f.updates.map(update => update.invocationId)).size, 1);
});

for (const changed of ["role", "key", "rotation", "catalog"]) test(
    `native task rechecks ${changed} and forbids detached work, native overrides and unsafe tools`, async t => {
    const f = await fixture(t, { behavior: { async send(config) {
        const hook = (toolName, toolArgs, child = false) => config.hooks.onPreToolUse(
            { toolName, toolArgs, sessionId: child ? "native" : config.sessionId }, { sessionId: config.sessionId });
        for (const [name, args, child] of [["spawn_agent", {}, false], ["web_fetch", {}, false],
            ["report_progress", {}, false], ["bash", { mode: "async" }, false], ["bash", { detach: true }, true],
            ["task", { agent_type: "swarm-task", mode: "background" }, false], ["task", { agent_type: "swarm-task", model: "other" }, false],
            ["task", { agent_type: "swarm-task", reasoning_effort: "low" }, false], ["task", { agent_type: "swarm-task" }, true]]) {
            assert.equal((await hook(name, args, child)).permissionDecision, "deny");
        }
        const accepted = await hook("task", { agent_type: "swarm-task", prompt: "safe" });
        assert.equal(accepted.modifiedArgs.mode, "sync"); assert.equal(accepted.modifiedArgs.model, "model");
        if (changed === "role") f.selected.role = "none";
        if (changed === "key") f.store.getCredential = async () => null;
        if (changed === "rotation") f.selected.credential.secretRef.value = "rotated-key";
        if (changed === "catalog") f.setTypes(null);
        await hook("task", { agent_type: "swarm-task" });
    } } });
    await assert.rejects(f.run(f.request()), { code: "EPHEMERAL_MODEL_UNAVAILABLE" });
    assert.ok(f.calls.includes("abort"));
});

test("progress is closed, parent-only, serialized and SDK-stamped before response", async t => {
    const received = [];
    const f = await fixture(t, { behavior: { async send(config) {
        const progress = config.tools[0];
        const invoke = (data, sessionId = config.sessionId) => progress.handler(data, { sessionId });
        for (const data of [{ stage: "secret" }, { stage: "reading", message: "private-canary" },
            { stage: "reading", completed: -1 }, { stage: "reading", completed: null }, { stage: "reading", completed: 2, total: 1 },
            { stage: "reading", total: NaN }, { stage: "reading", sequence: 99 }]) {
            assert.match(await invoke(data), /^Invalid progress/);
        }
        assert.equal(await invoke({ stage: "reading" }, "native-child"), "Progress unavailable.");
        await invoke({ stage: "reading", completed: 1, total: null });
        assert.equal(received.length, 1);
        config.onEvent(event("assistant.usage", { apiCallId: "call", ...metric }));
        config.onEvent(event("assistant.message", { content: "done" }));
        config.onEvent(event("session.idle"));
        assert.equal(await invoke({ stage: "reading" }), "Progress unavailable.");
    } } });
    await f.run(f.request({ progressStages: ["reading"], onProgress: async value => received.push(value) }));
    assert.deepEqual(Object.keys(received[0]).sort(), ["completed", "iteration", "sequence", "stage", "total", "updatedAt"]);
    assert.equal(received[0].sequence, 1); assert.equal(received[0].iteration, 1);
    assert.match(received[0].updatedAt, /^\d{4}-.*Z$/);
    assert.doesNotMatch(JSON.stringify(f.diagnostics), /private-canary/);
});

for (const mode of ["startup", "send", "response", "progress", "usage"]) test(`cancellation during ${mode} stops runtime before scratch removal`, async t => {
    const controller = new AbortController(), entered = deferred(), hanging = deferred();
    const f = await fixture(t, { deps: { removeScratch: async scratch => {
        assert.ok(f.calls.includes("forceStop")); await removeEphemeralScratch(scratch);
    } } });
    if (mode === "startup") f.behavior.create = async () => { entered.resolve(); await hanging.promise; };
    if (mode === "send") f.behavior.send = async config => {
        config.onEvent(event("assistant.usage", { apiCallId: "known", ...metric })); entered.resolve(); await hanging.promise;
    };
    const change = mode === "response" ? { onResponse: async () => { entered.resolve(); await hanging.promise; } }
        : mode === "progress" ? { progressStages: ["reading"], onProgress: async () => { entered.resolve(); await hanging.promise; } }
        : mode === "usage" ? { onUsage: async () => { entered.resolve(); await hanging.promise; } } : {};
    if (mode === "progress") f.behavior.send = config => config.tools[0].handler({ stage: "reading" }, { sessionId: config.sessionId });
    const pending = f.run(f.request({ ...change, signal: controller.signal }));
    const rejected = assert.rejects(pending, { code: "EPHEMERAL_ABORTED" });
    await entered.promise; controller.abort("private-canary"); await rejected; hanging.resolve();
    assert.deepEqual(await readdir(f.scratchRoot), []);
    if (mode === "send") {
        assert.equal(f.updates.at(-1).usage.inputTokens, null);
        assert.equal(f.updates.at(-1).usageUncertain, true);
        assert.deepEqual(f.updates.at(-1).usageDiagnostics.apiCallCountReasons, ["interrupted_call"]);
        assert.equal(f.updates.at(-1).usageDiagnostics.observedApiCalls, 1);
        assert.ok(f.updates.some(update => update.usage.inputTokens === 100));
    }
});

test("cleanup idle after cancellation cannot turn partial usage into a completed observation", async t => {
    const controller = new AbortController();
    const f = await fixture(t);
    f.behavior.send = async config => {
        config.onEvent(event("assistant.usage", { apiCallId: "known", ...metric }));
        await new Promise(resolve => setImmediate(resolve));
        controller.abort();
    };
    f.behavior.abort = async () => f.captured.config.onEvent(event("session.idle"));
    await assert.rejects(f.run(f.request({ signal: controller.signal })), { code: "EPHEMERAL_ABORTED" });
    assert.ok(f.updates.some(update => update.usage.inputTokens === 100));
    assert.equal(f.updates.at(-1).completed, false);
    assert.equal(f.updates.at(-1).usageUncertain, true);
    assert.equal(f.updates.at(-1).usage.apiCalls, null);
    assert.deepEqual(f.updates.at(-1).usageDiagnostics.apiCallCountReasons, ["interrupted_call"]);
});

test("idle before callback cancellation preserves genuinely completed model usage", async t => {
    const controller = new AbortController();
    const f = await fixture(t);
    await assert.rejects(f.run(f.request({
        signal: controller.signal,
        onResponse: async () => { controller.abort(); return { action: "complete" }; },
    })), { code: "EPHEMERAL_ABORTED" });
    assert.equal(f.updates.at(-1).completed, true);
    assert.equal(f.updates.at(-1).usageUncertain, false);
    assert.deepEqual(f.updates.at(-1).usage, { ...metric, apiCalls: 1 });
    assert.deepEqual(f.updates.at(-1).usageDiagnostics, { ...emptyUsageDiagnostics(), observedApiCalls: 1 });
    assert.ok(f.calls.includes("forceStop"));
    assert.deepEqual(await readdir(f.scratchRoot), []);
});

for (const outcome of ["succeeded", "aborted", "failed"]) test(`terminal usage observer cannot strand ${outcome} runtime shutdown`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const controller = new AbortController(), entered = deferred(), hanging = deferred();
    const f = await fixture(t);
    if (outcome === "aborted") f.behavior.send = async () => { controller.abort(); };
    if (outcome === "failed") f.behavior.forceStop = async () => { throw new Error("synthetic shutdown failure"); };
    const pending = f.run(f.request({ signal: controller.signal, onUsage: async () => {
        if (f.calls.includes("forceStop")) { entered.resolve(); await hanging.promise; }
    } }));
    const rejected = assert.rejects(pending, { code: "EPHEMERAL_CALLBACK_FAILED" });
    await entered.promise;
    assert.ok(f.calls.includes("forceStop"));
    assert.equal((await readdir(f.scratchRoot)).length, outcome === "failed" ? 1 : 0);
    t.mock.timers.tick(10000);
    await rejected; hanging.resolve();
});

test("a failing usage observer is not retried during final usage delivery", async t => {
    const f = await fixture(t);
    let updates = 0;
    await assert.rejects(f.run(f.request({ onUsage: async () => {
        updates++; throw new Error("private-canary");
    } })), { code: "EPHEMERAL_CALLBACK_FAILED" });
    assert.equal(updates, 1);
    assert.equal(f.calls.includes("send"), false);
    assert.doesNotMatch(JSON.stringify(f.diagnostics), /private-canary/);
});

test("active compaction drains before response validation and final usage", async t => {
    const entered = deferred(), f = await fixture(t);
    f.behavior.send = async config => {
        config.onEvent(event("assistant.usage", { apiCallId: "parent", ...metric }));
        config.onEvent(event("session.compaction_start"));
        config.onEvent(event("assistant.message", { content: "done" }));
        config.onEvent(event("session.idle"));
        entered.resolve();
    };
    let responses = 0;
    const pending = f.run(f.request({ onResponse: async () => { responses++; return { action: "complete" }; } }));
    await entered.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(responses, 0); assert.equal(f.updates.filter(update => update.completed).length, 0);
    f.captured.config.onEvent(event("session.compaction_complete", { success: true, compactionTokensUsed: metric }));
    const result = await pending;
    assert.equal(responses, 1); assert.equal(result.usage.apiCalls, 2);
});

test("a late background compaction is cancelled and reported uncertain rather than crossing iterations", async t => {
    const f = await fixture(t, { behavior: { lateCompaction: true } });
    await assert.rejects(f.run(f.request()), { code: "EPHEMERAL_INVOCATION_FAILED" });
    assert.equal(f.updates.at(-1).usage.apiCalls, null);
    assert.equal(f.calls.filter(call => call === "send").length, 1);
});

test("callback and cleanup failures are visible without second inference or raw diagnostics", async t => {
    for (const mode of ["response", "progress", "cleanup"]) {
        const f = await fixture(t);
        const failure = new Error("private-canary");
        const change = {};
        if (mode === "response") change.onResponse = async () => { throw failure; };
        if (mode === "progress") {
            change.progressStages = ["reading"]; change.onProgress = async () => { throw failure; };
            f.behavior.send = config => config.tools[0].handler({ stage: "reading" }, { sessionId: config.sessionId });
        }
        if (mode === "cleanup") f.behavior.stopErrors = [failure];
        await assert.rejects(f.run(f.request(change)), {
            code: mode === "cleanup" ? "EPHEMERAL_CLEANUP_FAILED" : "EPHEMERAL_CALLBACK_FAILED" });
        assert.equal(f.calls.filter(call => call === "send").length, 1);
        assert.doesNotMatch(JSON.stringify(f.diagnostics), /private-canary/);
    }
});

test("host shutdown aborts and drains tracked operations", async () => {
    const lifecycle = new HostEphemeralLifecycle(), stopped = deferred();
    const operation = lifecycle.track(new Promise(resolve => lifecycle.signal.addEventListener("abort", async () => {
        await stopped.promise; resolve({});
    })));
    let finished = false;
    const closing = lifecycle.stop().then(() => { finished = true; });
    await Promise.resolve(); assert.equal(finished, false);
    stopped.resolve(); await closing; await operation;
    assert.equal(lifecycle.signal.aborted, true); lifecycle.reset(); assert.equal(lifecycle.signal.aborted, false);
});

test("per-call native usage is additive once; session totals, duplicate aliases and missing counters are not", () => {
    const usage = new EphemeralUsageAccumulator();
    assert.equal(usage.snapshot().usage.apiCalls, null);
    usage.observe(event("assistant.usage", { apiCallId: "parent", ...metric }));
    usage.observe(event("assistant.usage", { apiCallId: "child", ...metric }, { agentId: "native" }));
    usage.observe(event("assistant.usage", { providerCallId: "alias", ...metric }, { agentId: "native" }));
    assert.equal(usage.snapshot().usageDiagnostics.observedApiCalls, 3);
    usage.observe(event("assistant.usage", { apiCallId: "child", providerCallId: "alias", ...metric }, { agentId: "native" }));
    usage.observe(event("session.shutdown", { usage: { inputTokens: 200 } }));
    usage.observe(event("subagent.completed", { usage: { inputTokens: 100 } }));
    assert.equal(usage.snapshot().usage.inputTokens, 200);
    assert.equal(usage.snapshot().usage.apiCalls, 2);
    assert.deepEqual(usage.snapshot().usageDiagnostics, { ...emptyUsageDiagnostics(), observedApiCalls: 2 });
    usage.observe(event("assistant.usage", { apiCallId: "child", inputTokens: 300 }, { agentId: "native" }));
    assert.equal(usage.snapshot().usage.inputTokens, null);
    assert.deepEqual(usage.snapshot().usageDiagnostics.counterReasons.inputTokens, ["conflicting_counter"]);
    assert.deepEqual(usage.snapshot().usageDiagnostics.counterReasons.outputTokens, []);
    assert.throws(() => usage.observe(event("assistant.usage", { apiCallId: "bad", inputTokens: -1 })), { code: "EPHEMERAL_INVALID_USAGE" });
    usage.markIncomplete(); assert.equal(usage.snapshot().usage.apiCalls, null);
    const unknown = new EphemeralUsageAccumulator();
    unknown.observe(event("assistant.usage", metric, { agentId: "native" }));
    unknown.observe(event("assistant.usage", metric, { agentId: "native" }));
    assert.equal(unknown.snapshot().usage.apiCalls, null);
    assert.equal(unknown.snapshot().usage.inputTokens, null);
});

test("compaction per-call metrics count once and correlate with provider usage rather than session totals", () => {
    const usage = new EphemeralUsageAccumulator();
    usage.observe(event("assistant.usage", { apiCallId: "parent", ...metric }));
    const compacted = event("session.compaction_complete", { success: true, serviceRequestId: "compaction-request",
        compactionTokensUsed: metric, preCompactionTokens: 10000, postCompactionTokens: 1000 });
    usage.observe(compacted); usage.observe(compacted);
    usage.observe(event("assistant.usage", { apiCallId: "compaction-response", serviceRequestId: "compaction-request", ...metric }));
    usage.observe(event("session.compaction_complete", { success: true, compactionTokensUsed: metric }, { agentId: "child" }));
    assert.equal(usage.snapshot().usage.apiCalls, 3);
    assert.deepEqual(usage.snapshot().usageDiagnostics, { ...emptyUsageDiagnostics(), observedApiCalls: 3 });
    assert.equal(usage.snapshot().usage.inputTokens, 300);
    usage.observe(event("session.compaction_complete", { success: false }));
    assert.equal(usage.snapshot().usage.apiCalls, null);
    assert.deepEqual(usage.snapshot().usageDiagnostics.apiCallCountReasons, ["interrupted_call", "missing_compaction_usage"]);
    const missing = new EphemeralUsageAccumulator();
    missing.observe(event("assistant.usage", { apiCallId: "parent", ...metric }));
    missing.observe(event("session.compaction_complete", { success: true }));
    assert.equal(missing.snapshot().usage.apiCalls, null);
    assert.equal(missing.snapshot().usageDiagnostics.observedApiCalls, 1);
    assert.deepEqual(missing.snapshot().usageDiagnostics.apiCallCountReasons, ["missing_compaction_usage"]);
});

const otherMetric = { inputTokens: 200, outputTokens: 22, cacheReadTokens: 60, cacheWriteTokens: 20 };
const twoCalls = { inputTokens: 300, outputTokens: 33, cacheReadTokens: 90, cacheWriteTokens: 30, apiCalls: 2 };
const unknownCalls = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, apiCalls: null };
function permutations(items) {
    return items.length ? items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index))
        .map(rest => [item, ...rest])) : [[]];
}
function replayUsage(events) {
    const usage = new EphemeralUsageAccumulator();
    for (const item of events) {
        usage.observe(item);
        usage.snapshot();
    }
    return usage;
}

for (const alias of ["providerCallId", "serviceRequestId"]) {
    for (const equal of [false, true]) test(`${alias} never unifies distinct primary IDs, including equal counters (${equal})`, () => {
        for (const events of permutations([
            event("assistant.usage", { apiCallId: "A", [alias]: "shared", ...metric }),
            event("assistant.usage", { apiCallId: "B", [alias]: "shared", ...(equal ? metric : otherMetric) }, { agentId: "native" }),
        ])) {
            const snapshot = replayUsage(events).snapshot();
            assert.deepEqual(snapshot.usage, equal
                ? { inputTokens: 200, outputTokens: 22, cacheReadTokens: 60, cacheWriteTokens: 20, apiCalls: 2 } : twoCalls);
            assert.deepEqual(snapshot.usageDiagnostics, { ...emptyUsageDiagnostics(), observedApiCalls: 2 });
        }
    });
}

test("late and transitive tracing bridges cannot collapse already-counted primary calls", () => {
    for (const events of permutations([
        event("assistant.usage", { apiCallId: "A", providerCallId: "P", ...metric }),
        event("assistant.usage", { apiCallId: "B", serviceRequestId: "S", ...otherMetric }),
        event("assistant.usage", { apiCallId: "A", serviceRequestId: "S", ...metric }),
    ])) assert.deepEqual(replayUsage(events).snapshot().usage, twoCalls);
    const transitive = replayUsage([
        event("assistant.usage", { apiCallId: "A", providerCallId: "P1", serviceRequestId: "S1", ...metric }),
        event("assistant.usage", { apiCallId: "B", providerCallId: "P2", serviceRequestId: "S2", ...metric }),
        event("assistant.usage", { apiCallId: "C", providerCallId: "P1", serviceRequestId: "S2", ...metric }),
    ]);
    assert.equal(transitive.snapshot().usage.apiCalls, 3);
    assert.equal(transitive.snapshot().usage.inputTokens, 300);
    const separate = replayUsage([
        event("assistant.usage", { providerCallId: "same-text", ...metric }),
        event("assistant.usage", { serviceRequestId: "same-text", ...otherMetric }),
    ]);
    assert.deepEqual(separate.snapshot().usage, twoCalls);
});

test("same-primary revisions stay conflicting, while duplicate events and identical snapshots stay deduplicated", () => {
    const first = event("assistant.usage", { apiCallId: "A", ...metric });
    const usage = replayUsage([first, { ...first, data: { apiCallId: "A", ...otherMetric } },
        event("assistant.usage", { apiCallId: "A", ...metric })]);
    assert.deepEqual(usage.snapshot().usage, { ...metric, apiCalls: 1 });
    usage.observe(event("assistant.usage", { apiCallId: "A", ...otherMetric }, { agentId: "native" }));
    usage.observe(event("assistant.usage", { apiCallId: "A", ...metric }));
    assert.deepEqual(usage.snapshot().usage, { ...unknownCalls, apiCalls: 1 });
    for (const reasons of Object.values(usage.snapshot().usageDiagnostics.counterReasons)) assert.deepEqual(reasons, ["conflicting_counter"]);
    assert.deepEqual(usage.snapshot().usageDiagnostics.apiCallCountReasons, []);
});

test("weak-only transitive observations resolve to a late unique primary in every arrival order", () => {
    for (const events of permutations([
        event("assistant.usage", { providerCallId: "P", ...metric }),
        event("assistant.usage", { serviceRequestId: "S", ...metric }),
        event("assistant.usage", { providerCallId: "P", serviceRequestId: "S", ...metric }),
        event("assistant.usage", { apiCallId: "A", providerCallId: "P", ...metric }),
    ])) {
        const snapshot = replayUsage(events).snapshot();
        assert.deepEqual(snapshot.usage, { ...metric, apiCalls: 1 });
        assert.deepEqual(snapshot.usageDiagnostics, { ...emptyUsageDiagnostics(), observedApiCalls: 1 });
    }
});

test("late primary ambiguity withdraws weak counters without poisoning an arbitrary primary", () => {
    for (const events of permutations([
        event("assistant.usage", { providerCallId: "shared", ...otherMetric }),
        event("assistant.usage", { apiCallId: "A", providerCallId: "shared", ...metric }),
        event("assistant.usage", { apiCallId: "B", providerCallId: "shared", ...otherMetric }),
    ])) {
        const snapshot = replayUsage(events).snapshot();
        assert.deepEqual(snapshot.usage, unknownCalls);
        assert.equal(snapshot.usageDiagnostics.observedApiCalls, 2);
        assert.deepEqual(snapshot.usageDiagnostics.apiCallCountReasons, ["missing_call_identity"]);
        for (const reasons of Object.values(snapshot.usageDiagnostics.counterReasons)) assert.deepEqual(reasons, ["missing_call_identity"]);
    }
    for (const events of permutations([
        event("assistant.usage", { providerCallId: "P", serviceRequestId: "S", ...metric }),
        event("assistant.usage", { apiCallId: "A", providerCallId: "P", ...metric }),
        event("assistant.usage", { apiCallId: "B", serviceRequestId: "S", ...otherMetric }),
    ])) assert.deepEqual(replayUsage(events).snapshot().usage, unknownCalls);
});

test("a shared primary tracing field does not make a separate uniquely anchored weak observation ambiguous", () => {
    for (const events of permutations([
        event("assistant.usage", { providerCallId: "unique-A", ...metric }),
        event("assistant.usage", { apiCallId: "A", providerCallId: "unique-A", serviceRequestId: "shared", ...metric }),
        event("assistant.usage", { apiCallId: "B", providerCallId: "unique-B", serviceRequestId: "shared", ...otherMetric }),
    ])) assert.deepEqual(replayUsage(events).snapshot().usage, twoCalls);
});

test("conflicting weak-only observations keep call identity unknown until an unambiguous primary arrives", () => {
    const usage = replayUsage([
        event("assistant.usage", { serviceRequestId: "S", ...metric }),
        event("assistant.usage", { serviceRequestId: "S", outputTokens: 12 }),
    ]);
    assert.deepEqual(usage.snapshot().usage, unknownCalls);
    assert.equal(usage.snapshot().usageDiagnostics.observedApiCalls, 0);
    assert.deepEqual(usage.snapshot().usageDiagnostics.apiCallCountReasons, ["missing_call_identity"]);
    usage.observe(event("assistant.usage", { apiCallId: "A", serviceRequestId: "S", ...metric }));
    assert.deepEqual(usage.snapshot().usage, { ...metric, outputTokens: null, apiCalls: 1 });
    assert.deepEqual(usage.snapshot().usageDiagnostics.counterReasons.outputTokens, ["conflicting_counter"]);
});

test("compaction fallback identities remain separate or explicitly ambiguous instead of guessing", () => {
    const compact = (data, extra) => event("session.compaction_complete", { success: true, compactionTokensUsed: metric, ...data }, extra);
    assert.equal(replayUsage([compact({}), compact({})]).snapshot().usage.apiCalls, 2);
    const shared = [compact({ serviceRequestId: "S" }), compact({ serviceRequestId: "S" }, { agentId: "native" })];
    assert.deepEqual(replayUsage(shared).snapshot().usage, unknownCalls);
    for (const events of permutations([...shared, event("assistant.usage", { apiCallId: "A", serviceRequestId: "S", ...metric })])) {
        const snapshot = replayUsage(events).snapshot();
        assert.deepEqual(snapshot.usage, unknownCalls);
        assert.equal(snapshot.usageDiagnostics.observedApiCalls, 1);
    }
    for (const events of permutations([
        compact({ serviceRequestId: "S" }),
        event("assistant.usage", { apiCallId: "A", serviceRequestId: "S", ...metric }),
        event("assistant.usage", { apiCallId: "B", serviceRequestId: "S", ...otherMetric }),
    ])) assert.deepEqual(replayUsage(events).snapshot().usage, unknownCalls);
    for (const events of permutations([
        compact({ serviceRequestId: "S1" }),
        compact({ serviceRequestId: "S2" }),
        event("assistant.usage", { apiCallId: "A", serviceRequestId: "S1", ...metric }),
        event("assistant.usage", { apiCallId: "A", serviceRequestId: "S2", ...metric }),
    ])) {
        const snapshot = replayUsage(events).snapshot();
        assert.deepEqual(snapshot.usage, unknownCalls);
        assert.equal(snapshot.usageDiagnostics.observedApiCalls, 1);
    }
});

test("failed-call weak correlation and primary sums preserve unknown counters and overflow errors", () => {
    const usage = replayUsage([
        event("model.call_failure", { providerCallId: "shared" }),
        event("assistant.usage", { apiCallId: "A", providerCallId: "shared", ...metric }),
        event("assistant.usage", { apiCallId: "B", providerCallId: "shared", ...otherMetric }),
    ]);
    assert.deepEqual(usage.snapshot().usage, unknownCalls);
    usage.markIncomplete();
    assert.deepEqual(usage.snapshot().usageDiagnostics.apiCallCountReasons, ["missing_call_identity", "interrupted_call"]);
    const overflow = new EphemeralUsageAccumulator();
    for (const apiCallId of ["A", "B"]) overflow.observe(event("assistant.usage", {
        apiCallId, providerCallId: "shared", ...metric, inputTokens: Number.MAX_SAFE_INTEGER,
    }));
    assert.throws(() => overflow.snapshot(), { code: "EPHEMERAL_INVALID_USAGE" });
});

test("session callbacks and final totals retain two primary calls sharing a tracing header", async t => {
    const f = await fixture(t, { behavior: { send(config) {
        config.onEvent(event("assistant.usage", { apiCallId: "A", providerCallId: "shared", ...metric }));
        config.onEvent(event("assistant.usage", { apiCallId: "B", providerCallId: "shared", ...otherMetric }, { agentId: "native" }));
        config.onEvent(event("assistant.message", { content: "done" }));
        config.onEvent(event("session.idle"));
    } } });
    const result = await f.run(f.request({ onResponse: async response => {
        assert.deepEqual(response.usage, twoCalls);
        return { action: "complete" };
    } }));
    assert.deepEqual(result.usage, twoCalls);
    assert.deepEqual(f.updates.at(-1).usage, twoCalls);
    assert.equal(result.usageUncertain, false);
});

test("missing and conflicting counters have different bounded provenance and preserve other fields", () => {
    const usage = new EphemeralUsageAccumulator();
    assert.deepEqual(usage.snapshot().usageDiagnostics.apiCallCountReasons, ["no_usage_observed"]);
    usage.observe(event("assistant.usage", { apiCallId: "private-call", privateText: "private-corpus" }));
    const missing = usage.snapshot();
    assert.deepEqual(missing.usage, { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, apiCalls: 1 });
    assert.deepEqual(missing.usageDiagnostics.apiCallCountReasons, []);
    for (const reasons of Object.values(missing.usageDiagnostics.counterReasons)) assert.deepEqual(reasons, ["missing_counter"]);
    usage.observe(event("assistant.usage", { apiCallId: "private-call", ...metric }));
    assert.deepEqual(usage.snapshot().usageDiagnostics, { ...emptyUsageDiagnostics(), observedApiCalls: 1 });
    assert.deepEqual(usage.snapshot().usage, { ...metric, apiCalls: 1 });
    usage.observe(event("assistant.usage", { apiCallId: "private-call", inputTokens: 101 }));
    assert.equal(usage.snapshot().usage.inputTokens, null);
    assert.equal(usage.snapshot().usage.outputTokens, 11);
    assert.deepEqual(usage.snapshot().usageDiagnostics.counterReasons.inputTokens, ["conflicting_counter"]);
    usage.observe(event("assistant.usage", { apiCallId: "private-call", inputTokens: 100 }));
    assert.deepEqual(usage.snapshot().usageDiagnostics.counterReasons.inputTokens, ["conflicting_counter"]);
    usage.observe(event("assistant.usage", { apiCallId: "private-call", outputTokens: 12, cacheReadTokens: 31, cacheWriteTokens: 11 }));
    assert.deepEqual(usage.snapshot().usage, missing.usage);
    for (const reasons of Object.values(usage.snapshot().usageDiagnostics.counterReasons)) assert.deepEqual(reasons, ["conflicting_counter"]);
    const text = JSON.stringify(usage.snapshot().usageDiagnostics);
    assert.ok(!text.includes("private"));
    assert.ok(text.length < 1500);
    missing.usageDiagnostics.counterReasons.inputTokens.push("interrupted_call");
    assert.deepEqual(usage.snapshot().usageDiagnostics.counterReasons.inputTokens, ["conflicting_counter"]);
});

test("observed calls remain distinct from unknown identity, interrupted calls and invalid counters", () => {
    const usage = new EphemeralUsageAccumulator();
    usage.observe(event("assistant.usage", { apiCallId: "parent", ...metric }));
    usage.observe(event("assistant.usage", metric, { agentId: "child" }));
    assert.equal(usage.snapshot().usage.apiCalls, null);
    assert.equal(usage.snapshot().usageDiagnostics.observedApiCalls, 1);
    assert.deepEqual(usage.snapshot().usageDiagnostics.apiCallCountReasons, ["missing_call_identity"]);
    usage.markIncomplete();
    assert.deepEqual(usage.snapshot().usageDiagnostics.apiCallCountReasons, ["missing_call_identity", "interrupted_call"]);
    assert.throws(() => usage.observe(event("assistant.usage", { apiCallId: "parent", outputTokens: -1 })),
        { code: "EPHEMERAL_INVALID_USAGE" });
    assert.deepEqual(usage.snapshot().usageDiagnostics.counterReasons.outputTokens,
        ["missing_call_identity", "interrupted_call", "invalid_counter"]);
    const conflicted = new EphemeralUsageAccumulator();
    conflicted.observe(event("assistant.usage", { providerCallId: "alias", ...metric }));
    conflicted.observe(event("assistant.usage", { providerCallId: "alias", outputTokens: 12 }));
    assert.throws(() => conflicted.observe(event("assistant.usage", { apiCallId: "call", outputTokens: -1 })));
    conflicted.observe(event("assistant.usage", { apiCallId: "call", providerCallId: "alias" }));
    assert.equal(conflicted.snapshot().usageDiagnostics.observedApiCalls, 1);
    assert.deepEqual(conflicted.snapshot().usageDiagnostics.counterReasons.outputTokens, ["conflicting_counter", "invalid_counter"]);
    const unidentifiable = new EphemeralUsageAccumulator();
    assert.throws(() => unidentifiable.observe(event("assistant.usage", { inputTokens: -1 })), { code: "EPHEMERAL_INVALID_USAGE" });
    assert.deepEqual(unidentifiable.snapshot().usageDiagnostics.counterReasons.inputTokens,
        ["missing_call_identity", "invalid_counter"]);
});

test("diagnostics replace within an invocation and union only across finalized iterations", async t => {
    const f = await fixture(t, { behavior: { send(config, _message, iteration) {
        config.onEvent(event("assistant.usage", { apiCallId: `call-${iteration}`, inputTokens: 100 }));
        if (iteration === 1) config.onEvent(event("assistant.usage", { apiCallId: "call-1", ...metric }));
        config.onEvent(event("assistant.message", { content: "done" }));
        config.onEvent(event("session.idle"));
    } } });
    const responses = [];
    const result = await f.run(f.request({ onResponse: async response => {
        responses.push(response);
        return response.iteration === 1 ? { action: "continue", prompt: "next" } : { action: "complete" };
    } }));
    assert.ok(f.updates.some(update => update.iteration === 1
        && update.usageDiagnostics.counterReasons.outputTokens.includes("missing_counter")));
    assert.deepEqual(responses[0].usageDiagnostics, { ...emptyUsageDiagnostics(), observedApiCalls: 1 });
    assert.deepEqual(responses[1].usageDiagnostics.counterReasons.outputTokens, ["missing_counter"]);
    assert.equal(result.usageDiagnostics.observedApiCalls, 2);
    assert.equal(result.usage.inputTokens, 200);
    assert.equal(result.usage.outputTokens, null);
    assert.deepEqual(result.usageDiagnostics.counterReasons.outputTokens, ["missing_counter"]);
    assert.deepEqual(result.usageDiagnostics.counterReasons.inputTokens, []);
    const first = new EphemeralUsageAccumulator();
    first.observe(event("assistant.usage", { apiCallId: "first" }));
    const second = new EphemeralUsageAccumulator();
    second.markIncomplete();
    const summed = sumUsageDiagnostics(first.snapshot().usageDiagnostics, second.snapshot().usageDiagnostics);
    assert.equal(summed.observedApiCalls, 1);
    assert.deepEqual(summed.counterReasons.inputTokens, ["no_usage_observed", "missing_counter", "interrupted_call"]);
});

test("fresh scratch allocation preserves prior live/dead/unowned/symlink state; virtual state never reaches disk", async t => {
    const f = await fixture(t), live = await createEphemeralScratch(f.scratchRoot), dead = await createEphemeralScratch(f.scratchRoot);
    assert.equal((await stat(live.directory)).mode & 0o077, 0);
    const unowned = path.join(f.scratchRoot, `invocation-${randomUUID()}`);
    await mkdir(unowned); await writeFile(path.join(unowned, "keep"), "keep");
    await symlink(unowned, path.join(f.scratchRoot, `invocation-${randomUUID()}`));
    const marker = path.join(dead.directory, ".ephemeral-owner.json");
    const data = JSON.parse(await readFile(marker, "utf8"));
    const historicalMarker = JSON.stringify({ ...data, pid: 2147483647, host: hostname() });
    await writeFile(marker, historicalMarker);
    const fresh = await createEphemeralScratch(f.scratchRoot);
    assert.equal(await readFile(marker, "utf8"), historicalMarker);
    assert.equal(await readFile(path.join(unowned, "keep"), "utf8"), "keep");
    const vfs = new EphemeralFilesystem(live.directory, f.cwd);
    const log = path.join(live.copilotHome, "events.jsonl");
    await vfs.appendFile(log, "private-canary");
    assert.equal(await vfs.readFile(log), "");
    await assert.rejects(stat(log), { code: "ENOENT" });
    await vfs.writeFile(path.join(live.copilotHome, "metadata.json"), "memory-only");
    assert.equal(await vfs.readFile(path.join(live.copilotHome, "metadata.json")), "memory-only");
    await vfs.writeFile(path.join(f.cwd, "output"), "host-output");
    assert.equal(await readFile(path.join(f.cwd, "output"), "utf8"), "host-output");
    await removeEphemeralScratch(live);
    await removeEphemeralScratch(fresh);
    assert.equal(await readFile(marker, "utf8"), historicalMarker);
});

// ---------------------------------------------------------------------------
// Host-driven inter-batch context reset (contextReset + clear_context).
// ---------------------------------------------------------------------------

// A reset turn: the model calls the reset tool, the runtime reports the clear,
// then the seeded turn produces the one assistant reply that survives.
const resetTurn = (content = "Ready.", onSeed = () => {}) => async config => {
    const tool = config.tools.find(entry => entry.name === RESET_TOOL);
    const cleared = await tool.handler({}, { sessionId: config.sessionId });
    assert.match(cleared, /reset/i);
    config.onEvent(event("assistant.usage", { apiCallId: "reset-call", ...metric }));
    config.onEvent(event("session.context_cleared", { messagesCleared: 2, initialMessage: RESET_SEED }));
    onSeed();
    config.onEvent(event("assistant.message", { messageId: "seeded", content }));
    config.onEvent(event("session.idle"));
    return "submitted";
};
const batchTurn = (config, count) => {
    config.onEvent(event("assistant.usage", { apiCallId: `call-${count}`, ...metric }));
    config.onEvent(event("assistant.message", { messageId: `answer-${count}`, content: `Batch ${count}.` }));
    config.onEvent(event("session.idle")); return "submitted";
};
// One boundary after the first batch, then complete.
const oneBoundary = () => { let turn = 0;
    return async () => ++turn < 2 ? { action: "clear_context", prompt: "batch two" } : { action: "complete" }; };

test("contextReset is opt-in: absent, the reset tool is never registered or offered", async t => {
    const f = await fixture(t);
    const result = await f.run(f.request());
    assert.equal(result.text, "Synthetic answer.");
    assert.equal(f.captured.config.availableTools.includes(RESET_TOOL), false);
    assert.equal((f.captured.config.tools ?? []).some(tool => tool.name === RESET_TOOL), false);
    assert.equal(f.calls.includes("clearContext"), false);
    assert.deepEqual(f.captured.recoveryGates, []);
});

test("contextReset registers the internal reset tool and nothing else changes", async t => {
    const f = await fixture(t, { request: { contextReset: true } });
    await f.run(f.request({ contextReset: true }));
    assert.equal(f.captured.config.availableTools.includes(RESET_TOOL), true);
    const tool = f.captured.config.tools.find(entry => entry.name === RESET_TOOL);
    assert.ok(tool, "The runtime can only honour a clear from inside a tool handler.");
    assert.equal(tool.skipPermission, true);
    assert.deepEqual(tool.parameters.properties, {});
    // Registration alone must not perform or imply a clear.
    assert.equal(f.calls.includes("clearContext"), false);
});

test("a clear_context decision without contextReset is refused, not silently continued", async t => {
    const f = await fixture(t);
    await assert.rejects(f.run(f.request({ onResponse: async () => ({ action: "clear_context", prompt: "next" }) })),
        { code: "EPHEMERAL_RESET_UNSUPPORTED" });
    assert.equal(f.calls.includes("clearContext"), false);
});

test("contextReset is refused up front alongside native children", async t => {
    const f = await fixture(t);
    await assert.rejects(f.run(f.request({ contextReset: true,
        nativeChildren: { maxConcurrent: 1, assignments: [{ id: "batch", sessionRefs: ["s0"] }], progressStages: ["classifying"] },
        onChildProgress: async () => {},
    })), { code: "EPHEMERAL_RESET_UNSUPPORTED" });
    // Refused before the runtime is ever reached.
    assert.equal(f.calls.includes("create"), false);
    assert.equal(f.calls.includes("send"), false);
});

test("an unsolicited context clear outside a reset barrier is a fatal integrity failure", async t => {
    for (const contextReset of [undefined, false, true]) {
        const responses = [];
        const f = await fixture(t, { behavior: { async send(config) {
            config.onEvent(event("assistant.usage", { apiCallId: "interrupted", ...metric }));
            config.onEvent(event("session.context_cleared", { messagesCleared: 9 }));
            config.onEvent(event("assistant.message", { messageId: "invalid", content: "Untrusted response." }));
            config.onEvent(event("session.idle"));
        } } });
        await assert.rejects(f.run(f.request({ contextReset,
            onResponse: async response => { responses.push(response); return { action: "complete" }; },
        })), { code: "EPHEMERAL_UNEXPECTED_CONTEXT_CLEAR" });
        assert.deepEqual(responses, []);
        assert.equal(f.calls.filter(call => call === "send").length, 1);
        assert.equal(f.updates.at(-1).completed, false);
        assert.equal(f.updates.at(-1).usage.apiCalls, null);
        assert.equal(f.updates.at(-1).usageDiagnostics.observedApiCalls, 1);
        assert.deepEqual(f.updates.at(-1).usageDiagnostics.apiCallCountReasons, ["interrupted_call"]);
        assert.equal(f.updates.at(-1).usageUncertain, true);
        assert.ok(f.calls.includes("abort"));
        assert.ok(f.calls.includes("forceStop"));
        assert.deepEqual(await readdir(f.scratchRoot), []);
    }
});

test("contextReset must be a boolean", async t => {
    const f = await fixture(t);
    await assert.rejects(f.run(f.request({ contextReset: "yes" })), { code: "EPHEMERAL_INVALID_REQUEST" });
});

test("a clear_context boundary clears with a neutral seed and reuses one session", async t => {
    const f = await fixture(t, { behavior: {
        send: (config, message, count) => count === 2
            ? resetTurn("Ready.", () => assert.equal(f.captured.recoveryGated, true))(config)
            : batchTurn(config, count),
    } });
    const result = await f.run(f.request({ contextReset: true, onResponse: oneBoundary() }));

    assert.equal(result.text, "Batch 3.");
    // One session across the boundary.
    assert.equal(f.calls.filter(call => call === "create").length, 1);
    // The host's real next prompt is never handed to the runtime's reseed: the
    // seeded turn runs against the stale window, so a batch prompt delivered
    // there would be answered with the previous batch still in view.
    assert.deepEqual(f.captured.cleared, [{ prompt: RESET_SEED }]);
    assert.notEqual(f.captured.cleared[0].prompt, "batch two");
    // It is delivered as an ordinary turn instead.
    assert.deepEqual(f.captured.message, { prompt: "batch two" });
    assert.deepEqual(f.captured.recoveryGates, [true, false]);
    assert.deepEqual(f.captured.recoveryOnSend, [false, true, false]);
    assert.deepEqual(f.captured.recoveryOnClear, [true]);
    assert.deepEqual(f.calls.filter(call => ["send", "clearContext", "gate:closed", "gate:open"].includes(call)),
        ["send", "gate:closed", "send", "clearContext", "gate:open", "send"]);
});

test("a reset the runtime never reports fails closed instead of reusing the window", async t => {
    // No session.context_cleared at all, and a clear that reports nothing cleared.
    for (const behavior of [
        { send: (config, message, count) => count === 2
            ? (async () => { const tool = config.tools.find(entry => entry.name === RESET_TOOL);
                await tool.handler({}, { sessionId: config.sessionId });
                config.onEvent(event("assistant.message", { messageId: "seeded", content: "Ready." }));
                config.onEvent(event("session.idle")); return "submitted"; })()
            : batchTurn(config, count),
          clearContext: async () => ({ messagesCleared: 0 }) },
        { send: (config, message, count) => count === 2
            ? (async () => { const tool = config.tools.find(entry => entry.name === RESET_TOOL);
                await tool.handler({}, { sessionId: config.sessionId });
                config.onEvent(event("session.context_cleared", { messagesCleared: -1, initialMessage: RESET_SEED }));
                config.onEvent(event("session.idle")); return "submitted"; })()
            : batchTurn(config, count),
          clearContext: async () => ({ messagesCleared: -1 }) },
    ]) {
        const f = await fixture(t, { behavior });
        await assert.rejects(f.run(f.request({ contextReset: true, onResponse: oneBoundary() })),
            { code: "EPHEMERAL_RESET_FAILED" });
        // The next batch's prompt must never reach the provider on a bad reset.
        assert.notDeepEqual(f.captured.message, { prompt: "batch two" });
        assert.deepEqual(f.captured.recoveryGates, [true]);
        assert.equal(f.captured.recoveryGated, true);
    }
});

test("a model that declines to call the reset tool fails closed", async t => {
    const f = await fixture(t, { behavior: {
        send(config, message, count) {
            if (count === 2) {
                // The model answers in prose instead of calling the tool.
                config.onEvent(event("assistant.message", { messageId: "refusal", content: "I would rather not." }));
                config.onEvent(event("session.idle")); return "submitted";
            }
            return batchTurn(config, count);
        },
    } });
    await assert.rejects(f.run(f.request({ contextReset: true, onResponse: oneBoundary() })),
        { code: "EPHEMERAL_RESET_FAILED" });
    assert.equal(f.calls.includes("clearContext"), false);
    assert.notDeepEqual(f.captured.message, { prompt: "batch two" });
    assert.deepEqual(f.captured.recoveryGates, [true]);
    assert.deepEqual(f.captured.recoveryOnSend, [false, ...Array(RESET_ATTEMPTS).fill(true)]);
    assert.equal(f.captured.recoveryGated, true);
});

test("a declined reset attempt keeps recovery closed until a later verified barrier", async t => {
    const f = await fixture(t, { behavior: {
        send: (config, message, count) => count === 3
            ? resetTurn("Ready.", () => assert.equal(f.captured.recoveryGated, true))(config)
            : batchTurn(config, count),
    } });
    await f.run(f.request({ contextReset: true, onResponse: oneBoundary() }));
    assert.deepEqual(f.captured.recoveryGates, [true, false]);
    assert.deepEqual(f.captured.recoveryOnSend, [false, true, true, false]);
    assert.deepEqual(f.captured.recoveryOnClear, [true]);
    assert.equal(f.calls.filter(call => call === "clearContext").length, 1);
    assert.deepEqual(f.captured.message, { prompt: "batch two" });
});

test("a reset turn that errors fails closed rather than continuing on a stale window", async t => {
    for (const failure of ["session.error", "model.call_failure"]) for (const seeded of [false, true]) {
        const f = await fixture(t, { behavior: {
            async send(config, message, count) {
                if (count === 2) {
                    if (seeded) await config.tools.find(entry => entry.name === RESET_TOOL)
                        .handler({}, { sessionId: config.sessionId });
                    assert.equal(f.captured.recoveryGated, true);
                    config.onEvent(event(failure, { message: "synthetic", statusCode: 429, failureKind: "api" }));
                    config.onEvent(event("session.idle")); return "submitted";
                }
                return batchTurn(config, count);
            },
        } });
        await assert.rejects(f.run(f.request({ contextReset: true, onResponse: oneBoundary() })),
            { code: "EPHEMERAL_RESET_FAILED" });
        assert.notDeepEqual(f.captured.message, { prompt: "batch two" });
        assert.deepEqual(f.captured.recoveryGates, [true]);
        assert.deepEqual(f.captured.recoveryOnSend, [false, true]);
        assert.equal(f.captured.recoveryGated, true);
        assert.equal(f.calls.filter(call => call === "clearContext").length, seeded ? 1 : 0);
    }
});

test("the reset turn is never reported as host-visible work, but its usage is counted", async t => {
    const progress = [], responses = [], usage = [];
    const f = await fixture(t, { behavior: {
        send: (config, message, count) => count === 2
            ? resetTurn("Ready for the next instruction.")(config) : batchTurn(config, count),
    } });
    const result = await f.run(f.request({ contextReset: true,
        onProgress: async value => { progress.push(value); },
        progressStages: ["reading"],
        onUsage: async value => { usage.push(value); },
        onResponse: async value => { responses.push(value.text);
            return responses.length < 2 ? { action: "clear_context", prompt: "batch two" } : { action: "complete" }; } }));

    // The reset turn is never a host-visible response, and never a batch result.
    assert.deepEqual(responses, ["Batch 1.", "Batch 3."]);
    assert.equal(result.text, "Batch 3.");
    assert.equal(responses.includes("Ready for the next instruction."), false);
    assert.equal(progress.length, 0);
    // Two host batches, not three.
    assert.equal(result.turnCount, 2);
    // The reset turn performs real inference, so it is charged to the batch it
    // precedes rather than hidden. Three model calls for two batches.
    assert.equal(result.usage.apiCalls, 3);
    // And the host saw it before that batch's own work was sent.
    assert.ok(usage.some(update => update.iteration === 2 && update.usage.apiCalls === 1 && !update.completed));
});

test("no reset is performed after a complete decision", async t => {
    const f = await fixture(t, { behavior: {
        send: (config, message, count) => count === 2 ? resetTurn()(config) : batchTurn(config, count),
    } });
    await f.run(f.request({ contextReset: true, onResponse: oneBoundary() }));
    // Exactly one clear: the single boundary. The final complete adds none.
    assert.equal(f.calls.filter(call => call === "clearContext").length, 1);
    // Three sends: batch one, the reset turn, batch two. Nothing after.
    assert.equal(f.calls.filter(call => call === "send").length, 3);
});

test("repeated boundaries clear once each and keep one session", async t => {
    const f = await fixture(t, { behavior: {
        // Sends 2 and 4 are reset turns; 1, 3 and 5 are batches.
        send: (config, message, count) => count % 2 === 0 ? resetTurn()(config) : batchTurn(config, count),
    } });
    let turn = 0;
    const result = await f.run(f.request({ contextReset: true,
        onResponse: async () => ++turn < 3 ? { action: "clear_context", prompt: `batch ${turn + 1}` } : { action: "complete" } }));

    assert.equal(result.turnCount, 3);
    assert.equal(f.calls.filter(call => call === "create").length, 1);
    assert.equal(f.calls.filter(call => call === "clearContext").length, 2);
    assert.deepEqual(f.captured.cleared, [{ prompt: RESET_SEED }, { prompt: RESET_SEED }]);
    // Five model turns for three batches: each boundary costs one.
    assert.equal(f.calls.filter(call => call === "send").length, 5);
    assert.equal(result.usage.apiCalls, 5);
    assert.deepEqual(f.captured.recoveryGates, [true, false, true, false]);
    assert.deepEqual(f.captured.recoveryOnSend, [false, true, false, true, false]);
    assert.deepEqual(f.captured.recoveryOnClear, [true, true]);
});

// Regression: the per-turn deadline must cover the batch turn on BOTH paths.
// runReset's tail clears the turn timer once the barrier is verified, so the
// batch turn it prepares for was being sent with nothing armed. A turn that
// never reaches idle is then bounded only by the inactivity deadline, while
// the identical turn on the ordinary path is capped by turnTimeoutMs. The
// control case pins that ordinary behaviour so this stays a reset-path test.
test("a batch turn that never idles is bounded by the turn deadline after a reset, as it is without one", async t => {
    const hang = (config, message, count, resetAt) => count === resetAt
        ? resetTurn()(config)
        : count === resetAt + 1 || resetAt === 0 ? "submitted" : batchTurn(config, count);

    // Control: no reset. The first turn never idles and the deadline aborts it.
    const control = await fixture(t, { deps: { turnTimeoutMs: 60, turnInactivityTimeoutMs: 60_000 },
        behavior: { send: (config, message, count) => hang(config, message, count, 0) } });
    await assert.rejects(control.run(control.request()), { code: "EPHEMERAL_ABORTED" });

    // Same hang, but on the batch turn the reset barrier just prepared.
    const afterReset = await fixture(t, { deps: { turnTimeoutMs: 60, turnInactivityTimeoutMs: 60_000 },
        behavior: { send: (config, message, count) => hang(config, message, count, 2) } });
    await assert.rejects(afterReset.run(afterReset.request({ contextReset: true, onResponse: oneBoundary() })),
        { code: "EPHEMERAL_ABORTED" });
    // The barrier really did complete first, so this is the post-reset turn.
    assert.equal(afterReset.calls.filter(call => call === "clearContext").length, 1);
    assert.equal(afterReset.calls.filter(call => call === "send").length, 3);
});

// Teardown quality dominates the returned code, and these pin that on purpose.
// A failed barrier proves the next batch prompt was never dispatched, but that
// narrow signal must never hide an undrained process group or a lost usage
// observation: those are global failures of the run, and a host told
// EPHEMERAL_RESET_FAILED would requeue the assignment while this session's
// resources are still unaccounted for. Losing the requeue optimization is the
// price of never reporting a partial success as a clean, actionable failure.
test("a failed reset does not mask a cleanup failure", async t => {
    const f = await fixture(t, { behavior: {
        // The reset turn answers in prose, so the barrier fails closed...
        send(config, message, count) {
            if (count === 2) {
                config.onEvent(event("assistant.message", { messageId: "refusal", content: "No." }));
                config.onEvent(event("session.idle")); return "submitted";
            }
            return batchTurn(config, count);
        },
        // ...and teardown fails at the same time, which is the correlated case:
        // a barrier that failed tends to leave the helper unhealthy.
        stopErrors: [new Error("private-canary")],
    } });
    await assert.rejects(f.run(f.request({ contextReset: true, onResponse: oneBoundary() })),
        { code: "EPHEMERAL_CLEANUP_FAILED" });
    // The host must not be handed the requeue-safe code while the session is
    // still unaccounted for.
    assert.ok(f.diagnostics.some(entry => entry.code === "EPHEMERAL_RESET_FAILED"),
        "the original barrier failure is still recorded, just not returned");
    assert.notDeepEqual(f.captured.message, { prompt: "batch two" });
});

test("a failed reset does not mask a terminal usage callback failure", async t => {
    const f = await fixture(t, { behavior: {
        send(config, message, count) {
            if (count === 2) {
                config.onEvent(event("assistant.message", { messageId: "refusal", content: "No." }));
                config.onEvent(event("session.idle")); return "submitted";
            }
            return batchTurn(config, count);
        },
    } });
    // Only the delivery after the barrier fails; the gate closing marks that
    // boundary, and no other usage callback runs between it and teardown.
    await assert.rejects(f.run(f.request({ contextReset: true, onResponse: oneBoundary(),
        onUsage: async update => {
            f.updates.push(update);
            if (f.calls.includes("gate:closed")) throw new Error("private-canary");
        } })), { code: "EPHEMERAL_CALLBACK_FAILED" });
    assert.notDeepEqual(f.captured.message, { prompt: "batch two" });
});

test("an ordinary reset failure with clean teardown still reports the barrier", async t => {
    const f = await fixture(t, { behavior: {
        send(config, message, count) {
            if (count === 2) {
                config.onEvent(event("assistant.message", { messageId: "refusal", content: "No." }));
                config.onEvent(event("session.idle")); return "submitted";
            }
            return batchTurn(config, count);
        },
    } });
    await assert.rejects(f.run(f.request({ contextReset: true, onResponse: oneBoundary() })),
        { code: "EPHEMERAL_RESET_FAILED" });
    assert.notDeepEqual(f.captured.message, { prompt: "batch two" });
});

// Regression: teardown must not wait forever on a host callback.
//
// Every other teardown step is bounded by cleanupStep; draining the callback
// queue was not. A callback enqueued by a late event AFTER the in-loop drain --
// here an assistant.usage fired from inside onResponse -- is never awaited
// again before teardown, so on the success path `interrupted` has never
// rejected and `guarded()` cannot rescue it: the returned promise hung forever
// with the child already dead. The runtime process being drained while
// host-owned work is not is a cleanup failure, not a success, so the run must
// report EPHEMERAL_CLEANUP_FAILED rather than resolving.
test("a host callback still in flight at teardown is bounded and fails the run", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const entered = deferred(), hanging = deferred();
    const f = await fixture(t);
    let late = false;
    const pending = f.run(f.request({
        // Only the late observation hangs. The terminal delivery is made
        // directly rather than through the queue, so it still completes and the
        // returned code stays the cleanup failure itself.
        onUsage: async update => {
            f.updates.push(update);
            if (late && update.completed === false) { entered.resolve(); await hanging.promise; }
        },
        onResponse: async () => {
            late = true;
            f.captured.config.onEvent(event("assistant.usage", { apiCallId: "late", ...metric }));
            return { action: "complete" };
        },
    }));
    const rejected = assert.rejects(pending, { code: "EPHEMERAL_CLEANUP_FAILED" });
    await entered.promise;
    // Let teardown reach the bounded drain, then expire it. Nothing else is
    // armed by now: the turn and inactivity timers are cleared entering cleanup.
    for (let i = 0; i < 40; i++) { await nextTurn(); t.mock.timers.tick(1000); }
    await rejected;
    // Release the callback so the test leaves nothing pending behind it.
    hanging.resolve();
    await nextTurn();
});
