import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition, workflowStartSessionId } from "../../src/workflow/session-definitions.ts";
import { workflowDefinitionFromTool } from "../../src/workflow/definition-tool.ts";
import { workflowToolGrant } from "../../src/workflow/tool-policy.ts";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "workflow-start-key" };
const ACTOR = { kind: "system", name: "workflow-start-key-test" };
const yaml = (name = "poller", seconds = 1) => `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: ${seconds}, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

async function setup(h) {
    const dispatched = [];
    const host = { catalog: h.catalog, store: h.store, duroxideClient: {
        startOrchestrationVersioned: async id => { dispatched.push(id); },
        getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {},
    } };
    const session = randomUUID();
    await h.catalog.createSession(session, { owner: OWNER });
    const save = async (name, source = yaml(name)) => (await saveSessionWorkflowDefinition(host, {
        ownerSessionId: session, name, yaml: source, expected: null, actor: { kind: "session", sessionId: session },
        operationId: randomUUID(), by: "session",
    })).receipt;
    const start = (definitionId, extra = {}) => startSessionWorkflowDefinition(host, {
        ownerSessionId: session, definition: { definitionId }, inputs: {}, actor: ACTOR, operationId: randomUUID(),
        owner: OWNER, key: "attempt-1", ...extra,
    });
    return { host, session, save, start, dispatched };
}

describe("idempotent session-scoped Workflow start key (FB-001)", () => {
    it("a new tool call returns the original pinned revision; fresh keys and unkeyed calls make new attempts", { timeout: 120_000 }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const { host, session, save, start } = await setup(h);
            const definition = await save("poller");
            const context = call => ({ callerSessionId: session, host, owner: OWNER, toolCallId: call, binding: async () => null });
            const first = JSON.parse(await workflowDefinitionFromTool({ operation: "start", name: "poller", key: "attempt-1" }, context("call-1")));
            expect(first).toMatchObject({ ok: true, replayed: false, revision: 1 });
            await saveSessionWorkflowDefinition(host, { ownerSessionId: session, name: "poller", yaml: yaml("poller", 2),
                expected: { definitionId: definition.definitionId, revision: 1 }, actor: { kind: "session", sessionId: session },
                operationId: randomUUID(), by: "session" });
            const replay = JSON.parse(await workflowDefinitionFromTool({ operation: "start", definition_id: definition.definitionId, key: "attempt-1" }, context("call-2")));
            expect(replay).toMatchObject({ ok: true, replayed: true, workflowId: first.workflowId, runId: first.runId, revision: 1 });
            expect(replay.message).toContain("no new attempt was created");
            const second = await start(definition.definitionId, { key: "attempt-2" });
            expect(second.workflowId).not.toBe(first.workflowId);
            expect(second.revision).toBe(2);
            const unkeyed = await start(definition.definitionId, { key: undefined });
            expect(unkeyed.workflowId).not.toBe(first.workflowId);
            expect(unkeyed.workflowId).not.toBe(second.workflowId);
            expect(await h.store.sessionDefinitions.listWorkflows({ definitionId: definition.definitionId })).toHaveLength(3);
        } finally { await h.stop(); }
    });

    it("concurrent repeated keys create one run; conflicting arguments and another definition refuse", { timeout: 120_000 }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const { host, session, save, start } = await setup(h);
            const definition = await save("poller");
            const attempts = await Promise.all(Array.from({ length: 3 }, () => start(definition.definitionId)));
            expect(new Set(attempts.map(item => item.workflowId)).size).toBe(1);
            expect(new Set(attempts.map(item => item.runId)).size).toBe(1);
            expect(attempts.filter(item => !item.replayed)).toHaveLength(1);
            const other = await save("other");
            for (const extra of [{ inputs: { changed: true } }, { vars: { changed: true } }, { notifyParent: false }, { revision: 2 },
                { agentModels: { classify: { model: "test:another" } } },
                { definition: { definitionId: other.definitionId } }, { definition: { name: "other" } }]) {
                await expect(start(definition.definitionId, extra)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
            }
            expect(await h.store.sessionDefinitions.listWorkflows({ definitionId: definition.definitionId })).toHaveLength(1);
            expect(await h.store.sessionDefinitions.listWorkflows({ definitionId: other.definitionId })).toHaveLength(0);
            const anotherSession = randomUUID();
            await h.catalog.createSession(anotherSession, { owner: OWNER });
            const savedElsewhere = (await saveSessionWorkflowDefinition(host, { ownerSessionId: anotherSession, name: "poller", yaml: yaml(),
                expected: null, actor: { kind: "session", sessionId: anotherSession }, operationId: randomUUID(), by: "session" })).receipt;
            const elsewhere = await start(savedElsewhere.definitionId, { ownerSessionId: anotherSession });
            expect(elsewhere.workflowId).not.toBe(attempts[0].workflowId);
            expect(workflowStartSessionId(session, "any", "attempt-1")).toBe(attempts[0].workflowId);
        } finally { await h.stop(); }
    });

    it("an admitted repeat uses the original grant even if current capture fails, and returns after the run ends", { timeout: 120_000 }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const { host, session, save, start, dispatched } = await setup(h);
            const source = yaml().replace("  hold: { type: wait, seconds: 1, transition: { next: { elapsed: done } } }",
                '  hold: { type: script, source: \'await callTool("read_facts", {}); await setResult("success", {});\', transition: { next: { success: done, failure: done } } }');
            const saved = await save("poller", source);
            const binding = { policy: "node-parent-tools-v1", parentSessionId: session, owner: OWNER, config: {},
                capabilities: { revision: 0, selections: [] }, tools: [workflowToolGrant({ name: "read_facts", input_schema: {} })],
                sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "fixture" };
            const first = await start(saved.definitionId, { binding });
            let captures = 0;
            const replay = await start(saved.definitionId, { binding: async () => { captures++; throw new Error("capture unavailable"); } });
            expect(replay).toMatchObject({ workflowId: first.workflowId, runId: first.runId, replayed: true });
            expect(captures).toBe(0);
            const stored = await h.catalog.getSessionCreationConfig(first.workflowId);
            expect(stored.workflowToolBinding).toEqual(binding);
            await h.q("UPDATE SCHEMA.workflow_runs SET status = 'failed', finished_at = now() WHERE run_id = $1", [first.runId]);
            const before = dispatched.length;
            const ended = await start(saved.definitionId);
            expect(ended).toMatchObject({ workflowId: first.workflowId, runId: first.runId, replayed: true });
            expect(dispatched).toHaveLength(before);
        } finally { await h.stop(); }
    });

    it("a restarted caller resumes an interrupted claim with its original revision and grant", { timeout: 120_000 }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const { host, session, save, start } = await setup(h);
            const saved = await save("poller");
            let fail = true;
            const interrupted = { ...host, store: new Proxy(h.store, { get(target, name) {
                if (name === "createDefinition" && fail) return async () => { fail = false; throw new Error("worker stopped"); };
                return typeof target[name] === "function" ? target[name].bind(target) : target[name];
            } }) };
            await expect(startSessionWorkflowDefinition(interrupted, { ownerSessionId: session, definition: { definitionId: saved.definitionId },
                inputs: {}, owner: OWNER, actor: ACTOR, operationId: "before-restart", key: "attempt-1" })).rejects.toThrow("worker stopped");
            await saveSessionWorkflowDefinition(host, { ownerSessionId: session, name: "poller", yaml: yaml("poller", 2),
                expected: { definitionId: saved.definitionId, revision: 1 }, actor: { kind: "session", sessionId: session },
                operationId: randomUUID(), by: "session" });
            const resumed = await start(saved.definitionId, { operationId: "after-restart", binding: async () => { throw new Error("do not recapture"); } });
            expect(resumed.revision).toBe(1);
            expect((await h.store.readRevision(resumed.workflowId, 1)).yaml).toBe(yaml());
            expect(await h.store.sessionDefinitions.listWorkflows({ definitionId: saved.definitionId })).toHaveLength(1);
        } finally { await h.stop(); }
    });
});
