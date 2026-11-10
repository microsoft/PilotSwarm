/**
 * FU-20 (review UI2-F2), on PostgreSQL: a second device's older whole-profile save cannot erase what this person has
 * already seen. setUserProfileSettings merges the stored "seen" receipts (canvasPrefs' lastViewedRev, lastViewedDataRev and
 * lastViewedWorkflowAt) by MAX under a lock on the person's row; an entry the older save leaves out is kept while its
 * session exists, and dropped once it is deleted; every other setting is the writer's. Unit side:
 * test/unit/profile-receipts.test.mjs.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { PgSessionCatalogProvider } from "../../src/index.ts";
import { useSuiteEnv } from "../helpers/local-env.js";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);

describe("profile receipts (FU-20)", () => {
    it("an older whole-profile save keeps the newer receipts; other settings are the writer's; a deleted session's entry goes", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const principal = { provider: "test", subject: `receipts-${randomUUID()}` };
            const session = randomUUID();
            const other = randomUUID();
            await catalog.createSession(session, { owner: principal });
            await catalog.createSession(other, { owner: principal });
            // Both devices read this.
            const first = { themeId: "dark", canvasPrefs: { [session]: { optedOut: false, lastViewedRev: 1, lastViewedDataRev: 0, lastViewedWorkflowAt: 1_000 } } };
            await catalog.setUserProfileSettings(principal, first);
            // Device A sees a failure (and a canvas revision) and saves; it also has an entry for another session.
            await catalog.setUserProfileSettings(principal, { themeId: "dark", canvasPrefs: {
                [session]: { optedOut: false, lastViewedRev: 4, lastViewedDataRev: 2, lastViewedWorkflowAt: 5_000 },
                [other]: { optedOut: false, lastViewedRev: 3, lastViewedDataRev: 0 },
            } });
            // Device B, which read `first`, saves its whole profile with a new theme.
            const saved = await catalog.setUserProfileSettings(principal, { ...first, themeId: "light" });
            expect(saved.profileSettings.themeId).toBe("light");
            expect(saved.profileSettings.canvasPrefs[session]).toEqual({ optedOut: false, lastViewedRev: 4, lastViewedDataRev: 2, lastViewedWorkflowAt: 5_000 });
            expect(saved.profileSettings.canvasPrefs[other]).toEqual({ optedOut: false, lastViewedRev: 3, lastViewedDataRev: 0 });
            // Once the other session is deleted, a save that leaves its entry out drops it.
            await catalog.softDeleteSession(other);
            const after = await catalog.setUserProfileSettings(principal, { ...first, themeId: "light" });
            expect(after.profileSettings.canvasPrefs[other]).toBeUndefined();
            expect(after.profileSettings.canvasPrefs[session].lastViewedWorkflowAt).toBe(5_000);
            // A write without canvasPrefs is stored as written (an older client).
            const plain = await catalog.setUserProfileSettings(principal, { themeId: "plain" });
            expect(plain.profileSettings).toEqual({ themeId: "plain" });
        } finally {
            await catalog.close();
        }
    });

    it("two saves at the same moment: neither loses the other's newer receipt", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const principal = { provider: "test", subject: `receipts-race-${randomUUID()}` };
            const a = randomUUID();
            const b = randomUUID();
            for (const id of [a, b]) await catalog.createSession(id, { owner: principal });
            await catalog.setUserProfileSettings(principal, { canvasPrefs: { [a]: { optedOut: false, lastViewedRev: 1, lastViewedDataRev: 0 },
                [b]: { optedOut: false, lastViewedRev: 1, lastViewedDataRev: 0 } } });
            for (let round = 2; round < 7; round += 1) {
                await Promise.all([
                    catalog.setUserProfileSettings(principal, { canvasPrefs: { [a]: { optedOut: false, lastViewedRev: round * 10, lastViewedDataRev: 0 },
                        [b]: { optedOut: false, lastViewedRev: 1, lastViewedDataRev: 0 } } }),
                    catalog.setUserProfileSettings(principal, { canvasPrefs: { [a]: { optedOut: false, lastViewedRev: 1, lastViewedDataRev: 0 },
                        [b]: { optedOut: false, lastViewedRev: round * 10, lastViewedDataRev: 0 } } }),
                ]);
                const profile = await catalog.getUserProfile(principal);
                expect(profile.profileSettings.canvasPrefs[a].lastViewedRev, `round ${round}`).toBe(round * 10);
                expect(profile.profileSettings.canvasPrefs[b].lastViewedRev, `round ${round}`).toBe(round * 10);
            }
        } finally {
            await catalog.close();
        }
    });
});
