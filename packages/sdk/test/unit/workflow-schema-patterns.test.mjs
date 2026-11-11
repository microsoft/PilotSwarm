import test from "node:test";
import assert from "node:assert/strict";
import {
    normalizeSchema, patternRefusal, refusedSchemaUseIn, schemaSetFor, WorkflowSchemaError, WorkflowSchemaSet,
} from "../../dist/workflow/schema.js";
import { compileWorkflow } from "../../dist/workflow/compiler.js";

// Owner decision Q1 (d): workflow schemas take no `pattern` and no `patternProperties`, anywhere (workflow inputs and
// output, state input and output, message, request and response contracts, named and inline, nested under any
// subschema keyword). A regular expression can take a very long time on some inputs, and no check of the expression
// rules that out (adversarial review SF-5 and its verifications), so the pattern checker is gone and the keywords are
// refused with WORKFLOW_SCHEMA_INVALID. A revision saved before this rule fails where its validators are built.
const HINT = "Use enum or const for fixed values, minLength and maxLength for a length, or check the text in an agent step.";
const STR = { type: "string" };
const PATTERN = { type: "string", pattern: "^[0-9a-f]{40}$" };

/** A definition with one schema in each place a workflow schema may be: every one of them pattern-free. */
function docWith(over = {}) {
    const schemas = {
        Change: { type: "object", properties: { head: STR } },
        Question: { type: "object", properties: { q: STR } },
        Answer: { type: "object", properties: { approved: { type: "boolean" } } },
        Note: { type: "object", properties: { note: STR } },
        ...(over.schemas ?? {}),
    };
    return JSON.stringify({
        apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "patterns", version: "1.0.0" },
        inputs: { schema: over.inputs ?? { type: "object", properties: { head: STR } } },
        ...(over.output ? { outputSchema: over.output } : {}),
        initial: "calc",
        schemas,
        contracts: {
            "Note@1": { schema: over.message ?? { $ref: "#/schemas/Note" } },
            "Ask@1": { schema: { $ref: "#/schemas/Question" }, response: { schema: over.response ?? { $ref: "#/schemas/Answer" } } },
        },
        states: {
            calc: {
                type: "script", source: "await setResult(\"done\", context.input);",
                inputSchema: over.scriptInput ?? { type: "object" }, input: {},
                outcomes: ["done"], transition: { next: { done: "review", failure: "failed" } },
            },
            review: {
                type: "agent", invoke: { prompt: "Review the change." }, timeoutSeconds: 600,
                outputSchema: over.agentOutput ?? { type: "object", properties: { verdict: STR } },
                transition: { next: { accepted: "tell", failure: "failed" } },
            },
            tell: {
                type: "messaging", mode: "send", contract: "Note@1", recipient: { parent: true }, input: { note: "hi" },
                transition: { next: { sent: "ask", failure: "failed" } },
            },
            ask: {
                type: "messaging", mode: "request", contract: "Ask@1", recipient: { parent: true }, input: { q: "ship?" }, timeoutSeconds: 600,
                transition: { next: { responded: "done", declined: "failed", timed_out: "failed", failure: "failed" } },
            },
            done: { type: "terminal", outcome: "succeeded" },
            failed: { type: "terminal", outcome: "failed" },
        },
    }, null, 2);
}

/** The definition is refused with WORKFLOW_SCHEMA_INVALID at `path`, naming `keyword` and what to use instead. */
/** The definition is refused with WORKFLOW_SCHEMA_INVALID at `path`, its message holding each of `texts`. */
function refusedWith(yaml, path, texts) {
    const compiled = compileWorkflow(yaml);
    assert.equal(compiled.valid, false);
    const hit = compiled.diagnostics.find(item => item.code === "WORKFLOW_SCHEMA_INVALID" && item.path === path);
    assert.ok(hit, `${path}: ${JSON.stringify(compiled.diagnostics)}`);
    assert.equal(hit.severity, "error");
    for (const text of texts) assert.ok(hit.message.includes(text), `${text} in ${hit.message}`);
}
function refusedAt(yaml, path, keyword = "pattern") {
    refusedWith(yaml, path, keyword === "dependencies"
        ? ["'dependencies' is not supported in workflow schemas: use dependentSchemas or dependentRequired (JSON Schema 2020-12)."]
        : [`'${keyword}' is not supported in workflow schemas`, HINT]);
}
/** Refused for a $ref with something after the schema's name (review R1). */
function refusedAtRef(yaml, path, value) {
    refusedWith(yaml, path, [`a $ref names one whole schema: '#/schemas/<Name>', with nothing after the name (got '${value}').`]);
}

test("the pattern-free definition compiles (the control for every case below)", () => {
    const compiled = compileWorkflow(docWith());
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
});

test("each place a workflow schema may be refuses 'pattern'", () => {
    refusedAt(docWith({ inputs: { type: "object", properties: { head: PATTERN } } }), "inputs.schema.properties.head.pattern");
    refusedAt(docWith({ output: { type: "object", properties: { head: PATTERN } } }), "outputSchema.properties.head.pattern");
    refusedAt(docWith({ schemas: { Change: { type: "object", properties: { head: PATTERN } } } }), "schemas.Change.properties.head.pattern");
    refusedAt(docWith({ scriptInput: { type: "object", properties: { head: PATTERN } } }), "states.calc.inputSchema.properties.head.pattern");
    refusedAt(docWith({ agentOutput: { type: "object", properties: { head: PATTERN } } }), "states.review.outputSchema.properties.head.pattern");
    refusedAt(docWith({ message: { type: "object", properties: { note: PATTERN } } }), "contracts.Note@1.schema.properties.note.pattern");
    refusedAt(docWith({ response: { type: "object", properties: { reason: PATTERN } } }), "contracts.Ask@1.response.schema.properties.reason.pattern");
});

test("'patternProperties' is refused as well, and so is either keyword nested under any subschema keyword", () => {
    refusedAt(docWith({ inputs: { type: "object", patternProperties: { "^x-": STR } } }), "inputs.schema.patternProperties", "patternProperties");
    refusedAt(docWith({ schemas: { Change: { type: "object", propertyNames: { pattern: "^[a-z]+$" } } } }), "schemas.Change.propertyNames.pattern");
    refusedAt(docWith({ schemas: { Change: { type: "array", items: { allOf: [STR, { not: PATTERN }] } } } }), "schemas.Change.items.allOf[1].not.pattern");
    refusedAt(docWith({ schemas: { Change: { type: "object", additionalProperties: { anyOf: [{ type: "object", patternProperties: { a: STR } }] } } } }),
        "schemas.Change.additionalProperties.anyOf[0].patternProperties", "patternProperties");
    refusedAt(docWith({ schemas: { Change: { if: STR, then: { prefixItems: [PATTERN] } } } }), "schemas.Change.then.prefixItems[0].pattern");
});

test("a property named 'pattern', and 'pattern' inside data (enum, const, default, examples), are not the keyword", () => {
    const compiled = compileWorkflow(docWith({
        schemas: { Change: { type: "object", properties: { pattern: STR, patternProperties: STR },
            default: { pattern: "x" }, examples: [{ pattern: "y" }] } },
        message: { type: "object", properties: { note: { enum: [{ pattern: "a" }, "hi"] }, tag: { const: { patternProperties: 1 } } } },
    }));
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
});

test("normalizeSchema throws the refusal with its path and code", () => {
    assert.throws(() => normalizeSchema({ type: "object", properties: { id: { type: "string", pattern: "^a$" } } }, "schemas.X"), error => {
        assert.ok(error instanceof WorkflowSchemaError);
        assert.equal(error.code, "WORKFLOW_SCHEMA_INVALID");
        assert.equal(error.path, "schemas.X.properties.id.pattern");
        assert.equal(error.message, `schemas.X.properties.id.pattern: ${patternRefusal("pattern")}`);
        return true;
    });
    assert.equal(patternRefusal("pattern"), `'pattern' is not supported in workflow schemas: a regular expression can take a very long time on some inputs. ${HINT}`);
});

test("a revision saved before the rule fails where its validators are built, without running the expression", () => {
    // Its stored definitions (normalized when it was saved) still hold a pattern, deep inside.
    const defs = {
        Fine: { type: "object", properties: { pattern: STR } },
        Old: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { head: { type: "string", pattern: "^(a+)+$" } } } } } },
    };
    assert.deepEqual(refusedSchemaUseIn(defs.Old, "$defs.Old"),
        { keyword: "pattern", path: "$defs.Old.properties.items.items.properties.head.pattern", message: patternRefusal("pattern") });
    assert.equal(refusedSchemaUseIn(defs.Fine, "$defs.Fine"), null);
    for (const build of [() => new WorkflowSchemaSet(defs), () => schemaSetFor("old-revision-ir", defs)]) {
        assert.throws(build, error => {
            assert.ok(error instanceof WorkflowSchemaError);
            assert.equal(error.code, "WORKFLOW_SCHEMA_INVALID");
            assert.equal(error.path, "$defs.Old.properties.items.items.properties.head.pattern");
            assert.ok(error.message.includes(patternRefusal("pattern")), error.message);
            assert.ok(error.message.includes("This revision was saved before that rule; save and publish a revision without it."), error.message);
            return true;
        });
    }
    // Nothing is cached for it: every later build fails the same way.
    assert.throws(() => schemaSetFor("old-revision-ir", defs), /saved before that rule/);
    // patternProperties at any depth, the same.
    assert.throws(() => new WorkflowSchemaSet({ Map: { type: "object", additionalProperties: { patternProperties: { "^x": STR } } } }),
        /\$defs\.Map\.additionalProperties\.patternProperties: 'patternProperties' is not supported/);
});

// Review R1 of the owner batch: a $ref names one whole schema. A pointer into a schema could reach data (a const, a
// default, an enum or examples member) that holds a pattern; the validator would then run that data as a schema. The
// patterns below are benign: nothing here runs them.
const DATA_HOLDER = { type: "object", const: PATTERN, default: PATTERN, enum: [PATTERN], examples: [PATTERN] };
const POINTERS = ["const", "default", "enum/0", "examples/0"];

test("R1: a $ref with anything after the schema's name is refused, whatever it points to", () => {
    for (const pointer of POINTERS) {
        refusedAtRef(docWith({ schemas: { Holder: DATA_HOLDER, Used: { $ref: `#/schemas/Holder/${pointer}` } },
            inputs: { $ref: "#/schemas/Used" } }), "schemas.Used.$ref", `#/schemas/Holder/${pointer}`);
        // Nested, and in the $defs spelling too.
        refusedAtRef(docWith({ schemas: { Holder: DATA_HOLDER },
            inputs: { type: "object", properties: { head: { allOf: [{ $ref: `#/$defs/Holder/${pointer}` }] } } } }),
        "inputs.schema.properties.head.allOf[0].$ref", `#/$defs/Holder/${pointer}`);
    }
    // The schema field's own shorthand ({ $ref } alone) refuses it the same way.
    refusedAtRef(docWith({ schemas: { Holder: DATA_HOLDER }, inputs: { $ref: "#/schemas/Holder/const" } }), "inputs.schema.$ref", "#/schemas/Holder/const");
    // A pointer to an ordinary subschema is refused as well: only whole named schemas may be referenced.
    refusedAtRef(docWith({ schemas: { Holder: { type: "object", properties: { head: STR } } },
        inputs: { type: "object", properties: { head: { $ref: "#/schemas/Holder/properties/head" } } } }),
    "inputs.schema.properties.head.$ref", "#/schemas/Holder/properties/head");
    assert.throws(() => normalizeSchema({ $ref: "#/schemas/Holder/const" }, "schemas.Used"), error => {
        assert.ok(error instanceof WorkflowSchemaError);
        assert.equal(error.path, "schemas.Used.$ref");
        assert.equal(error.message, "schemas.Used.$ref: a $ref names one whole schema: '#/schemas/<Name>', with nothing after the name "
            + "(got '#/schemas/Holder/const').");
        return true;
    });
});

test("R1: whole named schemas are still referenced, data holding a pattern still compiles, and a property named $ref is data", () => {
    const compiled = compileWorkflow(docWith({
        schemas: { Holder: DATA_HOLDER, Used: { $ref: "#/schemas/Holder" }, Plain: { type: "object", properties: { head: { $ref: "#/schemas/Note" } } } },
        inputs: { type: "object", properties: { used: { $ref: "#/schemas/Used" }, plain: { $ref: "#/$defs/Plain" }, $ref: STR } },
    }));
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
});

test("R1: a revision saved before the rule, with a pointer into data, fails where its validators are built", () => {
    for (const pointer of POINTERS) {
        const defs = { Holder: DATA_HOLDER, Used: { $ref: `#/$defs/Holder/${pointer}` } };
        assert.deepEqual(refusedSchemaUseIn(defs.Used, "$defs.Used"), { keyword: "$ref", path: "$defs.Used.$ref",
            message: `a $ref names one whole schema: '#/schemas/<Name>', with nothing after the name (got '#/$defs/Holder/${pointer}').` });
        for (const build of [() => new WorkflowSchemaSet(defs), () => schemaSetFor(`old-pointer-${pointer}`, defs)]) {
            assert.throws(build, error => {
                assert.ok(error instanceof WorkflowSchemaError);
                assert.equal(error.code, "WORKFLOW_SCHEMA_INVALID");
                assert.equal(error.path, "$defs.Used.$ref");
                assert.ok(error.message.includes("This revision was saved before that rule; save and publish a revision without it."), error.message);
                return true;
            });
        }
    }
    // Whole-schema references in a stored revision still build.
    assert.ok(new WorkflowSchemaSet({ Holder: DATA_HOLDER, Used: { $ref: "#/$defs/Holder" } }));
});

// Review Q2 of the owner batch: Ajv2020 8.20.0 registers the legacy `dependencies` keyword and compiles its schema-valued
// entries as subschemas; it is refused (2020-12 uses dependentSchemas and dependentRequired, which keep working).
test("Q2: 'dependencies' is refused, a nested pattern in it included; dependentSchemas and dependentRequired work", () => {
    refusedAt(docWith({ schemas: { Change: { type: "object", dependencies: { head: { properties: { note: PATTERN } } } } } }),
        "schemas.Change.dependencies", "dependencies");
    const compiled = compileWorkflow(docWith({ schemas: { Change: { type: "object",
        dependentSchemas: { head: { properties: { note: STR } } }, dependentRequired: { head: ["note"] } } } }));
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.throws(() => new WorkflowSchemaSet({ Old: { type: "object", dependencies: { head: { properties: { note: PATTERN } } } } }),
        /\$defs\.Old\.dependencies: 'dependencies' is not supported in workflow schemas: use dependentSchemas or dependentRequired/);
    assert.throws(() => new WorkflowSchemaSet({ Old: { type: "object", dependentSchemas: { head: { properties: { note: PATTERN } } } } }),
        /\$defs\.Old\.dependentSchemas\.head\.properties\.note\.pattern/);
});
