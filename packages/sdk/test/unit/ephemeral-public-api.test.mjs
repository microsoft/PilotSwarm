import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EphemeralSessionError } from "pilotswarm-sdk";
import { EphemeralSessionError as InvokerError } from "../../dist/ephemeral-errors.js";
import * as browserApi from "pilotswarm-sdk/api";

test("the public root can be imported without host startup or inference", () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import net from "node:net";
        import tls from "node:tls";
        import childProcess from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        const forbidden = () => { throw new Error("Import-only preflight attempted runtime I/O"); };
        net.Socket.prototype.connect = forbidden;
        tls.connect = forbidden;
        for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
            childProcess[name] = forbidden;
        }
        syncBuiltinESMExports();
        const sdk = await import("pilotswarm-sdk");
        process.stdout.write(new sdk.EphemeralSessionError("EPHEMERAL_MODEL_UNAVAILABLE").code);
    `], { cwd: new URL("../../", import.meta.url), encoding: "utf8", timeout: 30_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "EPHEMERAL_MODEL_UNAVAILABLE");
});

test("the public root exports the exact invoker error class", () => {
    assert.equal(EphemeralSessionError, InvokerError);
    const error = new InvokerError("EPHEMERAL_MODEL_UNAVAILABLE");
    assert.ok(error instanceof EphemeralSessionError);
    assert.ok(error instanceof Error);
    assert.equal(error.name, "EphemeralSessionError");
    assert.equal(error.code, "EPHEMERAL_MODEL_UNAVAILABLE");
    assert.equal(typeof error.message, "string");
});

test("public error construction retains safe codes without exposing rejected values", () => {
    const error = new EphemeralSessionError("private-canary");
    assert.equal(error.code, "EPHEMERAL_INVOCATION_FAILED");
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private-canary/);
});

test("context-integrity failures retain their fatal code in public errors and serialization", () => {
    const code = "EPHEMERAL_UNEXPECTED_CONTEXT_CLEAR";
    const error = new EphemeralSessionError(code);
    assert.equal(error.code, code);
    assert.match(error.message, /entire run must stop/);
    assert.deepEqual(JSON.parse(JSON.stringify(error)), { code, name: "EphemeralSessionError" });
});

test("root error exports do not expose host inference through the browser protocol", () => {
    assert.equal("EphemeralSessionError" in browserApi, false);
    assert.equal(browserApi.getOperation("runEphemeralSession"), null);
    assert.equal(browserApi.getOperation("invokeNoTools"), null);
    assert.equal(browserApi.getOperation("describeNoToolsModel"), null);
});
