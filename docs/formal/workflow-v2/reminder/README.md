# Workflow v2 in-turn step reminder model (8d568890; chain 052c0174..8a5b0b7d)

`WorkflowV2Reminder.tla` models the reminder a workflow agent state's child gets
inside its turn when the turn would end with nothing pending (design
decision Q2): `managed-session.ts` (`_runTurnWithState` trigger and re-check 4403-4460,
`runCorrection` 4195-4220, `awaitStepReminderGate` 1796-1836),
`session-proxy.ts` (`stepReminder.check` 4876-4890: published schedule, then the
store) and `store.ts` (`recordAgentReminder` 5424-5466), all in `packages/sdk/src/workflow/v2`
at `8d568890` (line numbers refer to that commit). The reminder chain
`052c0174..8a5b0b7d` is live in `8d568890`; the code is `agent-reminder.ts`
and the files named above.

| Module | Models |
|---|---|
| `WorkflowV2Reminder.tla` | One agent step and its child's turns: the reminder gate, its records and sends, Stop, interrupt, steer, held controls, a queued message, a guard, a schedule, a sub-agent, the deadline and send failures |

## Abstractions

- **One step, its child's turns.** `MaxTurns` turns; a turn's activity may run
  again after a crash (`MaxRetry`) with the same turn index.
- **The run.** Ends quietly, with a turn-ending action (wait, cron, question,
  error, sub-agent call) or by completing the step. Only a quiet end with
  nothing pending asks the gate.
- **The gate.** One store transaction (its locks and one clock reading are one
  step): the published schedule, the step open and in time, no sub-agent at
  work, one record per turn index, at most `Max` per step. It runs to its end
  even when the turn stopped waiting (a late answer is ignored).
- **JavaScript.** The re-check after the gate, runCorrection's Stop check,
  beforeSend and the start of the send are one synchronous step. The send is
  one step to accept or fail; the reminder run is one step.
- **Environment.** Stop, interrupt, steer, held controls, queued message,
  guard expiry, an active schedule, a busy sub-agent, the deadline, and the
  child's end after the step was decided, at any time.
- **Not modeled.** The CLI's events inside a run (the reminder run's idle that
  `nextRun()` catches before `send()` resolves), the reminder's text, the
  tool-call check of its answer, and the question to the parent (a turn-ending
  action here).

## Groups

| Group | Cases | Meaning |
|---|---|---|
| `rem-safety` | 3 | Caps, records, pending work, event order hold (expected PASS). |
| `rem-live` | 2 | A stalled step is reminded or decided; Stop always ends the turn (expected PASS). |
| `rem-witness` | 6 | Reachable: a reminder, three, recorded but not sent, sent after the step was decided, sent with a message queued, two sends for one turn index. |
| `rem-fault` | 6 | Planned breaks of E1, E2, the cap, the step check, the turn key, the race with Stop. |
| `rem-compare` | 1 | send() not raced with Stop: a CLI that never answers holds Stop. |

## Results

All 18 cases ran on 2026-11-04 on an isolated machine (TLC 2.19, 2 workers), batch r1:
18 of 18 as predicted. The expected outcomes are in `cases.json` (18 cases: 5 PASS, 11 safety
violation, 2 liveness violation). A case that exceeds its time or memory cap is PARTIAL
(VOID if it stops on an error), never PASS.

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
`CHECK_DEADLOCK TRUE`. A TLC pass is a bounded check, not a proof.
`gen-cases.py` regenerates the settings files, `cases.tsv` and `cases.json`.
