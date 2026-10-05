import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    acquireExecutionLock,
    getProcessIdentity,
    releaseExecutionLock,
    runTestFile,
} from "../run-local-test-baseline.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_ROOT = path.resolve(
    REPO_ROOT,
    "test-results",
    "validation-harness-regression",
);

function scratch(t) {
    const dir = path.join(TEST_ROOT, crypto.randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test("campaign lock recognizes the actual live coordinator process", (t) => {
    const output = path.join(scratch(t), "campaign.json");
    const processIdentity = getProcessIdentity(process.pid);
    assert.ok(processIdentity);
    const held = acquireExecutionLock(output, {
        token: "actual-owner",
        runId: "actual-run",
        processIdentity,
    });
    assert.throws(
        () => acquireExecutionLock(output, {
            token: "contender",
            runId: "contender-run",
            processIdentity,
        }),
        /Another validation coordinator is live/,
    );
    assert.equal(releaseExecutionLock(held), true);
});

test("gates an attempt until PID persistence and retains only a redacted native report", {
    timeout: 30_000,
}, async (t) => {
    const id = crypto.randomUUID();
    const fileName = `validation-harness-redaction-${id}.test.js`;
    const testPath = path.join(REPO_ROOT, "packages", "sdk", "test", "local", fileName);
    const reportPath = path.join(scratch(t), "native-attempt.json");
    fs.writeFileSync(testPath, `
import { it, expect } from "vitest";
it("redacts failure output", () => {
    expect("actual").toBe(process.env.HARNESS_TEST_TOKEN);
});
`);
    t.after(() => fs.rmSync(testPath, { force: true }));
    const started = new Date();
    let ready = null;
    let vitestReady = null;
    const result = await runTestFile(
        fileName,
        20_000,
        { ...process.env, HARNESS_TEST_TOKEN: "harness-secret-value" },
        reportPath,
        null,
        {
            startedAt: started.toISOString(),
            deadlineAt: new Date(started.getTime() + 20_000).toISOString(),
            onReady: async (value) => {
                ready = value;
                assert.equal(Number.isInteger(value.pid), true);
                assert.equal(value.processIdentity.pid, value.pid);
                assert.equal(fs.existsSync(reportPath), true);
            },
            onVitestReady: async (value) => {
                vitestReady = value;
                assert.equal(Number.isInteger(value.pid), true);
                assert.equal(value.processIdentity.pid, value.pid);
            },
        },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.collectionStatus, "complete");
    assert.equal(result.reportEvidenceValid, true);
    assert.match(result.reportDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.evidenceError, null);
    assert.ok(ready);
    assert.ok(vitestReady);
    assert.equal(result.vitestPid, vitestReady.pid);
    assert.deepEqual(result.vitestProcessIdentity, vitestReady.processIdentity);
    const retained = fs.readFileSync(reportPath, "utf8");
    assert.equal(
        result.reportDigest,
        `sha256:${crypto.createHash("sha256").update(retained).digest("hex")}`,
    );
    assert.doesNotMatch(retained, /harness-secret-value/);
    assert.equal(Array.isArray(JSON.parse(retained).testResults), true);
});

test("does not launch Vitest when child process identity cannot be verified", {
    timeout: 30_000,
}, async (t) => {
    const id = crypto.randomUUID();
    const fileName = `validation-harness-identity-${id}.test.js`;
    const testPath = path.join(REPO_ROOT, "packages", "sdk", "test", "local", fileName);
    const dir = scratch(t);
    const reportPath = path.join(dir, "identity-attempt.json");
    const markerPath = path.join(dir, "started.marker");
    fs.writeFileSync(testPath, `
import fs from "node:fs";
import { it } from "vitest";
fs.writeFileSync(process.env.IDENTITY_MARKER, "started");
it("would run", () => {});
`);
    t.after(() => fs.rmSync(testPath, { force: true }));
    const started = new Date();
    let readyCalled = false;
    await assert.rejects(
        runTestFile(
            fileName,
            20_000,
            { ...process.env, IDENTITY_MARKER: markerPath },
            reportPath,
            null,
            {
                startedAt: started.toISOString(),
                deadlineAt: new Date(started.getTime() + 20_000).toISOString(),
                onReady: async () => {
                    readyCalled = true;
                },
                campaignOutputDirectory: dir,
                inspectProcess: () => null,
                identityAttempts: 2,
            },
        ),
        /Could not verify attempt process identity/,
    );
    assert.equal(readyCalled, false);
    assert.equal(fs.existsSync(markerPath), false);
    assert.equal(fs.existsSync(reportPath), false);
});

test("cleanup terminates detached descendants before reporting verified", {
    timeout: 30_000,
}, async (t) => {
    const id = crypto.randomUUID();
    const fileName = `validation-harness-detached-${id}.test.js`;
    const testPath = path.join(REPO_ROOT, "packages", "sdk", "test", "local", fileName);
    const directory = scratch(t);
    const infoPath = path.join(directory, "detached-listener.json");
    const reportPath = path.join(directory, "detached-attempt.json");
    const serverSource = `
import fs from "node:fs";
import net from "node:net";
const server = net.createServer(() => {});
server.listen(0, "127.0.0.1", () => {
    fs.writeFileSync(process.argv[1], JSON.stringify({
        pid: process.pid,
        port: server.address().port,
    }));
});
setInterval(() => {}, 60_000);
`;
    fs.writeFileSync(testPath, `
import { spawn } from "node:child_process";
import { it } from "vitest";

it("leaves a detached listener running when the attempt times out", async () => {
    const child = spawn(process.execPath, [
        "--input-type=module",
        "-e",
        ${JSON.stringify(serverSource)},
        process.env.DETACHED_LISTENER_INFO,
    ], {
        detached: true,
        stdio: "ignore",
    });
    child.unref();
    await new Promise(() => {});
});
`);

    let detachedPid = null;
    t.after(() => {
        fs.rmSync(testPath, { force: true });
        if (!detachedPid && fs.existsSync(infoPath)) {
            detachedPid = JSON.parse(fs.readFileSync(infoPath, "utf8")).pid;
        }
        if (!Number.isInteger(detachedPid) || detachedPid < 1) return;
        try {
            process.kill(-detachedPid, "SIGKILL");
        } catch {}
        try {
            process.kill(detachedPid, "SIGKILL");
        } catch {}
    });

    const started = new Date();
    const timeoutMs = 8_000;
    const result = await runTestFile(
        fileName,
        timeoutMs,
        {
            ...process.env,
            DETACHED_LISTENER_INFO: infoPath,
        },
        reportPath,
        null,
        {
            startedAt: started.toISOString(),
            deadlineAt: new Date(started.getTime() + timeoutMs).toISOString(),
            campaignOutputDirectory: directory,
            onReady: async () => {},
        },
    );
    assert.equal(result.status, "timed_out", JSON.stringify(result, null, 2));
    assert.equal(result.collectionStatus, "complete");
    assert.equal(result.timeoutProcessDisposition, "terminated-and-verified");
    assert.equal(fs.existsSync(infoPath), true, "detached listener reported its identity");
    const listener = JSON.parse(fs.readFileSync(infoPath, "utf8"));
    detachedPid = listener.pid;

    const listenerAcceptsConnections = () => new Promise((resolve) => {
        const socket = net.createConnection({
            host: "127.0.0.1",
            port: listener.port,
        });
        const timer = setTimeout(() => {
            socket.destroy();
            resolve(false);
        }, 1_000);
        socket.once("connect", () => {
            clearTimeout(timer);
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
    assert.equal(
        getProcessIdentity(detachedPid),
        null,
        "detached descendant identity exited before cleanup was verified",
    );
    assert.equal(
        await listenerAcceptsConnections(),
        false,
        "detached descendant no longer accepts connections",
    );
});
