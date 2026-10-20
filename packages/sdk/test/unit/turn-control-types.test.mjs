// Session turn control, phase A1: the public types compile for a consumer
// that imports only the SDK entry point (test/types/turn-control.ts),
// including the expected type errors marked with @ts-expect-error.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
const fixture = fileURLToPath(new URL("../types/turn-control.ts", import.meta.url));

test("the turn-control public types compile for a consumer", () => {
    const run = spawnSync(process.execPath, [
        tsc, "--noEmit", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext",
        "--strict", "--esModuleInterop", "--skipLibCheck", fixture,
    ], { encoding: "utf8" });
    assert.equal(run.status, 0, `tsc failed:\n${run.stdout}${run.stderr}`);
});
