import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { capabilityRef } from "../../src/capability-catalog.ts";
import { createWorkflow } from "../../src/workflow/service.ts";
import { FilesystemArtifactStore, publishAgentPackageDir } from "../../src/index.ts";
import { createCatalog } from "../helpers/cms-helpers.js";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "fb033-fixture-owner" };
const OTHER = { provider: "test", subject: "fb033-unrelated-fixture-owner" };
const TOOL = "fb033_unchanged_tool";

function writePackage(dir, name, version, module) {
    mkdirSync(join(dir, "tools"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name, version, description: "Isolated reload fixture." }));
    writeFileSync(join(dir, "tools", "worker-module.js"), module);
    return dir;
}

describe("unchanged package tool across real registry watcher reload", () => {
    it.each([
        ...["factory", "constant"].flatMap(kind =>
            ["ordinary two turns", "ordinary one turn", "script two calls"].map(path => [kind, path, "unrelated reload", null])),
        ["factory", "ordinary one turn", "new A revision", "Package tool changed or access was revoked; refresh session capabilities"],
        ["factory", "ordinary one turn", "selection removed", "Package tool selection was removed"],
        ["factory", "ordinary one turn", "package disabled", "Package tool changed or access was revoked; refresh session capabilities"],
    ])("%s: %s: %s", { timeout: 120_000 }, async (kind, path, mutation, expectedRefusal) => {
        const env = getEnv();
        const tag = randomUUID();
        const hook = `fb033_${tag}`;
        const calls = [];
        const firstCall = Promise.withResolvers();
        const releaseCall = Promise.withResolvers();
        const reloaded = Promise.withResolvers();
        const blocked = path !== "ordinary two turns";
        globalThis[hook] = async () => {
            calls.push({ version: "1.0.0", at: new Date().toISOString() });
            firstCall.resolve();
            if (blocked && calls.length === 1) await releaseCall.promise;
            return { version: "1.0.0", calls: calls.length };
        };
        const tools = `[{ name: "${TOOL}", description: "Unchanged harmless package tool.",
parameters: { type: "object", properties: {}, additionalProperties: false },
handler: async () => globalThis[${JSON.stringify(hook)}]() }]`;
        const module = kind === "factory"
            ? `export default { createTools() { return ${tools}; } };`
            : `export const tools = ${tools};`;
        const catalog = await createCatalog(env);
        const registry = { catalog, artifactStore: new FilesystemArtifactStore(join(dirname(env.sessionStateDir), "artifacts")) };
        const packageA = await publishAgentPackageDir(registry, {
            dir: writePackage(join(env.baseDir, `a-${tag}`), `fb033-a-${tag}`, "1.0.0", module),
            scope: "user", owner: OWNER, createdBy: "fb033-fixture", isAdmin: false,
        });
        const publishB = version => publishAgentPackageDir(registry, {
            dir: writePackage(join(env.baseDir, `b-${tag}-${version}`), `fb033-b-${tag}`, version,
                "export const tools = [{ name: 'fb033_unused_tool', description: 'Unused fixture.', parameters: { type: 'object', properties: {} }, handler: async () => 'unused' }];"),
            scope: "user", owner: OTHER, createdBy: "fb033-fixture", isAdmin: false,
        });
        const initialB = await publishB("1.0.0");
        let phase = "prepare";
        const results = [];
        try {
            await withScriptedModel(env, {
                worker: { logLevel: "warning", agentPackages: {
                    cacheDir: join(env.baseDir, `cache-${tag}`), refreshIntervalMs: 500,
                } },
                respond: (body, position) => {
                    if (phase === "prepare") return { content: "ok" };
                    if (position.step === 0 || (path === "ordinary one turn" && position.step === 1)) {
                        const offered = body.tools.find(value => value.function?.name?.endsWith(TOOL));
                        if (!offered) throw new Error("The published fixture tool was not offered.");
                        return { tools: [{ name: offered.function.name, args: {} }] };
                    }
                    results.push({ phase, results: position.toolResults });
                    return { content: "ok" };
                },
            }, async ({ client, worker, qualifiedModel }) => {
                const manager = worker.sessionManager;
                const sources = () => manager.workerDefaults.getCapabilitySources();
                const initialTool = sources().find(source => source.id === packageA.packageId)?.tools.get(TOOL);
                expect(initialTool).toBeTruthy();
                const originalRefresh = worker.refreshAgentPackages.bind(worker);
                let targetEpoch = null;
                worker.refreshAgentPackages = async (...args) => {
                    await originalRefresh(...args);
                    if (targetEpoch !== null && worker._agentPackagesEpoch >= targetEpoch) reloaded.resolve();
                };
                const parent = await client.createSession({ owner: OWNER, model: qualifiedModel, toolNames: [] });
                expect(await parent.sendAndWait("Prepare the real published fixtures.", 30_000)).toBe("ok");
                const capabilities = manager.sessions.get(parent.sessionId).config.capabilityServices;
                await capabilities.use({
                    source_ref: capabilityRef(packageA.packageId, packageA.sha256, "source"), tools: [TOOL],
                    expected_revision: 0, request_id: "activate-real-fixture-a",
                });
                let workflow;
                let pending;
                let firstHandle;
                if (path === "script two calls") {
                    expect(await parent.sendAndWait("Refresh the activated real fixture.", 30_000)).toBe("ok");
                    const binding = await manager.captureWorkflowToolBinding(parent.sessionId);
                    expect(binding.sourceRevisions[packageA.packageId]).toBe(packageA.sha256);
                    expect(Object.keys(binding.sourceRevisions)).not.toContain(initialB.packageId);
                    workflow = await createWorkflow({
                        catalog: worker._catalog, store: worker._catalog.workflowStore(),
                        duroxideClient: client._getDuroxideClient(),
                    }, {
                        workflowSessionId: randomUUID(), parentSessionId: parent.sessionId, binding,
                        yaml: JSON.stringify({
                            apiVersion: "pilotswarm.dev/v1", kind: "Workflow",
                            metadata: { name: "real-registry-reload", version: "1.0.0" }, initial: "call",
                            states: {
                                call: { type: "script", timeoutSeconds: 45,
                                    source: `await callTool("${TOOL}", {}); const result = await callTool("${TOOL}", {}); await setResult("done", result);`,
                                    transition: { next: { done: "complete", failure: "failed" } } },
                                complete: { type: "terminal", outcome: "succeeded" },
                                failed: { type: "terminal", outcome: "failed" },
                            },
                        }),
                        actor: { kind: "system", name: "fb033-fixture" }, operationId: "create",
                        publish: true, notifyParent: false, start: { inputs: {} },
                    });
                    pending = client._getDuroxideClient().waitForOrchestration(workflow.receipt.run.controllerInstanceId, 90_000);
                } else {
                    phase = "first";
                    pending = parent.sendAndWait("Call the unchanged package tool.", 45_000);
                }
                await Promise.race([firstCall.promise, pending]);
                expect(calls).toHaveLength(1);
                if (!blocked) {
                    expect(await pending).toBe("ok");
                    firstHandle = manager.sessions.get(parent.sessionId);
                }
                const epochBefore = await catalog.agentRegistryEpoch();
                if (mutation === "new A revision") {
                    await publishAgentPackageDir(registry, {
                        dir: writePackage(join(env.baseDir, `a-${tag}-new`), `fb033-a-${tag}`, "1.1.0", module),
                        scope: "user", owner: OWNER, createdBy: "fb033-fixture", isAdmin: false,
                    });
                } else if (mutation === "package disabled") {
                    await catalog.setAgentPackageEnabled(`fb033-a-${tag}`, false, OWNER, false);
                } else {
                    if (mutation === "selection removed") await capabilities.use({
                        source_ref: capabilityRef(packageA.packageId, packageA.sha256, "source"), tools: [TOOL],
                        action: "remove", expected_revision: 1, request_id: "remove-real-fixture-a",
                    });
                    await publishB("1.1.0");
                }
                targetEpoch = await catalog.agentRegistryEpoch();
                expect(targetEpoch).toBeGreaterThan(epochBefore);
                if (worker._agentPackagesEpoch >= targetEpoch) reloaded.resolve();
                try { await reloaded.promise; }
                finally { releaseCall.resolve(); }
                const liveSource = sources().find(source => source.id === packageA.packageId);
                if (mutation === "package disabled") expect(liveSource).toBeUndefined();
                else if (mutation === "new A revision") expect(liveSource.revision).not.toBe(packageA.sha256);
                else expect(liveSource.revision).toBe(packageA.sha256);
                const identityChanged = liveSource?.tools.get(TOOL) !== initialTool;
                expect(identityChanged).toBe(kind === "factory");
                if (!blocked) {
                    phase = "second";
                    pending = parent.sendAndWait("Call the unchanged package tool after the watcher reload.", 45_000);
                }
                const ended = await pending;
                const run = workflow ? await worker._catalog.workflowStore().readRun(workflow.receipt.run.runId) : null;
                const nodes = run ? await worker._catalog.workflowStore().listNodeExecutions(run.runId) : [];
                console.info("FB033_REPRO", JSON.stringify({
                    kind, path, mutation, epochBefore, targetEpoch, workerEpoch: worker._agentPackagesEpoch,
                    aRevision: liveSource?.revision ?? null, identityChanged, calls, results,
                    sameManagedHandle: firstHandle ? manager.sessions.get(parent.sessionId) === firstHandle : null,
                    controllerStatus: run ? ended.status : null, runStatus: run?.status ?? null,
                    nodes: nodes.map(node => ({ outcome: node.outcome, error: node.error })),
                }));
                expect(calls).toHaveLength(expectedRefusal ? 1 : 2);
                if (expectedRefusal) expect(JSON.stringify(results)).toContain(expectedRefusal);
                if (run) expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
                else expect(ended).toBe("ok");
            });
        } finally {
            releaseCall.resolve();
            delete globalThis[hook];
            await catalog.close();
        }
    });
});
