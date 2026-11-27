/**
 * Pure unit tests for Workflow Re-run picker, compatibility rules (C1..C9 & Spec §8.2),
 * deterministic ID/scope mapper, 3-generation origin flattening, resume builder,
 * all 12 warnings (Spec §7.2), and plan builder — no database.
 *
 * Run: node --test test/unit/workflow-rerun-plan.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow } from "../../dist/workflow/compiler.js";
import { CATCH_ALL_ROUTE, branchScopeId } from "../../dist/workflow/controller/runtime.js";
import { nodeExecutionIdFor } from "../../dist/workflow/store.js";
import {
    WORKFLOW_RERUN_MAX_COPY_BYTES,
    WorkflowRerunError,
    flattenRerunOrigin,
    pickRerunTarget,
    partitionRerunVisits,
    mapRerunExecutions,
    checkRerunCompatibility,
    buildRerunWarnings,
    buildRerunResume,
    buildRerunPlan,
} from "../../dist/workflow/rerun.js";

function mustCompile(yaml) {
    const res = compileWorkflow(yaml);
    assert.equal(res.valid, true, JSON.stringify(res.diagnostics));
    return res;
}

function makeKey(overrides) {
    const runId = overrides.runId ?? "run-src";
    const scopeId = overrides.scopeId ?? "root";
    const nodeId = overrides.nodeId ?? "build";
    const ordinal = overrides.ordinal ?? 1;
    const nodeExecutionId = overrides.nodeExecutionId ?? nodeExecutionIdFor(runId, scopeId, nodeId, ordinal);
    return {
        nodeExecutionId,
        runId,
        scopeId,
        nodeId,
        ordinal,
        nodeType: "script",
        predecessorId: null,
        arrivalRoute: null,
        state: "completed",
        outcome: "ok",
        resultKind: "business",
        winner: "effect",
        kvRevision: 1,
        enteredAt: new Date("2026-11-26T10:00:00Z"),
        completedAt: new Date("2026-11-26T10:01:00Z"),
        inputSha256: `in-${nodeId}-${ordinal}`,
        carrySha256: null,
        hasCarry: false,
        byteLength: 1024,
        reusedFromExecutionId: null,
        reusedFromRunId: null,
        reusedFromWorkflowSessionId: null,
        spawnChildWorkflowId: null,
        ...overrides,
    };
}

function chainKeys(specs, runId = "run-src") {
    const out = [];
    let prev = null;
    for (let i = 0; i < specs.length; i += 1) {
        const s = specs[i];
        const k = makeKey({
            runId,
            predecessorId: prev ? prev.nodeExecutionId : null,
            enteredAt: new Date(Date.parse("2026-11-26T10:00:00Z") + i * 60_000),
            completedAt: new Date(Date.parse("2026-11-26T10:00:30Z") + i * 60_000),
            ...s,
        });
        out.push(k);
        prev = k;
    }
    return out;
}

const SPEC_82_BASE_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: spec82, version: "1.0.0" }
limits: { maxNodeExecutions: 50 }
initial: build
states:
  build:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: review } }
  review:
    type: agent
    session: continue
    invoke: { prompt: "Review v1." }
    outcomes: [changes, approved]
    timeoutSeconds: 120
    transition: { next: { changes: fix, approved: finish } }
  fix:
    type: agent
    invoke: { prompt: "Fix v1." }
    outcomes: [ok]
    timeoutSeconds: 120
    transition: { next: { ok: review } }
  finish:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

test("constants: WORKFLOW_RERUN_MAX_COPY_BYTES is 256 MiB", () => {
    assert.equal(WORKFLOW_RERUN_MAX_COPY_BYTES, 256 * 1024 * 1024);
});

test("pickRerunTarget: covers all 6 auto-pick rows and all refusal reasons", () => {
    // 1. Unrouted step error (top-level)
    const keys1 = chainKeys([
        { nodeId: "build", ordinal: 1, outcome: "ok" },
        { nodeId: "finish", ordinal: 1, arrivalRoute: "ok", outcome: "execution_failed", resultKind: "runtime_error" },
    ]);
    const p1 = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "execution_failed", details: { nodeExecutionId: keys1[1].nodeExecutionId } } },
        keys1,
    );
    assert.equal(p1.chosen.nodeExecutionId, keys1[1].nodeExecutionId);
    assert.equal(p1.mode, "run_again");
    assert.equal(p1.picked, "failed_visit");

    // 1b. Unrouted step error inside a parallel lane -> lifts to enclosing parallel visit
    const pVisit = makeKey({ nodeId: "fanout", ordinal: 1, nodeType: "parallel", predecessorId: keys1[0].nodeExecutionId, arrivalRoute: "ok", outcome: "blocked", resultKind: "business" });
    const laneVisit = makeKey({ scopeId: branchScopeId(pVisit.nodeExecutionId, 0), nodeId: "worker", ordinal: 1, predecessorId: pVisit.nodeExecutionId, arrivalRoute: "@branch", outcome: "execution_failed", resultKind: "runtime_error" });
    const p1b = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "execution_failed", details: { nodeExecutionId: laneVisit.nodeExecutionId } } },
        [keys1[0], pVisit, laneVisit],
    );
    assert.equal(p1b.chosen.nodeExecutionId, pVisit.nodeExecutionId);
    assert.equal(p1b.mode, "run_again");
    assert.equal(p1b.picked, "failed_visit");

    // 1c. Unrouted error on the 1st visit of the run -> refuses first_visit
    assert.throws(
        () => pickRerunTarget(
            { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "execution_failed", details: { nodeExecutionId: keys1[0].nodeExecutionId } } },
            [makeKey({ ...keys1[0], outcome: "execution_failed", resultKind: "runtime_error" })],
        ),
        (err) => err.code === "RERUN_VISIT_NOT_ALLOWED" && err.details?.reason === "first_visit",
    );

    // 2. Unrouted business outcome -> continue
    const keys2 = chainKeys([
        { nodeId: "build", ordinal: 1, outcome: "ok" },
        { nodeId: "review", ordinal: 1, arrivalRoute: "ok", outcome: "needs_triage", resultKind: "business" },
    ]);
    const p2 = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "no_route", details: { nodeExecutionId: keys2[1].nodeExecutionId } } },
        keys2,
    );
    assert.equal(p2.chosen.nodeExecutionId, keys2[1].nodeExecutionId);
    assert.equal(p2.mode, "continue");
    assert.equal(p2.picked, "unrouted_outcome");

    // 3. Ended at a terminal step with outcome 'failed' -> walks predecessor back to first runtime_error (or parallel blocked), else immediate predecessor
    const keys3 = chainKeys([
        { nodeId: "build", ordinal: 1, outcome: "ok" },
        { nodeId: "finish", ordinal: 1, arrivalRoute: "ok", outcome: "execution_failed", resultKind: "runtime_error" },
        { nodeId: "cleanup", ordinal: 1, arrivalRoute: "failure", outcome: "ok", resultKind: "business" },
        { nodeId: "failed", ordinal: 1, nodeType: "terminal", arrivalRoute: "ok", outcome: "failed", resultKind: "business", winner: "controller" },
    ]);
    const p3 = pickRerunTarget(
        { status: "failed", terminalNodeId: "failed", terminalOutcome: "failed", terminalError: null },
        keys3,
    );
    assert.equal(p3.chosen.nodeExecutionId, keys3[1].nodeExecutionId);
    assert.equal(p3.mode, "run_again");
    assert.equal(p3.picked, "failed_visit");

    // 3b. Terminal failed with no runtime_error ancestor -> picks immediate predecessor
    const keys3b = chainKeys([
        { nodeId: "build", ordinal: 1, outcome: "ok" },
        { nodeId: "gate", ordinal: 1, arrivalRoute: "ok", outcome: "rejected", resultKind: "business" },
        { nodeId: "failed", ordinal: 1, nodeType: "terminal", arrivalRoute: "rejected", outcome: "failed", resultKind: "business", winner: "controller" },
    ]);
    const p3b = pickRerunTarget(
        { status: "failed", terminalNodeId: "failed", terminalOutcome: "failed", terminalError: null },
        keys3b,
    );
    assert.equal(p3b.chosen.nodeExecutionId, keys3b[1].nodeExecutionId);
    assert.equal(p3b.mode, "run_again");
    assert.equal(p3b.picked, "failed_visit");

    // 4. limit_exceeded -> last top-level visit, continue when completed with real result
    const p4 = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "limit_exceeded", message: "hit limit" } },
        keys2,
    );
    assert.equal(p4.chosen.nodeExecutionId, keys2[1].nodeExecutionId);
    assert.equal(p4.mode, "continue");
    assert.equal(p4.picked, "limit_exceeded");

    // 4b. (I5) limit_exceeded inside a parallel lane: finishRun cancelled pending root parallel visit (winner="controller") -> falls back to run_again
    const p4bKeys = [
        keys1[0],
        makeKey({ nodeId: "fanout", ordinal: 1, nodeType: "parallel", predecessorId: keys1[0].nodeExecutionId, arrivalRoute: "ok", outcome: "cancelled", resultKind: "runtime_error", winner: "controller" }),
    ];
    const p4b = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "limit_exceeded", message: "hit limit in lane" } },
        p4bKeys,
    );
    assert.equal(p4b.chosen.nodeExecutionId, p4bKeys[1].nodeExecutionId);
    assert.equal(p4b.mode, "run_again");
    assert.equal(p4b.picked, "limit_exceeded");

    // 1d. (m6) lane visit whose enclosing parallel row is missing -> explicitly refuses inside_lane (never returns lane visit)
    const orphanLane = makeKey({ scopeId: branchScopeId("nx-missing-parallel", 0), nodeId: "worker", ordinal: 1, predecessorId: "nx-missing-parallel", arrivalRoute: "@branch", outcome: "execution_failed", resultKind: "runtime_error" });
    assert.throws(
        () => pickRerunTarget(
            { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "execution_failed", details: { nodeExecutionId: orphanLane.nodeExecutionId } } },
            [keys1[0], orphanLane],
        ),
        (err) => err instanceof WorkflowRerunError && err.code === "RERUN_VISIT_NOT_ALLOWED" && err.details?.reason === "inside_lane",
    );

    // 5c. (m7) technical failure (timed_out with winner="deadline") -> tagged last_visit, mode run_again
    const keys5c = chainKeys([
        { nodeId: "build", ordinal: 1, outcome: "ok" },
        { nodeId: "finish", ordinal: 1, arrivalRoute: "ok", outcome: "cancelled", resultKind: "runtime_error", winner: "deadline" },
    ]);
    const p5c = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "timed_out", details: { nodeExecutionId: keys5c[1].nodeExecutionId } } },
        keys5c,
    );
    assert.equal(p5c.chosen.nodeExecutionId, keys5c[1].nodeExecutionId);
    assert.equal(p5c.mode, "run_again");
    assert.equal(p5c.picked, "last_visit");

    // 5a. Stopped with real result on last visit -> continue
    const p5a = pickRerunTarget(
        { status: "stopped", terminalNodeId: null, terminalOutcome: null, terminalError: null },
        keys2,
    );
    assert.equal(p5a.chosen.nodeExecutionId, keys2[1].nodeExecutionId);
    assert.equal(p5a.mode, "continue");
    assert.equal(p5a.picked, "last_visit");

    // 5b. Cancelled with last visit cancelled by run end -> run_again
    const keys5b = chainKeys([
        { nodeId: "build", ordinal: 1, outcome: "ok" },
        { nodeId: "finish", ordinal: 1, arrivalRoute: "ok", outcome: "cancelled", resultKind: "runtime_error", winner: "cancel" },
    ]);
    const p5b = pickRerunTarget(
        { status: "cancelled", terminalNodeId: null, terminalOutcome: null, terminalError: null },
        keys5b,
    );
    assert.equal(p5b.chosen.nodeExecutionId, keys5b[1].nodeExecutionId);
    assert.equal(p5b.mode, "run_again");
    assert.equal(p5b.picked, "last_visit");
    assert.deepEqual(p5b.modesAvailable, ["run_again"]);

    // 6. Ended at terminal succeeded / blocked / cancelled -> RERUN_VISIT_REQUIRED
    for (const outcome of ["succeeded", "blocked", "cancelled"]) {
        assert.throws(
            () => pickRerunTarget(
                { status: "completed", terminalNodeId: "done", terminalOutcome: outcome, terminalError: null },
                keys3,
            ),
            (err) => err.code === "RERUN_VISIT_REQUIRED",
        );
    }

    // Explicit executionId refusals: not found, inside_lane, first_visit, terminal, no_result
    assert.throws(
        () => pickRerunTarget({ status: "completed", terminalNodeId: "done", terminalOutcome: "succeeded", terminalError: null }, keys3, { executionId: "nx-missing" }),
        (err) => err.code === "RERUN_VISIT_NOT_FOUND",
    );
    assert.throws(
        () => pickRerunTarget({ status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: null }, [keys1[0], pVisit, laneVisit], { executionId: laneVisit.nodeExecutionId }),
        (err) => err.code === "RERUN_VISIT_NOT_ALLOWED"
            && err.details?.reason === "inside_lane"
            && err.details?.parallelExecutionId === pVisit.nodeExecutionId
            && err.details?.parallelStateId === "fanout"
            && err.details?.parallelVisit === 1,
    );
    assert.throws(
        () => pickRerunTarget({ status: "completed", terminalNodeId: "done", terminalOutcome: "succeeded", terminalError: null }, keys3, { executionId: keys3[0].nodeExecutionId, mode: "run_again" }),
        (err) => err.code === "RERUN_VISIT_NOT_ALLOWED" && err.details?.reason === "first_visit",
    );
    assert.throws(
        () => pickRerunTarget({ status: "failed", terminalNodeId: "failed", terminalOutcome: "failed", terminalError: null }, keys3, { executionId: keys3[3].nodeExecutionId, mode: "continue" }),
        (err) => err.code === "RERUN_VISIT_NOT_ALLOWED" && err.details?.reason === "terminal",
    );
    assert.throws(
        () => pickRerunTarget({ status: "cancelled", terminalNodeId: null, terminalOutcome: null, terminalError: null }, keys5b, { executionId: keys5b[1].nodeExecutionId, mode: "continue" }),
        (err) => err.code === "RERUN_VISIT_NOT_ALLOWED" && err.details?.reason === "no_result",
    );

    // Explicit executionId defaults mode to run_again when omitted
    const pExplicit = pickRerunTarget(
        { status: "completed", terminalNodeId: "done", terminalOutcome: "succeeded", terminalError: null },
        keys2,
        { executionId: keys2[1].nodeExecutionId },
    );
    assert.equal(pExplicit.mode, "run_again");
    assert.equal(pExplicit.picked, "requested");
    assert.deepEqual(pExplicit.modesAvailable, ["run_again", "continue"]);
});

test("checkRerunCompatibility: verifies all 11 rows of Spec §8.2 plus rules C5, C6, C7, C9", () => {
    const srcCompiled = mustCompile(SPEC_82_BASE_YAML);
    const visits = chainKeys([
        { nodeId: "build", ordinal: 1, nodeType: "script", outcome: "ok" },
        { nodeId: "review", ordinal: 1, nodeType: "agent", arrivalRoute: "ok", outcome: "changes" },
        { nodeId: "fix", ordinal: 1, nodeType: "agent", arrivalRoute: "changes", outcome: "ok" },
        { nodeId: "review", ordinal: 2, nodeType: "agent", arrivalRoute: "ok", outcome: "approved" },
        { nodeId: "finish", ordinal: 1, nodeType: "script", arrivalRoute: "approved", outcome: "execution_failed", resultKind: "runtime_error" },
    ]);
    const finish = visits[4];
    const review2 = visits[3];
    const partFinish = partitionRerunVisits(visits, finish.nodeExecutionId, "run_again");
    const partReview2 = partitionRerunVisits(visits, review2.nodeExecutionId, "continue");

    const rows = [
        {
            name: "1. finish script fixed -> fits, no changedReusedSteps",
            yaml: SPEC_82_BASE_YAML.replace('await setResult("ok", {});\'\n    transition: { next: { ok: done', 'await setResult("ok", { fixed: true });\'\n    transition: { next: { ok: done'),
            part: partFinish, chosen: finish, mode: "run_again",
            fits: true, changed: [],
        },
        {
            name: "2. fix prompt changed -> fits with changedReusedSteps=['fix']",
            yaml: SPEC_82_BASE_YAML.replace('prompt: "Fix v1."', 'prompt: "Fix v2."'),
            part: partFinish, chosen: finish, mode: "run_again",
            fits: true, changed: [{ stateId: "fix", visits: 1 }],
        },
        {
            name: "3. untaken route review.rejected -> abort added -> fits",
            yaml: SPEC_82_BASE_YAML
                .replace("outcomes: [changes, approved]", "outcomes: [changes, approved, rejected]")
                .replace("next: { changes: fix, approved: finish }", "next: { changes: fix, approved: finish, rejected: failed }"),
            part: partFinish, chosen: finish, mode: "run_again",
            fits: true, changed: [{ stateId: "review", visits: 2 }],
        },
        {
            name: "4. step notify added after finish -> fits",
            yaml: SPEC_82_BASE_YAML
                .replace("next: { ok: done, failure: failed }", "next: { ok: notify, failure: failed }")
                .replace("  done: { type: terminal", '  notify:\n    type: script\n    source: \'await setResult("ok", {});\'\n    transition: { next: { ok: done } }\n  done: { type: terminal'),
            part: partFinish, chosen: finish, mode: "run_again",
            fits: true, changed: [],
        },
        {
            name: "5. run time limit raised -> fits",
            yaml: SPEC_82_BASE_YAML.replace("limits: { maxNodeExecutions: 50 }", "limits: { maxNodeExecutions: 50, timeoutSeconds: 7200 }"),
            part: partFinish, chosen: finish, mode: "run_again",
            fits: true, changed: [],
        },
        {
            name: "6. review renamed code_review -> C1 step_missing",
            yaml: SPEC_82_BASE_YAML.replaceAll("review", "code_review"),
            part: partFinish, chosen: finish, mode: "run_again",
            fits: false, problemCode: "step_missing",
        },
        {
            name: "7. build becomes agent -> C1 step_type_changed",
            yaml: SPEC_82_BASE_YAML.replace(
                '  build:\n    type: script\n    source: \'await setResult("ok", {});\'\n    transition: { next: { ok: review } }',
                '  build:\n    type: agent\n    invoke: { prompt: "Build." }\n    outcomes: [ok]\n    timeoutSeconds: 120\n    transition: { next: { ok: review } }',
            ),
            part: partFinish, chosen: finish, mode: "run_again",
            fits: false, problemCode: "step_type_changed",
        },
        {
            name: "8. review.changes leads to triage instead of fix -> C3 route_changed",
            yaml: SPEC_82_BASE_YAML
                .replace("changes: fix", "changes: triage")
                .replace("  fix:", '  triage:\n    type: script\n    source: \'await setResult("ok", {});\'\n    transition: { next: { ok: fix } }\n  fix:'),
            part: partFinish, chosen: finish, mode: "run_again",
            fits: false, problemCode: "route_changed",
        },
        {
            name: "9a. lint inserted between review and finish (run_again from finish) -> C4 route_changed",
            yaml: SPEC_82_BASE_YAML
                .replace("approved: finish", "approved: lint")
                .replace("  finish:", '  lint:\n    type: script\n    source: \'await setResult("ok", {});\'\n    transition: { next: { ok: finish } }\n  finish:'),
            part: partFinish, chosen: finish, mode: "run_again",
            fits: false, problemCode: "route_changed",
        },
        {
            name: "9b. lint inserted between review and finish (continue after review 2) -> fits!",
            yaml: SPEC_82_BASE_YAML
                .replace("approved: finish", "approved: lint")
                .replace("  finish:", '  lint:\n    type: script\n    source: \'await setResult("ok", {});\'\n    transition: { next: { ok: finish } }\n  finish:'),
            part: partReview2, chosen: review2, mode: "continue",
            fits: true, changed: [],
        },
        {
            name: "10. fix moved into a parallel step -> C2 step_moved",
            yaml: `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: spec82, version: "1.0.0" }
limits: { maxNodeExecutions: 50 }
initial: build
states:
  build:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: review } }
  review:
    type: agent
    session: continue
    invoke: { prompt: "Review v1." }
    outcomes: [changes, approved]
    timeoutSeconds: 120
    transition: { next: { changes: fan, approved: finish } }
  fan:
    type: parallel
    forEach: [1]
    body:
      initial: fix
      states:
        fix:
          type: agent
          invoke: { prompt: "Fix v1." }
          outcomes: [ok]
          timeoutSeconds: 120
          transition: { next: { ok: bdone } }
        bdone: { type: terminal, outcome: succeeded }
    transition: { next: { joined: review, blocked: failed } }
  finish:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`,
            part: partFinish, chosen: finish, mode: "run_again",
            fits: false, problemCode: "step_moved",
        },
        {
            name: "11. maxNodeExecutions set to 4 when 4 visits reused -> C8 limit_too_low",
            yaml: SPEC_82_BASE_YAML.replace("limits: { maxNodeExecutions: 50 }", "limits: { maxNodeExecutions: 4 }"),
            part: partFinish, chosen: finish, mode: "run_again",
            fits: false, problemCode: "limit_too_low",
        },
    ];

    for (const row of rows) {
        const tgt = mustCompile(row.yaml);
        const res = checkRerunCompatibility({
            sourceIr: srcCompiled.ir,
            targetIr: tgt.ir,
            reused: row.part.reused,
            reusedTop: row.part.reusedTop,
            chosen: row.chosen,
            mode: row.mode,
            sourceControllerVersion: "1.3.0",
        });
        assert.equal(res.fits, row.fits, `${row.name}: ${JSON.stringify(res.problems)}`);
        if (row.fits) {
            assert.deepEqual(res.changedReusedSteps, row.changed, row.name);
        } else {
            assert.ok(res.problems.some(p => p.code === row.problemCode), `${row.name}: expected ${row.problemCode}, got ${JSON.stringify(res.problems)}`);
        }
    }

    // C5: catch_all_changed and catch_all_twice
    const catchAllSrc = mustCompile(`
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ca, version: "1.0.0" }
initial: work
catchAll: rescue
states:
  work:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: done } }
  rescue:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: work } }
  rescue2:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: work } }
  done: { type: terminal, outcome: succeeded }
`);
    const caVisits = chainKeys([
        { nodeId: "work", ordinal: 1, outcome: "execution_failed", resultKind: "runtime_error" },
        { nodeId: "rescue", ordinal: 1, arrivalRoute: CATCH_ALL_ROUTE, outcome: "ok" },
        { nodeId: "work", ordinal: 2, arrivalRoute: "ok", outcome: "execution_failed", resultKind: "runtime_error" },
    ]);
    const caPart = partitionRerunVisits(caVisits, caVisits[2].nodeExecutionId, "run_again");
    const caChanged = mustCompile(catchAllSrc.ir ? `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ca, version: "1.0.0" }
initial: work
catchAll: rescue2
states:
  work:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: done } }
  rescue:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: work } }
  rescue2:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: work } }
  done: { type: terminal, outcome: succeeded }
` : "");
    const c5Res = checkRerunCompatibility({
        sourceIr: catchAllSrc.ir, targetIr: caChanged.ir,
        reused: caPart.reused, reusedTop: caPart.reusedTop, chosen: caVisits[2], mode: "run_again", sourceControllerVersion: "1.3.0",
    });
    assert.equal(c5Res.fits, false);
    assert.ok(c5Res.problems.some(p => p.code === "catch_all_changed"));

    const caTwiceVisits = chainKeys([
        { nodeId: "work", ordinal: 1, outcome: "execution_failed", resultKind: "runtime_error" },
        { nodeId: "rescue", ordinal: 1, arrivalRoute: CATCH_ALL_ROUTE, outcome: "ok" },
        { nodeId: "work", ordinal: 2, arrivalRoute: "ok", outcome: "execution_failed", resultKind: "runtime_error" },
        { nodeId: "rescue", ordinal: 2, arrivalRoute: CATCH_ALL_ROUTE, outcome: "ok" },
    ]);
    const caTwicePart = partitionRerunVisits(caTwiceVisits, caTwiceVisits[3].nodeExecutionId, "run_again");
    const c5Twice = checkRerunCompatibility({
        sourceIr: catchAllSrc.ir, targetIr: catchAllSrc.ir,
        reused: caTwicePart.reused, reusedTop: caTwicePart.reusedTop, chosen: caTwiceVisits[3], mode: "run_again", sourceControllerVersion: "1.3.0",
    });
    assert.equal(c5Twice.fits, false);
    assert.ok(c5Twice.problems.some(p => p.code === "catch_all_twice"));

    // C6: carry_changed on predecessor right before cut
    const carryAddedYaml = SPEC_82_BASE_YAML.replace("    outcomes: [changes, approved]", '    carry: { round: "${input}" }\n    outcomes: [changes, approved]');
    const c6Res = checkRerunCompatibility({
        sourceIr: srcCompiled.ir, targetIr: mustCompile(carryAddedYaml).ir,
        reused: partFinish.reused, reusedTop: partFinish.reusedTop, chosen: finish, mode: "run_again", sourceControllerVersion: "1.3.0",
    });
    assert.equal(c6Res.fits, false);
    assert.ok(c6Res.problems.some(p => p.code === "carry_changed"));

    // C7: parallel_changed (named branch renamed)
    const parSrc = mustCompile(`
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: par, version: "1.0.0" }
initial: fan
states:
  fan:
    type: parallel
    branches:
      alpha:
        initial: a1
        states:
          a1: { type: script, source: 'await setResult("ok", {});', transition: { next: { ok: ad } } }
          ad: { type: terminal, outcome: succeeded }
      beta:
        initial: b1
        states:
          b1: { type: script, source: 'await setResult("ok", {});', transition: { next: { ok: bd } } }
          bd: { type: terminal, outcome: succeeded }
    transition: { next: { joined: fin, blocked: fin } }
  fin: { type: script, source: 'await setResult("ok", {});', transition: { next: { ok: done } } }
  done: { type: terminal, outcome: succeeded }
`);
    const parTgt = mustCompile(`
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: par, version: "1.0.0" }
initial: fan
states:
  fan:
    type: parallel
    branches:
      alpha:
        initial: a1
        states:
          a1: { type: script, source: 'await setResult("ok", {});', transition: { next: { ok: ad } } }
          ad: { type: terminal, outcome: succeeded }
      gamma:
        initial: b1
        states:
          b1: { type: script, source: 'await setResult("ok", {});', transition: { next: { ok: bd } } }
          bd: { type: terminal, outcome: succeeded }
    transition: { next: { joined: fin, blocked: fin } }
  fin: { type: script, source: 'await setResult("ok", {});', transition: { next: { ok: done } } }
  done: { type: terminal, outcome: succeeded }
`);
    const pTop = chainKeys([
        { nodeId: "fan", ordinal: 1, nodeType: "parallel", outcome: "joined" },
        { nodeId: "fin", ordinal: 1, arrivalRoute: "joined", outcome: "execution_failed", resultKind: "runtime_error" },
    ]);
    const pPart = partitionRerunVisits(pTop, pTop[1].nodeExecutionId, "run_again");
    const c7Res = checkRerunCompatibility({
        sourceIr: parSrc.ir, targetIr: parTgt.ir,
        reused: pPart.reused, reusedTop: pPart.reusedTop, chosen: pTop[1], mode: "run_again", sourceControllerVersion: "1.3.0",
    });
    assert.equal(c7Res.fits, false);
    assert.ok(c7Res.problems.some(p => p.code === "parallel_changed"));

    // C9: controller_too_old (1.0.0 refused; 1.1.0, 1.2.0, 1.3.0 accepted)
    const c9Old = checkRerunCompatibility({
        sourceIr: srcCompiled.ir, targetIr: srcCompiled.ir,
        reused: partFinish.reused, reusedTop: partFinish.reusedTop, chosen: finish, mode: "run_again", sourceControllerVersion: "1.0.0",
    });
    assert.equal(c9Old.fits, false);
    assert.ok(c9Old.problems.some(p => p.code === "controller_too_old"));
    for (const v of ["1.1.0", "1.2.0", "1.3.0"]) {
        const ok = checkRerunCompatibility({
            sourceIr: srcCompiled.ir, targetIr: srcCompiled.ir,
            reused: partFinish.reused, reusedTop: partFinish.reusedTop, chosen: finish, mode: "run_again", sourceControllerVersion: v,
        });
        assert.equal(ok.fits, true, `version ${v} should fit`);
    }

    // C2: initial step changed -> step_moved
    const initChanged = mustCompile(SPEC_82_BASE_YAML.replace("initial: build", "initial: review"));
    const c2Init = checkRerunCompatibility({
        sourceIr: srcCompiled.ir, targetIr: initChanged.ir,
        reused: partFinish.reused, reusedTop: partFinish.reusedTop, chosen: finish, mode: "run_again", sourceControllerVersion: "1.3.0",
    });
    assert.equal(c2Init.fits, false);
    assert.ok(c2Init.problems.some(p => p.code === "step_moved"));

    // C4 continue: no_route when chosen outcome is not routed in target
    const unroutedReview = makeKey({ ...review2, outcome: "unhandled_label", resultKind: "business" });
    const unroutedVisits = [...visits.slice(0, 3), unroutedReview];
    const unroutedPart = partitionRerunVisits(unroutedVisits, unroutedReview.nodeExecutionId, "continue");
    const c4NoRoute = checkRerunCompatibility({
        sourceIr: srcCompiled.ir, targetIr: srcCompiled.ir,
        reused: unroutedPart.reused, reusedTop: unroutedPart.reusedTop, chosen: unroutedReview, mode: "continue", sourceControllerVersion: "1.3.0",
    });
    assert.equal(c4NoRoute.fits, false);
    assert.ok(c4NoRoute.problems.some(p => p.code === "no_route"));

    // C4 continue (m5): explicit route from chosen into an already-entered catch-all -> catch_all_twice
    const explicitCaIr = mustCompile(`
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ca-cont, version: "1.0.0" }
initial: work
catchAll: rescue
states:
  work:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: done, failure: rescue } }
  rescue:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: work } }
  done: { type: terminal, outcome: succeeded }
`).ir;
    const caContVisits = chainKeys([
        { nodeId: "work", ordinal: 1, outcome: "execution_failed", resultKind: "runtime_error" },
        { nodeId: "rescue", ordinal: 1, arrivalRoute: "failure", outcome: "ok" },
        { nodeId: "work", ordinal: 2, arrivalRoute: "ok", outcome: "execution_failed", resultKind: "runtime_error" },
    ]);
    const caContPart = partitionRerunVisits(caContVisits, caContVisits[2].nodeExecutionId, "continue");
    const c4CatchAllTwice = checkRerunCompatibility({
        sourceIr: explicitCaIr, targetIr: explicitCaIr,
        reused: caContPart.reused, reusedTop: caContPart.reusedTop, chosen: caContVisits[2], mode: "continue", sourceControllerVersion: "1.3.0",
    });
    assert.equal(c4CatchAllTwice.fits, false);
    assert.ok(c4CatchAllTwice.problems.some(p => p.code === "catch_all_twice"));

    // C7: forEach <-> named branches kind change -> parallel_changed
    const parForEach = mustCompile(`
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: par, version: "1.0.0" }
initial: fan
states:
  fan:
    type: parallel
    forEach: [1, 2]
    body:
      initial: a1
      states:
        a1: { type: script, source: 'await setResult("ok", {});', transition: { next: { ok: ad } } }
        ad: { type: terminal, outcome: succeeded }
    transition: { next: { joined: fin, blocked: fin } }
  fin: { type: script, source: 'await setResult("ok", {});', transition: { next: { ok: done } } }
  done: { type: terminal, outcome: succeeded }
`);
    const c7Kind = checkRerunCompatibility({
        sourceIr: parSrc.ir, targetIr: parForEach.ir,
        reused: pPart.reused, reusedTop: pPart.reusedTop, chosen: pTop[1], mode: "run_again", sourceControllerVersion: "1.3.0",
    });
    assert.equal(c7Kind.fits, false);
    assert.ok(c7Kind.problems.some(p => p.code === "parallel_changed"));
});

test("mapRerunExecutions & flattenRerunOrigin: remaps multi-lane/multi-parallel scopes, flattens 3-generation origins, and refuses non-completed keys", () => {
    const k1 = makeKey({ runId: "run-2", nodeId: "setup", ordinal: 1, reusedFromExecutionId: "nx-gen1-setup", reusedFromRunId: "run-1", reusedFromWorkflowSessionId: "wf-1" });
    const kPar1 = makeKey({ runId: "run-2", nodeId: "fan1", ordinal: 1, nodeType: "parallel", predecessorId: k1.nodeExecutionId, arrivalRoute: "ok", outcome: "joined" });
    const l0a = makeKey({ runId: "run-2", scopeId: branchScopeId(kPar1.nodeExecutionId, 0), nodeId: "b1", ordinal: 1, predecessorId: kPar1.nodeExecutionId, arrivalRoute: "@branch" });
    const l0b = makeKey({ runId: "run-2", scopeId: branchScopeId(kPar1.nodeExecutionId, 0), nodeId: "b2", ordinal: 1, predecessorId: l0a.nodeExecutionId, arrivalRoute: "ok" });
    const l1a = makeKey({ runId: "run-2", scopeId: branchScopeId(kPar1.nodeExecutionId, 1), nodeId: "b1", ordinal: 1, predecessorId: kPar1.nodeExecutionId, arrivalRoute: "@branch" });
    const kPar2 = makeKey({ runId: "run-2", nodeId: "fan2", ordinal: 1, nodeType: "parallel", predecessorId: kPar1.nodeExecutionId, arrivalRoute: "joined", outcome: "joined" });
    const p2l0 = makeKey({ runId: "run-2", scopeId: branchScopeId(kPar2.nodeExecutionId, 0), nodeId: "c1", ordinal: 1, predecessorId: kPar2.nodeExecutionId, arrivalRoute: "@branch" });
    const kFin = makeKey({ runId: "run-2", nodeId: "fin", ordinal: 1, predecessorId: kPar2.nodeExecutionId, arrivalRoute: "joined", outcome: "execution_failed", resultKind: "runtime_error" });

    // Deliberately pass l0b before l0a and p2l0 early to prove topological ordering across multiple parallels and lanes
    const part = partitionRerunVisits([k1, p2l0, kPar1, l0b, l1a, l0a, kPar2, kFin], kFin.nodeExecutionId, "run_again");
    assert.equal(part.reusedTop.length, 3);
    assert.equal(part.unwalkedCount, 4);
    assert.equal(part.reused.length, 7);
    assert.equal(part.totalBytes, 7 * 1024);

    const mapped = mapRerunExecutions("run-3", part.reused);
    assert.equal(mapped.length, 7);
    // Deterministic IDs matching store.ts › nodeExecutionIdFor exactly
    assert.equal(mapped[0].newId, nodeExecutionIdFor("run-3", "root", "setup", 1));
    assert.equal(mapped[0].newPredecessorId, null);
    assert.equal(mapped[1].newId, nodeExecutionIdFor("run-3", "root", "fan1", 1));
    assert.equal(mapped[1].newPredecessorId, mapped[0].newId);
    assert.equal(mapped[2].newId, nodeExecutionIdFor("run-3", "root", "fan2", 1));
    assert.equal(mapped[2].newPredecessorId, mapped[1].newId);

    // 3-generation origin flattening (always non-null workflowSessionId)
    assert.deepEqual(flattenRerunOrigin(mapped[0].source, "wf-2"), {
        executionId: "nx-gen1-setup",
        runId: "run-1",
        workflowSessionId: "wf-1",
    });
    assert.deepEqual(flattenRerunOrigin(mapped[1].source, "wf-2"), {
        executionId: kPar1.nodeExecutionId,
        runId: "run-2",
        workflowSessionId: "wf-2",
    });

    // Multi-lane & multi-parallel scope remapping, parent always before child
    const byOld = new Map(mapped.map(m => [m.source.nodeExecutionId, m]));
    const scope1_0 = branchScopeId(mapped[1].newId, 0);
    const scope1_1 = branchScopeId(mapped[1].newId, 1);
    const scope2_0 = branchScopeId(mapped[2].newId, 0);
    assert.equal(byOld.get(l0a.nodeExecutionId).newScopeId, scope1_0);
    assert.equal(byOld.get(l0a.nodeExecutionId).newPredecessorId, mapped[1].newId);
    assert.equal(byOld.get(l0b.nodeExecutionId).newScopeId, scope1_0);
    assert.equal(byOld.get(l0b.nodeExecutionId).newPredecessorId, byOld.get(l0a.nodeExecutionId).newId);
    assert.ok(mapped.indexOf(byOld.get(l0a.nodeExecutionId)) < mapped.indexOf(byOld.get(l0b.nodeExecutionId)));
    assert.equal(byOld.get(l1a.nodeExecutionId).newScopeId, scope1_1);
    assert.equal(byOld.get(l1a.nodeExecutionId).newPredecessorId, mapped[1].newId);
    assert.equal(byOld.get(p2l0.nodeExecutionId).newScopeId, scope2_0);
    assert.equal(byOld.get(p2l0.nodeExecutionId).newPredecessorId, mapped[2].newId);

    // Refuses any non-completed reused key before DB write
    assert.throws(
        () => mapRerunExecutions("run-3", [k1, makeKey({ ...kPar1, state: "pending" })]),
        (err) => err instanceof WorkflowRerunError && err.code === "RERUN_VISIT_NOT_ALLOWED",
    );
});

test("buildRerunResume & buildRerunWarnings (all 12 codes of Spec §7.2) & buildRerunPlan", () => {
    const compiled = mustCompile(`
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: warn-all, version: "1.0.0" }
contracts:
  Ping@1: { schema: { type: object } }
initial: setup
states:
  setup: { type: script, source: 'await setResult("ok", {});', transition: { next: { ok: approve } } }
  approve: { type: approval, question: "Publish PR?", timeoutSeconds: 60, transition: { next: { approved: spawn_a, rejected: done, timed_out: done } } }
  spawn_a: { type: spawn, definition: child-wf, transition: { next: { started: coder } } }
  coder:
    type: agent
    session: continue
    invoke: { prompt: "Code." }
    outcomes: [again, ok]
    timeoutSeconds: 120
    transition: { next: { again: coder, ok: decide_step } }
  decide_step:
    type: decision
    question: { type: choice, instructions: "Pick", criteria: { go: "Go", back: "Back" } }
    transition: { next: { go: send_step, back: coder } }
  send_step:
    type: messaging
    mode: send
    contract: Ping@1
    recipient: { parent: true }
    transition: { next: { sent: recv_step } }
  recv_step:
    type: messaging
    mode: receive
    contract: Ping@1
    transition: { next: { received: spawn_b } }
  spawn_b: { type: spawn, definition: child-wf, transition: { next: { started: approve2 } } }
  approve2: { type: approval, question: "Deploy?", timeoutSeconds: 60, transition: { next: { approved: after_work, rejected: done, timed_out: done } } }
  after_work: { type: script, source: 'await setResult("ok", {});', transition: { next: { ok: done } } }
  done: { type: terminal, outcome: succeeded }
`);
    const v = chainKeys([
        { nodeId: "setup", ordinal: 1, nodeType: "script", outcome: "ok" },
        { nodeId: "approve", ordinal: 1, nodeType: "approval", arrivalRoute: "ok", outcome: "approved" },
        { nodeId: "spawn_a", ordinal: 1, nodeType: "spawn", arrivalRoute: "approved", outcome: "started", spawnChildWorkflowId: "child-a" },
        { nodeId: "coder", ordinal: 1, nodeType: "agent", arrivalRoute: "started", outcome: "ok" },
        { nodeId: "decide_step", ordinal: 1, nodeType: "decision", arrivalRoute: "ok", outcome: "go", carrySha256: "carry-h", hasCarry: true },
        { nodeId: "send_step", ordinal: 1, nodeType: "messaging", arrivalRoute: "go", outcome: "sent" },
        { nodeId: "recv_step", ordinal: 1, nodeType: "messaging", arrivalRoute: "sent", outcome: "received" },
        { nodeId: "spawn_b", ordinal: 1, nodeType: "spawn", arrivalRoute: "received", outcome: "started", spawnChildWorkflowId: "child-b" },
        { nodeId: "approve2", ordinal: 1, nodeType: "approval", arrivalRoute: "started", outcome: "approved" },
        { nodeId: "after_work", ordinal: 1, nodeType: "script", arrivalRoute: "approved", outcome: "ok" },
    ]);

    // Case A: chosen = decide_step (triggers decision_runs_again + 10 other codes = 11 codes!)
    const partDecide = partitionRerunVisits(v, v[4].nodeExecutionId, "run_again");
    const warningsDecide = buildRerunWarnings({
        sourceNumber: 2,
        targetIr: compiled.ir,
        reused: partDecide.reused,
        dropped: partDecide.dropped.map(k => ({ ...k, outputPreview: k.nodeId === "after_work" ? '{"pr":415}' : null })),
        chosen: v[4],
        mode: "run_again",
        changedReusedSteps: [{ stateId: "setup", visits: 1 }],
        deliveredOutboxExecIds: new Set([v[5].nodeExecutionId]),
        droppedSpawnChildren: new Map([[v[7].nodeExecutionId, { name: "child-wf", number: 7, status: "cancelled" }]]),
        reusedSpawnNoticeChildIds: new Set(), // child-a has no end notice -> reused_child_gone!
        droppedConsumedUncarriedExecIds: new Set([v[6].nodeExecutionId]),
        reusedApprovals: [{ executionId: v[1].nodeExecutionId, stateId: "approve", visit: 1, question: "Publish PR?", outcome: "approved", decidedAt: "2026-11-26T22:02:00Z" }],
        droppedApprovals: [{ executionId: v[8].nodeExecutionId, stateId: "approve2", visit: 1, question: "Deploy?" }],
    });
    const codesDecide = new Set(warningsDecide.map(w => w.code));
    for (const expectedCode of [
        "work_after_cut",
        "messages_sent",
        "children_started",
        "approvals_asked",
        "inputs_taken",
        "reused_setup",
        "reused_child_gone",
        "changed_reused_step",
        "agent_memory",
        "approval_reused",
        "decision_runs_again",
    ]) {
        assert.ok(codesDecide.has(expectedCode), `missing warning ${expectedCode}; got ${[...codesDecide].join(", ")}`);
    }
    assert.ok(!codesDecide.has("step_runs_again"), "decision_runs_again replaces step_runs_again for a decision step");

    // Case B: chosen = send_step (triggers step_runs_again, does NOT trigger agent_memory since coder is unreachable from send_step!)
    const partSend = partitionRerunVisits(v, v[5].nodeExecutionId, "run_again");
    const warningsSend = buildRerunWarnings({
        sourceNumber: 2,
        targetIr: compiled.ir,
        reused: partSend.reused,
        dropped: partSend.dropped,
        chosen: v[5],
        mode: "run_again",
        changedReusedSteps: [],
        deliveredOutboxExecIds: new Set(),
        droppedSpawnChildren: new Map(),
        reusedSpawnNoticeChildIds: new Set(["child-a"]),
        droppedConsumedUncarriedExecIds: new Set(["msg-1", "msg-2"]),
        reusedApprovals: [],
        droppedApprovals: [],
    });
    assert.ok(warningsSend.some(w => w.code === "step_runs_again" && w.stateId === "send_step"));
    assert.ok(!warningsSend.some(w => w.code === "agent_memory"), "unreachable continued agent must not emit agent_memory");
    const pluralInputs = warningsSend.find(w => w.code === "inputs_taken");
    assert.ok(pluralInputs && pluralInputs.message.includes("Send them again"), "plural inputs_taken uses 'them'");

    // Case C (m11): chosen settled at entry (exhausted, winner='controller') does NOT emit step_runs_again
    const exhaustedChosen = makeKey({ ...v[5], outcome: "exhausted", resultKind: "runtime_error", winner: "controller" });
    const warningsExhausted = buildRerunWarnings({
        sourceNumber: 2,
        targetIr: compiled.ir,
        reused: partSend.reused,
        dropped: [exhaustedChosen],
        chosen: exhaustedChosen,
        mode: "run_again",
        changedReusedSteps: [],
        deliveredOutboxExecIds: new Set(),
        droppedSpawnChildren: new Map(),
        reusedSpawnNoticeChildIds: new Set(["child-a"]),
        droppedConsumedUncarriedExecIds: new Set(),
        reusedApprovals: [],
        droppedApprovals: [],
    });
    assert.ok(!warningsExhausted.some(w => w.code === "step_runs_again"), "exhausted visit never started work");

    // buildRerunResume (run_again sameIr vs changedIr, and continue)
    const resumeSame = buildRerunResume({
        mode: "run_again", chosen: v[4], mappedPredecessorId: "nx-new-coder",
        cutKvRevision: 3, sourceRevision: 2, sourceIrSha256: "abc", targetIrSha256: "abc",
    });
    assert.deepEqual(resumeSame, {
        v: 1, mode: "run_again", stateId: "decide_step", ordinal: 1, scopeId: "root",
        arrivalRoute: "ok", predecessorId: "nx-new-coder", cutKvRevision: 3,
        sameIr: true, expectedInputSha256: "in-decide_step-1", expectedCarrySha256: "carry-h",
        recordedInputSha256: "in-decide_step-1", fromStateId: "decide_step", fromVisit: 1, sourceRevision: 2,
    });
    const resumeChanged = buildRerunResume({
        mode: "run_again", chosen: v[4], mappedPredecessorId: "nx-new-coder",
        cutKvRevision: 3, sourceRevision: 2, sourceIrSha256: "abc", targetIrSha256: "def",
    });
    assert.equal(resumeChanged.sameIr, false);
    assert.equal(resumeChanged.expectedInputSha256, null);
    assert.equal(resumeChanged.expectedCarrySha256, null);
    assert.equal(resumeChanged.recordedInputSha256, "in-decide_step-1");

    const resumeCont = buildRerunResume({
        mode: "continue", chosen: v[4], mappedPredecessorId: "nx-new-decide",
        cutKvRevision: 3, sourceRevision: 2, sourceIrSha256: "abc", targetIrSha256: "abc",
    });
    assert.equal(resumeCont.stateId, null);
    assert.equal(resumeCont.ordinal, null);
    assert.equal(resumeCont.predecessorId, "nx-new-decide");
    assert.equal(resumeCont.recordedInputSha256, null);

    // buildRerunPlan shape check
    const plan = buildRerunPlan({
        source: { workflowId: "wf-2", runId: "run-2", revision: 3, status: "failed", number: 2 },
        chosen: v[4], picked: "failed_visit", mode: "run_again", modesAvailable: ["run_again", "continue"],
        revision: { target: 4, newestValid: 4, fits: true, problems: [], changedReusedSteps: [] },
        sourceRevisionFits: true,
        reused: partDecide.reused,
        reusedRequests: [],
        dropped: partDecide.dropped.map(k => ({ ...k, outputPreview: null })),
        targetIr: compiled.ir,
        warnings: warningsDecide,
        allowed: true,
        blockedReason: null,
    });
    assert.equal(plan.of.workflowId, "wf-2");
    assert.equal(plan.from.stateId, "decide_step");
    assert.equal(plan.reused.visits, 4);
    assert.equal(plan.runs.first?.stateId, "decide_step");
    assert.equal(plan.allowed, true);
});
