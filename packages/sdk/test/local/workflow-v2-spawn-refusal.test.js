/**
 * A refused start leaves nothing behind (preview finding, ux-capture-r5 on d72dfadf). A chat asked to publish and start a
 * definition with compile errors; the refusal (DEFINITION_INVALID) came after the workflow's session row had been
 * claimed, so a pending "Workflow <id>" with no definition stayed in the person's list.
 *
 * Every refusal of the request itself now comes before the claim, as the admission design already did for inputs, vars
 * and agent pins. spawn_workflow is no longer declared (owner 2026-11-08T16:55Z); the chat uses workflow_definition, the
 * path a model has: a revision with errors is saved and cannot start (no Workflow row); the corrected next revision starts.
 *
 * A full worker (PostgreSQL, duroxide and the Copilot CLI) with the model scripted.
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { turnWorkflowsOn } from "../helpers/workflows-on.js";

const TIMEOUT = 180_000;
const OWNER = { provider: "test", subject: "workflow-v2-spawn-refusal-owner" };
const PROMPT = "Start the one-second workflow.";

const YAML = next => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: one-second, version: "1.0.0" }
initial: pause
states:
  pause: { type: wait, seconds: 1${next} }
  done: { type: terminal, outcome: succeeded }
`;
/** No transition: a compile error. */
const INVALID = YAML("");
const VALID = YAML(", transition: { next: { elapsed: done } }");

const getEnv = useSuiteEnv(import.meta.url);

// Stage 2.1 (D2, E2-5): a definition with compile errors is saved as a revision with its errors and starts nothing: no
// Workflow row. The corrected YAML is the next revision, and it starts.
describe("a refused start leaves nothing behind", () => {
    it("a revision with errors starts nothing (no Workflow row); the corrected one is the next revision and starts", { timeout: TIMEOUT }, async () => {
        const results = [];
        let afterRefusal = "not checked";
        let catalog = null;
        let chatId = null;
        const workflowsOf = async () => (await catalog.pool.query(
            `SELECT session_id FROM "${getEnv().cmsSchema}".sessions WHERE parent_session_id = $1 AND session_kind = 'workflow'`, [chatId])).rows.map(row => row.session_id);
        const respond = async (_body, position) => {
            if (!position.lastUserText.includes(PROMPT)) return { content: "ok" };
            if (position.step > 0) results[position.step - 1] = position.toolResults[0];
            if (position.step === 0) return { tools: [{ name: "workflow_definition", args: { operation: "save", name: "one-second", yaml: INVALID } }] };
            if (position.step === 1) return { tools: [{ name: "workflow_definition", args: { operation: "start", name: "one-second" } }] };
            if (position.step === 2) {
                // Between the calls, as the agent sees it: no Workflow was made.
                afterRefusal = await workflowsOf();
                const saved = JSON.parse(results[0]);
                return { tools: [{ name: "workflow_definition", args: { operation: "save", name: "one-second", yaml: VALID,
                    definition_id: saved.definitionId, expected_revision: saved.revision } }] };
            }
            if (position.step === 3) return { tools: [{ name: "workflow_definition", args: { operation: "start", name: "one-second" } }] };
            return { content: "Started it." };
        };
        await withScriptedModel(getEnv(), { respond, worker: { workflowScripts: { enabled: true } } }, async ({ client, qualifiedModel }) => {
            catalog = client._catalog;
            const chat = await client.createSession({ model: qualifiedModel, owner: OWNER });
            chatId = chat.sessionId;
            await turnWorkflowsOn(catalog, chatId);
            expect(await chat.sendAndWait(PROMPT, TIMEOUT)).toBe("Started it.");

            const [saved, refused, corrected, started] = results.map(text => JSON.parse(text));
            expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, operation: "save", revision: 1, valid: false });
            expect(saved.errors.length).toBeGreaterThan(0);
            expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false });
            expect(afterRefusal, "no Workflow row after the revision with errors").toEqual([]);
            expect(corrected, JSON.stringify(corrected)).toMatchObject({ ok: true, operation: "save", revision: 2, valid: true, definitionId: saved.definitionId });
            expect(started, JSON.stringify(started)).toMatchObject({ ok: true, operation: "start", revision: 2 });
            // The one Workflow under the chat is the started one, pinned to revision 2.
            const workflows = await workflowsOf();
            expect(workflows).toEqual([started.workflowId]);
            expect((await catalog.workflowStore().chat.listWorkflows({ definitionId: saved.definitionId })).map(item => item.revision)).toEqual([2]);
        });
    });
});
