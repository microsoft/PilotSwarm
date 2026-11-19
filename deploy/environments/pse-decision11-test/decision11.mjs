#!/usr/bin/env node

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { redactArgs, resolveCli } from "../../scripts/lib/common.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(SCRIPT_DIR, "config.json");
const CONFIG_TEMPLATE = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const ACTIVE_CONFIG = new AsyncLocalStorage();
const CONFIG = new Proxy(CONFIG_TEMPLATE, {
  get(target, property) {
    const config = ACTIVE_CONFIG.getStore() ?? target;
    return Reflect.get(config, property);
  },
});

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
const DEMO_SESSION_PREFIXES = Object.freeze({
  "choice-routing": ["decision11-choice-"],
  "noul-gate": ["decision11-noul-"],
  "score-downstream-to-script-and-agent": ["decision11-score-script-", "decision11-score-agent-"],
  "uncertain-policy": ["decision11-uncertain-"],
  "recovery-replay-single-accepted-completion": ["decision11-replay-"],
  [NEGATIVE_DEMO]: ["decision11-diagnostic-"],
});
const DEMO_RESET_PATH = "/api/internal/decision11-demo/reset";
const DEMO_RUN_PATH = "/api/internal/decision11-demo/run";
const AUTH_ENV_NAME = "DECISION11_TEST_API_TOKEN";
const CAPTURE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const APPLICATION_REQUEST_TIMEOUT_MS = 120_000;
const APPLICATION_AUTH_PUBLIC = "public";
const APPLICATION_AUTH_PROTECTED = "protected";
const TEARDOWN_QUIESCENCE_TIMEOUT_MS = 60_000;
const TEARDOWN_QUIESCENCE_POLL_MS = 1_000;
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

function canonicalJson(value) {
  const canonical = Array.isArray(value)
    ? value.map(canonicalJson)
    : isRecord(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]))
      : value;
  return JSON.stringify(canonical);
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

function mergeBindings(base, bindings) {
  if (!isRecord(base) || !isRecord(bindings)) return bindings;
  const merged = { ...base };
  for (const [key, value] of Object.entries(bindings)) {
    merged[key] = Object.hasOwn(base, key) ? mergeBindings(base[key], value) : value;
  }
  return merged;
}

function unresolvedBindingPath(value, path = "config") {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = unresolvedBindingPath(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const found = unresolvedBindingPath(child, `${path}.${key}`);
      if (found) return found;
    }
    return null;
  }
  return typeof value === "string" && value.includes("__") ? path : null;
}

function resolveBindings(argv, supplied, expectedSha256 = CONFIG_TEMPLATE.bindingsSha256) {
  const rest = [];
  let receiptPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--bindings-receipt") {
      invariant(receiptPath === null, "bindings: duplicate --bindings-receipt.");
      index += 1;
      invariant(index < argv.length && !argv[index].startsWith("--"), "bindings: --bindings-receipt requires a value.");
      receiptPath = argv[index];
    } else if (token.startsWith("--bindings-receipt=")) {
      invariant(receiptPath === null, "bindings: duplicate --bindings-receipt.");
      receiptPath = token.slice("--bindings-receipt=".length);
      invariant(receiptPath, "bindings: --bindings-receipt requires a value.");
    } else {
      rest.push(token);
    }
  }
  invariant(!(supplied !== undefined && receiptPath !== null), "bindings may be supplied by injection or --bindings-receipt, not both.");
  const receipt = supplied ?? (receiptPath === null
    ? null
    : readSafeReceipt(receiptPath, "environment bindings receipt"));
  invariant(receipt !== null, "a reviewed --bindings-receipt is required; private cloud bindings are not checked into the repository.");
  const forbidden = findForbiddenMaterial(receipt);
  invariant(!forbidden, `environment bindings receipt contains forbidden secret or private material at ${forbidden}.`);
  assertSchema(receipt, "environment bindings receipt");
  assertExact(receipt.kind, "private-environment-bindings", "environment bindings receipt kind");
  assertExact(receipt.reviewed, true, "environment bindings receipt review state");
  assertExact(receipt.environment, CONFIG_TEMPLATE.environment, "environment bindings environment");
  invariant(isRecord(receipt.bindings), "environment bindings receipt bindings must be an object.");
  assertExact(sha256(canonicalJson(receipt.bindings)), expectedSha256, "environment bindings receipt hash");
  const config = mergeBindings(CONFIG_TEMPLATE, receipt.bindings);
  const unresolved = unresolvedBindingPath(config);
  invariant(unresolved === null, `environment bindings leave template placeholder ${unresolved} unresolved.`);
  return { argv: rest, config };
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

function mutatingInvocationOptions(command, now) {
  assertMutable(command, now);
  const deadlineMs = Date.parse(CONFIG.expiry.closureStartsAt);
  const remainingMs = deadlineMs - currentTime(now).getTime();
  invariant(remainingMs > 0, `Refusing ${command}: no time remains before the frozen closure deadline.`);
  const timeoutMs = Math.min(APPLICATION_REQUEST_TIMEOUT_MS, remainingMs);
  return {
    timeoutMs,
    deadlineMs,
    now,
    timeoutError: new CommandTimeoutError(
      `${command} request timed out before the frozen closure deadline ${CONFIG.expiry.closureStartsAt}`,
    ),
  };
}

function sanitizeCommandError(command, args, status, stderr) {
  const safeArgs = redactArgs(args.map(String));
  const text = String(stderr ?? "")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer ***")
    .replace(/(token|password|secret|sas)[=:]\s*[^\s,;]+/gi, "$1=***")
    .slice(0, 4000);
  return new Error(`${command} ${safeArgs.join(" ")} exited ${status}${text ? `\n${text}` : ""}`);
}

class CommandTimeoutError extends Error {
  constructor(message, readPhase) {
    super(message);
    this.readPhase = readPhase;
  }
}

async function invoke(runner, command, args, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs;
  const timeoutError = options.timeoutError instanceof Error
    ? options.timeoutError
    : new CommandTimeoutError(`${command} request timed out${Number.isInteger(timeoutMs) ? ` after ${timeoutMs}ms` : ""}`);
  let timer;
  let timedOut = false;
  const operationOptions = { ...options, signal: controller.signal };
  delete operationOptions.timeoutError;
  delete operationOptions.deadlineMs;
  delete operationOptions.now;
  const operation = Promise.resolve().then(() => {
    if (Number.isInteger(options.deadlineMs) && typeof options.now === "function"
        && currentTime(options.now).getTime() >= options.deadlineMs) throw timeoutError;
    return runner(command, args, operationOptions);
  });
  let result;
  try {
    const timeout = Number.isInteger(timeoutMs) && timeoutMs >= 0
      ? new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort(timeoutError);
            reject(timeoutError);
          }, timeoutMs);
        })
      : null;
    result = timeout ? await Promise.race([operation, timeout]) : await operation;
  } catch (error) {
    if (timedOut || error instanceof CommandTimeoutError) throw timeoutError;
    throw new Error(`Failed to run ${command} ${redactArgs(args.map(String)).join(" ")}: ${error.message}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (Number.isInteger(options.deadlineMs) && typeof options.now === "function"
      && currentTime(options.now).getTime() >= options.deadlineMs) throw timeoutError;
  invariant(isRecord(result) && Number.isInteger(result.status), `${command} runner returned an invalid result.`);
  if (command === "curl") {
    invariant(Number.isInteger(result.httpStatus), `${command} runner returned an invalid HTTP status; an integer httpStatus is required.`);
    invariant(
      result.httpStatus >= 200 && result.httpStatus < 300,
      `HTTP ${result.httpStatus} response from ${options.url ?? args.at(-1) ?? "application request"} is not 2xx; its body is not evidence.`,
    );
  }
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

async function waitForTeardownPoll(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function defaultRunner(command, args, options = {}) {
  if (command === "curl") {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) forwardAbort();
    else options.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? APPLICATION_REQUEST_TIMEOUT_MS);
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
      return { status: 1, stdout: "", stderr: error.message, httpStatus: 0 };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", forwardAbort);
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
  const { timeoutMs } = options;
  const result = spawnSync(cli, effectiveArgs, {
    shell: false,
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: CAPTURE_MAX_BUFFER_BYTES,
    // spawnSync waits for the child to exit after delivering the timeout signal.
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" }),
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new CommandTimeoutError(`${command} process timed out`);
  }
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
  assertString(CONFIG.target.tenantId, "config tenant binding");
  assertString(CONFIG.target.subscriptionId, "config subscription binding");
  assertExact(CONFIG.target.location, "westus2", "config location");
  assertExact(CONFIG.target.resourceGroup, "wdmchk-pse-decision11-test-rg", "config resource group");
  assertExact(CONFIG.expiry.expiresAt, "2026-11-22T04:17:38.699Z", "config expiry");
  assertExact(CONFIG.expiry.closureStartsAt, "2026-11-22T04:12:38.699Z", "config closure start");
  assertExact(CONFIG.network.relaySourceCidr, "4.148.50.242/32", "config relay source");
  assertExact(CONFIG.network.vpnSourceCidr, "172.16.200.0/24", "config VPN source");
  const approvedDemoPrefixes = [...POSITIVE_DEMOS, NEGATIVE_DEMO].flatMap(id => DEMO_SESSION_PREFIXES[id] ?? []);
  invariant(
    JSON.stringify(approvedDemoPrefixes) === JSON.stringify(CONFIG.demoSessionPrefixes),
    "config demo prefixes must name every approved positive and negative demo prefix exactly once.",
  );
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
  assertExact(receipt.reviewed, true, "image receipt review state");
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
    await invoke(deps.runner, "kubectl", ["--context", entry.context, "apply", "-f", entry.path],
      mutatingInvocationOptions("setup", deps.now));
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

function applicationHeaders(authPolicy, authValue) {
  assertString(authPolicy, "application auth policy");
  if (authPolicy === APPLICATION_AUTH_PROTECTED) {
    const value = assertString(authValue, "protected application auth token");
    return {
      "content-type": "application/json",
      authorization: ["Bearer", value].join(" "),
    };
  }
  invariant(authPolicy === APPLICATION_AUTH_PUBLIC, `Unsupported application auth policy ${authPolicy}.`);
  invariant(authValue === undefined, "A public application request cannot carry an operation token.");
  return { accept: "application/json" };
}

async function postApplicationJson(runner, url, body, authValue, { command, now }) {
  const options = mutatingInvocationOptions(command, now);
  const headers = applicationHeaders(APPLICATION_AUTH_PROTECTED, authValue);
  const nonce = randomBytes(24).toString("hex");
  const result = await invoke(runner, "curl", [
    "--silent",
    "--show-error",
    "--request", "POST",
    "--header", "Content-Type: application/json",
    url,
  ], {
    ...options,
    url,
    method: "POST",
    input: JSON.stringify({ ...body, nonce }),
    authPolicy: APPLICATION_AUTH_PROTECTED,
    headers,
  });
  const output = parseRunnerJson(result, `protected application request ${url}`);
  assertExact(output?.nonce, nonce, `protected application request ${url} correlation nonce`);
  return output;
}

async function getApplicationJson(runner, url) {
  const result = await invoke(runner, "curl", ["--silent", "--show-error", "--request", "GET", url], {
    url,
    method: "GET",
    authPolicy: APPLICATION_AUTH_PUBLIC,
    headers: applicationHeaders(APPLICATION_AUTH_PUBLIC, undefined),
    timeoutMs: APPLICATION_REQUEST_TIMEOUT_MS,
    timeoutError: new CommandTimeoutError(`public application request timed out: ${url}`),
  });
  return parseRunnerJson(result, `public application request ${url}`);
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
    "reset requires the exact seven approved synthetic session prefixes and no others.",
  );
  assertExact(receipt.resetPath, DEMO_RESET_PATH, "reset receipt path");
  const baseUrl = validateApiBaseUrl(receipt.apiBaseUrl, "reset API base URL");
  const authValue = readAuthValue(receipt, deps.env);
  const url = new URL(DEMO_RESET_PATH, baseUrl).toString();
  const results = [];
  const responsePrefixes = new Set();
  for (const prefix of CONFIG.demoSessionPrefixes) {
    assertMutable("reset", deps.now);
    const output = await postApplicationJson(deps.runner, url, { action: "remove-and-reseed", prefix }, authValue, { command: "reset", now: deps.now });
    invariant(output.ok === true, `reset refused prefix ${prefix}.`);
    assertExact(output.prefix, prefix, `reset returned prefix for ${prefix}`);
    invariant(!responsePrefixes.has(output.prefix), `reset returned duplicate prefix identity for ${prefix}.`);
    responsePrefixes.add(output.prefix);
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

function normalizeAksZones(value, label) {
  if (value === null || value === undefined) return [];
  invariant(Array.isArray(value), `${label} must be an array or null.`);
  invariant(value.every((zone) => typeof zone === "string" && zone.length > 0), `${label} must contain zone names.`);
  return [...value].sort();
}

function validateAksInventory(aks) {
  assertExact(aks.name, CONFIG.aks.name, "AKS name");
  assertExact(aks.location, CONFIG.target.location, "AKS location");
  assertExact(aks.resourceGroup, CONFIG.target.resourceGroup, "AKS resource group");
  assertExact(aks.nodeResourceGroup, CONFIG.aks.nodeResourceGroup, "AKS node resource group");
  assertExact(aks.provisioningState, "Succeeded", "AKS provisioning state");
  assertExact(aks.kubernetesVersion, CONFIG.aks.kubernetesVersion, "AKS Kubernetes version");
  assertExact(aks.apiServerAccessProfile?.enablePrivateCluster, CONFIG.aks.privateApi, "AKS private-cluster mode");
  assertExact(aks.networkProfile?.networkPlugin, CONFIG.aks.networkPlugin, "AKS network plugin");
  assertExact(aks.networkProfile?.networkDataplane, CONFIG.aks.networkDataplane, "AKS network dataplane");
  assertExact(aks.networkProfile?.networkPluginMode, CONFIG.aks.networkPluginMode, "AKS network plugin mode");
  invariant(Array.isArray(aks.agentPoolProfiles), "AKS agentPoolProfiles must be an array.");
  const pools = aks.agentPoolProfiles.filter((pool) => pool?.name === CONFIG.aks.pool);
  invariant(pools.length === 1, `AKS must contain exactly one ${CONFIG.aks.pool} agent pool.`);
  const pool = pools[0];
  assertExact(pool.count, CONFIG.aks.nodeCount, "AKS system pool node count");
  assertExact(pool.vmSize, CONFIG.aks.nodeSku, "AKS system pool node SKU");
  assertExact(pool.enableAutoScaling, CONFIG.aks.autoscaler, "AKS system pool autoscaler state");
  assertExact(String(pool.upgradeSettings?.maxSurge), String(CONFIG.aks.maxSurge), "AKS system pool max surge");
  const zones = normalizeAksZones(pool.availabilityZones, "AKS system pool availability zones");
  invariant(
    JSON.stringify(zones) === JSON.stringify([...CONFIG.aks.zones].sort()),
    `AKS system pool zones do not match the frozen non-zonal shape.`,
  );
  return {
    name: aks.name,
    location: aks.location,
    provisioningState: aks.provisioningState,
    privateApi: aks.apiServerAccessProfile.enablePrivateCluster,
    nodeResourceGroup: aks.nodeResourceGroup,
    kubernetesVersion: aks.kubernetesVersion,
    pool: pool.name,
    nodeCount: pool.count,
    nodeSku: pool.vmSize,
    maxSurge: pool.upgradeSettings.maxSurge,
    zones,
    autoscaler: pool.enableAutoScaling,
  };
}

function deploymentImageBindings() {
  return [
    { key: "portal", name: "decision11-portal", context: "decision11-app", namespace: CONFIG.namespaces.feature },
    { key: "worker", name: "decision11-worker", context: "decision11-app", namespace: CONFIG.namespaces.feature },
    { key: "originProxy", name: "decision11-origin-proxy", context: "decision11-app", namespace: CONFIG.namespaces.feature },
    { key: "relay", name: "pse-decision11-vpn-relay", context: "decision11-relay", namespace: CONFIG.namespaces.relay },
  ];
}

function controllerOwnerReference(item) {
  const references = item?.metadata?.ownerReferences ?? [];
  invariant(Array.isArray(references), "Kubernetes ownerReferences must be an array when present.");
  const controllers = references.filter((reference) => reference?.controller === true);
  invariant(controllers.length <= 1, "A Kubernetes object cannot have more than one controller owner reference.");
  return controllers[0] ?? null;
}

function requireReplicaCount(value, label, minimum = 0) {
  invariant(Number.isInteger(value) && value >= minimum, `${label} must be an integer of at least ${minimum}.`);
  return value;
}

function requireKubeCondition(item, type, expected, label) {
  const conditions = item?.status?.conditions;
  invariant(Array.isArray(conditions), `${label} conditions must be an array.`);
  const matches = conditions.filter((condition) => condition?.type === type);
  invariant(matches.length === 1, `${label} must report exactly one ${type} condition.`);
  assertExact(matches[0].status, expected, `${label} ${type} condition`);
  return matches[0];
}

function selectorMatches(selector, labels, label) {
  invariant(isRecord(selector), `${label} selector must be an object.`);
  const matchLabels = selector.matchLabels ?? {};
  const matchExpressions = selector.matchExpressions ?? [];
  invariant(isRecord(matchLabels), `${label} selector matchLabels must be an object.`);
  invariant(Array.isArray(matchExpressions), `${label} selector matchExpressions must be an array.`);
  invariant(Object.keys(matchLabels).length + matchExpressions.length > 0, `${label} selector cannot be empty.`);
  const podLabels = isRecord(labels) ? labels : {};
  if (Object.entries(matchLabels).some(([key, value]) => podLabels[key] !== value)) return false;
  for (const expression of matchExpressions) {
    invariant(isRecord(expression), `${label} selector expression must be an object.`);
    assertString(expression.key, `${label} selector expression key`);
    invariant(["In", "NotIn", "Exists", "DoesNotExist"].includes(expression.operator), `${label} selector has an unsupported operator.`);
    const values = expression.values ?? [];
    invariant(Array.isArray(values) && values.every((value) => typeof value === "string"), `${label} selector expression values must be strings.`);
    const hasKey = Object.hasOwn(podLabels, expression.key);
    if (expression.operator === "In" && (!hasKey || !values.includes(podLabels[expression.key]))) return false;
    if (expression.operator === "NotIn" && hasKey && values.includes(podLabels[expression.key])) return false;
    if (expression.operator === "Exists" && !hasKey) return false;
    if (expression.operator === "DoesNotExist" && hasKey) return false;
  }
  return true;
}

function requireSingleReviewedContainer(containers, expected, label) {
  invariant(Array.isArray(containers) && containers.length === 1, `${label} must contain exactly one reviewed runtime container.`);
  const container = containers[0];
  assertString(container?.name, `${label} container name`);
  const expectedReference = `${expected.name}@${expected.digest}`;
  invariant(/^\S+@sha256:[0-9a-f]{64}$/.test(container.image), `${label} image is not pinned to a complete SHA-256 digest.`);
  assertExact(container.image, expectedReference, `${label} image`);
  return container;
}

function runtimeImageDigest(imageId, label) {
  assertString(imageId, label);
  const match = /sha256:([0-9a-f]{64})$/.exec(imageId);
  invariant(match, `${label} must end in a complete lowercase SHA-256 digest; received ${imageId}.`);
  return `sha256:${match[1]}`;
}

function validateReplicaSetState(replicaSet, expected, deployment, label) {
  const desired = requireReplicaCount(replicaSet.spec?.replicas, `${label} desired replicas`);
  const status = replicaSet.status ?? {};
  const generation = requireReplicaCount(replicaSet.metadata?.generation, `${label} generation`, 1);
  const observedGeneration = requireReplicaCount(status.observedGeneration, `${label} observed generation`);
  invariant(observedGeneration >= generation, `${label} has not observed generation ${generation}.`);
  assertString(replicaSet.metadata?.uid, `${label} UID`);
  assertString(replicaSet.metadata?.resourceVersion, `${label} resourceVersion`);
  const state = {
    name: replicaSet.metadata?.name,
    namespace: replicaSet.metadata?.namespace,
    uid: replicaSet.metadata.uid,
    resourceVersion: replicaSet.metadata.resourceVersion,
    generation,
    observedGeneration,
    desiredReplicas: desired,
    replicas: requireReplicaCount(status.replicas, `${label} replicas`),
    readyReplicas: requireReplicaCount(status.readyReplicas ?? 0, `${label} ready replicas`),
    availableReplicas: requireReplicaCount(status.availableReplicas ?? 0, `${label} available replicas`),
  };
  if (state.desiredReplicas > 0) {
    assertExact(state.desiredReplicas, deployment.spec.replicas, `${label} desired replica count`);
    assertExact(state.replicas, state.desiredReplicas, `${label} replica count`);
    assertExact(state.readyReplicas, state.desiredReplicas, `${label} ready replica count`);
    assertExact(state.availableReplicas, state.desiredReplicas, `${label} available replica count`);
    requireSingleReviewedContainer(replicaSet.spec?.template?.spec?.containers, expected, `${label} template`);
  } else {
    assertExact(state.replicas, 0, `${label} inactive replica count`);
    assertExact(state.readyReplicas, 0, `${label} inactive ready replica count`);
    assertExact(state.availableReplicas, 0, `${label} inactive available replica count`);
  }
  return state;
}

function validateRunningPod(pod, activeReplicaSet, expected, label) {
  assertExact(pod.metadata?.namespace, activeReplicaSet.metadata.namespace, `${label} namespace`);
  invariant(!pod.metadata?.deletionTimestamp, `${label} is terminating; rollout is not settled.`);
  assertString(pod.metadata?.uid, `${label} UID`);
  assertString(pod.metadata?.resourceVersion, `${label} resourceVersion`);
  assertString(pod.spec?.nodeName, `${label} node name`);
  const owner = controllerOwnerReference(pod);
  assertExact(owner?.apiVersion, "apps/v1", `${label} controller owner API version`);
  assertExact(owner?.kind, "ReplicaSet", `${label} controller owner kind`);
  assertExact(owner?.name, activeReplicaSet.metadata.name, `${label} controller owner name`);
  assertExact(owner?.uid, activeReplicaSet.metadata.uid, `${label} controller owner UID`);
  assertExact(pod.status?.phase, "Running", `${label} phase`);
  requireKubeCondition(pod, "Ready", "True", label);
  requireKubeCondition(pod, "ContainersReady", "True", label);
  invariant(!pod.spec?.ephemeralContainers?.length, `${label} has unreviewed ephemeral containers.`);
  invariant(!pod.status?.ephemeralContainerStatuses?.length, `${label} reports unreviewed ephemeral container runtime state.`);
  for (const initStatus of pod.status?.initContainerStatuses ?? []) {
    invariant(!initStatus?.state?.running, `${label} has an unreviewed running init container.`);
  }
  const specContainer = requireSingleReviewedContainer(pod.spec?.containers, expected, `${label} spec`);
  const statuses = pod.status?.containerStatuses;
  invariant(Array.isArray(statuses) && statuses.length === 1, `${label} must report exactly one runtime container.`);
  const runtime = statuses[0];
  assertExact(runtime.name, specContainer.name, `${label} runtime container name`);
  assertExact(runtime.image, `${expected.name}@${expected.digest}`, `${label} runtime image reference`);
  assertExact(runtime.ready, true, `${label} runtime ready state`);
  invariant(isRecord(runtime.state?.running), `${label} container is not running.`);
  assertString(runtime.state.running.startedAt, `${label} container startedAt`);
  assertString(runtime.containerID, `${label} container runtime id`);
  requireReplicaCount(runtime.restartCount, `${label} restart count`);
  const digest = runtimeImageDigest(runtime.imageID, `${label} runtime imageID`);
  assertExact(digest, expected.digest, `${label} runtime image digest`);
  return {
    name: pod.metadata.name,
    namespace: pod.metadata.namespace,
    uid: pod.metadata.uid,
    resourceVersion: pod.metadata.resourceVersion,
    nodeName: pod.spec.nodeName,
    phase: pod.status.phase,
    ready: true,
    container: {
      name: runtime.name,
      image: runtime.image,
      imageID: runtime.imageID,
      digest,
      containerID: runtime.containerID,
      startedAt: runtime.state.running.startedAt,
      restartCount: runtime.restartCount,
    },
  };
}

function validateRunningWorkloads(deploymentReads, replicaSetReads, podReads, imageReceipt) {
  const inventories = {};
  for (const context of ALLOWED_KUBE_CONTEXTS) {
    inventories[context] = {
      deployments: requireList(deploymentReads[context], `${context} deployment read`),
      replicaSets: requireList(replicaSetReads[context], `${context} ReplicaSet read`),
      pods: requireList(podReads[context], `${context} Pod read`),
    };
  }
  const liveImages = {};
  const runtimeProof = {};
  for (const binding of deploymentImageBindings()) {
    const inventory = inventories[binding.context];
    const deploymentMatches = inventory.deployments.filter((item) => item?.metadata?.name === binding.name);
    invariant(deploymentMatches.length === 1, `verification must find exactly one ${binding.name} deployment in ${binding.context}.`);
    const deployment = deploymentMatches[0];
    const label = `${binding.name} deployment`;
    assertExact(deployment.metadata?.namespace, binding.namespace, `${label} namespace`);
    invariant(!deployment.metadata?.deletionTimestamp, `${label} is terminating.`);
    assertString(deployment.metadata?.uid, `${label} UID`);
    assertString(deployment.metadata?.resourceVersion, `${label} resourceVersion`);
    const generation = requireReplicaCount(deployment.metadata?.generation, `${label} generation`, 1);
    const desiredReplicas = requireReplicaCount(deployment.spec?.replicas, `${label} desired replicas`, 1);
    const expected = imageReceipt.images[binding.key];
    requireSingleReviewedContainer(deployment.spec?.template?.spec?.containers, expected, `${label} template`);
    const observedGeneration = requireReplicaCount(deployment.status?.observedGeneration, `${label} observed generation`);
    invariant(observedGeneration >= generation, `${label} rollout has not observed generation ${generation}.`);
    const rollout = {
      generation,
      observedGeneration,
      desiredReplicas,
      replicas: requireReplicaCount(deployment.status?.replicas, `${label} replicas`),
      updatedReplicas: requireReplicaCount(deployment.status?.updatedReplicas, `${label} updated replicas`),
      readyReplicas: requireReplicaCount(deployment.status?.readyReplicas, `${label} ready replicas`),
      availableReplicas: requireReplicaCount(deployment.status?.availableReplicas, `${label} available replicas`),
      unavailableReplicas: requireReplicaCount(deployment.status?.unavailableReplicas ?? 0, `${label} unavailable replicas`),
      terminatingReplicas: requireReplicaCount(deployment.status?.terminatingReplicas ?? 0, `${label} terminating replicas`),
    };
    assertExact(rollout.replicas, desiredReplicas, `${label} rollout replica count`);
    assertExact(rollout.updatedReplicas, desiredReplicas, `${label} updated replica count`);
    assertExact(rollout.readyReplicas, desiredReplicas, `${label} ready replica count`);
    assertExact(rollout.availableReplicas, desiredReplicas, `${label} available replica count`);
    assertExact(rollout.unavailableReplicas, 0, `${label} unavailable replica count`);
    assertExact(rollout.terminatingReplicas, 0, `${label} terminating replica count`);
    const available = requireKubeCondition(deployment, "Available", "True", label);
    const progressing = requireKubeCondition(deployment, "Progressing", "True", label);
    const replicaFailures = (deployment.status.conditions ?? []).filter((condition) => condition?.type === "ReplicaFailure");
    invariant(replicaFailures.every((condition) => condition.status !== "True"), `${label} reports a ReplicaFailure condition.`);

    const relatedReplicaSets = inventory.replicaSets.filter((replicaSet) => {
      const owner = controllerOwnerReference(replicaSet);
      return owner?.kind === "Deployment" && owner?.name === binding.name && replicaSet.metadata?.namespace === binding.namespace;
    });
    invariant(relatedReplicaSets.length > 0, `${label} must have at least one owned ReplicaSet.`);
    const selectorPods = inventory.pods.filter((pod) => (
      pod?.metadata?.namespace === binding.namespace
      && selectorMatches(deployment.spec?.selector, pod.metadata?.labels, `${label} Pod selector`)
    ));
    const activeReplicaSets = relatedReplicaSets.filter((replicaSet) => {
      const specReplicas = requireReplicaCount(replicaSet.spec?.replicas, `${replicaSet.metadata?.name} desired replicas`);
      const statusReplicas = requireReplicaCount(replicaSet.status?.replicas ?? 0, `${replicaSet.metadata?.name} status replicas`);
      return specReplicas > 0 || statusReplicas > 0;
    });
    invariant(activeReplicaSets.length === 1, `${label} rollout must have exactly one active ReplicaSet, found ${activeReplicaSets.length}.`);
    const activeReplicaSet = activeReplicaSets[0];
    const activeOwner = controllerOwnerReference(activeReplicaSet);
    assertExact(activeOwner?.apiVersion, "apps/v1", `${activeReplicaSet.metadata?.name} owner API version`);
    assertExact(activeOwner?.kind, "Deployment", `${activeReplicaSet.metadata?.name} owner kind`);
    assertExact(activeOwner?.name, deployment.metadata.name, `${activeReplicaSet.metadata?.name} owner name`);
    assertExact(activeOwner?.uid, deployment.metadata.uid, `${activeReplicaSet.metadata?.name} owner UID`);
    const activeReplicaSetState = validateReplicaSetState(activeReplicaSet, expected, deployment, `${activeReplicaSet.metadata?.name} ReplicaSet`);
    const replicaSetProof = relatedReplicaSets.map((replicaSet) => {
      const owner = controllerOwnerReference(replicaSet);
      const state = validateReplicaSetState(replicaSet, expected, deployment, `${replicaSet.metadata?.name} ReplicaSet`);
      const ownedPods = inventory.pods.filter((pod) => controllerOwnerReference(pod)?.uid === replicaSet.metadata?.uid).length;
      const active = replicaSet === activeReplicaSet;
      assertExact(replicaSet.metadata?.namespace, binding.namespace, `${replicaSet.metadata?.name} ReplicaSet namespace`);
      const templateImages = Array.isArray(replicaSet.spec?.template?.spec?.containers)
        ? replicaSet.spec.template.spec.containers.map((container) => container?.image)
        : [];
      if (!active) invariant(ownedPods === 0, `${replicaSet.metadata?.name} is inactive but still owns ${ownedPods} selected Pod(s).`);
      return {
        ...state,
        active,
        ownedByReviewedDeployment: owner?.uid === deployment.metadata.uid,
        imageReferences: templateImages,
        ownedPods,
      };
    });
    invariant(activeReplicaSetState.desiredReplicas === desiredReplicas, `${label} active ReplicaSet does not own the full desired rollout.`);
    const activeOwnedPods = inventory.pods.filter((pod) => controllerOwnerReference(pod)?.uid === activeReplicaSet.metadata.uid);
    assertExact(selectorPods.length, desiredReplicas, `${label} selected Pod count`);
    assertExact(activeOwnedPods.length, desiredReplicas, `${label} active ReplicaSet owned Pod count`);
    const selectedPodUids = new Set(selectorPods.map((pod) => pod?.metadata?.uid));
    invariant(activeOwnedPods.every((pod) => selectedPodUids.has(pod?.metadata?.uid)), `${label} has an active owned Pod outside its reviewed selector.`);
    const pods = selectorPods.map((pod, index) => validateRunningPod(
      pod,
      activeReplicaSet,
      expected,
      `${binding.name} Pod ${pod?.metadata?.name ?? index}`,
    ));
    const expectedReference = `${expected.name}@${expected.digest}`;
    liveImages[binding.key] = expectedReference;
    runtimeProof[binding.key] = {
      deployment: {
        name: deployment.metadata.name,
        uid: deployment.metadata.uid,
        resourceVersion: deployment.metadata.resourceVersion,
        generation,
        image: expectedReference,
        rollout,
        conditions: [
          { type: available.type, status: available.status, reason: available.reason ?? null },
          { type: progressing.type, status: progressing.status, reason: progressing.reason ?? null },
        ],
      },
      replicaSets: replicaSetProof,
      pods,
    };
  }
  return { liveImages, runtimeProof };
}

async function runVerify(argv, deps) {
  const flags = parseFlags(argv, ["verify-receipt", "image-receipt", "head", "evidence-out"], "verify");
  invariant(/^[0-9a-f]{40}$/.test(flags.head), "verify source head must be a full lowercase 40-character commit id.");
  const receipt = readSafeReceipt(flags["verify-receipt"], "verify receipt");
  const imageReceipt = readSafeReceipt(flags["image-receipt"], "image receipt");
  validateImageReceipt(imageReceipt, flags.head);
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
  const appDeployments = parseRunnerJson(await invoke(
    deps.runner,
    "kubectl",
    readOnlyKubeList(receipt.appContext, CONFIG.namespaces.feature, "deployment"),
  ), "app deployment verification");
  const relayDeployments = parseRunnerJson(await invoke(
    deps.runner,
    "kubectl",
    readOnlyKubeList(receipt.relayContext, CONFIG.namespaces.relay, "deployment"),
  ), "relay deployment verification");
  const appReplicaSets = parseRunnerJson(await invoke(
    deps.runner,
    "kubectl",
    readOnlyKubeList(receipt.appContext, CONFIG.namespaces.feature, "replicaset"),
  ), "app ReplicaSet verification");
  const relayReplicaSets = parseRunnerJson(await invoke(
    deps.runner,
    "kubectl",
    readOnlyKubeList(receipt.relayContext, CONFIG.namespaces.relay, "replicaset"),
  ), "relay ReplicaSet verification");
  const appPods = parseRunnerJson(await invoke(
    deps.runner,
    "kubectl",
    readOnlyKubeList(receipt.appContext, CONFIG.namespaces.feature, "pod"),
  ), "app Pod verification");
  const relayPods = parseRunnerJson(await invoke(
    deps.runner,
    "kubectl",
    readOnlyKubeList(receipt.relayContext, CONFIG.namespaces.relay, "pod"),
  ), "relay Pod verification");
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
  const expectedAzureInventory = [
    { name: CONFIG.aks.name, type: "Microsoft.ContainerService/managedClusters" },
    { name: CONFIG.postgres.server, type: "Microsoft.DBforPostgreSQL/flexibleServers" },
    { name: CONFIG.storage.account, type: "Microsoft.Storage/storageAccounts" },
    { name: CONFIG.acr, type: "Microsoft.ContainerRegistry/registries" },
  ];
  for (const expected of expectedAzureInventory) {
    const matches = azure.filter((item) => item?.name === expected.name);
    invariant(matches.length === 1, `Azure verification must find exactly one ${expected.name}.`);
    const resource = matches[0];
    assertExact(resource.type?.toLowerCase(), expected.type.toLowerCase(), `${expected.name} resource type`);
    assertExact(resource.resourceGroup, CONFIG.target.resourceGroup, `${expected.name} resource group`);
    assertExact(resource.location, CONFIG.target.location, `${expected.name} location`);
    assertExact(
      String(resource.id).toLowerCase(),
      `/subscriptions/${CONFIG.target.subscriptionId}/resourcegroups/${CONFIG.target.resourceGroup}/providers/${expected.type}/${expected.name}`.toLowerCase(),
      `${expected.name} resource id`,
    );
    assertExact(resource.tags?.["wdm-expires-at"], CONFIG.expiry.expiresAt, `${expected.name} expiry tag`);
  }
  const expectedAzureNames = expectedAzureInventory.map((item) => item.name);
  const aksInventory = validateAksInventory(aks);

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

  const { liveImages, runtimeProof } = validateRunningWorkloads(
    { "decision11-app": appDeployments, "decision11-relay": relayDeployments },
    { "decision11-app": appReplicaSets, "decision11-relay": relayReplicaSets },
    { "decision11-app": appPods, "decision11-relay": relayPods },
    imageReceipt,
  );

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
    aks: aksInventory,
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
    runtimeProof,
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

function validateSmokeIdentity(id, output, seenDemoIds, seenSessionIds) {
  const identityFields = ["id", "demoId"]
    .filter((field) => Object.hasOwn(output ?? {}, field))
    .map((field) => [field, output[field]]);
  invariant(identityFields.length > 0, `smoke ${id} response did not name its demo identity.`);
  for (const [field, value] of identityFields) {
    assertExact(value, id, `smoke response ${field} identity for ${id}`);
  }
  invariant(!seenDemoIds.has(id), `smoke returned duplicate demo response identity for ${id}.`);

  const sessionId = assertString(output?.sessionId, `smoke ${id} session id`);
  const sessionFields = [
    ["session.id", output?.session?.id],
    ["session.sessionId", output?.session?.sessionId],
  ].filter(([, value]) => value !== undefined && value !== null);
  for (const [field, value] of sessionFields) {
    assertExact(value, sessionId, `smoke ${id} conflicting ${field} session identity`);
  }
  const expectedPrefixes = DEMO_SESSION_PREFIXES[id];
  invariant(Array.isArray(expectedPrefixes) && expectedPrefixes.length > 0, `smoke ${id} has no approved synthetic session prefix.`);
  invariant(
    expectedPrefixes.some((prefix) => sessionId.startsWith(prefix)),
    `smoke ${id} session response identity is not under one of its approved synthetic prefixes.`,
  );
  invariant(!seenSessionIds.has(sessionId), `smoke returned a duplicate session identity for ${id}.`);
  seenDemoIds.add(id);
  seenSessionIds.add(sessionId);
}

function validateSmokeOutput(id, output, seenDemoIds, seenSessionIds) {
  validateSmokeIdentity(id, output, seenDemoIds, seenSessionIds);
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
      "replay demo must record exactly one accepted replay completion and zero duplicate durable completions.",
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
  const seenDemoIds = new Set();
  const seenSessionIds = new Set();
  let requestCount = 0;
  let billableTokens = 0;
  for (const demo of receipt.demos) {
    invariant(isRecord(demo.input), `smoke demo ${demo.id} input must be an object.`);
    assertMutable("smoke", deps.now);
    const output = await postApplicationJson(deps.runner, url, { id: demo.id, input: demo.input }, authValue, { command: "smoke", now: deps.now });
    const summary = validateSmokeOutput(demo.id, output, seenDemoIds, seenSessionIds);
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
  return asset.kind === "kubernetes"
    ? `${asset.kind}:${asset.namespace}:${asset.resource}:${asset.name}`
    : `${asset.kind}:${asset.resourceGroup ?? "global"}:${asset.name}`;
}

function exactTeardownConfirmation(assets) {
  const identities = new Map();
  for (const asset of assets) {
    if (asset.kind !== "kubernetes") continue;
    const identity = `${asset.namespace}:${asset.name}`;
    const resources = identities.get(identity) ?? new Set();
    resources.add(asset.resource);
    identities.set(identity, resources);
  }
  const resourceQualified = [...identities.values()].some((resources) => resources.size > 1);
  const list = assets.map((asset) => {
    if (asset.kind !== "kubernetes" || !resourceQualified) {
      return `${asset.kind}:${asset.namespace ?? asset.resourceGroup ?? "global"}:${asset.name}`;
    }
    return assetLabel(asset);
  }).sort().join(",");
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

function kubernetesAssetApiPath(asset, label) {
  const apiResources = {
    configmap: ["api/v1", "configmaps"],
    cronjob: ["apis/batch/v1", "cronjobs"],
    deployment: ["apis/apps/v1", "deployments"],
    job: ["apis/batch/v1", "jobs"],
    networkpolicy: ["apis/networking.k8s.io/v1", "networkpolicies"],
    role: ["apis/rbac.authorization.k8s.io/v1", "roles"],
    rolebinding: ["apis/rbac.authorization.k8s.io/v1", "rolebindings"],
    secret: ["api/v1", "secrets"],
    service: ["api/v1", "services"],
    serviceaccount: ["api/v1", "serviceaccounts"],
  };
  const [api, plural] = apiResources[asset.resource] ?? [];
  invariant(api, `${label} has no reviewed Kubernetes API mapping.`);
  invariant(/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(asset.name), `${label} name is not a safe Kubernetes path segment.`);
  return `/${api}/namespaces/${asset.namespace}/${plural}/${asset.name}`;
}

function teardownAssetAction(asset) {
  return asset.action ?? "delete";
}

function isAccessClosureTarget(asset) {
  return asset.kind === "kubernetes"
    && asset.resource === "deployment"
    && CONFIG.teardown.closeDeployments.some((item) => (
      item.context === asset.context && item.namespace === asset.namespace && item.name === asset.name
    ));
}

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
      const action = teardownAssetAction(asset);
      invariant(["delete", "scale-zero"].includes(action), `teardown asset ${label} has an unreviewed action ${String(action)}.`);
      if (isAccessClosureTarget(asset)) {
        assertExact(action, "scale-zero", `${label} access-closure action`);
      } else {
        assertExact(action, "delete", `${label} non-closure action`);
      }
      assertString(asset.uid, `teardown asset ${label} UID`);
      assertString(asset.apiPath, `teardown asset ${label} API path`);
      assertExact(asset.apiPath, kubernetesAssetApiPath(asset, label), `${label} API path`);
    } else if (asset.kind === "azure") {
      assertExact(teardownAssetAction(asset), "delete", `${label} Azure action`);
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

async function readKubernetesTeardownAsset(runner, asset, deadline) {
  const args = [
    "--context", asset.context,
    "--namespace", asset.namespace,
    "get", asset.resource, asset.name,
    "-o", "json",
  ];
  const result = deadline
    ? await readTeardownQuiescenceKube(runner, args, "deployment", deadline)
    : await invoke(runner, "kubectl", args);
  return parseRunnerJson(result, `teardown ${deadline ? "quiescence read" : "precondition"} for ${assetLabel(asset)}`);
}

async function precheckTeardownAsset(runner, asset) {
  if (asset.kind === "kubernetes") {
    const result = await readKubernetesTeardownAsset(runner, asset);
    assertExact(result.metadata?.name, asset.name, `${assetLabel(asset)} live name`);
    invariant(
      result.metadata?.uid === asset.uid,
      `UID precondition failed for ${assetLabel(asset)}: live ${String(result.metadata?.uid)} is a replacement UID; expected ${asset.uid}.`,
    );
    assertString(result.metadata?.resourceVersion, `${assetLabel(asset)} resourceVersion`);
    return { ...asset, resourceVersion: result.metadata.resourceVersion, identitySource: "teardown-receipt" };
  }
  const result = parseRunnerJson(await invoke(runner, "az", [
    "resource", "show",
    "--ids", asset.resourceId,
    "-o", "json",
  ]), `teardown precondition for ${assetLabel(asset)}`);
  assertExact(result.name, asset.name, `${assetLabel(asset)} live name`);
  assertExact(result.tags?.["wdm-resource-uid"], asset.uid, `${assetLabel(asset)} canonical UID`);
  return { ...asset, resourceVersion: result.tags?.["wdm-resource-uid"], identitySource: "teardown-receipt" };
}

async function precheckAccessClosureDeployment(runner, item) {
  const asset = {
    kind: "kubernetes",
    context: item.context,
    resource: "deployment",
    namespace: item.namespace,
    name: item.name,
    action: "scale-zero",
  };
  asset.apiPath = kubernetesAssetApiPath(asset, assetLabel(asset));
  const result = await readKubernetesTeardownAsset(runner, asset);
  assertExact(result.metadata?.name, asset.name, `${assetLabel(asset)} live name`);
  assertString(result.metadata?.uid, `${assetLabel(asset)} UID`);
  assertString(result.metadata?.resourceVersion, `${assetLabel(asset)} resourceVersion`);
  return {
    ...asset,
    uid: result.metadata.uid,
    resourceVersion: result.metadata.resourceVersion,
    identitySource: "execution-precheck",
  };
}

function closurePatch(asset) {
  return JSON.stringify([
    { op: "test", path: "/metadata/uid", value: asset.uid },
    { op: "test", path: "/metadata/resourceVersion", value: asset.resourceVersion },
    { op: "replace", path: "/spec/replicas", value: 0 },
  ]);
}

async function closeDecisionAccess(runner, assets, now) {
  for (const asset of assets) {
    assertMutable("teardown", now);
    await invoke(runner, "kubectl", [
      "--context", asset.context,
      "patch", "deployment", asset.name,
      "--subresource=scale",
      "--type=json",
      "--patch-file", "-",
    ], {
      ...mutatingInvocationOptions("teardown", now),
      namespace: asset.namespace,
      input: closurePatch(asset),
      uid: asset.uid,
      resourceVersion: asset.resourceVersion,
    });
  }
}

function podQuiescenceEvidence(pod) {
  const owner = controllerOwnerReference(pod);
  return {
    name: pod?.metadata?.name ?? null,
    namespace: pod?.metadata?.namespace ?? null,
    uid: pod?.metadata?.uid ?? null,
    resourceVersion: pod?.metadata?.resourceVersion ?? null,
    deletionTimestamp: pod?.metadata?.deletionTimestamp ?? null,
    phase: pod?.status?.phase ?? null,
    owner: owner ? {
      apiVersion: owner.apiVersion ?? null,
      kind: owner.kind ?? null,
      name: owner.name ?? null,
      uid: owner.uid ?? null,
    } : null,
  };
}

function replicaSetQuiescenceEvidence(replicaSet, blockers, label) {
  assertString(replicaSet.metadata?.name, `${label} name`);
  assertString(replicaSet.metadata?.uid, `${label} UID`);
  assertString(replicaSet.metadata?.resourceVersion, `${label} resourceVersion`);
  const generation = requireReplicaCount(replicaSet.metadata?.generation, `${label} generation`, 1);
  const observedGeneration = requireReplicaCount(replicaSet.status?.observedGeneration ?? 0, `${label} observed generation`);
  const specReplicas = requireReplicaCount(replicaSet.spec?.replicas, `${label} desired replicas`);
  const status = {
    replicas: requireReplicaCount(replicaSet.status?.replicas ?? 0, `${label} replicas`),
    readyReplicas: requireReplicaCount(replicaSet.status?.readyReplicas ?? 0, `${label} ready replicas`),
    availableReplicas: requireReplicaCount(replicaSet.status?.availableReplicas ?? 0, `${label} available replicas`),
    fullyLabeledReplicas: requireReplicaCount(replicaSet.status?.fullyLabeledReplicas ?? 0, `${label} fully labeled replicas`),
    terminatingReplicas: requireReplicaCount(replicaSet.status?.terminatingReplicas ?? 0, `${label} terminating replicas`),
  };
  if (specReplicas !== 0) blockers.push(`${label} still requests ${specReplicas} replica(s).`);
  if (observedGeneration < generation) blockers.push(`${label} has not observed generation ${generation}.`);
  for (const [field, count] of Object.entries(status)) {
    if (count !== 0) blockers.push(`${label} status.${field} is ${count}.`);
  }
  return {
    name: replicaSet.metadata.name,
    namespace: replicaSet.metadata.namespace ?? null,
    uid: replicaSet.metadata.uid,
    resourceVersion: replicaSet.metadata.resourceVersion,
    generation,
    observedGeneration,
    specReplicas,
    status,
  };
}

function deploymentQuiescenceEvidence(asset, deployment, replicaSets, pods, blockers) {
  const label = `${assetLabel(asset)} quiescence`;
  assertExact(deployment.metadata?.name, asset.name, `${label} live name`);
  assertExact(deployment.metadata?.namespace, asset.namespace, `${label} live namespace`);
  invariant(
    deployment.metadata?.uid === asset.uid,
    `UID precondition failed during ${label}: live ${String(deployment.metadata?.uid)} is a replacement UID; expected ${asset.uid}.`,
  );
  assertString(deployment.metadata?.resourceVersion, `${label} live resourceVersion`);
  const generation = requireReplicaCount(deployment.metadata?.generation, `${label} generation`, 1);
  const observedGeneration = requireReplicaCount(deployment.status?.observedGeneration ?? 0, `${label} observed generation`);
  const specReplicas = requireReplicaCount(deployment.spec?.replicas, `${label} desired replicas`);
  const status = {
    replicas: requireReplicaCount(deployment.status?.replicas ?? 0, `${label} replicas`),
    updatedReplicas: requireReplicaCount(deployment.status?.updatedReplicas ?? 0, `${label} updated replicas`),
    readyReplicas: requireReplicaCount(deployment.status?.readyReplicas ?? 0, `${label} ready replicas`),
    availableReplicas: requireReplicaCount(deployment.status?.availableReplicas ?? 0, `${label} available replicas`),
    unavailableReplicas: requireReplicaCount(deployment.status?.unavailableReplicas ?? 0, `${label} unavailable replicas`),
    terminatingReplicas: requireReplicaCount(deployment.status?.terminatingReplicas ?? 0, `${label} terminating replicas`),
  };
  if (deployment.metadata?.deletionTimestamp) blockers.push(`${label} Deployment is terminating.`);
  if (specReplicas !== 0) blockers.push(`${label} desired replicas is ${specReplicas}.`);
  if (observedGeneration < generation) blockers.push(`${label} has not observed generation ${generation}.`);
  for (const [field, count] of Object.entries(status)) {
    if (count !== 0) blockers.push(`${label} status.${field} is ${count}.`);
  }

  const ownedReplicaSets = replicaSets.filter((replicaSet) => {
    const owner = controllerOwnerReference(replicaSet);
    if (owner?.uid !== asset.uid) return false;
    assertExact(owner.apiVersion, "apps/v1", `${replicaSet.metadata?.name ?? "ReplicaSet"} owner API version`);
    assertExact(owner.kind, "Deployment", `${replicaSet.metadata?.name ?? "ReplicaSet"} owner kind`);
    assertExact(owner.name, asset.name, `${replicaSet.metadata?.name ?? "ReplicaSet"} owner name`);
    assertExact(replicaSet.metadata?.namespace, asset.namespace, `${replicaSet.metadata?.name ?? "ReplicaSet"} namespace`);
    return true;
  });
  const replicaSetProof = ownedReplicaSets.map((replicaSet, index) => replicaSetQuiescenceEvidence(
    replicaSet,
    blockers,
    `${assetLabel(asset)} owned ReplicaSet ${replicaSet.metadata?.name ?? index}`,
  ));
  const ownedReplicaSetUids = new Set(replicaSetProof.map((replicaSet) => replicaSet.uid));
  const selector = deployment.spec?.selector;
  const selectedPods = pods.filter((pod) => (
    pod?.metadata?.namespace === asset.namespace
    && selectorMatches(selector, pod.metadata?.labels, `${label} Pod selector`)
  ));
  const ownedPods = pods.filter((pod) => ownedReplicaSetUids.has(controllerOwnerReference(pod)?.uid));
  const relatedPods = [...new Set([...selectedPods, ...ownedPods])];
  const runningPods = relatedPods.filter((pod) => (
    pod?.status?.phase === "Running"
    || (pod?.status?.initContainerStatuses ?? []).some((container) => container?.state?.running)
    || (pod?.status?.containerStatuses ?? []).some((container) => container?.state?.running)
  ));
  const terminatingPods = relatedPods.filter((pod) => pod?.metadata?.deletionTimestamp);
  if (selectedPods.length !== 0) blockers.push(`${label} still selects ${selectedPods.length} Pod(s).`);
  if (ownedPods.length !== 0) blockers.push(`${label} still owns ${ownedPods.length} Pod(s) through ReplicaSets.`);
  if (runningPods.length !== 0) blockers.push(`${label} still has ${runningPods.length} running Pod(s).`);
  if (terminatingPods.length !== 0) blockers.push(`${label} still has ${terminatingPods.length} terminating Pod(s).`);
  return {
    context: asset.context,
    name: asset.name,
    namespace: asset.namespace,
    uid: asset.uid,
    preScaleResourceVersion: asset.resourceVersion,
    resourceVersion: deployment.metadata.resourceVersion,
    generation,
    observedGeneration,
    specReplicas,
    status,
    selector,
    ownedReplicaSets: replicaSetProof,
    selectedPods: selectedPods.map(podQuiescenceEvidence),
    ownedPods: ownedPods.map(podQuiescenceEvidence),
    runningPods: runningPods.map(podQuiescenceEvidence),
    terminatingPods: terminatingPods.map(podQuiescenceEvidence),
    pods: relatedPods.map(podQuiescenceEvidence),
  };
}

async function readTeardownQuiescenceKube(runner, args, readPhase, { deadlineMs, now }) {
  const remainingMs = deadlineMs - currentTime(now).getTime();
  const timeoutError = new CommandTimeoutError(`${readPhase} read timed out`, readPhase);
  if (remainingMs <= 0) throw timeoutError;

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), remainingMs);
  });
  try {
    const result = await Promise.race([
      timeout,
      invoke(runner, "kubectl", [...args, `--request-timeout=${remainingMs}ms`], { timeoutMs: remainingMs }),
    ]);
    if (currentTime(now).getTime() >= deadlineMs) throw timeoutError;
    return result;
  } catch (error) {
    if (error instanceof CommandTimeoutError || currentTime(now).getTime() >= deadlineMs) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readTeardownQuiescenceRound(runner, assets, deadline) {
  const deployments = new Map();
  for (const asset of assets) {
    const deployment = await readKubernetesTeardownAsset(runner, asset, deadline);
    deployments.set(assetLabel(asset), deployment);
  }

  const inventories = new Map();
  for (const asset of assets) {
    const key = `${asset.context}\n${asset.namespace}`;
    if (inventories.has(key)) continue;
    const replicaSets = parseRunnerJson(await readTeardownQuiescenceKube(
      runner,
      readOnlyKubeList(asset.context, asset.namespace, "replicaset"),
      "replicaset",
      deadline,
    ), `${asset.context}/${asset.namespace} ReplicaSet quiescence read`);
    const pods = parseRunnerJson(await readTeardownQuiescenceKube(
      runner,
      readOnlyKubeList(asset.context, asset.namespace, "pod"),
      "pod",
      deadline,
    ), `${asset.context}/${asset.namespace} Pod quiescence read`);
    inventories.set(key, {
      replicaSets: requireList(replicaSets, `${asset.context}/${asset.namespace} ReplicaSet quiescence read`),
      pods: requireList(pods, `${asset.context}/${asset.namespace} Pod quiescence read`),
    });
  }

  const blockers = [];
  const workloads = assets.map((asset) => {
    const inventory = inventories.get(`${asset.context}\n${asset.namespace}`);
    return deploymentQuiescenceEvidence(
      asset,
      deployments.get(assetLabel(asset)),
      inventory.replicaSets,
      inventory.pods,
      blockers,
    );
  });
  return { ok: blockers.length === 0, blockers, workloads };
}

function quiescenceEvidenceError(error, evidence) {
  error.teardownQuiescenceEvidence = evidence;
  return error;
}

async function proveTeardownQuiescence(runner, assets, deps) {
  const startedAt = currentTime(deps.now);
  const startedMs = startedAt.getTime();
  const closureMs = Date.parse(CONFIG.expiry.closureStartsAt);
  invariant(Number.isFinite(closureMs), "The frozen closure deadline is invalid.");
  const timeoutDeadlineMs = startedMs + TEARDOWN_QUIESCENCE_TIMEOUT_MS;
  const deadlineMs = Math.min(timeoutDeadlineMs, closureMs);
  const deadlineAt = new Date(deadlineMs).toISOString();
  const deadline = { deadlineMs, now: deps.now };
  const timeoutMs = Math.max(0, deadlineMs - startedMs);
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / TEARDOWN_QUIESCENCE_POLL_MS) + 1);
  let lastProof = null;
  let attempts = 0;
  const evidenceBase = {
    ok: false,
    startedAt: startedAt.toISOString(),
    deadlineAt,
    closureStartsAt: CONFIG.expiry.closureStartsAt,
    timeoutMs: TEARDOWN_QUIESCENCE_TIMEOUT_MS,
    pollIntervalMs: TEARDOWN_QUIESCENCE_POLL_MS,
  };
  const fail = (message, detail = {}) => {
    const evidence = {
      ...evidenceBase,
      ...(lastProof ?? {}),
      ...detail,
      ok: false,
      attempts,
      completedAt: currentTime(deps.now).toISOString(),
      error: message,
    };
    throw quiescenceEvidenceError(new Error(message), evidence);
  };

  try {
    while (attempts < maxAttempts) {
      const beforeRead = currentTime(deps.now);
      if (beforeRead.getTime() >= deadlineMs) {
        fail(`Teardown quiescence failed: the strict deadline ${deadlineAt} elapsed before closure proof completed.`);
      }
      attempts += 1;
      const round = await readTeardownQuiescenceRound(runner, assets, deadline);
      const afterRead = currentTime(deps.now);
      lastProof = {
        ...round,
        attempts,
        observedAt: afterRead.toISOString(),
      };
      if (afterRead.getTime() >= deadlineMs) {
        fail(`Teardown quiescence failed: the strict deadline ${deadlineAt} elapsed during an exact workload read.`);
      }
      if (round.ok) {
        return {
          ...evidenceBase,
          ...lastProof,
          ok: true,
          completedAt: afterRead.toISOString(),
        };
      }
      if (attempts >= maxAttempts) {
        fail(`Teardown quiescence failed before ${deadlineAt}; remaining Pods are not eligible for deletion.`);
      }
      const waitMs = Math.min(TEARDOWN_QUIESCENCE_POLL_MS, deadlineMs - afterRead.getTime());
      await deps.wait(waitMs);
    }
  } catch (error) {
    if (error.teardownQuiescenceEvidence) throw error;
    if (error instanceof CommandTimeoutError) {
      fail(`Teardown quiescence failed: ${error.message} (strict deadline ${deadlineAt}).`, {
        timedOut: true,
        readPhase: error.readPhase,
      });
    }
    fail(`Teardown quiescence could not be proven: ${error.message}`);
  }
  fail(`Teardown quiescence failed after ${attempts} bounded read attempts.`);
}

async function deleteKubernetesTeardownAsset(runner, asset, now) {
  invariant(asset.kind === "kubernetes", `Automated teardown cannot delete ${assetLabel(asset)}; only Kubernetes UID-precondition deletes are allowed.`);
  assertExact(teardownAssetAction(asset), "delete", `${assetLabel(asset)} deletion action`);
  assertMutable("teardown", now);
  const body = JSON.stringify({
    kind: "DeleteOptions",
    apiVersion: "v1",
    preconditions: { uid: asset.uid, resourceVersion: asset.resourceVersion },
  });
  await invoke(runner, "kubectl", [
    "--context", asset.context,
    "delete", asset.resource, asset.name,
    "--wait=false",
  ], {
    ...mutatingInvocationOptions("teardown", now),
    namespace: asset.namespace,
    input: body,
    deleteApiPath: asset.apiPath,
    uid: asset.uid,
  });
}

function operatorAzureDeletionRequirement(asset) {
  return {
    kind: "azure",
    name: asset.name,
    resourceGroup: asset.resourceGroup,
    uid: asset.uid,
    action: "operator-delete",
    requirement: "Delete only through a documented ARM operation with an atomic server-side resource precondition; this command intentionally does not issue az resource delete.",
  };
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
  const closureAssets = checked.filter((asset) => teardownAssetAction(asset) === "scale-zero");
  for (const item of CONFIG.teardown.closeDeployments) {
    if (!closureAssets.some((asset) => (
      asset.context === item.context && asset.namespace === item.namespace && asset.name === item.name
    ))) {
      const prechecked = await precheckAccessClosureDeployment(deps.runner, item);
      closureAssets.push(prechecked);
      checked.push(prechecked);
    }
  }
  invariant(closureAssets.length === CONFIG.teardown.closeDeployments.length, "Access closure must fence every reviewed Deployment exactly once.");
  await closeDecisionAccess(deps.runner, closureAssets, deps.now);
  const kubernetesAssets = checked.filter((asset) => asset.kind === "kubernetes" && teardownAssetAction(asset) === "delete");
  const azureAssets = checked.filter((asset) => asset.kind === "azure");
  let quiescence;
  try {
    quiescence = await proveTeardownQuiescence(deps.runner, closureAssets, deps);
  } catch (error) {
    const failureEvidence = {
      ok: false,
      command: "teardown",
      state: "quiescence-failed",
      observedAt: currentTime(deps.now).toISOString(),
      accessClosed: false,
      assetsPrechecked: checked.length,
      assetsScalePatchesSucceeded: closureAssets.length,
      assetsScaledToZero: 0,
      assetsDeleted: 0,
      assets: checked.map((asset) => ({
        kind: asset.kind,
        name: asset.name,
        namespace: asset.namespace ?? null,
        resourceGroup: asset.resourceGroup ?? null,
        uid: asset.uid,
        resourceVersion: asset.resourceVersion,
        action: teardownAssetAction(asset),
        identitySource: asset.identitySource,
        state: teardownAssetAction(asset) === "scale-zero"
          ? "scale-patch-succeeded-not-quiescent"
          : "deletion-blocked-by-quiescence",
      })),
      operatorDeletionRequired: [],
      quiescence: error.teardownQuiescenceEvidence ?? {
        ok: false,
        error: error.message,
      },
      error: error.message,
      expiresAt: CONFIG.expiry.expiresAt,
      closureStartsAt: CONFIG.expiry.closureStartsAt,
    };
    writeEvidence(flags["evidence-out"], failureEvidence);
    throw error;
  }

  for (const asset of kubernetesAssets) await deleteKubernetesTeardownAsset(deps.runner, asset, deps.now);
  const operatorDeletionRequired = azureAssets.map(operatorAzureDeletionRequirement);

  const evidence = {
    ok: operatorDeletionRequired.length === 0,
    command: "teardown",
    state: operatorDeletionRequired.length === 0 ? "complete" : "operator-action-required",
    observedAt: currentTime(deps.now).toISOString(),
    accessClosed: true,
    assetsPrechecked: checked.length,
    assetsScalePatchesSucceeded: closureAssets.length,
    assetsScaledToZero: closureAssets.length,
    assetsDeleted: kubernetesAssets.length,
    assets: checked.map((asset) => ({
      kind: asset.kind,
      name: asset.name,
      namespace: asset.namespace ?? null,
      resourceGroup: asset.resourceGroup ?? null,
      uid: asset.uid,
      resourceVersion: asset.resourceVersion,
      action: teardownAssetAction(asset),
      identitySource: asset.identitySource,
      state: asset.kind === "azure"
        ? "operator-deletion-required"
        : teardownAssetAction(asset) === "scale-zero" ? "scaled-zero" : "deleted",
    })),
    operatorDeletionRequired,
    quiescence,
    expiresAt: CONFIG.expiry.expiresAt,
    closureStartsAt: CONFIG.expiry.closureStartsAt,
  };
  writeEvidence(flags["evidence-out"], evidence);
  return { ok: evidence.ok, evidence };
}

export async function runDecision11(command, argv, dependencies = {}) {
  const bindings = resolveBindings(argv, dependencies.bindings, dependencies.bindingsSha256);
  invariant(COMMANDS.has(command), `Unknown command ${command}. Expected one of: ${[...COMMANDS].join(", ")}.`);
  const deps = {
    runner: dependencies.runner ?? defaultRunner,
    now: dependencies.now ?? (() => new Date()),
    wait: dependencies.wait ?? waitForTeardownPoll,
    env: dependencies.env ?? process.env,
  };
  return ACTIVE_CONFIG.run(bindings.config, async () => {
    validateConfig();
    assertMutable(command, deps.now);
    if (command === "setup") return runSetup(bindings.argv, deps);
    if (command === "reset") return runReset(bindings.argv, deps);
    if (command === "verify") return runVerify(bindings.argv, deps);
    if (command === "smoke") return runSmoke(bindings.argv, deps);
    return runTeardown(bindings.argv, deps);
  });
}

function usage() {
  return [
    "Usage: decision11.mjs <setup|reset|verify|smoke|teardown> --bindings-receipt <path> [required receipt flags]",
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
  if (result.ok !== true) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
