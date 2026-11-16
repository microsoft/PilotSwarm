------------------------------- MODULE WfIdleWake -------------------------------
(***************************************************************************)
(* Workflow controller 1.9.0, the running loop's wait (runtime.ts       *)
(* 2072-2089 at d2274e0d): race the command queue against a timer. A timer *)
(* win counts an idle wait; at WORKFLOW_IDLE_WAITS_PER_EXECUTION (50)   *)
(* the controller continues as new. A dequeued message that is a command   *)
(* is applied; any other message (a wake) loops back. In d2274e0d a wake   *)
(* is not counted; the paused loop (1711-1717) counts it. Wakes and        *)
(* commands share one queue (WORKFLOW_COMMAND_QUEUE), in order.            *)
(* hist counts loop passes in the current execution.                       *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    Cap,      \* idle waits per execution (50 in code)
    Mode,     \* "d2274e0d": only a timer win counts; "fix": a command-less wake counts too
    MaxCmd,   \* commands sent in all
    Fault     \* "none"; "count-then-can": count before parsing, continue as new with a command in hand;
              \* "swallow": a command is counted as a wake and dropped

ASSUME Cap \in 1..4 /\ Mode \in {"d2274e0d", "fix"} /\ MaxCmd \in 0..2
ASSUME Fault \in {"none", "count-then-can", "swallow"}

VARIABLES q, idle, hist, sent, applied, gh
vars == <<q, idle, hist, sent, applied, gh>>

Init == q = <<>> /\ idle = 0 /\ hist = 0 /\ sent = 0 /\ applied = 0 /\ gh = {}

(* A store notification with nothing for the controller to do.            *)
SendWake == Len(q) < 2 /\ q' = Append(q, "w") /\ UNCHANGED <<idle, hist, sent, applied, gh>>
SendCmd == sent < MaxCmd /\ Len(q) < 2 /\ q' = Append(q, "c") /\ sent' = sent + 1 /\ UNCHANGED <<idle, hist, applied, gh>>

Bound == Cap + 1
Bump(h) == IF h < Bound THEN h + 1 ELSE h

(* A counted idle wait; continue as new at the cap.                        *)
Counted(how) ==
    IF idle + 1 >= Cap
    THEN /\ idle' = 0 /\ hist' = 0 /\ gh' = gh \cup {how}
    ELSE /\ idle' = idle + 1 /\ hist' = Bump(hist) /\ UNCHANGED gh

TimerWin ==
    /\ q = <<>>
    /\ Counted("canByTimer")
    /\ UNCHANGED <<q, sent, applied>>

WakeWin ==
    /\ q # <<>> /\ Head(q) = "w"
    /\ q' = Tail(q)
    /\ IF Mode = "fix" \/ Fault # "none"
       THEN Counted("canByWake")
       ELSE /\ hist' = Bump(hist) /\ UNCHANGED <<idle, gh>>
    /\ UNCHANGED <<sent, applied>>

(* applyCommand ends this execution's loop; model its next as a fresh one. *)
CommandWin ==
    /\ q # <<>> /\ Head(q) = "c"
    /\ q' = Tail(q)
    /\ CASE Fault = "swallow" ->
              /\ Counted("canByWake") /\ UNCHANGED applied
         [] Fault = "count-then-can" /\ idle + 1 >= Cap ->
              /\ idle' = 0 /\ hist' = 0 /\ gh' = gh \cup {"canByWake"} /\ UNCHANGED applied
         [] OTHER ->
              /\ applied' = applied + 1 /\ idle' = 0 /\ hist' = 0 /\ UNCHANGED gh
    /\ UNCHANGED sent

Next == SendWake \/ SendCmd \/ TimerWin \/ WakeWin \/ CommandWin
Spec == Init /\ [][Next]_vars
(* A sustained stream of no-op wakes.                                       *)
Fairness == WF_vars(SendWake) /\ WF_vars(WakeWin) /\ WF_vars(CommandWin) /\ WF_vars(TimerWin)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
InQ == Len(SelectSeq(q, LAMBDA m : m = "c"))
TypeOK == q \in Seq({"w", "c"}) /\ Len(q) <= 2 /\ idle \in 0..Cap /\ hist \in 0..Bound /\ applied \in 0..MaxCmd
(* An execution never makes more than Cap loop passes without continuing   *)
(* as new (a stand-in for bounded history).                                *)
Inv_HistoryBounded == hist <= Cap
(* Every command sent is applied or still queued: never swallowed.         *)
Inv_CommandsKept == sent = applied + InQ
(* The controller continues as new again and again under any wake stream. *)
Prop_ContinuesAsNew == []<>(hist = 0)
Prop_CommandsApplied == <>[](applied = sent)

W_NoCanByWake == "canByWake" \notin gh
=============================================================================
