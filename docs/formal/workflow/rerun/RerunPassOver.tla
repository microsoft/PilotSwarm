---------------------------- MODULE RerunPassOver ----------------------------
(***************************************************************************)
(* An admitted re-run #3 from its admission to its end and the end's      *)
(* cleanup (I7, audit RR-3, RR-5, RR-9, RR-11), on a clock.               *)
(*                                                                         *)
(* #3 holds Reused copied (completed) visits, then the new visits of a    *)
(* chain TLC chooses from Chains (receive, agent, spawn, parallel). The   *)
(* controller (1.3.0, unchanged) begins (runtime.ts begin: the run's own   *)
(* deadline starts here), then admits each visit with one enterNode       *)
(* activity (store.ts enterNode: one transaction; a copied row is answered *)
(* as it is; the first new row is inserted with rerun_resumed_at in the   *)
(* same transaction; a receive takes a carried message only if             *)
(* expires_at > clock_timestamp()). An activity's result can be lost and  *)
(* the activity run again, before or after the cut. Timers fire on the    *)
(* clock: the run deadline (store.ts:4884 deadline_at <= now: expired),   *)
(* a receive's wait deadline and a parallel step's time limit (store.ts:  *)
(* 4895 deadline_at <= now). TLC chooses each carried message's restarted *)
(* expiry, the run's time limit, the wait and the parallel limit, and the *)
(* clock may run before the first begin (a slow or lost dispatch,         *)
(* recovered). The run ends completed, failed (unhandled outcome, or       *)
(* expired), cancelled (a command, or the owner's deletion: 0096), or     *)
(* stopped; the end's transaction ends every pending visit; then the       *)
(* controller's end activities end each agent session the run kept open    *)
(* (runtime.ts endAgent) and cancel each active child (parent-end:<run>),  *)
(* one activity per category; carried messages of an ended run expire by  *)
(* TTL and are not open (listOpenInbox leaves out ended runs).            *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Reused,             \* 0..2 copied visits before the cut
    Chains,             \* names of new-visit chains (ChainOf), TLC picks one: "receive_receive", "agent_spawn", ...
    Msgs,               \* carried messages, e.g. {"m1", "m2"} or {}
    ExpChoices,         \* restarted expiries TLC chooses from (the admission is at clock 0; TTL is at least 1 s), e.g. {1, 2, 3}
    RunLimits,          \* the run's time limits TLC chooses from (0 = none)
    WaitLimits,         \* a receive's wait.totalSeconds, TLC chooses
    ParLimits,          \* a parallel step's time limit, TLC chooses
    MaxClk,             \* the clock runs to MaxClk, and further only while a timer is armed ahead of it
    MaxRetries,         \* lost enterNode results re-run (0..2)
    AllowCtrl,          \* cancel, stop, pause/resume commands
    AllowOwnerEnd,      \* the owner session is deleted (0096: the active run is cancelled)
    \* ---- faults ----
    StampSeparateTx,    \* rerun_resumed_at is stamped in a second transaction after the first new row's insert
    TakeNotIdempotent,  \* a re-run enterNode of a receive that took a message takes it again
    TakeAtExpiry,       \* a take accepts expires_at >= now (a message expiring this instant)
    CopyKeepsRunDeadline, \* the copy keeps #2's run deadline (already past) instead of starting it at begin
    DeadlineEarly,      \* timers fire one tick early (deadline_at < now + 1)
    SkipChildCancelWhen,  \* end kinds whose end activities leave an active child running
    SkipAgentEndWhen,     \* end kinds whose end activities leave an agent session open
    NoCleanupOnOwnerEnd,  \* a run the owner's deletion ended gets no end activities
    StopKeepsPending      \* the stop's end transaction leaves pending visits pending

ASSUME Reused \in 0..2 /\ MaxRetries \in 0..2 /\ MaxClk \in 1..8
ASSUME {AllowCtrl, AllowOwnerEnd, StampSeparateTx, TakeNotIdempotent, TakeAtExpiry, CopyKeepsRunDeadline, DeadlineEarly,
        NoCleanupOnOwnerEnd, StopKeepsPending} \subseteq BOOLEAN

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
    exp,            \* [Msgs -> ExpChoices]: carried messages' restarted expires_at
    runLimit, waitLimit, parLimit,
    clk,
    runStatus, endKind, endAt, failCode,
    begunAt, runDl,
    pc,             \* "begin" | "admit" | "record" | "work" | "next" | "paused" | "endacts" | "done"
    cur,            \* visit being admitted / worked (1..Len)
    row,            \* [1..Len -> "absent" | "pending" | "completed"]
    outcome,        \* [1..Len -> "none" | "ok" | "msg" | "timed_out" | "ended"]
    armedAt,        \* [1..Len -> clock]: a timer's deadline (NoTime = none)
    resumedAt, stampOwed,
    actRes,         \* "none" | "row" | "ended" | "paused": the enterNode result not yet recorded
    retries,
    taken, takenAt, \* [Msgs -> 0..2], [Msgs -> clock]
    tookBy,         \* [1..Len -> Msgs \cup {"none"}]: the message a receive took
    sess,           \* agent session: "absent" | "live" | "ended"
    child,          \* spawned child: "absent" | "active" | "completed" | "cancelled"
    agentEndDone, childCancelDone,  \* the end activities ran
    stopReq, cancelUsed, pauseUsed, ownerGone,
    timerEarly, expiredEarly   \* ghosts: a timer fired before its deadline; the run expired before its own deadline

Last == Reused + Len(chain)
Visits == 1..Last
KindAt(i) == IF i <= Reused THEN "copied" ELSE chain[i - Reused]
IsNew(i) == i > Reused

vars == <<chain, exp, runLimit, waitLimit, parLimit, clk, runStatus, endKind, endAt, failCode, begunAt, runDl, pc, cur, row,
          outcome, armedAt, resumedAt, stampOwed, actRes, retries, taken, takenAt, tookBy, sess, child, agentEndDone,
          childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly>>

Init ==
    /\ chain \in {ChainOf(name) : name \in Chains}
    /\ exp \in [Msgs -> ExpChoices]
    /\ runLimit \in RunLimits /\ waitLimit \in WaitLimits /\ parLimit \in ParLimits
    /\ clk = 0
    /\ runStatus = "admitted" /\ endKind = "none" /\ endAt = NoTime /\ failCode = "none"
    /\ begunAt = NoTime /\ runDl = NoTime
    /\ pc = "begin" /\ cur = 1
    /\ row = [i \in 1..(Reused + Len(chain)) |-> IF i <= Reused THEN "completed" ELSE "absent"]
    /\ outcome = [i \in 1..(Reused + Len(chain)) |-> IF i <= Reused THEN "ok" ELSE "none"]
    /\ armedAt = [i \in 1..(Reused + Len(chain)) |-> NoTime]
    /\ resumedAt = FALSE /\ stampOwed = FALSE /\ actRes = "none" /\ retries = 0
    /\ taken = [m \in Msgs |-> 0] /\ takenAt = [m \in Msgs |-> NoTime]
    /\ tookBy = [i \in 1..(Reused + Len(chain)) |-> "none"]
    /\ sess = "absent" /\ child = "absent" /\ agentEndDone = FALSE /\ childCancelDone = FALSE
    /\ stopReq = FALSE /\ cancelUsed = FALSE /\ pauseUsed = FALSE /\ ownerGone = FALSE
    /\ timerEarly = FALSE /\ expiredEarly = FALSE

-----------------------------------------------------------------------------
(* Time                                                                    *)

\* A deadline is due when deadline_at <= now (fault DeadlineEarly: one tick early).
Due(dl) == IF DeadlineEarly THEN dl <= clk + 1 ELSE dl <= clk
ArmedAhead == (runStatus \in Active /\ runDl # NoTime /\ runDl > clk) \/ (\E i \in Visits : row[i] = "pending" /\ armedAt[i] > clk /\ armedAt[i] # NoTime)
\* The clock runs to MaxClk, and beyond it only while a deadline is armed ahead (each one is finite).
Tick ==
    /\ clk < MaxClk \/ ArmedAhead
    /\ clk' = clk + 1
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, runStatus, endKind, endAt, failCode, begunAt, runDl, pc, cur, row,
                   outcome, armedAt, resumedAt, stampOwed, actRes, retries, taken, takenAt, tookBy, sess, child, agentEndDone,
                   childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly>>

\* A carried message a receive can take now: not taken, and expires_at > now (fault TakeAtExpiry: >=).
Takeable(m) == taken[m] = 0 /\ (IF TakeAtExpiry THEN exp[m] >= clk ELSE exp[m] > clk)

\* The run's end transaction (finishRun / cancelRun / expireRun / stop / the 0096 trigger): every pending visit ends with it.
EndRun(status, kind, code) ==
    /\ runStatus' = status /\ endKind' = kind /\ endAt' = clk /\ failCode' = code
    /\ row' = [i \in Visits |-> IF row[i] = "pending" THEN "completed" ELSE row[i]]
    /\ outcome' = [i \in Visits |-> IF row[i] = "pending" THEN "ended" ELSE outcome[i]]
    /\ armedAt' = [i \in Visits |-> IF row[i] = "pending" THEN NoTime ELSE armedAt[i]]

-----------------------------------------------------------------------------
(* Controller                                                              *)

Begin ==
    /\ pc = "begin"
    /\ IF runStatus = "admitted"
         THEN /\ runStatus' = "running" /\ begunAt' = clk
              /\ runDl' = IF CopyKeepsRunDeadline THEN 0 ELSE IF runLimit = 0 THEN NoTime ELSE clk + runLimit
              /\ pc' = "admit"
              /\ UNCHANGED <<endKind, endAt, failCode, row, outcome, armedAt>>
         ELSE /\ pc' = "endacts" /\ UNCHANGED <<runStatus, begunAt, runDl, endKind, endAt, failCode, row, outcome, armedAt>>
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, cur, resumedAt, stampOwed, actRes, retries, taken, takenAt,
                   tookBy, sess, child, agentEndDone, childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly>>

\* store.ts enterNode, one transaction: an ended run admits nothing; a run past its deadline ends expired (deadline_at <=
\* now); a paused one admits nothing yet; an existing row (copied, or inserted by an earlier attempt) is answered as it is;
\* else the row is inserted (a receive takes a carried message if one is takeable), and the first new row stamps
\* rerun_resumed_at in the same transaction (fault StampSeparateTx: a second transaction, StampTx, owes it).
AdmitExec ==
    /\ pc = "admit" /\ actRes = "none"
    /\ LET i == cur IN
       IF runStatus \in Terminal
         THEN /\ actRes' = "ended"
              /\ UNCHANGED <<runStatus, endKind, endAt, failCode, row, outcome, armedAt, resumedAt, stampOwed, taken, takenAt, tookBy, expiredEarly>>
       ELSE IF runDl # NoTime /\ Due(runDl)
         THEN /\ EndRun("failed", "failed", "expired")
              /\ expiredEarly' = (expiredEarly \/ clk < begunAt + runLimit \/ runLimit = 0)
              /\ actRes' = "ended"
              /\ UNCHANGED <<resumedAt, stampOwed, taken, takenAt, tookBy>>
       ELSE IF runStatus = "paused"
         THEN /\ actRes' = "paused"
              /\ UNCHANGED <<runStatus, endKind, endAt, failCode, row, outcome, armedAt, resumedAt, stampOwed, taken, takenAt, tookBy, expiredEarly>>
       ELSE IF row[i] # "absent"
         THEN \* answered as it is; fault TakeNotIdempotent: a receive that took a message takes it again
              /\ IF TakeNotIdempotent /\ IsNew(i) /\ KindAt(i) = "receive" /\ tookBy[i] # "none"
                   THEN /\ taken' = [taken EXCEPT ![tookBy[i]] = @ + 1]
                   ELSE UNCHANGED taken
              /\ actRes' = "row"
              /\ UNCHANGED <<runStatus, endKind, endAt, failCode, row, outcome, armedAt, resumedAt, stampOwed, takenAt, tookBy, expiredEarly>>
       ELSE LET take == KindAt(i) = "receive" /\ \E m \in Msgs : Takeable(m)
                m == IF take THEN CHOOSE x \in Msgs : Takeable(x) ELSE "none"
            IN /\ row' = [row EXCEPT ![i] = IF take THEN "completed" ELSE "pending"]
               /\ outcome' = [outcome EXCEPT ![i] = IF take THEN "msg" ELSE "none"]
               /\ armedAt' = [armedAt EXCEPT ![i] =
                    IF take THEN NoTime
                    ELSE CASE KindAt(i) = "receive" -> clk + waitLimit
                           [] KindAt(i) = "parallel" -> clk + parLimit
                           [] OTHER -> NoTime]
               /\ IF take THEN /\ taken' = [taken EXCEPT ![m] = @ + 1] /\ takenAt' = [takenAt EXCEPT ![m] = clk]
                               /\ tookBy' = [tookBy EXCEPT ![i] = m]
                          ELSE UNCHANGED <<taken, takenAt, tookBy>>
               /\ IF ~resumedAt /\ ~stampOwed
                    THEN IF StampSeparateTx THEN stampOwed' = TRUE /\ UNCHANGED resumedAt
                         ELSE resumedAt' = TRUE /\ UNCHANGED stampOwed
                    ELSE UNCHANGED <<resumedAt, stampOwed>>
               /\ actRes' = "row"
               /\ UNCHANGED <<runStatus, endKind, endAt, failCode, expiredEarly>>
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, begunAt, runDl, pc, cur, retries, sess, child, agentEndDone,
                   childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly>>

\* Fault StampSeparateTx: the stamp's own transaction (lost if the activity's result is lost first).
StampTx ==
    /\ stampOwed /\ actRes # "none"
    /\ resumedAt' = TRUE /\ stampOwed' = FALSE
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, runStatus, endKind, endAt, failCode, begunAt, runDl, pc, cur,
                   row, outcome, armedAt, actRes, retries, taken, takenAt, tookBy, sess, child, agentEndDone, childCancelDone,
                   stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly>>

\* The activity's result is lost and the activity runs again (before or after the cut).
AdmitRetry ==
    /\ pc = "admit" /\ actRes # "none" /\ retries < MaxRetries
    /\ actRes' = "none" /\ retries' = retries + 1
    /\ stampOwed' = FALSE
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, runStatus, endKind, endAt, failCode, begunAt, runDl, pc, cur,
                   row, outcome, armedAt, resumedAt, taken, takenAt, tookBy, sess, child, agentEndDone, childCancelDone,
                   stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly>>

AdmitRecord ==
    /\ pc = "admit" /\ actRes # "none" /\ ~stampOwed
    /\ actRes' = "none"
    /\ pc' = CASE actRes = "ended" -> "endacts"
               [] actRes = "paused" -> "paused"
               [] stopReq -> "stop"
               [] row[cur] = "completed" -> "next"
               [] OTHER -> "work"
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, runStatus, endKind, endAt, failCode, begunAt, runDl, cur,
                   row, outcome, armedAt, resumedAt, stampOwed, retries, taken, takenAt, tookBy, sess, child, agentEndDone,
                   childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly>>

WaitResume ==
    /\ pc = "paused" /\ runStatus # "paused"
    /\ pc' = "admit"
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, runStatus, endKind, endAt, failCode, begunAt, runDl, cur,
                   row, outcome, armedAt, resumedAt, stampOwed, actRes, retries, taken, takenAt, tookBy, sess, child, agentEndDone,
                   childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly>>

\* A graceful stop requested earlier: the controller ends the run stopped at its next admission.
StopAtPoll ==
    /\ pc = "stop"
    /\ IF runStatus \in Active /\ StopKeepsPending
         THEN /\ runStatus' = "stopped" /\ endKind' = "stopped" /\ endAt' = clk /\ UNCHANGED <<failCode, row, outcome, armedAt>>
       ELSE IF runStatus \in Active THEN EndRun("stopped", "stopped", "none")
       ELSE UNCHANGED <<runStatus, endKind, endAt, failCode, row, outcome, armedAt>>
    /\ pc' = "endacts"
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, begunAt, runDl, cur, resumedAt, stampOwed, actRes, retries,
                   taken, takenAt, tookBy, sess, child, agentEndDone, childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone,
                   timerEarly, expiredEarly>>

\* A stop requested while a visit is in flight: when its grace period ends, the run ends stopped and the visit with it.
StopGraceEnds ==
    /\ pc = "wait" /\ stopReq /\ runStatus = "running"
    /\ IF StopKeepsPending
         THEN /\ runStatus' = "stopped" /\ endKind' = "stopped" /\ endAt' = clk /\ UNCHANGED <<failCode, row, outcome, armedAt>>
         ELSE EndRun("stopped", "stopped", "none")
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, begunAt, runDl, pc, cur, resumedAt, stampOwed, actRes, retries,
                   taken, takenAt, tookBy, sess, child, agentEndDone, childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone,
                   timerEarly, expiredEarly>>

\* The visit's work (effects start once, when admitted pending): an agent's session opens (it stays open for the next
\* cycle until the run ends); a spawn's child starts; the parallel step's lanes run. Then the visit completes.
StartWork ==
    /\ pc = "work" /\ row[cur] = "pending"
    /\ sess' = IF KindAt(cur) = "agent" /\ sess = "absent" THEN "live" ELSE sess
    /\ child' = IF KindAt(cur) = "spawn" /\ child = "absent" THEN "active" ELSE child
    /\ pc' = "wait"
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, runStatus, endKind, endAt, failCode, begunAt, runDl, cur, row,
                   outcome, armedAt, resumedAt, stampOwed, actRes, retries, taken, takenAt, tookBy, agentEndDone,
                   childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly>>
WorkEndedEarly ==
    /\ pc = "work" /\ row[cur] # "pending"
    /\ pc' = IF runStatus \in Terminal THEN "endacts" ELSE "next"
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, runStatus, endKind, endAt, failCode, begunAt, runDl, cur, row,
                   outcome, armedAt, resumedAt, stampOwed, actRes, retries, taken, takenAt, tookBy, sess, child, agentEndDone,
                   childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly>>

\* A pending visit completes: the agent reports, the child ends and its notice arrives, the lanes finish, or a pending
\* receive takes a carried message that is still takeable.
Complete(i, o) ==
    /\ row' = [row EXCEPT ![i] = "completed"] /\ outcome' = [outcome EXCEPT ![i] = o] /\ armedAt' = [armedAt EXCEPT ![i] = NoTime]
VisitDone ==
    /\ pc = "wait" /\ row[cur] = "pending" /\ runStatus = "running"
    /\ \/ /\ KindAt(cur) = "agent" /\ Complete(cur, "ok") /\ UNCHANGED <<child, taken, takenAt, tookBy>>
       \/ /\ KindAt(cur) = "spawn" /\ child = "active" /\ child' = "completed" /\ Complete(cur, "ok")
          /\ UNCHANGED <<taken, takenAt, tookBy>>
       \/ /\ KindAt(cur) = "parallel" /\ Complete(cur, "ok") /\ UNCHANGED <<child, taken, takenAt, tookBy>>
       \/ /\ KindAt(cur) = "receive" /\ \E m \in Msgs : Takeable(m)
          /\ LET m == CHOOSE x \in Msgs : Takeable(x) IN
             /\ taken' = [taken EXCEPT ![m] = @ + 1] /\ takenAt' = [takenAt EXCEPT ![m] = clk] /\ tookBy' = [tookBy EXCEPT ![cur] = m]
             /\ Complete(cur, "msg")
          /\ UNCHANGED child
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, runStatus, endKind, endAt, failCode, begunAt, runDl, pc, cur,
                   resumedAt, stampOwed, actRes, retries, sess, agentEndDone, childCancelDone, stopReq, cancelUsed, pauseUsed,
                   ownerGone, timerEarly, expiredEarly>>

\* A visit timer: a receive's wait deadline or a parallel step's time limit (deadline_at <= now): the visit completes
\* timed_out (the parallel's lanes are cancelled with it).
VisitTimerFires(i) ==
    /\ row[i] = "pending" /\ runStatus = "running" /\ armedAt[i] # NoTime /\ Due(armedAt[i])
    /\ timerEarly' = (timerEarly \/ clk < armedAt[i])
    /\ Complete(i, "timed_out")
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, runStatus, endKind, endAt, failCode, begunAt, runDl, pc, cur,
                   resumedAt, stampOwed, actRes, retries, taken, takenAt, tookBy, sess, child, agentEndDone, childCancelDone,
                   stopReq, cancelUsed, pauseUsed, ownerGone, expiredEarly>>

\* The run deadline's own timer (runtime.ts expireRun): the run ends failed, expired.
RunDeadlineFires ==
    /\ runStatus = "running" /\ runDl # NoTime /\ Due(runDl)
    /\ EndRun("failed", "failed", "expired")
    /\ expiredEarly' = (expiredEarly \/ clk < begunAt + runLimit \/ runLimit = 0)
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, begunAt, runDl, pc, cur, resumedAt, stampOwed, actRes, retries,
                   taken, takenAt, tookBy, sess, child, agentEndDone, childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone,
                   timerEarly>>

\* The controller collects the visit and routes: ok or msg goes on; timed_out (no route for it) fails the run; past the
\* last visit the run completes.
Collect ==
    /\ pc \in {"wait", "next"} /\ row[cur] = "completed"
    /\ IF runStatus \in Terminal
         THEN /\ pc' = "endacts" /\ UNCHANGED <<cur, runStatus, endKind, endAt, failCode, row, outcome, armedAt>>
       ELSE IF outcome[cur] = "timed_out"
         THEN /\ EndRun("failed", "failed", "unhandled") /\ pc' = "endacts" /\ UNCHANGED cur
       ELSE IF cur = Last
         THEN /\ EndRun("completed", "completed", "none") /\ pc' = "endacts" /\ UNCHANGED cur
         ELSE /\ cur' = cur + 1 /\ pc' = "admit"
              /\ UNCHANGED <<runStatus, endKind, endAt, failCode, row, outcome, armedAt>>
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, begunAt, runDl, resumedAt, stampOwed, actRes, retries, taken,
                   takenAt, tookBy, sess, child, agentEndDone, childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone,
                   timerEarly, expiredEarly>>
\* A controller waiting on a visit sees the run ended (by a command or the owner) and goes to its end activities.
WaitSeesEnd ==
    /\ pc = "wait" /\ runStatus \in Terminal
    /\ pc' = "endacts"
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, runStatus, endKind, endAt, failCode, begunAt, runDl, cur, row,
                   outcome, armedAt, resumedAt, stampOwed, actRes, retries, taken, takenAt, tookBy, sess, child, agentEndDone,
                   childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly>>

-----------------------------------------------------------------------------
(* The end's activities, one per category                                  *)

\* runtime.ts endAgent for every session the run kept open (fault SkipAgentEndWhen: not for those end kinds).
EndAgents ==
    /\ pc = "endacts" /\ ~agentEndDone /\ runStatus \in Terminal
    /\ ~(NoCleanupOnOwnerEnd /\ ownerGone)
    /\ agentEndDone' = TRUE
    /\ sess' = IF sess = "live" /\ endKind \notin SkipAgentEndWhen THEN "ended" ELSE sess
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, runStatus, endKind, endAt, failCode, begunAt, runDl, pc, cur,
                   row, outcome, armedAt, resumedAt, stampOwed, actRes, retries, taken, takenAt, tookBy, child, childCancelDone,
                   stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly>>
\* runtime.ts: each active child is cancelled with its own command, operation id parent-end:<runId> (fault
\* SkipChildCancelWhen: not for those end kinds).
CancelChildren ==
    /\ pc = "endacts" /\ ~childCancelDone /\ runStatus \in Terminal
    /\ ~(NoCleanupOnOwnerEnd /\ ownerGone)
    /\ childCancelDone' = TRUE
    /\ child' = IF child = "active" /\ endKind \notin SkipChildCancelWhen THEN "cancelled" ELSE child
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, runStatus, endKind, endAt, failCode, begunAt, runDl, pc, cur,
                   row, outcome, armedAt, resumedAt, stampOwed, actRes, retries, taken, takenAt, tookBy, sess, agentEndDone,
                   stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly>>
EndActsDone ==
    /\ pc = "endacts"
    /\ (agentEndDone /\ childCancelDone) \/ (NoCleanupOnOwnerEnd /\ ownerGone)
    /\ pc' = "done"
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, runStatus, endKind, endAt, failCode, begunAt, runDl, cur, row,
                   outcome, armedAt, resumedAt, stampOwed, actRes, retries, taken, takenAt, tookBy, sess, child, agentEndDone,
                   childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly>>

-----------------------------------------------------------------------------
(* Commands and the owner                                                  *)

CmdUnchanged == UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, begunAt, runDl, pc, cur, resumedAt, stampOwed,
                            actRes, retries, taken, takenAt, tookBy, sess, child, agentEndDone, childCancelDone, timerEarly, expiredEarly>>
Cancel ==
    /\ AllowCtrl /\ ~cancelUsed /\ runStatus \in Active
    /\ EndRun("cancelled", "cancelled", "none") /\ cancelUsed' = TRUE
    /\ UNCHANGED <<stopReq, pauseUsed, ownerGone>> /\ CmdUnchanged
Stop ==
    /\ AllowCtrl /\ ~stopReq /\ runStatus = "running"
    /\ stopReq' = TRUE
    /\ UNCHANGED <<runStatus, endKind, endAt, failCode, row, outcome, armedAt, cancelUsed, pauseUsed, ownerGone>> /\ CmdUnchanged
Pause ==
    /\ AllowCtrl /\ ~pauseUsed /\ runStatus = "running"
    /\ runStatus' = "paused" /\ pauseUsed' = TRUE
    /\ UNCHANGED <<endKind, endAt, failCode, row, outcome, armedAt, stopReq, cancelUsed, ownerGone>> /\ CmdUnchanged
Resume ==
    /\ runStatus = "paused"
    /\ runStatus' = "running"
    /\ UNCHANGED <<endKind, endAt, failCode, row, outcome, armedAt, stopReq, cancelUsed, pauseUsed, ownerGone>> /\ CmdUnchanged
\* 0096 workflow_on_owner_session_ended: the owner's deletion cancels the active run in its own transaction.
OwnerDeleted ==
    /\ AllowOwnerEnd /\ ~ownerGone
    /\ ownerGone' = TRUE
    /\ IF runStatus \in Active THEN EndRun("cancelled", "owner_deleted", "none")
       ELSE UNCHANGED <<runStatus, endKind, endAt, failCode, row, outcome, armedAt>>
    /\ UNCHANGED <<stopReq, cancelUsed, pauseUsed>> /\ CmdUnchanged

\* The open child settles on its own, whatever the run does.
ChildEndsAlone ==
    /\ child = "active" /\ runStatus \in Terminal
    /\ child' = "completed"
    /\ UNCHANGED <<chain, exp, runLimit, waitLimit, parLimit, clk, runStatus, endKind, endAt, failCode, begunAt, runDl, pc, cur,
                   row, outcome, armedAt, resumedAt, stampOwed, actRes, retries, taken, takenAt, tookBy, sess, agentEndDone,
                   childCancelDone, stopReq, cancelUsed, pauseUsed, ownerGone, timerEarly, expiredEarly>>

Done == pc = "done" /\ UNCHANGED vars

Ctrl == Begin \/ AdmitExec \/ StampTx \/ AdmitRecord \/ WaitResume \/ StopAtPoll \/ StartWork \/ WorkEndedEarly \/ Collect
        \/ WaitSeesEnd \/ EndAgents \/ CancelChildren \/ EndActsDone
Timers == RunDeadlineFires \/ \E i \in Visits : VisitTimerFires(i)
Next == Ctrl \/ AdmitRetry \/ VisitDone \/ Timers \/ Tick \/ Cancel \/ Stop \/ StopGraceEnds \/ Pause \/ Resume \/ OwnerDeleted \/ Done

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Ctrl) /\ WF_vars(VisitDone) /\ WF_vars(Timers) /\ WF_vars(Tick) /\ WF_vars(Resume)

-----------------------------------------------------------------------------
(* Properties                                                              *)

TypeOK ==
    /\ runStatus \in Active \cup Terminal /\ clk \in 0..(MaxClk + 12)
    /\ \A m \in Msgs : taken[m] \in 0..2
    /\ sess \in {"absent", "live", "ended"} /\ child \in {"absent", "active", "completed", "cancelled"}

\* RR-9: a carried message is taken at most once, also when an enterNode after the cut runs again.
Inv_TakeOnce == \A m \in Msgs : taken[m] <= 1
\* RR-3: a receive never takes a carried message at or after its (restarted) expiry.
Inv_NoExpiredTake == \A m \in Msgs : taken[m] > 0 => takenAt[m] < exp[m]
\* RR-9: a new row exists only with rerun_resumed_at stamped (in the same transaction).
Inv_ResumedIffNew == (\E i \in Visits : IsNew(i) /\ row[i] # "absent") => resumedAt
\* RR-11: the run expires only at or after its own deadline, counted from its begin (never #2's deadline), also when
\* the deadline passes during the pass-over over copied visits.
Inv_ExpiresNotEarly == ~expiredEarly
\* RR-11: a receive's wait deadline and a parallel step's time limit fire only at or after their deadline.
Inv_TimersNotEarly == ~timerEarly
\* An ended run has no pending visit (the end's transaction ends them).
Inv_TerminalNoPending == runStatus \in Terminal => \A i \in Visits : row[i] # "pending"
\* RR-5: once an ended run's end activities ran, no agent session it opened is open, for every end kind.
Inv_EndedNoLiveAgent == (runStatus \in Terminal /\ agentEndDone) => sess # "live"
\* RR-5: once an ended run's end activities ran, no child it spawned is active, for every end kind.
Inv_EndedNoActiveChild == (runStatus \in Terminal /\ childCancelDone) => child # "active"
\* RR-5: an ended run takes no carried message after its end.
Inv_EndedNoTake == \A m \in Msgs : (taken[m] > 0 /\ runStatus \in Terminal) => takenAt[m] <= endAt
\* RR-5: every ended run's agent sessions and children are eventually closed (the end activities run for every end).
Live_EndedQuiesces == <>[](runStatus \in Terminal => (sess # "live" /\ child # "active"))

\* Witnesses (each expected violated).
\* RR-3: a carried message expired while the run waited to begin or passed over copied visits, and a receive found
\* the other carried message (or none) instead.
Wit_NoExpiredBeforeReceive == ~(\E m \in Msgs : taken[m] = 0 /\ exp[m] <= clk /\ \E i \in Visits : KindAt(i) = "receive" /\ row[i] = "completed" /\ runStatus \in Terminal)
\* RR-3: a message taken the instant before it expires.
Wit_NoTakeAtLastInstant == ~(\E m \in Msgs : taken[m] = 1 /\ takenAt[m] + 1 = exp[m])
\* RR-9: an enterNode after the cut ran again and the run completed.
Wit_NoRetryAfterCut == ~(retries > 0 /\ resumedAt /\ runStatus = "completed" /\ \E m \in Msgs : taken[m] = 1)
\* RR-11: the run deadline passed while the controller passed over copied visits.
Wit_NoExpireInPassOver == ~(failCode = "expired" /\ \A i \in Visits : IsNew(i) => row[i] = "absent")
\* RR-11: a wait deadline and a parallel limit fire exactly at their deadline.
Wit_NoTimerAtDeadline == ~(\E i \in Visits : outcome[i] = "timed_out" /\ KindAt(i) \in {"receive", "parallel"} /\ runStatus = "failed" /\ failCode = "unhandled")
\* RR-5: a run stopped, cancelled, or ended by the owner with an open agent session and an active child, cleaned up.
Wit_NoCleanupAfterStop == ~(endKind = "stopped" /\ agentEndDone /\ childCancelDone /\ sess = "ended" /\ child = "cancelled")
Wit_NoCleanupAfterOwnerEnd == ~(endKind = "owner_deleted" /\ agentEndDone /\ childCancelDone /\ sess = "ended" /\ child = "cancelled")

=============================================================================
