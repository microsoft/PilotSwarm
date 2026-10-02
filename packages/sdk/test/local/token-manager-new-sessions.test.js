/**
 * The Token Manager tells new sessions from old ones (live model).
 *
 * The worker runs the management agents. The test writes four sessions
 * into the catalog: three created now (two owners), and one created three
 * hours ago but updated now. An update does not make a session new, so the
 * agent must leave that one out.
 *
 * Then the test asks the Token Manager which sessions were created in the
 * last hour, and checks that:
 *   - it called list_sessions;
 *   - its answer (a JSON object, as asked) lists exactly the three new
 *     sessions, so not the old one.
 *
 * Run: node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run test/local/token-manager-new-sessions.test.js
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { PilotSwarmWorker, PilotSwarmClient } from "../helpers/local-workers.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog, waitForSessionState } from "../helpers/cms-helpers.js";
import { systemAgentUUID, systemChildAgentUUID } from "../../src/index.ts";

const TIMEOUT = 300_000;

const NEW_SESSIONS = [
    { title: "tm-new-alpha", owner: { provider: "test", subject: "alice", email: "alice@example.com", displayName: "Alice" } },
    { title: "tm-new-beta", owner: { provider: "test", subject: "alice", email: "alice@example.com", displayName: "Alice" } },
    { title: "tm-new-gamma", owner: { provider: "test", subject: "bob", email: "bob@example.com", displayName: "Bob" } },
];
const OLD_SESSION = {
    title: "tm-old-delta",
    owner: { provider: "test", subject: "carol", email: "carol@example.com", displayName: "Carol" },
};

async function testTokenManagerNewSessions(env) {
    const catalog = await createCatalog(env);
    const worker = new PilotSwarmWorker({
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId: "test-token-manager",
        disableManagementAgents: false,
    });
    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
    });
    const sql = new pg.Client({ connectionString: env.store });

    try {
        await sql.connect();
        for (const one of [...NEW_SESSIONS, OLD_SESSION]) {
            const sessionId = randomUUID();
            await catalog.createSession(sessionId, { model: "test:model", owner: one.owner });
            await catalog.updateSession(sessionId, { title: one.title });
            one.sessionId = sessionId;
        }
        // Created three hours ago, updated now: listed by "updated since",
        // but not new.
        await sql.query(
            `UPDATE "${env.cmsSchema}".sessions
                SET created_at = now() - interval '3 hours', updated_at = now()
              WHERE session_id = $1`,
            [OLD_SESSION.sessionId],
        );

        await worker.start();
        await client.start();

        const tokenManagerId = systemChildAgentUUID(systemAgentUUID("pilotswarm"), "token-manager");
        // Wait for the agent's first turn to end: it sets its cron and waits.
        await waitForSessionState(catalog, tokenManagerId, ["waiting", "idle"], 180_000);

        // The Token Manager keeps a cron, so after a turn it goes back to
        // "waiting", never "idle": sendAndWait would wait forever. Send, then
        // read the reply from the session's events.
        const before = await catalog.getSessionEvents(tokenManagerId, undefined, 500);
        const afterSeq = before.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
        const session = await client.resumeSession(tokenManagerId);
        await session.send(
            "Which sessions were created in the last hour? Reply with only a JSON object, no other text: "
            + "{\"owners\": [{\"owner\": \"<owner name>\", \"titles\": [\"<session title>\", ...]}]}. "
            + "Include only sessions created in the last hour.",
        );

        const deadline = Date.now() + 240_000;
        let events = [];
        let replies = [];
        let stablePolls = 0;
        let lastCount = -1;
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            events = await catalog.getSessionEvents(tokenManagerId, afterSeq, 500);
            const asked = events.findIndex((event) => event.eventType === "user.message");
            replies = asked < 0 ? [] : events.slice(asked + 1)
                .filter((event) => event.eventType === "assistant.message" && String(event.data?.content ?? "").trim());
            const row = await catalog.getSession(tokenManagerId);
            const settled = replies.length > 0 && ["waiting", "idle"].includes(row?.state);
            stablePolls = settled && events.length === lastCount ? stablePolls + 1 : 0;
            lastCount = events.length;
            if (stablePolls >= 2) break;
        }
        // What the agent asked list_sessions for, and what came back.
        for (const event of events) {
            if (!String(event.eventType).startsWith("tool.execution")) continue;
            const data = event.data ?? {};
            const name = data.toolName ?? data.name ?? "";
            if (name && name !== "list_sessions") continue;
            const shown = event.eventType === "tool.execution_start"
                ? data.arguments
                : (data.result ?? data.output ?? data.content ?? Object.fromEntries(Object.entries(data).filter(([key]) => key !== "arguments")));
            const detail = JSON.stringify(shown).slice(0, 2500);
            console.log(`  ${event.eventType} ${name}: ${detail}`);
        }
        assert(replies.length > 0, "the Token Manager replied within 240 s");
        const answer = String(replies[replies.length - 1].data.content);
        console.log(`  Token Manager answer:\n${answer}`);

        const listed = events.some((event) => event.eventType === "tool.execution_start"
            && (event.data?.toolName === "list_sessions" || event.data?.name === "list_sessions"));
        assert(listed, "the Token Manager called list_sessions");

        const json = answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1);
        let parsed;
        try {
            parsed = JSON.parse(json);
        } catch {
            throw new Error(`the answer is not the JSON object asked for: ${answer}`);
        }
        const titles = (parsed.owners ?? []).flatMap((owner) => owner.titles ?? []).map(String).sort();
        assertEqual(
            JSON.stringify(titles),
            JSON.stringify(NEW_SESSIONS.map((one) => one.title).sort()),
            `exactly the three new sessions (${OLD_SESSION.title} was created three hours ago, only updated now)`,
        );
    } finally {
        await sql.end().catch(() => {});
        await client.stop().catch(() => {});
        await worker.stop();
        await catalog.close();
    }
}

describe("Token Manager: new sessions", () => {
    let env;
    beforeAll(async () => {
        await preflightChecks();
        env = createTestEnv("token-manager-new-sessions");
    });
    afterAll(async () => { await env?.cleanup(); });

    it("names the sessions created in the last hour, not one that was only updated", { timeout: TIMEOUT }, async () => {
        await testTokenManagerNewSessions(env);
    });
});
