import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

assert.equal(process.env.PS_TEST_MUTATION_COPY, "1", "Run mutations only in a disposable test copy.");

const sdk = fileURLToPath(new URL("../../", import.meta.url));
const local = (file, name) => ["../../node_modules/vitest/vitest.mjs", "run", `test/local/${file}`, "-t", name];
const unit = file => ["--test", `test/unit/${file}`];
const cases = [
    {
        name: "activity-wrapped failures retain their compute code",
        edits: [["dist/compute-failures.js", 'const text = raw.replace(', 'const text = raw; void raw.replace(']],
        args: unit("compute-failures.test.mjs"),
    },
    {
        name: "built-in classifications cannot be overridden",
        edits: [["dist/compute-failures.js", 'const permanent = builtIn?.permanent ?? marker === "permanent";', 'const permanent = marker === "permanent";']],
        args: unit("compute-failures.test.mjs"),
    },
    {
        name: "provider-owned classification survives the activity boundary",
        edits: [["dist/compute-failures.js", 'typeof failure.permanent === "boolean"', "false"]],
        args: unit("compute-failures.test.mjs"),
    },
    {
        name: "failures include corrective action",
        edits: [["dist/compute-failures.js", " ${action}`", "`"]],
        args: unit("compute-failures.test.mjs"),
    },
    {
        name: "permanent failures stop thrown and returned turns",
        edits: [["src/orchestration/turn.ts", "if (computeFailure?.permanent)", "if (false)"]],
        args: local("orchestration-retry-exhaustion.test.js", "permanent compute failure"),
    },
    {
        name: "permanent failure is persisted on the session row",
        edits: [["src/orchestration/turn.ts", 'const closed: any = yield runtime.manager.updateCmsState(runtime.input.sessionId, "error", failure.message, null, { closeControls: true });', 'const closed: any = undefined;']],
        args: local("orchestration-retry-exhaustion.test.js", "permanent compute failure"),
    },
    {
        name: "permanent failure emits a durable reason event",
        edits: [["src/orchestration/turn.ts", '"session.compute_failure"', '"session.compute_failure_removed"']],
        args: local("orchestration-retry-exhaustion.test.js", "permanent compute failure"),
    },
    {
        name: "temporary failures retain the existing retry schedule",
        edits: [["src/orchestration/turn.ts", "const retryDelay = 15 *", "const retryDelay = 14 *"]],
        args: local("orchestration-retry-exhaustion.test.js", "temporary compute failure"),
    },
    {
        name: "direct and web waits reject permanent compute statuses immediately",
        edits: [
            ["src/client.ts", "customStatus.computeFailure?.permanent === true", "false"],
            ["src/web/web-client.ts", "customStatus.computeFailure?.permanent === true", "false"],
        ],
        args: local("client-wait-status.test.js", "permanent compute status"),
    },
    {
        name: "detail reads preserve the saved permanent compute error",
        edits: [["src/client.ts", "&& customStatus?.computeFailure?.permanent !== true", "&& true"]],
        args: local("client-wait-status.test.js", "preserves the saved permanent compute error"),
    },
    {
        name: "web ordinary authentication errors keep their existing response path",
        edits: [["src/web/web-client.ts", 'customStatus.status === "error" && customStatus.computeFailure?.permanent === true', 'customStatus.status === "error" && (customStatus.authFailure || customStatus.computeFailure?.permanent === true)']],
        args: local("client-wait-status.test.js", "web authentication failures without compute metadata"),
    },
    {
        name: "frozen version identity must remain literal",
        edits: [["src/orchestration_1_0_82/runtime.ts", 'CURRENT_ORCHESTRATION_VERSION = "1.0.82"', "CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION"]],
        args: unit("orchestration-freeze-1-0-82.test.mjs"),
    },
];

for (const mutation of cases) {
    const originals = new Map();
    try {
        for (const [relative, before, after] of mutation.edits) {
            const file = fileURLToPath(new URL(`../../${relative}`, import.meta.url));
            const original = readFileSync(file, "utf8");
            originals.set(file, original);
            assert.ok(original.includes(before), `${mutation.name}: mutation anchor missing`);
            writeFileSync(file, original.replaceAll(before, after));
        }
        const result = spawnSync(process.execPath, mutation.args, { cwd: sdk, encoding: "utf8", timeout: 120_000, env: { ...process.env, NO_COLOR: "1" } });
        assert.equal(result.error, undefined, `${mutation.name}: runner failed`);
        assert.equal(result.signal, null, `${mutation.name}: runner was interrupted`);
        assert.equal(result.status, 1, `${mutation.name}: mutation was not caught\n${result.stdout}\n${result.stderr}`);
        const output = `${result.stdout}\n${result.stderr}`;
        assert.match(output, /AssertionError|ERR_ASSERTION|expected .*to (?:be|equal|have|contain)|received|assertion/i, `${mutation.name}: failure was not an assertion`);
        console.log(`CAUGHT: ${mutation.name}`);
    } finally {
        for (const [file, original] of originals) writeFileSync(file, original);
    }
}
