import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(
  join(here, "..", "devbox-workflow-generator.ps1"),
  "utf8",
);

test("devbox Workflow Generator is one stamp-level service", () => {
  assert.match(script, /^#requires -Version 7\.0/);
  assert.match(
    script,
    /\[ValidateSet\('Start', 'Stop', 'Status', 'Logs', 'Validate'\)\]/,
  );
  assert.doesNotMatch(script, /RepositoryPath|PILOTSWARM_WORKER_TAGS/);
  assert.match(script, /com\.pilotswarm\.devbox\.service=workflow-generator/);
  assert.match(script, /WORKFLOW_GENERATOR_COMPUTE=devbox/);
  assert.match(script, /packages\/workflow-generator\/dist\/cli\.js/);
});

test("devbox Workflow Generator fails closed outside an owned private stamp", () => {
  assert.match(script, /privateStamp.*true/);
  assert.match(script, /DEVBOX_PRINCIPAL_ID/);
  assert.match(script, /Private stamp owner does not match/);
  assert.match(script, /Stamp mismatch: DATABASE_URL targets/);
  assert.match(script, /DEPLOY_POSTGRES/);
  assert.match(script, /BYO database configuration/);
  assert.match(script, /Stamp mismatch: active kubectl context/);
});

test("devbox Workflow Generator enforces compatible version and bounded lifecycle", () => {
  assert.match(script, /function Get-ImageTag/);
  assert.match(script, /Version mismatch: devbox image tag/);
  assert.match(script, /environmentFileHash = \(Get-FileHash/);
  assert.match(script, /modelProvidersFileHash = \(Get-FileHash/);
  assert.match(script, /Split-Path -Parent \$Config\.ModelProvidersFile/);
  assert.match(script, /Split-Path -Leaf \$Config\.ModelProvidersFile/);
  assert.match(script, /\$\{modelProvidersDirectory\}:C:\\controller-config:ro/);
  assert.match(script, /PS_MODEL_PROVIDERS_PATH=C:\\controller-config\\\$modelProvidersName/);
  assert.match(script, /stateDirectory = \$Config\.StateDirectory/);
  assert.match(script, /WORKFLOW_GENERATOR_READY_FILE=C:\\controller-state\\workflow-generator\.ready/);
  assert.match(script, /Ready = \[bool\]\([\s\S]*\$state\.Running[\s\S]*workflow-generator\.ready/);
  assert.match(script, /'container', 'stop', '--time', '30'/);
  assert.equal(script.trimEnd().endsWith("exit 0"), true);
});

test("devbox Workflow Generator uses the mounted developer Azure identity", () => {
  assert.match(script, /AZURE_CONFIG_DIR=C:\\creds/);
  assert.match(script, /\$\(\$Config\.CredentialDirectory\):C:\\creds/);
  assert.match(script, /ad', 'signed-in-user', 'show'/);
  assert.doesNotMatch(script, /WORKLOAD_IDENTITY_CLIENT_ID/);
});

test("devbox Workflow Generator can reach providers hosted on Windows", () => {
  assert.match(script, /function Get-DockerHostGateway/);
  assert.match(script, /'network', 'inspect', 'nat'/);
  assert.match(
    script,
    /'--add-host', "host\.docker\.internal:\$dockerHostGateway"/,
  );
});
