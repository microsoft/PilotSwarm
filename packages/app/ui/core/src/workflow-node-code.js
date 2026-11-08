/**
 * OF-S2-8 (owner, 2026-11-07T23:12Z): "In the definition viewer, I'd like a script viewer which shows the actual script,
 * the input/output schema in the form of examples (clearly label them as sample inputs/outputs). these should be
 * collapsible items collapsed by default but expandable to show the details."
 *
 * What a node's Script, Sample input and Sample output sections show, from the definition as written (its YAML, read as
 * a value on the page: the graph a read gives has neither scripts nor node schemas). Pure; no parser here: the caller
 * gives the YAML document's value.
 */
import { workflowV2SampleValue } from "./workflow-v2-commands.js";

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** A script's language, by its runtime: workflow v2 scripts run as Node ES modules. */
export const WORKFLOW_SCRIPT_LANGUAGES = Object.freeze({ node: { name: "JavaScript", code: "javascript" } });

/**
 * A node's state as written in the definition's YAML (document: its value): from `states`, or from a parallel state's
 * `body.states`, at any depth. Null when it is not there.
 */
export function workflowDefinitionState(document, nodeId) {
    if (!isRecord(document) || typeof nodeId !== "string" || !nodeId) return null;
    const seen = new Set();
    const find = (states, depth) => {
        if (!isRecord(states) || depth > 8 || seen.has(states)) return null;
        seen.add(states);
        if (isRecord(states[nodeId])) return states[nodeId];
        for (const state of Object.values(states)) {
            const found = isRecord(state) && isRecord(state.body) ? find(state.body.states, depth + 1) : null;
            if (found) return found;
        }
        return null;
    };
    return find(document.states, 0);
}

const REF_MAX_DEPTH = 32;

/**
 * A schema with its references to the definition's own schemas followed ("#/schemas/<name>", "#/$defs/<name>"; the
 * compiler's normalized form): each reference is replaced by the schema it names, merged with the keywords beside it.
 * A reference that loops, or one past 32 levels, becomes {} (any value). Pure.
 */
export function workflowResolvedSchema(schema, schemas) {
    const named = isRecord(schemas) ? schemas : {};
    const walk = (value, path, depth) => {
        if (depth > REF_MAX_DEPTH) return {};
        if (Array.isArray(value)) return value.map(item => walk(item, path, depth + 1));
        if (!isRecord(value)) return value;
        let out = {};
        if (typeof value.$ref === "string") {
            const match = value.$ref.match(/^#\/(?:schemas|\$defs)\/([^/]+)$/);
            const name = match ? decodeURIComponent(match[1]) : null;
            if (name !== null && Object.hasOwn(named, name) && !path.includes(name)) {
                const target = walk(named[name], [...path, name], depth + 1);
                out = isRecord(target) ? { ...target } : target === true ? {} : {};
            } else if (name !== null) {
                out = {};
            }
        }
        for (const [key, item] of Object.entries(value)) {
            if (key === "$ref" && typeof item === "string") continue;
            out[key] = key === "properties" || key === "$defs" || key === "definitions" || key === "patternProperties"
                ? (isRecord(item) ? Object.fromEntries(Object.entries(item).map(([name, sub]) => [name, walk(sub, path, depth + 1)])) : item)
                : walk(item, path, depth + 1);
        }
        return out;
    };
    return walk(schema, [], 0);
}

/** "Script · JavaScript · 24 lines" (the Script section's closed line). */
export function workflowScriptSummary(source, languageName = "JavaScript") {
    const lines = typeof source === "string" && source ? source.replace(/\n$/, "").split("\n").length : 0;
    return ["Script", languageName, lines ? `${lines} ${lines === 1 ? "line" : "lines"}` : null].filter(Boolean).join(" · ");
}

const json = value => JSON.stringify(value, null, 2);

/** One sample section: its words, the sample as JSON (null when none can be made) and the schema as JSON. */
function sampleSection(kind, schema, schemas, from) {
    if (schema === undefined || schema === null || schema === false) return null;
    const resolved = workflowResolvedSchema(schema, schemas);
    const sample = workflowV2SampleValue(resolved);
    return {
        kind,
        label: kind === "input" ? "Sample input" : "Sample output",
        note: `A sample made from ${from}, not real data.`,
        sample: sample ? json(sample.value) : null,
        noSample: sample ? null : "No sample can be made from this schema; it is below.",
        schema: json(schema),
    };
}

/**
 * What a node's code sections show (the Definition view's and a Workflow's Node panel), from the definition's YAML value
 * (`document`): { script, input, output }, each null when the node has none.
 * - script: { text, language (the highlighter's), languageName, summary } for a script node.
 * - input / output: { label ("Sample input", "Sample output"), note (where the sample comes from, and that it is not
 *   real data), sample (JSON, or null with noSample), schema (the schema as written, JSON) }. A node's inputSchema and
 *   outputSchema; a message node's contract (what it sends, its answer, what it receives); an end's own outputSchema,
 *   else the Workflow's for an end that succeeds.
 * `type`: the node's type from the graph, used when the YAML does not say it. Pure.
 */
export function workflowNodeCode(document, nodeId, { type = null } = {}) {
    const state = workflowDefinitionState(document, nodeId);
    if (!state) return { script: null, input: null, output: null };
    const schemas = isRecord(document.schemas) ? document.schemas : {};
    const kind = typeof state.type === "string" ? state.type : type;
    let script = null;
    if (kind === "script" && typeof state.source === "string") {
        const runtime = typeof state.runtime === "string" ? state.runtime : "node";
        const language = WORKFLOW_SCRIPT_LANGUAGES[runtime] ?? { name: runtime, code: null };
        script = { text: state.source.replace(/\n$/, ""), language: language.code, languageName: language.name,
            summary: workflowScriptSummary(state.source, language.name) };
    }
    let input = sampleSection("input", state.inputSchema, schemas, "the node's input schema");
    let output = sampleSection("output", state.outputSchema, schemas, "the node's output schema");
    if (kind === "messaging" && typeof state.contract === "string" && isRecord(document.contracts) && isRecord(document.contracts[state.contract])) {
        const contract = document.contracts[state.contract];
        const name = state.contract;
        if (state.mode === "receive") {
            output ??= sampleSection("output", contract.schema, schemas, `the message schema of ${name}`);
        } else {
            input ??= sampleSection("input", contract.schema, schemas, `the message schema of ${name}`);
            if (state.mode === "request" && isRecord(contract.response)) {
                output ??= sampleSection("output", contract.response.schema, schemas, `the answer schema of ${name}`);
            }
        }
    }
    if (kind === "terminal" && !output && (state.outcome ?? "succeeded") === "succeeded" && document.outputSchema !== undefined) {
        output = sampleSection("output", document.outputSchema, schemas, "the Workflow's output schema");
    }
    return { script, input, output };
}
