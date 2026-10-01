// Guard against WAF path-Allow rule drift across the two edges.
//
// The public API routes through two Web Application Firewalls in Prevention
// mode: Azure Front Door (global-infra/frontdoor-waf-policy.bicep) and the
// Application Gateway (base-infra/application-gateway.bicep). Several API paths
// carry bodies that are legitimate but trip managed SQLi/XSS/RFI rules (freeform
// prompts, session envelopes, and a literal WIQL query). Each such path needs a
// path-scoped Allow custom rule on BOTH edges — if either edge drops its rule,
// the block simply moves to that edge and the request is rejected before it
// reaches the origin. That asymmetric drift is exactly what broke workflow-generator
// registration and is hard to spot by eye.
//
// These rules are declarative bicep (no JS logic to unit-test) and are verified
// end-to-end against a live stamp, so this is a source-shape guard: it asserts
// each protected path has a named Allow rule, with its path matchValue, on both
// policies. It intentionally does not assert priorities/schemas (those differ
// between the AFD and AppGw rule shapes and are covered by deploy/live checks).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Every protected path needs a path-Allow rule on BOTH edges. Keep this list in
// lockstep with the platform rules in both WAF bicep files; adding a new
// always-Allow API path means adding it here too.
const PROTECTED_PATHS = [
  { name: "AllowMcpMessagesPath", path: "/messages" },
  { name: "AllowSessionSubmitPath", path: "/api/v1/sessions" },
  { name: "AllowWorkflowDefinitionPath", path: "/api/v1/workflow-definitions" },
  { name: "AllowWorkflowGeneratorPath", path: "/api/v1/workflow-generators" },
];

const WAF_POLICIES = [
  {
    label: "Azure Front Door WAF (global-infra)",
    file: join(REPO_ROOT, "deploy", "providers", "azure", "services", "global-infra", "bicep", "frontdoor-waf-policy.bicep"),
  },
  {
    label: "Application Gateway WAF (base-infra)",
    file: join(REPO_ROOT, "deploy", "providers", "azure", "services", "base-infra", "bicep", "application-gateway.bicep"),
  },
];

// Slice the source from a rule's `name: '<Name>'` marker up to the next rule
// name (or end of file) so a token from an adjacent rule can't satisfy the
// assertion for this one.
function sliceForRule(raw, name) {
  const start = raw.indexOf(`name: '${name}'`);
  if (start < 0) return null;
  let end = raw.length;
  for (const { name: other } of PROTECTED_PATHS) {
    if (other === name) continue;
    const oi = raw.indexOf(`name: '${other}'`, start + 1);
    if (oi > start && oi < end) end = oi;
  }
  return raw.slice(start, end);
}

for (const { label, file } of WAF_POLICIES) {
  test(`${label} carries a path-Allow rule for every protected API path`, () => {
    const raw = readFileSync(file, "utf8");
    for (const { name, path } of PROTECTED_PATHS) {
      const slice = sliceForRule(raw, name);
      assert.ok(slice, `${label}: missing path-Allow rule '${name}' (protects ${path})`);
      assert.match(
        slice,
        /action:\s*'Allow'/,
        `${label}: rule '${name}' must have action 'Allow'`,
      );
      assert.ok(
        slice.includes(`'${path}'`),
        `${label}: rule '${name}' must match the '${path}' request path`,
      );
    }
  });
}
