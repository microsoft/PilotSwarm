# Native compute providers

The experimental compute framework runs the agent runtime outside the trusted
worker. **Remote execution uses native session files only.** Worker-backed
SessionFs is removed; an incompatible provider/host never falls back to local
execution. Unselected local sessions keep their existing behavior.

The native state/recovery contract is implemented separately from any particular
cloud provider. It is not a claim that every runtime or deployment is qualified.
The repository's original `process` test provider is not an isolation boundary and
does not supply qualified native writer supervision; a worker refuses it before
launching remote model work. Its process-lifecycle tests remain useful offline.

## What belongs where

| Component | Responsibility |
|---|---|
| Application provider | Implement public `ComputeProvider`, allocate idempotently per target **and logical session**, connect to the common host, and independently verify checkpoint/retirement evidence. Delegated children inherit target authority but have separate environments/homes/processes/databases. |
| Common host | Prepare/import native state, obtain a supervisor barrier, export bounded state and serve existing skill/asset/MCP services. It remains alive while runtime writers stop or pause. |
| Trusted worker | Authorize attempts/callbacks, withhold credentials, validate capture, stage archives, execute epoch-scoped CAS, then complete/settle the winning receipt idempotently. |
| Archive provider | Retain PilotSwarm-accepted archives. Provider-native VM snapshots are not an alternative authority in this contract. |
| Workspace provider | Attach authorized repo/build roots with independent persistence and partial-edit semantics. Those contents do not enter the session checkpoint. |

SDK-native same-process `task` subtasks cannot meet this isolation contract and
are unavailable on native compute targets, even when enabled for local sessions.
The worker records the unavailable capability and excludes that built-in tool.
Use durable delegated sessions, each of which follows the ordinary provider path.

Use only `pilotswarm-sdk` public exports. Install matching verified public release
tarballs as described in [Packages](../../quickstart/packages.md); do not import
private `src`/`dist` paths or maintain a consumer fork. This branch's experimental
API must be included in the selected release before a deployment can consume it.

## Host bootstrap and supervision

`startComputeHost`, `ComputeNativeStateHost`, `ComputeNativeStateClient`,
`ComputeHostNativeFactory`, native profile/supervisor/barrier types and compute
provider/authority types are public. A deployment-owned bootstrap can call the
common host directly or export a typed `createNativeState` factory for:

```text
pilotswarm-compute-host --binding <binding-id> --listen <protected-host:port> \
  --native-module <absolute-path-to-deployment-bootstrap-module>
```

The module is trusted bootstrap code, not an agent-writable repository plugin.
The handshake secret still comes from the host's supported secret channel, never
the command line. No worker database/model credentials belong in that module or
the runtime environment.

The factory returns `ComputeNativeStateOptions` for one session:

- `profile`: stable profile ID, expected controller SDK/runtime versions, named
  absolute native state roots, required files, explicitly declared SQLite
  `databases`, and unsupported features. The session root is a complete tree.
  An additional root may select exact relative `includeFiles`, for example
  `session-store.db`, its optional WAL/SHM sidecars and `config.json` in the
  ancestor native home. Effective file domains must not overlap. Import replaces
  or removes only those selected files, never the ancestor home, session tree,
  host assets or unselected credential files.
- `supervisor.prepare`: establish the actual native home and return the runtime
  address, connection token and generation. A fresh prepare requires empty state
  roots; import replaces only declared state after retirement, never attached repos.
- `supervisor.checkpoint`: obtain an identity-bound **writer hold** or verified
  **stopped-runtime** barrier while the host/export service remains reachable.
- `supervisor.endCheckpoint`: reopen an accepted hold only when the common host
  receives the next admitted identity. Committing a checkpoint parks its barrier;
  it does not permit background native writers between turns.
- `supervisor.retire`: retire the exact runtime/writer generation without treating
  environment deletion as ordinary checkpointing.

`verifyCheckpoint`, `inspectExecution` and `retireExecution` execute on the trusted
provider side. Do not implement them as unconditional success or by echoing a
guest's `quiescent: true`. They must use the deployment's qualified supervision.
The actual connected runtime version is checked before SDK create/resume.

A restart is allowed if required, but neither a restart every turn nor live
process-memory continuity is promised. SDK idle, save, detach, task lists and two
equal copies are not a native checkpoint barrier. `session.rpc.shutdown` has
session-end hook semantics; it must not be used as an automatic per-turn save.
Qualify hook fidelity and the complete native writer scope, including writable
helpers and descendants.

## State and recovery

The native profile must cover enabled required state, not just filenames that
look like a session. Include required runtime-global databases or explicitly
declare the affected feature unsupported; never copy a credential-bearing home.
SQLite databases declared in the profile are integrity-checked in disposable
worker validation copies before archive acceptance. Qualification also needs
real WAL transactions, a supported backup/closure boundary and restored logical
data checks, not comparisons of WAL/SHM filenames.

Transfers reject traversal, links/hardlinks, special files, case collisions,
duplicate entries, changed bytes and host-authored `.ps-*` protocol metadata.
Current buffered transfers have a 64 MiB uncompressed-state/4,096-entry ceiling;
host limits may be stricter. An oversized capture fails explicitly rather than
publishing partial state. This is separate from the read-only skill-copy budget.

The worker's `sessionStateDir/<id>` is staging/cache, not the live remote home.
It reconstructs trusted commit metadata after validating export. The archive's
accepted epoch/version/turnKey/result/receipt is the recovery source. If a
committed native outcome lacks required metadata, recovery fails rather than
rerunning committed model/tools or choosing today's accounting identity.
Worker-owned native metadata also records the profile/version fingerprint and
declared capture locations. Restoring legacy directories without that evidence,
or a different native profile/version, fails rather than silently converting modes.

Completion deduplicates metrics, the completion event and provider settlement in
one CMS transaction. The original owner/provider and absolute ledger coordinate
are frozen before execution. This does not make arbitrary external tool effects
exactly once.
The winning receipt also identifies the original execution. Repair may settle
only its reserved archive-publication/completion operations; it cannot clear
arbitrary failed tools. Retained writers remain under the accepted barrier until
the next admitted preparation. Importing different state requires verified
retirement, and old controller cleanup completes before ownership is released.

## Unknown work and reconciliation

Admission pins asynchronous work and the full archive publication. A stale
connection cannot borrow the next attempt's credentials or callbacks. A timeout,
lost heartbeat or empty archive probe does not authorize replacement.

`PilotSwarmManagementClient.getSessionComputeExecution(id)` exposes durable phase
and unresolved-operation count; the tuner has `read_session_compute_execution`.
`reconcileSessionComputeExecution(id)` requests a trusted worker inspection. It
does not accept user-supplied retirement proof or clear unresolved work. Workers
can release a reconciled generation only after admitted operations have settled
and trusted inspection verifies retirement. Unknown external effects remain
visible and require their own service-specific reconciliation.

Opaque MCP connection forwarding is not per-tool authorization. Destinations
must enforce the vouched caller's operation policy. Active/uncertain forwarded
work must drain or fail capture; it is not silently cancelled into a successful
checkpoint.

## Evidence and rollout

The public-consumer fixture freshly packs and installs the SDK in an owned
consumer directory without package links, verifies required shipped assets and
license, executes the manifest-listed host CLI usage path, typechecks public
exports and exercises the real loopback common host. Its authority/supervision
are fakes. Dependency versions come from the checked-in lock; missing public
cache blobs may be locally repacked from those exact installed public versions,
without registry credentials or TLS changes. Native registered-activity tests cover
prepare, capture, CAS, receipt repair and refusal. Controlled SQLite backup tests
are database consistency evidence for that fixture, not runtime containment.

`test/local/compute-native-writeback.test.js` requires an explicit dedicated
`PS_TEST_DATABASE_URL`; it checks real migration/transaction/concurrent-authority
behavior. It never falls back to a portal or production database.

`test/unit/compute-native-runtime.test.mjs` qualifies one real Windows external-CLI
TCP profile: SDK 1.0.13 / CLI 1.0.83, synthetic loopback inference, a native
PowerShell-launched descendant writer, and a kernel Job Object assigned before
execution with breakaway disabled. The common state service stays outside that
writer scope. SDK event flush precedes controlled termination; kernel membership
must reach zero before export. Two cold archive restores preserve the actual
session tree and global SQLite data/integrity and replace deliberately corrupted
unaccepted native state without touching independent repo or host files.

The observed pinned-runtime baseline is `onSessionEnd("complete")` once per
normal terminal turn. Flush, capture, controlled stop and cold resume add no
calls; routine shutdown of the already-terminal session does not repeat those
callbacks. The fixture does not insert per-checkpoint shutdown RPCs.

This is not warm-process, background-process, FFI-transport, full subagent or
hostile-host containment qualification. Other providers/OS profiles still need
their own supervisor evidence. Windows qualification requires an installed .NET
8+ SDK; fixture builds disable certificate generation, global-tools PATH changes,
telemetry and persistent build servers and use a cleared owned NuGet config.
Exact integrated-head CI remains a separate gate. The candidate native capability is
`pilotswarm.compute.native.v1`; old compute/SessionFs workers do not advertise it.
Historical local orchestration handlers remain registered. This integration
preserves main's migrations 0084-0087 and appends compute targets as 0088 and
native execution/completion as 0089. Orchestration 1.0.83 is frozen and native
work uses 1.0.84. No destructive reset or transparent live-mode conversion is
part of rollout.

## Reproduce the development checks

Use the repository's supported Node engine and lockfile, then build before
running module tests. From a fresh public source checkout:

```text
npm ci
npm run build
npm run test:api --workspace=pilotswarm-sdk
node --test packages/sdk/test/unit/compute-*.test.mjs
```

In an existing checkout, restore dependencies after a manifest change or a
missing-dependency failure rather than replacing local settings. The native
fixtures create owned homes and synthetic loopback model authority. They do not
need `.env`, a private model catalog, a user's global CLI home, a cloud account or
real inference credentials. The public consumer installs an actual local SDK
tarball, not a workspace link.

The real PostgreSQL suite uses only an explicit process-local
`PS_TEST_DATABASE_URL` pointing to an owned disposable test database:

```text
cd packages/sdk
node ../../node_modules/vitest/vitest.mjs run test/local/compute-native-writeback.test.js test/local/compute-targets.test.js
```

Missing database configuration is a coverage gap, not a passing transaction
gate. See [local setup](../contributing/local-ci-and-tests.md); do not point this
at a shared deployment. Run privacy after staging and check diff whitespace.
Use native path separators on Windows.

Windows validation needs actual Git Bash tools for the POSIX-oriented unit
fixtures while native Windows `tar` must handle Windows paths. Set this only
in the test process; do not edit the machine PATH. Some Linux deployment-policy
fixtures assert Unix modes and script behavior and are not qualified by running
them under Windows. Linux CI and each target OS/supervisor remain explicit gates.
The Windows Job Object result must not be presented as qualification of another
host, transport or provider.
