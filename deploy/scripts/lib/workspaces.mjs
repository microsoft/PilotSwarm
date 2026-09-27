// The session-workspaces switch (docs/proposals/session-workspaces.md,
// section 12.1).
//
// WORKSPACES_ENABLED=true turns on the reference deployment:
//
//   1. deploy.mjs deploys the repo-cache service (the repo pod). With the
//      switch off it skips that service, in `all` mode and on its own.
//   2. stage-manifests adds `- ../../components/workspaces` to the staged
//      worker and portal overlays (the attacher DaemonSet, the worker's /ws
//      mount and sample settings, the portal's plugin folder).
//
// Both read workspacesEnabled(), so they cannot disagree. The Flux paths stay
// `overlays/default` and the portal combo overlays: the component goes into
// the staged copy only, the way database-secrets.mjs adds its component.
//
// No I/O beyond the staged tree; no import of common.mjs (it imports this).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WORKSPACES_ENV_DEFAULTS = Object.freeze({ WORKSPACES_ENABLED: "false" });

// The services whose staged overlay gets the component.
export const WORKSPACES_COMPONENT_SERVICES = Object.freeze(["worker", "portal"]);

// The service that exists only for workspaces.
export const WORKSPACES_SERVICE = "repo-cache";

export function workspacesEnabled(env) {
  const raw = env?.WORKSPACES_ENABLED;
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false" || value === "") return false;
  throw new Error(`WORKSPACES_ENABLED must be true or false, not '${raw}'.`);
}

// Adds the workspaces component to the staged overlay of `service` when the
// switch is on. Returns whether it did. The overlay must have exactly one
// `components:` list; the new entry goes first.
export function stageWorkspacesComponent({ service, env, stagedServiceRoot, overlayName }) {
  if (!WORKSPACES_COMPONENT_SERVICES.includes(service) || !workspacesEnabled(env)) return false;
  const component = join(stagedServiceRoot, "components", "workspaces", "kustomization.yaml");
  if (!existsSync(component)) {
    throw new Error(`WORKSPACES_ENABLED=true, but ${service} has no workspaces component at ${component}.`);
  }
  const overlayPath = join(stagedServiceRoot, "overlays", overlayName, "kustomization.yaml");
  const overlay = readFileSync(overlayPath, "utf8");
  const marker = /^components:[ \t]*$/gm;
  if ((overlay.match(marker) ?? []).length !== 1) {
    throw new Error(`Expected exactly one components list in ${overlayPath}.`);
  }
  writeFileSync(overlayPath, overlay.replace(marker, "components:\n  - ../../components/workspaces"));
  return true;
}
