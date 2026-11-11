-------------------------- MODULE TimerHandoff --------------------------
EXTENDS Naturals
CONSTANTS TimerKinds, RestoreOnNoTurn
VARIABLES timerKind, phase, now, deadline, active, released, savedRemaining,
          queuedFire, ranTurn, cancelled, releaseAt, armedKind, finishedAt
vars == <<timerKind, phase, now, deadline, active, released, savedRemaining,
          queuedFire, ranTurn, cancelled, releaseAt, armedKind, finishedAt>>
Gate == timerKind \in {"budget", "workspace"}
OwedFire == timerKind \in {"wait", "cron", "cron_at"}
Init ==
    /\ timerKind \in TimerKinds
    /\ phase = "queued" /\ now = 0 /\ deadline = 2
    /\ active = TRUE /\ released = FALSE /\ savedRemaining = 0
    /\ queuedFire = FALSE /\ ranTurn = FALSE /\ cancelled = FALSE
    /\ releaseAt = 0 /\ armedKind = timerKind /\ finishedAt = 0
Tick ==
    /\ now < 4 /\ now' = now + 1
    /\ UNCHANGED <<timerKind, phase, deadline, active, released, savedRemaining,
          queuedFire, ranTurn, cancelled, releaseAt, armedKind, finishedAt>>
Release ==
    /\ phase = "queued"
    /\ active' = FALSE /\ phase' = "released" /\ releaseAt' = now
    /\ armedKind' = "none"
    /\ savedRemaining' = IF now < deadline THEN deadline - now ELSE 0
    /\ queuedFire' = (OwedFire /\ now >= deadline)
    /\ released' = ~(OwedFire /\ now >= deadline)
    /\ UNCHANGED <<timerKind, now, deadline, ranTurn, cancelled, finishedAt>>
CancelPrompt ==
    /\ phase = "released" /\ phase' = "settle" /\ cancelled' = TRUE
    /\ UNCHANGED <<timerKind, now, deadline, active, released, savedRemaining,
          queuedFire, ranTurn, releaseAt, armedKind, finishedAt>>
RunPrompt ==
    /\ phase = "released" /\ phase' = "running" /\ ranTurn' = TRUE
    /\ UNCHANGED <<timerKind, now, deadline, active, released, savedRemaining,
          queuedFire, cancelled, releaseAt, armedKind, finishedAt>>
\* Only a normal completion with unchanged schedules is represented here.
\* Gate retries and agent-polls are not resumed; an idle hold is new work.
FinishPrompt ==
    /\ phase = "running" /\ phase' = "settled" /\ released' = FALSE
    /\ active' = TRUE /\ finishedAt' = now
    /\ armedKind' = IF timerKind \in {"cron", "cron_at"} THEN timerKind
                    ELSE IF timerKind = "wait" /\ savedRemaining > 0
                         THEN "wait" ELSE "idle"
    /\ deadline' = IF timerKind = "cron_at" THEN deadline
                   ELSE IF timerKind \in {"wait", "cron"} /\ savedRemaining > 0
                        THEN now + savedRemaining ELSE now + 2
    /\ UNCHANGED <<timerKind, now, savedRemaining, queuedFire, ranTurn, cancelled, releaseAt>>
SettleNoTurn ==
    /\ phase = "settle" /\ phase' = "settled"
    /\ active' = (RestoreOnNoTurn /\ released)
    /\ armedKind' = IF RestoreOnNoTurn /\ released THEN timerKind ELSE "none"
    /\ released' = FALSE
    /\ UNCHANGED <<timerKind, now, deadline, savedRemaining, queuedFire,
          ranTurn, cancelled, releaseAt, finishedAt>>
Next == Tick \/ Release \/ CancelPrompt \/ RunPrompt \/ FinishPrompt \/ SettleNoTurn
TypeOK ==
    /\ timerKind \in TimerKinds
    /\ phase \in {"queued", "released", "settle", "running", "settled"}
    /\ now \in 0..4 /\ deadline \in 0..6 /\ releaseAt \in 0..4
    /\ finishedAt \in 0..4 /\ armedKind \in TimerKinds \cup {"none"}
    /\ savedRemaining \in 0..2
    /\ active \in BOOLEAN /\ released \in BOOLEAN /\ queuedFire \in BOOLEAN
    /\ ranTurn \in BOOLEAN /\ cancelled \in BOOLEAN
NoStrandedTimer == phase = "settled" /\ ~ranTurn => active \/ queuedFire
NoGateRearm == phase = "settled" /\ ranTurn /\ Gate => armedKind = "idle"
NoAgentPollRearm == phase = "settled" /\ ranTurn /\ timerKind = "agent-poll"
                   => armedKind = "idle"
CancelledKeepsDeadline == phase = "settled" /\ cancelled /\ active => deadline = 2
WallClockKeepsDeadline == phase = "settled" /\ timerKind = "cron_at" => deadline = 2
RelativeWaitKeepsRemaining ==
    phase = "settled" /\ ranTurn /\ timerKind \in {"wait", "cron"}
    /\ savedRemaining > 0 => deadline = finishedAt + savedRemaining
Spec == Init /\ [][Next]_vars
=============================================================================
