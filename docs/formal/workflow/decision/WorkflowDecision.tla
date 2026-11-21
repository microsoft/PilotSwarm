--------------------------- MODULE WorkflowDecision ---------------------------
(***************************************************************************)
(* One Decision state's node execution on controller 1.2.0.                 *)
(*                                                                          *)
(* The controller enters the state (the store creates the node execution   *)
(* pending) and dispatches it: a live run starts the Decision effect       *)
(* (workflow-effect 1.1.0, input nodeType decision); a test run intercepts *)
(* it, and its parent or a fixture answers. The effect runs the            *)
(* runDecision activity; Duroxide records its result in the effect's      *)
(* history; recordEffectResult stores it with store.completeNode, the      *)
(* pending-only compare-and-swap; the controller routes from the stored    *)
(* result.                                                                  *)
(*                                                                          *)
(* runDecision is split into its steps: the read, the entry                *)
(* (store.enterScript counts the attempt under the locks, only for a       *)
(* pending node of an active run), the cap (attempt > 2 records            *)
(* unavailable), admission, the ledger claim (first only per attempt), the *)
(* provider call, and settlement in finally (first only per attempt,       *)
(* retried, its failure swallowed). A worker crash before the result is    *)
(* in history delivers the activity again (MaxCrash); local state is lost, *)
(* durable rows stay. A replay is no step.                                  *)
(*                                                                          *)
(* Faults name one protection removed on purpose; Faults = {} is the code. *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    TestRun,         \* the run is a test run (plan.test)
    Cancel,          \* a cancellation (or a deletion, or the run's deadline) may commit at any point
    MaxCrash,        \* worker crashes of runDecision before its result is in history
    MaxSettleRetry,  \* settlement calls the best-effort retry repeats, in the whole behaviour
    Faults           \* a subset of FaultNames

FaultNames == {"noIntercept", "noTestGuard", "noCap", "callBeforeClaim", "noEntryGuard",
               "settleNotFirstOnly", "settleAlters", "noCas"}
ASSUME TestRun \in BOOLEAN /\ Cancel \in BOOLEAN /\ MaxCrash \in Nat /\ MaxSettleRetry \in Nat
ASSUME Faults \subseteq FaultNames

F(name) == name \in Faults

None == "none"
Att == 1..(MaxCrash + 1)               \* attempt numbers: one per delivery of runDecision
Answers == {"yes", "uncertain"}        \* business outcomes after the semantic policy (a noul question with confidence)
ProviderErrors == {"timed_out"}        \* a DecisionProviderError code: a runtime error
Runtime == {"unavailable", "execution_failed", "cancelled"} \cup ProviderErrors
KindOf(r) == IF r \in Answers THEN "business" ELSE "runtime_error"

VARIABLES
    \* store: the run and the node execution
    runActive, node, nodeRes, nodeKind, nodeWinner, attempts,
    \* provider ledger (provider_inference_operations)
    claimed, settledN,
    \* the Decision effect and its runDecision activity (act* is the activity's local state)
    eff, act, actAtt, actRes, actClaimed, hist, histAtt, settleTries,
    \* controller
    ctrl, intercepted, route,
    \* bound and ghosts (no action's guard reads a ghost)
    crashes, calls, called, callAns, enteredLive, unclaimedCall, lateCall, firstWinner, firstRes

storeVars == <<runActive, node, nodeRes, nodeKind, nodeWinner, attempts>>
ledgerVars == <<claimed, settledN>>
effVars == <<eff, act, actAtt, actRes, actClaimed, hist, histAtt, settleTries>>
ctrlVars == <<ctrl, intercepted, route>>
ghostVars == <<crashes, calls, called, callAns, enteredLive, unclaimedCall, lateCall, firstWinner, firstRes>>
vars == <<storeVars, ledgerVars, effVars, ctrlVars, ghostVars>>

Init ==
    /\ runActive = TRUE /\ node = "absent" /\ nodeRes = None /\ nodeKind = None /\ nodeWinner = None /\ attempts = 0
    /\ claimed = {} /\ settledN = [a \in Att |-> 0]
    /\ eff = "absent" /\ act = "idle" /\ actAtt = 0 /\ actRes = None /\ actClaimed = FALSE
    /\ hist = None /\ histAtt = 0 /\ settleTries = 0
    /\ ctrl = "enter" /\ intercepted = FALSE /\ route = None
    /\ crashes = 0 /\ calls = 0 /\ called = {} /\ callAns = [a \in Att |-> None]
    /\ enteredLive = [a \in Att |-> FALSE] /\ unclaimedCall = FALSE /\ lateCall = FALSE
    /\ firstWinner = None /\ firstRes = None

\* The single terminal compare-and-swap of a node execution: only a pending node is decided. With "noCas" the effect's
\* record overwrites a decided node (overwrite = TRUE only there).
Decide(res, winner, overwrite) ==
    IF node = "pending" \/ (overwrite /\ node = "completed")
    THEN /\ node' = "completed" /\ nodeRes' = res /\ nodeKind' = KindOf(res) /\ nodeWinner' = winner
         /\ firstWinner' = IF firstWinner = None THEN winner ELSE firstWinner
         /\ firstRes' = IF firstRes = None THEN res ELSE firstRes
    ELSE UNCHANGED <<node, nodeRes, nodeKind, nodeWinner, firstWinner, firstRes>>

(***************************************************************************)
(* Controller 1.2.0                                                         *)
(***************************************************************************)

\* store.enter: the node execution is created pending (the run must be active).
Enter ==
    /\ ctrl = "enter" /\ runActive
    /\ node' = "pending" /\ ctrl' = "entered"
    /\ UNCHANGED <<runActive, nodeRes, nodeKind, nodeWinner, attempts>>
    /\ UNCHANGED <<ledgerVars, effVars, intercepted, route, ghostVars>>

\* A test run's Decision is intercepted (workflow.intercept); a live one starts the Decision effect at its own version,
\* with nodeType decision. "noIntercept": the test Decision starts the effect too.
Dispatch ==
    /\ ctrl = "entered"
    /\ IF TestRun /\ ~F("noIntercept")
       THEN intercepted' = TRUE /\ UNCHANGED eff
       ELSE eff' = "started" /\ UNCHANGED intercepted
    /\ ctrl' = "dispatched"
    /\ UNCHANGED <<storeVars, ledgerVars, act, actAtt, actRes, actClaimed, hist, histAtt, settleTries, route, ghostVars>>

\* The parent or a fixture answers the interception: store.respondInterception decides the node (winner test).
TestAnswer ==
    /\ intercepted /\ node = "pending" /\ runActive
    /\ \E r \in Answers : Decide(r, "test", FALSE)
    /\ UNCHANGED <<runActive, attempts, ledgerVars, effVars, ctrlVars>>
    /\ UNCHANGED <<crashes, calls, called, callAns, enteredLive, unclaimedCall, lateCall>>

\* Collect and route from the stored result: a business outcome by its name, a runtime error by failure (selectRoute;
\* a runtime error named in the routes is abstracted to failure).
Route ==
    /\ ctrl = "dispatched" /\ runActive /\ node = "completed" /\ route = None
    /\ route' = IF nodeKind = "business" THEN nodeRes ELSE "failure"
    /\ ctrl' = "routed"
    /\ UNCHANGED <<storeVars, ledgerVars, effVars, intercepted, ghostVars>>

\* A cancellation (or a deletion, or the run's deadline) ends the run and decides its pending node in one transaction.
CancelRun ==
    /\ Cancel /\ runActive
    /\ runActive' = FALSE
    /\ Decide("cancelled", "cancel", FALSE)
    /\ UNCHANGED <<attempts, ledgerVars, effVars, ctrlVars>>
    /\ UNCHANGED <<crashes, calls, called, callAns, enteredLive, unclaimedCall, lateCall>>

(***************************************************************************)
(* The Decision effect (1.1.0) and its runDecision activity                 *)
(***************************************************************************)

\* runDecision is delivered and reads the node: a decided node is { kind: "completed" } (nothing to record); a test run
\* is refused before entry (it throws; the effect records execution_failed). "noTestGuard" removes that refusal.
ActRead ==
    /\ eff = "started" /\ act = "idle" /\ hist = None
    /\ IF node = "completed"
       THEN act' = "returned" /\ actRes' = "noop"
       ELSE IF TestRun /\ ~F("noTestGuard")
       THEN act' = "returned" /\ actRes' = "execution_failed"
       ELSE act' = "entry" /\ UNCHANGED actRes
    /\ UNCHANGED <<storeVars, ledgerVars, eff, actAtt, actClaimed, hist, histAtt, settleTries, ctrlVars, ghostVars>>

\* store.enterScript: one transaction under the session, run and node locks counts the attempt of a pending node of an
\* active run. "noEntryGuard": the attempt is counted whatever the node and the run.
ActEnter ==
    /\ act = "entry" /\ attempts + 1 \in Att
    /\ LET live == node = "pending" /\ runActive
       IN IF live \/ F("noEntryGuard")
          THEN /\ attempts' = attempts + 1 /\ actAtt' = attempts + 1
               /\ enteredLive' = [enteredLive EXCEPT ![attempts + 1] = live]
               /\ act' = "entered" /\ UNCHANGED actRes
          ELSE /\ act' = "returned" /\ actRes' = "noop"
               /\ UNCHANGED <<attempts, actAtt, enteredLive>>
    /\ UNCHANGED <<runActive, node, nodeRes, nodeKind, nodeWinner, ledgerVars, eff, actClaimed, hist, histAtt, settleTries>>
    /\ UNCHANGED <<ctrlVars, crashes, calls, called, callAns, unclaimedCall, lateCall, firstWinner, firstRes>>

\* The cap: a third (or later) delivery records unavailable, with no claim and no call. "noCap" removes it.
ActCap ==
    /\ act = "entered"
    /\ IF actAtt > 2 /\ ~F("noCap")
       THEN act' = "returned" /\ actRes' = "unavailable"
       ELSE act' = "admit" /\ UNCHANGED actRes
    /\ UNCHANGED <<storeVars, ledgerVars, eff, actAtt, actClaimed, hist, histAtt, settleTries, ctrlVars, ghostVars>>

\* Binding, host, budget admission and provider resolution: admitted, or a runtime error with no claim (abstracted to
\* unavailable). "callBeforeClaim": the call comes first.
ActAdmit ==
    /\ act = "admit"
    /\ \/ act' = (IF F("callBeforeClaim") THEN "call" ELSE "claim") /\ UNCHANGED actRes
       \/ act' = "returned" /\ actRes' = "unavailable"
    /\ UNCHANGED <<storeVars, ledgerVars, eff, actAtt, actClaimed, hist, histAtt, settleTries, ctrlVars, ghostVars>>

\* The ledger claim of (operation, attempt): first only (ON CONFLICT DO NOTHING). Not first: execution_failed, no call.
ActClaim ==
    /\ act = "claim"
    /\ IF actAtt \in claimed
       THEN act' = "returned" /\ actRes' = "execution_failed" /\ UNCHANGED <<claimed, actClaimed>>
       ELSE /\ claimed' = claimed \cup {actAtt} /\ actClaimed' = TRUE
            /\ act' = (IF F("callBeforeClaim") THEN "settle" ELSE "call") /\ UNCHANGED actRes
    /\ UNCHANGED <<storeVars, settledN, eff, actAtt, hist, histAtt, settleTries, ctrlVars, ghostVars>>

\* The provider call: an answer (after the semantic policy) or a provider error. A call may start after a cancellation
\* that committed after the entry; the liveness check then aborts it (an error) and its result loses the CAS.
ActCall ==
    /\ act = "call"
    /\ calls' = calls + 1 /\ called' = called \cup {actAtt}
    /\ unclaimedCall' = (unclaimedCall \/ actAtt \notin claimed)
    /\ lateCall' = (lateCall \/ node # "pending" \/ ~runActive)
    /\ \E r \in Answers \cup ProviderErrors :
          /\ callAns' = [callAns EXCEPT ![actAtt] = r]
          /\ actRes' = r
    /\ act' = IF F("callBeforeClaim") THEN "claim" ELSE "settle"
    /\ UNCHANGED <<storeVars, ledgerVars, eff, actAtt, actClaimed, hist, histAtt, settleTries, ctrlVars>>
    /\ UNCHANGED <<crashes, enteredLive, firstWinner, firstRes>>

\* finally: a claimed attempt is settled with the best-effort retry; the ledger settles an attempt once (settled_at IS
\* NULL). A call that commits may lose its reply and be repeated; a failure is swallowed and never changes the result.
\* "settleNotFirstOnly": a repeated settlement counts again. "settleAlters": a swallowed failure turns the result into
\* execution_failed.
Settled(a) == [settledN EXCEPT ![a] = IF @ = 0 \/ F("settleNotFirstOnly") THEN @ + 1 ELSE @]
ActSettle ==
    /\ act = "settle"
    /\ IF ~actClaimed
       THEN act' = "returned" /\ UNCHANGED <<settledN, settleTries, actRes>>
       ELSE \/ /\ settledN' = Settled(actAtt) /\ act' = "returned" /\ UNCHANGED <<settleTries, actRes>>
            \/ /\ settleTries < MaxSettleRetry /\ settleTries' = settleTries + 1
               /\ settledN' = Settled(actAtt) /\ UNCHANGED <<act, actRes>>
            \/ /\ settleTries < MaxSettleRetry /\ settleTries' = settleTries + 1
               /\ UNCHANGED <<settledN, act, actRes>>
            \/ /\ act' = "returned" /\ UNCHANGED <<settledN, settleTries>>
               /\ actRes' = IF F("settleAlters") THEN "execution_failed" ELSE actRes
    /\ UNCHANGED <<storeVars, claimed, eff, actAtt, actClaimed, hist, histAtt, ctrlVars, ghostVars>>

\* Duroxide records the activity's result in the effect's history; the activity is not delivered again.
ActRecord ==
    /\ act = "returned"
    /\ hist' = actRes /\ histAtt' = actAtt /\ act' = "done"
    /\ UNCHANGED <<storeVars, ledgerVars, eff, actAtt, actRes, actClaimed, settleTries, ctrlVars, ghostVars>>

\* A worker crash before the result is in history: runDecision is delivered again.
Crash ==
    /\ act \in {"entry", "entered", "admit", "claim", "call", "settle", "returned"}
    /\ crashes < MaxCrash
    /\ crashes' = crashes + 1
    /\ act' = "idle" /\ actAtt' = 0 /\ actRes' = None /\ actClaimed' = FALSE
    /\ UNCHANGED <<storeVars, ledgerVars, eff, hist, histAtt, settleTries, ctrlVars>>
    /\ UNCHANGED <<calls, called, callAns, enteredLive, unclaimedCall, lateCall, firstWinner, firstRes>>

\* recordEffectResult: store.completeNode with the recorded result ({ kind: "completed" } records nothing); then wake.
\* "noCas": the record overwrites a decided node.
EffRecord ==
    /\ eff = "started" /\ hist # None
    /\ IF hist = "noop"
       THEN UNCHANGED <<node, nodeRes, nodeKind, nodeWinner, firstWinner, firstRes>>
       ELSE Decide(hist, "effect", F("noCas"))
    /\ eff' = "recorded"
    /\ UNCHANGED <<runActive, attempts, ledgerVars, act, actAtt, actRes, actClaimed, hist, histAtt, settleTries>>
    /\ UNCHANGED <<ctrlVars, crashes, calls, called, callAns, enteredLive, unclaimedCall, lateCall>>

\* Nothing is left to do: the run routed or ended, and the effect (if any) recorded.
Done ==
    /\ act \in {"idle", "done"} /\ eff \in {"absent", "recorded"}
    /\ (ctrl = "routed" \/ ~runActive)
    /\ UNCHANGED vars

Progress == Enter \/ Dispatch \/ Route \/ ActRead \/ ActEnter \/ ActCap \/ ActAdmit \/ ActClaim \/ ActCall
            \/ ActSettle \/ ActRecord \/ EffRecord
Next == Progress \/ TestAnswer \/ CancelRun \/ Crash \/ Done
\* Fairness: the controller and the effect keep working; crashes are bounded; a cancellation and a test answer are free.
Spec == Init /\ [][Next]_vars /\ WF_vars(Progress)

TypeOK ==
    /\ runActive \in BOOLEAN /\ node \in {"absent", "pending", "completed"}
    /\ nodeRes \in Answers \cup Runtime \cup {None} /\ nodeKind \in {"business", "runtime_error", None}
    /\ nodeWinner \in {"effect", "cancel", "test", None} /\ attempts \in 0..(MaxCrash + 1)
    /\ claimed \subseteq Att /\ settledN \in [Att -> 0..(MaxSettleRetry + 1)]
    /\ eff \in {"absent", "started", "recorded"}
    /\ act \in {"idle", "entry", "entered", "admit", "claim", "call", "settle", "returned", "done"}
    /\ actAtt \in 0..(MaxCrash + 1) /\ actRes \in Answers \cup Runtime \cup {None, "noop"} /\ actClaimed \in BOOLEAN
    /\ hist \in Answers \cup Runtime \cup {None, "noop"} /\ histAtt \in 0..(MaxCrash + 1)
    /\ ctrl \in {"enter", "entered", "dispatched", "routed"} /\ intercepted \in BOOLEAN
    /\ route \in Answers \cup {None, "failure"}
    /\ crashes \in 0..MaxCrash /\ called \subseteq Att /\ callAns \in [Att -> Answers \cup ProviderErrors \cup {None}]

\* At most two provider deliveries per node execution; a third or later delivery makes no claim and no call.
Inv_CallCap == calls <= 2 /\ \A a \in claimed \cup called : a <= 2
\* Every provider call's attempt was claimed in the ledger before the call, and each attempt is called at most once.
Inv_ClaimBeforeCall == ~unclaimedCall /\ calls = Cardinality(called)
\* An attempt is settled at most once, and only a claimed one.
Inv_SettleOnce == \A a \in Att : settledN[a] <= 1 /\ (settledN[a] > 0 => a \in claimed)
\* Settlement never changes the Decision result: the recorded result of a called attempt is its call's answer.
Inv_SettlementInert == histAtt \in called => hist = callAns[histAtt]
\* Provider work (a claim or a call) happens only for a delivery whose entry committed while the node was pending and
\* the run active: a cancellation or lifecycle end that commits first stops the delivery before provider work.
Inv_NoWorkAfterDecided == \A a \in claimed \cup called : enteredLive[a]
\* The node's first decision is final.
Inv_FirstWinnerKept == firstWinner # None => (nodeWinner = firstWinner /\ nodeRes = firstRes)
\* An effect's stored result is the one in its history.
Inv_ResultFromHistory == nodeWinner = "effect" => nodeRes = hist
\* Routing reads the stored result only, and never a pending node.
Inv_RouteFromStored == route # None => (node = "completed" /\ route = IF nodeKind = "business" THEN nodeRes ELSE "failure")
\* A test run's Decision starts no effect; and touches no provider.
Inv_TestNoEffect == TestRun => eff = "absent"
Inv_TestNoProvider == TestRun => (claimed = {} /\ calls = 0)
\* A live Decision is never intercepted.
Inv_LiveNotIntercepted == ~TestRun => ~intercepted

\* Liveness (a live run, no cancellation): the state is routed.
Prop_Routed == <>(route # None)

\* Witnesses (each must be violated).
W_NoCall == calls = 0
W_NoRecoveryCall == calls < 2
W_NoThirdRefusal == ~(hist = "unavailable" /\ histAtt = 3)
W_NoUncertainRoute == route # "uncertain"
W_NoLateLoss == ~(eff = "recorded" /\ nodeWinner = "cancel" /\ hist \in Answers)
W_NoCallAfterCancel == ~lateCall
W_ClaimsSettled == (eff = "recorded") => \A a \in claimed : settledN[a] > 0
W_TestNotRouted == ~(TestRun /\ nodeWinner = "test" /\ route \in Answers)
==============================================================================
