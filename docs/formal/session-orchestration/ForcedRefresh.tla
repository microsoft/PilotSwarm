----------------------------- MODULE ForcedRefresh -----------------------------
(***************************************************************************)
(* A turn that completes with forceContinuePrompt (use_package, load or    *)
(* unload of an agent, a failed model switch, and enable_workflows) makes  *)
(* 1.0.83 continue as new at once (orchestration/turn.ts 1360-1365 at      *)
(* c9b23671) with the prompt as a bootstrap prompt, through the same       *)
(* versionedContinueAsNew (lifecycle.ts 724-783) and buildContinueInput as *)
(* every other continue-as-new: the pending prompt is merged with it       *)
(* (buildContinueInputWithPrompt 693-706); the FIFO stays in KV; the child *)
(* digest, the rehydration notice and the cron schedule are input fields;  *)
(* an armed timer rides as activeTimerState; the owed retry, the retry     *)
(* marker, the arrival flag and the intake state (queue, invocation, held  *)
(* cancels: every store write it owes with its absolute due time,          *)
(* intake-machine.ts 596-606) ride the intake fields. The intake turn      *)
(* records its attempt before (turn.ts 1320), so a write can be due at the *)
(* forced continue-as-new; the idle continue-as-new waits for due writes   *)
(* (runtime.ts 303), this one does not.                                    *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Fault, MaxForced   \* Fault: "none" or the item the forced continue-as-new drops

Items == {"fifo", "pend", "digest", "notice", "timer", "retry", "arrival", "intakeWrite"}
ASSUME Fault \in Items \cup {"none"} /\ MaxForced \in 1..2

VARIABLES where, forced, gh
vars == <<where, forced, gh>>

Init == where = [x \in Items |-> "held"] /\ forced = 0 /\ gh = {}

(* A turn completes with forceContinuePrompt: continue as new into 1.0.83. *)
Forced ==
    /\ forced < MaxForced
    /\ forced' = forced + 1
    /\ where' = [x \in Items |-> IF where[x] = "held" /\ x = Fault THEN "lost" ELSE where[x]]
    /\ gh' = gh \cup (IF where["intakeWrite"] = "held" THEN {"forcedWhileDue"} ELSE {})

(* The next execution handles each held item (drain makes the due write,   *)
(* a turn takes the prompt, digest and notice, the timer fires, the owed   *)
(* retry runs first, the arrival turn starts).                             *)
Handle == \E x \in Items : where[x] = "held" /\ where' = [where EXCEPT ![x] = "done"] /\ UNCHANGED <<forced, gh>>

Done == (\A x \in Items : where[x] # "held") /\ UNCHANGED vars
Next == Forced \/ Handle \/ Done
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Handle)

TypeOK == where \in [Items -> {"held", "done", "lost"}] /\ forced \in 0..MaxForced
Inv_NothingLost == \A x \in Items : where[x] # "lost"
Prop_AllHandled == <>(\A x \in Items : where[x] # "held")
W_NoForcedWhileDue == "forcedWhileDue" \notin gh
=============================================================================
