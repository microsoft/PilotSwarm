import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { systemText } from "../helpers/scripted-model.mjs";
import { turnWorkflowsOn } from "../helpers/workflows-on.js";
import { FilesystemArtifactStore, publishAgentPackageDir } from "../../src/index.ts";
import { capabilityRef } from "../../src/capability-catalog.ts";
import { sendTypedWorkflowInput } from "../../src/workflow/service.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "watch-drain-fixture" };
const TOOL = "pkg_tool_a";
const TIMEOUT = 180_000;

function writePackage(env, version) {
    const dir = join(env.baseDir, `pkg-a-${version}`);
    mkdirSync(join(dir, "tools"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({
        name: "pkg-a", version, description: "Harmless watch/drain fixture.",
    }));
    writeFileSync(join(dir, "tools", "worker-module.js"), `
export default {
    createTools: () => [{
        name: "${TOOL}", description: "Return the fixture version and call phase.",
        parameters: { type: "object", required: ["phase"], additionalProperties: false,
            properties: { phase: { type: "string" } } },
        handler: async ({ phase }) => "PKG_A_${version}:" + phase,
    }],
};
`);
    return dir;
}

function watchDefinition({ named = false, grant, required = false, gate = false, scriptOnly = false } = {}) {
    const poll = next => ({
        type: "script",
        source: `await setResult("done", await callTool("${TOOL}", { phase: "poll" }));`,
        transition: { next: { done: next, failure: "failed" } },
    });
    return JSON.stringify({
        apiVersion: "pilotswarm.dev/v1", kind: "Workflow",
        metadata: { name: "watch-drain", version: "1.0.0" }, initial: "poll",
        ...(gate ? { contracts: { "Ready@1": { schema: { type: "object" } } } } : {}),
        states: {
            poll: poll(gate ? "hold" : scriptOnly ? "done" : "drain"),
            ...(gate ? {
                hold: { type: "messaging", mode: "receive", contract: "Ready@1",
                    transition: { next: { received: "poll_again", failure: "failed" } } },
                poll_again: poll("drain"),
            } : {}),
            ...(!scriptOnly ? { drain: {
                type: "agent",
                invoke: named ? { agent: { name: "agent-b" } } : { prompt: "Drain the harmless fixture." },
                ...(grant === undefined ? {} : { grant }),
                ...(required ? { requiredTools: [TOOL] } : {}),
                tools: [TOOL], outcomes: ["done"], timeoutSeconds: 120,
                transition: { next: { done: "done", failure: "failed" } },
            } } : {}),
            done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
        },
    });
}

async function scenario(options, run) {
    const env = getEnv();
    const catalog = await createCatalog(env);
    const registry = {
        catalog, artifactStore: new FilesystemArtifactStore(join(dirname(env.sessionStateDir), "artifacts")),
    };
    const publish = version => publishAgentPackageDir(registry, {
        dir: writePackage(env, version), scope: "shared", owner: OWNER,
        createdBy: "watch-drain-fixture", isAdmin: false,
    });
    const pluginDir = join(env.baseDir, "pkg-b");
    mkdirSync(join(pluginDir, "agents"), { recursive: true });
    writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name: "pkg-b", version: "1.0.0" }));
    writeFileSync(join(pluginDir, "agents", "agent-b.agent.md"),
        "---\nname: agent-b\ndescription: Harmless named fixture.\nschemaVersion: 1\nversion: 1.0.0\ntools: []\n---\nDrain only the tools offered for this task.\n");
    const offers = new Map();
    const results = new Map();
    const refusals = [];
    let sourceRef, selectionRevision, started;
    const childVariants = [
        { name: "unnamed" },
        { name: "named", agent_name: "agent-b" },
        { name: "granted", agent_name: "agent-b", grant: [TOOL] },
        { name: "unheld", agent_name: "agent-b", grant: ["pkg_tool_missing"] },
    ];
    const recordOffer = (key, body) => offers.set(key, (body.tools ?? []).map(tool => tool.function.name).sort());
    const respond = (body, position) => {
        const offered = (body.tools ?? []).map(tool => tool.function.name);
        if (offered.includes("complete_workflow_node")) {
            const execution = [...`${position.lastUserText}\n${systemText(body)}`.matchAll(/nx-[a-f0-9]+/g)].at(-1)?.[0];
            expect(execution).toBeDefined();
            const complete = operation => ({ tools: [{ name: "complete_workflow_node", args: {
                node_execution_id: execution, operation_id: `${operation}-${execution}`, outcome: "done", output: null,
            } }] });
            if (position.step === 0) {
                recordOffer("drain", body);
                if (options.required) return complete("early");
                return offered.includes(TOOL) ? { tools: [{ name: TOOL, args: { phase: "drain" } }] } : complete("done");
            }
            if (options.required && position.step === 1) {
                refusals.push(position.toolResults.join("\n"));
                return { tools: [{ name: TOOL, args: { phase: "drain" } }] };
            }
            if (position.step === (options.required ? 2 : 1) && offered.includes(TOOL)) {
                results.set("drain", position.toolResults.join("\n"));
                return complete("done");
            }
            return { content: "DRAIN_DONE" };
        }
        const child = /PACKAGE_CHILD_(unnamed|named|granted)/.exec(`${position.firstUserText}\n${systemText(body)}`)?.[1];
        if (child) {
            if (position.step === 0) {
                recordOffer(child, body);
                if (offered.includes(TOOL)) return { tools: [{ name: TOOL, args: { phase: child } }] };
            } else results.set(child, position.toolResults.join("\n"));
            return { content: `CHILD_DONE_${child}` };
        }
        if (position.lastUserText.includes("ACTIVATE_PKG_A") && position.step === 0) return { tools: [{
            name: "use_package", args: { source_ref: sourceRef, tools: [TOOL],
                expected_revision: selectionRevision, request_id: "attach-pkg-a" },
        }] };
        if (position.lastUserText.includes("UNLOAD_PKG_A") && position.step === 0) return { tools: [{
            name: "use_package", args: { source_ref: sourceRef, action: "remove", tools: [TOOL],
                expected_revision: selectionRevision + 1, request_id: "unload-pkg-a" },
        }] };
        if (position.lastUserText.includes("CHECK_PARENT_TOOL")) {
            if (position.step === 0) {
                recordOffer("parent", body);
                if (offered.includes(TOOL)) return { tools: [{ name: TOOL, args: { phase: "parent" } }] };
            } else results.set("parent", position.toolResults.join("\n"));
        }
        if (position.lastUserText.includes("START_WATCH")) {
            if (position.step === 0) return { tools: [{ name: "workflow_definition",
                args: { operation: "save", name: "watch-drain", yaml: watchDefinition(options) } }] };
            if (position.step === 1) {
                expect(JSON.parse(position.toolResults[0])).toMatchObject({ ok: true, valid: true });
                return { tools: [{ name: "workflow_definition", args: {
                    operation: "start", name: "watch-drain", inputs: {}, notify_on_completion: false,
                } }] };
            }
            if (position.step === 2) {
                started = JSON.parse(position.toolResults[0]);
                expect(started).toMatchObject({ ok: true, operation: "start" });
            }
        }
        const spawning = /SPAWN_FROM_PARENT_(unnamed|named|granted|unheld)/.exec(position.lastUserText)?.[1];
        if (spawning) {
            if (position.step === 0) {
                const { name, ...args } = childVariants.find(variant => variant.name === spawning);
                return { tools: [{ name: "spawn_agent", args: { ...args, task: `PACKAGE_CHILD_${name}` } }] };
            }
            results.set(`spawn-${spawning}`, position.toolResults.join("\n"));
        }
        return { content: "PARENT_READY" };
    };
    try {
        const release = await publish("1.0.0");
        await withScriptedModel(env, {
            respond, worker: { pluginDirs: [pluginDir], logLevel: "warning", workflowScripts: { enabled: true },
                agentPackages: { cacheDir: join(env.baseDir, "package-cache"), refreshIntervalMs: 0 } },
        }, async ({ client, worker, model, qualifiedModel }) => {
            const parent = await client.createSession({ owner: OWNER, model: qualifiedModel });
            await turnWorkflowsOn(catalog, parent.sessionId);
            const source = worker.sessionManager.workerDefaults.getCapabilitySources().find(item => item.packageId === release.packageId);
            expect(source).toBeDefined();
            sourceRef = capabilityRef(source.id, source.revision, "source");
            selectionRevision = (await catalog.getSessionCapabilities(parent.sessionId)).revision;
            await parent.sendAndWait("ACTIVATE_PKG_A", 30_000);
            const selections = await catalog.getSessionCapabilities(parent.sessionId);
            expect(selections, model.sessionRequests().flatMap(request => request.position.toolResults).join("\n"))
                .toMatchObject({ revision: selectionRevision + 1, selections: [
                    expect.objectContaining({ sourceId: release.packageId, tools: [TOOL] }),
                ] });
            await parent.sendAndWait("CHECK_PARENT_TOOL_INITIAL", 30_000);
            expect(offers.get("parent")).toContain(TOOL);
            expect(results.get("parent")).toContain("PKG_A_1.0.0:parent");
            const store = catalog.workflowStore();
            const start = async () => {
                await parent.sendAndWait("START_WATCH", 30_000);
                expect(started).toBeDefined();
                return started;
            };
            const finish = async () => {
                const runRow = await store.readRun(started.runId);
                expect((await client._getDuroxideClient().waitForOrchestration(runRow.controllerInstanceId, 120_000)).status)
                    .toBe("Completed");
                const ended = await store.readRun(started.runId);
                expect(ended, JSON.stringify(ended.terminalError)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
                return ended;
            };
            const parked = async () => {
                await vi.waitFor(async () => {
                    expect(await store.readNodeExecution(nodeExecutionIdFor(started.runId, "root", "hold", 1))).toBeTruthy();
                }, { timeout: 30_000 });
                const poll = await store.readNodeExecution(nodeExecutionIdFor(started.runId, "root", "poll", 1));
                expect(poll).toMatchObject({ state: "completed" });
                expect(JSON.stringify(poll.output)).toContain("PKG_A_1.0.0:poll");
            };
            const releaseGate = () => sendTypedWorkflowInput({ catalog, store, duroxideClient: client._getDuroxideClient() }, {
                workflowSessionId: started.workflowId, runId: started.runId, senderSessionId: parent.sessionId,
                contract: "Ready@1", payload: {}, operationId: "release-watch",
            });
            const probeCurrentPackage = async revision => {
                const current = worker.sessionManager.workerDefaults.getCapabilitySources()
                    .find(item => item.packageId === release.packageId);
                expect(current.revision).toBe(revision);
                sourceRef = capabilityRef(current.id, current.revision, "source");
                const observer = await client.createSession({ owner: OWNER, model: qualifiedModel });
                selectionRevision = (await catalog.getSessionCapabilities(observer.sessionId)).revision;
                await observer.sendAndWait("ACTIVATE_PKG_A_CURRENT", 30_000);
                await observer.sendAndWait("CHECK_PARENT_TOOL_UPDATED", 30_000);
                expect(offers.get("parent")).toContain(TOOL);
                return results.get("parent");
            };
            await run({ parent, worker, model, catalog, store, release, publish, offers, results, refusals,
                start, finish, parked, releaseGate, probeCurrentPackage, getStarted: () => started, childVariants });
        });
    } finally {
        await catalog.close();
    }
}

describe("section 1 watch/drain composition on a real worker and Copilot CLI", () => {
    it("1: the starter activates pkg-a with use_package and can call its offered tool", { timeout: TIMEOUT }, async () => {
        await scenario({}, async ({ model }) => {
            expect(model.sessionRequests().some(request => request.answer?.tools?.some(tool => tool.name === "use_package"))).toBe(true);
        });
    });

    it("2: the starter starts a watch Workflow whose script calls pkg_tool_a", { timeout: TIMEOUT }, async () => {
        await scenario({ scriptOnly: true }, async ({ start, finish }) => {
            await start();
            expect(JSON.stringify((await finish()).terminalOutput)).toContain("PKG_A_1.0.0:poll");
        });
    });

    it("3: a granted named step offers the required tool, refuses early completion, then completes after calling it",
        { timeout: TIMEOUT }, async () => {
        await scenario({ named: true, grant: [TOOL], required: true }, async ({ start, finish, offers, results, refusals }) => {
            await start();
            await finish();
            expect(offers.get("drain")).toEqual(["complete_workflow_node", TOOL]);
            expect(refusals).toHaveLength(1);
            expect(refusals[0]).toContain("REQUIRED_TOOLS_NOT_CALLED");
            expect(refusals[0]).toContain(TOOL);
            expect(results.get("drain")).toContain("PKG_A_1.0.0:drain");
        });
    });

    it("4: the same named step without a grant does not offer the parent's package tool", { timeout: TIMEOUT }, async () => {
        await scenario({ named: true }, async ({ start, finish, offers, results }) => {
            await start();
            await finish();
            expect(offers.get("drain")).toEqual(["complete_workflow_node"]);
            expect(results.has("drain")).toBe(false);
        });
    });

    it("5: an inline step gets the package tool by default and calls it", { timeout: TIMEOUT }, async () => {
        await scenario({}, async ({ start, finish, offers, results }) => {
            await start();
            await finish();
            expect(offers.get("drain")).toEqual(["complete_workflow_node", TOOL]);
            expect(results.get("drain")).toContain("PKG_A_1.0.0:drain");
        });
    });

    it("6: unnamed children inherit; named children need a grant; an unheld grant creates no child", { timeout: TIMEOUT }, async () => {
        await scenario({}, async ({ parent, catalog, offers, results, childVariants }) => {
            for (const { name } of childVariants) {
                await parent.sendAndWait(`SPAWN_FROM_PARENT_${name}`, 30_000);
                if (name !== "unheld") await vi.waitFor(() => {
                    expect(offers.has(name)).toBe(true);
                    if (name !== "named") expect(results.get(name)).toContain(`PKG_A_1.0.0:${name}`);
                }, { timeout: 30_000 });
            }
            expect(offers.get("unnamed")).toContain(TOOL);
            expect(offers.get("named")).not.toContain(TOOL);
            expect(offers.get("granted")).toEqual([...offers.get("named"), TOOL].sort());
            expect(results.get("spawn-unheld")).toContain("pkg_tool_missing");
            const children = (await catalog.listSessions()).filter(row => row.parentSessionId === parent.sessionId);
            expect(children).toHaveLength(3);
        });
    });

    it("7: republishing pkg-a mid-run serves the new version to a fresh parent, but the script and step retain the Start version",
        { timeout: TIMEOUT }, async () => {
        await scenario({ gate: true, named: true, grant: [TOOL] }, async ({ worker, store, release, publish,
            start, finish, parked, releaseGate, probeCurrentPackage, results, getStarted }) => {
            await start();
            await parked();
            const updated = await publish("1.1.0");
            expect(updated.packageId).toBe(release.packageId);
            expect(updated.sha256).not.toBe(release.sha256);
            await worker.refreshAgentPackages();
            expect(await probeCurrentPackage(updated.sha256)).toContain("PKG_A_1.1.0:parent");
            await releaseGate();
            await finish();
            const laterPoll = await store.readNodeExecution(nodeExecutionIdFor(getStarted().runId, "root", "poll_again", 1));
            expect(JSON.stringify(laterPoll.output)).toContain("PKG_A_1.0.0:poll");
            expect(results.get("drain")).toContain("PKG_A_1.0.0:drain");
        });
    });

    it("8: unloading pkg-a after Start removes the starter's offer but preserves the running script and step",
        { timeout: TIMEOUT }, async () => {
        await scenario({ gate: true, named: true, grant: [TOOL] }, async ({ parent, store, offers, results,
            start, finish, parked, releaseGate, getStarted }) => {
            await start();
            await parked();
            await parent.sendAndWait("UNLOAD_PKG_A", 30_000);
            await parent.sendAndWait("CHECK_PARENT_TOOL_UNLOADED", 30_000);
            expect(offers.get("parent")).not.toContain(TOOL);
            await releaseGate();
            await finish();
            const laterPoll = await store.readNodeExecution(nodeExecutionIdFor(getStarted().runId, "root", "poll_again", 1));
            expect(JSON.stringify(laterPoll.output)).toContain("PKG_A_1.0.0:poll");
            expect(offers.get("drain")).toEqual(["complete_workflow_node", TOOL]);
            expect(results.get("drain")).toContain("PKG_A_1.0.0:drain");
        });
    });
});
