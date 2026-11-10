/**
 * PR 270 (owner decision): the turn of a Workflow agent state's own chat ends as an error on a session.error that is not
 * benign, even when the model already gave text (TurnOptions.sessionErrorEndsTurn, set by the runTurn activity for that
 * chat only). Before, such a turn ended "completed" with the text, no retry ran, no reminder was given (the turn had an
 * error), and the step waited for its deadline. Every other session keeps today's rule: text wins over the error.
 *
 * The Copilot session is a test double that emits the events a turn gets (as inline-control-tools.test.js's).
 */
import { describe, expect, it } from "vitest";
import { ManagedSession } from "../../src/managed-session.ts";

class FakeCopilotSession {
    registeredTools = [];
    listeners = new Map();
    catchAllHandlers = [];
    assistantContent = "ok";
    scriptedEvents = [];
    aborted = false;

    on(eventType, handler) {
        if (typeof eventType === "function") {
            this.catchAllHandlers.push(eventType);
            return () => { this.catchAllHandlers = this.catchAllHandlers.filter((candidate) => candidate !== eventType); };
        }
        const handlers = this.listeners.get(eventType) ?? [];
        handlers.push(handler);
        this.listeners.set(eventType, handlers);
        return () => { this.listeners.set(eventType, (this.listeners.get(eventType) ?? []).filter((candidate) => candidate !== handler)); };
    }

    registerTools(tools) {
        this.registeredTools = tools;
    }

    emit(eventType, payload = {}) {
        for (const handler of this.catchAllHandlers) handler({ type: eventType, data: payload.data ?? payload });
        for (const handler of this.listeners.get(eventType) ?? []) handler(payload);
    }

    async send() {
        this.aborted = false;
        queueMicrotask(() => {
            if (this.assistantContent != null) this.emit("assistant.message", { data: { content: this.assistantContent } });
            for (const event of this.scriptedEvents) this.emit(event.type, { data: event.data ?? {} });
            this.emit("session.idle", { data: {} });
        });
    }

    abort() {
        this.aborted = true;
    }
}

const RATE_LIMIT = { type: "session.error", data: { message: "Request failed: exceeded token rate limit (429)", errorType: "model_call" } };

function textThenError(error = RATE_LIMIT) {
    const fake = new FakeCopilotSession();
    fake.assistantContent = "I looked at the change; let me write the review.";
    fake.scriptedEvents = [error];
    return fake;
}

describe("a Workflow agent chat's turn whose model fails after it gave text (PR 270)", () => {
    it("ends as an error for the agent chat's turn, so its retries and its failure report apply", async () => {
        const managed = new ManagedSession("workflow-agent-text-then-error", textThenError(), {});
        const result = await managed.runTurn("do the step", { sessionErrorEndsTurn: true });
        expect(result.type).toBe("error");
        expect(result.message).toContain("exceeded token rate limit");
    });

    it("keeps today's rule for every other session: the text wins and the turn is completed", async () => {
        const managed = new ManagedSession("plain-text-then-error", textThenError(), {});
        const result = await managed.runTurn("say something");
        expect(result.type).toBe("completed");
        expect(result.content).toBe("I looked at the change; let me write the review.");
    });

    it("leaves the benign post-completion query error benign for the agent chat too", async () => {
        const managed = new ManagedSession("workflow-agent-benign", textThenError({
            type: "session.error", data: { message: "Cannot read properties of null (reading 'length')", errorType: "query" },
        }), {});
        const result = await managed.runTurn("do the step", { sessionErrorEndsTurn: true });
        expect(result.type).toBe("completed");
    });
});
