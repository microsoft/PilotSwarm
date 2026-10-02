/**
 * The Workspace tab's git marks (ui/react/src/workspace-pane.js): the letter
 * a changed file shows in the tree, the dot a folder with changes inside
 * shows, and the commit list's "5 min ago" times.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { gitTreeMarks, gitTimeAgo } from "../../ui/react/src/workspace-pane.js";

test("a changed file shows its letter; files inside an untracked folder are untracked", () => {
    const marks = gitTreeMarks([
        { path: "src/a.ts", letter: "M" },
        { path: "notes", letter: "U", dir: true },
        { path: "top.md", letter: "A" },
    ]);
    assert.equal(marks.letter("src/a.ts"), "M");
    assert.equal(marks.letter("top.md"), "A");
    assert.equal(marks.letter("notes/deep/todo.md"), "U");
    assert.equal(marks.letter("notesX/todo.md"), null, "only paths inside the folder");
    assert.equal(marks.letter("src/b.ts"), null);
});

test("a folder's dot shows the change inside that matters most", () => {
    const marks = gitTreeMarks([
        { path: "pkg/src/a.ts", letter: "A" },
        { path: "pkg/src/b.ts", letter: "M" },
        { path: "pkg/old.ts", letter: "D" },
        { path: "new", letter: "U", dir: true },
    ]);
    assert.equal(marks.dir("pkg/src"), "M", "modified beats added");
    assert.equal(marks.dir("pkg"), "D", "deleted beats modified");
    assert.equal(marks.dir("new"), "U", "an untracked folder gets a dot itself");
    assert.equal(marks.dir("other"), null);
});

test("commit times read as people say them", () => {
    const now = Date.UTC(2026, 9, 2, 12, 0, 0);
    const ago = (s) => gitTimeAgo(now / 1000 - s, now);
    assert.equal(ago(10), "just now");
    assert.equal(ago(5 * 60), "5 min ago");
    assert.equal(ago(3 * 3600), "3 h ago");
    assert.equal(ago(30 * 3600), "yesterday");
    assert.equal(ago(4 * 86400), "4 days ago");
});
