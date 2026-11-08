/**
 * Workflow Simplified stage 2.1c, FU-19: a failed step's error in short plain words, made on the server from the whole
 * stored error (HN #2: the read gives a step's error as a preview cut at 500 characters, whose keys come in sorted order,
 * so a long script error was cut before its message and every screen had to read the cut JSON field by field). The words
 * are stored with the step's failure event (`workflow.state_failed`, and a failed run's `workflow.failed`), and a read
 * gives them beside each failed visit and a failed run (`errorWords`), so the portal, the terminal and an agent's
 * read_workflow say the same sentence. The rules are the portal's (packages/app/ui/core/src/workflow-error-words.js) on
 * the whole error:
 * - a script that failed: "the script stopped with an error: <the first line of its stderr that names an error>", else
 *   "the script exited with code N";
 * - any other error: its message, else its code.
 * At most 240 characters, "…" last when shortened. The error is redacted before it is read, and the words again.
 */
import { isJsonObject, type JsonValue } from "./json.js";
import { redactWorkflowErrorValue, redactWorkflowSecrets } from "./redact.js";

/** The longest words (as the portal shows them). */
export const WORKFLOW_ERROR_WORDS_MAX = 240;

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** An error value as it is stored or sent: its envelope ({ code, message, details }), that envelope's JSON text, or text. */
function envelopeOf(value: unknown, depth = 0): { [key: string]: JsonValue } | string | null {
    if (value === null || value === undefined) return null;
    if (isJsonObject(value as JsonValue)) return value as { [key: string]: JsonValue };
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (depth < 2 && (trimmed.startsWith("{") || trimmed.startsWith("\""))) {
        try { return envelopeOf(JSON.parse(trimmed), depth + 1); } catch { /* text */ }
    }
    return trimmed;
}

/** The error a script's stderr reports ("Error: Unknown model …" → "Unknown model …"), its first such line; else null. */
export function workflowScriptErrorLine(stderr: unknown): string | null {
    if (typeof stderr !== "string") return null;
    for (const line of stderr.split(/\r?\n/u)) {
        const match = /^\s*(?:Uncaught\s+)?(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$]*(?:Error|Exception)(?:\s*\[[^\]]*\])?:\s*(\S.*)$/u.exec(line);
        if (match) return match[1].trim();
    }
    return null;
}

/** At most `max` characters, "…" last when shortened; never a lone half of a surrogate pair. */
function bounded(value: string, max = WORKFLOW_ERROR_WORDS_MAX): string {
    const one = value.replace(/\s*\r?\n\s*/gu, " ");
    if (one.length <= max) return one;
    let end = max - 1;
    const last = one.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return `${one.slice(0, end).trimEnd()}…`;
}

/**
 * A failed step's (or run's) error in short plain words, or null when it says nothing: an error value (its envelope, or
 * the JSON text of it, once or twice encoded, or text). Pure.
 */
export function workflowErrorWords(value: unknown): string | null {
    const envelope = envelopeOf(value);
    if (envelope === null) return null;
    if (typeof envelope === "string") return bounded(redactWorkflowSecrets(envelope));
    const safe = redactWorkflowErrorValue(envelope) as { [key: string]: JsonValue };
    const code = text(safe.code);
    const details = isJsonObject(safe.details ?? null) ? safe.details as { [key: string]: JsonValue } : {};
    if (code === "execution_failed") {
        const line = workflowScriptErrorLine(details.stderr);
        if (line) return bounded(redactWorkflowSecrets(`the script stopped with an error: ${line}`));
        if (Number.isSafeInteger(details.exitCode)) return `the script exited with code ${details.exitCode as number}`;
    }
    const said = text(safe.message) ?? text(safe.error) ?? code;
    return said ? bounded(redactWorkflowSecrets(said)) : null;
}
