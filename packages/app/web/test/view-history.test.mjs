import { test } from "node:test";
import assert from "node:assert/strict";
import { createViewHistory, cleanView, navigationShortcut, viewKey } from "../src/navigation/view-history.js";
const view = id => cleanView({ mode: "workspace", sessionId: String(id) });

test("history retains ten views, clamps ends, and replaces the forward branch", () => {
    const h = createViewHistory();
    for (let i = 0; i < 15; i++) h.visit(view(i));
    assert.equal(h.entries.length, 10); assert.equal(h.entries[0].sessionId, "5");
    assert.equal(h.move(1), null);
    h.move(-1); h.move(-1); assert.equal(h.current.sessionId, "12");
    h.visit(view("new")); assert.equal(h.destination(1), null);
    assert.equal(h.move(-1).sessionId, "12");
    while (h.move(-1));
    assert.equal(h.current.sessionId, "5"); assert.equal(h.index, 0);
});
test("repeated destinations update context without adding visits or losing Forward", () => {
    const h = createViewHistory(); h.visit(view(1)); h.visit(view(2)); h.move(-1);
    assert.equal(h.visit(view(1)), false); assert.equal(h.destination(1).sessionId, "2");
    const a = cleanView({ mode: "moa", dashboardId: "ops", panelId: "one" });
    const b = cleanView({ ...a, panelId: "two" });
    assert.equal(viewKey(a), viewKey(b)); h.visit(a); h.visit(b);
    assert.equal(h.current.panelId, "two"); assert.equal(h.entries.length, 2);
    assert.notEqual(viewKey(a), viewKey({ ...a, dashboardId: "review" }));
});
test("storage round trips the cursor and references, never arbitrary payloads", () => {
    const h = createViewHistory(); h.visit({ ...view(1), prompt: "secret", history: ["private text"] }); h.visit(view(2)); h.move(-1);
    assert.doesNotMatch(h.serialize(), /secret|private text|prompt/);
    const restored = createViewHistory(h.serialize());
    assert.equal(restored.current.sessionId, "1"); assert.equal(restored.destination(1).sessionId, "2");
    for (const invalid of ["broken", "null", JSON.stringify({ version: 1, entries: [{ mode: "evil" }], index: 0 }), JSON.stringify({version:1,entries:[view(1)],index:9})])
        assert.equal(createViewHistory(invalid).entries.length, 0);
});
test("keyboard supports Option-produced characters and composer navigation without hijacking other editing", () => {
    const event = extra => ({ altKey: true, code: "Minus", key: "–", ...extra });
    assert.equal(navigationShortcut(event()), -1);
    for (const code of ["Equal", "NumpadAdd"]) assert.equal(navigationShortcut(event({ code, key: "±", shiftKey: true })), 1);
    const composer = { matches: selector => selector === 'textarea.ps-prompt-input', closest: () => ({}) };
    assert.equal(navigationShortcut(event({ target: composer })), -1);
    assert.equal(navigationShortcut(event({ target: composer, code: "Equal", key: "≠" })), 1);
    for (const extra of [{ isComposing: true }, { getModifierState: name => name === "AltGraph" }, { ctrlKey: true }, { repeat: true }])
        assert.equal(navigationShortcut(event({ target: composer, ...extra })), 0);
    for (const extra of [{ altKey: false }, { ctrlKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }, { getModifierState: () => true }, { target: { isContentEditable: true } }, { target: { closest: () => ({}) } }])
        assert.equal(navigationShortcut(event(extra)), 0);
});

test("a phone screen is part of the view: chat, diagnostics and canvas are separate stops", () => {
    const h = createViewHistory();
    h.visit({ ...view(1), mobilePane: "workspace" });
    assert.equal(h.visit({ ...view(1), mobilePane: "inspector" }), true);
    assert.equal(h.visit({ ...view(1), mobilePane: "activity" }), true);
    assert.equal(h.entries.length, 3);
    assert.equal(cleanView({ ...view(1), mobilePane: "anything" }).mobilePane, null);
    const restored = createViewHistory(h.serialize());
    assert.equal(restored.current.mobilePane, "activity");
    assert.equal(restored.destination(-1).mobilePane, "inspector");
});

test("a phone's full-screen artifact preview is a stop of its own, and older entries still load", () => {
    const h = createViewHistory();
    h.visit({ ...view(1), mobilePane: "workspace" });
    const preview = { ...view(1), mobilePane: "workspace", artifactSessionId: "1", artifactFilename: "report.html", artifactFullscreen: true };
    assert.equal(h.visit(preview), true, "opening the preview is a visit");
    assert.notEqual(viewKey(cleanView(preview)), viewKey(cleanView({ ...preview, artifactFullscreen: false })));
    // The preview covers the screen under it: over chat or over the Files
    // tab, it is the same place, so a deep link landing on it adds no stop.
    assert.equal(viewKey(cleanView(preview)), viewKey(cleanView({ ...preview, mobilePane: "inspector" })));
    assert.equal(h.visit({ ...preview, mobilePane: "inspector" }), false, "the same preview refreshes its stop");
    assert.equal(h.index, 1);
    const restored = createViewHistory(h.serialize());
    assert.equal(restored.current.artifactFullscreen, true);
    assert.equal(restored.destination(-1).artifactFullscreen, false);
    // An entry saved before the field existed reads as the desktop pane.
    assert.equal(cleanView({ mode: "workspace", sessionId: "9", artifactSessionId: "9", artifactFilename: "a.md" }).artifactFullscreen, false);
});
