# Formal models (TLA+) of the PilotSwarm orchestrations

This folder holds TLA+ models of the core PilotSwarm orchestrations, with the
case tables, runners and settings templates to check them with TLC. A TLC pass is a
**bounded check, not a proof**: it explores a small, finite version of the
model. A violation is a counterexample of the model; it needs a check against
the code before it is called a bug.

## 1. Orchestration areas and model folders

There are three core areas:

1. The **durable session orchestration** (`packages/sdk/src/orchestration.ts`,
   `orchestration*/` files, `orchestration-registry.ts`).
2. The **Workflow controller and store** (`packages/sdk/src/workflow/`:
   `runtime.ts`, `store.ts`, `parallel.ts`).
3. **Session hydration and dehydration**: the dehydrate, hydrate and
   checkpoint activities and the snapshot commit in
   `packages/sdk/src/session-proxy.ts` and `session-manager.ts`; the
   orchestration's dehydrate and rehydrate paths in
   `packages/sdk/src/orchestration/lifecycle.ts`; the `shouldRehydrate` timers;
   the rehydration messages carried across continue-as-new. Its models live in
   `session-orchestration/`.

| Orchestration area | Model folder | Modules | Main code files | Binding head | Last full TLC run |
|---|---|---|---|---|---|
| Durable session orchestration: turn loop, turn commit, timers, child delivery, delivery identity; 1.0.83 owned retry and intake run loop; worker shutdown; 1.0.83 as the latest version (hand-off from 1.0.82, deploy, digest window, prompt merge rule, forced refresh) | `session-orchestration/` | `TurnLoop`, `TurnCommit`, `TimerGeneration`, `TimerHandoff`, `TimerInterrupt`, `TimerStarvation`, `ChildDelivery`, `DeliveryIdentity`; `OwnedRetry`, `IntakeDrain`, `WorkerShutdown`, `CarriedGiveBack`, `VersionHandoff`, `RollingDeploy`, `DigestWindow`, `MergeRule`, `ForcedRefresh` | `orchestration/{queue,turn,lifecycle,agents,state}.ts`, `orchestration-registry.ts`; `orchestration_1_0_83/{queue,turn,lifecycle,state,runtime,intake-state,intake-wiring}.ts`, `activity-routing.ts`, `worker.ts` | `198ad79a` (orchestration 1.0.82; the same code on main and at `e76a6133`); `e76a6133` for the 1.0.83 run loop (behind the Workflow test option) and the worker shutdown; `bb162ed8` (identical at `8aaf5435`, v0.8.10) for `CarriedGiveBack` | 2026-10-27: 38 cases, 21 PASS, 17 FAIL (12 describe the code: 7 likely bugs, 5 design limits; 5 deliberate faults); all matched their predictions. 2026-11-08, so3: 36 of 36 as expected, two design limits, both accepted as known limits (a 1.0.83 session fails at its first continue-as-new while 1.0.82 is the latest version; a legacy session's dehydrate cut by the shutdown deadline loses its local state if the worker folder does not survive), no new code finding. so4b to so5b: the 1.0.83 late-cancel give-back; three code findings fixed in place, so5b 48 of 48 as expected. ws2 (final review): `WorkerShutdown` with steps started after the deadline and overlapping, 11 of 11 as expected. Re-run on v0.8.10 (`8aaf5435`): all as expected. Latest-1.0.83 batch (to `91def26a`): every case as expected; findings fixed (sender stamping, the frozen 1.0.82 entry, a person's quoted runtime header); known limits: a rolling version flip, 1.0.82-queued prompts; tf1 (2026-11-10, an agent child's turn that fails terminally, bound to `2a6e6912`): 63 of 63 and 72 of 72 as expected |
| Workflow core: run, wait, admission, lifecycle, session commands, receive, send | `workflow/` | `WorkflowRun`, `Wait`, `Admission`, `Lifecycle`, `SessionCommands`, `Receive`, `Send` | `workflow/runtime.ts`, `store.ts`, `service.ts` | `9fcbf377` | 129 cases (4 retired in the version collapse); no complete run recorded in the folder's notes |
| Workflow execution graph, agent children, parent queue, recover, paging, paused runs, tool-session lease | `workflow/orchestration/` | `WfGraph`, `WfAgent`, `WfParent`, `WfRecover`, `WfPaging`, `WfPaused`, `WfExecutor`, `WfExecLease`, `WfExecShare` | `workflow/runtime.ts`, `store.ts`, `agent-node-service.ts` | `efe44835`, final heads `1f7bdc77`, `a10c2e07`, `8dd3eae1` and later; `9a8d0f66` for `WfGraph`, `WfParent`, `WfPaused`, `WfExecShare` (r3), their fixes at the code of `2a6e6912` (r4); `WfAgent`, `WfRecover`, `WfPaging` hold for agent sessions that are new per visit; `WfExecutor`, `WfExecLease` are history | r2-final packet (160 of 188 cases): 158 as expected, 2 mismatches (both explained in the folder's README); the other 28 cases have no recorded result. 2026-11-09, r3: 196 of 202 as expected at 300 s; liveness cases re-run at 1,800 s (two not checked); 2 expected values corrected; three findings (a timed cut leaves a decided agent child running; a deletion after another end drops its parent notice; the parent told twice after a crash); r4: the fixes bound at the code of `2a6e6912` (`0df9e8a4` when run), 79 of 79 as expected (`impl.parent-live-request-n1` at 1,800 s). 283 cases; the two S-RT1b cases of controller 1.8.0 are retired (version collapse); tf1 (2026-11-10, an agent child's turn that fails terminally, bound to `2a6e6912`): 63 of 63 and 72 of 72 as expected |
| Parallel join (k of n, timer) | `workflow/parallel/` | `WorkflowParallel` | `workflow/parallel.ts`, `runtime.ts`, `store.ts` | `8d568890` (design-pinned) | 2026-11-04, batches p1-p5 with the reminder: 110 of 112 as predicted (model errors fixed and re-run); one complete run not recorded |
| In-turn step reminder | `workflow/reminder/` | `WorkflowReminder` | `workflow/agent-reminder.ts`, `managed-session.ts`, `store.ts` | `8d568890` | 2026-11-04, r1: 18 of 18 as predicted |
| Fork + join (named branches) | `workflow/fork-join/` | `AbsForkJoin`, `WfForkJoin`, `WfForkTokens` | `workflow/runtime.ts`, `store.ts`, `parallel.ts`, `compiler.ts` | `e76a6133` (engine identical to `cf2a3141`) | 2026-11-08, fj3: 91 of 91 as expected (48 PASS, 43 expected violations, 0 PARTIAL); includes the NB-R2 and NB-R5 fault and fix cases |
| Workflow controller idle waits | `workflow/idle-wake/` | `WfIdleWake` | `workflow/runtime.ts` (1.8.0 and 1.9.0 running loops) | `bb162ed8` (identical at `8aaf5435`) | 2026-11-08, so5b: 11 of 11 as expected; finding fixed in place: a wake with no command was not an idle wait, so under a steady wake stream the controller never continued as new. Its four 1.8.0 cases are retired (the Workflow version collapse removes controller 1.8.0) |
| Workflow agent session that continues across visits (session lifecycle "continue", the default for an agent state in the outer graph) | `workflow/continued-session/` | `WfContinuedSession` | `workflow/runtime.ts`, `store.ts`, `agent-host.ts` | `2a6e6912` (design run at `a1772a01`, before the fixes at `9a8d0f66`) | 2026-11-09, design run: 27 of 27 as expected; findings G1, G2, G3, G5, then the G1 residual (an end asked during a turn) found by binding the G1 fix, then DRR-1, DRR-2, DRR-1b/1c and DR2-001/003 from later reviews; all fixed by `2a6e6912`. Runs: cc4 39 of 39, cc5d 56 of 59, cc6b 67 of 67, cc6l 4 of 5 (one not checked within 1,800 s, then passed at 3,600 s), cc7 11 of 11, cc9 83 of 83 and cc9l 2 of 2 at the final code, as expected; all 89 cases checked; tf1 (2026-11-10, an agent child's turn that fails terminally, bound to `2a6e6912`): 63 of 63 and 72 of 72 as expected |
| Workflow messaging request (intent and code models) | `workflow/paired/` | `WorkflowRequestSpec`, `Spec57`, `Code`, `CodeAuth`, `Code57`, wrappers | `workflow/store.ts`, `authority.ts` | `8021c75e`, `57fbb0d6` | 2026-11-01 to 11-02: 14 of 42 cases run: 3 PASS, 7 expected violations, 4 PARTIAL |
| Workflow durable recipient intake | `workflow/paired/recipient/` | 19 modules (`RecipientIntake*`, `RecipientTurn*`, `RecipientExposure*`, `RecipientCancelOrder*`, `MCExposure*`) | `orchestration_1_0_83/intake-*.ts`, `workflow/intake*.ts`, `store.ts`, `session-proxy.ts` | `66739e07`, `5df032f1`, `22a66ef7`, `1e240b0f` | 2026-11-01 to 11-02: 70 of 113 cases run: 23 PASS, 46 expected violations, 1 VOID (model error) |
| Workflow request, variant B | `workflow/paired/request/` | `WorkflowRequestSpec57`, `MCRequestCandidate`, `WorkflowRequestSpecB`, `MCRequestBStrict` | design `docs/proposals/workflow-messaging-request.md` at `2943167c` | `2943167c` | 2026-11-02: 21 of 36 cases run: 4 PASS, 17 expected violations |
| Session hydration and dehydration | `session-orchestration/` | the existing modules (1.0.82); `RehydrationNotice`, `SnapshotWarmDrop` | `session-proxy.ts`, `session-manager.ts`, `orchestration/lifecycle.ts`, `orchestration/queue.ts` | 1.0.82 as above; `e76a6133` for the two new modules | 2026-11-08, so2: 16 of 16 as expected, one code finding (a queued prompt cancelled at dispatch loses the rehydration notice); the 1.0.83 fix is bound to `bb162ed8` and passes (so5b, `CarriedGiveBack`, which also covers the carried child digest) and the worker shutdown's release sweep (`WorkerShutdown`). The hydration mechanism is unchanged since 1.0.81. In 1.0.82, already on main, a compact timer item keeps `shouldRehydrate` and an unqueued prompt gives back the rehydration notice. This line adds two edits, both modelled: in 1.0.83 a given-up hydration records an intake attempt, and in every session the warm session is dropped before the snapshot commit after an unsettled aborted run. |

The Workflow models were derived from the intended design first, then
independently from the written code; each model's README states the mapping
from model actions to code, with line ranges at the pinned commit. Line
numbers refer to those commits (`git show <commit>:<path>`), not to the
current head. Where the code has moved on, the binding head says so.

Each model folder has the same files: `*.tla` modules; `cases.tsv` (the case
list the runner reads: id, settings file, module); `cases.json` (one record per
case: its expected result, its note and, under `tlc`, its TLC settings);
`tlc-templates.json` (per module: the order of its constants, the indentation
and the layout of its settings files); `cases-retired.json` where cases were
retired (the code they bound no longer exists; kept for the record, never run);
`run-tlc.sh`, `check-packet.sh`, `SHA256SUMS` and a `README.md` with the
modules, the code binding, the case taxonomy and the recorded results. A folder
whose cases are written by a script has `gen-cases.py`, which writes
`cases.tsv`, `cases.json` and `tlc-templates.json`.

The TLC settings files (`<case>.cfg`) are **generated, never committed**
(`docs/formal/.gitignore`). `tlc_cases.py` renders them from `cases.json` and
`tlc-templates.json`; `run-tlc.sh` and `check-packet.sh` call it before they
use them. When the settings files were last committed (`01caf109`, 1,089
files), the generator reproduced every one of them byte for byte from the
tables (`python3 tlc_cases.py check`, with the retired cases).

Names: Workflow support was called Workflow V2 until the rename that followed the PR 270 collapse. In sections bound to earlier commits, files and identifiers are given by their current names; at those commits the code used `packages/sdk/src/workflow/v2/`, `WorkflowV2*`/`workflowV2*`/`WORKFLOW_V2_*`, `workflow-v2-*` orchestrations, `workflow.v2.*` activities and `workflow_v2_*` database objects (`git show <commit>:<path>`).

Names (2): until the session rename in PR 270, the session that owns Workflow Definitions was called a chat, an agent state's session an agent chat, and the IR field `session` was `chat`. Sections bound to earlier commits use today's names; migration 0088 keeps the old table names, which migration 0089 renames.

## 2. How to run

Java 17 or later and Python 3 are required (Java 21 was used). Download `tla2tools.jar`
v1.7.4 from the TLA+ releases
(`https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar`);
the runner checks its SHA-256.

```sh
cd docs/formal/<folder>
TLA_TOOLS=<dir with tla2tools.jar> ./check-packet.sh      # checks the folder before a run
TLA_TOOLS=<dir with tla2tools.jar> ./run-tlc.sh [out]     # SANY on every module, then TLC on every case
```

- Both scripts first generate the settings files of the cases in `cases.tsv`
  (`python3 ../tlc_cases.py gen <folder>`, found in the folder or above it)
  and remove any other `.cfg` there. To look at them without a run:
  `python3 docs/formal/tlc_cases.py gen docs/formal/<folder>` (`--all` for
  every folder; `--with-retired` adds the retired cases).
- `check-packet.sh` checks that every line of `cases.tsv` passes the runner's
  own guard, that every generated settings file states `CHECK_DEADLOCK`, and
  that `SHA256SUMS` matches. It must print `OK`.
- `run-tlc.sh` runs TLC with `-workers 2 -Xmx2g` and a limit of
  `TLC_CASE_SECONDS` per case (default 300 s). It writes `executions.tsv`
  and one `tlc.log` per case into the output folder, with `generated.sha256`
  (the generator and every settings file it ran). The script's own exit code
  is not the verdict: read `executions.tsv` and the logs.
- TLC exit code **0**: no violation in the bounded search (a pass only if the
  search finished). **12**: a safety violation. **13**: a liveness violation.
  **124**: the case timed out: it is **PARTIAL, never PASS**. Other codes are
  setup or model errors (VOID).
- Compare each result with `expected` in `cases.json`. A case with an expected
  violation passes only if TLC reports the named property with the expected
  cause.

TLC does not run in CI. It runs locally or on demand with each folder's
`run-tlc.sh`. There is no workflow file for it.

To run a folder elsewhere (a packet for another machine), copy the folder,
put `tlc_cases.py` in it, and keep `cases.tsv` and `cases.json` in step if
you cut the case list (`cases.tsv` may list a subset of `cases.json`, in
order). Regenerate `SHA256SUMS` over the committed inputs only.

A TLC pass is a bounded check, not a proof. The models cover small, finite
instances; they check the model, not the TypeScript or PostgreSQL code.

## 3. Adding or updating models

See `.github/skills/tla-formal-validation/SKILL.md` for how to add a model
folder or refresh one after the code changed (`cases.tsv`, `cases.json`,
`tlc-templates.json`, the runners and `SHA256SUMS` must stay in step).

- A folder with `gen-cases.py`: edit its table there and run it; it writes the
  three tables. Never edit its `cases.json` by hand.
- Any other folder: add or edit the case's record in `cases.json` (and its
  line in `cases.tsv`). To table settings files written by hand, put them in
  the folder and run `python3 docs/formal/tlc_cases.py import <folder>`.
- To retire a case whose code no longer exists:
  `python3 docs/formal/tlc_cases.py retire <folder> <case_id> "<reason>"` (a
  folder with `gen-cases.py`: list it in the script's `RETIRED`). Say so in the
  folder's README.
- Then regenerate `SHA256SUMS` (the committed inputs, no `.cfg`) and run
  `check-packet.sh`.

Comments of some modules and settings files were edited when these folders were
prepared for the repository (internal references removed); no definition
changed.
