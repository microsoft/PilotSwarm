import test from "node:test";
import assert from "node:assert/strict";
import { selectTurnStateLabel } from "../src/index.js";

// The composer shows no turn status; screen readers and tests read this label.
test("each status maps to one plain label", () => {
    const cases = [
        [{ status: "running", acceptsControls: true }, "Running · accepts Stop and Steer"],
        [{ status: "running", acceptsControls: false }, "Running"],
        [{ status: "running", acceptsControls: true, stopping: true }, "Stopping…"],
        [{ status: "idle" }, "Idle"],
        [{ status: "input_required" }, "Waiting for input"],
        [{ status: "failed" }, "Failed"],
        [{ status: "something_new" }, "Something new"],
    ];
    for (const [input, label] of cases) assert.equal(selectTurnStateLabel(input), label, JSON.stringify(input));
});
