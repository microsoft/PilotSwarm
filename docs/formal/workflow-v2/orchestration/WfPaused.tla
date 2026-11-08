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
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Code, AllowResume, AllowChildComplete, AllowEndFail, PauseFirst

ASSUME Code \in {"efe44835", "1c117a47", "1f7bdc77", "a99cd382"}
Fixed == Code \in {"1c117a47", "1f7bdc77", "a99cd382"}
E2 == Code = "a99cd382"   \* 1f7bdc77 = 1c117a47 + group D; these paths are unchanged

VARIABLES
    paused,     \* the run's status is paused (store)
    pauses,     \* pauses accepted (at most one)
    b1,         \* branch 1's cursor: "ready", "admitted" (its next state pending, no deadline)
    n2,         \* branch 2's agent state: "pending", "agent_ok", "timed_out"
    child,      \* branch 2's child: "active", "ended"
    ctlDue, storeDue,
    armed,      \* the controller still holds branch 2's deadline (1c117a47 clears it once elapsed)
    pc,         \* "admit", "paused", "elapse", "collect", "wait"
    routed,     \* branch 2's result was collected and routed
    endFailed,  \* an end command failed (once)
    admittedPaused  \* history: a state was admitted while the run was paused

vars == <<paused, pauses, b1, n2, child, ctlDue, storeDue, armed, pc, routed, endFailed, admittedPaused>>

Init ==
    /\ paused = PauseFirst /\ pauses = IF PauseFirst THEN 1 ELSE 0
    /\ b1 = "ready" /\ n2 = "pending" /\ child = "active"
    /\ ctlDue = FALSE /\ storeDue = FALSE /\ armed = TRUE
    /\ pc = "admit" /\ routed = FALSE /\ endFailed = FALSE /\ admittedPaused = FALSE

(* End branch 2's child (endAgent): sent, or failed once (traced).        *)
EndChild ==
    \/ child' = "ended" /\ UNCHANGED endFailed
    \/ AllowEndFail /\ ~endFailed /\ endFailed' = TRUE /\ UNCHANGED child

----------------------------------------------------------------------------
(* The environment.                                                         *)
Pause ==
    /\ ~paused /\ pauses = 0
    /\ paused' = TRUE /\ pauses' = 1
    /\ UNCHANGED <<b1, n2, child, ctlDue, storeDue, armed, pc, routed, endFailed, admittedPaused>>

Resume ==
    /\ AllowResume /\ paused
    /\ paused' = FALSE
    /\ UNCHANGED <<pauses, b1, n2, child, ctlDue, storeDue, armed, pc, routed, endFailed, admittedPaused>>

CtlClock ==
    /\ ~ctlDue /\ ctlDue' = TRUE
    /\ UNCHANGED <<paused, pauses, b1, n2, child, storeDue, armed, pc, routed, endFailed, admittedPaused>>

StoreClock ==
    /\ ~storeDue /\ storeDue' = TRUE
    /\ UNCHANGED <<paused, pauses, b1, n2, child, ctlDue, armed, pc, routed, endFailed, admittedPaused>>

(* The child completes its state before the store's deadline.             *)
ChildCompletes ==
    /\ AllowChildComplete /\ n2 = "pending" /\ ~storeDue /\ child = "active"
    /\ n2' = "agent_ok"
    /\ UNCHANGED <<paused, pauses, b1, child, ctlDue, storeDue, armed, pc, routed, endFailed, admittedPaused>>

----------------------------------------------------------------------------
(* The controller.                                                          *)
Admit ==
    /\ pc = "admit"
    /\ IF b1 = "ready"
         THEN IF paused THEN pc' = "paused" /\ UNCHANGED <<b1, admittedPaused>>
              ELSE /\ b1' = "admitted" /\ pc' = "elapse"
                   /\ admittedPaused' = (admittedPaused \/ paused)
         ELSE pc' = "elapse" /\ UNCHANGED <<b1, admittedPaused>>
    /\ UNCHANGED <<paused, pauses, n2, child, ctlDue, storeDue, armed, routed, endFailed>>

(* The paused path.                                                         *)
PausedPath ==
    /\ pc = "paused"
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

(* 2. Elapse a due state (the store's clock decides).                      *)
Elapse ==
    /\ pc = "elapse"
    /\ IF ctlDue /\ armed /\ n2 = "pending" /\ storeDue
         THEN n2' = "timed_out" /\ armed' = FALSE
         ELSE UNCHANGED <<n2, armed>>
    /\ pc' = "collect"
    /\ UNCHANGED <<paused, pauses, b1, child, ctlDue, storeDue, routed, endFailed, admittedPaused>>

(* Collect and route branch 2's result; its child is ended (best effort). *)
Collect ==
    /\ pc = "collect"
    /\ IF n2 # "pending" /\ ~routed
         THEN /\ routed' = TRUE
              /\ IF child = "active" THEN EndChild ELSE UNCHANGED <<child, endFailed>>
         ELSE UNCHANGED <<routed, child, endFailed>>
    /\ pc' = "wait"
    /\ UNCHANGED <<paused, pauses, b1, n2, ctlDue, storeDue, armed, admittedPaused>>

(* 3. Wait for a wake, a command or the nearest deadline; then loop.       *)
Wait ==
    /\ pc = "wait"
    /\ pc' = "admit"
    /\ UNCHANGED <<paused, pauses, b1, n2, child, ctlDue, storeDue, armed, routed, endFailed, admittedPaused>>

Controller == Admit \/ PausedPath \/ Elapse \/ Collect \/ Wait

Next == Controller \/ Pause \/ Resume \/ CtlClock \/ StoreClock \/ ChildCompletes

(* Fairness: the controller runs; both clocks pass the deadline. A pause, *)
(* a resume and the child's completion are free choices.                  *)
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Controller) /\ WF_vars(CtlClock) /\ WF_vars(StoreClock)

----------------------------------------------------------------------------
TypeOK ==
    /\ paused \in BOOLEAN /\ pauses \in 0..1
    /\ b1 \in {"ready", "admitted"} /\ n2 \in {"pending", "agent_ok", "timed_out"}
    /\ child \in {"active", "ended"} /\ ctlDue \in BOOLEAN /\ storeDue \in BOOLEAN /\ armed \in BOOLEAN
    /\ pc \in {"admit", "paused", "elapse", "collect", "wait"}
    /\ routed \in BOOLEAN /\ endFailed \in BOOLEAN /\ admittedPaused \in BOOLEAN

(* Safety rules.                                                           *)
Inv_NoAdmissionWhilePaused == ~admittedPaused
Inv_NoChildAfterTimeoutRouted == (routed /\ n2 = "timed_out" /\ ~endFailed) => child = "ended"

(* Liveness: a state past its deadline is decided, paused or not; a timed- *)
(* out state's child is ended; a completed state's child is ended.        *)
Prop_DeadlineEnforced == (storeDue /\ ctlDue) ~> (n2 # "pending")
Prop_TimedOutChildEnded == (n2 = "timed_out") ~> (child = "ended")
Prop_DoneChildEnded == (n2 = "agent_ok") ~> (child = "ended")

(* Witnesses, EXPECTED to be violated (reachable).                        *)
Wit_PausedElapse == ~(paused /\ n2 = "timed_out" /\ child = "ended" /\ ~routed)
Wit_PausedPath == pc # "paused"
(* r2e: a99cd382 ends a completed state's child while still paused.       *)
Wit_PausedDoneEnded == ~(paused /\ n2 = "agent_ok" /\ child = "ended" /\ ~routed)
=============================================================================
