/**
 * A refused spawn_workflow leaves nothing behind (preview finding, ux-capture-r5 on d72dfadf). A chat asked to publish
 * and start a definition with compile errors; the refusal (DEFINITION_INVALID) came after the workflow's session row
 * had been claimed for its key, so a pending "Workflow <id>" with no definition stayed in the person's list, the
 * corrected request with the same key was refused (WORKFLOW_EXISTS), and read_workflow could not find it.
 *
 * Every refusal of the request itself now comes before the claim, as the admission design already did for inputs, vars
 * and agent pins: no session row, no claim on the key, and the corrected request uses the same key.
 *
 * A full worker (PostgreSQL, duroxide and the Copilot CLI) with the model scripted.
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";

const TIMEOUT = 180_000;
const OWNER = { provider: "test", subject: "workflow-v2-spawn-refusal-owner" };
const PROMPT = "Start the one-second workflow.";
const KEY = "one-second";

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

// Stage 2.1 (D2, E2-5): spawn_workflow saves to the chat's definition. A definition with compile errors is saved as a
// revision with its errors and starts nothing: no Workflow row. The corrected YAML is the next revision, and it starts.
describe("a refused spawn_workflow leaves nothing behind", () => {
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
            if (position.step === 0) return { tools: [{ name: "spawn_workflow", args: { yaml: INVALID, key: KEY, state: "published", start: true } }] };
            if (position.step === 1) {
                // Between the two calls, as the agent sees it: no Workflow was made.
                afterRefusal = await workflowsOf();
                return { tools: [{ name: "spawn_workflow", args: { yaml: VALID, key: KEY, state: "published", start: true } }] };
            }
            return { content: "Started it." };
        };
        // spawn_workflow is offered only where workflow scripts are on, as in the other workflow tests.
        await withScriptedModel(getEnv(), { respond, worker: { workflowScripts: { enabled: true } } }, async ({ client, qualifiedModel }) => {
            catalog = client._catalog;
            const chat = await client.createSession({ model: qualifiedModel, owner: OWNER });
            chatId = chat.sessionId;
            expect(await chat.sendAndWait(PROMPT, TIMEOUT)).toBe("Started it.");

            const [saved, accepted] = results.map(text => JSON.parse(text));
            expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, operation: "save", revision: 1, valid: false, started: false });
            expect(saved.errors.length).toBeGreaterThan(0);
            expect(afterRefusal, "no Workflow row after the revision with errors").toEqual([]);
            expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true, operation: "save_and_start", revision: 2, definitionId: saved.definitionId });
            // The one Workflow under the chat is the accepted one, pinned to revision 2.
            const workflows = await workflowsOf();
            expect(workflows).toEqual([accepted.workflowId]);
            expect(await catalog.workflowStore().readDefinition(accepted.workflowId)).toMatchObject({ state: "published", currentRevision: 1 });
            expect((await catalog.workflowStore().chat.listWorkflows({ definitionId: saved.definitionId })).map(item => item.revision)).toEqual([2]);
        });
    });
});
