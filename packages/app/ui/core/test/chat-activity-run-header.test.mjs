/**
 * The header of a grouped run of tool calls in the session ("3 tool calls · latest: enable_workflows · Done"). A failed
 * state must never sit beside the name of a call that succeeded: a group in which an earlier call (the CLI's `skill`)
 * failed and the latest (enable_workflows) succeeded read "latest: enable_workflows … Failed".
 *
 * Run: node --test ui/core/test/chat-activity-run-header.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chatActivityRunHeader } from "../src/chat-activity.js";

const call = (name, status, category = "Tool") => ({ callKey: name, category, status, text: `${name} — args` });

test("a group whose calls all succeeded reads Done beside the latest call", () => {
    const header = chatActivityRunHeader([call("skill", "Done"), call("bash", "Done"), call("enable_workflows", "Done")]);
    assert.equal(header.countLabel, "3 tool calls");
    assert.equal(header.latestName, "enable_workflows");
    assert.equal(header.status, "Done");
    assert.equal(header.failed, false);
    assert.deepEqual(header.failedNames, []);
});

test("an earlier failed call and a latest that succeeded: the state counts the failures, never a bare Failed", () => {
    const header = chatActivityRunHeader([call("skill", "Failed"), call("bash", "Done"), call("enable_workflows", "Done")]);
    assert.equal(header.latestName, "enable_workflows");
    assert.equal(header.status, "1 of 3 failed");
    assert.notEqual(header.status, "Failed");
    assert.equal(header.failed, true);
    assert.deepEqual(header.failedNames, ["skill"]);
});

test("a latest call that failed is counted the same way; a single failed call says Failed", () => {
    const latestFailed = chatActivityRunHeader([call("bash", "Done"), call("skill", "Failed")]);
    assert.equal(latestFailed.latestName, "skill");
    assert.equal(latestFailed.status, "1 of 2 failed");
    assert.deepEqual(latestFailed.failedNames, ["skill"]);
    const single = chatActivityRunHeader([call("skill", "Failed")]);
    assert.equal(single.countLabel, "1 tool call");
    assert.equal(single.status, "Failed");
});

test("several failed calls are counted and named once each", () => {
    const header = chatActivityRunHeader([call("skill", "Failed"), call("bash", "Failed"), call("skill", "Failed"), call("view", "Done")]);
    assert.equal(header.status, "3 of 4 failed");
    assert.deepEqual(header.failedNames, ["skill", "bash"]);
});

test("a running latest call keeps Working (and the group's failed mark), as before", () => {
    const header = chatActivityRunHeader([call("skill", "Failed"), call("bash", "Called")]);
    assert.equal(header.status, "Working");
    assert.equal(header.active, true);
    assert.equal(header.failed, true);
    const agents = chatActivityRunHeader([call("spawn_agent", "Started", "Agent")]);
    assert.equal(agents.countLabel, "1 agent activity");
    assert.equal(agents.status, "Working");
    assert.equal(chatActivityRunHeader([call("a", "Done"), call("spawn_agent", "Done", "Agent")]).countLabel, "2 activities");
});

test("the browser's grouped run renders these words (web-app.js uses the helper)", () => {
    const source = readFileSync(fileURLToPath(new URL("../../react/src/web-app.js", import.meta.url)), "utf8");
    const run = source.slice(source.indexOf("function ChatActivityRun("), source.indexOf("function CanvasActionLine("));
    assert.match(run, /chatActivityRunHeader\(calls\)/);
    assert.doesNotMatch(run, /failed \? "Failed"/);
    assert.match(run, /`latest: \$\{latestName\}`/);
    assert.match(run, /`Failed: \$\{failedNames\.join\(", "\)\}`/);
});
