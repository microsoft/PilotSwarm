------------------------- MODULE WorkflowRequestSpecB -------------------------
(***************************************************************************)
(* Intent variant B of the request model, per decision D-REQ-1            *)
(* (the design decision of 2026-11-02 on durable expiry semantics) on     *)
(* design 2943167c (blob fdb38954). WorkflowRequestSpec57 (variant A,   *)
(* the literal text) and MCRequestCandidate are unchanged; this module    *)
(* EXTENDS them and replaces exactly two actions in its own NextB:        *)
(*  - ObserveB: a committed "expired" binding of the pending request is a *)
(*    durable expiry observation; the responder observation does not      *)
(*    decide after it, whatever the clock reads (rollback included);      *)
(*  - ElapseB: the elapse decides timed_out when its one reading is at or *)
(*    after the deadline OR such a binding exists. It records its ACTUAL  *)
(*    reading as decidedAt (no clock value is manufactured), so a        *)
(*    timed_out may carry a reading below the deadline after a rollback.  *)
(* Unchanged: every other producer (delivery failure, run end, deletion   *)
(* still compete by the first pending compare-and-swap: F4), responses,   *)
(* replay and authorization, the wake. The unobserved deadline passage    *)
(* taken back by the clock (R57-1) stays a stated limit.                  *)
(***************************************************************************)
EXTENDS MCRequestCandidate

ObserveB == Observe /\ ~ExpiredSeen

ElapseB ==
    /\ ~LockBlocks
    /\ node = "pending"
    /\ (clock >= Deadline \/ ExpiredSeen)
    /\ node' = "timed_out"
    /\ winner' = "controller"
    /\ decidedAt' = clock
    /\ UNCHANGED <<clock, rec, callVars, envVars, collected, wakeVars>>

NextB ==
    \/ Tick
    \/ ClockBack
    \/ \E a \in Actors, o \in Ops, r \in Results : Call(a, o, r)
    \/ Commit
    \/ LateWakeInsert
    \/ ElapseB
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

SpecB == Init /\ [][NextB]_vars

FairnessB ==
    /\ WF_vars(Tick)
    /\ WF_vars(Commit)
    /\ WF_vars(ElapseB)
    /\ WF_vars(Resume)
    /\ SF_vars(Collect)
    /\ WF_vars(\E w \in Workers : WakeLease(w))
    /\ WF_vars(WakeDue)
    /\ \A w \in Workers : WF_vars(WakeEnqueue(w))
    /\ \A w \in Workers : WF_vars(WakeFinishAny(w))
    /\ WF_vars(WakeAbandon)

LiveSpecB == SpecB /\ FairnessB

-----------------------------------------------------------------------------
(* Safety of B.                                                            *)

(* D-REQ-1: no responder observation decides after the durable expiry     *)
(* point (the negation of variant A's witness).                           *)
Inv_NoObserveAfterExpiry == Wit_ObservedAfterExpiry

(* Inv_Deadline with honest timestamps: a response still needs a reading  *)
(* before the deadline; a timed_out is justified by a reading at or after *)
(* it, or by the durable expiry point, and keeps its actual reading.      *)
(* Spec57's Inv_Deadline (raw wall clock) is expected to fail under B with *)
(* rollback, which shows that no reading is manufactured.                 *)
Inv_DeadlineB ==
    /\ (node \in {"responded", "declined"}) => (decidedAt < Deadline)
    /\ rec.has => (rec.at = decidedAt)
    /\ (node = "timed_out") => (decidedAt >= Deadline \/ ExpiredSeen)
    /\ (winner = "controller" /\ node \in {"unavailable", "forbidden"})
          => (decidedAt < Deadline /\ ~ExpiredSeen)

(* Positive witness, EXPECTED to be violated with rollback: timed_out     *)
(* decided by the durable expiry point at a reading below the deadline.   *)
Wit_TimedOutAfterRollback ==
    ~(node = "timed_out" /\ decidedAt < Deadline /\ ExpiredSeen)

=============================================================================
