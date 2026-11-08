------------------ MODULE MCWorkflowV2RequestSpecView ------------------
(***************************************************************************)
(* Model-checking wrapper only. It adds a TLC VIEW to the frozen intent   *)
(* model and changes no definition of WorkflowV2RequestSpec.              *)
(*                                                                         *)
(* SafetyView drops the variables that no action guard reads and that no  *)
(* safety property in the view partition reads: lastCode (written by      *)
(* Call and Commit, read by nothing), each binding's count (read only by  *)
(* its own saturating update), enqueued (read only by its own update),    *)
(* collected and paused (read only by Pause, Resume and Collect, which    *)
(* change only these two), and the difference between delivered and      *)
(* failed (Deliver and DeliveryFail read only delivery = "pending").      *)
(* Two states with the same view enable the same steps and reach states   *)
(* with the same view, and every property in rs-pv-decision.cfg depends   *)
(* only on viewed parts. The view is meant for safety only, never for     *)
(* liveness.                                                              *)
(***************************************************************************)
EXTENDS WorkflowV2RequestSpec

SafetyView ==
    << clock, node, winner, decidedAt, rec,
       [o \in Ops |-> [bind[o] EXCEPT !.count = 0]],
       lock, leak, reqState, respLive, related, respOrchEnded,
       delivery = "pending", runEnded, wake, held, nextTok, abandonEvents >>

=============================================================================
