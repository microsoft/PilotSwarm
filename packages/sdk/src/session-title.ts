/**
 * Deployed check DS-3: the Copilot runtime names a session from the first prompt it is sent (its session.title_changed
 * event, recorded into the session's events). A chat's first turn can carry runtime notes before the person's words (a
 * person's save note and a Workflow's end kept for a chat that had not started: stage 2.1 and DS-2), and that event then
 * carried the notes as the session's name. It is recorded with the person's own words instead, and not at all when
 * there are none. Pure.
 */

const RUNTIME_NOTE = /^\[(?:SYSTEM:|WORKFLOW_UPDATE\b|CHILD_UPDATE\b|SESSION_MESSAGE(?:_RESPONSE)?\b)/i;
/** A note that can come before a person's words: "[SYSTEM: ...]", one bracketed block. */
const LEADING_NOTE = /^\[SYSTEM:/i;
/** A runtime message: its header, then its body; all of it is the runtime's, none of it a person's words. */
const RUNTIME_MESSAGE = /^\[(?:WORKFLOW_UPDATE|CHILD_UPDATE|SESSION_MESSAGE(?:_RESPONSE)?)\b/i;
/** The longest name recorded for a session.title_changed event. */
export const SESSION_TITLE_EVENT_MAX = 80;

/** Whether `text` (trimmed) begins with a runtime note or message. */
export function startsWithRuntimeNote(text: string): boolean {
    return RUNTIME_NOTE.test(String(text ?? "").trimStart());
}

/**
 * `text` without the runtime notes it begins with, trimmed. Each "[SYSTEM: ...]" note runs to the bracket that closes
 * its own, brackets inside it balanced (a kept Workflow end's JSON escapes the brackets inside its strings); a note that
 * never closes takes the rest. A runtime message ("[WORKFLOW_UPDATE ...]", "[CHILD_UPDATE ...]", "[SESSION_MESSAGE ...]")
 * is all the runtime's: nothing of it remains. What remains is the person's own words, or "".
 */
export function stripLeadingRuntimeNotes(text: string): string {
    let rest = String(text ?? "").trim();
    for (;;) {
        if (RUNTIME_MESSAGE.test(rest)) return "";
        if (!LEADING_NOTE.test(rest)) return rest;
        let depth = 0;
        let end = -1;
        for (let at = 0; at < rest.length; at += 1) {
            const char = rest[at];
            if (char === "[") depth += 1;
            else if (char === "]") {
                depth -= 1;
                if (depth === 0) { end = at; break; }
            }
        }
        if (end < 0) return "";
        rest = rest.slice(end + 1).trim();
    }
}

/**
 * The Copilot runtime's session.title_changed event as it is recorded: unchanged unless its name begins with a runtime
 * note; then named by the turn's own words (`ownWords`: the person's prompt as the turn records it, without its notes),
 * whitespace collapsed and at most SESSION_TITLE_EVENT_MAX characters; and not recorded (null) when the turn has no
 * words of its own. Every other event is returned as it is.
 */
export function sessionTitleChangedForRecord<E extends { eventType: string; data: unknown }>(event: E, ownWords: string): E | null {
    if (event.eventType !== "session.title_changed") return event;
    const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
    if (typeof data.title !== "string" || !startsWithRuntimeNote(data.title)) return event;
    const words = stripLeadingRuntimeNotes(ownWords).replace(/\s+/g, " ").trim();
    if (!words) return null;
    const title = words.length > SESSION_TITLE_EVENT_MAX ? `${words.slice(0, SESSION_TITLE_EVENT_MAX - 1).trimEnd()}…` : words;
    return { ...event, data: { ...data, title } };
}
