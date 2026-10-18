# Executable published-package trust prerequisite

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
