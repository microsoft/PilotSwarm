----------------------------- MODULE WorkerShutdown -----------------------------
(***************************************************************************)
(* Worker graceful shutdown under one deadline (worker.ts 1307-1404 at     *)
(* bb162ed8; every worker). `bounded` (1317-1338) always STARTS its step   *)
(* (Promise.resolve().then(work)) and races it against the time left to   *)
(* the deadline, at least 0: past the deadline a step is started with a    *)
(* zero budget and its wait abandoned at once, while its work goes on. So  *)
(* after a late drain, the workspace release (1374), the release sweep     *)
(* (1394, sweepIdleSessions(1)) and closing the worker (1403, stop()) are  *)
(* all started and may run at the same time; the process exits when       *)
(* gracefulShutdown returns, which ends whatever still runs.               *)
(* The sweep deletes the local copy of a session whose snapshot is         *)
(* committed (the commit marker) and dehydrates an unmarked legacy one     *)
(* (upload, then delete the local copy). Once the worker is closed, an     *)
(* upload in flight fails and the local copy stays.                        *)
(* Sessions: "c" committed (marker, durable snapshot); "l" legacy.         *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    HasDeadline,        \* FALSE: the shutdown before its deadline (a hung step waits forever)
    LocalSurvivesExit,  \* the worker-local session folder is there after the process exits
    Fault               \* "none", "delete-unmarked", "marker-early"

ASSUME HasDeadline \in BOOLEAN /\ LocalSurvivesExit \in BOOLEAN
ASSUME Fault \in {"none", "delete-unmarked", "marker-early"}

S == {"c", "l"}
Steps == {"drain", "release", "sweep", "close"}
NextStep(p) == CASE p = "drain" -> "release" [] p = "release" -> "sweep" [] p = "sweep" -> "close" [] OTHER -> "returned"

VARIABLES
    phase,    \* the step gracefulShutdown is waiting for, then "returned", "exited"
    late,     \* the deadline has passed
    pending,  \* steps started and still running (a late step keeps running)
    hung,     \* a step that will not finish by itself
    hangs, local, durable, marker, deh, closed, gh
vars == <<phase, late, pending, hung, hangs, local, durable, marker, deh, closed, gh>>

Init ==
    /\ phase = "drain" /\ late = FALSE /\ pending = {"drain"} /\ hung = {} /\ hangs = 0
    /\ local = [s \in S |-> TRUE]
    /\ durable = [s \in S |-> s = "c" /\ Fault # "marker-early"]
    /\ marker = [s \in S |-> s = "c"]
    /\ deh = FALSE /\ closed = FALSE /\ gh = {}

DeadlinePasses ==
    /\ HasDeadline /\ ~late /\ phase # "exited"
    /\ late' = TRUE
    /\ UNCHANGED <<phase, pending, hung, hangs, local, durable, marker, deh, closed, gh>>

Hang ==
    /\ hangs = 0 /\ \E x \in pending : hung' = {x}
    /\ hangs' = 1
    /\ UNCHANGED <<phase, late, pending, local, durable, marker, deh, closed, gh>>

(* The sweep tries each session once: a dehydrate cut by the close is not  *)
(* retried.                                                                *)
SweepDoneWork == ~(local["c"] /\ marker["c"]) /\ (~(local["l"] /\ ~marker["l"]) \/ "closeCut" \in gh) /\ ~deh

(* A running step finishes (the sweep once its work is done).              *)
Finish ==
    \E x \in pending :
       /\ x \notin hung
       /\ (x = "sweep" => SweepDoneWork)
       /\ pending' = pending \ {x}
       /\ closed' = (closed \/ x = "close")
       /\ UNCHANGED <<phase, late, hung, hangs, local, durable, marker, deh, gh>>

(* gracefulShutdown goes on to the next step when the current one finished *)
(* or, at the deadline, without waiting; the next step is started anyway. *)
Advance ==
    /\ phase \in Steps
    /\ (phase \notin pending \/ late)
    /\ gh' = gh \cup (IF phase \in pending THEN {"abandoned"} ELSE {})
    /\ phase' = NextStep(phase)
    /\ pending' = IF NextStep(phase) \in Steps THEN pending \cup {NextStep(phase)} ELSE pending
    /\ UNCHANGED <<late, hung, hangs, local, durable, marker, deh, closed>>

Overlap == IF (pending \ {"sweep"}) \cap {"release", "close"} # {} \/ closed THEN {"overlap"} ELSE {}

SweepCommitted ==
    /\ "sweep" \in pending /\ "sweep" \notin hung /\ local["c"] /\ marker["c"]
    /\ local' = [local EXCEPT !["c"] = FALSE]
    /\ gh' = gh \cup Overlap
    /\ UNCHANGED <<phase, late, pending, hung, hangs, durable, marker, deh, closed>>

SweepLegacyStart ==
    /\ "sweep" \in pending /\ "sweep" \notin hung /\ local["l"] /\ ~marker["l"] /\ ~deh /\ "closeCut" \notin gh
    /\ IF Fault = "delete-unmarked"
       THEN /\ local' = [local EXCEPT !["l"] = FALSE] /\ gh' = gh \cup {"deletedUnmarked"} \cup Overlap
            /\ UNCHANGED deh
       ELSE /\ deh' = TRUE /\ gh' = gh \cup Overlap /\ UNCHANGED local
    /\ UNCHANGED <<phase, late, pending, hung, hangs, durable, marker, closed>>

(* The upload lands, then the local copy is deleted; after close it fails  *)
(* and the local copy stays (the sweep reports the failure).               *)
SweepLegacyFinish ==
    /\ "sweep" \in pending /\ "sweep" \notin hung /\ deh
    /\ IF closed
       THEN /\ deh' = FALSE /\ gh' = gh \cup {"closeCut"} /\ UNCHANGED <<durable, local>>
       ELSE /\ durable' = [durable EXCEPT !["l"] = TRUE] /\ local' = [local EXCEPT !["l"] = FALSE]
            /\ deh' = FALSE /\ UNCHANGED gh
    /\ UNCHANGED <<phase, late, pending, hung, hangs, marker, closed>>

(* gracefulShutdown returned; the caller exits, ending all running work.  *)
Exit ==
    /\ phase = "returned"
    /\ phase' = "exited" /\ pending' = {} /\ hung' = {} /\ deh' = FALSE
    /\ local' = IF LocalSurvivesExit THEN local ELSE [s \in S |-> FALSE]
    /\ UNCHANGED <<late, hangs, durable, marker, closed, gh>>

Done == phase = "exited" /\ UNCHANGED vars

Next == DeadlinePasses \/ Hang \/ Finish \/ Advance \/ SweepCommitted \/ SweepLegacyStart
        \/ SweepLegacyFinish \/ Exit \/ Done
Spec == Init /\ [][Next]_vars
Fairness == WF_vars(DeadlinePasses) /\ WF_vars(Finish) /\ WF_vars(Advance) /\ WF_vars(SweepCommitted)
            /\ WF_vars(SweepLegacyStart) /\ WF_vars(SweepLegacyFinish) /\ WF_vars(Exit)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
Recoverable(s) == durable[s] \/ local[s]
TypeOK == phase \in Steps \cup {"returned", "exited"} /\ pending \subseteq Steps /\ hung \subseteq Steps
          /\ {late, deh, closed} \subseteq BOOLEAN /\ hangs \in 0..1
          /\ local \in [S -> BOOLEAN] /\ durable \in [S -> BOOLEAN] /\ marker \in [S -> BOOLEAN]
Inv_CommittedRecoverable == Recoverable("c")
Inv_DeleteOnlyMarked == "deletedUnmarked" \notin gh
Inv_LegacyRecoverable == Recoverable("l")
Prop_WorkerExits == <>(phase = "exited")

W_Abandoned == "abandoned" \notin gh
W_LegacySwept == ~(phase = "exited" /\ durable["l"])
W_NoOverlap == "overlap" \notin gh
W_NoCloseCut == "closeCut" \notin gh
=============================================================================
