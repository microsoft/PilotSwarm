------------------------------- MODULE WorkflowV2Run -------------------------------
(***************************************************************************)
(* One workflow v2 run as implemented in packages/sdk/src/workflow/v2:      *)
(* the controller orchestration (runtime.ts controlRun), one effect         *)
(* orchestration per script node execution (runtime.ts workflowV2Effect),   *)
(* the PostgreSQL store transitions (store.ts) and deletion of the          *)
(* workflow session (cms_soft_delete_session plus the 0085 trigger).        *)
(* README.md maps every action to its code and transaction boundary.       *)
(*                                                                          *)
(* Graph: script state S routes "again" to S (at most MaxLoops times) and   *)
(* "ok" to terminal T. "error" has no route: the run fails, or, with        *)
(* CatchAll, goes once to the catch-all script state H ("ok" to T; an       *)
(* unhandled "error" there fails the run).                                  *)
(*                                                                          *)
(* An activity that writes the store is split into Exec (the store          *)
(* transaction, which may run again after a crash) and Record (its result   *)
(* enters the orchestration history). Replay re-reads recorded results, so  *)
(* the controller variables below are exactly its history state.           *)
(*                                                                          *)
(* Fix switches select the code revision: all FALSE is reviewed commit      *)
(* 63c8013b; all TRUE is the hardened commit named in README.md.           *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    MaxLoops,             \* bound on "again" re-entries of S
    LoseWake,             \* fault: a wake activity exhausts its retries
    ControllerFaults,     \* fault: a controller activity exhausts its retries
    EffectFaults,         \* fault: an effect crashes (script re-runs) or dies
    Backstop,             \* fix: the controller re-collects on a durable timer
    CancelStopFromStore,  \* fix: cancel stops every cancel-won effect, from the store
    DeleteGuard,          \* fix: deletion trigger, session-locked writes, entry claim, liveness stop
    EntryFence,           \* fix: the script process starts inside the entry transaction
    EndPending,           \* fix: every run end completes its pending node executions
    EffectWatch,          \* fix: collection fails a pending node whose effect ended
    CommandPoll,          \* fix: the controller reads queued commands before every admission
    Recovery,             \* fix: an explicit recover ends a run whose controller ended without ending it
    CatchAll,             \* feature: the workflow declares a catch-all state H
    ControllerDeath,      \* fault: the controller ends without ending its run
    Deletes,              \* environment: the workflow session may be deleted
    NoCas                 \* deliberate fault: node completion is not a compare-and-swap

ASSUME MaxLoops \in Nat
ASSUME {LoseWake, ControllerFaults, EffectFaults, Backstop, CancelStopFromStore,
        DeleteGuard, EntryFence, EndPending, EffectWatch, CommandPoll, Recovery,
        CatchAll, ControllerDeath, Deletes, NoCas} \subseteq BOOLEAN

SOrd == 1..(MaxLoops + 1)
HNode == <<"H", 1>>
SNodes == {<<"S", i>> : i \in SOrd} \cup (IF CatchAll THEN {HNode} ELSE {})
TNode == <<"T", 1>>
NoNode == <<"none", 0>>
NX == SNodes \cup {TNode}
Active == {"admitted", "running"}
Terminal == {"completed", "failed", "cancelled"}
ScriptOutcomes(i) == {"ok", "error"} \cup (IF i <= MaxLoops THEN {"again"} ELSE {})
NodeOutcomes(x) == IF x = HNode THEN {"ok", "error"} ELSE ScriptOutcomes(x[2])
EffectEnded == {"done", "stopped", "failed"}

VARIABLES
    runStatus,   \* workflow_runs.status
    nState,      \* workflow_node_executions.state; "absent" means no row
    nWinner,     \* workflow_node_executions.winner
    nOutcome,    \* workflow_node_executions.outcome
    events,      \* transcript events written by store projections
    sessionLive, \* sessions.deleted_at IS NULL
    defDeleted,  \* workflow_definitions.state = 'deleted'
    pc,          \* controller position
    cur,         \* controller cursor
    actRes,      \* result of the latest execution of the current activity
    cancelStep,  \* step of the cancel activity body
    cancelIds,   \* node executions this cancel execution completed
    eff,         \* effect orchestration state per script node execution
    effRes,      \* script result recorded in the effect history
    stopReq,     \* a stop request was sent to the effect
    wakeDup,     \* duplicate wakes sent by an effect (bounded)
    q,           \* the controller "messages" queue
    cancelSent,  \* the parent sent its cancel command
    deleteSent,  \* someone deleted the workflow session
    notified     \* parent notification executions (bounded)

storeVars == <<runStatus, nState, nWinner, nOutcome, events, sessionLive, defDeleted>>
nodeVars == <<nState, nWinner, nOutcome>>
ctrlVars == <<pc, cur, actRes, cancelStep, cancelIds>>
effVars == <<eff, effRes, stopReq, wakeDup>>
envVars == <<q, cancelSent, deleteSent, notified>>
vars == <<storeVars, ctrlVars, effVars, envVars>>

CurX == IF cur.node = "S" THEN <<"S", cur.ord>> ELSE IF cur.node = "H" THEN HNode ELSE TNode

(* Where the controller goes before it admits the next state.              *)
NextAdmit == IF CommandPoll THEN "poll" ELSE "admit"

(* A store transition the hardened code makes under the session row lock.  *)
Writable == sessionLive \/ ~DeleteGuard

(* An entry transaction that has started its script and not yet committed   *)
(* holds the session row lock (store.enterScript); every other transaction  *)
(* that locks the session row waits for it.                                 *)
NoEntryInFlight == \A x \in SNodes : eff[x] # "spawned"

(* Complete every pending node execution in the same store transaction.     *)
EndPendingNodes(winner) ==
    /\ nState' = [x \in NX |-> IF nState[x] = "pending" THEN "completed" ELSE nState[x]]
    /\ nWinner' = [x \in NX |-> IF nState[x] = "pending" THEN winner ELSE nWinner[x]]
    /\ nOutcome' = [x \in NX |-> IF nState[x] = "pending" THEN "cancelled" ELSE nOutcome[x]]

TypeOK ==
    /\ runStatus \in Active \cup Terminal
    /\ nState \in [NX -> {"absent", "pending", "completed"}]
    /\ nWinner \in [NX -> {"none", "effect", "cancel", "controller", "delete"}]
    /\ nOutcome \in [NX -> {"none", "again", "ok", "error", "cancelled", "succeeded"}]
    /\ sessionLive \in BOOLEAN
    /\ defDeleted \in BOOLEAN
    /\ pc \in {"undispatched", "begin", "poll", "admit", "start", "collect", "wait", "finish", "finishFail", "dead",
               "notify", "cancel", "done"}
    /\ cur.node \in {"S", "H", "T"}
    /\ cur.caught \in BOOLEAN
    /\ cur.ord \in SOrd
    /\ cur.pending \in NX \cup {NoNode}
    /\ cancelStep \in {"tx", "stop", "rec", "txRetry", "stopRetry", "recRetry"}
    /\ cancelIds \subseteq NX
    /\ eff \in [SNodes -> {"absent", "started", "claimed", "spawned", "running", "ran", "recorded", "done", "stopped", "failed"}]
    /\ effRes \in [SNodes -> {"none", "again", "ok", "error", "skip"}]
    /\ stopReq \in [SNodes -> BOOLEAN]
    /\ wakeDup \in [SNodes -> 0..1]
    /\ q \in Seq({"wake", "cancel"})
    /\ cancelSent \in BOOLEAN
    /\ deleteSent \in BOOLEAN
    /\ notified \in 0..2

Init ==
    /\ runStatus = "admitted"
    /\ nState = [x \in NX |-> "absent"]
    /\ nWinner = [x \in NX |-> "none"]
    /\ nOutcome = [x \in NX |-> "none"]
    /\ events = [started |-> 0, ended |-> 0,
                 stateStarted |-> [x \in NX |-> 0],
                 stateCompleted |-> [x \in SNodes |-> 0]]
    /\ sessionLive = TRUE
    /\ defDeleted = FALSE
    /\ pc = "undispatched"
    /\ cur = [node |-> "S", ord |-> 1, pending |-> NoNode, caught |-> FALSE]
    /\ actRes = "none"
    /\ cancelStep = "tx"
    /\ cancelIds = {}
    /\ eff = [x \in SNodes |-> "absent"]
    /\ effRes = [x \in SNodes |-> "none"]
    /\ stopReq = [x \in SNodes |-> FALSE]
    /\ wakeDup = [x \in SNodes |-> 0]
    /\ q = <<>>
    /\ cancelSent = FALSE
    /\ deleteSent = FALSE
    /\ notified = 0

-----------------------------------------------------------------------------
(* Admission committed the run; dispatch starts the controller afterwards.  *)
(* A deletion may commit in between (service.ts dispatchWorkflowV2Run).     *)

Dispatch ==
    /\ pc = "undispatched"
    /\ pc' = "begin"
    /\ UNCHANGED <<storeVars, cur, actRes, cancelStep, cancelIds, effVars, envVars>>

(* Controller: begin activity, store.beginRun                               *)

BeginExec ==
    /\ pc = "begin"
    /\ IF runStatus = "admitted" /\ Writable
         THEN /\ runStatus' = "running"
              /\ events' = [events EXCEPT !.started = @ + 1]
         ELSE UNCHANGED <<runStatus, events>>
    /\ actRes' = IF runStatus = "admitted" /\ Writable THEN "running" ELSE runStatus
    /\ UNCHANGED <<nodeVars, sessionLive, defDeleted, pc, cur, cancelStep, cancelIds, effVars, envVars>>

BeginRecord ==
    /\ pc = "begin"
    /\ actRes # "none"
    /\ pc' = IF actRes \in Active THEN NextAdmit ELSE "done"
    /\ actRes' = "none"
    /\ UNCHANGED <<storeVars, cur, cancelStep, cancelIds, effVars, envVars>>

(* Controller: enter activity, store.enterNode (idempotent by node id)      *)

AdmitExec ==
    /\ pc = "admit"
    /\ LET x == CurX IN
         IF nState[x] = "absent"
           THEN IF runStatus \in Active /\ Writable
                  THEN /\ nState' = [nState EXCEPT ![x] = "pending"]
                       /\ events' = [events EXCEPT !.stateStarted[x] = @ + 1]
                       /\ actRes' = "pending"
                  ELSE /\ actRes' = "notAdmitted"
                       /\ UNCHANGED <<nState, events>>
           ELSE /\ actRes' = nState[x]
                /\ UNCHANGED <<nState, events>>
    /\ UNCHANGED <<runStatus, nWinner, nOutcome, sessionLive, defDeleted, pc, cur, cancelStep, cancelIds, effVars, envVars>>

AdmitRecord ==
    /\ pc = "admit"
    /\ actRes # "none"
    /\ IF actRes = "notAdmitted"
         THEN /\ pc' = "done"
              /\ cur' = cur
         ELSE IF cur.node = "T"
                THEN /\ pc' = "finish"
                     /\ cur' = cur
                ELSE /\ pc' = IF actRes = "pending" THEN "start" ELSE "collect"
                     /\ cur' = [cur EXCEPT !.pending = CurX]
    /\ actRes' = "none"
    /\ UNCHANGED <<storeVars, cancelStep, cancelIds, effVars, envVars>>

(* Controller: ctx.startOrchestrationVersioned (idempotent effect id)       *)

StartEffect ==
    /\ pc = "start"
    /\ eff' = [eff EXCEPT ![cur.pending] = IF @ = "absent" THEN "started" ELSE @]
    /\ pc' = "collect"
    /\ UNCHANGED <<storeVars, cur, actRes, cancelStep, cancelIds, effRes, stopReq, wakeDup, envVars>>

(* Controller: collect activity. Reads stored results of the pending id;    *)
(* with EffectWatch it fails a pending node whose effect has ended.         *)

CollectExec ==
    /\ pc = "collect"
    /\ NoEntryInFlight
    /\ LET x == cur.pending IN
         IF nState[x] = "completed"
           THEN /\ actRes' = nOutcome[x]
                /\ UNCHANGED storeVars
           ELSE IF EffectWatch /\ x \in SNodes /\ eff[x] \in EffectEnded /\ Writable
                  THEN /\ nState' = [nState EXCEPT ![x] = "completed"]
                       /\ nWinner' = [nWinner EXCEPT ![x] = "controller"]
                       /\ nOutcome' = [nOutcome EXCEPT ![x] = "error"]
                       /\ actRes' = "error"
                       /\ UNCHANGED <<runStatus, events, sessionLive, defDeleted>>
                  ELSE /\ actRes' = "nothing"
                       /\ UNCHANGED storeVars
    /\ UNCHANGED <<pc, cur, cancelStep, cancelIds, effVars, envVars>>

CollectRecord ==
    /\ pc = "collect"
    /\ actRes # "none"
    /\ CASE actRes = "nothing" -> (pc' = "wait" /\ cur' = cur)
         [] actRes = "again" -> (pc' = NextAdmit /\ cur' = [cur EXCEPT !.node = "S", !.ord = cur.ord + 1, !.pending = NoNode])
         [] actRes = "ok" -> (pc' = NextAdmit /\ cur' = [cur EXCEPT !.node = "T", !.pending = NoNode])
         [] actRes = "error" /\ CatchAll /\ ~cur.caught ->
                (pc' = NextAdmit /\ cur' = [cur EXCEPT !.node = "H", !.pending = NoNode, !.caught = TRUE])
         [] OTHER -> (pc' = "finishFail" /\ cur' = cur)
    /\ actRes' = "none"
    /\ UNCHANGED <<storeVars, cancelStep, cancelIds, effVars, envVars>>

(* Controller: before each admission, read every queued message without   *)
(* waiting (takeQueuedCommand). A cancel ends the run; a wake is dropped.  *)
PollCommand ==
    /\ pc = "poll"
    /\ IF q = <<>>
         THEN /\ pc' = "admit"
              /\ q' = q
         ELSE /\ pc' = IF Head(q) = "cancel" THEN "cancel" ELSE "poll"
              /\ q' = Tail(q)
    /\ UNCHANGED <<storeVars, cur, actRes, cancelStep, cancelIds, effVars, cancelSent, deleteSent, notified>>

(* Controller: race(dequeueEvent("messages"), timer). A queued message wins. *)

WaitMsg ==
    /\ pc = "wait"
    /\ q # <<>>
    /\ pc' = IF Head(q) = "cancel" THEN "cancel" ELSE "collect"
    /\ q' = Tail(q)
    /\ UNCHANGED <<storeVars, cur, actRes, cancelStep, cancelIds, effVars, cancelSent, deleteSent, notified>>

WaitTimer ==
    /\ Backstop
    /\ pc = "wait"
    /\ q = <<>>
    /\ pc' = "collect"
    /\ UNCHANGED <<storeVars, cur, actRes, cancelStep, cancelIds, effVars, envVars>>

(* Controller: finish activity, store.finishRun (terminal or failure)       *)

FinishExec ==
    /\ pc = "finish"
    /\ NoEntryInFlight
    /\ IF runStatus \in Active /\ Writable
         THEN /\ runStatus' = "completed"
              /\ nState' = [x \in NX |-> IF x = TNode \/ (EndPending /\ nState[x] = "pending") THEN "completed" ELSE nState[x]]
              /\ nWinner' = [x \in NX |-> IF x = TNode \/ (EndPending /\ nState[x] = "pending") THEN "controller" ELSE nWinner[x]]
              /\ nOutcome' = [x \in NX |-> IF x = TNode THEN "succeeded"
                                           ELSE IF EndPending /\ nState[x] = "pending" THEN "cancelled" ELSE nOutcome[x]]
              /\ events' = [events EXCEPT !.ended = @ + 1]
              /\ UNCHANGED <<sessionLive, defDeleted>>
         ELSE UNCHANGED storeVars
    /\ actRes' = "ended"
    /\ UNCHANGED <<pc, cur, cancelStep, cancelIds, effVars, envVars>>

FinishFailExec ==
    /\ pc = "finishFail"
    /\ NoEntryInFlight
    /\ IF runStatus \in Active /\ Writable
         THEN /\ runStatus' = "failed"
              /\ events' = [events EXCEPT !.ended = @ + 1]
              /\ IF EndPending THEN EndPendingNodes("controller") ELSE UNCHANGED nodeVars
              /\ UNCHANGED <<sessionLive, defDeleted>>
         ELSE UNCHANGED storeVars
    /\ actRes' = "ended"
    /\ UNCHANGED <<pc, cur, cancelStep, cancelIds, effVars, envVars>>

FinishRecord ==
    /\ pc \in {"finish", "finishFail"}
    /\ actRes # "none"
    /\ pc' = "notify"
    /\ actRes' = "none"
    /\ UNCHANGED <<storeVars, cur, cancelStep, cancelIds, effVars, envVars>>

(* Controller: notifyParent activity (at-least-once, stable client id)      *)

NotifyExec ==
    /\ pc = "notify"
    /\ notified < 2
    /\ notified' = notified + 1
    /\ actRes' = "sent"
    /\ UNCHANGED <<storeVars, pc, cur, cancelStep, cancelIds, effVars, q, cancelSent, deleteSent>>

NotifyRecord ==
    /\ pc = "notify"
    /\ actRes # "none"
    /\ pc' = "done"
    /\ actRes' = "none"
    /\ UNCHANGED <<storeVars, cur, cancelStep, cancelIds, effVars, envVars>>

(* Controller: cancel activity. Its body is not one transaction: the store  *)
(* commit (CancelTx) precedes the stop requests (CancelStop), and a crash   *)
(* (CancelCrash) re-executes the body from its start. The code retries the  *)
(* activity a bounded number of times; here one crash may occur ("...Retry" *)
(* steps), and running out of attempts is ControllerFault. A stop request   *)
(* is only a request: the effect acknowledges it later (EffStopRequested).  *)

CancelTx ==
    /\ pc = "cancel"
    /\ cancelStep \in {"tx", "txRetry"}
    /\ NoEntryInFlight
    /\ LET pend == {x \in NX : nState[x] = "pending"} IN
         IF runStatus \in Active /\ Writable
           THEN /\ runStatus' = "cancelled"
                /\ EndPendingNodes("cancel")
                /\ events' = [events EXCEPT !.ended = @ + 1]
                /\ UNCHANGED <<sessionLive, defDeleted>>
                /\ cancelIds' = pend
           ELSE /\ UNCHANGED storeVars
                /\ cancelIds' = {}
    /\ cancelStep' = IF cancelStep = "tx" THEN "stop" ELSE "stopRetry"
    /\ UNCHANGED <<pc, cur, actRes, effVars, envVars>>

CancelStop ==
    /\ pc = "cancel"
    /\ cancelStep \in {"stop", "stopRetry"}
    /\ LET ids == IF CancelStopFromStore
                    THEN {x \in SNodes : nWinner[x] = "cancel"}
                    ELSE cancelIds \cap SNodes
       IN stopReq' = [x \in SNodes |-> stopReq[x] \/ (x \in ids /\ eff[x] \notin {"absent"} \cup EffectEnded)]
    /\ cancelStep' = IF cancelStep = "stop" THEN "rec" ELSE "recRetry"
    /\ UNCHANGED <<storeVars, pc, cur, actRes, cancelIds, eff, effRes, wakeDup, envVars>>

CancelCrash ==
    /\ pc = "cancel"
    /\ cancelStep \in {"stop", "rec"}
    /\ cancelStep' = "txRetry"
    /\ UNCHANGED <<storeVars, pc, cur, actRes, cancelIds, effVars, envVars>>

CancelRecord ==
    /\ pc = "cancel"
    /\ cancelStep \in {"rec", "recRetry"}
    /\ pc' = "notify"
    /\ cancelStep' = "tx"
    /\ UNCHANGED <<storeVars, cur, actRes, cancelIds, effVars, envVars>>

(* A controller activity exhausts its retries: controlRun throws, and the   *)
(* catch in workflowV2Controller ends the run through the failure finish.   *)
ControllerFault ==
    /\ ControllerFaults
    /\ pc \in {"begin", "poll", "admit", "start", "collect", "wait", "cancel"}
    /\ pc' = "finishFail"
    /\ actRes' = "none"
    /\ cancelStep' = "tx"
    /\ UNCHANGED <<storeVars, cur, cancelIds, effVars, envVars>>

(* The controller orchestration ends without ending its run: it was        *)
(* terminated, or its finalization retries ran out.                         *)
ControllerDie ==
    /\ ControllerDeath
    /\ pc \notin {"undispatched", "done", "dead"}
    /\ pc' = "dead"
    /\ UNCHANGED <<storeVars, cur, actRes, cancelStep, cancelIds, effVars, envVars>>

(* The parent's explicit recover (update_workflow operation recover,        *)
(* recoverWorkflowV2Run) ends a run whose controller ended, in one store    *)
(* transaction with its pending nodes. Nothing does this without that       *)
(* request; its weak fairness is the assumption that the parent eventually  *)
(* recovers a run that read_workflow shows as needing it.                   *)
Recover ==
    /\ Recovery
    /\ pc = "dead"
    /\ runStatus \in Active
    /\ Writable
    /\ NoEntryInFlight
    /\ runStatus' = "failed"
    /\ EndPendingNodes("controller")
    /\ events' = [events EXCEPT !.ended = @ + 1]
    /\ UNCHANGED <<sessionLive, defDeleted, ctrlVars, effVars, envVars>>

-----------------------------------------------------------------------------
(* Effect orchestration per script node execution x                        *)

(* runScript activity entry. Reviewed code: skip only a completed node.     *)
(* DeleteGuard: the entry checks the node, run and session under the        *)
(* session, run and node locks. EntryFence: the script process starts in    *)
(* that same transaction (store.enterScript), before it commits: "spawned"  *)
(* holds the session row lock until EffCommit or EffCommitFail. Without it  *)
(* the entry commits first and the process starts later (EffLaunch),        *)
(* unchecked. A started script's external effects happen at least once and *)
(* are never undone (a failed commit kills the process, it does not roll   *)
(* back what the script already did).                                       *)
EffClaim(x) ==
    /\ eff[x] = "started"
    /\ LET entry == IF DeleteGuard
                      THEN nState[x] = "pending" /\ runStatus \in Active /\ sessionLive
                      ELSE nState[x] # "completed"
       IN IF entry
            THEN /\ eff' = [eff EXCEPT ![x] = IF EntryFence THEN "spawned" ELSE "claimed"]
                 /\ UNCHANGED effRes
            ELSE /\ eff' = [eff EXCEPT ![x] = "ran"]
                 /\ effRes' = [effRes EXCEPT ![x] = "skip"]
    /\ UNCHANGED <<storeVars, ctrlVars, stopReq, wakeDup, envVars>>

(* EntryFence: the entry transaction commits after the process started.   *)
EffCommit(x) ==
    /\ eff[x] = "spawned"
    /\ eff' = [eff EXCEPT ![x] = "running"]
    /\ UNCHANGED <<storeVars, ctrlVars, effRes, stopReq, wakeDup, envVars>>

(* The entry commit fails: the runner kills the started process and the     *)
(* activity reports execution_failed (the attempt count rolls back).        *)
EffCommitFail(x) ==
    /\ EffectFaults
    /\ eff[x] = "spawned"
    /\ eff' = [eff EXCEPT ![x] = "ran"]
    /\ effRes' = [effRes EXCEPT ![x] = "error"]
    /\ UNCHANGED <<storeVars, ctrlVars, stopReq, wakeDup, envVars>>

(* Without EntryFence (reviewed 159bdce5): after the claim committed, the   *)
(* activity resolves the tool binding and then spawns the script, with no   *)
(* check in between; a deletion or cancellation may commit meanwhile.       *)
EffLaunch(x) ==
    /\ eff[x] = "claimed"
    /\ eff' = [eff EXCEPT ![x] = "running"]
    /\ UNCHANGED <<storeVars, ctrlVars, effRes, stopReq, wakeDup, envVars>>

(* The script returns a result; it enters the effect history.             *)
EffComplete(x) ==
    /\ eff[x] = "running"
    /\ \E r \in NodeOutcomes(x) : effRes' = [effRes EXCEPT ![x] = r]
    /\ eff' = [eff EXCEPT ![x] = "ran"]
    /\ UNCHANGED <<storeVars, ctrlVars, stopReq, wakeDup, envVars>>

(* Hardened code: the liveness check stops a script whose node is decided. *)
EffStopDecided(x) ==
    /\ DeleteGuard
    /\ eff[x] = "running"
    /\ nState[x] = "completed"
    /\ eff' = [eff EXCEPT ![x] = "ran"]
    /\ effRes' = [effRes EXCEPT ![x] = "skip"]
    /\ UNCHANGED <<storeVars, ctrlVars, stopReq, wakeDup, envVars>>

(* A worker crash re-dispatches runScript: the script may run again. A       *)
(* crash inside the entry transaction rolls it back. A process the crashed  *)
(* worker had started may outlive it; this model does not track such an     *)
(* orphan (its effects are already-started effects, not a new entry).       *)
EffCrash(x) ==
    /\ EffectFaults
    /\ eff[x] \in {"claimed", "spawned", "running"}
    /\ eff' = [eff EXCEPT ![x] = "started"]
    /\ UNCHANGED <<storeVars, ctrlVars, effRes, stopReq, wakeDup, envVars>>

(* The effect orchestration ends without storing a result (its record      *)
(* activity exhausted its retries, or it was terminated).                   *)
EffDie(x) ==
    /\ EffectFaults
    /\ eff[x] \in {"started", "claimed", "running", "ran"}
    /\ eff' = [eff EXCEPT ![x] = "failed"]
    /\ UNCHANGED <<storeVars, ctrlVars, effRes, stopReq, wakeDup, envVars>>

(* The effect acknowledges a stop request: duroxide cancels it, its runner  *)
(* kills the script, and it ends without storing a result. An effect inside *)
(* its entry transaction acknowledges after that transaction ends.         *)
EffStopRequested(x) ==
    /\ stopReq[x]
    /\ eff[x] \in {"started", "claimed", "running", "ran", "recorded"}
    /\ eff' = [eff EXCEPT ![x] = "stopped"]
    /\ UNCHANGED <<storeVars, ctrlVars, effRes, stopReq, wakeDup, envVars>>

(* recordEffectResult activity, store.completeNode (compare-and-swap).     *)
EffRecord(x) ==
    /\ eff[x] = "ran"
    /\ NoEntryInFlight
    /\ IF effRes[x] # "skip" /\ (nState[x] = "pending" \/ NoCas) /\ Writable
         THEN /\ nState' = [nState EXCEPT ![x] = "completed"]
              /\ nWinner' = [nWinner EXCEPT ![x] = "effect"]
              /\ nOutcome' = [nOutcome EXCEPT ![x] = effRes[x]]
              /\ events' = [events EXCEPT !.stateCompleted[x] = @ + 1]
         ELSE UNCHANGED <<nState, nWinner, nOutcome, events>>
    /\ eff' = [eff EXCEPT ![x] = "recorded"]
    /\ UNCHANGED <<runStatus, sessionLive, defDeleted, ctrlVars, effRes, stopReq, wakeDup, envVars>>

(* wake activity: enqueue a hint for an active run.                        *)
EffWake(x) ==
    /\ eff[x] = "recorded"
    /\ q' = IF runStatus \in Active THEN Append(q, "wake") ELSE q
    /\ eff' = [eff EXCEPT ![x] = "done"]
    /\ UNCHANGED <<storeVars, ctrlVars, effRes, stopReq, wakeDup, cancelSent, deleteSent, notified>>

(* A crash after the enqueue, before the wake result entered history.      *)
EffWakeDup(x) ==
    /\ eff[x] = "recorded"
    /\ wakeDup[x] = 0
    /\ runStatus \in Active
    /\ q' = Append(q, "wake")
    /\ wakeDup' = [wakeDup EXCEPT ![x] = 1]
    /\ UNCHANGED <<storeVars, ctrlVars, eff, effRes, stopReq, cancelSent, deleteSent, notified>>

(* The wake activity exhausts its retries; the effect ends without a wake. *)
EffWakeLost(x) ==
    /\ LoseWake
    /\ eff[x] = "recorded"
    /\ eff' = [eff EXCEPT ![x] = "done"]
    /\ UNCHANGED <<storeVars, ctrlVars, effRes, stopReq, wakeDup, envVars>>

-----------------------------------------------------------------------------
(* Environment                                                             *)

(* The parent may send one cancel command at any time.                     *)
SendCancel ==
    /\ ~cancelSent
    /\ q' = Append(q, "cancel")
    /\ cancelSent' = TRUE
    /\ UNCHANGED <<storeVars, ctrlVars, effVars, deleteSent, notified>>

(* Any deletion path soft-deletes the session row (cms_soft_delete_session).*)
(* Hardened code: the 0085 trigger ends v2 work in that transaction.       *)
Delete ==
    /\ Deletes
    /\ ~deleteSent
    /\ NoEntryInFlight
    /\ deleteSent' = TRUE
    /\ sessionLive' = FALSE
    /\ IF DeleteGuard
         THEN /\ defDeleted' = TRUE
              /\ IF runStatus \in Active
                   THEN /\ runStatus' = "cancelled"
                        /\ EndPendingNodes("delete")
                   ELSE UNCHANGED <<runStatus, nodeVars>>
         ELSE UNCHANGED <<defDeleted, runStatus, nodeVars>>
    /\ UNCHANGED <<events, ctrlVars, effVars, q, cancelSent, notified>>

Controller ==
    \/ Dispatch \/ BeginExec \/ BeginRecord \/ AdmitExec \/ AdmitRecord \/ StartEffect
    \/ CollectExec \/ CollectRecord \/ WaitMsg \/ WaitTimer
    \/ FinishExec \/ FinishFailExec \/ FinishRecord \/ NotifyExec \/ NotifyRecord
    \/ CancelTx \/ CancelStop \/ CancelCrash \/ CancelRecord \/ ControllerFault
    \/ PollCommand \/ ControllerDie \/ Recover

Effects ==
    \E x \in SNodes :
        \/ EffClaim(x) \/ EffCommit(x) \/ EffCommitFail(x) \/ EffLaunch(x) \/ EffComplete(x) \/ EffStopDecided(x)
        \/ EffStopRequested(x) \/ EffCrash(x) \/ EffDie(x)
        \/ EffRecord(x) \/ EffWake(x) \/ EffWakeDup(x) \/ EffWakeLost(x)

Next == Controller \/ Effects \/ SendCancel \/ Delete

(* Controller and normal effect steps are weakly fair. The cancel body may  *)
(* crash once, so its steps are weakly fair too. A worker crash may repeat  *)
(* a script, so the effect steps a crash disables are strongly fair (an     *)
(* assumption: crashes do not recur forever). Recover is weakly fair: the   *)
(* parent eventually recovers a run that needs it. Faults, cancel and       *)
(* delete are environment actions without fairness.                         *)
Fairness ==
    /\ WF_vars(Dispatch) /\ WF_vars(BeginExec) /\ WF_vars(BeginRecord)
    /\ WF_vars(AdmitExec) /\ WF_vars(AdmitRecord) /\ WF_vars(StartEffect)
    /\ WF_vars(CollectExec) /\ WF_vars(CollectRecord)
    /\ WF_vars(WaitMsg) /\ WF_vars(WaitTimer)
    /\ WF_vars(FinishExec) /\ WF_vars(FinishFailExec) /\ WF_vars(FinishRecord)
    /\ WF_vars(NotifyExec) /\ WF_vars(NotifyRecord)
    /\ WF_vars(CancelTx) /\ WF_vars(CancelStop) /\ WF_vars(CancelRecord)
    /\ WF_vars(PollCommand) /\ WF_vars(Recover)
    /\ \A x \in SNodes :
          /\ WF_vars(EffClaim(x)) /\ WF_vars(EffCommit(x)) /\ SF_vars(EffLaunch(x)) /\ SF_vars(EffComplete(x))
          /\ SF_vars(EffStopDecided(x)) /\ SF_vars(EffStopRequested(x))
          /\ WF_vars(EffRecord(x)) /\ WF_vars(EffWake(x))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety                                                                  *)

Inv_EventsOnce ==
    /\ events.started <= 1
    /\ events.ended <= 1
    /\ \A x \in NX : events.stateStarted[x] <= 1
    /\ \A x \in SNodes : events.stateCompleted[x] <= 1

Inv_TerminalNoPending == runStatus \in Terminal => \A x \in NX : nState[x] # "pending"

Inv_AdmissionOrder ==
    /\ \A i \in SOrd : (i > 1 /\ nState[<<"S", i>>] # "absent")
            => (nState[<<"S", i - 1>>] = "completed" /\ nOutcome[<<"S", i - 1>>] = "again")
    /\ nState[TNode] # "absent" =>
            (\E i \in SOrd : nOutcome[<<"S", i>>] = "ok") \/ (CatchAll /\ nOutcome[HNode] = "ok")

(* The catch-all state runs only after a state ended with an error it had   *)
(* no route for, and at most once (Inv_EventsOnce counts its admissions).  *)
Inv_CatchAllAfterUnhandled ==
    CatchAll => (nState[HNode] # "absent" => \E i \in SOrd : nOutcome[<<"S", i>>] = "error")

Inv_CancelWinner == \A x \in NX : nWinner[x] \in {"cancel", "delete"} => runStatus = "cancelled"

Inv_CompletedHasTerminal == runStatus = "completed" => nOutcome[TNode] = "succeeded"

(* A cancelled node reaches routing only after its run ended (deletion).   *)
Inv_NeverRouteCancelled == ~(pc = "collect" /\ actRes = "cancelled" /\ runStatus \in Active)

CoreSafety ==
    /\ TypeOK
    /\ Inv_EventsOnce
    /\ Inv_AdmissionOrder
    /\ Inv_CatchAllAfterUnhandled
    /\ Inv_CancelWinner
    /\ Inv_CompletedHasTerminal
    /\ Inv_NeverRouteCancelled

(* A deleted workflow has no active run.                                   *)
Inv_DeletedNotActive == ~sessionLive => runStatus \in Terminal

Prop_ResultImmutable ==
    [][\A x \in NX : nState[x] = "completed"
          => (nState'[x] = "completed" /\ nWinner'[x] = nWinner[x] /\ nOutcome'[x] = nOutcome[x])]_vars

(* The action of each [][...]_vars below is parenthesized: SANY reads      *)
(* "[ identifier \in" as the start of a function constructor.             *)
Prop_RunTerminalImmutable == [][(runStatus \in Terminal => runStatus' = runStatus)]_vars

Prop_NoAdmissionAfterTerminal ==
    [][(runStatus \in Terminal => \A x \in NX : nState[x] = "absent" => nState'[x] = "absent")]_vars

(* No script starts after the workflow session was deleted.                *)
Prop_NoScriptAfterDelete ==
    [][\A x \in SNodes : (eff[x] \notin {"spawned", "running"} /\ eff'[x] \in {"spawned", "running"}) => sessionLive]_vars

(* Requested: each stop step of the cancel activity asks every cancel-won   *)
(* effect that has not ended to stop (an ended effect needs no request).    *)
Prop_CancelAsksLiveEffects ==
    [][(pc = "cancel" /\ cancelStep \in {"stop", "stopRetry"} /\ cancelStep' \in {"rec", "recRetry"})
        => \A x \in SNodes : (nWinner[x] = "cancel" /\ eff[x] \notin {"absent"} \cup EffectEnded) => stopReq'[x]]_vars

(* A tombstone is permanent.                                               *)
Prop_TombstonePermanent == [][(defDeleted => (defDeleted' /\ ~sessionLive'))]_vars

(* Liveness                                                                *)

Live_Terminates == <>(runStatus \in Terminal)

Live_ControllerDone == <>(pc = "done")

Live_EffectsQuiesce == <>[](\A x \in SNodes : eff[x] \in {"absent"} \cup EffectEnded)

(* Acknowledged: every cancel-won effect eventually ends (by its stop        *)
(* request, or by its own check that its node was decided), even when the   *)
(* cancel activity runs out of attempts before it sends any request.        *)
Live_CancelledEffectsEnd ==
    \A x \in SNodes : (nWinner[x] = "cancel") ~> (eff[x] \in {"absent"} \cup EffectEnded)

=============================================================================
