// AKS settings from the env map, for base-infra's parameters.
//
//   USER_POOL_MIN_COUNT   the user pool's autoscaler minimum, 1 to 10
//                         (default 1). The session-workspaces tests need two
//                         agent nodes (docs/proposals/session-workspaces.md,
//                         section 12.1).
//
//   AKS_ENTRA_ID_AUTH     true: callers sign in to the cluster API with
//                         Microsoft Entra ID, and Azure role assignments
//                         decide what they may do. kubectl and flux then
//                         need kubelogin. AKS cannot turn it off again on a
//                         cluster. Older env files without the key keep the
//                         cluster as it is (false).
//
// The `repocache` pool follows WORKSPACES_ENABLED (lib/workspaces.mjs).
//
// No I/O; no import of common.mjs (it imports this).

export const AKS_ENV_DEFAULTS = Object.freeze({ USER_POOL_MIN_COUNT: "1", AKS_ENTRA_ID_AUTH: "false" });

export function aksEntraIdAuth(env) {
  const raw = env?.AKS_ENTRA_ID_AUTH;
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false" || value === "") return false;
  throw new Error(`AKS_ENTRA_ID_AUTH must be true or false, not '${raw}'.`);
}

export function userPoolMinCount(env) {
  const raw = env?.USER_POOL_MIN_COUNT;
  const value = String(raw ?? "").trim();
  if (value === "") return 1;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 10) {
    throw new Error(`USER_POOL_MIN_COUNT must be a whole number from 1 to 10, not '${raw}'.`);
  }
  return Number(value);
}
