# Worker OpenTelemetry metrics

Worker telemetry is opt-in. With no `OTEL_EXPORTER_OTLP_ENDPOINT`, or with
`OTEL_SDK_DISABLED=true`, the bootstrap registers no providers and the worker
continues normally. A configured endpoint enables **metrics only** by default.
No Node HTTP, database, model-client, or other automatic library instrumentation
is enabled. The portal does not preload worker telemetry.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Unset | OTLP HTTP base URL; `/v1/metrics` is appended. HTTP or HTTPS only. No user info, query, or fragment. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Unset | Optional comma-separated `name=value` headers; values can be percent-encoded. Inject authentication using a Secret. |
| `OTEL_SDK_DISABLED` | `false` | `true` disables all providers before other telemetry settings are evaluated. |
| `OTEL_METRICS_EXPORTER` | `otlp` | `otlp` or `none`. Requires a configured endpoint. |
| `OTEL_TRACES_EXPORTER` | `none` | `otlp` or `none`. Trace export requires explicit opt-in. |
| `OTEL_LOGS_EXPORTER` | `none` | Only `none` is supported. There is no logs exporter. |
| `OTEL_SERVICE_NAME` | `pilotswarm-worker` | Worker service resource name. |
| `OTEL_RESOURCE_ATTRIBUTES` | Unset | Standard resource attributes. Use only approved non-sensitive values. |
| `POD_NAME` | Unset | Default `service.instance.id`; an explicit resource attribute takes precedence. |
| `OTEL_METRIC_EXPORT_INTERVAL` | `30000` | Positive integer milliseconds, at most `2147483647`. |
| `OTEL_METRIC_EXPORT_TIMEOUT` | `5000` | Collection/export budget in milliseconds; must not exceed the interval. |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | `5000` | Bounded HTTP export timeout in milliseconds. |
| `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` | SDK default | Standard OTLP Sum temporality preference. Use `cumulative` or `delta` only when the receiver supports it. |
| `PILOTSWARM_OTEL_HISTOGRAMS` | `false` | `true` or `false`. Enables only PilotSwarm's two duration histograms when explicitly requested; it does not disable third-party instrumentation in the process. |

This bootstrap uses a shared OTLP HTTP base URL and headers for the selected
signals. Signal-specific endpoints/headers, OTLP gRPC, and automatic instrumentation
configuration are not supported here.

When an endpoint is configured, unknown signal values, invalid URLs, invalid
headers, invalid intervals, or invalid histogram settings fail worker startup.
Diagnostics do not print endpoints, header values, or exporter error payloads.
Export failures are reported with a generic diagnostic; OTLP is not a durable
queue. A collector outage can lose telemetry, without making a turn fail.
Graceful shutdown drains the worker first, then awaits exporter shutdown and
its final metric export before exit. All enabled providers settle before a
failure is reported. Signal handlers log a sanitized shutdown failure and exit
with status 1 instead of leaving an unhandled rejection. A hard kill can lose
buffered metrics.

**Trace privacy:** `OTEL_TRACES_EXPORTER=otlp` exports existing manual SDK spans.
Those spans can contain session identifiers, model names, tool names, and
exception details. Do not enable traces as part of a metrics-only rollout.
Review their data handling separately. No trace or logs provider is installed
in the default metrics-only mode.

## Metrics catalog

Metric labels are closed sets, not user or agent input. Resource attributes
are operator-controlled and can still disclose sensitive data; inspect them
before deployment.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `pilotswarm.turns` | Counter | `result=completed,error,cancelled,stopped,yielded` | Finished activity attempts, including errors and retries. Actions such as wait or input requests are yields, not failures. |
| `pilotswarm.tokens` | Counter | `direction=input,output,cache_read,cache_write` | Usage increments observed during a turn, added once when the attempt finishes. Partial usage from a failed/cancelled attempt is included. |
| `pilotswarm.tool.calls` | Counter | `result=success,error` | Observed tool completions. An unfinished tool start is not falsely counted as success. |
| `pilotswarm.lifecycle.operations` | Counter | `operation=hydration,dehydration`; `result=completed,error,lossy_handoff,checkpoint_fallback,superseded,cancelled` | Legacy hydrate/dehydrate activities and actual modern snapshot restore/commit operations, including lossy recreation. |
| `pilotswarm.turn.duration` | Histogram, seconds | Same `result` as turns | Monotonic wall duration of the activity attempt, including lock wait, tools, persistence and other runtime work. Explicit opt-in only. |
| `pilotswarm.lifecycle.duration` | Histogram, seconds | Same lifecycle labels | Monotonic wall duration of the instrumented lifecycle operation. Explicit opt-in only. |

Input tokens include cached tokens. Do **not** add cache_read/cache_write to
input when computing total tokens; total is input + output. CMS persistence
retries do not add token increments again. Actual model re-execution after
recovery can consume more tokens and is counted.

Already-committed recovery can finish an activity without a model call: it
adds a turn-attempt count and a snapshot hydration count, but no new token
usage. A warm preamble adds no hydration count. Snapshot commit retries are
one logical dehydration operation. A stopped turn does not attempt a snapshot
commit and adds no dehydration operation. A superseded snapshot commit is
not a successful dehydration. The counters are process observations, not
exactly-once durable business totals across crashes or duplicate deliveries.
Legacy pre-destroy checkpoint fallback is distinct from a successful
post-disconnect snapshot and is reported as `checkpoint_fallback`.

There are no session IDs, owner emails, arbitrary agent names, model labels,
tool names, arguments, outputs, or error strings in metric labels. Turn duration
is **not** model inference latency. Existing CMS summaries remain the source
for exact per-session analysis.

## Build and deploy

Build the existing worker image from the intended commit:

```bash
docker build -f deploy/Dockerfile.worker -t pilotswarm-worker:metrics .
```

The SDK package owns the telemetry bootstrap and its production dependencies.
The worker image preloads `pilotswarm-sdk/telemetry`. The starter image and
`deploy/bin/start-worker.sh` use the same bootstrap; portal startup does not.

Example worker environment (replace the illustrative collector address with
your existing OTLP HTTP receiver):

```dotenv
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.example:4318
OTEL_METRICS_EXPORTER=otlp
OTEL_TRACES_EXPORTER=none
OTEL_LOGS_EXPORTER=none
OTEL_SERVICE_NAME=pilotswarm-worker
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=example
OTEL_METRIC_EXPORT_INTERVAL=30000
OTEL_METRIC_EXPORT_TIMEOUT=5000
OTEL_EXPORTER_OTLP_TIMEOUT=5000
PILOTSWARM_OTEL_HISTOGRAMS=false
```

For the existing deployment generator, put non-secret settings in the local
deployment `.env` map. The worker overlay stages them into `worker-env`, already
referenced by the Deployment's `envFrom`. An empty endpoint/resource attribute
is omitted rather than left as a placeholder. Do not add authentication
headers to a ConfigMap, repository, image, or deployment artifact. Add them
through an operator-managed Secret, for example a worker-only patch:

```yaml
spec:
  template:
    spec:
      containers:
        - name: worker
          env:
            - name: OTEL_EXPORTER_OTLP_HEADERS
              valueFrom:
                secretKeyRef:
                  name: worker-telemetry-auth
                  key: headers
```

Create that Secret through your existing secret-management process. Omit the
header setting entirely if the receiver does not require authentication. The
starter inherits container environment variables; apply the configuration to
workers, not global `NODE_OPTIONS`, to avoid enabling the portal.

The collector must already have a **metrics pipeline** with an OTLP HTTP
receiver and a compatible exporter. A reachable receiver or HTTP 200 response
alone does not prove storage. Confirm that the downstream system has committed
the exported metrics and can query them. This change adds no collector, storage,
dashboard, or other backend infrastructure.

### Counters-only Collector receiver

`PILOTSWARM_OTEL_HISTOGRAMS=false` gates only the SDK-owned
`pilotswarm.turn.duration` and `pilotswarm.lifecycle.duration` instruments.
Other libraries can register metrics, including histograms, through their own or
a shared provider. If a destination must receive only the four PilotSwarm
counters, send PilotSwarm to a dedicated receiver and use this strict allowlist.
It deliberately drops every metric name that is not listed, including future
PilotSwarm metrics, rather than accepting a broad prefix.

This example requires the Contrib distribution, which contains
`filterprocessor`; the core Collector distribution does not. It is pinned to
`otel/opentelemetry-collector-contrib:0.145.0`.

```yaml
receivers:
  otlp/pilotswarm:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  filter/pilotswarm-counters:
    error_mode: propagate
    metrics:
      metric:
        - 'name != "pilotswarm.turns" and name != "pilotswarm.tokens" and name != "pilotswarm.tool.calls" and name != "pilotswarm.lifecycle.operations"'

exporters:
  otlphttp/metrics-destination:
    endpoint: https://metrics.example

service:
  pipelines:
    metrics/pilotswarm:
      receivers: [otlp/pilotswarm]
      processors: [filter/pilotswarm-counters]
      exporters: [otlphttp/metrics-destination]
```

The example declares only a metrics pipeline. Do not add traces or logs to this
receiver unless their routing, retention, and privacy review are explicit.
Resource attributes are still operator-supplied metadata; do not place
credentials, user identifiers, session data, or other sensitive values in them.

## Targeted source checks and live acceptance

The following checks do not require an inference key:

```bash
npm ci --force
npm run build --workspace=packages/sdk
npm run lint --workspace=packages/sdk
node --test scripts/test/worker-otel.test.mjs packages/sdk/test/unit/runtime-metrics.test.mjs deploy/scripts/test/worker-otel-contracts.test.mjs
npm exec --workspace=packages/sdk -- vitest run test/local/runtime-metrics-wiring.test.js test/local/turn-lifecycle.test.js test/local/session-manager-dehydrate.test.js
npm run check:privacy
```

The HTTP tests use a local mock receiver and inspect real OTLP metric payloads.
They are not a production image build or a backend acceptance test.

1. Capture a baseline using an existing workload and the same worker replicas,
   model, and concurrency. Record finished turns, token usage, tool outcomes,
   and lifecycle events from the normal management data.
2. Deploy the image with the metrics-only configuration. Run that same workload.
3. Wait for at least one export interval, or drain a worker to flush. Compare
   counter deltas for the same worker lifetime with the observed workload.
   Account for retries, cancellation, cache-inclusive input, and process resets.
4. Inspect all exported labels and resource attributes. Confirm that the
   collector received only metrics and that downstream storage committed them.
5. Enable histograms only after the collector and downstream schema support
   OTel histogram data, including buckets, counts, sums, and timestamps.

Rollback requires no data deletion: remove the endpoint or set
`OTEL_SDK_DISABLED=true`, then restart workers through the normal rollout.
Keep existing CMS data and backend telemetry. Revert the image if needed.

## Outside this scope

Duroxide metric bridging, queue/lock/DB pool measurements, runtime memory/CPU
metrics, model-only latency, dashboards, alerts, tracing and log rollout, and
exact per-session billing are not delivered by these counters. Histogram
compatibility, a full image build, full test suite, deployment, live workloads,
and committed downstream data must be assessed independently.
