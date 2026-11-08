# Formal models (TLA+) of the PilotSwarm orchestrations

This folder holds TLA+ models of the core PilotSwarm orchestrations, with the
settings files, runners and case lists to check them with TLC. A TLC pass is a
**bounded check, not a proof**: it explores a small, finite version of the
model. A violation is a counterexample of the model; it needs a check against
the code before it is called a bug.

## 1. Orchestration areas and model folders

There are three core areas:

1. The **durable session orchestration** (`packages/sdk/src/orchestration.ts`,
   `orchestration*/` files, `orchestration-registry.ts`).
2. The **Workflow V2 controller and store** (`packages/sdk/src/workflow/v2/`:
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
| Durable session orchestration: turn loop, turn commit, timers, child delivery, delivery identity; 1.0.83 owned retry and intake run loop; worker shutdown | `session-orchestration/` | `TurnLoop`, `TurnCommit`, `TimerGeneration`, `TimerHandoff`, `TimerInterrupt`, `TimerStarvation`, `ChildDelivery`, `DeliveryIdentity`; `OwnedRetry`, `IntakeDrain`, `WorkerShutdown`, `CarriedGiveBack` | `orchestration/{queue,turn,lifecycle,agents,state}.ts`, `orchestration-registry.ts`; `orchestration_1_0_83/{queue,turn,lifecycle,state,runtime,intake-state,intake-wiring}.ts`, `activity-routing.ts`, `worker.ts` | `198ad79a` (orchestration 1.0.82; the same code on main and at `e76a6133`); `e76a6133` for the 1.0.83 run loop (behind the Workflow test option) and the worker shutdown; `bb162ed8` (identical at `8aaf5435`, v0.8.10) for `CarriedGiveBack` | 2026-10-27: 38 cases, 21 PASS, 17 FAIL (12 describe the code: 7 likely bugs, 5 design limits; 5 deliberate faults); all matched their predictions. 2026-11-08, so3: 36 of 36 as expected, two design limits, both accepted as known limits (a 1.0.83 session fails at its first continue-as-new while 1.0.82 is the latest version; a legacy session's dehydrate cut by the shutdown deadline loses its local state if the worker folder does not survive), no new code finding. so4b to so5b: the 1.0.83 late-cancel give-back; three code findings fixed in place, so5b 48 of 48 as expected. ws2 (final review): `WorkerShutdown` with steps started after the deadline and overlapping, 11 of 11 as expected. Re-run on v0.8.10 (`8aaf5435`): all as expected |
| Workflow V2 core: run, wait, admission, lifecycle, session commands, receive, send | `workflow-v2/` | `WorkflowV2Run`, `Wait`, `Admission`, `Lifecycle`, `SessionCommands`, `Receive`, `Send` | `workflow/v2/runtime.ts`, `store.ts`, `service.ts` | `9fcbf377` | 133 cases; no complete run recorded in the folder's notes |
| Workflow V2 execution graph, agent children, parent queue, recover, paging, paused runs, tool-session lease | `workflow-v2/orchestration/` | `WfGraph`, `WfAgent`, `WfParent`, `WfRecover`, `WfPaging`, `WfPaused`, `WfExecutor`, `WfExecLease`, `WfExecShare` | `workflow/v2/runtime.ts`, `store.ts`, `agent-node-service.ts` | `efe44835`, final heads `1f7bdc77`, `a10c2e07`, `8dd3eae1` and later | r2-final packet (160 of 188 cases): 158 as expected, 2 mismatches (both explained in the folder's README); the other 28 cases have no recorded result |
| Parallel join (k of n, timer) | `workflow-v2/parallel/` | `WorkflowV2Parallel` | `workflow/v2/parallel.ts`, `runtime.ts`, `store.ts` | `8d568890` (design-pinned) | 2026-11-04, batches p1-p5 with the reminder: 110 of 112 as predicted (model errors fixed and re-run); one complete run not recorded |
| In-turn step reminder | `workflow-v2/reminder/` | `WorkflowV2Reminder` | `workflow/v2/agent-reminder.ts`, `managed-session.ts`, `store.ts` | `8d568890` | 2026-11-04, r1: 18 of 18 as predicted |
| Fork + join (named branches) | `workflow-v2/fork-join/` | `AbsForkJoin`, `WfForkJoin`, `WfForkTokens` | `workflow/v2/runtime.ts`, `store.ts`, `parallel.ts`, `compiler.ts` | `e76a6133` (engine identical to `cf2a3141`) | 2026-11-08, fj3: 91 of 91 as expected (48 PASS, 43 expected violations, 0 PARTIAL); includes the NB-R2 and NB-R5 fault and fix cases |
| Workflow V2 controller idle waits | `workflow-v2/idle-wake/` | `WfIdleWake` | `workflow/v2/runtime.ts` (1.8.0 and 1.9.0 running loops) | `bb162ed8` (identical at `8aaf5435`) | 2026-11-08, so5b: 11 of 11 as expected; finding fixed in place: a wake with no command was not an idle wait, so under a steady wake stream the controller never continued as new |
| Workflow V2 messaging request (intent and code models) | `workflow-v2/paired/` | `WorkflowV2RequestSpec`, `Spec57`, `Code`, `CodeAuth`, `Code57`, wrappers | `workflow/v2/store.ts`, `authority.ts` | `8021c75e`, `57fbb0d6` | 2026-11-01 to 11-02: 14 of 42 cases run: 3 PASS, 7 expected violations, 4 PARTIAL |
| Workflow V2 durable recipient intake | `workflow-v2/paired/recipient/` | 19 modules (`RecipientIntake*`, `RecipientTurn*`, `RecipientExposure*`, `RecipientCancelOrder*`, `MCExposure*`) | `orchestration_1_0_83/intake-*.ts`, `workflow/v2/intake*.ts`, `store.ts`, `session-proxy.ts` | `66739e07`, `5df032f1`, `22a66ef7`, `1e240b0f` | 2026-11-01 to 11-02: 70 of 113 cases run: 23 PASS, 46 expected violations, 1 VOID (model error) |
| Workflow V2 request, variant B | `workflow-v2/paired/request/` | `WorkflowV2RequestSpec57`, `MCRequestCandidate`, `WorkflowV2RequestSpecB`, `MCRequestBStrict` | design `docs/proposals/workflow-messaging-request.md` at `2943167c` | `2943167c` | 2026-11-02: 21 of 36 cases run: 4 PASS, 17 expected violations |
| Session hydration and dehydration | `session-orchestration/` | the existing modules (1.0.82); `RehydrationNotice`, `SnapshotWarmDrop` | `session-proxy.ts`, `session-manager.ts`, `orchestration/lifecycle.ts`, `orchestration/queue.ts` | 1.0.82 as above; `e76a6133` for the two new modules | 2026-11-08, so2: 16 of 16 as expected, one code finding (a queued prompt cancelled at dispatch loses the rehydration notice); the 1.0.83 fix is bound to `bb162ed8` and passes (so5b, `CarriedGiveBack`, which also covers the carried child digest) and the worker shutdown's release sweep (`WorkerShutdown`). The hydration mechanism is unchanged since 1.0.81. In 1.0.82, already on main, a compact timer item keeps `shouldRehydrate` and an unqueued prompt gives back the rehydration notice. This line adds two edits, both modelled: in 1.0.83 a given-up hydration records an intake attempt, and in every session the warm session is dropped before the snapshot commit after an unsettled aborted run. |

The Workflow V2 models were derived from the intended design first, then
independently from the written code; each model's README states the mapping
from model actions to code, with line ranges at the pinned commit. Line
numbers refer to those commits (`git show <commit>:<path>`), not to the
current head. Where the code has moved on, the binding head says so.

Each model folder has the same files: `*.tla` modules, one `*.cfg` settings
file per case, `cases.tsv` (the case list the runner reads: id, settings file,
module), `cases.json` (the expected result of each case), `run-tlc.sh`,
`check-packet.sh`, `SHA256SUMS` and a `README.md` with the modules, the code
binding, the case taxonomy and the recorded results.

## 2. How to run

Java 17 or later is required (Java 21 was used). Download `tla2tools.jar`
v1.7.4 from the TLA+ releases
(`https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar`);
the runner checks its SHA-256.

```sh
cd docs/formal/<folder>
TLA_TOOLS=<dir with tla2tools.jar> ./check-packet.sh      # checks the folder before a run
TLA_TOOLS=<dir with tla2tools.jar> ./run-tlc.sh [out]     # SANY on every module, then TLC on every case
```

- `check-packet.sh` checks that every line of `cases.tsv` passes the runner's
  own guard, that every settings file exists and states `CHECK_DEADLOCK`, and
  that `SHA256SUMS` matches. It must print `OK`.
- `run-tlc.sh` runs TLC with `-workers 2 -Xmx2g` and a limit of
  `TLC_CASE_SECONDS` per case (default 300 s). It writes `executions.tsv`
  and one `tlc.log` per case into the output folder. The script's own exit code
  is not the verdict: read `executions.tsv` and the logs.
- TLC exit code **0**: no violation in the bounded search (a pass only if the
  search finished). **12**: a safety violation. **13**: a liveness violation.
  **124**: the case timed out: it is **PARTIAL, never PASS**. Other codes are
  setup or model errors (VOID).
- Compare each result with `expected` in `cases.json`. A case with an expected
  violation passes only if TLC reports the named property with the expected
  cause.

TLC does not run in CI. It runs locally or on demand with each folder's
`run-tlc.sh`. There is no workflow file for it yet.

A TLC pass is a bounded check, not a proof. The models cover small, finite
instances; they check the model, not the TypeScript or PostgreSQL code.

## 3. Adding or updating models

See `.github/skills/tla-formal-validation/SKILL.md` for how to add a model
folder or refresh one after the code changed (the settings, `cases.tsv`,
`cases.json`, the runners and `SHA256SUMS` must stay in step).

Comments of some modules and settings files were edited when these folders were
prepared for the repository (internal references removed); no definition
changed.
