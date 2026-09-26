// Native delegation at a context-reset session.
//
// Opting into `contextReset` makes a session a leaf worker. Its window is wiped
// between batches, so it cannot account for native children it no longer
// remembers spawning; `task` is therefore refused at the permission hook.
//
// The refusal is deliberately narrow. The tool DESCRIPTOR stays registered —
// the runner's own isolation check requires `bash`, `view` and `task` to be
// present — and sessions that did not opt into `contextReset` keep ordinary
// synchronous delegation. Both halves are asserted here, against a real
// scripted endpoint so the decision is observed on the wire rather than
// inferred from the hook's source.
import { describe, it, expect } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { createEphemeralSessionRunner } from "../../dist/ephemeral-session.js";
import { loadProviderTypes } from "../../src/provider-catalog.ts";
import { WIRES, createScriptedWire } from "../helpers/scripted-wires.mjs";

const MODEL = "gpt-5.6-terra";
const WIRE = WIRES.openai;
const DENIED = "EPHEMERAL_NATIVE_DENIED";
const TASK_ARGS = { name: "probe", agent_type: "swarm-explore", description: "probe",
    prompt: "Look around and report." };

function credentialCatalog() {
    return {
        async getUserRole() { return { role: "user", roleSeenAt: null }; },
        providers: {
            async lookupUserId() { return 1; },
            async getCredential() {
                return { name: "synthetic", typeId: "template", class: "shared",
                    ownerUserId: null, baseUrl: null, secretRef: { value: "synthetic-only-key" } };
            },
        },
    };
}

/**
 * Runs one session whose scripted model opens with a `task` call, and reports
 * what the runtime did with it. `mode` is passed through verbatim so an omitted
 * mode can be distinguished from an explicit "sync".
 */
async function runWithTaskCall({ contextReset, mode }) {
    const root = path.resolve(`.ephemeral-leaf-${randomUUID()}`);
    const cwd = path.join(root, "workspace"), scratch = path.join(root, "sdk");
    await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });

    const canary = `CANARY-${randomUUID().slice(0, 8)}`;
    const phases = [];
    let asked = 0;

    const server = await createScriptedWire(WIRE, (messages, tools) => {
        // A child runs with the native worker toolset and never sees `task`.
        if (!tools.includes("task")) { phases.push("child"); return { content: "Child finished." }; }
        if (asked++ === 0) {
            phases.push("task-call");
            return { tool: "task", args: { ...TASK_ARGS, ...(mode === undefined ? {} : { mode }) } };
        }
        phases.push("settle");
        return { content: `Done. ${canary}` };
    });

    const types = loadProviderTypes({ providers: [
        { id: "template", type: WIRE.type, baseUrl: server.baseUrl, models: [MODEL] }] });
    try {
        const run = createEphemeralSessionRunner(credentialCatalog(), () => types, { scratchRoot: scratch });
        const outcome = await run({
            actor: { provider: "fixture", subject: "test" }, executionId: randomUUID(),
            model: `synthetic:${MODEL}`, workingDirectory: cwd,
            systemMessage: "Private synthetic system", prompt: "Delegate if you can, then finish.",
            ...(contextReset ? { contextReset: true } : {}),
            onResponse: async () => ({ action: "complete" }),
        }).then(result => ({ result }), error => ({ error }));
        const wire = JSON.stringify(server.requests);
        return { ...outcome, phases, canary, denied: wire.includes(DENIED), tools: WIRE.tools(server.requests[0]) };
    } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
    }
}

describe("a context-reset session is a leaf worker", () => {
    it.concurrent("denies an explicit task(mode=\"sync\") call before any child is created",
        { timeout: 180000 }, async () => {
            const { result, error, phases, canary, denied, tools } = await runWithTaskCall(
                { contextReset: true, mode: "sync" });
            expect(error).toBeUndefined();

            // The model did ask, and the refusal reached the wire as our reason.
            expect(phases.filter(phase => phase === "task-call").length).toBe(1);
            expect(denied).toBe(true);

            // No child session ever ran.
            expect(phases).not.toContain("child");

            // The descriptor is still offered — the isolation check requires it.
            expect(tools).toContain("task");
            expect(tools).toContain("ephemeral_context_reset");

            // The refusal is not fatal: the session finishes its own work.
            expect(result.text).toContain(canary);
        });

    it.concurrent("denies a task call with the mode omitted", { timeout: 180000 }, async () => {
        const { error, phases, denied } = await runWithTaskCall({ contextReset: true, mode: undefined });
        expect(error).toBeUndefined();
        expect(phases.filter(phase => phase === "task-call").length).toBe(1);
        expect(denied).toBe(true);
        expect(phases).not.toContain("child");
    });

    it.concurrent("leaves ordinary synchronous delegation untouched when contextReset is absent",
        { timeout: 180000 }, async () => {
            const { result, error, phases, canary, denied, tools } = await runWithTaskCall(
                { contextReset: false, mode: "sync" });
            expect(error).toBeUndefined();

            // Same request, opposite decision: admitted, and the child ran.
            expect(phases.filter(phase => phase === "task-call").length).toBe(1);
            expect(denied).toBe(false);
            expect(phases).toContain("child");

            // A session that did not opt in has no reset tool to begin with.
            expect(tools).toContain("task");
            expect(tools).not.toContain("ephemeral_context_reset");
            expect(result.text).toContain(canary);
        });
});
