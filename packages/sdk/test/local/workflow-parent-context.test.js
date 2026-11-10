/**
 * of-01 (owner feedback, preview 18:16Z): spawn_workflow was refused in the first turn after a chat's tools or model
 * changed ("A live parent tool context is required to admit a workflow."). getOrCreate recorded the chat's workflow
 * parent context before its warm-session branch; the turn-0 reset, the epoch start and a rebind (a model switch, a
 * capability selection such as use_package) forgot the warm session and that record with it, and the new
 * ManagedSession was stored without it. Every path that stores a ManagedSession now records it.
 *
 * - SessionManager's real getOrCreate with a fake Copilot client (as capability-session-lifecycle does): after
 *   use_package, a model switch, an epoch start and a turn-0 reset of a warm session, the parent context is there and
 *   captureWorkflowToolBinding binds; with no warm session it refuses with WORKFLOW_PARENT_CONTEXT_UNAVAILABLE.
 * - A real worker (PostgreSQL, duroxide, the Copilot CLI, scripted model): the chat switches model with
 *   set_session_model, and spawn_workflow in the first turn on the new model is admitted.
 *
 * Run: npx vitest run test/local/workflow-parent-context.test.js
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../src/session-manager.ts";
import { capabilityRef } from "../../src/capability-catalog.ts";
import { useSuiteEnv } from "../helpers/local-env.js";
import { FIXTURE_PROVIDER, withScriptedModel } from "../helpers/scripted-workers.js";
import { turnWorkflowsOn } from "../helpers/workflows-on.js";

const owner = { provider: "test", subject: "parent-context-owner", email: null, displayName: null };
const CODE = "WORKFLOW_PARENT_CONTEXT_UNAVAILABLE";
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

function packageSource() {
    const packageTool = { name: "package_lookup", description: "Look up package data", parameters: { type: "object" },
        handler: vi.fn(async () => "package-result") };
    return { id: "package-id", name: "incident-kit", source: "published", revision: "sha-1", scope: "user", owner,
        packageId: "package-id", artifacts: [
            { kind: "tool", name: packageTool.name, description: packageTool.description },
            { kind: "mcp", name: "package_mcp", description: "Package MCP" },
        ], tools: new Map([[packageTool.name, packageTool]]),
        mcpServers: { package_mcp: { type: "http", url: "https://example.test/mcp", tools: ["read"] } } };
}

/** A SessionManager over a fake Copilot client whose sessions answer the tool-catalog calls a workflow binding makes. */
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "ps-workflow-parent-context-"));
    const source = packageSource();
    let state = { revision: 0, selections: [] };
    const row = { sessionId: "parent-context-chat", owner, isSystem: false, parentSessionId: null, rootSessionId: "parent-context-chat" };
    const catalog = {
        getSession: async id => (id === row.sessionId ? row : null),
        getUserRole: async () => ({ role: "user", seenAt: new Date() }),
        recordEvents: async () => {},
        getSessionCapabilities: async () => structuredClone(state),
        saveSessionCapabilities: async (_id, expected, next) => {
            if (state.revision !== expected) return false;
            state = structuredClone(next);
            return true;
        },
    };
    const manager = new SessionManager(undefined, null, {
        frameworkBasePrompt: "legacy base", nativeSubagents: "off", getCapabilitySources: () => [source],
    }, dir);
    manager.setSessionCatalog(catalog);
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    const opened = [];
    const open = config => {
        mkdirSync(join(dir, config.sessionId), { recursive: true });
        const handle = { sessionId: config.sessionId, disconnect: vi.fn(async () => {}), registerTools: vi.fn(),
            rpc: { tasks: { list: vi.fn(async () => ({ tasks: [] })) },
                tools: { initializeAndValidate: vi.fn(async () => {}), getCurrentMetadata: vi.fn(async () => ({ tools: [] })) } } };
        opened.push({ config, handle });
        return handle;
    };
    manager.ensureClient = async () => ({ createSession: async config => open(config),
        resumeSession: async (_id, config) => open(config), deleteSession: async () => {} });
    cleanup.push(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        rmSync(dir, { recursive: true, force: true });
    });
    const id = row.sessionId;
    return {
        manager, opened, source, id,
        turn: (index, config = {}, options = {}) => manager.getOrCreate(id, { model: "gpt-test", ...config }, { turnIndex: index, ...options }),
        capture: () => manager.captureWorkflowToolBinding(id).then(binding => ({ binding }), error => ({ error })),
    };
}

/** The chat can hand its tools to a workflow: its parent context is recorded and a binding is captured. */
async function expectBindable(h) {
    expect(h.manager.workflowParentConfigs.has(h.id), "the workflow parent context is recorded").toBe(true);
    const { binding, error } = await h.capture();
    expect(error?.code, error?.message).not.toBe(CODE);
    expect(error, error?.message).toBeUndefined();
    expect(binding).toMatchObject({ policy: "node-parent-tools-v1", parentSessionId: h.id });
}

describe("a chat keeps its workflow parent context through every path that makes its Copilot session (of-01)", () => {
    it("after use_package (a capability selection rebinds the session)", async () => {
        const h = fixture();
        const first = await h.turn(0);
        await expectBindable(h);
        await expect(first.config.capabilityServices.use({ source_ref: capabilityRef(h.source.id, h.source.revision, "source"),
            tools: ["package_lookup"], mcp_servers: ["package_mcp"], expected_revision: 0, request_id: "attach-1" }))
            .resolves.toEqual({ changed: true, revision: 1 });
        await h.turn(1);
        expect(h.opened).toHaveLength(2);
        expect(h.opened[0].handle.disconnect).toHaveBeenCalledOnce();
        await expectBindable(h);
    });

    it("after a model switch (set_session_model rebinds the session)", async () => {
        const h = fixture();
        await h.turn(0);
        await h.turn(1, { model: "gpt-other" });
        expect(h.opened).toHaveLength(2);
        await expectBindable(h);
        expect(h.manager.workflowParentConfigs.get(h.id).model).toContain("gpt-other");
    });

    it("after an epoch start (session regeneration)", async () => {
        const h = fixture();
        await h.turn(0);
        await h.turn(1, {}, { epochStart: true, transcriptEpoch: 1 });
        expect(h.opened).toHaveLength(2);
        await expectBindable(h);
    });

    it("after a turn-0 reset of a warm session, and on the warm path", async () => {
        const h = fixture();
        await h.turn(0);
        await h.turn(0);
        expect(h.opened).toHaveLength(2);
        await expectBindable(h);
        await h.turn(1);
        expect(h.opened, "the warm session is reused").toHaveLength(2);
        await expectBindable(h);
    });

    it("with no warm session the refusal is coded and in plain words", async () => {
        const h = fixture();
        await h.turn(0);
        await h.manager.dropWarmSession(h.id);
        const { error } = await h.capture();
        expect(error?.code).toBe(CODE);
        expect(error.message).toBe("The workflow was not created: this chat's tools were not ready to hand to a workflow. "
            + "Nothing was started. Call spawn_workflow again; if it is refused again, tell the user.");
    });
});

// ── A real worker ───────────────────────────────────────────────────────────────────────────────────────────────

const TIMEOUT = 240_000;
const CHAT_OWNER = { provider: "test", subject: "workflow-parent-context-owner" };
const SECOND_MODEL = "fixture-model-b";
const SWITCH = "Switch to the second model, then create the draft workflow.";
const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: after-switch, version: "1.0.0" }
initial: pause
states:
  pause: { type: wait, seconds: 1, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

const getEnv = useSuiteEnv(import.meta.url);

async function until(check, label, timeoutMs = 150_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

describe("a definition saved in the first turn after a model switch, on a real worker (of-01)", () => {
    // Stage 2.1: a save makes revision 1 of the chat's definition (no Workflow row). spawn_workflow is no longer declared
    // (owner 2026-11-08T16:55Z): workflow_definition carries the same parent context; the chat has Workflows on.
    it("is admitted: the chat's definition is saved and no refusal is recorded", { timeout: TIMEOUT }, async () => {
        let spawnCalled = false;
        const respond = (body, position) => {
            // The first request on the second model is the first turn after the rebind: it creates the workflow there.
            if (body?.model === SECOND_MODEL) {
                if (!spawnCalled) {
                    spawnCalled = true;
                    return { tools: [{ name: "workflow_definition", args: { operation: "save", name: "after-switch", yaml: YAML } }] };
                }
                return { content: "Created the draft." };
            }
            if (position.lastUserText.includes(SWITCH) && position.step === 0) {
                return { tools: [{ name: "set_session_model", args: { model: `${FIXTURE_PROVIDER}:${SECOND_MODEL}` } }] };
            }
            return { content: "ok" };
        };
        await withScriptedModel(getEnv(), { respond, extraModels: [SECOND_MODEL], worker: { workflowScripts: { enabled: true } } },
            async ({ client, qualifiedModel }) => {
                const chat = await client.createSession({ model: qualifiedModel, owner: CHAT_OWNER });
                await turnWorkflowsOn(client._catalog, chat.sessionId);
                await chat.send(SWITCH);
                const store = client._catalog.workflowStore();
                const saved = await until(async () => (await store.chat.listDefinitions(chat.sessionId))[0] ?? null, "the chat's definition");
                expect(saved).toMatchObject({ ownerSessionId: chat.sessionId, currentRevision: 1 });
                expect(spawnCalled).toBe(true);
                const results = await client._catalog.getSessionEvents(chat.sessionId, 0, 500, ["tool.execution_complete"]);
                expect(JSON.stringify(results)).not.toContain(CODE);
                expect(JSON.stringify(results)).not.toContain("workflow_definition failed");
            });
    });
});
