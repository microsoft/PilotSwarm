import { describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ active: null }));
vi.mock("../../src/client.js", () => ({ PilotSwarmClient: class {
    systemSessions = new Set();
    async start() {} async stop() {}
    async listSessions() { return [...transport.active.rows.values()]; }
    async _getSessionInfo(id) { return transport.active.rows.get(id); }
    async createSession(config) { return transport.active.createChild(config); }
} }));
import { handoffHarness, shared, toolNames } from "../helpers/parent-child-handoff.mjs";
import { resolveWorkflowCapabilitySnapshot } from "../../src/workflow/package-pins.ts";

const harness = (options, run) => handoffHarness(transport, { callTools: [], ...options }, run);
const deploymentParent = { boundAgentPackageId: undefined, boundAgentSource: "deployment", toolNames: ["deployment_tool"] };
const firstOffer = h => toolNames(h.server.requests[0]).sort();

describe("composition child sets through real SessionManager and CLI turns", () => {
    it("leaves a top-level session's tool catalog unchanged after capturing a child grant", { timeout: 30_000 }, async () => {
        await harness({ parentConfig: deploymentParent }, async h => {
            const parent = await h.manager.getOrCreate(h.parentId, h.parentConfig, { turnIndex: 0 });
            const cli = parent.getWorkflowToolSession();
            await cli.rpc.tools.initializeAndValidate();
            const before = await cli.rpc.tools.getCurrentMetadata();
            await h.invoke("composition", { task: "Harmless child.", grant: "none" });
            expect(await cli.rpc.tools.getCurrentMetadata()).toEqual(before);
            expect(h.children[0].result.type).toBe("completed");
        });
    });

    it.each([null, { provider: "fixture", subject: "alice" }])(
        "grant none retains the frozen 1.0.83 unnamed child's exact offered set (owner=%s)",
        { timeout: 60_000 }, async owner => {
            let old;
            const options = { owner, parentConfig: deploymentParent };
            await harness(options, async h => {
                await h.invoke("frozen", { task: "Harmless old child." });
                expect(h.children[0].result.type).toBe("completed");
                old = firstOffer(h);
            });
            for (const grant of owner ? ["none"] : ["none", "all"]) {
                await harness(options, async h => {
                    await h.invoke("composition", { task: "Harmless child.", grant });
                    expect(h.children[0].result.type).toBe("completed");
                    expect(firstOffer(h)).toEqual(old);
                    expect(h.children[0].config.toolGrant?.tools ?? []).toEqual([]);
                });
            }
        });

    it("ownerless named spawning retains the frozen declared set without inventing grants", { timeout: 60_000 }, async () => {
        let old;
        const options = { owner: null, agents: [{ ...shared, initialRequiredTool: undefined }], parentConfig: deploymentParent };
        await harness(options, async h => {
            await h.invoke("frozen", { agent_name: "analyst", task: "Harmless old child." });
            old = firstOffer(h);
        });
        await harness(options, async h => {
            await h.invoke("composition", { agent_name: "analyst", task: "Harmless child.", grant: "all" });
            expect(h.children[0].result.type).toBe("completed");
            expect(firstOffer(h)).toEqual(old);
            expect(h.children[0].config.toolGrant).toBeUndefined();
        });
    });

    it.each([null, { provider: "fixture", subject: "alice" }])(
        "legacy tool_names binds an unheld deployment tool with frozen parity (owner=%s)",
        { timeout: 60_000 }, async owner => {
            let old;
            const options = { owner, parentConfig: { ...deploymentParent, toolNames: [] } };
            await harness(options, async h => {
                await h.invoke("frozen", { task: "Old child.", tool_names: ["deployment_tool"] });
                old = firstOffer(h);
            });
            await harness(options, async h => {
                await h.invoke("composition", { task: "Child.", tool_names: ["deployment_tool"] });
                expect(h.children[0].result.type).toBe("completed");
                expect(firstOffer(h)).toEqual(old);
                expect(firstOffer(h)).toContain("deployment_tool");
                expect(h.children[0].config.toolGrant).toBeUndefined();
            });
        });

    it.each([
        { grant: ["deployment_tool"], parent: { ...deploymentParent, toolNames: [] }, error: "deployment_tool" },
        { grant: ["missing_tool"], parent: deploymentParent, error: "missing_tool" },
        { grant: ["deployment_tool"], parent: deploymentParent, owner: null, error: "ownerless" },
        { tool_names: ["deployment_tool"], grant: "none", parent: deploymentParent, error: "cannot be combined" },
        { tool_names: ["deployment_tool"], tools: "none", parent: deploymentParent, error: "cannot be combined" },
    ])("refuses invalid composition $error before creating a child", { timeout: 30_000 }, async ({ parent, owner, error, ...args }) => {
        await harness({ parentConfig: parent, ...(owner === null ? { owner } : {}) }, async h => {
            const reply = await h.invoke("composition", { task: "Must not start.", ...args });
            expect(reply.toLowerCase()).toContain(error.toLowerCase());
            expect(h.children).toEqual([]);
            expect(h.server.requests).toEqual([]);
        });
    });

    it("an inherited ceiling cuts a child's legacy tool_names grandchild end to end", { timeout: 60_000 }, async () => {
        await harness({ parentConfig: deploymentParent }, async h => {
            await h.invoke("composition", { task: "Bounded child.", tools: ["read_facts"] });
            const child = h.children[0];
            expect(firstOffer(h)).toEqual(["read_facts"]);
            const configBefore = structuredClone(child.config);
            await h.invoke("composition", { task: "Bounded grandchild.", tool_names: ["deployment_tool", "read_facts"] },
                { sessionId: child.sessionId, config: child.config, nestingLevel: 1 });
            expect(h.children).toHaveLength(2);
            expect(h.children[1].config.toolCeiling).toEqual(["read_facts"]);
            expect(toolNames(h.server.requests.at(-1))).toEqual(["read_facts"]);
            expect(h.children[1].result.type).toBe("completed");
            expect(child.config).toEqual(configBefore);
        });
    });

    it.each([false, true])("a named child pins a foreign-package tool and handles registry failure %s without rerunning it",
        { timeout: 30_000 }, async registryFailure => {
        const sources = [];
        let catalog;
        let registryAvailable = true;
        let failedChecks = 0;
        const agent = { ...shared, tools: ["pkg_tool_b"], initialRequiredTool: undefined };
        await harness({ agents: [agent], callTools: ["pkg_tool_b"], parentConfig: deploymentParent,
            onToolRequest: () => { registryAvailable = !registryFailure; },
            workerDefaults: {
                getCapabilitySources: () => sources,
                getWorkflowCapabilitySnapshot: (binding, retained) =>
                    resolveWorkflowCapabilitySnapshot(binding, retained, catalog, sources),
            },
            configure: f => {
                catalog = f.catalog;
                const exported = f.makeTool("pkg_tool_b", "pkg-foreign");
                f.byPackage.set("pkg-foreign", new Map([[exported.name, exported]]));
                f.byPackage.set(agent.packageId, new Map());
                f.flat.set(exported.name, exported);
                sources.push({ id: "pkg-foreign", packageId: "pkg-foreign", name: "foreign-tools", revision: "a".repeat(64),
                    source: "published", scope: "shared", owner: null, tools: new Map([[exported.name, exported]]),
                    mcpServers: {}, artifacts: [] });
                catalog.listAgentPackages = async () => {
                    if (!registryAvailable) { failedChecks++; throw new Error("Synthetic registry outage."); }
                    return [{ packageId: "pkg-foreign", name: "foreign-tools", scope: "shared", enabled: true,
                        active: { semver: "1.0.0", sha256: "a".repeat(64) } }];
                };
                catalog.getAgentPackage = async () => ({ packageId: "pkg-foreign", name: "foreign-tools",
                    scope: "shared", enabled: true, versions: [{ semver: "1.0.0", sha256: "a".repeat(64) }] });
                f.manager.setToolRegistry(f.flat, { byPackage: f.byPackage, staticNames: f.staticNames });
            },
        }, async h => {
            await h.invoke("composition", { agent_name: "analyst", task: "Read the foreign fixture." });
            expect(h.children[0].result.type).toBe("completed");
            expect(firstOffer(h)).toContain("pkg_tool_b");
            const results = JSON.stringify(h.server.requests.at(-1).messages.filter(message => message.role === "tool"));
            expect(h.calls, results).toEqual(registryFailure ? [] : [{ name: "pkg_tool_b", owner: "pkg-foreign" }]);
            if (registryFailure) {
                expect(results).toContain("pkg_tool_b");
                expect(results).toContain("registry");
                expect(failedChecks).toBe(3);
            }
            expect(h.children[0].config.toolGrant.sourceRevisions["pkg-foreign"]).toBe("a".repeat(64));
            expect(h.children[0].config.toolGrant.packagePins["pkg-foreign"].version).toBe("1.0.0");
        });
    });

    it("an ownerless parent's explicit ceiling narrows the actual offer without creating a grant", async () => {
        await harness({ owner: null, parentConfig: deploymentParent }, async h => {
            await h.invoke("composition", { task: "OWNERLESS_CEILING", tools: ["read_facts"], grant: "all" });
            expect(firstOffer(h)).toEqual(["read_facts"]);
            expect(h.children[0].config.toolGrant).toBeUndefined();
        });
    });

    it("a named child's explicit grant adds exactly one parent package tool to its declared baseline", async () => {
        const sources = [];
        let catalog;
        const agent = { ...shared, packageId: undefined, packageScope: undefined,
            tools: ["deployment_tool"], initialRequiredTool: undefined };
        await harness({ agents: [agent], parentConfig: deploymentParent,
            workerDefaults: {
                getCapabilitySources: () => sources,
                getWorkflowCapabilitySnapshot: (binding, retained) =>
                    resolveWorkflowCapabilitySnapshot(binding, retained, catalog, sources),
            },
            configure: f => {
                catalog = f.catalog;
                const tool = f.makeTool("pkg_tool_a", "package-a");
                const source = { id: "package-a", packageId: "package-a", name: "package-a", source: "published",
                    revision: "a".repeat(64), scope: "shared", owner: null, artifacts: [],
                    tools: new Map([[tool.name, tool]]), mcpServers: {} };
                sources.push(source);
                catalog.getSessionCapabilities = async id => id === f.parentId
                    ? { revision: 1, selections: [{ sourceId: source.id, tools: [tool.name], mcpServers: [] }] }
                    : { revision: 0, selections: [] };
                const pkg = { packageId: source.id, name: source.name, scope: "shared", enabled: true,
                    active: { sha256: source.revision, semver: "1.0.0" } };
                catalog.listAgentPackages = async () => [pkg];
                catalog.getAgentPackage = async () => ({ ...pkg, versions: [pkg.active] });
            },
        }, async h => {
            await h.invoke("composition", { agent_name: agent.name, task: "DECLARED_BASELINE" });
            expect(h.children[0].result.type).toBe("completed");
            const baseline = firstOffer(h);
            expect(baseline).toContain("deployment_tool");
            expect(baseline).not.toContain("pkg_tool_a");
            await h.invoke("composition", { agent_name: agent.name, task: "ADD_ONE", grant: ["pkg_tool_a"] });
            expect(h.children[1].result.type, JSON.stringify(h.children[1].result)).toBe("completed");
            expect(toolNames(h.server.requests[1]).sort()).toEqual([...baseline, "pkg_tool_a"].sort());
            expect(h.children[1].config.toolGrant.sourceRevisions).toEqual({ "package-a": "a".repeat(64) });
        });
    });

    it.each([false, true])("a real depth-two step sub-agent cannot spawn again (named=%s)", async named => {
        const agent = { ...shared, packageId: undefined, packageScope: undefined,
            tools: ["deployment_tool"], initialRequiredTool: undefined };
        const ceiling = named ? ["deployment_tool"] : ["read_facts"];
        await harness({ agents: [agent], parentConfig: { ...deploymentParent, workflowInsideWorkflow: true } }, async h => {
            await h.invoke("composition", { task: "STEP_SUBAGENT", ...(named ? { agent_name: agent.name } : {}),
                tools: ceiling }, { sessionId: h.parentId, config: h.parentConfig, nestingLevel: 1 });
            expect(h.children).toHaveLength(1);
            const child = h.children[0];
            expect(child.result.type, JSON.stringify(child.result)).toBe("completed");
            expect(firstOffer(h)).toEqual(ceiling);
            const refusal = await h.invoke("composition", { task: "MUST_NOT_SPAWN" }, {
                sessionId: child.sessionId, config: child.config, nestingLevel: 2,
            });
            expect(refusal).toContain("cannot spawn further sub-agents");
            expect(h.children).toHaveLength(1);
        });
    });
});
