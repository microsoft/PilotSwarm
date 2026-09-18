#!/usr/bin/env node
// Print only a fixed diagnostic category from a deploy log. Action logs are
// visible to readers of the repository, while deploy logs contain resource
// names, endpoints, and potentially secret-bearing CLI output.
import { readFileSync } from "node:fs";

export function classifyFailure(log) {
  const lines = log.split(/\r?\n/);
  const failureIndex = lines.findLastIndex((line) => /Failed: [a-z-]+ [a-z-]+/.test(line));
  const stageIndex = lines.slice(0, failureIndex).findLastIndex((line) => /=== \[[a-z-]+\] [a-z-]+ ===/.test(line));
  const nearby = lines.slice(Math.max(0, stageIndex), failureIndex + 6).join("\n");
  if (/Unresolved overlay \.env keys/.test(nearby)) return "Diagnostic: unresolved overlay configuration.";
  if (/DEPLOYMENT_STORAGE_ACCOUNT_NAME must be set/.test(nearby)) return "Diagnostic: storage account output is missing.";
  if (/Failed to spawn az/.test(nearby)) return "Diagnostic: Azure CLI could not start.";
  if (/AuthorizationPermissionMismatch|AuthorizationFailure|AuthorizationFailed|Forbidden|\b403\b/i.test(nearby)) {
    return "Diagnostic: Azure authorization failure.";
  }
  if (/ResourceNotFound|ContainerNotFound|\b404\b/i.test(nearby)) return "Diagnostic: Azure resource was not found.";
  if (/az storage blob upload-batch .*exited [1-9]/.test(nearby)) return "Diagnostic: blob upload CLI failed.";
  if (/az storage blob list .*exited [1-9]/.test(nearby)) return "Diagnostic: blob list CLI failed.";
  if (/az .*exited [1-9]/.test(nearby)) return "Diagnostic: Azure CLI failed.";
  if (/ENOENT/.test(nearby)) return "Diagnostic: required local file is missing.";
  return "Diagnostic: unclassified; inspect private runner log during a reproduction.";
}

if (process.argv[1]?.endsWith("ci-failure-reason.mjs")) {
  try {
    process.stdout.write(`${classifyFailure(readFileSync(process.argv[2], "utf8"))}\n`);
  } catch {
    process.stdout.write("Diagnostic: deploy log unavailable.\n");
  }
}
