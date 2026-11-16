------------------------- MODULE TimerGeneration -------------------------
EXTENDS Naturals
CONSTANTS Kind, OneShot, ResetSchedule, CheckGeneration
\* Schedule 1 is the old schedule. Its fire is due and waits in the queue
\* behind a person's prompt. The prompt's turn installs schedule 2, or
\* cancels the schedule. Schedule 2 is first due at FirstDue.
FirstDue == 3
Horizon == 4
VARIABLES phase, now, schedule, firstPending, firedGeneration, earlyFire,
          firstRun
vars == <<phase, now, schedule, firstPending, firedGeneration, earlyFire,
          firstRun>>

Init ==
    /\ phase = "prompt-first" /\ now = 0 /\ schedule = 1
    /\ firstPending = FALSE /\ firedGeneration = 0
    /\ earlyFire = FALSE /\ firstRun = FALSE

\* The person's turn replaces the schedule, or cancels it.
PromptChangesSchedule ==
    /\ phase = "prompt-first"
    /\ schedule' = IF ResetSchedule THEN 2 ELSE 0
    /\ firstPending' = ResetSchedule
    /\ phase' = "old-fire"
    /\ UNCHANGED <<now, firedGeneration, earlyFire, firstRun>>

\* The queued old fire runs next. processTimer reads the current schedule.
OldFireRuns ==
    /\ phase = "old-fire"
    /\ LET run == schedule # 0 /\ (~CheckGeneration \/ schedule = 1)
       IN /\ firedGeneration' = IF run THEN schedule ELSE 0
          /\ earlyFire' = (run /\ schedule = 2 /\ now < FirstDue)
          \* cron_at records the new schedule's next occurrence as done.
          /\ firstPending' = IF run /\ Kind = "cron_at" THEN FALSE
                             ELSE firstPending
          \* A one-shot cron_at is complete after one fire.
          /\ schedule' = IF run /\ Kind = "cron_at" /\ OneShot THEN 0
                         ELSE schedule
    /\ phase' = "running"
    /\ UNCHANGED <<now, firstRun>>

\* The new schedule's first occurrence runs at its time, if still pending.
ScheduledRun ==
    /\ phase = "running" /\ now = FirstDue /\ firstPending /\ schedule # 0
    /\ firstRun' = TRUE /\ firstPending' = FALSE
    /\ UNCHANGED <<phase, now, schedule, firedGeneration, earlyFire>>

\* Time passes. It cannot pass a pending occurrence without running it.
Tick ==
    /\ phase = "running" /\ now < Horizon
    /\ ~(now = FirstDue /\ firstPending /\ schedule # 0)
    /\ now' = now + 1
    /\ UNCHANGED <<phase, schedule, firstPending, firedGeneration, earlyFire,
                   firstRun>>

Next == PromptChangesSchedule \/ OldFireRuns \/ ScheduledRun \/ Tick

TypeOK ==
    /\ phase \in {"prompt-first", "old-fire", "running"}
    /\ now \in 0..Horizon /\ schedule \in 0..2
    /\ firstPending \in BOOLEAN /\ firedGeneration \in 0..2
    /\ earlyFire \in BOOLEAN /\ firstRun \in BOOLEAN

NoFireAfterCancel == ~ResetSchedule => firedGeneration = 0
NoStaleGeneration == firedGeneration \in {0, 1}
NoEarlyReplacementFire == ~earlyFire
FirstOccurrenceKept == (ResetSchedule /\ now > FirstDue) => firstRun

Spec == Init /\ [][Next]_vars
=============================================================================
