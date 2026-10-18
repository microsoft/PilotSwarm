# Executable published-package trust prerequisite

## Current implementation after foundation `89d3269`

The follow-up implements supervised callbacks, ordinary automatic package MCP,
multi-package exact session grants, administrator-visible fencing, crash recovery
and a fail-closed mixed-fleet activation gate. Changes are published for review in
[PilotSwarm#185](https://github.com/microsoft/PilotSwarm/pull/185).
This is not permission to deploy or a
completed security approval. The exact requested Claude Opus 4.8
completed-candidate security pass is unavailable and has **not** run.

### Content, activation and session authority

Approval accepts immutable canonical package/version/full-tar-SHA bytes.
Dependency/configuration closure is inspected without imports; unverifiable
executable shapes cannot activate. Approval is not activation or session consent.
An approved-but-inactive, unpinned version cannot even register/import.
Declarative-only publication retains its original behavior.

New named sessions pin exact version/SHA/agent/owner. Generic `use_package`
selections persist exact version/SHA/source-ref/owner/tool/MCP/callback grants in
the **same PostgreSQL transaction as capability revision CAS**. A new grant must
target an explicitly active version. Existing exact grants never resolve through
the current active name. V2 approval/rejection leaves V1 active; V2 activation
does not migrate existing bindings. Stale CAS, substituted digests and failed
grant transactions cannot change capabilities or partially replace grants.

Every handler/callback/MCP start/list/call obtains fresh central admission against
live owner, visibility, enablement, content decision, session capability selection,
agent access, registration generation and registry/owner/capability epochs.
Creation-config/root changes also fence registrations. Named pins cannot be
bypassed by asking `SessionManager` to hydrate the same session as a generic
agent. Histories and exact pins are preserved when execution becomes denied.

### Public runtime contracts for cron/activity integration

* `worker.invokePackageCallback(identity, sessionId, name, args, services?)`
  resolves **exact** `{packageId, versionId, sha256}` only, never a name/active
  fallback.
* `SupervisedPackageRuntime.invokeCallback(...)` provides the same contract to
  SDK hosts. `PackageCallbackServices` supplies trusted deployment tool/MCP
  routers; those routers must preserve their own current allowlist/capability
  checks and published-target exact-identity wrappers.
* Package `plugin.json` declares
  `callbacks: {check: {agents:["helper"], tools:["ping"], mcpServers:["demo"]}}`.
  The canonical module exports `createCallbacks` or `callbacks`, an array of
  `{name, handler}` declarations. Factories run in the child, after tools are
  loaded, under separate factory admission. The parent receives no functions.
* A child callback receives JSON args/context and trusted reverse-IPC
  `context.callTool(name,args)` / `context.callMcp(server,method,args)` bridges.
  A no-tools agent may run an explicitly allowed callback but cannot thereby
  acquire tools. Undeclared calls fail before dispatch.
* The trusted parent latches failed, `isError:true`, and unfinished nested calls.
  A callback cannot catch a denied MCP/tool call and convert it into `{skip:true}`.
  The result rejects with
  `code: "PACKAGE_CALLBACK_NESTED_CALL_FAILED_OR_UNFINISHED"`. Callers must treat
  this as failure/defer, **never skip**. Unfinished calls cancel the generation.
* `PackageRuntimeAuthority.withAdmission` remains the independent authoritative
  admission contract; callback integrations should use the supervised callback
  API rather than transporting package function objects into an activity.

Callback agent declarations apply even to explicitly selected callbacks.
Cross-published-package named-agent callback bindings are rejected; unbound or
trusted deployment sessions must explicitly match the declared agent name.
This branch intentionally does not implement cron scheduling or alter #180.

### Ordinary MCP, not a raw-command fallback

Supported package MCP is `node` plus an exact packaged ESM entry, fixed reviewed
args/environment and verified static imports. Worker registration stores only an
exact-identity **marker**. Raw package `.mcp.json` commands never reach native
Copilot startup. Before SDK hydration, a trusted loopback HTTP MCP adapter binds
an unguessable token to the exact durable session/package/server/generation.
Every request reauthorizes. Server instances are distinct per session. Stable
tokens preserve warm SDK sessions; a generation change cannot revive an old one.
MCP executes in a broker-owned child, recorded while idle before code starts.

Only initialize/ping/initialized notifications/tools-list/tools-call are supported.
Remote package MCP, shell commands, npm/bare imports, vendored node_modules,
dynamic executable/dependency loading, native/WASM payloads, arbitrary hooks,
wildcard/unknown worker entry exports and undeclared callbacks are rejected.
Native inline-agent package MCP is not supported; affected sessions disable native
inline subagents rather than lending them a parent's durable identity. Known
trusted deployment plugins remain unchanged.

### Revocation, crash recovery and honest completion

SQL decisions and lifecycle changes order with admissions through the same
schema-scoped barrier. Revocation denies new admissions first, then responsive
brokers kill owned package/MCP children, including synchronous infinite loops.
Executable dispatch has a one-second deadline; trusted **idle preparation**
has a separate bounded 30-second deadline and cannot import/execute package code.
Previously admitted effects may occur until fencing completes and cannot be
undone. This is runtime supervision of trusted JS, **not a sandbox**.

Migration 0086 records host boot/PID-namespace identity and process start tokens.
Recovery denies the generation, freezes/observes the recorded broker exit,
then reads the final durable child inventory and terminates exact owned processes.
Acknowledgement independently checks that recorded package processes have exited;
a caller-supplied `true`, expired lease or changed heartbeat is not proof.
Windows recovery retains a native process handle through identity checking/kill.
Linux recovery uses pidfd via the trusted `/usr/bin/python3` helper
(Python 3.9+, kernel pidfd support); missing support fails closed before package
registration. Linux execution/recovery is **not validated by Windows evidence**.
Executable supervision currently supports Windows/Linux only; other operating
systems reject registration. Declarative-only packages do not require supervision.

A surviving broker retries durable acknowledgement after database outages;
package children die before retry. Windows/libuv may terminate the entire child
job when a worker dies, so another worker's local recovery must observe and record
those exits rather than inventing the missing broker acknowledgement.
Unreachable hosts/PID namespaces remain incomplete: no local code can honestly
prove their processes dead.

`package_runtime_legacy_workers` blocks executable activation/admission while any
pre-protocol worker remains unverified, including after migration reapplication.
A protocol-1 heartbeat does not certify an older uncontrolled process dead.
There is deliberately **no request-supplied "fenced" override**. Clearing an
unknown legacy/other-host fence requires a trusted deployment-specific external
fencing verifier/control-plane integration; none is configured or certified here.
That operational prerequisite cannot be inferred from stale CMS worker records.

### Administrator surfaces

Review rows include live `runtimeFencing: {denied,complete,outstanding}`. The
Pending Approval tab displays it and refreshes after decisions. Existing
management/Web/CLI/MCP review surfaces carry the same status. For identities
whose package was deleted, authenticated fleet administrators can use:

* `getAgentPackageRuntimeStatus(identity)` (management/Web API);
* `pilotswarm agents runtime-status <package> <version> <sha>`;
* `get_agent_package_runtime_status` (MCP).

Decision/activation mutation responses still do not claim execution permission or
fencing completion; read current status. Client `isAdmin`/actor fields never become
server authority. Cluster-scoped administrators cannot use global trust decisions.

### Migration and rollback impact

0086 is additive: exact grant/history tables, durable process identities,
legacy-fleet gate and lifecycle triggers. 0085's eligibility bootstrap preserves
0086's fleet gate on reapplication. No data/history is dropped. No operator/live
database, deployment, environment inventory or other worktree was touched.
Rollback to old workers is unsafe until executables are disabled and actual
fencing verified; retain review/binding/grant/admission histories. Do not erase
legacy fencing rows to bypass the activation gate.

### Follow-up validation and remaining gates

The final local verification matrix is:

| Command | Result |
|---|---|
| `npm run build` (root workspace build) | Pass; Vite reports its large-chunk advisory, no build failures |
| `npm run build --workspace=packages/sdk` | Pass |
| `npm run build --workspace=pilotswarm` | Pass |
| `node --test --test-concurrency=1 packages\sdk\test\postgres\package-runtime.test.mjs` | **34 pass, zero failures/skips**, standalone PostgreSQL 17.11 |
| `node --test --test-reporter=spec` with the exact focused files below | **207 pass, zero failures/skips** |
| From `packages\sdk`: `node ..\..\node_modules\vitest\vitest.mjs run test\local\agent-binding-refresh-runtime.test.js --reporter=verbose` | **3 pass, zero failures/skips** |
| `git diff --check` | Pass |

Exact focused Node selectors, supplied together to the command above:

```text
packages\sdk\test\unit\agent-package-authorization.test.mjs
packages\sdk\test\unit\agent-package-review-catalog.test.mjs
packages\sdk\test\unit\session-agent-binding-lifecycle.test.mjs
packages\sdk\test\unit\package-tool-binding.test.mjs
packages\sdk\test\unit\agent-package-format.test.mjs
packages\sdk\test\unit\agent-package-extraction.test.mjs
packages\sdk\test\unit\api-surface-contract.test.mjs
packages\sdk\test\unit\web-client-op-coverage.test.mjs
packages\sdk\test\unit\cms-migrations-shape.test.mjs
packages\sdk\test\unit\pg-migrator.test.mjs
packages\sdk\test\unit\package-runtime-format.test.mjs
packages\app\web\test\agent-package-review-authz.test.mjs
packages\app\ui\core\test\package-review-tabs.test.mjs
packages\app\ui\core\test\agent-packages-admin.test.mjs
packages\app\tui\test\package-transport-arity.test.mjs
packages\app\mcp\test\unit\agent-package-reviews.unit.mjs
```

The standalone suite uses isolated local PostgreSQL 17.11, independent real
connections and child processes, actual worker/Copilot SDK/CLI MCP startup,
and a real Edge browser/React review UI against authenticated HTTP + real SQL.
The browser fixture is not production Entra middleware; separate Web authorization
tests exercise the production runtime's server-admin gate.
Review decision CAS, additive migrations/reapplication, activation, immutable pins,
multi-package grant rollback, concurrent admission/revoke, broker database outage
and two independently blocked worker-host processes are **real PostgreSQL**
acceptance, not mocked/PGlite/source-shape substitutes.

Counter assertions through real loader/handler/startup paths:

| Path | Observed/asserted counters |
|---|---|
| Pending or approved-but-inactive package | Zero imports, factories and handlers |
| Approved/activated exact tool binding | One import, one factory, one handler; same child PID, different from parent |
| No-tools callback, then caught denied tool | One import, one tool factory, one callback factory, two callbacks, **zero tool handlers** |
| Owner change after callback | Zero additional imports/factories/callbacks/handlers |
| Caught denied callback MCP call | One callback; **zero MCP starts/calls**; no fabricated skip |
| Actual worker/native SDK ordinary MCP | One server start, one call; warm SDK handle reused; revoke adds **zero model requests or MCP calls** |
| Two blocked supervised handlers, revoke | Exactly two handlers and imports; no third import/handler; both exits required for complete status |

Earlier full runs exposed and fixed Windows browser-cleanup retries, the separation
of trusted preparation from the executable dispatch deadline, and an unreachable-
worker fixture that omitted the now-required explicit activation. These failures
were investigated rather than dismissed; the final rerun is the acceptance result.
The final disjoint total is **244 passing tests** (34 + 207 + 3). The standalone
database has zero remaining fixture schemas, temporary broker roles or broker
connections; process inspection found no surviving owned package, Copilot or
browser processes. Only task-owned test artifacts are removed during cleanup.

Remaining external/unsupported boundaries are explicit: the exact Opus 4.8 review,
Linux/pidfd CI evidence, trusted external proof for unknown legacy/other-host
workers, unsupported executable shapes and parent cron integration. No deployment,
commit or push is authorized by this implementation report.

### Exact follow-up changed-file inventory

Relative to committed foundation `89d3269`; all remain uncommitted. The four
files marked `NEW` are additions, not generated runtime/cache artifacts.

```text
docs\building-agent-packages.md
docs\proposals\agent-packages.md
docs\proposals\executable-package-authorization.md
packages\app\mcp\src\tools\agent-packages.ts
packages\app\mcp\test\unit\agent-package-reviews.unit.mjs
packages\app\tui\src\agents-cli.js
packages\app\tui\src\node-sdk-transport.js
packages\app\ui\react\src\package-review-tabs.js
packages\app\web\runtime.js
packages\app\web\test\agent-package-review-authz.test.mjs
packages\sdk\api\src\http-api-transport.js
packages\sdk\api\src\protocol.js
packages\sdk\src\agent-package-authorization.ts
packages\sdk\src\agent-package-installer.ts
packages\sdk\src\agent-package-review-store.ts
packages\sdk\src\capability-catalog.ts
packages\sdk\src\capability-runtime.ts
packages\sdk\src\cms-migrations.ts
packages\sdk\src\cms.ts
packages\sdk\src\index.ts
packages\sdk\src\management-client.ts
packages\sdk\src\migrations\package-runtime-0085.ts
packages\sdk\src\migrations\package-runtime-0086.ts NEW
packages\sdk\src\package-runtime-authority.ts
packages\sdk\src\package-runtime-broker.ts
packages\sdk\src\package-runtime-child.ts
packages\sdk\src\package-runtime-format.ts
packages\sdk\src\package-runtime-mcp-child.ts NEW
packages\sdk\src\package-runtime-mcp-gateway.ts NEW
packages\sdk\src\package-runtime-process.ts NEW
packages\sdk\src\package-runtime-supervisor.ts
packages\sdk\src\session-manager.ts
packages\sdk\src\web\generated-op-methods.ts
packages\sdk\src\web\web-management-client.ts
packages\sdk\src\worker.ts
packages\sdk\test\postgres\package-runtime.test.mjs
packages\sdk\test\unit\package-runtime-format.test.mjs
packages\sdk\test\unit\session-agent-binding-lifecycle.test.mjs
```

<details>
<summary>Historical foundation evidence at committed 89d3269 (superseded by the follow-up above)</summary>

**Status: independently testable, bounded runtime tranche; NOT the completed
platform prerequisite or release/security approval.** This implementation is
being published for review; nothing has been deployed. It is general
published-package trust, not cron-specific.
The exact requested completed-candidate Claude Opus 4.8 review is unavailable
and has NOT run. Cron #180 remains blocked.

## Implemented trust boundaries

1. **Data-only content inspection.** The entire uncompressed canonical tar
   SHA-256, package/version identity and every file/configuration byte are
   inspected without imports, factories, callbacks or server startup. Ambiguous
   paths, symlinks, reserved cache metadata and substituted identities are denied.
   Private/shared scope and `enabled` never substitute for approval.
2. **Immutable review.** Additive migration 0084 provides pending, approved,
   rejected and revoked candidates with exact identity/revision CAS and atomic
   append-only actor/time/reason/before/after audit. Inspection and version bytes
   are immutable. Existing executable versions are pending/uninspected, never
   grandfathered. A trusted installer may attach the first inspection only from
   verified actual artifact bytes. Declarative-only publication retains existing
   automatic activation; executable publication never changes the active pointer.
3. **Separate activation and pins.** Exact review/activation revision and prior
   pointer CAS explicitly activates an eligible version. Approved/rejected v2
   leaves v1 active until explicit activation. Existing session pins never
   change when the pointer changes. Pins contain exact package/version/full SHA,
   named agent, effective owner and binding revision. New explicit package
   sessions pin transactionally at creation; historical unbound sessions need
   an explicit audited admin revision-zero rebind. No silent latest-version
   resolution or shadow-package fallback.
4. **Current eligibility.** `SessionManager` checks durable pins before hydration
   and warm reuse. Runtime tool handlers independently check PostgreSQL authority
   on every invocation, not only orchestration/model admission. Current live
   session/root owner, visibility, enablement, review, exact agent declaration,
   binding, registration generation and registry/owner/capability epochs must
   match. Only explicitly declared tools of that exact bound agent are admitted.
5. **Fresh materialization verification.** Installer refresh redownloads/verifies
   the artifact and compares every materialized file. Supervisor startup checks
   the authoritative immutable inspection and every local file again, including
   configuration and dependencies. MCP startup rechecks materialization.
   `.pilotswarm-meta.json` is diagnostic only. Failed/missing bytes deny rather
   than trusting warm metadata. Trusted host filesystem integrity is assumed:
   this is not a filesystem sandbox against another privileged local process.
6. **Supervision, not parent imports.** The trusted worker forks a trusted broker,
   which forks a package execution child. Only the execution child imports
   package modules, runs factories and retains handlers. Parent receives JSON
   declarations/results and proxy handlers, never package functions. Import and
   factory/declaration phases receive separate fresh authoritative admissions.
   Worker cold/forced-warm refresh and shutdown own/stop previous generations.
   Trusted operator deployment plugins/`--worker` modules are unchanged.
7. **Deny-first revocation and observed fencing.** Migration 0085 adds durable
   registration generations, leases, admission/fence audit and lifecycle triggers.
   Review changes, disable/delete/owner/scope/active-pointer changes, rebind,
   effective-owner changes, capability changes and session deletion invalidate
   relevant generations before committing. New admissions deny immediately.
   Responsive brokers kill owned execution/MCP processes even when package JS
   is in a synchronous infinite loop. A registration becomes `fenced` only after
   trusted broker evidence of all owned child exits and broker exit observation.
   Unreachable/expired registrations NEVER become completed fences automatically.

## Supported and deliberately unsupported executable shapes

`verifyPackageRuntime` is a conservative dependency/configuration eligibility
policy, not a proof that arbitrary JavaScript is harmless.

| Shape | This tranche |
|---|---|
| Declarative-only prompt/skill packages | Preserved without executable approval |
| `tools/worker-module.mjs` | Supported after approval + explicit activation |
| Canonical `.js` module | Requires packaged nearest `package.json` with `"type":"module"`; ambient module configuration denied |
| Named/default `createTools({workerNodeId})`, named/default `tools` array | Supported; JSON tool declarations and JSON arguments/results only |
| Static relative imports | Only exact packaged `.js`/`.mjs` dependencies; all code parsed, all artifact bytes pinned |
| Builtin APIs | Explicit subset: `node:fs`, `node:fs/promises`, `node:path`, `node:os`, `node:crypto`, `node:util`, `node:process`, `node:timers`, `node:timers/promises`, `node:events`, `node:buffer`, `node:readline`, `node:stream`, `node:url`, `node:assert`, `node:assert/strict` |
| Named bound-agent tool invocation | Supported through real worker loader and fresh PostgreSQL admission |
| Stdio package MCP through `SupervisedPackageRuntime.startMcp/callMcp` | Supported lower-level API; exact session pin and server permission checked for each start/list/call; one starting session per server/generation |
| Automatic package MCP registration into Copilot/plugin MCP catalog | **Denied as a whole package**; no raw configuration reaches normal startup |
| Remote MCP, shell/arbitrary command, native executable, external executable dependency | Explicitly rejected |
| npm/bare imports, vendored `node_modules`, dynamic import/eval/native/process loading | Explicitly rejected |
| `.cjs`, TypeScript source, native/WASM payloads, unknown executable files | Explicitly rejected |
| Dynamic/computed executable/dependency shapes, unsupported manifests/hooks | Explicitly rejected, not silently loaded |
| Free-form handlers/prechecks/cron callbacks | Not implemented here; declared callback exports/configuration rejected |
| Generic-agent or another-package `use_package` executable selection | Denied: this tranche has one named bound-package pin per session, not a multi-package executable grant model |
| SDK/facts/worker objects, closures, functions crossing IPC | Unsupported; factory context is JSON `{workerNodeId}` only |
| Ambient worker environment or `${VAR}` command expansion | Not inherited; minimal host plumbing plus fixed reviewed MCP string environment only; runtime-loader overrides denied |

Unsupported dependency/configuration shapes can receive an **artifact-content**
review decision, but have no verified execution descriptor and cannot activate,
bind or execute as executable packages. Approval is never an invocation grant.
Archive-format validation warnings are not executable eligibility.

## Central ordering, cancellation and audit guarantees

`PgPackageRuntimeAuthority` uses one schema-scoped PostgreSQL advisory transaction
barrier. Admission and decisions/lifecycle mutation triggers serialize through
that barrier. Each admission transaction checks authoritative rows, records an
`admitted` event, then commits before synchronous IPC enqueue. A one-second
dispatch deadline is retained through parent/broker/execution-child dispatch;
delayed queued starts expire rather than acquiring an unbounded cached grant.
Long-running admitted operations have a separate 30-second cancellation timeout.
Statement/lock timeouts fail closed; deadlock/serialization victims deny rather
than retrying already admitted side effects.

An operation ordered **before** revocation may begin/issue effects while fencing
is still pending. Revocation completion is NOT its decision-transaction commit.
After commit new admissions deny, supervisors stop owned work, and completion
requires real exit acknowledgements. Audit records import, factory, tool, MCP
start/list/call admissions and completion/failure/cancellation boundaries, plus
registration/generation/session/effective-owner identity. This is admission-order
audit, not a general external-effect ledger.

The parent renews broker watchdogs only after authoritative heartbeat succeeds.
The broker executes no package code, so a package's synchronous JS does not
block its watchdog/kill path. Parent IPC loss also stops broker-owned children.
Leases suppress further admissions; they are **not** evidence of process death.
`fencingStatus(identity)` reports global identity revocation/disable/delete
completion only when denied and no registration remains unfenced. Owner and
capability changes fence affected generations conservatively; another owner's
new registration does not mean the entire approved package identity is revoked.

**Approved JavaScript remains trusted code, NOT a sandbox.** Allowed filesystem
and other trusted Node APIs retain their normal privilege. Static restrictions
are dependency eligibility checks, not adversarial JavaScript containment.
Killing processes cannot undo previously admitted filesystem/network/external
effects. No hermetic OS closure, generalized effect mediation or arbitrary-effect
ledger is asserted or required by this tranche.

### Failure and remaining integration boundaries

- Unexpected broker death without descendant-exit evidence remains **incomplete**
  centrally, even if IPC disconnect normally cleans up cooperative children.
  No synthetic acknowledgement is generated. Durable crash recovery/operator
  proof of orphan descendant termination is not implemented.
- If local exits are observed while PostgreSQL is unavailable, acknowledgement
  can fail. Completion remains unknown/pending; automatic durable retry/recovery
  of that acknowledgement across parent restarts is not implemented.
- Registry changes conservatively invalidate generations. Default worker refresh
  installs only active versions; a v1 session encountering a v2-only registry is
  denied, not upgraded. The lower-level authority can explicitly register an
  approved v1 for its immutable pins; automatic retained-version registration
  in the default worker is not implemented.
- Full source-selection capabilities and multiple package pins per session are
  not integrated. Existing bound-agent tools are baseline capabilities; a changed
  capability revision fences the old generation. This does not claim support
  for arbitrary executable `use_package` selection.
- Default Copilot MCP transport/discovery still needs a session-aware supervised
  adapter. Until then automatic executable MCP packages are quarantined entirely.
- Generic supervised callback/precheck registration/dispatch remains to be added
  before cron can consume this prerequisite. Do not directly call imported
  callbacks in the worker.
- Administration responses report `runtimeFencing: "not-reported"`, NOT complete.
  Authenticated Web/CLI/MCP/UI do not yet expose/wait for runtime fencing status
  or cancellation acknowledgement. The lower-level provider-neutral status API
  is tested; the full requested administration workflow remains incomplete.
- Exact requested Claude Opus 4.8 completed-candidate security review remains an
  external release gate. Initial review was not that pass.
- Already-running pre-protocol workers are not registered/fenced by this
  protocol. The legacy cold-install SQL endpoint excludes executable/uninspected
  versions, while new workers use the runtime-aware endpoint. This does not
  terminate old warm closures. A measured fleet-upgrade/drain barrier is still
  required before executable activation in an existing deployment; mixed-fleet
  safety/automatic activation gating is not implemented or claimed.

These are concrete unimplemented user requirements/integration gaps, not a
request for another sandboxing architecture decision. Do not publish this as the
completed prerequisite or unblock cron based on this tranche alone.

## Administration and provider-neutral contracts

`AgentPackageReviewCatalog`: authenticated admin list, immutable decision CAS,
audit, explicit activation CAS/audit, binding lookup and explicit rebind.
`PackageRuntimeAuthority`: register, current session context, separate import/
factory admission, per-invocation `withAdmission`, heartbeat, request/acknowledge
fence and truthful `fencingStatus`.
`SupervisedPackageRuntime`: start/load, JSON-only proxy tools, `invoke`,
session-bound `startMcp/callMcp`, and stop/observed fencing.

New catalog providers omit unsupported authority rather than approving execution.
`PgSessionCatalog.packageRuntime` supplies the PostgreSQL implementation.
The default worker passes that authority to the installer/public tool loader;
a cached approved flag without it cannot execute.

Authenticated HTTP routes (also exposed by management/Web/native transport,
CLI and MCP) are:

```text
GET  /api/v1/agent-package-reviews
POST /api/v1/agent-package-reviews/decision
GET  /api/v1/agent-package-reviews/<versionId>/audit
POST /api/v1/agent-package-reviews/activation
GET  /api/v1/agent-package-activations/<packageId>/audit
GET  /api/v1/agent-package-bindings/<sessionId>
POST /api/v1/agent-package-bindings/rebind
```

Decision inputs require package/version/full SHA/expected revision/decision/reason.
Activation additionally requires exact review revision, activation revision and
prior pointer. Rebind requires session, exact identity, named agent, saved binding
revision and reason. Server-authenticated administrator identity is authoritative;
request-body `isAdmin`/actor values are ignored. Anonymous or cluster-scoped
administrative trust operations deny. Database service credentials remain
privileged and are not an authenticated end-user identity.

The admin UI has **Private / Pending Approval / Shared** tabs, reviewable contents,
digests, publisher/reasons/prior active, decisions, explicit activation/rebind and
audit. CLI:

```text
pilotswarm agents reviews
pilotswarm agents review <package> <version> <sha> <revision> approved|rejected|revoked "reason"
pilotswarm agents review-audit <version>
pilotswarm agents activate <package> <version> <sha> <review-revision> <activation-revision> <prior-version|none> "reason"
pilotswarm agents activation-audit <package>
pilotswarm agents binding <session>
pilotswarm agents rebind <session> <package> <version> <sha> <agent> <binding-revision> "reason"
```

MCP equivalents: `list_agent_package_reviews`, `decide_agent_package_review`,
`get_agent_package_review_audit`, `activate_agent_package_version`,
`get_agent_package_activation_audit`, `get_session_agent_package_binding`,
`rebind_session_agent_package`. CLI trust administration requires authenticated
Web mode. A successful mutation is not an execution grant/fencing completion.

## Migrations and rollback

0084/0085 are additive, retaining histories and existing declarative behavior.
0085 adds registration/admission audit and session owner/capability epochs.
Ordered reapplication preserves decisions, audits and real admission functions;
0084 bootstrap stubs never replace installed 0085 authority.

Do not drop/truncate histories to roll back. Before deploying older workers,
disable executable packages and obtain actual fencing acknowledgements. Older
unmodified workers can bypass this feature's guards; mixed old/new fleets are
not certified safe. Rolling back application binaries alone is unsafe once
executable versions have been explicitly activated. No migration or rollback has
been run against operator/live state.

## Acceptance evidence

Two different database evidence classes are intentionally distinguished:

- **22 foundation catalog tests** run actual SQL/functions/triggers and complete
  ordered legacy migrations in PGlite's PostgreSQL engine. They are not merely
  mocks, but they are not a standalone multi-connection server.
- **16 runtime acceptance tests** use an actual isolated local **PostgreSQL
  17.11 x86_64-windows server**, multiple independent `pg` connections, full CMS
  migrations, real worker loaders, real brokers/execution/MCP processes, exact
  decision/activation/binding CAS and advisory-lock races. No PGlite or mocked
  SQL authority is used in this suite.

Real counters/evidence:

| Path | Observed result |
|---|---|
| Pending candidate startup | import/factory/handler counters all zero |
| Approved exact module, then one authorized call | 1 import, 1 factory, 1 handler; same child PID, different from worker PID |
| Actual worker cold + forced-warm loader | 2 imports, 2 factories, 2 handlers, all child-only; revoke/refresh adds zero |
| Two supervisors entering synchronous handler loops | 2 imports, 2 factories, 2 handler starts; revoke kills both; both calls fail; zero new starts; completion only after two real fence acknowledgements |
| Version/owner/capability/generation/review/registry/digest substitutions | zero callback admissions |
| MCP start/list/call | 1 separate MCP process startup, 1 call; denied starts/calls add zero |
| Synchronous MCP loop | call really starts, broker kills process on revoke, acknowledgement requires observed exit |
| Unreachable expired registration | denied=true, complete=false, outstanding=1; no fabricated fencing |
| Warm bytes/descriptor substitution | zero imports before denial |
| Approval/activation/pins | v2 approval is not activation; explicit v2 activation affects new bindings only; rejected v3/stale CAS cannot replace it |

Validation commands, from repository root unless noted:

```powershell
npm run build --workspace=packages/sdk
npm run build --workspace=pilotswarm
# Local standalone server must already be running; never use operator DB credentials.
$env:PACKAGE_TEST_PG_URL = 'postgresql://package_test@127.0.0.1:55439/postgres'
node --test --test-reporter=spec packages\sdk\test\postgres\package-runtime.test.mjs
# 16 real-PG tests. No skipped tests.

# Run legacy extraction/native tests with TEMP/TMP redirected to a NEW,
# exclusively task-owned worktree directory; restore environment and remove
# only that exact owned directory afterward.
node --test --test-reporter=spec packages\sdk\test\unit\agent-package-authorization.test.mjs packages\sdk\test\unit\agent-package-review-catalog.test.mjs packages\sdk\test\unit\session-agent-binding-lifecycle.test.mjs packages\sdk\test\unit\package-tool-binding.test.mjs packages\sdk\test\unit\agent-package-format.test.mjs packages\sdk\test\unit\agent-package-extraction.test.mjs packages\sdk\test\unit\api-surface-contract.test.mjs packages\sdk\test\unit\web-client-op-coverage.test.mjs packages\sdk\test\unit\cms-migrations-shape.test.mjs packages\sdk\test\unit\pg-migrator.test.mjs packages\sdk\test\unit\package-runtime-format.test.mjs packages\app\web\test\agent-package-review-authz.test.mjs packages\app\ui\core\test\package-review-tabs.test.mjs packages\app\ui\core\test\agent-packages-admin.test.mjs packages\app\tui\test\package-transport-arity.test.mjs packages\app\mcp\test\unit\agent-package-reviews.unit.mjs
# 199 tests: 179 foundation + 14 closure policy + 6 migration regressions.
# From packages\sdk:
node ..\..\node_modules\vitest\vitest.mjs run test\local\agent-binding-refresh-runtime.test.js --reporter=verbose
# From root:
git diff --check
```

Final Node selection: 199 focused regressions plus 16 standalone PostgreSQL
acceptance tests, all passing, zero failures/skips. Together with the 3 native
tests, **218 tests pass**. SDK and complete application builds, editor diagnostics
and `git diff --check` also pass. Native SDK/CLI lifecycle selection: 3
Vitest tests with local scripted inference and mocked catalog bindings. Those
three native tests do not prove PostgreSQL fencing; the standalone suite does
exercise the bounded implemented fencing protocol.

Local test processes are stopped and task-owned fixture schemas/directories
cleaned; zero owned broker/execution/MCP processes remained. The exact isolated
PostgreSQL server was shut down with `pg_ctl -D .test-postgres-data -m fast -w stop`.
Its task-owned archive/tools/data were removed afterward, not operator state.
No deployment, image push, remote
database access, commit or PR publication is authorized by this report.

Dependency install reported 61 npm audit alerts (5 low, 27 moderate, 28 high,
1 critical); this tranche does not claim independent dependency-security
clearance or complete-platform security approval.

## Exact changed-file inventory

All 42 files are under `C:\Source\PilotSwarm-package-authorization`; changes remain
uncommitted. Operator environments and other worktrees were not modified.

```text
docs\building-agent-packages.md
docs\proposals\agent-packages.md
docs\proposals\executable-package-authorization.md
package-lock.json
package.json
packages\app\mcp\src\tools\agent-packages.ts
packages\app\mcp\test\unit\agent-package-reviews.unit.mjs
packages\app\tui\src\agents-cli.js
packages\app\tui\src\node-sdk-transport.js
packages\app\ui\core\test\package-review-tabs.test.mjs
packages\app\ui\react\src\package-review-tabs.js
packages\app\ui\react\src\web-app.js
packages\app\web\runtime.js
packages\app\web\test\agent-package-review-authz.test.mjs
packages\sdk\api\src\http-api-transport.js
packages\sdk\api\src\protocol.js
packages\sdk\package.json
packages\sdk\src\agent-package-authorization.ts
packages\sdk\src\agent-package-installer.ts
packages\sdk\src\agent-package-review-store.ts
packages\sdk\src\agent-package-service.ts
packages\sdk\src\cms-migrations.ts
packages\sdk\src\cms.ts
packages\sdk\src\index.ts
packages\sdk\src\management-client.ts
packages\sdk\src\migrations\executable-package-reviews-0084.ts
packages\sdk\src\migrations\package-runtime-0085.ts
packages\sdk\src\package-runtime-authority.ts
packages\sdk\src\package-runtime-broker.ts
packages\sdk\src\package-runtime-child.ts
packages\sdk\src\package-runtime-format.ts
packages\sdk\src\package-runtime-supervisor.ts
packages\sdk\src\session-manager.ts
packages\sdk\src\web\generated-op-methods.ts
packages\sdk\src\web\web-management-client.ts
packages\sdk\src\worker.ts
packages\sdk\test\local\agent-binding-refresh-runtime.test.js
packages\sdk\test\postgres\package-runtime.test.mjs
packages\sdk\test\unit\agent-package-authorization.test.mjs
packages\sdk\test\unit\agent-package-review-catalog.test.mjs
packages\sdk\test\unit\package-runtime-format.test.mjs
packages\sdk\test\unit\session-agent-binding-lifecycle.test.mjs
```

</details>
