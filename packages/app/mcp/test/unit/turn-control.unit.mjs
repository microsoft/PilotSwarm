#!/usr/bin/env node
// Unit test — session turn control tools (Stop and Steer), against recording
// mocks (no DB, no network):
//   1. steer_session_turn: text and request id reach the management client
//      unchanged; a request id is generated when omitted; every answer maps.
//   2. stop_turn: request id forwarded (or generated); `stopped` follows the
//      outcome; too_late and timeout with control_seq are reported.
//   3. Both refuse an unknown session without calling the operation.
//
// Usage:  node packages/app/mcp/test/unit/turn-control.unit.mjs

import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../dist/src/server.js";

const results = [];
function record(name, ok, detail = "") {
    results.push({ name, ok });
    console.log(`${ok ? "✅" : "❌"} ${name.padEnd(72)} ${ok ? "PASS" : "FAIL"}${detail ? ` (${detail})` : ""}`);
}

function makeCtx(calls, { steer, stop, session = { sessionId: "s" } } = {}) {
    return {
        client: {},
        mgmt: {
            getSession: async (...args) => { calls.push(["getSession", ...args]); return session; },
            steerSessionTurn: async (...args) => { calls.push(["steerSessionTurn", ...args]); return steer; },
            stopSessionTurn: async (...args) => { calls.push(["stopSessionTurn", ...args]); return stop; },
        },
        facts: { async readFacts() { return { count: 0, facts: [] }; } },
        enhancedFacts: null,
        graph: null,
        api: null,
        admin: false,
        webMode: false,
        models: null,
        skills: [],
        registeredAgents: [],
        systemAgentIds: new Set(),
        async refreshSystemAgentIds() {},
    };
}

async function call(ctx, name, args) {
    const server = createMcpServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "turn-control-test", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
        const res = await client.callTool({ name, arguments: args });
        let body;
        try { body = JSON.parse(res.content[0].text); } catch { body = res.content?.[0]?.text; }
        return { res, body };
    } finally {
        await client.close();
    }
}

const op = (calls, name) => calls.filter(([n]) => n === name);

async function main() {
    const UUID = randomUUID();

    // ── 1. steer_session_turn ──────────────────────────────────────────
    {
        const calls = [];
        const { res, body } = await call(makeCtx(calls, { steer: { outcome: "accepted", steerId: 41, turn: 3 } }),
            "steer_session_turn", { session_id: UUID, text: "use metric units", request_id: "req-1" });
        const [steerCall] = op(calls, "steerSessionTurn");
        record("steer accepted → text and request id unchanged, no caller from MCP",
            !res.isError && steerCall?.[1] === UUID
            && JSON.stringify(steerCall?.[2]) === JSON.stringify({ text: "use metric units", requestId: "req-1" }));
        record("steer accepted → accepted, steer_id, turn, request_id",
            body.accepted === true && body.outcome === "accepted" && body.steer_id === 41 && body.turn === 3
            && body.request_id === "req-1" && !("repeat" in body) && !("hint" in body), JSON.stringify(body));
    }
    {
        const calls = [];
        const { body } = await call(makeCtx(calls, { steer: { outcome: "accepted", steerId: 41, turn: 3, repeat: true } }),
            "steer_session_turn", { session_id: UUID, text: "again" });
        const generated = op(calls, "steerSessionTurn")[0]?.[2]?.requestId;
        record("steer without request_id → one is generated and returned",
            typeof generated === "string" && generated.length > 0 && body.request_id === generated);
        record("steer repeat → repeat: true", body.repeat === true);
    }
    for (const refusal of ["no_turn", "legacy_turn"]) {
        const { res, body } = await call(makeCtx([], { steer: { outcome: refusal } }),
            "steer_session_turn", { session_id: UUID, text: "x", request_id: `r-${refusal}` });
        record(`steer ${refusal} → not an error, accepted false, send_message hint`,
            !res.isError && body.accepted === false && body.outcome === refusal && /send_message/.test(body.hint ?? ""));
    }
    for (const refusal of ["not_found", "too_many", "request_id_reused", "steering_disabled"]) {
        const { res, body } = await call(makeCtx([], { steer: { outcome: refusal } }),
            "steer_session_turn", { session_id: UUID, text: "x", request_id: `r-${refusal}` });
        record(`steer ${refusal} → accepted false, no fallback hint`,
            !res.isError && body.accepted === false && body.outcome === refusal && !("hint" in body));
    }
    {
        const { res } = await call(makeCtx([], { steer: { outcome: "accepted", steerId: 1, turn: 0 } }),
            "steer_session_turn", { session_id: UUID, text: "" });
        record("steer with empty text → rejected by the schema", res.isError === true);
    }
    {
        const calls = [];
        const { res } = await call(makeCtx(calls, { session: null }), "steer_session_turn", { session_id: UUID, text: "x" });
        record("steer on an unknown session → error, operation not called",
            res.isError === true && op(calls, "steerSessionTurn").length === 0);
    }

    // ── 2. stop_turn ───────────────────────────────────────────────────
    {
        const calls = [];
        const { res, body } = await call(makeCtx(calls, { stop: { outcome: "stopped", turnIndex: 3, controlSeq: 50 } }),
            "stop_turn", { session_id: UUID, reason: "enough", timeout_ms: 5000, request_id: "stop-1" });
        const [stopCall] = op(calls, "stopSessionTurn");
        record("stop → reason, timeout and request id forwarded",
            !res.isError && JSON.stringify(stopCall?.[2]) === JSON.stringify({ reason: "enough", timeoutMs: 5000, requestId: "stop-1" }));
        record("stop stopped → stopped true with control seq",
            body.stopped === true && body.outcome === "stopped" && body.controlSeq === 50 && body.request_id === "stop-1");
    }
    {
        const calls = [];
        const { body } = await call(makeCtx(calls, { stop: { outcome: "too_late", turnIndex: 3, controlSeq: 51 } }),
            "stop_turn", { session_id: UUID });
        const generated = op(calls, "stopSessionTurn")[0]?.[2]?.requestId;
        record("stop too_late → reported, stopped false", body.outcome === "too_late" && body.stopped === false);
        record("stop without request_id → one is generated and returned",
            typeof generated === "string" && generated.length > 0 && body.request_id === generated);
    }
    {
        const { body } = await call(makeCtx([], { stop: { outcome: "timeout", turnIndex: 3, controlSeq: 52, detail: "pending" } }),
            "stop_turn", { session_id: UUID });
        record("stop timeout → control seq kept, stopped false", body.outcome === "timeout" && body.controlSeq === 52 && body.stopped === false);
    }
    {
        const { body } = await call(makeCtx([], { stop: { outcome: "no_active_turn", detail: "no turn is running" } }),
            "stop_turn", { session_id: UUID });
        record("stop no_active_turn → stopped false", body.outcome === "no_active_turn" && body.stopped === false);
    }
    {
        const { body } = await call(makeCtx([], { stop: { outcome: "stop_forced", turnIndex: 2 } }), "stop_turn", { session_id: UUID });
        record("stop stop_forced (legacy turn) → stopped true", body.outcome === "stop_forced" && body.stopped === true);
    }
    for (const timeout_ms of [0, 300_000]) {
        const calls = [];
        const { res } = await call(makeCtx(calls, { stop: { outcome: "timeout", turnIndex: 1, controlSeq: 2 } }), "stop_turn", { session_id: UUID, timeout_ms });
        record(`stop timeout_ms ${timeout_ms} → accepted and forwarded`,
            !res.isError && op(calls, "stopSessionTurn")[0]?.[2]?.timeoutMs === timeout_ms);
    }
    for (const timeout_ms of [-1, 300_001, 1.5]) {
        const calls = [];
        const { res } = await call(makeCtx(calls, { stop: { outcome: "stopped" } }), "stop_turn", { session_id: UUID, timeout_ms });
        record(`stop timeout_ms ${timeout_ms} → rejected by the schema`, res.isError === true && op(calls, "stopSessionTurn").length === 0);
    }
    {
        const calls = [];
        const { res } = await call(makeCtx(calls, { session: null }), "stop_turn", { session_id: UUID });
        record("stop on an unknown session → error, operation not called",
            res.isError === true && op(calls, "stopSessionTurn").length === 0);
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
});
