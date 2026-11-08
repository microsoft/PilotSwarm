/**
 * Review SF-1: a turn the session's queue merged from messages of different senders reaches runTurn with no sender and
 * every message's client id. The runtime records how many messages it holds (`mergedMessages`), a server-stamped fact;
 * the UI shows it neutrally and never builds a Workflow card from its text (ui/core workflow-update-card tests).
 *
 * Run: node --test test/unit/workflow-simplified-merged-turn.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mergedTurnMessages } from "../../dist/session-proxy.js";

test("a turn with no sender and two or more client ids is a merged turn; anything else is not", () => {
    assert.equal(mergedTurnMessages(undefined, ["wf-msg-1", "c-1"]), 2);
    assert.equal(mergedTurnMessages(null, ["a", "b", "c"]), 3);
    assert.equal(mergedTurnMessages(undefined, ["c-1"]), null, "one message");
    assert.equal(mergedTurnMessages(undefined, []), null);
    assert.equal(mergedTurnMessages({ kind: "user", subject: "alice" }, ["c-1", "c-2"]), null, "one sender's messages keep their sender");
    assert.equal(mergedTurnMessages({ kind: "workflow", display: "workflow" }, ["a", "b"]), null);
});
