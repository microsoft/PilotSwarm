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
(* tf1 (2026-11-10, 1.0.83 changed in place): the retry may fail too, its  *)
(* retries spent (AllowExhaust): the turn is terminal and the session goes *)
(* idle with an error. With Report = "fix", a turn that carries a Workflow *)
(* visit owes the store a failure report (a durable activity): it is owed *)
(* only once the failure is terminal, carried across continue-as-new, and *)
(* sent once. Report = "none" is the code before the fix. AllowLaterSuccess: *)
(* a later turn succeeds while the report is still owed (its activity     *)
(* failed so far): the report is dropped (d3230de4 handleTurnResult: no   *)
(* report after a success).                                               *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    TimerKind,      \* "none", "wait", "agent": the timer armed when the retry is owed
    AllowHandoff,   \* the failure may be a lossy hand-off (a fresh retry)
    AllowShutdown,  \* a graceful shutdown may be pending
    Mode,           \* "1.0.83" or "1.0.82" (comparison: the retry is the pending prompt; the key stays)
    Fault,          \* "none", "other-first", "drop-at-can", "agent-released", "fresh-with-key", "report-early",
                    \* "drop-report-at-can"
    AllowExhaust,   \* tf1: the retry may fail with its retries spent (a terminal failure)
    Report,         \* tf1: "none" (no report) or "fix" (a terminal failure of a Workflow visit's turn is reported)
    AllowLaterSuccess \* tf1: a later turn succeeds while the report is owed; the report is dropped

ASSUME TimerKind \in {"none", "wait", "agent"} /\ AllowHandoff \in BOOLEAN /\ AllowShutdown \in BOOLEAN
ASSUME Mode \in {"1.0.83", "1.0.82"}
ASSUME Fault \in {"none", "other-first", "drop-at-can", "agent-released", "fresh-with-key", "report-early", "drop-report-at-can"}
ASSUME AllowExhaust \in BOOLEAN /\ Report \in {"none", "fix"} /\ AllowLaterSuccess \in BOOLEAN

VARIABLES
    owed,       \* the owned retry: "none", "fail" (with the thrown key), "fresh" (lossy hand-off)
    key,        \* the thrown attempt's key is in state
    prompt,     \* another prompt is queued
    turn,       \* the running turn: "none", "first", "retry", "other"
    timer,      \* "none", "armed", "released", "pollAfter", "fired", "lost"
    failed,     \* the first turn has failed (once)
    cans, shutdown,
    owedCount, dispatched,
    terminal,   \* tf1: the turn failed with its retries spent
    rep,        \* tf1: the failure report: "none", "owed", "sent", "dropped"
    repCount,   \* tf1: reports sent
    gh
vars == <<owed, key, prompt, turn, timer, failed, cans, shutdown, owedCount, dispatched, terminal, rep, repCount, gh>>

Init ==
    /\ owed = "none" /\ key = FALSE /\ prompt = FALSE /\ turn = "first"
    /\ timer = IF TimerKind = "none" THEN "none" ELSE "armed"
    /\ failed = FALSE /\ cans = 0 /\ shutdown = FALSE /\ owedCount = 0 /\ dispatched = 0 /\ gh = {}
    /\ terminal = FALSE /\ rep = "none" /\ repCount = 0

(* The first turn fails: its retry is owed (a lossy hand-off: fresh).      *)
TurnFails ==
    /\ turn = "first" /\ ~failed
    /\ \E fresh \in (IF AllowHandoff THEN BOOLEAN ELSE {FALSE}) :
         /\ owed' = IF fresh THEN "fresh" ELSE "fail"
         /\ key' = (~fresh \/ Fault = "fresh-with-key")
    /\ turn' = "none" /\ failed' = TRUE /\ owedCount' = owedCount + 1
    /\ rep' = IF Report = "fix" /\ Fault = "report-early" THEN "owed" ELSE rep
    /\ UNCHANGED <<prompt, timer, cans, shutdown, dispatched, gh, terminal, repCount>>

FirstSucceeds ==
    /\ turn = "first" /\ turn' = "none"
    /\ UNCHANGED <<owed, key, prompt, timer, failed, cans, shutdown, owedCount, dispatched, gh, terminal, rep, repCount>>

PromptArrives ==
    /\ ~prompt /\ prompt' = TRUE
    /\ UNCHANGED <<owed, key, turn, timer, failed, cans, shutdown, owedCount, dispatched, gh, terminal, rep, repCount>>

(* Continue-as-new between turns carries the owned retry.                 *)
ContinueAsNew ==
    /\ turn = "none" /\ cans < 1 /\ (owed # "none" \/ rep = "owed")
    /\ cans' = cans + 1
    /\ owed' = IF Fault = "drop-at-can" THEN "none" ELSE owed
    /\ rep' = IF Fault = "drop-report-at-can" /\ rep = "owed" THEN "none" ELSE rep
    /\ UNCHANGED <<key, prompt, turn, timer, failed, shutdown, owedCount, dispatched, gh, terminal, repCount>>

BeginShutdown ==
    /\ AllowShutdown /\ ~shutdown /\ shutdown' = TRUE
    /\ UNCHANGED <<owed, key, prompt, turn, timer, failed, cans, owedCount, dispatched, gh, terminal, rep, repCount>>

(* drain while a retry is owed: an armed wait is released for it; an agent *)
(* wait is kept and its poll queued after the retry.                      *)
DrainForRetry ==
    /\ Mode = "1.0.83" /\ owed # "none" /\ turn = "none" /\ timer = "armed"
    /\ timer' = IF TimerKind = "agent" /\ Fault # "agent-released" THEN "pollAfter" ELSE "released"
    /\ UNCHANGED <<owed, key, prompt, turn, failed, cans, shutdown, owedCount, dispatched, gh, terminal, rep, repCount>>

(* decide: the owed retry first (not during a graceful shutdown).         *)
DispatchRetry ==
    /\ Mode = "1.0.83" /\ owed # "none" /\ turn = "none" /\ ~shutdown
    /\ turn' = "retry" /\ owed' = "none" /\ dispatched' = dispatched + 1
    /\ gh' = gh \cup (IF owed = "fresh" /\ key THEN {"freshKey"} ELSE {})
    /\ UNCHANGED <<key, prompt, timer, failed, cans, shutdown, owedCount, terminal, rep, repCount>>

(* 1.0.82: the retry is the pending prompt, taken with any queued prompt;  *)
(* (In 1.0.83 the key belongs to the owned-retry record; another turn      *)
(* never sees it.)                                                         *)
(* the thrown key stays in state for whichever turn runs next.            *)
DispatchRetry82 ==
    /\ Mode = "1.0.82" /\ owed # "none" /\ turn = "none" /\ ~shutdown
    /\ turn' = "retry" /\ owed' = "none" /\ dispatched' = dispatched + 1
    /\ UNCHANGED <<key, prompt, timer, failed, cans, shutdown, owedCount, gh, terminal, rep, repCount>>

DispatchOther ==
    /\ prompt /\ turn = "none"
    /\ (owed = "none" \/ shutdown \/ Fault = "other-first" \/ Mode = "1.0.82")
    /\ turn' = "other" /\ prompt' = FALSE
    /\ gh' = gh \cup (IF owed # "none" /\ ~shutdown /\ Mode = "1.0.83" THEN {"otherFirst"} ELSE {})
                \cup (IF key /\ Mode = "1.0.82" THEN {"keyMisused"} ELSE {})
    /\ UNCHANGED <<owed, key, timer, failed, cans, shutdown, owedCount, dispatched, terminal, rep, repCount>>

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
    /\ UNCHANGED <<owed, prompt, failed, cans, shutdown, owedCount, dispatched, gh, terminal, rep, repCount>>

(* tf1: the retry fails with its retries spent: the turn is terminal, the   *)
(* session goes idle with an error; with the fix the failure is owed to    *)
(* the store (the turn carries a Workflow visit).                          *)
RetryExhausted ==
    /\ AllowExhaust /\ turn = "retry"
    /\ turn' = "none" /\ terminal' = TRUE
    /\ key' = IF Mode = "1.0.83" THEN FALSE ELSE key
    /\ timer' = CASE timer = "released" /\ TimerKind = "wait" -> "armed"
                  [] timer = "released" /\ TimerKind = "agent" -> "lost"
                  [] timer = "pollAfter" -> "armed"
                  [] OTHER -> timer
    /\ rep' = IF Report = "fix" /\ rep = "none" THEN "owed" ELSE rep
    /\ UNCHANGED <<owed, prompt, failed, cans, shutdown, owedCount, dispatched, repCount, gh>>

(* tf1: the report activity reaches the store (its own retries are        *)
(* transparent: one report per terminal failure).                          *)
ReportSend ==
    /\ rep = "owed"
    /\ rep' = "sent" /\ repCount' = repCount + 1
    /\ gh' = gh \cup (IF ~terminal THEN {"earlyReport"} ELSE {})
    /\ UNCHANGED <<owed, key, prompt, turn, timer, failed, cans, shutdown, owedCount, dispatched, terminal>>

(* tf1: a later turn succeeds while the report is owed: it is dropped.     *)
LaterSuccess ==
    /\ AllowLaterSuccess /\ terminal /\ rep = "owed" /\ turn = "none"
    /\ rep' = "dropped"
    /\ UNCHANGED <<owed, key, prompt, turn, timer, failed, cans, shutdown, owedCount, dispatched, terminal, repCount, gh>>

TimerFires ==
    /\ timer = "armed" /\ turn = "none" /\ owed = "none"
    /\ timer' = "fired"
    /\ UNCHANGED <<owed, key, prompt, turn, failed, cans, shutdown, owedCount, dispatched, gh, terminal, rep, repCount>>

Done == turn = "none" /\ rep # "owed" /\ (shutdown \/ (owed = "none" /\ ~prompt)) /\ UNCHANGED vars

Next == TurnFails \/ FirstSucceeds \/ PromptArrives \/ ContinueAsNew \/ BeginShutdown \/ DrainForRetry
        \/ DispatchRetry \/ DispatchRetry82 \/ DispatchOther \/ FinishTurn \/ TimerFires \/ Done
        \/ RetryExhausted \/ ReportSend \/ LaterSuccess
Spec == Init /\ [][Next]_vars
Fairness == WF_vars(TurnFails \/ FirstSucceeds) /\ WF_vars(DrainForRetry) /\ WF_vars(DispatchRetry) /\ WF_vars(DispatchRetry82)
            /\ WF_vars(DispatchOther) /\ WF_vars(FinishTurn \/ RetryExhausted) /\ WF_vars(TimerFires) /\ WF_vars(ReportSend)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK == /\ owed \in {"none", "fail", "fresh"} /\ turn \in {"none", "first", "retry", "other"}
          /\ timer \in {"none", "armed", "released", "pollAfter", "fired", "lost"}
          /\ {key, prompt, failed, shutdown, terminal} \subseteq BOOLEAN /\ cans \in 0..1
          /\ rep \in {"none", "owed", "sent", "dropped"} /\ repCount \in 0..2
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

(* tf1: a report is owed only after a terminal failure, is never lost      *)
(* (across continue-as-new too), and is sent once; a terminal failure is   *)
(* reported.                                                               *)
Inv_NoReportBeforeTerminal == "earlyReport" \notin gh
Inv_ReportNotLost == (terminal /\ Report = "fix") => rep # "none"
Inv_ReportOnce == repCount <= 1
Prop_TerminalReported == terminal ~> (rep = "sent")
(* With a later success: the report is sent or dropped by that success.    *)
Prop_TerminalSettled == terminal ~> (rep \in {"sent", "dropped"})
Prop_RetryDispatched == (owed # "none") ~> (owed = "none" /\ dispatched = owedCount)
Prop_WaitResumes == (timer = "released") ~> (timer \in {"armed", "fired"})

W_NoRetry == dispatched = 0
W_NoPollAfter == timer # "pollAfter"
W_NoTerminalReport == rep # "sent"
W_NoDroppedReport == rep # "dropped"
=============================================================================
