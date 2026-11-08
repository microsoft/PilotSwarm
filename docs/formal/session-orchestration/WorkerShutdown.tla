----------------------------- MODULE WorkerShutdown -----------------------------
(***************************************************************************)
(* Worker graceful shutdown under one deadline (worker.ts 1307-1404 at     *)
(* e76a6133; every worker). Each step races the same deadline (drain       *)
(* budget plus PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS); a hung step is        *)
(* abandoned at the deadline and the later steps are skipped. Steps:       *)
(* drain, workspace release (1374), release sweep (1394,                   *)
(* sweepIdleSessions(1)), stop (1403). The sweep deletes the local copy   *)
(* of a session whose snapshot is committed (it carries the commit         *)
(* marker) and dehydrates an unmarked legacy session (upload, then delete  *)
(* the local copy).                                                        *)
(* Sessions: "c" committed (marker, durable snapshot); "l" legacy          *)
(* (no marker, local state only).                                          *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    HasDeadline,        \* FALSE: the shutdown before its deadline (a hung step waits forever)
    LocalSurvivesExit,  \* the worker-local session folder is there after the process exits
    Fault               \* "none", "delete-unmarked", "marker-early"

ASSUME HasDeadline \in BOOLEAN /\ LocalSurvivesExit \in BOOLEAN
ASSUME Fault \in {"none", "delete-unmarked", "marker-early"}

S == {"c", "l"}
Steps == {"drain", "release", "sweep"}

VARIABLES phase, late, hung, hangs, local, durable, marker, deh, gh
vars == <<phase, late, hung, hangs, local, durable, marker, deh, gh>>

Init ==
    /\ phase = "drain" /\ late = FALSE /\ hung = FALSE /\ hangs = 0
    /\ local = [s \in S |-> TRUE]
    \* marker-early: the marker is written before the snapshot commit lands
    /\ durable = [s \in S |-> s = "c" /\ Fault # "marker-early"]
    /\ marker = [s \in S |-> s = "c"]
    /\ deh = FALSE /\ gh = {}

DeadlinePasses ==
    /\ HasDeadline /\ ~late /\ phase # "exited"
    /\ late' = TRUE
    /\ UNCHANGED <<phase, hung, hangs, local, durable, marker, deh, gh>>

Hang ==
    /\ phase \in Steps /\ ~hung /\ hangs = 0
    /\ hung' = TRUE /\ hangs' = 1
    /\ UNCHANGED <<phase, late, local, durable, marker, deh, gh>>

Next1(p) == IF p = "drain" THEN "release" ELSE "sweep"

StepDone ==
    /\ phase \in {"drain", "release"} /\ ~hung /\ ~late
    /\ phase' = Next1(phase)
    /\ UNCHANGED <<late, hung, hangs, local, durable, marker, deh, gh>>

SweepCommitted ==
    /\ phase = "sweep" /\ ~hung /\ ~late /\ local["c"] /\ marker["c"]
    /\ local' = [local EXCEPT !["c"] = FALSE]
    /\ UNCHANGED <<phase, late, hung, hangs, durable, marker, deh, gh>>

SweepLegacyStart ==
    /\ phase = "sweep" /\ ~hung /\ ~late /\ local["l"] /\ ~marker["l"] /\ ~deh
    /\ IF Fault = "delete-unmarked"
       THEN /\ local' = [local EXCEPT !["l"] = FALSE] /\ gh' = gh \cup {"deletedUnmarked"}
            /\ UNCHANGED deh
       ELSE /\ deh' = TRUE /\ UNCHANGED <<local, gh>>
    /\ UNCHANGED <<phase, late, hung, hangs, durable, marker>>

SweepLegacyFinish ==
    /\ phase = "sweep" /\ ~hung /\ ~late /\ deh
    /\ durable' = [durable EXCEPT !["l"] = TRUE]
    /\ local' = [local EXCEPT !["l"] = FALSE]
    /\ deh' = FALSE
    /\ UNCHANGED <<phase, late, hung, hangs, marker, gh>>

SweepDone ==
    /\ phase = "sweep" /\ ~hung /\ ~late /\ ~deh
    /\ ~(local["c"] /\ marker["c"]) /\ ~(local["l"] /\ ~marker["l"])
    /\ phase' = "stop"
    /\ UNCHANGED <<late, hung, hangs, local, durable, marker, deh, gh>>

(* The deadline abandons the running step (a dehydrate in flight is cut;   *)
(* its local copy stays) and skips the remaining steps.                    *)
Abandon ==
    /\ late /\ phase \in Steps
    /\ phase' = "stop" /\ hung' = FALSE /\ deh' = FALSE
    /\ gh' = gh \cup {"abandoned"}
    /\ UNCHANGED <<late, hangs, local, durable, marker>>

Exit ==
    /\ phase = "stop"
    /\ phase' = "exited"
    /\ local' = IF LocalSurvivesExit THEN local ELSE [s \in S |-> FALSE]
    /\ UNCHANGED <<late, hung, hangs, durable, marker, deh, gh>>

Done == phase = "exited" /\ UNCHANGED vars

Next == DeadlinePasses \/ Hang \/ StepDone \/ SweepCommitted \/ SweepLegacyStart
        \/ SweepLegacyFinish \/ SweepDone \/ Abandon \/ Exit \/ Done
Spec == Init /\ [][Next]_vars
Fairness == WF_vars(DeadlinePasses) /\ WF_vars(StepDone) /\ WF_vars(SweepCommitted)
            /\ WF_vars(SweepLegacyStart) /\ WF_vars(SweepLegacyFinish) /\ WF_vars(SweepDone)
            /\ WF_vars(Abandon) /\ WF_vars(Exit)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
Recoverable(s) == durable[s] \/ local[s]
TypeOK == phase \in Steps \cup {"stop", "exited"} /\ {late, hung, deh} \subseteq BOOLEAN
          /\ hangs \in 0..1 /\ local \in [S -> BOOLEAN] /\ durable \in [S -> BOOLEAN] /\ marker \in [S -> BOOLEAN]
Inv_CommittedRecoverable == Recoverable("c")
Inv_DeleteOnlyMarked == "deletedUnmarked" \notin gh
Inv_LegacyRecoverable == Recoverable("l")
Prop_WorkerExits == <>(phase = "exited")

W_Abandoned == "abandoned" \notin gh
W_LegacySwept == ~(phase = "exited" /\ durable["l"])
=============================================================================
