---------------------------- MODULE WfBranchContinuedSession ----------------------------
(***************************************************************************)
(* Issue I8: Workflow `session: continue` in named parallel branches       *)
(* (packages/sdk/src/workflow: compiler.ts, store.ts, runtime.ts).         *)
(*                                                                         *)
(* Models one Workflow run with an enclosing `parallel` state (`branches`) *)
(* that can be entered up to MaxForks times by an outer loop (p.ordinal    *)
(* 1..MaxForks). Each named branch b \in Branches has one continued agent  *)
(* state that may loop up to MaxBranchVisits times per fork (n.ordinal     *)
(* resets to 1 on each fork re-entry, matching controller/index.ts).       *)
(*                                                                         *)
(* Key mechanics modeled with code-level atomicity:                        *)
(* 1. Concurrent named-branch isolation (independent sessions, stops,      *)
(*    replacements, and per-session run-end error handling).               *)
(* 2. Composite visit ranking (p.ordinal, n.ordinal) in WorkflowStore      *)
(*    (readAgentVisitsBefore, readAgentInvocationByChild), vs deliberate   *)
(*    fault OrderByNodeOrdinalOnly (bare n.ordinal, which inverts fork-2   *)
(*    visit 1 behind fork-1 visit 2).                                      *)
(* 3. Branch cuts (failFast / join: { first: k } / parallel.timeoutSeconds)*)
(*    racing with agent completion (completeAgentNode CAS) and I1's        *)
(*    unstopped post-report reply turn (snapshot commit).                  *)
(* 4. Owed cycle Stop (stopTurn failure) followed by either G2 drain       *)
(*    before the next visit's spawn or run-end session Stop + end.         *)
(* 5. Cross-fork session replacement (session ended on its own in fork 1;  *)
(*    fork 2 allocates deterministic visit = count + 1 replacement).       *)
(* 6. Graceful stop (`run.stop`) with mixed branch states (one branch idle *)
(*    ended immediately while another branch's pending visit keeps running *)
(*    until completion, including across outer-loop re-entry).             *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
    Branches,               \* Set of named branches, e.g. {"A", "B"} or {"A"}
    MaxForks,               \* Maximum outer-loop entries of the parallel state (1 or 2)
    MaxBranchVisits,        \* Maximum visits of the branch's agent state per fork (1 or 2)
    AllowCut,               \* TRUE: a branch may be cut by failFast / join / parallel timeout
    AllowStopFail,          \* TRUE: a cycle Stop may fail once, leaving endSent = FALSE / stopOwed = TRUE
    AllowPersonEnd,         \* TRUE: a person may end a branch's idle session on its own (triggers replacement)
    AllowGracefulStop,      \* TRUE: the run may enter graceful stopping (run.stop != null)
    AllowRunCancel,         \* TRUE: the run may be cancelled mid-fork
    FailEndBranch,          \* "none" or a branch name whose endWorkflowContinuedSessions fails at run end
    OrderByNodeOrdinalOnly  \* FALSE (fix): rank by (p.ordinal, n.ordinal); TRUE (fault): rank by n.ordinal only

VARIABLES
    runState,           \* "running" | "stopping" | "completed" | "cancelled" | "stopped"
    fork,               \* 0 (outside parallel) or current parallel execution ordinal 1..MaxForks
    nextFork,           \* next parallel ordinal to admit (1..MaxForks+1)
    branchPhase,        \* [b \in Branches -> "outside" | "idle" | "in_agent" | "after_agent" | "done" | "cut"]
    branchOrd,          \* [b \in Branches -> 0..MaxBranchVisits] (resets to 0 on each fork re-entry!)
    admitted,           \* [b \in Branches -> SUBSET VisitKeys]
    vState,             \* [b \in Branches -> [VisitKeys -> "none" | "pending" | "completed"]]
    vWinner,            \* [b \in Branches -> [VisitKeys -> "none" | "agent" | "cut" | "run_cancel" | "unavailable"]]
    vSess,              \* [b \in Branches -> [VisitKeys -> 0..MaxSess]]
    vCycle,             \* [b \in Branches -> [VisitKeys -> 0..MaxSess]]
    vSpawned,           \* [b \in Branches -> [VisitKeys -> BOOLEAN]]
    vEndSent,           \* [b \in Branches -> [VisitKeys -> BOOLEAN]]
    vStopOwed,          \* [b \in Branches -> [VisitKeys -> BOOLEAN]]
    vCycleStopSent,     \* [b \in Branches -> [VisitKeys -> BOOLEAN]]
    vStoppedActive,     \* [b \in Branches -> [VisitKeys -> BOOLEAN]] (a Stop hit its turn while runState="running")
    vStopFailUsed,      \* [b \in Branches -> [VisitKeys -> BOOLEAN]]
    vSawCommitted,      \* [b \in Branches -> [VisitKeys -> SUBSET VisitKeys]] (memory seen when visit's turn started)
    sessState,          \* [b \in Branches -> [1..MaxSess -> "uncreated" | "live" | "ended"]]
    sessEndedBy,        \* [b \in Branches -> [1..MaxSess -> "none" | "person" | "workflow"]]
    sessEndCount,       \* [b \in Branches -> [1..MaxSess -> 0..2]]
    sessTurn,           \* [b \in Branches -> [1..MaxSess -> "idle" | "running" | "reporting"]]
    sessTurnVisit,      \* [b \in Branches -> [1..MaxSess -> VisitKeys \cup {NoVisit}]]
    sessQueue,          \* [b \in Branches -> [1..MaxSess -> Seq(VisitKeys)]]
    sessCommitted,      \* [b \in Branches -> [1..MaxSess -> SUBSET VisitKeys]]
    personEndUsed,      \* [b \in Branches -> BOOLEAN]
    \* Witness latches (observe key reachable events without altering transitions)
    wCutAfterDone,      \* BOOLEAN: a branch was cut while a completed ("agent") visit's reply turn was still reporting
    wStoppingMixed,     \* BOOLEAN: while runState="stopping", one branch session ended while another branch had a pending visit
    wOwedCutAtRunEnd,   \* BOOLEAN: the run ended while a cut visit still had vStopOwed = TRUE
    wCrossForkReplace,  \* BOOLEAN: fork 2 allocated a replacement session after fork 1's session ended on its own
    wStopCollision      \* BOOLEAN: a Stop for branch b1 ever affected a session of branch b2 (always FALSE; checked by invariant)

vars == <<runState, fork, nextFork, branchPhase, branchOrd, admitted, vState, vWinner, vSess, vCycle,
          vSpawned, vEndSent, vStopOwed, vCycleStopSent, vStoppedActive, vStopFailUsed, vSawCommitted,
          sessState, sessEndedBy, sessEndCount, sessTurn, sessTurnVisit, sessQueue, sessCommitted,
          personEndUsed, wCutAfterDone, wStoppingMixed, wOwedCutAtRunEnd, wCrossForkReplace, wStopCollision>>

VisitKeys == (1..MaxForks) \X (1..MaxBranchVisits)
NoVisit == <<0, 0>>
MaxSess == MaxForks * MaxBranchVisits
SessIds == 1..MaxSess
TerminalRunStates == {"completed", "cancelled", "stopped"}

\* True chronological rank of two visit keys (p.ordinal, n.ordinal)
TrueLt(k1, k2) == (k1[1] < k2[1]) \/ (k1[1] = k2[1] /\ k1[2] < k2[2])

\* Store query rank: composite (p.ordinal, n.ordinal) under fix, or n.ordinal only under fault
StoreLt(k1, k2) ==
    IF OrderByNodeOrdinalOnly
    THEN k1[2] < k2[2]
    ELSE TrueLt(k1, k2)

\* Equivalent to readAgentVisitsBefore(runId, stateId, before):
\* visits in S strictly before `before` according to StoreLt
VisitsBefore(S, before) == { k \in S : StoreLt(k, before) }

\* Equivalent to ORDER BY ... DESC LIMIT 1 over non-empty set S under StoreLt.
\* When OrderByNodeOrdinalOnly = TRUE and two visits tie on n.ordinal (e.g. <<1,1>> and <<2,1>>),
\* tie-break by fork ordinal (representing created_at / node_execution_id); crucially <<1,2>> (n.ordinal=2)
\* still beats <<2,1>> (n.ordinal=1), reproducing the exact outer-loop inversion bug!
StoreMax(S) ==
    CHOOSE k \in S :
        \A other \in S :
            other = k
            \/ StoreLt(other, k)
            \/ (OrderByNodeOrdinalOnly /\ other[2] = k[2] /\ other[1] < k[1])

\* Visits of branch b bound to session s
VisitsOfSession(b, s) == { k \in admitted[b] : vSess[b][k] = s }

\* Whether any visit across all branches is still pending
AnyPending == \E b \in Branches : \E k \in admitted[b] : vState[b][k] = "pending"

\* Whether a branch has a pending visit on session s
SessionHasPending(b, s) == \E k \in VisitsOfSession(b, s) : vState[b][k] = "pending"

\* Whether an earlier visit of (b, s) still owes a non-done Stop/end (G2 check in endEarlierVisitsOf)
HasOwedEarlierEnd(b, s, k) ==
    \E e \in VisitsOfSession(b, s) :
        e # k /\ TrueLt(e, k) /\ vState[b][e] = "completed" /\ ~vEndSent[b][e]

Init ==
    /\ runState = "running"
    /\ fork = 0
    /\ nextFork = 1
    /\ branchPhase = [b \in Branches |-> "outside"]
    /\ branchOrd = [b \in Branches |-> 0]
    /\ admitted = [b \in Branches |-> {}]
    /\ vState = [b \in Branches |-> [k \in VisitKeys |-> "none"]]
    /\ vWinner = [b \in Branches |-> [k \in VisitKeys |-> "none"]]
    /\ vSess = [b \in Branches |-> [k \in VisitKeys |-> 0]]
    /\ vCycle = [b \in Branches |-> [k \in VisitKeys |-> 0]]
    /\ vSpawned = [b \in Branches |-> [k \in VisitKeys |-> FALSE]]
    /\ vEndSent = [b \in Branches |-> [k \in VisitKeys |-> FALSE]]
    /\ vStopOwed = [b \in Branches |-> [k \in VisitKeys |-> FALSE]]
    /\ vCycleStopSent = [b \in Branches |-> [k \in VisitKeys |-> FALSE]]
    /\ vStoppedActive = [b \in Branches |-> [k \in VisitKeys |-> FALSE]]
    /\ vStopFailUsed = [b \in Branches |-> [k \in VisitKeys |-> FALSE]]
    /\ vSawCommitted = [b \in Branches |-> [k \in VisitKeys |-> {}]]
    /\ sessState = [b \in Branches |-> [s \in SessIds |-> "uncreated"]]
    /\ sessEndedBy = [b \in Branches |-> [s \in SessIds |-> "none"]]
    /\ sessEndCount = [b \in Branches |-> [s \in SessIds |-> 0]]
    /\ sessTurn = [b \in Branches |-> [s \in SessIds |-> "idle"]]
    /\ sessTurnVisit = [b \in Branches |-> [s \in SessIds |-> NoVisit]]
    /\ sessQueue = [b \in Branches |-> [s \in SessIds |-> <<>>]]
    /\ sessCommitted = [b \in Branches |-> [s \in SessIds |-> {}]]
    /\ personEndUsed = [b \in Branches |-> FALSE]
    /\ wCutAfterDone = FALSE
    /\ wStoppingMixed = FALSE
    /\ wOwedCutAtRunEnd = FALSE
    /\ wCrossForkReplace = FALSE
    /\ wStopCollision = FALSE

\* 1. Enter the parallel state (outer fork p.ordinal = nextFork). Resets per-scope branchOrd to 0!
EnterParallel ==
    /\ runState = "running"
    /\ fork = 0
    /\ nextFork <= MaxForks
    /\ fork' = nextFork
    /\ nextFork' = nextFork + 1
    /\ branchPhase' = [b \in Branches |-> "idle"]
    /\ branchOrd' = [b \in Branches |-> 0]
    /\ UNCHANGED <<runState, admitted, vState, vWinner, vSess, vCycle, vSpawned, vEndSent, vStopOwed,
                   vCycleStopSent, vStoppedActive, vStopFailUsed, vSawCommitted, sessState, sessEndedBy,
                   sessEndCount, sessTurn, sessTurnVisit, sessQueue, sessCommitted, personEndUsed,
                   wCutAfterDone, wStoppingMixed, wOwedCutAtRunEnd, wCrossForkReplace, wStopCollision>>

\* 2. Admit a visit of branch b's continued agent state (WORKFLOW_ACTIVITIES.enter + continuedSessionOf)
AdmitVisit(b) ==
    /\ runState = "running"
    /\ fork > 0
    /\ branchPhase[b] = "idle"
    /\ branchOrd[b] < MaxBranchVisits
    /\ LET o == branchOrd[b] + 1
           k == <<fork, o>>
           priorAll == admitted[b]
           priorBefore == VisitsBefore(priorAll, k)
           cyc == Cardinality(priorBefore) + 1
           \* continuedSessionOf reads readAgentVisitsBefore(runId, stateId, null):
           \* count = |priorAll|, last = StoreMax(priorAll) if non-empty
           chosenSid ==
               IF priorAll = {}
               THEN 1
               ELSE LET last == StoreMax(priorAll)
                        prevSid == vSess[b][last]
                    IN IF sessState[b][prevSid] = "ended"
                       THEN Cardinality(priorAll) + 1
                       ELSE prevSid
           isCrossForkReplace ==
               priorAll # {} /\ fork > 1 /\ chosenSid # vSess[b][StoreMax(priorAll)]
       IN /\ branchOrd' = [branchOrd EXCEPT ![b] = o]
          /\ branchPhase' = [branchPhase EXCEPT ![b] = "in_agent"]
          /\ admitted' = [admitted EXCEPT ![b] = @ \cup {k}]
          /\ vState' = [vState EXCEPT ![b][k] = "pending"]
          /\ vWinner' = [vWinner EXCEPT ![b][k] = "none"]
          /\ vSess' = [vSess EXCEPT ![b][k] = chosenSid]
          /\ vCycle' = [vCycle EXCEPT ![b][k] = cyc]
          /\ wCrossForkReplace' = (wCrossForkReplace \/ isCrossForkReplace)
          /\ UNCHANGED <<runState, fork, nextFork, vSpawned, vEndSent, vStopOwed, vCycleStopSent,
                         vStoppedActive, vStopFailUsed, vSawCommitted, sessState, sessEndedBy,
                         sessEndCount, sessTurn, sessTurnVisit, sessQueue, sessCommitted,
                         personEndUsed, wCutAfterDone, wStoppingMixed, wOwedCutAtRunEnd, wStopCollision>>

\* 3. Spawn visit k of branch b (spawnAgent: enforces G2 endEarlierVisitsOf, G1 recheck, queues prompt)
SpawnVisit(b, k) ==
    /\ k \in admitted[b]
    /\ vState[b][k] = "pending"
    /\ ~vSpawned[b][k]
    /\ LET s == vSess[b][k]
       IN /\ ~HasOwedEarlierEnd(b, s, k)
          /\ vSpawned' = [vSpawned EXCEPT ![b][k] = TRUE]
          /\ IF sessState[b][s] = "ended"
             THEN \* G1 recheck: session ended between admission and spawn -> unavailable
                  /\ vState' = [vState EXCEPT ![b][k] = "completed"]
                  /\ vWinner' = [vWinner EXCEPT ![b][k] = "unavailable"]
                  /\ branchPhase' = [branchPhase EXCEPT ![b] = IF fork = k[1] THEN "done" ELSE @]
                  /\ UNCHANGED <<sessState, sessQueue>>
             ELSE /\ sessState' = [sessState EXCEPT ![b][s] = "live"]
                  /\ sessQueue' = [sessQueue EXCEPT ![b][s] = Append(@, k)]
                  /\ UNCHANGED <<vState, vWinner, branchPhase>>
          /\ UNCHANGED <<runState, fork, nextFork, branchOrd, admitted, vSess, vCycle, vEndSent,
                         vStopOwed, vCycleStopSent, vStoppedActive, vStopFailUsed, vSawCommitted,
                         sessEndedBy, sessEndCount, sessTurn, sessTurnVisit, sessCommitted,
                         personEndUsed, wCutAfterDone, wStoppingMixed, wOwedCutAtRunEnd,
                         wCrossForkReplace, wStopCollision>>

\* 4. Session s of branch b dequeues its next prompt (turn admission: skips already-decided visits)
StartTurn(b, s) ==
    /\ sessState[b][s] = "live"
    /\ sessTurn[b][s] = "idle"
    /\ Len(sessQueue[b][s]) > 0
    /\ LET k == Head(sessQueue[b][s])
       IN /\ sessQueue' = [sessQueue EXCEPT ![b][s] = Tail(@)]
          /\ IF vState[b][k] = "pending"
             THEN /\ sessTurn' = [sessTurn EXCEPT ![b][s] = "running"]
                  /\ sessTurnVisit' = [sessTurnVisit EXCEPT ![b][s] = k]
                  /\ vSawCommitted' = [vSawCommitted EXCEPT ![b][k] = sessCommitted[b][s]]
             ELSE \* decidedAtAdmission fence: visit already decided, skip without running a turn
                  UNCHANGED <<sessTurn, sessTurnVisit, vSawCommitted>>
          /\ UNCHANGED <<runState, fork, nextFork, branchPhase, branchOrd, admitted, vState, vWinner,
                         vSess, vCycle, vSpawned, vEndSent, vStopOwed, vCycleStopSent, vStoppedActive,
                         vStopFailUsed, sessState, sessEndedBy, sessEndCount, sessCommitted,
                         personEndUsed, wCutAfterDone, wStoppingMixed, wOwedCutAtRunEnd,
                         wCrossForkReplace, wStopCollision>>

\* 5. Agent calls complete_workflow_node (completeAgentNode CAS): wins only if visit is still pending!
TurnReport(b, s) ==
    /\ sessState[b][s] = "live"
    /\ sessTurn[b][s] = "running"
    /\ LET k == sessTurnVisit[b][s]
       IN /\ k # NoVisit
          /\ IF vState[b][k] = "pending"
             THEN \* CAS wins: visit completed with winner="agent", tools close, reply turn continues (I1)
                  /\ vState' = [vState EXCEPT ![b][k] = "completed"]
                  /\ vWinner' = [vWinner EXCEPT ![b][k] = "agent"]
                  /\ sessTurn' = [sessTurn EXCEPT ![b][s] = "reporting"]
                  /\ branchPhase' = [branchPhase EXCEPT ![b] = IF fork = k[1] /\ @ = "in_agent" THEN "after_agent" ELSE @]
                  /\ UNCHANGED sessTurnVisit
             ELSE \* CAS lost (visit already cut or run-cancelled): no state change to visit; turn finishes/waits for Stop
                  /\ sessTurn' = [sessTurn EXCEPT ![b][s] = "idle"]
                  /\ sessTurnVisit' = [sessTurnVisit EXCEPT ![b][s] = NoVisit]
                  /\ UNCHANGED <<vState, vWinner, branchPhase>>
          /\ UNCHANGED <<runState, fork, nextFork, branchOrd, admitted, vSess, vCycle, vSpawned,
                         vEndSent, vStopOwed, vCycleStopSent, vStoppedActive, vStopFailUsed,
                         vSawCommitted, sessState, sessEndedBy, sessEndCount,
                         sessQueue, sessCommitted, personEndUsed, wCutAfterDone, wStoppingMixed,
                         wOwedCutAtRunEnd, wCrossForkReplace, wStopCollision>>

\* 6. Post-report reply finishes naturally and commits turn snapshot (memory) to session s (I1)
TurnFinish(b, s) ==
    /\ sessState[b][s] = "live"
    /\ sessTurn[b][s] = "reporting"
    /\ LET k == sessTurnVisit[b][s]
       IN /\ sessCommitted' = [sessCommitted EXCEPT ![b][s] = @ \cup {k}]
          /\ sessTurn' = [sessTurn EXCEPT ![b][s] = "idle"]
          /\ sessTurnVisit' = [sessTurnVisit EXCEPT ![b][s] = NoVisit]
          /\ UNCHANGED <<runState, fork, nextFork, branchPhase, branchOrd, admitted, vState, vWinner,
                         vSess, vCycle, vSpawned, vEndSent, vStopOwed, vCycleStopSent, vStoppedActive,
                         vStopFailUsed, vSawCommitted, sessState, sessEndedBy, sessEndCount, sessQueue,
                         personEndUsed, wCutAfterDone, wStoppingMixed, wOwedCutAtRunEnd,
                         wCrossForkReplace, wStopCollision>>

\* 7. endContinuedVisit for a completed visit k:
\*    - winner="agent" while runState="running": I1 sends NO Stop, marks AgentSessionContinues.
\*    - winner="cut"|"run_cancel"|"unavailable" OR runState # "running": sends fenced cycle Stop
\*      (may fail once when AllowStopFail, leaving vStopOwed = TRUE for retry or G2 or run-end).
EndVisit(b, k) ==
    /\ k \in admitted[b]
    /\ vState[b][k] = "completed"
    /\ ~vEndSent[b][k]
    /\ LET s == vSess[b][k]
           endKind == IF vWinner[b][k] = "agent" THEN "done" ELSE "cancel"
           turnEnds == (endKind = "cancel") \/ (runState # "running")
       IN IF ~turnEnds
          THEN \* I1: active run + agent completed -> NO Stop; session stays open, reply commits
               /\ vEndSent' = [vEndSent EXCEPT ![b][k] = TRUE]
               /\ vStopOwed' = [vStopOwed EXCEPT ![b][k] = FALSE]
               /\ UNCHANGED <<vCycleStopSent, vStoppedActive, vStopFailUsed, sessTurn, sessTurnVisit>>
          ELSE \* Needs cycle Stop (either succeeds or fails once if AllowStopFail)
               \/ \* Success: fenced Stop hits only a turn running THIS visit k
                  /\ vEndSent' = [vEndSent EXCEPT ![b][k] = TRUE]
                  /\ vStopOwed' = [vStopOwed EXCEPT ![b][k] = FALSE]
                  /\ vCycleStopSent' = [vCycleStopSent EXCEPT ![b][k] = TRUE]
                  /\ IF sessState[b][s] = "live" /\ sessTurn[b][s] # "idle" /\ sessTurnVisit[b][s] = k
                     THEN /\ sessTurn' = [sessTurn EXCEPT ![b][s] = "idle"]
                          /\ sessTurnVisit' = [sessTurnVisit EXCEPT ![b][s] = NoVisit]
                          /\ vStoppedActive' = [vStoppedActive EXCEPT ![b][k] = (@ \/ runState = "running")]
                     ELSE UNCHANGED <<sessTurn, sessTurnVisit, vStoppedActive>>
                  /\ UNCHANGED vStopFailUsed
               \/ \* Transient Stop failure (once per visit when AllowStopFail): Stop remains owed!
                  /\ AllowStopFail
                  /\ ~vStopFailUsed[b][k]
                  /\ vStopFailUsed' = [vStopFailUsed EXCEPT ![b][k] = TRUE]
                  /\ vStopOwed' = [vStopOwed EXCEPT ![b][k] = TRUE]
                  /\ UNCHANGED <<vEndSent, vCycleStopSent, vStoppedActive, sessTurn, sessTurnVisit>>
    /\ UNCHANGED <<runState, fork, nextFork, branchPhase, branchOrd, admitted, vState, vWinner,
                   vSess, vCycle, vSpawned, vSawCommitted, sessState, sessEndedBy, sessEndCount,
                   sessQueue, sessCommitted, personEndUsed, wCutAfterDone, wStoppingMixed,
                   wOwedCutAtRunEnd, wCrossForkReplace, wStopCollision>>

\* 8. Branch advances after agent visit reported: either loops back (idle) or completes branch (done)
BranchAdvance(b) ==
    /\ fork > 0
    /\ branchPhase[b] = "after_agent"
    /\ \/ (runState = "running" /\ branchOrd[b] < MaxBranchVisits /\ branchPhase' = [branchPhase EXCEPT ![b] = "idle"])
       \/ (branchPhase' = [branchPhase EXCEPT ![b] = "done"])
    /\ UNCHANGED <<runState, fork, nextFork, branchOrd, admitted, vState, vWinner, vSess, vCycle,
                   vSpawned, vEndSent, vStopOwed, vCycleStopSent, vStoppedActive, vStopFailUsed,
                   vSawCommitted, sessState, sessEndedBy, sessEndCount, sessTurn, sessTurnVisit,
                   sessQueue, sessCommitted, personEndUsed, wCutAfterDone, wStoppingMixed,
                   wOwedCutAtRunEnd, wCrossForkReplace, wStopCollision>>

\* 9. Branch cut (cancelBranches from failFast / join: { first: k } / parallel.timeoutSeconds)
\*    - If branch is in_agent with a pending visit k: cancels k (winner="cut"), EndVisit will Stop k.
\*    - If branch is after_agent (k already winner="agent", branch now in subsequent wait/script):
\*      marks branch cut WITHOUT touching k or stopping k's post-report reply turn!
BranchCut(b) ==
    /\ AllowCut
    /\ runState = "running"
    /\ fork > 0
    /\ branchPhase[b] \in {"in_agent", "after_agent"}
    /\ LET k == <<fork, branchOrd[b]>>
           s == vSess[b][k]
       IN /\ branchPhase' = [branchPhase EXCEPT ![b] = "cut"]
          /\ IF branchPhase[b] = "in_agent" /\ k \in admitted[b] /\ vState[b][k] = "pending"
             THEN /\ vState' = [vState EXCEPT ![b][k] = "completed"]
                  /\ vWinner' = [vWinner EXCEPT ![b][k] = "cut"]
                  /\ UNCHANGED wCutAfterDone
             ELSE \* Branch already moved past completed visit k; k's reply turn is untouched!
                  /\ wCutAfterDone' = (wCutAfterDone \/ (k \in admitted[b] /\ vWinner[b][k] = "agent"
                                                          /\ s > 0 /\ sessTurn[b][s] = "reporting"
                                                          /\ sessTurnVisit[b][s] = k))
                  /\ UNCHANGED <<vState, vWinner>>
    /\ UNCHANGED <<runState, fork, nextFork, branchOrd, admitted, vSess, vCycle, vSpawned, vEndSent,
                   vStopOwed, vCycleStopSent, vStoppedActive, vStopFailUsed, vSawCommitted,
                   sessState, sessEndedBy, sessEndCount, sessTurn, sessTurnVisit, sessQueue,
                   sessCommitted, personEndUsed, wStoppingMixed, wOwedCutAtRunEnd,
                   wCrossForkReplace, wStopCollision>>

\* 10. Parallel join completes once every branch is done or cut
JoinParallel ==
    /\ fork > 0
    /\ \A b \in Branches : branchPhase[b] \in {"done", "cut"}
    /\ fork' = 0
    /\ branchPhase' = [b \in Branches |-> "outside"]
    /\ branchOrd' = [b \in Branches |-> 0]
    /\ UNCHANGED <<runState, nextFork, admitted, vState, vWinner, vSess, vCycle, vSpawned, vEndSent,
                   vStopOwed, vCycleStopSent, vStoppedActive, vStopFailUsed, vSawCommitted,
                   sessState, sessEndedBy, sessEndCount, sessTurn, sessTurnVisit, sessQueue,
                   sessCommitted, personEndUsed, wCutAfterDone, wStoppingMixed, wOwedCutAtRunEnd,
                   wCrossForkReplace, wStopCollision>>

\* 11. Person ends a branch's idle continued session on its own (between visits or across forks)
PersonEndSession(b, s) ==
    /\ AllowPersonEnd
    /\ ~personEndUsed[b]
    /\ sessState[b][s] = "live"
    /\ sessTurn[b][s] = "idle"
    /\ ~SessionHasPending(b, s)
    /\ sessState' = [sessState EXCEPT ![b][s] = "ended"]
    /\ sessEndedBy' = [sessEndedBy EXCEPT ![b][s] = "person"]
    /\ personEndUsed' = [personEndUsed EXCEPT ![b] = TRUE]
    /\ UNCHANGED <<runState, fork, nextFork, branchPhase, branchOrd, admitted, vState, vWinner,
                   vSess, vCycle, vSpawned, vEndSent, vStopOwed, vCycleStopSent, vStoppedActive,
                   vStopFailUsed, vSawCommitted, sessEndCount, sessTurn, sessTurnVisit, sessQueue,
                   sessCommitted, wCutAfterDone, wStoppingMixed, wOwedCutAtRunEnd,
                   wCrossForkReplace, wStopCollision>>

\* 12. Graceful stop requested (run.stop != null): no new visits admitted; pending visits finish
RequestGracefulStop ==
    /\ AllowGracefulStop
    /\ runState = "running"
    /\ nextFork > 1   \* at least one parallel fork has been entered
    /\ runState' = "stopping"
    /\ UNCHANGED <<fork, nextFork, branchPhase, branchOrd, admitted, vState, vWinner, vSess, vCycle,
                   vSpawned, vEndSent, vStopOwed, vCycleStopSent, vStoppedActive, vStopFailUsed,
                   vSawCommitted, sessState, sessEndedBy, sessEndCount, sessTurn, sessTurnVisit,
                   sessQueue, sessCommitted, personEndUsed, wCutAfterDone, wStoppingMixed,
                   wOwedCutAtRunEnd, wCrossForkReplace, wStopCollision>>

\* 13. Run completes normally (outside parallel after at least one fork) or finishes graceful stop
FinishRun ==
    \/ /\ runState = "running"
       /\ fork = 0
       /\ nextFork > 1
       /\ runState' = "completed"
       /\ wOwedCutAtRunEnd' = (wOwedCutAtRunEnd \/ (\E b \in Branches : \E k \in admitted[b] : vWinner[b][k] = "cut" /\ vStopOwed[b][k]))
       /\ UNCHANGED <<branchPhase, vState, vWinner>>
    \/ /\ runState = "stopping"
       /\ ~AnyPending
       /\ runState' = "stopped"
       /\ wOwedCutAtRunEnd' = (wOwedCutAtRunEnd \/ (\E b \in Branches : \E k \in admitted[b] : vWinner[b][k] = "cut" /\ vStopOwed[b][k]))
       /\ UNCHANGED <<branchPhase, vState, vWinner>>
    \/ /\ AllowRunCancel
       /\ runState \in {"running", "stopping"}
       /\ nextFork > 1
       /\ runState' = "cancelled"
       /\ vState' = [b \in Branches |-> [k \in VisitKeys |-> IF k \in admitted[b] /\ vState[b][k] = "pending" THEN "completed" ELSE vState[b][k]]]
       /\ vWinner' = [b \in Branches |-> [k \in VisitKeys |-> IF k \in admitted[b] /\ vState[b][k] = "pending" THEN "run_cancel" ELSE vWinner[b][k]]]
       /\ branchPhase' = [b \in Branches |-> IF branchPhase[b] \in {"idle", "in_agent", "after_agent"} THEN "cut" ELSE branchPhase[b]]
       /\ wOwedCutAtRunEnd' = (wOwedCutAtRunEnd \/ (\E b \in Branches : \E k \in admitted[b] : vWinner[b][k] = "cut" /\ vStopOwed[b][k]))
    /\ UNCHANGED <<fork, nextFork, branchOrd, admitted, vSess, vCycle, vSpawned, vEndSent, vStopOwed,
                   vCycleStopSent, vStoppedActive, vStopFailUsed, vSawCommitted, sessState,
                   sessEndedBy, sessEndCount, sessTurn, sessTurnVisit, sessQueue, sessCommitted,
                   personEndUsed, wCutAfterDone, wStoppingMixed, wCrossForkReplace, wStopCollision>>

\* 14. endWorkflowContinuedSessions -> endContinuedSessionLocked for branch b, session s:
\*     Reads readAgentInvocationByChild(s) via StoreMax(VisitsOfSession(b, s)).
\*     If newest visit's state = "completed", sends unfenced workflow-session-stop:s and ends s.
\*     If FailEndBranch = b, that branch's end fails (must not block ending other branches!).
EndBranchSession(b, s) ==
    /\ runState \in ({"stopping"} \cup TerminalRunStates)
    /\ sessState[b][s] = "live"
    /\ b # FailEndBranch
    /\ LET vs == VisitsOfSession(b, s)
       IN /\ vs # {}
          /\ LET last == StoreMax(vs)
             IN /\ vState[b][last] = "completed"
                /\ sessState' = [sessState EXCEPT ![b][s] = "ended"]
                /\ sessEndedBy' = [sessEndedBy EXCEPT ![b][s] = "workflow"]
                /\ sessEndCount' = [sessEndCount EXCEPT ![b][s] = @ + 1]
                /\ sessTurn' = [sessTurn EXCEPT ![b][s] = "idle"]
                /\ sessTurnVisit' = [sessTurnVisit EXCEPT ![b][s] = NoVisit]
                \* Session-level Stop supersedes any owed cycle Stop on visits of s
                /\ vStopOwed' = [vStopOwed EXCEPT ![b] = [k \in VisitKeys |-> IF k \in vs THEN FALSE ELSE @[k]]]
                /\ wStoppingMixed' = (wStoppingMixed \/ (runState = "stopping" /\ \E other \in Branches : other # b /\ \E ok \in admitted[other] : vState[other][ok] = "pending"))
    /\ UNCHANGED <<runState, fork, nextFork, branchPhase, branchOrd, admitted, vState, vWinner,
                   vSess, vCycle, vSpawned, vEndSent, vCycleStopSent, vStoppedActive, vStopFailUsed,
                   vSawCommitted, sessQueue, sessCommitted, personEndUsed, wCutAfterDone,
                   wOwedCutAtRunEnd, wCrossForkReplace, wStopCollision>>

\* Stutter step once run is terminal and all non-failing sessions are ended (prevents spurious deadlock)
Quiescent ==
    /\ runState \in TerminalRunStates
    /\ \A b \in Branches : \A s \in SessIds : (b = FailEndBranch \/ sessState[b][s] # "live")
    /\ \A b \in Branches : \A k \in admitted[b] : vState[b][k] = "completed"
    /\ UNCHANGED vars

Next ==
    \/ EnterParallel
    \/ \E b \in Branches : AdmitVisit(b)
    \/ \E b \in Branches, k \in VisitKeys : SpawnVisit(b, k)
    \/ \E b \in Branches, s \in SessIds : StartTurn(b, s)
    \/ \E b \in Branches, s \in SessIds : TurnReport(b, s)
    \/ \E b \in Branches, s \in SessIds : TurnFinish(b, s)
    \/ \E b \in Branches, k \in VisitKeys : EndVisit(b, k)
    \/ \E b \in Branches : BranchAdvance(b)
    \/ \E b \in Branches : BranchCut(b)
    \/ JoinParallel
    \/ \E b \in Branches, s \in SessIds : PersonEndSession(b, s)
    \/ RequestGracefulStop
    \/ FinishRun
    \/ \E b \in Branches, s \in SessIds : EndBranchSession(b, s)
    \/ Quiescent

Spec == Init /\ [][Next]_vars

\* Fairness for liveness: turns complete/report, owed ends retry, joins complete, run-end closes sessions
Fairness ==
    /\ \A b \in Branches, k \in VisitKeys : WF_vars(SpawnVisit(b, k))
    /\ \A b \in Branches, s \in SessIds : WF_vars(StartTurn(b, s))
    /\ \A b \in Branches, s \in SessIds : WF_vars(TurnReport(b, s))
    /\ \A b \in Branches, s \in SessIds : WF_vars(TurnFinish(b, s))
    /\ \A b \in Branches, k \in VisitKeys : WF_vars(EndVisit(b, k))
    /\ \A b \in Branches : WF_vars(BranchAdvance(b))
    /\ WF_vars(JoinParallel)
    /\ WF_vars(FinishRun)
    /\ \A b \in Branches, s \in SessIds : WF_vars(EndBranchSession(b, s))

LiveSpec == Spec /\ Fairness

(***************************************************************************)
(* Safety Invariants                                                       *)
(***************************************************************************)

TypeOK ==
    /\ runState \in {"running", "stopping", "completed", "cancelled", "stopped"}
    /\ fork \in 0..MaxForks
    /\ nextFork \in 1..(MaxForks + 1)
    /\ \A b \in Branches :
        /\ branchPhase[b] \in {"outside", "idle", "in_agent", "after_agent", "done", "cut"}
        /\ branchOrd[b] \in 0..MaxBranchVisits
        /\ admitted[b] \subseteq VisitKeys
        /\ \A k \in VisitKeys :
            /\ vState[b][k] \in {"none", "pending", "completed"}
            /\ vWinner[b][k] \in {"none", "agent", "cut", "run_cancel", "unavailable"}
            /\ vSess[b][k] \in 0..MaxSess
            /\ vCycle[b][k] \in 0..MaxSess
        /\ \A s \in SessIds :
            /\ sessState[b][s] \in {"uncreated", "live", "ended"}
            /\ sessEndedBy[b][s] \in {"none", "person", "workflow"}
            /\ sessEndCount[b][s] \in 0..2
            /\ sessTurn[b][s] \in {"idle", "running", "reporting"}
            /\ sessTurnVisit[b][s] \in (VisitKeys \cup {NoVisit})

\* Concurrent named-branch isolation: at most one live session per branch, each ended at most once,
\* and no turn or Stop crosses branch boundaries.
Inv_BranchIsolation ==
    /\ ~wStopCollision
    /\ \A b \in Branches :
        /\ Cardinality({ s \in SessIds : sessState[b][s] = "live" }) <= 1
        /\ \A s \in SessIds :
            /\ sessEndCount[b][s] <= 1
            /\ (sessTurnVisit[b][s] # NoVisit => sessTurnVisit[b][s] \in admitted[b] /\ vSess[b][sessTurnVisit[b][s]] = s)

\* A visit cut while pending never settles as AgentSessionContinues without a cycle Stop sent.
Inv_CutPendingStopsVisit ==
    \A b \in Branches : \A k \in admitted[b] :
        (vWinner[b][k] = "cut" /\ vEndSent[b][k]) => vCycleStopSent[b][k]

\* I1 preserved in named branches: while run is active, no Stop hits a completed ("agent") visit's reply turn.
Inv_NoStopOnActiveDone ==
    \A b \in Branches : \A k \in admitted[b] :
        vWinner[b][k] = "agent" => ~vStoppedActive[b][k]

\* G2 preserved: no later visit of (b, s) is spawned while an earlier completed visit of (b, s) still owes its end/Stop.
Inv_NoPromptBehindStaleTurn ==
    \A b \in Branches : \A k \in admitted[b] :
        vSpawned[b][k] =>
            \A e \in VisitsOfSession(b, vSess[b][k]) :
                (e # k /\ TrueLt(e, k) /\ vWinner[b][e] \in {"cut", "run_cancel"}) => vEndSent[b][e]

\* Composite (p.ordinal, n.ordinal) ordering: cycle numbers are strictly monotonic in true chronological order,
\* including when fork 2 resets n.ordinal to 1!
Inv_MonotonicCycleOrder ==
    \A b \in Branches : \A k1, k2 \in admitted[b] :
        TrueLt(k1, k2) => vCycle[b][k1] < vCycle[b][k2]

\* Q5 preserved across outer-loop re-entry and mixed branches: while stopping, never end a session with a pending visit!
Inv_StoppingKeepsActiveVisit ==
    \A b \in Branches : \A s \in SessIds :
        (runState = "stopping" /\ SessionHasPending(b, s)) => sessEndedBy[b][s] # "workflow"

\* Cross-fork replacement distinctness: once a session is ended, no later admitted visit reuses an ended session's ID
\* as a "new" replacement (distinct IDs per replacement episode).
Inv_ReplacementDistinct ==
    \A b \in Branches : \A k1, k2 \in admitted[b] :
        (TrueLt(k1, k2) /\ vSess[b][k1] = vSess[b][k2]) =>
            \A m \in admitted[b] :
                (TrueLt(k1, m) /\ TrueLt(m, k2)) => vSess[b][m] = vSess[b][k1]

(***************************************************************************)
(* Temporal Liveness Properties                                            *)
(***************************************************************************)

\* Once the run reaches a terminal state, every non-failing branch's sessions are ended and idle,
\* and no cycle Stop remains owed (including when a cut's Stop failed and the run ended with no re-entry!).
Prop_AllEnded ==
    [](runState \in TerminalRunStates =>
        <>(\A b \in Branches : b = FailEndBranch \/
            ((\A s \in SessIds : sessState[b][s] # "live" /\ sessTurn[b][s] = "idle")
             /\ (\A k \in admitted[b] : ~vStopOwed[b][k]))))

\* Branch isolation on failing end: even when FailEndBranch = "A", branch "B" still ends cleanly!
Prop_OtherBranchEnded ==
    [](runState \in TerminalRunStates =>
        <>(\A b \in Branches : b = FailEndBranch \/
            \A s \in SessIds : sessState[b][s] # "live" /\ sessTurn[b][s] = "idle"))

(***************************************************************************)
(* Non-Vacuity Witnesses (negated canaries: TLC must find a counterexample)*)
(***************************************************************************)

\* 1. Intra-branch loop commits visit 1's memory (no Stop) and visit 2 runs seeing visit 1 committed
W_BranchLoopCommitRecall ==
    ~(\E b \in Branches : \E k1, k2 \in admitted[b] :
        k1[1] = k2[1] /\ k1[2] < k2[2] /\ vSess[b][k1] = vSess[b][k2]
        /\ k1 \in vSawCommitted[b][k2] /\ ~vStoppedActive[b][k1])

\* 2. Pending visit cut by failFast/join/timeout gets a cycle Stop
W_CutPendingStopsVisit ==
    ~(\E b \in Branches : \E k \in admitted[b] :
        vWinner[b][k] = "cut" /\ vCycleStopSent[b][k] /\ vEndSent[b][k])

\* 3. Branch cut after visit already reported ("agent") lets reply finish and commit memory without Stop
W_CutAfterDoneKeepsReply ==
    ~(wCutAfterDone /\ \E b \in Branches : \E k \in admitted[b] :
        vWinner[b][k] = "agent" /\ k \in sessCommitted[b][vSess[b][k]] /\ ~vStoppedActive[b][k])

\* 4. Outer-loop parallel re-entry: fork 1 runs 2 visits, fork 2 visit 1 runs as cycle 3 recalling fork 1 memory
W_OuterForkReentry ==
    ~(\E b \in Branches :
        <<1, 1>> \in admitted[b] /\ <<1, 2>> \in admitted[b] /\ <<2, 1>> \in admitted[b]
        /\ vSess[b][<<1, 1>>] = vSess[b][<<2, 1>>]
        /\ vCycle[b][<<2, 1>>] = 3
        /\ <<1, 2>> \in vSawCommitted[b][<<2, 1>>])

\* 5. Cross-fork session replacement: session ends in fork 1, fork 2 allocates distinct replacement session
W_CrossForkReplacement ==
    ~(wCrossForkReplace /\ \E b \in Branches :
        <<2, 1>> \in admitted[b] /\ vSess[b][<<2, 1>>] > 1 /\ vSpawned[b][<<2, 1>>])

\* 6. Graceful stop with mixed branch states: idle branch session ended while sibling branch visit still pending
W_StoppingMixedBranches == ~wStoppingMixed

\* 7. Cut visit with failed Stop (owed) followed by run end resolving it via session end
W_OwedCutThenRunEnd ==
    ~(wOwedCutAtRunEnd /\ runState \in TerminalRunStates
      /\ \A b \in Branches : \A s \in SessIds : sessState[b][s] # "live" /\ sessTurn[b][s] = "idle")

=============================================================================
