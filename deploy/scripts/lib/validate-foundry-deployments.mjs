// Foundry deployments validator.
//
// Catches the most common base-infra deploy failure ("DeploymentModelNotSupported")
// before invoking `az deployment group create`, by cross-checking each entry
// in `deploy/envs/local/<env>/foundry-deployments.json` against the live output
// of `az cognitiveservices model list --location <region>`.
//
// Error messages list the actual available versions for the requested model
// so the operator can fix their JSON in one edit.
//
// Pure validation logic (validateFoundryDeployments) is split from the az shell
// out (listAvailableFoundryModels) so unit tests can pass mock `az` output
// without spawning the CLI.

import { runJson } from "./common.mjs";

// Normalize a model triple to a comparison key.
function tupleKey(format, name, version) {
  return `${format ?? ""}::${name ?? ""}::${version ?? ""}`;
}

// Pure validation. Returns an array of human-readable error strings (empty
// array = valid).
//
// `availableModels` is the parsed `az cognitiveservices model list` array.
// Each item is expected to have a `.model.{format,name,version}` shape.
export function validateFoundryDeployments({ deployments, availableModels, region }) {
  if (!Array.isArray(deployments)) {
    return [`foundry-deployments.json must contain a JSON array (got ${typeof deployments})`];
  }
  if (!Array.isArray(availableModels)) {
    return [`available models response must be an array (got ${typeof availableModels})`];
  }

  const offered = new Set();
  for (const m of availableModels) {
    const mdl = m && m.model;
    if (mdl && mdl.format && mdl.name && mdl.version) {
      offered.add(tupleKey(mdl.format, mdl.name, mdl.version));
    }
  }

  const errors = [];
  for (let i = 0; i < deployments.length; i++) {
    const d = deployments[i] || {};
    const m = d.model || {};
    if (!m.format || !m.name || !m.version) {
      errors.push(
        `[${i}] ${d.name || "(unnamed)"} is missing model.format / model.name / model.version`,
      );
      continue;
    }
    const key = tupleKey(m.format, m.name, m.version);
    if (offered.has(key)) continue;

    // Suggest alternatives: same format+name, what versions ARE offered?
    const altVersions = [
      ...new Set(
        availableModels
          .map((am) => am && am.model)
          .filter((mdl) => mdl && mdl.format === m.format && mdl.name === m.name)
          .map((mdl) => mdl.version),
      ),
    ].sort();

    const hint = altVersions.length
      ? `Available version(s) for ${m.format}/${m.name} in ${region}: ${altVersions.join(", ")}`
      : `Model ${m.format}/${m.name} is not offered in ${region}. ` +
        `Run \`az cognitiveservices model list --location ${region}\` to see what is.`;

    errors.push(
      `[${i}] ${d.name || "(unnamed)"} -> ${m.format}/${m.name}@${m.version} ` +
        `not available in ${region}. ${hint}`,
    );
  }
  return errors;
}

// Keep only the fields the callers read: model.format, model.name and
// model.version (this validator and the new-env scaffolder). The full
// regional list can be larger than 1 MiB; this query makes it about 20 times
// smaller. The spaces make run() quote the value for cmd.exe on Windows.
export const FOUNDRY_MODEL_LIST_QUERY =
  "[].{model: {format: model.format, name: model.name, version: model.version}}";

// Arguments for `az cognitiveservices model list`. Exported for tests.
export function foundryModelListArgs(region, subscriptionId) {
  return [
    "cognitiveservices",
    "model",
    "list",
    "--location",
    region,
    ...(subscriptionId ? ["--subscription", subscriptionId] : []),
    "--query",
    FOUNDRY_MODEL_LIST_QUERY,
    "-o",
    "json",
  ];
}

// Live `az cognitiveservices model list` shell-out. Separated from the pure
// validator so tests can mock `availableModels` without spawning az.
export function listAvailableFoundryModels(region, subscriptionId) {
  return runJson("az", foundryModelListArgs(region, subscriptionId));
}

// One-shot helper used by the bicep stage. Throws with a single consolidated
// message on the first invalid deployment so the operator sees every problem
// in one go.
export function assertFoundryDeploymentsValid({ deployments, region, subscriptionId, listFn = listAvailableFoundryModels }) {
  const availableModels = listFn(region, subscriptionId);
  const errors = validateFoundryDeployments({ deployments, availableModels, region });
  if (errors.length === 0) return;
  throw new Error(
    `Foundry deployments validation failed for region ${region}:\n` +
      errors.map((e) => `  - ${e}`).join("\n") +
      `\n\nEdit deploy/envs/local/<env>/foundry-deployments.json to use valid model+version ` +
      `combos for ${region}, or set FOUNDRY_ENABLED=false to skip Foundry provisioning.`,
  );
}
