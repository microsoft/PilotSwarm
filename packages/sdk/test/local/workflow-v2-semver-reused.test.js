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

    // The version check runs inside the claim's transaction under a lock on (parent, name): two creations at the same moment
    // are serialized, and the later one sees the earlier one's claim (its name, version and hashes) or its definition. Without
    // the lock both checks could read before either claim committed, and both would pass.
    it("two creations at the same moment: other YAML, exactly one is created and the other is refused, binding nothing; the same YAML, both", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const host = { catalog, store: catalog.workflowStore(), duroxideClient: {} };
            const spawn = (chat, id, yaml, operationId = `create-${id}`) => createWorkflowV2(host, { workflowSessionId: id, parentSessionId: chat, owner: PERSON,
                yaml, actor: ACTOR, operationId, publish: true, refuseVersionReuse: true });
            for (let round = 0; round < 5; round += 1) {
                const chat = randomUUID();
                await catalog.createSession(chat, { owner: PERSON });
                const ids = [randomUUID(), randomUUID()];
                const yamls = [YAML("2.0.0", 30), YAML("2.0.0", 45)];
                const results = await Promise.allSettled([spawn(chat, ids[0], yamls[0]), spawn(chat, ids[1], yamls[1])]);
                const won = results.findIndex(result => result.status === "fulfilled");
                const lost = results.findIndex(result => result.status === "rejected");
                expect(results.map(result => result.status).sort(), `round ${round}: ${JSON.stringify(results.map(result => result.reason?.message ?? null))}`)
                    .toEqual(["fulfilled", "rejected"]);
                expect(results[lost].reason.code).toBe("SEMVER_REUSED");
                expect(results[lost].reason.details).toMatchObject({ name: "hacker-news-database-scan", version: "2.0.0", workflowId: ids[won] });
                // The refused one bound nothing: no row, no definition, and its corrected request may use the same id.
                expect(await catalog.getSession(ids[lost])).toBeNull();
                expect(await host.store.readDefinition(ids[lost])).toBeNull();
                const corrected = await spawn(chat, ids[lost], YAML("2.0.1", 45), `corrected-${ids[lost]}`);
                expect(corrected.receipt).toMatchObject({ state: "published", revision: 1 });
                // The winner's YAML twice at the same moment: more Workflows of the same definition, both created.
                const same = [randomUUID(), randomUUID()];
                const both = await Promise.allSettled(same.map(id => spawn(chat, id, yamls[won])));
                expect(both.map(result => result.status), JSON.stringify(both.map(result => result.reason?.message ?? null))).toEqual(["fulfilled", "fulfilled"]);
            }
        } finally {
            await catalog.close();
        }
    });

    // Review SDK3-F2: on connections whose default isolation is REPEATABLE READ the claim's transaction still reads what an
    // earlier holder of the version lock committed (it begins READ COMMITTED). Before, the check kept the snapshot of the
    // claim statement, taken before the wait, and both creations could pass.
    it("SDK3-F2: the same at a REPEATABLE READ default isolation: exactly one of two concurrent creations with other YAML", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        catalog.pool.on("connect", client => { client.query("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ").catch(() => {}); });
        await catalog.initialize();
        try {
            const host = { catalog, store: catalog.workflowStore(), duroxideClient: {} };
            const { rows } = await catalog.pool.query("SHOW default_transaction_isolation");
            expect(rows[0].default_transaction_isolation).toBe("repeatable read");
            const spawn = (chat, id, yaml) => createWorkflowV2(host, { workflowSessionId: id, parentSessionId: chat, yaml, actor: ACTOR,
                operationId: `create-${id}`, publish: true, refuseVersionReuse: true });
            for (let round = 0; round < 5; round += 1) {
                const chat = randomUUID();
                await catalog.createSession(chat, { owner: PERSON });
                const ids = [randomUUID(), randomUUID()];
                const results = await Promise.allSettled([spawn(chat, ids[0], YAML("3.0.0", 30)), spawn(chat, ids[1], YAML("3.0.0", 45))]);
                expect(results.map(result => result.status).sort(), `round ${round}: ${JSON.stringify(results.map(result => result.reason?.message ?? null))}`)
                    .toEqual(["fulfilled", "rejected"]);
                const lost = results.findIndex(result => result.status === "rejected");
                expect(results[lost].reason.code).toBe("SEMVER_REUSED");
                expect(await catalog.getSession(ids[lost])).toBeNull();
            }
        } finally {
            await catalog.close();
        }
    });

    // Review SDK3-F3: a claim an earlier build made records no version, so a guarded sibling cannot see it; resuming that
    // creation must not store a second definition at the sibling's version. Its definition is checked when it is stored
    // (refused, nothing saved); a completed creation's replay, earlier build or not, is still answered from its receipt.
    it("SDK3-F3: resuming an earlier build's unfinished claim is checked when its definition is stored; a completed one replays", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const host = { catalog, store: catalog.workflowStore(), duroxideClient: {} };
            const chat = randomUUID();
            await catalog.createSession(chat, { owner: PERSON });
            const create = (id, yaml, operationId = `create-${id}`) => createWorkflowV2(host, { workflowSessionId: id, parentSessionId: chat, yaml,
                actor: ACTOR, operationId, publish: true, refuseVersionReuse: true });
            // As an earlier build wrote it: the claim's marker without the name, version and hashes.
            const asEarlierBuild = id => catalog.pool.query(
                `UPDATE "${env.cmsSchema}".sessions SET creation_config = creation_config #- '{workflowV2,name}' #- '{workflowV2,version}'
                    #- '{workflowV2,yamlSha256}' #- '{workflowV2,irSha256}' WHERE session_id = $1`, [id]);
            // A: claimed, then its worker stopped before the definition was stored.
            const a = randomUUID();
            const storeDefinition = host.store.createDefinition;
            host.store.createDefinition = async () => { throw new Error("the worker stopped"); };
            await expect(create(a, YAML("4.0.0", 30))).rejects.toThrow("the worker stopped");
            delete host.store.createDefinition;
            expect(host.store.createDefinition).toBe(storeDefinition);
            await asEarlierBuild(a);
            expect(await catalog.getSession(a)).not.toBeNull();
            // B: other YAML at 4.0.0. A records no version, so B is created.
            const b = randomUUID();
            await create(b, YAML("4.0.0", 45));
            // A's own request resumed: refused when its definition would be stored; it stays a claim without one.
            const resumed = await refusedWith(create(a, YAML("4.0.0", 30)), "SEMVER_REUSED");
            expect(resumed.details).toMatchObject({ version: "4.0.0", workflowId: b, state: "published" });
            expect(resumed.message).toMatch(/Nothing was saved: the claim stays without a definition\.$/);
            expect(await host.store.readDefinition(a)).toBeNull();
            // A completed creation, its marker as an earlier build wrote it: its replay is answered from its receipt.
            const c = randomUUID();
            const first = await create(c, YAML("5.0.0", 30));
            await asEarlierBuild(c);
            const replay = await create(c, YAML("5.0.0", 30));
            expect(replay.replayed).toBe(true);
            expect(replay.receipt).toEqual(first.receipt);
        } finally {
            await catalog.close();
        }
    });
});
