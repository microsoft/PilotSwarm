# Executable published-package trust

## Status and scope

This document describes the current platform candidate: supervised tools,
callbacks and MCP, authoritative admission, exact caller pins, cancellation and
startup recovery, verified in-memory module loading, and additive CMS migrations
0084–0088. Superseded foundation-only implementation inventories remain in Git,
not as current limitations here.

Prerequisite PR #185 is **not a release/deployment authorization**. Executable
tools, generic callbacks and ordinary package MCP can execute in supervised
children after approval, activation and current-session admission. This is not
a permanently quarantined, approval-always-fails foundation.

External gates remain: Linux acceptance of the final candidate, trustworthy control-plane
fencing proof for unknown legacy/other-host workers, and the requested exact
Claude Opus 4.8 completed-candidate review. That model is unavailable here; no
replacement review is represented as its pass. Local acceptance does not
establish Linux or operational legacy-worker fencing qualification. Starting a
workflow is **not** evidence that it passed.

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

### Verified executable bytes, not a disk check/use assumption

At generation creation the trusted supervisor reads each artifact file once
into a Buffer, hashes that same Buffer against immutable inspection, and retains
verified `.js`, `.mjs` and `package.json` bytes (aggregate source limit 16 MiB).
Module and MCP children receive this bounded snapshot over IPC. Before importing,
their trusted bootstrap installs synchronous `node:module.registerHooks`.
Both resolve and load require an exact snapshot file URL; there is **no disk
fallback**, even for another file within the package directory. Only the
already-policy-permitted `node:` builtins delegate to Node. Actual file URLs are
preserved for `import.meta.url`. Unsupported Node runtimes without synchronous
hooks (Node <22.15; supported deployment/CI uses Node 24) fail closed. MCP entry
imports use the generation's same retained snapshot, not a fresh disk import.

Cache writers can include another UID with filesystem permission, concurrent
extraction/refresh, or another approved same-UID package process. Disk entry,
relative dependency or MCP entry replacement **after the verified read cannot
substitute executed module source**. Mutation before/during capture either
produces exactly the approved hashed bytes or denies that generation; links,
missing files and mismatches still deny. Snapshot bytes never replace approval,
activation, session ownership, binding/grant, generation or per-operation admission.
An integrity denial requests fencing and acknowledges only according to the
existing observed-exit protocol, without fallback version or successful skip.

This is not a sandbox. Already-approved running code can perform whatever
effects its UID permits, read mutable data with an approved filesystem builtin,
or interfere with same-UID memory/processes where the OS permits. The snapshot
does not defend against in-memory tampering by a same-UID process or undo
previously admitted effects. It specifically closes filesystem substitution
between source verification and Node module loading. The trusted SDK bootstrap,
Node installation and supervisor memory/IPC remain trust anchors; replacing
those is outside the package-cache substitution guarantee.

Named or default-object `createTools`/`createCallbacks` exports must be functions
when present, including when their value is explicitly `undefined` or `null`.
Present `tools`/`callbacks` exports and factory results must be arrays. Malformed
factory exports never fall back to a valid static array; static-only and
factory-only declarations remain supported.

Migration 0088 adds thin table-access procedures for authority/review reads,
registration/process/fencing writes, grants and capability CAS. TypeScript
retains the same barrier-first transaction boundary and row mapping; metadata
reads remain nonlocking. Applied migrations 0084–0087 are unchanged. Their
companion diff documents and `0088_diff.md` describe upgrade/mixed-fleet and
no-destructive-down requirements.

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

Migrations 0084–0088 are additive; histories are not dropped. 0086 adds exact
grants/audit, durable process identities, lifecycle triggers and the legacy-fleet
gate. 0085 reapplication preserves that gate. Downgrading to old workers is unsafe
until executables are disabled and their processes are actually fenced. Retain
review/binding/grant/admission histories; never erase fencing rows as rollback.
No operator environment, live database or deployment was modified for acceptance.

Migration 0087 closes the legacy version-pin activation path: executable and
uninspected targets are rejected even for administrators. They must use exact
administrator activation with digest/revision/pointer CAS and transactional
audit. Existing owner/editor pinning remains available for verified declarative
versions. Content approval alone never authorizes legacy pinning of executable
content.

Named-binding eligibility now has a nonlocking read path throughout its SQL
call chain. Runtime admission uses it under the authoritative barrier; binding
mutations retain their row locks and share the same eligibility rules. A
two-connection regression holds each relevant metadata row, makes a writer wait
for the admission barrier, proves the earlier read completes without deadlock,
then commits disablement and verifies the next admission is denied.

## Current acceptance and remaining gates

The current reviewer follow-up adds verified-buffer execution for module/dependency/
MCP entry imports, presence-sensitive factories, and stored-procedure-only CMS
access. Its acceptance commands are:

```text
npm run build
# From packages\sdk, with Git usr\bin first on PATH and project-owned TEMP/TMP:
node --test --test-concurrency=2 --test-reporter=tap test/unit/*.test.mjs
# Against a task-owned LOCAL SCRAM cluster; never source an operator database URL:
PACKAGE_TEST_PG_URL=<owned-local-url> node --test --test-reporter=tap --test-timeout=120000 packages/sdk/test/postgres/package-runtime.test.mjs
```

Post-verification replacement barriers target the module entry, relative dependency
and MCP entry before actual supervised import. Approved import/factory/callback/
handler counters must advance exactly once and substituted-code counters remain
zero. Malformed factories must reject startup with zero callback/tool invocation
and observed instance fencing. The suite also reapplies 0088 twice, retains the
0087 metadata-writer ordering cases, and checks audit identity/date transport.
Source guards and SQL-shape tests supplement, not replace, standalone PostgreSQL.

Current Windows evidence after the reviewer fixes: root `npm run build` passed;
the complete SDK unit suite passed **1,586 tests, nine explicit skips, zero
failures** (1,595 tests total, Git Bash PATH, concurrency two); the complete
standalone **SCRAM PostgreSQL 18.4** suite passed **69 tests, zero skips/failures**,
including real supervised processes, native MCP and Edge browser acceptance.
All migrations ran on the task-owned localhost-only server, with real
multi-connection races and recovery rather than mocked SQL. The 22 added runtime
cases include three post-check source substitutions, 14 invalid-factory cases,
four static/default-factory positives and one bigint/date transport case.
The server was stopped after acceptance; no operator database or deployment was used.

The final candidate still requires Linux acceptance after these changes, exact
Opus 4.8 review and operational legacy/remote-worker fencing proof. Historical
results below must not be reported as this candidate's qualification.

## Historical acceptance appendix (not final-candidate qualification)

The 0087 review remediation passed the full root build, **1,583 SDK unit tests**
(nine explicit platform skips), and **47 standalone SCRAM PostgreSQL 18.4
runtime tests** (38 top-level cases plus nine nested cases; zero failures/skips).
The latter includes real supervised workers, MCP and browser acceptance.
The targeted catalog/unit subset passed 23 tests and the targeted real-Postgres
subset passed 13; these overlap the broader suites and are not additive.

Before the fix, the legacy-pin regression reproduced a missing rejection after
content approval. The controlled two-connection test reproduced deadlocks for
session, package, owner, version and review rows; the old binding-row-only case
still passed. After the fix all seven row cases pass and deny admission following
committed disablement. Migration reapplication and declarative pin compatibility
are covered. Linux results below predate 0087 and do not certify this follow-up.

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

That earlier fixture used `PS_TEST_DATABASE_URL`; the current suite uses
`PACKAGE_TEST_PG_URL` for a separate task-owned local SCRAM cluster, not trust
authentication or an operator database. A direct probe
confirmed the old passwordless-role/inherited-root-password combination fails
with SQLSTATE `28P01`. The fixture now creates a generated synthetic role password
and forwards that same password. Failed starts are captured for teardown; pool
cleanup runs in `finally`, while failed recovery retains its inventory rather
than deleting rows to pretend fencing completed.

The Linux workflow at `0854f97` predates these corrections and cannot validate
the new code; its failed/hung run is not passing acceptance evidence.
The corrected code at `b358ba1` subsequently passed the
[Linux workflow](https://github.com/seanzqliang/PilotSwarm/actions/runs/39097369867):
root build, pidfd/Python preflight, CI policy/shell checks and **37 standalone
PostgreSQL/runtime/native-MCP/browser cases, zero skips**. The job exited normally.
This is hosted Ubuntu evidence, not certification of a deployment image or AKS.

Edge browser acceptance exercises the React review/activation/revoke/audit UI
against authenticated fixture HTTP plus real SQL, not production Entra middleware.
Separate production Web-runtime authorization tests check server-admin admission.

Counters through real paths prove pending/inactive content has zero imports/
factories/handlers; an approved tool has one import/factory/handler in a non-parent
PID; a no-tools callback can run while its denied tool has zero handlers; caught
denied MCP has zero starts/calls; actual ordinary native MCP has one start and
one call, with zero new model requests/MCP calls after warm revocation.

The secret-free, read-only Linux workflow uses PostgreSQL 17, pidfd/Python and
Edge. It also verified the policy/shell checks that exposed Windows-only POSIX
permission/MSYS/CRLF failures; those Windows results were not counted as passes.
Actual deployment-image prerequisites, external legacy/remote fencing proof and
exact Opus 4.8 review remain gates. This document grants no deployment approval.
