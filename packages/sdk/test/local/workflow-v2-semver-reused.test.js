/**
 * SEMVER_REUSED on PostgreSQL (owner revision dump 2, 2026-11-06; unit side: test/unit/workflow-semver-reused.test.mjs).
 * One metadata.name and version is one definition among the Workflows of one session. Asked by spawn_workflow and by a
 * draft's replace_definition (refuseVersionReuse), the store refuses a version that another live Workflow of the same
 * parent has with other YAML: neither its YAML hash nor (both valid) its IR hash. A refused creation writes nothing; the
 * same YAML spawned again, YAML that compiles to the same definition, another parent, a new version and a replay of a
 * stored creation all pass. No model and no run: drafts and publications only.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflowV2, updateWorkflowV2 } from "../../src/workflow/v2/service.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-semver-reused-test" };
const PERSON = { provider: "test", subject: "semver-reused" };

const YAML = (version, seconds = 60) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: hacker-news-database-scan, version: "${version}" }
initial: hold
states:
  hold: { type: wait, seconds: ${seconds}, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

async function refusedWith(promise, code) {
    let caught;
    try { await promise; } catch (error) { caught = error; }
    expect(caught?.code, caught?.message).toBe(code);
    return caught;
}

describe("workflow v2: one name and version is one definition among a session's Workflows (SEMVER_REUSED)", () => {
    it("refuses other YAML at a version the parent's Workflows have, writes nothing, and passes every legitimate case", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const host = { catalog, store: catalog.workflowStore(), duroxideClient: {} };
            const chat = randomUUID();
            const otherChat = randomUUID();
            await catalog.createSession(chat, { owner: PERSON });
            await catalog.createSession(otherChat, { owner: PERSON });
            const create = (parentSessionId, yaml, extra = {}) => {
                const workflowSessionId = extra.workflowSessionId ?? randomUUID();
                return createWorkflowV2(host, { workflowSessionId, parentSessionId, yaml, actor: ACTOR, operationId: extra.operationId ?? `create-${workflowSessionId}`,
                    publish: extra.publish === true, refuseVersionReuse: extra.guard !== false });
            };

            // 1.1.3 published, then the same YAML again: another Workflow of the same definition.
            const firstId = randomUUID();
            const first = await create(chat, YAML("1.1.3"), { workflowSessionId: firstId, operationId: "create-first", publish: true });
            expect(first.receipt).toMatchObject({ state: "published", revision: 1 });
            await create(chat, YAML("1.1.3"), { publish: true });
            // YAML that compiles to the same definition (a comment) is the same definition.
            const commented = await create(chat, `${YAML("1.1.3")}# the same monitor\n`, { publish: true });
            expect(commented.receipt.yamlSha256).not.toBe(first.receipt.yamlSha256);

            // Other YAML at 1.1.3: refused, naming the newest Workflow that has it; nothing is written.
            const refusedId = randomUUID();
            const refused = await refusedWith(create(chat, YAML("1.1.3", 30), { workflowSessionId: refusedId, publish: true }), "SEMVER_REUSED");
            expect(refused.details).toMatchObject({ name: "hacker-news-database-scan", version: "1.1.3", workflowId: commented.receipt.workflowSessionId,
                state: "published", revision: 1 });
            expect(refused.message).toMatch(/A published version never changes: raise metadata\.version and spawn the change as a draft\. Nothing was saved\.$/);
            expect(await catalog.getSession(refusedId)).toBeNull();
            expect(await host.store.readDefinition(refusedId)).toBeNull();
            // The corrected request may use the same id.
            const raised = await create(chat, YAML("1.1.4", 30), { workflowSessionId: refusedId });
            expect(raised.receipt).toMatchObject({ state: "draft", revision: 1, valid: true });

            // Another chat's Workflows are not this chat's; without the request's flag nothing is checked.
            await create(otherChat, YAML("1.1.3", 30));
            await create(chat, YAML("1.1.3", 45), { guard: false });

            // A replay of a stored creation is answered from its receipt, whatever was created since.
            const replay = await create(chat, YAML("1.1.3"), { workflowSessionId: firstId, operationId: "create-first", publish: true });
            expect(replay.replayed).toBe(true);

            // Drafts count: other YAML at a draft's version is refused with the way to change that draft.
            const draft = await create(chat, YAML("1.2.0"));
            const toDraft = await refusedWith(create(chat, YAML("1.2.0", 30)), "SEMVER_REUSED");
            expect(toDraft.details).toMatchObject({ workflowId: draft.receipt.workflowSessionId, state: "draft", revision: 1 });
            expect(toDraft.message).toMatch(/To change that draft, use update_workflow replace_definition on it; for a new definition, raise metadata\.version\./);
            // The draft itself changes in place (it is the only 1.2.0 Workflow).
            const edited = await updateWorkflowV2(host, draft.receipt.workflowSessionId, { operation: "replace_definition", yaml: YAML("1.2.0", 30), expectedRevision: 1 },
                { actor: ACTOR, operationId: "edit-draft", refuseVersionReuse: true });
            expect(edited.receipt).toMatchObject({ state: "draft", revision: 2 });

            // A second draft of 1.2.0 with the same YAML, changed to other YAML: refused, and it keeps its revision.
            const twin = await create(chat, YAML("1.2.0", 30));
            const replaced = await refusedWith(updateWorkflowV2(host, twin.receipt.workflowSessionId,
                { operation: "replace_definition", yaml: YAML("1.2.0", 90), expectedRevision: 1 },
                { actor: ACTOR, operationId: "edit-twin", refuseVersionReuse: true }), "SEMVER_REUSED");
            expect(replaced.details).toMatchObject({ workflowId: draft.receipt.workflowSessionId, state: "draft", revision: 2 });
            expect(replaced.message).toMatch(/Nothing was saved: the draft keeps its revision\.$/);
            expect((await host.store.readDefinition(twin.receipt.workflowSessionId)).currentRevision).toBe(1);
        } finally {
            await catalog.close();
        }
    });
});
