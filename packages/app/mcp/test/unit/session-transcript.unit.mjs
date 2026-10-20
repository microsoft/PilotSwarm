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
        // ASSERT THE EXACT SET, not just its tail and the absence of overlap.
        // The weaker form accepted a second page of [205] alone — so a
        // regression that silently dropped 202-204 would have passed while
        // losing three rows out of the middle of the history.
        const next = body.receipt.next_to_seq;
        const body2 = bodyOf(await handler({ session_id: SESSION, max_events: 4, to_seq: next }));
        const seqs2 = body2.events.map((e) => e.seq);
        const overlap = seqs2.filter((s) => seqs.includes(s));
        record("continuation from next_to_seq returns the EXACT expected rows",
            next === 205 && JSON.stringify(seqs2) === JSON.stringify([202, 203, 204, 205]),
            `next=${next} seqs2=${JSON.stringify(seqs2)} expected=[202,203,204,205]`);
        record("continuation does not overlap the first page",
            overlap.length === 0, `overlap=${JSON.stringify(overlap)}`);

        // Drain the WHOLE fixture through successive continuations and compare
        // the union against the known sequences. A partition claim is only
        // worth anything if it is checked over the entire history.
        {
            const drained = [...seqs];
            let cursor = body.receipt.next_to_seq, guard = 10;
            while (cursor !== null && guard-- > 0) {
                const page = bodyOf(await handler({ session_id: SESSION, max_events: 4, to_seq: cursor }));
                drained.push(...page.events.map((e) => e.seq));
                cursor = page.receipt.next_to_seq;
            }
            const sorted = [...drained].sort((x, y) => x - y);
            const expected = all.map((e) => e.seq);
            record("successive continuations PARTITION the whole session",
                JSON.stringify(sorted) === JSON.stringify(expected)
                && new Set(drained).size === drained.length,
                `drained=${JSON.stringify(sorted)} expected=${JSON.stringify(expected)}`);
        }

        // EXACT-CAP TERMINAL CASE. A session of exactly max_events rows is
        // complete, not truncated: the provider says no more history on the
        // same page that fills the cap. Reporting max_events here would claim
        // a cut that did not happen and hand back a cursor that returns
        // nothing.
        {
            const four = [ev(240, "a"), ev(241, "b"), ev(242, "c"), ev(243, "d")];
            const h4 = captureSessionTool("get_session_transcript", makeServerContext({ mgmt: sessionMgmt(four) }));
            const b4 = bodyOf(await h4({ session_id: SESSION, max_events: 4 }));
            record("a session of EXACTLY max_events rows reports completeness, not a cut",
                b4.receipt.truncated_reason === null
                && b4.receipt.reached_oldest_retained === true
                && b4.receipt.next_to_seq === null
                && b4.count === 4,
                `reason=${JSON.stringify(b4.receipt.truncated_reason)} oldest=${b4.receipt.reached_oldest_retained} next=${b4.receipt.next_to_seq} count=${b4.count}`);

            const b1 = bodyOf(await h4({ session_id: SESSION, max_events: 1 }));
            record("a genuine cap cut is still reported as max_events",
                b1.receipt.truncated_reason === "max_events"
                && b1.receipt.reached_oldest_retained === false
                && b1.receipt.next_to_seq === 242,
                `reason=${b1.receipt.truncated_reason} oldest=${b1.receipt.reached_oldest_retained} next=${b1.receipt.next_to_seq}`);
        }
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

    // ── 9. a single event larger than the ceiling is a LIMIT, not a dead end ──
    //
    // A session whose newest event is huge - a big final tool result is the
    // ordinary case - must still be transcribable. Dropping rows cannot help
    // once one remains, so the row is delivered WITHOUT its payload, exactly as
    // the paged reader does. Refusing instead would make such a session
    // permanently untranscribable while the paged reader handled it fine.
    {
        const huge = "x".repeat(1024 * 1024 + 4096);
        const all = [ev(1000, huge)];
        const handler = captureSessionTool("get_session_transcript", makeServerContext({ mgmt: sessionMgmt(all) }));
        const res = await handler({ session_id: SESSION });
        const body = res.isError ? null : bodyOf(res);
        record("an oversized single event is delivered, not refused",
            body !== null && body.count === 1,
            res.isError ? `refused: ${textOf(res).slice(0, 140)}` : `count=${body?.count}`);
        record("the oversized row is delivered with its payload omitted for size",
            body !== null && body.events?.[0]?.payloadOmitted?.kind === "byte_budget"
            && body.events?.[0]?.data === null,
            body ? JSON.stringify(body.events?.[0]?.payloadOmitted) : "n/a");
        record("a byte cut is reported as truncated_reason byte_budget",
            body !== null && body.receipt.truncated_reason === "byte_budget",
            body ? `${body.receipt.truncated_reason}` : "n/a");
        // The anti-misreport assertion. The stripped row has data === null, so a
        // naive redaction pass would classify it 'absent' and report
        // payload_unavailable - telling the caller the payload was never stored
        // when in truth we declined to send it.
        record("a reader-side byte cut is NOT reported as a write-time redaction",
            body !== null && body.redactions.payload_unavailable === 0
            && body.redactions.by_seq.length === 0,
            body ? JSON.stringify(body.redactions) : "n/a");
        record("the response respects the ceiling after the cut",
            body !== null && Buffer.byteLength(textOf(res), "utf8") <= 1024 * 1024,
            `bytes=${Buffer.byteLength(textOf(res), "utf8")}`);
    }

    // ── 10. a row that is BOTH write-time omitted AND too large to send ──
    //
    // The writer keeps other fields beside its summary marker
    // (`...(data ?? {})` in session-proxy.ts), so a row can carry the SDK echo
    // marker AND a large auxiliary field. Stripping it for size must not erase
    // the write-time omission: that row really did have its system prompt
    // omitted before storage, and reporting zero would be a false clean bill.
    {
        const bigEcho = {
            seq: 1100,
            sessionId: SESSION,
            eventType: "assistant.message",
            data: { content: `${SDK_ECHO_MARKER} Full content omitted from CMS (9 chars). Snippet: x]`, aux: "y".repeat(1024 * 1024 + 4096) },
            createdAt: new Date(0),
        };
        const handler = captureSessionTool("get_session_transcript", makeServerContext({ mgmt: sessionMgmt([bigEcho]) }));
        const res = await handler({ session_id: SESSION });
        const body = res.isError ? null : bodyOf(res);
        record("an oversized row is still delivered, with its payload omitted",
            body !== null && body.events?.[0]?.payloadOmitted?.kind === "byte_budget" && body.events?.[0]?.data === null,
            res.isError ? `refused: ${textOf(res).slice(0, 140)}` : JSON.stringify(body?.events?.[0]?.payloadOmitted));
        record("a write-time echo is NOT erased by a reader-side byte cut",
            body !== null && body.redactions?.system_prompt_echo === 1
            && body.redactions?.by_seq?.some((r) => r.seq === 1100 && r.kind === "system_prompt_echo"),
            body ? JSON.stringify(body.redactions) : "n/a");
        record("the byte cut is still NOT reported as payload_unavailable",
            body !== null && body.redactions?.payload_unavailable === 0,
            body ? JSON.stringify(body.redactions) : "n/a");

        // NEGATIVE CONTROL: oversized but with no write-time omission at all.
        // Without this, a detector that simply always reported one echo would
        // pass the case above.
        const bigClean = {
            seq: 1101, sessionId: SESSION, eventType: "assistant.message",
            data: { content: "ordinary", aux: "y".repeat(1024 * 1024 + 4096) }, createdAt: new Date(0),
        };
        const h2 = captureSessionTool("get_session_transcript", makeServerContext({ mgmt: sessionMgmt([bigClean]) }));
        const r2 = await h2({ session_id: SESSION });
        const b2 = r2.isError ? null : bodyOf(r2);
        record("NEGATIVE CONTROL: an oversized CLEAN row reports zero redactions",
            b2 !== null && b2.redactions?.system_prompt_echo === 0 && b2.redactions?.payload_unavailable === 0,
            b2 ? JSON.stringify(b2.redactions) : `refused: ${textOf(r2).slice(0, 140)}`);
    }

    // ── 11. MULTI-ROW byte pressure: the halving loop, never previously run ──
    //
    // Every earlier oversized fixture had exactly one row, so the trim loop was
    // never entered. Here each row fits on its own but the set does not: the
    // response must keep the NEWEST suffix, report byte_budget, stop claiming
    // it reached the oldest, and hand back an exact continuation bound.
    {
        const chunk = "z".repeat(300 * 1024);
        const many = [ev(1200, chunk), ev(1201, chunk), ev(1202, chunk), ev(1203, chunk), ev(1204, chunk)];
        const handler = captureSessionTool("get_session_transcript", makeServerContext({ mgmt: sessionMgmt(many) }));
        const res = await handler({ session_id: SESSION });
        const body = res.isError ? null : bodyOf(res);
        const seqs = body?.events?.map((e) => e.seq) ?? [];
        const bytes = Buffer.byteLength(textOf(res), "utf8");
        record("multi-row byte pressure returns a response within the ceiling",
            body !== null && bytes <= 1024 * 1024, `isError=${res.isError} bytes=${bytes}`);
        record("the byte trim keeps the NEWEST rows, not the oldest",
            seqs.length > 0 && seqs.length < many.length && seqs[seqs.length - 1] === 1204,
            `seqs=${JSON.stringify(seqs)} of ${JSON.stringify(many.map((e) => e.seq))}`);
        record("a multi-row byte cut reports byte_budget and drops the oldest claim",
            body?.receipt?.truncated_reason === "byte_budget" && body?.receipt?.reached_oldest_retained === false,
            `reason=${body?.receipt?.truncated_reason} oldest=${body?.receipt?.reached_oldest_retained}`);
        record("a byte-cut transcript still offers an exact continuation bound",
            body?.receipt?.next_to_seq === (seqs[0] - 1),
            `next_to_seq=${body?.receipt?.next_to_seq} lowest_delivered=${seqs[0]}`);
    }

    // ── 12. an inclusive to_seq we cannot honour is refused HERE ─────────
    {
        const handler = captureSessionTool("get_session_transcript", makeServerContext({ mgmt: sessionMgmt([ev(1300, "x")]) }));
        const res = await handler({ session_id: SESSION, to_seq: Number.MAX_SAFE_INTEGER });
        record("to_seq at the safe-integer boundary is refused with a named reason",
            res.isError === true && /to_seq is too large/.test(textOf(res)), textOf(res).slice(0, 140));
    }

    const failed = results.filter((r) => !r.ok).length;
    console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
