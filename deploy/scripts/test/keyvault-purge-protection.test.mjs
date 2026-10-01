import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inlineParamsForMarker,
  resolveKeyVaultPurgeProtection,
} from "../lib/deploy-bicep.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

test("Key Vault purge protection remains default-on when unset", () => {
  assert.equal(resolveKeyVaultPurgeProtection({}), null);
  assert.deepEqual(inlineParamsForMarker("base-infra", {}), []);
});

test("Key Vault purge protection accepts explicit booleans", () => {
  assert.equal(resolveKeyVaultPurgeProtection({
    KEY_VAULT_PURGE_PROTECTION_ENABLED: "true",
  }), true);
  assert.equal(resolveKeyVaultPurgeProtection({
    KEY_VAULT_PURGE_PROTECTION_ENABLED: "false",
  }), false);
  assert.deepEqual(
    inlineParamsForMarker("base-infra", {
      KEY_VAULT_PURGE_PROTECTION_ENABLED: "false",
    }),
    [{ param: "keyVaultPurgeProtectionEnabled", value: "false" }],
  );
});

test("Key Vault purge protection rejects invalid values", () => {
  assert.throws(
    () => resolveKeyVaultPurgeProtection({
      KEY_VAULT_PURGE_PROTECTION_ENABLED: "sometimes",
    }),
    /must be one of/,
  );
});

test("BaseInfra passes purge protection explicitly to Key Vault", () => {
  const main = readFileSync(
    resolve(repoRoot, "deploy/providers/azure/services/base-infra/bicep/main.bicep"),
    "utf8",
  );
  const keyVault = readFileSync(
    resolve(repoRoot, "deploy/providers/azure/services/base-infra/bicep/keyvault.bicep"),
    "utf8",
  );

  assert.match(main, /param keyVaultPurgeProtectionEnabled bool = true/);
  assert.match(main, /purgeProtectionEnabled:\s*keyVaultPurgeProtectionEnabled/);
  assert.match(keyVault, /param purgeProtectionEnabled bool = true/);
  assert.match(keyVault, /purgeProtectionEnabled\s*\?\s*\{/);
  assert.match(keyVault, /enablePurgeProtection:\s*true/);
  assert.doesNotMatch(keyVault, /enablePurgeProtection:\s*purgeProtectionEnabled/);
});
