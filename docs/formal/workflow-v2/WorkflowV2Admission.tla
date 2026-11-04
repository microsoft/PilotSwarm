------------------------ MODULE WorkflowV2Admission ------------------------
(***************************************************************************)
(* Admission of a workflow v2 run's states under its open KV and pause, as  *)
(* packages/sdk/src/workflow/v2 implements it in the commit of this file    *)
(* (README "Admission model"): the controller begins the run, then admits   *)
(* state 1 (a script) and, after its result, state Steps (the terminal),   *)
(* which ends the run. Each admission evaluates its input with the run's    *)
(* current KV revision and is accepted only while the run is admitting and *)
(* that revision is still current. set_vars, pause, resume, a cancel and a  *)
(* deletion may come at any time.                                          *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS
    Steps,              \* states admitted in the run: 1..Steps-1 are scripts, Steps is the terminal
    MaxKv,              \* KV revisions 1..MaxKv (each set_vars makes the next one)
    MaxEvals,           \* evaluations in one enter activity attempt (the code: 5)
    MaxAttempts,        \* enter activity attempts before the run fails (the code: the store retry policy, 5)
    MaxPauses,          \* pause commands
    KvCheck,            \* fix 69e2667b: an admission evaluated with a revision that is no longer current is refused
    PauseGuard,         \* the code: a paused run admits nothing (ADMITTING_RUN_STATUSES); FALSE is a deliberate fault
    InactiveFirst,      \* the code: the inactive refusal comes before the KV check; FALSE is a deliberate fault
    PausedRefusalWaits, \* the code: a paused refusal waits for the resume; FALSE is a deliberate fault
    PausedBackstop,     \* the code: the paused wait races a timer; FALSE is a deliberate fault
    CountOnAdmitted,    \* the code: the ordinal counts only a stored admission; FALSE is a deliberate fault
    BeginMarksBegun,    \* the code: begin of a run paused before it began records paused_from running; FALSE is a deliberate fault
    TriggerEndsPaused,  \* migration 0091: the deletion trigger ends a paused run too; FALSE is the 0090 trigger
    LoseWake,           \* fault: a resume's wake is lost
    PauseBeforeBegin,   \* environment: a pause may come before the controller begins the run
    Cancels,            \* environment: the parent may cancel the run after it began
    Deletes             \* environment: the workflow session may be deleted

ASSUME Steps \in Nat /\ Steps >= 2
ASSUME MaxKv \in Nat /\ MaxKv >= 1
ASSUME MaxEvals \in Nat /\ MaxEvals >= 1
ASSUME MaxAttempts \in Nat /\ MaxAttempts >= 1
ASSUME MaxPauses \in Nat
ASSUME {KvCheck, PauseGuard, InactiveFirst, PausedRefusalWaits, PausedBackstop, CountOnAdmitted, BeginMarksBegun,
        TriggerEndsPaused, LoseWake, PauseBeforeBegin, Cancels, Deletes} \subseteq BOOLEAN

States == 1..Steps
Active == {"admitted", "running", "paused"}
Terminal == {"completed", "failed", "cancelled"}
Admitting == IF PauseGuard THEN {"admitted", "running"} ELSE Active

VARIABLES
    status,     \* the run's status
    pausedFrom, \* paused_from: "none", "admitted", "running"
    kv,         \* the run's KV revision
    deleted,    \* the workflow session is soft-deleted
    nState,     \* each state's node execution: "absent", "pending", "completed"
    nOrd,       \* the ordinal it was admitted with (0: not admitted)
    nPin,       \* the KV revision it pinned (0: not admitted)
    nAtStatus,  \* ghost: the run's status when it was inserted
    nAtKv,      \* ghost: the run's KV revision when it was inserted
    pc,         \* the controller
    cur,        \* the cursor's state
    ord,        \* the ordinal of the cursor's next admission
    evalRev,    \* the KV revision this evaluation read
    evals,      \* kv_changed refusals in this enter attempt
    attempts,   \* enter attempts that ended with KV_CHANGING
    res,        \* the enter activity's result: "none", "admitted", "paused", "ended"
    begun,      \* the controller's begin committed
    wake,       \* a wake message is queued for the controller
    cmd,        \* the parent's cancel command: "none", "queued", "taken"
    pauses,     \* pause commands taken
    kvRefusedInactive \* ghost: a kv_changed refusal was returned for a run that was not admitting

runVars == <<status, pausedFrom, kv, deleted>>
nodeVars == <<nState, nOrd, nPin, nAtStatus, nAtKv>>
ctlVars == <<pc, cur, ord, evalRev, evals, attempts, res, begun>>
envVars == <<wake, cmd, pauses, kvRefusedInactive>>
vars == <<runVars, nodeVars, ctlVars, envVars>>

TypeOK ==
    /\ status \in Active \cup Terminal
    /\ pausedFrom \in {"none", "admitted", "running"}
    /\ kv \in 1..MaxKv
    /\ deleted \in BOOLEAN
    /\ nState \in [States -> {"absent", "pending", "completed"}]
    /\ nOrd \in [States -> 0..2]
    /\ nPin \in [States -> 0..MaxKv]
    /\ nAtStatus \in [States -> {"none"} \cup Active]
    /\ nAtKv \in [States -> 0..MaxKv]
    /\ pc \in {"begin", "admit", "insert", "record", "wait", "pausedWait", "finish", "fail", "done"}
    /\ cur \in States
    /\ ord \in 1..2
    /\ evalRev \in 0..MaxKv
    /\ evals \in 0..MaxEvals
    /\ attempts \in 0..MaxAttempts
    /\ res \in {"none", "admitted", "paused", "ended"}
    /\ begun \in BOOLEAN
    /\ wake \in BOOLEAN
    /\ cmd \in {"none", "queued", "taken"}
    /\ pauses \in 0..MaxPauses
    /\ kvRefusedInactive \in BOOLEAN

Init ==
    /\ status = "admitted" /\ pausedFrom = "none" /\ kv = 1 /\ deleted = FALSE
    /\ nState = [s \in States |-> "absent"]
    /\ nOrd = [s \in States |-> 0]
    /\ nPin = [s \in States |-> 0]
    /\ nAtStatus = [s \in States |-> "none"]
    /\ nAtKv = [s \in States |-> 0]
    /\ pc = "begin" /\ cur = 1 /\ ord = 1 /\ evalRev = 0 /\ evals = 0 /\ attempts = 0 /\ res = "none" /\ begun = FALSE
    /\ wake = FALSE /\ cmd = "none" /\ pauses = 0 /\ kvRefusedInactive = FALSE

NotBegun == status = "admitted" \/ (status = "paused" /\ pausedFrom = "admitted")

(* Pending node executions lose to a run's end in its transaction.         *)
EndPending == [s \in States |-> IF nState[s] = "pending" THEN "completed" ELSE nState[s]]

(* S beginRun. admitted -> running; a run paused before its controller      *)
(* began has begun now and stays paused. A deleted session or an ended run  *)
(* is returned as it is, and the controller ends unless the run is active.  *)
BeginTx ==
    /\ pc = "begin"
    /\ status' = IF ~deleted /\ status = "admitted" THEN "running" ELSE status
    /\ pausedFrom' = IF ~deleted /\ status = "paused" /\ pausedFrom = "admitted" /\ BeginMarksBegun
                     THEN "running" ELSE pausedFrom
    /\ pc' = IF status \in Active THEN "admit" ELSE "done"
    /\ begun' = TRUE
    /\ UNCHANGED <<kv, deleted, nodeVars, cur, ord, evalRev, evals, attempts, res, envVars>>

(* The enter activity evaluates the cursor's state with the run's current   *)
(* KV revision (its first evaluation, or again after kv_changed).           *)
Eval ==
    /\ pc = "admit"
    /\ pc' = "insert"
    /\ evalRev' = kv
    /\ UNCHANGED <<runVars, nodeVars, cur, ord, evals, attempts, res, begun, envVars>>

(* S enterNode under the session and run locks. An inactive run (deleted,  *)
(* ended, or paused) is refused first; then an admission evaluated with a   *)
(* revision that is no longer current (kv_changed), and the activity        *)
(* evaluates again, MaxEvals times in all, then fails with KV_CHANGING; the *)
(* store retry policy repeats the activity MaxAttempts times, then the run  *)
(* fails. Otherwise the state is admitted, pinning its revision.            *)
Inactive == deleted \/ status \notin Admitting
Stale == KvCheck /\ evalRev # kv
RefuseInactive == Inactive /\ (InactiveFirst \/ ~Stale)
RefuseKv == Stale /\ ~RefuseInactive
Admit == ~Inactive /\ ~Stale
Exhausted == RefuseKv /\ evals + 1 >= MaxEvals
FailsRun == Exhausted /\ attempts + 1 >= MaxAttempts

InsertTx ==
    /\ pc = "insert"
    /\ nState' = IF Admit THEN [nState EXCEPT ![cur] = "pending"] ELSE nState
    /\ nOrd' = IF Admit THEN [nOrd EXCEPT ![cur] = ord] ELSE nOrd
    /\ nPin' = IF Admit THEN [nPin EXCEPT ![cur] = evalRev] ELSE nPin
    /\ nAtStatus' = IF Admit THEN [nAtStatus EXCEPT ![cur] = status] ELSE nAtStatus
    /\ nAtKv' = IF Admit THEN [nAtKv EXCEPT ![cur] = kv] ELSE nAtKv
    /\ res' = CASE Admit -> "admitted"
               [] RefuseInactive /\ status = "paused" -> "paused"
               [] RefuseInactive -> "ended"
               [] OTHER -> "none"
    /\ pc' = CASE Admit \/ RefuseInactive -> "record"
              [] FailsRun -> "fail"
              [] OTHER -> "admit"
    /\ evals' = IF RefuseKv /\ ~Exhausted THEN evals + 1 ELSE 0
    /\ attempts' = IF Exhausted /\ ~FailsRun THEN attempts + 1 ELSE attempts
    /\ kvRefusedInactive' = (kvRefusedInactive \/ (RefuseKv /\ Inactive))
    /\ UNCHANGED <<runVars, cur, ord, evalRev, begun, wake, cmd, pauses>>

(* The controller records the result. A stored admission counts its        *)
(* ordinal; a paused refusal waits for the resume; an ended run ends the    *)
(* controller. (Without CountOnAdmitted a refusal counts the ordinal too.)  *)
Record ==
    /\ pc = "record"
    /\ pc' = CASE res = "admitted" /\ cur = Steps -> "finish"
              [] res = "admitted" -> "wait"
              [] res = "paused" -> (IF PausedRefusalWaits THEN "pausedWait" ELSE "done")
              [] OTHER -> "done"
    /\ ord' = IF res # "admitted" /\ ~CountOnAdmitted /\ ord < 2 THEN ord + 1 ELSE ord
    /\ res' = "none"
    /\ attempts' = 0
    /\ UNCHANGED <<runVars, nodeVars, cur, evalRev, evals, begun, envVars>>

(* The script's effect stores its result; admitted work finishes while the *)
(* run is paused.                                                           *)
NodeDone ==
    /\ \E s \in 1..(Steps - 1) :
        /\ nState[s] = "pending"
        /\ ~deleted
        /\ status \in Active
        /\ nState' = [nState EXCEPT ![s] = "completed"]
    /\ UNCHANGED <<runVars, nOrd, nPin, nAtStatus, nAtKv, ctlVars, envVars>>

(* The controller collects the stored result and routes to the next state. *)
Collect ==
    /\ pc = "wait"
    /\ nState[cur] = "completed"
    /\ pc' = "admit"
    /\ cur' = cur + 1
    /\ ord' = 1
    /\ UNCHANGED <<runVars, nodeVars, evalRev, evals, attempts, res, begun, envVars>>

(* The terminal state's finish (S finishRun): the run ends with its        *)
(* terminal node in one transaction; a run that ended first is kept.       *)
Finish ==
    /\ pc = "finish"
    /\ status' = IF ~deleted /\ status \in Active THEN "completed" ELSE status
    /\ pausedFrom' = IF ~deleted /\ status \in Active THEN "none" ELSE pausedFrom
    /\ nState' = IF ~deleted /\ status \in Active THEN EndPending ELSE nState
    /\ pc' = "done"
    /\ UNCHANGED <<kv, deleted, nOrd, nPin, nAtStatus, nAtKv, cur, ord, evalRev, evals, attempts, res, begun, envVars>>

(* KV_CHANGING exhausted the attempts: controlRun throws, and the           *)
(* controller ends the run as failed (controller_error).                    *)
Fail ==
    /\ pc = "fail"
    /\ status' = IF ~deleted /\ status \in Active THEN "failed" ELSE status
    /\ pausedFrom' = IF ~deleted /\ status \in Active THEN "none" ELSE pausedFrom
    /\ nState' = IF ~deleted /\ status \in Active THEN EndPending ELSE nState
    /\ pc' = "done"
    /\ UNCHANGED <<kv, deleted, nOrd, nPin, nAtStatus, nAtKv, cur, ord, evalRev, evals, attempts, res, begun, envVars>>

(* Paused: the race of the command queue and the backstop timer. A wake,    *)
(* the timer, or continue-as-new after idle waits (the next execution       *)
(* starts at the same admission) tries the admission again.                 *)
PausedWake ==
    /\ pc = "pausedWait"
    /\ wake
    /\ wake' = FALSE
    /\ pc' = "admit"
    /\ UNCHANGED <<runVars, nodeVars, cur, ord, evalRev, evals, attempts, res, begun, cmd, pauses, kvRefusedInactive>>

PausedTimer ==
    /\ pc = "pausedWait"
    /\ PausedBackstop
    /\ pc' = "admit"
    /\ UNCHANGED <<runVars, nodeVars, cur, ord, evalRev, evals, attempts, res, begun, envVars>>

(* update_workflow cancel of a run that has begun: the receipt, then the    *)
(* command is queued for its controller.                                    *)
SendCancel ==
    /\ Cancels
    /\ cmd = "none"
    /\ ~deleted
    /\ status \in Active
    /\ ~NotBegun
    /\ cmd' = "queued"
    /\ UNCHANGED <<runVars, nodeVars, ctlVars, wake, pauses, kvRefusedInactive>>

(* The controller reads the command before an admission or in its race,     *)
(* and the cancel activity ends the run (S finishRun).                      *)
ApplyCmd ==
    /\ pc \in {"admit", "wait", "pausedWait"}
    /\ cmd = "queued"
    /\ status' = IF ~deleted /\ status \in Active THEN "cancelled" ELSE status
    /\ pausedFrom' = IF ~deleted /\ status \in Active THEN "none" ELSE pausedFrom
    /\ nState' = IF ~deleted /\ status \in Active THEN EndPending ELSE nState
    /\ cmd' = "taken"
    /\ pc' = "done"
    /\ UNCHANGED <<kv, deleted, nOrd, nPin, nAtStatus, nAtKv, cur, ord, evalRev, evals, attempts, res, begun,
                   wake, pauses, kvRefusedInactive>>

(* S setRunPaused pause: paused_from records the status it paused.         *)
Pause ==
    /\ pauses < MaxPauses
    /\ ~deleted
    /\ status \in {"admitted", "running"}
    /\ status = "admitted" => PauseBeforeBegin
    /\ status' = "paused"
    /\ pausedFrom' = status
    /\ pauses' = pauses + 1
    /\ UNCHANGED <<kv, deleted, nodeVars, ctlVars, wake, cmd, kvRefusedInactive>>

(* S setRunPaused resume: back to paused_from. V controlWorkflowV2Run then  *)
(* sends a wake (the run admits again), which may be lost.                  *)
Resume ==
    /\ ~deleted
    /\ status = "paused"
    /\ status' = pausedFrom
    /\ pausedFrom' = "none"
    /\ wake' \in (IF LoseWake THEN {wake, TRUE} ELSE {TRUE})
    /\ UNCHANGED <<kv, deleted, nodeVars, ctlVars, cmd, pauses, kvRefusedInactive>>

(* S setRunVars: a new revision of an active run's KV (paused included).    *)
SetVars ==
    /\ ~deleted
    /\ status \in Active
    /\ kv < MaxKv
    /\ kv' = kv + 1
    /\ UNCHANGED <<status, pausedFrom, deleted, nodeVars, ctlVars, envVars>>

(* Soft delete and the deletion trigger: 0091 ends an admitted, running or  *)
(* paused run with its pending nodes; 0090 ended only admitted and running. *)
Delete ==
    /\ Deletes
    /\ ~deleted
    /\ deleted' = TRUE
    /\ status' = IF status \in (IF TriggerEndsPaused THEN Active ELSE {"admitted", "running"}) THEN "cancelled" ELSE status
    /\ pausedFrom' = IF status \in (IF TriggerEndsPaused THEN Active ELSE {"admitted", "running"}) THEN "none" ELSE pausedFrom
    /\ nState' = IF status \in (IF TriggerEndsPaused THEN Active ELSE {"admitted", "running"}) THEN EndPending ELSE nState
    /\ UNCHANGED <<kv, nOrd, nPin, nAtStatus, nAtKv, ctlVars, envVars>>

Next ==
    \/ BeginTx \/ Eval \/ InsertTx \/ Record \/ NodeDone \/ Collect \/ Finish \/ Fail
    \/ PausedWake \/ PausedTimer \/ SendCancel \/ ApplyCmd
    \/ Pause \/ Resume \/ SetVars \/ Delete

(* Weak fairness of the controller, the script and the resume (assumption   *)
(* A4: a paused run is eventually resumed). set_vars, pause, the cancel     *)
(* and the deletion are not fair.                                           *)
Fairness ==
    /\ WF_vars(BeginTx) /\ WF_vars(Eval) /\ WF_vars(InsertTx) /\ WF_vars(Record)
    /\ WF_vars(NodeDone) /\ WF_vars(Collect) /\ WF_vars(Finish) /\ WF_vars(Fail)
    /\ WF_vars(PausedWake) /\ WF_vars(PausedTimer) /\ WF_vars(ApplyCmd) /\ WF_vars(Resume)

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)

(* A state is admitted only while the run admits (never while paused).    *)
Inv_AdmitOnlyAdmitting == \A s \in States : nState[s] # "absent" => nAtStatus[s] \in {"admitted", "running"}

(* Each admission pins the KV revision current when it is inserted.        *)
Inv_PinCurrent == \A s \in States : nState[s] # "absent" => nPin[s] = nAtKv[s]

(* kv_changed is returned only for a run that admits (inactive wins).      *)
Inv_KvRefusalAdmitting == ~kvRefusedInactive

(* A refusal uses no ordinal: each state is admitted with ordinal 1.       *)
Inv_OrdinalCountsAdmissions == \A s \in States : nOrd[s] \in {0, 1}

(* A state is admitted after its predecessor completed.                    *)
Inv_AdmissionOrder == \A s \in 2..Steps : nState[s] # "absent" => nState[s - 1] = "completed"

(* paused <=> paused_from is set (the 0091 check constraint).              *)
Inv_PausedFrom == (status = "paused") <=> (pausedFrom # "none")

(* Pause is not an end: the controller ends only with its run.             *)
Inv_ExitEndedRun == pc = "done" => status \in Terminal

(* A deleted workflow has no active run.                                   *)
Inv_DeletedNotActive == deleted => status \notin Active

(* A run its controller began is never again a run that has not begun.     *)
Inv_BegunStaysBegun == (begun /\ status \in Active) => ~NotBegun

AdmissionSafety ==
    /\ TypeOK /\ Inv_AdmitOnlyAdmitting /\ Inv_PinCurrent /\ Inv_KvRefusalAdmitting
    /\ Inv_OrdinalCountsAdmissions /\ Inv_AdmissionOrder /\ Inv_PausedFrom /\ Inv_ExitEndedRun
    /\ Inv_DeletedNotActive /\ Inv_BegunStaysBegun

Live_Terminates == <>(status \in Terminal)

Live_ControllerDone == <>(pc = "done")

=============================================================================
