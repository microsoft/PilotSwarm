// HorizonDB bootstrap for the Azure deployment provider. No credential is
// written to a rendered template, command argument, ConfigMap or log.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";
import { log, run } from "./common.mjs";
import { deploysPostgres } from "./database-env.mjs";

export function horizonDbEnabled(env) {
  return String(env.HORIZONDB_ENABLED ?? "false").toLowerCase() === "true";
}

export function validateHorizonDbConfig(env) {
  if (!horizonDbEnabled(env)) return;
  const urlSecret = env.HORIZONDB_URL_SECRET_NAME || "horizondb-url";
  if (String(env.EDGE_MODE).toLowerCase() !== "public") {
    throw new Error("HorizonDB deployment currently requires EDGE_MODE=public for the fixed AKS egress firewall rule.");
  }
  if (deploysPostgres(env)) throw new Error("HorizonDB deployment requires DEPLOY_POSTGRES=false.");
  if (!["0", "false"].includes(String(env.PILOTSWARM_USE_MANAGED_IDENTITY).toLowerCase())) {
    throw new Error("HorizonDB deployment requires PILOTSWARM_USE_MANAGED_IDENTITY=0; its URL is a Key Vault secret.");
  }
  for (const key of ["DATABASE_URL_SECRET_NAME", "PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_NAME"]) {
    if (String(env[key] || "").toLowerCase() !== urlSecret.toLowerCase()) {
      throw new Error(`HorizonDB deployment requires ${key}=${urlSecret}.`);
    }
  }
  if (env.DATABASE_URL || env.PILOTSWARM_CMS_FACTS_DATABASE_URL) {
    throw new Error("HorizonDB deployment uses only Key Vault URL references; remove raw database URLs from the env file.");
  }
  if (String(env.FOUNDRY_ENABLED).toLowerCase() !== "true") {
    throw new Error("HorizonDB enhanced facts requires FOUNDRY_ENABLED=true for its embedding deployment.");
  }
}

function secretCommand(args, message) {
  let result;
  try {
    result = run("az", args, { capture: true, allowFail: true });
  } catch {
    throw new Error(message);
  }
  if (result.status !== 0) throw new Error(message);
  return result.stdout.trim();
}

function currentSecret(vault, name) {
  const result = run("az", [
    "keyvault", "secret", "show", "--vault-name", vault, "--name", name,
    "--query", "value", "-o", "tsv",
  ], { capture: true, allowFail: true });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function setSecret(vault, name, value) {
  const dir = mkdtempSync(join(tmpdir(), "pilotswarm-hdb-secret-"));
  try {
    const file = join(dir, "value");
    writeFileSync(file, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    secretCommand([
      "keyvault", "secret", "set", "--vault-name", vault, "--name", name,
      "--file", file, "--encoding", "utf-8", "--output", "none",
    ], `Cannot write HorizonDB secret '${name}' to Key Vault; CLI output is withheld.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function prepareHorizonDbEnvForRender(env) {
  if (!horizonDbEnabled(env)) throw new Error("HorizonDB module requires HORIZONDB_ENABLED=true.");
  for (const key of ["SUBSCRIPTION_ID", "RESOURCE_GROUP", "RESOURCE_PREFIX", "KV_NAME", "AKS_OUTBOUND_IP"]) {
    if (!env[key]) throw new Error(`HorizonDB module requires ${key} from base-infra.`);
  }
  if (isIP(env.AKS_OUTBOUND_IP) !== 4) {
    throw new Error("AKS_OUTBOUND_IP must be one IPv4 address; a broad HorizonDB firewall rule is forbidden.");
  }
  env.KV_RESOURCE_ID = `/subscriptions/${env.SUBSCRIPTION_ID}/resourceGroups/${env.RESOURCE_GROUP}/providers/Microsoft.KeyVault/vaults/${env.KV_NAME}`;
  env.HORIZONDB_CLUSTER_NAME ||= `${env.RESOURCE_PREFIX}-hdb`;
  env.HORIZONDB_ADMIN_LOGIN ||= "pilotswarm";
  env.HORIZONDB_ADMIN_PASSWORD_SECRET_NAME ||= "horizondb-admin-password";
  env.HORIZONDB_URL_SECRET_NAME ||= "horizondb-url";
  env.HORIZONDB_VCORES ||= "4";
  env.HORIZONDB_REPLICA_COUNT ||= "1";
  env.HORIZONDB_PARAMETER_GROUP_NAME ||= `${env.HORIZONDB_CLUSTER_NAME}-pg17-ext`;

  for (const [key, type, name] of [
    ["HORIZONDB_PARAMETER_GROUP_CREATE", "Microsoft.HorizonDb/parameterGroups", env.HORIZONDB_PARAMETER_GROUP_NAME],
    ["HORIZONDB_CLUSTER_CREATE", "Microsoft.HorizonDB/clusters", env.HORIZONDB_CLUSTER_NAME],
  ]) {
    const result = run("az", [
      "resource", "show", "--subscription", env.SUBSCRIPTION_ID,
      "--resource-group", env.RESOURCE_GROUP, "--resource-type", type,
      "--name", name, "--api-version", "2026-01-20-preview",
      "--query", "id", "-o", "tsv",
    ], { capture: true, allowFail: true });
    env[key] = result.status === 0 && result.stdout.trim() ? "false" : "true";
  }
  if (env.HORIZONDB_CLUSTER_CREATE === "false" && env.HORIZONDB_PARAMETER_GROUP_CREATE === "true") {
    throw new Error("Existing HorizonDB cluster is missing its extension parameter group; restore it before retrying.");
  }
}

export function seedHorizonDbAdminPassword(env) {
  if (!horizonDbEnabled(env)) return;
  if (!env.KV_NAME) throw new Error("HorizonDB bootstrap requires KV_NAME from base-infra.");
  const name = env.HORIZONDB_ADMIN_PASSWORD_SECRET_NAME || "horizondb-admin-password";
  if (currentSecret(env.KV_NAME, name) !== undefined) {
    log("info", `[horizondb] reusing existing ${name} in Key Vault.`);
    return;
  }
  setSecret(env.KV_NAME, name, randomBytes(36).toString("base64url"));
  log("ok", `[horizondb] generated ${name} in Key Vault.`);
}

export function seedHorizonDbConnectionUrl(env) {
  if (!horizonDbEnabled(env)) return;
  for (const key of ["KV_NAME", "HORIZONDB_FQDN"]) {
    if (!env[key]) throw new Error(`HorizonDB connection URL requires ${key} from prior stages.`);
  }
  const password = currentSecret(env.KV_NAME, env.HORIZONDB_ADMIN_PASSWORD_SECRET_NAME || "horizondb-admin-password");
  if (!password) throw new Error("HorizonDB admin password is absent from Key Vault; run base-infra seed-secrets first.");
  const login = env.HORIZONDB_ADMIN_LOGIN || "pilotswarm";
  const database = env.HORIZONDB_DATABASE_NAME || "postgres";
  const url = `postgresql://${encodeURIComponent(login)}:${encodeURIComponent(password)}@${env.HORIZONDB_FQDN}:5432/${encodeURIComponent(database)}?sslmode=require&uselibpqcompat=true`;
  const name = env.HORIZONDB_URL_SECRET_NAME || "horizondb-url";
  if (currentSecret(env.KV_NAME, name) !== url) {
    setSecret(env.KV_NAME, name, url);
    log("ok", `[horizondb] stored ${name} in Key Vault for runtime, CMS, facts and graph.`);
  } else {
    log("info", `[horizondb] ${name} is current.`);
  }
}
