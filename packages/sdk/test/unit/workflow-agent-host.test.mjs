/**
 * Workflow agent states, inactive: the host that creates an agent state's
 * child (workflow/agent-host.ts; design 03 agent node, R09 to R11, R16),
 * over fake session rows, a fake agent resolver and a recording child
 * creator.
 *
 * - The child is a child of the workflow, one level below it; a level above
 *   WORKFLOW_MAX_DESCENDANT_LEVEL, or a lineage that cannot be read
 *   (missing or cyclic), is refused before anything is created.
 * - It is owned as a spawned child is (the lineage's effective owner) and
 *   uses the controlling parent agent's model.
 * - An inline prompt has no named agent; a named agent is bound to the
 *   definition the resolver gives for the workflow's owner (asked within
 *   the state's package when it names one), with its own tools only; an unknown one, a worker-managed system agent, and a pinned
 *   package or version that does not match are refused; nothing is created.
 * - The first prompt is sent as the workflow, with the state's client
 *   message id; the client-based creator starts and stops a client for each
 *   child, also when the send fails.
 *
 * Run: node --test test/unit/workflow-agent-host.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    clientWorkflowAgentChildCreator, createWorkflowAgentNodeHost, sessionLevel, SESSION_MAX_NESTING_LEVEL, WORKFLOW_AGENT_PROMPT_SENDER,
} from "../../dist/workflow/agent-host.js";

const OWNER = { provider: "test", subject: "alice", email: null, displayName: null };

/** Session rows: root parent P (owned, a model), workflow W under it. */
function rows(extra = {}) {
    return {
        P: { parentSessionId: null, owner: OWNER, model: "azure-openai:gpt-test", reasoningEffort: "high" },
        W: { parentSessionId: "P", owner: null, sessionKind: "workflow" },
        ...extra,
    };
}

function request(fields = {}) {
    return {
        childSessionId: "child-1", workflowSessionId: "W", controllingSessionId: "P", runId: "run-1", nodeExecutionId: "nx-1", stateId: "review",
        task: { source: "prompt", prompt: "Review it." }, prompt: "[SYSTEM: wrapper]\n{}", clientMessageId: "workflow:W:run-1:agent:nx-1",
        deadlineAt: "2026-11-02T08:00:00.000Z", ...fields,
    };
}

function hostOver(sessions, definitions = {}, creationConfig = null) {
    const created = [];
    const resolved = [];
    const host = createWorkflowAgentNodeHost({
        getSession: async id => sessions[id] ?? null,
        getSessionCreationConfig: async () => creationConfig,
        resolveAgent: async (name, caller, packageName) => {
            resolved.push({ name, caller, ...(packageName ? { packageName } : {}) });
            return definitions[name] ?? null;
        },
        createChild: async spec => { created.push(spec); },
    });
    return { host, created, resolved };
}

test("a session's level uses effectiveLevel (first Workflow free, platform system reset); a missing or cyclic lineage has none", async () => {
    const sessions = rows({
        C: { parentSessionId: "W" },
        W2: { parentSessionId: "W", sessionKind: "workflow" },
        W3: { parentSessionId: "W2", sessionKind: "workflow" },
        W4: { parentSessionId: "W3", sessionKind: "workflow" },
        SYS_ROOT: { parentSessionId: null, isSystem: true },
        SYS_CHILD: { parentSessionId: "SYS_ROOT", isSystem: true },
        SYS_W: { parentSessionId: "SYS_CHILD", sessionKind: "workflow" },
        USER_SPAWNED_SYS: { parentSessionId: "C", isSystem: true },
        X: { parentSessionId: "Y" },
        Y: { parentSessionId: "X" },
    });
    const get = async id => sessions[id] ?? null;
    assert.equal(await sessionLevel(get, "P"), 0);
    assert.equal(await sessionLevel(get, "W"), 0);
    assert.equal(await sessionLevel(get, "C"), 1);
    assert.equal(await sessionLevel(get, "W2"), 1);
    assert.equal(await sessionLevel(get, "W3"), 2);
    assert.equal(await sessionLevel(get, "W4"), 3);
    assert.equal(await sessionLevel(get, "SYS_ROOT"), 0);
    assert.equal(await sessionLevel(get, "SYS_CHILD"), 0);
    assert.equal(await sessionLevel(get, "SYS_W"), 0);
    assert.equal(await sessionLevel(get, "USER_SPAWNED_SYS"), 2);
    assert.equal(await sessionLevel(get, "missing"), null);
    assert.equal(await sessionLevel(get, "X"), null);
    assert.equal(await sessionLevel(async id => (id === "Z" ? { parentSessionId: "gone" } : null), "Z"), null);
    assert.equal(SESSION_MAX_NESTING_LEVEL, 2);
});

test("an inline prompt's child is at its Workflow's effective level (0 for a top-level Workflow), owned by the lineage, with the controlling agent's model", async () => {
    const { host, created, resolved } = hostOver(rows());
    assert.deepEqual(await host.spawn(request()), { spawned: true });
    assert.equal(resolved.length, 0);
    assert.deepEqual(created, [{
        sessionId: "child-1", parentSessionId: "W", nestingLevel: 0, owner: OWNER, model: "azure-openai:gpt-test", reasoningEffort: "high",
        title: "Workflow step: review", prompt: "[SYSTEM: wrapper]\n{}", clientMessageId: "workflow:W:run-1:agent:nx-1",
        sender: { kind: "agent", sessionId: "W", display: WORKFLOW_AGENT_PROMPT_SENDER },
    }]);
    // Without a controlling agent the child inherits no model.
    const bare = hostOver(rows());
    await bare.host.spawn(request({ controllingSessionId: null }));
    assert.equal(bare.created[0].model, undefined);
    assert.equal(bare.created[0].reasoningEffort, undefined);
});

test("an agent node receives the Workflow's Start-time workspace, including pinned defaults", async () => {
    const workspace = { schema: 1, root: "repos", folder: "project" };
    const defaults = { workingFolder: null, extra: [{ name: "shared", root: "shared", required: false }] };
    const { host, created } = hostOver(rows(), {}, { workflowWorkspace: { workspace, defaults } });
    await host.spawn(request());
    assert.deepEqual(created[0].workspace, workspace);
    assert.deepEqual(created[0].workspaceDefaults, defaults);

    await host.spawn(request({ testRun: true }));
    assert.equal(created[1].workspace, null);
    assert.equal(created[1].workspaceDefaults, null);

    const raw = hostOver(rows(), {}, { workflowWorkspace: { workspace: null, defaults: null, workingDirectory: "/ws/raw-parent" } });
    await raw.host.spawn(request());
    assert.equal(raw.created[0].workspace, null);
    assert.equal(raw.created[0].workspaceDefaults, null);
    assert.equal(raw.created[0].workspaceWorkingDirectory, "/ws/raw-parent");
});

test("a child deeper than the descendant limit, or of an unreadable lineage, is refused and nothing is created", async () => {
    // 4-deep Workflow chain P -> W1 (0) -> W2 (1) -> W3 (2) -> W4 (3): W4's step would be at level 3 (refused).
    const chainSessions = rows({
        W2: { parentSessionId: "W", sessionKind: "workflow" },
        W3: { parentSessionId: "W2", sessionKind: "workflow" },
        W4: { parentSessionId: "W3", sessionKind: "workflow" },
    });
    const deep = hostOver(chainSessions);
    const refused = await deep.host.spawn(request({ workflowSessionId: "W4" }));
    assert.equal(refused.refused.code, "forbidden");
    assert.match(refused.refused.message, /level 3/);
    assert.match(refused.refused.message, /nothing goes past level 2/);
    assert.match(refused.refused.message, /the first Workflow in a chain is free/);
    assert.equal(deep.created.length, 0);
    // 3-deep Workflow chain P -> W (0) -> W2 (1) -> W3 (2): W3's step sits at level 2 (last allowed).
    const last = hostOver(chainSessions);
    assert.deepEqual(await last.host.spawn(request({ workflowSessionId: "W3" })), { spawned: true });
    assert.equal(last.created[0].nestingLevel, 2);
    // Soft-deleted ancestor hidden by getSession is still resolved when readLineage is supplied.
    const softDeletedCreated = [];
    const softDeletedHost = createWorkflowAgentNodeHost({
        getSession: async id => (id === "W3" ? { parentSessionId: "W2-deleted", sessionKind: "workflow", owner: OWNER } : null),
        readLineage: async id => (id === "W3" ? { sessionId: "W3", level: 2, hasWorkflow: true, agentRoot: null, deleted: false } : null),
        resolveAgent: async () => null,
        createChild: async spec => { softDeletedCreated.push(spec); },
    });
    assert.deepEqual(await softDeletedHost.spawn(request({ workflowSessionId: "W3", controllingSessionId: null })), { spawned: true });
    assert.equal(softDeletedCreated[0].nestingLevel, 2);
    // Unreadable or deleted workflow lineage via readLineage fails closed as unavailable before createChild.
    for (const bad of [
        { sessionId: "W", level: null, hasWorkflow: true, agentRoot: null, deleted: false },
        { sessionId: "W", level: 0, hasWorkflow: true, agentRoot: null, deleted: true },
    ]) {
        const unreadableHost = createWorkflowAgentNodeHost({
            getSession: async id => rows()[id] ?? null,
            readLineage: async () => bad,
            resolveAgent: async () => null,
            createChild: async () => { throw new Error("not reached"); },
        });
        assert.equal((await unreadableHost.spawn(request())).refused?.code, "unavailable", JSON.stringify(bad));
    }
    const lost = hostOver({});
    assert.equal((await lost.host.spawn(request())).refused.code, "unavailable");
    assert.equal(lost.created.length, 0);
});

test("a named agent is bound to the definition its owner sees, with its own tools; unknown, system and mismatched pins are refused", async () => {
    const definitions = {
        reviewer: { name: "reviewer", namespace: "kit", tools: ["read_file"], title: "Reviewer" },
        packaged: { name: "packaged", tools: [], packageId: "pkg-1", packageName: "review-kit", packageVersion: "1.2.0", id: "packaged-id" },
        sweeper: { name: "sweeper", system: true, creatable: false },
    };
    const { host, created, resolved } = hostOver(rows(), definitions);
    assert.deepEqual(await host.spawn(request({ task: { source: "agent", name: "reviewer", package: null, version: null } })), { spawned: true });
    assert.deepEqual(resolved, [{ name: "reviewer", caller: "P" }]);
    assert.equal(created[0].boundAgentName, "kit:reviewer");
    assert.equal(created[0].boundAgentPackageId, undefined);
    assert.equal(created[0].agentId, "reviewer");
    assert.deepEqual(created[0].toolNames, ["read_file"]);
    assert.equal(created[0].title, "Reviewer (workflow node: review)");
    assert.deepEqual(await host.spawn(request({ task: { source: "agent", name: "packaged", package: "review-kit", version: "1.2.0" } })), { spawned: true });
    assert.deepEqual([created[1].boundAgentName, created[1].boundAgentPackageId, created[1].agentId, created[1].toolNames],
        ["packaged", "pkg-1", "packaged-id", []]);
    // A state that names a package is resolved among that package's agents (agent-resolver.ts), as at its publication.
    assert.deepEqual(resolved[1], { name: "packaged", caller: "P", packageName: "review-kit" });
    for (const [task, code] of [
        [{ source: "agent", name: "missing", package: null, version: null }, "unavailable"],
        [{ source: "agent", name: "sweeper", package: null, version: null }, "forbidden"],
        [{ source: "agent", name: "packaged", package: "other-kit", version: null }, "unavailable"],
        [{ source: "agent", name: "packaged", package: "review-kit", version: "2.0.0" }, "unavailable"],
        [{ source: "agent", name: "reviewer", package: "review-kit", version: null }, "unavailable"],
    ]) {
        assert.equal((await host.spawn(request({ task }))).refused?.code, code, JSON.stringify(task));
    }
    assert.equal(created.length, 2);
    // Without a controlling agent the workflow itself is the caller whose owner resolves the name.
    await host.spawn(request({ controllingSessionId: null, task: { source: "agent", name: "reviewer", package: null, version: null } }));
    assert.equal(resolved.at(-1).caller, "W");
});

test("R18: a task pinned to an exact package revision is bound to that revision after a republish; another package, or a malformed revision, is refused", async () => {
    const OLD = "a".repeat(64);
    // The package was republished: the owner now sees 1.3.0 of the same package.
    const definitions = {
        packaged: { name: "packaged", tools: ["new_tool"], packageId: "pkg-1", packageName: "review-kit", packageVersion: "1.3.0", packageRevision: "b".repeat(64),
            id: "packaged-id" },
        shadowed: { name: "shadowed", tools: [], packageId: "pkg-9", packageName: "review-kit", packageVersion: "1.2.0" },
    };
    const { host, created } = hostOver(rows(), definitions);
    const pinned = { source: "agent", name: "packaged", package: "review-kit", version: "1.2.0", packageId: "pkg-1", revision: OLD };
    assert.deepEqual(await host.spawn(request({ task: pinned })), { spawned: true });
    // Bound to the pinned revision (agent-package-pins.ts), not to the package's active version, with no tools of that version.
    assert.deepEqual([created[0].boundAgentName, created[0].boundAgentPackageId, created[0].agentId, created[0].toolNames],
        ["packaged", `pkg-1@${OLD}`, "packaged-id", []]);
    for (const task of [
        // The name now resolves to another package (the owner's own copy, say): the pinned package is not confirmed.
        { ...pinned, name: "shadowed", packageId: "pkg-1" },
        // Not a package revision.
        { ...pinned, revision: "not-a-sha" },
        // Not visible at all.
        { ...pinned, name: "missing" },
    ]) {
        assert.equal((await host.spawn(request({ task }))).refused?.code, "unavailable", JSON.stringify(task));
    }
    // A pin without a revision (a publication made before revisions were pinned) is still held to its version.
    assert.equal((await host.spawn(request({ task: { source: "agent", name: "packaged", package: "review-kit", version: "1.2.0" } }))).refused?.code,
        "unavailable");
    assert.equal(created.length, 1);
});

test("the client-based creator starts a client, creates the child, titles it and sends the first prompt once, and always stops the client", async () => {
    const calls = [];
    const client = (failSend = false) => ({
        start: async () => { calls.push("start"); },
        stop: async () => { calls.push("stop"); },
        createSession: async config => {
            calls.push(["create", config]);
            return { send: async (prompt, opts) => { calls.push(["send", prompt, opts]); if (failSend) throw new Error("queue unavailable"); } };
        },
    });
    const catalog = { updateSession: async (id, update) => { calls.push(["title", id, update]); } };
    const spec = {
        sessionId: "child-1", parentSessionId: "W", nestingLevel: 1, owner: OWNER, model: "azure-openai:gpt-test", title: "Workflow step: review",
        prompt: "wrapper", clientMessageId: "cm-1", sender: { kind: "agent", sessionId: "W", display: WORKFLOW_AGENT_PROMPT_SENDER },
        boundAgentName: "kit:reviewer", toolNames: ["read_file"], agentId: "reviewer",
        workspace: { schema: 1, root: "repos", folder: "project" },
        workspaceDefaults: { workingFolder: null, extra: [{ name: "shared", root: "shared", required: false }] },
    };
    await clientWorkflowAgentChildCreator(() => client(), catalog)(spec);
    assert.deepEqual(calls, [
        "start",
        // Review DRR-1: the child is never brought back from a deletion.
        ["create", { sessionId: "child-1", parentSessionId: "W", nestingLevel: 1, owner: OWNER, refuseDeleted: true, model: "azure-openai:gpt-test",
            workspace: spec.workspace, workspaceDefaults: spec.workspaceDefaults,
            boundAgentName: "kit:reviewer", agentId: "reviewer", toolNames: ["read_file"] }],
        ["title", "child-1", { title: "Workflow step: review" }],
        ["send", "wrapper", { clientMessageIds: ["cm-1"], sender: spec.sender }],
        "stop",
    ]);
    calls.length = 0;
    await assert.rejects(clientWorkflowAgentChildCreator(() => client(true), null)(spec), /queue unavailable/);
    assert.equal(calls.at(-1), "stop");
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === "title"), false);
});

test("review DRR-1: a create that finds the agent session deleted is refused unavailable at once, not retried", async () => {
    const host = createWorkflowAgentNodeHost({
        getSession: async id => rows()[id] ?? null,
        resolveAgent: async () => null,
        createChild: async () => { throw Object.assign(new Error("Session child-1 was deleted; it is not created again."), { code: "SESSION_DELETED" }); },
    });
    const refused = await host.spawn(request());
    assert.equal(refused.refused.code, "unavailable");
    assert.match(refused.refused.message, /agent session child-1 of this step was deleted/);
    // Any other failure is thrown, so the spawn's retries try again.
    const flaky = createWorkflowAgentNodeHost({
        getSession: async id => rows()[id] ?? null, resolveAgent: async () => null,
        createChild: async () => { throw new Error("connection reset"); },
    });
    await assert.rejects(flaky.spawn(request()), /connection reset/);
});
