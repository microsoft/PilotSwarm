import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    campaign,
    materializeReports,
} from "./helpers/local-test-validation-fixtures.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_ROOT = path.join(REPO_ROOT, "test-results", "validation-comparison-regression");

function scratch(t) {
    const directory = path.join(TEST_ROOT, crypto.randomUUID());
    fs.mkdirSync(directory, { recursive: true });
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function runComparison(args) {
    return spawnSync(process.execPath, [
        path.join(REPO_ROOT, "scripts", "compare-local-test-validation.mjs"),
        ...args,
    ], {
        cwd: REPO_ROOT,
        encoding: "utf8",
    });
}

test("comparison CLI exits zero for a valid likely regression and writes the record", (t) => {
    const directory = scratch(t);
    const baselineDirectory = path.join(directory, "baseline");
    const candidateDirectory = path.join(directory, "candidate");
    fs.mkdirSync(baselineDirectory, { recursive: true });
    fs.mkdirSync(candidateDirectory, { recursive: true });
    const baselinePath = path.join(baselineDirectory, "campaign.json");
    const candidatePath = path.join(candidateDirectory, "campaign.json");
    const outputPath = path.join(directory, "comparison.json");
    const baseline = campaign("base", { "file.test.js": ["passed"] });
    const candidate = campaign("candidate", { "file.test.js": ["timed_out"] });
    materializeReports(baselineDirectory, baseline);
    materializeReports(candidateDirectory, candidate);
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));
    fs.writeFileSync(candidatePath, JSON.stringify(candidate));
    const result = runComparison([
        "--baseline", baselinePath,
        "--candidate", candidatePath,
        "--output", outputPath,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const comparison = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(comparison.files["file.test.js"].classification, "likely-regression");

    const reportPath = path.join(baselineDirectory, "reports", "1.json");
    const reportDigestBefore = crypto.createHash("sha256")
        .update(fs.readFileSync(reportPath))
        .digest("hex");
    const collision = runComparison([
        "--baseline", baselinePath,
        "--candidate", candidatePath,
        "--output", reportPath,
    ]);
    assert.notEqual(collision.status, 0);
    assert.match(collision.stderr, /verified report artifact/);
    assert.equal(
        crypto.createHash("sha256").update(fs.readFileSync(reportPath)).digest("hex"),
        reportDigestBefore,
    );
});

test("comparison CLI rejects missing, tampered, and identical manifest evidence", (t) => {
    const directory = scratch(t);
    const baselineDirectory = path.join(directory, "baseline");
    const candidateDirectory = path.join(directory, "candidate");
    fs.mkdirSync(baselineDirectory, { recursive: true });
    fs.mkdirSync(candidateDirectory, { recursive: true });
    const baselinePath = path.join(baselineDirectory, "campaign.json");
    const candidatePath = path.join(candidateDirectory, "campaign.json");
    const baseline = campaign("base", { "file.test.js": ["passed"] });
    const candidate = campaign("candidate", { "file.test.js": ["failed"] });
    materializeReports(baselineDirectory, baseline);
    materializeReports(candidateDirectory, candidate);
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));
    fs.writeFileSync(candidatePath, JSON.stringify(candidate));

    fs.appendFileSync(path.join(candidateDirectory, "reports", "1.json"), "tampered");
    const tampered = runComparison(["--baseline", baselinePath, "--candidate", candidatePath]);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /digest mismatch/);

    fs.rmSync(path.join(baselineDirectory, "reports", "1.json"));
    const missing = runComparison(["--baseline", baselinePath, "--candidate", candidatePath]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /artifact.*missing/);

    const identical = runComparison(["--baseline", baselinePath, "--candidate", baselinePath]);
    assert.notEqual(identical.status, 0);
    assert.match(identical.stderr, /manifest paths must be distinct/);
});

test("comparison CLI rejects manifest outcomes that contradict native reports", (t) => {
    const directory = scratch(t);
    const baselineDirectory = path.join(directory, "baseline");
    const candidateDirectory = path.join(directory, "candidate");
    fs.mkdirSync(baselineDirectory, { recursive: true });
    fs.mkdirSync(candidateDirectory, { recursive: true });
    const baselinePath = path.join(baselineDirectory, "campaign.json");
    const candidatePath = path.join(candidateDirectory, "campaign.json");
    const baseline = campaign("base", { "file.test.js": ["passed"] });
    const candidate = campaign("candidate", { "file.test.js": ["failed"] });
    materializeReports(baselineDirectory, baseline);
    materializeReports(candidateDirectory, candidate);
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));

    candidate.tests["file.test.js"].status = "passed";
    candidate.tests["file.test.js"].attempts[0].status = "passed";
    fs.writeFileSync(candidatePath, JSON.stringify(candidate));
    const statusMismatch = runComparison([
        "--baseline", baselinePath,
        "--candidate", candidatePath,
    ]);
    assert.notEqual(statusMismatch.status, 0);
    assert.match(statusMismatch.stderr, /outcome does not match its native report/);

    candidate.tests["file.test.js"].status = "failed";
    candidate.tests["file.test.js"].attempts[0].status = "failed";
    candidate.tests["file.test.js"].attempts[0].exitCode = 0;
    fs.writeFileSync(candidatePath, JSON.stringify(candidate));
    const exitMismatch = runComparison([
        "--baseline", baselinePath,
        "--candidate", candidatePath,
    ]);
    assert.notEqual(exitMismatch.status, 0);
    assert.match(exitMismatch.stderr, /outcome does not match its native report/);
});
