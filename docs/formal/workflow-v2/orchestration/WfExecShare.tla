------------------------------ MODULE WfExecShare ------------------------------
(***************************************************************************)
(* r2d (RT-2, E1b as described by the developer, after the deadlock of    *)
(* the 0c3b4ceb lease, E1-R1). The workflow's native tool session is      *)
(* shared again by its open script states (owners), with one tool call    *)
(* at a time:                                                              *)
(*   - an owner joins the share before anything is awaited; the share is  *)
(*     set up after the previous teardown, and a failed teardown (or a    *)
(*     failed background cancel) is a barrier, re-checked after the wait; *)
(*   - calls queue; at dequeue a call re-checks that its owner is not     *)
(*     closed or stopped and is still authorized;                          *)
(*   - an owner's close aborts only its own running call; its share is    *)
(*     released after its queued and in-flight calls settle;               *)
(*   - its background tasks (attributed by its call windows) are          *)
(*     cancelled at its release; a failed cancel sets the barrier;        *)
(*   - the last owner's release tears the session down.                   *)
(* Dep: script 1, after its first call, waits until script 2 made one     *)
(* call (a sibling dependency), as in exec.e1-dep of WfExecLease.          *)
(* Code "proposedE1b": the design as described. Code "8dd3eae1": E1b as  *)
(* committed (r2e): the turn's checks include the barrier; a close while  *)
(* the call waits releases at once (its turn runs nothing); a close while *)
(* it runs aborts it and waits until it settles, or (AllowUnsettled) gives *)
(* up after the deadline, sets the barrier and releases. Background work  *)
(* is attributed by the start time of a task and the time windows of the *)
(* owner's calls: a task without a readable start time is not attributed  *)
(* (AllowUnattributed), and a task started in the millisecond one window  *)
(* ends and the next begins is in both (AllowBoundary).                   *)
(* Code "412f7b00" (E1c, r2f): the running task ids are listed before and *)
(* after each call, and new ids are that call's owner's; by start time,   *)
(* in half-open call windows, only a task no listing claimed. A task is   *)
(* misattributed or left unattributed only when the listing failed       *)
(* (AllowListingFail): it is then left to the last owner's teardown.     *)
(* The barrier is checked again just before execution (as the dequeue    *)
(* check here); the per-share lease of the worker generation is not      *)
(* modeled (no late setup, catalog check or teardown).                    *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS N, Dep, AllowTeardownFail, AllowShutdown, AllowRevoke, AllowScriptEnd, Fault,
          Code, AllowUnsettled, AllowUnattributed, AllowBoundary, AllowListingFail

ASSUME N \in 1..3 /\ Dep \in BOOLEAN /\ Fault \in {"none", "no_dequeue_recheck", "no_barrier_recheck"}
ASSUME Code \in {"proposedE1b", "8dd3eae1", "412f7b00"}
ASSUME (AllowUnsettled \/ AllowUnattributed \/ AllowBoundary) => Code \in {"8dd3eae1", "412f7b00"}
ASSUME AllowListingFail => Code = "412f7b00"
Impl == Code \in {"8dd3eae1", "412f7b00"}
E1C == Code = "412f7b00"   \* ownership by task id first
Users == 1..N

VARIABLES
    pc,        \* per owner: "idle", "wait", "active", "closing", "done", "refused", "aborted"
    share,     \* "none", "setting", "ready"
    owners,    \* the share's owners
    tearing,   \* the last share's teardown is in progress
    gen, live, mine,
    q,         \* queued calls (owner ids)
    running,   \* the owner whose call runs (0: none)
    submitted, called,
    bg,        \* owners whose background work still runs (attributed by their call windows)
    failedTD, tdFails, shutting, revoked, ended,
    \* history
    badCall, broken, setupAfterFail,
    \* 8dd3eae1: background work by attribution
    ubg,       \* owners whose task has no readable start time (cancelled only by the full teardown)
    xbg,       \* <<owner, other>>: a task of owner started in the millisecond shared with other's window
    lastCaller,\* the owner of the previous call (0: none)
    crossKill  \* history: a close cancelled a task of another owner that still holds the share

attrVars == <<ubg, xbg, lastCaller, crossKill>>
vars == <<pc, share, owners, tearing, gen, live, mine, q, running, submitted, called, bg,
          failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, ubg, xbg, lastCaller, crossKill>>

Init ==
    /\ pc = [u \in Users |-> "idle"] /\ share = "none" /\ owners = 0 /\ tearing = FALSE
    /\ gen = 0 /\ live = FALSE /\ mine = [u \in Users |-> 0]
    /\ q = <<>> /\ running = 0 /\ submitted = [u \in Users |-> FALSE] /\ called = [u \in Users |-> FALSE] /\ bg = {}
    /\ failedTD = FALSE /\ tdFails = 0 /\ shutting = FALSE /\ revoked = {} /\ ended = {}
    /\ badCall = FALSE /\ broken = {} /\ setupAfterFail = FALSE
    /\ ubg = {} /\ xbg = {} /\ lastCaller = 0 /\ crossKill = FALSE

Blocked == failedTD \/ shutting
Set(f, u, v) == [f EXCEPT ![u] = v]
Range(s) == {s[i] : i \in 1..Len(s)}
\* An owner leaves the share; the last one starts the teardown of a set-up session.
Leave ==
    /\ owners' = owners - 1
    /\ IF owners = 1 THEN share' = "none" /\ tearing' = (tearing \/ share = "ready") ELSE UNCHANGED <<share, tearing>>

Open(u) ==
    /\ pc[u] = "idle" /\ u \notin ended
    /\ IF Blocked
         THEN pc' = Set(pc, u, "refused") /\ UNCHANGED <<share, owners>>
         ELSE /\ pc' = Set(pc, u, "wait") /\ owners' = owners + 1
              /\ share' = IF share = "none" THEN "setting" ELSE share
    /\ UNCHANGED <<tearing, gen, live, mine, q, running, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, attrVars>>

SetupShare ==
    /\ share = "setting" /\ ~tearing /\ (~Blocked \/ Fault = "no_barrier_recheck")
    /\ share' = "ready" /\ gen' = gen + 1 /\ live' = TRUE /\ setupAfterFail' = (setupAfterFail \/ failedTD)
    /\ UNCHANGED <<pc, owners, tearing, mine, q, running, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, attrVars>>

Wake(u) ==         \* after the wait the barrier is re-checked
    /\ pc[u] = "wait" /\ (share = "ready" \/ (Blocked /\ Fault # "no_barrier_recheck"))
    /\ IF Blocked /\ Fault # "no_barrier_recheck"
         THEN pc' = Set(pc, u, "refused") /\ Leave /\ UNCHANGED mine
         ELSE pc' = Set(pc, u, "active") /\ mine' = Set(mine, u, gen) /\ UNCHANGED <<owners, share, tearing>>
    /\ UNCHANGED <<gen, live, q, running, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, attrVars>>

Abort(u) ==
    /\ pc[u] = "wait" /\ u \in ended
    /\ pc' = Set(pc, u, "aborted") /\ Leave
    /\ UNCHANGED <<gen, live, mine, q, running, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, attrVars>>

Submit(u) ==
    /\ pc[u] = "active" /\ ~submitted[u]
    /\ q' = Append(q, u) /\ submitted' = Set(submitted, u, TRUE)
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, running, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, attrVars>>

Dequeue ==         \* one call at a time; the dequeue re-checks its owner
    /\ running = 0 /\ q # <<>>
    /\ LET h == Head(q)
           ok == pc[h] = "active" /\ h \notin revoked /\ ~shutting /\ ~(Impl /\ failedTD)
       IN /\ q' = Tail(q)
          /\ IF ok \/ Fault = "no_dequeue_recheck"
               THEN /\ running' = h /\ badCall' = (badCall \/ ~ok)
                    /\ broken' = IF live /\ mine[h] = gen THEN broken ELSE broken \cup {h}
               ELSE UNCHANGED <<running, badCall, broken>>
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, setupAfterFail, attrVars>>

CallEnds ==        \* the call ends; it may leave background work (attributed to its owner)
    /\ running # 0
    /\ called' = Set(called, running, TRUE) /\ running' = 0
    /\ lastCaller' = IF Impl /\ AllowBoundary THEN running ELSE lastCaller
    /\ \E kind \in {"none", "own", "unattributed", "boundary"} :
         /\ kind = "unattributed" => IF E1C THEN (AllowUnattributed \/ AllowBoundary) /\ AllowListingFail ELSE AllowUnattributed
         /\ kind = "boundary" => (~E1C /\ AllowBoundary /\ lastCaller \notin {0, running})
         /\ bg' = IF kind = "own" THEN bg \cup {running} ELSE bg
         /\ ubg' = IF kind = "unattributed" THEN ubg \cup {running} ELSE ubg
         /\ xbg' = IF kind = "boundary" THEN xbg \cup {<<running, lastCaller>>} ELSE xbg
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, q, submitted, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, crossKill>>

(* An owner closes (its script ends, or its work is done). With Dep,     *)
(* owner 1 closes only after owner 2's call, and each after its own call. *)
MayClose(u) == ~Dep \/ (called[u] /\ (u = 1 => called[2]))
Close(u) ==
    /\ pc[u] = "active" /\ MayClose(u)
    /\ pc' = Set(pc, u, "closing")
    /\ running' = IF running = u /\ ~Impl THEN 0 ELSE running      \* aborts only its own running call (8dd3eae1: it ends later)
    /\ UNCHANGED <<share, owners, tearing, gen, live, mine, q, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, attrVars>>

(* 8dd3eae1: a call still waiting does not hold the release (its turn    *)
(* runs nothing); a running call is waited for, or (AllowUnsettled) not   *)
(* after the deadline: the barrier is set and the release goes on.        *)
Release(u) ==      \* after its calls settle: cancel its background work, leave the share
    /\ pc[u] = "closing"
    /\ \E unsettled \in BOOLEAN :
         /\ IF unsettled THEN Impl /\ AllowUnsettled /\ running = u
                         ELSE running # u /\ (Impl \/ u \notin Range(q))
         /\ \/ /\ bg' = bg \ {u} /\ xbg' = {e \in xbg : e[1] # u /\ e[2] # u}
               /\ crossKill' = (crossKill \/ \E e \in xbg : e[2] = u /\ e[1] # u /\ pc[e[1]] \in {"active", "closing"})
               /\ failedTD' = (failedTD \/ unsettled) /\ UNCHANGED tdFails
            \/ /\ u \in bg /\ AllowTeardownFail /\ tdFails = 0 /\ failedTD' = TRUE /\ tdFails' = 1
               /\ UNCHANGED <<bg, xbg, crossKill>>
    /\ pc' = Set(pc, u, "done") /\ Leave
    /\ UNCHANGED <<gen, live, mine, q, running, submitted, called, shutting, revoked, ended, badCall, broken, setupAfterFail, ubg, lastCaller>>

Teardown ==
    /\ tearing
    /\ \/ /\ live' = FALSE /\ ubg' = {} /\ UNCHANGED <<failedTD, tdFails>>   \* the full cancel takes every task
       \/ /\ AllowTeardownFail /\ tdFails = 0 /\ failedTD' = TRUE /\ tdFails' = 1 /\ UNCHANGED <<live, ubg>>
    /\ tearing' = FALSE
    /\ UNCHANGED <<pc, share, owners, gen, mine, q, running, submitted, called, bg, shutting, revoked, ended, badCall, broken, setupAfterFail, xbg, lastCaller, crossKill>>

BgEndsX ==         \* 8dd3eae1: a task outside its owner's attribution ends on its own
    /\ \/ \E b \in ubg : ubg' = ubg \ {b} /\ UNCHANGED xbg
       \/ \E e \in xbg : xbg' = xbg \ {e} /\ UNCHANGED ubg
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, q, running, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, lastCaller, crossKill>>

BgEnds ==
    /\ \E b \in bg : bg' = bg \ {b}
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, q, running, submitted, called, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, attrVars>>

ScriptEnds(u) ==
    /\ AllowScriptEnd /\ u \notin ended /\ pc[u] \in {"idle", "wait"}
    /\ ended' = ended \cup {u}
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, q, running, submitted, called, bg, failedTD, tdFails, shutting, revoked, badCall, broken, setupAfterFail, attrVars>>

Shutdown ==
    /\ AllowShutdown /\ ~shutting /\ shutting' = TRUE
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, q, running, submitted, called, bg, failedTD, tdFails, revoked, ended, badCall, broken, setupAfterFail, attrVars>>

Revoke(u) ==
    /\ AllowRevoke /\ revoked = {} /\ revoked' = {u}
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, q, running, submitted, called, bg, failedTD, tdFails, shutting, ended, badCall, broken, setupAfterFail, attrVars>>

Done ==
    /\ \A u \in Users : pc[u] \in {"done", "refused", "aborted"} \/ (pc[u] = "idle" /\ u \in ended)
    /\ ~tearing /\ running = 0 /\ q = <<>>
    /\ UNCHANGED vars

OwnerStep(u) == Open(u) \/ Wake(u) \/ Abort(u) \/ Submit(u) \/ Close(u) \/ Release(u)
Next == (\E u \in Users : OwnerStep(u) \/ ScriptEnds(u) \/ Revoke(u))
        \/ SetupShare \/ Dequeue \/ CallEnds \/ Teardown \/ BgEnds \/ BgEndsX \/ Shutdown \/ Done

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ (\A u \in Users : WF_vars(OwnerStep(u)))
            /\ WF_vars(SetupShare) /\ WF_vars(Dequeue) /\ WF_vars(CallEnds) /\ WF_vars(Teardown)

----------------------------------------------------------------------------
TypeOK ==
    /\ pc \in [Users -> {"idle", "wait", "active", "closing", "done", "refused", "aborted"}]
    /\ share \in {"none", "setting", "ready"} /\ owners \in 0..N /\ tearing \in BOOLEAN
    /\ gen \in 0..N /\ live \in BOOLEAN /\ mine \in [Users -> 0..N]
    /\ Range(q) \subseteq Users /\ running \in 0..N /\ bg \subseteq Users
    /\ failedTD \in BOOLEAN /\ tdFails \in 0..1 /\ revoked \subseteq Users /\ ended \subseteq Users
    /\ ubg \subseteq Users /\ xbg \subseteq Users \X Users /\ lastCaller \in 0..N /\ crossKill \in BOOLEAN

(* VR-1: no call runs for a closed, stopped or revoked owner.             *)
Inv_NoCallForClosedOwner == ~badCall
(* A call runs only on the session its owner joined.                       *)
Inv_NoCallOnForeignSession == broken = {}
(* A running call's owner still holds its share.                          *)
Inv_RunningOwnerActive == running # 0 => pc[running] = "active"
(* VR-2: no setup after a failed teardown or cancel.                       *)
Inv_NoSetupAfterFailedTeardown == ~setupAfterFail
(* VR-3: background work outlives its owner only behind the barrier.       *)
Inv_NoOrphanBackground == \A b \in bg : pc[b] \in {"active", "closing"} \/ failedTD
(* Liveness.                                                               *)
Prop_WaitersServed == \A u \in Users : (pc[u] = "wait") ~> (pc[u] \in {"active", "closing", "done", "refused", "aborted"})
Prop_BothComplete == <>(\A u \in Users : pc[u] = "done" /\ called[u])
(* r2e (8dd3eae1). A running call's owner holds its share, or its call   *)
(* did not settle after its abort and the barrier is set.                 *)
Inv_RunningOwnerHolds == running # 0 => (pc[running] \in {"active", "closing"} \/ failedTD)
(* VR-3 with attribution: no task of an owner that released its share    *)
(* runs while others hold it (or the barrier is set).                     *)
Live(b) == pc[b] \in {"active", "closing"}
Inv_NoOrphanBackgroundAll ==
    /\ Inv_NoOrphanBackground
    /\ \A b \in ubg : Live(b) \/ failedTD \/ owners = 0
    /\ \A e \in xbg : Live(e[1]) \/ failedTD \/ owners = 0
(* An owner's close cancels only its own tasks.                           *)
Inv_NoForeignCancel == ~crossKill
(* Witness: a call still runs after its owner released its share.         *)
Wit_CallAfterRelease == ~(running # 0 /\ pc[running] = "done")
=============================================================================
