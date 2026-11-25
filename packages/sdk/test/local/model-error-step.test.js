/**
 * Recovery when a model step ends with `assistant.usage` finishReason "error"
 * and produces neither assistant text nor a tool call, without emitting
 * `session.error` (issue #383).
 *
 * Run: npx vitest run test/local/model-error-step.test.js
 */
import { describe, expect, it } from "vitest";
import { ManagedSession } from "../../src/managed-session.ts";

class FakeCopilotSession {
    registeredTools = [];
    listeners = new Map();
    catchAllHandlers = [];
    sentPrompts = [];
    scripts = [];

    constructor(scripts) {
        this.scripts = [...scripts];
    }

    on(eventType, handler) {
        if (typeof eventType === "function") {
            this.catchAllHandlers.push(eventType);
            return () => {
                this.catchAllHandlers = this.catchAllHandlers.filter((candidate) => candidate !== eventType);
            };
        }
        const handlers = this.listeners.get(eventType) ?? [];
        handlers.push(handler);
        this.listeners.set(eventType, handlers);
        return () => {
            const current = this.listeners.get(eventType) ?? [];
            this.listeners.set(eventType, current.filter((candidate) => candidate !== handler));
        };
    }

    registerTools(tools) {
        this.registeredTools = tools;
    }

    emit(eventType, data = {}) {
        for (const handler of this.catchAllHandlers) handler({ type: eventType, data });
        for (const handler of this.listeners.get(eventType) ?? []) handler({ type: eventType, data });
    }

    async invokeRegisteredTool(name, args = {}, toolCallId = `call-${name}`) {
        const tool = this.registeredTools.find((candidate) => candidate.name === name);
        if (!tool) throw new Error(`Missing registered tool: ${name}`);
        this.emit("tool.execution_start", { toolCallId, toolName: name, arguments: args });
        const result = await tool.handler(args, { toolCallId });
        this.emit("tool.execution_complete", { toolCallId, toolName: name, arguments: args, success: true, result });
        return result;
    }

    async send(payload = {}) {
        this.sentPrompts.push(payload.prompt);
        const script = this.scripts.shift();
        if (!script) throw new Error(`Unexpected send() call #${this.sentPrompts.length}`);
        queueMicrotask(async () => {
            await script(this, payload);
        });
    }

    abort() {}
}

describe("ManagedSession recovery on failed-empty model steps (issue #383)", () => {
    it("T1: recovers sequence (A) via one continuation and ignores an earlier failed-empty step", async () => {
        const live = [];
        let toolExecutions = 0;

        const fake = new FakeCopilotSession([
            (session) => {
                // Earlier failed-empty step followed by normal work must not trigger its own continuation.
                session.emit("assistant.turn_start", { turnId: "0" });
                session.emit("assistant.usage", { finishReason: "error", inputTokens: 1000, outputTokens: 100 });
                session.emit("assistant.turn_end", { turnId: "0" });

                // Step 1: runs a tool and writes no prose.
                session.emit("assistant.turn_start", { turnId: "1" });
                session.emit("assistant.message", {
                    messageId: "m1",
                    content: "",
                    toolRequests: [{ toolCallId: "c1", name: "read_file", arguments: { path: "a.txt" } }],
                });
                session.emit("tool.execution_start", { toolCallId: "c1", toolName: "read_file", arguments: { path: "a.txt" } });
                toolExecutions += 1;
                session.emit("tool.execution_complete", { toolCallId: "c1", toolName: "read_file", success: true, result: "ok" });
                session.emit("assistant.usage", { finishReason: "tool_calls", inputTokens: 1200, outputTokens: 50 });
                session.emit("assistant.turn_end", { turnId: "1" });

                // Final step: sequence (A) — usage finishReason "error" followed by empty message.
                session.emit("assistant.turn_start", { turnId: "2" });
                session.emit("assistant.usage", {
                    finishReason: "error",
                    numToolCalls: 0,
                    inputTokens: 734397,
                    outputTokens: 1779,
                });
                session.emit("assistant.message", { messageId: "m2", content: "", toolRequests: [] });
                session.emit("assistant.turn_end", { turnId: "2" });
                session.emit("session.idle", {});
            },
            (session) => {
                session.emit("assistant.turn_start", { turnId: "3" });
                session.emit("assistant.usage", { finishReason: "stop", inputTokens: 735000, outputTokens: 20 });
                session.emit("assistant.message", { messageId: "m3", content: "done", toolRequests: [] });
                session.emit("assistant.turn_end", { turnId: "3" });
                session.emit("session.idle", {});
            },
        ]);

        const result = await new ManagedSession("i383-t1", fake, {}).runTurn("do the task", {
            onEvent: (event) => live.push(event),
        });

        expect(fake.sentPrompts).toHaveLength(2);
        expect(fake.sentPrompts[1]).toMatch(/error/i);
        expect(fake.sentPrompts[1]).toMatch(/repeat/i);
        expect(toolExecutions).toBe(1);
        expect(result.type).toBe("completed");
        expect(result.content).toBe("done");

        const diag = live.filter((event) => event.eventType === "runtime.model_step_error");
        expect(diag).toEqual([{ eventType: "runtime.model_step_error", data: { attempt: 1, sessionId: "i383-t1" } }]);
        expect(result.events.some((event) => event.eventType === "runtime.model_step_error" && event.data?.attempt === 1)).toBe(true);
    });

    it("T2: recovers sequence (B) and returns continuation answer rather than earlier progress line", async () => {
        const fake = new FakeCopilotSession([
            (session) => {
                session.emit("assistant.turn_start", { turnId: "0" });
                session.emit("assistant.message", {
                    messageId: "m1",
                    content: "Checking...",
                    toolRequests: [{ toolCallId: "c1", name: "read_file", arguments: { path: "b.txt" } }],
                });
                session.emit("tool.execution_start", { toolCallId: "c1", toolName: "read_file", arguments: { path: "b.txt" } });
                session.emit("tool.execution_complete", { toolCallId: "c1", toolName: "read_file", success: true, result: "ok" });
                session.emit("assistant.usage", { finishReason: "tool_calls", inputTokens: 270000, outputTokens: 80 });
                session.emit("assistant.turn_end", { turnId: "0" });

                // Final step: sequence (B) — usage finishReason "error" with no assistant.message at all.
                session.emit("assistant.turn_start", { turnId: "1" });
                session.emit("assistant.usage", {
                    finishReason: "error",
                    inputTokens: 272679,
                    outputTokens: 15341,
                });
                session.emit("assistant.turn_end", { turnId: "1" });
                session.emit("session.idle", {});
            },
            (session) => {
                session.emit("assistant.turn_start", { turnId: "2" });
                session.emit("assistant.usage", { finishReason: "stop", inputTokens: 273000, outputTokens: 15 });
                session.emit("assistant.message", { messageId: "m2", content: "done", toolRequests: [] });
                session.emit("assistant.turn_end", { turnId: "2" });
                session.emit("session.idle", {});
            },
        ]);

        const result = await new ManagedSession("i383-t2", fake, {}).runTurn("check b.txt");

        expect(fake.sentPrompts).toHaveLength(2);
        expect(result.type).toBe("completed");
        expect(result.content).toBe("done");
        expect(result.content).not.toBe("Checking...");
    });

    it("T3: returns retryable error after continuation also ends failed-empty", async () => {
        const live = [];
        const fake = new FakeCopilotSession([
            (session) => {
                session.emit("assistant.turn_start", { turnId: "0" });
                session.emit("assistant.usage", { finishReason: "error", inputTokens: 50000, outputTokens: 900 });
                session.emit("assistant.message", { messageId: "m1", content: "", toolRequests: [] });
                session.emit("assistant.turn_end", { turnId: "0" });
                session.emit("session.idle", {});
            },
            (session) => {
                session.emit("assistant.turn_start", { turnId: "1" });
                session.emit("assistant.usage", { finishReason: "error", inputTokens: 51000, outputTokens: 700 });
                session.emit("assistant.turn_end", { turnId: "1" });
                session.emit("session.idle", {});
            },
        ]);

        const result = await new ManagedSession("i383-t3", fake, {}).runTurn("summarize", {
            onEvent: (event) => live.push(event),
        });

        expect(fake.sentPrompts).toHaveLength(2);
        expect(result.type).toBe("error");
        expect(result.retryable).not.toBe(false);
        expect(result.message).toMatch(/model|finishReason|error/i);
        expect(result.content).toBeUndefined();
        expect(live.filter((event) => event.eventType === "runtime.model_step_error")).toEqual([
            { eventType: "runtime.model_step_error", data: { attempt: 1, sessionId: "i383-t3" } },
            { eventType: "runtime.model_step_error", data: { final: true, sessionId: "i383-t3" } },
        ]);
    });

    it("T4: returns error without progress prose and preserves accepted workspace changes", async () => {
        const fake = new FakeCopilotSession([
            async (session) => {
                session.emit("assistant.turn_start", { turnId: "0" });
                session.emit("assistant.message", {
                    messageId: "m1",
                    content: "Checking...",
                    toolRequests: [{
                        toolCallId: "c-ws",
                        name: "set_session_workspace",
                        arguments: { extra: { logs: { root: "logs", folder: "svc" } } },
                    }],
                });
                await session.invokeRegisteredTool(
                    "set_session_workspace",
                    { extra: { logs: { root: "logs", folder: "svc" } } },
                    "c-ws",
                );
                session.emit("assistant.usage", { finishReason: "tool_calls", inputTokens: 10000, outputTokens: 60 });
                session.emit("assistant.turn_end", { turnId: "0" });

                session.emit("assistant.turn_start", { turnId: "1" });
                session.emit("assistant.usage", { finishReason: "error", inputTokens: 12000, outputTokens: 800 });
                session.emit("assistant.turn_end", { turnId: "1" });
                session.emit("session.idle", {});
            },
            (session) => {
                session.emit("assistant.turn_start", { turnId: "2" });
                session.emit("assistant.usage", { finishReason: "error", inputTokens: 12500, outputTokens: 400 });
                session.emit("assistant.message", { messageId: "m2", content: "", toolRequests: [] });
                session.emit("assistant.turn_end", { turnId: "2" });
                session.emit("session.idle", {});
            },
        ]);

        const result = await new ManagedSession("i383-t4", fake, {
            workspaceTools: true,
            workspace: { root: "main", folder: "repo" },
        }).runTurn("inspect logs", {
            controlToolBridge: {
                checkWorkspace: async ({ extras }) => ({
                    ok: true,
                    path: null,
                    extras: (extras ?? []).map((name) => ({ name, path: `/ws/${name}` })),
                }),
            },
        });

        expect(fake.sentPrompts).toHaveLength(2);
        expect(result.type).toBe("error");
        expect(result.retryable).not.toBe(false);
        expect(result.content).toBeUndefined();
        expect(result.queuedActions).toEqual([
            {
                type: "set_workspace_extra",
                extra: { logs: { root: "logs", folder: "svc" } },
                path: null,
                extraPaths: { logs: "/ws/logs" },
            },
        ]);
    });

    it("T4b: never returns completed when a text-tool-call correction run ends failed-empty", async () => {
        const fake = new FakeCopilotSession([
            (session) => {
                session.emit("assistant.turn_start", { turnId: "0" });
                session.emit("assistant.usage", { finishReason: "stop", inputTokens: 2000, outputTokens: 40 });
                session.emit("assistant.message", {
                    messageId: "m1",
                    content: '<invoke name="read_file"><parameter name="path">a.txt</parameter></invoke>',
                    toolRequests: [],
                });
                session.emit("assistant.turn_end", { turnId: "0" });
                session.emit("session.idle", {});
            },
            (session) => {
                session.emit("assistant.turn_start", { turnId: "1" });
                session.emit("assistant.usage", { finishReason: "error", inputTokens: 2500, outputTokens: 500 });
                session.emit("assistant.turn_end", { turnId: "1" });
                session.emit("session.idle", {});
            },
        ]);

        const result = await new ManagedSession("i383-t4b", fake, {}).runTurn("read a.txt");

        expect(fake.sentPrompts).toHaveLength(2);
        expect(result.type).toBe("error");
        expect(result.retryable).not.toBe(false);
        expect(result.content).toBeUndefined();
    });

    it("T5a (unchanged behaviour): normal multi-step turn ending with finishReason stop completes in one send", async () => {
        const fake = new FakeCopilotSession([
            (session) => {
                session.emit("assistant.turn_start", { turnId: "0" });
                session.emit("assistant.usage", { finishReason: "error", inputTokens: 800, outputTokens: 50 });
                session.emit("assistant.turn_end", { turnId: "0" });

                session.emit("assistant.turn_start", { turnId: "1" });
                session.emit("assistant.message", {
                    messageId: "m1",
                    content: "",
                    toolRequests: [{ toolCallId: "c1", name: "read_file", arguments: { path: "c.txt" } }],
                });
                session.emit("tool.execution_start", { toolCallId: "c1", toolName: "read_file", arguments: { path: "c.txt" } });
                session.emit("tool.execution_complete", { toolCallId: "c1", toolName: "read_file", success: true, result: "ok" });
                session.emit("assistant.usage", { finishReason: "tool_calls", inputTokens: 1000, outputTokens: 40 });
                session.emit("assistant.turn_end", { turnId: "1" });

                session.emit("assistant.turn_start", { turnId: "2" });
                session.emit("assistant.usage", { finishReason: "stop", inputTokens: 1500, outputTokens: 30 });
                session.emit("assistant.message", { messageId: "m2", content: "all good", toolRequests: [] });
                session.emit("assistant.turn_end", { turnId: "2" });
                session.emit("session.idle", {});
            },
        ]);

        const result = await new ManagedSession("i383-t5a", fake, {}).runTurn("read c.txt");

        expect(fake.sentPrompts).toHaveLength(1);
        expect(result.type).toBe("completed");
        expect(result.content).toBe("all good");
        expect(result.events.some((event) => event.eventType === "runtime.model_step_error")).toBe(false);
    });

    it("T5b (unchanged behaviour): real session.error plus failed-empty final step returns Execution failed without continuation", async () => {
        const fake = new FakeCopilotSession([
            (session) => {
                session.emit("assistant.turn_start", { turnId: "0" });
                session.emit("assistant.usage", { finishReason: "error", inputTokens: 5000, outputTokens: 100 });
                session.emit("session.error", { message: "upstream 502" });
                session.emit("assistant.turn_end", { turnId: "0" });
                session.emit("session.idle", {});
            },
        ]);

        const result = await new ManagedSession("i383-t5b", fake, {}).runTurn("go");

        expect(fake.sentPrompts).toHaveLength(1);
        expect(result.type).toBe("error");
        expect(result.message).toBe("Execution failed: upstream 502");
        expect(result.events.some((event) => event.eventType === "runtime.model_step_error")).toBe(false);
    });

    it("T5c (unchanged behaviour): a turn that queued a control action returns it, with no continuation", async () => {
        const fake = new FakeCopilotSession([
            async (session) => {
                session.emit("assistant.turn_start", { turnId: "0" });
                session.emit("assistant.message", {
                    messageId: "m1",
                    content: "",
                    toolRequests: [{
                        toolCallId: "c-msg",
                        name: "message_agent",
                        arguments: { agent_id: "child-1", message: "go on" },
                    }],
                });
                await session.invokeRegisteredTool("message_agent", { agent_id: "child-1", message: "go on" }, "c-msg");
                session.emit("assistant.usage", { finishReason: "tool_calls", inputTokens: 1200, outputTokens: 40 });
                session.emit("assistant.turn_end", { turnId: "0" });

                session.emit("assistant.turn_start", { turnId: "1" });
                session.emit("assistant.usage", { finishReason: "error", numToolCalls: 0, inputTokens: 734397, outputTokens: 1779 });
                session.emit("assistant.message", { messageId: "m2", content: "", toolRequests: [] });
                session.emit("assistant.turn_end", { turnId: "1" });
                session.emit("session.idle", {});
            },
        ]);

        const result = await new ManagedSession("i383-t5c", fake, {}).runTurn("tell child-1 to go on");

        expect(fake.sentPrompts).toHaveLength(1);
        expect(result.type).toBe("message_agent");
        expect(result.agentId).toBe("child-1");
        expect(result.events.some((event) => event.eventType === "runtime.model_step_error")).toBe(false);
    });

    it("T5d (unchanged behaviour): a turn the user stopped is not continued", async () => {
        let managed;
        const fake = new FakeCopilotSession([
            (session) => {
                session.emit("assistant.turn_start", { turnId: "0" });
                session.emit("assistant.message", {
                    messageId: "m1",
                    content: "",
                    toolRequests: [{ toolCallId: "c1", name: "read_file", arguments: { path: "a.txt" } }],
                });
                session.emit("tool.execution_start", { toolCallId: "c1", toolName: "read_file", arguments: { path: "a.txt" } });
                session.emit("tool.execution_complete", { toolCallId: "c1", toolName: "read_file", success: true, result: "ok" });
                session.emit("assistant.usage", { finishReason: "tool_calls", inputTokens: 1000, outputTokens: 40 });
                session.emit("assistant.turn_end", { turnId: "0" });

                session.emit("assistant.turn_start", { turnId: "1" });
                session.emit("assistant.usage", { finishReason: "error", inputTokens: 2000, outputTokens: 100 });
                managed.requestStop("user stop");
                managed.abort();
                session.emit("assistant.turn_end", { turnId: "1" });
                session.emit("session.idle", {});
            },
        ]);

        managed = new ManagedSession("i383-t5d", fake, {});
        const result = await managed.runTurn("read a.txt");

        expect(fake.sentPrompts).toHaveLength(1);
        expect(result.type).toBe("stopped");
        expect(result.reason).toBe("user stop");
        expect((result.events ?? []).some((event) => event.eventType === "runtime.model_step_error")).toBe(false);
    });

    it("T5e (unchanged behaviour): an aborted turn is not continued", async () => {
        let managed;
        const fake = new FakeCopilotSession([
            (session) => {
                session.emit("assistant.turn_start", { turnId: "0" });
                session.emit("assistant.message", {
                    messageId: "m1",
                    content: "",
                    toolRequests: [{ toolCallId: "c1", name: "read_file", arguments: { path: "a.txt" } }],
                });
                session.emit("tool.execution_start", { toolCallId: "c1", toolName: "read_file", arguments: { path: "a.txt" } });
                session.emit("tool.execution_complete", { toolCallId: "c1", toolName: "read_file", success: true, result: "ok" });
                session.emit("assistant.usage", { finishReason: "tool_calls", inputTokens: 1000, outputTokens: 40 });
                session.emit("assistant.turn_end", { turnId: "0" });

                session.emit("assistant.turn_start", { turnId: "1" });
                session.emit("assistant.usage", { finishReason: "error", inputTokens: 2000, outputTokens: 100 });
                managed.abort();
                session.emit("assistant.turn_end", { turnId: "1" });
                session.emit("session.idle", {});
            },
        ]);

        managed = new ManagedSession("i383-t5e", fake, {});
        const result = await managed.runTurn("read a.txt");

        expect(fake.sentPrompts).toHaveLength(1);
        expect(result.type).toBe("completed");
        expect(result.content).toBe("(no response)");
        expect((result.events ?? []).some((event) => event.eventType === "runtime.model_step_error")).toBe(false);
    });
});
