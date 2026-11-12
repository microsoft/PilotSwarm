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
import { readWorkflowPackagePins } from "../../src/workflow/package-pins.ts";
import { readWorkflowModel } from "../../src/workflow/tools.ts";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "fb032-pins-fixture-owner" };
const OTHER = { provider: "test", subject: "fb032-pins-publisher" };
const TOOLS = { a: "fb032_pinned_a", b: "fb032_pinned_b" };

function writePackage(dir, name, label, version, hook) {
    mkdirSync(join(dir, "tools"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name, version, description: "Isolated Workflow pin fixture." }));
    writeFileSync(join(dir, "tools", "worker-module.js"), `export default { createTools() {
        return [{ name: ${JSON.stringify(TOOLS[label])}, description: "Harmless versioned fixture.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            handler: async () => globalThis[${JSON.stringify(hook)}](${JSON.stringify(label)}, ${JSON.stringify(version)}) }];
    } };`);
    return dir;
}

describe("Workflow tool package pins", () => {
    it.each([
        ["republish A", null],
        ["republish unrelated selected B", null],
        ["rollback A", null],
        ["remove parent selection", null],
        ["disable A", "disabled"],
        ["delete A", "deleted"],
        ["make A private", "private"],
        ["legacy delete A after first open", "deleted"],
        ["legacy A deleted before first open", "deleted"],
        ["handled deletion", "deleted"],
    ])("%s preserves the fixed grant except the lost package", { timeout: 150_000 }, async (mutation, reason) => {
        const env = getEnv();
        const tag = randomUUID();
        const hook = `fb032_pins_${tag}`;
        const names = { a: `fb032-pins-a-${tag}`, b: `fb032-pins-b-${tag}` };
        const packageOwner = mutation === "make A private" ? OTHER : OWNER;
        const firstCall = Promise.withResolvers();
        const releaseCall = Promise.withResolvers();
        const calls = [];
        globalThis[hook] = async (label, version) => {
            calls.push({ label, version });
            if (calls.length === 1) {
                firstCall.resolve();
                await releaseCall.promise;
            }
            return { label, version };
        };
        const catalog = await createCatalog(env);
        const registry = { catalog, artifactStore: new FilesystemArtifactStore(join(dirname(env.sessionStateDir), "artifacts")) };
        const publish = (label, version) => publishAgentPackageDir(registry, {
            dir: writePackage(join(env.baseDir, `${label}-${tag}-${version}`), names[label], label, version, hook),
            scope: label === "a" && mutation === "make A private" ? "shared" : "user",
            owner: label === "a" ? packageOwner : OWNER, createdBy: "fb032-pins-fixture", isAdmin: false,
        });
        try {
            let a = await publish("a", "1.0.0");
            const b = await publish("b", "1.0.0");
            if (mutation === "rollback A") a = await publish("a", "1.1.0");
            await withScriptedModel(env, {
                worker: { logLevel: "warning", agentPackages: {
                    cacheDir: join(env.baseDir, `cache-${tag}`), refreshIntervalMs: 0,
                } },
                respond: () => ({ content: "ok" }),
            }, async ({ client, worker, qualifiedModel }) => {
                const manager = worker.sessionManager;
                const parent = await client.createSession({ owner: OWNER, model: qualifiedModel, toolNames: [] });
                expect(await parent.sendAndWait("Prepare isolated package fixtures.", 30_000)).toBe("ok");
                const activate = manager.sessions.get(parent.sessionId).config.capabilityServices.use;
                await activate({
                    source_ref: capabilityRef(a.packageId, a.sha256, "source"), tools: [TOOLS.a],
                    expected_revision: 0, request_id: "select-a",
                });
                await activate({
                    source_ref: capabilityRef(b.packageId, b.sha256, "source"), tools: [TOOLS.b],
                    expected_revision: 1, request_id: "select-b",
                });
                expect(await parent.sendAndWait("Refresh the selected package fixtures.", 30_000)).toBe("ok");
                const binding = await manager.captureWorkflowToolBinding(parent.sessionId);
                const legacy = mutation.startsWith("legacy");
                if (legacy) {
                    delete binding.packagePins;
                    delete binding.toolSources;
                    delete binding.agentStepTools;
                }
                if (mutation === "legacy A deleted before first open") await catalog.deleteAgentPackage(names.a, packageOwner, false);
                const callsSource = reason
                    ? `await callTool("${TOOLS.b}", {}); await callTool("${TOOLS.b}", {}); await callTool("${TOOLS.a}", {});`
                    : `await callTool("${TOOLS.a}", {}); const result = await callTool("${TOOLS.a}", {}); await setResult("done", result);`;
                const source = mutation === "handled deletion"
                    ? `try { ${callsSource} } catch (error) { await setResult("done", { handled: error.message }); }` : callsSource;
                const workflow = await createWorkflow({
                    catalog: worker._catalog, store: worker._catalog.workflowStore(),
                    duroxideClient: client._getDuroxideClient(),
                }, {
                    workflowSessionId: randomUUID(), parentSessionId: parent.sessionId, binding,
                    yaml: JSON.stringify({
                        apiVersion: "pilotswarm.dev/v1", kind: "Workflow",
                        metadata: { name: "fixed-package-pins", version: "1.0.0" }, initial: "call",
                        states: {
                            call: { type: "script", timeoutSeconds: 75, source,
                                transition: { next: { done: "complete", failure: "failed" } } },
                            complete: { type: "terminal", outcome: "succeeded" },
                            failed: { type: "terminal", outcome: "failed" },
                        },
                    }),
                    actor: { kind: "system", name: "fb032-pins-fixture" }, operationId: "create",
                    publish: true, notifyParent: false, start: { inputs: {} },
                });
                const pending = client._getDuroxideClient().waitForOrchestration(workflow.receipt.run.controllerInstanceId, 100_000);
                await Promise.race([firstCall.promise, pending]);
                expect(calls).toHaveLength(1);
                if (legacy) {
                    const creation = await worker._catalog.getSessionCreationConfig(workflow.receipt.workflowSessionId);
                    expect(creation.workflowToolBinding).toEqual(binding);
                    if (mutation !== "legacy A deleted before first open") {
                        expect(creation.workflowToolLabels.packagePins[a.packageId])
                            .toEqual({ package: names.a, version: "1.0.0", ownership: "owned" });
                        expect(creation.workflowToolLabels.toolSources[TOOLS.a]).toBe(a.packageId);
                    }
                }
                try {
                    if (mutation === "republish A") await publish("a", "1.1.0");
                    if (mutation === "republish unrelated selected B") await publish("b", "1.1.0");
                    if (mutation === "rollback A") await catalog.pinAgentPackageVersion(names.a, "1.0.0", packageOwner, false);
                    if (mutation === "disable A") await catalog.setAgentPackageEnabled(names.a, false, packageOwner, false);
                    if (mutation === "delete A") await catalog.deleteAgentPackage(names.a, packageOwner, false);
                    if (mutation === "legacy delete A after first open" || mutation === "handled deletion") {
                        await catalog.deleteAgentPackage(names.a, packageOwner, false);
                    }
                    if (mutation === "make A private") await catalog.setAgentPackageScope(names.a, "user", packageOwner, false);
                    if (mutation === "remove parent selection") {
                        const removal = {
                        source_ref: capabilityRef(a.packageId, a.sha256, "source"), tools: [TOOLS.a],
                        action: "remove", expected_revision: 2, request_id: "remove-a",
                        };
                        const reply = await activate(removal);
                        const expected = [{ workflowId: workflow.receipt.workflowSessionId, name: "fixed-package-pins",
                            package: names.a, version: "1.0.0" }];
                        expect(reply.stillPinnedBy).toEqual(expected);
                        expect((await activate(removal)).stillPinnedBy).toEqual(expected);
                    }
                    await worker.refreshAgentPackages({ force: true });
                    const id = workflow.receipt.workflowSessionId;
                    const view = await readWorkflowModel({
                        store: worker._catalog.workflowStore(),
                        readPackagePins: session => readWorkflowPackagePins(worker._catalog, session),
                    }, id, {}, "api");
                    const shown = view.pins.find(pin => pin.packageId === a.packageId);
                    expect(shown).toMatchObject({
                        revision: a.sha256, state: reason ? "unavailable"
                            : mutation === "republish A" ? "newer_available"
                            : mutation === "rollback A" ? "rolled_back" : "current",
                        ...(reason ? { reason } : {}),
                    });
                    if (mutation === "legacy A deleted before first open") {
                        expect(shown).toMatchObject({ package: null, version: null, ownership: null });
                    } else {
                        expect(shown).toMatchObject({ package: names.a, version: mutation === "rollback A" ? "1.1.0" : "1.0.0",
                            ownership: mutation === "make A private" ? "other_shared" : "owned" });
                    }
                } finally {
                    releaseCall.resolve();
                }
                await pending;
                const store = worker._catalog.workflowStore();
                const run = await store.readRun(workflow.receipt.run.runId);
                const nodes = await store.listNodeExecutions(run.runId);
                const script = nodes.find(node => node.nodeId === "call");
                console.info("FB032_PINS", JSON.stringify({ mutation, calls, runStatus: run.status, scriptError: script?.error }));
                if (!reason) {
                    const version = mutation === "rollback A" ? "1.1.0" : "1.0.0";
                    expect(calls).toEqual([{ label: "a", version }, { label: "a", version }]);
                    expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
                } else if (mutation === "handled deletion") {
                    expect(calls).toEqual([{ label: "b", version: "1.0.0" }, { label: "b", version: "1.0.0" }]);
                    expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
                    expect(script.error).toBeNull();
                } else {
                    expect(calls).toEqual([{ label: "b", version: "1.0.0" }, { label: "b", version: "1.0.0" }]);
                    const words = {
                        disabled: "was disabled", deleted: "was deleted", private: "is now private to its owner",
                    };
                    expect(script.error).toMatchObject({
                        code: "execution_failed",
                        message: mutation === "legacy A deleted before first open"
                            ? `Tool '${TOOLS.a}' is not available. This Workflow is pinned to a package version that was deleted (package id ${a.packageId}, revision ${a.sha256.slice(0, 12)}). Its name and version number were not recorded. Start a new Workflow to use a current version.`
                            : `Tool '${TOOLS.a}' is not available. This Workflow is pinned to ${names.a} 1.0.0, and that version ${words[reason]}. Start a new Workflow to use a current version.`,
                        details: { package: mutation === "legacy A deleted before first open" ? null : names.a,
                            version: mutation === "legacy A deleted before first open" ? null : "1.0.0", revision: a.sha256, reason },
                    });
                    expect(run).toMatchObject({ status: "failed", terminalOutcome: "failed" });
                }
            });
        } finally {
            releaseCall.resolve();
            delete globalThis[hook];
            await catalog.close();
        }
    });
});
