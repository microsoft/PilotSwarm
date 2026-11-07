import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startStubServer } from "./e2e/stub-server.mjs";

test("closing the browser stub drains an active response and exposes its late failure", async () => {
    const stub = await startStubServer(0);
    let receive;
    const received = new Promise(resolve => { receive = resolve; });
    stub.server.removeAllListeners("request");
    stub.server.on("request", (_req, res) => receive(res));
    const response = new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${stub.port}/late`, res => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
            res.on("error", reject);
        });
        req.on("error", reject);
    });
    const res = await received;
    let closed = false;
    const close = new Promise(resolve => stub.server.close(() => { closed = true; resolve(); }));
    assert.equal(closed, false, "close must wait for the active response");
    res.writeHead(500);
    res.end("late fixture failure");
    assert.equal(await response, 500, "the late failure must not become an aborted request");
    await close;
    assert.equal(closed, true);
});
