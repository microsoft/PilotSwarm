/**
 * Stage 2.4 (PR 235 955856f9): a wait state's `at` (the cron_at fields), DB-less. Compiled only where clock waits are
 * enabled (controller 1.9.0), to IR 10; refused otherwise, and refused with seconds, with a bad zone, an unknown field,
 * a day without an hour, or both day fields. The stored IR reads back only for a reader that asks for version 10. Its
 * words, and the graph's description of it.
 *
 * Run: node --test test/unit/workflow-clock-wait.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    compileWorkflowV2, parseWorkflowIr, WORKFLOW_V2_CLOCK_WAIT_IR_VERSION, WORKFLOW_V2_MILESTONE_IR_VERSION, WORKFLOW_V2_RUNNABLE_IR_VERSION,
    workflowV2ClockWaitWords,
} from "../../dist/workflow/v2/compiler.js";
import { describeWorkflowV2State } from "../../dist/workflow/v2/runtime.js";

const ON = { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true, enableClockWaits: true };
const yaml = wait => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: morning, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, ${wait}, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;
const errors = result => result.diagnostics.filter(item => item.severity === "error").map(item => [item.code, item.path]);

test("a clock wait compiles to IR 10 where enabled, with its time; a seconds wait stays IR 4", () => {
    const result = compileWorkflowV2(yaml("at: { minute: 0, hour: 9, tz: America/Los_Angeles }"), ON);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
    assert.equal(result.ir.irVersion, WORKFLOW_V2_CLOCK_WAIT_IR_VERSION);
    // The milestone reads clock waits (IR 10); named branches (IR 11, owner 2026-11-08) made it the newer one.
    assert.ok(WORKFLOW_V2_MILESTONE_IR_VERSION >= 10);
    assert.deepEqual(result.ir.nodes.hold.at, { minute: 0, hour: 9, tz: "America/Los_Angeles" });
    assert.equal(result.ir.nodes.hold.seconds, null);
    for (const [at, want] of [
        ["{ minute: 30, tz: UTC }", { minute: 30, tz: "UTC" }],
        ["{ minute: 30, hour: 6, day_of_week: 1, tz: Europe/Paris }", { minute: 30, hour: 6, dayOfWeek: 1, tz: "Europe/Paris" }],
        ["{ minute: 0, hour: 0, day_of_month: 1, tz: Asia/Tokyo }", { minute: 0, hour: 0, dayOfMonth: 1, tz: "Asia/Tokyo" }],
    ]) {
        const compiled = compileWorkflowV2(yaml(`at: ${at}`), ON);
        assert.equal(compiled.valid, true, `${at}: ${JSON.stringify(compiled.diagnostics)}`);
        assert.deepEqual(compiled.ir.nodes.hold.at, want);
    }
    const plain = compileWorkflowV2(yaml("seconds: 30"), ON);
    assert.equal(plain.ir.irVersion, 4);
    assert.equal(Object.hasOwn(plain.ir.nodes.hold, "at"), false);
});

test("a clock wait is refused where not enabled, with seconds, and when its fields break the cron_at rules", () => {
    assert.deepEqual(errors(compileWorkflowV2(yaml("at: { minute: 0, hour: 9, tz: UTC }"))), [["WORKFLOW_FEATURE_UNSUPPORTED", "states.hold.at"]]);
    for (const [wait, want] of [
        ["seconds: 30, at: { minute: 0, tz: UTC }", ["WORKFLOW_FIELD_INVALID", "states.hold"]],
        ["at: { minute: 0, hour: 9, tz: Mars/Olympus }", ["WORKFLOW_FIELD_INVALID", "states.hold.at.tz"]],
        ["at: { minute: 0, hour: 9 }", ["WORKFLOW_FIELD_INVALID", "states.hold.at"]],
        ["at: { minute: 60, tz: UTC }", ["WORKFLOW_FIELD_INVALID", "states.hold.at"]],
        ["at: { minute: 0, day_of_week: 1, tz: UTC }", ["WORKFLOW_FIELD_INVALID", "states.hold.at"]],
        ["at: { minute: 0, hour: 1, day_of_week: 1, day_of_month: 2, tz: UTC }", ["WORKFLOW_FIELD_INVALID", "states.hold.at"]],
        ["at: { minute: 0, tz: UTC, reason: x }", ["WORKFLOW_FIELD_UNKNOWN", "states.hold.at.reason"]],
        ["at: { minute: \"${kv.m}\", tz: UTC }", ["WORKFLOW_FIELD_INVALID", "states.hold.at.minute"]],
        ["at: 9", ["WORKFLOW_FIELD_INVALID", "states.hold.at"]],
    ]) {
        const result = compileWorkflowV2(yaml(wait), ON);
        assert.equal(result.valid, false, wait);
        assert.ok(errors(result).some(([code, path]) => code === want[0] && path === want[1]), `${wait}: ${JSON.stringify(errors(result))}`);
    }
    const words = compileWorkflowV2(yaml("at: { minute: 0, day_of_week: 1, tz: UTC }"), ON).diagnostics.find(item => item.path === "states.hold.at");
    assert.match(words.message, /^at 'day_of_week' \/ 'day_of_month' require 'hour'\.$/);
});

test("stored IR 10 reads back only for a reader that asks for it; its at is checked", () => {
    const { ir } = compileWorkflowV2(yaml("at: { minute: 0, hour: 9, tz: UTC }"), ON);
    const stored = JSON.parse(JSON.stringify(ir));
    assert.deepEqual(parseWorkflowIr(stored, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION }).nodes.hold.at, { minute: 0, hour: 9, tz: "UTC" });
    assert.throws(() => parseWorkflowIr(stored, { maxIrVersion: 9 }), /IR version 10 is not supported/);
    assert.throws(() => parseWorkflowIr(stored, { maxIrVersion: WORKFLOW_V2_RUNNABLE_IR_VERSION }), /IR version 10 is not supported/);
    const bad = JSON.parse(JSON.stringify(stored));
    bad.nodes.hold.at.tz = "Nowhere/Else";
    assert.throws(() => parseWorkflowIr(bad, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION }), /stored IR wait hold is invalid/);
    const both = JSON.parse(JSON.stringify(stored));
    both.nodes.hold.seconds = 30;
    assert.throws(() => parseWorkflowIr(both, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION }), /stored IR wait hold is invalid/);
});

test("its words, and the graph's description of it", () => {
    assert.equal(workflowV2ClockWaitWords({ minute: 0, hour: 9, tz: "America/Los_Angeles" }), "the next 09:00 (America/Los_Angeles)");
    assert.equal(workflowV2ClockWaitWords({ minute: 30, tz: "UTC" }), ":30 past the next hour (UTC)");
    assert.equal(workflowV2ClockWaitWords({ minute: 5, hour: 6, dayOfWeek: 1, tz: "Europe/Paris" }), "the next Monday 06:05 (Europe/Paris)");
    assert.equal(workflowV2ClockWaitWords({ minute: 0, hour: 0, dayOfMonth: 1, tz: "UTC" }), "the next day 1 of a month, 00:00 (UTC)");
    const { ir } = compileWorkflowV2(yaml("at: { minute: 0, hour: 9, tz: UTC }"), ON);
    assert.deepEqual(describeWorkflowV2State(ir.nodes.hold), { id: "hold", type: "wait", seconds: null, at: { minute: 0, hour: 9, tz: "UTC" },
        until: "the next 09:00 (UTC)", outcomes: ["elapsed"], next: { elapsed: "done" } });
});

test("agents on a host that runs clock waits are told of them; others are not", async () => {
    const { workflowSessionGuidance, WORKFLOW_CLOCK_WAIT_GUIDANCE } = await import("../../dist/workflow/guidance.js");
    assert.ok(workflowSessionGuidance(false, { clockWaits: true }).endsWith(WORKFLOW_CLOCK_WAIT_GUIDANCE));
    assert.ok(!workflowSessionGuidance(false).includes(WORKFLOW_CLOCK_WAIT_GUIDANCE));
    assert.equal(workflowSessionGuidance(false, { clockWaits: false }), workflowSessionGuidance(false));
    assert.match(WORKFLOW_CLOCK_WAIT_GUIDANCE, /at: \{ minute: 0, hour: 9, tz: America\/Los_Angeles \}/);
    // The field itself is in the reference skill (owner 2026-11-08T16:55Z: declarations carry their contract only).
    const fs = await import("node:fs");
    const reference = fs.readFileSync(new URL("../../plugins/workflow-v2/skills/workflow-reference/SKILL.md", import.meta.url), "utf8");
    assert.match(reference, /\| `at` \| Instead of `seconds`: `\{ minute, hour\?, day_of_week\? \(0-6, Sunday 0\) or day_of_month\? \(1-31\), tz \}`/);
});
