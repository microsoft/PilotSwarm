/**
 * OF-S2-8 (owner, 2026-11-07, released 23:19Z), part A: the Workflow tab's header on a session's definitions.
 * - 23:15Z "no need to have the 'ask the session for a new definition' option": gone from both definition pickers.
 * - 23:18Z: "label the two text boxes ... Definition, Revision ... put [Rev] up on the same line as the definition, so
 *   Definition -> combo box and then Rev -> combo box and then the ... toggle buttons"; the owner info is "the dimmed
 *   info below". 23:19Z: Start at the end of the same row; a phone wraps to two lines (Definition, then Rev, the icons and
 *   Start…); the Workflow picker gets a visible "Workflow" label too.
 * The mounted cases (one line at 1440 px, two at 390 px, focus kept across views) are the browser specs "OF-S2-8".
 *
 * Run: node --test ui/core/test/workflow-simplified-of-s2-8.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { appReducer, createInitialState } from "../src/index.js";
import { sessionDefinitionsModel, sessionRevisionFace, sessionRevisionInfoWords } from "../src/workflow-session-definitions.js";
import { SessionWorkflowTab } from "../../react/src/workflow-session-tab.js";

const OWNER = "owner-1";
const T0 = "2026-11-07T09:00:00.000Z";
const at = minutes => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const rev = (revision, extra = {}) => ({ definitionId: "def-hn", revision, valid: true, semver: "1.0.0", yamlSha256: `sha-${revision}`, irSha256: `ir-${revision}`,
    basedOn: revision > 1 ? revision - 1 : null, actor: { kind: "session", sessionId: OWNER }, imported: false, createdAt: at(revision), errorCount: 0, ...extra });
const HN = {
    definitionId: "def-hn", ownerSessionId: OWNER, name: "hn-top-watch", currentRevision: 3, source: "session", createdAt: at(1), updatedAt: at(3), deletedAt: null,
    newestValidRevision: 2,
    revisions: [rev(1), rev(2, { actor: { kind: "user", provider: "aad", subject: "s-1", display: "Ada Admin" }, semver: "1.1.0" }),
        rev(3, { valid: false, errorCount: 2, irSha256: null })],
    workflows: [{ workflowSessionId: "wf-a", definitionId: "def-hn", revision: 1, runStatus: "completed", createdAt: at(10) }],
};
const ALPHA = { definitionId: "def-alpha", ownerSessionId: OWNER, name: "alpha", currentRevision: 1, source: "session", createdAt: at(0), updatedAt: at(1),
    deletedAt: null, newestValidRevision: 1, revisions: [rev(1, { definitionId: "def-alpha" })], workflows: [] };
const LOCKED = {
    definitionId: "def-pkg", ownerSessionId: OWNER, name: "loop-lab/health-loop", currentRevision: 1, source: "package", locked: true, packageName: "loop-lab",
    createdAt: at(0), updatedAt: at(0), deletedAt: null, newestValidRevision: 1, packageUpdate: null,
    revisions: [{ ...rev(1, { definitionId: "def-pkg", semver: "0.2.0", actor: { kind: "user", provider: "aad", subject: "s-2", display: "Ada Admin" } }),
        package: { packageId: "p", packageName: "loop-lab", semver: "0.2.0", sha256: "s", cardDigest: "c" } }],
    workflows: [],
};

const controllerWith = (tab = {}) => {
    let state = createInitialState({ mode: "api" });
    state = appReducer(state, { type: "ui/workflowTab", ownerId: OWNER, patch: tab });
    return { getState: () => state, subscribe: () => () => {}, dispatch: () => {}, setPrompt() {} };
};
const render = (tab, list = [HN, ALPHA, LOCKED], { phone = false } = {}) => {
    const saved = globalThis.window;
    if (phone) globalThis.window = { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) };
    try {
        return renderToStaticMarkup(React.createElement(SessionWorkflowTab, { controller: controllerWith(tab), mobile: phone,
            modeButtons: React.createElement("button", { type: "button", "aria-label": "Maximize canvas" }), context: { ownerId: OWNER, workflowId: null },
            definitions: sessionDefinitionsModel(list) }));
    } finally {
        if (phone) globalThis.window = saved;
    }
};
const header = html => html.slice(html.indexOf("<header"), html.indexOf("</header>") + 9);
const labelFor = (html, words) => {
    const match = html.match(new RegExp(`<label for="([^"]+)"[^>]*>${words}</label>`));
    assert.ok(match, `a label "${words}"`);
    return match[1];
};
const optionsOf = (html, id) => {
    const select = html.slice(html.indexOf(`id="${id}"`));
    return [...select.slice(0, select.indexOf("</select>")).matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map(match => match[1]);
};

test("no option asks the session for a new definition, in either definition picker; the empty tab still says to ask the session", () => {
    const html = render({ view: "definition", sessionDefinitionId: "def-hn" });
    assert.ok(!html.includes("Ask the session for a new definition"));
    assert.ok(!html.includes("__new__"));
    assert.deepEqual(optionsOf(html, labelFor(html, "Definition")), ["alpha", "hn-top-watch", "loop-lab/health-loop · locked"]);
    const stageOne = fs.readFileSync(new URL("../../react/src/workflow-tab.js", import.meta.url), "utf8");
    assert.ok(!stageOne.includes("Ask the session for a new definition"), "the stage 1 picker too");
    assert.ok(!stageOne.includes("__new__"));
    const empty = render({}, []);
    assert.match(empty, /No definitions yet\./);
    assert.match(empty, /Ask the session to create one\./);
});

test("one row: Definition and its picker, Rev and its picker, the view icons, YAML, Compare, Start… at the end, then full screen", () => {
    const html = render({ view: "definition", sessionDefinitionId: "def-hn" });
    const head = header(html);
    assert.match(head, /^<header class="ps-wf-tab-head is-pickers">/, "one row, not two lines, off the phone");
    const definitionId = labelFor(head, "Definition");
    const revisionId = labelFor(head, "Rev");
    assert.match(head, new RegExp(`<select id="${definitionId}"`), "a real label for the definition picker");
    assert.match(head, new RegExp(`<select id="${revisionId}"[^>]*aria-label="Revision"`), "Rev, read aloud as Revision");
    const order = ["Definition</label>", "Rev</label>", 'aria-label="Definition or Workflows"', 'aria-label="YAML"', 'aria-label="Compare"', 'data-action="start"',
        'aria-label="Maximize canvas"'].map(needle => head.indexOf(needle));
    assert.ok(order.every(index => index > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order, "in the owner's order");
    // The faces are short: the name alone, the number alone; the open lists keep the detail.
    const faces = [...head.matchAll(/<span class="ps-wf-picker-face-text">([^<]*)<\/span>/g)].map(match => match[1]);
    assert.deepEqual(faces, ["hn-top-watch", "3"]);
    assert.deepEqual(optionsOf(head, revisionId).map(words => words.replace(/ · \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}:\d{2}| · \d{1,2}:\d{2}:\d{2}/, " · T")),
        ["Revision 3 · newest · by the session · T · not valid · version 1.0.0", "Revision 2 · by Ada Admin · T · version 1.1.0", "Revision 1 · by the session · T · version 1.0.0"]);
    // Delete… is not in the row: it ends the line under it.
    assert.ok(!head.includes('data-action="delete"'));
});

test("the dimmed line under the row: who, when without seconds, version, newest, not valid; a package's from … locked", () => {
    const html = render({ view: "definition", sessionDefinitionId: "def-hn" });
    const info = html.slice(html.lastIndexOf("<div", html.indexOf('data-field="revision-info"')));
    const line = info.slice(0, info.indexOf("</div>") + 6);
    const words = line.replace(/<[^>]+>/g, "");
    assert.match(words, /^by the session · (\d{4}-\d{2}-\d{2} )?\d{1,2}:\d{2} · version 1\.0\.0 · newest · not valid$/);
    assert.match(line, /<span data-field="not-valid" class="ps-wf-info-error">not valid<\/span>/, "not valid keeps the danger colour");
    assert.match(line, /class="ps-wf-line is-quiet ps-wf-info"/);
    // An older revision chosen: its own author and version, no "newest".
    const older = render({ view: "definition", sessionDefinitionId: "def-hn", sessionRevision: 2 });
    assert.match(older, /<span class="ps-wf-picker-face-text">2<\/span>/);
    assert.match(older.replace(/<[^>]+>/g, ""), /by Ada Admin · (\d{4}-\d{2}-\d{2} )?\d{1,2}:\d{2} · version 1\.1\.0(?! · newest)/);
    // A package's definition: the name alone on the face, its package words on the line.
    const locked = render({ view: "definition", sessionDefinitionId: "def-pkg" });
    assert.match(header(locked), /<span class="ps-wf-picker-face-text">loop-lab\/health-loop<\/span>/);
    // (Make a copy follows once a read says the person may change the session's definitions: the browser specs.)
    const lockedLine = locked.slice(locked.lastIndexOf("<div", locked.indexOf('data-field="revision-info"')));
    assert.match(lockedLine.slice(0, lockedLine.indexOf("</div>")).replace(/<[^>]+>/g, ""),
        /^by Ada Admin · (\d{4}-\d{2}-\d{2} )?\d{1,2}:\d{2} · version 0\.2\.0 · newest · from loop-lab 0\.2\.0 · locked$/);
    assert.match(locked, /data-field="revision-info" data-session-definition="locked"/);
});

test("sessionRevisionInfoWords and sessionRevisionFace: pure", () => {
    const [hn] = sessionDefinitionsModel([HN]);
    assert.deepEqual(sessionRevisionInfoWords(hn, 3, { time: "09:03:00", timeTitle: "2026-11-07 09:03:00 UTC" }), [
        { key: "author", text: "by the session" }, { key: "time", text: "09:03", title: "2026-11-07 09:03:00 UTC" }, { key: "version", text: "version 1.0.0" },
        { key: "newest", text: "newest" }, { key: "not-valid", text: "not valid" }]);
    assert.deepEqual(sessionRevisionInfoWords(hn, 1, { time: "2026-11-06 22:18:01" }).map(part => part.text),
        ["by the session", "2026-11-06 22:18", "version 1.0.0"]);
    assert.deepEqual(sessionRevisionInfoWords(hn, 9), []);
    assert.deepEqual(sessionRevisionInfoWords(null, 1), []);
    const [locked] = sessionDefinitionsModel([LOCKED]);
    assert.deepEqual(sessionRevisionInfoWords(locked, 1).map(part => part.text), ["by Ada Admin", "version 0.2.0", "newest", "from loop-lab 0.2.0 · locked"]);
    assert.equal(sessionRevisionFace(12), "12");
    assert.equal(sessionRevisionFace(null), "—");
});

test("the Workflows view: Definition with its label and the view icons; no Rev, YAML, Compare or Start in the row", () => {
    const html = render({ view: "workflows", sessionDefinitionId: "def-hn" });
    const head = header(html);
    labelFor(head, "Definition");
    assert.ok(!head.includes(">Rev</label>"));
    for (const needle of ['aria-label="YAML"', 'aria-label="Compare"', 'data-action="start"']) assert.ok(!head.includes(needle), needle);
    assert.match(head, /aria-label="Definition or Workflows"/);
    assert.ok(!html.includes('data-field="revision-info"'));
});

test("a phone: the Definition view's row wraps to two lines, Definition with full screen first, then Rev, the icons and Start…", () => {
    const html = render({ view: "definition", sessionDefinitionId: "def-hn" }, undefined, { phone: true });
    const head = header(html);
    assert.match(head, /^<header class="ps-wf-tab-head is-pickers is-two-lines">/);
    const order = ["Definition</label>", 'aria-label="Maximize canvas"', 'class="ps-wf-head-rest"', "Rev</label>", 'data-action="start"'].map(needle => head.indexOf(needle));
    assert.ok(order.every(index => index > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    // The Workflows view stays one line on a phone (Definition, the icons, full screen).
    const list = header(render({ view: "workflows", sessionDefinitionId: "def-hn" }, undefined, { phone: true }));
    assert.match(list, /^<header class="ps-wf-tab-head is-pickers">/);
    assert.ok(list.indexOf('aria-label="Definition or Workflows"') < list.indexOf('aria-label="Maximize canvas"'));
    // The CSS: the rest takes the second line on a phone; the old phone row for the revision picker is gone.
    const css = fs.readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8");
    assert.match(css, /\.ps-wf-tab\.is-phone \.ps-wf-tab-head\.is-two-lines > \.ps-wf-head-rest \{ flex: 1 1 100%;/);
    assert.ok(!css.includes(".ps-wf-bar.is-revisions"));
});

test("the Workflow picker says Workflow in words beside it", () => {
    const source = fs.readFileSync(new URL("../../react/src/workflow-tab.js", import.meta.url), "utf8");
    assert.match(source, /h\(FacedPicker, \{ id, label: "Workflow", kind: "is-number"/);
    assert.match(source, /h\("label", \{ htmlFor: id, className: "ps-wf-picker-label"/);
});
