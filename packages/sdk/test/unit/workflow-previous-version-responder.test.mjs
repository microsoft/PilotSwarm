// A request whose responder still runs the previous session orchestration tells the person what to do instead
// (release 1.0.83: the session moves to the new version after its next turn).
import { test } from "node:test";
import assert from "node:assert/strict";
import { unsupportedResponderMessage, WORKFLOW_PREVIOUS_VERSION_RESPONDER_WORDS } from "../../dist/workflow/runtime.js";

const WORDS = "This session still runs the previous version and moves to the new one after its next turn: "
    + "send it a message, then start the Workflow again.";

test("a responder on the previous version is told to send the session a message and start the Workflow again", () => {
    assert.equal(WORKFLOW_PREVIOUS_VERSION_RESPONDER_WORDS, WORDS);
    for (const version of ["1.0.82", "1.0.0", "0.9.99"]) {
        assert.equal(unsupportedResponderMessage("s1", version), `Session s1 cannot answer a request yet. ${WORDS}`, version);
    }
});

test("a responder without a readable version, or at the intake version, gets the requirement instead", () => {
    for (const version of [null, undefined, "", "1.0.82\n", "01.0.82", "x"]) {
        const message = unsupportedResponderMessage("s1", version);
        assert.ok(!message.includes("previous version"), String(version));
        assert.match(message, /needs the respond_session_request tool and a session orchestration at 1\.0\.83 or later\.$/);
    }
    // At 1.0.83 or later the refusal can only be the missing response tool.
    assert.ok(!unsupportedResponderMessage("s1", "1.0.83").includes("previous version"));
});
