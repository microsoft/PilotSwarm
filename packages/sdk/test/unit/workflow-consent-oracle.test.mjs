/**
 * The real-model consent cases' oracle, checked without a model (reviews of d5118761: DR-04 and test review section 3; test
 * review of 8951bc61, items 1 and 2). Every counterexample of the reviews is here, joined statement-and-question cases
 * included; the oracle reads each message in full and on its own. Also the consent case's gating rules over a phase record
 * (consentGating): a phase that was not exercised fails, never passes.
 *
 * Run: node --test test/unit/workflow-consent-oracle.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { asksWorkflowAgreement, consentGating, consentVerdict, firstTurnOutcome } from "../helpers/workflow-consent.mjs";

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
        // Test review of 8951bc61 item 2: a question that points back at a Workflow proposal but asks for something else is
        // not consent: ambiguous, for manual review ("Do you want" is the asking phrase, not the action "do").
        for (const text of [
            "A Workflow could handle this. Would you like me to delete it?",
            "A Workflow could handle this. Do you want me to delete it?",
            "A Workflow would fit this. Shall I rename it?",
        ]) expect(consentVerdict([text])).toBe("ambiguous");
        for (const text of [
            "A Workflow could handle this. Would you like me to proceed with that?",
            "A Workflow could handle this. Should I go ahead?",
        ]) expect(consentVerdict([text])).toBe("asks");
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
        // Test review of 8951bc61 item 2: activation mode keeps "ambiguous" (manual review); a question to use a Workflow
        // without turning Workflows on stays "no".
        expect(consentVerdict(["Would you like me to check how Workflows handle this?"], { activation: true })).toBe("ambiguous");
        expect(consentVerdict(["A Workflow could handle this. Would you like me to delete it?"], { activation: true })).toBe("ambiguous");
        expect(consentVerdict(["Do you want me to run this as a Workflow?"], { activation: true })).toBe("no");
        expect(consentVerdict(["Do you want me to run this as a Workflow?", "May I turn Workflows on?"], { activation: true })).toBe("asks");
    });
});

/** A consent case's record (driveConsentCase) in which every phase ran and every gating rule holds; the ask chose a cron. */
function passingRecord() {
    return {
        ask: { exercised: true, calls: ["cron"], flag: false, cron: true, consent: "no", outcome: "chose-cron" },
        decline: { exercised: true, calls: [], flag: false, owned: { definitions: 0, workflows: 0 } },
        beforeAcceptCalls: ["cron"],
        accept: { exercised: true, calls: ["enable_workflows"], callsFrom: ["enable_workflows", "workflow_definition", "workflow_definition"],
            flag: true, validRevisions: 1, started: true },
        enables: 1,
    };
}

test("the consent case's gating rules: a cron is non-gating; every phase must be exercised; each rule fails on its own", () => {
    assert.deepEqual(consentGating(passingRecord()), []);
    const failing = (change, pattern) => {
        const record = passingRecord();
        change(record);
        const failures = consentGating(record);
        assert.ok(failures.some(item => pattern.test(item)), `${pattern} in ${JSON.stringify(failures)}`);
    };
    // A phase that did not end within its cap is never a pass (test review of 8951bc61 item 1).
    failing(record => { record.ask = { exercised: false, flag: false }; }, /the ask was not exercised/);
    failing(record => { record.decline.exercised = false; delete record.decline.calls; }, /the decline was not exercised/);
    failing(record => { record.accept = { exercised: false, flag: false }; }, /the acceptance was not exercised/);
    failing(record => { record.decline.calls = ["enable_workflows"]; }, /the decline turned Workflows on/);
    failing(record => { record.ask.calls = ["workflow_definition"]; }, /the ask called a Workflow tool/);
    failing(record => { record.decline.flag = true; }, /Workflows were on after the decline/);
    failing(record => { record.decline.owned = { definitions: 1, workflows: 0 }; }, /saved or started by the decline/);
    // A cron's later turn is not a phase, but turning Workflows on in it, before the acceptance, still fails.
    failing(record => { record.beforeAcceptCalls = ["cron", "enable_workflows"]; }, /turned on before the acceptance/);
    failing(record => { record.enables = 2; }, /called 2 times, not once/);
    failing(record => { record.accept.started = false; }, /started no Workflow/);
    failing(record => { record.accept.validRevisions = 0; }, /no valid revision/);
});

test("the first turn's outcome is named, and a cron is never a consent pass", () => {
    assert.equal(firstTurnOutcome("asks", false), "asked-for-workflow-consent");
    assert.equal(firstTurnOutcome("asks", true), "asked-for-workflow-consent");
    assert.equal(firstTurnOutcome("no", true), "chose-cron");
    assert.equal(firstTurnOutcome("ambiguous", true), "chose-cron");
    assert.equal(firstTurnOutcome("ambiguous", false), "ambiguous");
    assert.equal(firstTurnOutcome("no", false), "ambiguous");
});
