import test from "node:test";
import assert from "node:assert/strict";
import { runScriptNode } from "../../dist/workflow/runner.js";

const LIMIT = 1024 * 1024;
const run = (source, callTool) => runScriptNode({
    sessionId: "tool-result-limit",
    node: { id: "read", source, timeoutSeconds: 15 },
    context: { input: null, inputs: {} },
    callTool,
});
const diagnostic = bytes => `Workflow tool 'large' result is ${bytes} bytes; limit is ${LIMIT} bytes. Use paging or request a smaller result.`;

test("FB-079 the serialized result limit is per call, inclusive, and preserves JSON normalization", async () => {
    let serialized = 0;
    const result = await run(`
        const lengths = [];
        for (let n = 0; n < 2; n++) lengths.push((await callTool("large", {})).length);
        const normalized = await callTool("normalized", {});
        await setResult("done", { lengths, normalized });
    `, async ({ name }) => name === "large" ? "x".repeat(LIMIT - 2) : {
        toJSON() { serialized++; return { value: 3, omitted: undefined }; },
    });
    assert.equal(result.outcome, "done");
    assert.deepEqual(result.output, { lengths: [LIMIT - 2, LIMIT - 2], normalized: { value: 3 } });
    assert.equal(serialized, 1);
    assert.equal(result.toolCalls.length, 3);
    assert.ok(result.toolCalls.every(call => call.ok));
});

for (const value of ["x".repeat(LIMIT - 1), { text: "\u20ac".repeat(350_000) }, "\u0000".repeat(180_000)]) {
    test(`FB-079 rejects ${Buffer.byteLength(JSON.stringify(value))} serialized bytes, including UTF-8 and escapes`, async () => {
        let effects = 0;
        const result = await run(`
            try { await callTool("large", {}); await setResult("unexpected", null); }
            catch (error) { await setResult("refused", { message: error.message, next: await callTool("small", {}) }); }
        `, async ({ name }) => { effects++; return name === "large" ? value : "ok"; });
        assert.equal(result.outcome, "refused");
        assert.deepEqual(result.output, { message: diagnostic(Buffer.byteLength(JSON.stringify(value))), next: "ok" });
        assert.equal(effects, 2, "oversized results are not retried");
        assert.deepEqual(result.toolCalls.map(call => call.ok), [false, true]);
    });
}

test("FB-079 oversized tool errors return a bounded explicit size error", async () => {
    const message = "x".repeat(LIMIT);
    const result = await run(`
        try { await callTool("large", {}); }
        catch (error) { await setResult("refused", error.message); }
    `, async () => { throw new Error(message); });
    assert.equal(result.outcome, "refused");
    assert.equal(result.output, diagnostic(Buffer.byteLength(JSON.stringify(message))));
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].error, result.output);
});
