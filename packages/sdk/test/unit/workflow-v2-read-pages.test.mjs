import test from "node:test";
import assert from "node:assert/strict";
import {
    parseWorkflowReadCursor, WORKFLOW_READ_CURSOR_VERSION, WORKFLOW_READ_OPEN_MAX, WORKFLOW_READ_PAGE_DEFAULTS, WORKFLOW_READ_PAGE_MAX,
    WORKFLOW_READ_SECTIONS, WORKFLOW_READ_STATUS, workflowReadCursor, workflowReadLimit,
} from "../../dist/workflow/v2/read-pages.js";

/**
 * read_workflow's history pages (design 04 read_workflow "Bounded history pagination"; R01): a cursor is exactly the
 * object a read returned, bound to its workflow, run, section, order and format version, with the exact key of the
 * previous page's last row; anything else is refused (WORKFLOW_CURSOR_INVALID) and nothing is guessed. A page holds 1
 * to 200 rows (WORKFLOW_READ_INVALID otherwise).
 */

const refusedAs = code => error => error?.code === code;
const POSITIONS = {
    executions: { enteredAt: "2026-01-01T00:00:04.000000Z", nodeExecutionId: "run-1-8" },
    inbox: { seq: "42" },
    outbox: { createdAt: "2026-01-01T00:00:04.123456Z", exchangeId: "run-1-101" },
    interceptions: { seq: "9007199254740993" },
};

test("the limits are the read's: section defaults, a page of at most 200 rows, at most 500 open rows apart", () => {
    assert.deepEqual([...WORKFLOW_READ_SECTIONS], ["executions", "inbox", "outbox", "interceptions"]);
    assert.deepEqual({ ...WORKFLOW_READ_PAGE_DEFAULTS }, { executions: 200, inbox: 50, outbox: 50, interceptions: 200 });
    assert.equal(WORKFLOW_READ_PAGE_MAX, 200);
    assert.equal(WORKFLOW_READ_OPEN_MAX, 500);
    for (const section of WORKFLOW_READ_SECTIONS) {
        assert.equal(workflowReadLimit(undefined, section), WORKFLOW_READ_PAGE_DEFAULTS[section]);
        assert.equal(workflowReadLimit(null, section), WORKFLOW_READ_PAGE_DEFAULTS[section]);
    }
    assert.equal(workflowReadLimit(1, "inbox"), 1);
    assert.equal(workflowReadLimit(200, "inbox"), 200);
    for (const limit of [0, -1, 201, 1.5, Number.NaN, Infinity, "5", true, {}]) {
        assert.throws(() => workflowReadLimit(limit, "executions"), refusedAs("WORKFLOW_READ_INVALID"), JSON.stringify(limit));
    }
});

test("a cursor a read returned is taken back as it was, for each section, also after a JSON round trip", () => {
    for (const section of WORKFLOW_READ_SECTIONS) {
        const cursor = workflowReadCursor("wf", "run-1", section, POSITIONS[section]);
        assert.deepEqual(cursor, { v: WORKFLOW_READ_CURSOR_VERSION, workflowId: "wf", runId: "run-1", section, order: "newest_first", after: POSITIONS[section] });
        assert.deepEqual(parseWorkflowReadCursor(JSON.parse(JSON.stringify(cursor)), "wf", null), cursor, section);
        assert.deepEqual(parseWorkflowReadCursor(cursor, "wf", "run-1"), cursor, section);
    }
});

test("anything that is not such a cursor is refused, and nothing is guessed", () => {
    const good = workflowReadCursor("wf", "run-1", "executions", POSITIONS.executions);
    const refused = (value, runId = null, workflowId = "wf") =>
        assert.throws(() => parseWorkflowReadCursor(value, workflowId, runId), refusedAs("WORKFLOW_CURSOR_INVALID"), JSON.stringify(value));
    for (const value of [null, "cursor", 5, [], [good]]) refused(value);
    refused({ ...good, extra: 1 });
    const { order: _order, ...missing } = good;
    refused(missing);
    refused({ ...good, v: 2 });
    refused({ ...good, v: "1" });
    refused(good, null, "another-workflow");
    refused(good, "run-2");
    refused({ ...good, runId: "" });
    refused({ ...good, runId: "r".repeat(257) });
    refused({ ...good, section: "nodes" });
    refused({ ...good, order: "oldest_first" });
    // A position of another section, or a key that is not exactly one a read gives.
    refused({ ...good, after: POSITIONS.inbox });
    refused({ ...good, after: { ...POSITIONS.executions, extra: true } });
    for (const enteredAt of ["2026-01-01T00:00:04Z", "2026-01-01T00:00:04.000Z", "2026-01-01 00:00:04.000000+00", 5]) {
        refused({ ...good, after: { ...POSITIONS.executions, enteredAt } });
    }
    refused({ ...good, after: { ...POSITIONS.executions, nodeExecutionId: "" } });
    for (const seq of ["0", "-1", "01", "1e3", "1.5", 42, "12345678901234567890"]) {
        refused({ ...workflowReadCursor("wf", "run-1", "inbox", POSITIONS.inbox), after: { seq } });
    }
    refused({ ...workflowReadCursor("wf", "run-1", "outbox", POSITIONS.outbox), after: { ...POSITIONS.outbox, exchangeId: 7 } });
});

test("each refusal of a read has its HTTP status: what does not exist 404, an invalid read 400, an unavailable store 503", () => {
    assert.deepEqual({ ...WORKFLOW_READ_STATUS }, {
        WORKFLOW_NOT_FOUND: 404, RUN_NOT_FOUND: 404, EXECUTION_NOT_FOUND: 404, KV_REVISION_NOT_FOUND: 404, DEFINITION_REVISION_NOT_FOUND: 404, WORKFLOW_CURSOR_INVALID: 400,
        WORKFLOW_READ_INVALID: 400, WORKFLOW_STORE_UNAVAILABLE: 503,
    });
});
