----------------------------- MODULE WfForkJoin -----------------------------
(***************************************************************************)
(* Option A of the Workflow fork + join, as a design model before code: *)
(* one fork state starts NB named branches; each branch has its OWN small *)
(* body graph of work states (a script or an agent state) with routes and *)
(* a branch-local error route, ending at a succeeded terminal (End) or a  *)
(* failed one (Fail); a join decides once and passes { name: output } of  *)
(* its winners on.                                                         *)
(*                                                                          *)
(* Sources. The intended design (the fork + join assignment of            *)
(* 2026-11-07) and the design investigation of the fork + join            *)
(* (option A: branches: { name: { initial, states } }, each branch compiled *)
(* by the existing body compiler, one scope per branch). The join rules are *)
(* the k-of-n join the For each state implements at b236778a, which option *)
(* A reuses unchanged (parallel.ts parallelVerdict 265-290, the store's     *)
(* one count settleParallelIn and parallelBranchesIn, store.ts 6966-7065;   *)
(* cancelBranchScopes 6827-6864; elapseParallelNode 6902-6930;             *)
(* decideParallelJoin 6948-6964; runtime.ts selectRoute and the catch-all, *)
(* 1248-1295). Reused from ../parallel/WorkflowParallel.tla: the split of *)
(* each store activity into its transaction and its answer, the crash that *)
(* re-runs an activity, the cancellation and its stop requests, the pause. *)
(* Reused from ../orchestration/WfGraph.tla: node executions with          *)
(* deterministic ids, cursors per scope, routes and the failure route, the *)
(* catch-all, the global node limit, the graceful stop and the cancel.     *)
(*                                                                          *)
(* A branch's success is counted by the store when the work that routes to *)
(* its succeeded terminal commits (in time, if there is a time limit); it  *)
(* is confirmed when that terminal is admitted. Joined needs k confirmed   *)
(* successes; past the time limit with k successes the join is due (the   *)
(* rest is cut, the winners' terminals are admitted, then the join).       *)
(* A worker crash after a transaction re-runs that activity; a controller  *)
(* replay is no step (every controller input is an activity's result, and  *)
(* node ids derive from visit, scope, state and ordinal).                  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    NB,           \* named branches 1..NB (the names are the indexes)
    Two,          \* branches whose body is W1 -ok-> W2 -> End, W1 -alt-> Fail
    Err,          \* branches whose body is W1 -ok-> End, W1 -error-> E (branch-local error route), E -ok-> End, E -alt-> Fail
    Loop,         \* branches whose body is W1 -ok-> End, W1 -alt-> W1 (a branch-local loop)
                  \* every other branch: W1 -ok/alt-> End
    AgentBr,      \* branches whose W1 is an agent state (the others are scripts)
    CanFail,      \* branches whose work may end with a runtime error
    Hang,         \* branches whose W1 never ends by itself
    K,            \* join: { first: K }
    JoinAll,      \* join: all
    Conc,         \* branches running at a time
    FailFast,     \* blocked as soon as k is impossible
    HasTimer,     \* the fork has a time limit
    ForkRoutes,   \* the fork's routes: "all" (joined, blocked, error), "noTimeout" (joined, blocked),
                  \* "retry" (blocked and error go back to the fork)
    HasCatchAll,  \* the workflow has a catch-all state H
    Limit,        \* maxNodeExecutions, counted across the root and every branch
    AllowPause, ResumeFair, AllowStop, AllowCancel,
    MaxCrash,     \* worker crashes after a transaction, before its result is recorded
    EntryErr,     \* fj2 (code da66611a runtime.ts 3700-3743): a branch input or the inputSchema fails at entry (invalid_input)
    StopFence,    \* fj3 NB-R2: "fork" (the rule): after an accepted stop the fork's join and time limit settle nothing;
                  \* "none" (code at 3f3e96fb): they still decide, cut started work and write a report
    AllJoinPath,  \* fj3 NB-R5: join all, no time limit, failFast: "store" (the rule: verdict, cut and decision in one
                  \* transaction) or "two-step" (code at 3f3e96fb: cancelBranchScopes first, the decision later)
    Fault         \* a deliberate fault, or "none"

Faults == {"none", "per-branch-limit", "exec-id-unqualified", "model-key-unqualified", "route-global",
           "branch-catchall", "no-cas", "admit-after-decision", "cut-returns-new-only", "stop-cuts-started",
           "count-late", "winners-by-index", "count-old-visit", "no-cut"}

ASSUME NB \in Nat /\ NB >= 1 /\ K \in 1..NB /\ Conc \in 1..NB /\ Limit \in Nat /\ Limit >= 2
ASSUME {Two, Err, Loop, AgentBr, CanFail, Hang} \subseteq SUBSET (1..NB)
ASSUME Two \cap Err = {} /\ Two \cap Loop = {} /\ Err \cap Loop = {}
ASSUME {JoinAll, FailFast, HasTimer, HasCatchAll, AllowPause, ResumeFair, AllowStop, AllowCancel} \subseteq BOOLEAN
ASSUME ForkRoutes \in {"all", "noTimeout", "retry"}
(* fj3 NB-R6 (compile rule): joined and blocked need routes; with timeoutSeconds timed_out needs its route ("all" and *)
(* "retry" give the fork an error route); the catch-all never takes the fork's timed_out.                           *)
ASSUME HasTimer => ForkRoutes \in {"all", "retry"}
ASSUME StopFence \in {"fork", "none"} /\ AllJoinPath \in {"store", "two-step"}
ASSUME MaxCrash \in Nat /\ EntryErr \in BOOLEAN /\ Fault \in Faults

Br == 1..NB
Scopes == 0..NB
MaxIds == Limit + 1
Ids == 1..MaxIds
Vis == 1..Limit
Kneed == IF JoinAll THEN NB ELSE K
Live == {"running", "paused"}
Ended == {"completed", "failed", "cancelled"}
Terms == {"End", "Fail"}
CutWins == {"join", "failFast", "timeout", "end", "stop"}
RepStates == {"none", "succeeded", "failed", "cancelled", "late", "not_started"}

Max(S) == CHOOSE x \in S : \A y \in S : y <= x
Min(S) == CHOOSE x \in S : \A y \in S : x <= y

----------------------------------------------------------------------------
(* The branch bodies. Outcomes "ok" and "alt" are business outcomes;      *)
(* "boom" (an effect's error) and "cancel" (a cut or a run end) are       *)
(* runtime errors, which take the state's error route "@f" if it has one. *)
Shape(b) == IF b \in Two THEN "two" ELSE IF b \in Err THEN "err" ELSE IF b \in Loop THEN "loop" ELSE "one"
NodesOf(sh) == CASE sh = "two" -> {"W1", "W2", "End", "Fail"}
                 [] sh = "err" -> {"W1", "E", "End", "Fail"}
                 [] OTHER -> {"W1", "End", "Fail"}
LocalNext(sh, n, r) ==
    CASE sh = "one" /\ n = "W1" /\ r \in {"ok", "alt"} -> "End"
      [] sh = "two" /\ n = "W1" /\ r = "ok" -> "W2"
      [] sh = "two" /\ n = "W1" /\ r = "alt" -> "Fail"
      [] sh = "two" /\ n = "W2" /\ r \in {"ok", "alt"} -> "End"
      [] sh = "err" /\ n = "W1" /\ r = "ok" -> "End"
      [] sh = "err" /\ n = "W1" /\ r = "@f" -> "E"
      [] sh = "err" /\ n = "E" /\ r = "ok" -> "End"
      [] sh = "err" /\ n = "E" /\ r = "alt" -> "Fail"
      [] sh = "loop" /\ n = "W1" /\ r = "ok" -> "End"
      [] sh = "loop" /\ n = "W1" /\ r = "alt" -> "W1"
      [] OTHER -> "none"
(* selectRoute: a business outcome takes its own route; a runtime error   *)
(* its error route. "none" when no route takes it.                        *)
BRoute(sh, n, out) ==
    IF out \in {"ok", "alt"} THEN (IF LocalNext(sh, n, out) # "none" THEN out ELSE "none")
    ELSE IF LocalNext(sh, n, "@f") # "none" THEN "@f" ELSE "none"
BTarget(sh, n, out) == LET r == BRoute(sh, n, out) IN IF r = "none" THEN "none" ELSE LocalNext(sh, n, r)
(* A route's target is resolved in its own branch. Fault route-global: in *)
(* one name space, the first branch with a state of that name.            *)
TScope(b, t) == IF Fault = "route-global" THEN Min({c \in Br : t \in NodesOf(Shape(c))}) ELSE b

(* The root: F (the fork), T and U (terminals), H (the catch-all).        *)
RootNext(n, r) ==
    CASE n = "F" /\ r = "joined" -> "T"
      [] n = "F" /\ r = "blocked" /\ ForkRoutes \in {"all", "noTimeout"} -> "U"
      [] n = "F" /\ r = "blocked" /\ ForkRoutes = "retry" -> "F"
      [] n = "F" /\ r = "@f" /\ ForkRoutes = "all" -> "U"
      [] n = "F" /\ r = "@f" /\ ForkRoutes = "retry" -> "F"
      [] n = "H" /\ r = "ok" -> "T"
      [] OTHER -> "none"
(* joined and blocked are business outcomes; timed_out and invalid_input   *)
(* (an entry error, fj2) runtime errors.                                   *)
RootTarget(n, out) == IF out \in {"joined", "blocked", "ok"} THEN RootNext(n, out) ELSE RootNext(n, "@f")

----------------------------------------------------------------------------
VARIABLES
    \* the store
    ne,       \* node executions: [Ids -> row]
    runSt,    \* "running", "paused", "completed", "failed", "cancelled"
    why,      \* why the run ended: "none", "finish", "limit", "unrouted", "stop", "cancel"
    stopReq,  \* a graceful stop was accepted
    stopDue,  \* its grace period ended
    stTime,   \* the store's clock against the current fork visit's deadline: "before", "after"
    rep,      \* [Vis -> [Br -> status]]: each visit's report, written by its decision
    fwin,     \* [Vis -> SUBSET Br]: the winners, whose outputs make { name: output }
    fdec,     \* [Vis -> Nat]: decisions (compare-and-swaps that decided the fork row)
    fids,     \* [Vis -> 0..MaxIds]: the fork row of each visit
    ctr,      \* the store's commit counter (the commit order)
    \* the work
    eff,      \* [Ids -> "none", "running", "done", "stopped"]: a work row's effect or agent child
    asked,    \* [Ids -> BOOLEAN]: asked to stop (the child's end is recorded)
    \* the controller
    rc,       \* the root cursor
    bc,       \* [Br -> cursor]: one per branch of the current visit
    fv,       \* the current fork visit (0: none yet)
    fs,       \* the fork's controller phase
    act,      \* the activity in flight
    steps,    \* node admissions (maxNodeExecutions counts these)
    nrows,    \* rows created (an admission that found its id returns that row)
    scount,   \* admissions per scope (read only by the per-branch-limit fault)
    caEntered, stopping, cEnded, crashes, pauses,
    cdone,    \* [Vis -> BOOLEAN]: that visit's losers were cut and dropped
    gh        \* ghost flags (history, read by no action)

storeV == <<ne, runSt, why, stopReq, stopDue, stTime, rep, fwin, fdec, fids, ctr>>
workV == <<eff, asked>>
ctlV == <<rc, bc, fv, fs, act, steps, nrows, scount, caEntered, stopping, cEnded, crashes, pauses, cdone>>
vars == <<storeV, workV, ctlV, gh>>

NoRow == [st |-> "free", sc |-> 0, nd |-> "none", by |-> 0, vis |-> 0, ord |-> 0, pr |-> 0,
          out |-> "none", win |-> "none", cn |-> 0, it |-> TRUE]
NewRow(st, s, n, by, v, o, p) == [st |-> st, sc |-> s, nd |-> n, by |-> by, vis |-> v, ord |-> o, pr |-> p,
                                  out |-> "none", win |-> "none", cn |-> 0, it |-> TRUE]
NoCur == [st |-> "idle", ns |-> 0, nd |-> "none", pend |-> 0, pr |-> 0]
NoAct == [k |-> "none", ph |-> "sched", res |-> "none", ret |-> {}, from |-> "none"]

Init ==
    /\ ne = [i \in Ids |-> NoRow]
    /\ runSt = "running" /\ why = "none" /\ stopReq = FALSE /\ stopDue = FALSE /\ stTime = "before"
    /\ rep = [v \in Vis |-> [b \in Br |-> "none"]] /\ fwin = [v \in Vis |-> {}]
    /\ fdec = [v \in Vis |-> 0] /\ fids = [v \in Vis |-> 0] /\ ctr = 0
    /\ eff = [i \in Ids |-> "none"] /\ asked = [i \in Ids |-> FALSE]
    /\ rc = [on |-> TRUE, nd |-> "F", pend |-> 0]
    /\ bc = [b \in Br |-> NoCur] /\ fv = 0 /\ fs = "none" /\ act = NoAct
    /\ steps = 0 /\ nrows = 0 /\ scount = [s \in Scopes |-> 0]
    /\ caEntered = FALSE /\ stopping = FALSE /\ cEnded = FALSE /\ crashes = 0 /\ pauses = 0
    /\ cdone = [v \in Vis |-> FALSE] /\ gh = {}

----------------------------------------------------------------------------
(* Deterministic node-execution ids: (visit, scope, state, ordinal). Fault *)
(* exec-id-unqualified leaves the branch scope out.                        *)
OrdOf(v, s, n) == Cardinality({j \in Ids : ne[j].st # "free" /\ ne[j].vis = v /\ ne[j].sc = s /\ ne[j].nd = n}) + 1
KeyOf(v, s, n, o) == IF Fault = "exec-id-unqualified" THEN <<v, 0, n, o>> ELSE <<v, s, n, o>>
RowKey(j) == KeyOf(ne[j].vis, ne[j].sc, ne[j].nd, ne[j].ord)

IsAgentRow(i) == ne[i].st # "free" /\ ne[i].sc \in AgentBr /\ ne[i].nd = "W1"
(* The key the per-node model choice (agentModels) is stored under.        *)
ModelKey(i) == IF Fault = "model-key-unqualified" THEN <<0, ne[i].nd>> ELSE <<ne[i].sc, ne[i].nd>>

ForkPending == IF fv = 0 THEN FALSE ELSE ne[fids[fv]].st = "pending"
ForkDone == IF fv = 0 THEN FALSE ELSE ne[fids[fv]].st = "done"
Past == stTime = "after"

----------------------------------------------------------------------------
(* The store's one count (parallelBranchStates): each branch read from its *)
(* last row in this visit.                                                 *)
BRows(v, b) == {i \in Ids : ne[i].st # "free" /\ ne[i].sc = b /\ ne[i].vis # 0
                            /\ (ne[i].vis = v \/ Fault = "count-old-visit")}
NoBS == [k |-> "none", succ |-> FALSE, fail |-> FALSE, done |-> FALSE, conf |-> FALSE, cn |-> 0, it |-> TRUE, cut |-> FALSE]
BS(v, b) ==
    LET R == BRows(v, b) IN
    IF R = {} THEN NoBS
    ELSE LET r == ne[Max(R)] IN
         IF r.nd \in Terms
         THEN LET p == IF r.pr \in Ids THEN (IF ne[r.pr].st = "done" THEN ne[r.pr] ELSE r) ELSE r
              IN [k |-> "terminal", succ |-> r.nd = "End", fail |-> r.nd = "Fail", done |-> TRUE, conf |-> TRUE,
                  cn |-> p.cn, it |-> p.it, cut |-> FALSE]
         ELSE IF r.st = "pending" THEN [NoBS EXCEPT !.k = "running"]
         ELSE LET t == BTarget(Shape(b), r.nd, r.out)
                  ct == r.win \in CutWins
              IN CASE t = "none" -> [k |-> "error", succ |-> FALSE, fail |-> TRUE, done |-> TRUE, conf |-> FALSE,
                                      cn |-> r.cn, it |-> r.it, cut |-> ct]
                   [] t = "End" -> [k |-> "finished", succ |-> TRUE, fail |-> FALSE, done |-> FALSE, conf |-> FALSE,
                                     cn |-> r.cn, it |-> r.it, cut |-> ct]
                   [] t = "Fail" -> [k |-> "finished", succ |-> FALSE, fail |-> TRUE, done |-> FALSE, conf |-> FALSE,
                                      cn |-> r.cn, it |-> r.it, cut |-> ct]
                   [] OTHER -> [NoBS EXCEPT !.k = "running", !.cut = ct]

(* A success counts when its work committed in time (fault count-late:    *)
(* late ones count too); a failure when committed in time. Cut rows count *)
(* neither (the code excludes a time-limit cut; the others only exist     *)
(* after the decision).                                                   *)
CSucc0(v, b) == LET s == BS(v, b) IN s.succ /\ ~s.cut /\ s.it
CSucc(v, b) == LET s == BS(v, b) IN s.succ /\ ~s.cut /\ (s.it \/ Fault = "count-late")
CFail(v, b) == LET s == BS(v, b) IN s.fail /\ ~s.cut /\ s.it
Late(v, b) == LET s == BS(v, b) IN (s.succ \/ s.fail) /\ ~s.cut /\ ~s.it
SuccSet(v) == {b \in Br : CSucc(v, b)}
FailSet(v) == {b \in Br : CFail(v, b)}
CN(v, b) == BS(v, b).cn
Before(v, c, b) == CN(v, c) < CN(v, b) \/ (CN(v, c) = CN(v, b) /\ c < b)
(* The winners: the first k successes in the store's commit order (ties  *)
(* by index); every branch for join all.                                  *)
WinnersOf(v) ==
    LET S == SuccSet(v) IN
    IF JoinAll THEN S
    ELSE IF Fault = "winners-by-index" THEN {b \in S : Cardinality({c \in S : c < b}) < Kneed}
    ELSE {b \in S : Cardinality({c \in S : Before(v, c, b)}) < Kneed}
CommitWinners(v) ==
    LET S == {b \in Br : CSucc0(v, b)} IN
    IF JoinAll THEN S ELSE {b \in S : Cardinality({c \in S : Before(v, c, b)}) < Kneed}
IndexWinners(v) ==
    LET S == {b \in Br : CSucc0(v, b)} IN {b \in S : Cardinality({c \in S : c < b}) < Kneed}
Impossible(v) == Cardinality(FailSet(v)) + Kneed > NB

(* parallelVerdict; tl: the time limit asks (elapse), else the join asks. *)
Verdict(v, tl) ==
    IF Cardinality(SuccSet(v)) >= Kneed
    THEN (IF ~tl /\ \A b \in WinnersOf(v) : BS(v, b).conf THEN "joined"
          ELSE IF Past THEN "due" ELSE "wait")
    ELSE IF Past THEN (IF Impossible(v) THEN "blocked" ELSE "timed_out")
    ELSE IF Impossible(v) /\ (FailFast \/ \A b \in Br : BS(v, b).done) THEN "blocked"
    ELSE "wait"

(* The report: every branch, once.                                        *)
RepOf(v, W) == [b \in Br |->
    IF b \in W \/ CSucc(v, b) THEN "succeeded"
    ELSE IF CFail(v, b) THEN "failed"
    ELSE IF BRows(v, b) = {} THEN "not_started"
    ELSE IF Late(v, b) THEN "late"
    ELSE "cancelled"]

(* cancelBranchWorkIn: pending work (never a terminal) of the scopes not  *)
(* in keep is decided cancelled, winner w.                                *)
CutRows(v, keep, w) ==
    [i \in Ids |-> IF ne[i].st = "pending" /\ ne[i].vis = v /\ ne[i].sc \in Br \ keep /\ ne[i].nd \notin Terms
                   THEN [ne[i] EXCEPT !.st = "done", !.out = "cancel", !.win = w, !.cn = ctr + 1, !.it = (stTime = "before")]
                   ELSE ne[i]]
CutRowsF(v, keep, w) == IF Fault = "no-cut" THEN ne ELSE CutRows(v, keep, w)

(* Every end of the run: one transaction decides every pending row.       *)
EndRows(w) ==
    [i \in Ids |-> IF ne[i].st = "pending"
                   THEN [ne[i] EXCEPT !.st = "done", !.out = "cancel", !.win = w, !.cn = ctr + 1, !.it = (stTime = "before")]
                   ELSE ne[i]]
EndRun(status, reason) ==
    /\ runSt' = status /\ why' = reason
    /\ ne' = EndRows(IF reason = "stop" THEN "stop" ELSE "end")
    /\ ctr' = ctr + 1

LimitReached(s) == IF Fault = "per-branch-limit" THEN scount[s] >= Limit ELSE steps >= Limit

(* startBranches: queued branches start in name order, Conc at a time.    *)
Fill(c) == [b \in Br |->
    IF c[b].st = "queued"
       /\ Cardinality({x \in Br : x < b /\ c[x].st = "queued"}) + Cardinality({x \in Br : c[x].st = "active"}) < Conc
    THEN [c[b] EXCEPT !.st = "active"] ELSE c[b]]
(* After the decision: running branches cancelled, queued not_started.   *)
Drop(c, W) == [b \in Br |->
    IF b \in W THEN c[b]
    ELSE IF c[b].st = "active" THEN [c[b] EXCEPT !.st = "cancelled", !.pend = 0]
    ELSE IF c[b].st = "queued" THEN [c[b] EXCEPT !.st = "not_started"]
    ELSE c[b]]

(* When the controller may admit or route in branch b. After a due join   *)
(* only the winners' terminals are admitted.                               *)
BranchMay(b, n) ==
    \/ fs = "waiting"
    \/ (fs = "due" /\ b \in WinnersOf(fv) /\ (n \in Terms \/ n = "route"))
    \/ (Fault = "admit-after-decision" /\ fs = "decided")

(* A branch ended: the controller asks the join.                          *)
AskJoin ==
    IF fs \in {"waiting", "due"}
    THEN /\ act' = [NoAct EXCEPT !.k = "join", !.from = fs] /\ fs' = "joining"
    ELSE UNCHANGED <<act, fs>>
(* fj3 NB-R5 (code at 3f3e96fb, runtime.ts 1448-1457, 1558-1571, 5282-5303): join all with no time limit and   *)
(* failFast: a failed branch first cancels the others (cancelBranchScopes), and the decision follows in a      *)
(* later transaction. "store": the branch end asks the store, which cuts and decides in one transaction.       *)
TwoStep == AllJoinPath = "two-step" /\ JoinAll /\ ~HasTimer /\ FailFast
BranchFailed ==
    IF TwoStep /\ fs = "waiting"
    THEN /\ act' = [NoAct EXCEPT !.k = "cut", !.from = "precut"] /\ fs' = "precut"
    ELSE AskJoin

----------------------------------------------------------------------------
(* The controller. Each step is one activity and its recorded result.     *)

(* Admit the root cursor's state: the fork, a terminal or the catch-all.  *)
AdmitRoot ==
    /\ ~cEnded /\ act.k = "none" /\ ~stopping /\ runSt = "running" /\ ~stopReq
    /\ rc.on /\ rc.pend = 0 /\ ~LimitReached(0) /\ nrows < MaxIds
    /\ steps' = steps + 1 /\ scount' = [scount EXCEPT ![0] = @ + 1]
    /\ LET n == rc.nd
           id == nrows + 1
           o == OrdOf(0, 0, n)
       IN CASE n = "F" ->
                 \* fj2: an entry error decides the state invalid_input at once, and no branch starts
                 /\ \E bad \in (IF EntryErr THEN BOOLEAN ELSE {FALSE}) :
                      IF bad
                      THEN /\ ne' = [ne EXCEPT ![id] = [NewRow("done", 0, n, 0, 0, o, 0) EXCEPT !.out = "invalid_input",
                                                            !.win = "controller", !.cn = ctr + 1]]
                           /\ ctr' = ctr + 1
                           /\ bc' = [b \in Br |-> NoCur] /\ fs' = "decided"
                      ELSE /\ ne' = [ne EXCEPT ![id] = NewRow("pending", 0, n, 0, 0, o, 0)]
                           /\ bc' = Fill([b \in Br |-> [st |-> "queued", ns |-> b, nd |-> "W1", pend |-> 0, pr |-> 0]])
                           /\ fs' = "waiting"
                           /\ UNCHANGED ctr
                 /\ nrows' = id /\ fv' = fv + 1 /\ fids' = [fids EXCEPT ![fv + 1] = id]
                 /\ rc' = [rc EXCEPT !.pend = id] /\ stTime' = "before"
                 /\ UNCHANGED <<runSt, why, eff, cEnded>>
            [] n \in {"T", "U"} ->
                 /\ LET ne1 == [ne EXCEPT ![id] = [NewRow("done", 0, n, 0, 0, o, 0) EXCEPT !.out = "ok", !.win = "controller"]]
                    IN ne' = [i \in Ids |-> IF ne1[i].st = "pending"
                                            THEN [ne1[i] EXCEPT !.st = "done", !.out = "cancel", !.win = "end", !.cn = ctr + 1]
                                            ELSE ne1[i]]
                 /\ ctr' = ctr + 1 /\ nrows' = id /\ runSt' = "completed" /\ why' = "finish" /\ cEnded' = TRUE
                 /\ rc' = [rc EXCEPT !.pend = id]
                 /\ UNCHANGED <<fv, fids, stTime, bc, fs, eff>>
            [] OTHER ->
                 /\ ne' = [ne EXCEPT ![id] = NewRow("pending", 0, n, 0, 0, o, 0)]
                 /\ eff' = [eff EXCEPT ![id] = "running"]
                 /\ nrows' = id /\ rc' = [rc EXCEPT !.pend = id]
                 /\ UNCHANGED <<runSt, why, ctr, fv, fids, stTime, bc, fs, cEnded>>
    /\ UNCHANGED <<stopReq, stopDue, rep, fwin, fdec, asked, act, caEntered, stopping, crashes, pauses, cdone, gh>>

(* Admit branch b's next state: a work state, or its terminal (endBranch). *)
AdmitBranch(b) ==
    /\ ~cEnded /\ act.k = "none" /\ ~stopping /\ runSt = "running" /\ ~stopReq
    /\ bc[b].st = "active" /\ bc[b].pend = 0 /\ ~LimitReached(b) /\ nrows < MaxIds
    /\ BranchMay(b, bc[b].nd)
    /\ (bc[b].nd \in Terms \/ ~Past)   \* fj2: past the time limit only a terminal is admitted
    /\ LET n == bc[b].nd
           s == bc[b].ns
           v == fv
           o == OrdOf(v, s, n)
           dup == {j \in Ids : ne[j].st # "free" /\ RowKey(j) = KeyOf(v, s, n, o)}
           id == nrows + 1
       IN /\ steps' = steps + 1 /\ scount' = [scount EXCEPT ![b] = @ + 1]
          /\ gh' = gh \cup (IF ForkDone THEN {"startedAfter"} ELSE {})
          /\ IF n \in Terms
             THEN /\ ne' = [ne EXCEPT ![id] = [NewRow("done", s, n, b, v, o, bc[b].pr) EXCEPT
                                !.out = IF n = "End" THEN "succ" ELSE "fail", !.win = "controller", !.cn = ctr + 1]]
                  /\ ctr' = ctr + 1 /\ nrows' = id
                  /\ LET c1 == [bc EXCEPT ![b] = [@ EXCEPT !.st = IF n = "End" THEN "succeeded" ELSE "failed", !.pend = 0]]
                     IN bc' = IF fs = "waiting" THEN Fill(c1) ELSE c1
                  /\ IF n = "Fail" THEN BranchFailed ELSE AskJoin
                  /\ UNCHANGED eff
             ELSE IF dup # {}
             THEN /\ bc' = [bc EXCEPT ![b].pend = Min(dup)]
                  /\ UNCHANGED <<ne, ctr, nrows, eff, act, fs>>
             ELSE /\ ne' = [ne EXCEPT ![id] = NewRow("pending", s, n, b, v, o, bc[b].pr)]
                  /\ eff' = [eff EXCEPT ![id] = "running"]
                  /\ nrows' = id /\ bc' = [bc EXCEPT ![b].pend = id]
                  /\ UNCHANGED <<ctr, act, fs>>
    /\ UNCHANGED <<runSt, why, stopReq, stopDue, stTime, rep, fwin, fdec, fids, asked, rc, fv,
                   caEntered, stopping, cEnded, crashes, pauses, cdone>>

(* fj2 (code da66611a store.ts 3587-3599, runtime.ts 1732-1736, cutBranch *)
(* 1568-1575): once the state's time limit passed, the store refuses a     *)
(* branch's next work state (only a terminal is admitted). The controller  *)
(* ends that branch (cancelled, or not_started before its first state),    *)
(* starts no queued branch, and asks the join.                              *)
AdmitRefusedPast(b) ==
    /\ ~cEnded /\ act.k = "none" /\ ~stopping /\ runSt = "running" /\ ~stopReq
    /\ HasTimer /\ Past /\ fs = "waiting"
    /\ bc[b].st = "active" /\ bc[b].pend = 0 /\ bc[b].nd \notin Terms /\ ~LimitReached(b)
    /\ bc' = [c \in Br |-> IF c = b THEN [bc[c] EXCEPT !.st = "cancelled"]
                           ELSE IF bc[c].st = "queued" THEN [bc[c] EXCEPT !.st = "not_started"]
                           ELSE bc[c]]
    /\ AskJoin
    /\ gh' = gh \cup {"pastCut"}
    /\ UNCHANGED <<storeV, workV, rc, fv, steps, nrows, scount, caEntered, stopping, cEnded, crashes, pauses, cdone>>

(* Collect a branch's decided row and route it inside its branch. No      *)
(* route: the branch failed (never the catch-all; fault branch-catchall). *)
RouteBranch(b) ==
    /\ ~cEnded /\ act.k = "none" /\ ~stopping /\ runSt = "running"
    /\ bc[b].st = "active" /\ bc[b].pend # 0
    /\ ne[bc[b].pend].st = "done"
    /\ BranchMay(b, "route")
    /\ LET i == bc[b].pend
           n == bc[b].nd
           sh == Shape(bc[b].ns)
           out == ne[i].out
           t == BTarget(sh, n, out)
           toCa == t = "none" /\ Fault = "branch-catchall" /\ HasCatchAll /\ ~caEntered /\ out \in {"boom", "cancel"}
           esc == (t # "none" /\ TScope(b, t) # b) \/ toCa
       IN /\ gh' = gh \cup (IF ForkDone THEN {"routedAfter"} ELSE {})
                          \cup (IF esc THEN {"escaped"} ELSE {})
                          \cup (IF BRoute(sh, n, out) = "@f" THEN {"errRoute"} ELSE {})
                          \cup (IF t = n THEN {"loop"} ELSE {})
          /\ IF toCa
             THEN /\ bc' = [bc EXCEPT ![b] = [st |-> "active", ns |-> 0, nd |-> "H", pend |-> 0, pr |-> i]]
                  /\ caEntered' = TRUE
                  /\ UNCHANGED <<act, fs>>
             ELSE IF t = "none"
             THEN /\ LET c1 == [bc EXCEPT ![b] = [@ EXCEPT !.st = "failed", !.pend = 0, !.pr = i]]
                     IN bc' = IF fs = "waiting" THEN Fill(c1) ELSE c1
                  /\ BranchFailed
                  /\ UNCHANGED caEntered
             ELSE /\ bc' = [bc EXCEPT ![b] = [@ EXCEPT !.ns = TScope(b, t), !.nd = t, !.pend = 0, !.pr = i]]
                  /\ UNCHANGED <<act, fs, caEntered>>
    /\ UNCHANGED <<storeV, workV, rc, fv, steps, nrows, scount, stopping, cEnded, crashes, pauses, cdone>>

(* Collect the catch-all's row and route it at the root.                  *)
RouteRoot ==
    /\ ~cEnded /\ act.k = "none" /\ ~stopping /\ runSt = "running"
    /\ rc.on /\ rc.nd = "H" /\ rc.pend # 0
    /\ ne[rc.pend].st = "done"
    /\ LET t == RootTarget("H", ne[rc.pend].out) IN
       IF t # "none"
       THEN /\ rc' = [on |-> TRUE, nd |-> t, pend |-> 0]
            /\ UNCHANGED <<runSt, why, ne, ctr, cEnded>>
       ELSE /\ EndRun("failed", "unrouted") /\ cEnded' = TRUE
            /\ UNCHANGED rc
    /\ UNCHANGED <<stopReq, stopDue, stTime, rep, fwin, fdec, fids, workV, bc, fv, fs, act, steps, nrows, scount,
                   caEntered, stopping, crashes, pauses, cdone, gh>>

(* The node limit: an admission at the limit fails the run (finishRun).   *)
Wants(s) == IF s = 0 THEN rc.on /\ rc.pend = 0
            ELSE bc[s].st = "active" /\ bc[s].pend = 0 /\ BranchMay(s, bc[s].nd)
AdmitLimit ==
    /\ ~cEnded /\ act.k = "none" /\ ~stopping /\ runSt = "running" /\ ~stopReq
    /\ \E s \in Scopes : Wants(s) /\ LimitReached(s)
    /\ EndRun("failed", "limit") /\ cEnded' = TRUE
    /\ UNCHANGED <<stopReq, stopDue, stTime, rep, fwin, fdec, fids, workV, rc, bc, fv, fs, act, steps, nrows, scount,
                   caEntered, stopping, crashes, pauses, cdone, gh>>

(* The fork's time limit: the controller's timer fires; elapse asks.      *)
TimerFire ==
    /\ HasTimer /\ Past /\ fs = "waiting" /\ act.k = "none" /\ ~cEnded
    /\ (~stopping \/ StopFence = "none")   \* NB-R2: at 3f3e96fb the fork is elapsed before the stopping collector
    /\ act' = [NoAct EXCEPT !.k = "timeout", !.from = "waiting"] /\ fs' = "timing"
    /\ UNCHANGED <<storeV, workV, rc, bc, fv, steps, nrows, scount, caEntered, stopping, cEnded, crashes, pauses, cdone, gh>>

(* The join's or the time limit's transaction (decideParallelJoin,        *)
(* elapseParallelNode): the store's one count decides by compare-and-swap  *)
(* and cuts the losers' work in the same transaction.                     *)
DecideFork(v, out, W, w) ==
    /\ ne' = [CutRowsF(v, W, w) EXCEPT ![fids[v]] = [@ EXCEPT !.st = "done", !.out = out, !.win = "controller",
                                                              !.cn = ctr + 1, !.it = TRUE]]
    /\ ctr' = ctr + 1
    /\ rep' = [rep EXCEPT ![v] = RepOf(v, W)]
    /\ fwin' = [fwin EXCEPT ![v] = W]
    /\ fdec' = [fdec EXCEPT ![v] = @ + 1]

DecisionTx ==
    /\ act.k \in {"join", "timeout"} /\ act.ph = "sched"
    /\ LET v == fv
           f == fids[fv]
           V == Verdict(v, act.k = "timeout")
           W == IF V = "joined" THEN WinnersOf(v) ELSE {}
           w == IF V = "joined" THEN "join" ELSE IF Past THEN "timeout" ELSE "failFast"
           pnd == ne[f].st = "pending"
           redo == Fault = "no-cas" /\ ne[f].st = "done" /\ ne[f].out \in {"joined", "blocked", "timed_out"}
           fenced == StopFence = "fork" /\ stopReq /\ pnd
           late == IF stopReq /\ pnd THEN {"settledAfterStop"} ELSE {}
       IN IF fenced
          THEN \* NB-R2: an accepted stop: nothing settles; the controller learns the stop
               /\ act' = [act EXCEPT !.ph = "done", !.res = "stopped"]
               /\ UNCHANGED <<ne, ctr, rep, fwin, fdec, gh>>
          ELSE IF (pnd \/ redo) /\ V \in {"joined", "blocked", "timed_out"}
          THEN /\ DecideFork(v, V, W, w)
               /\ act' = [act EXCEPT !.ph = "done", !.res = "won"]
               /\ gh' = gh \cup late
          ELSE IF pnd /\ V = "due"
          THEN /\ ne' = CutRowsF(v, WinnersOf(v), "timeout") /\ ctr' = ctr + 1
               /\ act' = [act EXCEPT !.ph = "done", !.res = "due"]
               /\ gh' = gh \cup late
               /\ UNCHANGED <<rep, fwin, fdec>>
          ELSE /\ act' = [act EXCEPT !.ph = "done", !.res = IF pnd THEN "wait" ELSE "decided"]
               /\ UNCHANGED <<ne, ctr, rep, fwin, fdec, gh>>
    /\ UNCHANGED <<runSt, why, stopReq, stopDue, stTime, fids, workV, rc, bc, fv, fs, steps, nrows, scount,
                   caEntered, stopping, cEnded, crashes, pauses, cdone>>

DecisionAck ==
    /\ act.k \in {"join", "timeout"} /\ act.ph = "done" /\ ~cEnded
    /\ IF act.res = "stopped"
       THEN /\ fs' = act.from /\ act' = NoAct /\ stopping' = TRUE /\ UNCHANGED gh
       ELSE IF act.res = "wait"
       THEN /\ fs' = act.from /\ act' = NoAct /\ UNCHANGED gh
       ELSE IF act.res = "due"
       THEN \* join due: the winners' terminals are admitted, then the join is asked (at once if they all were)
            /\ gh' = gh \cup {"due"}
            /\ IF \A b \in WinnersOf(fv) : BS(fv, b).conf
               THEN /\ fs' = "joining" /\ act' = [NoAct EXCEPT !.k = "join", !.from = "due"]
               ELSE /\ fs' = "due" /\ act' = NoAct
       ELSE IF ne[fids[fv]].out = "cancel"
       THEN /\ act' = NoAct /\ UNCHANGED <<fs, gh>>
       ELSE /\ fs' = "cutting" /\ act' = [NoAct EXCEPT !.k = "cut"] /\ UNCHANGED gh
    /\ IF act.res = "stopped" THEN TRUE ELSE UNCHANGED stopping
    /\ UNCHANGED <<storeV, workV, rc, bc, fv, steps, nrows, scount, caEntered, cEnded, crashes, pauses, cdone>>

(* cancelBranchScopes for the losers: it decides what is still pending and *)
(* returns every row any cut decided, so a retry still asks them to stop.  *)
CutReason == LET o == ne[fids[fv]].out IN
             IF o = "joined" THEN "join" ELSE IF Past THEN "timeout" ELSE "failFast"
CutTx ==
    /\ act.k = "cut" /\ act.ph = "sched"
    /\ LET v == fv
           L == Br \ fwin[fv]
           newly == IF runSt \in Live /\ Fault # "no-cut"
                    THEN {i \in Ids : ne[i].st = "pending" /\ ne[i].vis = v /\ ne[i].sc \in L /\ ne[i].nd \notin Terms}
                    ELSE {}
           ne2 == [i \in Ids |-> IF i \in newly
                                 THEN [ne[i] EXCEPT !.st = "done", !.out = "cancel", !.win = CutReason,
                                                    !.cn = ctr + 1, !.it = (stTime = "before")]
                                 ELSE ne[i]]
           all == {i \in Ids : ne2[i].st = "done" /\ ne2[i].vis = v /\ ne2[i].sc \in L
                               /\ ne2[i].win \in {"join", "failFast", "timeout"}}
       IN /\ ne' = ne2 /\ ctr' = ctr + 1
          /\ act' = [act EXCEPT !.ph = "stored", !.ret = IF Fault = "cut-returns-new-only" THEN newly ELSE all]
    /\ UNCHANGED <<runSt, why, stopReq, stopDue, stTime, rep, fwin, fdec, fids, workV, rc, bc, fv, fs,
                   steps, nrows, scount, caEntered, stopping, cEnded, crashes, pauses, cdone, gh>>

(* The stop requests: an effect is asked to stop, an agent child ended.   *)
CutReq ==
    /\ act.k = "cut" /\ act.ph = "stored"
    /\ asked' = [i \in Ids |-> asked[i] \/ i \in act.ret]
    /\ act' = [act EXCEPT !.ph = "done"]
    /\ UNCHANGED <<storeV, eff, rc, bc, fv, fs, steps, nrows, scount, caEntered, stopping, cEnded, crashes, pauses, cdone, gh>>

CutAck ==
    /\ act.k = "cut" /\ act.ph = "done" /\ ~cEnded
    /\ IF act.from = "precut"
       THEN \* NB-R5 two-step: the others are cut; the decision is a later transaction
            /\ bc' = Drop(bc, {}) /\ fs' = "joining" /\ act' = [NoAct EXCEPT !.k = "join", !.from = "waiting"]
            /\ UNCHANGED cdone
       ELSE \* fault admit-after-decision: the controller keeps the losers' cursors
            /\ bc' = IF Fault = "admit-after-decision" THEN bc ELSE Drop(bc, fwin[fv])
            /\ fs' = "decided" /\ act' = NoAct
            /\ cdone' = [cdone EXCEPT ![fv] = TRUE]
    /\ UNCHANGED <<storeV, workV, rc, fv, steps, nrows, scount, caEntered, stopping, cEnded, crashes, pauses, gh>>

(* A worker crash after the transaction, before the result is in history. *)
WorkerCrash ==
    /\ act.k # "none" /\ act.ph \in {"stored", "done"} /\ crashes < MaxCrash
    /\ act' = [act EXCEPT !.ph = "sched"] /\ crashes' = crashes + 1
    /\ UNCHANGED <<storeV, workV, rc, bc, fv, fs, steps, nrows, scount, caEntered, stopping, cEnded, pauses, cdone, gh>>

(* The root cursor routes the fork's decision; the visit is over.         *)
RouteFork ==
    /\ fs = "decided" /\ act.k = "none" /\ ~cEnded /\ runSt = "running" /\ ~stopping
    /\ LET out == ne[fids[fv]].out
           t == RootTarget("F", out)
       IN IF t # "none"
          THEN /\ rc' = [on |-> TRUE, nd |-> t, pend |-> 0]
               /\ UNCHANGED <<runSt, why, ne, ctr, caEntered, cEnded>>
          ELSE IF out \notin {"joined", "blocked"} /\ HasCatchAll /\ ~caEntered
          THEN /\ rc' = [on |-> TRUE, nd |-> "H", pend |-> 0] /\ caEntered' = TRUE
               /\ UNCHANGED <<runSt, why, ne, ctr, cEnded>>
          ELSE /\ EndRun("failed", "unrouted") /\ cEnded' = TRUE
               /\ UNCHANGED <<rc, caEntered>>
    /\ fs' = "none" /\ bc' = [b \in Br |-> NoCur]
    /\ UNCHANGED <<stopReq, stopDue, stTime, rep, fwin, fdec, fids, workV, fv, act, steps, nrows, scount,
                   stopping, crashes, pauses, cdone, gh>>

(* The controller learns a stop (a refused admission or the collection).  *)
CtlSeesStop ==
    /\ stopReq /\ ~stopping /\ ~cEnded /\ act.k = "none"
    /\ stopping' = TRUE
    /\ UNCHANGED <<storeV, workV, rc, bc, fv, fs, act, steps, nrows, scount, caEntered, cEnded, crashes, pauses, cdone, gh>>

(* The stop transaction: once no work is pending (started work finished), *)
(* or at the grace deadline, the run ends cancelled (reason stop).        *)
NoPendingWork == \A i \in Ids : ne[i].st = "pending" => ne[i].nd = "F"
StopEnd ==
    /\ stopping /\ ~cEnded /\ act.k = "none"
    /\ (NoPendingWork \/ stopDue \/ Fault = "stop-cuts-started")
    /\ IF runSt \in Live
       THEN /\ EndRun("cancelled", "stop")
            /\ gh' = gh \cup (IF ~stopDue /\ ~NoPendingWork THEN {"stopCut"} ELSE {})
       ELSE UNCHANGED <<runSt, why, ne, ctr, gh>>
    /\ cEnded' = TRUE
    /\ UNCHANGED <<stopReq, stopDue, stTime, rep, fwin, fdec, fids, workV, rc, bc, fv, fs, act, steps, nrows, scount,
                   caEntered, stopping, crashes, pauses, cdone>>

CtlSeesEnd ==
    /\ runSt \in Ended /\ ~cEnded
    /\ cEnded' = TRUE /\ act' = NoAct
    /\ UNCHANGED <<storeV, workV, rc, bc, fv, fs, steps, nrows, scount, caEntered, stopping, crashes, pauses, cdone, gh>>

(* afterEnd ends the children of the run's agent states.                  *)
AfterEnd(i) ==
    /\ cEnded /\ eff[i] = "running" /\ IsAgentRow(i) /\ ~asked[i]
    /\ asked' = [asked EXCEPT ![i] = TRUE]
    /\ UNCHANGED <<storeV, eff, ctlV, gh>>

----------------------------------------------------------------------------
(* The environment.                                                        *)
StoreTick ==
    /\ HasTimer /\ ForkPending /\ stTime = "before"
    /\ stTime' = "after"
    /\ UNCHANGED <<ne, runSt, why, stopReq, stopDue, rep, fwin, fdec, fids, ctr, workV, ctlV, gh>>

Pause ==
    /\ AllowPause /\ pauses = 0 /\ runSt = "running"
    /\ runSt' = "paused" /\ pauses' = 1
    /\ UNCHANGED <<ne, why, stopReq, stopDue, stTime, rep, fwin, fdec, fids, ctr, workV,
                   rc, bc, fv, fs, act, steps, nrows, scount, caEntered, stopping, cEnded, crashes, cdone, gh>>
Resume ==
    /\ runSt = "paused" /\ runSt' = "running"
    /\ UNCHANGED <<ne, why, stopReq, stopDue, stTime, rep, fwin, fdec, fids, ctr, workV, ctlV, gh>>
RequestStop ==
    /\ AllowStop /\ runSt \in Live /\ ~stopReq
    /\ stopReq' = TRUE
    /\ UNCHANGED <<ne, runSt, why, stopDue, stTime, rep, fwin, fdec, fids, ctr, workV, ctlV, gh>>
StopGrace ==
    /\ stopReq /\ ~stopDue
    /\ stopDue' = TRUE
    /\ UNCHANGED <<ne, runSt, why, stopReq, stTime, rep, fwin, fdec, fids, ctr, workV, ctlV, gh>>
(* Cancel now: the store ends the run in one transaction.                  *)
CancelNow ==
    /\ AllowCancel /\ runSt \in Live
    /\ EndRun("cancelled", "cancel")
    /\ UNCHANGED <<stopReq, stopDue, stTime, rep, fwin, fdec, fids, workV, ctlV, gh>>

HangRow(i) == ne[i].sc \in Hang /\ ne[i].nd = "W1"
Outs(i) == IF ne[i].sc = 0 THEN {"ok"}
           ELSE IF ne[i].sc \in CanFail THEN {"ok", "alt", "boom"} ELSE {"ok", "alt"}

(* A work state's effect or agent child ends and decides its row (a       *)
(* compare-and-swap from pending: a row decided first stays).             *)
EffFinish(i) ==
    /\ eff[i] = "running" /\ ~HangRow(i)
    /\ eff' = [eff EXCEPT ![i] = "done"]
    /\ IF ne[i].st = "pending"
       THEN \E out \in Outs(i) :
               /\ ne' = [ne EXCEPT ![i] = [@ EXCEPT !.st = "done", !.out = out, !.win = "effect",
                                                    !.cn = ctr + 1, !.it = (stTime = "before")]]
               /\ ctr' = ctr + 1
       ELSE UNCHANGED <<ne, ctr>>
    /\ UNCHANGED <<runSt, why, stopReq, stopDue, stTime, rep, fwin, fdec, fids, asked, ctlV, gh>>

(* A script's liveness check stops it once its row is decided; an agent  *)
(* child stops once its end is recorded.                                   *)
EffStop(i) ==
    /\ eff[i] = "running" /\ ne[i].st = "done"
    /\ (IsAgentRow(i) => asked[i])
    /\ eff' = [eff EXCEPT ![i] = "stopped"]
    /\ UNCHANGED <<storeV, asked, ctlV, gh>>

HangIdle == (\E i \in Ids : eff[i] = "running" /\ HangRow(i)) /\ UNCHANGED vars
Done == cEnded /\ (\A i \in Ids : eff[i] # "running") /\ UNCHANGED vars

Controller ==
    \/ AdmitRoot \/ RouteRoot \/ RouteFork \/ AdmitLimit \/ TimerFire
    \/ DecisionTx \/ DecisionAck \/ CutTx \/ CutReq \/ CutAck \/ WorkerCrash
    \/ CtlSeesStop \/ StopEnd \/ CtlSeesEnd
    \/ \E b \in Br : AdmitBranch(b) \/ RouteBranch(b) \/ AdmitRefusedPast(b)
    \/ \E i \in Ids : AfterEnd(i)
Environment ==
    \/ StoreTick \/ Pause \/ Resume \/ RequestStop \/ StopGrace \/ CancelNow
    \/ \E i \in Ids : EffFinish(i) \/ EffStop(i)

Next == Controller \/ Environment \/ HangIdle \/ Done

Spec == Init /\ [][Next]_vars

Fairness ==
    /\ WF_vars(AdmitRoot) /\ WF_vars(RouteRoot) /\ WF_vars(RouteFork) /\ WF_vars(AdmitLimit) /\ WF_vars(TimerFire)
    /\ WF_vars(DecisionTx) /\ WF_vars(DecisionAck) /\ WF_vars(CutTx) /\ WF_vars(CutReq) /\ WF_vars(CutAck)
    /\ WF_vars(CtlSeesStop) /\ WF_vars(StopEnd) /\ WF_vars(CtlSeesEnd)
    /\ WF_vars(\E b \in Br : AdmitBranch(b)) /\ WF_vars(\E b \in Br : RouteBranch(b)) /\ WF_vars(\E b \in Br : AdmitRefusedPast(b))
    /\ WF_vars(\E i \in Ids : AfterEnd(i)) /\ WF_vars(\E i \in Ids : EffFinish(i)) /\ WF_vars(\E i \in Ids : EffStop(i))
    /\ WF_vars(StoreTick) /\ WF_vars(StopGrace) /\ WF_vars(ResumeFair /\ Resume)

LiveSpec == Spec /\ Fairness

----------------------------------------------------------------------------
TypeOK ==
    /\ runSt \in Live \cup Ended
    /\ why \in {"none", "finish", "limit", "unrouted", "stop", "cancel"}
    /\ fs \in {"none", "waiting", "joining", "timing", "due", "cutting", "precut", "decided"}
    /\ act.k \in {"none", "join", "timeout", "cut"} /\ act.ph \in {"sched", "stored", "done"}
    /\ steps \in 0..(Limit + 1) /\ nrows \in 0..MaxIds /\ fv \in 0..Limit
    /\ \A b \in Br : bc[b].st \in {"idle", "queued", "active", "succeeded", "failed", "cancelled", "not_started"}
    /\ \A v \in Vis : \A b \in Br : rep[v][b] \in RepStates

EnteredVis == 1..fv
ForkOut(v) == IF fids[v] = 0 THEN "none" ELSE IF ne[fids[v]].st = "pending" THEN "pending" ELSE ne[fids[v]].out
Decided(v) == ForkOut(v) \in {"joined", "blocked", "timed_out"}

(* Exactly one decision per fork visit.                                    *)
Inv_OneDecision == \A v \in Vis : fdec[v] <= 1
(* Joined with exactly k confirmed winners; { name: output } holds them.  *)
Inv_JoinedK == \A v \in EnteredVis : ForkOut(v) = "joined" =>
    /\ Cardinality(fwin[v]) = Kneed
    /\ \A b \in fwin[v] : BS(v, b).conf /\ rep[v][b] = "succeeded"
(* The winners are the first k successes in the store's commit order.     *)
Inv_WinnersCommitOrder == \A v \in EnteredVis : ForkOut(v) = "joined" => fwin[v] = CommitWinners(v)
(* A winner's success was committed in time.                               *)
Inv_WinnersOnTime == \A v \in EnteredVis : ForkOut(v) = "joined" => \A b \in fwin[v] : CSucc0(v, b)
(* A visit's join counts only that visit's branches.                       *)
Inv_VisitIsolated == \A v \in EnteredVis : ForkOut(v) = "joined" =>
    \A b \in fwin[v] : \E i \in Ids : ne[i].st # "free" /\ ne[i].vis = v /\ ne[i].sc = b
(* Blocked only when k successes are impossible.                           *)
Inv_BlockedOnlyWhenImpossible == \A v \in EnteredVis : ForkOut(v) = "blocked" =>
    Cardinality({b \in Br : rep[v][b] = "failed"}) + Kneed > NB
(* failFast false and no time limit: blocked only when every branch ended. *)
Inv_FailFastFalseWaits == (~FailFast /\ ~HasTimer) =>
    \A v \in EnteredVis : ForkOut(v) = "blocked" => \A b \in Br : rep[v][b] \in {"succeeded", "failed"}
(* Every branch ends exactly once: the report names each, once, with how  *)
(* it ended; a branch that ended before the decision keeps how it ended.  *)
Inv_ReportComplete == \A v \in EnteredVis : Decided(v) => \A b \in Br : rep[v][b] # "none"
Inv_ReportKeepsFinished == \A v \in EnteredVis : Decided(v) =>
    \A b \in Br : rep[v][b] \in {"cancelled", "not_started", "late"} => (~CSucc0(v, b) /\ ~CFail(v, b))
(* No work is admitted, and no branch result routed, after the decision.  *)
Inv_NoStartAfterDecision == "startedAfter" \notin gh
Inv_NoRouteAfterDecision == "routedAfter" \notin gh
(* A not_started branch never runs.                                        *)
Inv_QueuedNeverStarted == \A v \in EnteredVis : \A b \in Br : rep[v][b] = "not_started" =>
    \A i \in Ids : ~(ne[i].st # "free" /\ ne[i].vis = v /\ ne[i].sc = b)
Inv_Concurrency == Cardinality({b \in Br : bc[b].st = "active"}) <= Conc
(* maxNodeExecutions counts every admission, root and branches.           *)
Inv_StepsBound == steps <= Limit
(* The limit ends the run deterministically, at exactly the limit.       *)
Inv_LimitExact == why = "limit" => steps = Limit
(* Routes stay inside their branch.                                        *)
Inv_BranchConfined == "escaped" \notin gh
(* A branch waits only on its own node executions.                        *)
Inv_RowsOwned == \A b \in Br : IF bc[b].st = "active" /\ bc[b].pend \in Ids THEN ne[bc[b].pend].by = b ELSE TRUE
(* Agent states of different branches keep their own model choices.       *)
Inv_ModelKeysDistinct == \A i, j \in Ids :
    (IsAgentRow(i) /\ IsAgentRow(j) /\ ne[i].sc # ne[j].sc) => ModelKey(i) # ModelKey(j)
(* A graceful stop lets started work finish (before its grace deadline).  *)
Inv_StopLetsStartedFinish == "stopCut" \notin gh
Inv_EndedNothingPending == runSt \in Ended => \A i \in Ids : ne[i].st # "pending"
(* fj3 NB-R2: after an accepted graceful stop the fork's join and time limit decide nothing and cut nothing. *)
Inv_NoSettleAfterStop == "settledAfterStop" \notin gh
(* fj3 NB-R5: work is cut for a join or failFast only in or after its fork's decision (a due join's        *)
(* time-limit cut, winner "timeout", decides nothing by design).                                           *)
Inv_CutOnlyWithDecision == \A i \in Ids :
    (ne[i].st = "done" /\ ne[i].vis \in Vis /\ ne[i].win \in {"join", "failFast"}) => ForkOut(ne[i].vis) \notin {"none", "pending"}
(* After a visit's cut, none of its branches has pending work.             *)
Inv_DroppedNoPending == \A i \in Ids : (ne[i].st = "pending" /\ ne[i].vis # 0) => (ne[i].vis = fv /\ ~cdone[fv])
(* A cut agent child whose cut was acknowledged was asked to end.          *)
CutAcked(i) == IF ne[i].vis \in Vis THEN cdone[ne[i].vis] ELSE FALSE
Inv_CutMeansAsked == \A i \in Ids :
    (IsAgentRow(i) /\ CutAcked(i) /\ ne[i].win \in {"join", "failFast", "timeout"} /\ eff[i] = "running") => asked[i]

(* Witnesses: expected to be violated (the behavior is reachable).         *)
W_NotJoined == \A v \in EnteredVis : ForkOut(v) # "joined"
W_NotBlocked == \A v \in EnteredVis : ForkOut(v) # "blocked"
W_NotTimedOut == \A v \in EnteredVis : ForkOut(v) # "timed_out"
W_NoDue == "due" \notin gh
W_NoLate == \A v \in EnteredVis : \A b \in Br : rep[v][b] # "late"
W_NoSecondVisit == fv < 2
W_NoLocalErrorRoute == "errRoute" \notin gh
W_NoLocalLoop == "loop" \notin gh
W_NoLimitEnd == why # "limit"
W_NoCatchAll == ~caEntered
W_NoNotStarted == \A v \in EnteredVis : \A b \in Br : rep[v][b] # "not_started"
W_NoCancelledLoser == \A v \in EnteredVis : \A b \in Br : rep[v][b] # "cancelled"
W_WinnersIndexOrder == \A v \in EnteredVis : ForkOut(v) = "joined" => fwin[v] = IndexWinners(v)
W_NoStopAfterWork == ~(why = "stop" /\ \E i \in Ids : ne[i].win = "effect" /\ ne[i].sc \in Br)
W_NotCompleted == runSt # "completed"
W_NoPastCut == "pastCut" \notin gh
W_NoEntryError == \A v \in EnteredVis : ForkOut(v) # "invalid_input"

(* Progress, under Fairness.                                               *)
Prop_ForkDecided == ForkPending ~> ~ForkPending
Prop_RunEnds == <>(runSt \in Ended)
Prop_EffectsSettle == <>(cEnded /\ \A i \in Ids : eff[i] # "running")
Prop_StopEnds == stopReq ~> (runSt \in Ended)
(* fj2 (MF-FJ1): a requested stop ends the run and settles every effect.   *)
Prop_StopSettles == stopReq ~> (cEnded /\ \A i \in Ids : eff[i] # "running")

----------------------------------------------------------------------------
(* Refinement of the intended specification, for the first fork visit.    *)
F1 == fids[1]
MapOut == IF F1 = 0 THEN "none"
          ELSE IF ne[F1].st = "pending" THEN "none"
          ELSE IF ne[F1].out = "cancel" THEN "cancelled"
          ELSE IF ne[F1].out = "invalid_input" THEN "error"
          ELSE ne[F1].out
MapAst == [b \in Br |->
    IF MapOut \in {"joined", "blocked", "timed_out"} THEN rep[1][b]
    ELSE IF CSucc(1, b) THEN "succeeded"
    ELSE IF CFail(1, b) THEN "failed"
    ELSE IF BRows(1, b) = {} THEN (IF MapOut = "none" THEN "queued" ELSE "not_started")
    ELSE IF MapOut = "none" THEN "running"
    ELSE IF Late(1, b) THEN "late"
    ELSE "cancelled"]
MapWin == IF MapOut = "joined" THEN fwin[1] ELSE {}

Abs == INSTANCE AbsForkJoin WITH NB <- NB, Kneed <- Kneed, FailFast <- FailFast, HasTimer <- HasTimer,
                                 AllowRunEnd <- TRUE, AllowEntryError <- EntryErr,
                                 ast <- MapAst, aout <- MapOut, awin <- MapWin
Prop_RefinesAbs == Abs!ASpec
=============================================================================
