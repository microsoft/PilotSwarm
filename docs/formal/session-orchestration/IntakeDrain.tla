------------------------------ MODULE IntakeDrain ------------------------------
(***************************************************************************)
(* The 1.0.83 run loop around the durable Workflow intake                  *)
(* (orchestration_1_0_83/ at e76a6133): a due intake write is a third      *)
(* deadline drain races (queue.ts 482-520, 797-812); each wake makes at    *)
(* most one intake activity call; the loop does not continue as new while  *)
(* a write is due (runtime.ts 303). An unanswered arrival's flag rides     *)
(* every continue-as-new (lifecycle.ts 749-750; set intake-wiring.ts 326, *)
(* cleared 584, restored state.ts 804).                                    *)
(* At the history-size cap the continue-as-new runs outside the stats      *)
(* read's try (runtime.ts 253-278): a refused continue-as-new fails the    *)
(* execution (1.0.82 swallowed it and the loop went on). Every 1.0.83      *)
(* continue-as-new refuses a target older than itself                      *)
(* (assertIntakeContinueAsNewTarget, intake-state.ts 534-545); the target  *)
(* is the latest version, which is 1.0.82 at e76a6133                      *)
(* (orchestration-version.ts 15; 1.0.83 is inactive, line 33). 1.0.83      *)
(* turns run as runTurnV5 with                                             *)
(* the intake routing tag, registered only on a worker with the Workflow   *)
(* test option (activity-routing.ts 10-22, 93-128; session-proxy.ts 5778; *)
(* milestone-worker.ts 45-46).                                             *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Cap,            \* loop iterations before the history-size continue-as-new
    Latest83,       \* the continue-as-new target accepts 1.0.83 state (FALSE at e76a6133: latest is 1.0.82)
    Mode,           \* "1.0.83" or "1.0.82" (comparison: a refused continue-as-new is swallowed)
    MaxCan,         \* continue-as-new taken at most
    Fault           \* "none", "can-while-due", "two-calls", "drop-arrival-flag", "downgrade", "route-any"

ASSUME Cap \in 1..3 /\ Latest83 \in BOOLEAN /\ Mode \in {"1.0.83", "1.0.82"} /\ MaxCan \in 0..2
ASSUME Fault \in {"none", "can-while-due", "two-calls", "drop-arrival-flag", "downgrade", "route-any"}

VARIABLES
    hist,       \* loop iterations since the last continue-as-new
    due,        \* an intake write is due
    writes,     \* intake writes made (the activity calls)
    arrival,    \* an unanswered arrival's flag: "none", "pending", "turned"
    cans,       \* continue-as-new taken
    failed,     \* the execution failed
    worker,     \* where the last turn activity ran: "none", "intake", "plain"
    gh
vars == <<hist, due, writes, arrival, cans, failed, worker, gh>>

Init == hist = 0 /\ due = FALSE /\ writes = 0 /\ arrival = "none" /\ cans = 0 /\ failed = FALSE /\ worker = "none" /\ gh = {}

Live == ~failed

BecomeDue ==
    /\ Live /\ ~due /\ writes < 2
    /\ due' = TRUE
    /\ UNCHANGED <<hist, writes, arrival, cans, failed, worker, gh>>

(* drain: the race fires at the due write; one intake activity call.      *)
WakeWrite ==
    /\ Live /\ due
    /\ due' = FALSE
    /\ writes' = writes + (IF Fault = "two-calls" THEN 2 ELSE 1)
    /\ gh' = gh \cup (IF Fault = "two-calls" THEN {"twoCalls"} ELSE {})
    /\ UNCHANGED <<hist, arrival, cans, failed, worker>>

Arrive ==
    /\ Live /\ arrival = "none"
    /\ arrival' = "pending" /\ gh' = gh \cup {"arrived"}
    /\ UNCHANGED <<hist, due, writes, cans, failed, worker>>

(* The one turn an arrival starts for its parked invocation.               *)
ArrivalTurn ==
    /\ Live /\ arrival = "pending"
    /\ arrival' = "turned"
    /\ worker' = IF Fault = "route-any" THEN "plain" ELSE "intake"
    /\ gh' = gh \cup (IF Fault = "route-any" THEN {"misrouted"} ELSE {})
    /\ UNCHANGED <<hist, due, writes, cans, failed>>

(* The loop goes past the cap only while a write is due (no continue-as-new *)
(* then), after the model's last continue-as-new, or when 1.0.82 swallowed *)
(* a refused continue-as-new.                                             *)
Loop ==
    /\ Live /\ hist < Cap + 1
    /\ (hist < Cap \/ due \/ cans = MaxCan \/ "swallowed" \in gh)
    /\ hist' = hist + 1
    /\ gh' = gh \cup (IF hist + 1 > Cap /\ ~due /\ cans < MaxCan THEN {"pastCap"} ELSE {})
    /\ UNCHANGED <<due, writes, arrival, cans, failed, worker>>

(* The history-size continue-as-new: not while a write is due; refused     *)
(* when the target is older than 1.0.83.                                  *)
ContinueAsNew ==
    /\ Live /\ hist >= Cap /\ cans < MaxCan
    /\ (~due \/ Fault = "can-while-due")
    /\ gh' = gh \cup (IF due THEN {"canWhileDue"} ELSE {})
               \cup (IF ~Latest83 /\ Fault = "downgrade" THEN {"downgraded"} ELSE {})
               \cup (IF ~Latest83 /\ Fault # "downgrade" /\ Mode = "1.0.82" THEN {"swallowed"} ELSE {})
    /\ IF Latest83 \/ Fault = "downgrade"
       THEN /\ hist' = 0 /\ cans' = cans + 1
            /\ arrival' = IF arrival = "pending" /\ Fault = "drop-arrival-flag" THEN "none" ELSE arrival
            /\ UNCHANGED <<failed>>
       ELSE IF Mode = "1.0.83"
       THEN /\ failed' = TRUE /\ UNCHANGED <<hist, cans, arrival>>
       ELSE \* 1.0.82: the refusal is swallowed; the loop goes on
            /\ UNCHANGED <<hist, cans, arrival, failed>>
    /\ UNCHANGED <<due, writes, worker>>

Done == (failed \/ (cans = MaxCan /\ ~due)) /\ UNCHANGED vars

Next == BecomeDue \/ WakeWrite \/ Arrive \/ ArrivalTurn \/ Loop \/ ContinueAsNew \/ Done
Spec == Init /\ [][Next]_vars
Fairness == WF_vars(WakeWrite) /\ WF_vars(ArrivalTurn) /\ WF_vars(ContinueAsNew)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK == hist \in 0..(Cap + 1) /\ {due, failed} \subseteq BOOLEAN /\ writes \in 0..4
          /\ arrival \in {"none", "pending", "turned"} /\ cans \in 0..MaxCan /\ worker \in {"none", "intake", "plain"}
(* I05: no continue-as-new while an intake write is due; one call a wake.  *)
Inv_NoCanWhileDue == "canWhileDue" \notin gh
Inv_OneCallPerWake == "twoCalls" \notin gh
(* I08: an arrival's flag is never lost: once pending it stays pending     *)
(* until its turn starts.                                                 *)
Inv_ArrivalKept == ("arrived" \in gh) => arrival # "none"
(* N01: past the history cap the loop does not go on silently.            *)
Inv_HistoryBounded == "pastCap" \notin gh
(* N02: 1.0.83 never continues as an older version.                       *)
Inv_NoDowngrade == "downgraded" \notin gh
(* N10: a 1.0.83 turn runs only on a worker that registered the intake      *)
(* routing.                                                                *)
Inv_RoutedToIntakeWorker == "misrouted" \notin gh
(* N02 at e76a6133: a 1.0.83 session's continue-as-new fails its execution. *)
Inv_NoExecutionFailure == ~failed

Prop_WriteMade == due ~> (~due \/ failed)
Prop_ArrivalTurns == (arrival = "pending") ~> (arrival = "turned" \/ failed)

W_NoCan == cans = 0
W_NoWrite == writes = 0
=============================================================================
