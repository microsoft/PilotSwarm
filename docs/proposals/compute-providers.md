# Compute providers: run a session's agent somewhere other than the worker

**Status:** exploration on a feature branch, draft PR for discussion. Built
on the branch: targets and names, the provider interface and its connection
contract, the bridge, the handshake and the host component, the remote turn
and its trust boundary, the host's idle shutdown, and the management
surfaces. Three pieces of the design were taken out of this change
to keep it easy to review — clear failure reasons, running providers as
registered services, and a target's own capabilities and models. They are
designed in section 12 (Future work) and the code for them is on the
exploration branch history of this PR.

**Still to be built on this branch:** skills and MCP servers for a remote
session. A session on a host does not yet get the skill folders and MCP
servers a deployment configures, so it is not at parity with a session that
runs on the worker. That gap is part of this change, not future work, and
its design is being written separately. **Date:** 2026-11-02, revision 4.
Revision 1 restructured the proposal to match
`docs/proposals/session-workspaces.md`: a high-level design for a human
reader first, then numbered sections. Revision 2 records the built behaviour
after the parts were brought together. Revision 3 defers clear failure
reasons to a follow-up that needs no orchestration change. Revision 4 moves
provider services and target capabilities/host models into Future work, so
this change is only the provider seam, the connection and the targets.

A session's agent runs on a host chosen for that session, not inside the
worker that serves the turn. The worker stays the trusted side: it keeps the
orchestration, the PilotSwarm tools, the model keys and the session's history.
The agent runtime runs on a separate host and is driven over a connection
whose two ends prove who they are. A **compute provider** supplies the hosts:
today it is a plug-in loaded into the worker, and running providers as
registered services outside the worker is future work (section 12). Nothing
in the design names a cloud, a platform, a network product or a kind of
kind of host; a provider can front a pool of hosts or a sandbox service.

## High-level design

**The problem.** Every session's agent runtime — the part that runs
model-chosen commands — runs as a child process of the worker that serves the
turn. So model-chosen code runs next to the worker's database access and its
credentials. And every session runs on the same kind of machine, whatever
isolation or tools it needs.

**The solution.** Keep the worker as the trusted side, and let the agent run
on a separate host chosen per session. A compute provider supplies hosts. The
worker drives the agent over a connection; everything the agent sends back is
checked by the worker.

```mermaid
flowchart LR
  subgraph T["Trusted: PilotSwarm"]
    DB[("CMS and orchestration")]
    W["Worker<br/>orchestration, PilotSwarm tools,<br/>model keys, session state"]
  end
  P["Compute provider<br/>(worker plug-in)"]
  subgraph U["Untrusted: hosts"]
    H1["Host<br/>agent runtime"]
    H2["Host<br/>agent runtime"]
  end
  W --- DB
  W -- "get / release a host" --> P
  P -- "creates or pairs" --> H1
  P -. "creates or pairs" .-> H2
  W == "connection: both ends prove who they are,<br/>then tool calls, results, model requests" ==> H1
```

> **Rule:** an agent never runs where the CMS or orchestration state can be
> reached. Commands and results cross that line; credentials and database
> access never do.

The main ideas:

- **A compute target** is a registered place to run: shared (`shared/<label>`)
  or someone's own (`<owner>/<label>`). A session picks one when it is created
  and keeps it.
- **A compute provider** knows one kind of compute. It gets a host ready, says
  how to reach it, and decides what happens to the host when PilotSwarm is
  done with it.
- **One host per session tree.** A parent session and its sub-agents share a
  host.
- **The connection is just a pipe.** Each provider has one way of being
  reached. PilotSwarm needs only a two-way, ordered, reliable connection and
  never learns what it is made of.
- **Both ends prove who they are** before anything else crosses, with one
  handshake PilotSwarm defines for every provider.
- **The worker keeps what must be trusted:** orchestration, PilotSwarm tools,
  PilotSwarm's model keys and the session's history.

**One turn**

```text
On the worker that runs the turn:
1. Load the conversation (as today).
2. Re-check that the session's owner may still use its target.
3. Ask the provider for the tree's host.
4. Open the connection; worker and host prove who they are.
5. Start or resume the agent on the host. Its model requests come back to
   the worker, which adds PilotSwarm's real keys; its session files are
   written to the worker's folder for that session.
6. The model runs the turn. PilotSwarm tools run in the worker.

If step 2, 3 or 4 fails, the model is not called and the turn fails with
a reason. The agent never falls back to running on the worker.
```

**Registering compute**

| Who | Does what |
|---|---|
| Whoever runs the worker | Loads a compute provider into it (`computeProviders`, or `registerComputeProvider`). Running providers as registered services is future work (section 12). |
| An administrator | Registers a target (`shared/<label>`). |
| A user creating a session | Picks the target, then a model. |

**Who owns what**

| Owner | Owns |
|---|---|
| PilotSwarm core | Targets and who may use them. The turn steps above. The connection bridge and the handshake. Model-key handling and session state. It has no cloud, network-product or host-type code. |
| A compute provider | Getting, cleaning, reusing or discarding hosts. Its one way of being reached. Putting the handshake secret on its hosts. Any spare hosts kept ready for bursts. |
| The deployment | The network between workers and hosts. |

**What does not change**

- A session without a target runs exactly as today: same tools, same prompt,
  same steps. Only sessions that name a target see anything new.
- No orchestration change. Migration 0084 is new and additive.

**Main choices**

| Chosen | Instead of | Why |
|---|---|---|
| Everything above the provider sees only a pipe | Core knowing the medium | The connection can change without the control plane changing. |
| One handshake defined by PilotSwarm | Each provider's own trust scheme | The worker checks every host the same way itself. |
| The provider decides a host's fate | PilotSwarm deleting hosts | Some hosts are never removed; others are cleaned and reused. Only the provider knows. |
| Names that include the owner | Free-form global names | Names never collide between people, and nobody can take a name administrators need. |

For details, see section 3 (the parts and who owns what), 4 (the PilotSwarm
design), 5 (the `process` test provider), 6 (walkthroughs), 9 (decisions
and open items), 11 (what is built) and 12 (future work).

## Contents

1. [Goal and scenarios](#1-goal-and-scenarios)
2. [Terms](#2-terms)
3. [Architecture and who owns what](#3-architecture-and-who-owns-what)
4. [PilotSwarm design](#4-pilotswarm-design)
5. [The `process` provider: the test provider](#5-the-process-provider-the-test-provider)
6. [Walkthroughs](#6-walkthroughs)
7. [Corner cases](#7-corner-cases)
8. [Test plan](#8-test-plan)
9. [Decisions, verified facts and open items](#9-decisions-verified-facts-and-open-items)
10. [Implementation map](#10-implementation-map)
11. [Delivery plan](#11-delivery-plan)
12. [Future work](#12-future-work)

## 1. Goal and scenarios

The one rule the whole design serves:

> **Invariant:** an agent runtime never runs in the same place as anything
> that can reach the CMS or the orchestration state. Commands and results may
> cross that line; database credentials and routes to the database never do.

| # | Scenario |
|---|---|
| S1 | A session runs its agent on a host that is not the worker, chosen when the session is created and kept for the life of the session tree. |
| S2 | A sub-agent runs on the same host as its parent. One host serves a whole session tree. |
| S3 | A session moves to another worker and keeps going. The next worker reaches the same host, or is given a fresh one, without losing the conversation. |
| S4 | An administrator registers compute everyone shares. |
| S5 | A target says what it offers. That shapes the targets a person is shown. (Future work, section 12.) |
| S6 | A new kind of compute is added without changing the worker. (Future work, section 12: today a provider is a plug-in loaded into the worker.) |
| S7 | When compute cannot be used, the person is told why, and a reason that retrying cannot fix stops the turn at once. |
| S8 | Existing sessions, with no target, run exactly as they do today. |

Not in scope for this work: creating hosts on demand (provisioning); a session
whose sub-agents span more than one target; isolating session-state files
between tenants beyond today's confinement.

Accepted, and stated here so nobody expects otherwise:

- The agent runtime is untrusted: it runs model-chosen code. Everything it
  sends back to the worker is checked in the worker.
- A worker can crash without telling a provider it is finished with a host, so
  a host must be able to end itself. The PilotSwarm component on it does that
  after a set time with no connection.
- Today a connection is trusted because of where it goes and the runtime's own
  token. The mutual handshake (section 4.5) is what makes
  each end prove itself.

## 2. Terms

Defined before use, in the order the rest of the document needs them.

| Term | Meaning |
|---|---|
| Worker | The trusted PilotSwarm process that serves a turn. It holds the orchestration, the PilotSwarm tools, the model keys and the session's history. |
| Agent runtime | The part that runs the agent loop and the model-chosen commands (such as a shell). Today it runs in the worker; this design lets it run on a host. Also "the runtime". |
| Compute type | A kind of place a runtime can run. |
| Compute provider | The code for one compute type, named by its `kind`. It gets a host ready and says how to reach it. |
| Compute target | A registered instance of a compute type, stored in the CMS. A session picks one. Named `shared/<label>`. |
| Host | The concrete place a session tree's runtime is bound to. Has an `id` and an `incarnation` that changes when it is replaced. |
| Host component | A small PilotSwarm program on the host. It answers the handshake, then forwards the connection to the runtime's local port. |
| Binding | One (target, session tree) pairing to a host. It carries a per-binding secret. |
| Idle shutdown | The host component ending itself after a set time with no connection, which is what frees a host nobody came back to. |
| Pipe | A two-way, ordered, reliable byte stream to one host's runtime. Everything above the provider sees only a pipe. |
| Transport | How a provider's pipe is made: `direct` (the host is reachable at an address) or `pipe` (the provider opens the connection itself). Exactly one per provider. |
| Bridge | A loopback listener the worker runs, one per binding. It turns a provider-opened pipe into an address the runtime connection can dial. |
| Handshake | One mutual proof PilotSwarm defines, run on every remote connection before any session traffic. Each end proves it holds the binding's secret. |
| Endpoint | What `connect` returns: `uri` (an address the worker dials) or `pipe` (open the connection through the provider). |
| Capabilities | What a provider says about the hosts it makes. Fixed in provider code. |
| Placeholder credentials | Per-session, per-binding random stand-ins the runtime holds instead of real model keys. The worker swaps them for real keys on each request. |
| SessionFs | The session-state file surface the runtime reads and writes. It is confined to the worker's folder for that session. |
| Session tree | A root session and all of its sub-agents. It runs on one target, fixed at the root. |
| CMS | The session catalog database: sessions, events, and the new `compute_targets` table. |

## 3. Architecture and who owns what

```mermaid
flowchart LR
  subgraph T["Trusted: PilotSwarm worker"]
    ORCH["Orchestration + PilotSwarm tools"]
    CP["Compute provider<br/>(plug-in)"]
    BR["Bridge (loopback, one per binding)"]
    ORCH --- CP
  end
  subgraph HOST["Untrusted host"]
    HCOMP["Host component"]
    RT["Agent runtime"]
    HCOMP --- RT
  end
  CP -- "creates or pairs" --> HOST
  BR == "handshake, then pass-through" ==> HCOMP
  CP -- "says where to reach the host" --> BR
  HCOMP -- "forward to local port" --> RT
  RT -- "model requests, tool calls,<br/>session-state reads/writes" --> ORCH
```

Every arrow is a call the design makes. A `direct` provider's host is reached
at an address the worker dials; a `pipe` provider's connection is opened by the
provider and joined through the bridge. Either way the host component answers
the handshake first, then forwards to the runtime. The runtime's model
requests and session-state access come back to the worker, which checks them.

PilotSwarm core has no cloud, network-product or host-type code. In the split
below, "the provider" is the code for one compute type, and "the deployment"
is everything the operator runs: the network between workers and hosts.

| Concern | Core supplies | The provider / deployment supplies | Where they meet |
|---|---|---|---|
| Adding a kind of compute | A provider interface and a registry the worker loads plug-ins into (**built**). Registering providers as services outside the worker is future work (section 12) | A provider object with a `kind` and capabilities | `computeProviders` / `registerComputeProvider` |
| Registering a place to run | The `compute_targets` table, owner-qualified names, create/update/enable/disable/delete, resolve (**built**) | A `config` object the provider understands (no secrets) | `cms_compute_target_*` procedures |
| Getting a host for a tree | `bind` once per (target, tree), `connect` every turn, with deadlines (**built**) | Readying a host and saying how to reach it | `bind(req)`, `connect(req)` |
| Reaching the host | A bridge per host on the worker's machine, in front of every remote runtime; PilotSwarm opens every connection itself (**built**) | An address the worker can reach | the endpoint `connect` returns |
| Proving each end | One mutual handshake on every remote connection; a host component that answers it (**built**) | Putting the per-binding secret on the host; running the host component in front of the runtime | the handshake frames |
| Model requests | Placeholder credentials in the runtime; a per-connection handler that swaps them for real keys and refuses anything else (**built**) | Nothing; the provider never sees a key | the request handler |
| Session-state files | SessionFs confined to the worker's session folder (**built**) | `files` capability says whether the host shares the worker's files | the SessionFs provider |
| Finishing with a host | `release` per leaving session, as a hint; the host component's idle shutdown as the backstop (**built**) | Running the runtime under the host component; deciding the host's fate | `release(req)`, the idle timeout |
| Failures | One shape for every compute error (`CODE: message`); a failure goes through the ordinary turn retry (**built**). Clear reasons that stop a turn at once are future work (section 12) | A code, a message and an optional retry hint | the `ComputeFailure` shape |
| Management surfaces | List, create, update, enable/disable and delete targets, across the client, Web API and MCP (**built**) | Nothing | the management client and API |

How the two sides work together, end to end:

```text
Register
 1. [operator -> worker]  Load a compute provider into the worker, which
                      declares its kind and capabilities.
 2. [admin/user -> core]  Register a target of that kind.
Create and run
 3. [user -> core]    Create a session naming the target. Core records the
                      target's id.
 4. [core -> provider]  Each turn: re-check the owner may use the target; bind
                      (once per tree) and connect.
 5. [core <-> host]   Open the connection through the host's bridge; the
                      handshake proves both ends; then the runtime runs the turn
                      and its model requests come back to the worker.
Finish
 6. [core -> provider]  The session leaves a worker: release, as a hint. A host
                      nobody connects to ends itself. The provider keeps, cleans
                      or discards it.
```

## 4. PilotSwarm design

### 4.1 Targets and names

Migration 0084 adds `compute_targets`. An administrator registers a target;
every signed-in user can run a session on it. **(built)**

Every target is named `<owner>/<label>`, and the owner part is the reserved
word `shared`, as in `shared/build-pool`. PilotSwarm builds that part itself;
whoever registers a target supplies only the label. Labels are plain: letters,
numbers, dot, dash and underscore, at most 64 characters. Keeping the owner
part in the name now means a later change can add targets with another owner
without renaming anything. Personal compute targets will be supported in a
later change.

A target has a `name`, an `id` that is never reused, a `kind` (which provider
handles it), an optional `displayName`, `enabled`, and a `config` object that
PilotSwarm stores but never interprets. Only those who may manage a target see
its `config`. **`config` is not a place for secrets** — a hash such as a
pairing-code hash is allowed, a credential is not; providers get their
credentials from the deployment. All rules live in the `cms_compute_target_*`
procedures; the store only shapes rows and errors.

A session names its target at creation (`computeTarget`). The create
transaction checks the target exists and is enabled, and records the target's
id with the name. Before every turn the worker resolves the target by that id
and checks again that it is still there and still enabled. A deleted target
leaves its sessions blocked; a new target with the same name is a different
target and never takes them. When a name is looked up, a whole
`<owner>/<label>` is taken as it is, and a bare label is shorthand for the
shared target of that label.

### 4.2 The provider interface

A provider is the code for one compute type, loaded into the worker as a
plug-in. **(built)**

```ts
interface ComputeProvider {
  readonly kind: string;
  readonly capabilities: {
    files: "worker-local" | "shared-mount" | "provider-api" | "none";
  };
  validateTarget?(req): Promise<{ ok: true } | ComputeFailure>;           // before every bind
  bind(req): Promise<{ ok: true; host: ComputeHostRef } | ComputeFailure>; // once per (target, tree)
  connect(req): Promise<ComputeConnectResult>;                             // every turn
  release?(req): Promise<void>;                                            // once per leaving session
}
```

- Every call carries an `AbortSignal`, and the worker enforces a deadline
  (bind 5 minutes, connect 2 minutes, release 30 seconds). A provider that does
  not answer fails the call; it cannot hold a turn or a shutdown.
- `validateTarget` asks, for the tree's owner: may this principal use what the
  target's config points at? It runs before every bind.
- `bind` is idempotent per (target, session tree). `connect` runs before every
  turn, possibly on another worker, and returns how to reach the runtime and
  the session's folders as the host sees them.
- A host has an `id` and an `incarnation` that changes when the host is
  replaced. The worker keys its connection pool by address, host and
  incarnation, so a replaced host gets a fresh connection and the old one is
  stopped when no session uses it.
- An endpoint is `uri` (a runtime already listening, which the worker dials) or
  `pipe` (opened through the provider). By default the worker dials only
  loopback addresses: a provider that reaches a host elsewhere secures that
  path itself. A worker can accept other addresses only when its network
  secures them.
- The `process` provider (section 5) is the test provider the SDK uses to
  exercise this path; it is internal and never registered by default.
  Sessions without a target run as today. Applications add providers in the
  worker options (`computeProviders`) or at runtime
  (`registerComputeProvider`). Running a provider as a registered service,
  outside the worker, is future work (section 12).

### 4.3 Provider capabilities

A provider declares, in its own code, one thing about its hosts: how the
worker's file tools reach them. It is the same for every target of that kind
and never sent by a host. **(built)**

| Field | Meaning |
|---|---|
| `files` | How PilotSwarm tools in the worker reach the host's files: `worker-local`, `shared-mount`, `provider-api` or `none` |

That is the only one because it is the only one PilotSwarm acts on: artifact
file tools that name worker files are allowed for a remote session only when
the provider says the host shares those files with the worker. Descriptive
fields that nothing reads — which operating systems a provider's hosts run,
whether a host is an isolation boundary — were left out rather than carried
unused; a provider that needs to say more can say it where it is used.

**Not in this change.** A target saying what it offers — its own capabilities,
refreshed as the worker reaches it — and a target offering models of its own
are future work (section 12). Until then a target carries no advertisement,
and every session picks a model from PilotSwarm's own catalog.

### 4.4 The connection contract and the bridge

Every host is reached at an address. `connect` returns a `uri` endpoint and
PilotSwarm opens the connection itself, so no provider carries transport code
and a registered target never carries any either. **(built)**

A provider written against an earlier interface, where it could open the
connection in its own code, is refused where it is registered rather than
accepted and then never asked to open one.

Hosts that cannot be dialled — a host that can only reach outwards — are left
for later (section 12).

Everything above the provider sees only a pipe: a two-way byte stream to one
host's runtime. It does not know, and must never need to know, what the pipe is
made of.

**What the connection must guarantee** (the provider's side):

| | |
|---|---|
| Two-way | Bytes flow in both directions |
| Ordered and reliable | Nothing lost, reordered or duplicated |
| Interactive | Many round trips per turn, output arriving as it is produced |
| Visibly broken | A broken pipe closes or errors; it never goes quiet and leaves a turn waiting |
| Pointed at one host | It reaches that host's runtime and nothing else |
| Protected end to end | Private and tamper-proof whenever what it crosses cannot be trusted. PilotSwarm does not encrypt this connection and cannot check that anything else does; it is the provider's and the deployment's work. See section 4.5 and section 12 |

**What PilotSwarm guarantees** (the worker's side):

| | |
|---|---|
| One bridge per host | Each host of a session tree gets one bridge, on the worker's own machine, on a port the operating system picks and nothing outside the worker is told. The sessions of a tree share a host, so they share its bridge, its address and its pooled runtime connection — a bridge per session would open a second control connection into one runtime |
| Nothing unproven passes | Every pipe the bridge opens is handshaken (section 4.5) before it is joined to anything. A host that cannot prove itself never sees a byte of the turn |
| Local only | The bridge listens on this machine alone, so a bridged connection meets the loopback rule by construction |
| The token is required | The bridge serves whoever connects to it on this machine, so the runtime's own connection token is what makes reaching it worth nothing. A remote endpoint without a token is refused: a session that runs on the worker is model-chosen code on the same machine, and without a token it could drive another session's runtime |
| One pipe per connection | A pipe serves its own host's runtime only, never shared between connections |
| Reconnect or fail clearly | A broken connection is replaced by a fresh pipe. A pipe that cannot be opened, or that takes too long, fails the turn with a clear reason rather than hanging |
| Closed on release | The bridge and every pipe through it close when the session leaves the host and when the worker shuts down |

The runtime connection can only dial an address, so the bridge is the smallest
thing that turns a pipe into one: a loopback listener that asks for a fresh
pipe per connection, proves both ends, and joins the two. Every runtime that is
not the worker's own child process goes through it.

### 4.5 The handshake and the host component

The pipe says nothing about who is on it. So before any session traffic flows,
the worker and the host prove themselves to each other, with one handshake
PilotSwarm defines — the same for every provider and every kind of connection.
**(built)**

- **Per-binding secret.** The provider's `connect` returns a `bindingId` and a
  random `secret`, at least 32 bytes, fresh for every new binding. It is never
  logged, never stored in the CMS, and kept only in worker memory for the
  binding. Providers must never reuse it across trees. A remote endpoint that
  arrives without one cannot be used: the worker refuses it rather than
  connecting to a host it would have no way of recognizing.
- **The proof.** The worker sends a hello with the protocol version, the
  `bindingId` and a worker nonce. The host answers with a host nonce and a
  proof over both nonces and the `bindingId`. The worker verifies, answers with
  its own proof, and the host verifies. Then the stream is a plain pass-through
  to the runtime. Each side's proof is over a string that names which side made
  it, so neither can be replayed as the other. Frames are length-prefixed and
  size-bounded, with a deadline; comparisons are constant-time; the host
  remembers the worker nonces it has answered and refuses a repeat, so a
  recorded exchange is worthless. Any failure closes the connection, and the
  turn fails with a "handshake failed" reason (section 4.10).
- **The host component.** A small PilotSwarm program runs on the host, in front
  of the runtime. It answers the handshake, then forwards the stream to the
  runtime's local port, and reaches nothing else. It serves exactly one binding
  and refuses any other. It listens for the worker's side, so a host must be
  one the worker can reach at an address. It ships in the SDK as a function and
  as a command, and the `process` test provider runs it in front of its
  runtime, so the tests do the real handshake. A provider's `connect` therefore
  returns the host component's address, never the runtime's own port.
- **The runtime token still counts.** Inside the tunnel, the runtime's own
  connection token is still used. The handshake proves the two ends; the token
  still guards the runtime.

A machine that merely claims to be the host cannot take part.

**What the handshake does not do.** It proves who is at each end of the
connection. It does not protect what crosses it: after `ok` the stream is a
plain pass-through, with no key derived from the exchange and nothing bound to
the channel. A party that can sit in the middle of the connection and relay
the four frames can then read or change everything that follows — the
runtime's token, the prompts, the tool results. The host also answers a hello
before the worker has proved anything, which is what makes relaying them
possible at all. So the network between a worker and its hosts must be private
or otherwise protected; PilotSwarm does not encrypt it and cannot check that
anything else does. Encrypting it is designed in section 12.

The provider's whole part is to put the secret on the host and hand the same
secret to PilotSwarm; a reserved, ignored version field leaves room for
provider extras later (see section 9, open items), which would add to the
handshake and never replace it.

### 4.6 Every turn of a remote session

**(built)**

1. The worker reads the tree's compute target from the root session's record,
   re-checks it for the tree's owner, and picks the provider for its `kind`.
2. The session's folders are made ready as today (worker paths).
3. The compute provider binds the host (once per tree) and connects: an
   endpoint plus the host's folder paths.
4. The connection is opened through the host's bridge — a connection to the
   host's address — and the handshake proves both ends before anything of the
   turn crosses. The
   first connection of a binding is proved before a prompt or a model request
   is sent, so a host that cannot be reached or cannot be recognized fails the
   turn where compute failures are named.
5. The worker builds or reuses a runtime connection per endpoint. A remote
   connection gets no worker environment and no model keys; instead it gets:
   - a request handler: every model request comes back to the worker, which
     checks it against the session's grant and swaps placeholders for real
     keys;
   - a SessionFs provider: session-state files live in the worker's own session
     folder, so dehydrate and hydrate are unchanged.
6. The session is created or resumed with the host's working directory. The
   model runs the turn; PilotSwarm tools run in the worker as external tools.

The trust boundary, concern by concern:

| Path | Rule |
|---|---|
| Model requests | The runtime holds per-session, per-binding placeholders, not keys. Each pooled connection has its own request handler, serving only its sessions. A request must go to the session's model origin and path prefix, by `GET` or `POST`; the worker swaps placeholders for real keys and sends it with redirects refused. Anything else is refused. |
| Session state (SessionFs) | Confined to the worker's folder for that session. Only the virtual root, the runtime's own session-state form and relative paths are accepted; no link inside is followed; one write carries at most 64 MiB. |
| Folders mounted on a host | A provider whose `files` capability says it mounts the session's folders must mount only that session's own folders, with access control on the file server, so a host can never reach another session's or another person's folders. PilotSwarm states the rule and cannot enforce it. |
| Worker files named by tools | Any tool that names a worker path from a remote session — the artifact file tools, and loading an agent or skill by path — may use only that session's own workspace folders, and only when the provider says the host shares them with the worker; otherwise none. For those sessions a path is resolved before it is checked, so a link inside a folder that points out of it is refused. A session that runs on the worker is unchanged. |
| Skills and MCP servers | Not yet sent to a remote runtime: their configs are worker-local. Giving a remote session the same skills and MCP servers as one on the worker is part of this change and still to be built on this branch. |
| Runtime-authenticated models | A model that signs inside the runtime with a credential the worker holds is refused on a remote target. |

### 4.7 Where a provider runs

Today a compute provider is a plug-in loaded into the worker: the application
passes it in the worker options, or registers it at runtime, and the registry
holds one provider per `kind`. A kind with no provider on this worker fails
the turn with a clear code rather than silently running locally. **(built)**

That is enough for the `process` test provider and for a deployment that
is happy to ship provider code in its workers. It is not enough for a provider
that needs rights on whatever it makes hosts out of, or for a third party's
provider: those should run as their own service, registered by an
administrator, and be reached through one generic connector so the worker
holds neither the code nor the rights. That is designed and was built on the
exploration branch, and is **future work** — see section 12.

### 4.8 Turning it on: a default target, and requiring compute

The rule this design serves — an agent never runs where the CMS and the
orchestration can be reached — holds for a session that has a compute target.
It does not hold for a session that has none, and nothing so far stopped a
deployment having both. Two settings close that, in two stages. Both are off
by default, so an existing deployment and local development are unchanged.
**(built)**

| Setting | What it does |
|---|---|
| A default compute target | A new root session that names no target is given this one, as `shared/<label>`. It is resolved and recorded at creation exactly as a named target is, so the per-turn re-check is unchanged, and sub-agents keep inheriting their tree's target. System sessions get it too. |
| Require compute | The worker refuses to run an agent runtime as its own child process. A session with no target, and no default, fails its turn with `COMPUTE_REQUIRED` before a runtime is started or a prompt moves. A target whose provider runs the runtime on the worker is refused the same way: what matters is where the agent ends up, not whether a target was named. |

Whether a session has a target is read from its own record, never from
anything the agent can set.

**The two stages.** With require-compute off, the deployment is in mixed mode:
some sessions run on hosts, some on the worker, and the gaps in section 12.10
apply. With it on, every session's agent runs where the CMS and the
orchestration cannot be reached, which is when the invariant actually holds.
Removing the worker-local path altogether — so there is no mode to be in — is
section 12.11.

**What this does not cover.** Three helpers run a model over text without an
agent: generating a session title, listing models, and distilling a transcript
when context is regenerated. They run no tools, start no shell and read no
files on a model's instruction, so they are not agents and the policy leaves
them alone; refusing them would break titles and context regeneration for no
gain in where agents run. What they do carry is content: for a remote session
the transcript came from an untrusted host, so an injection there could colour
a title or a summary. It cannot call a tool. They must stay tool-free.

### 4.9 Host lifecycle: idle shutdown and reuse

PilotSwarm says when it is finished with a host, and the host looks after
itself. **(built)**

- **Release.** `release` is called once per session that leaves a host:
  ended, moved (dehydrate), evicted, shutdown, or failed. Sessions of one tree
  share a host, so a host is free of PilotSwarm only once no session uses it.
  Release means PilotSwarm no longer needs the host for that session tree; it
  never means destroy.
- **Release is a hint.** It may never arrive. A worker can crash, a session can
  move, a network can go away. A provider must never wait for it to know a host
  is free.
- **Idle shutdown.** The host component ends itself after a set time with no
  connection at all — none proved, and none part-way through proving itself.
  Thirty minutes by default; the clock starts when the component does, so a
  host nobody ever reaches goes away too. That clock runs on the host, so it
  keeps running whatever happens on the worker's side, which is what makes it
  the backstop a hint cannot be. A warm session holds its connection open, so a
  host in use is never touched.
- **The runtime goes with the component.** A provider should run the runtime
  under the host component — as its child, for example — so that the
  component's exit ends the whole host rather than leaving a runtime behind
  with nothing in front of it. The `process` test provider does exactly this.
- **A session whose host has gone.** Nothing special happens: its next turn
  binds again and the provider gives it a host. The conversation is in the
  worker's own storage, so it carries on where it left off. What is lost is
  anything that lived only on the old host — see section 12.
- **The provider decides the host's fate.** Keep it, because some kinds are
  never taken away; clean it and hold it ready for the next workload; or
  discard it and make a fresh one, to keep spare capacity. Only the provider
  knows.
- **The reuse rule.** A host may take a new workload only with nothing left
  over from an earlier one — files, logins, running processes, secrets. The
  provider guarantees that, and PilotSwarm does its part by using a fresh
  handshake secret for every new binding on a host.

PilotSwarm records no host bindings of its own. Telling a provider exactly when
a tree is finished, rather than letting a timeout do it, is designed in section
12.

### 4.10 Failures

Every compute failure carries a `code`, a human `message`, and an optional
`retryAfterMs`. The worker builds every compute error it raises through one
helper, so the line a turn carries is always `CODE: message`. **(built)**

A compute failure then goes through the ordinary turn retry, like any failed
turn: three attempts over about 45 seconds, then the session shows the error.
That affects only sessions that use a compute target.

**Left out on purpose: clear reasons.** Separating failures that retrying
cannot fix from ones that may pass, and stopping the first kind at once with a
clear reason, was left out to keep this work small. See section 12.

### 4.11 APIs, events and errors

Compute targets are managed through the management client and the Web API,
the way model providers are. **(built)**

| Surface area | Operations |
|---|---|
| List and manage targets | List the targets; create (admin); update; enable/disable; delete |
| Create a session | The management client and the Web API accept `computeTarget` |
| Audit | Every mutation is audited the way provider mutations are |

Managing targets needs the fleet-admin right and lives under the admin path.
Managing targets from MCP and
the CLI, and choosing one in the portal and the TUI, are future work (section
12), as are checking a target on a worker and listing the models a target
offers itself. The API reference docs are updated alongside; this proposal is
not that reference.

### 4.12 Compatibility

The design is additive. A session without a target runs exactly as today: the
runtime runs in the worker, with the same tools, the same prompt and the same
steps. Migration 0084 only adds a table and its procedures; it changes no
existing row. It adds no orchestration version. There is no feature flag: the new
behaviour appears only for a session that names a target.

## 5. The `process` provider: the test provider

`createProcessComputeProvider()` (kind `process`) runs each session tree's
runtime as a separate local process on the worker's machine and returns its
loopback address and a fresh connection token. **(built)**

It is the **test provider**: it exists so the remote path can be exercised on
a laptop and in CI, and as the smallest readable example of a provider. It is
internal to the SDK — not exported from the package, not registered by
default — and it is not a sandbox. A deployment that wants compute brings a
provider of its own.

It exercises exactly the remote path a real provider uses. The runtime gets a
scrubbed environment — its own home, a `PATH`, the connection token, nothing
from the worker — and leads its own process group, so stopping it stops the
commands it started. It starts the host component (section 4.5) in front of
its runtime, so tests run the real handshake.

A local test drives it through real workers and PostgreSQL and checks:

| Check | Result |
|---|---|
| A turn on a `process` target runs a shell inside the separate runtime | the command sees the runtime's home, and none of the worker's variables |
| The runtime holds only placeholders | every model request still carries the real key; no placeholder reaches the model |
| Session state | written through SessionFs into the worker's own session folder |
| A new worker with a new runtime | resumes the session from that folder; the next request carries the earlier turn |
| Stop | the worker's shutdown releases the host; no runtime process is left |
| A sub-agent | runs in its tree's runtime, though its own config names no target |
| Refusals | an unknown target is refused at create; an unknown kind fails the turn; an address that is not local fails the turn and releases the host |

What the runs showed, carried here so later work does not relearn it:

- The runtime writes session files under the SessionFs root, and also names
  some by its own home. The worker's SessionFs maps both to the session folder.
- The runtime keeps a private local store in its home. It is not needed to
  resume: a new runtime with an empty home resumed the session. The `process`
  provider keeps that home private and removes it with the host.
- A refusal at bind or connect is retried like any failed turn today. Stopping
  at once on an unknown or disabled target needs the clear-failures work
  (section 12).

## 6. Walkthroughs

Two generic shapes, to show the one design covers them. Each arrow is a call
from section 3 or 4.

### 6.1 A shared pool

An administrator registers `shared/build-pool`. Its hosts sit in a pool the
provider owns, each reachable at an address the worker can dial.

```text
Create:   the worker loads the pool's provider; an admin registers
          shared/build-pool.
Turn:
 1. core re-checks the owner may use the target, binds a host from the pool,
    and connects. The host is reachable, so connect returns a uri endpoint.
 2. core dials the address; the host component answers the handshake; the
    runtime runs the turn.
 3. a sub-agent of the same tree reuses the same host.
Finish:   the tree ends and core releases the host; the provider cleans it and
          returns it to the pool, with nothing left over. A host nobody came
          back to is ended by its component's idle shutdown.
```

### 6.2 A sandbox service

A sandbox provider creates a fresh sandbox per tree, each reachable at an
address the worker can dial.

```text
Create:   the worker loads the sandbox provider; an admin registers a target
          of its kind.
Turn:
 1. core binds; the provider creates a sandbox, starts the host component in
    front of its runtime, and connect returns that component's address and a
    per-binding secret.
 2. core runs a bridge on loopback and connects to the address; the host
    component answers the handshake; the runtime runs the turn.
 3. the session runs on a model from PilotSwarm's own catalog; the runtime
    holds placeholders and every model request comes back to the worker.
Finish:   the tree ends and core releases the host; the provider discards the
          sandbox and, to keep a buffer, may start a fresh one. A sandbox
          nobody came back to is ended by the host component's idle shutdown.
```

## 7. Corner cases

| # | Case | Handling |
|---|---|---|
| K1 | A worker crashes mid-turn | The turn is redelivered and replayed. Nothing connects to the host meanwhile, so its component's idle shutdown ends it if the tree never comes back. |
| K2 | A session moves to another worker | The next worker connects again — to the same host, or a fresh one the provider gives it — and resumes from the session folder. SessionFs lives in the worker's own storage, so hydrate is unchanged. |
| K3 | A host is replaced | Its `incarnation` changes, so the worker builds a fresh connection and stops the old one once no session uses it. |
| K4 | A target is deleted while sessions reference it | Those sessions are blocked with a clear reason. A new target with the same name is a different id and never takes them. |

| K6 | The connection breaks mid-turn | A fresh pipe replaces it. A pipe that cannot be opened, or is too slow, fails the turn with a clear reason rather than hanging. |
| K7 | A session tree ends while not loaded anywhere | No `release` is sent, because no worker has it. Nothing connects to the host, so its component's idle shutdown ends it. |
| K8 | The handshake fails (wrong secret, a replayed nonce, an oversized frame, a timeout) | The connection closes and the turn fails with a "handshake failed" reason, including when the connection that carries the turn is the one that fails; the model is never called. The handshake proves who each end is, not that the stream between them is private — see 4.5. |
| K9 | A target names a kind this worker has no provider for | The turn fails with that reason, naming the kind. |
| K10 | A remote runtime asks for a model it was not granted, or a different destination | The request handler refuses it; no placeholder is resolved and nothing is sent. |
| K11 | A host shares no files with the worker | Artifact file tools that name worker files are refused for that session; only `worker-local` or `shared-mount` hosts allow them. |
| K12 | A reused host carries state from before | Not allowed: the provider must hand over a clean host, and PilotSwarm uses a fresh secret per binding. |
| K13 | A worker too old to drive remote runtimes | It should carry a capability tag so it never runs a remote session locally. (**open, section 9**) |

## 8. Test plan

Levels:

| Level | What runs |
|---|---|
| U | Unit tests, no runtime |
| L | Local integration: real workers and PostgreSQL, the `process` provider, a scripted model |
| Q | Qualification against a real provider and a real host (later) |

Every test must be able to fail. Break the rule on purpose once and see the
test turn red; the specs say which break proves which rule. Tests run on Linux
and Windows, so nothing may assume a path separator or a shell.

| Area | Level | Checks |
|---|---|---|
| Targets and names (**built**) | U, L | Owner-qualified names; a bare label resolves to the shared target; a deleted target blocks its sessions; a reused name is a new target; admin-only registration enforced in SQL |
| Provider interface and the connection (**built**) | U | A provider that opens its own connections is refused where it is registered; deadlines enforced |
| Remote turn and trust boundary (**built**) | L | A turn runs in a separate runtime with none of the worker's environment; every model request carries the real key while the runtime holds only placeholders; a request to any other destination is refused; session state round-trips and resumes on a new worker |
| The bridge (**built**) | U, L | A full turn through the bridge; one bridge per binding on loopback; a broken pipe reconnects or fails clearly; concurrent turns of one tree share one bridge; a remote endpoint with no connection token is refused |
| The handshake and host component (**built**) | U, L | Success; wrong secret either side; a replayed nonce; a truncated or oversized frame; a timeout; constant-time compare; the host component forwards to the runtime; a wrong secret fails the turn with no model request |
| Host lifecycle (**built**) | U, L | A component with no connection ends itself; an open connection keeps it alive and the clock starts again when that connection ends; the `process` provider's runtime goes with its component, and a returning session gets a fresh host |
| Failures (**built**) | U | Every compute error is `CODE: message` with its code and retry hint, and is never prefixed twice |
| Management surfaces (**built**) | U, L | List, create, update, enable/disable and delete across the management client and the Web API; every mutation audited; surface-parity tests updated |

## 9. Decisions, verified facts and open items

**Decided (2026-11-01)**

| Decision | Instead of |
|---|---|
| The runtime runs on a host, never where the CMS or orchestration can be reached | Running the runtime next to the worker's credentials |
| One host per session tree, fixed at the root session | A session picking compute per turn, or sub-agents on different hosts |
| Every host is reached at an address; the worker opens the connection | A provider carrying transport code of its own |
| Everything above the provider sees only a pipe | Core knowing the medium |
| One mutual handshake PilotSwarm defines for every connection, answered by a host component | Each provider inventing its own trust scheme |
| A per-binding secret, fresh for every binding, never stored in the CMS | A per-host or per-target secret |
| The provider decides a host's fate; PilotSwarm only reports use (a lease) and finish (a done notice) | PilotSwarm deleting hosts; release meaning destroy |
| A host is reusable only with nothing left over | Trusting a host to be clean |
| Owner-qualified names (`shared/<label>`); sessions reference a permanent id | Free-form global names |
| Target `config` holds no secrets; providers get credentials from the deployment | A secret reference in the config |
| Clear failure reasons, provider services and target capabilities/host models left out of this change and designed in section 12 | One large change carrying all of it |

**Verified on the branch (with the `process` provider, real workers and PostgreSQL)**

| Check | Result |
|---|---|
| A turn runs in a separate runtime with none of the worker's environment | Holds |
| Placeholders in the runtime, real keys only in the worker; other destinations refused | Holds |
| Session state round-trips through SessionFs and resumes on a new worker | Holds |
| A sub-agent runs in its tree's runtime | Holds |
| A full turn through a provider-opened pipe and the bridge | Holds |
| Owner-qualified names, shorthand resolution, and the deleted/reused-name rules | Hold |

**Unverified (designed and wired, not proven)**

| Item | Why |
|---|---|
| A turn surviving a worker crash | Depends on whether the runtime keeps a turn when its connection drops and on resume reattaching. |
| SessionFs under compaction, large files, or a non-Linux runtime | Checked for ordinary turns, dehydrate and resume only. |

**Open items**

| Item | State |
|---|---|
| Provider extras | A provider may want to add stronger evidence about a host (additive to the handshake, never replacing it), or to verify PilotSwarm itself in turn. Not decided, not built; a reserved handshake field leaves room. |
| Demand hints | Telling a provider how much demand there is per target, so it can size spare capacity. Deferred; the design leaves room. |
| A secret reference for a provider that needs per-user credentials | Deferred (secrets option A for now: none in the config). |
| A tree spanning more than one target | An open question; today a tree runs on exactly one. |
| Personal compute targets | A later change. |
| A routing capability tag so older workers never run remote sessions locally | To do. |
| Portal and TUI views for compute | Future work (section 12). |
| Provisioning (creating hosts on demand) | Out of scope; a compute provisioner can come later. |
| SessionFs quotas (total size and file count per session), and SQL tools on remote sessions | To do. |

## 10. Implementation map

Paths are under `packages/sdk/src` unless noted. Every row exists on the
branch; section 12 lists what was deliberately left out.

| File / area | Change | State |
|---|---|---|
| `compute.ts` | Provider interface, registry, the always-available local provider, endpoint-to-connection, the rules a remote endpoint must meet | built |
| `compute-bridge.ts` | The loopback bridge, one per host, in front of every remote runtime, plus the built-in pipe that opens a plain connection to an address | built |
| `migrations/compute-targets-0084.ts`, `0084_diff.md` | `compute_targets` and its procedures (extended in place; never edit 0083 or older) | built |
| `compute-target-store.ts`, `cms.ts` | The target store; the create-time check | built |
| `types.ts`, `client.ts` | `computeTarget` on the session config | built |
| `compute-runtime.ts` | Placeholder credentials, the request handler, worker-backed SessionFs | built |
| `compute-process.ts` | The `process` test provider, internal to the package | built |
| `copilot-client.ts`, `session-manager.ts` | The remote connection and turn wiring | built |
| `compute-handshake.ts`, `compute-host.ts`, `compute-host-cli.ts` | The handshake, the host component, and the command that runs it on a host | built |
| `compute-failures.ts` | The one shape every compute error the worker raises takes | built |
| `management-client.ts`, `web/*`, `api/*`, `packages/app/mcp/*` | The target-management surfaces | built |

## 11. Delivery plan

| Stage | Scope | State |
|---|---|---|
| Core | Targets and names; the provider interface and the connection; the remote turn and trust boundary; the bridge; the `process` test provider | **built** |
| The handshake | The mutual handshake and the host component, run for real by the `process` provider | **built** |
| Host lifecycle | `release` as a hint, and the host component's idle shutdown as the backstop | **built** |
| Management surfaces | Targets across the management client and the Web API; audit; API reference docs | **built** |
| Clear failures | Permanent vs temporary; stop the turn at once on a permanent one, from the turn activity, with no orchestration change | **future work** (section 12) |
| Provider services | Running providers as registered services outside the worker, reached through one generic connector | **future work** (section 12) |
| Capabilities and a target's own models | What a target says it offers, the check that records it, and models a host serves itself | **future work** (section 12) |
| The remaining surfaces | Managing targets from MCP and the CLI, and choosing one in the portal and the TUI | **future work** (section 12) |
| Leases and end-of-tree notices | Telling a provider exactly when a host is free, instead of after a timeout | **future work** (section 12) |
| Later | Provider extras; demand hints; a secret reference; provisioning; multi-target trees; SessionFs quotas and remote SQL tools | **later** |

What is built is proved end to end on a laptop and in CI through the `process`
provider: loaded into the worker, reached through the bridge, with the real
handshake answered by the real host component, and a host ending itself when
no session came back to it. What a real deployment still needs is a provider of
its own. The later items are
known and deferred, not forgotten.

## 12. Future work

Pieces of this design were taken out of the change so it stays easy to
review. Each was built and exercised first, so none of this is speculative:
**the built code is on the exploration branch history of PR 244.** The
requirements under each entry are what review found in that code, written as
what a future build must satisfy.

### 12.1 Clear failure reasons

**Value.** A person whose compute target was deleted, disabled or taken away
from them waits about 45 seconds for three identical retries before being told
something that retrying was never going to fix.

**What it adds.** Each compute failure carries whether it is permanent or
temporary. The worker's turn activity stops a permanent one at once with its
reason, and keeps retrying a temporary one (a host offline, no capacity) as it
does today. It is done inside the turn activity, which already has a "do not
retry" result, so it needs no orchestration change and no new orchestration
version.

**Requirements when it is built.**

- Whether a failure is permanent comes from a structured field that only
  worker code sets — never from parsing a message a remote runtime can
  influence, which would let a host force a permanent stop or hide an
  authentication refusal.
- The table of reasons is fixed for a runtime version, or pinned by a test:
  an orchestration replay must not branch on a table that changed under it.
- A provider's own failure code and its permanent flag survive every hop to
  the turn; nothing rewrites a provider code to a generic one or drops the
  flag on the way.
- A refusal to authenticate maps to a permanent reason, not a temporary one.

### 12.2 Running providers as registered services

**Value.** Administrators add compute providers without changing or trusting
worker code. The rights needed to create hosts — on a platform, a pool or a
fleet of machines — stay out of the worker, which holds the sessions and the
model keys. A third party's provider runs in its own service rather than
inside PilotSwarm. And because one service owns its hosts, it is the natural
place to keep spare ones ready for bursts, and to reach hosts that can only
connect out.

**What it adds.** A table of provider services an administrator registers: where
each one is, and the identity a worker must see from it. One generic connector
in the worker forwards every provider call — `describe`, `validate`, `bind`,
`connect`, `release`, `renew`, `done` — over a versioned HTTPS/JSON protocol,
so a new kind of compute needs no new worker code. What a service serves is
never typed in by hand: its kinds and capabilities are what it said
about itself when asked. A service whose hosts cannot be reached answers
`connect` with a URL the worker opens as a WebSocket and treats as a pipe. The
credential a worker presents comes from a deployment hook at call time, so
nothing secret is stored. A helper serves any in-process provider as a service,
so the `process` provider can be run as a registered one in tests.

**Requirements when it is built.**

- A WebSocket connection checks the service's registered certificate before
  any credential is sent, exactly as the HTTPS calls do, and refuses a
  mismatch. The registered server name is enforced too when both are
  registered.
- A connection URL a service returns must belong to the same origin as its
  registration, and must be `wss:` unless it is on this machine. Credentials
  are never sent to an address outside the registered connection policy.
- The WebSocket honours backpressure in both directions, and buffers partial
  frames without quadratic cost. A malformed frame closes the connection
  rather than becoming runtime bytes.
- A worker that has not finished reading the register yet treats a kind it
  does not know as temporarily unavailable, not permanently unknown, and does
  not swap a working adapter for a refusing stand-in because one description
  failed. Compute turns are admitted only after the registry is loaded, or
  behind temporary stand-ins.
- A stand-in for an unreachable service refuses the end-of-session notice
  rather than letting the sweep record it as delivered, so a notice is never
  silently lost while a service is down.
- A service's own failure code and its permanent flag cross the protocol
  unchanged (see 12.1).
- Two services may not own the same kind: a conflict is refused before the
  registry is published, and ownership is stable across reloads rather than
  depending on which one was read last.
- A connection callback uses the provider, target and host of the current
  binding, not the ones captured when the bridge was first made, so a
  re-registered service is actually used.
- A connection ticket belongs to one connection: finishing one session must
  not invalidate a sibling's live connection to the same host.
- Administrators get management, Web and MCP surfaces for the register, with
  the same audit every other mutation has — or the documentation says plainly
  that registration is SDK-only. `update` can clear an identity field it is
  allowed to clear, and a fingerprint is accepted in the forms people paste.
- Registration refuses a service with no identity to check, as it does today.

### 12.3 Capabilities, and a target's own models

**Value.** A person is shown the targets and models that will actually work,
rather than guessing. And providers whose hosts also offer models of their own
become usable: a session can run on a model the host serves with the host's
own model access, with none of PilotSwarm's credentials involved.

**What it adds.** A target advertises what it offers — its operating system,
facts the provider wants shown, and the models its host serves itself. The
worker records it from a check at registration (bind, connect, ask the
runtime, release) and refreshes it, throttled, as it reaches the host; a host
that cannot answer leaves the previous answer standing. The provider declares
in its own code whether its hosts can have model access of their own, and may
describe a host. A model a target offers is named `@<target>:<model>`, which
cannot collide with a `provider:model` name. A session on one of those models
gets a connection with no request handler and no credentials, and the refusal
that keeps runtime-authenticated models off remote targets does not apply to
it, because the host signs for itself. Only a target belonging to one person
may offer models. Management, Web and MCP gain "check a target" and "list a
target's models".

**Requirements when it is built.**

- An advertisement is untrusted input: only well-formed fields are kept, every
  string is bounded, the whole is capped, and the rules are enforced in the
  worker and again in SQL. Strings shown to other users are printable only —
  no control, bidirectional or markup characters — and output that carries
  them marks them as coming from a host.
- Only a target belonging to one person may offer models, enforced where the
  advertisement is stored and again before a turn runs.
- A check on a target that cannot offer models still proves the runtime
  answers, not only that the host component completes the handshake: a host
  whose runtime is dead or incompatible must not pass. Model enumeration is
  the only part that depends on the target's class.
- A check sends the end-of-session notice for the host it borrowed, its wait
  is aligned with the bind deadline, its orchestration is versioned and its
  records are cleaned up, and it is rate-limited.
- A turn whose chosen model the target no longer offers fails with a reason
  that says to choose another.
- A connection that carries a host's own model calls never carries
  PilotSwarm's credentials, and is never the same pooled connection as one
  that does.

### 12.4 Managing targets from MCP and the CLI, and choosing one in the portal and TUI

**Value.** A person who works through MCP, the command line, the portal or the
TUI can see which compute targets exist and pick one, instead of being able to
do it only through the management client or a raw API call. Agents that create
sessions through MCP can place a session on a target.

**What it adds.** MCP tools that list and manage targets and a `compute_target`
option on MCP session creation; the same target operations on the CLI's direct
transport; and a place in the portal and the TUI to see the targets available
and choose one when creating a session. No new API: every one of these is a
caller of operations that already exist.

**Requirements when it is built.**

- Every surface goes through the management client or the Web API, never a
  database handle of its own, and the surface-parity tests cover it the way
  they cover model providers.
- A target the caller cannot use looks the same as one that does not exist.
- Session creation on every surface takes a target name in the same form, and
  a name the caller cannot use is refused at creation, not at the first turn.

### 12.5 Hosts that cannot be dialed directly

**Value.** Reach hosts that can only connect out — a person's own machine, or
a service with no inbound address — without the provider shipping networking
code into the worker. Today every host must be reachable at an address, which
leaves those places out.

**What it adds.** One transport per provider, declared in provider code and
fixed for every host it makes: either `direct`, which is what this change
built, or a pipe the provider opens itself through the worker's bridge. The
bridge, the handshake and everything above them stay exactly as they are — the
only difference is who supplies the code that opens one connection. The host
component gains a mode that connects out and plays the host's part on that
connection.

**Requirements when it is built.**

- The pipe contract holds whoever opens it: two-way, ordered and reliable,
  quick enough for a conversation, visibly broken when it breaks rather than
  going quiet, reaching only that host's runtime, and protected whenever what
  it crosses cannot be trusted.
- A pipe URL is tied to the service it was registered against and never
  carries a credential in the clear off the machine.
- Backpressure is honoured in both directions, so a slow reader cannot make
  the worker buffer without limit.
- A host component that connects out reconnects after a connection ends and
  keeps a spare outward connection ready, because the bridge asks for a fresh
  pipe per connection and a check connection must not consume the only one.
- That component exits with a non-zero status when its handshake is refused,
  instead of ending quietly as a success.

### 12.6 Leases and end-of-tree notices

**Value.** A provider that keeps spare hosts ready learns exactly when a host
is free, instead of waiting out the idle timeout. Today a host nobody came back
to is ended by its own component after half an hour, which is correct but slow:
capacity sits idle, and a provider cannot tell "finished with" from "quiet".

**What it adds.** A lease the worker renews while it uses a host, so renewals
that stop mean nobody is using it — which covers a worker that crashed as well
as one that let go properly. And one notice when a session tree is finished,
sent even if no worker has the tree loaded, so a provider hears about hosts no
`release` would ever cover.

**Requirements when it is built.**

- "Ended" is decided from a session that really finished, never from a state
  the session publishes while it is still alive and still accepting prompts.
  A failed turn is not an ended tree, and telling a provider otherwise would
  recycle a host a live tree still needs.
- A tree that is bound again after a notice starts a new binding, rather than
  reusing a row that has been closed.
- Exactly one notice per tree, and it is never lost: a worker that dies
  mid-notice leaves it to be retried, and a provider that cannot be reached
  does not count as told.
- Holders are tracked per worker, so one worker letting go does not clear a
  lease another worker still holds.
- Closed records are pruned, and a binding of a kind no worker serves does not
  retry for ever.

### 12.7 Long waits and host-local state

**Value.** A session that comes back after a long gap behaves predictably, and
a person knows what survives the wait.

**What it adds.** Today a host whose component timed out is simply replaced at
the next turn. The conversation resumes from the worker's saved history, so the
turn itself is unaffected. What is lost is anything that lived only on the old
host: files outside the session's folders, and background processes started
there. Making those survive — or saying plainly in the session that they did
not — is not built.

### 12.8 Encrypting the connection between worker and host

**Value.** The connection between a worker and a host stops needing a network
that is already private. Today the handshake proves who is at each end and
nothing more, so a party that can sit in the middle of that connection can
read and change the runtime's token, the prompts and the tool results. A
deployment whose workers and hosts are not on a network it controls has no
safe way to use this.

**What it adds.** A session key derived from the handshake — HKDF over the
secret, the binding id and both nonces — and the stream framed under an AEAD
from then on; or the connection bound to TLS, with the handshake proving the
same certificate both ends saw. Either makes relaying the exchange useless.

**Requirements when it is built.**

- The handshake version goes up, and a worker and a host that disagree refuse
  each other rather than falling back to an unprotected stream.
- The order of the frames changes so the host does not sign anything before
  the worker has proved itself, which is the opening a relay uses.
- The contract that leaves no bytes behind between the handshake and whatever
  takes the stream over is re-proved through the new frame layer; today the
  reader puts back what it read past the last frame, and an AEAD layer must
  not lose or duplicate those bytes.
- A test with a party in the middle: it relays the exchange and is then unable
  to read or change a byte of what follows.

### 12.9 File-based tools on remote sessions

**Value.** The rule that a remote session reaches only its own folders stays
true as features are added, rather than being re-established tool by tool.

**What it adds.** SQL tools on a remote session, which need SessionFs to carry
SQLite; and a sweep of every worker feature that takes a path, so each one
either goes through the same per-session roots or is refused for a remote
session, the way the artifact tools and loading by path already are.

**Requirements when it is built.**

- One place decides which worker folders a session may name, and every tool
  that takes a path asks it. A second copy of the rule will drift from the
  first.
- A session that runs on the worker keeps today's behaviour exactly; the
  narrowing is for sessions whose agent is elsewhere.

### 12.10 Canvas and workspace for remote sessions

This change hardens the boundary between an agent and the database: the agent
runs where the CMS and the orchestration cannot be reached. These are the
known gaps left around it, accepted for now and written down rather than
implied.

**What is still true today.**

- A canvas command an agent declared runs in the trusted portal process. The
  programs it may run are allow-listed and there is no shell, but a repository
  inside the session's folders can carry settings that make one of them start
  another program there.
- A person's folder and the shared folder are reachable by more than one
  session. An agent on a host can write a file that another session later
  reads as instructions — including a session that runs on the worker, which
  is what mixed mode means while some sessions have a compute target and some
  do not.
- A provider that mounts the session's folders on a host must mount only that
  session's own folders, with access control on the file server. PilotSwarm
  states the rule and cannot enforce it.
- Traffic between a worker and a host is not encrypted (section 12.8), so the
  network between them must be private.

**Where this goes.**

- The trusted side handles an agent's files only as data: it never executes
  them and never treats them as its own configuration.
- Anything that runs on an agent's behalf runs on that session's own host,
  over the connection the handshake has already proved — canvas commands and
  the Workspace tab's git operations included.
- Mounts are per session.
- Agents get read-only access to the shared folder.

### 12.11 Every session runs on a compute target

**Value.** There is no mixed mode left to reason about. Today a deployment can
require compute (section 4.7a), which is what makes the invariant hold, but
the worker-local path still exists behind it, and every gap in section 12.10
is a gap only because some sessions may run on the worker.

**What it adds.** Running an agent as the worker's own child process is
removed. Every session has a compute target — the one it named or the
deployment's default — so the trusted side never runs model-chosen code at
all.

**Requirements when it is built.**

- A deployment has a target to give every session before the worker-local
  path goes, or it cannot start a session at all.
- Local development has a way to run without one, or a target that is cheap
  enough to be the default there.
- The helpers that run a model over text without an agent (titles, model
  listing, distillation) either move with it or are shown to need no agent.
