------------------------- MODULE MCRequestBStrict -------------------------
(***************************************************************************)
(* Strict witnesses for request variant B (WorkflowRequestSpecB and the  *)
(* modules it extends are unchanged). Two history variables, read by no    *)
(* action; HNext is NextB with the Call and ElapseB steps tagged, so HSpec *)
(* has exactly SpecB's behaviors on SpecB's variables. Added after the     *)
(* diagnostics run b-diagnostics-first-r1, where Wit_OpConflict and       *)
(* Wit_TimedOutWhilePaused were reached by weaker paths (a conflict on an  *)
(* expired binding; a pause after the timeout).                            *)
(*  conflictOnDecided: a call with operation o answered OPERATION_CONFLICT *)
(*    while o was bound "decided" to the winning response, with another    *)
(*    result; the winner's record, the binding and the node are unchanged.*)
(*  elapsedWhilePaused: ElapseB decided timed_out from a state in which    *)
(*    the run was paused, and the result was not collected.               *)
(***************************************************************************)
EXTENDS WorkflowRequestSpecB

VARIABLES conflictOnDecided, elapsedWhilePaused

hvars == <<vars, conflictOnDecided, elapsedWhilePaused>>

HInit == Init /\ conflictOnDecided = FALSE /\ elapsedWhilePaused = FALSE

CallH(a, o, r) ==
    /\ Call(a, o, r)
    /\ conflictOnDecided' =
         \/ conflictOnDecided
         \/ /\ lastCode' = "OPERATION_CONFLICT"
            /\ bind[o].b /\ bind[o].outcome = "decided" /\ r # bind[o].res
            /\ rec.has /\ rec' = rec /\ node' = node
            /\ bind'[o].outcome = "decided" /\ bind'[o].res = bind[o].res
    /\ UNCHANGED elapsedWhilePaused

ElapseH ==
    /\ ElapseB
    /\ elapsedWhilePaused' = (elapsedWhilePaused \/ (paused /\ node' = "timed_out" /\ ~collected'))
    /\ UNCHANGED conflictOnDecided

(* NextB without its Call and ElapseB disjuncts.                          *)
RestB ==
    \/ Tick
    \/ ClockBack
    \/ Commit
    \/ LateWakeInsert
    \/ ObserveB
    \/ Deliver
    \/ DeliveryFail
    \/ RunEnd
    \/ DeleteRequester
    \/ Purge
    \/ DeleteResponder
    \/ LoseAuthority
    \/ RespOrchEnd
    \/ Pause
    \/ Resume
    \/ Collect
    \/ \E w \in Workers : WakeLease(w)
    \/ WakeDue
    \/ \E w \in Workers : WakeEnqueue(w)
    \/ \E w \in Workers : WakeFinishAny(w)
    \/ WakeAbandon

HNext ==
    \/ \E a \in Actors, o \in Ops, r \in Results : CallH(a, o, r)
    \/ ElapseH
    \/ RestB /\ UNCHANGED <<conflictOnDecided, elapsedWhilePaused>>

HSpec == HInit /\ [][HNext]_hvars

(* EXPECTED to be violated (reachable).                                   *)
Wit_ConflictOnDecided == ~conflictOnDecided
Wit_ElapsedWhilePaused == ~elapsedWhilePaused

=============================================================================
