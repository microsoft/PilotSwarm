------------------------------ MODULE WfRecover ------------------------------
(***************************************************************************)
(* r2 (fidelity FR-1; RT-3, RT-4). A run's end and its debts when its     *)
(* controller dies, and update_workflow recover. The run has one agent    *)
(* state whose child was spawned and is active, and a parent that is told *)
(* of the run's end.                                                       *)
(*                                                                         *)
(* The controller (1.9.0) ends a run in three steps that are not one      *)
(* transaction (runtime.ts finishRun, reportEnded): the terminal store    *)
(* commit (the pending state is decided); afterEnd, which ends the        *)
(* children of decided agent states (endAgents); and the notifyParent    *)
(* activity. Its orchestration can die before, between or after them (a *)
(* persisted activity that runs out of attempts fails the orchestration; *)
(* an operator can terminate it).                                          *)
(*                                                                         *)
(* recover (service.ts recoverWorkflowRun): a run whose controller      *)
(* ended without ending it is ended (failed, controller_ended; its        *)
(* pending state is decided). Then:                                        *)
(*   efe44835: notifyRecoveredRun starts the notifier                     *)
(*     workflow-notify-<run> only for a failed controller_ended run (a    *)
(*     second start of that instance is ignored); no child is ended.      *)
(*   1c117a47: finishRecoveredRun ends every owed child                    *)
(*     (endWorkflowRunAgents; RT-3), then, for any terminal live run    *)
(*     whose end was neither notified nor skipped, whose controller ended *)
(*     and whose notifier is not running, starts the notifier, or one     *)
(*     named for the recover's operation id when that instance already   *)
(*     ended (RT-4). A failed child end still starts the notification;   *)
(*     the recover then fails and a later one ends the rest.              *)
(* A notifier is an orchestration that runs notifyParent (persisted); it  *)
(* can run out of attempts (AllowNotifierExhaust, once: the outage ends). *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Code,                 \* "efe44835" or "1c117a47"
    MaxDeaths,            \* controller deaths (0 or 1)
    DieAt,                \* "any": before, between or after the end's steps; "run": only while the run is active
    MaxRecovers,          \* update_workflow recover calls (each its own operation id)
    AllowNotifierExhaust, \* a notifier runs out of attempts once
    AllowEndFail          \* a recover's child end fails once (transient)

ASSUME Code \in {"efe44835", "1c117a47", "1f7bdc77"} /\ DieAt \in {"any", "run"}
Fixed == Code \in {"1c117a47", "1f7bdc77"}   \* 1f7bdc77 = 1c117a47 + group D; these paths are unchanged
Insts == 0..MaxRecovers   \* 0: workflow-notify-<run>; k: the one recover k names for its operation id

VARIABLES
    runSt,      \* "running", "completed" (the controller's end), "failed_ce" (a recover's end)
    ctl,        \* the controller: "run", "agents", "notify", "done", "dead"
    child,      \* the agent state's child: "active", "ended"
    noticeRec,  \* workflow.parent_notified or parent_notification_skipped recorded for the run
    inst,       \* notifier instances: "none", "running", "ok", "failed"
    deaths, recovers, exhausted, endFailed,
    rc          \* the recover call in progress: "idle", "inspect", "agents", "notify"

vars == <<runSt, ctl, child, noticeRec, inst, deaths, recovers, exhausted, endFailed, rc>>

Init ==
    /\ runSt = "running" /\ ctl = "run" /\ child = "active" /\ noticeRec = FALSE
    /\ inst = [k \in Insts |-> "none"]
    /\ deaths = 0 /\ recovers = 0 /\ exhausted = FALSE /\ endFailed = FALSE /\ rc = "idle"

Terminal == runSt # "running"
CtlEnded == ctl \in {"done", "dead"}

----------------------------------------------------------------------------
(* The controller.                                                          *)
CtlCommit ==      \* finishRun's terminal transaction (a pending state is decided)
    /\ ctl = "run" /\ runSt = "running"
    /\ runSt' = "completed" /\ ctl' = "agents"
    /\ UNCHANGED <<child, noticeRec, inst, deaths, recovers, exhausted, endFailed, rc>>

CtlEndAgents ==   \* afterEnd: endAgents (the end command is queued to the child)
    /\ ctl = "agents"
    /\ child' = "ended" /\ ctl' = "notify"
    /\ UNCHANGED <<runSt, noticeRec, inst, deaths, recovers, exhausted, endFailed, rc>>

CtlNotify ==      \* the notifyParent activity: notified (or skipped) is recorded
    /\ ctl = "notify"
    /\ noticeRec' = TRUE /\ ctl' = "done"
    /\ UNCHANGED <<runSt, child, inst, deaths, recovers, exhausted, endFailed, rc>>

CtlDies ==
    /\ deaths < MaxDeaths
    /\ IF DieAt = "run" THEN ctl = "run" ELSE ctl \in {"run", "agents", "notify"}
    /\ ctl' = "dead" /\ deaths' = deaths + 1
    /\ UNCHANGED <<runSt, child, noticeRec, inst, recovers, exhausted, endFailed, rc>>

(* A notifier instance: notifyParent records the notice, or every attempt *)
(* fails (once: the outage then ends).                                     *)
NotifierRuns(k) ==
    /\ inst[k] = "running"
    /\ \/ /\ inst' = [inst EXCEPT ![k] = "ok"] /\ noticeRec' = TRUE /\ UNCHANGED exhausted
       \/ /\ AllowNotifierExhaust /\ ~exhausted /\ ~noticeRec
          /\ inst' = [inst EXCEPT ![k] = "failed"] /\ exhausted' = TRUE /\ UNCHANGED noticeRec
    /\ UNCHANGED <<runSt, ctl, child, deaths, recovers, endFailed, rc>>

----------------------------------------------------------------------------
(* update_workflow recover. Each call is a new operation id. Model        *)
(* simplification: recover is called only after the controller ended and *)
(* while no notifier runs. A recover before that changes nothing a later  *)
(* one does not do (1c117a47 leaves a live controller's run to it), so   *)
(* the bounded calls are not spent early.                                 *)
RecoverStart ==
    /\ rc = "idle" /\ recovers < MaxRecovers /\ CtlEnded
    /\ \A k \in Insts : inst[k] # "running"
    /\ recovers' = recovers + 1 /\ rc' = "inspect"
    /\ UNCHANGED <<runSt, ctl, child, noticeRec, inst, deaths, exhausted, endFailed>>

(* inspectWorkflowController + store.finishRun: a run whose controller   *)
(* ended without ending it is ended (its pending state is decided).       *)
RecoverInspect ==
    /\ rc = "inspect"
    /\ runSt' = IF runSt = "running" /\ ctl = "dead" THEN "failed_ce" ELSE runSt
    /\ rc' = IF Fixed THEN "agents" ELSE "notify"
    /\ UNCHANGED <<ctl, child, noticeRec, inst, deaths, recovers, exhausted, endFailed>>

(* 1c117a47: endWorkflowRunAgents for a terminal run (RT-3).             *)
RecoverAgents ==
    /\ rc = "agents"
    /\ IF Terminal /\ child = "active"
         THEN \/ child' = "ended" /\ UNCHANGED endFailed
              \/ AllowEndFail /\ ~endFailed /\ endFailed' = TRUE /\ UNCHANGED child
         ELSE UNCHANGED <<child, endFailed>>
    /\ rc' = "notify"
    /\ UNCHANGED <<runSt, ctl, noticeRec, inst, deaths, recovers, exhausted>>

RecoverNotify ==
    /\ rc = "notify"
    /\ IF ~Fixed
         THEN inst' = IF runSt = "failed_ce" /\ inst[0] = "none" THEN [inst EXCEPT ![0] = "running"] ELSE inst
         ELSE inst' = IF Terminal /\ ~noticeRec /\ CtlEnded
                        THEN IF inst[0] = "none" THEN [inst EXCEPT ![0] = "running"]
                             ELSE IF inst[0] \in {"ok", "failed"} /\ inst[recovers] = "none"
                               THEN [inst EXCEPT ![recovers] = "running"]
                             ELSE inst
                        ELSE inst
    /\ rc' = "idle"
    /\ UNCHANGED <<runSt, ctl, child, noticeRec, deaths, recovers, exhausted, endFailed>>

(* Nothing more to do: the controller ended and no recover or notifier   *)
(* runs (the end of a behavior, not a deadlock).                          *)
Done ==
    /\ CtlEnded /\ rc = "idle" /\ \A k \in Insts : inst[k] # "running"
    /\ UNCHANGED vars

Next ==
    \/ Done \/ CtlCommit \/ CtlEndAgents \/ CtlNotify \/ CtlDies
    \/ \E k \in Insts : NotifierRuns(k)
    \/ RecoverStart \/ RecoverInspect \/ RecoverAgents \/ RecoverNotify

(* Fairness: a live controller and every notifier proceed; a recover in   *)
(* progress finishes; and an operator recovers while the controller has   *)
(* ended and something is still owed (until MaxRecovers calls). Deaths,  *)
(* exhaustion and failed child ends are free choices.                     *)
Owed == runSt = "running" \/ child = "active" \/ ~noticeRec
Fairness ==
    /\ WF_vars(CtlCommit) /\ WF_vars(CtlEndAgents) /\ WF_vars(CtlNotify)
    /\ \A k \in Insts : WF_vars(NotifierRuns(k))
    /\ WF_vars(RecoverInspect) /\ WF_vars(RecoverAgents) /\ WF_vars(RecoverNotify)
    /\ WF_vars(RecoverStart /\ Owed)

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ Fairness

----------------------------------------------------------------------------
TypeOK ==
    /\ runSt \in {"running", "completed", "failed_ce"}
    /\ ctl \in {"run", "agents", "notify", "done", "dead"}
    /\ child \in {"active", "ended"} /\ noticeRec \in BOOLEAN
    /\ inst \in [Insts -> {"none", "running", "ok", "failed"}]
    /\ deaths \in 0..MaxDeaths /\ recovers \in 0..MaxRecovers
    /\ exhausted \in BOOLEAN /\ endFailed \in BOOLEAN
    /\ rc \in {"idle", "inspect", "agents", "notify"}

(* Safety rules.                                                           *)
Inv_RecoverEndsOnlyDeadController == runSt = "failed_ce" => ctl = "dead"
Inv_ChildEndedOnlyAfterRunEnd == child = "ended" => Terminal
Inv_NotifierOnlyForEndedRun == (\E k \in Insts : inst[k] # "none") => Terminal

(* Liveness: every debt of the run is paid.                                *)
Prop_RunEnds == <>Terminal
Prop_ChildReleased == <>(child = "ended")
Prop_NoticePaid == <>noticeRec

(* Witnesses, EXPECTED to be violated (reachable).                        *)
Wit_RecoverEnds == runSt # "failed_ce"
Wit_RecoverNamedNotifier == ~(\E k \in Insts : k > 0 /\ inst[k] = "ok")
=============================================================================
