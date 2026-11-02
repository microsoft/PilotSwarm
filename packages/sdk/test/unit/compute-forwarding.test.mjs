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
import zlib from "node:zlib";
import net from "node:net";
import { ComputeChannel } from "../../dist/compute-channel.js";
import { ComputeControlLink, forwardDestination, forwardHeaders, forwardUrl } from "../../dist/compute-control.js";

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

test("the headers of a forwarded call: the caller's own, what the deployment set winning, the worker's statement last", () => {
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
    // What the deployment configured for this server is the deployment's
    // decision. A caller that sends the same header name does not replace
    // it: the configuration is how the server is reached today, for a
    // session on the worker as much as for one on a host.
    assert.equal(headers.authorization, "Bearer deployment-standing-credential",
        "a header the deployment set for this server is not a caller's to replace");
    assert.equal(headers["x-source"], "deployment", "what the caller did not send, the configuration still provides");
    assert.equal(headers.accept, "application/json", "and everything else the caller sent goes through unchanged");
    assert.equal(headers.host, undefined, "a header that belongs to one hop is not forwarded");
    assert.equal(headers["content-length"], undefined);
    assert.equal(headers["pilotswarm-caller-owner-subject"], "subject-9", "the statement cannot be forged from the host");
    assert.equal(headers["pilotswarm-caller-session"], "session-1");
    assert.equal(headers["pilotswarm-caller-runs-remotely"], "1");
    // Where the deployment configured nothing, the caller's own travels
    // exactly as it arrived and the worker adds none of its own.
    const callerOnly = forwardHeaders(undefined, { authorization: "Bearer the-callers-own-token" }, CALLER);
    assert.equal(callerOnly.authorization, "Bearer the-callers-own-token");
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
    // Both queries survive: what the deployment configured, and what the
    // caller sent beside it.
    assert.equal(forwardUrl("https://x.invalid/mcp?v=1", "/messages?id=2"), "https://x.invalid/mcp/messages?id=2&v=1");
});

test("the configured address pins where a forwarded call may go", () => {
    // The host decides this path. Every one of these is a way to make a
    // path mean somewhere else, and each must be refused rather than
    // joined: the worker sends the deployment's own configured headers to
    // whatever comes out of it.
    const hostile = [
        [".attacker.invalid/tools", "another host by suffix"],
        ["@attacker.invalid/x", "another host through user info"],
        ["//attacker.invalid/x", "another host through an authority"],
        ["https://attacker.invalid/x", "a whole address of its own"],
        ["/../admin", "a step out of the configured path"],
        ["/sub/../../admin", "a step out after going in"],
        ["/%2e%2e/admin", "an encoded step out"],
        ["/%2E%2E/admin", "an encoded step out, upper case"],
        ["/%2fadmin", "an encoded separator"],
        ["/x%5Cadmin", "an encoded backslash"],
        ["/x\\admin", "a backslash"],
        ["/messages#somewhere", "a fragment"],
        ["/messages\u0000", "a null byte"],
        ["messages", "a path that does not begin with a separator"],
    ];
    for (const [rest, why] of hostile) {
        const answer = forwardDestination("https://mcp.invalid/mcp", rest);
        assert.equal(answer.ok, false, `${why} (${rest}) must be refused`);
        assert.match(String(answer.reason), /\S/);
        assert.throws(() => forwardUrl("https://mcp.invalid/mcp", rest));
    }
    // And a configured address that is not one the worker will call at all.
    for (const configured of ["", "not-an-address", "file:///etc/passwd", "ws://x.invalid/", "https://someone:something@x.invalid/mcp"]) {
        assert.equal(forwardDestination(configured, "/messages").ok, false, `${configured} must be refused`);
    }
    // A configured address whose path is the root still pins the origin.
    assert.equal(forwardDestination("https://mcp.invalid", "//attacker.invalid/x").ok, false);
    assert.equal(forwardUrl("https://mcp.invalid", "/messages"), "https://mcp.invalid/messages");
});

test("a host that asks for a path outside the configured one reaches nothing", async (t) => {
    let reached = 0;
    const server = http.createServer((request, response) => { reached++; response.writeHead(200).end("{}"); });
    await new Promise((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
    t.after(() => server.close());

    const refusals = [];
    const { link: made, hostSide } = await link(t, { onRefusal: (refusal) => refusals.push(refusal) });
    const ticket = made.mintTicket({
        sessionId: "session-1", server: "tools", caller: CALLER,
        config: { type: "http", url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { "x-configured": "a deployment value" } },
    });
    const stream = hostSide.open("mcp-http", { ticket, method: "POST", path: "/../admin", headers: {} });
    assert.match(String(await once(stream, "close")), /outside the path|step through/);
    assert.equal(reached, 0, "and nothing was called at all, so no configured header left the worker");
    assert.equal(refusals.length, 1);
});

test("a method the worker does not forward is refused before any call is made", async (t) => {
    const { link: made, hostSide } = await link(t);
    const ticket = made.mintTicket({
        sessionId: "session-1", server: "tools", caller: CALLER,
        config: { type: "http", url: "http://127.0.0.1:1/mcp" },
    });
    const stream = hostSide.open("mcp-http", { ticket, method: "TRACE", path: "/", headers: {} });
    assert.match(String(await once(stream, "close")), /does not forward a "TRACE" call/);
});

test("a ticket is revoked when the session is no longer authorized for that server", async (t) => {
    const { link: made, hostSide } = await link(t);
    const ticket = made.mintTicket({ sessionId: "s", server: "catalog", caller: CALLER, config: { command: "a" } });
    const other = made.mintTicket({ sessionId: "s", server: "kept", caller: CALLER, config: { command: "a" } });
    assert.equal(made.ticketCount, 2);

    // The whole set this session may reach, as it now stands.
    made.reconcileSession("s", ["kept"]);
    assert.equal(made.ticketCount, 1);
    const gone = hostSide.open("mcp", { ticket });
    assert.match(String(await once(gone, "close")), /no such forwarding ticket/);
    // The one still authorized is untouched, and keeps its ticket, so a
    // warm runtime goes on working.
    assert.equal(made.mintTicket({ sessionId: "s", server: "kept", caller: CALLER, config: { command: "b" } }), other);

    // An empty set revokes everything the session held.
    made.reconcileSession("s", []);
    assert.equal(made.ticketCount, 0);
});

test("revoking a grant ends what was open under it", async (t) => {
    const { link: made, hostSide } = await link(t);
    const ticket = made.mintTicket({
        sessionId: "s", server: "long-lived", caller: CALLER,
        // Says nothing and never exits on its own.
        config: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] },
    });
    const stream = hostSide.open("mcp", { ticket });
    await stream.write(Buffer.from("x"));
    while (made.activeForwards === 0) await new Promise((resolve) => setImmediate(resolve));

    const closed = once(stream, "close");
    made.reconcileSession("s", []);
    assert.match(String(await closed), /no longer reaches that server/);
    assert.equal(made.activeForwards, 0, "and the server it started is not left running");
});

test("a host that gives up on a call does not leave the worker making it", async (t) => {
    let reached = 0;
    const server = http.createServer((request, response) => {
        reached++;
        request.resume();
        response.writeHead(200).end("{}");
    });
    await new Promise((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
    t.after(() => server.close());

    const refusals = [];
    const { link: made, hostSide } = await link(t, { onRefusal: (refusal) => refusals.push(refusal.reason) });
    const ticket = made.mintTicket({
        sessionId: "s", server: "tools", caller: CALLER,
        config: { type: "http", url: `http://127.0.0.1:${server.address().port}/mcp` },
    });
    // Opened, a partial body sent, then closed without ever ending.
    const stream = hostSide.open("mcp-http", { ticket, method: "POST", path: "/", headers: {} });
    await stream.write(Buffer.from("{\"partial\":"));
    stream.close("the host changed its mind");
    // Wait for the call to have been given up on, not merely for the
    // bookkeeping to be tidy: without this the check below can run
    // before a call that was started has reached anything.
    const deadline = Date.now() + 10_000;
    while (!refusals.some((reason) => /gave up on this call/.test(reason))) {
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(refusals.some((reason) => /gave up on this call/.test(reason)),
        "a stream that closes before it ends is the host giving up, never a finished body");
    assert.equal(made.activeForwards, 0);
    assert.equal(reached, 0, "so nothing was called at all");
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

test("a compressed answer is forwarded as the bytes the host actually receives", async (t) => {
    const body = JSON.stringify({ jsonrpc: "2.0", result: { tools: [] }, id: 1 });
    const server = http.createServer((request, response) => {
        // The worker's own call decodes this before the broker sees it.
        // Passing the original encoding on with the decoded bytes tells
        // the runtime to decode plain JSON a second time.
        const packed = zlib.gzipSync(Buffer.from(body, "utf8"));
        response.writeHead(200, {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "content-length": String(packed.length),
            "x-answered-by": "the server",
        });
        response.end(packed);
    });
    await new Promise((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
    t.after(() => server.close());

    const { link: made, hostSide } = await link(t);
    const ticket = made.mintTicket({
        sessionId: "s", server: "tools", caller: CALLER,
        config: { type: "http", url: `http://127.0.0.1:${server.address().port}/mcp` },
    });
    const stream = hostSide.open("mcp-http", { ticket, method: "GET", path: "/", headers: {} });
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    const ended = once(stream, "end");
    await ended;

    const head = JSON.parse(chunks[0].toString());
    assert.equal(head.status, 200);
    assert.equal(head.headers["x-answered-by"], "the server", "what the server said about itself still travels");
    const encoding = Object.keys(head.headers).find((name) => name.toLowerCase() === "content-encoding");
    assert.equal(encoding, undefined, "but not a claim about bytes the worker no longer has");
    const length = Object.keys(head.headers).find((name) => name.toLowerCase() === "content-length");
    assert.equal(length, undefined);
    assert.equal(Buffer.concat(chunks.slice(1)).toString(), body, "and the body is the decoded one");
});
