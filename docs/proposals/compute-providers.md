# Compute providers: running a session's GHCP runtime somewhere else

Status: exploration. Nothing here is released; the exported interface is
experimental and may change.

## The problem

Today every session's GHCP runtime (the Copilot CLI: the agent loop and its
built-in tools such as `bash`) runs as a child process of the PilotSwarm
worker that claims the turn. The runtime inherits the worker's environment,
so model-chosen code runs next to the worker's database, blob and model
credentials. And every session runs on the same kind of machine.

We want sessions to run on a choice of compute, chosen per session, while
keeping one rule:

> **Invariant:** a GHCP runtime never runs in the same context (process,
> container, VM or machine) as anything that can access the CMS or duroxide.
> Commands and results may cross that boundary; database credentials and
> network routes to the database never do.

## Shape

The worker stays trusted and keeps everything it has today: orchestrations,
PilotSwarm tools, authorization, model credentials and session state. Only
the GHCP runtime moves. The worker drives it remotely through the Copilot
SDK connection; the runtime calls back over the same connection for
PilotSwarm tools, model requests, session-state reads and writes, and
permission requests.

Nothing in this design names a platform. A compute type can be a container on
separate machines, a managed sandbox service, a user's own machine, or an
existing build pool. Each is a plug-in.

## Terms

| Term | Meaning |
|---|---|
| Compute type | A kind of place a runtime can run |
| Compute provider | The worker plug-in for one compute type, identified by `kind` |
| Compute target | A registered instance of a compute type, stored in the CMS. Users pick one per session |
| Host | The concrete runtime a session tree is bound to |

A session tree runs entirely on one compute target, fixed when its root
session is created. The worker reads the target from the root session's
record before every turn, so a sub-agent always runs where its tree runs,
and nothing a client sends later can move a session. Whether a tree should
ever span several targets is an open question.

## Compute targets (data)

Migration 0084 adds `compute_targets`, with the same ownership rules as
model providers:

| Class | Registered by | Visible to |
|---|---|---|
| `shared` | An administrator | Every signed-in user |
| `personal` | A user, for themselves | Only that user (administrators included) |

A target has a `name`, an `id` that is never reused, a `kind` (which
provider handles it), an optional `displayName`, `enabled`, and a `config`
object that PilotSwarm stores but never interprets: it belongs to the
provider of `kind`. Only those who may manage a target see its `config`.
`config` is not a place for secrets. All rules live in the
`cms_compute_target_*` procedures; `ComputeTargetStore` only shapes rows
and errors.

A session names its target by name at creation (`computeTarget`). The
create transaction checks that the target is shared or the owner's own,
and enabled (`cms_compute_target_assert_session`), and records the target's
id with the name. System sessions may use shared targets only. Before every
turn the worker resolves the target by that id and checks again that the
tree's owner may use it (`cms_compute_target_resolve_for_session`). A
deleted target leaves its sessions blocked; a new target with the same name
is a different target and never takes them.

## Compute providers (code)

```ts
interface ComputeProvider {
  readonly kind: string;
  readonly capabilities: {
    os: string[];                     // Node platform names
    sandboxed: boolean;
    files: "worker-local" | "shared-mount" | "provider-api" | "none";
  };
  validateTarget?(req): Promise<{ ok: true } | ComputeFailure>;           // before every bind
  bind(req): Promise<{ ok: true; host: ComputeHostRef } | ComputeFailure>; // once per (target, tree)
  connect(req): Promise<ComputeConnectResult>;                             // every turn
  release?(req): Promise<void>;                                            // once per leaving session
}
```

- Every call carries an `AbortSignal`, and the worker enforces a deadline
  (bind 5 minutes, connect 2 minutes, release 30 seconds). A provider that
  does not answer fails the call; it cannot hold a turn or a shutdown.
- `validateTarget` runs before every bind with the tree's owner: may this
  principal use what the target's config points at?
- `bind` is idempotent per (target, session tree). `connect` runs before
  every turn, possibly on another worker, and returns how to reach the
  runtime and the session's folders as the host sees them.
- A host has an `id` and an `incarnation` that changes whenever the host is
  replaced. The worker keys its client pool by address, token, host and
  incarnation (never the token itself), so a replaced host or a rotated
  token gets a fresh client, and the old one is stopped when no session
  uses it.
- Endpoints are `local` (the worker starts the runtime itself, today's
  behaviour) or `uri` (a runtime already listening). By default the worker
  accepts only loopback addresses: a provider that reaches a host elsewhere
  secures that path itself and hands back a local address. A worker can
  accept other addresses (`computeAllowNonLoopbackEndpoints`) when its
  network secures them.
- Failures use the workspace provider shape (`code`, `message`,
  `retryAfterMs`).
- `release` is called once per session that leaves a host: `ended`,
  `moved` (dehydrate), `evicted`, `shutdown`, or `failed` (bind succeeded
  but connect did not, or the host was replaced). It carries the target,
  host, session, tree and worker. Sessions of one tree share a host, so a
  provider stops it when no session uses it. A worker can crash without
  releasing, so a provider that holds costly hosts also needs its own
  expiry.
- The built-in `local` provider is always registered. Sessions without a
  target run as today. Applications add providers with `computeProviders`
  in the worker options or `worker.registerComputeProvider()`.

## Trust boundary

The runtime is untrusted: it runs model-chosen code. What crosses back to
the worker is checked there.

| Path | Rule |
|---|---|
| Model requests | The runtime's provider config carries per-session, per-binding random placeholders instead of credentials. Each pooled client has its own request handler, which serves only the sessions bound to that connection. A request must go to the session's model provider origin and path prefix, by `GET` or `POST`; then the worker swaps the placeholders for real credentials and sends it with redirects refused. Anything else is refused. WebSocket model transports are refused. |
| Session state (SessionFs) | Paths are confined to the worker's directory for that session. Only the virtual root, the runtime's own `<home>/session-state/<id>` form and relative paths are accepted. No link inside the directory is followed. One write carries at most 64 MiB. |
| Worker files named by tools | `write_artifact({fromFile})` and `read_artifact({toFile})` from a remote session may use only that session's workspace folders, and only when the provider says the host shares them with the worker (`worker-local`, `shared-mount`); otherwise none. |
| Skills and MCP servers | Not sent to a remote runtime: their configs are worker-local. |
| GitHub Copilot models | Refused on a remote target: they authenticate inside the runtime with a GitHub token. |

## One remote turn

1. The worker reads the tree's compute target from the root session's
   record, re-checks it for the tree's owner, and picks the provider for
   its `kind`.
2. Workspace providers attach the folders, as today (worker paths).
3. The compute provider binds the host and connects: endpoint plus host
   paths.
4. The worker builds or reuses a Copilot client per endpoint (the client
   pool gains an endpoint dimension). A remote client gets:
   - no GitHub token and no worker environment;
   - a request handler: every model request comes back to the worker,
     which checks it against the session's grant;
   - a SessionFs provider: session-state files live in the worker's own
     session directory, so dehydrate and hydrate are unchanged.
5. The session is created or resumed with the host's working directory and
   additional directories. Model provider credentials in the session config
   are per-session placeholders; the worker's request handler swaps them for
   the real values on each request, and refuses a request whose placeholder
   it cannot resolve.
6. The turn runs; PilotSwarm tools execute in the worker as external tools.

## Testing without a cluster: the `process` provider

`createProcessComputeProvider()` (kind `process`) runs each session tree's
runtime as a separate `copilot --headless` process on the worker's machine
and returns its `127.0.0.1` address and a fresh connection token. It is not
a sandbox. It exercises exactly the remote path a cluster provider uses, so
the plumbing can be built and tested on a laptop or in CI. The runtime gets
a scrubbed environment (its own home, `PATH`, the connection token, nothing
from the worker) and leads its own process group, so stopping it stops the
commands it started.

`test/local/compute-process-provider.test.js` drives it with the scripted
model through real workers and PostgreSQL and checks:

| Check | Result |
|---|---|
| A turn on a `process` target runs `bash` inside the separate runtime | the command sees the runtime's home, and no worker variables (`PS_TEST_DATABASE_URL`, `PG*`) |
| The runtime holds only credential placeholders | every model request still carries the real key; no placeholder reaches the model |
| Session state | written through SessionFs into the worker's own session folder (`events.jsonl`, `workspace.yaml`, `checkpoints/`) |
| A new worker with a new runtime | resumes the session from that folder; the next request carries the earlier turn |
| Stop | the worker's shutdown releases the host; no runtime process is left |
| A sub-agent | runs in its tree's runtime, though its own config names no target |
| Refusals | an unknown target is refused at create; an unknown kind fails the turn; a runtime address that is not local fails the turn and releases the host |

What the run showed about the runtime:

- It writes session files under the SessionFs root, and also names some of
  them by its own home (`<COPILOT_HOME>/session-state/<sessionId>/...`).
  The worker's SessionFs maps both to the session folder.
- It keeps a local `session-store.db` (SQLite) in its home. It is not
  needed to resume: a new runtime with an empty home resumed the session.
  The `process` provider keeps that home private and removes it with the
  host.
- A refusal at bind or connect is retried like any failed turn (15 s, then
  30 s) before the session shows the error. Unknown or disabled targets
  should fail at once; that needs a new orchestration version.

## Built on the branch

| Piece | Where |
|---|---|
| Provider interface, registry, `local` provider, endpoint → SDK connection | `packages/sdk/src/compute.ts` |
| `compute_targets` and procedures | `packages/sdk/src/migrations/compute-targets-0084.ts`, `0084_diff.md` |
| Target store; create-time check | `packages/sdk/src/compute-target-store.ts`, `cms.ts` |
| `computeTarget` on the session config | `types.ts`, `client.ts` |
| Credential placeholders, request handler, worker-backed SessionFs | `packages/sdk/src/compute-runtime.ts` |
| `process` provider (separate local runtime, for tests and as the smallest example) | `packages/sdk/src/compute-process.ts` |
| Remote client and turn wiring | `copilot-client.ts`, `session-manager.ts` |
| Tests | `test/unit/compute-providers.test.mjs`, `test/unit/compute-runtime.test.mjs`, `test/unit/compute-process.test.mjs`, `test/local/compute-targets.test.js`, `test/local/compute-process-provider.test.js` |

## Known gaps

| Gap | Note |
|---|---|
| GitHub Copilot models on a remote target | Refused for now: they authenticate inside the runtime with a GitHub token, which a remote runtime must not hold. Needs per-request auth through the worker |
| Skills and MCP servers on a remote target | Not sent: skill folders and MCP configs are worker-local (paths, commands, environment) |
| PilotSwarm tools that read host files | Work only when the worker sees the same files (`worker-local`, `shared-mount`); others need a provider file API. Other worker-path tools besides artifacts still need the same review |
| Hold-and-retry | A bind or connect failure goes through the ordinary turn retry (three tries, then an error). A transient failure should hold the turn like a workspace attach does; a permanent refusal should fail at once. Needs a new orchestration version |
| Durable bindings and cleanup | Bindings live in worker memory. A session that ends while dehydrated, or a worker crash, releases nothing; providers need their own expiry. A durable binding record with a lease, and a sweeper, would close this |
| Transport security | Non-local runtime addresses are refused by default. A provider that reaches a host elsewhere must secure the path (and authenticate the host) itself |
| Provider secrets | `config` must not hold secrets. A separate secret reference, resolved only in the worker, is not built |
| SessionFs quotas | One write is capped; total size and file count per session are not |
| Routing capability tag | Workers that can drive remote runtimes should declare a tag so older workers never run remote sessions locally |
| Admin and user surfaces | Protocol operations, management client, MCP tools and portal for registering targets and picking one at session creation |
| Turn survival across a worker crash | Depends on whether the runtime keeps a turn when its client disconnects and on `resumeSession` reattaching. Unverified |
| SessionFs path layout | Verified with the `process` provider for ordinary turns, dehydrate and resume. Not yet checked: checkpoints under compaction, large files, a Windows runtime |
| SQL tools on remote sessions | Need SessionFs SQLite support |
| Provisioning | Out of scope here: targets are assumed to exist. A compute provisioner can create hosts on demand later |
