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
(* Code "9a8d0f66" (E1d, r3; commit 2a372b5a via the squash d7c3ca68):    *)
(*   - E1c-R1: the barrier is a set of causes (causes; 0 stands for a     *)
(*     failure: a failed cancel or teardown, a call that did not end; u   *)
(*     for owner u's late catalog check). A raise adds a cause, a lift    *)
(*     removes only its own; the barrier is up while the set is not       *)
(*     empty. 412f7b00 and earlier keep one slot: a raise replaces it,    *)
(*     a lift empties it only if it still holds the lifted cause.         *)
(*   - E1c-R2: a close waits for its call's whole turn (the native call   *)
(*     and the task listing after it), and a task the listing gives to an *)
(*     owner already released is cancelled at once (pend, LateCancel);    *)
(*     a failed cancel adds a cause (only while the share's lease holds). *)
(* AllowLate: an owner's tool catalog check outlives its deadline: the    *)
(* opening fails, a cause is raised, and it is lifted when the check ends *)
(* (late setup follows the same rule and is not modeled separately).      *)
(* ListingRace: the listing after a call is a step of its own (CallEnds,  *)
(* then Listed), so a close can come between them; FALSE keeps the        *)
(* atomic turn of r2f. With an r3 switch on (R3), a successful teardown   *)
(* cancels every task of the session, as tearDownWorkflowToolSession does.*)
(* A worker restart (startWorkflowTools, the other lift) is not modeled.  *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS N, Dep, AllowTeardownFail, AllowShutdown, AllowRevoke, AllowScriptEnd, Fault,
          Code, AllowUnsettled, AllowUnattributed, AllowBoundary, AllowListingFail,
          AllowLate, ListingRace

ASSUME N \in 1..3 /\ Dep \in BOOLEAN /\ Fault \in {"none", "no_dequeue_recheck", "no_barrier_recheck"}
ASSUME Code \in {"proposedE1b", "8dd3eae1", "412f7b00", "9a8d0f66"}
ASSUME (AllowUnsettled \/ AllowUnattributed \/ AllowBoundary) => Code \in {"8dd3eae1", "412f7b00", "9a8d0f66"}
ASSUME AllowListingFail => Code \in {"412f7b00", "9a8d0f66"}
ASSUME AllowLate \in BOOLEAN /\ ListingRace \in BOOLEAN
ASSUME (AllowLate \/ ListingRace) => Code \in {"412f7b00", "9a8d0f66"}
Impl == Code \in {"8dd3eae1", "412f7b00", "9a8d0f66"}
E1C == Code \in {"412f7b00", "9a8d0f66"}   \* ownership by task id first
E1D == Code = "9a8d0f66"                     \* barrier causes; whole-turn close; late task cancelled at once
R3 == E1D \/ AllowLate \/ ListingRace       \* r3 refinements on (FALSE: every r2 case unchanged)
Users == 1..N

VARIABLES
    pc,        \* per owner: "idle", "wait", "checking", "active", "closing", "done", "refused", "aborted"
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
    crossKill, \* history: a close cancelled a task of another owner that still holds the share
    \* r3 (9a8d0f66)
    causes,    \* the barrier: 0 = a failure cause, u = owner u's late catalog check (old codes: at most one)
    lateRun,   \* owners whose late catalog check still runs
    lst,       \* ListingRace: the owner whose turn is in its listing after the call (0: none)
    ltask,     \* the task that call started, not yet claimed: "none", "own" (readable start), "nostart"
    pend,      \* 9a8d0f66: tasks given by a listing to a released owner, their cancel still to come
    cfail,     \* owners whose task cancel failed (R3 only)
    cw         \* ListingRace: owners whose close found their call executing

attrVars == <<ubg, xbg, lastCaller, crossKill>>
r3Vars == <<causes, lateRun, lst, ltask, pend, cfail, cw>>
vars == <<pc, share, owners, tearing, gen, live, mine, q, running, submitted, called, bg,
          failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, ubg, xbg, lastCaller, crossKill,
          causes, lateRun, lst, ltask, pend, cfail, cw>>

Init ==
    /\ pc = [u \in Users |-> "idle"] /\ share = "none" /\ owners = 0 /\ tearing = FALSE
    /\ gen = 0 /\ live = FALSE /\ mine = [u \in Users |-> 0]
    /\ q = <<>> /\ running = 0 /\ submitted = [u \in Users |-> FALSE] /\ called = [u \in Users |-> FALSE] /\ bg = {}
    /\ failedTD = FALSE /\ tdFails = 0 /\ shutting = FALSE /\ revoked = {} /\ ended = {}
    /\ badCall = FALSE /\ broken = {} /\ setupAfterFail = FALSE
    /\ ubg = {} /\ xbg = {} /\ lastCaller = 0 /\ crossKill = FALSE
    /\ causes = {} /\ lateRun = {} /\ lst = 0 /\ ltask = "none" /\ pend = {} /\ cfail = {} /\ cw = {}

\* The barrier is up while any cause is there (old codes: while the slot is full).
Barrier == causes # {}
Blocked == Barrier \/ shutting
\* A failure cause raised: 9a8d0f66 adds it to the set; earlier codes replace the slot.
R0 == IF E1D THEN causes \cup {0} ELSE {0}
Set(f, u, v) == [f EXCEPT ![u] = v]
Range(s) == {s[i] : i \in 1..Len(s)}
Live(b) == pc[b] \in {"active", "closing"}
Gone(r) == pc[r] = "done"                       \* released (disposed)
Holds(r) == live /\ mine[r] = gen               \* the share's lease r joined still holds the session
\* A close waits for its turn: 9a8d0f66 for the whole turn that began; earlier codes for the
\* execution, and for the whole turn only when the close found the call executing.
Waits(u) == running = u \/ (lst = u /\ (E1D \/ u \in cw))
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
    /\ UNCHANGED <<tearing, gen, live, mine, q, running, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, attrVars, r3Vars>>

SetupShare ==
    /\ share = "setting" /\ ~tearing /\ (~Blocked \/ Fault = "no_barrier_recheck")
    /\ share' = "ready" /\ gen' = gen + 1 /\ live' = TRUE /\ setupAfterFail' = (setupAfterFail \/ failedTD)
    /\ UNCHANGED <<pc, owners, tearing, mine, q, running, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, attrVars, r3Vars>>

Wake(u) ==         \* after the wait the barrier is re-checked; AllowLate: then the catalog check
    /\ pc[u] = "wait" /\ (share = "ready" \/ (Blocked /\ Fault # "no_barrier_recheck"))
    /\ IF Blocked /\ Fault # "no_barrier_recheck"
         THEN pc' = Set(pc, u, "refused") /\ Leave /\ UNCHANGED mine
         ELSE /\ pc' = Set(pc, u, IF AllowLate THEN "checking" ELSE "active")
              /\ mine' = Set(mine, u, gen) /\ UNCHANGED <<owners, share, tearing>>
    /\ UNCHANGED <<gen, live, q, running, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, attrVars, r3Vars>>

CheckDone(u) ==    \* the catalog check ends in time; the barrier is checked again (E1-R3)
    /\ pc[u] = "checking"
    /\ IF Blocked
         THEN pc' = Set(pc, u, "refused") /\ Leave
         ELSE pc' = Set(pc, u, "active") /\ UNCHANGED <<owners, share, tearing>>
    /\ UNCHANGED <<gen, live, mine, q, running, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, attrVars, r3Vars>>

CheckLate(u) ==    \* the catalog check outlives its deadline: a cause (lateWorkflowWork), the opening fails
    /\ pc[u] = "checking" /\ AllowLate
    /\ pc' = Set(pc, u, "refused") /\ Leave
    /\ lateRun' = lateRun \cup {u}
    /\ causes' = IF E1D THEN causes \cup {u} ELSE {u}
    /\ UNCHANGED <<gen, live, mine, q, running, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, attrVars, lst, ltask, pend, cfail, cw>>

LateEnds ==        \* the late check ends: its own cause is lifted (old codes: only if the slot still holds it)
    /\ \E u \in lateRun :
         /\ lateRun' = lateRun \ {u}
         /\ causes' = IF E1D THEN causes \ {u} ELSE IF causes = {u} THEN {} ELSE causes
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, q, running, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, attrVars, lst, ltask, pend, cfail, cw>>

Abort(u) ==
    /\ pc[u] = "wait" /\ u \in ended
    /\ pc' = Set(pc, u, "aborted") /\ Leave
    /\ UNCHANGED <<gen, live, mine, q, running, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, attrVars, r3Vars>>

Submit(u) ==
    /\ pc[u] = "active" /\ ~submitted[u]
    /\ q' = Append(q, u) /\ submitted' = Set(submitted, u, TRUE)
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, running, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, attrVars, r3Vars>>

Dequeue ==         \* one turn at a time (its listing and late cancel included); the dequeue re-checks its owner
    /\ running = 0 /\ lst = 0 /\ pend = {} /\ q # <<>>
    /\ LET h == Head(q)
           ok == pc[h] = "active" /\ h \notin revoked /\ ~shutting /\ ~(Impl /\ Barrier)
       IN /\ q' = Tail(q)
          /\ IF ok \/ Fault = "no_dequeue_recheck"
               THEN /\ running' = h /\ badCall' = (badCall \/ ~ok)
                    /\ broken' = IF live /\ mine[h] = gen THEN broken ELSE broken \cup {h}
               ELSE UNCHANGED <<running, badCall, broken>>
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, setupAfterFail, attrVars, r3Vars>>

(* The call ends; it may leave background work. Without ListingRace the  *)
(* listing after it is part of this step; 9a8d0f66 gives a task of a      *)
(* released owner to its cancel at once (pend).                           *)
CallEnds ==
    /\ running # 0
    /\ called' = Set(called, running, TRUE) /\ running' = 0
    /\ lastCaller' = IF Impl /\ AllowBoundary THEN running ELSE lastCaller
    /\ IF ListingRace
         THEN /\ lst' = running
              /\ \E kind \in {"none", "own", "nostart"} : (kind = "nostart" => AllowUnattributed) /\ ltask' = kind
              /\ UNCHANGED <<bg, ubg, xbg, pend>>
         ELSE /\ \E kind \in {"none", "own", "unattributed", "boundary"} :
                   /\ kind = "unattributed" => IF E1C THEN (AllowUnattributed \/ AllowBoundary) /\ AllowListingFail ELSE AllowUnattributed
                   /\ kind = "boundary" => (~E1C /\ AllowBoundary /\ lastCaller \notin {0, running})
                   /\ bg' = IF kind = "own" /\ ~(E1D /\ Gone(running)) THEN bg \cup {running} ELSE bg
                   /\ pend' = IF kind = "own" /\ E1D /\ Gone(running) THEN pend \cup {running} ELSE pend
                   /\ ubg' = IF kind = "unattributed" THEN ubg \cup {running} ELSE ubg
                   /\ xbg' = IF kind = "boundary" THEN xbg \cup {<<running, lastCaller>>} ELSE xbg
              /\ UNCHANGED <<lst, ltask>>
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, q, submitted, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, crossKill, causes, lateRun, cfail, cw>>

(* ListingRace: the listing after the call. Listed: the new id is the     *)
(* caller's (9a8d0f66: if the caller is released, its cancel comes at     *)
(* once). Listing failed: a task with a readable start time is left to    *)
(* the window check at the caller's release (if it is still to come),     *)
(* any other is left to the last owner's teardown.                        *)
Listed ==
    /\ lst # 0
    /\ \E fail \in BOOLEAN :
         /\ fail => AllowListingFail
         /\ LET r == lst
                claimed == ltask # "none" /\ ~fail
                byWindow == ltask = "own" /\ fail /\ ~Gone(r)
                unclaimed == ltask # "none" /\ fail /\ ~byWindow
            IN /\ bg' = IF (claimed /\ ~(E1D /\ Gone(r))) \/ byWindow THEN bg \cup {r} ELSE bg
               /\ pend' = IF claimed /\ E1D /\ Gone(r) THEN pend \cup {r} ELSE pend
               /\ ubg' = IF unclaimed THEN ubg \cup {r} ELSE ubg
    /\ lst' = 0 /\ ltask' = "none"
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, q, running, submitted, called, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, xbg, lastCaller, crossKill, causes, lateRun, cfail, cw>>

(* 9a8d0f66 (E1c-R2): the turn cancels the task it gave to a released     *)
(* owner; a failed cancel adds a cause while the share's lease holds.      *)
LateCancel ==
    /\ \E r \in pend :
         /\ pend' = pend \ {r}
         /\ \/ UNCHANGED <<bg, cfail, failedTD, tdFails, causes>>
            \/ /\ AllowTeardownFail /\ tdFails = 0
               /\ bg' = bg \cup {r} /\ cfail' = cfail \cup {r}
               /\ failedTD' = TRUE /\ tdFails' = 1
               /\ causes' = IF Holds(r) THEN R0 ELSE causes
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, q, running, submitted, called, shutting, revoked, ended, badCall, broken, setupAfterFail, ubg, xbg, lastCaller, crossKill, lateRun, lst, ltask, cw>>

(* An owner closes (its script ends, or its work is done). With Dep,     *)
(* owner 1 closes only after owner 2's call, and each after its own call. *)
MayClose(u) == ~Dep \/ (called[u] /\ (u = 1 => called[2]))
Close(u) ==
    /\ pc[u] = "active" /\ MayClose(u)
    /\ pc' = Set(pc, u, "closing")
    /\ running' = IF running = u /\ ~Impl THEN 0 ELSE running      \* aborts only its own running call (8dd3eae1: it ends later)
    /\ cw' = IF ListingRace /\ running = u THEN cw \cup {u} ELSE cw
    /\ UNCHANGED <<share, owners, tearing, gen, live, mine, q, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, attrVars, causes, lateRun, lst, ltask, pend, cfail>>

(* 8dd3eae1: a call still waiting does not hold the release (its turn    *)
(* runs nothing); a running call is waited for, or (AllowUnsettled) not   *)
(* after the deadline: the barrier is set and the release goes on.        *)
(* 9a8d0f66 waits for the whole turn (Waits). A task in the listing with  *)
(* a readable start time is in the call's window: the release takes it.   *)
Release(u) ==      \* after its calls settle: cancel its background work, leave the share
    /\ pc[u] = "closing"
    /\ \E unsettled \in BOOLEAN :
         /\ IF unsettled THEN Impl /\ AllowUnsettled /\ Waits(u)
                         ELSE ~Waits(u) /\ (Impl \/ u \notin Range(q))
         /\ \/ /\ bg' = bg \ {u} /\ xbg' = {e \in xbg : e[1] # u /\ e[2] # u}
               /\ crossKill' = (crossKill \/ \E e \in xbg : e[2] = u /\ e[1] # u /\ pc[e[1]] \in {"active", "closing"})
               /\ ltask' = IF lst = u /\ ltask = "own" THEN "none" ELSE ltask
               /\ failedTD' = (failedTD \/ unsettled) /\ UNCHANGED <<tdFails, cfail>>
               /\ causes' = IF unsettled THEN R0 ELSE causes
            \/ /\ u \in bg /\ AllowTeardownFail /\ tdFails = 0 /\ failedTD' = TRUE /\ tdFails' = 1
               /\ causes' = R0 /\ cfail' = IF R3 THEN cfail \cup {u} ELSE cfail
               /\ UNCHANGED <<bg, xbg, crossKill, ltask>>
    /\ pc' = Set(pc, u, "done") /\ Leave
    /\ UNCHANGED <<gen, live, mine, q, running, submitted, called, shutting, revoked, ended, badCall, broken, setupAfterFail, ubg, lastCaller, lateRun, lst, pend, cw>>

Teardown ==        \* the full cancel takes every task (R3: attributed ones too); a failure adds a cause
    /\ tearing
    /\ \/ /\ live' = FALSE /\ ubg' = {} /\ UNCHANGED <<failedTD, tdFails, causes>>
          /\ bg' = IF R3 THEN {} ELSE bg
          /\ xbg' = IF R3 THEN {} ELSE xbg
          /\ pend' = IF R3 THEN {} ELSE pend
          /\ ltask' = IF R3 THEN "none" ELSE ltask
       \/ /\ AllowTeardownFail /\ tdFails = 0 /\ failedTD' = TRUE /\ tdFails' = 1 /\ causes' = R0
          /\ UNCHANGED <<live, ubg, bg, xbg, pend, ltask>>
    /\ tearing' = FALSE
    /\ UNCHANGED <<pc, share, owners, gen, mine, q, running, submitted, called, shutting, revoked, ended, badCall, broken, setupAfterFail, lastCaller, crossKill, lateRun, lst, cfail, cw>>

BgEndsX ==         \* 8dd3eae1: a task outside its owner's attribution ends on its own
    /\ \/ \E b \in ubg : ubg' = ubg \ {b} /\ UNCHANGED xbg
       \/ \E e \in xbg : xbg' = xbg \ {e} /\ UNCHANGED ubg
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, q, running, submitted, called, bg, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, lastCaller, crossKill, r3Vars>>

BgEnds ==
    /\ \E b \in bg : bg' = bg \ {b}
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, q, running, submitted, called, failedTD, tdFails, shutting, revoked, ended, badCall, broken, setupAfterFail, attrVars, r3Vars>>

ScriptEnds(u) ==
    /\ AllowScriptEnd /\ u \notin ended /\ pc[u] \in {"idle", "wait"}
    /\ ended' = ended \cup {u}
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, q, running, submitted, called, bg, failedTD, tdFails, shutting, revoked, badCall, broken, setupAfterFail, attrVars, r3Vars>>

Shutdown ==
    /\ AllowShutdown /\ ~shutting /\ shutting' = TRUE
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, q, running, submitted, called, bg, failedTD, tdFails, revoked, ended, badCall, broken, setupAfterFail, attrVars, r3Vars>>

Revoke(u) ==
    /\ AllowRevoke /\ revoked = {} /\ revoked' = {u}
    /\ UNCHANGED <<pc, share, owners, tearing, gen, live, mine, q, running, submitted, called, bg, failedTD, tdFails, shutting, ended, badCall, broken, setupAfterFail, attrVars, r3Vars>>

Done ==
    /\ \A u \in Users : pc[u] \in {"done", "refused", "aborted"} \/ (pc[u] = "idle" /\ u \in ended)
    /\ ~tearing /\ running = 0 /\ q = <<>>
    /\ UNCHANGED vars

OwnerStep(u) == Open(u) \/ Wake(u) \/ CheckDone(u) \/ CheckLate(u) \/ Abort(u) \/ Submit(u) \/ Close(u) \/ Release(u)
Next == (\E u \in Users : OwnerStep(u) \/ ScriptEnds(u) \/ Revoke(u))
        \/ SetupShare \/ Dequeue \/ CallEnds \/ Listed \/ LateCancel \/ LateEnds \/ Teardown \/ BgEnds \/ BgEndsX \/ Shutdown \/ Done

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ (\A u \in Users : WF_vars(OwnerStep(u)))
            /\ WF_vars(SetupShare) /\ WF_vars(Dequeue) /\ WF_vars(CallEnds) /\ WF_vars(Teardown)
            /\ WF_vars(Listed) /\ WF_vars(LateCancel) /\ WF_vars(LateEnds)

----------------------------------------------------------------------------
TypeOK ==
    /\ pc \in [Users -> {"idle", "wait", "checking", "active", "closing", "done", "refused", "aborted"}]
    /\ share \in {"none", "setting", "ready"} /\ owners \in 0..N /\ tearing \in BOOLEAN
    /\ gen \in 0..N /\ live \in BOOLEAN /\ mine \in [Users -> 0..N]
    /\ Range(q) \subseteq Users /\ running \in 0..N /\ bg \subseteq Users
    /\ failedTD \in BOOLEAN /\ tdFails \in 0..1 /\ revoked \subseteq Users /\ ended \subseteq Users
    /\ ubg \subseteq Users /\ xbg \subseteq Users \X Users /\ lastCaller \in 0..N /\ crossKill \in BOOLEAN
    /\ causes \subseteq 0..N /\ lateRun \subseteq Users /\ lst \in 0..N /\ ltask \in {"none", "own", "nostart"}
    /\ pend \subseteq Users /\ cfail \subseteq Users /\ cw \subseteq Users

(* VR-1: no call runs for a closed, stopped or revoked owner.             *)
Inv_NoCallForClosedOwner == ~badCall
(* A call runs only on the session its owner joined.                       *)
Inv_NoCallOnForeignSession == broken = {}
(* A running call's owner still holds its share.                          *)
Inv_RunningOwnerActive == running # 0 => pc[running] = "active"
(* VR-2: no setup after a failed teardown or cancel.                       *)
Inv_NoSetupAfterFailedTeardown == ~setupAfterFail
(* VR-3: background work outlives its owner only behind the barrier       *)
(* (r3: the barrier is the cause set; it equals failedTD without AllowLate).*)
Inv_NoOrphanBackground == \A b \in bg : pc[b] \in {"active", "closing"} \/ Barrier
(* Liveness.                                                               *)
Prop_WaitersServed == \A u \in Users : (pc[u] = "wait") ~> (pc[u] \in {"active", "closing", "done", "refused", "aborted"})
Prop_BothComplete == <>(\A u \in Users : pc[u] = "done" /\ called[u])
(* r2e (8dd3eae1). A running call's owner holds its share, or its call   *)
(* did not settle after its abort and the barrier is set.                 *)
Inv_RunningOwnerHolds == running # 0 => (pc[running] \in {"active", "closing"} \/ Barrier)
(* VR-3 with attribution: no task of an owner that released its share    *)
(* runs while others hold it (or the barrier is set).                     *)
Inv_NoOrphanBackgroundAll ==
    /\ Inv_NoOrphanBackground
    /\ \A b \in ubg : Live(b) \/ Barrier \/ owners = 0
    /\ \A e \in xbg : Live(e[1]) \/ Barrier \/ owners = 0
(* An owner's close cancels only its own tasks.                           *)
Inv_NoForeignCancel == ~crossKill
(* Witness: a call still runs after its owner released its share.         *)
Wit_CallAfterRelease == ~(running # 0 /\ pc[running] = "done")

(* r3 (9a8d0f66). E1c-R1: the barrier is up while any cause still holds: *)
(* a failure (sticky: no worker restart here) or a late check running.    *)
Inv_BarrierWhileCause == (failedTD \/ lateRun # {}) => Barrier
(* Every cause that holds is in the set (none is replaced or lost).        *)
Inv_CausesKept == (failedTD => 0 \in causes) /\ lateRun \subseteq causes
(* The share is going away: the last owner's teardown takes every task.    *)
Doomed == owners = 0 \/ tearing
(* VR-3 for every task, the listing and the late cancel included: a task  *)
(* of a released owner runs only behind the barrier or until the teardown.*)
Inv_NoOrphanTask ==
    /\ \A b \in bg \cup pend \cup ubg : Live(b) \/ Barrier \/ Doomed
    /\ \A e \in xbg : Live(e[1]) \/ Barrier \/ Doomed
    /\ IF lst # 0 /\ ltask # "none" THEN Live(lst) \/ Barrier \/ Doomed ELSE TRUE
(* E1c-R2: a task attributed to a released owner was cancelled (or its     *)
(* cancel failed), not left to the last owner's teardown.                  *)
Inv_ReleasedTaskCancelled == \A b \in bg : Live(b) \/ b \in cfail \/ Doomed
(* Witness: a task given to a released owner runs before its cancel.       *)
Wit_TaskBeforeCancel == pend = {}
(* A raised barrier is cleared, or the share is gone.                      *)
Prop_BarrierResolved == Barrier ~> (~Barrier \/ (owners = 0 /\ ~tearing))
(* A raised barrier is cleared (only late-work causes are lifted here).    *)
Prop_BarrierCleared == Barrier ~> ~Barrier
=============================================================================
