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
