// The Workspace pane's editor: CodeMirror 6. The pane loads this module only
// when it opens a text file, so the editor is not in the portal's first load.
//
// Colors come from the portal theme: the --ps-code-* colors, each one
// readable on the panel in every theme (themeCodeColors in the theme code).
// Markdown is plain text with colors, at one size, so lines stay evenly
// spaced; the pane's Preview shows it rendered.
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, search, setSearchQuery } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { MergeView, diff } from "@codemirror/merge";

const code = (role) => `var(--ps-code-${role}, var(--ps-foreground))`;

const highlight = HighlightStyle.define([
    { tag: t.comment, color: code("comment"), fontStyle: "italic" },
    { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: code("keyword") },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: code("string") },
    { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: code("number") },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: code("function") },
    { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: code("type") },
    { tag: [t.propertyName, t.attributeName], color: code("property") },
    { tag: t.tagName, color: code("type") },
    { tag: [t.definition(t.variableName), t.special(t.variableName)], color: code("variable") },
    { tag: [t.meta, t.processingInstruction, t.contentSeparator], color: code("comment") },
    { tag: t.invalid, color: code("invalid") },
    { tag: t.inserted, color: code("inserted") },
    { tag: t.deleted, color: code("deleted") },
    // Markdown, plain: the same size everywhere, so every line is one height.
    { tag: t.heading, fontWeight: "700", color: code("heading") },
    { tag: t.strong, fontWeight: "700" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: [t.link, t.url], color: code("link") },
    { tag: t.monospace, color: code("string") },
    { tag: t.quote, color: code("comment"), fontStyle: "italic" },
]);

const theme = EditorView.theme({
    "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent", color: "var(--ps-foreground)" },
    ".cm-scroller": { fontFamily: "var(--ps-mono, ui-monospace, SFMono-Regular, Menlo, monospace)", lineHeight: "1.55" },
    // Solid: a long line scrolled sideways passes UNDER the line numbers.
    ".cm-gutters": { backgroundColor: "var(--ps-surface)", color: "var(--ps-code-comment, var(--ps-muted))", border: "none", borderRight: "1px solid var(--ps-border)" },
    ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--ps-foreground) 5%, transparent)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--ps-surface)", color: "var(--ps-foreground)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in srgb, var(--ps-foreground) 22%, transparent) !important" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ps-foreground)" },
    "&.cm-focused": { outline: "none" },
    ".cm-panels": { backgroundColor: "var(--ps-surface)", color: "var(--ps-foreground)" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--ps-border)" },
    // Matches are outlined, not filled: a fill under coloured code lowers its
    // contrast below what the theme's code colours were chosen for.
    ".cm-searchMatch": { backgroundColor: "transparent", outline: "1px solid var(--ps-muted)", borderRadius: "2px" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "transparent", outline: "2px solid var(--ps-foreground)" },
    ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--ps-foreground) 10%, transparent)" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--ps-surface)", border: "1px solid var(--ps-border)", color: "var(--ps-foreground)" },
    ".cm-tooltip": { backgroundColor: "var(--ps-surface)", border: "1px solid var(--ps-border)", color: "var(--ps-foreground)" },
});

// ─── Find in file ─────────────────────────────────────────────────────
// CodeMirror's own panel carries Replace and unthemed form controls. This
// one only finds: the words, a match count, match case, previous, next.

function findPanel(view) {
    const dom = document.createElement("div");
    dom.className = "ps-ws-find";
    dom.setAttribute("role", "search");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ps-ws-find-input";
    input.placeholder = "Find in file";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Find in file");
    input.setAttribute("main-field", "true");
    const count = document.createElement("span");
    count.className = "ps-ws-find-count";
    count.setAttribute("aria-live", "polite");
    let caseSensitive = false;
    const commit = () => view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: input.value, caseSensitive })) });
    const button = (label, text, run) => {
        const element = document.createElement("button");
        element.type = "button";
        element.className = "ps-ws-find-btn";
        element.title = label;
        element.setAttribute("aria-label", label);
        element.textContent = text;
        element.addEventListener("mousedown", (event) => event.preventDefault());
        element.addEventListener("click", run);
        return element;
    };
    const caseButton = button("Match case", "Aa", () => {
        caseSensitive = !caseSensitive;
        caseButton.setAttribute("aria-pressed", String(caseSensitive));
        commit();
    });
    caseButton.setAttribute("aria-pressed", "false");
    const close = () => {
        closeSearchPanel(view);
        view.focus();
    };
    input.addEventListener("input", commit);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            (event.shiftKey ? findPrevious : findNext)(view);
        } else if (event.key === "Escape") {
            // Only the find box closes: nothing else hears this Escape.
            event.preventDefault();
            event.stopPropagation();
            close();
        }
    });
    dom.append(
        input,
        count,
        caseButton,
        button("Previous match (Shift+Enter)", "↑", () => findPrevious(view)),
        button("Next match (Enter)", "↓", () => findNext(view)),
        button("Close (Escape)", "✕", close),
    );
    const showCount = (state) => {
        const query = getSearchQuery(state);
        if (!query.search || !query.valid) {
            count.textContent = "";
            return;
        }
        const { from, to } = state.selection.main;
        let total = 0;
        let current = 0;
        const cursor = query.getCursor(state);
        for (let match = cursor.next(); !match.done && total < 1000; match = cursor.next()) {
            total += 1;
            if (match.value.from === from && match.value.to === to) current = total;
        }
        count.textContent = total === 0 ? "No matches" : `${current ? `${current} of ` : ""}${total}${total >= 1000 ? "+" : ""}`;
    };
    return {
        dom,
        top: false,
        mount() {
            const query = getSearchQuery(view.state);
            input.value = query.search;
            caseSensitive = query.caseSensitive;
            caseButton.setAttribute("aria-pressed", String(caseSensitive));
            input.select();
            showCount(view.state);
        },
        update(update) {
            let queryChanged = false;
            for (const transaction of update.transactions) {
                for (const effect of transaction.effects) {
                    if (!effect.is(setSearchQuery)) continue;
                    queryChanged = true;
                    if (effect.value.search !== input.value) input.value = effect.value.search;
                }
            }
            if (queryChanged || update.docChanged || update.selectionSet) showCount(update.state);
        },
    };
}

const findInFile = search({ top: false, createPanel: findPanel });

const MARKDOWN_NAME = /\.(md|markdown|mdx)$/i;
export function isMarkdownName(name) {
    return MARKDOWN_NAME.test(String(name || ""));
}

// A script without an extension names its program on the first line.
const SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?([A-Za-z][\w.+-]*)/;
const INTERPRETERS = { sh: "Shell", bash: "Shell", zsh: "Shell", dash: "Shell", ksh: "Shell", python: "Python", node: "JavaScript", deno: "JavaScript", bun: "JavaScript", ruby: "Ruby", perl: "Perl" };

/** The language for a file name (or its `#!` line), loaded on demand; null for plain text. */
export async function languageFor(name, text = "") {
    if (isMarkdownName(name)) return yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages: languages }) });
    let description = LanguageDescription.matchFilename(languages, String(name || ""));
    if (!description) {
        const program = SHEBANG.exec(String(text || "").slice(0, 200))?.[1]?.replace(/[\d.]+$/, "");
        const language = program ? INTERPRETERS[program] : null;
        if (language) description = LanguageDescription.matchLanguageName(languages, language, true);
    }
    if (!description) return null;
    try {
        return await description.load();
    } catch {
        return null;
    }
}

/**
 * An editor in `parent`. `onChange(text)` runs on every edit; `onSave()` on
 * Mod-s. `position` ({ line, cursor }) is where to start: the line at the top
 * and the cursor's offset; `onPosition` hears where the person is, a moment
 * after they scroll or move. Returns handles to replace the text, switch
 * read-only, and destroy it.
 */
export async function createEditor(parent, { doc = "", name = "", readOnly = false, onChange, onSave, position = null, onPosition, lineSeparator = null } = {}) {
    const language = await languageFor(name, doc);
    const editable = new Compartment();
    const view = new EditorView({
        parent,
        state: EditorState.create({
            doc,
            extensions: [
                // A CRLF file stays CRLF: the text the editor gives back joins lines with it.
                lineSeparator ? EditorState.lineSeparator.of(lineSeparator) : [],
                basicSetup,
                keymap.of([
                    indentWithTab,
                    { key: "Mod-s", preventDefault: true, run: () => { onSave?.(); return true; } },
                ]),
                findInFile,
                theme,
                syntaxHighlighting(highlight),
                language ?? [],
                isMarkdownName(name) ? EditorView.lineWrapping : [],
                editable.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
                EditorView.updateListener.of((update) => {
                    // sliceDoc, not doc.toString(): it joins lines with the file's own line end.
                    if (update.docChanged) onChange?.(update.state.sliceDoc());
                    if (update.selectionSet) tellPosition();
                }),
            ],
        }),
    });
    // Where the person is: the top line in view, and the cursor.
    let positionTimer = null;
    function tellPosition() {
        if (!onPosition) return;
        clearTimeout(positionTimer);
        positionTimer = setTimeout(() => {
            if (!view.dom.isConnected) return;
            const block = view.lineBlockAtHeight(Math.max(0, view.scrollDOM.scrollTop));
            onPosition({ line: view.state.doc.lineAt(block.from).number, cursor: view.state.selection.main.head });
        }, 250);
    }
    view.scrollDOM.addEventListener("scroll", tellPosition, { passive: true });
    if (position && typeof position === "object") {
        const docNow = view.state.doc;
        const lineNumber = Math.min(Math.max(1, Math.floor(Number(position.line) || 1)), docNow.lines);
        const cursor = Number.isInteger(position.cursor) && position.cursor >= 0 && position.cursor <= docNow.length ? position.cursor : null;
        view.dispatch({
            ...(cursor !== null ? { selection: { anchor: cursor } } : {}),
            effects: EditorView.scrollIntoView(docNow.line(lineNumber).from, { y: "start" }),
        });
    }
    return {
        view,
        getText: () => view.state.sliceDoc(),
        setText(text) {
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
        },
        setReadOnly(value) {
            view.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)]) });
        },
        focus: () => view.focus(),
        // The Find box, for a button (a phone has no Ctrl+F).
        find: () => openSearchPanel(view),
        destroy: () => {
            clearTimeout(positionTimer);
            view.scrollDOM.removeEventListener("scroll", tellPosition);
            view.destroy();
        },
    };
}

/**
 * Side by side: the file as it is now on the left (read-only), your version on
 * the right. The arrows copy a change from the left into yours.
 */
export async function createCompare(parent, { theirs, mine, name = "", lineSeparator = null } = {}) {
    const language = await languageFor(name, mine);
    const shared = [lineSeparator ? EditorState.lineSeparator.of(lineSeparator) : [], basicSetup, findInFile, theme, syntaxHighlighting(highlight), language ?? [], EditorView.lineWrapping];
    const merge = new MergeView({
        parent,
        a: { doc: theirs, extensions: [...shared, EditorState.readOnly.of(true), EditorView.editable.of(false)] },
        b: { doc: mine, extensions: shared },
        revertControls: "a-to-b",
        highlightChanges: true,
        gutter: true,
    });
    return {
        getMine: () => merge.b.state.sliceDoc(),
        destroy: () => merge.destroy(),
    };
}

// ─── Keep both: a line-level three-way merge ──────────────────────────

function encodeLines(texts) {
    const codes = new Map();
    let next = 0xe000;
    return texts.map((text) => {
        const lines = text.split("\n");
        let encoded = "";
        for (const line of lines) {
            let code = codes.get(line);
            if (code === undefined) {
                if (next > 0xf8ff) throw new Error("too many different lines");
                code = String.fromCharCode(next++);
                codes.set(line, code);
            }
            encoded += code;
        }
        return { encoded, lines };
    });
}

/**
 * Merges your edits and theirs, both made on `base`. Works only when they
 * change different lines, with at least one unchanged line between them;
 * otherwise `{ ok: false }` and the person compares by hand.
 */
export function mergeThreeWay(base, mine, theirs) {
    if (mine === theirs || base === theirs) return { ok: true, text: mine };
    if (base === mine) return { ok: true, text: theirs };
    let encoded;
    try {
        encoded = encodeLines([base, mine, theirs]);
    } catch {
        return { ok: false };
    }
    const [b, m, th] = encoded;
    const ours = diff(b.encoded, m.encoded);
    const their = diff(b.encoded, th.encoded);
    const same = (x, y) => x.fromA === y.fromA && x.toA === y.toA && m.encoded.slice(x.fromB, x.toB) === th.encoded.slice(y.fromB, y.toB);
    for (const x of ours) {
        for (const y of their) {
            if (x.fromA <= y.toA && y.fromA <= x.toA && !same(x, y)) return { ok: false };
        }
    }
    const changes = [
        ...ours.map((c) => ({ fromA: c.fromA, toA: c.toA, lines: m.lines.slice(c.fromB, c.toB) })),
        ...their.filter((y) => !ours.some((x) => same(x, y))).map((c) => ({ fromA: c.fromA, toA: c.toA, lines: th.lines.slice(c.fromB, c.toB) })),
    ].sort((x, y) => x.fromA - y.fromA);
    const out = [];
    let at = 0;
    for (const change of changes) {
        out.push(...b.lines.slice(at, change.fromA), ...change.lines);
        at = change.toA;
    }
    out.push(...b.lines.slice(at));
    return { ok: true, text: out.join("\n") };
}
