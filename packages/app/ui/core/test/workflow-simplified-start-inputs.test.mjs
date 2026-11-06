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
import { workflowV2DrawableInput, workflowV2InputsShape, workflowV2RunInputs, workflowV2StartAnotherShape } from "../src/workflow-v2-commands.js";
import { workflowStartAnotherText } from "../src/workflow-owner.js";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import { StartDialog } from "../../react/src/workflow-tab.js";

test("the form's shape: none only when no input can be asked for; a JSON box for what it cannot draw", () => {
    assert.equal(workflowV2InputsShape(null), "none");
    // Review UI-D8: an open object takes any inputs (a JSON box); only a closed empty contract takes none.
    assert.equal(workflowV2InputsShape({ type: "object" }), "json");
    assert.equal(workflowV2InputsShape({ type: "object", additionalProperties: true }), "json");
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

// Review UI-D8: Start another keeps the inputs its Workflow ran with for an open object schema, additionalProperties: true
// and no schema at all (a JSON box filled with them); "Takes no inputs" only for a closed empty contract.
test("UI-D8: Start another keeps known inputs for an open, additionalProperties or absent schema; the request never says it takes none", async () => {
    const original = { region: "east", limit: 3 };
    for (const schema of [{ type: "object" }, { type: "object", additionalProperties: true }, null]) {
        const label = JSON.stringify(schema);
        assert.equal(workflowV2StartAnotherShape(schema, original), "json", label);
        const html = render({ publication: publication(schema), onAsk: async () => ({ ok: true }), source: { number: 2, inputs: original } });
        assert.ok(!html.includes("Takes no inputs.") && html.includes("Inputs (JSON)") && html.includes("Filled with the inputs of #2."), html);
        // The JSON box holds the original object exactly: what Ask sends.
        const box = /<textarea[^>]*>([^<]*)<\/textarea>/.exec(html);
        assert.deepEqual(JSON.parse(box[1].replaceAll("&quot;", "\"")), original, label);
    }
    // No schema and no known inputs, or a closed empty contract: takes none.
    assert.equal(workflowV2StartAnotherShape(null, null), "none");
    assert.equal(workflowV2StartAnotherShape(null, {}), "none");
    assert.equal(workflowV2StartAnotherShape({ type: "object", additionalProperties: false }, original), "none");
    // The message: the inputs as given, "It takes no inputs." only for a contract that takes none.
    assert.match(workflowStartAnotherText({ name: "check-items", inputs: original }), /\nInputs \(data, JSON\): \{"region":"east","limit":3\}$/);
    assert.match(workflowStartAnotherText({ name: "check-items", inputs: {} }), /\nInputs \(data, JSON\): \{\}$/);
    assert.match(workflowStartAnotherText({ name: "check-items", inputs: {}, noInputs: true }), /\nIt takes no inputs\.$/);
    // Through the controller: the chat is asked with the original object.
    const sent = [];
    const transport = { sendMessage: async (sessionId, prompt, options) => { sent.push({ sessionId, prompt, options }); return { ok: true }; } };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "owner", title: "Owner", status: "idle" },
        { sessionId: "wf-2", sessionKind: "workflow", title: "Workflow: check-items", status: "completed", parentSessionId: "owner" },
    ] });
    controller.askWorkflowParent = async (sessionId, text) => { sent.push({ sessionId, prompt: text }); return { ok: true }; };
    await controller.startAnotherWorkflow("wf-2", { inputs: original, noInputs: false });
    assert.match(sent.at(-1).prompt, /\nInputs \(data, JSON\): \{"region":"east","limit":3\}$/);
    assert.doesNotMatch(sent.at(-1).prompt, /takes no inputs/);
});
