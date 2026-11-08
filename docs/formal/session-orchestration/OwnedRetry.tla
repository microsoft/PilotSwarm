------------------------------ MODULE OwnedRetry ------------------------------
(***************************************************************************)
(* 1.0.83 ordinary retry ownership (orchestration_1_0_83/ at e76a6133):    *)
(* a failed turn's retry is owed apart from the pending prompt (state.ts   *)
(* 255-410, `ownedRetry`); a connection-closed, lossy hand-off or generic  *)
(* retry continues as new with it owned (turn.ts 159, 194, 364; the lossy  *)
(* hand-off's retry is fresh: count 0, no key); `decide` dispatches it     *)
(* before every other turn (queue.ts 1495-1517); only that dispatch reuses *)
(* the thrown attempt's key (turn.ts 549-553; `thrownTurnKey` null at      *)
(* start, state.ts 759-761); while it is owed, drain releases an armed     *)
(* wait for it but keeps an agent wait and queues its poll after it        *)
(* (`releaseTimerForOwnedRetry`, queue.ts 620-629, 749-760); every         *)
(* continue-as-new carries it (lifecycle.ts 733-740). In 1.0.82 the retry  *)
(* was the continue-as-new's pending prompt and the thrown key stayed in   *)
(* state for the next turn (1.0.82 turn.ts 218-247, 541).                  *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    TimerKind,      \* "none", "wait", "agent": the timer armed when the retry is owed
    AllowHandoff,   \* the failure may be a lossy hand-off (a fresh retry)
    AllowShutdown,  \* a graceful shutdown may be pending
    Mode,           \* "1.0.83" or "1.0.82" (comparison: the retry is the pending prompt; the key stays)
    Fault           \* "none", "other-first", "drop-at-can", "agent-released", "fresh-with-key"

ASSUME TimerKind \in {"none", "wait", "agent"} /\ AllowHandoff \in BOOLEAN /\ AllowShutdown \in BOOLEAN
ASSUME Mode \in {"1.0.83", "1.0.82"}
ASSUME Fault \in {"none", "other-first", "drop-at-can", "agent-released", "fresh-with-key"}

VARIABLES
    owed,       \* the owned retry: "none", "fail" (with the thrown key), "fresh" (lossy hand-off)
    key,        \* the thrown attempt's key is in state
    prompt,     \* another prompt is queued
    turn,       \* the running turn: "none", "first", "retry", "other"
    timer,      \* "none", "armed", "released", "pollAfter", "fired", "lost"
    failed,     \* the first turn has failed (once)
    cans, shutdown,
    owedCount, dispatched,
    gh
vars == <<owed, key, prompt, turn, timer, failed, cans, shutdown, owedCount, dispatched, gh>>

Init ==
    /\ owed = "none" /\ key = FALSE /\ prompt = FALSE /\ turn = "first"
    /\ timer = IF TimerKind = "none" THEN "none" ELSE "armed"
    /\ failed = FALSE /\ cans = 0 /\ shutdown = FALSE /\ owedCount = 0 /\ dispatched = 0 /\ gh = {}

(* The first turn fails: its retry is owed (a lossy hand-off: fresh).      *)
TurnFails ==
    /\ turn = "first" /\ ~failed
    /\ \E fresh \in (IF AllowHandoff THEN BOOLEAN ELSE {FALSE}) :
         /\ owed' = IF fresh THEN "fresh" ELSE "fail"
         /\ key' = (~fresh \/ Fault = "fresh-with-key")
    /\ turn' = "none" /\ failed' = TRUE /\ owedCount' = owedCount + 1
    /\ UNCHANGED <<prompt, timer, cans, shutdown, dispatched, gh>>

FirstSucceeds ==
    /\ turn = "first" /\ turn' = "none"
    /\ UNCHANGED <<owed, key, prompt, timer, failed, cans, shutdown, owedCount, dispatched, gh>>

PromptArrives ==
    /\ ~prompt /\ prompt' = TRUE
    /\ UNCHANGED <<owed, key, turn, timer, failed, cans, shutdown, owedCount, dispatched, gh>>

(* Continue-as-new between turns carries the owned retry.                 *)
ContinueAsNew ==
    /\ turn = "none" /\ cans < 1 /\ owed # "none"
    /\ cans' = cans + 1
    /\ owed' = IF Fault = "drop-at-can" THEN "none" ELSE owed
    /\ UNCHANGED <<key, prompt, turn, timer, failed, shutdown, owedCount, dispatched, gh>>

BeginShutdown ==
    /\ AllowShutdown /\ ~shutdown /\ shutdown' = TRUE
    /\ UNCHANGED <<owed, key, prompt, turn, timer, failed, cans, owedCount, dispatched, gh>>

(* drain while a retry is owed: an armed wait is released for it; an agent *)
(* wait is kept and its poll queued after the retry.                      *)
DrainForRetry ==
    /\ Mode = "1.0.83" /\ owed # "none" /\ turn = "none" /\ timer = "armed"
    /\ timer' = IF TimerKind = "agent" /\ Fault # "agent-released" THEN "pollAfter" ELSE "released"
    /\ UNCHANGED <<owed, key, prompt, turn, failed, cans, shutdown, owedCount, dispatched, gh>>

(* decide: the owed retry first (not during a graceful shutdown).         *)
DispatchRetry ==
    /\ Mode = "1.0.83" /\ owed # "none" /\ turn = "none" /\ ~shutdown
    /\ turn' = "retry" /\ owed' = "none" /\ dispatched' = dispatched + 1
    /\ gh' = gh \cup (IF owed = "fresh" /\ key THEN {"freshKey"} ELSE {})
    /\ UNCHANGED <<key, prompt, timer, failed, cans, shutdown, owedCount>>

(* 1.0.82: the retry is the pending prompt, taken with any queued prompt;  *)
(* (In 1.0.83 the key belongs to the owned-retry record; another turn      *)
(* never sees it.)                                                         *)
(* the thrown key stays in state for whichever turn runs next.            *)
DispatchRetry82 ==
    /\ Mode = "1.0.82" /\ owed # "none" /\ turn = "none" /\ ~shutdown
    /\ turn' = "retry" /\ owed' = "none" /\ dispatched' = dispatched + 1
    /\ UNCHANGED <<key, prompt, timer, failed, cans, shutdown, owedCount, gh>>

DispatchOther ==
    /\ prompt /\ turn = "none"
    /\ (owed = "none" \/ shutdown \/ Fault = "other-first" \/ Mode = "1.0.82")
    /\ turn' = "other" /\ prompt' = FALSE
    /\ gh' = gh \cup (IF owed # "none" /\ ~shutdown /\ Mode = "1.0.83" THEN {"otherFirst"} ELSE {})
                \cup (IF key /\ Mode = "1.0.82" THEN {"keyMisused"} ELSE {})
    /\ UNCHANGED <<owed, key, timer, failed, cans, shutdown, owedCount, dispatched>>

(* A turn ends; the retry's key is spent; a released wait is armed again   *)
(* (settleQueuedWorkAfterDecide) and a kept agent wait's poll runs.        *)
FinishTurn ==
    /\ turn \in {"retry", "other"}
    /\ turn' = "none"
    /\ key' = IF turn = "retry" /\ Mode = "1.0.83" THEN FALSE ELSE key
    /\ timer' = CASE timer = "released" /\ TimerKind = "wait" -> "armed"
                  [] timer = "released" /\ TimerKind = "agent" -> "lost"
                  [] timer = "pollAfter" /\ turn = "retry" -> "armed"
                  [] OTHER -> timer
    /\ UNCHANGED <<owed, prompt, failed, cans, shutdown, owedCount, dispatched, gh>>

TimerFires ==
    /\ timer = "armed" /\ turn = "none" /\ owed = "none"
    /\ timer' = "fired"
    /\ UNCHANGED <<owed, key, prompt, turn, failed, cans, shutdown, owedCount, dispatched, gh>>

Done == turn = "none" /\ (shutdown \/ (owed = "none" /\ ~prompt)) /\ UNCHANGED vars

Next == TurnFails \/ FirstSucceeds \/ PromptArrives \/ ContinueAsNew \/ BeginShutdown \/ DrainForRetry
        \/ DispatchRetry \/ DispatchRetry82 \/ DispatchOther \/ FinishTurn \/ TimerFires \/ Done
Spec == Init /\ [][Next]_vars
Fairness == WF_vars(TurnFails \/ FirstSucceeds) /\ WF_vars(DrainForRetry) /\ WF_vars(DispatchRetry) /\ WF_vars(DispatchRetry82)
            /\ WF_vars(DispatchOther) /\ WF_vars(FinishTurn) /\ WF_vars(TimerFires)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK == /\ owed \in {"none", "fail", "fresh"} /\ turn \in {"none", "first", "retry", "other"}
          /\ timer \in {"none", "armed", "released", "pollAfter", "fired", "lost"}
          /\ {key, prompt, failed, shutdown} \subseteq BOOLEAN /\ cans \in 0..1
(* The owed retry runs before any other turn (outside a graceful shutdown). *)
Inv_RetryFirst == "otherFirst" \notin gh
(* Only the retry's own dispatch reuses the thrown attempt's key.          *)
Inv_KeyOnlyForRetry == "keyMisused" \notin gh
(* A lossy hand-off's retry is fresh: it carries no key and adopts nothing. *)
Inv_FreshNoKey == "freshKey" \notin gh
(* An owed retry is never lost: it is still owed or was dispatched.        *)
Inv_RetryNotLost == owedCount = dispatched + (IF owed = "none" THEN 0 ELSE 1)
(* An agent wait is kept for the retry, never lost.                        *)
Inv_AgentWaitKept == timer # "lost"

Prop_RetryDispatched == (owed # "none") ~> (owed = "none" /\ dispatched = owedCount)
Prop_WaitResumes == (timer = "released") ~> (timer \in {"armed", "fired"})

W_NoRetry == dispatched = 0
W_NoPollAfter == timer # "pollAfter"
=============================================================================
