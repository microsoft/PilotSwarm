import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { canonicalJson } from "../../src/workflow/json.ts";
import { carryArrival, carrySnapshotText, readCarrySnapshot } from "../../src/workflow/carry.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { branchScopeId } from "../../src/workflow/parallel.ts";
import { registerWorkflow, WORKFLOW_ACTIVITIES, BRANCH_ROUTE } from "../../src/workflow/runtime.ts";

const getEnv = useSuiteEnv(import.meta.url);
const ACTOR = { kind: "system", name: "workflow-carry-test" };
const TIMEOUT = 120_000;
const ROUTE_STATES = [
    ["send", "sent", "    type: messaging\n    mode: send\n    recipient: { parent: true }\n    contract: Test@1", { accepted: true }],
    ["request", "responded", "    type: messaging\n    mode: request\n    recipient: { parent: true }\n    contract: Test@1\n    timeoutSeconds: 60", { approved: true }],
    ["receive", "received", "    type: messaging\n    mode: receive\n    contract: Test@1\n    wait: { seconds: 60 }", { event: 1 }],
    ["agent", "ok", "    type: agent\n    session: new\n    invoke: { prompt: Answer from input. }\n    outcomes: [ok]\n    timeoutSeconds: 60", { answer: 1 }],
    ["wait", "elapsed", "    type: wait\n    seconds: 60", { q: "hi" }],
];
const script = `
    type: script
    carry: { loop: "\${input.loop}", saved: "\${kv.saved}" }
    input: "\${input.payload}"
    source: await setResult("ok", {});
    transition: { next: { ok: next, failure: next } }`;
const yamlOf = (work = script, next = "", root = "") => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: carry, version: "1.0.0" }
initial: work
initialInput: "\${inputs}"
${root}
states:
  work:
${work}
  next:
    type: script
${next}
    source: await setResult("ok", {});
    transition: { next: { ok: done, failure: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

/** Real admission transactions and production activities; effects are completed explicitly, without model calls. */
async function fixture(yaml = yamlOf(), { version = "1.1.0", inputs = { loop: 7, payload: { q: "hi" } } } = {}) {
    const h = await openWorkflowStore(getEnv());
    try {
        const compiled = compileWorkflow(yaml);
        expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
        const owner = { provider: "test", subject: randomUUID() };
        const parent = randomUUID();
        const workflowSessionId = randomUUID();
        const runId = randomUUID();
        await h.catalog.createSession(parent, { owner });
        await h.catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner,
            creationConfig: { workflow: { requestSha256: "carry" } } });
        await h.store.createDefinition({ workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled,
            actor: ACTOR, operationId: "create", requestSha256: "carry", publish: true, title: "Carry",
            start: { runId, mode: "live", controllerInstanceId: `carry-${runId}`, controllerVersion: version,
                inputsText: canonicalJson(inputs), kvText: '{"saved":1}', testAgentMode: null } });
        await h.store.beginRun(runId);
        const activities = new Map();
        registerWorkflow({ registerActivity: (name, fn) => activities.set(name, fn), registerOrchestrationVersioned: () => {} }, {
            store: h.store, catalog: h.catalog, enabled: () => true, resolveToolBinding: async () => null,
            openToolExecutor: async () => { throw new Error("No tool effects permitted."); },
            authorizeParentNotification: async () => false, notifyParent: async () => { throw new Error("No notifications permitted."); },
            deleteSession: async id => h.catalog.softDeleteSession(id),
        });
        const enter = async (nodeId = "work", predecessorId = null, arrivalRoute = null, { ordinal = 1, scopeId = "root" } = {}) => {
            const args = { runId, nodeId, predecessorId, arrivalRoute, ordinal, scopeId };
            const result = await activities.get(WORKFLOW_ACTIVITIES.enter)({ getClient: () => null }, args);
            expect(result.admitted).toBe(true);
            return h.store.readNodeExecution(nodeExecutionIdFor(runId, scopeId, nodeId, ordinal));
        };
        const finish = (node, value, outcome = "ok", resultKind = "business") => h.store.completeNode(node.nodeExecutionId,
            { outcome, resultKind, valueText: canonicalJson(value), winner: "effect" });
        const setKv = async saved => {
            const run = await h.store.readRun(runId);
            return h.store.setRunVars({ workflowSessionId, runId, set: { saved }, delete: [],
                expectedRevision: run.kvRevision, operationId: randomUUID(), requestSha256: `saved-${saved}`, actor: ACTOR });
        };
        return Object.assign(h, { runId, workflowSessionId, parent, enter, finish, setKv });
    } catch (error) {
        await h.stop();
        throw error;
    }
}

describe("carry admission and routing", () => {
    it("freezes before input mapping, survives a KV update and activity replay, and carries errors unchanged", { timeout: TIMEOUT }, async () => {
        const h = await fixture(yamlOf(script, '    input: { wrapper: "${input}", error: "${runtime.error}" }'));
        try {
            const entered = await h.enter();
            expect(entered.input).toEqual({ q: "hi" });
            expect(entered.carrySnapshot).toEqual({ loop: 7, saved: 1 });
            await h.setKv(9);
            expect(await h.enter()).toEqual(entered);
            const error = { code: "execution_failed", message: "fixture crash", details: null };
            await h.finish(entered, error, "execution_failed", "runtime_error");
            const next = await h.enter("next", entered.nodeExecutionId, "failure");
            expect(next.input).toEqual({ wrapper: { carry: { loop: 7, saved: 1 }, result: error }, error });
        } finally { await h.stop(); }
    });

    it("re-evaluates input and carry together after a pre-admission KV conflict", { timeout: TIMEOUT }, async () => {
        const h = await fixture(yamlOf(script.replace('input: "${input.payload}"', 'input: "${kv.saved}"')));
        try {
            const original = h.store.enterNode.bind(h.store);
            let calls = 0;
            h.store.enterNode = async input => {
                if (calls++ === 0) await h.setKv(9);
                return original(input);
            };
            const entered = await h.enter();
            expect(calls).toBe(2);
            expect(entered).toMatchObject({ input: 9, carrySnapshot: { loop: 7, saved: 9 }, kvRevision: 2 });
        } finally { await h.stop(); }
    });

    it("same-basis duplicate admissions cannot alter carry; a newer evaluation loses to the committed row", { timeout: TIMEOUT }, async () => {
        const h = await fixture();
        try {
            const entered = await h.enter();
            const duplicate = { runId: h.runId, nodeExecutionId: entered.nodeExecutionId, scopeId: "root", nodeId: "work", ordinal: 1,
                nodeType: "script", predecessorId: null, arrivalRoute: null, inputText: canonicalJson(entered.input), kvRevision: 1,
                carryText: '{"loop":8,"saved":1}', waitSeconds: null, immediate: null };
            await expect(h.store.enterNode(duplicate)).rejects.toMatchObject({ code: "NONDETERMINISTIC_ADMISSION" });
            const newer = await h.store.enterNode({ ...duplicate, kvRevision: 2 });
            expect(newer).toMatchObject({ inserted: false, node: { carrySnapshot: { loop: 7, saved: 1 } } });
        } finally { await h.stop(); }
    });

    it.each(["1.0.0", null])("a legacy %s run ignores declared carry, writes NULL, and routes raw errors", { timeout: TIMEOUT }, async version => {
        const h = await fixture(yamlOf(), { version });
        try {
            const entered = await h.enter();
            expect(entered.carrySnapshot).toBeNull();
            const error = { code: "execution_failed", message: "legacy", details: null };
            await h.finish(entered, error, "execution_failed", "runtime_error");
            expect((await h.enter("next", entered.nodeExecutionId, "failure")).input).toEqual(error);
        } finally { await h.stop(); }
    });

    it.each([
        ["missing carry binding", script.replace('${input.loop}', '${input.missing}'), null],
        ["input mapping failure", script.replace('${input.payload}', '${input.missing}'), { loop: 7, saved: 1 }],
        ["input schema failure", `${script}\n    inputSchema: { type: integer }`, { loop: 7, saved: 1 }],
    ])("%s runs no effect and preserves only a successfully selected carry", { timeout: TIMEOUT }, async (_label, work, carry) => {
        const h = await fixture(yamlOf(work));
        try {
            const entered = await h.enter();
            expect(entered).toMatchObject({ state: "completed", outcome: "invalid_input", effectAttempts: 0, carrySnapshot: carry });
            const next = await h.enter("next", entered.nodeExecutionId, "failure");
            expect(next.input).toEqual({ carry, result: entered.error });
        } finally { await h.stop(); }
    });

    it("a state without carry retains its raw result shape at 1.1.0", { timeout: TIMEOUT }, async () => {
        const h = await fixture(yamlOf(script.replace(/    carry:.*\n/, "")));
        try {
            const entered = await h.enter();
            await h.finish(entered, { ordinary: true });
            expect((await h.enter("next", entered.nodeExecutionId, "ok")).input).toEqual({ ordinary: true });
        } finally { await h.stop(); }
    });

    it("the successor schema sees the wrapper, but input mapping can select its raw result", { timeout: TIMEOUT }, async () => {
        for (const mapped of [false, true]) {
            const h = await fixture(yamlOf(script, '    inputSchema: { type: integer }\n' + (mapped ? '    input: "${input.result}"' : "")));
            try {
                const entered = await h.enter();
                await h.finish(entered, 42);
                const next = await h.enter("next", entered.nodeExecutionId, "ok");
                expect(next.state).toBe(mapped ? "pending" : "completed");
                if (mapped) expect(next.input).toBe(42);
                else expect(next.outcome).toBe("invalid_input");
            } finally { await h.stop(); }
        }
    });

    it.each(ROUTE_STATES)("%s routes its ordinary result inside carry without changing the effect input", { timeout: TIMEOUT }, async (_kind, outcome, fields, output) => {
        const work = `${fields}\n    carry: { loop: "\${input.loop}" }\n    input: "\${input.payload}"\n`
            + `    transition: { next: { ${outcome}: next, ${_kind === "request" ? "declined: next," : ""} ${_kind === "receive" ? "elapsed: next," : ""} failure: next } }`;
        const root = "contracts:\n  Test@1:\n    schema: { type: object }\n    response: { schema: { type: object } }";
        const h = await fixture(yamlOf(work, "", root));
        try {
            const entered = await h.enter();
            expect(entered.state).toBe("pending");
            expect(entered.input).toEqual({ q: "hi" });
            await h.finish(entered, output, outcome);
            expect((await h.enter("next", entered.nodeExecutionId, outcome)).input).toEqual({ carry: { loop: 7 }, result: output });
            if (_kind === "send" || _kind === "request") {
                const rows = await h.q("SELECT payload FROM SCHEMA.workflow_outbox WHERE node_execution_id = $1", [entered.nodeExecutionId]);
                expect(rows.map(row => JSON.parse(row.payload))).toEqual([{ q: "hi" }]);
            }
        } finally { await h.stop(); }
    });

    it.each([
        ["send", "delivery_failed", "runtime_error", { code: "delivery_failed", message: "Acceptance is unknown." }],
        ["request", "declined", "business", { reason: "Not approved." }],
        ["request", "timed_out", "runtime_error", { code: "timed_out", message: "No response." }],
        ["agent", "execution_failed", "runtime_error", { code: "execution_failed", message: "Visit failed." }],
    ])("%s preserves carry for %s", { timeout: TIMEOUT }, async (kind, outcome, resultKind, output) => {
        const [, ordinary, fields] = ROUTE_STATES.find(row => row[0] === kind);
        const work = `${fields}\n    carry: { loop: "\${input.loop}" }\n    input: "\${input.payload}"\n`
            + `    transition: { next: { ${ordinary}: next, ${kind === "request" ? "declined: next," : ""} failure: next } }`;
        const root = "contracts:\n  Test@1:\n    schema: { type: object }\n    response: { schema: { type: object } }";
        const h = await fixture(yamlOf(work, "", root));
        try {
            const entered = await h.enter();
            await h.finish(entered, output, outcome, resultKind);
            const route = resultKind === "runtime_error" ? "failure" : outcome;
            expect((await h.enter("next", entered.nodeExecutionId, route)).input).toEqual({ carry: { loop: 7 }, result: output });
        } finally { await h.stop(); }
    });

    it("a same-basis duplicate retains canonical NUL and lone-surrogate carry", { timeout: TIMEOUT }, async () => {
        const saved = JSON.parse('{"text":"\\u0000\\ud800","__proto__":{"kept":true}}');
        const h = await fixture(yamlOf(script.replace('carry: { loop: "${input.loop}", saved: "${kv.saved}" }',
            'carry: { saved: "${input.loop}" }')), { inputs: { loop: saved, payload: {} } });
        try {
            const entered = await h.enter();
            expect(entered.carrySnapshot).toEqual({ saved });
            expect(await h.enter()).toEqual(entered);
            const duplicate = await h.store.enterNode({
                runId: h.runId, nodeExecutionId: entered.nodeExecutionId, scopeId: "root", nodeId: "work", ordinal: 1,
                nodeType: "script", predecessorId: null, arrivalRoute: null, inputText: canonicalJson(entered.input), kvRevision: 1,
                carryText: canonicalJson({ saved }), waitSeconds: null, immediate: null,
            });
            expect(duplicate).toMatchObject({ inserted: false, node: { carrySnapshot: { saved } } });
        } finally { await h.stop(); }
    });
});

describe("carry bounds and JSON fidelity", () => {
    it("64 KiB carry and 256 KiB combined boundaries are exact; NUL, surrogate and prototype keys are lossless", () => {
        const value = JSON.parse('{"text":"\\u0000\\ud800","__proto__":{"kept":true}}');
        expect(readCarrySnapshot(carrySnapshotText(value))).toEqual(value);
        const exact = { text: "x".repeat(65_536 - 11) };
        expect(Buffer.byteLength(carrySnapshotText(exact))).toBe(65_536);
        expect(() => carrySnapshotText({ text: `${exact.text}x` })).toThrow(/limit is 65536/);
        const result = "x".repeat(262_144 - Buffer.byteLength(canonicalJson({ carry: {}, result: "" })));
        expect(Buffer.byteLength(canonicalJson(carryArrival({}, result)))).toBe(262_144);
        expect(() => carryArrival({}, `${result}x`)).toThrow(/limit is 262144/);
    });

    it("oversize carry fails its own state; an oversize wrapper fails the receiver before input mapping", { timeout: TIMEOUT }, async () => {
        const h = await fixture(yamlOf(script.replace('{ loop: "${input.loop}", saved: "${kv.saved}" }', '{ text: "${input.text}" }')),
            { inputs: { text: "x".repeat(65_537), payload: {} } });
        try {
            expect(await h.enter()).toMatchObject({ state: "completed", outcome: "invalid_input", carrySnapshot: null, effectAttempts: 0 });
        } finally { await h.stop(); }
        const large = await fixture(yamlOf(script, '    input: "${input.result}"'));
        try {
            const entered = await large.enter();
            await large.finish(entered, "x".repeat(262_142));
            expect(await large.enter("next", entered.nodeExecutionId, "ok")).toMatchObject({ state: "completed", outcome: "invalid_input", effectAttempts: 0 });
        } finally { await large.stop(); }
    });

    it("canonical text survives real database storage without JSONB replacement", { timeout: TIMEOUT }, async () => {
        const value = { loop: "\u0000\ud800", payload: {} };
        const h = await fixture(yamlOf(), { inputs: value });
        try {
            const entered = await h.enter();
            expect(entered.carrySnapshot.loop).toBe(value.loop);
            await h.finish(entered, null);
            expect((await h.enter("next", entered.nodeExecutionId, "ok")).input.carry.loop).toBe(value.loop);
        } finally { await h.stop(); }
    });
});

describe("parallel carry", () => {
    const parallel = `
    type: parallel
    carry: { outer: "\${input.loop}" }
    forEach: [10, 20]
    body:
      initial: branch
      states:
        branch:
          type: script
          carry: { item: "\${branch.item}", index: "\${branch.index}" }
          source: await setResult("ok", {});
          transition: { next: { ok: end, failure: end } }
        end: { type: terminal, outcome: succeeded, output: "\${input}" }
    transition: { next: { joined: next, blocked: next, failure: next } }`;

    it("outer carry does not enter branch manifests; each branch freezes its own snapshot, and late results cannot overwrite it", { timeout: TIMEOUT }, async () => {
        const h = await fixture(yamlOf(parallel));
        try {
            const outer = await h.enter();
            expect(outer.input).toEqual([10, 20]);
            const leftScope = branchScopeId(outer.nodeExecutionId, 0);
            const rightScope = branchScopeId(outer.nodeExecutionId, 1);
            const left = await h.enter("branch", outer.nodeExecutionId, BRANCH_ROUTE, { scopeId: leftScope });
            const right = await h.enter("branch", outer.nodeExecutionId, BRANCH_ROUTE, { scopeId: rightScope });
            expect(left).toMatchObject({ input: 10, carrySnapshot: { item: 10, index: 0 } });
            expect(right).toMatchObject({ input: 20, carrySnapshot: { item: 20, index: 1 } });
            await h.finish(left, "left");
            expect((await h.enter("end", left.nodeExecutionId, "ok", { scopeId: leftScope })).input)
                .toEqual({ carry: { item: 10, index: 0 }, result: "left" });
            await h.store.cancelBranchScopes({ runId: h.runId, scopeIds: [rightScope] });
            await expect(h.enter("end", right.nodeExecutionId, "ok", { scopeId: leftScope, ordinal: 2 })).rejects.toMatchObject({
                code: "NONDETERMINISTIC_ADMISSION", message: expect.stringContaining(`not a state of branch ${leftScope}`),
            });
            expect((await h.finish(right, "late")).won).toBe(false);
            expect((await h.store.readNodeExecution(right.nodeExecutionId)).carrySnapshot).toEqual({ item: 20, index: 1 });
            await h.finish(outer, ["left"], "joined");
            expect((await h.enter("next", outer.nodeExecutionId, "joined")).input).toEqual({ carry: { outer: 7 }, result: ["left"] });
        } finally { await h.stop(); }
    });

    it("an empty manifest still preserves the outer snapshot", { timeout: TIMEOUT }, async () => {
        const h = await fixture(yamlOf(parallel.replace("[10, 20]", "[]")));
        try {
            const outer = await h.enter();
            expect(outer.input).toEqual([]);
            await h.finish(outer, [], "joined");
            expect((await h.enter("next", outer.nodeExecutionId, "joined")).input).toEqual({ carry: { outer: 7 }, result: [] });
        } finally { await h.stop(); }
    });
});
