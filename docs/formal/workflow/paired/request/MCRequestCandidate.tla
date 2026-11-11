------------------------- MODULE MCRequestCandidate -------------------------
(***************************************************************************)
(* Entry module for the request spec candidate at design commit 2943167c  *)
(* (docs/proposals/workflow-messaging-request.md, blob fdb38954).          *)
(*                                                                         *)
(* WorkflowRequestSpec57 (this folder) is a byte-identical copy of the   *)
(* frozen paired/WorkflowRequestSpec57.tla (SHA-256 6bdf65bc...): the    *)
(* intent model of design blob d57b406b. The design text at 2943167c       *)
(* differs from d57b406b by one sentence only (4.3: the store's            *)
(* transactions state READ COMMITTED), which the model already assumes:    *)
(* calls are serialized by the lock and Commit reads the bindings the      *)
(* previous holder committed. See SPEC-CANDIDATE-2943167C.md.              *)
(*                                                                         *)
(* This module adds no action and changes no definition. It only names    *)
(* one more witness, for decision D-REQ-1.                                 *)
(***************************************************************************)
EXTENDS WorkflowRequestSpec57

(* D-REQ-1, EXPECTED to be violated (reachable) with ClockMode =          *)
(* "rollback": after the request's durable expiry point (an operation     *)
(* bound "expired"), the clock steps back below the deadline and the      *)
(* controller's observation decides "unavailable" or "forbidden" instead  *)
(* of the elapse deciding "timed_out". The design text (4.3, 4.4) does    *)
(* not say whether the expiry point also binds the observation.           *)
Wit_ObservedAfterExpiry ==
    ~(ExpiredSeen /\ winner = "controller" /\ node \in {"unavailable", "forbidden"})

=============================================================================
