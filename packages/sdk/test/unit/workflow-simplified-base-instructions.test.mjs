/**
 * A workflow agent node chat's base instructions (owner feedback 2026-11-06, finding 8, "show the base prompts"): the
 * SDK's echo of the composed system prompt is recognised, its whole text is named by its sha256 and kept once per
 * distinct text as an artifact of its Workflow's session, so two visits (two chats, or one continued chat at two turns)
 * with the same instructions share one artifact; another text gets its own. The transcript keeps only the summary
 * (session-proxy summarizeSdkSystemPromptEchoEvent), which names where the whole text is.
 *
 * Run: node --test test/unit/workflow-simplified-base-instructions.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
    keepWorkflowBaseInstructions, SDK_SYSTEM_PROMPT_PREFIX, sdkSystemPromptEchoContent,
    workflowBaseInstructionsArtifact, workflowBaseInstructionsRef, workflowBaseInstructionsText,
} from "../../dist/workflow/v2/base-instructions.js";
import { summarizeSdkSystemPromptEchoEvent } from "../../dist/session-proxy.js";

const TEXT = `${SDK_SYSTEM_PROMPT_PREFIX}\n\nYou are an interactive agent. Use your tools.`;

function store(existing = []) {
    const files = new Map(existing.map(([session, name, content]) => [`${session}/${name}`, content]));
    const uploads = [];
    return {
        files, uploads,
        async statArtifact(sessionId, filename) {
            const content = files.get(`${sessionId}/${filename}`);
            return content === undefined ? null : { filename, sha256: createHash("sha256").update(content).digest("hex") };
        },
        async uploadArtifact(sessionId, filename, content, contentType) {
            uploads.push({ sessionId, filename, contentType });
            files.set(`${sessionId}/${filename}`, content);
            return { filename };
        },
    };
}

test("the SDK's echo of the composed system prompt is recognised; every other message is not", () => {
    assert.equal(sdkSystemPromptEchoContent({ eventType: "system.message", data: { content: TEXT } }), TEXT);
    assert.equal(sdkSystemPromptEchoContent({ eventType: "system.message", data: { content: "Workspace note." } }), null);
    assert.equal(sdkSystemPromptEchoContent({ eventType: "user.message", data: { content: TEXT } }), null);
    assert.equal(sdkSystemPromptEchoContent({ eventType: "system.message", data: null }), null);
});

test("a text is named by its sha256 on its Workflow: the same text names the same artifact", () => {
    const sha = createHash("sha256").update(TEXT).digest("hex");
    assert.deepEqual(workflowBaseInstructionsRef("wf-1", TEXT), { sessionId: "wf-1", artifact: `base-instructions-${sha.slice(0, 16)}.md`, sha256: sha,
        chars: TEXT.length });
    assert.equal(workflowBaseInstructionsArtifact(sha), `base-instructions-${sha.slice(0, 16)}.md`);
    assert.deepEqual(workflowBaseInstructionsRef("wf-1", TEXT), workflowBaseInstructionsRef("wf-1", TEXT));
    assert.notEqual(workflowBaseInstructionsRef("wf-1", `${TEXT} More.`).artifact, workflowBaseInstructionsRef("wf-1", TEXT).artifact);
});

test("two visits with the same instructions share one artifact; another text gets its own; one already in the store is not written again", async () => {
    const workflow = `wf-${randomUUID()}`;
    const s = store();
    const ref = workflowBaseInstructionsRef(workflow, TEXT);
    // Visit 1's chat and visit 2's chat (chat: new), or one continued chat at two turns: the same ref, one write.
    assert.equal(await keepWorkflowBaseInstructions(s, ref, TEXT), true);
    assert.equal(await keepWorkflowBaseInstructions(s, workflowBaseInstructionsRef(workflow, TEXT), TEXT), false);
    assert.deepEqual(s.uploads, [{ sessionId: workflow, filename: ref.artifact, contentType: "text/markdown" }]);
    assert.equal(s.files.get(`${workflow}/${ref.artifact}`), TEXT);
    // Other instructions (another node, or a changed agent): their own artifact.
    const other = workflowBaseInstructionsRef(workflow, `${TEXT}\nAnother role.`);
    assert.equal(await keepWorkflowBaseInstructions(s, other, `${TEXT}\nAnother role.`), true);
    assert.equal(s.uploads.length, 2);
    // Another worker (nothing remembered) finds the artifact in the store and writes nothing.
    const later = `wf-${randomUUID()}`;
    const laterRef = workflowBaseInstructionsRef(later, TEXT);
    const kept = store([[later, laterRef.artifact, TEXT]]);
    assert.equal(await keepWorkflowBaseInstructions(kept, laterRef, TEXT), false);
    assert.deepEqual(kept.uploads, []);
});

// Review SF-4 and its delta residual: a kept reference is never reused unchecked: every keep asks the store, so an
// artifact replaced by other bytes or deleted right after it was kept (within any time) is written again at the next
// visit, and one that is unchanged is not.
test("a kept text that was replaced or deleted right after it was kept is written again at the next visit", async () => {
    const workflow = `wf-${randomUUID()}`;
    const s = store();
    const ref = workflowBaseInstructionsRef(workflow, TEXT);
    assert.equal(await keepWorkflowBaseInstructions(s, ref, TEXT), true);
    // Replaced by other bytes under its name: the very next visit finds it out and writes the text again.
    s.files.set(`${workflow}/${ref.artifact}`, "forged");
    assert.equal(await keepWorkflowBaseInstructions(s, ref, TEXT), true);
    assert.equal(s.files.get(`${workflow}/${ref.artifact}`), TEXT);
    // Deleted: the next visit writes it again at once.
    s.files.delete(`${workflow}/${ref.artifact}`);
    assert.equal(await keepWorkflowBaseInstructions(s, ref, TEXT), true);
    assert.equal(s.files.get(`${workflow}/${ref.artifact}`), TEXT);
    // Unchanged in the store: checked, and not written.
    const writes = s.uploads.length;
    assert.equal(await keepWorkflowBaseInstructions(s, ref, TEXT), false);
    assert.equal(s.uploads.length, writes);
});

// FU-21 (r4 C04, the live dump): the 1.0.83 SDK records the system prompt it composed as a system.message with the model's
// role "system" and an interaction id, whatever its first words; it was stored whole in every transcript (55,151 characters
// each turn). It is recognised by that shape and stored as its summary, as the echo with the known first words is.
test("FU-21: the echo is recognised by its shape too, and every transcript stores only its summary", () => {
    const live = "<instructions>\nYou are PilotSwarm's agent.\n" + "rule ".repeat(11_000) + "\n</instructions>";
    const shaped = { eventType: "system.message", data: { role: "system", interactionId: "int-1", content: live } };
    assert.equal(sdkSystemPromptEchoContent(shaped), live);
    const summary = summarizeSdkSystemPromptEchoEvent(shaped);
    assert.equal(summary.eventType, "system.message");
    assert.equal(summary.data.role, "system");
    assert.equal(summary.data.interactionId, "int-1");
    // S2SF-F2: fixed words and the length only, never the echo's first words.
    assert.equal(summary.data.content, `[SYSTEM: Copilot SDK rebuilt the full system prompt for model input. Full content omitted from CMS (${live.length} chars).]`);
    // The known first words, as before.
    assert.match(summarizeSdkSystemPromptEchoEvent({ eventType: "system.message", data: { content: TEXT } }).data.content, /^\[SYSTEM: Copilot SDK rebuilt/);
    // Not the echo: a person's or the runtime's system message (a sender, no interaction id), another role, an empty text.
    for (const data of [{ content: "Workspace note.", sender: { kind: "system" } }, { role: "user", interactionId: "int-2", content: live },
        { role: "system", content: live }, { role: "system", interactionId: "", content: live }, { role: "system", interactionId: "int-3", content: "  " }]) {
        const event = { eventType: "system.message", data };
        assert.equal(sdkSystemPromptEchoContent(event), null, JSON.stringify(data).slice(0, 80));
        assert.equal(summarizeSdkSystemPromptEchoEvent(event), event);
    }
    const other = { eventType: "assistant.message", data: { role: "system", interactionId: "int-4", content: live } };
    assert.equal(summarizeSdkSystemPromptEchoEvent(other), other);
});

// Stage 2 review S2SF-F2: the summary is session-readable, so it keeps nothing of the echo's text: a private marker at the
// start of an echo (by its shape, and by its known first words) is in neither summary; the whole text is still what the
// owner-only base-instructions file is made from.
test("S2SF-F2: an echo's summary keeps only fixed words and its length, never its text", () => {
    const MARKER = "private-marker-s2sf-f2-31aa";
    const shaped = `${MARKER} token=abc123\n` + "rule ".repeat(100);
    for (const event of [
        { eventType: "system.message", data: { role: "system", interactionId: "int-9", content: shaped } },
        { eventType: "system.message", data: { content: `${TEXT}\n${MARKER}` } },
    ]) {
        const echo = sdkSystemPromptEchoContent(event);
        assert.ok(echo && echo.includes(MARKER));
        const summary = summarizeSdkSystemPromptEchoEvent(event);
        assert.equal(JSON.stringify(summary).includes(MARKER), false, JSON.stringify(summary));
        assert.equal(JSON.stringify(summary).includes("token=abc123"), false);
        assert.equal(summary.data.content, `[SYSTEM: Copilot SDK rebuilt the full system prompt for model input. Full content omitted from CMS (${echo.length} chars).]`);
        // The owner-only file is made from the whole echo, with its secrets hidden.
        assert.ok(workflowBaseInstructionsText(echo).includes(MARKER));
    }
});
