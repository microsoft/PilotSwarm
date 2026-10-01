import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  randomUUID,
} from "node:crypto";
import { run, runJson, log } from "./common.mjs";

export function localhostCertificatePolicy(defaultPolicy) {
  const policy = structuredClone(defaultPolicy);
  policy.issuerParameters = {
    ...(policy.issuerParameters ?? {}),
    name: "Self",
  };
  policy.secretProperties = {
    ...(policy.secretProperties ?? {}),
    contentType: "application/x-pem-file",
  };
  policy.x509CertificateProperties = {
    ...(policy.x509CertificateProperties ?? {}),
    subject: "CN=localhost",
    subjectAlternativeNames: {
      ...(policy.x509CertificateProperties?.subjectAlternativeNames ?? {}),
      dnsNames: ["localhost"],
    },
    validityInMonths: 12,
  };
  return policy;
}

export function isPemCertificateContentType(contentType) {
  return String(contentType ?? "").trim().toLowerCase() === "application/x-pem-file";
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

export function validateExistingCertificate(certificate, now = new Date()) {
  if (!certificate || certificate.attributes?.enabled === false) {
    return "certificate is disabled";
  }
  if (!isPemCertificateContentType(certificate.policy?.secretProperties?.contentType)) {
    return "certificate secret content type is not application/x-pem-file";
  }
  const dnsNames =
    certificate.policy?.x509CertificateProperties?.subjectAlternativeNames?.dnsNames ?? [];
  if (!dnsNames.some((name) => String(name).toLowerCase() === "localhost")) {
    return "certificate does not contain a localhost DNS subject alternative name";
  }
  const notBefore = parseDate(certificate.attributes?.notBefore);
  const expires = parseDate(certificate.attributes?.expires);
  if (notBefore && now < notBefore) return "certificate is not valid yet";
  if (!expires || now >= expires) return "certificate is expired or has no valid expiry";
  return null;
}

export function ensurePortForwardCertificate(
  env,
  { runCommand = run, runJsonCommand = runJson } = {},
) {
  if (env.EDGE_MODE !== "port-forward") return;
  if (env.TLS_SOURCE !== "akv-selfsigned") {
    throw new Error("EDGE_MODE=port-forward requires TLS_SOURCE=akv-selfsigned.");
  }

  const vaultName = env.KV_NAME;
  const certificateName = env.PORTAL_TLS_CERT_NAME;
  if (!vaultName || !certificateName) {
    throw new Error(
      "Port-forward certificate preparation requires KV_NAME and PORTAL_TLS_CERT_NAME from Bicep outputs.",
    );
  }

  const existing = runCommand(
    "az",
    [
      "keyvault",
      "certificate",
      "show",
      "--vault-name",
      vaultName,
      "--name",
      certificateName,
      "--output",
      "json",
    ],
    { capture: true, allowFail: true },
  );
  if (existing.status === 0) {
    const validationError = validateExistingCertificate(JSON.parse(existing.stdout));
    if (validationError) {
      throw new Error(
        `Key Vault certificate '${certificateName}' is incompatible with port-forward mode: ` +
          `${validationError}. Use a fresh stamp or replace the certificate.`,
      );
    }
    log("info", `Key Vault certificate '${certificateName}' already exists; reusing it.`);
    return;
  }

  // A secret created directly with this name blocks certificate creation but
  // is not compatible with the CSI driver's kubernetes.io/tls synthesis. The
  // driver expects the certificate object's backing secret format.
  const existingSecret = runCommand(
    "az",
    [
      "keyvault",
      "secret",
      "show",
      "--vault-name",
      vaultName,
      "--name",
      certificateName,
      "--output",
      "none",
    ],
    { capture: true, allowFail: true },
  );
  if (existingSecret.status === 0) {
    throw new Error(
      `Key Vault secret '${certificateName}' exists without a certificate object and cannot be ` +
        "used for Kubernetes TLS synthesis. Use a fresh PORTAL_TLS_CERT_NAME; purge-protected " +
        "vaults cannot reuse the conflicting name until retention expires.",
    );
  }

  const defaultPolicy = runJsonCommand("az", [
    "keyvault",
    "certificate",
    "get-default-policy",
    "--output",
    "json",
  ]);
  const policyPath = join(tmpdir(), `pilotswarm-localhost-cert-${randomUUID()}.json`);
  try {
    writeFileSync(policyPath, `${JSON.stringify(localhostCertificatePolicy(defaultPolicy), null, 2)}\n`, "utf8");
    log("info", `Creating localhost TLS certificate '${certificateName}' in Key Vault '${vaultName}'...`);
    runCommand("az", [
      "keyvault",
      "certificate",
      "create",
      "--vault-name",
      vaultName,
      "--name",
      certificateName,
      "--policy",
      `@${policyPath}`,
      "--output",
      "none",
    ]);
  } finally {
    rmSync(policyPath, { force: true });
  }
  log("ok", `Created localhost TLS certificate '${certificateName}'.`);
}
