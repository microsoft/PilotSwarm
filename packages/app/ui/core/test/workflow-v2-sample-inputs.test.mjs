// Batch 7 (f-05): sample inputs from a workflow's input schema (references already resolved by the read model's
// graph.inputsSchema), for the Inputs boxes of Publish and start, Start and Test review.
//
// Run: node --test packages/app/ui/core/test/workflow-v2-sample-inputs.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { workflowV2DefinitionControls, workflowV2InputsBoxEmpty, workflowV2SampleInputs, workflowV2TestControls } from "../src/workflow-v2-commands.js";
import { readModel } from "./workflow-v2-fixtures.mjs";

test("a sample takes each field's example, default or first enum value, else a value by its type and name", () => {
    const schema = {
        type: "object",
        required: ["change", "repo", "when", "owner", "count", "dryRun", "labels", "target", "mode", "note"],
        properties: {
            change: { type: "string" },
            repo: { type: "string", format: "uri" },
            when: { type: "string", format: "date-time" },
            owner: { type: "string", format: "email" },
            count: { type: "integer", minimum: 3 },
            dryRun: { type: "boolean" },
            labels: { type: "array", items: { type: "string" } },
            target: { type: "object", required: ["prUrl"], properties: { prUrl: { type: "string" }, extra: { type: "string" } } },
            mode: { type: "string", enum: ["fast", "slow"] },
            note: { type: ["string", "null"], examples: ["ship it"], default: "ignored" },
            optional: { type: "string" },
        },
    };
    assert.deepEqual(workflowV2SampleInputs(schema), {
        change: "example change", repo: "https://example.com/repo", when: "2026-01-01T09:00:00Z", owner: "owner@example.com",
        count: 3, dryRun: false, labels: ["example labels"], target: { prUrl: "example pr url", extra: "example extra" },
        mode: "fast", note: "ship it",
    }, "required fields only, as the object has more than four; a small nested object gets all of its fields");
    assert.deepEqual(workflowV2SampleInputs({ type: "object", properties: { a: { default: 5 }, b: { type: "number" } } }), { a: 5, b: 1 });
});

test("no schema, or one that is not an object, gives no sample; the box is filled only while it is empty or {}", () => {
    for (const schema of [null, undefined, true, { type: "string" }, { type: "array", items: { type: "string" } }]) {
        assert.equal(workflowV2SampleInputs(schema), null, JSON.stringify(schema));
    }
    for (const text of ["", "  ", "{}", " { } ", "\n{\n}\n"]) assert.equal(workflowV2InputsBoxEmpty(text), true, JSON.stringify(text));
    for (const text of ["{\"a\":1}", "[]", "x"]) assert.equal(workflowV2InputsBoxEmpty(text), false, text);
    // The panels read the schema of exactly the reviewed revision from the read model's graph.
    const inputsSchema = { type: "object", required: ["change"], properties: { change: { type: "string" } } };
    const commands = { operations: ["publish", "publish_and_start", "start", "test"], restriction: null, run: null };
    const draft = { ...readModel({ definition: { state: "draft", currentRevision: 1, publishedRevision: null, publishedDefinitionHash: null }, noRun: true }),
        personCommands: commands };
    draft.graph = { ...draft.graph, revision: 1, inputsSchema };
    assert.deepEqual(workflowV2DefinitionControls(draft).inputsSchema, inputsSchema);
    assert.deepEqual(workflowV2TestControls(draft).inputsSchema, inputsSchema);
    assert.equal(workflowV2DefinitionControls({ ...draft, graph: { ...draft.graph, revision: 2 } }).inputsSchema, null, "another revision's schema is not used");
});

// Adversarial review UI-3: a sample has a budget; a schema that asks for more gets no sample, and nothing large is made.
test("UI-3: a huge minLength, a huge default or many large copies give no sample; nothing large is allocated", () => {
    const started = process.hrtime.bigint();
    assert.equal(workflowV2SampleInputs({ type: "object", properties: { text: { type: "string", minLength: 9007199254740991 } } }), null);
    assert.equal(workflowV2SampleInputs({ type: "object", properties: { text: { type: "string", minLength: 1001 } } }), null);
    assert.equal(workflowV2SampleInputs({ type: "object", properties: { text: { type: "string", default: "y".repeat(20_000) } } }), null);
    const big = { type: "string", default: "z".repeat(3_000) };
    let nested = big;
    for (let i = 0; i < 6; i += 1) nested = { type: "array", minItems: 3, items: nested };
    assert.equal(workflowV2SampleInputs({ type: "object", required: ["deep"], properties: { deep: nested } }), null);
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 1_000, "bounded time");
});

test("UI-3: within the budget a sample is made as before", () => {
    assert.deepEqual(workflowV2SampleInputs({ type: "object", properties: { text: { type: "string", minLength: 20 } } }),
        { text: "example textxxxxxxxx" });
    assert.equal(workflowV2SampleInputs({ type: "object", properties: { text: { type: "string", minLength: 1000 } } }).text.length, 1000);
    assert.deepEqual(workflowV2SampleInputs({ type: "object", properties: { tags: { type: "array", minItems: 2, items: { type: "string", enum: ["a"] } } } }),
        { tags: ["a", "a"] });
});
