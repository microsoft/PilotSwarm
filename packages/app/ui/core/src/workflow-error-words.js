/**
 * A workflow's runtime error in plain words (coordinator, 2026-11-06: a failed script showed its raw error JSON, code,
 * details, exit code and a stack, as its headline). The read gives an error as its envelope ({ code, message, details }),
 * as that envelope's JSON text, or as a preview of that text cut at 500 characters, whose keys come in sorted order, so
 * a long script error is cut before its message. Each is read here, the cut one field by field.
 * Pure; shared by the portal and the terminal.
 */

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => (typeof value === "string" && value.trim() ? value.trim() : null);

/** A string field's value in cut JSON text: its whole value, or as much of it as arrived. Null when absent. */
function cutField(json, name) {
    const match = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)`, "u").exec(json);
    if (!match) return null;
    // Drop a cut escape at the end (a lone backslash, or \u with fewer than 4 digits).
    const raw = match[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/u, "");
    try { return JSON.parse(`"${raw}"`); } catch { return null; }
}

/**
 * The parts of a runtime error: { code, message, exitCode, stderr, raw } (each null when absent; raw is the text as it
 * arrived). Null for no error.
 */
export function workflowErrorParts(value) {
    if (value === undefined || value === null || value === "") return null;
    if (isRecord(value)) {
        const details = isRecord(value.details) ? value.details : {};
        return {
            code: text(value.code), message: text(value.message) ?? text(value.error),
            exitCode: Number.isSafeInteger(details.exitCode) ? details.exitCode : null, stderr: text(details.stderr),
            raw: JSON.stringify(value, null, 2),
        };
    }
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; }
    if (isRecord(parsed)) return workflowErrorParts(parsed);
    if (typeof parsed === "string") return { code: null, message: text(parsed), exitCode: null, stderr: null, raw: trimmed };
    if (!trimmed.startsWith("{")) return { code: null, message: trimmed, exitCode: null, stderr: null, raw: trimmed };
    const cut = trimmed.replace(/…$/u, "");
    const exit = /"exitCode":(-?\d+)/u.exec(cut);
    return {
        code: text(cutField(cut, "code")), message: text(cutField(cut, "message")),
        exitCode: exit ? Number(exit[1]) : null, stderr: text(cutField(cut, "stderr")), raw: trimmed,
    };
}

/** The error a script's stderr reports ("Error: Unknown model …" → "Unknown model …"), its first such line; else null. */
export function workflowScriptErrorLine(stderr) {
    if (typeof stderr !== "string") return null;
    for (const line of stderr.split(/\r?\n/u)) {
        const match = /^\s*(?:Uncaught\s+)?(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$]*(?:Error|Exception)(?:\s*\[[^\]]*\])?:\s*(\S.*)$/u.exec(line);
        if (match) return match[1].trim();
    }
    return null;
}

const bounded = (value, max = 240) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

/**
 * What went wrong, in plain words: a script that failed says "the script stopped with an error: <its error>" (else "the
 * script exited with code N"); any other error says its message, else its code. Null when there is nothing to say.
 */
export function workflowErrorWords(value) {
    const parts = workflowErrorParts(value);
    if (!parts) return null;
    if (parts.code === "execution_failed" && (parts.stderr !== null || parts.exitCode !== null)) {
        const line = workflowScriptErrorLine(parts.stderr);
        if (line) return `the script stopped with an error: ${bounded(line)}`;
        if (parts.exitCode !== null) return `the script exited with code ${parts.exitCode}`;
    }
    const said = parts.message ?? parts.code;
    return said ? bounded(said) : null;
}

/** The error as it arrived, for a folded Details block: indented JSON when it is whole JSON, else its text. Null for none. */
export function workflowErrorDetails(value) {
    return workflowErrorParts(value)?.raw ?? null;
}
