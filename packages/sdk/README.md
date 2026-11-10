# pilotswarm-sdk

Durable runtime primitives for building apps on top of PilotSwarm.

Download the SDK asset from a published Microsoft release, then install it:

```bash
gh release download vX.Y.Z --repo microsoft/PilotSwarm --pattern 'pilotswarm-sdk-*.tgz' --dir dist-tarballs
npm install ./dist-tarballs/pilotswarm-sdk-X.Y.Z.tgz
```

Release assets are public; repository membership is not required. See the
[package installation guide](https://github.com/microsoft/PilotSwarm/blob/main/docs/quickstart/packages.md)
for anonymous downloads and checksum verification. Microsoft distributes
npm-format release assets, not npm registry publications. Install the matching Horizon-store
tarball as well when using its optional providers.

Minimal usage:

```ts
import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "pilotswarm-sdk";
```

## Opt-in worker telemetry

The SDK can export its internal worker counters through OTLP/HTTP. It is off
unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and it installs metrics only by
default. The telemetry bootstrap is a separate public subpath so importing the
SDK does not load telemetry providers.

Preload it before the SDK or application imports acquire meters or tracers:

```bash
node --import pilotswarm-sdk/telemetry app.mjs
```

Set a unique instance identifier explicitly with
`OTEL_RESOURCE_ATTRIBUTES=service.instance.id=worker-1`, or set `POD_NAME` for
the fallback. A minimal metrics-only configuration is:

```dotenv
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_METRICS_EXPORTER=otlp
OTEL_TRACES_EXPORTER=none
OTEL_LOGS_EXPORTER=none
OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=cumulative
```

The standard temporality preference accepts `cumulative` or `delta`; select the
one the receiver supports. Leave the endpoint unset, or set
`OTEL_SDK_DISABLED=true`, to disable providers. No automatic HTTP, database,
model-client, filesystem, or resource collectors are installed.

The application owns signal handling. After its worker drains, call the
idempotent shutdown function before setting a nonzero exit code or exiting:

```ts
import { shutdownTelemetry } from "pilotswarm-sdk/telemetry";

await worker.gracefulShutdown();
await shutdownTelemetry();
```

Handle `SIGINT` and `SIGTERM` once in the application and share its drain
promise. Do not add signal handlers in a library bootstrap. Static ESM imports
do not guarantee that a telemetry provider is registered before another module
gets a meter; use `--import` as shown, or dynamically import the application
only after importing `pilotswarm-sdk/telemetry`. The internal metric hook is
not a consumer API.

### Packed-consumer smoke test

The repository's package smoke needs Node `24.22.1` or later, npm, and an
isolated disposable PostgreSQL server. It deliberately fails when
`PILOTSWARM_SMOKE_DATABASE_URL` is absent; it never falls back to a local or
shared database.

```bash
docker run --rm --name pilotswarm-sdk-telemetry-smoke \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1:5432:5432 postgres:17-trixie

npm ci --ignore-scripts --force
npm run build --workspace=packages/sdk
PILOTSWARM_SMOKE_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
  npm run test:sdk-telemetry-package
```

The test packs the built SDK, installs it into an empty temporary consumer,
imports only `pilotswarm-sdk` and `pilotswarm-sdk/telemetry`, then uses
localhost model and OTLP receivers. It removes the temporary consumer, worker
state, local servers, and isolated database schemas when it completes.

Client apps connect to a deployment's Web API (web mode):

```ts
const client = new PilotSwarmClient({ apiUrl: "https://portal.example.com" });
await client.start();
const session = await client.createSession();
const reply = await session.sendAndWait("hello");
```

Pass `getAccessToken` for authenticated deployments; use `PilotSwarmManagementClient({ apiUrl, getAccessToken? })` for management operations. Constructing a client directly with `{ store }` is internal (worker/portal-host embedding and testing) — see the [Web API reference](https://github.com/microsoft/PilotSwarm/blob/main/docs/api/reference.md).

Workers are trusted backend components and always attach directly to the store:

```ts
const worker = new PilotSwarmWorker({ store: process.env.DATABASE_URL });
```

`pilotswarm-sdk` ships PilotSwarm's embedded framework prompt, framework skills, and management plugins inside the package. App code should provide its own `plugin/` directory and worker-side tool handlers on top of that base.

Packages may contain skills, worker tools, MCP servers, authored agent workflows,
or any combination of them; agent files are optional. With the opt-in Base Agent
V2 policy, sessions progressively search visible static, published, and curated
capabilities, load only the guidance they need, and attach selected permitted
tools or MCP servers at the next turn boundary. Existing sessions retain the V1
framework unless the feature is enabled, and Base V2 requires native tasks.

Tool-catalog overflow dispatch is off by default. A model on a validated
OpenAI-compatible Chat Completions endpoint can opt in with
`toolCatalog: { "maxDeclarations": 128, "overflowStrategy": "typed-dispatch" }`
in its provider-type catalog. Only above that configured declaration limit does
PilotSwarm retain direct declarations and group eligible overflow functions into
one typed dispatch schema. With 140 eligible tools and a limit of 128, it keeps
127 direct declarations and represents the other 13 through the dispatcher.
Model and deployment names, including `model-router`, never enable dispatch.
Every grouped function keeps its description and argument schema; returned calls
are restored to their original names, arguments and IDs before runtime permission
hooks and handlers. The dispatcher has an object root with paired tool-name and
argument alternatives inside a nested `call` property, rather than a root-level
union rejected by some Completions endpoints. This is a wire-format adaptation,
not tool removal or another agent/model turn. The check runs per request, including after a session resumes
or switches models. The existing BYOK `snippy` cleanup is unchanged.

Forced tool choices, strict functions, document-relative schema references and
unrecognized tool options stay direct. Restricted or unsupported tool-choice
lists are not rewritten. If the limit cannot be met without changing those
contracts, the request fails before transport rather than weakening schemas.
Catalogs at or below the limit,
GitHub Copilot, Anthropic and Responses transports are unchanged. Tool-call
fragments are buffered until complete, while ordinary response text still streams.
Grouping does not reduce the catalog's token footprint or enlarge model context.
See [Tool Catalog Overflow](../../docs/developer/reference/configuration.md#tool-catalog-overflow-toolcatalog)
for configuration, runtime-provider inheritance and activation constraints.

Artifact note:

- `write_artifact` remains the standard way for agents to create downloadable files.
- Text artifacts work as before.
- Binary artifacts are supported by supplying `contentType` plus `encoding: "base64"` when the agent writes the file; downloads preserve the raw bytes.

Common docs:

- SDK apps: `https://github.com/microsoft/PilotSwarm/blob/main/docs/developer/building/sdk-apps.md`
- SDK agents: `https://github.com/microsoft/PilotSwarm/blob/main/docs/developer/building/sdk-agents.md`
- Configuration: `https://github.com/microsoft/PilotSwarm/blob/main/docs/developer/reference/configuration.md`
- Architecture: `https://github.com/microsoft/PilotSwarm/blob/main/docs/architecture/system.md`

If you want the shipped terminal UI, portal, and MCP server, install
`pilotswarm` (`pilotswarm-cli` is only a bin alias inside that package).
