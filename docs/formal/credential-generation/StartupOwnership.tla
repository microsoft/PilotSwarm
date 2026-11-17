--------------------------- MODULE StartupOwnership ---------------------------
EXTENDS Integers, FiniteSets

CONSTANTS Scenario, FaultResetUnbind, FaultColdHolder
ASSUME Scenario \in {"epoch", "cold-workflow", "warm-workflow"}
ASSUME FaultResetUnbind \in BOOLEAN /\ FaultColdHolder \in BOOLEAN

G == 0..1
None == -1
VARIABLES generation, live, key, target, phase, warm, resetDone
vars == <<generation, live, key, target, phase, warm, resetDone>>
WorkflowHolder == Scenario # "epoch"

Init ==
    /\ generation = IF Scenario = "epoch" THEN 0 ELSE 1
    /\ live = G /\ key = 0 /\ target = None /\ phase = "opening"
    /\ warm = (Scenario # "cold-workflow")
    /\ resetDone = (Scenario # "epoch")

(* A cold workflow's newly opening holder does not own the previous warm handle. *)
Acquire ==
    /\ phase = "opening"
    /\ IF key # generation /\ WorkflowHolder /\ (warm \/ FaultColdHolder)
       THEN /\ phase' = "rejected" /\ UNCHANGED <<key, target, warm>>
       ELSE /\ phase' = "starting" /\ key' = generation /\ target' = generation
            /\ warm' = FALSE
    /\ UNCHANGED <<generation, live, resetDone>>

(* The SDK registration/disk reset is not the end of the enclosing operation's lease. *)
Reset ==
    /\ phase = "starting" /\ ~resetDone
    /\ resetDone' = TRUE
    /\ key' = IF FaultResetUnbind THEN None ELSE key
    /\ UNCHANGED <<generation, live, target, phase, warm>>

Begin ==
    /\ phase = "starting" /\ resetDone
    /\ phase' = "running" /\ warm' = TRUE
    /\ UNCHANGED <<generation, live, key, target, resetDone>>

Rotate ==
    /\ generation = 0 /\ generation' = 1
    /\ UNCHANGED <<live, key, target, phase, warm, resetDone>>

(* The implementation discovers session locks through the key-to-session binding. *)
StopOld ==
    /\ generation = 1 /\ 0 \in live /\ key # 0
    /\ live' = live \ {0}
    /\ UNCHANGED <<generation, key, target, phase, warm, resetDone>>

Idle == UNCHANGED vars
Next == Acquire \/ Reset \/ Begin \/ Rotate \/ StopOld \/ Idle
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Acquire) /\ WF_vars(Reset) /\ WF_vars(Begin)

TypeOK ==
    /\ generation \in G /\ live \subseteq G /\ key \in G \cup {None}
    /\ target \in G \cup {None} /\ phase \in {"opening", "starting", "running", "rejected"}
    /\ warm \in BOOLEAN /\ resetDone \in BOOLEAN
Inv_StartupReserved == phase \in {"starting", "running"} => key = target
Inv_ActiveUsesLive == phase \in {"starting", "running"} => target \in live
Inv_WarmOwnerRefused == Scenario = "warm-workflow" => phase \notin {"starting", "running"}
Prop_ExpectedOutcome ==
    TRUE ~> (phase = IF Scenario = "warm-workflow" THEN "rejected" ELSE "running")
=============================================================================
