# Sandboxing: execution, state, resources and lifecycle

**Draft for discussion.** This proposes a first target and a convergence path,
not an already agreed architecture or a claim of provider qualification.
Merging this document changes no runtime behavior, database schema or deployment.

## Proposed framing

**Sandboxing is the management of an isolated execution environment and its
resources, not just remote placement of the Copilot runtime.** PilotSwarm remains
authoritative for logical sessions, queued work, committed agent state,
completion/accounting, policy and current execution authority. Providers supply
execution environments, storage/attachment mechanics and explicitly qualified
lifecycle capabilities.

Separate four concerns:

1. **Isolation and execution:** the worker and embedded SDK stay outside; the
   runtime, native tools and deliberately attached resources execute inside an
   appropriate boundary.
2. **Agent-state recovery:** archive-backed restore remains the baseline. A
   provider snapshot can accelerate restoration only when it represents the
   exact PilotSwarm-accepted checkpoint. Provider-native durable byte custody is
   a distinct, stronger optional mode.
3. **Workspace and build-state persistence:** repositories, scratch roots, build
   outputs and caches have explicit attachment and persistence contracts,
   independent of the runtime checkpoint.
4. **Process continuity:** retaining a live executor/job across controller changes
   or supported suspension is a separately qualified capability, not a
   consequence of saving agent-state files.

These are separate concerns, not four features that must ship together.

## Proposed first target

Preserve PilotSwarm's session lifecycle, orchestration and recovery model while
moving agent execution away from the trusted worker. Support independently
attached repositories/workspaces and an explicitly supported model/tool profile.
Start with one session per isolated environment; sharing and the treatment of
child sessions need an explicit allocation policy.

**Proposed state strategy:** the runtime uses native session files inside its
execution environment. PilotSwarm captures/restores the declared session state
and retains archive-backed commit and recovery authority. Repositories remain
independently attached. This is the proposed shared-core integration mode, not
an already qualified remote profile.

```text
Current:   worker [SDK client + agent runtime]
Proposed:  worker [SDK client] -> isolated environment [agent runtime]
```

The worker retains trusted composition, platform callbacks and backend access.
The isolated environment is not enrolled as a trusted worker. Its files, events
and requests are untrusted inputs; authenticating a connection does not authorize
every operation that arrives over it.

The benefit is an execution boundary between agent-generated code and the worker.
It does not replace authorization for shared history, artifacts, facts, graphs
or storage. A parallel threat model and privacy review must cover those services.
Cloud-specific identity, provisioning and network behavior belong in provider
implementations, not the public core.

## Proposed convergence direction

Build toward one common compute core and separately managed provider lifecycles,
not two parallel remote-execution frameworks.

The [compute-provider draft](https://github.com/microsoft/PilotSwarm/pull/244)
provides a proposed surface for targets, host connection, workspace paths,
rollout and model/MCP brokerage. The
[isolated-runtime proposal](https://github.com/microsoft/PilotSwarm/pull/253)
records complementary ownership, state and completion requirements. Reuse
mechanisms that satisfy those requirements; do not preserve an interface merely
because a prototype already uses it.

This document combines those contributions into a proposed direction. It does
not declare either implementation ready, supersede the existing proposals or
assign implementation ownership without agreement.

## Dynamic environments require lifecycle management

A long-lived machine can already exist when a worker needs it. A dynamic
environment may need to be created, prepared, reused, retired and deleted.
A compute connection alone does not manage that lifecycle.

```text
Queued work
  -> acquire or create the intended environment
  -> prepare accepted agent state and attach authorized resources
  -> connect and run the turn
  -> commit the accepted state and completion
  -> retain for reuse or retire safely
```

The trusted integration must retain enough durable allocation and ownership
information to reconcile a worker disappearing. It must handle lost provisioning
responses, abandoned resources, cleanup failures, quotas and expiry. A timeout is
not proof that creation failed or execution stopped.

The provider's `bind` operation can allocate dynamically; a separate microservice
is not automatically required. The important distinction is between releasing a
caller's interest, retaining an idle environment, and proving an executor retired.
A best-effort release hint must not be used as termination proof. Cleanup and
reconciliation must not depend solely on that hint arriving.

## Resources do not all share one checkpoint

- **Agent session state:** preserve the files and databases required by the
  supported runtime profile and the accepted turn result.
- **Repositories and other attached roots:** retain their own storage,
  authorization and recovery policies. A selected folder or attachment revision
  is not an immutable version of its contents.
- **Build outputs, caches and installed tools:** state which are disposable,
  independently persistent or local to the environment.
- **Live processes:** identify who owns them and what happens on cancellation,
  worker loss, idle retirement and environment replacement.

PilotSwarm already has workspace selection and attachment behavior. Extending it
to remote execution requires real access to the selected files inside the
environment, correct runtime paths and lifecycle integration. Translating a
worker-local path does not mount or synchronize the corresponding filesystem.

Preserve the distinction between conversation recovery and workspace recovery.
An external workspace may retain partial edits from a failed attempt. Restoring
agent state does not silently roll those files back. A profile that promises
coordinated content rollback needs a separate workspace-version contract.

## Required behavior in the common implementation

### Safe execution ownership

Before a replacement turn is admitted, conflicting execution from the previous
controller must be stopped or fenced. Stale callbacks, state publication and
accounting writes must be refused. Already admitted effects must be accounted
for; a handshake or routing tag alone is not a replacement barrier.

Unknown outcomes need an observable reconciliation path. The required outcome
does not mandate a particular binding API, deleting every environment after each
turn, or one specific lease implementation.

### Proposed native-session-file profile

For the first isolated profile, this draft proposes real session files beside
the runtime rather than requiring worker-backed SessionFs for all runtime state.
The intent is to preserve normal filesystem behavior, including native database
access where the supported runtime uses it.

The trusted side captures/restores the complete declared per-session state and
publishes the accepted result through PilotSwarm's existing archive/CAS lifecycle.
Validate returned files and preserve the worker's authority over commit metadata.
Do not fold independently attached repo/build storage into the conversation
archive merely because the runtime can access it.

Capture needs a defined consistency boundary: verified writer shutdown, a
supported database backup operation or another qualified mechanism. A warm live
copy is not automatically an atomic database checkpoint. Establish the locations
of all required files/databases; capturing a per-session tree does not imply
capturing every runtime-global database. SQLite/sidecar fidelity still needs
qualification rather than inference from filenames.

Native session files do not mean provider-owned VM snapshots or process-memory
recovery. PilotSwarm remains authoritative. This can be a declared mode of the
common compute framework; it need not reject its targets, connection, workspace
or brokerage mechanisms, or mandate the same storage mode for every provider.

### Committed outcome and completion recovery

The winning committed state, result and original completion/accounting identity
must agree. Recovery after state commit must not rerun committed model/tool work
or duplicate completion effects merely to discover the outcome.

A saved result and validated, idempotent completion record are one approach.
An equivalent mechanism is acceptable. The state commit and an external effect
are not automatically one transaction, and no exactly-once claim is made for
arbitrary external tools.

### Explicit authority and compatibility

Revalidate target and resource authority at the relevant admission points.
An explicitly remote session must not silently run locally when a provider,
catalog capability, connection or profile is unavailable. Rollout and rollback
must preserve that rule across mixed worker versions.

Model authentication and runtime attachment are separate concerns. Deliberately
select worker brokerage, a qualified platform-managed identity or appropriately
scoped runtime credentials. Effective model configuration and authority must
follow the current selection on create, resume and rebind. A placeholder is not
proof that its backing grant is current.

Package MCP services may run inside the environment; privileged deployment
services remain behind trusted authorization. A server-connection ticket is not
automatically permission for every tool or operation on that server. Define where
those operation restrictions are enforced.

## Delivery sequence and the first code change

### First: harden the existing compute-provider contract

The proposed first code PR is deliberately bounded to four reviewed cases in
three areas, with regressions against the actual implementation:

- **Placement:** persist default target selection and refuse explicit remote
  placement when its target authority cannot be read. Genuinely unselected local
  sessions remain supported.
- **Model configuration:** refresh effective provider configuration and backing
  credential resolvers after selection changes or rotation. Stable stand-ins
  must not retain an obsolete account, project or configuration.
- **State exclusion:** close mutation admission and drain already-admitted
  SessionFs writes before saving/restoring. Hold the barrier for the complete
  operation and reopen safely.

This is a proposed correctness PR, not code included with this document. It
adds no cloud provider, new persistence backend, process-continuity feature or
sharing policy. It does not complete the broader worker-failure fencing or
committed-completion work.

Those fixes repair the reviewed draft's existing paths. The proposed native
session-file integration is a separate change, not an expansion of that first PR.

### Then: reconcile the required recovery behavior

Carry the execution-ownership, state-fidelity and committed-completion outcomes
above into the common path. Choose an explicitly supported state/model/tool
profile. Distinguish newly introduced defects, inherited behavior and deliberate
feature limits rather than treating every difference as a reason to preserve
the prototype unchanged.

### Then: integrate and qualify the first dynamic provider

Add durable allocation/reconciliation, host bootstrap, protected connectivity,
identity, real workspace access and cleanup behind the common boundary.

The first delivery should demonstrate a configured repo-backed session:
attach resources, run native operations in the isolated environment, change an
attachment, save the turn, recover after safe executor replacement, and clean
up. State which platform features and authentication profiles this qualifies.

Agree a named integration lead and review responsibilities before treating a
handoff as complete. Adoption decisions and implementation ownership remain
subject to joint review.

## Later capabilities, not prerequisites

- Snapshot-assisted restoration can be an exact-state optimization with archive
  fallback. Keeping that fallback current still requires archive publication.
- Provider-native checkpoint custody can remove routine archive movement only
  with qualified immutable references, durability, retention and reconciliation.
- Retained-executor reconnect can preserve an environment while it survives;
  process-memory suspension and execution-host-loss recovery are stronger claims.
- Shared user/team environments need separate visibility, authority and lifecycle
  policies.

Rolling an entire environment back cannot also promise that processes created
after that checkpoint keep running. These capabilities should be justified and
qualified independently.

## Decisions for the next design revision

1. Is allocation per logical session or per parent/child session tree, and what is
   the initial supported scope?
2. Do we agree on the proposed native-session-file mode, which files/databases
   must it preserve, and which model/tool profile does the first delivery qualify?
3. Where are dynamic allocation records, authority and orphan reconciliation
   implemented, and what proves safe replacement?
4. How are repository files actually made available inside the environment, and
   which content/retry semantics remain unchanged?
5. Who integrates and reviews the common-core and provider changes, and what is
   the acceptance plan for the first workload?
