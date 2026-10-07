# Fleet-Default MCP Servers — Design Sketch

> **Implemented with a different assembly boundary:** this proposal originally
> targeted the retired specialized repository worker. The standard generic
> worker now consumes deployment-owned MCP configuration directly when no
> startup module supplies MCP worker options. An owning composition repository
> can still use a startup module to override that fallback.

How a generic worker grants every session a set of **default MCP servers that
are NOT checked into a target repo** — including sessions with no repository.
The canonical case is Azure DevOps MCP, so a session can look up a work item
without relying on a repo's `.vscode/mcp.json`.

This is the deployment-owned source of MCP servers. Authentication is supplied
by the worker through the configured workload-identity scope mapping and is
never taken from the session request.

## Original problem

Before the generic-worker startup module, a worker's sessions received MCP
servers from exactly two places:

1. **Plugin catalog** — `.mcp.json` in a plugin dir; servers tagged
   `"default": true` are granted to agents that opt in with
   `inheritDefaultMcpServers: true` (`packages/sdk/src/mcp-loader.ts`
   → `loadMcpConfig`).
2. **Repo-declared** — `<enlistment>/.vscode/mcp.json`, loaded by
   `loadRepoMcpConfig` and passed as the worker's direct `mcpServers` so every
   session on the (repo-pinned) worker gets them. Curated by `REPO_MCP_ALLOW`.

Both are **opt-in by the repo**. There is no way to say "every session on this
fleet should be able to talk to ADO," short of asking each target repo to
check an `ado` server into its `.vscode/mcp.json` — which the operator does not
control and which pollutes those repos' developer configs. Concretely: a session
asks its agent to "look up work item 12345" and it cannot, because that repo's
`.vscode/mcp.json` never declared an ADO MCP server.

## Goal / non-goals

**Goal.** A deploy-time, fleet-level set of **remote** MCP servers injected into
every session on a worker, independent of the target repo's files, authenticated
with the deployment-owned worker identity.

**Non-goals.** No caller credential transport; no stdio defaults; no concrete
server URLs or Entra scopes in source. Server names, URLs, and scopes remain
deployment configuration.

## The ADO MCP connection string

The full remote Azure DevOps MCP is served per-organization at:

```
https://mcp.dev.azure.com/<org>
```

So a fleet targeting organization `<org>` would carry:

```json
{
  "servers": {
    "ado": {
      "type": "http",
      "url": "https://mcp.dev.azure.com/<org>",
      "tools": ["*"]
    }
  }
}
```

- **No `Authorization` header in config.** The deployment maps the server name
  to its Entra scope through `MCP_WORKLOAD_IDENTITY_SCOPES`. The worker acquires
  the token and attaches it only when the effective server URL matches the
  deployment-owned URL.
- **Authenticated transport is constrained.** Workload-identity headers require
  HTTPS except for deployment-owned Kubernetes Services addressed by the exact
  cluster-local form
  `http://<service>.<namespace>.svc.cluster.local[/path]`. Arbitrary HTTP hosts,
  IP addresses, embedded credentials, and URL fragments remain rejected.
- **Optional toolset narrowing** — the ADO MCP exposes a large surface; it can
  be trimmed with an `X-MCP-Toolsets` request header
  (e.g. `core,work-items,repositories,search`) to cut tool count / context.

> URL-free-source rule: the concrete URL + org live ONLY on the deploy side (a
> per-fleet deploy value, substituted like the other deploy tokens), never in
> the public base manifest.

## Design

### 1. New config source: `DEFAULT_MCP_JSON`

A new deploy token carrying an inline JSONC `{ "servers": { … } }` map (same
schema as `.vscode/mcp.json`), surfaced to the worker as an env var:

- Set per-fleet on the deploy side and substituted into the worker base manifest
  by the deploy tooling (a new `__DEFAULT_MCP_JSON__` token, plumbed exactly like
  `__PLUGIN_SPEC__`).
- Optionally a cluster-wide default in the `worker-env` ConfigMap that a per-fleet
  value overrides. (Fleets that share one org can use a single cluster default;
  per-fleet keeps org/toolset flexibility.)

### 2. New loader: `loadDefaultMcpConfig`

Add to `packages/sdk/src/mcp-loader.ts`, sharing internals with
`loadRepoMcpConfig`:

- Parse the value as JSONC (`parseMcpJsonc`), accept the `{ servers }` wrapper
  or a flat map.
- `remoteOnly` is forced true (a fleet default is never a local stdio server).
- Normalize like repo servers: missing/empty `tools` → `["*"]`; skip entries
  still carrying unresolved `${input:…}`/`${command:…}`.
- **Mark each default server `optional: true`** (see §4).

### 3. Precedence (worker assembly)

The standard generic worker loads `DEFAULT_MCP_JSON` and
`MCP_WORKLOAD_IDENTITY_SCOPES` from its environment. The Azure deployment
already projects its rendered `.env` through the `worker-env` ConfigMap, so the
same mechanism works for workers with or without a repository.

If `PILOTSWARM_WORKER_STARTUP_MODULE` returns `workerOptions`, those options are
authoritative and the generic fallback is not parsed. This preserves
composition-owned startup behavior and prevents a server catalog or headers
provider from being loaded twice. A startup module that only adds plugins and
does not return `workerOptions` still receives the generic deployment fallback.

Deployment-owned servers receive only URL-bound worker headers. Repository MCP
discovery is disabled on shared workers; a trusted devbox launcher may opt in,
but a repository-defined same-name server cannot receive deployment headers
because its URL does not match the deployment binding.

### 4. Authentication semantics

Deployment-owned MCP authentication fails closed. A token acquisition or URL
binding failure never falls back to a PAT and never borrows a caller credential.
The error is surfaced by the worker rather than silently changing identities.

### Server sources after this change

| Source | File / token | Scope | Auth |
|---|---|---|---|
| Plugin catalog | plugin `.mcp.json` `default:true` | agent opt-in | n/a (mostly stdio/local) |
| Repo-declared | `<enlistment>/.vscode/mcp.json` | trusted devbox opt-in only | devbox-local caller identity |
| **Fleet-default** | `DEFAULT_MCP_JSON` (.env/ConfigMap) | every session, repo-independent | URL-bound worker workload identity |

## Exit criteria

1. **Injected without the repo:** a session on a fleet configured with the ADO
   default, running against a repo whose `.vscode/mcp.json` declares **no** ADO
   server, has the `ado` MCP available.
2. **It actually works:** a prompt such as *"look up Azure DevOps work item
   `<id>` and report its creation date"* drives the `ado` server's work-item tool
   to **complete successfully** (`TOOL_COMPLETED`, `success=true`) and the reply
   contains that work item's **immutable** creation date. (An immutable field is
   used deliberately — a title/state can be edited and would make the check
   flaky.)
3. **Identity boundary preserved:** the ADO server is reached with the worker
   UAMI. No caller token is accepted by the PilotSwarm API or persisted for the
   worker.
4. **No composition regression:** startup-module MCP options remain
   authoritative and deployment fallback is used only when they are absent.
5. **URL-free source:** the concrete ADO URL/org appear only in the deploy-side
   value; public source carries no concrete server or tenant configuration.

## Acceptance test

An end-to-end test that exercises the feature against a real fleet:

- Creates a session without repository affinity and attaches **no** MCP server
  of its own, so any `ado` server that shows up must be the fleet default rather
  than repo or caller configuration.
- Supplies no caller credential or MCP server configuration. The deployment
  provides the server and the worker UAMI authenticates it.
- Submits a work-item lookup prompt and asserts an `ado` work-item tool
  **completes successfully**, and (stronger) that the reply contains the work
  item's **immutable creation date** — a mutable field like the title/state would
  make the check flaky.
- **Exit codes:** `0` PASS / `1` FAIL (feature absent: no default server, the tool
  never runs) / `2` SKIP (infra unreachable or no credential). Wire as an
  **expected-fail** until the feature is deployed; it flips green once it is.

Plus unit tests (SDK): `loadDefaultMcpConfig` parse/normalize; merge precedence
(repo overrides default); `resolveMcpServerAuth` optional-skip vs. repo
fast-fail.

## Rollout

1. Land SDK changes (`loadDefaultMcpConfig`, `optional` tag, worker merge,
   `resolveMcpServerAuth` optional-skip) + unit tests.
2. Build a new uniquely-tagged worker image (worker JS is baked in).
3. Set the server catalog and scope bindings in the deploy-side worker `.env`;
   the existing `worker-env` ConfigMap projects both values to the generic
   worker.
4. Roll fleet-by-fleet with truthful readiness and run the default-MCP
   acceptance client against each fleet to confirm green.

## Open questions

- **Cluster-wide default vs. per-fleet value.** Fleets that share one org can use
  a single ConfigMap default; a per-fleet value is only needed if a fleet wants a
  different org or toolset. Start cluster-wide, allow a per-fleet override.
- **Toolset trimming.** Ship `X-MCP-Toolsets` (e.g. `core,work-items,search`) on
  the default ADO entry to cap tool count, or leave `["*"]` and revisit if
  context bloat shows up.
- **Generalize `optional` to phase-2.** This introduces optional-skip narrowly;
  consider whether repo-declared servers should also move from fast-fail to skip
  (the broader phase-2 TODO in `mcp-auth-discovery.ts`).
