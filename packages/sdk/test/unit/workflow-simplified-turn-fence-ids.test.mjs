/**
 * The turn-to-visit fence's two ids (review RT-2, RT-3): a visit's prompt id names its node execution
 * (`workflow:<wf>:<run>:agent:<nx>`), and a continued session's turn Stop names its visit by its request id
 * (`workflow-cycle-stop:<nx>`, with `:sent` after a late send). Anything else names no visit.
 *
 * Run: node --test test/unit/workflow-simplified-turn-fence-ids.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { workflowVisitOfPromptId, workflowVisitOfStopRequestId } from "../../dist/workflow/store.js";
import { workflowAgentClientMessageId } from "../../dist/workflow/runtime.js";

const NX = `nx-${"ab12".repeat(10)}`;

test("a visit prompt's id names its node execution; other ids name none", () => {
    assert.equal(workflowVisitOfPromptId(workflowAgentClientMessageId("wf-1", "run-1", NX)), NX);
    for (const id of ["workflow:wf-1:run-1:request:nx-1", "portal-123", `workflow:wf:run:agent:${NX}:extra`, "", null, 7, `agent:${NX}`]) {
        assert.equal(workflowVisitOfPromptId(id), null, String(id));
    }
});

test("a cycle Stop's request id names its visit, with or without :sent; a person's Stop names none", () => {
    assert.equal(workflowVisitOfStopRequestId(`workflow-cycle-stop:${NX}`), NX);
    assert.equal(workflowVisitOfStopRequestId(`workflow-cycle-stop:${NX}:sent`), NX);
    for (const id of ["portal-stop-1", `workflow-cycle-stop:${NX}:later`, `workflow-agent-end:${NX}`, null, undefined, 3]) {
        assert.equal(workflowVisitOfStopRequestId(id), null, String(id));
    }
});
