// Worker runtime settings from the env map that older env files may lack.
//
//   PILOTSWARM_NATIVE_SUBAGENTS   off (default) or sync. With sync, workers
//                                 offer native Copilot tasks: sessions can hand
//                                 local work to native sub-agents, including
//                                 agents adopted from a session workspace's
//                                 repo. The `copilot.native_tasks` feature flag
//                                 (Admin Console, Features) must be on as well.
//
// No I/O; no import of common.mjs (it imports this).

export const WORKER_ENV_DEFAULTS = Object.freeze({
  PILOTSWARM_NATIVE_SUBAGENTS: "off",
  DEFAULT_MCP_JSON: "",
  MCP_WORKLOAD_IDENTITY_SCOPES: "",
});

export function nativeSubagentsSetting(env) {
  const raw = env?.PILOTSWARM_NATIVE_SUBAGENTS;
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return "off";
  if (value === "sync") return "sync";
  throw new Error(`PILOTSWARM_NATIVE_SUBAGENTS must be off or sync, not '${raw}'.`);
}
