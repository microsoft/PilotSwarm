import test from "node:test";
import assert from "node:assert/strict";
import { workflowV2ResolvedInputsSchema } from "../../dist/workflow/v2/tools.js";
import { compileWorkflowV2 } from "../../dist/workflow/v2/compiler.js";

// Batch 7 (f-05): the read model's graph.inputsSchema is the workflow's input schema with every reference to one of its
// schemas replaced by that schema, so the portal can build sample inputs without resolving references itself.

const ir = (defs, inputsSchema = "inputs") => ({ inputsSchema, schemaDefs: defs });

test("no input schema, or one that is not stored, is null", () => {
    assert.equal(workflowV2ResolvedInputsSchema({ inputsSchema: null, schemaDefs: {} }), null);
    assert.equal(workflowV2ResolvedInputsSchema({ inputsSchema: "inputs" }), null);
    assert.equal(workflowV2ResolvedInputsSchema(ir({ other: { type: "object" } })), null);
});

test("references to schemas are replaced by those schemas, in properties, items and lists", () => {
    const defs = {
        inputs: { $ref: "#/$defs/WatchInputs" },
        WatchInputs: {
            type: "object",
            required: ["build"],
            properties: {
                build: { $ref: "#/$defs/Build" },
                tags: { type: "array", items: { $ref: "#/schemas/Tag" } },
                pair: { type: "array", prefixItems: [{ $ref: "#/$defs/Tag" }, { type: "integer" }] },
                either: { anyOf: [{ $ref: "#/$defs/Build" }, { type: "null" }] },
            },
        },
        Build: { type: "object", properties: { id: { type: "integer", minimum: 1 } } },
        Tag: { type: "string", enum: ["a", "b"] },
    };
    const before = structuredClone(defs);
    const build = { type: "object", properties: { id: { type: "integer", minimum: 1 } } };
    const tag = { type: "string", enum: ["a", "b"] };
    assert.deepEqual(workflowV2ResolvedInputsSchema(ir(defs)), {
        type: "object",
        required: ["build"],
        properties: {
            build,
            tags: { type: "array", items: tag },
            pair: { type: "array", prefixItems: [tag, { type: "integer" }] },
            either: { anyOf: [build, { type: "null" }] },
        },
    });
    assert.deepEqual(defs, before, "the stored schemas are not changed");
});

test("keywords beside a reference are kept, and win over the referenced schema's", () => {
    const defs = {
        inputs: { type: "object", properties: { build: { $ref: "#/$defs/Build", description: "The build to watch.", default: { id: 7 } } } },
        Build: { type: "object", description: "A build.", properties: { id: { type: "integer" } } },
    };
    assert.deepEqual(workflowV2ResolvedInputsSchema(ir(defs)).properties.build, {
        type: "object", description: "The build to watch.", properties: { id: { type: "integer" } }, default: { id: 7 },
    });
});

test("a recursive reference becomes {} (anything); so does one into part of a schema or to no schema", () => {
    const defs = {
        inputs: { $ref: "#/$defs/Node" },
        Node: {
            type: "object",
            properties: {
                name: { type: "string" },
                child: { $ref: "#/$defs/Node" },
                part: { $ref: "#/$defs/Other/properties/x" },
                missing: { $ref: "#/$defs/Missing", description: "kept" },
                remote: { $ref: "https://example.test/schema.json" },
            },
        },
        Other: { type: "object", properties: { x: { type: "string" } } },
    };
    assert.deepEqual(workflowV2ResolvedInputsSchema(ir(defs)), {
        type: "object",
        properties: { name: { type: "string" }, child: {}, part: {}, missing: { description: "kept" }, remote: {} },
    });
    // The root is being resolved too: a reference back to it is recursive.
    assert.deepEqual(workflowV2ResolvedInputsSchema(ir({ inputs: { type: "object", properties: { self: { $ref: "#/$defs/inputs" } } } })),
        { type: "object", properties: { self: {} } });
});

test("a reference to a boolean schema is that schema; with keywords beside it, the keywords", () => {
    const defs = { inputs: { type: "object", properties: { any: { $ref: "#/$defs/Anything" }, noted: { $ref: "#/$defs/Anything", title: "t" } } }, Anything: true };
    assert.deepEqual(workflowV2ResolvedInputsSchema(ir(defs)).properties, { any: true, noted: { title: "t" } });
});

test("a resolved schema larger than 32 KiB is left out (null)", () => {
    const small = { inputs: { type: "object", description: "x".repeat(30 * 1024) } };
    assert.ok(workflowV2ResolvedInputsSchema(ir(small)));
    // Small as stored, large once its references are replaced.
    const big = { type: "object", description: "y".repeat(9 * 1024) };
    const fanOut = { inputs: { type: "object", properties: { a: { $ref: "#/$defs/Big" }, b: { $ref: "#/$defs/Big" }, c: { $ref: "#/$defs/Big" }, d: { $ref: "#/$defs/Big" } } }, Big: big };
    assert.equal(workflowV2ResolvedInputsSchema(ir(fanOut)), null);
});

test("from a compiled workflow's IR", () => {
    const compiled = compileWorkflowV2(`
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: inputs-view, version: "1.0.0" }
inputs:
  schema: { $ref: "#/schemas/WatchInputs" }
initial: pause
schemas:
  WatchInputs:
    type: object
    required: [build]
    properties:
      build: { $ref: "#/schemas/Build" }
  Build:
    type: object
    properties:
      id: { type: integer }
states:
  pause:
    type: wait
    seconds: 1
    transition: { next: { elapsed: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.deepEqual(workflowV2ResolvedInputsSchema(compiled.ir), {
        type: "object", required: ["build"], properties: { build: { type: "object", properties: { id: { type: "integer" } } } },
    });
});

test("SF-4: references that branch (each schema refers twice to the next) stop at a budget, quickly, and show no schema", () => {
    const defs = { inputs: { $ref: "#/$defs/A1" } };
    for (let i = 1; i <= 25; i += 1) {
        defs[`A${i}`] = i === 25 ? { type: "string" }
            : { type: "object", properties: { left: { $ref: `#/$defs/A${i + 1}` }, right: { $ref: `#/$defs/A${i + 1}` } } };
    }
    const started = process.hrtime.bigint();
    assert.equal(workflowV2ResolvedInputsSchema(ir(defs)), null);
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 2_000, "bounded time");
    // A long chain that does not branch still resolves.
    const chain = { inputs: { $ref: "#/$defs/C1" } };
    for (let i = 1; i <= 15; i += 1) chain[`C${i}`] = i === 15 ? { type: "integer" } : { type: "object", properties: { next: { $ref: `#/$defs/C${i + 1}` } } };
    let level = workflowV2ResolvedInputsSchema(ir(chain));
    for (let i = 1; i < 15; i += 1) level = level.properties.next;
    assert.deepEqual(level, { type: "integer" });
});

// Verification of SF-4 (M-04): a branching DAG with one large string leaf stops on its byte budget, as the bytes are
// counted, before the large copy would be serialized.
test("SF-4: a branching DAG over a 128 KiB string stops within the byte budget, before serializing", () => {
    const defs = { inputs: { $ref: "#/$defs/L1" } };
    for (let i = 1; i <= 10; i += 1) {
        defs[`L${i}`] = { type: "object", properties: { left: { $ref: `#/$defs/L${i + 1}` }, right: { $ref: `#/$defs/L${i + 1}` } } };
    }
    defs.L11 = { type: "string", description: "x".repeat(128 * 1024) };
    const stats = { values: 0, bytes: 0 };
    const started = process.hrtime.bigint();
    assert.equal(workflowV2ResolvedInputsSchema(ir(defs), stats), null);
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 1_000, "bounded time");
    // Counting stopped at the first string past the budget: at most the budget plus that one string.
    assert.ok(stats.bytes <= 32 * 1024 + 128 * 1024 + 2, `counted ${stats.bytes} bytes`);
    assert.ok(stats.values < 100, `made ${stats.values} values`);
});

test("SF-4: a schema just under the budget is shown, and its count is its size", () => {
    const stats = { values: 0, bytes: 0 };
    const shown = workflowV2ResolvedInputsSchema(ir({ inputs: { type: "object", description: "d".repeat(20 * 1024) } }), stats);
    assert.ok(shown);
    assert.ok(stats.bytes >= 20 * 1024 && stats.bytes < 32 * 1024);
});
