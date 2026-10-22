import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createNativeToolWorkload } from "../helpers/native-tool-workload.mjs";

test("native workload is a loopback request held until explicit fixture completion", { timeout: 5_000 }, async t => {
    const workload = await createNativeToolWorkload();
    t.after(() => workload.close());
    const url = new URL(workload.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.match(url.pathname, /^\/pstc[a-f0-9]{32}$/);
    assert.equal(workload.command, `curl --fail --silent --show-error ${workload.url}`);
    assert.doesNotMatch(workload.command, /sleep|setTimeout|setInterval/);

    let completed = false;
    const request = fetch(workload.url).then(async response => {
        assert.equal(response.status, 200);
        const text = await response.text();
        completed = true;
        return text;
    });
    await workload.requested;
    assert.equal(workload.hasRequest(), true);
    assert.equal(completed, false);
    await workload.close();
    assert.equal(await request, "Test workload completed\n");
    assert.equal(workload.hasRequest(), false);
    await workload.close();
});

test("workloads have disjoint endpoints and completing one leaves the other pending", { timeout: 5_000 }, async t => {
    const first = await createNativeToolWorkload();
    const second = await createNativeToolWorkload();
    t.after(() => Promise.all([first.close(), second.close()]));
    assert.notEqual(first.url, second.url);
    const firstReply = fetch(first.url).then(response => response.text());
    const secondReply = fetch(second.url).then(response => response.text());
    await Promise.all([first.requested, second.requested]);
    await first.close();
    assert.equal(await firstReply, "Test workload completed\n");
    assert.equal(second.hasRequest(), true);
    await second.close();
    assert.equal(await secondReply, "Test workload completed\n");
});

test("an unrelated request cannot start the held native workload", { timeout: 5_000 }, async t => {
    const workload = await createNativeToolWorkload();
    t.after(() => workload.close());
    const response = await fetch(new URL("/other", workload.url));
    assert.equal(response.status, 404);
    await response.text();
    assert.equal(workload.hasRequest(), false);
});

test("native liveness matches only the unique workload marker and surfaces probe errors", async t => {
    const workload = await createNativeToolWorkload();
    t.after(() => workload.close());
    const marker = new URL(workload.url).pathname.slice(1);
    const probe = t.mock.method(childProcess, "execFileSync", (command, args) => {
        assert.equal(command, "pgrep");
        assert.deepEqual(args, ["-f", marker]);
        return "12345\n";
    });
    assert.equal(workload.alive(), true);
    probe.mock.mockImplementation(() => { throw Object.assign(new Error("no match"), { status: 1 }); });
    assert.equal(workload.alive(), false);
    probe.mock.mockImplementation(() => { throw Object.assign(new Error("pgrep unavailable"), { code: "ENOENT" }); });
    assert.throws(() => workload.alive(), /pgrep unavailable/);
    probe.mock.mockImplementation(() => { throw Object.assign(new Error("probe failed"), { status: 2 }); });
    assert.throws(() => workload.alive(), /probe failed/);
});
