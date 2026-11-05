import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateHorizonDbConfig, ensureHorizonDbParameterGroup, prepareHorizonDbEnvForRender, horizonDbPoolExists,
} from "../lib/horizondb.mjs";
import { composeDerivedEnv } from "../lib/compose-env.mjs";
import { stageDatabaseSecrets } from "../lib/database-secrets.mjs";

const version = "a".repeat(32);
function horizonEnv(extra = {}) {
  return {
    EDGE_MODE: "public", DEPLOY_POSTGRES: "false", HORIZONDB_ENABLED: "true",
    PILOTSWARM_USE_MANAGED_IDENTITY: "0", FOUNDRY_ENABLED: "true",
    FOUNDRY_ENDPOINT: "https://stamp.cognitiveservices.azure.com/",
    DATABASE_URL_SECRET_NAME: "horizondb-url",
    PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_NAME: "horizondb-url",
    DATABASE_URL_SECRET_VERSION: version,
    PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_VERSION: version,
    KV_NAME: "stamp-vault", WORKLOAD_IDENTITY_CLIENT_ID: "00000000-0000-0000-0000-000000000001",
    AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000002",
    ...extra,
  };
}

test("HorizonDB stamp pins one Key Vault URL for runtime, CMS, facts and graph", () => {
  const env = horizonEnv();
  assert.doesNotThrow(() => validateHorizonDbConfig(env));
  composeDerivedEnv(env);
  assert.equal(env.HORIZON_EMBED_URL, "https://stamp.cognitiveservices.azure.com/openai/v1/embeddings");

  const root = mkdtempSync(join(tmpdir(), "pilotswarm-hdb-projection-"));
  try {
    const overlay = join(root, "overlays", "default");
    mkdirSync(overlay, { recursive: true });
    writeFileSync(join(overlay, "kustomization.yaml"), "components:\n  - ../../components/worker-replacements\n");
    stageDatabaseSecrets({ service: "worker", env, stagedServiceRoot: root, overlayName: "default" });
    const spc = JSON.parse(readFileSync(join(root, "components", "database-secrets", "secret-provider-class.yaml"), "utf8"));
    const keys = spc.spec.secretObjects[0].data.map(({ key }) => key);
    assert.deepEqual(keys, ["DATABASE_URL", "PILOTSWARM_CMS_FACTS_DATABASE_URL", "HORIZON_DATABASE_URL", "HORIZON_GRAPH_DATABASE_URL"]);
    assert.equal(new Set(spc.spec.secretObjects[0].data.map(({ objectName }) => objectName)).size, 4);
    assert.equal((spc.spec.parameters.objects.match(/objectVersion: a{32}/g) || []).length, 4);
    assert.equal((spc.spec.parameters.objects.match(/objectName: horizondb-url/g) || []).length, 4);
    const patch = readFileSync(join(root, "components", "database-secrets", "kustomization.yaml"), "utf8");
    assert.ok(!patch.includes("postgresql://"), "database credentials must stay out of staged manifests");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HorizonDB stamp fails closed on a mismatched database or unbounded public access", () => {
  for (const change of [
    { EDGE_MODE: "afd" },
    { DEPLOY_POSTGRES: "true" },
    { PILOTSWARM_USE_MANAGED_IDENTITY: "1" },
    { DATABASE_URL_SECRET_NAME: "other-url" },
    { FOUNDRY_ENABLED: "false" },
    { DATABASE_URL: "postgresql://user:private@host.invalid/postgres" },
  ]) {
    assert.throws(() => validateHorizonDbConfig(horizonEnv(change)));
  }
});

const stampGroupId = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/stamp-rg/providers/Microsoft.HorizonDb/parameterGroups/stamp-extensions";
const builtInGroupId = "/subscriptions/00000000-0000-0000-0000-000000000003/providers/Microsoft.HorizonDb/locations/region/parameterGroups/default_pg17";
const stampNames = {
  SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000003",
  RESOURCE_GROUP: "stamp-rg", HORIZONDB_CLUSTER_NAME: "stamp-hdb",
  HORIZONDB_PARAMETER_GROUP_NAME: "stamp-extensions",
};

// Plays back pool GET results in order and records every az rest call.
function fakePoolApi(poolStates) {
  const calls = [];
  const runFn = (_name, args) => {
    const method = args[args.indexOf("--method") + 1];
    calls.push({ method, url: args[args.indexOf("--url") + 1], body: args.includes("--body") ? JSON.parse(args[args.indexOf("--body") + 1]) : undefined });
    if (method !== "get") return { status: 0, stdout: "" };
    const [provisioningState, parameterGroupResourceId, syncStatus] = poolStates.length > 1 ? poolStates.shift() : poolStates[0];
    return { status: 0, stdout: JSON.stringify({ properties: { provisioningState, parameterGroup: { parameterGroupResourceId, syncStatus } } }) };
  };
  return { calls, runFn };
}

test("a new pool on the built-in group gets one attach request and the deploy waits for the declared group", async () => {
  // The pool GET shows the previous group as InSync while the attach runs.
  const { calls, runFn } = fakePoolApi([
    ["Succeeded", builtInGroupId, "InSync"],
    ["Succeeded", builtInGroupId, "InSync"],
    ["Updating", builtInGroupId, "InSync"],
    ["Succeeded", builtInGroupId, "InSync"],
    ["Succeeded", stampGroupId, "InSync"],
  ]);
  await ensureHorizonDbParameterGroup(horizonEnv(stampNames), { runFn, sleepFn: async () => {} });
  const patches = calls.filter((c) => c.method === "patch");
  assert.equal(patches.length, 1, "a second PATCH would start another attach");
  assert.match(patches[0].url, /\/clusters\/stamp-hdb\/pools\/DefaultPool\?api-version=2026-10-01-preview$/);
  assert.deepEqual(patches[0].body, { properties: { parameterGroup: { parameterGroupResourceId: stampGroupId, applyMethod: "Immediate" } } });
  assert.equal(calls.filter((c) => c.method === "get").length, 5);
});

test("a PATCH that ends without attaching is sent again after four minutes, at most three times", async () => {
  // Seen on a new pool: the first PATCH ends "Succeeded" and the pool stays on the built-in group.
  const dropped = fakePoolApi([...Array(25).fill(["Succeeded", builtInGroupId, "InSync"]), ["Succeeded", stampGroupId, "InSync"]]);
  await ensureHorizonDbParameterGroup(horizonEnv(stampNames), { runFn: dropped.runFn, sleepFn: async () => {} });
  const order = dropped.calls.map((c) => c.method);
  assert.equal(order.filter((m) => m === "patch").length, 2);
  assert.equal(order.indexOf("patch", order.indexOf("patch") + 1) - order.indexOf("patch"), 25, "resend comes 24 polls (four minutes) later");

  const never = fakePoolApi([["Succeeded", builtInGroupId, "InSync"]]);
  await assert.rejects(
    ensureHorizonDbParameterGroup(horizonEnv(stampNames), { runFn: never.runFn, sleepFn: async () => {} }),
    /did not become active within fifteen minutes/,
  );
  assert.equal(never.calls.filter((c) => c.method === "patch").length, 3);
});

test("an attached group that is InSync needs no change", async () => {
  const { calls, runFn } = fakePoolApi([["Succeeded", stampGroupId.toUpperCase(), "InSync"]]);
  await ensureHorizonDbParameterGroup(horizonEnv(stampNames), { runFn, sleepFn: async () => {} });
  assert.deepEqual(calls.map((c) => c.method), ["get"]);
});

test("settings that wait for a restart get one pool restart", async () => {
  const { calls, runFn } = fakePoolApi([
    ["Succeeded", stampGroupId, "PendingReboot"],
    ["Updating", stampGroupId, "PendingReboot"],
    ["Succeeded", stampGroupId, "InSync"],
  ]);
  await ensureHorizonDbParameterGroup(horizonEnv(stampNames), { runFn, sleepFn: async () => {} });
  const posts = calls.filter((c) => c.method === "post");
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/pools\/DefaultPool\/restart\?api-version=2026-10-01-preview$/);
  assert.equal(calls.filter((c) => c.method === "patch").length, 0);
});

test("a FailedToApply left by an earlier deploy is retried once, then reported", async () => {
  const retried = fakePoolApi([
    ["Succeeded", stampGroupId, "FailedToApply"],
    ["Succeeded", stampGroupId, "Applying"],
    ["Succeeded", stampGroupId, "InSync"],
  ]);
  await ensureHorizonDbParameterGroup(horizonEnv(stampNames), { runFn: retried.runFn, sleepFn: async () => {} });
  assert.equal(retried.calls.filter((c) => c.method === "patch").length, 1);

  const failed = fakePoolApi([
    ["Succeeded", stampGroupId, "FailedToApply"],
    ["Succeeded", stampGroupId, "Applying"],
    ["Succeeded", stampGroupId, "FailedToApply"],
  ]);
  await assert.rejects(
    ensureHorizonDbParameterGroup(horizonEnv(stampNames), { runFn: failed.runFn, sleepFn: async () => {} }),
    /syncStatus FailedToApply/,
  );
  assert.equal(failed.calls.filter((c) => c.method === "patch").length, 1);
});

test("the wait has a limit", async () => {
  const { runFn } = fakePoolApi([["Succeeded", builtInGroupId, "InSync"]]);
  await assert.rejects(
    ensureHorizonDbParameterGroup(horizonEnv(stampNames), { runFn, sleepFn: async () => {}, attempts: 3 }),
    /did not become active within fifteen minutes/,
  );
});

test("pool lookup: present, absent, or an error that stops the deploy", () => {
  const names = { subscription: "s", group: "g", cluster: "c" };
  const answer = (status, stderr = "") => ({ runFn: () => ({ status, stdout: "{}", stderr }) });
  assert.equal(horizonDbPoolExists(names, answer(0)), true);
  assert.equal(horizonDbPoolExists(names, answer(3, 'ERROR: Not Found({"error":{"code":"ResourceNotFound"}})')), false);
  assert.equal(horizonDbPoolExists(names, answer(3, 'ERROR: Not Found({"error":{"code":"ResourceGroupNotFound"}})')), false);
  assert.throws(() => horizonDbPoolExists(names, answer(1, "ERROR: (AuthorizationFailed) no access")), /Cannot check whether the HorizonDB pool exists: ERROR: \(AuthorizationFailed\)/);
});

test("render env: pool flag follows the live pool and the old replica setting still sets the node count", () => {
  const base = {
    HORIZONDB_ENABLED: "true", SUBSCRIPTION_ID: "s", RESOURCE_GROUP: "g", RESOURCE_PREFIX: "stamp",
    KV_NAME: "kv", AKS_OUTBOUND_IP: "203.0.113.7",
  };
  const missing = { ...base, HORIZONDB_REPLICA_COUNT: "2" };
  prepareHorizonDbEnvForRender(missing, { runFn: () => ({ status: 3, stderr: "ResourceNotFound" }) });
  assert.equal(missing.HORIZONDB_POOL_CREATE, "true");
  assert.equal(missing.HORIZONDB_NODE_COUNT, "2");
  assert.equal(missing.HORIZONDB_CLUSTER_NAME, "stamp-hdb");
  assert.equal(missing.HORIZONDB_PARAMETER_GROUP_NAME, "stamp-hdb-pg17-ext");

  const present = { ...base };
  let url;
  prepareHorizonDbEnvForRender(present, { runFn: (_n, args) => { url = args[args.indexOf("--url") + 1]; return { status: 0, stdout: "{}" }; } });
  assert.equal(present.HORIZONDB_POOL_CREATE, "false");
  assert.equal(present.HORIZONDB_NODE_COUNT, "1");
  assert.match(url, /\/clusters\/stamp-hdb\/pools\/DefaultPool\?api-version=2026-10-01-preview$/);
});
