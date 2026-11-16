------------------------ MODULE WorkflowLifecycle ------------------------
(***************************************************************************)
(* The start of a live workflow run and the cancels that can come       *)
(* before its controller begins it, as packages/sdk/src/workflow        *)
(* implements them in the commit of this file (README "Lifecycle model"):  *)
(* the dispatch after admission (it may be lost, and it skips a run that   *)
(* already ended), duroxide's start, the provider's drop of queue messages *)
(* for an instance that has not started, the controller's begin, the       *)
(* parent's recover, update_workflow cancel by the parent, by another      *)
(* agent session or by a system actor (a service caller that is not the   *)
(* parent; not a production entry point), cancel receipts that an earlier  *)
(* build stored, and who is told that the run ended. A system actor's     *)
(* cancel records no requester (null). Each notification effect has the    *)
(* outcome the code gives it: a notifier start succeeds or fails for good; *)
(* a delivery is made, records a skip when the parent's authority is gone, *)
(* or runs out, and its caller sees that.                                  *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS
    Cancellers,            \* who sends a cancel: a subset of {"parent", "other", "system"}
    LegacyWriter,          \* who wrote a cancel receipt an earlier build stored without ending the run: "none", "parent" (M1), or "other" or "system" (M1 broken)
    CancelEndsBeforeBegin, \* fix 369beaf0: a cancel ends a run that has not begun in its own transaction, also on a repeat
    BeginHonorsReceipt,    \* fix 31dc9888: begin ends a run that has not begun and has an accepted cancel receipt
    C2Fix,                 \* fix b1d1d4b9: begin names the parent as that receipt's requester (M1) and starts the notifier for a requester that is not the parent; the parent's own cancel is not reported
    LoseDispatch,          \* fault: the controller start after admission never reaches duroxide
    DropOrphans,           \* the provider: duroxide-pg drops queue messages of an instance with no row and no history
    Interrupts,            \* fault: a cancel request stops after its commit; the begin activity runs again after its commit
    Repeats,               \* environment: a requester repeats, with its operation id, a cancel that was interrupted or returned an error (assumption A5)
    Recovery,              \* the parent's recover of a run that needs it (assumption A3)
    ControllerDeath,       \* fault: the controller ends without ending its run; its begin activity may still complete
    NotifyEnabled,         \* workflow: it has a parent and asked to be told (notifyParent)
    NotifyFaults,          \* fault: a notifier start, or a delivery that notifyParent attempts, fails for good (its retries run out)
    AuthorityLoss,         \* environment: the parent's authority to be told is gone when a delivery is attempted (notifyParent records a skip)
    MaxCrashes             \* begin activity re-executions

Reqs == {"parent", "other", "system"}
NonParent == {"other", "system"}
ASSUME Cancellers \subseteq Reqs
ASSUME LegacyWriter \in Reqs \cup {"none"}
ASSUME {CancelEndsBeforeBegin, BeginHonorsReceipt, C2Fix, LoseDispatch, DropOrphans, Interrupts, Repeats,
        Recovery, ControllerDeath, NotifyEnabled, NotifyFaults, AuthorityLoss} \subseteq BOOLEAN
ASSUME MaxCrashes \in Nat

Active == {"admitted", "running"}
Terminal == {"completed", "cancelled", "failed"}
(* A controller that ended: it completed, it failed, or it ended without   *)
(* ending its run (dead).                                                  *)
Ended == {"done", "failed", "dead"}
(* The legacy writer may repeat its earlier request.                       *)
Senders == Cancellers \cup {w \in Reqs : w = LegacyWriter}
(* The requester a cancel records (V controlWorkflowRun): an agent's      *)
(* session, or null for any other actor.                                   *)
Rec(r) == IF r = "system" THEN "null" ELSE r

VARIABLES
    status,           \* the run's status
    rcpt,             \* each requester's cancel receipt (one operation id each) is stored
    firstRcpt,        \* the requester of the earliest cancel receipt (begin's query)
    endKind,          \* how the run ended: "none", "finish", "beforeBegin", "cmd", "recover"
    endReq,           \* requestedBy in the run's end: "parent", "other", "null" or "none"
    endTruth,         \* ghost: who actually asked for the cancel that ended the run
    endOp,            \* whose operation id the run's before-begin end records
    acceptedNotBegun, \* ghost: a cancel was accepted while the run had not begun
    dispatch,         \* the dispatch after admission: "pending", "sent", "skipped", "lost"
    rdispatch,        \* a recover dispatched the run
    rnotify,          \* the recover that ended the run: "none", "pending" (its end committed), "done", "error" (its notifier start failed for good)
    inst,             \* the controller instance: "none" (NotFound), "begin", "beginNotify", "run", "fallback" (its failure path),
                      \* "done" (completed), "failed", "dead" (ended without ending its run)
    q,                \* cancel commands queued for the controller instance, by requester
    crashes,          \* begin activity re-executions taken
    zBegin,           \* the begin activity of a controller that ended: "none", "tx" (may still commit),
                      \* "notify" (may still start the notifier), "lost" (that start failed for good, unseen)
    req,              \* each requester's cancel request: "idle", "committed", "done", "error" (it returned an error after its commit)
    tries,            \* requests each requester sent (the first and a repeat)
    notifier,         \* the notifier orchestration: "none", "started", "done" (completed), "failed" (its delivery ran out)
    notice,           \* the parent was told that the run ended
    skipped,          \* a delivery found the parent's authority gone and recorded a skip
    selfNotice        \* ghost: the parent was told of a cancel it asked for itself

endVars == <<endKind, endReq, endTruth, endOp>>
storeVars == <<status, rcpt, firstRcpt, endVars, acceptedNotBegun>>
ctlVars == <<dispatch, rdispatch, rnotify, inst, q, crashes, zBegin>>
reqVars == <<req, tries>>
noteVars == <<notifier, notice, skipped, selfNotice>>
vars == <<storeVars, ctlVars, reqVars, noteVars>>

TypeOK ==
    /\ status \in Active \cup Terminal
    /\ rcpt \in [Reqs -> BOOLEAN]
    /\ firstRcpt \in Reqs \cup {"none"}
    /\ endKind \in {"none", "finish", "beforeBegin", "cmd", "recover"}
    /\ endReq \in {"parent", "other", "null", "none"}
    /\ endTruth \in Reqs \cup {"none"}
    /\ endOp \in Reqs \cup {"none"}
    /\ acceptedNotBegun \in BOOLEAN
    /\ dispatch \in {"pending", "sent", "skipped", "lost"}
    /\ rdispatch \in BOOLEAN
    /\ rnotify \in {"none", "pending", "done", "error"}
    /\ inst \in {"none", "begin", "beginNotify", "run", "fallback"} \cup Ended
    /\ q \in SUBSET Reqs
    /\ crashes \in 0..MaxCrashes
    /\ zBegin \in {"none", "tx", "notify", "lost"}
    /\ req \in [Reqs -> {"idle", "committed", "done", "error"}]
    /\ tries \in [Reqs -> 0..2]
    /\ notifier \in {"none", "started", "done", "failed"}
    /\ notice \in BOOLEAN
    /\ skipped \in BOOLEAN
    /\ selfNotice \in BOOLEAN

(* An earlier build stored LegacyWriter's cancel receipt and queued its     *)
(* command, which the provider dropped: the run is still admitted.          *)
Init ==
    /\ status = "admitted"
    /\ rcpt = [r \in Reqs |-> r = LegacyWriter]
    /\ firstRcpt = LegacyWriter
    /\ endKind = "none" /\ endReq = "none" /\ endTruth = "none" /\ endOp = "none"
    /\ acceptedNotBegun = (LegacyWriter # "none")
    /\ dispatch = "pending" /\ rdispatch = FALSE /\ rnotify = "none" /\ inst = "none" /\ q = {} /\ crashes = 0 /\ zBegin = "none"
    /\ req = [r \in Reqs |-> "idle"]
    /\ tries = [r \in Reqs |-> IF r = LegacyWriter THEN 1 ELSE 0]
    /\ notifier = "none" /\ notice = FALSE /\ skipped = FALSE /\ selfNotice = FALSE

(* The outcomes of a notifier start (a duroxide client call that its caller *)
(* awaits): when it is attempted, it may fail for good (NotifyFaults).      *)
StartOk(attempted) == IF NotifyFaults /\ attempted THEN BOOLEAN ELSE {TRUE}

(* R notifyParent, one call with its retries, given whether the run's end   *)
(* tells the parent: nothing when it does not, or when the parent was told  *)
(* or a skip was recorded (its dedup by the run's events); otherwise it     *)
(* delivers, records a skip and returns when the parent's authority is gone *)
(* (AuthorityLoss), or runs out (NotifyFaults), which fails its caller.     *)
Outcomes(tells) ==
    IF tells /\ ~notice /\ ~skipped
    THEN {"delivered"} \cup (IF AuthorityLoss THEN {"skipped"} ELSE {}) \cup (IF NotifyFaults THEN {"exhausted"} ELSE {})
    ELSE {"nothing"}

(* What that call changes; kind and truth describe the run's end after     *)
(* this step.                                                              *)
Notified(o, kind, truth) ==
    /\ notice' = (notice \/ (o = "delivered"))
    /\ skipped' = (skipped \/ (o = "skipped"))
    /\ selfNotice' = (selfNotice \/ (o = "delivered" /\ kind \in {"beforeBegin", "cmd"} /\ truth = "parent"))

(* V dispatchWorkflowRun after admission: it starts the controller of a  *)
(* run that is still active, and skips one that already ended.              *)
DispatchSend ==
    /\ dispatch = "pending"
    /\ dispatch' = IF status \in Active THEN "sent" ELSE "skipped"
    /\ UNCHANGED <<storeVars, rdispatch, rnotify, inst, q, crashes, zBegin, reqVars, noteVars>>

DispatchLose ==
    /\ LoseDispatch
    /\ dispatch = "pending"
    /\ dispatch' = "lost"
    /\ UNCHANGED <<storeVars, rdispatch, rnotify, inst, q, crashes, zBegin, reqVars, noteVars>>

(* duroxide processes a start (the dispatch's or a recover's): the instance *)
(* has a row and history now; a second start is ignored.                   *)
Start ==
    /\ inst = "none"
    /\ dispatch = "sent" \/ rdispatch
    /\ inst' = "begin"
    /\ UNCHANGED <<storeVars, dispatch, rdispatch, rnotify, q, crashes, zBegin, reqVars, noteVars>>

(* duroxide-pg acknowledges, and so deletes, the queue messages it fetches  *)
(* for an instance with no row and no history.                              *)
OrphanDrop ==
    /\ DropOrphans
    /\ inst = "none"
    /\ q # {}
    /\ q' = {}
    /\ UNCHANGED <<storeVars, dispatch, rdispatch, rnotify, inst, crashes, zBegin, reqVars, noteVars>>

(* S beginRun: a run that has not begun and has an accepted cancel receipt  *)
(* (the earliest) is ended as cancelled, before it began; its requester is  *)
(* the parent (C2Fix, migration assumption M1) or null (31dc9888).          *)
Repair == BeginHonorsReceipt /\ status = "admitted" /\ firstRcpt # "none"

BeginEffect ==
    /\ status' = CASE Repair -> "cancelled"
                   [] status = "admitted" -> "running"
                   [] OTHER -> status
    /\ endKind' = IF Repair THEN "beforeBegin" ELSE endKind
    /\ endReq' = IF Repair THEN (IF C2Fix THEN "parent" ELSE "null") ELSE endReq
    /\ endTruth' = IF Repair THEN firstRcpt ELSE endTruth
    /\ endOp' = IF Repair THEN firstRcpt ELSE endOp

BeginTx ==
    /\ inst = "begin"
    /\ BeginEffect
    /\ inst' = "beginNotify"
    /\ UNCHANGED <<rcpt, firstRcpt, acceptedNotBegun, dispatch, rdispatch, rnotify, q, crashes, zBegin, reqVars, noteVars>>

(* The begin activity after its commit: with C2Fix it starts the notifier   *)
(* for a run that a cancel ended before it began, unless the run's end      *)
(* names the parent or the workflow asked not to be told (R                 *)
(* parentToldOfCancelBeforeBegin); the controller runs an active run and    *)
(* completes otherwise. The start is attempted whenever the end tells the   *)
(* parent (duroxide ignores a second start of the notifier). A start that   *)
(* fails for good (NotifyFaults) fails the begin activity, and the          *)
(* controller takes its failure path (CtlFallback).                         *)
BeginTells == NotifyEnabled /\ C2Fix /\ status = "cancelled" /\ endKind = "beforeBegin" /\ endReq # "parent"
NotifierStart == IF BeginTells /\ notifier = "none" THEN "started" ELSE notifier

BeginNotify ==
    /\ inst = "beginNotify"
    /\ \E ok \in StartOk(BeginTells) :
        /\ notifier' = IF ok THEN NotifierStart ELSE notifier
        /\ inst' = IF ~ok THEN "fallback" ELSE IF status \in Active THEN "run" ELSE "done"
    /\ UNCHANGED <<storeVars, dispatch, rdispatch, rnotify, q, crashes, zBegin, reqVars, notice, skipped, selfNotice>>

(* The begin activity runs again after its commit (a worker crash).         *)
BeginRetry ==
    /\ Interrupts
    /\ inst = "beginNotify"
    /\ crashes < MaxCrashes
    /\ inst' = "begin"
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<storeVars, dispatch, rdispatch, rnotify, q, zBegin, reqVars, noteVars>>

(* R notifyParent: the parent is told unless the requester that the run's   *)
(* end names is the parent: the command's requester, or, with C2Fix, when   *)
(* the command names none (null), the recorded or attributed requester of a *)
(* before-begin end.                                                       *)
Tells(arg) ==
    (IF arg \notin {"none", "null"} THEN arg ELSE IF C2Fix /\ endKind = "beforeBegin" THEN endReq ELSE "null") # "parent"

(* The controller reads a queued cancel (its first poll follows begin), the *)
(* cancel activity ends the run with the command's requester, and it        *)
(* notifies with that requester (R applyCommand). When that notification   *)
(* runs out, the controller takes its failure path.                        *)
ApplyCmd ==
    /\ inst = "run"
    /\ status = "running"
    /\ \E r \in q :
        \E o \in Outcomes(NotifyEnabled /\ Tells(Rec(r))) :
            /\ status' = "cancelled"
            /\ endKind' = "cmd"
            /\ endReq' = Rec(r)
            /\ endTruth' = r
            /\ q' = q \ {r}
            /\ Notified(o, "cmd", r)
            /\ inst' = IF o = "exhausted" THEN "fallback" ELSE "done"
    /\ UNCHANGED <<rcpt, firstRcpt, endOp, acceptedNotBegun, dispatch, rdispatch, rnotify, crashes, zBegin, reqVars, notifier>>

(* The run's own work ends it (abstracted); reportEnded tells the parent.  *)
(* The controller polls its queue before it admits anything, so the work    *)
(* starts only with no command queued (README "Lifecycle model": limits).  *)
(* When that notification runs out, the controller takes its failure path. *)
RunFinish ==
    /\ inst = "run"
    /\ status = "running"
    /\ q = {}
    /\ \E o \in Outcomes(NotifyEnabled) :
        /\ Notified(o, "finish", "none")
        /\ inst' = IF o = "exhausted" THEN "fallback" ELSE "done"
    /\ status' = "completed"
    /\ endKind' = "finish"
    /\ UNCHANGED <<rcpt, firstRcpt, endReq, endTruth, endOp, acceptedNotBegun, dispatch, rdispatch, rnotify, q, crashes, zBegin,
                   reqVars, notifier>>

(* The controller's failure path after a notification effect ran out (R    *)
(* workflowController, failRun): its finish keeps the run's end (the run  *)
(* already ended, Inv_FallbackAfterEnd), and reportEnded calls              *)
(* notifyParent once more, with no requester. The controller completes      *)
(* when that call returns, and fails when it runs out too.                  *)
CtlFallback ==
    /\ inst = "fallback"
    /\ \E o \in Outcomes(NotifyEnabled /\ Tells("none")) :
        /\ Notified(o, endKind, endTruth)
        /\ inst' = IF o = "exhausted" THEN "failed" ELSE "done"
    /\ UNCHANGED <<storeVars, dispatch, rdispatch, rnotify, q, crashes, zBegin, reqVars, notifier>>

(* V controlWorkflowRun cancel and S recordRunCancelRequest, one          *)
(* transaction: the receipt and, with CancelEndsBeforeBegin, the end of a   *)
(* run that has not begun (a repeat of an accepted cancel too, with the     *)
(* repeat's requester, recorded as Rec). Earlier builds stored the receipt  *)
(* only.                                                                   *)
EndsNow == CancelEndsBeforeBegin /\ status = "admitted"

CancelTx(r) ==
    /\ r \in Senders
    /\ req[r] \in {"idle", "error"}
    /\ tries[r] < (IF Repeats THEN 2 ELSE 1)
    /\ status' = IF EndsNow THEN "cancelled" ELSE status
    /\ endKind' = IF EndsNow THEN "beforeBegin" ELSE endKind
    /\ endReq' = IF EndsNow THEN Rec(r) ELSE endReq
    /\ endTruth' = IF EndsNow THEN r ELSE endTruth
    /\ endOp' = IF EndsNow THEN r ELSE endOp
    /\ rcpt' = [rcpt EXCEPT ![r] = TRUE]
    /\ firstRcpt' = IF firstRcpt = "none" THEN r ELSE firstRcpt
    /\ acceptedNotBegun' = (acceptedNotBegun \/ (~rcpt[r] /\ status = "admitted"))
    /\ req' = [req EXCEPT ![r] = "committed"]
    /\ tries' = [tries EXCEPT ![r] = tries[r] + 1]
    /\ UNCHANGED <<dispatch, rdispatch, rnotify, inst, q, crashes, zBegin, noteVars>>

(* After the commit: an active run's controller gets the command (V         *)
(* enqueueEvent, a repeat too); for a run this request's operation ended    *)
(* before it began, V notifyCancelledBeforeBegin starts the notifier unless *)
(* the end names the parent, the workflow asked not to be told, or (with    *)
(* C2Fix) the parent asks. A start that fails for good (NotifyFaults) is an *)
(* error the request returns; its receipt and the run's end stay, and the   *)
(* requester may repeat it with its operation id (A5).                      *)
FollowTells(r) ==
    /\ NotifyEnabled
    /\ status = "cancelled"
    /\ endKind = "beforeBegin"
    /\ endOp = r
    /\ endReq # "parent"
    /\ ~(C2Fix /\ r = "parent")

CancelFollow(r) ==
    /\ req[r] = "committed"
    /\ \E ok \in StartOk(FollowTells(r)) :
        /\ notifier' = IF ok /\ FollowTells(r) /\ notifier = "none" THEN "started" ELSE notifier
        /\ req' = [req EXCEPT ![r] = IF ok THEN "done" ELSE "error"]
    /\ q' = IF status \in Active THEN q \cup {r} ELSE q
    /\ UNCHANGED <<storeVars, dispatch, rdispatch, rnotify, inst, crashes, zBegin, tries, notice, skipped, selfNotice>>

(* The first request stops after its commit (A5: its repeat completes).    *)
CancelInterrupt(r) ==
    /\ Interrupts
    /\ req[r] = "committed"
    /\ tries[r] = 1
    /\ req' = [req EXCEPT ![r] = "idle"]
    /\ UNCHANGED <<storeVars, ctlVars, tries, noteVars>>

(* V recoverWorkflowRun: a run that has not begun and has no controller   *)
(* instance is dispatched again (its receipt first); an active run whose    *)
(* controller ended is ended as failed. After that commit the request       *)
(* starts the notifier when the workflow asked to be told (V               *)
(* notifyRecoveredRun); a start that fails for good is an error the request *)
(* returns, and the run's end stays.                                       *)
RecoverDispatch ==
    /\ Recovery
    /\ inst = "none"
    /\ status = "admitted"
    /\ ~rdispatch
    /\ rdispatch' = TRUE
    /\ UNCHANGED <<storeVars, dispatch, rnotify, inst, q, crashes, zBegin, reqVars, noteVars>>

RecoverEnd ==
    /\ Recovery
    /\ inst \in Ended
    /\ status \in Active
    /\ status' = "failed"
    /\ endKind' = "recover"
    /\ rnotify' = "pending"
    /\ UNCHANGED <<rcpt, firstRcpt, endReq, endTruth, endOp, acceptedNotBegun, dispatch, rdispatch, inst, q, crashes, zBegin,
                   reqVars, noteVars>>

RecoverNotify ==
    /\ rnotify = "pending"
    /\ \E ok \in StartOk(NotifyEnabled) :
        /\ notifier' = IF ok /\ NotifyEnabled /\ notifier = "none" THEN "started" ELSE notifier
        /\ rnotify' = IF ok THEN "done" ELSE "error"
    /\ UNCHANGED <<storeVars, dispatch, rdispatch, inst, q, crashes, zBegin, reqVars, notice, skipped, selfNotice>>

(* The controller ends without ending its run (before, during or after      *)
(* begin, or in its failure path). A begin activity it had scheduled is not *)
(* stopped: it may still commit, and after its commit still start the       *)
(* notifier (zBegin).                                                       *)
CtrlDie ==
    /\ ControllerDeath
    /\ inst \in {"begin", "beginNotify", "run", "fallback"}
    /\ inst' = "dead"
    /\ zBegin' = CASE inst = "begin" -> "tx"
                   [] inst = "beginNotify" -> "notify"
                   [] OTHER -> zBegin
    /\ UNCHANGED <<storeVars, dispatch, rdispatch, rnotify, q, crashes, reqVars, noteVars>>

(* That begin activity's transaction and its notifier start, after its     *)
(* controller ended (not fair: they may never happen). The start may fail   *)
(* for good (NotifyFaults); no controller sees that (zBegin = "lost").      *)
ZombieBeginTx ==
    /\ zBegin = "tx"
    /\ BeginEffect
    /\ zBegin' = "notify"
    /\ UNCHANGED <<rcpt, firstRcpt, acceptedNotBegun, dispatch, rdispatch, rnotify, inst, q, crashes, reqVars, noteVars>>

ZombieBeginNotify ==
    /\ zBegin = "notify"
    /\ \E ok \in StartOk(BeginTells) :
        /\ notifier' = IF ok THEN NotifierStart ELSE notifier
        /\ zBegin' = IF ok THEN "none" ELSE "lost"
    /\ UNCHANGED <<storeVars, dispatch, rdispatch, rnotify, inst, q, crashes, reqVars, notice, skipped, selfNotice>>

(* The notifier orchestration runs notifyParent with no requester (R        *)
(* workflowNotify): it completes when the call returns (it delivered, had  *)
(* nothing to tell, or recorded a skip), and fails when the call runs out.  *)
NotifierTells == NotifyEnabled /\ Tells("none")

NotifierRun ==
    /\ notifier = "started"
    /\ \E o \in Outcomes(NotifierTells) :
        /\ notifier' = IF o = "exhausted" THEN "failed" ELSE "done"
        /\ Notified(o, endKind, endTruth)
    /\ UNCHANGED <<storeVars, ctlVars, reqVars>>

Next ==
    \/ DispatchSend \/ DispatchLose \/ Start \/ OrphanDrop
    \/ BeginTx \/ BeginNotify \/ BeginRetry \/ ApplyCmd \/ RunFinish \/ CtlFallback
    \/ \E r \in Reqs : (CancelTx(r) \/ CancelFollow(r) \/ CancelInterrupt(r))
    \/ RecoverDispatch \/ RecoverEnd \/ RecoverNotify \/ CtrlDie \/ ZombieBeginTx \/ ZombieBeginNotify \/ NotifierRun

(* Weak fairness of the dispatch, duroxide, the controller and its failure  *)
(* path, the request's follow-up, the notifier, recover and its follow-up   *)
(* (A3), and the repeat of a request that was interrupted or returned an    *)
(* error (A5). The first cancel, the faults, the drop and the begin         *)
(* activity of a controller that ended are not fair; an outcome of a fair   *)
(* step may be its fault.                                                   *)
Fairness ==
    /\ WF_vars(DispatchSend) /\ WF_vars(Start) /\ WF_vars(BeginTx) /\ WF_vars(BeginNotify)
    /\ WF_vars(ApplyCmd) /\ WF_vars(RunFinish) /\ WF_vars(CtlFallback) /\ WF_vars(NotifierRun)
    /\ WF_vars(RecoverDispatch) /\ WF_vars(RecoverEnd) /\ WF_vars(RecoverNotify)
    /\ \A r \in Reqs : WF_vars(CancelFollow(r))
    /\ \A r \in Reqs : WF_vars(tries[r] = 1 /\ CancelTx(r))

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)

(* A cancel accepted before the run began wins: the run's work never runs   *)
(* to its end (C1). Its controller may begin it, then applies the queued    *)
(* cancel before it admits anything.                                       *)
Inv_AcceptedCancelWins == acceptedNotBegun => status # "completed"

(* This commit ends such a run before its controller begins it: in the      *)
(* cancel's transaction (369beaf0), or at begin (31dc9888).                *)
Inv_EndedBeforeBegin == acceptedNotBegun => status \notin {"running", "completed"}

(* The parent is never told of a cancel it asked for (C2).                 *)
Inv_NoSelfNotice == ~selfNotice

(* A before-begin end records no requester (null) exactly when a system     *)
(* actor asked: an agent's cancel, and a legacy receipt under C2Fix, name a *)
(* session.                                                                *)
Inv_EndNamesRequester == endKind = "beforeBegin" => ((endReq = "null") <=> (endTruth = "system"))

(* The recorded requester is the one that asked (null for a system actor);  *)
(* for a legacy receipt it holds under M1 only.                            *)
Inv_AttributionTruthful == endKind = "beforeBegin" => endReq = Rec(endTruth)

(* The parent is told only when the workflow asked for it.                 *)
Inv_NoticeEnabled == notice => NotifyEnabled

(* The controller takes its failure path only for a run that already      *)
(* ended, so failRun's finish keeps that end (S finishRun).                *)
Inv_FallbackAfterEnd == inst = "fallback" => status \in Terminal

LifecycleSafety ==
    /\ TypeOK /\ Inv_AcceptedCancelWins /\ Inv_EndedBeforeBegin
    /\ Inv_NoSelfNotice /\ Inv_EndNamesRequester /\ Inv_AttributionTruthful /\ Inv_NoticeEnabled
    /\ Inv_FallbackAfterEnd

(* A run that a requester other than the parent (an agent or a system       *)
(* actor) ended with its cancel.                                           *)
NonParentEnd == endKind \in {"beforeBegin", "cmd"} /\ endTruth \in NonParent

(* The parent is told of it (assumptions A5 and A6).                       *)
Live_OtherTold == NonParentEnd ~> notice

(* ... at least when the run's controller starts after a before-begin end  *)
(* (assumption A6; no repeat needed).                                      *)
Live_OtherToldOnceStarted == (endKind = "beforeBegin" /\ endTruth \in NonParent /\ inst # "none") ~> notice

(* A notification effect visibly failed for good: the notifier or the      *)
(* controller failed, or a cancel request returned an error to its caller.  *)
FailedVisibly == notifier = "failed" \/ inst = "failed" \/ \E r \in Reqs : req[r] = "error"

(* Without A6: the parent is told, a delivery recorded a skip (the parent's *)
(* authority was gone), or a notification visibly failed for good           *)
(* (assumption A5).                                                        *)
Live_OtherOutcomeVisible == NonParentEnd ~> (notice \/ skipped \/ FailedVisibly)

(***************************************************************************)
(* Witnesses: each is expected to be violated, which shows that its        *)
(* outcome is reachable.                                                   *)
(***************************************************************************)

(* A delivery recorded a skip, and the notifier completed.                 *)
Wit_SkipCompletes == ~(skipped /\ notifier = "done")

(* A request returned an error, and its repeat with the same operation id   *)
(* completed (checked without Interrupts, so a repeat follows an error).    *)
Wit_ErrorRepeated == ~(\E r \in Reqs : tries[r] = 2 /\ req[r] = "done")

(* The begin activity's notifier start failed for good, and the            *)
(* controller's failure path told the parent and completed.                *)
Wit_FallbackTells == ~(endKind = "beforeBegin" /\ notifier = "none" /\ notice /\ inst = "done")

(* The controller's failure path ran out too: the controller failed.       *)
Wit_FallbackFails == inst # "failed"

(* A recover's notifier start failed for good.                             *)
Wit_RecoverStartFails == rnotify # "error"

(* The notifier start of a begin activity whose controller ended failed     *)
(* for good.                                                               *)
Wit_ZombieStartLost == zBegin # "lost"

=============================================================================
