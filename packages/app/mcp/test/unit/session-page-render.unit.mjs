#!/usr/bin/env node
// Unit test — paged history rendering for issue 148.
//
// Covers the three behaviours that are easy to get wrong and expensive to get
// wrong: the byte budget must never strand a caller, omission kinds must stay
// distinct from any notion of redaction, and rendered text must not be able to
// drive the reader's terminal.
//
// Pure. No database, no MCP server, no network.
//
// STATUS: WRITTEN BUT NEVER EXECUTED. No install, build or test grant existed
// when this was authored, so it has not been compiled against or run. Treat
// every assertion as unverified until a real run reports.
import assert from "node:assert/strict";
import {
    applyByteBudget,
    sanitizeForJson,
    classifyStoredOmission,
    escapeTranscriptText,
    renderTranscriptText,
    PAGE_BYTES_DEFAULT,
    PAGE_BYTES_MAX,
    UNTRUSTED_NOTICE,
    SDK_ECHO_MARKER,
} from "../../dist/src/tools/sessions.js";

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ✗ ${name}\n    ${err.message}`);
    }
}

function event(seq, content, extra = {}) {
    return {
        seq,
        sessionId: "s",
        eventType: "assistant.message",
        data: content === null ? null : { content },
        createdAt: new Date(0),
        ...extra,
    };
}

console.log("paged history rendering (issue 148)");

// ── byte budget: progress is guaranteed ──────────────────────────

check("a page under budget is delivered whole and not cut", () => {
    const events = [event(1, "a"), event(2, "b"), event(3, "c")];
    const { delivered, undispatched } = applyByteBudget(events, PAGE_BYTES_DEFAULT);
    assert.equal(delivered.length, 3);
    assert.equal(undispatched, false);
});

check("the budget cuts mid-page and reports it", () => {
    const events = [event(1, "x".repeat(400)), event(2, "y".repeat(400)), event(3, "z".repeat(400))];
    const { delivered, undispatched } = applyByteBudget(events, 600);
    assert.ok(delivered.length >= 1 && delivered.length < 3, `expected a partial page, got ${delivered.length}`);
    assert.equal(undispatched, true);
});

check("an oversized FIRST record is still delivered, payload omitted", () => {
    // Note: it is DISPATCHED, so it does not by itself mean history remains.
    // The stranding case. Without this rule the caller can never advance and
    // loops forever on the same record.
    const events = [event(1, "x".repeat(5000)), event(2, "ok")];
    const { delivered, undispatched, omissions } = applyByteBudget(events, 100);

    assert.equal(delivered.length, 1, "the oversized record must still come back");
    assert.equal(delivered[0].seq, 1);
    assert.equal(delivered[0].data, null, "its payload is dropped");
    assert.equal(delivered[0].payloadOmitted.kind, "byte_budget");
    assert.ok(delivered[0].payloadOmitted.encodedBytes > 100, "the real size is reported");
    assert.ok(omissions.some((o) => o.seq === 1 && o.kind === "byte_budget"));
});

check("delivery never returns a record it did not deliver", () => {
    // The cursor is taken from the last delivered record, so anything returned
    // here is something the caller will mark as consumed.
    const events = [event(1, "a".repeat(300)), event(2, "b".repeat(300)), event(3, "c".repeat(300))];
    const { delivered } = applyByteBudget(events, 400);
    const seqs = delivered.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "delivered stays ordered");
    assert.ok(seqs.length < 3, "the undelivered tail is not returned");
});

check("an empty page is not a cut", () => {
    const { delivered, undispatched } = applyByteBudget([], PAGE_BYTES_DEFAULT);
    assert.deepEqual(delivered, []);
    assert.equal(undispatched, false);
});

check("budget constants are the adopted values", () => {
    assert.equal(PAGE_BYTES_DEFAULT, 256 * 1024);
    assert.equal(PAGE_BYTES_MAX, 1024 * 1024);
});

// ── omissions are NOT a redaction report ─────────────────────────

check("an SDK system-prompt echo marker is classified as sdk_echo", () => {
    const e = event(1, `${SDK_ECHO_MARKER} Full content omitted from CMS (9000 chars). Snippet: ...]`);
    assert.equal(classifyStoredOmission(e), "sdk_echo");
});

check("a missing payload is 'absent', not redacted", () => {
    // Absence has many causes. Calling it redaction would assert a scrub that
    // never happened.
    assert.equal(classifyStoredOmission(event(1, null)), "absent");
    assert.equal(classifyStoredOmission({ seq: 1 }), "absent");
});

check("ordinary content yields NO omission entry", () => {
    assert.equal(classifyStoredOmission(event(1, "hello")), null);
});

check("an unredacted secret-shaped string is NOT reported as an omission", () => {
    // The boundary that stops this field drifting into implying a redaction
    // engine. PilotSwarm does not scrub payloads; it must not look as if it does.
    const e = event(1, "AKIAIOSFODNN7EXAMPLE and password=hunter2 and ghp_0123456789abcdef");
    assert.equal(classifyStoredOmission(e), null);

    const { omissions } = applyByteBudget([e], PAGE_BYTES_DEFAULT);
    assert.deepEqual(omissions, [], "a clean page reports nothing omitted");
});

check("a clean page's empty omissions list means nothing omitted, not 'scanned'", () => {
    const { omissions, undispatched } = applyByteBudget([event(1, "a"), event(2, "b")], PAGE_BYTES_DEFAULT);
    assert.equal(omissions.length, 0);
    assert.equal(undispatched, false);
});

// ── text rendering cannot drive a terminal ───────────────────────

check("control characters are escaped", () => {
    const out = escapeTranscriptText("before\u001b[31mRED\u0007after\u0000end");
    assert.ok(!out.includes("\u001b"), "ESC must not survive");
    assert.ok(!out.includes("\u0007"), "BEL must not survive");
    assert.ok(!out.includes("\u0000"), "NUL must not survive");
    assert.ok(out.includes("\\x1b"), "escaped form is visible");
});

check("a carriage return cannot overwrite the line", () => {
    // Regression: the original class ran \u000B\u000C then \u000E-\u001F,
    // skipping \u000D entirely, so CR survived. A lone CR returns the cursor
    // to column zero, letting injected text overwrite the line already
    // rendered — the exact log-injection vector this escaping exists to stop.
    const out = escapeTranscriptText("real content\rFAKE");
    assert.ok(!out.includes("\r"));
    assert.ok(out.includes("\\x0d"));
});

check("every C0 control except tab and newline is escaped, and those two survive", () => {
    // Pins the whole boundary rather than one character, so a future edit
    // cannot silently reopen a hole next to the ones already covered.
    for (let code = 0x00; code <= 0x1f; code++) {
        const ch = String.fromCharCode(code);
        const out = escapeTranscriptText(`a${ch}b`);
        if (code === 0x09 || code === 0x0a) {
            assert.ok(out.includes(ch), `code ${code} (tab/newline) must survive`);
        } else {
            assert.ok(!out.includes(ch), `code ${code} must be escaped`);
        }
    }
    assert.ok(!escapeTranscriptText(`a\u007fb`).includes("\u007f"), "DEL must be escaped");
});

check("newlines and ordinary text survive unchanged", () => {
    assert.equal(escapeTranscriptText("line one\nline two"), "line one\nline two");
    assert.equal(escapeTranscriptText("héllo — ünïcode 日本語"), "héllo — ünïcode 日本語");
});

check("a transcript renders chronologically with seq and timestamp", () => {
    const text = renderTranscriptText([event(1, "first"), event(2, "second")]);
    assert.ok(text.includes("seq 1"));
    assert.ok(text.includes("seq 2"));
    assert.ok(text.includes("1970-01-01T00:00:00.000Z"));
    assert.ok(text.indexOf("first") < text.indexOf("second"), "chronological order");
});

check("an omitted payload is visible in the transcript, not silently blank", () => {
    const { delivered } = applyByteBudget([event(1, "x".repeat(5000))], 100);
    const text = renderTranscriptText(delivered);
    assert.ok(text.includes("payload omitted"));
    assert.ok(text.includes("byte_budget"));
});

check("a stored-null payload renders explicitly", () => {
    assert.ok(renderTranscriptText([event(1, null)]).includes("no payload stored"));
});

check("escaping applies to rendered content too", () => {
    const text = renderTranscriptText([event(1, "danger\u001b[2Jclear")]);
    assert.ok(!text.includes("\u001b"), "a transcript must not carry a live escape sequence");
});

// ── untrusted framing ────────────────────────────────────────────

check("the untrusted notice states data, not instructions", () => {
    assert.match(UNTRUSTED_NOTICE, /UNTRUSTED CONTENT/);
    assert.match(UNTRUSTED_NOTICE, /not instructions/i);
});


// ── F1: orientation-aware cutting (Opus 4.8 review, blocking) ────

/**
 * Simulate a receipt-driven drain over a whole session, cutting by budget at
 * every step, and return the multiset of seqs the caller would actually see.
 *
 * This is the shape of the real bug: each individual page looked fine, and
 * only following the cursor across pages revealed that some rows were never
 * returned by anything.
 */
function drain({ mode, all, pageSize, budget }) {
    const seen = [];
    let cursor = null;
    let guard = 0;
    while (guard++ < 200) {
        let window;
        if (mode === "forward") {
            const from = cursor === null ? 0 : all.findIndex((e) => e.seq === cursor) + 1;
            window = all.slice(from, from + pageSize);
        } else {
            const end = cursor === null ? all.length : all.findIndex((e) => e.seq === cursor);
            window = all.slice(Math.max(0, end - pageSize), end);
        }
        if (window.length === 0) break;
        const orientation = mode === "forward" ? "forward" : "backward";
        const { delivered } = applyByteBudget(window, budget, orientation);
        if (delivered.length === 0) break;
        seen.push(...delivered.map((e) => e.seq));
        cursor = orientation === "forward"
            ? delivered[delivered.length - 1].seq
            : delivered[0].seq;
    }
    return seen;
}

const BIG = (seq) => event(seq, "x".repeat(400));

check("F1 latest drain with budget cuts loses no events and duplicates none", () => {
    // The regression. Before the fix the budget kept the OLDEST rows while the
    // cursor moved DOWNWARD, so the newest rows sat above everything the drain
    // would ever revisit and vanished silently.
    const all = Array.from({ length: 20 }, (_, i) => BIG(i + 1));
    const seen = drain({ mode: "latest", all, pageSize: 5, budget: 900 });
    const sorted = [...seen].sort((a, b) => a - b);
    assert.deepEqual(sorted, all.map((e) => e.seq), "every seq delivered exactly once");
    assert.equal(new Set(seen).size, seen.length, "no duplicates");
});

check("F1 backward drain with budget cuts loses no events and duplicates none", () => {
    const all = Array.from({ length: 20 }, (_, i) => BIG(i + 1));
    const seen = drain({ mode: "backward", all, pageSize: 4, budget: 900 });
    assert.deepEqual([...seen].sort((a, b) => a - b), all.map((e) => e.seq));
    assert.equal(new Set(seen).size, seen.length);
});

check("F1 forward drain is unchanged (positive control)", () => {
    // Forward was always correct. If this breaks, the fix over-corrected.
    const all = Array.from({ length: 20 }, (_, i) => BIG(i + 1));
    const seen = drain({ mode: "forward", all, pageSize: 5, budget: 900 });
    assert.deepEqual([...seen].sort((a, b) => a - b), all.map((e) => e.seq));
    assert.equal(new Set(seen).size, seen.length);
});

check("F1 backward cut keeps the NEWEST rows, not the oldest", () => {
    const window = [BIG(10), BIG(11), BIG(12), BIG(13)];
    const { delivered, undispatched } = applyByteBudget(window, 900, "backward");
    assert.equal(undispatched, true);
    const seqs = delivered.map((e) => e.seq);
    assert.ok(seqs.includes(13), "the newest row must survive a downward-continuing cut");
    assert.ok(!seqs.includes(10), "the oldest row is the one dropped; it lies below the cursor");
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "delivered stays ascending");
});

check("F1 oversized first record still advances in BOTH orientations", () => {
    for (const orientation of ["forward", "backward"]) {
        const window = [event(1, "a"), event(2, "x".repeat(5000)), event(3, "c")];
        const { delivered } = applyByteBudget(window, 50, orientation);
        assert.ok(delivered.length >= 1, `${orientation}: must deliver something to advance`);
        assert.ok(delivered.some((e) => e.payloadOmitted), `${orientation}: oversized record delivered with payload omitted`);
    }
});

check("F1 property: random oversized records still partition the session", () => {
    const all = Array.from({ length: 30 }, (_, i) =>
        event(i + 1, (i % 4 === 0 ? "x".repeat(3000) : "y".repeat(200))));
    for (const mode of ["latest", "backward", "forward"]) {
        const seen = drain({ mode, all, pageSize: 6, budget: 1200 });
        assert.deepEqual([...seen].sort((a, b) => a - b), all.map((e) => e.seq), `${mode}: drain is a partition`);
        assert.equal(new Set(seen).size, seen.length, `${mode}: no duplicates`);
    }
});

// ── F2: C1, line separators, bidi, and JSON mode ─────────────────

check("F2 C1 controls, line separators and bidi overrides are escaped", () => {
    const cases = {
        "CSI U+009B": "\u009b", "NEL U+0085": "\u0085",
        "C1 low U+0080": "\u0080", "C1 high U+009F": "\u009f",
        "LINE SEP U+2028": "\u2028", "PARA SEP U+2029": "\u2029",
        "RLO U+202E": "\u202e", "LRI U+2066": "\u2066",
    };
    for (const [name, ch] of Object.entries(cases)) {
        const out = escapeTranscriptText(`a${ch}b`);
        assert.ok(!out.includes(ch), `${name} must not survive`);
    }
});

check("F2 tab, newline and printable Unicode still survive", () => {
    assert.equal(escapeTranscriptText("one\ttwo\nthree"), "one\ttwo\nthree");
    assert.equal(escapeTranscriptText("héllo — 日本語 🙂"), "héllo — 日本語 🙂");
});

check("F2 JSON mode is neutralized too, not just text mode", () => {
    // JSON.stringify escapes C0 but NOT DEL, C1, U+2028 or U+2029, so JSON
    // readers were exposed to exactly what the text renderer guards against.
    const payload = sanitizeForJson({
        seq: 1,
        data: { content: "danger\u009b2Jclear\u2028injected", nested: ["\u0085", "\u202e"] },
    });
    const encoded = JSON.stringify(payload);
    for (const ch of ["\u009b", "\u2028", "\u0085", "\u202e"]) {
        assert.ok(!encoded.includes(ch), `JSON output must not carry ${escape(ch)}`);
    }
    assert.ok(encoded.includes("danger"), "ordinary text survives");
});

check("F2 sanitizeForJson preserves structure and non-string values", () => {
    const out = sanitizeForJson({ seq: 7, ok: true, nil: null, list: [1, "a"], deep: { k: "v" } });
    assert.equal(out.seq, 7);
    assert.equal(out.ok, true);
    assert.equal(out.nil, null);
    assert.deepEqual(out.list, [1, "a"]);
    assert.equal(out.deep.k, "v");
});

// ── unencodable records must not bypass the budget ───────────────

check("an unencodable record is omitted explicitly, never counted as free", () => {
    // encodedBytes used to return 0 on failure. Zero is success-shaped: the
    // record would consume no budget and be delivered uncounted.
    const circular = { seq: 2, sessionId: "s", eventType: "assistant.message", createdAt: new Date(0) };
    circular.data = { self: circular };
    const { delivered, omissions } = applyByteBudget([event(1, "a"), circular], 10_000, "forward");

    const bad = delivered.find((e) => e.seq === 2);
    assert.ok(bad, "the record is still delivered so the cursor can advance");
    assert.equal(bad.data, null, "its payload is dropped");
    assert.equal(bad.payloadOmitted.kind, "unencodable");
    assert.ok(omissions.some((o) => o.seq === 2 && o.kind === "unencodable"),
        "and it is reported as an omission, not silently passed");
});


// ── G61-04 / G61-05: receipt honesty (different-family review) ───

check("a dispatched oversized record does NOT mean history remains", () => {
    // G61-04. Payload omission and row exhaustion are different properties.
    // One oversized row, fully dispatched, must not report undispatched work.
    const { delivered, undispatched } = applyByteBudget([event(1, "x".repeat(5000))], 100, "forward");
    assert.equal(delivered.length, 1, "the row is dispatched, in omitted form");
    assert.ok(delivered[0].payloadOmitted, "its payload is omitted");
    assert.equal(undispatched, false,
        "nothing was left undispatched, so the handler must not invent remaining history");
});

check("a genuinely undispatched row IS reported", () => {
    const { delivered, undispatched } = applyByteBudget(
        [event(1, "a".repeat(300)), event(2, "b".repeat(300)), event(3, "c".repeat(300))], 400, "forward");
    assert.ok(delivered.length < 3, "some rows did not fit");
    assert.equal(undispatched, true, "and that is remaining history");
});

check("G61-05 every omission belongs to a DELIVERED row", () => {
    // Omissions were previously recorded before the row was accepted, so the
    // receipt could claim omission evidence for a sequence outside the
    // delivered range - making "omissions describes this response" false.
    const marked = (seq) => event(seq, `${SDK_ECHO_MARKER} Full content omitted from CMS (9000 chars). Snippet: ...]`);
    const window = [event(1, "a".repeat(300)), marked(2), marked(3)];
    for (const orientation of ["forward", "backward"]) {
        const { delivered, omissions } = applyByteBudget(window, 400, orientation);
        const deliveredSeqs = new Set(delivered.map((e) => e.seq));
        for (const o of omissions) {
            assert.ok(deliveredSeqs.has(o.seq),
                `${orientation}: omission for seq ${o.seq} must belong to a delivered row`);
        }
    }
});

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
