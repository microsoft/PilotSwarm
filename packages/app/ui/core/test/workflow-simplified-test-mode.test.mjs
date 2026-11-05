// Workflow Simplified, spec 16 (E1, O2): test mode is hidden unless the deployment turns it on. The server lists a test
// operation in a read model's personCommands only while its test mode is on; the portal and the terminal UI then show
// no test run in a run picker, no test controls and no test calls. With it on, they show them as before.
//
// Run: node --test packages/app/ui/core/test/workflow-simplified-test-mode.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { workflowV2RunPickerModel } from "../src/workflow-v2-run-picker.js";
import { workflowV2TestControls, workflowV2TestResponder, workflowV2TestRunsShown } from "../src/workflow-v2-commands.js";
import { workflowSessionProjection } from "../src/workflow-tui.js";
import { readModel, subtreeCommands } from "./workflow-v2-fixtures.mjs";

const EVERY = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel"];
const RUNS = [
    { runId: "run-1", mode: "live", status: "running", revision: 1, outcome: null },
    { runId: "run-t1", mode: "test", status: "completed", revision: 1, outcome: "passed" },
    { runId: "run-t2", mode: "test", status: "running", revision: 1, outcome: null },
];
const withCommands = (operations, extra = {}) => ({ ...readModel({ runs: RUNS }), personCommands: { operations, restriction: null, run: null, ...extra } });

test("test runs are shown only while the server lists a test operation", () => {
    assert.equal(workflowV2TestRunsShown(withCommands([...EVERY, "stop"])), false, "test mode off: stop only");
    assert.equal(workflowV2TestRunsShown(withCommands([...EVERY, "stop", "test", "test_respond", "test_advance"])), true);
    // A published workflow takes no new test, but its test runs' answers stay offered while test mode is on.
    assert.equal(workflowV2TestRunsShown(withCommands([...EVERY, "stop", "test_respond", "test_advance"])), true);
    // A deployment that takes no person's commands (no test run can start there), and a workflow in an agent step's
    // subtree (only brakes, so the list cannot tell), keep what they list.
    assert.equal(workflowV2TestRunsShown(readModel({ runs: RUNS })), true);
    assert.equal(workflowV2TestRunsShown({ ...readModel({ runs: RUNS }), personCommands: subtreeCommands() }), true);
    for (const value of [null, undefined, 5, "x", []]) assert.equal(workflowV2TestRunsShown(value), true, String(value));
});

test("the run picker leaves test runs out with tests: false, and lists them by default", () => {
    const off = workflowV2RunPickerModel({ workflowModel: readModel({ runs: RUNS }), tests: false, ownModelLoaded: true });
    assert.deepEqual(off.options.map(option => option.value), [""]);
    assert.equal(off.runCount, 1);
    const on = workflowV2RunPickerModel({ workflowModel: readModel({ runs: RUNS }), ownModelLoaded: true });
    assert.deepEqual(on.options.map(option => option.value), ["", "run-t1", "run-t2"]);
    assert.equal(on.runCount, 3);
    // Only test runs: "No runs yet." while they are hidden.
    const only = workflowV2RunPickerModel({ workflowModel: readModel({ runs: RUNS.slice(1) }), tests: false, ownModelLoaded: true });
    assert.equal(only.runCount, 0);
    assert.ok(only.notes.some(note => note.text === "No runs yet."));
});

test("the terminal UI's projection lists test runs only while the server's test mode is on", () => {
    const session = { sessionId: "wf", sessionKind: "workflow", status: "running" };
    const project = model => workflowSessionProjection({ session, view: { readModel: model, readModelRunId: null } });
    const off = project(withCommands([...EVERY, "stop"]));
    assert.deepEqual(off.runPicker.options.map(option => option.value), [""]);
    assert.equal(off.testControls, null, "no Test control");
    const on = project(withCommands([...EVERY, "stop", "test", "test_respond", "test_advance"]));
    assert.deepEqual(on.runPicker.options.map(option => option.value), ["", "run-t1", "run-t2"]);
});

test("without a test operation listed, no test control and no test answers are offered", () => {
    const draft = { ...readModel({ runs: RUNS, definition: { state: "draft", publishedRevision: null } }),
        personCommands: { operations: [...EVERY, "stop"], restriction: null, run: null } };
    assert.equal(workflowV2TestControls(draft), null);
    const testRun = { ...readModel({ runs: RUNS, run: { runId: "run-t2", mode: "test", status: "running", test: { interceptions: [] } } }),
        personCommands: { operations: [...EVERY, "stop"], restriction: null, run: null } };
    assert.equal(workflowV2TestResponder(testRun), null);
    const on = { ...draft, personCommands: { ...draft.personCommands, operations: [...EVERY, "stop", "test", "test_respond", "test_advance"] } };
    assert.notEqual(workflowV2TestControls(on), null);
});
