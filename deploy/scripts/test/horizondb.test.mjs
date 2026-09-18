import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateHorizonDbConfig, ensureHorizonDbParameterGroup } from "../lib/horizondb.mjs";
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

test("existing HorizonDB cluster is attached to its extension group before deployment continues", async () => {
  const env = horizonEnv({
    SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000003",
    RESOURCE_GROUP: "stamp-rg", HORIZONDB_CLUSTER_NAME: "stamp-hdb",
    HORIZONDB_PARAMETER_GROUP_NAME: "stamp-extensions",
  });
  const states = [
    { provisioningState: "Succeeded", parameterGroup: { id: "default_pg17", syncStatus: "InSync" } },
    { provisioningState: "Updating", parameterGroup: { id: "default_pg17", syncStatus: "PendingReplace" } },
    { provisioningState: "Succeeded", parameterGroup: { id: "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/stamp-rg/providers/Microsoft.HorizonDb/parameterGroups/stamp-extensions", syncStatus: "InSync" } },
  ];
  const calls = [];
  await ensureHorizonDbParameterGroup(env, {
    runFn: (_name, args) => {
      calls.push(args);
      return args.includes("patch") ? { stdout: "" } : { stdout: JSON.stringify({ properties: states.shift() }) };
    },
    sleepFn: async () => {},
  });
  const patches = calls.filter((args) => args.includes("patch"));
  assert.equal(patches.length, 1);
  const body = JSON.parse(patches[0][patches[0].indexOf("--body") + 1]);
  assert.equal(body.properties.parameterGroup.applyImmediately, true);
  assert.match(body.properties.parameterGroup.id, /parameterGroups\/stamp-extensions$/);
});
