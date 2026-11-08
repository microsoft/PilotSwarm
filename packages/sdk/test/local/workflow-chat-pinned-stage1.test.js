/**
 * The stage 2.1 code check's two gaps (formal code check of 1d95d406), on PostgreSQL:
 * - G1: a stage 1 Workflow migration 0107 pinned to a chat revision (one that never ran: a draft, or published and never
 *   started) takes none of the stage 1 definition operations, on the chat's update_workflow and on a person's command
 *   (PINNED_TO_CHAT_REVISION, refused in the store under the definition's lock). Each of the check's traces:
 *   - R1: replace_definition and publish on a pinned draft change nothing, so it cannot run YAML no revision holds;
 *   - R6: after its definition is deleted, a person's publish_and_start starts nothing;
 *   - R4: after its chat completed, a person's start starts nothing.
 *   A person is not offered these operations on a pinned Workflow.
 * - G2: an exact spawn_workflow repeat (the same key and YAML) is answered from its save's receipt, also after a crash
 *   between the save and the start: the repeat starts the revision that save made and saves no other; for a first save
 *   and for a later one.
 * No model, no controller: a started run stays admitted (a recording duroxide client stands in for the dispatch).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import { updateWorkflowForPerson, workflowCommandsForPerson } from "../../src/workflow/v2/human-commands.ts";
import { deleteChatWorkflowDefinition, listChatWorkflowDefinitions } from "../../src/workflow/v2/chat-definitions.ts";
import { spawnWorkflowCompatFromTool } from "../../src/workflow/v2/definition-tool.ts";
import { sha256Hex } from "../../src/workflow/v2/json.ts";
import { openWorkflowStore } from "../helpers/workflow-v2-request-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const CMS_LOCK_SEED = 0x63_6D_73;
const ACTOR = { kind: "system", name: "chat-pinned-test" };
const OWNER = { provider: "test", subject: "chat-pinned" };
const PERSON = { kind: "user", provider: "test", subject: "ada", display: "Ada Lovelace" };

const YAML = (name, seconds) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: ${seconds}, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

const recordingClient = () => ({ startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} });

describe("G1: a Workflow pinned to a chat revision takes no stage 1 definition operation", () => {
    it("refuses replace_definition, publish, publish_and_start and start on the chat's tool and a person's command, per trace (R1, R6, R4)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const direct = new pg.Pool({ connectionString: env.store, max: 2 });
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        try {
            // Stage 1 Workflows, made before migration 0107, that never ran.
            await runMigrations(direct, env.cmsSchema, CMS_MIGRATIONS(env.cmsSchema).filter(m => m.version <= "0106"), CMS_LOCK_SEED);
            const store = catalog.workflowStore();
            const host = { catalog, store, duroxideClient: recordingClient() };
            const chat = randomUUID();
            await catalog.createSession(chat, { owner: OWNER });
            const make = async (yaml, publish) => {
                const id = randomUUID();
                await createWorkflowV2(host, { workflowSessionId: id, parentSessionId: chat, yaml, actor: ACTOR, operationId: `create-${id}`, publish });
                return id;
            };
            const draftR1 = await make(YAML("pinned-r1", 10), false);
            const draftR6 = await make(YAML("pinned-r6", 20), false);
            const publishedR4 = await make(YAML("pinned-r4", 30), true);
            await catalog.initialize();

            const definitions = Object.fromEntries((await listChatWorkflowDefinitions(host, chat)).map(item => [item.name, item]));
            for (const [id, name] of [[draftR1, "pinned-r1"], [draftR6, "pinned-r6"], [publishedR4, "pinned-r4"]]) {
                expect(await store.readDefinition(id)).toMatchObject({ chatDefinitionId: definitions[name].definitionId, chatRevision: 1 });
            }
            const hashOf = async id => (await store.readRevision(id, 1)).yamlSha256;
            const tool = (id, args) => updateWorkflowFromTool({ workflow_id: id, ...args }, { callerSessionId: chat, host }).then(text => JSON.parse(text));
            const person = (id, command) => updateWorkflowForPerson(command, { host, workflowSessionId: id, actor: PERSON });
            const refusedCode = async promise => { try { await promise; return null; } catch (error) { return error?.code ?? String(error); } };
            const noRun = async id => expect(await store.listRuns(id)).toEqual([]);

            // A person is offered no definition operation on a pinned Workflow, and no draft to edit.
            const offered = await workflowCommandsForPerson(store, draftR1, { requests: false, runId: null, draftRevision: 1 });
            expect(offered.operations).not.toContain("replace_definition");
            expect(offered.operations).not.toContain("publish_and_start");
            expect(offered.operations).toContain("cancel");
            expect(offered.draft).toBeUndefined();

            // R1: the chat's replace_definition and publish on the pinned draft change nothing.
            const replaced = await tool(draftR1, { operation: "replace_definition", operation_id: "r1-replace", expected_revision: 1, yaml: YAML("pinned-r1", 11) });
            expect(replaced).toMatchObject({ ok: false, error: { code: "PINNED_TO_CHAT_REVISION" } });
            expect(replaced.error.message).toMatch(/^This Workflow is a copy of revision 1 of its chat's Workflow Definition: replace_definition does not change, publish or start it\. .*workflow_definition save.* Nothing was changed\.$/);
            const published = await tool(draftR1, { operation: "publish", operation_id: "r1-publish", expected_revision: 1, definition_hash: await hashOf(draftR1) });
            expect(published).toMatchObject({ ok: false, error: { code: "PINNED_TO_CHAT_REVISION" } });
            expect(await store.readDefinition(draftR1)).toMatchObject({ state: "draft", currentRevision: 1 });
            await noRun(draftR1);

            // R6: its definition deleted, a person's publish_and_start on the pinned draft starts nothing.
            await deleteChatWorkflowDefinition(host, { ownerSessionId: chat, definitionId: definitions["pinned-r6"].definitionId, actor: PERSON,
                operationId: "delete-r6" });
            expect(await refusedCode(person(draftR6, { operation: "publish_and_start", operation_id: "r6-pas", expected_revision: 1,
                definition_hash: await hashOf(draftR6), inputs: {} }))).toBe("PINNED_TO_CHAT_REVISION");
            await noRun(draftR6);

            // R4: its chat completed, a person's start (and the chat's) of the published, never started Workflow starts nothing.
            await direct.query(`UPDATE "${env.cmsSchema}".sessions SET state = 'completed' WHERE session_id = $1`, [chat]);
            expect(await refusedCode(person(publishedR4, { operation: "start", operation_id: "r4-start", definition_hash: await hashOf(publishedR4),
                inputs: {} }))).toBe("PINNED_TO_CHAT_REVISION");
            expect(await tool(publishedR4, { operation: "start", operation_id: "r4-start-chat", definition_hash: await hashOf(publishedR4), inputs: {} }))
                .toMatchObject({ ok: false, error: { code: "PINNED_TO_CHAT_REVISION" } });
            await noRun(publishedR4);
        } finally {
            await catalog.close();
            await direct.end();
        }
    });
});

describe("G2: an exact spawn_workflow repeat is answered from its save's receipt", () => {
    it("after a crash between the save and the start, the repeat starts the revision that save made, for a first save and a later one", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = { catalog: h.catalog, store: h.store, duroxideClient: recordingClient() };
            const chat = randomUUID();
            await h.catalog.createSession(chat, { owner: OWNER });
            // The worker "crashes" in the start, after the save committed: the Workflow's definition is never stored.
            let crashes = 0;
            const crashing = Object.create(h.store);
            crashing.createDefinition = async () => { crashes += 1; throw new Error("the worker stopped"); };
            const spawn = (yaml, key, onHost = host) => spawnWorkflowCompatFromTool({ yaml, key, state: "published", start: true },
                { callerSessionId: chat, operationId: `spawn:key:${key}:${sha256Hex(yaml).slice(0, 32)}`, owner: async () => null, binding: async () => null,
                    host: onHost }).then(text => JSON.parse(text));
            const workflowsOf = async definitionId => (await h.store.chat.listWorkflows({ definitionId })).map(item => item.revision);

            // A first save (no guard): saved, then the crash.
            const first = await spawn(YAML("repeat-me", 10), "k1", { ...host, store: crashing });
            expect(first).toMatchObject({ ok: false });
            expect(crashes).toBe(1);
            const definition = await h.store.chat.readDefinitionByName(chat, "repeat-me");
            expect(definition.currentRevision).toBe(1);
            expect(await workflowsOf(definition.definitionId)).toEqual([]);
            // The repeat: no OPERATION_CONFLICT, no second revision; it starts revision 1.
            const repeated = await spawn(YAML("repeat-me", 10), "k1");
            expect(repeated, JSON.stringify(repeated)).toMatchObject({ ok: true, operation: "save_and_start", revision: 1, definitionId: definition.definitionId });
            expect((await h.store.chat.readDefinitionByName(chat, "repeat-me")).currentRevision).toBe(1);
            expect(await workflowsOf(definition.definitionId)).toEqual([1]);
            // A third time: the same Workflow, from both receipts.
            expect(await spawn(YAML("repeat-me", 10), "k1")).toMatchObject({ ok: true, replayed: true, revision: 1, workflowId: repeated.workflowId });

            // A later save (guarded by revision 1, which the chat has seen): saved as revision 2, then the crash; the repeat
            // starts revision 2 and saves no revision 3.
            const later = await spawn(YAML("repeat-me", 20), "k2", { ...host, store: crashing });
            expect(later).toMatchObject({ ok: false });
            expect(crashes).toBe(2);
            expect((await h.store.chat.readDefinitionByName(chat, "repeat-me")).currentRevision).toBe(2);
            const second = await spawn(YAML("repeat-me", 20), "k2");
            expect(second, JSON.stringify(second)).toMatchObject({ ok: true, revision: 2 });
            expect((await h.store.chat.readDefinitionByName(chat, "repeat-me")).currentRevision).toBe(2);
            expect((await workflowsOf(definition.definitionId)).sort()).toEqual([1, 2]);
            expect((await h.store.readRevision(second.workflowId, 1)).yaml).toBe(YAML("repeat-me", 20));

            // The guard still applies to a first execution: a person's save the chat has not seen refuses a new key.
            await h.store.chat.save({ ownerSessionId: chat, name: "repeat-me", yaml: YAML("repeat-me", 30),
                compiled: (await import("../../src/workflow/v2/compiler.ts")).compileWorkflowV2(YAML("repeat-me", 30)),
                expected: { definitionId: definition.definitionId, revision: 2 }, actor: { kind: "user", provider: "test", subject: "ada" },
                operationId: "person-save", requestSha256: "person-save", seenByChat: false, noteBy: "Ada Lovelace" });
            expect(await spawn(YAML("repeat-me", 40), "k3")).toMatchObject({ ok: false, error: { code: "REVISION_STALE" } });
        } finally {
            await h.stop();
        }
    });
});
