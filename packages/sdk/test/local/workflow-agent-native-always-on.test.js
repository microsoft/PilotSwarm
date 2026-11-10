/**
 * Workflow agent node under the always-on flags (0.8.10, PR 272), on the real Copilot SDK/CLI with scripted local
 * inference: the session a Workflow agent node runs in (workflowAgentChild) now always gets native tasks and Base Agent V2,
 * whatever the stored flag settings say, and its `tools:` limit (FU-17, review S2RT-F1) still narrows the native task
 * agents it starts.
 *
 * - The cluster setting and the owner's own setting both turn copilot.native_tasks OFF: it stays on (always on). The
 *   session has the swarm-* profiles and the native delegation guidance.
 * - The state's session (tools: [task, view, read_facts]) is offered only those, and complete_workflow_node: PilotSwarm's own
 *   tools too (Copilot CLI 1.0.83's availableTools cuts only its own and MCP tools; the session manager cuts the rest). A
 *   PilotSwarm tool it guesses anyway (store_fact) never runs.
 * - The native task it starts is declared only `view` (the native tools within the limit): no bash, no task, no
 *   complete_workflow_node. A bash call it guesses anyway is refused by the child hook, in the limit's words.
 * - Without a limit, the same session's native task gets its usual tools (bash among them).
 *
 * The local PostgreSQL case test/local/workflow-agent-tool-limit.test.js shows a started Workflow agent node's turn
 * gives its session exactly this config (workflowAgentChild, workflowToolLimit); this file takes that config through the
 * real session manager and CLI. No PostgreSQL is needed here.
 *
 * Run: npx vitest run test/local/workflow-agent-native-always-on.test.js
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { isAlwaysOn } from "../../src/feature-flags.ts";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";
import { createFeaturePolicy } from "../helpers/feature-policy.mjs";

const MODEL = "gpt-5.6-terra";
const LIMIT = ["task", "view", "read_facts"];
const OWNER = { provider: "test", subject: "workflow-owner" };
const names = body => (body.tools ?? []).map(tool => tool.function?.name);
/** The Workflow agent node's own session: the only one offered complete_workflow_node. */
const stateSession = body => names(body).includes("complete_workflow_node");
const systemPrompt = body => body.messages.filter(m => m.role === "system").map(m =>
    typeof m.content === "string" ? m.content : m.content.map(part => part.text ?? "").join("\n")).join("\n");
const nativeTask = { name: "task", args: { name: "probe", agent_type: "swarm-task", description: "Run the fixture command",
    prompt: "Run the fixture command and report its output", mode: "sync" } };
const bashCall = { name: "bash", args: { command: "echo BASH_RAN", description: "fixture", mode: "sync" } };
const guessedStoreFact = { name: "store_fact", args: { key: "guessed/outside-limit", value: "STORED" } };

/** One Workflow agent node session (limit or none), with copilot.native_tasks set OFF at the cluster and for its owner. */
async function stateSessionTurn(workflowToolLimit) {
    const home = mkdtempSync(join(tmpdir(), "ps-wf-native-"));
    const childRequests = [];
    const server = await createNativeCopilotProvider(body => {
        if (stateSession(body)) {
            // The state's session first guesses store_fact (outside its limit), then starts the native task, then finishes.
            const toolTurns = body.messages.filter(message => message.role === "tool").length;
            if (workflowToolLimit && toolTurns === 0) return { tools: [guessedStoreFact] };
            if (toolTurns < (workflowToolLimit ? 2 : 1)) return { tools: [nativeTask] };
            return { content: "STATE_DONE" };
        }
        childRequests.push(body);
        // The native task guesses bash whatever it was declared, then reports what it got back.
        return body.messages.at(-1).role === "tool" ? { content: String(body.messages.at(-1).content) } : { tools: [bashCall] };
    });
    const registry = new ModelProviderRegistry({ providers: [{ id: "fixture", type: "openai", baseUrl: server.baseUrl, apiKey: "synthetic", models: [MODEL] }] });
    const policy = await createFeaturePolicy(false);
    await policy.setForUser(OWNER, false);
    const sessionId = randomUUID();
    const manager = new SessionManager(undefined, null, { nativeSubagents: "sync", modelProviders: registry, turnTimeoutMs: 30_000 }, join(home, "session-state"));
    manager.setFeatureFlagCache(policy.cache);
    const stored = [];
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }), storeFact: async (...args) => { stored.push(args); return { stored: true }; }, deleteFact: async () => ({ deleted: true }) });
    // The config a Workflow agent node's turn gives its session (workflow-agent-tool-limit.test.js on PostgreSQL).
    const config = { model: `fixture:${MODEL}`, workingDirectory: home, workflowAgentChild: true, ...(workflowToolLimit ? { workflowToolLimit } : {}) };
    manager.setConfig(sessionId, config);
    try {
        const managed = await manager.getOrCreate(sessionId, config, { turnIndex: 0 });
        const events = [];
        const result = await managed.runTurn("Do the step", { onEvent: event => events.push(event) });
        const agents = (await managed.getCopilotSession().rpc.agent.list()).agents.map(agent => agent.name);
        return { result, agents, events, childRequests, stored, stateRequests: server.requests.filter(stateSession) };
    } finally {
        await manager.shutdown();
        await policy.cache.stop();
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
}

describe("a Workflow agent node under the always-on flags: native tasks on, narrowed by its tools: limit", () => {
    it("tools: [task, view, read_facts]: native tasks stay on with the flag set OFF, and the task gets only view; bash is refused", { timeout: 90_000 }, async () => {
        expect(isAlwaysOn("copilot.native_tasks")).toBe(true);
        expect(isAlwaysOn("agents.base_v2")).toBe(true);
        const run = await stateSessionTurn(LIMIT);
        expect(run.result.type, JSON.stringify(run.result)).toBe("completed");
        // Always on: the cluster and the owner set it OFF, and the session still has the native profiles and guidance.
        expect(run.agents).toEqual(expect.arrayContaining(["swarm-explore", "swarm-task"]));
        expect(systemPrompt(run.stateRequests[0])).toContain("## Native local delegation");
        // The state's session is offered its limit and complete_workflow_node only, on every request.
        for (const request of run.stateRequests) expect(names(request).sort()).toEqual([...LIMIT, "complete_workflow_node"].sort());
        // The store_fact it guessed never reached the fact store.
        expect(run.stored).toEqual([]);
        expect(String(run.stateRequests[1].messages.at(-1).content)).toMatch(/Tool 'store_fact' does not exist/);
        // The native task it started is declared only the native tools within the limit.
        expect(run.childRequests.length).toBeGreaterThan(0);
        for (const request of run.childRequests) expect(names(request).sort()).toEqual(["view"]);
        // Its guessed bash is refused, in the limit's words, and never runs.
        const answer = String(run.childRequests.at(-1).messages.at(-1).content);
        expect(answer).toMatch(/This Workflow step limits its tools; a native task cannot use bash\./);
        expect(answer).not.toContain("BASH_RAN");
    });

    it("no limit: the same session's native task gets its usual tools, bash among them", { timeout: 90_000 }, async () => {
        const run = await stateSessionTurn(null);
        expect(run.result.type, JSON.stringify(run.result)).toBe("completed");
        expect(run.agents).toEqual(expect.arrayContaining(["swarm-task"]));
        expect(names(run.childRequests[0])).toEqual(expect.arrayContaining(["bash", "view"]));
        expect(String(run.childRequests.at(-1).messages.at(-1).content)).toContain("BASH_RAN");
    });
});
