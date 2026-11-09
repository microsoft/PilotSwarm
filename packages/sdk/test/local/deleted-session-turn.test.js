/**
 * Review DR2-001: a session whose row is deleted never runs a model turn. A Workflow agent session is created by its spawn
 * (the catalog row, no orchestration yet), then its first prompt is sent, which starts the session's orchestration. A
 * person's delete then is a catalog delete only (nothing runs to stop). The client's send refuses a row that is already
 * deleted when it reads it (it cannot restore the session's lineage); a delete that lands after that read, before the
 * send starts the orchestration, used to leave the first turn free to run the model on the deleted session, before the
 * Workflow's carried delete was queued. Now the turn reads the tombstone with its lineage, runs no model and no tool, and
 * queues the session's own delete: the orchestration ends and the row stays deleted. The Workflow's carry is not involved
 * here (held for ever): the real session orchestration (1.0.83), the real turn activity and a scripted model; the child's
 * id and first prompt as a `session: new` visit's and as a continued replacement's.
 *
 * Review D3-001: the refused turn's result is followed by the orchestration's title step before its own delete is
 * drained. A session whose title is due (its first turn armed it 60 s earlier) and whose row is deleted while its cancel
 * has not arrived sent its retained conversation to the title model. Now its next turn and its title step both run no
 * model: no request at all after the delete, and the session's own delete ends it.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { workflowAgentChatSessionId, workflowAgentChildSessionId } from "../../src/workflow/v2/agent-ids.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const OWNER = { provider: "test", subject: "deleted-session-turn", email: null, displayName: null };

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

describe("a deleted session runs no model turn (review DR2-001)", () => {
    for (const [label, childId, prompt] of [
        ["a `session: new` visit's agent session", () => workflowAgentChildSessionId(`nx-${randomUUID()}`),
            marker => `[SYSTEM: workflow node invocation ${marker}] Tell one new fact about PostgreSQL.`],
        ["a continued agent session's replacement", () => workflowAgentChatSessionId(`run-${randomUUID()}`, "talk", 2),
            marker => `[SYSTEM: workflow node invocation ${marker}] The agent session of its earlier cycles ended. Tell one new fact.`],
    ]) {
        it(`${label}, deleted between its create and its first send, ends without a model request or a tool call; its row stays deleted`, { timeout: TIMEOUT }, async () => {
            const env = getEnv();
            const mgmt = await createManagementClient(env);
            const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
            await catalog.initialize();
            try {
                await withScriptedModel(env, { worker: { logLevel: "warning" } }, async ({ client, model, qualifiedModel }) => {
                    const parent = await client.createSession({ model: qualifiedModel, owner: OWNER });
                    const id = childId();
                    const marker = `deleted-turn-${randomUUID()}`;
                    // As the Workflow's agent host creates a child: the catalog row (refusing a deleted one), then the prompt.
                    const child = await client.createSession({ sessionId: id, parentSessionId: parent.sessionId, nestingLevel: 1,
                        owner: OWNER, model: qualifiedModel, refuseDeleted: true });
                    // A person deletes it after the send read its row and before it starts the orchestration: none exists
                    // yet, so the delete is a catalog delete only. The send then starts it with the prompt; nothing else is
                    // queued to it.
                    const restore = client._restoreLineageForStart.bind(client);
                    let deleted = false;
                    client._restoreLineageForStart = async (sessionId, ...rest) => {
                        const lineage = await restore(sessionId, ...rest);
                        if (sessionId === id && !deleted) {
                            expect((await client._getDuroxideClient().getStatus(`session-${id}`)).status).toBe("NotFound");
                            await mgmt.deleteSession(id, "deleted by a person");
                            deleted = await catalog.workflowStore().isSessionDeleted(id);
                        }
                        return lineage;
                    };
                    await child.send(prompt(marker), { clientMessageIds: [`workflow:${parent.sessionId}:run:agent:${marker}`],
                        sender: { kind: "agent", sessionId: parent.sessionId, display: "workflow node invocation" } });
                    expect(deleted).toBe(true);
                    let status;
                    try {
                        status = await until(async () => {
                            const read = (await client._getDuroxideClient().getStatus(`session-${id}`)).status;
                            return ["Completed", "Failed", "Terminated"].includes(read) ? read : null;
                        }, "the deleted session's orchestration to end", 60_000);
                    } catch (error) {
                        const info = await client._getDuroxideClient().getStatus(`session-${id}`);
                        const events = (await catalog.getSessionEvents(id, 0, 200)).map(event => [event.eventType, JSON.stringify(event.data ?? null).slice(0, 160)]);
                        throw new Error(`${error.message}; status ${JSON.stringify({ status: info.status, custom: String(info.customStatus ?? "").slice(0, 400) })}; `
                            + `requests with the marker ${model.requests.filter(request => JSON.stringify(request.body).includes(marker)).length}; events ${JSON.stringify(events)}`);
                    }
                    expect(["Completed", "Failed", "Terminated"]).toContain(status);
                    // No model request carried its prompt (so no tool call either), and the row is still deleted.
                    expect(model.requests.filter(request => JSON.stringify(request.body).includes(marker))).toEqual([]);
                    expect(await catalog.workflowStore().isSessionDeleted(id)).toBe(true);
                    const stopped = (await catalog.getSessionEvents(id, 0, 200, ["session.turn_stopped"])).map(event => event.data?.reason);
                    expect(stopped).toContain("This session was deleted; this turn was not run.");
                });
            } finally {
                await mgmt.stop();
                await catalog.close();
            }
        });
    }
});

describe("a deleted session's due title goes to no model (review D3-001)", () => {
    it("a chat deleted (row only, its cancel not yet arrived) when its title is due: the next turn and the title make no model request; it ends", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            await withScriptedModel(env, { worker: { logLevel: "warning" } }, async ({ client, model, qualifiedModel }) => {
                const chat = await client.createSession({ model: qualifiedModel, owner: OWNER });
                const kept = `retained-${randomUUID()}`;
                await chat.sendAndWait(`Remember the code ${kept} and say ok.`, 120_000);
                const firstTurnAt = Date.now();
                // The first turn armed the title for 60 s after it (FIRST_SUMMARIZE_DELAY); let it fall due.
                await new Promise(resolve => setTimeout(resolve, Math.max(0, firstTurnAt + 65_000 - Date.now())));
                expect(model.requests.filter(request => !request.session && JSON.stringify(request.body).includes(kept))).toEqual([]);
                // A person's delete whose cancel has not reached the orchestration: the catalog row only.
                await catalog.softDeleteSession(chat.sessionId);
                expect(await catalog.workflowStore().isSessionDeleted(chat.sessionId)).toBe(true);
                const before = model.requests.length;
                const marker = `after-delete-${randomUUID()}`;
                await chat.send(`Say ${marker}.`);
                const orchestrationId = `session-${chat.sessionId}`;
                const status = await until(async () => {
                    const read = (await client._getDuroxideClient().getStatus(orchestrationId)).status;
                    return ["Completed", "Failed", "Terminated"].includes(read) ? read : null;
                }, "the deleted chat's orchestration to end", 90_000);
                expect(["Completed", "Failed", "Terminated"]).toContain(status);
                // No request after the delete: not the turn's (its prompt) and not the title's (the kept conversation).
                const after = model.requests.slice(before).map(request => ({ session: request.session, path: request.path,
                    turn: JSON.stringify(request.body).includes(marker), conversation: JSON.stringify(request.body).includes(kept) }));
                expect(after).toEqual([]);
                expect(await catalog.workflowStore().isSessionDeleted(chat.sessionId)).toBe(true);
                const stopped = (await catalog.getSessionEvents(chat.sessionId, 0, 500, ["session.turn_stopped"])).map(event => event.data?.reason);
                expect(stopped).toContain("This session was deleted; this turn was not run.");
            });
        } finally {
            await catalog.close();
        }
    });
});
