#!/usr/bin/env node
// Materialize an Azure deployment stamp from GitHub Environment Secrets.
// The runner writes only under the ignored deploy/envs/local/ directory.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./lib/common.mjs";

const ENV_NAME = "ci";
const LOCAL_DIR = join(REPO_ROOT, "deploy", "envs", "local", ENV_NAME);

function parseEntries(text) {
  if (!text?.trim()) throw new Error("AZURE_DEPLOY_ENV is missing");
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) throw new Error("AZURE_DEPLOY_ENV contains a malformed line");
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error("AZURE_DEPLOY_ENV contains an invalid key");
    }
    if (values.has(key)) throw new Error(`AZURE_DEPLOY_ENV repeats ${key}`);
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const comment = value.match(/\s+#.*$/);
      if (comment) value = value.slice(0, comment.index).trimEnd();
    }
    values.set(key, value);
  }
  return values;
}

function requireValue(values, key) {
  const value = values.get(key);
  if (!value || value === "__PS_UNSET__") throw new Error(`AZURE_DEPLOY_ENV requires ${key}`);
  return value;
}

function requireSetting(values, key, expected) {
  if (values.get(key) !== expected) throw new Error(`AZURE_DEPLOY_ENV requires ${key}=${expected}`);
}

function parseJsonSecret(value, key) {
  if (!value?.trim()) throw new Error(`${key} is missing`);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${key} must contain valid JSON`);
  }
}

export function prepareGithubEnv({ envText, foundryText, modelText, subscriptionId, tenantId, principalId, writeDir = LOCAL_DIR }) {
  const values = parseEntries(envText);
  for (const key of [
    "LOCATION", "RESOURCE_PREFIX", "RESOURCE_GROUP", "PORTAL_RESOURCE_NAME",
    "PORTAL_HOSTNAME", "ACME_EMAIL", "PORTAL_AUTH_ENTRA_CLIENT_ID",
    "HORIZONDB_CLUSTER_NAME", "DATABASE_URL_SECRET_NAME",
    "PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_NAME",
  ]) requireValue(values, key);
  if (!subscriptionId || !tenantId || !principalId) {
    throw new Error("Azure OIDC subscription, tenant and principal object ID are required");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principalId)) {
    throw new Error("Azure deployment principal object ID must be a UUID");
  }
  requireSetting(values, "DEPLOY_PROVIDER", "azure");
  requireSetting(values, "SUBSCRIPTION_ID", subscriptionId);
  requireSetting(values, "AZURE_TENANT_ID", tenantId);
  requireSetting(values, "PORTAL_AUTH_ENTRA_TENANT_ID", tenantId);
  requireSetting(values, "EDGE_MODE", "public");
  requireSetting(values, "TLS_SOURCE", "letsencrypt");
  requireSetting(values, "PORTAL_AUTH_PROVIDER", "entra");
  requireSetting(values, "PORTAL_AUTH_ALLOW_UNAUTHENTICATED", "false");
  requireSetting(values, "AUTHZ_ENFORCE_OWNERSHIP", "true");
  if (!["none", "", "__PS_UNSET__", undefined].includes(values.get("PORTAL_AUTHZ_DEFAULT_ROLE"))) {
    throw new Error("AZURE_DEPLOY_ENV must deny unmatched portal users");
  }
  for (const kind of ["ADMIN", "USER"]) {
    const groups = [values.get(`PORTAL_AUTHZ_${kind}_GROUPS`), values.get(`PORTAL_AUTH_ENTRA_${kind}_GROUPS`)]
      .find((entry) => entry && entry !== "__PS_UNSET__" && entry.split(",").some((item) => item.trim()));
    if (!groups) {
      throw new Error(`AZURE_DEPLOY_ENV requires the ${kind.toLowerCase()} allowlist`);
    }
  }
  requireSetting(values, "DEPLOY_POSTGRES", "false");
  requireSetting(values, "HORIZONDB_ENABLED", "true");
  requireSetting(values, "FOUNDRY_ENABLED", "true");
  requireSetting(values, "PILOTSWARM_USE_MANAGED_IDENTITY", "0");
  requireSetting(values, "VPN_GATEWAY_ENABLED", "false");
  requireSetting(values, "GITHUB_TOKEN", "");
  requireSetting(values, "ANTHROPIC_API_KEY", "");
  requireSetting(values, "DATABASE_URL", "");
  requireSetting(values, "PILOTSWARM_CMS_FACTS_DATABASE_URL", "");
  if (values.get("DATABASE_URL_SECRET_NAME") !== values.get("HORIZONDB_URL_SECRET_NAME") ||
      values.get("PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_NAME") !== values.get("HORIZONDB_URL_SECRET_NAME")) {
    throw new Error("Both database URL secret references must point to the HorizonDB URL secret");
  }
  const foundry = parseJsonSecret(foundryText, "AZURE_FOUNDRY_DEPLOYMENTS_JSON");
  if (!Array.isArray(foundry) || foundry.length === 0) {
    throw new Error("AZURE_FOUNDRY_DEPLOYMENTS_JSON must be a nonempty array");
  }
  for (const name of ["gpt-5.6-terra", "text-embedding-3-small"]) {
    if (!foundry.some((deployment) => deployment?.model?.name === name && deployment.model.version)) {
      throw new Error(`AZURE_FOUNDRY_DEPLOYMENTS_JSON requires ${name}`);
    }
  }
  const models = parseJsonSecret(modelText, "AZURE_MODEL_PROVIDERS_JSON");
  if (!Array.isArray(models.providers) || models.providers.length !== 1 || models.providers[0].id !== "azure-foundry") {
    throw new Error("AZURE_MODEL_PROVIDERS_JSON must contain only the Azure Foundry provider");
  }
  const provider = models.providers[0];
  if (provider.type !== "openai" || provider.wireApi !== "responses") {
    throw new Error("AZURE_MODEL_PROVIDERS_JSON requires type openai and wireApi responses for Terra tools with reasoning");
  }
  if (provider.baseUrl !== "__FOUNDRY_ENDPOINT__/openai/v1" || provider.apiKey !== "env:AZURE_OAI_KEY") {
    throw new Error("AZURE_MODEL_PROVIDERS_JSON must use the generated Foundry endpoint and Key Vault key");
  }
  if (models.defaultModel !== "azure-foundry:gpt-5.6-terra" ||
      !provider.models?.some((model) => model.name === "gpt-5.6-terra")) {
    throw new Error("AZURE_MODEL_PROVIDERS_JSON must default to the deployed Terra model");
  }

  // The secret is a standalone env file. Replace any prior local file paths;
  // they cannot exist on a fresh runner. The final copies are gitignored.
  const filePath = `deploy/envs/local/${ENV_NAME}`;
  const envOut = [
    envText.trimEnd(),
    `FOUNDRY_DEPLOYMENTS_FILE=${filePath}/foundry-deployments.json`,
    `MODEL_PROVIDERS_FILE=${filePath}/model_providers.json`,
    `DEPLOY_PRINCIPAL_ID=${principalId}`,
    "",
  ].join("\n");
  mkdirSync(writeDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(writeDir, ".env"), envOut, { mode: 0o600 });
  writeFileSync(join(writeDir, "foundry-deployments.json"), JSON.stringify(foundry), { mode: 0o600 });
  writeFileSync(join(writeDir, "model_providers.json"), JSON.stringify(models), { mode: 0o600 });
  return values;
}

function maskForActions(values) {
  // A multiline GitHub Secret masks the whole document, but not each value
  // when Azure or the deployer prints a resource name or endpoint.
  for (const value of new Set(values.values())) {
    if (!value || value.length < 6 || value === "__PS_UNSET__") continue;
    const escaped = value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    process.stdout.write(`::add-mask::${escaped}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const values = prepareGithubEnv({
      envText: process.env.AZURE_DEPLOY_ENV,
      foundryText: process.env.AZURE_FOUNDRY_DEPLOYMENTS_JSON,
      modelText: process.env.AZURE_MODEL_PROVIDERS_JSON,
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
      tenantId: process.env.AZURE_TENANT_ID,
      principalId: process.env.AZURE_DEPLOY_PRINCIPAL_OBJECT_ID,
    });
    maskForActions(values);
    process.stdout.write("Deployment configuration prepared in the ignored local directory.\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
