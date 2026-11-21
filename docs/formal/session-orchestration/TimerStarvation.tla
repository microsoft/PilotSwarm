-------------------------- MODULE TimerStarvation --------------------------
EXTENDS Naturals
CONSTANTS Input, CountTurnTime, DueFirst
\* Input = "finite": one more prompt may arrive, at any time.
\* Input = "gaps": prompts keep arriving, but only while the session is idle.
\* Input = "backlog": each new prompt arrives while a turn is running.
StartRemaining == 2
VARIABLES phase, queued, remaining, fired, extra
vars == <<phase, queued, remaining, fired, extra>>

Init ==
    /\ phase = "idle" /\ queued = TRUE /\ remaining = StartRemaining
    /\ fired = FALSE /\ extra = 1

Arrive ==
    /\ ~queued
    /\ CASE Input = "finite" -> extra > 0
         [] Input = "gaps" -> phase = "idle"
         [] OTHER -> phase = "turn"
    /\ queued' = TRUE
    /\ extra' = IF Input = "finite" THEN extra - 1 ELSE extra
    /\ UNCHANGED <<phase, remaining, fired>>

\* People run before timers. DueFirst is a proposed rule.
StartTurn ==
    /\ phase = "idle" /\ queued
    /\ ~(DueFirst /\ remaining = 0 /\ ~fired)
    /\ phase' = "turn" /\ queued' = FALSE
    /\ UNCHANGED <<remaining, fired, extra>>

\* The code pauses a wait or cron during a turn. CountTurnTime is proposed.
TurnTime ==
    /\ phase = "turn" /\ CountTurnTime /\ remaining > 0
    /\ remaining' = remaining - 1
    /\ UNCHANGED <<phase, queued, fired, extra>>

EndTurn ==
    /\ phase = "turn"
    /\ phase' = "idle"
    /\ UNCHANGED <<queued, remaining, fired, extra>>

\* Idle time counts the timer down.
IdleTime ==
    /\ phase = "idle" /\ ~queued /\ remaining > 0
    /\ remaining' = remaining - 1
    /\ UNCHANGED <<phase, queued, fired, extra>>

TimerFires ==
    /\ phase = "idle" /\ remaining = 0 /\ ~fired
    /\ (~queued \/ DueFirst)
    /\ fired' = TRUE
    /\ UNCHANGED <<phase, queued, remaining, extra>>

Next == Arrive \/ StartTurn \/ TurnTime \/ EndTurn \/ IdleTime \/ TimerFires

TypeOK ==
    /\ phase \in {"idle", "turn"} /\ queued \in BOOLEAN
    /\ remaining \in 0..StartRemaining /\ fired \in BOOLEAN /\ extra \in 0..1

\* Weak fairness: a step that stays possible happens. Strong fairness: idle
\* moments and turn time that keep coming back do pass. This excludes idle
\* gaps that shrink toward zero.
Spec == Init /\ [][Next]_vars
        /\ WF_vars(StartTurn) /\ WF_vars(EndTurn)
        /\ SF_vars(TurnTime) /\ SF_vars(IdleTime) /\ SF_vars(TimerFires)

TimerEventuallyRuns == <>fired
=============================================================================
