/**
 * Workflow Simplified stage 2.1c, FU-19: a failed step's error in short plain words, made on the server from the whole
 * stored error (error-words.ts), as the portal says them (packages/app/ui/core/src/workflow-error-words.js), so a long
 * error cut in its 500-character preview (HN #2: keys in sorted order, the script's stderr cut before its error line)
 * still reads in words. The database side (the failure events and the read) is test/local/workflow-v2-error-words.test.js.
 *
 * Run: node --test test/unit/workflow-error-words.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { WORKFLOW_ERROR_WORDS_MAX, workflowErrorWords, workflowScriptErrorLine } from "../../dist/workflow/v2/error-words.js";

const NOISE = Array.from({ length: 40 }, (_, index) => `    at frame${index} (file:///work/script.mjs:${index}:1)`).join("\n");

test("a script that failed: the stderr line that names its error, else its exit code", () => {
    const envelope = { code: "execution_failed", message: "The script exited with code 1 without a result.",
        details: { exitCode: 1, stderr: `${NOISE}\nfile:///work/script.mjs:3\nSyntaxError: Expected ',' or ']' after array element in JSON at position 4002\n${NOISE}` } };
    const words = "the script stopped with an error: Expected ',' or ']' after array element in JSON at position 4002";
    // The envelope, its JSON text, and that text as a JSON string (how a node's error is stored and previewed) say the same.
    assert.equal(workflowErrorWords(envelope), words);
    assert.equal(workflowErrorWords(JSON.stringify(envelope)), words);
    assert.equal(workflowErrorWords(JSON.stringify(JSON.stringify(envelope))), words);
    // Its preview is cut before the line (the HN #2 shape): the whole error is what the words are made from.
    assert.ok(!JSON.stringify(JSON.stringify(envelope)).slice(0, 500).includes("SyntaxError"));
    assert.equal(workflowErrorWords({ code: "execution_failed", message: "x", details: { exitCode: 3, stderr: "no error line here" } }),
        "the script exited with code 3");
    assert.equal(workflowErrorWords({ code: "execution_failed", message: "The script exited with code 2.", details: { exitCode: 2 } }), "the script exited with code 2");
    assert.equal(workflowScriptErrorLine("Uncaught TypeError [ERR_X]: boom\n    at x"), "boom");
    assert.equal(workflowScriptErrorLine("nothing"), null);
});

test("any other error: its message, else its code; text as it is; nothing for nothing", () => {
    assert.equal(workflowErrorWords({ code: "timed_out", message: "The agent did not complete the state before its deadline." }),
        "The agent did not complete the state before its deadline.");
    assert.equal(workflowErrorWords({ code: "invalid_output" }), "invalid_output");
    assert.equal(workflowErrorWords("the feed did not answer"), "the feed did not answer");
    for (const nothing of [null, undefined, "", "   ", 7, [], {}]) assert.equal(workflowErrorWords(nothing), null, JSON.stringify(nothing));
});

test("at most 240 characters on one line, \"…\" last when shortened, never half a surrogate pair", () => {
    const long = workflowErrorWords({ code: "execution_failed", message: "m", details: { stderr: `Error: ${"x".repeat(400)}` } });
    assert.equal(long.length, WORKFLOW_ERROR_WORDS_MAX);
    assert.ok(long.endsWith("…"));
    const emoji = workflowErrorWords({ code: "x", message: `${"a".repeat(238)}😀😀` });
    assert.ok(emoji.length <= WORKFLOW_ERROR_WORDS_MAX);
    assert.ok(!/[\ud800-\udbff]…$/u.test(emoji), "no lone high surrogate before the ellipsis");
    assert.equal(workflowErrorWords({ code: "x", message: "line one\n  line two" }), "line one line two");
});

test("secrets in the error never reach the words", () => {
    const secret = "sk-test-0123456789abcdefghijklmnop";
    const words = workflowErrorWords({ code: "execution_failed", message: "m",
        details: { stderr: `Error: request to https://user:${secret}@example.invalid/v1 failed with token=${secret}` } });
    assert.ok(words.startsWith("the script stopped with an error: "), words);
    assert.ok(!words.includes(secret), words);
    assert.ok(!(workflowErrorWords({ code: "x", message: `Authorization: Bearer ${secret}` }) ?? "").includes(secret));
    assert.ok(!(workflowErrorWords(`password=${secret}`) ?? "").includes(secret));
});
