// A workflow schema problem in plain words (schema-words.ts, used by WorkflowSchemaSet.validate): the words a refused
// Start shows in the Start dialog and returns to the session (WORKFLOW_INPUT_INVALID's details), and a node's input or output
// problems. No JSON of Ajv's params, no const or enum value; the place by name.
//
// Run: node --test packages/sdk/test/unit/workflow-schema-words.test.mjs (after the SDK build)
import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowSchemaSet } from "../../dist/workflow/schema.js";
import { schemaPlaceWords, schemaPointerParts, schemaProblemWords } from "../../dist/workflow/schema-words.js";

const SECRET = "s3cr3t-literal";
const INPUTS = {
    type: "object", required: ["model", "sessions"], additionalProperties: false,
    properties: {
        model: { type: "string" },
        sessions: { type: "array", minItems: 6, maxItems: 8, uniqueItems: true, items: { type: "string" } },
        topic: { type: "string", minLength: 3, maxLength: 10 },
        mode: { enum: ["fast", SECRET] },
        exact: { const: SECRET },
        count: { type: "number", minimum: 1, maximum: 5 },
        ratio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.25 },
        n: { type: ["integer", "null"] },
        home: { type: "object", required: ["city"], properties: { city: { type: "string" } } },
        people: { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
    },
};
const set = new WorkflowSchemaSet({ Inputs: INPUTS, Small: { type: "array", maxItems: 1 } });
const messages = value => set.validate("Inputs", value).map(problem => `${problem.path} | ${problem.message}`);

test("each kind of problem reads as plain words naming its place; the path stays the JSON pointer", () => {
    const sessions = ["a", "b", "a"];
    assert.deepEqual(messages({ sessions, topic: "ab", mode: "slow", exact: "x", count: "three", n: 1.5, extra: 1, home: {},
        people: [{}, { name: 3 }] }), [
        "/ | model is required",
        "/ | extra is not a known field",
        "/sessions | sessions needs at least 6 items",
        "/sessions | items 1 and 3 of sessions are the same",
        "/topic | topic needs at least 3 characters",
        "/mode | mode must be one of the allowed values",
        "/exact | exact must be the allowed value",
        "/count | count must be a number",
        "/n | n must be a whole number or null",
        "/home | home.city is required",
        "/people/0 | name in item 1 of people is required",
        "/people/1/name | name in item 2 of people must be text",
    ]);
    assert.deepEqual(messages({ model: "m", sessions: ["1", "2", "3", "4", "5", "6", "7", "8", "9"], topic: "x".repeat(11), count: 9, ratio: 1 }), [
        "/sessions | sessions can have at most 8 items",
        "/topic | topic can have at most 10 characters",
        "/count | count must be at most 5",
        "/ratio | ratio must be less than 1",
    ]);
    assert.deepEqual(messages({ model: "m", sessions: ["1", "2", "3", "4", "5", "6"], count: 0, ratio: 0.3 }), [
        "/count | count must be at least 1",
        "/ratio | ratio must be a multiple of 0.25",
    ]);
    assert.deepEqual(messages({ model: "m", sessions: ["1", "2", "3", "4", "5", "6"], ratio: 0 }), ["/ratio | ratio must be more than 0"]);
    assert.deepEqual(set.validate("Inputs", []).map(problem => problem.message), ["The value must be an object"]);
    assert.deepEqual(set.validate("Small", [1, 2]).map(problem => problem.message), ["The value can have at most 1 item"]);
});

test("no message carries JSON, Ajv's parameter names, or a value the schema's author wrote for a const or an enum", () => {
    const problems = set.validate("Inputs", { sessions: [1, 1], mode: "x", exact: "y", extra: true });
    assert.ok(problems.length >= 5, JSON.stringify(problems));
    for (const problem of problems) {
        assert.doesNotMatch(problem.message, /[{}"]|missingProperty|limit|allowedValue|additionalProperty|must NOT|must be equal/, problem.message);
        assert.ok(!problem.message.includes(SECRET), problem.message);
        assert.doesNotMatch(problem.message, /\.$/, "a clause: callers join several and end the sentence");
    }
});

test("a value checked where it sits in a larger one names its places from there (`at`); its paths stay its own", () => {
    const home = new WorkflowSchemaSet({ Home: { type: "object", required: ["city"], properties: { zip: { type: "string", minLength: 5 } } } });
    assert.deepEqual(home.validate("Home", { zip: "1" }, "/home"), [
        { path: "/", message: "home.city is required" },
        { path: "/zip", message: "home.zip needs at least 5 characters" },
    ]);
    assert.deepEqual(new WorkflowSchemaSet({ N: { type: "integer" } }).validate("N", "x", "/tags/2"), [{ path: "/", message: "item 3 of tags must be a whole number" }]);
});

test("pattern, format and keywords without their own words: generic words, never the pattern, else Ajv's message", () => {
    assert.equal(schemaProblemWords({ keyword: "pattern", instancePath: "/code", params: { pattern: `^${SECRET}$` }, message: `must match pattern "^${SECRET}$"` }),
        "code does not have the expected form");
    assert.equal(schemaProblemWords({ keyword: "format", instancePath: "/owner", params: { format: "email" }, message: 'must match format "email"' }),
        "owner is not in the expected format");
    assert.equal(schemaProblemWords({ keyword: "if", instancePath: "/x", params: { failingKeyword: "then" }, message: 'must match "then" schema' }),
        'x must match "then" schema');
    assert.equal(schemaProblemWords({ keyword: "somethingNew", instancePath: "", params: { limit: 3 } }), "The value is invalid");
    assert.equal(schemaProblemWords({ keyword: "uniqueItems", instancePath: "/tags", params: { limit: 100 } }),
        "tags has more than 100 items, too many to check for duplicates");
    assert.equal(schemaProblemWords({ keyword: "minItems", instancePath: "/tags", params: { limit: 1 } }), "tags needs at least 1 item");
    assert.equal(schemaProblemWords({ keyword: "anyOf", instancePath: "/a", params: {} }), "a does not match any of the allowed shapes");
    assert.equal(schemaProblemWords({ keyword: "false schema", instancePath: "/f", params: {} }), "f is not allowed");
    assert.equal(schemaProblemWords({ keyword: "dependentRequired", instancePath: "", params: { property: "x", missingProperty: "y" } }),
        "y is required when x is given");
});

test("places: dots for fields, 1-based items, JSON pointer escapes undone", () => {
    assert.deepEqual(schemaPointerParts("/a~1b/c~0d/0"), ["a/b", "c~d", "0"]);
    assert.deepEqual(schemaPointerParts("/"), []);
    assert.equal(schemaPlaceWords([]), "the value");
    assert.equal(schemaPlaceWords(["a", "b"]), "a.b");
    assert.equal(schemaPlaceWords(["0"]), "item 1");
    assert.equal(schemaPlaceWords(["list", "4", "name"]), "name in item 5 of list");
});
