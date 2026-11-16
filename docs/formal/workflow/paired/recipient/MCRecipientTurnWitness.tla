--------------------- MODULE MCRecipientTurnWitness ---------------------
(***************************************************************************)
(* Witness wrapper for RecipientTurnSpec (unchanged). It adds history     *)
(* variables only: each is set from the step just taken and is read by no *)
(* action of the spec, so HSpec has exactly RecipientTurnSpec's behaviors  *)
(* (projected on its variables) and every spec invariant keeps its        *)
(* meaning. The three witnesses below replace the spec's Wit_GateResumed, *)
(* Wit_AbandonedInterrupted and Wit_CompletedAfterInterpose, which did not *)
(* prove that the situation they name happened (parent review of          *)
(* 382f06e0).                                                              *)
(*                                                                         *)
(*  gateParkedTurn: the turn whose attempt parked the invocation for a     *)
(*    gate (0: never).                                                     *)
(*  gateResumeTurn: the gate_retry turn whose attempt carried the          *)
(*    gate-parked invocation (0: never).                                   *)
(*  completedBy: the turn whose attempt completed it (0: not completed).   *)
(*  abandonEnd: the invocation ended interrupted by Abandon (a waiting     *)
(*    retry that never came), not by an attempt.                           *)
(***************************************************************************)
EXTENDS RecipientTurnSpec

VARIABLES gateParkedTurn, gateResumeTurn, completedBy, abandonEnd

hvars == <<vars, gateParkedTurn, gateResumeTurn, completedBy, abandonEnd>>

HInit ==
    /\ Init
    /\ gateParkedTurn = 0 /\ gateResumeTurn = 0 /\ completedBy = 0
    /\ abandonEnd = FALSE

(* Only Attempt changes `parked` to "gate" or `out` to "completed" with a  *)
(* current turn; only Abandon ends the invocation while the current turn   *)
(* waits for its retry or only a held turn exists (Attempt needs a        *)
(* current turn that does not wait).                                       *)
HNext ==
    /\ Next
    /\ gateParkedTurn' = IF inv.parked # "gate" /\ inv'.parked = "gate"
                           THEN cur.id ELSE gateParkedTurn
    /\ gateResumeTurn' = IF /\ Active(cur) /\ cur.stim = "gate_retry"
                            /\ inv.parked = "gate" /\ gateParkedTurn # 0
                            /\ inv' # inv
                           THEN cur.id ELSE gateResumeTurn
    /\ completedBy' = IF inv.out = "none" /\ inv'.out = "completed"
                        THEN cur.id ELSE completedBy
    /\ abandonEnd' = \/ abandonEnd
                     \/ /\ inv.out = "none" /\ inv'.out = "interrupted"
                        /\ \/ Active(cur) /\ cur.waiting
                           \/ ~Active(cur) /\ Active(held)

HSpec == HInit /\ [][HNext]_hvars

-----------------------------------------------------------------------------
(* Witnesses, EXPECTED to be violated (each situation is reachable).      *)

(* A gate parked the invocation; the gate's own retry turn carried it,    *)
(* first sent it, and completed it.                                         *)
Wit2_GateResumedCompleted ==
    ~(/\ gateParkedTurn # 0 /\ gateResumeTurn # 0
      /\ gateResumeTurn # gateParkedTurn
      /\ firstSent = gateResumeTurn
      /\ inv.out = "completed" /\ completedBy = gateResumeTurn)

(* The first-sending turn's retry was abandoned, and that ended the        *)
(* invocation interrupted.                                                  *)
Wit2_AbandonedInterrupted ==
    ~(abandonEnd /\ inv.out = "interrupted" /\ firstSent # 0)

(* Another turn ran while the first-sending turn waited for its retry,    *)
(* and the first-sending turn itself, resumed, completed the invocation.  *)
Wit2_CompletedAfterInterpose ==
    ~(interposed /\ inv.out = "completed" /\ completedBy = firstSent /\ firstSent # 0)

=============================================================================
