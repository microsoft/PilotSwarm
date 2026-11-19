#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, fileURLToPath } from "node:url";
import { basename, resolve } from "node:path";
import { redactArgs, resolveCli } from "../../scripts/lib/common.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(SCRIPT_DIR, "config.json");
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

const PLAN_ARTIFACT_SHA256 = "07d2309b79a857661b4782c420809e048513b6b61cb787b5f9681f1bfc63bdf2";
const MUTATING_COMMANDS = new Set(["setup", "reset", "smoke", "teardown"]);
const COMMANDS = new Set(["setup", "reset", "verify", "smoke", "teardown"]);
const ALLOWED_KUBE_CONTEXTS = new Set(["decision11-app", "decision11-relay"]);
const ALLOWED_KUBE_NAMESPACES = new Set(Object.values(CONFIG.namespaces));
const POSITIVE_DEMOS = [
  "choice-routing",
  "noul-gate",
  "score-downstream-to-script-and-agent",
  "uncertain-policy",
  "recovery-replay-single-accepted-completion",
];
const NEGATIVE_DEMO = "missing-default-negative-diagnostic";
const DEMO_RESET_PATH = "/api/internal/decision11-demo/reset";
const DEMO_RUN_PATH = "/api/internal/decision11-demo/run";
const AUTH_ENV_NAME = "DECISION11_TEST_API_TOKEN";
const CAPTURE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const PROHIBITED_REUSED_OBJECT_RE = new RegExp(["wf" + "simp", "can" + "vas"].join("|"), "i");
const FORBIDDEN_RECEIPT_KEYS = new Set([
  "password",
  "privatekey",
  "clientkey",
  "keybytes",
  "certificatebytes",
  "pem",
  "token",
  "accesstoken",
  "refreshtoken",
  "sastoken",
  "connectionstring",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertString(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} must be a non-empty string.`);
  return value;
}

function assertExact(actual, expected, label) {
  invariant(actual === expected, `${label} does not match the frozen plan (expected ${expected}, received ${String(actual)}).`);
}

function parseFlags(argv, required, label) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    invariant(token.startsWith("--"), `${label}: unexpected positional argument ${JSON.stringify(token)}.`);
    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    invariant(name && !Object.hasOwn(out, name), `${label}: duplicate or empty flag --${name}.`);
    let value;
    if (equals === -1) {
      index += 1;
      invariant(index < argv.length, `${label}: --${name} requires a value.`);
      value = argv[index];
      invariant(!value.startsWith("--"), `${label}: --${name} requires a value.`);
    } else {
      value = token.slice(equals + 1);
      invariant(value !== "", `${label}: --${name} requires a value.`);
    }
    out[name] = value;
  }
  for (const name of required) invariant(Object.hasOwn(out, name), `${label}: missing required --${name}.`);
  return out;
}

function readJsonFile(path, label) {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    throw new Error(`${label} is unreadable at ${path}: ${error.message}`);
  }
  invariant(stat.isFile(), `${label} must be a regular file: ${path}`);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${label} could not be read at ${path}: ${error.message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    invariant(isRecord(parsed), `${label} must contain a JSON object.`);
    return parsed;
  } catch (error) {
    if (/must contain/.test(error.message)) throw error;
    throw new Error(`${label} is not valid JSON at ${path}: ${error.message}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function findForbiddenMaterial(value, path = "receipt") {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenMaterial(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RECEIPT_KEYS.has(key.replace(/[-_]/g, "").toLowerCase())) return `${path}.${key}`;
    const found = findForbiddenMaterial(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function readSafeReceipt(path, label) {
  const receipt = readJsonFile(path, label);
  const field = findForbiddenMaterial(receipt);
  invariant(!field, `${label} contains forbidden secret or private material at ${field}.`);
  return receipt;
}

function assertSchema(receipt, label) {
  assertExact(receipt.schemaVersion, 1, `${label} schemaVersion`);
}

function currentTime(now) {
  const value = typeof now === "function" ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  invariant(Number.isFinite(date.getTime()), `The command clock returned an invalid time.`);
  return date;
}

function assertMutable(command, now) {
  if (!MUTATING_COMMANDS.has(command)) return;
  const at = currentTime(now);
  const closure = Date.parse(CONFIG.expiry.closureStartsAt);
  invariant(Number.isFinite(closure), "The frozen closure deadline is invalid.");
  invariant(
    at.getTime() < closure,
    `Refusing ${command}: mutating commands must stop at or inside the closure lead time ${CONFIG.expiry.closureStartsAt}.`,
  );
}

function sanitizeCommandError(command, args, status, stderr) {
  const safeArgs = redactArgs(args.map(String));
  const text = String(stderr ?? "")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer ***")
    .replace(/(token|password|secret|sas)[=:]\s*[^\s,;]+/gi, "$1=***")
    .slice(0, 4000);
  return new Error(`${command} ${safeArgs.join(" ")} exited ${status}${text ? `\n${text}` : ""}`);
}

async function invoke(runner, command, args, options = {}) {
  let result;
  try {
    result = await runner(command, args, options);
  } catch (error) {
    throw new Error(`Failed to run ${command} ${redactArgs(args.map(String)).join(" ")}: ${error.message}`);
  }
  invariant(isRecord(result) && Number.isInteger(result.status), `${command} runner returned an invalid result.`);
  if (result.status !== 0) throw sanitizeCommandError(command, args, result.status, result.stderr);
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    httpStatus: result.httpStatus,
  };
}

function parseRunnerJson(result, label) {
  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

async function defaultRunner(command, args, options = {}) {
  if (command === "curl") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
    try {
      const response = await fetch(options.url, {
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        body: options.input,
        redirect: "error",
        signal: controller.signal,
      });
      return {
        status: 0,
        stdout: await response.text(),
        stderr: response.ok ? "" : `HTTP ${response.status} ${response.statusText}`,
        httpStatus: response.status,
      };
    } catch (error) {
      return { status: 1, stdout: "", stderr: error.message };
    } finally {
      clearTimeout(timeout);
    }
  }

  let effectiveArgs = [...args];
  if (command === "kubectl" && options.deleteApiPath) {
    const contextIndex = effectiveArgs.indexOf("--context");
    invariant(contextIndex !== -1 && contextIndex + 1 < effectiveArgs.length, "atomic Kubernetes delete requires a reviewed context.");
    effectiveArgs = [
      "--context", effectiveArgs[contextIndex + 1],
      "delete", "--raw", options.deleteApiPath, "-f", "-",
    ];
  } else if (command === "kubectl" && options.namespace && !effectiveArgs.includes("--namespace")) {
    effectiveArgs.push("--namespace", options.namespace);
  }
  const cli = resolveCli(command);
  const result = spawnSync(cli, effectiveArgs, {
    shell: false,
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: CAPTURE_MAX_BUFFER_BYTES,
  });
  if (result.error) {
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.error.message };
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function writeEvidence(path, evidence) {
  assertString(path, "evidence output path");
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function validateConfig() {
  assertExact(CONFIG.environment, "pse-decision11-test", "config environment");
  assertExact(CONFIG.receiptIds.plan, "pse/decision-env/frozen-create-plan", "config frozen plan receipt");
  assertExact(CONFIG.target.id, "ai-ops-independent-tests", "config target id");
  assertExact(CONFIG.target.subscriptionId, "3de368f3-1dac-475a-b39a-3afb5f21e280", "config subscription");
  assertExact(CONFIG.target.location, "westus2", "config location");
  assertExact(CONFIG.target.resourceGroup, "wdmchk-pse-decision11-test-rg", "config resource group");
  assertExact(CONFIG.expiry.expiresAt, "2026-11-22T04:17:38.699Z", "config expiry");
  assertExact(CONFIG.expiry.closureStartsAt, "2026-11-22T04:12:38.699Z", "config closure start");
  assertExact(CONFIG.network.relaySourceCidr, "4.148.50.242/32", "config relay source");
  assertExact(CONFIG.network.vpnSourceCidr, "172.16.200.0/24", "config VPN source");
  invariant(!PROHIBITED_REUSED_OBJECT_RE.test(JSON.stringify(CONFIG)), "config cannot name a reused sibling resource.");
  invariant(!/0\.0\.0\.0\/0/.test(JSON.stringify(CONFIG)), "config cannot contain an unrestricted network rule.");
  const forbidden = findForbiddenMaterial(CONFIG);
  invariant(!forbidden, `config contains a secret-like field at ${forbidden}.`);
}

function validateTargetReceipt(receipt) {
  assertSchema(receipt, "frozen plan receipt");
  assertExact(receipt.receiptId, CONFIG.receiptIds.plan, "frozen plan receipt id");
  assertExact(receipt.kind, "frozen-plan", "frozen plan receipt kind");
  assertExact(receipt.artifactSha256, PLAN_ARTIFACT_SHA256, "frozen plan receipt artifact hash");
  assertExact(receipt.version, 1, "frozen plan receipt version");
  assertExact(receipt.targetId, CONFIG.target.id, "frozen plan receipt target id");
  assertExact(receipt.subscriptionId, CONFIG.target.subscriptionId, "frozen plan receipt subscription");
  assertExact(receipt.location, CONFIG.target.location, "frozen plan receipt location");
  assertExact(receipt.resourceGroup, CONFIG.target.resourceGroup, "frozen plan receipt resource group");
  assertExact(receipt.expiresAt, CONFIG.expiry.expiresAt, "frozen plan receipt expiry");
  assertExact(receipt.closureStartsAt, CONFIG.expiry.closureStartsAt, "frozen plan receipt closure");
}

function validateCostReceipt(receipt) {
  assertSchema(receipt, "cost receipt");
  assertExact(receipt.receiptId, CONFIG.receiptIds.costFact, "cost receipt id");
  assertExact(receipt.kind, "cost-acceptance", "cost receipt kind");
  assertExact(receipt.section, "cost", "cost receipt section");
  assertExact(receipt.currency, CONFIG.cost.currency, "cost receipt currency");
  assertExact(receipt.expectedRoundedUsd, CONFIG.cost.expectedRounded, "cost receipt expected amount");
  assertExact(receipt.ceilingUsd, CONFIG.cost.ceiling, "cost receipt ceiling");
  assertExact(receipt.decisionProofRequestMax, CONFIG.cost.decisionProofRequestMax, "cost receipt request maximum");
  assertExact(receipt.decisionBillableTokensMax, CONFIG.cost.decisionBillableTokensMax, "cost receipt billable-token maximum");
  assertExact(receipt.accepted, true, "cost receipt acceptance");
}

function validateApprovalReceipt(receipt) {
  assertSchema(receipt, "approval receipt");
  assertExact(receipt.receiptId, CONFIG.receiptIds.createApproval, "approval receipt id");
  assertExact(receipt.vpnReceiptId, CONFIG.receiptIds.vpnApproval, "VPN approval receipt id");
  assertExact(receipt.ownerSubject, CONFIG.owner.subject, "approval receipt owner subject");
  assertExact(receipt.ownerEmail, CONFIG.owner.email, "approval receipt owner email");
  assertExact(receipt.approvedAt, CONFIG.expiry.anchor, "approval receipt timestamp");
  assertExact(receipt.expiresAt, CONFIG.expiry.expiresAt, "approval receipt expiry");
}

function validateSourceReceipt(receipt, head) {
  assertSchema(receipt, "source receipt");
  assertExact(receipt.kind, "reviewed-source", "source receipt kind");
  assertExact(receipt.reviewed, true, "source receipt review state");
  assertExact(receipt.head, head, "source receipt head");
  invariant(/^[0-9a-f]{40}$/.test(head), "source head must be a full lowercase 40-character commit id.");
  invariant(/^[0-9a-f]{64}$/.test(receipt.archiveSha256), "source receipt archiveSha256 must be a SHA-256 digest.");
}

function validateImageReceipt(receipt, head) {
  assertSchema(receipt, "image receipt");
  assertExact(receipt.kind, "reviewed-images", "image receipt kind");
  assertExact(receipt.sourceHead, head, "image receipt source head");
  invariant(isRecord(receipt.images), "image receipt images must be an object.");
  assertExact(Object.keys(receipt.images).sort().join(","), Object.keys(CONFIG.images).sort().join(","), "image receipt image set");
  for (const [key, expectedName] of Object.entries(CONFIG.images)) {
    const image = receipt.images[key];
    invariant(isRecord(image), `image receipt is missing ${key}.`);
    assertExact(image.name, expectedName, `image receipt ${key} name`);
    invariant(/^sha256:[0-9a-f]{64}$/.test(image.digest), `image receipt ${key} digest must be immutable and complete.`);
  }
}

function validateTrustReceipt(receipt) {
  assertSchema(receipt, "trust material receipt");
  const allowed = [
    "caName",
    "clientSecretRef",
    "clientUriSan",
    "kind",
    "publicCertificatesOnly",
    "schemaVersion",
    "serverDnsSan",
    "serverSecretRef",
  ];
  const actual = Object.keys(receipt).sort();
  invariant(
    JSON.stringify(actual) === JSON.stringify(allowed.sort()),
    "trust material receipt may contain only secret references and public certificate metadata; private key or certificate bytes are forbidden.",
  );
  assertExact(receipt.kind, "trust-material-references", "trust material receipt kind");
  assertExact(receipt.publicCertificatesOnly, true, "trust material receipt public-only state");
  assertExact(receipt.caName, CONFIG.network.caName, "trust material CA name");
  assertExact(receipt.clientSecretRef, CONFIG.network.clientSecretRef, "trust material client Secret reference");
  assertExact(receipt.serverSecretRef, CONFIG.network.serverSecretRef, "trust material server Secret reference");
  assertExact(receipt.clientUriSan, CONFIG.network.clientUriSan, "trust material client URI SAN");
  assertExact(receipt.serverDnsSan, CONFIG.network.serverDnsSan, "trust material server DNS SAN");
}

function validateLeaseReceipt(receipt) {
  assertSchema(receipt, "lease receipt");
  assertExact(receipt.kind, "operation-fences", "lease receipt kind");
  assertExact(receipt.operationId, CONFIG.fences.operationId, "lease receipt operation id");
  assertExact(receipt.targetId, CONFIG.target.id, "lease receipt target id");
  assertExact(receipt.generation, CONFIG.fences.generation, "lease receipt generation");
  assertExact(receipt.epoch, CONFIG.fences.epoch, "lease receipt epoch");
  assertExact(receipt.expiresAt, CONFIG.expiry.expiresAt, "lease receipt expiry");
  assertExact(receipt.closureStartsAt, CONFIG.expiry.closureStartsAt, "lease receipt closure");
  assertString(receipt.holder, "lease receipt holder");
  invariant(Array.isArray(receipt.objects) && receipt.objects.length === 3, "lease receipt must contain exactly the three frozen fence objects.");
  const expected = [CONFIG.fences.bootstrapLock, CONFIG.fences.hostLock, CONFIG.fences.featureLease]
    .map((item) => `${item.namespace}/${item.name}`)
    .sort();
  const actual = receipt.objects.map((item) => {
    invariant(isRecord(item), "each lease receipt object must be an object.");
    assertString(item.namespace, "lease object namespace");
    assertString(item.name, "lease object name");
    assertString(item.uid, "lease object UID");
    assertString(item.resourceVersion, "lease object resourceVersion");
    return `${item.namespace}/${item.name}`;
  }).sort();
  invariant(JSON.stringify(actual) === JSON.stringify(expected), "lease receipt object identities do not match the frozen fences.");
}

function validateLedgerReceipt(receipt) {
  assertSchema(receipt, "ledger receipt");
  assertExact(receipt.kind, "canonical-ledger-plan", "ledger receipt kind");
  assertExact(receipt.operationId, CONFIG.ledger.operationId, "ledger receipt operation id");
  assertExact(receipt.targetId, CONFIG.target.id, "ledger receipt target id");
  assertExact(receipt.revision, CONFIG.ledger.revision, "ledger receipt revision");
  invariant(isRecord(receipt.resourceUids), "ledger receipt resourceUids must be an object.");
  for (const [name, expected] of Object.entries(CONFIG.ledger.resourceUids)) {
    assertExact(receipt.resourceUids[name], expected, `ledger receipt ${name} UID`);
  }
  assertExact(Object.keys(receipt.resourceUids).length, Object.keys(CONFIG.ledger.resourceUids).length, "ledger receipt UID count");
}

function safeManifestText(raw, label) {
  const text = String(raw);
  invariant(!/(?:^|\r?\n)[\s]*0\.0\.0\.0\/0(?:\s|$)/m.test(text), `${label} contains an unrestricted network rule.`);
  invariant(!PROHIBITED_REUSED_OBJECT_RE.test(text), `${label} names a prohibited reused resource.`);
  invariant(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(text), `${label} embeds private key material.`);
  invariant(!/\b(?:stringData|data):[\s\S]{0,200}\b(?:tls\.key|privateKey|clientKey)\b/i.test(text), `${label} embeds secret bytes.`);
}

function validateManifestReceipt(receipt, head) {
  assertSchema(receipt, "manifest receipt");
  assertExact(receipt.kind, "reviewed-manifests", "manifest receipt kind");
  assertExact(receipt.reviewed, true, "manifest receipt review state");
  assertExact(receipt.sourceHead, head, "manifest receipt source head");
  invariant(Array.isArray(receipt.entries) && receipt.entries.length > 0, "manifest receipt must contain at least one caller-supplied manifest.");
  invariant(receipt.entries.length <= 64, "manifest receipt exceeds the 64-manifest safety limit.");
  const paths = new Set();
  return receipt.entries.map((entry, index) => {
    invariant(isRecord(entry), `manifest receipt entry ${index} must be an object.`);
    assertExact(entry.kind, "kubernetes", `manifest receipt entry ${index} kind`);
    assertExact(typeof entry.path, "string", `manifest receipt entry ${index} path type`);
    assertExact(typeof entry.context, "string", `manifest receipt entry ${index} context type`);
    invariant(ALLOWED_KUBE_CONTEXTS.has(entry.context), `manifest receipt entry ${index} uses an unreviewed Kubernetes context.`);
    invariant(/^[0-9a-f]{64}$/.test(entry.sha256), `manifest receipt entry ${index} hash must be SHA-256.`);
    const path = resolve(process.cwd(), entry.path);
    invariant(!paths.has(path), `manifest receipt contains a duplicate path: ${path}`);
    paths.add(path);
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      throw new Error(`reviewed manifest is unreadable at ${path}: ${error.message}`);
    }
    invariant(stat.isFile(), `reviewed manifest must be a regular file: ${path}`);
    const raw = readFileSync(path);
    invariant(sha256(raw) === entry.sha256, `reviewed manifest hash does not match ${path}.`);
    safeManifestText(raw.toString("utf8"), `reviewed manifest ${basename(path)}`);
    return { ...entry, path };
  });
}

async function measureRelaySource(runner) {
  const cluster = CONFIG.network.relayCluster;
  const pipIdResult = await invoke(runner, "az", [
    "aks", "show",
    "--subscription", cluster.subscriptionId,
    "--resource-group", cluster.resourceGroup,
    "--name", cluster.name,
    "--query", "networkProfile.loadBalancerProfile.effectiveOutboundIPs[0].id",
    "-o", "tsv",
  ]);
  const pipId = pipIdResult.stdout.trim();
  assertExact(pipId, cluster.outboundPublicIpId, "execution-time relay outbound public-IP identity");

  const ipResult = await invoke(runner, "az", [
    "network", "public-ip", "show",
    "--ids", pipId,
    "--query", "ipAddress",
    "-o", "tsv",
  ]);
  const ip = ipResult.stdout.trim();
  const sourceCidr = `${ip}/32`;
  invariant(sourceCidr === CONFIG.network.relaySourceCidr, `Measured relay source ${sourceCidr} does not match ${CONFIG.network.relaySourceCidr}.`);

  const lbResult = await invoke(runner, "az", [
    "network", "lb", "show",
    "--ids", cluster.outboundLoadBalancerId,
    "-o", "json",
  ]);
  const lb = parseRunnerJson(lbResult, "relay load balancer read");
  const rule = Array.isArray(lb.outboundRules)
    ? lb.outboundRules.find((item) => item?.name === cluster.outboundRule)
    : null;
  invariant(rule, `Relay outbound rule ${cluster.outboundRule} is missing.`);
  const frontends = Array.isArray(rule.frontendIPConfigurations) ? rule.frontendIPConfigurations : [];
  invariant(
    frontends.some((frontend) => frontend?.publicIPAddress?.id === pipId),
    `Relay outbound rule does not reference the measured public-IP ${pipId}.`,
  );
  return { publicIpId: pipId, ip, sourceCidr };
}

async function runSetup(argv, deps) {
  const flags = parseFlags(argv, [
    "target-id",
    "head",
    "plan-receipt",
    "cost-receipt",
    "approval-receipt",
    "source-receipt",
    "image-receipt",
    "trust-receipt",
    "lease-receipt",
    "ledger-receipt",
    "manifest-receipt",
    "evidence-out",
  ], "setup");
  assertExact(flags["target-id"], CONFIG.target.id, "setup target id");
  validateTargetReceipt(readSafeReceipt(flags["plan-receipt"], "frozen plan receipt"));
  validateCostReceipt(readSafeReceipt(flags["cost-receipt"], "cost receipt"));
  validateApprovalReceipt(readSafeReceipt(flags["approval-receipt"], "approval receipt"));
  validateSourceReceipt(readSafeReceipt(flags["source-receipt"], "source receipt"), flags.head);
  validateImageReceipt(readSafeReceipt(flags["image-receipt"], "image receipt"), flags.head);
  validateTrustReceipt(readSafeReceipt(flags["trust-receipt"], "trust material receipt"));
  validateLeaseReceipt(readSafeReceipt(flags["lease-receipt"], "lease receipt"));
  validateLedgerReceipt(readSafeReceipt(flags["ledger-receipt"], "ledger receipt"));
  const manifests = validateManifestReceipt(readSafeReceipt(flags["manifest-receipt"], "manifest receipt"), flags.head);

  const measurement = await measureRelaySource(deps.runner);
  for (const entry of manifests) {
    assertMutable("setup", deps.now);
    await invoke(deps.runner, "kubectl", ["--context", entry.context, "apply", "-f", entry.path]);
  }
  const evidence = {
    ok: true,
    command: "setup",
    observedAt: currentTime(deps.now).toISOString(),
    targetId: CONFIG.target.id,
    subscriptionId: CONFIG.target.subscriptionId,
    resourceGroup: CONFIG.target.resourceGroup,
    sourceHead: flags.head,
    relaySourceCidr: measurement.sourceCidr,
    relayPublicIpId: measurement.publicIpId,
    manifestsApplied: manifests.length,
    manifestHashes: manifests.map((entry) => ({ path: entry.path, sha256: entry.sha256, context: entry.context })),
    expiresAt: CONFIG.expiry.expiresAt,
    closureStartsAt: CONFIG.expiry.closureStartsAt,
  };
  writeEvidence(flags["evidence-out"], evidence);
  return { ok: true, evidence };
}

function validateApiBaseUrl(value, label) {
  const url = new URL(assertString(value, label));
  invariant(["http:", "https:"].includes(url.protocol), `${label} must use HTTP or HTTPS.`);
  invariant(!url.username && !url.password && !url.hash, `${label} cannot contain credentials or a fragment.`);
  return url;
}

async function postApplicationJson(runner, url, body, authValue) {
  const result = await invoke(runner, "curl", [
    "--silent",
    "--show-error",
    "--request", "POST",
    "--header", "Content-Type: application/json",
    url,
  ], {
    url,
    method: "POST",
    input: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${authValue}`,
    },
  });
  return parseRunnerJson(result, `application request ${url}`);
}

async function getApplicationJson(runner, url) {
  const result = await invoke(runner, "curl", ["--silent", "--show-error", "--request", "GET", url], {
    url,
    method: "GET",
  });
  return parseRunnerJson(result, `application read ${url}`);
}

function readAuthValue(receipt, env) {
  assertExact(receipt.authEnv, AUTH_ENV_NAME, "operation receipt auth environment name");
  const value = env[AUTH_ENV_NAME];
  invariant(typeof value === "string" && value.length > 0, `${AUTH_ENV_NAME} is required in the process environment for this application mutation.`);
  return value;
}

function requireIntegerAtLeast(value, minimum, label) {
  invariant(Number.isInteger(value) && value >= minimum, `${label} must be an integer of at least ${minimum}.`);
  return value;
}

async function runReset(argv, deps) {
  const flags = parseFlags(argv, ["reset-receipt", "evidence-out"], "reset");
  const receipt = readSafeReceipt(flags["reset-receipt"], "reset receipt");
  assertSchema(receipt, "reset receipt");
  assertExact(receipt.kind, "synthetic-demo-reset", "reset receipt kind");
  assertExact(receipt.reviewed, true, "reset receipt review state");
  invariant(
    JSON.stringify(receipt.prefixes) === JSON.stringify(CONFIG.demoSessionPrefixes),
    "reset requires the exact six approved synthetic session prefixes and no others.",
  );
  assertExact(receipt.resetPath, DEMO_RESET_PATH, "reset receipt path");
  const baseUrl = validateApiBaseUrl(receipt.apiBaseUrl, "reset API base URL");
  const authValue = readAuthValue(receipt, deps.env);
  const url = new URL(DEMO_RESET_PATH, baseUrl).toString();
  const results = [];
  for (const prefix of CONFIG.demoSessionPrefixes) {
    assertMutable("reset", deps.now);
    const output = await postApplicationJson(deps.runner, url, { action: "remove-and-reseed", prefix }, authValue);
    invariant(output.ok === true, `reset refused prefix ${prefix}.`);
    assertExact(output.prefix, prefix, `reset returned prefix for ${prefix}`);
    results.push({
      prefix,
      removed: requireIntegerAtLeast(output.removed, 0, `reset removed count for ${prefix}`),
      seeded: requireIntegerAtLeast(output.seeded, 0, `reset seeded count for ${prefix}`),
    });
  }
  const evidence = {
    ok: true,
    command: "reset",
    observedAt: currentTime(deps.now).toISOString(),
    prefixes: results.map((item) => item.prefix),
    results,
  };
  writeEvidence(flags["evidence-out"], evidence);
  return { ok: true, evidence };
}

function requireList(value, label) {
  invariant(Array.isArray(value?.items), `${label} must contain an items array.`);
  return value.items;
}

function readOnlyKubeList(context, namespace, resource) {
  return ["--context", context, "--namespace", namespace, "get", resource, "-o", "json"];
}

async function runVerify(argv, deps) {
  const flags = parseFlags(argv, ["verify-receipt", "head", "evidence-out"], "verify");
  invariant(/^[0-9a-f]{40}$/.test(flags.head), "verify source head must be a full lowercase 40-character commit id.");
  const receipt = readSafeReceipt(flags["verify-receipt"], "verify receipt");
  assertSchema(receipt, "verify receipt");
  assertExact(receipt.kind, "read-only-verification", "verify receipt kind");
  assertExact(receipt.reviewed, true, "verify receipt review state");
  assertExact(receipt.appContext, "decision11-app", "verify app context");
  assertExact(receipt.relayContext, "decision11-relay", "verify relay context");
  const baseHealthUrl = new URL(assertString(receipt.portalHealthUrl, "portal health URL"));
  const readinessUrl = new URL(assertString(receipt.readinessUrl, "readiness URL"));
  invariant(["http:", "https:"].includes(baseHealthUrl.protocol), "portal health URL must use HTTP or HTTPS.");
  invariant(["http:", "https:"].includes(readinessUrl.protocol), "readiness URL must use HTTP or HTTPS.");
  invariant(isRecord(receipt.negativeProofs), "verify receipt negativeProofs must be an object.");
  for (const proofName of ["sibling", "nonVpn", "directOrigin"]) {
    const proof = receipt.negativeProofs[proofName];
    invariant(isRecord(proof), `negative proof ${proofName} is missing.`);
    invariant(proof.status === "passed", `negative proof ${proofName} is ${String(proof.status)}; verification failed closed.`);
    assertString(proof.evidenceId, `negative proof ${proofName} evidence id`);
  }

  const azure = parseRunnerJson(await invoke(deps.runner, "az", [
    "resource", "list",
    "--subscription", CONFIG.target.subscriptionId,
    "--resource-group", CONFIG.target.resourceGroup,
    "-o", "json",
  ]), "Azure resource inventory");
  const aks = parseRunnerJson(await invoke(deps.runner, "az", [
    "aks", "show",
    "--subscription", CONFIG.target.subscriptionId,
    "--resource-group", CONFIG.target.resourceGroup,
    "--name", CONFIG.aks.name,
    "-o", "json",
  ]), "AKS verification");
  const lb = parseRunnerJson(await invoke(deps.runner, "az", [
    "network", "lb", "show",
    "--ids", CONFIG.network.relayCluster.outboundLoadBalancerId,
    "-o", "json",
  ]), "relay load balancer verification");
  const policies = parseRunnerJson(await invoke(
    deps.runner,
    "kubectl",
    readOnlyKubeList(receipt.appContext, CONFIG.namespaces.feature, "networkpolicy"),
  ), "network policy verification");
  const services = parseRunnerJson(await invoke(
    deps.runner,
    "kubectl",
    readOnlyKubeList(receipt.appContext, CONFIG.namespaces.feature, "service"),
  ), "service verification");
  const appConfigMaps = parseRunnerJson(await invoke(
    deps.runner,
    "kubectl",
    readOnlyKubeList(receipt.appContext, CONFIG.namespaces.feature, "configmap"),
  ), "app ConfigMap verification");
  const relayConfigMaps = parseRunnerJson(await invoke(
    deps.runner,
    "kubectl",
    readOnlyKubeList(receipt.relayContext, CONFIG.namespaces.relay, "configmap"),
  ), "relay ConfigMap verification");
  const deployments = parseRunnerJson(await invoke(
    deps.runner,
    "kubectl",
    readOnlyKubeList(receipt.appContext, CONFIG.namespaces.feature, "deployment"),
  ), "deployment verification");
  const foundry = parseRunnerJson(await invoke(deps.runner, "az", [
    "cognitiveservices", "account", "deployment", "show",
    "--subscription", CONFIG.foundry.subscriptionId,
    "--resource-group", CONFIG.foundry.resourceGroup,
    "--name", CONFIG.foundry.account,
    "--deployment-name", CONFIG.foundry.deployment,
    "-o", "json",
  ]), "Foundry deployment verification");
  const health = await getApplicationJson(deps.runner, baseHealthUrl.toString());
  const readiness = await getApplicationJson(deps.runner, readinessUrl.toString());

  invariant(Array.isArray(azure), "Azure inventory must be an array.");
  const expectedAzureNames = [CONFIG.aks.name, CONFIG.postgres.server, CONFIG.storage.account, CONFIG.acr];
  for (const name of expectedAzureNames) {
    const resource = azure.find((item) => item?.name === name);
    invariant(resource, `Azure verification is missing ${name}.`);
    assertExact(resource.tags?.["wdm-expires-at"], CONFIG.expiry.expiresAt, `${name} expiry tag`);
  }
  assertExact(aks.name, CONFIG.aks.name, "AKS name");
  assertExact(aks.provisioningState, "Succeeded", "AKS provisioning state");
  assertExact(aks.nodeCount, CONFIG.aks.nodeCount, "AKS node count");
  assertExact(aks.nodeSku, CONFIG.aks.nodeSku, "AKS node SKU");

  const policyItems = requireList(policies, "network policy read");
  const policyNames = new Set(policyItems.map((item) => item?.metadata?.name));
  for (const name of ["decision11-default-deny", "decision11-origin-allow"]) {
    invariant(policyNames.has(name), `NetworkPolicy ${name} is missing.`);
  }
  const defaultDeny = policyItems.find((item) => item?.metadata?.name === "decision11-default-deny");
  invariant(
    Array.isArray(defaultDeny?.spec?.policyTypes)
      && defaultDeny.spec.policyTypes.includes("Ingress")
      && defaultDeny.spec.policyTypes.includes("Egress"),
    "decision11-default-deny must deny both ingress and egress by default.",
  );

  const serviceItems = requireList(services, "service read");
  const originService = serviceItems.find((item) => item?.metadata?.name === "decision11-portal-vpn");
  const portalService = serviceItems.find((item) => item?.metadata?.name === "decision11-portal");
  invariant(originService, "decision11-portal-vpn Service is missing.");
  invariant(portalService, "decision11-portal Service is missing.");
  invariant(
    JSON.stringify(originService.spec?.loadBalancerSourceRanges) === JSON.stringify([CONFIG.network.relaySourceCidr]),
    `decision11-portal-vpn source rule must be exactly ${CONFIG.network.relaySourceCidr}.`,
  );
  invariant(originService.spec?.ports?.some((port) => port.port === 443), "public origin Service must expose only the reviewed 443 path.");
  invariant(portalService.spec?.ports?.some((port) => port.port === 3001), "portal ClusterIP must retain its reviewed 3001 hop.");

  const outboundRule = lb.outboundRules?.find((rule) => rule?.name === CONFIG.network.relayCluster.outboundRule);
  invariant(outboundRule, "relay outbound load-balancer rule is missing.");
  invariant(
    outboundRule.frontendIPConfigurations?.some(
      (frontend) => frontend?.publicIPAddress?.id === CONFIG.network.relayCluster.outboundPublicIpId,
    ),
    "relay outbound rule no longer references the frozen public-IP.",
  );

  const configItems = [
    ...requireList(appConfigMaps, "app ConfigMap read"),
    ...requireList(relayConfigMaps, "relay ConfigMap read"),
  ];
  const trust = configItems.find((item) => item?.metadata?.name === "decision11-origin-client-trust");
  invariant(trust, "origin mTLS trust metadata is missing.");
  assertExact(trust.data?.caName, CONFIG.network.caName, "origin mTLS CA name");
  assertExact(trust.data?.clientUriSan, CONFIG.network.clientUriSan, "origin mTLS client URI SAN");
  assertExact(trust.data?.serverDnsSan, CONFIG.network.serverDnsSan, "origin mTLS server DNS SAN");
  assertExact(trust.data?.clientSecretRef, CONFIG.network.clientSecretRef, "origin mTLS client Secret reference");
  assertExact(trust.data?.serverSecretRef, CONFIG.network.serverSecretRef, "origin mTLS server Secret reference");
  const leases = Object.fromEntries(Object.values(CONFIG.namespaces).filter((namespace) => namespace !== CONFIG.namespaces.host).map((namespace) => {
    const lease = configItems.find((item) => item?.metadata?.name === "decision11-access-lease" && item?.metadata?.namespace === namespace);
    invariant(lease, `access lease is missing in ${namespace}.`);
    assertExact(lease.data?.expiresAt, CONFIG.expiry.expiresAt, `${namespace} access lease expiry`);
    assertExact(lease.data?.closureStartsAt, CONFIG.expiry.closureStartsAt, `${namespace} access lease closure`);
    assertExact(lease.data?.epoch, String(CONFIG.fences.epoch), `${namespace} access lease epoch`);
    return [namespace, { expiresAt: lease.data.expiresAt, closureStartsAt: lease.data.closureStartsAt, epoch: Number(lease.data.epoch) }];
  }));

  const deploymentItems = requireList(deployments, "deployment read");
  const liveImages = {};
  for (const key of ["portal", "worker"]) {
    const name = key === "portal" ? "decision11-portal" : "decision11-worker";
    const deployment = deploymentItems.find((item) => item?.metadata?.name === name);
    invariant(deployment, `${name} deployment is missing.`);
    const image = deployment.spec?.template?.spec?.containers?.find((container) => String(container?.image).startsWith(CONFIG.images[key]))?.image;
    invariant(typeof image === "string" && /@sha256:[0-9a-f]+$/.test(image), `${name} deployment image is not digest pinned.`);
    liveImages[key] = image;
  }

  assertExact(foundry.name, CONFIG.foundry.deployment, "Foundry deployment name");
  assertExact(foundry.properties?.provisioningState, "Succeeded", "Foundry deployment state");
  assertExact(foundry.properties?.model?.format, CONFIG.foundry.modelFormat, "Foundry model format");
  assertExact(foundry.properties?.model?.name, CONFIG.foundry.modelName, "Foundry model name");
  assertExact(foundry.properties?.model?.version, CONFIG.foundry.modelVersion, "Foundry model version");

  invariant(health.ok === true, "portal health is not ready.");
  assertExact(health.sourceHead, flags.head, "portal health source head");
  invariant(readiness.ok === true, "application readiness is not ready.");
  assertExact(readiness.database?.name, CONFIG.postgres.database, "readiness database name");
  assertExact(readiness.database?.ok, true, "readiness database state");
  assertExact(readiness.storage?.account, CONFIG.storage.account, "readiness storage account");
  assertExact(readiness.storage?.container, CONFIG.storage.container, "readiness storage container");
  assertExact(readiness.storage?.ok, true, "readiness storage state");
  assertExact(readiness.leases?.ok, true, "readiness lease state");

  const evidence = {
    ok: true,
    command: "verify",
    observedAt: currentTime(deps.now).toISOString(),
    sourceHead: flags.head,
    azure: { resourceGroup: CONFIG.target.resourceGroup, names: expectedAzureNames, expiresAt: CONFIG.expiry.expiresAt },
    aks: { name: aks.name, provisioningState: aks.provisioningState, nodeCount: aks.nodeCount, nodeSku: aks.nodeSku },
    network: {
      relaySourceCidr: CONFIG.network.relaySourceCidr,
      vpnSourceCidr: CONFIG.network.vpnSourceCidr,
      publicRelayHop: CONFIG.network.publicRelayHop,
      originPort: 443,
      portalPort: 3001,
    },
    originMtls: {
      caName: trust.data.caName,
      clientUriSan: trust.data.clientUriSan,
      serverDnsSan: trust.data.serverDnsSan,
      clientSecretRef: trust.data.clientSecretRef,
      serverSecretRef: trust.data.serverSecretRef,
    },
    negativeProofs: Object.fromEntries(["sibling", "nonVpn", "directOrigin"].map((key) => [key, {
      status: receipt.negativeProofs[key].status,
      evidenceId: receipt.negativeProofs[key].evidenceId,
    }])),
    portalHealth: { ok: true, sourceHead: flags.head },
    foundry: {
      account: CONFIG.foundry.account,
      deployment: foundry.name,
      model: `${CONFIG.foundry.modelFormat}:${CONFIG.foundry.modelName}:${CONFIG.foundry.modelVersion}`,
      state: foundry.properties.provisioningState,
    },
    images: liveImages,
    database: { ok: true, server: CONFIG.postgres.server, database: CONFIG.postgres.database, role: CONFIG.postgres.role },
    storage: { ok: true, account: CONFIG.storage.account, container: CONFIG.storage.container },
    leases,
  };
  writeEvidence(flags["evidence-out"], evidence);
  return { ok: true, evidence };
}

function nearlyOne(values, label) {
  const sum = values.reduce((total, value) => total + value, 0);
  invariant(Number.isFinite(sum) && Math.abs(sum - 1) <= 1e-6, `${label} must sum to 1.`);
}

function validateProbability(value, label) {
  invariant(Number.isFinite(value) && value >= 0 && value <= 1, `${label} must be a probability.`);
  return value;
}

function assertCommonLiveOutput(output, demoId) {
  invariant(output?.ok === true, `${demoId} did not return a successful live Decision result.`);
  assertExact(output.model, CONFIG.foundry.qualifiedBinding, `${demoId} model binding`);
  assertExact(output.transport, "live-decision", `${demoId} transport`);
  assertString(output.sessionId, `${demoId} session id`);
  requireIntegerAtLeast(output.requestCount, 0, `${demoId} request count`);
  requireIntegerAtLeast(output.billableTokens, 0, `${demoId} billable tokens`);
}

function sanitizeSessionId(value) {
  return `sha256:${sha256(value).slice(0, 24)}`;
}

function validateSmokeOutput(id, output) {
  if (id === NEGATIVE_DEMO) {
    invariant(output?.ok === false, "missing-default diagnostic must refuse the run.");
    assertExact(output.error?.code, CONFIG.demos.negative.errorCode, "missing-default diagnostic error code");
    invariant(
      String(output.error?.message).includes("no eligible Cluster Decision Default"),
      "missing-default diagnostic did not explain the missing Cluster Decision Default.",
    );
    assertExact(output.requestCount, 0, "missing-default diagnostic request count");
    assertExact(output.billableTokens, 0, "missing-default diagnostic billable tokens");
    assertString(output.sessionId, "missing-default diagnostic session id");
    return {
      id,
      refused: true,
      errorCode: output.error.code,
      requestCount: 0,
      billableTokens: 0,
    };
  }

  assertCommonLiveOutput(output, id);
  if (id === "choice-routing") {
    invariant(isRecord(output.result), "choice-routing result must be an object.");
    const distribution = output.result.distribution;
    invariant(isRecord(distribution), "choice-routing distribution must be an object.");
    assertExact(Object.keys(distribution).sort().join(","), "billing,engineering,support", "choice-routing labels");
    nearlyOne(Object.values(distribution).map((value) => validateProbability(value, "choice-routing probability")), "choice-routing distribution");
    assertExact(output.result.route, output.result.selection, "choice-routing route");
    invariant(Object.hasOwn(distribution, output.result.selection), "choice-routing selection is not in the distribution.");
  } else if (id === "noul-gate") {
    const probability = validateProbability(output.result?.positiveProbability, "noul positive probability");
    const threshold = validateProbability(output.result?.threshold, "noul threshold");
    assertExact(threshold, 0.5, "noul threshold");
    assertExact(output.result.decision, probability >= threshold ? "yes" : "no", "noul decision");
    const confidence = Math.max(probability, 1 - probability);
    invariant(Math.abs(output.result.confidence - confidence) <= 1e-6, "noul confidence does not match max(p, 1-p).");
  } else if (id === "score-downstream-to-script-and-agent") {
    invariant(Number.isFinite(output.result?.score), "score demo score must be finite.");
    invariant(Array.isArray(output.result.distribution), "score demo distribution must be an array.");
    assertExact(output.result.distribution.map((entry) => entry?.label).join(","), "Cosmetic,Minor,Major,Critical", "score demo level order");
    nearlyOne(output.result.distribution.map((entry) => validateProbability(entry?.probability, "score demo probability")), "score demo distribution");
    assertExact(output.result.scriptScore, output.result.score, "score demo script score");
    assertExact(output.result.agentScore, output.result.score, "score demo agent score");
  } else if (id === "uncertain-policy") {
    assertExact(output.result?.outcome, "uncertain", "uncertain-policy outcome");
    validateProbability(output.result?.confidence, "uncertain-policy confidence");
    validateProbability(output.result?.threshold, "uncertain-policy threshold");
    invariant(
      output.result.confidence < output.result.threshold,
      "uncertain-policy cannot be fabricated when confidence meets the threshold.",
    );
  } else if (id === "recovery-replay-single-accepted-completion") {
    requireIntegerAtLeast(output.providerAttempts, 1, "replay provider attempts");
    invariant(
      output.result?.acceptedSemanticCompletions === 1 && output.result?.duplicateDurableCompletions === 0,
      "replay demo must record exactly one accepted semantic completion and zero duplicate durable completions.",
    );
    assertExact(output.result.outcome, "succeeded", "replay demo outcome");
  }
  return {
    id,
    ok: true,
    requestCount: output.requestCount,
    billableTokens: output.billableTokens,
    providerAttempts: output.providerAttempts ?? null,
  };
}

async function runSmoke(argv, deps) {
  const flags = parseFlags(argv, ["smoke-receipt", "evidence-out"], "smoke");
  const receipt = readSafeReceipt(flags["smoke-receipt"], "smoke receipt");
  assertSchema(receipt, "smoke receipt");
  assertExact(receipt.kind, "real-decision-smoke", "smoke receipt kind");
  assertExact(receipt.reviewed, true, "smoke receipt review state");
  assertExact(receipt.smokePath, DEMO_RUN_PATH, "smoke receipt path");
  const baseUrl = validateApiBaseUrl(receipt.apiBaseUrl, "smoke API base URL");
  const authValue = readAuthValue(receipt, deps.env);
  invariant(Array.isArray(receipt.demos), "smoke receipt demos must be an array.");
  assertExact(receipt.demos.length, 6, "smoke demo count");
  assertExact(receipt.demos.map((demo) => demo?.id).join(","), [...POSITIVE_DEMOS, NEGATIVE_DEMO].join(","), "smoke demo set and order");
  const url = new URL(DEMO_RUN_PATH, baseUrl).toString();
  const summaries = [];
  const sessions = {};
  let requestCount = 0;
  let billableTokens = 0;
  for (const demo of receipt.demos) {
    invariant(isRecord(demo.input), `smoke demo ${demo.id} input must be an object.`);
    assertMutable("smoke", deps.now);
    const output = await postApplicationJson(deps.runner, url, { id: demo.id, input: demo.input }, authValue);
    const summary = validateSmokeOutput(demo.id, output);
    summaries.push(summary);
    sessions[demo.id] = sanitizeSessionId(output.sessionId);
    requestCount += output.requestCount ?? 0;
    billableTokens += output.billableTokens ?? 0;
    invariant(requestCount <= CONFIG.cost.decisionProofRequestMax, "smoke exceeded the Decision proof request maximum.");
    invariant(billableTokens <= CONFIG.cost.decisionBillableTokensMax, "smoke exceeded the Decision billable-token maximum.");
  }
  assertExact(receipt.demos.at(-1).expectRefusal, true, "missing-default diagnostic expectation");
  const evidence = {
    ok: true,
    command: "smoke",
    observedAt: currentTime(deps.now).toISOString(),
    positiveDemos: POSITIVE_DEMOS.length,
    negativeDiagnostic: NEGATIVE_DEMO,
    demos: summaries,
    sessions,
    requestCount,
    billableTokens,
  };
  writeEvidence(flags["evidence-out"], evidence);
  return { ok: true, evidence };
}

function assetLabel(asset) {
  return `${asset.kind}:${asset.namespace ?? asset.resourceGroup ?? "global"}:${asset.name}`;
}

function exactTeardownConfirmation(assets) {
  const list = assets.map(assetLabel).sort().join(",");
  return `DELETE pse-decision11-test EXACT ASSETS [${list}]`;
}

const ALLOWED_KUBE_RESOURCES = new Set([
  "configmap",
  "cronjob",
  "deployment",
  "job",
  "networkpolicy",
  "role",
  "rolebinding",
  "secret",
  "service",
  "serviceaccount",
]);

function validateTeardownAssets(receipt) {
  invariant(Array.isArray(receipt.assets) && receipt.assets.length > 0, "teardown receipt must list at least one exact asset.");
  const labels = new Set();
  for (const asset of receipt.assets) {
    invariant(isRecord(asset), "each teardown asset must be an object.");
    assertString(asset.name, "teardown asset name");
    const label = assetLabel(asset);
    invariant(!labels.has(label), `teardown receipt contains duplicate asset ${label}.`);
    labels.add(label);
    if (asset.kind === "kubernetes") {
      invariant(ALLOWED_KUBE_CONTEXTS.has(asset.context), `teardown asset ${label} has an unreviewed Kubernetes context.`);
      invariant(ALLOWED_KUBE_NAMESPACES.has(asset.namespace), `teardown asset ${label} has an unreviewed namespace.`);
      invariant(ALLOWED_KUBE_RESOURCES.has(asset.resource), `teardown asset ${label} has an unreviewed resource type.`);
      assertString(asset.uid, `teardown asset ${label} UID`);
      assertString(asset.apiPath, `teardown asset ${label} API path`);
      invariant(asset.apiPath.startsWith("/api") || asset.apiPath.startsWith("/apis"), `teardown asset ${label} API path is not an in-cluster API path.`);
      invariant(!/[?&#]/.test(asset.apiPath), `teardown asset ${label} API path must be a single exact endpoint.`);
    } else if (asset.kind === "azure") {
      assertString(asset.resourceId, `teardown asset ${label} resource id`);
      assertString(asset.resourceGroup, `teardown asset ${label} resource group`);
      assertString(asset.uid, `teardown asset ${label} canonical UID`);
      invariant(
        asset.resourceId.startsWith(`/subscriptions/${CONFIG.target.subscriptionId}/`),
        `teardown asset ${label} is outside the frozen target subscription.`,
      );
      invariant(!/\/resourcegroups\/[^/]+$/i.test(asset.resourceId), `teardown asset ${label} cannot delete a resource group blindly.`);
    } else {
      throw new Error(`teardown asset ${label} has an unsupported kind.`);
    }
  }
  return receipt.assets;
}

async function precheckTeardownAsset(runner, asset) {
  if (asset.kind === "kubernetes") {
    const result = parseRunnerJson(await invoke(runner, "kubectl", [
      "--context", asset.context,
      "--namespace", asset.namespace,
      "get", asset.resource, asset.name,
      "-o", "json",
    ]), `teardown precondition for ${assetLabel(asset)}`);
    assertExact(result.metadata?.name, asset.name, `${assetLabel(asset)} live name`);
    invariant(
      result.metadata?.uid === asset.uid,
      `UID precondition failed for ${assetLabel(asset)}: live ${String(result.metadata?.uid)} is a replacement UID; expected ${asset.uid}.`,
    );
    assertString(result.metadata?.resourceVersion, `${assetLabel(asset)} resourceVersion`);
    return { ...asset, resourceVersion: result.metadata.resourceVersion };
  }
  const result = parseRunnerJson(await invoke(runner, "az", [
    "resource", "show",
    "--ids", asset.resourceId,
    "-o", "json",
  ]), `teardown precondition for ${assetLabel(asset)}`);
  assertExact(result.name, asset.name, `${assetLabel(asset)} live name`);
  assertExact(result.tags?.["wdm-resource-uid"], asset.uid, `${assetLabel(asset)} canonical UID`);
  return { ...asset, resourceVersion: result.tags?.["wdm-resource-uid"] };
}

async function closeDecisionAccess(runner, now) {
  for (const item of CONFIG.teardown.closeDeployments) {
    assertMutable("teardown", now);
    await invoke(runner, "kubectl", [
      "--context", item.context,
      "scale", `deployment/${item.name}`,
      "--replicas=0",
    ], { namespace: item.namespace });
  }
}

async function deleteTeardownAsset(runner, asset, now) {
  assertMutable("teardown", now);
  const body = JSON.stringify({
    kind: "DeleteOptions",
    apiVersion: "v1",
    preconditions: { uid: asset.uid, resourceVersion: asset.resourceVersion },
  });
  if (asset.kind === "kubernetes") {
    await invoke(runner, "kubectl", [
      "--context", asset.context,
      "delete", asset.resource, asset.name,
      "--wait=false",
    ], {
      namespace: asset.namespace,
      input: body,
      deleteApiPath: asset.apiPath,
      uid: asset.uid,
    });
  } else {
    await invoke(runner, "az", [
      "resource", "delete",
      "--ids", asset.resourceId,
    ], { input: body, uid: asset.uid });
  }
}

async function runTeardown(argv, deps) {
  const flags = parseFlags(argv, ["teardown-receipt", "asset-confirmation", "evidence-out"], "teardown");
  const receipt = readSafeReceipt(flags["teardown-receipt"], "teardown receipt");
  assertSchema(receipt, "teardown receipt");
  assertExact(receipt.kind, "exact-asset-teardown", "teardown receipt kind");
  assertExact(receipt.reviewed, true, "teardown receipt review state");
  const assets = validateTeardownAssets(receipt);
  assertExact(flags["asset-confirmation"], exactTeardownConfirmation(assets), "teardown exact asset confirmation");

  const checked = [];
  for (const asset of assets) checked.push(await precheckTeardownAsset(deps.runner, asset));
  await closeDecisionAccess(deps.runner, deps.now);
  for (const asset of checked) await deleteTeardownAsset(deps.runner, asset, deps.now);

  const evidence = {
    ok: true,
    command: "teardown",
    observedAt: currentTime(deps.now).toISOString(),
    accessClosed: true,
    assetsDeleted: checked.length,
    assets: checked.map((asset) => ({
      kind: asset.kind,
      name: asset.name,
      namespace: asset.namespace ?? null,
      resourceGroup: asset.resourceGroup ?? null,
      uid: asset.uid,
      resourceVersion: asset.resourceVersion,
    })),
    expiresAt: CONFIG.expiry.expiresAt,
    closureStartsAt: CONFIG.expiry.closureStartsAt,
  };
  writeEvidence(flags["evidence-out"], evidence);
  return { ok: true, evidence };
}

export async function runDecision11(command, argv, dependencies = {}) {
  validateConfig();
  invariant(COMMANDS.has(command), `Unknown command ${command}. Expected one of: ${[...COMMANDS].join(", ")}.`);
  const deps = {
    runner: dependencies.runner ?? defaultRunner,
    now: dependencies.now ?? (() => new Date()),
    env: dependencies.env ?? process.env,
  };
  assertMutable(command, deps.now);
  if (command === "setup") return runSetup(argv, deps);
  if (command === "reset") return runReset(argv, deps);
  if (command === "verify") return runVerify(argv, deps);
  if (command === "smoke") return runSmoke(argv, deps);
  return runTeardown(argv, deps);
}

function usage() {
  return [
    "Usage: decision11.mjs <setup|reset|verify|smoke|teardown> [required receipt flags]",
    "Use the matching wrapper and README receipt schema. The command never invents manifests, assets or trust material.",
  ].join("\n");
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runDecision11(command, argv);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
