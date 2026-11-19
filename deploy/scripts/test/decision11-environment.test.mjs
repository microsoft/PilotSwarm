import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const ENV_DIR = join(REPO_ROOT, "deploy", "environments", "pse-decision11-test");
const SCRIPT_PATH = join(ENV_DIR, "decision11.mjs");
const CONFIG_PATH = join(ENV_DIR, "config.json");
const SOURCE_HEAD = "a".repeat(40);
const PLAN_ID = "pse/decision-env/frozen-create-plan";
const CREATE_APPROVAL_ID = "pse/approvals/decision-env-create-20261119T041738";
const VPN_APPROVAL_ID = "pse/approvals/decision-env-vpn-plaintext-20261119";
const OPERATION_ID = "79abbbf1-e41c-425a-984a-25f5cf0b949f";
const EXPIRY = "2026-11-22T04:17:38.699Z";
const CLOSURE = "2026-11-22T04:12:38.699Z";
const ACTIVE_NOW = "2026-11-20T12:00:00.000Z";
const TEST_TENANT_ID = "22222222-2222-2222-2222-222222222222";
const TEST_SUBSCRIPTION_ID = "11111111-1111-1111-1111-111111111111";
const TEST_RELAY_SUBSCRIPTION_ID = "33333333-3333-3333-3333-333333333333";
const TEST_OWNER_ID = "44444444-4444-4444-4444-444444444444";
const TEST_ACR_HOST = "decision11-test.invalid";
const TEST_IMAGE_DIGESTS = {
  portal: `sha256:${"1".repeat(64)}`,
  worker: `sha256:${"2".repeat(64)}`,
  originProxy: `sha256:${"3".repeat(64)}`,
  relay: `sha256:${"4".repeat(64)}`,
};
const TEST_RESOURCE_GROUP = "wdmchk-pse-decision11-test-rg";
const T3_PIP_ID = `/subscriptions/${TEST_RELAY_SUBSCRIPTION_ID}/resourceGroups/wdmwaldemortchk-aks-t3-nodes/providers/Microsoft.Network/publicIPAddresses/relay-test-public-ip`;
const TEST_RESOURCE_UIDS = {
  resourceGroup: "resource-group-test-uid",
  aks: "aks-test-uid",
  postgres: "postgres-test-uid",
  storage: "storage-test-uid",
  acr: "acr-test-uid",
  database: "database-test-uid",
  decisionDeployment: "decision-deployment-test-uid",
  nodeResourceGroup: "node-resource-group-test-uid",
  vnet: "vnet-test-uid",
  nsg: "nsg-test-uid",
  egressPip: "egress-pip-test-uid",
  originPip: "origin-pip-test-uid",
  runtimeIdentity: "runtime-identity-test-uid",
  controlPlaneIdentity: "control-plane-identity-test-uid",
  kubeletIdentity: "kubelet-identity-test-uid",
  privateDns: "private-dns-test-uid",
};
const TEST_BINDINGS = {
  schemaVersion: 1,
  kind: "private-environment-bindings",
  reviewed: true,
  environment: "pse-decision11-test",
  bindings: {
    target: {
      tenantId: TEST_TENANT_ID,
      subscriptionId: TEST_SUBSCRIPTION_ID,
      subscriptionName: "Decision test subscription",
    },
    owner: { subject: TEST_OWNER_ID, email: "owner@example.invalid" },
    network: {
      relayCluster: {
        name: "relay-cluster-test",
        subscriptionId: TEST_RELAY_SUBSCRIPTION_ID,
        resourceGroup: "relay-cluster-test-rg",
        nodeResourceGroup: "relay-cluster-test-nodes-rg",
        outboundPublicIpName: "relay-test-public-ip",
        outboundPublicIpId: T3_PIP_ID,
        outboundLoadBalancerId: `/subscriptions/${TEST_RELAY_SUBSCRIPTION_ID}/resourceGroups/relay-cluster-test-nodes-rg/providers/Microsoft.Network/loadBalancers/kubernetes`,
      },
    },
    foundry: { subscriptionId: TEST_SUBSCRIPTION_ID },
    images: {
      portal: `${TEST_ACR_HOST}/pilotswarm-portal`,
      worker: `${TEST_ACR_HOST}/pilotswarm-worker`,
      originProxy: `${TEST_ACR_HOST}/decision11-origin-proxy`,
      relay: `${TEST_ACR_HOST}/decision11-vpn-relay`,
    },
    ledger: { resourceUids: TEST_RESOURCE_UIDS },
  },
};
const TEST_BINDINGS_SHA256 = sha256(canonicalTestJson(TEST_BINDINGS.bindings));
const TARGET_PREFIXES = [
  "decision11-choice-",
  "decision11-noul-",
  "decision11-score-script-",
  "decision11-score-agent-",
  "decision11-uncertain-",
  "decision11-replay-",
];
const REQUIRED_FILES = [
  "config.json",
  "decision11.mjs",
  "setup.sh",
  "reset.sh",
  "verify.sh",
  "smoke.sh",
  "teardown.sh",
  "README.md",
];

const implementation = import(pathToFileURL(SCRIPT_PATH)).then(
  (value) => value,
  () => null,
);

async function implementationApi() {
  const api = await implementation;
  assert.ok(api, "decision11.mjs has not implemented the Decision 1.1 environment contract");
  assert.equal(typeof api.runDecision11, "function");
  return {
    ...api,
    runDecision11: (command, argv, dependencies = {}) => api.runDecision11(command, argv, {
      ...dependencies,
      bindings: TEST_BINDINGS,
      bindingsSha256: TEST_BINDINGS_SHA256,
    }),
  };
}

function canonicalTestJson(value) {
  const canonical = Array.isArray(value)
    ? value.map(canonicalTestJson)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalTestJson(value[key])]))
      : value;
  return JSON.stringify(canonical);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tempRoot(prefix = "decision11-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function jsonFile(root, name, value) {
  const path = join(root, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function reviewedImageReceipt(root) {
  return jsonFile(root, "image-receipt.json", {
    schemaVersion: 1,
    kind: "reviewed-images",
    reviewed: true,
    sourceHead: SOURCE_HEAD,
    images: {
      portal: { name: `${TEST_ACR_HOST}/pilotswarm-portal`, digest: TEST_IMAGE_DIGESTS.portal },
      worker: { name: `${TEST_ACR_HOST}/pilotswarm-worker`, digest: TEST_IMAGE_DIGESTS.worker },
      originProxy: { name: `${TEST_ACR_HOST}/decision11-origin-proxy`, digest: TEST_IMAGE_DIGESTS.originProxy },
      relay: { name: `${TEST_ACR_HOST}/decision11-vpn-relay`, digest: TEST_IMAGE_DIGESTS.relay },
    },
  });
}

function baseReceipts(root) {
  const manifest = jsonFile(root, "reviewed-manifest.yaml", { sample: true });
  const manifestSha256 = sha256(readFileSync(manifest));
  const commonTarget = {
    targetId: "ai-ops-independent-tests",
    subscriptionId: TEST_SUBSCRIPTION_ID,
    location: "westus2",
    resourceGroup: "wdmchk-pse-decision11-test-rg",
  };
  const paths = {
    plan: jsonFile(root, "plan-receipt.json", {
      schemaVersion: 1,
      receiptId: PLAN_ID,
      kind: "frozen-plan",
      artifactSha256: "07d2309b79a857661b4782c420809e048513b6b61cb787b5f9681f1bfc63bdf2",
      version: 1,
      ...commonTarget,
      expiresAt: EXPIRY,
      closureStartsAt: CLOSURE,
    }),
    cost: jsonFile(root, "cost-receipt.json", {
      schemaVersion: 1,
      receiptId: PLAN_ID,
      kind: "cost-acceptance",
      section: "cost",
      currency: "USD",
      expectedRoundedUsd: 80,
      ceilingUsd: 100,
      accepted: true,
      decisionProofRequestMax: 100,
      decisionBillableTokensMax: 1_000_000,
    }),
    approval: jsonFile(root, "approval-receipt.json", {
      schemaVersion: 1,
      receiptId: CREATE_APPROVAL_ID,
      vpnReceiptId: VPN_APPROVAL_ID,
      approvedAt: "2026-11-19T04:17:38.699Z",
      ownerSubject: TEST_OWNER_ID,
      ownerEmail: "owner@example.invalid",
      expiresAt: EXPIRY,
    }),
    source: jsonFile(root, "source-receipt.json", {
      schemaVersion: 1,
      kind: "reviewed-source",
      head: SOURCE_HEAD,
      archiveSha256: sha256(`archive:${SOURCE_HEAD}`),
      reviewed: true,
    }),
    image: reviewedImageReceipt(root),
    trust: jsonFile(root, "trust-receipt.json", {
      schemaVersion: 1,
      kind: "trust-material-references",
      caName: "PSE Decision11 Test Origin CA",
      clientSecretRef: "pse-decision11-relay/decision11-relay-client-tls",
      serverSecretRef: "pse-decision11-preview/decision11-origin-server-tls",
      clientUriSan: "spiffe://pse-decision11-test/relay/epoch/1",
      serverDnsSan: "decision11-origin.pse-decision11.test",
      publicCertificatesOnly: true,
    }),
    lease: jsonFile(root, "lease-receipt.json", {
      schemaVersion: 1,
      kind: "operation-fences",
      operationId: OPERATION_ID,
      holder: "decision11-environment-executor",
      targetId: "ai-ops-independent-tests",
      generation: 1,
      epoch: 1,
      expiresAt: EXPIRY,
      closureStartsAt: CLOSURE,
      objects: [
        { namespace: "pse-decision11-relay", name: "pse-environment-operation-lock", uid: "relay-lock-uid", resourceVersion: "1" },
        { namespace: "pse-decision11-host", name: "pse-environment-operation-lock", uid: "host-lock-uid", resourceVersion: "1" },
        { namespace: "pse-decision11-preview", name: "pse-namespace-lease", uid: "feature-lease-uid", resourceVersion: "1" },
      ],
    }),
    ledger: jsonFile(root, "ledger-receipt.json", {
      schemaVersion: 1,
      kind: "canonical-ledger-plan",
      operationId: OPERATION_ID,
      targetId: "ai-ops-independent-tests",
      revision: 1,
      resourceUids: { ...TEST_RESOURCE_UIDS },
    }),
    manifests: jsonFile(root, "manifest-receipt.json", {
      schemaVersion: 1,
      kind: "reviewed-manifests",
      reviewed: true,
      sourceHead: SOURCE_HEAD,
      entries: [
        {
          kind: "kubernetes",
          path: manifest,
          sha256: manifestSha256,
          context: "decision11-app",
        },
      ],
    }),
    evidence: join(root, "setup-evidence.json"),
    manifest,
  };
  return paths;
}

function setupArgs(paths) {
  return [
    "--target-id", "ai-ops-independent-tests",
    "--head", SOURCE_HEAD,
    "--plan-receipt", paths.plan,
    "--cost-receipt", paths.cost,
    "--approval-receipt", paths.approval,
    "--source-receipt", paths.source,
    "--image-receipt", paths.image,
    "--trust-receipt", paths.trust,
    "--lease-receipt", paths.lease,
    "--ledger-receipt", paths.ledger,
    "--manifest-receipt", paths.manifests,
    "--evidence-out", paths.evidence,
  ];
}

function outboundRunner(calls, { ip = "4.148.50.242" } = {}) {
  return async (command, args, options = {}) => {
    const call = { command, args: [...args], options };
    calls.push(call);
    if (command === "az" && args[0] === "aks" && args[1] === "show") {
      return { status: 0, stdout: `${T3_PIP_ID}\n`, stderr: "" };
    }
    if (command === "az" && args[0] === "network" && args[1] === "public-ip" && args[2] === "show") {
      return { status: 0, stdout: `${ip}\n`, stderr: "" };
    }
    if (command === "az" && args[0] === "network" && args[1] === "lb" && args[2] === "show") {
      return {
        status: 0,
        stdout: JSON.stringify({
          outboundRules: [{ name: "aksOutboundRule", frontendIPConfigurations: [{ publicIPAddress: { id: T3_PIP_ID } }] }],
        }),
        stderr: "",
      };
    }
    if (command === "kubectl" && args.includes("apply")) {
      return { status: 0, stdout: "applied\n", stderr: "" };
    }
    throw new Error(`Unexpected runner call: ${command} ${args.join(" ")}`);
  };
}

function nowAt(value = ACTIVE_NOW) {
  return () => new Date(value);
}

test("the checked-in environment template freezes policy values and all wrappers without private cloud bindings", () => {
  for (const file of REQUIRED_FILES) assert.ok(existsSync(join(ENV_DIR, file)), `${file} is required`);
  const config = readJson(CONFIG_PATH);
  assert.deepEqual(config.receiptIds, {
    plan: PLAN_ID,
    costFact: PLAN_ID,
    createApproval: CREATE_APPROVAL_ID,
    vpnApproval: VPN_APPROVAL_ID,
  });
  assert.equal(config.target.id, "ai-ops-independent-tests");
  assert.equal(config.target.subscriptionId, "__SUBSCRIPTION_ID__");
  assert.equal(config.target.tenantId, "__TENANT_ID__");
  assert.equal(config.target.location, "westus2");
  assert.equal(config.target.resourceGroup, "wdmchk-pse-decision11-test-rg");
  assert.equal(config.aks.name, "wdmchk-pse-decision11-aks");
  assert.equal(config.postgres.server, "wdmchk-pse-decision11-pg");
  assert.equal(config.postgres.database, "pilotswarm_decision11");
  assert.equal(config.postgres.role, "pilotswarm_decision11");
  assert.equal(config.storage.account, "wdmchkpsedecision11sa");
  assert.equal(config.storage.container, "copilot-sessions-decision11");
  assert.equal(config.acr, "wdmchkpsedecision11acr");
  assert.deepEqual(config.namespaces, {
    host: "pse-decision11-host",
    feature: "pse-decision11-preview",
    relay: "pse-decision11-relay",
  });
  assert.equal(config.network.relaySourceCidr, "4.148.50.242/32");
  assert.equal(config.network.vpnSourceCidr, "172.16.200.0/24");
  assert.equal(config.network.clientUriSan, "spiffe://pse-decision11-test/relay/epoch/1");
  assert.equal(config.network.serverDnsSan, "decision11-origin.pse-decision11.test");
  assert.equal(config.expiry.expiresAt, EXPIRY);
  assert.equal(config.expiry.closureStartsAt, CLOSURE);
  assert.deepEqual(config.demoSessionPrefixes, TARGET_PREFIXES);
  assert.equal(config.demos.positive.length, 5);
  assert.equal(config.demos.negative.id, "missing-default-negative-diagnostic");

  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /["']?(password|privateKey|clientKey|token|sas|connectionString)["']?\s*:/i);
  assert.doesNotMatch(serialized, /(?:0\.){3}0\/0/);
  assert.doesNotMatch(serialized, /wfsimp|canvas/i);
  for (const wrapper of ["setup", "reset", "verify", "smoke", "teardown"]) {
    const path = join(ENV_DIR, `${wrapper}.sh`);
    assert.match(readFileSync(path, "utf8"), new RegExp(`decision11\\.mjs["']?\\s+${wrapper}`));
    assert.notEqual(statSync(path).mode & 0o111, 0, `${wrapper}.sh must be executable`);
  }
});

test("every command requires an external reviewed bindings receipt", async () => {
  const api = await implementation;
  assert.ok(api, "decision11.mjs is required");
  for (const command of ["setup", "reset", "verify", "smoke", "teardown"]) {
    await assert.rejects(api.runDecision11(command, [], { now: nowAt() }), /--bindings-receipt/i, command);
  }
});

test("the CLI resolves a reviewed bindings receipt without weakening the frozen setup contract", async () => {
  const api = await implementation;
  assert.ok(api, "decision11.mjs is required");
  const root = tempRoot();
  try {
    const paths = baseReceipts(root);
    const bindingPath = jsonFile(root, "bindings-receipt.json", TEST_BINDINGS);
    const calls = [];
    const result = await api.runDecision11("setup", [
      "--bindings-receipt", bindingPath,
      ...setupArgs(paths),
    ], { runner: outboundRunner(calls), now: nowAt(), bindingsSha256: TEST_BINDINGS_SHA256 });
    assert.equal(result.evidence.subscriptionId, TEST_SUBSCRIPTION_ID);
    assert.equal(calls.filter((call) => call.command === "kubectl" && call.args.includes("apply")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI refuses a reviewed bindings receipt whose private values changed", async () => {
  const api = await implementation;
  assert.ok(api, "decision11.mjs is required");
  const root = tempRoot();
  try {
    const paths = baseReceipts(root);
    const changed = structuredClone(TEST_BINDINGS);
    changed.bindings.target.subscriptionId = "55555555-5555-5555-5555-555555555555";
    const bindingPath = jsonFile(root, "bindings-receipt.json", changed);
    const calls = [];
    await assert.rejects(
      api.runDecision11("setup", ["--bindings-receipt", bindingPath, ...setupArgs(paths)], {
        runner: outboundRunner(calls), now: nowAt(), bindingsSha256: TEST_BINDINGS_SHA256,
      }),
      /bindings receipt hash/i,
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup validates the exact plan, target and source head before any command", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const paths = baseReceipts(root);
    const plan = readJson(paths.plan);
    plan.receiptId = "wrong-plan";
    writeFileSync(paths.plan, `${JSON.stringify(plan)}\n`);
    const calls = [];
    await assert.rejects(
      runDecision11("setup", setupArgs(paths), { runner: outboundRunner(calls), now: nowAt() }),
      /frozen plan receipt/i,
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every mutating command refuses at or inside the closure lead window before side effects", async () => {
  const { runDecision11 } = await implementationApi();
  for (const command of ["setup", "reset", "smoke", "teardown"]) {
    const calls = [];
    await assert.rejects(
      runDecision11(command, [], { runner: outboundRunner(calls), now: nowAt(CLOSURE) }),
      /closure|expired|mutating commands/i,
    );
    assert.equal(calls.length, 0, command);
  }
});

test("setup remeasures the relay source at execution time and refuses drift before apply", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const paths = baseReceipts(root);
    const calls = [];
    await assert.rejects(
      runDecision11("setup", setupArgs(paths), {
        runner: outboundRunner(calls, { ip: "4.148.50.243" }),
        now: nowAt(),
      }),
      /relay source.*4\.148\.50\.242\/32/i,
    );
    assert.ok(calls.some((call) => call.command === "az" && call.args[0] === "aks"));
    assert.equal(calls.filter((call) => call.command === "kubectl" && call.args.includes("apply")).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup accepts only public trust references and the exact CA/SAN identities", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const paths = baseReceipts(root);
    const trust = readJson(paths.trust);
    trust.privateKey = "forbidden-private-material";
    writeFileSync(paths.trust, `${JSON.stringify(trust)}\n`);
    const calls = [];
    await assert.rejects(
      runDecision11("setup", setupArgs(paths), { runner: outboundRunner(calls), now: nowAt() }),
      /trust.*secret|private.*material/i,
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup applies exactly the caller-supplied reviewed and hashed manifests", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const paths = baseReceipts(root);
    const calls = [];
    const result = await runDecision11("setup", setupArgs(paths), { runner: outboundRunner(calls), now: nowAt() });
    const applies = calls.filter((call) => call.command === "kubectl" && call.args.includes("apply"));
    assert.equal(applies.length, 1);
    assert.ok(applies[0].args.includes(paths.manifest));
    assert.equal(result.evidence.manifestsApplied, 1);
    assert.equal(result.evidence.relaySourceCidr, "4.148.50.242/32");
    assert.equal(readJson(paths.evidence).relaySourceCidr, "4.148.50.242/32");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup refuses an unreviewed or changed manifest without applying it", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const paths = baseReceipts(root);
    const receipt = readJson(paths.manifests);
    writeFileSync(paths.manifest, '{"changed":true}\n');
    writeFileSync(paths.manifests, JSON.stringify(receipt));
    const calls = [];
    await assert.rejects(
      runDecision11("setup", setupArgs(paths), { runner: outboundRunner(calls), now: nowAt() }),
      /manifest hash/i,
    );
    assert.equal(calls.filter((call) => call.args.includes("apply")).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function resetReceipt(root) {
  return jsonFile(root, "reset-receipt.json", {
    schemaVersion: 1,
    kind: "synthetic-demo-reset",
    reviewed: true,
    apiBaseUrl: "http://decision11-vpn.invalid",
    resetPath: "/api/internal/decision11-demo/reset",
    authEnv: "DECISION11_TEST_API_TOKEN",
    prefixes: TARGET_PREFIXES,
  });
}

test("reset removes and reseeds only the six named synthetic session prefixes through the application API", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const receipt = resetReceipt(root);
    const evidence = join(root, "reset-evidence.json");
    const calls = [];
    const runner = async (command, args, options = {}) => {
      calls.push({ command, args, options });
      const request = JSON.parse(options.input);
      return { status: 0, stdout: JSON.stringify({ ok: true, prefix: request.prefix, removed: 2, seeded: 1 }), stderr: "" };
    };
    const result = await runDecision11("reset", ["--reset-receipt", receipt, "--evidence-out", evidence], {
      runner,
      now: nowAt(),
      env: { DECISION11_TEST_API_TOKEN: "synthetic-test-token" },
    });
    assert.equal(calls.length, 6);
    assert.ok(calls.every((call) => call.command === "curl"));
    assert.deepEqual(calls.map((call) => JSON.parse(call.options.input).prefix), TARGET_PREFIXES);
    assert.ok(calls.every((call) => JSON.parse(call.options.input).action === "remove-and-reseed"));
    assert.equal(result.evidence.prefixes.length, 6);
    assert.doesNotMatch(JSON.stringify(readJson(evidence)), /synthetic-test-token/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset fails closed on an unknown prefix before calling the application", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const receipt = resetReceipt(root);
    const value = readJson(receipt);
    value.prefixes.push("other-session-");
    writeFileSync(receipt, JSON.stringify(value));
    const calls = [];
    await assert.rejects(
      runDecision11("reset", ["--reset-receipt", receipt, "--evidence-out", join(root, "out.json")], {
        runner: async (...args) => { calls.push(args); return { status: 0, stdout: "{}", stderr: "" }; },
        now: nowAt(),
      }),
      /exact six.*prefixes/i,
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function verifyReceipt(root) {
  return jsonFile(root, "verify-receipt.json", {
    schemaVersion: 1,
    kind: "read-only-verification",
    reviewed: true,
    appContext: "decision11-app",
    relayContext: "decision11-relay",
    portalHealthUrl: "http://decision11-vpn.invalid/api/health",
    readinessUrl: "http://decision11-vpn.invalid/api/internal/decision11-readiness",
    negativeProofs: {
      sibling: { status: "passed", evidenceId: "sibling-denied-1" },
      nonVpn: { status: "passed", evidenceId: "non-vpn-denied-1" },
      directOrigin: { status: "passed", evidenceId: "direct-origin-denied-1" },
    },
  });
}

function verificationRunner(calls, { mutateAks, images = {} } = {}) {
  const liveImages = {
    portal: `${TEST_ACR_HOST}/pilotswarm-portal@${TEST_IMAGE_DIGESTS.portal}`,
    worker: `${TEST_ACR_HOST}/pilotswarm-worker@${TEST_IMAGE_DIGESTS.worker}`,
    originProxy: `${TEST_ACR_HOST}/decision11-origin-proxy@${TEST_IMAGE_DIGESTS.originProxy}`,
    relay: `${TEST_ACR_HOST}/decision11-vpn-relay@${TEST_IMAGE_DIGESTS.relay}`,
    ...images,
  };
  return async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === "az" && args[0] === "resource" && args[1] === "list") {
      const inventory = [
        { name: "wdmchk-pse-decision11-aks", type: "Microsoft.ContainerService/managedClusters" },
        { name: "wdmchk-pse-decision11-pg", type: "Microsoft.DBforPostgreSQL/flexibleServers" },
        { name: "wdmchkpsedecision11sa", type: "Microsoft.Storage/storageAccounts" },
        { name: "wdmchkpsedecision11acr", type: "Microsoft.ContainerRegistry/registries" },
      ].map((item) => ({
        ...item,
        id: `/subscriptions/${TEST_SUBSCRIPTION_ID}/resourceGroups/${TEST_RESOURCE_GROUP}/providers/${item.type}/${item.name}`,
        location: "westus2",
        resourceGroup: TEST_RESOURCE_GROUP,
        tags: { "wdm-expires-at": EXPIRY },
      }));
      return { status: 0, stdout: JSON.stringify(inventory), stderr: "" };
    }
    if (command === "az" && args[0] === "aks" && args[1] === "show") {
      const aks = {
        id: `/subscriptions/${TEST_SUBSCRIPTION_ID}/resourceGroups/${TEST_RESOURCE_GROUP}/providers/Microsoft.ContainerService/managedClusters/wdmchk-pse-decision11-aks`,
        name: "wdmchk-pse-decision11-aks",
        location: "westus2",
        resourceGroup: TEST_RESOURCE_GROUP,
        nodeResourceGroup: "wdmchk-pse-decision11-nodes-rg",
        provisioningState: "Succeeded",
        kubernetesVersion: "1.36.5",
        apiServerAccessProfile: { enablePrivateCluster: true },
        networkProfile: { networkPlugin: "azure", networkDataplane: "cilium", networkPluginMode: "overlay" },
        agentPoolProfiles: [{
          name: "systempool",
          count: 2,
          vmSize: "Standard_D4ds_v5",
          availabilityZones: null,
          enableAutoScaling: false,
          mode: "System",
          osType: "Linux",
          upgradeSettings: { maxSurge: "1" },
        }],
        tags: { "wdm-expires-at": EXPIRY },
      };
      if (mutateAks) mutateAks(aks);
      return { status: 0, stdout: JSON.stringify(aks), stderr: "" };
    }
    if (command === "az" && args[0] === "network" && args[1] === "lb") {
      return { status: 0, stdout: JSON.stringify({ outboundRules: [{ name: "aksOutboundRule", frontendIPConfigurations: [{ publicIPAddress: { id: T3_PIP_ID } }] }] }), stderr: "" };
    }
    if (command === "az" && args[0] === "cognitiveservices" && args[1] === "account" && args[2] === "deployment") {
      return { status: 0, stdout: JSON.stringify({ name: "ps-decision-1-1", properties: { provisioningState: "Succeeded", model: { format: "Microsoft", name: "Microsoft-Decision-1.1", version: "1" } } }), stderr: "" };
    }
    if (command === "kubectl" && args.includes("networkpolicy")) {
      return { status: 0, stdout: JSON.stringify({ items: [
        { metadata: { name: "decision11-default-deny" }, spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] } },
        { metadata: { name: "decision11-origin-allow" } },
      ] }), stderr: "" };
    }
    if (command === "kubectl" && args.includes("service")) {
      return { status: 0, stdout: JSON.stringify({ items: [
        { metadata: { namespace: "pse-decision11-preview", name: "decision11-portal-vpn" }, spec: { ports: [{ port: 443 }], loadBalancerSourceRanges: ["4.148.50.242/32"] } },
        { metadata: { namespace: "pse-decision11-preview", name: "decision11-portal" }, spec: { ports: [{ port: 3001 }] } },
      ] }), stderr: "" };
    }
    if (command === "kubectl" && args.includes("configmap")) {
      return { status: 0, stdout: JSON.stringify({ items: [
        { metadata: { name: "decision11-origin-client-trust", namespace: "pse-decision11-preview" }, data: { caName: "PSE Decision11 Test Origin CA", clientUriSan: "spiffe://pse-decision11-test/relay/epoch/1", serverDnsSan: "decision11-origin.pse-decision11.test", serverSecretRef: "pse-decision11-preview/decision11-origin-server-tls", clientSecretRef: "pse-decision11-relay/decision11-relay-client-tls" } },
        { metadata: { name: "decision11-access-lease", namespace: "pse-decision11-preview" }, data: { expiresAt: EXPIRY, closureStartsAt: CLOSURE, epoch: "1" } },
        { metadata: { name: "decision11-access-lease", namespace: "pse-decision11-relay" }, data: { expiresAt: EXPIRY, closureStartsAt: CLOSURE, epoch: "1" } },
      ] }), stderr: "" };
    }
    if (command === "kubectl" && args.includes("deployment")) {
      const context = args[args.indexOf("--context") + 1];
      const items = context === "decision11-relay"
        ? [{ metadata: { namespace: "pse-decision11-relay", name: "pse-decision11-vpn-relay" }, spec: { template: { spec: { containers: [{ name: "relay", image: liveImages.relay }] } } } }]
        : [
          { metadata: { namespace: "pse-decision11-preview", name: "decision11-portal" }, spec: { template: { spec: { containers: [{ name: "portal", image: liveImages.portal }] } } } },
          { metadata: { namespace: "pse-decision11-preview", name: "decision11-worker" }, spec: { template: { spec: { containers: [{ name: "worker", image: liveImages.worker }] } } } },
          { metadata: { namespace: "pse-decision11-preview", name: "decision11-origin-proxy" }, spec: { template: { spec: { containers: [{ name: "origin-proxy", image: liveImages.originProxy }] } } } },
        ];
      return { status: 0, stdout: JSON.stringify({ items }), stderr: "" };
    }
    if (command === "curl" && args.some((arg) => arg.endsWith("/api/health"))) {
      return { status: 0, stdout: JSON.stringify({ ok: true, sourceHead: SOURCE_HEAD }), stderr: "" };
    }
    if (command === "curl" && args.some((arg) => arg.endsWith("/api/internal/decision11-readiness"))) {
      return { status: 0, stdout: JSON.stringify({ ok: true, database: { ok: true, name: "pilotswarm_decision11" }, storage: { ok: true, account: "wdmchkpsedecision11sa", container: "copilot-sessions-decision11" }, leases: { ok: true } }), stderr: "" };
    }
    throw new Error(`Unexpected verification call: ${command} ${args.join(" ")}`);
  };
}

test("verify uses only read operations and emits the required evidence matrix", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const receipt = verifyReceipt(root);
    const imageReceipt = reviewedImageReceipt(root);
    const evidence = join(root, "verify-evidence.json");
    const calls = [];
    const result = await runDecision11("verify", ["--verify-receipt", receipt, "--image-receipt", imageReceipt, "--head", SOURCE_HEAD, "--evidence-out", evidence], {
      runner: verificationRunner(calls),
      now: nowAt(),
    });
    assert.ok(calls.length >= 10);
    for (const call of calls) {
      assert.doesNotMatch(call.args.join(" "), /\b(apply|create|update|delete|patch|post|put|set|remove)\b/i, `${call.command} ${call.args.join(" ")}`);
    }
    for (const key of ["azure", "aks", "network", "originMtls", "negativeProofs", "portalHealth", "foundry", "images", "database", "storage", "leases"]) {
      assert.ok(Object.hasOwn(result.evidence, key), `${key} evidence is required`);
    }
    assert.equal(result.evidence.aks.nodeCount, 2);
    assert.equal(result.evidence.aks.nodeSku, "Standard_D4ds_v5");
    assert.equal(result.evidence.aks.privateApi, true);
    assert.deepEqual(result.evidence.aks.zones, []);
    assert.deepEqual(Object.keys(result.evidence.images).sort(), ["originProxy", "portal", "relay", "worker"]);
    for (const [key, digest] of Object.entries(TEST_IMAGE_DIGESTS)) {
      assert.match(result.evidence.images[key], new RegExp(`@${digest}$`));
    }
    assert.ok(calls.some((call) => call.command === "kubectl" && call.args.includes("deployment") && call.args.includes("decision11-app")));
    assert.ok(calls.some((call) => call.command === "kubectl" && call.args.includes("deployment") && call.args.includes("decision11-relay")));
    assert.equal(result.ok, true);
    assert.equal(readJson(evidence).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify retains explicit sibling, non-VPN and direct-origin placeholders but does not call them passed when unrun", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const receipt = verifyReceipt(root);
    const imageReceipt = reviewedImageReceipt(root);
    const value = readJson(receipt);
    value.negativeProofs.nonVpn = { status: "not-run", reason: "VPN client unavailable" };
    writeFileSync(receipt, JSON.stringify(value));
    await assert.rejects(
      runDecision11("verify", ["--verify-receipt", receipt, "--image-receipt", imageReceipt, "--head", SOURCE_HEAD, "--evidence-out", join(root, "evidence.json")], {
        runner: verificationRunner([]),
        now: nowAt(),
      }),
      /negative proof.*nonVpn.*not-run/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify requires the reviewed 64-hex image receipt before any read", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const receipt = verifyReceipt(root);
    const imageReceipt = reviewedImageReceipt(root);
    const image = readJson(imageReceipt);
    image.reviewed = false;
    image.images.relay.digest = `sha256:${"4".repeat(63)}`;
    writeFileSync(imageReceipt, JSON.stringify(image));
    const calls = [];
    await assert.rejects(
      runDecision11("verify", ["--verify-receipt", receipt, "--image-receipt", imageReceipt, "--head", SOURCE_HEAD, "--evidence-out", join(root, "evidence.json")], {
        runner: verificationRunner(calls),
        now: nowAt(),
      }),
      /image receipt review state/i,
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify refuses an incomplete image receipt digest before any read", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const receipt = verifyReceipt(root);
    const imageReceipt = reviewedImageReceipt(root);
    const image = readJson(imageReceipt);
    image.images.worker.digest = `sha256:${"2".repeat(63)}`;
    writeFileSync(imageReceipt, JSON.stringify(image));
    const calls = [];
    await assert.rejects(
      runDecision11("verify", ["--verify-receipt", receipt, "--image-receipt", imageReceipt, "--head", SOURCE_HEAD, "--evidence-out", join(root, "evidence.json")], {
        runner: verificationRunner(calls),
        now: nowAt(),
      }),
      /worker digest.*immutable and complete/i,
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify compares exact repositories and 64-hex digests in app and relay contexts", async () => {
  const { runDecision11 } = await implementationApi();
  for (const [key, liveReference] of [
    ["portal", `${TEST_ACR_HOST}/pilotswarm-portal-lookalike@${TEST_IMAGE_DIGESTS.portal}`],
    ["worker", `${TEST_ACR_HOST}/pilotswarm-worker@sha256:${"2".repeat(63)}`],
    ["originProxy", `${TEST_ACR_HOST}/decision11-origin-proxy@sha256:${"a".repeat(64)}`],
    ["relay", `${TEST_ACR_HOST}/decision11-vpn-relay@sha256:${"b".repeat(64)}`],
  ]) {
    const root = tempRoot();
    try {
      const receipt = verifyReceipt(root);
      const imageReceipt = reviewedImageReceipt(root);
      await assert.rejects(
        runDecision11("verify", ["--verify-receipt", receipt, "--image-receipt", imageReceipt, "--head", SOURCE_HEAD, "--evidence-out", join(root, "evidence.json")], {
          runner: verificationRunner([], { images: { [key]: liveReference } }),
          now: nowAt(),
        }),
        new RegExp(key === "portal" ? "pilotswarm-portal|decision11-portal" : `${key}|image`, "i"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("verify parses the real AKS agent-pool shape and rejects private-cluster or zone drift", async () => {
  const { runDecision11 } = await implementationApi();
  for (const [mutateAks, expected] of [
    [(aks) => { aks.apiServerAccessProfile.enablePrivateCluster = false; }, /private-cluster mode/i],
    [(aks) => { aks.agentPoolProfiles[0].availabilityZones = ["1"]; }, /zones/i],
    [(aks) => { aks.agentPoolProfiles[0].count = 3; }, /node count/i],
  ]) {
    const root = tempRoot();
    try {
      const receipt = verifyReceipt(root);
      const imageReceipt = reviewedImageReceipt(root);
      await assert.rejects(
        runDecision11("verify", ["--verify-receipt", receipt, "--image-receipt", imageReceipt, "--head", SOURCE_HEAD, "--evidence-out", join(root, "evidence.json")], {
          runner: verificationRunner([], { mutateAks }),
          now: nowAt(),
        }),
        expected,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function smokeReceipt(root) {
  return jsonFile(root, "smoke-receipt.json", {
    schemaVersion: 1,
    kind: "real-decision-smoke",
    reviewed: true,
    apiBaseUrl: "http://decision11-vpn.invalid",
    smokePath: "/api/internal/decision11-demo/run",
    authEnv: "DECISION11_TEST_API_TOKEN",
    demos: [
      { id: "choice-routing", input: { ticket: "synthetic routing case" } },
      { id: "noul-gate", input: { claim: "synthetic claim" } },
      { id: "score-downstream-to-script-and-agent", input: { artifact: "synthetic artifact" } },
      { id: "uncertain-policy", input: { subject: "synthetic ambiguity" } },
      { id: "recovery-replay-single-accepted-completion", input: { incident: "synthetic recovery" } },
      { id: "missing-default-negative-diagnostic", input: { diagnostic: true }, expectRefusal: true },
    ],
  });
}

function smokeOutput(id) {
  const common = {
    ok: true,
    sessionId: `synthetic-session-${id}`,
    model: "azure-foundry:ps-decision-1-1",
    transport: "live-decision",
    requestCount: 1,
    billableTokens: 8,
  };
  if (id === "choice-routing") return { ...common, result: { selection: "billing", route: "billing", distribution: { engineering: 0.03, billing: 0.93, support: 0.04 } } };
  if (id === "noul-gate") return { ...common, result: { positiveProbability: 0.5, threshold: 0.5, decision: "yes", confidence: 0.5 } };
  if (id === "score-downstream-to-script-and-agent") return { ...common, result: { score: 2.4, distribution: [{ label: "Cosmetic", probability: 0.05 }, { label: "Minor", probability: 0.15 }, { label: "Major", probability: 0.4 }, { label: "Critical", probability: 0.4 }], scriptScore: 2.4, agentScore: 2.4 } };
  if (id === "uncertain-policy") return { ...common, result: { outcome: "uncertain", confidence: 0.62, threshold: 0.8, selection: "billing" } };
  if (id === "recovery-replay-single-accepted-completion") return { ...common, providerAttempts: 2, result: { acceptedSemanticCompletions: 1, duplicateDurableCompletions: 0, outcome: "succeeded" } };
  return {
    ok: false,
    sessionId: `synthetic-session-${id}`,
    requestCount: 0,
    billableTokens: 0,
    error: {
      code: "WORKFLOW_DECISION_MODEL_UNAVAILABLE",
      message: "Decision nodes are unavailable because no eligible Cluster Decision Default is configured.",
    },
  };
}

test("smoke proves all five real Decision behaviors plus the missing-default diagnostic and sanitizes session IDs", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const receipt = smokeReceipt(root);
    const evidence = join(root, "smoke-evidence.json");
    const calls = [];
    const runner = async (command, args, options = {}) => {
      calls.push({ command, args, options });
      const request = JSON.parse(options.input);
      return { status: 0, stdout: JSON.stringify(smokeOutput(request.id)), stderr: "" };
    };
    const result = await runDecision11("smoke", ["--smoke-receipt", receipt, "--evidence-out", evidence], {
      runner,
      now: nowAt(),
      env: { DECISION11_TEST_API_TOKEN: "synthetic-test-token" },
    });
    assert.equal(calls.length, 6);
    assert.equal(result.evidence.positiveDemos, 5);
    assert.equal(result.evidence.negativeDiagnostic, "missing-default-negative-diagnostic");
    const saved = JSON.stringify(readJson(evidence));
    assert.doesNotMatch(saved, /synthetic-session-/);
    assert.doesNotMatch(saved, /synthetic-test-token/);
    assert.equal(Object.keys(result.evidence.sessions).length, 6);
    for (const id of Object.values(result.evidence.sessions)) assert.match(id, /^sha256:[0-9a-f]{24}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("smoke refuses a fabricated uncertainty or duplicate replay completion", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const receipt = smokeReceipt(root);
    const calls = [];
    await assert.rejects(
      runDecision11("smoke", ["--smoke-receipt", receipt, "--evidence-out", join(root, "evidence.json")], {
        runner: async (_command, _args, options = {}) => {
          calls.push(options);
          const id = JSON.parse(options.input).id;
          const output = smokeOutput(id);
          if (id === "recovery-replay-single-accepted-completion") output.result.duplicateDurableCompletions = 1;
          return { status: 0, stdout: JSON.stringify(output), stderr: "" };
        },
        now: nowAt(),
        env: { DECISION11_TEST_API_TOKEN: "synthetic-test-token" },
      }),
      /exactly one accepted.*replay/i,
    );
    assert.equal(calls.length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function teardownReceipt(root) {
  return jsonFile(root, "teardown-receipt.json", {
    schemaVersion: 1,
    kind: "exact-asset-teardown",
    reviewed: true,
    assets: [
      {
        kind: "kubernetes",
        context: "decision11-app",
        resource: "service",
        namespace: "pse-decision11-preview",
        name: "decision11-portal-vpn",
        uid: "portal-service-uid",
        apiPath: "/api/v1/namespaces/pse-decision11-preview/services/decision11-portal-vpn",
      },
      {
        kind: "kubernetes",
        context: "decision11-relay",
        resource: "service",
        namespace: "pse-decision11-relay",
        name: "pse-decision11-vpn-relay",
        uid: "relay-service-uid",
        apiPath: "/api/v1/namespaces/pse-decision11-relay/services/pse-decision11-vpn-relay",
      },
    ],
  });
}

function teardownConfirmation(receiptPath) {
  const receipt = readJson(receiptPath);
  const list = receipt.assets.map((asset) => `${asset.kind}:${asset.namespace ?? asset.resourceGroup}:${asset.name}`).sort().join(",");
  return `DELETE pse-decision11-test EXACT ASSETS [${list}]`;
}

function teardownRunner(calls) {
  return async (command, args, options = {}) => {
    const call = { command, args, options };
    calls.push(call);
    if (command === "kubectl" && args.includes("get")) {
      const name = args[args.indexOf("get") + 2];
      return { status: 0, stdout: JSON.stringify({ metadata: { name, uid: `${name === "decision11-portal-vpn" ? "portal" : "relay"}-service-uid`, resourceVersion: "7" } }), stderr: "" };
    }
    return { status: 0, stdout: "{}", stderr: "" };
  };
}

test("teardown requires the exact confirmation list, checks every UID, closes access, then deletes only listed assets", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const receipt = teardownReceipt(root);
    const evidence = join(root, "teardown-evidence.json");
    const calls = [];
    const result = await runDecision11("teardown", [
      "--teardown-receipt", receipt,
      "--asset-confirmation", teardownConfirmation(receipt),
      "--evidence-out", evidence,
    ], { runner: teardownRunner(calls), now: nowAt() });
    const closure = calls.findIndex((call) => call.command === "kubectl" && call.args.includes("scale"));
    const firstDelete = calls.findIndex((call) => call.command === "kubectl" && call.args.includes("delete"));
    assert.notEqual(closure, -1);
    assert.ok(firstDelete > closure);
    assert.equal(calls.filter((call) => call.command === "kubectl" && call.args.includes("delete")).length, 2);
    for (const call of calls.filter((entry) => entry.args.includes("delete"))) {
      assert.doesNotMatch(call.args.join(" "), /namespace|database\b/i);
      assert.match(String(call.options.input), /uid|preconditions/i);
    }
    assert.equal(result.evidence.assetsDeleted, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("teardown refuses a UID mismatch before any delete", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const receipt = teardownReceipt(root);
    const runner = teardownRunner([]);
    const calls = [];
    const mismatch = async (command, args, options = {}) => {
      calls.push({ command, args, options });
      if (command === "kubectl" && args.includes("get")) {
        const name = args[args.indexOf("get") + 2];
        return { status: 0, stdout: JSON.stringify({ metadata: { name, uid: "replacement-uid", resourceVersion: "8" } }), stderr: "" };
      }
      return runner(command, args, options);
    };
    await assert.rejects(
      runDecision11("teardown", [
        "--teardown-receipt", receipt,
        "--asset-confirmation", teardownConfirmation(receipt),
        "--evidence-out", join(root, "evidence.json"),
      ], { runner: mismatch, now: nowAt() }),
      /UID precondition|replacement UID/i,
    );
    assert.equal(calls.filter((call) => call.args.includes("delete")).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Kubernetes teardown submits exact UID preconditions so a replacement wins the race safely", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const receipt = teardownReceipt(root);
    let replacementDeleted = false;
    const calls = [];
    const runner = async (command, args, options = {}) => {
      calls.push({ command, args, options });
      if (command === "kubectl" && args.includes("get")) {
        const name = args[args.indexOf("get") + 2];
        return {
          status: 0,
          stdout: JSON.stringify({ metadata: { name, uid: `${name === "decision11-portal-vpn" ? "portal" : "relay"}-service-uid`, resourceVersion: "7" } }),
          stderr: "",
        };
      }
      if (command === "kubectl" && args.includes("delete")) {
        const body = JSON.parse(options.input);
        assert.equal(body.preconditions.uid, options.uid);
        assert.equal(body.preconditions.resourceVersion, "7");
        replacementDeleted = body.preconditions.uid === "replacement-uid";
        return { status: 409, stdout: "", stderr: "the UID precondition failed for a replacement object" };
      }
      return { status: 0, stdout: "{}", stderr: "" };
    };
    await assert.rejects(
      runDecision11("teardown", [
        "--teardown-receipt", receipt,
        "--asset-confirmation", teardownConfirmation(receipt),
        "--evidence-out", join(root, "evidence.json"),
      ], { runner, now: nowAt() }),
      /exited 409[\s\S]*UID precondition/i,
    );
    assert.equal(replacementDeleted, false);
    assert.equal(calls.filter((call) => call.command === "kubectl" && call.args.includes("delete")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Azure teardown stops after UID precheck and cannot delete a raced replacement", async () => {
  const { runDecision11 } = await implementationApi();
  const root = tempRoot();
  try {
    const receipt = teardownReceipt(root);
    const value = readJson(receipt);
    const azure = {
      kind: "azure",
      resourceGroup: TEST_RESOURCE_GROUP,
      name: "wdmchkpsedecision11sa",
      resourceId: `/subscriptions/${TEST_SUBSCRIPTION_ID}/resourceGroups/${TEST_RESOURCE_GROUP}/providers/Microsoft.Storage/storageAccounts/wdmchkpsedecision11sa`,
      uid: "storage-test-uid",
    };
    value.assets = [azure];
    writeFileSync(receipt, JSON.stringify(value));
    let liveUid = azure.uid;
    let replacementDeleted = false;
    const calls = [];
    const runner = async (command, args, options = {}) => {
      calls.push({ command, args, options });
      if (command === "az" && args[0] === "resource" && args[1] === "show") {
        const result = { status: 0, stdout: JSON.stringify({ name: azure.name, tags: { "wdm-resource-uid": liveUid } }), stderr: "" };
        liveUid = "replacement-uid";
        return result;
      }
      if (command === "az" && args[0] === "resource" && args[1] === "delete") {
        replacementDeleted = liveUid === "replacement-uid";
        return { status: 0, stdout: "{}", stderr: "" };
      }
      return { status: 0, stdout: "{}", stderr: "" };
    };
    const evidencePath = join(root, "evidence.json");
    const result = await runDecision11("teardown", [
      "--teardown-receipt", receipt,
      "--asset-confirmation", teardownConfirmation(receipt),
      "--evidence-out", evidencePath,
    ], { runner, now: nowAt() });
    assert.equal(result.ok, false);
    assert.equal(liveUid, "replacement-uid");
    assert.equal(replacementDeleted, false);
    assert.equal(calls.filter((call) => call.command === "az" && call.args[1] === "delete").length, 0);
    assert.equal(result.evidence.assetsDeleted, 0);
    assert.equal(result.evidence.assetsPrechecked, 1);
    assert.equal(result.evidence.operatorDeletionRequired.length, 1);
    assert.equal(result.evidence.operatorDeletionRequired[0].action, "operator-delete");
    assert.match(result.evidence.operatorDeletionRequired[0].requirement, /atomic server-side resource precondition/i);
    assert.equal(readJson(evidencePath).state, "operator-action-required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the deploy-script suite wires the new test file", () => {
  const pkg = readJson(join(REPO_ROOT, "package.json"));
  assert.match(pkg.scripts["test:deploy-scripts"], /deploy\/scripts\/test\/decision11-environment\.test\.mjs/);
});
