// A failed Workflow's error in plain words (coordinator, 2026-11-06): the owner's "poll" script failed with its raw error
// JSON (code, details, exit code, a stack) as the headline. The read's error preview is canonical JSON cut at 500
// characters, keys sorted, so a script error is cut before its message: its fields are read from the cut text.
import test from "node:test";
import assert from "node:assert/strict";
import { workflowErrorDetails, workflowErrorParts, workflowErrorWords, workflowFailure, workflowScriptErrorLine } from "../src/index.js";
import { workflowNodeNow, workflowNodeResult } from "../src/workflow-node-summary.js";

const STDERR = [
    "file:///tmp/wf-script-7c1/script.mjs:101",
    "    if (!payload.ok) throw new Error(payload.error)",
    "                     ^",
    "",
    "Error: Unknown model \"azure-openai:gpt-5.6-terra\". Call list_available_models and choose an exact configured provider:model value.",
    "    at callTool (file:///tmp/wf-script-7c1/script.mjs:101:28)",
    "    at async main (file:///tmp/wf-script-7c1/script.mjs:130:15)",
    "    at async run (file:///tmp/wf-script-7c1/script.mjs:160:9)",
    "    at async file:///tmp/wf-script-7c1/script.mjs:200:1",
    "",
    "Node.js v24.11.0",
].join("\n");
// canonicalJson sorts keys: code, details { exitCode, stderr }, message.
const WHOLE = JSON.stringify({ code: "execution_failed", details: { exitCode: 1, stderr: STDERR }, message: "The script exited with code 1." });
const CUT = `${WHOLE.slice(0, 499)}…`;
const WORDS = "the script stopped with an error: Unknown model \"azure-openai:gpt-5.6-terra\". Call list_available_models and choose an exact configured provider:model value.";

test("a script error reads as the error its script raised, whole or cut", () => {
    assert.ok(!CUT.includes("The script exited"), "the cut preview has lost its message");
    assert.throws(() => JSON.parse(CUT));
    for (const value of [WHOLE, CUT, JSON.parse(WHOLE)]) {
        assert.equal(workflowErrorWords(value), WORDS);
        assert.doesNotMatch(workflowErrorWords(value), /exitCode|stderr|"code"|\bat callTool/);
    }
    assert.deepEqual({ ...workflowErrorParts(CUT), raw: undefined }, {
        code: "execution_failed", message: null, exitCode: 1, stderr: workflowErrorParts(CUT).stderr, raw: undefined, stderrCut: true,
    });
    // The details keep the error as it arrived: indented when whole, its text when cut.
    assert.equal(workflowErrorDetails(WHOLE), JSON.stringify(JSON.parse(WHOLE), null, 2));
    assert.equal(workflowErrorDetails(CUT), CUT);
});

test("other errors read as their message; a script without an error line says its exit code", () => {
    assert.equal(workflowErrorWords(JSON.stringify({ code: "timed_out", message: "The script ran past its 30s timeout." })), "The script ran past its 30s timeout.");
    assert.equal(workflowErrorWords(JSON.stringify({ code: "execution_failed", details: { exitCode: 3, stderr: "nothing useful" }, message: "x" })),
        "the script exited with code 3");
    assert.equal(workflowErrorWords("{\"message\":\"cherry is out of stock\"}"), "cherry is out of stock");
    assert.equal(workflowErrorWords("\"no stock\""), "no stock");
    assert.equal(workflowErrorWords("plain words"), "plain words");
    assert.equal(workflowErrorWords(JSON.stringify({ code: "unavailable" })), "unavailable");
    assert.equal(workflowErrorWords(null), null);
    assert.equal(workflowErrorWords(""), null);
    // A message cut inside an escape keeps what arrived, and says it was cut (review UI2-F8).
    assert.equal(workflowErrorWords("{\"code\":\"x\",\"message\":\"a \\\"quoted\\u00"), "a \"quoted…");
    // Error lines of other runtimes.
    assert.equal(workflowScriptErrorLine("Traceback (most recent call last):\n  File \"s.py\", line 3\nValueError: bad input"), "bad input");
    assert.equal(workflowScriptErrorLine("TypeError [ERR_INVALID_ARG_TYPE]: The \"path\" argument must be of type string"),
        "The \"path\" argument must be of type string");
    assert.equal(workflowScriptErrorLine("    at main (x.mjs:1:1)"), null);
});

test("the failed Workflow's headline, reason and details, and the Node panel, use the words", () => {
    const run = { status: "failed", terminalState: "poll", error: JSON.stringify({ code: "execution_failed",
        message: "State 'poll' ended with runtime error 'execution_failed' and has no route for it.", details: { nodeExecutionId: "nx-poll-7" } }),
    nodeExecutions: [{ nodeExecutionId: "nx-poll-7", stateId: "poll", state: "completed", resultKind: "runtime_error", outcome: "execution_failed",
        errorPreview: CUT }] };
    const failure = workflowFailure(run);
    assert.equal(failure.headline, `poll failed: ${WORDS}`);
    assert.equal(failure.reason, `at poll: ${WORDS}`);
    assert.equal(failure.details, CUT);
    const node = { id: "poll", type: "script", runs: 7 };
    const execution = { id: "nx-poll-7", status: "completed", resultKind: "runtime_error", outcome: "execution_failed", errorPreview: CUT };
    assert.equal(workflowNodeResult(node, execution)?.text, `${WORDS} · execution_failed`);
    assert.doesNotMatch(workflowNodeNow(node, execution) ?? "", /exitCode|stderr/);
});

// Review UI-D7: readable words are a summary, not the whole error. Whenever they leave out recorded detail (a cut preview,
// a script's stderr), the whole error stays readable: Read the whole value in the Node panel (also for an error the
// Workflow handled and then went on) and Read the whole error under a failed Workflow's headline.
test("UI-D7: a summarized error keeps the whole error readable, in the Node panel and under the headline", async () => {
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { WorkflowV2FailureDetails, WorkflowV2NodeSummary } = await import("../../react/src/workflow-v2-panels.js");
    const { workflowV2ExecutionValueKey } = await import("../src/workflow-v2-view.js");
    const { workflowErrorLeavesOut } = await import("../src/workflow-error-words.js");
    assert.equal(workflowErrorLeavesOut(CUT), true, "a cut preview");
    assert.equal(workflowErrorLeavesOut(WHOLE), true, "a script's stderr and exit code");
    assert.equal(workflowErrorLeavesOut(JSON.stringify({ code: "timed_out", message: "The script ran past its 30s timeout." })), false);
    assert.equal(workflowErrorLeavesOut("plain words"), false);
    assert.equal(workflowErrorLeavesOut(JSON.stringify({ message: "x".repeat(300) })), true, "words shortened to 240 characters");

    // The Node panel: a handled error (the Workflow took its route and went on) and a failed run's visit alike.
    const values = { [workflowV2ExecutionValueKey("run-1", "nx-poll-7")]: { runId: "run-1", executionId: "nx-poll-7", phase: "loaded",
        result: { kind: "error", whole: true, bytes: WHOLE.length, value: JSON.parse(WHOLE) } } };
    for (const outcome of ["execution_failed", "handled"]) {
        const execution = { id: "nx-poll-7", status: "completed", resultKind: "runtime_error", outcome, errorPreview: CUT, ordinal: 7 };
        const node = { id: "poll", type: "script", kind: "script", runs: 7, executions: [execution], next: {}, current: execution };
        const result = workflowNodeResult(node, execution);
        assert.deepEqual({ truncated: result.truncated, summary: result.summary }, { truncated: true, summary: true }, outcome);
        const asked = [];
        const render = executionValues => renderToStaticMarkup(React.createElement(WorkflowV2NodeSummary, { selected: node, nodes: [node], select: () => {},
            runId: "run-1", executionValues, onReadWholeValue: id => asked.push(id) }));
        const before = render(null);
        assert.ok(before.includes(">Summary.<"), before);
        assert.ok(/data-action="whole-value"[^>]*data-execution="nx-poll-7"/.test(before), before);
        const after = render(values);
        assert.ok(after.includes("<h3>Error · ") && after.includes("Node.js v24.11.0"), "the tail of the stored stderr is reachable");
    }
    // A short whole error said fully by its words: nothing more to read.
    const short = { id: "nx-1", status: "completed", resultKind: "runtime_error", outcome: "timed_out",
        errorPreview: JSON.stringify({ code: "timed_out", message: "The script ran past its 30s timeout." }) };
    assert.equal(workflowNodeResult({ id: "poll", type: "script", runs: 1 }, short).truncated, false);

    // Under the headline of a failed run: the folded details are the cut preview; Read the whole error reads the visit's.
    const run = { status: "failed", terminalState: "poll", error: JSON.stringify({ code: "execution_failed", message: "no route",
        details: { nodeExecutionId: "nx-poll-7" } }),
    nodeExecutions: [{ nodeExecutionId: "nx-poll-7", stateId: "poll", state: "completed", resultKind: "runtime_error", outcome: "execution_failed",
        errorPreview: CUT }] };
    const failure = workflowFailure(run);
    assert.deepEqual({ leavesOut: failure.leavesOut, executionId: failure.executionId }, { leavesOut: true, executionId: "nx-poll-7" });
    const asked = [];
    const details = executionValues => renderToStaticMarkup(React.createElement(WorkflowV2FailureDetails, { failure, runId: "run-1", executionValues,
        onReadWholeValue: id => asked.push(id) }));
    const folded = details(null);
    assert.ok(folded.includes("<summary>Details</summary>") && /data-action="whole-error"[^>]*>Show all</.test(folded), folded);
    assert.ok(details(values).includes("Node.js v24.11.0"));
    // A failure whose words say it all, with nothing more recorded: no Details at all.
    const plain = workflowFailure({ status: "failed", terminalState: "poll", error: "plain words" });
    assert.equal(renderToStaticMarkup(React.createElement(WorkflowV2FailureDetails, { failure: plain, runId: "run-1" })), "");
});

// HN #2 on live data (5482bae3): a node's runtime error is stored as its envelope's JSON text, so the read's errorPreview
// (previewJson: canonical JSON, cut at 500 characters with "…") is a JSON string of that text, escaped once more and,
// for a long stderr, cut with no closing quote. Its words were the raw text. Read the text inside, whole or cut.
const sorted = value => (value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value);
const previewOf = (value, max = 500) => { const json = JSON.stringify(sorted(value)); return json.length > max ? `${json.slice(0, max)}…` : json; };
test("a node's error preview that is a JSON string of its envelope reads in words, cut or whole", () => {
    const stderr = ["<anonymous_script>:3", "<note>Content truncated. Call the fetch tool with a start_index of 4000 to get more content.</note>", "^", "",
        "SyntaxError: Expected ',' or ']' after array element in JSON at position 4002 (line 3 column 1)", "    at JSON.parse (<anonymous>)",
        ...Array.from({ length: 12 }, (_, i) => `    at frame${i} (file:///tmp/pilotswarm-script-x/script.mjs:${100 + i}:15)`), "", "Node.js v24.11.0"].join("\n");
    const envelopeText = JSON.stringify(sorted({ code: "execution_failed", message: "The script exited with code 1.", details: { exitCode: 1, stderr } }));
    const cut = previewOf(envelopeText);
    assert.ok(cut.startsWith("\"{\\\"code\\\":\\\"execution_failed\\\"") && cut.endsWith("…") && cut.length === 501, "the live shape");
    assert.equal(workflowErrorWords(cut), "the script stopped with an error: Expected ',' or ']' after array element in JSON at position 4002 (line 3 column 1)");
    assert.ok(workflowErrorDetails(cut).startsWith("{\"code\":\"execution_failed\",\"details\":{\"exitCode\":1,\"stderr\":\"<anonymous_script>:3\\n"),
        "the details are the envelope's text, not escaped twice");
    // r3's ux-boom: short enough to arrive whole.
    const boomText = JSON.stringify(sorted({ code: "execution_failed", message: "The script exited with code 1.",
        details: { exitCode: 1, stderr: "file:///tmp/s.mjs:1\nthrow new Error('ux-boom-4821');\n^\n\nError: ux-boom-4821\n    at file:///tmp/s.mjs:1:7" } }));
    const whole = previewOf(boomText);
    assert.ok(!whole.endsWith("…"));
    assert.equal(workflowErrorWords(whole), "the script stopped with an error: ux-boom-4821");
    // A plain JSON string still reads as itself; a cut that ends inside an escape keeps what arrived.
    assert.equal(workflowErrorWords("\"no stock\""), "no stock");
    const literal = JSON.stringify("{\"message\":\"a \\u00e9 b\"}");
    const at = literal.indexOf("u00e9");
    // Review UI2-F8: words the cut ended inside say so ("…"), here before the rest of the message.
    assert.equal(workflowErrorWords(`${literal.slice(0, at + 2)}…`), "a…", "cut inside the text's own \\u escape");
    assert.equal(workflowErrorWords(`${literal.slice(0, at - 1)}…`), "a…", "cut between the two backslashes of the literal's escape");
    assert.equal(workflowErrorWords(literal), "a é b");
});

// HN #2's poll, exactly as the read gave it on wfsimp at 5482bae3 (run fae01890; executor's redacted read model): 501
// characters, a JSON string of the envelope's text, cut inside its stderr's stack.
const HN2_PREVIEW = "\"{\\\"code\\\":\\\"execution_failed\\\",\\\"details\\\":{\\\"exitCode\\\":1,\\\"stderr\\\":\\\"<anonymous_script>:3\\\\n<note>Content truncated. Call the fetch tool with a start_index of 4000 to get more content.</note>\\\\n^\\\\n\\\\nSyntaxError: Expected ',' or ']' after array element in JSON at position 4002 (line 3 column 1)\\\\n    at JSON.parse (<anonymous>)\\\\n    at parseToolJson (file:///tmp/pilotswarm-script-Ue71gI/script.mjs:134:15)\\\\n    at file:///tmp/pilotswarm-script-Ue71gI/script.mjs:137:13\\\\n    at process.proc…";
test("HN #2's exact error preview reads as its SyntaxError; a line the cut ends in ends with '…'; a short JSON error is unchanged", () => {
    assert.equal(HN2_PREVIEW.length, 501);
    assert.equal(workflowErrorWords(HN2_PREVIEW),
        "the script stopped with an error: Expected ',' or ']' after array element in JSON at position 4002 (line 3 column 1)",
        "its SyntaxError line arrived whole");
    // Cut inside that line, the words say so.
    const inLine = `${HN2_PREVIEW.slice(0, HN2_PREVIEW.indexOf("after array element") + 3)}…`;
    assert.equal(workflowErrorWords(inLine), "the script stopped with an error: Expected ',' or ']' aft…");
    // The existing paths: a whole short JSON error, and a plain envelope's JSON text, read as before.
    assert.equal(workflowErrorWords(JSON.stringify({ code: "timed_out", message: "The script ran past its 30s timeout." })), "The script ran past its 30s timeout.");
    assert.equal(workflowErrorWords(JSON.stringify({ code: "execution_failed", details: { exitCode: 1, stderr: "Error: ux-boom-4821\n    at x" },
        message: "The script exited with code 1." })), "the script stopped with an error: ux-boom-4821");
    assert.equal(workflowErrorWords(WHOLE), WORDS);
    assert.equal(workflowErrorWords(CUT), WORDS, "a cut plain preview whose error line arrived whole has no '…'");
});

// Review UI2-F8 (short UI re-review, low): a cut message lost its "…" (only a cut stderr kept one), and shortening to 240
// characters could leave half of a surrogate pair.
test("UI2-F8: cut message words end with '…'; shortening never splits a character; whole words get no '…'", () => {
    // A plain message string, cut (a node's error preview that is a JSON string).
    assert.equal(workflowErrorWords(`${JSON.stringify("The feed answered 503 three times in a row")}`.slice(0, 20) + "…"), "The feed answered 5…");
    // An envelope's message field, cut in its JSON text; and the same field whole.
    assert.equal(workflowErrorWords("{\"code\":\"timed_out\",\"message\":\"The script ran past its 30s tim…"), "The script ran past its 30s tim…");
    assert.equal(workflowErrorWords("{\"code\":\"timed_out\",\"message\":\"The script ran past its 30s timeout.\",\"details\":{\"x\":\"…"),
        "The script ran past its 30s timeout.", "a message that arrived whole has no '…'");
    // Double-escaped (a JSON string of the envelope's text), cut inside the message.
    const envelope = JSON.stringify(JSON.stringify({ code: "timed_out", message: "The script ran past its 30s timeout." }));
    assert.equal(workflowErrorWords(`${envelope.slice(0, envelope.indexOf("past") + 4)}…`), "The script ran past…");
    // 238 ASCII characters, then U+1F600 across the 239-code-unit bound, then more.
    const long = `${"x".repeat(238)}\u{1F600}${"y".repeat(20)}`;
    const said = workflowErrorWords(JSON.stringify({ code: "bad", message: long }));
    assert.ok(said.endsWith("…") && said.length <= 240);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(said.replace(/\p{Extended_Pictographic}/gu, "")), "no lone high surrogate");
    assert.equal(said, `${"x".repeat(238)}…`);
    // A whole long message of plain characters is shortened as before.
    assert.equal(workflowErrorWords(JSON.stringify({ code: "bad", message: "z".repeat(300) })), `${"z".repeat(239)}…`);
});
