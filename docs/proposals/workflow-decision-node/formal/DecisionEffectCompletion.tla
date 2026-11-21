--------------------- MODULE DecisionEffectCompletion ---------------------
(***************************************************************************)
(* Base-pinned v10 design evidence at b71f78d2e6c80603d4e3a2a43c756e4a03fe98fa. *)
(* At that source, the cap was proposed and enterScript had none.          *)
(* Repaired implementation comparison head 6591fe14f043703c8985923ce3f96baf409932d3. *)
(* That head caps runDecision after entry; a final-head review is still pending. *)
(* Provider results enter Duroxide history before the pending-only CAS.    *)
(* Runtime errors route through failure and hand off stored error.         *)
(* This model is not TLC, proof, or final-head implementation evidence.     *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Results
ASSUME Results # {}

NONE == "none"
PENDING == "pending"
COMPLETED == "completed"
BUSINESS == "business"
RUNTIME_ERROR == "runtime_error"
UNAVAILABLE == "unavailable"
TIMEOUT == "timed_out"
CANCEL == "cancelled"
FAILURE == "failure"

VARIABLES
  nodeState, nodeOutcome, nodeKind, nodeOutput, nodeError,
  entries, providerCalls, effect, activityOutcome,
  activityKind, activityValue, due, runLive,
  route, nextInput, commits

vars == <<nodeState, nodeOutcome, nodeKind, nodeOutput, nodeError,
          entries, providerCalls, effect, activityOutcome,
          activityKind, activityValue, due, runLive,
          route, nextInput, commits>>

Init ==
  /\ nodeState = PENDING
  /\ nodeOutcome = NONE /\ nodeKind = NONE
  /\ nodeOutput = NONE /\ nodeError = NONE
  /\ entries = 0 /\ providerCalls = 0
  /\ effect = "idle"
  /\ activityOutcome = NONE /\ activityKind = NONE /\ activityValue = NONE
  /\ due = FALSE /\ runLive = TRUE
  /\ route = NONE /\ nextInput = NONE /\ commits = 0

StartProviderAttempt ==
  /\ effect = "idle" /\ nodeState = PENDING /\ runLive /\ ~due
  /\ providerCalls < 2 /\ entries < 2
  /\ entries' = entries + 1 /\ providerCalls' = providerCalls + 1
  /\ effect' = "calling"
  /\ UNCHANGED <<nodeState, nodeOutcome, nodeKind, nodeOutput, nodeError,
                  activityOutcome, activityKind, activityValue,
                  due, runLive, route, nextInput, commits>>

CrashBeforeHistory ==
  /\ effect = "calling"
  /\ effect' = "idle"
  /\ UNCHANGED <<nodeState, nodeOutcome, nodeKind, nodeOutput, nodeError,
                  entries, providerCalls, activityOutcome, activityKind,
                  activityValue, due, runLive, route, nextInput, commits>>

RecordProviderResult ==
  /\ effect = "calling"
  /\ \E result \in Results :
       /\ activityOutcome' = "scored"
       /\ activityKind' = BUSINESS
       /\ activityValue' = result
  /\ effect' = "recorded"
  /\ UNCHANGED <<nodeState, nodeOutcome, nodeKind, nodeOutput, nodeError,
                  entries, providerCalls, due, runLive, route, nextInput, commits>>

RecordProviderFailure ==
  /\ effect = "calling"
  /\ \E failure \in {UNAVAILABLE, TIMEOUT} :
       /\ activityOutcome' = failure
       /\ activityKind' = RUNTIME_ERROR
       /\ activityValue' = failure
  /\ effect' = "recorded"
  /\ UNCHANGED <<nodeState, nodeOutcome, nodeKind, nodeOutput, nodeError,
                  entries, providerCalls, due, runLive, route, nextInput, commits>>

(* Proposed v10 policy: third entry records unavailable without a provider call. *)
RecordThirdEntryRefusal ==
  /\ effect = "idle" /\ nodeState = PENDING /\ runLive /\ ~due
  /\ providerCalls = 2 /\ entries = 2
  /\ entries' = 3
  /\ activityOutcome' = UNAVAILABLE
  /\ activityKind' = RUNTIME_ERROR
  /\ activityValue' = UNAVAILABLE
  /\ effect' = "recorded"
  /\ UNCHANGED <<nodeState, nodeOutcome, nodeKind, nodeOutput, nodeError,
                  providerCalls, due, runLive, route, nextInput, commits>>

CommitRecordedResult ==
  /\ effect = "recorded"
  /\ activityOutcome # NONE
  /\ IF nodeState = PENDING
       THEN /\ nodeState' = COMPLETED
            /\ nodeOutcome' = activityOutcome
            /\ nodeKind' = activityKind
            /\ nodeOutput' = IF activityKind = BUSINESS THEN activityValue ELSE NONE
            /\ nodeError' = IF activityKind = RUNTIME_ERROR THEN activityValue ELSE NONE
            /\ commits' = commits + 1
       ELSE UNCHANGED <<nodeState, nodeOutcome, nodeKind, nodeOutput, nodeError, commits>>
  /\ effect' = "done"
  /\ UNCHANGED <<entries, providerCalls, activityOutcome, activityKind,
                  activityValue, due, runLive, route, nextInput>>

Deadline ==
  /\ ~due
  /\ due' = TRUE
  /\ UNCHANGED <<nodeState, nodeOutcome, nodeKind, nodeOutput, nodeError,
                  entries, providerCalls, effect, activityOutcome, activityKind,
                  activityValue, runLive, route, nextInput, commits>>

Elapse ==
  /\ nodeState = PENDING /\ due /\ runLive
  /\ nodeState' = COMPLETED /\ nodeOutcome' = TIMEOUT /\ nodeKind' = RUNTIME_ERROR
  /\ nodeOutput' = NONE /\ nodeError' = TIMEOUT
  /\ commits' = commits + 1 /\ effect' = "done"
  /\ UNCHANGED <<entries, providerCalls, activityOutcome, activityKind,
                  activityValue, due, runLive, route, nextInput>>

CancelRun ==
  /\ runLive
  /\ runLive' = FALSE
  /\ IF nodeState = PENDING
       THEN /\ nodeState' = COMPLETED /\ nodeOutcome' = CANCEL /\ nodeKind' = RUNTIME_ERROR
            /\ nodeOutput' = NONE /\ nodeError' = CANCEL /\ commits' = commits + 1
       ELSE UNCHANGED <<nodeState, nodeOutcome, nodeKind, nodeOutput, nodeError, commits>>
  /\ effect' = "done"
  /\ UNCHANGED <<entries, providerCalls, activityOutcome, activityKind,
                  activityValue, due, route, nextInput>>

Collect ==
  /\ runLive /\ nodeState = COMPLETED /\ route = NONE
  /\ route' = IF nodeKind = BUSINESS THEN nodeOutcome ELSE FAILURE
  /\ nextInput' = IF nodeKind = BUSINESS THEN nodeOutput ELSE nodeError
  /\ UNCHANGED <<nodeState, nodeOutcome, nodeKind, nodeOutput, nodeError,
                  entries, providerCalls, effect, activityOutcome, activityKind,
                  activityValue, due, runLive, commits>>

Next == StartProviderAttempt \/ CrashBeforeHistory \/ RecordProviderResult
       \/ RecordProviderFailure \/ RecordThirdEntryRefusal
       \/ CommitRecordedResult \/ Deadline \/ Elapse \/ CancelRun \/ Collect

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ nodeState \in {PENDING, COMPLETED}
  /\ nodeKind \in {NONE, BUSINESS, RUNTIME_ERROR}
  /\ nodeOutcome \in Results \cup {NONE, "scored", UNAVAILABLE, TIMEOUT, CANCEL}
  /\ nodeOutput \in Results \cup {NONE}
  /\ nodeError \in {NONE, UNAVAILABLE, TIMEOUT, CANCEL}
  /\ entries \in 0..3 /\ providerCalls \in 0..2
  /\ effect \in {"idle", "calling", "recorded", "done"}
  /\ activityKind \in {NONE, BUSINESS, RUNTIME_ERROR}
  /\ activityOutcome \in Results \cup {NONE, "scored", UNAVAILABLE, TIMEOUT}
  /\ activityValue \in Results \cup {NONE, UNAVAILABLE, TIMEOUT}
  /\ due \in BOOLEAN /\ runLive \in BOOLEAN
  /\ route \in {NONE, "scored", FAILURE}
  /\ nextInput \in Results \cup {NONE, UNAVAILABLE, TIMEOUT, CANCEL}
  /\ commits \in 0..1

Inv_CallCap == providerCalls <= 2
Inv_EntryCap == entries <= 3
Inv_OneTerminalCommit == commits <= 1
Inv_RouteFromStoredOutcome == route # NONE =>
  nodeState = COMPLETED /\ route = IF nodeKind = BUSINESS THEN nodeOutcome ELSE FAILURE
Inv_InputFromStoredPayload == route # NONE =>
  nextInput = IF nodeKind = BUSINESS THEN nodeOutput ELSE nodeError
Inv_PendingNotRouted == nodeState = PENDING => route = NONE
Inv_ModelResultHasHistory == nodeKind = BUSINESS =>
  activityOutcome = nodeOutcome /\ activityValue = nodeOutput
Inv_BusinessRuntimeShape == nodeState = COMPLETED =>
  (nodeKind = BUSINESS <=> nodeOutput # NONE) /\ (nodeKind = RUNTIME_ERROR <=> nodeError # NONE)
====
