/**
 * The CLI's own `skill` tool and the Workflow skills, through the real Copilot CLI (1.0.83; scripted local inference, no
 * database).
 *
 * Owner ruling (2026-11-08): the CLI's `skill` tool stays; it must succeed for the Workflow skills. Every worker loads the
 * Workflow skill directory (worker.ts _loadSdkSkillDir) and passes it to the CLI as a skill directory. The CLI's `skill`
 * tool serves those directories and lists their skills in its own description (an <available_skills> block). So:
 *
 * - Workflows off in the chat: the CLI is not given the Workflow skill directory (session-manager.ts cliSkillDirectories):
 *   the `skill` tool lists no Workflow skill and does not serve one; the chat's paragraph names enable_workflows. Before,
 *   an off chat's `skill` tool listed all four Workflow skills and served them.
 * - Workflows on: the `skill` tool lists them, and `skill` with skill `workflow-authoring` succeeds with the body
 *   ("# Workflow authoring"), as load_skill does.
 * - The deployed failure ("skill — name: workflow-authoring · Failed"): the `skill` tool takes `skill`, not `name`
 *   ({"skill": string}, required), and the CLI refused `{ name }` with '"skill": Required'. A call with `name` is now given
 *   it as `skill` (session-manager.ts withSkillNameArgument) and succeeds.
 *
 * Base Agent V1 (skillDirectories) and V2 (getBaseV2SkillDirectories, with native tasks) both.
 *
 * Run: npx vitest run test/local/workflow-skills-cli-skill-tool.test.js
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { WORKFLOW_SKILLS_DIR } from "../../src/workflow/guidance.ts";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";
import { createFeaturePolicy } from "../helpers/feature-policy.mjs";

const MODEL = "gpt-5.6-terra";
const owner = { provider: "test", subject: "workflow-skills-cli-skill-tool", email: null, displayName: null };
const WORKFLOW_SKILLS = ["workflow-authoring", "workflow-patterns", "workflow-reference", "workflow-tools"];
const AUTHORING_HEADING = /^# Workflow authoring$/m;

/**
 * A chat on a manager given the worker's skill directories (the Workflow skill directory and another deployment one), the
 * real CLI and a scripted model that makes `calls` once per turn, then answers. Workflows are off until `on()`.
 */
async function harness({ native }, run) {
    const home = mkdtempSync(join(tmpdir(), "ps-workflow-skills-cli-"));
    // Another deployment skill directory, given in every chat: the rule takes out only the Workflow skill directories.
    const otherSkills = join(home, "deployment-skills");
    mkdirSync(join(otherSkills, "notes-helper"), { recursive: true });
    writeFileSync(join(otherSkills, "notes-helper", "SKILL.md"), "---\nname: notes-helper\ndescription: Keeps notes.\n---\n\n# Notes helper\n\nKeep notes.\n");
    const dirs = [WORKFLOW_SKILLS_DIR, otherSkills];
    const sessionId = randomUUID();
    let state = { revision: 0, selections: [] };
    const row = { sessionId, owner, isSystem: false, parentSessionId: null, rootSessionId: sessionId };
    const catalog = {
        getSession: async id => (id === sessionId ? row : null),
        getUserRole: async () => ({ role: "user", seenAt: new Date() }),
        recordEvents: async () => {},
        getSessionCapabilities: async () => structuredClone(state),
        saveSessionCapabilities: async (_id, expected, next) => {
            if (state.revision !== expected) return false;
            state = structuredClone(next);
            return true;
        },
    };
    const requests = [];
    let calls = [];
    let called = false;
    const server = await createNativeCopilotProvider(body => {
        requests.push(body);
        if (called) return { content: "Done." };
        called = true;
        return { tools: calls };
    });
    const registry = new ModelProviderRegistry({ providers: [{ id: "fixture", type: "openai", baseUrl: server.baseUrl, apiKey: "synthetic", models: [MODEL] }] });
    const policy = await createFeaturePolicy();
    const manager = new SessionManager(undefined, null, { nativeSubagents: native ? "sync" : "off", modelProviders: registry, turnTimeoutMs: 30_000,
        skillDirectories: dirs, getBaseV2SkillDirectories: () => dirs }, join(home, "session-state"));
    manager.workflowScriptsEnabled = true;
    manager.setFeatureFlagCache(policy.cache);
    manager.setSessionCatalog(catalog);
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    let index = 0;
    /** One turn whose model makes `toolCalls` once: the chat's mode and Base Agent version, its `skill` tool, the completions. */
    const turn = async (toolCalls) => {
        calls = toolCalls;
        called = false;
        const events = [];
        const from = requests.length;
        const managed = await manager.getOrCreate(sessionId, { model: `fixture:${MODEL}`, workingDirectory: home, workflowMilestoneTurn: true },
            { turnIndex: index++ });
        await managed.runTurn(`turn ${index}`, { onEvent: event => events.push(event) });
        const first = requests[from];
        const skillTool = (first.tools ?? []).find(tool => tool.function?.name === "skill");
        // In the order the model made the calls (the CLI runs a response's calls at once; their ids end in their index).
        const done = events.filter(event => event.eventType === "tool.execution_complete" && event.data?.toolName === "skill")
            .sort((a, b) => Number(a.data.toolCallId.split("-").at(-1)) - Number(b.data.toolCallId.split("-").at(-1)));
        return { mode: managed.config.workflowContext, policy: managed.config.baseAgentPolicy?.version, skillTool, done };
    };
    try {
        await run({ turn, on: () => { state = { ...state, revision: state.revision + 1, workflows: true }; } });
    } finally {
        await manager.shutdown();
        await policy.cache.stop();
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
}

/** The skills the CLI's `skill` tool lists in its description (<available_skills>). */
const listed = skillTool => [...String(skillTool?.function?.description ?? "").matchAll(/<name>([^<]+)<\/name>/g)].map(match => match[1]).sort();
const succeeded = event => event.data.success === true && !event.data.error;
const body = event => `${event.data.result?.detailedContent ?? ""}\n${event.data.result?.content ?? ""}`;

describe("the CLI's skill tool serves the Workflow skills where Workflows are on", () => {
    for (const native of [false, true]) {
        it(`Base ${native ? "V2" : "V1"}: off, no Workflow skill is listed or served; on, they are listed and workflow-authoring loads`, { timeout: 90_000 }, async () => {
            await harness({ native }, async ({ turn, on }) => {
                const off = await turn([{ name: "skill", args: { skill: "workflow-authoring" } }, { name: "skill", args: { skill: "notes-helper" } }]);
                expect(off.mode).toBe("off");
                expect(off.policy).toBe(native ? "v2" : "v1");
                expect(off.skillTool, "the CLI's skill tool is declared (not excluded)").toBeDefined();
                expect(listed(off.skillTool)).toEqual(["notes-helper"]);
                const [offAuthoring, offOther] = off.done;
                expect(offAuthoring.data.arguments).toEqual({ skill: "workflow-authoring" });
                expect(succeeded(offAuthoring), JSON.stringify(offAuthoring.data)).toBe(false);
                expect(offAuthoring.data.error?.message).toBe("Skill not found: workflow-authoring");
                expect(succeeded(offOther), "another deployment skill still loads").toBe(true);

                on();
                const shown = await turn([{ name: "skill", args: { skill: "workflow-authoring" } }]);
                expect(shown.mode).toBe("on");
                expect(listed(shown.skillTool)).toEqual([...WORKFLOW_SKILLS, "notes-helper"].sort());
                const [loaded] = shown.done;
                expect(succeeded(loaded), JSON.stringify(loaded.data)).toBe(true);
                expect(body(loaded)).toMatch(AUTHORING_HEADING);
            });
        });
    }

    it("a call of skill with `name` (load_skill's argument) is given it as `skill` and succeeds", { timeout: 90_000 }, async () => {
        await harness({ native: false }, async ({ turn, on }) => {
            on();
            const { mode, done } = await turn([{ name: "skill", args: { name: "workflow-authoring" } }, { name: "skill", args: { skill: "workflow-reference" } }]);
            expect(mode).toBe("on");
            const [byName, bySkill] = done;
            expect(succeeded(byName), JSON.stringify(byName.data)).toBe(true);
            expect(body(byName)).toMatch(AUTHORING_HEADING);
            expect(succeeded(bySkill), JSON.stringify(bySkill.data)).toBe(true);
            expect(body(bySkill)).toMatch(/^# Workflow reference$/m);
        });
    });
});
