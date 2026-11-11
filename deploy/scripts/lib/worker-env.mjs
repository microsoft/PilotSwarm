// Worker runtime settings from the env map that older env files may lack.
//
//   PILOTSWARM_NATIVE_SUBAGENTS   sync (default). Native Copilot tasks are always
//                                 on: workers offer them, so sessions can hand
//                                 local work to native sub-agents, including
//                                 agents adopted from a session workspace's
//                                 repo. The `copilot.native_tasks` feature flag
//                                 is always on too. An older env file's "off"
//                                 is accepted and deployed as sync (the worker
//                                 would ignore it with a warning).
//
// No I/O; no import of common.mjs (it imports this).

export const WORKER_ENV_DEFAULTS = Object.freeze({
  PILOTSWARM_NATIVE_SUBAGENTS: "sync",
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
  OTEL_SDK_DISABLED: "false",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_TRACES_EXPORTER: "none",
  OTEL_LOGS_EXPORTER: "none",
  OTEL_SERVICE_NAME: "pilotswarm-worker",
  OTEL_RESOURCE_ATTRIBUTES: "",
  OTEL_METRIC_EXPORT_INTERVAL: "30000",
  OTEL_METRIC_EXPORT_TIMEOUT: "5000",
  OTEL_EXPORTER_OTLP_TIMEOUT: "5000",
  PILOTSWARM_OTEL_HISTOGRAMS: "false",
});

export function workerTelemetryOmittedKeys(env) {
  const endpoint = String(env?.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim();
  if (!endpoint) {
    return Object.keys(WORKER_ENV_DEFAULTS)
      .filter(key => key.startsWith("OTEL_") || key.startsWith("PILOTSWARM_OTEL_"));
  }
  return ["OTEL_RESOURCE_ATTRIBUTES"].filter(key => !env[key]);
}

export function nativeSubagentsSetting(env) {
  const raw = env?.PILOTSWARM_NATIVE_SUBAGENTS;
  const value = String(raw ?? "").trim().toLowerCase();
  // Always on: unset, off and sync all deploy sync. Other values still fail.
  if (value === "" || value === "off" || value === "sync") return "sync";
  throw new Error(`PILOTSWARM_NATIVE_SUBAGENTS must be off or sync, not '${raw}'.`);
}
