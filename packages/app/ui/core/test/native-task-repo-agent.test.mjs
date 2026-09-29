/**
 * A native task that runs an agent adopted from the session workspace's repo
 * is named, with its repo (session workspaces, section 4.6). The worker marks
 * such a task with `repo`; the card used to label every such task "Native
 * task", so the user could not tell which agent was triggered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyNativeTaskSnapshot, appendNativeTaskEvent, nativeTaskProfile } from "../src/native-tasks.js";
import { NativeTaskCard } from "../../react/src/native-task-card.js";

const COLORS = { running: "#0af", completed: "#0a0", failed: "#a00" };
const repoTask = { id: "call-1", toolCallId: "call-1", title: "Survey tfenv architecture", profile: "architect", repo: "tfenv",
    model: "gpt-5.6-sol", status: "running", startedAt: "2026-09-27T21:00:00.000Z", toolCalls: 3 };

test("nativeTaskProfile names a repo agent with its repo; the built-in profiles keep their labels", () => {
    const repo = nativeTaskProfile(repoTask);
    assert.equal(repo.kind, "repo");
    assert.equal(repo.label, "Repo agent · architect");
    assert.equal(repo.repo, "tfenv");
    assert.match(repo.title, /architect agent from the tfenv repo/);
    assert.deepEqual(nativeTaskProfile({ profile: "swarm-explore" }), { kind: "builtin", label: "Explore" });
    assert.deepEqual(nativeTaskProfile({ profile: "swarm-task" }), { kind: "builtin", label: "Task" });
    assert.deepEqual(nativeTaskProfile({ profile: "architect" }), { kind: "generic", label: "Native task" }, "no repo: not a repo agent");
    assert.deepEqual(nativeTaskProfile({}), { kind: "generic", label: "Native task" });
});

test("the repo survives in the history: from the snapshot, through later raw events", () => {
    let history = applyNativeTaskSnapshot(null, { version: 1, ownerId: "o1", ownerStartedAt: 1, revision: 1, phase: "live", tasks: [repoTask] },
        { sessionId: "s1" });
    const chat = [...history.chat];
    appendNativeTaskEvent(chat, { sessionId: "s1", eventType: "subagent.completed", createdAt: "2026-09-27T21:01:00.000Z",
        data: { toolCallId: "call-1", durationMs: 60_000, totalToolCalls: 9 } });
    const task = chat.find((group) => group.kind === "native-task-group").tasks[0];
    assert.equal(task.status, "completed");
    assert.equal(task.repo, "tfenv");
    assert.equal(task.profile, "architect");
});

test("the card shows which repo agent ran", () => {
    const html = renderToStaticMarkup(React.createElement(NativeTaskCard, { group: { id: "g1", tasks: [repoTask] }, colors: COLORS }));
    assert.match(html, /class="ps-native-task-profile ps-native-task-profile--repo"/);
    assert.match(html, /Repo agent · architect/);
    assert.match(html, /title="The architect agent from the tfenv repo/);
    assert.match(html, /architect agent from tfenv · gpt-5\.6-sol · Same worker/);

    const plain = renderToStaticMarkup(React.createElement(NativeTaskCard, { group: { id: "g2", tasks: [{ ...repoTask, repo: undefined, profile: "swarm-explore" }] }, colors: COLORS }));
    assert.match(plain, /class="ps-native-task-profile">Explore</);
    assert.doesNotMatch(plain, /Repo agent/);
});

// ── Loaded agents: the person's own, and loaded by path (v0.7.1) ─────────

const loadedTask = { ...repoTask, id: "call-2", toolCallId: "call-2", title: "Summarize AGENTS.md", profile: "summarizer", repo: undefined, loaded: "personal" };

test("nativeTaskProfile names a loaded agent: from the person's folder, or loaded by path", () => {
    const own = nativeTaskProfile(loadedTask);
    assert.equal(own.kind, "loaded");
    assert.equal(own.label, "Loaded agent · summarizer");
    assert.match(own.title, /summarizer agent from your own folder/);
    const byPath = nativeTaskProfile({ ...loadedTask, profile: "reviewer", loaded: "path" });
    assert.equal(byPath.label, "Loaded agent · reviewer");
    assert.match(byPath.title, /reviewer agent from a file loaded by path/);
    assert.deepEqual(nativeTaskProfile({ ...loadedTask, loaded: "elsewhere" }), { kind: "generic", label: "Native task" }, "an unknown mark is ignored");
    assert.equal(nativeTaskProfile({ ...loadedTask, repo: "tfenv", loaded: "path" }).kind, "repo", "a repo mark wins");
});

test("the loaded mark survives in the history, and the card shows it", () => {
    let history = applyNativeTaskSnapshot(null, { version: 1, ownerId: "o1", ownerStartedAt: 1, revision: 1, phase: "live", tasks: [loadedTask] }, { sessionId: "s1" });
    const chat = [...history.chat];
    appendNativeTaskEvent(chat, { sessionId: "s1", eventType: "subagent.completed", createdAt: "2026-09-29T10:01:00.000Z",
        data: { toolCallId: "call-2", durationMs: 2_000, totalToolCalls: 1 } });
    const task = chat.find((group) => group.kind === "native-task-group").tasks[0];
    assert.equal(task.loaded, "personal");
    const html = renderToStaticMarkup(React.createElement(NativeTaskCard, { group: { id: "g3", tasks: [task] }, colors: COLORS }));
    assert.match(html, /class="ps-native-task-profile ps-native-task-profile--loaded"/);
    assert.match(html, /Loaded agent · summarizer/);
    assert.match(html, /summarizer agent from your own folder · gpt-5\.6-sol · Same worker/);
});
