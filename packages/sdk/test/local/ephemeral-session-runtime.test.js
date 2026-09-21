import { describe, it, expect } from "vitest";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync, fork } from "node:child_process";
import path from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { createEphemeralSessionRunner } from "../../dist/ephemeral-session.js";
import { createEphemeralClient } from "../../dist/ephemeral-client.js";
import { EphemeralFilesystem } from "../../dist/ephemeral-filesystem.js";
import { loadProviderTypes } from "../../src/provider-catalog.ts";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";
import { RESET_PROMPT, RESET_SEED, RESET_TOOL } from "../../dist/ephemeral-context-reset.js";

const MODEL = "gpt-5.6-terra";
const isParent = body => body.tools?.some(tool => tool.function?.name === "task");
const tool = (name, args) => ({ tools: [{ name, args }] });

function credentialCatalog(credential) {
    const providers = {
        async lookupUserId() { return 1; },
        async getCredential(name, viewer) {
            expect(name).toBe(credential.name);
            expect(viewer).toBe(1);
            return credential;
        },
    };
    return {
        async getUserRole() { return { role: "user", roleSeenAt: null }; },
        providers: new Proxy(providers, { get(target, key) {
            expect(["lookupUserId", "getCredential"]).toContain(key);
            return target[key];
        } }),
    };
}

async function scan(directory, canary) {
    const leaks = [], files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            const child = await scan(file, canary); leaks.push(...child.leaks); files.push(...child.files);
        } else if (entry.isFile()) {
            files.push(file);
            if ((await readFile(file)).includes(Buffer.from(canary))) leaks.push(file);
        }
    }
    return { leaks, files };
}

describe("ephemeral runtime (pinned SDK 1.0.14 / CLI 1.0.85, synthetic provider, no DB)", () => {
    for (const outcome of ["recovered", "exhausted", "unauthorized", "cancel-backoff", "not-enabled"]) it.concurrent(
        `native model rate limits ${outcome}: same child, bounded recovery and honest usage`,
        { timeout: 60000 }, async () => {
            const root = path.resolve(`.ephemeral-rate-limit-${randomUUID()}`), cwd = path.join(root, "workspace"), scratch = path.join(root, "sdk");
            await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
            const controller = new AbortController(), events = [], usage = [], childRequests = [];
            let launched = false, helperPid, validated = 0;
            const server = await createNativeCopilotProvider(body => {
                if (isParent(body) && outcome !== "not-enabled") {
                    if (launched) return { content: "Parent returned before child." };
                    launched = true;
                    return tool("task", { name: "batch", mode: "background", agent_type: "swarm-task",
                        description: "Synthetic rate-limit work", prompt: "Finish this assigned synthetic task." });
                }
                childRequests.push({ at: performance.now(), model: body.model });
                if (outcome === "recovered" && childRequests.length === 2) return { content: "Child recovered." };
                return { status: outcome === "unauthorized" ? 401 : 429, headers: { "retry-after": "1" },
                    body: { error: { message: "Synthetic provider limit", type: "rate_limit_error" } } };
            });
            const types = loadProviderTypes({ providers: [{ id: "template", type: "openai", baseUrl: server.baseUrl, models: [MODEL] }] });
            const catalog = credentialCatalog({ name: "selected", typeId: "template", class: "shared", ownerUserId: null,
                baseUrl: null, secretRef: { value: "synthetic" } });
            try {
                const run = createEphemeralSessionRunner(catalog, () => types, {
                    scratchRoot: scratch, signal: controller.signal, turnTimeoutMs: 30000,
                    diagnostic: value => console.log(`  ${outcome} ${value.phase}:${value.code} requests=${childRequests.length}`),
                    createClient(options, provider, onFailure, onDiagnostic) {
                        const client = createEphemeralClient(options, provider, onFailure, onDiagnostic, (...args) => {
                            const child = fork(...args); helperPid = child.pid; return child;
                        });
                        return { ...client, async createSession(config, retryModelRateLimits) {
                            expect(retryModelRateLimits).toBe(outcome !== "not-enabled");
                            return client.createSession({ ...config, onEvent(event) {
                                events.push(event);
                                if (event.type === "model.call_failure" || event.type === "subagent.failed")
                                    console.log(`  ${outcome} ${event.type} requests=${childRequests.length}`);
                                config.onEvent?.(event);
                                if (outcome === "cancel-backoff" && event.type === "model.call_failure") controller.abort();
                            } }, retryModelRateLimits);
                        } };
                    },
                });
                const operation = run({ actor: { provider: "fixture", subject: "test" }, executionId: randomUUID(),
                    model: `selected:${MODEL}`, workingDirectory: cwd, systemMessage: "Synthetic recovery test.", prompt: "Launch batch.",
                    ...(outcome !== "not-enabled" ? {
                        nativeChildren: { maxConcurrent: 20, assignments: [{ id: "batch", sessionRefs: ["s0"] }], progressStages: ["classifying"] },
                        onChildProgress: async () => {},
                    } : {}),
                    onUsage: async value => usage.push(value),
                    onResponse: async () => { validated++; return { action: "complete" }; },
                });
                if (outcome === "recovered") {
                    const result = await operation;
                    expect(validated).toBe(1);
                    expect(result.usageUncertain).toBe(true);
                    expect(result.usage.inputTokens).toBeNull();
                    expect(childRequests).toHaveLength(2);
                    expect(childRequests[1].at - childRequests[0].at).toBeGreaterThanOrEqual(1000);
                    expect(events.filter(event => event.type === "subagent.completed" && !event.data.cancelled)).toHaveLength(1);
                } else {
                    await expect(operation).rejects.toMatchObject({ code: outcome === "cancel-backoff"
                        ? "EPHEMERAL_ABORTED" : "EPHEMERAL_INVOCATION_FAILED" });
                    expect(validated).toBe(0);
                    expect(childRequests).toHaveLength(outcome === "exhausted" ? 3 : 1);
                    expect(usage.at(-1).usageUncertain).toBe(true);
                    expect(usage.at(-1).completed).toBe(false);
                }
                const starts = events.filter(event => event.type === "subagent.started");
                expect(starts).toHaveLength(outcome === "not-enabled" ? 0 : 1);
                const failures = events.filter(event => event.type === "model.call_failure");
                expect(failures.every(event => event.agentId === starts[0]?.agentId)).toBe(true);
                expect(childRequests.every(request => request.model === MODEL)).toBe(true);
                expect(await readdir(scratch)).toEqual([]);
                expect(() => process.kill(helperPid, 0)).toThrow();
                expect(() => process.kill(-helperPid, 0)).toThrow();
            } finally {
                controller.abort();
                await server.close();
                await rm(root, { recursive: true, force: true });
            }
        });
    it("bounds 21 assigned native children at 20, attributes progress once and drains before validation",
    { timeout: 90000 }, async () => {
        const root = path.resolve(`.ephemeral-parallel-${randomUUID()}`), cwd = path.join(root, "workspace"), scratch = path.join(root, "sdk");
        await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
        const assignments = Array.from({ length: 21 }, (_, i) => ({ id: `batch-${i}`, sessionRefs: [`s${i}`] }));
        const events = [], progress = [], updates = [], diagnostics = [], steps = new Map();
        let first = true, receiptRead = false, lastLaunched = false, active = 0, peak = 0, arrivals = 0, release;
        const twentyArrived = new Promise(resolve => { release = resolve; });
        const launch = i => ({ name: "task", args: { agent_type: "swarm-task", mode: "background", name: `batch-${i}`,
            description: `Process assigned batch ${i}`, prompt: `CHILD_INDEX=${i}. Write the private record, then report its completed session reference.` } });
        const server = await createNativeCopilotProvider(async body => {
            if (!isParent(body)) {
                const text = body.messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content)).join("\n");
                const i = Number(/CHILD_INDEX=(\d+)/.exec(text)?.[1]);
                expect(Number.isInteger(i)).toBe(true);
                const step = steps.get(i) ?? 0; steps.set(i, step + 1);
                if (step === 0) {
                    active++; peak = Math.max(peak, active);
                    if (++arrivals === 20) release();
                    if (i < 20) await twentyArrived;
                    active--;
                    return tool("bash", { command: `printf '{"sessionRef":"s${i}"}' > child-${i}.json`,
                        description: "Write synthetic private record", mode: "sync" });
                }
                if (step === 1) return { tools: [
                    { name: "task", args: launch(0).args },
                    { name: "ephemeral_report_progress", args: { stage: "classifying", completed: 999 } },
                    { name: "ephemeral_report_child_progress", args: { stage: "classifying", completedSessionRefs: ["foreign"] } },
                ] };
                if (step === 2 || step === 3) return tool("ephemeral_report_child_progress", {
                    stage: "classifying", completedSessionRefs: [`s${i}`],
                });
                return { content: `Private artifact child-${i}.json ready.` };
            }
            if (first) {
                first = false;
                return { tools: [{ name: "ephemeral_report_child_progress", args: { stage: "classifying", completedSessionRefs: ["s0"] } },
                    ...assignments.map((_, i) => launch(i))] };
            }
            if (!receiptRead) {
                receiptRead = true;
                const ids = body.messages.filter(message => message.role === "tool")
                    .flatMap(message => /agent_id: ([a-z0-9-]+)/i.exec(String(message.content))?.[1] ?? []);
                expect(ids).toHaveLength(20);
                return { tools: ids.map(agent_id => ({ name: "read_agent", args: { agent_id, wait: true, timeout: 30 } })) };
            }
            const done = events.filter(event => event.type === "subagent.completed");
            if (!lastLaunched && done.length) { lastLaunched = true; return { tools: [launch(20)] }; }
            const completed = new Set(done.map(event => event.agentId));
            const running = events.filter(event => event.type === "subagent.started" && !completed.has(event.agentId));
            if (running.length) return { tools: running.map(event => ({
                name: "read_agent", args: { agent_id: event.agentId, wait: true },
            })) };
            return { content: "Structured artifacts ready for host validation." };
        });
        const types = loadProviderTypes({ providers: [{ id: "template", type: "openai", baseUrl: server.baseUrl,
            models: [{ name: MODEL, supportedReasoningEfforts: ["medium"], supportedContextTiers: ["long_context"],
                contextWindowSizes: { long_context: 256000 } }] }] });
        const catalog = credentialCatalog({ name: "selected", typeId: "template", class: "shared", ownerUserId: null,
            baseUrl: null, secretRef: { value: "synthetic" } });
        const controller = new AbortController();
        let helperPid, runtimeSession, validated = false;
        try {
            const run = createEphemeralSessionRunner(catalog, () => types, { scratchRoot: scratch, signal: controller.signal,
                diagnostic: entry => diagnostics.push(entry),
                createClient(options, provider) {
                    const client = createEphemeralClient(options, provider, () => controller.abort(), () => {}, (...args) => {
                        const child = fork(...args); helperPid = child.pid; return child;
                    });
                    return { ...client, async createSession(config) {
                        runtimeSession = await client.createSession({ ...config, onEvent(event) { events.push(event); config.onEvent?.(event); } });
                        return runtimeSession;
                    } };
                } });
            const result = await run({ actor: { provider: "fixture", subject: "test" }, executionId: randomUUID(),
                model: `selected:${MODEL}`, reasoningEffort: "medium", contextTier: "long_context",
                workingDirectory: cwd, systemMessage: "Synthetic parallel assignment fixture.", prompt: "Process the assigned synthetic records.",
                nativeChildren: { maxConcurrent: 20, assignments, progressStages: ["classifying"] },
                onChildProgress: async event => {
                    progress.push(event);
                    const i = Number(event.assignmentId.slice(6));
                    expect(JSON.parse(await readFile(path.join(cwd, `child-${i}.json`), "utf8"))).toEqual({ sessionRef: `s${i}` });
                },
                onUsage: async update => updates.push(update),
                onResponse: async () => {
                    // CLI 1.0.85 replays a cancelled completion for some already
                    // finished children during teardown; count the clean ones.
                    const completed = events.filter(event => event.type === "subagent.completed" && !event.data.cancelled);
                    expect(completed).toHaveLength(21);
                    expect(new Set(completed.map(event => event.agentId)).size).toBe(21);
                    expect((await runtimeSession.rpc.tasks.list()).tasks).toEqual([]);
                    validated = true; return { action: "complete" };
                } });
            expect(validated).toBe(true);
            expect(peak).toBe(20);
            expect(events.filter(event => event.type === "subagent.started")).toHaveLength(21);
            expect(events.filter(event => event.type === "subagent.configured").every(event =>
                event.data.model === MODEL && event.data.reasoningEffort === "medium" && event.data.contextTier === "long_context")).toBe(true);
            expect(progress).toHaveLength(21);
            expect(new Set(progress.map(event => event.childId)).size).toBe(21);
            expect(progress.map(event => event.sequence)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
            expect(progress.every(event => event.iteration === 1 && event.completedSessionRefs[0] === `s${event.assignmentId.slice(6)}`)).toBe(true);
            const results = server.requests.flatMap(body => body.messages.filter(message => message.role === "tool").map(message => String(message.content)));
            expect(results.some(text => /capacity is full/.test(text))).toBe(true);
            expect(results.some(text => /Read only this execution's assigned children/.test(text))).toBe(false);
            expect(results.some(text => /duplicate or unavailable child progress/.test(text))).toBe(true);
            expect(result.usage.apiCalls).toBe(server.requests.length);
            expect(result.usage.inputTokens).toBe(server.requests.length * 20);
            expect(result.usage.outputTokens).toBe(server.requests.length * 5);
            expect(result.usageUncertain).toBe(false);
            expect(updates.filter(update => update.completed)).toHaveLength(1);
            expect(await readdir(scratch)).toEqual([]);
            expect(() => process.kill(helperPid, 0)).toThrow();
            console.log(`  native overlap=${peak}, assignments=${progress.length}, observed calls=${server.requests.length}`);
        } finally {
            controller.abort();
            await server.close();
            await rm(root, { recursive: true, force: true });
        }
    });
    for (const failure of ["cancel", "callback", "child-failure"]) it.concurrent(
        `parallel native ${failure} cancels all children before scratch cleanup and never validates`,
        { timeout: 45000 }, async () => {
            const root = path.resolve(`.ephemeral-parallel-failure-${randomUUID()}`), cwd = path.join(root, "workspace"), scratch = path.join(root, "sdk");
            await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
            const controller = new AbortController(), events = [], updates = [];
            let first = true, arrivals = 0, release, helperPid, validated = false, progressCalls = 0;
            const pending = new Promise(resolve => { release = resolve; });
            const server = await createNativeCopilotProvider(async body => {
                if (isParent(body)) {
                    if (first) {
                        first = false;
                        return { tools: [0, 1, 2].map(i => ({ name: "task", args: { name: `batch-${i}`, mode: "background",
                            agent_type: "swarm-task", description: "Synthetic failure work", prompt: `CHILD_INDEX=${i}` } })) };
                    }
                    return { content: "Parent returned before children." };
                }
                const i = Number(/CHILD_INDEX=(\d+)/.exec(body.messages.filter(message => message.role === "user")
                    .map(message => JSON.stringify(message.content)).join("\n"))?.[1]);
                if (++arrivals === 3 && failure === "cancel") controller.abort();
                if (failure === "callback" && i === 0) return tool("ephemeral_report_child_progress", { stage: "classifying", completedSessionRefs: ["s0"] });
                if (failure === "child-failure" && i === 0) throw new Error("SYNTHETIC_CHILD_FAILURE");
                await pending;
                return { content: "Child released after cleanup." };
            });
            const types = loadProviderTypes({ providers: [{ id: "template", type: "openai", baseUrl: server.baseUrl, models: [MODEL] }] });
            const catalog = credentialCatalog({ name: "selected", typeId: "template", class: "shared", ownerUserId: null,
                baseUrl: null, secretRef: { value: "synthetic" } });
            try {
                const run = createEphemeralSessionRunner(catalog, () => types, { scratchRoot: scratch, signal: controller.signal,
                    diagnostic: () => {},
                    createClient(options, provider) {
                        const client = createEphemeralClient(options, provider, () => controller.abort(), () => {}, (...args) => {
                            const child = fork(...args); helperPid = child.pid; return child;
                        });
                        return { ...client, async createSession(config) {
                            return client.createSession({ ...config, onEvent(event) { events.push(event); config.onEvent?.(event); } });
                        } };
                    } });
                await expect(run({ actor: { provider: "fixture", subject: "test" }, executionId: randomUUID(),
                    model: `selected:${MODEL}`, workingDirectory: cwd, systemMessage: "Synthetic cancellation fixture.", prompt: "Launch assigned work.",
                    nativeChildren: { maxConcurrent: 3, assignments: [0, 1, 2].map(i => ({ id: `batch-${i}`, sessionRefs: [`s${i}`] })),
                        progressStages: ["classifying"] },
                    onChildProgress: async () => { progressCalls++; throw new Error("SYNTHETIC_CALLBACK_FAILURE"); },
                    onUsage: async value => updates.push(value),
                    onResponse: async () => { validated = true; return { action: "complete" }; },
                })).rejects.toMatchObject({ code: failure === "cancel" ? "EPHEMERAL_ABORTED"
                    : failure === "callback" ? "EPHEMERAL_CALLBACK_FAILED" : "EPHEMERAL_INVOCATION_FAILED" });
                expect(validated).toBe(false);
                expect(events.filter(event => event.type === "subagent.started")).toHaveLength(3);
                expect(progressCalls).toBe(failure === "callback" ? 1 : 0);
                expect(updates.at(-1).completed).toBe(false);
                expect(updates.at(-1).usageUncertain).toBe(true);
                expect(updates.at(-1).usageDiagnostics.observedApiCalls).toBeGreaterThan(0);
                expect(await readdir(scratch)).toEqual([]);
                expect(() => process.kill(helperPid, 0)).toThrow();
                expect(() => process.kill(-helperPid, 0)).toThrow();
            } finally {
                controller.abort(); release();
                await server.close();
                await rm(root, { recursive: true, force: true });
            }
        });
    for (const [compact, automatic, policy] of [[false, false, false], [true, false, false], [false, true, false], [false, false, true]]) it(policy
        ? "denies native progress, nested tasks and detached shells without hiding their model usage"
        : automatic
        ? "qualifies automatic compaction with native tasks without persistence or lost usage observations"
        : compact
        ? "qualifies private native output, compaction, usage, progress and five repairs"
        : "qualifies full native output, Python, parent/child event-log suppression and five repairs",
    { timeout: 90000 }, async () => {
        const root = path.resolve(`.ephemeral-runtime-${randomUUID()}`);
        const cwd = path.join(root, "workspace"), scratch = path.join(root, "sdk");
        await mkdir(cwd, { recursive: true, mode: 0o700 });
        await mkdir(scratch, { mode: 0o700 });
        const canary = `private-fixture-${randomUUID()}`;
        const outputSize = 50000;
        const reasoningEffort = policy ? "medium" : "low", contextTier = policy ? "long_context" : "default";
        await writeFile(path.join(cwd, "input.txt"), canary, { mode: 0o600 });
        let parentStep = 0, childStep = 0, compactions = 0, runtimeSession;
        const privacy = [], progress = [], updates = [], diagnostics = [], events = [];
        const server = await createNativeCopilotProvider(async body => {
            privacy.push(await scan(scratch, canary));
            if (body.tool_choice === "none") {
                compactions++;
                return { content: `<summary>Local input was read, Python completed and all repair instructions remain active. ${canary}</summary>` };
            }
            if (!isParent(body)) {
                const denied = [
                    ["ephemeral_report_progress", { stage: "reading", completed: 1, total: 1 }],
                    ["task", { agent_type: "swarm-task", mode: "sync", prompt: "Do not start a nested task." }],
                    ["bash", { command: "python3 -c 'open(\"forbidden\", \"w\").write(\"unexpected\")'", mode: "async" }],
                    ["bash", { command: "python3 -c 'open(\"forbidden\", \"w\").write(\"unexpected\")'", mode: "sync", detach: true }],
                ];
                if (policy && childStep < denied.length) return tool(...denied[childStep++]);
                switch (childStep++ - (policy ? denied.length : 0)) {
                    case 0: return tool("view", { path: path.join(cwd, "input.txt") });
                    case 1: return tool("bash", { command: `python3 -c 'from pathlib import Path; Path("child.txt").write_text("child verified"); print(Path("input.txt").read_text()); print("x" * ${outputSize})'`,
                        description: "Synthetic local Python", mode: "sync" });
                    default: return { content: `Child completed ${canary}` };
                }
            }
            switch (parentStep++) {
                case 0: return tool("ephemeral_report_progress", { stage: "reading", completed: 0, total: 1 });
                case 1: return tool("view", { path: path.join(cwd, "input.txt") });
                case 2: return tool("task", { agent_type: "swarm-task", mode: "sync", name: "fixture",
                    description: "Synthetic native work", prompt: `Read local input and run Python. ${canary}` });
                default: return body.messages.at(-1)?.role === "tool"
                    ? { content: "Response ready." + (automatic ? " summary".repeat(4000) : "") }
                    : tool("ephemeral_report_progress", { stage: "reading", completed: 1, total: 1 });
            }
        });
        const types = loadProviderTypes({ providers: [{
            id: "synthetic-template", type: "openai", baseUrl: server.baseUrl,
            models: [{ name: MODEL, supportedReasoningEfforts: ["low", "medium"], supportedContextTiers: ["default", "long_context"],
                contextWindowSizes: { default: automatic ? 16384 : 128000, long_context: 256000 } }],
        }] });
        const catalog = credentialCatalog({
            name: "synthetic", typeId: "synthetic-template", class: "shared", ownerUserId: null,
            baseUrl: null, secretRef: { value: "synthetic-only-key" },
        });
        try {
            const transport = new AbortController();
            const run = createEphemeralSessionRunner(catalog, () => types, { scratchRoot: scratch,
                signal: transport.signal,
                // The ordinary case exercises the default production client path.
                createClient: compact || automatic || policy ? (options, provider) => {
                    const client = createEphemeralClient(options, provider,
                        () => transport.abort(), () => diagnostics.push({ code: "RUNTIME_LOG_SUPPRESSED" }));
                    return { ...client, async createSession(config) {
                        runtimeSession = await client.createSession({ ...config, onEvent(event) {
                            events.push(event); config.onEvent?.(event);
                        } });
                        return runtimeSession;
                    } };
                } : undefined,
                diagnostic: entry => diagnostics.push(entry) });
            const result = await run({
                actor: { provider: "fixture", subject: "test" }, executionId: randomUUID(), model: `synthetic:${MODEL}`,
                reasoningEffort, contextTier, workingDirectory: cwd, systemMessage: `Private synthetic system ${canary}`,
                prompt: `Read files and delegate synthetic work ${canary}`, progressStages: ["reading"],
                onProgress: async event => { progress.push(event); privacy.push(await scan(scratch, canary)); },
                onUsage: async update => { updates.push(update); },
                onResponse: async response => {
                    privacy.push(await scan(scratch, canary));
                    if (compact && response.iteration === 1) {
                        const result = await runtimeSession.rpc.history.compact({
                            trigger: "manual", customInstructions: `Preserve synthetic file/task and repair context. ${canary}`,
                        });
                        expect(result.success).toBe(true);
                        privacy.push(await scan(scratch, canary));
                    }
                    return response.iteration < 6 ? { action: "continue", prompt: `Repair iteration ${response.iteration}` } : { action: "complete" };
                },
            });
            expect(childStep).toBe(policy ? 7 : 3);
            const nativeResults = server.requests.filter(body => !isParent(body) && body.messages.at(-1)?.role === "tool")
                .map(body => String(body.messages.at(-1).content));
            if (policy) expect(nativeResults.slice(0, 4).every(text => /denied|unknown|unavailable|does not exist|not found/i.test(text))).toBe(true);
            expect(nativeResults.slice(policy ? 4 : 0).some(text => /denied|permission|failed|error|not found/i.test(text))).toBe(false);
            const leaks = privacy.flatMap(snapshot => snapshot.leaks);
            expect(leaks.length).toBe(0);
            expect(server.requests.some(body => JSON.stringify(body).includes("x".repeat(outputSize)))).toBe(true);
            expect(privacy.flatMap(snapshot => snapshot.files).some(file => file.includes("-copilot-tool-output-"))).toBe(false);
            if (automatic) {
                expect(compactions).toBeGreaterThan(0);
                expect(events.some(event => event.type === "session.compaction_complete" && event.data.success && event.data.trigger === "threshold")).toBe(true);
            } else {
                expect(compactions).toBe(compact ? 1 : 0);
                expect(events.filter(event => event.type === "session.compaction_complete" && event.data.success)).toHaveLength(compact ? 1 : 0);
            }
            expect(await readFile(path.join(cwd, "child.txt"), "utf8")).toBe("child verified");
            expect((await scan(cwd, canary)).files.map(file => path.relative(cwd, file)).sort()).toEqual(["child.txt", "input.txt"]);
            expect(result.turnCount).toBe(6);
            expect(updates.filter(update => update.completed)).toHaveLength(6);
            expect(new Set(updates.map(update => update.invocationId)).size).toBe(6);
            expect(privacy.flatMap(snapshot => snapshot.files).some(file => /events\.jsonl|history\.json|session-store\.db/.test(file))).toBe(false);
            const firstProgressResult = String(server.requests.filter(isParent)[1].messages.at(-1).content);
            expect(server.requests[0].tools.filter(tool => tool.function?.name === "ephemeral_report_progress")
                .map(tool => Object.keys(tool.function.parameters.properties))).toEqual([["stage", "completed", "total"]]);
            expect(firstProgressResult).toContain("Progress recorded.");
            expect(progress.length).toBe(6);
            expect(progress.map(event => event.sequence)).toEqual(progress.map((_, index) => index + 1));
            expect(new Set(progress.map(event => event.iteration)).size).toBe(6);
            expect(result.usage.inputTokens).toBe(server.requests.length * 20);
            expect(result.usage.outputTokens).toBe(server.requests.length * 5);
            expect(result.usage.apiCalls).toBe(server.requests.length);
            expect(result.usageUncertain).toBe(false);
            expect(result.usageDiagnostics.observedApiCalls).toBe(server.requests.length);
            expect(result.usageDiagnostics.apiCallCountReasons).toEqual([]);
            expect(Object.values(result.usageDiagnostics.counterReasons)).toEqual([[], [], [], []]);
            expect([...new Set(server.paths)]).toEqual(["/v1/chat/completions"]);
            expect(updates.filter(update => update.completed)).toHaveLength(6);
            expect(server.requests.every(body => body.model === MODEL && body.reasoning_effort === reasoningEffort)).toBe(true);
            if (compact || automatic || policy) expect(events.filter(event => event.type === "subagent.configured").map(event => ({
                model: event.data.model, reasoningEffort: event.data.reasoningEffort, contextTier: event.data.contextTier,
            }))).toEqual([{ model: MODEL, reasoningEffort, contextTier }]);
            expect(server.requests.filter(body => !isParent(body)).every(body => !body.tools.some(tool =>
                ["task", "ephemeral_report_progress", "spawn_agent", "store_fact", "web_search", "write_agent", "run_factory"].includes(tool.function?.name)))).toBe(true);
            expect(await readdir(scratch)).toEqual([]);
            expect((await scan(scratch, canary)).files).toEqual([]);
        } finally {
            await server.close();
            await rm(root, { recursive: true, force: true });
        }
    });
    // Why rewind is not used for ephemeral resets. conversation-mode
    // history.rewind DOES rebuild the window on a stock client, but ephemeral
    // mode routes session state through EphemeralFilesystem, which discards the
    // event log by design (src/ephemeral-filesystem.ts). rewind resolves its
    // eventId against that log, so it cannot apply here. This pins the measured
    // failure: same session, host-driven between settled turns, three batches.
    it("history.rewind cannot reset an ephemeral session: the event log is discarded by design",
        { timeout: 90000 }, async () => {
            const root = path.resolve(`.ephemeral-rewind-${randomUUID()}`);
            const cwd = path.join(root, "workspace"), state = path.join(root, "state");
            await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(state, { recursive: true, mode: 0o700 });

            // A conversation-only rewind must never touch workspace files.
            const sentinels = { "sentinel-a.txt": `A ${randomUUID()}`, "sentinel-b.json": JSON.stringify({ b: randomUUID() }) };
            for (const [name, body] of Object.entries(sentinels)) await writeFile(path.join(cwd, name), body);
            const digest = async () => Object.fromEntries(await Promise.all((await readdir(cwd)).sort().map(async name =>
                [name, createHash("sha256").update(await readFile(path.join(cwd, name))).digest("hex")])));
            const before = await digest();

            // Spoken only by the model, never by a prompt: reappearance is proof.
            const canaries = ["ALPHA-9271", "BRAVO-4416", "CHARLIE-8305"];
            const prompts = ["Analyze batch 1.", "Analyze batch 2.", "Analyze batch 3."];
            const windows = [];
            const server = await createNativeCopilotProvider(body => {
                const text = JSON.stringify(body.messages);
                windows.push({ n: body.messages.length,
                    seen: canaries.filter(canary => text.includes(canary)),
                    priorPrompts: prompts.filter((prompt, index) => index < windows.length && text.includes(prompt)),
                    summaryResidue: /summar/i.test(text) });
                return { content: `Batch ${windows.length}. ${canaries[windows.length - 1] ?? "done"}` };
            });

            let client, after;
            const rewinds = [], sessionIds = new Set();
            try {
                const filesystem = new EphemeralFilesystem(path.dirname(state), cwd);
                client = new CopilotClient({ connection: RuntimeConnection.forStdio(), mode: "empty",
                    workingDirectory: cwd,
                    sessionFs: { initialCwd: cwd, sessionStatePath: state, conventions: "posix", capabilities: { sqlite: false } },
                    useLoggedInUser: false, logLevel: "none", enableRemoteSessions: false });
                await client.start();
                expect((await client.getStatus()).version).toBe("1.0.85");
                const session = await client.createSession({ model: MODEL,
                    provider: { type: "openai", baseUrl: server.baseUrl, apiKey: "synthetic" },
                    systemMessage: { mode: "replace", content: "Synthetic probe." },
                    workingDirectory: cwd, configDirectory: state, availableTools: [],
                    createSessionFsProvider: () => filesystem });

                for (const [index, prompt] of prompts.entries()) {
                    if (index > 0) {
                        // Host-driven, between turns, session settled.
                        const points = await session.rpc.history.listRewindPoints();
                        const target = points.points?.[0];
                        rewinds.push(target
                            ? await session.rpc.history.rewind({ eventId: target.eventId, mode: "conversation" })
                            : { outcome: "no-rewind-points" });
                    }
                    sessionIds.add(session.sessionId);
                    await session.sendAndWait({ prompt });
                    sessionIds.add(session.sessionId);
                }
                after = await digest();
            } finally {
                try { await client?.stop(); } catch {}
                try { await client?.forceStop(); } catch {}
                await server.close();
                await rm(root, { recursive: true, force: true });
            }

            // One session throughout: this really is same-session reuse.
            expect(sessionIds.size).toBe(1);

            // Every rewind is refused, and refused for the event-log reason.
            expect(rewinds).toHaveLength(prompts.length - 1);
            expect(rewinds.every(value => value.outcome === "truncation-failed")).toBe(true);
            expect(rewinds.every(value => /not found in session/i.test(value.error ?? ""))).toBe(true);
            expect(rewinds.every(value => (value.restoredFiles?.length ?? 0) === 0)).toBe(true);
            expect(rewinds.every(value => (value.skippedFiles?.length ?? 0) === 0)).toBe(true);

            // ...so the window is never reset. It grows monotonically, carrying
            // every earlier model-spoken canary and every earlier batch prompt.
            expect(windows).toHaveLength(prompts.length);
            expect(windows.map(value => value.n)).toEqual([2, 4, 6]);
            expect(windows[0].seen).toEqual([]);
            expect(windows[1].seen).toEqual([canaries[0]]);
            expect(windows[2].seen).toEqual([canaries[0], canaries[1]]);
            expect(windows[2].priorPrompts).toEqual([prompts[0], prompts[1]]);

            // No summary residue either: nothing rebuilt the window at all.
            expect(windows.every(value => value.summaryResidue === false)).toBe(true);

            // The failed rewind left the workspace byte-identical.
            expect(after).toEqual(before);
        });

    // Control for the characterization above. It isolates the cause: a stock
    // CopilotClient in the DEFAULT "copilot-cli" mode, on the real filesystem,
    // with no sessionFs provider and none of PilotSwarm's ephemeral machinery,
    // behaves identically. So the limitation is NOT caused by mode:"empty" or
    // by the in-memory session filesystem -- it is a plain CLI defect, measured
    // here on the qualified 1.0.85, whose clearContext rebuilds the window one
    // turn late. (1.0.83 never rebuilds it at all.)
    // This is the minimal upstream repro; keep it dependency-free on purpose.
    it("history.clearContext rebuilds the window one turn late in a non-ephemeral session",
        { timeout: 90000 }, async () => {
            const root = path.resolve(`.nonephemeral-clear-${randomUUID()}`), cwd = path.join(root, "workspace"), home = path.join(root, "home");
            await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(home, { recursive: true, mode: 0o700 });
            // Spoken only by the model, never by a prompt: reappearance is proof.
            const canary = "ALPHA-9271";
            const windows = [];
            const server = await createNativeCopilotProvider(body => {
                windows.push(body.messages.map(message => ({ role: message.role,
                    text: typeof message.content === "string" ? message.content : JSON.stringify(message.content) })));
                return windows.length === 1
                    ? { content: `Batch 1. ${canary}`, ...tool("probe_clear", {}) }
                    : { content: `Batch ${windows.length}. done` };
            });
            let client, session, cleared, clearError;
            const events = [];
            try {
                client = new CopilotClient({
                    connection: RuntimeConnection.forStdio(),
                    workingDirectory: cwd, baseDirectory: home,
                    useLoggedInUser: false, logLevel: "none", enableRemoteSessions: false,
                });
                await client.start();
                expect((await client.getStatus()).version).toBe("1.0.85");
                session = await client.createSession({
                    model: MODEL,
                    provider: { type: "openai", baseUrl: server.baseUrl, apiKey: "synthetic" },
                    systemMessage: { mode: "replace", content: "Synthetic probe." },
                    workingDirectory: cwd, configDirectory: home,
                    onEvent(event) { if (event.type === "session.context_cleared") events.push(event.data); },
                    tools: [{
                        name: "probe_clear", description: "Clear the conversation and deliver the next batch.",
                        skipPermission: true, defer: "never",
                        parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
                        handler: async () => {
                            try {
                                cleared = await session.rpc.history.clearContext({ prompt: "Analyze batch 2." });
                                return `Cleared ${cleared.messagesCleared}.`;
                            } catch (error) { clearError = String(error?.message ?? error); return "Clear failed."; }
                        },
                    }],
                });
                await session.sendAndWait({ prompt: "Analyze batch 1." });
                // A second host turn rules out a deferred clear landing later.
                await session.sendAndWait({ prompt: "Analyze batch 3." });

                // The runtime reports success, seeds the prompt, and emits the event.
                expect(clearError).toBeUndefined();
                expect(cleared.messagesCleared).toBeGreaterThan(0);
                expect(events).toEqual([{ initialMessage: "Analyze batch 2.", messagesCleared: cleared.messagesCleared }]);

                // CLI 1.0.85 applies the clear ONE TURN LATE.
                expect(windows).toHaveLength(3);
                expect(windows.map(window => window.length)).toEqual([2, 5, 3]);

                // The seeded turn is appended to the SAME conversation and still
                // runs on the stale window: the canary is still there.
                expect(windows[1].map(message => message.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
                expect(windows[1].some(message => message.text?.includes(canary))).toBe(true);

                // Only the NEXT host turn sees a rebuilt window. The original
                // prompt, the model-spoken canary and the seed are all gone.
                expect(windows[2].map(message => message.role)).toEqual(["system", "assistant", "user"]);
                expect(windows[2].some(message => message.text?.includes(canary))).toBe(false);
                expect(windows[2].some(message => message.text?.includes("Analyze batch 1."))).toBe(false);
                expect(windows[2].some(message => message.text?.includes("Analyze batch 2."))).toBe(false);

                // ...but the assistant message that survives is the reply the model
                // wrote while the window was still stale. That residue is why a
                // clear alone is not isolation, and why PilotSwarm serves the
                // boundary turn locally with a fixed sentinel instead.
                expect(windows[2][1].role).toBe("assistant");
                expect(windows[2][1].text).toContain("Batch 2.");
            } finally {
                try { await client?.stop(); } catch { /* probe teardown */ }
                try { await client?.forceStop(); } catch { /* probe teardown */ }
                await server.close();
                await rm(root, { recursive: true, force: true });
            }
        });

    it("history.clearContext rejects between turns, while compact rebuilds the window",
        { timeout: 90000 }, async () => {
            const root = path.resolve(`.ephemeral-primitives-${randomUUID()}`), cwd = path.join(root, "workspace"), scratch = path.join(root, "sdk");
            await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
            const controller = new AbortController(), windows = [];
            let session, rejected, compacted;
            const server = await createNativeCopilotProvider(body => {
                windows.push(JSON.stringify(body.messages));
                return { content: `Answer ${windows.length}. ZULU-${windows.length}` };
            });
            const types = loadProviderTypes({ providers: [{ id: "template", type: "openai", baseUrl: server.baseUrl, models: [MODEL] }] });
            const catalog = credentialCatalog({ name: "selected", typeId: "template", class: "shared", ownerUserId: null,
                baseUrl: null, secretRef: { value: "synthetic" } });
            try {
                const run = createEphemeralSessionRunner(catalog, () => types, { scratchRoot: scratch,
                    signal: controller.signal, turnTimeoutMs: 60000, diagnostic: () => {},
                    createClient: (options, provider, onFailure, onDiagnostic) => {
                        const client = createEphemeralClient(options, provider, onFailure, onDiagnostic);
                        return { ...client, createSession: async config => (session = await client.createSession(config)) };
                    },
                });
                let turn = 0;
                await run({ actor: { provider: "fixture", subject: "test" }, executionId: randomUUID(),
                    model: `selected:${MODEL}`, workingDirectory: cwd,
                    systemMessage: "Synthetic primitive test.", prompt: "Analyze batch 1.",
                    onUsage: async () => {},
                    onResponse: async () => {
                        if (++turn > 1) return { action: "complete" };
                        // Documented contract: a clear needs a tool call in flight.
                        rejected = await session.rpc.history.clearContext({ prompt: "Analyze batch 2." })
                            .then(() => null, error => error.code);
                        compacted = await session.rpc.history.compact({});
                        return { action: "continue", prompt: "Analyze batch 2." };
                    },
                });
                expect(rejected).toBe("EPHEMERAL_INVOCATION_FAILED");
                expect(compacted.success).toBe(true);
                // compact is the only primitive that rebuilds the window here, at
                // the cost of a summarization call and its summary residue.
                expect(windows.at(-1)).not.toContain("ZULU-1");
                expect(windows.at(-1)).toContain("summarized");
            } finally {
                controller.abort();
                await server.close();
                await rm(root, { recursive: true, force: true });
            }
        });

    it("rejects invalid host authority before provider access on the default runtime path", async () => {
        let accessed = false;
        const run = createEphemeralSessionRunner({}, () => { accessed = true; return null; });
        await expect(run({})).rejects.toMatchObject({ code: "EPHEMERAL_INVALID_REQUEST" });
        expect(accessed).toBe(false);
    });
    for (const failure of ["progress", "response", "compaction", "inference"]) it(
        failure === "inference" ? "uncertain provider failure stops the real runtime without replay"
            : `${failure === "compaction" ? "cancellation during" : "callback failure during"} ${failure} stops the real runtime and reports usage only to the caller`,
        { timeout: 30000 }, async () => {
            const root = path.resolve(`.ephemeral-callback-${randomUUID()}`), cwd = path.join(root, "workspace"), scratch = path.join(root, "sdk");
            await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
            const canary = `private-fixture-${randomUUID()}`, controller = new AbortController(), updates = [], privacy = [];
            let runtimeSession, helperPid, enterCompaction, releaseCompaction, step = 0, pending;
            const compactionStarted = new Promise(resolve => { enterCompaction = resolve; });
            const heldCompaction = new Promise(resolve => { releaseCompaction = resolve; });
            const server = await createNativeCopilotProvider(async body => {
                privacy.push(await scan(scratch, canary));
                if (failure === "inference" && step++ === 0) throw new Error("SYNTHETIC_INFERENCE_FAILURE");
                if (body.tool_choice === "none") {
                    enterCompaction(); await heldCompaction;
                    return { content: `Synthetic summary ${canary}` };
                }
                return step++ === 0 ? tool("ephemeral_report_progress", { stage: "working", completed: 0 })
                    : { content: `Synthetic response ${canary}` };
            });
            const types = loadProviderTypes({ providers: [{ id: "template", type: "openai", baseUrl: server.baseUrl, models: [MODEL] }] });
            const catalog = credentialCatalog({
                name: "selected", typeId: "template", class: "shared", ownerUserId: null,
                baseUrl: null, secretRef: { value: "synthetic" },
            });
            const run = createEphemeralSessionRunner(catalog, () => types, { scratchRoot: scratch, diagnostic: () => {},
                createClient: (options, provider) => {
                    const client = createEphemeralClient(options, provider, () => controller.abort(), () => {},
                        (module, args, options) => { const child = fork(module, args, options); helperPid = child.pid; return child; });
                    return { ...client, async createSession(config) {
                        runtimeSession = await client.createSession(config); return runtimeSession;
                    } };
                },
                removeScratch: async scratch => {
                    expect(() => process.kill(helperPid, 0)).toThrow();
                    const { removeEphemeralScratch } = await import("../../dist/ephemeral-scratch.js");
                    await removeEphemeralScratch(scratch);
                },
            });
            try {
                pending = run({ actor: { provider: "fixture", subject: "user" }, executionId: randomUUID(), model: `selected:${MODEL}`,
                    workingDirectory: cwd, systemMessage: `Synthetic system ${canary}`, prompt: `Synthetic prompt ${canary}`,
                    signal: controller.signal, progressStages: ["working"],
                    onProgress: async () => {
                        privacy.push(await scan(scratch, canary));
                        if (failure === "progress") throw new Error(canary);
                    },
                    onUsage: async update => { updates.push(update); },
                    onResponse: async () => {
                        if (failure === "response" || failure === "inference") throw new Error(canary);
                        await runtimeSession.rpc.history.compact({ trigger: "manual" });
                        return { action: "complete" };
                    },
                });
                const rejected = expect(pending).rejects.toMatchObject({ code: failure === "compaction"
                    ? "EPHEMERAL_ABORTED" : failure === "inference"
                        ? expect.stringMatching(/^EPHEMERAL_(INVOCATION|CLEANUP)_FAILED$/) : "EPHEMERAL_CALLBACK_FAILED" });
                if (failure === "compaction") {
                    await compactionStarted;
                    privacy.push(await scan(scratch, canary));
                    controller.abort();
                }
                await rejected;
                expect(privacy.flatMap(snapshot => snapshot.leaks)).toEqual([]);
                expect(await readdir(scratch)).toEqual([]);
                expect(await readdir(cwd)).toEqual([]);
                expect(new Set(updates.map(update => update.invocationId)).size).toBe(1);
                if (failure !== "inference") expect(updates.some(update => update.usage.inputTokens > 0)).toBe(true);
                if (failure === "compaction" || failure === "inference") {
                    expect(updates.at(-1).usage.apiCalls).toBe(null);
                    expect(updates.at(-1).usageUncertain).toBe(true);
                    expect(updates.at(-1).usageDiagnostics.apiCallCountReasons).toContain("interrupted_call");
                }
                if (failure === "inference") expect(server.requests).toHaveLength(1);
            } finally {
                controller.abort(); releaseCompaction();
                await pending?.catch(() => {});
                await server.close(); await rm(root, { recursive: true, force: true });
            }
        });
    it("cancels the helper, CLI, native shell, Python and grandchild before removing SDK scratch", { timeout: 30000 }, async () => {
        const root = path.resolve(`.ephemeral-cancel-${randomUUID()}`), cwd = path.join(root, "workspace"), scratch = path.join(root, "sdk");
        await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
        const controller = new AbortController(), updates = [];
        const childCode = `import time; fixture=${JSON.stringify(cwd)}; time.sleep(60)`;
        const code = `import os,subprocess,sys,json; from pathlib import Path; child=subprocess.Popen([sys.executable,"-c",${JSON.stringify(childCode)}]); Path(${JSON.stringify(path.join(cwd, "pids"))}).write_text(json.dumps([os.getpid(),child.pid])); child.wait()`;
        let pythonPids = [], ownedPids = [], helperPid;
        const server = await createNativeCopilotProvider(body => {
            if (isParent(body)) return tool("task", { agent_type: "swarm-task", mode: "sync", name: "cancellation",
                description: "Synthetic cancellation", prompt: "Start the synthetic local Python process" });
            return tool("bash", { command: `python3 -c '${code}'`, description: "Await synthetic cancellation", mode: "sync" });
        });
        const types = loadProviderTypes({ providers: [{ id: "template", type: "openai", baseUrl: server.baseUrl, models: [MODEL] }] });
        const catalog = credentialCatalog({
            name: "selected", typeId: "template", class: "shared", ownerUserId: null,
            baseUrl: null, secretRef: { value: "synthetic" },
        });
        const run = createEphemeralSessionRunner(catalog, () => types, { scratchRoot: scratch,
            diagnostic: () => {},
            createClient: (options, provider) => createEphemeralClient(options, provider, () => controller.abort(), () => {},
                (module, args, options) => { const child = fork(module, args, options); helperPid = child.pid; return child; }),
            removeScratch: async scratch => {
                for (const pid of ownedPids) expect(() => process.kill(pid, 0)).toThrow();
                const { removeEphemeralScratch } = await import("../../dist/ephemeral-scratch.js");
                await removeEphemeralScratch(scratch);
            },
        });
        let pending;
        try {
            pending = run({ actor: { provider: "fixture", subject: "user" }, executionId: randomUUID(), model: `selected:${MODEL}`,
                workingDirectory: cwd, systemMessage: "Synthetic cancellation test.", prompt: "Run synthetic native task",
                signal: controller.signal, onUsage: async update => updates.push(update),
                onResponse: async () => ({ action: "complete" }) });
            const rejected = expect(pending).rejects.toMatchObject({ code: "EPHEMERAL_ABORTED" });
            for (let i = 0; i < 200; i++) {
                try { pythonPids = JSON.parse(await readFile(path.join(cwd, "pids"), "utf8")); break; }
                catch (error) { if (error.code !== "ENOENT") throw error; }
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            expect(pythonPids).toHaveLength(2);
            expect(pythonPids.every(pid => Number.isSafeInteger(pid) && pid > 0)).toBe(true);
            const processes = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
                .trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
            ownedPids = [helperPid];
            for (let index = 0; index < ownedPids.length; index++) {
                ownedPids.push(...processes.filter(([, parent]) => parent === ownedPids[index]).map(([pid]) => pid));
            }
            expect(pythonPids.every(pid => ownedPids.includes(pid))).toBe(true);
            for (const pid of ownedPids) process.kill(pid, 0);
            controller.abort();
            await rejected;
            for (const pid of ownedPids) expect(() => process.kill(pid, 0)).toThrow();
            expect(new Set(updates.map(update => update.invocationId)).size).toBe(1);
            expect(updates.some(update => update.usage.inputTokens > 0)).toBe(true);
            expect(updates.at(-1).usageUncertain).toBe(true);
            expect(updates.at(-1).completed).toBe(false);
            expect(await readdir(scratch)).toEqual([]);
        } finally {
            controller.abort();
            await pending?.catch(() => {});
            for (const pythonPid of pythonPids) {
                // On a failed cancellation qualification, clean only the exact
                // synthetic process whose command still contains this test path.
                try {
                    const command = execFileSync("/bin/ps", ["-p", String(pythonPid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
                    if (command.includes(cwd)) process.kill(pythonPid, "SIGKILL");
                } catch { /* Already reaped. */ }
            }
            await server.close(); await rm(root, { recursive: true, force: true });
        }
    });
});

describe("ephemeral inter-batch context reset (CLI 1.0.85 delayed clear)", () => {
    // 2 and 4 boundaries stand in for the B20 and B10 partitions.
    for (const batches of [2, 4]) it.concurrent(
        `${batches} batches: one session, no prior prompt or model-spoken canary survives a boundary`,
        { timeout: 180000 }, async () => {
            const root = path.resolve(`.ephemeral-reset-${randomUUID()}`), cwd = path.join(root, "workspace"), scratch = path.join(root, "sdk");
            await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
            const sentinelFile = path.join(cwd, "artifact.txt");
            await writeFile(sentinelFile, "preserved-artifact", { mode: 0o600 });
            const before = createHash("sha256").update(await readFile(sentinelFile)).digest("hex");

            // Canaries are spoken only by the model, never by any prompt, so
            // finding one in a later request proves real carryover.
            const canaries = Array.from({ length: batches }, (_value, index) => `CANARY-${index}-${randomUUID().slice(0, 8)}`);
            const prompts = Array.from({ length: batches }, (_value, index) => `BATCH ${index} WORK ${randomUUID().slice(0, 8)}`);
            // A deterministic neutral reply for the seeded turn. It is the one
            // message the runtime carries across a boundary, so the test pins
            // what it is rather than assuming there is nothing there.
            const SEEDED_REPLY = "Ready for the next instruction.";
            const sessions = new Set(), events = [], phases = [];
            const server = await createNativeCopilotProvider(body => {
                // Every request is classified by what the runtime actually sent,
                // never by a counter: the phase sequence is a measurement.
                const last = body.messages.at(-1) ?? {};
                const text = String(last.content ?? "");
                const index = prompts.findIndex(prompt => text.includes(prompt));
                if (index >= 0) { phases.push(`batch-${index}`); return { content: `Finished batch ${index}. ${canaries[index]}` }; }
                if (text.includes(RESET_PROMPT)) { phases.push("reset-call"); return { tools: [{ name: RESET_TOOL, args: {} }] }; }
                if (last.role === "tool") { phases.push("reset-tool-result"); return { content: SEEDED_REPLY }; }
                if (text.includes(RESET_SEED)) { phases.push("reset-seeded"); return { content: SEEDED_REPLY }; }
                phases.push("unexpected"); return { content: "UNEXPECTED" };
            });
            const types = loadProviderTypes({ providers: [{
                id: "template", type: "openai", baseUrl: server.baseUrl, models: [MODEL],
            }] });
            const catalog = credentialCatalog({
                name: "synthetic", typeId: "template", class: "shared", ownerUserId: null,
                baseUrl: null, secretRef: { value: "synthetic-only-key" },
            });
            try {
                const run = createEphemeralSessionRunner(catalog, () => types, {
                    scratchRoot: scratch,
                    createClient: (options, provider) => {
                        const client = createEphemeralClient(options, provider, () => {}, () => {});
                        return { ...client, async createSession(config) {
                            const session = await client.createSession({ ...config, onEvent(event) {
                                events.push(event); config.onEvent?.(event);
                            } });
                            sessions.add(session.sessionId);
                            return session;
                        } };
                    },
                });
                let turn = 0;
                const responses = [];
                const result = await run({
                    actor: { provider: "fixture", subject: "test" }, executionId: randomUUID(), model: `synthetic:${MODEL}`,
                    workingDirectory: cwd, systemMessage: "Private synthetic system", prompt: prompts[0],
                    contextReset: true,
                    onResponse: async value => {
                        responses.push(value.text);
                        turn++;
                        return turn < batches ? { action: "clear_context", prompt: prompts[turn] } : { action: "complete" };
                    },
                });
                expect(result.text).toContain(canaries[batches - 1]);
                // Every batch was delivered and answered, and the internal reset
                // turns never surfaced as host-visible batch results.
                expect(responses.length).toBe(batches);
                expect(result.turnCount).toBe(batches);
                expect(responses.some(text => text.includes(SEEDED_REPLY))).toBe(false);

                // One session, reused across every boundary.
                expect(sessions.size).toBe(1);

                const real = server.requests.filter(body => prompts.some(prompt =>
                    String(body.messages.at(-1)?.content ?? "").includes(prompt)));
                expect(real.length).toBe(batches);
                for (let index = 1; index < batches; index++) {
                    const window = JSON.stringify(real[index]);
                    // No earlier batch's prompt and no earlier model-spoken canary.
                    for (let prior = 0; prior < index; prior++) {
                        expect(window).not.toContain(canaries[prior]);
                        expect(window).not.toContain(prompts[prior]);
                    }
                    // The seed itself is gone too, and the only assistant residue
                    // is the seeded turn's reply. That reply is model-written and
                    // was produced against the stale window, so this pins what
                    // survives rather than claiming nothing does.
                    expect(window).not.toContain(RESET_SEED);
                    expect(window).not.toContain(RESET_PROMPT);
                    const assistants = real[index].messages.filter(message => message.role === "assistant");
                    expect(assistants.map(message => String(message.content ?? ""))).toEqual([SEEDED_REPLY]);
                    // System instruction survives the boundary.
                    expect(real[index].messages[0].role).toBe("system");
                    expect(JSON.stringify(real[index].messages[0])).toContain("Private synthetic system");
                }
                // A reset actually happened, once per boundary, and is observable
                // by the host without inspecting prompt text.
                expect(events.filter(event => event.type === "session.context_cleared").length).toBe(batches - 1);
                expect(events.filter(event => event.type === "session.context_cleared")
                    .every(event => Number.isSafeInteger(event.data.messagesCleared) && event.data.messagesCleared > 0)).toBe(true);

                // Measured, not presumed: the phase sequence and the reported
                // usage must agree with the requests the provider actually saw.
                expect(phases.filter(phase => phase === "unexpected")).toEqual([]);
                expect(phases.filter(phase => phase.startsWith("batch-")).length).toBe(batches);
                expect(phases.filter(phase => phase === "reset-call").length).toBe(batches - 1);
                expect(result.usage.apiCalls).toBe(server.requests.length);
                // eslint-disable-next-line no-console
                console.log(`  reset phase sequence (${batches} batches):`, phases.join(" -> "),
                    `| requests=${server.requests.length} apiCalls=${result.usage.apiCalls}`,
                    `| windows=${JSON.stringify(server.requests.map(body => body.messages.length))}`);

                // Isolation and artifacts are untouched by the boundary.
                const { files } = await scan(scratch, "never-present");
                expect(files.some(file => /events.*\.jsonl$/.test(file) && !file.endsWith("-blank"))).toBe(false);
                expect(createHash("sha256").update(await readFile(sentinelFile)).digest("hex")).toBe(before);
            } finally {
                await server.close();
                await rm(root, { recursive: true, force: true });
            }
        });
});
