/**
 * Workflow v2 parallel joins of the first k and a parallel state's own time
 * limit (IR 9; owner decision join-k-of-n of 2026-11-04), INACTIVE: only
 * controller 1.9.0 runs them, and only tests register it and start runs there
 * (the test-only option workflowRequests and a host with `requests`).
 *
 * - The compiler: every accepted and refused form of `join` (all,
 *   all_required, { first: k }) and of `timeoutSeconds`, the timed_out route
 *   it needs (and that is refused without it), k against a literal list; IR 9
 *   only for a state that uses one of them, so every other IR stays as it was;
 *   the stored IR's checks.
 * - The store: the time limit decides once by its clock (not due, then
 *   timed_out with every branch's end and their pending work cancelled), and
 *   once only against a join (both orders); a branch of a decided parallel
 *   state admits nothing more; the cancellations are listed with why.
 * - Controller 1.9.0 on a native duroxide runtime: a race of three scripts of
 *   different lengths (one winner, the others cancelled, nothing of theirs
 *   routed later); the first 2 of 4 in the order they finished; k that can no
 *   longer happen with failFast and without; a time limit with 1 of 3
 *   finished (its output kept, the running one cancelled, the queued one not
 *   started; a late result loses); a binding with fewer items than k, and no
 *   items; the time limit and the branch's last result at one virtual
 *   instant (a test run's clock: the result counts, one decision, joined);
 *   the time limit while the run is paused; a worker restart, and a
 *   continue-as-new, while the time limit is pending; an IR 8 parallel run
 *   schedules what it did before.
 * - J1b (owner decision join-k-of-n, formal questions Q1 to Q3 and finding
 *   H1): the store's one count for the join and the time limit (pure: commit
 *   order with ties by index, late successes, time-limit cancellations,
 *   failFast); the store: join due at the time limit with a success not yet
 *   admitted, a k-th success after the deadline at the join (timed_out), k
 *   impossible before the time limit (blocked, timedOut), the report keeping
 *   a finished branch's result, H1 (A on time, B late and admitted first:
 *   joined with A), with and without a join due first; the controller: a
 *   join due while paused, blocked at the time limit, and H1 and a late
 *   success across a worker restart.
 * - J1c: a branch's last state is the end of its predecessor chain (review
 *   J1-R1: equal milliseconds and reversed ids, pure and in the store); the
 *   read model names a branch state's predecessor and when it ended; with
 *   fewer worker slots than branches, the first committed success wins and
 *   a loser committed before the cancel stays succeeded. The runtimes here
 *   set their worker slots (WORKER_SLOTS); duroxide's default is 2. The
 *   loser agent whose end fails (review J1-R2) is in
 *   workflow-v2-agent-node.test.js.
 *
 * Branch scripts run as real script processes; the race cases rely on timing
 * margins of at least a second between the branches that win and those that
 * lose. No model runs. Not an activation proof. The agent branch cancelled at
 * the time limit is in workflow-v2-agent-node.test.js (its child double).
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import {
    compileWorkflowV2, parseWorkflowIr, WORKFLOW_V2_AGENT_IR_VERSION, WORKFLOW_V2_JOIN_IR_VERSION, WORKFLOW_V2_MILESTONE_IR_VERSION,
    WORKFLOW_V2_PARALLEL_MAX_ITEMS,
} from "../../src/workflow/v2/compiler.ts";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import {
    branchLastState, PARALLEL_TIMEOUT_MESSAGE, parallelBranchEnd, parallelBranchStates, parallelSuccesses, parallelVerdict,
} from "../../src/workflow/v2/parallel.ts";
import { controlWorkflowV2Run, createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { readWorkflowV2View, updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import {
    BRANCH_ROUTE, branchScopeId, describeWorkflowV2State, registerWorkflowV2, sessionQueueTransport, WORKFLOW_V2_REQUEST_ACTIVITIES,
    WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, workflowLiveControllerInstanceId,
} from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { openWorkflowStore } from "../helpers/workflow-v2-request-fixture.js";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-join-test" };
const PARALLEL = { enableRequests: true, enableAgents: true, enableParallel: true };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(50);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/** A definition as a document (JSON is YAML). */
const yamlOf = doc => JSON.stringify(doc, null, 2);
const errorsOf = result => result.diagnostics.filter(item => item.severity === "error");
const head = name => ({ apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name, version: "1.0.0" } });

/**
 * Each branch's script waits its item's `ms`, then ends `bad` for an item with `fail`, `hold` for an item with `seconds`
 * (a wait of that many seconds, then success), and `ok` otherwise; its output is its index and its item.
 */
const WORK = "const item = context.input;\n"
    + "await new Promise(resolve => setTimeout(resolve, item.ms ?? 0));\n"
    + "await setResult(item.fail ? \"bad\" : item.seconds ? \"hold\" : \"ok\", { index: context.branch.index, ...item });\n";

/**
 * A failed branch's end as the join's report gives it (wfs-full-5d687726 classification): at its blocked terminal, or,
 * when the join decided before that terminal step committed (under load), finished at its work step with the outcome
 * that routes there (parallelBranchStates: a terminal admitted but not yet decided stands as the state before it).
 * Either is the same failure; the finished form must be this branch's own work step with outcome "bad". Never a
 * success, a cancellation or still running.
 */
function failedBranchEnd(branch, workId) {
    if (branch.ended !== "finished") return [branch.index, branch.ended, branch.outcome];
    expect(branch, `branch ${branch.index}`).toMatchObject({ nodeExecutionId: workId, outcome: "bad" });
    return [branch.index, "terminal", "blocked"];
}

/** A parallel state over `items` with the join, failFast, concurrency and time limit given; its routes lead to the outer terminals. */
function joinDoc({ items = [], forEach = "${input.items}", join, failFast = false, concurrency, timeoutSeconds } = {}) {
    const timed = timeoutSeconds !== undefined;
    return {
        ...head("join-k"),
        initialInput: { items },
        initial: "fan",
        states: {
            fan: {
                type: "parallel", forEach, concurrency: concurrency ?? Math.max(1, Math.min(Array.isArray(items) ? items.length : 1, 16)),
                ...(join !== undefined ? { join } : {}), ...(failFast ? { failFast: true } : {}), ...(timed ? { timeoutSeconds } : {}),
                body: {
                    initial: "work",
                    states: {
                        work: { type: "script", source: WORK, transition: { next: { ok: "done", bad: "refused", hold: "hold" } } },
                        hold: { type: "wait", seconds: "${input.seconds}", transition: { next: { elapsed: "done" } } },
                        done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                        refused: { type: "terminal", outcome: "blocked", output: "${input}" },
                    },
                },
                transition: { next: { joined: "finished", blocked: "stuck", failure: "failed", ...(timed ? { timed_out: "late" } : {}) } },
            },
            finished: { type: "terminal", outcome: "succeeded", output: "${input}" },
            stuck: { type: "terminal", outcome: "blocked", output: "${input}" },
            failed: { type: "terminal", outcome: "failed" },
            ...(timed ? { late: { type: "terminal", outcome: "blocked", output: "${input}" } } : {}),
        },
    };
}

describe("workflow v2 parallel joins: compiler and IR 9", () => {
    it("compiles join all, all_required and { first: k }, and timeoutSeconds; IR 9 only for a state that uses one of them", () => {
        for (const join of [undefined, "all", "all_required"]) {
            const compiled = compileWorkflowV2(yamlOf(joinDoc({ items: [{ ms: 0 }], join })), PARALLEL);
            expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
            // A join of every branch without a time limit is IR 8, written exactly as before.
            expect(compiled.ir.irVersion).toBe(WORKFLOW_V2_AGENT_IR_VERSION);
            expect(compiled.ir.nodes.fan.join).toBe("all_required");
            expect(Object.keys(compiled.ir.nodes.fan).sort()).toEqual(
                ["body", "concurrency", "description", "failFast", "forEach", "id", "inputSchema", "join", "next", "outputSchema", "type"]);
        }
        const first = compileWorkflowV2(yamlOf(joinDoc({ items: [{ ms: 0 }, { ms: 1 }], join: { first: 2 } })), PARALLEL);
        expect(first.valid, JSON.stringify(first.diagnostics)).toBe(true);
        expect(first.ir.irVersion).toBe(WORKFLOW_V2_JOIN_IR_VERSION);
        expect(first.ir.nodes.fan).toMatchObject({ join: { first: 2 } });
        expect(first.ir.nodes.fan.timeoutSeconds).toBeUndefined();

        const timed = compileWorkflowV2(yamlOf(joinDoc({ items: [{ ms: 0 }], timeoutSeconds: 30 })), PARALLEL);
        expect(timed.valid, JSON.stringify(timed.diagnostics)).toBe(true);
        expect(timed.ir.irVersion).toBe(WORKFLOW_V2_JOIN_IR_VERSION);
        expect(timed.ir.nodes.fan).toMatchObject({ join: "all_required", timeoutSeconds: 30, next: expect.objectContaining({ timed_out: "late" }) });
        const bound = compileWorkflowV2(yamlOf({ ...joinDoc({ items: [{ ms: 0 }], timeoutSeconds: "${input.limit}" }), initialInput: { items: [{ ms: 0 }], limit: 5 } }),
            PARALLEL);
        expect(bound.valid, JSON.stringify(bound.diagnostics)).toBe(true);
        expect(bound.ir.nodes.fan.timeoutSeconds).toBe("${input.limit}");
        // The graph and events show them; an IR 8 state shows neither.
        expect(describeWorkflowV2State(timed.ir.nodes.fan)).toMatchObject({ join: "all_required", timeoutSeconds: 30 });
        expect(describeWorkflowV2State(first.ir.nodes.fan)).toMatchObject({ join: { first: 2 } });
        expect(describeWorkflowV2State(first.ir.nodes.fan).timeoutSeconds).toBeUndefined();

        // A reader takes IR 9 only when asked to, and stored IR 9 reads back as compiled.
        for (const compiled of [first, timed, bound]) {
            const stored = JSON.parse(canonicalJson(compiled.ir));
            expect(parseWorkflowIr(stored, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION })).toEqual(compiled.ir);
            expect(() => parseWorkflowIr(stored, { maxIrVersion: WORKFLOW_V2_AGENT_IR_VERSION })).toThrow(/stored IR version 9 is not supported/);
            expect(() => parseWorkflowIr(stored)).toThrow(/stored IR version 9 is not supported/);
        }
        expect(WORKFLOW_V2_MILESTONE_IR_VERSION).toBe(WORKFLOW_V2_JOIN_IR_VERSION);
    });

    it("refuses every other join, a k above a literal list, a bad time limit, and a timed_out route without a time limit or the reverse", () => {
        const variant = (options, change = () => {}) => {
            const doc = joinDoc(options);
            change(doc, doc.states.fan);
            return compileWorkflowV2(yamlOf(doc), PARALLEL);
        };
        const items = [{ ms: 0 }, { ms: 0 }];
        for (const [label, options, change, code, path] of [
            ["first 0", { items, join: { first: 0 } }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["first negative", { items, join: { first: -1 } }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["first not an integer", { items, join: { first: 1.5 } }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["first as text", { items, join: { first: "2" } }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["first above the item limit", { join: { first: WORKFLOW_V2_PARALLEL_MAX_ITEMS + 1 } }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["first with another field", { items, join: { first: 1, of: 2 } }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["any", { items, join: "any" }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["a number", { items, join: 2 }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["k above a literal list", { join: { first: 3 } }, (_, fan) => { fan.forEach = items; }, "WORKFLOW_FIELD_INVALID", "states.fan.join.first"],
            ["timeout 0", { items, timeoutSeconds: 0 }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.timeoutSeconds"],
            ["timeout above a day", { items, timeoutSeconds: 86_401 }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.timeoutSeconds"],
            ["timeout not an integer", { items, timeoutSeconds: 1.5 }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.timeoutSeconds"],
            ["timeout text that is no binding", { items, timeoutSeconds: "soon" }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.timeoutSeconds"],
            ["timeout bound to branch", { items, timeoutSeconds: "${branch.index}" }, undefined, "WORKFLOW_BINDING_INVALID", "states.fan.timeoutSeconds"],
            ["timeout without a timed_out route", { items, timeoutSeconds: 5 }, (_, fan) => { delete fan.transition.next.timed_out; },
                "WORKFLOW_ROUTE_MISSING", "states.fan.transition.next"],
            ["a timed_out route without a timeout", { items }, (doc, fan) => {
                fan.transition.next.timed_out = "stuck";
            }, "WORKFLOW_ROUTE_INVALID", "states.fan.transition.next.timed_out"],
        ]) {
            const result = variant(options, change);
            expect(result.valid, label).toBe(false);
            expect(errorsOf(result).map(item => [item.code, item.path]), label).toContainEqual([code, path]);
        }
        // k equal to a literal list's items, and the largest k, compile.
        const equal = variant({ join: { first: 2 } }, (_, fan) => { fan.forEach = items; });
        expect(equal.valid, JSON.stringify(equal.diagnostics)).toBe(true);
        expect(equal.ir.nodes.fan.join).toEqual({ first: 2 });
        const largest = variant({ items, join: { first: WORKFLOW_V2_PARALLEL_MAX_ITEMS }, timeoutSeconds: 86_400 });
        expect(largest.valid, JSON.stringify(largest.diagnostics)).toBe(true);
        // The message for k above a literal list says why.
        expect(errorsOf(variant({ join: { first: 3 } }, (_, fan) => { fan.forEach = items; })).find(item => item.path === "states.fan.join.first").message)
            .toBe("join.first is 3, but forEach lists 2 items: 3 successes can never happen.");
    });

    it("refuses stored IR whose join or time limit its version does not have, or that is malformed", () => {
        const first = compileWorkflowV2(yamlOf(joinDoc({ items: [{ ms: 0 }], join: { first: 1 }, timeoutSeconds: 10 })), PARALLEL);
        expect(first.valid, JSON.stringify(first.diagnostics)).toBe(true);
        const stored = JSON.parse(canonicalJson(first.ir));
        const read = value => parseWorkflowIr(value, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
        const withFan = change => ({ ...stored, nodes: { ...stored.nodes, fan: { ...stored.nodes.fan, ...change } } });
        for (const broken of [
            { ...stored, irVersion: 8 },
            { ...withFan({ timeoutSeconds: undefined }), irVersion: 8 },
            withFan({ join: { first: 0 } }),
            withFan({ join: { first: 2.5 } }),
            withFan({ join: { first: 1, extra: true } }),
            withFan({ join: "any" }),
            withFan({ timeoutSeconds: 0 }),
            withFan({ timeoutSeconds: true }),
        ]) {
            expect(() => read(JSON.parse(JSON.stringify(broken)))).toThrow(/stored IR/);
        }
        // An IR 8 state with neither reads back as it was.
        const plain = compileWorkflowV2(yamlOf(joinDoc({ items: [{ ms: 0 }] })), PARALLEL);
        expect(read(JSON.parse(canonicalJson(plain.ir)))).toEqual(plain.ir);
    });
});

// ─── J1b: the store's one count (pure) ───────────────────────

describe("workflow v2 parallel joins: the store's one count for the join and the time limit (J1b)", () => {
    const P = "nx-00ab";
    const ir = compileWorkflowV2(yamlOf(joinDoc({ items: [{ ms: 0 }, { ms: 0 }, { ms: 0 }], join: { first: 2 }, timeoutSeconds: 60 })), PARALLEL).ir;
    let clock = 0;
    /**
     * A stored node execution of branch `index`: completed (with `outcome`, `resultKind`, `winner`) or pending; a terminal
     * names its branch's wait as the state before it, every other state the parallel state.
     */
    const row = (index, nodeId, fields = {}) => ({
        nodeExecutionId: `${nodeId}-${index}`, scopeId: branchScopeId(P, index), nodeId, state: "completed", outcome: null, resultKind: null,
        output: { index }, error: null, winner: "controller", predecessorId: nodeId === "done" ? `hold-${index}` : P,
        enteredAt: new Date(1_000 + (clock += 1)), completedAt: new Date(2_000 + clock), ...fields,
    });
    const elapsed = (index, fields) => row(index, "hold", { outcome: "elapsed", resultKind: "business", ...fields });
    const done = index => row(index, "done", { outcome: "succeeded", resultKind: "business" });
    const failed = index => row(index, "hold", { outcome: "execution_failed", resultKind: "runtime_error", output: null, error: { code: "execution_failed" } });
    const states = (rows, committed, notStarted = []) => parallelBranchStates(ir, P, 3, rows, new Map(Object.entries(committed)), new Set(notStarted));
    const verdict = (branches, options = {}) => parallelVerdict({ join: { first: 2 }, failFast: false, total: 3, branches, pastDeadline: false, timeLimit: false, ...options });

    it("counts every success committed by the time limit, admitted or not, in commit order with ties by index (O3)", () => {
        // Branch 2 and branch 0 were committed at one instant (rank 1), branch 1 later: the first 2 are 0 and 2, in that order.
        const finished = states([elapsed(0), elapsed(1), elapsed(2)],
            { "hold-0": { rank: 1, inTime: true }, "hold-1": { rank: 2, inTime: true }, "hold-2": { rank: 1, inTime: true } });
        expect(finished.map(branch => [branch.ended, branch.success, branch.confirmed])).toEqual([
            ["finished", true, false], ["finished", true, false], ["finished", true, false]]);
        expect(parallelSuccesses(finished).map(branch => branch.index)).toEqual([0, 2, 1]);
        // Not admitted: the join waits for their terminals before the time limit, and is due after it.
        expect(verdict(finished)).toEqual({ kind: "wait" });
        expect(verdict(finished, { pastDeadline: true })).toEqual({ kind: "join_due", winners: [0, 2] });
        expect(verdict(finished, { pastDeadline: true, timeLimit: true })).toEqual({ kind: "join_due", winners: [0, 2] });
        // Admitted and decided at their terminals: joined with them, in commit order. The time limit itself never joins.
        const confirmed = states([elapsed(0), done(0), elapsed(1), elapsed(2), done(2)],
            { "hold-0": { rank: 2, inTime: true }, "done-0": { rank: 4, inTime: true }, "hold-1": { rank: 3, inTime: true },
                "hold-2": { rank: 1, inTime: true }, "done-2": { rank: 5, inTime: true } });
        expect(confirmed.map(branch => [branch.ended, branch.confirmed])).toEqual([["terminal", true], ["finished", false], ["terminal", true]]);
        const joined = verdict(confirmed);
        expect(joined.kind).toBe("joined");
        expect(joined.winners.map(branch => branch.index)).toEqual([2, 0]);
        expect(verdict(confirmed, { pastDeadline: true, timeLimit: true })).toEqual({ kind: "join_due", winners: [2, 0] });
        // H1: the first k in commit order decide, not the order the controller admitted their terminals in.
        const h1 = states([elapsed(0), done(0), elapsed(1)], { "hold-0": { rank: 2, inTime: false }, "done-0": { rank: 3, inTime: false },
            "hold-1": { rank: 1, inTime: true } });
        expect(parallelVerdict({ join: { first: 1 }, failFast: false, total: 3, branches: h1, pastDeadline: true, timeLimit: false }))
            .toEqual({ kind: "join_due", winners: [1] });
    });

    it("J1-R1: a branch's last state is the end of its predecessor chain, never the latest admission time or the greatest id", () => {
        // Its wait and its terminal were admitted in the same millisecond, and the terminal's id sorts first.
        const same = new Date(5_000);
        const wait = row(0, "hold", { nodeExecutionId: "z-hold-0", outcome: "elapsed", resultKind: "business", enteredAt: same });
        const end = row(0, "done", { nodeExecutionId: "a-done-0", outcome: "succeeded", resultKind: "business", enteredAt: same, predecessorId: "z-hold-0" });
        expect(branchLastState([wait, end]).nodeExecutionId).toBe("a-done-0");
        expect(branchLastState([end, wait]).nodeExecutionId).toBe("a-done-0");
        // The terminal also entered before its wait by the clock: the chain still decides.
        expect(branchLastState([{ ...wait, enteredAt: new Date(6_000) }, end]).nodeExecutionId).toBe("a-done-0");
        const [branch] = states([wait, end], { "z-hold-0": { rank: 1, inTime: true }, "a-done-0": { rank: 2, inTime: true } });
        expect(branch).toMatchObject({ ended: "terminal", nodeExecutionId: "a-done-0", success: true, confirmed: true, commit: { rank: 1 } });
        expect(parallelSuccesses(states([wait, end], { "z-hold-0": { rank: 1, inTime: true }, "a-done-0": { rank: 2, inTime: true } })).map(item => item.index))
            .toEqual([0]);
        // A scope that is not one chain (corrupt) falls back to the latest admitted end.
        expect(branchLastState([row(1, "hold", { nodeExecutionId: "x", predecessorId: P, enteredAt: new Date(1) }),
            row(1, "work", { nodeExecutionId: "y", predecessorId: P, enteredAt: new Date(2) })]).nodeExecutionId).toBe("y");
    });

    it("a success committed after the time limit does not count; a time-limit cancellation is no failure before it (Q1, Q3)", () => {
        const late = states([elapsed(0), done(0), elapsed(1), failed(2)],
            { "hold-0": { rank: 1, inTime: true }, "done-0": { rank: 4, inTime: true }, "hold-1": { rank: 2, inTime: false }, "hold-2": { rank: 3, inTime: false } });
        // One success counted, and the failure came after the time limit: timed_out, with the late success marked in the report.
        expect(verdict(late, { pastDeadline: true })).toEqual({ kind: "timed_out" });
        expect(parallelBranchEnd(late[1])).toMatchObject({ index: 1, ended: "finished", late: true });
        expect(parallelBranchEnd(late[0]).late).toBeUndefined();
        // Two failures by the time limit: k could no longer happen, so it is blocked with timedOut.
        const impossible = states([failed(0), failed(1), row(2, "hold", { state: "pending", outcome: null, resultKind: null, output: null, completedAt: null })],
            { "hold-0": { rank: 1, inTime: true }, "hold-1": { rank: 2, inTime: true } });
        expect(impossible.map(branch => branch.ended)).toEqual(["error", "error", "running"]);
        expect(verdict(impossible)).toEqual({ kind: "wait" });
        expect(verdict(impossible, { failFast: true })).toEqual({ kind: "blocked", timedOut: false, cancel: "failFast" });
        expect(verdict(impossible, { pastDeadline: true, timeLimit: true })).toEqual({ kind: "blocked", timedOut: true, cancel: "timeout" });
        // A branch the time limit cancelled is not a failure before it, even when its row's time equals the deadline.
        const cut = states([failed(0), row(1, "hold", { outcome: "cancelled", resultKind: "runtime_error", winner: "join_timeout", output: null })],
            { "hold-0": { rank: 1, inTime: true }, "hold-1": { rank: 2, inTime: true } });
        expect(cut[1]).toMatchObject({ ended: "cancelled", cancelledBy: "timeout", failure: true });
        expect(verdict(cut, { pastDeadline: true, timeLimit: true })).toEqual({ kind: "timed_out" });
    });

    it("blocks before the time limit only with failFast or when every branch ended; a branch that will not start has ended", () => {
        // Branch 2 never started; its controller will not start it (a cut), and two branches failed.
        const ended = states([failed(0), failed(1)], { "hold-0": { rank: 1, inTime: true }, "hold-1": { rank: 2, inTime: true } }, [2]);
        expect(ended.map(branch => [branch.ended, branch.done])).toEqual([["error", true], ["error", true], ["not_started", true]]);
        expect(verdict(ended)).toEqual({ kind: "blocked", timedOut: false, cancel: "failFast" });
        // The same branch only queued: the join waits for it.
        expect(verdict(states([failed(0), failed(1)], { "hold-0": { rank: 1, inTime: true }, "hold-1": { rank: 2, inTime: true } }))).toEqual({ kind: "wait" });
        // A result that routes to another step is finished but neither a success nor a failure; one that takes no route is an error.
        const routes = states([row(0, "work", { outcome: "hold", resultKind: "business" }), row(1, "work", { outcome: "nope", resultKind: "business" })],
            { "work-0": { rank: 1, inTime: true }, "work-1": { rank: 2, inTime: true } });
        expect(routes.slice(0, 2).map(branch => [branch.ended, branch.success, branch.failure, branch.nodeExecutionId])).toEqual([
            ["finished", false, false, "work-0"], ["error", false, true, "work-1"]]);
        // A join of every branch: joined in index order once each succeeded and was admitted.
        const all = states([elapsed(2), done(2), elapsed(0), done(0), elapsed(1), done(1)], Object.fromEntries(
            ["hold-2", "done-2", "hold-0", "done-0", "hold-1", "done-1"].map((id, at) => [id, { rank: at + 1, inTime: true }])));
        const joined = parallelVerdict({ join: "all_required", failFast: false, total: 3, branches: all, pastDeadline: false, timeLimit: false });
        expect(joined.kind).toBe("joined");
        expect(joined.winners.map(branch => branch.index)).toEqual([0, 1, 2]);
    });
});

// ─── The store ───────────────────────────────────────────────

/** A published workflow of `doc` with an admitted live run (no controller), and its parallel state's node execution id. */
async function storedRun(h, doc) {
    const parent = randomUUID();
    await h.catalog.createSession(parent, {});
    const yaml = yamlOf(doc);
    const compiled = compileWorkflowV2(yaml, PARALLEL);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    expect(await h.catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner: null,
        creationConfig: { workflowV2: { requestSha256: "join" } } })).toEqual({ created: true });
    await h.store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor: ACTOR,
        operationId: "create", requestSha256: "join", publish: true, title: "Workflow: join",
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
            inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION },
    });
    const fan = nodeExecutionIdFor(runId, "root", "fan", 1);
    return { workflowSessionId, runId, fan };
}

const enterFan = (h, { runId, fan }, seconds) => h.store.enterNode({
    runId, nodeExecutionId: fan, scopeId: "root", nodeId: "fan", ordinal: 1, nodeType: "parallel", predecessorId: null, arrivalRoute: null,
    inputText: canonicalJson([{ seconds: 600 }, { seconds: 600 }]), kvRevision: 1, waitSeconds: seconds, immediate: null,
});
const enterHold = (h, { runId, fan }, index) => h.store.enterNode({
    runId, nodeExecutionId: nodeExecutionIdFor(runId, branchScopeId(fan, index), "hold", 1), scopeId: branchScopeId(fan, index), nodeId: "hold",
    ordinal: 1, nodeType: "wait", predecessorId: fan, arrivalRoute: BRANCH_ROUTE, inputText: canonicalJson({ seconds: 600 }), kvRevision: 1,
    waitSeconds: 600, immediate: null,
});

describe("workflow v2 parallel joins: the store", () => {
    it("decides a parallel state's time limit once by its clock: not due, then timed_out with every branch's end and their work cancelled", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const run = await storedRun(h, joinDoc({ items: [{ seconds: 600 }, { seconds: 600 }], timeoutSeconds: 1 }));
            const entered = await enterFan(h, run, 1);
            expect(entered).toMatchObject({ admitted: true, node: { state: "pending", nodeType: "parallel" } });
            expect(entered.node.deadlineAt.getTime() - entered.node.enteredAt.getTime()).toBe(1_000);
            const hold = (await enterHold(h, run, 0)).node.nodeExecutionId;
            const projection = decided => ({ sessionId: run.workflowSessionId, events: [{ eventType: "workflow.state_failed",
                data: { runId: run.runId, nodeExecutionId: run.fan, outcome: "timed_out", branches: decided.total, succeeded: decided.succeeded } }] });
            const early = await h.store.elapseParallelNode(run.fan, projection);
            expect(early).toMatchObject({ result: "not_due", node: { state: "pending" } });
            expect(early.remainingMs).toBeGreaterThanOrEqual(1);
            expect(early.remainingMs).toBeLessThanOrEqual(1_000);

            const elapsed = await until(async () => {
                const result = await h.store.elapseParallelNode(run.fan, projection);
                return result.result === "elapsed" ? result : null;
            }, "the time limit to pass", 10_000);
            expect(elapsed.cancelled).toEqual([hold]);
            const report = {
                joined: false, timedOut: true, total: 2, needed: 2, succeeded: 0, failFast: false,
                branches: [
                    { index: 0, ended: "cancelled", nodeExecutionId: hold, outcome: "cancelled", resultKind: "runtime_error", cancelledBy: "timeout",
                        error: { code: "cancelled", message: "The parallel state's time limit passed before its join, so this branch was cancelled." } },
                    { index: 1, ended: "not_started", nodeExecutionId: null, outcome: null, resultKind: null },
                ],
            };
            expect(await h.store.readNodeExecution(run.fan)).toMatchObject({
                state: "completed", outcome: "timed_out", resultKind: "runtime_error", winner: "controller",
                error: { code: "timed_out", message: PARALLEL_TIMEOUT_MESSAGE, details: report },
            });
            const fanRow = await h.store.readNodeExecution(run.fan);
            expect(fanRow.completedAt.getTime()).toBeGreaterThanOrEqual(fanRow.deadlineAt.getTime());
            expect(await h.store.readNodeExecution(hold)).toMatchObject({ state: "completed", outcome: "cancelled", winner: "join_timeout" });
            const events = await h.catalog.getSessionEvents(run.workflowSessionId, 0, 200);
            // S6-UI2: the end event carries the row's completed_at.
            expect(events.filter(event => event.data?.nodeExecutionId === run.fan && event.eventType === "workflow.state_failed").map(event => event.data))
                .toEqual([{ runId: run.runId, nodeExecutionId: run.fan, outcome: "timed_out", branches: 2, succeeded: 0,
                    completedAt: fanRow.completedAt.toISOString() }]);
            expect(events.filter(event => event.eventType === "workflow.branches_cancelled").map(event => event.data)).toEqual([expect.objectContaining({
                runId: run.runId, cancelled: [hold], cancelledCount: 1, reason: "timeout" })]);

            // Once only: the time limit again, a join after it, and a later result of the branch all find it decided.
            expect(await h.store.elapseParallelNode(run.fan, projection)).toMatchObject({ result: "decided", node: { outcome: "timed_out" } });
            expect(await h.store.completeNode(run.fan, { outcome: "joined", resultKind: "business", valueText: "[]", winner: "controller" }))
                .toMatchObject({ won: false, node: { outcome: "timed_out" } });
            expect(await h.store.completeNode(hold, { outcome: "elapsed", resultKind: "business", valueText: "{}", winner: "controller" }))
                .toMatchObject({ won: false, node: { outcome: "cancelled" } });
            // A branch of the decided state admits nothing more.
            expect(await enterHold(h, run, 1)).toMatchObject({ admitted: false, reason: "cut" });
            expect(await h.store.readNodeExecution(nodeExecutionIdFor(run.runId, branchScopeId(run.fan, 1), "hold", 1))).toBeFalsy();
            // The controller's cut of the branches finds what the time limit cancelled, with why, for their effects and children.
            expect(await h.store.cancelBranchScopes({ runId: run.runId, scopeIds: [0, 1].map(index => branchScopeId(run.fan, index)), reason: "timeout" }))
                .toEqual({ active: true, cancelled: [{ nodeExecutionId: hold, nodeType: "wait", reason: "timeout" }] });
            // It cancelled nothing new, so it recorded nothing new.
            expect((await h.catalog.getSessionEvents(run.workflowSessionId, 0, 200)).filter(event => event.eventType === "workflow.branches_cancelled")).toHaveLength(1);
        } finally {
            await h.stop();
        }
    });

    it("a join decided first keeps the state from its time limit; a join's cancellation is recorded as such", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const run = await storedRun(h, joinDoc({ items: [{ seconds: 600 }, { seconds: 600 }], join: { first: 1 }, timeoutSeconds: 1 }));
            await enterFan(h, run, 1);
            const first = (await enterHold(h, run, 0)).node.nodeExecutionId;
            const second = (await enterHold(h, run, 1)).node.nodeExecutionId;
            // The first branch won the join of the first 1: the other is cancelled for the join, then the state is joined.
            await h.store.completeNode(first, { outcome: "elapsed", resultKind: "business", valueText: "{}", winner: "controller" });
            expect(await h.store.cancelBranchScopes({ runId: run.runId, scopeIds: [branchScopeId(run.fan, 1)], reason: "join" }))
                .toEqual({ active: true, cancelled: [{ nodeExecutionId: second, nodeType: "wait", reason: "join" }] });
            expect(await h.store.readNodeExecution(second)).toMatchObject({ outcome: "cancelled", winner: "join",
                error: { code: "cancelled", message: "The parallel state's join had the successes it needs, so this branch was cancelled." } });
            expect(await h.store.completeNode(run.fan, { outcome: "joined", resultKind: "business", valueText: "[]", winner: "controller" }))
                .toMatchObject({ won: true });
            // Past the time limit, it finds the state decided and changes nothing.
            await pause(1_100);
            expect(await h.store.elapseParallelNode(run.fan)).toMatchObject({ result: "decided", node: { outcome: "joined", resultKind: "business" } });
            expect(await h.store.readNodeExecution(first)).toMatchObject({ outcome: "elapsed" });
        } finally {
            await h.stop();
        }
    });
});

// ─── J1b: the store's one count, in the store ────────────────

/** A run's branch state ids, and store calls that stand in for a controller that is slow, or admits in another order. */
function branchesOf(h, run) {
    const at = (index, nodeId) => nodeExecutionIdFor(run.runId, branchScopeId(run.fan, index), nodeId, 1);
    const enter = (index, nodeId, nodeType, predecessorId, arrivalRoute, waitSeconds = null) => h.store.enterNode({
        runId: run.runId, nodeExecutionId: at(index, nodeId), scopeId: branchScopeId(run.fan, index), nodeId, ordinal: 1, nodeType, predecessorId,
        arrivalRoute, inputText: canonicalJson({ index }), kvRevision: 1, waitSeconds, immediate: null,
    });
    const result = (outcome, value) => ({ outcome, resultKind: "business", valueText: canonicalJson(value), winner: "controller" });
    return {
        at,
        /** The branch's wait, entered as its first state (pending). */
        hold: index => enter(index, "hold", "wait", run.fan, BRANCH_ROUTE, 600),
        /** Its work, entered as its first state (pending). */
        work: index => enter(index, "work", "script", run.fan, BRANCH_ROUTE),
        /** The wait's success (elapsed, which routes to the succeeded terminal), stored now. */
        succeed: index => h.store.completeNode(at(index, "hold"), result("elapsed", { index })),
        /** The wait's error with no route: the branch ends without success. */
        fail: index => h.store.completeNode(at(index, "hold"), { outcome: "execution_failed", resultKind: "runtime_error",
            valueText: canonicalJson({ code: "execution_failed", message: "no" }), winner: "controller" }),
        /** Admit the branch's terminal and decide it succeeded, as the controller's endBranch does. */
        confirm: async index => {
            const entered = await enter(index, "done", "terminal", at(index, "hold"), "elapsed");
            expect(entered, `the terminal of branch ${index}`).toMatchObject({ admitted: true });
            return h.store.completeNode(at(index, "done"), result("succeeded", { index }));
        },
        /** The join's question, as the join activity asks it. */
        join: (notStarted = []) => h.store.decideParallelJoin({ nodeExecutionId: run.fan, notStarted,
            joined: output => ({ outcome: "joined", resultKind: "business", valueText: canonicalJson(output), winner: "controller" }) }),
    };
}
const enterFanOf = (h, { runId, fan }, items, seconds) => h.store.enterNode({
    runId, nodeExecutionId: fan, scopeId: "root", nodeId: "fan", ordinal: 1, nodeType: "parallel", predecessorId: null, arrivalRoute: null,
    inputText: canonicalJson(items), kvRevision: 1, waitSeconds: seconds, immediate: null,
});
/** Wait until the store's clock is past the parallel state's deadline. */
const pastDeadlineOf = async (h, run) => {
    const { deadlineAt } = await h.store.readNodeExecution(run.fan);
    await until(async () => Date.now() >= deadlineAt.getTime() + 300, "the time limit to pass", 10_000);
};

describe("workflow v2 parallel joins: the store's one count for the join and the time limit (J1b)", () => {
    it("(a) the time limit with k successes committed by it, none admitted, is a join due: nothing decided, the rest cancelled; the join then joins them", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const run = await storedRun(h, joinDoc({ items: [{ seconds: 600 }, { seconds: 600 }, { seconds: 600 }], join: { first: 1 }, timeoutSeconds: 1 }));
            await enterFanOf(h, run, [{ seconds: 600 }, { seconds: 600 }, { seconds: 600 }], 1);
            const b = branchesOf(h, run);
            await b.hold(0);
            await b.hold(1);
            await b.succeed(0);
            // Before the time limit its terminal is not admitted yet: the join waits.
            expect(await b.join()).toMatchObject({ result: "wait", node: { state: "pending" } });
            await pastDeadlineOf(h, run);
            const due = await h.store.elapseParallelNode(run.fan);
            expect(due).toMatchObject({ result: "join_due", node: { state: "pending" }, cancelled: [b.at(1, "hold")] });
            expect(await h.store.readNodeExecution(b.at(1, "hold"))).toMatchObject({ outcome: "cancelled", winner: "join_timeout" });
            // Again: still due, nothing new.
            expect(await h.store.elapseParallelNode(run.fan)).toMatchObject({ result: "join_due", cancelled: [] });
            // Past the time limit a branch admits only its terminal: branch 2 does not start; branch 0's terminal is admitted.
            expect(await b.hold(2)).toMatchObject({ admitted: false, reason: "cut" });
            expect(await b.join([])).toMatchObject({ result: "wait" });
            await b.confirm(0);
            const joined = await b.join([2]);
            expect(joined).toMatchObject({ result: "won", node: { state: "completed", outcome: "joined", output: [{ index: 0, output: { index: 0 } }] } });
            // Exactly one decision (O1): the time limit, and the join again, find it decided.
            expect(await h.store.elapseParallelNode(run.fan)).toMatchObject({ result: "decided", node: { outcome: "joined" } });
            expect(await b.join([2])).toMatchObject({ result: "decided", node: { outcome: "joined" } });
        } finally {
            await h.stop();
        }
    });

    it("(b) a k-th success committed after the deadline does not count when the join is reached first: timed_out, the late success marked", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const run = await storedRun(h, joinDoc({ items: [{ seconds: 600 }, { seconds: 600 }], join: { first: 1 }, timeoutSeconds: 1 }));
            await enterFanOf(h, run, [{ seconds: 600 }, { seconds: 600 }], 1);
            const b = branchesOf(h, run);
            await b.hold(0);
            await pastDeadlineOf(h, run);
            // No time-limit decision ran: the success is stored after the deadline, and the controller admits its terminal and asks.
            await b.succeed(0);
            await b.confirm(0);
            const decided = await b.join([1]);
            expect(decided).toMatchObject({ result: "won", node: { outcome: "timed_out", resultKind: "runtime_error" } });
            expect(decided.node.error).toEqual({ code: "timed_out", message: PARALLEL_TIMEOUT_MESSAGE, details: {
                joined: false, timedOut: true, total: 2, needed: 1, succeeded: 0, failFast: false,
                branches: [
                    { index: 0, ended: "terminal", nodeExecutionId: b.at(0, "done"), outcome: "succeeded", resultKind: "business", output: { index: 0 }, late: true },
                    { index: 1, ended: "not_started", nodeExecutionId: null, outcome: null, resultKind: null },
                ],
            } });
        } finally {
            await h.stop();
        }
    });

    it("(c) k impossible before the time limit without failFast: the join waits; the time limit decides blocked with timedOut (Q3)", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const items = [{ seconds: 600 }, { seconds: 600 }, { seconds: 600 }];
            const run = await storedRun(h, joinDoc({ items, join: { first: 2 }, timeoutSeconds: 1 }));
            await enterFanOf(h, run, items, 1);
            const b = branchesOf(h, run);
            for (const index of [0, 1, 2]) await b.hold(index);
            await b.fail(0);
            await b.fail(1);
            // Two of three failed: 2 successes can no longer happen. Without failFast the third runs on.
            expect(await b.join()).toMatchObject({ result: "wait" });
            await pastDeadlineOf(h, run);
            const decided = await h.store.elapseParallelNode(run.fan);
            expect(decided).toMatchObject({ result: "elapsed", cancelled: [b.at(2, "hold")], node: { outcome: "blocked", resultKind: "business" } });
            expect(decided.node.output).toMatchObject({ joined: false, timedOut: true, total: 3, needed: 2, succeeded: 0, failFast: false });
            expect(decided.node.output.branches.map(branch => [branch.index, branch.ended, branch.cancelledBy ?? null])).toEqual([
                [0, "error", null], [1, "error", null], [2, "cancelled", "timeout"]]);
            expect(await h.store.readNodeExecution(b.at(2, "hold"))).toMatchObject({ winner: "join_timeout" });
        } finally {
            await h.stop();
        }
    });

    it("(d) the report keeps a finished branch's result when its next state was never admitted, with every index once (O4)", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const items = [{ seconds: 600 }, { seconds: 600 }, { seconds: 600 }, { seconds: 600 }];
            const run = await storedRun(h, joinDoc({ items, timeoutSeconds: 1 }));
            await enterFanOf(h, run, items, 1);
            const b = branchesOf(h, run);
            await b.hold(0);
            await b.succeed(0);
            // Branch 1's work routed to its wait, which was never admitted.
            await b.work(1);
            await h.store.completeNode(b.at(1, "work"), { outcome: "hold", resultKind: "business", valueText: canonicalJson({ index: 1, seconds: 600 }), winner: "controller" });
            await b.hold(2);
            await pastDeadlineOf(h, run);
            const decided = await h.store.elapseParallelNode(run.fan);
            expect(decided).toMatchObject({ result: "elapsed", node: { outcome: "timed_out" }, cancelled: [b.at(2, "hold")] });
            const report = decided.node.error.details;
            expect(report).toMatchObject({ joined: false, timedOut: true, total: 4, needed: 4, succeeded: 1 });
            expect(report.branches).toEqual([
                { index: 0, ended: "finished", nodeExecutionId: b.at(0, "hold"), outcome: "elapsed", resultKind: "business", output: { index: 0 } },
                { index: 1, ended: "finished", nodeExecutionId: b.at(1, "work"), outcome: "hold", resultKind: "business", output: { index: 1, seconds: 600 } },
                { index: 2, ended: "cancelled", nodeExecutionId: b.at(2, "hold"), outcome: "cancelled", resultKind: "runtime_error", cancelledBy: "timeout",
                    error: expect.objectContaining({ code: "cancelled" }) },
                { index: 3, ended: "not_started", nodeExecutionId: null, outcome: null, resultKind: null },
            ]);
        } finally {
            await h.stop();
        }
    });

    it("H1: k = 1, A committed on time and not admitted, B committed late and admitted first: joined with A, with or without a join due first", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            for (const timeFirst of [false, true]) {
                const items = [{ seconds: 600 }, { seconds: 600 }];
                const run = await storedRun(h, joinDoc({ items, join: { first: 1 }, timeoutSeconds: 1 }));
                await enterFanOf(h, run, items, 1);
                const b = branchesOf(h, run);
                await b.hold(0);
                await b.hold(1);
                // A is branch 1, on time; B is branch 0, after the deadline.
                await b.succeed(1);
                await pastDeadlineOf(h, run);
                await b.succeed(0);
                if (timeFirst) expect(await h.store.elapseParallelNode(run.fan), "the time limit first").toMatchObject({ result: "join_due", cancelled: [] });
                // B's terminal is admitted first (its cursor comes first): B does not count, A is not admitted yet.
                await b.confirm(0);
                expect(await b.join(), `B admitted first (time limit first: ${timeFirst})`).toMatchObject({ result: "wait" });
                await b.confirm(1);
                expect(await b.join(), `then A (time limit first: ${timeFirst})`).toMatchObject({ result: "won",
                    node: { outcome: "joined", output: [{ index: 1, output: { index: 1 } }] } });
            }
        } finally {
            await h.stop();
        }
    });

    it("J1-R1 in the store: a terminal admitted in the same instant as its wait is the branch's last state; the join joins it", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const items = [{ seconds: 600 }, { seconds: 600 }];
            const run = await storedRun(h, joinDoc({ items, join: { first: 1 } }));
            await enterFanOf(h, run, items, null);
            const b = branchesOf(h, run);
            await b.hold(0);
            await b.hold(1);
            await b.succeed(0);
            await b.confirm(0);
            // Both of branch 0's states now carry one admission instant, to the microsecond.
            await h.q("UPDATE SCHEMA.workflow_node_executions SET entered_at = (SELECT entered_at FROM SCHEMA.workflow_node_executions WHERE node_execution_id = $1) "
                + "WHERE node_execution_id = $2", [b.at(0, "hold"), b.at(0, "done")]);
            const [hold, done] = await Promise.all([b.at(0, "hold"), b.at(0, "done")].map(id => h.store.readNodeExecution(id)));
            expect(done.enteredAt.getTime()).toBe(hold.enteredAt.getTime());
            expect(await b.join()).toMatchObject({ result: "won", node: { outcome: "joined", output: [{ index: 0, output: { index: 0 } }] },
                cancelled: [b.at(1, "hold")] });
        } finally {
            await h.stop();
        }
    });

    it("joins the first k in commit order, not in index or admission order (O3); the others are cancelled by the join", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const items = [{ seconds: 600 }, { seconds: 600 }, { seconds: 600 }, { seconds: 600 }];
            const run = await storedRun(h, joinDoc({ items, join: { first: 2 } }));
            await enterFanOf(h, run, items, null);
            const b = branchesOf(h, run);
            for (const index of [0, 1, 2, 3]) await b.hold(index);
            await b.succeed(2);
            await b.succeed(0);
            await b.succeed(1);
            // Admitted in index order: after 0 and 1 the first two committed (2, then 0) are not both admitted yet.
            await b.confirm(0);
            await b.confirm(1);
            expect(await b.join()).toMatchObject({ result: "wait" });
            await b.confirm(2);
            const joined = await b.join();
            expect(joined).toMatchObject({ result: "won", node: { outcome: "joined", output: [{ index: 2, output: { index: 2 } }, { index: 0, output: { index: 0 } }] },
                cancelled: [b.at(3, "hold")] });
            expect(await h.store.readNodeExecution(b.at(3, "hold"))).toMatchObject({ outcome: "cancelled", winner: "join" });
            // The joined state lets no branch admit anything more (O5).
            expect(await b.work(3)).toMatchObject({ admitted: false, reason: "cut" });
        } finally {
            await h.stop();
        }
    });
});

// ─── Controller 1.9.0 on a native runtime ────────────────────

/**
 * Worker slots for these runtimes. A branch's script holds a worker slot for its whole run, and every controller step
 * (collect, admit, the join, the cancellation of the others) needs one too. duroxide's default is 2 (core
 * RuntimeOptions::default, which the JS binding starts from; its typings say 8), so with more scripts than slots the
 * branches run in waves and the controller waits behind them (DEV of 206c4198). 16 runs the widest case here (4
 * scripts) at once with room for the controller; one case runs with 2 on purpose.
 */
const WORKER_SLOTS = 16;

/** A worker-equivalent registration with workflowRequests and the request tag declared. */
async function harness(env, { wakeBackstopMs = 500, workerConcurrency = WORKER_SLOTS } = {}) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerConcurrency, workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs,
        workflowRequests: true,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
    });
    await runtime.start();
    return {
        catalog, store, client, host: { catalog, store, duroxideClient: client, requests: true },
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

/** A parent session and a started live run of `doc` it created, with the ids of its parallel state and its branches' states. */
async function started(h, doc) {
    const parent = randomUUID();
    await h.catalog.createSession(parent, {});
    const workflowSessionId = randomUUID();
    const created = await createWorkflowV2(h.host, {
        workflowSessionId, parentSessionId: parent, yaml: yamlOf(doc), actor: ACTOR, operationId: "start", start: { inputs: {} },
    });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    const runId = created.receipt.run.runId;
    const fan = nodeExecutionIdFor(runId, "root", "fan", 1);
    return { parent, workflowSessionId, runId, fan, at: (index, nodeId) => nodeExecutionIdFor(runId, branchScopeId(fan, index), nodeId, 1) };
}

const ENDED = ["completed", "failed", "cancelled", "stopped"];
const ended = (h, runId, timeoutMs = 60_000) => until(async () => {
    const run = await h.store.readRun(runId);
    return run && ENDED.includes(run.status) ? run : null;
}, `run ${runId} to end`, timeoutMs);
const branchRows = async (h, runId, fan, index) => (await h.store.listNodeExecutions(runId)).filter(node => node.scopeId === branchScopeId(fan, index));
const eventsOf = async (h, workflowSessionId) => h.catalog.getSessionEvents(workflowSessionId, 0, 1_000);

/** The inputs of every `name` activity a controller instance scheduled, in every execution (selected by the name token first). */
async function scheduledInputs(client, instanceId, name) {
    const executions = await client.listExecutions(instanceId);
    const histories = await Promise.all(executions.map(id => client.readExecutionHistory(instanceId, id)));
    const prefix = `{"name":${JSON.stringify(name)}`;
    return histories.flat().filter(event => event.kind === "ActivityScheduled" && String(event.data).startsWith(prefix)).map(event => {
        const payload = JSON.parse(event.data);
        return typeof payload.input === "string" ? JSON.parse(payload.input) : payload.input;
    });
}

describe("workflow v2 parallel joins of the first k: controller 1.9.0 (inactive, test-only registration)", () => {
    it("a race of three scripts: the first success joins, the others are cancelled with their effects, and nothing of theirs is routed later", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const begun = Date.now();
            const { workflowSessionId, runId, fan, at } = await started(h, joinDoc({ items: [{ ms: 200 }, { ms: 5_000 }, { ms: 9_000 }], join: { first: 1 } }));
            const run = await ended(h, runId);
            const won = [{ index: 0, output: { index: 0, ms: 200 } }];
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalNodeId: "finished", terminalOutput: won });
            expect(await h.store.readNodeExecution(fan)).toMatchObject({ state: "completed", outcome: "joined", resultKind: "business", output: won });
            for (const index of [1, 2]) {
                expect(await h.store.readNodeExecution(at(index, "work"))).toMatchObject({
                    state: "completed", outcome: "cancelled", resultKind: "runtime_error", winner: "join", error: { code: "cancelled" },
                });
            }
            const events = await eventsOf(h, workflowSessionId);
            // J1d: the cancellation names only the branches still running; the winner (#0) ended at its terminal and is not cut.
            expect(events.filter(event => event.eventType === "workflow.branches_cancelled").map(event => event.data)).toEqual([expect.objectContaining({
                runId, scopeIds: [1, 2].map(index => branchScopeId(fan, index)), cancelled: [at(1, "work"), at(2, "work")].sort(), cancelledCount: 2, reason: "join",
            })]);
            const asked = events.filter(event => event.eventType === "workflow.cancel_requested").map(event => event.data);
            expect(asked).toEqual([expect.objectContaining({ runId, branchesCancelled: "join" })]);
            expect(asked[0].effects.map(effect => effect.nodeExecutionId).sort()).toEqual([at(1, "work"), at(2, "work")].sort());

            // Nothing of the losers is routed later: past the slowest script's length, their branches hold only the cancelled state.
            await until(async () => Date.now() - begun >= 10_000, "the slowest script's length");
            for (const index of [1, 2]) {
                expect((await branchRows(h, runId, fan, index)).map(node => [node.nodeId, node.outcome, node.winner])).toEqual([["work", "cancelled", "join"]]);
            }
            expect((await h.store.listNodeExecutions(runId)).filter(node => node.scopeId === "root").map(node => node.nodeId)).toEqual(["fan", "finished"]);
            expect(await h.store.hasPendingNodes(runId)).toBe(false);
        } finally {
            await h.stop();
        }
    });

    it("the first 2 of 4 join in the order they finished; the other two are cancelled for the join", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { runId, fan, at } = await started(h, joinDoc({ items: [{ ms: 6_000 }, { ms: 200 }, { ms: 10_000 }, { ms: 1_800 }], join: { first: 2 } }));
            const run = await ended(h, runId);
            const won = [{ index: 1, output: { index: 1, ms: 200 } }, { index: 3, output: { index: 3, ms: 1_800 } }];
            expect(run).toMatchObject({ status: "completed", terminalNodeId: "finished", terminalOutput: won });
            expect(await h.store.readNodeExecution(fan)).toMatchObject({ outcome: "joined", output: won });
            for (const index of [0, 2]) expect(await h.store.readNodeExecution(at(index, "work"))).toMatchObject({ outcome: "cancelled", winner: "join" });
            for (const index of [1, 3]) expect(await h.store.readNodeExecution(at(index, "done"))).toMatchObject({ outcome: "succeeded" });
        } finally {
            await h.stop();
        }
    });

    it("with fewer worker slots than branches: the first success the store committed wins; a loser committed before the cancel stays succeeded, not a winner", { timeout: TIMEOUT }, async () => {
        // 2 slots for 3 scripts: they run in waves, and the controller's steps wait behind them (as in production with the
        // default PILOTSWARM_WORKER_CONCURRENCY of 2). The rule that still holds is the store's commit order.
        const h = await harness(getEnv(), { workerConcurrency: 2 });
        try {
            const items = [{ ms: 300 }, { ms: 2_000 }, { ms: 2_500 }];
            const { runId, fan, at } = await started(h, joinDoc({ items, join: { first: 1 } }));
            const run = await ended(h, runId, 90_000);
            expect(run).toMatchObject({ status: "completed", terminalNodeId: "finished" });
            const works = await Promise.all([0, 1, 2].map(index => h.store.readNodeExecution(at(index, "work"))));
            const successes = works.map((row, index) => ({ row, index })).filter(item => item.row?.outcome === "ok")
                .sort((a, b) => a.row.completedAt.getTime() - b.row.completedAt.getTime() || a.index - b.index);
            expect(successes.length).toBeGreaterThanOrEqual(1);
            const [first, ...later] = successes;
            expect(run.terminalOutput).toEqual([{ index: first.index, output: { index: first.index, ...items[first.index] } }]);
            expect(await h.store.readNodeExecution(fan)).toMatchObject({ outcome: "joined", output: run.terminalOutput });
            // A loser that committed its success before the join's decision keeps it, and is not a winner.
            for (const { row, index } of later) {
                expect(row, `branch ${index}`).toMatchObject({ state: "completed", outcome: "ok", resultKind: "business", winner: "effect" });
                expect(row.completedAt.getTime()).toBeGreaterThanOrEqual(first.row.completedAt.getTime());
            }
            // Every other loser's work was cancelled for the join.
            for (const [index, row] of works.entries()) {
                if (row?.outcome !== "ok") expect(row, `branch ${index}`).toMatchObject({ state: "completed", outcome: "cancelled", winner: "join" });
            }
            expect(await h.store.hasPendingNodes(runId)).toBe(false);
        } finally {
            await h.stop();
        }
    });

    it("k that can no longer happen: failFast cancels the rest at once; without it they run to their end, then the join blocks", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const fast = await started(h, joinDoc({ items: [{ fail: true, ms: 100 }, { fail: true, ms: 300 }, { seconds: 600 }], join: { first: 2 }, failFast: true }));
            const run = await ended(h, fast.runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "stuck" });
            expect(run.terminalOutput).toMatchObject({ joined: false, timedOut: false, total: 3, needed: 2, succeeded: 0, failFast: true });
            expect(run.terminalOutput.branches.map(branch => (branch.index < 2 ? failedBranchEnd(branch, fast.at(branch.index, "work"))
                : [branch.index, branch.ended, branch.outcome]))).toEqual([
                [0, "terminal", "blocked"], [1, "terminal", "blocked"], [2, "cancelled", "cancelled"]]);
            const cut = await branchRows(h, fast.runId, fast.fan, 2);
            expect(cut.filter(node => node.winner === "fail_fast").map(node => node.outcome)).toEqual(["cancelled"]);
            expect(cut.some(node => node.nodeId === "done")).toBe(false);

            const slow = await started(h, joinDoc({ items: [{ fail: true, ms: 100 }, { fail: true, ms: 300 }, { seconds: 3 }], join: { first: 2 } }));
            const after = await ended(h, slow.runId);
            expect(after).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "stuck" });
            expect(after.terminalOutput).toMatchObject({ joined: false, timedOut: false, total: 3, needed: 2, succeeded: 1, failFast: false });
            expect(after.terminalOutput.branches[2]).toMatchObject({ index: 2, ended: "terminal", outcome: "succeeded", output: { index: 2, seconds: 3 } });
            // The join waited for the last branch's end.
            const done = await h.store.readNodeExecution(slow.at(2, "done"));
            expect((await h.store.readNodeExecution(slow.fan)).completedAt.getTime()).toBeGreaterThanOrEqual(done.completedAt.getTime());
        } finally {
            await h.stop();
        }
    });

    it("a binding with fewer items than k blocks at once without starting a branch; so do no items", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const few = await started(h, joinDoc({ items: [{ ms: 0 }, { ms: 0 }], join: { first: 3 } }));
            const run = await ended(h, few.runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "stuck", terminalOutput: {
                joined: false, timedOut: false, total: 2, needed: 3, succeeded: 0, failFast: false,
                branches: [0, 1].map(index => ({ index, ended: "not_started", nodeExecutionId: null, outcome: null, resultKind: null })),
            } });
            expect((await h.store.listNodeExecutions(few.runId)).map(node => node.nodeId).sort()).toEqual(["fan", "stuck"]);

            const none = await started(h, joinDoc({ items: [], join: { first: 1 } }));
            expect(await ended(h, none.runId)).toMatchObject({ terminalNodeId: "stuck", terminalOutput: {
                joined: false, timedOut: false, total: 0, needed: 1, succeeded: 0, failFast: false, branches: [] } });
            // With every branch needed, no items still joins with none (as before).
            const all = await started(h, joinDoc({ items: [] }));
            expect(await ended(h, all.runId)).toMatchObject({ terminalNodeId: "finished", terminalOutput: [] });
        } finally {
            await h.stop();
        }
    });
});

describe("workflow v2 parallel time limits: controller 1.9.0 (inactive, test-only registration)", () => {
    it("ends the state timed_out with 1 of 3 finished: its output kept, the running branch cancelled, the queued one not started; a late result loses", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { workflowSessionId, runId, fan, at } = await started(h, joinDoc({ items: [{ ms: 0 }, { seconds: 600 }, { seconds: 600 }], concurrency: 1,
                timeoutSeconds: 2 }));
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "late" });
            const fanRow = await h.store.readNodeExecution(fan);
            expect(fanRow).toMatchObject({ state: "completed", outcome: "timed_out", resultKind: "runtime_error", winner: "controller" });
            expect(fanRow.deadlineAt.getTime() - fanRow.enteredAt.getTime()).toBe(2_000);
            expect(fanRow.completedAt.getTime()).toBeGreaterThanOrEqual(fanRow.deadlineAt.getTime());
            const cut = (await branchRows(h, runId, fan, 1)).find(node => node.winner === "join_timeout");
            expect(cut).toMatchObject({ state: "completed", outcome: "cancelled", winner: "join_timeout" });
            const report = {
                joined: false, timedOut: true, total: 3, needed: 3, succeeded: 1, failFast: false,
                branches: [
                    { index: 0, ended: "terminal", nodeExecutionId: at(0, "done"), outcome: "succeeded", resultKind: "business", output: { index: 0, ms: 0 } },
                    { index: 1, ended: "cancelled", nodeExecutionId: cut.nodeExecutionId, outcome: "cancelled", resultKind: "runtime_error", cancelledBy: "timeout",
                        error: expect.objectContaining({ code: "cancelled" }) },
                    { index: 2, ended: "not_started", nodeExecutionId: null, outcome: null, resultKind: null },
                ],
            };
            expect(fanRow.error).toEqual({ code: "timed_out", message: PARALLEL_TIMEOUT_MESSAGE, details: report });
            // On its route, the run took the error envelope as its input.
            expect(run.terminalOutput).toEqual({ code: "timed_out", message: PARALLEL_TIMEOUT_MESSAGE, details: report });
            expect(await branchRows(h, runId, fan, 2)).toEqual([]);
            // A late result of the cancelled branch loses, and nothing of it is admitted.
            expect(await h.store.completeNode(cut.nodeExecutionId, { outcome: "elapsed", resultKind: "business", valueText: "{}", winner: "controller" }))
                .toMatchObject({ won: false });
            expect((await branchRows(h, runId, fan, 1)).map(node => node.nodeId)).not.toContain("done");

            const events = await eventsOf(h, workflowSessionId);
            expect(events.filter(event => event.data?.nodeExecutionId === fan && event.eventType.startsWith("workflow.state_")).map(event => event.eventType))
                .toEqual(["workflow.state_started", "workflow.state_failed"]);
            expect(events.find(event => event.eventType === "workflow.state_failed" && event.data.nodeExecutionId === fan).data)
                .toMatchObject({ outcome: "timed_out", resultKind: "runtime_error", branches: 3, succeeded: 1 });
            expect(events.filter(event => event.eventType === "workflow.branches_cancelled").map(event => event.data))
                .toEqual([expect.objectContaining({ cancelled: [cut.nodeExecutionId], reason: "timeout" })]);
            // read_workflow: the graph says the join and the time limit; the parallel state's visit says its deadline.
            const view = await readWorkflowV2View(h.store, workflowSessionId);
            expect(view.graph.states.find(state => state.id === "fan")).toMatchObject({ join: "all_required", timeoutSeconds: 2 });
            expect(view.run.nodeExecutions.find(node => node.nodeExecutionId === fan)).toMatchObject({
                outcome: "timed_out", resultKind: "runtime_error", deadline: fanRow.deadlineAt.toISOString(), branches: 3,
                completedAt: fanRow.completedAt.toISOString() });
            expect(view.run.nodeExecutions.find(node => node.nodeExecutionId === cut.nodeExecutionId)).toMatchObject({ winner: "join_timeout" });
            // J1c: a branch state names the state before it and says when it ended; a root state other than a parallel one
            // has neither.
            expect(view.run.nodeExecutions.find(node => node.nodeExecutionId === at(0, "done"))).toMatchObject({
                predecessorId: at(0, "work"), completedAt: (await h.store.readNodeExecution(at(0, "done"))).completedAt.toISOString() });
            expect(view.run.nodeExecutions.find(node => node.nodeExecutionId === at(0, "work"))).toMatchObject({ predecessorId: fan });
            const lateRow = view.run.nodeExecutions.find(node => node.stateId === "late");
            expect([lateRow?.completedAt, lateRow?.predecessorId]).toEqual([undefined, undefined]);
        } finally {
            await h.stop();
        }
    });

    // J1b (e): at one instant of a test run's clock, the branch's result at the time limit is decided first and counts.
    it("the time limit and the last branch at one instant of a test run's clock: the branch's result counts, and the state joins once", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parentId = randomUUID();
            await h.catalog.createSession(parentId, {});
            const workflowSessionId = randomUUID();
            const created = await createWorkflowV2(h.host, { workflowSessionId, parentSessionId: parentId,
                yaml: yamlOf(joinDoc({ items: [{ seconds: 60 }], timeoutSeconds: 60 })), actor: ACTOR, operationId: "create" });
            expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
            const update = async args => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowSessionId, ...args },
                { callerSessionId: parentId, host: h.host }));
            const test = await update({ operation: "test", operation_id: "test-1", expected_revision: 1, definition_hash: created.receipt.yamlSha256, inputs: {} });
            expect(test, JSON.stringify(test)).toMatchObject({ ok: true, run: { mode: "test" } });
            const runId = test.run.runId;
            const fan = nodeExecutionIdFor(runId, "root", "fan", 1);
            const hold = nodeExecutionIdFor(runId, branchScopeId(fan, 0), "hold", 1);
            const [fanRow, holdRow] = await until(async () => {
                const rows = await Promise.all([h.store.readNodeExecution(fan), h.store.readNodeExecution(hold)]);
                return rows.every(row => row?.state === "pending") ? rows : null;
            }, "the branch's wait");
            // Both deadlines are 60 virtual seconds after the same virtual instant.
            expect(holdRow.deadlineAt).toEqual(fanRow.deadlineAt);
            expect(await update({ operation: "test_advance", operation_id: "advance-1", run_id: runId, seconds: 60 })).toMatchObject({ ok: true });
            // The advance elapsed the wait first; the time limit then found its success and decided nothing (the join was due).
            expect(await h.store.readNodeExecution(hold)).toMatchObject({ outcome: "elapsed", winner: "controller" });
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "completed", terminalNodeId: "finished", terminalOutput: [expect.objectContaining({ index: 0, seconds: 60 })] });
            expect(await h.store.readNodeExecution(fan)).toMatchObject({ outcome: "joined", resultKind: "business" });
            // One decision, the join: no time-limit result, and nothing of the branch cancelled.
            const events = await eventsOf(h, workflowSessionId);
            expect(events.filter(event => event.data?.nodeExecutionId === fan && event.eventType !== "workflow.state_started").map(event => event.eventType))
                .toEqual(["workflow.state_completed"]);
            expect(events.filter(event => event.eventType === "workflow.branches_cancelled")).toEqual([]);
            expect((await branchRows(h, runId, fan, 0)).map(node => node.nodeId).sort()).toEqual(["done", "hold", "work"]);
            expect((await h.store.listNodeExecutions(runId)).filter(node => node.scopeId === "root").map(node => node.nodeId)).toEqual(["fan", "finished"]);
        } finally {
            await h.stop();
        }
    });

    it("while the run is paused the time limit still passes; the state is timed_out then, and its route is taken after the resume", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { workflowSessionId, runId, fan, at } = await started(h, joinDoc({ items: [{ seconds: 600 }], timeoutSeconds: 3 }));
            await until(async () => (await h.store.readNodeExecution(at(0, "hold")))?.state === "pending", "the branch's wait");
            await controlWorkflowV2Run(h.host, workflowSessionId, { operation: "pause", runId: null, reason: "look first" }, { actor: ACTOR, operationId: "pause-1" });
            await until(async () => (await h.store.readNodeExecution(fan))?.state === "completed", "the time limit to pass while paused", 30_000);
            expect(await h.store.readNodeExecution(fan)).toMatchObject({ outcome: "timed_out" });
            expect(await h.store.readNodeExecution(at(0, "hold"))).toMatchObject({ outcome: "cancelled", winner: "join_timeout" });
            expect((await h.store.readRun(runId)).status).toBe("paused");
            // Its route is not taken while paused.
            await pause(1_000);
            expect((await h.store.listNodeExecutions(runId)).map(node => node.nodeId)).not.toContain("late");
            await controlWorkflowV2Run(h.host, workflowSessionId, { operation: "resume", runId: null, reason: null }, { actor: ACTOR, operationId: "resume-1" });
            expect(await ended(h, runId)).toMatchObject({ status: "completed", terminalNodeId: "late" });
            expect(await branchRows(h, runId, fan, 0)).toHaveLength(2);
        } finally {
            await h.stop();
        }
    });

    it("carries a pending time limit across continue-as-new and decides it once at its deadline", { timeout: TIMEOUT }, async () => {
        // A 100 ms backstop makes 50 idle waits (the continue-as-new bound, about 5 s) pass before the 24-second time limit,
        // also under a loaded suite (a 9-second limit was missed once under load: 6f98773e DEV). The precondition is that
        // the continue-as-new came while the time limit was pending; seen only after the deadline, the case is VOID (as the
        // restart cases below say it), not a pass or a product failure.
        const h = await harness(getEnv(), { wakeBackstopMs: 100 });
        try {
            const { workflowSessionId, runId, fan } = await started(h, joinDoc({ items: [{ seconds: 600 }], timeoutSeconds: 24 }));
            const instanceId = workflowLiveControllerInstanceId(workflowSessionId);
            await until(async () => (await h.client.listExecutions(instanceId)).length >= 2, "a continue-as-new", 60_000);
            const seenAt = Date.now();
            const atContinue = await h.store.readNodeExecution(fan);
            expect(seenAt, "VOID (not a product result): the continue-as-new was seen only after the time limit; run the case again")
                .toBeLessThan(atContinue.deadlineAt.getTime());
            const run = await ended(h, runId);
            expect(run).toMatchObject({ terminalNodeId: "late" });
            const fanRow = await h.store.readNodeExecution(fan);
            expect(fanRow).toMatchObject({ outcome: "timed_out" });
            const late = fanRow.completedAt.getTime() - fanRow.deadlineAt.getTime();
            expect(late).toBeGreaterThanOrEqual(0);
            expect(late).toBeLessThan(2_000);
            expect(await h.store.readNodeExecution(nodeExecutionIdFor(runId, "root", "fan", 2))).toBeFalsy();
            const events = await eventsOf(h, workflowSessionId);
            expect(events.filter(event => event.data?.nodeExecutionId === fan && event.eventType === "workflow.state_failed")).toHaveLength(1);
        } finally {
            await h.stop();
        }
    });
});

// A worker restart across the time limit: two runtimes in turn over one catalog and provider (the parallel restart test's
// split). The precondition is read from the store; read after the deadline, the case is VOID, not a pass or a product failure.
async function restartBaseOf(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    return { catalog, store, provider, client, host: { catalog, store, duroxideClient: client, requests: true } };
}

async function restartRuntimeOn(base) {
    const runtime = new Runtime(base.provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerConcurrency: WORKER_SLOTS, workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
        // Whole seconds of at least 2: a shorter activity lock renews no earlier than it expires (duroxide 0.1.32).
        workerLockTimeoutMs: 2_000, orchestratorLockTimeoutMs: 2_000,
    });
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store: base.store, catalog: base.catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async sessionId => base.catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500, workflowRequests: true,
        sessionQueue: { ...sessionQueueTransport(base.client), version: async () => "1.0.83" },
    });
    await runtime.start();
    let running = true;
    return { async stop() { if (!running) return; running = false; await runtime.shutdown(100); } };
}

describe("workflow v2 parallel time limits: a worker restart across the deadline (controller 1.9.0, test-only)", () => {
    it("decides the time limit once after the runtime was down at its deadline, keeping the deadline", { timeout: 180_000 }, async () => {
        const base = await restartBaseOf(getEnv());
        const workers = [await restartRuntimeOn(base)];
        try {
            const parent = randomUUID();
            await base.catalog.createSession(parent, {});
            const workflowSessionId = randomUUID();
            const created = await createWorkflowV2(base.host, { workflowSessionId, parentSessionId: parent,
                yaml: yamlOf(joinDoc({ items: [{ seconds: 600 }, { seconds: 600 }], timeoutSeconds: 6 })), actor: ACTOR, operationId: "start", start: { inputs: {} } });
            expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
            const runId = created.receipt.run.runId;
            const fan = nodeExecutionIdFor(runId, "root", "fan", 1);
            const holds = [0, 1].map(index => nodeExecutionIdFor(runId, branchScopeId(fan, index), "hold", 1));
            const before = await until(async () => {
                const rows = await Promise.all([fan, ...holds].map(id => base.store.readNodeExecution(id)));
                return rows.every(row => row?.state === "pending") ? rows[0] : null;
            }, "the parallel state and its branches' waits persisted as pending", 90_000);
            expect(Date.now(), "VOID (not a product result): the precondition was read after the time limit; run the case again")
                .toBeLessThan(before.deadlineAt.getTime());
            await workers[0].stop();
            // Stay down until the deadline has passed, then start another runtime over the same catalog and provider.
            await until(async () => Date.now() >= before.deadlineAt.getTime() + 1_000, "the deadline to pass while no runtime runs", 30_000);
            expect((await base.store.readNodeExecution(fan)).state).toBe("pending");
            workers.push(await restartRuntimeOn(base));
            const run = await until(async () => {
                const current = await base.store.readRun(runId);
                return current && ENDED.includes(current.status) ? current : null;
            }, `run ${runId} to end`, 90_000);
            expect(run).toMatchObject({ status: "completed", terminalNodeId: "late" });
            const after = await base.store.readNodeExecution(fan);
            expect(after).toMatchObject({ outcome: "timed_out", enteredAt: before.enteredAt, deadlineAt: before.deadlineAt });
            for (const hold of holds) expect(await base.store.readNodeExecution(hold)).toMatchObject({ outcome: "cancelled", winner: "join_timeout" });
            expect(await base.store.readNodeExecution(nodeExecutionIdFor(runId, "root", "fan", 2))).toBeFalsy();
            const events = await base.catalog.getSessionEvents(workflowSessionId, 0, 500);
            expect(events.filter(event => event.data?.nodeExecutionId === fan && event.eventType === "workflow.state_failed")).toHaveLength(1);
            expect(await base.store.hasPendingNodes(runId)).toBe(false);
        } finally {
            for (const worker of workers) await worker.stop();
            await base.catalog.close();
        }
    });
});

describe("workflow v2 parallel states of IR 8 (controller 1.9.0, test-only)", () => {
    it("an IR 8 parallel run schedules what it did before: no time limit, no reason for its cancellation, the same join input", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const doc = joinDoc({ items: [{ fail: true, ms: 1_500 }, { seconds: 600 }], failFast: true });
            expect(compileWorkflowV2(yamlOf(doc), PARALLEL).ir.irVersion).toBe(WORKFLOW_V2_AGENT_IR_VERSION);
            const { workflowSessionId, runId, fan, at } = await started(h, doc);
            expect(await ended(h, runId)).toMatchObject({ terminalNodeId: "stuck" });
            expect((await h.store.readNodeExecution(fan)).deadlineAt).toBeNull();
            const instanceId = workflowLiveControllerInstanceId(workflowSessionId);
            expect(await scheduledInputs(h.client, instanceId, WORKFLOW_V2_REQUEST_ACTIVITIES.cancelBranches))
                .toEqual([{ runId, scopeIds: [branchScopeId(fan, 1)] }]);
            expect((await scheduledInputs(h.client, instanceId, WORKFLOW_V2_REQUEST_ACTIVITIES.elapse)).some(input => input.nodeExecutionIds.includes(fan)))
                .toBe(false);
            const joins = await scheduledInputs(h.client, instanceId, WORKFLOW_V2_REQUEST_ACTIVITIES.join);
            expect(joins).toHaveLength(1);
            expect(Object.keys(joins[0]).sort()).toEqual(["parallelNodeExecutionId", "results", "runId"]);
            expect(joins[0]).toMatchObject({ runId, parallelNodeExecutionId: fan });
            expect(joins[0].results[0]).toEqual({ index: 0, nodeExecutionId: at(0, "refused"), via: "terminal" });
            expect(joins[0].results[1]).toMatchObject({ index: 1, via: "cancelled" });
            // The second branch's state was cancelled under failFast, as before (none when it was between two states).
            const cancelled = joins[0].results[1].nodeExecutionId;
            if (cancelled !== null) expect(await h.store.readNodeExecution(cancelled)).toMatchObject({ winner: "fail_fast" });
        } finally {
            await h.stop();
        }
    });
});

describe("workflow v2 parallel joins and time limits, J1b: controller 1.9.0 (inactive, test-only registration)", () => {
    it("(a) a success committed before the time limit while the run was paused still joins after the resume: the time limit finds the join due", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { workflowSessionId, runId, fan, at } = await started(h, joinDoc({ items: [{ seconds: 2 }, { seconds: 600 }], join: { first: 1 }, timeoutSeconds: 4 }));
            await until(async () => {
                const rows = await Promise.all([h.store.readNodeExecution(at(0, "hold")), h.store.readNodeExecution(at(1, "hold"))]);
                return rows.every(row => row?.state === "pending");
            }, "both branches' waits");
            await controlWorkflowV2Run(h.host, workflowSessionId, { operation: "pause", runId: null, reason: "slow controller" }, { actor: ACTOR, operationId: "pause-1" });
            // While paused, the first wait elapses by its deadline (2 s), then the time limit (4 s) finds its success: the join is
            // due, nothing is decided, and the other branch's wait is cancelled at the time limit.
            const fanRow = await h.store.readNodeExecution(fan);
            await until(async () => (await h.store.readNodeExecution(at(1, "hold")))?.state === "completed", "the time limit to pass while paused", 30_000);
            expect(await h.store.readNodeExecution(at(1, "hold"))).toMatchObject({ outcome: "cancelled", winner: "join_timeout" });
            const first = await h.store.readNodeExecution(at(0, "hold"));
            expect(first).toMatchObject({ outcome: "elapsed" });
            expect(first.completedAt.getTime()).toBeLessThanOrEqual(fanRow.deadlineAt.getTime());
            await pause(500);
            expect(await h.store.readNodeExecution(fan)).toMatchObject({ state: "pending" });
            expect((await h.store.readRun(runId)).status).toBe("paused");
            await controlWorkflowV2Run(h.host, workflowSessionId, { operation: "resume", runId: null, reason: null }, { actor: ACTOR, operationId: "resume-1" });
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "completed", terminalNodeId: "finished", terminalOutput: [{ index: 0, output: expect.objectContaining({ index: 0 }) }] });
            expect(await h.store.readNodeExecution(fan)).toMatchObject({ outcome: "joined" });
            expect((await h.store.readNodeExecution(fan)).completedAt.getTime()).toBeGreaterThan(fanRow.deadlineAt.getTime());
            // Its terminal was admitted after the time limit; nothing more of the cancelled branch was.
            expect(await h.store.readNodeExecution(at(0, "done"))).toMatchObject({ outcome: "succeeded" });
            expect((await branchRows(h, runId, fan, 1)).map(node => node.nodeId).sort()).toEqual(["hold", "work"]);
            const events = await eventsOf(h, workflowSessionId);
            expect(events.filter(event => event.data?.nodeExecutionId === fan && event.eventType !== "workflow.state_started").map(event => event.eventType))
                .toEqual(["workflow.state_completed"]);
            // J1d: the join due cut only the branch still running, never the winner, whose terminal is admitted next.
            expect(events.filter(event => event.eventType === "workflow.branches_cancelled").map(event => event.data))
                .toEqual([expect.objectContaining({ scopeIds: [branchScopeId(fan, 1)], cancelled: [at(1, "hold")], reason: "timeout" })]);
        } finally {
            await h.stop();
        }
    });

    it("(c) k can no longer happen and failFast is off: the rest run on, and the time limit ends it blocked with timedOut (Q3)", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { runId, fan, at } = await started(h, joinDoc({ items: [{ fail: true, ms: 100 }, { seconds: 600 }], join: { first: 2 }, timeoutSeconds: 3 }));
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "stuck" });
            const fanRow = await h.store.readNodeExecution(fan);
            expect(fanRow).toMatchObject({ outcome: "blocked", resultKind: "business" });
            expect(fanRow.completedAt.getTime()).toBeGreaterThanOrEqual(fanRow.deadlineAt.getTime());
            expect(run.terminalOutput).toMatchObject({ joined: false, timedOut: true, total: 2, needed: 2, succeeded: 0, failFast: false });
            expect(run.terminalOutput.branches.map(branch => [branch.index, branch.ended, branch.outcome, branch.cancelledBy ?? null])).toEqual([
                [0, "terminal", "blocked", null], [1, "cancelled", "cancelled", "timeout"]]);
            expect(await h.store.readNodeExecution(at(1, "hold"))).toMatchObject({ winner: "join_timeout" });
        } finally {
            await h.stop();
        }
    });

    it("H1 and (b) across a worker restart: A on time and B late, collected together and B admitted first, join with A; a late success alone times out", { timeout: 180_000 }, async () => {
        const base = await restartBaseOf(getEnv());
        const workers = [await restartRuntimeOn(base)];
        try {
            const parent = randomUUID();
            await base.catalog.createSession(parent, {});
            const start = async doc => {
                const workflowSessionId = randomUUID();
                const created = await createWorkflowV2(base.host, { workflowSessionId, parentSessionId: parent, yaml: yamlOf(doc), actor: ACTOR,
                    operationId: "start", start: { inputs: {} } });
                expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
                const runId = created.receipt.run.runId;
                const fan = nodeExecutionIdFor(runId, "root", "fan", 1);
                return { workflowSessionId, runId, fan, hold: index => nodeExecutionIdFor(runId, branchScopeId(fan, index), "hold", 1) };
            };
            const race = await start(joinDoc({ items: [{ seconds: 600 }, { seconds: 600 }], join: { first: 1 }, timeoutSeconds: 8 }));
            const alone = await start(joinDoc({ items: [{ seconds: 600 }], timeoutSeconds: 8 }));
            const holds = [race.hold(0), race.hold(1), alone.hold(0)];
            await until(async () => (await Promise.all(holds.map(id => base.store.readNodeExecution(id)))).every(row => row?.state === "pending"),
                "every branch's wait persisted as pending", 90_000);
            await workers[0].stop();
            const [raceFan, aloneFan] = await Promise.all([race.fan, alone.fan].map(id => base.store.readNodeExecution(id)));
            const elapsed = { outcome: "elapsed", resultKind: "business", valueText: canonicalJson({ seconds: 600 }), winner: "controller" };
            // A (branch 1 of the race) is stored before the deadline while no runtime runs.
            expect(await base.store.completeNode(race.hold(1), elapsed)).toMatchObject({ won: true });
            expect(Date.now(), "VOID (not a product result): A was stored after the time limit; run the case again").toBeLessThan(raceFan.deadlineAt.getTime());
            // B (branch 0) and the lone branch are stored after their deadlines.
            await until(async () => Date.now() >= Math.max(raceFan.deadlineAt.getTime(), aloneFan.deadlineAt.getTime()) + 500, "the deadlines to pass", 30_000);
            expect(await base.store.completeNode(race.hold(0), elapsed)).toMatchObject({ won: true });
            expect(await base.store.completeNode(alone.hold(0), elapsed)).toMatchObject({ won: true });
            workers.push(await restartRuntimeOn(base));
            const endOf = runId => until(async () => {
                const current = await base.store.readRun(runId);
                return current && ENDED.includes(current.status) ? current : null;
            }, `run ${runId} to end`, 90_000);
            // H1: joined with A, although B's terminal was admitted first (its cursor comes first).
            const raced = await endOf(race.runId);
            expect(raced).toMatchObject({ status: "completed", terminalNodeId: "finished", terminalOutput: [{ index: 1, output: expect.anything() }] });
            const terminals = await Promise.all([0, 1].map(index => base.store.readNodeExecution(nodeExecutionIdFor(race.runId, branchScopeId(race.fan, index), "done", 1))));
            expect(terminals.map(row => row?.outcome ?? null)).toEqual(["succeeded", "succeeded"]);
            expect(terminals[0].enteredAt.getTime()).toBeLessThanOrEqual(terminals[1].enteredAt.getTime());
            // (b): the lone success came after the time limit: timed_out, its result kept and marked late. Which of two legal
            // orders the restart took decides how its branch ended (J1f: not a product rule, and not chosen by this test):
            // - the first pass after the restart elapsed the time limit before it collected the wait's result: the branch's
            //   terminal was never admitted, and the report keeps the wait's result as finished;
            // - the worker stopped while a collection was on its way (the controller looks every backstop period, 500 ms);
            //   it ran after the restart, found the late result and routed it, and the branch's terminal was admitted after
            //   the time limit (a terminal still is): the report says terminal, succeeded, late.
            // Either way the late success does not count. The persisted terminal row says which order it was.
            const lone = await endOf(alone.runId);
            expect(lone).toMatchObject({ status: "completed", terminalNodeId: "late" });
            const aloneFanRow = await base.store.readNodeExecution(alone.fan);
            expect(aloneFanRow).toMatchObject({ outcome: "timed_out", resultKind: "runtime_error" });
            const details = aloneFanRow.error.details;
            expect(details).toMatchObject({ timedOut: true, total: 1, needed: 1, succeeded: 0 });
            const aloneDone = await base.store.readNodeExecution(nodeExecutionIdFor(alone.runId, branchScopeId(alone.fan, 0), "done", 1));
            if (aloneDone) {
                expect(aloneDone).toMatchObject({ state: "completed", outcome: "succeeded" });
                expect(aloneDone.enteredAt.getTime(), "admitted after the time limit").toBeGreaterThan(aloneFan.deadlineAt.getTime());
                expect(details.branches).toEqual([expect.objectContaining({ index: 0, ended: "terminal", nodeExecutionId: aloneDone.nodeExecutionId,
                    outcome: "succeeded", late: true })]);
            } else {
                expect(details.branches).toEqual([expect.objectContaining({ index: 0, ended: "finished", nodeExecutionId: alone.hold(0), outcome: "elapsed",
                    late: true })]);
            }
        } finally {
            for (const worker of workers) await worker.stop();
            await base.catalog.close();
        }
    });
});
