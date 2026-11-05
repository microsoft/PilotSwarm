import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { ApiClient } from "../../../sdk/api/src/api-client.js";

async function sampleTree(pid) {
    try {
        const [status, children] = await Promise.all([
            fs.readFile(`/proc/${pid}/status`, "utf8"),
            fs.readFile(`/proc/${pid}/task/${pid}/children`, "utf8"),
        ]);
        const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
        const rest = await Promise.all(children.trim().split(/\s+/).filter(Boolean).map(Number).map(sampleTree));
        return rss + rest.reduce((a, b) => a + b, 0);
    } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return 0; throw error; }
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test("isolated warm portal and all upload helpers keep median 5→20MiB peak RSS growth within 8MiB", { skip: process.platform !== "linux", timeout: 240_000 }, async () => {
    const worker = fork(new URL("./workspace-upload-memory-worker.mjs", import.meta.url), {
        execArgv: ["--expose-gc"], stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const [ready] = await once(worker, "message");
    const api = new ApiClient({ apiUrl: ready.url });
    const part = new Uint8Array(524288);
    let serial = 0;
    async function upload(size, concurrency) {
        const entries = await Promise.all(Array.from({ length: concurrency }, () => api.call("startSessionWorkspaceUpload", {
            sessionId: "session", input: { folder: "working", path: `memory-${serial++}.bin`, size, ifMatch: null },
        })));
        for (let n = 0; n < entries[0].partCount; n++) {
            await Promise.all(entries.map((entry) => api.putSessionWorkspaceUploadPart("session", entry.uploadId, n, part.subarray(0, Math.min(entry.partBytes, size - n * entry.partBytes)))));
        }
        await Promise.all(entries.map((entry) => api.call("completeSessionWorkspaceUpload", { sessionId: "session", uploadId: entry.uploadId })));
    }
    const measurements = [];
    async function measure(mib, concurrency, trial) {
        const warm = once(worker, "message"); worker.send("warm"); await warm;
        const baselineRss = await sampleTree(worker.pid);
        let peakRss = baselineRss, stopping = false, sampleError;
        // Await the sampler so neither its final peak nor an error is lost
        // when the upload finishes between samples.
        const sampling = (async () => {
            while (!stopping) {
                peakRss = Math.max(peakRss, await sampleTree(worker.pid));
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
        })().catch((error) => { sampleError = error; });
        try { await upload(mib * 1024 ** 2, concurrency); }
        finally {
            stopping = true;
            await sampling;
            if (sampleError) throw sampleError;
        }
        measurements.push({ concurrency, trial, mib, baselineRss, peakRss, incrementalRss: peakRss - baselineRss });
    }
    try {
        for (const concurrency of [1, 2]) {
            // Warm the complete workload, not only the 1 MiB path. Every
            // fixed trial is retained; this is sampling, not retry-until-green.
            await upload(20 * 1024 ** 2, concurrency);
            for (let trial = 0; trial < 3; trial++) {
                for (const mib of trial % 2 ? [20, 5, 1] : [1, 5, 20]) {
                    await measure(mib, concurrency, trial);
                }
            }
        }
        console.log(JSON.stringify({ kind: "workspace-upload-memory", sampleMs: 5, measurements }));
        if (process.env.WORKSPACE_UPLOAD_MEMORY_EVIDENCE_FILE) await fs.writeFile(process.env.WORKSPACE_UPLOAD_MEMORY_EVIDENCE_FILE, JSON.stringify(measurements, null, 2));
        for (const concurrency of [1, 2]) {
            const growth = Array.from({ length: 3 }, (_, trial) => {
                const five = measurements.find((m) => m.concurrency === concurrency && m.trial === trial && m.mib === 5);
                const twenty = measurements.find((m) => m.concurrency === concurrency && m.trial === trial && m.mib === 20);
                return twenty.incrementalRss - five.incrementalRss;
            });
            assert.ok(median(growth) <= 8 * 1024 ** 2, `${concurrency} calls: median 5→20MiB RSS grew ${median(growth)} bytes; all trials: ${growth.join(", ")}`);
        }
    } finally {
        const exit = once(worker, "exit"); worker.send("stop"); await exit;
    }
});
