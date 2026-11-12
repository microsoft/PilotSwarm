-------------------------- MODULE WorkflowApproval --------------------------
(***************************************************************************)
(* FB-007 design model: a person-facing approval step. Batch ap1 followed  *)
(* the design note dag-human-approval-design.md (sha256 d224c115); batch   *)
(* ap2 binds the acknowledged contract dag-human-approval-schema.md        *)
(* (sha256 e117753e) and its addendum (sha256 47cfbb47), on controller     *)
(* 1.1.0 (gate "approval"; base 288cb6c3).                                 *)
(*                                                                         *)
(* One approval state in a run (optionally inside a branch that a fork    *)
(* decision can cut); a rejection may route back for a second visit with   *)
(* changed context (Loop). Each visit has one node execution and one       *)
(* approval row (rec: the node result and the audit row, written in one    *)
(* transaction with the operation receipt and the session event). Its      *)
(* effective deadline is the earlier of activation + D and the run's       *)
(* deadline RunDl, by the store's clock; pausing does not move it.        *)
(*                                                                         *)
(* An answer is an authenticated request naming the visit (approval_id =   *)
(* node execution id, with its context digest), a decision and an         *)
(* operation id; it may be delivered twice (a lost response, then the      *)
(* exact retry). It is accepted, under the session -> run -> node ->       *)
(* approval -> receipt locks in one transaction, only from a user who is   *)
(* both the pinned owner and the current owner (a live run) or from a test *)
(* fixture (a test run's interception), for the current visit's pending    *)
(* row, on a run that has not ended and has no accepted stop, while now <  *)
(* deadline. The timeout competes under the same locks. The wake is sent   *)
(* after commit and may be lost or duplicated. The controller learns of a  *)
(* settled row from a wake, from its durable deadline timer (which settles *)
(* a pending row as timed out and otherwise reads the saved result), from  *)
(* a resume, and from its start after continue-as-new. It routes a        *)
(* settled result once (consuming the stored result, guarded by the node   *)
(* execution), only while the run is running and the branch is not cut.   *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    D,                \* the approval period in clock ticks (timeoutSeconds)
    MaxT,             \* the clock's bound (it also runs on to a pending deadline)
    RunDl,            \* the run's own deadline (an earlier run deadline cuts the approval's)
    Loop,             \* a rejection routes back to a second visit, whose context changed
    Reqs,             \* the requests sent: a subset of ReqIds
    Mode,             \* "live" or "test" (a test run's approval is an interception answered by fixtures)
    Gate,             \* the approval gate of the run's controller version (FALSE: 1.0.0, no approval path)
    AllowPause,       \* the owner may pause the run once and resume it
    AllowEnd,         \* the run may be cancelled or deleted
    AllowStop,        \* a graceful stop may be accepted
    AllowCut,         \* a fork decision may cut the approval's branch
    OwnerChange,      \* environment: the Workflow's current owner becomes another user
    AllowCan,         \* the controller may continue as new
    LoseWake,         \* environment: a decision's wake may be lost
    DupWake,          \* environment: a wake may be delivered twice
    PausedWakeKept,   \* the controller keeps what a wake told it while the run is paused
    ResumeReread,     \* a resume reads the saved result (a decision buffered while paused is routed)
    Backstop,         \* the deadline timer also reads a row already decided (FALSE: it only settles a pending one)
    CanReread,        \* after continue-as-new the controller reads the saved result of its pending execution
    AnyReader,        \* fault: a reader who is not the owner may decide
    AtDeadline,       \* fault: a decision at the deadline (now = deadline) is accepted
    NoLock,           \* fault: the decision's check and its write are separate steps (no row lock)
    MatchByNode,      \* fault: a request is matched to the node's current visit, not the visit it names
    NoIdem,           \* fault: no receipt per operation id
    NoRouteGuard,     \* fault: routing is not guarded by the node execution
    RouteWhilePaused, \* fault: a route starts the next step while the run is paused
    PinnedOnly,       \* fault: only the pinned owner is checked, not the current owner
    CurrentOnly,      \* fault: only the current owner is checked, not the pinned owner
    NoStopCheck,      \* fault: an answer is accepted after an accepted stop
    SplitReceipt,     \* fault: the receipt is not written in the decision's transaction (lost with the response)
    FixtureLive       \* fault: a test fixture's answer settles a live approval

(* A request: who sends it, the visit its page showed, the decision, the   *)
(* operation id. ownConflict1 reuses ownA1's operation id with the other   *)
(* decision; newA1 is the user who owns the Workflow after OwnerChange;    *)
(* fixA1 is a test fixture's answer.                                       *)
ReqIds == {"ownA1", "ownR1", "ownConflict1", "readerA1", "agentA1", "ownA2", "ownR2", "newA1", "fixA1"}
Who(r) == CASE r = "readerA1" -> "reader" [] r = "agentA1" -> "agent" [] r = "newA1" -> "newOwner"
            [] r = "fixA1" -> "fixture" [] OTHER -> "owner"
VisitOf(r) == IF r \in {"ownA2", "ownR2"} THEN 2 ELSE 1
Dec(r) == IF r \in {"ownR1", "ownConflict1", "ownR2"} THEN "rejected" ELSE "approved"
Op(r) == IF r = "ownConflict1" THEN "ownA1" ELSE r

ASSUME D \in Nat \ {0} /\ MaxT \in Nat /\ RunDl \in Nat /\ Reqs \subseteq ReqIds /\ Mode \in {"live", "test"}
ASSUME {Loop, Gate, AllowPause, AllowEnd, AllowStop, AllowCut, OwnerChange, AllowCan, LoseWake, DupWake,
        PausedWakeKept, ResumeReread, Backstop, CanReread, AnyReader, AtDeadline, NoLock, MatchByNode, NoIdem,
        NoRouteGuard, RouteWhilePaused, PinnedOnly, CurrentOnly, NoStopCheck, SplitReceipt, FixtureLive} \subseteq BOOLEAN

Final == {"approved", "rejected", "timed_out", "closed"}
Settled == {"approved", "rejected", "timed_out"}
Ops == {Op(r) : r \in ReqIds}
People == {"owner", "newOwner", "reader", "agent"}
Answerers == People \cup {"fixture"}
TMax == MaxT + D
Min(a, b) == IF a < b THEN a ELSE b
NoRcpt == <<0, "none">>      \* no receipt (a tuple, so that every receipt value is a tuple)

VARIABLES
    now,        \* the store's clock
    visit,      \* the current visit
    rec,        \* each visit's node result and audit row: "none", "pending", or a final state
    dl,         \* each visit's effective deadline
    pin,        \* each visit's pinned owner (set at activation)
    owner,      \* the Workflow's current owner
    actor,      \* who settled it: "none", an answerer, or "timer"
    at,         \* the clock when it settled
    reqVisit,   \* the visit the accepted request named
    accReq,     \* the request whose answer settled the visit ("none")
    ownAt,      \* the current owner when the answer was accepted
    receipt,    \* each operation id's stored receipt: NoRcpt or <<visit, decision>>
    runSt,      \* "running", "paused", "stopping", "ended"
    paused,     \* pauses taken
    cut,        \* the approval's branch was cut by a fork decision
    wakes,      \* wakes queued for the controller
    dups,       \* duplicate wakes delivered
    known,      \* the controller knows the current visit's row is settled
    cans,       \* continue-as-new taken
    timerDone,  \* each visit's deadline timer has fired
    routed,     \* routes made per visit
    delivered,  \* deliveries per request
    checking,   \* NoLock: requests that passed their check and have not written
    firstFinal, \* ghost: each row's first final state
    afterStop,  \* ghost: an answer was accepted after the stop was accepted
    accWhilePaused, \* ghost: an answer was accepted while the run was paused
    badStart,   \* ghost: a step started while the run was not running or the branch was cut
    badReceipt  \* ghost: the request whose answer was accepted was later told it was refused

vars == <<now, visit, rec, dl, pin, owner, actor, at, reqVisit, accReq, ownAt, receipt, runSt, paused, cut, wakes, dups,
          known, cans, timerDone, routed, delivered, checking, firstFinal, afterStop, accWhilePaused, badStart, badReceipt>>

TypeOK ==
    /\ now \in 0..TMax /\ visit \in 1..2
    /\ rec \in [1..2 -> {"none", "pending"} \cup Final]
    /\ dl \in [1..2 -> 0..(TMax + D)]
    /\ pin \in [1..2 -> {"none", "owner", "newOwner"}] /\ owner \in {"owner", "newOwner"}
    /\ actor \in [1..2 -> {"none", "timer"} \cup Answerers]
    /\ at \in [1..2 -> 0..TMax] /\ reqVisit \in [1..2 -> 0..2] /\ accReq \in [1..2 -> ReqIds \cup {"none"}]
    /\ ownAt \in [1..2 -> {"none", "owner", "newOwner"}]
    /\ receipt \in [Ops -> {NoRcpt} \cup ({1, 2} \X Settled)]
    /\ runSt \in {"running", "paused", "stopping", "ended"} /\ paused \in 0..1 /\ cut \in BOOLEAN
    /\ wakes \in Nat /\ dups \in 0..1 /\ known \in BOOLEAN /\ cans \in 0..1
    /\ timerDone \in [1..2 -> BOOLEAN] /\ routed \in [1..2 -> 0..2]
    /\ delivered \in [ReqIds -> 0..2] /\ checking \subseteq ReqIds
    /\ firstFinal \in [1..2 -> {"none"} \cup Final]
    /\ afterStop \in BOOLEAN /\ accWhilePaused \in BOOLEAN /\ badStart \in BOOLEAN /\ badReceipt \in BOOLEAN

(* At 1.0.0 the approval state is never admitted (no approval path).      *)
Init ==
    /\ now = 0 /\ visit = 1
    /\ rec = [v \in 1..2 |-> IF v = 1 /\ Gate THEN "pending" ELSE "none"]
    /\ dl = [v \in 1..2 |-> IF v = 1 THEN Min(D, RunDl) ELSE 0]
    /\ pin = [v \in 1..2 |-> IF v = 1 THEN "owner" ELSE "none"] /\ owner = "owner"
    /\ actor = [v \in 1..2 |-> "none"] /\ at = [v \in 1..2 |-> 0] /\ reqVisit = [v \in 1..2 |-> 0]
    /\ accReq = [v \in 1..2 |-> "none"] /\ ownAt = [v \in 1..2 |-> "none"]
    /\ receipt = [o \in Ops |-> NoRcpt]
    /\ runSt = "running" /\ paused = 0 /\ cut = FALSE /\ wakes = 0 /\ dups = 0 /\ known = FALSE /\ cans = 0
    /\ timerDone = [v \in 1..2 |-> FALSE] /\ routed = [v \in 1..2 |-> 0]
    /\ delivered = [r \in ReqIds |-> 0] /\ checking = {}
    /\ firstFinal = [v \in 1..2 |-> "none"]
    /\ afterStop = FALSE /\ accWhilePaused = FALSE /\ badStart = FALSE /\ badReceipt = FALSE

ctl == <<wakes, dups, known, cans, timerDone, routed>>
reqv == <<delivered, checking>>
ghost == <<firstFinal, afterStop, accWhilePaused, badStart, badReceipt>>
dec == <<actor, at, reqVisit, accReq, ownAt, receipt>>

SetFinal(v, s) ==
    /\ rec' = [rec EXCEPT ![v] = s]
    /\ firstFinal' = IF firstFinal[v] = "none" THEN [firstFinal EXCEPT ![v] = s] ELSE firstFinal

(* The clock runs to MaxT, and on to the current visit's deadline while    *)
(* its timer has not fired (ap4: also when the row is already settled, so   *)
(* the deadline timer can still find a decision whose wake was lost).      *)
Tick ==
    /\ now < MaxT \/ (rec[visit] # "none" /\ ~timerDone[visit] /\ runSt # "ended" /\ now < dl[visit] /\ now < TMax)
    /\ now' = now + 1
    /\ UNCHANGED <<visit, rec, dl, pin, owner, dec, runSt, paused, cut, ctl, reqv, ghost>>

(* ---------------- an answer ---------------- *)
OwnerOk(r) ==
    CASE PinnedOnly -> Who(r) = pin[VisitOf(r)]
      [] CurrentOnly -> Who(r) = owner
      [] OTHER -> Who(r) = pin[VisitOf(r)] /\ Who(r) = owner
Authorized(r) ==
    IF Mode = "live"
    THEN OwnerOk(r) \/ (AnyReader /\ Who(r) = "reader") \/ (FixtureLive /\ Who(r) = "fixture")
    ELSE Who(r) = "fixture"
Target(r) == IF MatchByNode THEN visit ELSE VisitOf(r)
OnTime(v) == IF AtDeadline THEN now <= dl[v] ELSE now < dl[v]
Acceptable(r) ==
    LET v == Target(r) IN
    /\ Authorized(r) /\ v = visit /\ rec[v] = "pending" /\ runSt # "ended" /\ ~cut /\ OnTime(v)
    /\ (runSt = "stopping" => NoStopCheck)
Replay(r) == ~NoIdem /\ receipt[Op(r)] # NoRcpt
SameAsReceipt(r) == receipt[Op(r)] = <<VisitOf(r), Dec(r)>>

(* The answer the requester gets; refusing the request whose answer was    *)
(* accepted (a retry after a lost response) is the bad case.               *)
Answer(r, acc) == badReceipt' = (badReceipt \/ (~acc /\ \E v \in 1..2 : accReq[v] = r))

Accept(r) ==
    LET v == Target(r) IN
    /\ SetFinal(v, Dec(r))
    /\ actor' = [actor EXCEPT ![v] = Who(r)] /\ at' = [at EXCEPT ![v] = now]
    /\ reqVisit' = [reqVisit EXCEPT ![v] = VisitOf(r)] /\ accReq' = [accReq EXCEPT ![v] = r]
    /\ ownAt' = [ownAt EXCEPT ![v] = owner]
    /\ accWhilePaused' = (accWhilePaused \/ runSt = "paused")
    /\ receipt' = IF NoIdem \/ SplitReceipt THEN receipt ELSE [receipt EXCEPT ![Op(r)] = <<VisitOf(r), Dec(r)>>]
    /\ afterStop' = (afterStop \/ runSt = "stopping")
    /\ wakes' = wakes + 1

Deliver(r) ==
    /\ r \in Reqs /\ delivered[r] < 2 /\ VisitOf(r) <= visit /\ r \notin checking
    /\ delivered' = [delivered EXCEPT ![r] = @ + 1]
    /\ IF Replay(r)
       THEN /\ Answer(r, SameAsReceipt(r))
            /\ UNCHANGED <<rec, dec, wakes, checking, firstFinal, afterStop, accWhilePaused>>
       ELSE IF ~Acceptable(r)
       THEN /\ Answer(r, FALSE)
            /\ UNCHANGED <<rec, dec, wakes, checking, firstFinal, afterStop, accWhilePaused>>
       ELSE IF NoLock
       THEN /\ checking' = checking \cup {r}
            /\ UNCHANGED <<rec, dec, wakes, firstFinal, afterStop, accWhilePaused, badReceipt>>
       ELSE /\ Accept(r) /\ Answer(r, TRUE) /\ UNCHANGED checking
    /\ UNCHANGED <<now, visit, dl, pin, owner, runSt, paused, cut, dups, known, cans, timerDone, routed, badStart>>

(* NoLock: the write of a request that passed its check earlier.            *)
Write(r) ==
    /\ r \in checking
    /\ Accept(r) /\ Answer(r, TRUE) /\ checking' = checking \ {r}
    /\ UNCHANGED <<now, visit, dl, pin, owner, runSt, paused, cut, dups, known, cans, timerDone, routed, delivered,
                   badStart>>

(* ---------------- the controller ---------------- *)
Sees == runSt = "running" \/ PausedWakeKept

(* The current visit's deadline timer fires (durable; at or after the      *)
(* deadline, also while paused or stopping). Under the locks it settles a  *)
(* pending row as timed out; otherwise it reads the saved result.          *)
Timer ==
    /\ ~timerDone[visit] /\ rec[visit] # "none" /\ now >= dl[visit] /\ runSt # "ended"
    /\ timerDone' = [timerDone EXCEPT ![visit] = TRUE]
    /\ IF rec[visit] = "pending"
       THEN /\ SetFinal(visit, "timed_out") /\ actor' = [actor EXCEPT ![visit] = "timer"]
            /\ at' = [at EXCEPT ![visit] = now] /\ known' = (Sees \/ known)
       ELSE /\ known' = (known \/ (Backstop /\ rec[visit] \in Settled /\ Sees))
            /\ UNCHANGED <<rec, firstFinal, actor, at>>
    /\ UNCHANGED <<now, visit, dl, pin, owner, reqVisit, accReq, ownAt, receipt, runSt, paused, cut, wakes, dups, cans,
                   routed, reqv, afterStop, accWhilePaused, badStart, badReceipt>>

(* A wake is processed: the controller reads the current visit's result.  *)
TakeWake ==
    /\ wakes > 0 /\ runSt # "ended"
    /\ wakes' = wakes - 1
    /\ known' = (known \/ (rec[visit] \in Settled /\ Sees))
    /\ UNCHANGED <<now, visit, rec, dl, pin, owner, dec, runSt, paused, cut, dups, cans, timerDone, routed, reqv, ghost>>

DropWake ==
    /\ LoseWake /\ wakes > 0 /\ wakes' = wakes - 1
    /\ UNCHANGED <<now, visit, rec, dl, pin, owner, dec, runSt, paused, cut, dups, known, cans, timerDone, routed, reqv,
                   ghost>>

DuplicateWake ==
    /\ DupWake /\ dups = 0 /\ wakes > 0 /\ wakes' = wakes + 1 /\ dups' = 1
    /\ UNCHANGED <<now, visit, rec, dl, pin, owner, dec, runSt, paused, cut, known, cans, timerDone, routed, reqv, ghost>>

(* Continue-as-new: duroxide carries the queued wakes; the controller's    *)
(* state carries the pending execution id and deadline, not what it knew. *)
(* With CanReread its start reads the saved result of that execution.     *)
Can ==
    /\ AllowCan /\ cans = 0 /\ runSt \in {"running", "paused"}
    /\ cans' = 1 /\ known' = (CanReread /\ rec[visit] \in Settled /\ Sees)
    /\ UNCHANGED <<now, visit, rec, dl, pin, owner, dec, runSt, paused, cut, wakes, dups, timerDone, routed, reqv, ghost>>

(* Consume the settled result once (guarded by the node execution) and     *)
(* advance: a rejection with Loop admits the second visit, whose context   *)
(* changed, pinned to the current owner, with its own effective deadline.  *)
Route ==
    /\ known /\ rec[visit] \in Settled
    /\ IF RouteWhilePaused THEN runSt \in {"running", "paused"} ELSE runSt = "running"
    /\ ~cut
    /\ known' = FALSE
    /\ IF routed[visit] = 0 \/ (NoRouteGuard /\ routed[visit] < 2)
       THEN /\ routed' = [routed EXCEPT ![visit] = @ + 1]
            /\ badStart' = (badStart \/ runSt # "running")
            /\ IF routed[visit] = 0 /\ rec[visit] = "rejected" /\ Loop /\ visit = 1
               THEN /\ visit' = 2
                    /\ rec' = [rec EXCEPT ![2] = "pending"] /\ dl' = [dl EXCEPT ![2] = Min(now + D, RunDl)]
                    /\ pin' = [pin EXCEPT ![2] = owner]
               ELSE UNCHANGED <<visit, rec, dl, pin>>
       ELSE UNCHANGED <<routed, badStart, visit, rec, dl, pin>>
    /\ UNCHANGED <<now, owner, dec, runSt, paused, cut, wakes, dups, cans, timerDone, reqv, firstFinal, afterStop,
                   accWhilePaused, badReceipt>>

(* ---------------- control and environment ---------------- *)
Pause ==
    /\ AllowPause /\ runSt = "running" /\ paused = 0 /\ runSt' = "paused" /\ paused' = 1
    /\ UNCHANGED <<now, visit, rec, dl, pin, owner, dec, cut, ctl, reqv, ghost>>

Resume ==
    /\ runSt = "paused" /\ runSt' = "running"
    /\ known' = (known \/ (ResumeReread /\ rec[visit] \in Settled))
    /\ UNCHANGED <<now, visit, rec, dl, pin, owner, dec, paused, cut, wakes, dups, cans, timerDone, routed, reqv, ghost>>

(* A graceful stop: started work finishes, nothing new starts, no fresh   *)
(* answer is accepted. The run ends once the approval's row is final.     *)
Stop ==
    /\ AllowStop /\ runSt \in {"running", "paused"} /\ runSt' = "stopping"
    /\ UNCHANGED <<now, visit, rec, dl, pin, owner, dec, paused, cut, ctl, reqv, ghost>>

StopEnds ==
    /\ runSt = "stopping" /\ rec[visit] # "pending" /\ checking = {} /\ runSt' = "ended"
    /\ UNCHANGED <<now, visit, rec, dl, pin, owner, dec, paused, cut, ctl, reqv, ghost>>

(* Cancel or delete, or the run's own deadline: a pending row is closed;  *)
(* a settled one stays as it is and starts nothing.                        *)
EndRun ==
    /\ (AllowEnd \/ now >= RunDl) /\ runSt # "ended" /\ runSt' = "ended"
    /\ IF rec[visit] = "pending" THEN SetFinal(visit, "closed") ELSE UNCHANGED <<rec, firstFinal>>
    /\ UNCHANGED <<now, visit, dl, pin, owner, dec, paused, cut, ctl, reqv, afterStop, accWhilePaused, badStart, badReceipt>>

(* A fork decision cuts the approval's branch: a pending row is closed; a *)
(* settled one is kept and routes nothing. The run goes on.                *)
Cut ==
    /\ AllowCut /\ ~cut /\ runSt # "ended" /\ cut' = TRUE
    /\ IF rec[visit] = "pending" THEN SetFinal(visit, "closed") ELSE UNCHANGED <<rec, firstFinal>>
    /\ UNCHANGED <<now, visit, dl, pin, owner, dec, runSt, paused, ctl, reqv, afterStop, accWhilePaused, badStart,
                   badReceipt>>

(* The Workflow's current owner becomes another user (not reachable in the *)
(* design: owner transfer is excluded and a hand-over keeps the user).     *)
ChangeOwner ==
    /\ OwnerChange /\ owner = "owner" /\ owner' = "newOwner"
    /\ UNCHANGED <<now, visit, rec, dl, pin, dec, runSt, paused, cut, ctl, reqv, ghost>>

Done == UNCHANGED vars

Next ==
    \/ Tick \/ (\E r \in ReqIds : Deliver(r) \/ Write(r)) \/ Timer \/ TakeWake \/ DropWake \/ DuplicateWake \/ Can
    \/ Route \/ Pause \/ Resume \/ Stop \/ StopEnds \/ EndRun \/ Cut \/ ChangeOwner \/ Done

Spec == Init /\ [][Next]_vars
(* The clock advances, the timer fires, wakes are processed, a settled     *)
(* row is routed, a paused run is resumed, a stopping run ends. People are *)
(* not obliged to answer.                                                  *)
LiveSpec == Spec /\ WF_vars(Tick) /\ WF_vars(Timer) /\ WF_vars(TakeWake) /\ WF_vars(Route) /\ WF_vars(Resume)
            /\ WF_vars(StopEnds) /\ \A r \in ReqIds : WF_vars(Write(r))

(* ---------------- properties ---------------- *)
ByPerson(v) == actor[v] \in Answerers
(* At most one final decision: a final row never changes.                  *)
Inv_OneDecision == \A v \in 1..2 : firstFinal[v] # "none" => rec[v] = firstFinal[v]
(* A live approval is decided only by the user who is its pinned owner and *)
(* the current owner; a test interception only by a fixture.               *)
Inv_OnlyPinned ==
    \A v \in 1..2 : ByPerson(v) => IF Mode = "live" THEN actor[v] = pin[v] /\ actor[v] \in {"owner", "newOwner"}
                                    ELSE actor[v] = "fixture"
Inv_OwnerAtDecision == \A v \in 1..2 : (ByPerson(v) /\ Mode = "live") => actor[v] = pin[v] /\ actor[v] = ownAt[v]
(* No acceptance at or after the effective deadline.                       *)
Inv_BeforeDeadline == \A v \in 1..2 : ByPerson(v) => at[v] < dl[v]
(* Changed context never reuses prior consent: the request named its visit. *)
Inv_ConsentFresh == \A v \in 1..2 : ByPerson(v) => reqVisit[v] = v
(* A settled result is routed at most once; nothing starts unless running.  *)
Inv_RoutedOnce == \A v \in 1..2 : routed[v] <= 1
Inv_NoStartUnlessRunning == ~badStart
(* The accepted request is never told it was refused (a lost response,     *)
(* then the exact retry, returns the accepted receipt).                    *)
Inv_ReceiptStable == ~badReceipt
(* Node result, audit and receipt agree.                                    *)
Inv_AuditAgrees ==
    \A v \in 1..2 : (ByPerson(v) /\ ~NoIdem) => receipt[Op(accReq[v])] = <<v, rec[v]>>
(* No fresh answer after an accepted stop.                                 *)
Inv_NoAnswerAfterStop == ~afterStop
(* 1.0.0 has no approval path.                                             *)
Inv_GateHolds == ~Gate => \A v \in 1..2 : rec[v] = "none"

(* Every row settles, and a settled row of a running, uncut run is routed. *)
Prop_Settles == \A v \in 1..2 : (rec[v] = "pending") ~> (rec[v] \in Final)
Prop_Routed == \A v \in 1..2 : (visit = v /\ rec[v] \in Settled) ~> (routed[v] >= 1 \/ runSt = "ended" \/ cut)
Prop_StopEnds == (runSt = "stopping") ~> (runSt = "ended")

(* Witnesses: each must be violated.                                       *)
W_NoApproval == \A v \in 1..2 : rec[v] # "approved"
W_NoSecondVisitApproval == rec[2] # "approved"
W_NoTimeoutWhilePaused == ~(rec[1] = "timed_out" /\ runSt = "paused")
W_NoAcceptedThenEnded == ~(rec[1] = "approved" /\ runSt = "ended" /\ routed[1] = 0)
W_NoBoundaryRefusal == ~(now = dl[1] /\ rec[1] = "pending" /\ delivered["ownA1"] > 0 /\ actor[1] = "none")
W_NoApprovedWhilePausedThenRouted == ~(accWhilePaused /\ routed[1] = 1 /\ rec[1] = "approved")
W_NoRunDeadlineFirst == ~(rec[1] = "timed_out" /\ dl[1] = RunDl /\ RunDl < D)
W_NoAcceptedThenCut == ~(rec[1] = "approved" /\ cut /\ routed[1] = 0)
W_NoReplayedReceipt == ~(delivered["ownA1"] = 2 /\ accReq[1] = "ownA1" /\ ~badReceipt)
=============================================================================
