// Microsoft Entra ID sign-in for the AKS cluster API (AKS_ENTRA_ID_AUTH):
// the setting, the cluster template, the deployment principal's role, and
// the rollout's sign-in through kubelogin.
//
// Run: node --test deploy/scripts/test/aks-entra-id.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AKS_ENV_DEFAULTS, aksEntraIdAuth } from "../lib/aks-env.mjs";
import { REPO_ROOT, parseEnvFile, templateEnvPath } from "../lib/common.mjs";
import { kubeconfigUsesEntraId, prepareClusterAccess } from "../lib/wait-rollout.mjs";

const read = (path) => readFileSync(join(REPO_ROOT, path), "utf8");
const bicep = (name) => read(`deploy/providers/azure/services/base-infra/bicep/${name}`);

// What `az aks get-credentials` writes for a cluster with Entra ID sign-in,
// and for a cluster without it.
const ENTRA_KUBECONFIG = `apiVersion: v1
clusters:
- cluster:
    server: https://example.invalid:443
  name: example
users:
- name: clusterUser_example-rg_example
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      args:
      - get-token
      - --login
      - devicecode
      command: kubelogin
      env: null
`;
const CERTIFICATE_KUBECONFIG = `apiVersion: v1
users:
- name: clusterUser_example-rg_example
  user:
    client-certificate-data: ZXhhbXBsZQ==
    client-key-data: ZXhhbXBsZQ==
    token: example # a comment that names kubelogin changes nothing
`;

test("the setting is off for an env file without the key, on for a new stamp, and refuses other values", () => {
  assert.equal(AKS_ENV_DEFAULTS.AKS_ENTRA_ID_AUTH, "false");
  assert.equal(parseEnvFile(templateEnvPath()).AKS_ENTRA_ID_AUTH, "true");
  for (const [value, expected] of [["true", true], [" True ", true], ["false", false], ["", false], [undefined, false]]) {
    assert.equal(aksEntraIdAuth({ AKS_ENTRA_ID_AUTH: value }), expected, String(value));
  }
  assert.equal(aksEntraIdAuth(undefined), false);
  for (const value of ["yes", "1", "on"]) assert.throws(() => aksEntraIdAuth({ AKS_ENTRA_ID_AUTH: value }), /AKS_ENTRA_ID_AUTH must be true or false/);
});

test("the cluster template adds Entra ID sign-in only when asked, and gives the deployment principal a cluster role", () => {
  const aks = bicep("aks.bicep");
  assert.match(aks, /^param entraIdAuthEnabled bool = false$/m);
  // The block is added to the cluster's properties only when the switch is on:
  // a stamp that leaves it off sends the same cluster definition as before.
  assert.match(aks, /\}, entraIdAuthEnabled \? \{[\s\S]*?aadProfile: \{\s+managed: true\s+enableAzureRBAC: true\s+tenantID: tenant\(\)\.tenantId\s+\}\s+\} : \{\}\)/);
  assert.equal(aks.match(/aadProfile/g).length, 1);
  assert.doesNotMatch(aks, /disableLocalAccounts/);
  // Azure Kubernetes Service RBAC Cluster Admin, with the same naming rule as the other deployer roles.
  assert.match(aks, /^var aksRbacClusterAdminRoleId = 'b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b'$/m);
  assert.match(aks, /resource assignClusterAdminToDeployer [^\n]+ = if \(entraIdAuthEnabled && !empty\(deploymentPrincipalId\)\) \{\s+name: guid\(aks\.id, deploymentPrincipalId, aksRbacClusterAdminRoleId\)\s+scope: aks/);

  const main = bicep("main.bicep");
  assert.match(main, /^param aksEntraIdAuthEnabled bool = false$/m);
  assert.match(main, /entraIdAuthEnabled: aksEntraIdAuthEnabled\s+deploymentPrincipalId: localDeploymentPrincipalId\s+deploymentPrincipalType: localDeploymentPrincipalType/);
  assert.match(bicep("base-infra.params.template.json"), /"aksEntraIdAuthEnabled": \{\s+"value": \$\{AKS_ENTRA_ID_AUTH\}\s+\}/);
});

test("a kubeconfig with Entra ID sign-in is recognized; a certificate kubeconfig is not", () => {
  assert.equal(kubeconfigUsesEntraId(ENTRA_KUBECONFIG), true);
  assert.equal(kubeconfigUsesEntraId(ENTRA_KUBECONFIG.replace("command: kubelogin", 'command: "kubelogin"')), true);
  assert.equal(kubeconfigUsesEntraId(CERTIFICATE_KUBECONFIG), false);
  assert.equal(kubeconfigUsesEntraId(""), false);
});

function accessFixture(t, text, answers) {
  const dir = mkdtempSync(join(tmpdir(), "aks-entra-id-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const kubeconfigPath = join(dir, "kubeconfig");
  writeFileSync(kubeconfigPath, text);
  const calls = [];
  const sleeps = [];
  const runFn = (name, args, opts) => {
    calls.push({ name, args, opts });
    if (name === "kubelogin") return { status: 0, stdout: "", stderr: "" };
    return answers.shift() ?? { status: 1, stdout: "no\n", stderr: "" };
  };
  const kubeEnv = { KUBECONFIG: kubeconfigPath };
  const access = (extra = {}) => prepareClusterAccess({ kubeconfigPath, kubeEnv, namespace: "example-namespace", runFn,
    sleepFn: async (ms) => { sleeps.push(ms); }, attempts: 4, delayMs: 10, ...extra });
  return { access, calls, sleeps, kubeEnv, kubeconfigPath };
}

test("a cluster with Entra ID sign-in: kubectl signs in as the Azure CLI identity, and the rollout waits for its role", async (t) => {
  const f = accessFixture(t, ENTRA_KUBECONFIG, [
    { status: 1, stdout: "", stderr: "Error from server (Forbidden): the role is not active yet" },
    { status: 1, stdout: "no\n", stderr: "" },
    { status: 0, stdout: "yes\n", stderr: "" },
  ]);
  assert.equal(await f.access(), true);
  assert.deepEqual(f.calls[0], { name: "kubelogin", args: ["convert-kubeconfig", "--login", "azurecli", "--kubeconfig", f.kubeconfigPath],
    opts: { capture: true, env: f.kubeEnv } });
  const probes = f.calls.slice(1);
  assert.equal(probes.length, 3);
  for (const probe of probes) {
    assert.deepEqual(probe, { name: "kubectl", args: ["auth", "can-i", "get", "deployments", "--namespace", "example-namespace"],
      opts: { capture: true, env: f.kubeEnv, allowFail: true } });
  }
  assert.deepEqual(f.sleeps, [10, 10]);
});

test("a role that never arrives stops the rollout and names the role; a missing kubelogin gives an install hint", async (t) => {
  const denied = accessFixture(t, ENTRA_KUBECONFIG, []);
  await assert.rejects(denied.access(), (error) => {
    assert.match(error.message, /The signed-in identity has no access to the cluster/);
    assert.match(error.message, /Azure Kubernetes Service RBAC Cluster Admin/);
    assert.match(error.message, /Last answer: no/);
    return true;
  });
  assert.equal(denied.calls.filter((call) => call.name === "kubectl").length, 4);
  assert.deepEqual(denied.sleeps, [10, 10, 10]);

  const missing = accessFixture(t, ENTRA_KUBECONFIG, []);
  await assert.rejects(
    missing.access({ runFn: () => { throw new Error("Failed to spawn kubelogin: spawnSync kubelogin ENOENT\nsecond line"); } }),
    /Cannot prepare sign-in to the cluster: Failed to spawn kubelogin: spawnSync kubelogin ENOENT\nInstall hint: https:\/\/azure\.github\.io\/kubelogin/,
  );
});

test("a cluster without Entra ID sign-in is left alone: no kubelogin, no waiting", async (t) => {
  const f = accessFixture(t, CERTIFICATE_KUBECONFIG, []);
  assert.equal(await f.access(), false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.sleeps, []);
  assert.equal(readFileSync(f.kubeconfigPath, "utf8"), CERTIFICATE_KUBECONFIG);
});

test("the deploy has kubelogin: a pinned, checksummed install in the action and a tool check for local runs", () => {
  const action = read(".github/actions/deploy-azure/action.yml");
  const step = action.split("- name: Setup kubelogin")[1].split("\n    - name:")[0];
  assert.match(step, /releases\/download\/v\d+\.\d+\.\d+\/kubelogin-linux-amd64\.zip/);
  assert.match(step, /echo '[0-9a-f]{64}  '"\$RUNNER_TEMP\/kubelogin\.zip" \| sha256sum --check/);
  assert(action.indexOf("- name: Setup kubelogin") < action.indexOf("- name: Deploy\n"));
  const deploy = read("deploy/scripts/deploy.mjs");
  assert.match(deploy, /if \(aksEntraIdAuth\(ctx\.env\)\) \{\s+assertCli\(\s+"kubelogin",/);
  // The workflows pass the switch from the deploy environment's variables.
  for (const workflow of ["deploy-azure.yml", "release-tarballs.yml"]) {
    assert.match(read(`.github/workflows/${workflow}`), /^ {10}AKS_ENTRA_ID_AUTH: \$\{\{ vars\.AKS_ENTRA_ID_AUTH \}\}$/m, workflow);
  }
});
