------------------------ MODULE WorkflowV2Lifecycle ------------------------
(***************************************************************************)
(* The start of a live workflow v2 run and the cancels that can come       *)
(* before its controller begins it, as packages/sdk/src/workflow/v2        *)
(* implements them in the commit of this file (README "Lifecycle model"):  *)
(* the dispatch after admission (it may be lost, and it skips a run that   *)
(* already ended), duroxide's start, the provider's drop of queue messages *)
(* for an instance that has not started, the controller's begin, the       *)
(* parent's recover, update_workflow cancel by the parent or by another    *)
(* requester (a service caller that is not the parent; not a production   *)
(* entry point), cancel receipts that an earlier build stored, and who is  *)
(* told that the run ended.                                                 *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS
    Cancellers,            \* who sends a cancel: a subset of {"parent", "other"}
    LegacyWriter,          \* requester of a cancel receipt an earlier build stored without ending the run: "none", "parent" (M1), "other" (M1 broken)
    CancelEndsBeforeBegin, \* fix 369beaf0: a cancel ends a run that has not begun in its own transaction, also on a repeat
    BeginHonorsReceipt,    \* fix 31dc9888: begin ends a run that has not begun and has an accepted cancel receipt
    C2Fix,                 \* fix b1d1d4b9: begin names the parent as that receipt's requester (M1) and starts the notifier for a requester that is not the parent; the parent's own cancel is not reported
    LoseDispatch,          \* fault: the controller start after admission never reaches duroxide
    DropOrphans,           \* the provider: duroxide-pg drops queue messages of an instance with no row and no history
    Interrupts,            \* fault: a cancel request stops after its commit; the begin activity runs again after its commit
    Repeats,               \* environment: a requester repeats an interrupted cancel with its operation id (assumption A5)
    Recovery,              \* the parent's recover of a run that needs it (assumption A3)
    ControllerDeath,       \* fault: the controller ends without ending its run
    MaxCrashes             \* begin activity re-executions

Reqs == {"parent", "other"}
ASSUME Cancellers \subseteq Reqs
ASSUME LegacyWriter \in Reqs \cup {"none"}
ASSUME {CancelEndsBeforeBegin, BeginHonorsReceipt, C2Fix, LoseDispatch, DropOrphans, Interrupts, Repeats,
        Recovery, ControllerDeath} \subseteq BOOLEAN
ASSUME MaxCrashes \in Nat

Active == {"admitted", "running"}
Terminal == {"completed", "cancelled", "failed"}
(* The legacy writer may repeat its earlier request.                       *)
Senders == Cancellers \cup {w \in Reqs : w = LegacyWriter}

VARIABLES
    status,           \* the run's status
    rcpt,             \* each requester's cancel receipt (one operation id each) is stored
    firstRcpt,        \* the requester of the earliest cancel receipt (begin's query)
    endKind,          \* how the run ended: "none", "finish", "beforeBegin", "cmd", "recover"
    endReq,           \* requestedBy in the run's end: a requester, "null", or "none"
    endTruth,         \* ghost: who actually asked for the cancel that ended the run
    endOp,            \* whose operation id the run's before-begin end records
    acceptedNotBegun, \* ghost: a cancel was accepted while the run had not begun
    dispatch,         \* the dispatch after admission: "pending", "sent", "skipped", "lost"
    rdispatch,        \* a recover dispatched the run
    inst,             \* the controller instance: "none" (NotFound), "begin", "beginNotify", "run", "done"
    q,                \* cancel commands queued for the controller instance, by requester
    req,              \* each requester's cancel request: "idle", "committed", "done"
    tries,            \* requests each requester sent (the first and a repeat)
    notifier,         \* the notifier orchestration: "none", "started", "done"
    notice,           \* the parent was told that the run ended
    selfNotice,       \* ghost: the parent was told of a cancel it asked for itself
    crashes

endVars == <<endKind, endReq, endTruth, endOp>>
storeVars == <<status, rcpt, firstRcpt, endVars, acceptedNotBegun>>
ctlVars == <<dispatch, rdispatch, inst, q, crashes>>
reqVars == <<req, tries>>
noteVars == <<notifier, notice, selfNotice>>
vars == <<storeVars, ctlVars, reqVars, noteVars>>

TypeOK ==
    /\ status \in Active \cup Terminal
    /\ rcpt \in [Reqs -> BOOLEAN]
    /\ firstRcpt \in Reqs \cup {"none"}
    /\ endKind \in {"none", "finish", "beforeBegin", "cmd", "recover"}
    /\ endReq \in Reqs \cup {"none", "null"}
    /\ endTruth \in Reqs \cup {"none"}
    /\ endOp \in Reqs \cup {"none"}
    /\ acceptedNotBegun \in BOOLEAN
    /\ dispatch \in {"pending", "sent", "skipped", "lost"}
    /\ rdispatch \in BOOLEAN
    /\ inst \in {"none", "begin", "beginNotify", "run", "done"}
    /\ q \in SUBSET Reqs
    /\ req \in [Reqs -> {"idle", "committed", "done"}]
    /\ tries \in [Reqs -> 0..2]
    /\ notifier \in {"none", "started", "done"}
    /\ notice \in BOOLEAN
    /\ selfNotice \in BOOLEAN
    /\ crashes \in 0..MaxCrashes

(* An earlier build stored LegacyWriter's cancel receipt and queued its     *)
(* command, which the provider dropped: the run is still admitted.          *)
Init ==
    /\ status = "admitted"
    /\ rcpt = [r \in Reqs |-> r = LegacyWriter]
    /\ firstRcpt = LegacyWriter
    /\ endKind = "none" /\ endReq = "none" /\ endTruth = "none" /\ endOp = "none"
    /\ acceptedNotBegun = (LegacyWriter # "none")
    /\ dispatch = "pending" /\ rdispatch = FALSE /\ inst = "none" /\ q = {}
    /\ req = [r \in Reqs |-> "idle"]
    /\ tries = [r \in Reqs |-> IF r = LegacyWriter THEN 1 ELSE 0]
    /\ notifier = "none" /\ notice = FALSE /\ selfNotice = FALSE /\ crashes = 0

(* V dispatchWorkflowV2Run after admission: it starts the controller of a  *)
(* run that is still active, and skips one that already ended.              *)
DispatchSend ==
    /\ dispatch = "pending"
    /\ dispatch' = IF status \in Active THEN "sent" ELSE "skipped"
    /\ UNCHANGED <<storeVars, rdispatch, inst, q, crashes, reqVars, noteVars>>

DispatchLose ==
    /\ LoseDispatch
    /\ dispatch = "pending"
    /\ dispatch' = "lost"
    /\ UNCHANGED <<storeVars, rdispatch, inst, q, crashes, reqVars, noteVars>>

(* duroxide processes a start (the dispatch's or a recover's): the instance *)
(* has a row and history now; a second start is ignored.                   *)
Start ==
    /\ inst = "none"
    /\ dispatch = "sent" \/ rdispatch
    /\ inst' = "begin"
    /\ UNCHANGED <<storeVars, dispatch, rdispatch, q, crashes, reqVars, noteVars>>

(* duroxide-pg acknowledges, and so deletes, the queue messages it fetches  *)
(* for an instance with no row and no history.                              *)
OrphanDrop ==
    /\ DropOrphans
    /\ inst = "none"
    /\ q # {}
    /\ q' = {}
    /\ UNCHANGED <<storeVars, dispatch, rdispatch, inst, crashes, reqVars, noteVars>>

(* S beginRun: a run that has not begun and has an accepted cancel receipt  *)
(* (the earliest) is ended as cancelled, before it began; its requester is  *)
(* the parent (C2Fix, migration assumption M1) or null (31dc9888).          *)
Repair == BeginHonorsReceipt /\ status = "admitted" /\ firstRcpt # "none"

BeginTx ==
    /\ inst = "begin"
    /\ status' = CASE Repair -> "cancelled"
                   [] status = "admitted" -> "running"
                   [] OTHER -> status
    /\ endKind' = IF Repair THEN "beforeBegin" ELSE endKind
    /\ endReq' = IF Repair THEN (IF C2Fix THEN "parent" ELSE "null") ELSE endReq
    /\ endTruth' = IF Repair THEN firstRcpt ELSE endTruth
    /\ endOp' = IF Repair THEN firstRcpt ELSE endOp
    /\ inst' = "beginNotify"
    /\ UNCHANGED <<rcpt, firstRcpt, acceptedNotBegun, dispatch, rdispatch, q, crashes, reqVars, noteVars>>

(* The begin activity after its commit: with C2Fix it starts the notifier   *)
(* for a run that a cancel ended before it began, unless the run's end      *)
(* names the parent; the controller runs an active run and ends otherwise.  *)
BeginTells == C2Fix /\ status = "cancelled" /\ endKind = "beforeBegin" /\ endReq # "parent"

BeginNotify ==
    /\ inst = "beginNotify"
    /\ notifier' = IF BeginTells /\ notifier = "none" THEN "started" ELSE notifier
    /\ inst' = IF status \in Active THEN "run" ELSE "done"
    /\ UNCHANGED <<storeVars, dispatch, rdispatch, q, crashes, reqVars, notice, selfNotice>>

(* The begin activity runs again after its commit (a worker crash).         *)
BeginRetry ==
    /\ Interrupts
    /\ inst = "beginNotify"
    /\ crashes < MaxCrashes
    /\ inst' = "begin"
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<storeVars, dispatch, rdispatch, q, reqVars, noteVars>>

(* R notifyParent: the parent is told unless the requester that the run's   *)
(* end names is the parent: the command's requester, or, with C2Fix, the    *)
(* recorded or attributed requester of a before-begin end.                  *)
Tells(arg) ==
    (IF arg # "none" THEN arg ELSE IF C2Fix /\ endKind = "beforeBegin" THEN endReq ELSE "null") # "parent"

(* The controller reads a queued cancel (its first poll follows begin), the *)
(* cancel activity ends the run, and it notifies with the requester.        *)
ApplyCmd ==
    /\ inst = "run"
    /\ status = "running"
    /\ \E r \in q :
        /\ status' = "cancelled"
        /\ endKind' = "cmd"
        /\ endReq' = r
        /\ endTruth' = r
        /\ q' = q \ {r}
        /\ notice' = (notice \/ Tells(r))
    /\ inst' = "done"
    /\ UNCHANGED <<rcpt, firstRcpt, endOp, acceptedNotBegun, dispatch, rdispatch, crashes, reqVars, notifier, selfNotice>>

(* The run's own work ends it (abstracted); reportEnded tells the parent.  *)
RunFinish ==
    /\ inst = "run"
    /\ status = "running"
    /\ status' = "completed"
    /\ endKind' = "finish"
    /\ notice' = TRUE
    /\ inst' = "done"
    /\ UNCHANGED <<rcpt, firstRcpt, endReq, endTruth, endOp, acceptedNotBegun, dispatch, rdispatch, q, crashes,
                   reqVars, notifier, selfNotice>>

(* V controlWorkflowV2Run cancel and S recordRunCancelRequest, one          *)
(* transaction: the receipt and, with CancelEndsBeforeBegin, the end of a   *)
(* run that has not begun (a repeat of an accepted cancel too, with the     *)
(* repeat's requester). Earlier builds stored the receipt only.            *)
EndsNow == CancelEndsBeforeBegin /\ status = "admitted"

CancelTx(r) ==
    /\ r \in Senders
    /\ req[r] = "idle"
    /\ tries[r] < (IF Repeats THEN 2 ELSE 1)
    /\ status' = IF EndsNow THEN "cancelled" ELSE status
    /\ endKind' = IF EndsNow THEN "beforeBegin" ELSE endKind
    /\ endReq' = IF EndsNow THEN r ELSE endReq
    /\ endTruth' = IF EndsNow THEN r ELSE endTruth
    /\ endOp' = IF EndsNow THEN r ELSE endOp
    /\ rcpt' = [rcpt EXCEPT ![r] = TRUE]
    /\ firstRcpt' = IF firstRcpt = "none" THEN r ELSE firstRcpt
    /\ acceptedNotBegun' = (acceptedNotBegun \/ (~rcpt[r] /\ status = "admitted"))
    /\ req' = [req EXCEPT ![r] = "committed"]
    /\ tries' = [tries EXCEPT ![r] = tries[r] + 1]
    /\ UNCHANGED <<dispatch, rdispatch, inst, q, crashes, noteVars>>

(* After the commit: an active run's controller gets the command (V         *)
(* enqueueEvent, a repeat too); for a run this request's operation ended    *)
(* before it began, V notifyCancelledBeforeBegin starts the notifier unless *)
(* the end names the parent (and, with C2Fix, unless the parent asks).      *)
FollowTells(r) ==
    /\ status = "cancelled"
    /\ endKind = "beforeBegin"
    /\ endOp = r
    /\ endReq # "parent"
    /\ ~(C2Fix /\ r = "parent")

CancelFollow(r) ==
    /\ req[r] = "committed"
    /\ q' = IF status \in Active THEN q \cup {r} ELSE q
    /\ notifier' = IF FollowTells(r) /\ notifier = "none" THEN "started" ELSE notifier
    /\ req' = [req EXCEPT ![r] = "done"]
    /\ UNCHANGED <<storeVars, dispatch, rdispatch, inst, crashes, tries, notice, selfNotice>>

(* The first request stops after its commit (A5: its repeat completes).    *)
CancelInterrupt(r) ==
    /\ Interrupts
    /\ req[r] = "committed"
    /\ tries[r] = 1
    /\ req' = [req EXCEPT ![r] = "idle"]
    /\ UNCHANGED <<storeVars, ctlVars, tries, noteVars>>

(* V recoverWorkflowV2Run: a run that has not begun and has no controller   *)
(* instance is dispatched again (its receipt first); an active run whose    *)
(* controller ended is ended as failed, and the notifier starts.           *)
RecoverDispatch ==
    /\ Recovery
    /\ inst = "none"
    /\ status = "admitted"
    /\ ~rdispatch
    /\ rdispatch' = TRUE
    /\ UNCHANGED <<storeVars, dispatch, inst, q, crashes, reqVars, noteVars>>

RecoverEnd ==
    /\ Recovery
    /\ inst = "done"
    /\ status \in Active
    /\ status' = "failed"
    /\ endKind' = "recover"
    /\ notifier' = IF notifier = "none" THEN "started" ELSE notifier
    /\ UNCHANGED <<rcpt, firstRcpt, endReq, endTruth, endOp, acceptedNotBegun, ctlVars, reqVars, notice, selfNotice>>

(* The controller ends without ending its run (before or after begin).      *)
CtrlDie ==
    /\ ControllerDeath
    /\ inst \in {"begin", "run"}
    /\ inst' = "done"
    /\ UNCHANGED <<storeVars, dispatch, rdispatch, q, crashes, reqVars, noteVars>>

(* The notifier orchestration runs notifyParent with no requester.          *)
NotifierRun ==
    /\ notifier = "started"
    /\ notifier' = "done"
    /\ notice' = (notice \/ Tells("none"))
    /\ selfNotice' = (selfNotice \/ (Tells("none") /\ endKind \in {"beforeBegin", "cmd"} /\ endTruth = "parent"))
    /\ UNCHANGED <<storeVars, ctlVars, reqVars>>

Next ==
    \/ DispatchSend \/ DispatchLose \/ Start \/ OrphanDrop
    \/ BeginTx \/ BeginNotify \/ BeginRetry \/ ApplyCmd \/ RunFinish
    \/ \E r \in Reqs : (CancelTx(r) \/ CancelFollow(r) \/ CancelInterrupt(r))
    \/ RecoverDispatch \/ RecoverEnd \/ CtrlDie \/ NotifierRun

(* Weak fairness of the dispatch, duroxide, the controller, the request's   *)
(* follow-up, the notifier, recover (A3) and the repeat of an interrupted   *)
(* request (A5). The first cancel, the faults and the drop are not fair.    *)
Fairness ==
    /\ WF_vars(DispatchSend) /\ WF_vars(Start) /\ WF_vars(BeginTx) /\ WF_vars(BeginNotify)
    /\ WF_vars(ApplyCmd) /\ WF_vars(RunFinish) /\ WF_vars(NotifierRun)
    /\ WF_vars(RecoverDispatch) /\ WF_vars(RecoverEnd)
    /\ \A r \in Reqs : WF_vars(CancelFollow(r))
    /\ \A r \in Reqs : WF_vars(tries[r] = 1 /\ CancelTx(r))

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)

(* A cancel accepted before the run began wins: the run never runs (C1).   *)
Inv_AcceptedCancelWins == acceptedNotBegun => status \notin {"running", "completed"}

(* The parent is never told of a cancel it asked for (C2).                 *)
Inv_NoSelfNotice == ~selfNotice

(* A before-begin end always names its requester (recorded or attributed). *)
Inv_EndNamesRequester == endKind = "beforeBegin" => endReq # "null"

(* The named requester is the actual one: this holds under M1 only.        *)
Inv_AttributionTruthful == endKind = "beforeBegin" => endReq = endTruth

LifecycleSafety ==
    TypeOK /\ Inv_AcceptedCancelWins /\ Inv_NoSelfNotice /\ Inv_EndNamesRequester /\ Inv_AttributionTruthful

(* The parent is told of a run that another requester's cancel ended.      *)
Live_OtherTold == (endKind \in {"beforeBegin", "cmd"} /\ endTruth = "other") ~> notice

(* ... at least when the run's controller starts after that end.           *)
Live_OtherToldOnceStarted == (endKind = "beforeBegin" /\ endTruth = "other" /\ inst # "none") ~> notice

=============================================================================
