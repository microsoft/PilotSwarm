import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { callCronPrecheckMcpTool } from "../../src/cron-precheck-mcp.ts";
import { evaluateCronPrecheck } from "../../src/cron-precheck.ts";
import { SessionManager, packageAgentKey } from "../../src/session-manager.ts";
import { registerActivities } from "../../src/session-proxy.ts";
import { startPrecheckMcpServer } from "../helpers/cron-precheck-mcp.mjs";

const input = { sessionId: "s1", precheck: "queue", reason: "poll", intervalSeconds: 300,
    packageIdentity: { packageId: "shared", versionId: "v1", sha256: "a".repeat(64) }, packageBindingRevision: 1 };
const agent = { boundAgentName: "poller", boundAgentPackageId: "shared" };
const owner = { provider: "test", subject: "alice" };
const serverConfig = { type: "http", url: "http://127.0.0.1:1/mcp", tools: ["queue_status"] };

describe("non-LLM MCP precheck calls", () => {
    for (const sse of [false, true]) {
        it(`${sse ? "SSE" : "HTTP"} uses configured authentication and tool arguments`, async () => {
            const fixture = await startPrecheckMcpServer({ sse });
            const controller = new AbortController();
            try {
                const config = { ...fixture.config, headers: { Authorization: "Bearer fixture-only" } };
                const result = await callCronPrecheckMcpTool({ queue: config }, controller.signal, "queue", "queue_status", { scope: "both" });
                expect(result.structuredContent).toEqual({ hasWork: false });
                expect(fixture.state.calls).toEqual([{ name: "queue_status", arguments: { scope: "both" } }]);
                expect(fixture.state.headers.every(headers => headers.authorization === "Bearer fixture-only")).toBe(true);
            } finally { controller.abort(); await fixture.close(); }
        });
    }

    it("stdio uses configured cwd/env and terminates the child process", async () => {
        const cwd = fileURLToPath(new URL("../helpers", import.meta.url));
        const result = await callCronPrecheckMcpTool({
            queue: {
                command: process.execPath, args: [fileURLToPath(new URL("../helpers/cron-precheck-stdio.mjs", import.meta.url))],
                tools: ["*"], cwd, env: { PRECHECK_FIXTURE_VALUE: "configured" },
            },
        }, new AbortController().signal, "queue", "queue_status");
        const response = JSON.parse(result.content[0].text);
        expect(response.cwd).toBe(cwd);
        expect(response.value).toBe("configured");
        expect(() => process.kill(response.pid, 0)).toThrow();
    });

    it("rejects unknown servers, prototype names and tools outside the grant before connecting", async () => {
        const signal = new AbortController().signal;
        await expect(callCronPrecheckMcpTool({ queue: serverConfig }, signal, "missing", "queue_status")).rejects.toThrow(/unauthorized/);
        await expect(callCronPrecheckMcpTool({}, signal, "toString", "queue_status")).rejects.toThrow(/unauthorized/);
        await expect(callCronPrecheckMcpTool({ queue: serverConfig }, signal, "queue", "delete_all")).rejects.toThrow(/not authorized/);
    });

    it("rejects raw package MCP markers before any legacy transport can start", async () => {
        const signal = new AbortController().signal;
        for (const config of [
            { type: "pilotswarm-package", tools: ["*"] },
            { ...serverConfig, packageRuntime: { packageId: "shared" } },
        ]) {
            await expect(callCronPrecheckMcpTool({ queue: config }, signal, "queue", "queue_status"))
                .rejects.toThrow(/supervised authority/);
        }
    });

    it("fails open for server tool errors, invalid results, denied tools and connection failures", async () => {
        const fixture = await startPrecheckMcpServer();
        try {
            for (const mode of ["tool_error", "malformed", "denied", "unreachable", "unauthorized"]) {
                fixture.state.fail = mode === "tool_error";
                fixture.state.malformed = mode === "malformed";
                fixture.state.unauthorized = mode === "unauthorized";
                const { result, event } = await evaluateCronPrecheck({
                    input,
                    registrations: [{ name: "queue", check: async ({ callMcpTool }) => {
                        await callMcpTool("queue", mode === "denied" ? "delete_all" : "queue_status");
                        return { action: "skip" };
                    } }],
                    callMcpTool: (signal, server, tool, args) => callCronPrecheckMcpTool({
                        queue: mode === "unreachable" ? serverConfig : fixture.config,
                    }, signal, server, tool, args),
                });
                expect(result).toMatchObject({ outcome: "error", skip: false });
                expect(event.detail).not.toContain(fixture.config.url);
            }
        } finally { await fixture.close(); }
    });

    it.each(["call", "initialize"])("bounds a hung MCP %s and rejects calls after evaluation", async (phase) => {
        const fixture = await startPrecheckMcpServer();
        fixture.state.hang = phase === "call";
        fixture.state.hangInitialize = phase === "initialize";
        let caller;
        try {
            const { result } = await evaluateCronPrecheck({
                input,
                registrations: [{ name: "queue", timeoutMs: 100, check: async ({ callMcpTool }) => {
                    caller = callMcpTool;
                    await callMcpTool("queue", "queue_status");
                    return { action: "skip" };
                } }],
                callMcpTool: (signal, server, tool, args) => callCronPrecheckMcpTool({ queue: fixture.config }, signal, server, tool, args),
            });
            expect(result).toMatchObject({ outcome: "timeout", skip: false });
            expect(() => caller("queue", "queue_status")).toThrow();
        } finally { await fixture.close(); }
    });

    it("does not disclose malformed endpoint credentials in operator events", async () => {
        const { result, event } = await evaluateCronPrecheck({
            input,
            registrations: [{ name: "queue", check: async ({ callMcpTool }) => {
                await callMcpTool("queue", "queue_status");
                return { action: "skip" };
            } }],
            callMcpTool: (signal, server, tool, args) => callCronPrecheckMcpTool({
                queue: { ...serverConfig, url: "invalid-url-with-fixture-secret" },
            }, signal, server, tool, args),
        });
        expect(result).toMatchObject({ outcome: "error", skip: false });
        expect(event.detail).not.toContain("fixture-secret");
    });

    it("records unavailable MCP services as a failed-open precheck", async () => {
        const { result } = await evaluateCronPrecheck({
            input,
            registrations: [{ name: "queue", check: async ({ callMcpTool }) => {
                await callMcpTool("queue", "queue_status");
                return { action: "skip" };
            } }],
        });
        expect(result).toMatchObject({ outcome: "error", skip: false });
    });

    it("does not accept idle when the callback catches an MCP denial", async () => {
        const { result } = await evaluateCronPrecheck({
            input,
            registrations: [{ name: "queue", check: async ({ callMcpTool }) => {
                try { await callMcpTool("queue", "queue_status"); } catch {}
                return { action: "skip" };
            } }],
        });
        expect(result).toMatchObject({ outcome: "error", skip: false });
    });

    it("does not accept idle when the callback leaves an MCP call unfinished", async () => {
        const { result } = await evaluateCronPrecheck({
            input,
            registrations: [{ name: "queue", check: ({ callMcpTool }) => {
                void callMcpTool("queue", "queue_status");
                return { action: "skip" };
            } }],
            callMcpTool: (signal) => new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
            }),
        });
        expect(result).toMatchObject({ outcome: "error", skip: false });
    });

    it("terminates each stateful HTTP session rather than just closing its connection", async () => {
        const fixture = await startPrecheckMcpServer({ stateful: true });
        try {
            for (let i = 0; i < 2; i++) {
                await callCronPrecheckMcpTool({ queue: fixture.config }, new AbortController().signal, "queue", "queue_status");
            }
            expect(fixture.state.sessions.size).toBe(0);
            expect(fixture.state.terminations).toHaveLength(2);
            expect(fixture.state.terminations.every(headers => headers["mcp-session-id"] && headers["mcp-protocol-version"])).toBe(true);
        } finally { await fixture.close(); }
    });

    it("settles an aborted SSE connection even when the server never sends its endpoint", async () => {
        const fixture = await startPrecheckMcpServer({ sse: true, omitEndpoint: true });
        const controller = new AbortController();
        let timer;
        try {
            const call = callCronPrecheckMcpTool({ queue: fixture.config }, controller.signal, "queue", "queue_status");
            const settled = call.then(() => "resolved", () => "rejected");
            await new Promise(resolve => setTimeout(resolve, 100));
            controller.abort();
            expect(await Promise.race([
                settled,
                new Promise(resolve => { timer = setTimeout(() => resolve("pending"), 500); }),
            ])).toBe("rejected");
        } finally { clearTimeout(timer); controller.abort(); await fixture.close(); }
    });

    it.each(["tool-error", "abort"])("terminates a stateful HTTP session after %s", async (failure) => {
        const fixture = await startPrecheckMcpServer({ stateful: true });
        const controller = new AbortController();
        try {
            fixture.state.fail = failure === "tool-error";
            fixture.state.hang = failure === "abort";
            const call = callCronPrecheckMcpTool({ queue: fixture.config }, controller.signal, "queue", "queue_status");
            const rejected = expect(call).rejects.toThrow(/call failed/);
            if (failure === "abort") {
                await vi.waitFor(() => expect(fixture.state.calls).toHaveLength(1));
                controller.abort();
            }
            await rejected;
            expect(fixture.state.sessions.size).toBe(0);
            expect(fixture.state.terminations).toHaveLength(1);
        } finally { controller.abort(); await fixture.close(); }
    });

    it.each([405, 500, "hung"])("handles stateful HTTP termination status %s without an unbounded wait", async (status) => {
        const fixture = await startPrecheckMcpServer({ stateful: true });
        let timer;
        try {
            fixture.state.terminateStatus = status === "hung" ? 200 : status;
            fixture.state.hangTerminate = status === "hung";
            const settled = callCronPrecheckMcpTool({ queue: fixture.config }, new AbortController().signal, "queue", "queue_status")
                .then(() => "resolved", error => error.message);
            const outcome = await Promise.race([
                settled,
                new Promise(resolve => { timer = setTimeout(() => resolve("pending"), 3_000); }),
            ]);
            expect(outcome).toBe(status === 405 ? "resolved" : "Cron precheck MCP connection cleanup failed; run the normal cycle");
            expect(fixture.state.terminations).toHaveLength(1);
        } finally { clearTimeout(timer); await fixture.close(); }
    });
});

describe("precheck session MCP grants without model hydration", () => {
    function setup(extra = {}) {
        const shared = { kind: "app-agent", prompt: "", namespace: "kit", packageId: "shared", packageScope: "shared",
            packageVersionId: "v1", packageSha256: "a".repeat(64) };
        const personal = { kind: "app-agent", prompt: "", packageId: "personal", packageScope: "user", packageOwner: owner };
        const defaults = {
            baseMcpServers: { base: serverConfig },
            agentPromptLookup: { poller: { ...shared, copies: [shared, personal] } },
            agentMcpServers: {
                [packageAgentKey("shared", "poller")]: { queue: serverConfig },
                [packageAgentKey("personal", "poller")]: { private_queue: serverConfig },
            },
            ...extra,
        };
        const manager = new SessionManager(undefined, null, defaults);
        const catalog = {
            getSession: vi.fn(async () => ({ owner })),
            getSessionCapabilities: vi.fn(async () => ({ revision: 0, selections: [] })),
            packageReviews: { getSessionBinding: async () => ({
                ...input.packageIdentity, agentName: "poller", revision: 1, allowed: true,
            }) },
            packageRuntime: { context: async () => ({}) },
        };
        manager.setSessionCatalog(catalog);
        vi.spyOn(manager, "getOrCreate").mockImplementation(() => { throw new Error("must not hydrate"); });
        return { manager, catalog, defaults };
    }

    it("uses the exact bound package, never a same-named personal copy or the deployment catalog", async () => {
        const { manager } = setup({ mcpServers: { ungranted: serverConfig } });
        const servers = await manager.getCronPrecheckMcpServers({ ...input, packageId: "shared", agent });
        expect(Object.keys(servers).sort()).toEqual(["base", "queue"]);
        expect(manager.getOrCreate).not.toHaveBeenCalled();
    });

    it("rejects another user's private package and stale precheck provenance", async () => {
        const { manager, catalog } = setup();
        await expect(manager.getCronPrecheckMcpServers({ ...input, packageId: "personal", agent })).rejects.toThrow(/no longer bound/);
        catalog.getSession.mockResolvedValue({ owner: { provider: "test", subject: "bob" } });
        await expect(manager.getCronPrecheckMcpServers({ ...input, packageId: "personal", agent: { ...agent, boundAgentPackageId: "personal" } })).rejects.toThrow();
    });

    it("re-resolves grants after worker registry changes instead of reusing warm connections", async () => {
        const { manager, defaults } = setup();
        expect(await manager.getCronPrecheckMcpServers({ ...input, agent })).toHaveProperty("queue");
        delete defaults.agentMcpServers[packageAgentKey("shared", "poller")];
        expect(await manager.getCronPrecheckMcpServers({ ...input, agent })).not.toHaveProperty("queue");
    });

    it("honors persisted capability selections, owner visibility, restrictions and revocation", async () => {
        const source = {
            id: "selected", name: "extra", source: "published", revision: "v1", scope: "user", owner,
            packageId: "selected", artifacts: [], tools: new Map(),
            mcpServers: {
                selected_queue: serverConfig,
                restricted: { ...serverConfig, allowedAgents: ["deployment-only"] },
                admitted: { ...serverConfig, allowedAgents: ["kit:poller"] },
            },
        };
        const { manager, catalog } = setup({ getCapabilitySources: () => [source] });
        const select = names => catalog.getSessionCapabilities.mockResolvedValue({
            revision: 1, selections: [{ sourceId: "selected", tools: [], mcpServers: names }],
        });
        select(["selected_queue"]);
        expect(await manager.getCronPrecheckMcpServers({ ...input, agent })).toHaveProperty("selected_queue");
        select(["restricted"]);
        expect(await manager.getCronPrecheckMcpServers({ ...input, agent })).not.toHaveProperty("restricted");
        select(["admitted"]);
        expect(await manager.getCronPrecheckMcpServers({ ...input, agent })).toHaveProperty("admitted");
        select(["selected_queue"]);
        catalog.getSession.mockResolvedValue({ owner: { provider: "test", subject: "bob" } });
        expect(await manager.getCronPrecheckMcpServers({ ...input, agent })).not.toHaveProperty("selected_queue");
        catalog.getSession.mockResolvedValue({ owner });
        select([]);
        expect(await manager.getCronPrecheckMcpServers({ ...input, agent })).not.toHaveProperty("selected_queue");
    });

    it("actual dispatch denies a tool revoked after callback admission, even when the callback catches it", async () => {
        const fixture = await startPrecheckMcpServer();
        try {
            const source = {
                id: "selected", name: "extra", source: "published", revision: "v1", scope: "user", owner,
                packageId: "selected", artifacts: [], tools: new Map(),
                mcpServers: { selected_queue: fixture.config },
            };
            const { manager, catalog } = setup({ getCapabilitySources: () => [source] });
            let callbacks = 0;
            catalog.recordEvents = vi.fn(async () => {});
            catalog.getSessionCapabilities.mockResolvedValue({
                revision: 1, selections: [{ sourceId: "selected", tools: [], mcpServers: ["selected_queue"] }],
            });
            manager.setPackageCronPrechecks(new Map([["shared", new Map([["queue", {
                name: "queue", check: async ({ callMcpTool }) => {
                    callbacks++;
                    catalog.getSessionCapabilities.mockResolvedValue({ revision: 2, selections: [] });
                    try { await callMcpTool("selected_queue", "queue_status"); } catch {}
                    return { action: "skip" };
                },
            }]])]]));
            const handlers = new Map();
            registerActivities({ registerActivity: (name, handler) => handlers.set(name, handler) },
                manager, null, undefined, catalog);
            const result = await handlers.get("runCronPrecheck")({ traceInfo() {} }, {
                ...input, packageId: "shared", agent,
            });
            expect(callbacks).toBe(1);
            expect(result).toMatchObject({ outcome: "error", skip: false });
            expect(fixture.state.calls).toEqual([]);
            expect(manager.getOrCreate).not.toHaveBeenCalled();
        } finally { await fixture.close(); }
    });
});
