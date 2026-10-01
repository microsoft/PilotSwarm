import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  inlineParamsForMarker,
  resolveDevboxPrincipal,
} from "../lib/deploy-bicep.mjs";
import { computeInlineParamsHash } from "../lib/deploy-marker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

test("devbox principal is optional", () => {
  assert.equal(resolveDevboxPrincipal({}), null);
});

test("devbox principal defaults to a group", () => {
  assert.deepEqual(
    resolveDevboxPrincipal({
      DEVBOX_PRINCIPAL_ID: "principal-id",
      DEVBOX_PRINCIPAL_NAME: "PilotSwarm Developers",
    }),
    {
      id: "principal-id",
      name: "PilotSwarm Developers",
      type: "Group",
    },
  );
});

test("devbox principal requires a display name", () => {
  assert.throws(
    () => resolveDevboxPrincipal({ DEVBOX_PRINCIPAL_ID: "principal-id" }),
    /DEVBOX_PRINCIPAL_NAME is required/,
  );
});

test("devbox principal rejects unsupported principal types", () => {
  assert.throws(
    () => resolveDevboxPrincipal({
      DEVBOX_PRINCIPAL_ID: "principal-id",
      DEVBOX_PRINCIPAL_NAME: "PilotSwarm Developers",
      DEVBOX_PRINCIPAL_TYPE: "Application",
    }),
    /DEVBOX_PRINCIPAL_TYPE must be User, Group, or ServicePrincipal/,
  );
});

test("changing the devbox principal invalidates the base-infra marker input", () => {
  const first = computeInlineParamsHash(inlineParamsForMarker("base-infra", {
    DEVBOX_PRINCIPAL_ID: "group-1",
    DEVBOX_PRINCIPAL_NAME: "PilotSwarm Developers",
  }));
  const second = computeInlineParamsHash(inlineParamsForMarker("base-infra", {
    DEVBOX_PRINCIPAL_ID: "group-2",
    DEVBOX_PRINCIPAL_NAME: "PilotSwarm Developers",
  }));
  assert.notEqual(first, second);
});

test("base infrastructure grants only container-scoped blob access", () => {
  const main = readFileSync(
    resolve(repoRoot, "deploy/providers/azure/services/base-infra/bicep/main.bicep"),
    "utf8",
  );
  const storage = readFileSync(
    resolve(repoRoot, "deploy/providers/azure/services/base-infra/bicep/storage.bicep"),
    "utf8",
  );

  assert.match(main, /devboxPrincipalId:\s*devboxPrincipalId/);
  assert.match(main, /aadSecondaryAdminPrincipalId:\s*devboxPrincipalId/);
  assert.match(main, /CONTROLLED-PREVIEW SECURITY EXCEPTION/);
  assert.match(main, /not suitable as a general upstream feature/);
  assert.match(
    storage,
    /resource assignSessionBlobContributorToDevboxPrincipal[\s\S]*?scope:\s*sessionsContainer[\s\S]*?principalId:\s*devboxPrincipalId/,
  );
});
