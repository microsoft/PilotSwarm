------------------------- MODULE RerunContinuedSession -------------------------
(***************************************************************************)
(* A continued agent state (session: continue) in a re-run (I7, audit     *)
(* CS-6).                                                                  *)
(*                                                                         *)
(* #3 reuses or is supplied K cycles of the state (TLC chooses K): their   *)
(* conversation is in #2's session, never in #3's. Live cycles K+1 ..     *)
(* K+Live follow, one at a time. Each is admitted to a session            *)
(* (runtime.ts continuedSessionOf: the previous live visit's session while *)
(* it goes on, the state's first session for the first live visit, a new  *)
(* session when the previous one ended on its own), gets its prompt       *)
(* (runtime.ts agentSessionCycle and workflowAgentPrompt /                 *)
(* workflowAgentCyclePrompt), and is spawned (its prompt is queued in the *)
(* session) or refused. A queued turn runs in queue order, or is dropped  *)
(* when the visit is decided without it. The visit is decided by its agent*)
(* (a report: winner agent) or by its time limit (before or after its turn*)
(* ran). After a report the cycle's conversation can be lost (the reply   *)
(* stopped, the Copilot session lost, the snapshot not committed); the    *)
(* loss is recorded when the turn ends (store.ts                           *)
(* recordAgentCycleMemoryLost), before the session's next turn. A session *)
(* can end on its own between cycles.                                      *)
(*                                                                         *)
(* The prompt's claim is the code's: the first live cycle carries the     *)
(* pre-cut summary (rerunRecap), as does the first cycle of a new session *)
(* (the restart prompt); a later cycle of the same session points to the  *)
(* first earlier cycle of its session whose agent reported (review I-2    *)
(* residual: a queued prompt is not evidence), carries the summary itself *)
(* when none reported (notRunInSession) or when that cycle's conversation *)
(* was lost (recapLostCycle). At the turn, the session reads the cycles   *)
(* lost before it (store.ts readAgentCyclesLostBefore) and carries the    *)
(* summary again when the cycle it points to was lost.                    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    PreCuts,                \* the K values TLC chooses from (pre-cut reused or supplied cycles)
    Live,                   \* live cycles after the cut (1..3)
    AllowSessionEnd,        \* a session ends on its own between cycles
    AllowLoss,              \* a cycle's conversation is lost after its report
    \* ---- faults ----
    RanMeansSpawned,        \* the code before review I-2 residual: a cycle "reached" the session once its prompt was queued
    IgnoreLostRecap,        \* the code before review I-2 residual b: a lost recap cycle is still pointed to, at the prompt and at the turn
    RestartWithoutRecap,    \* a new session's first prompt (restart) leaves out the pre-cut summary
    ContinueSourceSession   \* the first live cycle continues #2's session (the last reused visit's child session)

ASSUME PreCuts \subseteq 0..2 /\ PreCuts # {} /\ Live \in 1..3
ASSUME {AllowSessionEnd, AllowLoss, RanMeansSpawned, IgnoreLostRecap, RestartWithoutRecap, ContinueSourceSession} \subseteq BOOLEAN

Cycles == 1..Live          \* live cycle j is the state's cycle K + j
Sessions == 0..Live        \* 0 = #2's session (the reused cycles'); 1..Live = #3's sessions
SourceSession == 0

VARIABLES
    K,
    cur,        \* the live cycle in progress (0 = none yet)
    st,         \* [Cycles -> "none" | "admitted" | "queued" | "refused" | "decided"]
    sessOf,     \* [Cycles -> Sessions]
    carries,    \* [Cycles -> BOOLEAN]: the prompt carries the pre-cut summary
    pointsTo,   \* [Cycles -> 0..Live]: the prompt says the summary is in that cycle's prompt above (0 = no such claim)
    queued,     \* [Cycles -> BOOLEAN]: the spawn was recorded (the prompt is in the session's queue)
    turn,       \* [Cycles -> "none" | "ran" | "dropped"]
    winner,     \* [Cycles -> "none" | "agent" | "controller"]
    lost,       \* [Cycles -> BOOLEAN]: the conversation of this cycle was lost after its report (recorded)
    ended,      \* [Sessions -> BOOLEAN]: the session ended on its own
    nextSess,   \* the next new session id
    reCarried,  \* [Cycles -> BOOLEAN]: at its turn, the summary was carried again (the cycle it points to was lost)
    falseClaim, \* ghost: a turn ran under a claim that the summary is above, and it is not
    noRecap     \* ghost: a turn ran with K > 0 and the summary nowhere in its session's conversation or its prompt

vars == <<K, cur, st, sessOf, carries, pointsTo, queued, turn, winner, lost, ended, nextSess, reCarried, falseClaim, noRecap>>

Init ==
    /\ K \in PreCuts
    /\ cur = 0
    /\ st = [j \in Cycles |-> "none"] /\ sessOf = [j \in Cycles |-> 1]
    /\ carries = [j \in Cycles |-> FALSE] /\ pointsTo = [j \in Cycles |-> 0]
    /\ queued = [j \in Cycles |-> FALSE] /\ turn = [j \in Cycles |-> "none"]
    /\ winner = [j \in Cycles |-> "none"] /\ lost = [j \in Cycles |-> FALSE]
    /\ ended = [s \in Sessions |-> FALSE] /\ nextSess = 2
    /\ reCarried = [j \in Cycles |-> FALSE] /\ falseClaim = FALSE /\ noRecap = FALSE

\* The earlier live cycles of session s before cycle j.
InSession(s, j) == {c \in Cycles : c < j /\ st[c] # "none" /\ sessOf[c] = s}
\* The code's evidence that a cycle's turn ran: its agent reported (winner agent); fault RanMeansSpawned: it was queued.
Reached(c) == IF RanMeansSpawned THEN queued[c] ELSE winner[c] = "agent"
FirstReached(s, j) ==
    LET R == {c \in InSession(s, j) : Reached(c)} IN IF R = {} THEN 0 ELSE CHOOSE c \in R : \A d \in R : c <= d
\* The ground truth: cycle c's prompt is in session s's conversation (its turn ran there and was not lost).
InConversation(c) == turn[c] = "ran" /\ ~lost[c]
SummaryInSession(s, j) == \E c \in InSession(s, j) : InConversation(c) /\ (carries[c] \/ reCarried[c])

-----------------------------------------------------------------------------

\* The next live cycle is admitted once the previous one is decided: its session, then its prompt.
Admit ==
    /\ cur < Live /\ IF cur = 0 THEN TRUE ELSE st[cur] = "decided"
    /\ LET j == cur + 1
           prevSess == IF cur = 0 THEN 1 ELSE sessOf[cur]
           newSession == cur > 0 /\ ended[prevSess]
           s == IF cur = 0 THEN (IF ContinueSourceSession /\ K > 0 THEN SourceSession ELSE 1)
                ELSE IF newSession THEN nextSess ELSE prevSess
           first == FirstReached(s, j)
       IN
       /\ cur' = j
       /\ st' = [st EXCEPT ![j] = "admitted"]
       /\ sessOf' = [sessOf EXCEPT ![j] = s]
       /\ nextSess' = IF newSession THEN nextSess + 1 ELSE nextSess
       /\ IF K = 0
            THEN UNCHANGED <<carries, pointsTo>>
          ELSE IF cur = 0
            THEN \* the first live cycle (workflowAgentPrompt with rerunRecap)
                 /\ carries' = [carries EXCEPT ![j] = TRUE] /\ UNCHANGED pointsTo
          ELSE IF newSession
            THEN \* the restart prompt of a new session
                 /\ carries' = [carries EXCEPT ![j] = ~RestartWithoutRecap] /\ UNCHANGED pointsTo
          ELSE IF first = 0 \/ (lost[first] /\ ~IgnoreLostRecap)
            THEN \* notRunInSession, or recapLostCycle: this prompt carries the summary itself
                 /\ carries' = [carries EXCEPT ![j] = TRUE] /\ UNCHANGED pointsTo
            ELSE /\ pointsTo' = [pointsTo EXCEPT ![j] = first] /\ UNCHANGED carries
    /\ UNCHANGED <<K, queued, turn, winner, lost, ended, reCarried, falseClaim, noRecap>>

\* The spawn: the prompt is queued in the session, or refused (never queued).
Spawn ==
    /\ cur > 0 /\ st[cur] = "admitted"
    /\ \/ /\ st' = [st EXCEPT ![cur] = "queued"] /\ queued' = [queued EXCEPT ![cur] = TRUE]
       \/ /\ st' = [st EXCEPT ![cur] = "refused"] /\ UNCHANGED queued
    /\ UNCHANGED <<K, cur, sessOf, carries, pointsTo, turn, winner, lost, ended, nextSess, reCarried, falseClaim, noRecap>>

\* A queued turn runs once every earlier queued turn of its session ran or was dropped. At its start the session reads
\* the cycles lost before it and carries the summary again when the cycle its prompt points to was lost.
TurnRuns(j) ==
    LET s == sessOf[j]
        p == pointsTo[j]
        again == p > 0 /\ lost[p] /\ ~IgnoreLostRecap
        claimFalse == p > 0 /\ ~again /\ ~(InConversation(p) /\ (carries[p] \/ reCarried[p]))
        recapThere == carries[j] \/ again \/ SummaryInSession(s, j)
    IN
    /\ queued[j] /\ turn[j] = "none" /\ ~ended[s]
    /\ \A c \in InSession(s, j) : queued[c] => turn[c] # "none"
    /\ turn' = [turn EXCEPT ![j] = "ran"]
    /\ reCarried' = [reCarried EXCEPT ![j] = again]
    /\ falseClaim' = (falseClaim \/ claimFalse)
    /\ noRecap' = (noRecap \/ (K > 0 /\ ~recapThere))
    /\ UNCHANGED <<K, cur, st, sessOf, carries, pointsTo, queued, winner, lost, ended, nextSess>>

\* A queued turn the session never runs (the visit was decided without it, and its prompt was stopped).
TurnDropped(j) ==
    /\ queued[j] /\ turn[j] = "none" /\ winner[j] = "controller"
    /\ turn' = [turn EXCEPT ![j] = "dropped"]
    /\ UNCHANGED <<K, cur, st, sessOf, carries, pointsTo, queued, winner, lost, ended, nextSess, reCarried, falseClaim, noRecap>>

\* The visit is decided: its agent reports during its turn, or its time limit decides it (before or after its turn ran,
\* or after a refused spawn).
Report ==
    /\ cur > 0 /\ st[cur] = "queued" /\ turn[cur] = "ran" /\ winner[cur] = "none"
    /\ winner' = [winner EXCEPT ![cur] = "agent"] /\ st' = [st EXCEPT ![cur] = "decided"]
    /\ UNCHANGED <<K, cur, sessOf, carries, pointsTo, queued, turn, lost, ended, nextSess, reCarried, falseClaim, noRecap>>
TimesOut ==
    /\ cur > 0 /\ st[cur] \in {"queued", "refused"} /\ winner[cur] = "none"
    /\ winner' = [winner EXCEPT ![cur] = "controller"] /\ st' = [st EXCEPT ![cur] = "decided"]
    /\ UNCHANGED <<K, cur, sessOf, carries, pointsTo, queued, turn, lost, ended, nextSess, reCarried, falseClaim, noRecap>>

\* After a report, the cycle's conversation is lost at its turn's end (recorded then), before the session's next turn.
Lose(j) ==
    /\ AllowLoss /\ winner[j] = "agent" /\ turn[j] = "ran" /\ ~lost[j]
    /\ \A c \in Cycles : (c > j /\ sessOf[c] = sessOf[j] /\ st[c] # "none") => turn[c] = "none"
    /\ lost' = [lost EXCEPT ![j] = TRUE]
    /\ UNCHANGED <<K, cur, st, sessOf, carries, pointsTo, queued, turn, winner, ended, nextSess, reCarried, falseClaim, noRecap>>

\* A session ends on its own (deleted, failed, or ended by a person) between cycles.
SessionEnds ==
    /\ AllowSessionEnd /\ cur > 0 /\ st[cur] = "decided" /\ ~ended[sessOf[cur]] /\ sessOf[cur] # SourceSession
    /\ ended' = [ended EXCEPT ![sessOf[cur]] = TRUE]
    /\ UNCHANGED <<K, cur, st, sessOf, carries, pointsTo, queued, turn, winner, lost, nextSess, reCarried, falseClaim, noRecap>>

Done ==
    /\ cur = Live /\ st[cur] = "decided"
    /\ UNCHANGED vars

Next == Admit \/ Spawn \/ Report \/ TimesOut \/ SessionEnds \/ Done
        \/ \E j \in Cycles : TurnRuns(j) \/ TurnDropped(j) \/ Lose(j)
Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties                                                              *)

TypeOK ==
    /\ K \in PreCuts /\ cur \in 0..Live /\ nextSess \in 2..(Live + 2)
    /\ sessOf \in [Cycles -> Sessions] /\ pointsTo \in [Cycles -> 0..Live]

\* CS-6: no turn runs under a claim that the pre-cut summary is in an earlier cycle's prompt above when it is not (that
\* cycle's turn did not run, its conversation was lost, or its prompt did not carry the summary).
Inv_NoFalseRecapClaim == ~falseClaim
\* CS-6: in a re-run with pre-cut cycles, every turn has the summary in its prompt, its turn note, or its session's kept
\* conversation, whatever timed out, was refused, was lost, or which session ended.
Inv_RecapAvailable == ~noRecap
\* CS-6: no live cycle of #3 uses #2's agent session.
Inv_SessionIsolation == \A j \in Cycles : st[j] # "none" => sessOf[j] # SourceSession

\* Witnesses (each expected violated).
\* The audit's trace: the first live cycle was queued and timed out before its turn ran; the next cycle of the same
\* session carries the summary itself and its turn runs.
Wit_NoTimedOutThenCarried ==
    ~(K > 0 /\ queued[1] /\ winner[1] = "controller" /\ Live >= 2 /\ sessOf[2] = sessOf[1] /\ carries[2] /\ turn[2] = "ran")
\* A cycle points to an earlier cycle of its session that reported, and that pointer is true at its turn.
Wit_NoPointerHonoured == ~(\E j \in Cycles : pointsTo[j] > 0 /\ turn[j] = "ran" /\ InConversation(pointsTo[j]))
\* The cycle a later prompt points to is lost before that later turn; the turn note carries the summary again.
Wit_NoReCarryAtTurn == ~(\E j \in Cycles : reCarried[j])
\* A session ended on its own; the next cycle starts a new session whose restart prompt carries the summary, and a
\* later cycle of the new session points to it.
Wit_NoReplacementPointer ==
    ~(\E j \in Cycles : j > 1 /\ sessOf[j] # sessOf[j - 1] /\ carries[j] /\ \E i \in Cycles : i > j /\ pointsTo[i] = j /\ turn[i] = "ran")

=============================================================================
