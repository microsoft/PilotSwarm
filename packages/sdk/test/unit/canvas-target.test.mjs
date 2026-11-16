/**
 * Canvas target rules (design D1): the "parent" alias, Workflows are never
 * canvas targets, and a script must name a canvas. resolveCanvasTarget runs
 * against a fake catalog of five sessions:
 *
 *   P (agent, root)
 *   ├── W (workflow)
 *   │   └── S (agent step)
 *   │       └── C (the step's sub-agent)
 *   └── A (agent)
 *
 * Run: node --test test/unit/canvas-target.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveCanvasTarget } from "../../dist/canvas-operations.js";
import { ManagedSession } from "../../dist/managed-session.js";

const P = "pppppppp-0000-4000-8000-000000000001";
const W = "wwwwwwww-0000-4000-8000-000000000002";
const S = "ssssssss-0000-4000-8000-000000000003";
const C = "cccccccc-0000-4000-8000-000000000004";
const A = "aaaaaaaa-0000-4000-8000-000000000005";

const rows = {
    [P]: { sessionId: P, sessionKind: "agent", parentSessionId: null },
    [W]: { sessionId: W, sessionKind: "workflow", parentSessionId: P },
    [S]: { sessionId: S, sessionKind: "agent", parentSessionId: W },
    [C]: { sessionId: C, sessionKind: "agent", parentSessionId: S },
    [A]: { sessionId: A, sessionKind: "agent", parentSessionId: P },
};
const catalog = { getSession: async (id) => rows[id] ?? null };

const M1 = 'session_id "parent": this session has no parent agent.';
const M2 = (id) => `session_id ${id.slice(0, 8)} is a Workflow, and a Workflow has no canvas. Use session_id "parent" to write to the agent that started it.`;
const M3 = 'A Workflow script must name a canvas: pass session_id "parent" (the agent that started this Workflow) or the session id of an agent above it.';

function deps(writerSessionId, mode, cat = catalog) {
    return { catalog: cat, artifactStore: null, factStore: null, writerSessionId, workerNodeId: undefined, agentIdentity: null, mode };
}

const cases = [
    { writer: A, mode: "agent", requested: undefined, expect: { target: A, crossSession: false }, label: "an agent's omitted target is its own canvas" },
    { writer: W, mode: "script", requested: undefined, expect: { error: M3 }, label: "a script's omitted target is refused" },
    { writer: A, mode: "agent", requested: "parent", expect: { target: P, crossSession: true }, label: "an ordinary sub-agent's parent is its direct parent" },
    { writer: W, mode: "script", requested: "parent", expect: { target: P, crossSession: true }, label: "a script's parent is the agent that started the Workflow" },
    { writer: S, mode: "agent", requested: "parent", expect: { target: P, crossSession: true }, label: "an agent step's parent is the agent that started the Workflow" },
    { writer: C, mode: "agent", requested: "parent", expect: { target: P, crossSession: true }, label: "an agent step's sub-agent's parent is the agent that started the Workflow, not the step" },
    { writer: P, mode: "agent", requested: "parent", expect: { error: M1 }, label: "a root session has no parent" },
    { writer: S, mode: "agent", requested: W, expect: { error: M2(W) }, label: "an agent step may not target its Workflow" },
    { writer: W, mode: "script", requested: W, expect: { error: M2(W) }, label: "a script may not target its own Workflow" },
    { writer: C, mode: "agent", requested: S, expect: { target: S, crossSession: true }, label: "a step's sub-agent reaches the step by explicit id" },
    { writer: C, mode: "agent", requested: P, expect: { target: P, crossSession: true }, label: "a step's sub-agent reaches the Workflow's starter by explicit id" },
    { writer: A, mode: "agent", requested: S, expect: { error: `session_id ${S} is not an ancestor of this session — canvas tools may target only your parent chain (parent, grandparent, root)` }, label: "a non-ancestor is refused, message unchanged" },
];

const names = { [P]: "P", [W]: "W", [S]: "S", [C]: "C", [A]: "A" };
const shown = (requested) => requested === undefined ? "omitted" : names[requested] ?? JSON.stringify(requested);

for (const c of cases) {
    test(`${c.label} (${names[c.writer]}, ${c.mode}, ${shown(c.requested)})`, async () => {
        assert.deepEqual(await resolveCanvasTarget(deps(c.writer, c.mode), c.requested), c.expect);
    });
}

test("M2 names the Workflow by its first 8 characters", async () => {
    const result = await resolveCanvasTarget(deps(S, "agent"), W);
    assert.ok("error" in result);
    assert.ok(result.error.includes(W.slice(0, 8)), result.error);
    assert.ok(!result.error.includes(W), "only the first 8 characters, not the whole id");
});

test("a lineage read that throws is refused, whatever the writer, mode and target", async () => {
    const throwing = { getSession: async () => { throw new Error("catalog down"); } };
    for (const [writer, mode, requested] of [[C, "agent", P], [S, "agent", "parent"], [W, "script", "parent"], [W, "script", W], [A, "agent", A]]) {
        const result = await resolveCanvasTarget(deps(writer, mode, throwing), requested);
        assert.ok("error" in result, `${names[writer]} ${mode} ${shown(requested)}`);
        assert.match(result.error, /^could not verify the session lineage: catalog down$/);
    }
});

test("the five canvas tools teach the \"parent\" target and keep the ancestor rule", () => {
    const defs = ManagedSession.systemToolDefs();
    for (const name of ["draw_canvas", "update_canvas", "show_canvas", "read_canvas", "canvas_kv"]) {
        const tool = defs.find((t) => t.name === name);
        assert.ok(tool, `${name} is declared`);
        const description = tool.parameters.properties.session_id.description;
        assert.match(description, /ANCESTOR/, name);
        assert.ok(description.includes(', or "parent" for the agent that started your Workflow (or your parent agent)'), `${name}: ${description}`);
    }
});
