/**
 * What the worker takes from a compute host, and what it does not
 * (docs/proposals/compute-providers.md).
 *
 *   a. a remote runtime cannot put PilotSwarm's name to an event: the
 *      types the worker emits, and the two that change what the CMS says a
 *      session is doing, are recorded under a name that says who claimed
 *      them
 *   b. the paths the agent is given are paths on its host, and attachment
 *      on the worker is reported apart from availability on the host
 *   c. a worker-side tool is told the agent runs elsewhere, and which
 *      worker folders (if any) that session may name
 *   d. the session is told, in its own instructions, that its shell is
 *      somewhere else
 *
 * Run: npx vitest run test/local/compute-remote-trust.test.js
 */
import { describe, expect, it } from "vitest";
import { ManagedSession } from "../../src/managed-session.ts";
import {
    CLAIMED_EVENT_PREFIX, isWorkerOwnedEventType, remoteRuntimeEventType, WORKER_OWNED_EVENT_TYPES,
} from "../../src/compute-events.ts";
import { ComputeFolderMap, computeFolderMapOf, COMPUTE_WORKING_FOLDER } from "../../src/compute.ts";
import { computeHostNote, withComputeHostNote } from "../../src/session-manager.ts";

const FOLDERS = [
    { name: COMPUTE_WORKING_FOLDER, workerPath: "/worker/mnt/a/repo", hostPath: "/home/agent/work" },
    { name: "logs", workerPath: "/worker/mnt/b/logs", hostPath: "/home/agent/extra/logs" },
];

const REMOTE = {
    targetName: "shared/test",
    hostId: "host-1",
    hostIncarnation: "inc-1",
    files: "shared-mount",
    sharesWorkerFiles: true,
    folders: FOLDERS,
};

const ATTACHED = {
    workspaceTools: true,
    workspace: { root: "a", folder: "repo", extra: { logs: { root: "b", folder: "logs" } } },
    workspaceAttach: {
        root: "a", rootPath: "/worker/mnt/a", path: "/worker/mnt/a/repo", realPath: "/worker/mnt/a/repo",
        extras: [{ name: "logs", root: "b", rootPath: "/worker/mnt/b", path: "/worker/mnt/b/logs", realPath: "/worker/mnt/b/logs" }],
    },
};

/**
 * The smallest session handle a turn needs: it registers the tools, runs
 * the ones the script names, replays the events the script sends, and goes
 * idle.
 */
class FakeCopilotSession {
    registeredTools = [];
    catchAll = [];
    listeners = new Map();
    scriptedToolCalls = [];
    scriptedEvents = [];
    toolResults = [];
    aborted = false;
    rpc = { tasks: { async list() { return { tasks: [] }; }, async cancel() { return { cancelled: true }; } } };

    on(eventType, handler) {
        if (typeof eventType === "function") {
            this.catchAll.push(eventType);
            return () => { this.catchAll = this.catchAll.filter((candidate) => candidate !== eventType); };
        }
        const handlers = this.listeners.get(eventType) ?? [];
        handlers.push(handler);
        this.listeners.set(eventType, handlers);
        return () => {
            this.listeners.set(eventType, (this.listeners.get(eventType) ?? []).filter((candidate) => candidate !== handler));
        };
    }

    registerTools(tools) {
        this.registeredTools = tools;
    }

    emit(eventType, data = {}) {
        for (const handler of this.catchAll) handler({ type: eventType, data });
        for (const handler of this.listeners.get(eventType) ?? []) handler({ data });
    }

    abort() {
        this.aborted = true;
    }

    async send() {
        this.aborted = false;
        queueMicrotask(async () => {
            for (const call of this.scriptedToolCalls) {
                const tool = this.registeredTools.find((candidate) => candidate.name === call.name);
                if (!tool) throw new Error(`the session was never given a "${call.name}" tool`);
                this.emit("tool.execution_start", { toolName: call.name, arguments: call.args ?? {} });
                const result = await tool.handler(call.args ?? {}, { toolCallId: `call-${call.name}` });
                this.toolResults.push(result);
                this.emit("tool.execution_complete", { toolName: call.name, arguments: call.args ?? {}, result });
            }
            for (const event of this.scriptedEvents) this.emit(event.type, event.data ?? {});
            this.emit("assistant.message", { content: "ok" });
            this.emit("session.idle", {});
        });
    }
}

/** Run one turn that calls one tool, and give back what the tool answered. */
async function callTool(config, name, args = {}) {
    const session = new FakeCopilotSession();
    session.scriptedToolCalls = [{ name, args }];
    const managed = new ManagedSession(`tool-${name}`, session, config);
    await managed.runTurn("go", {});
    return session.toolResults[0];
}

describe("events a remote runtime sends", () => {
    it("records an event only PilotSwarm emits under a name that says who claimed it", () => {
        for (const type of ["session.wait_started", "session.input_required_started", "session.agent_spawned", "system.message"]) {
            expect(isWorkerOwnedEventType(type)).toBe(true);
            expect(remoteRuntimeEventType(type)).toBe(`${CLAIMED_EVENT_PREFIX}${type}`);
        }
    });

    it("leaves the runtime's own events alone", () => {
        for (const type of [
            "session.idle", "session.error", "session.usage_info", "session.compaction_start",
            "session.compaction_complete", "session.background_tasks_changed",
            "assistant.message", "assistant.usage", "user.message", "tool.execution_start",
        ]) {
            expect(isWorkerOwnedEventType(type)).toBe(false);
            expect(remoteRuntimeEventType(type)).toBe(type);
        }
    });

    it("names the compute lifecycle events the worker emits, so a host cannot claim them", () => {
        for (const type of ["session.compute_bound", "session.compute_connected", "session.compute_host_replaced", "session.compute_released"]) {
            expect(WORKER_OWNED_EVENT_TYPES.has(type)).toBe(true);
        }
    });

    it("renames a claimed event as it arrives, and only for a remote session", async () => {
        const run = async (config) => {
            const session = new FakeCopilotSession();
            session.scriptedEvents = [{ type: "session.wait_started", data: { seconds: 1, reason: "claimed" } }];
            const seen = [];
            const managed = new ManagedSession("claimed-events", session, config);
            await managed.runTurn("go", { onEvent: (event) => seen.push(event.eventType) });
            return seen;
        };
        const remote = await run({ computeRuntime: REMOTE });
        expect(remote).toContain(`${CLAIMED_EVENT_PREFIX}session.wait_started`);
        expect(remote).not.toContain("session.wait_started");

        // A session that runs on the worker is the worker's own code; it
        // behaves exactly as it always has.
        const local = await run({});
        expect(local).toContain("session.wait_started");
        expect(local).not.toContain(`${CLAIMED_EVENT_PREFIX}session.wait_started`);
    });
});

describe("a session's folders on both sides", () => {
    const map = new ComputeFolderMap(FOLDERS);

    it("translates a path in each direction, inside the session's folders only", () => {
        expect(map.toHost("/worker/mnt/a/repo")).toBe("/home/agent/work");
        expect(map.toHost("/worker/mnt/a/repo/src/main.ts")).toBe("/home/agent/work/src/main.ts");
        expect(map.toWorker("/home/agent/extra/logs/today.log")).toBe("/worker/mnt/b/logs/today.log");
        // Nothing else on either machine is this session's to name.
        expect(map.toHost("/worker/etc/passwd")).toBeUndefined();
        expect(map.toWorker("/etc/passwd")).toBeUndefined();
        // A folder whose name only begins like one of the session's.
        expect(map.toWorker("/home/agent/workspace-elsewhere/x")).toBeUndefined();
    });

    it("says when both sides see the same paths, so nothing needs translating", () => {
        expect(map.identical).toBe(false);
        expect(new ComputeFolderMap([
            { name: COMPUTE_WORKING_FOLDER, workerPath: "/same/place", hostPath: "/same/place" },
        ]).identical).toBe(true);
    });

    it("pairs the worker's folders with the host's by position, and leaves out what the host did not place", () => {
        const paired = computeFolderMapOf(
            { cwd: "/w/cwd", additionalDirectories: ["/w/one", "/w/two"] },
            { cwd: "/h/cwd", additionalDirectories: ["/h/one"] },
            ["one", "two"],
        );
        expect(paired.folders).toEqual([
            { name: COMPUTE_WORKING_FOLDER, workerPath: "/w/cwd", hostPath: "/h/cwd" },
            { name: "one", workerPath: "/w/one", hostPath: "/h/one" },
        ]);
        expect(paired.toHost("/w/two/file")).toBeUndefined();
    });
});

describe("what a session is told about where it runs", () => {
    it("reports host paths from get_session_workspace, and attachment separately", async () => {
        const answer = JSON.parse(await callTool({ ...ATTACHED, computeRuntime: REMOTE }, "get_session_workspace"));
        expect(answer.path).toBe("/home/agent/work");
        expect(answer.attachedOnWorker).toBe("/worker/mnt/a/repo");
        expect(answer.availableOnHost).toBe(true);
        expect(answer.extra[0]).toMatchObject({
            name: "logs", path: "/home/agent/extra/logs", status: "attached", availableOnHost: true,
        });
        expect(answer.compute.target).toBe("shared/test");
    });

    it("reports a folder the host was never given as attached but not available there", async () => {
        const answer = JSON.parse(await callTool({
            ...ATTACHED,
            // The host placed the working folder and nothing else.
            computeRuntime: { ...REMOTE, folders: [FOLDERS[0]] },
        }, "get_session_workspace"));
        expect(answer.extra[0]).toMatchObject({
            name: "logs", path: null, status: "attached",
            attachedOnWorker: "/worker/mnt/b/logs", availableOnHost: false,
        });
    });

    it("reports worker paths, and nothing about a host, for a session that runs on the worker", async () => {
        const answer = JSON.parse(await callTool(ATTACHED, "get_session_workspace"));
        expect(answer.path).toBe("/worker/mnt/a/repo");
        expect(answer.compute).toBeUndefined();
        expect(answer.attachedOnWorker).toBeUndefined();
        expect(answer.extra[0].path).toBe("/worker/mnt/b/logs");
    });

    it("tells a worker-side tool that the agent is elsewhere, and which folders it may name", () => {
        const shared = new ManagedSession("ctx-shared", new FakeCopilotSession(), { computeRuntime: REMOTE });
        expect(shared.computeToolContext()).toEqual({
            runsRemotely: true,
            target: "shared/test",
            sharesWorkerFiles: true,
            allowedWorkerPaths: ["/worker/mnt/a/repo", "/worker/mnt/b/logs"],
            hostPaths: ["/home/agent/work", "/home/agent/extra/logs"],
        });
        const unshared = new ManagedSession("ctx-unshared", new FakeCopilotSession(), {
            computeRuntime: { ...REMOTE, files: "none", sharesWorkerFiles: false },
        });
        expect(unshared.computeToolContext().allowedWorkerPaths).toEqual([]);
        expect(new ManagedSession("ctx-local", new FakeCopilotSession(), {}).computeToolContext()).toBeUndefined();
    });

    it("adds a note to the session's instructions saying its shell is on its host", () => {
        const base = { content: "base instructions" };
        const shared = withComputeHostNote(base, { sharesWorkerFiles: true });
        expect(shared.content).toContain("base instructions");
        expect(shared.content).toContain("Your shell runs on this session's compute host");
        expect(shared.content).toContain("read_artifact({toFile})` work");
        const unshared = withComputeHostNote(base, { sharesWorkerFiles: false });
        expect(unshared.content).toContain("are unavailable to you");
        // An ordinary session's instructions are untouched.
        expect(withComputeHostNote(base, undefined)).toBe(base);
        expect(computeHostNote(true)).not.toEqual(computeHostNote(false));
    });
});
