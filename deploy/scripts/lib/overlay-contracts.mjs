// Single source of truth for per-overlay env-key contracts.
//
// Each portal overlay (the value `resolveOverlayKey()` returns) maps to a
// contract with four role buckets:
//
//   userRequiredEnvKeys: must be present + non-empty BEFORE deploy.mjs runs
//                    any step. Operator-supplied (new-env scaffold or
//                    hand-edited deploy/envs/local/<env>/.env).
//   composedEnvKeys: populated by compose-env.mjs from upstream bicep
//                    outputs (POSTGRES_FQDN, BLOB_CONTAINER_ENDPOINT, …).
//                    Required at substitute time, not at the pre-deploy
//                    gate (chicken-and-egg: bicep step produces the inputs
//                    they're composed from).
//   stubKeys:        off-path keys that must exist in the env Map for
//                    substitute-env.mjs's target-based fail-closed gate
//                    to succeed. deploy.mjs auto-fills these with the
//                    `unused` sentinel.
//   bicepOutputKeys: populated by deploy-bicep.mjs via the OUTPUT_ALIAS
//                    map (or sourced from the base template.env, for the
//                    handful of static keys this group also covers).
//                    Required at substitute time but not at the pre-deploy
//                    validator.
//
// Adding a new overlay key is a one-line change in this file —
// deploy.mjs / new-env.mjs pick it up automatically via the contract
// table.

export { databaseOverlayOmittedKeys } from "./database-env.mjs";
import { PORTAL_CONFIG_KEYS } from "./portal-config.mjs";

// Edge mode and TLS source value spaces. Mirrors `new-env.mjs` EDGE_MODES /
// TLS_SOURCES — kept in sync via overlay-contracts.test.mjs.
export const EDGE_MODES = ["afd", "private", "public", "port-forward"];
export const TLS_SOURCES = ["letsencrypt", "akv", "akv-selfsigned"];

// JS-side authoritative defaults. Single source of truth — referenced by
// stage-manifests.mjs:resolveOverlayName() and portal/bicep/main.bicep
// (the bicep-side defaults carry a comment pointer to this file).
export const DEFAULT_EDGE_MODE = "afd";
export const DEFAULT_TLS_SOURCE = "letsencrypt";

export const SUPPORTED_TLS_BY_EDGE = Object.freeze({
  afd: Object.freeze(["letsencrypt", "akv"]),
  private: Object.freeze(["akv", "akv-selfsigned"]),
  public: Object.freeze(["letsencrypt"]),
  "port-forward": Object.freeze(["akv-selfsigned"]),
});

export function unsupportedEdgeTlsReason(edgeMode, tlsSource) {
  const supported = SUPPORTED_TLS_BY_EDGE[edgeMode];
  if (!supported || supported.includes(tlsSource)) return null;
  if (edgeMode === "port-forward") {
    return "Port-forward mode has no public or private ingress endpoint and uses a locally initiated AKV self-signed certificate.";
  }
  if (edgeMode === "private") {
    return "Private ingress has no public HTTP-01 endpoint. Use TLS_SOURCE=akv or akv-selfsigned.";
  }
  if (edgeMode === "public") {
    return "Public NGINX currently supports TLS_SOURCE=letsencrypt only.";
  }
  return "Azure Front Door requires a publicly trusted origin certificate. Use TLS_SOURCE=letsencrypt or akv.";
}

export function edgeModeTransitionReason(deployedEdgeMode, requestedEdgeMode) {
  if (!deployedEdgeMode || deployedEdgeMode === requestedEdgeMode) return null;
  return (
    `In-place EDGE_MODE transitions are not supported (deployed='${deployedEdgeMode}', ` +
    `requested='${requestedEdgeMode}'). Azure deployments are incremental, so changing modes ` +
    "can leave the previous ingress resources active. Create a new stamp or decommission the " +
    "existing stamp before changing EDGE_MODE."
  );
}

export function parseDeployedEdgeModeLookup({
  status,
  stdout = "",
  stderr = "",
  deploymentName,
}) {
  if (status !== 0) {
    const details = `${stderr}\n${stdout}`.trim();
    if (/\b(?:DeploymentNotFound|ResourceGroupNotFound)\b/i.test(details)) {
      return null;
    }
    throw new Error(
      `Failed to inspect existing deployment "${deploymentName}" before validating EDGE_MODE` +
        `${details ? `:\n${details}` : ` (Azure CLI exited ${status})`}`,
    );
  }

  let lookup;
  try {
    lookup = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Azure returned invalid deployment metadata for "${deploymentName}": ${error.message}`,
    );
  }

  const deployedEdgeMode = [lookup?.output, lookup?.parameter]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .find((value) => EDGE_MODES.includes(value));
  if (deployedEdgeMode) return deployedEdgeMode;

  throw new Error(
    `Existing deployment "${deploymentName}" does not contain a recognized EDGE_MODE ` +
      "output or parameter. Refusing to deploy because the prior ingress topology cannot be verified.",
  );
}

// Collapse `akv-selfsigned` → `akv` (the two share a single overlay; the
// only delta is the AKV issuer name, owned by Portal bicep). Mirrors
// stage-manifests.mjs's resolveOverlayName().
function collapseTlsSource(tlsSource) {
  return tlsSource === "akv-selfsigned" ? "akv" : tlsSource;
}

// (edgeMode, tlsSource) → overlay directory key under
// deploy/providers/azure/gitops/portal/overlays/. Single source of truth.
export function resolveOverlayKey({ edgeMode, tlsSource }) {
  const em = (edgeMode || DEFAULT_EDGE_MODE).toLowerCase();
  const ts = collapseTlsSource((tlsSource || DEFAULT_TLS_SOURCE).toLowerCase());
  return `${em}-${ts}`;
}

// Shared roster: keys substituted into the portal overlay `.env` from
// bicep outputs (via deploy-bicep.mjs's OUTPUT_ALIAS) or seeded from the
// base template.env (the NAMESPACE / PILOTSWARM_USE_MANAGED_IDENTITY pair).
// Identical across all three overlays today; kept as a named constant so a
// future divergence is a single-line change per overlay.
const SHARED_BICEP_OUTPUT_KEYS = Object.freeze([
  "IMAGE",
  "NAMESPACE",
  "KV_NAME",
  "WORKLOAD_IDENTITY_CLIENT_ID",
  "AZURE_TENANT_ID",
  "PORTAL_HOSTNAME",
  "PILOTSWARM_USE_MANAGED_IDENTITY",
  "PILOTSWARM_BLOB_USE_MANAGED_IDENTITY",
  "SPC_KEYS_HASH",
  "AKS_VNET_ID",
  ...PORTAL_CONFIG_KEYS.map(({ env }) => env),
]);

// Shared composed-key roster (populated by compose-env.mjs from prior
// bicep outputs). Identical across all three overlays. On BYO deployments,
// databaseOverlayOmittedKeys removes URLs (projected by CSI instead); it also
// removes the AAD user when database managed identity is disabled.
const SHARED_COMPOSED_ENV_KEYS = Object.freeze([
  "AZURE_STORAGE_ACCOUNT_URL",
  "PILOTSWARM_CMS_FACTS_DATABASE_URL",
  "PILOTSWARM_DB_AAD_USER",
  "DATABASE_URL",
  "HORIZON_EMBED_URL",
  "HORIZON_EMBED_MODEL",
  "HORIZON_EMBED_DIM",
  "HORIZON_EMBED_API_KEY_HEADER",
]);

// Per-overlay contracts.
export const OVERLAY_CONTRACTS = Object.freeze({
  "afd-akv": Object.freeze({
    userRequiredEnvKeys: Object.freeze([
      "SSL_CERT_DOMAIN_SUFFIX",
    ]),
    composedEnvKeys: SHARED_COMPOSED_ENV_KEYS,
    stubKeys: Object.freeze([
      "PRIVATE_DNS_ZONE",
      "AKS_VNET_ID",
      "ACME_EMAIL",
    ]),
    bicepOutputKeys: SHARED_BICEP_OUTPUT_KEYS,
  }),
  "afd-letsencrypt": Object.freeze({
    userRequiredEnvKeys: Object.freeze([
      "ACME_EMAIL",
    ]),
    composedEnvKeys: SHARED_COMPOSED_ENV_KEYS,
    stubKeys: Object.freeze([
      "PRIVATE_DNS_ZONE",
      "AKS_VNET_ID",
      "SSL_CERT_DOMAIN_SUFFIX",
    ]),
    bicepOutputKeys: SHARED_BICEP_OUTPUT_KEYS,
  }),
  "private-akv": Object.freeze({
    userRequiredEnvKeys: Object.freeze([
      "HOST",
      "PRIVATE_DNS_ZONE",
    ]),
    composedEnvKeys: SHARED_COMPOSED_ENV_KEYS,
    stubKeys: Object.freeze([
      "FRONT_DOOR_PROFILE_NAME",
      "FRONT_DOOR_PROFILE_RESOURCE_GROUP",
      "FRONT_DOOR_ENDPOINT_NAME",
      "FRONT_DOOR_ID",
      "APPLICATION_GATEWAY_NAME",
      "PRIVATE_LINK_CONFIGURATION_NAME",
      "SSL_CERT_DOMAIN_SUFFIX",
      "ACME_EMAIL",
    ]),
    bicepOutputKeys: SHARED_BICEP_OUTPUT_KEYS,
  }),
  "port-forward-akv": Object.freeze({
    userRequiredEnvKeys: Object.freeze([]),
    composedEnvKeys: SHARED_COMPOSED_ENV_KEYS,
    stubKeys: Object.freeze([
      "HOST",
      "PRIVATE_DNS_ZONE",
      "FRONT_DOOR_PROFILE_NAME",
      "FRONT_DOOR_PROFILE_RESOURCE_GROUP",
      "FRONT_DOOR_ENDPOINT_NAME",
      "FRONT_DOOR_ID",
      "APPLICATION_GATEWAY_NAME",
      "PRIVATE_LINK_CONFIGURATION_NAME",
      "SSL_CERT_DOMAIN_SUFFIX",
      "ACME_EMAIL",
    ]),
    bicepOutputKeys: SHARED_BICEP_OUTPUT_KEYS,
  }),
  "public-letsencrypt": Object.freeze({
    userRequiredEnvKeys: Object.freeze([
      "ACME_EMAIL",
      "PORTAL_HOSTNAME",
      "PORTAL_AUTH_PROVIDER",
      "PORTAL_AUTH_ENTRA_TENANT_ID",
      "AZURE_TENANT_ID",
      "PORTAL_AUTH_ENTRA_CLIENT_ID",
      "PORTAL_AUTH_ALLOW_UNAUTHENTICATED",
      "PILOTSWARM_USE_MANAGED_IDENTITY",
    ]),
    composedEnvKeys: SHARED_COMPOSED_ENV_KEYS,
    stubKeys: Object.freeze([
      "PRIVATE_DNS_ZONE",
      "AKS_VNET_ID",
      "SSL_CERT_DOMAIN_SUFFIX",
      "FRONT_DOOR_PROFILE_NAME",
      "FRONT_DOOR_PROFILE_RESOURCE_GROUP",
      "FRONT_DOOR_ENDPOINT_NAME",
      "APPLICATION_GATEWAY_NAME",
      "PRIVATE_LINK_CONFIGURATION_NAME",
    ]),
    bicepOutputKeys: SHARED_BICEP_OUTPUT_KEYS,
  }),
});

// Return the contract for a given (edgeMode, tlsSource). Throws if the
// resolved overlay key is unknown — that's a hard bug, not user error.
export function getContract({ edgeMode, tlsSource }) {
  const key = resolveOverlayKey({ edgeMode, tlsSource });
  const c = OVERLAY_CONTRACTS[key];
  if (!c) {
    throw new Error(
      `overlay-contracts: no contract for resolved overlay '${key}' ` +
        `(EDGE_MODE='${edgeMode}' TLS_SOURCE='${tlsSource}'). ` +
        `Add an entry to OVERLAY_CONTRACTS in deploy/scripts/lib/overlay-contracts.mjs.`,
    );
  }
  return c;
}

// Human-readable rendering for configuration-combination error codes. Keeps
// the message and remediation hint adjacent to the code so deploy.mjs /
// new-env.mjs don't have to re-derive them.
const PORTAL_AUTH_COMBO_ERROR_DETAILS = Object.freeze({
  "public-portal-auth-provider-required": Object.freeze({
    message:
      "EDGE_MODE='afd' publishes the portal on the public internet, but " +
      "PORTAL_AUTH_PROVIDER is unset.",
    hint:
      "Set PORTAL_AUTH_PROVIDER=entra with PORTAL_AUTH_ENTRA_TENANT_ID and " +
      "PORTAL_AUTH_ENTRA_CLIENT_ID. For an intentionally open sandbox, set " +
      "PORTAL_AUTH_PROVIDER=none and PORTAL_AUTH_ALLOW_UNAUTHENTICATED=true explicitly.",
  }),
  "public-portal-entra-requires-config": Object.freeze({
    message:
      "PORTAL_AUTH_PROVIDER=entra requires both PORTAL_AUTH_ENTRA_TENANT_ID " +
      "and PORTAL_AUTH_ENTRA_CLIENT_ID.",
    hint:
      "Create or select the portal Entra app registration, add the AFD URL as " +
      "a SPA redirect URI, and set both IDs in the stamp env file.",
  }),
  "public-portal-auth-allows-anonymous": Object.freeze({
    message:
      "A public authenticated portal cannot set " +
      "PORTAL_AUTH_ALLOW_UNAUTHENTICATED=true.",
    hint:
      "Set PORTAL_AUTH_ALLOW_UNAUTHENTICATED=false. To deploy an intentionally " +
      "open sandbox, use PORTAL_AUTH_PROVIDER=none with the value true explicitly.",
  }),
  "public-portal-no-auth-not-explicit": Object.freeze({
    message:
      "PORTAL_AUTH_PROVIDER=none on a public AFD endpoint requires an explicit " +
      "acknowledgement because the runtime otherwise allows anonymous access by default.",
    hint:
      "Use Entra authentication for shared stamps. Only for an intentionally open " +
      "sandbox, set PORTAL_AUTH_ALLOW_UNAUTHENTICATED=true explicitly.",
  }),
});

function describePortalAuthComboError(code) {
  const detail = PORTAL_AUTH_COMBO_ERROR_DETAILS[code];
  if (!detail) {
    return {
      code,
      message: `Portal authentication combo error: ${code}.`,
      hint: "Check the portal authentication settings in the stamp env file.",
    };
  }
  return { code, message: detail.message, hint: detail.hint };
}

function normalizedPortalSetting(value) {
  const normalized = String(value ?? "").trim();
  return normalized === "__PS_UNSET__" ? "" : normalized;
}

export function validatePortalAuthCombo({ edgeMode, env }) {
  if (String(edgeMode ?? "").toLowerCase() !== "afd") return [];

  const provider = normalizedPortalSetting(env?.PORTAL_AUTH_PROVIDER).toLowerCase();
  const allowUnauthenticated =
    normalizedPortalSetting(env?.PORTAL_AUTH_ALLOW_UNAUTHENTICATED).toLowerCase();

  if (!provider) return ["public-portal-auth-provider-required"];
  if (provider === "none") {
    return allowUnauthenticated === "true"
      ? []
      : ["public-portal-no-auth-not-explicit"];
  }

  const errors = [];
  if (
    provider === "entra"
    && (
      !normalizedPortalSetting(env?.PORTAL_AUTH_ENTRA_TENANT_ID)
      || !normalizedPortalSetting(env?.PORTAL_AUTH_ENTRA_CLIENT_ID)
    )
  ) {
    errors.push("public-portal-entra-requires-config");
  }
  if (allowUnauthenticated === "true") {
    errors.push("public-portal-auth-allows-anonymous");
  }
  return errors;
}

// VPN hints never point at the scaffolder (re-running new-env.mjs would
// clobber operator edits); they point at the env file and the VPN docs.
const VPN_COMBO_ERROR_DETAILS = Object.freeze({
  "vpn-requires-afd": Object.freeze({
    message:
      "VPN gateway requires EDGE_MODE='afd' (the auto-seeded AppGw WAF guard at " +
      "priorities 90/91/92 only makes sense when AFD is the public ingress and " +
      "AppGw is the private front-end).",
    hint:
      "Set EDGE_MODE=afd in deploy/envs/local/<env>/.env, or disable the VPN " +
      "gateway by setting VPN_GATEWAY_ENABLED=false. See docs/developer/deploy/aks.md.",
  }),
  "vpn-requires-akv": Object.freeze({
    message:
      "VPN gateway requires TLS_SOURCE='akv' or 'akv-selfsigned' " +
      "(Let's Encrypt's HTTP-01 challenge cannot reach a VPN-only client).",
    hint:
      "Set TLS_SOURCE=akv (or akv-selfsigned) in deploy/envs/local/<env>/.env, " +
      "or disable the VPN gateway by setting VPN_GATEWAY_ENABLED=false. " +
      "See docs/developer/deploy/aks.md.",
  }),
  "vpn-requires-domain-suffix": Object.freeze({
    message:
      "VPN gateway requires SSL_CERT_DOMAIN_SUFFIX to be set (the managed " +
      "Private DNS zone is named from this suffix).",
    hint:
      "Set SSL_CERT_DOMAIN_SUFFIX in deploy/envs/local/<env>/.env. " +
      "See docs/developer/deploy/aks.md.",
  }),
  "vpn-pool-overlap": Object.freeze({
    message:
      "VPN_CLIENT_ADDRESS_POOL overlaps the stamp VNet CIDR (or is malformed). " +
      "The client pool MUST be disjoint from the VNet address space — overlap " +
      "would black-hole intra-stamp traffic from connected VPN clients.",
    hint:
      "Pick a non-overlapping IPv4 CIDR for VPN_CLIENT_ADDRESS_POOL in " +
      "deploy/envs/local/<env>/.env (the default stamp VNet is 10.20.0.0/16; " +
      "set VNET_CIDR if you've customised it). See docs/developer/deploy/aks.md.",
  }),
  "vpn-requires-tenant-id": Object.freeze({
    message:
      "VPN gateway requires AZURE_TENANT_ID to be set (the P2S Entra ID " +
      "authentication flow needs the tenant GUID; an empty value would fall " +
      "through to bicep's empty default and produce a confusing late failure).",
    hint:
      "Set AZURE_TENANT_ID in deploy/envs/local/<env>/.env (it ships populated " +
      "in template.env — restore it if it was blanked). See docs/developer/deploy/aks.md.",
  }),
});

// Build a rich combo-error object from a code returned by
// validateVpnGatewayCombo(). Unknown codes get a generic message so a
// future combo-error addition isn't silently rendered as "[object Object]".
function describeVpnComboError(code) {
  const detail = VPN_COMBO_ERROR_DETAILS[code];
  if (!detail) {
    return {
      code,
      message: `VPN gateway combo error: ${code}.`,
      hint: "See docs/developer/deploy/aks.md.",
    };
  }
  return { code, message: detail.message, hint: detail.hint };
}

// Pre-deploy validator. Returns `{ missing, combo }`:
//   missing — array of userRequiredEnvKey names that are unset/blank (and
//             ACME_EMAIL when malformed on letsencrypt). These render as
//             "requires <keys> to be set" with a scaffolder hint.
//   combo   — array of `{ code, message, hint }` objects describing invalid
//             cross-setting combinations.
// Callers decide whether to throw or log — deploy.mjs throws via
// process.exit(1); new-env.mjs warn-and-continues at scaffold time.
export function validateRequiredEnv({
  edgeMode,
  tlsSource,
  env,
  enforcePortalAuth = true,
}) {
  const contract = getContract({ edgeMode, tlsSource });
  const missing = [];
  for (const k of contract.userRequiredEnvKeys) {
    const v = env[k];
    if (v === undefined || v === null || String(v).trim() === "" || String(v).trim() === "__PS_UNSET__") {
      missing.push(k);
    }
  }
  if (edgeMode === "public") {
    const requiredValues = {
      PORTAL_AUTH_PROVIDER: "entra",
      PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "false",
      PILOTSWARM_USE_MANAGED_IDENTITY: String(env.HORIZONDB_ENABLED).toLowerCase() === "true" ? "0" : "1",
    };
    for (const [key, expected] of Object.entries(requiredValues)) {
      if (String(env[key] ?? "").toLowerCase() !== expected && !missing.includes(key)) missing.push(key);
    }
    for (const key of ["AZURE_TENANT_ID", "PORTAL_AUTH_ENTRA_TENANT_ID", "PORTAL_AUTH_ENTRA_CLIENT_ID"]) {
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(env[key] ?? "")) && !missing.includes(key)) missing.push(key);
    }
  }
  // ACME_EMAIL gets a stricter shape check on letsencrypt — preserves
  // the prior deploy.mjs behaviour. We do it here so the contract is the
  // sole owner of "what counts as valid for this overlay".
  if (tlsSource === "letsencrypt") {
    const ace = env.ACME_EMAIL;
    if (ace && String(ace).trim() !== "" && !String(ace).includes("@")) {
      missing.push("ACME_EMAIL"); // present but malformed → treat as missing
    }
  }
  const portalAuthCodes = enforcePortalAuth
    ? validatePortalAuthCombo({ edgeMode, env })
    : [];
  const vpnCodes = validateVpnGatewayCombo({ edgeMode, tlsSource, env });
  const combo = [
    ...portalAuthCodes.map(describePortalAuthComboError),
    ...vpnCodes.map(describeVpnComboError),
  ];
  return { missing, combo };
}

// ===========================================================================
// VPN gateway combo validator.
//
// Gated on `env.VPN_GATEWAY_ENABLED === 'true'`. Returns an array of error
// codes (empty = OK). Codes:
//   vpn-requires-afd            — EDGE_MODE must be 'afd' (the auto-seeded
//                                 AppGw WAF guard at priorities 90/91/92
//                                 only makes sense when AFD is the public
//                                 ingress and AppGw is private-FE).
//   vpn-requires-akv            — TLS_SOURCE must be 'akv' or
//                                 'akv-selfsigned'; Let's Encrypt is
//                                 unsupported on the VPN path (HTTP-01
//                                 cannot reach a VPN-only client).
//   vpn-requires-domain-suffix  — SSL_CERT_DOMAIN_SUFFIX must be non-empty
//                                 (managed Private DNS zone uses it).
//   vpn-pool-overlap            — VPN_CLIENT_ADDRESS_POOL overlaps the
//                                 stamp VNet CIDR. Reads VNET_CIDR from
//                                 env when present, defaults to
//                                 '10.20.0.0/16' (matches vnet.bicep's
//                                 default base address space).
//   vpn-requires-tenant-id      — AZURE_TENANT_ID must be set (non-empty)
//                                 when the VPN gateway is enabled.
//                                 Closes the gap behind the bicep
//                                 `tenantId=''` default — even though
//                                 template.env ships a populated value,
//                                 an operator who blanks it gets a clear
//                                 pre-deploy error instead of a confusing
//                                 bicep failure.
//
// Returns an empty array when VPN_GATEWAY_ENABLED is anything other than
// the literal string 'true' (handles the unset / 'false' / 'FALSE' /
// boolean-false cases).
// ===========================================================================
export function validateVpnGatewayCombo({ edgeMode, tlsSource, env }) {
  const enabled = String(env?.VPN_GATEWAY_ENABLED ?? "").toLowerCase() === "true";
  if (!enabled) return [];

  const errors = [];

  const em = String(edgeMode ?? "").toLowerCase();
  if (em !== "afd") errors.push("vpn-requires-afd");

  // Accept both `akv` and `akv-selfsigned` (they collapse to the same
  // overlay anyway; the only delta is the AKV issuer). The forbidden value
  // is `letsencrypt`.
  const ts = String(tlsSource ?? "").toLowerCase();
  if (ts !== "akv" && ts !== "akv-selfsigned") errors.push("vpn-requires-akv");

  const suffix = env?.SSL_CERT_DOMAIN_SUFFIX;
  if (suffix === undefined || suffix === null || String(suffix).trim() === "") {
    errors.push("vpn-requires-domain-suffix");
  }

  const pool = env?.VPN_CLIENT_ADDRESS_POOL;
  // VNET_CIDR is forward-compatible — not in template.env today; default
  // mirrors vnet.bicep's `10.20.0.0/16` baseline.
  const vnetCidr = env?.VNET_CIDR && String(env.VNET_CIDR).trim() !== ""
    ? String(env.VNET_CIDR).trim()
    : "10.20.0.0/16";
  if (pool && String(pool).trim() !== "") {
    try {
      if (cidrsOverlap(String(pool).trim(), vnetCidr)) {
        errors.push("vpn-pool-overlap");
      }
    } catch {
      // Malformed CIDR → also a pool problem.
      errors.push("vpn-pool-overlap");
    }
  }

  // AZURE_TENANT_ID must be present when VPN is enabled. The bicep side
  // declares `param tenantId string = ''` so a blanked value would silently
  // flow through and surface as a confusing late error in the gateway
  // module — fail-closed here instead.
  const tenantId = env?.AZURE_TENANT_ID;
  if (tenantId === undefined || tenantId === null || String(tenantId).trim() === "") {
    errors.push("vpn-requires-tenant-id");
  }

  return errors;
}

// IPv4 CIDR overlap helper. Returns true when the two prefixes share any
// address. Pure-JS, no dependencies; only handles IPv4 (the VPN gateway
// supports IPv6 client pools too, but the stamp VNet is IPv4-only — when
// IPv6 support arrives we extend here and add tests).
function cidrsOverlap(a, b) {
  const [na, ma] = parseCidr(a);
  const [nb, mb] = parseCidr(b);
  // Two prefixes overlap iff one contains the other. Apply the SHORTER
  // (less specific) mask to both networks — if they match, the longer
  // prefix's network is contained in the shorter prefix.
  const mask = ma < mb ? ma : mb;
  return networkOf(na, mask) === networkOf(nb, mask);
}

function parseCidr(cidr) {
  const m = /^([0-9]{1,3}(?:\.[0-9]{1,3}){3})\/([0-9]{1,2})$/.exec(cidr);
  if (!m) throw new Error(`invalid IPv4 CIDR: ${cidr}`);
  const ip = m[1].split(".").map((o) => {
    const n = Number(o);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error(`invalid IPv4 octet in ${cidr}`);
    }
    return n;
  });
  const mask = Number(m[2]);
  if (!Number.isInteger(mask) || mask < 0 || mask > 32) {
    throw new Error(`invalid IPv4 prefix length in ${cidr}`);
  }
  // Use unsigned right shift to keep the result in [0, 2^32-1].
  const num = ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;
  return [num, mask];
}

function networkOf(ipNum, prefix) {
  if (prefix === 0) return 0;
  // 32-bit left-aligned mask; >>> 0 to coerce back to unsigned.
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNum & mask) >>> 0;
}

// Off-path stub-fill. Mutates `env` in place, setting any stubKey that
// is currently blank to the `unused` sentinel. Driven by the contract so
// adding a new off-path key is a one-line change in this file.
export function applyStubKeys({ edgeMode, tlsSource, env }) {
  const contract = getContract({ edgeMode, tlsSource });
  const STUB = "unused";
  const stubbed = [];
  for (const k of contract.stubKeys) {
    if (!env[k] || String(env[k]).trim() === "") {
      env[k] = STUB;
      stubbed.push(k);
    }
  }
  return stubbed;
}
