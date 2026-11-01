/**
 * Workflow v2 admission at the session-row creation boundary, on real
 * PostgreSQL through the production entry points: createWorkflowV2 and the
 * catalog's createSession call that legacy workflows and agent sessions use.
 *
 * A v2 creation claims the session row exclusively. It never changes a row
 * another creator made (legacy workflow, agent session, a different v2
 * request), whether that row existed first or was inserted concurrently.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "workflow-v2-admission" };
const ACTOR = { kind: "agent", sessionId: "parent" };

const DRAFT = (name) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: step
states:
  step:
    type: script
    source: |
      await setResult("ok", {});
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded }
`;

/** Drafts start no run, so these tests need no durable runtime; a dispatch would be a defect. */
const NO_DISPATCH = {
    startOrchestrationVersioned: async () => { throw new Error("A draft creation must not dispatch a run."); },
};

async function harness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const parentId = randomUUID();
    await catalog.createSession(parentId, { owner: OWNER });
    return { catalog, store, parentId, host: { catalog, store, duroxideClient: NO_DISPATCH } };
}

/** The exact catalog call the legacy createWorkflowSession makes for a new admission. */
function legacyCreate(h, id) {
    return h.catalog.createSession(id, {
        sessionKind: "workflow",
        parentSessionId: h.parentId,
        owner: OWNER,
        creationConfig: {
            workflowToolBinding: { policy: "node-parent-tools-v1", parentSessionId: h.parentId },
            workflowAdmission: { policy: "node-parent-tools-v1", workflowName: "legacy", input: { sessionId: id } },
        },
    });
}

function v2Create(h, id, name = "v2", operationId = "create") {
    return createWorkflowV2(h.host, {
        workflowSessionId: id, parentSessionId: h.parentId, owner: OWNER, yaml: DRAFT(name),
        actor: ACTOR, operationId,
    });
}

async function snapshot(h, id) {
    const [row, creation, definition] = await Promise.all([
        h.catalog.getSession(id), h.catalog.getSessionCreationConfig(id), h.store.readDefinition(id),
    ]);
    return {
        kind: row?.sessionKind ?? null, title: row?.title ?? null, parent: row?.parentSessionId ?? null,
        creation, definition: definition ? { state: definition.state, revision: definition.currentRevision } : null,
    };
}

describe("workflow v2 admission at the session creation boundary", () => {
    it("refuses an existing legacy workflow or agent session and leaves it unchanged", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const legacyId = randomUUID();
            await legacyCreate(h, legacyId);
            const legacyBefore = await snapshot(h, legacyId);
            await expect(v2Create(h, legacyId)).rejects.toMatchObject({ code: "SESSION_EXISTS" });
            expect(await snapshot(h, legacyId)).toEqual(legacyBefore);
            expect(legacyBefore.definition).toBeNull();

            const agentId = randomUUID();
            await h.catalog.createSession(agentId, { parentSessionId: h.parentId, owner: OWNER, creationConfig: { systemMessage: "agent" } });
            const agentBefore = await snapshot(h, agentId);
            await expect(v2Create(h, agentId)).rejects.toMatchObject({ code: "SESSION_EXISTS" });
            const agentAfter = await snapshot(h, agentId);
            expect(agentAfter).toEqual(agentBefore);
            expect(agentAfter.kind).toBe("agent");
            expect(agentAfter.creation).toEqual({ systemMessage: "agent" });

            // A v2 workflow of another parent, or the same parent's workflow created for another owner, is not ours.
            const otherParent = randomUUID();
            await h.catalog.createSession(otherParent, { owner: OWNER });
            const foreignId = randomUUID();
            await createWorkflowV2(h.host, { workflowSessionId: foreignId, parentSessionId: otherParent, owner: OWNER,
                yaml: DRAFT("foreign"), actor: ACTOR, operationId: "create" });
            const foreignBefore = await snapshot(h, foreignId);
            await expect(v2Create(h, foreignId)).rejects.toMatchObject({ code: "SESSION_EXISTS" });
            await expect(createWorkflowV2(h.host, { workflowSessionId: foreignId, parentSessionId: otherParent,
                owner: { provider: "test", subject: "someone-else" }, yaml: DRAFT("foreign"), actor: ACTOR, operationId: "create" }))
                .rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect(await snapshot(h, foreignId)).toEqual(foreignBefore);

            const legacyAfterV2 = randomUUID();
            await v2Create(h, legacyAfterV2);
            const v2Before = await snapshot(h, legacyAfterV2);
            await legacyCreate(h, legacyAfterV2);
            expect(await snapshot(h, legacyAfterV2)).toEqual(v2Before);
            expect(v2Before.creation.workflowAdmission).toBeUndefined();
        } finally { await h.catalog.close(); }
    });

    it("lets exactly one of concurrent legacy and v2 creators own each id, with no mixed state", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const outcomes = { legacy: 0, v2: 0 };
            for (let round = 0; round < 16; round += 1) {
                const id = randomUUID();
                // Alternate which creator starts first; both run concurrently.
                let legacyCall, v2Call;
                if (round % 2 === 0) { legacyCall = legacyCreate(h, id); v2Call = v2Create(h, id); }
                else { v2Call = v2Create(h, id); legacyCall = legacyCreate(h, id); }
                const [legacy, v2] = await Promise.allSettled([legacyCall, v2Call]);
                const state = await snapshot(h, id);
                expect(state.kind).toBe("workflow");
                const isV2 = Boolean(state.creation.workflowV2);
                const isLegacy = Boolean(state.creation.workflowAdmission);
                expect(isV2 !== isLegacy, JSON.stringify(state)).toBe(true);
                expect(legacy.status, String(legacy.reason)).toBe("fulfilled");
                if (isV2) {
                    outcomes.v2 += 1;
                    expect(v2.status).toBe("fulfilled");
                    expect(state.definition).toEqual({ state: "draft", revision: 1 });
                    expect(state.title).toBe("Workflow: v2");
                } else {
                    outcomes.legacy += 1;
                    expect(v2.status).toBe("rejected");
                    expect(v2.reason.code).toBe("SESSION_EXISTS");
                    expect(state.definition).toBeNull();
                    expect(state.creation.workflowToolBinding.parentSessionId).toBe(h.parentId);
                }
            }
            expect(outcomes.legacy + outcomes.v2).toBe(16);
        } finally { await h.catalog.close(); }
    });

    it("lets one of two different concurrent v2 requests win an id; the other changes nothing", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            for (let round = 0; round < 10; round += 1) {
                const id = randomUUID();
                const results = await Promise.allSettled([v2Create(h, id, "first", "op-a"), v2Create(h, id, "second", "op-b")]);
                const won = results.filter(result => result.status === "fulfilled");
                const lost = results.filter(result => result.status === "rejected");
                expect(won, JSON.stringify(lost.map(result => result.reason?.message))).toHaveLength(1);
                expect(lost[0].reason.code).toBe("WORKFLOW_EXISTS");
                const state = await snapshot(h, id);
                const winner = won[0].value.receipt;
                const revision = await h.store.readRevision(id, 1);
                expect(revision.yamlSha256).toBe(winner.yamlSha256);
                // The row's claim, its definition and its title all belong to the same request.
                expect(state.creation.workflowV2.operationId).toBe(revision.name === "first" ? "op-a" : "op-b");
                expect(state.title).toBe(`Workflow: ${revision.name}`);
            }
        } finally { await h.catalog.close(); }
    });

    it("returns one receipt to concurrent identical retries", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            for (let round = 0; round < 10; round += 1) {
                const id = randomUUID();
                const results = await Promise.allSettled([v2Create(h, id), v2Create(h, id)]);
                expect(results.map(result => result.status), JSON.stringify(results.map(result => result.reason?.message))).toEqual(["fulfilled", "fulfilled"]);
                const [a, b] = results.map(result => result.value);
                expect(a.receipt).toEqual(b.receipt);
                expect([a.replayed, b.replayed].filter(Boolean)).toHaveLength(1);
                expect((await snapshot(h, id)).definition).toEqual({ state: "draft", revision: 1 });
            }
        } finally { await h.catalog.close(); }
    });
});
