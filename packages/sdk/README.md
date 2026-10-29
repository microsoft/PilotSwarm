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

`pilotswarm-sdk` ships PilotSwarm's embedded framework prompt, framework skills, and management plugins inside the package. App code should provide its own `plugin/` directory and worker-side tool handlers on top of that base.

Packages may contain skills, worker tools, MCP servers, authored agent workflows,
or any combination of them; agent files are optional. With the opt-in Base Agent
V2 policy, sessions progressively search visible static, published, and curated
capabilities, load only the guidance they need, and attach selected permitted
tools or MCP servers at the next turn boundary. Existing sessions retain the V1
framework unless the feature is enabled, and Base V2 requires native tasks.

Credentialed hosts can set `PILOTSWARM_PACKAGE_POLICY_MODULE` to an absolute,
deployment-owned ESM file exporting `authorizePackage({ kind, root,
packageSha256 })`. Throw to deny; `kind` is `agent` or `workflow`. The SDK verifies
the canonical package bytes before invoking the policy, including warm registry
caches, and calls it before workflow registration and every transition-module
load. Missing/invalid configured modules fail closed. No policy is enabled by
default; `PACKAGE_POLICY_API_VERSION === 1` lets hosts refuse older runtimes.
Policies should reread mutable approvals rather than caching grants.

Worker options `agentPackages: { mcpServers: "deployment-only",
workerModules: "disabled" }` suppress package-defined MCP servers and generic
worker-module imports without removing agent prompts. Named references still
honor the deployment catalog and its agent restrictions. These options do not
approve workflow JavaScript: use the host policy to admit exact package
identities before import. Approved modules execute as ordinary trusted Node
code, not in a sandbox. Neither content hashes nor package ownership alone
establish execution approval.

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
