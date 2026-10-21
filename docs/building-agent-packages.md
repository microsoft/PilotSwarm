# Building a Package for PilotSwarm

> **Executable published-package safety gate:** publishing code records a pending
> immutable candidate, never automatic activation or grandfathered execution.
> Supported ESM module tools require administrator content approval, verified
> packaged dependencies/config, explicit activation and exact durable session pins.
> They run only in supervised child processes; every tool invocation rechecks
> authoritative current identity/owner/capability/registration state. Prefer
> `tools/worker-module.mjs`; `.js` requires packaged `"type":"module"`.
> Automatic supported stdio MCP uses a session-specific supervised transport,
> never raw package commands in the SDK. Explicitly declared callbacks execute
> through JSON/reverse IPC; failed or unfinished nested calls cannot authorize skip.
> Free-form handlers/prechecks and unverifiable executable/dependency shapes remain
> rejected. See the runtime proposal for exact callback and host requirements.
> Declarative prompts/skills retain their behavior. Historical unbound sessions
> require explicit admin rebind. This prerequisite is **not release-ready**:
> see the supported/unsupported shapes and remaining integration/review gates.
> See the [platform prerequisite and remaining gates](proposals/executable-package-authorization.md).

> **Point your coding assistant (Copilot / Claude / …) at this file.** It is a
> complete, self-contained recipe for authoring a package that uploads
> to PilotSwarm and passes validation on the first try. Every schema, rule,
> and error listed here mirrors the actual validator
> (`packages/sdk/src/agent-package-format.ts`); when in doubt, that file wins.

An **agent package** (the existing API and CLI name) is a folder of files that
teaches a PilotSwarm deployment new capabilities — without rebuilding or
restarting anything. Publish it and workers install it on their next registry
poll (~20 seconds). Generic and named sessions can discover its visible
capabilities; a package that contains agents also supplies named session entry
points.

A package can ship four kinds of artifact, all optional except the manifest:

| Artifact | What it is | Runs where |
|---|---|---|
| **Agents** (`*.agent.md`) | Authored workflows: choreography, checks, and expected outputs, with declared skills/tools/MCP | Named session entry points; instructions can also be consulted as reference |
| **Skills** (`SKILL.md` dirs) | Reusable methods and domain knowledge | Loaded on demand, or preloaded when an agent declares them |
| **Worker tools** (`worker-module.js`) | Real JavaScript executed server-side on the worker | Worker process |
| **MCP servers** (`.mcp.json` + sources) | Executable integrations over stdio/http | Connected for the session that uses them |

**Zero-agent packages are valid.** Use skills for reusable methods and tools
or MCP for executable integrations. Add an agent when the capability needs an
authored workflow, rather than creating a named wrapper around each skill or
tool. Existing agent packages keep their named entry points.

Sessions use `search_capabilities` to find visible skills, workflows, tools,
and MCP integrations. They load methods with `load_skill`, consult authored
workflows with `load_agent_guidelines`, and activate needed permitted
integrations with `use_package`. Reading instructions does not launch an
agent, change session identity, grant permissions, or run its `initialPrompt`.
Before applying another agent's instructions, the session names that agent to
the user and states any material adaptations. A named session is still useful
when the user wants that workflow's entry point or an independent durable
responsibility.

With Base Agent V2 enabled, a session starts with a metadata-only index of
deployment packages and packages published by its owner, including the owner's
private and shared copies. It loads a relevant skill or workflow only when
needed. Other users' shared packages remain searchable, but V2 may only load
their instructions or activate their tools and MCP servers when the session
owner explicitly asks for that capability. Base V1 keeps its existing skill
catalog and declared-skill behavior. A system-owned child without a verified
human owner uses deployment skills for automatic V2 loading.

---

## 1. A minimal useful package — no agents required

```
my-kit/
├── plugin.json                  # REQUIRED — the manifest
└── skills/
    └── style-guide/
        └── SKILL.md            # reusable method; content shown in §4
```

`plugin.json` (identity is required; everything else has defaults):

```json
{
    "name": "my-kit",
    "version": "0.1.0",
    "description": "One-line summary shown in package listings."
}
```

- `name` — **DNS label**: lowercase letters, digits, hyphens; no dots,
  underscores, capitals, or leading/trailing hyphen. Unique per
  `(scope, owner)` — **not** deployment-wide, so you and the shared
  deployment can both publish a `triager` (§9). A leading `__` is reserved
  for the platform and rejected. It identifies the package in discovery and
  becomes the namespace shown next to any agents it contains.
- `version` — **concrete semver** (`1.2.3` or `1.2.3-dev.1`). No ranges, no
  `v` prefix. `name@version` is the immutable identity (see §7).
- `description` — strongly recommended; listings are blank without it.

## 2. plugin.json is the manifest — two layout modes

**Convention mode** (no layout fields): artifacts are discovered at fixed
paths relative to `plugin.json`:

```
my-kit/
├── plugin.json
├── agents/*.agent.md            # every agent, one file each
├── skills/<name>/SKILL.md       # one directory per skill
├── .mcp.json                    # MCP server catalog
├── mcp-servers/**               # stdio MCP server sources
└── tools/worker-module.js       # the single worker-tool entry point
```

**Manifest mode**: declare the layout explicitly and put files wherever you
like. Every path is relative to `plugin.json`; declaring **any** layout field
switches the package to manifest mode, and then **only declared artifacts
ship** (plus the manifest itself):

```json
{
    "name": "my-kit",
    "version": "0.1.0",
    "description": "…",
    "agents":     ["src/prompts/greeter.agent.md"],
    "skills":     ["kb/style-guide"],
    "mcpConfig":  "src/mcp.config.json",
    "mcpServers": ["src/servers/lookup.js"],
    "tools":      "src/worker-tools.js",
    "include":    ["README.md"]
}
```

| Field | Type | Points at |
|---|---|---|
| `agents` | `string[]` | `.agent.md` **files** |
| `skills` | `string[]` | skill **directories** (each contains `SKILL.md`) |
| `mcpConfig` | `string` | the MCP catalog JSON file |
| `mcpServers` | `string[]` | MCP server source files or directories |
| `tools` | `string` | the worker-module JS file |
| `include` | `string[]` | extra files/dirs shipped verbatim (README, fixtures) |

Rules: relative paths only (`..`, absolute paths, and escapes are rejected);
a listed-but-missing file is a **hard error**; two entries may not collide on
the same basename. At publish the artifacts are staged into the convention
layout above and `plugin.json` is rewritten with the canonical paths — the
published tarball always has one canonical shape regardless of how you
authored it.

## 3. Agents — `*.agent.md`

Agents are optional. Each is YAML frontmatter + markdown body. **The body IS
the agent's system prompt** when a session binds to it and must not be empty.
When loaded as reference, the body is guidance the current session can adapt;
loading it does not start the workflow. Put reusable methods in skills so they
can be used without selecting the named entry point.

```markdown
---
name: greeter
description: Greets people and demonstrates this package.
schemaVersion: 2
version: 0.1.0
title: Greeter
tools:
  - roll_dice
skills:
  - style-guide
mcpServers:
  - lookup-mcp
---

# Greeter

You are the Greeter. When greeted, respond warmly and offer to roll dice.
When asked to roll dice, CALL the roll_dice tool — never simulate output.
```

Frontmatter fields:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes (else derived from filename) | How sessions bind to the agent (`create_session {agent: "greeter"}`). Matched case/punctuation-insensitively. |
| `description` | recommended | Shown in the agent picker/catalog. |
| `schemaVersion` | recommended: `1` | `1`, `2`, `3`, and `4` are accepted. Use at least `2` for `mcpServers`, `3` for `initialRequiredTool`, and `4` for `nativeTaskTools`. |
| `version` | recommended | Informational agent version. |
| `title` | optional | Display title. |
| `tools` | optional | Names of worker tools this agent may call — from this package's worker module or the deployment's built-ins. Omit for prompt-only agents. |
| `skills` | optional | Skill names to preload into the prompt (see §4). |
| `mcpServers` | optional | Server names from this package's MCP catalog (§6). |
| `inheritDefaultMcpServers` | optional | Also attach the deployment's default MCP servers. |
| `initialPrompt` | optional | Auto-sent first message when a session starts blank. |
| `initialRequiredTool` | optional, schema `3` | Tool with a registered session handler that must produce a real execution event during the initial prompt turn. It must also appear in `tools`. PilotSwarm corrects one prose-only response, then fails closed if the handler is unavailable or still not invoked. |
| `cronPrechecks` | optional | Bind this agent's `cron` schedules to a cron precheck by reason: a list of `{ reason \| reasonPrefix, precheck }`. A matching schedule asks the precheck (from this package's worker module, §5) before each wake-up and skips wake-ups that have no work, without a model call. Other cron uses and interactive messages are unaffected. Any schema version. |

**Rejected at validation**: `system: true` (background agents belong to the
deployment), an agent named `default`, names colliding with a built-in agent
(the check is case/punctuation-insensitive and also strips a trailing
"agent"), two agents in one package whose names normalize identically, and an
`initialRequiredTool` that uses an older schema or is absent from `tools`.

## 4. Skills — `skills/<name>/SKILL.md`

```markdown
---
name: style-guide
description: House style for responses.
---

# Style Guide

1. Be concise.
2. Attribute quotes.
```

- The frontmatter `name` is what agents reference in their `skills:` list
  (it may differ from the directory name; the loader keys by frontmatter).
- A skill is discoverable without any agent declaring it. Give it a clear
  description so `search_capabilities` can find the method; `load_skill` loads
  its instructions when needed.
- When an agent explicitly lists the skill, the **whole body is inlined into
  that agent's prompt** as `[PRELOADED SKILL: <name>]`. Keep these preloads
  short; use progressive discovery for methods that are only sometimes needed.
- Every subdirectory of `skills/` must contain a parseable `SKILL.md`;
  stray directories fail validation.

## 5. Worker tools — `tools/worker-module.mjs` (or packaged ESM `.js`)

Trusted code executed only in a supervised package child. The supported declaration contract:

```js
/**
 * Export default { createTools({ workerNodeId }) => [tool, …] }.
 * Tools are plain objects: { name, description, parameters, handler }.
 */
export default {
    createTools: ({ workerNodeId }) => [
        {
            name: "roll_dice",
            description: "Roll dice server-side. Returns each roll and the total.",
            parameters: {
                type: "object",
                properties: {
                    sides: { type: "number", description: "Faces per die (default 6)" },
                    count: { type: "number", description: "How many dice (default 1, max 20)" },
                },
            },
            handler: async ({ sides = 6, count = 1 } = {}) => {
                const faces = Math.max(2, Math.min(1000, Math.floor(sides)));
                const dice = Math.max(1, Math.min(20, Math.floor(count)));
                const rolls = Array.from({ length: dice }, () => 1 + Math.floor(Math.random() * faces));
                return { rolls, total: rolls.reduce((a, b) => a + b, 0), rolledOn: workerNodeId };
            },
        },
    ],
};
```

- `parameters` is a JSON-Schema object; `handler` is async and returns a
  JSON-serializable value.
- **Closed imports only.** Bare npm imports, vendored `node_modules`, dynamic
  imports, child-process/native loading and external executable dependencies are
  rejected before activation. Static relative packaged ESM imports and a
  documented subset of `node:` builtins are supported. `.js` needs a packaged
  `package.json` with `"type":"module"` (include it when using manifest staging).
- The file must be valid **ES module** syntax; it is compile-checked (never
  executed) at validation.
- Agent declarations and current session permissions narrow available tools.
  Executable named-agent roots require exact durable bindings. Generic agents
  and declarative named roots can use tools from another executable package
  through exact durable `use_package` selection grants; a declarative root does
  not need a named-agent pin. Both root eligibility and target approval/current
  grants are rechecked before invocation. No agent file is required for a
  tools-only package. Session and deployment restrictions still apply, and
  loading a skill alone does not attach tools.

### Cron prechecks

**Not yet deployment-ready:** package-owned prechecks depend on the separate
executable-package authorization prerequisite. Administrator approval of exact
content before loading and current session permission to invoke it are separate
requirements; neither one replaces the other. This also applies to package
tools and executable MCP integrations.

A package whose agent polls on a `cron` schedule can skip empty cycles without
a model call. The unreleased package precheck API has intentionally changed:
`createCronPrechecks` / exported `cronPrechecks` are **rejected**, never imported.
Declare the schedule name and policy as data in `plugin.json`, mapped to an
explicit generic supervised callback:

```json
{
  "callbacks": {
    "queue_gate": { "agents": ["queue-poller"], "tools": [], "mcpServers": ["queue"] }
  },
  "cronPrechecks": {
    "queue-gate": { "callback": "queue_gate", "timeoutMs": 10000, "shadow": false, "maxConsecutiveSkips": 12 }
  }
}
```

```js
export function createTools() { return []; }
export function createCallbacks() {
  return [{
    name: "queue_gate",
    handler: async ({ sessionId, reason, intervalSeconds, consecutiveSkips }, context) => {
      const result = await context.callMcp("queue", "tools/call", {
        name: "queue_status", arguments: { scope: "both" },
      });
      const hasWork = result.structuredContent?.hasWork;
      if (typeof hasWork !== "boolean") throw new Error("Invalid queue status");
      return { action: hasWork ? "run" : "skip" };
    },
  }];
}
```

Use canonical `tools/worker-module.js` with packaged `package.json` containing
`{"type":"module"}`. Only supported, fully verifiable executable dependencies may
activate; arbitrary npm/bare imports and remote package MCP are not supported.
The existing user-facing agent frontmatter and schedule names do not change:

```yaml
cronPrechecks:
  - reasonPrefix: "Run the queue cycle"
    precheck: queue-gate
```

Bindings accept single-line plain or quoted strings (JSON escapes for double
quotes, doubled apostrophes for single quotes). Inline comments are ignored
outside quotes; `#` inside a quoted reason remains part of the reason.

- Each worker reads precheck policy without importing package code; no deployment code changes.
  Only sessions bound to this package's agents can use them.
- Every callback is subject to current-owner and bound-copy checks, including
  callbacks that never call MCP. Missing ownership or a removed/inaccessible
  binding cannot produce an idle-skip result. Admin approval and explicit
  activation precede imports/factories in a supervised child.
- Package-owned executable schedule arming captures full package/version/SHA
  and binding revision. Continue-as-new preserves that identity. An existing
  approved/authorized V1 schedule can use retained V1 after executable V2
  activation; it never silently follows V2. Retired package registrations cannot
  arm new package-owned schedules. Revocation or explicit rebind denies stale
  schedules; old package-ID-only histories cannot silently adopt executable code.
- Trusted `worker.registerCronPrechecks()` checks need no package binding row
  for prompt-only/declarative agents, including historical sessions. Declarative
  republishing remains fast and needs no administrative rebind. If either the
  existing binding or active copy is executable/unverified, exact-content
  admission remains mandatory even for a static check. Both transitions between
  declarative and executable require explicit rebind and deliberate re-arm.
  Lower-level SDK callers creating named package roots supply
  `boundAgentPackageId`; authenticated Web/TUI creation resolves it server-side.
- `run` continues with the normal model turn. `skip` re-arms the schedule
  without one. A thrown, timed-out or malformed answer runs the model turn,
  and unsupported exports/declarations quarantine the package.
- Timeout cancellation reaches the supervised runtime and kills its owned
  generation, including synchronous code. The child does not receive the
  parent's `AbortSignal`; this is process supervision, not a sandbox.
- Keep the check bounded and answer from authoritative state; return `run`
  when unsure. See [Cron Prechecks](developer/building/sdk-apps.md#cron-prechecks)
  for the full behavior.

#### Calling MCP without a model

Package callbacks use the reverse-IPC `context.callMcp` bridge shown above.
Trusted `worker.registerCronPrechecks` retains `callMcpTool(server, tool, args)`
and its original `AbortSignal` context unchanged.

Declare `queue` in the agent's `mcpServers` and its connection in the package
or deployment MCP configuration as usual (§6). This helper grants no new
servers or tools: the current session owner, exact bound package and a
deployment server's `tools` allowlist apply. It also honors authorized persisted `use_package`
MCP selections. Package-owned MCP markers are resolved only through the exact
supervised/authoritative runtime, never passed to the raw transport helper.
Trusted deployment HTTP/SSE/stdio uses the current-authorized bridge and a
bounded fresh connection. Package MCP children are session-specific supervised
instances. Await every call; failed, caught, or unfinished nested calls cannot
fabricate skip. Interactive OAuth and MCP model sampling are not provided.

Stateful HTTP calls explicitly terminate their remote MCP session after closing
the connection, including on errors or cancellation. Disposal has an independent
one-second deadline so cancellation cannot strand a session without attempting
cleanup. Servers may decline termination with HTTP 405; their own expiry policy
then applies. Other cleanup failures run the normal cycle rather than skip.

Connection, protocol and MCP `isError` results throw. Failed or unfinished
MCP calls force the normal cycle, even if the handler catches an error and
returns `skip`. Do not turn an unknown response into `skip`.
Use deterministic, preferably read-only tools;
activity retries can repeat calls. MCP tools that internally use an LLM may
still incur backend model cost.

## 6. MCP servers — `.mcp.json` + `mcp-servers/`

**Executable published packages currently support only reviewed packaged Node ESM
stdio MCP through supervised authority.** The HTTP/SSE and arbitrary-command
configurations described below remain trusted deployment configuration formats,
not permission to publish or execute an unverifiable package server.

For an executable package, each server config may contain only `command`
(`"node"`), `args` (a package-relative `.mjs`/`.js` entry, then string
arguments), `env` and `type: "stdio"`. Any other key, including a `tools`
allowlist, is an approval blocker shown in **Pending Approval**: the content can
still be approved, but activation is refused. The supervised gateway exposes
the server's tools; access is limited by the agent's `mcpServers` and the
callback's declared `mcpServers`, not by a package `tools` list:

```json
{
    "lookup-mcp": {
        "command": "node",
        "args": ["./mcp-servers/lookup.mjs"]
    }
}
```

In trusted deployment configuration, `.mcp.json` maps server names to configs.
Each server needs `command` (stdio) **or** `url` (http/sse):

```json
{
    "lookup-mcp": {
        "command": "node",
        "args": ["./mcp-servers/lookup.js"],
        "tools": ["*"]
    },
    "remote-api": {
        "url": "https://mcp.example.com/sse"
    }
}
```

- stdio `command`/`args` paths resolve inside the unpacked package — ship
  the server source in `mcp-servers/` and reference it with a relative path.
- `${VAR}` placeholders expand from the worker's environment at load time,
  never at validation.
- Server JS in `mcp-servers/` is syntax-checked like the worker module, and
  the same no-bare-imports rule applies.
- Named agents opt in by listing the server name under `mcpServers:`, and an
  agent that does so must declare `schemaVersion: 2` or later (validator error
  `mcp_requires_schema_v2`).
- Sessions can also discover and activate permitted package MCP integrations
  with `use_package`. An MCP-only package needs no agent file. Activation
  remains subject to the session's actual identity and deployment policy;
  consulting an allowed agent's instructions never acquires its access.
- A reference to a server the package does not define is a warning
  (`unknown_mcp_server`): it must exist in the deployment catalog, or the
  reference is dropped at load.

Two fields are **deployment-catalog only** and rejected in a package
`.mcp.json`:

- `"default": true` (`mcp_default_forbidden`) — it would add the server to
  every agent that inherits the deployment default set.
- `"allowedAgents"` (`mcp_allowed_agents_forbidden`) — only a deployment may
  restrict who uses a server.

### Using a server the deployment restricts

A deployment can restrict one of its own catalog entries to named agents:

```json
{
    "icm-mcp-rw": {
        "type": "stdio", "command": "node", "args": ["/app/plugin/mcp/icm-proxy.mjs"],
        "allowedAgents": ["ops-analyst", "rcakit:rcakit-cosmosdb"],
        "tools": ["*"]
    }
}
```

Entries are agent identities: a bare `name` is a deployment (baked) agent;
`namespace:name` is the agent `name` from the plugin or package whose
namespace is `namespace` — for a package, its `plugin.json` name. A package
agent matches only the **shared** copy of the package; a user-scope copy is
a different package and never inherits the grant. Any other reference to a
restricted server is dropped at load with a warning, and restricted servers
never join the default set. The catalog is flat, so a package cannot define
a server with **any** name the deployment catalog already uses — restricted
or not (`reserved_mcp_server_name` at publish; workers drop such a
definition at load). Pick your own server names.

Optional activation through `use_package` applies these same rules to the
session's resolved agent copy. A qualified session binding is a lookup key,
not the authored agent name: the selected copy supplies its leaf name, raw
plugin namespace, and package provenance. Loading another agent's instructions
does not change that identity. Later turns and worker restarts revalidate the
saved capability source reference without rewriting it or granting new access.

## 7. Versioning and immutability

- **`name@version` is immutable.** Re-publishing the same version with
  different content is **hard-rejected** — there is no `--replace`. Bump the
  version instead; use prerelease semvers (`0.2.0-dev.1`, `-dev.2`, …) for
  the edit-test loop, then publish the clean release version.
- Publishing byte-identical content to the same version is a no-op (safe to
  retry).
- Every upload is normalized to a canonical tarball and hashed; the sha you
  see in the UI identifies the exact content.
- **Ship a `CHANGELOG.md`.** It lives inside the package, so it is versioned,
  diffable, and travels with the artifact; the portal and TUI render it on the
  package detail page. The Agent Manager (§11) refuses to publish a version
  that has no entry, and signs its own entries with the approver's name —
  which is how a reader tells an agent edit from a human `agents push`.

## 8. Hard limits and forbidden content

| Rule | Limit / behavior |
|---|---|
| Compressed size | 16 MB max (portal **folder-upload** envelope: 2 MB) |
| `node_modules` vendored | warning above 2 MB — keep packages dependency-light |
| Symlinks | rejected |
| Non-ASCII file paths | rejected (rename to ASCII) |
| `session-policy.json` | rejected — session policy belongs to the deployment |
| `system: true` agents | rejected |
| Agent named `default` | rejected |
| Names colliding with built-in agents | rejected |

## 9. Validate locally, then upload

**Validate before uploading** (offline, prints every error verbatim):

```sh
pilotswarm agents validate ./my-kit
```

**Upload — any of these paths:**

1. **CLI**: `pilotswarm agents push ./my-kit --shared` (or `--user`).

   ```sh
   pilotswarm auth login --api-url https://<your-portal>
   export PILOTSWARM_API_URL=https://<your-portal>   # or pass --api-url
   pilotswarm agents push ./my-kit --shared
   ```

   No database credentials: your own sign-in decides what you may publish.
   §11 covers the rest of the lifecycle — updating, inspecting, pinning,
   disabling, deleting — and the ≤ 2 MB upload envelope.
2. **Portal**: Admin Console → **Packages** → **+ Add package**:
   - **GitHub / Azure DevOps** — paste the browser link to `plugin.json`
     (or the folder containing it); the branch and path are read from the
     link. **Your browser** reads the repo with **your** access — public
     GitHub needs no credential, Azure DevOps uses your signed-in account,
     and a PAT is only needed for private GitHub (used for that import
     only, never stored). The files are then published through the normal
     package-artifact upload, so nothing about the repo is kept server-side.
   - **Upload folder** — pick the folder in the browser (≤ 2 MB).

   Both portal paths are a point-in-time **import**, not a subscription: to
   ship an update, bump the version and import again (or use the CLI).
3. **MCP** (for assistants driving PilotSwarm): the `push_agent_package`
   tool takes inline base64 files, ≤ 2 MB total.

**Scopes and namespaces**: `shared` = every user can discover the package;
`user` = only you. Package identity is `(scope, owner, name)`, so the first
person to publish `triager` does not own that word for the whole deployment.
Where both exist, **your own enabled copy shadows the shared one** — which is
also the recovery path: disable your personal copy and the shared one takes
over, with no other action. Promote/demote later from the package detail page;
running sessions are never affected by scope changes.

## 10. What happens after publish

- Every worker notices the registry change on its next poll (~20 s) and
  installs the **active** version without a whole-worker restart — watch fleet
  adoption on the package detail page ("N/N workers current"). Declarative
  versions auto-activate; code-bearing versions remain pending administrator
  content approval and separate activation. A mixed code/prompt package requires
  approval for its whole immutable version, not just its executable files.
- Prompt-only agent sessions follow declarative republishes on resume, including
  historical sessions: no exact pin or administrator rebind is required. If either
  their prior binding or active copy is executable/unverified, exact-content rules
  apply. Declarative-to-executable and executable-to-declarative transitions
  require explicit administrator rebind. Existing approved executable V1 pins
  remain V1 when executable V2 activates, never silently adopt V2.
- Owners, package editors and administrators can inspect the package detail's
  **Approval** status, version ID, full digest and reasons, or run
  `pilotswarm agents review-status <package> --api-url <portal-url>` with their
  own authenticated credential. MCP exposes `get_agent_package_review_status`;
  management/Web clients expose `getAgentPackageReviewStatus`. Labels distinguish
  not required, pending admin approval, approved (not active), active, rejected
  and revoked. Publish/republish JSON adds `review` with decision, executable,
  active, versionId and sha256; `status: published | noop` is unchanged.
  These are read-only snapshots, not execution grants. Approve, reject and
  revoke decisions also notify the package owner and editors (portal package
  catalog → **Notifications**, or `pilotswarm agents notifications`), and an
  approved version is marked "approved, not active" until it is activated.
  Administrators review a candidate against its baseline with
  `getAgentPackageReviewDiff` (portal **Pending Approval** tab, MCP
  `get_agent_package_review_diff`). Content approval does not approve external
  tool backends.
- Keep fast-changing prompts declarative; keep approved executable components
  thin/stable or use deployment-registered trusted prechecks. Unknown inspection
  is not a declarative exemption. Disabling, deleting or revoking executable
  content still denies new admissions immediately and requires truthful fencing.
- A broken package (bad import, runtime throw at load) is **quarantined
  alone**: its capabilities become unavailable, the error lands in the fleet view, and
  every other package keeps working.
- Users discover and load the package's visible capabilities from generic or
  named sessions. For a zero-agent package, this is the normal entry point;
  there is no named agent to add to the agent picker.
- If the package contains agents, users bind to one by name (`create_session {agent: "greeter"}`
  via MCP, the portal's agent picker, or the TUI). The package name appears
  as the agent's namespace. A bare name resolves to **your own enabled copy
  first, then the shared one**; these forms reach past that default:

  | Form | Resolves to |
  |---|---|
  | `<package>` | your own enabled copy, else the deployment's |
  | `__shared:<package>` | the deployment-wide copy, explicitly |
  | `<owner>:<package>` | a named owner's copy |
  | `<any of the above>:<semver>` | pinned to one version |

  `__` is reserved at the database for both package names and user subjects,
  so `__shared` cannot be minted by a user. A bare two-segment `a:b` keeps its
  long-standing reading as `namespace:agent` first, and is only tried as
  `owner:package` after that.
- Disabling or deleting a package removes its capabilities fleet-wide on the
  next poll; sessions bound to its agents fail their next turn's agent resolution.
- Every publish path — CLI, portal import, portal folder upload, MCP —
  converges on the same mechanism: files are validated, canonically packed,
  and stored as a package artifact. There is no server-side repo polling.

### Optional advisory review assistant

The [package-reviewer package](../agent-packages/package-reviewer/) supplies
an optional assistant for unrestricted fleet administrators. After an
administrator publishes and enables that declarative package, **Ask
package-reviewer** in the **Pending Approval** diff panel opens its session
with the exact candidate and baseline shown. **Refresh report** reads the saved
facts, analysis, review steps and open risks through
`getAgentPackageReviewReport`.

This is not approval automation. The assistant has no approve, reject,
activation, shell, file, MCP or delegation tools. Each tool call resolves
current owner/admin authority without using the inspect-viewer cache.
Anonymous no-auth operators and the system principal cannot use this bundle,
matching the authenticated-admin rule on the review API.
File-based hooks, custom instructions and discovered skills are disabled.
Package contents are untrusted data, never imported or executed for a review.

Reports bind package/version IDs and both digests, are insert-only, and are
shown only while the candidate is pending and the baseline matches. Large
diff patches are explicitly omitted to keep the tool response within 96 KiB;
the assistant can read individual files in slices. Binary files expose
size/hash only. The administrator must independently inspect any incomplete
analysis. Missing agents, unavailable reports or assistant errors never block
manual review or its decision controls.

## 11. Managing a published package from the CLI

Every registry operation is available from the terminal. The CLI talks to a
deployment's Web API, so your own sign-in decides what you may see and change
— no database credentials anywhere.

**Getting the CLI** (full detail:
[Getting Started → Installing the CLI on its own](./quickstart/local.md#installing-the-cli-on-its-own)):

```sh
gh auth login
# From a PilotSwarm checkout:
scripts/install-from-release.sh X.Y.Z
```

To use subcommands that have not been published yet, run the repo entry point
instead: `node /path/to/pilotswarm/packages/app/tui/bin/tui.js agents …`.

**Signing in:**

```sh
pilotswarm auth login --api-url https://<your-portal>   # once; the token is cached
export PILOTSWARM_API_URL=https://<your-portal>         # or pass --api-url each time
```

**The three you need most:**

```sh
pilotswarm agents push ./my-kit --user      # upload (--shared to publish to everyone)
pilotswarm agents push ./my-kit             # update: bump plugin.json "version" first
pilotswarm agents rm my-kit --yes           # delete every version and its artifacts
```

Updating is the same command as uploading — the version in `plugin.json` is
what makes it a new release (§7). Re-pushing an unchanged version is a no-op
("already up to date"), not an error, so a push in a script is safe to repeat.
`rm` refuses without `--yes`.

**The rest of the surface:**

| Command | What it does |
|---|---|
| `agents list` | Packages visible to you: shared, plus your own user-scope ones |
| `agents show <name>` | Version history, scope, owner, active version |
| `agents tree <name>` | The published file list — what actually shipped |
| `agents cat <name> <file>` | One file's contents from the package |
| `agents pin <name>@<semver>` | Roll the active version back or forward |
| `agents enable\|disable <name>` | Turn a package off fleet-wide without deleting it |
| `agents promote\|demote <name>` | Move between `shared` and `user` scope |
| `agents validate <dir>` | Offline check; no deployment needed |

`tree` and `cat` take `--semver <v>` to inspect a version other than the
active one — useful for confirming what a release actually contains before
pinning to it. `list` and `show` take `--json`.

**Two things to know:**

- **Only what the manifest declares is uploaded.** In manifest mode the CLI
  publishes exactly the staged tree, so a `scratch/`, `docs/`, or `.git`
  directory sitting beside `plugin.json` is neither uploaded nor counted
  against the size limit. Use `agents tree` after publishing to confirm.
- **Web upload is capped at ≤ 2 MB**, the same envelope as the portal and MCP
  paths. A larger package needs `--store <postgres-url>` (which packs up to
  16 MB compressed). That path talks to the datastore directly and **bypasses
  authentication and authorization entirely** — operator break-glass, not a
  normal path. It announces itself on stderr whenever it engages, including
  when it is selected by a `DATABASE_URL` left in your shell.

**Or let an agent do it.** The `agent-manager` package (in `agent-packages/`
in this repo) installs an agent that reads, edits and ships packages on your
behalf: it diagnoses a misbehaving session, stages an edit seeded from the
bytes actually running, renders the change as reviewable `.patch` artifacts,
and publishes a new version only once a human approves. It can also author a
package from scratch. Importing from a URL reaches only origins the
deployment has allowlisted in `.agent_packages.json`, so a URL injected into a
transcript it is reading cannot be fetched at all.

## 12. Complete worked example

The live reference package is `demo-agent-kit` (published on the demo
deployment): one agent (`kit-navigator`) wired to two worker tools
(`roll_dice`, `kit_info`), one preloaded skill (`fortune-craft`), and one
stdio MCP server (`fortune-mcp`) — in manifest mode:

```
demo-agent-kit/
├── plugin.json                      # manifest: identity + explicit layout
├── agents/kit-navigator.agent.md    # prompt references all three surfaces
├── skills/fortune-craft/SKILL.md    # contains a codeword to prove preloading
├── mcp-servers/fortune-server.js    # stdio MCP server source
├── tools/worker-module.js           # the §5 contract, two tools
├── .mcp.json                        # { "fortune-mcp": { command, args } }
└── README.md                        # shipped via "include"
```

A good smoke test exercises the surfaces the package actually contains.
For a zero-agent package, use a generic session: discover the package, load a
skill, activate its permitted integrations, and verify real tool/MCP results.
For an authored agent workflow, also use a session bound to that agent to
check its entry point and declared configuration. Confirm execution evidence
rather than accepting a claim that a tool ran (the demo kit's tools return the
executing `workerNodeId` for exactly this reason).

### A multi-agent package you can read in this repo

[`examples/agent-packages/finance-research-lab/`](../examples/agent-packages/finance-research-lab/)
is a larger package checked into this repository, so it needs no deployment
to study: a lead agent that coordinates five specialists over six shared
worker tools, plus two skills — also in manifest mode:

```
finance-research-lab/
├── plugin.json                                # manifest: six agents, two skills
├── agents/finance-research-lead.agent.md      # coordinator for the five below
├── agents/equity-fundamentals.agent.md
├── agents/valuation-analyst.agent.md
├── agents/market-catalyst-scout.agent.md
├── agents/investment-risk-auditor.agent.md
├── agents/macro-sector-strategist.agent.md
├── skills/finance-research-standards/SKILL.md
├── skills/valuation-methods/SKILL.md
├── tools/worker-module.js                     # the §5 contract, six tools
└── README.md                                  # shipped via "include"
```

It shows two things a single-agent kit cannot: several agents sharing one
worker module while each declaring a different subset of its tools, and
skills preloaded only by the agents that need them (only the valuation-facing
agents preload `valuation-methods`; other sessions can discover it on demand). It ships no MCP
server, so it is also the smaller of the two starting points. Its only
external configuration is `SEC_USER_AGENT`, which the SEC's fair-access
policy requires of automated callers.

### An offline package with all four artifact kinds

[`examples/agent-packages/editorial-desk/`](../examples/agent-packages/editorial-desk/)
is the example to copy when you want every surface at once, in **convention
mode**, with no credentials and no network:

```
editorial-desk/
├── plugin.json                             # identity only — no layout fields
├── agents/editor-in-chief.agent.md         # coordinator; self-starting, with splash art
├── agents/structure-editor.agent.md
├── agents/line-editor.agent.md
├── agents/caveman-editor.agent.md          # optional compression pass
├── skills/editorial-standards/SKILL.md     # the map — the rulebook lives in MCP
├── tools/worker-module.js                  # the §5 contract, seven tools
├── .mcp.json                               # { "style-desk": { command, args } }
├── mcp-servers/style-desk.js               # the §6 contract, hand-rolled JSON-RPC
└── README.md                               # shipped automatically in convention mode
```

Four things it demonstrates that the other two do not:

- **Convention mode.** `plugin.json` carries identity only; every artifact is
  found at its fixed path (§2), and files like `README.md` ship without being
  declared.
- **A stdio MCP server shipped inside the package.** Because package code
  loads from an install cache with no `node_modules` above it,
  `@modelcontextprotocol/sdk` is not importable — `mcp-servers/style-desk.js`
  speaks the MCP stdio transport directly (newline-delimited JSON-RPC 2.0 over
  stdin/stdout) using only Node built-ins. Copy it as the starting point for
  any in-package MCP server.
- **The skill/MCP split, deliberately.** The preloaded skill holds the map
  because it costs prompt space on every turn; the full rulebook, the format
  checklists, and the preferred-term list sit behind MCP and are fetched only
  when needed.
- **Model transforms, code verifies.** The optional caveman pass has the model
  do the compressing, but a worker tool masks every protected region first so
  code, URLs, paths, and numbers return byte-identical, and a second worker
  tool *errors* if any of them went missing. When a capability cannot be made
  deterministic, this is the shape to reach for.

Every tool in it is deterministic and offline, so the same input always
produces the same numbers — which is what lets it double as a smoke test.

## 13. Checklist for assistants

Before telling the user the package is ready:

- [ ] `plugin.json` has DNS-label `name`, concrete-semver `version`, and a `description`.
- [ ] Manifest mode: every declared path exists; nothing needed is undeclared. Convention mode: files sit at the fixed paths in §2.
- [ ] Contents match the capability: skills for reusable methods, tools/MCP for executable integrations, agents for authored workflows. Zero agents is valid.
- [ ] If present, every `.agent.md` has a non-empty body, the schema version its fields require (§3), and a unique, non-reserved name.
- [ ] If agents are present, their `tools:` names match available tools; `skills:` match SKILL.md frontmatter names; `mcpServers:` match package or permitted deployment catalog keys.
- [ ] `tools/worker-module.mjs` (or `.js` with packaged `"type":"module"`, never both) and `mcp-servers/*` modules are valid ESM with **no bare imports**.
- [ ] `pilotswarm agents validate ./my-kit` prints no errors.
- [ ] Version bumped if this `name@version` was ever published with different content.
- [ ] `CHANGELOG.md` has an entry for the version being published (§7).
- [ ] After publishing: `pilotswarm agents tree <name>` shows exactly the files you intended — no stray directories, nothing missing (§11).
