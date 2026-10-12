import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const protectedPaths = [
  { name: "AllowMcpMessagesPath", path: "/messages" },
  { name: "AllowSessionSubmitPath", path: "/api/v1/sessions" },
  { name: "AllowWorkflowDefinitionPath", path: "/api/v1/workflow-definitions" },
  { name: "AllowWorkflowGeneratorPath", path: "/api/v1/workflow-generators" },
];
const policies = [
  {
    label: "Azure Front Door WAF",
    file: join(
      repoRoot,
      "deploy",
      "providers",
      "azure",
      "services",
      "global-infra",
      "bicep",
      "frontdoor-waf-policy.bicep",
    ),
  },
  {
    label: "Application Gateway WAF",
    file: join(
      repoRoot,
      "deploy",
      "providers",
      "azure",
      "services",
      "base-infra",
      "bicep",
      "application-gateway.bicep",
    ),
  },
];

function ruleSource(raw, name) {
  const start = raw.indexOf(`name: '${name}'`);
  if (start < 0) return null;
  let end = raw.length;
  for (const { name: other } of protectedPaths) {
    if (other === name) continue;
    const candidate = raw.indexOf(`name: '${other}'`, start + 1);
    if (candidate > start && candidate < end) end = candidate;
  }
  return raw.slice(start, end);
}

for (const { label, file } of policies) {
  test(`${label} allows every protected API path`, () => {
    const raw = readFileSync(file, "utf8");
    for (const { name, path } of protectedPaths) {
      const source = ruleSource(raw, name);
      assert.ok(source, `${label} is missing ${name}.`);
      assert.match(source, /action:\s*'Allow'/);
      assert.ok(source.includes(`'${path}'`), `${name} must match ${path}.`);
    }
  });
}
