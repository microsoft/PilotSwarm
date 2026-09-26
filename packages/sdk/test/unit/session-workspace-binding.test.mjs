/**
 * Session workspaces, slice B: what SessionManager does with a workspace
 * session's attach result, with the Copilot transport stubbed (the
 * session-agent-binding-lifecycle pattern). Covers the in-process half of
 * test C3 in docs/proposals/session-workspaces.md; the digest comparison
 * against the merge-base is the differential run (npm run test:differential).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    SessionManager,
    buildBindingFingerprintInput,
    bindingFingerprintDigest,
    keepAdoptedRepoInstructions,
    withWorkspaceChangeDeny,
} from "../../dist/session-manager.js";
import { ManagedSession } from "../../dist/managed-session.js";

const WORKSPACE = { schema: 1, root: "a", folder: "repo-x" };
const attach = (folder = "repo-x", adopt) => ({
    root: "a", rootPath: "/ws/a", path: `/ws/a/${folder}`, realPath: `/ws/a/${folder}`, ...(adopt ? { adopt } : {}),
});

function fixture(t) {
    const home = mkdtempSync(join(tmpdir(), "ps-ws-binding-"));
    const calls = [];
    const clientArgs = [];
    const manager = new SessionManager(undefined, null, {}, home);
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    const open = (kind, config) => {
        const handle = { disconnected: false, disconnect: async () => { handle.disconnected = true; } };
        calls.push({ kind, config, handle });
        mkdirSync(join(home, config.sessionId), { recursive: true });
        return handle;
    };
    manager.ensureClient = async (...args) => {
        clientArgs.push(args);
        return {
            createSession: async (config) => open("create", config),
            resumeSession: async (_id, config) => open("resume", config),
            deleteSession: async () => {},
        };
    };
    t.after(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        rmSync(home, { recursive: true, force: true });
    });
    return { manager, calls, clientArgs };
}

test("a workspace session gets the attach path as its cwd, repo hooks off, and instructions per adopt", async (t) => {
    const h = fixture(t);
    await h.manager.getOrCreate("s1", { workspace: WORKSPACE, workspaceAttach: attach() }, { turnIndex: 0 });
    const sdk = h.calls.at(-1).config;
    assert.equal(sdk.workingDirectory, "/ws/a/repo-x");
    assert.equal(sdk.enableFileHooks, false);
    assert.equal(sdk.skipCustomInstructions, true, "no adopt: instructions stay off");

    const adopting = fixture(t);
    await adopting.manager.getOrCreate("s2", {
        workspace: WORKSPACE, workspaceAttach: attach("repo-x", { agents: false, skills: false, instructions: true }),
    }, { turnIndex: 0 });
    assert.equal(adopting.calls.at(-1).config.skipCustomInstructions, false);
});

test("a session without a workspace gets no new SDK keys, its own cwd, and the plain pool key", async (t) => {
    const h = fixture(t);
    await h.manager.getOrCreate("plain", { workingDirectory: "/home/app" }, { turnIndex: 0 });
    const sdk = h.calls.at(-1).config;
    assert.equal(sdk.workingDirectory, "/home/app");
    assert.equal("enableFileHooks" in sdk, false);
    assert.equal("skipCustomInstructions" in sdk, false);
    assert.equal(h.clientArgs.at(-1)[2], undefined, "no workspace root in the pool key");
    assert.equal(h.manager.sessionClientKeys.get("plain").includes("workspace-root"), false);
});

test("the pool key gains the root, so each root gets its own CLI process", async (t) => {
    const h = fixture(t);
    await h.manager.getOrCreate("s1", { workspace: WORKSPACE, workspaceAttach: attach() }, { turnIndex: 0 });
    assert.equal(h.clientArgs.at(-1)[2], "a");
    assert.match(h.manager.sessionClientKeys.get("s1"), /\0workspace-root:a$/);
});

test("the same attach reuses the warm session; a new path or adopt flag resumes the conversation in a new handle", async (t) => {
    const h = fixture(t);
    const first = await h.manager.getOrCreate("s1", { workspace: WORKSPACE, workspaceAttach: attach() }, { turnIndex: 0 });
    const same = await h.manager.getOrCreate("s1", { workspace: WORKSPACE, workspaceAttach: attach() }, { turnIndex: 1 });
    assert.equal(same, first, "an unchanged attach keeps the warm session");
    assert.equal(h.calls.length, 1);

    const moved = await h.manager.getOrCreate("s1", { workspace: { ...WORKSPACE, folder: "repo-y" }, workspaceAttach: attach("repo-y") }, { turnIndex: 2 });
    assert.notEqual(moved, first, "a new path needs a new ManagedSession");
    assert.equal(h.calls.at(-1).kind, "resume");
    assert.equal(h.calls.at(-1).config.workingDirectory, "/ws/a/repo-y");
    assert.equal(h.calls[0].handle.disconnected, true, "the old handle was released");

    const adopted = await h.manager.getOrCreate("s1", {
        workspace: { ...WORKSPACE, folder: "repo-y" },
        workspaceAttach: attach("repo-y", { agents: false, skills: false, instructions: true }),
    }, { turnIndex: 3 });
    assert.notEqual(adopted, moved, "a changed adopt flag needs a new ManagedSession");
    assert.equal(h.calls.at(-1).config.skipCustomInstructions, false);
});

test("a workspace without an attach result fails loudly instead of running in the wrong folder", async (t) => {
    const h = fixture(t);
    await assert.rejects(h.manager.getOrCreate("s1", { workspace: WORKSPACE }, { turnIndex: 0 }), /without an attach result/);
    assert.equal(h.calls.length, 0);
});

test("a cleared workspace does not survive in the stored config", async (t) => {
    const h = fixture(t);
    h.manager.setConfig("s1", { workspace: WORKSPACE });
    await h.manager.getOrCreate("s1", { workspace: WORKSPACE, workspaceAttach: attach() }, { turnIndex: 0 });
    const cleared = await h.manager.getOrCreate("s1", { workingDirectory: "/home/app" }, { turnIndex: 1 });
    const sdk = h.calls.at(-1).config;
    assert.equal(sdk.workingDirectory, "/home/app", "back to config.workingDirectory");
    assert.equal("enableFileHooks" in sdk, false);
    assert.equal(cleared.config.workspace, undefined);
    assert.equal(cleared.config.workspaceAttach, undefined);
    assert.equal(h.clientArgs.at(-1)[2], undefined);
});

test("the fingerprint input has a workspace key only when a workspace is set (C3)", () => {
    const parts = {
        capabilityFingerprint: "cap", baseAgentPolicy: "v1", sdkSkillDirectories: [], boundAgentName: undefined,
        boundAgentSource: undefined, boundAgentCopy: undefined, mcpServers: {}, excludedTools: ["task"], tools: [{ name: "wait" }],
    };
    const plain = buildBindingFingerprintInput(parts);
    assert.deepEqual(Object.keys(plain), ["capabilityFingerprint", "baseAgentPolicy", "boundAgentName", "boundAgentSource", "boundAgentCopy", "mcpServers", "excludedTools", "tools"]);
    // The mechanism the differential run relies on: any extra key, even a
    // null one, changes the digest.
    assert.notEqual(bindingFingerprintDigest({ ...plain, workspace: null }), bindingFingerprintDigest(plain));

    const withWorkspace = buildBindingFingerprintInput({ ...parts, workspace: { path: "/ws/a/repo-x", adopt: null } });
    assert.deepEqual(withWorkspace.workspace, { path: "/ws/a/repo-x", adopt: null });
    assert.notEqual(bindingFingerprintDigest(withWorkspace), bindingFingerprintDigest(plain));
    const hashed = buildBindingFingerprintInput({ ...parts, workspace: { path: "/ws/a/repo-x", adopt: null, repoAgentHash: "h1" } });
    assert.equal(hashed.workspace.repoAgentHash, "h1");
});

test("keepAdoptedRepoInstructions turns only a replaced custom_instructions section into a prepend", () => {
    const message = { mode: "customize", sections: { custom_instructions: { action: "replace", content: "BASE" }, guidelines: { action: "append", content: "G" } } };
    assert.equal(keepAdoptedRepoInstructions(message, false), message, "untouched without adoption");
    const kept = keepAdoptedRepoInstructions(message, true);
    assert.deepEqual(kept.sections.custom_instructions, { action: "prepend", content: "BASE" });
    assert.deepEqual(kept.sections.guidelines, message.sections.guidelines);
    assert.equal(message.sections.custom_instructions.action, "replace", "the input is not mutated");
    assert.equal(keepAdoptedRepoInstructions(undefined, true), undefined);
    const noCustom = { mode: "customize", sections: { guidelines: { action: "append", content: "G" } } };
    assert.equal(keepAdoptedRepoInstructions(noCustom, true), noCustom);
});

test("the workspace tools are declared only for workspace sessions and agents that list them (C6)", async (t) => {
    const names = (tools) => tools.map((tool) => tool.name);
    assert.deepEqual(names(ManagedSession.systemToolDefs({})).filter((n) => n.includes("session_workspace")), []);
    assert.deepEqual(names(ManagedSession.systemToolDefs({ workspaceTools: true })).slice(-2), ["set_session_workspace", "get_session_workspace"]);
    assert.deepEqual(names(ManagedSession.systemToolDefs({})), names(ManagedSession.systemToolDefs({ workspaceTools: true })).slice(0, -2),
        "the other tools keep their order");

    const plain = fixture(t);
    await plain.manager.getOrCreate("plain", {}, { turnIndex: 0 });
    assert.equal(names(plain.calls.at(-1).config.tools).some((n) => n.includes("session_workspace")), false);

    const withWorkspace = fixture(t);
    await withWorkspace.manager.getOrCreate("ws", { workspace: WORKSPACE, workspaceAttach: attach() }, { turnIndex: 0 });
    const wsNames = names(withWorkspace.calls.at(-1).config.tools);
    assert.ok(wsNames.includes("set_session_workspace") && wsNames.includes("get_session_workspace"));

    const asking = fixture(t);
    await asking.manager.getOrCreate("asks", { toolNames: ["set_session_workspace"] }, { turnIndex: 0 });
    assert.ok(names(asking.calls.at(-1).config.tools).includes("set_session_workspace"), "an agent that lists the tool gets it without a workspace");
});

test("the deny hook refuses every tool while a workspace change is pending, and is absent otherwise", async () => {
    const inner = { onPreToolUse: async () => ({ modifiedArgs: { x: 1 } }) };
    assert.equal(withWorkspaceChangeDeny(inner, null), inner, "no hook without workspace tools");
    let pending = false;
    const wrapped = withWorkspaceChangeDeny(inner, () => pending);
    assert.deepEqual(await wrapped.onPreToolUse({ toolName: "bash" }, {}), { modifiedArgs: { x: 1 } });
    pending = true;
    const denied = await wrapped.onPreToolUse({ toolName: "bash" }, {});
    assert.equal(denied.permissionDecision, "deny");
    assert.match(denied.permissionDecisionReason, /working directory is changing/);
});
