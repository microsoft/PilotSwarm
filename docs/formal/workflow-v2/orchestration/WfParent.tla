------------------------------ MODULE WfParent ------------------------------
(***************************************************************************)
(* r2. A workflow and its parent agent session: what the parent LLM is   *)
(* given from one run, and in which order. The run has one send or       *)
(* request state whose message goes to the parent (MKind), then ends: by *)
(* its own controller, by another end (a cancel from someone else, a     *)
(* stop, the run's deadline), or by the parent's own cancel. Its end is  *)
(* told by the notifyParent activity (default on; a skip is recorded).   *)
(*                                                                         *)
(* Code: "efe44835" and "1c117a47" behave the same here (groups A-C did  *)
(* not change these paths); "1f7bdc77" is the final head with group D as  *)
(* committed (WFO-1, WFO-3, WFO-4); "proposedD" is the comparison: the    *)
(* fixes this review first proposed; "proposedE3" is 1f7bdc77 with the   *)
(* batch E3 changes (the count includes rows decided after a recent       *)
(* attempt; a per-run notifier lock; a marker plus a refusal records a    *)
(* skip with earlierAttempt).                                              *)
(* r2c adds a zombie enqueue (an attempt still inside its enqueue while   *)
(* the activity is retried) and a second notifier instance (a recover    *)
(* variant), from the verification of group D.                            *)
(* r2e adds "a10c2e07", batch E3 as committed: the wait (15 s) runs      *)
(* before the run's notice lock and only with notifications on; the lock  *)
(* is a try-lock (an attempt that finds it held returns and records       *)
(* nothing); under it the notice is read again, the marker, the enqueue   *)
(* and the record follow; a known refusal after a marker is a skip with  *)
(* earlierAttempt. AllowNtZombie: an attempt whose activity timed out    *)
(* keeps running and keeps the lock (process 3) while the runtime retries *)
(* it. AllowRecover: update_workflow recover starts the notifier again   *)
(* while the notice is owed. AllowStatusRace FALSE makes the worker's     *)
(* status read and the enqueue one step (to isolate D-R1).                *)
(* r2g adds "fc6d7a65" (E3b): an attempt that finds the lock held fails  *)
(* and the activity runs again (it no longer returns), and                *)
(* RecoverAfterRelease (a recover is made only while no attempt holds the *)
(* lock: after a holder failed).                                           *)
(*                                                                         *)
(* Only the prompt path is live: a send is a WORKFLOW_UPDATE prompt        *)
(* (legacy_window). The durable intake (claim, bind, expose, settle) is  *)
(* INACTIVE at both heads: no worker sets workflowIntake (runtime.ts      *)
(* WorkflowV2RuntimeDeps.workflowIntake). r2 splits the parent into its   *)
(* transport queue (pq), its stored FIFO (fifo; the id is marked recent   *)
(* when stored) and the model's exposure (seen); a turn can fail or be    *)
(* regenerated before its model call and keep its items (fidelity FR-17).*)
(* A request is answerable while its state is pending, before its         *)
(* delivery is recorded (MF-1, FR-4). The store's clock (storeLate) and  *)
(* the elapse (timed_out) are separate, and an expired answer binds the   *)
(* request's expiry durably (expiredBound).                               *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    MKind,             \* "send" or "request"
    StartFlag,         \* notify_on_completion at the live start: "omitted", "true", "false"
    MaxCrashes,        \* worker crashes in each activity
    AllowExternalEnd,  \* a cancel by someone else, a stop or the run's deadline ends the run
    AllowParentCancel, \* the parent cancels the run itself
    AllowParentEnd,    \* the parent session ends or is deleted while the run lives
    AllowFifoFull,     \* the parent's FIFO is full when a message arrives
    AllowEvict,        \* 20 other messages reach the parent between two copies
    AllowClockBack,    \* the store's clock steps back after it passed the deadline
    MaxTurnFails,      \* parent turns that fail or are regenerated before their model call
    Fault,             \* "none", "no_prior_check", "no_window", "no_durable_expiry"
    AllowWaitTimeout,  \* 1f7bdc77: the notifier's bounded wait (20 s) gives up while a delivery is in flight
    AllowZombie,       \* a delivery attempt is still inside its enqueue when the runtime retries the activity
    NumNotifiers,      \* notifier instances for the run: 1, or 2 (a recover variant runs concurrently)
    AllowStatusRace,   \* the parent can end between the worker's status read and the enqueue (WFO-3)
    AllowNtZombie,     \* a10c2e07: a notifier attempt that timed out keeps running and holds the lock
    AllowRecover,      \* a10c2e07: recover starts the notifier again (instance 2) while the notice is owed
    MaxRecovers,
    RecoverAfterRelease, \* a recover is made only while no attempt holds the run's notice lock
    Code               \* "efe44835", "1c117a47", "1f7bdc77", "proposedD", "proposedE3", "a10c2e07", "fc6d7a65"

ASSUME MKind \in {"send", "request"} /\ StartFlag \in {"omitted", "true", "false"}
ASSUME Fault \in {"none", "no_prior_check", "no_window", "no_durable_expiry"}
ASSUME Code \in {"efe44835", "1c117a47", "1f7bdc77", "proposedD", "proposedE3", "a10c2e07", "fc6d7a65"} /\ NumNotifiers \in {1, 2}
ASSUME AllowRecover => (Code \in {"a10c2e07", "fc6d7a65"} /\ NumNotifiers = 2)
ASSUME AllowNtZombie => Code \in {"a10c2e07", "fc6d7a65"}
NONE == "none"
Ids == {"M", "E"}   \* the state's message (its exchange id) and the run's end ("...:terminal")
FixD == Code = "proposedD"
D1 == Code \in {"1f7bdc77", "proposedE3"}   \* group D as committed (E3 builds on it)
E3 == Code = "proposedE3"
A10 == Code \in {"a10c2e07", "fc6d7a65"}   \* batch E3 as committed (and E3b on top of it)
E3B == Code = "fc6d7a65"                    \* E3b: a held lock fails the attempt, which runs again
E3L == E3 \/ A10                            \* the count of failed rows; the skip with earlierAttempt
NI == 1..NumNotifiers
Procs == IF AllowNtZombie THEN NI \cup {3} ELSE NI   \* 3: an attempt that timed out and keeps running

VARIABLES
    runSt,       \* "running", "ended"
    endBy,       \* NONE, "controller", "other", "parent"
    mNode,       \* the state: "pending", "awaiting" (a request delivered), "sent", "answered", "refused", "timed_out", "cancel"
    storeLate,   \* the store's clock is past the request's deadline (it can step back until an expiry is bound)
    expiredBound,\* an answer was refused REQUEST_EXPIRED: every later answer is expired too
    dl,          \* the delivery activity: "start", "begun", "enqueued", "done"
    dlCrashes,
    nt,          \* per notifier instance: "idle", "check", "authorize", "wait", "attempt", "status", "enqueue", "record", "done"
    ntCrashes,
    ntAttempted, \* proposedD and 1f7bdc77: an enqueue attempt is recorded before the enqueue (WFO-4; 1f7bdc77 parent_notifying)
    ntSaw,       \* per instance, 1f7bdc77: its attempt found an earlier attempt recorded (runNoticeAttempted, read at its start)
    ob,          \* the outbox message: "pending", "delivered", "failed"
    obAttempted, \* a delivery attempt was counted (attempts > 0, last_attempt_at) in the begin's transaction
    obRecent,    \* proposedE3: the row was decided after a recent attempt began, and is still counted
    zombie,      \* an earlier attempt's enqueue of M is still running
    evNotified, evSkipped, evUnconfirmed, evByEarlier, evSkipEarlier,   \* events (evByEarlier: parent_notified byEarlierAttempt; evSkipEarlier: E3 skip with earlierAttempt)
    pLive,       \* the parent's orchestration runs
    pRow,        \* the parent's catalog row says it is live
    pq,          \* the parent's transport queue (ids)
    fifo,        \* the parent's stored, not yet exposed items
    window,      \* the parent's recent client message ids (marked when stored)
    seen,        \* what the parent's model was given, in order
    turnFails,
    \* history
    lost,        \* ids of which a copy was queued and never stored (per copy, not per id)
    eAccepted,   \* a copy of the end was queued to a running parent orchestration
    lateAnswer,  \* NONE, "expired" or "closed": why the parent's answer was refused
    answeredEarly,\* the answer was accepted before the delivery was recorded
    holder,      \* a10c2e07: the process that holds the run's notice lock (0: none)
    recovers     \* a10c2e07: recover calls

vars == <<runSt, endBy, mNode, storeLate, expiredBound, dl, dlCrashes, nt, ntCrashes, ntAttempted, ntSaw, ob, obAttempted, obRecent, zombie,
          evNotified, evSkipped, evUnconfirmed, evByEarlier, evSkipEarlier, pLive, pRow, pq, fifo, window, seen, turnFails,
          lost, eAccepted, lateAnswer, answeredEarly, holder, recovers>>
lockVars == <<holder, recovers>>
clockVars == <<storeLate, expiredBound>>
obVars == <<ob, obAttempted, obRecent, zombie>>
evVars == <<evNotified, evSkipped, evUnconfirmed, evByEarlier, evSkipEarlier>>
parentVars == <<pLive, pRow, pq, fifo, window, seen, turnFails>>
histVars == <<lost, eAccepted, lateAnswer, answeredEarly>>

NotifyOn == StartFlag # "false"
Decided == mNode \in {"sent", "answered", "refused", "timed_out", "cancel"}
Range(s) == {s[i] : i \in 1..Len(s)}

Init ==
    /\ runSt = "running" /\ endBy = NONE /\ mNode = "pending"
    /\ storeLate = FALSE /\ expiredBound = FALSE
    /\ dl = "start" /\ dlCrashes = 0 /\ nt = [i \in Procs |-> "idle"] /\ ntCrashes = 0 /\ ntAttempted = FALSE
    /\ ntSaw = [i \in Procs |-> FALSE] /\ holder = 0 /\ recovers = 0
    /\ ob = "pending" /\ obAttempted = FALSE /\ obRecent = FALSE /\ zombie = FALSE
    /\ evNotified = FALSE /\ evSkipped = FALSE /\ evUnconfirmed = FALSE /\ evByEarlier = FALSE /\ evSkipEarlier = FALSE
    /\ pLive = TRUE /\ pRow = TRUE
    /\ pq = <<>> /\ fifo = <<>> /\ window = {} /\ seen = <<>> /\ turnFails = 0
    /\ lost = {} /\ eAccepted = FALSE /\ lateAnswer = NONE /\ answeredEarly = FALSE

(* An enqueue to the parent's session orchestration: queued only while it *)
(* runs; queued to an ended one, the copy is never stored.                *)
Enqueue(id) ==
    IF pLive THEN /\ pq' = Append(pq, id) /\ UNCHANGED lost
    ELSE /\ lost' = lost \cup {id} /\ UNCHANGED pq

----------------------------------------------------------------------------
(* The delivery of the state's message (workflowV2Send / RequestDelivery).*)
(* The begin counts the attempt (attempts + 1, last_attempt_at) in its   *)
(* transaction; a begin that finds the state decided fails the message.   *)
DlBegin ==
    /\ dl = "start"
    /\ IF mNode = "pending" /\ runSt = "running"
         THEN IF pLive
                THEN dl' = "begun" /\ obAttempted' = TRUE /\ UNCHANGED <<mNode, ob, obRecent>>
                ELSE dl' = "done" /\ mNode' = "refused" /\ ob' = "failed" /\ UNCHANGED <<obAttempted, obRecent>>
         ELSE /\ dl' = "done" /\ UNCHANGED <<mNode, obAttempted>>
              /\ ob' = IF ob = "pending" THEN "failed" ELSE ob
              /\ obRecent' = (obRecent \/ (ob = "pending" /\ obAttempted))
    /\ UNCHANGED <<runSt, endBy, clockVars, dlCrashes, zombie, nt, ntCrashes, ntAttempted, ntSaw, evVars, parentVars, histVars, lockVars>>

(* The enqueue (stable client message id), outside the begin's transaction.*)
DlEnqueue ==
    /\ dl = "begun"
    /\ Enqueue("M")
    /\ dl' = "enqueued"
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dlCrashes, obVars, nt, ntCrashes, ntAttempted, ntSaw, evVars,
                   pLive, pRow, fifo, window, seen, turnFails, eAccepted, lateAnswer, answeredEarly, lockVars>>

(* recordDelivery: a send is decided sent; a request awaits its response. *)
DlRecord ==
    /\ dl = "enqueued"
    /\ mNode' = IF mNode = "pending" THEN (IF MKind = "send" THEN "sent" ELSE "awaiting") ELSE mNode
    /\ ob' = IF ob = "pending" THEN "delivered" ELSE ob
    /\ obRecent' = (obRecent \/ ob = "pending")
    /\ dl' = "done"
    /\ UNCHANGED <<runSt, endBy, clockVars, dlCrashes, obAttempted, zombie, nt, ntCrashes, ntAttempted, ntSaw, evVars, parentVars, histVars, lockVars>>

DlCrash ==
    /\ dl \in {"begun", "enqueued"} /\ dlCrashes < MaxCrashes
    /\ dl' = "start" /\ dlCrashes' = dlCrashes + 1
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, obVars, nt, ntCrashes, ntAttempted, ntSaw, evVars, parentVars, histVars, lockVars>>

(* An attempt still inside its (slow) enqueue while the runtime retries   *)
(* the activity: its enqueue of M lands later (once).                     *)
DlZombie ==
    /\ AllowZombie /\ dl = "begun" /\ ~zombie /\ dlCrashes < MaxCrashes
    /\ zombie' = TRUE /\ dl' = "start" /\ dlCrashes' = dlCrashes + 1
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, ob, obAttempted, obRecent, nt, ntCrashes, ntAttempted, ntSaw, evVars, parentVars, histVars, lockVars>>

ZombieLands ==
    /\ zombie
    /\ Enqueue("M")
    /\ zombie' = FALSE
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, ob, obAttempted, obRecent, nt, ntCrashes, ntAttempted, ntSaw, evVars,
                   pLive, pRow, fifo, window, seen, turnFails, eAccepted, lateAnswer, answeredEarly, lockVars>>

(* proposedE3: a decided row stops being counted when its attempt is no  *)
(* longer recent. Within the bound (no AllowWaitTimeout) an enqueue still *)
(* running lands first.                                                    *)
AgeOut ==
    /\ obRecent /\ (~zombie \/ AllowWaitTimeout)
    /\ obRecent' = FALSE
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, ob, obAttempted, zombie, nt, ntCrashes, ntAttempted, ntSaw, evVars, parentVars, histVars, lockVars>>

(* The store's clock passes the request's deadline; it can step back     *)
(* (clock_timestamp() is not monotonic); a bound expiry stands.           *)
RequestClock ==
    /\ MKind = "request" /\ ~storeLate
    /\ storeLate' = TRUE
    /\ UNCHANGED <<runSt, endBy, mNode, expiredBound, dl, dlCrashes, obVars, nt, ntCrashes, ntAttempted, ntSaw, evVars, parentVars, histVars, lockVars>>

ClockBack ==
    /\ AllowClockBack /\ storeLate /\ mNode \in {"pending", "awaiting"}
    /\ storeLate' = FALSE
    /\ UNCHANGED <<runSt, endBy, mNode, expiredBound, dl, dlCrashes, obVars, nt, ntCrashes, ntAttempted, ntSaw, evVars, parentVars, histVars, lockVars>>

(* The controller's elapse: the store decides timed_out by its clock.     *)
RequestDeadline ==
    /\ MKind = "request" /\ runSt = "running" /\ mNode \in {"pending", "awaiting"}
    /\ storeLate \/ expiredBound
    /\ mNode' = "timed_out"
    /\ UNCHANGED <<runSt, endBy, clockVars, dl, dlCrashes, obVars, nt, ntCrashes, ntAttempted, ntSaw, evVars, parentVars, histVars, lockVars>>

----------------------------------------------------------------------------
(* The run's ends: a pending state is cancelled; notifyParent starts.     *)
EndRun(by) ==
    /\ runSt = "running"
    /\ runSt' = "ended" /\ endBy' = by
    /\ mNode' = IF mNode \in {"pending", "awaiting"} THEN "cancel" ELSE mNode
    /\ nt' = [nt EXCEPT ![1] = "check"]

ControllerEnds ==
    /\ Decided /\ mNode # "cancel"
    /\ EndRun("controller")
    /\ UNCHANGED <<clockVars, dl, dlCrashes, obVars, ntCrashes, ntAttempted, ntSaw, evVars, parentVars, histVars, lockVars>>

ExternalEnd ==
    /\ AllowExternalEnd
    /\ EndRun("other")
    /\ UNCHANGED <<clockVars, dl, dlCrashes, obVars, ntCrashes, ntAttempted, ntSaw, evVars, parentVars, histVars, lockVars>>

ParentCancels ==
    /\ AllowParentCancel /\ pLive
    /\ EndRun("parent")
    /\ UNCHANGED <<clockVars, dl, dlCrashes, obVars, ntCrashes, ntAttempted, ntSaw, evVars, parentVars, histVars, lockVars>>

----------------------------------------------------------------------------
(* notifyParent: nothing for the parent's own end; once per run (a prior  *)
(* notified or skipped event); off: skipped; authority gone: skipped;    *)
(* else the WORKFLOW_UPDATE type=ended prompt, then the notified event.  *)
(* proposedD: an attempt is recorded before the enqueue, and a retry      *)
(* after an attempt never records a skip (WFO-4); the parent              *)
(* orchestration's status is read after the enqueue, and an ended one is  *)
(* recorded as unconfirmed, not notified (WFO-3).                         *)
(* 1f7bdc77 (as committed): the attempt reads runNoticeAttempted at its   *)
(* start (ntSaw); a skip after an earlier attempt is recorded as          *)
(* parent_notified byEarlierAttempt (WFO-4); the activity waits, bounded, *)
(* while a delivery to the parent is in flight (WFO-1); it records        *)
(* parent_notifying once; the worker reads the parent orchestration's     *)
(* status, queues nothing for an ended one, and the skip follows (WFO-3); *)
(* the read and the enqueue are separate steps.                           *)
(* proposedE3: a skip after an earlier attempt is recorded as a skip with *)
(* earlierAttempt (evSkipEarlier), not as told.                            *)
Skip(sawEarlier) ==
    IF E3L /\ sawEarlier THEN evSkipEarlier' = TRUE /\ UNCHANGED <<evNotified, evSkipped, evUnconfirmed, evByEarlier>>
    ELSE IF D1 /\ sawEarlier THEN evByEarlier' = TRUE /\ UNCHANGED <<evNotified, evSkipped, evUnconfirmed, evSkipEarlier>>
    ELSE evSkipped' = TRUE /\ UNCHANGED <<evNotified, evUnconfirmed, evByEarlier, evSkipEarlier>>

Recorded == evNotified \/ evSkipped \/ evUnconfirmed \/ evByEarlier \/ evSkipEarlier
Mid == {"authorize", "wait", "attempt", "status", "enqueue", "record"}
\* proposedE3: the notifier is serialized per run (a lock held from its check to its end).
Locked(i) == E3 /\ \E j \in Procs : j # i /\ nt[j] \in Mid
SetNt(i, v) == nt' = [nt EXCEPT ![i] = v]

(* A second notifier instance for the run (a recover variant), started   *)
(* while the first may still run.                                          *)
NtStart2 ==
    /\ NumNotifiers = 2 /\ ~AllowRecover /\ runSt = "ended" /\ nt[2] = "idle"
    /\ SetNt(2, "check")
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, ntCrashes, ntAttempted, ntSaw, evVars, parentVars, histVars, lockVars>>

NtCheck(i) ==
    /\ ~A10 /\ nt[i] = "check" /\ ~Locked(i)
    /\ ntSaw' = [ntSaw EXCEPT ![i] = ntAttempted]
    /\ IF endBy = "parent"
         THEN SetNt(i, "done") /\ UNCHANGED evVars
       ELSE IF Recorded /\ Fault # "no_prior_check"
         THEN SetNt(i, "done") /\ UNCHANGED evVars
       ELSE IF ~NotifyOn
         THEN SetNt(i, "done") /\ Skip(ntAttempted)
       ELSE SetNt(i, "authorize") /\ UNCHANGED evVars
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, ntCrashes, ntAttempted, parentVars, histVars, lockVars>>

NtAuthorize(i) ==
    /\ ~A10 /\ nt[i] = "authorize"
    /\ IF pRow
         THEN SetNt(i, IF FixD THEN "attempt" ELSE IF D1 THEN "wait" ELSE "enqueue") /\ UNCHANGED evVars
       ELSE IF FixD /\ ntAttempted
         THEN SetNt(i, "done") /\ evUnconfirmed' = TRUE /\ UNCHANGED <<evNotified, evSkipped, evByEarlier, evSkipEarlier>>
       ELSE SetNt(i, "done") /\ Skip(ntSaw[i])
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, ntCrashes, ntAttempted, ntSaw, parentVars, histVars, lockVars>>

(* 1f7bdc77, WFO-1: store.runDeliveriesInFlight counts the run's sends    *)
(* and requests to the parent with state pending, attempts > 0 and a     *)
(* recent last attempt (proposedE3: also one decided after a recent       *)
(* attempt). The wait ends when none is left, or at its bound            *)
(* (AllowWaitTimeout: 20 s, E3 15 s, or the attempt began over 60 s ago). *)
InFlight == obAttempted /\ (ob = "pending" \/ (E3L /\ obRecent))
NtWait(i) ==
    /\ ~A10 /\ nt[i] = "wait"
    /\ ~InFlight \/ AllowWaitTimeout
    /\ SetNt(i, "attempt")
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, ntCrashes, ntAttempted, ntSaw, evVars, parentVars, histVars, lockVars>>

NtAttempt(i) ==
    /\ ~A10 /\ nt[i] = "attempt"
    /\ ntAttempted' = TRUE /\ SetNt(i, IF D1 THEN "status" ELSE "enqueue")
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, ntCrashes, ntSaw, evVars, parentVars, histVars, lockVars>>

(* 1f7bdc77, WFO-3: the worker reads the parent orchestration's status;   *)
(* NotFound, Completed, Failed or Terminated: nothing is queued.          *)
NtStatus(i) ==
    /\ ~A10 /\ nt[i] = "status"
    /\ IF pLive THEN SetNt(i, "enqueue") /\ UNCHANGED evVars
       ELSE SetNt(i, "done") /\ Skip(ntSaw[i])
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, ntCrashes, ntAttempted, ntSaw, parentVars, histVars, lockVars>>

NtEnqueue(i) ==
    /\ ~A10 /\ nt[i] = "enqueue"
    /\ Enqueue("E")
    /\ eAccepted' = (eAccepted \/ pLive)
    /\ SetNt(i, "record")
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, ntCrashes, ntAttempted, ntSaw, evVars,
                   pLive, pRow, fifo, window, seen, turnFails, lateAnswer, answeredEarly, lockVars>>

Told == IF FixD /\ ~pLive
          THEN evUnconfirmed' = TRUE /\ UNCHANGED <<evNotified, evSkipped, evByEarlier, evSkipEarlier>>
          ELSE evNotified' = TRUE /\ UNCHANGED <<evUnconfirmed, evSkipped, evByEarlier, evSkipEarlier>>

NtRecord(i) ==
    /\ ~A10 /\ nt[i] = "record"
    /\ Told
    /\ SetNt(i, "done")
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, ntCrashes, ntAttempted, ntSaw, parentVars, histVars, lockVars>>

(* A crash before the next step, or after the record committed and      *)
(* before the activity's completion was recorded: the activity runs again *)
(* (a crash of the second instance ends it: its recover call failed).     *)
NtCrash(i) ==
    /\ ~A10 /\ nt[i] \in Mid /\ ntCrashes < MaxCrashes
    /\ SetNt(i, IF i = 1 THEN "check" ELSE "done") /\ ntCrashes' = ntCrashes + 1
    /\ \E committed \in BOOLEAN : IF nt[i] = "record" /\ committed THEN Told ELSE UNCHANGED evVars
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, ntAttempted, ntSaw, parentVars, histVars, lockVars>>

(* a10c2e07 (batch E3 as committed). The other variables of each step.  *)
NtOther == <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, ntCrashes, parentVars, histVars, recovers>>
NtOtherE == <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, ntCrashes, pLive, pRow, fifo, window, seen,
              turnFails, lateAnswer, answeredEarly, recovers>>
MidA == {"wait", "lock", "authorize", "attempt", "status", "enqueue", "record"}
Held == {"authorize", "attempt", "status", "enqueue", "record"}
Release(i) == holder' = IF holder = i THEN 0 ELSE holder

(* Nothing for the parent's own end; told or skipped already: nothing.   *)
(* With notifications on, the bounded wait comes first, before the lock.  *)
NtCheckA(i) ==
    /\ A10 /\ nt[i] = "check"
    /\ IF endBy = "parent" \/ Recorded THEN SetNt(i, "done") ELSE SetNt(i, IF NotifyOn THEN "wait" ELSE "lock")
    /\ UNCHANGED <<NtOther, ntAttempted, ntSaw, evVars, holder>>

NtWaitA(i) ==
    /\ A10 /\ nt[i] = "wait"
    /\ ~InFlight \/ AllowWaitTimeout
    /\ SetNt(i, "lock")
    /\ UNCHANGED <<NtOther, ntAttempted, ntSaw, evVars, holder>>

(* withRunNoticeLock: a try-lock. Held: return, record nothing. Under the *)
(* lock: read the notice again, then the marker of an earlier attempt;   *)
(* notifications off: the skip (with earlierAttempt after a marker).     *)
NtLockA(i) ==
    /\ A10 /\ nt[i] = "lock"
    /\ IF holder # 0 \/ Recorded
         THEN SetNt(i, IF E3B /\ holder # 0 /\ i # 3 THEN "check" ELSE "done") /\ UNCHANGED <<ntSaw, evVars, holder>>
       ELSE /\ ntSaw' = [ntSaw EXCEPT ![i] = ntAttempted]
            /\ IF ~NotifyOn
                 THEN SetNt(i, "done") /\ Skip(ntAttempted) /\ UNCHANGED holder
                 ELSE SetNt(i, "authorize") /\ holder' = i /\ UNCHANGED evVars
    /\ UNCHANGED <<NtOther, ntAttempted>>

NtAuthA(i) ==
    /\ A10 /\ nt[i] = "authorize"
    /\ IF pRow THEN SetNt(i, "attempt") /\ UNCHANGED <<evVars, holder>>
       ELSE SetNt(i, "done") /\ Skip(ntSaw[i]) /\ Release(i)
    /\ UNCHANGED <<NtOther, ntAttempted, ntSaw>>

NtAttemptA(i) ==
    /\ A10 /\ nt[i] = "attempt"
    /\ ntAttempted' = TRUE /\ SetNt(i, "status")
    /\ UNCHANGED <<NtOther, ntSaw, evVars, holder>>

NtStatusA(i) ==
    /\ A10 /\ nt[i] = "status"
    /\ IF pLive THEN SetNt(i, "enqueue") /\ UNCHANGED <<evVars, holder>>
       ELSE SetNt(i, "done") /\ Skip(ntSaw[i]) /\ Release(i)
    /\ UNCHANGED <<NtOther, ntAttempted, ntSaw>>

NtEnqueueA(i) ==
    /\ A10 /\ nt[i] = "enqueue"
    /\ Enqueue("E")
    /\ eAccepted' = (eAccepted \/ pLive)
    /\ SetNt(i, "record")
    /\ UNCHANGED <<NtOtherE, ntAttempted, ntSaw, evVars, holder>>

(* parent_notified only after this attempt queued the notice.            *)
NtRecordA(i) ==
    /\ A10 /\ nt[i] = "record"
    /\ evNotified' = TRUE /\ UNCHANGED <<evSkipped, evUnconfirmed, evByEarlier, evSkipEarlier>>
    /\ SetNt(i, "done") /\ Release(i)
    /\ UNCHANGED <<NtOther, ntAttempted, ntSaw>>

(* A crash, or a failure that the lock's finally releases: the lock goes  *)
(* with it, and the notifier's activity runs again. Process 3, an attempt *)
(* the runtime already gave up on, ends.                                  *)
NtCrashA(i) ==
    /\ A10 /\ nt[i] \in MidA /\ ntCrashes < MaxCrashes
    /\ SetNt(i, IF i = 3 THEN "done" ELSE "check") /\ ntCrashes' = ntCrashes + 1 /\ Release(i)
    /\ \E committed \in BOOLEAN :
         IF nt[i] = "record" /\ committed
           THEN evNotified' = TRUE /\ UNCHANGED <<evSkipped, evUnconfirmed, evByEarlier, evSkipEarlier>>
           ELSE UNCHANGED evVars
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, ntAttempted, ntSaw, parentVars, histVars, recovers>>

(* The activity attempt of instance 1 times out while it holds the lock: *)
(* it keeps running as process 3, and the runtime retries the activity.  *)
NtSplitA ==
    /\ A10 /\ AllowNtZombie /\ nt[3] = "idle" /\ holder = 1 /\ nt[1] \in Held
    /\ nt' = [nt EXCEPT ![3] = nt[1], ![1] = "check"]
    /\ ntSaw' = [ntSaw EXCEPT ![3] = ntSaw[1]] /\ holder' = 3
    /\ UNCHANGED <<NtOther, ntAttempted, evVars>>

(* update_workflow recover (1c117a47 and later): the run ended, its notice *)
(* is owed and its notifier orchestration ended: a notifier starts again. *)
RecoverA ==
    /\ A10 /\ AllowRecover /\ runSt = "ended" /\ endBy # "parent" /\ ~Recorded
    /\ ~RecoverAfterRelease \/ holder = 0
    /\ nt[1] = "done" /\ nt[2] \in {"idle", "done"} /\ recovers < MaxRecovers
    /\ SetNt(2, "check") /\ recovers' = recovers + 1
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, ntCrashes, ntAttempted, ntSaw, evVars,
                   parentVars, histVars, holder>>

NtStep(i) == NtCheck(i) \/ NtAuthorize(i) \/ NtWait(i) \/ NtAttempt(i) \/ NtStatus(i) \/ NtEnqueue(i) \/ NtRecord(i)
            \/ NtCheckA(i) \/ NtWaitA(i) \/ NtLockA(i) \/ NtAuthA(i) \/ NtAttemptA(i) \/ NtStatusA(i) \/ NtEnqueueA(i) \/ NtRecordA(i)

----------------------------------------------------------------------------
(* The parent session: its turn loop stores the next queued item (a       *)
(* duplicate of a recent or pending id is dropped; the id is marked when  *)
(* stored); a full FIFO refuses the copy without marking it.              *)
ParentStores ==
    /\ pLive /\ pq # <<>>
    /\ LET id == Head(pq) IN
       /\ pq' = Tail(pq)
       /\ IF (id \in window \/ id \in Range(fifo)) /\ Fault # "no_window"
            THEN UNCHANGED <<fifo, window>>
            ELSE /\ fifo' = Append(fifo, id) /\ window' = window \cup {id}
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, nt, ntCrashes, ntAttempted, ntSaw, evVars,
                   pLive, pRow, seen, turnFails, histVars, lockVars>>

ParentFifoFull ==
    /\ AllowFifoFull /\ pLive /\ pq # <<>>
    /\ lost' = lost \cup {Head(pq)}
    /\ pq' = Tail(pq)
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, nt, ntCrashes, ntAttempted, ntSaw, evVars,
                   pLive, pRow, fifo, window, seen, turnFails, eAccepted, lateAnswer, answeredEarly, lockVars>>

(* A turn fails or is regenerated before its model call: its items stay. *)
ParentTurnFails ==
    /\ pLive /\ fifo # <<>> /\ turnFails < MaxTurnFails
    /\ turnFails' = turnFails + 1
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, nt, ntCrashes, ntAttempted, ntSaw, evVars,
                   pLive, pRow, pq, fifo, window, seen, histVars, lockVars>>

(* The model is given the next stored item. A request it is given is      *)
(* answered: the store accepts while the state is pending (whether or not *)
(* its delivery was recorded) and its clock is before the deadline with  *)
(* no expiry bound; pending past it is REQUEST_EXPIRED (bound); a decided *)
(* state is REQUEST_CLOSED. proposedD: a workflow message of a run whose *)
(* end the parent was already given is dropped (WFO-1).                   *)
ParentExposes ==
    /\ pLive /\ fifo # <<>>
    /\ LET id == Head(fifo) IN
       /\ fifo' = Tail(fifo)
       /\ IF FixD /\ id = "M" /\ "E" \in Range(seen)
            THEN UNCHANGED <<seen, mNode, expiredBound, lateAnswer, answeredEarly>>
            ELSE /\ seen' = Append(seen, id)
                 /\ IF id = "M" /\ MKind = "request"
                      THEN IF mNode \in {"pending", "awaiting"}
                             THEN IF (Fault # "no_durable_expiry" /\ expiredBound) \/ storeLate
                                    THEN /\ lateAnswer' = "expired" /\ expiredBound' = TRUE
                                         /\ UNCHANGED <<mNode, answeredEarly>>
                                    ELSE /\ mNode' = "answered" /\ answeredEarly' = (dl # "done")
                                         /\ UNCHANGED <<lateAnswer, expiredBound>>
                             ELSE /\ lateAnswer' = "closed"
                                  /\ UNCHANGED <<mNode, expiredBound, answeredEarly>>
                      ELSE UNCHANGED <<mNode, expiredBound, lateAnswer, answeredEarly>>
    /\ UNCHANGED <<runSt, endBy, storeLate, dl, dlCrashes, obVars, nt, ntCrashes, ntAttempted, ntSaw, evVars,
                   pLive, pRow, pq, window, turnFails, lost, eAccepted, lockVars>>

ParentForgets ==
    /\ AllowEvict /\ \E id \in window : window' = window \ {id}
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, nt, ntCrashes, ntAttempted, ntSaw, evVars,
                   pLive, pRow, pq, fifo, seen, turnFails, histVars, lockVars>>

(* The parent session ends: queued and stored items are never exposed.    *)
ParentEnds ==
    /\ AllowParentEnd /\ pLive
    /\ (AllowStatusRace \/ \A i \in Procs : nt[i] # "enqueue")
    /\ pLive' = FALSE
    /\ lost' = lost \cup Range(pq)
    /\ pq' = <<>> /\ fifo' = <<>>
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, nt, ntCrashes, ntAttempted, ntSaw, evVars,
                   pRow, window, seen, turnFails, eAccepted, lateAnswer, answeredEarly, lockVars>>

ParentRowEnds ==
    /\ ~pLive /\ pRow
    /\ pRow' = FALSE
    /\ UNCHANGED <<runSt, endBy, mNode, clockVars, dl, dlCrashes, obVars, nt, ntCrashes, ntAttempted, ntSaw, evVars,
                   pLive, pq, fifo, window, seen, turnFails, histVars, lockVars>>

Done ==
    /\ runSt = "ended" /\ dl = "done" /\ ~zombie /\ nt[1] = "done" /\ (\A i \in Procs : nt[i] \in {"idle", "done"})
    /\ ((pq = <<>> /\ fifo = <<>>) \/ ~pLive)
    /\ UNCHANGED vars

Next ==
    \/ DlBegin \/ DlEnqueue \/ DlRecord \/ DlCrash \/ DlZombie \/ ZombieLands \/ AgeOut \/ RequestClock \/ ClockBack \/ RequestDeadline
    \/ ControllerEnds \/ ExternalEnd \/ ParentCancels
    \/ NtStart2 \/ NtSplitA \/ RecoverA \/ (\E i \in Procs : NtStep(i) \/ NtCrash(i) \/ NtCrashA(i))
    \/ ParentStores \/ ParentFifoFull \/ ParentTurnFails \/ ParentExposes \/ ParentForgets
    \/ ParentEnds \/ ParentRowEnds \/ Done

(* Fairness: workers run the activities; the controller ends the run once *)
(* its state is decided; the store's clock passes a request's deadline    *)
(* and the elapse follows; a live parent stores and exposes its items;    *)
(* a catalog row follows its session. Crashes, other ends, the parent's  *)
(* end, a full FIFO, clock steps back, failed turns and evictions are     *)
(* free choices (each bounded or a single step).                          *)
Fairness ==
    /\ WF_vars(DlBegin) /\ WF_vars(DlEnqueue) /\ WF_vars(DlRecord)
    /\ WF_vars(RequestClock) /\ WF_vars(RequestDeadline)
    /\ WF_vars(ControllerEnds)
    /\ \A i \in Procs : WF_vars(NtStep(i))
    /\ WF_vars(RecoverA)
    /\ WF_vars(ZombieLands) /\ WF_vars(AgeOut)
    /\ WF_vars(ParentStores) /\ WF_vars(ParentExposes) /\ WF_vars(ParentRowEnds)

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ Fairness

----------------------------------------------------------------------------
Count(id) == Cardinality({i \in 1..Len(seen) : seen[i] = id})

TypeOK ==
    /\ runSt \in {"running", "ended"}
    /\ endBy \in {NONE, "controller", "other", "parent"}
    /\ mNode \in {"pending", "awaiting", "sent", "answered", "refused", "timed_out", "cancel"}
    /\ storeLate \in BOOLEAN /\ expiredBound \in BOOLEAN
    /\ dl \in {"start", "begun", "enqueued", "done"}
    /\ nt \in [Procs -> {"idle", "check", "authorize", "wait", "lock", "attempt", "status", "enqueue", "record", "done"}]
    /\ holder \in {0} \cup Procs /\ recovers \in 0..MaxRecovers
    /\ ob \in {"pending", "delivered", "failed"} /\ obAttempted \in BOOLEAN /\ obRecent \in BOOLEAN /\ zombie \in BOOLEAN
    /\ ntSaw \in [Procs -> BOOLEAN] /\ evByEarlier \in BOOLEAN /\ evSkipEarlier \in BOOLEAN
    /\ dlCrashes \in 0..MaxCrashes /\ ntCrashes \in 0..MaxCrashes /\ turnFails \in 0..MaxTurnFails
    /\ ntAttempted \in BOOLEAN /\ evNotified \in BOOLEAN /\ evSkipped \in BOOLEAN /\ evUnconfirmed \in BOOLEAN
    /\ pLive \in BOOLEAN /\ pRow \in BOOLEAN
    /\ Range(pq) \subseteq Ids /\ Range(fifo) \subseteq Ids /\ Range(seen) \subseteq Ids
    /\ lost \subseteq Ids /\ window \subseteq Ids
    /\ eAccepted \in BOOLEAN /\ lateAnswer \in {NONE, "expired", "closed"} /\ answeredEarly \in BOOLEAN

(* Safety rules (desired contracts; PI-7).                                *)
(* The parent's model is never given a message of the run after its end. *)
Inv_EndedIsLast == \A i, j \in 1..Len(seen) : (seen[i] = "E" /\ seen[j] = "M") => j < i
(* The parent's model is given each message once.                          *)
Inv_GivenOnce == \A id \in Ids : Count(id) <= 1
(* A notified event means a copy of the end was queued to a running      *)
(* parent orchestration (accepted for reading, not yet read: FR-17).     *)
Inv_NotifiedAccepted == evNotified => eAccepted
(* A skip is recorded only for a parent that was not given the end.       *)
Inv_SkipMeansNotGiven == evSkipped => Count("E") = 0
(* At most one of told (notified, or 1f7bdc77's byEarlierAttempt),        *)
(* skipped and unconfirmed.                                                *)
ToldEv == evNotified \/ evByEarlier
SkipEv == evSkipped \/ evSkipEarlier
Inv_NotifiedXorSkipped == ~(ToldEv /\ SkipEv) /\ ~(ToldEv /\ evUnconfirmed) /\ ~(SkipEv /\ evUnconfirmed) /\ ~(evSkipped /\ evSkipEarlier)
(* Diagnostic (1f7bdc77, WFO-4): a byEarlierAttempt record also means a  *)
(* copy was accepted. Expected to break: parent_notifying is recorded    *)
(* before the enqueue, so a crash there and a parent that ends record     *)
(* "told" with nothing queued.                                             *)
Inv_ToldMeansAccepted == ToldEv => eAccepted
(* No answer is accepted once an expiry was bound (durable expiry).       *)
Inv_NoDecisionAfterExpiry == expiredBound => mNode # "answered"

(* Liveness: the parent's model is given the run's end, or the end is the *)
(* parent's own, or a skip is recorded, or the parent session ended.      *)
Prop_ParentLearnsEnd ==
    <>(runSt = "ended" /\ (endBy = "parent" \/ evSkipped \/ evSkipEarlier \/ Count("E") > 0 \/ ~pLive))

(* Witnesses, EXPECTED to be violated (reachable).                        *)
Wit_GivenMessageThenEnd == ~(Len(seen) = 2 /\ seen[1] = "M" /\ seen[2] = "E")
Wit_SkipRecorded == ~evSkipped
Wit_AnswerEarly == ~answeredEarly
Wit_AnswerExpired == ~(lateAnswer = "expired" /\ mNode \in {"pending", "awaiting"})
Wit_AnswerClosed == ~(lateAnswer = "closed" /\ runSt = "ended")
Wit_AnswerAfterTimeout == ~(lateAnswer = "closed" /\ mNode = "timed_out")
Wit_ToldByEarlier == ~evByEarlier
(* r2e: a10c2e07 records a skip with earlierAttempt.                       *)
Wit_SkipEarlier == ~evSkipEarlier
=============================================================================
