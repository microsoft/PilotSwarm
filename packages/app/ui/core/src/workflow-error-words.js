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
    return cutFieldOf(json, name)?.value ?? null;
}

/** cutField with whether the value was cut ({ value, cut }); null when absent. */
function cutFieldOf(json, name) {
    const match = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)(")?`, "u").exec(json);
    if (!match) return null;
    // Drop a cut escape at the end (a lone backslash, or \u with fewer than 4 digits).
    const raw = match[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/u, "");
    try { return { value: JSON.parse(`"${raw}"`), cut: match[2] === undefined }; } catch { return null; }
}

/**
 * A JSON string literal's text, whole or cut (a preview cut at 500 characters ends with "…" and has no closing quote):
 * { text, cut }, or null when `json` is not one. A node's runtime error is stored as its envelope's JSON text, so its
 * preview is that text as a JSON string (HN #2 and r3's ux-boom: `"{\"code\":\"execution_failed\",…`).
 */
function jsonStringText(json) {
    if (!json.startsWith("\"")) return null;
    try {
        const whole = JSON.parse(json);
        return typeof whole === "string" ? { text: whole, cut: false } : null;
    } catch { /* cut: read as much as arrived */ }
    let body = json.slice(1).replace(/…$/u, "");
    // Drop a cut escape at the end: an odd run of backslashes, or \u with fewer than 4 digits.
    const unicode = /(\\+)u[0-9a-fA-F]{0,3}$/u.exec(body);
    if (unicode && unicode[1].length % 2 === 1) body = body.slice(0, unicode.index + unicode[1].length - 1);
    const slashes = /\\+$/u.exec(body);
    if (slashes && slashes[0].length % 2 === 1) body = body.slice(0, -1);
    try { return { text: JSON.parse(`"${body}"`), cut: true }; } catch { return null; }
}

/**
 * The parts of a runtime error: { code, message, exitCode, stderr, raw } (each null when absent; raw is the text as it
 * arrived, a JSON string's text unwrapped). Null for no error.
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
    // HN #2 (5482bae3 live data): an error preview that is a JSON string of the envelope's text, cut or whole. Read the
    // text inside; a cut keeps its "…" so the reader still knows more was recorded.
    const literal = jsonStringText(trimmed);
    if (literal) {
        const inner = literal.text.trim();
        if (inner.startsWith("{")) return workflowErrorParts(literal.cut ? `${inner}…` : inner);
        return { code: null, message: text(inner), exitCode: null, stderr: null, raw: literal.cut ? `${inner}…` : trimmed };
    }
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; }
    if (isRecord(parsed)) return workflowErrorParts(parsed);
    if (typeof parsed === "string") return { code: null, message: text(parsed), exitCode: null, stderr: null, raw: trimmed };
    if (!trimmed.startsWith("{")) return { code: null, message: trimmed, exitCode: null, stderr: null, raw: trimmed };
    const cut = trimmed.replace(/…$/u, "");
    const exit = /"exitCode":(-?\d+)/u.exec(cut);
    const stderr = cutFieldOf(cut, "stderr");
    return {
        code: text(cutField(cut, "code")), message: text(cutField(cut, "message")),
        exitCode: exit ? Number(exit[1]) : null, stderr: text(stderr?.value), raw: trimmed,
        // Whether the stderr arrived cut: an error line that is its last line is then shown ending in "…".
        ...(stderr?.cut ? { stderrCut: true } : {}),
    };
}

/** The error a script's stderr reports ("Error: Unknown model …" → "Unknown model …"), its first such line; else null. */
export function workflowScriptErrorLine(stderr) {
    return scriptErrorLineOf(stderr)?.text ?? null;
}

/** workflowScriptErrorLine with whether that line is the last of the stderr: { text, last }; null when there is none. */
function scriptErrorLineOf(stderr) {
    if (typeof stderr !== "string") return null;
    const lines = stderr.split(/\r?\n/u);
    for (let at = 0; at < lines.length; at += 1) {
        const match = /^\s*(?:Uncaught\s+)?(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$]*(?:Error|Exception)(?:\s*\[[^\]]*\])?:\s*(\S.*)$/u.exec(lines[at]);
        if (match) return { text: match[1].trim(), last: lines.slice(at + 1).every(line => !line.trim()) };
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
        const found = scriptErrorLineOf(parts.stderr);
        // A line the cut ended inside says so (HN #2: a long stderr cut at the preview's 500 characters).
        const line = found && parts.stderrCut && found.last && !found.text.endsWith("…") ? `${found.text}…` : found?.text;
        if (line) return `the script stopped with an error: ${bounded(line)}`;
        if (parts.exitCode !== null) return `the script exited with code ${parts.exitCode}`;
    }
    const said = parts.message ?? parts.code;
    return said ? bounded(said) : null;
}

/**
 * Review UI-D7: whether the plain words (workflowErrorWords) leave out recorded detail of the error, so the whole error
 * must stay readable: the stored preview is cut (it ends with "…"), the words are shortened, the error has fields beyond
 * its code and message (its details: a script's stderr, exit code, stack), or a text error is said differently. Pure.
 */
export function workflowErrorLeavesOut(value, words = workflowErrorWords(value)) {
    const parts = workflowErrorParts(value);
    if (!parts) return false;
    if (/…$/u.test(parts.raw) || (typeof words === "string" && words.endsWith("…"))) return true;
    let parsed = isRecord(value) ? value : undefined;
    if (parsed === undefined && typeof value === "string") {
        try { parsed = JSON.parse(value.trim()); } catch { parsed = undefined; }
    }
    if (isRecord(parsed)) return Object.keys(parsed).some(key => key !== "code" && key !== "message");
    if (parts.raw.trim().startsWith("{")) return true;
    return text(parts.raw) !== text(words);
}

/** The error as it arrived, for a folded Details block: indented JSON when it is whole JSON, else its text. Null for none. */
export function workflowErrorDetails(value) {
    return workflowErrorParts(value)?.raw ?? null;
}
