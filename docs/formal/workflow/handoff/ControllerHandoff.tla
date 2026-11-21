--------------------------- MODULE ControllerHandoff ---------------------------
(***************************************************************************)
(* FB-064: a running Workflow moves to the latest controller at            *)
(* continue-as-new, as sessions do.                                        *)
(*                                                                          *)
(* Versions: 0 = 1.0.0 (frozen), 1 = 1.1.0, 2 = 1.2.0. Latest is 1 at the   *)
(* FB-064 head (batches ch1 and ch2) and 2 at the Decision head (ch3),     *)
(* where 1.1.0 is frozen and 1.2.0 adds the Decision state. A run is        *)
(* admitted at a version, stored on the run; each execution runs on a      *)
(* handler version. Duroxide records the continue-as-new target only in    *)
(* the work item that starts the next execution, never in replayed         *)
(* history, so a frozen handler may pass the shared latest constant.       *)
(*                                                                          *)
(* The carry and approval gates are read in the activities. GateBy says    *)
(* from which version: the run's admission version (the design) or the     *)
(* current execution's (a mutant). 1.2.0's feature entry equals 1.1.0's    *)
(* (Feature120). The Decision state has no gate in the activities: only    *)
(* the plan parsers guard it (1.0.0 and 1.1.0 refuse a Decision plan).     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Admitted,      \* 0, 1 or 2: the run's stored admission version (at most Latest)
    CarryDecl,     \* the plan declares carry (a 1.0.0 run can only through the unsupported path)
    ApprovalDecl,  \* step 2 of the plan is an approval state
    DecisionDecl,  \* step 3 of the plan is a Decision state (needs N >= 3 and Latest = 2)
    GateBy,        \* "admission" (design) or "execution" (mutant)
    Target,        \* the continue-as-new target: "latest" (FB-064), "pinned" (before), "down" (mutant)
    N,             \* steps in the plan
    MaxCan,        \* continue-as-new points explored
    LenientParse,  \* hypothetical: the frozen plan parsers accepted a state type they do not know (they do not)
    Latest,        \* the latest version: 1 (the FB-064 head) or 2 (the 1.2.0 head)
    Feature120     \* code: 1.2.0 has 1.1.0's features (carry and approval); FALSE is a mutant

ASSUME Latest \in {1, 2} /\ Admitted \in 0..Latest /\ GateBy \in {"admission", "execution"}
ASSUME Target \in {"latest", "pinned", "down"} /\ Feature120 \in BOOLEAN
ASSUME DecisionDecl => (Latest = 2 /\ N >= 3)

VARIABLES exec, maxExec, fresh, status, i, snap, shape, cans, approvalActive, decisionActive, decisionExec
vars == <<exec, maxExec, fresh, status, i, snap, shape, cans, approvalActive, decisionActive, decisionExec>>

Steps == 1..N
\* controller-features.ts: carry and approval exist from 1.1.0; 1.2.0's entry is 1.1.0's.
Feature(v) == IF v = 2 THEN Feature120 ELSE v >= 1
Gate == IF GateBy = "admission" THEN Feature(Admitted) ELSE Feature(exec)
\* The plan parser of a handler (controller_*/runtime.ts parsePlan): 1.0.0 has no approval node type; 1.0.0 and 1.1.0
\* have no Decision node type.
Parses(v) == /\ (~ApprovalDecl \/ v >= 1 \/ LenientParse)
             /\ (~DecisionDecl \/ v >= 2 \/ LenientParse)

Init ==
    /\ exec = Admitted /\ maxExec = Admitted
    /\ fresh = TRUE /\ status = "running" /\ i = 0
    /\ snap = [k \in Steps |-> FALSE]
    /\ shape = [k \in Steps |-> "none"]
    /\ cans = 0 /\ approvalActive = FALSE
    /\ decisionActive = FALSE /\ decisionExec = 0

\* Every execution parses the stored plan before its loop.
Begin ==
    /\ fresh /\ status = "running"
    /\ IF Parses(exec)
       THEN fresh' = FALSE /\ UNCHANGED status
       ELSE status' = "failed" /\ UNCHANGED fresh
    /\ UNCHANGED <<exec, maxExec, i, snap, shape, cans, approvalActive, decisionActive, decisionExec>>

\* Enter the next state: the arrival mapping and the entry snapshot both read the gate. A Decision state is dispatched by
\* the 1.2.0 generator (the Decision effect, or the test interception); an older generator has no Decision dispatch, so
\* it reaches one only under the hypothetical lenient parser, and the state then fails.
Enter ==
    /\ ~fresh /\ status = "running" /\ i < N
    /\ LET k == i + 1
           isApproval == ApprovalDecl /\ k = 2
           isDecision == DecisionDecl /\ k = 3
       IN IF (isApproval /\ ~Gate) \/ (isDecision /\ exec < 2)
          THEN /\ status' = "failed"   \* the activity refuses the approval; an older generator cannot run the Decision
               /\ UNCHANGED <<i, snap, shape, approvalActive, decisionActive, decisionExec>>
          ELSE /\ shape' = [shape EXCEPT ![k] =
                    IF k = 1 THEN "start"
                    ELSE IF Gate /\ CarryDecl THEN (IF snap[k - 1] THEN "carry" ELSE "carryNull") ELSE "raw"]
               /\ snap' = [snap EXCEPT ![k] = Gate /\ CarryDecl]
               /\ approvalActive' = (approvalActive \/ isApproval)
               /\ decisionActive' = (decisionActive \/ isDecision)
               /\ decisionExec' = IF isDecision THEN exec ELSE decisionExec
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
    /\ UNCHANGED <<status, i, snap, shape, approvalActive, decisionActive, decisionExec>>

Finish ==
    /\ ~fresh /\ status = "running" /\ i = N
    /\ status' = "done"
    /\ UNCHANGED <<exec, maxExec, fresh, i, snap, shape, cans, approvalActive, decisionActive, decisionExec>>

Ended == status # "running" /\ UNCHANGED vars

Next == Begin \/ Enter \/ CAN \/ Finish \/ Ended
Spec == Init /\ [][Next]_vars /\ WF_vars(Begin \/ Enter \/ Finish)

TypeOK == exec \in 0..Latest /\ status \in {"running", "done", "failed"} /\ decisionExec \in 0..Latest

\* A run admitted at 1.0.0 keeps raw routing for its whole life (WorkflowCarry's Inv_GateHolds).
Inv_GateHolds == Admitted = 0 => \A k \in Steps : shape[k] \in {"none", "start", "raw"}
\* No successor receives a carry envelope for a predecessor entered without a snapshot.
Inv_NoCarryNull == \A k \in Steps : shape[k] # "carryNull"
\* An approval state is active only in a run admitted where approval exists.
Inv_ApprovalGated == approvalActive => Feature(Admitted)
\* Never move down.
Inv_NeverDown == exec = maxExec /\ exec >= Admitted
\* A run admitted at 1.1.0 or later that declares carry keeps carry routing for its whole life, on any later handler.
Inv_CarryKept == (CarryDecl /\ Admitted >= 1) => \A k \in Steps : shape[k] \in {"none", "start", "carry"}
\* A Decision state is dispatched only by a 1.2.0 execution.
Inv_DecisionOnLatest == decisionActive => decisionExec = 2
\* A Decision state is dispatched only in a run admitted at 1.2.0.
Inv_DecisionAdmitted == decisionActive => Admitted = 2
Prop_Ends == <>(status # "running")

\* Witnesses (each must be violated).
W_NoMove == exec = Admitted
W_NotFailed == status # "failed"
\* A 1.0.0 run with an approval state reaches a later execution.
W_NoApprovalCross == ~(ApprovalDecl /\ Admitted = 0 /\ exec >= 1 /\ ~fresh)
\* A 1.2.0 run dispatches its Decision state.
W_NoDecision == ~decisionActive
\* A run admitted before 1.2.0 with a Decision state reaches a 1.2.0 execution.
W_NoDecisionCross == ~(DecisionDecl /\ Admitted < 2 /\ exec = 2 /\ ~fresh)
==============================================================================
