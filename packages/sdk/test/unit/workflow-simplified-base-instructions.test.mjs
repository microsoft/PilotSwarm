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
    keepWorkflowBaseInstructions, SDK_SYSTEM_PROMPT_PREFIX, sdkSystemPromptEchoContent, workflowBaseInstructionsArtifact, workflowBaseInstructionsRef,
} from "../../dist/workflow/v2/base-instructions.js";

const TEXT = `${SDK_SYSTEM_PROMPT_PREFIX}\n\nYou are an interactive agent. Use your tools.`;

function store(existing = []) {
    const files = new Map(existing.map(([session, name, content]) => [`${session}/${name}`, content]));
    const uploads = [];
    return {
        files, uploads,
        async statArtifact(sessionId, filename) { return files.has(`${sessionId}/${filename}`) ? { filename } : null; },
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
