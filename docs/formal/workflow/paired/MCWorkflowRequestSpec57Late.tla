-------------------- MODULE MCWorkflowRequestSpec57Late --------------------
(***************************************************************************)
(* Witness wrapper only. It adds two history variables to                 *)
(* WorkflowRequestSpec57 and changes none of its definitions:           *)
(*   wasLate:  the clock has been at or after the deadline in some state;  *)
(*   readLate: the open response transaction took its reading after       *)
(*             wasLate became TRUE.                                        *)
(* Prop_NoDecisionFromLateReading is EXPECTED to be violated with          *)
(* ClockMode = "rollback": durable expiry stops a decision only after an   *)
(* operation observed the expiry (a binding), not after an unobserved      *)
(* passage of the deadline that the clock then took back. With            *)
(* "monotone" it is expected to hold: a reading taken after wasLate is at  *)
(* or after the deadline.                                                  *)
(***************************************************************************)
EXTENDS WorkflowRequestSpec57

VARIABLES wasLate, readLate

lvars == <<vars, wasLate, readLate>>

LInit ==
    /\ Init
    /\ wasLate = (clock >= Deadline)
    /\ readLate = FALSE

LNext ==
    /\ Next
    /\ wasLate' = (wasLate \/ clock' >= Deadline)
    /\ readLate' = IF ~lock.held /\ lock'.held THEN wasLate ELSE readLate

LSpec == LInit /\ [][LNext]_lvars

Prop_NoDecisionFromLateReading ==
    [][(~rec.has /\ rec'.has) => ~readLate]_lvars

=============================================================================
