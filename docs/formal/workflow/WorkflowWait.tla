--------------------------- MODULE WorkflowWait ---------------------------
(***************************************************************************)
(* One wait state of a workflow run, as packages/sdk/src/workflow     *)
(* implements it in the commit of this file (README "Wait model"): its      *)
(* admission (evaluation, transaction start, lock wait, the accepted entry, *)
(* commit), its deadline in the store's clock, the controller's timer in    *)
(* its own clock, the store's elapse, and the transactions that may decide  *)
(* the wait first: a cancel that the controller applies, a deletion, and a  *)
(* recover after the controller ended (whose last elapse activity may still *)
(* run). The run may be paused at any time. After the wait, the terminal    *)
(* state ends the run.                                                      *)
(*                                                                          *)
(* clk is the store's clock in whole seconds; it never goes back. The       *)
(* controller and the workers read clk + Skew. ClockCap stands for every    *)
(* time from ClockCap on: every stored deadline in these bounds is before   *)
(* it, so the store decides the same way at every later time, and a        *)
(* controller timer set for a later time has fired there (README "Wait     *)
(* model": the clock).                                                     *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS
    Secs,              \* the wait's seconds, read once when its input is evaluated
    ClockOffset,       \* the controller's and the workers' clock against the store's: "behind" (1 s), "equal", "ahead" (1 s)
    MaxPre,            \* bound of the store's clock while the wait is not stored
    EntryClock,        \* the deadline counts from: "evaluation" (a93c105c), "begin" (659dc63f), "accepted" (183bb0b0 and later)
    StoreElapseGuard,  \* fix 659dc63f: the store elapses a wait only once its own clock reached the deadline
    Cas,               \* the elapse is a compare-and-swap from pending; FALSE is a deliberate fault
    CanKeepsDeadline,  \* continue-as-new carries the cursor's deadline (the code); FALSE is a deliberate fault
    ElapseWhilePaused, \* the store elapses a wait of a paused run (the code); FALSE is a deliberate fault
    Pauses,            \* environment: the parent may pause the run (once) and resume it
    Cancels,           \* environment: the parent may cancel the run
    Deletes,           \* environment: the workflow session may be deleted
    ControllerDeath,   \* fault: the controller ends without ending its run; the parent recovers it
    ResumeFair,        \* environment: a paused run is eventually resumed (a control for the paused cases)
    MaxCrashes         \* assumption A1: worker crashes inside the enter and elapse activities

ASSUME Secs \in Nat /\ Secs >= 2
ASSUME ClockOffset \in {"behind", "equal", "ahead"}
ASSUME MaxPre \in Nat /\ MaxCrashes \in Nat
ASSUME EntryClock \in {"evaluation", "begin", "accepted"}
ASSUME {StoreElapseGuard, Cas, CanKeepsDeadline, ElapseWhilePaused, Pauses, Cancels, Deletes, ControllerDeath, ResumeFair} \subseteq BOOLEAN

NoTime == -1
(* The controller's and the workers' clock minus the store's, in seconds.  *)
Skew == CASE ClockOffset = "ahead" -> 1
          [] ClockOffset = "behind" -> -1
          [] OTHER -> 0
AbsSkew == IF Skew < 0 THEN -Skew ELSE Skew
(* Every stored deadline and the controller's first ask are at or before  *)
(* this time (README "Wait model": the clock).                             *)
ClockCap == MaxPre + Secs + 2 * AbsSkew + 1
Times == {NoTime} \cup 0..(2 * ClockCap)
Active == {"running", "paused"}
Terminal == {"completed", "failed", "cancelled"}
Winners == {"none", "elapse", "cancel", "delete", "controller"}

VARIABLES
    clk,       \* the store's clock
    run,       \* the run's status; its controller began it, and the wait is its next state
    deleted,   \* the workflow session is soft-deleted
    pauses,    \* pause commands taken
    wState,    \* the wait's node execution: "absent", "pending", "completed"
    wWinner,   \* the result stored first
    wAt,       \* completed_at
    accAt,     \* ghost: the store's clock when the insert ran (the accepted entry)
    commitAt,  \* ghost: the store's clock when the insert committed
    dl,        \* deadline_at
    pc,        \* the controller
    evalAt,    \* the store's clock when this enter attempt evaluated the wait
    txAt,      \* the store's clock when this attempt's transaction began (now())
    tent,      \* this attempt inserted the row and has not committed
    tentAt,    \* the uncommitted row's entry reading
    tentDl,    \* the uncommitted row's deadline
    admRes,    \* the enter attempt's result: "none", "pending", "completed", "paused", "ended"
    ctrlDl,    \* the cursor's deadline in the controller's state
    elRes,     \* the elapse activity's result: "none", "elapsed", "decided", "not_due"
    elRem,     \* the time left that a not_due result reports
    crashes,   \* worker crashes taken
    zombie     \* an elapse activity of a controller that ended may still run

runVars == <<run, deleted, pauses>>
rowVars == <<wState, wWinner, wAt, accAt, commitAt, dl>>
admVars == <<evalAt, txAt, tent, tentAt, tentDl, admRes>>
elVars == <<elRes, elRem>>
vars == <<clk, runVars, rowVars, pc, admVars, ctrlDl, elVars, crashes, zombie>>

TypeOK ==
    /\ clk \in 0..ClockCap
    /\ run \in Active \cup Terminal
    /\ deleted \in BOOLEAN
    /\ pauses \in 0..1
    /\ wState \in {"absent", "pending", "completed"}
    /\ wWinner \in Winners
    /\ wAt \in Times /\ accAt \in Times /\ commitAt \in Times /\ dl \in Times
    /\ pc \in {"admit", "begin", "lock", "insert", "commit", "record", "pausedWait", "waiting",
               "elapse", "elapseRecord", "collect", "finish", "done", "dead"}
    /\ evalAt \in Times /\ txAt \in Times /\ tent \in BOOLEAN /\ tentAt \in Times /\ tentDl \in Times
    /\ admRes \in {"none", "pending", "completed", "paused", "ended"}
    /\ ctrlDl \in Times
    /\ elRes \in {"none", "elapsed", "decided", "not_due"}
    /\ elRem \in 0..(2 * ClockCap)
    /\ crashes \in 0..MaxCrashes
    /\ zombie \in BOOLEAN

Init ==
    /\ clk = 0
    /\ run = "running" /\ deleted = FALSE /\ pauses = 0
    /\ wState = "absent" /\ wWinner = "none" /\ wAt = NoTime /\ accAt = NoTime /\ commitAt = NoTime /\ dl = NoTime
    /\ pc = "admit"
    /\ evalAt = NoTime /\ txAt = NoTime /\ tent = FALSE /\ tentAt = NoTime /\ tentDl = NoTime /\ admRes = "none"
    /\ ctrlDl = NoTime /\ elRes = "none" /\ elRem = 0 /\ crashes = 0 /\ zombie = FALSE

(* The enter activity holds the session and run locks from AdmLock to its   *)
(* commit; every other transaction here is one step and waits for them.     *)
LocksHeld == pc \in {"insert", "commit"}
Admitting == ~deleted /\ run = "running"

(* What the deadline counts from in each code revision: the worker's        *)
(* Date.now() at evaluation (a93c105c), the transaction's now() (659dc63f), *)
(* or one clock_timestamp() reading in the inserting statement, after the   *)
(* locks and the guards (183bb0b0 and later).                               *)
Base == CASE EntryClock = "evaluation" -> evalAt + Skew
          [] EntryClock = "begin" -> txAt
          [] OTHER -> clk

(* The enter activity. A retry after the commit returns the stored row      *)
(* (readNodeExecution); otherwise it evaluates the input and the seconds.   *)
AdmEval ==
    /\ pc = "admit"
    /\ pc' = IF wState = "absent" THEN "begin" ELSE "record"
    /\ admRes' = CASE wState = "absent" -> "none"
                   [] wState = "pending" -> "pending"
                   [] OTHER -> "completed"
    /\ evalAt' = IF wState = "absent" THEN clk ELSE NoTime
    /\ UNCHANGED <<clk, runVars, rowVars, txAt, tent, tentAt, tentDl, ctrlDl, elVars, crashes, zombie>>

(* S enterNode's transaction begins; now() is read here.                    *)
AdmBegin ==
    /\ pc = "begin"
    /\ pc' = "lock"
    /\ txAt' = clk
    /\ UNCHANGED <<clk, runVars, rowVars, evalAt, tent, tentAt, tentDl, admRes, ctrlDl, elVars, crashes, zombie>>

(* The session and run locks: the clock may advance before this step (a     *)
(* lock wait) while other transactions commit.                              *)
AdmLock ==
    /\ pc = "lock"
    /\ pc' = "insert"
    /\ UNCHANGED <<clk, runVars, rowVars, admVars, ctrlDl, elVars, crashes, zombie>>

(* The live and status guards, then the insert with its entry reading; a    *)
(* paused or ended run is refused (the KV guard is in WorkflowAdmission). *)
(* The attempt's earlier readings are not used after this step.            *)
AdmInsert ==
    /\ pc = "insert"
    /\ pc' = "commit"
    /\ tent' = Admitting
    /\ tentAt' = IF Admitting THEN clk ELSE NoTime
    /\ tentDl' = IF Admitting THEN Base + Secs ELSE NoTime
    /\ admRes' = CASE Admitting -> "pending"
                   [] ~deleted /\ run = "paused" -> "paused"
                   [] OTHER -> "ended"
    /\ evalAt' = NoTime
    /\ txAt' = NoTime
    /\ UNCHANGED <<clk, runVars, rowVars, ctrlDl, elVars, crashes, zombie>>

(* The commit makes the row visible; the clock may have advanced since the  *)
(* insert.                                                                  *)
AdmCommit ==
    /\ pc = "commit"
    /\ pc' = "record"
    /\ wState' = IF tent THEN "pending" ELSE wState
    /\ accAt' = IF tent THEN tentAt ELSE accAt
    /\ commitAt' = IF tent THEN clk ELSE commitAt
    /\ dl' = IF tent THEN tentDl ELSE dl
    /\ tent' = FALSE
    /\ tentAt' = NoTime
    /\ tentDl' = NoTime
    /\ UNCHANGED <<clk, runVars, wWinner, wAt, evalAt, txAt, admRes, ctrlDl, elVars, crashes, zombie>>

(* The controller resumes with the recorded result: a pending wait waits    *)
(* for its deadline; a paused run waits for its resume; an ended run ends   *)
(* the controller.                                                          *)
AdmRecord ==
    /\ pc = "record"
    /\ pc' = CASE admRes \in {"pending", "completed"} -> "waiting"
               [] admRes = "paused" -> "pausedWait"
               [] OTHER -> "done"
    /\ ctrlDl' = IF admRes = "pending" THEN dl ELSE ctrlDl
    /\ admRes' = "none"
    /\ UNCHANGED <<clk, runVars, rowVars, evalAt, txAt, tent, tentAt, tentDl, elVars, crashes, zombie>>

(* A worker crash re-dispatches the enter activity: an uncommitted insert   *)
(* rolls back, and a committed one is read back by the retry.               *)
AdmCrash ==
    /\ pc \in {"begin", "lock", "insert", "commit", "record"}
    /\ crashes < MaxCrashes
    /\ pc' = "admit"
    /\ tent' = FALSE
    /\ tentAt' = NoTime
    /\ tentDl' = NoTime
    /\ admRes' = "none"
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<clk, runVars, rowVars, evalAt, txAt, ctrlDl, elVars, zombie>>

(* The cursor's timer fired and the controller's clock (utcNow, recorded in *)
(* its history) reached the cursor's deadline: ask the store. At ClockCap   *)
(* (every later time) a timer set for a later time has fired too.           *)
CtrlAsk ==
    /\ pc = "waiting"
    /\ ctrlDl # NoTime
    /\ (clk + Skew >= ctrlDl \/ clk = ClockCap)
    /\ pc' = "elapse"
    /\ UNCHANGED <<clk, runVars, rowVars, admVars, ctrlDl, elVars, crashes, zombie>>

(* A wake or the backstop timer: collect a result that another path stored. *)
CtrlCollect ==
    /\ pc = "waiting"
    /\ wState = "completed"
    /\ pc' = "collect"
    /\ UNCHANGED <<clk, runVars, rowVars, admVars, ctrlDl, elVars, crashes, zombie>>

(* Continue-as-new while waiting: the next execution starts with the        *)
(* controller state, which carries the cursor's deadline.                   *)
CtrlCan ==
    /\ pc = "waiting"
    /\ ctrlDl' = IF CanKeepsDeadline THEN ctrlDl ELSE NoTime
    /\ UNCHANGED <<clk, runVars, rowVars, pc, admVars, elVars, crashes, zombie>>

(* S elapseWait for this wait: the outcome of one transaction that reads    *)
(* the store's clock once after the session lock.                           *)
ElapseOpen == ~deleted
              /\ (~StoreElapseGuard \/ dl <= clk)
              /\ (ElapseWhilePaused \/ run # "paused")
              /\ (wState = "pending" \/ (~Cas /\ wState = "completed"))

ElapseExec ==
    /\ pc = "elapse"
    /\ pc' = "elapseRecord"
    /\ wState' = IF ElapseOpen THEN "completed" ELSE wState
    /\ wWinner' = IF ElapseOpen THEN "elapse" ELSE wWinner
    /\ wAt' = IF ElapseOpen THEN clk ELSE wAt
    /\ elRes' = CASE ElapseOpen -> "elapsed"
                  [] wState = "pending" /\ ~deleted -> "not_due"
                  [] OTHER -> "decided"
    /\ elRem' = IF ~ElapseOpen /\ wState = "pending" /\ ~deleted
                THEN (IF dl - clk >= 1 THEN dl - clk ELSE 1) ELSE 0
    /\ UNCHANGED <<clk, runVars, accAt, commitAt, dl, admVars, ctrlDl, crashes, zombie>>

(* The controller records the elapse: a wait the store did not find due     *)
(* waits the reported time from its own clock (utcNow after the activity).  *)
ElapseRecord ==
    /\ pc = "elapseRecord"
    /\ pc' = IF elRes = "not_due" THEN "waiting" ELSE "collect"
    /\ ctrlDl' = IF elRes = "not_due" THEN clk + Skew + elRem ELSE ctrlDl
    /\ elRes' = "none"
    /\ elRem' = 0
    /\ UNCHANGED <<clk, runVars, rowVars, admVars, crashes, zombie>>

(* A worker crash before the elapse result is recorded runs the activity    *)
(* again.                                                                   *)
ElapseCrash ==
    /\ pc = "elapseRecord"
    /\ crashes < MaxCrashes
    /\ pc' = "elapse"
    /\ elRes' = "none"
    /\ elRem' = 0
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<clk, runVars, rowVars, admVars, ctrlDl, zombie>>

(* The collect activity reads the stored result; the controller routes on.  *)
Collect ==
    /\ pc = "collect"
    /\ pc' = IF wState = "completed" THEN "finish" ELSE "waiting"
    /\ ctrlDl' = IF wState = "completed" THEN NoTime ELSE ctrlDl
    /\ UNCHANGED <<clk, runVars, rowVars, admVars, elVars, crashes, zombie>>

(* The next state's admission (the terminal) and the run's end: a paused   *)
(* run waits, and a run that another path ended ends the controller.       *)
Finish ==
    /\ pc = "finish"
    /\ pc' = CASE Admitting -> "done"
               [] ~deleted /\ run = "paused" -> "pausedWait"
               [] OTHER -> "done"
    /\ run' = IF Admitting THEN "completed" ELSE run
    /\ UNCHANGED <<clk, deleted, pauses, rowVars, admVars, ctrlDl, elVars, crashes, zombie>>

(* Paused: the resume's wake or the backstop timer (and continue-as-new,    *)
(* which starts the next execution at the same admission) tries again.     *)
PausedRetry ==
    /\ pc = "pausedWait"
    /\ pc' = IF wState = "absent" THEN "admit" ELSE "finish"
    /\ UNCHANGED <<clk, runVars, rowVars, admVars, ctrlDl, elVars, crashes, zombie>>

(* A cancel command read before an admission or in the controller's race:  *)
(* the cancel activity ends the run and decides the pending wait.           *)
ApplyCancel ==
    /\ Cancels
    /\ pc \in {"admit", "waiting", "pausedWait"}
    /\ pc' = "done"
    /\ run' = IF ~deleted /\ run \in Active THEN "cancelled" ELSE run
    /\ wState' = IF ~deleted /\ run \in Active /\ wState = "pending" THEN "completed" ELSE wState
    /\ wWinner' = IF ~deleted /\ run \in Active /\ wState = "pending" THEN "cancel" ELSE wWinner
    /\ wAt' = IF ~deleted /\ run \in Active /\ wState = "pending" THEN clk ELSE wAt
    /\ UNCHANGED <<clk, deleted, pauses, accAt, commitAt, dl, admVars, ctrlDl, elVars, crashes, zombie>>

(* Soft delete and the deletion trigger (0091): the run ends and a pending  *)
(* wait loses to the deletion, in one transaction.                          *)
Delete ==
    /\ Deletes
    /\ ~deleted
    /\ ~LocksHeld
    /\ deleted' = TRUE
    /\ run' = IF run \in Active THEN "cancelled" ELSE run
    /\ wState' = IF wState = "pending" THEN "completed" ELSE wState
    /\ wWinner' = IF wState = "pending" THEN "delete" ELSE wWinner
    /\ wAt' = IF wState = "pending" THEN clk ELSE wAt
    /\ UNCHANGED <<clk, pauses, accAt, commitAt, dl, pc, admVars, ctrlDl, elVars, crashes, zombie>>

Pause ==
    /\ Pauses
    /\ pauses = 0
    /\ ~deleted
    /\ run = "running"
    /\ ~LocksHeld
    /\ run' = "paused"
    /\ pauses' = 1
    /\ UNCHANGED <<clk, deleted, rowVars, pc, admVars, ctrlDl, elVars, crashes, zombie>>

Resume ==
    /\ ~deleted
    /\ run = "paused"
    /\ ~LocksHeld
    /\ run' = "running"
    /\ UNCHANGED <<clk, deleted, pauses, rowVars, pc, admVars, ctrlDl, elVars, crashes, zombie>>

(* The controller ends without ending its run: between its activities, or   *)
(* while its elapse activity runs, which may still commit after it. It does *)
(* not end while its enter activity runs (README "Wait model": limits).     *)
CtrlDie ==
    /\ ControllerDeath
    /\ pc \in {"record", "waiting", "elapse", "elapseRecord", "collect", "pausedWait"}
    /\ pc' = "dead"
    /\ zombie' = (pc = "elapse")
    /\ UNCHANGED <<clk, runVars, rowVars, admVars, ctrlDl, elVars, crashes>>

(* That elapse activity's transaction, after its controller ended.          *)
ZombieElapse ==
    /\ zombie
    /\ zombie' = FALSE
    /\ wState' = IF ElapseOpen THEN "completed" ELSE wState
    /\ wWinner' = IF ElapseOpen THEN "elapse" ELSE wWinner
    /\ wAt' = IF ElapseOpen THEN clk ELSE wAt
    /\ UNCHANGED <<clk, runVars, accAt, commitAt, dl, pc, admVars, ctrlDl, elVars, crashes>>

(* V recoverWorkflowRun: the run ends as failed and a pending wait loses  *)
(* to it, in one transaction.                                               *)
Recover ==
    /\ ControllerDeath
    /\ pc = "dead"
    /\ ~deleted
    /\ run \in Active
    /\ run' = "failed"
    /\ wState' = IF wState = "pending" THEN "completed" ELSE wState
    /\ wWinner' = IF wState = "pending" THEN "controller" ELSE wWinner
    /\ wAt' = IF wState = "pending" THEN clk ELSE wAt
    /\ UNCHANGED <<clk, deleted, pauses, accAt, commitAt, dl, pc, admVars, ctrlDl, elVars, crashes, zombie>>

(* The store's clock advances: freely (to MaxPre) while the wait is not     *)
(* stored, then while a timer of the store or of the controller is ahead.   *)
Tick ==
    /\ clk < ClockCap
    /\ \/ wState = "absent" /\ clk < MaxPre
       \/ wState = "pending" /\ (clk < dl \/ (ctrlDl # NoTime /\ clk + Skew < ctrlDl))
    /\ clk' = clk + 1
    /\ UNCHANGED <<runVars, rowVars, pc, admVars, ctrlDl, elVars, crashes, zombie>>

Next ==
    \/ AdmEval \/ AdmBegin \/ AdmLock \/ AdmInsert \/ AdmCommit \/ AdmRecord \/ AdmCrash
    \/ CtrlAsk \/ CtrlCollect \/ CtrlCan \/ ElapseExec \/ ElapseRecord \/ ElapseCrash
    \/ Collect \/ Finish \/ PausedRetry \/ ApplyCancel
    \/ Delete \/ Pause \/ Resume \/ CtrlDie \/ ZombieElapse \/ Recover \/ Tick

(* Weak fairness of every controller step, the zombie activity, recover     *)
(* (A3) and the clock. Pause, cancel, deletion, crashes, death and          *)
(* continue-as-new are not fair, and resume only with ResumeFair: a run may *)
(* stay paused.                                                             *)
Fairness ==
    /\ WF_vars(AdmEval) /\ WF_vars(AdmBegin) /\ WF_vars(AdmLock) /\ WF_vars(AdmInsert)
    /\ WF_vars(AdmCommit) /\ WF_vars(AdmRecord) /\ WF_vars(CtrlAsk) /\ WF_vars(CtrlCollect)
    /\ WF_vars(ElapseExec) /\ WF_vars(ElapseRecord) /\ WF_vars(Collect) /\ WF_vars(Finish)
    /\ WF_vars(PausedRetry) /\ WF_vars(ZombieElapse) /\ WF_vars(Recover) /\ WF_vars(Tick)
    /\ WF_vars(ResumeFair /\ Resume)

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)

(* A wait elapses no earlier than its seconds after its accepted entry, in  *)
(* the store's clock.                                                       *)
Inv_NotEarly == wWinner = "elapse" => wAt >= accAt + Secs

(* A run that ended has no pending wait.                                    *)
Inv_RunEndDecidesWait == run \in Terminal => wState # "pending"

(* The controller ends only with its run.                                   *)
Inv_ExitEndedRun == pc = "done" => run \in Terminal

WaitSafety == TypeOK /\ Inv_NotEarly /\ Inv_RunEndDecidesWait /\ Inv_ExitEndedRun

(* Witness, expected to be violated: the seconds are not counted from the   *)
(* commit, which may come later than the accepted entry.                    *)
Wit_FromVisibility == wWinner = "elapse" => wAt >= commitAt + Secs

(* The stored deadline and entry never change (retries, continue-as-new).  *)
Prop_DeadlineFixed == [][(dl # NoTime => dl' = dl)]_vars
Prop_EntryFixed == [][(accAt # NoTime => accAt' = accAt)]_vars

(* The first stored result is kept.                                         *)
Prop_FirstResultKept ==
    [][(wState = "completed" => (wState' = "completed" /\ wWinner' = wWinner /\ wAt' = wAt))]_vars

(* A pending wait is eventually decided, also while its run stays paused.  *)
Live_WaitDecided == (wState = "pending") ~> (wState = "completed")

=============================================================================
