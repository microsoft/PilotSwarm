/**
 * Scripted-model harness: proves a full worker (PostgreSQL, Duroxide, the
 * real Copilot CLI) runs deterministic turns against scripted-model.mjs, that
 * native tools really execute, and that every model request is captured.
 *
 * Also checks the pinned-version start helper against a frozen handler.
 *
 * Run: npx vitest run test/local/scripted-harness.test.js
 */
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { scriptTurns } from "../helpers/scripted-model.mjs";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { pinSessionStartVersion, sessionOrchestrationVersion } from "../helpers/pinned-start.mjs";
import { DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../src/orchestration-registry.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

describe("scripted-model harness", () => {
    it("runs scripted turns with real native tools and captures requests", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const marker = `scripted-${env.runId}`;
        const respond = scriptTurns([
            // Turn 1: run a real shell command, then answer with its output.
            [
                { tools: [{ name: "bash", args: { command: `echo ${marker}`, description: "echo marker" } }] },
                (_body, position) => ({ content: `turn1:${position.toolResults.join("").includes(marker) ? "saw-marker" : "no-marker"}` }),
            ],
            // Turn 2: plain answer.
            [{ content: "turn2:ok" }],
        ]);

        await withScriptedModel(env, { respond }, async ({ client, model, qualifiedModel }) => {
            const sessionId = `00000000-0000-4000-8000-${env.runId.padStart(12, "0")}`;
            const session = await client.createSession({ sessionId, model: qualifiedModel });
            assertEqual(session.sessionId, sessionId, "fixed session id is honored");

            const first = await session.sendAndWait("first prompt", TIMEOUT);
            assertEqual(first, "turn1:saw-marker", "turn 1 ran bash and saw its output");

            const second = await session.sendAndWait("second prompt", TIMEOUT);
            assertEqual(second, "turn2:ok", "turn 2 answered from the second script entry");

            const requests = model.sessionRequests("first prompt");
            assert(requests.length >= 3, `expected at least 3 session requests, got ${requests.length}`);
            const firstRequest = requests[0];
            assertEqual(firstRequest.position.turn, 1);
            assertEqual(firstRequest.position.step, 0);
            assert(Array.isArray(firstRequest.body.tools) && firstRequest.body.tools.length > 0, "request carries the tool list");
            assert(firstRequest.body.messages.some((m) => m.role === "system"), "request carries a system message");
            const turn2 = requests.find((r) => r.position.turn === 2);
            assert(turn2, "a request for turn 2 was captured");
        });
    });

    it("starts a session at a pinned frozen orchestration version", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const frozen = DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-2).version;
        assert(frozen !== DURABLE_SESSION_LATEST_VERSION, "the registry has a frozen version before the latest");

        await withScriptedModel(env, { respond: scriptTurns([[{ content: "pinned:ok" }]]) }, async ({ client, qualifiedModel }) => {
            const sessionId = `00000000-0000-4000-8001-${env.runId.padStart(12, "0")}`;
            const pin = pinSessionStartVersion(client, frozen, { sessionId });
            try {
                const session = await client.createSession({ sessionId, model: qualifiedModel });
                assertEqual(await session.sendAndWait("pinned prompt", TIMEOUT), "pinned:ok", "the frozen handler ran the turn");
            } finally {
                pin.restore();
            }
            assert(pin.starts.some((s) => s.used === frozen && s.requested === DURABLE_SESSION_LATEST_VERSION),
                `the start was pinned: ${JSON.stringify(pin.starts)}`);
            assertEqual(await sessionOrchestrationVersion(client, sessionId), frozen, "Duroxide records the pinned version");
        });
    });
});
