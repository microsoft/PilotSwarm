------------------------------ MODULE WfPaused ------------------------------
(***************************************************************************)
(* r2 (fidelity FR-2; RT-6). A paused parallel run (controller 1.9.0)    *)
(* with a ready branch and a pending agent state with a deadline, and no *)
(* run-wide deadline. Branch 1's cursor is ready (its next state is not  *)
(* admitted yet); branch 2's agent state is pending, its child working.  *)
(*                                                                         *)
(* The controller loop (runtime.ts controlRequestRun): 1. the admission   *)
(* pass enters a ready cursor's next state; the store refuses it while   *)
(* the run is paused, and the pass takes the paused path. Only a ready   *)
(* cursor finds the pause: with none, the loop goes on to 2.              *)
(*   efe44835 paused path: wait for a command or the run's deadline       *)
(*     (none), or the backstop timer; nothing else.                       *)
(*   1c117a47 paused path (RT-6): a pending state past its deadline is    *)
(*     elapsed (the store's clock decides; not due: re-armed), and an    *)
(*     agent state's child is ended at once (a failure is traced, not     *)
(*     retried while paused); nothing is admitted or routed until resume. *)
(* 2. elapse due states (the store's clock decides), collect, route; an   *)
(*    agent state's child is ended when its result is collected.          *)
(* The controller's clock (ctlDue) and the store's (storeDue) each pass  *)
(* the deadline in their own time. The pause is permanent unless          *)
(* AllowResume; resume is never assumed (no fairness).                    *)
(* r2e: Code = "a99cd382" (E2): the paused path collects the pending      *)
(* agent states; one decided while paused (its completion or its elapsed *)
(* deadline) has its child ended at once; a failed end is tried again at *)
(* each paused wake until it is recorded; the deadline branch no longer   *)
(* ends the child itself. Nothing is admitted or routed before resume.   *)
(* r3: Code = "9a8d0f66" (controller 1.9.0 at the PR head): the paused  *)
(* path is pausedPass (runtime.ts 1648). (a) S-RT1 07c29b05: the pause is  *)
(* also found by the collection (pausedNow, 1959), which then routes      *)
(* nothing and hands what it read to pausedPass (seen); the results stay  *)
(* in their cursors and are collected again after the resume. (b) a      *)
(* collection (or the admission) that finds the run ended goes to         *)
(* endedElsewhere (1946, 1669, 1794): its children are ended, it reports. *)
(* (c) IR 9 f2aeeb25: the run is a parallel state P (branches 1 and 2)    *)
(* with its own time limit (TimedJoin): the elapse decides P (cancelling  *)
(* the branches' pending work) and askJoin cuts the branches at once, also *)
(* while paused (1715); P's result is routed after the resume. (d) J1d:   *)
(* a cut child whose end failed is owed and tried again at the top of     *)
(* every pass, paused or not (retryOwedCuts, 1741). The paused pass is    *)
(* three steps here: collect the agent states and end their children,    *)
(* then the deadlines (elapse, askTimedJoins), then the next pass.        *)
(* "proposedR3": 9a8d0f66 with the cut also ending (or owing) the child   *)
(* of a cut branch's agent state that was decided but whose end is not    *)
(* recorded (r3 finding R3-P1).                                           *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Code, AllowResume, AllowChildComplete, AllowEndFail, PauseFirst,
          TimedJoin,          \* r3: the run is a parallel state with its own time limit (IR 9)
          AllowEndElsewhere,  \* r3: another writer ends the run (an accepted cancel or done, a deletion)
          AllowCutFail,       \* r3: the cut's end of a child fails (at most twice: owed, then one failed retry)
          AllowPause          \* r3: a pause may be accepted (FALSE: never; PauseFirst still pauses at the start)

New == Code \in {"9a8d0f66", "proposedR3"}
FixCut == Code = "proposedR3"

ASSUME Code \in {"efe44835", "1c117a47", "1f7bdc77", "a99cd382", "9a8d0f66", "proposedR3"}
ASSUME /\ TimedJoin \in BOOLEAN /\ AllowEndElsewhere \in BOOLEAN
       /\ AllowCutFail \in BOOLEAN /\ AllowPause \in BOOLEAN
ASSUME TimedJoin => New                       \* IR 9 time limits came after a99cd382
ASSUME AllowEndElsewhere => Code \in {"a99cd382", "9a8d0f66", "proposedR3"}
Fixed == Code \in {"1c117a47", "1f7bdc77", "a99cd382", "9a8d0f66", "proposedR3"}
E2 == Code = "a99cd382"   \* 1f7bdc77 = 1c117a47 + group D; these paths are unchanged

VARIABLES
    paused,     \* the run's status is paused (store)
    pauses,     \* pauses accepted (at most one)
    b1,         \* branch 1's cursor: "ready", "admitted" (its next state pending, no deadline), "gone" (cut)
    n2,         \* branch 2's agent state: "pending", "agent_ok", "timed_out",
                \*   "cut" (P's time limit cancelled it), "cancelled" (the run's end did)
    child,      \* branch 2's child: "active", "ended"
    ctlDue, storeDue,
    armed,      \* the controller still holds branch 2's deadline (1c117a47 clears it once elapsed)
    pc,         \* "top", "admit", "paused", "pdeadline", "elapse", "collect", "wait", "done"
    routed,     \* branch 2's result was collected and routed
    endFailed,  \* an end command failed (once)
    admittedPaused, \* history: a state was admitted while the run was paused
    \* r3
    ended,      \* another writer ended the run (store)
    seen,       \* what the collection that found the pause read of branch 2: "none" (no such collection), "yes", "no"
    pst,        \* P, the parallel state: "none" (no time limit), "pending", "decided" (by its time limit), "cancelled" (run end)
    pDue,       \* P's time limit passed (both clocks)
    cut,        \* the controller cut P's branches (their cursors are gone)
    owed,       \* the cut's end of branch 2's child is owed (J1d)
    cutFails,   \* failed cut ends so far
    pRouted,    \* P's own result was routed
    routedPaused, \* history: a result was routed by a collection that read the run paused
    routedEnded   \* history: a result was routed by a collection that read the run ended

oldVars == <<paused, pauses, b1, n2, child, ctlDue, storeDue, armed, pc, routed, endFailed, admittedPaused>>
newVars == <<ended, seen, pst, pDue, cut, owed, cutFails, pRouted, routedPaused, routedEnded>>
vars == <<paused, pauses, b1, n2, child, ctlDue, storeDue, armed, pc, routed, endFailed, admittedPaused,
          ended, seen, pst, pDue, cut, owed, cutFails, pRouted, routedPaused, routedEnded>>

Init ==
    /\ paused = PauseFirst /\ pauses = IF PauseFirst THEN 1 ELSE 0
    /\ b1 = "ready" /\ n2 = "pending" /\ child = "active"
    /\ ctlDue = FALSE /\ storeDue = FALSE /\ armed = TRUE
    /\ pc = (IF New THEN "top" ELSE "admit")
    /\ routed = FALSE /\ endFailed = FALSE /\ admittedPaused = FALSE
    /\ ended = FALSE /\ seen = "none" /\ pst = (IF TimedJoin THEN "pending" ELSE "none") /\ pDue = FALSE
    /\ cut = FALSE /\ owed = FALSE /\ cutFails = 0 /\ pRouted = FALSE
    /\ routedPaused = FALSE /\ routedEnded = FALSE

(* End branch 2's child (endAgent): sent, or failed once (traced).        *)
EndChild ==
    \/ child' = "ended" /\ UNCHANGED endFailed
    \/ AllowEndFail /\ ~endFailed /\ endFailed' = TRUE /\ UNCHANGED child

----------------------------------------------------------------------------
(* The environment.                                                         *)
Pause ==
    /\ AllowPause /\ ~ended
    /\ ~paused /\ pauses = 0
    /\ paused' = TRUE /\ pauses' = 1
    /\ UNCHANGED <<b1, n2, child, ctlDue, storeDue, armed, pc, routed, endFailed, admittedPaused>>
    /\ UNCHANGED newVars

Resume ==
    /\ AllowResume /\ paused
    /\ paused' = FALSE
    /\ UNCHANGED <<pauses, b1, n2, child, ctlDue, storeDue, armed, pc, routed, endFailed, admittedPaused>>
    /\ UNCHANGED newVars

CtlClock ==
    /\ ~ctlDue /\ ctlDue' = TRUE
    /\ UNCHANGED <<paused, pauses, b1, n2, child, storeDue, armed, pc, routed, endFailed, admittedPaused>>
    /\ UNCHANGED newVars

StoreClock ==
    /\ ~storeDue /\ storeDue' = TRUE
    /\ UNCHANGED <<paused, pauses, b1, n2, child, ctlDue, armed, pc, routed, endFailed, admittedPaused>>
    /\ UNCHANGED newVars

(* r3: P's own time limit passes (the controller's and the store's clocks *)
(* together).                                                              *)
PClock ==
    /\ TimedJoin /\ pst = "pending" /\ ~pDue
    /\ pDue' = TRUE
    /\ UNCHANGED oldVars
    /\ UNCHANGED <<ended, seen, pst, cut, owed, cutFails, pRouted, routedPaused, routedEnded>>

(* The child completes its state before the store's deadline.             *)
ChildCompletes ==
    /\ AllowChildComplete /\ n2 = "pending" /\ ~storeDue /\ child = "active"
    /\ n2' = "agent_ok"
    /\ UNCHANGED <<paused, pauses, b1, child, ctlDue, storeDue, armed, pc, routed, endFailed, admittedPaused>>
    /\ UNCHANGED newVars

(* r3: another writer ends the run (S7-DX2: an accepted cancel or done;   *)
(* a deletion): its pending work is decided; the run is no longer paused. *)
EndElsewhere ==
    /\ AllowEndElsewhere /\ ~ended
    /\ ended' = TRUE /\ paused' = FALSE
    /\ n2' = (IF n2 = "pending" THEN "cancelled" ELSE n2)
    /\ pst' = (IF pst = "pending" THEN "cancelled" ELSE pst)
    /\ UNCHANGED <<pauses, b1, child, ctlDue, storeDue, armed, pc, routed, endFailed, admittedPaused>>
    /\ UNCHANGED <<seen, pDue, cut, owed, cutFails, pRouted, routedPaused, routedEnded>>

----------------------------------------------------------------------------
(* The controller up to a99cd382 (unchanged but for the run ended         *)
(* elsewhere, which only AllowEndElsewhere makes possible).                *)
Admit ==
    /\ ~New /\ pc = "admit"
    /\ IF b1 = "ready"
         THEN IF ended
                THEN pc' = "done" /\ child' = "ended" /\ UNCHANGED <<b1, admittedPaused>>   \* a99cd382: afterEnd, no notice
              ELSE IF paused
                THEN pc' = "paused" /\ UNCHANGED <<b1, admittedPaused, child>>
              ELSE /\ b1' = "admitted" /\ pc' = "elapse"
                   /\ admittedPaused' = (admittedPaused \/ paused)
                   /\ UNCHANGED child
         ELSE pc' = "elapse" /\ UNCHANGED <<b1, admittedPaused, child>>
    /\ UNCHANGED <<paused, pauses, n2, ctlDue, storeDue, armed, routed, endFailed>>
    /\ UNCHANGED newVars

(* The paused path.                                                         *)
PausedPath ==
    /\ ~New /\ pc = "paused"
    /\ IF E2 /\ n2 # "pending" /\ child = "active"
         THEN \/ child' = "ended" /\ armed' = FALSE /\ UNCHANGED <<n2, endFailed>>   \* collected: its end is recorded
              \/ AllowEndFail /\ ~endFailed /\ endFailed' = TRUE /\ UNCHANGED <<n2, armed, child>>   \* traced; tried at the next wake
       ELSE IF E2 /\ ctlDue /\ armed /\ n2 = "pending"
         THEN IF storeDue
                THEN n2' = "timed_out" /\ armed' = FALSE /\ UNCHANGED <<child, endFailed>>   \* the collection ends it
                ELSE UNCHANGED <<n2, armed, child, endFailed>>
       ELSE IF Fixed /\ ~E2 /\ ctlDue /\ armed /\ n2 = "pending"
         THEN IF storeDue
                THEN /\ n2' = "timed_out" /\ armed' = FALSE /\ EndChild
                ELSE UNCHANGED <<n2, armed, child, endFailed>>     \* not due: re-armed
       ELSE IF Fixed /\ ctlDue /\ armed /\ n2 # "pending"
         THEN armed' = FALSE /\ UNCHANGED <<n2, child, endFailed>>  \* decided meanwhile: not elapsed again
       ELSE UNCHANGED <<n2, armed, child, endFailed>>              \* wait for a command or the timer
    /\ pc' = "admit"
    /\ UNCHANGED <<paused, pauses, b1, ctlDue, storeDue, routed, admittedPaused>>
    /\ UNCHANGED newVars

(* 2. Elapse a due state (the store's clock decides).                      *)
Elapse ==
    /\ ~New /\ pc = "elapse"
    /\ IF ctlDue /\ armed /\ n2 = "pending" /\ storeDue
         THEN n2' = "timed_out" /\ armed' = FALSE
         ELSE UNCHANGED <<n2, armed>>
    /\ pc' = "collect"
    /\ UNCHANGED <<paused, pauses, b1, child, ctlDue, storeDue, routed, endFailed, admittedPaused>>
    /\ UNCHANGED newVars

(* Collect and route branch 2's result; its child is ended (best effort). *)
(* Up to a99cd382 the collection reads neither the pause nor a run's end. *)
Collect ==
    /\ ~New /\ pc = "collect"
    /\ IF n2 # "pending" /\ ~routed
         THEN /\ routed' = TRUE
              /\ IF child = "active" THEN EndChild ELSE UNCHANGED <<child, endFailed>>
         ELSE UNCHANGED <<routed, child, endFailed>>
    /\ routedPaused' = (routedPaused \/ (paused /\ n2 # "pending" /\ ~routed))
    /\ routedEnded' = (routedEnded \/ (ended /\ n2 # "pending" /\ ~routed))
    /\ pc' = "wait"
    /\ UNCHANGED <<paused, pauses, b1, n2, ctlDue, storeDue, armed, admittedPaused>>
    /\ UNCHANGED <<ended, seen, pst, pDue, cut, owed, cutFails, pRouted>>

(* 3. Wait for a wake, a command or the nearest deadline; then loop.       *)
Wait ==
    /\ pc = "wait"
    /\ pc' = (IF New THEN "top" ELSE "admit")
    /\ UNCHANGED <<paused, pauses, b1, n2, child, ctlDue, storeDue, armed, routed, endFailed, admittedPaused>>
    /\ UNCHANGED newVars

----------------------------------------------------------------------------
(* r3: the controller at 9a8d0f66 (controlRequestRun, runtime.ts 1411).    *)

(* 0a. retryOwedCuts (J1d, 1741): every pass, paused or not, tries the     *)
(* owed end again (at most once per backstop period: here every pass).    *)
Top ==
    /\ New /\ pc = "top"
    /\ IF owed
         THEN \/ child' = "ended" /\ owed' = FALSE /\ UNCHANGED cutFails
              \/ AllowCutFail /\ cutFails < 2 /\ cutFails' = cutFails + 1 /\ UNCHANGED <<child, owed>>
         ELSE UNCHANGED <<child, owed, cutFails>>
    /\ pc' = "admit"
    /\ UNCHANGED <<paused, pauses, b1, n2, ctlDue, storeDue, armed, routed, endFailed, admittedPaused>>
    /\ UNCHANGED <<ended, seen, pst, pDue, cut, pRouted, routedPaused, routedEnded>>

(* reportEnded (endedElsewhere): every owed child is ended (endRunAgents), *)
(* then the parent is told.                                               *)

(* 1. The admission of a ready cursor: the store refuses it while the run *)
(* is paused (inactive before cut, store.ts 3637), or ended.               *)
AdmitNew ==
    /\ New /\ pc = "admit"
    /\ IF b1 = "ready"
         THEN IF ended
                THEN pc' = "done" /\ child' = "ended" /\ owed' = FALSE /\ UNCHANGED <<b1, admittedPaused>>
              ELSE IF paused
                THEN pc' = "paused" /\ UNCHANGED <<b1, admittedPaused, child, owed>>
              ELSE /\ b1' = "admitted" /\ pc' = "elapse"
                   /\ admittedPaused' = (admittedPaused \/ paused)
                   /\ UNCHANGED <<child, owed>>
         ELSE pc' = "elapse" /\ UNCHANGED <<b1, admittedPaused, child, owed>>
    /\ UNCHANGED <<paused, pauses, n2, ctlDue, storeDue, armed, routed, endFailed>>
    /\ UNCHANGED <<ended, seen, pst, pDue, cut, cutFails, pRouted, routedPaused, routedEnded>>

(* The deadlines, in step 2 and in the paused pass: one elapse call for    *)
(* the due states in cursor order (P's root cursor first: its time limit  *)
(* cancels branch 2's pending work before branch 2's own elapse looks),   *)
(* then askTimedJoins: P decided, askJoin cuts both branches at once. The *)
(* cut ends only the children of work a cut decided (cancelBranchScopes   *)
(* lists winners fail_fast/join/join_timeout, store.ts 6933); proposedR3   *)
(* also ends a decided state's child whose end is not recorded.            *)
Deadlines ==
    LET pNow  == TimedJoin /\ pDue /\ pst = "pending"
        nDue  == ctlDue /\ armed /\ ~routed /\ ~cut
        n2a   == IF pNow /\ n2 = "pending" THEN "cut"
                 ELSE IF nDue /\ storeDue /\ n2 = "pending" THEN "timed_out" ELSE n2
        endIt == child = "active" /\ (n2a = "cut" \/ FixCut)
    IN /\ n2' = n2a
       \* not due by the store's clock: re-armed; elapsed or decided meanwhile: cleared
       /\ armed' = (IF nDue /\ ~(n2 = "pending" /\ ~storeDue /\ ~pNow) THEN FALSE ELSE armed)
       /\ IF pNow
            THEN /\ pst' = "decided" /\ cut' = TRUE /\ b1' = "gone"
                 /\ IF endIt
                      THEN \/ child' = "ended" /\ UNCHANGED <<owed, cutFails>>
                           \/ AllowCutFail /\ cutFails < 2 /\ owed' = TRUE /\ cutFails' = cutFails + 1 /\ UNCHANGED child
                      ELSE UNCHANGED <<child, owed, cutFails>>
            ELSE UNCHANGED <<pst, cut, b1, child, owed, cutFails>>

(* 2. Elapse the due states, ask the timed joins (runtime.ts 1913-1934).   *)
ElapseNew ==
    /\ New /\ pc = "elapse"
    /\ Deadlines
    /\ pc' = "collect"
    /\ UNCHANGED <<paused, pauses, ctlDue, storeDue, routed, endFailed, admittedPaused>>
    /\ UNCHANGED <<ended, seen, pDue, pRouted, routedPaused, routedEnded>>

(* 2. Collect (1944): the results, then the run read after them. Ended:   *)
(* endedElsewhere. Paused (pausedNow): no child ended here, nothing        *)
(* routed; pausedPass(collected). Else children ended, results routed.     *)
CollectNew ==
    /\ New /\ pc = "collect"
    /\ LET gotN == n2 # "pending" /\ ~routed /\ ~cut   \* branch 2's cursor still waits on n2
           gotP == pst = "decided" /\ ~pRouted          \* the root cursor waits on P
       IN IF ended
            THEN /\ pc' = "done" /\ child' = "ended" /\ owed' = FALSE
                 /\ UNCHANGED <<routed, pRouted, endFailed, seen, routedPaused, routedEnded>>
          ELSE IF paused
            THEN /\ pc' = "paused" /\ seen' = (IF gotN THEN "yes" ELSE "no")
                 /\ UNCHANGED <<routed, pRouted, child, endFailed, owed, routedPaused, routedEnded>>
          ELSE /\ routed' = (routed \/ gotN)
               /\ pRouted' = (pRouted \/ gotP)
               /\ IF gotN /\ child = "active" THEN EndChild ELSE UNCHANGED <<child, endFailed>>
               /\ routedPaused' = (routedPaused \/ (paused /\ (gotN \/ gotP)))
               /\ routedEnded' = (routedEnded \/ (ended /\ (gotN \/ gotP)))
               /\ pc' = "wait"
               /\ UNCHANGED <<seen, owed>>
    /\ UNCHANGED <<paused, pauses, b1, n2, ctlDue, storeDue, armed, admittedPaused>>
    /\ UNCHANGED <<ended, pst, pDue, cut, cutFails>>

(* 1a. pausedPass, its first part (1648-1687): the pending agent states    *)
(* whose end is not recorded; found by the admission (seen "none"): one   *)
(* collection, which may find the run ended; found by a collection: what *)
(* it read. A decided one has its child ended now (a failure: next pass). *)
PausedCollect ==
    /\ New /\ pc = "paused"
    /\ LET agent   == ~routed /\ ~cut /\ child = "active"
           decided == IF seen = "none" THEN n2 # "pending" ELSE seen = "yes"
       IN IF agent /\ seen = "none" /\ ended
            THEN /\ pc' = "done" /\ child' = "ended" /\ owed' = FALSE
                 /\ UNCHANGED <<armed, endFailed>>
          ELSE IF agent /\ decided
            THEN /\ \/ child' = "ended" /\ armed' = FALSE /\ UNCHANGED endFailed
                    \/ AllowEndFail /\ ~endFailed /\ endFailed' = TRUE /\ UNCHANGED <<child, armed>>
                 /\ pc' = "pdeadline"
                 /\ UNCHANGED owed
          ELSE /\ pc' = "pdeadline"
               /\ UNCHANGED <<child, armed, endFailed, owed>>
    /\ seen' = "none"
    /\ UNCHANGED <<paused, pauses, b1, n2, ctlDue, storeDue, routed, admittedPaused>>
    /\ UNCHANGED <<ended, pst, pDue, cut, cutFails, pRouted, routedPaused, routedEnded>>

(* 1a. pausedPass, its second part (1688-1729): the deadlines and the      *)
(* timed joins (IR 9 Q2), then the wait; nothing admitted or routed.      *)
PausedDeadlines ==
    /\ New /\ pc = "pdeadline"
    /\ Deadlines
    /\ pc' = "top"
    /\ UNCHANGED <<paused, pauses, ctlDue, storeDue, routed, endFailed, admittedPaused>>
    /\ UNCHANGED <<ended, seen, pDue, pRouted, routedPaused, routedEnded>>

(* The controller ended (it reported, or ended the children): nothing left. *)
Finished == pc = "done" /\ UNCHANGED vars

Controller ==
    \/ Admit \/ PausedPath \/ Elapse \/ Collect \/ Wait
    \/ Top \/ AdmitNew \/ PausedCollect \/ PausedDeadlines \/ ElapseNew \/ CollectNew

Next ==
    \/ Controller \/ Pause \/ Resume \/ CtlClock \/ StoreClock \/ ChildCompletes
    \/ PClock \/ EndElsewhere \/ Finished

(* Fairness: the controller runs; the clocks pass the deadlines. A pause, *)
(* a resume, the child's completion and a run's end elsewhere are free.   *)
(* ResumeSpec: a pause is resumed (for "routed after the resume").        *)
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Controller) /\ WF_vars(CtlClock) /\ WF_vars(StoreClock) /\ WF_vars(PClock)
ResumeSpec == LiveSpec /\ WF_vars(Resume)

----------------------------------------------------------------------------
TypeOK ==
    /\ paused \in BOOLEAN /\ pauses \in 0..1
    /\ b1 \in {"ready", "admitted", "gone"}
    /\ n2 \in {"pending", "agent_ok", "timed_out", "cut", "cancelled"}
    /\ child \in {"active", "ended"} /\ ctlDue \in BOOLEAN /\ storeDue \in BOOLEAN /\ armed \in BOOLEAN
    /\ pc \in {"top", "admit", "paused", "pdeadline", "elapse", "collect", "wait", "done"}
    /\ routed \in BOOLEAN /\ endFailed \in BOOLEAN /\ admittedPaused \in BOOLEAN
    /\ ended \in BOOLEAN /\ seen \in {"none", "yes", "no"}
    /\ pst \in {"none", "pending", "decided", "cancelled"} /\ pDue \in BOOLEAN
    /\ cut \in BOOLEAN /\ owed \in BOOLEAN /\ cutFails \in 0..2
    /\ pRouted \in BOOLEAN /\ routedPaused \in BOOLEAN /\ routedEnded \in BOOLEAN

(* Safety rules.                                                           *)
Inv_NoAdmissionWhilePaused == ~admittedPaused
Inv_NoChildAfterTimeoutRouted == (routed /\ n2 = "timed_out" /\ ~endFailed) => child = "ended"
(* r3 *)
Inv_NoRouteWhilePaused == ~routedPaused        \* no collection that read the pause routes a result
Inv_NoRouteAfterEnd == ~routedEnded            \* no collection that read the run ended routes a result
Inv_TimedJoinCut == (pst = "decided") => cut   \* a time limit's decision cuts the branches at once
Inv_ParallelRoutedAfterCut == pRouted => cut
Inv_CutNotRouted == (n2 = "cut") => ~routed    \* a cut branch's result goes nowhere

(* Liveness: a state past its deadline is decided, paused or not; a timed- *)
(* out state's child is ended; a completed state's child is ended.        *)
Prop_DeadlineEnforced == (storeDue /\ ctlDue) ~> (n2 # "pending")
Prop_TimedOutChildEnded == (n2 = "timed_out") ~> (child = "ended")
Prop_DoneChildEnded == (n2 = "agent_ok") ~> (child = "ended")
(* r3 *)
Prop_TimedJoinDecided == (TimedJoin /\ pDue) ~> (pst # "pending")
Prop_CutChildEnded == (n2 = "cut") ~> (child = "ended")
Prop_OwedCutMade == owed ~> ~owed
Prop_EndedReported == ended ~> (pc = "done")
Prop_DecidedRouted == (n2 \in {"agent_ok", "timed_out"}) ~> (routed \/ cut \/ ended)
Prop_ParallelRouted == (pst = "decided") ~> (pRouted \/ ended)

(* Witnesses, EXPECTED to be violated (reachable).                        *)
Wit_PausedElapse == ~(paused /\ n2 = "timed_out" /\ child = "ended" /\ ~routed)
Wit_PausedPath == pc # "paused"
(* r2e: a99cd382 ends a completed state's child while still paused.       *)
Wit_PausedDoneEnded == ~(paused /\ n2 = "agent_ok" /\ child = "ended" /\ ~routed)
(* r3: the pause found by a collection that read a result (S-RT1).        *)
Wit_PauseAtCollect == ~(pc = "paused" /\ seen = "yes")
(* r3: a timed join decided and its branches cut while paused, unrouted.  *)
Wit_PausedCut == ~(paused /\ pst = "decided" /\ cut /\ ~pRouted)
=============================================================================
