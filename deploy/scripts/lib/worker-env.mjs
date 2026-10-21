// Worker runtime settings from the env map that older env files may lack.
//
//   PILOTSWARM_NATIVE_SUBAGENTS   off (default) or sync. With sync, workers
//                                 offer native Copilot tasks: sessions can hand
//                                 local work to native sub-agents, including
//                                 agents adopted from a session workspace's
//                                 repo. The `copilot.native_tasks` feature flag
//                                 (Admin Console, Features) must be on as well.
//   PILOTSWARM_CANVAS_LEGACY_MODE on (default) or off. The canvas app
//                                 transition (issue 181): on keeps the old
//                                 apps/<name> canvas app catalog working next
//                                 to the registry. Workers and the portal read
//                                 the same value; both ConfigMaps carry it.
//
// No I/O; no import of common.mjs (it imports this).

export const WORKER_ENV_DEFAULTS = Object.freeze({ PILOTSWARM_NATIVE_SUBAGENTS: "off", PILOTSWARM_CANVAS_LEGACY_MODE: "on" });

export function nativeSubagentsSetting(env) {
  const raw = env?.PILOTSWARM_NATIVE_SUBAGENTS;
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return "off";
  if (value === "sync") return "sync";
  throw new Error(`PILOTSWARM_NATIVE_SUBAGENTS must be off or sync, not '${raw}'.`);
}

export function canvasLegacyModeSetting(env) {
  const raw = env?.PILOTSWARM_CANVAS_LEGACY_MODE;
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "" || value === "on") return "on";
  if (value === "off") return "off";
  throw new Error(`PILOTSWARM_CANVAS_LEGACY_MODE must be on or off, not '${raw}'.`);
}
