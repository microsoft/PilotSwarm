/**
 * D9 against a real Postgres: an agent session inside a Workflow agent
 * step's subtree reads, through canvas_kv get and list, only the parent's KV
 * rows an agent wrote.
 *
 * P (agent, owned by Alice) started Workflow W; S is W's agent step child.
 * Slot 1 of P holds one row each by Alice, by P itself (an agent) and by a
 * share link. The lineage comes from a Proxy over the real catalog whose
 * workflowStore() answers as the test says: an agent step, outside every
 * agent step, or a read that throws (an explicit lineage error, not an
 * empty result).
 *
 * The second test uses the real lineage: W has an agent state admitted with
 * child S, as the Workflow controller admits one, and C is S's own child
 * (agentRoot distance 1). From S and from C, a list paged one row at a time
 * never names a hidden row's key and still reaches every agent row, and
 * read_canvas with includeData returns only what an agent drew and ticked.
 *
 * Run: npx vitest run test/local/canvas-kv-agent-step-filter.test.js
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assertEqual } from "../helpers/assertions.js";
import { FilesystemArtifactStore } from "../../src/index.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { WORKFLOW_CONTROLLER_VERSION, workflowLiveControllerInstanceId } from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { writeCanvasKv } from "../../dist/canvas-kv.js";
import { createCanvasOperations } from "../../dist/canvas-operations.js";

const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

const ALICE = { provider: "test", subject: "kvf-alice", email: "alice@test", displayName: "Alice" };
const alice = { kind: "user", provider: ALICE.provider, subject: ALICE.subject, isAdmin: false, label: ALICE.displayName };

const keys = (result) => result.entries.map((e) => e.key).join(",");

describe("canvas KV: agent steps do not read rows a person typed", () => {
    it("an agent step sees only agent rows; outside it every row; a failed lineage read an error", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const P = randomUUID();
            const W = randomUUID();
            const S = randomUUID();
            await catalog.createSession(P, { model: "m", owner: ALICE });
            assertEqual((await catalog.createWorkflowSession(W, {
                parentSessionId: P, owner: null, creationConfig: { workflow: { requestSha256: "kv-agent-step-filter" } },
            })).created, true);
            await catalog.createSession(S, { model: "m", parentSessionId: W });
            assertEqual((await catalog.getSession(W)).sessionKind, "workflow");
            assertEqual((await catalog.getSession(S)).parentSessionId, W);

            // Three writers on P slot 1. The link writes under policy "link"
            // with an app that admits viewers; the policy goes back to owner after.
            let out = await writeCanvasKv(catalog, P, 1, alice, [{ op: "put", key: "ui/a", value: { typed: "by a person" } }]);
            assertEqual(out.results[0].ok, true, JSON.stringify(out.results));
            out = await writeCanvasKv(catalog, P, 1, { kind: "agent", sessionId: P }, [{ op: "put", key: "app/b", value: { n: 1 } }]);
            assertEqual(out.results[0].ok, true, JSON.stringify(out.results));
            await catalog.setCanvasKvAccess(P, 1, "link");
            await catalog.setCanvasKvManifest(P, 1, { write: "viewers", shared: [] });
            out = await writeCanvasKv(catalog, P, 1, { kind: "link", writerId: "link-w1", label: "a link", writeEnabled: true },
                [{ op: "put", key: "app/c", value: { typed: "by a link" } }]);
            assertEqual(out.results[0].ok, true, JSON.stringify(out.results));
            await catalog.setCanvasKvAccess(P, 1, "owner");
            const kinds = (await catalog.canvasKvList(P, 1, null, 10, null)).map((r) => `${r.key}:${r.value.by.kind}`).join(",");
            assertEqual(kinds, "app/b:agent,app/c:link,ui/a:user");

            let lineage = "agent-step";
            const fakeStore = {
                readWorkflowLineage: async (sessionId) => {
                    assertEqual(sessionId, S, "the reader's own lineage is read");
                    if (lineage === "throws") throw new Error("lineage read failed");
                    return {
                        sessionId: S, level: 2,
                        agentRoot: lineage === "agent-step"
                            ? { childSessionId: S, nodeExecutionId: "n", workflowSessionId: W, controllingSessionId: P, distance: 0 }
                            : null,
                    };
                },
            };
            const proxied = new Proxy(catalog, {
                get(target, prop) {
                    if (prop === "workflowStore") return () => fakeStore;
                    const value = Reflect.get(target, prop, target);
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
            const deps = (c) => ({
                catalog: c, artifactStore: null, factStore: null, writerSessionId: S, workerNodeId: undefined, agentIdentity: null, mode: "agent",
            });
            const kv = createCanvasOperations(deps(proxied)).canvasKv;

            // In an agent step: only the agent's row.
            assertEqual(keys(await kv({ op: "list", session_id: P })), "app/b");
            assertEqual(JSON.stringify(await kv({ op: "get", key: "ui/a", session_id: P })), JSON.stringify({ found: false, key: "ui/a" }));
            assertEqual(JSON.stringify(await kv({ op: "get", key: "app/c", session_id: P })), JSON.stringify({ found: false, key: "app/c" }));
            assertEqual((await kv({ op: "get", key: "app/b", session_id: P })).found, true);
            // "parent" from the step reaches P, with the same filter.
            assertEqual(keys(await kv({ op: "list", session_id: "parent" })), "app/b");

            // Outside every agent step (agentRoot null): all three.
            lineage = "outside";
            assertEqual(keys(await kv({ op: "list", session_id: P })), "app/b,app/c,ui/a");
            assertEqual((await kv({ op: "get", key: "ui/a", session_id: P })).v.typed, "by a person");

            // A lineage read that throws: an explicit error, no row, and never an empty result.
            lineage = "throws";
            const failed = JSON.stringify({ error: "could not verify the session lineage: lineage read failed" });
            assertEqual(JSON.stringify(await kv({ op: "list", session_id: P })), failed);
            assertEqual(JSON.stringify(await kv({ op: "get", key: "app/b", session_id: P })), failed);

            // The real workflow store: S has no agent invocation recorded, so it is outside every agent step.
            const real = createCanvasOperations(deps(catalog)).canvasKv;
            assertEqual(keys(await real({ op: "list", session_id: P })), "app/b,app/c,ui/a");
        } finally {
            await catalog.close?.();
        }
    });

    it("real agent-step lineage, distance 0 and 1: list cursors never name a hidden row; read_canvas includeData returns only agent data", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "kvf-artifacts-"));
        try {
            const artifactStore = new FilesystemArtifactStore(artifactDir);
            const P = randomUUID();
            const S = randomUUID();
            const C = randomUUID();
            await catalog.createSession(P, { model: "m", owner: ALICE });
            const { workflowSessionId: W, nodeExecutionId } = await agentStateOf(catalog, P, S);
            await catalog.createSession(S, { model: "m", parentSessionId: W });
            await catalog.createSession(C, { model: "m", parentSessionId: S });
            const root = { childSessionId: S, nodeExecutionId, workflowSessionId: W, controllingSessionId: P };
            expect((await catalog.workflowStore().readWorkflowLineage(S)).agentRoot).toEqual({ ...root, distance: 0 });
            expect((await catalog.workflowStore().readWorkflowLineage(C)).agentRoot).toEqual({ ...root, distance: 1 });

            const opsFor = (writerSessionId) => createCanvasOperations({
                catalog, artifactStore, factStore: null, writerSessionId, workerNodeId: undefined, agentIdentity: null, mode: "agent",
            });
            // P draws slot 1 and ticks it: the only data the plane holds.
            const drawn = await opsFor(P).drawCanvas({ html: "<html><body>the agent's page</body></html>" });
            expect(drawn.error).toBeUndefined();
            const ticked = await opsFor(P).updateCanvas({ data: { status: "ticked by P" } });
            expect(ticked.error).toBeUndefined();

            // KV rows on P slot 1, in key order: app/b (agent), app/c (link),
            // old/e (legacy, no writer), ui/a (Alice), zz/d (agent).
            const SECRETS = ["typed by a person", "typed by a link", "typed before writers"];
            let out = await writeCanvasKv(catalog, P, 1, alice, [{ op: "put", key: "ui/a", value: { typed: SECRETS[0] } }]);
            assertEqual(out.results[0].ok, true, JSON.stringify(out.results));
            out = await writeCanvasKv(catalog, P, 1, { kind: "agent", sessionId: P }, [
                { op: "put", key: "app/b", value: { n: 1 } }, { op: "put", key: "zz/d", value: { n: 2 } }]);
            assertEqual(out.results.every((r) => r.ok), true, JSON.stringify(out.results));
            await catalog.setCanvasKvAccess(P, 1, "link");
            await catalog.setCanvasKvManifest(P, 1, { write: "viewers", shared: [] });
            out = await writeCanvasKv(catalog, P, 1, { kind: "link", writerId: "link-w2", label: "a link", writeEnabled: true },
                [{ op: "put", key: "app/c", value: { typed: SECRETS[1] } }]);
            assertEqual(out.results[0].ok, true, JSON.stringify(out.results));
            await catalog.setCanvasKvAccess(P, 1, "owner");
            const legacy = await catalog.canvasKvWrite(P, 1, "old/e", { v: { typed: SECRETS[2] } }, null,
                { maxKeys: 1000, maxBytes: 2 * 1024 * 1024, maxValueBytes: 16 * 1024 });
            assertEqual(legacy.status, "written");
            const kinds = (await catalog.canvasKvList(P, 1, null, 10, null)).map((r) => `${r.key}:${r.value.by?.kind ?? "none"}`).join(",");
            assertEqual(kinds, "app/b:agent,app/c:link,old/e:none,ui/a:user,zz/d:agent");

            const HIDDEN = ["ui/a", "app/c", "old/e"];
            const assertNoPersonInput = (result, what) => {
                const text = JSON.stringify(result);
                for (const secret of SECRETS) expect(text, `${what} carries "${secret}"`).not.toContain(secret);
                for (const key of HIDDEN) expect(text, `${what} names the hidden key ${key}`).not.toContain(JSON.stringify(key));
            };

            for (const reader of [S, C]) {
                const ops = opsFor(reader);
                for (const target of [P, "parent"]) {
                    const what = `reader ${reader === S ? "S" : "C"}, target ${target === P ? "P" : "parent"}`;
                    // read_canvas with includeData: the agent's page and the agent's tick, nothing a person typed.
                    const doc = await ops.readCanvas({ session_id: target, includeData: true });
                    expect(doc.exists, what).toBe(true);
                    expect(doc.content).toContain("the agent's page");
                    expect(doc.live.data).toEqual({ status: "ticked by P" });
                    expect(doc.live.updatedBy).toBe(P);
                    assertNoPersonInput(doc, `${what}: read_canvas`);
                    const card = await ops.readCanvas({ session_id: target, includeData: true, manifestOnly: true });
                    expect(card.exists, what).toBe(true);
                    expect(card.live.updatedBy).toBe(P);
                    assertNoPersonInput(card, `${what}: read_canvas manifestOnly`);

                    // canvas_kv list, one row per page: every agent row, and no cursor that names a hidden row.
                    const pages = [];
                    let after;
                    do {
                        const page = await ops.canvasKv({ op: "list", limit: 1, session_id: target, ...(after ? { after } : {}) });
                        expect(page.error, what).toBeUndefined();
                        pages.push(page);
                        after = page.nextAfter;
                        expect(pages.length, `${what}: the cursor ends`).toBeLessThan(10);
                    } while (after);
                    expect(pages.map((p) => p.entries.map((e) => e.key)), what).toEqual([["app/b"], ["zz/d"]]);
                    expect(pages.map((p) => p.nextAfter), what).toEqual(["app/b", undefined]);
                    for (const page of pages) assertNoPersonInput(page, `${what}: list page`);
                    for (const key of HIDDEN) {
                        expect(await ops.canvasKv({ op: "get", key, session_id: target }), what).toEqual({ found: false, key });
                    }
                }
            }
            // Outside the agent step (P itself) every row shows, with its value.
            expect(keys(await opsFor(P).canvasKv({ op: "list" }))).toBe("app/b,app/c,old/e,ui/a,zz/d");
        } finally {
            await catalog.close?.();
            fs.rmSync(artifactDir, { recursive: true, force: true });
        }
    });
});

const ACTOR = { kind: "system", name: "canvas-kv-agent-step-filter-test" };
const AGENT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: kv-reader, version: "1.0.0" }
initial: review
schemas:
  ReviewResult: { type: object, required: [verdict], properties: { verdict: { type: string } }, additionalProperties: false }
states:
  review:
    type: agent
    invoke: { prompt: "Review it." }
    outputSchema: { $ref: "#/schemas/ReviewResult" }
    timeoutSeconds: 3600
    transition: { next: { accepted: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

/**
 * A live Workflow of `parent` whose agent state is admitted pending with
 * child `childSessionId`: its invocation record, as the Workflow controller
 * admits one (the fixture of workflow-input-policy.test.js).
 */
async function agentStateOf(catalog, parent, childSessionId) {
    const store = catalog.workflowStore();
    const compiled = compileWorkflow(AGENT_YAML);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    expect(await catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner: null,
        creationConfig: { workflow: { requestSha256: "kv-agent-step-filter" } } })).toEqual({ created: true });
    await store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: AGENT_YAML, compiled, actor: ACTOR,
        operationId: "create", requestSha256: "kv-agent-step-filter", publish: true, title: "Workflow: kv-reader",
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
            inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION },
    });
    const nodeExecutionId = nodeExecutionIdFor(runId, "root", "review", 1);
    expect(await store.enterNode({
        runId, nodeExecutionId, scopeId: "root", nodeId: "review", ordinal: 1, nodeType: "agent", predecessorId: null, arrivalRoute: null,
        inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
        agent: { childSessionId, controllingSessionId: parent, task: { source: "prompt", prompt: "Review it." }, outcomes: ["accepted"],
            outputSchema: "ReviewResult", timeoutSeconds: 3600 },
    })).toMatchObject({ admitted: true, inserted: true });
    return { workflowSessionId, nodeExecutionId };
}
