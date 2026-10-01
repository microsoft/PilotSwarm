// Tests for the seed-secrets KV clobber-guard.
//
// The guard: an optional `seedEmpty` secret that is BLANK in the env map must
// NOT overwrite a real value already stored in Key Vault with the unset
// sentinel. A blank env means "leave whatever KV holds".
//
// Run: node --test deploy/scripts/test/seed-secrets.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { seedSecrets, SEED_SECRETS_UNSET_SENTINEL } from "../lib/seed-secrets.mjs";

// Build a fake `run` that answers `keyvault secret show` from `kvState`
// (kvKey → current value; the string "__ERROR__" simulates an ambiguous read
// failure; a missing key simulates a positively-absent secret) and records
// every `keyvault secret set` call.
function makeFakeRun(kvState = {}) {
  const sets = [];
  const run = (name, args) => {
    const nameOf = () => {
      const i = args.indexOf("--name");
      return i >= 0 ? args[i + 1] : undefined;
    };
    if (name === "az" && args[0] === "keyvault" && args[1] === "secret" && args[2] === "show") {
      const key = nameOf();
      const val = kvState[key];
      if (val === "__ERROR__") return { status: 1, stdout: "", stderr: "ERROR: (Forbidden) Caller is not authorized to perform action on resource." };
      if (val === undefined) return { status: 3, stdout: "", stderr: `ERROR: (SecretNotFound) A secret with (name/id) ${key} was not found in this key vault.` };
      return { status: 0, stdout: `${val}\n`, stderr: "" };
    }
    if (name === "az" && args[0] === "keyvault" && args[1] === "secret" && args[2] === "set") {
      const valIdx = args.indexOf("--value");
      sets.push({ key: nameOf(), value: args[valIdx + 1] });
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, sets };
}

const baseEnv = { KV_NAME: "kvtest" };
const setFor = (sets, key) => sets.find((s) => s.key === key);

test("blank seedEmpty secret preserves an existing real KV value (no clobber)", async () => {
  const { run, sets } = makeFakeRun({ "github-token": "a-real-token-value" });
  await seedSecrets({ envName: "example", env: { ...baseEnv, GITHUB_TOKEN: "" } }, { run });
  assert.equal(setFor(sets, "github-token"), undefined, "must not overwrite an existing token");
});

test("blank seedEmpty secret writes sentinel when KV holds the sentinel", async () => {
  const { run, sets } = makeFakeRun({ "github-token": SEED_SECRETS_UNSET_SENTINEL });
  await seedSecrets({ envName: "example", env: { ...baseEnv, GITHUB_TOKEN: "" } }, { run });
  assert.deepEqual(setFor(sets, "github-token"), { key: "github-token", value: SEED_SECRETS_UNSET_SENTINEL });
});

test("blank seedEmpty secret writes sentinel when KV secret is missing", async () => {
  const { run, sets } = makeFakeRun({}); // show returns positively-absent
  await seedSecrets({ envName: "example", env: { ...baseEnv, GITHUB_TOKEN: "" } }, { run });
  assert.deepEqual(setFor(sets, "github-token"), { key: "github-token", value: SEED_SECRETS_UNSET_SENTINEL });
});

test("blank seedEmpty secret does NOT write when the KV read fails ambiguously", async () => {
  const { run, sets } = makeFakeRun({ "github-token": "__ERROR__" });
  await seedSecrets({ envName: "example", env: { ...baseEnv, GITHUB_TOKEN: "" } }, { run });
  assert.equal(setFor(sets, "github-token"), undefined, "must not clobber on an ambiguous read failure");
});

test("a provided secret is written verbatim regardless of KV state", async () => {
  const { run, sets } = makeFakeRun({ "github-token": SEED_SECRETS_UNSET_SENTINEL });
  await seedSecrets({ envName: "example", env: { ...baseEnv, GITHUB_TOKEN: "provided-token" } }, { run });
  assert.deepEqual(setFor(sets, "github-token"), { key: "github-token", value: "provided-token" });
});

test("legacy Git PAT is not part of deployment secret seeding", async () => {
  const { run, sets } = makeFakeRun({});
  await seedSecrets({
    envName: "example",
    env: { ...baseEnv, GIT_CACHE_ADO_PAT: "must-not-be-seeded" },
  }, { run });
  assert.equal(setFor(sets, "git-cache-ado-pat"), undefined);
});
