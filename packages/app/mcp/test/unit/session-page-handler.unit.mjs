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
//
// STATUS: authored, NOT YET EXECUTED.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../dist/src/server.js";

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
    const ctx = {
        mgmt,
        client: null, facts: null, enhancedFacts: null, graph: null,
        admin: false, authz: { ownershipEnforced: false, defaultVisibility: "private", systemVisibility: "read" },
        registeredAgents: [], systemAgentIds: new Set(), web: null,
    };
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

    // ── handler-level drain is a PARTITION, under byte pressure ──
    {
        const all = Array.from({ length: 24 }, (_, i) => ev(i + 1, "y".repeat(400)));
        const client = await connect(sessionMgmt(all));

        for (const mode of ["latest", "forward", "backward"]) {
            const seen = [];
            let args = { session_id: SESSION, page: true, limit: 5, max_bytes: 3000 };
            if (mode === "forward") args.after_seq = 0 + 1 - 1 || undefined;
            let cursor = null, direction = null, guard = 0, ok = true;

            // Seed the first call per mode.
            if (mode === "backward") args.before_seq = 1000;
            if (mode === "forward") args.after_seq = 0;

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
