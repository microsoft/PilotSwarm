import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflowV2 } from "../../dist/workflow/v2/compiler.js";

// Batch 7 (s-1, s-2): a state's input that has no binding is fixed, so the compiler checks it against the schema the run
// checks it against (a send's contract, a script's inputSchema): a mismatch is WORKFLOW_STATE_INPUT_INVALID. JSON written
// as a text string where the schema wants an object or an array is the warning WORKFLOW_INPUT_JSON_TEXT, bound or not.

const SENDER = (input, extraStates = "") => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: fact-sender, version: "1.0.0" }
inputs: { schema: { type: object } }
initial: tell
schemas:
  Fact:
    type: object
    required: [fact]
    properties:
      fact: { type: string }
      details: { $ref: "#/schemas/Details" }
      tags: { type: array, items: { $ref: "#/schemas/Tag" } }
      loose: { properties: { a: { type: integer } } }
      list: { items: { type: string } }
  Details:
    type: object
    properties:
      note: { type: string }
  Tag:
    type: object
    properties:
      name: { type: string }
contracts:
  Fact@1: { schema: { $ref: "#/schemas/Fact" } }
states:
  tell:
    type: messaging
    mode: send
    contract: Fact@1
    recipient: { parent: true }
    input: ${input}
    transition: { next: { sent: done, failure: refused } }
${extraStates}  done: { type: terminal, outcome: succeeded }
  refused: { type: terminal, outcome: failed }
`;

const SCRIPT = input => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: fixed-script, version: "1.0.0" }
inputs: { schema: { type: object } }
initial: calc
states:
  calc:
    type: script
    source: |
      await setResult("done", context.input);
    inputSchema:
      type: object
      required: [n]
      properties:
        n: { type: integer }
        options: { type: object }
    input: ${input}
    outcomes: [done]
    transition: { next: { done: finish, failure: refused } }
  finish: { type: terminal, outcome: succeeded }
  refused: { type: terminal, outcome: failed }
`;

const codes = (compiled, code) => compiled.diagnostics.filter(item => item.code === code);
const JSON_TEXT_MESSAGE = /^This is a text string that looks like JSON\. Write it as a YAML value \(no quotes\) so it is an? (object|array)\.$/;

test("a send's input written as JSON text is a string, refused for a contract that takes an object", () => {
    const compiled = compileWorkflowV2(SENDER(`'{"fact": "MVCC keeps old row versions"}'`));
    assert.equal(compiled.valid, false);
    const [error] = codes(compiled, "WORKFLOW_STATE_INPUT_INVALID");
    assert.ok(error, JSON.stringify(compiled.diagnostics));
    assert.equal(error.severity, "error");
    assert.equal(error.path, "states.tell.input");
    assert.match(error.message, /^this input has no binding, so it is sent as written, and it does not match contract 'Fact@1': /);
    assert.match(error.message, /\/ must be object/);
    const [warning] = codes(compiled, "WORKFLOW_INPUT_JSON_TEXT");
    assert.ok(warning, JSON.stringify(compiled.diagnostics));
    assert.equal(warning.severity, "warning");
    assert.equal(warning.path, "states.tell.input");
    assert.match(warning.message, JSON_TEXT_MESSAGE);
    assert.match(warning.message, /an object\.$/);
});

test("the same input as a YAML map compiles with no input diagnostics", () => {
    for (const input of [`{ fact: "MVCC keeps old row versions" }`, `{ fact: "x", details: { note: "y" }, tags: [{ name: "a" }] }`]) {
        const compiled = compileWorkflowV2(SENDER(input));
        assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
        assert.equal(codes(compiled, "WORKFLOW_STATE_INPUT_INVALID").length, 0);
        assert.equal(codes(compiled, "WORKFLOW_INPUT_JSON_TEXT").length, 0);
    }
});

test("a fixed map that does not match its contract names the first problems", () => {
    const compiled = compileWorkflowV2(SENDER(`{ other: 1 }`));
    assert.equal(compiled.valid, false);
    const [error] = codes(compiled, "WORKFLOW_STATE_INPUT_INVALID");
    assert.ok(error, JSON.stringify(compiled.diagnostics));
    assert.equal(error.path, "states.tell.input");
    assert.match(error.message, /fact/);
});

test("a bound input is not checked against its contract", () => {
    for (const input of [`"\${inputs.fact}"`, `{ fact: "\${inputs.fact}", other: "\${inputs.other}" }`, `{ fact: "\${inputs.fact}", details: "\${inputs.details}" }`]) {
        const compiled = compileWorkflowV2(SENDER(input));
        assert.equal(codes(compiled, "WORKFLOW_STATE_INPUT_INVALID").length, 0, `${input}: ${JSON.stringify(compiled.diagnostics)}`);
        assert.equal(compiled.valid, true, `${input}: ${JSON.stringify(compiled.diagnostics)}`);
    }
});

test("JSON text inside a bound input still warns where the schema ($ref, properties, items) wants an object or an array", () => {
    const compiled = compileWorkflowV2(SENDER(
        `{ fact: "\${inputs.fact}", details: '{"note": "y"}', tags: ['{"name": "a"}', { name: "b" }], loose: '{"a": 1}', list: '["a"]' }`));
    // SF-8: the fixed parts are checked too: details is written as text where an object is required.
    assert.equal(compiled.valid, false);
    assert.match(codes(compiled, "WORKFLOW_STATE_INPUT_INVALID")[0]?.message ?? "", /a fixed part of this input .* \/details must be object/);
    const warnings = codes(compiled, "WORKFLOW_INPUT_JSON_TEXT");
    assert.deepEqual(warnings.map(item => item.path).sort(),
        ["states.tell.input.details", "states.tell.input.list", "states.tell.input.loose", "states.tell.input.tags[0]"]);
    for (const warning of warnings) {
        assert.equal(warning.severity, "warning");
        assert.match(warning.message, JSON_TEXT_MESSAGE);
    }
    assert.match(warnings.find(item => item.path === "states.tell.input.list").message, /an array\.$/);
    assert.match(warnings.find(item => item.path === "states.tell.input.details").message, /an object\.$/);
});

test("no warning where the schema wants a string, for text that is not JSON, or where no schema is known", () => {
    for (const input of [
        `{ fact: '{"a": 1}' }`,
        `{ fact: "x", details: "{not json" }`,
        `{ fact: "x", details: "[1, 2" }`,
        `{ fact: "x", unknown: '{"a": 1}' }`,
    ]) {
        const compiled = compileWorkflowV2(SENDER(input));
        assert.equal(codes(compiled, "WORKFLOW_INPUT_JSON_TEXT").length, 0, `${input}: ${JSON.stringify(compiled.diagnostics)}`);
    }
});

test("a script's fixed input is checked against its inputSchema", () => {
    const bad = compileWorkflowV2(SCRIPT(`{ n: "two" }`));
    assert.equal(bad.valid, false);
    const [error] = codes(bad, "WORKFLOW_STATE_INPUT_INVALID");
    assert.ok(error, JSON.stringify(bad.diagnostics));
    assert.equal(error.path, "states.calc.input");
    assert.match(error.message, /does not match its inputSchema: /);
    assert.match(error.message, /\/n /);

    const text = compileWorkflowV2(SCRIPT(`'{"n": 2}'`));
    assert.equal(text.valid, false);
    assert.equal(codes(text, "WORKFLOW_STATE_INPUT_INVALID")[0]?.path, "states.calc.input");
    assert.equal(codes(text, "WORKFLOW_INPUT_JSON_TEXT")[0]?.path, "states.calc.input");

    const good = compileWorkflowV2(SCRIPT(`{ n: 2, options: { fast: true } }`));
    assert.equal(good.valid, true, JSON.stringify(good.diagnostics));
    assert.equal(codes(good, "WORKFLOW_STATE_INPUT_INVALID").length, 0);

    const bound = compileWorkflowV2(SCRIPT(`{ n: "\${inputs.n}", options: '{"fast": true}' }`));
    assert.deepEqual(codes(bound, "WORKFLOW_INPUT_JSON_TEXT").map(item => item.path), ["states.calc.input.options"]);
    // SF-8: its fixed options are text where an object is required.
    assert.equal(bound.valid, false);
    const boundOk = compileWorkflowV2(SCRIPT(`{ n: "\${inputs.n}", options: { fast: true } }`));
    assert.equal(boundOk.valid, true, JSON.stringify(boundOk.diagnostics));
});

// Adversarial review SF-8: one binding no longer disables the check of the input's fixed parts.
test("SF-8: a partly bound input's fixed parts are checked: wrong type, missing required property, enum", () => {
    const wrongType = compileWorkflowV2(SCRIPT(`{ n: "x", options: "\${inputs.options}" }`));
    assert.equal(wrongType.valid, false);
    assert.match(codes(wrongType, "WORKFLOW_STATE_INPUT_INVALID")[0].message, /\/n must be integer/);
    const missing = compileWorkflowV2(SENDER(`{ other: "\${inputs.fact}" }`));
    assert.equal(missing.valid, false);
    assert.match(codes(missing, "WORKFLOW_STATE_INPUT_INVALID")[0].message, /must have required property 'fact'/);
    const fine = compileWorkflowV2(SCRIPT(`{ n: 3, options: "\${inputs.options}" }`));
    assert.equal(fine.valid, true, JSON.stringify(fine.diagnostics));
    const allBound = compileWorkflowV2(SCRIPT(`"\${inputs.whole}"`));
    assert.equal(allBound.valid, true, JSON.stringify(allBound.diagnostics));
});

// Verification of SF-8: each fixed part of a partly bound input is validated whole, with the run's validator.
const RICH = input => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: rich-script, version: "1.0.0" }
inputs: { schema: { type: object } }
initial: calc
schemas:
  Address:
    type: object
    required: [city]
    properties:
      city: { type: string, minLength: 2 }
states:
  calc:
    type: script
    source: |
      await setResult("done", context.input);
    inputSchema:
      type: object
      properties:
        age: { type: integer, minimum: 18 }
        user: { type: string }
        home: { $ref: "#/schemas/Address" }
        tags: { type: array, items: { type: string, maxLength: 3 } }
        pair: { type: array, prefixItems: [{ type: integer }, { type: string }] }
    input: ${input}
    outcomes: [done]
    transition: { next: { done: finish, failure: refused } }
  finish: { type: terminal, outcome: succeeded }
  refused: { type: terminal, outcome: failed }
`;
const problemOf = yaml => codes(compileWorkflowV2(yaml), "WORKFLOW_STATE_INPUT_INVALID")[0]?.message ?? "";

test("SF-8: a fixed scalar below its minimum beside a binding is refused", () => {
    assert.match(problemOf(RICH(`{ age: 12, user: "\${inputs.user}" }`)), /\/age must be >= 18/);
});

test("SF-8: a fixed nested object missing a required property, or with a too-short string, is refused", () => {
    assert.match(problemOf(RICH(`{ user: "\${inputs.user}", home: { street: "x" } }`)), /\/home must have required property 'city'/);
    assert.match(problemOf(RICH(`{ user: "\${inputs.user}", home: { city: "x" } }`)), /\/home\/city must NOT have fewer than 2 characters/);
});

test("SF-8: a fixed array item beside a bound one, and a prefixItems item, are checked", () => {
    assert.match(problemOf(RICH(`{ tags: ["ok", "\${inputs.tag}", "toolong"] }`)), /\/tags\/2 must NOT have more than 3 characters/);
    assert.match(problemOf(RICH(`{ pair: ["\${inputs.n}", 7] }`)), /\/pair\/1 must be string/);
});

test("SF-8: a written-out object holding a binding must have its required properties, nested too", () => {
    assert.match(problemOf(RICH(`{ home: { street: "\${inputs.street}" } }`)), /\/home must have required property 'city'/);
});

test("SF-8: valid fixed parts beside bindings compile; a part holding a binding is left to the run", () => {
    for (const input of [
        `{ age: 30, user: "\${inputs.user}", home: { city: "Oslo" }, tags: ["a", "\${inputs.tag}"], pair: [1, "\${inputs.s}"] }`,
        `{ age: "\${inputs.age}", home: { city: "\${inputs.city}" } }`,
    ]) {
        const compiled = compileWorkflowV2(RICH(input));
        assert.equal(compiled.valid, true, `${input}: ${JSON.stringify(compiled.diagnostics)}`);
    }
});

// Verification of SF-8 in E2 (E2-R3; test E2-T6) and the final verification of E2bm-R1: the compiler evaluates no
// pattern. A fixed member of an object holding a binding takes its named property's schema (the run's validator, Ajv in
// strict mode, refuses a schema whose property name one of its patternProperties names matches, so no pattern applies
// to a named key). Any other member is left to the run when there are patternProperties (which apply needs them
// evaluated), and takes additionalProperties when there are none. A fixed part or a fixed input whose schema has a
// `pattern` or `patternProperties` anywhere below it is left to the run. A schema without patterns is still checked.
const POLY = "^a*a*a*a*a*a*b$";
const PATTERNED = (input, { patterns = true } = {}) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: patterned-script, version: "1.0.0" }
inputs: { schema: { type: object } }
initial: calc
states:
  calc:
    type: script
    source: |
      await setResult("done", context.input);
    inputSchema:
      type: object
      properties:
        user: { type: string }
        count: { type: integer }
        note: ${patterns ? `{ type: string, pattern: "${POLY}" }` : "{ type: string, maxLength: 3 }"}
${patterns ? `      patternProperties:
        "${POLY}": { type: integer }
        "^x-": { type: string }
` : ""}      additionalProperties: false
    input: ${input}
    outcomes: [done]
    transition: { next: { done: finish, failure: refused } }
  finish: { type: terminal, outcome: succeeded }
  refused: { type: terminal, outcome: failed }
`;
const compiledIn = (yaml) => {
    const started = performance.now();
    const compiled = compileWorkflowV2(yaml);
    return { compiled, ms: performance.now() - started };
};

test("E2-T6: a named member is checked against its property; a member a pattern would select is left to the run", () => {
    for (const input of [`{ user: "\${inputs.user}", x-note: "ok" }`, `{ user: "\${inputs.user}", count: 3 }`]) {
        const compiled = compileWorkflowV2(PATTERNED(input));
        assert.equal(compiled.valid, true, `${input}: ${JSON.stringify(compiled.diagnostics)}`);
    }
    // A named member, beside patternProperties, is checked here.
    assert.match(problemOf(PATTERNED(`{ user: "\${inputs.user}", count: "three" }`)), /\/count must be integer/);
    // Which pattern applies to x-note, or whether "other" matches none, needs a pattern evaluated: the run checks them.
    for (const input of [`{ user: "\${inputs.user}", x-note: 5 }`, `{ user: "\${inputs.user}", other: "x" }`]) {
        const compiled = compileWorkflowV2(PATTERNED(input));
        assert.equal(compiled.valid, true, `${input}: ${JSON.stringify(compiled.diagnostics)}`);
    }
});

test("E2-T6: without patterns, a member that names nothing takes additionalProperties, and a fixed input is checked whole", () => {
    assert.ok(problemOf(PATTERNED(`{ user: "\${inputs.user}", other: "x" }`, { patterns: false })).includes("/other"),
        "an unnamed key takes additionalProperties: false");
    assert.match(problemOf(PATTERNED(`{ user: "\${inputs.user}", note: "abcd" }`, { patterns: false })), /\/note must NOT have more than 3 characters/);
    assert.match(problemOf(PATTERNED(`{ count: "three" }`, { patterns: false })), /\/count must be integer/);
    assert.match(problemOf(PATTERNED(`{ other: "x" }`, { patterns: false })), /additional properties/);
});

// Final verification of E2bm-R1: ^a*a*a*a*a*a*b$ passes the pattern check (its cost is a power of the input, not
// exponential), and on a long run of "a" with no "b" its cost is a high power of the length: the length caps alone do
// not bound it. The compiler evaluates no pattern, so each of these compiles fast and is left to the run. Nothing here
// matches the pattern against a long input.
test("E2bm-R1: a schema with a pattern is not evaluated at compile time, under the length caps too; the run checks it", { timeout: 20_000 }, () => {
    const key = `${"a".repeat(255)}!`;
    const text = "a".repeat(4_000);
    for (const input of [
        `{ user: "\${inputs.user}", "${key}": 1 }`,
        `{ "${key}": 1 }`,
        `{ user: "\${inputs.user}", note: "${text}" }`,
        `{ note: "${text}" }`,
    ]) {
        const { compiled, ms } = compiledIn(PATTERNED(input));
        // If it were checked here, additionalProperties (the key) or the pattern (the text: it does not end in "b") would refuse it.
        assert.equal(compiled.valid, true, `${input.slice(0, 60)}: ${JSON.stringify(compiled.diagnostics).slice(0, 400)}`);
        assert.ok(ms < 3_000, `compiled in ${Math.round(ms)} ms`);
    }
    // A fixed input with a pattern-free schema is still refused at compile time when it is wrong, beside the same caps.
    assert.match(problemOf(PATTERNED(`{ user: "\${inputs.user}", count: "${"a".repeat(255)}" }`)), /\/count must be integer/);
});

test("E2bm-R1: the length caps are kept: a key over 256 characters or a string over 4,096 is left to the run", () => {
    // Pattern-free schema: up to the caps the fixed input is checked; past them it is left to the run.
    assert.match(problemOf(PATTERNED(`{ "${"k".repeat(256)}": "x" }`, { patterns: false })), /additional properties/);
    assert.equal(compileWorkflowV2(PATTERNED(`{ "${"k".repeat(257)}": "x" }`, { patterns: false })).valid, true);
    assert.match(problemOf(PATTERNED(`{ user: "\${inputs.user}", note: "${"n".repeat(4_096)}" }`, { patterns: false })), /\/note must NOT have more than 3 characters/);
    assert.equal(compileWorkflowV2(PATTERNED(`{ user: "\${inputs.user}", note: "${"n".repeat(4_097)}" }`, { patterns: false })).valid, true);
});
