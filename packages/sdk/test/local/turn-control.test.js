/**
 * Session turn control, phase A5: Stop and Steer through the real Copilot
 * CLI and the default model (design 7.3; Spec US-1, US-2, US-3, US-7).
 *
 * Controls enter through `catalog.turnControlAdd`, as the API does (the
 * client surfaces are workstream C's). The window cases use the
 * session-scoped `hold` fault action (plan P23): a hold blocks only its own
 * session, so these cases run concurrently with the rest of the file.
 *
 * Prompts ask for tool calls, so a turn has model calls and tool boundaries
 * where a steer can land; every assertion is on the durable record (outcome
 * events, confirmations, transcript), not on what the model writes.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { execFileSync } from "node:child_process";
import { describe, it, beforeAll, afterAll } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { createCatalog, waitForEventCount } from "../helpers/cms-helpers.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { armFaultHold } from "../../src/fault-injection.ts";
import { readTurnCommitFile } from "../../src/snapshot-protocol.ts";
import { TURN_CONTROL_EVENT_TYPES as EV } from "../../src/turn-control-contract.ts";
import { TURN_CONTROL_ORCHESTRATION, until, outcomesOf, awaitOutcome } from "../helpers/turn-control-harness.mjs";

const TIMEOUT = 300_000;
const REPLY_TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-tc-release-"));
const savedReleaseDir = process.env.PILOTSWARM_FAULT_RELEASE_DIR;
beforeAll(async () => {
    await preflightChecks();
    process.env.PILOTSWARM_FAULT_RELEASE_DIR = releaseDir;
});
afterAll(() => {
    if (savedReleaseDir === undefined) delete process.env.PILOTSWARM_FAULT_RELEASE_DIR;
    else process.env.PILOTSWARM_FAULT_RELEASE_DIR = savedReleaseDir;
    fs.rmSync(releaseDir, { recursive: true, force: true });
});

const release = (point, sessionId) => fs.writeFileSync(path.join(releaseDir, `${point}.${sessionId}`), "");
/** Wait until the worker has reached a session-scoped hold (it writes `<point>.<session>.held`). */
const waitForHold = (point, sessionId) => until(
    () => fs.existsSync(path.join(releaseDir, `${point}.${sessionId}.held`)),
    `the ${point} hold was reached`,
    REPLY_TIMEOUT,
);
const actor = { kind: "user", provider: "dev", subject: "alice" };
const steer = (catalog, sessionId, text) => catalog.turnControlAdd(sessionId, "steer", text, randomUUID(), actor);
const stop = (catalog, sessionId) => catalog.turnControlAdd(sessionId, "stop", "Stopped by user", randomUUID(), actor);
const events = (catalog, sessionId, type) => catalog.getSessionEvents(sessionId).then((all) => all.filter((e) => e.eventType === type));

/** A session on one in-process worker with the default model, plus a catalog. */
async function withTurnControl(fn) {
    const env = getEnv();
    await withClient(env, {}, async (client, worker) => {
        const catalog = await createCatalog(env);
        try {
            await fn({ env, client, worker, catalog });
        } finally {
            await catalog.close?.();
        }
    });
}

/** The backend pid of the worker's LISTEN connection (test-only look inside the worker). */
const listenerPid = (worker) => worker._turnControlHub?.listener?.processID ?? null;

const MULTI_TOOL = (tag) => `Use the bash tool four separate times, one call each: run \`sleep 1 && echo ${tag}-1\`, then \`sleep 1 && echo ${tag}-2\`, then \`sleep 1 && echo ${tag}-3\`, then \`echo ${tag}-4\`. After the last call, reply with one short sentence.`;

describe.skipIf(!TURN_CONTROL_ORCHESTRATION)("turn control with the real CLI (design 7.3)", () => {
    it("a steer during a multi-tool turn is delivered before the next model call", { timeout: TIMEOUT }, async () => {
        await withTurnControl(async ({ client, catalog }) => {
            const session = await client.createSession();
            const sid = session.sessionId;
            await session.send(MULTI_TOOL("mt"));
            await waitForEventCount(catalog, sid, "tool.execution_start", 1, REPLY_TIMEOUT);
            const added = await steer(catalog, sid, "Also mention the word KIWI in your final sentence.");
            await session.wait(REPLY_TIMEOUT);
            assertEqual(await awaitOutcome(catalog, sid, added.seq, "multi-tool"), "delivered");
            const [confirmed] = (await events(catalog, sid, EV.steerConfirmed)).filter((e) => e.data.seq === added.seq);
            assert(confirmed, "the run confirmed the steer");
            const answers = await events(catalog, sid, "assistant.message");
            assert(answers.some((a) => a.seq > confirmed.seq), "a model call followed the confirmation");
            assertEqual((await events(catalog, sid, EV.steer)).length, 1, "the steer is in the transcript once");
        });
    });

    it("a steer during a long tool call is delivered after the tool ends", { timeout: TIMEOUT }, async () => {
        await withTurnControl(async ({ client, catalog }) => {
            const session = await client.createSession();
            const sid = session.sessionId;
            await session.send("Use the bash tool once to run `sleep 8 && echo long-done`. Then reply with one short sentence.");
            await waitForEventCount(catalog, sid, "tool.execution_start", 1, REPLY_TIMEOUT);
            const added = await steer(catalog, sid, "Also mention the word KIWI in your reply.");
            await session.wait(REPLY_TIMEOUT);
            assertEqual(await awaitOutcome(catalog, sid, added.seq, "long tool"), "delivered");
            const [confirmed] = (await events(catalog, sid, EV.steerConfirmed)).filter((e) => e.data.seq === added.seq);
            const [toolEnd] = await events(catalog, sid, "tool.execution_complete");
            assert(confirmed && toolEnd && confirmed.seq > toolEnd.seq, "confirmed after the tool ended");
        });
    });

    it("a late steer (after the final model call) is carried, runs in the next turn and is in the transcript once", { timeout: TIMEOUT }, async () => {
        await withTurnControl(async ({ client, catalog }) => {
            const session = await client.createSession();
            const sid = session.sessionId;
            armFaultHold("turn.control.before-writeback", sid);
            await session.send("Reply with the single word ALPHA.");
            await waitForEventCount(catalog, sid, "assistant.message", 1, REPLY_TIMEOUT);
            await waitForHold("turn.control.before-writeback", sid);
            const added = await steer(catalog, sid, "Reply with the single word BETA.");
            release("turn.control.before-writeback", sid);
            assertEqual(await awaitOutcome(catalog, sid, added.seq, "late"), "carried");
            const [closed] = await until(async () => {
                const found = (await events(catalog, sid, EV.carriedSteersClosed)).filter((e) => e.data.seqs.includes(added.seq));
                return found.length ? found : null;
            }, "the carried steer was closed", REPLY_TIMEOUT);
            assertEqual(closed.data.reason, "ran", "the next turn ran it");
            await waitForEventCount(catalog, sid, "assistant.message", 2, REPLY_TIMEOUT);
            assertEqual((await events(catalog, sid, EV.steer)).length, 1, "the steer is in the transcript once");
            const asUser = (await events(catalog, sid, "user.message")).filter((e) => JSON.stringify(e.data).includes("BETA"));
            assertEqual(asUser.length, 0, "the carried steer is not recorded again as a prompt");
        });
    });

    it("a Stop during a turn: stopped, no retry, the session is idle", { timeout: TIMEOUT }, async () => {
        await withTurnControl(async ({ client, catalog }) => {
            const session = await client.createSession();
            const sid = session.sessionId;
            await session.send("Use the bash tool once, in the foreground, to run `for i in 1 2 3 4 5 6; do echo working $i; sleep 10; done`. Then reply with one short sentence.");
            await waitForEventCount(catalog, sid, "tool.execution_start", 1, REPLY_TIMEOUT);
            const added = await stop(catalog, sid);
            assertEqual(await awaitOutcome(catalog, sid, added.seq, "stop"), "stopped");
            await until(async () => (await catalog.getSession(sid))?.state === "idle", "the session is idle", REPLY_TIMEOUT);
            assertEqual((await events(catalog, sid, "session.turn_started")).length, 1, "the turn was not retried");
            const next = await session.sendAndWait("Reply with the single word NEXT.", REPLY_TIMEOUT);
            assert(typeof next === "string" && next.length > 0, "the session takes the next prompt");
        });
    });

    it("a Stop with a pending steer ends the turn stopped and the steer not delivered", { timeout: TIMEOUT }, async () => {
        await withTurnControl(async ({ client, catalog }) => {
            const session = await client.createSession();
            const sid = session.sessionId;
            await session.send("Use the bash tool once, in the foreground, to run `for i in 1 2 3 4 5 6; do echo working $i; sleep 10; done`. Then reply with one short sentence.");
            await waitForEventCount(catalog, sid, "tool.execution_start", 1, REPLY_TIMEOUT);
            const pending = await steer(catalog, sid, "Mention KIWI in your reply.");
            const added = await stop(catalog, sid);
            assert(pending.seq && added.seq, "both controls were accepted");
            assertEqual(await awaitOutcome(catalog, sid, added.seq, "pending-steer stop"), "stopped");
            assertEqual(await awaitOutcome(catalog, sid, pending.seq, "pending steer"), "not_delivered");
            await until(async () => (await catalog.getSession(sid))?.state === "idle", "the session is idle", REPLY_TIMEOUT);
            assertEqual((await events(catalog, sid, "session.turn_started")).length, 1, "the turn was not retried");
        });
    });

    it("a Stop after a steer moved a long shell to the background ends the turn within 2 s and stops the shell", { timeout: TIMEOUT }, async () => {
        await withTurnControl(async ({ client, catalog }) => {
            const marker = `tcbg${randomUUID().replaceAll("-", "").slice(0, 12)}`;
            const alive = () => {
                try { return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim().length > 0; } catch { return false; }
            };
            const session = await client.createSession();
            const sid = session.sessionId;
            await session.send(`Use the bash tool once, in the foreground (not in the background), to run \`for i in 1 2 3 4 5 6; do echo ${marker} $i; sleep 10; done\`. Then reply with one short sentence.`);
            await waitForEventCount(catalog, sid, "tool.execution_start", 1, REPLY_TIMEOUT);
            const steered = await steer(catalog, sid, "Also mention the word KIWI in your reply.");
            // The CLI takes an immediate message during a sync shell by moving
            // the shell to the background; the model then answers while the
            // shell keeps running and the turn stays open.
            await until(async () => (await events(catalog, sid, EV.steerConfirmed)).some((e) => e.data.seq === steered.seq), "the steer was confirmed", REPLY_TIMEOUT);
            const confirmedAt = Math.max(...(await events(catalog, sid, EV.steerConfirmed)).map((e) => e.seq));
            await until(async () => (await events(catalog, sid, "assistant.message")).some((e) => e.seq > confirmedAt), "the model answered after the steer", REPLY_TIMEOUT);
            assert(alive(), "the backgrounded shell is still running");
            assertEqual((await catalog.getSession(sid))?.state, "running", "the turn is still open");

            const stoppedAt = Date.now();
            const added = await stop(catalog, sid);
            assertEqual(await awaitOutcome(catalog, sid, added.seq, "stop with a background shell"), "stopped");
            const ms = Date.now() - stoppedAt;
            console.log(`  stop with a background shell: outcome after ${ms} ms`);
            assert(ms <= 2_000, `the Stop ended the turn within 2 s (${ms} ms)`);
            await until(() => !alive(), "the shell is gone", 5_000);

            // The warm session is usable at once: the next prompt runs and
            // answers normally, without a busy error and without a new hydrate.
            await until(async () => (await catalog.getSession(sid))?.state === "idle", "the session is idle", REPLY_TIMEOUT);
            const hydratedBefore = (await events(catalog, sid, "session.hydrated")).length;
            const next = await session.sendAndWait("Reply with the single word NEXT.", REPLY_TIMEOUT);
            assert(typeof next === "string" && next.trim().length > 0, `the next turn answered (${next})`);
            assert(!/busy|already processing/i.test(next), `no busy error (${next})`);
            assertEqual((await events(catalog, sid, "session.hydrated")).length, hydratedBefore, "no extra hydrate");
            assertEqual((await catalog.getSession(sid))?.state, "idle", "the session is idle after the next turn");
        });
    });

    it("a Stop ends the commands the stopped turn started, not a background command from an earlier turn", { timeout: TIMEOUT }, async () => {
        await withTurnControl(async ({ client, catalog }) => {
            const tag = randomUUID().replaceAll("-", "").slice(0, 10);
            const earlier = `tcearly${tag}`;
            const current = `tcnow${tag}`;
            const alive = (marker) => {
                try { return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim().length > 0; } catch { return false; }
            };
            try {
                const session = await client.createSession();
                const sid = session.sessionId;
                await session.sendAndWait(`Call the bash tool exactly once with mode "async" and detach true to start \`sleep 300; echo ${earlier}\`. Do not wait for it. Then reply with the single word STARTED.`, REPLY_TIMEOUT);
                await until(() => alive(earlier), "turn 1 left a background command running", 15_000);

                await session.send(`Use the bash tool once, in the foreground (not in the background), to run \`for i in 1 2 3 4 5 6; do echo ${current} $i; sleep 10; done\`. Then reply with one short sentence.`);
                await until(() => alive(current), "turn 2 started its command", REPLY_TIMEOUT);
                const steered = await steer(catalog, sid, "Also mention the word KIWI in your reply.");
                await until(async () => (await events(catalog, sid, EV.steerConfirmed)).some((e) => e.data.seq === steered.seq), "the steer was confirmed", REPLY_TIMEOUT);

                const stoppedAt = Date.now();
                const added = await stop(catalog, sid);
                assertEqual(await awaitOutcome(catalog, sid, added.seq, "stop of turn 2"), "stopped");
                const ms = Date.now() - stoppedAt;
                assert(ms <= 2_000, `the Stop ended turn 2 within 2 s (${ms} ms)`);
                await until(() => !alive(current), "turn 2's command is gone", 5_000);
                assert(alive(earlier), "turn 1's background command still runs");
            } finally {
                try { execFileSync("pkill", ["-f", earlier]); } catch {}
                try { execFileSync("pkill", ["-f", current]); } catch {}
            }
        });
    });

    it("a Stop and a steer held before the initial send: no model run, the Stop ends stopped and the steer not delivered (P21)", { timeout: TIMEOUT }, async () => {
        await withTurnControl(async ({ client, catalog }) => {
            const session = await client.createSession();
            const sid = session.sessionId;
            armFaultHold("turn.control.before-send", sid);
            await session.send("Reply with the single word ALPHA.");
            await waitForHold("turn.control.before-send", sid);
            await until(async () => (await catalog.getSession(sid))?.turnHigh >= 0, "turn start ran");
            const pending = await steer(catalog, sid, "Reply with the single word BETA.");
            const added = await stop(catalog, sid);
            release("turn.control.before-send", sid);
            assertEqual(await awaitOutcome(catalog, sid, added.seq, "held stop"), "stopped");
            assertEqual(await awaitOutcome(catalog, sid, pending.seq, "held steer"), "not_delivered");
            assertEqual((await events(catalog, sid, "assistant.message")).length, 0, "the model never ran");
        });
    });

    it("a steer held before the initial send is delivered right after it (P21)", { timeout: TIMEOUT }, async () => {
        await withTurnControl(async ({ client, catalog }) => {
            const session = await client.createSession();
            const sid = session.sessionId;
            armFaultHold("turn.control.before-send", sid);
            await session.send(MULTI_TOOL("held"));
            await waitForHold("turn.control.before-send", sid);
            await until(async () => (await catalog.getSession(sid))?.turnHigh >= 0, "turn start ran");
            const added = await steer(catalog, sid, "Also mention the word KIWI in your final sentence.");
            release("turn.control.before-send", sid);
            await session.wait(REPLY_TIMEOUT);
            assertEqual(await awaitOutcome(catalog, sid, added.seq, "held steer"), "delivered");
        });
    });

    for (const point of ["turn.control.before-writeback", "turn.control.after-writeback"]) {
        it(`a steer racing the end-of-turn write (${point.split(".").pop()}) gets its serialized outcome`, { timeout: TIMEOUT }, async () => {
            await withTurnControl(async ({ client, catalog }) => {
                const session = await client.createSession();
                const sid = session.sessionId;
                armFaultHold(point, sid);
                await session.send("Reply with the single word ALPHA.");
                await waitForEventCount(catalog, sid, "assistant.message", 1, REPLY_TIMEOUT);
                await waitForHold(point, sid);
                const added = await steer(catalog, sid, "Reply with the single word BETA.");
                release(point, sid);
                if (point === "turn.control.after-writeback") {
                    // The end-of-turn write closed the turn under the row lock: the add came after it.
                    await session.wait(REPLY_TIMEOUT);
                    assertEqual(JSON.stringify(added), JSON.stringify({ refused: "no_turn" }), "writeback already closed the turn");
                    assertEqual((await events(catalog, sid, EV.steer)).length, 0, "no steer was recorded");
                    assertEqual((await events(catalog, sid, "assistant.message")).length, 1, "no carried turn ran");
                    return;
                }
                assert(added.seq, "the steer was accepted before the end-of-turn write");
                assertEqual(await awaitOutcome(catalog, sid, added.seq, point), "carried");
                await waitForEventCount(catalog, sid, "assistant.message", 2, REPLY_TIMEOUT);
                assertEqual((await outcomesOf(catalog, sid, added.seq)).length, 1, "one outcome");
            });
        });
    }

    it("a Stop when the turn already finished is too late; a late steer is not delivered (D5)", { timeout: TIMEOUT }, async () => {
        await withTurnControl(async ({ client, catalog }) => {
            const session = await client.createSession();
            const sid = session.sessionId;
            armFaultHold("turn.control.before-writeback", sid);
            await session.send("Reply with the single word ALPHA.");
            await waitForEventCount(catalog, sid, "assistant.message", 1, REPLY_TIMEOUT);
            await waitForHold("turn.control.before-writeback", sid);
            const late = await steer(catalog, sid, "Reply with the single word BETA.");
            const added = await stop(catalog, sid);
            release("turn.control.before-writeback", sid);
            assertEqual(await awaitOutcome(catalog, sid, added.seq, "too late"), "too_late");
            assertEqual(await awaitOutcome(catalog, sid, late.seq, "late steer"), "not_delivered");
        });
    });

    it("a turn without controls writes no outcome and saves no cursor", { timeout: TIMEOUT }, async () => {
        await withTurnControl(async ({ env, client, catalog }) => {
            const session = await client.createSession();
            const sid = session.sessionId;
            await session.sendAndWait("Reply with the single word ALPHA.", REPLY_TIMEOUT);
            assertEqual((await events(catalog, sid, EV.outcome)).length, 0);
            const commit = readTurnCommitFile(path.join(env.sessionStateDir, sid));
            assert(commit, "the turn was saved");
            assertEqual(commit.result?.controlCursor, undefined, "no cursor field");
        });
    });

    it("a lost notification (the LISTEN connection killed) still delivers the steer within the 5 s look", { timeout: TIMEOUT }, async () => {
        await withTurnControl(async ({ env, client, worker, catalog }) => {
            const admin = new pg.Client({ connectionString: env.store });
            await admin.connect();
            try {
                const session = await client.createSession();
                const sid = session.sessionId;
                await session.send(MULTI_TOOL("lost"));
                await waitForEventCount(catalog, sid, "tool.execution_start", 1, REPLY_TIMEOUT);
                const pid = listenerPid(worker);
                assert(pid, "the worker listens");
                await admin.query("SELECT pg_terminate_backend($1)", [pid]);
                const addedAt = Date.now();
                const added = await steer(catalog, sid, "Also mention the word KIWI in your final sentence.");
                const [confirmed] = await until(async () => {
                    const found = (await events(catalog, sid, EV.steerConfirmed)).filter((e) => e.data.seq === added.seq);
                    return found.length ? found : null;
                }, "the steer was confirmed", REPLY_TIMEOUT);
                const ms = Date.now() - addedAt;
                console.log(`  lost notification: steer confirmed ${ms} ms after it was accepted`);
                assert(confirmed, "confirmed");
                assert(ms <= 5_000 + 3_000, `delivered within the look interval plus one tool call (${ms} ms)`);
                await session.wait(REPLY_TIMEOUT);
                assertEqual(await awaitOutcome(catalog, sid, added.seq, "lost"), "delivered");
            } finally {
                await admin.end();
            }
        });
    });

    it("worker stop() closes the LISTEN connection", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const admin = new pg.Client({ connectionString: env.store });
        await admin.connect();
        try {
            const alive = async (pid) => (await admin.query(
                "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND application_name = 'pilotswarm-turn-control'", [pid],
            )).rowCount > 0;
            let pid = null;
            await withClient(env, {}, async (_client, worker) => {
                pid = listenerPid(worker);
                assert(pid, "the worker opened a LISTEN connection");
                assert(await alive(pid), "it is open while the worker runs");
            });
            await until(async () => !(await alive(pid)), "the LISTEN connection is closed after stop", 10_000);
        } finally {
            await admin.end();
        }
    });
});
