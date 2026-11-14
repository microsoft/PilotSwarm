import test from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { compileWorkflow, parseWorkflowIr } from "../../dist/workflow/compiler.js";
import { canonicalJson, sha256Hex } from "../../dist/workflow/json.js";
import { workflowGraphJson, workflowReaderView } from "../../dist/workflow/tools.js";

const next = { elapsed: "done", failure: "bad" };
const wait = () => ({ type: "wait", seconds: 1, transition: { next } });
const terminal = outcome => ({ type: "terminal", outcome });
const definition = work => ({
    apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "notes", version: "1.0.0" },
    initial: "work", states: { work, done: terminal("succeeded"), bad: terminal("blocked") },
});
const compile = doc => compileWorkflow(stringify(doc));
const valid = doc => {
    const result = compile(doc);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
    return result;
};
const literal = "  Keep ${unknown.value} literally.\n<script>not code</script>\n";
const states = {
    script: { type: "script", source: 'await setResult("ok", {});', transition: { next: { ok: "done", failure: "bad" } } },
    wait: wait(),
    approval: { type: "approval", question: "Proceed?", timeoutSeconds: 100,
        transition: { next: { approved: "done", rejected: "bad", timed_out: "bad", failure: "bad" } } },
    agent: { type: "agent", invoke: { prompt: "Respond." }, timeoutSeconds: 100,
        transition: { next: { ok: "done", failure: "bad" } } },
    send: { type: "messaging", mode: "send", recipient: { parent: true }, contract: "Note@1",
        transition: { next: { sent: "done", failure: "bad" } } },
    request: { type: "messaging", mode: "request", recipient: { parent: true }, contract: "Note@1", timeoutSeconds: 100,
        transition: { next: { responded: "done", declined: "bad", timed_out: "bad", failure: "bad" } } },
    receive: { type: "messaging", mode: "receive", contract: "Note@1", wait: { seconds: 100 },
        transition: { next: { received: "done", elapsed: "bad", failure: "bad" } } },
    parallel: { type: "parallel", forEach: [], body: { initial: "item", states: { item: terminal("succeeded") } },
        transition: { next: { joined: "done", blocked: "bad", failure: "bad" } } },
    branches: { type: "parallel", branches: {
        left: { initial: "leftEnd", states: { leftEnd: terminal("succeeded") } },
        right: { initial: "rightEnd", states: { rightEnd: terminal("succeeded") } },
    }, transition: { next: { joined: "done", blocked: "bad", failure: "bad" } } },
};

for (const [kind, state] of Object.entries(states)) {
    test(`literal root/state/route notes survive compilation, storage and graph reads: ${kind}`, () => {
        const doc = definition(structuredClone(state));
        doc.contracts = { "Note@1": { schema: { type: "object" }, response: { schema: { type: "object" } } } };
        doc.notes = literal;
        doc.states.work.description = "Check the build";
        doc.states.work.notes = literal;
        doc.states.done.notes = "Complete.\n";
        const route = Object.keys(doc.states.work.transition.next)[0];
        doc.states.work.transition.notes = { [route]: literal };
        if (kind === "parallel") doc.states.work.body.states.item.notes = literal;
        if (kind === "branches") doc.states.work.branches.left.states.leftEnd.notes = literal;
        const result = valid(doc);
        assert.deepEqual(parseWorkflowIr(result.ir), result.ir);
        const graph = workflowGraphJson(parseWorkflowIr(result.ir), 2);
        assert.equal(graph.notes, literal);
        assert.deepEqual(graph.states.find(s => s.id === "work").about,
            { description: "Check the build", ...(kind === "agent" ? { prompt: "Respond." } : {}), notes: literal });
        assert.deepEqual(graph.states.find(s => s.id === "work").routeNotes, { [route]: literal });
        assert.equal(graph.states.find(s => s.id === "done").about.notes, "Complete.\n");
        if (kind === "parallel") assert.equal(graph.states.find(s => s.id === "item").about.notes, literal);
        if (kind === "branches") assert.equal(graph.states.find(s => s.id === "leftEnd").about.notes, literal);
        const reader = workflowReaderView({ graph });
        assert.equal(reader.graph.notes, literal);
        assert.equal(reader.graph.states.find(s => s.id === "work").about.notes, literal);
        assert.equal(Object.hasOwn(reader.graph.states.find(s => s.id === "work").about, "prompt"), false);
    });
}

test("absent annotations preserve exact old canonical IR/hash; annotations make a different hash", () => {
    const result = valid(definition(wait()));
    const expected = {
        irVersion: 1, apiVersion: "pilotswarm.dev/v1", name: "notes", version: "1.0.0",
        description: null, initial: "work", initialInput: null, inputsSchema: null, outputSchema: null, catchAll: null,
        limits: { maxNodeExecutions: 1000 }, schemaDefs: {}, contracts: {},
        nodes: {
            work: { id: "work", type: "wait", description: null, seconds: 1, hasInput: false, input: null, next },
            done: { id: "done", type: "terminal", description: null, outcome: "succeeded", summary: null, hasOutput: false, output: null, outputSchema: null },
            bad: { id: "bad", type: "terminal", description: null, outcome: "blocked", summary: null, hasOutput: false, output: null, outputSchema: null },
        },
    };
    assert.equal(canonicalJson(result.ir), canonicalJson(expected));
    assert.equal(result.irSha256, sha256Hex(canonicalJson(expected)));
    assert.deepEqual(parseWorkflowIr(expected), expected);
    const doc = definition(wait());
    doc.notes = "";
    doc.states.work.notes = "";
    doc.states.work.transition.notes = {};
    const annotated = valid(doc);
    assert.equal(annotated.ir.notes, "");
    assert.deepEqual(parseWorkflowIr(annotated.ir), annotated.ir);
    assert.notEqual(annotated.irSha256, result.irSha256);
    const graph = workflowGraphJson(result.ir, 1);
    assert.equal(Object.hasOwn(graph, "notes"), false);
    assert.equal(Object.hasOwn(graph.states[0], "routeNotes"), false);
    assert.equal(Object.hasOwn(graph.states[0], "about"), false);
});

test("each note is at most 16 KiB UTF-8, preserves whitespace, and must be storable literal text", () => {
    for (const note of ["x".repeat(16384), "\u00e9".repeat(8192), literal, ""]) {
        const doc = definition(wait());
        doc.notes = note;
        doc.states.work.notes = note;
        doc.states.work.transition.notes = { elapsed: note };
        assert.deepEqual(parseWorkflowIr(valid(doc).ir).notes, note);
    }
    for (const note of [null, 1, [], {}, "x".repeat(16385), "\u00e9".repeat(8193), "\0", "\ud800"]) {
        for (const place of ["root", "state", "route"]) {
            const doc = definition(wait());
            if (place === "root") doc.notes = note;
            if (place === "state") doc.states.work.notes = note;
            if (place === "route") doc.states.work.transition.notes = { elapsed: note };
            const result = compile(doc);
            assert.equal(result.valid, false, `${place}: ${JSON.stringify(note).slice(0, 50)}`);
            assert.ok(result.diagnostics.some(d => d.code === "WORKFLOW_FIELD_INVALID" && d.path.endsWith(place === "route" ? ".elapsed" : "notes")));
            const ir = structuredClone(valid(definition(wait())).ir);
            if (place === "root") ir.notes = note;
            if (place === "state") ir.nodes.work.notes = note;
            if (place === "route") ir.nodes.work.routeNotes = { elapsed: note };
            assert.throws(() => parseWorkflowIr(ir));
        }
    }
});

test("route notes cannot change routes, name absent routes, or annotate terminals", () => {
    for (const notes of [null, [], 1, { missing: "No such route" }]) {
        const doc = definition(wait());
        doc.states.work.transition.notes = notes;
        assert.equal(compile(doc).valid, false);
        const ir = structuredClone(valid(definition(wait())).ir);
        ir.nodes.work.routeNotes = notes;
        assert.throws(() => parseWorkflowIr(ir));
    }
    const doc = definition(wait());
    doc.states.done.transition = { notes: { elapsed: "Not a route" } };
    assert.equal(compile(doc).valid, false);
    const ir = structuredClone(valid(definition(wait())).ir);
    ir.nodes.done.routeNotes = {};
    assert.throws(() => parseWorkflowIr(ir));
});
