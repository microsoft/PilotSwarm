import { describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
    createCalls: [],
    events: [],
    sendCalls: [],
    rows: new Map(),
}));

vi.mock("../../src/client.js", () => ({
    PilotSwarmClient: class {
        systemSessions = new Set();

        async start() {}
        async stop() {}

        async createSession(config) {
            transport.createCalls.push(structuredClone(config));
            const row = {
                ...structuredClone(config),
                sessionId: config.sessionId,
                state: "pending",
                sessionKind: "agent",
            };
            transport.rows.set(config.sessionId, row);
            return {
                send: async (task, options) => {
                    transport.sendCalls.push({ task, options: structuredClone(options) });
                },
            };
        }

        async resumeSession(sessionId) {
            if (!transport.rows.has(sessionId)) throw new Error(`Missing session ${sessionId}`);
            return {
                send: async (task, options) => {
                    transport.sendCalls.push({ task, options: structuredClone(options) });
                    if (transport.sendCalls.length === 1) {
                        transport.events.push({
                            seq: 1,
                            eventType: "user.message",
                            data: {
                                clientMessageIds: structuredClone(options.clientMessageIds),
                            },
                        });
                        transport.rows.get(sessionId).state = "completed";
                        throw new Error("simulated activity result loss after enqueue");
                    }
                },
            };
        }
    },
}));

import { registerActivities } from "../../src/session-proxy.ts";
import {
    ENQUEUE_WORKFLOW_AGENT_BOOTSTRAP_ACTIVITY,
    ENSURE_WORKFLOW_AGENT_CHILD_ACTIVITY,
} from "../../src/workflow-orchestration_1_0_0/contracts.ts";

describe("workflow child bootstrap replay", () => {
    it("reuses the child and retries bootstrap with one stable delivery identity", async () => {
        transport.createCalls.length = 0;
        transport.events.length = 0;
        transport.sendCalls.length = 0;
        transport.rows.clear();

        const parentSessionId = "workflow-parent";
        const childSessionId = "workflow-child";
        transport.rows.set(parentSessionId, {
            sessionId: parentSessionId,
            state: "running",
            sessionKind: "workflow",
            owner: { provider: "test", subject: "owner" },
        });

        let failMetadataOnce = true;
        const catalog = {
            getSession: async sessionId => transport.rows.get(sessionId) ?? null,
            getSessionEventsBefore: async () => [...transport.events],
            updateSession: async (sessionId, patch) => {
                if (sessionId === childSessionId && failMetadataOnce) {
                    failMetadataOnce = false;
                    throw new Error("simulated metadata failure after create");
                }
                Object.assign(transport.rows.get(sessionId), patch);
            },
        };
        const handlers = new Map();
        registerActivities(
            { registerActivity: (name, handler) => handlers.set(name, handler) },
            {
                normalizeModelRef: value => value,
                getWorkspaceProvider: () => null,
            },
            null,
            undefined,
            catalog,
            undefined,
            "in-memory://workflow-bootstrap",
        );
        const activityContext = { traceInfo() {} };
        const ensureInput = {
            parentSessionId,
            childSessionId,
            config: {
                boundAgentName: "reviewer",
                detachedPackageToolPolicy: "reject",
                toolNames: ["submit_workflow_result"],
                childContract: {
                    kind: "workflow-state-execution",
                    workflowSessionId: parentSessionId,
                    graphId: "review",
                    stateId: "inspect",
                    executionSequence: 1,
                    allowedOutcomes: ["succeeded"],
                },
            },
            nestingLevel: 1,
            isSystem: false,
            title: "reviewer",
            agentId: "reviewer",
            titleIsExplicit: false,
        };

        await expect(
            handlers.get(ENSURE_WORKFLOW_AGENT_CHILD_ACTIVITY)(
                activityContext,
                ensureInput,
            ),
        ).rejects.toThrow("simulated metadata failure after create");
        await expect(
            handlers.get(ENSURE_WORKFLOW_AGENT_CHILD_ACTIVITY)(
                activityContext,
                ensureInput,
            ),
        ).resolves.toBe(childSessionId);
        expect(transport.createCalls).toHaveLength(1);
        expect(transport.sendCalls).toHaveLength(0);

        const bootstrapInput = {
            parentSessionId,
            childSessionId,
            task: "Inspect the change.",
            requiredTool: "submit_workflow_result",
            clientMessageId: `workflow-bootstrap:${childSessionId}`,
        };
        await expect(
            handlers.get(ENQUEUE_WORKFLOW_AGENT_BOOTSTRAP_ACTIVITY)(
                activityContext,
                bootstrapInput,
            ),
        ).rejects.toThrow("simulated activity result loss after enqueue");
        await expect(
            handlers.get(ENQUEUE_WORKFLOW_AGENT_BOOTSTRAP_ACTIVITY)(
                activityContext,
                bootstrapInput,
            ),
        ).resolves.toBeUndefined();

        expect(transport.sendCalls).toHaveLength(1);
        expect(transport.sendCalls[0].options.clientMessageIds).toEqual([
            `workflow-bootstrap:${childSessionId}`,
        ]);
    });
});
