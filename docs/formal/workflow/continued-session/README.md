# The continued agent session (session lifecycle "continue")

`WfContinuedSession.tla` models an agent state whose visits in one run go to one agent session, the default for an
agent state in the outer graph. `CORRESPONDENCE-069eca30.md` maps it to the code. A TLC pass is a bounded check, not a
proof.

## What is checked

| Property | Meaning |
|---|---|
| `Inv_OneLive` | One agent session per agent state goes on at a time. |
| `Inv_ResultOwnVisit` | A visit is decided only by a result from its own turn. |
| `Inv_ReplaceOnlyEnded` | A replacement agent session only after the previous one ended. |
| `Inv_NoTurnForDecided` | No turn starts for a visit already decided. |
| `Inv_EndOnce` | An agent session gets its end command at most once. |
| `Inv_PromptNotDropped`, `Inv_NoLoudFail` | A visit's prompt is not dropped, and a visit does not wait out the spawn retries, because its agent session ended between its admission and its spawn (G1). |
| `Inv_NoPromptBehindStaleTurn` | A later visit's prompt never waits behind a decided visit's turn whose Stop was never sent (G2). |
| `Inv_StopAtRunEnd` | A visit ended by the run's end stops its running turn (G5). |
| `Inv_NoRevive` | A deleted agent session is never brought back (DRR-1). |
| `Inv_NoOrphanRun` | No orchestration is started for a deleted agent session and left running. |
| `Prop_OrphanEnded` | Such an orchestration is ended in the end. |
| `Inv_NoTurnOnDeleted` | No model turn runs on a deleted agent session (DR2-001). |
| `Inv_NoAbandonedLive`, `Inv_NoFailOnLive` | A replacement never leaves the previous agent session live with no end on its way, and a visit never fails at once on a live agent session with no end on its way (DRR-2). |
| `Prop_AllEnded`, `Prop_OthersEnded` | After the run ends, every agent session is ended (G3). |
| `Prop_OwedSent` | An owed end is eventually sent. |
| `Prop_VisitsDecided` | Every visit is decided (guaranteed by the time limit). |
| `Inv_NoStopOnActiveDone`, `Inv_StopOwnVisit`, `Inv_TurnsInOrder`, `Inv_EndStopsTurn`, `Prop_PromptTaken` | i1: no Workflow Stop ends a completed visit's turn while the run is active; a Stop ends only a turn of its own visit; a session's turns run in visit order; the session's end stops a turn still running; a queued prompt is taken. |

Constants switch on a person's end or delete, a stop or cancel, failing Stops and a failing end, and each proposed
fix (`SpawnRecheck`, `StopBeforeSpawn`, `PerAgentSessionEnd`, `StopAtRunEnd`, and `EndMark` for the G1 residual).
`SplitSpawn` takes the spawn as three steps (the check, the child create, the send) and `MarkSplit` a person's end as
two (the mark, the command), so that other steps can run between them; `CheckAll`, `Fence`, `Backstop`,
`AllowSpawnCrash`, `MarkFail`, `Withdraw`, `Outbox`, `Carry`, `CarryDelete`, `TurnGuard`, `MarkCreating` and `CarryNotFound` describe the DRR-1 and DRR-2 code and fixes (see the module
header). `Inv_OneLive` does not count an agent session whose end command is on its way.
`RecheckSeesEnding` says whether the spawn's check sees an agent session whose end was asked while one of its turns
runs (the code: no, its orchestration reads Running until the turn ends). `cases.tsv`, `cases.json` and
`tlc-templates.json` (149 cases: 134 `WfContinuedSession` [89 before tf1 and i1] + 15 `WfBranchContinuedSession`) are written by

    I1_AFIX_HEAD=1e0ea856 I1_MERGE_HEAD=58e4d056 \
    G1B_HEAD=7024ef6f DRR1_HEAD=69d07073 DRR2_HEAD=5451a22e DRR1B_HEAD=7bd79a46 \
      DRR1C_HEAD=9b2ca643 DR2FIX_HEAD=781441bf python3 gen-cases.py 9a8d0f66

The settings files (`.cfg`) are generated from `cases.json` and `tlc-templates.json` (`../../tlc_cases.py`) and are not committed.

## Results

Design run, bound to `a1772a01` (2026-11-09; TLC 2.19, two workers, 300 s per case): 27 of 27 as expected, no
timeouts. Largest case `fix.all`, 70,558 distinct states, 63 s.

| Group | Cases | Result |
|---|---|---|
| The code with no gap triggered (`cc.*`) | 7 | PASS: one agent session at a time, results bound to their own visit, ends sent once, every agent session ended after the run ends, owed ends sent |
| Proposed fixes (`fix.*`) | 5 | PASS, each fix alone and all together |
| Findings (`finding.*`) | 5 | violated as found in the code (G1 silent and loud, G2, G3, G5) |
| Design limit (`limit.g3-failed-chat`) | 1 | an agent session whose end fails past every retry stays open until a recover |
| Deliberate faults (`fault.*`) | 5 | each fails on its property |
| Witnesses (`wit.*`) | 4 | reached |

Findings (each from the code at `a1772a01`, confirmed in the model; each is fixed, see "Fixes" below):

- G1: an agent session that ends between a visit's admission and its spawn. Ended by a person: the spawn retries
  about 31 minutes, then the visit fails unavailable. Deleted by a person: the row is brought back as running, the
  prompt is dropped, and the visit waits out its time limit (trace: admit, spawn, time limit, admit the next visit,
  delete, spawn).
- G2: a visit's cycle Stop that fails past its retries is not sent again during the run; the next visit's prompt
  waits behind the old turn (trace: turn starts, time limit, Stop fails, next visit's prompt queued).
- G3: an agent session whose end keeps failing after the run ended keeps the later agent sessions from being ended.
- G5: a `done` or `cancel` command does not stop a running turn, and no Stop is sent at the run's end, so a cancelled
  run's turn runs to its natural end.
- G4 (at most 50 detached end retries per agent session) is not reachable in practice: one is started per recover
  after a 31-minute retry ends; an end that stays owed concerns an agent session that never became visible, so
  nothing runs.

## Fixes (2026-11-09)

| Finding | Fix on the pull request branch | Cases (all pass) |
|---|---|---|
| G1 | `15a306c2`: before a later visit's prompt, the spawn checks the agent session its admission chose; if it was deleted or ended since, the visit fails `unavailable` at once with nothing sent, and the next visit starts a new agent session | `impl.cc-g1`, `impl.cc-g1-deleted` |
| G1 residual | `80019c84`: a person's, a parent's or the Workflow's `done` or `cancel` is recorded on the agent session before its command is queued, and admission and the spawn's check read that mark | `impl.cc-g1b-end-during-turn`, `impl.cc-g1b-safety`, `impl.cc-g1b-live` |
| G2 | `f4265d64`: an earlier visit whose end was not sent is ended before the next visit's prompt; a failure retries the spawn | `impl.cc-g2` |
| G3 | `d2e00a16`: the run's end ends each agent session on its own, and the call fails afterwards naming those not ended | `impl.cc-g3` |
| G5 | `06b3abab`: a visit ended by the run's end (and a recover) also stops its running turn | `impl.cc-g5` |

The G1 residual was found by binding the G1 fix (`a9f60db7`): the fix's check reads the orchestration status, which
stays Running while a turn runs after a person asked the session to end, so the next visit's prompt went to that
session and was dropped (`limit.cc-g1-end-during-turn`, kept as the reference: admit, spawn, turn starts, time limit,
the person ends the session during the turn, the next visit is admitted to the same session, its prompt is dropped).
That remaining window between the spawn's check and its send was the subject of a later review (below).

## Later review: the spawn's check is a read, and the end mark is a separate write (DRR, DR2)

From `69d07073` on, the model takes the spawn as three steps (the check, the child create, the send) and a person's
end as two (the mark, the command), so that other steps run between them (`SplitSpawn`, `MarkSplit`).

| Finding | What the model showed at the code before the fix | Fix | Cases |
|---|---|---|---|
| DRR-1 (high) | A deletion between the check and the create, or before a retried attempt (whose check was skipped), brought the deleted row back (`limit.cc-drr1-delete-after-check`, `limit.cc-drr1-retry-revives`: `Inv_NoRevive`); an end after the check met the prompt (`limit.cc-drr1-end-after-check`, `limit.cc-drr1-create-then-end`: `Inv_NoLoudFail`) | `69d07073`: the create refuses a deleted row and leaves it deleted (row lock; DR2-002 `7ec59a50`: creates of one id take turns); every attempt is checked; the check runs again after the send and decides the visit | `impl.cc-drr1-fence`, `impl.cc-drr1-live`, `-live-n` |
| DRR-2 (medium) | The mark commits before the command; when the command is lost (a throw or a crash) a visit replaced the live session or failed on it (`limit.cc-drr2-throw`, `-throw-withdraw`, `-crash`: `Inv_NoFailOnLive`); a withdrawal does not close it. The lost command drops no prompt and breaks no liveness property (`cc.drr2-crash-prompt` PASS) | `5451a22e`: a Workflow that acts on a mark first queues the marked end itself (`workflow-mark-end:<mark id>`); DR2-003 `de1f9f98`: also to a session that reads NotFound | `impl.cc-drr2-carry-throw`, `-carry-crash`, `-carry-live`, `-live-n`, `fix.cc-dr2-003-carry-notfound` |
| DRR-1b, DRR-1c, DR2-001 | A deletion between the create and the send left an orchestration running on the deleted session (`limit.cc-drr1-orphan-run`); carried only when the start already reads as existing (`7bd79a46`, `limit.cc-drr1b-start-not-visible`); queued behind the start and the prompt (`9b2ca643`), a worker can still run one model turn first (`limit.cc-dr2-001-turn-before-delete`: `Inv_NoTurnOnDeleted`) | `7bd79a46`, `9b2ca643`: the check after the send queues the deletion's delete; DR2-001 `a386f3e5`: a turn of a deleted session runs no model and no tool and ends the session | `fix.cc-dr2-001-turn-guard`, `-guard-skew`, `-live-n`, `fix.cc-dr2-safety`, `impl.cc-final-live` |

An orchestration that does run on a deleted session is ended by the run's end at the latest
(`impl.cc-drr1b-orphan-ended`: `Prop_OrphanEnded`).

Runs of the implementation cases (TLC 2.19, two workers):

| Run | Code | Cases | Result |
|---|---|---|---|
| cc3 | `a9f60db7` | 36 (the 27 above and 9 new) | 36 of 36 as expected; the largest new case `impl.cc-live`, 80,612 distinct states, 68 s; `limit.cc-g1-end-during-turn` violates `Inv_PromptNotDropped` |
| cc4 | `7024ef6f` | 39 (cc3 and 3 `impl.cc-g1b-*`) | 39 of 39 as expected; `impl.cc-g1b-end-during-turn`, `-safety` and `-live` pass (99,326 distinct states, 154 s for `-live`); `limit.cc-g1-end-during-turn` still violates `Inv_PromptNotDropped` at `a9f60db7` |
| cc5d | design of DRR-1, DRR-2 and the carried end | 59, 600 s | 56 of 59 as expected; 3 liveness cases not checked within 600 s (rerun in cc6l) |
| cc6b | `69d07073`, `5451a22e` | 67, 600 s | 67 of 67 as expected; the DRR-1 and DRR-2 cases pass (largest `impl.cc-drr-safety`, 1,630,717 distinct states); every reduced liveness case passes |
| cc6l | `69d07073`, `5451a22e` | 5 full-size liveness cases, 1,800 s | 4 PASS (`fix.cc-drr1-live`, `impl.cc-drr1-live`, `fix.cc-drr2-carry-live`, `impl.cc-drr2-carry-live`, up to 1,709,892 distinct states); `cc.drr2-crash-live` not checked (1,695,724 distinct states at 1,800 s; its two-visit version passes) |
| cc7 | `7bd79a46` | 11, 1,800 s | 11 of 11 as expected; `limit.cc-drr1b-start-not-visible` violates `Inv_NoOrphanRun`, `impl.cc-drr1b-orphan-ended` passes |
| cc9 | `781441bf` (the code at `0df9e8a4`) | 83, 600 s | 83 of 83 as expected; `limit.cc-dr2-001-turn-before-delete` violates `Inv_NoTurnOnDeleted` and `limit.cc-dr2-003-mark-notfound` `Inv_NoFailOnLive` (the code before those fixes); every fix case passes, `fix.cc-dr2-safety` with 1,644,649 distinct states |
| cc9l | `781441bf` | `cc.drr2-crash-live` and `impl.cc-final-live`, 3,600 s | 2 of 2 PASS: `impl.cc-final-live` (every fix, 659,197 distinct states, 371 s); `cc.drr2-crash-live` (1,771,490 distinct states, 3,356 s) |

Every one of the 89 cases of that time has a TLC result as expected; none is left unchecked (`cc.drr2-crash-live`, not checked
within 1,800 s in cc6l, passed at 3,600 s in cc9l).

## tf1 (2026-11-10): a turn that fails terminally (bound to 069eca30)

Runs (2026-11-10, TLC 2.19, two workers, 600 s per case): the design run, 63 of 63 as expected (the three findings of the code before the fix violate their liveness property; every fix case passes), and the run with the drop on success, 72 of 72 as expected.

The code binding of this fix (all three models) is `../orchestration/CORRESPONDENCE-tf1-069eca30.md`.

A turn can fail with its retries spent: the agent session goes idle with an error. Before the fix the visit waits for
its time limit. The fix: the session reports the failure, and the store decides the turn's own visit
`execution_failed` while it is pending; a visit already decided (a stale turn whose Stop failed, G2) is kept. The next
visit reuses the agent session (its next successful turn clears the error). A turn carries one visit's prompt here; if
a turn can carry the prompts of several visits, its report decides every pending visit it carried.

New constants `AllowTurnFail`, `FailReport` (`"none"`, `"fix"`, `"binds-newest"`: a fault) and `TimeoutFair`; actions
`TurnFails` and `ReportDecide`; `Prop_FailedVisitDecided`; witnesses `W_NoFailDecided` and `W_NoReuseAfterFail`. Cases
(batch tf1, the G1-G5 fixes and the end mark as the base): `tf.cc-turn-fails-waits` (the code before the fix, with the
time limit not forced: violated), `tf.cc-turn-fails`, `-safety`, `-live`, `tf.cc-stale-turn-fails` (PASS),
`fault.cc-report-binds-newest` (`Inv_ResultOwnVisit` violated) and two witnesses. A later successful turn of the session
while the report is owed drops it (`AllowRecover`, `RecoveredTurn`, as `d3230de4` does): `tf.cc-turn-fails-recovers`
passes (the visit is decided by the report, the agent's result or its time limit), two witnesses show the last two, and
`limit.cc-turn-fails-recovered-no-timeout` records the reliance on the time limit. A turn can carry the late prompt of a
decided visit with the next visit's prompt; at most one of them is pending, and the report decides every pending visit
it names (the model's turns carry one prompt; `fault.cc-report-binds-newest` checks that a report never decides a visit
it did not carry).

## i1 (2026-11-27): a completed visit's turn is not stopped (issue I1, bound to 5f24054e)

The agent reports its result with `complete_workflow_node` in the middle of its turn, and the turn goes on to write its
reply. The code before the fix (`b79be29d`) sent that turn the visit's cycle Stop at the visit's end; a stopped turn
commits no snapshot, so the next visit did not remember the earlier one. The fix: a visit its agent completed while
the run is active sends no Stop; the turn ends by itself and commits. The Stop stays for a time limit, a cancel, and a
run that is stopping or ended. The next visit's prompt waits behind the turn and starts a new turn on its own visit.
Review R1 of the fix found that the turn could then outlive its run, and that a reply that never ends held the next
visit's prompt forever. Its fixes: the session's end stops whichever turn still runs (R1-1), and a reported reply has a
limit (R1-2).

New constants: `SplitTurn` (the result and the turn's end are two steps: `TurnReport`, then `TurnFinish`, which
commits), `NoStopOnDone` (the fix), `SessionEndStop` (R1-1), `ReplyLimit` (R1-2: `ReplyExpire` ends a reported turn
without a commit) and `AllowStall` (a reported turn may never finish by itself); the fault `"stop-unfenced"` (a Stop
ends whatever turn runs). All five are `FALSE` in every earlier case, whose behavior does not change. New properties:

| Property | Meaning |
|---|---|
| `Inv_NoStopOnActiveDone` | No Workflow Stop ends the turn of a visit its agent completed while the run is active. That turn commits when it finishes by itself; the reply limit, a lost session or the run's end may still end it without a commit. |
| `Inv_StopOwnVisit` | A Stop never ends a turn of another visit (the turn-to-visit fence). |
| `Inv_TurnsInOrder` | A session's turns run one at a time, in visit order: the next visit's turn runs after the previous one ended. |
| `Inv_EndStopsTurn` | The session's end never waits behind the turn of a visit its agent completed whose end sent no Stop. |
| `Prop_PromptTaken` | A prompt queued in a live session is taken by a turn (or the session ends), also when a reply stalls. |

Witnesses: `W_NoDoneCommitted` (a completed visit's turn commits), `W_NoRanAfterDone` (the next visit's prompt waits
behind that turn, then runs its own turn: Admit, Spawn while the turn runs, TurnFinish, TurnStart),
`W_NoRanWithMemory` (that turn starts after the completed visit's turn committed), `W_NoStopFenced` (the next visit's
Stop finds the completed visit's turn and the fence keeps it), `W_NoDoneStoppedAtEnd` (the run's end still stops a
completed visit's turn), `W_NoEndStoppedTurn` (the session's end stops it), `W_NoReplyExpired` (the reply limit ends a
stalled reply) and `W_NoCycleStop` (a time limit or a cancel still stops its own turn). `CORRESPONDENCE-i1-5f24054e.md`
maps the model to the code. The cases are written by

    G1B_HEAD=7024ef6f DRR1_HEAD=69d07073 DRR2_HEAD=5451a22e DRR1B_HEAD=7bd79a46 \
      DRR1C_HEAD=9b2ca643 DR2FIX_HEAD=781441bf python3 gen-cases.py 9a8d0f66

Batch i1 (TLC 2.19, two workers, 1,800 s per case; 17 cases):

| Case | Expected | Result |
|---|---|---|
| `i1.cc-done-turn-stopped` (the code before the fix) | `Inv_NoStopOnActiveDone` violated | violated |
| `i1.cc-end-behind-turn` (`4753e1cd`: TurnReport, EndVisit with no Stop, RunStop, the session's end) | `Inv_EndStopsTurn` violated | violated |
| `i1.cc-stalled-reply` (`4753e1cd` with R1-1; a reply that stalls, time limits not forced) | `Prop_PromptTaken` violated | violated (liveness) |
| `i1.fix-safety` (three visits, a person's end or delete, failing Stops; every earlier invariant and the four new) | PASS | PASS, 445,565 distinct states |
| `i1.fix-live` (two visits; `LIVE` and `Prop_PromptTaken`) | PASS | PASS, 23,899 distinct states |
| `i1.fix-stalled-reply` | PASS | PASS, 1,872 distinct states |
| `i1.fix-turn-fails` (with tf1's failing turns; every safety property) | PASS | PASS, 112,294 distinct states |
| `i1.fix-turn-fails-live` | PASS | PASS, 4,392 distinct states |
| `i1.fault-stop-unfenced` | `Inv_StopOwnVisit` violated | violated |
| `i1.wit-*` (eight witnesses) | reached | all reached |

### Review R2 of i1 (bound to 85c3ad9d)

Review R2 found three gaps in the R1 fixes. R2-2: the reply limit's abort is a background step on the worker; it
checked its turn once, so it could settle by force the next visit's turn, started meanwhile on the same session. R2-3:
a result whose write committed but whose acknowledgement was lost left the turn's tools open and no reply limit armed.
R2-1: a decided visit's turn could run again when its report came in a recovery's own run. The fixes: the abort acts
only on the run it was sent for; such a write reads the visit back; every recovery reads the visit before it resets
anything and before its model run.

New constants: `AsyncAbort` (the limit's abort is two steps: `ReplyFire`, then `ReplyAbort`), `AckLost` (a result's
acknowledgement may be lost), `Reconcile` (the R2-3 fix) and `AllowLoss` (`SessionLost`: a decided turn loses its
session); faults `"abort-unfenced"` and `"replay-decided"`. All four constants are `FALSE` in every earlier case, whose
behavior does not change. Witnesses: `W_NoAbortFenced` (the abort lands while the next visit's turn runs and leaves
it), `W_NoAckReconciled` (a lost acknowledgement is read back) and `W_NoLostNotRun` (a decided turn that lost its
session ends without running again). `CORRESPONDENCE-i1-r2-85c3ad9d.md` maps the new actions to the code.

Batch r2a (TLC 2.19, two workers, 3,600 s per case; 9 cases; model sha256 `8ae4e8ffa716...`):

| Case | Expected | Result |
|---|---|---|
| `i1.cc-abort-unfenced` (`0dae9760`: a visit's time limit stops its reported turn after the limit fired; the next visit's turn starts; the abort lands on it) | `Inv_StopOwnVisit` violated | violated |
| `i1.cc-ack-lost` (`0dae9760`: a lost acknowledgement, then a reply that stalls; time limits not forced) | `Prop_PromptTaken` violated | violated (liveness), 10,299 distinct states |
| `i1.fault-replay-decided` (a recovery that does not read the visit) | `Inv_NoTurnForDecided` violated | violated |
| `i1.fix-r2-safety` (three visits, a person's end or delete, failing Stops, the R2 environment; every earlier invariant and the four of i1) | PASS | PASS, 6,521,296 distinct states |
| `i1.fix-r2-live` (two visits; `LIVE` and `Prop_PromptTaken`) | PASS | PASS, 188,101 distinct states |
| `i1.fix-r2-stalled-reply` (a reply that stalls, also after a lost acknowledgement) | PASS | PASS, 13,908 distinct states |
| `i1.wit-abort-fenced`, `i1.wit-ack-reconciled`, `i1.wit-lost-not-run` | reached | all three reached |

(`i1.fault-replay-decided` ran as `i1.cc-replay-decided` in batch r2a; only its name and note changed.)

### Review R3 of i1 (bound to 19bd0cc1)

Review R3 found that the R2-3 read-back was a plain read, which can see the visit pending while the write's COMMIT is
still in flight. The fix reads the visit under a row lock that waits for the decision's own. In the model, `TurnReport`'s
read-back sees the result unless the new fault `"reconcile-unlocked"`. The other two R3 findings (a retried
`session: new` turn, a disconnect that never answers) are outside the model; `CORRESPONDENCE-i1-r3-19bd0cc1.md` says
how the code handles them.

Batch r3a (TLC 2.19, two workers, 3,600 s per case; model sha256 `f517c705cc65...`):

| Case | Expected | Result |
|---|---|---|
| `i1.fault-reconcile-unlocked` (a read-back that may see the visit pending; a reply that stalls, time limits not forced) | `Prop_PromptTaken` violated | violated (liveness) |
| `i1.fix-r2-stalled-reply` (the read-back ordered after the write) | PASS | PASS, 13,908 distinct states |
| `i1.wit-ack-reconciled` | reached | reached |

### Review R4 of i1 (bound to 88681dd1)

Review R4 found the same ordering gap at turn admission: a retry on another worker could read the visit open (a plain
read) while the first worker's completion was still committing, and run it again. The model's `TurnStart` reads the
visit in one step, ordered with the decisions, so it could not show that interleaving. The fix makes the code match the
model: admission reads the turn's visit under a row lock that waits for a decision in flight.
`CORRESPONDENCE-i1-r4-88681dd1.md` gives the mapping. The model does not change.

### Full run on the review R5 model (before D-2)

All 128 cases on the model of review R5 (sha256 `f517c705cc65...`, superseded by D-2 below; TLC 2.19, OpenJDK 21, two workers, 3,600 s per case),
2026-11-27: every case ended as expected (72 PASS, 48 safety violations and 8 liveness violations where the case
expects one, including every finding, fault and witness). The cases from before i1 keep their results with the new
constants `FALSE` (for example `cc.safety` 3,142 distinct states, `fix.all` 78,282, `impl.cc-final-live` 659,197), and
the i1 cases keep their batch results (`i1.fix-safety` 445,565, `i1.fix-live` 23,899, `i1.fix-r2-safety` 6,521,296,
`i1.fix-r2-live` 188,101).

### Design review D-1 and D-2 of i1 (owner decision a-fixes, bound to 1e0ea856)

D-2: a completed visit whose turn then ends without a commit (the reply limit, a lost session, a Stop while the run is
stopping) left the next cycle's prompt saying "what you did in earlier cycles is above". The fix (`NoteLoss`) marks such a
visit `lost` in the same step as that turn's end, while the run has not ended, and the next cycle's `TurnStart` checks
the claim: `Inv_NoFalseMemoryClaim` (no later cycle's turn starts with the claim while an earlier cycle of its session
that its agent completed did not commit and is not recorded lost) and `Inv_LostNotCommitted` (only a visit that did not
commit is marked). The invariant ranges over visits their agent completed (`how = "result"`) only: a visit decided by its
time limit or a cancel, whose Stop ends its turn unsaved, and a recovery that starts a fresh conversation are not
recorded in the code either (documented known limits), and the model does not claim them.
A visit whose turn failed for good after its report (`TurnFails`, its activity's retries spent) records nothing in the
code; it is outside the invariant and shown by the limit case. D-1 (the turn's background tasks cancelled at the report)
changes no modelled step: a reply that never ends by itself is already a choice (`AllowStall`).
`CORRESPONDENCE-i1-afix-1e0ea856.md` gives the mapping.

Model sha256 `014926672f2e...`; the batch reran every `i1.*` case, the new limit case and the regression set (46 cases;
TLC 2.19, OpenJDK 21, two workers), 2026-11-27: all as expected. With `NoteLoss` `FALSE` the earlier cases keep their
state counts (`i1.fix-safety` 445,565, `i1.fix-r2-safety` 6,521,296, `i1.fix-r2-live` 188,101).

| Case | Expected | Result |
|---|---|---|
| `i1.cc-false-memory-claim` (the code at 58e4d056) | `Inv_NoFalseMemoryClaim` violated | violated: report, the next visit queued, the reported turn loses its session, the next turn starts (1,004 distinct states) |
| `i1.fix-memory-safety` (three visits, a person's end or delete, failing Stops) | PASS | PASS, 7,204,588 distinct states |
| `i1.fix-memory-live` | PASS | PASS, 207,181 distinct states |
| `i1.fix-memory-turn-fails` | PASS | PASS, 53,250 distinct states |
| `i1.wit-loss-told` (non-vacuity) | reached | reached: the same trace, the next turn told |
| `limit.i1-turn-fails-untold` | reached | reached (1,459 distinct states) |

### Full run on the final model (D-2)

All 134 cases on the final model (sha256 `014926672f2e...`; TLC 2.19, OpenJDK 21, two workers), 2026-11-27 08:23 to
09:43 UTC: every case ended as expected, 75 PASS, 51 safety violations and 8 liveness violations, each where the case
expects one (every finding, fault, witness and limit case). The longest, `cc.drr2-crash-live`, passed with 1,771,490
distinct states in 16 minutes. The PASS cases keep their state counts (`cc.safety` 3,142, `fix.all` 78,282,
`impl.cc-final-live` 659,197, `i1.fix-safety` 445,565, `i1.fix-r2-safety` 6,521,296, `i1.fix-memory-safety` 7,204,588,
`i1.fix-memory-live` 207,181, `i1.fix-memory-turn-fails` 53,250). A violation's count depends on when a worker finds it
(two workers): `i1.cc-false-memory-claim` violated `Inv_NoFalseMemoryClaim` at 1,035 distinct states, the witness
`i1.wit-loss-told` was reached at 983 and `limit.i1-turn-fails-untold` at 1,349.

### Issue I8 (`session: continue` in named parallel branches)

`WfBranchContinuedSession.tla` models an enclosing `parallel` state with named `branches:` that an outer loop can
re-enter (`MaxForks = 2`, resetting per-scope `n.ordinal` to `1`), checking concurrent branch isolation, branch cuts
(`failFast` / `join: { first: k }` / `parallel.timeoutSeconds`) racing against `completeAgentNode` CAS and `I1`'s
post-report reply turns, owed cycle Stops resolved at run end with no re-entry, cross-fork session replacements,
graceful stop (`run.stop`) with mixed idle/pending branches (`Q5`), and the deliberate `OrderByNodeOrdinalOnly` fault
(bare `n.ordinal` ordering inverting fork-2 visit 1 behind fork-1 visit 2).

Run on TLC 2.19 (2026-11-27, Temurin JDK 21.0.13.1, two workers): 15 of 15 `i8.*` cases as expected, no timeouts.

| Case | Expected | Result |
|---|---|---|
| `i8.fix-two-branch-safety` | PASS | PASS, 2,700,838 distinct states (88 s) |
| `i8.fix-two-branch-live` | PASS | PASS, 87,455 distinct states (13 s) |
| `i8.fix-fail-branch-isolation` | PASS | PASS, 10,398 distinct states (2 s) |
| `i8.fix-outer-loop-safety` | PASS | PASS, 644,319 distinct states (20 s) |
| `i8.fix-outer-loop-live` | PASS | PASS, 644,319 distinct states (101 s) |
| `i8.fix-two-branch-outer-safety` | PASS | PASS, 4,211,022 distinct states (128 s) |
| `i8.fault-node-ordinal-only` (`OrderByNodeOrdinalOnly = TRUE`) | `Inv_MonotonicCycleOrder` violated | violated (104 distinct states) |
| `i8.fault-node-ordinal-q5` (`OrderByNodeOrdinalOnly = TRUE`) | `Inv_StoppingKeepsActiveVisit` violated | violated (589 distinct states) |
| `i8.wit-*` (7 non-vacuity witnesses) | reached | all 7 reached (`W_BranchLoopCommitRecall`, `W_CutPendingStopsVisit`, `W_CutAfterDoneKeepsReply`, `W_OuterForkReentry`, `W_CrossForkReplacement`, `W_StoppingMixedBranches`, `W_OwedCutThenRunEnd`) |

## How to run

As in `../../session-orchestration/README.md`: `TLA_TOOLS=<dir with tla2tools.jar> ./check-packet.sh` then
`./run-tlc.sh [out]`.
