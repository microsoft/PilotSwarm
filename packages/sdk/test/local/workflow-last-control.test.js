/**
 * UXP-AD-01 (owner 2026-11-09T03:25Z): read_workflow's run.lastControl, on the real PostgreSQL store, through the
 * read_workflow and update_workflow tool adapters a session calls and the run command service a person's command takes:
 * - a run with no control action has none;
 * - a pause by the reading session ("this session"), then a resume by a person ("a person", with the name the portal knows them
 *   by; never their sign-in identity), as on TEST: the session paused, the person resumed from the portal;
 * - variables set by another session ("another session", its id); a system's pause ("system", its name);
 * - a graceful stop and a cancel, with their reasons as stored: secrets hidden, cut at 500 characters (and "…");
 * - a "done" ends a run but is no control action;
 * - review PRA-F3: the management client's readWorkflow (the Web API's and MCP's read) has it too, with no reading session:
 *   the session's own action reads "another session" with its id.
 * Nothing here runs a controller: the runs are admitted and never begin (the store's commands apply to them as they are).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { controlWorkflowRun } from "../../src/workflow/service.ts";
import { readWorkflowFromTool, updateWorkflowFromTool } from "../../src/workflow/tools.ts";
import { WORKFLOW_CONTROLLER_VERSION, workflowLiveControllerInstanceId } from "../../src/workflow/runtime.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;

const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: last-control, version: "1.0.0" }
initial: pause_a_while
states:
  pause_a_while: { type: wait, seconds: 600, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

/** A durable client that records what it is told and runs nothing (no controller runs here). */
function fakeDuroxide() {
    const told = [];
    return {
        told,
        enqueueEvent: async (instanceId, queue, data) => { told.push({ instanceId, queue, data }); },
        startOrchestrationVersioned: async (...args) => { told.push({ started: args }); },
        getStatus: async () => ({ status: "Running" }),
    };
}

/** A session and its Workflow with one live run, admitted (at the Workflow controller, so it can be stopped). */
async function sessionWorkflow(env, label) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const owner = { provider: "test", subject: `${label}-${randomUUID()}` };
    const session = randomUUID();
    await catalog.createSession(session, { owner });
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    const compiled = compileWorkflow(YAML);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    expect((await catalog.createWorkflowSession(workflowSessionId, { parentSessionId: session, owner,
        creationConfig: { workflow: { requestSha256: label } } })).created).toBe(true);
    await store.createDefinition({
        workflowSessionId, parentSessionId: session, notifyParent: false, yaml: YAML, compiled, actor: { kind: "system", name: `${label}-test` },
        operationId: "create", requestSha256: label, publish: true, title: `Workflow: ${label}`,
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId), inputsText: "{}", kvText: "{}",
            testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION },
    });
    const duroxideClient = fakeDuroxide();
    const host = { catalog, store, duroxideClient };
    const read = async () => {
        const view = JSON.parse(await readWorkflowFromTool({ workflow_id: workflowSessionId }, { callerSessionId: session, host }));
        expect(view.ok, JSON.stringify(view)).toBe(true);
        return view.run;
    };
    const asSession = async args => {
        const done = JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowSessionId, ...args }, { callerSessionId: session, host }));
        expect(done.ok, JSON.stringify(done)).toBe(true);
        return done;
    };
    const command = (actor, command) => controlWorkflowRun(host, workflowSessionId, { runId: null, reason: null, ...command },
        { actor, operationId: `${command.operation}-${randomUUID()}` });
    /** The data of the run's newest event of this type, as stored. */
    const stored = async eventType => (await catalog.getSessionEvents(workflowSessionId, 0, 1_000, [eventType])).at(-1)?.data ?? null;
    return { catalog, store, session, owner, workflowSessionId, runId, host, read, asSession, command, stored, env };
}

/** The users table's display name for a person (as the portal's sign-in records it). */
async function nameThePerson(catalog, env, person, displayName) {
    await catalog.pool.query(`INSERT INTO "${env.cmsSchema}".users (provider, subject, display_name) VALUES ($1, $2, $3)
        ON CONFLICT (provider, subject) DO UPDATE SET display_name = EXCLUDED.display_name`, [person.provider, person.subject, displayName]);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("read_workflow run.lastControl (UXP-AD-01)", () => {
    it("is absent without a control action; a pause by this session, then a person's resume, reads as the person's resume", { timeout: TIMEOUT }, async () => {
        const h = await sessionWorkflow(getEnv(), "pause-resume");
        const before = await h.read();
        expect(before.status).toBe("admitted");
        expect(before).not.toHaveProperty("lastControl");

        // The session pauses its run on the person's request.
        await h.asSession({ operation: "pause", operation_id: "owner-pause", reason: "The person asked me to pause it." });
        const paused = await h.read();
        expect(paused.status).toBe("paused");
        expect(paused.lastControl).toEqual({ operation: "pause", by: "this session", at: expect.stringMatching(ISO),
            reason: "The person asked me to pause it." });

        // The person resumes it from the portal (a person's command: their sign-in is the actor).
        const person = { kind: "user", provider: "test-idp", subject: `subject-${randomUUID()}` };
        await nameThePerson(h.catalog, h.env, person, "Ada Lovelace");
        await h.command(person, { operation: "resume" });
        const resumed = await h.read();
        expect(resumed.status).toBe("admitted");
        expect(resumed.lastControl).toEqual({ operation: "resume", by: "a person", name: "Ada Lovelace", at: expect.stringMatching(ISO) });
        expect(Date.parse(resumed.lastControl.at)).toBeGreaterThanOrEqual(Date.parse(paused.lastControl.at));
        // Never the person's sign-in identity.
        const text = JSON.stringify(resumed.lastControl);
        expect(text).not.toContain(person.subject);
        expect(text).not.toContain(person.provider);
        // The same run read again reads the same: reading changes nothing.
        expect((await h.read()).lastControl).toEqual(resumed.lastControl);
    });

    it("names another session that set variables, a system that paused, and a person without a portal name", { timeout: TIMEOUT }, async () => {
        const h = await sessionWorkflow(getEnv(), "others");
        const other = randomUUID();
        await h.command({ kind: "agent", sessionId: other }, { operation: "set_vars", set: { mode: "fast" }, delete: [], expectedKvRevision: 1 });
        expect((await h.read()).lastControl).toEqual({ operation: "set_vars", by: "another session", sessionId: other, at: expect.stringMatching(ISO) });

        await h.command({ kind: "system", name: "management-client" }, { operation: "pause", reason: "maintenance" });
        expect((await h.read()).lastControl).toEqual({ operation: "pause", by: "system", name: "management-client", at: expect.stringMatching(ISO),
            reason: "maintenance" });

        const unnamed = { kind: "user", provider: "test-idp", subject: `subject-${randomUUID()}` };
        await h.command(unnamed, { operation: "resume" });
        const resumed = (await h.read()).lastControl;
        expect(resumed).toEqual({ operation: "resume", by: "a person", at: expect.stringMatching(ISO) });
        expect(JSON.stringify(resumed)).not.toContain(unnamed.subject);
    });

    it("reads a stop and a cancel with their reasons as stored: secrets hidden, cut at 500 characters", { timeout: TIMEOUT }, async () => {
        const stopping = await sessionWorkflow(getEnv(), "stop");
        const person = { kind: "user", provider: "test-idp", subject: `subject-${randomUUID()}` };
        const long = `Stop it: Bearer s3cr3tT0kenValue123 ${"x".repeat(700)}`;
        await stopping.command(person, { operation: "stop", reason: long, graceSeconds: 30 });
        const stop = (await stopping.read()).lastControl;
        const storedStop = await stopping.stored("workflow.stop_requested");
        expect(stop).toEqual({ operation: "stop", by: "a person", at: expect.stringMatching(ISO), reason: storedStop.reason });
        // Cut at 500 characters, and marked as cut (jsonbSafeText).
        expect(stop.reason).toHaveLength(501);
        expect(stop.reason.endsWith("…")).toBe(true);
        expect(stop.reason).not.toContain("s3cr3tT0kenValue123");
        expect(stop.reason.startsWith("Stop it: Bearer ")).toBe(true);

        // A cancel by the session (update_workflow takes a reason of at most 500 characters): its secret hidden as stored.
        const cancelling = await sessionWorkflow(getEnv(), "cancel");
        await cancelling.asSession({ operation: "cancel", operation_id: "owner-cancel", reason: "The person said stop; token=abcdefgh12345 was in the log." });
        const run = await cancelling.read();
        expect(run.status).toBe("cancelled");
        const storedCancel = await cancelling.stored("workflow.cancelled");
        expect(storedCancel.actor).toEqual({ kind: "agent", sessionId: cancelling.session });
        expect(run.lastControl).toEqual({ operation: "cancel", by: "this session", at: expect.stringMatching(ISO), reason: storedCancel.reason });
        expect(run.lastControl.reason).not.toContain("abcdefgh12345");
        expect(run.lastControl.reason.startsWith("The person said stop; token=")).toBe(true);
    });

    it("reads a person's cancel without a reason by the reason the run stored; a parent's \"done\" is no control action", { timeout: TIMEOUT }, async () => {
        const h = await sessionWorkflow(getEnv(), "person-cancel");
        const person = { kind: "user", provider: "test-idp", subject: `subject-${randomUUID()}` };
        await nameThePerson(h.catalog, h.env, person, "Grace Hopper");
        await h.command(person, { operation: "cancel" });
        expect((await h.read()).lastControl).toEqual({ operation: "cancel", by: "a person", name: "Grace Hopper", at: expect.stringMatching(ISO),
            reason: "Cancelled by a person" });

        // A parent's done (its session command) ends the run cancelled, but is not a control action: a pause stays the latest.
        const done = await sessionWorkflow(getEnv(), "done");
        await done.asSession({ operation: "pause", operation_id: "owner-pause" });
        await done.store.recordSessionCommand({ workflowSessionId: done.workflowSessionId, operationId: "parent-done", requestSha256: "done",
            command: "done", reason: "Stopped", requestedBy: done.session });
        const ended = await done.read();
        expect(ended.status).toBe("cancelled");
        expect((await done.stored("workflow.cancelled")).command).toBe("done");
        expect(ended.lastControl).toEqual({ operation: "pause", by: "this session", at: expect.stringMatching(ISO) });
    });

    it("PRA-F3: the management client's read (the Web API's and MCP's) has lastControl too, read by no session", { timeout: TIMEOUT }, async () => {
        const h = await sessionWorkflow(getEnv(), "mgmt-read");
        const mgmt = await createManagementClient(h.env);
        try {
            expect((await mgmt.readWorkflow(h.workflowSessionId)).run).not.toHaveProperty("lastControl");
            await h.asSession({ operation: "pause", operation_id: "owner-pause", reason: "The person asked me to pause it." });
            expect((await mgmt.readWorkflow(h.workflowSessionId)).run.lastControl).toEqual({ operation: "pause", by: "another session", sessionId: h.session,
                at: expect.stringMatching(ISO), reason: "The person asked me to pause it." });
            // The session's own read still says it was this session.
            expect((await h.read()).lastControl).toMatchObject({ operation: "pause", by: "this session" });
            const person = { kind: "user", provider: "test-idp", subject: `subject-${randomUUID()}` };
            await nameThePerson(h.catalog, h.env, person, "Ada Lovelace");
            await h.command(person, { operation: "resume" });
            expect((await mgmt.readWorkflow(h.workflowSessionId)).run.lastControl).toEqual({ operation: "resume", by: "a person", name: "Ada Lovelace",
                at: expect.stringMatching(ISO) });
        } finally {
            await mgmt.stop();
        }
    });
});
