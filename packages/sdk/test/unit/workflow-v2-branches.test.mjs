/**
 * Named branches (owner decision 2026-11-08T00:35Z, option A), the compiler, the stored IR and the pure join helpers:
 *
 * - `type: parallel` with `branches: { <name>: { initial, states, input? } }` instead of forEach and body: each branch its
 *   own graph (its routes stay in it), state ids unique across the Workflow (so agentModels works per branch), concurrency
 *   defaulting to the number of branches; the same joins, failFast and time limit; IR 11 only for a Workflow with one.
 * - Refused: forEach or body with branches, an empty map, a bad name, a missing or foreign initial, a route into another
 *   branch, k above the branches, branch.name in a For each, `branch` in a branch's input template, a continued chat in a
 *   branch, a state id used twice; and a route with a list of targets says how to run several nodes at once.
 * - The stored IR reads back as compiled (only by a reader of IR 11), and malformed branches are refused.
 * - The joined output is { <name>: output } (for a join of the first k, its winners only); a report names each branch.
 * - FJ-S11: a named branch with an agent state, or a receive with no wait, warns when its parallel state has no time limit
 *   of its own (a join of every branch waits as long as its slowest branch runs).
 * - A plan's branch initials are one for each branch, the first the body's; any other plan fails loudly, never starting
 *   the first branch's initial instead (the formal pre-check of da66611a). Review NB-R4: a named fork's plan gives its
 *   branch count and each branch's states; parsePlan refuses missing or wrong initials for a named fork only.
 * - Review NB-R3: more than 16 named branches with no concurrency are refused in words, never silently capped.
 * - Review NB-R6 (no change): a named fork with timeoutSeconds still needs its own timed_out route, catchAll or not.
 *
 * Run: node --test test/unit/workflow-v2-branches.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    compileWorkflowV2, parseWorkflowIr, WORKFLOW_V2_BRANCHES_IR_VERSION, WORKFLOW_V2_CLOCK_WAIT_IR_VERSION, WORKFLOW_V2_MILESTONE_IR_VERSION,
} from "../../dist/workflow/v2/compiler.js";
import { canonicalJson } from "../../dist/workflow/v2/json.js";
import { describeWorkflowV2State, parallelBranchInitial, parsePlan } from "../../dist/workflow/v2/runtime.js";
import { branchScopeId, branchScopeNameList, branchScopeNames, parallelJoinedOutput, parallelReportText } from "../../dist/workflow/v2/parallel.js";
import { requireAgentModelsForRevision } from "../../dist/workflow/v2/agent-models.js";

const ALL = { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true, enableClockWaits: true };
const yamlOf = doc => JSON.stringify(doc, null, 2);
const errorsOf = result => result.diagnostics.filter(item => item.severity === "error");

/** Two named branches: quick (an agent node, the arriving input) and careful (a script, then an agent node, its own input). */
function branchesDoc(change = () => {}) {
    const doc = {
        apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "two-views", version: "1.0.0" },
        initialInput: { text: "hello" }, initial: "views",
        states: {
            views: {
                type: "parallel",
                branches: {
                    quick: {
                        initial: "quick_summary",
                        states: {
                            quick_summary: { type: "agent", invoke: { prompt: "Summarize it." }, outcomes: ["done"], timeoutSeconds: 600,
                                transition: { next: { done: "quick_end", failure: "quick_failed" } } },
                            quick_end: { type: "terminal", outcome: "succeeded", output: { lane: "${branch.name}", summary: "${input}" } },
                            quick_failed: { type: "terminal", outcome: "failed" },
                        },
                    },
                    careful: {
                        initial: "prepare",
                        input: { text: "${input.text}", depth: "deep" },
                        states: {
                            prepare: { type: "script", outcomes: ["ready"], source: "await setResult(\"ready\", context.input);\n",
                                transition: { next: { ready: "careful_summary", failure: "careful_failed" } } },
                            careful_summary: { type: "agent", invoke: { prompt: "Summarize it closely." }, outcomes: ["done"], timeoutSeconds: 1800,
                                transition: { next: { done: "careful_end", failure: "careful_failed" } } },
                            careful_end: { type: "terminal", outcome: "succeeded", output: "${input}" },
                            careful_failed: { type: "terminal", outcome: "failed" },
                        },
                    },
                },
                transition: { next: { joined: "done", blocked: "failed", failure: "failed" } },
            },
            done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            failed: { type: "terminal", outcome: "failed", output: "${input}" },
        },
    };
    change(doc, doc.states.views);
    return doc;
}

test("named branches compile to IR 11: each branch its own graph from its own initial; concurrency defaults to their number", () => {
    const compiled = compileWorkflowV2(yamlOf(branchesDoc()), ALL);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.equal(compiled.ir.irVersion, WORKFLOW_V2_BRANCHES_IR_VERSION);
    assert.equal(WORKFLOW_V2_MILESTONE_IR_VERSION, WORKFLOW_V2_BRANCHES_IR_VERSION);
    const views = compiled.ir.nodes.views;
    assert.equal(views.forEach, null);
    assert.equal(views.concurrency, 2, "every branch at once");
    assert.equal(views.join, "all_required");
    assert.deepEqual(views.branches, [
        { name: "quick", initial: "quick_summary", states: ["quick_summary", "quick_end", "quick_failed"], hasInput: false, input: null },
        { name: "careful", initial: "prepare", states: ["prepare", "careful_summary", "careful_end", "careful_failed"], hasInput: true,
            input: { text: "${input.text}", depth: "deep" } },
    ]);
    assert.deepEqual(views.body, { initial: "quick_summary", states: [...views.branches[0].states, ...views.branches[1].states] });
    // State ids stay unique across the Workflow: each branch's agent node takes its own model at start.
    requireAgentModelsForRevision({ quick_summary: { model: "a:fast" }, careful_summary: { model: "a:strong" } }, compiled.ir, "two-views");
    // The graph and the start event show the branches instead of a forEach.
    const shown = describeWorkflowV2State(views);
    assert.deepEqual(shown.branches, [
        { name: "quick", initial: "quick_summary", states: ["quick_summary", "quick_end", "quick_failed"] },
        { name: "careful", initial: "prepare", states: ["prepare", "careful_summary", "careful_end", "careful_failed"] },
    ]);
    assert.equal(Object.hasOwn(shown, "forEach"), false);
    // The same joins, failFast and time limit; an explicit concurrency is kept.
    const tuned = compileWorkflowV2(yamlOf(branchesDoc((_, views) => {
        Object.assign(views, { join: { first: 1 }, failFast: true, concurrency: 1, timeoutSeconds: 60 });
        views.transition.next.timed_out = "failed";
    })), ALL);
    assert.equal(tuned.valid, true, JSON.stringify(tuned.diagnostics));
    assert.deepEqual([tuned.ir.nodes.views.join, tuned.ir.nodes.views.failFast, tuned.ir.nodes.views.concurrency, tuned.ir.nodes.views.timeoutSeconds],
        [{ first: 1 }, true, 1, 60]);
    // A For each stays as it was (IR 8, no branches field).
    const forEach = compileWorkflowV2(yamlOf({ ...branchesDoc(), states: { fan: { type: "parallel", forEach: [1, 2],
        body: { initial: "end", states: { end: { type: "terminal", outcome: "succeeded" } } }, transition: { next: { joined: "done", blocked: "done" } } },
    done: { type: "terminal", outcome: "succeeded" } }, initial: "fan" }), ALL);
    assert.equal(forEach.valid, true, JSON.stringify(forEach.diagnostics));
    assert.ok(forEach.ir.irVersion < WORKFLOW_V2_BRANCHES_IR_VERSION);
    assert.equal(Object.hasOwn(forEach.ir.nodes.fan, "branches"), false);
});

test("named branches are refused in words: with forEach or body, empty, misnamed, a foreign initial or route, k above them, and more", () => {
    const cases = [
        ["forEach and branches", (_, v) => { v.forEach = [1]; }, "WORKFLOW_FIELD_INVALID", "states.views.branches", /forEach .* or branches .*, not both/],
        ["body and branches", (_, v) => { v.body = { initial: "x", states: {} }; }, "WORKFLOW_FIELD_INVALID", "states.views.body", /has no body/],
        ["no branches", (_, v) => { v.branches = {}; }, "WORKFLOW_FIELD_REQUIRED", "states.views.branches", /map each branch's name/],
        ["a bad name", (_, v) => { v.branches["1st"] = v.branches.quick; delete v.branches.quick; }, "WORKFLOW_FIELD_INVALID", "states.views.branches.1st",
            /branch names use a letter/],
        ["no initial", (_, v) => { delete v.branches.quick.initial; }, "WORKFLOW_FIELD_REQUIRED", "states.views.branches.quick", /needs \{ initial/],
        ["an initial of another branch", (_, v) => { v.branches.quick.initial = "prepare"; }, "WORKFLOW_INITIAL_INVALID",
            "states.views.branches.quick.initial", /initial must name a state of branch 'quick'/],
        ["a route into another branch", (_, v) => { v.branches.careful.states.careful_summary.transition.next.done = "quick_end"; },
            "WORKFLOW_TARGET_UNKNOWN", "states.views.branches.careful.states.careful_summary.transition.next.done", /unknown state 'quick_end'/],
        ["k above the branches", (_, v) => { v.join = { first: 3 }; }, "WORKFLOW_FIELD_INVALID", "states.views.join.first",
            /join.first is 3, but the state has 2 branches/],
        ["an unknown branch field", (_, v) => { v.branches.quick.forEach = [1]; }, "WORKFLOW_FIELD_UNKNOWN", "states.views.branches.quick.forEach", /./],
        ["branch in a branch's input", (_, v) => { v.branches.careful.input = "${branch.name}"; }, "WORKFLOW_BINDING_INVALID",
            "states.views.branches.careful.input", /branch is bound only/],
        ["a continued chat", (_, v) => { v.branches.quick.states.quick_summary.chat = "continue"; }, "WORKFLOW_FIELD_INVALID",
            "states.views.branches.quick.states.quick_summary.chat", /inside branch 'quick' of parallel state 'views'/],
        ["a state id used twice", (_, v) => { v.branches.careful.states.quick_end = v.branches.careful.states.careful_end;
            v.branches.careful.states.careful_summary.transition.next.done = "quick_end"; delete v.branches.careful.states.careful_end; },
        "WORKFLOW_STATE_ID", "states.views.branches.careful.states.quick_end", /used twice/],
        // A branch state named as a root state is reported at its own branch's path.
        ["a branch state named as a root state", (_, v) => { v.branches.quick.states.done = v.branches.quick.states.quick_end;
            delete v.branches.quick.states.quick_end; v.branches.quick.states.quick_summary.transition.next.done = "done"; },
        "WORKFLOW_STATE_ID", "states.views.branches.quick.states.done", /^state id 'done' is used twice; state ids are unique across the workflow\.$/],
        ["a list of targets", (_, v) => { v.transition.next.joined = ["done", "failed"]; }, "WORKFLOW_TARGET_INVALID", "states.views.transition.next.joined",
            /^route 'joined' lists several states: a route has one target; use a parallel state with branches to run several nodes at once\.$/],
    ];
    for (const [label, change, code, path, message] of cases) {
        const result = compileWorkflowV2(yamlOf(branchesDoc(change)), ALL);
        assert.equal(result.valid, false, label);
        const found = errorsOf(result).find(item => item.code === code && item.path.startsWith(path));
        assert.ok(found, `${label}: ${JSON.stringify(errorsOf(result).map(item => [item.code, item.path, item.message]))}`);
        assert.match(found.message, message, label);
    }
    // branch.name is a named branch's: a For each's items have none.
    const forEach = compileWorkflowV2(yamlOf({ ...branchesDoc(), initial: "fan", states: {
        fan: { type: "parallel", forEach: [1, 2], body: { initial: "end", states: { end: { type: "terminal", outcome: "succeeded", output: "${branch.name}" } } },
            transition: { next: { joined: "done", blocked: "done" } } },
        done: { type: "terminal", outcome: "succeeded" } } }), ALL);
    assert.deepEqual(errorsOf(forEach).map(item => [item.code, item.path, item.message]), [["WORKFLOW_BINDING_INVALID", "states.fan.body.states.end.output",
        "branch.name is bound only in a parallel state with branches; in a For each, use branch.index or branch.item."]]);
    // A host without parallel states refuses them as before.
    assert.equal(compileWorkflowV2(yamlOf(branchesDoc()), { enableRequests: true, enableAgents: true }).valid, false);
});

test("the stored IR 11 reads back as compiled, only by a reader of IR 11; malformed branches are refused", () => {
    const compiled = compileWorkflowV2(yamlOf(branchesDoc()), ALL);
    const stored = JSON.parse(canonicalJson(compiled.ir));
    const read = value => parseWorkflowIr(JSON.parse(JSON.stringify(value)), { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
    assert.deepEqual(read(stored), compiled.ir);
    assert.throws(() => parseWorkflowIr(stored, { maxIrVersion: WORKFLOW_V2_CLOCK_WAIT_IR_VERSION }), /stored IR version 11 is not supported/);
    const views = stored.nodes.views;
    const withViews = change => ({ ...stored, nodes: { ...stored.nodes, views: { ...views, ...change } } });
    const branch = (index, change) => views.branches.map((item, at) => (at === index ? { ...item, ...change } : item));
    for (const [label, broken] of [
        ["an older version", { ...stored, irVersion: 10 }],
        ["no branches", withViews({ branches: [] })],
        ["a duplicate name", withViews({ branches: branch(1, { name: "quick" }) })],
        ["a bad name", withViews({ branches: branch(0, { name: "1st" }) })],
        ["an initial outside its states", withViews({ branches: branch(0, { initial: "prepare" }) })],
        ["states that are not the body's", withViews({ branches: branch(1, { states: ["prepare", "careful_end"] }) })],
        ["a forEach beside them", withViews({ forEach: [1, 2] })],
        ["no hasInput", withViews({ branches: branch(0, { hasInput: undefined }) })],
    ]) {
        assert.throws(() => read(broken), /stored IR/, label);
    }
});

test("the joined output is { <name>: output } (a join of the first k: its winners only); a report names each branch", () => {
    const named = { branches: [{ name: "quick" }, { name: "careful" }], join: "all_required" };
    assert.deepEqual(parallelJoinedOutput(named, [{ index: 0, output: "q" }, { index: 1, output: { c: 1 } }]), { quick: "q", careful: { c: 1 } });
    assert.deepEqual(parallelJoinedOutput({ ...named, join: { first: 1 } }, [{ index: 1, output: "c" }]), { careful: "c" });
    // A For each as before: outputs in index order, or [{ index, output }] for the first k.
    assert.deepEqual(parallelJoinedOutput({ join: "all_required" }, [{ index: 0, output: "a" }, { index: 1, output: "b" }]), ["a", "b"]);
    assert.deepEqual(parallelJoinedOutput({ join: { first: 1 } }, [{ index: 1, output: "b" }]), [{ index: 1, output: "b" }]);
    const report = JSON.parse(parallelReportText({ total: 2, needed: 2, failFast: false, timedOut: false, names: ["quick", "careful"], branches: [
        { index: 1, ended: "terminal", nodeExecutionId: "nx-2", row: { outcome: "failed", resultKind: "business", output: null, error: null } },
        { index: 0, ended: "terminal", nodeExecutionId: "nx-1", row: { outcome: "succeeded", resultKind: "business", output: "q", error: null } },
    ] }, "test"));
    assert.deepEqual(report.branches.map(item => [item.index, item.name, item.outcome]), [[0, "quick", "succeeded"], [1, "careful", "failed"]]);
    const unnamed = JSON.parse(parallelReportText({ total: 1, needed: 1, failFast: false, timedOut: false, branches: [
        { index: 0, ended: "not_started", nodeExecutionId: null }] }, "test"));
    assert.equal(Object.hasOwn(unnamed.branches[0], "name"), false);
});

test("FJ-S11: a named branch that can wait long warns when its parallel state has no time limit of its own", () => {
    const warningsOf = result => result.diagnostics.filter(item => item.code === "WORKFLOW_BRANCH_UNBOUNDED")
        .map(item => [item.severity, item.path, item.message]);
    const message = (branch, state) => `branch '${branch}' has agent state '${state}', and parallel state 'views' has no timeoutSeconds: `
        + "its join waits as long as that branch runs. Give 'views' a timeoutSeconds and a timed_out route to bound the wait.";
    // Both branches have an agent node, and the parallel state has no timeoutSeconds: a warning each, and it still compiles.
    const plain = compileWorkflowV2(yamlOf(branchesDoc()), ALL);
    assert.equal(plain.valid, true);
    assert.deepEqual(warningsOf(plain), [
        ["warning", "states.views.branches.quick", message("quick", "quick_summary")],
        ["warning", "states.views.branches.careful", message("careful", "careful_summary")],
    ]);
    // With its own time limit, none.
    const timed = compileWorkflowV2(yamlOf(branchesDoc((_, views) => { views.timeoutSeconds = 3600; views.transition.next.timed_out = "failed"; })), ALL);
    assert.equal(timed.valid, true, JSON.stringify(timed.diagnostics));
    assert.deepEqual(warningsOf(timed), []);
    // A receive with no wait can wait until the run is cancelled or stopped; with a wait it cannot. A branch of scripts: none.
    const receiving = wait => compileWorkflowV2(yamlOf(branchesDoc((doc, views) => {
        doc.contracts = { "Go@1": { schema: { type: "object" } } };
        views.branches.quick.states.quick_summary = { type: "messaging", mode: "receive", contract: "Go@1", ...(wait ? { wait: { seconds: 60 } } : {}),
            transition: { next: { received: "quick_end", ...(wait ? { elapsed: "quick_end" } : {}), failure: "quick_failed" } } };
        views.branches.careful.states.careful_summary = { type: "script", outcomes: ["done"], source: "await setResult(\"done\", context.input);\n",
            transition: { next: { done: "careful_end", failure: "careful_failed" } } };
    })), ALL);
    const unbounded = receiving(false);
    assert.equal(unbounded.valid, true, JSON.stringify(unbounded.diagnostics));
    assert.deepEqual(warningsOf(unbounded), [["warning", "states.views.branches.quick", "branch 'quick' has receive state 'quick_summary' with no wait, "
        + "and parallel state 'views' has no timeoutSeconds: its join waits as long as that branch runs, and without a message, until the run is "
        + "cancelled or stopped. Give 'views' a timeoutSeconds and a timed_out route to bound the wait."]]);
    assert.deepEqual(warningsOf(receiving(true)), []);
    // A For each is unchanged: its body's agent node gives no such warning.
    const forEach = compileWorkflowV2(yamlOf({ ...branchesDoc(), initial: "fan", states: {
        fan: { type: "parallel", forEach: [1, 2], body: { initial: "look", states: {
            look: { type: "agent", invoke: { prompt: "Look." }, outcomes: ["done"], timeoutSeconds: 600, transition: { next: { done: "end", failure: "end" } } },
            end: { type: "terminal", outcome: "succeeded" } } }, transition: { next: { joined: "done", blocked: "done" } } },
        done: { type: "terminal", outcome: "succeeded" } } }), ALL);
    assert.equal(forEach.valid, true, JSON.stringify(forEach.diagnostics));
    assert.deepEqual(warningsOf(forEach), []);
});

test("NB-R4: a named fork's plan gives its branch count, one initial per branch in its own branch, and its branches' states", () => {
    const compiled = compileWorkflowV2(yamlOf(branchesDoc()), ALL);
    const views = compiled.ir.nodes.views;
    const spec = { initial: views.body.initial, concurrency: 2, failFast: false, branches: 2, initials: views.branches.map(branch => branch.initial),
        branchStates: views.branches.map(branch => branch.states) };
    // Every state of the IR is a node of the plan, as the plan activity writes it.
    const nodes = parallel => Object.fromEntries(Object.values(compiled.ir.nodes).map(node => [node.id, node.id === "views"
        ? { type: "parallel", next: node.next, parallel } : { type: node.type, next: node.type === "terminal" ? {} : node.next }]));
    const plan = parallel => ({ name: "two-views", version: "1.0.0", initial: "views", maxNodeExecutions: 1000, wakeBackstopMs: 30_000, nodes: nodes(parallel) });
    assert.deepEqual(parsePlan(plan(spec), true).nodes.views.parallel, spec);
    // A For each's plan has none of them, and reads as it was written.
    const { branches: _count, initials: _initials, branchStates: _states, ...forEach } = spec;
    assert.deepEqual(parsePlan(plan(forEach), true).nodes.views.parallel, forEach);
    for (const [label, broken] of [
        ["initials without a branch count", { ...forEach, initials: spec.initials }],
        ["branch states without a branch count", { ...forEach, branchStates: spec.branchStates }],
        ["no initials", { ...spec, initials: undefined }],
        ["no branch states", { ...spec, branchStates: undefined }],
        ["one initial for two branches", { ...spec, initials: ["quick_summary"] }],
        ["three initials for two branches", { ...spec, initials: ["quick_summary", "prepare", "prepare"] }],
        ["a count that is not the branches'", { ...spec, branches: 3 }],
        ["a later initial of another branch", { ...spec, initials: ["quick_summary", "quick_end"] }],
        ["a first initial that is not the body's", { ...spec, initials: ["quick_end", "prepare"] }],
        ["a branch state that is not a node", { ...spec, branchStates: [spec.branchStates[0], [...spec.branchStates[1], "ghost"]] }],
        ["an empty branch", { ...spec, branchStates: [spec.branchStates[0], []] }],
        ["a count of zero", { ...spec, branches: 0, initials: [], branchStates: [] }],
    ]) {
        const parallel = JSON.parse(JSON.stringify(broken));
        assert.throws(() => parsePlan(plan(parallel), true), /plan node views parallel is invalid/, label);
    }
    // Each branch starts at its own initial; initials that are not one for each branch never fall back to the first.
    assert.equal(parallelBranchInitial(spec, 0, 2), "quick_summary");
    assert.equal(parallelBranchInitial(spec, 1, 2), "prepare");
    assert.equal(parallelBranchInitial(forEach, 1, 2), "quick_summary");
    assert.throws(() => parallelBranchInitial(spec, 2, 3), /the plan's named fork has 2 branches and 2 initials for 3 branches/);
    assert.throws(() => parallelBranchInitial({ ...spec, initials: undefined }, 1, 2), /the plan's named fork has 2 branches and no initials for 2 branches/);
});

test("NB-R3: more than 16 named branches without a concurrency are refused in words; with one they compile", () => {
    const many = count => branchesDoc((_, views) => {
        views.branches = Object.fromEntries(Array.from({ length: count }, (_, index) => [`b${index + 1}`, { initial: `b${index + 1}_end`,
            states: { [`b${index + 1}_end`]: { type: "terminal", outcome: "succeeded" } } }]));
    });
    const refused = compileWorkflowV2(yamlOf(many(17)), ALL);
    assert.equal(refused.valid, false);
    assert.deepEqual(errorsOf(refused).map(item => [item.code, item.path, item.message]), [["WORKFLOW_FIELD_INVALID", "states.views.concurrency",
        "17 branches would not all start at once: set concurrency (at most 16) or use fewer branches."]]);
    // 16 run at once by default; 17 with an explicit concurrency start as it says.
    const sixteen = compileWorkflowV2(yamlOf(many(16)), ALL);
    assert.equal(sixteen.valid, true, JSON.stringify(sixteen.diagnostics));
    assert.equal(sixteen.ir.nodes.views.concurrency, 16);
    const capped = compileWorkflowV2(yamlOf(branchesDoc((doc, views) => {
        Object.assign(views, many(17).states.views, { concurrency: 4 });
    })), ALL);
    assert.equal(capped.valid, true, JSON.stringify(capped.diagnostics));
    assert.equal(capped.ir.nodes.views.concurrency, 4);
    // A For each keeps its default of 1, whatever its items.
    const forEach = compileWorkflowV2(yamlOf({ ...branchesDoc(), initial: "fan", states: {
        fan: { type: "parallel", forEach: Array.from({ length: 20 }, (_, index) => index), body: { initial: "end", states: { end: { type: "terminal", outcome: "succeeded" } } },
            transition: { next: { joined: "done", blocked: "done" } } },
        done: { type: "terminal", outcome: "succeeded" } } }), ALL);
    assert.equal(forEach.valid, true, JSON.stringify(forEach.diagnostics));
    assert.equal(forEach.ir.nodes.fan.concurrency, 1);
});

test("NB-R6 (no change): a named fork with timeoutSeconds must route timed_out itself, even with a catchAll", () => {
    const result = compileWorkflowV2(yamlOf(branchesDoc((doc, views) => {
        views.timeoutSeconds = 60;
        doc.catchAll = "failed";
    })), ALL);
    assert.equal(result.valid, false);
    assert.ok(errorsOf(result).some(item => item.code === "WORKFLOW_ROUTE_MISSING" && item.path.startsWith("states.views") && /timed_out/.test(item.message)),
        JSON.stringify(errorsOf(result)));
});

test("a cut's branch names come from each scope's own fork, never another's; a For each's scope has none", () => {
    const fork = (names) => ({ type: "parallel", branches: names.map(name => ({ name, initial: `${name}_w`, states: [`${name}_w`] })) });
    const forks = new Map([["nx-aaaa", fork(["a1", "a2"])], ["nx-bbbb", fork(["b1", "b2"])], ["nx-cccc", { type: "parallel" }]]);
    const scopes = [branchScopeId("nx-aaaa", 1), branchScopeId("nx-bbbb", 0), branchScopeId("nx-bbbb", 1), branchScopeId("nx-cccc", 0), branchScopeId("nx-dddd", 0)];
    const names = branchScopeNames(scopes, forks);
    assert.deepEqual([...names], [["nx-aaaa#1", "a2"], ["nx-bbbb#0", "b1"], ["nx-bbbb#1", "b2"]]);
    // An event names its scopes only when every one has a name: never a For each's or an unknown fork's beside them.
    assert.deepEqual(branchScopeNameList([branchScopeId("nx-bbbb", 0), branchScopeId("nx-aaaa", 1)], names), ["b1", "a2"]);
    assert.equal(branchScopeNameList([branchScopeId("nx-bbbb", 0), branchScopeId("nx-cccc", 0)], names), null);
    assert.equal(branchScopeNameList([], names), null);
});
