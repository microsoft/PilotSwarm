import { canonicalJson, sha256Hex, type JsonValue } from "./json.js";

/** Coded Workflow store/planning error shared by pure modules (rerun.ts) and WorkflowStore without pulling in pg. */
export class WorkflowStoreError extends Error {
    constructor(readonly code: string, message: string, readonly details: JsonValue = null) {
        super(message);
        this.name = "WorkflowStoreError";
    }
}

/** Deterministic node execution identity from its history-selected coordinates. */
export function nodeExecutionIdFor(runId: string, scopeId: string, nodeId: string, ordinal: number): string {
    return `nx-${sha256Hex(canonicalJson([runId, scopeId, nodeId, ordinal])).slice(0, 40)}`;
}
