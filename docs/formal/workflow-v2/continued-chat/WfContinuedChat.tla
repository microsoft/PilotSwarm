---------------------------- MODULE WfContinuedChat ----------------------------
(***************************************************************************)
(* The session lifecycle "continue" of a Workflow agent state: its visits  *)
(* in one run go to one agent session (packages/sdk/src/workflow/v2,       *)
(* runtime.ts and store.ts; the default for an agent state in the outer    *)
(* graph). A visit's agent session is chosen at its admission and frozen   *)
(* (continuedChatOf): the previous visit's session while it goes on, else  *)
(* a replacement session. The spawn sends the visit's prompt to it. A      *)
(* turn takes the prompts in order, skips a visit that is already decided, *)
(* and its result binds only to its own visit (agentInvocationOfCompletion *)
(* by node execution id). When a visit ends, its turn gets a cycle Stop    *)
(* and the session stays open (ChatContinues). When the run ends (stop,    *)
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
    FailChat,       \* 0, or the agent session whose end fails past every retry after the run ended
    RecoverFair,    \* a person runs recover after a failed end (it is only on request)
    SpawnRecheck,   \* fix G1: the spawn checks the frozen agent session is not ended or deleted before sending
    StopBeforeSpawn,\* fix G2: the next visit's spawn first ends earlier visits whose Stop was not sent
    PerChatEnd,     \* fix G3: one agent session's failed end does not keep the others from being ended
    StopAtRunEnd,   \* fix G5: a visit ended by the run's end also stops its running turn
    Fault           \* "none", "bind-newest", "replace-without-check", "no-owed-mark", "end-without-lock", "run-decided"

ASSUME V \in 1..3 /\ Person \in {"none", "end", "delete", "any"}
ASSUME {AllowStop, AllowCancel, AllowStopFail, RecoverFair, SpawnRecheck, StopBeforeSpawn, PerChatEnd, StopAtRunEnd} \subseteq BOOLEAN
ASSUME FailChat \in 0..V
ASSUME Fault \in {"none", "bind-newest", "replace-without-check", "no-owed-mark", "end-without-lock", "run-decided"}

Vis == 1..V
Ses == 1..V
Alive == {"creating", "live", "ending"}

VARIABLES
    run,        \* "active", "stopping", "ended"
    nv,         \* visits admitted
    vis,        \* visit -> [node, how, s, sent, endReq, stopOk, gaveUp]
    ses,        \* agent session -> [st, turn, q, chat, ends]
    readers,    \* agent sessions an unlocked looker has read as live (fault "end-without-lock")
    afterDone,  \* the run's end looked at every agent session (afterEnd)
    acted,      \* a person acted
    gh
vars == <<run, nv, vis, ses, readers, afterDone, acted, gh>>

NoVisit == [node |-> "none", how |-> "none", s |-> 0, sent |-> FALSE, endReq |-> FALSE, stopOk |-> FALSE, gaveUp |-> FALSE]
NoSes == [st |-> "none", turn |-> 0, q |-> {}, chat |-> "open", ends |-> 0]

Init == /\ run = "active" /\ nv = 0 /\ vis = [v \in Vis |-> NoVisit] /\ ses = [s \in Ses |-> NoSes]
        /\ readers = {} /\ afterDone = FALSE /\ acted = FALSE /\ gh = {}

Decide(v, how) == [vis EXCEPT ![v].node = "decided", ![v].how = how]
Used(s) == \E v \in Vis : vis[v].node # "none" /\ vis[v].s = s
Newest(s) == CHOOSE v \in Vis : vis[v].s = s /\ vis[v].node # "none" /\ \A w \in Vis : (vis[w].s = s /\ vis[w].node # "none") => w <= v
Ended(st) == st \in {"ended", "deleted", "zombie"}

(* Admission (enter): the previous visit decided and its end attempted     *)
(* (collect ends a child before routing on). continuedChatOf reads the     *)
(* previous agent session without a lock; the choice is frozen.            *)
Admit ==
    /\ run = "active" /\ nv < V
    /\ IF nv = 0 THEN TRUE ELSE vis[nv].node = "decided" /\ vis[nv].endReq
    /\ LET prev == IF nv = 0 THEN 0 ELSE vis[nv].s
           gone == prev # 0 /\ Ended(ses[prev].st)
           s == IF prev = 0 THEN 1 ELSE IF gone \/ Fault = "replace-without-check" THEN nv + 1 ELSE prev
       IN /\ vis' = [vis EXCEPT ![nv + 1].node = "pending", ![nv + 1].s = s]
          /\ gh' = gh \cup (IF prev # 0 /\ s # prev /\ ~gone THEN {"replacedLive"} ELSE {})
                      \cup (IF prev # 0 /\ s # prev THEN {"replaced"} ELSE {})
    /\ nv' = nv + 1
    /\ UNCHANGED <<run, ses, readers, afterDone, acted>>

(* spawnAgent: send the visit's prompt to its frozen agent session. A      *)
(* completed or cancelled session refuses it: the spawn retries, then the  *)
(* visit fails unavailable. A deleted one is brought back as a row that    *)
(* says running while duroxide drops the prompt (zombie).                  *)
Spawn(v) ==
    /\ vis[v].node = "pending" /\ ~vis[v].sent /\ run # "ended"
    /\ StopBeforeSpawn => \A u \in Vis : (u < v /\ vis[u].s = vis[v].s /\ vis[u].node = "decided") => ~vis[u].gaveUp
    /\ LET s == vis[v].s
           st == ses[s].st
       IN IF SpawnRecheck /\ (Ended(st) \/ st = "ending")
          THEN /\ vis' = Decide(v, "unavailable") /\ UNCHANGED <<ses, gh>>
          ELSE IF st = "ended"
          THEN /\ vis' = Decide(v, "unavailable") /\ gh' = gh \cup {"loudFail"} /\ UNCHANGED ses
          ELSE IF st \in {"deleted", "zombie", "ending"}
          THEN /\ vis' = [vis EXCEPT ![v].sent = TRUE]
               /\ ses' = [ses EXCEPT ![s].st = IF st = "ending" THEN "ending" ELSE "zombie"]
               /\ gh' = gh \cup {"dropped"}
          ELSE /\ vis' = [vis EXCEPT ![v].sent = TRUE]
               /\ ses' = [ses EXCEPT ![s].st = IF st = "none" THEN "creating" ELSE st, ![s].q = @ \cup {v}]
               /\ UNCHANGED gh
    /\ UNCHANGED <<run, nv, readers, afterDone, acted>>

(* The agent session becomes visible (an attempt in flight may finish      *)
(* after the run ended).                                                   *)
Visible(s) ==
    /\ ses[s].st = "creating" /\ ses' = [ses EXCEPT ![s].st = "live"]
    /\ UNCHANGED <<run, nv, vis, readers, afterDone, acted, gh>>

(* A turn takes the oldest queued prompt; a decided visit's turn is not    *)
(* run (session-proxy turn start).                                         *)
TurnStart(s) ==
    /\ ses[s].st = "live" /\ ses[s].turn = 0 /\ ses[s].q # {}
    /\ LET u == CHOOSE x \in ses[s].q : \A y \in ses[s].q : x <= y
           skip == vis[u].node = "decided" /\ Fault # "run-decided"
       IN /\ ses' = [ses EXCEPT ![s].q = @ \ {u}, ![s].turn = IF skip THEN 0 ELSE u]
          /\ gh' = gh \cup (IF skip THEN {"skipped"} ELSE {}) \cup (IF ~skip /\ vis[u].node = "decided" THEN {"ranDecided"} ELSE {})
    /\ UNCHANGED <<run, nv, vis, readers, afterDone, acted>>

(* The turn ends with the agent's result: it decides only its own pending  *)
(* visit (bound by node execution id); a late result is refused.           *)
TurnEnd(s) ==
    /\ ses[s].turn # 0
    /\ LET u == ses[s].turn
           pend == {w \in Vis : vis[w].s = s /\ vis[w].node = "pending"}
           t == IF Fault = "bind-newest" /\ pend # {} THEN CHOOSE w \in pend : \A x \in pend : x <= w ELSE u
       IN /\ vis' = IF vis[t].node = "pending" THEN Decide(t, "result") ELSE vis
          /\ gh' = gh \cup (IF vis[t].node = "pending" /\ t # u THEN {"wrongResult"} ELSE {})
    /\ ses' = [ses EXCEPT ![s].turn = 0]
    /\ UNCHANGED <<run, nv, readers, afterDone, acted>>

(* The visit's time limit.                                                 *)
Timeout(v) ==
    /\ vis[v].node = "pending" /\ run # "ended"
    /\ vis' = Decide(v, "timeout")
    /\ UNCHANGED <<run, nv, ses, readers, afterDone, acted, gh>>

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
    /\ UNCHANGED <<run, nv, readers, afterDone, acted>>

(* Fix G2: the next visit's spawn sends the Stop again until it lands.     *)
RetryStop(u) ==
    /\ StopBeforeSpawn /\ vis[u].gaveUp
    /\ \E v \in Vis : v > u /\ vis[v].s = vis[u].s /\ vis[v].node = "pending" /\ ~vis[v].sent
    /\ vis' = [vis EXCEPT ![u].gaveUp = FALSE, ![u].stopOk = TRUE]
    /\ ses' = IF ses[vis[u].s].turn = u THEN [ses EXCEPT ![vis[u].s].turn = 0] ELSE ses
    /\ UNCHANGED <<run, nv, readers, afterDone, acted, gh>>

(* The end of one agent session under its end lock (endContinuedChatLocked). *)
Due(s) == Used(s) /\ ses[s].chat = "open" /\ vis[Newest(s)].node = "decided"
ChatEnd(r) ==
    IF r.st \in {"none", "creating"}
    THEN IF r.st = "creating" /\ Fault # "no-owed-mark" THEN [r EXCEPT !.chat = "owed"] ELSE [r EXCEPT !.chat = "ended"]
    ELSE IF r.st = "live"
    THEN [r EXCEPT !.chat = "ended", !.ends = @ + 1,
                   !.st = IF r.turn = 0 \/ StopAtRunEnd THEN "ended" ELSE "ending",
                   !.turn = IF StopAtRunEnd THEN 0 ELSE @]
    ELSE [r EXCEPT !.chat = "ended"]

(* afterEnd: once the run ended, every agent session in order; one whose   *)
(* end keeps failing stops the loop (G3) unless PerChatEnd; it is then     *)
(* swallowed (only a recover looks again).                                 *)
Looked(s) == s # FailChat /\ (FailChat = 0 \/ PerChatEnd \/ s < FailChat)
AfterEnd ==
    /\ run = "ended" /\ ~afterDone /\ (\A v \in Vis : vis[v].node # "pending")
    /\ ses' = [s \in Ses |-> IF Looked(s) /\ Due(s) THEN ChatEnd(ses[s]) ELSE ses[s]]
    /\ afterDone' = TRUE
    /\ UNCHANGED <<run, nv, vis, readers, acted, gh>>

(* A stopping run ends an idle agent session at collect; also the owed     *)
(* end's retry (wfc) and the visit's own end after the run stopped.        *)
LookLocked(s) ==
    /\ Fault # "end-without-lock"
    /\ \/ run = "stopping" /\ Due(s)
       \/ ses[s].chat = "owed" /\ ses[s].st # "creating"
    /\ ses' = [ses EXCEPT ![s] = ChatEnd([ses[s] EXCEPT !.chat = "open"])]
    /\ UNCHANGED <<run, nv, vis, readers, afterDone, acted, gh>>
LookRead(s) ==
    /\ Fault = "end-without-lock" /\ s \notin readers
    /\ run # "active" /\ Due(s) /\ ses[s].st = "live"
    /\ readers' = readers \cup {s}
    /\ UNCHANGED <<run, nv, vis, ses, afterDone, acted, gh>>
LookSend(s) ==
    /\ s \in readers /\ readers' = readers \ {s}
    /\ ses' = [ses EXCEPT ![s].ends = @ + 1, ![s].chat = "ended",
                           ![s].st = IF @ = "live" THEN (IF ses[s].turn = 0 THEN "ended" ELSE "ending") ELSE @]
    /\ UNCHANGED <<run, nv, vis, afterDone, acted, gh>>

(* A person runs recover after a failed end: every agent session looked at. *)
Recover ==
    /\ run = "ended" /\ afterDone /\ (\E s \in Ses : Due(s))
    /\ ses' = [s \in Ses |-> IF Due(s) THEN ChatEnd(ses[s]) ELSE ses[s]]
    /\ UNCHANGED <<run, nv, vis, readers, afterDone, acted, gh>>

(* An ended session's command lands after its running turn.                *)
Finish(s) ==
    /\ ses[s].st = "ending" /\ ses[s].turn = 0
    /\ ses' = [ses EXCEPT ![s].st = "ended", ![s].q = {}]
    /\ UNCHANGED <<run, nv, vis, readers, afterDone, acted, gh>>

(* A person ends or deletes an agent session (once).                       *)
PersonEnd(s) ==
    /\ Person \in {"end", "any"} /\ ~acted /\ ses[s].st = "live"
    /\ ses' = [ses EXCEPT ![s].st = IF ses[s].turn = 0 THEN "ended" ELSE "ending"]
    /\ acted' = TRUE
    /\ UNCHANGED <<run, nv, vis, readers, afterDone, gh>>
PersonDelete(s) ==
    /\ Person \in {"delete", "any"} /\ ~acted /\ ses[s].st = "live" /\ ses[s].turn = 0
    /\ ses' = [ses EXCEPT ![s].st = "deleted", ![s].q = {}]
    /\ acted' = TRUE
    /\ UNCHANGED <<run, nv, vis, readers, afterDone, gh>>

RunStop == AllowStop /\ run = "active" /\ run' = "stopping" /\ UNCHANGED <<nv, vis, ses, readers, afterDone, acted, gh>>
StopDone ==
    /\ run = "stopping" /\ (\A v \in Vis : vis[v].node # "pending")
    /\ run' = "ended"
    /\ UNCHANGED <<nv, vis, ses, readers, afterDone, acted, gh>>
RunCancel ==
    /\ AllowCancel /\ run \in {"active", "stopping"} /\ run' = "ended"
    /\ vis' = [v \in Vis |-> IF vis[v].node = "pending" THEN [vis[v] EXCEPT !.node = "decided", !.how = "cancelled"] ELSE vis[v]]
    /\ UNCHANGED <<nv, ses, readers, afterDone, acted, gh>>
RunDone ==
    /\ run = "active" /\ nv = V /\ vis[V].node = "decided" /\ vis[V].endReq
    /\ run' = "ended" /\ UNCHANGED <<nv, vis, ses, readers, afterDone, acted, gh>>

Done == run = "ended" /\ afterDone /\ UNCHANGED vars

Next ==
    \/ Done \/ Admit \/ RunStop \/ StopDone \/ RunCancel \/ RunDone \/ AfterEnd \/ Recover
    \/ \E v \in Vis : Spawn(v) \/ Timeout(v) \/ EndVisit(v) \/ RetryStop(v)
    \/ \E s \in Ses : Visible(s) \/ TurnStart(s) \/ TurnEnd(s) \/ LookLocked(s) \/ LookRead(s) \/ LookSend(s)
                      \/ Finish(s) \/ PersonEnd(s) \/ PersonDelete(s)

Spec == Init /\ [][Next]_vars
Fairness ==
    /\ WF_vars(Admit) /\ WF_vars(StopDone) /\ WF_vars(RunDone) /\ WF_vars(AfterEnd)
    /\ \A v \in Vis : WF_vars(Spawn(v)) /\ WF_vars(Timeout(v)) /\ WF_vars(EndVisit(v)) /\ WF_vars(RetryStop(v))
    /\ \A s \in Ses : WF_vars(Visible(s)) /\ WF_vars(TurnStart(s)) /\ WF_vars(TurnEnd(s)) /\ WF_vars(LookLocked(s))
                      /\ WF_vars(LookSend(s)) /\ WF_vars(Finish(s))
    /\ WF_vars(RecoverFair /\ Recover)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK == /\ run \in {"active", "stopping", "ended"} /\ nv \in 0..V
          /\ \A v \in Vis : vis[v].node \in {"none", "pending", "decided"} /\ vis[v].s \in 0..V
          /\ \A s \in Ses : ses[s].st \in {"none", "creating", "live", "ending", "ended", "deleted", "zombie"}
                            /\ ses[s].turn \in 0..V /\ ses[s].q \subseteq Vis /\ ses[s].chat \in {"open", "owed", "ended"}
(* One agent session per agent state goes on at a time.                    *)
Inv_OneLive == Cardinality({s \in Ses : ses[s].st \in Alive}) <= 1
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
Prop_OthersEnded == <>[](run = "ended" => \A s \in Ses \ {FailChat} : ses[s].st \notin {"live", "ending", "creating"} \/ ~Used(s))
Prop_OwedSent == \A s \in Ses : (ses[s].chat = "owed") ~> (ses[s].chat = "ended")

W_NoReplacement == "replaced" \notin gh
W_NoOwedEnd == \A s \in Ses : ~(ses[s].chat = "owed")
W_NoCycleStop == "cycleStop" \notin gh
W_NoSkip == "skipped" \notin gh
=============================================================================
