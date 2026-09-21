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

### Run a sticky repository worker

`examples/repository-worker.js` is a provider-neutral, source-tree runnable
headless composition for agents that need a persistent Git checkout:

```bash
DATABASE_URL=postgresql://... \
REPOSITORY_URL=https://example.com/org/repository.git \
REPOSITORY_REF=main \
REPOSITORY_WORKSPACE_DIR=/var/lib/pilotswarm/repository \
PILOTSWARM_WORKER_CONCURRENCY=1 \
node packages/sdk/examples/repository-worker.js
```

The worker clones and pins the repository before it becomes ready, changes the
process working directory to that checkout, and binds the checkout to the first
session it receives. The binding is stored under `.git`, so local commits and
uncommitted files remain available to that session after a process restart. A
different session is rejected instead of resetting or contaminating the
checkout, and a session that explicitly requests another working directory is
rejected before the turn starts.

Each workspace must be owned by exactly one worker process and
`PILOTSWARM_WORKER_CONCURRENCY` must be `1`. Set
`REPOSITORY_READY_FILE` when an external supervisor needs a readiness sentinel.
`PLUGIN_DIRS`, `GITHUB_TOKEN`, `LOG_LEVEL`, and `SESSION_STATE_DIR` are handled
the same way as the generic worker example. Supply repository credentials
through the Git execution environment or credential helper; credential-bearing
HTTP URLs are rejected.

This sticky mode deliberately does not provide cross-worker failover or make
Git state atomic with the PilotSwarm session snapshot. Use the durable
repository workspace primitives when the deployment requires portable
checkpoints.

Repository-bound applications can use confined workspaces and the SDK's
provider-neutral Git durability primitives:

```ts
import {
  SessionWorkspaceManager,
  dehydrateGitWorkspace,
  hydrateGitWorkspace,
} from "pilotswarm-sdk";
import path from "node:path";

const workspaces = new SessionWorkspaceManager("C:\\pilotswarm\\workspaces");
const enlistmentDir = path.join(workspaces.resolve(sessionId).path, "repository");

const hydrated = await hydrateGitWorkspace({
  enlistmentDir,
  blobs: blobsFor(sessionId),
  state: stateFor(sessionId),
  targetRef: "origin/main",
});

// Run repository-bound work under the application's durable coordinator.

await dehydrateGitWorkspace({
  enlistmentDir,
  blobs: blobsFor(sessionId),
  state: stateFor(sessionId),
  expectedState: hydrated,
});
```

`GitBlobIO` and `GitStateIO` are provider-neutral interfaces. Blob keys include
the checkpoint epoch and a unique generation so concurrent attempts cannot
overwrite each other's artifacts. The state adapter's atomic `compareAndSet`
selects the committed generation. Deployment,
repository placement, credentials, and concrete persistence adapters remain the
application's responsibility. The durable state row is the commit point:
workspace artifacts are written first, and hydration ignores artifact epochs
that were not committed by the state adapter.
Checkpointing does not mutate the caller's Git index; restored uncommitted
changes are intentionally materialized as unstaged working-tree changes.

`beforeTurn` and `afterTurn` are process-local activity-attempt hooks for setup,
cleanup, and observability. They are not transaction participants in the SDK's
versioned snapshot commit. Applications that checkpoint repository state and
another durable store must coordinate those commits and crash recovery; placing
`dehydrateGitWorkspace` directly in `afterTurn` does not make the two stores
atomic.

`pilotswarm-sdk` ships PilotSwarm's embedded framework prompt, framework skills, and management plugins inside the package. App code should provide its own `plugin/` directory and worker-side tool handlers on top of that base.

Packages may contain skills, worker tools, MCP servers, authored agent workflows,
or any combination of them; agent files are optional. With the opt-in Base Agent
V2 policy, sessions progressively search visible static, published, and curated
capabilities, load only the guidance they need, and attach selected permitted
tools or MCP servers at the next turn boundary. Existing sessions retain the V1
framework unless the feature is enabled, and Base V2 requires native tasks.

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
