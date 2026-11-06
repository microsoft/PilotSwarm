import { createHash } from "node:crypto";

/**
 * A workflow agent node chat's base instructions (owner feedback 2026-11-06, finding 8: the agent node's Log shows "the
 * base prompts"). The SDK echoes the full system prompt it composed for the model as a `system.message`; the runtime
 * records only a short summary of it in the transcript (session-proxy summarizeSdkSystemPromptEchoEvent: its length
 * and a snippet). For the chat of a workflow agent node, the whole text is kept too: once per distinct text (its
 * sha256), as an artifact of its Workflow's session, so every visit of the node (a new chat each visit, or one chat
 * that continues) and every node with the same instructions share one copy. The summary event names it
 * (`baseInstructions`), and the Log reads it when a person opens the row. No schema change: artifacts are the
 * existing blob store.
 */

/** The first words of the system prompt the Copilot SDK composes (its echo is recognised by them). */
export const SDK_SYSTEM_PROMPT_PREFIX = "You are the GitHub Copilot CLI, a terminal assistant built by GitHub.";

/** The full text of an SDK system prompt echo event, or null for any other event. */
export function sdkSystemPromptEchoContent(event: { eventType: string; data: unknown }): string | null {
    if (event.eventType !== "system.message") return null;
    const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : null;
    const content = typeof data?.content === "string" ? data.content : "";
    return content.startsWith(SDK_SYSTEM_PROMPT_PREFIX) ? content : null;
}

/** Where a kept text is: the Workflow's session, the artifact named by its sha256, the hash and its length. */
export interface WorkflowBaseInstructionsRef {
    sessionId: string;
    artifact: string;
    sha256: string;
    chars: number;
}

/** The artifact a text is kept in: named by its sha256, so the same text always names the same artifact. */
export function workflowBaseInstructionsArtifact(sha256: string): string {
    return `base-instructions-${sha256.slice(0, 16)}.md`;
}

/** The reference of `content` kept on the Workflow session `workflowSessionId`. */
export function workflowBaseInstructionsRef(workflowSessionId: string, content: string): WorkflowBaseInstructionsRef {
    const sha256 = createHash("sha256").update(content).digest("hex");
    return { sessionId: workflowSessionId, artifact: workflowBaseInstructionsArtifact(sha256), sha256, chars: content.length };
}

/** The part of the artifact store this needs. */
export interface BaseInstructionsStore {
    statArtifact(sessionId: string, filename: string): Promise<unknown | null>;
    uploadArtifact(sessionId: string, filename: string, content: string, contentType?: string): Promise<unknown>;
}

/** The texts this worker already knows are kept (bounded; a forgotten one is checked in the store again). */
const KEPT = new Set<string>();
const KEPT_MAX = 5_000;

/**
 * Keep a text once: when the store has no artifact by its name yet, write it. Returns whether this call wrote it. Two
 * workers that write the same text at once write the same bytes under the same name.
 */
export async function keepWorkflowBaseInstructions(store: BaseInstructionsStore, ref: WorkflowBaseInstructionsRef, content: string): Promise<boolean> {
    const key = `${ref.sessionId}/${ref.artifact}`;
    if (KEPT.has(key)) return false;
    let wrote = false;
    if (!(await store.statArtifact(ref.sessionId, ref.artifact))) {
        await store.uploadArtifact(ref.sessionId, ref.artifact, content, "text/markdown");
        wrote = true;
    }
    if (KEPT.size >= KEPT_MAX) KEPT.clear();
    KEPT.add(key);
    return wrote;
}
