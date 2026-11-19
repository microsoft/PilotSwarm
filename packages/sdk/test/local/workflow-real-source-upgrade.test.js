import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { startScriptedModel, systemText } from "../helpers/scripted-model.mjs";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "real-source-upgrade" };
const TOOL = "upgrade_fixture_echo";
const AGENT = "upgrade-narrow";
const roots = {
    old: process.env.PS_UPGRADE_OLD_ROOT,
    current: process.env.PS_UPGRADE_CURRENT_ROOT,
};

async function moduleAt(root, path) {
    if (!root) throw new Error("Real-source upgrade requires PS_UPGRADE_OLD_ROOT and PS_UPGRADE_CURRENT_ROOT.");
    return import(/* @vite-ignore */ `${root}/packages/sdk/${path}`);
}

function workflow() {
    return JSON.stringify({
        apiVersion: "pilotswarm.dev/v1", kind: "Workflow",
        metadata: { name: "real-source-upgrade", version: "1.0.0" }, initial: "gate",
        contracts: { "Gate@1": { schema: true } },
        states: {
            gate: { type: "messaging", mode: "receive", contract: "Gate@1",
                transition: { next: { received: "inline", failure: "failed" } } },
            narrow: { type: "agent", invoke: { agent: { name: AGENT, package: "upgrade-plugin" } }, outcomes: ["done"], timeoutSeconds: 120,
                transition: { next: { done: "done", failure: "failed" } } },
            inline: { type: "agent", invoke: { prompt: "INLINE_UPGRADE_CONTROL" }, outcomes: ["done"], timeoutSeconds: 120,
                transition: { next: { done: "narrow", failure: "failed" } } },
            done: { type: "terminal", outcome: "succeeded" },
            failed: { type: "terminal", outcome: "failed" },
        },
    });
}

describe.skipIf(!roots.old && !roots.current)("actual old-code Workflow Start continued on Release A", () => {
    it.each([false, true])("keeps a named step's declared tools separate from the inline step (republish=%s)",
        { timeout: 300_000 }, async republish => {
        const env = getEnv();
        expect(isAbsolute(roots.old ?? "")).toBe(true);
        expect(isAbsolute(roots.current ?? "")).toBe(true);
        expect(roots.old).not.toBe(roots.current);
        expect((await moduleAt(roots.old, "src/orchestration-version.ts")).DURABLE_SESSION_LATEST_VERSION).toBe("1.0.83");
        expect((await moduleAt(roots.current, "src/orchestration-version.ts")).DURABLE_SESSION_LATEST_VERSION).toBe("1.0.84");
        const turns = [];
        const parentOffers = [];
        const traces = [];
        const model = await startScriptedModel({ respond: (body, position) => {
            const tools = (body.tools ?? []).map(tool => tool.function?.name).filter(Boolean);
            if (!tools.includes("complete_workflow_node")) {
                parentOffers.push(tools);
                return { content: "ok" };
            }
            const invocation = JSON.parse(position.lastUserText.split("\n").find(line =>
                line.startsWith('{"workflowSessionId":')));
            if (position.step === 0) {
                turns.push({ nodeExecutionId: invocation.nodeExecutionId, tools, prompt: position.lastUserText,
                    system: systemText(body), inputTools: invocation.input?.tools });
                const execution = /"nodeExecutionId":"(nx-[a-f0-9]+)"/.exec(position.lastUserText)?.[1];
                expect(execution).toBeDefined();
                return { tools: [{ name: "complete_workflow_node", args: {
                    node_execution_id: execution, outcome: "done", output: { tools }, operation_id: `finish-${turns.length}`,
                } }] };
            }
            const turn = turns.find(item => item.nodeExecutionId === invocation.nodeExecutionId);
            turn.result = position.toolResults.at(-1);
            console.info("UPGRADE_TURN_EVIDENCE", JSON.stringify(turn));
            return { content: "STATE_COMPLETED" };
        } });
        const pluginDir = join(env.baseDir, "upgrade-plugin");
        mkdirSync(join(pluginDir, "agents"), { recursive: true });
        writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name: "upgrade-plugin", version: "1.0.0" }));
        writeFileSync(join(pluginDir, "agents", `${AGENT}.agent.md`),
            `---\nname: ${AGENT}\ndescription: Harmless narrow upgrade probe.\ntools: [read_facts]\n---\nNARROW_UPGRADE_MARKER\n`);
        mkdirSync(join(pluginDir, "tools"), { recursive: true });
        writeFileSync(join(pluginDir, "tools", "worker-module.js"), `export default { createTools: () => [{
            name: "${TOOL}", description: "Harmless upgrade fixture.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            handler: async () => ({ harmless: true }),
        }] };`);
        const common = { workerPool: "default", logLevel: "warning",
            agentPackages: { cacheDir: join(env.baseDir, "upgrade-package-cache"), refreshIntervalMs: 0 },
            traceWriter: line => { traces.push(String(line)); if (traces.length > 100) traces.shift(); } };
        let created;
        let oldBinding;
        let parentId;
        try {
            const oldHelpers = await moduleAt(roots.old, "test/helpers/scripted-workers.js");
            const providerPath = await oldHelpers.registerScriptedProvider(env, model.baseUrl);
            const oldSdk = await moduleAt(roots.old, "src/index.ts");
            const { createCatalog } = await moduleAt(roots.old, "test/helpers/cms-helpers.js");
            const registryCatalog = await createCatalog(env);
            try {
                await oldSdk.publishAgentPackageDir({ catalog: registryCatalog,
                    artifactStore: new oldSdk.FilesystemArtifactStore(join(env.baseDir, "artifacts")) }, {
                    dir: pluginDir, scope: "user", owner: OWNER, createdBy: "actual-old-source", isAdmin: false,
                });
            } finally {
                await registryCatalog.close();
            }
            const oldWorkers = await moduleAt(roots.old, "test/helpers/local-workers.js");
            await oldWorkers.withClient(env, { worker: { ...common, modelProvidersPath: providerPath },
                client: { modelProvidersPath: providerPath } }, async (client, worker) => {
                const source = worker.sessionManager.workerDefaults.getCapabilitySources().find(item =>
                    item.name === "upgrade-plugin" && item.source === "published");
                expect(source).toBeDefined();
                const parent = await client.createSession({ owner: OWNER, model: oldHelpers.FIXTURE_QUALIFIED_MODEL });
                parentId = parent.sessionId;
                expect(await parent.sendAndWait("Prepare source upgrade.", 30_000)).toBe("ok");
                const { capabilityRef } = await moduleAt(roots.old, "src/capability-catalog.ts");
                await worker.sessionManager.sessions.get(parentId).config.capabilityServices.use({
                    source_ref: capabilityRef(source.id, source.revision, "source"), tools: [TOOL],
                    expected_revision: 0, request_id: "activate-upgrade-fixture",
                });
                expect(await parent.sendAndWait("Refresh source upgrade selections.", 30_000)).toBe("ok");
                expect(parentOffers.at(-1)).toContain(TOOL);
                expect((await client._getDuroxideClient().getInstanceInfo(`session-${parentId}`)).orchestrationVersion)
                    .toBe("1.0.83");
                oldBinding = await worker.sessionManager.captureWorkflowToolBinding(parentId);
                const { createWorkflow } = await moduleAt(roots.old, "src/workflow/service.ts");
                const { createWorkflowAgentResolver } = await moduleAt(roots.old, "src/workflow/agent-resolver.ts");
                const catalog = worker._catalog;
                const resolveAgent = createWorkflowAgentResolver({ catalog });
                created = await createWorkflow({
                    catalog, store: catalog.workflowStore(), duroxideClient: client._getDuroxideClient(), resolveAgent,
                    ...(worker.sessionManager.describeWorkflowAgentTools ? {
                        describeAgentTools: (...args) => worker.sessionManager.describeWorkflowAgentTools(...args),
                    } : {}),
                }, {
                    workflowSessionId: randomUUID(), parentSessionId: parentId, binding: oldBinding, yaml: workflow(),
                    publish: true, actor: { kind: "system", name: "actual-old-source" }, operationId: "create",
                    notifyParent: false, start: { inputs: {} },
                });
                await vi.waitFor(async () => {
                    const nodes = await catalog.workflowStore().listNodeExecutions(created.receipt.run.runId);
                    expect(nodes.some(node => node.nodeId === "gate" && node.state === "pending")).toBe(true);
                }, { timeout: 30_000 });
                expect(turns).toEqual([]);
                expect((await catalog.getSessionCreationConfig(created.receipt.workflowSessionId)).workflowToolBinding)
                    .toEqual(oldBinding);
                console.info("OLD_SOURCE_BINDING", JSON.stringify({
                    oldRoot: roots.old, currentRoot: roots.current, republish, parentId,
                    created: created.receipt, oldBinding, parentOffer: parentOffers.at(-1),
                    definition: await catalog.workflowStore().readDefinition(created.receipt.workflowSessionId),
                }));
            });
            const currentWorkers = await moduleAt(roots.current, "test/helpers/local-workers.js");
            if (republish) {
                writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name: "upgrade-plugin", version: "1.1.0" }));
                writeFileSync(join(pluginDir, "agents", `${AGENT}.agent.md`),
                    `---\nname: ${AGENT}\ndescription: Harmless narrow upgrade probe.\ntools: [read_facts]\n---\nNEW_VERSION_NOT_THE_PINNED_MARKER\n`);
                const currentSdk = await moduleAt(roots.current, "src/index.ts");
                const { createCatalog } = await moduleAt(roots.current, "test/helpers/cms-helpers.js");
                const catalog = await createCatalog(env);
                try {
                    await currentSdk.publishAgentPackageDir({ catalog,
                        artifactStore: new currentSdk.FilesystemArtifactStore(join(env.baseDir, "artifacts")) }, {
                        dir: pluginDir, scope: "user", owner: OWNER, createdBy: "actual-new-source", isAdmin: false,
                    });
                } finally {
                    await catalog.close();
                }
            }
            await currentWorkers.withClient(env, { worker: { ...common, modelProvidersPath: providerPath },
                client: { modelProvidersPath: providerPath } }, async (client, worker) => {
                const catalog = worker._catalog;
                const store = catalog.workflowStore();
                const { sendTypedWorkflowInput } = await moduleAt(roots.current, "src/workflow/service.ts");
                await sendTypedWorkflowInput({ store, catalog, duroxideClient: client._getDuroxideClient() }, {
                    workflowSessionId: created.receipt.workflowSessionId, runId: created.receipt.run.runId,
                    senderSessionId: parentId, contract: "Gate@1", payload: {},
                    operationId: "after-upgrade",
                });
                await vi.waitFor(() => expect(turns).toHaveLength(2), { timeout: 120_000 });
                const run = await store.readRun(created.receipt.run.runId);
                const nodes = await store.listNodeExecutions(run.runId);
                const narrow = nodes.find(node => node.nodeId === "narrow");
                const invocation = await store.readAgentInvocation(narrow.nodeExecutionId);
                const instance = `session-${invocation.childSessionId}`;
                const dx = client._getDuroxideClient();
                const executions = await dx.listExecutions(instance);
                const history = (await Promise.all(executions.map(id => dx.readExecutionHistory(instance, id)))).flat();
                const scheduled = history.filter(event => event.kind === "ActivityScheduled").map(event => String(event.data));
                console.info("REAL_UPGRADE_RESULT", JSON.stringify({
                    oldRoot: roots.old, currentRoot: roots.current, republish, turns, invocation,
                    childConfig: await catalog.getSessionCreationConfig(invocation.childSessionId),
                    childVersion: (await dx.getInstanceInfo(instance)).orchestrationVersion, scheduled, traces,
                }));
                expect((await dx.getInstanceInfo(instance)).orchestrationVersion).toBe("1.0.84");
                expect(scheduled.some(data => data.includes('"name":"runTurnV6"'))).toBe(true);
                expect(turns[1].system).toContain("NARROW_UPGRADE_MARKER");
                expect(turns[1].system).not.toContain("NEW_VERSION_NOT_THE_PINNED_MARKER");
                expect(turns[1].tools).toContain("read_facts");
                expect(turns[1].tools.some(name => name.includes(TOOL))).toBe(false);
                expect(turns[1].inputTools).toEqual(turns[0].tools);
                if (oldBinding.agentStepTools === "selections") {
                    expect(turns[0].tools).toContain(TOOL);
                    expect(turns[1].inputTools).toContain(TOOL);
                } else {
                    // The production writer did not opt into parent selections for any agent step.
                    expect(turns[0].tools.some(name => name.includes(TOOL))).toBe(false);
                }
                await vi.waitFor(async () => expect((await store.readRun(run.runId)).terminalOutcome).toBe("succeeded"),
                    { timeout: 30_000 });
            });
        } finally {
            await model.close();
        }
    });
});
