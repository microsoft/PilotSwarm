/**
 * E2-4 and F3 (Workflow Simplified stage 2.1) on a real 1.0.83 turn (runTurnV5): a person's save of one of the chat's
 * Workflow Definitions leaves a note; the chat's next turn reads it at the start of its prompt; a turn that fails keeps it
 * for its retry, and the turn that succeeds consumes it, so a later turn does not see it again. A save never starts a turn.
 * The model is scripted (intake native fixture).
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { intakeNativeCase, INTAKE_NATIVE_TIMEOUT } from "../helpers/workflow-v2-intake-native-fixture.js";
import { saveChatWorkflowDefinition } from "../../src/workflow/v2/chat-definitions.ts";
import { workflowParentNotifier } from "../../src/workflow/parent-delivery.ts";
import { workflowV2ParentNotification } from "../../src/workflow/v2/runtime.ts";

const getEnv = useSuiteEnv(import.meta.url);
const YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: hn-top-watch, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 30, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;
const NOTE = "[SYSTEM: Ada Lovelace saved hn-top-watch revision 1.]";

describe("a person's save note reaches the chat's next turn once (E2-4, F3)", () => {
    it("a failed turn keeps the note for its retry; the turn that succeeds consumes it; the next turn has none", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        const prompts = [];
        let attempt = 0;
        const script = async (_call, prompt) => {
            attempt += 1;
            prompts.push(String(prompt));
            if (attempt === 1) return { type: "error", message: "the model did not answer (scripted)", events: [] };
            return { type: "completed", content: "noted", events: [] };
        };
        await intakeNativeCase(getEnv(), "save note turn", script, { testOptions: { workflowRequests: true },
            managerExtras: { workflowScriptsEnabled: true } }, async h => {
            const host = { catalog: h.catalog, store: h.store, duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }),
                enqueueEvent: async () => {} } };
            await h.start();
            await h.until(({ history }) => history.some(event => event.kind === "QueueSubscribed"), "the session waits for its messages");
            await saveChatWorkflowDefinition(host, { ownerSessionId: h.sessionId, name: "hn-top-watch", yaml: YAML, expected: null,
                actor: { kind: "user", provider: "test", subject: "ada", display: "Ada Lovelace" }, operationId: "person-save-1", by: "person", personWords: "Ada Lovelace" });
            expect((await h.store.chat.pendingNotes(h.sessionId)).length).toBe(1);
            // The save started no turn.
            expect(prompts).toEqual([]);
            await h.say("what changed?", "cm-note-1");
            await h.until(async () => prompts.length >= 2 && (await h.store.chat.pendingNotes(h.sessionId)).length === 0,
                "the retry succeeds and consumes the note");
            expect(prompts[0].startsWith(`${NOTE}\n\n`), prompts[0]).toBe(true);
            expect(prompts[1].startsWith(`${NOTE}\n\n`), prompts[1]).toBe(true);
            await h.say("and now?", "cm-note-2");
            await h.until(() => prompts.length >= 3, "the next turn runs");
            expect(prompts[2]).not.toContain(NOTE);
        });
    });
    // Deployed check DS-2: a chat made without a first message has no session orchestration. The worker's delivery of a
    // Workflow's end says so, and the runtime keeps the notice as the chat's note (workflow-v2-notify-parent "DS-2" runs that
    // end to end on the real controller); nothing starts the chat. Its first turn reads the note once.
    it("DS-2: a Workflow's end kept for a chat that has not started is read by its first turn, once", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        const prompts = [];
        const script = async (_call, prompt) => {
            prompts.push(String(prompt));
            return { type: "completed", content: "noted", events: [] };
        };
        await intakeNativeCase(getEnv(), "end notice first turn", script, { testOptions: { workflowRequests: true },
            managerExtras: { workflowScriptsEnabled: true } }, async h => {
            const delivery = await workflowParentNotifier(h.client)(h.sessionId, "ended", { kind: "system", display: "workflow" }, "ds2-id");
            expect(delivery).toEqual({ delivered: false, notStarted: true });
            const notice = workflowV2ParentNotification({ sessionId: "wf-ds2", runId: "run-ds2-0001", name: "hn-top-watch", version: "1.0.0",
                status: "completed", outcome: "succeeded", stateId: "done", failure: null }, "{}");
            await h.store.chat.keepNote(h.sessionId, "wf-ds2", 1, notice);
            // A retried notice keeps it once.
            await h.store.chat.keepNote(h.sessionId, "wf-ds2", 1, notice);
            expect(await h.store.chat.pendingNotes(h.sessionId)).toHaveLength(1);
            // Nothing started the chat, and no turn ran.
            expect((await h.client.getStatus(h.instanceId)).status).toBe("NotFound");
            expect(prompts).toEqual([]);
            await h.start();
            await h.until(({ history }) => history.some(event => event.kind === "QueueSubscribed"), "the session waits for its messages");
            await h.say("hello", "cm-ds2-1");
            await h.until(async () => prompts.length >= 1 && (await h.store.chat.pendingNotes(h.sessionId)).length === 0,
                "the first turn reads the note and consumes it");
            expect(prompts[0].startsWith(`[SYSTEM: ${notice}]\n\n`), prompts[0]).toBe(true);
            await h.say("and now?", "cm-ds2-2");
            await h.until(() => prompts.length >= 2, "the next turn runs");
            expect(prompts[1]).not.toContain(notice);
        });
    });
});
