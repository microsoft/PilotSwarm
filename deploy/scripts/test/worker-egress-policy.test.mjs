// The worker egress NetworkPolicy shipped in both worker templates: the GitOps
// worker base and the plain manifests that scripts/deploy-aks.sh applies.
//
// A Workflow script, an agent shell or a tool in the worker pod shares the
// pod's network, and Node's permission model does not limit it. The policy
// must deny the instance metadata address (169.254.169.254, which hands out the
// node's managed identity token) and keep every other egress the worker had.
//
// The checks run on the rendered objects, the same build Flux runs, and judge
// them with a small evaluator of Kubernetes egress semantics. The evaluator
// runs twice: once where an ipBlock matches pod addresses, and once where it
// does not (Cilium), so the pod and namespace selectors must carry pod traffic.
// Without kubectl the render tests skip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { REPO_ROOT } from "../lib/common.mjs";
import { stageManifests } from "../lib/stage-manifests.mjs";

const POLICY = "NetworkPolicy/copilot-runtime-worker-egress";
const IMDS = "169.254.169.254";

const kubectlWorks = spawnSync("kubectl", ["version", "--client"], { encoding: "utf8" }).status === 0;
const opts = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };

// YAML in, objects keyed by "Kind/name" out. `kubectl annotate --local` reads
// YAML and prints JSON without a cluster; removing an annotation nobody set
// leaves the objects as they were.
function toObjects(yaml) {
  const json = spawnSync("kubectl", ["annotate", "--local", "-f", "-", "-o", "json", "pilotswarm.dev/render-probe-"], {
    ...opts,
    input: yaml,
    env: { ...process.env, KUBECONFIG: "/dev/null" },
  });
  assert.equal(json.status, 0, json.stderr);
  const items = json.stdout.trim().split(/\n(?=\{\n)/).map((part) => JSON.parse(part))
    .flatMap((item) => (item.kind === "List" ? item.items : [item]));
  return Object.fromEntries(items.map((item) => [`${item.kind}/${item.metadata.name}`, item]));
}

function stampEnv() {
  return {
    EDGE_MODE: "public",
    TLS_SOURCE: "letsencrypt",
    FOUNDRY_ENDPOINT: "",
    IMAGE: "stub.azurecr.io/pilotswarm-worker:t1",
    NAMESPACE: "pilotswarm",
    KV_NAME: "stub-kv",
    WORKLOAD_IDENTITY_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
    AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
    PORTAL_HOSTNAME: "stub.example.com",
    PILOTSWARM_USE_MANAGED_IDENTITY: "1",
    AZURE_STORAGE_ACCOUNT_URL: "https://stub.blob.core.windows.net/",
    AZURE_STORAGE_CONTAINER: "copilot-sessions",
    PILOTSWARM_TURN_TIMEOUT_MS: "2700000",
    PILOTSWARM_LIVE_TURN: "0",
    PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgresql://u@h:5432/d?sslmode=require",
    PILOTSWARM_DB_AAD_USER: "stub",
    DATABASE_URL: "postgresql://u@h:5432/d?sslmode=require",
  };
}

function renderGitopsWorker(t) {
  if (!kubectlWorks) {
    t.skip("kubectl is not installed");
    return null;
  }
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-egress-stage-"));
  t.after(() => rmSync(stagingDir, { recursive: true, force: true }));
  const worker = stageManifests({ service: "worker", envName: "testenv", env: stampEnv(), stagingDir });
  const built = spawnSync("kubectl", ["kustomize", join(worker, "overlays/default")], opts);
  assert.equal(built.status, 0, built.stderr);
  return toObjects(built.stdout);
}

// What scripts/deploy-aks.sh applies: the file with its namespace substituted.
function renderPlainManifest(t, file, namespace) {
  if (!kubectlWorks) {
    t.skip("kubectl is not installed");
    return null;
  }
  const text = readFileSync(join(REPO_ROOT, file), "utf8").replaceAll("namespace: copilot-runtime", `namespace: ${namespace}`);
  return toObjects(text);
}

// ── A small evaluator of NetworkPolicy egress ─────────────────────

function ipv4(text) {
  const parts = text.split(".").map(Number);
  assert.equal(parts.length, 4, `not an IPv4 address: ${text}`);
  return parts.reduce((acc, part) => acc * 256 + part, 0);
}

function inCidr(ip, cidr) {
  const [base, bits] = cidr.split("/");
  const prefix = Number(bits);
  if (base.includes(":")) {
    // The policies here use only ::/0 for IPv6.
    assert.equal(prefix, 0, `IPv6 prefix other than ::/0 is not modeled: ${cidr}`);
    return ip.includes(":");
  }
  if (ip.includes(":")) return false;
  if (prefix === 0) return true;
  const size = 2 ** (32 - prefix);
  return Math.floor(ipv4(ip) / size) === Math.floor(ipv4(base) / size);
}

const selectsAll = (selector) => selector
  && Object.keys(selector.matchLabels ?? {}).length === 0
  && (selector.matchExpressions ?? []).length === 0;

// A destination is { ip, port, protocol } plus, for a pod, { pod: { namespace } }.
function peerMatches(peer, dest, policyNamespace, { ipBlockMatchesPods }) {
  if (peer.ipBlock) {
    if (dest.pod && !ipBlockMatchesPods) return false;
    if (!inCidr(dest.ip, peer.ipBlock.cidr)) return false;
    return !(peer.ipBlock.except ?? []).some((cidr) => inCidr(dest.ip, cidr));
  }
  if (!dest.pod) return false;
  // Only empty selectors are modeled: the policies here select every pod.
  if (peer.namespaceSelector) {
    assert.ok(selectsAll(peer.namespaceSelector), "only an empty namespaceSelector is modeled");
    return peer.podSelector ? selectsAll(peer.podSelector) : true;
  }
  assert.ok(selectsAll(peer.podSelector), "only an empty podSelector is modeled");
  return dest.pod.namespace === policyNamespace;
}

function portMatches(port, dest) {
  return (port.protocol ?? "TCP") === dest.protocol && (port.port === undefined || port.port === dest.port);
}

function allowsEgress(policy, dest, mode) {
  return (policy.spec.egress ?? []).some((rule) => {
    const portsOk = !rule.ports?.length || rule.ports.some((port) => portMatches(port, dest));
    const peersOk = !rule.to?.length || rule.to.some((peer) => peerMatches(peer, dest, policy.metadata.namespace, mode));
    return portsOk && peersOk;
  });
}

const MODES = [
  ["an ipBlock matches pod addresses", { ipBlockMatchesPods: true }],
  ["an ipBlock does not match pod addresses (Cilium)", { ipBlockMatchesPods: false }],
];

const DENIED = [
  ["instance metadata, HTTP", { ip: IMDS, port: 80, protocol: "TCP" }],
  ["instance metadata, HTTPS", { ip: IMDS, port: 443, protocol: "TCP" }],
];

const ALLOWED = [
  ["the internet, HTTPS", { ip: "20.1.2.3", port: 443, protocol: "TCP" }],
  ["a model endpoint over IPv6", { ip: "2603:1030::1", port: 443, protocol: "TCP" }],
  ["Postgres on a private address", { ip: "10.20.30.40", port: 5432, protocol: "TCP" }],
  ["Azure DNS", { ip: "168.63.129.16", port: 53, protocol: "UDP" }],
  ["a node-local DNS cache", { ip: "169.254.20.10", port: 53, protocol: "UDP" }],
  ["the address next to the metadata address", { ip: "169.254.169.253", port: 80, protocol: "TCP" }],
  ["cluster DNS in kube-system", { ip: "10.244.1.10", port: 53, protocol: "UDP", pod: { namespace: "kube-system" } }],
  ["the repo service in the worker's namespace", { ip: "10.244.2.20", port: 8080, protocol: "TCP", pod: { namespace: "SELF" } }],
  ["a pod in another namespace", { ip: "10.244.3.30", port: 9000, protocol: "TCP", pod: { namespace: "other" } }],
];

function assertPolicy(policy, deployment) {
  assert.ok(policy, "the worker egress NetworkPolicy is rendered");
  assert.equal(policy.metadata.namespace, deployment.metadata.namespace, "the policy sits in the worker's namespace");
  assert.deepEqual(policy.spec.policyTypes, ["Egress"], "egress only: ingress is not restricted");
  const podLabels = deployment.spec.template.metadata.labels;
  for (const [key, value] of Object.entries(policy.spec.podSelector.matchLabels)) {
    assert.equal(podLabels[key], value, `the policy selects the worker pods (${key})`);
  }
  for (const [modeName, mode] of MODES) {
    for (const [name, dest] of DENIED) {
      assert.equal(allowsEgress(policy, dest, mode), false, `${name} is denied when ${modeName}`);
    }
    for (const [name, raw] of ALLOWED) {
      const dest = raw.pod?.namespace === "SELF" ? { ...raw, pod: { namespace: policy.metadata.namespace } } : raw;
      assert.equal(allowsEgress(policy, dest, mode), true, `${name} is allowed when ${modeName}`);
    }
  }
}

test("the evaluator: a worker without an egress policy reaches the metadata address", () => {
  // Kubernetes: a pod no Egress policy selects has all egress; an Egress policy
  // with no rules denies all. Both ends anchor the checks above.
  const none = { metadata: { namespace: "pilotswarm" }, spec: { egress: [{}] } };
  assert.equal(allowsEgress(none, { ip: IMDS, port: 80, protocol: "TCP" }, MODES[0][1]), true);
  const denyAll = { metadata: { namespace: "pilotswarm" }, spec: { egress: [] } };
  assert.equal(allowsEgress(denyAll, { ip: "20.1.2.3", port: 443, protocol: "TCP" }, MODES[0][1]), false);
});

test("GitOps worker: the rendered policy denies the metadata address and keeps all other egress", (t) => {
  const objects = renderGitopsWorker(t);
  if (!objects) return;
  const deployment = objects["Deployment/copilot-runtime-worker"];
  assertPolicy(objects[POLICY], deployment);
  // The worker authenticates without the metadata address: workload identity
  // on the pod and the identity's client id on its service account.
  assert.equal(deployment.spec.template.metadata.labels["azure.workload.identity/use"], "true");
  const account = objects[`ServiceAccount/${deployment.spec.template.spec.serviceAccountName}`];
  assert.equal(account.metadata.annotations["azure.workload.identity/client-id"], "00000000-0000-0000-0000-000000000000");
  // The CSI driver fetches Key Vault secrets with the same workload identity.
  const spc = Object.entries(objects).find(([key]) => key.startsWith("SecretProviderClass/"))[1];
  assert.equal(spc.spec.parameters.usePodIdentity, "false");
  assert.equal(spc.spec.parameters.clientID, "00000000-0000-0000-0000-000000000000");
  assert.ok(!("useVMManagedIdentity" in spc.spec.parameters) || spc.spec.parameters.useVMManagedIdentity === "false");
});

test("deploy/k8s: scripts/deploy-aks.sh applies the same policy in the worker's namespace", (t) => {
  const policyObjects = renderPlainManifest(t, "deploy/k8s/worker-network-policy.yaml", "ps-ns");
  if (!policyObjects) return;
  const deployment = renderPlainManifest(t, "deploy/k8s/worker-deployment.yaml", "ps-ns")["Deployment/copilot-runtime-worker"];
  assertPolicy(policyObjects[POLICY], deployment);
  assert.equal(policyObjects[POLICY].metadata.namespace, "ps-ns");

  // The two copies say the same thing.
  const gitops = renderGitopsWorker(t)[POLICY];
  assert.deepEqual(policyObjects[POLICY].spec, gitops.spec);

  // The script applies it, rendered like the Deployment, right after it.
  const script = readFileSync(join(REPO_ROOT, "scripts/deploy-aks.sh"), "utf8");
  const deployLine = 'render_manifest deploy/k8s/worker-deployment.yaml | "${KUBECTL[@]}" apply -f -';
  const policyLine = 'render_manifest deploy/k8s/worker-network-policy.yaml | "${KUBECTL[@]}" apply -f -';
  assert.ok(script.includes(policyLine), "deploy-aks.sh applies the worker egress policy");
  assert.ok(script.indexOf(policyLine) > script.indexOf(deployLine), "after the worker Deployment");
  // The plain worker gets its credentials from the Secret, not from the node.
  assert.deepEqual(deployment.spec.template.spec.containers[0].envFrom, [{ secretRef: { name: "copilot-runtime-secrets" } }]);
});
