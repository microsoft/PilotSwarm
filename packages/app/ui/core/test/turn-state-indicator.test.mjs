// The composer's turn status is a coloured dot at every width: no visible
// text, the status as its tooltip and accessible name (owner, 2026-10-14).
import test from "node:test";
import assert from "node:assert/strict";
import { selectTurnStateIndicator } from "../src/index.js";

test("each status maps to one tone and one plain label", () => {
    const cases = [
        [{ status: "running", acceptsControls: true }, "running", "Running · accepts Stop and Steer"],
        [{ status: "running", acceptsControls: false }, "running", "Running"],
        [{ status: "running", acceptsControls: true, stopping: true }, "waiting", "Stopping…"],
        [{ status: "idle" }, "idle", "Idle"],
        [{ status: "waiting" }, "waiting", "Waiting"],
        [{ status: "input_required" }, "waiting", "Waiting for input"],
        [{ status: "error" }, "error", "Error"],
        [{ status: "failed" }, "error", "Failed"],
        [{ status: "pending" }, "done", "Pending"],
        [{ status: "completed" }, "done", "Completed"],
        [{ status: "cancelled" }, "done", "Cancelled"],
        [{ status: "something_new" }, "idle", "Something new"],
    ];
    for (const [input, tone, label] of cases) {
        assert.deepEqual(selectTurnStateIndicator(input), { tone, label }, JSON.stringify(input));
    }
});
