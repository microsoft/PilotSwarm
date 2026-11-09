# The continued agent session (session lifecycle "continue")

`WfContinuedChat.tla` models an agent state whose visits in one run go to one agent session, the default for an
agent state in the outer graph. `CORRESPONDENCE-9a8d0f66.md` maps it to the code. A TLC pass is a bounded check, not a
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
| `Prop_AllEnded`, `Prop_OthersEnded` | After the run ends, every agent session is ended (G3). |
| `Prop_OwedSent` | An owed end is eventually sent. |
| `Prop_VisitsDecided` | Every visit is decided (guaranteed by the time limit). |

Constants switch on a person's end or delete, a stop or cancel, failing Stops and a failing end, and each proposed
fix (`SpawnRecheck`, `StopBeforeSpawn`, `PerChatEnd`, `StopAtRunEnd`). `gen-cases.py <commit>` writes the settings
files, `cases.tsv` and `cases.json`.

## Results

Design run, bound to `a1772a01` (unchanged at `9a8d0f66`; 2026-11-09; TLC 2.19, two workers, 300 s per case): 27 of 27 as expected, no
timeouts. Largest case `fix.all`, 70,558 distinct states, 63 s.

| Group | Cases | Result |
|---|---|---|
| The code with no gap triggered (`cc.*`) | 7 | PASS: one agent session at a time, results bound to their own visit, ends sent once, every agent session ended after the run ends, owed ends sent |
| Proposed fixes (`fix.*`) | 5 | PASS, each fix alone and all together |
| Findings (`finding.*`) | 5 | violated as found in the code (G1 silent and loud, G2, G3, G5) |
| Design limit (`limit.g3-failed-chat`) | 1 | an agent session whose end fails past every retry stays open until a recover |
| Deliberate faults (`fault.*`) | 5 | each fails on its property |
| Witnesses (`wit.*`) | 4 | reached |

Findings (each from the code at `a1772a01`, the same at `9a8d0f66`, confirmed in the model; the fixes are decided by the owner):

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

## How to run

As in `../../session-orchestration/README.md`: `TLA_TOOLS=<dir with tla2tools.jar> ./check-packet.sh` then
`./run-tlc.sh [out]`.
