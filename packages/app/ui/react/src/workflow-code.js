// OF-S2-8 (owner, 2026-11-07T23:12Z, 23:13Z): code in the Workflow viewer. Highlighted YAML, JSON and scripts, and a
// node's Script, Sample input and Sample output sections. The parsers load on demand (workflow-code-lang.js); until
// they arrive a text is shown plain in exactly the same place, so nothing moves when the colours come.
import React from "react";
import { workflowNodeCode } from "../../core/src/workflow-node-code.js";

const h = React.createElement;

let langModule = null;
let langPromise = null;
/** The code module, once loaded (null before). */
export function loadedCodeModule() {
    return langModule;
}
/** Loads the code module once. */
export function loadCodeModule() {
    langPromise ??= import("./workflow-code-lang.js").then((module) => { langModule = module; return module; });
    return langPromise;
}

/** The code module, loading it on first use; null until it is there. */
export function useCodeModule() {
    const [module, setModule] = React.useState(langModule);
    React.useEffect(() => {
        if (module) return undefined;
        let live = true;
        loadCodeModule().then((loaded) => { if (live) setModule(loaded); }).catch(() => {});
        return () => { live = false; };
    }, [module]);
    return module;
}

/** The coloured runs of `text` in `language` ("yaml", "json", "javascript"), or null while its parser loads. */
export function useCodeRuns(text, language) {
    const module = useCodeModule();
    const [ready, setReady] = React.useState(() => Boolean(module?.codeLanguageReady(language)));
    React.useEffect(() => {
        if (!module || !language) return undefined;
        if (module.codeLanguageReady(language)) { setReady(true); return undefined; }
        let live = true;
        module.loadCodeHighlighting(language).then(() => { if (live) setReady(module.codeLanguageReady(language)); }).catch(() => {});
        return () => { live = false; };
    }, [module, language]);
    return React.useMemo(() => (module && language && (ready || module.codeLanguageReady(language)) ? module.codeRuns(text, language) : null),
        [module, language, ready, text]);
}

/** `text` as React children, each coloured run a span with its class. */
export function codeChildren(text, runs) {
    if (!runs || !runs.length) return text;
    const out = [];
    let at = 0;
    runs.forEach((run, index) => {
        if (run.from < at) return;
        if (run.from > at) out.push(text.slice(at, run.from));
        out.push(h("span", { key: index, className: run.className }, text.slice(run.from, run.to)));
        at = run.to;
    });
    if (at < text.length) out.push(text.slice(at));
    return out;
}

/** Whether a text reads as JSON (an object, a list or a quoted string): it is then coloured as JSON. */
export function looksLikeJson(text) {
    return typeof text === "string" && /^\s*[[{"]/.test(text);
}

/**
 * A read-only code box: `<pre class="ps-wf-code" data-language><code>`, coloured by language. `language` "json" may be
 * "auto": coloured as JSON only when the text reads as JSON. Other props go on the <pre>.
 */
export function CodeBlock({ text, language, className = "", ...rest }) {
    const value = typeof text === "string" ? text : String(text ?? "");
    const shown = language === "auto" ? (looksLikeJson(value) ? "json" : null) : language;
    const runs = useCodeRuns(value, shown);
    return h("pre", { ...rest, className: `ps-wf-code${className ? ` ${className}` : ""}`, "data-language": shown ?? undefined,
        "data-highlighted": runs ? "true" : undefined },
        h("code", null, codeChildren(value, runs)));
}

/** A short code text inline (a variable's value), coloured as JSON when it reads as JSON. */
export function CodeText({ text }) {
    const value = typeof text === "string" ? text : String(text ?? "");
    const runs = useCodeRuns(value, looksLikeJson(value) || /^(?:-?\d|true$|false$|null$)/.test(value) ? "json" : null);
    return h("code", { className: "ps-wf-code-inline" }, codeChildren(value, runs));
}

/** The value of a YAML text (yamlDocumentValue), or null while the parser loads or without a text. */
export function useYamlDocument(yaml) {
    const module = useCodeModule();
    return React.useMemo(() => (module && typeof yaml === "string" && yaml ? module.yamlDocumentValue(yaml).value : null), [module, yaml]);
}

/** A collapsible section, closed by default (OF-S2-8): a one-line summary, then its body. */
function Section({ field, summary, title = null, children }) {
    return h("details", { className: "ps-wf-more", "data-section": field },
        h("summary", { title: title ?? undefined }, summary),
        h("div", { className: "ps-wf-more-body" }, children));
}

/**
 * A node's Script, Sample input and Sample output sections (OF-S2-8), each closed by default. `yaml`: the definition's
 * YAML, when the person may read it (null: `hidden` says why there is none); `pending`: it is being read. A sample is
 * made from the node's schema and says so; its schema as written is in a Schema row inside it.
 */
export function NodeCodeSections({ node, yaml = null, pending = false, hidden = null }) {
    const document = useYamlDocument(yaml);
    const code = React.useMemo(() => (document && node ? workflowNodeCode(document, node.id, { type: node.type ?? null }) : null), [document, node?.id, node?.type]);
    if (!node) return null;
    const isScript = node.type === "script" || node.kind === "script";
    if (!code) {
        // The YAML is not read (yet), or this person may not read it: a script node still says it has a script.
        if (!isScript) return null;
        const words = pending || (yaml && !document) ? "Reading the script…" : hidden ?? "The script is not available here.";
        return h("div", { className: "ps-wf-more-list" },
            h(Section, { field: "script", summary: "Script · JavaScript" }, h("p", { className: "ps-wf-muted" }, words)));
    }
    const sample = (part, field) => (part ? h(Section, { field, summary: part.label, title: part.note },
        h("p", { className: "ps-wf-muted ps-wf-sample-note" }, part.note),
        part.sample !== null ? h(CodeBlock, { text: part.sample, language: "json", "data-field": `${field}-json`, "aria-label": part.label })
            : h("p", { className: "ps-wf-muted" }, part.noSample),
        h("details", { className: "ps-wf-more is-schema", "data-section": `${field}-schema` }, h("summary", null, "Schema"),
            h("div", { className: "ps-wf-more-body" }, h(CodeBlock, { text: part.schema, language: "json", "aria-label": `${part.label}: schema` })))) : null);
    if (!code.script && !code.input && !code.output) return null;
    return h("div", { className: "ps-wf-more-list" },
        code.script ? h(Section, { field: "script", summary: code.script.summary },
            h(CodeBlock, { text: code.script.text, language: code.script.language, "data-field": "script-text", "aria-label": `Script of ${node.id}`,
                tabIndex: 0 })) : null,
        sample(code.input, "sample-input"),
        sample(code.output, "sample-output"));
}
