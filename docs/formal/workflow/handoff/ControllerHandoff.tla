--------------------------- MODULE ControllerHandoff ---------------------------
(***************************************************************************)
(* FB-064: a running Workflow moves to the latest controller at            *)
(* continue-as-new, as sessions do.                                        *)
(*                                                                          *)
(* Versions: 0 = 1.0.0 (frozen), 1 = 1.1.0 (latest). A run is admitted at a *)
(* version, stored on the run; each execution runs on a handler version.   *)
(* Duroxide records the continue-as-new target only in the work item that  *)
(* starts the next execution, never in replayed history, so the frozen     *)
(* handler may pass the shared latest constant.                            *)
(*                                                                          *)
(* The carry and approval gates are read in the activities. GateBy says    *)
(* from which version: the run's admission version (the design) or the     *)
(* current execution's (a mutant).                                         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Admitted,      \* 0 or 1: the run's stored admission version
    CarryDecl,     \* the plan declares carry (a 1.0.0 run can only through the unsupported path)
    ApprovalDecl,  \* step 2 of the plan is an approval state
    GateBy,        \* "admission" (design) or "execution" (mutant)
    Target,        \* the continue-as-new target: "latest" (FB-064), "pinned" (before), "down" (mutant)
    N,             \* steps in the plan
    MaxCan,        \* continue-as-new points explored
    LenientParse   \* hypothetical: the 1.0.0 plan parser accepted an approval state (it does not)

Latest == 1
ASSUME Admitted \in {0, 1} /\ GateBy \in {"admission", "execution"} /\ Target \in {"latest", "pinned", "down"}

VARIABLES exec, maxExec, fresh, status, i, snap, shape, cans, approvalActive
vars == <<exec, maxExec, fresh, status, i, snap, shape, cans, approvalActive>>

Steps == 1..N
Feature(v) == v >= 1                      \* carry and approval exist from 1.1.0
Gate == IF GateBy = "admission" THEN Feature(Admitted) ELSE Feature(exec)
\* The plan parser of a handler: 1.0.0 has no approval node type.
Parses(v) == ~ApprovalDecl \/ Feature(v) \/ LenientParse

Init ==
    /\ exec = Admitted /\ maxExec = Admitted
    /\ fresh = TRUE /\ status = "running" /\ i = 0
    /\ snap = [k \in Steps |-> FALSE]
    /\ shape = [k \in Steps |-> "none"]
    /\ cans = 0 /\ approvalActive = FALSE

\* Every execution parses the stored plan before its loop.
Begin ==
    /\ fresh /\ status = "running"
    /\ IF Parses(exec)
       THEN fresh' = FALSE /\ UNCHANGED status
       ELSE status' = "failed" /\ UNCHANGED fresh
    /\ UNCHANGED <<exec, maxExec, i, snap, shape, cans, approvalActive>>

\* Enter the next state: the arrival mapping and the entry snapshot both read the gate.
Enter ==
    /\ ~fresh /\ status = "running" /\ i < N
    /\ LET k == i + 1
           isApproval == ApprovalDecl /\ k = 2
       IN IF isApproval /\ ~Gate
          THEN status' = "failed" /\ UNCHANGED <<i, snap, shape, approvalActive>>   \* the activity refuses
          ELSE /\ shape' = [shape EXCEPT ![k] =
                    IF k = 1 THEN "start"
                    ELSE IF Gate /\ CarryDecl THEN (IF snap[k - 1] THEN "carry" ELSE "carryNull") ELSE "raw"]
               /\ snap' = [snap EXCEPT ![k] = Gate /\ CarryDecl]
               /\ approvalActive' = (approvalActive \/ isApproval)
               /\ i' = k
               /\ UNCHANGED status
    /\ UNCHANGED <<exec, maxExec, fresh, cans>>

\* Continue-as-new between states (the idle-wait or admission limit).
CAN ==
    /\ ~fresh /\ status = "running" /\ i < N /\ cans < MaxCan
    /\ LET t == CASE Target = "latest" -> Latest [] Target = "pinned" -> exec [] OTHER -> 0
       IN /\ exec' = t
          /\ maxExec' = IF t > maxExec THEN t ELSE maxExec
    /\ fresh' = TRUE /\ cans' = cans + 1
    /\ UNCHANGED <<status, i, snap, shape, approvalActive>>

Finish ==
    /\ ~fresh /\ status = "running" /\ i = N
    /\ status' = "done"
    /\ UNCHANGED <<exec, maxExec, fresh, i, snap, shape, cans, approvalActive>>

Ended == status # "running" /\ UNCHANGED vars

Next == Begin \/ Enter \/ CAN \/ Finish \/ Ended
Spec == Init /\ [][Next]_vars /\ WF_vars(Begin \/ Enter \/ Finish)

TypeOK == exec \in {0, 1} /\ status \in {"running", "done", "failed"}

\* A run admitted at 1.0.0 keeps raw routing for its whole life (WorkflowCarry's Inv_GateHolds).
Inv_GateHolds == Admitted = 0 => \A k \in Steps : shape[k] \in {"none", "start", "raw"}
\* No successor receives a carry envelope for a predecessor entered without a snapshot.
Inv_NoCarryNull == \A k \in Steps : shape[k] # "carryNull"
\* An approval state is active only in a run admitted where approval exists.
Inv_ApprovalGated == approvalActive => Feature(Admitted)
\* Never move down.
Inv_NeverDown == exec = maxExec /\ exec >= Admitted
Prop_Ends == <>(status # "running")

\* Witnesses (each must be violated).
W_NoMove == exec = Admitted
W_NotFailed == status # "failed"
\* A 1.0.0 run with an approval state reaches a 1.1.0 execution.
W_NoApprovalCross == ~(ApprovalDecl /\ Admitted = 0 /\ exec = 1 /\ ~fresh)
==============================================================================
