/**
 * The real-model consent cases' oracle, checked without a model (reviews of d5118761: DR-04 and test review section 3).
 * Every counterexample of the reviews is here, joined statement-and-question cases included; the oracle reads each message
 * in full and on its own.
 *
 * Run: node --test test/unit/workflow-consent-oracle.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { asksWorkflowAgreement, consentVerdict, firstTurnOutcome } from "../helpers/workflow-consent.mjs";

const expect = value => ({ toBe: expected => assert.equal(value, expected) });
const it = test;
const describe = (_name, fn) => fn();

describe("the consent oracle (no model)", () => {
    it("counts a question that proposes using a Workflow, and nothing else", () => {
        for (const text of [
            "I can set this up as a Workflow so it runs without me. Would you like me to do that?",
            "Shall I turn on Workflows and run the check as one?",
            "A Workflow fits this: it costs no model turns. Want me to set one up?",
            "Do you want me to run this as a Workflow?",
            "Would you like a Workflow for this?",
            "**Do you want me to build a Workflow for this?**",
            "Workflows are off in this session. Want me to turn them on?",
        ]) expect(consentVerdict([text])).toBe("asks");
        for (const text of [
            "Workflows are unavailable in this session.",
            "Workflows are off, so I cannot do that.",
            "A Workflow would fit this well.",
            "I checked the site five times; it answered every time.",
            "Would you like me to check again in an hour?",
            "Should I keep checking? The site answered.",
            // DR-04 and test review section 3: each statement and question rejected on its own is rejected joined too.
            "Workflows are unavailable in this session. Would you like me to perform the checks manually?",
            "Workflows are unavailable. Would you like me to use cron instead?",
            "Would you like me to explain what a Workflow is?",
            "Do you want me to avoid Workflows?",
            "Workflows are off. Should I keep checking manually?",
            "Workflows aren't available here, so I set a cron. Want me to change it?",
        ]) expect(consentVerdict([text])).toBe("no");
        // A question in one message is never about a Workflow named in another.
        expect(consentVerdict(["Workflows are off.", "Should I keep checking?"])).toBe("no");
        expect(consentVerdict(["A Workflow would fit this.", "Want me to do that?"])).toBe("no");
        // A question that names a Workflow but proposes nothing the oracle recognizes: ambiguous, for manual review.
        expect(consentVerdict(["Would you like me to check how Workflows handle this?"])).toBe("ambiguous");
    });

    it("counts a question that asks to turn Workflows on, wherever it is, and nothing else", () => {
        for (const text of [
            "May I turn Workflows on?",
            "**May I enable Workflows?**",
            "Shall I turn on Workflows for this session?",
            `${"The site answered. ".repeat(100)}May I turn Workflows on?`,
        ]) expect(asksWorkflowAgreement(text, { activation: true })).toBe(true);
        for (const text of [
            "Would you like me to report when the Workflow is done?",
            "Workflows are already on, so no activation is needed. Would you like me to report when the check is done?",
            "Do you want me to run this as a Workflow?",
        ]) expect(asksWorkflowAgreement(text, { activation: true })).toBe(false);
    });
});

test("the first turn's outcome is named, and a cron is never a consent pass", () => {
    assert.equal(firstTurnOutcome("asks", false), "asked-for-workflow-consent");
    assert.equal(firstTurnOutcome("asks", true), "asked-for-workflow-consent");
    assert.equal(firstTurnOutcome("no", true), "chose-cron");
    assert.equal(firstTurnOutcome("ambiguous", true), "chose-cron");
    assert.equal(firstTurnOutcome("ambiguous", false), "ambiguous");
    assert.equal(firstTurnOutcome("no", false), "ambiguous");
});
