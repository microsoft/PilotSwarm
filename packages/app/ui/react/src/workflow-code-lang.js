// OF-S2-8 (owner, 2026-11-07T23:12Z, 23:13Z): the Workflow viewer's code, highlighted and read. Loaded on demand
// (workflow-code.js), so the parsers are not in the portal's first load. It reuses the parsers the portal already
// bundles for the Workspace editor (CodeMirror's Lezer grammars): YAML for definitions, JSON for values and schemas,
// JavaScript for scripts. Colours are classes (ps-code-<role>) painted with the theme's --ps-code-* colours, each one
// readable on the panel in every theme (themeCodeColors).
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { yamlLanguage } from "@codemirror/lang-yaml";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

const role = (name) => `ps-code-${name}`;

const highlighter = tagHighlighter([
    { tag: t.comment, class: role("comment") },
    { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.self], class: role("keyword") },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], class: role("string") },
    { tag: [t.number, t.bool, t.null, t.atom, t.unit], class: role("number") },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: role("function") },
    { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], class: role("type") },
    { tag: [t.propertyName, t.attributeName], class: role("property") },
    { tag: [t.definition(t.variableName), t.special(t.variableName)], class: role("variable") },
    { tag: [t.meta, t.processingInstruction, t.contentSeparator], class: role("comment") },
    { tag: t.invalid, class: role("invalid") },
]);

const LANGUAGE_NAMES = { javascript: "javascript", json: "json" };
const parsers = new Map([["yaml", yamlLanguage.parser]]);
const loading = new Map();

/** The parser of a language ("yaml", "json", "javascript"), loading it once; null for one this module does not know. */
export async function loadCodeLanguage(language) {
    if (parsers.has(language)) return parsers.get(language);
    const name = LANGUAGE_NAMES[language];
    if (!name) return null;
    if (!loading.has(language)) {
        loading.set(language, (async () => {
            const description = LanguageDescription.matchLanguageName(languages, name, true);
            const support = description ? await description.load() : null;
            const parser = support?.language?.parser ?? null;
            if (parser) parsers.set(language, parser);
            return parser;
        })());
    }
    return loading.get(language);
}

/** Whether a language's parser is loaded (codeRuns answers at once). YAML needs JavaScript too, for its scripts. */
export function codeLanguageReady(language) {
    return parsers.has(language) && (language !== "yaml" || parsers.has("javascript"));
}

/** Loads a language and what its highlighting needs (YAML: JavaScript, for a script's source). */
export async function loadCodeHighlighting(language) {
    if (language === "yaml") await loadCodeLanguage("javascript");
    return loadCodeLanguage(language);
}

const NUMBERISH = /^(?:[-+]?(?:0|[1-9][0-9_]*)(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)|0x[0-9a-fA-F]+|0o[0-7]+)$/;
const CONSTANTS = /^(?:null|Null|NULL|~|true|True|TRUE|false|False|FALSE)$/;

/**
 * The coloured runs of `text` in `language`: [{ from, to, className }], in order and apart; null when its parser is not
 * loaded (the text is then shown plain, in the same place). A YAML definition's script (`source:` with a block or a
 * quoted value) is coloured as JavaScript.
 */
export function codeRuns(text, language) {
    if (typeof text !== "string" || !text) return [];
    if (!codeLanguageReady(language)) return null;
    const parser = parsers.get(language);
    const runs = [];
    const add = (from, to, className) => { if (to > from && className) runs.push({ from, to, className }); };
    if (language !== "yaml") {
        highlightTree(parser.parse(text), highlighter, (from, to, classes) => add(from, to, classes));
        return runs;
    }
    const javascript = parsers.get("javascript");
    const keyText = (pair) => {
        const key = pair?.getChild("Key");
        return key ? text.slice(key.from, key.to).trim().replace(/^["']|["']$/g, "") : null;
    };
    parser.parse(text).iterate({
        enter(node) {
            switch (node.name) {
                case "Comment": add(node.from, node.to, role("comment")); return false;
                case "Key": add(node.from, node.to, role("property")); return false;
                case "Anchor": case "Alias": case "Tag": add(node.from, node.to, role("type")); return false;
                case "DirectiveName": case "DirectiveContent": case "DocEnd": case "DirectiveEnd": add(node.from, node.to, role("comment")); return false;
                case "QuotedLiteral": add(node.from, node.to, role("string")); return false;
                case "Literal": {
                    const value = text.slice(node.from, node.to).trim();
                    add(node.from, node.to, NUMBERISH.test(value) || CONSTANTS.test(value) ? role("number") : role("string"));
                    return false;
                }
                case "BlockLiteralHeader": add(node.from, node.to, role("keyword")); return false;
                case "BlockLiteralContent": {
                    const pair = node.node.parent?.parent;
                    if (javascript && pair?.name === "Pair" && keyText(pair) === "source") {
                        const source = text.slice(node.from, node.to);
                        highlightTree(javascript.parse(source), highlighter, (from, to, classes) => add(node.from + from, node.from + to, classes));
                    } else {
                        add(node.from, node.to, role("string"));
                    }
                    return false;
                }
                default: return undefined;
            }
        },
    });
    return runs;
}

// ─── YAML values ─────────────────────────────────────────────────────
// The definition's own values (a node's script and schemas), read from its YAML on the page, as the YAML viewer shows
// it: mappings, sequences, plain, quoted and block scalars, anchors and aliases. Anything else reads as its text.

function unquoteDouble(body) {
    let out = "";
    for (let index = 0; index < body.length; index += 1) {
        const char = body[index];
        if (char === "\n") {
            // A line break inside a double-quoted scalar folds to a space; blank lines keep their breaks.
            out = out.replace(/[ \t]+$/, "");
            let breaks = 0;
            while (body[index + 1] === "\n" || body[index + 1] === " " || body[index + 1] === "\t") {
                if (body[index + 1] === "\n") breaks += 1;
                index += 1;
            }
            out += breaks ? "\n".repeat(breaks) : " ";
            continue;
        }
        if (char !== "\\") { out += char; continue; }
        const next = body[index + 1];
        index += 1;
        const simple = { n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "\\": "\\", "/": "/", " ": " ", b: "\b", f: "\f", e: "\u001b", a: "\u0007", v: "\v",
            N: "\u0085", _: "\u00a0", L: "\u2028", P: "\u2029", "\t": "\t" };
        if (Object.hasOwn(simple, next)) { out += simple[next]; continue; }
        const width = next === "x" ? 2 : next === "u" ? 4 : next === "U" ? 8 : 0;
        if (width) {
            const code = Number.parseInt(body.slice(index + 1, index + 1 + width), 16);
            if (Number.isFinite(code)) out += String.fromCodePoint(code);
            index += width;
            continue;
        }
        if (next === "\n") { while (body[index + 1] === " " || body[index + 1] === "\t") index += 1; continue; }
        out += next ?? "";
    }
    return out;
}

function foldPlain(raw) {
    return raw.split("\n").map((line) => line.trim()).reduce((out, line, index) => {
        if (index === 0) return line;
        if (!line) return `${out}\n`;
        return out.endsWith("\n") ? out + line : `${out} ${line}`;
    }, "");
}

function plainValue(raw) {
    const value = foldPlain(raw);
    if (/^(?:null|Null|NULL|~)?$/.test(value)) return null;
    if (/^(?:true|True|TRUE)$/.test(value)) return true;
    if (/^(?:false|False|FALSE)$/.test(value)) return false;
    if (/^[-+]?(?:0|[1-9][0-9]*)$/.test(value)) return Number(value);
    if (/^0x[0-9a-fA-F]+$/.test(value)) return Number.parseInt(value.slice(2), 16);
    if (/^0o[0-7]+$/.test(value)) return Number.parseInt(value.slice(2), 8);
    if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(value)) return Number(value);
    if (/^[-+]?\.(?:inf|Inf|INF)$/.test(value)) return value.startsWith("-") ? -Infinity : Infinity;
    return value;
}

function blockValue(header, content) {
    const style = header.trim()[0];
    const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
    const indicator = Number.parseInt(header.replace(/[^1-9]/g, ""), 10);
    const lines = content.split("\n");
    const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^ */)[0].length);
    const indent = Number.isFinite(indicator) && indents.length ? Math.min(...indents, indicator) : indents.length ? Math.min(...indents) : 0;
    const body = lines.map((line) => line.slice(Math.min(indent, line.match(/^ */)[0].length)));
    let out;
    if (style === "|") {
        out = body.join("\n");
    } else {
        // Folded: a single break between two lines is a space; each blank line is a break; more-indented lines keep theirs.
        out = "";
        body.forEach((line, index) => {
            if (index === 0) { out = line; return; }
            const previous = body[index - 1];
            if (!line.trim()) { out += "\n"; return; }
            if (!previous.trim()) { out += line; return; }
            out += /^[ \t]/.test(line) || /^[ \t]/.test(previous) ? `\n${line}` : ` ${line}`;
        });
    }
    out = out.replace(/\n+$/, "");
    return chomp === "strip" ? out : `${out}\n`;
}

/**
 * The value of a YAML document as JSON: { ok, value }, `ok` false when the text has a syntax error (`value` is then
 * what could be read). Pure.
 */
export function yamlDocumentValue(text) {
    if (typeof text !== "string") return { ok: false, value: null };
    const tree = yamlLanguage.parser.parse(text);
    let ok = true;
    tree.iterate({ enter: (node) => { if (node.type.isError) ok = false; } });
    const anchors = new Map();
    const read = (node, depth = 0) => {
        if (!node || depth > 200) return null;
        switch (node.name) {
            case "Document": case "Item": {
                for (let child = node.firstChild; child; child = child.nextSibling) {
                    if (!["Comment", "-", "DirectiveEnd", "DocEnd", "Directive"].includes(child.name) && !child.type.isError) return read(child, depth + 1);
                }
                return null;
            }
            case "BlockMapping": case "FlowMapping": {
                const out = {};
                for (let pair = node.firstChild; pair; pair = pair.nextSibling) {
                    if (pair.name !== "Pair") continue;
                    const key = pair.getChild("Key");
                    const keyNode = key?.firstChild;
                    const name = keyNode ? String(read(keyNode, depth + 1) ?? "") : key ? text.slice(key.from, key.to).trim() : "";
                    let valueNode = null;
                    let seenColon = false;
                    for (let child = pair.firstChild; child; child = child.nextSibling) {
                        if (child.name === ":") { seenColon = true; continue; }
                        if (seenColon && child.name !== "Comment" && !child.type.isError) { valueNode = child; break; }
                    }
                    out[name] = valueNode ? read(valueNode, depth + 1) : null;
                }
                return out;
            }
            case "BlockSequence": case "FlowSequence": {
                const out = [];
                for (let item = node.firstChild; item; item = item.nextSibling) if (item.name === "Item") out.push(read(item, depth + 1));
                return out;
            }
            case "Literal": return plainValue(text.slice(node.from, node.to));
            case "QuotedLiteral": {
                const raw = text.slice(node.from, node.to);
                return raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'").split("\n").map((line, index) => (index ? line.trim() : line)).join(" ")
                    : unquoteDouble(raw.slice(1, -1));
            }
            case "BlockLiteral": {
                const header = node.getChild("BlockLiteralHeader");
                const content = node.getChild("BlockLiteralContent");
                return blockValue(header ? text.slice(header.from, header.to) : "|", content ? text.slice(content.from, content.to) : "");
            }
            case "Anchored": {
                const anchor = node.getChild("Anchor");
                let value = null;
                for (let child = node.firstChild; child; child = child.nextSibling) if (child.name !== "Anchor") { value = read(child, depth + 1); break; }
                if (anchor) anchors.set(text.slice(anchor.from + 1, anchor.to), value);
                return value;
            }
            case "Alias": return anchors.get(text.slice(node.from + 1, node.to)) ?? null;
            case "Tagged": {
                const tag = node.getChild("Tag");
                let child = node.firstChild;
                while (child && child.name === "Tag") child = child.nextSibling;
                const value = read(child, depth + 1);
                return tag && text.slice(tag.from, tag.to) === "!!str" && child ? (child.name === "Literal" ? foldPlain(text.slice(child.from, child.to)) : String(value)) : value;
            }
            default: return null;
        }
    };
    const top = tree.topNode.getChild("Document");
    return { ok, value: top ? read(top) : null };
}
