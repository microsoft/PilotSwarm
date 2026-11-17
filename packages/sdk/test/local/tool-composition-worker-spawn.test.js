import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { capabilityRef } from "../../src/capability-catalog.ts";
import { resolveWorkflowCapabilitySnapshot } from "../../src/workflow/package-pins.ts";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "composition-spawn-fixture" };
const tools = ["pkg_tool_a", "pkg_tool_b"];
const variants = [
    { name: "none", grant: "none" },
    { name: "all", grant: "all" },
    { name: "default" },
    { name: "one", grant: ["pkg_tool_a"] },
];

describe("ordinary spawn grants on the real worker", () => {
    it("adds only selected package tools and MCP methods to the unchanged unnamed baseline", { timeout: 180_000 }, async () => {
        const env = getEnv();
        const offers = new Map();
        await withScriptedModel(env, {
            worker: { logLevel: "warning" },
            respond: (body, position) => {
                const child = /COMPOSITION_CHILD_(none|all|default|one)/.exec(position.firstUserText)?.[1];
                if (child) {
                    offers.set(child, (body.tools ?? []).map(tool => tool.function.name).sort());
                    return { content: `CHILD_DONE_${child}` };
                }
                const spawn = /PARENT_SPAWN_(none|all|default|one)/.exec(position.lastUserText)?.[1];
                if (spawn && position.step === 0) {
                    const variant = variants.find(item => item.name === spawn);
                    return { tools: [{ name: "spawn_agent", args: {
                        task: `COMPOSITION_CHILD_${spawn}`, ...(variant.grant === undefined ? {} : { grant: variant.grant }),
                    } }] };
                }
                return { content: "PARENT_READY" };
            },
        }, async ({ client, worker, qualifiedModel }) => {
            const manager = worker.sessionManager;
            const source = {
                id: "composition-spawn-source", packageId: "composition-spawn-source", name: "composition-spawn-source",
                revision: "one", source: "published", scope: "user", owner: OWNER,
                artifacts: [...tools.map(name => ({ kind: "tool", name })), { kind: "mcp", name: "notes" }],
                tools: new Map(tools.map(name => [name, { name, description: `Harmless ${name}.`,
                    parameters: { type: "object", properties: {}, additionalProperties: false }, handler: async () => "OK" }])),
                mcpServers: { notes: { command: process.execPath,
                    args: [new URL("../helpers/native-task-mcp.mjs", import.meta.url).pathname,
                        join(env.baseDir, "composition-spawn-mcp-proof.txt")], tools: ["read_note"] } },
            };
            const pkg = { packageId: source.id, name: source.name, scope: source.scope, owner: OWNER,
                enabled: true, active: { sha256: source.revision, semver: "1.0.0" } };
            manager.workerDefaults.getCapabilitySources = () => [source];
            manager.workerDefaults.getWorkflowCapabilitySnapshot = (binding, retained) =>
                resolveWorkflowCapabilitySnapshot(binding, retained, {
                    listAgentPackages: async () => [pkg],
                    getAgentPackage: async () => ({ ...pkg, versions: [pkg.active] }),
                }, [source]);
            const parent = await client.createSession({ owner: OWNER, model: qualifiedModel });
            expect(await parent.sendAndWait("Prepare the harmless spawn fixture.", 30_000)).toBe("PARENT_READY");
            await manager.sessions.get(parent.sessionId).config.capabilityServices.use({
                source_ref: capabilityRef(source.id, source.revision, "source"), tools, mcp_servers: ["notes"],
                expected_revision: 0, request_id: "activate-composition-spawn",
            });
            expect(await parent.sendAndWait("Refresh the spawn fixture.", 30_000)).toBe("PARENT_READY");
            for (const variant of variants) {
                expect(await parent.sendAndWait(`PARENT_SPAWN_${variant.name}`, 30_000)).toBe("PARENT_READY");
                await vi.waitFor(() => expect(offers.has(variant.name)).toBe(true), { timeout: 30_000 });
            }
            const baseline = offers.get("none");
            expect(baseline).not.toContain("pkg_tool_a");
            expect(baseline).not.toContain("pkg_tool_b");
            expect(baseline).not.toContain("notes-read_note");
            expect(offers.get("one")).toEqual([...baseline, "pkg_tool_a"].sort());
            const all = [...baseline, ...tools, "notes-read_note"].sort();
            expect(offers.get("all")).toEqual(all);
            expect(offers.get("default")).toEqual(all);
            const children = (await client._catalog.listSessions()).filter(row => row.parentSessionId === parent.sessionId);
            expect(children).toHaveLength(variants.length);
            for (const child of children) {
                const creation = await client._catalog.getSessionCreationConfig(child.sessionId);
                const none = creation.systemMessage.includes("COMPOSITION_CHILD_none");
                expect(creation.toolGrant?.sourceRevisions ?? {}).toEqual(none ? {} : { [source.id]: source.revision });
            }
        });
    });
});
