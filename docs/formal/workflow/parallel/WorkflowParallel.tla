------------------------- MODULE WorkflowParallel -------------------------
(***************************************************************************)
(* One parallel state of a workflow run with the k-of-n join agreed in  *)
(* the design decision of 2026-11-04 (join k of n): join all (k = n) or    *)
(* join first k; failFast; an                                              *)
(* optional timeoutSeconds whose durable timer races the join; outcomes    *)
(* joined, blocked or timed_out; exactly one decision; running branches    *)
(* cancelled after it and queued branches not_started; finished outputs    *)
(* kept. The model is derived from that design and from controller 1.9.0   *)
(* at 8d568890 (runtime.ts startBranches/endBranch/joinIfDone 1222-1267,   *)
(* the pass order 1269-1630, cancelBranches 3998-4052, join 4054-4150;     *)
(* store.ts cancelBranchScopes 6104-6131, enterScript 3492-3507).          *)
(*                                                                          *)
(* Every branch body is one work state (a script or an agent state) and    *)
(* then the body's terminal. The controller is one deterministic process:  *)
(* it is never inside two steps at once. Every store activity is a         *)
(* transaction; the branch cancellation is split into its transaction and  *)
(* the stop requests that follow it. A worker crash after a transaction    *)
(* and before the activity's result is in history re-executes the          *)
(* activity (duroxide at-least-once). A controller replay is no step.      *)
(* Clocks are monotone flags: stTime is the store's clock against the      *)
(* parallel state's deadline, ctTime the controller's (it may be ahead     *)
(* with AllowSkew). The numeric clock and its skew are checked for the     *)
(* wait state in ../WorkflowWait.tla.                                    *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    N,             \* the manifest's item count at run time
    K,             \* join: { first: K } (ignored with JoinAll)
    JoinAll,       \* join: all, so k is n
    Conc,          \* the state's concurrency
    FailFast,      \* cancel the rest as soon as k successes are impossible
    HasTimer,      \* timeoutSeconds is set
    Agents,        \* branches whose work state is an agent state (the others are script states)
    CanFail,       \* branches whose work may end failed (an outcome the body does not route)
    Hang,          \* branches whose work never ends by itself
    AllowSkew,     \* the controller's clock may reach the deadline before the store's
    AllowPause,    \* the parent may pause the run once, and resume it
    PausedCancel,  \* a timeout decided while paused cancels the branches "now" or at the "resume"
    ResumeFair,    \* a paused run is resumed in the end
    AllowRunEnd,   \* a cancel, a deletion or the run's own deadline ends the run and decides what is pending
    AllowEndFail,  \* ending an agent child at the decision may fail (the run's end ends it again)
    MaxCrash,      \* worker crashes after a transaction, before its activity's result is recorded
    MaxCan,        \* continue-as-new while the parallel state waits
    CancelFirst,   \* the join path cancels the other branches before its decision (as failFast does at 8d568890)
    Rules,         \* "p1": the design of 20:07Z; "decided": with the answers to PJ-Q1..Q3 (20:33Z)
    TimeoutCounts, \* with "decided": the timeout counts stored successful "work" or admitted "terminals"
    JoinCheck,     \* with "decided": the join's deadline check counts "work" (shared with the timeout), "winners", or "none"
    StoreCutsOnTimeout, \* the timeout's transaction also cancels the branches' pending work (J1 1b4f67b3)
    EndFailRetries,\* J1-R2 (J1b): a failed child end fails the cancellation activity, which retries; FALSE: swallowed (J1)
    MaxEndFail,    \* bound on failed child ends that fail the activity
    EndBudget,     \* after MaxEndFail failed ends: "forced" (the end succeeds; p2), "fail-run" (J1c), "owe" (J1d)
    EndForever,    \* a loser's child end may keep failing (no forced success; an owed end's retries fail too)
    RetryAt,       \* owed ends retried: "idle-paused" (J1d: idle wait, paused collector) or "every-pass" (J1e 68079fed)
    BusyAfter,     \* J1d-R1: after the route the run stays busy (ready results every pass); it never idles or ends
    PauseSeen,     \* the controller learns a pause at a refused "admission" (8d568890, J1b) or at the "collect" (R2-RT-1 fix)
    Fault          \* a deliberate fault, or "none"

Faults == {"none", "failfast-first", "ff-false-early", "no-store-guard", "no-cas", "timer-armed",
           "timeout-keeps-cursors", "cancel-retry-forgets", "cancel-only-if-won", "can-drops-deadline",
           "winners-by-index", "no-conc-limit"}

ASSUME N \in Nat /\ K \in Nat /\ K >= 1 /\ Conc \in Nat /\ Conc >= 1
ASSUME {JoinAll, FailFast, HasTimer, AllowSkew, AllowPause, ResumeFair, AllowRunEnd, AllowEndFail, CancelFirst} \subseteq BOOLEAN
ASSUME Agents \subseteq 1..N /\ CanFail \subseteq 1..N /\ Hang \subseteq 1..N
ASSUME PausedCancel \in {"now", "resume"}
ASSUME MaxCrash \in Nat /\ MaxCan \in Nat
ASSUME Fault \in Faults
ASSUME Rules \in {"p1", "decided"} /\ TimeoutCounts \in {"work", "terminals"} /\ JoinCheck \in {"work", "winners", "none"}
ASSUME StoreCutsOnTimeout \in BOOLEAN /\ EndFailRetries \in BOOLEAN /\ MaxEndFail \in Nat
ASSUME PauseSeen \in {"admission", "collect"}
ASSUME EndBudget \in {"forced", "fail-run", "owe"} /\ EndForever \in BOOLEAN
ASSUME RetryAt \in {"idle-paused", "every-pass"} /\ BusyAfter \in BOOLEAN

Idx == 1..N
(* k: the successes the join needs. join all is k = n (n = 0 joins []).   *)
Kneed == IF JoinAll THEN N ELSE K
(* The timer stays armed after a join decision (a fault, or its control).  *)
TimerStaysArmed == Fault \in {"timer-armed", "no-cas"}

CbStates == {"queued", "ready", "running", "toTerminal", "succeeded", "failed", "cancelled", "not_started"}
Outcomes == {"none", "joined", "blocked", "timed_out", "cancelled"}
Results == {"none", "not_due", "join_due", "joined", "blocked", "timed_out", "cancelled", "ok"}

VARIABLES
    \* the store
    pst,        \* the parallel state's node execution: "none", "pending", "done"
    pout,       \* its stored outcome; "cancelled" when the run's end decided it
    bst,        \* each branch's work state: "none", "pending", "succeeded", "failed", "cancelled"
    byDecision, \* the branch's work state was decided cancelled by this parallel state's cancellation
    joinOut,    \* a joined state's output: the winners' indexes, in order
    stTime,     \* the store's clock: "before" or "after" the parallel state's deadline
    runEnded,   \* a cancel, deletion or run deadline ended the run
    paused,     \* the run is paused
    \* the work
    eff,        \* each branch's work: "none", "starting", "running", "done", "stopped"
    asked,      \* its effect was asked to stop (cancelInstance, or the child's end)
    endOk,      \* an agent branch's child end was recorded
    \* the controller
    cb,         \* each branch as the controller sees it
    order,      \* the branches that succeeded, in the order the controller saw them end
    ctl,        \* "init", "waiting", "deciding", "cancelPending", "decided", "routed", "busy", "ended"
    want,       \* the decision the controller asked for: "none", "joined", "blocked", "timed_out"
    ctlOut,     \* the outcome the controller acts on
    act,        \* the activity in flight
    ctTime,     \* the controller's clock
    armed,      \* the parallel state's deadline is in the controller's state
    crashes, cans, pauses,
    \* history, for the rules and witnesses
    dv,         \* the controller's view of the branches at the decision
    decisions,  \* compare-and-swaps that decided (or overwrote) the parallel state
    routes,     \* times the parallel state's result was routed
    early,      \* a timeout was decided before the store's clock reached the deadline
    kStored,    \* at the timeout, k branches' work had already stored succeeded
    pausedAtDecision, impossibleAtDecision,
    startedAfter, routedAfter, notDueSeen,
    \* p2: the decided rules
    wAt,        \* the store's clock when each branch's work stored its result: "none", "before", "after"
    tFlag,      \* the report says timedOut (the time limit decided the state)
    impSeen,    \* the controller saw k successes become impossible
    joinDueSeen,\* the timeout answered "join due"
    jLate,      \* joined with a winner whose work was stored after the deadline
    jRule,      \* joined by the store-time rule (the join's own count)
    wOrder,     \* the branches whose work committed succeeded, in commit order
    endFails,   \* failed child ends that failed the cancellation activity
    ctlPaused,  \* the controller knows the run is paused
    routedWhilePaused, \* R2-RT-1: a branch result routed while the run was paused
    owed,       \* J1d: loser child ends recorded owed after the retry budget
    runFailed,  \* J1c: the controller failed the run after the retry budget
    cmdQ        \* a cancel command waits in the controller's queue (taken only between activities)

storeVars == <<pst, pout, bst, byDecision, joinOut, stTime, runEnded, paused>>
workVars == <<eff, asked, endOk>>
ctlVars == <<cb, order, ctl, want, ctlOut, act, ctTime, armed, crashes, cans, pauses>>
histVars == <<dv, decisions, routes, early, kStored, pausedAtDecision, impossibleAtDecision, startedAfter, routedAfter, notDueSeen>>
p2Vars == <<wAt, tFlag, impSeen, joinDueSeen, jLate, jRule, wOrder, endFails, ctlPaused, routedWhilePaused, owed, runFailed, cmdQ>>
vars == <<storeVars, workVars, ctlVars, histVars, p2Vars>>

NoAct == [k |-> "none", ph |-> "sched", res |-> "none", won |-> FALSE, list |-> {}, ret |-> {}]

RECURSIVE SeqOfSet(_)
SeqOfSet(S) == IF S = {} THEN <<>>
               ELSE LET m == CHOOSE x \in S : \A y \in S : x <= y IN <<m>> \o SeqOfSet(S \ {m})
Range(s) == {s[j] : j \in 1..Len(s)}

Active(c) == {i \in Idx : c[i] \in {"ready", "running", "toTerminal"}}
Succ(c) == {i \in Idx : c[i] = "succeeded"}
Failed(c) == {i \in Idx : c[i] \in {"failed", "cancelled"}}
AllEnded(c) == \A i \in Idx : c[i] \in {"succeeded", "failed", "cancelled", "not_started"}
(* k successes became impossible: failed or cancelled > n - k.            *)
Impossible(c) == Cardinality(Failed(c)) + Kneed > N

(* startBranches: queued branches get a cursor in manifest order, at most  *)
(* the concurrency at a time.                                              *)
Fill(c) == [i \in Idx |->
              IF c[i] = "queued"
                 /\ (Fault = "no-conc-limit"
                     \/ Cardinality({j \in Idx : j < i /\ c[j] = "queued"}) + Cardinality(Active(c)) < Conc)
              THEN "ready" ELSE c[i]]

(* The rule after a branch ended.                                          *)
Rule(c) ==
    IF Cardinality(Succ(c)) >= Kneed THEN "joined"
    ELSE IF Fault = "failfast-first" /\ FailFast /\ Failed(c) # {} THEN "blocked"
    ELSE IF Impossible(c) /\ (FailFast \/ Fault = "ff-false-early" \/ AllEnded(c)) THEN "blocked"
    ELSE "none"

(* At entry: n = 0 with all joins []; n < k blocks at once.                *)
EnterRule == IF Kneed = 0 THEN "joined" ELSE IF N < Kneed THEN "blocked" ELSE "none"

(* After the decision: running branches cancelled, queued ones not_started; *)
(* branches that ended keep how they ended.                                 *)
Drop(c) == [i \in Idx |->
              CASE c[i] \in {"ready", "running", "toTerminal"} -> "cancelled"
                [] c[i] = "queued" -> "not_started"
                [] OTHER -> c[i]]

ByIndex == SubSeq(SeqOfSet(Range(order)), 1, Kneed)
Winners == IF want # "joined" THEN <<>>
           ELSE IF Fault = "winners-by-index" THEN ByIndex ELSE SubSeq(order, 1, Kneed)

Init ==
    /\ pst = "none" /\ pout = "none"
    /\ bst = [i \in Idx |-> "none"] /\ byDecision = [i \in Idx |-> FALSE]
    /\ joinOut = <<>> /\ stTime = "before" /\ runEnded = FALSE /\ paused = FALSE
    /\ eff = [i \in Idx |-> "none"] /\ asked = [i \in Idx |-> FALSE] /\ endOk = [i \in Idx |-> FALSE]
    /\ cb = [i \in Idx |-> "queued"] /\ order = <<>>
    /\ ctl = "init" /\ want = "none" /\ ctlOut = "none" /\ act = NoAct
    /\ ctTime = "before" /\ armed = FALSE /\ crashes = 0 /\ cans = 0 /\ pauses = 0
    /\ dv = [i \in Idx |-> "queued"] /\ decisions = 0 /\ routes = 0 /\ early = FALSE /\ kStored = FALSE
    /\ pausedAtDecision = FALSE /\ impossibleAtDecision = FALSE
    /\ startedAfter = FALSE /\ routedAfter = FALSE /\ notDueSeen = FALSE
    /\ wAt = [i \in Idx |-> "none"] /\ tFlag = FALSE /\ impSeen = FALSE /\ joinDueSeen = FALSE /\ jLate = FALSE /\ jRule = FALSE /\ wOrder = <<>> /\ endFails = 0
    /\ ctlPaused = FALSE /\ routedWhilePaused = FALSE /\ owed = [i \in Idx |-> FALSE] /\ runFailed = FALSE /\ cmdQ = FALSE

(* The controller decides d from its view c: the join path asks the store  *)
(* for the decision (after the cancellation with CancelFirst).             *)
Decide(d, c) ==
    /\ ctl' = "deciding" /\ want' = d /\ dv' = c /\ cb' = c
    /\ impossibleAtDecision' = Impossible(c)
    /\ act' = (IF CancelFirst /\ Active(c) # {}
               THEN [NoAct EXCEPT !.k = "cancel", !.list = Active(c)]
               ELSE [NoAct EXCEPT !.k = "join"])

(* A branch ended at its terminal ("succeeded") or by a result no route    *)
(* takes ("failed"). The parallel state's own cursor decides only while    *)
(* it is waiting.                                                          *)
EndB(i, via) ==
    LET c1 == [cb EXCEPT ![i] = via]
        d == Rule(c1)
    IN /\ impSeen' = (impSeen \/ Impossible(c1))
       /\ IF ctl = "waiting" /\ d # "none"
          THEN Decide(d, c1)
          ELSE /\ cb' = Fill(c1) /\ UNCHANGED <<ctl, want, dv, act, impossibleAtDecision>>

(* The parallel state is admitted: its node and its deadline are stored.   *)
Enter ==
    /\ ctl = "init" /\ ~runEnded
    /\ pst' = "pending" /\ armed' = HasTimer
    /\ IF EnterRule # "none"
       THEN Decide(EnterRule, cb)
       ELSE /\ cb' = Fill(cb) /\ ctl' = "waiting"
            /\ UNCHANGED <<want, dv, act, impossibleAtDecision>>
    /\ UNCHANGED <<pout, bst, byDecision, joinOut, stTime, runEnded, paused, workVars, order, ctlOut, ctTime,
                   crashes, cans, pauses, decisions, routes, early, kStored, pausedAtDecision, startedAfter, routedAfter, notDueSeen, p2Vars>>

CtlRoutes == ctl = "waiting" \/ (Fault = "timeout-keeps-cursors" /\ ctl = "decided")

(* A cursor's work state is admitted and its effect or agent started.      *)
StartBranch(i) ==
    /\ cb[i] = "ready" /\ CtlRoutes /\ act.k = "none" /\ ~paused /\ ~runEnded
    /\ ~(Rules = "decided" /\ joinDueSeen)   \* J1b: after the time limit a branch admits only its terminal
    /\ cb' = [cb EXCEPT ![i] = "running"]
    /\ bst' = [bst EXCEPT ![i] = "pending"]
    /\ eff' = [eff EXCEPT ![i] = "starting"]
    /\ startedAfter' = (startedAfter \/ pst = "done")
    /\ UNCHANGED <<pst, pout, byDecision, joinOut, stTime, runEnded, paused, asked, endOk, order, ctl, want, ctlOut, act,
                   ctTime, armed, crashes, cans, pauses, dv, decisions, routes, early, kStored, pausedAtDecision,
                   impossibleAtDecision, routedAfter, notDueSeen, p2Vars>>

(* The controller collects a branch's stored result and routes it.         *)
Collect(i) ==
    /\ cb[i] = "running" /\ bst[i] \in {"succeeded", "failed"}
    /\ CtlRoutes /\ act.k = "none"
    \* R2-RT-1: at 8d568890 and J1b the controller learns a pause only at a refused admission
    /\ IF PauseSeen = "collect" THEN ~paused ELSE ~ctlPaused
    /\ routedAfter' = (routedAfter \/ (pst = "done" /\ pout # "cancelled"))
    /\ routedWhilePaused' = (routedWhilePaused \/ paused)
    /\ IF bst[i] = "succeeded"
       THEN /\ cb' = [cb EXCEPT ![i] = "toTerminal"]
            /\ UNCHANGED <<ctl, want, dv, act, impossibleAtDecision, impSeen>>
       ELSE EndB(i, "failed")
    /\ UNCHANGED <<storeVars, workVars, order, ctlOut, ctTime, armed, crashes, cans, pauses,
                   decisions, routes, early, kStored, pausedAtDecision, startedAfter, notDueSeen, wAt, tFlag, joinDueSeen, jLate, jRule, wOrder, endFails, ctlPaused, owed, runFailed, cmdQ>>

(* The branch's terminal is admitted: the branch succeeded.                *)
AdmitTerminal(i) ==
    /\ cb[i] = "toTerminal" /\ CtlRoutes /\ act.k = "none" /\ ~paused /\ ~runEnded
    /\ order' = Append(order, i)
    /\ routedAfter' = (routedAfter \/ (pst = "done" /\ pout # "cancelled"))
    /\ EndB(i, "succeeded")
    /\ UNCHANGED <<storeVars, workVars, ctlOut, ctTime, armed, crashes, cans, pauses,
                   decisions, routes, early, kStored, pausedAtDecision, startedAfter, notDueSeen, wAt, tFlag, joinDueSeen, jLate, jRule, wOrder, endFails, ctlPaused, routedWhilePaused, owed, runFailed, cmdQ>>

(* R2-RT-1: the controller learns a pause when the store refuses a cursor's *)
(* admission, and learns the resume when an admission is accepted again.   *)
AdmitRefused ==
    /\ paused /\ ~ctlPaused /\ CtlRoutes /\ act.k = "none"
    /\ \E i \in Idx : cb[i] \in {"ready", "toTerminal"}
    /\ ctlPaused' = TRUE
    /\ UNCHANGED <<storeVars, workVars, ctlVars, histVars, wAt, tFlag, impSeen, joinDueSeen, jLate, jRule, wOrder, endFails, routedWhilePaused, owed, runFailed, cmdQ>>
CtlSeesResume ==
    /\ ctlPaused /\ ~paused
    /\ ctlPaused' = FALSE
    /\ UNCHANGED <<storeVars, workVars, ctlVars, histVars, wAt, tFlag, impSeen, joinDueSeen, jLate, jRule, wOrder, endFails, routedWhilePaused, owed, runFailed, cmdQ>>

(* The controller's timer reached the deadline by its own clock. A pass    *)
(* admits every cursor before it elapses deadlines, so no branch is at an  *)
(* unadmitted state then, unless the run is paused (admission is refused). *)
(* The timer runs while paused, as a wait state's does.                    *)
TimerFire ==
    /\ HasTimer /\ armed /\ ctTime = "after" /\ act.k = "none"
    /\ (ctl = "waiting" \/ (TimerStaysArmed /\ ctl = "decided"))
    /\ (paused \/ \A i \in Idx : cb[i] \notin {"ready", "toTerminal"})
    /\ act' = [NoAct EXCEPT !.k = "timeout"]
    /\ ctl' = IF ctl = "waiting" THEN "deciding" ELSE ctl
    /\ UNCHANGED <<storeVars, workVars, cb, order, want, ctlOut, ctTime, armed, crashes, cans, pauses, histVars, p2Vars>>

CtlTick ==
    /\ HasTimer /\ pst # "none" /\ ctTime = "before" /\ (AllowSkew \/ stTime = "after")
    /\ ctTime' = "after"
    /\ UNCHANGED <<storeVars, workVars, cb, order, ctl, want, ctlOut, act, armed, crashes, cans, pauses, histVars, p2Vars>>

StoreTick ==
    /\ HasTimer /\ pst # "none" /\ stTime = "before"
    /\ stTime' = "after"
    /\ UNCHANGED <<pst, pout, bst, byDecision, joinOut, runEnded, paused, workVars, ctlVars, histVars, p2Vars>>

(* p2: store time decides. A branch's success counts toward k when its    *)
(* work committed succeeded at or before the deadline ("on time").         *)
OnTime(i) == wAt[i] = "before"
WorkBefore == Cardinality({i \in Idx : bst[i] = "succeeded" /\ OnTime(i)})
OnTimeAdmitted == SelectSeq(order, OnTime)
JoinCount == IF JoinCheck = "work" THEN WorkBefore ELSE Len(OnTimeAdmitted)
(* The join's winners under the store-time rule: with the shared count,   *)
(* the first k on-time successes in commit order (J1b amendment 1),       *)
(* admitted or not; "winners" takes the on-time admitted ones (H1).        *)
CheckedWinners == IF JoinCheck = "work" THEN SubSeq(SelectSeq(wOrder, OnTime), 1, Kneed)
                  ELSE SubSeq(OnTimeAdmitted, 1, Kneed)
(* J1b: k is impossible by the store's count: failures committed on time. *)
StoreImpossible == Cardinality({i \in Idx : bst[i] = "failed" /\ OnTime(i)}) + Kneed > N
(* J1b: a blocked verdict asked after the deadline stands only when k was  *)
(* impossible on time; otherwise the state timed out.                      *)
LateBlocked == Rules = "decided" /\ want = "blocked" /\ HasTimer /\ stTime = "after"
JoinRule == Rules = "decided" /\ want = "joined"
            /\ (JoinCheck = "work" \/ (JoinCheck = "winners" /\ HasTimer /\ stTime = "after"))
(* The timeout's transaction cancels the branches' pending work (J1).      *)
CutBst == [i \in Idx |-> IF StoreCutsOnTimeout /\ bst[i] = "pending" THEN "cancelled" ELSE bst[i]]
CutBy == [i \in Idx |-> byDecision[i] \/ (StoreCutsOnTimeout /\ bst[i] = "pending")]

(* The activity's transaction.                                             *)
JoinStore ==
    /\ act.k = "join" /\ act.ph = "sched"
    /\ IF pst = "pending" /\ LateBlocked
       THEN /\ pst' = "done" /\ pout' = (IF StoreImpossible THEN "blocked" ELSE "timed_out") /\ decisions' = decisions + 1
            /\ tFlag' = TRUE /\ kStored' = (WorkBefore >= Kneed) /\ impossibleAtDecision' = StoreImpossible
            /\ bst' = CutBst /\ byDecision' = CutBy
            /\ act' = [act EXCEPT !.ph = "done", !.res = (IF StoreImpossible THEN "blocked" ELSE "timed_out"), !.won = TRUE]
            /\ UNCHANGED <<joinOut, jLate, jRule>>
       ELSE IF pst = "pending" /\ JoinRule /\ JoinCount < Kneed
       THEN \* k is reached only with successes after the deadline: timed_out
            /\ pst' = "done" /\ pout' = "timed_out" /\ decisions' = decisions + 1 /\ tFlag' = TRUE
            /\ kStored' = (WorkBefore >= Kneed)
            /\ bst' = CutBst /\ byDecision' = CutBy
            /\ act' = [act EXCEPT !.ph = "done", !.res = "timed_out", !.won = TRUE]
            /\ UNCHANGED <<joinOut, jLate, jRule, wOrder, impossibleAtDecision>>
       ELSE IF pst = "pending"
       THEN /\ pst' = "done" /\ pout' = want /\ decisions' = decisions + 1
            /\ joinOut' = IF JoinRule THEN CheckedWinners ELSE Winners
            /\ jRule' = (jRule \/ JoinRule)
            /\ act' = [act EXCEPT !.ph = "done", !.res = want, !.won = TRUE]
            /\ jLate' = (jLate \/ (want = "joined" /\ HasTimer
                            /\ \E j \in 1..Len(joinOut') : wAt[joinOut'[j]] # "before"))
            /\ UNCHANGED <<tFlag, kStored, bst, byDecision, impossibleAtDecision>>
       ELSE /\ act' = [act EXCEPT !.ph = "done", !.res = pout, !.won = FALSE]
            /\ UNCHANGED <<pst, pout, joinOut, decisions, jLate, jRule, tFlag, kStored, bst, byDecision, impossibleAtDecision>>
    /\ UNCHANGED <<stTime, runEnded, paused, workVars, cb, order, ctl, want, ctlOut, ctTime, armed,
                   crashes, cans, pauses, dv, routes, early, pausedAtDecision,
                   startedAfter, routedAfter, notDueSeen, wAt, impSeen, joinDueSeen, wOrder, endFails, ctlPaused, routedWhilePaused, owed, runFailed, cmdQ>>

(* The timeout's compare-and-swap: only from pending, and only once the    *)
(* store's own clock reached the deadline; before it, the time left. With  *)
(* the decided rules (PJ-Q1, PJ-Q3): k successes stored by the deadline     *)
(* answer "join due" and decide nothing; k impossible decides blocked.     *)
TimeoutCount == IF TimeoutCounts = "work" THEN WorkBefore ELSE Cardinality(Succ(cb))
TimeoutOutcome == IF Rules = "decided" /\ StoreImpossible THEN "blocked" ELSE "timed_out"

TimeoutStore ==
    /\ act.k = "timeout" /\ act.ph = "sched"
    /\ IF pst = "pending" /\ (stTime = "after" \/ Fault = "no-store-guard") /\ Rules = "decided" /\ TimeoutCount >= Kneed
       THEN \* join due: nothing is decided; the work still running is cancelled at the time limit (J1b)
            /\ act' = [act EXCEPT !.ph = "done", !.res = "join_due", !.won = FALSE]
            /\ bst' = CutBst /\ byDecision' = CutBy
            /\ UNCHANGED <<pst, pout, decisions, early, kStored, pausedAtDecision, impossibleAtDecision, dv, tFlag>>
       ELSE IF pst = "pending" /\ (stTime = "after" \/ Fault = "no-store-guard")
       THEN /\ pst' = "done" /\ pout' = TimeoutOutcome /\ decisions' = decisions + 1 /\ tFlag' = TRUE
            /\ early' = (early \/ stTime = "before")
            /\ kStored' = (WorkBefore >= Kneed)
            /\ pausedAtDecision' = paused /\ dv' = cb
            /\ impossibleAtDecision' = IF Rules = "decided" THEN StoreImpossible ELSE Impossible(cb)
            /\ bst' = CutBst /\ byDecision' = CutBy
            /\ act' = [act EXCEPT !.ph = "done", !.res = TimeoutOutcome, !.won = TRUE]
       ELSE IF Fault = "no-cas" /\ pst = "done" /\ pout \in {"joined", "blocked"} /\ stTime = "after"
       THEN /\ pout' = "timed_out" /\ decisions' = decisions + 1
            /\ act' = [act EXCEPT !.ph = "done", !.res = "timed_out", !.won = TRUE]
            /\ UNCHANGED <<pst, early, kStored, pausedAtDecision, impossibleAtDecision, dv, tFlag, bst, byDecision>>
       ELSE /\ act' = [act EXCEPT !.ph = "done", !.res = (IF pst = "pending" THEN "not_due" ELSE pout), !.won = FALSE]
            /\ UNCHANGED <<pst, pout, decisions, early, kStored, pausedAtDecision, impossibleAtDecision, dv, tFlag, bst, byDecision>>
    /\ UNCHANGED <<joinOut, stTime, runEnded, paused, workVars, cb, order, ctl, want, ctlOut, ctTime,
                   armed, crashes, cans, pauses, routes, startedAfter, routedAfter, notDueSeen, wAt, impSeen, joinDueSeen, jLate, jRule, wOrder, endFails, ctlPaused, routedWhilePaused, owed, runFailed, cmdQ>>

(* cancelBranchScopes: the branches' pending work states are decided       *)
(* cancelled (an inactive run changes nothing). It returns every work      *)
(* state of these branches that this cancellation decided, this attempt's  *)
(* and an earlier one's, so a retry still sends the stop requests.         *)
CancelStore ==
    /\ act.k = "cancel" /\ act.ph = "sched"
    /\ LET newly == IF runEnded THEN {} ELSE {i \in act.list : bst[i] = "pending"}
           by2 == [i \in Idx |-> byDecision[i] \/ i \in newly]
       IN /\ bst' = [i \in Idx |-> IF i \in newly THEN "cancelled" ELSE bst[i]]
          /\ byDecision' = by2
          /\ act' = [act EXCEPT !.ph = "stored",
                       !.ret = (IF Fault = "cancel-retry-forgets" THEN newly ELSE {i \in act.list : by2[i]})]
    /\ UNCHANGED <<pst, pout, joinOut, stTime, runEnded, paused, workVars, cb, order, ctl, want, ctlOut, ctTime, armed,
                   crashes, cans, pauses, histVars, p2Vars>>

(* The stop requests after the transaction: a script's effect is asked to  *)
(* stop; an agent's child is ended (that end may fail).                    *)
CancelRequests ==
    /\ act.k = "cancel" /\ act.ph = "stored"
    /\ \E F \in SUBSET (act.ret \cap Agents) :
          LET spent == endFails >= MaxEndFail
          IN
          /\ (AllowEndFail \/ F = {})
          /\ (EndFailRetries /\ EndBudget = "forced" /\ ~EndForever => (F = {} \/ ~spent))
          /\ asked' = [i \in Idx |-> asked[i] \/ i \in act.ret]
          /\ endOk' = [i \in Idx |-> endOk[i] \/ i \in (act.ret \cap Agents) \ F]
          \* J1-R2: a failed end fails the activity; its durable retry enumerates the cancelled states again
          /\ IF EndFailRetries /\ F # {} /\ ~spent
             THEN /\ act' = [act EXCEPT !.ph = "sched"] /\ endFails' = endFails + 1
                  /\ UNCHANGED <<storeVars, ctl, owed, runFailed, cmdQ>>
             \* J1c (C1-1): the retry budget is spent; the error fails the run (controlWithFailure, failRun)
             ELSE IF EndFailRetries /\ F # {} /\ EndBudget = "fail-run"
             THEN /\ act' = NoAct /\ ctl' = "ended" /\ runEnded' = TRUE /\ paused' = FALSE /\ runFailed' = TRUE
                  /\ pst' = IF pst = "pending" THEN "done" ELSE pst
                  /\ pout' = IF pst = "pending" THEN "cancelled" ELSE pout
                  /\ bst' = [i \in Idx |-> IF bst[i] = "pending" THEN "cancelled" ELSE bst[i]]
                  /\ UNCHANGED <<byDecision, joinOut, stTime, endFails, owed>>
             \* J1d: the budget is spent; the ends are recorded owed and the run goes on (afterEnd or recover ends them)
             ELSE IF EndFailRetries /\ F # {} /\ EndBudget = "owe"
             THEN /\ act' = [act EXCEPT !.ph = "done", !.res = "ok"]
                  /\ owed' = [i \in Idx |-> owed[i] \/ i \in F]
                  /\ UNCHANGED <<storeVars, ctl, endFails, runFailed>>
             ELSE /\ act' = [act EXCEPT !.ph = "done", !.res = "ok"]
                  /\ UNCHANGED <<storeVars, ctl, endFails, owed, runFailed, cmdQ>>
    /\ UNCHANGED <<eff, cb, order, want, ctlOut, ctTime, armed, crashes, cans, pauses, histVars,
                   wAt, tFlag, impSeen, joinDueSeen, jLate, jRule, wOrder, ctlPaused, routedWhilePaused, cmdQ>>

(* A worker crash after the transaction, before the result is in history: *)
(* the activity runs again.                                                *)
WorkerCrash ==
    /\ act.k # "none" /\ act.ph \in {"stored", "done"} /\ crashes < MaxCrash
    /\ act' = [act EXCEPT !.ph = "sched", !.won = FALSE]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<storeVars, workVars, cb, order, ctl, want, ctlOut, ctTime, armed, cans, pauses, histVars, p2Vars>>

ScheduleCancel ==
    /\ act' = [NoAct EXCEPT !.k = "cancel", !.list = Active(cb)]
    /\ ctl' = "deciding" /\ UNCHANGED cb

FinishDecision ==
    /\ cb' = Drop(cb) /\ ctl' = "decided" /\ act' = NoAct

(* After the decision is known: cancel what still runs.                    *)
AfterDecision ==
    IF Active(cb) = {} THEN FinishDecision
    ELSE IF Fault = "cancel-only-if-won" /\ ~act.won THEN FinishDecision
    ELSE IF act.k = "timeout" /\ paused /\ PausedCancel = "resume"
         THEN /\ ctl' = "cancelPending" /\ act' = NoAct /\ UNCHANGED cb
    ELSE ScheduleCancel

(* The controller records the activity's result.                           *)
JoinAck ==
    /\ act.k = "join" /\ act.ph = "done"
    /\ ctlOut' = act.res
    /\ armed' = (armed /\ TimerStaysArmed)
    /\ IF act.res = "cancelled"
       THEN /\ ctl' = "ended" /\ act' = NoAct /\ UNCHANGED cb
       ELSE IF CancelFirst THEN FinishDecision ELSE AfterDecision
    /\ UNCHANGED <<storeVars, workVars, order, want, ctTime, crashes, cans, pauses, histVars, p2Vars>>

TimeoutAck ==
    /\ act.k = "timeout" /\ act.ph = "done"
    /\ CASE act.res = "not_due" ->
              /\ ctl' = "waiting" /\ ctTime' = "before" /\ act' = NoAct /\ notDueSeen' = TRUE
              /\ UNCHANGED <<cb, ctlOut, armed>>
         [] act.res = "join_due" ->
              \* k successes were stored by the deadline: the join decides, the timer is spent
              /\ ctl' = "waiting" /\ act' = NoAct /\ armed' = FALSE
              /\ UNCHANGED <<cb, ctlOut, ctTime, notDueSeen>>
         [] act.res = "cancelled" ->
              /\ ctl' = "ended" /\ act' = NoAct /\ ctlOut' = "cancelled"
              /\ UNCHANGED <<cb, ctTime, armed, notDueSeen>>
         [] act.res \in {"timed_out", "blocked"} /\ ctl = "deciding" ->
              /\ ctlOut' = act.res /\ armed' = FALSE
              /\ IF Fault = "timeout-keeps-cursors"
                 THEN /\ ctl' = "decided" /\ act' = NoAct /\ UNCHANGED cb
                 ELSE AfterDecision
              /\ UNCHANGED <<ctTime, notDueSeen>>
         [] OTHER ->
              \* the timer of a state already decided: the store's outcome stands
              /\ ctlOut' = act.res /\ act' = NoAct /\ armed' = FALSE
              /\ UNCHANGED <<cb, ctl, ctTime, notDueSeen>>
    /\ joinDueSeen' = (joinDueSeen \/ act.res = "join_due")
    /\ UNCHANGED <<storeVars, workVars, order, want, crashes, cans, pauses, dv, decisions, routes, early, kStored,
                   pausedAtDecision, impossibleAtDecision, startedAfter, routedAfter, wAt, tFlag, impSeen, jLate, jRule, wOrder, endFails, ctlPaused, routedWhilePaused, owed, runFailed, cmdQ>>

CancelAck ==
    /\ act.k = "cancel" /\ act.ph = "done"
    /\ cb' = Drop(cb)
    /\ IF ctlOut = "none"
       THEN /\ act' = [NoAct EXCEPT !.k = "join"] /\ UNCHANGED ctl     \* CancelFirst: the decision follows
       ELSE /\ ctl' = "decided" /\ act' = NoAct
    /\ UNCHANGED <<storeVars, workVars, order, want, ctlOut, ctTime, armed, crashes, cans, pauses, histVars, p2Vars>>

CancelAfterResume ==
    /\ ctl = "cancelPending" /\ ~paused /\ ~runEnded
    /\ ScheduleCancel
    /\ UNCHANGED <<storeVars, workVars, order, want, ctlOut, ctTime, armed, crashes, cans, pauses, histVars, p2Vars>>

(* Continue-as-new while the state waits: the cursor's deadline is carried. *)
Can ==
    /\ ctl = "waiting" /\ act.k = "none" /\ cans < MaxCan
    /\ cans' = cans + 1
    /\ armed' = (armed /\ Fault # "can-drops-deadline")
    /\ UNCHANGED <<storeVars, workVars, cb, order, ctl, want, ctlOut, act, ctTime, crashes, pauses, histVars, p2Vars>>

(* The parallel state's cursor collects its decided node and routes it.    *)
RouteParallel ==
    /\ ctl = "decided" /\ act.k = "none"
    /\ IF PauseSeen = "collect" THEN ~paused ELSE ~ctlPaused
    /\ ctl' = "routed" /\ routes' = routes + 1
    /\ routedWhilePaused' = (routedWhilePaused \/ paused)
    /\ UNCHANGED <<storeVars, workVars, cb, order, want, ctlOut, act, ctTime, armed, crashes, cans, pauses,
                   dv, decisions, early, kStored, pausedAtDecision, impossibleAtDecision, startedAfter, routedAfter, notDueSeen,
                   wAt, tFlag, impSeen, joinDueSeen, jLate, jRule, wOrder, endFails, ctlPaused, owed, runFailed, cmdQ>>

(* The states after it run, and the run ends (its afterEnd follows).       *)
RunFinish ==
    /\ ctl = "routed" /\ ~BusyAfter
    /\ ctl' = "ended"
    /\ bst' = [i \in Idx |-> IF bst[i] = "pending" THEN "cancelled" ELSE bst[i]]
    /\ UNCHANGED <<pst, pout, byDecision, joinOut, stTime, runEnded, paused, workVars, cb, order, want, ctlOut, act,
                   ctTime, armed, crashes, cans, pauses, histVars, p2Vars>>

(* J1d-R1: the run goes on after the parallel state with a ready result in *)
(* every pass: the controller never reaches its idle wait, and continue-as- *)
(* new may happen between passes. The run does not end in these cases.     *)
BusyStart ==
    /\ ctl = "routed" /\ BusyAfter
    /\ ctl' = "busy"
    /\ UNCHANGED <<storeVars, workVars, cb, order, want, ctlOut, act, ctTime, armed, crashes, cans, pauses, histVars, p2Vars>>

(* A cancel, a deletion or the run's deadline: every pending node is       *)
(* decided cancelled in one transaction.                                   *)
RunEnd ==
    /\ AllowRunEnd /\ ~runEnded /\ ctl # "ended"
    /\ runEnded' = TRUE /\ paused' = FALSE
    /\ pst' = IF pst = "pending" THEN "done" ELSE pst
    /\ pout' = IF pst = "pending" THEN "cancelled" ELSE pout
    /\ bst' = [i \in Idx |-> IF bst[i] = "pending" THEN "cancelled" ELSE bst[i]]
    /\ UNCHANGED <<byDecision, joinOut, stTime, workVars, ctlVars, histVars, p2Vars>>

(* J1C-1: a cancel command is queued for the controller, which takes it   *)
(* only between activities (not inside a retry loop of one).               *)
Command ==
    /\ AllowRunEnd /\ ~cmdQ /\ ~runEnded /\ ctl \notin {"init", "ended"}
    /\ cmdQ' = TRUE
    /\ UNCHANGED <<storeVars, workVars, ctlVars, histVars, wAt, tFlag, impSeen, joinDueSeen, jLate, jRule, wOrder, endFails,
                   ctlPaused, routedWhilePaused, owed, runFailed>>
TakeCommand ==
    /\ cmdQ /\ act.k = "none" /\ ctl \notin {"init", "ended"}
    /\ cmdQ' = FALSE /\ ctl' = "ended" /\ runEnded' = TRUE /\ paused' = FALSE
    /\ pst' = IF pst = "pending" THEN "done" ELSE pst
    /\ pout' = IF pst = "pending" THEN "cancelled" ELSE pout
    /\ bst' = [i \in Idx |-> IF bst[i] = "pending" THEN "cancelled" ELSE bst[i]]
    /\ UNCHANGED <<byDecision, joinOut, stTime, workVars, cb, order, want, ctlOut, act, ctTime, armed, crashes, cans, pauses,
                   histVars, wAt, tFlag, impSeen, joinDueSeen, jLate, jRule, wOrder, endFails, ctlPaused, routedWhilePaused,
                   owed, runFailed>>

(* The controller finds the run ended (an admission, a collection or an    *)
(* activity's answer).                                                     *)
CtlSeesEnd ==
    /\ runEnded /\ ctl # "ended"
    /\ ctl' = "ended" /\ act' = NoAct
    /\ UNCHANGED <<storeVars, workVars, cb, order, want, ctlOut, ctTime, armed, crashes, cans, pauses, histVars, p2Vars>>

(* J1d (874af832, retryOwedCuts): the controller tries an owed end again   *)
(* between its steps, at its idle wait and in the paused collector, running *)
(* or paused, until the run ends. A failed retry changes nothing (a        *)
(* stutter); with EndForever every retry fails. The backstop period that   *)
(* spaces the retries is not modeled.                                       *)
(* J1e (68079fed): retryOwedCuts at the top of every pass, busy or idle,   *)
(* and at the first pass after continue-as-new ("every-pass"). J1d's set   *)
(* ("idle-paused") over-approximates its idle wait and paused collector:   *)
(* it never includes a busy pass.                                          *)
RetryCtl == IF RetryAt = "every-pass" THEN {"waiting", "cancelPending", "decided", "routed", "busy"}
            ELSE {"waiting", "cancelPending", "decided", "routed"}
RetryOwed(i) ==
    /\ EndBudget = "owe" /\ ~EndForever
    /\ owed[i] /\ ~endOk[i] /\ eff[i] \in {"starting", "running"}
    /\ act.k = "none" /\ ctl \in RetryCtl
    /\ endOk' = [endOk EXCEPT ![i] = TRUE] /\ asked' = [asked EXCEPT ![i] = TRUE]
    /\ UNCHANGED <<storeVars, eff, ctlVars, histVars, p2Vars>>

(* afterEnd ends the children of the run's decided agent states; at J1d    *)
(* this includes every owed child (endWorkflowRunAgents).                *)
AfterEnd(i) ==
    /\ ctl = "ended" /\ i \in Agents /\ eff[i] \in {"starting", "running"} /\ ~endOk[i]
    /\ endOk' = [endOk EXCEPT ![i] = TRUE] /\ asked' = [asked EXCEPT ![i] = TRUE]
    /\ UNCHANGED <<storeVars, eff, ctlVars, histVars, p2Vars>>

Pause ==
    /\ AllowPause /\ pauses < 1 /\ ~paused /\ ~runEnded /\ ctl \in {"waiting", "deciding", "decided"}
    /\ paused' = TRUE /\ pauses' = pauses + 1
    /\ UNCHANGED <<pst, pout, bst, byDecision, joinOut, stTime, runEnded, workVars, cb, order, ctl, want, ctlOut, act,
                   ctTime, armed, crashes, cans, histVars, p2Vars>>

Resume ==
    /\ paused /\ paused' = FALSE
    /\ UNCHANGED <<pst, pout, bst, byDecision, joinOut, stTime, runEnded, workVars, ctlVars, histVars, p2Vars>>

(* The work. A script starts only while its state is pending (enterScript); *)
(* an agent child is not kept when its state was decided first.            *)
EffStart(i) ==
    /\ eff[i] = "starting"
    /\ eff' = [eff EXCEPT ![i] = IF bst[i] = "pending" THEN "running" ELSE "stopped"]
    /\ UNCHANGED <<storeVars, asked, endOk, ctlVars, histVars, p2Vars>>

EffFinish(i) ==
    /\ i \notin Hang /\ eff[i] = "running"
    /\ eff' = [eff EXCEPT ![i] = "done"]
    /\ IF bst[i] = "pending"
       THEN /\ \E r \in {"succeeded"} \cup (IF i \in CanFail THEN {"failed"} ELSE {}) :
                    /\ bst' = [bst EXCEPT ![i] = r]
                    /\ wOrder' = IF r = "succeeded" THEN Append(wOrder, i) ELSE wOrder
            /\ wAt' = [wAt EXCEPT ![i] = stTime]
       ELSE UNCHANGED <<bst, wAt, wOrder>>
    /\ UNCHANGED <<pst, pout, byDecision, joinOut, stTime, runEnded, paused, asked, endOk, ctlVars, histVars,
                   tFlag, impSeen, joinDueSeen, jLate, jRule, endFails, ctlPaused, routedWhilePaused, owed, runFailed, cmdQ>>

(* A script's liveness check stops it once its state is decided; an agent  *)
(* child stops once its end is recorded.                                   *)
EffStop(i) ==
    /\ eff[i] = "running"
    /\ IF i \in Agents THEN endOk[i] ELSE bst[i] # "pending"
    /\ eff' = [eff EXCEPT ![i] = "stopped"]
    /\ UNCHANGED <<storeVars, asked, endOk, ctlVars, histVars, p2Vars>>

(* A hung work keeps running; the run ended and its work settled.          *)
HangIdle == (\E i \in Hang : eff[i] = "running") /\ UNCHANGED vars
Done == ctl = "ended" /\ (\A i \in Idx : eff[i] \notin {"starting", "running"}) /\ UNCHANGED vars
BusyIdle == ctl = "busy" /\ UNCHANGED vars

Next ==
    \/ Enter \/ TimerFire \/ CtlTick \/ StoreTick
    \/ JoinStore \/ TimeoutStore \/ CancelStore \/ CancelRequests \/ WorkerCrash
    \/ JoinAck \/ TimeoutAck \/ CancelAck \/ CancelAfterResume \/ Can \/ AdmitRefused \/ CtlSeesResume \/ Command \/ TakeCommand
    \/ RouteParallel \/ RunFinish \/ RunEnd \/ CtlSeesEnd \/ Pause \/ Resume
    \/ \E i \in Idx : StartBranch(i) \/ Collect(i) \/ AdmitTerminal(i) \/ AfterEnd(i) \/ RetryOwed(i)
                      \/ EffStart(i) \/ EffFinish(i) \/ EffStop(i)
    \/ BusyStart \/ HangIdle \/ Done \/ BusyIdle

Spec == Init /\ [][Next]_vars

(* Fairness for the branch actions is on their disjunction over the       *)
(* branches: each such action fires at most a bounded number of times per  *)
(* branch, so no branch starves. A quantifier over Idx around a temporal   *)
(* formula is avoided: with N = 0 TLC reported a counterexample that       *)
(* satisfies every property (p1, par.n0-all and par.n0-first; MF-P1).      *)
Fairness ==
    /\ WF_vars(Enter) /\ WF_vars(TimerFire) /\ WF_vars(CtlTick) /\ WF_vars(StoreTick)
    /\ WF_vars(JoinStore) /\ WF_vars(TimeoutStore) /\ WF_vars(CancelStore) /\ WF_vars(CancelRequests)
    /\ WF_vars(JoinAck) /\ WF_vars(TimeoutAck) /\ WF_vars(CancelAck) /\ WF_vars(CancelAfterResume)
    /\ WF_vars(RouteParallel) /\ WF_vars(RunFinish) /\ WF_vars(BusyStart) /\ WF_vars(CtlSeesEnd) /\ WF_vars(AdmitRefused) /\ WF_vars(CtlSeesResume) /\ WF_vars(TakeCommand)
    /\ WF_vars(\E i \in Idx : StartBranch(i)) /\ WF_vars(\E i \in Idx : Collect(i))
    /\ WF_vars(\E i \in Idx : AdmitTerminal(i)) /\ WF_vars(\E i \in Idx : AfterEnd(i))
    /\ WF_vars(\E i \in Idx : RetryOwed(i))
    /\ WF_vars(\E i \in Idx : EffStart(i)) /\ WF_vars(\E i \in Idx : EffStop(i))
    /\ WF_vars(\E i \in Idx \ Hang : EffFinish(i))
    /\ WF_vars(ResumeFair /\ Resume)

LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK ==
    /\ pst \in {"none", "pending", "done"} /\ pout \in Outcomes
    /\ bst \in [Idx -> {"none", "pending", "succeeded", "failed", "cancelled"}]
    /\ byDecision \in [Idx -> BOOLEAN] /\ joinOut \in Seq(Idx)
    /\ stTime \in {"before", "after"} /\ ctTime \in {"before", "after"}
    /\ {runEnded, paused, armed, early, kStored, pausedAtDecision, impossibleAtDecision,
        startedAfter, routedAfter, notDueSeen} \subseteq BOOLEAN
    /\ eff \in [Idx -> {"none", "starting", "running", "done", "stopped"}]
    /\ asked \in [Idx -> BOOLEAN] /\ endOk \in [Idx -> BOOLEAN]
    /\ cb \in [Idx -> CbStates] /\ dv \in [Idx -> CbStates] /\ order \in Seq(Idx)
    /\ ctl \in {"init", "waiting", "deciding", "cancelPending", "decided", "routed", "busy", "ended"}
    /\ want \in {"none", "joined", "blocked", "timed_out"} /\ ctlOut \in Outcomes
    /\ act.k \in {"none", "join", "timeout", "cancel"} /\ act.ph \in {"sched", "stored", "done"}
    /\ act.res \in Results /\ act.won \in BOOLEAN /\ act.list \subseteq Idx /\ act.ret \subseteq Idx
    /\ crashes \in 0..MaxCrash /\ cans \in 0..MaxCan /\ pauses \in 0..1
    /\ decisions \in 0..2 /\ routes \in 0..2
    /\ wAt \in [Idx -> {"none", "before", "after"}] /\ {tFlag, impSeen, joinDueSeen, jLate, jRule} \subseteq BOOLEAN /\ wOrder \in Seq(Idx) /\ endFails \in 0..MaxEndFail
    /\ {ctlPaused, routedWhilePaused, runFailed} \subseteq BOOLEAN /\ owed \in [Idx -> BOOLEAN] /\ cmdQ \in BOOLEAN

(* Exactly one decision; the controller acts on the stored one.            *)
Inv_OneDecision == decisions <= 1 /\ (ctlOut # "none" /\ pst = "done" => ctlOut = pout)
(* Joined only with k successes, and its output is exactly the k winners.  *)
Inv_JoinedNeedsK == pout = "joined" => (Len(joinOut) = Kneed /\ \A j \in 1..Len(joinOut) : bst[joinOut[j]] = "succeeded")
(* The winners are the first k to finish, in the order they finished.      *)
Inv_WinnersFirstK == pout = "joined" =>
    IF jRule THEN Len(joinOut) = Kneed /\ \A j \in 1..Len(joinOut) : OnTime(joinOut[j])
    ELSE Len(order) = Kneed /\ joinOut = SubSeq(order, 1, Kneed)
(* Blocked only when k successes are impossible (or n < k at entry).       *)
(* MF-P2: with the decided rules the store's count decides (failures      *)
(* committed on time), which the controller may not have collected yet.    *)
Inv_BlockedOnlyWhenImpossible == pout = "blocked" =>
    (N < Kneed \/ Cardinality(Failed(dv)) + Kneed > N \/ (Rules = "decided" /\ impossibleAtDecision))
(* failFast false: blocked only after every branch ended.                  *)
Inv_FailFastFalseWaits == (pout = "blocked" /\ ~FailFast /\ N >= Kneed /\ ~tFlag) => \A i \in Idx : dv[i] \in {"succeeded", "failed"}
(* A branch that ended before the decision keeps how it ended.             *)
Inv_ReportKeepsFinished == (pst = "done" /\ pout \in {"blocked", "timed_out"}) =>
                              \A i \in Idx : dv[i] \in {"succeeded", "failed"} => cb[i] = dv[i]
(* No branch starts, and no branch result is routed, after the decision.   *)
Inv_NoStartAfterDecision == ~startedAfter
Inv_NoRouteAfterDecision == ~routedAfter
(* A queued branch that the decision left is never started.                *)
Inv_QueuedNeverStarted == \A i \in Idx : cb[i] = "not_started" => (bst[i] = "none" /\ eff[i] = "none")
Inv_Concurrency == /\ Cardinality(Active(cb)) <= Conc
                   /\ Cardinality({i \in Idx : eff[i] \in {"starting", "running"} /\ bst[i] = "pending"}) <= Conc
Inv_RoutedOnce == routes <= 1
(* The store's clock decides the timeout.                                  *)
Inv_NoEarlyTimeout == ~early
(* A branch the controller dropped has no pending work state.              *)
Inv_DroppedBranchDecided == \A i \in Idx : cb[i] = "cancelled" => bst[i] # "pending"
(* Every branch the decision cancelled was asked to stop.                  *)
Inv_CancelAckedMeansAsked == \A i \in Idx : (cb[i] = "cancelled" /\ byDecision[i]) => asked[i]

(* p2, the decided rules. PJ-Q1: k successes whose work was stored by the *)
(* deadline are never timed_out. PJ-Q3: once k is impossible, the outcome  *)
(* is blocked (a time limit after it keeps blocked, with timedOut).        *)
Inv_FinishedWorkWins == ~(pout = "timed_out" /\ kStored)
Inv_NoLateJoin == ~jLate
(* R2-RT-1: no branch result is routed while the run is paused.            *)
Inv_NoRouteWhilePaused == ~routedWhilePaused
(* J1-R2: when the parallel state routes, every running losing agent child *)
(* has its end recorded.                                                   *)
(* MF-P3: a run ended by a cancel or its deadline routes nothing further;  *)
(* afterEnd ends its children.                                             *)
Inv_LoserEndedBeforeRoute == (ctl = "routed" /\ ~runEnded) =>
    \A i \in Agents : (cb[i] = "cancelled" /\ eff[i] \in {"starting", "running"}) => (endOk[i] \/ owed[i])
(* J1b amendment 1: the joined output is the first k on-time successes in  *)
(* commit order.                                                           *)
Inv_WinnersCommitOrder == (pout = "joined" /\ jRule /\ JoinCheck = "work") =>
    joinOut = SubSeq(SelectSeq(wOrder, OnTime), 1, Kneed)
Inv_BlockedStaysBlocked == pout = "timed_out" => ~impossibleAtDecision
(* J1d: a cut decides only work that was still running: a winner's work,  *)
(* stored succeeded, is never decided cancelled, and a joined state's      *)
(* winners keep their success.                                             *)
Inv_WinnersNeverCut ==
    /\ \A i \in Idx : byDecision[i] => bst[i] = "cancelled"
    /\ pout = "joined" => \A j \in 1..Len(joinOut) : ~byDecision[joinOut[j]] /\ bst[joinOut[j]] = "succeeded"

(* Witnesses: each is expected to be violated, which shows the behavior   *)
(* is reachable.                                                           *)
W_NotJoined == pout # "joined"
W_NotBlocked == pout # "blocked"
W_NotTimedOut == pout # "timed_out"
W_WinnersInIndexOrder == pout = "joined" => joinOut = SeqOfSet(Range(joinOut))
W_TimeoutNotWithKStored == ~(pout = "timed_out" /\ kStored)
W_NotTimedOutWhilePaused == ~(pout = "timed_out" /\ pausedAtDecision)
W_NoTimeoutAfterImpossible == ~(pout = "timed_out" /\ impossibleAtDecision)
W_LoserNotRunningAfterRoute == ~(ctl = "routed" /\ \E i \in Agents : cb[i] = "cancelled" /\ eff[i] = "running")
W_FinishedWorkNotReportedCancelled == ~(pout \in {"blocked", "timed_out"} /\ \E i \in Idx : dv[i] = "toTerminal")
W_LateResultNotStored == ~(\E i \in Idx : cb[i] = "cancelled" /\ bst[i] \in {"succeeded", "failed"})
W_NoNotDue == ~notDueSeen
W_NoJoinDue == ~joinDueSeen
W_NotBlockedByTimer == ~(pout = "blocked" /\ tFlag)
W_NoLateJoin == ~jLate
(* J1d: a loser's end is recorded owed; an owed end is completed by the    *)
(* controller's retry while the run is paused.                             *)
W_NoOwed == ~(\E i \in Idx : owed[i])
W_OwedNotRetriedWhilePaused == ~(\E i \in Idx : owed[i] /\ endOk[i] /\ paused /\ ctl # "ended")
W_NoCheckedJoin == ~jRule
W_WinnersAdmissionOrder == pout = "joined" => joinOut = SubSeq(order, 1, Kneed)

(* Progress, under Fairness.                                               *)
Prop_Decided == (pst = "pending") ~> (pst = "done")
Prop_Routed == (pst = "done") ~> (ctl \in {"routed", "ended"})
Running == {i \in Idx : eff[i] \in {"starting", "running"}}
PendingWork == {i \in Idx : bst[i] = "pending"}
Prop_CancelledStops == (pst = "done") ~> (Running = {})
Prop_BranchesSettle == (pst = "done") ~> (PendingWork = {})
(* J1C-1: a decided join is routed, unless something outside the controller *)
(* ended the run; the controller never fails the run over a loser's end.    *)
(* MF-P4 (p4): the target uses the route count, not ctl = "routed": a      *)
(* finished run's controller has left "routed" while the antecedent still  *)
(* holds, so a leads-to on the control state failed after a normal finish. *)
Prop_JoinRouted == (pout = "joined" /\ ~runEnded) ~> (routes >= 1 \/ (runEnded /\ ~runFailed))
(* J1d: every owed end is completed in the end (afterEnd or recover).     *)
OwedOpen == {i \in Idx : owed[i] /\ ~endOk[i] /\ eff[i] \in {"starting", "running"}}
Prop_OwedEnded == (OwedOpen # {}) ~> (OwedOpen = {})
(* J1C-1: the controller stays controllable: a queued command is taken,   *)
(* unless the run ended first (a command for a finished run is moot).      *)
Prop_CommandTaken == cmdQ ~> (~cmdQ \/ runEnded \/ ctl = "ended")
=============================================================================
