--------------------- MODULE MCRecipientTurnGWitness ---------------------
(***************************************************************************)
(* Witness wrapper for RecipientTurnSpecG (unchanged). History variables  *)
(* only, read by no action of the spec:                                    *)
(*  waitEnder: the turn whose start ended the gate's wait (0: the wait is *)
(*    armed, never ended, or ended by another event, GateWaitEnds).       *)
(*  doneByEnder: an attempt completed an invocation that was parked for a *)
(*    gate just before it, the gate's wait was gone at that attempt, the  *)
(*    attempt's turn is the turn that ended the wait, and that turn was   *)
(*    not started by the wait's own fire (gate_retry).                     *)
(* Amended after review of d229a253: the earlier ghost did not prove that  *)
(* the wait had ended (a completion could happen with the wait armed).    *)
(***************************************************************************)
EXTENDS RecipientTurnSpecG

VARIABLES waitEnder, doneByEnder

hvars == <<vars, waitEnder, doneByEnder>>

HInit == Init /\ waitEnder = 0 /\ doneByEnder = FALSE

HNext ==
    /\ NextG
    /\ waitEnder' =
         IF gateWait /\ ~gateWait' /\ nTurns' = nTurns + 1 THEN nTurns'  \* a turn start ended it
         ELSE IF gateWait /\ ~gateWait' THEN 0                            \* GateWaitEnds
         ELSE IF ~gateWait /\ gateWait' THEN 0                            \* a refusal armed a new wait
         ELSE waitEnder
    /\ doneByEnder' =
         \/ doneByEnder
         \/ /\ inv.parked = "gate" /\ inv.out = "none" /\ inv'.out = "completed"
            /\ ~gateWait /\ cur.stim # "gate_retry" /\ waitEnder = cur.id

HSpec == HInit /\ [][HNext]_hvars

(* EXPECTED violated under "revalidated" (reachable): the turn that ended *)
(* the gate's wait, not its timer, carries and completes the gate-parked  *)
(* invocation.                                                             *)
Wit_GateParkCompletedByWaitEnder == ~doneByEnder

=============================================================================
