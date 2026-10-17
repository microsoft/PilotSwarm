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
    const { delivered, cut } = applyByteBudget(events, PAGE_BYTES_DEFAULT);
    assert.equal(delivered.length, 3);
    assert.equal(cut, false);
});

check("the budget cuts mid-page and reports it", () => {
    const events = [event(1, "x".repeat(400)), event(2, "y".repeat(400)), event(3, "z".repeat(400))];
    const { delivered, cut } = applyByteBudget(events, 600);
    assert.ok(delivered.length >= 1 && delivered.length < 3, `expected a partial page, got ${delivered.length}`);
    assert.equal(cut, true);
});

check("an oversized FIRST record is still delivered, payload omitted", () => {
    // The stranding case. Without this rule the caller can never advance and
    // loops forever on the same record.
    const events = [event(1, "x".repeat(5000)), event(2, "ok")];
    const { delivered, cut, omissions } = applyByteBudget(events, 100);

    assert.equal(delivered.length, 1, "the oversized record must still come back");
    assert.equal(delivered[0].seq, 1);
    assert.equal(delivered[0].data, null, "its payload is dropped");
    assert.equal(delivered[0].payloadOmitted.kind, "byte_budget");
    assert.ok(delivered[0].payloadOmitted.encodedBytes > 100, "the real size is reported");
    assert.equal(cut, true);
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
    const { delivered, cut } = applyByteBudget([], PAGE_BYTES_DEFAULT);
    assert.deepEqual(delivered, []);
    assert.equal(cut, false);
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
    const { omissions, cut } = applyByteBudget([event(1, "a"), event(2, "b")], PAGE_BYTES_DEFAULT);
    assert.equal(omissions.length, 0);
    assert.equal(cut, false);
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

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
