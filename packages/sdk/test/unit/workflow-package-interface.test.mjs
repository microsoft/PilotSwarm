/**
 * A package agent's workflow interface (workflow/package-interface.ts;
 * design 04 "Package-agent I/O export", 03 package agents, 09
 * `interface: name@version`; R09, T011, T071, mock M17), DB-less. INACTIVE:
 * only a host that runs the Workflow controller compiles agent states and checks an
 * interface at publication.
 *
 * - An agent file declares it in its front matter (schemaVersion 5): the
 *   loader parses the nested mapping, a malformed one fails the agent's
 *   parse, and an older schemaVersion is refused instead of dropping it.
 * - The package exports it: the schema files are read from inside the
 *   package only (no traversal, absolute path, URL, backslash, link or
 *   directory), are JSON workflow schemas that stand alone and compile, and
 *   the export carries a digest of its name, version, schemas and outcomes.
 * - A stored export is read back only when it is well formed and its digest
 *   matches.
 * - A workflow names it on an agent state (it needs the package and an
 *   outputSchema); the IR keeps it, and the stored IR reads it back.
 * - Publication's check: the state's outcomes and schemas must be exactly the
 *   interface's; nothing is inferred and no narrowing is assumed safe.
 *
 * Run: node --test test/unit/workflow-package-interface.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    exportWorkflowInterface, readWorkflowInterfaceExport, WORKFLOW_INTERFACE_SCHEMA_MAX_BYTES, workflowInterfaceDigest, workflowInterfaceMismatches,
} from "../../dist/workflow/package-interface.js";
import { compileWorkflow, parseWorkflowInterfaceRef, parseWorkflowIr, WORKFLOW_MILESTONE_IR_VERSION } from "../../dist/workflow/compiler.js";
import { describeWorkflowState } from "../../dist/workflow/runtime.js";
import { canonicalJson } from "../../dist/workflow/json.js";
import { agentFrontmatterProblem, loadAgentFiles, validateAgentDefinition } from "../../dist/agent-loader.js";

const MILESTONE = { enableRequests: true, enableAgents: true };
const INPUT = { type: "object", required: ["head"], properties: { head: { type: "string" } }, additionalProperties: false };
const RESULT = { type: "object", required: ["verdict"], properties: { verdict: { type: "string" }, notes: { type: "string" } }, additionalProperties: false };
const OUTCOMES = ["accepted", "changes_required"];
const DECLARED = {
    name: "review_change", version: "1", inputSchema: "./contracts/review-input.schema.json",
    outputSchema: "./contracts/review-result.schema.json", outcomes: OUTCOMES,
};
const WANTED = { name: "review_change", version: "1" };

/** A package directory with the two contract files (`files` adds or replaces files; null removes one), removed after the test. */
function packageDir(t, files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-interface-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const all = { "contracts/review-input.schema.json": JSON.stringify(INPUT), "contracts/review-result.schema.json": JSON.stringify(RESULT), ...files };
    for (const [relative, text] of Object.entries(all)) {
        if (text === null) continue;
        fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
        fs.writeFileSync(path.join(dir, relative), text);
    }
    return dir;
}

/** One agent state that names `invoke` (YAML), with the schemas the interface exports unless `schemas` replaces them. */
const AGENT_YAML = ({ invoke = "{ agent: { name: code-reviewer, package: review-kit, version: \"1.2.0\", interface: review_change@1 } }",
    output = "    outputSchema: { $ref: \"#/schemas/ReviewResult\" }\n", result = JSON.stringify(RESULT) } = {}) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: reviewer, version: "1.0.0" }
initialInput: { head: "abc" }
initial: review
schemas:
  ReviewInput: ${JSON.stringify(INPUT)}
  ReviewResult: ${result}
states:
  review:
    type: agent
    invoke: ${invoke}
    inputSchema: { $ref: "#/schemas/ReviewInput" }
${output}    timeoutSeconds: 3600
    transition: { next: { accepted: done, changes_required: rework, needs_input: rework, timed_out: rework, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  rework: { type: terminal, outcome: blocked }
  failed: { type: terminal, outcome: failed }
`;

const errorsOf = result => result.diagnostics.filter(item => item.severity === "error").map(item => [item.code, item.path]);

test("an interface is named name@version", () => {
    assert.deepEqual(parseWorkflowInterfaceRef("review_change@1"), WANTED);
    assert.deepEqual(parseWorkflowInterfaceRef("integration.review-v2@1.2"), { name: "integration.review-v2", version: "1.2" });
    for (const bad of ["review_change", "@1", "review_change@", "1review@1", "a@b@1", "review change@1", "review_change@-1", 7, null, undefined]) {
        assert.equal(parseWorkflowInterfaceRef(bad), null, String(bad));
    }
});

test("a package exports the interface an agent declares: its schema files read from inside the package, checked and digested", t => {
    const dir = packageDir(t);
    const { exported, issues } = exportWorkflowInterface(dir, DECLARED);
    assert.deepEqual(issues, []);
    assert.deepEqual({ ...exported, digest: null }, { name: "review_change", version: "1", inputSchema: INPUT, outputSchema: RESULT, outcomes: OUTCOMES, digest: null });
    assert.match(exported.digest, /^[0-9a-f]{64}$/);
    assert.equal(exported.digest, workflowInterfaceDigest({ name: "review_change", version: "1", inputSchema: INPUT, outputSchema: RESULT, outcomes: OUTCOMES }));
    // The digest is of the canonical JSON: the files' key order does not change it.
    const reordered = packageDir(t, { "contracts/review-result.schema.json": JSON.stringify({ additionalProperties: false,
        properties: { notes: { type: "string" }, verdict: { type: "string" } }, required: ["verdict"], type: "object" }) });
    assert.equal(exportWorkflowInterface(reordered, DECLARED).exported.digest, exported.digest);
    // The input schema is optional; without it the export says so, and its digest differs.
    const { inputSchema: _input, ...outputOnly } = DECLARED;
    const without = exportWorkflowInterface(dir, outputOnly);
    assert.deepEqual(without.issues, []);
    assert.equal(without.exported.inputSchema, null);
    assert.notEqual(without.exported.digest, exported.digest);
});

test("a declaration's own problems are named, and nothing is exported", t => {
    const dir = packageDir(t);
    const { outputSchema: _output, ...noOutput } = DECLARED;
    for (const [declared, pattern] of [
        ["review_change@1", /must be a mapping/],
        [{ ...DECLARED, extra: "x" }, /unknown field 'extra'/],
        [{ ...DECLARED, name: "1review" }, /workflowInterface\.name/],
        [{ ...DECLARED, version: "" }, /workflowInterface\.version/],
        [{ ...DECLARED, version: 1 }, /workflowInterface\.version/],
        [noOutput, /outputSchema must name a schema file/],
        [{ ...DECLARED, inputSchema: [] }, /inputSchema, when given/],
        [{ ...DECLARED, outcomes: [] }, /outcomes must list/],
        [{ ...DECLARED, outcomes: "accepted" }, /outcomes must list/],
        [{ ...DECLARED, outcomes: ["accepted", "accepted"] }, /outcomes must list/],
        [{ ...DECLARED, outcomes: ["accepted", "timed_out"] }, /not a runtime route/],
    ]) {
        const { exported, issues } = exportWorkflowInterface(dir, declared);
        assert.equal(exported, null, JSON.stringify(declared));
        assert.ok(issues.length > 0 && issues.every(issue => issue.code === "invalid_workflow_interface"), JSON.stringify(issues));
        assert.ok(issues.some(issue => pattern.test(issue.message)), `${pattern}: ${JSON.stringify(issues)}`);
    }
});

test("schema files stay inside the package, are ordinary JSON files, and stand alone as workflow schemas", t => {
    const dir = packageDir(t, {
        "contracts/bad.json": "{nope",
        "contracts/ref.json": JSON.stringify({ type: "object", properties: { other: { $ref: "#/schemas/Other" } } }),
        "contracts/id.json": JSON.stringify({ $id: "urn:x", type: "object" }),
        "contracts/unknown.json": JSON.stringify({ type: "object", propertiez: {} }),
        "contracts/invalid.json": JSON.stringify({ type: "nope" }),
        "contracts/list.json": JSON.stringify([1, 2]),
        "contracts/infinite.json": "{\"type\": \"number\", \"maximum\": 1e400}",
        "contracts/deep.json": `${"{\"not\": ".repeat(70)}{}${"}".repeat(70)}`,
        "contracts/large.json": JSON.stringify({ type: "string", description: "x".repeat(WORKFLOW_INTERFACE_SCHEMA_MAX_BYTES) }),
    });
    fs.symlinkSync(path.join(dir, "contracts", "review-result.schema.json"), path.join(dir, "contracts", "link.json"));
    fs.writeFileSync(path.join(path.dirname(dir), `${path.basename(dir)}-outside.json`), JSON.stringify(RESULT));
    t.after(() => fs.rmSync(path.join(path.dirname(dir), `${path.basename(dir)}-outside.json`), { force: true }));
    for (const [ref, pattern] of [
        [`../${path.basename(dir)}-outside.json`, /inside the package \(no '\.\.'\)/],
        ["contracts/../../x.json", /no '\.\.'/],
        ["/etc/hostname", /relative path inside the package/],
        ["https://example.com/review.schema.json", /relative path inside the package/],
        ["contracts\\review-result.schema.json", /no absolute path, URL or backslash/],
        ["contracts/missing.json", /is not in the package/],
        ["contracts", /must be an ordinary file/],
        ["contracts/link.json", /must be an ordinary file/],
        ["contracts/bad.json", /is not valid JSON/],
        ["contracts/ref.json", /stands alone: it may not use \$ref/],
        ["contracts/id.json", /'\$id' is not supported/],
        ["contracts/unknown.json", /propertiez/],
        ["contracts/invalid.json", /type/],
        ["contracts/list.json", /a schema must be a mapping or a boolean/],
        ["contracts/infinite.json", /numbers must be finite/],
        ["contracts/deep.json", /nesting exceeds 64 levels/],
        ["contracts/large.json", new RegExp(`larger than ${WORKFLOW_INTERFACE_SCHEMA_MAX_BYTES} bytes`)],
    ]) {
        const { exported, issues } = exportWorkflowInterface(dir, { ...DECLARED, outputSchema: ref });
        assert.equal(exported, null, ref);
        assert.equal(issues.length, 1, `${ref}: ${JSON.stringify(issues)}`);
        assert.equal(issues[0].code, "workflow_interface_schema", ref);
        assert.ok(issues[0].message.startsWith(`workflowInterface.outputSchema '${ref}': `), issues[0].message);
        assert.match(issues[0].message, pattern, ref);
    }
    // The input schema is checked the same way, and named.
    const input = exportWorkflowInterface(dir, { ...DECLARED, inputSchema: "contracts/missing.json" });
    assert.deepEqual(input.issues.map(issue => [issue.code, issue.message.startsWith("workflowInterface.inputSchema 'contracts/missing.json'")]),
        [["workflow_interface_schema", true]]);
});

test("a stored interface is read back only when it is well formed and its digest matches", t => {
    const { exported } = exportWorkflowInterface(packageDir(t), DECLARED);
    assert.deepEqual(readWorkflowInterfaceExport(JSON.parse(JSON.stringify(exported))), exported);
    for (const tampered of [
        { ...exported, digest: "0".repeat(64) },
        { ...exported, outcomes: ["accepted"] },
        { ...exported, outputSchema: { type: "object" } },
        { ...exported, name: "bad name" },
        { ...exported, digest: undefined },
        null, "review_change@1", [],
    ]) {
        assert.equal(readWorkflowInterfaceExport(tampered), null, JSON.stringify(tampered));
    }
    // A record whose digest matches but whose schema does not stand alone is refused too.
    const body = { name: "x", version: "1", inputSchema: null, outputSchema: { type: "object", properties: { a: { $ref: "#/$defs/Other" } } }, outcomes: ["ok"] };
    assert.equal(readWorkflowInterfaceExport({ ...body, digest: workflowInterfaceDigest(body) }), null);
});

test("an agent state names an interface with its package and an outputSchema; the IR keeps it and the stored IR reads it back", () => {
    const compiled = compileWorkflow(AGENT_YAML(), MILESTONE);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.deepEqual(compiled.ir.nodes.review.invoke,
        { agent: { name: "code-reviewer", package: "review-kit", version: "1.2.0", interface: WANTED } });
    assert.equal(describeWorkflowState(compiled.ir.nodes.review).invoke.interface, "review_change@1");
    const stored = JSON.parse(canonicalJson(compiled.ir));
    assert.deepEqual(parseWorkflowIr(stored, { maxIrVersion: WORKFLOW_MILESTONE_IR_VERSION }), compiled.ir);
    for (const bad of [{ name: "review_change" }, { ...WANTED, extra: "x" }, "review_change@1", { name: "bad name", version: "1" }]) {
        const copy = structuredClone(stored);
        copy.nodes.review.invoke.agent.interface = bad;
        assert.throws(() => parseWorkflowIr(copy, { maxIrVersion: WORKFLOW_MILESTONE_IR_VERSION }), /stored IR agent state review is invalid/);
    }
    const unpackaged = structuredClone(stored);
    unpackaged.nodes.review.invoke.agent.package = null;
    assert.throws(() => parseWorkflowIr(unpackaged, { maxIrVersion: WORKFLOW_MILESTONE_IR_VERSION }), /stored IR agent state review is invalid/);

    // Without an interface the IR is as before: no interface key.
    const plain = compileWorkflow(AGENT_YAML({ invoke: "{ agent: { name: code-reviewer, package: review-kit } }" }), MILESTONE);
    assert.deepEqual(plain.ir.nodes.review.invoke, { agent: { name: "code-reviewer", package: "review-kit", version: null } });
    assert.equal("interface" in describeWorkflowState(plain.ir.nodes.review).invoke, false);

    for (const [options, expected] of [
        [{ invoke: "{ agent: { name: code-reviewer, package: review-kit, interface: review_change } }" },
            ["WORKFLOW_FIELD_INVALID", "states.review.invoke.agent.interface"]],
        [{ invoke: "{ agent: { name: code-reviewer, package: review-kit, interface: { name: review_change, version: \"1\" } } }" },
            ["WORKFLOW_FIELD_INVALID", "states.review.invoke.agent.interface"]],
        [{ invoke: "{ agent: { name: code-reviewer, interface: review_change@1 } }" }, ["WORKFLOW_FIELD_INVALID", "states.review.invoke.agent.interface"]],
        [{ output: "" }, ["WORKFLOW_FIELD_REQUIRED", "states.review.outputSchema"]],
    ]) {
        const result = compileWorkflow(AGENT_YAML(options), MILESTONE);
        assert.equal(result.valid, false, JSON.stringify(options));
        assert.deepEqual(errorsOf(result), [expected], JSON.stringify(options));
    }
});

test("publication's check: the state's outcomes and schemas are exactly the interface's, nothing inferred", t => {
    const dir = packageDir(t);
    const { exported } = exportWorkflowInterface(dir, DECLARED);
    const compiled = compileWorkflow(AGENT_YAML(), MILESTONE);
    const node = compiled.ir.nodes.review;
    const check = (exportedValue, { state = node, ir = compiled.ir, wanted = WANTED } = {}) => workflowInterfaceMismatches(state, ir, wanted, exportedValue);
    assert.deepEqual(check(exported), []);
    // The same outcomes in another order match; the stored record is checked again.
    const reordered = exportWorkflowInterface(dir, { ...DECLARED, outcomes: ["changes_required", "accepted"] }).exported;
    assert.deepEqual(check(reordered), []);
    assert.deepEqual(check(undefined), ["its agent exports no workflow interface (expected review_change@1)"]);
    assert.deepEqual(check({ ...exported, digest: "0".repeat(64) }), ["its agent's workflow interface record is not well formed"]);
    assert.deepEqual(check(exported, { wanted: { name: "review_change", version: "2" } }), ["its agent exports review_change@1, not review_change@2"]);

    const fewer = exportWorkflowInterface(dir, { ...DECLARED, outcomes: ["accepted"] }).exported;
    assert.deepEqual(check(fewer), ["its outcomes [accepted, changes_required] are not the interface's [accepted]"]);
    // A looser or a stricter schema is a mismatch: no narrowing is assumed safe.
    const looser = exportWorkflowInterface(packageDir(t, { "contracts/review-result.schema.json": JSON.stringify({ type: "object" }) }), DECLARED).exported;
    assert.deepEqual(check(looser), ["its outputSchema is not exactly the interface's output schema"]);
    const stricter = { ...RESULT, required: ["verdict", "notes"] };
    const strict = exportWorkflowInterface(packageDir(t, { "contracts/review-result.schema.json": JSON.stringify(stricter) }), DECLARED).exported;
    assert.deepEqual(check(strict), ["its outputSchema is not exactly the interface's output schema"]);
    const otherInput = exportWorkflowInterface(packageDir(t, { "contracts/review-input.schema.json": JSON.stringify({ type: "object" }) }), DECLARED).exported;
    assert.deepEqual(check(otherInput), ["its inputSchema is not exactly the interface's input schema"]);
    // A state without an input schema does not match an interface that declares one; an interface without one takes any.
    assert.deepEqual(check(exported, { state: { ...node, inputSchema: null } }), ["its inputSchema is not exactly the interface's input schema"]);
    const { inputSchema: _input, ...outputOnly } = DECLARED;
    const anyInput = exportWorkflowInterface(dir, outputOnly).exported;
    assert.deepEqual(check(anyInput, { state: { ...node, inputSchema: null } }), []);
    // A workflow schema that refers to another one is not the interface's schema, even when it would validate the same.
    const referring = compileWorkflow(AGENT_YAML({ result: JSON.stringify({ ...RESULT, properties: { verdict: { $ref: "#/schemas/Verdict" },
        notes: { type: "string" } } }) }).replace("schemas:\n", "schemas:\n  Verdict: { type: string }\n"), MILESTONE);
    assert.equal(referring.valid, true, JSON.stringify(referring.diagnostics));
    assert.deepEqual(check(exported, { state: referring.ir.nodes.review, ir: referring.ir }), ["its outputSchema is not exactly the interface's output schema"]);
});

test("an agent file declares its interface in schemaVersion 5 front matter; a malformed or older declaration is never dropped silently", t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-interface-agents-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const agent = (name, lines) => {
        const text = ["---", `name: ${name}`, "version: 1.0.0", ...lines, "---", "", "You review changes."].join("\n");
        fs.writeFileSync(path.join(dir, `${name}.agent.md`), text);
        return text;
    };
    const inline = agent("inline", ["schemaVersion: 5", "workflowInterface:", "  name: review_change", "  version: \"1\"",
        "  # the contract files", "  inputSchema: ./contracts/review-input.schema.json", "  outputSchema: './contracts/review-result.schema.json'",
        "  outcomes: [accepted, \"changes_required\"]", "tools: [read_file]"]);
    agent("block", ["schemaVersion: 5", "workflowInterface:", "  name: review_change", "  version: \"1\"",
        "  outputSchema: ./contracts/review-result.schema.json", "  outcomes:", "    - accepted", "    - changes_required"]);
    agent("plain", ["schemaVersion: 5"]);
    agent("older", ["schemaVersion: 4", "workflowInterface:", "  name: review_change", "  version: \"1\"",
        "  outputSchema: ./contracts/review-result.schema.json", "  outcomes: [accepted]"]);
    const duplicate = agent("duplicate", ["schemaVersion: 5", "workflowInterface:", "  name: review_change", "  name: other", "  version: \"1\"",
        "  outputSchema: ./r.json", "  outcomes: [accepted]"]);
    const malformed = agent("malformed", ["schemaVersion: 5", "workflowInterface:", "   name: review_change", "  version: \"1\""]);
    const inlineValue = agent("inlined", ["schemaVersion: 5", "workflowInterface: review_change@1"]);

    const loaded = Object.fromEntries(loadAgentFiles(dir).map(item => [item.name, item]));
    assert.deepEqual(Object.keys(loaded).sort(), ["block", "inline", "plain"]);
    assert.deepEqual(loaded.inline.workflowInterface, { name: "review_change", version: "1", inputSchema: "./contracts/review-input.schema.json",
        outputSchema: "./contracts/review-result.schema.json", outcomes: OUTCOMES });
    assert.deepEqual(loaded.inline.tools, ["read_file"], "the fields after the mapping still parse");
    assert.deepEqual(loaded.block.workflowInterface.outcomes, OUTCOMES);
    assert.equal("workflowInterface" in loaded.plain, false);
    // Package validation keeps the older one long enough to name why it is refused.
    const older = loadAgentFiles(dir, { includeInvalid: true }).find(item => item.name === "older");
    assert.deepEqual(validateAgentDefinition(older).map(issue => issue.code), ["workflow_interface_requires_schema_v5"]);
    assert.equal(agentFrontmatterProblem(inline), null);
    assert.match(agentFrontmatterProblem(duplicate), /Duplicate workflowInterface field: name/);
    assert.match(agentFrontmatterProblem(malformed), /Malformed workflowInterface entry/);
    assert.match(agentFrontmatterProblem(inlineValue), /workflowInterface requires an indented mapping/);
    // schemaVersion 5 keeps what 3 and 4 declare.
    assert.deepEqual(validateAgentDefinition({ schemaVersion: 5, nativeTaskTools: { "swarm-explore": [] }, tools: ["x"], initialRequiredTool: "x" }), []);
    assert.deepEqual(validateAgentDefinition({ schemaVersion: 3, nativeTaskTools: { "swarm-explore": [] } }).map(issue => issue.code), ["native_task_policy"]);
});
