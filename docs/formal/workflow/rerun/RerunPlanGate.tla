---------------------------- MODULE RerunPlanGate ----------------------------
(***************************************************************************)
(* Re-run plan over a source history TLC chooses (I7, audit RR-6, RR-8,    *)
(* RR-7 / MA-1).                                                           *)
(*                                                                         *)
(* TLC chooses #2's history: up to MaxTop top-level visits, each of a kind *)
(* in TopKinds (at most one parallel step, whose two lanes have kinds in   *)
(* LaneKinds), KV writes (set_vars) before any visit or after the last,    *)
(* each spawned child's state when the plan reads it, each approval's     *)
(* decider, and the Start: the chosen visit and mode (explicit), or the    *)
(* automatic pick's candidate and default mode with the requested mode,   *)
(* and the caller's channel (person or system, an agent session proxy, MCP)*)
(* and identity.                                                           *)
(*                                                                         *)
(* The code's plan is written as rerun.ts computes it (partitionRerunVisits*)
(* reusedSplit / droppedSplit, lanes by their parallel, rerunCutKvRevision,*)
(* pickRerunTarget's G-R1 scan, session-definitions.ts's approval-reuse    *)
(* gate, store.ts verifyRerunLimitsAndApprovalsIn's re-check of deciders). *)
(* The invariants state the design independently: by visit order and      *)
(* instants (a KV write k at instant 2k-1, visit i entered at 2i, #2's    *)
(* end at 2n+2), and by each child's true end. Between the plan and the   *)
(* admission a spawned child can still end (the parent-end cancel lands,  *)
(* or the child finishes first): the admission does not read the flags    *)
(* again (store.ts:3207-3278), so the plan's flags can be stale.          *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxTop,                 \* 2..4: most top-level visits in #2
    TopKinds,               \* subset of {"work", "spawn", "parallel", "approval"}
    LaneKinds,              \* subset of {"work", "spawn", "approval"}
    WithBumps,              \* TRUE = TLC chooses KV writes between visits
    AutoPick,               \* TRUE = the Start names no visit (pickRerunTarget picks it, with G-R1)
    Modes,                  \* explicit Starts: subset of {"run_again", "continue", "supply"}
    WithGate,               \* TRUE = TLC chooses the caller's channel and identity and each approval's decider
    \* ---- faults ----
    SplitOffByOne,          \* continue reuses only the visits before the chosen one (reusedSplit = chosenIndex)
    LanesByIndex,           \* a lane is reused only when its parallel is before the chosen visit
    KvUsesChosenPin,        \* the copied KV ceiling is the chosen visit's pin
    Gr1PicksLatest,         \* G-R1 cuts back to the latest reused bad spawn
    Gr1TopOnly,             \* G-R1 scans top-level spawns only, not lane spawns
    Gr1CutsBefore,          \* G-R1 cuts one visit before the earliest bad spawn
    GateIgnoresMcp,         \* the gate lets a person reuse an approval over MCP
    GateIgnoresProxy,       \* the gate lets an agent session (originatingSessionId) reuse an approval for its owner
    GateIgnoresDecider,     \* the gate does not compare each approval's decider with the starter
    GateIgnoresOwner,       \* the gate does not compare the starter with the session's owner
    GateTopLevelOnly        \* the gate looks only at top-level approvals, not at approvals inside a reused lane

ASSUME MaxTop \in 2..4
ASSUME TopKinds \subseteq {"work", "spawn", "parallel", "approval"} /\ "work" \in TopKinds
ASSUME LaneKinds \subseteq {"work", "spawn", "approval"} /\ LaneKinds # {}
ASSUME Modes \subseteq {"run_again", "continue", "supply"}
ASSUME {WithBumps, AutoPick, WithGate, SplitOffByOne, LanesByIndex, KvUsesChosenPin, Gr1PicksLatest, Gr1TopOnly,
        Gr1CutsBefore, GateIgnoresMcp, GateIgnoresProxy, GateIgnoresDecider, GateIgnoresOwner, GateTopLevelOnly} \subseteq BOOLEAN

Lanes == {1, 2}
ChildStates == {"completed", "cancelled", "running"}   \* the spawned child as it is: finished on its own, cancelled by #2's end, still running
Persons == {"owner", "other"}

VARIABLES
    n,          \* number of top-level visits
    kind,       \* [1..MaxTop -> kinds] (only 1..n used)
    laneKind,   \* [Lanes -> LaneKinds] (used when a top visit is the parallel step)
    bump,       \* [1..MaxTop+1 -> BOOLEAN]: a KV write before visit k (k = n+1: after the last visit, before #2 ended)
    childAt,    \* [Visits -> ChildStates]: each spawned child (top-level spawn or lane spawn); others "completed"
    decider,    \* [Visits -> Persons]: who answered each approval
    chosen0,    \* the requested visit (explicit) or the automatic pick's candidate (top-level index)
    mode0,      \* the requested mode, or the automatic pick's default mode
    reqMode,    \* AutoPick: "none" | "run_again" | "continue" (the caller's mode)
    actorKind, viaProxy, viaMcp, starter,   \* the caller: "user" | "system", originatingSessionId set, MCP, who
    phase,      \* "init" | "planned" | "admitted" | "refused"
    pChosen, pMode, pReusedTop, pReusedLanes, pSupplied, pKv, pGr1Moved, pBad

TopVisit(i) == <<"T", i>>
LaneVisit(j) == <<"L", j>>
AllVisits == {TopVisit(i) : i \in 1..MaxTop} \cup {LaneVisit(j) : j \in Lanes}

ParIdx == IF \E i \in 1..n : kind[i] = "parallel" THEN CHOOSE i \in 1..n : kind[i] = "parallel" ELSE 0
Visits == {TopVisit(i) : i \in 1..n} \cup (IF ParIdx > 0 THEN {LaneVisit(j) : j \in Lanes} ELSE {})
KindOf(v) == IF v[1] = "T" THEN kind[v[2]] ELSE laneKind[v[2]]
\* The top-level step a visit belongs to (a lane belongs to its parallel step).
TopOf(v) == IF v[1] = "T" THEN v[2] ELSE ParIdx
Spawns == {v \in Visits : KindOf(v) = "spawn"}
Approvals == {v \in Visits : KindOf(v) = "approval"}

Count(S) == Cardinality(S)
\* A visit's KV pin: the revision when it was admitted (lanes: their parallel's). #2's last revision includes a write after
\* its last visit.
Pin(i) == 1 + Count({k \in 1..i : bump[k]})
SourceKv == 1 + Count({k \in 1..(n + 1) : bump[k]})

Valid(i, m) ==
    /\ i \in 1..n
    /\ (m = "supply" => kind[i] = "work")      \* supply: a script or agent visit only (approval, spawn, parallel refused)

TypeOK ==
    /\ n \in 2..MaxTop
    /\ phase \in {"init", "planned", "admitted", "refused"}
    /\ pChosen \in 0..MaxTop /\ pKv \in 0..(MaxTop + 2)

\* Init chooses each value over the domain the earlier ones fix (TLC enumerates only those).
Init ==
    /\ n \in 2..MaxTop
    /\ kind \in [1..n -> TopKinds]
    /\ Count({i \in 1..n : kind[i] = "parallel"}) <= 1
    /\ laneKind \in [Lanes -> IF ParIdx > 0 THEN LaneKinds ELSE {"work"}]
    /\ bump \in [1..(n + 1) -> IF WithBumps THEN BOOLEAN ELSE {FALSE}]
    /\ childAt \in [Spawns -> ChildStates]
    /\ decider \in [Approvals -> IF WithGate THEN Persons ELSE {"owner"}]
    /\ chosen0 \in 1..n
    /\ IF AutoPick
         THEN /\ mode0 \in {"run_again", "continue"}
              /\ reqMode \in {"none", "run_again", "continue"}
         ELSE /\ mode0 \in Modes /\ Valid(chosen0, mode0)
              /\ reqMode = "none"
    /\ IF WithGate
         THEN /\ actorKind \in {"user", "system"} /\ viaProxy \in BOOLEAN /\ viaMcp \in BOOLEAN /\ starter \in Persons
         ELSE /\ actorKind = "user" /\ viaProxy = FALSE /\ viaMcp = FALSE /\ starter = "owner"
    /\ phase = "init"
    /\ pChosen = 0 /\ pMode = "none" /\ pReusedTop = {} /\ pReusedLanes = {} /\ pSupplied = {} /\ pKv = 0
    /\ pGr1Moved = FALSE /\ pBad = {}

-----------------------------------------------------------------------------
(* The code's plan                                                         *)

\* rerun.ts partitionRerunVisits: reusedSplit = continue ? chosenIndex + 1 : chosenIndex (1-based: the first c or c - 1
\* visits); droppedSplit = run_again ? chosenIndex : chosenIndex + 1; lanes follow their parallel.
CodeReusedTop(c, m) ==
    {i \in 1..n : i < c \/ (m = "continue" /\ i = c /\ ~SplitOffByOne)}
CodeDroppedTop(c, m) == {i \in 1..n : i > c \/ (m = "run_again" /\ i = c)}
CodeReusedLanes(c, m) ==
    IF ParIdx = 0 THEN {}
    ELSE IF (IF LanesByIndex THEN ParIdx < c ELSE ParIdx \in CodeReusedTop(c, m)) THEN Lanes ELSE {}
Min(S) == CHOOSE x \in S : \A y \in S : x <= y
Max(S) == CHOOSE x \in S : \A y \in S : x >= y
\* rerun.ts rerunCutKvRevision: max(1, the first dropped top-level visit's pin (else #2's last revision), every copied pin,
\* and in supply mode the chosen visit's pin).
CodeKv(c, m) ==
    LET dropped == CodeDroppedTop(c, m)
        cut == IF KvUsesChosenPin THEN Pin(c) ELSE IF dropped # {} THEN Pin(Min(dropped)) ELSE SourceKv
        pins == {Pin(i) : i \in CodeReusedTop(c, m)} \cup (IF m = "supply" THEN {Pin(c)} ELSE {})
    IN Max({1, cut} \cup pins)

\* listRerunKeys flags as the plan reads them: spawnChildCancelledBySourceEnd (a parent-end cancel was recorded) and
\* spawnChildHasNotice (a WorkflowEnded@1 notice is in #2's inbox). G-R1 skips a spawn only when it was not cancelled by the
\* source's end and has a notice: a cancelled or still running child is bad.
BadAtPlan(v) == v \in Spawns /\ childAt[v] # "completed"

\* pickRerunTarget's G-R1 scan (auto-pick, requested mode none or run_again): the candidate's reused visits (top and lanes),
\* each bad spawn lifted to its top-level step, the earliest one (faults: latest, top-level only, one visit before).
Gr1Applies == AutoPick /\ reqMode # "continue"
CandMode == IF reqMode = "none" THEN mode0 ELSE reqMode
CandReused ==
    {TopVisit(i) : i \in CodeReusedTop(chosen0, CandMode)}
    \cup {LaneVisit(j) : j \in CodeReusedLanes(chosen0, CandMode)}
BadTops == {TopOf(v) : v \in {w \in CandReused : BadAtPlan(w) /\ (~Gr1TopOnly \/ w[1] = "T")}}
Gr1Target ==
    IF Gr1PicksLatest THEN Max(BadTops)
    ELSE IF Gr1CutsBefore /\ Min(BadTops) > 1 THEN Min(BadTops) - 1
    ELSE Min(BadTops)

\* session-definitions.ts:944-969: the reused answered approvals (top and lanes) need the person who owns the session,
\* directly (not over MCP, not through an agent session), who decided every one of them; the admission re-checks each
\* decider (store.ts verifyRerunLimitsAndApprovalsIn). The owner is set when the session is made and never changes.
ReusedApprovals(top, lanes) ==
    {v \in Approvals : (v[1] = "T" /\ v[2] \in top) \/ (v[1] = "L" /\ v[2] \in lanes /\ ~GateTopLevelOnly)}
DirectOwner ==
    actorKind = "user" /\ (~viaProxy \/ GateIgnoresProxy) /\ (~viaMcp \/ GateIgnoresMcp)
GateRefuses(top, lanes) ==
    ReusedApprovals(top, lanes) # {}
    /\ \/ ~DirectOwner
       \/ (starter # "owner" /\ ~GateIgnoresOwner)
       \/ (\E v \in ReusedApprovals(top, lanes) : decider[v] # starter /\ ~GateIgnoresDecider)

Plan ==
    /\ phase = "init"
    /\ LET moved == Gr1Applies /\ BadTops # {}
           c == IF moved THEN Gr1Target ELSE chosen0
           m == IF moved THEN "run_again" ELSE IF AutoPick THEN CandMode ELSE mode0
       IN /\ pChosen' = c /\ pMode' = m /\ pGr1Moved' = moved
          /\ pReusedTop' = CodeReusedTop(c, m)
          /\ pReusedLanes' = CodeReusedLanes(c, m)
          /\ pSupplied' = IF m = "supply" THEN {c} ELSE {}
          /\ pKv' = CodeKv(c, m)
          /\ pBad' = {v \in Visits : BadAtPlan(v)}
          /\ phase' = "planned"
    /\ UNCHANGED <<n, kind, laneKind, bump, childAt, decider, chosen0, mode0, reqMode, actorKind, viaProxy, viaMcp, starter>>

\* Between the plan and the admission a running child still ends: #2's parent-end cancel lands, or it finished first.
ChildEnds(v) ==
    /\ phase = "planned" /\ v \in Spawns /\ childAt[v] = "running"
    /\ \E s \in {"completed", "cancelled"} : childAt' = [childAt EXCEPT ![v] = s]
    /\ UNCHANGED <<n, kind, laneKind, bump, decider, chosen0, mode0, reqMode, actorKind, viaProxy, viaMcp, starter, phase,
                   pChosen, pMode, pReusedTop, pReusedLanes, pSupplied, pKv, pGr1Moved, pBad>>

Admit ==
    /\ phase = "planned"
    /\ phase' = IF GateRefuses(pReusedTop, pReusedLanes) THEN "refused" ELSE "admitted"
    /\ UNCHANGED <<n, kind, laneKind, bump, childAt, decider, chosen0, mode0, reqMode, actorKind, viaProxy, viaMcp, starter,
                   pChosen, pMode, pReusedTop, pReusedLanes, pSupplied, pKv, pGr1Moved, pBad>>

Done == phase \in {"admitted", "refused"} /\ UNCHANGED <<n, kind, laneKind, bump, childAt, decider, chosen0, mode0, reqMode,
            actorKind, viaProxy, viaMcp, starter, phase, pChosen, pMode, pReusedTop, pReusedLanes, pSupplied, pKv, pGr1Moved, pBad>>

Next == Plan \/ (\E v \in AllVisits : ChildEnds(v)) \/ Admit \/ Done
Spec == Init /\ [][Next]_<<n, kind, laneKind, bump, childAt, decider, chosen0, mode0, reqMode, actorKind, viaProxy, viaMcp,
                         starter, phase, pChosen, pMode, pReusedTop, pReusedLanes, pSupplied, pKv, pGr1Moved, pBad>>

-----------------------------------------------------------------------------
(* The design, stated independently                                       *)

\* RR-6: #3 reuses exactly the visits that ran before the chosen one (and the chosen one itself for continue), with the
\* lanes of every reused parallel step; supply replaces the chosen visit; every other visit runs again.
SpecReused(c, m) ==
    {v \in Visits : TopOf(v) < c \/ (m = "continue" /\ TopOf(v) = c)}
Inv_ReusedIsPrefix ==
    phase \in {"planned", "admitted"} =>
        /\ {TopVisit(i) : i \in pReusedTop} \cup {LaneVisit(j) : j \in pReusedLanes} = SpecReused(pChosen, pMode)
        /\ pSupplied = (IF pMode = "supply" THEN {pChosen} ELSE {})
        /\ pChosen \notin pReusedTop \/ pMode = "continue"

\* RR-6: the KV #3 starts from is #2's variables at the instant of the cut: the entry of the first top-level visit that
\* runs again (run_again: the chosen one; continue and supply: the next one), or #2's end when none runs again.
CutInstant(c, m) == IF m = "run_again" THEN 2 * c ELSE 2 * (c + 1)
KvAt(t) == 1 + Count({k \in 1..(n + 1) : bump[k] /\ 2 * k - 1 < t})
Inv_KvAtCut ==
    phase \in {"planned", "admitted"} => pKv = KvAt(CutInstant(pChosen, pMode))

\* RR-8: an automatic pick never reuses a spawn whose child did not finish on its own (it was cancelled by #2's end or is
\* still running), whatever such spawns there are, at the top level or in a lane, and however the flags moved after the plan.
Inv_ReusedSpawnFinished ==
    (phase = "admitted" /\ Gr1Applies) =>
        \A v \in SpecReused(pChosen, pMode) : v \in Spawns => childAt[v] = "completed"

\* RR-8: G-R1 moves the cut no further back than the earliest bad spawn: the step it cuts at holds one.
Inv_Gr1CutAtBadSpawn ==
    (phase \in {"planned", "admitted"} /\ pGr1Moved) => \E v \in pBad : TopOf(v) = pChosen

\* RR-7 / MA-1: an admitted re-run that reuses an answered approval (top-level or in a reused lane) was started by the
\* session's owner in person (a user, not over MCP, not through an agent session), who answered every one of them.
Inv_ReuseNeedsOwnerInPerson ==
    (phase = "admitted" /\ (\E v \in SpecReused(pChosen, pMode) : v \in Approvals)) =>
        /\ actorKind = "user" /\ ~viaProxy /\ ~viaMcp /\ starter = "owner"
        /\ \A v \in SpecReused(pChosen, pMode) \cap Approvals : decider[v] = "owner"

\* Witnesses (each expected violated).
\* RR-6: continue at a parallel step reuses its lanes, with a KV write between it and the next visit.
Wit_NoContinueAtParallel ==
    ~(phase = "admitted" /\ pMode = "continue" /\ ParIdx = pChosen /\ pReusedLanes = Lanes /\ pChosen < n /\ bump[pChosen + 1])
\* RR-6: supply keeps the chosen visit's KV writes of the cut visit's successor pin; run_again drops a write before V.
Wit_NoSupplyKv == ~(phase = "admitted" /\ pMode = "supply" /\ pChosen < n /\ bump[pChosen + 1] /\ pKv > Pin(pChosen))
Wit_NoRunAgainKvBefore == ~(phase = "admitted" /\ pMode = "run_again" /\ bump[pChosen] /\ pChosen > 1)
\* RR-8: a good (finished) spawn is reused and a later bad one is cut back to.
Wit_NoGoodReusedBadCut ==
    ~(phase = "admitted" /\ pGr1Moved /\ \E v \in SpecReused(pChosen, pMode) : v \in Spawns /\ childAt[v] = "completed")
\* RR-8: two bad spawns, cut back to the earlier one.
Wit_NoTwoBadSpawns == ~(phase = "admitted" /\ pGr1Moved /\ Count({TopOf(v) : v \in pBad}) >= 2)
\* RR-8: a lane spawn lifts the cut to its parallel step.
Wit_NoLaneLift == ~(phase = "admitted" /\ pGr1Moved /\ pChosen = ParIdx /\ \E j \in Lanes : LaneVisit(j) \in pBad)
\* RR-8: a child running at the plan ends between the plan and the admission.
Wit_NoStaleFlag == ~(phase = "admitted" /\ \E v \in pBad : childAt[v] = "completed")
\* RR-7 / MA-1: a reused lane approval answered by the owner, started by the owner in person.
Wit_NoLaneApprovalReused == ~(phase = "admitted" /\ \E j \in pReusedLanes : LaneVisit(j) \in Approvals)
\* RR-7 / MA-1: the gate refuses the owner over MCP.
Wit_NoMcpRefusal == ~(phase = "refused" /\ viaMcp /\ starter = "owner" /\ actorKind = "user" /\ ~viaProxy)

=============================================================================
