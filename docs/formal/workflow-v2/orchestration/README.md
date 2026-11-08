# Workflow v2 orchestration models (controller 1.9.0)

Nine TLA+ modules model how workflow v2 executes a graph and how its runs
talk to the parent agent and to agent-state children, as the code in
`packages/sdk/src/workflow/v2` implements it at
`efe44835a06786f800c9d07d3031565f199f13fe` (main 0.8.9, batch 7). Line
numbers below refer to that commit. Every result is a bounded model check,
not a proof of the code. Results are in the section "Results" below.

`R` is `runtime.ts`, `S` is `store.ts`, `A` is `agent-node-service.ts`,
`Q` is `orchestration_1_0_83/queue.ts`, `W` is `worker.ts`.

| Module | Checks |
|---|---|
| `WfGraph.tla` | The controller loop of `controlRequestRun` (`R` 1156-1569): admission of every cursor (step limit, the store's ended/deadline/stopping/paused answers, deterministic node ids), routing (`selectRoute`, failure routes, the catch-all state once), root and branch terminals, parallel fan-out with concurrency, failFast cancellation and its dropped results, the all-required join, collection, a graceful stop with its grace deadline, the run's deadline, pause, cancel commands, deletion, results decided by other processes. |
| `WfAgent.tla` | An agent state and its child LLM session: the agent orchestration's spawn attempts (`R` 1703, 3592-3653: `beginAgentSpawn`, `host.spawn`, `recordAgentSpawned`, the end after a spawn), worker crashes inside them, refusals and exhausted attempts (`agentSpawnFailed`), `complete_workflow_node` (`A`; `S` `completeAgentNode` 5441), the outer deadline (`S` `elapseAgentNode`), the controller's `endAgent` and `endAgents` (`R` `endAgentChild` 2326, `endRunAgents` 2358), the child's 20-id prompt window, a child that asks its controlling parent. |
| `WfParent.tla` | What the parent LLM is given and in which order: a send or request state's delivery (`R` `deliver` 3467, `deliverRequest` 4129: begin, enqueue, record), the run's ends, `notifyParent` (`R` 3192: the per-run event check, the notify flag of fe01b956, the recorded skip of 61a622c2, the parent's authority read `W` 1030, the enqueue `W` 1045), the parent's 1.0.83 queue with its 20-id duplicate window (`Q` 406-420) and FIFO overflow (`Q` 307), a parent that ends or is deleted. |

The existing models in `../` (Run, Admission, Lifecycle, Send, Receive, Wait,
SessionCommands) and `../paired/` (the recipient intake and exposure, the
request's response, wake and expiry with variant B) keep their own pins and
results; these modules do not repeat them. A request's response, operation
ids, expiry and wake dispatch are checked in `../paired/request/`.

## Abstractions

- **One step per activity.** Every store activity the controller schedules is
  idempotent or a compare-and-swap, so a crash and retry is the same step
  again, and a replay of the deterministic controller is no step. The steps
  that are not one transaction are split: the spawn activity (`WfAgent`), the
  delivery and notification activities (`WfParent`).
- **Node ids.** A node execution's id is its admission's step number; the code
  derives it from (scope, node, ordinal), one-to-one in a deterministic
  controller.
- **Work states.** `WfGraph` has one kind of state whose result another process
  decides (script effect, agent child, delivery, wait elapse); `WfAgent` and
  `WfParent` model two of those processes in detail.
- **Clocks.** Deadlines are monotone flags; the store's non-monotone clock with
  durable expiry is checked in `../paired/request/` (variant B).
- **Plans.** `WfGraph` interprets a small plan chosen by `Plan`: `linear`,
  `catch`, `catchf` (explicit failure route to the catch-all), `loop` (limit),
  `par` and `parc` (one parallel state; its body `B -> BT`).

## Cases

`gen-cases.py` writes every settings file, `cases.tsv` (every case, in run
order) and `cases.json` (mode, rules, expected outcome and the development
batch `r2d` or `r2e`) from one table (`BATCH=r2e` or `ONLY=<ids>` select a
subset of `cases.tsv`). Modes:
`reviewed` (the code as written), `deliberate` (a planned break of one
protection, expected to fail), and witnesses (reachability checks, expected to
be violated). `run-tlc.sh` runs SANY on every module, then every case.

## r2: final head 1f7bdc77, after an independent fidelity review

r2 answers an independent fidelity review of the first three modules. It adds
six modules over the later batches and revises two. Every new path has a `Code` switch: `"efe44835"` shows the
defect, `"1f7bdc77"` (the final head) shows the fix; `"1c117a47"` is the
same for groups A-C.

| Module | Fidelity issue | What it adds |
|---|---|---|
| `WfRecover.tla` | FR-1 (RT-3, RT-4) | The controller's end as three steps (terminal commit; `afterEnd` endAgents; notifyParent), controller death before, between or after them, notifier orchestrations that can run out of attempts, and `update_workflow recover` (efe44835 `notifyRecoveredRun`; 1c117a47 `finishRecoveredRun`: owed children, any owed notice, a notifier named for the recover's operation id). |
| `WfPaging.tla` | FR-3 (RT-5) | The run's cleanup over N invocations with a page of `Page` (scaled 200/201): efe44835 reads the first page of all invocations; 1c117a47 reads owed ones by id after a cursor until a short page; a failed end is retried by the activity. |
| `WfPaused.tla` | FR-2 (RT-6) | A paused parallel run: a ready branch makes the admission pass take the paused path; a pending agent state with a deadline; controller and store clocks; no run deadline; resume never assumed. |
| `WfExecutor.tla` | FR-5 (RT-2) | Two script states of one workflow opening tool executors over the one native session keyed by the workflow session (efe44835: one executor per session, check before awaits, close destroys; 1c117a47: an owner-counted share reserved before any await, torn down by the last close). |
| `WfParent.tla` (revised) | FR-4, MF-1, FR-17, FR-11, PI-7 | Answers accepted while the request is pending, before the delivery's record; the store's clock separate from the elapse, steps back, and a durable bound expiry; REQUEST_CLOSED after timed_out; the parent's transport queue, stored FIFO (id marked when stored) and model exposure split, with failed or regenerated turns; `Inv_NotifiedAccepted` replaces `Inv_NotifiedReceived` (a notified event promises a running parent orchestration accepted the copy, not that its model read it); `proposedD` for WFO-1, WFO-3, WFO-4. |
| `WfAgent.tla` (revised) | WFO-2 | `proposedD`: agentSpawnFailed ends a child an attempt may have created, and endAgents re-sends an end marked NotFound. |

FR-16: the durable recipient intake (claim, bind, expose, settle) is INACTIVE
at both heads: no worker sets `workflowIntake` (`runtime.ts`
`WorkflowV2RuntimeDeps.workflowIntake`), so every send is a `legacy_window`
prompt, which is what `WfParent` models. The intake keeps its own models in
`../paired/` at their pins.

### Final head 1f7bdc77 (1c117a47 + group D)

`Code = "1f7bdc77"` models the code as committed: groups A-C are unchanged
from 1c117a47, and group D is:

- WFO-1 (ac5032ec): the notifier waits, bounded (20 s, polling every 200 ms),
  while `store.runDeliveriesInFlight` counts an outbox row of the run to the
  parent that is pending, attempted and recent (sends and requests alike).
  The attempt is counted in the begin's transaction, before the enqueue, and
  a run's end leaves a message to an agent pending, so the count cannot miss
  an enqueue that is still to come. `AllowWaitTimeout` models the bound.
- WFO-2 (63922d4f): `agentSpawnFailed` ends the child after a counted
  attempt (afterSpawn); `endRunAgents` re-sends to a NotFound mark after an
  attempt, and `remarkAgentEndSent` moves NotFound to the real status. A row
  whose spawn never created a child stays listed as owed; nothing exists to
  end, so `Prop_ChildReleased` holds.
- WFO-3 (e9fe009d): the worker reads the parent orchestration's status
  before the enqueue; an ended one gets nothing queued and the run records
  the skip "parent is gone". The read and the enqueue are separate steps.
- WFO-4 (1f7bdc77): `workflow.parent_notifying` is recorded once before the
  enqueue; a retry that finds it records `parent_notified` with
  `byEarlierAttempt` instead of a skip.

`"proposedD"` stays as the comparison: the fixes this review first proposed.

### Correspondence: each finding, the case that shows it, the case that checks its fix

| Finding | Defect at efe44835 | Fix at 1f7bdc77 | Remaining at 1f7bdc77 |
|---|---|---|---|
| RT-2 | `exec.rt2-refused-efe`, `exec.rt2-destroyed-efe` | `exec.rt2-fixed`, `exec.rt2-fixed-live`; control `exec.sequential-efe` | |
| RT-3 | `recover.rt3-efe` | `recover.rt3-fixed` | |
| RT-4 | `recover.rt4-efe`, `recover.rt4-exhaust-efe` | `recover.rt4-fixed`, `recover.rt4-exhaust-fixed`; control `recover.nodeath-efe` | |
| RT-5 | `paging.rt5-efe` | `paging.rt5-fixed`, `paging.rt5-fixed-live`; control `paging.one-page-efe` | |
| RT-6 | `paused.rt6-efe` | `paused.rt6-fixed`, `paused.fixed-any` | `paused.end-fails-fixed`, `paused.done-child` |
| WFO-1 | `parent.late-message`, `parent.late-request`, `parent.safety-request` | `parent.late-message-1f7-bound`, `parent.late-request-1f7-bound`, `parent.safety-request-1f7-bound`, `parent.safety-1f7` | `parent.late-message-1f7`, `parent.safety-request-1f7` (a delivery past the bound) |
| WFO-2 | `agent.exhausted-orphan` | `agent.exhausted-orphan-1f7`, `agent.safety-1f7`, `agent.live-1f7` | `wit.agent-second-end` (a second end, same id) |
| WFO-3 | `parent.notified-lost` | `parent.safety-1f7` | `parent.notified-lost-1f7` (status read, then the parent ends, then the enqueue) |
| WFO-4 | `parent.skip-after-given` | `parent.skip-after-given-1f7` | `parent.told-by-earlier-1f7` (told byEarlierAttempt with nothing queued) |
| FR-4, MF-1 | r1 `wit.parent-answer-closed` took a wrong path | `wit.parent-answer-early`, `wit.parent-answer-after-timeout`, `wit.parent-answer-expired`, `parent.expiry-durable`; planned break `fault.parent-no-durable-expiry` | |

The `*-D` cases check the proposed fixes for comparison.

Fixed-head questions the r2 models raise (not yet results): `paused.end-fails-fixed`
(an end that fails on the paused path is not retried while the run stays
paused) and `paused.done-child` (a child that completed its state while the run
is paused is ended only after the resume).

### Model simplifications added in r2

- `WfRecover`: one agent child and one parent notice; recover is called only
  after the controller ended and while no notifier runs (an earlier call does
  nothing a later one does not); deaths, notifier exhaustion and a failed
  child end are once each; the parent's own cancel is not modeled.
- `WfPaging`: every state decided; ids are creation order; page 2 for 200.
- `WfPaused`: branch 1's next state is admitted once and never decided; one
  pause; the run has no deadline; the child's completion and the clocks are
  single steps.
- `WfExecutor`: same tools and authority for both states (a different binding
  is refused by design at 1c117a47); one tool call each; setup and teardown
  never fail.
- `WfParent`: one exposure at a time in FIFO order; a turn's failure keeps its
  items; the parent's answer is attempted when its model is given the request.

## r2c (2026-11-04): verification of group D, batch E3 as proposed, E1 lease

- `WfParent` adds a zombie enqueue (`AllowZombie`: an attempt still inside
  its enqueue while the runtime retries the activity; the retry's begin finds
  the state decided and fails the row), a second notifier instance
  (`NumNotifiers = 2`: a recover variant), and `Code = "proposedE3"`
  (1f7bdc77 plus batch E3 as proposed: rows decided after a recent attempt are
  counted, the wait is 15 s, the notifier is serialized per run, and a marker
  plus a refusal records a skip with earlierAttempt).
- Verification cases at 1f7bdc77, one each: `parent.zombie-1f7` (failed-row
  race, WFO-1), `parent.concurrent-1f7` (concurrent notifiers, WFO-4),
  `parent.notified-lost-1f7` (status-read race, WFO-3),
  `parent.told-by-earlier-1f7` (D-R1). Their E3 counterparts:
  `parent.zombie-E3`, `parent.concurrent-E3`, `parent.told-by-earlier-E3`;
  `parent.notified-lost-E3` shows E3 leaves the status-read race.
- `WfExecLease.tla` (new) models E1 0c3b4ceb: the workflow's native tool
  session is exclusive; states wait in a FIFO line of links taken before any
  await; an aborted waiter releases its link and the next still waits on the
  holder; after the wait a failed teardown or a shutdown refuses, and setup
  checks authority. Cases `exec.e1-*` and two planned breaks. The efe44835
  defect cases and the 1c117a47 share stay in `WfExecutor.tla`.

## r2d (2026-11-04): E1-R1 and E1b as proposed

- `WfExecLease` adds `Dep`: state 1, after its first call, waits until state
  2 made a call. `exec.e1-dep` checks that both scripts complete their work
  (`Prop_BothComplete`, not merely served, refused or aborted): expected to
  fail under the 0c3b4ceb lease (E1-R1; the real code ends it by a timeout,
  so both scripts fail).
- `WfExecShare.tla` (new) models E1b as its design describes it: a
  shared native session with one call at a time; a queued call re-checks at
  dequeue that its owner is not closed or stopped and is authorized; an
  owner's close aborts only its own running call; its share is released after
  its queued and in-flight calls settle; its background work (attributed by
  its call windows) is cancelled at its release, and a failed cancel or
  teardown is a barrier re-checked after the wait. Cases `exec.e1b-*`
  (including the dependency, expected to pass) and two planned breaks. E1b
  code is not written yet.

## r2e (2026-11-04): batch E3, E2 and E1b as committed

The r2e packet runs only the 29 cases of `cases.tsv` (`BATCH=r2e python3
gen-cases.py`); `cases.json` lists all 160 with their batch. The r2d cases
keep their r2d results: the new constants default to the r2d behaviour.

| Code | Commit | What the mode follows |
|---|---|---|
| `a10c2e07` (WfParent) | 181daa7c, a10c2e07 | The 15 s wait before the run's notice lock, with notifications on only; a try-lock: an attempt that finds it held returns and records nothing; under the lock, the notice read again, the marker read, the refusals, the marker, the worker's status read and enqueue, the record; a known refusal after a marker is a skip with `earlierAttempt`; the count of failed rows. |
| `a10c2e07` (WfAgent) | a10c2e07 | An end already marked sent is sent again only after a spawn and only when its status was NotFound. |
| `a99cd382` (WfPaused) | a99cd382 | The paused path collects a decided agent state and ends its child at once; a failed end is tried at the next paused wake; the deadline branch no longer ends the child. |
| `8dd3eae1` (WfExecShare) | 8dd3eae1 | The turn checks include the barrier; a close while the call waits releases at once; a close while it runs aborts and waits, or gives up after the deadline with the barrier; background work attributed by start time and call windows. |

New switches: `AllowNtZombie` (an attempt that timed out keeps running and
holds the lock, process 3), `AllowRecover`/`MaxRecovers` (update_workflow
recover restarts the notifier while the notice is owed), `AllowStatusRace`
(FALSE makes the status read and the enqueue one step, to isolate D-R1),
`AllowUnsettled`, `AllowUnattributed`, `AllowBoundary`.

Prediction correction for r2d: `parent.told-by-earlier-E3` (predicted PASS)
does not exclude WFO-3's status-read race, which proposedE3 keeps; it is
expected to fail through that race. `parent.told-by-earlier-E3-norace` and
`parent.told-by-earlier-1f7-norace` isolate D-R1.

Case ids are lowercase (`-D` is `-d`, `-E3` is `-e3`): the runner accepts
`^[a-z0-9.-]+$` only. The first r2e packet (056efbe5) used uppercase ids and
was not run; this one replaces it with the same models and cases.

## r2f (2026-11-04): MF-2 fix and E1c (412f7b00)

In r2d-rest the six WfExecLease cases stopped with a TLC exception:
`Attempted to apply function <<FALSE, FALSE, FALSE>> to argument 0`. Wake
used `Ahead(u) == prev[u] = 0 \/ LinkDone(prev[u])`; TLC evaluates each
disjunct of an action on its own, so it applied `LinkDone(0)` (and `Free`
had the same form). Both now use IF; the six cases rerun with their r2d
predictions.

WfExecShare adds Code `412f7b00` (E1c): task ownership by id from listings
before and after each call, half-open windows only for a task no listing
claimed, the barrier checked just before execution. `AllowListingFail`: a
listing fails, so a task with no start time (or one at a window's edge) is
left to the last owner's teardown, as the code documents. Six exec.e1c-*
cases. The per-share generation lease is not modeled.

`ONLY=<ids> python3 gen-cases.py` selects the twelve r2f cases.

## r2 final (2026-11-04): every case on the final models

One packet with all 160 cases (r1, r2, r2c, r2d, r2e) on the final models
(r2e modes and the MF-2 fix), so the evidence is one run on one model revision. The new constants default to the earlier behaviour, so the
r2d predictions stand (with the pre-result correction of
parent.told-by-earlier-e3).

## r2g (2026-11-04): E3-R1 after r2e2

r2e2's parent.zombie-holder-recover-a10 failed its progress rule: all three
of the model's recovers were made while the timed-out attempt still held
the run's notice lock (each returned at the try-lock), and then the holder
failed. That is a case-design error (the bound was spent too early), and
it is the code's limit at a10c2e07: only a recover made after the holder
failed pays the notice. r2g adds `RecoverAfterRelease` (a recover only
while no attempt holds the lock) and Code `fc6d7a65` (E3b: an attempt that
finds the lock held fails and the activity runs again). Four cases.

## o5: S7-DX2 (1ef53967 on dbf99086), lifecycle commands end the run at acceptance

`Cmd = "direct"`: an accepted cancel or done ends a begun run in the store at
once, under the session and run locks, while the run is active (running,
paused or stopping; it replaces a graceful stop). It ends cancelled, as the
controller's own cancel does; done records reason Stopped (one status here).
The command is still queued, as a hint (`cmdq`); `AllowLoseHint` may drop it
(continue-as-new carries at most 100 unread messages; the drain was removed).
The controller finds the ended run at its next admission, collection or stop
end (`endedElsewhere`) and tells the parent after a command's end
(`ReportIfCommand`). 1.9.0's collect reports an ended run before any result.
Delete stays a direct store end. The first run-ending commit wins (Q1): a
terminal's finish that finds the run ended only reports. `Cmd = "queue"` is
the behaviour before S7-DX2, the setting of every earlier case.

- `Inv_NoAdmitAfterAccept`: no node execution is admitted after acceptance.
- `Inv_NoCollectAfterEnd`: an ended run's collection returns no result.
- `Prop_FirstEndWins`: an ended run's status never changes.
- `Prop_CommandEnds`: every accepted command ends the run by its own
  transaction, and the controller ends. `Prop_CommandTold`: the parent is told.
- Comparisons (queue): an admission after an accepted cancel; a lost hint;
  a terminal finishing first; a deleted run's results collected.

Not modeled: the receipt on an ended run (no change), the 32-message read
batch (a hint's delay or loss covers it), the requester not being told, a
run ended before it began (cancelBeforeBegin), 1.8.0 (this module is 1.9.0).
`SendCancel` stands for every entry point: the parent's session path and, since
3c93f3c6, the management API and the agent manager (applyOperatorCommandToWorkflowV2,
the same store end under the same locks). Only a command an older build queued
can still be lost at continue-as-new; that is the queue setting.

## Case taxonomy

`cases.json` gives each case a `mode`: `reviewed` (165: the code as written at
the head named in `head`), `deliberate` (16: a planned break of one protection,
expected to fail), `comparison` (6: an earlier code behavior or a proposed fix,
kept for comparison) and `witness` (1: reachability). `expected` is `PASS`
(`safety` or `liveness` when a violation is expected). A case id names its
group: `graph.`, `agent.`, `parent.`, `recover.`, `paging.`, `paused.`, `exec.`,
`cmp.`, `fault.`, `wit.`. A `reviewed` case with expected `safety` or
`liveness` shows a defect of an earlier head or a limit of the code (the
"Correspondence" table above names the case that shows each finding and the case
that checks its fix).

| Module | Cases | Heads modeled |
|---|---|---|
| `WfGraph` | 44 | `efe44835`, `1f7bdc77`, S7-DX2 (`1ef53967` on `dbf99086`) |
| `WfParent` | 62 | `efe44835`, `1f7bdc77`, `a10c2e07`, `fc6d7a65`, proposed variants |
| `WfAgent` | 23 | `efe44835`, `1f7bdc77`, `a10c2e07` |
| `WfExecShare` | 17 | `8dd3eae1`, `412f7b00` |
| `WfPaused` | 15 | `1c117a47`, `a99cd382` |
| `WfRecover` | 11 | `efe44835`, `1c117a47` |
| `WfExecLease`, `WfExecutor` | 6 + 6 | `0c3b4ceb` (E1), `efe44835`, `1c117a47` |
| `WfPaging` | 4 | `efe44835`, `1c117a47` |

## Results

The r2-final packet (model commit `95018882`, 2026-11-04) ran all 160 cases
that existed then, on the final models, with TLC 2.19 (`-workers 2`, two
workers, a limit per case). SANY accepted all 9 modules. All 160 cases ran; the
longest took 194 s.

| Outcome | Cases |
|---|---|
| As expected | 158 |
| Mismatch with the expected verdict | 2 |
| PARTIAL (timeout) | 0 |
| VOID | 0 |

The two mismatches are the same in the three runs of the packet:

- `parent.told-by-earlier-e3`: expected PASS; TLC found a safety violation
  (`Inv_ToldMeansAccepted`). `cases.json` still lists PASS, but the prediction
  was corrected before the run (see "Prediction correction" above): the
  proposed E3 keeps the status-read race of WFO-3, which this case does not
  exclude (`parent.told-by-earlier-e3-norace` isolates D-R1).
- `parent.zombie-holder-recover-a10`: expected PASS; TLC found a temporal
  violation (`Prop_ParentLearnsEnd`). It is a case-design error: all three
  recovers were made while the timed-out attempt still held the notice lock, so
  the recover bound was spent too early. It is the code's limit at `a10c2e07`:
  only a recover made after the holder failed pays the notice. The cases of
  group r2g (`RecoverAfterRelease`, `fc6d7a65`) address it.

A cross-check against three earlier runs of the same cases (160 comparisons)
found 100 identical verdicts and distinct-state counts, 6 verdict changes (all
six `WfExecLease` cases, which stopped with a TLC exception before the
`Ahead`/`Free` fix and now give their expected verdicts) and 54 differences in
the number of distinct states, all in cases that stop at a violation, where the
count depends on the order of the two TLC workers. Cases that explore the full
state space showed no difference.

`cases.tsv` lists 188 cases: the 160 above and 28 that were added after the
packet (the batches r2f and r2g, and the S7-DX2 cases for `WfGraph`). No result of those 28 cases is recorded in this
folder.

## How to run

Java 17 or later is required.

```sh
TLA_TOOLS=<dir with tla2tools.jar> ./check-packet.sh
TLA_TOOLS=<dir with tla2tools.jar> ./run-tlc.sh [out]
```

`run-tlc.sh` pins `tla2tools.jar` v1.7.4 by SHA-256, runs SANY on every module
named in `cases.tsv`, then TLC on every case (`-workers 2 -Xmx2g`, a limit of
`TLC_CASE_SECONDS` per case, default 300 s). Read `<out>/executions.tsv` and
each case's `tlc.log`. Exit code 0 means no violation in the bounded search,
12 a safety violation, 13 a liveness violation, 124 a timeout (PARTIAL, never
PASS); other codes are setup or model errors. Every settings file states
`CHECK_DEADLOCK TRUE`: a stuck state that is not a final state is reported.
Case ids are lowercase (`^[a-z0-9.-]+$`). A TLC pass is a bounded check, not a
proof.
