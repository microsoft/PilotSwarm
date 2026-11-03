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

test("isolated warm portal and all upload helpers keep 5→20MiB peak RSS growth within 8MiB", { skip: process.platform !== "linux", timeout: 240_000 }, async () => {
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
    try {
        await upload(1024 ** 2, 1);
        const warm = once(worker, "message"); worker.send("warm"); await warm;
        for (const concurrency of [1, 2]) {
            for (const mib of [1, 5, 20]) {
                let peak = await sampleTree(worker.pid), sampling = false, sampleError;
                const timer = setInterval(() => {
                    if (sampling) return;
                    sampling = true;
                    void sampleTree(worker.pid).then((rss) => { peak = Math.max(peak, rss); }, (error) => { sampleError = error; }).finally(() => { sampling = false; });
                }, 5);
                try { await upload(mib * 1024 ** 2, concurrency); }
                finally { clearInterval(timer); }
                if (sampleError) throw sampleError;
                measurements.push({ concurrency, mib, peakRss: peak });
            }
        }
        console.log(JSON.stringify({ kind: "workspace-upload-memory", sampleMs: 5, measurements }));
        if (process.env.WORKSPACE_UPLOAD_MEMORY_EVIDENCE_FILE) await fs.writeFile(process.env.WORKSPACE_UPLOAD_MEMORY_EVIDENCE_FILE, JSON.stringify(measurements, null, 2));
        for (const concurrency of [1, 2]) {
            const five = measurements.find((m) => m.concurrency === concurrency && m.mib === 5);
            const twenty = measurements.find((m) => m.concurrency === concurrency && m.mib === 20);
            assert.ok(twenty.peakRss - five.peakRss <= 8 * 1024 ** 2, `${concurrency} calls: 5→20MiB RSS grew ${twenty.peakRss - five.peakRss} bytes`);
        }
    } finally {
        const exit = once(worker, "exit"); worker.send("stop"); await exit;
    }
});
