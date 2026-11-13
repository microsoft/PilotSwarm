/**
 * FB-034 R4, LIVE: a session deleting itself must end Completed with its reply delivered.
 *
 * This is the test Keeper asked for and the only one that can see the defect. Every other test in this change
 * drives the generator against a fake delete activity, and a fake that cancels nothing looks exactly the same
 * whether or not the fix is present — which is precisely why this survived review until now.
 *
 * The defect, on duroxide core v0.1.32: the delete activity calls PilotSwarmClient.deleteSession, whose
 * _deleteOneSession soft-deletes the row and then cancels the instance. When a session deletes ITSELF that cancel
 * lands on the caller. A CancelInstance work item becomes OrchestrationCancelRequested in the turn that dequeues
 * it (replay_engine.rs 394-417) and finalize_turn (1061-1068) then returns Cancelled, which outranks Completed and
 * the generator's own return value. `writeCommandResponse` yields `ctx.utcNow()`, a real activity, and the
 * Cancelled branch dispatches no worker items — so the reply is never written. Deterministically, every time.
 *
 * Keeper's instruction, followed: run this against b3135aba FIRST and watch it fail, so the test is known to
 * detect the problem before it is used to certify the fix.
 *
 * Expected on b3135aba (no fix): orchestration Cancelled, no command response.
 * Expected with the fix:         orchestration Completed, output "deleted", reply ok:true, row gone.
 *
 * Run: node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run test/local/delete-self-cancel-live.test.js
 *      (the env file matters: without it the default model resolves to a Copilot-backed one and preflight fails)
 */
import { describe, it, beforeAll } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient, createManagementClient } from "../helpers/local-workers.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const TIMEOUT = 300_000;
const getEnv = useSuiteEnv(import.meta.url);

beforeAll(async () => { await preflightChecks(); });

/** Poll until the predicate holds or the deadline passes. Returns the last value seen either way. */
async function until(read, ok, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await read().catch(() => null);
        if (ok(last)) return last;
        await new Promise(r => setTimeout(r, 500));
    }
    return last;
}

describe("FB-034 R4 (live): a self-delete keeps its own orchestration alive long enough to answer", () => {
    it("ends Completed with the reply delivered and the row gone", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await withClient(env, {}, async ({ client }) => {
            const mgmt = await createManagementClient(env);
            const catalog = await createCatalog(env);
            try {
                const session = await client.createSession(ONEWORD_CONFIG);
                const sessionId = session.sessionId ?? session.id ?? session;

                // Send the delete through the REAL lifecycle command path, with an id we choose so the reply can
                // be read back by id rather than guessed at.
                const commandId = `delete-fb034-${Date.now()}`;
                await mgmt.sendCommand(sessionId, { cmd: "delete", id: commandId, args: { reason: "FB-034 R4 live" } });

                // The row goes first: the activity soft-deletes before it would have cancelled.
                const row = await until(() => catalog.getSession(sessionId), value => value == null, 90_000);
                assertEqual(row, null, "the session row is soft-deleted");

                // THE ASSERTION THAT FAILS WITHOUT THE FIX. On b3135aba the instance is cancelled before the
                // reply's utcNow is dispatched, so this stays null for ever.
                const reply = await until(
                    () => mgmt.getCommandResponse(sessionId, commandId),
                    value => value != null,
                    60_000,
                );
                assert(reply != null, "the caller receives a reply at all (null here is the defect)");
                assertEqual(reply.result?.ok, true, "and it says the delete succeeded");
                assertEqual(reply.error, undefined, "with no error");

                // And the orchestration ended normally rather than being cancelled by its own delete. The idiom
                // is the one deleted-session-turn.test.js uses.
                const info = await client._getDuroxideClient().getStatus(`session-${sessionId}`);
                assertEqual(info.status, "Completed",
                    `the orchestration ends Completed, not Cancelled (saw ${info.status})`);
            } finally {
                await catalog.close().catch(() => {});
                await mgmt.stop?.().catch(() => {});
            }
        });
    });
});
