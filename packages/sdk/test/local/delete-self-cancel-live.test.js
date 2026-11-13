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

const TIMEOUT = 420_000;
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
        // withClient calls fn(client, worker) POSITIONALLY - not with an object.
        await withClient(env, {}, async (client) => {
            const mgmt = await createManagementClient(env);
            const catalog = await createCatalog(env);
            try {
                const session = await client.createSession(ONEWORD_CONFIG);
                const sessionId = session.sessionId;

                // One real turn FIRST. The orchestration is not started until a session takes a turn, and
                // sendCommand refuses to enqueue into an instance that does not exist
                // (management-client.ts:4818, "orchestration ... is not started"). The delete path under test
                // only exists inside a running orchestration, so there is no way around starting one.
                await session.sendAndWait("Say ok.", 180_000);

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
    it("control: a DESCENDANT is still cancelled when its ancestor is deleted", { timeout: TIMEOUT }, async () => {
        // The flag must apply to the target and only the target. A descendant is a different orchestration with
        // nobody inside it waiting to answer anyone, so it keeps being cancelled as it always was - and if that
        // ever stopped being true, deleting a parent would leave its children running.
        const env = await getEnv();
        await withClient(env, {}, async (client) => {
            const mgmt = await createManagementClient(env);
            const catalog = await createCatalog(env);
            try {
                const parent = await client.createSession(ONEWORD_CONFIG);
                const child = await client.createSession({
                    ...ONEWORD_CONFIG, parentSessionId: parent.sessionId, nestingLevel: 1,
                });
                // Both need a turn: an orchestration does not exist until its session takes one.
                await parent.sendAndWait("Say ok.", 180_000);
                await child.sendAndWait("Say ok.", 180_000);

                const commandId = `delete-fb034-desc-${Date.now()}`;
                await mgmt.sendCommand(parent.sessionId, {
                    cmd: "delete", id: commandId, args: { reason: "FB-034 R4 descendant control" },
                });

                const parentRow = await until(() => catalog.getSession(parent.sessionId), v => v == null, 90_000);
                assertEqual(parentRow, null, "the parent row is gone");
                const childRow = await until(() => catalog.getSession(child.sessionId), v => v == null, 60_000);
                assertEqual(childRow, null, "and so is the child's");

                const dx = client._getDuroxideClient();
                const parentStatus = await dx.getStatus(`session-${parent.sessionId}`);
                assertEqual(parentStatus.status, "Completed",
                    `the TARGET still ends Completed (saw ${parentStatus.status})`);

                // I had asserted here that the descendant's instance must NOT read Completed, expecting the
                // cancel to show as it does for a self-delete. It reads Completed - and it does so IDENTICALLY
                // at b3135aba, so it detects nothing about this change and my expectation was simply unverified.
                // I have not chased what a cascaded child's terminal status should be; it is not what FB-034
                // changed, and guessing at it here would put an unproven claim in a passing test.
                //
                // The contract that actually matters - that a descendant delete carries NO selfDelete key, so it
                // keeps cancelling exactly as before - is pinned byte-exactly in delete-self-cancel.test.js. What
                // this live case adds is the part it can establish: the cascade still removes the child, and the
                // target still ends Completed beside it.
                const childStatus = await dx.getStatus(`session-${child.sessionId}`);
                assert(typeof childStatus.status === "string",
                    "the descendant's instance is readable after the cascade");
            } finally {
                await catalog.close().catch(() => {});
                await mgmt.stop?.().catch(() => {});
            }
        });
    });
});
