---------------------------- MODULE RerunPassOver ----------------------------
(***************************************************************************)
(* An admitted re-run #3 from its admission commit to its end and the     *)
(* end's cleanup (I7, audit RR-3, RR-5, RR-9, RR-11), on a clock.         *)
(*                                                                         *)
(* #3 holds Reused copied (completed) visits, then the new visits of a    *)
(* chain TLC chooses from Chains (receive, agent, spawn, parallel).       *)
(*                                                                         *)
(* Dispatch (service.ts createWorkflow -> dispatchWorkflowRun, after the   *)
(* admission's commit): a read of the run, then a separate orchestration  *)
(* start. A crash after the commit loses the dispatch: the run stays      *)
(* admitted with no controller until a receipt replay of the Start        *)
(* dispatches it again (recovered). A run that ended meanwhile (a command,*)
(* the owner's deletion) is not started. The clock runs throughout.       *)
(*                                                                         *)
(* The controller (1.3.0, unchanged) begins (runtime.ts begin: the run's  *)
(* own deadline starts here), then admits each visit with one enterNode   *)
(* activity, in store.ts's order: an existing row (copied, or inserted by *)
(* an earlier attempt) is answered as it is, whatever the run's state;    *)
(* else an active run past its deadline answers "expired" and changes     *)
(* nothing (a read-only decision); else a stop admits nothing new; else a *)
(* paused or ended run admits nothing; else the row is inserted (a receive*)
(* takes a carried message only if expires_at > now) and the first new   *)
(* row stamps rerun_resumed_at in the same transaction. On "expired" the  *)
(* controller runs expireRun, a transaction of its own, which ends an     *)
(* active (running or paused) run past its deadline and finds a run that  *)
(* ended meanwhile inactive. An activity's result can be lost and the     *)
(* activity run again, before or after the cut. Timers fire on the clock: *)
(* the run deadline (expireRun, running or paused), a receive's wait      *)
(* deadline and a parallel step's time limit (deadline_at <= now).        *)
(* TLC chooses each carried message's restarted expiry, the run's time    *)
(* limit, the wait and the parallel limit. The run ends completed, failed *)
(* (unhandled outcome, or expired), cancelled (a command, or the owner's  *)
(* deletion: 0096), or stopped; the end's transaction ends every pending  *)
(* visit; then the controller's end activities end each agent session the *)
(* run kept open (runtime.ts endAgent) and cancel each active child        *)
(* (parent-end:<run>), one activity per category. A message is carried at *)
(* the admission or sent to #3 later (acceptInput, while the run is       *)
(* active); a receive waiting for it takes it only while the run is       *)
(* running (the take and the end lock the run row; whichever commits     *)
(* second sees the other).                                                *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Reused,             \* 0..2 copied visits before the cut
    Chains,             \* names of new-visit chains (ChainOf), TLC picks one: "receive_receive", "agent_spawn", ...
    Msgs,               \* messages, e.g. {"m1", "m2"} or {}: carried into #3 at its admission, or sent to it later
    LateMsgs,           \* the messages TLC may choose to send to #3 after its admission instead of carrying them
    ExpChoices,         \* restarted expiries TLC chooses from (the admission commit is at clock 0; TTL is at least 1 s)
    RunLimits,          \* the run's time limits TLC chooses from (0 = none)
    WaitLimits,         \* a receive's wait.totalSeconds, TLC chooses
    ParLimits,          \* a parallel step's time limit, TLC chooses
    MaxClk,             \* the clock runs to MaxClk, and further only while a timer is armed ahead of it
    MaxRetries,         \* lost enterNode results re-run (0..2)
    AllowCtrl,          \* cancel, stop, pause/resume commands
    AllowOwnerEnd,      \* the owner session is deleted (0096: the active run is cancelled)
    AllowLostDispatch,  \* a crash after the admission commit loses the dispatch; a receipt replay recovers it
    \* ---- faults ----
    StampSeparateTx,    \* rerun_resumed_at is stamped in a second transaction after the first new row's insert
    TakeNotIdempotent,  \* a re-run enterNode of a receive that took a message takes it again
    TakeAtExpiry,       \* a take accepts expires_at >= now (a message expiring this instant)
    CopyKeepsRunDeadline, \* the copy keeps #2's run deadline (already past) instead of starting it at begin
    DeadlineEarlyFor,   \* timer kinds ("receive", "parallel", "run") that fire one tick early (deadline_at < now + 1)
    TakeIgnoresEnd,     \* a message delivered to a waiting receive is taken after the run ended (no terminal fence)
    SkipChildCancelWhen,  \* end kinds whose end activities leave an active child running
    SkipAgentEndWhen,     \* end kinds whose end activities leave an agent session open
    NoCleanupOnOwnerEnd,  \* a run the owner's deletion ended gets no end activities
    StopKeepsPending      \* the stop's end transaction leaves pending visits pending

ASSUME Reused \in 0..2 /\ MaxRetries \in 0..2 /\ MaxClk \in 1..8 /\ LateMsgs \subseteq Msgs
ASSUME {AllowCtrl, AllowOwnerEnd, AllowLostDispatch, StampSeparateTx, TakeNotIdempotent, TakeAtExpiry, CopyKeepsRunDeadline,
        TakeIgnoresEnd, NoCleanupOnOwnerEnd, StopKeepsPending} \subseteq BOOLEAN
ASSUME DeadlineEarlyFor \subseteq {"receive", "parallel", "run"}

ChainOf(name) ==
    CASE name = "receive_receive" -> <<"receive", "receive">>
      [] name = "agent_spawn"     -> <<"agent", "spawn">>
      [] name = "parallel_agent"  -> <<"parallel", "agent">>
      [] name = "spawn_parallel"  -> <<"spawn", "parallel">>
      [] OTHER                    -> <<"agent">>
ASSUME Chains \subseteq {"receive_receive", "agent_spawn", "parallel_agent", "spawn_parallel"}

Terminal == {"completed", "failed", "cancelled", "stopped"}
Active == {"admitted", "running", "paused"}
NoTime == 99

VARIABLES
    chain,          \* the new visits' kinds (chosen in Init)
    exp,            \* [Msgs -> ExpChoices]: a carried message's restarted expires_at, or a later message's expires_at
    arrived,        \* [Msgs -> BOOLEAN]: the message is in #3's inbox (carried at the admission, or sent and accepted since)
    runLimit, waitLimit, parLimit,
    clk,
    disp,           \* dispatch: "committed" | "lost" | "read" | "started" | "skipped"
    recovered,      \* a lost dispatch was recovered by a receipt replay
    runStatus, endKind, endAt, failCode,
    begunAt, runDl,
    pc,             \* "begin" | "admit" | "expire" | "stop" | "paused" | "work" | "wait" | "next" | "endacts" | "done"
    cur,            \* visit being admitted / worked (1..Len)
    row,            \* [1..Len -> "absent" | "pending" | "completed"]
    outcome,        \* [1..Len -> "none" | "ok" | "msg" | "timed_out" | "ended"]
    armedAt,        \* [1..Len -> clock]: an armed timer's deadline (NoTime = none)
    dlOf, firedAt,  \* [1..Len -> clock]: the deadline a visit's timer was armed with, and when it fired (NoTime = never)
    resumedAt, stampOwed,
    actRes,         \* "none" | "row" | "expired" | "stopping" | "paused" | "ended": the enterNode result not yet recorded
    retries,
    lostNew,        \* "none" | "new_row" | "receive_take": the kind of new-row result a retry discarded
    taken, takenAt, \* [Msgs -> 0..2], [Msgs -> clock]
    tookBy,         \* [1..Len -> Msgs \cup {"none"}]: the message a receive took
    evt, takeSeq, endSeq,   \* causal order: a counter bumped by every take and by the end; 0 = not yet
    sess,           \* agent session: "absent" | "live" | "ended"
    child,          \* spawned child: "absent" | "active" | "completed" | "cancelled"
    agentEndDone, childCancelDone,  \* the end activities ran
    stopReq, cancelUsed, pauseUsed, ownerGone,
    \* ghosts for the properties and witnesses
    timerEarly, expiredEarly,   \* a visit timer fired before its deadline; the run expired before its own deadline
    expFrom,        \* "none" | "running" | "paused": the status expireRun ended the run from
    expireIdle,     \* expireRun found the run already ended by something else after enterNode answered "expired"
    rcvSawExpired   \* a receive was decided at an instant when an untaken carried message had already expired

Last == Reused + Len(chain)
Visits == 1..Last
KindAt(i) == IF i <= Reused THEN "copied" ELSE chain[i - Reused]
IsNew(i) == i > Reused
TimerKindAt(i) == KindAt(i)     \* "receive" (wait) or "parallel" (time limit)

vars == <<chain, exp, arrived, runLimit, waitLimit, parLimit, clk, disp, recovered, runStatus, endKind, endAt, failCode, begunAt, runDl,
          pc, cur, row, outcome, armedAt, dlOf, firedAt, resumedAt, stampOwed, actRes, retries, lostNew, taken, takenAt, tookBy,
          evt, takeSeq, endSeq, sess, child, agentEndDone, childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone,
          timerEarly, expiredEarly, expFrom, expireIdle, rcvSawExpired>>

Init ==
    /\ chain \in {ChainOf(name) : name \in Chains}
    /\ exp \in [Msgs -> ExpChoices]
    /\ arrived \in [Msgs -> BOOLEAN] /\ \A m \in Msgs \ LateMsgs : arrived[m]
    /\ runLimit \in RunLimits /\ waitLimit \in WaitLimits /\ parLimit \in ParLimits
    /\ clk = 0
    /\ disp = "committed" /\ recovered = FALSE
    /\ runStatus = "admitted" /\ endKind = "none" /\ endAt = NoTime /\ failCode = "none"
    /\ begunAt = NoTime /\ runDl = NoTime
    /\ pc = "begin" /\ cur = 1
    /\ row = [i \in 1..(Reused + Len(chain)) |-> IF i <= Reused THEN "completed" ELSE "absent"]
    /\ outcome = [i \in 1..(Reused + Len(chain)) |-> IF i <= Reused THEN "ok" ELSE "none"]
    /\ armedAt = [i \in 1..(Reused + Len(chain)) |-> NoTime]
    /\ dlOf = [i \in 1..(Reused + Len(chain)) |-> NoTime]
    /\ firedAt = [i \in 1..(Reused + Len(chain)) |-> NoTime]
    /\ resumedAt = FALSE /\ stampOwed = FALSE /\ actRes = "none" /\ retries = 0 /\ lostNew = "none"
    /\ taken = [m \in Msgs |-> 0] /\ takenAt = [m \in Msgs |-> NoTime]
    /\ tookBy = [i \in 1..(Reused + Len(chain)) |-> "none"]
    /\ evt = 0 /\ takeSeq = [m \in Msgs |-> 0] /\ endSeq = 0
    /\ sess = "absent" /\ child = "absent" /\ agentEndDone = FALSE /\ childCancelDone = FALSE
    /\ stopReq = FALSE /\ cancelUsed = FALSE /\ pauseUsed = FALSE /\ ownerGone = FALSE
    /\ timerEarly = FALSE /\ expiredEarly = FALSE /\ expFrom = "none" /\ expireIdle = FALSE /\ rcvSawExpired = FALSE

-----------------------------------------------------------------------------
(* Time                                                                    *)

\* A deadline of timer kind k is due when deadline_at <= now (fault DeadlineEarlyFor: one tick early).
Due(k, dl) == IF k \in DeadlineEarlyFor THEN dl <= clk + 1 ELSE dl <= clk
ArmedAhead == (runStatus \in Active /\ runDl # NoTime /\ runDl > clk) \/ (\E i \in Visits : row[i] = "pending" /\ armedAt[i] > clk /\ armedAt[i] # NoTime)
\* The clock runs to MaxClk, and beyond it only while a deadline is armed ahead (each one is finite).
Tick ==
    /\ clk < MaxClk \/ ArmedAhead
    /\ clk' = clk + 1
    /\ UNCHANGED <<chain, exp, arrived, runLimit, waitLimit, parLimit, disp, recovered, runStatus, endKind, endAt, failCode, begunAt,
                   runDl, pc, cur, row, outcome, armedAt, dlOf, firedAt, resumedAt, stampOwed, actRes, retries, lostNew, taken,
                   takenAt, tookBy, evt, takeSeq, endSeq, sess, child, agentEndDone, childCancelDone, stopReq, cancelUsed,
                   pauseUsed, ownerGone, timerEarly, expiredEarly, expFrom, expireIdle, rcvSawExpired>>

\* A carried message a receive can take now: not taken, and expires_at > now (fault TakeAtExpiry: >=).
Takeable(m) == arrived[m] /\ taken[m] = 0 /\ (IF TakeAtExpiry THEN exp[m] >= clk ELSE exp[m] > clk)
\* An untaken message in the inbox that has already expired now.
ExpiredUntaken == \E m \in Msgs : arrived[m] /\ taken[m] = 0 /\ exp[m] <= clk

\* store.ts acceptInput: a message sent to #3 after its admission is accepted while the run is active (its expiry is
\* after now). A receive waiting for it can then take it.
Arrive(m) ==
    /\ m \in LateMsgs /\ ~arrived[m] /\ runStatus \in Active /\ exp[m] > clk
    /\ arrived' = [arrived EXCEPT ![m] = TRUE]
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, disp, recovered, runStatus, endKind, endAt, failCode, begunAt,
                   runDl, pc, cur, row, outcome, armedAt, dlOf, firedAt, resumedAt, stampOwed, actRes, retries, lostNew, taken,
                   takenAt, tookBy, evt, takeSeq, endSeq, sess, child, agentEndDone, childCancelDone, stopReq, cancelUsed,
                   pauseUsed, ownerGone, timerEarly, expiredEarly, expFrom, expireIdle, rcvSawExpired>>

\* The run's end transaction (finishRun / cancelRun / expireRun / stop / the 0096 trigger): every pending visit ends with it,
\* and it takes the next place in the causal order.
EndRun(status, kind, code) ==
    /\ runStatus' = status /\ endKind' = kind /\ endAt' = clk /\ failCode' = code
    /\ row' = [i \in Visits |-> IF row[i] = "pending" THEN "completed" ELSE row[i]]
    /\ outcome' = [i \in Visits |-> IF row[i] = "pending" THEN "ended" ELSE outcome[i]]
    /\ armedAt' = [i \in Visits |-> IF row[i] = "pending" THEN NoTime ELSE armedAt[i]]
    /\ evt' = evt + 1 /\ endSeq' = evt + 1

\* A take of carried message m by visit i: the next place in the causal order.
Take(m, i) ==
    /\ taken' = [taken EXCEPT ![m] = @ + 1] /\ takenAt' = [takenAt EXCEPT ![m] = clk] /\ tookBy' = [tookBy EXCEPT ![i] = m]
    /\ evt' = evt + 1 /\ takeSeq' = [takeSeq EXCEPT ![m] = IF @ = 0 THEN evt + 1 ELSE @]

-----------------------------------------------------------------------------
(* Dispatch, after the admission's commit                                  *)

DispUnchanged == UNCHANGED <<chain, exp, arrived, runLimit, waitLimit, parLimit, clk, runStatus, endKind, endAt, failCode, begunAt, runDl,
                             cur, row, outcome, armedAt, dlOf, firedAt, resumedAt, stampOwed, actRes, retries, lostNew, taken,
                             takenAt, tookBy, evt, takeSeq, endSeq, sess, child, agentEndDone, childCancelDone, stopReq,
                             cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly, expFrom, expireIdle, rcvSawExpired>>
\* A crash after the admission committed and before dispatchWorkflowRun ran: the run stays admitted with no controller.
DispatchLost ==
    /\ AllowLostDispatch /\ disp = "committed" /\ ~recovered
    /\ disp' = "lost"
    /\ UNCHANGED <<pc, recovered>> /\ DispUnchanged
\* A receipt replay of the same Start dispatches the stored run again (duroxide makes the start idempotent).
Recover ==
    /\ disp = "lost"
    /\ disp' = "committed" /\ recovered' = TRUE
    /\ UNCHANGED pc /\ DispUnchanged
\* dispatchWorkflowRun: a read of the run; an ended run is not started (no controller: nothing to end or clean up).
DispatchRead ==
    /\ disp = "committed"
    /\ IF runStatus \in Active THEN disp' = "read" /\ UNCHANGED pc ELSE disp' = "skipped" /\ pc' = "done"
    /\ UNCHANGED recovered /\ DispUnchanged
\* The orchestration start, separate from the read: the run may have ended in between (begin then finds it ended).
DispatchStart ==
    /\ disp = "read"
    /\ disp' = "started"
    /\ UNCHANGED <<pc, recovered>> /\ DispUnchanged

-----------------------------------------------------------------------------
(* Controller                                                              *)

CtrlUnchanged == UNCHANGED <<chain, exp, arrived, runLimit, waitLimit, parLimit, clk, disp, recovered, sess, child, agentEndDone,
                             childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone>>

Begin ==
    /\ pc = "begin" /\ disp = "started"
    /\ IF runStatus = "admitted"
         THEN /\ runStatus' = "running" /\ begunAt' = clk
              /\ runDl' = IF CopyKeepsRunDeadline THEN 0 ELSE IF runLimit = 0 THEN NoTime ELSE clk + runLimit
              /\ pc' = "admit"
         ELSE /\ pc' = "endacts" /\ UNCHANGED <<runStatus, begunAt, runDl>>
    /\ UNCHANGED <<endKind, endAt, failCode, cur, row, outcome, armedAt, dlOf, firedAt, resumedAt, stampOwed, actRes, retries,
                   lostNew, taken, takenAt, tookBy, evt, takeSeq, endSeq, timerEarly, expiredEarly, expFrom, expireIdle,
                   rcvSawExpired>>
    /\ CtrlUnchanged

\* store.ts enterNode, one transaction, in its order: an existing row is answered as it is (fault TakeNotIdempotent: a
\* receive that took a message takes it again); else an active run past its deadline answers "expired" and changes
\* nothing; else a stop admits nothing new; else a paused or ended run admits nothing; else the row is inserted (a
\* receive takes a carried message if one is takeable), and the first new row stamps rerun_resumed_at in the same
\* transaction (fault StampSeparateTx: a second transaction, StampTx, owes it).
AdmitExec ==
    /\ pc = "admit" /\ actRes = "none"
    /\ LET i == cur IN
       IF row[i] # "absent"
         THEN /\ IF TakeNotIdempotent /\ IsNew(i) /\ KindAt(i) = "receive" /\ tookBy[i] # "none"
                   THEN /\ taken' = [taken EXCEPT ![tookBy[i]] = @ + 1] /\ evt' = evt + 1
                   ELSE UNCHANGED <<taken, evt>>
              /\ actRes' = "row"
              /\ UNCHANGED <<row, outcome, armedAt, dlOf, resumedAt, stampOwed, takenAt, tookBy, takeSeq, rcvSawExpired>>
       ELSE IF runStatus \in Active /\ runDl # NoTime /\ Due("run", runDl)
         THEN /\ actRes' = "expired"
              /\ UNCHANGED <<row, outcome, armedAt, dlOf, resumedAt, stampOwed, taken, takenAt, tookBy, evt, takeSeq, rcvSawExpired>>
       ELSE IF runStatus \in Active /\ stopReq
         THEN /\ actRes' = "stopping"
              /\ UNCHANGED <<row, outcome, armedAt, dlOf, resumedAt, stampOwed, taken, takenAt, tookBy, evt, takeSeq, rcvSawExpired>>
       ELSE IF runStatus # "running"
         THEN /\ actRes' = IF runStatus = "paused" THEN "paused" ELSE "ended"
              /\ UNCHANGED <<row, outcome, armedAt, dlOf, resumedAt, stampOwed, taken, takenAt, tookBy, evt, takeSeq, rcvSawExpired>>
       ELSE LET take == KindAt(i) = "receive" /\ \E m \in Msgs : Takeable(m)
                m == IF take THEN CHOOSE x \in Msgs : Takeable(x) ELSE "none"
                dl == CASE take -> NoTime
                        [] KindAt(i) = "receive" -> clk + waitLimit
                        [] KindAt(i) = "parallel" -> clk + parLimit
                        [] OTHER -> NoTime
            IN /\ row' = [row EXCEPT ![i] = IF take THEN "completed" ELSE "pending"]
               /\ outcome' = [outcome EXCEPT ![i] = IF take THEN "msg" ELSE "none"]
               /\ armedAt' = [armedAt EXCEPT ![i] = dl]
               /\ dlOf' = [dlOf EXCEPT ![i] = dl]
               /\ IF take THEN Take(m, i) ELSE UNCHANGED <<taken, takenAt, tookBy, evt, takeSeq>>
               /\ rcvSawExpired' = (rcvSawExpired \/ (KindAt(i) = "receive" /\ ExpiredUntaken))
               /\ IF ~resumedAt /\ ~stampOwed
                    THEN IF StampSeparateTx THEN stampOwed' = TRUE /\ UNCHANGED resumedAt
                         ELSE resumedAt' = TRUE /\ UNCHANGED stampOwed
                    ELSE UNCHANGED <<resumedAt, stampOwed>>
               /\ actRes' = "row"
    /\ UNCHANGED <<runStatus, endKind, endAt, failCode, begunAt, runDl, pc, cur, firedAt, retries, lostNew, endSeq,
                   timerEarly, expiredEarly, expFrom, expireIdle>>
    /\ CtrlUnchanged

\* Fault StampSeparateTx: the stamp's own transaction (lost if the activity's result is lost first).
StampTx ==
    /\ stampOwed /\ actRes # "none"
    /\ resumedAt' = TRUE /\ stampOwed' = FALSE
    /\ UNCHANGED <<runStatus, endKind, endAt, failCode, begunAt, runDl, pc, cur, row, outcome, armedAt, dlOf, firedAt, actRes,
                   retries, lostNew, taken, takenAt, tookBy, evt, takeSeq, endSeq, timerEarly, expiredEarly, expFrom,
                   expireIdle, rcvSawExpired>>
    /\ CtrlUnchanged

\* The activity's result is lost and the activity runs again (before or after the cut). lostNew records whether the lost
\* result was a new row's, and whether that row was a receive that took a carried message.
AdmitRetry ==
    /\ pc = "admit" /\ actRes # "none" /\ retries < MaxRetries
    /\ actRes' = "none" /\ retries' = retries + 1
    /\ stampOwed' = FALSE
    /\ lostNew' = IF actRes = "row" /\ IsNew(cur) /\ KindAt(cur) = "receive" /\ tookBy[cur] # "none" THEN "receive_take"
                  ELSE IF actRes = "row" /\ IsNew(cur) /\ lostNew = "none" THEN "new_row"
                  ELSE lostNew
    /\ UNCHANGED <<runStatus, endKind, endAt, failCode, begunAt, runDl, pc, cur, row, outcome, armedAt, dlOf, firedAt, resumedAt,
                   taken, takenAt, tookBy, evt, takeSeq, endSeq, timerEarly, expiredEarly, expFrom, expireIdle, rcvSawExpired>>
    /\ CtrlUnchanged

AdmitRecord ==
    /\ pc = "admit" /\ actRes # "none" /\ ~stampOwed
    /\ actRes' = "none"
    /\ pc' = CASE actRes = "ended" -> "endacts"
               [] actRes = "expired" -> "expire"
               [] actRes = "stopping" -> "stop"
               [] actRes = "paused" -> "paused"
               [] row[cur] = "completed" -> "next"
               [] OTHER -> "work"
    /\ UNCHANGED <<runStatus, endKind, endAt, failCode, begunAt, runDl, cur, row, outcome, armedAt, dlOf, firedAt, resumedAt,
                   stampOwed, retries, lostNew, taken, takenAt, tookBy, evt, takeSeq, endSeq, timerEarly, expiredEarly,
                   expFrom, expireIdle, rcvSawExpired>>
    /\ CtrlUnchanged

\* runtime.ts expireRun -> store.ts expireRun, a transaction of its own after enterNode answered "expired": an active
\* (running or paused) run past its deadline ends failed, expired; a run something else ended in between is inactive.
ExpireTx ==
    /\ pc = "expire"
    /\ IF runStatus \in Active /\ runDl # NoTime /\ Due("run", runDl)
         THEN /\ EndRun("failed", "failed", "expired")
              /\ expiredEarly' = (expiredEarly \/ clk < begunAt + runLimit \/ runLimit = 0)
              /\ expFrom' = runStatus
              /\ UNCHANGED expireIdle
         ELSE /\ expireIdle' = (expireIdle \/ runStatus \in Terminal)
              /\ UNCHANGED <<runStatus, endKind, endAt, failCode, row, outcome, armedAt, evt, endSeq, expiredEarly, expFrom>>
    /\ pc' = "endacts"
    /\ UNCHANGED <<begunAt, runDl, cur, dlOf, firedAt, resumedAt, stampOwed, actRes, retries, lostNew, taken, takenAt, tookBy,
                   takeSeq, timerEarly, rcvSawExpired>>
    /\ CtrlUnchanged

WaitResume ==
    /\ pc = "paused" /\ runStatus # "paused"
    /\ pc' = "admit"
    /\ UNCHANGED <<runStatus, endKind, endAt, failCode, begunAt, runDl, cur, row, outcome, armedAt, dlOf, firedAt, resumedAt,
                   stampOwed, actRes, retries, lostNew, taken, takenAt, tookBy, evt, takeSeq, endSeq, timerEarly, expiredEarly,
                   expFrom, expireIdle, rcvSawExpired>>
    /\ CtrlUnchanged

\* A graceful stop requested earlier: the controller ends the run stopped when enterNode answers "stopping".
StopAtPoll ==
    /\ pc = "stop"
    /\ IF runStatus \in Active /\ StopKeepsPending
         THEN /\ runStatus' = "stopped" /\ endKind' = "stopped" /\ endAt' = clk /\ evt' = evt + 1 /\ endSeq' = evt + 1
              /\ UNCHANGED <<failCode, row, outcome, armedAt>>
       ELSE IF runStatus \in Active THEN EndRun("stopped", "stopped", "none")
       ELSE UNCHANGED <<runStatus, endKind, endAt, failCode, row, outcome, armedAt, evt, endSeq>>
    /\ pc' = "endacts"
    /\ UNCHANGED <<begunAt, runDl, cur, dlOf, firedAt, resumedAt, stampOwed, actRes, retries, lostNew, taken, takenAt, tookBy,
                   takeSeq, timerEarly, expiredEarly, expFrom, expireIdle, rcvSawExpired>>
    /\ CtrlUnchanged

\* A stop requested while a visit is in flight: when its grace period ends, the run ends stopped and the visit with it.
StopGraceEnds ==
    /\ pc = "wait" /\ stopReq /\ runStatus = "running"
    /\ IF StopKeepsPending
         THEN /\ runStatus' = "stopped" /\ endKind' = "stopped" /\ endAt' = clk /\ evt' = evt + 1 /\ endSeq' = evt + 1
              /\ UNCHANGED <<failCode, row, outcome, armedAt>>
         ELSE EndRun("stopped", "stopped", "none")
    /\ UNCHANGED <<begunAt, runDl, pc, cur, dlOf, firedAt, resumedAt, stampOwed, actRes, retries, lostNew, taken, takenAt, tookBy,
                   takeSeq, timerEarly, expiredEarly, expFrom, expireIdle, rcvSawExpired>>
    /\ CtrlUnchanged

\* The visit's work (effects start once, when admitted pending): an agent's session opens (it stays open for the next
\* cycle until the run ends); a spawn's child starts; the parallel step's lanes run. Then the visit completes.
StartWork ==
    /\ pc = "work" /\ row[cur] = "pending"
    /\ sess' = IF KindAt(cur) = "agent" /\ sess = "absent" THEN "live" ELSE sess
    /\ child' = IF KindAt(cur) = "spawn" /\ child = "absent" THEN "active" ELSE child
    /\ pc' = "wait"
    /\ UNCHANGED <<chain, exp, arrived, runLimit, waitLimit, parLimit, clk, disp, recovered, runStatus, endKind, endAt, failCode, begunAt,
                   runDl, cur, row, outcome, armedAt, dlOf, firedAt, resumedAt, stampOwed, actRes, retries, lostNew, taken,
                   takenAt, tookBy, evt, takeSeq, endSeq, agentEndDone, childCancelDone, stopReq, cancelUsed, pauseUsed,
                   ownerGone, timerEarly, expiredEarly, expFrom, expireIdle, rcvSawExpired>>
WorkEndedEarly ==
    /\ pc = "work" /\ row[cur] # "pending"
    /\ pc' = IF runStatus \in Terminal THEN "endacts" ELSE "next"
    /\ UNCHANGED <<runStatus, endKind, endAt, failCode, begunAt, runDl, cur, row, outcome, armedAt, dlOf, firedAt, resumedAt,
                   stampOwed, actRes, retries, lostNew, taken, takenAt, tookBy, evt, takeSeq, endSeq, timerEarly, expiredEarly,
                   expFrom, expireIdle, rcvSawExpired>>
    /\ CtrlUnchanged

\* A pending visit completes: the agent reports, the child ends and its notice arrives, the lanes finish, or a pending
\* receive takes a carried message that is still takeable. A take needs a running run (the terminal fence); fault
\* TakeIgnoresEnd: a message delivered to the receive after the run's end transaction is still taken.
Complete(i, o) ==
    /\ row' = [row EXCEPT ![i] = "completed"] /\ outcome' = [outcome EXCEPT ![i] = o] /\ armedAt' = [armedAt EXCEPT ![i] = NoTime]
VisitDone ==
    /\ pc = "wait" /\ row[cur] = "pending" /\ runStatus = "running"
    /\ \/ /\ KindAt(cur) = "agent" /\ Complete(cur, "ok") /\ UNCHANGED <<child, taken, takenAt, tookBy, evt, takeSeq, rcvSawExpired>>
       \/ /\ KindAt(cur) = "spawn" /\ child = "active" /\ child' = "completed" /\ Complete(cur, "ok")
          /\ UNCHANGED <<taken, takenAt, tookBy, evt, takeSeq, rcvSawExpired>>
       \/ /\ KindAt(cur) = "parallel" /\ Complete(cur, "ok") /\ UNCHANGED <<child, taken, takenAt, tookBy, evt, takeSeq, rcvSawExpired>>
       \/ /\ KindAt(cur) = "receive" /\ \E m \in Msgs : Takeable(m)
          /\ rcvSawExpired' = (rcvSawExpired \/ ExpiredUntaken)
          /\ LET m == CHOOSE x \in Msgs : Takeable(x) IN Take(m, cur) /\ Complete(cur, "msg")
          /\ UNCHANGED child
    /\ UNCHANGED <<chain, exp, arrived, runLimit, waitLimit, parLimit, clk, disp, recovered, runStatus, endKind, endAt, failCode, begunAt,
                   runDl, pc, cur, dlOf, firedAt, resumedAt, stampOwed, actRes, retries, lostNew, endSeq, sess, agentEndDone,
                   childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly, expFrom, expireIdle>>
LateTake ==
    /\ TakeIgnoresEnd
    /\ runStatus \in Terminal /\ KindAt(cur) = "receive" /\ outcome[cur] = "ended" /\ tookBy[cur] = "none"
    /\ \E m \in Msgs : Takeable(m)
    /\ LET m == CHOOSE x \in Msgs : Takeable(x) IN Take(m, cur)
    /\ UNCHANGED <<chain, exp, arrived, runLimit, waitLimit, parLimit, clk, disp, recovered, runStatus, endKind, endAt, failCode, begunAt,
                   runDl, pc, cur, row, outcome, armedAt, dlOf, firedAt, resumedAt, stampOwed, actRes, retries, lostNew, endSeq,
                   sess, child, agentEndDone, childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly,
                   expiredEarly, expFrom, expireIdle, rcvSawExpired>>

\* A visit timer: a receive's wait deadline or a parallel step's time limit (deadline_at <= now): the visit completes
\* timed_out (the parallel's lanes are cancelled with it).
VisitTimerFires(i) ==
    /\ row[i] = "pending" /\ runStatus = "running" /\ armedAt[i] # NoTime /\ Due(TimerKindAt(i), armedAt[i])
    /\ timerEarly' = (timerEarly \/ clk < armedAt[i])
    /\ firedAt' = [firedAt EXCEPT ![i] = clk]
    /\ rcvSawExpired' = (rcvSawExpired \/ (KindAt(i) = "receive" /\ ExpiredUntaken))
    /\ Complete(i, "timed_out")
    /\ UNCHANGED <<chain, exp, arrived, runLimit, waitLimit, parLimit, clk, disp, recovered, runStatus, endKind, endAt, failCode, begunAt,
                   runDl, pc, cur, dlOf, resumedAt, stampOwed, actRes, retries, lostNew, taken, takenAt, tookBy, evt, takeSeq,
                   endSeq, sess, child, agentEndDone, childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, expiredEarly,
                   expFrom, expireIdle>>

\* The run deadline's own timer (runtime.ts expireRun -> store.ts expireRun): an active run, running or paused, ends
\* failed, expired.
RunDeadlineFires ==
    /\ runStatus \in {"running", "paused"} /\ runDl # NoTime /\ Due("run", runDl)
    /\ EndRun("failed", "failed", "expired")
    /\ expiredEarly' = (expiredEarly \/ clk < begunAt + runLimit \/ runLimit = 0)
    /\ expFrom' = runStatus
    /\ UNCHANGED <<chain, exp, arrived, runLimit, waitLimit, parLimit, clk, disp, recovered, begunAt, runDl, pc, cur, dlOf, firedAt,
                   resumedAt, stampOwed, actRes, retries, lostNew, taken, takenAt, tookBy, takeSeq, sess, child, agentEndDone,
                   childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expireIdle, rcvSawExpired>>

\* The controller collects the visit and routes: ok or msg goes on; timed_out (no route for it) fails the run; past the
\* last visit the run completes.
Collect ==
    /\ pc \in {"wait", "next"} /\ row[cur] = "completed"
    /\ IF runStatus \in Terminal
         THEN /\ pc' = "endacts" /\ UNCHANGED <<cur, runStatus, endKind, endAt, failCode, row, outcome, armedAt, evt, endSeq>>
       ELSE IF outcome[cur] = "timed_out"
         THEN /\ EndRun("failed", "failed", "unhandled") /\ pc' = "endacts" /\ UNCHANGED cur
       ELSE IF cur = Last
         THEN /\ EndRun("completed", "completed", "none") /\ pc' = "endacts" /\ UNCHANGED cur
         ELSE /\ cur' = cur + 1 /\ pc' = "admit"
              /\ UNCHANGED <<runStatus, endKind, endAt, failCode, row, outcome, armedAt, evt, endSeq>>
    /\ UNCHANGED <<begunAt, runDl, dlOf, firedAt, resumedAt, stampOwed, actRes, retries, lostNew, taken, takenAt, tookBy,
                   takeSeq, timerEarly, expiredEarly, expFrom, expireIdle, rcvSawExpired>>
    /\ CtrlUnchanged
\* A controller waiting on a visit sees the run ended (by a command, the owner or the deadline) and goes to its end activities.
WaitSeesEnd ==
    /\ pc = "wait" /\ runStatus \in Terminal
    /\ pc' = "endacts"
    /\ UNCHANGED <<runStatus, endKind, endAt, failCode, begunAt, runDl, cur, row, outcome, armedAt, dlOf, firedAt, resumedAt,
                   stampOwed, actRes, retries, lostNew, taken, takenAt, tookBy, evt, takeSeq, endSeq, timerEarly, expiredEarly,
                   expFrom, expireIdle, rcvSawExpired>>
    /\ CtrlUnchanged

-----------------------------------------------------------------------------
(* The end's activities, one per category                                  *)

EndActUnchanged == UNCHANGED <<chain, exp, arrived, runLimit, waitLimit, parLimit, clk, disp, recovered, runStatus, endKind, endAt,
                               failCode, begunAt, runDl, cur, row, outcome, armedAt, dlOf, firedAt, resumedAt, stampOwed, actRes,
                               retries, lostNew, taken, takenAt, tookBy, evt, takeSeq, endSeq, stopReq, cancelUsed, pauseUsed,
                               ownerGone, timerEarly, expiredEarly, expFrom, expireIdle, rcvSawExpired>>
\* runtime.ts endAgent for every session the run kept open (fault SkipAgentEndWhen: not for those end kinds).
EndAgents ==
    /\ pc = "endacts" /\ ~agentEndDone /\ runStatus \in Terminal
    /\ ~(NoCleanupOnOwnerEnd /\ ownerGone)
    /\ agentEndDone' = TRUE
    /\ sess' = IF sess = "live" /\ endKind \notin SkipAgentEndWhen THEN "ended" ELSE sess
    /\ UNCHANGED <<pc, child, childCancelDone>> /\ EndActUnchanged
\* runtime.ts: each active child is cancelled with its own command, operation id parent-end:<runId> (fault
\* SkipChildCancelWhen: not for those end kinds).
CancelChildren ==
    /\ pc = "endacts" /\ ~childCancelDone /\ runStatus \in Terminal
    /\ ~(NoCleanupOnOwnerEnd /\ ownerGone)
    /\ childCancelDone' = TRUE
    /\ child' = IF child = "active" /\ endKind \notin SkipChildCancelWhen THEN "cancelled" ELSE child
    /\ UNCHANGED <<pc, sess, agentEndDone>> /\ EndActUnchanged
EndActsDone ==
    /\ pc = "endacts"
    /\ (agentEndDone /\ childCancelDone) \/ (NoCleanupOnOwnerEnd /\ ownerGone)
    /\ pc' = "done"
    /\ UNCHANGED <<sess, child, agentEndDone, childCancelDone>> /\ EndActUnchanged

-----------------------------------------------------------------------------
(* Commands and the owner                                                  *)

CmdUnchanged == UNCHANGED <<chain, exp, arrived, runLimit, waitLimit, parLimit, clk, disp, recovered, begunAt, runDl, pc, cur, dlOf,
                            firedAt, resumedAt, stampOwed, actRes, retries, lostNew, taken, takenAt, tookBy, takeSeq, sess,
                            child, agentEndDone, childCancelDone, timerEarly, expiredEarly, expFrom, expireIdle, rcvSawExpired>>
Cancel ==
    /\ AllowCtrl /\ ~cancelUsed /\ runStatus \in Active
    /\ EndRun("cancelled", "cancelled", "none") /\ cancelUsed' = TRUE
    /\ UNCHANGED <<stopReq, pauseUsed, ownerGone>> /\ CmdUnchanged
Stop ==
    /\ AllowCtrl /\ ~stopReq /\ runStatus = "running"
    /\ stopReq' = TRUE
    /\ UNCHANGED <<runStatus, endKind, endAt, failCode, row, outcome, armedAt, evt, endSeq, cancelUsed, pauseUsed, ownerGone>>
    /\ CmdUnchanged
Pause ==
    /\ AllowCtrl /\ ~pauseUsed /\ runStatus = "running"
    /\ runStatus' = "paused" /\ pauseUsed' = TRUE
    /\ UNCHANGED <<endKind, endAt, failCode, row, outcome, armedAt, evt, endSeq, stopReq, cancelUsed, ownerGone>> /\ CmdUnchanged
Resume ==
    /\ runStatus = "paused"
    /\ runStatus' = "running"
    /\ UNCHANGED <<endKind, endAt, failCode, row, outcome, armedAt, evt, endSeq, stopReq, cancelUsed, pauseUsed, ownerGone>>
    /\ CmdUnchanged
\* 0096 workflow_on_owner_session_ended: the owner's deletion cancels the active run in its own transaction.
OwnerDeleted ==
    /\ AllowOwnerEnd /\ ~ownerGone
    /\ ownerGone' = TRUE
    /\ IF runStatus \in Active THEN EndRun("cancelled", "owner_deleted", "none")
       ELSE UNCHANGED <<runStatus, endKind, endAt, failCode, row, outcome, armedAt, evt, endSeq>>
    /\ UNCHANGED <<stopReq, cancelUsed, pauseUsed>> /\ CmdUnchanged

\* The open child settles on its own, whatever the run does.
ChildEndsAlone ==
    /\ child = "active" /\ runStatus \in Terminal
    /\ child' = "completed"
    /\ UNCHANGED <<pc, sess, agentEndDone, childCancelDone>> /\ EndActUnchanged

Done == pc = "done" /\ UNCHANGED vars

Dispatch == DispatchRead \/ DispatchStart \/ Recover
Ctrl == Begin \/ AdmitExec \/ StampTx \/ AdmitRecord \/ ExpireTx \/ WaitResume \/ StopAtPoll \/ StartWork \/ WorkEndedEarly
        \/ Collect \/ WaitSeesEnd \/ EndAgents \/ CancelChildren \/ EndActsDone
Timers == RunDeadlineFires \/ \E i \in Visits : VisitTimerFires(i)
Next == Dispatch \/ DispatchLost \/ Ctrl \/ AdmitRetry \/ VisitDone \/ LateTake \/ (\E m \in Msgs : Arrive(m)) \/ Timers \/ Tick
        \/ Cancel \/ Stop
        \/ StopGraceEnds \/ Pause \/ Resume \/ OwnerDeleted \/ ChildEndsAlone \/ Done

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Dispatch) /\ WF_vars(Ctrl) /\ WF_vars(VisitDone) /\ WF_vars(Timers) /\ WF_vars(Tick) /\ WF_vars(Resume)

-----------------------------------------------------------------------------
(* Properties                                                              *)

TypeOK ==
    /\ chain \in {ChainOf(name) : name \in Chains}
    /\ exp \in [Msgs -> ExpChoices] /\ arrived \in [Msgs -> BOOLEAN]
    /\ runLimit \in RunLimits /\ waitLimit \in WaitLimits /\ parLimit \in ParLimits
    /\ clk \in 0..(MaxClk + 12)
    /\ disp \in {"committed", "lost", "read", "started", "skipped"} /\ recovered \in BOOLEAN
    /\ runStatus \in Active \cup Terminal
    /\ endKind \in {"none", "completed", "failed", "cancelled", "stopped", "owner_deleted"}
    /\ failCode \in {"none", "expired", "unhandled"}
    /\ pc \in {"begin", "admit", "expire", "stop", "paused", "work", "wait", "next", "endacts", "done"}
    /\ cur \in Visits
    /\ row \in [Visits -> {"absent", "pending", "completed"}]
    /\ outcome \in [Visits -> {"none", "ok", "msg", "timed_out", "ended"}]
    /\ actRes \in {"none", "row", "expired", "stopping", "paused", "ended"}
    /\ retries \in 0..MaxRetries /\ lostNew \in {"none", "new_row", "receive_take"}
    /\ taken \in [Msgs -> 0..2] /\ tookBy \in [Visits -> Msgs \cup {"none"}]
    /\ evt \in 0..(Cardinality(Msgs) * 2 + 2) /\ endSeq \in 0..(Cardinality(Msgs) * 2 + 2)
    /\ takeSeq \in [Msgs -> 0..(Cardinality(Msgs) * 2 + 2)]
    /\ sess \in {"absent", "live", "ended"} /\ child \in {"absent", "active", "completed", "cancelled"}
    /\ {resumedAt, stampOwed, agentEndDone, childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly,
        expiredEarly, expireIdle, rcvSawExpired} \subseteq BOOLEAN
    /\ expFrom \in {"none", "running", "paused"}

\* RR-9: a carried message is taken at most once, also when an enterNode after the cut runs again.
Inv_TakeOnce == \A m \in Msgs : taken[m] <= 1
\* RR-3: a receive never takes a carried message at or after its (restarted) expiry.
Inv_NoExpiredTake == \A m \in Msgs : taken[m] > 0 => takenAt[m] < exp[m]
\* RR-9: a new row exists only with rerun_resumed_at stamped (in the same transaction).
Inv_ResumedIffNew == (\E i \in Visits : IsNew(i) /\ row[i] # "absent") => resumedAt
\* RR-11: the run expires only at or after its own deadline, counted from its begin (never #2's deadline), also when
\* the deadline passes during the pass-over over copied visits, before the dispatch, or while paused.
Inv_ExpiresNotEarly == ~expiredEarly
\* RR-11: a receive's wait deadline and a parallel step's time limit fire only at or after their deadline.
Inv_TimersNotEarly == ~timerEarly
\* An ended run has no pending visit (the end's transaction ends them).
Inv_TerminalNoPending == runStatus \in Terminal => \A i \in Visits : row[i] # "pending"
\* RR-5: once an ended run's end activities ran, no agent session it opened is open, for every end kind.
Inv_EndedNoLiveAgent == (runStatus \in Terminal /\ agentEndDone) => sess # "live"
\* RR-5: once an ended run's end activities ran, no child it spawned is active, for every end kind.
Inv_EndedNoActiveChild == (runStatus \in Terminal /\ childCancelDone) => child # "active"
\* RR-5: an ended run takes no carried message after its end: every take precedes the end in the causal order (a take
\* and the end in the same clock tick are still ordered).
Inv_EndedNoTake == \A m \in Msgs : (takeSeq[m] > 0 /\ endSeq > 0) => takeSeq[m] < endSeq
\* RR-5: every ended run's agent sessions and children are eventually closed (the end activities run for every end).
Live_EndedQuiesces == <>[](runStatus \in Terminal => (sess # "live" /\ child # "active"))

\* Witnesses (each expected violated).
\* RR-3: a receive was decided (it took a message, waited, or timed out) at an instant when another carried message had
\* already expired while the run waited for its dispatch or begin, or passed over copied visits.
Wit_NoExpiredBeforeReceive == ~(rcvSawExpired /\ runStatus \in Terminal)
\* RR-5: a message sent after the admission is taken by a receive that was waiting for it, and the run completes.
Wit_NoTakeOfLateMessage == ~(\E m \in LateMsgs : taken[m] = 1 /\ \E i \in Visits : tookBy[i] = m /\ row[i] = "completed"
                                                   /\ outcome[i] = "msg" /\ runStatus = "completed")
\* RR-3: a message taken the instant before it expires.
Wit_NoTakeAtLastInstant == ~(\E m \in Msgs : taken[m] = 1 /\ takenAt[m] + 1 = exp[m])
\* RR-9: the result of a new receive row that took a carried message was lost, the enterNode ran again (answered as it is,
\* no second take), and the run completed.
Wit_NoRetryAfterCut == ~(lostNew = "receive_take" /\ runStatus = "completed")
\* RR-11: the run deadline passed while the controller passed over copied visits.
Wit_NoExpireInPassOver == ~(failCode = "expired" /\ \A i \in Visits : IsNew(i) => row[i] = "absent")
\* RR-11: a receive's wait deadline fires exactly at its deadline (the tie deadline_at = now).
Wit_NoWaitTimerAtDeadline == ~(\E i \in Visits : KindAt(i) = "receive" /\ outcome[i] = "timed_out" /\ firedAt[i] = dlOf[i])
\* RR-11: a parallel step's time limit fires exactly at its deadline.
Wit_NoParallelTimerAtDeadline == ~(\E i \in Visits : KindAt(i) = "parallel" /\ outcome[i] = "timed_out" /\ firedAt[i] = dlOf[i])
\* RR-11: a paused run past its deadline is expired (expireRun accepts paused runs).
Wit_NoPausedExpiry == ~(failCode = "expired" /\ expFrom = "paused")
\* RR-11: enterNode answered "expired" and a command or the owner ended the run before expireRun's transaction, which
\* found it inactive.
Wit_NoEndBetweenExpiredAndExpire == ~expireIdle
\* RR-3 / RR-9: the admission committed, its dispatch was lost in a crash, a receipt replay recovered it, and the run
\* completed.
Wit_NoRecoveredDispatch == ~(recovered /\ runStatus = "completed")
\* A run ended (a command or the owner) before its dispatch read it: no controller is started for it.
Wit_NoEndBeforeDispatch == ~(disp = "skipped")
\* RR-5: a run stopped, cancelled, or ended by the owner with an open agent session and an active child, cleaned up.
Wit_NoCleanupAfterStop == ~(endKind = "stopped" /\ agentEndDone /\ childCancelDone /\ sess = "ended" /\ child = "cancelled")
Wit_NoCleanupAfterOwnerEnd == ~(endKind = "owner_deleted" /\ agentEndDone /\ childCancelDone /\ sess = "ended" /\ child = "cancelled")

=============================================================================
