-------------------------- MODULE WorkflowV2Send --------------------------
(***************************************************************************)
(* A messaging send state whose recipient is a workflow, as packages/sdk/  *)
(* src/workflow/v2 implements it in the commit of this file (README "Send  *)
(* model"). Its send orchestration attempts the delivery: an attempt       *)
(* begins in the store (beginDelivery), gives the message to the recipient *)
(* as typed input bound to the send (acceptInput), and records the         *)
(* delivery (recordDelivery), or ends the attempts (failDelivery). An      *)
(* attempt may fail between its steps and is then begun again; the        *)
(* orchestration may end without a record, and the controller then        *)
(* collects the state. The sending run may be cancelled (finishRun) and    *)
(* its workflow deleted; the recipient may stop taking input; a trusted    *)
(* caller of the typed-input service may give the recipient an input       *)
(* under the send's id. Each step is one store transaction, and every      *)
(* step that reads or decides the send takes the sending workflow's        *)
(* session lock first, so the steps are atomic here. A failed attempt      *)
(* loses only its own progress. Agent-session recipients are not in this   *)
(* model.                                                                  *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    MaxAttempts,    \* the attempts the send orchestration counts before it gives up
    Foreign,        \* environment: "none", or what a trusted caller gives the recipient under the send's id:
                    \* "same" (the message's content) or "other" (another content)
    Cancels,        \* environment: the sending run may be cancelled
    SourceDeletes,  \* environment: the sending workflow's session may be deleted
    RecipientEnds,  \* environment: the recipient may stop taking input (its run ends, or it is deleted)
    Terminates,     \* environment: the send orchestration may end without a record
    Crashes,        \* environment: an attempt may fail between its steps
    Guard,          \* fix 9fcbf377 (S2-GPT-02): a fresh acceptance needs the send undecided; FALSE: fa7c232f
    CollectFinds,   \* fix 9fcbf377 (S2-GPT-01): the controller's collection records the acceptance; FALSE: fa7c232f
    ContentBound,   \* fix 9fcbf377 (S2-GPT-03): only an input with the message's content is its acceptance; FALSE: fa7c232f
    RunEndDecides   \* fix 9fcbf377: the run's end decides a pending message to a workflow; FALSE: fa7c232f

ASSUME MaxAttempts \in Nat /\ MaxAttempts >= 1
ASSUME Foreign \in {"none", "same", "other"}
ASSUME {Cancels, SourceDeletes, RecipientEnds, Terminates, Crashes, Guard, CollectFinds, ContentBound, RunEndDecides} \subseteq BOOLEAN

VARIABLES
    run,        \* the sending run: "active" or "ended"
    live,       \* the sending workflow's session is live (not deleted)
    node,       \* the send state: "pending", "sent", "cancelled", "failed"
    outbox,     \* its message: "pending", "delivered", "failed"
    rcpt,       \* the input the message's receipt names: "none", "own" (the message's content), "other"
    input,      \* the recipient's input under the send's id: "none", "own", "other"
    takes,      \* the recipient takes fresh input
    child,      \* the send orchestration: "running" or "ended"
    att,        \* the current attempt: "idle", "begun", "accepted", "refused", "done"
    tries,      \* the attempts counted
    byUs,       \* ghost: the send's own delivery stored the recipient's input
    late,       \* ghost: it stored it after the send was decided
    failedHeld, \* ghost: a decision failed the message while the recipient held the message's own input
    guarded,    \* ghost: an acceptance was refused because the send was decided first
    how         \* ghost: what recorded the delivery: "none", "attempt", "begin", "fail", "exhausted", "collect", "end"

vars == <<run, live, node, outbox, rcpt, input, takes, child, att, tries, byUs, late, failedHeld, guarded, how>>

TypeOK ==
    /\ run \in {"active", "ended"}
    /\ live \in BOOLEAN
    /\ node \in {"pending", "sent", "cancelled", "failed"}
    /\ outbox \in {"pending", "delivered", "failed"}
    /\ rcpt \in {"none", "own", "other"}
    /\ input \in {"none", "own", "other"}
    /\ takes \in BOOLEAN
    /\ child \in {"running", "ended"}
    /\ att \in {"idle", "begun", "accepted", "refused", "done"}
    /\ tries \in 0..MaxAttempts
    /\ byUs \in BOOLEAN
    /\ late \in BOOLEAN
    /\ failedHeld \in BOOLEAN
    /\ guarded \in BOOLEAN
    /\ how \in {"none", "attempt", "begin", "fail", "exhausted", "collect", "end"}

Init ==
    /\ run = "active" /\ live = TRUE /\ node = "pending" /\ outbox = "pending" /\ rcpt = "none" /\ input = "none"
    /\ takes = TRUE /\ child = "running" /\ att = "idle" /\ tries = 0
    /\ byUs = FALSE /\ late = FALSE /\ failedHeld = FALSE /\ guarded = FALSE /\ how = "none"

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
    /\ UNCHANGED failedHeld

(* No delivery will be recorded: the message fails, and a state still      *)
(* pending (in a live workflow) gets the failure.                          *)
FailMessage ==
    /\ outbox' = "failed"
    /\ node' = IF node = "pending" /\ live THEN "failed" ELSE node
    /\ failedHeld' = (failedHeld \/ input = "own")
    /\ UNCHANGED <<rcpt, how>>

(* S failDelivery: a message already decided is kept; otherwise the        *)
(* recipient's acceptance found is the delivery, or the message fails.     *)
Conclude(by) ==
    IF outbox # "pending"
    THEN UNCHANGED <<node, outbox, rcpt, how, failedHeld>>
    ELSE IF Found THEN Deliver(by) ELSE FailMessage

(* S beginDelivery, under the session locks: a message already decided    *)
(* ends the attempt; the acceptance found is recorded, with no attempt     *)
(* counted; a decided state or a deleted workflow fails the message;       *)
(* otherwise the attempt is counted.                                       *)
Begin ==
    /\ child = "running"
    /\ att = "idle"
    /\ tries < MaxAttempts
    /\ IF outbox # "pending"
       THEN (att' = "done" /\ UNCHANGED <<node, outbox, rcpt, how, failedHeld, tries>>)
       ELSE IF Found
            THEN (Deliver("begin") /\ att' = "done" /\ UNCHANGED tries)
            ELSE IF ~live \/ node # "pending"
                 THEN (/\ outbox' = "failed"
                       /\ failedHeld' = (failedHeld \/ input = "own")
                       /\ att' = "done"
                       /\ UNCHANGED <<node, rcpt, how, tries>>)
                 ELSE (tries' = tries + 1 /\ att' = "begun" /\ UNCHANGED <<node, outbox, rcpt, how, failedHeld>>)
    /\ UNCHANGED <<run, live, input, takes, child, byUs, late, guarded>>

(* V acceptSendAsWorkflowInputV2 and S acceptInput with the send's id,      *)
(* under the session locks. A recipient that takes no input and a deleted *)
(* sending workflow refuse it. A repeat of the message's own request is    *)
(* answered with its stored acceptance; another input under the id is      *)
(* OPERATION_CONFLICT. A fresh input needs the send undecided (Guard,      *)
(* SEND_DECIDED); otherwise the recipient stores the message's input.      *)
Accept ==
    /\ att = "begun"
    /\ IF ~takes \/ ~live
       THEN (att' = "refused" /\ UNCHANGED <<input, byUs, late, guarded>>)
       ELSE IF input = "own"
            THEN (att' = "accepted" /\ UNCHANGED <<input, byUs, late, guarded>>)
            ELSE IF input = "other"
                 THEN (att' = "refused" /\ UNCHANGED <<input, byUs, late, guarded>>)
                 ELSE IF Guard /\ Decided
                      THEN (att' = "refused" /\ guarded' = TRUE /\ UNCHANGED <<input, byUs, late>>)
                      ELSE (/\ input' = "own"
                            /\ byUs' = TRUE
                            /\ late' = (late \/ Decided)
                            /\ att' = "accepted"
                            /\ UNCHANGED guarded)
    /\ UNCHANGED <<run, live, node, outbox, rcpt, takes, child, tries, failedHeld, how>>

(* S recordDelivery: the delivery recorded, unless the message was decided *)
(* first.                                                                  *)
Record ==
    /\ att = "accepted"
    /\ IF outbox = "pending" THEN Deliver("attempt") ELSE UNCHANGED <<node, outbox, rcpt, how, failedHeld>>
    /\ att' = "done"
    /\ UNCHANGED <<run, live, input, takes, child, tries, byUs, late, guarded>>

(* R the deliver activity's refusal: S failDelivery ends the attempts.     *)
Fail ==
    /\ att = "refused"
    /\ Conclude("fail")
    /\ att' = "done"
    /\ UNCHANGED <<run, live, input, takes, child, tries, byUs, late, guarded>>

(* The attempt's activity fails between its steps; while the send          *)
(* orchestration runs, the attempt begins again.                           *)
Crash ==
    /\ Crashes
    /\ att \in {"begun", "accepted", "refused"}
    /\ att' = IF child = "running" THEN "idle" ELSE "done"
    /\ UNCHANGED <<run, live, node, outbox, rcpt, input, takes, child, tries, byUs, late, failedHeld, guarded, how>>

(* R deliveryFailed: every attempt failed, and failDelivery ends them.     *)
Exhausted ==
    /\ child = "running"
    /\ att = "idle"
    /\ tries = MaxAttempts
    /\ Conclude("exhausted")
    /\ att' = "done"
    /\ UNCHANGED <<run, live, input, takes, child, tries, byUs, late, guarded>>

(* The send orchestration completes after its last attempt.                *)
Complete ==
    /\ child = "running"
    /\ att = "done"
    /\ child' = "ended"
    /\ UNCHANGED <<run, live, node, outbox, rcpt, input, takes, att, tries, byUs, late, failedHeld, guarded, how>>

(* The send orchestration is terminated, or its last record failed: it     *)
(* ends without a record. An attempt in flight may still finish its steps  *)
(* (a running activity is not stopped); none begins again.                 *)
Terminate ==
    /\ Terminates
    /\ child = "running"
    /\ child' = "ended"
    /\ UNCHANGED <<run, live, node, outbox, rcpt, input, takes, att, tries, byUs, late, failedHeld, guarded, how>>

(* R collect: the controller finds the send orchestration ended and the    *)
(* state pending, and calls failDelivery. CollectFinds = FALSE: fa7c232f,  *)
(* which failed the message without looking for the acceptance.           *)
Collect ==
    /\ child = "ended"
    /\ run = "active"
    /\ live
    /\ node = "pending"
    /\ IF CollectFinds
       THEN Conclude("collect")
       ELSE IF outbox # "pending" THEN UNCHANGED <<node, outbox, rcpt, how, failedHeld>> ELSE FailMessage
    /\ UNCHANGED <<run, live, input, takes, child, att, tries, byUs, late, guarded>>

(* S finishRun for a cancel: the run ends, a pending state is cancelled,   *)
(* and (RunEndDecides) a pending message to the workflow is decided in the *)
(* same transaction: the acceptance found is its delivery (the state keeps *)
(* the cancel); otherwise it fails.                                        *)
Cancel ==
    /\ Cancels
    /\ run = "active"
    /\ live
    /\ run' = "ended"
    /\ node' = IF node = "pending" THEN "cancelled" ELSE node
    /\ IF RunEndDecides /\ outbox = "pending"
       THEN IF Found
            THEN (outbox' = "delivered" /\ rcpt' = input /\ how' = "end" /\ UNCHANGED failedHeld)
            ELSE (outbox' = "failed" /\ failedHeld' = (failedHeld \/ input = "own") /\ UNCHANGED <<rcpt, how>>)
       ELSE UNCHANGED <<outbox, rcpt, how, failedHeld>>
    /\ UNCHANGED <<live, input, takes, child, att, tries, byUs, late, guarded>>

(* The sending workflow's session is soft-deleted. Its trigger cancels the *)
(* active run's pending states; the message stays as it is.                *)
SourceDelete ==
    /\ SourceDeletes
    /\ live
    /\ live' = FALSE
    /\ run' = "ended"
    /\ node' = IF node = "pending" /\ run = "active" THEN "cancelled" ELSE node
    /\ UNCHANGED <<outbox, rcpt, input, takes, child, att, tries, byUs, late, failedHeld, guarded, how>>

(* The recipient stops taking input: its run ends, or it is deleted.       *)
RecipientStops ==
    /\ RecipientEnds
    /\ takes
    /\ takes' = FALSE
    /\ UNCHANGED <<run, live, node, outbox, rcpt, input, child, att, tries, byUs, late, failedHeld, guarded, how>>

(* V sendWorkflowInputV2 by a trusted caller: the recipient gets an input  *)
(* from the sending workflow under the send's id, with the message's own   *)
(* content ("same") or another ("other").                                  *)
Give ==
    /\ Foreign # "none"
    /\ input = "none"
    /\ takes
    /\ live
    /\ input' = IF Foreign = "same" THEN "own" ELSE "other"
    /\ UNCHANGED <<run, live, node, outbox, rcpt, takes, child, att, tries, byUs, late, failedHeld, guarded, how>>

Next ==
    \/ Begin \/ Accept \/ Record \/ Fail \/ Crash \/ Exhausted \/ Complete \/ Terminate
    \/ Collect \/ Cancel \/ SourceDelete \/ RecipientStops \/ Give

(* Weak fairness of the store's steps, the send orchestration and the      *)
(* controller. The environment (crashes, termination, cancels, deletions,  *)
(* the recipient, the trusted caller) is not fair.                         *)
Fairness ==
    /\ WF_vars(Begin) /\ WF_vars(Accept) /\ WF_vars(Record) /\ WF_vars(Fail)
    /\ WF_vars(Exhausted) /\ WF_vars(Complete) /\ WF_vars(Collect)

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)

(* The send's own delivery never stores an input after the send was        *)
(* decided: a cancel or another decision that commits first leaves the     *)
(* recipient nothing (S2-GPT-02).                                          *)
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

(* The state is eventually decided.                                        *)
Live_StateDecided == <>(node # "pending")

(* The message is eventually decided.                                      *)
Live_MessageDecided == <>(outbox # "pending")

(***************************************************************************)
(* Witnesses: each is expected to be violated, which shows that its        *)
(* outcome is reachable.                                                   *)
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
(* An input a trusted caller gave with the message's content is recorded   *)
(* as its delivery.                                                        *)
Wit_SameRecorded == ~(outbox = "delivered" /\ ~byUs)
(* Another input under the send's id: the message fails, and the input     *)
(* stays as it was given.                                                  *)
Wit_OtherRefused == ~(input = "other" /\ outbox = "failed")

=============================================================================
