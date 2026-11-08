---------------------------- MODULE WfForkTokens ----------------------------
(***************************************************************************)
(* Option B for comparison: a fork in a transition (one outcome routes to *)
(* two states at once) and a free join node J, executed with tokens. Each *)
(* token runs one state at a time; a state's outcome moves its token to   *)
(* the target, or splits it at a fork. The join fires when it holds a     *)
(* token from each incoming arc ("arcs", as a BPMN parallel gateway) or   *)
(* holds two tokens ("count"). Its output token goes to the terminal T.   *)
(* Source: the fork + join design investigation, option B                 *)
(* ("next changes type, multiple root cursors, barrier, terminal-while-   *)
(* siblings-run, catchAll, loops across forks").                          *)
(*                                                                          *)
(* The same graphs run with Sem = "compiled" are option C: the arrow sugar *)
(* compiled into option A's named branches (errors branch-local; the join *)
(* waits for every branch). CValid is option C's compile check (one fork, *)
(* every target reaches J, no cross edges, no loop over the fork, no      *)
(* terminal inside a branch). Option C on graphs CValid accepts is checked *)
(* against AbsForkJoin (join all of two branches) as a refinement.         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Graph,         \* "clean", "chain", "dangling", "loop", "cross"
    Sem,           \* "free" (option B) or "compiled" (option C as option A)
    JoinWaits,     \* the free join: "arcs" or "count"
    TerminalEnds,  \* a token at a terminal ends the run (TRUE) or only that token (FALSE)
    ErrOn,         \* state A may end with a runtime error that no route takes
    MaxTok,        \* token slots
    MaxSteps       \* the node limit

ASSUME Graph \in {"clean", "chain", "dangling", "loop", "cross"}
ASSUME Sem \in {"free", "compiled"} /\ JoinWaits \in {"arcs", "count"}
ASSUME TerminalEnds \in BOOLEAN /\ ErrOn \in BOOLEAN
ASSUME MaxTok \in Nat /\ MaxTok >= 2 /\ MaxSteps \in Nat

Tags == {"A", "B"}
Slots == 1..MaxTok
Work == {"S", "A", "B", "C"}

(* Edges <<state, outcome, targets>>; J's output goes to T.               *)
Base == {<<"S", "ok", {"A", "B"}>>, <<"B", "ok", {"J"}>>}
Edges == CASE Graph = "clean" -> Base \cup {<<"A", "ok", {"J"}>>}
           [] Graph = "chain" -> Base \cup {<<"A", "ok", {"C"}>>, <<"C", "ok", {"J"}>>}
           [] Graph = "dangling" -> Base \cup {<<"A", "ok", {"J"}>>, <<"B", "alt", {"T"}>>}
           [] Graph = "loop" -> Base \cup {<<"A", "ok", {"J"}>>, <<"A", "alt", {"S"}>>}
           [] Graph = "cross" -> Base \cup {<<"A", "ok", {"J"}>>, <<"A", "alt", {"B"}>>}

Outs(n) == {e[2] : e \in {x \in Edges : x[1] = n}} \cup (IF ErrOn /\ n = "A" THEN {"boom"} ELSE {})
Targets(n, r) == UNION {e[3] : e \in {x \in Edges : x[1] = n /\ x[2] = r}}
Succs(n) == UNION {e[3] : e \in {x \in Edges : x[1] = n}}
Preds == {e[1] : e \in {x \in Edges : "J" \in x[3]}}
(* The branch each tag belongs to in the well-formed graphs.               *)
Home(g) == IF g = "A" THEN {"A", "C"} ELSE {"B"}
OtherHome(g) == UNION {Home(h) : h \in Tags \ {g}}

Min(S) == CHOOSE x \in S : \A y \in S : x <= y

(* Option C's compile check.                                               *)
RECURSIVE ReachFrom(_, _)
ReachFrom(F, seen) ==
    LET nxt == (UNION {Succs(n) : n \in F}) \ ({"J"} \cup seen \cup F)
    IN IF nxt = {} THEN seen \cup F ELSE ReachFrom(nxt, seen \cup F)
Region(x) == ReachFrom({x}, {})
ForkTargets == Targets("S", "ok")
CValid ==
    /\ ForkTargets = Tags
    /\ Region("A") \cap Region("B") = {}
    /\ \A x \in ForkTargets : "S" \notin Region(x) /\ "T" \notin Region(x)
    /\ \A x \in ForkTargets : \E n \in Region(x) : "J" \in Succs(n)
    /\ Preds \subseteq Region("A") \cup Region("B")

VARIABLES
    tok,     \* [Slots -> token]
    runSt,   \* "running", "completed", "failed"
    steps,   \* states executed
    forks,   \* forks taken (a token's generation)
    jout,    \* the join's outcome: "none", "joined", "blocked"
    jrep,    \* the join's report: [Tags -> "none", "succeeded", "failed"]
    failed,  \* compiled: branches whose error no route took
    gh       \* ghost flags
vars == <<tok, runSt, steps, forks, jout, jrep, failed, gh>>

NoTok == [on |-> FALSE, at |-> "none", tag |-> "none", gen |-> 0, from |-> "none"]
Init ==
    /\ tok = [s \in Slots |-> IF s = 1 THEN [on |-> TRUE, at |-> "S", tag |-> "none", gen |-> 0, from |-> "none"] ELSE NoTok]
    /\ runSt = "running" /\ steps = 0 /\ forks = 0
    /\ jout = "none" /\ jrep = [g \in Tags |-> "none"] /\ failed = {} /\ gh = {}

Others(t) == {s \in Slots : s # t /\ tok[s].on}
FreeSlots == {s \in Slots : ~tok[s].on}
AllOff == [s \in Slots |-> NoTok]

(* A token's state runs and its outcome is routed.                         *)
Step(t) ==
    /\ runSt = "running" /\ tok[t].on /\ tok[t].at \in Work /\ steps < MaxSteps
    /\ \E r \in Outs(tok[t].at) :
         LET x == tok[t]
             n == x.at
             tg == Targets(n, r)
         IN /\ steps' = steps + 1
            /\ IF tg = {}
               THEN IF Sem = "free"
                    THEN \* no route: the run fails, and the other branches' work with it
                         /\ runSt' = "failed" /\ tok' = AllOff
                         /\ gh' = gh \cup (IF Others(t) # {} THEN {"errorEscapes"} ELSE {})
                         /\ UNCHANGED <<forks, failed>>
                    ELSE \* compiled: the error ends its branch only
                         /\ tok' = [tok EXCEPT ![t] = NoTok] /\ failed' = failed \cup {x.tag}
                         /\ UNCHANGED <<runSt, forks, gh>>
               ELSE IF Cardinality(tg) > 1
               THEN /\ FreeSlots # {}
                    /\ LET s2 == Min(FreeSlots) IN
                       tok' = [s \in Slots |->
                                 IF s = t THEN [on |-> TRUE, at |-> "A", tag |-> "A", gen |-> forks + 1, from |-> n]
                                 ELSE IF s = s2 THEN [on |-> TRUE, at |-> "B", tag |-> "B", gen |-> forks + 1, from |-> n]
                                 ELSE tok[s]]
                    /\ forks' = forks + 1
                    /\ gh' = gh \cup (IF x.tag # "none" THEN {"loopFork"} ELSE {})
                                \cup (IF \E s \in Others(t) : tok[s].at \in Tags THEN {"twoOnNode"} ELSE {})
                    /\ UNCHANGED <<runSt, failed>>
               ELSE LET y == CHOOSE z \in tg : TRUE IN
                    /\ tok' = [tok EXCEPT ![t] = [x EXCEPT !.at = y, !.from = n]]
                    /\ gh' = gh \cup (IF x.tag \in Tags /\ y \in OtherHome(x.tag) THEN {"cross"} ELSE {})
                                \cup (IF y \in Work /\ \E s \in Others(t) : tok[s].at = y THEN {"twoOnNode"} ELSE {})
                    /\ UNCHANGED <<runSt, forks, failed>>
    /\ UNCHANGED <<jout, jrep>>

(* The node limit ends the run; the store's end cancels every token's work. *)
StepLimit ==
    /\ runSt = "running" /\ steps >= MaxSteps
    /\ \E t \in Slots : tok[t].on /\ tok[t].at \in Work
    /\ runSt' = "failed" /\ gh' = gh \cup {"limit"}
    /\ tok' = [s \in Slots |-> IF tok[s].on /\ tok[s].at = "J" THEN tok[s] ELSE NoTok]  \* a branch that reached J keeps its end
    /\ UNCHANGED <<steps, forks, jout, jrep, failed>>

(* A token reaches the terminal.                                           *)
AtTerminal(t) ==
    /\ runSt = "running" /\ tok[t].on /\ tok[t].at = "T"
    /\ IF TerminalEnds
       THEN /\ runSt' = "completed" /\ tok' = AllOff
            /\ gh' = gh \cup (IF Others(t) # {} THEN {"siblingsDiscarded"} ELSE {})
       ELSE /\ tok' = [tok EXCEPT ![t] = NoTok]
            /\ runSt' = IF Others(t) = {} THEN "completed" ELSE "running"
            /\ UNCHANGED gh
    /\ UNCHANGED <<steps, forks, jout, jrep, failed>>

AtJ == {s \in Slots : tok[s].on /\ tok[s].at = "J"}
PickFrom(p) == CHOOSE s \in AtJ : tok[s].from = p
(* A join is exact when it consumes one token of each branch of the same  *)
(* fork, each arriving from its own branch.                                *)
JoinGood(C) ==
    /\ Cardinality(C) = 2
    /\ {tok[s].tag : s \in C} = Tags
    /\ \A s1, s2 \in C : tok[s1].gen = tok[s2].gen
    /\ \A s \in C : tok[s].from \in Home(tok[s].tag)
OutTok == [on |-> TRUE, at |-> "T", tag |-> "none", gen |-> 0, from |-> "J"]
Fire(C) ==
    /\ tok' = [s \in Slots |-> IF s = Min(FreeSlots \cup C) THEN OutTok ELSE IF s \in C THEN NoTok ELSE tok[s]]
    /\ gh' = gh \cup (IF JoinGood(C) THEN {} ELSE {"joinBad"}) \cup (IF jout # "none" THEN {"joinTwice"} ELSE {})

JoinFree ==
    /\ Sem = "free" /\ runSt = "running"
    /\ IF JoinWaits = "arcs"
       THEN /\ \A p \in Preds : \E s \in AtJ : tok[s].from = p
            /\ Fire({PickFrom(p) : p \in Preds})
       ELSE \E C \in SUBSET AtJ : Cardinality(C) = 2 /\ Fire(C)
    /\ jout' = "joined" /\ jrep' = [g \in Tags |-> "succeeded"]
    /\ UNCHANGED <<runSt, steps, forks, failed>>

(* Option C as option A: the join waits for every branch to end; joined   *)
(* when all succeeded, blocked otherwise (both go on to T).                *)
JoinCompiled ==
    /\ Sem = "compiled" /\ runSt = "running" /\ jout = "none" /\ forks >= 1
    /\ \A g \in Tags : g \in failed \/ \E s \in AtJ : tok[s].tag = g
    /\ FreeSlots \cup AtJ # {}
    /\ tok' = [s \in Slots |-> IF s = Min(FreeSlots \cup AtJ) THEN OutTok ELSE IF s \in AtJ THEN NoTok ELSE tok[s]]
    /\ gh' = gh \cup (IF failed # {} \/ JoinGood(AtJ) THEN {} ELSE {"joinBad"})
    /\ jout' = IF failed = {} THEN "joined" ELSE "blocked"
    /\ jrep' = [g \in Tags |-> IF g \in failed THEN "failed" ELSE "succeeded"]
    /\ UNCHANGED <<runSt, steps, forks, failed>>

Done == runSt # "running" /\ UNCHANGED vars

Next == (\E t \in Slots : Step(t) \/ AtTerminal(t)) \/ StepLimit \/ JoinFree \/ JoinCompiled \/ Done
Spec == Init /\ [][Next]_vars
Fairness ==
    /\ WF_vars(\E t \in Slots : Step(t)) /\ WF_vars(\E t \in Slots : AtTerminal(t))
    /\ WF_vars(StepLimit) /\ WF_vars(JoinFree) /\ WF_vars(JoinCompiled)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK ==
    /\ runSt \in {"running", "completed", "failed"}
    /\ jout \in {"none", "joined", "blocked"}
    /\ failed \subseteq Tags /\ steps \in 0..MaxSteps

(* The hazards (option B), as rules that hold for option A.               *)
Inv_NoSiblingDiscarded == "siblingsDiscarded" \notin gh   \* a terminal inside a branch ends the run while siblings run
Inv_ErrorBranchLocal == "errorEscapes" \notin gh          \* a branch's error fails the whole run
Inv_JoinExact == "joinBad" \notin gh /\ "joinTwice" \notin gh
Inv_NoCross == "cross" \notin gh                          \* a branch routes into another branch
Inv_NoTwoOnNode == "twoOnNode" \notin gh                  \* one state runs for two tokens at once
Inv_NoLoopFork == "loopFork" \notin gh                    \* a loop crosses the fork
Prop_RunEnds == <>(runSt # "running")                     \* the join does not wait forever

(* Option C's compile check, per graph.                                    *)
Inv_CompileRefuses == ~CValid
Inv_CompileAccepts == CValid

(* Witnesses, expected to be violated.                                      *)
W_NotJoined == jout # "joined"
W_NotBlocked == jout # "blocked"
W_NotCompleted == runSt # "completed"

(* Option C (compiled) refines the intended specification.                *)
TagOf(b) == IF b = 1 THEN "A" ELSE "B"
MapOut == IF jout # "none" THEN jout ELSE IF runSt # "running" THEN "cancelled" ELSE "none"
MapAst == [b \in 1..2 |->
    LET g == TagOf(b) IN
    IF jout # "none" THEN jrep[g]
    ELSE IF g \in failed THEN "failed"
    ELSE IF \E s \in AtJ : tok[s].tag = g THEN "succeeded"
    ELSE IF forks = 0 THEN (IF MapOut = "none" THEN "queued" ELSE "not_started")
    ELSE IF MapOut = "none" THEN "running" ELSE "cancelled"]
MapWin == IF jout = "joined" THEN {1, 2} ELSE {}
Abs == INSTANCE AbsForkJoin WITH NB <- 2, Kneed <- 2, FailFast <- FALSE, HasTimer <- FALSE, AllowRunEnd <- TRUE, AllowEntryError <- FALSE,
                                 ast <- MapAst, aout <- MapOut, awin <- MapWin
Prop_RefinesAbs == Abs!ASpec
=============================================================================
