------------------------------ MODULE WfAgent ------------------------------
(***************************************************************************)
(* An agent state and its child LLM session (controller 1.9.0, IR 8) at   *)
(* efe44835: the agent orchestration that creates the child               *)
(* (workflowV2AgentSpawn; spawnAgent, agentSpawnFailed), the child's     *)
(* completion tool (complete_workflow_node; store.completeAgentNode),     *)
(* the state's outer deadline (elapse; store.elapseAgentNode), the        *)
(* controller ending the child once the state is decided (endAgent at    *)
(* collection, endAgents when the run ends; endAgentChild), and a run    *)
(* end that decides the state first. One agent state, one child.         *)
(*                                                                         *)
(* Store transactions are atomic steps. The agent orchestration's spawn  *)
(* activity is split where its non-transactional steps are: the store's   *)
(* begin, the host's child creation and first prompt, the record, and    *)
(* the end after the spawn; a worker crash between them retries the      *)
(* activity from its begin (persistentlyTagged). The deadline is one      *)
(* monotone flag: the store's non-monotone clock with durable expiry is   *)
(* checked in paired/request (variant B) and applies here unchanged.     *)
(***************************************************************************)
(* r2: Code = "proposedD" adds the WFO-2 fix proposed for group D        *)
(* (agentSpawnFailed ends a child an attempt may have created; endAgents  *)
(* re-sends an end marked NotFound); efe44835 and 1c117a47 are the same    *)
(* here (1c117a47's paging of the run's cleanup is in WfPaging).          *)
(* r2e: Code = "a10c2e07" sends an end already marked sent again only     *)
(* after a spawn and only when its recorded status was NotFound.          *)
EXTENDS Naturals

CONSTANTS
    MaxCrashes,      \* worker crashes inside the spawn activity
    MaxInvalid,      \* WORKFLOW_V2_AGENT_MAX_INVALID_COMPLETIONS (small here)
    AllowRefuse,     \* the host refuses the child (unknown or forbidden agent)
    AllowExhaust,    \* every remaining spawn attempt fails (a long store outage)
    AllowEndFail,    \* an end command cannot be sent (status read or enqueue fails, every attempt)
    AllowEvict,      \* the child's recent-id window (20 ids) forgets the prompt's id
    AllowRunEnd,     \* the run ends while the state is pending (cancel, stop, expiry, deletion)
    AllowAsk,        \* the child asks its controlling parent agent and waits for an answer
    Fault,           \* "none", "no_end_after_spawn", "end_ignores_spawn", "accept_after_deadline"
    Code             \* "efe44835" (= "1c117a47" here), "1f7bdc77" (group D as committed), "a10c2e07" or "proposedD"

ASSUME Code \in {"efe44835", "1c117a47", "1f7bdc77", "a10c2e07", "proposedD"}
ASSUME Fault \in {"none", "no_end_after_spawn", "end_ignores_spawn", "accept_after_deadline"}
NONE == "none"

VARIABLES
    node,       \* the state: "pending", "agent_ok", "agent_err", "invalid_output", "timed_out", "unavailable", "cancel"
    due,        \* the store's clock reached the deadline (or an expired completion was bound)
    runLive,    \* the run is active
    inv,        \* agent invocation row: [attempts, spawned, endReq, endSent, endStatus]
    sp,         \* the agent orchestration: "begin", "host", "record", "endafter", "done"
    crashes,
    child,      \* [exists, st ("none", "active", "ended"), prompts, window, endCmd, asked, answered]
    invalidLeft,
    ctl,        \* the controller: "waiting", "ending", "ended"
    \* history
    acceptLate, acceptClosed, endBeforeDecision, wokeController

vars == <<node, due, runLive, inv, sp, crashes, child, invalidLeft, ctl,
          acceptLate, acceptClosed, endBeforeDecision, wokeController>>

Decided == node # "pending"
ByAgent == node \in {"agent_ok", "agent_err", "invalid_output"}

Init ==
    /\ node = "pending" /\ due = FALSE /\ runLive = TRUE
    /\ inv = [attempts |-> 0, spawned |-> FALSE, endReq |-> NONE, endSent |-> FALSE, endStatus |-> NONE]
    /\ sp = "begin" /\ crashes = 0
    /\ child = [exists |-> FALSE, st |-> "none", prompts |-> 0, window |-> FALSE, endCmd |-> FALSE,
                asked |-> FALSE, answered |-> FALSE, ends |-> 0]
    /\ invalidLeft = MaxInvalid
    /\ ctl = "waiting"
    /\ acceptLate = FALSE /\ acceptClosed = FALSE /\ endBeforeDecision = FALSE /\ wokeController = FALSE

----------------------------------------------------------------------------
(* endAgentChild: once the state is decided, record the end once (done   *)
(* after the agent's own completion, cancel after anything else), read  *)
(* the child's session status and queue the command when it still runs, *)
(* then mark the end sent with the status read. A call after the end    *)
(* was marked does nothing, unless it comes after a spawn (afterSpawn).  *)
(* 1f7bdc77 (WFO-2): remarkAgentEndSent moves a NotFound mark to the     *)
(* child's real status once an end after a spawn finds it.                *)
Remark == Code \in {"1f7bdc77", "a10c2e07"}
OnlyNotFound == Code = "a10c2e07"   \* a10c2e07: re-sent after a spawn only when it found no session
EndChildN(n, afterSpawn) ==
    /\ n # "pending"
    /\ LET endReq == IF inv.endReq # NONE THEN inv.endReq ELSE IF n \in {"agent_ok", "agent_err", "invalid_output"} THEN "done" ELSE "cancel"
           skip == inv.endSent /\ ~(afterSpawn /\ Fault # "end_ignores_spawn" /\ (~OnlyNotFound \/ inv.endStatus = "notfound"))
           send == child.exists /\ child.st = "active"
       IN IF skip
            THEN UNCHANGED <<inv, child>>
            ELSE /\ inv' = [inv EXCEPT !.endReq = endReq, !.endSent = TRUE,
                                       !.endStatus = IF inv.endSent
                                                       THEN IF Remark /\ afterSpawn /\ inv.endStatus = "notfound" /\ child.exists
                                                              THEN (IF send THEN "running" ELSE "ended")
                                                              ELSE inv.endStatus
                                                     ELSE IF send THEN "running" ELSE IF child.exists THEN "ended" ELSE "notfound"]
                 /\ child' = IF send THEN [child EXCEPT !.endCmd = TRUE, !.ends = @ + 1] ELSE child

EndChild(afterSpawn) == EndChildN(node, afterSpawn)

(* WFO-2, proposed for group D: an end that found no session while a     *)
(* spawn attempt was counted is not final; it is sent again.             *)
FixD == Code \in {"proposedD", "1f7bdc77", "a10c2e07"}
EndOwedAgain == FixD /\ inv.endSent /\ inv.endStatus = "notfound" /\ inv.attempts > 0

----------------------------------------------------------------------------
(* The agent orchestration's spawn activity.                               *)
(* beginAgentSpawn: under the session lock, a state decided (or a       *)
(* deleted session) is not spawned, and a child an earlier attempt may   *)
(* have created is ended; a recorded spawn is not repeated; otherwise    *)
(* the attempt is counted.                                                *)
SpawnBegin ==
    /\ sp = "begin"
    /\ IF Decided \/ ~runLive
         THEN /\ IF inv.attempts > 0 /\ Fault # "no_end_after_spawn"
                   THEN EndChild(TRUE) /\ sp' = "done"
                   ELSE sp' = "done" /\ UNCHANGED <<inv, child>>
              /\ UNCHANGED node
       ELSE IF inv.spawned
         THEN /\ sp' = "endafter" /\ UNCHANGED <<inv, child, node>>
       ELSE /\ inv' = [inv EXCEPT !.attempts = @ + 1]
            /\ sp' = "host" /\ UNCHANGED <<child, node>>
    /\ UNCHANGED <<due, runLive, crashes, invalidLeft, ctl, acceptLate, acceptClosed, endBeforeDecision, wokeController>>

(* host.spawn: create the child session (or find the one an earlier      *)
(* attempt created) and send its first prompt with the stable client     *)
(* message id; the child drops a repeated prompt while that id is among  *)
(* its 20 most recent ones. A refusal fails the state (winner           *)
(* controller) and wakes the controller.                                 *)
SpawnHost ==
    /\ sp = "host"
    /\ \/ /\ child' = [child EXCEPT !.exists = TRUE,
                                    !.st = IF child.st = "none" THEN "active" ELSE child.st,
                                    !.prompts = IF child.window \/ child.st = "ended" THEN child.prompts ELSE child.prompts + 1,
                                    !.window = TRUE]
          /\ sp' = "record"
          /\ UNCHANGED <<node, wokeController>>
       \/ /\ AllowRefuse /\ ~child.exists
          /\ node' = IF node = "pending" THEN "unavailable" ELSE node
          /\ wokeController' = TRUE
          /\ sp' = "done"
          /\ UNCHANGED child
    /\ UNCHANGED <<due, runLive, inv, crashes, invalidLeft, ctl, acceptLate, acceptClosed, endBeforeDecision>>

(* recordAgentSpawned: once; a repeat changes nothing.                     *)
SpawnRecord ==
    /\ sp = "record"
    /\ inv' = [inv EXCEPT !.spawned = TRUE]
    /\ sp' = "endafter"
    /\ UNCHANGED <<node, due, runLive, crashes, child, invalidLeft, ctl, acceptLate, acceptClosed, endBeforeDecision, wokeController>>

(* A state decided while its child was being created: the controller's   *)
(* end may have found no session yet, so the spawn ends it again.        *)
SpawnEndAfter ==
    /\ sp = "endafter"
    /\ IF Decided /\ Fault # "no_end_after_spawn" THEN EndChild(TRUE) ELSE UNCHANGED <<inv, child>>
    /\ sp' = "done"
    /\ UNCHANGED <<node, due, runLive, crashes, invalidLeft, ctl, acceptLate, acceptClosed, endBeforeDecision, wokeController>>

(* A worker crash inside the spawn activity: the activity runs again.     *)
SpawnCrash ==
    /\ sp \in {"host", "record", "endafter"} /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1 /\ sp' = "begin"
    /\ UNCHANGED <<node, due, runLive, inv, child, invalidLeft, ctl, acceptLate, acceptClosed, endBeforeDecision, wokeController>>

(* Every remaining attempt fails: agentSpawnFailed decides the state     *)
(* unavailable (a result stored first is kept) and wakes the controller.  *)
(* proposedD: agentSpawnFailed then ends a child an attempt may have      *)
(* created (endAgentChild afterSpawn; efe44835 and 1c117a47 end nothing). *)
SpawnExhausted ==
    /\ AllowExhaust /\ sp \in {"begin", "host", "record", "endafter"}
    /\ node' = IF node = "pending" THEN "unavailable" ELSE node
    /\ wokeController' = TRUE
    /\ sp' = "done"
    /\ IF FixD /\ inv.attempts > 0
         THEN EndChildN(IF node = "pending" THEN "unavailable" ELSE node, TRUE)
         ELSE UNCHANGED <<inv, child>>
    /\ UNCHANGED <<due, runLive, crashes, invalidLeft, ctl, acceptLate, acceptClosed, endBeforeDecision>>

----------------------------------------------------------------------------
(* The child session.                                                      *)
Working == child.exists /\ child.st = "active" /\ child.prompts > 0

(* complete_workflow_node: one transaction under the session and run     *)
(* locks; one reading of the store's clock decides by the invocation's   *)
(* deadline. A valid result or error decides the state (winner agent); an*)
(* invalid one spends the correction budget, and the last one decides    *)
(* invalid_output. A decided state refuses (NODE_CLOSED; the same result *)
(* again is a replay); past the deadline NODE_EXPIRED is bound.           *)
ChildComplete ==
    /\ Working /\ (~AllowAsk \/ ~child.asked \/ child.answered \/ due)
    /\ \E kind \in {"ok", "err", "invalid"} :
         IF node = "pending" /\ runLive /\ (~due \/ Fault = "accept_after_deadline")
           THEN /\ acceptLate' = (acceptLate \/ due)
                /\ IF kind = "invalid"
                     THEN /\ invalidLeft' = invalidLeft - 1
                          /\ node' = IF invalidLeft = 1 THEN "invalid_output" ELSE node
                     ELSE /\ node' = IF kind = "ok" THEN "agent_ok" ELSE "agent_err"
                          /\ UNCHANGED invalidLeft
                /\ wokeController' = (wokeController \/ node' # "pending")
                /\ UNCHANGED due
           ELSE \* refused: decided (NODE_CLOSED), past the deadline (NODE_EXPIRED is bound,
                \* so the deadline decides from now on), or the run ended
                UNCHANGED <<node, due, invalidLeft, acceptLate, wokeController>>
    /\ UNCHANGED <<runLive, inv, sp, crashes, child, ctl, acceptClosed, endBeforeDecision>>

(* The child asks its controlling parent agent (a needs_input it tries    *)
(* to resolve before completing) and waits for the answer.                *)
ChildAsks ==
    /\ AllowAsk /\ Working /\ ~child.asked
    /\ child' = [child EXCEPT !.asked = TRUE]
    /\ UNCHANGED <<node, due, runLive, inv, sp, crashes, invalidLeft, ctl, acceptLate, acceptClosed, endBeforeDecision, wokeController>>

ParentAnswers ==
    /\ child.asked /\ ~child.answered
    /\ child' = [child EXCEPT !.answered = TRUE]
    /\ UNCHANGED <<node, due, runLive, inv, sp, crashes, invalidLeft, ctl, acceptLate, acceptClosed, endBeforeDecision, wokeController>>

(* The child reads its end command and its session ends.                  *)
ChildTakesEnd ==
    /\ child.st = "active" /\ child.endCmd
    /\ child' = [child EXCEPT !.st = "ended"]
    /\ endBeforeDecision' = (endBeforeDecision \/ ~Decided)
    /\ UNCHANGED <<node, due, runLive, inv, sp, crashes, invalidLeft, ctl, acceptLate, acceptClosed, wokeController>>

(* The child's session ends on its own (it completes, fails or is        *)
(* cancelled by someone else) without completing the state.               *)
ChildQuits ==
    /\ Working
    /\ child' = [child EXCEPT !.st = "ended"]
    /\ UNCHANGED <<node, due, runLive, inv, sp, crashes, invalidLeft, ctl, acceptLate, acceptClosed, endBeforeDecision, wokeController>>

(* Many other messages reach the child: its recent-id window forgets the  *)
(* prompt's client message id.                                            *)
Evict ==
    /\ AllowEvict /\ child.window
    /\ child' = [child EXCEPT !.window = FALSE]
    /\ UNCHANGED <<node, due, runLive, inv, sp, crashes, invalidLeft, ctl, acceptLate, acceptClosed, endBeforeDecision, wokeController>>

----------------------------------------------------------------------------
(* The deadline arrives (the store's clock).                               *)
Deadline ==
    /\ ~due
    /\ due' = TRUE
    /\ UNCHANGED <<node, runLive, inv, sp, crashes, child, invalidLeft, ctl, acceptLate, acceptClosed, endBeforeDecision, wokeController>>

(* The controller elapses the state at its deadline (timed_out; the       *)
(* store decides by its own clock, a result stored first is kept).        *)
Elapse ==
    /\ ctl = "waiting" /\ due /\ node = "pending" /\ runLive
    /\ node' = "timed_out"
    /\ UNCHANGED <<due, runLive, inv, sp, crashes, child, invalidLeft, ctl, acceptLate, acceptClosed, endBeforeDecision, wokeController>>

(* The controller collects the decided state and ends its child           *)
(* (endAgent, its store retries only: a failure is traced and the result *)
(* is routed anyway); the run then goes on and ends later.                *)
Collect ==
    /\ ctl = "waiting" /\ Decided /\ runLive
    /\ \/ EndChild(FALSE)
       \/ AllowEndFail /\ UNCHANGED <<inv, child>>
    /\ ctl' = "ending"
    /\ UNCHANGED <<node, due, runLive, sp, crashes, invalidLeft, acceptLate, acceptClosed, endBeforeDecision, wokeController>>

(* Another end decides the run first: the pending state is cancelled.     *)
RunEnds ==
    /\ AllowRunEnd /\ runLive /\ ctl = "waiting"
    /\ runLive' = FALSE
    /\ node' = IF node = "pending" THEN "cancel" ELSE node
    /\ ctl' = "ending"
    /\ UNCHANGED <<due, inv, sp, crashes, child, invalidLeft, acceptLate, acceptClosed, endBeforeDecision, wokeController>>

(* The run ended (after the state was routed, or by another end): the     *)
(* controller's afterEnd ends the child of every decided agent state      *)
(* whose end was not marked sent (endAgents, persistentlyTagged; a        *)
(* failure of every attempt is traced and the end still reported).        *)
EndAgents ==
    /\ ctl = "ending"
    /\ runLive' = FALSE
    /\ \/ IF ~inv.endSent THEN EndChild(FALSE) ELSE IF EndOwedAgain THEN EndChild(TRUE) ELSE UNCHANGED <<inv, child>>
       \/ AllowEndFail /\ UNCHANGED <<inv, child>>
    /\ ctl' = "ended"
    /\ UNCHANGED <<node, due, sp, crashes, invalidLeft, acceptLate, acceptClosed, endBeforeDecision, wokeController>>

Done == ctl = "ended" /\ sp = "done" /\ UNCHANGED vars

Next ==
    \/ SpawnBegin \/ SpawnHost \/ SpawnRecord \/ SpawnEndAfter \/ SpawnCrash \/ SpawnExhausted
    \/ ChildComplete \/ ChildAsks \/ ParentAnswers \/ ChildTakesEnd \/ ChildQuits \/ Evict
    \/ Deadline \/ Elapse \/ Collect \/ RunEnds \/ EndAgents \/ Done

(* Fairness: workers run the spawn, the controller and the child; the    *)
(* deadline arrives; a child reads its queued end command. Crashes,      *)
(* refusals, exhausted attempts, failed ends, evictions, the child's     *)
(* own answers and the parent's are free choices.                         *)
Fairness ==
    /\ WF_vars(SpawnBegin) /\ WF_vars(SpawnHost) /\ WF_vars(SpawnRecord) /\ WF_vars(SpawnEndAfter)
    /\ WF_vars(Deadline) /\ WF_vars(Elapse) /\ WF_vars(Collect) /\ WF_vars(EndAgents)
    /\ WF_vars(ChildTakesEnd)

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ Fairness

----------------------------------------------------------------------------
TypeOK ==
    /\ node \in {"pending", "agent_ok", "agent_err", "invalid_output", "timed_out", "unavailable", "cancel"}
    /\ sp \in {"begin", "host", "record", "endafter", "done"}
    /\ ctl \in {"waiting", "ending", "ended"}
    /\ invalidLeft \in 0..MaxInvalid

(* Safety rules.                                                           *)
Inv_NoCompletionAfterDeadline == ~acceptLate
Inv_PromptOnce == child.prompts <= 1
Inv_EndOnlyDecided == ~endBeforeDecision
Inv_EndMatchesWinner == inv.endReq # NONE => (inv.endReq = "done" <=> ByAgent)
Inv_ChildOnlyFromAttempt == child.exists => inv.attempts > 0

(* Liveness.                                                               *)
Prop_StateDecided == <>Decided
Prop_ChildReleased == <>[](child.exists => child.st = "ended")

(* Witnesses, EXPECTED to be violated (reachable).                        *)
Wit_ChildCompletes == ~(node = "agent_ok")
Wit_TimedOutChildEnded == ~(node = "timed_out" /\ child.st = "ended")
Wit_SpawnAfterDecision == ~(Decided /\ inv.endStatus = "notfound" /\ child.exists /\ child.endCmd)
Wit_InvalidExhausted == ~(node = "invalid_output")
(* r2: a second end command (same command id) reaches a child.           *)
Wit_SecondEndCommand == child.ends < 2
=============================================================================
