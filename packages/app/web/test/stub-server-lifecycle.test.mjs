import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startStubServer } from "./e2e/stub-server.mjs";

test("closing the browser stub resolves promptly with a request still in flight", { timeout: 1000 }, async (t) => {
    const stub = await startStubServer(0);
    let request;
    t.after(async () => {
        request?.destroy();
        stub.server.closeAllConnections?.();
        if (stub.server.listening) await new Promise(resolve => stub.server.close(resolve));
    });
    let receive;
    const received = new Promise(resolve => { receive = resolve; });
    stub.server.removeAllListeners("request");
    stub.server.on("request", () => receive());
    const response = new Promise((resolve, reject) => {
        request = http.get(`http://127.0.0.1:${stub.port}/pending`, res => {
            res.resume();
            res.on("end", () => reject(new Error("The fixture must leave the response in flight")));
            res.on("error", reject);
        });
        request.on("error", error => error.code === "ECONNRESET" ? resolve(error.code) : reject(error));
    });
    await received;
    await new Promise(resolve => stub.server.close(resolve));
    assert.equal(await response, "ECONNRESET", "teardown must close the still-active connection");
});
