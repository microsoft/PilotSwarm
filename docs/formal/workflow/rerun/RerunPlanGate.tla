---------------------------- MODULE RerunPlanGate ----------------------------
(***************************************************************************)
(* Re-run plan, claim and admission over a source history TLC chooses     *)
(* (I7, audit RR-6, RR-8, RR-7 / MA-1).                                    *)
(*                                                                         *)
(* TLC chooses #2's history: up to MaxTop top-level visits, each of a kind *)
(* in TopKinds (at most one parallel step, whose two lanes have kinds in   *)
(* LaneKinds), KV writes (set_vars) before any visit or after the last,    *)
(* each spawned child's evidence when the plan reads it, each approval's  *)
(* recorded decider (or none), and the Start: the chosen visit and mode   *)
(* (explicit), or the automatic pick's candidate and default mode with the *)
(* requested mode, and the caller's channel (person or system, an agent   *)
(* session proxy, MCP) and identity.                                       *)
(*                                                                         *)
(* A spawned child's evidence is three things, not its lifecycle alone:   *)
(* the child's own state (running, completed, or cancelled by #2's end),  *)
(* whether #2's end recorded a parent-end cancel operation for it, and    *)
(* whether its WorkflowEnded@1 notice row is in the immediate source's    *)
(* inbox (the notice is a separate input transaction: a child can be      *)
(* completed before it arrives). With Generations = 2, #2 is a re-run of  *)
(* #1 that reused a spawn and a receive after it: when #1's receive read  *)
(* the child's notice, #2's inbox has no row for it (a read message is    *)
(* never carried).                                                         *)
(*                                                                         *)
(* The code is written as rerun.ts and session-definitions.ts compute it  *)
(* (partitionRerunVisits reusedSplit / droppedSplit, lanes by their       *)
(* parallel, rerunCutKvRevision, pickRerunTarget's G-R1 scan over         *)
(* listRerunKeys' two flags, the approval gate) and as the admission      *)
(* stores it (store.ts insertRun: the KV snapshot and the revision rows   *)
(* with revision <= R; verifyRerunLimitsAndApprovalsIn: each reused       *)
(* approval's provenance, read now, against the identity the plan pinned).*)
(* The plan's approval gate refuses before any claim (no shell); the      *)
(* admission's re-check refuses after the claim (a rollback; the shell's  *)
(* cleanup is owed). Between the plan and the admission a child can still *)
(* end, and an approval's recorded provenance can change; the admission   *)
(* does not read the spawn flags again. #2 has ended before the plan      *)
(* (prepareRerunStart refuses an active source), so no notice row can be  *)
(* inserted into it any more: a late delivery of a child's notice is      *)
(* refused (acceptInput RUN_ENDED, or the runtime skips an inactive        *)
(* parent run) and leaves #2's inbox as the plan read it (review H3).     *)
(*                                                                         *)
(* The invariants state the design independently: by visit order and      *)
(* instants (a KV write k at instant 2k-1, visit i entered at 2i, #2's    *)
(* end at 2n+2), each revision's distinct value, the flags as the plan    *)
(* read them, and each child's own state.                                  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxTop,                 \* 2..4: most top-level visits in #2
    TopKinds,               \* subset of {"work", "spawn", "parallel", "approval", "receive"}
    LaneKinds,              \* subset of {"work", "spawn", "approval"}
    WithBumps,              \* TRUE = TLC chooses KV writes between visits
    AutoPick,               \* TRUE = the Start names no visit (pickRerunTarget picks it, with G-R1)
    Modes,                  \* explicit Starts: subset of {"run_again", "continue", "supply"}
    WithGate,               \* TRUE = TLC chooses the caller's channel and identity and each approval's decider
    Generations,            \* 1 | 2: #2 is itself a re-run whose spawn and later receive were reused from #1
    \* ---- faults ----
    SplitOffByOne,          \* continue reuses only the visits before the chosen one (reusedSplit = chosenIndex)
    LanesByIndex,           \* a lane is reused only when its parallel is before the chosen visit
    DroppedOffByOne,        \* continue drops the chosen visit too (droppedSplit = chosenIndex)
    DroppedLanesByIndex,    \* a lane is dropped only when its parallel is after the chosen visit
    KvUsesChosenPin,        \* the copied KV ceiling is the chosen visit's pin
    KvSnapshotBelowCut,     \* the run's KV snapshot is selected with revision < R
    KvRowsBelowCut,         \* the KV revision rows are copied with revision < R
    Gr1PicksLatest,         \* G-R1 cuts back to the latest reused bad spawn
    Gr1TopOnly,             \* G-R1 scans top-level spawns only, not lane spawns
    Gr1CutsBefore,          \* G-R1 cuts one visit before the earliest bad spawn
    Gr1NeverMoves,          \* G-R1 never moves the cut
    Gr1UsesChildStatus,     \* G-R1 reads the child's own state (completed = finished) instead of the two flags
    GateIgnoresMcp,         \* the plan's gate lets a person reuse an approval over MCP
    GateIgnoresProxy,       \* the plan's gate lets an agent session (originatingSessionId) reuse an approval for its owner
    GateIgnoresDecider,     \* neither gate compares each approval's decider with the starter
    GateIgnoresOwner,       \* the plan's gate does not compare the starter with the session's owner
    GateTopLevelOnly,       \* the plan's gate looks only at top-level approvals, not at approvals inside a reused lane
    GateSkipPlan,           \* the plan has no approval gate (only the admission's re-check)
    GateSkipRecheck,        \* the admission does not re-check the reused approvals' provenance
    GateRecheckAsPlan       \* the admission's re-check refusal is treated as a plan refusal (no cleanup of the claim)

ASSUME MaxTop \in 2..4 /\ Generations \in {1, 2}
ASSUME TopKinds \subseteq {"work", "spawn", "parallel", "approval", "receive"} /\ "work" \in TopKinds
ASSUME LaneKinds \subseteq {"work", "spawn", "approval"} /\ LaneKinds # {}
ASSUME Modes \subseteq {"run_again", "continue", "supply"}
ASSUME {WithBumps, AutoPick, WithGate, SplitOffByOne, LanesByIndex, DroppedOffByOne, DroppedLanesByIndex, KvUsesChosenPin,
        KvSnapshotBelowCut, KvRowsBelowCut, Gr1PicksLatest, Gr1TopOnly, Gr1CutsBefore, Gr1NeverMoves, Gr1UsesChildStatus,
        GateIgnoresMcp, GateIgnoresProxy, GateIgnoresDecider, GateIgnoresOwner, GateTopLevelOnly, GateSkipPlan,
        GateSkipRecheck, GateRecheckAsPlan} \subseteq BOOLEAN

Lanes == {1, 2}
Persons == {"owner", "other"}
Deciders == Persons \cup {"none"}           \* "none": no workflow_approvals row and no output.decidedBy
Lives == {"running", "completed", "cancelled"}   \* the child's own state; "cancelled" = by #2's end cancel
Notices == {"none", "row", "read_earlier"}   \* in flight; a row in #2's inbox (read or not); read in #1, not in #2

VARIABLES
    n,          \* number of top-level visits
    kind,       \* [1..n -> kinds]
    laneKind,   \* [Lanes -> LaneKinds] (used when a top visit is the parallel step)
    bump,       \* [1..n+1 -> BOOLEAN]: a KV write before visit k (k = n+1: after the last visit, before #2 ended)
    life, op, notice,   \* [Spawns -> ...]: each spawned child's own state, parent-end operation, notice row
    decider,    \* [Approvals -> Deciders]: the provenance of each answered approval, as the store reads it now
    chosen0,    \* the requested visit (explicit) or the automatic pick's candidate (top-level index)
    mode0,      \* the requested mode, or the automatic pick's default mode
    reqMode,    \* AutoPick: "none" | "run_again" | "continue" (the caller's mode)
    actorKind, viaProxy, viaMcp, starter,   \* the caller: "user" | "system", originatingSessionId set, MCP, who
    phase,      \* "init" | "planned" | "claimed" | "admitted" | "refused_plan" | "refused_admit"
    \* the plan (session-definitions.ts prepareRerunStart), kept as computed
    pChosen, pMode, pReusedTop, pReusedLanes, pDroppedTop, pDroppedLanes, pSupplied, pKv, pGr1Moved, pinned,
    snapOp, snapNotice, \* the spawn flags' inputs as the plan read them
    \* the admission's commit (store.ts createDefinition)
    aReused, aDropped, aSupplied, aKvRows, aKvSnap,
    shellMade, cleanupOwed, provChanged,
    noticeRefused   \* review H3: spawns whose late notice delivery to the ended #2 was attempted and refused (no row)

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
\* A receive after the spawn's step (with Generations = 2 it read the child's notice in #1 and #2 reused it).
ReceiveAfter(v) == \E i \in 1..n : kind[i] = "receive" /\ i > TopOf(v)

\* The evidence a spawned child can have when the plan reads it. A running child's parent-end cancel was recorded (it was
\* active at #2's end); a child cancelled by that cancel has one too; a child that finished before #2 ended has none, and
\* one that finished on its own after #2 ended has one. Its notice is a row only once it ended.
EvAll ==
    {e \in [life: Lives, op: BOOLEAN, notice: Notices] :
        /\ e.life = "running" => (e.op /\ e.notice = "none")
        /\ e.life = "cancelled" => e.op
        /\ e.notice = "read_earlier" => (e.life = "completed" /\ ~e.op)}
Evidence(v) == {e \in EvAll : e.notice = "read_earlier" => (Generations = 2 /\ ReceiveAfter(v))}

Count(S) == Cardinality(S)
Min(S) == CHOOSE x \in S : \A y \in S : x <= y
Max(S) == CHOOSE x \in S : \A y \in S : x >= y
\* A visit's KV pin: the revision when it was admitted (lanes: their parallel's). #2's last revision includes a write after
\* its last visit. Revision r holds a value of its own (KvValue): no two revisions hold the same variables.
Pin(i) == 1 + Count({k \in 1..i : bump[k]})
SourceKv == 1 + Count({k \in 1..(n + 1) : bump[k]})
KvValue(r) == r

Valid(i, m) ==
    /\ i \in 1..n
    /\ (m = "supply" => kind[i] = "work")      \* supply: a script or agent visit only (approval, spawn, parallel refused)

vars == <<n, kind, laneKind, bump, life, op, notice, decider, chosen0, mode0, reqMode, actorKind, viaProxy, viaMcp, starter,
          phase, pChosen, pMode, pReusedTop, pReusedLanes, pDroppedTop, pDroppedLanes, pSupplied, pKv, pGr1Moved, pinned,
          snapOp, snapNotice, aReused, aDropped, aSupplied, aKvRows, aKvSnap, shellMade, cleanupOwed, provChanged,
          noticeRefused>>
\* #2's history and the Start; noticeRefused records refused delivery attempts to the ended #2 (they change nothing else).
historyVars == <<n, kind, laneKind, bump, chosen0, mode0, reqMode, actorKind, viaProxy, viaMcp, starter, noticeRefused>>
planVars == <<pChosen, pMode, pReusedTop, pReusedLanes, pDroppedTop, pDroppedLanes, pSupplied, pKv, pGr1Moved, pinned,
              snapOp, snapNotice>>
admitVars == <<aReused, aDropped, aSupplied, aKvRows, aKvSnap>>

TypeOK ==
    /\ n \in 2..MaxTop
    /\ kind \in [1..n -> TopKinds] /\ laneKind \in [Lanes -> LaneKinds \cup {"work"}]
    /\ bump \in [1..(n + 1) -> BOOLEAN]
    /\ life \in [Spawns -> Lives] /\ op \in [Spawns -> BOOLEAN] /\ notice \in [Spawns -> Notices]
    /\ decider \in [Approvals -> Deciders]
    /\ phase \in {"init", "planned", "claimed", "admitted", "refused_plan", "refused_admit"}
    /\ pChosen \in 0..MaxTop /\ pMode \in {"none", "run_again", "continue", "supply"}
    /\ pReusedTop \subseteq 1..n /\ pDroppedTop \subseteq 1..n /\ pSupplied \subseteq 1..n
    /\ pReusedLanes \subseteq Lanes /\ pDroppedLanes \subseteq Lanes
    /\ pKv \in 0..(MaxTop + 2) /\ pGr1Moved \in BOOLEAN /\ pinned \in Persons \cup {"none"}
    /\ aReused \subseteq Visits /\ aDropped \subseteq Visits /\ aSupplied \subseteq Visits
    /\ aKvRows \subseteq 1..(MaxTop + 2) /\ aKvSnap \in 0..(MaxTop + 2)
    /\ {shellMade, cleanupOwed, provChanged} \subseteq BOOLEAN
    /\ noticeRefused \subseteq AllVisits

\* Init chooses each value over the domain the earlier ones fix (TLC enumerates only those).
Init ==
    /\ n \in 2..MaxTop
    /\ kind \in [1..n -> TopKinds]
    /\ Count({i \in 1..n : kind[i] = "parallel"}) <= 1
    /\ laneKind \in [Lanes -> IF ParIdx > 0 THEN LaneKinds ELSE {"work"}]
    /\ bump \in [1..(n + 1) -> IF WithBumps THEN BOOLEAN ELSE {FALSE}]
    /\ \E ev \in [Spawns -> EvAll] :
         /\ \A v \in Spawns : ev[v] \in Evidence(v)
         /\ life = [v \in Spawns |-> ev[v].life] /\ op = [v \in Spawns |-> ev[v].op]
         /\ notice = [v \in Spawns |-> ev[v].notice]
    /\ decider \in [Approvals -> IF WithGate THEN Deciders ELSE {"owner"}]
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
    /\ pChosen = 0 /\ pMode = "none" /\ pReusedTop = {} /\ pReusedLanes = {} /\ pDroppedTop = {} /\ pDroppedLanes = {}
    /\ pSupplied = {} /\ pKv = 0 /\ pGr1Moved = FALSE /\ pinned = "none"
    /\ snapOp = [v \in Spawns |-> FALSE] /\ snapNotice = [v \in Spawns |-> "none"]
    /\ aReused = {} /\ aDropped = {} /\ aSupplied = {} /\ aKvRows = {} /\ aKvSnap = 0
    /\ shellMade = FALSE /\ cleanupOwed = FALSE /\ provChanged = FALSE
    /\ noticeRefused = {}

-----------------------------------------------------------------------------
(* The code                                                                *)

\* rerun.ts partitionRerunVisits: reusedSplit = continue ? chosenIndex + 1 : chosenIndex (1-based: the first c or c - 1
\* visits); droppedSplit = run_again ? chosenIndex : chosenIndex + 1 (the supplied visit is neither); lanes follow their
\* parallel.
CodeReusedTop(c, m) == {i \in 1..n : i < c \/ (m = "continue" /\ i = c /\ ~SplitOffByOne)}
CodeDroppedTop(c, m) == {i \in 1..n : i > c \/ (m = "run_again" /\ i = c) \/ (m = "continue" /\ i = c /\ DroppedOffByOne)}
CodeReusedLanes(c, m) ==
    IF ParIdx = 0 THEN {}
    ELSE IF (IF LanesByIndex THEN ParIdx < c ELSE ParIdx \in CodeReusedTop(c, m)) THEN Lanes ELSE {}
CodeDroppedLanes(c, m) ==
    IF ParIdx = 0 THEN {}
    ELSE IF (IF DroppedLanesByIndex THEN ParIdx > c ELSE ParIdx \in CodeDroppedTop(c, m)) THEN Lanes ELSE {}
\* rerun.ts rerunCutKvRevision: max(1, the first dropped top-level visit's pin (else #2's last revision), every copied pin,
\* and in supply mode the chosen visit's pin).
CodeKv(c, m) ==
    LET dropped == CodeDroppedTop(c, m)
        cut == IF KvUsesChosenPin THEN Pin(c) ELSE IF dropped # {} THEN Pin(Min(dropped)) ELSE SourceKv
        pins == {Pin(i) : i \in CodeReusedTop(c, m)} \cup (IF m = "supply" THEN {Pin(c)} ELSE {})
    IN Max({1, cut} \cup pins)
\* store.ts insertRun: the run's variables are the newest revision <= R (none: the start's own, value 0); the revision rows
\* copied are those <= R (faults: < R).
CodeKvSnap(r) ==
    LET s == {k \in 1..SourceKv : IF KvSnapshotBelowCut THEN k < r ELSE k <= r} IN IF s = {} THEN 0 ELSE KvValue(Max(s))
CodeKvRows(r) == {k \in 1..SourceKv : IF KvRowsBelowCut THEN k < r ELSE k <= r}

\* listRerunKeys' flags: spawnChildCancelledBySourceEnd (a parent-end operation) and spawnChildHasNotice (a notice row in
\* the immediate source's inbox, read or not). G-R1 skips a spawn only when it has no parent-end operation and has a
\* notice row (fault Gr1UsesChildStatus: when the child is completed, whatever the flags).
CodeBad(v) ==
    v \in Spawns /\ IF Gr1UsesChildStatus THEN life[v] # "completed" ELSE (op[v] \/ notice[v] # "row")

\* pickRerunTarget's G-R1 scan (auto-pick, requested mode none or run_again): the candidate's reused visits (top and lanes),
\* each bad spawn lifted to its top-level step, the earliest one (faults: latest, top-level only, one visit before, never).
Gr1Applies == AutoPick /\ reqMode # "continue"
CandMode == IF reqMode = "none" THEN mode0 ELSE reqMode
CandReused ==
    {TopVisit(i) : i \in CodeReusedTop(chosen0, CandMode)} \cup {LaneVisit(j) : j \in CodeReusedLanes(chosen0, CandMode)}
BadTops == {TopOf(v) : v \in {w \in CandReused : CodeBad(w) /\ (~Gr1TopOnly \/ w[1] = "T")}}
Gr1Target ==
    IF Gr1PicksLatest THEN Max(BadTops)
    ELSE IF Gr1CutsBefore /\ Min(BadTops) > 1 THEN Min(BadTops) - 1
    ELSE Min(BadTops)

\* session-definitions.ts:944-969, the plan's approval gate over the reused answered approvals (top and lanes): the person
\* who owns the session, directly (not over MCP, not through an agent session), with a provenance row for every one, who
\* decided every one. It pins that person (approvalOwnerCheck) for the admission.
PlanApprovals(top, lanes) ==
    {v \in Approvals : (v[1] = "T" /\ v[2] \in top) \/ (v[1] = "L" /\ v[2] \in lanes /\ ~GateTopLevelOnly)}
AllApprovals(top, lanes) ==
    {v \in Approvals : (v[1] = "T" /\ v[2] \in top) \/ (v[1] = "L" /\ v[2] \in lanes)}
DirectOwner ==
    actorKind = "user" /\ (~viaProxy \/ GateIgnoresProxy) /\ (~viaMcp \/ GateIgnoresMcp)
PlanGateRefuses(top, lanes) ==
    /\ ~GateSkipPlan
    /\ PlanApprovals(top, lanes) # {}
    /\ \/ ~DirectOwner
       \/ (starter # "owner" /\ ~GateIgnoresOwner)
       \/ (\E v \in PlanApprovals(top, lanes) : decider[v] = "none")
       \/ (\E v \in PlanApprovals(top, lanes) : decider[v] # starter /\ ~GateIgnoresDecider)
\* store.ts verifyRerunLimitsAndApprovalsIn: every reused answered approval (the mapped visits, lanes included), with its
\* provenance read now, against the pinned identity.
RecheckRefuses(top, lanes) ==
    /\ ~GateSkipRecheck
    /\ \E v \in AllApprovals(top, lanes) :
         pinned = "none" \/ decider[v] = "none" \/ (decider[v] # pinned /\ ~GateIgnoresDecider)

Plan ==
    /\ phase = "init"
    /\ LET moved == Gr1Applies /\ BadTops # {} /\ ~Gr1NeverMoves
           c == IF moved THEN Gr1Target ELSE chosen0
           m == IF moved THEN "run_again" ELSE IF AutoPick THEN CandMode ELSE mode0
           top == CodeReusedTop(c, m)
           lanes == CodeReusedLanes(c, m)
       IN /\ pChosen' = c /\ pMode' = m /\ pGr1Moved' = moved
          /\ pReusedTop' = top /\ pReusedLanes' = lanes
          /\ pDroppedTop' = CodeDroppedTop(c, m) /\ pDroppedLanes' = CodeDroppedLanes(c, m)
          /\ pSupplied' = IF m = "supply" THEN {c} ELSE {}
          /\ pKv' = CodeKv(c, m)
          /\ pinned' = IF AllApprovals(top, lanes) # {} /\ DirectOwner THEN starter ELSE "none"
          /\ snapOp' = op /\ snapNotice' = notice
          /\ phase' = IF PlanGateRefuses(top, lanes) THEN "refused_plan" ELSE "planned"
    /\ UNCHANGED <<historyVars, life, op, notice, decider, admitVars, shellMade, cleanupOwed, provChanged>>

\* The claim (createWorkflowSession): the shell exists from here on; a refusal after it owes the shell's cleanup.
Claim ==
    /\ phase = "planned"
    /\ phase' = "claimed" /\ shellMade' = TRUE
    /\ UNCHANGED <<historyVars, life, op, notice, decider, planVars, admitVars, cleanupOwed, provChanged>>

\* Between the plan and the admission: a running child ends (#2's parent-end cancel lands, or it finishes first); a late
\* delivery of an ended child's notice to the ended #2 is refused; an answered approval's recorded provenance changes or
\* goes missing.
EnvUnchanged == UNCHANGED <<historyVars, phase, planVars, admitVars, shellMade, cleanupOwed>>
ChildEnds(v) ==
    /\ phase \in {"planned", "claimed"} /\ v \in Spawns /\ life[v] = "running"
    /\ \E s \in {"completed", "cancelled"} : life' = [life EXCEPT ![v] = s]
    /\ UNCHANGED <<op, notice, decider, provChanged>> /\ EnvUnchanged
\* Review H3: the notice of a child that ended with no row in #2 is delivered after #2 ended. runtime.ts targets the
\* spawning run (#2) and skips it when inactive; a delivery already in flight reaches store.ts acceptInput, which locks #2's
\* run row and refuses it (RUN_ENDED) before any insert. #2's inbox (notice) is unchanged: no fresh notice row is ever
\* inserted into an ended source run.
LateNoticeRefused(v) ==
    /\ phase \in {"planned", "claimed"} /\ v \in Spawns /\ life[v] # "running" /\ notice[v] = "none" /\ v \notin noticeRefused
    /\ noticeRefused' = noticeRefused \cup {v}
    /\ UNCHANGED <<n, kind, laneKind, bump, chosen0, mode0, reqMode, actorKind, viaProxy, viaMcp, starter>>
    /\ UNCHANGED <<life, op, notice, decider, provChanged, phase, planVars, admitVars, shellMade, cleanupOwed>>
ProvenanceChanges(v) ==
    /\ WithGate /\ ~provChanged /\ phase \in {"planned", "claimed"} /\ v \in Approvals
    /\ \E d \in Deciders \ {decider[v]} : decider' = [decider EXCEPT ![v] = d]
    /\ provChanged' = TRUE
    /\ UNCHANGED <<life, op, notice>> /\ EnvUnchanged

\* The admission (createDefinition, one transaction): the approval re-check, then the copy: the reused visits (top and
\* lanes), the supplied visit, the dropped split the plan computed, the KV snapshot and the revision rows. A refusal rolls
\* back; the claim's shell is left for its cleanup (fault GateRecheckAsPlan: treated as a plan refusal, no cleanup owed).
Admit ==
    /\ phase = "claimed"
    /\ IF RecheckRefuses(pReusedTop, pReusedLanes)
         THEN /\ phase' = IF GateRecheckAsPlan THEN "refused_plan" ELSE "refused_admit"
              /\ cleanupOwed' = ~GateRecheckAsPlan
              /\ UNCHANGED admitVars
         ELSE /\ phase' = "admitted"
              /\ aReused' = {TopVisit(i) : i \in pReusedTop} \cup {LaneVisit(j) : j \in pReusedLanes}
              /\ aDropped' = {TopVisit(i) : i \in pDroppedTop} \cup {LaneVisit(j) : j \in pDroppedLanes}
              /\ aSupplied' = {TopVisit(i) : i \in pSupplied}
              /\ aKvRows' = CodeKvRows(pKv)
              /\ aKvSnap' = CodeKvSnap(pKv)
              /\ UNCHANGED cleanupOwed
    /\ UNCHANGED <<historyVars, life, op, notice, decider, planVars, shellMade, provChanged>>

Ended == phase \in {"admitted", "refused_plan", "refused_admit"}
Done == Ended /\ UNCHANGED vars

Next == Plan \/ Claim \/ (\E v \in AllVisits : ChildEnds(v) \/ LateNoticeRefused(v) \/ ProvenanceChanges(v)) \/ Admit \/ Done
Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The design, stated independently                                       *)

\* RR-6: #3 reuses exactly the visits that ran before the chosen one (and the chosen one itself for continue), with the
\* lanes of every reused parallel step; supply replaces the chosen visit; every other visit runs again.
SpecReused(c, m) == {v \in Visits : TopOf(v) < c \/ (m = "continue" /\ TopOf(v) = c)}
SpecSupplied(c, m) == IF m = "supply" THEN {TopVisit(c)} ELSE {}
SpecDropped(c, m) == Visits \ (SpecReused(c, m) \cup SpecSupplied(c, m))
PlannedLike == phase \in {"planned", "claimed", "admitted", "refused_admit"}
Inv_ReusedIsPrefix ==
    PlannedLike =>
        /\ {TopVisit(i) : i \in pReusedTop} \cup {LaneVisit(j) : j \in pReusedLanes} = SpecReused(pChosen, pMode)
        /\ pSupplied = (IF pMode = "supply" THEN {pChosen} ELSE {})
        /\ pChosen \notin pReusedTop \/ pMode = "continue"

\* RR-6: the admission commits an exact partition of #2's visits: reused, supplied and dropped, each visit in exactly one,
\* each as the design states it.
Inv_ExactPartition ==
    phase = "admitted" =>
        /\ aReused = SpecReused(pChosen, pMode)
        /\ aSupplied = SpecSupplied(pChosen, pMode)
        /\ aDropped = SpecDropped(pChosen, pMode)
        /\ aReused \cap aDropped = {} /\ aReused \cap aSupplied = {} /\ aDropped \cap aSupplied = {}
        /\ aReused \cup aDropped \cup aSupplied = Visits

\* RR-6: the KV #3 starts from is #2's variables at the instant of the cut: the entry of the first top-level visit that
\* runs again (run_again: the chosen one; continue and supply: the next one), or #2's end when none runs again.
CutInstant(c, m) == IF m = "run_again" THEN 2 * c ELSE 2 * (c + 1)
KvAt(t) == 1 + Count({k \in 1..(n + 1) : bump[k] /\ 2 * k - 1 < t})
Inv_KvAtCut ==
    PlannedLike => pKv = KvAt(CutInstant(pChosen, pMode))
\* RR-6: the admitted run holds exactly that revision's variables, and #3's revision history is exactly revisions 1..R of
\* #2 (R included).
Inv_KvAdmitted ==
    phase = "admitted" =>
        /\ aKvSnap = KvValue(KvAt(CutInstant(pChosen, pMode)))
        /\ aKvRows = 1..KvAt(CutInstant(pChosen, pMode))

\* RR-8: an automatic pick never reuses a spawn whose child did not finish on its own (it was cancelled by #2's end or is
\* still running), at the top level or in a lane, however the children and notices moved after the plan.
Inv_ReusedSpawnFinished ==
    (phase = "admitted" /\ Gr1Applies) =>
        \A v \in SpecReused(pChosen, pMode) : v \in Spawns => life[v] = "completed"

\* RR-8: G-R1 cuts at exactly the earliest top-level step of a bad candidate, as the plan read the flags (a parent-end
\* operation, or no notice row in the immediate source), whatever the admission sees later; with no bad candidate the
\* cut stays at the candidate.
SpecBadTops ==
    LET m == IF reqMode = "none" THEN mode0 ELSE reqMode
    IN {TopOf(v) : v \in {w \in SpecReused(chosen0, m) : w \in Spawns /\ (snapOp[w] \/ snapNotice[w] # "row")}}
Inv_Gr1CutAtMinBad ==
    (PlannedLike /\ Gr1Applies) =>
        IF SpecBadTops # {}
          THEN pGr1Moved /\ pChosen = Min(SpecBadTops) /\ pMode = "run_again"
          ELSE ~pGr1Moved /\ pChosen = chosen0

\* RR-7 / MA-1: an admitted re-run that reuses an answered approval (top-level or in a reused lane) was started by the
\* session's owner in person (a user, not over MCP, not through an agent session), who answered every one of them, as
\* the admission read them.
Inv_ReuseNeedsOwnerInPerson ==
    (phase = "admitted" /\ (\E v \in SpecReused(pChosen, pMode) : v \in Approvals)) =>
        /\ actorKind = "user" /\ ~viaProxy /\ ~viaMcp /\ starter = "owner"
        /\ \A v \in SpecReused(pChosen, pMode) \cap Approvals : decider[v] = "owner"

\* RR-7 / MA-1: what the plan can see is refused before the claim; the admission refuses only a provenance that changed
\* after the plan.
Inv_PlanRefusesWhatItSees == phase = "refused_admit" => provChanged

\* RR-7 / MA-1: a plan refusal made no shell; an admission refusal leaves the claim's shell with its cleanup owed.
Inv_RefusalShellAccounted ==
    /\ phase = "refused_plan" => ~shellMade
    /\ phase = "refused_admit" => (shellMade /\ cleanupOwed)

\* Witnesses (each expected violated).
\* RR-6: continue at a parallel step reuses its lanes, with a KV write between it and the next visit.
Wit_NoContinueAtParallel ==
    ~(phase = "admitted" /\ pMode = "continue" /\ ParIdx = pChosen /\ pReusedLanes = Lanes /\ pChosen < n /\ bump[pChosen + 1])
\* RR-6: supply keeps the KV writes up to the successor's pin.
Wit_NoSupplyKv == ~(phase = "admitted" /\ pMode = "supply" /\ pChosen < n /\ bump[pChosen + 1] /\ pKv > Pin(pChosen))
\* RR-6: run_again from a visit with a KV write before it keeps that write (the cut is the visit's own pin).
Wit_NoRunAgainKvBefore == ~(phase = "admitted" /\ pMode = "run_again" /\ bump[pChosen] /\ pChosen > 1)
\* RR-6: the admitted snapshot is revision R exactly, with a later revision of #2 that is not copied.
Wit_NoKvCutBetweenRevisions == ~(phase = "admitted" /\ aKvSnap > 1 /\ aKvSnap < SourceKv)
\* RR-6: run_again at a parallel step drops it with its lanes.
Wit_NoDroppedLanes == ~(phase = "admitted" /\ \E j \in Lanes : LaneVisit(j) \in aDropped)
\* RR-8: a good (finished, notice row) spawn is reused and a later bad one is cut back to.
Wit_NoGoodReusedBadCut ==
    ~(phase = "admitted" /\ pGr1Moved /\ \E v \in SpecReused(pChosen, pMode) : v \in Spawns /\ life[v] = "completed")
\* RR-8: two bad spawns, cut back to the earlier one.
Wit_NoTwoBadSpawns == ~(phase = "admitted" /\ pGr1Moved /\ Count(SpecBadTops) >= 2)
\* RR-8: a lane spawn lifts the cut to its parallel step.
Wit_NoLaneLift ==
    ~(phase = "admitted" /\ pGr1Moved /\ pChosen = ParIdx /\ \E j \in Lanes : LaneVisit(j) \in Spawns
                                                                     /\ (snapOp[LaneVisit(j)] \/ snapNotice[LaneVisit(j)] # "row"))
\* RR-8: a child running at the plan ends between the plan and the admission (the admission keeps the plan's cut).
Wit_NoStaleFlag == ~(phase = "admitted" /\ pGr1Moved /\ \E v \in Spawns : TopOf(v) = pChosen /\ snapOp[v] /\ life[v] = "completed")
\* RR-8: a child completed before the plan but its notice had not arrived: cut back to its spawn.
Wit_NoNoticeAfterCompletion ==
    ~(phase = "admitted" /\ pGr1Moved /\ \E v \in Spawns : TopOf(v) = pChosen /\ ~snapOp[v] /\ snapNotice[v] = "none"
                                                         /\ life[v] = "completed")
\* RR-8 / review H3: a child ended with no notice row in the ended #2; a late delivery of its notice between the plan and
\* the admission is refused and inserts nothing; the admission keeps the plan's cut-back to its spawn.
Wit_NoRefusedLateNotice ==
    ~(phase = "admitted" /\ pGr1Moved /\ \E v \in Spawns : TopOf(v) = pChosen /\ snapNotice[v] = "none" /\ v \in noticeRefused
                                                         /\ notice[v] = "none")
\* RR-8 (Generations = 2): #1's kept receive read the child's notice, #2 reused the spawn and the receive without a notice
\* row, and the automatic pick on #2 cuts back to the spawn.
Wit_NoKeptReceiveCutBack ==
    ~(phase = "admitted" /\ pGr1Moved /\ \E v \in Spawns : TopOf(v) = pChosen /\ snapNotice[v] = "read_earlier")
\* RR-7 / MA-1: a reused lane approval answered by the owner, started by the owner in person.
Wit_NoLaneApprovalReused == ~(phase = "admitted" /\ \E j \in pReusedLanes : LaneVisit(j) \in Approvals)
\* RR-7 / MA-1: the plan's gate refuses the owner over MCP, before any claim.
Wit_NoMcpRefusal == ~(phase = "refused_plan" /\ viaMcp /\ starter = "owner" /\ actorKind = "user" /\ ~viaProxy)
\* RR-7 / MA-1: the plan's gate refuses a reused approval with no provenance.
Wit_NoMissingProvenanceRefused == ~(phase = "refused_plan" /\ \E v \in Approvals : decider[v] = "none")
\* RR-7 / MA-1: the admission's re-check refuses after the claim, because a provenance changed after the plan.
Wit_NoRecheckRefusal == ~(phase = "refused_admit" /\ provChanged /\ cleanupOwed)

=============================================================================
