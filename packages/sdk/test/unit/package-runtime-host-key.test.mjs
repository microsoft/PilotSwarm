import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

test("host identity shares in-flight probes but does not permanently cache a failed probe", async () => {
    const originalExec = childProcess.execFile;
    const originalPlatform = os.platform;
    let probes = 0;
    const exec = () => { throw new Error("expected promisified identity probe"); };
    exec[promisify.custom] = async () => {
        probes++;
        if (probes === 1) throw new Error("synthetic unavailable host identity");
        return { stdout: "2026-01-01T00:00:00.0000000Z\n", stderr: "" };
    };
    try {
        childProcess.execFile = exec;
        os.platform = () => "win32";
        syncBuiltinESMExports();
        const { runtimeHostKey } = await import("../../dist/package-runtime-process.js?host-probe-recovery");
        const first = runtimeHostKey();
        assert.equal(runtimeHostKey(), first, "concurrent callers share one probe");
        await assert.rejects(first, /synthetic unavailable host identity/);
        assert.equal(probes, 1, "the failed call is surfaced, not retried silently");
        const recovered = await runtimeHostKey();
        assert.ok(recovered.endsWith(":2026-01-01T00:00:00.0000000Z"));
        assert.equal(await runtimeHostKey(), recovered);
        assert.equal(probes, 2, "only a later invocation retries; successful identity is cached");
    } finally {
        childProcess.execFile = originalExec;
        os.platform = originalPlatform;
        syncBuiltinESMExports();
    }
});
