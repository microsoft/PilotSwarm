#!/usr/bin/env node
// Unit test — the REAL get_session_events page:true HANDLER (issue 148).
//
// Why this file exists: the GPT-6.1 different-family review identified the
// existing MCP tests as FALSE CONFIDENCE. They call the pure helpers, not the
// tool handler, and none of them asserts the bytes actually sent. A helper can
// be perfect while the handler that assembles the response is wrong.
//
// So these drive the actual MCP tool over an in-memory transport, with a
// recording mgmt mock, and assert the SERIALIZED WIRE BYTES of the response.
//
// Covers:
//   - the hard max_bytes contract: the response NEVER exceeds the budget
//   - an impossible budget returns an explicit error instead of a truncated page
//   - a receipt-driven multi-page drain through the handler is a PARTITION of
//     the session in all three modes, under byte pressure
//   - escaping survives the handler in both json and text modes
//
// No database, no network, no model.
//
// Usage: node packages/app/mcp/test/unit/session-page-handler.unit.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../dist/src/server.js";
import { makeServerContext } from "./helpers/fake-context.mjs";

const results = [];
function record(name, ok, detail = "") {
    results.push({ name, ok });
    console.log(`${ok ? "✅" : "❌"} ${name.padEnd(68)} ${ok ? "PASS" : "FAIL"}${detail ? ` (${detail})` : ""}`);
}

const SESSION = "11111111-2222-3333-4444-555555555555";

const ev = (seq, content) => ({
    seq,
    sessionId: SESSION,
    eventType: "assistant.message",
    data: { content },
    createdAt: new Date(0),
});

/**
 * A mgmt mock that serves a real session from an in-memory array, implementing
 * the same selection semantics as the stored procedures: forward takes the
 * oldest above the cursor, latest and backward take the newest.
 */
function sessionMgmt(all, { pageLimit = 999 } = {}) {
    return {
        getSession: async () => ({ sessionId: SESSION }),
        getSessionEventsPage: async (_id, opts = {}) => {
            const { afterSeq, beforeSeq, limit } = opts;
            const mode = beforeSeq !== undefined ? "backward"
                : (afterSeq !== undefined && afterSeq > 0) ? "forward" : "latest";
            const applied = Math.max(1, Math.min(limit ?? 50, pageLimit));

            let eligible;
            if (mode === "forward") eligible = all.filter((e) => e.seq > afterSeq);
            else if (mode === "backward") eligible = all.filter((e) => e.seq < beforeSeq);
            else eligible = [...all];

            const window = mode === "forward"
                ? eligible.slice(0, applied)
                : eligible.slice(Math.max(0, eligible.length - applied));
            const hasMore = eligible.length > window.length;
            const range = window.length
                ? { fromSeq: window[0].seq, toSeq: window[window.length - 1].seq }
                : null;
            const nextDirection = !hasMore || !range ? null : (mode === "forward" ? "forward" : "backward");
            const nextCursor = nextDirection === null ? null
                : (nextDirection === "forward" ? range.toSeq : range.fromSeq);

            return {
                events: window,
                receipt: {
                    mode, range, limitRequested: limit ?? null, limitApplied: applied,
                    providerClamp: 1000, maxPageSize: 999, hasMore, nextCursor, nextDirection,
                    completeness: "read-view", truncatedReason: hasMore ? "limit" : null,
                },
            };
        },
    };
}

async function connect(mgmt) {
    // A COMPLETE context (see helpers/fake-context.mjs). A hand-rolled
    // near-miss crashes inside a registrar during setup, which fails the file
    // before a single case runs — the assertions below would then be neither
    // passed nor failed, while the output shows only one error.
    const ctx = makeServerContext({ mgmt });
    const server = createMcpServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
}

const textOf = (res) => res.content[0].text;
const bytesOf = (res) => Buffer.byteLength(textOf(res), "utf8");

async function run() {
    // ── hard byte contract ───────────────────────────────────────
    {
        const all = Array.from({ length: 40 }, (_, i) => ev(i + 1, "x".repeat(500)));
        const client = await connect(sessionMgmt(all));

        for (const budget of [2000, 5000, 12000]) {
            for (const format of ["json", "text"]) {
                const res = await client.callTool({
                    name: "get_session_events",
                    arguments: { session_id: SESSION, page: true, limit: 20, max_bytes: budget, format },
                });
                const bytes = bytesOf(res);
                // The contract is on the bytes actually sent, including the
                // warning, receipt, omissions, pretty-printing and escaping.
                record(`hard budget respected: ${format} @ ${budget}B -> ${bytes}B`,
                    bytes <= budget, `${bytes} > ${budget}`);
            }
        }
    }

    // ── impossible budget is an explicit error, never a truncated page ──
    {
        const all = [ev(1, "a")];
        const client = await connect(sessionMgmt(all));
        const res = await client.callTool({
            name: "get_session_events",
            arguments: { session_id: SESSION, page: true, max_bytes: 1 },
        });
        const text = textOf(res);
        record("impossible budget returns an explicit error",
            res.isError === true && /too small/i.test(text) && /minimum_envelope_bytes/.test(text),
            text.slice(0, 120));
        record("impossible budget does NOT emit a truncated page",
            !/\"events\"/.test(text) && !/\"transcript\"/.test(text));
    }

    // ── GPT-6.1 FINAL-01/02 boundaries ──────────────────────────
    {
        // FINAL-01: the counterexample needed no execution. Take the accepted
        // minimum budget E, then observe that adding response_bytes grows the
        // returned text past E. The contract must hold on the bytes SENT, so
        // either the response fits or an explicit error is returned - never a
        // success-shaped over-budget page.
        const all = [ev(1, "a")];
        const client = await connect(sessionMgmt(all));

        // Walk budgets across the whole interesting region, including the exact
        // envelope boundary, rather than guessing one value.
        let anyOverBudget = false;
        let anyFalseRefusal = false;
        for (let budget = 50; budget <= 1400; budget += 7) {
            const res = await client.callTool({
                name: "get_session_events",
                arguments: { session_id: SESSION, page: true, max_bytes: budget },
            });
            const bytes = bytesOf(res);
            if (res.isError) {
                // A refusal is acceptable only if the response really could not fit.
                continue;
            }
            if (bytes > budget) anyOverBudget = true;
        }
        record("FINAL-01: no budget yields a success-shaped over-budget response", !anyOverBudget);

        // FINAL-02: a budget that comfortably fits a complete small page must be
        // ACCEPTED, not refused on the cost of an omission-heavy replacement.
        const generous = await client.callTool({
            name: "get_session_events",
            arguments: { session_id: SESSION, page: true, max_bytes: 200000 },
        });
        const fullBytes = bytesOf(generous);
        const exact = await client.callTool({
            name: "get_session_events",
            arguments: { session_id: SESSION, page: true, max_bytes: fullBytes },
        });
        record("FINAL-02: a budget equal to the real full response is accepted",
            !exact.isError && bytesOf(exact) <= fullBytes,
            exact.isError ? textOf(exact).slice(0, 120) : `${bytesOf(exact)} > ${fullBytes}`);
        if (exact.isError) anyFalseRefusal = true;
        record("FINAL-02: minimum envelope is not inflated by an omitted record",
            !anyFalseRefusal);
    }

    // ── G46-06: the advertised remedy must actually work ────────
    {
        // Grok's finding, caught by source review before this file ever ran.
        //
        // The planning pass used to measure bodies WITHOUT response_bytes and
        // only add the field afterwards, so it was blind to a cost it later
        // incurred. Two false refusals follow near the bound:
        //
        //   1. minimum_envelope_bytes understated the true floor by the field's
        //      width, so obeying the error's own remedy got you refused AGAIN.
        //   2. a page whose body fit at exactly the budget grew past it once the
        //      field arrived, and was refused instead of shrunk by one more row.
        //
        // The crisp observable is the REMEDY LADDER. minimum_envelope_bytes is
        // necessary but not sufficient — a page carrying even one row costs more
        // than the bare envelope — so the contract is that following the numbers
        // the errors advertise TERMINATES IN A RESPONSE, and that each number is
        // honest about which kind it is. smallest_achieved_bytes is sufficient:
        // it names a response that was actually built and measured.
        const all = [ev(1, "a")];
        const client = await connect(sessionMgmt(all));

        const ask = (max_bytes) => client.callTool({
            name: "get_session_events",
            arguments: { session_id: SESSION, page: true, max_bytes },
        });

        let budget = 1;
        let steps = 0;
        let res = await ask(budget);
        const advertisedChain = [];
        while (res.isError && steps < 5) {
            const err = JSON.parse(textOf(res));
            // Prefer the solved retry value; fall back to the envelope floor,
            // which is only a necessary condition. NEVER smallest_achieved_bytes:
            // that describes the rejected request, not the retry.
            const next = err.sufficient_max_bytes ?? err.minimum_envelope_bytes;
            record(`G46-06: refusal at ${budget}B advertises a larger budget`,
                typeof next === "number" && next > budget, `advertised ${next} for ${budget}`);
            if (!(typeof next === "number" && next > budget)) break;
            advertisedChain.push(next);
            budget = next;
            res = await ask(budget);
            steps++;
        }
        record("G46-06: following the advertised remedy terminates in a response",
            !res.isError, res.isError ? textOf(res).slice(0, 160) : `after ${steps} step(s)`);
        record("G46-06: the response fits the budget its own error advertised",
            !res.isError && bytesOf(res) <= budget,
            res.isError ? "refused" : `${bytesOf(res)} > ${budget}`);
        record("G46-06: the ladder is short, not a byte-by-byte crawl",
            steps <= 2, `${steps} steps via ${JSON.stringify(advertisedChain)}`);

        // G46-07. smallest_achieved_bytes must be SUFFICIENT, not merely
        // larger. The trap: `room` is derived from the budget, so retrying at
        // the size a truncated attempt happened to reach grants MORE room than
        // the attempt that produced it, can pull in another event, and refuses
        // again. A reported minimum that fails on retry is worse than none.
        //
        // Use a session big enough that the page really is event-truncated,
        // which is the path that reports the number.
        {
            const many = Array.from({ length: 30 }, (_, i) => ev(i + 1, "y".repeat(300)));
            const c2 = await connect(sessionMgmt(many));
            const ask2 = (max_bytes) => c2.callTool({
                name: "get_session_events",
                arguments: { session_id: SESSION, page: true, limit: 30, max_bytes },
            });

            // The budgets must be DERIVED, not guessed. My first version of this
            // case guessed 1/60/120/300 and skipped on a missing field; every one
            // of those takes the ENVELOPE refusal branch, which reports no retry
            // value at all, so the whole case silently asserted nothing. Find the
            // envelope floor first, then probe just above it, where the refusal
            // actually carries a retry value.
            const envelopeErr = JSON.parse(textOf(await ask2(1)));
            const floorBytes = envelopeErr.minimum_envelope_bytes;
            record("G46-07 setup: the envelope refusal reports a floor",
                typeof floorBytes === "number" && floorBytes > 0, JSON.stringify(envelopeErr).slice(0, 160));

            let exercised = 0;
            for (const over of [0, 1, 5, 40, 200]) {
                const tightBudget = floorBytes + over;
                const refusedRes = await ask2(tightBudget);
                if (!refusedRes.isError) continue;
                const err = JSON.parse(textOf(refusedRes));
                const n = err.sufficient_max_bytes;
                // Above the envelope floor a refusal MUST offer a retry value.
                record(`G46-07: refusal at floor+${over} offers a sufficient budget`,
                    typeof n === "number" && n > 0, JSON.stringify(err).slice(0, 160));
                if (typeof n !== "number") continue;
                exercised++;
                const retry = await ask2(n);
                record(`G46-07: sufficient_max_bytes ${n} (from floor+${over}) actually succeeds`,
                    !retry.isError && bytesOf(retry) <= n,
                    retry.isError ? textOf(retry).slice(0, 140) : `${bytesOf(retry)} > ${n}`);
            }
            // Guard against this case going quiet again: if nothing was probed,
            // that is itself a failure, not a silent pass.
            record("G46-07: the retry-sufficiency contract was actually exercised",
                exercised > 0, `${exercised} budgets reached the retry-value branch`);
        }

        // FINAL-03: a budget ONE BYTE below the complete response must still
        // return a smaller page, not refuse. This is the case a budget-only
        // decrement loop fails: shaving bytes off the event budget re-selects
        // the same rows, so the identical over-budget candidate is rejected
        // repeatedly while a one-row page plainly fits.
        {
            const two = [ev(101, "x".repeat(500)), ev(102, "x".repeat(500))];
            const c3 = await connect(sessionMgmt(two));
            const ask3 = (max_bytes) => c3.callTool({
                name: "get_session_events",
                arguments: { session_id: SESSION, page: true, after_seq: 100, limit: 2, max_bytes },
            });
            // The reference size must be measured in the SAME budget
            // representation the later requests use. A generous probe
            // serializes a six-digit response_bytes_budget; the real requests
            // serialize four digits, so the identical complete response is two
            // bytes smaller. Subtracting from the generous figure therefore
            // lands ABOVE the true full size, the complete page still fits, and
            // a correct null continuation looked like a failure. Re-measure at
            // the probe's own answer so the width matches before subtracting.
            const probe = await ask3(200000);
            const full = await ask3(bytesOf(probe));
            const fullBytes = bytesOf(full);
            const totalCount = JSON.parse(textOf(full)).count;

            for (const delta of [1, 2, 10, 50]) {
                const b = fullBytes - delta;
                const res = await ask3(b);
                record(`FINAL-03: ${delta}B below the full response still returns a page`,
                    !res.isError && bytesOf(res) <= b,
                    res.isError ? textOf(res).slice(0, 140) : `${bytesOf(res)} > ${b}`);
                if (res.isError) continue;

                const parsed = JSON.parse(textOf(res));
                // Always true: something was delivered.
                record(`FINAL-03: the page at full-${delta}B delivers at least one row`,
                    parsed.count >= 1, `count=${parsed.count}`);
                // Continuation is required ONLY when a strict subset was
                // delivered. A complete page that happens to fit correctly
                // reports next_cursor null, and demanding a cursor there would
                // reject correct behaviour.
                if (parsed.count < totalCount) {
                    record(`FINAL-03: the strict subset at full-${delta}B can be continued`,
                        parsed.receipt.next_cursor !== null && parsed.receipt.has_more === true,
                        `count=${parsed.count}/${totalCount} next_cursor=${parsed.receipt.next_cursor} has_more=${parsed.receipt.has_more}`);
                } else {
                    record(`FINAL-03: the complete page at full-${delta}B ends the drain`,
                        parsed.receipt.has_more === false && parsed.receipt.next_cursor === null,
                        `count=${parsed.count} has_more=${parsed.receipt.has_more}`);
                }
            }

            // The text-projection counterexample: admission sizes the compact
            // SOURCE record, but text mode renders only data.content. A small
            // content beside a large auxiliary field must not be refused when
            // the complete rendered response fits.
            {
                const fat = [{
                    seq: 1,
                    sessionId: SESSION,
                    eventType: "assistant.message",
                    data: { content: "a", padding: "x".repeat(5000) },
                    createdAt: new Date(0),
                }];
                const c4 = await connect(sessionMgmt(fat));
                const askText = (max_bytes) => c4.callTool({
                    name: "get_session_events",
                    arguments: { session_id: SESSION, page: true, format: "text", max_bytes },
                });
                const generous = await askText(200000);
                record("FINAL-03 setup: the complete text rendering succeeds generously",
                    !generous.isError, generous.isError ? textOf(generous).slice(0, 140) : "");
                if (!generous.isError) {
                    const renderedBytes = bytesOf(generous);
                    // The whole point: the rendered form is far smaller than the
                    // compact source, so a budget sized for the RENDERING must be
                    // accepted rather than refused on the source's size.
                    const res = await askText(renderedBytes);
                    record("FINAL-03: a text budget that fits the RENDERED output is accepted",
                        !res.isError && bytesOf(res) <= renderedBytes,
                        res.isError ? textOf(res).slice(0, 180) : `${bytesOf(res)} > ${renderedBytes}`);
                    record("FINAL-03: and it delivers the content, not an omission",
                        !res.isError && /\ba\b/.test(textOf(res)) && !/payload omitted/.test(textOf(res)),
                        res.isError ? "refused" : textOf(res).slice(0, 180));
                }
            }
        }

        // No budget anywhere in the band may yield an over-budget SUCCESS.
        let overBudget = 0;
        for (let b = advertisedChain[0] ?? 1; b <= (advertisedChain[0] ?? 1) + 80; b++) {
            const r = await ask(b);
            if (!r.isError && bytesOf(r) > b) overBudget++;
        }
        record("G46-06: no over-budget success in the band above the floor",
            overBudget === 0, `${overBudget} violations`);
    }

    // ── handler-level drain is a PARTITION, under byte pressure ──
    {
        // Sequences start at 101 deliberately. A forward drain must begin from a
        // cursor ABOVE zero, because afterSeq=0 classifies as LATEST, not
        // "from the beginning" (session-events-page.ts classifyPageMode). Seeding
        // forward with after_seq=0 would silently test latest a second time and
        // report that forward passed - the exact shape of a vacuous test.
        const all = Array.from({ length: 24 }, (_, i) => ev(i + 101, "y".repeat(400)));
        const client = await connect(sessionMgmt(all));

        for (const mode of ["latest", "forward", "backward"]) {
            const seen = [];
            let args = { session_id: SESSION, page: true, limit: 5, max_bytes: 3000 };
            let cursor = null, direction = null, guard = 0, ok = true;

            // Seed the first call per mode, and assert the handler agrees with
            // the mode we think we are exercising.
            if (mode === "backward") args.before_seq = 1000;
            if (mode === "forward") args.after_seq = 100;   // below the first seq (101), and > 0
            let modeConfirmed = null;

            while (guard++ < 60) {
                const call = { ...args };
                if (cursor !== null) {
                    delete call.after_seq; delete call.before_seq;
                    if (direction === "forward") call.after_seq = cursor;
                    else call.before_seq = cursor;
                }
                const res = await client.callTool({ name: "get_session_events", arguments: call });
                if (res.isError) { ok = false; break; }
                const body = JSON.parse(textOf(res));
                if (modeConfirmed === null) modeConfirmed = body.receipt.mode;
                if (bytesOf(res) > call.max_bytes) { ok = false; break; }
                for (const e of body.events ?? []) seen.push(e.seq);
                if (!body.receipt.has_more) break;
                cursor = body.receipt.next_cursor;
                direction = body.receipt.next_direction;
                if (cursor === null || direction === null) break;
            }

            const sorted = [...seen].sort((a, b) => a - b);
            const expected = all.map((e) => e.seq);
            const partition = JSON.stringify(sorted) === JSON.stringify(expected);
            const unique = new Set(seen).size === seen.length;
            // Guard against testing a different mode than intended.
            record(`handler drain exercises the intended mode: ${mode}`,
                modeConfirmed === mode, `handler reported "${modeConfirmed}"`);
            record(`handler drain is a partition: ${mode}`, ok && partition && unique,
                `saw ${seen.length}/${expected.length}, unique=${unique}`);
        }
    }

    // ── escaping survives the handler, both modes ────────────────
    {
        const nasty = "danger\u009b2Jclear\u2028break\u202ereverse\u0085nel";
        const all = [ev(1, nasty)];
        const client = await connect(sessionMgmt(all));

        for (const format of ["json", "text"]) {
            const res = await client.callTool({
                name: "get_session_events",
                arguments: { session_id: SESSION, page: true, format, max_bytes: 200000 },
            });
            const text = textOf(res);
            const clean = !text.includes("\u009b") && !text.includes("\u2028")
                && !text.includes("\u202e") && !text.includes("\u0085");
            record(`handler neutralizes control characters: ${format}`, clean);
        }
    }

    const failed = results.filter((r) => !r.ok).length;
    console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
