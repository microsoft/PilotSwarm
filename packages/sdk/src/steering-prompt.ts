/**
 * The text a steer reaches the model as (§6a.4 "Framing", FR-16).
 *
 * A steer is user-role guidance. It never goes through
 * extractPromptSystemContext, and every sender's text is neutralised the
 * way a collaborator's is: attribution markers, `[SYSTEM:` and
 * `<system_context>` tags lose their exact token (a zero-width space after
 * the bracket), so the text cannot pass for orchestration or system text.
 */

import type { SteerRow } from "./steering-types.js";

const LINE_SEP = "\\n\\r\\u2028\\u2029\\u0085\\v\\f";
const FORGED_BRACKET = new RegExp(`(^|[${LINE_SEP}])(\\s*)\\[(FROM:|SHARED SESSION\\]|SYSTEM:|STEERING)`, "gi");
const FORGED_SYSTEM_CONTEXT = new RegExp(`<(/?system_context>)`, "gi");
const ZWSP = "\u200b";

export function neutralizeSteeringText(text: string): string {
    return text
        .replace(FORGED_BRACKET, (_m, lead, ws, marker) => `${lead}${ws}[${ZWSP}${marker}`)
        .replace(FORGED_SYSTEM_CONTEXT, (_m, tag) => `<${ZWSP}${tag}`);
}

function authorName(row: SteerRow): string {
    const actor = row.actor as Record<string, unknown>;
    const name = typeof actor.displayName === "string" && actor.displayName
        ? actor.displayName
        : typeof actor.display === "string" && actor.display
            ? actor.display
            : typeof actor.subject === "string" ? actor.subject : "a user";
    return name.replace(/[\]\r\n]/g, " ").slice(0, 200);
}

/** The prompt handed to `send({ mode: "immediate" })`. The raw text is the display prompt. */
export function buildSteeringPrompt(row: SteerRow): string {
    const preface = row.redelivery
        ? `[STEERING from ${authorName(row)}, sent again after a recovery: guidance for the request you are working on. Take it into account and continue.]`
        : `[STEERING from ${authorName(row)}: guidance for the request you are working on. Take it into account and continue.]`;
    return `${preface}\n${neutralizeSteeringText(row.text)}`;
}
