import test from "node:test";
import assert from "node:assert/strict";
import { selectActiveChat } from "../src/selectors.js";

test("workflow sessions show a truthful controller placeholder instead of chat", () => {
    const session = {
        sessionId: "workflow-1",
        sessionKind: "workflow",
        title: "Release workflow",
        createdAt: 1,
        updatedAt: 2,
    };
    const messages = selectActiveChat({
        branding: { title: "PilotSwarm" },
        sessions: {
            activeSessionId: session.sessionId,
            byId: { [session.sessionId]: session },
        },
        history: { bySessionId: new Map() },
    });

    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /workflow controller, not an LLM conversation/);
    assert.doesNotMatch(messages[0].text, /Start interacting/);
});
