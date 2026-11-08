/**
 * OF-S2-8 (owner, 2026-11-07), part B: the script viewer, samples and syntax highlighting.
 * - 23:12Z: "In the definition viewer, I'd like a script viewer which shows the actual script, the input/output schema in
 *   the form of examples (clearly label them as sample inputs/outputs). these should be collapsible items collapsed by
 *   default but expandable to show the details."
 * - 23:13Z: "proper syntax highlighting pls for YAML, json objects as well as the scripts."
 * The graph a read gives has neither scripts nor node schemas; the page reads them from the definition's YAML (for those
 * who may read it), with the YAML grammar the portal already bundles. The mounted cases are the browser specs "OF-S2-8".
 *
 * Run: node --test ui/core/test/workflow-simplified-of-s2-8-code.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { workflowDefinitionState, workflowNodeCode, workflowResolvedSchema, workflowScriptSummary } from "../src/workflow-node-code.js";
import { workflowV2SampleInputs, workflowV2SampleValue } from "../src/workflow-v2-commands.js";
import { codeRuns, loadCodeHighlighting, yamlDocumentValue } from "../../react/src/workflow-code-lang.js";
import { CodeBlock, NodeCodeSections, loadCodeModule } from "../../react/src/workflow-code.js";
import { WorkflowV2YamlBox } from "../../react/src/workflow-v2-panels.js";

const YAML = `apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: health-loop, version: "0.2.0" }
schemas:
  Check:
    type: object
    required: [url, tries]
    properties:
      url: { type: string, format: uri }
      tries: { type: integer, minimum: 2, maximum: 5 }
      mode: { enum: [fast, slow] }
  Verdict:
    type: object
    properties:
      ok: { type: boolean }
      note: { type: string, default: "all good" }
      next: { $ref: "#/schemas/Check" }
contracts:
  Ask@1:
    schema: { $ref: "#/schemas/Check" }
    response: { schema: { type: object, properties: { answer: { const: yes } } } }
outputSchema: { $ref: "#/schemas/Verdict" }
initial: generate
states:
  generate:
    type: script
    timeoutSeconds: 30
    inputSchema: { $ref: "#/schemas/Check" }
    outputSchema: { $ref: "#/schemas/Verdict" }
    outcomes: [done]
    source: |
      // check the site
      const res = await fetch(context.input.url);
      await setResult("done", { ok: res.ok, count: 3 });
    transition:
      next: { done: fan }
  fan:
    type: parallel
    forEach: "\${input}"
    body:
      initial: inner
      states:
        inner:
          type: script
          outcomes: [ok]
          source: "await setResult('ok', {})"
          transition: { next: { ok: end } }
        end: { type: terminal, outcome: succeeded, output: "\${input}" }
    transition: { next: { joined: ask, blocked: done } }
  ask:
    type: messaging
    mode: request
    contract: Ask@1
    recipient: { parent: true }
    timeoutSeconds: 60
    transition: { next: { responded: done, declined: done } }
  done:
    type: terminal
    outcome: succeeded
    output: "\${input}"
`;

test("the YAML is read as the definition's value: states, nested body states, schemas", () => {
    const { ok, value } = yamlDocumentValue(YAML);
    assert.equal(ok, true);
    assert.equal(value.states.generate.source, "// check the site\nconst res = await fetch(context.input.url);\nawait setResult(\"done\", { ok: res.ok, count: 3 });\n");
    assert.deepEqual(value.schemas.Check.required, ["url", "tries"]);
    assert.equal(value.states.generate.timeoutSeconds, 30);
    assert.equal(workflowDefinitionState(value, "inner").source, "await setResult('ok', {})", "a parallel's body state");
    assert.equal(workflowDefinitionState(value, "missing"), null);
    assert.equal(workflowDefinitionState(null, "generate"), null);
    // Scalars as YAML reads them.
    assert.deepEqual(yamlDocumentValue("a: 'it''s'\nb: \"x\\ty\"\nc: >-\n  one\n  two\n\n  three\nd: [1, 2.5, true, null, ~, -3]\ne: &x {k: v}\nf: *x\n").value,
        { a: "it's", b: "x\ty", c: "one two\nthree", d: [1, 2.5, true, null, null, -3], e: { k: "v" }, f: { k: "v" } });
    assert.equal(yamlDocumentValue("a: [1,\n").ok, false, "a syntax error says so");
});

test("references to the definition's schemas are followed; a loop reads as any value", () => {
    const { value } = yamlDocumentValue(YAML);
    const resolved = workflowResolvedSchema({ $ref: "#/schemas/Verdict" }, value.schemas);
    assert.equal(resolved.properties.next.properties.tries.minimum, 2);
    const loop = workflowResolvedSchema({ $ref: "#/schemas/A" }, { A: { type: "object", properties: { self: { $ref: "#/schemas/A" } } } });
    assert.deepEqual(loop, { type: "object", properties: { self: {} } });
    assert.deepEqual(workflowResolvedSchema({ $ref: "#/schemas/Nope", description: "d" }, {}), { description: "d" });
    assert.deepEqual(workflowResolvedSchema({ $ref: "#/$defs/A" }, { A: { type: "string" } }), { type: "string" });
});

test("samples come from the schema, the same every time: example, default, const, first enum value, then by type", () => {
    assert.deepEqual(workflowV2SampleValue({ type: "string", example: "from example" }), { value: "from example" });
    assert.deepEqual(workflowV2SampleValue({ type: "string", examples: ["first"], default: "d" }), { value: "first" });
    assert.deepEqual(workflowV2SampleValue({ type: "integer", default: 7 }), { value: 7 });
    assert.deepEqual(workflowV2SampleValue({ const: "yes" }), { value: "yes" });
    assert.deepEqual(workflowV2SampleValue({ enum: ["fast", "slow"] }), { value: "fast" });
    assert.deepEqual(workflowV2SampleValue({ type: "integer", minimum: 2, maximum: 5 }), { value: 2 });
    assert.deepEqual(workflowV2SampleValue({ type: "number", maximum: -3 }), { value: -3 });
    assert.deepEqual(workflowV2SampleValue({ type: "array", items: { type: "boolean" }, minItems: 2 }), { value: [false, false] });
    assert.deepEqual(workflowV2SampleValue({ type: "null" }), { value: null });
    assert.deepEqual(workflowV2SampleValue(true), { value: {} });
    assert.equal(workflowV2SampleValue({ type: "string", minLength: 2 ** 40 }), null, "over the budget: no sample");
    assert.equal(workflowV2SampleValue(null), null);
    assert.deepEqual(workflowV2SampleInputs({ type: "object", properties: { a: { type: "string", example: "x" } } }), { a: "x" }, "the Start form's sample reads `example` too");
});

test("a node's code: the script, its language and lines; sample input and output from its schemas, labelled as samples", () => {
    const { value } = yamlDocumentValue(YAML);
    const code = workflowNodeCode(value, "generate", { type: "script" });
    assert.deepEqual(code.script, { text: "// check the site\nconst res = await fetch(context.input.url);\nawait setResult(\"done\", { ok: res.ok, count: 3 });",
        language: "javascript", languageName: "JavaScript", summary: "Script · JavaScript · 3 lines" });
    assert.equal(code.input.label, "Sample input");
    assert.equal(code.input.note, "A sample made from the node's input schema, not real data.");
    assert.deepEqual(JSON.parse(code.input.sample), { url: "https://example.com/url", tries: 2, mode: "fast" });
    assert.equal(code.output.label, "Sample output");
    assert.deepEqual(JSON.parse(code.output.sample), { ok: false, note: "all good", next: { url: "https://example.com/url", tries: 2, mode: "fast" } });
    assert.deepEqual(JSON.parse(code.input.schema), { $ref: "#/schemas/Check" }, "the schema as written");
    // The same document gives the same samples.
    assert.deepEqual(workflowNodeCode(value, "generate"), code);
    // A request: what it sends and its answer, from its contract; an end that succeeds: the Workflow's output schema.
    const ask = workflowNodeCode(value, "ask");
    assert.equal(ask.script, null);
    assert.equal(ask.input.note, "A sample made from the message schema of Ask@1, not real data.");
    assert.deepEqual(JSON.parse(ask.output.sample), { answer: "yes" });
    assert.equal(workflowNodeCode(value, "done").output.note, "A sample made from the Workflow's output schema, not real data.");
    // A body script without schemas: its script only.
    assert.deepEqual(workflowNodeCode(value, "inner"), { script: { text: "await setResult('ok', {})", language: "javascript", languageName: "JavaScript",
        summary: "Script · JavaScript · 1 line" }, input: null, output: null });
    assert.deepEqual(workflowNodeCode(value, "nowhere"), { script: null, input: null, output: null });
    assert.equal(workflowScriptSummary(""), "Script · JavaScript");
});

test("before the parsers load a code box is the plain text in place; the YAML box is the plain textarea", () => {
    const plain = renderToStaticMarkup(React.createElement(CodeBlock, { text: "{\"a\": 1}", language: "json" }));
    assert.equal(plain, '<pre class="ps-wf-code" data-language="json"><code>{&quot;a&quot;: 1}</code></pre>');
    const box = renderToStaticMarkup(React.createElement(WorkflowV2YamlBox, { value: "a: 1\n", readOnly: true, marks: { lines: [], unplaced: 0 }, changed: false }));
    assert.ok(!box.includes("ps-workflow-yaml-paint"));
    assert.match(box, /<div class="ps-workflow-yaml-text"><textarea[^>]*aria-label="Workflow YAML"/);
    assert.ok(!box.includes("is-painted"));
});

test("highlighting: YAML keys, values and comments, a script's source as JavaScript, JSON and scripts, in the theme's code colours", async () => {
    await loadCodeModule();
    for (const language of ["yaml", "json", "javascript"]) await loadCodeHighlighting(language);
    const text = "a: 1 # c\nb: word\nsource: |\n  const x = await f('s');\n";
    const runs = codeRuns(text, "yaml").map(run => [text.slice(run.from, run.to), run.className]);
    assert.deepEqual(runs.slice(0, 6), [["a", "ps-code-property"], ["1", "ps-code-number"], ["# c", "ps-code-comment"], ["b", "ps-code-property"],
        ["word", "ps-code-string"], ["source", "ps-code-property"]]);
    assert.ok(runs.some(([words, name]) => words === "const" && name === "ps-code-keyword"), "the script inside the YAML is JavaScript");
    assert.ok(runs.some(([words, name]) => words === "'s'" && name === "ps-code-string"));
    const json = '{"a": [1, true, "s"]}';
    assert.deepEqual(codeRuns(json, "json").map(run => [json.slice(run.from, run.to), run.className]).filter(([, name]) => name !== "ps-code-punctuation"),
        [["\"a\"", "ps-code-property"], ["1", "ps-code-number"], ["true", "ps-code-number"], ["\"s\"", "ps-code-string"]]);
    // Rendered: spans with the classes; the YAML box paints a highlighted copy under its (now transparent) text.
    const block = renderToStaticMarkup(React.createElement(CodeBlock, { text: json, language: "json" }));
    assert.match(block, /^<pre class="ps-wf-code" data-language="json" data-highlighted="true"><code>{<span class="ps-code-property">&quot;a&quot;<\/span>/);
    const auto = renderToStaticMarkup(React.createElement(CodeBlock, { text: "plain words", language: "auto" }));
    assert.equal(auto, '<pre class="ps-wf-code"><code>plain words</code></pre>', "auto: only a text that reads as JSON");
    const box = renderToStaticMarkup(React.createElement(WorkflowV2YamlBox, { value: "a: 1\n", readOnly: true, marks: { lines: [], unplaced: 0 }, changed: false }));
    assert.match(box, /<pre class="ps-workflow-yaml-paint" aria-hidden="true"><code><span class="ps-code-property">a<\/span>: <span class="ps-code-number">1<\/span>\n<\/code>\n<\/pre><textarea[^>]*class="is-painted"/);
    // Every class has its theme colour.
    const css = fs.readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8");
    for (const role of ["keyword", "string", "number", "function", "type", "property", "variable", "comment", "invalid"]) {
        assert.match(css, new RegExp(`\\.ps-code-${role} \\{ color: var\\(--ps-code-${role}, inherit\\);`), role);
    }
    assert.match(css, /\.ps-workflow-yaml textarea\.is-painted \{ position: relative; z-index: 1; color: transparent;/);
});

test("the Node panel's sections: Script, Sample input and Sample output, each closed; a sample says it is one; its schema below", async () => {
    await loadCodeModule();
    for (const language of ["yaml", "json", "javascript"]) await loadCodeHighlighting(language);
    const html = renderToStaticMarkup(React.createElement(NodeCodeSections, { node: { id: "generate", type: "script" }, yaml: YAML }));
    const sections = [...html.matchAll(/<details class="ps-wf-more[^"]*" data-section="([^"]+)"(?: open="")?><summary[^>]*>([^<]*)<\/summary>/g)].map(match => [match[1], match[2]]);
    assert.deepEqual(sections, [["script", "Script · JavaScript · 3 lines"], ["sample-input", "Sample input"], ["sample-input-schema", "Schema"],
        ["sample-output", "Sample output"], ["sample-output-schema", "Schema"]]);
    assert.ok(!/<details[^>]* open=""/.test(html), "every section closed");
    assert.match(html, /data-field="script-text"/);
    assert.match(html, /<span class="ps-code-comment">\/\/ check the site<\/span>/, "the script, highlighted");
    assert.match(html, /<p class="ps-wf-muted ps-wf-sample-note">A sample made from the node&#x27;s input schema, not real data\.<\/p>/);
    // A script node whose YAML may not be read says so; another node without YAML shows nothing.
    const hidden = renderToStaticMarkup(React.createElement(NodeCodeSections, { node: { id: "generate", type: "script" }, yaml: null,
        hidden: "Only this chat's owner or an admin can read the script." }));
    assert.match(hidden, /data-section="script"><summary>Script · JavaScript<\/summary><div class="ps-wf-more-body"><p class="ps-wf-muted">Only this chat&#x27;s owner/);
    assert.equal(renderToStaticMarkup(React.createElement(NodeCodeSections, { node: { id: "pause", type: "wait" }, yaml: null })), "");
    const reading = renderToStaticMarkup(React.createElement(NodeCodeSections, { node: { id: "generate", type: "script" }, pending: true }));
    assert.match(reading, /Reading the script…/);
});

test("the panels use them: the Definition view's Node panel, a Workflow's Node panel, and the JSON boxes", () => {
    const tab = fs.readFileSync(new URL("../../react/src/workflow-tab.js", import.meta.url), "utf8");
    const chat = fs.readFileSync(new URL("../../react/src/workflow-chat-tab.js", import.meta.url), "utf8");
    const panels = fs.readFileSync(new URL("../../react/src/workflow-v2-panels.js", import.meta.url), "utf8");
    assert.match(tab, /h\(NodeCodeSections, \{ node, yaml, pending, hidden \}\)/);
    assert.match(tab, /sections: h\(NodeCodeSections, \{ node: selected, yaml: code\.yaml, pending: code\.pending, hidden: code\.hidden \}\)/);
    assert.match(chat, /h\(NodeFacts, \{ node: selected, yaml: read\?\.phase === "ready" \? access\.yaml : null/);
    for (const needle of ['h(CodeBlock, { text, language: "auto" })', 'h(CodeBlock, { text: whole.text, language: "auto", "data-whole-value": whole.kind })',
        'h(CodeBlock, { text: result.text, language: "auto" })', "h(CodeText, { text: entry.displayText })"]) {
        assert.ok(panels.includes(needle), needle);
    }
});
