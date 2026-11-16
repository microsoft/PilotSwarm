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
 * Run: npx vitest run test/local/canvas-kv-agent-step-filter.test.js
 */

import { describe, it } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assertEqual } from "../helpers/assertions.js";
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
});
