import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareGithubEnv } from "../prepare-github-env.mjs";
import { resolveLocalDeploymentPrincipal } from "../lib/deploy-bicep.mjs";

const subscriptionId = "11111111-1111-1111-1111-111111111111";
const tenantId = "22222222-2222-2222-2222-222222222222";
const principalId = "33333333-3333-3333-3333-333333333333";
const envText = [
  "DEPLOY_PROVIDER=azure",
  `SUBSCRIPTION_ID=${subscriptionId}`,
  `AZURE_TENANT_ID=${tenantId}`,
  "LOCATION=example-region",
  "RESOURCE_PREFIX=example",
  "RESOURCE_GROUP=example-rg",
  "PORTAL_RESOURCE_NAME=example-portal",
  "PORTAL_HOSTNAME=example.invalid",
  "ACME_EMAIL=operator@example.invalid",
  "PORTAL_AUTH_ENTRA_CLIENT_ID=44444444-4444-4444-4444-444444444444",
  `PORTAL_AUTH_ENTRA_TENANT_ID=${tenantId}`,
  "PORTAL_AUTH_PROVIDER=entra",
  "PORTAL_AUTH_ALLOW_UNAUTHENTICATED=false",
  "PORTAL_AUTHZ_DEFAULT_ROLE=none",
  "PORTAL_AUTHZ_ADMIN_GROUPS=admin@example.invalid",
  "PORTAL_AUTHZ_USER_GROUPS=user@example.invalid",
  "AUTHZ_ENFORCE_OWNERSHIP=true",
  "EDGE_MODE=public",
  "TLS_SOURCE=letsencrypt",
  "VPN_GATEWAY_ENABLED=false",
  "DEPLOY_POSTGRES=false",
  "HORIZONDB_ENABLED=true",
  "HORIZONDB_CLUSTER_NAME=example-db",
  "HORIZONDB_URL_SECRET_NAME=example-db-url",
  "DATABASE_URL_SECRET_NAME=example-db-url",
  "PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_NAME=example-db-url",
  "FOUNDRY_ENABLED=true",
  "PILOTSWARM_USE_MANAGED_IDENTITY=0",
  "GITHUB_TOKEN=",
  "ANTHROPIC_API_KEY=",
  "DATABASE_URL=",
  "PILOTSWARM_CMS_FACTS_DATABASE_URL=",
  "FOUNDRY_DEPLOYMENTS_FILE=old-path",
  "MODEL_PROVIDERS_FILE=old-path",
  "",
].join("\n");
const foundryText = JSON.stringify([
  { name: "model", model: { name: "gpt-5.6-terra", version: "fixture" } },
  { name: "embedding", model: { name: "text-embedding-3-small", version: "fixture" } },
]);
const modelText = JSON.stringify({
  providers: [{ id: "azure-foundry", type: "openai", wireApi: "responses", baseUrl: "__FOUNDRY_ENDPOINT__/openai/v1", apiKey: "env:AZURE_OAI_KEY", models: [{ name: "gpt-5.6-terra" }] }],
  defaultModel: "azure-foundry:gpt-5.6-terra",
});

function input(overrides = {}) {
  return { envText, foundryText, modelText, subscriptionId, tenantId, principalId, ...overrides };
}

test("GitHub configuration stays in private files and overrides stale local paths", (t) => {
  const writeDir = mkdtempSync(join(tmpdir(), "ps-gh-env-"));
  t.after(() => rmSync(writeDir, { recursive: true, force: true }));
  prepareGithubEnv(input({ writeDir }));
  const content = readFileSync(join(writeDir, ".env"), "utf8");
  assert.match(content, /MODEL_PROVIDERS_FILE=deploy\/envs\/local\/ci\/model_providers.json$/m);
  assert.match(content, /DEPLOY_PRINCIPAL_ID=33333333-3333-3333-3333-333333333333$/m);
  assert.equal(JSON.parse(readFileSync(join(writeDir, "foundry-deployments.json"), "utf8")).length, 2);
  assert.equal(statSync(join(writeDir, ".env")).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(writeDir, "model_providers.json"), "utf8")).providers[0].wireApi, "responses");
});

test("Terra deployment rejects Chat Completions and an omitted API format", () => {
  for (const wireApi of [undefined, "completions"]) {
    const models = JSON.parse(modelText);
    models.providers[0].wireApi = wireApi;
    assert.throws(() => prepareGithubEnv(input({ modelText: JSON.stringify(models) })), /wireApi responses/);
  }
});

test("GitHub configuration rejects a different subscription or weaker portal auth", () => {
  assert.throws(() => prepareGithubEnv(input({ subscriptionId: tenantId })), /SUBSCRIPTION_ID/);
  assert.throws(() => prepareGithubEnv(input({ envText: envText.replace("PORTAL_AUTH_ALLOW_UNAUTHENTICATED=false", "PORTAL_AUTH_ALLOW_UNAUTHENTICATED=true") })), /PORTAL_AUTH_ALLOW_UNAUTHENTICATED/);
  assert.throws(() => prepareGithubEnv(input({ envText: envText.replace("PORTAL_AUTHZ_USER_GROUPS=user@example.invalid", "PORTAL_AUTHZ_USER_GROUPS=__PS_UNSET__") })), /user allowlist/);
  assert.throws(() => prepareGithubEnv(input({ modelText: JSON.stringify({ providers: [{ id: "github-copilot" }], defaultModel: "github-copilot:x" }) })), /Azure Foundry provider/);
});

test("OIDC deployment principal resolves without a signed-in human", () => {
  assert.deepEqual(resolveLocalDeploymentPrincipal({ DEPLOY_PRINCIPAL_ID: principalId }), {
    id: principalId, type: "ServicePrincipal", label: "deployment service principal",
  });
  assert.throws(() => resolveLocalDeploymentPrincipal({ DEPLOY_PRINCIPAL_ID: "not-an-id" }), /object ID/);
});

test("explicit authenticated-admin posture retains tenant/auth gates without email allowlists", (t) => {
  const writeDir = mkdtempSync(join(tmpdir(), "ps-gh-admin-env-"));
  t.after(() => rmSync(writeDir, { recursive: true, force: true }));
  const adminEnv = envText
    .replace("PORTAL_AUTHZ_ADMIN_GROUPS=admin@example.invalid", "PORTAL_AUTHZ_ADMIN_GROUPS=__PS_UNSET__")
    .replace("PORTAL_AUTHZ_USER_GROUPS=user@example.invalid", "PORTAL_AUTHZ_USER_GROUPS=__PS_UNSET__")
    + "PORTAL_AUTHZ_MODE=authenticated-admin\n";
  prepareGithubEnv(input({ envText: adminEnv, writeDir }));
  assert.match(readFileSync(join(writeDir, ".env"), "utf8"), /PORTAL_AUTHZ_MODE=authenticated-admin/);
  for (const [from, to, expected] of [
    ["PORTAL_AUTH_ALLOW_UNAUTHENTICATED=false", "PORTAL_AUTH_ALLOW_UNAUTHENTICATED=true", /PORTAL_AUTH_ALLOW_UNAUTHENTICATED/],
    ["PORTAL_AUTH_PROVIDER=entra", "PORTAL_AUTH_PROVIDER=none", /PORTAL_AUTH_PROVIDER/],
    [`PORTAL_AUTH_ENTRA_TENANT_ID=${tenantId}`, `PORTAL_AUTH_ENTRA_TENANT_ID=${subscriptionId}`, /PORTAL_AUTH_ENTRA_TENANT_ID/],
    ["AUTHZ_ENFORCE_OWNERSHIP=true", "AUTHZ_ENFORCE_OWNERSHIP=false", /AUTHZ_ENFORCE_OWNERSHIP/],
    ["PORTAL_AUTHZ_MODE=authenticated-admin", "PORTAL_AUTHZ_MODE=authenticated-admn", /PORTAL_AUTHZ_MODE/],
  ]) {
    assert.throws(() => prepareGithubEnv(input({ envText: adminEnv.replace(from, to), writeDir })), expected);
  }
});
