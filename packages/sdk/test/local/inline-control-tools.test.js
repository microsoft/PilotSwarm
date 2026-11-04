import { describe, expect, it, vi } from "vitest";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { ManagedSession, TURN_INACTIVITY_ERROR_MARKER } from "../../src/managed-session.ts";
import { LiveTurnControl } from "../../src/turn-control.ts";
import { collectContractViolations, isFailureToolCompletion, SYSTEM_ONLY_TURN_PROMPT } from "../../src/session-proxy.ts";
import { WORKFLOW_ASK_USER_REFUSAL } from "../../src/workflow/v2/input-policy.ts";
import {
    answerAsksParent, publishedScheduleActive, turnAskedForAnswer, turnScheduleEffect, workflowAgentReminderText,
} from "../../src/workflow/v2/agent-reminder.ts";

class FakeCopilotSession {
    registeredTools = [];
    listeners = new Map();
    catchAllHandlers = [];
    scriptedToolCalls = [];
    scriptedEvents = [];
    scriptedSends = [];
    sentPrompts = [];
    assistantContent = "ok";
    aborted = false;

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

    emit(eventType, payload = {}) {
        for (const handler of this.catchAllHandlers) {
            handler({ type: eventType, data: payload.data ?? payload });
        }
        const handlers = this.listeners.get(eventType) ?? [];
        for (const handler of handlers) {
            handler(payload);
        }
    }

    async send(payload = {}) {
        this.sentPrompts.push(payload.prompt);
        this.aborted = false;
        const scriptedSend = this.scriptedSends.length > 0
            ? this.scriptedSends.shift()
            : {
                toolCalls: this.scriptedToolCalls,
                events: this.scriptedEvents,
                assistantContent: this.assistantContent,
            };
        queueMicrotask(async () => {
            // A run that starts only after send() resolved (as the CLI's, which accepts the prompt first): `delayMs`.
            if (scriptedSend.delayMs) await new Promise((resolve) => setTimeout(resolve, scriptedSend.delayMs));
            for (const call of scriptedSend.toolCalls ?? []) {
                if (this.aborted) break;
                const tool = this.registeredTools.find((candidate) => candidate.name === call.name);
                if (!tool) throw new Error(`Missing fake tool: ${call.name}`);
                this.emit("tool.execution_start", { data: { toolName: call.name, arguments: call.args ?? {} } });
                const result = await tool.handler(call.args ?? {}, { toolCallId: call.id ?? `call-${call.name}` });
                this.emit("tool.execution_complete", { data: { toolName: call.name, arguments: call.args ?? {}, result } });
            }
            for (const delta of scriptedSend.assistantDeltas ?? []) {
                this.emit("assistant.message_delta", { data: { deltaContent: delta } });
            }
            if (!this.aborted && scriptedSend.assistantContent != null) {
                this.emit("assistant.message", { data: { content: scriptedSend.assistantContent } });
            }
            for (const event of scriptedSend.events ?? []) {
                this.emit(event.type, { data: event.data ?? {} });
            }
            this.emit("session.idle", { data: {} });
        });
    }

    abort() {
        this.aborted = true;
    }
}

describe("tool completion telemetry classification", () => {
    it.each([
        ["native SDK failure", { success: false, error: { code: "failure", message: "Canvas refused" } }, true],
        ["native SDK failure without details", { success: false }, true],
        ["legacy failure", { resultType: "failure" }, true],
        ["legacy error string", { error: "Canvas refused" }, true],
        ["legacy error message", { errorMessage: "Canvas refused" }, true],
        ["successful completion", { success: true, result: { content: "drawn" } }, false],
        ["ordinary error-looking text", { success: true, result: "Error: ordinary tool output" }, false],
        ["empty event", {}, false],
        ["missing event", undefined, false],
        ["null event", null, false],
    ])("classifies %s", (_label, data, expected) => {
        expect(isFailureToolCompletion(data)).toBe(expected);
    });
});

describe("inline control tool execution", () => {
    it.each([
        ["inline HTML", { html: "<html><body>Demo</body></html>", slot: 0 }, "slot must be an integer 1-5", false],
        ["a stored artifact", { fromArtifact: { filename: "missing.html" } }, "Artifact not found: missing.html", true],
    ])("reports a refused canvas draw from %s as a failed tool result", async (
        _source,
        args,
        reason,
        expectsAppHint,
    ) => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            {
                name: "draw_canvas",
                args,
            },
        ];

        const controlToolBridge = {
            drawCanvas: vi.fn(async () => ({
                error: reason,
            })),
        };

        const toolResults = [];
        fakeSession.on("tool.execution_complete", (event) => {
            toolResults.push(event.data.result);
        });

        const managed = new ManagedSession("canvas-refusal-repro", fakeSession, {});
        await managed.runTurn("Draw the demo canvas.", { controlToolBridge });

        expect(controlToolBridge.drawCanvas).toHaveBeenCalledTimes(1);
        expect(toolResults).toHaveLength(1);

        expect(toolResults[0]).toMatchObject({
            resultType: "failure",
            error: expect.stringContaining(reason),
            textResultForLlm: expect.stringContaining(reason),
        });
        expect(toolResults[0].textResultForLlm).toContain("Address the reported reason before retrying.");
        expect(toolResults[0].textResultForLlm.includes("find_canvas_app")).toBe(expectsAppHint);
    });

    it("preserves successful canvas draw results", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            {
                name: "draw_canvas",
                args: { html: "<html><body>Demo</body></html>" },
            },
        ];

        const controlToolBridge = {
            drawCanvas: vi.fn(async () => ({
                rev: 1,
                sizeBytes: 30,
            })),
        };

        const toolResults = [];
        fakeSession.on("tool.execution_complete", (event) => {
            toolResults.push(event.data.result);
        });

        const managed = new ManagedSession("canvas-success-repro", fakeSession, {});
        await managed.runTurn("Draw the demo canvas.", { controlToolBridge });

        expect(controlToolBridge.drawCanvas).toHaveBeenCalledTimes(1);
        expect(toolResults).toHaveLength(1);
        expect(JSON.parse(toolResults[0])).toMatchObject({
            drawn: true,
            rev: 1,
            sizeBytes: 30,
        });
    });

    it.each([
        ["update_canvas", "updateCanvas", { data: { value: 1 } }],
        ["show_canvas", "showCanvas", {}],
        ["read_canvas", "readCanvas", {}],
        ["canvas_kv", "canvasKv", { op: "get", key: "demo" }],
        ["publish_canvas_app", "publishCanvasApp", { name: "demo" }],
        ["find_canvas_app", "findCanvasApp", { query: "demo" }],
    ])("reports a refused %s call as a failed tool result", async (
        toolName,
        bridgeMethod,
        args,
    ) => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [{ name: toolName, args }];

        const reason = "Canvas operation refused for this reproduction";
        const bridgeHandler = vi.fn(async () => ({ error: reason }));
        const controlToolBridge = {
            [bridgeMethod]: bridgeHandler,
        };

        const toolResults = [];
        fakeSession.on("tool.execution_complete", (event) => {
            toolResults.push(event.data.result);
        });

        const managed = new ManagedSession("canvas-tools-refusal", fakeSession, {});
        await managed.runTurn("Run the canvas operation.", { controlToolBridge });

        expect(bridgeHandler).toHaveBeenCalledTimes(1);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0]).toMatchObject({
            resultType: "failure",
            error: expect.stringContaining(reason),
            textResultForLlm: expect.stringContaining(reason),
        });
    });

    it.each([
        "draw_canvas",
        "update_canvas",
        "show_canvas",
        "read_canvas",
        "canvas_kv",
        "publish_canvas_app",
        "find_canvas_app",
    ])("reports an unavailable bridge for %s as a failed tool result", async (
        toolName,
    ) => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [{ name: toolName, args: {} }];

        const toolResults = [];
        fakeSession.on("tool.execution_complete", (event) => {
            toolResults.push(event.data.result);
        });

        const managed = new ManagedSession("canvas-no-bridge", fakeSession, {});
        await managed.runTurn("Run the canvas operation.");

        expect(toolResults).toHaveLength(1);
        expect(toolResults[0]).toMatchObject({
            resultType: "failure",
            error: expect.stringContaining("canvas bridge is unavailable"),
            textResultForLlm: expect.stringContaining("canvas bridge is unavailable"),
        });
    });

    it.each([
        ["draw_canvas", "drawCanvas", { html: 42 }, "html must be a string"],
        ["draw_canvas", "drawCanvas", {}, "pass exactly one source"],
        ["draw_canvas", "drawCanvas", { html: "", fromArtifact: { filename: "demo.html" } }, "pass exactly one source"],
        ["draw_canvas", "drawCanvas", { fromArtifact: { filename: " " } }, "fromArtifact.filename is required"],
        ["draw_canvas", "drawCanvas", { html: "x".repeat(900_001) }, "keep it under 900 KB"],
        ["draw_canvas", "drawCanvas", { html: "\u00e9".repeat(450_001) }, "900002 bytes"],
        ["draw_canvas", "drawCanvas", { html: "<html></html>", responseContract: { actions: {} } }, "invalid responseContract"],
        ["update_canvas", "updateCanvas", {}, "pass exactly one of data"],
        ["update_canvas", "updateCanvas", { data: {}, patch: {} }, "pass exactly one of data"],
        ["update_canvas", "updateCanvas", { data: [] }, "not an array"],
        ["update_canvas", "updateCanvas", { patch: [] }, "not an array"],
        ["update_canvas", "updateCanvas", { data: null }, "must be a JSON object"],
        ["update_canvas", "updateCanvas", { patch: "invalid" }, "must be a JSON object"],
        ["update_canvas", "updateCanvas", { data: { text: "x".repeat(32_758) } }, "32769"],
        ["update_canvas", "updateCanvas", { patch: { text: "\u00e9".repeat(16_379) } }, "32769"],
        ["canvas_kv", "canvasKv", { op: "invalid" }, "op must be get, put, list or delete"],
    ])("reports invalid %s arguments as a failed tool result (%#)", async (
        toolName,
        bridgeMethod,
        args,
        reason,
    ) => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [{ name: toolName, args }];
        const bridgeHandler = vi.fn();
        const toolResults = [];
        fakeSession.on("tool.execution_complete", (event) => {
            toolResults.push(event.data.result);
        });

        const managed = new ManagedSession("canvas-invalid-arguments", fakeSession, {});
        await managed.runTurn("Run the canvas operation.", {
            controlToolBridge: { [bridgeMethod]: bridgeHandler },
        });

        expect(bridgeHandler).not.toHaveBeenCalled();
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0]).toMatchObject({
            resultType: "failure",
            error: expect.stringContaining(reason),
            textResultForLlm: expect.stringContaining(reason),
        });
    });

    it.each([
        ["draw_canvas", "drawCanvas", { html: "" }, { rev: 2, sizeBytes: 0 }, { drawn: true, rev: 2, sizeBytes: 0 }],
        ["draw_canvas", "drawCanvas", { html: "x".repeat(900_000) }, { rev: 3, sizeBytes: 900_000 }, { drawn: true, sizeBytes: 900_000 }],
        ["update_canvas", "updateCanvas", { data: { text: "x".repeat(32_757) } }, { dataRev: 2, sizeBytes: 32_768 }, { updated: true, mode: "data", sizeBytes: 32_768 }],
        ["update_canvas", "updateCanvas", { patch: { value: null } }, { dataRev: 3, sizeBytes: 2 }, { updated: true, mode: "patch", sizeBytes: 2 }],
        ["show_canvas", "showCanvas", { slot: 2 }, { slot: 2, rev: 1 }, { presented: true, slot: 2, rev: 1 }],
        ["read_canvas", "readCanvas", {}, { exists: true, rev: 1 }, { exists: true, rev: 1 }],
        ["canvas_kv", "canvasKv", { op: "get", key: "missing" }, { found: false }, { found: false }],
        ["publish_canvas_app", "publishCanvasApp", { name: "demo" }, { published: true }, { published: true }],
        ["find_canvas_app", "findCanvasApp", { query: "demo" }, { count: 1, apps: [{ name: "demo" }] }, { count: 1, apps: [{ name: "demo" }] }],
        ["find_canvas_app", "findCanvasApp", { query: "missing" }, { count: 0, apps: [] }, { count: 0, apps: [] }],
    ])("preserves successful %s results (%#)", async (
        toolName,
        bridgeMethod,
        args,
        bridgeResult,
        expected,
    ) => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [{ name: toolName, args }];
        const bridgeHandler = vi.fn(async () => bridgeResult);
        const toolResults = [];
        fakeSession.on("tool.execution_complete", (event) => {
            toolResults.push(event.data.result);
        });

        const managed = new ManagedSession("canvas-success", fakeSession, {});
        await managed.runTurn("Run the canvas operation.", {
            controlToolBridge: { [bridgeMethod]: bridgeHandler },
        });

        expect(bridgeHandler).toHaveBeenCalledTimes(1);
        expect(toolResults).toHaveLength(1);
        expect(typeof toolResults[0]).toBe("string");
        expect(JSON.parse(toolResults[0])).toMatchObject(expected);
    });

    it("keeps an absent canvas as a normal read result", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [{ name: "read_canvas", args: {} }];
        const toolResults = [];
        fakeSession.on("tool.execution_complete", (event) => {
            toolResults.push(event.data.result);
        });

        const managed = new ManagedSession("canvas-empty-read", fakeSession, {});
        await managed.runTurn("Read the canvas.", {
            controlToolBridge: { readCanvas: vi.fn(async () => ({ exists: false })) },
        });

        expect(toolResults).toEqual(["No canvas has been drawn on this session yet."]);
    });

    it("fails before the model turn when a required tool handler is unavailable", async () => {
        const fakeSession = new FakeCopilotSession();
        const managed = new ManagedSession("required-tool-unavailable", fakeSession, {});

        const result = await managed.runTurn("Verify the package catalog.", { requiredTool: "package_catalog" });

        expect(result).toMatchObject({
            type: "error",
            retryable: false,
            message: 'Required tool "package_catalog" is not available in this session.',
        });
        expect(fakeSession.sentPrompts).toHaveLength(0);
    });

    it("retries once when a required tool was claimed but not invoked", async () => {
        const fakeSession = new FakeCopilotSession();
        const catalog = vi.fn(async () => ({ commands: 71 }));
        fakeSession.scriptedSends = [
            {
                assistantDeltas: ["The catalog has ", "71 commands."],
                assistantContent: "The catalog has 71 commands.",
            },
            {
                toolCalls: [{ name: "package_catalog", args: { arguments: ["catalog"] } }],
                assistantDeltas: ["Catalog ", "verified."],
                assistantContent: "Catalog verified.",
            },
        ];
        const visibleEvents = [];
        const visibleDeltas = [];

        const managed = new ManagedSession("required-tool-correction", fakeSession, {
            tools: [{ name: "package_catalog", parameters: { type: "object", properties: {} }, handler: catalog }],
        });
        const result = await managed.runTurn("Verify the package catalog.", {
            requiredTool: "package_catalog",
            liveTurn: true,
            onEvent: (event) => visibleEvents.push(event),
            onDelta: (delta) => visibleDeltas.push(delta),
        });

        expect(result.type).toBe("completed");
        expect(result.content).toBe("Catalog verified.");
        expect(catalog).toHaveBeenCalledOnce();
        expect(fakeSession.sentPrompts).toHaveLength(2);
        expect(fakeSession.sentPrompts[0]).toContain('MUST invoke the tool "package_catalog"');
        expect(fakeSession.sentPrompts[0]).toContain("Verify the package catalog.");
        expect(fakeSession.sentPrompts[1]).toContain("Required-tool contract violation");
        expect(fakeSession.sentPrompts[1]).toContain('Invoke "package_catalog" now');
        expect(fakeSession.sentPrompts[1]).toContain("answer only from its result");
        expect(result.events).toEqual(expect.arrayContaining([
            expect.objectContaining({ eventType: "runtime.required_tool_not_invoked" }),
            expect.objectContaining({ eventType: "tool.execution_start", data: expect.objectContaining({ toolName: "package_catalog" }) }),
        ]));
        expect(visibleEvents
            .filter((event) => event.eventType === "assistant.message")
            .map((event) => event.data.content))
            .toEqual(["Catalog verified."]);
        expect(visibleEvents
            .filter((event) => event.eventType === "assistant.message_delta")
            .map((event) => event.data.deltaContent))
            .toEqual(["Catalog ", "verified."]);
        expect(visibleDeltas).toEqual(["Catalog ", "verified."]);
        expect(visibleEvents
            .filter((event) => event.eventType === "assistant.live_tick" && event.data.phase === "live")
            .every((event) => !String(event.data.text).includes("71 commands")))
            .toBe(true);
        expect(result.events
            .filter((event) => event.eventType === "assistant.message")
            .map((event) => event.data.content))
            .toEqual(["Catalog verified."]);
    });

    it("fails closed when a required tool is omitted again after correction", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedSends = [
            { assistantContent: "The catalog has 71 commands." },
            { assistantContent: "I confirm the same result." },
        ];

        const managed = new ManagedSession("required-tool-fail-closed", fakeSession, {
            tools: [{ name: "package_catalog", parameters: { type: "object", properties: {} }, handler: vi.fn() }],
        });
        const result = await managed.runTurn("Verify the package catalog.", { requiredTool: "package_catalog" });

        expect(result.type).toBe("error");
        expect(result.retryable).toBe(false);
        expect(result.message).toContain('Required tool "package_catalog" was not invoked');
        expect(fakeSession.sentPrompts).toHaveLength(2);
        expect(result.events.filter((event) => event.eventType === "runtime.required_tool_not_invoked")).toHaveLength(2);
        expect(result.events.filter((event) => event.eventType === "assistant.message")).toHaveLength(0);
    });

    it("keeps spawn_agent inline when a control bridge is provided", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "spawn_agent", args: { task: "say hi" } },
        ];
        fakeSession.assistantContent = "Spawned one and continuing.";

        const controlToolBridge = {
            spawnAgent: vi.fn(async () => "[SYSTEM: spawned]"),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(),
            listSessions: vi.fn(),
            completeAgent: vi.fn(),
            cancelAgent: vi.fn(),
            deleteAgent: vi.fn(),
        };

        const managed = new ManagedSession("inline-spawn", fakeSession, {});
        const result = await managed.runTurn("spawn a child", { controlToolBridge });

        expect(controlToolBridge.spawnAgent).toHaveBeenCalledTimes(1);
        expect(fakeSession.aborted).toBe(false);
        expect(result.type).toBe("completed");
        expect(result.content).toBe("Spawned one and continuing.");
    });
    it("spawn_workflow runs inline, keeps the turn going and passes the tool call id", async () => {
        const fakeSession = new FakeCopilotSession();
        const yaml = "apiVersion: pilotswarm.dev/v1alpha1\nkind: Workflow\n";
        fakeSession.scriptedToolCalls = [
            { name: "spawn_workflow", id: "call-wf", args: { yaml, inputs: { n: 1 } } },
            { name: "spawn_workflow", id: "call-empty", args: { yaml: "  " } },
            { name: "spawn_workflow", id: "call-list", args: { yaml, inputs: [1] } },
        ];
        fakeSession.assistantContent = "Started the workflow.";
        const results = [];
        fakeSession.on("tool.execution_complete", (event) => results.push(event.data.result));
        const controlToolBridge = {
            spawnAgent: vi.fn(),
            spawnWorkflow: vi.fn(async () => "[SYSTEM: started workflow session wf-1]"),
            messageAgent: vi.fn(),
        };
        const managed = new ManagedSession("inline-spawn-workflow", fakeSession, {});
        const result = await managed.runTurn("run my workflow", { controlToolBridge });

        const live = fakeSession.registeredTools.find((tool) => tool.name === "spawn_workflow");
        const stub = ManagedSession.subAgentToolDefs().find((tool) => tool.name === "spawn_workflow");
        expect(live?.parameters).toEqual(stub?.parameters);
        expect(live?.description).toBe(stub?.description);
        expect(controlToolBridge.spawnWorkflow).toHaveBeenCalledTimes(1);
        expect(controlToolBridge.spawnWorkflow).toHaveBeenCalledWith({ yaml, inputs: { n: 1 } }, { toolCallId: "call-wf" });
        expect(results).toEqual([
            "[SYSTEM: started workflow session wf-1]",
            "Error: yaml is required.",
            "Error: inputs must be a JSON object.",
        ]);
        expect(result.type).toBe("completed");
        expect(result.content).toBe("Started the workflow.");
    });

    it("spawn_workflow without the bridge method refuses instead of hanging", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [{ name: "spawn_workflow", args: { yaml: "kind: Workflow" } }];
        const results = [];
        fakeSession.on("tool.execution_complete", (event) => results.push(event.data.result));
        const managed = new ManagedSession("inline-spawn-workflow-missing", fakeSession, {});
        await managed.runTurn("run it", { controlToolBridge: { spawnAgent: vi.fn(), messageAgent: vi.fn() } });
        expect(results).toEqual(["Error: spawn_workflow is not available in this session."]);
    });

    it("cron then spawn_workflow: the schedule is set and every wake-up can start a run", async () => {
        const yaml = "apiVersion: pilotswarm.dev/v1alpha1\nkind: Workflow\n";
        const controlToolBridge = {
            spawnAgent: vi.fn(),
            messageAgent: vi.fn(),
            spawnWorkflow: vi.fn(async (_args, call) => `[SYSTEM: started workflow session for ${call.toolCallId}]`),
        };

        // The turn that sets it up: start the first run now, then schedule.
        const setupSession = new FakeCopilotSession();
        setupSession.scriptedToolCalls = [
            { name: "spawn_workflow", id: "call-first", args: { yaml } },
            { name: "cron", id: "call-cron", args: { seconds: 3600, reason: "run the nightly workflow" } },
        ];
        setupSession.assistantContent = "Started the first run; it repeats every hour.";
        const setup = await new ManagedSession("cron-workflow", setupSession, {}).runTurn("Every hour, run this workflow", { controlToolBridge });
        // cron does not end the turn: the schedule rides the result as a queued action.
        expect(setup.type).toBe("completed");
        expect(setup.queuedActions).toContainEqual(expect.objectContaining({ type: "cron", action: "set", intervalSeconds: 3600 }));

        // A cron wake-up: the agent starts the next run and ends its turn.
        const wakeSession = new FakeCopilotSession();
        wakeSession.scriptedToolCalls = [{ name: "spawn_workflow", id: "call-wake", args: { yaml } }];
        wakeSession.assistantContent = "Started this hour's run.";
        const wake = await new ManagedSession("cron-workflow", wakeSession, {}).runTurn("[cron wake-up]", { controlToolBridge, cycleOrigin: "cron" });
        expect(wake.type).toBe("completed");
        expect(controlToolBridge.spawnWorkflow.mock.calls.map(([, call]) => call.toolCallId)).toEqual(["call-first", "call-wake"]);
    });

    it("keeps sub-agent stub schemas aligned with live schemas", () => {
        const spawnTool = ManagedSession.subAgentToolDefs().find((tool) => tool.name === "spawn_agent");
        const completeTool = ManagedSession.subAgentToolDefs().find((tool) => tool.name === "complete_agent");
        const cancelTool = ManagedSession.subAgentToolDefs().find((tool) => tool.name === "cancel_agent");

        expect(spawnTool?.parameters?.properties?.title?.type).toBe("string");
        expect(spawnTool?.parameters?.properties?.contract?.type).toBe("object");
        expect(spawnTool?.parameters?.properties?.contract?.description).toContain("no separate contract tool exists");
        expect(completeTool?.parameters?.properties?.result?.type).toBe("object");
        expect(cancelTool?.parameters?.properties?.partial_result?.type).toBe("object");
    });

    it("message_agent deliver and stop_agent_turn: schemas match the stubs, and the tool call id reaches the bridge", async () => {
        const stubs = ManagedSession.subAgentToolDefs();
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "message_agent", id: "call-steer", args: { agent_id: "child", message: "use metric", deliver: "now" } },
            { name: "message_agent", id: "call-bad", args: { agent_id: "child", message: "x", deliver: "later" } },
            { name: "stop_agent_turn", id: "call-stop", args: { agent_id: "child", reason: "wrong file" } },
        ];
        fakeSession.assistantContent = "Controlled.";
        const controlToolBridge = {
            spawnAgent: vi.fn(),
            messageAgent: vi.fn(async () => "[SYSTEM: steered]"),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(),
            listSessions: vi.fn(),
            completeAgent: vi.fn(),
            cancelAgent: vi.fn(),
            stopAgentTurn: vi.fn(async () => "[SYSTEM: stopped]"),
            deleteAgent: vi.fn(),
        };
        const results = [];
        fakeSession.on("tool.execution_complete", (event) => results.push(event.data.result));
        const managed = new ManagedSession("inline-parent-controls", fakeSession, {});
        const result = await managed.runTurn("control the child", { controlToolBridge });

        for (const name of ["message_agent", "stop_agent_turn"]) {
            const live = fakeSession.registeredTools.find((tool) => tool.name === name);
            const stub = stubs.find((tool) => tool.name === name);
            expect(live?.parameters).toEqual(stub?.parameters);
            expect(live?.description.startsWith(stub?.description.split(" Calling")[0])).toBe(true);
        }
        expect(stubs.find((tool) => tool.name === "message_agent").parameters.properties.deliver.enum).toEqual(["next_turn", "now"]);
        expect(controlToolBridge.messageAgent).toHaveBeenCalledTimes(1);
        expect(controlToolBridge.messageAgent).toHaveBeenCalledWith(
            { agent_id: "child", message: "use metric", deliver: "now" }, { toolCallId: "call-steer" });
        expect(controlToolBridge.stopAgentTurn).toHaveBeenCalledWith({ agent_id: "child", reason: "wrong file" }, { toolCallId: "call-stop" });
        expect(results).toEqual(["[SYSTEM: steered]", "Error: deliver must be next_turn or now.", "[SYSTEM: stopped]"]);
        expect(result.type).toBe("completed");
    });

    it("stop_agent_turn without the bridge method refuses instead of hanging", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [{ name: "stop_agent_turn", args: { agent_id: "child" } }];
        const results = [];
        fakeSession.on("tool.execution_complete", (event) => results.push(event.data.result));
        const managed = new ManagedSession("inline-parent-stop-missing", fakeSession, {});
        await managed.runTurn("stop the child", { controlToolBridge: { spawnAgent: vi.fn(), messageAgent: vi.fn() } });
        expect(results).toEqual(["Error: stop_agent_turn is unavailable in this session."]);
    });

    it("advertises cross-session reply requirements", () => {
        const tools = ManagedSession.systemToolDefs();
        const sendTool = tools.find((tool) => tool.name === "send_session_message");
        const replyTool = tools.find((tool) => tool.name === "reply_session_message");

        expect(sendTool?.description).toContain("normal chat transcript is not the response channel");
        expect(replyTool?.description).toContain("Do not only write the answer in your own chat");
    });
    it("declares the regeneration tools so the model actually sees them", () => {
        // Regression guard: runTurn() wires real handlers for regenerate_context
        // and regenerate_agent, but the SCHEMAS the CLI server advertises to the
        // model come only from systemToolDefs() (→ sessionConfig.tools). A tool
        // present only in runTurn is invisible to the LLM — an agent asked to
        // call it truthfully reports "no such tool" (was live in prod pre-f18c851).
        const tools = ManagedSession.systemToolDefs();
        const regenContext = tools.find((tool) => tool.name === "regenerate_context");
        const regenAgent = tools.find((tool) => tool.name === "regenerate_agent");

        expect(regenContext, "regenerate_context must be declared in systemToolDefs").toBeDefined();
        expect(regenContext?.parameters?.required ?? []).toContain("handoff");
        expect(regenAgent, "regenerate_agent must be declared in systemToolDefs").toBeDefined();
        expect(regenAgent?.parameters?.required ?? []).toContain("agent_id");
    });

    it("blocks user tool side effects after a wait boundary", async () => {
        const fakeSession = new FakeCopilotSession();
        const storeFact = vi.fn(async () => "stored");
        fakeSession.scriptedToolCalls = [
            { name: "wait", args: { seconds: 60, reason: "pause before next write" } },
            { name: "store_fact", args: { key: "post-wait", value: "should not write yet" } },
        ];
        fakeSession.assistantContent = "waiting";

        const managed = new ManagedSession("inline-wait-boundary", fakeSession, {
            waitThreshold: 0,
            tools: [{ name: "store_fact", parameters: { type: "object", properties: {} }, handler: storeFact }],
        });
        const result = await managed.runTurn("wait then write");

        expect(result.type).toBe("wait");
        expect(storeFact).not.toHaveBeenCalled();
    });

    it("blocks system side effects after a wait boundary", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "wait", args: { seconds: 60, reason: "pause before summary" } },
            { name: "send_session_message", args: { session_id: "peer", subject: "late", body: "Should not send" } },
        ];
        fakeSession.assistantContent = "waiting";

        const controlToolBridge = {
            sendSessionMessage: vi.fn(async () => "queued"),
        };

        const managed = new ManagedSession("inline-wait-summary-boundary", fakeSession, { waitThreshold: 0 });
        const result = await managed.runTurn("wait then summarize", { controlToolBridge });

        expect(result.type).toBe("wait");
        expect(controlToolBridge.sendSessionMessage).not.toHaveBeenCalled();
    });

    it("advertises and forwards an optional spawn_agent title", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "spawn_agent", args: { task: "say hi", title: "Research Child" } },
        ];
        fakeSession.assistantContent = "Spawned titled child.";

        const controlToolBridge = {
            spawnAgent: vi.fn(async () => "[SYSTEM: spawned]"),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(),
            listSessions: vi.fn(),
            completeAgent: vi.fn(),
            cancelAgent: vi.fn(),
            deleteAgent: vi.fn(),
        };

        const managed = new ManagedSession("inline-spawn-title", fakeSession, {});
        const result = await managed.runTurn("spawn a titled child", { controlToolBridge });

        const spawnTool = fakeSession.registeredTools.find((tool) => tool.name === "spawn_agent");
        expect(spawnTool?.parameters?.properties?.title?.type).toBe("string");
        expect(controlToolBridge.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({
            task: "say hi",
            title: "Research Child",
        }));
        expect(result.type).toBe("completed");
        expect(result.content).toBe("Spawned titled child.");
    });

    it.each(["inline", "fallback"])("does not expose the removed spawn selector in %s mode", async (mode) => {
        const fakeSession = new FakeCopilotSession();
        const spawnAgent = vi.fn();
        const managed = new ManagedSession("removed-selector-schema", fakeSession, {});
        await managed.runTurn("register tools", mode === "inline" ? { controlToolBridge: { spawnAgent } } : {});
        const spawnTool = fakeSession.registeredTools.find((tool) => tool.name === "spawn_agent");
        const staticTool = ManagedSession.subAgentToolDefs().find((tool) => tool.name === "spawn_agent");
        for (const tool of [spawnTool, staticTool]) {
            expect(tool.parameters.properties).not.toHaveProperty("required_tool");
            expect(tool.description).not.toContain("required_tool");
            expect(tool.description).toContain("ps_list_agents");
            expect(tool.description).toContain("static and published");
        }
        expect(spawnAgent).not.toHaveBeenCalled();
    });

    for (const mode of ["inline", "fallback"]) {
        it.each([
            { required_tool: "package_catalog" },
            { agent_name: "catalog-analyst", required_tool: "package_catalog" },
            { task: "Inspect one shard", required_tool: "package_catalog" },
            { task: "Inspect one shard", required_tool: null },
            { task: "Inspect one shard", required_tool: "" },
            { task: "Inspect one shard", requiredTool: "package_catalog" },
        ])(`rejects a stale selector before %s spawning in ${mode} mode`, async (args) => {
            const fakeSession = new FakeCopilotSession();
            fakeSession.scriptedToolCalls = [{ name: "spawn_agent", args }];
            const spawnAgent = vi.fn();
            const managed = new ManagedSession("removed-selector-rejection", fakeSession, {});
            const result = await managed.runTurn("Delegate", mode === "inline" ? { controlToolBridge: { spawnAgent } } : {});
            expect(result.type).toBe("completed");
            expect(result.queuedActions ?? []).toHaveLength(0);
            const completion = result.events.find(event => event.eventType === "tool.execution_complete" && event.data.toolName === "spawn_agent");
            expect(completion.data.result).toContain("required_tool is no longer supported by spawn_agent");
            expect(completion.data.result).toContain("ps_list_agents");
            expect(completion.data.result).toContain("agent_name");
            expect(spawnAgent).not.toHaveBeenCalled();
        });
    }

    it("advertises and forwards child contracts and results", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            {
                name: "spawn_agent",
                args: {
                    task: "collect evidence",
                    contract: {
                        purpose: "Evidence collection",
                        expectedFacts: [{ key: "result/evidence", required: true }],
                    },
                },
            },
            {
                name: "complete_agent",
                args: {
                    agent_id: "session-child",
                    result: {
                        verdict: "success",
                        summary: "Evidence collected.",
                        factsWritten: [{ kind: "fact", key: "result/evidence" }],
                    },
                },
            },
            {
                name: "cancel_agent",
                args: {
                    agent_id: "session-other-child",
                    reason: "stale",
                    partial_result: { verdict: "cancelled", summary: "No longer needed." },
                },
            },
        ];
        fakeSession.assistantContent = "Recorded child outcomes.";

        const controlToolBridge = {
            spawnAgent: vi.fn(async () => "[SYSTEM: spawned]"),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(),
            listSessions: vi.fn(),
            completeAgent: vi.fn(async () => "[SYSTEM: completed]"),
            cancelAgent: vi.fn(async () => "[SYSTEM: cancelled]"),
            deleteAgent: vi.fn(),
            sendSessionMessage: vi.fn(),
            replySessionMessage: vi.fn(),
        };

        const managed = new ManagedSession("inline-contracts", fakeSession, {});
        const result = await managed.runTurn("spawn with contract", { controlToolBridge });

        const spawnTool = fakeSession.registeredTools.find((tool) => tool.name === "spawn_agent");
        const completeTool = fakeSession.registeredTools.find((tool) => tool.name === "complete_agent");
        const cancelTool = fakeSession.registeredTools.find((tool) => tool.name === "cancel_agent");
        expect(spawnTool?.parameters?.properties?.contract?.type).toBe("object");
        expect(completeTool?.parameters?.properties?.result?.type).toBe("object");
        expect(completeTool?.parameters?.properties?.result?.properties?.factsWritten?.type).toBe("array");
        expect(completeTool?.parameters?.properties?.result?.properties?.artifactsWritten?.type).toBe("array");
        expect(cancelTool?.parameters?.properties?.partial_result?.type).toBe("object");
        expect(controlToolBridge.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({
            task: "collect evidence",
            contract: expect.objectContaining({ purpose: "Evidence collection" }),
        }));
        expect(controlToolBridge.completeAgent).toHaveBeenCalledWith(expect.objectContaining({
            agent_id: "session-child",
            result: expect.objectContaining({ verdict: "success" }),
        }));
        expect(controlToolBridge.cancelAgent).toHaveBeenCalledWith(expect.objectContaining({
            agent_id: "session-other-child",
            partial_result: expect.objectContaining({ verdict: "cancelled" }),
        }));
        expect(result.type).toBe("completed");
    });

    it("normalizes canonical and compatibility child output references", () => {
        const factKey = "runbooks/runs/1/result";
        const artifactPath = "reports/run-1.md";
        const contractJson = {
            current: {
                expectedFacts: [{ key: factKey, required: true }],
                expectedArtifacts: [{ path: artifactPath, required: true }],
            },
        };

        expect(collectContractViolations(contractJson, {
            factsWritten: [{ key: factKey }],
            artifactsWritten: [{ path: artifactPath }],
        })).toEqual([]);
        expect(collectContractViolations(contractJson, { outputs: [factKey, artifactPath] })).toEqual([]);
        expect(collectContractViolations(contractJson, {
            evidenceFactKeys: [factKey],
            artifactPointers: [artifactPath],
        })).toEqual([]);

        expect(collectContractViolations(contractJson, { outputs: [] })).toEqual([
            expect.objectContaining({ code: "missing_fact_reference" }),
            expect.objectContaining({ code: "missing_artifact_reference" }),
        ]);
    });

    it("forwards cross-session coordination tools inline", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "send_session_message", args: { session_id: "target", subject: "Status", body: "What is current state?", expects_response: true } },
            { name: "reply_session_message", args: { request_id: "req-1", session_id: "source", body: "Answered." } },
        ];
        fakeSession.assistantContent = "Coordinated.";

        const controlToolBridge = {
            spawnAgent: vi.fn(),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(),
            listSessions: vi.fn(),
            completeAgent: vi.fn(),
            cancelAgent: vi.fn(),
            deleteAgent: vi.fn(),
            sendSessionMessage: vi.fn(async () => "[SYSTEM: message queued]"),
            replySessionMessage: vi.fn(async () => "[SYSTEM: reply queued]"),
        };

        const managed = new ManagedSession("inline-coordination", fakeSession, {});
        const result = await managed.runTurn("coordinate", { controlToolBridge });

        expect(fakeSession.registeredTools.some((tool) => tool.name === "send_session_message")).toBe(true);
        expect(fakeSession.registeredTools.some((tool) => tool.name === "reply_session_message")).toBe(true);
        expect(controlToolBridge.sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({ session_id: "target", expects_response: true }));
        expect(controlToolBridge.replySessionMessage).toHaveBeenCalledWith(expect.objectContaining({ request_id: "req-1" }));
        expect(result.type).toBe("completed");
    });

    it("corrects a tool call emitted as assistant text before accepting completion", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedSends = [
            {
                assistantContent:
                    'court\n<invoke name="send_session_message">\n' +
                    '<parameter name="subject">Recovered Title</parameter>\n' +
                    '</invoke>',
            },
            {
                toolCalls: [{ name: "send_session_message", args: { session_id: "peer", subject: "Recovered Title", body: "recovered" } }],
                assistantContent: "Recovered after real tool call.",
            },
        ];

        const controlToolBridge = {
            sendSessionMessage: vi.fn(async () => "[SYSTEM: message queued]"),
        };
        const forwardedEvents = [];

        const managed = new ManagedSession("inline-text-tool-call-guard", fakeSession, {});
        const result = await managed.runTurn("rename yourself", {
            controlToolBridge,
            onEvent: (event) => forwardedEvents.push(event),
        });

        expect(fakeSession.sentPrompts).toHaveLength(2);
        expect(fakeSession.sentPrompts[1]).toContain("Come to your senses");
        expect(fakeSession.sentPrompts[1]).toContain("send_session_message");
        expect(controlToolBridge.sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({ subject: "Recovered Title" }));
        expect(result.type).toBe("completed");
        expect(result.content).toBe("Recovered after real tool call.");
        expect(result.events.some((event) => event.eventType === "runtime.tool_call_as_text")).toBe(true);
        expect(result.events.find((event) => event.eventType === "runtime.tool_call_as_text")?.data?.rawContent).toContain("<invoke");
        expect(result.events.some((event) => event.eventType === "assistant.message" && String(event.data?.content || "").includes("<invoke"))).toBe(false);
        expect(forwardedEvents.some((event) => event.eventType === "assistant.message" && String(event.data?.content || "").includes("<invoke"))).toBe(false);
    });

    it("allows legitimate fenced examples of invoke syntax", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.assistantContent = [
            "Here is the Anthropic text form as an example:",
            "```xml",
            "<invoke name=\"send_session_message\">",
            "<parameter name=\"subject\">Example</parameter>",
            "</invoke>",
            "```",
        ].join("\n");

        const managed = new ManagedSession("inline-text-tool-call-example", fakeSession, {});
        const result = await managed.runTurn("show an example");

        expect(fakeSession.sentPrompts).toHaveLength(1);
        expect(result.type).toBe("completed");
        expect(result.content).toContain("<invoke name=\"send_session_message\">");
        expect(result.events.some((event) => event.eventType === "runtime.tool_call_as_text")).toBe(false);
    });

    it("returns a corrective error when text tool-call markup appears with a turn boundary", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "wait", args: { seconds: 60, reason: "pause" } },
        ];
        fakeSession.assistantContent = 'court\n<invoke name="send_session_message">\n<parameter name="subject">Dropped Title</parameter>\n</invoke>';

        const managed = new ManagedSession("inline-text-tool-call-boundary", fakeSession, { waitThreshold: 0 });
        const result = await managed.runTurn("wait and rename", {
            controlToolBridge: { sendSessionMessage: vi.fn() },
        });

        expect(fakeSession.sentPrompts).toHaveLength(1);
        expect(result.type).toBe("error");
        expect(result.message).toContain("Come to your senses");
        expect(result.message).toContain("send_session_message");
        expect(result.events.filter((event) => event.eventType === "runtime.tool_call_as_text")).toHaveLength(1);
        expect(result.events.find((event) => event.eventType === "runtime.tool_call_as_text")?.data?.rawContent).toContain("Dropped Title");
        expect(result.events.some((event) => event.eventType === "assistant.message" && String(event.data?.content || "").includes("<invoke"))).toBe(false);
    });

    it("returns a corrective error when tool-call text repeats past the guard limit", async () => {
        const fakeSession = new FakeCopilotSession();
        const malformed = 'court\n<invoke name="send_session_message">\n<parameter name="subject">Lost Title</parameter>\n</invoke>';
        fakeSession.scriptedSends = [
            { assistantContent: malformed },
            { assistantContent: malformed },
            { assistantContent: malformed },
        ];
        const forwardedEvents = [];

        const managed = new ManagedSession("inline-text-tool-call-error", fakeSession, {});
        const result = await managed.runTurn("rename yourself", {
            controlToolBridge: { sendSessionMessage: vi.fn() },
            onEvent: (event) => forwardedEvents.push(event),
        });

        expect(fakeSession.sentPrompts).toHaveLength(3);
        expect(result.type).toBe("error");
        expect(result.message).toContain("Come to your senses");
        expect(result.message).toContain("send_session_message");
        expect(result.events.filter((event) => event.eventType === "runtime.tool_call_as_text")).toHaveLength(3);
        expect(result.events.some((event) => event.eventType === "assistant.message" && String(event.data?.content || "").includes("<invoke"))).toBe(false);
        expect(forwardedEvents.some((event) => event.eventType === "assistant.message" && String(event.data?.content || "").includes("<invoke"))).toBe(false);
    });

    it("returns catalog reasoning strengths and context tiers through list_available_models", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.assistantContent = "checked models";

        const managed = new ManagedSession("inline-list-models", fakeSession, {
            model: "github-copilot:gpt-5.5",
            reasoningEffort: "medium",
        });
        await managed.runTurn("list models", {
            modelSummary: new ModelProviderRegistry({ providers: [{
                id: "github-copilot", type: "github", githubToken: "test-token",
                models: [{ name: "gpt-5.5", supportedReasoningEfforts: ["medium", "xhigh"],
                    defaultReasoningEffort: "medium", supportedContextTiers: ["default", "long_context"],
                    defaultContextTier: "default", contextWindowSizes: { default: 200000, long_context: 936000 } }],
            }] }).getModelSummaryForLLM(),
        });

        const listTool = fakeSession.registeredTools.find((tool) => tool.name === "list_available_models");
        expect(listTool?.description).toContain("supported reasoning efforts");
        const result = await listTool.handler({});
        expect(result).toContain("Current session configured model (this turn):");
        expect(result).toContain("provider: github-copilot");
        expect(result).toContain("model: gpt-5.5");
        expect(result).toContain("qualified_model: github-copilot:gpt-5.5");
        expect(result).toContain("reasoning_effort: medium");
        expect(result).toContain("github-copilot:gpt-5.5");
        expect(result).toContain("reasoning: medium, xhigh; default: medium");
        expect(result).toContain("context: default, long_context; default: default");
        expect(result).toContain("context sizes: default: 200000 tokens, long_context: 936000 tokens");
    });

    it("advertises and forwards an optional spawn_agent reasoning_effort", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "spawn_agent", args: { task: "reason deeply", model: "github-copilot:claude-opus-4.8", reasoning_effort: "max" } },
        ];
        fakeSession.assistantContent = "Spawned reasoning child.";

        const controlToolBridge = {
            spawnAgent: vi.fn(async () => "[SYSTEM: spawned]"),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(),
            listSessions: vi.fn(),
            completeAgent: vi.fn(),
            cancelAgent: vi.fn(),
            deleteAgent: vi.fn(),
        };

        const managed = new ManagedSession("inline-spawn-reasoning", fakeSession, {});
        const result = await managed.runTurn("spawn a high reasoning child", { controlToolBridge });

        const spawnTool = fakeSession.registeredTools.find((tool) => tool.name === "spawn_agent");
        expect(spawnTool?.parameters?.properties?.reasoning_effort?.enum).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
        expect(controlToolBridge.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({
            task: "reason deeply",
            model: "github-copilot:claude-opus-4.8",
            reasoning_effort: "max",
        }));
        expect(result.type).toBe("completed");
        expect(result.content).toBe("Spawned reasoning child.");
    });

    it.each(["default", "long_context"])("forwards explicit child context %s in inline and fallback spawning", async (tier) => {
        for (const inline of [true, false]) {
            const fakeSession = new FakeCopilotSession();
            const args = { task: "Review the proposal", model: "review:model", context_tier: tier };
            fakeSession.scriptedToolCalls = [{ name: "spawn_agent", args }];
            const spawnAgent = vi.fn(async () => "spawned");
            const managed = new ManagedSession("spawn-context", fakeSession, { contextTier: "long_context" });
            const result = await managed.runTurn("review", inline ? { controlToolBridge: { spawnAgent } } : {});
            const schema = fakeSession.registeredTools.find((tool) => tool.name === "spawn_agent").parameters;
            expect(schema.properties.context_tier.enum).toEqual(["default", "long_context"]);
            expect(ManagedSession.subAgentToolDefs().find((tool) => tool.name === "spawn_agent")
                .parameters.properties.context_tier).toEqual(schema.properties.context_tier);
            if (inline) expect(spawnAgent).toHaveBeenCalledWith(args);
            else expect(result).toMatchObject({ type: "spawn_agent", contextTier: tier });
        }
    });

    it("rejects invalid spawn context before invoking the bridge", async () => {
        const fakeSession = new FakeCopilotSession();
        const spawnAgent = vi.fn();
        const managed = new ManagedSession("invalid-context", fakeSession, {});
        await managed.runTurn("register tools", { controlToolBridge: { spawnAgent } });
        const tool = fakeSession.registeredTools.find((entry) => entry.name === "spawn_agent");
        expect(await tool.handler({ task: "review", context_tier: "huge" })).toContain("context_tier must be one of");
        expect(spawnAgent).not.toHaveBeenCalled();
    });

    it("leaves the legacy fallback action unchanged when context is omitted", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [{ name: "spawn_agent", args: { task: "review" } }];
        const managed = new ManagedSession("inherited-context", fakeSession, { contextTier: "long_context" });
        const result = await managed.runTurn("review");
        expect(result.type).toBe("spawn_agent");
        expect(result).not.toHaveProperty("contextTier");
    });

    it("still suspends the turn for wait_for_agents", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "wait_for_agents", args: {} },
        ];

        const controlToolBridge = {
            spawnAgent: vi.fn(),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(async () => []),
            listSessions: vi.fn(),
            completeAgent: vi.fn(),
            cancelAgent: vi.fn(),
            deleteAgent: vi.fn(),
        };

        const managed = new ManagedSession("wait-for-agents", fakeSession, {});
        const result = await managed.runTurn("wait on children", { controlToolBridge });

        expect(result.type).toBe("wait_for_agents");
        expect(controlToolBridge.resolveWaitForAgents).toHaveBeenCalledTimes(1);
        expect(fakeSession.aborted).toBe(false);
    });

    it("does not abort the session for long wait() but blocks later tool side effects", async () => {
        const fakeSession = new FakeCopilotSession();
        const regularToolHandler = vi.fn(async () => "ok");
        fakeSession.scriptedToolCalls = [
            { name: "wait", args: { seconds: 120, reason: "pause work" } },
            { name: "regular_tool", args: { value: 1 } },
        ];

        const managed = new ManagedSession("inline-wait", fakeSession, {
            tools: [{
                name: "regular_tool",
                description: "test tool",
                parameters: { type: "object", properties: {} },
                handler: regularToolHandler,
            }],
        });

        const result = await managed.runTurn("pause and keep transcript valid");

        expect(result.type).toBe("wait");
        expect(regularToolHandler).not.toHaveBeenCalled();
        expect(fakeSession.aborted).toBe(false);
    });

    it("does not abort the session for ask_user() but blocks later tool side effects", async () => {
        const fakeSession = new FakeCopilotSession();
        const regularToolHandler = vi.fn(async () => "ok");
        fakeSession.scriptedToolCalls = [
            { name: "ask_user", args: { question: "Need approval?" } },
            { name: "regular_tool", args: { value: 1 } },
        ];

        const managed = new ManagedSession("inline-ask-user", fakeSession, {
            tools: [{
                name: "regular_tool",
                description: "test tool",
                parameters: { type: "object", properties: {} },
                handler: regularToolHandler,
            }],
        });

        const result = await managed.runTurn("ask the user and keep transcript valid");

        expect(result.type).toBe("input_required");
        expect(regularToolHandler).not.toHaveBeenCalled();
        expect(fakeSession.aborted).toBe(false);
    });

    it("intercepts every framework tool of a session under a real-agent workflow test, but complete_workflow_node and ask_user", async () => {
        // Workflow v2 real-agent test runs (design 05 agent mode real; INACTIVE): the bridge's workflowTestToolCall answers the calls.
        const fakeSession = new FakeCopilotSession();
        const regularToolHandler = vi.fn(async () => "live result");
        const calls = [];
        const workflowTestToolCall = vi.fn(async (tool, args) => {
            calls.push([tool, args]);
            if (tool === "read_logs") throw new Error("not_found: no logs");
            return tool === "wait" ? "waited" : { state: "green" };
        });
        const completeWorkflowNode = vi.fn(async () => JSON.stringify({ ok: true }));
        const spawnAgent = vi.fn(async () => "spawned");
        fakeSession.scriptedToolCalls = [
            { name: "regular_tool", args: { buildId: 1 } },
            { name: "wait", args: { seconds: 60, reason: "cool off" } },
            { name: "spawn_agent", args: { task: "help me" } },
            { name: "read_logs", args: { buildId: 1 } },
            { name: "ask_user", args: { question: "May I?" } },
            { name: "complete_workflow_node", args: { outcome: "accepted", output: { verdict: "ok" }, operation_id: "op-1" } },
        ];
        const tool = name => ({ name, description: "test tool", parameters: { type: "object", properties: {} }, handler: regularToolHandler });
        const managed = new ManagedSession("workflow-test-agent", fakeSession, { tools: [tool("regular_tool"), tool("read_logs")] });
        expect(managed.workflowTestSessionActive()).toBe(false);

        const result = await managed.runTurn("run the state", {
            controlToolBridge: { workflowTestToolCall, workflowAgentSubtree: true, completeWorkflowNode, spawnAgent },
        });

        // No framework tool ran, and no call ended the turn (a wait is answered, not waited); the state's own completion and
        // ask_user's refusal are as in a live run.
        expect(result.type).toBe("completed");
        expect(regularToolHandler).not.toHaveBeenCalled();
        expect(spawnAgent).not.toHaveBeenCalled();
        expect(calls).toEqual([
            ["regular_tool", { buildId: 1 }], ["wait", { seconds: 60, reason: "cool off" }], ["spawn_agent", { task: "help me" }], ["read_logs", { buildId: 1 }],
        ]);
        expect(completeWorkflowNode).toHaveBeenCalledTimes(1);
        const handlerResult = name => fakeSession.registeredTools.find(candidate => candidate.name === name);
        expect(await handlerResult("regular_tool").handler({ buildId: 1 }, { toolCallId: "again" })).toBe(JSON.stringify({ state: "green" }));
        expect(await handlerResult("wait").handler({ seconds: 1 }, { toolCallId: "again" })).toBe("waited");
        expect(await handlerResult("read_logs").handler({ buildId: 1 }, { toolCallId: "again" }))
            .toMatchObject({ resultType: "failure", textResultForLlm: "Tool failed: not_found: no logs" });
        expect(await handlerResult("ask_user").handler({ question: "May I?" }, { toolCallId: "again" })).toBe(WORKFLOW_ASK_USER_REFUSAL);
        // From then on the session refuses MCP tools (its permission handler reads this).
        expect(managed.workflowTestSessionActive()).toBe(true);

        // A turn without the test's bridge runs its tools.
        const plain = new FakeCopilotSession();
        plain.scriptedToolCalls = [{ name: "regular_tool", args: { buildId: 2 } }];
        const live = new ManagedSession("workflow-live-agent", plain, { tools: [tool("regular_tool")] });
        expect((await live.runTurn("run the state", { controlToolBridge: { workflowAgentSubtree: true } })).type).toBe("completed");
        expect(regularToolHandler).toHaveBeenCalledTimes(1);
        expect(live.workflowTestSessionActive()).toBe(false);
    });

    it("converts thrown user tool errors into failure tool results instead of surfacing SDK tool errors", async () => {
        const fakeSession = new FakeCopilotSession();
        const failingToolHandler = vi.fn(async () => {
            throw new Error("HTTP 404");
        });
        fakeSession.scriptedToolCalls = [
            { name: "regular_tool", args: { value: 1 } },
        ];
        fakeSession.assistantContent = "Handled the tool failure.";

        const managed = new ManagedSession("inline-tool-failure", fakeSession, {
            tools: [{
                name: "regular_tool",
                description: "test tool",
                parameters: { type: "object", properties: {} },
                handler: failingToolHandler,
            }],
        });

        const result = await managed.runTurn("run a tool that fails");

        expect(failingToolHandler).toHaveBeenCalledTimes(1);
        expect(result.type).toBe("completed");
        expect(result.content).toBe("Handled the tool failure.");
        expect(fakeSession.aborted).toBe(false);
    });

    it("suppresses the benign post-completion null-length query error when the assistant already replied", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.assistantContent = "Hello! I'm here and ready to help.";
        fakeSession.scriptedEvents = [{
            type: "session.error",
            data: {
                message: "Cannot read properties of null (reading 'length')",
                errorType: "query",
            },
        }];
        const onEvent = vi.fn();

        const managed = new ManagedSession("benign-query-error", fakeSession, {});
        const result = await managed.runTurn("say hello", { onEvent });

        expect(result.type).toBe("completed");
        expect(result.content).toBe("Hello! I'm here and ready to help.");
        expect(result.events?.some((event) => event.eventType === "session.error")).toBe(false);
        expect(onEvent.mock.calls.some(([event]) => event?.eventType === "session.error")).toBe(false);
    });

    it("still surfaces the null-length query error when the turn produced no assistant message", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.assistantContent = null;
        fakeSession.scriptedEvents = [{
            type: "session.error",
            data: {
                message: "Cannot read properties of null (reading 'length')",
                errorType: "query",
            },
        }];
        const onEvent = vi.fn();

        const managed = new ManagedSession("fatal-query-error", fakeSession, {});
        const result = await managed.runTurn("say hello", { onEvent });

        expect(result.type).toBe("error");
        expect(result.message).toContain("Cannot read properties of null");
        expect(onEvent.mock.calls.some(([event]) => event?.eventType === "session.error")).toBe(true);
    });

    it.each([
        "Please produce the requested report.",
        "Internal orchestration wake-up. A child has a new result requiring action.",
    ])("still reports a real empty-response query error: %s", async prompt => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.assistantContent = null;
        fakeSession.scriptedEvents = [{
            type: "session.error",
            data: { message: "No response was returned. Send your message again to retry.", errorType: "query" },
        }];
        const managed = new ManagedSession("empty-query-error", fakeSession, {});
        const result = await managed.runTurn(prompt);
        expect(result.type).toBe("error");
        expect(result.message).toContain("No response was returned");
        expect(result.events.some(event => event.eventType === "session.error")).toBe(true);
    });

    // F-C3: the runTurn activity sets quietEmptyAnswer only on a root session's system-only turn (a child digest, a wake;
    // isQuietSystemOnlyTurn, test/local/empty-system-turn.test.js). Without it, the cases above stay errors.
    describe("F-C3: a root session's system-only turn that the model answers with nothing (quietEmptyAnswer)", () => {
        const EMPTY = { message: "No response was returned. Send your message again to retry.", errorType: "query" };
        const quietTurn = async (fakeSession, config = {}) => {
            const onEvent = vi.fn();
            const trace = vi.fn();
            const managed = new ManagedSession("quiet-system-turn", fakeSession, config);
            const result = await managed.runTurn(SYSTEM_ONLY_TURN_PROMPT, { onEvent, trace, bootstrap: true, quietEmptyAnswer: true });
            const recorded = onEvent.mock.calls.map(([event]) => event?.eventType);
            return { result, recorded, trace };
        };

        it("is a completed turn with no content: no error, no chat warning, one activity line and a trace", async () => {
            const fakeSession = new FakeCopilotSession();
            fakeSession.assistantContent = null;
            fakeSession.scriptedEvents = [{ type: "session.error", data: EMPTY }];
            const { result, recorded, trace } = await quietTurn(fakeSession);
            expect(result).toMatchObject({ type: "completed", content: "" });
            expect(result.events.some(event => event.eventType === "session.error")).toBe(false);
            expect(recorded).not.toContain("session.error");
            expect(recorded).toContain("session.empty_answer");
            expect(result.events.find(event => event.eventType === "session.empty_answer").data)
                .toMatchObject({ cliMessage: EMPTY.message, text: expect.stringContaining("ended without an answer") });
            expect(trace.mock.calls.some(([line]) => /answered a system-only turn with nothing/.test(line))).toBe(true);
        });

        it("any other error of the same turn is still an error, recorded as before", async () => {
            const fakeSession = new FakeCopilotSession();
            fakeSession.assistantContent = null;
            fakeSession.scriptedEvents = [{ type: "session.error", data: { message: "Rate limit exceeded. Try again later.", errorType: "query" } }];
            const { result, recorded } = await quietTurn(fakeSession);
            expect(result.type).toBe("error");
            expect(result.message).toContain("Rate limit exceeded");
            expect(recorded).toContain("session.error");
            expect(recorded).not.toContain("session.empty_answer");
        });

        it("a turn that made a tool call before the empty answer is still an error, its error recorded", async () => {
            const handler = vi.fn(async () => "done");
            const fakeSession = new FakeCopilotSession();
            fakeSession.scriptedToolCalls = [{ name: "regular_tool", args: { value: 1 } }];
            fakeSession.assistantContent = null;
            fakeSession.scriptedEvents = [{ type: "session.error", data: EMPTY }];
            const { result, recorded } = await quietTurn(fakeSession, {
                tools: [{ name: "regular_tool", description: "test tool", parameters: { type: "object", properties: {} }, handler }],
            });
            expect(handler).toHaveBeenCalledTimes(1);
            expect(result.type).toBe("error");
            expect(result.message).toContain("No response was returned");
            expect(result.events.some(event => event.eventType === "session.error")).toBe(true);
            expect(recorded).toContain("session.error");
            expect(recorded).not.toContain("session.empty_answer");
        });

        // Review Q1 of the owner batch: text that was streamed and then cut off by the empty-answer error is not an empty answer.
        it("streamed answer text with no final message, then the empty-answer error, is an error as before", async () => {
            const fakeSession = new FakeCopilotSession();
            fakeSession.scriptedSends = [{ assistantDeltas: ["The child finished: "], assistantContent: null,
                events: [{ type: "session.error", data: EMPTY }] }];
            const { result, recorded } = await quietTurn(fakeSession);
            expect(result.type).toBe("error");
            expect(result.message).toContain("No response was returned");
            expect(result.events.some(event => event.eventType === "session.error")).toBe(true);
            expect(recorded).toContain("session.error");
            expect(recorded).not.toContain("session.empty_answer");
        });

        it("an empty streamed delta is not answer text: the turn is still quiet", async () => {
            const fakeSession = new FakeCopilotSession();
            fakeSession.scriptedSends = [{ assistantDeltas: [""], assistantContent: null, events: [{ type: "session.error", data: EMPTY }] }];
            const { result, recorded } = await quietTurn(fakeSession);
            expect(result).toMatchObject({ type: "completed", content: "" });
            expect(recorded).not.toContain("session.error");
        });

        it("an answer with content keeps its content; the error is recorded as before", async () => {
            const fakeSession = new FakeCopilotSession();
            fakeSession.assistantContent = "Noted.";
            fakeSession.scriptedEvents = [{ type: "session.error", data: EMPTY }];
            const { result, recorded } = await quietTurn(fakeSession);
            expect(result).toMatchObject({ type: "completed", content: "Noted." });
            expect(recorded).toContain("session.error");
            expect(recorded).not.toContain("session.empty_answer");
        });
    });

    it("does not capture empty assistant messages at wait_for_agents boundaries", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "wait_for_agents", args: { agent_ids: ["session-child"] } },
        ];
        fakeSession.assistantContent = "";
        const onEvent = vi.fn();

        const managed = new ManagedSession("blank-assistant-wait", fakeSession, {});
        const result = await managed.runTurn("wait for the child", { onEvent });

        expect(result.type).toBe("wait_for_agents");
        expect(result.events?.some((event) => event.eventType === "assistant.message")).toBe(false);
        expect(onEvent.mock.calls.some(([event]) => event?.eventType === "assistant.message")).toBe(false);
    });

    it("sanitizes replayed null assistant content before sending the next turn", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession._chatMessages = [
            { role: "user", content: "spawn children" },
            { role: "assistant", content: null },
            { role: "assistant", content: "   " },
            { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "wait_for_agents", arguments: "{}" } }] },
            { role: "user", content: null },
        ];
        fakeSession._systemContextMessages = [
            { role: "assistant", content: null },
            { role: "system", content: null },
        ];

        const managed = new ManagedSession("sanitize-replay-history", fakeSession, {});
        const result = await managed.runTurn("resume after child completion");

        expect(result.type).toBe("completed");
        expect(fakeSession._chatMessages).toEqual([
            { role: "user", content: "spawn children" },
            { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "wait_for_agents", arguments: "{}" } }] },
            { role: "user", content: "" },
        ]);
        expect(fakeSession._systemContextMessages).toEqual([
            { role: "system", content: "" },
        ]);
    });

    it("strips null response-only fields that strict OpenAI-compatible providers reject", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession._chatMessages = [
            { role: "user", content: "hi" },
            // What OpenAI and Azure emit and accept back, but which Fireworks
            // rejects with "Extra inputs are not permitted, field:
            // 'messages[N].refusal', value: None".
            { role: "assistant", content: "hello", refusal: null, annotations: null },
            // A real value must survive — only nulls are safe to drop.
            { role: "assistant", content: "nope", refusal: "I cannot help with that" },
            { role: "user", content: "bye" },
        ];

        const managed = new ManagedSession("strip-null-response-fields", fakeSession, {});
        const result = await managed.runTurn("continue");

        expect(result.type).toBe("completed");
        expect(fakeSession._chatMessages).toEqual([
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
            { role: "assistant", content: "nope", refusal: "I cannot help with that" },
            { role: "user", content: "bye" },
        ]);
    });
});

// Owner decision Q2 (workflow/v2/agent-reminder.ts): a workflow agent state's own child whose turn would end with nothing
// pending is reminded once, inside the turn, through runCorrection, after the activity's gate (TurnOptions.stepReminder)
// checked the step and recorded the reminder.
describe("Q2: the step reminder inside an agent state's child turn", () => {
    const TEXT = workflowAgentReminderText("review");
    const COMPLETE = { name: "complete_workflow_node", args: { outcome: "accepted", output: { verdict: "ok" }, operation_id: "op-1" } };
    const REMIND = { remind: true, n: 1, max: 3, stateId: "review" };

    /**
     * A step child's turn on the fake CLI: the model's sends, the gate's answer (an answer, an error it throws, or a function
     * of the check's input and the session that returns the answer), the session config.
     */
    function stepChild(sends, { gate = REMIND, config = { workflowAgentChild: true }, tools = [] } = {}) {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedSends = sends;
        const checks = [];
        let managed = null;
        const stepReminder = { check: vi.fn(async input => {
            checks.push(input);
            if (gate instanceof Error) throw gate;
            return typeof gate === "function" ? await gate(input, managed) : gate;
        }) };
        const completeWorkflowNode = vi.fn(async () => JSON.stringify({ ok: true }));
        const sendSessionMessage = vi.fn(async () => "sent");
        managed = new ManagedSession("step-child", fakeSession, { ...config, tools });
        const events = [];
        const traces = [];
        const run = (opts = {}) => managed.runTurn("Review the change.", {
            stepReminder, onEvent: event => events.push(event), trace: line => traces.push(line),
            controlToolBridge: { completeWorkflowNode, sendSessionMessage, resolveWaitForAgents: async ids => ids },
            ...opts,
        });
        return { fakeSession, managed, checks, completeWorkflowNode, sendSessionMessage, events, traces, run };
    }
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    /** A gate that answers `answer` after `ms`. */
    const slowGate = (ms, answer) => async () => { await pause(ms); return answer; };
    const INVOKE_AS_TEXT = '<invoke name="complete_workflow_node">\n<parameter name="outcome">accepted</parameter>\n</invoke>';
    const reminded = result => (result.events ?? []).filter(event => event.eventType === "runtime.workflow_step_reminded");

    it("reads what is pending: a question in the turn's calls or its answer, the turn's schedule actions, the published schedule", () => {
        const call = (eventType, args) => ({ eventType, data: { toolName: "send_session_message", arguments: args } });
        expect(turnAskedForAnswer([call("tool.execution_start", { session_id: "p", subject: "q", body: "b", expects_response: true })])).toBe(true);
        expect(turnAskedForAnswer([call("tool.execution_complete", { session_id: "p", subject: "q", body: "b" })])).toBe(false);
        expect(turnAskedForAnswer(undefined)).toBe(false);
        expect(answerAsksParent("  question for parent: which base?")).toBe(true);
        expect(answerAsksParent("It seems fine. QUESTION FOR PARENT: none")).toBe(false);
        expect(answerAsksParent(undefined)).toBe(false);
        const set = { type: "cron", action: "set", intervalSeconds: 60, reason: "check" };
        const cancelAt = [{ type: "cron_at", action: "cancel" }, { type: "cron", action: "cancel" }];
        expect(turnScheduleEffect(undefined)).toBeNull();
        expect(turnScheduleEffect([{ type: "set_workspace_extra", extra: {} }])).toBeNull();
        expect(turnScheduleEffect([set, ...cancelAt])).toBe("cancel");
        expect(turnScheduleEffect([...cancelAt, { type: "cron_at", action: "set", schedule: {} }])).toBe("set");
        expect(publishedScheduleActive({ status: "Running", customStatus: JSON.stringify({ status: "running", cronActive: true }) })).toBe(true);
        expect(publishedScheduleActive({ status: "Running", customStatus: { cronActive: true } })).toBe(true);
        expect(publishedScheduleActive({ status: "Running", customStatus: JSON.stringify({ status: "running", cronActive: false }) })).toBe(false);
        expect(publishedScheduleActive({ status: "Running", customStatus: "not json" })).toBe(false);
        expect(publishedScheduleActive(null)).toBe(false);
    });

    it("a prose end gets exactly one reminder in the same turn, with the soft text and a runtime event; the turn completes", async () => {
        expect(TEXT).toBe("Reminder from the workflow: step 'review' is still open. If you have finished, call complete_workflow_node now "
            + "with your outcome and output. If you are still working, continue.");
        const h = stepChild([{ assistantContent: "I looked at it; it seems fine." }, { toolCalls: [COMPLETE], assistantContent: "STATE_COMPLETED" }]);
        const result = await h.run();
        expect(result).toMatchObject({ type: "completed", content: "STATE_COMPLETED" });
        expect(h.fakeSession.sentPrompts).toEqual(["Review the change.", TEXT]);
        expect(h.checks).toEqual([{ scheduleCancelled: false }]);
        expect(h.completeWorkflowNode).toHaveBeenCalledTimes(1);
        const event = { eventType: "runtime.workflow_step_reminded", data: { stateId: "review", n: 1, max: 3, sessionId: "step-child" } };
        expect(reminded(result)).toEqual([event]);
        expect(h.events.filter(item => item.eventType === "runtime.workflow_step_reminded")).toEqual([event]);
    });

    it("a model that still answers in prose after the reminder gets no second one this turn; the turn completes", async () => {
        const h = stepChild([{ assistantContent: "It seems fine." }, { assistantContent: "Still fine, I think." }]);
        const result = await h.run();
        expect(result).toMatchObject({ type: "completed", content: "Still fine, I think." });
        expect(h.fakeSession.sentPrompts).toEqual(["Review the change.", TEXT]);
        expect(h.checks).toHaveLength(1);
        expect(reminded(result)).toHaveLength(1);
    });

    it("a turn that called complete_workflow_node gets none, and the gate is not asked", async () => {
        const h = stepChild([{ toolCalls: [COMPLETE], assistantContent: "Done." }]);
        const result = await h.run();
        expect(result).toMatchObject({ type: "completed", content: "Done." });
        expect(h.fakeSession.sentPrompts).toEqual(["Review the change."]);
        expect(h.checks).toEqual([]);
        expect(reminded(result)).toEqual([]);
    });

    it.each([
        // Longer than the session's wait threshold (30 s), which ManagedSession waits out inside the turn.
        ["wait", { name: "wait", args: { seconds: 120, reason: "build running" } }, "wait"],
        ["ask_user", { name: "ask_user", args: { question: "May I merge?" } }, "input_required"],
        ["wait_for_agents", { name: "wait_for_agents", args: { agent_ids: ["helper-1"] } }, "wait_for_agents"],
        ["cron", { name: "cron", args: { seconds: 60, reason: "check the build" } }, "completed"],
        ["cron_at", { name: "cron_at", args: { minute: 0, hour: 9, tz: "UTC", reason: "check every morning" } }, "completed"],
    ])("a turn that ends on %s, or queues a schedule, gets none", async (_label, call, type) => {
        const h = stepChild([{ toolCalls: [call], assistantContent: "Waiting for it." }]);
        const result = await h.run();
        expect(result.type).toBe(type);
        expect(h.fakeSession.sentPrompts).toEqual(["Review the change."]);
        expect(h.checks).toEqual([]);
        expect(reminded(result)).toEqual([]);
    });

    it("a turn that cancels its schedule tells the gate, which decides on the session's status without it", async () => {
        const h = stepChild([{ toolCalls: [{ name: "cron", args: { action: "cancel" } }], assistantContent: "No more checks." },
            { assistantContent: "Still thinking." }]);
        const result = await h.run();
        expect(h.checks).toEqual([{ scheduleCancelled: true }]);
        expect(reminded(result)).toHaveLength(1);
    });

    it("a1: a turn that called send_session_message with expects_response=true gets none; a one-way message does not count", async () => {
        const ask = { name: "send_session_message", args: { session_id: "parent-1", subject: "Which base?", body: "main or dev?", expects_response: true } };
        const asked = stepChild([{ toolCalls: [ask], assistantContent: "I asked my parent." }]);
        const result = await asked.run();
        expect(result.type).toBe("completed");
        expect(asked.sendSessionMessage).toHaveBeenCalledTimes(1);
        expect(asked.checks).toEqual([]);
        expect(asked.fakeSession.sentPrompts).toEqual(["Review the change."]);
        const told = stepChild([{ toolCalls: [{ name: "send_session_message", args: { session_id: "parent-1", subject: "FYI", body: "started" } }],
            assistantContent: "I told my parent." }, { assistantContent: "Still working." }]);
        expect(reminded(await told.run())).toHaveLength(1);
    });

    it("an answer that asks the parent a question (QUESTION FOR PARENT:) gets none", async () => {
        const h = stepChild([{ assistantContent: "QUESTION FOR PARENT: which base should I use?" }]);
        const result = await h.run();
        expect(result).toMatchObject({ type: "completed", content: "QUESTION FOR PARENT: which base should I use?" });
        expect(h.checks).toEqual([]);
        expect(h.fakeSession.sentPrompts).toHaveLength(1);
    });

    it("a gate that refuses (step closed, deadline passed, sub-agents at work, reminders spent, a schedule) or fails sends nothing; the turn completes", async () => {
        for (const reason of ["decided", "expired", "sub_agents", "spent", "schedule"]) {
            const h = stepChild([{ assistantContent: "It seems fine." }], { gate: { remind: false, reason } });
            const result = await h.run();
            expect(result, reason).toMatchObject({ type: "completed", content: "It seems fine." });
            expect(h.checks, reason).toHaveLength(1);
            expect(h.fakeSession.sentPrompts, reason).toEqual(["Review the change."]);
            expect(reminded(result), reason).toEqual([]);
            expect(h.traces.join("\n"), reason).toContain(`no step reminder: ${reason}`);
        }
        const failing = stepChild([{ assistantContent: "It seems fine." }], { gate: new Error("store unavailable") });
        const result = await failing.run();
        expect(result).toMatchObject({ type: "completed", content: "It seems fine." });
        expect(failing.fakeSession.sentPrompts).toEqual(["Review the change."]);
        expect(failing.traces.join("\n")).toContain("store unavailable");
    });

    it("a session that is not an agent state's own child, or a turn without the gate, gets none", async () => {
        const other = stepChild([{ assistantContent: "It seems fine." }], { config: {} });
        expect(reminded(await other.run())).toEqual([]);
        expect(other.checks).toEqual([]);
        expect(other.fakeSession.sentPrompts).toHaveLength(1);
        const ungated = stepChild([{ assistantContent: "It seems fine." }]);
        expect(reminded(await ungated.run({ stepReminder: undefined }))).toEqual([]);
        expect(ungated.fakeSession.sentPrompts).toHaveLength(1);
    });

    // Review D1: every 1.0.83 workflow turn runs with a turn-control binding, and the run's session.idle closes its send
    // gate; the reminder's correction opens it again, as the other corrections do.
    it("D1: with the turn's real turn-control binding, a prose end is still reminded", async () => {
        const h = stepChild([{ assistantContent: "It seems fine." }, { toolCalls: [COMPLETE], assistantContent: "STATE_COMPLETED" }]);
        const live = new LiveTurnControl({ sessionId: "step-child", turn: 0, start: 0,
            abort: async reason => { h.managed.requestStop(reason); h.managed.abort(); } });
        const result = await h.run({ turnIndex: 0, turnControl: live });
        expect(result).toMatchObject({ type: "completed", content: "STATE_COMPLETED" });
        expect(h.fakeSession.sentPrompts).toEqual(["Review the change.", TEXT]);
        expect(h.checks).toEqual([{ scheduleCancelled: false }]);
        expect(reminded(result)).toHaveLength(1);
        expect(h.completeWorkflowNode).toHaveBeenCalledTimes(1);
    });

    it("a steer held after the run settled, or a held Stop, is pending: no reminder", async () => {
        // A binding whose controls arrive once the first prompt was sent (after it, the run settles with the gate closed).
        const binding = (fakeSession, held) => ({
            attach() {}, gateOpened() {}, detach() {},
            heldStop: () => (fakeSession.sentPrompts.length > 0 ? held.stop ?? null : null),
            hasHeldControls: () => fakeSession.sentPrompts.length > 0 && held.controls === true,
        });
        const steered = stepChild([{ assistantContent: "It seems fine." }, { assistantContent: "never sent" }]);
        const result = await steered.run({ turnControl: binding(steered.fakeSession, { controls: true }) });
        expect(result).toMatchObject({ type: "completed", content: "It seems fine." });
        expect(steered.checks).toEqual([]);
        expect(steered.fakeSession.sentPrompts).toEqual(["Review the change."]);
        const stopped = stepChild([{ assistantContent: "It seems fine." }, { assistantContent: "never sent" }]);
        await stopped.run({ turnControl: binding(stopped.fakeSession, { stop: "Stopped by user" }) });
        expect(stopped.checks).toEqual([]);
        expect(stopped.fakeSession.sentPrompts).toEqual(["Review the change."]);
    });

    // Review D2: the gate is raced with the turn's guards and its Stop; its late answer is ignored, and nothing is sent.
    it.each([["remind", REMIND], ["refuse", { remind: false, reason: "decided" }]])(
        "D2: a gate still deciding when the turn times out (%s, late) ends the turn timed out at once, and nothing is sent", async (_label, answer) => {
            const h = stepChild([{ assistantContent: "It seems fine." }, { assistantContent: "never sent" }],
                { gate: slowGate(800, answer), config: { workflowAgentChild: true, turnTimeoutMs: 200 } });
            const startedAt = Date.now();
            const result = await h.run();
            expect(Date.now() - startedAt).toBeLessThan(700);
            expect(result).toMatchObject({ type: "error", message: "Copilot was taking too long to process and was killed." });
            await pause(900);
            expect(h.fakeSession.sentPrompts).toEqual(["Review the change."]);
            expect(h.events.filter(event => event.eventType === "runtime.workflow_step_reminded")).toEqual([]);
        });

    it.each([["remind", REMIND], ["refuse", { remind: false, reason: "decided" }]])(
        "D2: a gate still deciding when the inactivity watchdog fires (%s, late) ends the turn as lost, and nothing is sent", async (_label, answer) => {
            const h = stepChild([{ assistantContent: "It seems fine." }, { assistantContent: "never sent" }],
                { gate: slowGate(900, answer), config: { workflowAgentChild: true, turnTimeoutMs: 0, turnInactivityTimeoutMs: 200 } });
            const startedAt = Date.now();
            const result = await h.run();
            expect(Date.now() - startedAt).toBeLessThan(800);
            expect(result.type).toBe("error");
            expect(result.message).toContain(TURN_INACTIVITY_ERROR_MARKER);
            await pause(1_000);
            expect(h.fakeSession.sentPrompts).toEqual(["Review the change."]);
            expect(h.events.filter(event => event.eventType === "runtime.workflow_step_reminded")).toEqual([]);
        });

    it.each([["remind", REMIND], ["refuse", { remind: false, reason: "decided" }]])(
        "D2: a Stop while the gate is still deciding (%s, late) ends the turn stopped at once, and nothing is sent", async (_label, answer) => {
            const h = stepChild([{ assistantContent: "It seems fine." }, { assistantContent: "never sent" }], { gate: slowGate(800, answer) });
            const startedAt = Date.now();
            const turn = h.run();
            await pause(100);
            h.managed.requestStop("Stopped by user");
            const result = await turn;
            expect(Date.now() - startedAt).toBeLessThan(700);
            expect(result).toMatchObject({ type: "stopped", reason: "Stopped by user" });
            await pause(900);
            expect(h.fakeSession.sentPrompts).toEqual(["Review the change."]);
            expect(h.events.filter(event => event.eventType === "runtime.workflow_step_reminded")).toEqual([]);
        });

    it("a Stop that arrives as the gate answers yes sends nothing and records no reminder event in the turn", async () => {
        const h = stepChild([{ assistantContent: "It seems fine." }, { assistantContent: "never sent" }],
            { gate: async (_input, managed) => { managed.requestStop("Stopped by user"); return REMIND; } });
        const result = await h.run();
        expect(result).toMatchObject({ type: "stopped", reason: "Stopped by user" });
        expect(h.checks).toHaveLength(1);
        expect(h.fakeSession.sentPrompts).toEqual(["Review the change."]);
        expect(h.events.filter(event => event.eventType === "runtime.workflow_step_reminded")).toEqual([]);
    });

    // Review E1: a Steer that turn control accepts while the gate is asked is pending work: the reminder is not sent, and
    // the Steer stays held for the turn's normal end (turn end labels it).
    it("E1: a Steer accepted while the gate decides goes first: the gate's yes sends nothing, and the Steer stays held", async () => {
        let live = null;
        const h = stepChild([{ assistantContent: "It seems fine." }, { assistantContent: "never sent" }], {
            gate: async () => {
                live.enqueue([{ seq: 1, kind: "steer", text: "Also check the tests.", createdAt: new Date().toISOString() }]);
                await pause(50);
                return REMIND;
            },
        });
        live = new LiveTurnControl({ sessionId: "step-child", turn: 0, start: 0,
            abort: async reason => { h.managed.requestStop(reason); h.managed.abort(); } });
        const result = await h.run({ turnIndex: 0, turnControl: live });
        expect(result).toMatchObject({ type: "completed", content: "It seems fine." });
        expect(h.checks).toHaveLength(1);
        // Neither the reminder nor the Steer was sent in this turn; the Steer waits for the turn's end.
        expect(h.fakeSession.sentPrompts).toEqual(["Review the change."]);
        expect(h.events.filter(event => event.eventType === "runtime.workflow_step_reminded")).toEqual([]);
        expect(reminded(result)).toEqual([]);
        expect(live.hasHeldControls()).toBe(true);
        expect(h.traces.join("\n")).toContain("the turn has pending work now");
    });

    // Review E2: no observer runs between the last check and the send. The reminder's event is published once the SDK
    // accepted the prompt, before the send gate opens, so a Stop its observer asks for keeps the gate closed and nothing
    // more is sent.
    it("E2: the reminder's event is published after the SDK accepted the prompt; a Stop from its observer keeps the gate closed", async () => {
        // Each run starts only after its send() resolved, as the CLI's run does once it accepted the prompt (delayMs): so the
        // first send opens the gate, and the reminder's send opens it again unless a Stop closed it.
        const reminderTurn = async ({ stopOnEvent }) => {
            const h = stepChild([{ delayMs: 20, assistantContent: "It seems fine." }, { delayMs: 20, assistantContent: "Still fine." },
                { assistantContent: "never sent" }]);
            const live = new LiveTurnControl({ sessionId: "step-child", turn: 0, start: 0,
                abort: async reason => { h.managed.requestStop(reason); h.managed.abort(); } });
            let opened = 0;
            const binding = {
                attach: port => live.attach(port), heldStop: () => live.heldStop(), hasHeldControls: () => live.hasHeldControls(),
                gateOpened: () => { opened += 1; live.gateOpened(); }, detach: () => live.detach(),
            };
            let promptsAtEvent = null;
            let openedAtEvent = null;
            const result = await h.run({
                turnIndex: 0, turnControl: binding,
                onEvent: event => {
                    h.events.push(event);
                    if (event.eventType !== "runtime.workflow_step_reminded") return;
                    promptsAtEvent = h.fakeSession.sentPrompts.length;
                    openedAtEvent = opened;
                    if (stopOnEvent) h.managed.requestStop("Stopped by user");
                },
            });
            return { h, result, opened, promptsAtEvent, openedAtEvent };
        };
        // Without a Stop: the first send opened the gate once; the event comes after the SDK accepted the reminder and
        // before the gate opens for the reminder's run, which it then does.
        const plain = await reminderTurn({ stopOnEvent: false });
        expect(plain.promptsAtEvent).toBe(2);
        expect(plain.openedAtEvent).toBe(1);
        expect(plain.opened).toBe(2);
        expect(plain.result).toMatchObject({ type: "completed", content: "Still fine." });
        // A Stop from the event's observer: nothing more is sent, the gate stays closed, and the turn is stopped.
        const stopped = await reminderTurn({ stopOnEvent: true });
        expect(stopped.promptsAtEvent).toBe(2);
        expect(stopped.openedAtEvent).toBe(1);
        expect(stopped.h.fakeSession.sentPrompts).toEqual(["Review the change.", TEXT]);
        expect(stopped.opened).toBe(1);
        expect(stopped.result).toMatchObject({ type: "stopped", reason: "Stopped by user" });
    });

    // Review D3: a turn with an error is not a quiet prose end; the error stands.
    it.each([
        ["the CLI's empty-answer error", { message: "No response was returned. Send your message again to retry.", errorType: "query" }],
        ["a provider error", { message: "Provider returned 500", errorType: "provider" }],
    ])("D3: %s, then idle, never asks the gate and sends nothing", async (_label, error) => {
        const h = stepChild([{ assistantContent: null, events: [{ type: "session.error", data: error }] }, { assistantContent: "Recovered." }]);
        const result = await h.run();
        expect(result.type).toBe("error");
        expect(result.message).toContain(error.message);
        expect(h.checks).toEqual([]);
        expect(h.fakeSession.sentPrompts).toEqual(["Review the change."]);
    });

    // Review D4: the reminder's answer gets the same tool-call check as the first answer, within one budget per turn.
    it("D4: a tool call the reminder's answer writes as text is corrected, and the real call completes the step", async () => {
        const h = stepChild([
            { assistantContent: "It seems fine." },
            { assistantContent: INVOKE_AS_TEXT },
            { toolCalls: [COMPLETE], assistantContent: "STATE_COMPLETED" },
        ]);
        const result = await h.run();
        expect(result).toMatchObject({ type: "completed", content: "STATE_COMPLETED" });
        expect(h.fakeSession.sentPrompts).toHaveLength(3);
        expect(h.fakeSession.sentPrompts[1]).toBe(TEXT);
        expect(h.fakeSession.sentPrompts[2]).toContain("Come to your senses");
        expect(h.completeWorkflowNode).toHaveBeenCalledTimes(1);
        expect(result.events.map(event => event.eventType).filter(type => type.startsWith("runtime.")))
            .toEqual(["runtime.workflow_step_reminded", "runtime.tool_call_as_text"]);
    });

    it("D4: a reminder's answer that keeps writing the tool call as text ends the turn with an error, never completed", async () => {
        const h = stepChild([
            { assistantContent: "It seems fine." },
            { assistantContent: INVOKE_AS_TEXT },
            { assistantContent: INVOKE_AS_TEXT },
            { assistantContent: INVOKE_AS_TEXT },
        ]);
        const result = await h.run();
        expect(result.type).toBe("error");
        expect(result.message).toContain("Tool-call protocol error");
        expect(h.fakeSession.sentPrompts).toHaveLength(4);
        expect(h.completeWorkflowNode).not.toHaveBeenCalled();
        // One reminder in the turn, whatever follows it.
        expect(h.checks).toHaveLength(1);
        expect(reminded(result)).toHaveLength(1);
    });

    it("what the reminder's run does ends the turn as it would any run: a wait, or a cron with its answer", async () => {
        // A wait longer than the session's wait threshold (30 s) ends the turn; a shorter one is waited out inside it.
        const waited = stepChild([{ assistantContent: "It seems fine." }, { toolCalls: [{ name: "wait", args: { seconds: 120, reason: "build running" } }],
            assistantContent: "Waiting for the build." }]);
        const result = await waited.run();
        expect(result.type).toBe("wait");
        expect(waited.fakeSession.sentPrompts).toEqual(["Review the change.", TEXT]);
        const scheduled = stepChild([{ assistantContent: "It seems fine." }, { toolCalls: [{ name: "cron", args: { seconds: 60, reason: "check the build" } }],
            assistantContent: "I will check every minute." }]);
        const later = await scheduled.run();
        expect(later).toMatchObject({ type: "completed", content: "I will check every minute." });
        expect(later.queuedActions).toEqual([expect.objectContaining({ type: "cron", action: "set", intervalSeconds: 60 })]);
        expect(scheduled.checks).toHaveLength(1);
    });

    it("the reminder comes after the required-tool correction, never before it", async () => {
        const catalog = vi.fn(async () => ({ commands: 71 }));
        const tools = [{ name: "package_catalog", parameters: { type: "object", properties: {} }, handler: catalog }];
        const h = stepChild([
            { assistantContent: "The catalog has 71 commands." },
            { toolCalls: [{ name: "package_catalog", args: {} }], assistantContent: "Catalog verified." },
            { assistantContent: "Still checking the review." },
        ], { tools });
        const result = await h.run({ requiredTool: "package_catalog" });
        expect(result).toMatchObject({ type: "completed", content: "Still checking the review." });
        expect(h.fakeSession.sentPrompts).toHaveLength(3);
        expect(h.fakeSession.sentPrompts[1]).toContain("Required-tool contract violation");
        expect(h.fakeSession.sentPrompts[2]).toBe(TEXT);
        expect(result.events.map(event => event.eventType).filter(type => type.startsWith("runtime.")))
            .toEqual(["runtime.required_tool_not_invoked", "runtime.workflow_step_reminded"]);
    });
});
