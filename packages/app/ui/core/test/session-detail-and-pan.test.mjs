/**
 * The session pane's foldable detail box.
 *
 * ── the fold ──
 * The detail box is ten rows of reference detail pinned under a list you are
 * trying to read. It now starts folded to a one-line summary and remembers
 * whether you opened it.
 *
 * The trap that guards is a PERSISTENCE one, and it is silent. A setting has to
 * be wired in four separate places — normalize, write, read-back merge, and the
 * save effect's hand-maintained dependency array. Miss any one and the toggle
 * works perfectly until you reload, then reverts, with nothing logged. The
 * stylesheet's own comment records this happening once already to `touchScale`
 * (written but never merged); building this feature hit it again, on the
 * dependency array. So the last test below derives the requirement instead of
 * listing it: every field the save path reads must appear in the deps.
 *
 * Run: node --test test/session-detail-and-pan.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { selectSessionStatusSummary } from "../src/selectors.js";
import {
    clampWaitReason,
    visibleWaitReason,
    waitReasonLabel,
    WAIT_REASON_MAX_CHARS,
    WAIT_REASON_MAX_WORDS,
} from "../../react/src/web-app.js";

const webApp = readFileSync(
    fileURLToPath(new URL("../../react/src/web-app.js", import.meta.url)),
    "utf8",
);

// ── the fold: state and reducer ─────────────────────────────────────────────

test("the detail box starts folded", () => {
    const state = createInitialState({ mode: "web" });
    assert.equal(state.ui.sessionDetailCollapsed, true);
});

test("the fold toggles, and an unchanged toggle keeps the same object", () => {
    const state = createInitialState({ mode: "web" });
    const opened = appReducer(state, { type: "ui/sessionDetailCollapsed", collapsed: false });
    assert.equal(opened.ui.sessionDetailCollapsed, false);

    const refolded = appReducer(opened, { type: "ui/sessionDetailCollapsed", collapsed: true });
    assert.equal(refolded.ui.sessionDetailCollapsed, true);

    // Identity, not just equality: a no-op dispatch that returned a new object
    // would re-render every subscriber on each poll.
    const again = appReducer(refolded, { type: "ui/sessionDetailCollapsed", collapsed: true });
    assert.equal(again, refolded);
});

test("a stored profile restores the fold, and an absent one does not clobber it", () => {
    const open = appReducer(
        createInitialState({ mode: "web" }),
        { type: "ui/sessionDetailCollapsed", collapsed: false },
    );

    const applied = appReducer(open, {
        type: "profileSettings/apply",
        settings: { sessionDetailCollapsed: true },
    });
    assert.equal(applied.ui.sessionDetailCollapsed, true);

    // A poll that carries no opinion must leave a fresh local toggle alone —
    // the same no-defaults rule the merge path documents for touchScale.
    const untouched = appReducer(open, { type: "profileSettings/apply", settings: {} });
    assert.equal(untouched.ui.sessionDetailCollapsed, false);
});

// ── the fold: the four wiring points ────────────────────────────────────────

test("the fold is wired through every place a persisted setting has to be", () => {
    const missing = [];
    if (!/candidate\.sessionDetailCollapsed === "boolean"/.test(webApp)) missing.push("normalizeProfileSettings");
    if (!/sessionDetailCollapsed: state\.sessionDetailCollapsed/.test(webApp)) missing.push("profileSettingsFromViewState (write)");
    if (!/hasOwn\(normalizedRemote, "sessionDetailCollapsed"\)/.test(webApp)) missing.push("remote merge (read back)");
    assert.deepEqual(missing, [], `a persisted setting must be wired in all of these: ${missing.join(", ")}`);
});

test("every field the save path reads is in the save effect's dependency array", () => {
    // The deps are hand-maintained, and omitting one does not break the toggle
    // — it breaks only the SAVE, silently, until a reload reveals it. Derive
    // the expected set from what the writer actually reads so a new setting
    // cannot be added to one and forgotten in the other.
    const writerStart = webApp.indexOf("function profileSettingsFromViewState(");
    assert.notEqual(writerStart, -1, "profileSettingsFromViewState not found — renamed?");
    const writerEnd = webApp.indexOf("\n}", writerStart);
    const writer = webApp.slice(writerStart, writerEnd);

    // `state.x` reads inside the writer, minus the ones reached dynamically.
    const read = new Set([...writer.matchAll(/\bstate\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]));
    // touchScale is written through a computed key, `[touchScaleKey()]`, so it
    // never appears as a plain `state.touchScale` read here.
    read.delete("touchScale");

    const effectStart = webApp.indexOf("const settings = profileSettingsFromViewState(state, otherTouchScaleRef.current");
    assert.notEqual(effectStart, -1, "the save effect not found — renamed?");
    const depsMatch = webApp.slice(effectStart).match(/\}, \[([^\]]*)\]\);/);
    assert.ok(depsMatch, "could not read the save effect's dependency array");
    const deps = new Set(
        [...depsMatch[1].matchAll(/\bstate\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]),
    );

    const undeclared = [...read].filter((key) => !deps.has(key)).sort();
    assert.deepEqual(
        undeclared,
        [],
        "these persisted settings are written but are NOT in the save effect's deps, " +
            `so changing them never triggers a save: ${undeclared.join(", ")}`,
    );
});

// ── the detail box's two halves must agree ──────────────────────────────────

test("the WAITING block does not blink while the status holds steady", () => {
    // The reported flicker: the box showed "(running)" and a WAITING row
    // appeared for a few milliseconds on every poll, then vanished.
    //
    // Cause: the two halves ran on different clocks. The Updated row reads the
    // DEBOUNCED status (a change is held 5s, because the 4s catalog poll and
    // the post-event detail sync disagree mid-turn) while waitReason was read
    // raw. So the CMS row clearing wait_reason — client.ts does exactly that
    // when a session goes running — toggled the block under a status that was
    // deliberately not moving.
    const PARENT = "flicker-1";
    const REASON = "Supervise five RCAKit PG Flex incident investigations";
    const row = (extra) => ({
        sessionId: PARENT,
        title: "RCAKit PG Flex",
        updatedAt: Date.now(),
        status: "running",
        orchestrationStatus: "Running",
        ...extra,
    });

    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [row({ waitReason: REASON })] });
    state = appReducer(state, { type: "sessions/selected", sessionId: PARENT });

    const seen = [];
    const sample = () => {
        const session = state.sessions.byId[PARENT];
        const status = selectSessionStatusSummary(session)?.status;
        seen.push(`${status}/${visibleWaitReason(session, status) ? "WAITING" : "-"}`);
    };
    sample();

    for (let i = 0; i < 5; i += 1) {
        // live detail sync: still carries the sentence
        state = appReducer(state, {
            type: "sessions/merged",
            session: { sessionId: PARENT, status: "running", orchestrationStatus: "Running", waitReason: REASON },
        });
        sample();
        // catalog poll: the CMS row has had wait_reason cleared
        state = appReducer(state, { type: "sessions/loaded", sessions: [row({ waitReason: null })] });
        sample();
    }

    assert.deepEqual(
        [...new Set(seen)],
        ["running/-"],
        `the box flickered across polls: ${seen.join(" → ")}`,
    );
});

test("a genuinely waiting session still shows its reason", () => {
    // The gate must not swallow the sentence when it is the whole point of the
    // block — this is the case the flicker fix could easily over-correct.
    const session = { sessionId: "s", waitReason: "Waiting for the 09:00 window" };
    assert.equal(visibleWaitReason(session, "waiting"), "Waiting for the 09:00 window");
    assert.equal(visibleWaitReason(session, "waiting on 7"), "Waiting for the 09:00 window");
    assert.equal(visibleWaitReason(session, "waiting on children"), "Waiting for the 09:00 window");
    assert.equal(visibleWaitReason(session, "input_required"), "Waiting for the 09:00 window");
    // ...and must stay quiet when the box is saying the session is active.
    assert.equal(visibleWaitReason(session, "running"), null);
    assert.equal(visibleWaitReason(session, "idle"), null);
    assert.equal(visibleWaitReason(session, "completed"), null);
    // No sentence is no block, whatever the status says.
    assert.equal(visibleWaitReason({ sessionId: "s", waitReason: "  " }, "waiting"), null);
    assert.equal(visibleWaitReason({ sessionId: "s" }, "waiting"), null);
});

// ── the wait reason is one line, and a cron's is not a "reason" ───────

// A real cron wake-up instruction: this is what `cron` asks the model for
// ("What to do on each wake-up"), and it is replayed on every fire.
const CRON_INSTRUCTION = `Poll the pg-flex repairer sub-agent
(session-df588c0b-d8cc-4b9b-a23f-1b9923a1712a, final cycle 3 of 3) for run
pgflex-20260829-040000 via check_agents. When it returns its
pg-flex-output-repair-plan.v1 JSON: save it as artifact
pgflex-repair-plan-cycle3.json, then apply it locally with
apply-output-repair.mjs against the sealed concurrent sidecar.`;

test("a wait reason is clipped to a glance, however long the stored text is", () => {
    const shown = visibleWaitReason({ sessionId: "s", waitReason: CRON_INSTRUCTION }, "waiting");
    assert.ok(shown.split(" ").length <= WAIT_REASON_MAX_WORDS, "within the word budget");
    assert.ok(shown.endsWith("…"), "and says it was clipped");
    assert.ok(!shown.includes("\n"), "newlines are flattened, not carried into the box");
    // The word budget alone is not a length: these instructions carry session
    // UUIDs, and ten words of those ran to 100 characters.
    assert.ok(shown.length <= WAIT_REASON_MAX_CHARS + 1, `one line, got ${shown.length} chars`);
    assert.equal(shown, "Poll the pg-flex repairer sub-agent…");
});

test("a sentence that already fits is left exactly as it is", () => {
    // The common `wait` case. Clipping must not put an ellipsis on text that
    // was never too long, or every ordinary wait looks truncated.
    for (const text of ["Waiting for the 09:00 window", "Sleeping 30s before the next poll"]) {
        assert.equal(clampWaitReason(text), text);
    }
    assert.equal(clampWaitReason(""), "");
    assert.equal(clampWaitReason(null), "");
});

test("clipping does not leave a comma sitting before the ellipsis", () => {
    const clipped = clampWaitReason("one two three four five six seven eight nine ten, eleven");
    assert.equal(clipped, "one two three four five six seven eight nine ten…");
});

test("a cron session's text is labelled as an instruction, not as a reason", () => {
    // It is not waiting BECAUSE of this text; it is waiting for the next tick,
    // and this is what it will then do.
    assert.equal(waitReasonLabel({ cronActive: true }), "On wake");
    assert.equal(waitReasonLabel({ cronActive: false }), "Waiting");
    assert.equal(waitReasonLabel({}), "Waiting");
    assert.equal(waitReasonLabel(null), "Waiting");
});

test("a long single token is cut rather than allowed to wrap the box", () => {
    // No space to fall back to, so the cut lands mid-token. A clipped UUID
    // beats a box three lines tall.
    const clipped = clampWaitReason(`session-${"d".repeat(120)}`);
    assert.ok(clipped.length <= WAIT_REASON_MAX_CHARS + 1, `got ${clipped.length}`);
    assert.ok(clipped.endsWith("…"));
});
