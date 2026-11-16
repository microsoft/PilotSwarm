/**
 * The stage 2.1 code check's gap G2 (formal code check of 1d95d406), on PostgreSQL: an exact spawn_workflow repeat (the
 * same key and YAML) is answered from its save's receipt, also after a crash between the save and the start: the repeat
 * starts the revision that save made and saves no other; for a first save and for a later one.
 * No model, no controller: a started run stays admitted (a recording duroxide client stands in for the dispatch).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { spawnWorkflowCompatFromTool } from "../../src/workflow/definition-tool.ts";
import { sha256Hex } from "../../src/workflow/json.ts";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "owner-pinned" };

const YAML = (name, seconds) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: ${seconds}, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

const recordingClient = () => ({ startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} });

describe("G2: an exact spawn_workflow repeat is answered from its save's receipt", () => {
    it("after a crash between the save and the start, the repeat starts the revision that save made, for a first save and a later one", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = { catalog: h.catalog, store: h.store, duroxideClient: recordingClient() };
            const session = randomUUID();
            await h.catalog.createSession(session, { owner: OWNER });
            // The worker "crashes" in the start, after the save committed: the Workflow's definition is never stored.
            let crashes = 0;
            const crashing = Object.create(h.store);
            crashing.createDefinition = async () => { crashes += 1; throw new Error("the worker stopped"); };
            const spawn = (yaml, key, onHost = host) => spawnWorkflowCompatFromTool({ yaml, key, state: "published", start: true },
                { callerSessionId: session, operationId: `spawn:key:${key}:${sha256Hex(yaml).slice(0, 32)}`, owner: async () => null, binding: async () => null,
                    host: onHost }).then(text => JSON.parse(text));
            const workflowsOf = async definitionId => (await h.store.sessionDefinitions.listWorkflows({ definitionId })).map(item => item.revision);

            // A first save (no guard): saved, then the crash.
            const first = await spawn(YAML("repeat-me", 10), "k1", { ...host, store: crashing });
            expect(first).toMatchObject({ ok: false });
            expect(crashes).toBe(1);
            const definition = await h.store.sessionDefinitions.readDefinitionByName(session, "repeat-me");
            expect(definition.currentRevision).toBe(1);
            expect(await workflowsOf(definition.definitionId)).toEqual([]);
            // The repeat: no OPERATION_CONFLICT, no second revision; it starts revision 1.
            const repeated = await spawn(YAML("repeat-me", 10), "k1");
            expect(repeated, JSON.stringify(repeated)).toMatchObject({ ok: true, operation: "save_and_start", revision: 1, definitionId: definition.definitionId });
            expect((await h.store.sessionDefinitions.readDefinitionByName(session, "repeat-me")).currentRevision).toBe(1);
            expect(await workflowsOf(definition.definitionId)).toEqual([1]);
            // A third time: the same Workflow, from both receipts.
            expect(await spawn(YAML("repeat-me", 10), "k1")).toMatchObject({ ok: true, replayed: true, revision: 1, workflowId: repeated.workflowId });

            // A later save (guarded by revision 1, which the session has seen): saved as revision 2, then the crash; the repeat
            // starts revision 2 and saves no revision 3.
            const later = await spawn(YAML("repeat-me", 20), "k2", { ...host, store: crashing });
            expect(later).toMatchObject({ ok: false });
            expect(crashes).toBe(2);
            expect((await h.store.sessionDefinitions.readDefinitionByName(session, "repeat-me")).currentRevision).toBe(2);
            const second = await spawn(YAML("repeat-me", 20), "k2");
            expect(second, JSON.stringify(second)).toMatchObject({ ok: true, revision: 2 });
            expect((await h.store.sessionDefinitions.readDefinitionByName(session, "repeat-me")).currentRevision).toBe(2);
            expect((await workflowsOf(definition.definitionId)).sort()).toEqual([1, 2]);
            expect((await h.store.readRevision(second.workflowId, 1)).yaml).toBe(YAML("repeat-me", 20));

            // The guard still applies to a first execution: a person's save the session has not seen refuses a new key.
            await h.store.sessionDefinitions.save({ ownerSessionId: session, name: "repeat-me", yaml: YAML("repeat-me", 30),
                compiled: (await import("../../src/workflow/compiler.ts")).compileWorkflow(YAML("repeat-me", 30)),
                expected: { definitionId: definition.definitionId, revision: 2 }, actor: { kind: "user", provider: "test", subject: "ada" },
                operationId: "person-save", requestSha256: "person-save", seenBySession: false, noteBy: "Ada Lovelace" });
            expect(await spawn(YAML("repeat-me", 40), "k3")).toMatchObject({ ok: false, error: { code: "REVISION_STALE" } });
        } finally {
            await h.stop();
        }
    });
});
