// AKS node-pool settings from the env map, for base-infra's parameters.
//
//   USER_POOL_MIN_COUNT   the user pool's autoscaler minimum, 1 to 10
//                         (default 1). The session-workspaces tests need two
//                         agent nodes (docs/proposals/session-workspaces.md,
//                         section 12.1).
//
// The `repocache` pool follows WORKSPACES_ENABLED (lib/workspaces.mjs).
//
// No I/O; no import of common.mjs (it imports this).

export const AKS_ENV_DEFAULTS = Object.freeze({ USER_POOL_MIN_COUNT: "1" });

export function userPoolMinCount(env) {
  const raw = env?.USER_POOL_MIN_COUNT;
  const value = String(raw ?? "").trim();
  if (value === "") return 1;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 10) {
    throw new Error(`USER_POOL_MIN_COUNT must be a whole number from 1 to 10, not '${raw}'.`);
  }
  return Number(value);
}
