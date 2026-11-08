---------------------------- MODULE AbsForkJoin ----------------------------
(***************************************************************************)
(* The intended specification of a Workflow V2 fork + join (option A,     *)
(* named branches), for one visit of the fork. It is derived from the     *)
(* assignment of 2026-11-07 and the k-of-n join decided on 2026-11-04     *)
(* (the design decision "join k of n", questions PJ-Q1..Q3).             *)
(*                                                                         *)
(* A branch's body is abstracted away: a branch is queued, then running,  *)
(* then succeeded or failed as the store counts it. The join decides once *)
(* - joined with k successes (the winners), blocked when k successes are  *)
(* impossible, timed_out when the time limit passes first (a time limit  *)
(* with k impossible is blocked), or cancelled when the run ends - and    *)
(* drops the rest: running branches are cancelled (or late: they ended    *)
(* after the time limit and did not count), queued ones not_started, and  *)
(* ended ones keep how they ended. Nothing changes after the decision.    *)
(*                                                                         *)
(* WfForkJoin (the detailed design) and WfForkTokens with compiled        *)
(* semantics (option C) are checked against ASpec as a refinement.        *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    NB,           \* the number of named branches
    Kneed,        \* the successes the join needs (NB for join all)
    FailFast,     \* blocked as soon as k is impossible
    HasTimer,     \* the fork has a time limit
    AllowRunEnd,  \* a cancel, a stop or the node limit may end the run
    AllowEntryError \* the state fails at entry (its inputs), before any branch starts

ASSUME NB \in Nat /\ NB >= 1 /\ Kneed \in 1..NB
ASSUME {FailFast, HasTimer, AllowRunEnd, AllowEntryError} \subseteq BOOLEAN

ABr == 1..NB
AFinal == {"succeeded", "failed", "cancelled", "late", "not_started"}

VARIABLES ast, aout, awin
avars == <<ast, aout, awin>>

ASucc == {b \in ABr : ast[b] = "succeeded"}
AFail == {b \in ABr : ast[b] = "failed"}
AImpossible == Cardinality(AFail) + Kneed > NB
ADone == \A b \in ABr : ast[b] \in {"succeeded", "failed"}

AInit == /\ ast = [b \in ABr |-> "queued"]
         /\ aout = "none"
         /\ awin = {}

(* Branches start (several may start in one step).                         *)
AStart(S) ==
    /\ aout = "none" /\ S # {}
    /\ \A b \in S : ast[b] = "queued"
    /\ ast' = [b \in ABr |-> IF b \in S THEN "running" ELSE ast[b]]
    /\ UNCHANGED <<aout, awin>>

(* A running branch ends as the store counts it.                           *)
AEnd(b, r) ==
    /\ aout = "none" /\ ast[b] = "running"
    /\ ast' = [ast EXCEPT ![b] = r]
    /\ UNCHANGED <<aout, awin>>

(* The one decision, and the drop of the rest.                             *)
ADecide(o, W) ==
    /\ aout = "none"
    /\ aout' = o /\ awin' = W
    /\ \E L \in SUBSET {b \in ABr : ast[b] = "running"} :
          /\ (HasTimer \/ L = {})
          /\ ast' = [b \in ABr |-> IF b \in L THEN "late"
                                   ELSE IF ast[b] = "running" THEN "cancelled"
                                   ELSE IF ast[b] = "queued" THEN "not_started"
                                   ELSE ast[b]]

AJoin == \E W \in SUBSET ASucc : Cardinality(W) = Kneed /\ ADecide("joined", W)
ABlock == AImpossible /\ (FailFast \/ HasTimer \/ ADone) /\ ADecide("blocked", {})
ATimeout == HasTimer /\ Cardinality(ASucc) < Kneed /\ ~AImpossible /\ ADecide("timed_out", {})
AEndRun == AllowRunEnd /\ ADecide("cancelled", {})
(* An error at entry (a branch input or the state's inputSchema): no branch *)
(* starts; the state's own error route handles it.                          *)
AEntryError == AllowEntryError /\ (\A b \in ABr : ast[b] = "queued") /\ ADecide("error", {})
AIdle == aout # "none" /\ UNCHANGED avars

ANext ==
    \/ \E S \in SUBSET ABr : AStart(S)
    \/ \E b \in ABr : AEnd(b, "succeeded") \/ AEnd(b, "failed")
    \/ AJoin \/ ABlock \/ ATimeout \/ AEndRun \/ AEntryError \/ AIdle

ASpec == AInit /\ [][ANext]_avars

-----------------------------------------------------------------------------
(* Checked on the abstract model itself.                                   *)
ATypeOK == /\ ast \in [ABr -> AFinal \cup {"queued", "running"}]
           /\ aout \in {"none", "joined", "blocked", "timed_out", "cancelled", "error"}
           /\ awin \subseteq ABr
AInv_Joined == aout = "joined" => (Cardinality(awin) = Kneed /\ \A b \in awin : ast[b] = "succeeded")
AInv_Decided == aout # "none" => \A b \in ABr : ast[b] \in AFinal
AInv_WinnersOnlyWhenJoined == aout # "joined" => awin = {}
AInv_TimedOutNotImpossible == aout = "timed_out" => ~AImpossible
=============================================================================
