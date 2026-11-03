// Tests for ci-failure-reason.mjs: the fixed diagnostic line the Azure deploy
// action prints instead of the private deploy log.
//
// Run: node --test deploy/scripts/test/ci-failure-reason.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyFailure } from "../ci-failure-reason.mjs";

function failedLog(...errorLines) {
  return [
    "[2026-11-02T00:00:00.000Z] ▶ === [base-infra] bicep ===",
    "[2026-11-02T00:00:01.000Z] · [base-infra] render params",
    "[2026-11-02T00:00:02.000Z] ✖ Failed: base-infra bicep",
    ...errorLines,
    "",
    "Re-run with: npm run deploy -- base-infra ci --steps bicep",
  ].join("\n");
}

test("output above the capture limit is not reported as a failed start", () => {
  const log = failedLog(
    "Output too large: az cognitiveservices model list --location westus3 -o json printed more than 67108864 bytes",
  );
  assert.equal(classifyFailure(log), "Diagnostic: Azure CLI output exceeded the capture limit.");
});

test("an ENOBUFS from older deploy scripts is also reported as too much output", () => {
  const log = failedLog("Failed to spawn az: spawnSync /usr/bin/az ENOBUFS");
  assert.equal(classifyFailure(log), "Diagnostic: Azure CLI output exceeded the capture limit.");
});

test("a real start failure is still reported as Azure CLI could not start", () => {
  const log = failedLog("Failed to spawn az: spawnSync az ENOENT");
  assert.equal(classifyFailure(log), "Diagnostic: Azure CLI could not start.");
});
