/**
 * Workflow Simplified, review UI-13: the Start form never says "Takes no inputs" for a definition that may need them,
 * and Start another repeats the Workflow it comes from.
 * - A schema the form cannot draw, or that asks for input without listing it (oneOf, references, typed
 *   additionalProperties, minProperties, required, a non-object type), gets a JSON box.
 * - Start another is filled with the source Workflow's own inputs (its read's run.inputs), never sample values; when the
 *   read does not have them (none, or cut), it says so and asks the chat to use the same ones unless the person gives others.
 *
 * Run: node --test ui/core/test/workflow-simplified-start-inputs.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { workflowV2DrawableInput, workflowV2InputsShape, workflowV2RunInputs } from "../src/workflow-v2-commands.js";
import { StartDialog } from "../../react/src/workflow-tab.js";

test("the form's shape: none only when no input can be asked for; a JSON box for what it cannot draw", () => {
    assert.equal(workflowV2InputsShape(null), "none");
    assert.equal(workflowV2InputsShape({ type: "object" }), "none");
    assert.equal(workflowV2InputsShape({ type: "object", properties: {}, additionalProperties: false }), "none");
    assert.equal(workflowV2InputsShape({ type: "object", properties: { region: { type: "string" } } }), "form");
    assert.equal(workflowV2InputsShape({ type: "object", properties: { cfg: { type: "object" } } }), "json", "a field it cannot draw");
    for (const schema of [
        { type: "object", minProperties: 1, additionalProperties: { type: "string" } },
        { type: "object", oneOf: [{ required: ["a"] }, { required: ["b"] }] },
        { $ref: "#/$defs/Inputs" },
        { type: "object", required: ["x"] },
        { type: "object", patternProperties: { "^x-": { type: "string" } } },
        { type: "array" },
    ]) assert.equal(workflowV2InputsShape(schema), "json", JSON.stringify(schema));
    assert.equal(workflowV2DrawableInput({ enum: ["a", "b"] }), true);
    assert.equal(workflowV2DrawableInput({ type: "array", items: { type: "string" } }), true);
    assert.equal(workflowV2DrawableInput({ type: "object" }), false);
});

test("a run's inputs from its read: an object, or none when the read has none or cut them", () => {
    assert.deepEqual(workflowV2RunInputs({ run: { inputs: '{"region":"east"}' } }), { region: "east" });
    assert.deepEqual(workflowV2RunInputs({ run: { inputs: { region: "east" } } }), { region: "east" });
    assert.equal(workflowV2RunInputs({ run: { inputs: '{"region":"ea…' } }), null, "a cut preview");
    assert.equal(workflowV2RunInputs({ run: { inputs: "[1]" } }), null);
    assert.equal(workflowV2RunInputs({ run: {} }), null);
    assert.equal(workflowV2RunInputs(null), null);
});

const SCHEMA = { type: "object", properties: { region: { type: "string", examples: ["west"] } }, required: ["region"] };
const publication = inputsSchema => ({ inputsSchema, revision: 1, publishedRevision: 1, state: "published", valid: true });
const render = props => renderToStaticMarkup(React.createElement(StartDialog, {
    controller: {}, sessionId: "wf-2", name: "check-items", number: 3, onClose: () => {}, onStarted: () => {}, ...props }));

test("Start another is filled with the source Workflow's inputs, not the schema's example", () => {
    const html = render({ publication: publication(SCHEMA), onAsk: async () => ({ ok: true }), source: { number: 2, inputs: { region: "east" } } });
    assert.ok(html.includes("Filled with the inputs of #2."), html);
    assert.ok(html.includes('value="east"') && !html.includes('value="west"'), html);
});

test("without the source's inputs, Start another says it cannot read them and uses the same ones; nothing is made up", () => {
    const html = render({ publication: publication(SCHEMA), onAsk: async () => ({ ok: true }), source: { number: 2, inputs: null } });
    assert.ok(html.includes("The same as #2. This screen cannot read them; the chat uses the ones it started it with."), html);
    assert.ok(html.includes('data-action="other-inputs"') && !html.includes("west"), html);
});

test("the first Start keeps its sample values; a schema it cannot draw gets a JSON box, never 'Takes no inputs'", () => {
    const first = render({ publication: publication(SCHEMA), control: { operation: "start", enabled: true } });
    assert.ok(first.includes('value="west"'), "the example fills the first Start (F-5)");
    const open = render({ publication: publication({ type: "object", minProperties: 1, additionalProperties: { type: "string" } }),
        control: { operation: "start", enabled: true } });
    assert.ok(!open.includes("Takes no inputs.") && open.includes("Inputs (JSON)"), open);
    const none = render({ publication: publication({ type: "object", additionalProperties: false }), control: { operation: "start", enabled: true } });
    assert.ok(none.includes("Takes no inputs."));
});
