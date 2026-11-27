/**
 * Pure unit tests for Workflow Re-run picker, compatibility rules (C1..C9 & Spec §8.2),
 * deterministic ID/scope mapper, 3-generation origin flattening, resume builder,
 * all 12 warnings (Spec §7.2), and plan builder — no database.
 *
 * Run: node --test test/unit/workflow-rerun-plan.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow, parseWorkflowIr, WORKFLOW_IR_VERSION } from "../../dist/workflow/compiler.js";
import { CATCH_ALL_ROUTE, branchScopeId } from "../../dist/workflow/controller/runtime.js";
import { workflowResolvedSchema } from "../../dist/workflow/resolved-schema.js";
import { nodeExecutionIdFor, WorkflowStoreError } from "../../dist/workflow/store.js";
import {
    WORKFLOW_RERUN_MAX_COPY_BYTES,
    WORKFLOW_RERUN_SUPPLY_NOTE_MAX_CHARS,
    flattenRerunOrigin,
    pickRerunTarget,
    partitionRerunVisits,
    mapRerunExecutions,
    validateRerunSupply,
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
        carryByteLength: 0,
        byteLength: 1024,
        reusedFromExecutionId: null,
        reusedFromRunId: null,
        reusedFromWorkflowSessionId: null,
        suppliedFromExecutionId: null,
        suppliedFromRunId: null,
        suppliedFromWorkflowSessionId: null,
        suppliedNote: null,
        spawnChildWorkflowId: null,
        spawnChildCancelledBySourceEnd: false,
        spawnChildHasNotice: true,
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
        (err) => err instanceof WorkflowStoreError && err.code === "RERUN_VISIT_NOT_ALLOWED" && err.details?.reason === "inside_lane",
    );

    // 5c. (B1) step-level unrouted timed_out (with details.nodeExecutionId) -> run_again / failed_visit
    const keys5c = chainKeys([
        { nodeId: "build", ordinal: 1, outcome: "ok" },
        { nodeId: "finish", ordinal: 1, arrivalRoute: "ok", outcome: "timed_out", resultKind: "runtime_error", winner: "controller" },
    ]);
    const p5c = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "timed_out", details: { nodeExecutionId: keys5c[1].nodeExecutionId } } },
        keys5c,
    );
    assert.equal(p5c.chosen.nodeExecutionId, keys5c[1].nodeExecutionId);
    assert.equal(p5c.mode, "run_again");
    assert.equal(p5c.picked, "failed_visit");

    // 5d. run-level timed_out (NO details.nodeExecutionId; last visit cancelled with winner="deadline") -> row 5 last_visit / run_again
    const keys5d = chainKeys([
        { nodeId: "build", ordinal: 1, outcome: "ok" },
        { nodeId: "finish", ordinal: 1, arrivalRoute: "ok", outcome: "cancelled", resultKind: "runtime_error", winner: "deadline" },
    ]);
    const p5d = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "timed_out", details: { limit: "run_timeout", timeoutSeconds: 60 } } },
        keys5d,
    );
    assert.equal(p5d.chosen.nodeExecutionId, keys5d[1].nodeExecutionId);
    assert.equal(p5d.mode, "run_again");
    assert.equal(p5d.picked, "last_visit");

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
    assert.deepEqual(p5b.modesAvailable, ["run_again", "supply"]);

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
    assert.deepEqual(pExplicit.modesAvailable, ["run_again", "continue", "supply"]);
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
        (err) => err instanceof WorkflowStoreError && err.code === "RERUN_VISIT_NOT_ALLOWED",
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
        recordedInputSha256: "in-decide_step-1", supplied: null, fromStateId: "decide_step", fromVisit: 1, sourceRevision: 2,
    });
    const resumeChanged = buildRerunResume({
        mode: "run_again", chosen: v[4], mappedPredecessorId: "nx-new-coder",
        cutKvRevision: 3, sourceRevision: 2, sourceIrSha256: "abc", targetIrSha256: "def",
    });
    assert.equal(resumeChanged.sameIr, false);
    assert.equal(resumeChanged.expectedInputSha256, null);
    assert.equal(resumeChanged.expectedCarrySha256, null);
    assert.equal(resumeChanged.recordedInputSha256, "in-decide_step-1");
    assert.equal(resumeChanged.supplied, null);

    const resumeCont = buildRerunResume({
        mode: "continue", chosen: v[4], mappedPredecessorId: "nx-new-decide",
        cutKvRevision: 3, sourceRevision: 2, sourceIrSha256: "abc", targetIrSha256: "abc",
    });
    assert.equal(resumeCont.stateId, null);
    assert.equal(resumeCont.ordinal, null);
    assert.equal(resumeCont.predecessorId, "nx-new-decide");
    assert.equal(resumeCont.recordedInputSha256, null);
    assert.equal(resumeCont.supplied, null);

    // buildRerunPlan shape check (N2: omits sourceRevisionFits; source-rev default + newestValidFits)
    const plan = buildRerunPlan({
        source: { workflowId: "wf-2", runId: "run-2", revision: 3, status: "failed", number: 2 },
        chosen: v[4], picked: "failed_visit", mode: "run_again", modesAvailable: ["run_again", "continue"],
        revision: { target: 4, newestValid: 4, newestValidFits: true, newestValidProblem: null, fits: true, problems: [], changedReusedSteps: [] },
        reused: partDecide.reused,
        reusedRequests: [],
        dropped: partDecide.dropped.map(k => ({ ...k, outputPreview: null })),
        sourceIr: compiled.ir,
        targetIr: compiled.ir,
        carried: { count: 0, contracts: [] },
        warnings: warningsDecide,
        allowed: true,
        blockedReason: null,
    });
    assert.equal(plan.of.workflowId, "wf-2");
    assert.equal(plan.from.stateId, "decide_step");
    assert.equal(plan.revision.source, 3);
    assert.equal(plan.revision.target, 4);
    assert.equal(plan.revision.newestValidFits, true);
    assert.equal("sourceRevisionFits" in plan, false);
    assert.equal(plan.reused.visits, 4);
    assert.equal(plan.runs.first?.stateId, "decide_step");
    assert.equal(plan.allowed, true);
});

test("compiler.ts: supply: never on script/agent preserves WORKFLOW_IR_VERSION=1 & irSha256 and rejects invalid values/step types", () => {
    const baseYaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: sup-comp, version: "1.0.0" }
initial: s1
states:
  s1:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: a1 } }
  a1:
    type: agent
    invoke: { prompt: "Check." }
    outcomes: [ok]
    timeoutSeconds: 60
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded }
`;
    const baseRes = mustCompile(baseYaml);
    assert.equal(WORKFLOW_IR_VERSION, 1);
    assert.equal("supply" in baseRes.ir.nodes.s1, false);
    assert.equal("supply" in baseRes.ir.nodes.a1, false);

    // Adding supply: never on script and agent compiles and round-trips through parseWorkflowIr
    const neverYaml = baseYaml
        .replace('    source: \'await setResult("ok", {});\'', '    supply: never\n    source: \'await setResult("ok", {});\'')
        .replace('    invoke: { prompt: "Check." }', '    supply: never\n    invoke: { prompt: "Check." }');
    const neverRes = mustCompile(neverYaml);
    assert.equal(neverRes.ir.nodes.s1.supply, "never");
    assert.equal(neverRes.ir.nodes.a1.supply, "never");
    const parsed = parseWorkflowIr(JSON.parse(JSON.stringify(neverRes.ir)));
    assert.equal(parsed.nodes.s1.supply, "never");
    assert.equal(parsed.nodes.a1.supply, "never");

    // M13(a): pinned literal irSha256 from pre-amendment cf0e203cb compiler proves unset supply leaves irSha256 byte-identical
    assert.equal(baseRes.irSha256, "c89da35ebe2b98f6fff861ac5393d0650c44a4ac0cfbcc31430eec16d57d7190");

    // M13(b): parseWorkflowIr rejects invalid stored supply values
    const badStored = JSON.parse(JSON.stringify(neverRes.ir));
    badStored.nodes.s1.supply = "always";
    assert.throws(() => parseWorkflowIr(badStored), /invalid/i);

    // Invalid supply value on script -> WORKFLOW_FIELD_INVALID
    const badVal = compileWorkflow(baseYaml.replace('    source:', '    supply: always\n    source:'));
    assert.equal(badVal.valid, false);
    assert.ok(badVal.diagnostics.some(d => d.code === "WORKFLOW_FIELD_INVALID" && d.path === "states.s1.supply"));

    // N11: supply on non-script/non-agent step types emits checkKeys's standard unknown-field diagnostic
    const badWait = compileWorkflow(`
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: sup-wait, version: "1.0.0" }
initial: w
states:
  w: { type: wait, supply: never, seconds: 5, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`);
    assert.equal(badWait.valid, false);
    assert.ok(badWait.diagnostics.some(d => d.path === "states.w.supply" && d.code !== "WORKFLOW_FIELD_INVALID"));

    const badApproval = compileWorkflow(`
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: sup-app, version: "1.0.0" }
initial: ap
states:
  ap: { type: approval, supply: never, question: "Ok?", timeoutSeconds: 60, transition: { next: { approved: done, rejected: done, timed_out: done } } }
  done: { type: terminal, outcome: succeeded }
`);
    assert.equal(badApproval.valid, false);
    assert.ok(badApproval.diagnostics.some(d => d.path === "states.ap.supply"));
});

test("resolved-schema.ts: workflowResolvedSchema resolves named outputSchema refs and respects 32 KiB cap", () => {
    const compiled = mustCompile(`
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: res-schema, version: "1.0.0" }
schemas:
  ServerRef:
    type: object
    required: [fqdn]
    properties:
      fqdn: { type: string }
  ProvisionOut:
    type: object
    required: [server]
    properties:
      server: { $ref: "#/schemas/ServerRef" }
initial: prov
states:
  prov:
    type: script
    outputSchema: { $ref: "#/schemas/ProvisionOut" }
    source: 'await setResult("ok", { server: { fqdn: "x" } });'
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded }
`);
    const resolved = workflowResolvedSchema(compiled.ir, compiled.ir.nodes.prov.outputSchema);
    assert.deepEqual(resolved, {
        type: "object",
        required: ["server"],
        properties: {
            server: {
                type: "object",
                required: ["fqdn"],
                properties: { fqdn: { type: "string" } },
            },
        },
    });
    assert.equal(workflowResolvedSchema(compiled.ir, null), null);
    assert.equal(workflowResolvedSchema(compiled.ir, "MissingSchema"), null);
});

test("G-R1 spawn cut-back: auto-pick backs up to cancelled/noticeless top-level and lane spawns; explicit/continue emits warnings", () => {
    const compiled = mustCompile(`
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: gr1, version: "1.0.0" }
initial: init
states:
  init: { type: script, source: 'await setResult("ok", {});', transition: { next: { ok: par } } }
  par:
    type: parallel
    forEach: [1]
    body:
      initial: lane_sp
      states:
        lane_sp: { type: spawn, definition: child-wf, transition: { next: { started: ldone } } }
        ldone: { type: terminal, outcome: succeeded }
    transition: { next: { joined: top_sp, blocked: fail } }
  top_sp: { type: spawn, definition: child-wf, transition: { next: { started: finish } } }
  finish: { type: script, source: 'await setResult("ok", {});', transition: { next: { ok: done, failure: fail } } }
  done: { type: terminal, outcome: succeeded }
  fail: { type: terminal, outcome: failed }
`);
    // 1. Top-level spawn cancelled by source end -> auto-pick cuts back from finish to top_sp
    const vTop = chainKeys([
        { nodeId: "init", ordinal: 1, nodeType: "script", outcome: "ok" },
        { nodeId: "top_sp", ordinal: 1, nodeType: "spawn", arrivalRoute: "ok", outcome: "started", spawnChildWorkflowId: "child-top", spawnChildCancelledBySourceEnd: true, spawnChildHasNotice: false },
        { nodeId: "finish", ordinal: 1, nodeType: "script", arrivalRoute: "started", outcome: "execution_failed", resultKind: "runtime_error" },
    ]);
    const pTop = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "execution_failed", details: { nodeExecutionId: vTop[2].nodeExecutionId } } },
        vTop,
    );
    assert.equal(pTop.chosen.nodeExecutionId, vTop[1].nodeExecutionId);
    assert.equal(pTop.mode, "run_again");
    assert.equal(pTop.picked, "reused_spawn");

    // 2. Lane spawn inside parallel cancelled by source end (earlier than top_sp) -> auto-pick lifts to enclosing parallel!
    const initK = makeKey({ nodeId: "init", ordinal: 1, nodeType: "script", outcome: "ok" });
    const parK = makeKey({ nodeId: "par", ordinal: 1, nodeType: "parallel", predecessorId: initK.nodeExecutionId, arrivalRoute: "ok", outcome: "joined" });
    const laneSpK = makeKey({
        scopeId: branchScopeId(parK.nodeExecutionId, 0),
        nodeId: "lane_sp",
        ordinal: 1,
        nodeType: "spawn",
        predecessorId: parK.nodeExecutionId,
        arrivalRoute: "@branch",
        outcome: "started",
        spawnChildWorkflowId: "child-lane",
        spawnChildCancelledBySourceEnd: true,
        spawnChildHasNotice: false,
    });
    const topSpK = makeKey({
        nodeId: "top_sp",
        ordinal: 1,
        nodeType: "spawn",
        predecessorId: parK.nodeExecutionId,
        arrivalRoute: "joined",
        outcome: "started",
        spawnChildWorkflowId: "child-top-2",
        spawnChildCancelledBySourceEnd: true,
        spawnChildHasNotice: false,
    });
    const finK = makeKey({ nodeId: "finish", ordinal: 1, nodeType: "script", predecessorId: topSpK.nodeExecutionId, arrivalRoute: "started", outcome: "execution_failed", resultKind: "runtime_error" });
    const allKeys = [initK, parK, laneSpK, topSpK, finK];

    const pLane = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "execution_failed", details: { nodeExecutionId: finK.nodeExecutionId } } },
        allKeys,
    );
    assert.equal(pLane.chosen.nodeExecutionId, parK.nodeExecutionId);
    assert.equal(pLane.mode, "run_again");
    assert.equal(pLane.picked, "reused_spawn");

    // 3. Explicit later executionId keeps both spawns in reused -> buildRerunWarnings emits reused_child_cancelled
    const pExplicit = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: null },
        allKeys,
        { executionId: finK.nodeExecutionId, mode: "run_again" },
    );
    assert.equal(pExplicit.chosen.nodeExecutionId, finK.nodeExecutionId);
    const partExp = partitionRerunVisits(allKeys, finK.nodeExecutionId, "run_again");
    const warnsExp = buildRerunWarnings({
        sourceNumber: 2,
        targetIr: compiled.ir,
        reused: partExp.reused,
        dropped: partExp.dropped,
        chosen: finK,
        mode: "run_again",
        changedReusedSteps: [],
        deliveredOutboxExecIds: new Set(),
        droppedSpawnChildren: new Map(),
        reusedSpawnNoticeChildIds: new Set(),
        droppedConsumedUncarriedExecIds: new Set(),
        reusedApprovals: [],
        droppedApprovals: [],
    });
    const cancelWarns = warnsExp.filter(w => w.code === "reused_child_cancelled");
    assert.equal(cancelWarns.length, 2);
    assert.ok(cancelWarns.some(w => w.message.includes("child-lane") && w.message.includes("Choose par instead")));
    assert.ok(cancelWarns.some(w => w.message.includes("child-top-2") && w.message.includes("Choose top_sp instead")));

    // 4. Noticeless (not cancelled) spawn -> auto-pick cuts back; explicit keeps and emits reused_child_gone
    const vGone = chainKeys([
        { nodeId: "init", ordinal: 1, nodeType: "script", outcome: "ok" },
        { nodeId: "top_sp", ordinal: 1, nodeType: "spawn", arrivalRoute: "ok", outcome: "started", spawnChildWorkflowId: "child-gone", spawnChildCancelledBySourceEnd: false, spawnChildHasNotice: false },
        { nodeId: "finish", ordinal: 1, nodeType: "script", arrivalRoute: "started", outcome: "execution_failed", resultKind: "runtime_error" },
    ]);
    const pGone = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "execution_failed", details: { nodeExecutionId: vGone[2].nodeExecutionId } } },
        vGone,
    );
    assert.equal(pGone.chosen.nodeExecutionId, vGone[1].nodeExecutionId);
    assert.equal(pGone.picked, "reused_spawn");

    // 5. G-R1 cut target is visit 1 (predecessorId === null) -> refuses first_visit
    const vFirstSpawn = chainKeys([
        { nodeId: "top_sp", ordinal: 1, nodeType: "spawn", outcome: "started", spawnChildWorkflowId: "child-1", spawnChildCancelledBySourceEnd: true, spawnChildHasNotice: false },
        { nodeId: "finish", ordinal: 1, nodeType: "script", arrivalRoute: "started", outcome: "execution_failed", resultKind: "runtime_error" },
    ]);
    assert.throws(
        () => pickRerunTarget(
            { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "execution_failed", details: { nodeExecutionId: vFirstSpawn[1].nodeExecutionId } } },
            vFirstSpawn,
        ),
        (err) => err.code === "RERUN_VISIT_NOT_ALLOWED" && err.details?.reason === "first_visit",
    );

    // 6. I3: auto-pick with explicit mode: "continue" (executionId omitted) skips G-R1 and emits reused_child_cancelled warning
    const vCont = chainKeys([
        { nodeId: "init", ordinal: 1, nodeType: "script", outcome: "ok" },
        { nodeId: "top_sp", ordinal: 1, nodeType: "spawn", arrivalRoute: "ok", outcome: "started", spawnChildWorkflowId: "child-cont", spawnChildCancelledBySourceEnd: true, spawnChildHasNotice: false },
        { nodeId: "finish", ordinal: 1, nodeType: "script", arrivalRoute: "started", outcome: "unrouted_x", resultKind: "business" },
    ]);
    const pExplicitContinue = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "no_route", details: { nodeExecutionId: vCont[2].nodeExecutionId } } },
        vCont,
        { mode: "continue" },
    );
    assert.equal(pExplicitContinue.chosen.nodeExecutionId, vCont[2].nodeExecutionId);
    assert.equal(pExplicitContinue.mode, "continue");
    assert.equal(pExplicitContinue.picked, "unrouted_outcome");
    const partCont = partitionRerunVisits(vCont, pExplicitContinue.chosen.nodeExecutionId, "continue");
    const warnsCont = buildRerunWarnings({
        sourceNumber: 2, targetIr: compiled.ir, reused: partCont.reused, dropped: partCont.dropped,
        chosen: pExplicitContinue.chosen, mode: "continue", changedReusedSteps: [],
        deliveredOutboxExecIds: new Set(), droppedSpawnChildren: new Map(), reusedSpawnNoticeChildIds: new Set(),
        droppedConsumedUncarriedExecIds: new Set(), reusedApprovals: [], droppedApprovals: [],
    });
    assert.ok(warnsCont.some(w => w.code === "reused_child_cancelled" && w.message.includes("child-cont") && w.message.includes("Choose top_sp instead")));

    // 7. I3: reqMode === null where defaultMode would be "continue" (unrouted_outcome & limit_exceeded) STILL cuts back via G-R1!
    const pUnroutedGr1 = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "no_route", details: { nodeExecutionId: vCont[2].nodeExecutionId } } },
        vCont,
    );
    assert.equal(pUnroutedGr1.chosen.nodeExecutionId, vCont[1].nodeExecutionId);
    assert.equal(pUnroutedGr1.mode, "run_again");
    assert.equal(pUnroutedGr1.picked, "reused_spawn");

    const pLimitGr1 = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "limit_exceeded", message: "hit limit" } },
        vCont,
    );
    assert.equal(pLimitGr1.chosen.nodeExecutionId, vCont[1].nodeExecutionId);
    assert.equal(pLimitGr1.mode, "run_again");
    assert.equal(pLimitGr1.picked, "reused_spawn");

    // 8. I3: explicit reqMode === "run_again" with executionId omitted applies G-R1 cut-back
    const pExplicitRunAgain = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: { code: "no_route", details: { nodeExecutionId: vCont[2].nodeExecutionId } } },
        vCont,
        { mode: "run_again" },
    );
    assert.equal(pExplicitRunAgain.chosen.nodeExecutionId, vCont[1].nodeExecutionId);
    assert.equal(pExplicitRunAgain.mode, "run_again");
    assert.equal(pExplicitRunAgain.picked, "reused_spawn");
});

test("supply mode: validation (step types, supply: never on S or T, 400 vs 422, outputSchema, size, C4 incl. catchAll, visit 1, resume, preview)", () => {
    assert.equal(WORKFLOW_RERUN_SUPPLY_NOTE_MAX_CHARS, 2_000);
    const yaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: sup-flow, version: "1.0.0" }
limits: { maxNodeExecutions: 10 }
schemas:
  ProvisionOut:
    type: object
    additionalProperties: false
    required: [fqdn]
    properties:
      fqdn: { type: string, minLength: 1 }
initial: prov
catchAll: rescue
states:
  prov:
    type: script
    maxVisits: 2
    carry: { attempt: 1 }
    outputSchema: { $ref: "#/schemas/ProvisionOut" }
    outcomes: [ready, fallback]
    source: 'await setResult("ready", { fqdn: "a.db" });'
    transition: { next: { ready: review, fallback: rescue, exhausted: failed, failure: failed } }
  review:
    type: agent
    session: continue
    invoke: { prompt: "Review." }
    outcomes: [ok, retry]
    timeoutSeconds: 60
    transition: { next: { ok: approve, retry: review } }
  approve:
    type: approval
    question: "Ship?"
    timeoutSeconds: 60
    transition: { next: { approved: done, rejected: failed, timed_out: failed } }
  rescue:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
    const src = mustCompile(yaml);
    const v = chainKeys([
        { nodeId: "prov", ordinal: 1, nodeType: "script", outcome: "timed_out", resultKind: "runtime_error", hasCarry: true, carryByteLength: 64 },
        { nodeId: "review", ordinal: 1, nodeType: "agent", arrivalRoute: "ready", outcome: "ok", resultKind: "business" },
        { nodeId: "approve", ordinal: 1, nodeType: "approval", arrivalRoute: "ok", outcome: "approved", resultKind: "business" },
    ]);

    // 1. mode: "supply" without executionId -> 400 RERUN_VISIT_REQUIRED
    assert.throws(
        () => pickRerunTarget({ status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: null }, v, { mode: "supply" }),
        (err) => err.code === "RERUN_VISIT_REQUIRED",
    );

    // 2. supply on approval step -> 422 RERUN_SUPPLY_NOT_ALLOWED (step_type)
    assert.throws(
        () => pickRerunTarget({ status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: null }, v, { executionId: v[2].nodeExecutionId, mode: "supply", sourceIr: src.ir, targetIr: src.ir }),
        (err) => err.code === "RERUN_SUPPLY_NOT_ALLOWED" && err.details?.reason === "step_type",
    );

    // 3. supply inside a parallel lane -> 422 RERUN_SUPPLY_NOT_ALLOWED (inside_lane)
    const laneK = makeKey({ scopeId: branchScopeId("nx-par", 0), nodeId: "prov", ordinal: 1, nodeType: "script" });
    assert.throws(
        () => pickRerunTarget({ status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: null }, [...v, laneK], { executionId: laneK.nodeExecutionId, mode: "supply" }),
        (err) => err.code === "RERUN_SUPPLY_NOT_ALLOWED" && err.details?.reason === "inside_lane",
    );

    // 4. supply on exhausted visit -> 422 RERUN_VISIT_NOT_ALLOWED (no_result)
    const exhK = makeKey({ ...v[0], outcome: "exhausted", resultKind: "runtime_error", winner: "controller" });
    assert.throws(
        () => pickRerunTarget({ status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: null }, [exhK], { executionId: exhK.nodeExecutionId, mode: "supply" }),
        (err) => err.code === "RERUN_VISIT_NOT_ALLOWED" && err.details?.reason === "no_result",
    );

    // 5. N6: supply: never on EITHER S or T -> 422 RERUN_SUPPLY_NOT_ALLOWED (supply_never)
    const neverIr = mustCompile(yaml.replace("    maxVisits: 2", "    supply: never\n    maxVisits: 2")).ir;
    assert.throws(
        () => validateRerunSupply({ chosen: v[0], reused: [], sourceIr: neverIr, targetIr: src.ir, requireResultAndNote: false }),
        (err) => err.code === "RERUN_SUPPLY_NOT_ALLOWED" && err.details?.reason === "supply_never",
    );
    assert.throws(
        () => validateRerunSupply({ chosen: v[0], reused: [], sourceIr: src.ir, targetIr: neverIr, requireResultAndNote: false }),
        (err) => err.code === "RERUN_SUPPLY_NOT_ALLOWED" && err.details?.reason === "supply_never",
    );

    // 6. S11: 400 shape vs 422 value boundary
    for (const [label, result, note] of [
        ["non-object result", "ready", "verified"],
        ["extra key in result", { outcome: "ready", output: { fqdn: "a.db" }, extra: 1 }, "verified"],
        ["blank outcome", { outcome: "   " }, "verified"],
        ["missing note", { outcome: "ready", output: { fqdn: "a.db" } }, undefined],
        ["Unicode-space-only note", { outcome: "ready", output: { fqdn: "a.db" } }, "\u2003\u00A0"],
        ["too-long note (2001 chars)", { outcome: "ready", output: { fqdn: "a.db" } }, "n".repeat(2001)],
        ["NUL char in note", { outcome: "ready", output: { fqdn: "a.db" } }, "ok\u0000bad"],
    ]) {
        assert.throws(
            () => validateRerunSupply({ chosen: v[0], reused: [], sourceIr: src.ir, targetIr: src.ir, result, note, requireResultAndNote: true }),
            (err) => err.code === "RERUN_ARGUMENT_REFUSED",
            `expected 400 RERUN_ARGUMENT_REFUSED for ${label}`,
        );
    }

    // 422 value checks: undeclared outcome, schema mismatch, nesting > 64, carry+output > 256 KiB
    assert.throws(
        () => validateRerunSupply({ chosen: v[0], reused: [], sourceIr: src.ir, targetIr: src.ir, result: { outcome: "bogus", output: { fqdn: "a.db" } }, note: "verified", requireResultAndNote: true }),
        (err) => err.code === "RERUN_SUPPLIED_RESULT_INVALID" && err.details?.reason === "undeclared_outcome",
    );
    assert.throws(
        () => validateRerunSupply({ chosen: v[0], reused: [], sourceIr: src.ir, targetIr: src.ir, result: { outcome: "ready", output: { wrong: 1 } }, note: "verified", requireResultAndNote: true }),
        (err) => err.code === "RERUN_SUPPLIED_RESULT_INVALID" && err.details?.reason === "schema",
    );
    let deep = {};
    for (let i = 0; i < 66; i += 1) deep = { a: deep };
    assert.throws(
        () => validateRerunSupply({ chosen: v[1], reused: [v[0]], sourceIr: src.ir, targetIr: src.ir, result: { outcome: "ok", output: deep }, note: "verified", requireResultAndNote: true }),
        (err) => err.code === "RERUN_SUPPLIED_RESULT_INVALID" && err.details?.reason === "schema",
    );
    // carryByteLength=64 + 20 overhead -> maxOutputBytes = 262144 - 84 = 262060
    const bigFqdn = "a".repeat(262_060); // {"fqdn":"aaa..."} exceeds 262060 bytes
    assert.throws(
        () => validateRerunSupply({ chosen: v[0], reused: [], sourceIr: src.ir, targetIr: src.ir, result: { outcome: "ready", output: { fqdn: bigFqdn } }, note: "verified", requireResultAndNote: true }),
        (err) => err.code === "RERUN_SUPPLIED_RESULT_INVALID" && err.details?.reason === "too_large",
    );

    // 7. N4: omitted output -> output: null, outputText: "null"
    const resNull = validateRerunSupply({
        chosen: v[1], reused: [v[0]], sourceIr: src.ir, targetIr: src.ir,
        result: { outcome: "ok" }, note: "verified in portal", requireResultAndNote: true,
    });
    assert.equal(resNull.validated.output, null);
    assert.equal(resNull.validated.outputText, "null");
    assert.equal(resNull.contract.maxOutputBytes, 262_144);

    // 8. supply on visit 1 (0 reused visits): partition + C2 + C4 (incl. N10 explicit route to unused catchAll)
    const partFirst = partitionRerunVisits(v, v[0].nodeExecutionId, "supply");
    assert.equal(partFirst.reused.length, 0);
    assert.equal(partFirst.reusedTop.length, 0);
    assert.equal(partFirst.firstDroppedTop?.nodeExecutionId, v[1].nodeExecutionId);

    const compatReady = checkRerunCompatibility({
        sourceIr: src.ir, targetIr: src.ir,
        reused: partFirst.reused, reusedTop: partFirst.reusedTop,
        chosen: v[0], mode: "supply", sourceControllerVersion: "1.3.0", suppliedOutcome: "ready",
    });
    assert.equal(compatReady.fits, true);

    // N10: explicit route to unused catchAll ("fallback" -> rescue) is ALLOWED
    const compatFallback = checkRerunCompatibility({
        sourceIr: src.ir, targetIr: src.ir,
        reused: partFirst.reused, reusedTop: partFirst.reusedTop,
        chosen: v[0], mode: "supply", sourceControllerVersion: "1.3.0", suppliedOutcome: "fallback",
    });
    assert.equal(compatFallback.fits, true);

    // Explicit route to ALREADY-USED catchAll -> catch_all_twice
    const vWithRescue = chainKeys([
        { nodeId: "prov", ordinal: 1, nodeType: "script", outcome: "fallback", resultKind: "business", hasCarry: true },
        { nodeId: "rescue", ordinal: 1, nodeType: "script", arrivalRoute: "fallback", outcome: "ok", resultKind: "business" },
        { nodeId: "prov", ordinal: 2, nodeType: "script", arrivalRoute: "ok", outcome: "timed_out", resultKind: "runtime_error", hasCarry: true },
    ]);
    const rescueLoopIr = mustCompile(yaml.replace('transition: { next: { ok: done } }', 'transition: { next: { ok: prov } }')).ir;
    const partRescue = partitionRerunVisits(vWithRescue, vWithRescue[2].nodeExecutionId, "supply");
    const compatTwice = checkRerunCompatibility({
        sourceIr: rescueLoopIr, targetIr: rescueLoopIr,
        reused: partRescue.reused, reusedTop: partRescue.reusedTop,
        chosen: vWithRescue[2], mode: "supply", sourceControllerVersion: "1.3.0", suppliedOutcome: "fallback",
    });
    assert.equal(compatTwice.fits, false);
    assert.ok(compatTwice.problems.some(p => p.code === "catch_all_twice"));

    // 9. buildRerunResume in supply mode & buildRerunPlan outcome-only preview (M6, S11) & source-rev default
    const supResume = buildRerunResume({
        mode: "supply", chosen: v[0], mappedPredecessorId: null,
        cutKvRevision: 1, sourceRevision: 2, sourceIrSha256: src.irSha256, targetIrSha256: src.irSha256,
        supplied: {
            mappedSuppliedId: "nx-new-prov-1",
            outcome: "ready",
            outputSha256: "out-sha",
            note: "server ready",
            at: "2026-11-27T19:00:00Z",
            nextStateId: "review",
            nextOrdinal: 1,
        },
    });
    assert.equal(supResume.mode, "supply");
    assert.equal(supResume.stateId, "review");
    assert.equal(supResume.ordinal, 1);
    assert.equal(supResume.arrivalRoute, "ready");
    assert.equal(supResume.predecessorId, "nx-new-prov-1");
    assert.equal(supResume.supplied?.outcome, "ready");

    const supPlanValid = buildRerunPlan({
        source: { workflowId: "wf-2", runId: "run-2", revision: 2, status: "failed", number: 2 },
        chosen: v[0], picked: "requested", mode: "supply", modesAvailable: ["supply"],
        revision: { newestValid: 3, newestValidFits: true, newestValidProblem: null, fits: true, problems: [], changedReusedSteps: [] },
        reused: partFirst.reused,
        reusedRequests: [],
        dropped: partFirst.dropped.map(k => ({ ...k, outputPreview: null })),
        sourceIr: src.ir,
        targetIr: src.ir,
        supplyOutcome: "ready",
        carried: { count: 2, contracts: ["WorkflowEnded@1", "HumanNote@1"] },
        warnings: buildRerunWarnings({
            sourceNumber: 2, targetIr: src.ir, reused: partFirst.reused, dropped: partFirst.dropped,
            chosen: v[0], mode: "supply", suppliedOutcome: "ready", changedReusedSteps: [],
            deliveredOutboxExecIds: new Set(), droppedSpawnChildren: new Map(), reusedSpawnNoticeChildIds: new Set(),
            droppedConsumedUncarriedExecIds: new Set(), reusedApprovals: [], droppedApprovals: [],
        }),
        allowed: true,
        blockedReason: null,
    });
    assert.equal(supPlanValid.revision.target, 2, "defaults target revision to source revision when omitted");
    assert.equal(supPlanValid.revision.source, 2);
    assert.equal(supPlanValid.supplyContract?.maxOutputBytes, 262_144 - 20 - 64);
    assert.deepEqual(supPlanValid.carried, { count: 2, contracts: ["WorkflowEnded@1", "HumanNote@1"] });
    assert.deepEqual(supPlanValid.supply, { outcome: "ready", valid: true, next: { stateId: "review", visit: 1 }, problems: [] });
    assert.deepEqual(supPlanValid.runs.first, { stateId: "review", visit: 1 });
    assert.ok(supPlanValid.warnings.some(w => w.code === "result_supplied"));

    // Invalid supplyOutcome in preview returns valid: false (never throws 422!)
    const supPlanBad = buildRerunPlan({
        source: { workflowId: "wf-2", runId: "run-2", revision: 2, status: "failed", number: 2 },
        chosen: v[0], picked: "requested", mode: "supply", modesAvailable: ["supply"],
        revision: { newestValid: 3, newestValidFits: true, newestValidProblem: null, fits: true, problems: [], changedReusedSteps: [] },
        reused: partFirst.reused,
        reusedRequests: [],
        dropped: partFirst.dropped.map(k => ({ ...k, outputPreview: null })),
        sourceIr: src.ir,
        targetIr: src.ir,
        supplyOutcome: "undeclared_x",
        carried: { count: 0, contracts: [] },
        warnings: [],
        allowed: true,
        blockedReason: null,
    });
    assert.equal(supPlanBad.supply?.valid, false);
    assert.equal(supPlanBad.supply?.next, null);
    assert.equal(supPlanBad.revision.newestValidFits, true);
    assert.ok(supPlanBad.supply?.problems.some(p => p.code === "undeclared_outcome"));

    // M1: Catch-all self-loop in supply mode: preview nextByOutcome matches C4 catch_all_twice refusal
    const selfLoopCaIr = mustCompile(
        yaml.replace('    source: \'await setResult("ok", {});\'\n    transition: { next: { ok: done } }',
            '    outcomes: [ok, retry]\n    source: \'await setResult("ok", {});\'\n    transition: { next: { ok: done, retry: rescue } }'),
    ).ir;
    const vRescue = chainKeys([
        { nodeId: "prov", ordinal: 1, nodeType: "script", outcome: "fallback", resultKind: "business", hasCarry: true },
        { nodeId: "rescue", ordinal: 1, nodeType: "script", arrivalRoute: "fallback", outcome: "timed_out", resultKind: "runtime_error" },
    ]);
    const partRescSelf = partitionRerunVisits(vRescue, vRescue[1].nodeExecutionId, "supply");
    const selfContract = validateRerunSupply({
        chosen: vRescue[1], reused: partRescSelf.reused, sourceIr: selfLoopCaIr, targetIr: selfLoopCaIr, requireResultAndNote: false,
    }).contract;
    assert.equal(selfContract.nextByOutcome.retry, null, "M1: catch-all self-loop must report null in nextByOutcome");
    assert.deepEqual(selfContract.nextByOutcome.ok, { stateId: "done", visit: 1 });
    const selfCompat = checkRerunCompatibility({
        sourceIr: selfLoopCaIr, targetIr: selfLoopCaIr,
        reused: partRescSelf.reused, reusedTop: partRescSelf.reusedTop,
        chosen: vRescue[1], mode: "supply", sourceControllerVersion: "1.3.0", suppliedOutcome: "retry",
    });
    assert.equal(selfCompat.fits, false);
    assert.ok(selfCompat.problems.some(p => p.code === "catch_all_twice"));

    // M2: buildRerunPlan maps supply_never to supply_not_allowed (not step_missing)
    const supPlanNever = buildRerunPlan({
        source: { workflowId: "wf-2", runId: "run-2", revision: 2, status: "failed", number: 2 },
        chosen: v[0], picked: "requested", mode: "supply", modesAvailable: [],
        revision: { newestValid: 3, newestValidFits: false, newestValidProblem: null, fits: true, problems: [], changedReusedSteps: [] },
        reused: partFirst.reused, reusedRequests: [], dropped: [],
        sourceIr: neverIr, targetIr: src.ir, supplyOutcome: "ready",
        carried: { count: 0, contracts: [] }, warnings: [], allowed: false, blockedReason: "supply_never",
    });
    assert.equal(supPlanNever.supply?.valid, false);
    assert.ok(supPlanNever.supply?.problems.some(p => p.code === "supply_not_allowed"));

    // M3: modesAvailable excludes supply when targetIr changed V's type, or when supply: never, or exhausted
    const waitProvIr = mustCompile(`
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: sup-flow, version: "1.0.0" }
initial: prov
states:
  prov: { type: wait, seconds: 5, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`).ir;
    const pNeverModes = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: null },
        v,
        { executionId: v[0].nodeExecutionId, mode: "continue", sourceIr: neverIr, targetIr: src.ir },
    );
    assert.ok(!pNeverModes.modesAvailable.includes("supply"));
    const pWaitTargetModes = pickRerunTarget(
        { status: "failed", terminalNodeId: null, terminalOutcome: null, terminalError: null },
        v,
        { executionId: v[0].nodeExecutionId, mode: "continue", sourceIr: src.ir, targetIr: waitProvIr },
    );
    assert.ok(!pWaitTargetModes.modesAvailable.includes("supply"));

    // M4: buildRerunResume throws when nextStateId or nextOrdinal is null in supply mode
    assert.throws(
        () => buildRerunResume({
            mode: "supply", chosen: v[0], mappedPredecessorId: null,
            cutKvRevision: 1, sourceRevision: 2, sourceIrSha256: src.irSha256, targetIrSha256: src.irSha256,
            supplied: { mappedSuppliedId: "nx-1", outcome: "ready", outputSha256: "h", note: "n", at: "2026-11-27T00:00:00Z", nextStateId: null, nextOrdinal: 1 },
        }),
        (err) => err.code === "RERUN_ARGUMENT_REFUSED",
    );

    // M5: validateRerunSupply refuses non-completed V
    assert.throws(
        () => validateRerunSupply({
            chosen: makeKey({ ...v[0], state: "pending" }), reused: [], sourceIr: src.ir, targetIr: src.ir, requireResultAndNote: false,
        }),
        (err) => err.code === "RERUN_VISIT_NOT_ALLOWED" && err.details?.reason === "not_completed",
    );

    // M13(b): C4 supply with suppliedOutcome=null, C8 maxVisits for V', C6 carry on V, C1 V type change, C3 final pair (last reused, V)
    const c4NullOk = checkRerunCompatibility({
        sourceIr: src.ir, targetIr: src.ir,
        reused: partFirst.reused, reusedTop: partFirst.reusedTop,
        chosen: v[0], mode: "supply", sourceControllerVersion: "1.3.0", suppliedOutcome: null,
    });
    assert.equal(c4NullOk.fits, true);

    const vOrd3 = makeKey({ ...v[0], ordinal: 3 });
    const c8MaxV = checkRerunCompatibility({
        sourceIr: src.ir, targetIr: src.ir,
        reused: [], reusedTop: [],
        chosen: vOrd3, mode: "supply", sourceControllerVersion: "1.3.0", suppliedOutcome: "ready",
    });
    assert.equal(c8MaxV.fits, false);
    assert.ok(c8MaxV.problems.some(p => p.code === "limit_too_low"));

    const noCarryIr = mustCompile(yaml.replace("    carry: { attempt: 1 }\n", "")).ir;
    const c6CarryV = checkRerunCompatibility({
        sourceIr: src.ir, targetIr: noCarryIr,
        reused: [], reusedTop: [],
        chosen: v[0], mode: "supply", sourceControllerVersion: "1.3.0", suppliedOutcome: "ready",
    });
    assert.equal(c6CarryV.fits, false);
    assert.ok(c6CarryV.problems.some(p => p.code === "carry_changed"));

    const c1TypeV = checkRerunCompatibility({
        sourceIr: src.ir, targetIr: waitProvIr,
        reused: [], reusedTop: [],
        chosen: v[0], mode: "supply", sourceControllerVersion: "1.3.0", suppliedOutcome: "ready",
    });
    assert.equal(c1TypeV.fits, false);
    assert.ok(c1TypeV.problems.some(p => p.code === "step_type_changed"));

    // C3 final pair (last reused prov -> chosen review) when target reroutes prov away from review
    const reroutedIr = mustCompile(yaml.replace("ready: review", "ready: approve")).ir;
    const partRev = partitionRerunVisits(v, v[1].nodeExecutionId, "supply");
    const c3FinalPair = checkRerunCompatibility({
        sourceIr: src.ir, targetIr: reroutedIr,
        reused: partRev.reused, reusedTop: partRev.reusedTop,
        chosen: v[1], mode: "supply", sourceControllerVersion: "1.3.0", suppliedOutcome: "ok",
    });
    assert.equal(c3FinalPair.fits, false);
    assert.ok(c3FinalPair.problems.some(p => p.code === "route_changed"));
});
