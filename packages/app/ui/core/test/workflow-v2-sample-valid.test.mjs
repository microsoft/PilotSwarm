/**
 * UXFD (C2): the Start form's sample inputs (workflowV2SampleInputs) can be submitted as offered: as many list items as
 * minItems asks for, all different when uniqueItems asks for that, texts padded to minLength, an enum's first value.
 * Checked with the validator the server checks a Start with (the SDK's WorkflowSchemaSet).
 *
 * Run: node --test ui/core/test/workflow-v2-sample-valid.test.mjs (after the SDK build: it reads packages/sdk/dist)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { workflowV2SampleInputs, workflowV2SampleValue } from "../src/workflow-v2-commands.js";
import { WorkflowSchemaSet } from "../../../../sdk/dist/workflow/v2/schema.js";

const problemsOf = (schema, value) => new WorkflowSchemaSet({ S: schema }).validate("S", value);

test("a list of at least 6 different texts, a text of at least 3 characters and an enum: the sample is valid", () => {
    const schema = {
        type: "object", required: ["sessions", "topic", "mode"], additionalProperties: false,
        properties: {
            sessions: { type: "array", minItems: 6, uniqueItems: true, items: { type: "string" } },
            topic: { type: "string", minLength: 3, maxLength: 4 },
            mode: { type: "string", enum: ["fast", "slow"] },
        },
    };
    const sample = workflowV2SampleInputs(schema);
    assert.deepEqual(problemsOf(schema, sample), [], JSON.stringify(sample));
    assert.equal(sample.sessions.length, 6);
    assert.equal(new Set(sample.sessions).size, 6);
    assert.equal(sample.topic, "exam");
    assert.equal(sample.mode, "fast");
});

test("different items of other kinds: numbers in a range, dates, e-mail addresses, objects, an enum, booleans", () => {
    const schema = {
        type: "object", required: ["n", "when", "who", "rows", "pick", "flags", "nested"],
        properties: {
            n: { type: "array", minItems: 3, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 3 } },
            when: { type: "array", minItems: 3, uniqueItems: true, items: { type: "string", format: "date-time" } },
            who: { type: "array", minItems: 2, uniqueItems: true, items: { type: "string", format: "email" } },
            rows: { type: "array", minItems: 3, maxItems: 10, uniqueItems: true, items: { type: "object", required: ["name"], properties: { name: { type: "string", maxLength: 4 } } } },
            pick: { type: "array", minItems: 2, uniqueItems: true, items: { type: "string", enum: ["a", "b", "c"] } },
            flags: { type: "array", minItems: 2, uniqueItems: true, items: { type: "boolean" } },
            nested: { type: "array", minItems: 2, maxItems: 10, uniqueItems: true, items: { type: "array", minItems: 2, uniqueItems: true, items: { type: "string" } } },
        },
    };
    const sample = workflowV2SampleInputs(schema);
    assert.deepEqual(problemsOf(schema, sample), [], JSON.stringify(sample));
    assert.deepEqual(sample.n, [1, 2, 3]);
    assert.deepEqual(sample.pick, ["a", "b"]);
    assert.deepEqual(sample.flags, [false, true]);
});

test("without uniqueItems the items stay copies, now as many as minItems; maxItems 0 gives an empty list", () => {
    assert.deepEqual(workflowV2SampleValue({ type: "array", minItems: 5, items: { type: "string" } }), { value: Array(5).fill("example") });
    assert.deepEqual(workflowV2SampleValue({ type: "array", maxItems: 0, items: { type: "string" } }), { value: [] });
    const schema = { type: "array", minItems: 4, items: { type: "integer" } };
    assert.deepEqual(problemsOf(schema, workflowV2SampleValue(schema).value), []);
    // A count past the budget gives no sample, at once.
    assert.equal(workflowV2SampleValue({ type: "array", minItems: 2 ** 40, uniqueItems: true, items: { type: "integer" } }), null);
});
