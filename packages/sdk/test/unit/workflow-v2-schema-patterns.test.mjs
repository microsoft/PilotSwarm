import test from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_PATTERN_MAX_LENGTH, unsafeSchemaPattern } from "../../dist/workflow/v2/schema.js";
import { compileWorkflowV2 } from "../../dist/workflow/v2/compiler.js";

// Adversarial review SF-5: a schema pattern that could take exponential time on a small input is refused when the
// definition is compiled; ordinary patterns keep working.

test("nested repeats and repeated overlapping alternatives are refused", () => {
    for (const pattern of ["^(a+)+$", "(a*)*", "((ab)*)+", "(.*a){10}", "(a|ab)*", "(a|a)+", "(\\w|\\d)+", "(x|.)*", "(|a)+", "(?:a+)+b",
        "([a-z]+\\.)+[a-z]+", "(a{2,})*", "^v\\d+(\\.\\d+){0,2}$"]) {
        assert.match(unsafeSchemaPattern(pattern) ?? "", /repeat|alternatives/, pattern);
    }
});

test("ordinary patterns are accepted", () => {
    for (const pattern of ["^[a-z0-9-]+$", "^\\d{4}-\\d{2}-\\d{2}$", "^(foo|bar)$", "^(foo|bar)+$", "^[A-Z]{2,3}$", "^(\\d+)?$", "(ab)*", "^a+b+c+$",
        "^[^\\]]+$", "^\\(\\d+\\)$", "^(?:https?)://[^\\s]+$", "^(a{1})+$"]) {
        assert.equal(unsafeSchemaPattern(pattern), null, pattern);
    }
});

test("a pattern longer than the limit, or with unmatched parentheses, is refused", () => {
    assert.equal(SCHEMA_PATTERN_MAX_LENGTH, 512);
    assert.equal(unsafeSchemaPattern("a".repeat(512)), null);
    assert.match(unsafeSchemaPattern("a".repeat(513)), /at most 512 characters/);
    assert.match(unsafeSchemaPattern("(a"), /unmatched '\('/);
    assert.match(unsafeSchemaPattern("a)"), /unmatched '\)'/);
});

const docWith = schema => JSON.stringify({
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "patterns", version: "1.0.0" },
    inputs: { schema }, initial: "pause",
    states: {
        pause: { type: "wait", seconds: 1, transition: { next: { elapsed: "done", failure: "failed" } } },
        done: { type: "terminal", outcome: "succeeded" },
        failed: { type: "terminal", outcome: "failed" },
    },
});

test("the compiler refuses an unsafe pattern or patternProperties name, and takes a safe one", () => {
    const unsafe = compileWorkflowV2(docWith({ type: "object", properties: { name: { type: "string", pattern: "^(a+)+$" } } }));
    assert.equal(unsafe.valid, false);
    assert.ok(unsafe.diagnostics.some(item => item.severity === "error" && /unsafe pattern/.test(item.message)), JSON.stringify(unsafe.diagnostics));
    const keys = compileWorkflowV2(docWith({ type: "object", patternProperties: { "^(x|xy)*$": { type: "string" } } }));
    assert.equal(keys.valid, false);
    assert.ok(keys.diagnostics.some(item => /unsafe pattern/.test(item.message)));
    const safe = compileWorkflowV2(docWith({ type: "object", properties: { name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" } } }));
    assert.equal(safe.valid, true, JSON.stringify(safe.diagnostics));
});
