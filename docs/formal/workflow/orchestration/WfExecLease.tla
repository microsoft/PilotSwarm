------------------------------ MODULE WfExecLease ------------------------------
(***************************************************************************)
(* r2 (RT-2 after its verification, E1 0c3b4ceb). The native tool session *)
(* of a workflow is exclusive: one script state holds it from its setup   *)
(* (first tool call) until its executor closed and the teardown finished. *)
(* Other script states of the workflow wait in a FIFO line of promises   *)
(* (session-manager.ts openWorkflowToolExecutor): each takes its place    *)
(* (previous = the line's tail) before anything is awaited; its own link  *)
(* resolves when it releases AND the one before it resolved, so a waiter  *)
(* that aborts releases its link and the next still waits on the holder. *)
(*   - Open: refused at once after a failed teardown or during shutdown.  *)
(*   - After the wait: refused after a failed teardown or during          *)
(*     shutdown; setup checks authority (revoked: refused).               *)
(*   - After setup: shutdown or the script ended: torn down, not handed   *)
(*     out.                                                                *)
(*   - Holder: tool calls (authority checked before each) may start       *)
(*     background work; the close tears down (cancel background work,     *)
(*     disconnect, release folders) and then frees its link, even when    *)
(*     the teardown fails; a failed teardown blocks every later opening.  *)
(* Code "0c3b4ceb" is the only mode here; efe44835 and 1c117a47/1f7bdc77  *)
(* (the share) stay in WfExecutor.                                         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS N, Dep, AllowTeardownFail, AllowShutdown, AllowRevoke, AllowScriptEnd, Fault

ASSUME N \in 1..3 /\ Dep \in BOOLEAN /\ Fault \in {"none", "link_skips_aborted", "no_recheck_after_wait"}
Users == 1..N
Holding == {"setup", "ready", "hold", "closing"}

VARIABLES
    pc,        \* per state: "idle", "wait", "setup", "ready", "hold", "closing", "done", "refused", "aborted"
    prev,      \* the state before it in line (0: none)
    tail,      \* the line's last state (0: none)
    rel,       \* the state released its link
    gen, live, mine,    \* the native session's generation, its existence, each state's generation
    failedTD,  \* a teardown failed: the workflow requires recovery
    shutting,  \* the worker is shutting down
    revoked,   \* states whose authority was revoked
    ended,     \* states whose script ended (their activity aborts the wait)
    bg,        \* the owner of background work still running (0: none)
    called,    \* states that made a tool call
    \* history
    broken, setupAfterFail, tdFails

vars == <<pc, prev, tail, rel, gen, live, mine, failedTD, shutting, revoked, ended, bg, called, broken, setupAfterFail, tdFails>>

Init ==
    /\ pc = [u \in Users |-> "idle"] /\ prev = [u \in Users |-> 0] /\ tail = 0 /\ rel = [u \in Users |-> FALSE]
    /\ gen = 0 /\ live = FALSE /\ mine = [u \in Users |-> 0]
    /\ failedTD = FALSE /\ shutting = FALSE /\ revoked = {} /\ ended = {} /\ bg = 0 /\ called = {}
    /\ broken = {} /\ setupAfterFail = FALSE /\ tdFails = 0

\* A state's link has resolved: it released, and so did everyone before it.
RECURSIVE Free(_)
Free(u) == rel[u] /\ (IF prev[u] = 0 THEN TRUE ELSE Free(prev[u]))
\* Fault link_skips_aborted: an aborted waiter's link resolves at once (the bug the code avoids).
LinkDone(u) == IF Fault = "link_skips_aborted" /\ pc[u] = "aborted" THEN TRUE ELSE Free(u)
\* r2f (MF-2): IF, not \/: TLC evaluates each disjunct of an action on its own, so LinkDone(0) was applied.
Ahead(u) == IF prev[u] = 0 THEN TRUE ELSE LinkDone(prev[u])
Blocked == failedTD \/ shutting

Set(f, u, v) == [f EXCEPT ![u] = v]

Open(u) ==
    /\ pc[u] = "idle" /\ u \notin ended
    /\ IF Blocked
         THEN pc' = Set(pc, u, "refused") /\ UNCHANGED <<prev, tail>>
         ELSE pc' = Set(pc, u, "wait") /\ prev' = Set(prev, u, tail) /\ tail' = u
    /\ UNCHANGED <<rel, gen, live, mine, failedTD, shutting, revoked, ended, bg, called, broken, setupAfterFail, tdFails>>

Abort(u) ==
    /\ pc[u] = "wait" /\ u \in ended
    /\ pc' = Set(pc, u, "aborted") /\ rel' = Set(rel, u, TRUE)
    /\ UNCHANGED <<prev, tail, gen, live, mine, failedTD, shutting, revoked, ended, bg, called, broken, setupAfterFail, tdFails>>

Wake(u) ==
    /\ pc[u] = "wait" /\ Ahead(u)
    /\ IF Blocked /\ Fault # "no_recheck_after_wait"
         THEN pc' = Set(pc, u, "refused") /\ rel' = Set(rel, u, TRUE)
         ELSE pc' = Set(pc, u, "setup") /\ UNCHANGED rel
    /\ UNCHANGED <<prev, tail, gen, live, mine, failedTD, shutting, revoked, ended, bg, called, broken, setupAfterFail, tdFails>>

Setup(u) ==        \* authorizes, attaches folders, creates the managed session and its tools
    /\ pc[u] = "setup"
    /\ IF u \in revoked
         THEN pc' = Set(pc, u, "refused") /\ rel' = Set(rel, u, TRUE)
              /\ UNCHANGED <<gen, live, mine, setupAfterFail>>
         ELSE /\ pc' = Set(pc, u, "ready") /\ gen' = gen + 1 /\ live' = TRUE /\ mine' = Set(mine, u, gen + 1)
              /\ setupAfterFail' = (setupAfterFail \/ failedTD) /\ UNCHANGED rel
    /\ UNCHANGED <<prev, tail, failedTD, shutting, revoked, ended, bg, called, broken, tdFails>>

HandOut(u) ==      \* shutdown or the script ended meanwhile: torn down, not handed out
    /\ pc[u] = "ready"
    /\ pc' = Set(pc, u, IF shutting \/ u \in ended THEN "closing" ELSE "hold")
    /\ UNCHANGED <<prev, tail, rel, gen, live, mine, failedTD, shutting, revoked, ended, bg, called, broken, setupAfterFail, tdFails>>

Call(u) ==         \* one tool call (authority checked first); it may start background work
    /\ pc[u] = "hold" /\ u \notin revoked
    /\ broken' = IF live /\ mine[u] = gen THEN broken ELSE broken \cup {u}
    /\ \E b \in BOOLEAN : bg' = IF b THEN u ELSE bg
    /\ called' = called \cup {u}
    /\ UNCHANGED <<pc, prev, tail, rel, gen, live, mine, failedTD, shutting, revoked, ended, setupAfterFail, tdFails>>

(* Dep: state 1, after its first call, waits until state 2 made a call   *)
(* (a sibling dependency); each closes after its own call.                *)
MayClose(u) == ~Dep \/ (u \in called /\ (u = 1 => 2 \in called))
Close(u) ==        \* the script ended (or its executor is closed)
    /\ pc[u] = "hold" /\ MayClose(u)
    /\ pc' = Set(pc, u, "closing")
    /\ UNCHANGED <<prev, tail, rel, gen, live, mine, failedTD, shutting, revoked, ended, bg, called, broken, setupAfterFail, tdFails>>

Teardown(u) ==     \* cancel background work, disconnect, release folders; then free the link (finally)
    /\ pc[u] = "closing"
    /\ \/ /\ live' = FALSE /\ bg' = (IF bg = u THEN 0 ELSE bg) /\ UNCHANGED <<failedTD, tdFails>>
       \/ /\ AllowTeardownFail /\ tdFails = 0
          /\ failedTD' = TRUE /\ tdFails' = 1 /\ UNCHANGED <<live, bg>>
    /\ pc' = Set(pc, u, "done") /\ rel' = Set(rel, u, TRUE)
    /\ UNCHANGED <<prev, tail, gen, mine, shutting, revoked, ended, called, broken, setupAfterFail>>

BgEnds ==          \* background work ends on its own
    /\ bg # 0 /\ bg' = 0
    /\ UNCHANGED <<pc, prev, tail, rel, gen, live, mine, failedTD, shutting, revoked, ended, called, broken, setupAfterFail, tdFails>>

ScriptEnds(u) ==
    /\ AllowScriptEnd /\ u \notin ended /\ pc[u] \in {"idle", "wait", "setup", "ready"}
    /\ ended' = ended \cup {u}
    /\ UNCHANGED <<pc, prev, tail, rel, gen, live, mine, failedTD, shutting, revoked, bg, called, broken, setupAfterFail, tdFails>>

Shutdown ==
    /\ AllowShutdown /\ ~shutting /\ shutting' = TRUE
    /\ UNCHANGED <<pc, prev, tail, rel, gen, live, mine, failedTD, revoked, ended, bg, called, broken, setupAfterFail, tdFails>>

Revoke(u) ==
    /\ AllowRevoke /\ u \notin revoked /\ revoked = {}
    /\ revoked' = {u}
    /\ UNCHANGED <<pc, prev, tail, rel, gen, live, mine, failedTD, shutting, ended, bg, called, broken, setupAfterFail, tdFails>>

Done ==
    /\ \A u \in Users : pc[u] \in {"done", "refused", "aborted"} \/ (pc[u] = "idle" /\ u \in ended)
    /\ UNCHANGED vars

StateStep(u) == Open(u) \/ Abort(u) \/ Wake(u) \/ Setup(u) \/ HandOut(u) \/ Call(u) \/ Close(u) \/ Teardown(u)
Next == (\E u \in Users : StateStep(u) \/ ScriptEnds(u) \/ Revoke(u)) \/ BgEnds \/ Shutdown \/ Done

(* Fairness: every state's steps; a script that ended aborts its wait.    *)
(* A holder closes in the end (its script ends); a call is not forced.    *)
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ \A u \in Users : (WF_vars(Open(u)) /\ WF_vars(Abort(u)) /\ WF_vars(Wake(u)) /\ WF_vars(Setup(u))
                                      /\ WF_vars(HandOut(u)) /\ WF_vars(Close(u)) /\ WF_vars(Teardown(u)))

----------------------------------------------------------------------------
TypeOK ==
    /\ pc \in [Users -> {"idle", "wait", "setup", "ready", "hold", "closing", "done", "refused", "aborted"}]
    /\ prev \in [Users -> 0..N] /\ tail \in 0..N /\ rel \in [Users -> BOOLEAN]
    /\ gen \in 0..N /\ live \in BOOLEAN /\ mine \in [Users -> 0..N]
    /\ failedTD \in BOOLEAN /\ shutting \in BOOLEAN /\ revoked \subseteq Users /\ ended \subseteq Users
    /\ bg \in 0..N /\ called \subseteq Users /\ broken \subseteq Users /\ setupAfterFail \in BOOLEAN /\ tdFails \in 0..1

(* At most one state holds the native session.                            *)
Inv_OneHolder == Cardinality({u \in Users : pc[u] \in Holding}) <= 1
(* VR-1: a tool call runs only on its own state's live session.           *)
Inv_NoCallOnForeignSession == broken = {}
(* VR-2: no setup after a failed teardown.                                 *)
Inv_NoSetupAfterFailedTeardown == ~setupAfterFail
(* VR-3: background work never runs while another state holds the session.*)
Inv_NoForeignBackground == bg # 0 => \A v \in Users : v # bg => pc[v] \notin Holding
(* Liveness: every waiter is served (holds) or refused or aborted.        *)
(* E1-R1: with a sibling dependency both scripts complete their work.    *)
Prop_BothComplete == <>(\A u \in Users : pc[u] = "done" /\ u \in called)
Prop_WaitersServed == \A u \in Users : (pc[u] = "wait") ~> (pc[u] \in {"hold", "closing", "done", "refused", "aborted"})
(* Witness, EXPECTED to be violated: a waiter after an aborted one is served. *)
Wit_ServedAfterAbort == ~(\E u, v \in Users : prev[v] = u /\ pc[u] = "aborted" /\ pc[v] = "hold")
=============================================================================
