# Executable published-package trust

## Status and scope

This document describes the implemented platform candidate through `dbf5edf`
and the Linux acceptance workflow added in `0854f97`, plus the uncommitted
admission lock-order, exact caller-pin, cancellation and startup-recovery
strengthening below, not the superseded
foundation-only design at `89d3269`. Historical implementation inventories and
claims that callbacks or automatic MCP are unimplemented have been removed.
The relevant history remains in Git.

Prerequisite PR #185 is **not a release/deployment authorization**. Executable
tools, generic callbacks and ordinary package MCP can execute in supervised
children after approval, activation and current-session admission. This is not
a permanently quarantined, approval-always-fails foundation.

External gates remain: Linux acceptance evidence, trustworthy control-plane
fencing proof for unknown legacy/other-host workers, and the requested exact
Claude Opus 4.8 completed-candidate review. That model is unavailable here; no
replacement review is represented as its pass. The initial Linux run is
<https://github.com/seanzqliang/PilotSwarm/actions/runs/39093805760>;
that run failed the broker database-outage fixture under SCRAM and retained
an orphan broker after initialization failed. Its other passing cases do not
make the matrix successful. The corrected fixture and startup recovery require
a fresh Linux run; starting a workflow is **not** evidence that it passed.

This is a general executable-package workflow, not cron-specific. Declarative
prompt/agent/skill packages retain their existing publication behavior. Known
trusted deployment plugins and ordinary interactive turns are not converted to
published-package processes.

## Independent controls and immutable content

1. Admin content approval is required **before** module import, tools factory,
   callback factory, handler registration or package MCP server startup.
2. Approval is not activation, owner access, capability consent or session
   permission. Every invocation independently obtains authoritative admission.

Private/shared scope, `enabled`, prior installation and warm caches never imply
approval. Existing executable versions start pending/uninspected; there is no
grandfathering. Inspection reads archive/manifest/source bytes without importing
code. Review is tied to exact package ID, version ID and the full canonical tar
SHA-256, including all packaged dependencies/configuration bytes.

The inspector rejects ambiguous paths, links, reserved metadata, unverifiable
dependencies and unsupported executable shapes. It checks static ESM imports and
fixed MCP entry/args/environment. This is a conservative supported-shape policy,
**not** a JavaScript sandbox or proof that approved code is harmless.

Every install/refresh verifies artifact bytes and materialized files against the
immutable inspection. `.pilotswarm-meta.json` is diagnostic only. A retained
sidecar cannot authorize a changed cache. Imports and factories execute only in
the package child; the parent receives JSON declarations and proxy functions,
never package function objects.

## Review, activation and version pins

Additive catalog contracts and PostgreSQL migrations provide immutable review
candidates, pending/approved/rejected/revoked decisions, separate explicit
activation, durable session pins/grants, and append-only audits.

Decision CAS requires exact candidate/version/digest and expected review revision.
Activation separately requires expected review revision, active version and
activation revision. Actor/time/reason/before/after are audited in the transaction.
An authenticated fleet administrator is required; request `isAdmin`/actor fields
never become server authority. Cluster-scoped administrators cannot change
global executable trust decisions.

Publishing executable V2 does not activate it. Pending, rejected or merely
approved V2 leaves V1 active. Explicit V2 activation affects new bindings only;
an existing V1 session remains exactly V1 or is denied, never silently upgraded.
An approved-but-inactive, unpinned version cannot even register/import.
Rebinding is a separate explicit audited CAS operation, including an explicit
initial bind for historical sessions that lack a pin.

Named bindings pin package/version/SHA/agent/owner. Generic `use_package`
selections persist exact version/SHA/source-ref/owner/tools/MCP/callback grants
in the **same transaction as capability revision CAS**. New grants require an
active version. Existing exact grants do not follow the current active name.
Substituted identities, stale CAS and failed grant transactions cannot partially
replace capabilities/grants.

## Current-session admission and ordering

`PackageRuntimeAuthority.withAdmission` is the provider-neutral execution
contract. PostgreSQL implements its authoritative ordering with the same
schema-scoped barrier used by decisions and lifecycle/capability changes.
No nondeterministic authorization is embedded in orchestration replay.

Metadata reads under that barrier use ordinary MVCC snapshots, not tuple
`FOR SHARE` locks. A writer may already own a tuple lock before entering its
BEFORE trigger and waiting for the same barrier. Taking its tuple lock from
inside admission would invert that order and deadlock. The writer cannot commit
its mutation until the trigger obtains the barrier; admission can therefore
observe the prior committed metadata and order before that writer. Registration
row locking remains inside the barrier. A real two-connection regression holds
a binding tuple lock and proves admission completes before the writer releases
it; the correction does not weaken the mutation triggers or admission checks.

Each handler/callback/MCP start/list/call checks live effective owner, visibility,
enablement, content decision, exact binding/grant, current agent/capability
permissions, registration generation and registry/owner/capability epochs.
Creation-config/root changes also fence affected registrations. A caller cannot
omit the named agent and hydrate a durable package pin as a generic session.
Histories and bindings are retained when execution is denied.

`PackageCallbackServices.bindingRevision`, when supplied by a durable caller,
must match the named binding inside the same authoritative admission transaction.
Missing session grants, selected generic grants and stale revisions cannot
impersonate that exact named binding. `PackageCallbackServices.signal` cancels
the owned supervised generation, including a synchronous callback; already
aborted calls admit no callback. Neither option executes callback code in the
parent or changes deployment-plugin behavior.

Executable dispatch has a one-second admission deadline, checked before package
operations begin. Trusted idle-process preparation has its own bounded 30-second
deadline and cannot import package code. Check-then-unbounded-wait is not an
admission mechanism. A decision ordered after admission may overlap a previously
admitted effect; it denies **new admissions** first, then fences execution.

Already-admitted external effects cannot be undone. Admission/decision/fence
audit is the boundary; there is no general effect ledger or rollback claim.

## Supervision, cancellation and honest fencing

A trusted broker owns package execution and MCP processes and maintains its own
PostgreSQL authority connection. Package code never receives that connection
configuration. Processes are recorded while idle, before code starts, with
registration/generation, host boot/PID-namespace, PID and OS start identity.
The parent records the idle broker before its independent database connection
initializes. A failed initialization cannot leave the broker absent from recovery
inventory. Startup first attempts graceful shutdown; if that cannot observe
completion, the healthy parent authority denies the generation and performs
exact local process recovery. Fence-requested generations are recoverable even
before lease expiry; healthy active generations are not reclaimed merely
because another worker starts.
Windows termination compares the held process handle at the same microsecond
precision as the recorded CIM start token. Comparing its extra 100ns digit
instead falsely treated a still-live owned broker as a recycled PID and prevented
recovery. The handle remains open across identity comparison and termination.

Revocation/disable/delete/owner/capability changes deny admissions and request
fences. Responsive brokers kill their owned children, including synchronous
infinite loops, before recording observed completion. A surviving broker kills
children on loss of database authority and retries acknowledgement after the
database returns. It does not fabricate completion during the outage.

Recovery first denies the generation, freezes/observes the recorded broker exit,
then reads the final durable child inventory and terminates exact owned process
identities. Reading an earlier inventory while a broker can still add children
is not sufficient. Windows/libuv can kill the broker with its parent; another
local worker must then independently observe and record exits.

Acknowledgement independently verifies local recorded processes are gone.
A boolean `true`, expired lease, heartbeat change or missing response is not
proof. Unreachable hosts/PID namespaces remain incomplete. No management response
claims revocation execution-complete merely because its SQL decision committed.

Windows recovery retains a native process handle through identity checking,
termination and observed exit. Linux uses pidfd through trusted
`/usr/bin/python3` (Python 3.9+ and kernel pidfd support); missing support fails
closed before registration. Windows evidence does not validate Linux. Other
operating systems reject executable registration; declarative packages do not
require process supervision.

`package_runtime_legacy_workers` blocks activation/admission while a known
pre-protocol worker remains unverified, including across migration reapplication.
A new protocol-1 heartbeat cannot certify an old uncontrolled process dead.
No client/admin boolean can clear this gate. Proving an unknown legacy or remote
worker fenced requires a trusted deployment-specific control-plane verifier;
none is configured/certified by this candidate. CMS-invisible legacy processes
also require external fleet inventory/proof. **Never delete legacy rows to
bypass this operational prerequisite.**

These are supervised trusted-worker processes, not a sandbox. Approved JavaScript
retains its host privileges; arbitrary already-admitted effects are not mediated
or reversed. Whole-worker recycling is not the cancellation design.

## Generic callback and ordinary MCP contracts

* `worker.invokePackageCallback(identity, sessionId, name, args, services?)`
  resolves exact `{packageId, versionId, sha256}`, never a name/active fallback.
  SDK hosts can use `SupervisedPackageRuntime.invokeCallback`.
* `plugin.json` declares `callbacks` with explicit agent/tool/MCP permissions.
  The canonical module exports `createCallbacks`/`callbacks`, arrays of
  `{name, handler}`. Tools load before callback factories.
* Callback args/results/context cross IPC as bounded JSON. The child receives
  trusted reverse-IPC `context.callTool` and `context.callMcp` bridges.
  No-tools callbacks remain possible; they do not acquire tools by executing.
* `PackageCallbackServices` supplies trusted deployment tool/MCP routers. Such
  routers preserve their current authorization and published-target exact
  wrappers. Every nested call independently reauthorizes.
* Failed, `isError:true`, or unfinished nested calls are latched in the trusted
  parent. Catching an error cannot fabricate `{skip:true}`. Rejection code is
  `PACKAGE_CALLBACK_NESTED_CALL_FAILED_OR_UNFINISHED`; unfinished calls cancel
  the generation. Integrators treat rejection as failure/defer, **never skip**.

Ordinary package MCP uses an exact-identity registry marker, not a raw command.
Before native SDK hydration, the worker resolves it to a trusted loopback HTTP
adapter bound by an unguessable token to the durable session/package/server/
generation. Every request reauthorizes. MCP children are distinct per session;
stable tokens preserve warm SDK sessions. Generation refresh closes old adapters.

## Supported and explicitly unsupported shapes

Supported: canonical packaged ESM module with tools/generic callbacks, verified
relative imports and permitted Node builtins; package stdio MCP using `node`,
an exact packaged ESM entry and fixed reviewed args/environment.

Rejected: remote package MCP, shell commands, bare/npm imports, vendored
`node_modules`, dynamic/unverifiable dependencies, native/WASM payloads, arbitrary
hooks, wildcard/unknown entry exports, undeclared callbacks and noncanonical
worker modules. Only MCP initialize/ping/initialized/tools-list/tools-call are
supported. Callback agent declarations apply even to explicit selections.
Cross-published-package named-agent callback bindings are unsupported.
Native inline package-MCP subagents are disabled rather than borrowing their
parent's durable identity.

## Administration, migration and rollback

The authenticated Pending Approval UI tab sits between Private and Shared and
shows publisher, exact package/version/digest, reasons, reviewable files, prior/
current active versions, CAS decisions/activation/rebind, audits and current
`runtimeFencing: {denied, complete, outstanding}`. Refresh reads actual status.
Equivalent management/Web API/CLI/MCP surfaces exist, including deleted-identity
status via `getAgentPackageRuntimeStatus`,
`pilotswarm agents runtime-status <package> <version> <sha>` and
`get_agent_package_runtime_status`.

Migrations 0084–0086 are additive; histories are not dropped. 0086 adds exact
grants/audit, durable process identities, lifecycle triggers and the legacy-fleet
gate. 0085 reapplication preserves that gate. Downgrading to old workers is unsafe
until executables are disabled and their processes are actually fenced. Retain
review/binding/grant/admission histories; never erase fencing rows as rollback.
No operator environment, live database or deployment was modified for acceptance.

## Verified evidence and remaining gates

At `dbf5edf`, Windows local acceptance was **244 passing tests**:

* `npm run build` — root full build passed.
* `node --test --test-concurrency=1 packages\sdk\test\postgres\package-runtime.test.mjs`
  — **34 pass, zero skips**, isolated standalone PostgreSQL 17.11.
* The focused Node matrix recorded by `dbf5edf` — **207 pass, zero skips**.
* From `packages\sdk`, `node ..\..\node_modules\vitest\vitest.mjs run test\local\agent-binding-refresh-runtime.test.js --reporter=verbose`
  — **3 pass, zero skips**, real native SDK/CLI with scripted inference.

Real PostgreSQL acceptance covers additive migration/reapplication, decision and
activation CAS, exact pins/multi-package grant rollback, concurrent admission/
revoke, two real blocked worker-host processes, broker/parent death, database
outage, truthful unreachable-worker status and mixed-fleet gating. It is not
mocked/PGlite/source-shape evidence.

The follow-up passed SDK compilation and **seven targeted standalone SCRAM
PostgreSQL 17 cases**, with zero failures/skips and normal process exit:
live-process acknowledgement, concurrent revoke ordering, no-tools/current-owner
callbacks, caller cancellation of synchronous code, writer-owned binding tuples,
failed broker initialization recovery and broker database-authority outage.
The last two cases independently passed on the integrated cron branch as well.
These overlapping regressions are not added to the historical 244 count.

The focused startup/outage command is:

```text
node --test --test-reporter=tap --test-timeout=120000 --test-name-pattern="broker initialization failure|unavailable broker database authority" packages\sdk\test\postgres\package-runtime.test.mjs
```

`PS_TEST_DATABASE_URL` selects a separate task-owned local cluster initialized
with SCRAM, not trust authentication or an operator database. A direct probe
confirmed the old passwordless-role/inherited-root-password combination fails
with SQLSTATE `28P01`. The fixture now creates a generated synthetic role password
and forwards that same password. Failed starts are captured for teardown; pool
cleanup runs in `finally`, while failed recovery retains its inventory rather
than deleting rows to pretend fencing completed.

The Linux workflow at `0854f97` predates these corrections and cannot validate
the new code; its failed/hung run is not passing acceptance evidence.

Edge browser acceptance exercises the React review/activation/revoke/audit UI
against authenticated fixture HTTP plus real SQL, not production Entra middleware.
Separate production Web-runtime authorization tests check server-admin admission.

Counters through real paths prove pending/inactive content has zero imports/
factories/handlers; an approved tool has one import/factory/handler in a non-parent
PID; a no-tools callback can run while its denied tool has zero handlers; caught
denied MCP has zero starts/calls; actual ordinary native MCP has one start and
one call, with zero new model requests/MCP calls after warm revocation.

Linux acceptance is tracked separately; Windows-only POSIX permission/MSYS/CRLF
failures are not passes or a reason to hide skipped tests. The secret-free
read-only workflow uses PostgreSQL 17, pidfd/Python and Edge. Its successful run,
external legacy/remote fencing proof and exact Opus 4.8 review remain gates.
This document does not grant permission to commit, push or deploy further work.
