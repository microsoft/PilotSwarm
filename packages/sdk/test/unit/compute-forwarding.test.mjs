/**
 * Forwarding MCP traffic to the servers that stay on the trusted side
 * (docs/proposals/compute-providers.md, "Skills and MCP servers on remote
 * sessions").
 *
 * What these hold it to: a host can reach only the servers this worker
 * offered that session, by ticket; the caller's own credentials travel
 * unchanged and the worker adds none of its own; the worker's statement
 * of who is calling is attached and cannot be forged from the host; and
 * a conversation is bounded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { ComputeChannel } from "../../dist/compute-channel.js";
import { ComputeControlLink, forwardHeaders, forwardUrl } from "../../dist/compute-control.js";

const CALLER = {
    sessionId: "session-1",
    rootSessionId: "session-root",
    ownerProvider: "test",
    ownerSubject: "subject-9",
    ownerEmail: "someone@example.invalid",
    computeTarget: "shared/pool",
};

function pair(t) {
    return new Promise((resolve) => {
        const server = net.createServer((incoming) => {
            incoming.on("error", () => { /* the test closes these */ });
            resolve({ host: incoming, worker, server });
        });
        let worker;
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
            worker = net.connect({ host: "127.0.0.1", port: server.address().port });
            worker.on("error", () => { /* the test closes these */ });
        });
        t.after(() => {
            try { worker?.destroy(); } catch { /* already gone */ }
            server.close();
        });
    });
}

/** A worker link and a stand-in for the host component's side of the channel. */
async function link(t, options = {}) {
    const { worker, host } = await pair(t);
    const made = new ComputeControlLink(worker, options);
    const hostSide = new ComputeChannel(host, { side: "host" }).start();
    t.after(() => { made.close(); hostSide.close(); });
    return { link: made, hostSide };
}

function once(emitter, event) {
    return new Promise((resolve) => emitter.once(event, (...args) => resolve(args.length > 1 ? args : args[0])));
}

test("the worker reaches only a server it offered that session, by ticket", async (t) => {
    const { link: made, hostSide } = await link(t);
    const ticket = made.mintTicket({ sessionId: "session-1", server: "catalog", caller: CALLER, config: { command: process.execPath, args: ["-e", ""] } });
    assert.equal(made.ticketCount, 1);

    const invented = hostSide.open("mcp", { ticket: "a-ticket-nobody-minted" });
    const refused = await once(invented, "close");
    assert.match(String(refused), /no such forwarding ticket/);

    // The ticket a session held is gone when the session leaves the host.
    made.forgetSession("session-1");
    const stale = hostSide.open("mcp", { ticket });
    assert.match(String(await once(stale, "close")), /no such forwarding ticket/);
});

test("a session keeps one ticket per server, so a warm runtime keeps working", async (t) => {
    const { link: made } = await link(t);
    const first = made.mintTicket({ sessionId: "s", server: "catalog", caller: CALLER, config: { command: "a" } });
    const again = made.mintTicket({ sessionId: "s", server: "catalog", caller: CALLER, config: { command: "b" } });
    assert.equal(again, first);
    assert.notEqual(made.mintTicket({ sessionId: "s", server: "other", caller: CALLER, config: {} }), first);
    assert.notEqual(made.mintTicket({ sessionId: "t", server: "catalog", caller: CALLER, config: {} }), first);
});

test("a server that speaks over its own input and output is started here, and told who is calling", async (t) => {
    const { link: made, hostSide } = await link(t);
    // Answers with the environment it was given, then ends.
    const program = "let seen='';process.stdin.on('data',c=>{seen+=c;if(seen.includes('\\n')){"
        + "process.stdout.write(JSON.stringify({session:process.env.PILOTSWARM_CALLER_SESSION,"
        + "owner:process.env.PILOTSWARM_CALLER_OWNER_SUBJECT,remote:process.env.PILOTSWARM_CALLER_RUNS_REMOTELY,"
        + "configured:process.env.CATALOG_TOKEN,heard:seen.trim()}));process.exit(0);}})";
    const ticket = made.mintTicket({
        sessionId: "session-1", server: "catalog", caller: CALLER,
        config: { command: process.execPath, args: ["-e", program], env: { CATALOG_TOKEN: "worker-only-secret" } },
    });
    const stream = hostSide.open("mcp", { ticket });
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    const done = new Promise((resolve) => { stream.on("close", resolve); stream.on("end", resolve); });
    await stream.write(Buffer.from("a request\n"));
    await done;
    const said = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(said.heard, "a request");
    assert.equal(said.session, "session-1");
    assert.equal(said.owner, "subject-9");
    assert.equal(said.remote, "1");
    assert.equal(said.configured, "worker-only-secret", "the deployment's own configuration still applies here");
});

test("the headers of a forwarded call: configured first, the caller's own unchanged, the worker's statement last", () => {
    const headers = forwardHeaders(
        { Authorization: "Bearer deployment-standing-credential", "x-source": "deployment" },
        {
            authorization: "Bearer the-callers-own-token",
            host: "127.0.0.1:5001",
            "content-length": "12",
            "pilotswarm-caller-owner-subject": "someone-else",
            accept: "application/json",
        },
        CALLER);
    assert.equal(headers.authorization, "Bearer the-callers-own-token", "the caller's own token goes through unchanged");
    assert.equal(headers["x-source"], "deployment", "what the caller did not send, the configuration still provides");
    assert.equal(headers.host, undefined, "a header that belongs to one hop is not forwarded");
    assert.equal(headers["content-length"], undefined);
    assert.equal(headers["pilotswarm-caller-owner-subject"], "subject-9", "the statement cannot be forged from the host");
    assert.equal(headers["pilotswarm-caller-session"], "session-1");
    assert.equal(headers["pilotswarm-caller-runs-remotely"], "1");
    assert.equal(headers.accept, "application/json");
    // Nothing of the worker's own identity is added beyond the statement.
    const added = Object.keys(headers).filter((name) => name.startsWith("pilotswarm-"));
    assert.deepEqual(added.sort(), [
        "pilotswarm-caller-compute-target", "pilotswarm-caller-owner-email", "pilotswarm-caller-owner-provider",
        "pilotswarm-caller-owner-subject", "pilotswarm-caller-root-session", "pilotswarm-caller-runs-remotely",
        "pilotswarm-caller-session",
    ]);
});

test("what the runtime asked for is joined onto the address the deployment configured", () => {
    assert.equal(forwardUrl("https://x.invalid/mcp", ""), "https://x.invalid/mcp");
    assert.equal(forwardUrl("https://x.invalid/mcp", "/"), "https://x.invalid/mcp");
    assert.equal(forwardUrl("https://x.invalid/mcp", "/messages"), "https://x.invalid/mcp/messages");
    assert.equal(forwardUrl("https://x.invalid/mcp/", "/messages"), "https://x.invalid/mcp/messages");
    assert.equal(forwardUrl("https://x.invalid/mcp?v=1", "/messages"), "https://x.invalid/mcp/messages?v=1");
    assert.equal(forwardUrl("https://x.invalid/mcp", "/messages?id=2"), "https://x.invalid/mcp/messages?id=2");
});

test("a server reached over HTTP is called from the worker, with the caller's own credentials and no others", async (t) => {
    const seen = [];
    const server = http.createServer((request, response) => {
        seen.push({ method: request.method, url: request.url, headers: request.headers });
        response.writeHead(201, { "content-type": "application/json", "x-answered-by": "the server" });
        response.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/mcp`;

    const { link: made, hostSide } = await link(t);
    const ticket = made.mintTicket({
        sessionId: "session-1", server: "tools", caller: CALLER,
        config: { type: "http", url, headers: { "x-deployment": "configured" }, tools: ["*"] },
    });
    const stream = hostSide.open("mcp-http", {
        ticket, method: "POST", path: "/messages",
        headers: { authorization: "Bearer the-callers-own-token", "content-type": "application/json" },
    });
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    const ended = once(stream, "end");
    await stream.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 })));
    await stream.end();
    await ended;

    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/mcp/messages");
    assert.equal(seen[0].headers.authorization, "Bearer the-callers-own-token");
    assert.equal(seen[0].headers["x-deployment"], "configured");
    assert.equal(seen[0].headers["pilotswarm-caller-session"], "session-1");
    assert.equal(seen[0].headers["pilotswarm-caller-owner-subject"], "subject-9");

    const head = JSON.parse(chunks[0].toString());
    assert.equal(head.status, 201);
    assert.equal(head.headers["x-answered-by"], "the server");
    assert.equal(Buffer.concat(chunks.slice(1)).toString(), JSON.stringify({ ok: true }));
});

test("a conversation that runs past its ceiling is cut off rather than carried", async (t) => {
    const refusals = [];
    const { link: made, hostSide } = await link(t, { maxForwardBytes: 64, onRefusal: (refusal) => refusals.push(refusal) });
    const ticket = made.mintTicket({
        sessionId: "session-1", server: "chatty", caller: CALLER,
        config: { command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(5000))"] },
    });
    const stream = hostSide.open("mcp", { ticket });
    const closed = await once(stream, "close");
    assert.match(String(closed), /more than the 64 bytes/);
    assert.equal(refusals.length, 1);
});

test("a stream of a kind the worker does not forward is refused", async (t) => {
    const { link: made, hostSide } = await link(t);
    const ticket = made.mintTicket({ sessionId: "session-1", server: "catalog", caller: CALLER, config: {} });
    const stream = hostSide.open("something-else", { ticket });
    assert.match(String(await once(stream, "close")), /does not forward streams of that kind/);
});
