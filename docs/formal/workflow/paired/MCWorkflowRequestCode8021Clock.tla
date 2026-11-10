------------------- MODULE MCWorkflowRequestCode8021Clock -------------------
(***************************************************************************)
(* The checkpoint 2 code model at 8021c75e, unchanged, with the store's   *)
(* clock allowed to step back (A-CLK removed). It reproduces the          *)
(* checkpoint 1b clock-back counterexample at the code level for the code *)
(* as it was before 57fbb0d6. Inv_C_NoDecisionAfterExpiry is EXPECTED to  *)
(* be violated.                                                           *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Deadline, MaxTime, Ops, Vals, MaxBindings, Caller

VARIABLES clock, sReq, sResp, rel, runSt, finished, nd, resp, ops, wakeRow,
          txn, lastCode, leak

C == INSTANCE WorkflowRequestCode

CClockBack ==
    /\ clock > 0
    /\ clock' = clock - 1
    /\ UNCHANGED <<sReq, sResp, rel, runSt, finished, nd, resp, ops, wakeRow,
                   txn, lastCode, leak>>

BNext == C!CNext \/ CClockBack

BSpec == C!Init /\ [][BNext]_C!cvars

Inv_C_NoDecisionAfterExpiry ==
    resp.has => \A o \in Ops : ops[o].outcome # "expired"

=============================================================================
