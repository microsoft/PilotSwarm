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

test("the six canvas tools that take session_id teach the \"parent\" target and keep the ancestor rule", () => {
    const defs = ManagedSession.systemToolDefs();
    for (const name of ["draw_canvas", "update_canvas", "show_canvas", "read_canvas", "canvas_kv", "publish_canvas_app"]) {
        const tool = defs.find((t) => t.name === name);
        assert.ok(tool, `${name} is declared`);
        const description = tool.parameters.properties.session_id.description;
        assert.match(description, /ANCESTOR/, name);
        assert.ok(description.includes('Pass its id, or "parent": the agent that started your Workflow, else your parent agent.'), `${name}: ${description}`);
        assert.ok(description.endsWith("Siblings, children and unrelated sessions are refused."), `${name} keeps the refusal: ${description}`);
    }
});

// ─── "parent" passes the same checks as an explicit id; cycles are lineage errors ───

const NOT_ANCESTOR = (id) => `session_id ${id} is not an ancestor of this session — canvas tools may target only your parent chain (parent, grandparent, root)`;
const REPEATS = (id) => `could not verify the session lineage: the parent chain repeats at ${id.slice(0, 8)}`;
const catalogOf = (list) => {
    const byId = Object.fromEntries(list.map((row) => [row.sessionId, row]));
    return { getSession: async (id) => byId[id] ?? null };
};
const agent = (sessionId, parentSessionId = null) => ({ sessionId, sessionKind: "agent", parentSessionId });
const workflow = (sessionId, parentSessionId = null) => ({ sessionId, sessionKind: "workflow", parentSessionId });

test("hop bound: a Workflow at hop 8 whose parent is at hop 9 gives \"parent\" no target inside the bound", async () => {
    // X0 (writer) -> X1 .. X7 (agents) -> W8 (Workflow, hop 8) -> P9 (hop 9).
    const X = Array.from({ length: 8 }, (_, i) => `x${i}hop000-0000-4000-8000-00000000010${i}`);
    const W8 = "w8hop000-0000-4000-8000-000000000108";
    const P9 = "p9hop000-0000-4000-8000-000000000109";
    const cat = catalogOf([
        ...X.map((id, i) => agent(id, i < 7 ? X[i + 1] : W8)),
        workflow(W8, P9),
        agent(P9),
    ]);
    assert.deepEqual(await resolveCanvasTarget(deps(X[0], "agent", cat), "parent"), { error: NOT_ANCESTOR(P9) });
    assert.deepEqual(await resolveCanvasTarget(deps(X[0], "agent", cat), P9), { error: NOT_ANCESTOR(P9) });
    // One hop nearer, the Workflow's parent is at hop 8 and is the target.
    assert.deepEqual(await resolveCanvasTarget(deps(X[1], "agent", cat), "parent"), { target: P9, crossSession: true });
});

test("a self-parenting Workflow is a lineage error for its script's \"parent\"", async () => {
    const WS = "wselfwf0-0000-4000-8000-000000000201";
    const cat = catalogOf([workflow(WS, WS)]);
    assert.deepEqual(await resolveCanvasTarget(deps(WS, "script", cat), "parent"), { error: REPEATS(WS) });
});

test("a cycle in the parent chain is a lineage error for an explicit id and for \"parent\"", async () => {
    const CA = "cyclea00-0000-4000-8000-000000000301";
    const CB = "cycleb00-0000-4000-8000-000000000302";
    const cat = catalogOf([agent(CA, CB), agent(CB, CA)]);
    assert.deepEqual(await resolveCanvasTarget(deps(CA, "agent", cat), "zzz"), { error: REPEATS(CA) });
    assert.deepEqual(await resolveCanvasTarget(deps(CA, "agent", cat), "parent"), { error: REPEATS(CA) });
});

test("\"parent\" whose candidate has no catalog row is accepted, like an explicit missing-row ancestor", async () => {
    const PM = "pmissing-0000-4000-8000-000000000401";
    const WM = "wmissing-0000-4000-8000-000000000402";
    const SM = "smissing-0000-4000-8000-000000000403";
    const cat = catalogOf([workflow(WM, PM), agent(SM, WM)]);
    assert.deepEqual(await resolveCanvasTarget(deps(WM, "script", cat), "parent"), { target: PM, crossSession: true });
    assert.deepEqual(await resolveCanvasTarget(deps(SM, "agent", cat), "parent"), { target: PM, crossSession: true });
    assert.deepEqual(await resolveCanvasTarget(deps(SM, "agent", cat), PM), { target: PM, crossSession: true });
});

test("\"parent\" whose candidate is a Workflow (a corrupt row) gets M2 naming the candidate", async () => {
    const WX = "wcorrupt-0000-4000-8000-000000000501";
    const XW = "xworkflw-0000-4000-8000-000000000502";
    const SX = "scorrupt-0000-4000-8000-000000000503";
    const cat = catalogOf([workflow(WX, XW), workflow(XW), agent(SX, WX)]);
    assert.deepEqual(await resolveCanvasTarget(deps(WX, "script", cat), "parent"), { error: M2(XW) });
    assert.deepEqual(await resolveCanvasTarget(deps(SX, "agent", cat), "parent"), { error: M2(XW) });
});
