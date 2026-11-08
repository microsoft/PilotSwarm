--------------------------- MODULE TimerInterrupt ---------------------------
EXTENDS Naturals
CONSTANTS Kind, Rule, MaxDelay
\* One time unit is 100 ms. The armed wait or cron is due at Deadline (3 s).
Deadline == 30
\* JavaScript Math.round(ms / 1000) for ms >= 0.
RoundSec(ms) == (ms + 500) \div 1000
Max(a, b) == IF a > b THEN a ELSE b
VARIABLES phase, now, handledAt, savedMs, savedSec, queued, outcome
vars == <<phase, now, handledAt, savedMs, savedSec, queued, outcome>>

Init ==
    /\ phase = "armed" /\ now = 0 /\ handledAt = 0
    /\ savedMs = 0 /\ savedSec = 0 /\ queued = FALSE /\ outcome = "pending"

\* Time passes while the timer is armed. It may jump to any earlier moment.
Tick ==
    /\ phase = "armed"
    /\ \E t \in (now + 1)..(Deadline - 1) : now' = t
    /\ UNCHANGED <<phase, handledAt, savedMs, savedSec, queued, outcome>>

\* Nothing interrupts: the timer fires at its deadline and its turn runs.
TimerFires ==
    /\ phase = "armed"
    /\ now' = Deadline /\ phase' = "settled" /\ outcome' = "fired"
    /\ UNCHANGED <<handledAt, savedMs, savedSec, queued>>

\* A prompt wins the race against the timer before the deadline.
MessageArrives ==
    /\ phase = "armed"
    /\ phase' = "received"
    /\ UNCHANGED <<now, handledAt, savedMs, savedSec, queued, outcome>>

\* The loop handles the prompt up to MaxDelay later and saves what is left.
\* Rule "prompt": the current interrupt code. Rule "release": the rule for
\* queued work. Rule "atLeastOne": the rule for a model switch.
Handle ==
    /\ phase = "received"
    /\ \E d \in 0..MaxDelay :
         LET at == now + d
             ms == IF at < Deadline THEN (Deadline - at) * 100 ELSE 0
             due == ms = 0 \/ (Kind = "wait" /\ RoundSec(ms) = 0)
         IN /\ handledAt' = at
            /\ savedMs' = ms
            /\ savedSec' = IF Rule = "atLeastOne" THEN Max(1, RoundSec(ms))
                           ELSE RoundSec(ms)
            /\ queued' = (Rule = "release" /\ due)
    /\ phase' = "replying"
    /\ UNCHANGED <<now, outcome>>

\* After the reply turn, schedulePostTurnContinuation runs.
FinishReply ==
    /\ phase = "replying"
    /\ phase' = "settled"
    /\ outcome' = CASE queued -> "queued"
                    [] Kind = "wait" /\ savedSec > 0 -> "resumed"
                    [] Kind = "cron" /\ savedMs > 0 -> "resumed"
                    [] Kind = "wait" -> "lost"
                    [] OTHER -> "skipped"
    /\ UNCHANGED <<now, handledAt, savedMs, savedSec, queued>>

Next == Tick \/ TimerFires \/ MessageArrives \/ Handle \/ FinishReply

TypeOK ==
    /\ phase \in {"armed", "received", "replying", "settled"}
    /\ now \in 0..Deadline /\ handledAt \in 0..(Deadline + MaxDelay)
    /\ savedMs \in 0..(Deadline * 100) /\ savedSec \in 0..4
    /\ queued \in BOOLEAN
    /\ outcome \in {"pending", "fired", "queued", "resumed", "lost", "skipped"}

\* An interrupted timer is resumed, or its due fire is queued. It is never dropped.
NoLostTimer == phase = "settled" => outcome \in {"fired", "queued", "resumed"}

Spec == Init /\ [][Next]_vars
=============================================================================
