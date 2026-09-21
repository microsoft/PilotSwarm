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

Repository-bound workers can opt into generic turn hooks and compose them with
the SDK's confined workspace and Git durability primitives:

```ts
import {
  PilotSwarmWorker,
  SessionWorkspaceManager,
  dehydrateGitWorkspace,
  hydrateGitWorkspace,
} from "pilotswarm-sdk";

const workspaces = new SessionWorkspaceManager("C:\\pilotswarm\\workspaces");

const worker = new PilotSwarmWorker({
  store: process.env.DATABASE_URL,
  beforeTurn: ({ sessionId, trace }) => hydrateGitWorkspace({
    enlistmentDir: workspaces.resolve(sessionId).path,
    blobs: blobsFor(sessionId),
    state: stateFor(sessionId),
    targetRef: "origin/main",
    trace,
  }),
  afterTurn: ({ sessionId, trace }) => dehydrateGitWorkspace({
    enlistmentDir: workspaces.resolve(sessionId).path,
    blobs: blobsFor(sessionId),
    state: stateFor(sessionId),
    trace,
  }),
});
```

`GitBlobIO` and `GitStateIO` are provider-neutral interfaces. Deployment,
repository placement, credentials, and concrete persistence adapters remain the
application's responsibility. The durable state row is the commit point:
workspace artifacts are written first, and hydration ignores artifact epochs
that were not committed by the state adapter. See
`examples/repository-workspace-hooks.js` for the minimal composition boundary.

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
