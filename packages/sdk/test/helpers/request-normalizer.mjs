/**
 * Request normalizer for differential tests (C1 in
 * docs/proposals/session-workspaces.md).
 *
 * Reduces one chat-completions request to the two parts a code change can
 * alter: the system message and the tools array. Lines the Copilot CLI or the
 * test run owns (paths, dates, ids that differ per run) are replaced with
 * fixed tokens. The tools array keeps its order and content: a reordered or
 * reworded tool is a real difference.
 */
import { systemText } from "./scripted-model.mjs";

/**
 * Lines owned by the CLI or by the test run. Each entry replaces the value
 * after the label, and keeps the label so a diff still shows which line moved.
 */
export const MASKED_LINE_LABELS = [
    "Current working directory",
    "Git repository root",
    "Available tools",
    "Session folder",
];

/** Values that differ per run and can appear anywhere in the text. */
function runValuePatterns(values) {
    return Object.entries(values)
        .filter(([, value]) => typeof value === "string" && value.length > 0)
        .sort(([, a], [, b]) => b.length - a.length)
        .map(([name, value]) => ({ name, value }));
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mask one text block.
 *
 * @param {string} text
 * @param {object} [runValues] - { name: value } pairs to replace with <name>,
 *   for example { baseDir: env.baseDir, cwd: process.cwd() }. Longest first.
 */
export function maskText(text, runValues = {}) {
    let out = text;
    for (const { name, value } of runValuePatterns(runValues)) {
        out = out.split(value).join(`<${name}>`);
    }
    for (const label of MASKED_LINE_LABELS) {
        const re = new RegExp(`^(\\s*[-*]?\\s*${escapeRegExp(label)}\\s*[:=]).*$`, "gm");
        out = out.replace(re, `$1 <masked>`);
    }
    return out;
}

/**
 * Normalize a request body.
 *
 * @returns {{ system: string, tools: Array }}
 */
export function normalizeRequest(body, runValues = {}) {
    const system = maskText(systemText(body), runValues);
    const tools = JSON.parse(maskText(JSON.stringify(body?.tools ?? []), runValues));
    return { system, tools };
}

/**
 * Render a normalized request as stable text for a line diff: the system
 * message, then one block per tool in the original order.
 */
export function renderNormalized(normalized) {
    const parts = ["=== system ===", normalized.system, "", `=== tools (${normalized.tools.length}) ===`];
    for (const tool of normalized.tools) {
        const name = tool?.function?.name ?? tool?.name ?? "?";
        parts.push(`--- ${name} ---`, JSON.stringify(tool, null, 2));
    }
    return parts.join("\n") + "\n";
}
