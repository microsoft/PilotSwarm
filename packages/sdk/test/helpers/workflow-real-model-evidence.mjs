/**
 * What a real-model case leaves in its receipt about the session's Workflows, read before the test environment is cleaned up
 * (DEV, UXP-AC-01 run 2: a valid revision started and its run failed, and the receipt held no YAML and no error, so a
 * failure the model wrote could not be told from a product defect):
 * - each saved revision of the session's definitions: its YAML (secrets hidden, at most 8 KB) and its diagnostics;
 * - each Workflow the session started, and each test of a revision: every run's status, terminal outcome and error;
 * - each node execution of those runs: its state, outcome and error, as stored (secrets hidden).
 * Reading changes nothing, and a read that fails is recorded in the evidence, never thrown: assertions are the case's.
 */
import { redactThenClip, redactWorkflowErrorValue, redactWorkflowSecrets } from "../../src/workflow/redact.ts";

/** The most YAML kept per revision. */
export const EVIDENCE_YAML_MAX_BYTES = 8 * 1024;
/** The most node executions kept per run (the newest are dropped past it, and the count says so). */
export const EVIDENCE_NODES_MAX = 200;
export const EVIDENCE_SESSION_EVENTS_MAX = 1_000;
export const EVIDENCE_SESSION_EVENT_MAX_BYTES = 64 * 1024;

/** `text` with its secrets hidden, cut to `max` UTF-8 bytes (the cut says how long the whole was). */
export function evidenceText(text, max = EVIDENCE_YAML_MAX_BYTES) {
    if (typeof text !== "string") return text ?? null;
    const redacted = redactWorkflowSecrets(text);
    const bytes = Buffer.from(redacted, "utf8");
    if (bytes.length <= max) return redacted;
    return `${bytes.subarray(0, max).toString("utf8").replace(/\uFFFD$/, "")}… [cut: ${bytes.length} bytes in all]`;
}

/** A read that failed, in words: its message with secrets hidden before it is cut (review DSS-002: never cut first). */
const failed = error => `unreadable: ${redactThenClip(String(error?.message ?? error), 300)}`;

/** A failed turn or a new question is not successful completion of the requested work. */
export function healthyBetweenTurns(row) {
    if (["failed", "error", "cancelled", "input_required"].includes(row?.state)) {
        throw new Error(`Session did not settle successfully: ${row.state}${row.lastError ? `: ${evidenceText(row.lastError, 1_000)}` : ""}`);
    }
    return ["idle", "waiting", "completed"].includes(row?.state);
}

/** Capture the session outcome before cleanup, including failures that produced no Workflow. */
export async function realModelSessionEvidence(catalog, sessionId) {
    const evidence = {};
    try {
        const row = await catalog.getSession(sessionId);
        evidence.session = row ? {
            state: row.state,
            lastError: evidenceText(row.lastError ?? null, 1_000),
        } : null;
    } catch (error) {
        evidence.session = failed(error);
    }
    try {
        const rows = await catalog.getSessionEvents(sessionId, 0, EVIDENCE_SESSION_EVENTS_MAX + 1, [
            "assistant.message", "assistant.usage", "session.error", "session.turn_completed",
            "tool.execution_start", "tool.execution_complete",
        ]);
        evidence.events = rows.slice(0, EVIDENCE_SESSION_EVENTS_MAX).map(event => ({
            seq: event.seq,
            type: event.eventType,
            data: evidenceText(JSON.stringify(event.data), EVIDENCE_SESSION_EVENT_MAX_BYTES),
        }));
        evidence.enableWorkflowsRan = rows.some(event => event.eventType === "tool.execution_start"
            && (event.data?.toolName ?? event.data?.name) === "enable_workflows");
        if (rows.length > EVIDENCE_SESSION_EVENTS_MAX) {
            evidence.eventsCut = `the first ${EVIDENCE_SESSION_EVENTS_MAX} matching events only`;
        }
    } catch (error) {
        evidence.events = failed(error);
    }
    try {
        evidence.workflowsOn = (await catalog.getSessionCapabilities(sessionId))?.workflows === true;
    } catch (error) {
        evidence.workflowsOn = failed(error);
    }
    return evidence;
}

/** One run with its node executions. */
async function runEvidence(store, run) {
    const evidence = { runId: run.runId, mode: run.mode, status: run.status, outcome: run.terminalOutcome ?? null,
        terminalState: run.terminalNodeId ?? null, error: redactWorkflowErrorValue(run.terminalError ?? null) };
    try {
        const nodes = await store.listNodeExecutions(run.runId, EVIDENCE_NODES_MAX + 1);
        evidence.nodes = nodes.slice(0, EVIDENCE_NODES_MAX).map(node => ({
            nodeId: node.nodeId, step: node.ordinal, type: node.nodeType, state: node.state, outcome: node.outcome ?? null,
            resultKind: node.resultKind ?? null, winner: node.winner ?? null, error: redactWorkflowErrorValue(node.error ?? null),
        }));
        if (nodes.length > EVIDENCE_NODES_MAX) evidence.nodesCut = `the first ${EVIDENCE_NODES_MAX} node executions only`;
    } catch (error) {
        evidence.nodes = failed(error);
    }
    return evidence;
}

/** Every run of a Workflow session (a started Workflow, or a test's bench). */
async function workflowEvidence(store, workflowSessionId, extra) {
    const evidence = { workflowSessionId, ...extra };
    try {
        evidence.runs = [];
        for (const run of await store.listRuns(workflowSessionId)) evidence.runs.push(await runEvidence(store, run));
    } catch (error) {
        evidence.runs = failed(error);
    }
    return evidence;
}

/** The evidence of the session `ownerSessionId`'s definitions, Workflows and tests, from `catalog`'s workflow store. */
export async function realModelWorkflowEvidence(catalog, ownerSessionId) {
    const evidence = { revisions: [], workflows: [], tests: [] };
    try {
        const store = catalog.workflowStore();
        const sessionDefinitions = store.sessionDefinitions;
        const definitions = await sessionDefinitions.listDefinitions(ownerSessionId, { includeDeleted: true });
        for (const definition of definitions) {
            for (const summary of await sessionDefinitions.listRevisions(definition.definitionId)) {
                const row = await sessionDefinitions.readRevision(definition.definitionId, summary.revision).catch(error => ({ unreadable: failed(error) }));
                evidence.revisions.push({
                    definitionId: definition.definitionId, name: definition.name, revision: summary.revision, valid: summary.valid,
                    savedAt: summary.createdAt ?? null,
                    ...(row?.unreadable ? { yaml: row.unreadable } : {
                        yaml: evidenceText(row?.yaml ?? null),
                        diagnostics: (row?.diagnostics ?? []).map(item => ({ severity: item.severity ?? null, path: item.path ?? null,
                            code: item.code ?? null, ...(item.line !== undefined ? { line: item.line } : {}), message: evidenceText(String(item.message ?? ""), 1_000) })),
                    }),
                });
            }
            for (const test of await sessionDefinitions.listTests(ownerSessionId, definition.definitionId)) {
                evidence.tests.push(await workflowEvidence(store, test.testId,
                    { definitionId: test.definitionId, revision: test.revision, verdict: test.verdict }));
            }
        }
        for (const row of await sessionDefinitions.listWorkflows({ ownerSessionId })) {
            evidence.workflows.push(await workflowEvidence(store, row.workflowSessionId, { definitionId: row.definitionId, revision: row.revision }));
        }
    } catch (error) {
        evidence.error = failed(error);
    }
    return evidence;
}
