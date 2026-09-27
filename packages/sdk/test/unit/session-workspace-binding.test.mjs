/**
 * Session workspaces: what SessionManager does with a workspace
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
import { orchestrationSupportsWorkspaces } from "../../dist/workspace.js";

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
    // One log for every handle: task calls and disconnects, in order.
    const log = [];
    const open = (kind, config) => {
        const tasks = new Map();
        const handle = {
            disconnected: false,
            tasks,
            // A test sets this to stand in for a CLI frozen by a hung mount.
            hang: false,
            disconnect: async () => { log.push(`disconnect:${config.sessionId}`); handle.disconnected = true; },
            rpc: {
                tasks: {
                    list: async () => {
                        if (handle.hang) return new Promise(() => {});
                        log.push(`list:${config.sessionId}`);
                        return { tasks: [...tasks.values()] };
                    },
                    cancel: async ({ id }) => {
                        log.push(`cancel:${config.sessionId}:${id}`);
                        tasks.delete(id);
                        return { cancelled: true };
                    },
                },
            },
        };
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
    return { manager, calls, clientArgs, log };
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

test("a cleared workspace does not survive in the stored config; the folder stays explicit and hooks stay off (review R1)", async (t) => {
    const h = fixture(t);
    h.manager.setConfig("s1", { workspace: WORKSPACE });
    await h.manager.getOrCreate("s1", { workspace: WORKSPACE, workspaceAttach: attach() }, { turnIndex: 0 });
    // The runTurn activity marks a turn after a clear: its revision is above 0.
    const cleared = await h.manager.getOrCreate("s1", { workspaceCleared: true }, { turnIndex: 1 });
    const sdk = h.calls.at(-1).config;
    assert.equal(sdk.workingDirectory, process.cwd(), "explicit: a resume without a folder falls back to the checkout");
    assert.equal(sdk.enableFileHooks, false);
    assert.equal(cleared.config.workspace, undefined);
    assert.equal(cleared.config.workspaceAttach, undefined);
    assert.equal(h.clientArgs.at(-1)[2], undefined);

    const own = fixture(t);
    await own.manager.getOrCreate("s2", { workspace: WORKSPACE, workspaceAttach: attach() }, { turnIndex: 0 });
    await own.manager.getOrCreate("s2", { workingDirectory: "/home/app", workspaceCleared: true }, { turnIndex: 1 });
    assert.equal(own.calls.at(-1).config.workingDirectory, "/home/app", "a configured folder still wins");
});

test("a turn of an orchestration before 1.0.80 gets no workspace tools; the next turn gets them back (review F3)", async (t) => {
    assert.equal(orchestrationSupportsWorkspaces("1.0.79"), false);
    assert.equal(orchestrationSupportsWorkspaces("1.0.8"), false);
    assert.equal(orchestrationSupportsWorkspaces("0.9.99"), false);
    for (const version of ["1.0.80", "1.0.100", "1.1.0", "2.0.0", undefined, "", "next"]) {
        assert.equal(orchestrationSupportsWorkspaces(version), true, String(version));
    }
    const names = (tools) => tools.map((tool) => tool.name);
    const spawnProps = (tools) => Object.keys(tools.find((tool) => tool.name === "spawn_agent").parameters.properties);
    const h = fixture(t);
    await h.manager.getOrCreate("asks", { toolNames: ["set_session_workspace"], workspaceToolsBlocked: true }, { turnIndex: 0 });
    assert.equal(names(h.calls.at(-1).config.tools).some((n) => n.includes("session_workspace")), false);
    assert.equal(spawnProps(h.calls.at(-1).config.tools).includes("workspace"), false);
    // The mark is per turn: after the continue-as-new into 1.0.80 the tools come back.
    await h.manager.getOrCreate("asks", { toolNames: ["set_session_workspace"] }, { turnIndex: 1 });
    assert.ok(names(h.calls.at(-1).config.tools).includes("set_session_workspace"));
    assert.equal(spawnProps(h.calls.at(-1).config.tools).includes("workspace"), true);
});

test("every drop of a warm workspace session stops its background tasks before the disconnect (review R2)", async (t) => {
    const h = fixture(t);
    const warm = async (id, config = {}) => {
        await h.manager.getOrCreate(id, { workspace: WORKSPACE, workspaceAttach: attach(), ...config }, { turnIndex: 0 });
        h.calls.at(-1).handle.tasks.set("t1", { id: "t1", type: "agent", status: "running" });
    };
    const sequence = (id) => h.log.filter((entry) => entry.includes(`:${id}`)).map((entry) => entry.split(":")[0]);

    await warm("drop");
    await h.manager.dropWarmSession("drop");
    assert.deepEqual(sequence("drop"), ["list", "cancel", "list", "disconnect"]);

    await warm("invalidate");
    await h.manager.invalidateWarmSession("invalidate");
    assert.deepEqual(sequence("invalidate"), ["list", "cancel", "list", "disconnect"]);

    await warm("epoch");
    await h.manager.getOrCreate("epoch", { workspace: WORKSPACE, workspaceAttach: attach() }, { turnIndex: 1, epochStart: true, transcriptEpoch: 1 });
    assert.deepEqual(sequence("epoch").slice(0, 4), ["list", "cancel", "list", "disconnect"]);

    // Another root and a clear change the CLI process too; the release runs first.
    await warm("root");
    await h.manager.getOrCreate("root", { workspace: { schema: 1, root: "b", folder: "repo-x" }, workspaceAttach: { ...attach(), root: "b", rootPath: "/ws/b", path: "/ws/b/repo-x", realPath: "/ws/b/repo-x" } }, { turnIndex: 1 });
    assert.deepEqual(sequence("root"), ["list", "cancel", "list", "disconnect"]);

    await warm("clear");
    await h.manager.getOrCreate("clear", { workspaceCleared: true }, { turnIndex: 1 });
    assert.deepEqual(sequence("clear"), ["list", "cancel", "list", "disconnect"]);

    // A session without a workspace is dropped as before.
    await h.manager.getOrCreate("plain", {}, { turnIndex: 0 });
    await h.manager.dropWarmSession("plain");
    assert.deepEqual(sequence("plain"), ["disconnect"]);
});

test("a release that arrives after a newer turn attached under a new affinity key leaves that attach alone (review F7)", async (t) => {
    const h = fixture(t);
    const newer = { ...attach(), turnIndex: 5, affinityKey: "key-B" };
    await h.manager.getOrCreate("s1", { workspace: WORKSPACE, workspaceAttach: newer }, { turnIndex: 0 });
    const late = await h.manager.releaseWorkspace("s1", { reason: "idle", workerNodeId: "w", turnIndex: 5, affinityKey: "key-A" });
    assert.deepEqual(late, { released: false, cancelled: 0, detail: "a newer turn (5) holds the workspace here" });
    assert.equal(h.calls.at(-1).handle.disconnected, false);

    // Under the same key (a turn that threw), or for an older attach, the release runs.
    const same = await h.manager.releaseWorkspace("s1", { reason: "error", workerNodeId: "w", turnIndex: 5, affinityKey: "key-B" });
    assert.equal(same.released, true);
    await h.manager.getOrCreate("s2", { workspace: WORKSPACE, workspaceAttach: { ...attach(), turnIndex: 4, affinityKey: "key-A" } }, { turnIndex: 0 });
    const older = await h.manager.releaseWorkspace("s2", { reason: "idle", workerNodeId: "w", turnIndex: 5, affinityKey: "key-B" });
    assert.equal(older.released, true);
});

test("a release gives up on a frozen CLI at its deadline, and shutdown releases run side by side (review R9)", { timeout: 10_000 }, async (t) => {
    const h = fixture(t);
    for (const id of ["f1", "f2"]) {
        await h.manager.getOrCreate(id, { workspace: WORKSPACE, workspaceAttach: attach() }, { turnIndex: 0 });
        h.calls.at(-1).handle.hang = true;
    }
    const started = Date.now();
    const one = await h.manager.releaseWorkspace("f1", { reason: "idle", workerNodeId: "w", deadlineMs: 200 });
    assert.equal(one.released, true);
    assert.match(one.detail, /did not finish within 200 ms/);
    assert.equal(h.manager.sessions.has("f1"), false, "the handle is dropped anyway");

    await h.manager.getOrCreate("f3", { workspace: WORKSPACE, workspaceAttach: attach() }, { turnIndex: 0 });
    h.calls.at(-1).handle.hang = true;
    const before = Date.now();
    const released = await h.manager.releaseIdleWorkspaces({ reason: "shutdown", workerNodeId: "w", deadlineMs: 300 });
    assert.equal(released, 2);
    assert.ok(Date.now() - before < 550, `side by side, not one after the other (${Date.now() - before} ms)`);
    assert.ok(Date.now() - started < 2_000);
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

    // spawn_agent's workspace parameter follows the same rule, in the
    // declaration the model sees (subAgentToolDefs).
    const spawnProps = (tools) => Object.keys(tools.find((tool) => tool.name === "spawn_agent").parameters.properties);
    assert.equal(spawnProps(plain.calls.at(-1).config.tools).includes("workspace"), false);
    assert.equal(spawnProps(withWorkspace.calls.at(-1).config.tools).includes("workspace"), true);
    assert.deepEqual(spawnProps(ManagedSession.subAgentToolDefs()), spawnProps(ManagedSession.subAgentToolDefs({ workspaceTools: true })).filter((n) => n !== "workspace"),
        "the other parameters are unchanged");
});

test("the deny hook refuses every tool once a workspace change is requested or pending, and is absent otherwise (review R3)", async () => {
    const inner = { onPreToolUse: async () => ({ modifiedArgs: { x: 1 } }) };
    assert.equal(withWorkspaceChangeDeny(inner, null), inner, "no hook without workspace tools");
    let state = "none";
    let requested = 0;
    const change = { state: () => state, noteRequested: () => { requested += 1; state = "requested"; } };
    const wrapped = withWorkspaceChangeDeny(inner, change);
    assert.deepEqual(await wrapped.onPreToolUse({ toolName: "bash" }, {}), { modifiedArgs: { x: 1 } });
    // The CLI runs every pre-tool hook of a message before any handler, so
    // the set call itself marks the change and the call after it is refused.
    assert.deepEqual(await wrapped.onPreToolUse({ toolName: "set_session_workspace" }, {}), { modifiedArgs: { x: 1 } });
    assert.equal(requested, 1);
    const waiting = await wrapped.onPreToolUse({ toolName: "bash" }, {});
    assert.equal(waiting.permissionDecision, "deny");
    assert.match(waiting.permissionDecisionReason, /has not answered yet/);
    state = "accepted";
    const denied = await wrapped.onPreToolUse({ toolName: "bash" }, {});
    assert.equal(denied.permissionDecision, "deny");
    assert.match(denied.permissionDecisionReason, /working directory is changing/);

    // A set call another hook refuses marks nothing.
    state = "none";
    requested = 0;
    const refusing = withWorkspaceChangeDeny({ onPreToolUse: async () => ({ permissionDecision: "deny", permissionDecisionReason: "no" }) }, change);
    await refusing.onPreToolUse({ toolName: "set_session_workspace" }, {});
    assert.equal(requested, 0);
});

// ── Extra folders (section 4.10) ─────────────────────────────────

test("extra folders reach the CLI as additional directories on create and on resume; a session without them gets no such key", async (t) => {
    const h = fixture(t);
    const extras = [
        { name: "logs", root: "logs", rootPath: "/ws/logs", path: "/ws/logs/svc", realPath: "/ws/logs/svc", required: false },
        { name: "shared", root: "shared", rootPath: "/ws/shared", path: "/ws/shared/notes", realPath: "/ws/shared/notes", required: true },
    ];
    const workspace = { ...WORKSPACE, extra: { logs: { root: "logs", folder: "svc", required: false }, shared: { root: "shared", folder: "notes" } } };
    await h.manager.getOrCreate("s1", { workspace, workspaceAttach: { ...attach(), extras } }, { turnIndex: 0 });
    assert.equal(h.calls.at(-1).kind, "create");
    assert.deepEqual(h.calls.at(-1).config.additionalDirectories, ["/ws/logs/svc", "/ws/shared/notes"]);
    assert.equal(h.calls.at(-1).config.workingDirectory, "/ws/a/repo-x");

    // A new handle (new working folder) passes them again: the CLI keeps
    // them only until a cold resume.
    await h.manager.getOrCreate("s1", { workspace: { ...workspace, folder: "repo-y" }, workspaceAttach: { ...attach("repo-y"), extras } }, { turnIndex: 1 });
    assert.equal(h.calls.at(-1).kind, "resume");
    assert.deepEqual(h.calls.at(-1).config.additionalDirectories, ["/ws/logs/svc", "/ws/shared/notes"]);

    // An optional folder that could not be attached is not passed.
    await h.manager.getOrCreate("s2", {
        workspace, workspaceAttach: { ...attach(), extras: [extras[1]], extrasUnavailable: [{ name: "logs", root: "logs", folder: "svc", code: "WORKSPACE_NOT_MOUNTED", message: "no marker" }] },
    }, { turnIndex: 0 });
    assert.deepEqual(h.calls.at(-1).config.additionalDirectories, ["/ws/shared/notes"]);

    await h.manager.getOrCreate("s3", { workspace: WORKSPACE, workspaceAttach: attach() }, { turnIndex: 0 });
    assert.equal("additionalDirectories" in h.calls.at(-1).config, false, "no extra folders, no key");
    await h.manager.getOrCreate("plain", { workingDirectory: "/home/app" }, { turnIndex: 0 });
    assert.equal("additionalDirectories" in h.calls.at(-1).config, false);
});

test("a change of extra folders keeps the warm session: they are not part of the fingerprint", async (t) => {
    const h = fixture(t);
    const first = await h.manager.getOrCreate("s1", { workspace: WORKSPACE, workspaceAttach: attach() }, { turnIndex: 0 });
    const withLogs = {
        workspace: { ...WORKSPACE, extra: { logs: { root: "logs", folder: "svc" } } },
        workspaceAttach: { ...attach(), extras: [{ name: "logs", root: "logs", rootPath: "/ws/logs", path: "/ws/logs/svc", realPath: "/ws/logs/svc", required: true }] },
    };
    const same = await h.manager.getOrCreate("s1", withLogs, { turnIndex: 1 });
    assert.equal(same, first, "adding an extra folder keeps the handle, so running shells keep running");
    assert.equal(h.calls.length, 1);
    const digest = (extras) => bindingFingerprintDigest(buildBindingFingerprintInput({
        capabilityFingerprint: "c", baseAgentPolicy: undefined, sdkSkillDirectories: [], boundAgentName: undefined,
        boundAgentSource: undefined, boundAgentCopy: undefined, mcpServers: {}, excludedTools: [], tools: [],
        workspace: { path: "/ws/a/repo-x", adopt: null, ...(extras ? { extras } : {}) },
    }));
    assert.equal(digest(undefined), digest(["/ws/logs/svc"]), "the fingerprint input ignores anything but path, adopt and the repo hash");
});

test("an extra-folder-only set call marks no change, so the calls after it in the same message run", async () => {
    const inner = { onPreToolUse: async () => ({ modifiedArgs: { x: 1 } }) };
    let state = "none";
    let requested = 0;
    const change = { state: () => state, noteRequested: () => { requested += 1; state = "requested"; } };
    const wrapped = withWorkspaceChangeDeny(inner, change);
    await wrapped.onPreToolUse({ toolName: "set_session_workspace", toolArgs: { extra: { logs: { root: "logs", folder: "svc" } } } }, {});
    await wrapped.onPreToolUse({ toolName: "set_session_workspace", toolArgs: JSON.stringify({ extra: { logs: null } }) }, {});
    assert.equal(requested, 0);
    assert.deepEqual(await wrapped.onPreToolUse({ toolName: "bash" }, {}), { modifiedArgs: { x: 1 } }, "the next call is not denied");

    await wrapped.onPreToolUse({ toolName: "set_session_workspace", toolArgs: { root: "a", folder: "repo-y", extra: { logs: null } } }, {});
    assert.equal(requested, 1, "a call that also moves the working folder is a change");
    assert.equal((await wrapped.onPreToolUse({ toolName: "bash" }, {})).permissionDecision, "deny");
});
