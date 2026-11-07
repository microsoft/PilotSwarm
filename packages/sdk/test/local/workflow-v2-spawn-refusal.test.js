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
import { workflowChildSessionId } from "../../src/workflow/spawn.ts";

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

describe("a refused spawn_workflow leaves nothing behind", () => {
    it("refused before anything is written: no session row, and the corrected request uses the same key", { timeout: TIMEOUT }, async () => {
        const results = [];
        let afterRefusal = "not checked";
        let workflowId = null;
        let catalog = null;
        const respond = async (_body, position) => {
            if (!position.lastUserText.includes(PROMPT)) return { content: "ok" };
            if (position.step > 0) results[position.step - 1] = position.toolResults[0];
            if (position.step === 0) return { tools: [{ name: "spawn_workflow", args: { yaml: INVALID, key: KEY, state: "published", start: true } }] };
            if (position.step === 1) {
                // Between the two calls, as the agent sees it: the refused key holds nothing.
                afterRefusal = await catalog.getSession(workflowId);
                return { tools: [{ name: "spawn_workflow", args: { yaml: VALID, key: KEY, state: "published", start: true } }] };
            }
            return { content: "Started it." };
        };
        // spawn_workflow is offered only where workflow scripts are on, as in the other workflow tests.
        await withScriptedModel(getEnv(), { respond, worker: { workflowScripts: { enabled: true } } }, async ({ client, qualifiedModel }) => {
            catalog = client._catalog;
            const chat = await client.createSession({ model: qualifiedModel, owner: OWNER });
            workflowId = workflowChildSessionId(chat.sessionId, KEY, undefined);
            expect(await chat.sendAndWait(PROMPT, TIMEOUT)).toBe("Started it.");

            const [refused, accepted] = results.map(text => JSON.parse(text));
            expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, error: { code: "DEFINITION_INVALID" } });
            expect(refused.error.details.diagnostics.some(item => item.severity === "error")).toBe(true);
            expect(afterRefusal, "no session row after the refusal").toBeNull();
            expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true, workflowId, state: "published", revision: 1, valid: true });
            expect(accepted.run).toMatchObject({ mode: "live" });
            // The one workflow under the chat is the accepted one, with its definition.
            expect(await catalog.getSession(workflowId)).toMatchObject({ sessionKind: "workflow", parentSessionId: chat.sessionId });
            expect(await catalog.workflowStore().readDefinition(workflowId)).toMatchObject({ state: "published", currentRevision: 1 });
        });
    });
});
