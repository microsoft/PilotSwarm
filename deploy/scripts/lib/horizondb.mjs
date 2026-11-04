// HorizonDB bootstrap for the Azure deployment provider. No credential is
// written to a rendered template, command argument, ConfigMap or log.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";
import { log, run } from "./common.mjs";
import { deploysPostgres } from "./database-env.mjs";

// HorizonDB API 2026-10-01-preview keeps compute and the settings group on a
// pool. This module and the Bicep module use one pool with a fixed name.
export const HORIZONDB_API_VERSION = "2026-10-01-preview";
export const HORIZONDB_POOL_NAME = "DefaultPool";

function horizonDbBase({ subscription, group }) {
  return `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.HorizonDb`;
}

export function horizonDbPoolUrl({ subscription, group, cluster }) {
  return `https://management.azure.com${horizonDbBase({ subscription, group })}/clusters/${cluster}/pools/${HORIZONDB_POOL_NAME}?api-version=${HORIZONDB_API_VERSION}`;
}

// True when the pool exists, false when Azure says it (or its cluster) is not
// there. Any other failure stops the deploy: guessing "absent" would send a
// pool PUT with the built-in settings group and detach the extension group.
export function horizonDbPoolExists(names, { runFn = run } = {}) {
  const result = runFn("az", ["rest", "--method", "get", "--url", horizonDbPoolUrl(names), "--output", "json"],
    { capture: true, allowFail: true });
  if (result.status === 0) return true;
  const stderr = String(result.stderr || "");
  if (/ResourceNotFound|ParentResourceNotFound|ResourceGroupNotFound/.test(stderr)) return false;
  throw new Error(`Cannot check whether the HorizonDB pool exists: ${stderr.trim().split(/\r?\n/)[0].slice(0, 300) || `exit ${result.status}`}`);
}

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

export function prepareHorizonDbEnvForRender(env, { runFn = run } = {}) {
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
  // HORIZONDB_REPLICA_COUNT is the name used before the pool API.
  env.HORIZONDB_NODE_COUNT ||= env.HORIZONDB_REPLICA_COUNT || "1";
  env.HORIZONDB_PARAMETER_GROUP_NAME ||= `${env.HORIZONDB_CLUSTER_NAME}-pg17-ext`;
  const exists = horizonDbPoolExists({
    subscription: env.SUBSCRIPTION_ID, group: env.RESOURCE_GROUP, cluster: env.HORIZONDB_CLUSTER_NAME,
  }, { runFn });
  env.HORIZONDB_POOL_CREATE = exists ? "false" : "true";
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

// A new HorizonDB pool must start on the built-in settings group, so the
// extension group is attached here, after Bicep, before the worker runs its
// extension migrations. Later deploys find it attached and return at once.
//
// While an attach runs (about two minutes, one server restart), the pool GET
// still shows the previous group as InSync, so the script waits instead of
// sending another PATCH. But the first PATCH soon after a pool is created can
// end "Succeeded" without attaching anything. So when the GET still shows
// another group four minutes after a PATCH, the PATCH is sent again (at most
// three PATCHes in all).
export const HORIZONDB_ATTACH_RESEND_POLLS = 24;
export const HORIZONDB_ATTACH_MAX_PATCHES = 3;
export async function ensureHorizonDbParameterGroup(env, {
  runFn = run,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  attempts = 90,
} = {}) {
  if (!horizonDbEnabled(env)) return;
  const { SUBSCRIPTION_ID: subscription, RESOURCE_GROUP: group, HORIZONDB_CLUSTER_NAME: cluster,
    HORIZONDB_PARAMETER_GROUP_NAME: parameterGroup } = env;
  if (!subscription || !group || !cluster || !parameterGroup) {
    throw new Error("HorizonDB parameter-group verification requires subscription, resource group, cluster and group names.");
  }
  const desiredId = `${horizonDbBase({ subscription, group })}/parameterGroups/${parameterGroup}`;
  const poolUrl = horizonDbPoolUrl({ subscription, group, cluster });
  const restartUrl = poolUrl.replace(`/pools/${HORIZONDB_POOL_NAME}?`, `/pools/${HORIZONDB_POOL_NAME}/restart?`);
  let patchesSent = 0;
  let lastPatchAttempt = -1;
  let restartRequested = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pool = JSON.parse(runFn("az", ["rest", "--method", "get", "--url", poolUrl, "--output", "json"], { capture: true }).stdout);
    const ready = pool.properties?.provisioningState === "Succeeded";
    const attached = pool.properties?.parameterGroup ?? {};
    const isDeclared = String(attached.parameterGroupResourceId || "").toLowerCase() === desiredId.toLowerCase();
    const status = attached.syncStatus;
    if (ready && isDeclared && status === "InSync") {
      log("ok", "HorizonDB pool is using its declared extension parameter group.");
      return;
    }
    if (ready && isDeclared && status === "FailedToApply" && patchesSent > 0) {
      throw new Error("HorizonDB could not apply the extension parameter group (syncStatus FailedToApply).");
    }
    if (ready && isDeclared && status === "PendingReboot" && !restartRequested) {
      // Static settings such as shared_preload_libraries wait for a restart
      // that only the customer can start.
      runFn("az", ["rest", "--method", "post", "--url", restartUrl], { capture: true });
      restartRequested = true;
      log("info", "Restarting the HorizonDB pool to apply pending extension settings.");
    } else if (ready && (!isDeclared || (status === "FailedToApply" && patchesSent === 0)) &&
        patchesSent < HORIZONDB_ATTACH_MAX_PATCHES &&
        (patchesSent === 0 || attempt - lastPatchAttempt >= HORIZONDB_ATTACH_RESEND_POLLS)) {
      // FailedToApply before this deploy's own attempt is retried once.
      if (patchesSent > 0) log("warn", "HorizonDB pool still shows another settings group four minutes after the attach request; sending it again.");
      const body = JSON.stringify({ properties: { parameterGroup: { parameterGroupResourceId: desiredId, applyMethod: "Immediate" } } });
      runFn("az", ["rest", "--method", "patch", "--url", poolUrl,
        "--headers", "Content-Type=application/json", "--body", body], { capture: true });
      patchesSent += 1;
      lastPatchAttempt = attempt;
      log("info", "Attaching the declared HorizonDB extension parameter group (about two minutes, one restart).");
    }
    await sleepFn(10000);
  }
  throw new Error("HorizonDB extension parameter group did not become active within fifteen minutes.");
}
