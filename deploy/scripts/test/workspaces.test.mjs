// The session-workspaces switch (lib/workspaces.mjs) and the Kubernetes
// objects it ships: the repo-cache service, and the `workspaces` component the
// staged worker and portal overlays get when WORKSPACES_ENABLED=true.
//
// The render tests run `kubectl kustomize` on the staged trees, the same build
// Flux runs, and check the objects, not the YAML text. Without kubectl they skip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { REPO_ROOT } from "../lib/common.mjs";
import { stageManifests } from "../lib/stage-manifests.mjs";
import { workspacesEnabled, WORKSPACES_ENV_DEFAULTS } from "../lib/workspaces.mjs";

const COMPONENT_LINE = "  - ../../components/workspaces";
const PORTAL_OVERLAYS = [
  ["afd", "letsencrypt", "afd-letsencrypt"],
  ["afd", "akv", "afd-akv"],
  ["private", "akv", "private-akv"],
  ["public", "letsencrypt", "public-letsencrypt"],
];

function stampEnv(extra = {}) {
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
    DATABASE_URL: "postgresql://u:p@h:5432/d?sslmode=require",
    PORTAL_AUTH_PROVIDER: "none",
    PORTAL_AUTH_ENTRA_TENANT_ID: "00000000-0000-0000-0000-000000000000",
    PORTAL_AUTH_ENTRA_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
    PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "false",
    PORTAL_AUTH_ENTRA_ADMIN_GROUPS: "__PS_UNSET__",
    PORTAL_AUTH_ENTRA_USER_GROUPS: "__PS_UNSET__",
    PORTAL_AUTHZ_DEFAULT_ROLE: "viewer",
    PORTAL_AUTHZ_ADMIN_GROUPS: "__PS_UNSET__",
    PORTAL_AUTHZ_USER_GROUPS: "__PS_UNSET__",
    ...extra,
  };
}

// A bring-your-own database adds the database-secrets component to the same
// components list; the two insertions must both land.
function byoEnv(extra = {}) {
  return stampEnv({
    DEPLOY_POSTGRES: "false",
    PILOTSWARM_USE_MANAGED_IDENTITY: "0",
    PILOTSWARM_DB_AAD_USER: undefined,
    DATABASE_URL: "postgresql://u:x@shared.invalid:5432/d?sslmode=require",
    PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgresql://u:x@shared.invalid:5432/d?sslmode=require",
    DATABASE_URL_SECRET_VERSION: "a".repeat(32),
    PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_VERSION: "b".repeat(32),
    ...extra,
  });
}

function stage(t, service, env) {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-workspaces-stage-"));
  t.after(() => rmSync(stagingDir, { recursive: true, force: true }));
  return stageManifests({ service, envName: "testenv", env, stagingDir });
}

const kubectlWorks = spawnSync("kubectl", ["version", "--client"], { encoding: "utf8" }).status === 0;

// Renders one overlay directory; objects keyed by "Kind/name".
//
// `kubectl kustomize` writes YAML only, and this suite uses no npm packages.
// `kubectl annotate --local` reads YAML and prints JSON without a cluster; it
// removes an annotation nobody sets, so the objects come out unchanged (bar an
// empty `metadata.annotations`). It prints one pretty object after another; a
// line that is exactly "{" starts each, since JSON strings hold no raw newline.
function render(t, overlayDir) {
  if (!kubectlWorks) {
    t.skip("kubectl is not installed");
    return null;
  }
  const opts = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  const built = spawnSync("kubectl", ["kustomize", overlayDir], opts);
  assert.equal(built.status, 0, built.stderr);
  const json = spawnSync("kubectl", ["annotate", "--local", "-f", "-", "-o", "json", "pilotswarm.dev/render-probe-"], {
    ...opts,
    input: built.stdout,
    env: { ...process.env, KUBECONFIG: "/dev/null" },
  });
  assert.equal(json.status, 0, json.stderr);
  const items = json.stdout.trim().split(/\n(?=\{\n)/).map((text) => JSON.parse(text));
  assert.equal(items.length, (built.stdout.match(/^kind: /gm) ?? []).length, "every rendered object came back");
  return Object.fromEntries(items.map((item) => [`${item.kind}/${item.metadata.name}`, item]));
}

const container = (deployment, name) => deployment.spec.template.spec.containers.find((c) => c.name === name);
const envOf = (c) => Object.fromEntries((c.env ?? []).map((e) => [e.name, e.value]));
const byName = (list, name) => (list ?? []).find((entry) => entry.name === name);
const hashed = (objects, kind, prefix) => Object.keys(objects).find((key) => key.startsWith(`${kind}/${prefix}-`));

test("workspacesEnabled: only true and false, default off", () => {
  assert.equal(workspacesEnabled({ WORKSPACES_ENABLED: "true" }), true);
  assert.equal(workspacesEnabled({ WORKSPACES_ENABLED: " TRUE " }), true);
  assert.equal(workspacesEnabled({ WORKSPACES_ENABLED: "false" }), false);
  assert.equal(workspacesEnabled({ WORKSPACES_ENABLED: "" }), false);
  assert.equal(workspacesEnabled({}), false);
  assert.equal(WORKSPACES_ENV_DEFAULTS.WORKSPACES_ENABLED, "false");
  // A typo must not silently mean "off".
  assert.throws(() => workspacesEnabled({ WORKSPACES_ENABLED: "yes" }), /WORKSPACES_ENABLED must be true or false/);
  assert.throws(() => workspacesEnabled({ WORKSPACES_ENABLED: "1" }), /WORKSPACES_ENABLED must be true or false/);
});

for (const value of [undefined, "false"]) {
  test(`WORKSPACES_ENABLED=${value ?? "(unset)"}: no staged overlay gets the component`, (t) => {
    const extra = value === undefined ? {} : { WORKSPACES_ENABLED: value };
    const worker = stage(t, "worker", stampEnv(extra));
    assert.ok(!readFileSync(join(worker, "overlays/default/kustomization.yaml"), "utf8").includes(COMPONENT_LINE));
    for (const [edge, tls, overlay] of PORTAL_OVERLAYS) {
      const portal = stage(t, "portal", stampEnv({ EDGE_MODE: edge, TLS_SOURCE: tls, ...extra }));
      assert.ok(!readFileSync(join(portal, "overlays", overlay, "kustomization.yaml"), "utf8").includes(COMPONENT_LINE), overlay);
    }
  });
}

test("WORKSPACES_ENABLED=true: the worker and every portal overlay get the component once", (t) => {
  const on = { WORKSPACES_ENABLED: "true" };
  const worker = stage(t, "worker", stampEnv(on));
  const text = readFileSync(join(worker, "overlays/default/kustomization.yaml"), "utf8");
  assert.equal(text.split(COMPONENT_LINE).length - 1, 1);
  for (const [edge, tls, overlay] of PORTAL_OVERLAYS) {
    const portal = stage(t, "portal", stampEnv({ EDGE_MODE: edge, TLS_SOURCE: tls, ...on }));
    const portalText = readFileSync(join(portal, "overlays", overlay, "kustomization.yaml"), "utf8");
    assert.equal(portalText.split(COMPONENT_LINE).length - 1, 1, overlay);
  }
  // The source tree is never edited; only the staged copy.
  assert.ok(!readFileSync(join(REPO_ROOT, "deploy/providers/azure/gitops/worker/overlays/default/kustomization.yaml"), "utf8").includes(COMPONENT_LINE));
});

test("rendered worker: the attacher runs from the worker image; worker pods keep their base settings and gain the workspace ones", (t) => {
  const worker = stage(t, "worker", stampEnv({ WORKSPACES_ENABLED: "true" }));
  const objects = render(t, join(worker, "overlays/default"));
  if (!objects) return;
  const attacher = objects["DaemonSet/pilotswarm-attacher"];
  assert.ok(attacher, "the attacher DaemonSet is rendered");
  assert.equal(attacher.metadata.namespace, "pilotswarm");
  const attacherContainer = container(attacher, "attacher");
  assert.equal(attacherContainer.image, "stub.azurecr.io/pilotswarm-worker:t1");
  assert.equal(attacher.spec.template.spec.hostNetwork, true);
  assert.equal(attacher.spec.template.spec.dnsPolicy, "ClusterFirstWithHostNet");
  assert.equal(attacherContainer.securityContext.privileged, true);
  assert.equal(byName(attacherContainer.volumeMounts, "mounts").mountPropagation, "Bidirectional");

  const deployment = objects["Deployment/copilot-runtime-worker"];
  const spec = deployment.spec.template.spec;
  const worker0 = container(deployment, "worker");
  const env = envOf(worker0);
  assert.equal(worker0.image, "stub.azurecr.io/pilotswarm-worker:t1");
  // Base entries survive the strategic merge.
  for (const name of ["POD_NAME", "RUST_LOG", "PS_MODEL_PROVIDERS_PATH"]) assert.ok(byName(worker0.env, name), name);
  for (const name of ["copilot-home", "secrets-store", "model-providers"]) assert.ok(byName(spec.volumes, name), name);
  // And the workspace ones arrive.
  assert.equal(env.PILOTSWARM_EXTENSION_MODULES, "/app/packages/sdk/examples/repo-workspaces/index.mjs");
  assert.equal(env.PLUGIN_DIRS, "/app/packages/sdk/examples/repo-workspaces/plugin");
  assert.equal(byName(worker0.volumeMounts, "workspaces").mountPath, "/ws");
  assert.equal(byName(worker0.volumeMounts, "workspaces").mountPropagation, "HostToContainer");
  assert.equal(spec.terminationGracePeriodSeconds, 90);
  // The worker reaches the attacher through the folder the attacher listens in.
  const socketDir = byName(spec.volumes, "attacher-socket").hostPath.path;
  assert.equal(byName(attacher.spec.template.spec.volumes, "socket").hostPath.path, socketDir);
  assert.equal(env.ATTACHER_SOCKET, envOf(attacherContainer).ATTACHER_SOCKET);
  assert.ok(env.ATTACHER_SOCKET.startsWith(`${byName(worker0.volumeMounts, "attacher-socket").mountPath}/`));
  // The folder the attacher mounts into is the one worker pods see at /ws.
  assert.equal(byName(spec.volumes, "workspaces").hostPath.path, envOf(attacherContainer).ATTACHER_MOUNT_BASE);
  assert.equal(byName(attacher.spec.template.spec.volumes, "mounts").hostPath.path, envOf(attacherContainer).ATTACHER_MOUNT_BASE);
});

test("rendered worker with a bring-your-own database: both staged components apply", (t) => {
  const worker = stage(t, "worker", byoEnv({ WORKSPACES_ENABLED: "true" }));
  const text = readFileSync(join(worker, "overlays/default/kustomization.yaml"), "utf8");
  assert.ok(text.includes("../../components/database-secrets") && text.includes(COMPONENT_LINE));
  const objects = render(t, join(worker, "overlays/default"));
  if (!objects) return;
  const worker0 = container(objects["Deployment/copilot-runtime-worker"], "worker");
  assert.ok(byName(worker0.env, "DATABASE_URL")?.valueFrom?.secretKeyRef, "the database URL still comes from its Secret");
  assert.ok(byName(worker0.env, "PILOTSWARM_EXTENSION_MODULES"));
  assert.ok(objects["DaemonSet/pilotswarm-attacher"]);
});

for (const [edge, tls, overlay] of PORTAL_OVERLAYS) {
  test(`rendered portal/${overlay}: PLUGIN_DIRS keeps the app plugin and adds the sample's`, (t) => {
    const off = stage(t, "portal", stampEnv({ EDGE_MODE: edge, TLS_SOURCE: tls }));
    const on = stage(t, "portal", stampEnv({ EDGE_MODE: edge, TLS_SOURCE: tls, WORKSPACES_ENABLED: "true" }));
    const before = render(t, join(off, "overlays", overlay));
    if (!before) return;
    const after = render(t, join(on, "overlays", overlay));
    const base = envOf(container(before["Deployment/pilotswarm-portal"], "portal")).PLUGIN_DIRS;
    const patched = envOf(container(after["Deployment/pilotswarm-portal"], "portal")).PLUGIN_DIRS;
    // The patch restates the base list; if the base changes, this catches the drift.
    assert.deepEqual(patched.split(","), [...base.split(","), "/app/packages/sdk/examples/repo-workspaces/plugin"]);
  });
}

test("rendered repo-cache: one image in all three containers, the exports mounted, no Namespace of its own", (t) => {
  const root = stage(t, "repo-cache", { IMAGE: "stub.azurecr.io/pilotswarm-repo-cache:t1" });
  const objects = render(t, join(root, "overlays/default"));
  if (!objects) return;
  assert.ok(!Object.keys(objects).some((key) => key.startsWith("Namespace/")), "the worker's kustomization owns the namespace");
  const deployment = objects["Deployment/repo-cache"];
  const spec = deployment.spec.template.spec;
  assert.equal(deployment.metadata.namespace, "pilotswarm");
  assert.equal(deployment.spec.strategy.type, "Recreate");
  assert.equal(spec.containers[0].name, "repo-service", "the deploy tool checks the first container's image tag");
  for (const c of [...spec.initContainers, ...spec.containers]) assert.equal(c.image, "stub.azurecr.io/pilotswarm-repo-cache:t1", c.name);
  assert.equal(container(deployment, "nfs").securityContext.privileged, true);
  const exportsKey = hashed(objects, "ConfigMap", "repo-cache-exports");
  assert.ok(exportsKey);
  assert.equal(byName(spec.volumes, "exports").configMap.name, exportsKey.split("/")[1]);
  assert.equal(byName(spec.volumes, "nfs-root").emptyDir.medium, "Memory");
  assert.ok(objects["PersistentVolumeClaim/repo-cache-data"]);
  assert.ok(objects["NetworkPolicy/repo-cache"]);
});

test("the repo pod lands on the repocache pool, and only it tolerates that pool's taint", (t) => {
  // aks.bicep declares the pool; the repo pod must select its label and
  // tolerate its taint, and the attacher must not land there (no workers).
  const bicep = readFileSync(join(REPO_ROOT, "deploy/providers/azure/services/base-infra/bicep/aks.bicep"), "utf8");
  const pool = bicep.slice(bicep.indexOf("name: 'repocache'"));
  const label = /nodeLabels: \{\s*'([^']+)': '([^']+)'/.exec(pool);
  const taint = /nodeTaints: \[\s*'([^=]+)=([^:]+):(\w+)'/.exec(pool);
  assert.ok(label && taint, "aks.bicep declares the repocache pool's label and taint");

  const repo = stage(t, "repo-cache", { IMAGE: "stub.azurecr.io/pilotswarm-repo-cache:t1" });
  const r = render(t, join(repo, "overlays/default"));
  if (!r) return;
  const spec = r["Deployment/repo-cache"].spec.template.spec;
  assert.equal(spec.nodeSelector[label[1]], label[2]);
  assert.ok(spec.tolerations.some((tol) => tol.key === taint[1] && tol.value === taint[2] && tol.effect === taint[3]));

  const worker = stage(t, "worker", stampEnv({ WORKSPACES_ENABLED: "true" }));
  const w = render(t, join(worker, "overlays/default"));
  const attacherTolerations = w["DaemonSet/pilotswarm-attacher"].spec.template.spec.tolerations ?? [];
  assert.ok(!attacherTolerations.some((tol) => tol.key === taint[1] || tol.operator === "Exists" && !tol.key));
});

test("aks.bicep adds the repocache pool as its own agent pool resource, never in agentPoolProfiles", () => {
  // AKS refuses a new pool in agentPoolProfiles on an existing cluster ("A new
  // agent pool was introduced. Adding agent pools to an existing cluster is not
  // allowed through managed cluster operations"): the stamp's first deploy
  // failed on it, and `az deployment group validate` against the live cluster
  // reproduced it. Only the agentPools resource passes.
  const bicep = readFileSync(join(REPO_ROOT, "deploy/providers/azure/services/base-infra/bicep/aks.bicep"), "utf8");
  const profiles = bicep.slice(bicep.indexOf("agentPoolProfiles:"), bicep.indexOf("addonProfiles:"));
  assert.ok(profiles.length > 0 && !profiles.includes("repocache"), "the cluster's pool list does not name repocache");
  assert.match(bicep, /resource \w+ 'Microsoft\.ContainerService\/managedClusters\/agentPools@[^']+' = if \(repoCachePoolEnabled\) \{\s*parent: aks\s*name: 'repocache'/);
  // The Flux extension waits for the pool: its write starts an AKS add-on
  // update, and a pool write that overlaps it failed on the stamp
  // ("EtagMismatch ... Another operation is in progress").
  const extension = bicep.slice(bicep.indexOf("resource fluxExtension"));
  assert.match(extension.slice(0, extension.indexOf("\n}")), /dependsOn: \[\s*repoCachePool\s*\]/);
});

test("the pieces agree: roots, exports, paths, service address and sample files", (t) => {
  const worker = stage(t, "worker", stampEnv({ WORKSPACES_ENABLED: "true" }));
  const repo = stage(t, "repo-cache", { IMAGE: "stub.azurecr.io/pilotswarm-repo-cache:t1" });
  const w = render(t, join(worker, "overlays/default"));
  if (!w) return;
  const r = render(t, join(repo, "overlays/default"));

  const attacherEnv = envOf(container(w["DaemonSet/pilotswarm-attacher"], "attacher"));
  const workerEnv = envOf(container(w["Deployment/copilot-runtime-worker"], "worker"));
  const repoDeployment = r["Deployment/repo-cache"];
  const serviceEnv = envOf(container(repoDeployment, "repo-service"));
  const service = r["Service/repo-cache"];

  // Each root the worker knows is a root the attacher mounts, at the same
  // path through /mnt/ps -> /ws, from an export the NFS server has.
  const attacherRoots = Object.fromEntries(attacherEnv.ATTACHER_ROOTS.split(",").map((entry) => {
    const [name, target] = entry.split("=");
    const [host, exportPath] = target.split(":");
    return [name, { host, exportPath }];
  }));
  const workerRoots = [...workerEnv.PS_WORKSPACE_ROOTS.split(","), ...workerEnv.PS_PLAIN_ROOTS.split(",")]
    .map((entry) => entry.split("="));
  assert.deepEqual(workerRoots.map(([name]) => name).sort(), Object.keys(attacherRoots).sort());
  const exportsText = r[hashed(r, "ConfigMap", "repo-cache-exports")].data["pilotswarm.exports"];
  const exported = exportsText.split("\n").filter((line) => line.trim() && !line.startsWith("#")).map((line) => line.split(/\s+/)[0]);
  for (const [name, path] of workerRoots) {
    assert.equal(path, `/ws/${name}`, "a root's path in worker pods is /ws/<root>");
    // Same path on the repo pod and on the workers (section 5.1).
    assert.equal(attacherRoots[name].exportPath, path);
    assert.ok(exported.includes(path), `${path} is exported`);
    assert.equal(attacherRoots[name].host, `${service.metadata.name}.${service.metadata.namespace}.svc.cluster.local`);
  }
  assert.equal(serviceEnv.REPO_SERVICE_ROOT, "/ws/a");
  assert.equal(`/ws/${serviceEnv.REPO_SERVICE_ROOT_NAME}`, serviceEnv.REPO_SERVICE_ROOT);
  assert.ok(workerEnv.PS_WORKSPACE_ROOTS.split(",").includes(`${serviceEnv.REPO_SERVICE_ROOT_NAME}=${serviceEnv.REPO_SERVICE_ROOT}`));

  // Workers call the repo service at the address it gives its own sandbox remotes.
  const http = byName(service.spec.ports, "http").port;
  const url = `http://${service.metadata.name}.${service.metadata.namespace}.svc.cluster.local:${http}`;
  assert.equal(workerEnv.REPO_SERVICE_URL, url);
  assert.equal(serviceEnv.REPO_SERVICE_PUBLIC_URL, url);
  assert.equal(byName(service.spec.ports, "nfs").port, 2049);

  // The network policy lets worker pods in on the service port.
  const policy = r["NetworkPolicy/repo-cache"];
  const workerLabels = w["Deployment/copilot-runtime-worker"].spec.template.metadata.labels;
  const httpRule = policy.spec.ingress.find((rule) => rule.ports.some((p) => p.port === http));
  const selector = httpRule.from[0].podSelector.matchLabels;
  for (const [key, value] of Object.entries(selector)) assert.equal(workerLabels[key], value, key);

  // Files the settings name exist in the sample, which the worker image copies.
  const sample = join(REPO_ROOT, "packages/sdk/examples/repo-workspaces");
  const inImage = (path) => join(sample, path.replace("/app/packages/sdk/examples/repo-workspaces/", ""));
  assert.ok(existsSync(inImage(workerEnv.PILOTSWARM_EXTENSION_MODULES)));
  assert.ok(existsSync(join(inImage(workerEnv.PLUGIN_DIRS), "plugin.json")));
  const helper = serviceEnv.REPO_SERVICE_CREDENTIAL_HELPER.replace(/^!node /, "");
  assert.ok(existsSync(inImage(helper)), helper);
  const attacherScript = container(w["DaemonSet/pilotswarm-attacher"], "attacher").command.at(-1);
  assert.ok(existsSync(inImage(attacherScript)), attacherScript);
  // The repos the service mirrors are well-formed JSON with a sandbox remote.
  const repos = JSON.parse(serviceEnv.REPO_SERVICE_REPOS);
  assert.equal(repos.duroxide.upstream, "https://github.com/microsoft/duroxide.git");
  assert.equal(repos.duroxide.sandbox, true);
});
