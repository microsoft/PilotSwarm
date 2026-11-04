import test from "node:test";
import assert from "node:assert/strict";
import {
    schemaCostRefusal, WORKFLOW_SCHEMA_MAX_EXPANDED_PARTS, WORKFLOW_SCHEMA_UNIQUE_ITEMS_MAX, WorkflowSchemaError, WorkflowSchemaSet,
} from "../../dist/workflow/v2/schema.js";
import { compileWorkflowV2 } from "../../dist/workflow/v2/compiler.js";

// Adversarial review R2-SF-1: a few lines of schemas that name a schema twice, which names one twice, and so on, would
// make one check of a small value do 2^n checks (Ajv runs with allErrors, synchronously, on a shared worker). Such
// schemas are refused when the definition is saved: a schema may stand for at most 10,000 parts with each $ref put in
// its place; a schema may refer back to itself in one place only, which goes into a property or an item; uniqueItems
// on items that are not plain values needs maxItems of at most 100. And uniqueItems never compares more than 100 such
// items, even when maxItems has already failed (allErrors).

const MILESTONE = { enableRequests: true, enableAgents: true };

/** A definition whose inputs schema and script input schema are `inputs`, with `schemas`, and a fixed script input. */
function docWith(schemas, inputs, input = {}) {
    return JSON.stringify({
        apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "costs", version: "1.0.0" },
        inputs: { schema: inputs },
        initial: "calc",
        schemas,
        states: {
            calc: {
                type: "script", source: "await setResult(\"done\", context.input);", inputSchema: inputs, input,
                outcomes: ["done"], transition: { next: { done: "done", failure: "failed" } },
            },
            done: { type: "terminal", outcome: "succeeded" },
            failed: { type: "terminal", outcome: "failed" },
        },
    }, null, 2);
}

/** S0 an object; each S_i is allOf [S_(i-1), S_(i-1)]: 2^n checks of S0 for one value against S_n. */
function doubling(n) {
    const schemas = { S0: { type: "object", properties: { a: { type: "string" } } } };
    for (let i = 1; i <= n; i += 1) schemas[`S${i}`] = { allOf: [{ $ref: `#/schemas/S${i - 1}` }, { $ref: `#/schemas/S${i - 1}` }] };
    return schemas;
}

function schemaErrors(compiled) {
    return compiled.diagnostics.filter(item => item.severity === "error" && item.code === "WORKFLOW_SCHEMA_INVALID");
}

test("a compact doubling of 30 schemas is refused at once when the definition is compiled, with its fixed input never checked", () => {
    const started = performance.now();
    const compiled = compileWorkflowV2(docWith(doubling(30), { $ref: "#/schemas/S30" }, { a: "x" }), MILESTONE);
    const elapsedMs = performance.now() - started;
    assert.equal(compiled.valid, false);
    const [error] = schemaErrors(compiled);
    assert.ok(error, JSON.stringify(compiled.diagnostics));
    // S11 is the first that stands for more than 10,000 parts (S0 for 2: itself and its property; S_i for 5 * 2^i - 3).
    assert.equal(error.path, "$defs.S11");
    assert.ok(error.message.includes("stands for more than 10,000 schema parts"), error.message);
    assert.ok(error.message.includes("Name fewer schemas, or each one fewer times."), error.message);
    // Measured bound: without the rule, checking the fixed input against S30 makes about 2^30 checks of S0.
    assert.ok(elapsedMs < 2_000, `compiled in ${elapsedMs} ms`);
    // A validator is not built for such schemas either (a revision saved before the rule fails plainly).
    const defs = Object.fromEntries(Object.entries(doubling(30)).map(([name, schema]) => [name, JSON.parse(JSON.stringify(schema).replaceAll("#/schemas/", "#/$defs/"))]));
    assert.throws(() => new WorkflowSchemaSet(defs), error => error instanceof WorkflowSchemaError && error.path === "$defs.S11");
});

test("the expanded count: under the limit compiles, over it is refused; a schema named many times counts each time", () => {
    // S10 stands for 5 * 2^10 - 3 = 5,117 parts: allowed; S11 for 10,237: refused.
    const fine = compileWorkflowV2(docWith(doubling(10), { $ref: "#/schemas/S10" }), MILESTONE);
    assert.equal(fine.valid, true, JSON.stringify(fine.diagnostics));
    assert.equal(schemaCostRefusal(Object.fromEntries(Object.entries(doubling(11)).map(([name, schema]) =>
        [name, JSON.parse(JSON.stringify(schema).replaceAll("#/schemas/", "#/$defs/"))])))?.path, "$defs.S11");
    // A wide schema: Big (101 parts) named 100 times in one object (1 + 100 + 100 * 101 parts).
    const big = { type: "object", properties: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`p${index}`, { type: "string" }])) };
    const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`b${index}`, { $ref: "#/$defs/Big" }])) };
    assert.deepEqual(schemaCostRefusal({ Big: big, Wide: wide })?.path, "$defs.Wide");
    assert.equal(schemaCostRefusal({ Big: big, Wide: { ...wide, properties: Object.fromEntries(Object.entries(wide.properties).slice(0, 90)) } }), null);
    assert.equal(WORKFLOW_SCHEMA_MAX_EXPANDED_PARTS, 10_000);
});

test("ordinary nested schemas still compile: shared parts named a few times, lists of objects, a tree of children", () => {
    const schemas = {
        Address: { type: "object", required: ["city"], properties: { street: { type: "string" }, city: { type: "string" } } },
        Person: { type: "object", properties: { name: { type: "string" }, home: { $ref: "#/schemas/Address" }, work: { $ref: "#/schemas/Address" } } },
        Team: { type: "object", properties: { lead: { $ref: "#/schemas/Person" }, members: { type: "array", items: { $ref: "#/schemas/Person" } } } },
        Tree: { type: "object", properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/schemas/Tree" } } } },
        Tags: { type: "array", items: { type: "string" }, uniqueItems: true },
        Pairs: { type: "array", items: { type: "object" }, maxItems: 20, uniqueItems: true },
    };
    const inputs = { type: "object", properties: { team: { $ref: "#/schemas/Team" }, tree: { $ref: "#/schemas/Tree" }, tags: { $ref: "#/schemas/Tags" },
        pairs: { $ref: "#/schemas/Pairs" } } };
    const compiled = compileWorkflowV2(docWith(schemas, inputs, { team: { lead: { name: "a", home: { city: "x" } } }, tags: ["a", "b"] }), MILESTONE);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    // Two schemas that refer to each other once each, going into the value, are a tree too.
    assert.equal(schemaCostRefusal({
        Folder: { type: "object", properties: { files: { type: "array", items: { $ref: "#/$defs/File" } } } },
        File: { type: "object", properties: { attachment: { $ref: "#/$defs/Folder" } } },
    }), null);
});

test("a schema that refers back to itself in two places, or without going into the value, is refused", () => {
    const twice = compileWorkflowV2(docWith({
        Node: { type: "object", properties: { left: { $ref: "#/schemas/Node" }, right: { $ref: "#/schemas/Node" } } },
    }, { $ref: "#/schemas/Node" }), MILESTONE);
    const [error] = schemaErrors(twice);
    assert.ok(error, JSON.stringify(twice.diagnostics));
    assert.equal(error.path, "$defs.Node");
    assert.ok(error.message.includes("schema 'Node' refers back to itself in 2 places; it may do so in one place only"), error.message);
    // Through another schema: the doubling is in the cycle.
    const mutual = schemaCostRefusal({
        A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
        B: { allOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/A" }] },
    });
    assert.equal(mutual?.path, "$defs.B");
    assert.ok(mutual.message.includes("refers back to itself (through 'A') in 2 places"), mutual.message);
    // In place (allOf, anyOf, not, if): a check would never end.
    for (const loop of [{ anyOf: [{ type: "string" }, { $ref: "#/$defs/Loop" }] }, { not: { $ref: "#/$defs/Loop" } }, { if: { $ref: "#/$defs/Loop" } }]) {
        const refused = schemaCostRefusal({ Loop: loop });
        assert.equal(refused?.path, "$defs.Loop", JSON.stringify(loop));
        assert.ok(refused.message.includes("without going into a property or an item of the value, so checking a value against it would never end"));
    }
});

test("uniqueItems on items that are not plain values needs maxItems of at most 100; plain items need none", () => {
    const refused = compileWorkflowV2(docWith({ Rows: { type: "array", items: { type: "object" }, uniqueItems: true } }, { $ref: "#/schemas/Rows" }), MILESTONE);
    const [error] = schemaErrors(refused);
    assert.ok(error, JSON.stringify(refused.diagnostics));
    assert.equal(error.path, "$defs.Rows.uniqueItems");
    assert.ok(error.message.includes(`needs maxItems of at most ${WORKFLOW_SCHEMA_UNIQUE_ITEMS_MAX} beside it`), error.message);
    for (const rows of [
        { type: "array", items: { type: "object" }, maxItems: 101, uniqueItems: true },
        { type: "array", items: { $ref: "#/$defs/Row" }, uniqueItems: true },
        { type: "array", prefixItems: [{ type: "string" }], uniqueItems: true },
        { type: "array", items: { type: ["string", "object"] }, uniqueItems: true },
    ]) assert.equal(schemaCostRefusal({ Row: { type: "object" }, Rows: rows })?.path, "$defs.Rows.uniqueItems", JSON.stringify(rows));
    for (const rows of [
        { type: "array", items: { type: "object" }, maxItems: 100, uniqueItems: true },
        { type: "array", items: { type: ["string", "integer", "null"] }, uniqueItems: true },
        { type: "array", items: { type: "object" }, uniqueItems: false },
    ]) assert.equal(schemaCostRefusal({ Rows: rows }), null, JSON.stringify(rows));
});

test("uniqueItems never compares more than 100 items that are not plain values, even when maxItems already failed", () => {
    const set = new WorkflowSchemaSet({
        Rows: { type: "array", items: { type: "object" }, maxItems: 100, uniqueItems: true },
        Tags: { type: "array", items: { type: "string" }, uniqueItems: true },
        Mixed: { type: "array", maxItems: 10, uniqueItems: true },
    });
    // 60,000 equal objects: Ajv's own check would compare about 1.8 billion pairs.
    const started = performance.now();
    const problems = set.validate("Rows", Array.from({ length: 60_000 }, () => ({})));
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 1_000, `validated in ${elapsedMs} ms`);
    assert.ok(problems.some(problem => problem.message.startsWith("must NOT have more than 100 items")), JSON.stringify(problems));
    assert.ok(problems.some(problem => problem.message.includes(`must NOT have more than ${WORKFLOW_SCHEMA_UNIQUE_ITEMS_MAX} items to be checked for duplicates`)),
        JSON.stringify(problems));
    // Up to 100 are compared by their content, whatever the order of an object's keys.
    assert.deepEqual(set.validate("Rows", [{ a: 1, b: [1, 2] }, { c: null }]), []);
    const duplicate = set.validate("Rows", [{ a: 1, b: [1, 2] }, { c: null }, { b: [1, 2], a: 1 }]);
    assert.equal(duplicate.length, 1);
    assert.ok(duplicate[0].message.startsWith("must NOT have duplicate items (items ## 2 and 0 are identical)"), duplicate[0].message);
    assert.deepEqual(set.validate("Rows", [{ a: 1 }, { a: 1.0, b: 2 }]), []);
    // Plain values: any number of them, each looked up once; equal values of different types are different.
    const tags = Array.from({ length: 100_000 }, (_, index) => `t${index}`);
    const plainStarted = performance.now();
    assert.deepEqual(set.validate("Tags", tags), []);
    assert.ok(performance.now() - plainStarted < 1_000);
    assert.ok(set.validate("Tags", ["a", "b", "a"])[0].message.startsWith("must NOT have duplicate items (items ## 2 and 0 are identical)"));
    assert.deepEqual(set.validate("Mixed", [1, "1", true, "true", null, "null"]), []);
    assert.equal(set.validate("Mixed", [{ x: 1 }, [1], { x: 1 }]).length, 1);
});
