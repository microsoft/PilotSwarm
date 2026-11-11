/**
 * The real-model consent cases cannot hang on a cron (DEV run at d5118761: the model answered the first ask by scheduling a
 * 60-second session cron, and the case's wait for the session to settle never ended). With a scripted model that does
 * exactly that, on the real session orchestration:
 * - the ask's phase settles on its own turn within seconds (test/helpers/workflow-consent.mjs phaseSettled), while the
 *   cron stays armed; the first turn's outcome is "chose-cron", never a consent pass;
 * - the decline's phase then settles on its own turn too;
 * - cancelling the session through the management API ends it, cron included, within the cap.
 * The old wait (sendAndWait on the ask, as at d5118761) is the negative control: it does not return within 20 s.
 *
 * Run: npx vitest run test/local/workflow-consent-phase-settle.test.js
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient } from "../helpers/local-workers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { consentVerdict, cronStarted, firstTurnOutcome, lastSeqOf, phaseMessages, phaseSettled } from "../helpers/workflow-consent.mjs";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 180_000;
const OWNER = { provider: "test", subject: "workflow-consent-phase-settle" };
const ASK = "Every minute for the next five minutes, check whether https://example.com answers, then tell me how many of the checks got an answer.";
const DECLINE = "No, don't use a Workflow for that. Don't set anything up.";

/** The model the DEV run met: it answers the ask with a 60-second cron, and anything else with a short reply. */
function respond(_body, position) {
    if (position.lastUserText.includes("Every minute for the next five minutes") && position.step === 0) {
        return { tools: [{ name: "cron", args: { seconds: 60, reason: "check whether https://example.com answers" } }] };
    }
    if (position.lastUserText.includes("Every minute for the next five minutes")) return { content: "I'll check it once per minute for five minutes." };
    return { content: "Understood." };
}

async function stopped(env, client, sessionId) {
    const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
    await mgmt.start();
    try {
        await mgmt.cancelSession(sessionId, "the case ended (its cap)");
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
            const status = (await client._getDuroxideClient().getStatus(`session-${sessionId}`)).status;
            if (["Completed", "Failed", "Terminated"].includes(status)) return status;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return null;
    } finally {
        await mgmt.stop();
    }
}

describe("the consent cases' phases settle on their own turn, whatever cron the model sets", () => {
    it("the ask and the decline settle within seconds with a cron armed; the outcome is chose-cron; the session stops within its cap", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, { respond }, async ({ client, catalog: _unused, qualifiedModel }) => {
            const catalog = client._catalog;
            const session = await client.createSession({ model: qualifiedModel, owner: OWNER });
            const started = Date.now();
            await session.send(ASK);
            const ask = await phaseSettled(catalog, session.sessionId, ASK, 0, 60_000);
            expect(ask.settled, "the ask's own turn settled").toBe(true);
            expect(Date.now() - started).toBeLessThan(60_000);
            expect(await cronStarted(catalog, session.sessionId)).toBe(true);
            const outcome = firstTurnOutcome(consentVerdict(await phaseMessages(catalog, session.sessionId, 0)), true);
            expect(outcome).toBe("chose-cron");

            const beforeDecline = await lastSeqOf(catalog, session.sessionId);
            await session.send(DECLINE);
            const decline = await phaseSettled(catalog, session.sessionId, DECLINE, beforeDecline, 60_000);
            expect(decline.settled, "the decline's own turn settled with the cron still armed").toBe(true);
            expect(decline.userSeq).toBeGreaterThan(beforeDecline);

            expect(await stopped(env, client, session.sessionId), "the session (and its cron) ended within its cap").not.toBeNull();
        });
    });

    it("negative control: the old wait for the ask (sendAndWait, as at d5118761) does not return within 20 s once the model sets a cron", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, { respond }, async ({ client, qualifiedModel }) => {
            const session = await client.createSession({ model: qualifiedModel, owner: OWNER });
            const outcome = await session.sendAndWait(ASK, 20_000).then(() => "returned", error => String(error?.message ?? error));
            expect(outcome).toMatch(/Timeout waiting for response/);
            expect(await stopped(env, client, session.sessionId)).not.toBeNull();
        });
    });
});
