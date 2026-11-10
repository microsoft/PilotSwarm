/**
 * FU-20 (review UI2-F2): the profile's "seen" receipts survive a stale whole-profile save. Pure merge rules here; the
 * write under a row lock, with a real second-device save, is test/local/profile-receipts.test.js.
 *
 * Run: node --test test/unit/profile-receipts.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PROFILE_RECEIPT_FIELDS, mergeProfileReceipts, profileReceiptOmittedSessions, profileReceiptSessionId } from "../../dist/profile-receipts.js";

test("each receipt is the larger of the stored and the written value; every other field is the writer's", () => {
    assert.deepEqual([...PROFILE_RECEIPT_FIELDS], ["lastViewedRev", "lastViewedDataRev", "lastViewedWorkflowAt"]);
    const stored = { themeId: "dark", canvasPrefs: { a: { optedOut: false, lastViewedRev: 7, lastViewedDataRev: 3, lastViewedWorkflowAt: 2_000 } } };
    const written = { themeId: "light", canvasPrefs: { a: { optedOut: true, lastViewedRev: 5, lastViewedDataRev: 4, zenRailPx: 400 } } };
    assert.deepEqual(mergeProfileReceipts(stored, written), {
        themeId: "light",
        canvasPrefs: { a: { optedOut: true, lastViewedRev: 7, lastViewedDataRev: 4, zenRailPx: 400, lastViewedWorkflowAt: 2_000 } },
    });
    assert.equal(written.canvasPrefs.a.lastViewedRev, 5, "the written document is not changed");
    // A newer write wins as it is (and is returned as the same object when nothing was raised).
    const newer = { canvasPrefs: { a: { optedOut: false, lastViewedRev: 9, lastViewedDataRev: 3, lastViewedWorkflowAt: 2_500 } } };
    assert.equal(mergeProfileReceipts(stored, newer), newer);
});

test("the Workflow dot's receipt: a second device's older save does not bring an old failure's dot back", () => {
    // Device A saw a failure at t=5,000 and saved; device B, which read the profile before that, saves its receipt of 1,000.
    const stored = { canvasPrefs: { owner1: { optedOut: false, lastViewedRev: 0, lastViewedDataRev: 0, lastViewedWorkflowAt: 5_000 } } };
    const fromB = { canvasPrefs: { owner1: { optedOut: false, lastViewedRev: 0, lastViewedDataRev: 0, lastViewedWorkflowAt: 1_000 } } };
    assert.equal(mergeProfileReceipts(stored, fromB).canvasPrefs.owner1.lastViewedWorkflowAt, 5_000);
});

test("a stored entry the write leaves out is kept only when it holds a receipt and its session still exists", () => {
    const stored = { canvasPrefs: {
        live: { optedOut: false, lastViewedRev: 3, lastViewedDataRev: 0 },
        "live#2": { optedOut: false, lastViewedRev: 1, lastViewedDataRev: 0 },
        gone: { optedOut: false, lastViewedRev: 4, lastViewedDataRev: 0 },
        empty: { optedOut: true, lastViewedRev: 0, lastViewedDataRev: 0 },
    } };
    const written = { canvasPrefs: { other: { optedOut: false, lastViewedRev: 1, lastViewedDataRev: 0 } } };
    assert.deepEqual(profileReceiptOmittedSessions(stored, written).sort(), ["gone", "live"]);
    const merged = mergeProfileReceipts(stored, written, id => id === "live");
    assert.deepEqual(Object.keys(merged.canvasPrefs).sort(), ["live", "live#2", "other"]);
    // Nothing kept: the write as it is.
    assert.equal(mergeProfileReceipts(stored, written), written, "no session is live by default");
});

test("a write or a store without a canvasPrefs map is stored as written; malformed values count as no receipt", () => {
    const written = { themeId: "x" };
    assert.equal(mergeProfileReceipts({ canvasPrefs: { a: { lastViewedRev: 9 } } }, written), written);
    assert.equal(mergeProfileReceipts(null, { canvasPrefs: {} }).canvasPrefs !== undefined, true);
    const stored = { canvasPrefs: { a: { lastViewedRev: "9", lastViewedDataRev: -1, lastViewedWorkflowAt: Number.NaN } } };
    const write = { canvasPrefs: { a: { lastViewedRev: 2 } } };
    assert.equal(mergeProfileReceipts(stored, write), write);
    assert.deepEqual(profileReceiptOmittedSessions(stored, { canvasPrefs: {} }), []);
    assert.equal(profileReceiptSessionId("abc#3"), "abc");
    assert.equal(profileReceiptSessionId("abc#1"), "abc#1", "slot 1 has no suffix; #1 is part of an id");
    assert.equal(profileReceiptSessionId("abc"), "abc");
});
