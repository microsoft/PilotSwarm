import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { executeSessionsCommand, parseSessionsArgs } from "../src/sessions-cli.js";

function harness() {
    const calls = [];
    const accepted = { ok: true, duplicate: false, receipt: { requestId: "server-request", clientRequestId: "caller-id", disposition: "accepted" } };
    const track = (name, result) => async (...args) => { calls.push([name, ...args]); return result; };
    return { calls, accepted, client: {
        getSessionSteeringState: track("state", { steerable: true, expectedTarget: "target-a" }),
        steerSessionTurn: track("steer", accepted),
        getSteeringRequest: track("receipt", { requestId: "server-request", disposition: "delivery_unconfirmed" }),
        listSteeringRequests: track("list", { items: [], nextCursor: null }),
        withdrawSteeringRequest: track("withdraw", { outcome: "not_withdrawable", receipt: null }),
        sendMessage: async () => { throw new Error("ordinary Send is not a steering fallback"); },
        stopSessionTurn: async () => { throw new Error("Stop is not a steering fallback"); },
        sendAnswer: async () => { throw new Error("steering cannot answer a question"); },
    } };
}

const args = (source) => ["steer", "session-a", ...source, "--client-request-id", "caller-id", "--expected-target", "observed-target"];

test("ST-A01: CLI forwards exact captured identity and target without discovery or delivery wait", async () => {
    const h = harness();
    const result = await executeSessionsCommand(h.client, parseSessionsArgs(args(["--text", "line one\nline two"])));
    assert.deepEqual(result, h.accepted);
    assert.deepEqual(h.calls, [["steer", "session-a", {
        text: "line one\nline two", clientRequestId: "caller-id", expectedTarget: "observed-target",
    }]]);
});

test("ST-A01: CLI file and stdin sources stay multiline text with the same request identity", async () => {
    for (const source of ["file", "stdin"]) {
        const h = harness();
        const options = source === "file" ? { loadText: async (file, encoding) => {
            assert.equal(file, "guidance.txt");
            assert.equal(encoding, "utf8");
            return "  \u00e9\nline two  ";
        } } : { stdin: Readable.from(["  \u00e9\n", "line two  "]) };
        await executeSessionsCommand(h.client, parseSessionsArgs(args(source === "file"
            ? ["--text-file", "guidance.txt"] : ["--stdin"])), options);
        assert.equal(h.calls[0][2].text, "  \u00e9\nline two  ");
        assert.equal(h.calls[0][2].clientRequestId, "caller-id");
        assert.equal(h.calls[0][2].expectedTarget, "observed-target");
    }
});

test("ST-A01: missing or conflicting text sources never invoke management", async () => {
    for (const source of [[], ["--text", "one", "--stdin"], ["--text", "one", "--text-file", "two"], ["--text", " \n "]]) {
        const h = harness();
        await assert.rejects(executeSessionsCommand(h.client, parseSessionsArgs(args(source))));
        assert.equal(h.calls.length, 0);
    }
});

test("ST-U02/ST-A01: the CLI checks normalized UTF-8 bytes, not characters", async () => {
    const h = harness();
    await executeSessionsCommand(h.client, parseSessionsArgs(args(["--text", `  ${"\u00e9".repeat(4096)}  `])));
    assert.equal(h.calls.length, 1);
    await assert.rejects(executeSessionsCommand(h.client, parseSessionsArgs(args(["--text", "\u00e9".repeat(4096) + "x"]))), /8 KiB/);
    assert.equal(h.calls.length, 1);
});

test("ST-A02: typed refusal is preserved and cannot refresh a target or fall back", async () => {
    const h = harness();
    const refused = { ok: false, code: "stale_target" };
    h.client.steerSessionTurn = async (...input) => { h.calls.push(["steer", ...input]); return refused; };
    assert.deepEqual(await executeSessionsCommand(h.client, parseSessionsArgs(args(["--text", "keep text"]))), refused);
    assert.equal(h.calls.length, 1);
});

test("ST-A05: bounded CLI pages and server request IDs use the canonical methods", async () => {
    const h = harness();
    await executeSessionsCommand(h.client, parseSessionsArgs(["steering-status", "session-a", "server-request", "--attempt-cursor", "20"]));
    await executeSessionsCommand(h.client, parseSessionsArgs(["steering-list", "session-a", "--limit", "2", "--cursor", "cursor-a",
        "--disposition", "withdrawn", "--expected-target", "target-a"]));
    await executeSessionsCommand(h.client, parseSessionsArgs(["withdraw-steering", "session-a", "server-request"]));
    assert.deepEqual(h.calls, [
        ["receipt", "session-a", "server-request", { attemptCursor: "20" }],
        ["list", "session-a", { limit: 2, cursor: "cursor-a", dispositions: ["withdrawn"], expectedTarget: "target-a" }],
        ["withdraw", "session-a", "server-request"],
    ]);
});

test("ST-A01: invalid CLI flags, missing values and incompatible command options are refused", async () => {
    for (const argv of [["steer", "session-a", "--unknown"], ["steer", "session-a", "--text"],
        ["steer", "session-a", "--text", "one", "--text", "two"]]) {
        assert.throws(() => parseSessionsArgs(argv));
    }
    for (const argv of [["steering-state", "session-a", "--text", "not allowed"],
        ["steering-list", "session-a", "--limit", "201"], ["steering-list", "session-a", "--limit", "0"],
        ["steering-status", "session-a"], ["steer", "session-a", "--text", "missing identity"]]) {
        const h = harness();
        await assert.rejects(executeSessionsCommand(h.client, parseSessionsArgs(argv)));
        assert.equal(h.calls.length, 0);
    }
});
