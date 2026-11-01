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

## How compute gets registered and used

1. **An administrator registers a provider.** PilotSwarm is told which
   provider service to trust, and the provider is told how to recognize
   PilotSwarm. The provider declares its one way of being reached and what
   it can do.
2. **Someone registers a target with that provider** — an administrator for
   one everybody shares, a user for one of their own. Its name says who owns
   it (`shared/…` or `<owner>/…`), and its settings hold no secrets.
3. **PilotSwarm checks the new target once and records what it offers** —
   for example models of its own, which only a personal target may offer.
   That is what shapes the choices when a session is created.
4. **A user creates a session**: they pick the target first, then a model
   from that target's list.
5. **Each turn**: PilotSwarm re-checks that the owner may still use the
   target, asks the provider for a host, opens the connection, and the
   worker and the host prove themselves to each other before anything else
   crosses. PilotSwarm keeps a lease while it is using the host.
6. **When a session tree is done with a host, PilotSwarm says so.** The
   provider decides whether to keep it, clean it and reuse it, or replace
   it. A reused host must carry nothing over from before.

Steps 2, 4 and 5 are on this branch, minus the handshake. Step 1, the
lease, the handshake and the end-of-session notice are not built yet.

## Compute targets (data)

Migration 0084 adds `compute_targets`, with the same ownership rules as
model providers:

| Class | Registered by | Visible to |
|---|---|---|
| `shared` | An administrator | Every signed-in user |
| `personal` | A user, for themselves | Only that user (administrators included) |

### Names say who owns a target

Every target is named `<owner>/<label>`. For a target of someone's own the
owner part is their sign-in address — `alice@example.com/gpu-sandbox` —
and for one an administrator registers for everyone it is the reserved
word `shared`, as in `shared/build-pool`.

So two people can both have a target called `sandbox` without colliding,
nobody can take a name administrators need, and nobody can name a target
after someone else. PilotSwarm builds the owner part itself from whoever is
signed in; whoever registers a target supplies only the label — which lets
a provider suggest one from something it already knows is unique, such as
a machine's own name. Labels are plain: letters, numbers, dot, dash and
underscore, at most 64 characters. A registrant with no sign-in address on
record is refused rather than given an invented owner part.

Sessions always reference a target by its permanent id, so none of this
changes once a session exists. When a name is looked up, a whole name is
taken as it is, and a bare label is shorthand for the caller's own target,
falling back to the shared target of that label.

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
    offersModels?: boolean;           // can its hosts have model access of their own?
  };
  readonly transport?: "direct" | "pipe";                                  // default: direct
  openConnection?(req): Promise<Duplex>;                                   // pipe providers only
  validateTarget?(req): Promise<{ ok: true } | ComputeFailure>;           // before every bind
  bind(req): Promise<{ ok: true; host: ComputeHostRef } | ComputeFailure>; // once per (target, tree)
  connect(req): Promise<ComputeConnectResult>;                             // every turn
  describeHost?(req): Promise<ComputeAdvertisement>;                       // what the host offers
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
  host, session, tree and worker. It says PilotSwarm no longer needs the
  host, never that it should be stopped or destroyed — see "Who decides
  what happens to a host". Sessions of one tree share a host, so a host is
  only free of PilotSwarm once no session uses it. A worker can crash
  without releasing, so a provider also needs its own expiry.
- The built-in `local` provider is always registered. Sessions without a
  target run as today. Applications add providers with `computeProviders`
  in the worker options or `worker.registerComputeProvider()`.

## Transport contract

Each provider has exactly one way of being reached, declared in its own
code. A host never chooses, and a registered target never carries transport
code: code arrives with the installed provider.

| `transport` | What the provider does |
|---|---|
| `direct` (default) | Its hosts are reachable at an address. `connect` returns a `uri` endpoint and the worker connects to it itself. The provider writes no transport code at all. |
| `pipe` | The provider opens the connection itself, in `openConnection(host, signal)`. `connect` returns a `pipe` endpoint: the host's folders and whatever opaque details opening the connection needs — never an address. |

A provider that says `pipe` must have `openConnection`, and one that says
`direct` must not. The registry refuses anything else, so a provider whose
declaration and code disagree never reaches a turn.

Everything above the provider sees only a pipe: a two-way byte stream to one
host's runtime. It does not know, and must never need to know, what the pipe
is made of.

**What the pipe must guarantee** (the provider's side):

| | |
|---|---|
| Two-way | Bytes flow in both directions |
| Ordered and reliable | Nothing lost, reordered or duplicated |
| Interactive | Many round trips per turn, with output arriving as it is produced |
| Visibly broken | A broken pipe closes or errors; it never goes quiet and leaves a turn waiting |
| Pointed at one host | It reaches that host's runtime and nothing else |
| Protected end to end | Private and tamper-proof whenever what it crosses cannot be trusted. The worker cannot check this; it is the provider's work |

**What PilotSwarm guarantees** (the worker's side):

| | |
|---|---|
| One bridge per binding | Each session binding gets its own bridge, on the worker's own machine, on a port the operating system picks and nothing outside the worker is told |
| Local only | The bridge listens on this machine alone, so a bridged connection satisfies the local-addresses rule by construction |
| The token still counts | The runtime's connection token still travels inside the pipe and is still checked at the far end. Reaching the bridge grants nothing |
| One pipe per connection | A pipe is used for its own host's runtime only, and never shared between connections |
| Reconnect or fail clearly | A broken connection is replaced by a fresh pipe. A pipe that cannot be opened, or that takes too long, fails the turn with a coded error rather than hanging |
| Closed on release | The bridge and every pipe through it close when the session leaves the host, and when the worker shuts down |

The Copilot SDK can only connect to an address, so the bridge is the smallest
thing that turns a pipe into one: a loopback listener that asks the provider
for a fresh pipe per connection it accepts and joins the two. The client pool
is keyed by that address, so a replaced bridge gets a fresh client.

Reusable transport code — anything that knows how a particular kind of
connection is built — belongs in a package of its own, outside this core.

## Where providers run

A provider that really makes hosts runs as its own service, outside the
worker. An administrator registers each provider service in advance, and
PilotSwarm deals only with services it was told about. The worker reaches
any of them through a single generic connector built in once, so the worker
itself never holds the rights to create or manage hosts, and a new compute
type needs no new code in the worker. A provider service never reads
PilotSwarm's database.

Providers built into the worker stay, for tests and for cases simple enough
not to need a service of their own — the `process` provider below is one.

Because a provider service owns the hosts, it is also the natural place to
keep spare ones ready for bursts. PilotSwarm may later tell it how much
demand there is per target, as plain counts; that is not built, and the
design only leaves room for it.

None of this is in the branch yet: the connector, registration, and the
trust between PilotSwarm and a provider service are still to come.

## Who decides what happens to a host

PilotSwarm reports how it uses hosts, and nothing more. It holds a lease on
a host while it is using one and keeps renewing it; if the renewals stop —
because a worker crashed, say — the host is no longer in use. And it says
when a session tree is finished with a host, including a tree that ends
while it is not loaded in any worker.

Finished never means destroy. What happens to a host nobody needs is the
provider's decision alone: keep it, because some kinds are never taken
away; clean it and hold it ready for the next workload; or discard it and
make a fresh one, so there is still enough spare capacity.

A host may take a new workload only with nothing left over from an earlier
one — files, logins, running processes, secrets. The provider guarantees
that, and PilotSwarm does its part by using a fresh secret for every new
session tree on a host.

Leases, and the end-of-session notice for trees that end while not loaded,
are not built yet.

## Proving who is at each end

The pipe says nothing about who is on it. So before any session traffic
flows, the worker and the host prove themselves to each other, with one
handshake that PilotSwarm defines — the same for every provider and every
kind of connection, rather than something each provider invents.

Each side proves it holds a secret that only that host and PilotSwarm got
from the provider. A machine that merely claims to be the host cannot take
part, and neither can anything sitting in the middle of the connection. A
small PilotSwarm component on the host answers the handshake. The provider's
whole part is to put the secret on the host and hand the same secret to
PilotSwarm.

Open: a provider may still want more. Its platform may be able to say
something stronger about a host, which would add to the handshake and never
replace it; and a provider or a host may want to satisfy itself about
PilotSwarm in turn, rather than only that whoever is calling holds the
secret. Neither is decided, and neither is built — the handshake and the
component on the host are both still to come.

## Capabilities

A compute target advertises what it offers, and that shapes the choices a
person is given: which targets to run a session on, and which models are
available once one is chosen. The target is chosen first, the model after
it.

| Kind | Where it comes from | Changes |
|---|---|---|
| Provider capabilities | Declared in provider code; the same for every target of that kind | Only when the provider changes |
| Target capabilities | Advertised by the target itself and stored with the time it was last heard | Refreshed whenever the worker reaches the host |

**Advertised capabilities are never used to authorize anything.** They come
from a host, which is untrusted. They decide what is shown; what anyone may
do is decided where it always was — in SQL for who may use a target, and in
the worker for what a session may reach. The worker keeps only the
well-formed parts of an advertisement, bounds every field, and caps the whole
thing (16 KiB), in the worker and again in the database.

### Models a target offers itself

A target may advertise models of its own: models its host can serve with its
own model access. They appear beside PilotSwarm's catalog models, under names
of their own — `@<target>:<model>` — which cannot collide with a
`provider:model` name because a provider name never starts with `@`. A
session picks one like any other model.

Two things follow from where such a model runs:

- The host makes the call. Nothing of PilotSwarm's goes to it: no credentials,
  no provider config, and no model request routed back through the worker. A
  session on one of these models gets a client of its own with no request
  handler, kept apart from any client that carries credentials.
- PilotSwarm's budgets and credentials do not cover it. It is the host's own
  model access being spent.

**Only a personal target may offer models** — a target belonging to one
person, used by that person. A shared target never does, however it
advertises itself. That rule is enforced when the advertisement is stored,
and again in the worker before a turn runs.

### Filling the list

A probe validates a target and records what it offers: bind, connect, ask the
runtime what models it has, release. Every later connection refreshes the
answer (throttled, bounded, and never allowed to fail a turn, so a host that
cannot answer leaves the previous answer standing). A turn whose chosen model
the target no longer offers fails with `COMPUTE_HOST_MODEL_UNAVAILABLE` and
says to choose another.

## Trust boundary

The runtime is untrusted: it runs model-chosen code. What crosses back to
the worker is checked there.

| Path | Rule |
|---|---|
| Model requests | The runtime's provider config carries per-session, per-binding random placeholders instead of credentials. Each pooled client has its own request handler, which serves only the sessions bound to that connection. A request must go to the session's model provider origin and path prefix, by `GET` or `POST`; then the worker swaps the placeholders for real credentials and sends it with redirects refused. Anything else is refused. WebSocket model transports are refused. |
| Session state (SessionFs) | Paths are confined to the worker's directory for that session. Only the virtual root, the runtime's own `<home>/session-state/<id>` form and relative paths are accepted. No link inside the directory is followed. One write carries at most 64 MiB. |
| Worker files named by tools | `write_artifact({fromFile})` and `read_artifact({toFile})` from a remote session may use only that session's workspace folders, and only when the provider says the host shares them with the worker (`worker-local`, `shared-mount`); otherwise none. |
| Skills and MCP servers | Not sent to a remote runtime: their configs are worker-local. |
| GitHub Copilot models | Refused on a remote target: they authenticate inside the runtime with a GitHub token the worker holds. The exception is a model the target offers itself on a personal target, where the host signs for itself and the worker sends nothing. |

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
| Provider interface, registry, `local` provider, endpoint → SDK connection, transport rules, advertisement shaping, `@target:model` names | `packages/sdk/src/compute.ts` |
| The bridge in front of a provider that opens its own connections | `packages/sdk/src/compute-bridge.ts` |
| `compute_targets` and procedures | `packages/sdk/src/migrations/compute-targets-0084.ts`, `0084_diff.md` |
| Target store; create-time check | `packages/sdk/src/compute-target-store.ts`, `cms.ts` |
| `computeTarget` on the session config | `types.ts`, `client.ts` |
| Credential placeholders, request handler, worker-backed SessionFs | `packages/sdk/src/compute-runtime.ts` |
| `process` provider (separate local runtime, for tests and as the smallest example) | `packages/sdk/src/compute-process.ts` |
| Remote client and turn wiring | `copilot-client.ts`, `session-manager.ts` |
| Probe, advertisement refresh, model-of-the-target turns | `session-manager.ts` |
| Model options for a target | `management-client.ts`, `compute-target-store.ts` |
| Tests | `test/unit/compute-providers.test.mjs`, `test/unit/compute-runtime.test.mjs`, `test/unit/compute-process.test.mjs`, `test/unit/compute-capabilities.test.mjs`, `test/unit/compute-bridge.test.mjs`, `test/local/compute-targets.test.js`, `test/local/compute-process-provider.test.js`, `test/local/compute-bridge-provider.test.js` |

## Known gaps

| Gap | Note |
|---|---|
| GitHub Copilot models on a remote target | Refused for now: they authenticate inside the runtime with a GitHub token the worker holds, which a remote runtime must not get. Needs per-request auth through the worker. A model the target offers itself is the exception and is allowed |
| A turn on a model the target offers itself | **Unverified end to end.** The plumbing is built and tested — the name, the rules about which targets may offer models, the advertisement, the refusal when a model is withdrawn, and a client with no credentials and no request handler. What has not been run is a turn against a host that really has model access of its own, which needs such a host. Until then, treat it as designed and wired, not proven |
| Who sees a target's advertisement | It is shown wherever the target is, which for a personal target is its owner alone. There is no review step: a host's own description of itself is shown as it stands (shaped and bounded), with the time it was last heard |
| Bridge callers | The bridge is on loopback, on a port nothing outside the worker is told, and the runtime's token is still checked at the far end — but the bridge itself does not identify the process connecting to it. That is the same exposure a runtime's own loopback port already has. A stronger local check needs a transport the SDK can carry a handshake over |
| Transport packages | Nothing reusable is built. Anything that knows how a particular kind of connection is made belongs outside this core; only the seam is here |
| Provider services | The connector the worker would use to reach a registered provider service, the registration itself, and the trust between PilotSwarm and a provider are not built. Everything on the branch is an in-worker provider |
| Demand hints | Telling a provider service how much demand there is per target, so it can keep spare hosts ready, is deferred. The design leaves room for it |
| The handshake and the component on the host | The mutual handshake between worker and host, and the small PilotSwarm component on the host that answers it, are not built. Today a connection is trusted because of where it goes and the runtime's own token, not because the two ends proved themselves |
| Skills and MCP servers on a remote target | Not sent: skill folders and MCP configs are worker-local (paths, commands, environment) |
| PilotSwarm tools that read host files | Work only when the worker sees the same files (`worker-local`, `shared-mount`); others need a provider file API. Other worker-path tools besides artifacts still need the same review |
| Clear reasons when compute can't be used | Today every bind or connect failure goes through the ordinary turn retry (three tries, then an error), whatever caused it. Decided for a follow-up: a failure retrying cannot fix — the target was removed or paused, or the person lost access — stops the turn at once and says why; one that may pass — the host is offline, there is no capacity, the provider cannot be reached — keeps the retries but says what is happening and what to do about it. Waiting patiently for a host and resuming on its own may come later. It changes how turns behave, so it needs its own change |
| Leases, and the end-of-session notice for sessions that end while not loaded | Bindings live in worker memory, so a session that ends while not loaded anywhere, or a worker that crashes, tells the provider nothing and providers need their own expiry. The lease PilotSwarm renews while it uses a host, and the notice that a session tree is finished with one, would close this |
| Transport security | Non-local runtime addresses are refused by default. A provider that reaches a host elsewhere must secure the path (and authenticate the host) itself, whether it hands back a local address or opens the connection in its own code |
| Provider secrets | `config` must not hold secrets. A separate secret reference, resolved only in the worker, is not built |
| SessionFs quotas | One write is capped; total size and file count per session are not |
| Routing capability tag | Workers that can drive remote runtimes should declare a tag so older workers never run remote sessions locally |
| Admin and user surfaces | Protocol operations, MCP tools and portal for registering targets, probing one, and picking a target and then a model at session creation. The direct management client can list a target's model options today; web mode cannot |
| Turn survival across a worker crash | Depends on whether the runtime keeps a turn when its client disconnects and on `resumeSession` reattaching. Unverified |
| SessionFs path layout | Verified with the `process` provider for ordinary turns, dehydrate and resume. Not yet checked: checkpoints under compaction, large files, a Windows runtime |
| SQL tools on remote sessions | Need SessionFs SQLite support |
| Provisioning | Out of scope here: targets are assumed to exist. A compute provisioner can create hosts on demand later |
