# PilotSwarm

> **Experimental** — This project is under active development and not yet ready for production use. APIs may change without notice.

An open-source durable execution runtime for [GitHub Copilot SDK](https://github.com/github/copilot-sdk) agents. Crash recovery, durable timers, session dehydration, and multi-node scaling — powered by [duroxide](https://github.com/microsoft/duroxide). Just add a connection string.

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Builder Agents

If you are building layered apps on top of PilotSwarm, this repo now ships distributable builder-agent templates you can copy into your own repository:

- [Builder Agent Templates](./docs/developer/building/builder-agents.md)
- [DevOps Command Center Sample](examples/devops-command-center/README.md)
- [Horizon Harvester Sample](examples/horizon-harvester/README.md) — optional enhanced facts + knowledge graph

These are not active agents in this repo. They are templates intended to be copied into a user repo under `.github/agents/` and `.github/skills/`.

<img width="630" height="239" alt="image" src="https://github.com/user-attachments/assets/807cdf40-b228-41c1-bfe2-8100230544c9" />

## Quick Start

### Run from source

Use Node.js 24 or later and a PostgreSQL instance you can access. Build the
repository, copy the example configuration, then set `DATABASE_URL` and a model
provider credential such as `GITHUB_TOKEN` in `.env`:

```bash
git clone https://github.com/microsoft/PilotSwarm.git
cd PilotSwarm
npm ci
npm run build
cp .env.example .env
cp .model_providers.example.json .model_providers.json
# Edit .env and .model_providers.json for your PostgreSQL and model provider.
./run.sh local --db
```

The local command starts the TUI with embedded workers and uses the PostgreSQL
connection configured in `.env`. See [Configuration](./docs/developer/reference/configuration.md)
for the available settings.

### Package tarballs

PilotSwarm distributes its three npm-format packages as `.tgz` assets
on [GitHub Releases](https://github.com/microsoft/PilotSwarm/releases):
`pilotswarm-sdk`, `pilotswarm-horizon-store`, and `pilotswarm`. After a release
is selected, download and verify the matching tarballs using the
[package installation guide](docs/quickstart/packages.md). Public downloads do
not require repository membership. With GitHub CLI:

```bash
gh release download vX.Y.Z --repo microsoft/PilotSwarm --pattern '*.tgz' --pattern SHA256SUMS --dir dist-tarballs
(cd dist-tarballs && shasum -a 256 -c SHA256SUMS)
npm install -g ./dist-tarballs/pilotswarm-sdk-X.Y.Z.tgz \
  ./dist-tarballs/pilotswarm-horizon-store-X.Y.Z.tgz \
  ./dist-tarballs/pilotswarm-X.Y.Z.tgz
```

The tarballs provide the three PilotSwarm packages; npm still resolves their
other dependencies through your configured registry. Keep the release's
`LICENSE` copyright and permission notice with redistributed copies.

### Use as a library in your own app

Install the SDK tarball from a GitHub Release or use a checkout, then:

```typescript
import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "pilotswarm-sdk";

const getWeather = defineTool("get_weather", {
    description: "Get weather for a city",
    parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
    },
    handler: async ({ city }) => {
        const res = await fetch(`https://wttr.in/${city}?format=j1`);
        return await res.json();
    },
});

// Worker runs LLM turns + tools. In production it lives in its own
// long-running process (see "Durability" below); here we co-locate for demo.
const worker = new PilotSwarmWorker({ store: process.env.DATABASE_URL });
worker.registerTools([getWeather]);
await worker.start();

// Direct { store } client only because this single-process demo co-locates
// worker and client. Apps talking to a real deployment use web mode
// ({ apiUrl }) — see "Connect to a shared deployment" below.
const client = new PilotSwarmClient({ store: process.env.DATABASE_URL });
await client.start();

const session = await client.createSession({
    toolNames: ["get_weather"],
    systemMessage: "You are a weather assistant.",
});
const response = await session.sendAndWait("What's the weather in NYC?");
console.log(response);

await client.stop();
await worker.stop();
```

A worker-registered tool can keep durable state per session without touching
SDK internals. Its handler receives `invocation.facts`, bound to the calling
session; the model never sees it, and nothing under the `tools/` key prefix is
readable, writable, or searchable by any agent through the fact tools:

```typescript
const proxy = defineTool("call_service", {
    description: "Call the external service for this session",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    handler: async ({ query }, ctx) => {
        // Exact read, this session only. `{ scope: "root" }` binds to the spawn
        // tree's root session; `{ scope: "shared" }` is cluster-wide.
        let binding = await ctx.facts?.read("tools/my-service/binding");
        if (!binding) {
            binding = await openExternalSession(ctx.durableSessionId);
            await ctx.facts?.store("tools/my-service/binding", binding);
            binding = await ctx.facts?.read("tools/my-service/binding"); // adopt the winner if two replicas raced
        }
        return callService(binding, query);
    },
});
```

Reserve more prefixes for tools with `new PilotSwarmWorker({ reservedFactPrefixes: ["bindings/"] })`.
Design: `docs/proposals/tool-context-facts-accessor.md`.

PilotSwarm's own framework prompt and management plugins ship embedded inside `pilotswarm-sdk`. Apps layer their own `plugin/` directories on top; they do not need to copy the framework's built-in plugin text into their own repos.

### Connect to a shared deployment

Already have a PilotSwarm deployment (see [Deploying to AKS](./docs/developer/deploy/aks.md))? The portal hosts a versioned Web API (HTTP `/api/v1` + WebSocket `/api/v1/ws`), so clients need the portal URL.

From a built checkout, attach the TUI with:

```bash
node packages/app/tui/bin/tui.js remote --api-url https://portal.example.com
```

Logs stream over the API. If the deployment uses Entra authentication, the TUI
opens a browser for interactive sign-in. The `auth login|status|logout`
subcommands on the same entry point manage that sign-in; use `--device-code`
for headless hosts.

Or connect from your own app with the SDK's web mode:

```typescript
const client = new PilotSwarmClient({ apiUrl: "https://portal.example.com" });
await client.start();
// Session handles work exactly as in the demo above: send, sendAndWait, on, ...
```

`PilotSwarmManagementClient({ apiUrl })` works the same way. The zero-dependency [`pilotswarm-sdk/api`](packages/sdk/api/README.md) subpath speaks the same contract — see the [Web API Reference](docs/api/reference.md). Direct `{ store }` client construction remains available for worker/portal embedding and internal testing only; workers always use `{ store }`.

### Durability — recurring and long-waiting agents

The single-process demo above doesn't show the durability story because the
process exits as soon as the response lands. To run an agent that pauses for
hours or runs a recurring schedule, the worker has to be a long-running
process — typically:

- one or more `PilotSwarmWorker`s in their own service (locally with `npm run worker`, in production on Kubernetes), and
- clients (CLI, TUI, browser portal, or your app) connecting through the portal's [Web API](docs/api/reference.md)

The agent then calls `wait(...)` for one-shot delays, or `cron(...)` for
recurring schedules. Long waits dehydrate the session to blob storage; any
worker rehydrates it when the timer fires. See [Architecture](./docs/architecture/system.md)
and [Building SDK Apps](./docs/developer/building/sdk-apps.md) for the full pattern.

## What You Get

| Feature | Copilot SDK | PilotSwarm |
|---------|-------------|---------------------|
| Tool calling | ✅ | ✅ Same `defineTool()` API |
| Wait/pause | ❌ Blocks process | ✅ Durable timer — process shuts down, resumes later |
| Crash recovery | ❌ Session lost | ✅ Automatic resume from last state |
| Multi-node | ❌ Single process | ✅ Sessions migrate between worker pods |
| Session persistence | ❌ In-memory | ✅ PostgreSQL + Azure Blob Storage |
| Event streaming | ❌ Local only | ✅ Cross-process event subscriptions |

## How It Works

The runtime automatically injects `wait` and `cron` tools into every session. When the LLM needs to pause or schedule recurring work:

1. **Short waits** (< 30s) — sleep in-process
2. **Long waits** (≥ 30s) — dehydrate session to blob storage → durable timer → any worker hydrates and continues
3. **Recurring schedules** — use `cron(...)` so the orchestration re-arms itself automatically after each cycle

```
Client                        PostgreSQL                     Worker Pods
  │                              │                              │
  │── send("monitor hourly") ──→ │                              │
  │                              │── orchestration queued ────→ │
  │                              │                              │── runTurn (LLM)
  │                              │                              │── wait(3600)
  │                              │                              │── dehydrate → blob
  │                              │── durable timer (1 hour) ──→ │
  │                              │                              │── hydrate ← blob
  │                              │                              │── runTurn (LLM)
  │                              │                              │── response
  │←── result ──────────────────│                              │
```

## Examples

| Example | Description | Command |
|---------|-------------|---------|
| [Chat](packages/sdk/examples/chat.js) | Interactive console chat | `npm run chat` |
| [TUI](packages/app/tui/bin/tui.js) | Multi-session terminal UI with logs | `npm run tui` |
| [Worker](packages/sdk/examples/worker.js) | Headless worker for K8s | `npm run worker` |
| [Tests](packages/sdk/test/sdk.test.js) | Automated test suite | `npm test` |

## Documentation

Start with the documentation hub:

- [Documentation Index](docs/README.md)

Common entry points:

- [User Guide](docs/user-guide/README.md) — scenario-based walkthroughs of the TUI and browser portal, simple to advanced
- [Working On PilotSwarm](./docs/developer/contributing/working-on-pilotswarm.md) — contributors working on the SDK, TUI, providers, prompts, or orchestration
- [Builder Agent Templates](./docs/developer/building/builder-agents.md) — copyable Copilot custom agents for users building apps on top of PilotSwarm
- [Building Packages](./docs/building-agent-packages.md) — author uploadable agents, skills, tools, MCP integrations, and workflows; zero-agent packages are valid; written to be handed straight to a coding assistant
- [Building SDK Apps](./docs/developer/building/sdk-apps.md) — app developers using `PilotSwarmClient` and `PilotSwarmWorker`
- [Building Agents For SDK Apps](./docs/developer/building/sdk-agents.md) — the clearest path for authoring `default.agent.md`, named agents, skills, and tools
- [Building CLI Apps](./docs/developer/building/cli-apps.md) — plugin- and worker-module-driven apps on the shipped TUI
- [Building Agents For CLI Apps](./docs/developer/building/cli-agents.md) — the CLI-focused agent-authoring guide
- [Example Applications](./docs/developer/building/examples.md) — includes the DevOps Command Center sample for layered apps
- [Web API Reference](docs/api/reference.md) — the versioned HTTP + WebSocket API (`/api/v1`) behind SDK web mode, `pilotswarm remote --api-url`, and the browser portal
- [Configuration](./docs/developer/reference/configuration.md) — environment variables, blob storage, worker/client options
- [Deploying to AKS](./docs/developer/deploy/aks.md) — Kubernetes deployment, scaling, and rolling updates
- [Architecture](./docs/architecture/system.md) — internal design and runtime flow

## Requirements

- Node.js >= 24
- PostgreSQL
- GitHub Copilot access token (worker-side only)
- Azure Blob Storage (optional, for session dehydration across nodes)

## License

PilotSwarm is licensed under the [MIT license](LICENSE), retaining both
Microsoft and original-contributor copyright notices. See the
[source provenance record](docs/migration/README.md).

## Contributing

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit [Contributor License Agreements](https://cla.opensource.microsoft.com).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
