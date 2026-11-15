----------------------------- MODULE WaitScopes -----------------------------
EXTENDS Naturals
CONSTANT Fault
ASSUME Fault \in {"none", "timer", "stop", "turn"}
VARIABLES wait, turn, observed, replacement, fired, command, cancelled
vars == <<wait, turn, observed, replacement, fired, command, cancelled>>
Init == /\ wait = 1 /\ turn = 0 /\ observed = 0 /\ replacement = FALSE
        /\ fired = FALSE /\ command = FALSE /\ cancelled = "none"
Observe == /\ observed = 0 /\ observed' = 1
           /\ UNCHANGED <<wait, turn, replacement, fired, command, cancelled>>
ReplaceWait == /\ observed = 1 /\ ~replacement /\ wait = 1
               /\ wait' = 2 /\ replacement' = TRUE
               /\ UNCHANGED <<turn, observed, fired, command, cancelled>>
ReplaceTurn == /\ observed = 1 /\ ~replacement /\ wait = 1
               /\ wait' = 0 /\ turn' = 7 /\ replacement' = TRUE
               /\ UNCHANGED <<observed, fired, command, cancelled>>
OldTimer == /\ ~fired /\ replacement /\ wait = 2
            /\ fired' = TRUE
            /\ wait' = IF Fault = "timer" THEN 0 ELSE wait
            /\ cancelled' = IF Fault = "timer" THEN "new-wait" ELSE cancelled
            /\ UNCHANGED <<turn, observed, replacement, command>>
Stop ==
    /\ observed = 1 /\ ~command /\ command' = TRUE
    /\ wait' = IF wait = observed \/ (Fault = "stop" /\ wait = 2) THEN 0 ELSE wait
    /\ turn' = IF Fault = "turn" THEN 0 ELSE turn
    /\ cancelled' = IF wait = 2 /\ Fault = "stop" THEN "new-wait"
                    ELSE IF turn = 7 /\ Fault = "turn" THEN "new-turn"
                    ELSE IF wait = observed THEN "old-wait" ELSE cancelled
    /\ UNCHANGED <<observed, replacement, fired>>
Next == Observe \/ ReplaceWait \/ ReplaceTurn \/ OldTimer \/ Stop \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ wait \in 0..2 /\ turn \in {0, 7} /\ observed \in {0, 1}
          /\ replacement \in BOOLEAN /\ fired \in BOOLEAN /\ command \in BOOLEAN
          /\ cancelled \in {"none", "old-wait", "new-wait", "new-turn"}
ScopedCancellation == cancelled \notin {"new-wait", "new-turn"}
=============================================================================
