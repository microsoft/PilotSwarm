# The continued agent session (session lifecycle "continue")

`WfContinuedSession.tla` models an agent state whose visits in one run go to one agent session, the default for an
agent state in the outer graph. `CORRESPONDENCE-2a6e6912.md` maps it to the code. A TLC pass is a bounded check, not a
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

Constants switch on a person's end or delete, a stop or cancel, failing Stops and a failing end, and each proposed
fix (`SpawnRecheck`, `StopBeforeSpawn`, `PerAgentSessionEnd`, `StopAtRunEnd`, and `EndMark` for the G1 residual).
`SplitSpawn` takes the spawn as three steps (the check, the child create, the send) and `MarkSplit` a person's end as
two (the mark, the command), so that other steps can run between them; `CheckAll`, `Fence`, `Backstop`,
`AllowSpawnCrash`, `MarkFail`, `Withdraw`, `Outbox`, `Carry`, `CarryDelete`, `TurnGuard`, `MarkCreating` and `CarryNotFound` describe the DRR-1 and DRR-2 code and fixes (see the module
header). `Inv_OneLive` does not count an agent session whose end command is on its way.
`RecheckSeesEnding` says whether the spawn's check sees an agent session whose end was asked while one of its turns
runs (the code: no, its orchestration reads Running until the turn ends). `cases.tsv`, `cases.json` and
`tlc-templates.json` (89 cases) are written by

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

Every one of the 89 cases has a TLC result as expected; none is left unchecked (`cc.drr2-crash-live`, not checked
within 1,800 s in cc6l, passed at 3,600 s in cc9l).

## tf1 (2026-11-10): a turn that fails terminally (bound to 2a6e6912)

Runs (2026-11-10, TLC 2.19, two workers, 600 s per case): the design run, 63 of 63 as expected (the three findings of the code before the fix violate their liveness property; every fix case passes), and the run with the drop on success, 72 of 72 as expected.

The code binding of this fix (all three models) is `../orchestration/CORRESPONDENCE-tf1-2a6e6912.md`.

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

## How to run

As in `../../session-orchestration/README.md`: `TLA_TOOLS=<dir with tla2tools.jar> ./check-packet.sh` then
`./run-tlc.sh [out]`.
