import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { registerWorkflowActivities } from "../../src/workflow/activities.js";
import { WORKFLOW_SESSION_ORCHESTRATION_REGISTRY } from "../../src/workflow/orchestration.js";
import { WORKFLOW_TOOL_POLICY } from "../../src/workflow/tool-policy.js";

const { Runtime, Client, SqliteProvider } = createRequire(import.meta.url)("duroxide");
const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: durable-watch, version: "1" }
initial: poll
states:
  poll:
    type: script
    runtime: node
    source: |
      const result = await callTool("snapshot", {});
      await setResult(result.changed ? "changed" : "quiet", result);
    completion: { outcomes: [quiet, changed] }
    transition:
      next: { quiet: poll, changed: end }
      delaySeconds: { quiet: 2 }
  end: { type: terminal, outcome: succeeded, output: "\${states.poll.result}" }
`;

async function waitFor(check) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const result = await check();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("workflow did not reach its delay");
}

async function fixture({ failDeliveryOnce = false, failFinishOnce = false, failEndEventOnce = false } = {}) {
    const provider = await SqliteProvider.inMemory();
    const client = new Client(provider);
    const events = [], messages = [];
    let polls = 0, attempts = 0, terminalUpdates = 0;
    const deps = {
        enabled: () => true,
        catalog: {
            updateSession: async (_id, update) => {
                if (update.state === "completed") {
                    if (failFinishOnce) { failFinishOnce = false; throw new Error("temporary catalog update failure"); }
                    terminalUpdates++;
                }
            },
            recordEvents: async (_id, rows) => {
                if (failEndEventOnce && rows.some(row => row.eventType === "workflow.completed")) {
                    failEndEventOnce = false;
                    throw new Error("temporary end event failure");
                }
                events.push(...rows);
            },
            getSessionEvents: async (_id, _after, _limit, types) => events.filter(event => types.includes(event.eventType)),
        },
        resolveTools: async () => new Map(),
        resolveToolBinding: async () => ({ policy: WORKFLOW_TOOL_POLICY }),
        openToolExecutor: async () => ({
            call: async () => ({ changed: ++polls >= 2, head: polls >= 2 ? "new" : "old" }),
            close: async () => {},
        }),
        authorizeParentNotification: async () => true,
        notifyParent: async (...args) => {
            attempts++;
            if (failDeliveryOnce && attempts === 1) throw new Error("temporary enqueue failure");
            messages.push(args);
        },
    };
    const startWorker = async () => {
        const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
        registerWorkflowActivities(runtime, deps);
        for (const { version, handler } of WORKFLOW_SESSION_ORCHESTRATION_REGISTRY) {
            runtime.registerOrchestrationVersioned("workflow-session", version, handler);
        }
        await runtime.start();
        return runtime;
    };
    return { client, events, messages, startWorker, get polls() { return polls; }, get attempts() { return attempts; },
        get terminalUpdates() { return terminalUpdates; } };
}

function start(client, id, options = {}) {
    return client.startOrchestrationVersioned(`session-${id}`, "workflow-session", {
        sessionId: id, parentSessionId: "parent", yaml, inputs: {},
        executionPolicy: WORKFLOW_TOOL_POLICY, ...options,
    }, "1.1.0");
}

describe("child workflow controller 1.1 on the real durable runtime", () => {
    for (const failure of ["failFinishOnce", "failEndEventOnce"]) {
        it(`retries ${failure} without duplicating the terminal event or losing the parent wake`, async () => {
            const f = await fixture({ [failure]: true });
            const worker = await f.startWorker();
            try {
                await start(f.client, failure);
                const result = await f.client.waitForOrchestration(`session-${failure}`, 30_000);
                expect(result.status, JSON.stringify(result)).toBe("Completed");
                expect(f.terminalUpdates).toBe(1);
                expect(f.events.filter(event => event.eventType === "workflow.completed")).toHaveLength(1);
                expect(f.messages).toHaveLength(1);
            } finally { await worker.shutdown(100); }
        });
    }

    it("deduplicates repeated starts with the same instance ID on the actual provider", async () => {
        const f = await fixture();
        const worker = await f.startWorker();
        try {
            await Promise.all([start(f.client, "duplicate"), start(f.client, "duplicate")]);
            const result = await f.client.waitForOrchestration("session-duplicate", 30_000);
            expect(result.status, JSON.stringify(result)).toBe("Completed");
            expect(f.polls).toBe(2);
            expect(f.messages).toHaveLength(1);
        } finally { await worker.shutdown(100); }
    });

    it("keeps an unsupported orchestration version queued until an upgraded worker starts", async () => {
        const provider = await SqliteProvider.inMemory();
        const client = new Client(provider);
        const oldWorker = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
        oldWorker.registerOrchestrationVersioned("rollout-probe", "1.0.0", function* () { return "old"; });
        await oldWorker.start();
        let upgraded;
        try {
            await client.startOrchestrationVersioned("old-control", "rollout-probe", {}, "1.0.0");
            expect((await client.waitForOrchestration("old-control", 5_000)).status).toBe("Completed");
            await client.startOrchestrationVersioned("new-version", "rollout-probe", {}, "1.1.0");
            await new Promise(resolve => setTimeout(resolve, 150));
            const status = await client.getStatus("new-version");
            expect(status.status, JSON.stringify(status)).not.toBe("Failed");
            await oldWorker.shutdown(100);
            upgraded = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
            upgraded.registerOrchestrationVersioned("rollout-probe", "1.1.0", function* () { return "new"; });
            await upgraded.start();
            const result = await client.waitForOrchestration("new-version", 10_000);
            expect(result.status, JSON.stringify(result)).toBe("Completed");
            expect(result.output).toBe("new");
        } finally {
            if (upgraded) await upgraded.shutdown(100);
            else await oldWorker.shutdown(100);
        }
    });
    it("replays a waiting child after worker restart without repeating the completed poll", async () => {
        const f = await fixture();
        let worker = await f.startWorker();
        try {
            await start(f.client, "restart");
            await waitFor(async () => {
                const status = await f.client.getStatus("session-restart");
                return status.customStatus && JSON.parse(status.customStatus).workflow.waitingUntil;
            });
            expect(f.polls).toBe(1);
            expect(f.messages).toHaveLength(0);
            await worker.shutdown(100);
            worker = await f.startWorker();
            const result = await f.client.waitForOrchestration("session-restart", 30_000);
            expect(result.status, JSON.stringify(result)).toBe("Completed");
            expect(f.polls).toBe(2);
            expect(f.messages).toHaveLength(1);
            expect(f.events.filter(event => event.eventType === "workflow.completed")).toHaveLength(1);
        } finally { await worker.shutdown(100); }
    });

    it("cancels a delay on a parent command without another poll or redundant notification", async () => {
        const f = await fixture();
        const worker = await f.startWorker();
        try {
            await start(f.client, "cancel");
            await waitFor(async () => {
                const status = await f.client.getStatus("session-cancel");
                return status.customStatus && JSON.parse(status.customStatus).workflow.waitingUntil;
            });
            await f.client.enqueueEvent("session-cancel", "messages", JSON.stringify({
                type: "cmd", cmd: "cancel", requestedBy: "parent",
            }));
            const result = await f.client.waitForOrchestration("session-cancel", 30_000);
            expect(result.status, JSON.stringify(result)).toBe("Completed");
            expect(result.output.status).toBe("cancelled");
            expect(f.polls).toBe(1);
            expect(f.messages).toHaveLength(0);
        } finally { await worker.shutdown(100); }
    });

    it("retries delivery independently without repeating terminal effects or script states", async () => {
        const f = await fixture({ failDeliveryOnce: true });
        const worker = await f.startWorker();
        try {
            await start(f.client, "retry");
            const result = await f.client.waitForOrchestration("session-retry", 30_000);
            expect(result.status, JSON.stringify(result)).toBe("Completed");
            expect(f.polls).toBe(2);
            expect(f.attempts).toBe(2);
            expect(f.messages).toHaveLength(1);
            expect(f.events.filter(event => event.eventType === "workflow.completed")).toHaveLength(1);
            expect(f.events.filter(event => event.eventType === "workflow.parent_notification_failed")).toHaveLength(1);
        } finally { await worker.shutdown(100); }
    });
});
