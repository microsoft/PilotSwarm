import { describe, it } from "vitest";
import { SessionManager } from "../../src/session-manager.ts";
import { approvePermissionForSession, sessionApprovalForPermissionRequest } from "../../src/permissions.ts";
import { assertEqual, assertNotNull } from "../helpers/assertions.js";
import { createTempSessionLayout } from "../helpers/temp-session-layout.js";

class FakeCopilotSession {}

class FakeCopilotClient {
    createdSessionConfigs = [];
    session = new FakeCopilotSession();

    async createSession(config) {
        this.createdSessionConfigs.push(config);
        return this.session;
    }

    async resumeSession(_sessionId, config) {
        this.createdSessionConfigs.push(config);
        return this.session;
    }

    async stop() {}
}

function createNoopFactStore() {
    return {
        async initialize() {},
        async storeFact(input) {
            return { key: input.key, shared: input.shared === true, stored: true };
        },
        async readFacts() {
            return { count: 0, facts: [] };
        },
        async deleteFact(input) {
            return { key: input.key, shared: input.shared === true, deleted: true };
        },
        async deleteSessionFactsForSession() {
            return 0;
        },
        async close() {},
    };
}

function createManagerHarness() {
    const layout = createTempSessionLayout("pilotswarm-permission-contract-");
    const manager = new SessionManager(process.env.GITHUB_TOKEN, null, {}, layout.sessionStateDir);
    const fakeClient = new FakeCopilotClient();
    manager.client = fakeClient;
    manager.setFactStore(createNoopFactStore());

    return {
        manager,
        fakeClient,
        cleanup: layout.cleanup,
    };
}

describe("Permission handler contracts", () => {
    it("uses a one-shot SDK response for shell permissions after runtime 1.0.112 revalidation", async () => {
        const harness = createManagerHarness();
        try {
            await harness.manager.getOrCreate("default-permission-session", {
                toolNames: [],
            }, { turnIndex: 0 });

            const sessionConfig = harness.fakeClient.createdSessionConfigs[0];
            assertNotNull(sessionConfig, "SDK session config should be captured");
            assertEqual(typeof sessionConfig.onPermissionRequest, "function", "default permission handler should be installed");

            const result = await sessionConfig.onPermissionRequest({
                kind: "shell",
                commands: [{ identifier: "echo", readOnly: true }],
                fullCommandText: "echo permission-probe",
            }, { sessionId: "default-permission-session" });

            assertEqual(result.kind, "approve-once", "runtime 1.0.112 shell requests should be approved only after this exact validation");
        } finally {
            harness.cleanup();
        }
    });

    it("maps common permission request kinds to session approvals", async () => {
        const shellApproval = sessionApprovalForPermissionRequest({
            kind: "shell",
            commands: [{ identifier: "git" }, { identifier: "git" }, { identifier: "az" }],
        });
        assertEqual(shellApproval?.kind, "commands", "shell requests should map to command approval");
        assertEqual(JSON.stringify(shellApproval?.commandIdentifiers), JSON.stringify(["git", "az"]), "shell approvals should dedupe command identifiers");

        assertEqual(sessionApprovalForPermissionRequest({ kind: "read" })?.kind, "read", "read requests should map to read approval");
        assertEqual(sessionApprovalForPermissionRequest({ kind: "write" })?.kind, "write", "write requests should map to write approval");
        assertEqual(sessionApprovalForPermissionRequest({ kind: "memory" })?.kind, "memory", "memory requests should map to memory approval");

        const oneShot = approvePermissionForSession({
            kind: "shell",
            canOfferSessionApproval: false,
            commands: [{ identifier: "echo" }],
        });
        assertEqual(oneShot.kind, "approve-once", "requests that forbid a session-wide grant should be approved once");

        const mcpApproval = sessionApprovalForPermissionRequest({
            kind: "mcp",
            serverName: "server-a",
            toolName: "tool-a",
        });
        assertEqual(mcpApproval?.kind, "mcp", "MCP requests should map to MCP approval");
        assertEqual(mcpApproval?.serverName, "server-a", "MCP approval should preserve server name");
        assertEqual(mcpApproval?.toolName, "tool-a", "MCP approval should preserve tool name");

        const customToolApproval = sessionApprovalForPermissionRequest({
            kind: "custom-tool",
            toolName: "publish_report",
        });
        assertEqual(customToolApproval?.kind, "custom-tool", "custom tools should map to custom-tool approval");
        assertEqual(customToolApproval?.toolName, "publish_report", "custom tool approval should preserve tool name");

        const urlResult = approvePermissionForSession({ kind: "url" });
        assertEqual(urlResult.kind, "approve-once", "unsupported session approval kinds should fall back to one-shot approval");
    });

    it("on a turn of a worker that runs workflow agent states, refuses MCP tools only while the session runs under a real-agent test", async () => {
        // Workflow: a workflow request turn (1.0.83) gets this handler; every other turn keeps its handler as it is.
        const harness = createManagerHarness();
        try {
            const managed = await harness.manager.getOrCreate("milestone-permission-session", {
                toolNames: [],
                workflowMilestoneTurn: true,
            }, { turnIndex: 0 });

            const sessionConfig = harness.fakeClient.createdSessionConfigs[0];
            assertNotNull(sessionConfig, "SDK session config should be captured");
            const mcp = { kind: "mcp", serverName: "server-a", toolName: "tool-a" };
            const before = await sessionConfig.onPermissionRequest(mcp, { sessionId: "milestone-permission-session" });
            assertEqual(before.kind, "approve-for-session", "an MCP tool is approved as before while the session is not under a test");
            assertEqual(before.approval.kind, "mcp", "the approval is the default handler's");

            // The session's turn ran under a real-agent test (ManagedSession sets this from the turn's bridge).
            managed.workflowTestSessionActive = () => true;
            const refused = await sessionConfig.onPermissionRequest(mcp, { sessionId: "milestone-permission-session" });
            assertEqual(refused.kind, "reject", "an MCP tool cannot be intercepted, so it is refused under a real-agent test");
            assertEqual((await sessionConfig.onPermissionRequest({ kind: "mcp-sampling", serverName: "server-a" })).kind, "reject",
                "MCP sampling is refused too");
            const shell = await sessionConfig.onPermissionRequest({ kind: "shell", commands: [{ identifier: "echo" }] },
                { sessionId: "milestone-permission-session" });
            assertEqual(shell.kind, "approve-once", "a built-in shell permission uses the runtime 1.0.112-safe default, as in a live run");
        } finally {
            harness.cleanup();
        }
    });

    it("forwards worker-side custom permission handlers without changing the result shape", async () => {
        const harness = createManagerHarness();
        const seenRequests = [];
        const customHandler = async (request, invocation) => {
            seenRequests.push({ request, invocation });
            return { kind: "approve-once" };
        };

        try {
            harness.manager.setConfig("custom-permission-session", {
                toolNames: [],
                onPermissionRequest: customHandler,
            });

            await harness.manager.getOrCreate("custom-permission-session", {
                toolNames: [],
            }, { turnIndex: 0 });

            const sessionConfig = harness.fakeClient.createdSessionConfigs[0];
            assertNotNull(sessionConfig, "SDK session config should be captured");
            assertEqual(sessionConfig.onPermissionRequest, customHandler, "custom permission handler should be forwarded unchanged");

            const result = await sessionConfig.onPermissionRequest({
                kind: "shell",
                fullCommandText: "echo permission-probe",
            }, { sessionId: "custom-permission-session" });

            assertEqual(result.kind, "approve-once", "custom permission handler result should be returned unchanged");
            assertEqual(seenRequests.length, 1, "custom permission handler should see the shell request");
            assertEqual(seenRequests[0].request.kind, "shell", "request kind should be preserved");
            assertEqual(seenRequests[0].invocation.sessionId, "custom-permission-session", "invocation session id should be preserved");
        } finally {
            harness.cleanup();
        }
    });
});
