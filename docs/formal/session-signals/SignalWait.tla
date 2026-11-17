----------------------------- MODULE SignalWait -----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Mode, Fault
ASSUME Mode \in {"signal", "any"}
ASSUME Fault \in {"none", "priority", "deadline", "stop", "carry"}

Kinds == {"stop", "user", "signal", "timeout"}
VARIABLES pending, interrupted, deadline, now, inbox, arrivals, consumed,
          winner, atGate, stopped, checkpointed, modelTurn
vars == <<pending, interrupted, deadline, now, inbox, arrivals, consumed,
          winner, atGate, stopped, checkpointed, modelTurn>>

Init ==
    /\ pending = TRUE /\ interrupted = FALSE /\ deadline = 2 /\ now = 0
    /\ inbox = {} /\ arrivals = {} /\ consumed = {}
    /\ winner = "none" /\ atGate = "none" /\ stopped = FALSE
    /\ checkpointed = FALSE /\ modelTurn = FALSE

Priority ==
    IF "stop" \in inbox THEN "stop"
    ELSE IF "user" \in inbox THEN "user"
    ELSE IF "signal" \in inbox THEN "signal"
    ELSE IF "timeout" \in inbox THEN "timeout"
    ELSE "none"

Arrival(k) ==
    /\ k \in {"stop", "user", "signal"} /\ k \notin arrivals
    /\ arrivals' = arrivals \cup {k} /\ inbox' = inbox \cup {k}
    /\ UNCHANGED <<pending, interrupted, deadline, now, consumed, winner,
                   atGate, stopped, checkpointed, modelTurn>>

Tick ==
    /\ now < 3 /\ now' = now + 1
    /\ LET expired == pending /\ now' >= deadline /\ "timeout" \notin arrivals
       IN /\ arrivals' = IF expired THEN arrivals \cup {"timeout"} ELSE arrivals
          /\ inbox' = IF expired THEN inbox \cup {"timeout"} ELSE inbox
    /\ UNCHANGED <<pending, interrupted, deadline, consumed, winner,
                   atGate, stopped, checkpointed, modelTurn>>

Finish(k) ==
    /\ pending /\ ~modelTurn
    /\ k = IF Fault = "priority" /\ "signal" \in inbox /\ "stop" \notin inbox
           THEN "signal" ELSE Priority
    /\ k # "none" /\ (k # "user" \/ Mode = "any")
    /\ consumed' = consumed \cup {k} /\ inbox' = inbox \ {k}
    /\ winner' = k /\ atGate' = Priority
    /\ pending' = FALSE /\ interrupted' = FALSE
    /\ stopped' = (k = "stop")
    /\ UNCHANGED <<deadline, now, arrivals, checkpointed, modelTurn>>

Interrupt ==
    /\ pending /\ ~modelTurn /\ Mode = "signal" /\ Priority = "user"
    /\ inbox' = inbox \ {"user"} /\ consumed' = consumed \cup {"user"}
    /\ interrupted' = TRUE /\ modelTurn' = TRUE
    /\ UNCHANGED <<pending, deadline, now, arrivals, winner, atGate,
                   stopped, checkpointed>>

ReturnNormal ==
    /\ modelTurn /\ modelTurn' = FALSE /\ interrupted' = FALSE
    /\ deadline' = IF Fault = "deadline" THEN now + 2 ELSE deadline
    /\ UNCHANGED <<pending, now, inbox, arrivals, consumed, winner,
                   atGate, stopped, checkpointed>>

ReturnStopped ==
    /\ modelTurn /\ modelTurn' = FALSE /\ interrupted' = FALSE
    /\ stopped' = TRUE /\ pending' = (Fault = "stop")
    /\ winner' = "stop" /\ atGate' = "stop"
    /\ UNCHANGED <<deadline, now, inbox, arrivals, consumed, checkpointed>>

ContinueAsNew ==
    /\ ~checkpointed /\ checkpointed' = TRUE
    /\ pending' = IF Fault = "carry" THEN FALSE ELSE pending
    /\ UNCHANGED <<interrupted, deadline, now, inbox, arrivals, consumed,
                   winner, atGate, stopped, modelTurn>>

Decide == (\E k \in Kinds : Finish(k)) \/ Interrupt
Return == ReturnNormal \/ ReturnStopped
Next == (\E k \in Kinds : Arrival(k)) \/ Tick \/ Decide \/ Return
        \/ ContinueAsNew \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Tick) /\ WF_vars(Decide) /\ WF_vars(Return)

TypeOK ==
    /\ pending \in BOOLEAN /\ interrupted \in BOOLEAN /\ modelTurn \in BOOLEAN
    /\ deadline \in 2..5 /\ now \in 0..3
    /\ inbox \subseteq Kinds /\ arrivals \subseteq Kinds /\ consumed \subseteq Kinds
    /\ winner \in Kinds \cup {"none"} /\ atGate \in Kinds \cup {"none"}
    /\ stopped \in BOOLEAN /\ checkpointed \in BOOLEAN
Accounting == arrivals = inbox \cup consumed /\ inbox \cap consumed = {}
GatePriority == winner = "none" \/ winner = atGate
AbsoluteDeadline == deadline = 2
StopIsFinal == stopped => ~pending
WaitNotLost == pending \/ winner # "none"
WaitProgress == pending ~> ~pending
=============================================================================
