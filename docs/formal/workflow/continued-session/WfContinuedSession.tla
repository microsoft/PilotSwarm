---------------------------- MODULE WfContinuedSession ----------------------------
(***************************************************************************)
(* The session lifecycle "continue" of a Workflow agent state: its visits  *)
(* in one run go to one agent session (packages/sdk/src/workflow,       *)
(* runtime.ts and store.ts; the default for an agent state in the outer    *)
(* graph). A visit's agent session is chosen at its admission and frozen   *)
(* (continuedSessionOf): the previous visit's session while it goes on, else *)
(* a replacement session. The spawn sends the visit's prompt to it. A      *)
(* turn takes the prompts in order, skips a visit that is already decided, *)
(* and its result binds only to its own visit (agentInvocationOfCompletion *)
(* by node execution id). When a visit ends, its turn gets a cycle Stop    *)
(* and the session stays open (AgentSessionContinues). When the run ends (stop, *)
(* cancel, done) every agent session is ended under its end lock; one not  *)
(* visible yet is marked owed and a detached retry (wfc) ends it later.    *)
(* A person can end or delete an agent session.                            *)
(*                                                                         *)
(* Sessions: index 1 is the state's first agent session; index k > 1 is   *)
(* the replacement made for visit k. The model follows one agent state.    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    V,              \* visits of the agent state in the run
    Person,         \* "none", "end" (complete or cancel), "delete", "any": what a person may do, once
    AllowStop,      \* the run may be stopped (graceful: started visits finish)
    AllowCancel,    \* the run may be cancelled (pending visits decided at once)
    AllowStopFail,  \* a visit's cycle Stop may fail past its retries (a database error)
    FailAgentSession,       \* 0, or the agent session whose end fails past every retry after the run ended
    RecoverFair,    \* a person runs recover after a failed end (it is only on request)
    SpawnRecheck,   \* fix G1: the spawn checks the frozen agent session is not ended or deleted before sending
    RecheckSeesEnding, \* the check also sees an agent session whose end was asked while a turn runs (FALSE: the code at
                    \* a9f60db7, which reads the orchestration status: still Running until that turn ends)
    EndMark,        \* fix G1b: a person's end of an agent session is recorded before its command, and admission and
                    \* the spawn's check treat an agent session whose end was asked as ended
    StopBeforeSpawn,\* fix G2: the next visit's spawn first ends earlier visits whose Stop was not sent
    PerAgentSessionEnd,     \* fix G3: one agent session's failed end does not keep the others from being ended
    StopAtRunEnd,   \* fix G5: a visit ended by the run's end also stops its running turn
    Fault,          \* "none", "bind-newest", "replace-without-check", "no-owed-mark", "end-without-lock", "run-decided"
    \* DRR-1 and DRR-2 (the delta review of the G1 fixes): the spawn and a person's end in separate steps.
    SplitSpawn,     \* the spawn is three steps: the G1 check, the child create (cms_create_session), the send
    CheckAll,       \* the check also covers a first visit, a replacement session and a retried attempt (FALSE: the code
                    \* at 7024ef6f checks only a later visit that reuses its predecessor's agent session)
    Fence,          \* "none"; "create": the create refuses a deleted, ended or marked agent session without reviving it;
                    \* "both": also the send, in one step with its check; "after" (the code at 5451a22e): the create
                    \* is fenced and the send is followed by the check again, which decides the visit
    Backstop,       \* the client refuses a send to a terminal orchestration (G1 backstop at 7024ef6f)
    AllowSpawnCrash,\* a spawn attempt may fail after its send and before it is recorded, and is retried (once per visit)
    MarkSplit,      \* a person's end is two steps: the mark (session.end_requested), then the command
    MarkFail,       \* "none", "throw" (the enqueue fails and the call throws), "crash" (the process stops after the mark)
    Withdraw,       \* a thrown enqueue withdraws its mark
    Outbox,         \* a durable owner retries the end command after a throw or a crash until it is queued
    CarryDelete,    \* the check after the send ends an orchestration that the send started on a deleted session: "none";
                    \* "visible" (the code at 7bd79a46: only when that start already reads as existing); "owed" (also
                    \* when it does not yet: the attempt retries until it does); "queued" (DRR-1c: the delete is
                    \* enqueued whatever the status says, and delivered with the queued start, before any turn);
                    \* "queued-skew": "queued" where the event may become visible before the start, be fetched
                    \* alone and be dropped (hosts' clocks apart); "queued-race" (the code at 9b2ca643): the delete
                    \* is queued behind the start and the prompt, so a worker may fetch those two first and run a
                    \* model turn before the delete is read
    TurnGuard,      \* DR2-001 fix: a turn's admission reads the row's deletion first; a deleted session runs no model
                    \* turn and ends
    MarkCreating,   \* a parent's end recorded without a live check (session-proxy), also on an agent session whose
                    \* start is queued but does not read as existing yet
    CarryNotFound,  \* DR2-003 fix: carryMarkedEnd also queues the end to an agent session that reads NotFound
    Carry,          \* the Workflow carries the end: an activity that acts on a mark (a replacement at admission, a visit
                    \* failed at once) first queues the mark's end itself (idempotent, retried with the activity)
    \* tf1: a turn that fails terminally (its retries spent; the session goes idle with an error and stays usable).
    AllowTurnFail,  \* a running turn may fail terminally
    FailReport,     \* "none" (the code before the fix: nothing tells the store), "fix" (the session reports the failure and
                    \* one store step decides the turn's own visit execution_failed while it is pending), "binds-newest"
                    \* (fault: the report decides the session's newest pending visit)
    TimeoutFair,    \* a visit's time limit is forced to arrive (FALSE: liveness must not rest on it)
    AllowRecover    \* a later turn of the session succeeds (a reminder of the failed visit) while its report is owed:
                    \* the report is dropped (no report after a success); the agent may complete the visit in that turn

ASSUME V \in 1..3 /\ Person \in {"none", "end", "delete", "any"}
ASSUME {AllowStop, AllowCancel, AllowStopFail, RecoverFair, SpawnRecheck, RecheckSeesEnding, EndMark, StopBeforeSpawn, PerAgentSessionEnd, StopAtRunEnd} \subseteq BOOLEAN
ASSUME FailAgentSession \in 0..V
ASSUME Fault \in {"none", "bind-newest", "replace-without-check", "no-owed-mark", "end-without-lock", "run-decided"}
ASSUME {SplitSpawn, CheckAll, Backstop, AllowSpawnCrash, MarkSplit, Withdraw, Outbox, Carry} \subseteq BOOLEAN
ASSUME CarryDelete \in {"none", "visible", "owed", "queued", "queued-skew", "queued-race"}
ASSUME {TurnGuard, MarkCreating, CarryNotFound} \subseteq BOOLEAN
ASSUME AllowTurnFail \in BOOLEAN /\ FailReport \in {"none", "fix", "binds-newest"} /\ TimeoutFair \in BOOLEAN
ASSUME AllowRecover \in BOOLEAN
ASSUME Fence \in {"none", "create", "both", "after"} /\ MarkFail \in {"none", "throw", "crash"}

Vis == 1..V
Ses == 1..V
(* An agent session that takes prompts; one that was asked to end and is   *)
(* finishing its last turn does not count.                                 *)
Alive == {"creating", "live"}

VARIABLES
    marked,     \* agent sessions whose end a person asked (EndMark)
    run,        \* "active", "stopping", "ended"
    nv,         \* visits admitted
    vis,        \* visit -> [node, how, s, sent, endReq, stopOk, gaveUp]
    ses,        \* agent session -> [st, turn, q, endState, ends]
    readers,    \* agent sessions an unlocked looker has read as live (fault "end-without-lock")
    afterDone,  \* the run's end looked at every agent session (afterEnd)
    acted,      \* a person acted
    pend,       \* a person's split end (MarkSplit): [ph |-> "none", "marked", "thrown", "crashed", "done", "withdrawn", s]
    reports,    \* tf1: visits whose turn failed terminally, their failure report owed to the store
    failedV,    \* tf1 (history): visits whose turn failed terminally
    gh
vars == <<marked, run, nv, vis, ses, readers, afterDone, acted, pend, reports, failedV, gh>>

NoVisit == [node |-> "none", how |-> "none", s |-> 0, sent |-> FALSE, endReq |-> FALSE, stopOk |-> FALSE, gaveUp |-> FALSE,
            ph |-> "idle", cr |-> FALSE]
NoSes == [st |-> "none", turn |-> 0, q |-> {}, endState |-> "open", ends |-> 0]

Init == /\ marked = {} /\ run = "active" /\ nv = 0 /\ vis = [v \in Vis |-> NoVisit] /\ ses = [s \in Ses |-> NoSes]
        /\ readers = {} /\ afterDone = FALSE /\ acted = FALSE /\ pend = [ph |-> "none", s |-> 0] /\ gh = {}
        /\ reports = {} /\ failedV = {}

Decide(v, how) == [vis EXCEPT ![v].node = "decided", ![v].how = how]
Used(s) == \E v \in Vis : vis[v].node # "none" /\ vis[v].s = s
Newest(s) == CHOOSE v \in Vis : vis[v].s = s /\ vis[v].node # "none" /\ \A w \in Vis : (vis[w].s = s /\ vis[w].node # "none") => w <= v
(* "row": the catalog row exists, no orchestration yet (SplitSpawn); "tomb0": *)
(* such a row deleted; "orphan": an orchestration the send started on it.  *)
Ended(st) == st \in {"ended", "deleted", "zombie", "revived", "tomb0", "orphan", "orphanq"}
(* An end command is on its way: a person's split end between its mark    *)
(* and its command, or one a durable owner retries.                       *)
EndComing(s) == pend.s = s /\ (pend.ph = "marked" \/ (Outbox /\ pend.ph \in {"thrown", "crashed"}))
NewDims == SplitSpawn \/ MarkSplit
(* An end command reaching an agent session: a live one ends (between turns) *)
(* or finishes its running turn first.                                     *)
EndCmd(r) == IF r.st = "live" THEN [r EXCEPT !.st = IF r.turn = 0 THEN "ended" ELSE "ending"]
             \* an end queued behind a queued start: the session's first drain reads it (its queued prompt's
             \* visit is decided by the Workflow that carried it, or waits out its time limit)
             ELSE IF r.st = "creating" THEN [r EXCEPT !.st = "ended", !.q = {}]
             ELSE r
(* Carry: the Workflow queues a marked live agent session's end before it  *)
(* acts on the mark (counted as a Workflow end command).                   *)
Carried(s) == IF Carry /\ s \in marked THEN ses[s].st = "live" \/ (CarryNotFound /\ ses[s].st = "creating") ELSE FALSE
CarryEnd(s) == IF Carried(s) THEN [ses EXCEPT ![s] = [EndCmd(ses[s]) EXCEPT !.ends = @ + 1]] ELSE ses

(* Admission (enter): the previous visit decided and its end attempted     *)
(* (collect ends a child before routing on). continuedSessionOf reads the  *)
(* previous agent session without a lock; the choice is frozen.            *)
Admit ==
    /\ run = "active" /\ nv < V
    /\ IF nv = 0 THEN TRUE ELSE vis[nv].node = "decided" /\ vis[nv].endReq
    /\ LET prev == IF nv = 0 THEN 0 ELSE vis[nv].s
           gone == prev # 0 /\ (Ended(ses[prev].st) \/ (EndMark /\ prev \in marked))
           s == IF prev = 0 THEN 1 ELSE IF gone \/ Fault = "replace-without-check" THEN nv + 1 ELSE prev
       IN /\ vis' = [vis EXCEPT ![nv + 1].node = "pending", ![nv + 1].s = s]
          /\ gh' = gh \cup (IF prev # 0 /\ s # prev /\ ~gone THEN {"replacedLive"} ELSE {})
                      \cup (IF prev # 0 /\ s # prev THEN {"replaced"} ELSE {})
                      \cup (IF NewDims /\ prev # 0 /\ s # prev /\ ses[prev].st \in Alive /\ ~EndComing(prev) /\ ~Carried(prev)
                            THEN {"abandoned"} ELSE {})
                      \cup (IF prev # 0 /\ s # prev /\ Carried(prev) THEN {"carried"} ELSE {})
          /\ ses' = IF prev # 0 /\ s # prev THEN CarryEnd(prev) ELSE ses
    /\ nv' = nv + 1
    /\ UNCHANGED <<pend, marked, run, readers, afterDone, acted, reports, failedV>>

(* spawnAgent: send the visit's prompt to its frozen agent session. A      *)
(* completed or cancelled session refuses it: the spawn retries, then the  *)
(* visit fails unavailable. A deleted one is brought back as a row that    *)
(* says running while duroxide drops the prompt (zombie).                  *)
Spawn(v) ==
    /\ ~SplitSpawn
    /\ vis[v].node = "pending" /\ ~vis[v].sent /\ run # "ended"
    /\ StopBeforeSpawn => \A u \in Vis : (u < v /\ vis[u].s = vis[v].s /\ vis[u].node = "decided") => ~vis[u].gaveUp
    /\ LET s == vis[v].s
           st == ses[s].st
       IN IF SpawnRecheck /\ (Ended(st) \/ (RecheckSeesEnding /\ st = "ending") \/ (EndMark /\ s \in marked))
          THEN /\ vis' = Decide(v, "unavailable") /\ ses' = ses /\ gh' = gh \cup {"recheckFail"}
          ELSE IF st = "ended"
          THEN /\ vis' = Decide(v, "unavailable") /\ gh' = gh \cup {"loudFail"} /\ UNCHANGED ses
          ELSE IF st \in {"deleted", "zombie", "ending"}
          THEN /\ vis' = [vis EXCEPT ![v].sent = TRUE]
               /\ ses' = [ses EXCEPT ![s].st = IF st = "ending" THEN "ending" ELSE "zombie"]
               /\ gh' = gh \cup {"dropped"}
          ELSE /\ vis' = [vis EXCEPT ![v].sent = TRUE]
               /\ ses' = [ses EXCEPT ![s].st = IF st = "none" THEN "creating" ELSE st, ![s].q = @ \cup {v}]
               /\ UNCHANGED gh
    /\ UNCHANGED <<pend, marked, run, nv, readers, afterDone, acted, reports, failedV>>

(* DRR-1: the spawn in three steps (SplitSpawn). The G1 check reads the     *)
(* agent session; the create (createSession, the catalog upsert) revives a *)
(* deleted row unless fenced; the send starts or feeds the orchestration.  *)
(* Other steps (a person's delete or end) run between them.               *)
GoneNow(s) == Ended(ses[s].st) \/ (EndMark /\ s \in marked)
CheckApplies(v) == SpawnRecheck /\ (IF CheckAll THEN TRUE ELSE IF v > 1 THEN vis[v].s = vis[v - 1].s ELSE FALSE)
FailNow(v, s) ==
    /\ vis' = Decide(v, "unavailable")
    /\ gh' = gh \cup {"recheckFail"} \cup (IF ses[s].st \in Alive /\ ~EndComing(s) /\ ~Carried(s) THEN {"failOnLive"} ELSE {})
                \cup (IF Carried(s) THEN {"carried"} ELSE {})
    /\ ses' = CarryEnd(s)
SpawnCheck(v) ==
    /\ SplitSpawn /\ vis[v].node = "pending" /\ ~vis[v].sent /\ vis[v].ph = "idle" /\ run # "ended"
    /\ StopBeforeSpawn => \A u \in Vis : (u < v /\ vis[u].s = vis[v].s /\ vis[u].node = "decided") => ~vis[u].gaveUp
    /\ LET s == vis[v].s
       IN IF CheckApplies(v) /\ (GoneNow(s) \/ (RecheckSeesEnding /\ ses[s].st = "ending"))
          THEN FailNow(v, s)
          ELSE /\ vis' = [vis EXCEPT ![v].ph = "checked"] /\ UNCHANGED <<ses, gh>>
    /\ UNCHANGED <<pend, marked, run, nv, readers, afterDone, acted, reports, failedV>>
SpawnCreate(v) ==
    /\ vis[v].node = "pending" /\ vis[v].ph = "checked" /\ run # "ended"
    /\ LET s == vis[v].s
       IN IF Fence # "none" /\ GoneNow(s)
          THEN FailNow(v, s)
          ELSE /\ vis' = [vis EXCEPT ![v].ph = "created"]
               /\ IF ses[s].st \in {"deleted", "tomb0"}
                  THEN /\ ses' = [ses EXCEPT ![s].st = IF ses[s].st = "tomb0" THEN "row" ELSE "revived"]
                       /\ gh' = gh \cup {"revived"}
                  ELSE /\ ses' = [ses EXCEPT ![s].st = IF @ = "none" THEN "row" ELSE @]
                       /\ UNCHANGED gh
    /\ UNCHANGED <<pend, marked, run, nv, readers, afterDone, acted, reports, failedV>>
SpawnSend(v) ==
    /\ vis[v].node = "pending" /\ vis[v].ph = "created" /\ run # "ended"
    /\ LET s == vis[v].s
           st == ses[s].st
       IN IF Fence = "both" /\ GoneNow(s)
          THEN FailNow(v, s)
          ELSE IF Fence = "after" /\ GoneNow(s)
          \* the send happened, then the check decides the visit; on a deleted row with no orchestration the send
          \* started one (an orphan) unless the check ends it
          \* (the start this send queued may not read as existing yet: the check then sees NotFound)
          THEN (\E seen \in (IF CarryDelete \in {"visible", "queued-skew"} THEN BOOLEAN ELSE {CarryDelete \in {"owed", "queued", "queued-race"}}) :
                LET leftRunning == st = "tomb0" /\ ~seen
                    raced == st = "tomb0" /\ CarryDelete = "queued-race"
                IN /\ vis' = Decide(v, "unavailable")
                   /\ ses' = IF raced THEN [ses EXCEPT ![s].st = "orphanq"]
                             ELSE IF leftRunning THEN [ses EXCEPT ![s].st = "orphan"] ELSE CarryEnd(s)
                   /\ gh' = gh \cup {"recheckFail"} \cup (IF leftRunning THEN {"orphan"} ELSE {})
                               \cup (IF Carried(s) THEN {"carried"} ELSE {})
                               \cup (IF ses[s].st \in Alive /\ ~EndComing(s) /\ ~Carried(s) THEN {"failOnLive"} ELSE {}))
          ELSE IF st = "tomb0"
          THEN /\ vis' = [vis EXCEPT ![v].sent = TRUE] /\ ses' = [ses EXCEPT ![s].st = "orphan"] /\ gh' = gh \cup {"orphan"}
          ELSE IF st = "ended" \/ (Backstop /\ st \in {"deleted", "zombie", "revived"})
          THEN /\ vis' = Decide(v, "unavailable") /\ gh' = gh \cup {"loudFail"} /\ UNCHANGED ses
          ELSE IF st \in {"deleted", "zombie", "revived"}
          THEN /\ vis' = [vis EXCEPT ![v].sent = TRUE]
               /\ ses' = [ses EXCEPT ![s].st = "zombie"]
               /\ gh' = gh \cup {"dropped"}
          ELSE IF st = "ending"
          THEN /\ vis' = [vis EXCEPT ![v].sent = TRUE]
               /\ UNCHANGED ses
               \* queued behind the end; not a loss when the crashed attempt's copy is the running turn
               /\ gh' = gh \cup (IF ses[s].turn = v THEN {} ELSE {"dropped"})
          ELSE \E crash \in (IF AllowSpawnCrash /\ ~vis[v].cr THEN BOOLEAN ELSE {FALSE}) :
               /\ vis' = IF crash THEN [vis EXCEPT ![v].ph = "idle", ![v].cr = TRUE] ELSE [vis EXCEPT ![v].sent = TRUE]
               /\ ses' = [ses EXCEPT ![s].st = IF st \in {"none", "row"} THEN "creating" ELSE st, ![s].q = @ \cup {v}]
               /\ UNCHANGED gh
    /\ UNCHANGED <<pend, marked, run, nv, readers, afterDone, acted, reports, failedV>>

(* DR2-001: the orchestration a send started on a deleted session with its *)
(* delete queued behind the prompt: the worker reads the delete first, or  *)
(* fetches the start and the prompt first and admits a model turn (refused *)
(* under TurnGuard). An orphan (no delete queued) admits its turn too.     *)
RaceResolve(s) ==
    /\ ses[s].st = "orphanq"
    /\ \E turnFirst \in BOOLEAN :
          /\ ses' = [ses EXCEPT ![s].st = "deleted", ![s].q = {}]
          /\ gh' = gh \cup (IF ~turnFirst THEN {} ELSE IF TurnGuard THEN {"turnRefused"} ELSE {"turnOnDeleted"})
    /\ UNCHANGED <<pend, marked, run, nv, vis, readers, afterDone, acted, reports, failedV>>
OrphanTurn(s) ==
    /\ ses[s].st = "orphan"
    /\ IF TurnGuard
       THEN ses' = [ses EXCEPT ![s].st = "deleted", ![s].q = {}] /\ gh' = gh \cup {"turnRefused"}
       ELSE "turnOnDeleted" \notin gh /\ gh' = gh \cup {"turnOnDeleted"} /\ UNCHANGED ses
    /\ UNCHANGED <<pend, marked, run, nv, vis, readers, afterDone, acted, reports, failedV>>

(* The agent session becomes visible (an attempt in flight may finish      *)
(* after the run ended).                                                   *)
Visible(s) ==
    /\ ses[s].st = "creating" /\ ses' = [ses EXCEPT ![s].st = "live"]
    /\ UNCHANGED <<pend, marked, run, nv, vis, readers, afterDone, acted, gh, reports, failedV>>

(* A turn takes the oldest queued prompt; a decided visit's turn is not    *)
(* run (session-proxy turn start).                                         *)
TurnStart(s) ==
    /\ ses[s].st = "live" /\ ses[s].turn = 0 /\ ses[s].q # {}
    /\ LET u == CHOOSE x \in ses[s].q : \A y \in ses[s].q : x <= y
           skip == vis[u].node = "decided" /\ Fault # "run-decided"
       IN /\ ses' = [ses EXCEPT ![s].q = @ \ {u}, ![s].turn = IF skip THEN 0 ELSE u]
          /\ gh' = gh \cup (IF skip THEN {"skipped"} ELSE {}) \cup (IF ~skip /\ vis[u].node = "decided" THEN {"ranDecided"} ELSE {})
    /\ UNCHANGED <<pend, marked, run, nv, vis, readers, afterDone, acted, reports, failedV>>

(* The turn ends with the agent's result: it decides only its own pending  *)
(* visit (bound by node execution id); a late result is refused.           *)
TurnEnd(s) ==
    /\ ses[s].turn # 0
    /\ LET u == ses[s].turn
           pendVis == {w \in Vis : vis[w].s = s /\ vis[w].node = "pending"}
           t == IF Fault = "bind-newest" /\ pendVis # {} THEN CHOOSE w \in pendVis : \A x \in pendVis : x <= w ELSE u
       IN /\ vis' = IF vis[t].node = "pending" THEN Decide(t, "result") ELSE vis
          /\ gh' = gh \cup (IF vis[t].node = "pending" /\ t # u THEN {"wrongResult"} ELSE {})
    /\ ses' = [ses EXCEPT ![s].turn = 0]
    /\ UNCHANGED <<pend, marked, run, nv, readers, afterDone, acted, reports, failedV>>

(* tf1: the running turn fails terminally: it ends without a result, the  *)
(* session goes idle with an error and takes the next prompt (the next     *)
(* successful turn clears the error: the next visit reuses it). With a     *)
(* report, the failure of the turn's own visit is owed to the store. A     *)
(* turn carries one visit's prompt here (TurnStart takes one); a turn that *)
(* carried several would owe a report for each.                            *)
TurnFails(s) ==
    /\ AllowTurnFail /\ ses[s].turn # 0
    /\ LET u == ses[s].turn
       IN /\ ses' = [ses EXCEPT ![s].turn = 0]
          /\ failedV' = failedV \cup {u}
          /\ reports' = IF FailReport # "none" THEN reports \cup {u} ELSE reports
    /\ UNCHANGED <<pend, marked, run, nv, vis, readers, afterDone, acted, gh>>

(* tf1: the report's store step: the turn's own visit is decided           *)
(* execution_failed (winner controller) only while it is pending; a visit  *)
(* already decided (a stale turn whose Stop failed, G2) is kept.           *)
ReportDecide(u) ==
    /\ u \in reports
    /\ LET s == vis[u].s
           pendVis == {w \in Vis : vis[w].s = s /\ vis[w].node = "pending"}
           t == IF FailReport = "binds-newest" /\ pendVis # {} THEN CHOOSE w \in pendVis : \A x \in pendVis : x <= w ELSE u
       IN /\ vis' = IF vis[t].node = "pending" THEN Decide(t, "execution_failed") ELSE vis
          /\ gh' = gh \cup (IF vis[t].node = "pending" /\ t # u THEN {"wrongResult"} ELSE {})
    /\ reports' = reports \ {u}
    /\ UNCHANGED <<pend, marked, run, nv, ses, readers, afterDone, acted, failedV>>

(* tf1: a later turn of the session succeeds while the failed visit's     *)
(* report is still owed (its activity failed so far): the report is       *)
(* dropped; the agent completes the visit in that turn, or does not (then *)
(* its time limit decides it).                                             *)
RecoveredTurn(u) ==
    /\ AllowRecover /\ u \in reports /\ vis[u].node = "pending"
    /\ LET s == vis[u].s
       IN /\ ses[s].st = "live" /\ ses[s].turn = 0
          /\ \E done \in BOOLEAN :
                /\ vis' = IF done THEN Decide(u, "result") ELSE vis
                /\ gh' = gh \cup {"dropped"} \cup (IF done THEN {"droppedThenResult"} ELSE {})
    /\ reports' = reports \ {u}
    /\ UNCHANGED <<pend, marked, run, nv, ses, readers, afterDone, acted, failedV>>

(* The visit's time limit.                                                 *)
Timeout(v) ==
    /\ vis[v].node = "pending" /\ run # "ended"
    /\ vis' = Decide(v, "timeout")
    /\ UNCHANGED <<pend, marked, run, nv, ses, readers, afterDone, acted, gh, reports, failedV>>

(* endContinuedVisit: while the run is active (or stopping) the visit's    *)
(* turn gets a cycle Stop; a Stop may fail past its retries (G2) and then  *)
(* nothing sends it again during the run. After the run ended no Stop is   *)
(* sent (G5) unless StopAtRunEnd.                                          *)
EndVisit(v) ==
    /\ vis[v].node = "decided" /\ ~vis[v].endReq
    /\ LET s == vis[v].s
           active == run # "ended"
           stopping == active \/ StopAtRunEnd
       IN \E ok \in (IF active /\ AllowStopFail THEN BOOLEAN ELSE {TRUE}) :
            /\ vis' = [vis EXCEPT ![v].endReq = TRUE, ![v].stopOk = stopping /\ ok, ![v].gaveUp = stopping /\ ~ok]
            /\ ses' = IF stopping /\ ok /\ ses[s].turn = v THEN [ses EXCEPT ![s].turn = 0] ELSE ses
            /\ gh' = gh \cup (IF stopping /\ ok /\ ses[s].turn = v THEN {"cycleStop"} ELSE {})
                        \cup (IF ~stopping /\ ses[s].turn = v THEN {"noStopAtEnd"} ELSE {})
    /\ UNCHANGED <<pend, marked, run, nv, readers, afterDone, acted, reports, failedV>>

(* Fix G2: the next visit's spawn sends the Stop again until it lands; with *)
(* the G5 fix, the run's end sends it again too (endWorkflowRunAgents).  *)
RetryStop(u) ==
    /\ vis[u].gaveUp
    /\ \/ StopBeforeSpawn /\ \E v \in Vis : v > u /\ vis[v].s = vis[u].s /\ vis[v].node = "pending" /\ ~vis[v].sent
       \/ StopAtRunEnd /\ run = "ended"
    /\ vis' = [vis EXCEPT ![u].gaveUp = FALSE, ![u].stopOk = TRUE]
    /\ ses' = IF ses[vis[u].s].turn = u THEN [ses EXCEPT ![vis[u].s].turn = 0] ELSE ses
    /\ UNCHANGED <<pend, marked, run, nv, readers, afterDone, acted, gh, reports, failedV>>

(* The end of one agent session under its end lock (endContinuedSessionLocked). *)
Due(s) == Used(s) /\ ses[s].endState = "open" /\ vis[Newest(s)].node = "decided"
AgentSessionEnd(r) ==
    IF r.st \in {"none", "row", "creating"}
    THEN IF r.st = "creating" /\ Fault # "no-owed-mark" THEN [r EXCEPT !.endState = "owed"] ELSE [r EXCEPT !.endState = "ended"]
    ELSE IF r.st = "live"
    THEN [r EXCEPT !.endState = "ended", !.ends = @ + 1, !.st = IF r.turn = 0 THEN "ended" ELSE "ending"]
    \* an orchestration running on a deleted row is ended too (endContinuedSessionLocked reads its status, not the row)
    ELSE IF r.st = "orphan"
    THEN [r EXCEPT !.endState = "ended", !.ends = @ + 1, !.st = "deleted"]
    ELSE [r EXCEPT !.endState = "ended"]

(* afterEnd: once the run ended, every agent session in order; one whose   *)
(* end keeps failing stops the loop (G3) unless PerAgentSessionEnd; it is then *)
(* swallowed (only a recover looks again).                                 *)
Looked(s) == s # FailAgentSession /\ (FailAgentSession = 0 \/ PerAgentSessionEnd \/ s < FailAgentSession)
AfterEnd ==
    /\ run = "ended" /\ ~afterDone /\ (\A v \in Vis : vis[v].node # "pending")
    /\ ses' = [s \in Ses |-> IF Looked(s) /\ Due(s) THEN AgentSessionEnd(ses[s]) ELSE ses[s]]
    /\ afterDone' = TRUE
    /\ UNCHANGED <<pend, marked, run, nv, vis, readers, acted, gh, reports, failedV>>

(* A stopping run ends an idle agent session at collect; also the owed     *)
(* end's retry (wfc) and the visit's own end after the run stopped.        *)
LookLocked(s) ==
    /\ Fault # "end-without-lock"
    /\ \/ run = "stopping" /\ Due(s)
       \/ ses[s].endState = "owed" /\ ses[s].st # "creating"
    /\ ses' = [ses EXCEPT ![s] = AgentSessionEnd([ses[s] EXCEPT !.endState = "open"])]
    /\ UNCHANGED <<pend, marked, run, nv, vis, readers, afterDone, acted, gh, reports, failedV>>
LookRead(s) ==
    /\ Fault = "end-without-lock" /\ s \notin readers
    /\ run # "active" /\ Due(s) /\ ses[s].st = "live"
    /\ readers' = readers \cup {s}
    /\ UNCHANGED <<pend, marked, run, nv, vis, ses, afterDone, acted, gh, reports, failedV>>
LookSend(s) ==
    /\ s \in readers /\ readers' = readers \ {s}
    /\ ses' = [ses EXCEPT ![s].ends = @ + 1, ![s].endState = "ended",
                           ![s].st = IF @ = "live" THEN (IF ses[s].turn = 0 THEN "ended" ELSE "ending") ELSE @]
    /\ UNCHANGED <<pend, marked, run, nv, vis, afterDone, acted, gh, reports, failedV>>

(* A person runs recover after a failed end: every agent session looked at. *)
Recover ==
    /\ run = "ended" /\ afterDone /\ (\E s \in Ses : Due(s))
    /\ ses' = [s \in Ses |-> IF Due(s) THEN AgentSessionEnd(ses[s]) ELSE ses[s]]
    /\ UNCHANGED <<pend, marked, run, nv, vis, readers, afterDone, acted, gh, reports, failedV>>

(* An ended session's command lands after its running turn.                *)
Finish(s) ==
    /\ ses[s].st = "ending" /\ ses[s].turn = 0
    /\ ses' = [ses EXCEPT ![s].st = "ended", ![s].q = {}]
    /\ UNCHANGED <<pend, marked, run, nv, vis, readers, afterDone, acted, gh, reports, failedV>>

(* A person ends or deletes an agent session (once).                       *)
PersonEnd(s) ==
    /\ ~MarkSplit
    /\ Person \in {"end", "any"} /\ ~acted /\ ses[s].st = "live"
    /\ ses' = [ses EXCEPT ![s].st = IF ses[s].turn = 0 THEN "ended" ELSE "ending"]
    /\ acted' = TRUE /\ marked' = marked \cup {s}
    /\ UNCHANGED <<pend, run, nv, vis, readers, afterDone, gh, reports, failedV>>
(* DRR-2: a person's end in two steps (MarkSplit): the mark, then the      *)
(* command. The command may fail (the call throws) or the process may stop *)
(* in between; a withdrawal removes a thrown end's mark; an outbox sends   *)
(* the command later. A command finds the session as it is then.          *)
PersonMark(s) ==
    /\ MarkSplit /\ Person \in {"end", "any"} /\ ~acted /\ (ses[s].st = "live" \/ (MarkCreating /\ ses[s].st = "creating"))
    /\ marked' = marked \cup {s} /\ acted' = TRUE /\ pend' = [ph |-> "marked", s |-> s]
    /\ UNCHANGED <<run, nv, vis, ses, readers, afterDone, gh, reports, failedV>>
PersonEnqueue ==
    /\ pend.ph = "marked" \/ (Outbox /\ pend.ph \in {"thrown", "crashed"})
    /\ ses' = [ses EXCEPT ![pend.s] = EndCmd(ses[pend.s])]
    /\ pend' = [pend EXCEPT !.ph = "done"]
    /\ UNCHANGED <<marked, run, nv, vis, readers, afterDone, acted, gh, reports, failedV>>
PersonEnqueueFails ==
    /\ pend.ph = "marked" /\ MarkFail # "none"
    /\ pend' = [pend EXCEPT !.ph = IF MarkFail = "throw" THEN "thrown" ELSE "crashed"]
    /\ UNCHANGED <<marked, run, nv, vis, ses, readers, afterDone, acted, gh, reports, failedV>>
WithdrawMark ==
    /\ Withdraw /\ pend.ph = "thrown" /\ ~Outbox
    /\ marked' = marked \ {pend.s} /\ pend' = [pend EXCEPT !.ph = "withdrawn"]
    /\ UNCHANGED <<run, nv, vis, ses, readers, afterDone, acted, gh, reports, failedV>>
PersonDelete(s) ==
    /\ Person \in {"delete", "any"} /\ ~acted /\ ((ses[s].st = "live" /\ ses[s].turn = 0) \/ ses[s].st = "row")
    /\ ses' = [ses EXCEPT ![s].st = IF @ = "row" THEN "tomb0" ELSE "deleted", ![s].q = {}]
    /\ acted' = TRUE
    /\ UNCHANGED <<pend, marked, run, nv, vis, readers, afterDone, gh, reports, failedV>>

RunStop == AllowStop /\ run = "active" /\ run' = "stopping" /\ UNCHANGED <<pend, marked, nv, vis, ses, readers, afterDone, acted, gh, reports, failedV>>
StopDone ==
    /\ run = "stopping" /\ (\A v \in Vis : vis[v].node # "pending")
    /\ run' = "ended"
    /\ UNCHANGED <<pend, marked, nv, vis, ses, readers, afterDone, acted, gh, reports, failedV>>
RunCancel ==
    /\ AllowCancel /\ run \in {"active", "stopping"} /\ run' = "ended"
    /\ vis' = [v \in Vis |-> IF vis[v].node = "pending" THEN [vis[v] EXCEPT !.node = "decided", !.how = "cancelled"] ELSE vis[v]]
    /\ UNCHANGED <<pend, marked, nv, ses, readers, afterDone, acted, gh, reports, failedV>>
RunDone ==
    /\ run = "active" /\ nv = V /\ vis[V].node = "decided" /\ vis[V].endReq
    /\ run' = "ended" /\ UNCHANGED <<pend, marked, nv, vis, ses, readers, afterDone, acted, gh, reports, failedV>>

Done == run = "ended" /\ afterDone /\ UNCHANGED vars

Next ==
    \/ Done \/ Admit \/ RunStop \/ StopDone \/ RunCancel \/ RunDone \/ AfterEnd \/ Recover
    \/ PersonEnqueue \/ PersonEnqueueFails \/ WithdrawMark
    \/ \E v \in Vis : Spawn(v) \/ SpawnCheck(v) \/ SpawnCreate(v) \/ SpawnSend(v) \/ Timeout(v) \/ EndVisit(v) \/ RetryStop(v)
                      \/ ReportDecide(v) \/ RecoveredTurn(v)
    \/ \E s \in Ses : Visible(s) \/ TurnStart(s) \/ TurnEnd(s) \/ LookLocked(s) \/ LookRead(s) \/ LookSend(s)
                      \/ Finish(s) \/ PersonEnd(s) \/ PersonMark(s) \/ PersonDelete(s) \/ RaceResolve(s) \/ OrphanTurn(s)
                      \/ TurnFails(s)

Spec == Init /\ [][Next]_vars
Fairness ==
    /\ WF_vars(Admit) /\ WF_vars(StopDone) /\ WF_vars(RunDone) /\ WF_vars(AfterEnd)
    /\ WF_vars(PersonEnqueue) /\ WF_vars(WithdrawMark)
    /\ \A v \in Vis : WF_vars(Spawn(v)) /\ WF_vars(SpawnCheck(v)) /\ WF_vars(SpawnCreate(v)) /\ WF_vars(SpawnSend(v)) /\ WF_vars(TimeoutFair /\ Timeout(v)) /\ WF_vars(EndVisit(v)) /\ WF_vars(RetryStop(v))
                      /\ WF_vars(ReportDecide(v))
    /\ \A s \in Ses : WF_vars(Visible(s)) /\ WF_vars(TurnStart(s)) /\ WF_vars(TurnEnd(s)) /\ WF_vars(LookLocked(s))
                      /\ WF_vars(LookSend(s)) /\ WF_vars(Finish(s)) /\ WF_vars(RaceResolve(s))
                      /\ WF_vars(TurnGuard /\ OrphanTurn(s))
    /\ WF_vars(RecoverFair /\ Recover)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK == /\ run \in {"active", "stopping", "ended"} /\ nv \in 0..V
          /\ \A v \in Vis : vis[v].node \in {"none", "pending", "decided"} /\ vis[v].s \in 0..V
          /\ \A s \in Ses : ses[s].st \in {"none", "row", "creating", "live", "ending", "ended", "deleted", "zombie", "revived", "tomb0", "orphan", "orphanq"}
                            /\ ses[s].turn \in 0..V /\ ses[s].q \subseteq Vis /\ ses[s].endState \in {"open", "owed", "ended"}
(* One agent session per agent state goes on at a time.                    *)
(* An agent session whose end command is on its way does not count.       *)
Inv_OneLive == Cardinality({s \in Ses : ses[s].st \in Alive /\ ~EndComing(s)}) <= 1
(* A visit is decided only by a result from its own turn.                  *)
Inv_ResultOwnVisit == "wrongResult" \notin gh
(* A replacement agent session only after the previous one ended.          *)
Inv_ReplaceOnlyEnded == "replacedLive" \notin gh
(* No turn runs for a visit already decided.                               *)
Inv_NoTurnForDecided == "ranDecided" \notin gh
(* An agent session gets its end command at most once.                     *)
Inv_EndOnce == \A s \in Ses : ses[s].ends <= 1
(* G1: a visit's prompt is never silently dropped (a deleted or ending     *)
(* agent session); G1 loud: a visit never waits out the spawn retries on   *)
(* an agent session that already ended.                                    *)
Inv_PromptNotDropped == "dropped" \notin gh
Inv_NoLoudFail == "loudFail" \notin gh
(* G2: a later visit's prompt never waits behind a decided visit's turn    *)
(* whose Stop was never sent.                                              *)
Inv_NoPromptBehindStaleTurn ==
    \A s \in Ses : (ses[s].turn # 0 /\ vis[ses[s].turn].node = "decided" /\ vis[ses[s].turn].gaveUp)
                   => ~\E v \in ses[s].q : vis[v].node = "pending"
(* G5: a visit ended by the run's end stops its running turn.              *)
Inv_StopAtRunEnd == "noStopAtEnd" \notin gh

Prop_VisitsDecided == \A v \in Vis : (vis[v].node = "pending") ~> (vis[v].node = "decided")
Prop_AllEnded == <>[](run = "ended" => \A s \in Ses : ses[s].st \notin {"live", "ending", "creating"} \/ ~Used(s))
Prop_OthersEnded == <>[](run = "ended" => \A s \in Ses \ {FailAgentSession} : ses[s].st \notin {"live", "ending", "creating"} \/ ~Used(s))
(* tf1: a visit whose turn failed terminally is decided without its time   *)
(* limit (checked with TimeoutFair FALSE).                                  *)
Prop_FailedVisitDecided == \A v \in Vis : (v \in failedV /\ vis[v].node = "pending") ~> (vis[v].node = "decided")
Prop_OrphanEnded == \A s \in Ses : (ses[s].st \in {"orphan", "orphanq"}) ~> (ses[s].st \notin {"orphan", "orphanq"})
(* DR2-001: no model turn runs on a deleted agent session.                 *)
Inv_NoTurnOnDeleted == "turnOnDeleted" \notin gh
Prop_OwedSent == \A s \in Ses : (ses[s].endState = "owed") ~> (ses[s].endState = "ended")

(* DRR-1: a deleted agent session is never brought back.                  *)
Inv_NoRevive == "revived" \notin gh
(* No orchestration is started for a deleted agent session and left running. *)
Inv_NoOrphanRun == "orphan" \notin gh
(* DRR-2: a replacement agent session never leaves the previous one live   *)
(* with no end on its way, and a visit never fails at once because of a   *)
(* mark while its agent session is live with no end on its way.           *)
Inv_NoAbandonedLive == "abandoned" \notin gh
Inv_NoFailOnLive == "failOnLive" \notin gh

W_NoReplacement == "replaced" \notin gh
W_NoOwedEnd == \A s \in Ses : ~(ses[s].endState = "owed")
W_NoCycleStop == "cycleStop" \notin gh
W_NoSkip == "skipped" \notin gh
W_NoCarry == "carried" \notin gh
W_NoRecheckFail == "recheckFail" \notin gh
(* tf1: a failure report decides a visit; the next visit reuses the agent  *)
(* session whose turn failed.                                              *)
W_NoFailDecided == ~\E v \in Vis : vis[v].how = "execution_failed"
W_NoDroppedThenResult == "droppedThenResult" \notin gh
W_NoDroppedThenTimeout == ~("dropped" \in gh /\ \E v \in failedV : vis[v].how = "timeout")
W_NoReuseAfterFail == ~\E v \in 1..(V - 1) : vis[v].how = "execution_failed" /\ vis[v + 1].node # "none" /\ vis[v + 1].s = vis[v].s
=============================================================================
