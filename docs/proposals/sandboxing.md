# Sandboxing: execution, state, resources and lifecycle

**Code draft for continued development.** This describes the integrated
provider-neutral native-core candidate and its first target. The branch now
includes runtime and additive schema changes, not documentation only. Its named
Windows qualification is a controlled profile, not blanket provider qualification
or deployment approval.

**Reading guide:** start here for the framing and first workflow. The
[remote-execution technical companion](remote-execution-bindings.md) explains the
compute framework, trust boundaries, lifecycle and recovery contracts in more
detail. They describe the same proposal; the earlier PRs are background, not
three competing designs reviewers must reconcile.

## What we want to achieve

**The goal is to give PilotSwarm agents isolated, task-appropriate environments
with the compute, tools, repositories and storage they need.** The agent's Copilot
runtime and native tools execute inside the environment, driven remotely through
the SDK by the trusted PilotSwarm worker. Session progress and results should
remain durable and recoverable across failures and environment replacement.
PilotSwarm coordinates the work, enforces access and execution policy, and
preserves committed session state and outcomes. Pluggable providers supply and
manage the execution environments and their attached resources throughout their
lifecycle.

The design covers four related areas:

1. **Execution isolation:** give agents appropriate execution environments with
   clear resource and access boundaries.
2. **Session durability and recovery:** preserve committed progress and results so
   sessions can recover safely after failures or environment replacement.
3. **Workspace and build-state persistence:** make repositories, storage, build
   outputs and caches available with clear ownership and persistence guarantees.
4. **Process continuity:** define whether running commands and background jobs
   continue, stop or restart as sessions and environments change.

Each area has its own lifecycle and recovery guarantees, which should be explicit
for every supported configuration.

## Proposed first target

Preserve PilotSwarm's session lifecycle, orchestration and recovery model while
moving agent execution away from the trusted worker. Support independently
attached repositories/workspaces and an explicitly supported model/tool profile.
Start with **one isolated environment per logical session, including each
delegated subagent**. A child can inherit its parent's target authorization
without sharing its executor or native home.

The runtime uses **native session files inside the execution environment**.
PilotSwarm captures/restores the required state and retains archive-backed
commit and recovery authority. Remove remote worker-backed SessionFs rather
than keep two remote state modes. Ordinary local/native filesystem behavior
remains unchanged.

```text
Current:   worker [SDK client + agent runtime]
Proposed:  worker [SDK client] -> isolated environment [agent runtime]
```

The worker retains trusted composition, platform callbacks and backend access.
The common PilotSwarm host inside the environment handles native state
import/export. The deployment provider manages the environment and connection,
not a separate checkpoint format. The worker validates the returned state and
decides what commits.

The isolated environment is not enrolled as a trusted worker. Its files, events
and requests are untrusted inputs; authenticating a connection does not authorize
every operation that arrives over it.

The benefit is an execution boundary between agent-generated code and the worker.
It does not replace authorization for shared history, artifacts, facts, graphs
or storage. A parallel threat model and privacy review must cover those services.
Cloud-specific identity, provisioning and network behavior belong in provider
implementations, not the public core.

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

Retaining the environment does not require keeping the runtime process alive.
The environment, common host/state service and runtime writer scope have
different lifetimes: stopping writers for capture must not also remove the
service needed to export the state.

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

Authority must remain valid through admitted asynchronous work and archive
publication, not just at a check before they start. Unknown outcomes need an
observable reconciliation path, not an unsafe retry or an unexplained permanent
hold. This does not mandate deleting every environment after each turn.

### Native session files and recovery

Restore accepted state before starting/resuming the runtime against its native
home. Capture the complete state required by the supported workload, including
required databases outside a per-session directory. Do not assume every
runtime-global file is disposable or copy an entire credential-bearing home.

Capture requires a **verified checkpoint barrier**: required state has been
persisted and relevant writers cannot change it inconsistently while it is
captured. A qualified writer hold, supported database backup or controlled
runtime restart may establish that boundary. Neither mandatory warm-process
continuity nor an unconditional restart after every turn is required.

SDK idle/disconnect, signal delivery and a warm live copy are not that guarantee.
Preserve normal lifecycle-hook semantics. SQLite/sidecar fidelity needs actual
backup/restore qualification, not inference from filenames.

The trusted side validates captured state and publishes it through PilotSwarm's
archive/CAS lifecycle. Native session files do not mean provider-owned VM snapshots
or process-memory recovery. Repositories remain independently attached.

### Committed outcome and completion recovery

The winning committed state, result and original completion/accounting identity
must agree. Commit the accepted state/result before finalizing completion.
Recovery after that commit must not rerun committed model/tool work or duplicate
completion effects merely to discover the outcome.

A saved result and validated, idempotent completion record are one approach.
An equivalent mechanism is acceptable. The state commit and an external effect
are not automatically one transaction, and no exactly-once claim is made for
arbitrary external tools.

### Explicit authority and compatibility

Revalidate target and resource authority at the relevant admission points.
An explicitly remote session must not silently run locally when a provider,
catalog capability, connection or profile is unavailable. Rollout and rollback
must preserve that rule across mixed worker versions and retain local/legacy
compatibility without inventing recovery metadata.

Model authentication and runtime attachment are separate concerns. Deliberately
select worker brokerage, a qualified platform-managed identity or appropriately
scoped runtime credentials. Effective model configuration and authority must
follow the current selection on create, resume and rebind. A placeholder is not
proof that its backing grant is current.

Package MCP services may run inside the environment; privileged deployment
services remain behind trusted authorization. A server-connection ticket is not
automatically permission for every tool or operation on that server. Define where
those operation restrictions are enforced. The execution/control path must also
be protected; a handshake authenticates but does not encrypt.

## Converge existing work rather than add another framework

The compute-provider draft
([microsoft/PilotSwarm#244](https://github.com/microsoft/PilotSwarm/pull/244))
provides a proposed common surface for targets, host connection, workspace paths,
rollout and model/MCP brokerage. The isolated-runtime proposal
([microsoft/PilotSwarm#253](https://github.com/microsoft/PilotSwarm/pull/253))
records complementary ownership, state and completion requirements.

Build one implementation from those contributions. Keep the broader compute
framework, move reusable native-state and recovery mechanisms into its common
host/lifecycle, and remove remote SessionFs-specific plumbing. The prototype
already supplies implementation and useful regression scenarios; adapt them
rather than restart from abstract requirements or preserve both interfaces.

**One core PR** should deliver that coherent provider-neutral path, with logical
commits for review. The completed placement/model/state-exclusion corrections are
a checkpoint within that work, not the finished native integration or a reason
to merge an intermediate state mode independently.

**A separate deployment-owned PR** supplies the cloud-specific provider,
allocation/reconciliation, identity, host bootstrap, protected connectivity,
actual repo access and provider qualification. It consumes public PilotSwarm SDK
contracts and the common host, without private SDK imports or a core fork.

The first delivery should demonstrate a configured repo-backed session:
attach resources, run native operations in the isolated environment, change an
attachment, save the turn, recover after safe executor replacement, and clean
up. State which platform features and authentication profiles this qualifies.

Controlled prototype observations and the local correctness checkpoint do not
qualify the new common path by themselves. Native barrier/hook fidelity, actual
database/ownership/completion behavior, external-provider consumption and the
final integrated version still need evidence. Core acceptance does not establish
a real provider's physical isolation, identity, network or retirement guarantees.

Agree a named integration lead and review responsibilities before treating a
handoff as complete. This proposal does not silently supersede either existing
PR or assign ownership without agreement.

## Later capabilities, not prerequisites

- Providers may later support pausing an idle environment and resuming it for
  subsequent work. This is outside the initial core PR and must preserve
  PilotSwarm's checkpoint, ownership and recovery guarantees.
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

## Review focus

Review the proposed boundary and first workflow: one compute core, native
session-state recovery, independently attached resources and deployment-owned
lifecycle. Confirm that the public provider contract can express those
responsibilities and that failure/recovery behavior is explicit.

Implementation details and the full qualification matrix belong with the code
and implementation plan. They should support this design, not obscure its
purpose or imply that an unqualified mechanism already provides the guarantee.
