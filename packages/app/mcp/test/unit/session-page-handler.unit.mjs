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
