# Workflow controller: idle waits in the running loop

`WfIdleWake.tla` models the wait at the end of a controller pass, in both controllers 1.8.0 and 1.9.0
(`packages/sdk/src/workflow/runtime.ts`). The wait races the command queue against a timer. Wakes and commands
share that queue, in order. An idle wait is counted; at `WORKFLOW_IDLE_WAITS_PER_EXECUTION` (50) the controller
continues as new. A TLC pass is a bounded check, not a proof.

The Workflow version collapse removes controller 1.8.0: its four cases (`iw-180.*`) are retired
(`cases-retired.json`, kept for the record, never run), and the `iw-190.*` cases bind the surviving loop.

## Status

| Item | Value |
|---|---|
| Code | `bb162ed8`; `packages/sdk/src` byte-identical at `8aaf5435` (on v0.8.10) |
| Finding | At `d2274e0d` only a timer win counted in the running loop; a wake that brought no command looped back uncounted. Under a steady stream of such wakes, with all work waiting, the controller never continued as new and its history grew without bound. Both controllers had it. Fixed in place in `bb162ed8` (Workflow is not released). |
| TLC run | 2026-11-08, batch so5b: 11 of 11 as expected |

## Correspondence

| Model | 1.8.0 | 1.9.0 |
|---|---|---|
| race of the command queue against the timer | 1360 | 2092 |
| `CommandWin` (applied first) | 1361-1364 | 2093-2096 |
| `WakeWin` / `TimerWin` counted, `Counted` continues as new at the cap | 1365-1366 | 2097-2098 |
| `Mode = "d2274e0d"` (only a timer win counted) | 1347-1361 at `d2274e0d` | 2079-2088 at `d2274e0d` |
| paused loops (same order, unchanged) | 1265-1270 | `pausedPass` 1718-1723 |

`Cap` stands for `WORKFLOW_IDLE_WAITS_PER_EXECUTION` (50, runtime.ts 206). The top-of-pass `takeQueuedCommand` poll
and the admissions cap (25) are unchanged and not modelled. A completion's wake is a hint: the result is in the store,
and the next execution's first pass collects it.


## Cases

| Case | Expected | Meaning |
|---|---|---|
| `iw-190.fix`, `iw-190.fix-live` | PASS | A command is applied first; every other wait counts; the controller continues as new under wakes; every command is applied. |
| `iw-190.old-history` | `Inv_HistoryBounded` violated | `d2274e0d`: an execution makes more passes than the cap. |
| `iw-190.old-live` | `Prop_ContinuesAsNew` violated | `d2274e0d`: under a steady wake stream it never continues as new. |
| `fault.iw-count-then-can` | `Inv_CommandsKept` violated | Counting before parsing, then continuing as new with a dequeued command, loses it. |
| `fault.iw-swallow` | `Inv_CommandsKept` violated | A command counted as a wake and dropped. |
| `wit.iw-can-by-wake` | witness violated | A continue-as-new reached through wakes. |
| `iw-180.*` (4, retired) | as their `iw-190` twins | Controller 1.8.0, removed; the same settings as the `iw-190` cases. |

`Cap` is 3 in the cases (50 in code). Run with `TLA_TOOLS=<dir with tla2tools.jar> ./run-tlc.sh [out]` after
`./check-packet.sh`, as in `../../session-orchestration/README.md`. The settings files are generated from `cases.json` and
`tlc-templates.json` (`../../tlc_cases.py`) and are not committed.
