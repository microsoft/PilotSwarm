------------------------------ MODULE WfGraph ------------------------------
(***************************************************************************)
(* How workflow v2 controller 1.9.0 executes a graph: controlRequestRun   *)
(* in packages/sdk/src/workflow/v2/runtime.ts at efe44835. One run of one *)
(* small plan, chosen by Plan.                                            *)
(*                                                                         *)
(* The controller's durable state (cursors, steps, the catch-all flag,   *)
(* the running parallel state) is carried by its history and by          *)
(* continue-as-new. Each controller step below stands for one activity   *)
(* and the controller resuming with its recorded result. Every store     *)
(* activity the controller schedules is idempotent or a compare-and-swap *)
(* (enter by deterministic id, endBranch, cancelBranches, join, finish,  *)
(* stop, expire), so a worker crash and a retry of one is the same step  *)
(* again; duroxide replays the controller deterministically, so a replay *)
(* is no step at all. Continue-as-new keeps every variable below.         *)
(*                                                                         *)
(* Node kinds: "work" stands for every state whose result another        *)
(* process decides (a script's effect, an agent's child, a send or       *)
(* request delivery, a wait's elapse): Decide is that process. "term" is *)
(* a root terminal, "bterm" a terminal inside a parallel body, "par" a   *)
(* parallel state with K branches (manifest items), Conc at a time.      *)
(* A node execution's id is the admission's step number: the code        *)
(* derives it from (scope, node, ordinal), one-to-one with that number   *)
(* in a deterministic controller.                                        *)
(*                                                                         *)
(* r3 (S7-DX3): the controller's end is three steps, as reportEnded runs  *)
(* them: the end (one store activity), afterEnd (endAgents: the agent      *)
(* children of decided states are ended) and notifyParent. A store call  *)
(* that finds the run ended by another writer goes through endedElsewhere *)
(* (pc "observe": observeEnd, then afterEnd, then the notice or not).     *)
(* Elsewhere selects its rule: "command" is 1ef53967 (S7-DX2: the notice *)
(* only after an accepted command's end; a finish or a command's cancel  *)
(* that finds the run ended reports as its own end would), "any" is      *)
(* 9a8d0f66 (S7-DX3 3dec2dca, in the squash d7c3ca68: every end but a     *)
(* deletion is reported; a finish, finishRun or cancel answer `elsewhere` *)
(* goes to endedElsewhere; observeEnd's `deleted` is the session's        *)
(* deletion mark when it runs). OtherEnds adds writers and faults:        *)
(* "chat" (the owning chat ended: migrations 0107/0109 cancel the run,   *)
(* no command, no deletion), "delete_after" (the workflow is deleted     *)
(* after its run ended), "retry" (an end activity's commit is followed by *)
(* a worker crash; its retry answers `elsewhere`; only finish, finishRun  *)
(* and cancel answer so, expire and stop report their own end again).     *)
(* Named branches and named forks (66842522, 571ed468) are not modeled    *)
(* here (the fork-join folder covers them).                               *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Plan,           \* "linear", "catch", "catchf", "loop", "par", "parc"
    Limit,          \* the plan's maxNodeExecutions
    K,              \* the parallel state's manifest size
    Conc,           \* its concurrency
    FailFast,       \* its failure policy
    AllowCancel, AllowStop, AllowPause, AllowDeadline, AllowDelete,
    Cmd,            \* lifecycle commands: "queue" (queued, applied by the controller) or "direct" (S7-DX2 1ef53967: acceptance ends the run)
    AllowLoseHint,  \* a queued command may be lost (continue-as-new behind 100 unread messages, or never read)
    Fault,          \* "none" or a deliberate fault
    Elsewhere,      \* r3: endedElsewhere's rule: "command" (1ef53967) or "any" (9a8d0f66, S7-DX3)
    OtherEnds       \* r3: subset of {"chat", "delete_after", "retry"} (see the header)

Faults == {"none", "no_limit", "branch_catchall", "join_early", "no_dropped",
           "catchall_twice", "store_admits_stopping", "fix_pause_on_collect", "srt1", "srt1b"}
ASSUME Fault \in Faults
ASSUME Cmd \in {"queue", "direct"} /\ AllowLoseHint \in BOOLEAN
ASSUME Limit \in Nat \ {0} /\ K \in Nat \ {0} /\ Conc \in 1..K
ASSUME Plan \in {"linear", "catch", "catchf", "loop", "par", "parc"}
ASSUME Elsewhere \in {"command", "any"} /\ OtherEnds \subseteq {"chat", "delete_after", "retry"}

NONE == "none"
Ids == 1..(Limit + 1)
Branches == 1..K
Scopes == 0..K
\* "chat_cancelled": the store's status is cancelled; the model tells it from a command's end
Ended == {"completed", "failed", "cancelled", "stopped", "deleted", "chat_cancelled"}
Live == {"running", "paused"}

----------------------------------------------------------------------------
(* The plans. Edges are <<state, route, target>>. Business outcomes are  *)
(* "ok" and "alt" (a work state), "joined" and "blocked" (a parallel     *)
(* state), "succ" and "fail" (a branch terminal). "boom" is a runtime    *)
(* error code; "cancel" is the runtime error a run's end stores on a     *)
(* pending state; "@f" is a state's failure route.                        *)
Nodes == CASE Plan = "linear" -> {"A", "B", "T"}
           [] Plan \in {"catch", "catchf"} -> {"A", "H", "T"}
           [] Plan = "loop" -> {"A", "T"}
           [] Plan = "par" -> {"P", "B", "BT", "T", "U"}
           [] Plan = "parc" -> {"P", "B", "BT", "T", "U", "H"}
Initial == IF Plan \in {"par", "parc"} THEN "P" ELSE "A"
CatchAll == IF Plan \in {"catch", "catchf", "parc"} THEN "H" ELSE NONE
BodyInitial == "B"
BodyNodes == {"B", "BT"}
Kind(n) == CASE n \in {"A", "B", "H"} -> "work"
             [] n = "P" -> "par"
             [] n = "BT" -> "bterm"
             [] OTHER -> "term"
Edges == CASE Plan = "linear" -> {<<"A", "ok", "T">>, <<"A", "alt", "B">>, <<"B", "ok", "T">>, <<"B", "alt", "T">>}
           [] Plan = "catch" -> {<<"A", "ok", "T">>, <<"H", "ok", "T">>, <<"H", "alt", "T">>}
           [] Plan = "catchf" -> {<<"A", "ok", "T">>, <<"A", "@f", "H">>, <<"H", "ok", "T">>, <<"H", "@f", "H">>}
           [] Plan = "loop" -> {<<"A", "ok", "T">>, <<"A", "alt", "A">>, <<"A", "@f", "A">>}
           [] Plan = "par" -> {<<"P", "joined", "T">>, <<"P", "blocked", "U">>, <<"B", "ok", "BT">>, <<"B", "alt", "BT">>}
           [] Plan = "parc" -> {<<"P", "joined", "T">>, <<"P", "blocked", "U">>, <<"B", "ok", "BT">>, <<"B", "alt", "BT">>,
                                <<"H", "ok", "T">>}
HasEdge(n, r) == \E e \in Edges : e[1] = n /\ e[2] = r
Target(n, r) == (CHOOSE e \in Edges : e[1] = n /\ e[2] = r)[3]
BusinessOuts == {"ok", "alt", "joined", "blocked", "succ", "fail"}

(* selectRoute: a business outcome takes its own route; a runtime error  *)
(* its own route, else the failure route; NONE when unhandled.           *)
SelectRoute(n, out) ==
    IF out \in BusinessOuts THEN (IF HasEdge(n, out) THEN out ELSE NONE)
    ELSE IF HasEdge(n, out) THEN out
    ELSE IF HasEdge(n, "@f") THEN "@f" ELSE NONE

----------------------------------------------------------------------------
VARIABLES
    \* store
    ne,        \* node executions: [Ids -> [st, node, scope, out, win]]
    runSt,     \* the run's status
    stopReq,   \* an accepted graceful stop (never withdrawn)
    stopDue,   \* its grace deadline passed by the store's clock
    runDue,    \* the run's deadline (limits.timeoutSeconds) passed by the store's clock
    cmdq,      \* the controller's command queue: NONE or "cancel"
    pauses,    \* pauses the environment made (at most one)
    \* controller
    pc,        \* "loop", "collect", "settle", "route", "endbranch", "cancelbr", "join", "finish", "wait", "paused", "ended";
               \* r3: "observe" (endedElsewhere), "children" (afterEnd, then the notice), "childrenonly", "notify"
    cur,       \* cursors: [Scopes -> [on, node, pend, pred]]; scope 0 is the root, b the branch of item b
    par,       \* the running parallel state: [ne, next, res, cancelled]
    steps, caEntered, stopping,
    batch,     \* results collected and not routed yet
    dropped,   \* node executions whose branch a failFast cancellation dropped
    ctx,       \* the current sub-step's argument: [scope, id, ret, cancel]
    \* history (read by no action)
    caCount, fault, joinBad, escaped, admittedStopping, notified,
    pausedRoute, \* R2-RT-1: results collected while the run was paused (routed before the resume)
    pausedEnd,   \* R2-RT-1: the node limit ended a run while it was paused
    \* S7-DX2 history, updated by H in every step (read by no action except the controller's notice)
    accepted,    \* a lifecycle command (cancel or done) was accepted
    cmdEnd,      \* a lifecycle command's transaction ended the run (status cancelled)
    admittedAfterAccept, \* a node execution was admitted after a command was accepted
    collectedAfterEnd,   \* a collection returned results of a run that had already ended
    \* r3 (S7-DX3)
    wfDel,       \* the workflow session is deleted (observeEnd reads this mark)
    childEnded,  \* afterEnd (endAgents) ran after the run's end
    loserNotice  \* history: a notice was decided by the requester of a command that did not end the run (N-2)

storeVars == <<ne, runSt, stopReq, stopDue, runDue, cmdq, pauses>>
ctlVars == <<pc, cur, par, steps, caEntered, stopping, batch, dropped, ctx>>
histVars == <<caCount, fault, joinBad, escaped, admittedStopping, notified, pausedRoute, pausedEnd>>
cmdVars == <<accepted, cmdEnd, admittedAfterAccept, collectedAfterEnd>>
r3Vars == <<wfDel, childEnded, loserNotice>>
vars == <<storeVars, ctlVars, histVars, cmdVars, r3Vars>>

NoNe == [st |-> "free", node |-> NONE, scope |-> 0, out |-> NONE, win |-> NONE]
NoCur == [on |-> FALSE, node |-> NONE, pend |-> 0, pred |-> 0]
NoPar == [ne |-> 0, next |-> 0, res |-> [b \in Branches |-> NONE], cancelled |-> FALSE]
NoCtx == [scope |-> 0, id |-> 0, ret |-> NONE, cancel |-> {}]

Init ==
    /\ ne = [i \in Ids |-> NoNe]
    /\ runSt = "running" /\ stopReq = FALSE /\ stopDue = FALSE /\ runDue = FALSE
    /\ cmdq = NONE /\ pauses = 0 /\ pausedRoute = FALSE /\ pausedEnd = FALSE
    /\ accepted = FALSE /\ cmdEnd = FALSE /\ admittedAfterAccept = FALSE /\ collectedAfterEnd = FALSE
    /\ pc = "loop"
    /\ cur = [s \in Scopes |-> IF s = 0 THEN [on |-> TRUE, node |-> Initial, pend |-> 0, pred |-> 0] ELSE NoCur]
    /\ par = NoPar
    /\ steps = 0 /\ caEntered = FALSE /\ stopping = FALSE
    /\ batch = {} /\ dropped = {} /\ ctx = NoCtx
    /\ caCount = 0 /\ fault = NONE /\ joinBad = FALSE
    /\ escaped = FALSE /\ admittedStopping = FALSE /\ notified = 0
    /\ wfDel = FALSE /\ childEnded = FALSE /\ loserNotice = FALSE

----------------------------------------------------------------------------
(* Every end of the run: the run's status and every pending node          *)
(* execution decided "cancel" in one store transaction (finishRun,        *)
(* finishStoppedRun, expireRun, the cancel command, the deletion).        *)
EndRunTx(status) ==
    /\ runSt' = status
    /\ ne' = [i \in Ids |-> IF ne[i].st = "pending"
                               THEN [ne[i] EXCEPT !.st = "done", !.out = "cancel", !.win = "end"]
                               ELSE ne[i]]

(* reportEnded: the children of decided agent states are ended (pc       *)
(* "children": afterEnd), then the notifyParent activity runs (pc         *)
(* "notify"; WfParent models what it does). `notified` counts the         *)
(* notifyParent activities this controller schedules.                     *)
Report == notified' = notified + 1
(* The pc after the controller's own end committed: reportEnded. r3      *)
(* "retry": the activity's result was lost after its commit; the retry   *)
(* answers `elsewhere` (finish, finishRun, cancel at 9a8d0f66), so the    *)
(* controller goes to endedElsewhere instead. At 1ef53967 those answers   *)
(* carried no such flag and the retry reported as the first attempt.      *)
OwnEndPcs == IF "retry" \in OtherEnds /\ Elsewhere = "any" THEN {"children", "observe"} ELSE {"children"}
(* A finish, finishRun or cancel that finds the run already ended:       *)
(* 1ef53967 reports it as its own end (reportEnded, or applyCommand's    *)
(* notice with the command's requester); 9a8d0f66 goes to endedElsewhere *)
(* (S7-DX3 N-1, N-2).                                                     *)
FoundEndedPc == IF Elsewhere = "any" THEN "observe" ELSE "children"
(* endedElsewhere's rule after observeEnd. 1ef53967 (S7-DX2): the notice  *)
(* only after an accepted command's end (commandEndOf). 9a8d0f66          *)
(* (S7-DX3): unless the workflow session is deleted when observeEnd runs. *)
ObservedReports == IF Elsewhere = "any" THEN ~wfDel ELSE (Cmd = "direct" /\ cmdEnd)

PendingIds == {cur[s].pend : s \in {t \in Scopes : cur[t].on}} \ {0}
Owner(i) == {s \in Scopes : cur[s].on /\ cur[s].pend = i}

----------------------------------------------------------------------------
(* Step 0: a lifecycle command already queued (takeQueuedCommand, only    *)
(* when some cursor waits on no work), or one that ends a wait (the       *)
(* race). applyCommand: the cancel transaction, then afterEnd and the    *)
(* parent's notice. On a run another writer ended: 1ef53967 still tells   *)
(* the parent, with the queued command's requester (loserNotice when that *)
(* command did not end the run: only a queued, older build's command can  *)
(* lose here); 9a8d0f66 follows the stored end (endedElsewhere, N-2).     *)
TakeCommand ==
    /\ cmdq = "cancel"
    /\ \/ pc = "loop" /\ \E s \in Scopes : cur[s].on /\ cur[s].pend = 0
       \/ pc \in {"wait", "paused"}
    /\ cmdq' = NONE
    /\ IF runSt \in Live
         THEN /\ EndRunTx("cancelled")
              /\ pc' \in OwnEndPcs
              /\ UNCHANGED loserNotice
         ELSE /\ UNCHANGED <<runSt, ne>>
              /\ pc' = FoundEndedPc
              /\ loserNotice' = (loserNotice \/ (Elsewhere = "command" /\ Cmd = "queue"))
    /\ UNCHANGED <<stopReq, stopDue, runDue, pauses, cur, par, steps, caEntered, stopping, batch,
                   dropped, ctx, caCount, fault, joinBad, escaped, admittedStopping, pausedRoute, pausedEnd,
                   notified, wfDel, childEnded>>

(* Branches of p start while fewer than Conc run (startBranches).         *)
Room(c) == Conc - Cardinality({b \in Branches : c[b].on})
StartBranches(p, c) ==
    [s \in Scopes |-> IF s \in Branches /\ s > p.next /\ s <= p.next + Room(c) /\ ~p.cancelled
                        THEN [on |-> TRUE, node |-> BodyInitial, pend |-> 0, pred |-> p.ne]
                        ELSE c[s]]
NextAfterStart(p, c) ==
    IF p.cancelled THEN p.next
    ELSE IF p.next + Room(c) > K THEN K ELSE p.next + Room(c)
AllEnded(p) == \A b \in Branches : p.res[b] # NONE

(* Step 1: admit the next node of one cursor that waits on no work.       *)
(* The step limit first (controller), then the store's answers in the    *)
(* code's order: ended, past the run's deadline, stopping, paused; then   *)
(* the admission (enter: store.enterNode under the session and run        *)
(* locks).                                                                *)
Admit(s) ==
    /\ pc = "loop" /\ ~stopping
    /\ cur[s].on /\ cur[s].pend = 0
    /\ steps < Limit + 1
    \* S-RT1 (07c29b05): at its limit, 1.9.0 reads the run first; an ended, expired, stopping or paused run is not ended by it
    /\ IF steps >= Limit /\ Fault # "no_limit"
          /\ ~(Fault = "srt1" /\ (runSt \notin Live \/ runDue \/ stopReq \/ runSt = "paused"))
         THEN \* limit_exceeded: finishRun ends the run failed, then reportEnded; an ended run is its answer `elsewhere` (r3).
              /\ IF runSt \in Live
                   THEN EndRunTx("failed") /\ pc' \in OwnEndPcs
                   ELSE UNCHANGED <<runSt, ne>> /\ pc' = FoundEndedPc
              /\ UNCHANGED <<cur, par, steps, caEntered, stopping, ctx, caCount, admittedStopping, escaped>>
       ELSE IF runSt \notin Live
         THEN \* another end decided the run: endedElsewhere (r3: pc "observe").
              /\ pc' = "observe"
              /\ UNCHANGED <<runSt, ne, cur, par, steps, caEntered, stopping, ctx, caCount, admittedStopping, escaped>>
       ELSE IF runDue
         THEN \* expireRun: the store ends the run failed (timed_out), then reportEnded (a retry reports it too: byDeadline).
              /\ EndRunTx("failed") /\ pc' = "children"
              /\ UNCHANGED <<cur, par, steps, caEntered, stopping, ctx, caCount, admittedStopping, escaped>>
       ELSE IF stopReq /\ Fault # "store_admits_stopping"
         THEN /\ stopping' = TRUE /\ pc' = "collect"
              /\ UNCHANGED <<runSt, ne, cur, par, steps, caEntered, ctx, caCount, admittedStopping, escaped>>
       ELSE IF runSt = "paused"
         THEN /\ pc' = "paused"
              /\ UNCHANGED <<runSt, ne, cur, par, steps, caEntered, stopping, ctx, caCount, admittedStopping, escaped>>
       ELSE LET id == steps + 1
                n == cur[s].node
            IN /\ steps' = id
               /\ caEntered' = (caEntered \/ n = CatchAll)
               /\ caCount' = caCount + (IF n = CatchAll THEN 1 ELSE 0)
               /\ admittedStopping' = (admittedStopping \/ stopReq)
               /\ escaped' = (escaped \/ (s # 0 /\ n \notin BodyNodes))
               /\ ne' = [ne EXCEPT ![id] = [st |-> "pending", node |-> n, scope |-> s, out |-> NONE, win |-> NONE]]
               /\ UNCHANGED <<runSt, stopping>>
               /\ CASE Kind(n) = "work" ->
                         /\ cur' = [cur EXCEPT ![s].pend = id]
                         /\ UNCHANGED <<par, pc, ctx>>
                    [] Kind(n) = "term" ->
                         /\ cur' = [cur EXCEPT ![s].pend = id]
                         /\ ctx' = [NoCtx EXCEPT !.scope = s, !.id = id]
                         /\ pc' = "finish"
                         /\ UNCHANGED par
                    [] Kind(n) = "bterm" ->
                         /\ cur' = [cur EXCEPT ![s].pend = id]
                         /\ ctx' = [NoCtx EXCEPT !.scope = s, !.id = id, !.ret = "loop"]
                         /\ pc' = "endbranch"
                         /\ UNCHANGED par
                    [] Kind(n) = "par" ->
                         LET p0 == [NoPar EXCEPT !.ne = id]
                             c0 == [cur EXCEPT ![s].pend = id]
                         IN /\ cur' = StartBranches(p0, c0)
                            /\ par' = [p0 EXCEPT !.next = NextAfterStart(p0, c0)]
                            /\ UNCHANGED <<pc, ctx>>
    /\ UNCHANGED <<stopReq, stopDue, runDue, cmdq, pauses, batch, dropped, fault, joinBad, pausedRoute,
                   notified, wfDel, childEnded, loserNotice>>
    \* the node limit's end only: the run's deadline still ends a paused run (expireRun), as the design says
    /\ pausedEnd' = (pausedEnd \/ (runSt = "paused" /\ runSt' = "failed" /\ steps >= Limit /\ ~runDue))

(* No cursor is left to admit in this pass (or the run is stopping).      *)
PassDone ==
    /\ pc = "loop"
    /\ (stopping \/ \A s \in Scopes : ~cur[s].on \/ cur[s].pend # 0)
    /\ pc' = "collect"
    /\ UNCHANGED <<storeVars, cur, par, steps, caEntered, stopping, batch, dropped, ctx, histVars, r3Vars>>

----------------------------------------------------------------------------
(* A root terminal: finish. An invalid output goes to the catch-all      *)
(* state while it has not run (routeOutputErrors); otherwise the run      *)
(* ends. A run another end decided first: 1ef53967 reports it as its own *)
(* end (Q1); 9a8d0f66's finish answers `elsewhere` and the controller    *)
(* reconciles it (endedElsewhere, S7-DX3 N-1).                            *)
Finish ==
    /\ pc = "finish"
    /\ LET s == ctx.scope
           id == ctx.id
       IN \/ /\ IF runSt \in Live /\ ne[id].st = "pending"
                  THEN /\ runSt' = "completed"
                       /\ ne' = [i \in Ids |-> IF i = id THEN [ne[i] EXCEPT !.st = "done", !.out = "ok", !.win = "controller"]
                                               ELSE IF ne[i].st = "pending" THEN [ne[i] EXCEPT !.st = "done", !.out = "cancel", !.win = "end"]
                                               ELSE ne[i]]
                       /\ pc' \in OwnEndPcs
                  ELSE /\ UNCHANGED <<runSt, ne>>
                       /\ pc' = FoundEndedPc
             /\ UNCHANGED <<cur, caEntered>>
          \/ /\ runSt \in Live /\ ne[id].st = "pending"
             /\ IF CatchAll # NONE /\ ~caEntered
                  THEN /\ ne' = [ne EXCEPT ![id] = [@ EXCEPT !.st = "done", !.out = "invalid_output", !.win = "controller"]]
                       /\ cur' = [cur EXCEPT ![s] = [on |-> TRUE, node |-> CatchAll, pend |-> 0, pred |-> id]]
                       /\ caEntered' = TRUE
                       /\ pc' = "loop"
                       /\ UNCHANGED runSt
                  ELSE /\ EndRunTx("failed") /\ pc' \in OwnEndPcs
                       /\ UNCHANGED <<cur, caEntered>>
    /\ ctx' = NoCtx
    /\ UNCHANGED <<stopReq, stopDue, runDue, cmdq, pauses, par, steps, stopping, batch, dropped,
                   caCount, fault, joinBad, escaped, admittedStopping, pausedRoute, pausedEnd,
                   notified, wfDel, childEnded, loserNotice>>

----------------------------------------------------------------------------
(* A branch ended (endBranch in the controller): record how and drop its *)
(* cursor. Under failFast a branch that did not succeed cancels the      *)
(* others (their results go nowhere) and the rest never start; otherwise *)
(* the next branches start. Then the join when every branch ended.       *)
BranchEnd(s, via, succ, ret) ==
    LET p1 == [par EXCEPT !.res[s] = via]
        c1 == [cur EXCEPT ![s] = NoCur]
        others == {b \in Branches : b # s /\ c1[b].on}
    IN IF ~succ /\ FailFast /\ ~par.cancelled
         THEN LET p2 == [p1 EXCEPT !.cancelled = TRUE, !.next = K,
                            !.res = [b \in Branches |-> IF b \in others THEN "cancelled"
                                                        ELSE IF b > par.next THEN "not_started"
                                                        ELSE p1.res[b]]]
              IN /\ par' = p2
                 /\ cur' = [b \in Scopes |-> IF b \in others THEN NoCur ELSE c1[b]]
                 /\ dropped' = dropped \cup ({c1[b].pend : b \in others} \ {0})
                 /\ ctx' = [NoCtx EXCEPT !.ret = ret, !.cancel = others]
                 /\ pc' = IF others # {} THEN "cancelbr"
                          ELSE IF AllEnded(p2) \/ Fault = "join_early" THEN "join" ELSE ret
         ELSE LET p2 == [p1 EXCEPT !.next = NextAfterStart(p1, c1)]
              IN /\ cur' = StartBranches(p1, c1)
                 /\ par' = p2
                 /\ UNCHANGED dropped
                 /\ ctx' = [NoCtx EXCEPT !.ret = ret]
                 /\ pc' = IF AllEnded(p2) \/ Fault = "join_early" THEN "join" ELSE ret

(* endBranch activity at a branch terminal: its output, checked against  *)
(* its schema, decides the terminal once; a result another end decided   *)
(* first is read as stored. Succeeded: outcome succeeded, as business.    *)
EndBranchAt ==
    /\ pc = "endbranch" /\ par.ne \in Ids
    /\ LET s == ctx.scope
           id == ctx.id
       IN \E good \in BOOLEAN :
            /\ IF ne[id].st = "pending"
                 THEN ne' = [ne EXCEPT ![id] = [@ EXCEPT !.st = "done", !.out = IF good THEN "succ" ELSE "fail", !.win = "controller"]]
                 ELSE /\ UNCHANGED ne
                      /\ good = FALSE
            /\ BranchEnd(s, IF good THEN "t_ok" ELSE "t_bad", good, ctx.ret)
    /\ UNCHANGED <<runSt, stopReq, stopDue, runDue, cmdq, pauses, steps, caEntered, stopping, batch,
                   histVars, r3Vars>>

(* cancelBranches: the other branches' pending states are decided         *)
(* cancelled (winner fail_fast); a result stored first is kept.           *)
CancelBranches ==
    /\ pc = "cancelbr"
    /\ ne' = [i \in Ids |-> IF ne[i].st = "pending" /\ ne[i].scope \in ctx.cancel
                               THEN [ne[i] EXCEPT !.st = "done", !.out = "cancel", !.win = "fail_fast"]
                               ELSE ne[i]]
    /\ pc' = IF AllEnded(par) \/ Fault = "join_early" THEN "join" ELSE ctx.ret
    /\ UNCHANGED <<runSt, stopReq, stopDue, runDue, cmdq, pauses, cur, par, steps, caEntered, stopping,
                   batch, dropped, ctx, histVars, r3Vars>>

(* join (all_required): when every branch ended, the parallel state is   *)
(* decided once: joined when every branch ended at its terminal with      *)
(* succeeded, blocked otherwise. The activity refuses a list that does   *)
(* not account for every branch (joinBad records such a call).            *)
Join ==
    /\ pc = "join" /\ par.ne \in Ids
    /\ LET id == par.ne
           ok == \A b \in Branches : par.res[b] = "t_ok"
       IN /\ joinBad' = (joinBad \/ ~AllEnded(par))
          /\ IF ne[id].st = "pending"
               THEN ne' = [ne EXCEPT ![id] = [@ EXCEPT !.st = "done", !.out = IF ok THEN "joined" ELSE "blocked", !.win = "controller"]]
               ELSE UNCHANGED ne
    /\ par' = NoPar
    /\ pc' = ctx.ret
    /\ UNCHANGED <<runSt, stopReq, stopDue, runDue, cmdq, pauses, cur, steps, caEntered, stopping, batch,
                   dropped, ctx, caCount, fault, escaped, admittedStopping, notified, pausedRoute, pausedEnd, r3Vars>>

----------------------------------------------------------------------------
(* Step 2: collect the stored results of every pending node execution,   *)
(* then the run's stop and deadline, read after them. A run past its     *)
(* deadline is ended by the store before any result is routed.           *)
Collect ==
    /\ pc = "collect"
    /\ LET got == {i \in PendingIds : ne[i].st = "done"}
       IN IF (Cmd = "direct" \/ Elsewhere = "any") /\ runSt \notin Live
            THEN \* S7-DX2: 1.9.0's collect reports an ended run first; none of its results is routed (endedElsewhere)
                 /\ pc' = "observe"
                 /\ UNCHANGED <<batch, stopping, dropped, runSt, ne, pausedRoute>>
          ELSE IF runSt \in Live /\ runDue
            THEN /\ EndRunTx("failed") /\ pc' = "children"
                 /\ UNCHANGED <<batch, stopping, dropped, pausedRoute>>
          ELSE IF runSt = "paused" /\ ~stopping /\ ~stopReq /\ Fault \in {"fix_pause_on_collect", "srt1"}
            THEN \* the fix of R2-RT-1 (batch S, not yet in code): the collection reads the paused status
                 /\ pc' = "paused"
                 /\ UNCHANGED <<batch, stopping, dropped, runSt, ne, pausedRoute>>
          ELSE IF runSt = "paused" /\ Fault = "srt1b"
            THEN \* S-RT1b (c4481682), 1.8.0: a paused run's collection returns no result; the loop is unchanged
                 /\ batch' = {}
                 /\ stopping' = (stopping \/ (runSt \in Live /\ stopReq))
                 /\ dropped' = {}
                 /\ pc' = IF stopping' THEN "settle" ELSE "wait"
                 /\ UNCHANGED <<runSt, ne, pausedRoute>>
            ELSE /\ batch' = got
                 /\ stopping' = (stopping \/ (runSt \in Live /\ stopReq))
                 /\ dropped' = {}
                 /\ pc' = IF stopping' THEN "settle" ELSE IF got # {} THEN "route" ELSE "wait"
                 \* 8d568890: the collection does not read the paused status; these results are routed now
                 /\ pausedRoute' = (pausedRoute \/ (runSt = "paused" /\ ~stopping' /\ got # {}))
                 /\ UNCHANGED <<runSt, ne>>
    /\ UNCHANGED <<stopReq, stopDue, runDue, cmdq, pauses, cur, par, steps, caEntered, ctx,
                   caCount, fault, joinBad, escaped, admittedStopping, pausedEnd, notified, r3Vars>>

(* 2a. Stopping: collected results settle their cursors and go nowhere.   *)
(* When no work (other than a parallel state's own join) is pending, or  *)
(* at the stop's deadline, the stop transaction ends the run stopped and *)
(* cancels what is still pending; an end decided first is kept.           *)
Settle ==
    /\ pc = "settle"
    /\ LET c1 == [s \in Scopes |-> IF cur[s].on /\ cur[s].pend \in batch THEN [cur[s] EXCEPT !.pend = 0] ELSE cur[s]]
           idle == ~\E s \in Scopes : c1[s].on /\ c1[s].pend # 0 /\ Kind(c1[s].node) # "par"
       IN /\ cur' = c1
          /\ batch' = {}
          /\ IF idle \/ stopDue
               THEN \* the stop's end; one that finds another end goes to endedElsewhere (a retry finds "stopped" and reports)
                    /\ IF runSt \in Live
                         THEN EndRunTx("stopped") /\ pc' = "children"
                         ELSE UNCHANGED <<runSt, ne>> /\ pc' = "observe"
               ELSE /\ pc' = "wait"
                    /\ UNCHANGED <<runSt, ne>>
    /\ UNCHANGED <<stopReq, stopDue, runDue, cmdq, pauses, par, steps, caEntered, stopping, dropped, ctx,
                   caCount, fault, joinBad, escaped, admittedStopping, pausedRoute, pausedEnd, notified, r3Vars>>

(* Route one collected result; the code routes the batch in its order.   *)
(* In a branch, an error no route takes ends the branch, never at the    *)
(* catch-all. At the root, an unhandled runtime error goes to the        *)
(* catch-all while it has not run; a route to the catch-all after it ran,*)
(* or no route at all, fails the run (finishRun).                         *)
Advance(s, n, i) == [on |-> TRUE, node |-> n, pend |-> 0, pred |-> i]
AfterRoute == IF batch' = {} THEN "loop" ELSE "route"

Route(i) ==
    /\ pc = "route" /\ i \in batch
    /\ LET own == Owner(i)
           out == ne[i].out
       IN IF own = {}
            THEN /\ IF i \in dropped /\ Fault # "no_dropped"
                      THEN \* a branch a failFast cancellation dropped: its result goes nowhere
                           /\ batch' = batch \ {i}
                           /\ pc' = AfterRoute
                           /\ UNCHANGED <<runSt, ne, fault>>
                      ELSE \* expect(owner !== undefined) fails: failRun ends the run (finishRun)
                           /\ fault' = "unowned_result"
                           /\ IF runSt \in Live
                                THEN EndRunTx("failed") /\ pc' \in OwnEndPcs
                                ELSE UNCHANGED <<runSt, ne>> /\ pc' = FoundEndedPc
                           /\ batch' = {}
                 /\ UNCHANGED <<cur, par, caEntered, dropped, ctx, escaped>>
          ELSE LET s == CHOOSE x \in own : TRUE
                   n == cur[s].node
                   r == SelectRoute(n, out)
               IN /\ UNCHANGED fault
                  /\ IF s # 0
                       THEN IF r = NONE
                              THEN IF Fault = "branch_catchall" /\ CatchAll # NONE
                                     THEN /\ cur' = [cur EXCEPT ![s] = Advance(s, CatchAll, i)]
                                          /\ batch' = batch \ {i}
                                          /\ pc' = AfterRoute
                                          /\ UNCHANGED <<runSt, ne, par, caEntered, dropped, ctx>>
                                     ELSE /\ batch' = batch \ {i}
                                          /\ BranchEnd(s, "error", FALSE, AfterRoute)
                                          /\ UNCHANGED <<runSt, ne, caEntered>>
                              ELSE /\ cur' = [cur EXCEPT ![s] = Advance(s, Target(n, r), i)]
                                   /\ batch' = batch \ {i}
                                   /\ pc' = AfterRoute
                                   /\ UNCHANGED <<runSt, ne, par, caEntered, dropped, ctx>>
                       ELSE LET tgt == IF r # NONE THEN Target(n, r)
                                       ELSE IF out \notin BusinessOuts /\ CatchAll # NONE
                                               /\ (~caEntered \/ Fault = "catchall_twice")
                                         THEN CatchAll ELSE NONE
                            IN IF tgt = NONE \/ (tgt = CatchAll /\ caEntered /\ Fault # "catchall_twice")
                                 THEN \* finishRun; an ended run is its answer `elsewhere` (r3)
                                      /\ IF runSt \in Live
                                           THEN EndRunTx("failed") /\ pc' \in OwnEndPcs
                                           ELSE UNCHANGED <<runSt, ne>> /\ pc' = FoundEndedPc
                                      /\ batch' = {}
                                      /\ UNCHANGED <<cur, par, caEntered, dropped, ctx>>
                                 ELSE /\ cur' = [cur EXCEPT ![0] = Advance(0, tgt, i)]
                                      /\ caEntered' = (caEntered \/ tgt = CatchAll)
                                      /\ batch' = batch \ {i}
                                      /\ pc' = AfterRoute
                                      /\ UNCHANGED <<runSt, ne, par, dropped, ctx>>
                  /\ escaped' = (escaped \/ (s # 0 /\ cur'[s].on /\ cur'[s].node \notin BodyNodes))
    /\ UNCHANGED <<stopReq, stopDue, runDue, cmdq, pauses, steps, stopping, caCount, joinBad, admittedStopping, pausedRoute, pausedEnd,
                   notified, r3Vars>>

(* Step 3: nothing is ready: wait for a wake, a command or the nearest   *)
(* deadline (one durable race; the backstop timer always ends it). At or *)
(* past the run's deadline the store is asked to end the run.            *)
WaitEnds ==
    /\ pc = "wait"
    /\ IF runSt \in Live /\ runDue
         THEN /\ EndRunTx("failed") /\ pc' = "children"
         ELSE /\ pc' = "loop" /\ UNCHANGED <<runSt, ne>>
    /\ UNCHANGED <<stopReq, stopDue, runDue, cmdq, pauses, cur, par, steps, caEntered, stopping, batch,
                   dropped, ctx, caCount, fault, joinBad, escaped, admittedStopping, pausedRoute, pausedEnd,
                   notified, r3Vars>>

(* 1a. Paused: wait for a command, the backstop or the run's deadline,   *)
(* then try the admission again.                                          *)
PausedWakes ==
    /\ pc = "paused"
    /\ IF runSt \in Live /\ runDue
         THEN /\ EndRunTx("failed") /\ pc' = "children"
         ELSE /\ pc' = "loop" /\ UNCHANGED <<runSt, ne>>
    /\ UNCHANGED <<stopReq, stopDue, runDue, cmdq, pauses, cur, par, steps, caEntered, stopping, batch,
                   dropped, ctx, caCount, fault, joinBad, escaped, admittedStopping, pausedRoute, pausedEnd,
                   notified, r3Vars>>

----------------------------------------------------------------------------
(* r3 (S7-DX3): the post-end steps.                                        *)
(* endedElsewhere: observeEnd (it asks the cancelled effects to stop, not *)
(* modeled) reads the run and, at 9a8d0f66, the session's deletion mark;  *)
(* then reportEnded (afterEnd, the notice) or afterEnd only.              *)
CtlKeep == <<storeVars, cur, par, steps, caEntered, stopping, batch, dropped, ctx>>
Observe ==
    /\ pc = "observe"
    /\ pc' = IF ObservedReports THEN "children" ELSE "childrenonly"
    /\ UNCHANGED <<CtlKeep, histVars, r3Vars>>

(* afterEnd: endAgents ends the children of the decided agent states      *)
(* (repeat-safe; a child it cannot end is traced, not retried here).       *)
AfterEnd ==
    /\ pc = "children"
    /\ childEnded' = TRUE
    /\ pc' = "notify"
    /\ UNCHANGED <<CtlKeep, histVars, wfDel, loserNotice>>

AfterEndOnly ==
    /\ pc = "childrenonly"
    /\ childEnded' = TRUE
    /\ pc' = "ended"
    /\ UNCHANGED <<CtlKeep, histVars, wfDel, loserNotice>>

(* notifyParent (its own checks, its idempotence and its delivery are     *)
(* WfParent's), then the final status is published and the controller    *)
(* returns.                                                                *)
Notify ==
    /\ pc = "notify"
    /\ Report
    /\ pc' = "ended"
    /\ UNCHANGED <<CtlKeep, caCount, fault, joinBad, escaped, admittedStopping, pausedRoute, pausedEnd, r3Vars>>

----------------------------------------------------------------------------
(* The environment.                                                        *)
(* An effect, child, delivery or timer decides a pending work state      *)
(* (compare-and-swap from pending: it loses to every earlier decision).   *)
Decide(i) ==
    /\ ne[i].st = "pending" /\ Kind(ne[i].node) = "work"
    /\ \E out \in {"ok", "alt", "boom"} :
         ne' = [ne EXCEPT ![i] = [@ EXCEPT !.st = "done", !.out = out, !.win = "effect"]]
    /\ UNCHANGED <<runSt, stopReq, stopDue, runDue, cmdq, pauses, ctlVars, histVars, r3Vars>>

(* A cancel or done is accepted (an accepted done also ends the run       *)
(* cancelled, reason Stopped). "queue": it is only queued for the         *)
(* controller. "direct" (S7-DX2): under the session and run locks, while  *)
(* the run is active (running, paused or stopping: it replaces a graceful *)
(* stop), the store ends the run cancelled as the controller's cancel     *)
(* does; the command is still queued, as a hint. On an ended run it only  *)
(* records a receipt (not modeled: no change).                            *)
SendCancel ==
    /\ AllowCancel /\ cmdq = NONE /\ runSt \in Live
    /\ Cmd = "queue" => pc # "ended"
    /\ cmdq' = "cancel"
    /\ IF Cmd = "direct" THEN EndRunTx("cancelled") ELSE UNCHANGED <<ne, runSt>>
    /\ UNCHANGED <<stopReq, stopDue, runDue, pauses, ctlVars, histVars, r3Vars>>

(* A queued message is lost: continue-as-new carries at most 100 unread  *)
(* messages (S7-DX2 dropped the drain), or it is never read in time.      *)
LoseHint ==
    /\ AllowLoseHint /\ cmdq # NONE
    /\ cmdq' = NONE
    /\ UNCHANGED <<ne, runSt, stopReq, stopDue, runDue, pauses, ctlVars, histVars, r3Vars>>

RequestStop ==
    /\ AllowStop /\ runSt \in Live /\ ~stopReq
    /\ stopReq' = TRUE
    /\ UNCHANGED <<ne, runSt, stopDue, runDue, cmdq, pauses, ctlVars, histVars, r3Vars>>

StopGraceEnds ==
    /\ stopReq /\ ~stopDue
    /\ stopDue' = TRUE
    /\ UNCHANGED <<ne, runSt, stopReq, runDue, cmdq, pauses, ctlVars, histVars, r3Vars>>

RunDeadline ==
    /\ AllowDeadline /\ ~runDue
    /\ runDue' = TRUE
    /\ UNCHANGED <<ne, runSt, stopReq, stopDue, cmdq, pauses, ctlVars, histVars, r3Vars>>

Pause ==
    /\ AllowPause /\ runSt = "running" /\ pauses = 0
    /\ runSt' = "paused" /\ pauses' = 1
    /\ UNCHANGED <<ne, stopReq, stopDue, runDue, cmdq, ctlVars, histVars, r3Vars>>

Resume ==
    /\ runSt = "paused"
    /\ runSt' = "running"
    /\ UNCHANGED <<ne, stopReq, stopDue, runDue, cmdq, pauses, ctlVars, histVars, r3Vars>>

Delete ==
    /\ AllowDelete /\ runSt \in Live
    /\ EndRunTx("deleted")
    /\ wfDel' = TRUE
    /\ UNCHANGED <<stopReq, stopDue, runDue, cmdq, pauses, ctlVars, histVars, childEnded, loserNotice>>

(* r3 "chat": the chat that owns the workflow completed, was cancelled or *)
(* failed (migrations 0107, 0109): its trigger ends the active run        *)
(* cancelled (pending work winner delete), with no command and no         *)
(* deletion. A deleted test definition ends its test runs the same way.  *)
ChatEnds ==
    /\ "chat" \in OtherEnds /\ runSt \in Live
    /\ EndRunTx("chat_cancelled")
    /\ UNCHANGED <<stopReq, stopDue, runDue, cmdq, pauses, ctlVars, histVars, r3Vars>>

(* r3 "delete_after": the workflow is deleted after its run ended (a       *)
(* delete on an ended run soft-deletes the session and keeps the run's    *)
(* result; the chat's deletion soft-deletes its workflows, 0109).         *)
DeleteEnded ==
    /\ AllowDelete /\ "delete_after" \in OtherEnds
    /\ runSt \in Ended /\ ~wfDel
    /\ wfDel' = TRUE
    /\ UNCHANGED <<ne, runSt, stopReq, stopDue, runDue, cmdq, pauses, ctlVars, histVars, childEnded, loserNotice>>

(* The controller ended: stutter (a terminal state, not a deadlock).      *)
Done == pc = "ended" /\ UNCHANGED vars

Controller ==
    \/ TakeCommand \/ PassDone \/ Finish \/ EndBranchAt \/ CancelBranches \/ Join
    \/ Collect \/ Settle \/ WaitEnds \/ PausedWakes
    \/ Observe \/ AfterEnd \/ AfterEndOnly \/ Notify
    \/ \E s \in Scopes : Admit(s)
    \/ \E i \in Ids : Route(i)
Environment ==
    \/ \E i \in Ids : Decide(i)
    \/ SendCancel \/ LoseHint \/ RequestStop \/ StopGraceEnds \/ RunDeadline \/ Pause \/ Resume \/ Delete
    \/ ChatEnds \/ DeleteEnded

(* The S7-DX2 history of every step. A command's end is the only end with *)
(* status cancelled (applyCommand or an accepted command's store end); r3  *)
(* names the owning chat's end "chat_cancelled".                           *)
H ==
    /\ accepted' = (accepted \/ (AllowCancel /\ cmdq = NONE /\ cmdq' = "cancel"))
    /\ cmdEnd' = (cmdEnd \/ (runSt \in Live /\ runSt' = "cancelled"))
    /\ admittedAfterAccept' = (admittedAfterAccept \/ (accepted /\ steps' > steps))
    /\ collectedAfterEnd' = (collectedAfterEnd \/ (pc = "collect" /\ runSt \notin Live /\ batch' # {}))

Next == (Controller \/ Environment \/ Done) /\ H

(* Fairness: the controller and the effects make progress (a worker runs *)
(* them and the store accepts their transactions); a paused run is        *)
(* resumed; a stop's grace period ends. Commands, stops, deadlines and   *)
(* deletions are free choices of the environment.                         *)
Fairness ==
    /\ WF_vars(TakeCommand /\ H) /\ WF_vars(PassDone /\ H) /\ WF_vars(Finish /\ H) /\ WF_vars(EndBranchAt /\ H)
    /\ WF_vars(CancelBranches /\ H) /\ WF_vars(Join /\ H) /\ WF_vars(Collect /\ H) /\ WF_vars(Settle /\ H)
    /\ WF_vars(WaitEnds /\ H) /\ WF_vars(PausedWakes /\ H)
    /\ WF_vars(Observe /\ H) /\ WF_vars(AfterEnd /\ H) /\ WF_vars(AfterEndOnly /\ H) /\ WF_vars(Notify /\ H)
    /\ \A s \in Scopes : WF_vars(Admit(s) /\ H)
    /\ \A i \in Ids : WF_vars(Route(i) /\ H) /\ WF_vars(Decide(i) /\ H)
    /\ WF_vars(Resume /\ H) /\ WF_vars(StopGraceEnds /\ H)

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ Fairness

----------------------------------------------------------------------------
TypeOK ==
    /\ runSt \in Live \cup Ended
    /\ pc \in {"loop", "collect", "settle", "route", "endbranch", "cancelbr", "join", "finish", "wait", "paused", "ended",
              "observe", "children", "childrenonly", "notify"}
    /\ steps \in 0..(Limit + 1)
    /\ batch \subseteq Ids /\ dropped \subseteq Ids
    /\ notified \in Nat
    /\ {accepted, cmdEnd, admittedAfterAccept, collectedAfterEnd} \subseteq BOOLEAN
    /\ {wfDel, childEnded, loserNotice} \subseteq BOOLEAN

(* Safety rules.                                                           *)
Inv_StepsBound == steps <= Limit
Inv_EndedNothingPending == runSt \in Ended => \A i \in Ids : ne[i].st # "pending"
Inv_ControllerEndsOnlyEndedRun == pc = "ended" => runSt \in Ended
Inv_CatchAllOnce == caCount <= 1
Inv_JoinAccountsAll == ~joinBad
Inv_JoinedOnlyAllSucceeded ==
    \A i \in Ids : (ne[i].st = "done" /\ ne[i].out = "joined") =>
        \A b \in Branches : \E t \in Ids : ne[t].node = "BT" /\ ne[t].scope = b /\ ne[t].out = "succ"
Inv_NoProtocolFault == fault = NONE
Inv_BranchConfined == ~escaped
Inv_NoAdmissionAfterStop == ~admittedStopping
Inv_ParallelBranchesBounded == Cardinality({b \in Branches : cur[b].on}) <= Conc
Inv_OneReport == notified <= 1
(* R2-RT-1: no result collected after the pause committed is routed before *)
(* the resume.                                                             *)
Inv_NoRouteWhilePaused == ~pausedRoute
(* R2-RT-1: the node limit never ends a paused run (S-RT1 reads the run    *)
(* first; 1.8.0 keeps this as a residual, S-RT1b).                         *)
Inv_NoFailWhilePaused == ~pausedEnd
(* S7-DX2: no node execution is admitted after a lifecycle command was    *)
(* accepted (the run has ended, and enterNode refuses an ended run).       *)
Inv_NoAdmitAfterAccept == ~admittedAfterAccept
(* S7-DX2: an ended run's collection routes none of its results.          *)
Inv_NoCollectAfterEnd == ~collectedAfterEnd
(* S7-DX2: the first run-ending commit wins; an ended run never changes.  *)
(* MF-O5: "[runSt \in Ended ..." parses as a function constructor; the    *)
(* parenthesis makes the action explicit.                                  *)
Prop_FirstEndWins == [][(runSt \in Ended) => (runSt' = runSt)]_runSt
(* r3 (S7-DX3). The parent is told only of an ended run, after its agent  *)
(* children were ended, and never of a run whose end was its deletion;    *)
(* a notice is never decided by a command that lost (N-2).                *)
Inv_ReportOnlyEnded == notified > 0 => runSt \in Ended
Inv_ReportAfterChildren == notified > 0 => childEnded
Inv_DeletedNotReported == runSt = "deleted" => notified = 0
Inv_NoticeFollowsWinner == ~loserNotice

(* Liveness.                                                               *)
Prop_ControllerEnds == <>(pc = "ended")
Prop_RunEnds == <>(runSt \in Ended)
(* S7-DX2: every accepted command ends the run, by its own transaction, and *)
(* the controller then ends and tells the parent.                          *)
Prop_CommandEnds == accepted ~> (cmdEnd /\ pc = "ended")
Prop_CommandTold == cmdEnd ~> (notified >= 1)
(* r3 (S7-DX3): an end by another writer that is not a deletion (an       *)
(* accepted command's, the owning chat's) is reconciled: the children are *)
(* ended and the parent is told (once: Inv_OneReport).                    *)
ElsewhereEnd == runSt = "chat_cancelled" \/ (runSt = "cancelled" /\ Cmd = "direct")
Prop_EndedElsewhereReported == ElsewhereEnd ~> (notified = 1 /\ childEnded)
(* Every end but a deletion is told to the parent ("whatever ended the    *)
(* run first decides who is told"; the requester is WfParent's).          *)
Prop_EndReported == (runSt \in Ended \ {"deleted"}) ~> (notified >= 1)
(* Every end, a deletion's too, ends the agent children; a deletion's     *)
(* only that.                                                              *)
Prop_ChildrenEnded == (runSt \in Ended) ~> childEnded
Prop_DeletedChildrenEnded == (runSt = "deleted") ~> (childEnded /\ pc = "ended" /\ notified = 0)

(* Witnesses, EXPECTED to be violated (reachable).                        *)
Wit_FailFastCancels == ~(par.cancelled /\ pc = "cancelbr")
Wit_JoinBlocked == ~(\E i \in Ids : ne[i].out = "blocked")
Wit_Joined == ~(\E i \in Ids : ne[i].out = "joined")
Wit_LimitEnds == ~(runSt = "failed" /\ steps >= Limit /\ pc = "ended")
Wit_CatchAllEntered == ~caEntered
Wit_StoppedWithWork == ~(runSt = "stopped" /\ \E i \in Ids : ne[i].win = "end")
Wit_DroppedResultSkipped == ~(pc = "route" /\ \E i \in batch : i \in dropped)
Wit_CommandEndsBusyRun == ~(cmdEnd /\ pc = "ended" /\ steps > 0 /\ notified = 1)
Wit_ChatEndReported == ~(runSt = "chat_cancelled" /\ pc = "ended" /\ notified = 1)
Wit_RetryObserved == ~(pc = "observe" /\ runSt \in {"completed", "failed"})
=============================================================================
