#!/usr/bin/env node
// Unit test — the REAL get_session_transcript HANDLER (issue 148, spec 3.3/3.4).
//
// These drive the SHIPPED tool callback, not a copy of its logic, against a
// mgmt mock that reproduces the stored procedures' selection semantics —
// including the one that matters most here:
//
//     afterSeq = 0 is NOT "from the beginning".
//
// The procedure's guard is `p_after_seq IS NOT NULL AND p_after_seq > 0`
// (packages/sdk/src/cms.ts:51-53), so zero falls through to the LATEST-page
// branch. A transcript that paged forward from zero would silently return the
// newest page while claiming to start at the oldest. The mock below reproduces
// that guard exactly, so a regression to forward paging FAILS here rather than
// passing against a forgiving fake.
//
// Every redaction count is paired with a NEGATIVE CONTROL: a transcript with
// no omissions must report zero. Without that pairing a detector that always
// fires, or always returns a constant, passes the positive case.
//
// No database, no network, no model.
//
// Usage: node packages/app/mcp/test/unit/session-transcript.unit.mjs

import { registerSessionTools } from "../../dist/src/tools/sessions.js";
import { makeServerContext } from "./helpers/fake-context.mjs";

/** Capture the shipped callback with no schema in the path (see page-handler test). */
function captureSessionTool(name, ctx) {
    let captured = null;
    const collector = {
        registerTool(toolName, _spec, handler) { if (toolName === name) captured = handler; },
        registerResource() {},
        registerPrompt() {},
    };
    registerSessionTools(collector, ctx);
    if (!captured) throw new Error(`[test] tool "${name}" was not registered; capture failed`);
    return captured;
}

const results = [];
function record(name, ok, detail = "", info = "") {
    results.push({ name, ok });
    const parts = ok ? [info] : [detail, info];
    const note = parts.filter(Boolean).join(" — ");
    console.log(`${ok ? "✅" : "❌"} ${name.padEnd(68)} ${ok ? "PASS" : "FAIL"}${note ? ` (${note})` : ""}`);
}

const SESSION = "11111111-2222-3333-4444-555555555555";
const SDK_ECHO_MARKER = "[SYSTEM: Copilot SDK rebuilt the full system prompt for model input.";

const ev = (seq, content, type = "assistant.message") => ({
    seq,
    sessionId: SESSION,
    eventType: type,
    data: { content },
    createdAt: new Date(0),
});

/**
 * mgmt mock reproducing the stored-procedure selection rules.
 *
 * `stall` makes every page return the same window regardless of beforeSeq —
 * the non-advancing-cursor fault the drain must detect instead of spinning.
 */
function sessionMgmt(all, { pageLimit = 999, stall = false, calls = null } = {}) {
    return {
        getSession: async () => ({ sessionId: SESSION }),
        getSessionEventsPage: async (_id, opts = {}) => {
            if (calls) calls.push(opts);
            const { afterSeq, beforeSeq, limit, eventTypes } = opts;
            const mode = beforeSeq !== undefined ? "backward"
                : (afterSeq !== undefined && afterSeq > 0) ? "forward" : "latest";
            const applied = Math.max(1, Math.min(limit ?? 50, pageLimit));

            let pool = eventTypes ? all.filter((e) => eventTypes.includes(e.eventType)) : all;

            let eligible;
            if (stall) eligible = [...pool];
            else if (mode === "forward") eligible = pool.filter((e) => e.seq > afterSeq);
            else if (mode === "backward") eligible = pool.filter((e) => e.seq < beforeSeq);
            else eligible = [...pool];

            const window = mode === "forward"
                ? eligible.slice(0, applied)
                : eligible.slice(Math.max(0, eligible.length - applied));
            return {
                events: window,
                receipt: {
                    mode,
                    hasMore: eligible.length > window.length,
                    completeness: "read-view",
                    limitApplied: applied,
                },
            };
        },
    };
}

const textOf = (res) => res.content[0].text;
const bodyOf = (res) => JSON.parse(textOf(res));

async function run() {
    // ── 1. complete drain: truncated_reason must be null ─────────────────
    {
        const all = [ev(101, "first"), ev(102, "second"), ev(103, "third")];
        const handler = captureSessionTool("get_session_transcript", makeServerContext({ mgmt: sessionMgmt(all, { pageLimit: 2 }) }));
        const body = bodyOf(await handler({ session_id: SESSION }));
        const seqs = body.events.map((e) => e.seq);
        record("complete drain reports truncated_reason null",
            body.receipt.truncated_reason === null && body.receipt.reached_oldest_retained === true,
            `truncated_reason=${JSON.stringify(body.receipt.truncated_reason)} reachedOldest=${body.receipt.reached_oldest_retained}`);
        // The decisive orientation case: pageLimit 2 forces multiple pages, and
        // seq 101 is reachable ONLY by paging backward.
        record("drain reaches the OLDEST row across pages (not the latest-page trap)",
            seqs.length === 3 && seqs[0] === 101 && seqs[2] === 103,
            `seqs=${JSON.stringify(seqs)}`, `pages=${body.receipt.pages_read}`);
        record("transcript is ascending and gapless",
            seqs.every((s, i) => i === 0 || s > seqs[i - 1]) && new Set(seqs).size === seqs.length,
            `seqs=${JSON.stringify(seqs)}`);
        record("complete drain offers no continuation bound",
            body.receipt.next_to_seq === null, `next_to_seq=${body.receipt.next_to_seq}`);
    }

    // ── 2. max_events cap ────────────────────────────────────────────────
    {
        const all = Array.from({ length: 10 }, (_, i) => ev(200 + i, `m${i}`));
        const handler = captureSessionTool("get_session_transcript", makeServerContext({ mgmt: sessionMgmt(all) }));
        const body = bodyOf(await handler({ session_id: SESSION, max_events: 4 }));
        const seqs = body.events.map((e) => e.seq);
        record("cap sets truncated_reason max_events",
            body.receipt.truncated_reason === "max_events" && body.count === 4,
            `reason=${body.receipt.truncated_reason} count=${body.count}`);
        // Backward drain keeps the NEWEST, which is the documented behaviour.
        record("cap keeps the NEWEST events",
            seqs[seqs.length - 1] === 209 && seqs[0] === 206, `seqs=${JSON.stringify(seqs)}`);
        record("cap does not claim the oldest was reached",
            body.receipt.reached_oldest_retained === false, `${body.receipt.reached_oldest_retained}`);

        // Continuation must be gapless: next_to_seq is exclusive of everything
        // already delivered, so resuming there must not repeat or skip a row.
        const next = body.receipt.next_to_seq;
        const body2 = bodyOf(await handler({ session_id: SESSION, max_events: 4, to_seq: next }));
        const seqs2 = body2.events.map((e) => e.seq);
        const overlap = seqs2.filter((s) => seqs.includes(s));
        record("continuation from next_to_seq is gapless and non-overlapping",
            next === 205 && overlap.length === 0 && seqs2[seqs2.length - 1] === 205,
            `next=${next} seqs2=${JSON.stringify(seqs2)} overlap=${JSON.stringify(overlap)}`);
    }

    // ── 3. range bound ───────────────────────────────────────────────────
    {
        const all = Array.from({ length: 10 }, (_, i) => ev(300 + i, `r${i}`));
        const handler = captureSessionTool("get_session_transcript", makeServerContext({ mgmt: sessionMgmt(all, { pageLimit: 3 }) }));
        const body = bodyOf(await handler({ session_id: SESSION, from_seq: 304, to_seq: 307 }));
        const seqs = body.events.map((e) => e.seq);
        record("explicit range is honoured inclusively at both ends",
            JSON.stringify(seqs) === JSON.stringify([304, 305, 306, 307]), `seqs=${JSON.stringify(seqs)}`);
        record("a bounded read reports truncated_reason range_bound",
            body.receipt.truncated_reason === "range_bound", `${body.receipt.truncated_reason}`);
        record("requested_range is echoed back for audit",
            body.receipt.requested_range.from_seq === 304 && body.receipt.requested_range.to_seq === 307,
            JSON.stringify(body.receipt.requested_range));
    }

    // ── 4. non-advancing cursor must STOP, not spin ──────────────────────
    {
        const all = Array.from({ length: 5 }, (_, i) => ev(400 + i, `s${i}`));
        const calls = [];
        const handler = captureSessionTool("get_session_transcript",
            makeServerContext({ mgmt: sessionMgmt(all, { pageLimit: 2, stall: true, calls }) }));
        const started = Date.now();
        const body = bodyOf(await handler({ session_id: SESSION, max_events: 50 }));
        record("stalled cursor halts the drain instead of looping",
            body.receipt.stop_reason === "cursor_stalled" && calls.length <= 3,
            `stop_reason=${body.receipt.stop_reason} pages=${calls.length}`,
            `${Date.now() - started}ms`);
        record("a stalled drain never claims completeness",
            body.receipt.truncated_reason === "drain_incomplete" && body.receipt.reached_oldest_retained === false,
            `reason=${body.receipt.truncated_reason} reachedOldest=${body.receipt.reached_oldest_retained}`);
    }

    // ── 5. redactions, each with a negative control ──────────────────────
    {
        const clean = [ev(500, "ordinary"), ev(501, "also ordinary")];
        const handlerClean = captureSessionTool("get_session_transcript", makeServerContext({ mgmt: sessionMgmt(clean) }));
        const bodyClean = bodyOf(await handlerClean({ session_id: SESSION }));
        record("NEGATIVE CONTROL: a clean transcript reports zero redactions",
            bodyClean.redactions.system_prompt_echo === 0
            && bodyClean.redactions.payload_unavailable === 0
            && bodyClean.redactions.by_seq.length === 0,
            JSON.stringify(bodyClean.redactions));

        const dirty = [
            ev(600, "ordinary"),
            ev(601, `${SDK_ECHO_MARKER} Full content omitted from CMS (9 chars). Snippet: x]`),
            { seq: 602, sessionId: SESSION, eventType: "turn.completed", data: null, createdAt: new Date(0) },
        ];
        const handlerDirty = captureSessionTool("get_session_transcript", makeServerContext({ mgmt: sessionMgmt(dirty) }));
        const bodyDirty = bodyOf(await handlerDirty({ session_id: SESSION }));
        record("system_prompt_echo is detected by the real SDK marker",
            bodyDirty.redactions.system_prompt_echo === 1
            && bodyDirty.redactions.by_seq.some((r) => r.seq === 601 && r.kind === "system_prompt_echo"),
            JSON.stringify(bodyDirty.redactions));
        record("payload_unavailable is detected for an absent payload",
            bodyDirty.redactions.payload_unavailable === 1
            && bodyDirty.redactions.by_seq.some((r) => r.seq === 602 && r.kind === "payload_unavailable"),
            JSON.stringify(bodyDirty.redactions));
        record("the two redaction kinds are not collapsed into one",
            bodyDirty.redactions.system_prompt_echo === 1 && bodyDirty.redactions.payload_unavailable === 1,
            JSON.stringify(bodyDirty.redactions));
        record("redactions carry the no-sanitization caveat",
            /no general/i.test(bodyDirty.redactions.note || ""), bodyDirty.redactions.note);
    }

    // ── 6. formats and the untrusted-content notice ──────────────────────
    {
        const all = [ev(700, "hello transcript")];
        const handler = captureSessionTool("get_session_transcript", makeServerContext({ mgmt: sessionMgmt(all) }));
        const j = bodyOf(await handler({ session_id: SESSION, format: "json" }));
        const t = bodyOf(await handler({ session_id: SESSION, format: "text" }));
        record("json format returns structured events, not a rendering",
            Array.isArray(j.events) && j.transcript === undefined, `keys=${Object.keys(j).join(",")}`);
        record("text format returns a rendering carrying the content",
            typeof t.transcript === "string" && t.transcript.includes("hello transcript") && t.events === undefined,
            `transcript=${JSON.stringify((t.transcript || "").slice(0, 60))}`);
        record("both formats carry the untrusted-content warning",
            typeof j.content_warning === "string" && j.content_warning.length > 0
            && typeof t.content_warning === "string" && t.content_warning.length > 0,
            `json=${!!j.content_warning} text=${!!t.content_warning}`);
    }

    // ── 7. event_types reaches the provider as a server-side filter ──────
    {
        const all = [ev(800, "a", "assistant.message"), ev(801, "b", "tool.invoked"), ev(802, "c", "assistant.message")];
        const calls = [];
        const handler = captureSessionTool("get_session_transcript", makeServerContext({ mgmt: sessionMgmt(all, { calls }) }));
        const body = bodyOf(await handler({ session_id: SESSION, event_types: ["assistant.message"] }));
        const seqs = body.events.map((e) => e.seq);
        record("event_types is pushed to the provider, not filtered after paging",
            calls.every((c) => Array.isArray(c.eventTypes) && c.eventTypes[0] === "assistant.message")
            && JSON.stringify(seqs) === JSON.stringify([800, 802]),
            `calls=${JSON.stringify(calls.map((c) => c.eventTypes))} seqs=${JSON.stringify(seqs)}`);
    }

    // ── 8. input validation (routed round the schema on purpose) ─────────
    {
        const handler = captureSessionTool("get_session_transcript", makeServerContext({ mgmt: sessionMgmt([ev(900, "x")]) }));
        const inverted = await handler({ session_id: SESSION, from_seq: 50, to_seq: 10 });
        record("an inverted range is refused, not silently swapped",
            inverted.isError === true && /from_seq/.test(textOf(inverted)),
            textOf(inverted).slice(0, 100));

        // NaN survives Math.max/Math.min, so every later bound comparison would
        // be vacuously false and the guard would fail OPEN. The schema rejects
        // it today; this proves the handler's own defence works regardless.
        const nan = await handler({ session_id: SESSION, max_events: NaN });
        record("NaN max_events is refused by the handler itself (guard fails CLOSED)",
            nan.isError === true && /safe integer/.test(textOf(nan)), textOf(nan).slice(0, 100));

        const missingCtx = makeServerContext({ mgmt: { getSession: async () => null, getSessionEventsPage: async () => { throw new Error("must not be called"); } } });
        const missing = await captureSessionTool("get_session_transcript", missingCtx)({ session_id: SESSION });
        record("an unreadable session is refused BEFORE any event is fetched",
            missing.isError === true && /not found/.test(textOf(missing)), textOf(missing).slice(0, 100));
    }

    const failed = results.filter((r) => !r.ok).length;
    console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
