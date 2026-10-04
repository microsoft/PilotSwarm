/**
 * What a turn result carries in `events`.
 *
 * The runTurn activity result is stored durably: in the orchestration history,
 * and in `.ps-turn-commit.json` inside the session snapshot. The orchestration
 * reads only context-usage events and `tool.execution_complete` from it. One
 * tool call with a large argument can stream thousands of
 * `assistant.tool_call_delta` events, some of them after the tool started, and
 * copying the call's arguments into each of those made turn results of
 * hundreds of megabytes (issue #121).
 *
 * Run: npx vitest run test/local/turn-result-events.test.js
 */
import { describe, expect, it } from "vitest";
import { ManagedSession } from "../../src/managed-session.ts";
import { updateContextUsageFromEvents } from "../../src/orchestration/utils.ts";
import { detectFailedModelSwitch } from "../../src/orchestration/turn.ts";
import {
    ORCHESTRATION_TURN_EVENT_TYPES,
    TURN_RESULT_WARNING_BYTES,
    keepOrchestrationTurnEvents,
    turnResultSizeWarning,
} from "../../src/turn-result-events.ts";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";

class FakeCopilotSession {
    registeredTools = [];
    listeners = new Map();
    catchAllHandlers = [];

    constructor(script) {
        this.script = script;
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

    async send() {
        queueMicrotask(() => this.script(this));
    }

    abort() {}
}

const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** One turn with a `create` call whose argument streams in many fragments. */
function largeToolCallTurn({ fragments, fragmentChars }) {
    return (session) => {
        session.emit("assistant.turn_start", {});
        session.emit("session.usage_info", {
            tokenLimit: 200_000, currentTokens: 50_000, messagesLength: 12,
        });
        session.emit("assistant.reasoning_delta", { reasoningId: "r1", deltaContent: "Write the script." });
        let fileText = "";
        for (let i = 0; i < fragments; i++) {
            const inputDelta = "x".repeat(fragmentChars);
            fileText += inputDelta;
            // A runtime that repeats the whole partial input in every fragment.
            session.emit("assistant.tool_call_delta", {
                toolCallId: "call-1",
                toolName: "create",
                inputDelta,
                path: "/tmp/script.py",
                file_text: fileText,
            });
        }
        session.emit("tool.execution_start", {
            toolCallId: "call-1", toolName: "create", arguments: { path: "/tmp/script.py", file_text: fileText },
        });
        session.emit("tool.execution_complete", {
            toolCallId: "call-1", toolName: "create", success: true, result: "Created /tmp/script.py",
        });
        session.emit("assistant.usage", { inputTokens: 1200, outputTokens: 900 });
        session.emit("session.compaction_start", {});
        session.emit("session.compaction_complete", { success: true, preCompactionTokens: 50_000, postCompactionTokens: 20_000 });
        session.emit("model.messages_snapshot", { messages: [{ role: "user", content: "y".repeat(200_000) }] });
        session.emit("assistant.message_delta", { messageId: "m1", deltaContent: "Do" });
        session.emit("assistant.message_delta", { messageId: "m1", deltaContent: "ne." });
        session.emit("assistant.message", { messageId: "m1", content: "Done." });
        session.emit("assistant.turn_end", {});
        session.emit("session.idle", {});
    };
}

/**
 * One turn whose `create` call gets argument pieces after it started, the
 * shape seen in #121. Each piece carries only its own fragment. A second call
 * gets no late pieces.
 */
function latePiecesTurn({ argumentChars, latePieces }) {
    return (session) => {
        session.emit("assistant.turn_start", {});
        const fileText = "z".repeat(argumentChars);
        for (let i = 0; i < 10; i++) {
            session.emit("assistant.tool_call_delta", {
                toolCallId: "call-big", toolName: "create", inputDelta: fileText.slice(i * 100, (i + 1) * 100),
            });
        }
        session.emit("tool.execution_start", {
            toolCallId: "call-big", toolName: "create", arguments: { path: "/tmp/big.py", file_text: fileText },
        });
        for (let i = 0; i < latePieces; i++) {
            session.emit("assistant.tool_call_delta", { toolCallId: "call-big", toolName: "create", inputDelta: "z" });
        }
        session.emit("tool.execution_complete", { toolCallId: "call-big", success: true, result: "Created /tmp/big.py" });
        session.emit("assistant.tool_call_delta", { toolCallId: "call-small", toolName: "view", inputDelta: "{}" });
        session.emit("tool.execution_start", { toolCallId: "call-small", toolName: "view", arguments: {} });
        session.emit("tool.execution_complete", { toolCallId: "call-small", success: true, result: "ok" });
        session.emit("assistant.message", { messageId: "m1", content: "Done." });
        session.emit("assistant.turn_end", {});
        session.emit("session.idle", {});
    };
}

describe("turn events collected by ManagedSession", () => {
    it("leaves streaming fragments and the messages snapshot out", async () => {
        const fragments = 400;
        const live = [];
        const session = new FakeCopilotSession(largeToolCallTurn({ fragments, fragmentChars: 100 }));
        const result = await new ManagedSession("turn-result-events", session, {}).runTurn("go", {
            onEvent: (event) => live.push(event),
        });

        expect(result.type).toBe("completed");
        expect(result.content).toBe("Done.");
        const types = result.events.map((event) => event.eventType);
        for (const type of ["assistant.tool_call_delta", "assistant.reasoning_delta", "assistant.message_delta", "model.messages_snapshot"]) {
            expect(types, `${type} must not be collected`).not.toContain(type);
        }
        // Live consumers still see every fragment and the snapshot.
        expect(live.filter((event) => event.eventType === "assistant.tool_call_delta")).toHaveLength(fragments);
        expect(live.some((event) => event.eventType === "model.messages_snapshot")).toBe(true);
        // The fragments carried about 400 * 20 KB = 8 MB. The result keeps the assembled call once.
        expect(bytesOf(result)).toBeLessThan(200_000);
    });

    it("does not copy a call's arguments into its late argument pieces", async () => {
        const argumentChars = 60_000;
        const latePieces = 200;
        const live = [];
        const session = new FakeCopilotSession(latePiecesTurn({ argumentChars, latePieces }));
        await new ManagedSession("late-pieces", session, {}).runTurn("go", { onEvent: (event) => live.push(event) });

        const startIndex = live.findIndex((event) => event.eventType === "tool.execution_start" && event.data.toolCallId === "call-big");
        const late = live.slice(startIndex).filter((event) =>
            event.eventType === "assistant.tool_call_delta" && event.data.toolCallId === "call-big");
        expect(late).toHaveLength(latePieces);
        // Before the fix every late piece got the full 60 KB argument copied
        // in: 200 pieces = 12 MB. Now each piece is its own fragment.
        for (const piece of late) expect(piece.data.arguments).toBeUndefined();
        const pieceBytes = live
            .filter((event) => event.eventType === "assistant.tool_call_delta")
            .reduce((sum, event) => sum + bytesOf(event), 0);
        expect(pieceBytes).toBeLessThan(100_000);
        // The copy rule still fills in events of the call that are not pieces.
        const complete = live.find((event) => event.eventType === "tool.execution_complete" && event.data.toolCallId === "call-big");
        expect(complete.data.toolName).toBe("create");
        expect(complete.data.arguments.file_text).toHaveLength(argumentChars);
    });

    it("logs late argument pieces once per call at the end of the turn", async () => {
        const lines = [];
        const session = new FakeCopilotSession(latePiecesTurn({ argumentChars: 2_000, latePieces: 25 }));
        await new ManagedSession("late-pieces-log", session, {}).runTurn("go", { trace: (line) => lines.push(line) });

        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/session=late-pieces-log tool call call-big \(create\): 25 argument pieces arrived after the tool started, the first \d+ ms and the last \d+ ms after the start, \d+ bytes$/);
    });
});

describe("turn result returned by the runTurn activity", () => {
    function everyKindOfEvent() {
        return [
            { eventType: "assistant.turn_start", data: {} },
            { eventType: "session.usage_info", data: { tokenLimit: 200_000, currentTokens: 50_000, messagesLength: 12 } },
            { eventType: "assistant.reasoning", data: { content: "think" } },
            { eventType: "tool.execution_start", data: { toolCallId: "c1", toolName: "set_session_model", arguments: { model: "x" } } },
            {
                eventType: "tool.execution_complete",
                data: { toolCallId: "c1", toolName: "set_session_model", success: false, result: "set_session_model failed: no such model." },
            },
            { eventType: "runtime.tool_call_as_text", data: { toolName: "bash", rawContent: "<invoke>" } },
            { eventType: "assistant.usage", data: { inputTokens: 1200, outputTokens: 900 } },
            { eventType: "session.compaction_start", data: {} },
            { eventType: "session.compaction_complete", data: { success: true, postCompactionTokens: 20_000 } },
            { eventType: "native.task_updated", data: { id: "t1", status: "completed" } },
            { eventType: "assistant.message", data: { content: "Done." } },
            { eventType: "assistant.turn_end", data: {} },
        ];
    }

    it("keeps only the event types the orchestration reads", async () => {
        const events = everyKindOfEvent();
        const harness = makeRunTurnHarness({ turn: async () => ({ type: "completed", content: "Done.", events }) });
        const result = await harness.runTurn();

        expect(result.type).toBe("completed");
        expect(result.content).toBe("Done.");
        expect(result.events.map((event) => event.eventType)).toEqual([
            "session.usage_info",
            "tool.execution_complete",
            "assistant.usage",
            "session.compaction_start",
            "session.compaction_complete",
        ]);
        for (const event of result.events) expect(ORCHESTRATION_TURN_EVENT_TYPES.has(event.eventType)).toBe(true);

        const usage = updateContextUsageFromEvents(undefined, result.events, 1000);
        expect(usage.tokenLimit).toBe(200_000);
        expect(usage.lastInputTokens).toBe(1200);
        expect(usage.compaction.state).toBe("succeeded");
        expect(usage.compaction.postCompactionTokens).toBe(20_000);
        expect(detectFailedModelSwitch(result.events)).toMatch(/^set_session_model failed: no such model\./);
        // Same answers as on the full list.
        expect(updateContextUsageFromEvents(undefined, events, 1000)).toEqual(usage);
        expect(detectFailedModelSwitch(events)).toBe(detectFailedModelSwitch(result.events));
    });

    it("logs a warning above 4 MiB and drops nothing", async () => {
        const output = "o".repeat(TURN_RESULT_WARNING_BYTES + 1024);
        const events = [{ eventType: "tool.execution_complete", data: { toolCallId: "c1", toolName: "bash", success: true, result: output } }];
        const harness = makeRunTurnHarness({ turn: async () => ({ type: "completed", content: "Done.", events }) });
        const result = await harness.runTurn("big-result");

        expect(result.events).toHaveLength(1);
        expect(result.events[0].data.result).toHaveLength(output.length);
        expect(harness.traces.warn).toHaveLength(1);
        expect(harness.traces.warn[0]).toMatch(/^\[runTurn\] session=big-result turn result is \d+ bytes \(warning above 4194304\); events \d+ bytes \(tool\.execution_complete x1 = \d+ bytes\); other fields \d+ bytes$/);
    });

    it("does not warn under the limit", async () => {
        const harness = makeRunTurnHarness({ turn: async () => ({ type: "completed", content: "Done.", events: everyKindOfEvent() }) });
        await harness.runTurn();
        expect(harness.traces.warn).toEqual([]);
    });
});

describe("turn result helpers", () => {
    it("returns the same object when there is nothing to remove", () => {
        const result = { type: "completed", content: "ok", events: [{ eventType: "assistant.usage", data: {} }] };
        expect(keepOrchestrationTurnEvents(result)).toBe(result);
        const noEvents = { type: "cancelled" };
        expect(keepOrchestrationTurnEvents(noEvents)).toBe(noEvents);
    });

    it("measures the whole result and names the largest event types", () => {
        expect(turnResultSizeWarning({ type: "completed", content: "ok", events: [] })).toBeNull();
        const warning = turnResultSizeWarning({
            type: "completed",
            content: "c".repeat(300),
            events: [
                { eventType: "tool.execution_complete", data: { result: "r".repeat(500) } },
                { eventType: "assistant.usage", data: { inputTokens: 1 } },
            ],
        }, 100);
        expect(warning).toMatch(/^turn result is \d+ bytes \(warning above 100\); events \d+ bytes \(tool\.execution_complete x1 = \d+ bytes, assistant\.usage x1 = \d+ bytes\); other fields \d+ bytes$/);
    });
});
