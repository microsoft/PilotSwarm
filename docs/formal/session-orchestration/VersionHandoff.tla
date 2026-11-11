----------------------------- MODULE VersionHandoff -----------------------------
(***************************************************************************)
(* A live 1.0.82 session continues as new into 1.0.83 once 1.0.83 is the  *)
(* latest version. What a 1.0.82 execution holds, and where it goes:       *)
(*  - fifo:     a prompt queued in the KV FIFO (keys fifo.N; same keys and *)
(*              item shape in both versions; KV is per instance, kept      *)
(*              across continue-as-new). A 1.0.82 item has no give-back    *)
(*              markers. It may have taken the child digest into its text. *)
(*  - pend:     the continue-as-new input's prompt: plain, a returned      *)
(*              error's retry, a thrown turn's retry (with the thrown key; *)
(*              its model call already ran and its turn may be saved), or  *)
(*              a lossy hand-off (count 0, with the rehydration notice).   *)
(*              1.0.83 converts a thrown retry to ownedRetry, with the key,*)
(*              iff the input's sourceOrchestrationVersion is below 1.0.83 *)
(*              or absent (1_0_83/state.ts 375-404).                       *)
(*  - unread:   queue messages not yet dequeued (prompts, a set_model      *)
(*              command); duroxide carries at most Cap of them             *)
(*              (MAX_CARRY_FORWARD_EVENTS = 100) to the next execution.    *)
(*  - digest, notice, cron: input fields (pendingChildDigest,              *)
(*              rehydrationMessage, cronSchedule + activeTimerState), read *)
(*              unchanged by 1.0.83.                                       *)
(* A deploy registers 1.0.83 as latest. An execution in flight replays     *)
(* with its recorded version (duroxide resolve_handler_exact), so 1.0.82   *)
(* must stay registered with the frozen 1.0.82 code.                       *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    PendKind,          \* "none", "plain", "retErr", "thrown", "lossy"
    SourceStamp,       \* what the 1.0.82 handler writes as sourceOrchestrationVersion: "82", "absent" (1.0.47-1.0.81), "83" (fault: the 1.0.82 handler claims 1.0.83)
    RegistryOK,        \* 1.0.82 stays registered with the frozen code (FALSE: fault: the registry entry follows the latest version)
    NU,                \* unread prompts at the continue-as-new
    SetModel,          \* a set_model command is unread at the continue-as-new
    Cap,               \* unread messages duroxide carries
    FifoTookDigest,    \* the queued prompt took the child digest into its text (1.0.82: no marker)
    AllowLateCancel,   \* the queued prompt may be cancelled at its dispatch on 1.0.83
    AllowSweepSetModel,\* 1.0.82's sweep set_model gap may cause the continue-as-new (known 1.0.82 issue)
    FieldFault         \* "none", "fifo", "digest", "notice", "cron"

ASSUME PendKind \in {"none", "plain", "retErr", "thrown", "lossy"} /\ SourceStamp \in {"82", "absent", "83"}
ASSUME RegistryOK \in BOOLEAN /\ NU \in 0..2 /\ SetModel \in BOOLEAN /\ Cap \in 1..3
ASSUME FifoTookDigest \in BOOLEAN /\ AllowLateCancel \in BOOLEAN /\ AllowSweepSetModel \in BOOLEAN
ASSUME FieldFault \in {"none", "fifo", "digest", "notice", "cron"}

(* Unread messages in queue order: prompts u1, u2, then the set_model "m". *)
UnreadItems == (IF NU >= 1 THEN {"u1"} ELSE {}) \cup (IF NU >= 2 THEN {"u2"} ELSE {}) \cup (IF SetModel THEN {"m"} ELSE {})
Pos(x) == CASE x = "u1" -> 1 [] x = "u2" -> 2 [] OTHER -> NU + 1
Items == {"fifo", "digest", "cron"} \cup (IF PendKind = "none" THEN {} ELSE {"pend"})
         \cup (IF PendKind = "lossy" THEN {"notice"} ELSE {}) \cup UnreadItems

VARIABLES
    deployed,   \* 1.0.83 is registered as latest
    exec,       \* the running execution's version: "82", "83"
    replayed,   \* the in-flight 1.0.82 execution has replayed after the deploy
    failed,     \* the session's execution failed (an unregistered version: poison)
    where,      \* item -> "82", "83", "infifo" (in the queued prompt's text), "done", "cancelled", "lost"
    keyKept,    \* the thrown retry kept its key in 1.0.83
    calls,      \* model calls for the pending prompt's turn
    gh
vars == <<deployed, exec, replayed, failed, where, keyKept, calls, gh>>

Init ==
    /\ deployed = FALSE /\ exec = "82" /\ replayed = FALSE /\ failed = FALSE
    /\ where = [x \in Items |-> IF x = "digest" /\ FifoTookDigest THEN "infifo" ELSE "82"]
    /\ keyKept = FALSE
    /\ calls = IF PendKind = "thrown" THEN 1 ELSE 0
    /\ gh = {}

Deploy == ~deployed /\ deployed' = TRUE /\ UNCHANGED <<exec, replayed, failed, where, keyKept, calls, gh>>

(* The in-flight 1.0.82 execution's next turn replays it on a new worker.  *)
Replay82 ==
    /\ deployed /\ exec = "82" /\ ~replayed /\ ~failed
    /\ replayed' = TRUE /\ failed' = ~RegistryOK
    /\ UNCHANGED <<deployed, exec, where, keyKept, calls, gh>>

Live == ~failed

(* 1.0.82 runs its queued prompt before the continue-as-new.               *)
Run82Fifo ==
    /\ Live /\ exec = "82" /\ where["fifo"] = "82" /\ (deployed => replayed)
    /\ where' = [x \in Items |-> IF x = "fifo" \/ (x = "digest" /\ where[x] = "infifo") THEN "done" ELSE where[x]]
    /\ UNCHANGED <<deployed, exec, replayed, failed, keyKept, calls, gh>>

Moved(x, w) ==
    IF w \notin {"82", "infifo"} THEN w
    ELSE IF x = FieldFault THEN "lost"
    ELSE IF x = "digest" /\ w = "infifo" THEN (IF FieldFault = "fifo" THEN "lost" ELSE "infifo")
    ELSE IF x \in {"fifo", "pend", "digest", "notice", "cron"} THEN "83"
    ELSE IF Pos(x) <= Cap THEN "83" ELSE "lost"

(* The continue-as-new into the latest version, 1.0.83 after the deploy.   *)
(* sweepGap: 1.0.82's decide popped the queued prompt, then its sweep      *)
(* handled set_model, which continued as new without it.                   *)
Can82 ==
    /\ Live /\ exec = "82" /\ deployed /\ replayed
    /\ \E sweepGap \in (IF AllowSweepSetModel /\ SetModel /\ where["fifo"] = "82" THEN BOOLEAN ELSE {FALSE}) :
         /\ where' = [x \in Items |->
               IF sweepGap /\ (x = "fifo" \/ (x = "digest" /\ where[x] = "infifo")) THEN "lost"
               ELSE IF sweepGap /\ x = "m" THEN "done"
               ELSE Moved(x, where[x])]
         /\ gh' = gh \cup (IF sweepGap THEN {"sweepGap"} ELSE {})
    /\ exec' = "83"
    /\ keyKept' = (PendKind = "thrown" /\ SourceStamp # "83")
    /\ UNCHANGED <<deployed, replayed, failed, calls>>

(* 1.0.83 runs the converted owned retry first (priority 2a), adopting the *)
(* thrown attempt's saved turn when it kept the key; otherwise the pending *)
(* prompt runs as a new turn. The model takes the case where the thrown    *)
(* attempt saved its turn (otherwise a second call is legitimate).         *)
RunPend ==
    /\ Live /\ exec = "83" /\ "pend" \in Items /\ where["pend"] = "83"
    /\ where' = [where EXCEPT !["pend"] = "done"]
    /\ calls' = IF PendKind = "thrown" /\ keyKept THEN calls ELSE calls + 1
    /\ gh' = gh \cup (IF keyKept THEN {"adopted"} ELSE {})
    /\ UNCHANGED <<deployed, exec, replayed, failed, keyKept>>

(* Any other held item is taken by a 1.0.83 turn: the queued prompt (with  *)
(* the digest in its text), an unread prompt, the set_model command, the   *)
(* digest and notice (with the next turn), the cron schedule (it fires).   *)
RunOther ==
    /\ Live /\ exec = "83"
    /\ \E x \in Items \ {"pend"} :
         /\ where[x] = "83"
         /\ where' = [y \in Items |->
               IF y = x \/ (x = "fifo" /\ y = "digest" /\ where[y] = "infifo") THEN "done" ELSE where[y]]
         /\ gh' = gh \cup (IF x = "m" THEN {"setModel"} ELSE {})
                     \cup (IF x = "cron" THEN {"cronFired"} ELSE {})
    /\ UNCHANGED <<deployed, exec, replayed, failed, keyKept, calls>>

(* decide drops the 1.0.82-queued prompt for a cancel: it has no markers,  *)
(* so nothing is given back (as on 1.0.82).                                *)
LateCancel ==
    /\ Live /\ exec = "83" /\ AllowLateCancel /\ where["fifo"] = "83"
    /\ where' = [y \in Items |->
          IF y = "fifo" THEN "cancelled" ELSE IF y = "digest" /\ where[y] = "infifo" THEN "lost" ELSE where[y]]
    /\ UNCHANGED <<deployed, exec, replayed, failed, keyKept, calls, gh>>

Settled == \A x \in Items : where[x] \in {"done", "cancelled", "lost"}
Done == (failed \/ (exec = "83" /\ Settled)) /\ UNCHANGED vars

Next == Deploy \/ Replay82 \/ Run82Fifo \/ Can82 \/ RunPend \/ RunOther \/ LateCancel \/ Done
Spec == Init /\ [][Next]_vars
Fairness == WF_vars(Deploy) /\ WF_vars(Replay82) /\ WF_vars(Can82) /\ WF_vars(RunPend) /\ WF_vars(RunOther)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK == /\ {deployed, replayed, failed, keyKept} \subseteq BOOLEAN /\ exec \in {"82", "83"}
          /\ where \in [Items -> {"82", "83", "infifo", "done", "cancelled", "lost"}] /\ calls \in 0..2
(* Nothing the 1.0.82 execution held is lost.                              *)
Inv_NothingLost == \A x \in Items : where[x] # "lost"
(* The pending turn calls the model at most once (a thrown attempt's call  *)
(* counts; its saved turn is adopted).                                     *)
Inv_ModelOnce == calls <= 1
(* An in-flight 1.0.82 execution replays after the deploy.                 *)
Inv_NoFailure == ~failed
Prop_AllProcessed == <>(failed \/ (exec = "83" /\ \A x \in Items : where[x] \in {"done", "cancelled"}))

W_NoAdoption == "adopted" \notin gh
W_NoSetModel == "setModel" \notin gh
W_NoCronFired == "cronFired" \notin gh
=============================================================================
