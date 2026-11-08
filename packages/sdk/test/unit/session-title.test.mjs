/**
 * Deployed check DS-3: the Copilot runtime names a session from the first prompt it is sent and says so in a
 * session.title_changed event, which is recorded into the session's events. A chat's first turn after DS-2 carried
 * runtime notes before the person's words (a save note and a Workflow's end kept for a chat that had not started), so
 * the event named the chat "[SYSTEM: Alice Anderson saved dc-short revision 1.] ..." (TEST, seq 48167). It is recorded
 * with the person's own words instead, and not at all when there are none; any other name is recorded as it was. Nothing
 * reads this event as a session's title (the stored title comes from summarizeSession, which leaves notes out).
 *
 * Run: node --test test/unit/session-title.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_TITLE_EVENT_MAX, sessionTitleChangedForRecord, startsWithRuntimeNote, stripLeadingRuntimeNotes }
    from "../../dist/session-title.js";
import { workflowV2ParentNotification } from "../../dist/workflow/v2/runtime.js";

const SAVE_NOTE = "[SYSTEM: Alice Anderson saved dc-short revision 1.]";
// A Workflow's end kept as the chat's note (DS-2), as the chat's first turn reads it: "[SYSTEM: <the end notice>]".
const NOTICE = workflowV2ParentNotification({ sessionId: "wf-ds3", runId: "run-ds3-0001", name: "dc-short", version: "1.0.0",
    status: "completed", outcome: "succeeded", stateId: "done", failure: null }, JSON.stringify({ output: { items: ["a", "b"] } }));
const NOTES = `${SAVE_NOTE}\n[SYSTEM: ${NOTICE}]`;
const FIRST = "Hello. Reply in one line: did anything happen in this chat before this message?";
const titled = title => ({ eventType: "session.title_changed", data: { title } });

test("a text's leading notes are removed; the person's own words remain", () => {
    assert.match(NOTICE, /\[WORKFLOW_UPDATE/);
    assert.equal(stripLeadingRuntimeNotes(`${NOTES}\n\n${FIRST}`), FIRST);
    assert.equal(stripLeadingRuntimeNotes("  plain words [with brackets] stay  "), "plain words [with brackets] stay");
    assert.equal(stripLeadingRuntimeNotes(NOTES), "");
    // A note that never closes (a name the runtime cut short) takes the rest; a runtime message is all the runtime's.
    assert.equal(stripLeadingRuntimeNotes(`${NOTES}\n\n${FIRST}`.slice(0, 120)), "");
    assert.equal(stripLeadingRuntimeNotes(NOTICE), "");
    assert.equal(stripLeadingRuntimeNotes("[CHILD_UPDATE from=x]\ndone"), "");
    assert.equal(startsWithRuntimeNote(" [system: x]"), true);
    assert.equal(startsWithRuntimeNote("Plan [SYSTEM: x]"), false);
});

test("the runtime's name for a chat whose first turn carried notes is recorded as the person's words", () => {
    // As TEST recorded it: the model's prompt, notes first, cut short by the runtime.
    const observed = titled(`${NOTES}\n\n${FIRST}`.slice(0, 300) + "...");
    const recorded = sessionTitleChangedForRecord(observed, FIRST);
    assert.deepEqual(recorded, titled(FIRST));
    assert.ok(FIRST.length <= SESSION_TITLE_EVENT_MAX);
    // Long words are cut to the limit; whitespace is collapsed.
    const long = sessionTitleChangedForRecord(titled(`${SAVE_NOTE} x`), `Please   summarise ${"every ".repeat(30)}thing`);
    assert.equal(long.data.title.length, SESSION_TITLE_EVENT_MAX);
    assert.match(long.data.title, /^Please summarise every every .*…$/);
    // A turn with no words of its own (only notes, or a Workflow's message): the event is not recorded.
    assert.equal(sessionTitleChangedForRecord(titled(NOTES), NOTES), null);
    assert.equal(sessionTitleChangedForRecord(titled(NOTICE), NOTICE), null);
    assert.equal(sessionTitleChangedForRecord(titled(NOTES), ""), null);
    // Any other name, and any other event, is recorded as it was.
    const plain = titled("Fix the login bug");
    assert.equal(sessionTitleChangedForRecord(plain, "fix the login bug please"), plain);
    const message = { eventType: "assistant.message", data: { content: SAVE_NOTE } };
    assert.equal(sessionTitleChangedForRecord(message, ""), message);
    const odd = { eventType: "session.title_changed", data: null };
    assert.equal(sessionTitleChangedForRecord(odd, FIRST), odd);
});

test("the turn records the runtime's name through that rule, with its own prompt as the person's words", () => {
    const proxy = readFileSync(fileURLToPath(new URL("../../src/session-proxy.ts", import.meta.url)), "utf8");
    assert.match(proxy, /const turnOwnWords = input\.config\?\.systemContextInPrompt \? splitSystemContextBlock\(input\.prompt \?\? ""\)\.prompt : \(input\.prompt \?\? ""\);/);
    assert.match(proxy, /if \(persistedEvent\) persistedEvent = sessionTitleChangedForRecord\(persistedEvent, turnOwnWords\);\s+if \(!persistedEvent\) return;/);
});

test("nothing reads the runtime's session.title_changed event as a session's title", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const files = [];
    const walk = dir => {
        for (const name of readdirSync(dir)) {
            if (name === "node_modules" || name === "dist" || name === "test" || name.startsWith(".")) continue;
            const path = join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else if (/\.(m?[jt]sx?)$/.test(name)) files.push(path);
        }
    };
    for (const dir of ["sdk/src", "app/ui", "app/web/src", "app/web/api", "app/tui", "app/mcp"]) {
        try { walk(join(root, dir)); } catch { /* a package this checkout does not have */ }
    }
    assert.ok(files.length > 100, String(files.length));
    // Code that reads the event names its type as a string; session-title.ts is the rule above.
    const readers = files.filter(path => /["'`]session\.title_changed["'`]/.test(readFileSync(path, "utf8")) && !path.endsWith("session-title.ts"));
    assert.deepEqual(readers, []);
});
