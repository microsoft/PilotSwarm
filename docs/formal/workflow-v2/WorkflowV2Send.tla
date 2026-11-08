-------------------------- MODULE WorkflowV2Send --------------------------
(***************************************************************************)
(* A messaging send state whose recipient is a workflow, as packages/sdk/  *)
(* src/workflow/v2 implements it in the source commit this file is pinned  *)
(* to (README "Send model"). Its send orchestration attempts the delivery: *)
(* an attempt begins in the store (beginDelivery), gives the message to    *)
(* the recipient as typed input bound to the send (acceptInput), and       *)
(* records the delivery (recordDelivery), or ends the attempts             *)
(* (failDelivery). An attempt may fail between its steps and is then       *)
(* begun again; the orchestration may end without a record, and the        *)
(* controller then collects the state. The sending run may end (finishRun) *)
(* and its workflow may be deleted; the recipient's run may end and the    *)
(* recipient may be deleted or stop allowing the sender; the recipient may *)
(* refuse the message's content; a trusted caller of the public typed-     *)
(* input service may give the recipient an input under the send's id.     *)
(* Each step is the state-changing store decision of its path: one store   *)
(* transaction that takes the session locks first and decides on what it  *)
(* reads after them. The typed-input service's prechecks (definition,     *)
(* authority, run, contract and payload) are reads before acceptInput's    *)
(* transaction, which locks both sessions and rechecks what can change.   *)
(* For one existing run with a stable pinned definition, the model takes   *)
(* that transaction as the acceptance's atomic commit point; read errors,  *)
(* a missing run and each interleaving of a precheck with other steps are  *)
(* not separate outcomes here. A failed attempt loses only its own         *)
(* progress. Agent-session recipients are not in this model.               *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    MaxAttempts,    \* the attempts the send orchestration counts before it gives up
    Foreign,        \* environment: "none", or what a trusted caller of the public service gives the recipient under the
                    \* send's id: "same" (the message's content) or "other" (another content)
    Refuses,        \* environment: the recipient's definition refuses the message's content (no receive state for the
                    \* contract, or a payload its contract refuses): every acceptance of it is refused, before any input
    Cancels,        \* environment: the sending run may end while the send state is pending (finishRun)
    SourceDeletes,  \* environment: the sending workflow's session may be deleted
    RecipientEnds,  \* environment: the recipient's run may end, and the recipient may be deleted or stop allowing the sender
    Terminates,     \* environment: the send orchestration may end without a record
    Crashes,        \* environment: an attempt may fail between its steps
    Guard,          \* fix 9fcbf377 (S2-GPT-02): a fresh acceptance needs the send undecided; FALSE: fa7c232f
    CollectFinds,   \* fix 9fcbf377 (S2-GPT-01): the controller's collection records the acceptance; FALSE: fa7c232f
    ContentBound,   \* fix 9fcbf377 (S2-GPT-03): only an input with the message's content is its acceptance; FALSE: fa7c232f
    RunEndDecides   \* fix 9fcbf377: the run's end decides a pending message to a workflow; FALSE: fa7c232f

ASSUME MaxAttempts \in Nat /\ MaxAttempts >= 1
ASSUME Foreign \in {"none", "same", "other"}
ASSUME {Refuses, Cancels, SourceDeletes, RecipientEnds, Terminates, Crashes, Guard, CollectFinds, ContentBound, RunEndDecides}
       \subseteq BOOLEAN

(* Why an attempt's acceptance was refused.                                *)
Causes == {"none", "source", "gone", "invalid", "conflict", "decided", "ended"}
(* Why the message failed: a refused attempt's cause, or the step that     *)
(* failed it.                                                              *)
FailCauses == Causes \cup {"begin-gone", "begin-decided", "exhausted", "collect", "end"}

VARIABLES
    run,        \* the sending run: "active" or "ended"
    live,       \* the sending workflow's session is live (not deleted)
    node,       \* the send state: "pending", "sent", "cancelled", "failed"
    outbox,     \* its message: "pending", "delivered", "failed"
    rcpt,       \* the input the message's receipt names: "none", "own", "other"
    input,      \* the recipient's input under the send's id: "none", "own" (the message's content), "other"
    recipient,  \* the recipient: "takes" (its run takes input), "ended" (its run ended), "gone" (deleted, or the sender
                \* no longer allowed)
    child,      \* the send orchestration: "running" or "ended"
    att,        \* the current attempt: "idle", "begun", "accepted", "refused", "done"
    why,        \* why the current attempt's acceptance was refused ("none" otherwise)
    tries,      \* the attempts counted
    byUs,       \* ghost: the send's own delivery stored the recipient's input
    late,       \* ghost: it stored it after the send was decided
    failedHeld, \* ghost: a decision failed the message while the recipient held the message's own input
    guarded,    \* ghost: an acceptance was refused because the send was decided first
    failCause,  \* ghost: why the message failed, set by the step that failed it ("none" otherwise)
    how         \* ghost: what recorded the delivery: "none", "attempt", "begin", "fail", "exhausted", "collect", "end"

vars == <<run, live, node, outbox, rcpt, input, recipient, child, att, why, tries, byUs, late, failedHeld, guarded,
          failCause, how>>

TypeOK ==
    /\ run \in {"active", "ended"}
    /\ live \in BOOLEAN
    /\ node \in {"pending", "sent", "cancelled", "failed"}
    /\ outbox \in {"pending", "delivered", "failed"}
    /\ rcpt \in {"none", "own", "other"}
    /\ input \in {"none", "own", "other"}
    /\ recipient \in {"takes", "ended", "gone"}
    /\ child \in {"running", "ended"}
    /\ att \in {"idle", "begun", "accepted", "refused", "done"}
    /\ why \in Causes
    /\ tries \in 0..MaxAttempts
    /\ byUs \in BOOLEAN
    /\ late \in BOOLEAN
    /\ failedHeld \in BOOLEAN
    /\ guarded \in BOOLEAN
    /\ failCause \in FailCauses
    /\ how \in {"none", "attempt", "begin", "fail", "exhausted", "collect", "end"}

Init ==
    /\ run = "active" /\ live = TRUE /\ node = "pending" /\ outbox = "pending" /\ rcpt = "none" /\ input = "none"
    /\ recipient = "takes" /\ child = "running" /\ att = "idle" /\ why = "none" /\ tries = 0
    /\ byUs = FALSE /\ late = FALSE /\ failedHeld = FALSE /\ guarded = FALSE /\ failCause = "none" /\ how = "none"

(* The send is decided: its state or its message is no longer pending.     *)
Decided == node # "pending" \/ outbox # "pending"

(* What a store transaction finds as the recipient's acceptance of the     *)
(* message (sendAcceptanceIn): an input with the message's content.        *)
(* ContentBound = FALSE: fa7c232f's lookup, any input under the send's id. *)
Found == IF ContentBound THEN input = "own" ELSE input # "none"

(* The delivery recorded (deliverIn): the message delivered, its receipt   *)
(* naming the input found, and a state still pending (in a live workflow)  *)
(* sent.                                                                   *)
Deliver(by) ==
    /\ outbox' = "delivered"
    /\ rcpt' = input
    /\ node' = IF node = "pending" /\ live THEN "sent" ELSE node
    /\ how' = by
    /\ UNCHANGED <<failedHeld, failCause>>

(* No delivery will be recorded: the message fails for this cause, and a   *)
(* state still pending (in a live workflow) gets the failure.              *)
FailMessage(cause) ==
    /\ outbox' = "failed"
    /\ node' = IF node = "pending" /\ live THEN "failed" ELSE node
    /\ failedHeld' = (failedHeld \/ input = "own")
    /\ failCause' = cause
    /\ UNCHANGED <<rcpt, how>>

(* S failDelivery: a message already decided is kept; otherwise the        *)
(* recipient's acceptance found is the delivery, or the message fails.     *)
Conclude(by, cause) ==
    IF outbox # "pending"
    THEN UNCHANGED <<node, outbox, rcpt, how, failedHeld, failCause>>
    ELSE IF Found THEN Deliver(by) ELSE FailMessage(cause)

(* S beginDelivery, under both session locks: a message already decided   *)
(* ends the attempt; the acceptance found is recorded, with no attempt     *)
(* counted; a decided state or a deleted sending workflow fails the        *)
(* message; a recipient deleted or no longer allowed fails the state and   *)
(* the message (recipientDecision); otherwise the attempt is counted.      *)
Begin ==
    /\ child = "running"
    /\ att = "idle"
    /\ tries < MaxAttempts
    /\ IF outbox # "pending"
       THEN (att' = "done" /\ UNCHANGED <<node, outbox, rcpt, how, failedHeld, failCause, tries>>)
       ELSE IF Found
            THEN (Deliver("begin") /\ att' = "done" /\ UNCHANGED tries)
            ELSE IF ~live \/ node # "pending"
                 THEN (/\ outbox' = "failed"
                       /\ failedHeld' = (failedHeld \/ input = "own")
                       /\ failCause' = "begin-decided"
                       /\ att' = "done"
                       /\ UNCHANGED <<node, rcpt, how, tries>>)
                 ELSE IF recipient = "gone"
                      THEN (FailMessage("begin-gone") /\ att' = "done" /\ UNCHANGED tries)
                      ELSE (/\ tries' = tries + 1
                            /\ att' = "begun"
                            /\ UNCHANGED <<node, outbox, rcpt, how, failedHeld, failCause>>)
    /\ UNCHANGED <<run, live, input, recipient, child, why, byUs, late, guarded>>

(* V acceptSendAsWorkflowInputV2 and S acceptInput with the send's id, in  *)
(* the code's order: the recipient's definition deleted or the sender no   *)
(* longer allowed (gone), the sending workflow deleted (source), the       *)
(* content refused by the recipient's contract (invalid), all before the   *)
(* store; then, under the session locks, a repeat of the message's own     *)
(* request answered with its stored acceptance, another input under the    *)
(* id (OPERATION_CONFLICT), the send decided (Guard, SEND_DECIDED), the    *)
(* recipient's run ended (RUN_ENDED); otherwise the recipient stores the   *)
(* message's input.                                                        *)
Accept ==
    /\ att = "begun"
    /\ IF recipient = "gone"
       THEN (att' = "refused" /\ why' = "gone" /\ UNCHANGED <<input, byUs, late, guarded>>)
       ELSE IF ~live
       THEN (att' = "refused" /\ why' = "source" /\ UNCHANGED <<input, byUs, late, guarded>>)
       ELSE IF Refuses
       THEN (att' = "refused" /\ why' = "invalid" /\ UNCHANGED <<input, byUs, late, guarded>>)
       ELSE IF input = "own"
       THEN (att' = "accepted" /\ UNCHANGED <<why, input, byUs, late, guarded>>)
       ELSE IF input = "other"
       THEN (att' = "refused" /\ why' = "conflict" /\ UNCHANGED <<input, byUs, late, guarded>>)
       ELSE IF Guard /\ Decided
       THEN (att' = "refused" /\ why' = "decided" /\ guarded' = TRUE /\ UNCHANGED <<input, byUs, late>>)
       ELSE IF recipient = "ended"
       THEN (att' = "refused" /\ why' = "ended" /\ UNCHANGED <<input, byUs, late, guarded>>)
       ELSE (/\ input' = "own"
             /\ byUs' = TRUE
             /\ late' = (late \/ Decided)
             /\ att' = "accepted"
             /\ UNCHANGED <<why, guarded>>)
    /\ UNCHANGED <<run, live, node, outbox, rcpt, recipient, child, tries, failedHeld, failCause, how>>

(* S recordDelivery: the delivery recorded, unless the message was decided *)
(* first.                                                                  *)
Record ==
    /\ att = "accepted"
    /\ IF outbox = "pending" THEN Deliver("attempt") ELSE UNCHANGED <<node, outbox, rcpt, how, failedHeld, failCause>>
    /\ att' = "done"
    /\ UNCHANGED <<run, live, input, recipient, child, why, tries, byUs, late, guarded>>

(* R the deliver activity's refusal: S failDelivery ends the attempts. The *)
(* message fails for the attempt's own cause, unless an acceptance is      *)
(* found or the message was decided first.                                 *)
Fail ==
    /\ att = "refused"
    /\ Conclude("fail", why)
    /\ att' = "done"
    /\ why' = "none"
    /\ UNCHANGED <<run, live, input, recipient, child, tries, byUs, late, guarded>>

(* The attempt's activity fails between its steps; while the send          *)
(* orchestration runs, the attempt begins again.                           *)
Crash ==
    /\ Crashes
    /\ att \in {"begun", "accepted", "refused"}
    /\ att' = IF child = "running" THEN "idle" ELSE "done"
    /\ why' = "none"
    /\ UNCHANGED <<run, live, node, outbox, rcpt, input, recipient, child, tries, byUs, late, failedHeld, guarded,
                   failCause, how>>

(* R deliveryFailed: every attempt failed, and failDelivery ends them.     *)
Exhausted ==
    /\ child = "running"
    /\ att = "idle"
    /\ tries = MaxAttempts
    /\ Conclude("exhausted", "exhausted")
    /\ att' = "done"
    /\ UNCHANGED <<run, live, input, recipient, child, why, tries, byUs, late, guarded>>

(* The send orchestration completes after its last attempt.                *)
Complete ==
    /\ child = "running"
    /\ att = "done"
    /\ child' = "ended"
    /\ UNCHANGED <<run, live, node, outbox, rcpt, input, recipient, att, why, tries, byUs, late, failedHeld, guarded,
                   failCause, how>>

(* The send orchestration is terminated, or its last record failed: it     *)
(* ends without a record. An attempt in flight may still finish its steps  *)
(* (a running activity is not stopped); none begins again.                 *)
Terminate ==
    /\ Terminates
    /\ child = "running"
    /\ child' = "ended"
    /\ UNCHANGED <<run, live, node, outbox, rcpt, input, recipient, att, why, tries, byUs, late, failedHeld, guarded,
                   failCause, how>>

(* R collect: the controller finds the send orchestration ended and the    *)
(* state pending, and calls failDelivery. CollectFinds = FALSE: fa7c232f,  *)
(* which failed the message without looking for the acceptance.           *)
Collect ==
    /\ child = "ended"
    /\ run = "active"
    /\ live
    /\ node = "pending"
    /\ IF CollectFinds
       THEN Conclude("collect", "collect")
       ELSE IF outbox # "pending"
            THEN UNCHANGED <<node, outbox, rcpt, how, failedHeld, failCause>>
            ELSE FailMessage("collect")
    /\ UNCHANGED <<run, live, input, recipient, child, att, why, tries, byUs, late, guarded>>

(* S finishRun while the send state is pending: a cancel, a recover, or a  *)
(* run that fails or completes on another path. Each ends the run, cancels *)
(* every pending state and (RunEndDecides) decides a pending message to a  *)
(* workflow in the same transaction: the acceptance found is its delivery  *)
(* (the state keeps the end's result); otherwise it fails. They differ     *)
(* only in the run's status and the state's winner, which the model does   *)
(* not keep.                                                               *)
Cancel ==
    /\ Cancels
    /\ run = "active"
    /\ live
    /\ run' = "ended"
    /\ node' = IF node = "pending" THEN "cancelled" ELSE node
    /\ IF RunEndDecides /\ outbox = "pending"
       THEN IF Found
            THEN (outbox' = "delivered" /\ rcpt' = input /\ how' = "end" /\ UNCHANGED <<failedHeld, failCause>>)
            ELSE (/\ outbox' = "failed"
                  /\ failedHeld' = (failedHeld \/ input = "own")
                  /\ failCause' = "end"
                  /\ UNCHANGED <<rcpt, how>>)
       ELSE UNCHANGED <<outbox, rcpt, how, failedHeld, failCause>>
    /\ UNCHANGED <<live, input, recipient, child, att, why, tries, byUs, late, guarded>>

(* The sending workflow's session is soft-deleted. Its trigger cancels the *)
(* active run's pending states; the message stays as it is.                *)
SourceDelete ==
    /\ SourceDeletes
    /\ live
    /\ live' = FALSE
    /\ run' = "ended"
    /\ node' = IF node = "pending" /\ run = "active" THEN "cancelled" ELSE node
    /\ UNCHANGED <<outbox, rcpt, input, recipient, child, att, why, tries, byUs, late, failedHeld, guarded, failCause,
                   how>>

(* The recipient's run ends; or the recipient is deleted, or the authority *)
(* rule stops allowing the sender.                                         *)
RecipientStops ==
    /\ RecipientEnds
    /\ recipient # "gone"
    /\ recipient' \in IF recipient = "takes" THEN {"ended", "gone"} ELSE {"gone"}
    /\ UNCHANGED <<run, live, node, outbox, rcpt, input, child, att, why, tries, byUs, late, failedHeld, guarded,
                   failCause, how>>

(* V sendWorkflowInputV2 by a trusted caller (public, unbound): the        *)
(* recipient, whose run takes input, gets an input from the sending        *)
(* workflow under the send's id, with the message's own content ("same",   *)
(* which a refusing contract refuses too) or another ("other").            *)
Give ==
    /\ Foreign # "none"
    /\ input = "none"
    /\ recipient = "takes"
    /\ live
    /\ ~(Foreign = "same" /\ Refuses)
    /\ input' = IF Foreign = "same" THEN "own" ELSE "other"
    /\ UNCHANGED <<run, live, node, outbox, rcpt, recipient, child, att, why, tries, byUs, late, failedHeld, guarded,
                   failCause, how>>

Next ==
    \/ Begin \/ Accept \/ Record \/ Fail \/ Crash \/ Exhausted \/ Complete \/ Terminate
    \/ Collect \/ Cancel \/ SourceDelete \/ RecipientStops \/ Give

(* Weak fairness of the store's steps, the send orchestration and the      *)
(* controller: each assumes the store eventually completes a step it keeps *)
(* enabled (no permanent store failure). The environment (crashes,         *)
(* termination, run ends, deletions, the recipient, the trusted caller) is *)
(* not fair.                                                               *)
Fairness ==
    /\ WF_vars(Begin) /\ WF_vars(Accept) /\ WF_vars(Record) /\ WF_vars(Fail)
    /\ WF_vars(Exhausted) /\ WF_vars(Complete) /\ WF_vars(Collect)

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)

(* The send's own delivery never stores an input after the send was        *)
(* decided: a cancel or another decision that commits first leaves the     *)
(* recipient nothing (S2-GPT-02). The public, unbound Give is not bound by *)
(* this property.                                                          *)
Inv_NoFreshAfterDecision == ~late

(* No decision fails the message while the recipient holds its own input:  *)
(* the acceptance is recorded instead (S2-GPT-01).                         *)
Inv_AcceptanceNotFailed == ~failedHeld

(* An input the send's delivery stored is never contradicted by a failed   *)
(* message.                                                                *)
Inv_StoredIsDelivered == (byUs /\ outbox # "pending") => outbox = "delivered"

(* A receipt names only an input with the message's content (S2-GPT-03).   *)
Inv_ReceiptOwn == outbox = "delivered" => rcpt = "own"

(* A sent state's message is delivered, with its own input.                *)
Inv_SentDelivered == node = "sent" => (outbox = "delivered" /\ rcpt = "own")

(* The input a receipt names is the one the recipient holds.               *)
Inv_ReceiptHeld == outbox = "delivered" => input = rcpt

SendSafety ==
    /\ TypeOK /\ Inv_NoFreshAfterDecision /\ Inv_AcceptanceNotFailed /\ Inv_StoredIsDelivered
    /\ Inv_ReceiptOwn /\ Inv_SentDelivered /\ Inv_ReceiptHeld

(* The first decision of the state, and of the message with its receipt,   *)
(* is kept.                                                                *)
Prop_FirstDecisionKept ==
    [][/\ node # "pending" => node' = node
       /\ outbox # "pending" => (outbox' = outbox /\ rcpt' = rcpt)]_vars

(* What recorded the delivery is written once, by the step that delivers   *)
(* the message, and never changes after.                                   *)
Prop_RecorderFixed == [][how' # how => (how = "none" /\ outbox = "pending" /\ outbox' = "delivered")]_vars

(* The state is eventually decided.                                        *)
Live_StateDecided == <>(node # "pending")

(* The message is eventually decided.                                      *)
Live_MessageDecided == <>(outbox # "pending")

(***************************************************************************)
(* Witnesses: each is expected to be violated, which shows that its        *)
(* outcome is reachable by the path its comment names.                     *)
(***************************************************************************)

(* The controller's collection records the acceptance after the send       *)
(* orchestration ended without a record.                                   *)
Wit_CollectRecords == how # "collect"
(* The run's end records an acceptance made before the cancel, and the     *)
(* state keeps the cancel.                                                 *)
Wit_EndRecords == ~(how = "end" /\ node = "cancelled")
(* An acceptance is refused because the send was decided first, and the   *)
(* recipient holds nothing.                                                *)
Wit_RefusedAfterDecision == ~(guarded /\ input = "none" /\ outbox = "failed")
(* The send's own acceptance lost its reply (the attempt failed after it)  *)
(* and the next attempt's begin records it.                                *)
Wit_OwnLostReplyRecovered == ~(how = "begin" /\ byUs)
(* An unbound input that a trusted caller gave with the message's content  *)
(* is adopted by a later begin as the delivery (not the send's own         *)
(* acceptance). A delivery that the run's end, the collection or an        *)
(* attempt's record made is not this witness: each writes its own `how`    *)
(* (Prop_RecorderFixed).                                                   *)
Wit_UnboundSameAdopted == ~(how = "begin" /\ outbox = "delivered" /\ rcpt = "own" /\ ~byUs)
(* An attempt meets another input under the send's id                      *)
(* (OPERATION_CONFLICT), and the message fails because of that refusal.    *)
Wit_OtherRefused == failCause # "conflict"
(* The recipient's contract refuses the content, and the message fails     *)
(* because of that refusal.                                                *)
Wit_InvalidRefused == failCause # "invalid"
(* A recipient deleted or no longer allowing the sender is refused inside  *)
(* the begin's transaction, which fails the state and the message.         *)
Wit_RecipientGoneAtBegin == failCause # "begin-gone"

=============================================================================
