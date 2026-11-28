------------------------------- MODULE WorkflowRerun -------------------------------
(***************************************************************************)
(* Formal model of Workflow Re-run from a Chosen Visit (I7 v1 + supply)    *)
(* for microsoft/PilotSwarm.                                               *)
(*                                                                         *)
(* Restates the unchanged 1.3.0 controller loop (AdmitExec/AdmitRecord,    *)
(* CollectExec/CollectRecord, FinishExec/FinishFailExec, PollCommand,      *)
(* CancelTx) from WorkflowRun.tla starting from an atomically copied       *)
(* prefix of completed visits (and optional supplied visit V' in supply    *)
(* mode), coupled with:                                                    *)
(*   - Two-step Start: ClaimRerun (writes rerunPin incl. supplied digest   *)
(*     & creates claim shell) + crash/new-rev/retry-payload-change +       *)
(*     AdmitRerunCopy (owner FOR SHARE -> def FOR SHARE -> #2 FOR SHARE    *)
(*     -> #3 FOR NO KEY UPDATE in ascending session_id order);             *)
(*   - Refusal cleanup of the claim shell in a transaction of its own     *)
(*     after the refusal's rollback, which a crash can lose (RR-4:         *)
(*     RefusalCleanup / RefusalCleanupLost, Inv_RefusedClaimDeleted-       *)
(*     AtOnce) and Sweeper collection of stale bare claim shells after     *)
(*     grace on its own without OwnerEnd (R2-M1, SweeperReadBareShell +    *)
(*     SweeperCollectClaimShell, Inv_AdmittedNotSwept,                     *)
(*     Prop_SweepRequiresLockAndNoRun);                                    *)
(*   - Three deleters with exact SQL lock modes:                           *)
(*       * SweeperDirect: blocking FOR NO KEY UPDATE on target #2,         *)
(*         NOWAIT on descendants (store.ts sweeperSoftDelete);             *)
(*       * DeleteWorkflow: blocking UPDATE on #2                           *)
(*         (cms_soft_delete_session via management-client/cms.ts);         *)
(*       * OwnerEnded: blocking lock on owner, then                        *)
(*         session_workflow_definitions (defLock), then child Workflows    *)
(*         (#2, #3) in ascending session_id order                          *)
(*         (migration 0096 workflow_on_owner_session_ended);               *)
(*   - Compatibility check (FitCheck), cut guard (Guard) for run_again,    *)
(*     continue, and supply modes, supply guardrails (allowed step types,  *)
(*     supply: never, declared outcomes, non-blank note, never executes    *)
(*     effect or agent session), G-R1 auto-pick cut-back over top-level    *)
(*     and lane spawns (Inv_AutoPickNoCancelledReuse) + G-R2 async old-    *)
(*     child wind-down, exact carried inbox filtering over a generated     *)
(*     source inbox (Inv_InboxCarryExact) incl. stray child notices,       *)
(*     second-generation carry times (RR-1) and the source run's end time  *)
(*     racing an acceptance (MSG-1), & TTL expiry, quiescence              *)
(*     safety (Inv_QuiescentNoLive) and liveness (Live_Quiesces).          *)
(*                                                                         *)
(* Lock waits are modeled as disabled actions so any lock cycle surfaces   *)
(* as a TLC deadlock (CHECK_DEADLOCK TRUE on every case).                  *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    SourceKind,          \* "loop" | "catchall" | "parallel" | "approval" | "inbox" | "supply_first" | "spawn" | "spawn_lane"
    Mode,                \* "run_again" | "continue" | "supply"
    Target,              \* "same" | "fix_chosen" | "reroute_taken" | "reroute_onto_copy" | "reroute_supply"
    Generations,         \* 1 or 2 (#1 -> #2 -> #3)
    Actor,               \* "owner" | "agent" | "admin"
    MaxVisits,           \* per-step visit limit for S (1..3)
    StepLimit,           \* run limits.maxNodeExecutions (2..6)
    StartVars,           \* TRUE = Start supplied vars (kvRev = cutKvRev + 1, skips same-IR byte check)
    InputHashMismatch,   \* TRUE = evaluated input/carry hash at cut differs from source's recorded hash
    AllowDeleters,       \* enable SweeperDirect & DeleteWorkflow
    AllowOwnerEnd,       \* enable OwnerEnded specifically (locks owner -> def -> #2 -> #3)
    AllowClaimCrash,     \* allow retriable crash + new revision saved between Claim and Admit
    AllowCtrlCmds,       \* allow Pause/Resume, Stop, Cancel during pass-over/run
    AllowRetry,          \* allow AdmitExec retry before AdmitRecord during pass-over
    AllowCan,            \* allow ContinueAsNew during pass-over
    FitCheck,            \* TRUE = checkRerunCompatibility enforced; FALSE = bypassed
    Guard,               \* TRUE = enterNode cut guard & copied-coordinate guard enforced; FALSE = bypassed
    CheckInputHash,      \* TRUE = same-IR hash check enforced in cut guard; FALSE = fault
    CheckCopyCoord,      \* TRUE = copied-row predecessor/route checked on pass-over hit; FALSE = fault
    PlanBudget,          \* TRUE = plan subtracts rerun_unwalked; FALSE = fault
    FlatOrigin,          \* TRUE = COALESCE(reused_from, id); FALSE = fault
    AtomicCopy,          \* TRUE = run + copies (+ supplied row) in one TX; FALSE = fault
    ApprovalGate,        \* TRUE = owner-only approval reuse; FALSE = fault
    StartsDecided,       \* fault: controller starts effect for completed reused visit
    CopyKeepsIds,        \* fault: copy mutates source rows/IDs
    OrdinalsRestart,     \* fault: new visit restarts at ordinal 1
    DropsCatchAll,       \* fault: pass-over drops catchAllEntered on reused catch-all
    NoSourceLock,        \* fault: copy reads source live without FOR SHARE
    RepickOnResume,      \* fault: resumed Start after claim crash repicks latestRev
    CopyKeepsDeadline,   \* fault: copied receive visit keeps source total deadline
    DivergeInserts,      \* fault: cut guard inserts pending row before failing
    CarryLateMessage,    \* fault: inbox carry copies post-cut message
    CarryReadMessage,    \* fault: also carries a message a dropped visit read (consumed_by not a kept visit)
    CarryDropsEqualCut,  \* fault (old filter): treats accepted_at = cut as late (accepted_at < cut)
    CarryKeepsExpiredAtCut, \* fault: treats expires_at = cut as unexpired (expires_at >= cut)
    LockNewBeforeOwner,  \* fault: copy locks #2/#3 before owner (deadlocks OwnerEnded)
    \* ---- Unit 3A-Supply additions (supply mode, G-R1, R2-M1 observable Sweeper-vs-admission race, quiescence) ----
    SupplyNever,                  \* TRUE = chosen step sets supply: never on S or T
    SuppliedOutcome,              \* "ok" | "again" | "undeclared"
    SupplyNotePresent,            \* TRUE = valid non-blank note present
    AllowRetrySupplyChange,       \* allow retry after claim crash with changed supply payload
    AutoPicked,                   \* TRUE = execution_id omitted (auto-pick with G-R1)
    ReqModeContinue,              \* TRUE = caller explicitly passed mode="continue" (disables G-R1 per §5.5/§6.2/R2-N3)
    AllowResumeAfterCrash,        \* TRUE = crashed claim can retry; FALSE = unretried crash (S6)
    AllowShellSweeper,            \* enable SweeperReadBareShell + SweeperCollectClaimShell after grace without OwnerEnd
    AllowPostSweepStart,          \* allow one fresh Start (new key/opId) after Sweeper collects a stale shell
    AllowSupplyOnForbiddenStep,   \* fault: allow supply on approval / non-script-agent step
    StartsSupplied,               \* fault: controller starts effect/agent for supplied visit V'
    AllowUndeclaredSupplyOutcome, \* fault: admit undeclared supplied outcome
    IgnoreSupplyNever,            \* fault: ignore supply: never opt-out
    IgnoreMissingSupplyNote,      \* fault: admit supply without note
    RepickSuppliedOnRetry,        \* fault: retry admits changed supply payload instead of pinned/conflict
    SkipGr1CutBack,               \* fault: auto-pick skips G-R1 cut-back over cancelled/noticeless spawn
    SkipParentEndCancel,          \* fault: #2's end fails to cancel old spawn child (leaks at quiescence)
    SkipImmediateRefusalCleanup,  \* fault: post-claim refusal leaves claim shell live_unadmitted
    SweeperSkipsNewLockOrRecheck, \* fault (R2-M1): keeps grace, removes ONLY newLock / under-lock no-run re-check
    \* ---- Unit 3B fix wave R3 additions (I-INBOX, RR-1, MSG-1) ----
    StrayNotice,                  \* TRUE = #2's inbox also holds m_stray, a WorkflowEnded@1 notice of a child whose spawn #3 does not reuse
    CarryNoticeByTime,            \* fault (I-INBOX): the ordinary time arm drops ONLY its contract discriminator (contract <> WorkflowEnded@1)
    CutVisitCopied,               \* TRUE = (Generations = 2) #3's cut is a visit #2 copied from #1, and #2's inbox rows were carried from #1
    CarryComparesCopyTime,        \* fault (RR-1): the cut is compared with a carried row's accepted_at (its copy time), not its first acceptance
    SourceEndRace,                \* TRUE = #3 cuts at #2's end, and an acceptance into #2 races #2's end transaction (MSG-1)
    EndClock,                     \* "locked" = #2's end reads the clock after its locks; "begin" (fault, MSG-1) = now(), the transaction's start
    \* ---- Task 6a-TLA+2 additions (RR-4, RR-9) ----
    AllowCleanupCrash,            \* RR-4: a crash between a refusal and its cleanup transaction loses the cleanup
    RetryAfterCut,                \* RR-9: an enterNode result is lost and re-run after the cut too (not only in the pass-over)
    TakeIgnoresTaken,             \* fault (RR-9): a re-run enterNode of a receive that took a carried message takes it again
    \* ---- Task R5 (owner ruling, 27 Nov 22:35 PST) ----
    NoNewMessage                  \* TRUE = nobody sends #3 a new message: a receive with nothing to take hits its time limit

ASSUME SourceKind \in {"loop", "catchall", "parallel", "approval", "inbox", "supply_first", "spawn", "spawn_lane"}
ASSUME Mode \in {"run_again", "continue", "supply"}
ASSUME Target \in {"same", "fix_chosen", "reroute_taken", "reroute_onto_copy", "reroute_supply"}
ASSUME Generations \in {1, 2}
ASSUME Actor \in {"owner", "agent", "admin"}
ASSUME MaxVisits \in 1..3
ASSUME StepLimit \in 2..6
ASSUME SuppliedOutcome \in {"ok", "again", "undeclared"}
ASSUME {StartVars, InputHashMismatch, AllowDeleters, AllowOwnerEnd, AllowClaimCrash, AllowCtrlCmds,
        AllowRetry, AllowCan, FitCheck, Guard, CheckInputHash, CheckCopyCoord, PlanBudget,
        FlatOrigin, AtomicCopy, ApprovalGate, StartsDecided, CopyKeepsIds, OrdinalsRestart,
        DropsCatchAll, NoSourceLock, RepickOnResume, CopyKeepsDeadline, DivergeInserts,
        CarryLateMessage, CarryReadMessage, CarryDropsEqualCut, CarryKeepsExpiredAtCut, LockNewBeforeOwner,
        SupplyNever, SupplyNotePresent, AllowRetrySupplyChange, AutoPicked, ReqModeContinue, AllowResumeAfterCrash,
        AllowShellSweeper, AllowPostSweepStart, AllowSupplyOnForbiddenStep, StartsSupplied,
        AllowUndeclaredSupplyOutcome, IgnoreSupplyNever, IgnoreMissingSupplyNote,
        RepickSuppliedOnRetry, SkipGr1CutBack, SkipParentEndCancel, SkipImmediateRefusalCleanup,
        SweeperSkipsNewLockOrRecheck, StrayNotice, CarryNoticeByTime, CutVisitCopied, CarryComparesCopyTime,
        SourceEndRace, AllowCleanupCrash, RetryAfterCut, TakeIgnoresTaken, NoNewMessage} \subseteq BOOLEAN
ASSUME EndClock \in {"begin", "locked"}
ASSUME (StrayNotice \/ CutVisitCopied \/ SourceEndRace) => SourceKind = "inbox"
ASSUME CutVisitCopied => (Generations = 2 /\ ~StrayNotice)
ASSUME SourceEndRace => (Generations = 1 /\ ~StrayNotice)

-----------------------------------------------------------------------------
(* Node universe and static source run definition                          *)

NoNode == <<"none", 0>>
SNode(i) == <<"S", i>>
ANode == <<"A", 1>>
PNode == <<"P", 1>>
LNode == <<"L", 1>>       \* Unwalked lane visit inside P (scope "P#0")
SPNode == <<"SP", 1>>     \* Top-level spawn step whose child was cancelled by #2's end
LSPNode == <<"LSP", 1>>   \* Lane spawn step inside P whose child was cancelled by #2's end
RNode(i) == <<"R", i>>
HNode(i) == <<"H", i>>
TNode == <<"T", 1>>

TopNodes == {SNode(1), SNode(2), SNode(3), ANode, PNode, SPNode, RNode(1), RNode(2), HNode(1), HNode(2), TNode}
LaneNodes == {LNode, LSPNode}
AllNodes == TopNodes \cup LaneNodes
WorkNodes == AllNodes \ {TNode}

DeclaredOutcomes == {"ok", "again"}

NodeKindOf(x) ==
    CASE x[1] = "S"   -> "script_or_agent"
      [] x[1] = "H"   -> "script_or_agent"
      [] x = ANode    -> "approval"
      [] x = PNode    -> "parallel"
      [] x = SPNode   -> "spawn"
      [] x = LNode    -> "lane"
      [] x = LSPNode  -> "lane_spawn"
      [] x[1] = "R"   -> "receive"
      [] x = TNode    -> "terminal"
      [] OTHER        -> "unknown"

\* G-R1: whether a visit in #2 is a spawn (top-level or parallel lane) whose child was cancelled by #2's end or lacks a notice
IsCancelledOrNoticelessSpawn(x) ==
    (SourceKind = "spawn" /\ x = SPNode) \/ (SourceKind = "spawn_lane" /\ x = LSPNode)

\* G-R1 lift helper: top-level spawn maps to itself; lane spawn lifts to enclosing PNode.
EnclosingTopOf(x) ==
    IF x = LSPNode THEN PNode ELSE x

\* G-R1 cut-back applies ONLY when execution_id is omitted AND caller did NOT explicitly ask for mode="continue" (§5.5/§6.2/R2-N3).
Gr1Applies == AutoPicked /\ ~ReqModeContinue /\ ~SkipGr1CutBack

\* Candidate pre-cut chain before G-R1 scan (used for spawn / spawn_lane)
CandSpawnTop ==
    CASE SourceKind = "spawn"      -> <<SNode(1), SPNode>>
      [] SourceKind = "spawn_lane" -> <<SNode(1), PNode>>
      [] OTHER                     -> <<>>

CandSpawnLanes ==
    IF SourceKind = "spawn_lane" THEN {LSPNode} ELSE {}

CandSpawnAll == {CandSpawnTop[i] : i \in 1..Len(CandSpawnTop)} \cup CandSpawnLanes

\* Scan candidate top + lane visits for cancelled/noticeless spawns, lift to enclosing top-level node, and pick earliest index.
Gr1BadTopIndices ==
    {i \in 1..Len(CandSpawnTop) :
        \E x \in CandSpawnAll : IsCancelledOrNoticelessSpawn(x) /\ EnclosingTopOf(x) = CandSpawnTop[i]}

Gr1EarliestIdx ==
    IF Gr1Applies /\ Gr1BadTopIndices # {}
      THEN CHOOSE i \in Gr1BadTopIndices : \A j \in Gr1BadTopIndices : i <= j
      ELSE 0

Gr1Active == (Gr1EarliestIdx > 0)

\* Generated inbox of source #2 (Task 6a-TLA+). Abstract instants: 1 = before the cut, 2 = exactly at the cut (CutTime),
\* 3 = after the cut, 4 = later. A message has a shape [accept, expire, reader] with expire > accept: accept is the time it
\* was first accepted, as a place in the history the cut is taken in (accepted_at of a row accepted into #2), expire is
\* expires_at (CutTime = expires exactly at the cut), reader is the #2 visit that consumed it (consumed_by): NoNode
\* (unread), KeptReader (#2's receive R1, which the inbox re-run reuses) or DroppedReader (a #2 visit the re-run drops,
\* such as #2's receive R2 at the cut, which the re-run runs again). SourceKind "inbox" enumerates every shape of two
\* ordinary messages (m1, m2) and of the reused spawn's WorkflowEnded@1 notice (m_child): 12^3 = 1,728 inboxes. With
\* StrayNotice (review I-INBOX), m2 is replaced by m_stray, the WorkflowEnded@1 notice of a child whose spawn #3 does not
\* reuse: again 12^3 = 1,728 inboxes. SourceKind "spawn" keeps one fixed waiting message; every other kind has an empty inbox.
\*
\* Review RR-1 (CutVisitCopied, Generations = 2): #2 is itself a re-run of #1, and #3's cut is a visit #2 copied from #1, so
\* the cut is that visit's #1 entry time (CutTime). Every row of #2's inbox was carried from #1 when #2 was admitted
\* (CopyTime, after all of #1): its stored accepted_at is CopyTime, its expiry restarted after it, and origin_accepted_at
\* keeps accept. Such a message was unexpired at #2's own cut, which is later than CutTime, and no visit that #2 copied
\* read it, so its shapes are expire = 4 and reader NoNode or DroppedReader: 6^3 = 216 inboxes.
\*
\* Review MSG-1 (SourceEndRace): #3 cuts at #2's end, and #2's inbox is the one message m_late whose acceptance races #2's
\* end (SourceEndRaceStep). Its stored accepted_at is accAt, the cut is #2's finished_at (srcEndAt), and its shape is fixed.
CutTime == 2
CopyTime == 5
MsgTimes == {1, 2, 3}
ExpireTimes == {CutTime, 4}
KeptReader == RNode(1)
DroppedReader == RNode(2)
Readers == {NoNode, KeptReader, DroppedReader}
MsgShapes == {s \in [accept: MsgTimes, expire: ExpireTimes, reader: Readers] : s.expire > s.accept}
SrcCarried == Generations = 2 /\ CutVisitCopied
CarriedShapes == [accept: MsgTimes, expire: {4}, reader: {NoNode, DroppedReader}]
OrdMsgs ==
    IF SourceKind = "inbox"
      THEN IF SourceEndRace THEN {"m_late"} ELSE IF StrayNotice THEN {"m1"} ELSE {"m1", "m2"}
      ELSE IF SourceKind = "spawn" THEN {"m1"} ELSE {}
ReusedNoticeMsgs == IF SourceKind = "inbox" /\ ~SourceEndRace THEN {"m_child"} ELSE {}
StrayNoticeMsgs == IF StrayNotice THEN {"m_stray"} ELSE {}
NoticeMsgs == ReusedNoticeMsgs \cup StrayNoticeMsgs
InboxMsgs == OrdMsgs \cup NoticeMsgs
FixedWaiting == [accept |-> 1, expire |-> 4, reader |-> NoNode]
SrcInboxProfiles ==
    IF SourceKind # "inbox" \/ SourceEndRace THEN {[m \in InboxMsgs |-> FixedWaiting]}
    ELSE IF SrcCarried THEN [InboxMsgs -> CarriedShapes]
    ELSE [InboxMsgs -> MsgShapes]

Active == {"admitted", "running", "paused"}
Terminal == {"completed", "failed", "cancelled", "stopped"}
Refused == {
    "refused_source_gone",
    "refused_owner_ended",
    "refused_incompatible",
    "refused_approval",
    "refused_supply_not_allowed",
    "refused_supplied_invalid",
    "refused_conflict",
    "refused_workflow_deleted"
}

\* Chosen visit V' in supply mode
ChosenSupplyNode ==
    CASE Mode # "supply"           -> NoNode
      [] SourceKind = "supply_first" -> SNode(1)
      [] SourceKind = "loop"       -> SNode(2)
      [] SourceKind = "approval"   -> ANode
      [] OTHER                     -> SNode(2)

ExpectedSupplied == IF Mode = "supply" /\ ChosenSupplyNode # NoNode THEN {ChosenSupplyNode} ELSE {}

\* Source reused top-level chain
SrcReusedTop ==
    CASE SourceKind = "supply_first"                       -> <<>>
      [] SourceKind = "approval" /\ Mode = "supply"        -> <<>>
      [] SourceKind = "loop" /\ Mode = "run_again"         -> <<SNode(1)>>
      [] SourceKind = "loop" /\ Mode = "supply"            -> <<SNode(1)>>
      [] SourceKind = "loop" /\ Mode = "continue"          -> <<SNode(1), SNode(2)>>
      [] SourceKind = "catchall"                           -> <<SNode(1), HNode(1)>>
      [] SourceKind = "parallel"                           -> <<PNode>>
      [] SourceKind = "approval"                           -> <<ANode>>
      [] SourceKind = "inbox"                              -> <<RNode(1)>>
      [] SourceKind = "spawn"                              -> IF Gr1Active THEN SubSeq(CandSpawnTop, 1, Gr1EarliestIdx - 1) ELSE CandSpawnTop
      [] SourceKind = "spawn_lane"                         -> IF Gr1Active THEN SubSeq(CandSpawnTop, 1, Gr1EarliestIdx - 1) ELSE CandSpawnTop

SrcReusedLanes ==
    CASE SourceKind = "parallel"                  -> {LNode}
      [] SourceKind = "spawn_lane" /\ ~Gr1Active  -> {LSPNode}
      [] OTHER                                    -> {}

ExpectedReused == {SrcReusedTop[i] : i \in 1..Len(SrcReusedTop)} \cup SrcReusedLanes
UnwalkedCount == Cardinality(SrcReusedLanes)
HasApproval == ANode \in ExpectedReused

InitSrcOutcome(x) ==
    CASE SourceKind = "loop" /\ x = SNode(1)        -> "again"
      [] SourceKind = "loop" /\ x = SNode(2)        -> "again"
      [] SourceKind = "supply_first" /\ x = SNode(1) -> "error"
      [] SourceKind = "catchall" /\ x = SNode(1)    -> "error"
      [] SourceKind = "catchall" /\ x = HNode(1)    -> "ok"
      [] SourceKind = "parallel" /\ x = PNode       -> "ok"
      [] SourceKind = "parallel" /\ x = LNode       -> "ok"
      [] SourceKind = "approval" /\ x = ANode       -> "approved"
      [] SourceKind = "inbox" /\ x = RNode(1)       -> "again"
      [] SourceKind = "spawn" /\ x = SNode(1)       -> "again"
      [] SourceKind = "spawn" /\ x = SPNode         -> "started"
      [] SourceKind = "spawn_lane" /\ x = SNode(1)  -> "again"
      [] SourceKind = "spawn_lane" /\ x = PNode     -> "ok"
      [] SourceKind = "spawn_lane" /\ x = LSPNode   -> "started"
      [] OTHER -> "none"

InitSrcKind(x) ==
    CASE InitSrcOutcome(x) = "error" -> "runtime_error"
      [] InitSrcOutcome(x) = "none"  -> "none"
      [] OTHER -> "business"

\* Recorded predecessor and arrival route of each copied or supplied source visit
SrcPred(x) ==
    CASE SourceKind = "loop" /\ Mode \in {"continue", "supply"} /\ x = SNode(2) -> SNode(1)
      [] SourceKind = "catchall" /\ x = HNode(1)                                -> SNode(1)
      [] SourceKind = "parallel" /\ x = LNode                                   -> PNode
      [] SourceKind = "spawn" /\ x = SPNode                                     -> SNode(1)
      [] SourceKind = "spawn_lane" /\ x = PNode                                 -> SNode(1)
      [] SourceKind = "spawn_lane" /\ x = LSPNode                               -> PNode
      [] OTHER -> NoNode

SrcRoute(x) ==
    CASE SourceKind = "loop" /\ Mode \in {"continue", "supply"} /\ x = SNode(2) -> "again"
      [] SourceKind = "catchall" /\ x = HNode(1)                                -> "catchAll"
      [] SourceKind = "parallel" /\ x = LNode                                   -> "branch"
      [] SourceKind = "spawn" /\ x = SPNode                                     -> "again"
      [] SourceKind = "spawn_lane" /\ x = PNode                                 -> "again"
      [] SourceKind = "spawn_lane" /\ x = LSPNode                               -> "branch"
      [] OTHER -> "initial"

InitSrcNodes == [x \in AllNodes |-> [outcome |-> InitSrcOutcome(x), kind |-> InitSrcKind(x)]]

\* Origin flattening model: in gen 1, source #2's own rows have reused_from = "none" (ran in wf2);
\* in gen 2, source #2's rows already carry reused_from = "wf1" (originally ran in wf1).
SrcReusedFrom(x) == IF Generations = 2 /\ x \in ExpectedReused THEN "wf1" ELSE "none"
ActualOrigin(x) == IF SrcReusedFrom(x) # "none" THEN SrcReusedFrom(x) ELSE "wf2"

InitialStep ==
    CASE SourceKind = "parallel" -> PNode
      [] SourceKind = "approval" -> ANode
      [] SourceKind = "inbox"    -> RNode(1)
      [] OTHER -> SNode(1)

ExpectedCutNode ==
    CASE Mode = "supply" /\ SourceKind = "supply_first" /\ SuppliedOutcome = "again" -> SNode(2)
      [] Mode = "supply" /\ SourceKind = "supply_first" /\ SuppliedOutcome = "ok"    -> TNode
      [] Mode = "supply" /\ SourceKind = "loop" /\ SuppliedOutcome = "again"         -> SNode(3)
      [] Mode = "supply" /\ SourceKind = "loop" /\ SuppliedOutcome = "ok"            -> TNode
      [] Mode = "supply"                                                             -> TNode
      [] SourceKind = "loop" /\ Mode = "run_again"                                   -> SNode(2)
      [] SourceKind = "loop" /\ Mode = "continue"                                    -> SNode(3)
      [] SourceKind = "catchall"                                                     -> SNode(2)
      [] SourceKind = "parallel"                                                     -> SNode(1)
      [] SourceKind = "approval"                                                     -> SNode(1)
      [] SourceKind = "inbox"                                                        -> RNode(2)
      [] SourceKind = "spawn" /\ Gr1Active                                           -> SPNode
      [] SourceKind = "spawn" /\ ~Gr1Active                                          -> SNode(2)
      [] SourceKind = "spawn_lane" /\ Gr1Active                                      -> PNode
      [] SourceKind = "spawn_lane" /\ ~Gr1Active                                     -> SNode(2)

ExpectedCutRoute ==
    CASE Mode = "supply"                           -> SuppliedOutcome
      [] SourceKind = "loop" /\ Mode = "run_again" -> "again"
      [] SourceKind = "catchall"                   -> "ok"
      [] SourceKind = "parallel"                   -> "ok"
      [] SourceKind = "approval"                   -> "approved"
      [] SourceKind = "inbox"                      -> "again"
      [] SourceKind = "spawn" /\ Gr1Active         -> "again"
      [] SourceKind = "spawn" /\ ~Gr1Active        -> "started"
      [] SourceKind = "spawn_lane" /\ Gr1Active    -> "again"
      [] SourceKind = "spawn_lane" /\ ~Gr1Active   -> "ok"
      [] OTHER -> "none"

LastReusedTop == IF Len(SrcReusedTop) > 0 THEN SrcReusedTop[Len(SrcReusedTop)] ELSE NoNode
SameIr == (Target = "same")
CutKvRev == 1
RunKvRev == IF StartVars THEN CutKvRev + 1 ELSE CutKvRev

\* Target routing:
\*   - reroute_taken: S1 "again" routes to TNode (misses S2 in both run_again and continue)
\*   - reroute_supply: ChosenSupplyNode SuppliedOutcome routes to TNode instead of SNode(3)/SNode(2)
\*   - reroute_onto_copy:
\*       * SourceKind="catchall": T adds explicit "error" failure route from S1 to H1, so controller arrives
\*         at existing copied H1 with route "error" != recorded "catchAll" (100% reachable S1 controller race).
\*       * SourceKind="loop": S1 "again" routes back onto S1 (predecessor mismatch on copied row).
RouteTarget(x, o, caught, h1Present) ==
    IF Target = "reroute_taken" /\ x = SNode(1) /\ o = "again"
      THEN TNode
    ELSE IF Target = "reroute_supply" /\ Mode = "supply" /\ x = ChosenSupplyNode /\ o = SuppliedOutcome
      THEN TNode
    ELSE IF Target = "reroute_onto_copy" /\ SourceKind = "loop" /\ x = SNode(1) /\ o = "again"
      THEN SNode(1)
    ELSE IF SourceKind = "spawn" /\ x = SNode(1) /\ o = "again"
      THEN SPNode
    ELSE IF SourceKind = "spawn_lane" /\ x = SNode(1) /\ o = "again"
      THEN PNode
    ELSE CASE x[1] = "S" /\ o = "again"     -> IF x[2] < 3 THEN SNode(x[2] + 1) ELSE TNode
           [] x[1] = "S" /\ o = "ok"        -> TNode
           [] x[1] = "S" /\ o = "exhausted" -> TNode
           [] x[1] = "S" /\ o = "error"     -> IF ~caught
                                                 THEN (IF h1Present /\ x = SNode(2) THEN HNode(2) ELSE HNode(1))
                                                 ELSE NoNode
           [] x[1] = "H" /\ o = "ok"        -> IF SourceKind = "catchall" THEN SNode(2) ELSE TNode
           [] x[1] = "H" /\ o = "error"     -> NoNode
           [] x[1] = "P" /\ o = "ok"        -> IF SourceKind = "spawn_lane" THEN SNode(2) ELSE SNode(1)
           [] x[1] = "SP" /\ o = "started"  -> SNode(2)
           [] x[1] = "A" /\ o = "approved"  -> SNode(1)
           [] x[1] = "R" /\ o = "again"     -> RNode(x[2] + 1)
           [] x[1] = "R" /\ o = "msg"       -> TNode
           [] OTHER -> NoNode

RouteLabelOf(x, o, caught) ==
    IF Target = "reroute_onto_copy" /\ SourceKind = "catchall" /\ x = SNode(1) /\ o = "error"
      THEN "error"
    ELSE IF x[1] = "S" /\ o = "error" /\ ~caught THEN "catchAll" ELSE o

NewWorkOutcomes(x) ==
    CASE x = SNode(3) -> {"ok"}
      [] x[1] = "S" -> IF SourceKind = "catchall" THEN {"error", "ok"}
                       ELSE IF SourceKind = "parallel" THEN {"ok", "again"}
                       ELSE IF SourceKind \in {"approval", "spawn", "spawn_lane"} THEN {"ok"}
                       ELSE IF Mode = "supply" THEN {"ok"}
                       ELSE {"again", "ok", "error"}
      [] x[1] = "H"  -> {"ok"}
      [] x[1] = "R"  -> IF NoNewMessage THEN {"elapsed"} ELSE {"msg"}
      [] x = SPNode  -> {"started"}
      [] x = PNode   -> {"ok"}
      [] OTHER -> {"ok"}

MaxReusedOrd(st) ==
    LET ords == {x[2] : x \in {y \in ExpectedReused : y[1] = st}}
    IN IF ords = {} THEN 0 ELSE CHOOSE m \in ords : \A o \in ords : m >= o

-----------------------------------------------------------------------------
VARIABLES
    \* Session & lock state (owner, def, source #2, new #3)
    ownerLive,          \* owner session live
    srcLive,            \* source workflow #2 live
    srcNodes,           \* source #2 visit rows (must remain untouched)
    deleterWaitedOnCopy,\* witness tracker: deleter observed srcLock="copy_share" while ready
    srcDeletedAfterCopy,\* witness tracker: deleter deleted #2 after #3 committed
    latestRev,          \* latest saved definition revision (1, incremented to 2 on save)
    ownerLock,          \* "free" | "copy_share" | "owner_ended_excl"
    defLock,            \* "free" | "copy_share" | "owner_ended_excl"
    srcLock,            \* "free" | "copy_share" | "sweeper_excl" | "delwf_excl" | "owner_ended_excl"
    newLock,            \* "free" | "copy_excl" | "owner_ended_excl"

    \* Start & claim state (3A's exact startPhase values; zero invented phases)
    startPhase,         \* "idle" | "claimed" | "crashed" | "lock_step1" | "lock_src" | "lock_step2" | "partial_run" | "admitted" | Refused
    rerunPin,           \* [rev |-> 0..2, mode |-> "none" | Mode, supplied |-> [outcome |-> Outcomes, payloadVer |-> 0..2]]
    admittedRev,        \* 0 | 1 | 2
    admittedSupplied,   \* [outcome |-> Outcomes, payloadVer |-> 0..2]
    retrySupplyVer,     \* 1 | 2 (2 when retry mutates supplied payload under same operationId)
    copySawSrcLive,     \* used only by NoSourceLock fault
    copiedFromLive,     \* whether srcLive was TRUE when Copy committed
    pinnedResumed,      \* witness tracker: Start resumed from claim crash

    \* Claim shell & Sweeper bare-shell race state (R2-M1, 10:24 PST, S6)
    claimShellState,      \* "none" | "live_unadmitted" | "admitted" | "soft_deleted"
    sessionVersion,       \* 0 | 1 (claimed) | 2 (admitted) — models sessions row xmin/version
    sweeperSnapVersion,   \* 0 (none) | 1..2 (version snapshotted by SweeperReadBareShell before locking newLock)
    claimGraceElapsed,    \* TRUE once sessions.updated_at age exceeds grace (can fire in any pre-admission phase)
    everSweptShell,       \* witness tracker: Sweeper collected a stale bare claim shell (without OwnerEnd)
    ownerEndedNew,        \* TRUE if OwnerEnd soft-deleted an admitted #3
    freshStartAfterSweep, \* bounds fresh Start (new key/opId) after sweep to at most 1
    refusalCleanup,       \* RR-4: "none" | "owed" (a refusal rolled back; its cleanup transaction has not run) | "done" | "lost"

    \* Re-run #3 store state
    runStatus,          \* "none" | Active | Terminal
    failCode,           \* "none" | "rerun_diverged" | "unhandled_error" | "limit_exceeded"
    nState,             \* [AllNodes -> "absent" | "pending" | "completed"]
    nPred,              \* [AllNodes -> AllNodes \cup {NoNode}]
    nRoute,             \* [AllNodes -> Routes]
    nWinner,            \* [AllNodes -> "none" | "reused" | "supplied" | "effect" | "cancel" | "controller" | "delete"]
    nOutcome,           \* [AllNodes -> Outcomes]
    nResultKind,        \* [AllNodes -> "none" | "business" | "runtime_error"]
    nOrigin,            \* [AllNodes -> "none" | "wf1" | "wf2" | "wf3"]
    nDeadline,          \* [AllNodes -> "none" | "source" | "new"]
    reusedSet,          \* subset of AllNodes that are reused copies
    suppliedSet,        \* subset of AllNodes that are supplied visits (V')
    newVisits,          \* subset of AllNodes admitted fresh (not reused, not supplied)
    resumedAtCut,       \* rerun_resumed_at IS NOT NULL
    firstNew,           \* first non-reused, non-supplied node admitted
    firstNewPred,       \* predecessor of first new node
    firstNewRoute,      \* arrival route of first new node
    firstNewHashOk,     \* whether first new admission satisfied same-IR byte check
    copyHitMismatch,    \* whether pass-over silently accepted a copied row with mismatched predecessor/route
    downstreamReadSupplied, \* witness tracker: downstream step read supplied output
    events,             \* event counters for Inv_EventsOnce

    \* Source #2 inbox (fixed per behavior, chosen in Init) and carried inbox state for #3
    srcInbox,              \* [InboxMsgs -> MsgShapes]: #2's inbox rows (never written)
    carriedInbox,          \* subset of InboxMsgs copied into #3
    unexpiredCarriedInbox, \* carried messages not yet consumed or expired by TTL
    inboxTaken,            \* [InboxMsgs -> 0..2]

    \* #2's end racing an acceptance into #2 (MSG-1, SourceEndRace; constant "done"/"idle" otherwise)
    srcClk,                \* the store's clock while #2 is active: 0..3
    endPc,                 \* #2's end transaction: "idle" | "begun" (its now() is fixed) | "done" (#2 ended)
    endTxStart,            \* now() of #2's end transaction (the clock when it began)
    srcEndAt,              \* #2's stored finished_at
    accPc,                 \* acceptance of m_late into #2: "idle" | "locked" (holds #2's session lock) | "done"
    accAt,                 \* m_late's stored accepted_at (the clock read after the acceptance's locks)

    \* Controller state (1.3.0) for #3
    pc,                 \* "idle" | "begin" | "poll" | "admit" | "start" | "collect" | "wait" | "finish" | "finishFail" | "cancel" | "done"
    curNode,            \* current cursor node in TopNodes \cup {NoNode}
    curPred,            \* predecessor of current cursor
    curRoute,           \* arrival route of current cursor
    curPending,         \* currently pending node in TopNodes \cup {NoNode}
    curCaught,          \* controller catchAllEntered flag
    curSteps,           \* controller walked steps counter
    planMaxSteps,       \* maxNodeExecutions returned by plan activity
    actRes,             \* result of latest activity Exec before Record
    retriedInPassOver,  \* witness tracker
    canInPassOver,      \* witness tracker

    \* Effects, agent sessions, spawn children & commands
    eff,                 \* [WorkNodes -> "absent" | "started" | "done"]
    agentSession,        \* [WorkNodes -> "absent" | "live" | "ended"]
    oldChildStatus,      \* "absent" | "active" | "cancelling" | "cancelled" (#2's dropped/cancelled spawn child, G-R2)
    newSpawnChildStatus, \* "absent" | "active" | "completed" | "cancelled" (#3's new spawn child)
    q,                   \* controller command queue ("cancel")
    pauseUsed,           \* bound pause/resume to 1
    stopRequested,       \* stop requested flag
    cancelSent,          \* cancel sent flag

    \* Deleter state machines
    sweeperPc,          \* "idle" | "locked_target" | "done" | "busy"
    delWfPc,            \* "idle" | "locked_src" | "done"
    ownerEndPc          \* "idle" | "locked_owner" | "locked_def" | "done"

lockVars == <<ownerLock, defLock, srcLock, newLock>>
sessionVars == <<ownerLive, srcLive, srcNodes, deleterWaitedOnCopy, srcDeletedAfterCopy, latestRev>>
startVars == <<startPhase, rerunPin, admittedRev, admittedSupplied, retrySupplyVer, copySawSrcLive, copiedFromLive, pinnedResumed>>
shellVars == <<claimShellState, sessionVersion, sweeperSnapVersion, claimGraceElapsed, everSweptShell, ownerEndedNew, freshStartAfterSweep,
               refusalCleanup>>
runVars == <<runStatus, failCode, nState, nPred, nRoute, nWinner, nOutcome, nResultKind, nOrigin, nDeadline,
             reusedSet, suppliedSet, newVisits, resumedAtCut, firstNew, firstNewPred, firstNewRoute, firstNewHashOk,
             copyHitMismatch, downstreamReadSupplied, events>>
raceVars == <<srcClk, endPc, endTxStart, srcEndAt, accPc, accAt>>
inboxVars == <<srcInbox, carriedInbox, unexpiredCarriedInbox, inboxTaken, raceVars>>
ctrlVars == <<pc, curNode, curPred, curRoute, curPending, curCaught, curSteps, planMaxSteps, actRes,
              retriedInPassOver, canInPassOver>>
effCmdVars == <<eff, agentSession, oldChildStatus, newSpawnChildStatus, q, pauseUsed, stopRequested, cancelSent>>
delVars == <<sweeperPc, delWfPc, ownerEndPc>>
vars == <<lockVars, sessionVars, startVars, shellVars, runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

-----------------------------------------------------------------------------
(* Type invariant                                                          *)

Outcomes == {"none", "again", "ok", "error", "approved", "msg", "elapsed", "exhausted", "cancelled", "succeeded", "started", "undeclared"}
Routes == {"none", "initial", "again", "ok", "error", "approved", "msg", "exhausted", "catchAll", "branch", "started", "undeclared"}
SuppliedPinDomain == [outcome: Outcomes, payloadVer: 0..2]

TypeOK ==
    /\ ownerLive \in BOOLEAN /\ srcLive \in BOOLEAN
    /\ deleterWaitedOnCopy \in BOOLEAN /\ srcDeletedAfterCopy \in BOOLEAN
    /\ srcNodes \in [AllNodes -> [outcome: Outcomes, kind: {"none", "business", "runtime_error"}]]
    /\ latestRev \in 1..2
    /\ ownerLock \in {"free", "copy_share", "owner_ended_excl"}
    /\ defLock \in {"free", "copy_share", "owner_ended_excl"}
    /\ srcLock \in {"free", "copy_share", "sweeper_excl", "delwf_excl", "owner_ended_excl"}
    /\ newLock \in {"free", "copy_excl", "owner_ended_excl"}
    /\ startPhase \in {"idle", "claimed", "crashed", "lock_step1", "lock_src", "lock_step2", "partial_run", "admitted"} \cup Refused
    /\ rerunPin \in [rev: 0..2, mode: {"none", "run_again", "continue", "supply"}, supplied: SuppliedPinDomain]
    /\ admittedRev \in 0..2
    /\ admittedSupplied \in SuppliedPinDomain
    /\ retrySupplyVer \in 1..2
    /\ copySawSrcLive \in BOOLEAN /\ copiedFromLive \in BOOLEAN /\ pinnedResumed \in BOOLEAN
    /\ claimShellState \in {"none", "live_unadmitted", "admitted", "soft_deleted"}
    /\ sessionVersion \in 0..2 /\ sweeperSnapVersion \in 0..2
    /\ claimGraceElapsed \in BOOLEAN
    /\ everSweptShell \in BOOLEAN /\ ownerEndedNew \in BOOLEAN /\ freshStartAfterSweep \in BOOLEAN
    /\ refusalCleanup \in {"none", "owed", "done", "lost"}
    /\ runStatus \in {"none"} \cup Active \cup Terminal
    /\ failCode \in {"none", "rerun_diverged", "unhandled_error", "limit_exceeded"}
    /\ nState \in [AllNodes -> {"absent", "pending", "completed"}]
    /\ nPred \in [AllNodes -> AllNodes \cup {NoNode}]
    /\ nRoute \in [AllNodes -> Routes]
    /\ nWinner \in [AllNodes -> {"none", "reused", "supplied", "effect", "timer", "cancel", "controller", "delete"}]
    /\ nOutcome \in [AllNodes -> Outcomes]
    /\ nResultKind \in [AllNodes -> {"none", "business", "runtime_error"}]
    /\ nOrigin \in [AllNodes -> {"none", "wf1", "wf2", "wf3"}]
    /\ nDeadline \in [AllNodes -> {"none", "source", "new"}]
    /\ reusedSet \subseteq AllNodes /\ suppliedSet \subseteq AllNodes /\ newVisits \subseteq AllNodes
    /\ resumedAtCut \in BOOLEAN
    /\ firstNew \in AllNodes \cup {NoNode}
    /\ firstNewPred \in AllNodes \cup {NoNode}
    /\ firstNewRoute \in Routes
    /\ firstNewHashOk \in BOOLEAN
    /\ copyHitMismatch \in BOOLEAN
    /\ downstreamReadSupplied \in BOOLEAN
    /\ events.started \in 0..2 /\ events.ended \in 0..2
    /\ events.stateStarted \in [AllNodes -> 0..2]
    /\ events.stateCompleted \in [AllNodes -> 0..2]
    /\ srcInbox \in SrcInboxProfiles
    /\ carriedInbox \subseteq InboxMsgs
    /\ unexpiredCarriedInbox \subseteq InboxMsgs
    /\ inboxTaken \in [InboxMsgs -> 0..2]
    /\ srcClk \in 0..3 /\ endTxStart \in 0..3 /\ srcEndAt \in 0..3 /\ accAt \in 0..3
    /\ endPc \in {"idle", "begun", "done"} /\ accPc \in {"idle", "locked", "done"}
    /\ pc \in {"idle", "begin", "poll", "admit", "start", "collect", "wait", "finish", "finishFail", "cancel", "done"}
    /\ curNode \in TopNodes \cup {NoNode}
    /\ curPred \in TopNodes \cup {NoNode}
    /\ curRoute \in Routes
    /\ curPending \in TopNodes \cup {NoNode}
    /\ curCaught \in BOOLEAN
    /\ curSteps \in 0..(StepLimit + 2)
    /\ planMaxSteps \in 0..(StepLimit + 2)
    /\ actRes \in {"none", "pending", "completed", "paused", "notAdmitted", "nothing", "ended"} \cup Outcomes
    /\ retriedInPassOver \in BOOLEAN /\ canInPassOver \in BOOLEAN
    /\ eff \in [WorkNodes -> {"absent", "started", "done"}]
    /\ agentSession \in [WorkNodes -> {"absent", "live", "ended"}]
    /\ oldChildStatus \in {"absent", "active", "cancelling", "cancelled"}
    /\ newSpawnChildStatus \in {"absent", "active", "completed", "cancelled"}
    /\ q \in Seq({"cancel"})
    /\ pauseUsed \in BOOLEAN /\ stopRequested \in BOOLEAN /\ cancelSent \in BOOLEAN
    /\ sweeperPc \in {"idle", "locked_target", "done", "busy"}
    /\ delWfPc \in {"idle", "locked_src", "done"}
    /\ ownerEndPc \in {"idle", "locked_owner", "locked_def", "done"}

-----------------------------------------------------------------------------
(* Initial state                                                           *)

EmptySuppliedPin == [outcome |-> "none", payloadVer |-> 0]

Init ==
    /\ ownerLive = TRUE
    /\ srcLive = TRUE
    /\ srcNodes = InitSrcNodes
    /\ deleterWaitedOnCopy = FALSE
    /\ srcDeletedAfterCopy = FALSE
    /\ latestRev = 1
    /\ ownerLock = "free" /\ defLock = "free" /\ srcLock = "free" /\ newLock = "free"
    /\ startPhase = "idle"
    /\ rerunPin = [rev |-> 0, mode |-> "none", supplied |-> EmptySuppliedPin]
    /\ admittedRev = 0
    /\ admittedSupplied = EmptySuppliedPin
    /\ retrySupplyVer = 1
    /\ copySawSrcLive = FALSE
    /\ copiedFromLive = FALSE
    /\ pinnedResumed = FALSE
    /\ claimShellState = "none"
    /\ sessionVersion = 0
    /\ sweeperSnapVersion = 0
    /\ claimGraceElapsed = FALSE
    /\ everSweptShell = FALSE
    /\ ownerEndedNew = FALSE
    /\ freshStartAfterSweep = FALSE
    /\ refusalCleanup = "none"
    /\ runStatus = "none"
    /\ failCode = "none"
    /\ nState = [x \in AllNodes |-> "absent"]
    /\ nPred = [x \in AllNodes |-> NoNode]
    /\ nRoute = [x \in AllNodes |-> "none"]
    /\ nWinner = [x \in AllNodes |-> "none"]
    /\ nOutcome = [x \in AllNodes |-> "none"]
    /\ nResultKind = [x \in AllNodes |-> "none"]
    /\ nOrigin = [x \in AllNodes |-> "none"]
    /\ nDeadline = [x \in AllNodes |-> "none"]
    /\ reusedSet = {}
    /\ suppliedSet = {}
    /\ newVisits = {}
    /\ resumedAtCut = FALSE
    /\ firstNew = NoNode
    /\ firstNewPred = NoNode
    /\ firstNewRoute = "none"
    /\ firstNewHashOk = TRUE
    /\ copyHitMismatch = FALSE
    /\ downstreamReadSupplied = FALSE
    /\ events = [started |-> 0, ended |-> 0,
                 stateStarted |-> [x \in AllNodes |-> 0],
                 stateCompleted |-> [x \in AllNodes |-> 0]]
    /\ srcInbox \in SrcInboxProfiles
    /\ carriedInbox = {}
    /\ unexpiredCarriedInbox = {}
    /\ inboxTaken = [m \in InboxMsgs |-> 0]
    /\ srcClk = 0 /\ endTxStart = 0 /\ srcEndAt = 0 /\ accAt = 0
    /\ endPc = IF SourceEndRace THEN "idle" ELSE "done"
    /\ accPc = "idle"
    /\ pc = "idle"
    /\ curNode = InitialStep
    /\ curPred = NoNode
    /\ curRoute = "initial"
    /\ curPending = NoNode
    /\ curCaught = FALSE
    /\ curSteps = 0
    /\ planMaxSteps = StepLimit
    /\ actRes = "none"
    /\ retriedInPassOver = FALSE
    /\ canInPassOver = FALSE
    /\ eff = [x \in WorkNodes |-> "absent"]
    /\ agentSession = [x \in WorkNodes |-> "absent"]
    /\ oldChildStatus = IF SourceKind \in {"spawn", "spawn_lane"} THEN "active" ELSE "absent"
    /\ newSpawnChildStatus = "absent"
    /\ q = <<>>
    /\ pauseUsed = FALSE
    /\ stopRequested = FALSE
    /\ cancelSent = FALSE
    /\ sweeperPc = "idle"
    /\ delWfPc = "idle"
    /\ ownerEndPc = "idle"

-----------------------------------------------------------------------------
(* Helpers                                                                 *)

EndPendingNodes(winner) ==
    /\ nState' = [x \in AllNodes |-> IF nState[x] = "pending" THEN "completed" ELSE nState[x]]
    /\ nWinner' = [x \in AllNodes |-> IF nState[x] = "pending" THEN winner ELSE nWinner[x]]
    /\ nOutcome' = [x \in AllNodes |-> IF nState[x] = "pending" THEN "cancelled" ELSE nOutcome[x]]
    /\ nResultKind' = [x \in AllNodes |-> IF nState[x] = "pending" THEN "runtime_error" ELSE nResultKind[x]]

\* COALESCE(s.reused_from_execution_id, s.node_execution_id) flattening across generations
CopyOriginOf(x) ==
    IF FlatOrigin
      THEN IF SrcReusedFrom(x) # "none" THEN SrcReusedFrom(x) ELSE "wf2"
      ELSE "wf2"

CopyDeadlineOf(x) ==
    IF CopyKeepsDeadline /\ x = RNode(1) THEN "source" ELSE "none"

\* Design §5.4 (owner ruling, 27 Nov 22:35 PST): the #2 messages that no #2 visit read and that a fresh run started at the
\* cut would still see, read from the history the cut is taken in (a message's first acceptance and its expiry; never #2's
\* stored copy times). An unread ordinary message accepted at or before the cut and unexpired at it (accept <= CutTime <
\* expire), or an unread WorkflowEnded@1 notice of a reused spawn child whatever its times, but never the notice of a child
\* whose spawn #3 does not reuse (review I-INBOX). A message any visit read (kept, supplied or dropped) is never carried:
\* a re-run that starts before the visit that read it waits for a new message. With SourceEndRace the cut is #2's end,
\* and m_late waited at it exactly when #2 accepted it, that is, while #2 was active (event order, not timestamps).
KeptSourceVisits == ExpectedReused \cup ExpectedSupplied
MsgPresent(m) == ~SourceEndRace \/ accPc = "done"
EligibleCarry(m) ==
    /\ MsgPresent(m)
    /\ srcInbox[m].reader = NoNode
    /\ \/ (m \in OrdMsgs /\ (SourceEndRace \/ (srcInbox[m].accept <= CutTime /\ srcInbox[m].expire > CutTime)))
       \/ m \in ReusedNoticeMsgs
EligibleCarrySet == {m \in InboxMsgs : EligibleCarry(m)}
WaitingAtCut == EligibleCarrySet

\* #2's stored inbox columns and cut, as store.ts reads them. A row accepted into #2 has accepted_at = its acceptance and no
\* origin_accepted_at (0); a row #2 carried from #1 (RR-1) has accepted_at = CopyTime, a restarted expires_at, and
\* origin_accepted_at = its first acceptance; with SourceEndRace (MSG-1) m_late's accepted_at is accAt and the cut is
\* #2's finished_at.
StoredAcceptedAt(m) == IF SourceEndRace THEN accAt ELSE IF SrcCarried THEN CopyTime ELSE srcInbox[m].accept
StoredOriginAt(m) == IF SrcCarried THEN srcInbox[m].accept ELSE 0
StoredExpiresAt(m) == IF SourceEndRace THEN 9 ELSE IF SrcCarried THEN CopyTime + 1 ELSE srcInbox[m].expire
CodeCutAt == IF SourceEndRace THEN srcEndAt ELSE CutTime
CodeAcceptAt(m) == IF StoredOriginAt(m) # 0 /\ ~CarryComparesCopyTime THEN StoredOriginAt(m) ELSE StoredAcceptedAt(m)

\* store.ts copyRerunInboxIn (and summarizeRerunCarriedInbox) WHERE clause over #2's rows:
\*   consumed_by IS NULL
\*   AND ((contract <> WorkflowEnded@1 AND COALESCE(origin_accepted_at, accepted_at) <= cut AND expires_at > cut)
\*        OR (contract = WorkflowEnded@1 AND sender = ANY(reusedSpawnChildIds)))
\* Faults encode wrong filters: CarryLateMessage drops the time test, CarryReadMessage also carries a row a dropped visit
\* read (consumed_by IS NULL OR consumed_by is not a kept visit: reused, lanes included, or the supplied visit V'),
\* CarryDropsEqualCut models the old loss of a message accepted exactly at the cut as accepted_at < cut,
\* CarryKeepsExpiredAtCut uses expires_at >= cut, CarryNoticeByTime drops only the time arm's contract discriminator
\* (I-INBOX), and CarryComparesCopyTime compares accepted_at instead of COALESCE(origin_accepted_at, accepted_at) (RR-1,
\* the code before origin_accepted_at).
CodeUnread(m) ==
    IF CarryReadMessage THEN srcInbox[m].reader \notin KeptSourceVisits ELSE srcInbox[m].reader = NoNode
CodeWaitingAtCut(m) ==
    /\ IF CarryDropsEqualCut THEN CodeAcceptAt(m) < CodeCutAt ELSE CodeAcceptAt(m) <= CodeCutAt
    /\ IF CarryKeepsExpiredAtCut THEN StoredExpiresAt(m) >= CodeCutAt ELSE StoredExpiresAt(m) > CodeCutAt
CodeTimeArm(m) == (m \notin NoticeMsgs \/ CarryNoticeByTime) /\ CodeWaitingAtCut(m)
TargetInbox ==
    {m \in InboxMsgs : MsgPresent(m) /\ CodeUnread(m)
                       /\ (CarryLateMessage \/ CodeTimeArm(m) \/ m \in ReusedNoticeMsgs)}

\* RR-4: a refusal rolls the admission transaction back and changes nothing: the claim shell is left as it is, and its
\* cleanup is owed to a transaction of its own (service.ts createWorkflow catch -> store.ts softDeleteRefusedClaimShell,
\* RefusalCleanup below), which a crash can lose (RefusalCleanupLost; the Sweeper collects the shell after its grace).
RefuseClaim ==
    /\ UNCHANGED claimShellState
    /\ refusalCleanup' = "owed"

ReleaseCopyLocks ==
    /\ ownerLock' = IF ownerLock = "copy_share" THEN "free" ELSE ownerLock
    /\ defLock' = IF defLock = "copy_share" THEN "free" ELSE defLock
    /\ srcLock' = IF srcLock = "copy_share" THEN "free" ELSE srcLock
    /\ newLock' = IF newLock = "copy_excl" THEN "free" ELSE newLock

-----------------------------------------------------------------------------
(* Phase 0 (MSG-1, SourceEndRace): #2's end races an acceptance into #2    *)

\* #2 is active when the race starts. The store's clock advances (SrcClockTick). #2's end E (store.ts endRunIn /
\* cancelBeforeBegin) begins its transaction (EndBegin: now() is fixed at endTxStart), later takes #2's session lock and
\* commits (EndCommit). The acceptance A of m_late (store.ts acceptInput) takes the same session lock while #2 is active
\* (AccLock), reads the store's clock after its locks and commits (AccCommit: accAt). E stamps finished_at with now()
\* (EndClock = "begin", the code before the fix) or with the clock read after its locks (EndClock = "locked", store.ts
\* lockedClockText). An acceptance that finds #2 ended is refused (no message). The re-run is claimed after E committed.
RaceUnchanged ==
    UNCHANGED <<lockVars, sessionVars, startVars, shellVars, runVars, srcInbox, carriedInbox, unexpiredCarriedInbox,
                inboxTaken, ctrlVars, effCmdVars, delVars>>

SrcClockTick ==
    /\ SourceEndRace /\ endPc # "done" /\ srcClk < 3
    /\ srcClk' = srcClk + 1
    /\ UNCHANGED <<endPc, endTxStart, srcEndAt, accPc, accAt>>
    /\ RaceUnchanged

EndBegin ==
    /\ endPc = "idle"
    /\ endPc' = "begun"
    /\ endTxStart' = srcClk
    /\ UNCHANGED <<srcClk, srcEndAt, accPc, accAt>>
    /\ RaceUnchanged

AccLock ==
    /\ SourceEndRace /\ accPc = "idle" /\ endPc # "done"
    /\ accPc' = "locked"
    /\ UNCHANGED <<srcClk, endPc, endTxStart, srcEndAt, accAt>>
    /\ RaceUnchanged

AccCommit ==
    /\ accPc = "locked"
    /\ accPc' = "done"
    /\ accAt' = srcClk
    /\ UNCHANGED <<srcClk, endPc, endTxStart, srcEndAt>>
    /\ RaceUnchanged

EndCommit ==
    /\ endPc = "begun"
    /\ accPc # "locked"    \* E waits for #2's session lock while A holds it
    /\ endPc' = "done"
    /\ srcEndAt' = IF EndClock = "begin" THEN endTxStart ELSE srcClk
    /\ UNCHANGED <<srcClk, endTxStart, accPc, accAt>>
    /\ RaceUnchanged

SourceEndRaceStep == SrcClockTick \/ EndBegin \/ AccLock \/ AccCommit \/ EndCommit

-----------------------------------------------------------------------------
(* Phase 1: Two-step Start (ClaimRerun + Crash/NewRev + AdmitRerunCopy)    *)

ClaimRerun ==
    /\ endPc = "done"    \* a re-run's source has ended (with SourceEndRace, once #2's end committed)
    /\ \/ startPhase = "idle"
       \/ (AllowPostSweepStart /\ ~freshStartAfterSweep
           /\ (startPhase = "crashed" \/ startPhase = "refused_workflow_deleted")
           /\ claimShellState = "soft_deleted" /\ sweeperSnapVersion = 0)
    /\ refusalCleanup # "owed"     \* RR-4: an earlier refusal's own cleanup transaction has run (or was lost)
    /\ refusalCleanup' = "none"
    /\ LET isPostSweep == (startPhase # "idle")
           supPin == IF Mode = "supply" THEN [outcome |-> SuppliedOutcome, payloadVer |-> 1] ELSE EmptySuppliedPin
       IN
       IF ownerLive
         THEN /\ startPhase' = "claimed"
              /\ rerunPin' = [rev |-> latestRev, mode |-> Mode, supplied |-> supPin]
              /\ claimShellState' = "live_unadmitted"
              /\ sessionVersion' = 1
              /\ sweeperSnapVersion' = 0
              /\ claimGraceElapsed' = FALSE
              /\ freshStartAfterSweep' = IF isPostSweep THEN TRUE ELSE freshStartAfterSweep
         ELSE /\ startPhase' = "refused_owner_ended"
              /\ UNCHANGED <<rerunPin, claimShellState, sessionVersion, sweeperSnapVersion, claimGraceElapsed, freshStartAfterSweep>>
    /\ UNCHANGED <<lockVars, sessionVars, admittedRev, admittedSupplied, retrySupplyVer,
                   copySawSrcLive, copiedFromLive, pinnedResumed, everSweptShell, ownerEndedNew,
                   runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

SaveNewRevision ==
    /\ AllowClaimCrash
    /\ startPhase \in {"claimed", "crashed"}
    /\ latestRev = 1
    /\ latestRev' = 2
    /\ UNCHANGED <<lockVars, ownerLive, srcLive, srcNodes, deleterWaitedOnCopy, srcDeletedAfterCopy,
                   startVars, shellVars, runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

MutateRetrySupply ==
    /\ AllowRetrySupplyChange
    /\ Mode = "supply"
    /\ startPhase \in {"claimed", "crashed"}
    /\ retrySupplyVer = 1
    /\ retrySupplyVer' = 2
    /\ UNCHANGED <<lockVars, sessionVars, startPhase, rerunPin, admittedRev, admittedSupplied,
                   copySawSrcLive, copiedFromLive, pinnedResumed, shellVars,
                   runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

ClaimCrash ==
    /\ AllowClaimCrash
    /\ startPhase = "claimed"
    /\ ~pinnedResumed
    /\ ~freshStartAfterSweep
    /\ startPhase' = "crashed"
    /\ UNCHANGED <<lockVars, sessionVars, rerunPin, admittedRev, admittedSupplied, retrySupplyVer,
                   copySawSrcLive, copiedFromLive, pinnedResumed, shellVars,
                   runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

ResumeAfterClaimCrash ==
    /\ AllowResumeAfterCrash
    /\ startPhase = "crashed"
    /\ startPhase' = "claimed"
    /\ pinnedResumed' = TRUE
    /\ UNCHANGED <<lockVars, sessionVars, rerunPin, admittedRev, admittedSupplied, retrySupplyVer,
                   copySawSrcLive, copiedFromLive, shellVars,
                   runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

\* R2-M1: wall-clock grace (sessions.updated_at age) can elapse in ANY pre-admission phase (claimed, crashed, lock_*), and
\* (RR-4) after a refusal whose cleanup has not removed the shell (owed, or lost in a crash).
AdvanceClaimGrace ==
    /\ AllowShellSweeper
    /\ startPhase \in {"claimed", "crashed", "lock_step1", "lock_src", "lock_step2"} \cup Refused
    /\ claimShellState = "live_unadmitted"
    /\ ~claimGraceElapsed
    /\ claimGraceElapsed' = TRUE
    /\ UNCHANGED <<lockVars, sessionVars, startVars, claimShellState, sessionVersion, sweeperSnapVersion,
                   everSweptShell, ownerEndedNew, freshStartAfterSweep, refusalCleanup,
                   runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

\* R2-M1 step 1 (sweeper-tools.ts): unlocked candidate read observes bare shell older than grace (NO startPhase oracle).
SweeperReadBareShell ==
    /\ AllowShellSweeper
    /\ claimShellState = "live_unadmitted"
    /\ runStatus = "none"
    /\ claimGraceElapsed
    /\ sweeperSnapVersion = 0
    /\ sweeperSnapVersion' = sessionVersion
    /\ UNCHANGED <<lockVars, sessionVars, startVars, claimShellState, sessionVersion, claimGraceElapsed,
                   everSweptShell, ownerEndedNew, freshStartAfterSweep, refusalCleanup,
                   runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

\* R2-M1 step 2 (store.ts sweeperSoftDelete): acquires newLock (FOR NO KEY UPDATE), re-checks version & no run under lock,
\* and soft-deletes the bare shell without OwnerEnd. Fault SweeperSkipsNewLockOrRecheck keeps grace enabled and removes ONLY
\* newLock / the under-lock version & no-run re-check.
SweeperCollectClaimShell ==
    /\ AllowShellSweeper
    /\ sweeperSnapVersion > 0
    /\ IF SweeperSkipsNewLockOrRecheck
         THEN /\ claimShellState \in {"live_unadmitted", "admitted"}
              /\ claimShellState' = "soft_deleted"
              /\ sweeperSnapVersion' = 0
              /\ everSweptShell' = TRUE
         ELSE /\ newLock = "free"
              /\ sweeperSnapVersion' = 0
              /\ IF claimShellState = "live_unadmitted" /\ runStatus = "none" /\ sessionVersion = sweeperSnapVersion
                   THEN /\ claimShellState' = "soft_deleted"
                        /\ everSweptShell' = TRUE
                   ELSE UNCHANGED <<claimShellState, everSweptShell>>
    /\ UNCHANGED <<lockVars, sessionVars, startVars, sessionVersion, claimGraceElapsed, ownerEndedNew, freshStartAfterSweep,
                   refusalCleanup, runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

CopyLockStep1 ==
    /\ startPhase = "claimed"
    /\ IF LockNewBeforeOwner
         THEN /\ srcLock = "free"
              /\ srcLock' = "copy_share"
              /\ UNCHANGED <<ownerLock, defLock, newLock, copySawSrcLive>>
              /\ startPhase' = "lock_src"
         ELSE /\ ownerLock = "free" /\ defLock = "free"
              /\ ownerLock' = "copy_share" /\ defLock' = "copy_share"
              /\ copySawSrcLive' = IF NoSourceLock THEN srcLive ELSE copySawSrcLive
              /\ UNCHANGED <<srcLock, newLock>>
              /\ startPhase' = "lock_step1"
    /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, admittedSupplied, retrySupplyVer,
                   copiedFromLive, pinnedResumed, shellVars,
                   runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

CopyLockSrc ==
    /\ startPhase = "lock_step1"
    /\ ~LockNewBeforeOwner
    /\ IF NoSourceLock
         THEN /\ startPhase' = "lock_src"
              /\ UNCHANGED lockVars
         ELSE /\ srcLock = "free"
              /\ srcLock' = "copy_share"
              /\ startPhase' = "lock_src"
              /\ UNCHANGED <<ownerLock, defLock, newLock>>
    /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, admittedSupplied, retrySupplyVer,
                   copySawSrcLive, copiedFromLive, pinnedResumed, shellVars,
                   runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

\* M9: CopyLockStep2 acquires newLock (FOR NO KEY UPDATE) and immediately checks whether the Sweeper
\* already soft-deleted #3's bare claim shell; if so, releases locks and refuses refused_workflow_deleted (0 rows written).
CopyLockStep2 ==
    /\ startPhase = "lock_src"
    /\ IF LockNewBeforeOwner
         THEN /\ newLock = "free" /\ ownerLock = "free" /\ defLock = "free"
              /\ IF claimShellState = "soft_deleted"
                   THEN /\ startPhase' = "refused_workflow_deleted"
                        /\ ReleaseCopyLocks
                   ELSE /\ newLock' = "copy_excl" /\ ownerLock' = "copy_share" /\ defLock' = "copy_share"
                        /\ UNCHANGED srcLock
                        /\ startPhase' = "lock_step2"
         ELSE /\ newLock = "free"
              /\ IF claimShellState = "soft_deleted"
                   THEN /\ startPhase' = "refused_workflow_deleted"
                        /\ ReleaseCopyLocks
                   ELSE /\ newLock' = "copy_excl"
                        /\ UNCHANGED <<ownerLock, defLock, srcLock>>
                        /\ startPhase' = "lock_step2"
    /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, admittedSupplied, retrySupplyVer,
                   copySawSrcLive, copiedFromLive, pinnedResumed, shellVars,
                   runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

CopyCommit ==
    /\ startPhase = "lock_step2"
    /\ LET effectiveSrcLive == IF NoSourceLock THEN copySawSrcLive ELSE srcLive
           chosenRev == IF RepickOnResume /\ pinnedResumed THEN latestRev ELSE rerunPin.rev
           chosenSupplied == IF Mode = "supply"
                               THEN [outcome |-> SuppliedOutcome,
                                     payloadVer |-> IF RepickSuppliedOnRetry THEN retrySupplyVer ELSE rerunPin.supplied.payloadVer]
                               ELSE EmptySuppliedPin
           incompatible == Target \in {"reroute_taken", "reroute_onto_copy", "reroute_supply"}
           supplyStepBad == Mode = "supply" /\ NodeKindOf(ChosenSupplyNode) # "script_or_agent" /\ ~AllowSupplyOnForbiddenStep
           supplyNeverBad == Mode = "supply" /\ SupplyNever /\ ~IgnoreSupplyNever
           supplyOutcomeBad == Mode = "supply" /\ SuppliedOutcome \notin DeclaredOutcomes /\ ~AllowUndeclaredSupplyOutcome
           supplyNoteBad == Mode = "supply" /\ ~SupplyNotePresent /\ ~IgnoreMissingSupplyNote
           supplyRetryConflict == Mode = "supply" /\ AllowRetrySupplyChange /\ retrySupplyVer # rerunPin.supplied.payloadVer /\ ~RepickSuppliedOnRetry
           allCopied == ExpectedReused \cup ExpectedSupplied
       IN
       IF claimShellState = "soft_deleted"
         THEN /\ startPhase' = "refused_workflow_deleted"
              /\ ReleaseCopyLocks
              /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, admittedSupplied, retrySupplyVer,
                             copySawSrcLive, copiedFromLive, pinnedResumed, shellVars,
                             runVars, inboxVars, ctrlVars, effCmdVars, delVars>>
       ELSE IF ~ownerLive
         THEN /\ startPhase' = "refused_owner_ended"
              /\ RefuseClaim
              /\ ReleaseCopyLocks
              /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, admittedSupplied, retrySupplyVer,
                             copySawSrcLive, copiedFromLive, pinnedResumed,
                             sessionVersion, sweeperSnapVersion, claimGraceElapsed, everSweptShell, ownerEndedNew, freshStartAfterSweep,
                             runVars, inboxVars, ctrlVars, effCmdVars, delVars>>
       ELSE IF ~effectiveSrcLive
         THEN /\ startPhase' = "refused_source_gone"
              /\ RefuseClaim
              /\ ReleaseCopyLocks
              /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, admittedSupplied, retrySupplyVer,
                             copySawSrcLive, copiedFromLive, pinnedResumed,
                             sessionVersion, sweeperSnapVersion, claimGraceElapsed, everSweptShell, ownerEndedNew, freshStartAfterSweep,
                             runVars, inboxVars, ctrlVars, effCmdVars, delVars>>
       ELSE IF supplyRetryConflict
         THEN /\ startPhase' = "refused_conflict"
              /\ RefuseClaim
              /\ ReleaseCopyLocks
              /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, admittedSupplied, retrySupplyVer,
                             copySawSrcLive, copiedFromLive, pinnedResumed,
                             sessionVersion, sweeperSnapVersion, claimGraceElapsed, everSweptShell, ownerEndedNew, freshStartAfterSweep,
                             runVars, inboxVars, ctrlVars, effCmdVars, delVars>>
       ELSE IF supplyStepBad \/ supplyNeverBad
         THEN /\ startPhase' = "refused_supply_not_allowed"
              /\ RefuseClaim
              /\ ReleaseCopyLocks
              /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, admittedSupplied, retrySupplyVer,
                             copySawSrcLive, copiedFromLive, pinnedResumed,
                             sessionVersion, sweeperSnapVersion, claimGraceElapsed, everSweptShell, ownerEndedNew, freshStartAfterSweep,
                             runVars, inboxVars, ctrlVars, effCmdVars, delVars>>
       ELSE IF supplyOutcomeBad \/ supplyNoteBad
         THEN /\ startPhase' = "refused_supplied_invalid"
              /\ RefuseClaim
              /\ ReleaseCopyLocks
              /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, admittedSupplied, retrySupplyVer,
                             copySawSrcLive, copiedFromLive, pinnedResumed,
                             sessionVersion, sweeperSnapVersion, claimGraceElapsed, everSweptShell, ownerEndedNew, freshStartAfterSweep,
                             runVars, inboxVars, ctrlVars, effCmdVars, delVars>>
       ELSE IF FitCheck /\ incompatible
         THEN /\ startPhase' = "refused_incompatible"
              /\ RefuseClaim
              /\ ReleaseCopyLocks
              /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, admittedSupplied, retrySupplyVer,
                             copySawSrcLive, copiedFromLive, pinnedResumed,
                             sessionVersion, sweeperSnapVersion, claimGraceElapsed, everSweptShell, ownerEndedNew, freshStartAfterSweep,
                             runVars, inboxVars, ctrlVars, effCmdVars, delVars>>
       ELSE IF ApprovalGate /\ HasApproval /\ Actor # "owner"
         THEN /\ startPhase' = "refused_approval"
              /\ RefuseClaim
              /\ ReleaseCopyLocks
              /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, admittedSupplied, retrySupplyVer,
                             copySawSrcLive, copiedFromLive, pinnedResumed,
                             sessionVersion, sweeperSnapVersion, claimGraceElapsed, everSweptShell, ownerEndedNew, freshStartAfterSweep,
                             runVars, inboxVars, ctrlVars, effCmdVars, delVars>>
       ELSE IF ~AtomicCopy
         \* Fault rr-df-copy-not-atomic: run row commits before copies exist
         THEN /\ startPhase' = "partial_run"
              /\ claimShellState' = "admitted"
              /\ sessionVersion' = 2
              /\ admittedRev' = chosenRev
              /\ admittedSupplied' = chosenSupplied
              /\ copiedFromLive' = srcLive
              /\ runStatus' = "admitted"
              /\ ReleaseCopyLocks
              /\ UNCHANGED <<sessionVars, rerunPin, retrySupplyVer, copySawSrcLive, pinnedResumed,
                             sweeperSnapVersion, claimGraceElapsed, everSweptShell, ownerEndedNew, freshStartAfterSweep,
                             refusalCleanup, failCode, nState, nPred, nRoute, nWinner, nOutcome, nResultKind, nOrigin, nDeadline,
                             reusedSet, suppliedSet, newVisits, resumedAtCut, firstNew, firstNewPred, firstNewRoute,
                             firstNewHashOk, copyHitMismatch, downstreamReadSupplied, events, inboxVars, ctrlVars, effCmdVars, delVars>>
       ELSE \* Normal atomic commit of run row + copied prefix (+ optional supplied visit V') + carried inbox
            /\ startPhase' = "admitted"
            /\ claimShellState' = "admitted"
            /\ sessionVersion' = 2
            /\ admittedRev' = chosenRev
            /\ admittedSupplied' = chosenSupplied
            /\ copiedFromLive' = srcLive
            /\ runStatus' = "admitted"
            /\ nState' = [x \in AllNodes |-> IF x \in allCopied THEN "completed" ELSE "absent"]
            /\ nPred' = [x \in AllNodes |-> IF x \in allCopied THEN SrcPred(x) ELSE NoNode]
            /\ nRoute' = [x \in AllNodes |-> IF x \in allCopied THEN SrcRoute(x) ELSE "none"]
            /\ nWinner' = [x \in AllNodes |->
                  IF x \in ExpectedSupplied THEN "supplied"
                  ELSE IF x \in ExpectedReused THEN "reused"
                  ELSE "none"]
            /\ nOutcome' = [x \in AllNodes |->
                  IF x \in ExpectedSupplied THEN SuppliedOutcome
                  ELSE IF x \in ExpectedReused THEN srcNodes[x].outcome
                  ELSE "none"]
            /\ nResultKind' = [x \in AllNodes |->
                  IF x \in ExpectedSupplied THEN "business"
                  ELSE IF x \in ExpectedReused THEN srcNodes[x].kind
                  ELSE "none"]
            /\ nOrigin' = [x \in AllNodes |->
                  IF x \in ExpectedSupplied THEN "wf3"
                  ELSE IF x \in ExpectedReused THEN CopyOriginOf(x)
                  ELSE "none"]
            /\ nDeadline' = [x \in AllNodes |->
                  IF x \in ExpectedSupplied THEN "none"
                  ELSE IF x \in ExpectedReused THEN CopyDeadlineOf(x)
                  ELSE "none"]
            /\ reusedSet' = ExpectedReused
            /\ suppliedSet' = ExpectedSupplied
            /\ carriedInbox' = TargetInbox
            /\ unexpiredCarriedInbox' = TargetInbox
            /\ srcNodes' = IF CopyKeepsIds /\ LastReusedTop # NoNode
                             THEN [srcNodes EXCEPT ![LastReusedTop].outcome = "cancelled"]
                             ELSE srcNodes
            /\ pc' = "begin"
            /\ ReleaseCopyLocks
            /\ UNCHANGED <<ownerLive, srcLive, deleterWaitedOnCopy, srcDeletedAfterCopy, latestRev,
                           rerunPin, retrySupplyVer, copySawSrcLive, pinnedResumed,
                           sweeperSnapVersion, claimGraceElapsed, everSweptShell, ownerEndedNew, freshStartAfterSweep,
                           refusalCleanup, failCode, newVisits, resumedAtCut, firstNew, firstNewPred, firstNewRoute,
                           firstNewHashOk, copyHitMismatch, downstreamReadSupplied, events,
                           srcInbox, inboxTaken, raceVars, curNode, curPred, curRoute, curPending, curCaught, curSteps,
                           planMaxSteps, actRes, retriedInPassOver, canInPassOver, effCmdVars, delVars>>

CopyFinishPartial ==
    /\ startPhase = "partial_run"
    /\ LET allCopied == ExpectedReused \cup ExpectedSupplied IN
       /\ startPhase' = "admitted"
       /\ nState' = [x \in AllNodes |-> IF x \in allCopied THEN "completed" ELSE "absent"]
       /\ nPred' = [x \in AllNodes |-> IF x \in allCopied THEN SrcPred(x) ELSE NoNode]
       /\ nRoute' = [x \in AllNodes |-> IF x \in allCopied THEN SrcRoute(x) ELSE "none"]
       /\ nWinner' = [x \in AllNodes |->
             IF x \in ExpectedSupplied THEN "supplied"
             ELSE IF x \in ExpectedReused THEN "reused"
             ELSE "none"]
       /\ nOutcome' = [x \in AllNodes |->
             IF x \in ExpectedSupplied THEN SuppliedOutcome
             ELSE IF x \in ExpectedReused THEN srcNodes[x].outcome
             ELSE "none"]
       /\ nResultKind' = [x \in AllNodes |->
             IF x \in ExpectedSupplied THEN "business"
             ELSE IF x \in ExpectedReused THEN srcNodes[x].kind
             ELSE "none"]
       /\ nOrigin' = [x \in AllNodes |->
             IF x \in ExpectedSupplied THEN "wf3"
             ELSE IF x \in ExpectedReused THEN CopyOriginOf(x)
             ELSE "none"]
       /\ nDeadline' = [x \in AllNodes |->
             IF x \in ExpectedSupplied THEN "none"
             ELSE IF x \in ExpectedReused THEN CopyDeadlineOf(x)
             ELSE "none"]
       /\ reusedSet' = ExpectedReused
       /\ suppliedSet' = ExpectedSupplied
       /\ carriedInbox' = TargetInbox
       /\ unexpiredCarriedInbox' = TargetInbox
       /\ pc' = "begin"
    /\ UNCHANGED <<lockVars, sessionVars, rerunPin, admittedRev, admittedSupplied, retrySupplyVer,
                   copySawSrcLive, copiedFromLive, pinnedResumed, shellVars,
                   runStatus, failCode, newVisits, resumedAtCut, firstNew, firstNewPred, firstNewRoute,
                   firstNewHashOk, copyHitMismatch, downstreamReadSupplied, events, srcInbox, inboxTaken, raceVars,
                   curNode, curPred, curRoute, curPending, curCaught, curSteps, planMaxSteps, actRes,
                   retriedInPassOver, canInPassOver, effCmdVars, delVars>>

\* RR-4: the refusal's cleanup, a transaction of its own after the rollback (store.ts softDeleteRefusedClaimShell): the
\* shell's row FOR NO KEY UPDATE (newLock), then a soft delete only while the shell is still bare (live, unadmitted). Fault
\* SkipImmediateRefusalCleanup: the cleanup removes nothing (the code before RR-4 for refusals other than RUN_ENDED /
\* RERUN_*, and for a resumed claim). RefusalCleanupLost: a crash between the refusal and the cleanup.
RefusalCleanup ==
    /\ refusalCleanup = "owed"
    /\ newLock = "free"
    /\ refusalCleanup' = "done"
    /\ claimShellState' = IF claimShellState = "live_unadmitted" /\ ~SkipImmediateRefusalCleanup
                            THEN "soft_deleted" ELSE claimShellState
    /\ UNCHANGED <<lockVars, sessionVars, startVars, sessionVersion, sweeperSnapVersion, claimGraceElapsed, everSweptShell,
                   ownerEndedNew, freshStartAfterSweep, runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

RefusalCleanupLost ==
    /\ AllowCleanupCrash
    /\ refusalCleanup = "owed"
    /\ refusalCleanup' = "lost"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, claimShellState, sessionVersion, sweeperSnapVersion, claimGraceElapsed,
                   everSweptShell, ownerEndedNew, freshStartAfterSweep, runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

\* A refusal is settled once its cleanup ran, or, lost, once the shell is gone (the Sweeper, or the owner's deletion).
RefusalSettled ==
    \/ refusalCleanup \in {"none", "done"}
    \/ (refusalCleanup = "lost" /\ claimShellState # "live_unadmitted")

-----------------------------------------------------------------------------
(* Phase 2: Three Deleters (SweeperDirect, DeleteWorkflow, OwnerEnded)     *)

\* Witness action: records that a deleter arrived while Copy held srcLock="copy_share"
DeleterObservesCopyLock ==
    /\ AllowDeleters
    /\ ~deleterWaitedOnCopy
    /\ srcLive
    /\ srcLock = "copy_share"
    /\ (sweeperPc = "idle" \/ delWfPc = "idle")
    /\ deleterWaitedOnCopy' = TRUE
    /\ UNCHANGED <<lockVars, ownerLive, srcLive, srcNodes, srcDeletedAfterCopy, latestRev,
                   startVars, shellVars, runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

\* 1. SweeperDirect: blocking FOR NO KEY UPDATE on target #2, NOWAIT on descendants
SweeperLockTarget ==
    /\ AllowDeleters
    /\ sweeperPc = "idle"
    /\ srcLive
    /\ srcLock = "free"
    /\ srcLock' = "sweeper_excl"
    /\ sweeperPc' = "locked_target"
    /\ UNCHANGED <<ownerLock, defLock, newLock, sessionVars, startVars, shellVars,
                   runVars, inboxVars, ctrlVars, effCmdVars, delWfPc, ownerEndPc>>

SweeperCommit ==
    /\ sweeperPc = "locked_target"
    /\ srcLock' = "free"
    /\ \/ \* NOWAIT on descendant returned Busy -> rollback without deleting #2
          /\ sweeperPc' = "busy"
          /\ UNCHANGED <<srcLive, srcDeletedAfterCopy>>
       \/ /\ sweeperPc' = "done"
          /\ srcLive' = FALSE
          /\ srcDeletedAfterCopy' = (startPhase = "admitted")
    /\ UNCHANGED <<ownerLock, defLock, newLock, ownerLive, srcNodes, deleterWaitedOnCopy, latestRev,
                   startVars, shellVars, runVars, inboxVars, ctrlVars, effCmdVars, delWfPc, ownerEndPc>>

\* 2. DeleteWorkflow (explicit delete via cms_soft_delete_session): blocking UPDATE on #2
DelWfLock ==
    /\ AllowDeleters
    /\ delWfPc = "idle"
    /\ srcLive
    /\ srcLock = "free"
    /\ srcLock' = "delwf_excl"
    /\ delWfPc' = "locked_src"
    /\ UNCHANGED <<ownerLock, defLock, newLock, sessionVars, startVars, shellVars,
                   runVars, inboxVars, ctrlVars, effCmdVars, sweeperPc, ownerEndPc>>

DelWfCommit ==
    /\ delWfPc = "locked_src"
    /\ srcLock' = "free"
    /\ delWfPc' = "done"
    /\ srcLive' = FALSE
    /\ srcDeletedAfterCopy' = (startPhase = "admitted")
    /\ UNCHANGED <<ownerLock, defLock, newLock, ownerLive, srcNodes, deleterWaitedOnCopy, latestRev,
                   startVars, shellVars, runVars, inboxVars, ctrlVars, effCmdVars, sweeperPc, ownerEndPc>>

\* 3. OwnerEnded (migration 0096 workflow_on_owner_session_ended):
\*    owner-deleted branch locks owner -> updates session_workflow_definitions (defLock) -> locks child Workflows (#2, #3) ASC
OwnerEndLockOwner ==
    /\ AllowOwnerEnd
    /\ ownerEndPc = "idle"
    /\ ownerLive
    /\ ownerLock = "free"
    /\ ownerLock' = "owner_ended_excl"
    /\ ownerEndPc' = "locked_owner"
    /\ UNCHANGED <<defLock, srcLock, newLock, sessionVars, startVars, shellVars,
                   runVars, inboxVars, ctrlVars, effCmdVars, sweeperPc, delWfPc>>

OwnerEndLockDef ==
    /\ ownerEndPc = "locked_owner"
    /\ defLock = "free"
    /\ defLock' = "owner_ended_excl"
    /\ ownerEndPc' = "locked_def"
    /\ UNCHANGED <<ownerLock, srcLock, newLock, sessionVars, startVars, shellVars,
                   runVars, inboxVars, ctrlVars, effCmdVars, sweeperPc, delWfPc>>

OwnerEndCommit ==
    /\ ownerEndPc = "locked_def"
    /\ srcLock = "free"
    /\ newLock = "free"
    /\ ownerLock' = "free"
    /\ defLock' = "free"
    /\ ownerEndPc' = "done"
    /\ ownerLive' = FALSE
    /\ srcLive' = FALSE
    /\ claimShellState' = IF claimShellState \in {"live_unadmitted", "admitted"} THEN "soft_deleted" ELSE claimShellState
    /\ ownerEndedNew' = (ownerEndedNew \/ claimShellState = "admitted")
    /\ IF runStatus \in Active
         THEN /\ runStatus' = "cancelled"
              /\ EndPendingNodes("delete")
         ELSE UNCHANGED <<runStatus, nState, nWinner, nOutcome, nResultKind>>
    /\ UNCHANGED <<srcLock, newLock, srcNodes, deleterWaitedOnCopy, srcDeletedAfterCopy, latestRev,
                   startVars, sessionVersion, sweeperSnapVersion, claimGraceElapsed, everSweptShell, freshStartAfterSweep,
                   refusalCleanup, failCode, nPred, nRoute, nOrigin, nDeadline, reusedSet, suppliedSet, newVisits,
                   resumedAtCut, firstNew, firstNewPred, firstNewRoute, firstNewHashOk, copyHitMismatch,
                   downstreamReadSupplied, events, inboxVars, ctrlVars, effCmdVars, sweeperPc, delWfPc>>

-----------------------------------------------------------------------------
(* Phase 3: Unchanged 1.3.0 Controller Pass-Over & Live Execution          *)

BeginExec ==
    /\ pc = "begin"
    /\ IF runStatus = "admitted"
         THEN /\ runStatus' = "running"
              /\ events' = [events EXCEPT !.started = @ + 1]
              /\ planMaxSteps' = IF PlanBudget THEN StepLimit - UnwalkedCount ELSE StepLimit
              /\ pc' = "poll"
         ELSE /\ pc' = "done"
              /\ UNCHANGED <<runStatus, events, planMaxSteps>>
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, failCode, nState, nPred, nRoute, nWinner, nOutcome,
                   nResultKind, nOrigin, nDeadline, reusedSet, suppliedSet, newVisits, resumedAtCut, firstNew,
                   firstNewPred, firstNewRoute, firstNewHashOk, copyHitMismatch, downstreamReadSupplied, inboxVars,
                   curNode, curPred, curRoute, curPending, curCaught, curSteps, actRes,
                   retriedInPassOver, canInPassOver, effCmdVars, delVars>>

PollCommand ==
    /\ pc = "poll"
    /\ IF q # <<>> /\ Head(q) = "cancel"
         THEN /\ pc' = "cancel"
              /\ q' = Tail(q)
              /\ UNCHANGED <<runVars, curNode, curPred, curRoute, curPending, curCaught, curSteps,
                             planMaxSteps, actRes, retriedInPassOver, canInPassOver>>
       ELSE IF stopRequested /\ runStatus \in Active
         THEN /\ runStatus' = "stopped"
              /\ EndPendingNodes("controller")
              /\ events' = [events EXCEPT !.ended = @ + 1]
              /\ pc' = "done"
              /\ UNCHANGED <<q, failCode, nPred, nRoute, nOrigin, nDeadline, reusedSet, suppliedSet, newVisits,
                             resumedAtCut, firstNew, firstNewPred, firstNewRoute, firstNewHashOk,
                             copyHitMismatch, downstreamReadSupplied, curNode, curPred, curRoute, curPending,
                             curCaught, curSteps, planMaxSteps, actRes, retriedInPassOver, canInPassOver>>
       ELSE IF runStatus = "paused"
         THEN FALSE
       ELSE IF runStatus \in Terminal
         THEN /\ pc' = "done"
              /\ UNCHANGED <<runVars, q, curNode, curPred, curRoute, curPending, curCaught, curSteps,
                             planMaxSteps, actRes, retriedInPassOver, canInPassOver>>
       ELSE IF curSteps >= planMaxSteps
         THEN /\ runStatus' = "failed"
              /\ failCode' = "limit_exceeded"
              /\ EndPendingNodes("controller")
              /\ events' = [events EXCEPT !.ended = @ + 1]
              /\ pc' = "done"
              /\ UNCHANGED <<q, nPred, nRoute, nOrigin, nDeadline, reusedSet, suppliedSet, newVisits, resumedAtCut,
                             firstNew, firstNewPred, firstNewRoute, firstNewHashOk, copyHitMismatch,
                             downstreamReadSupplied, curNode, curPred, curRoute, curPending, curCaught, curSteps,
                             planMaxSteps, actRes, retriedInPassOver, canInPassOver>>
       ELSE /\ pc' = "admit"
            /\ UNCHANGED <<runVars, q, curNode, curPred, curRoute, curPending, curCaught, curSteps,
                           planMaxSteps, actRes, retriedInPassOver, canInPassOver>>
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, inboxVars, eff, agentSession,
                   oldChildStatus, newSpawnChildStatus, pauseUsed, stopRequested, cancelSent, delVars>>

ControllerCan ==
    /\ AllowCan
    /\ pc = "poll"
    /\ runStatus = "running"
    /\ curSteps >= 1
    /\ ~resumedAtCut
    /\ ~canInPassOver
    /\ canInPassOver' = TRUE
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, runVars, inboxVars,
                   pc, curNode, curPred, curRoute, curPending, curCaught, curSteps, planMaxSteps, actRes,
                   retriedInPassOver, effCmdVars, delVars>>

\* Decision 3 same-IR byte check: enforced in run_again ONLY when SameIr /\ RunKvRev = CutKvRev.
\* Skipped when Target="fix_chosen" (SameIr=FALSE) or StartVars=TRUE (RunKvRev=CutKvRev+1).
ByteCheckRequired == (Mode = "run_again" /\ SameIr /\ RunKvRev = CutKvRev)
ByteCheckOk == (~ByteCheckRequired) \/ (~InputHashMismatch)

\* Cut guard check (Design §5.2):
\*   run_again: curNode = ExpectedCutNode /\ curPred = LastReusedTop /\ curRoute = ExpectedCutRoute /\ (sameIr & sameKV => byte check)
\*   supply:    curNode = ExpectedCutNode /\ curPred = ChosenSupplyNode /\ curRoute = ExpectedCutRoute
\*   continue:  curPred = LastReusedTop
CutCoordMatches(x, pred, route) ==
    IF Mode = "run_again"
      THEN x = ExpectedCutNode /\ pred = LastReusedTop /\ route = ExpectedCutRoute
    ELSE IF Mode = "supply"
      THEN x = ExpectedCutNode /\ pred = ChosenSupplyNode /\ route = ExpectedCutRoute
      ELSE pred = LastReusedTop

CutGuardMatches(x, pred, route) ==
    CutCoordMatches(x, pred, route) /\ (~CheckInputHash \/ ByteCheckOk)

AdmitCoord ==
    IF OrdinalsRestart /\ ~resumedAtCut /\ curNode[1] = "S" /\ MaxReusedOrd("S") > 0 /\ nState[curNode] = "absent"
      THEN SNode(1)
      ELSE curNode

ReceiveAnchor ==
    IF nDeadline[RNode(1)] = "source" THEN "source" ELSE "new"

AdmitExec ==
    /\ pc = "admit"
    /\ actRes = "none"
    /\ LET x == AdmitCoord IN
       IF nState[x] # "absent" /\ ~(OrdinalsRestart /\ x = SNode(1) /\ curNode = SNode(2))
         \* Pass-over hit on an existing copied or supplied row: verify predecessor & arrival route (Design §5.2 item 2 / S1)
         THEN IF (curPred # nPred[x] \/ curRoute # nRoute[x])
                THEN IF CheckCopyCoord /\ Guard /\ ~resumedAtCut
                       THEN \* failRerunDiverged: end run failed without retrying NONDETERMINISTIC_ADMISSION
                            IF runStatus = "running"
                              THEN /\ runStatus' = "failed"
                                   /\ failCode' = "rerun_diverged"
                                   /\ EndPendingNodes("controller")
                                   /\ events' = [events EXCEPT !.ended = @ + 1]
                                   /\ actRes' = "notAdmitted"
                                   /\ UNCHANGED <<nPred, nRoute, nOrigin, nDeadline, reusedSet, suppliedSet, newVisits,
                                                  resumedAtCut, firstNew, firstNewPred, firstNewRoute,
                                                  firstNewHashOk, copyHitMismatch, downstreamReadSupplied, inboxVars>>
                              ELSE /\ actRes' = IF runStatus = "paused" THEN "paused" ELSE "notAdmitted"
                                   /\ UNCHANGED <<runVars, inboxVars>>
                       ELSE \* Fault rr-df-copy-hit-ignores-pred
                            /\ copyHitMismatch' = TRUE
                            /\ actRes' = nState[x]
                            /\ UNCHANGED <<runStatus, failCode, nState, nPred, nRoute, nWinner, nOutcome,
                                           nResultKind, nOrigin, nDeadline, reusedSet, suppliedSet, newVisits,
                                           resumedAtCut, firstNew, firstNewPred, firstNewRoute, firstNewHashOk,
                                           downstreamReadSupplied, events, inboxVars>>
                ELSE /\ actRes' = nState[x]
                     \* Fault TakeIgnoresTaken (RR-9): a re-run enterNode of a receive that took a carried message (its row
                     \* answered as it is) takes that message again.
                     /\ IF TakeIgnoresTaken /\ x[1] = "R" /\ x \in newVisits /\ nOutcome[x] = "msg"
                             /\ \E m \in carriedInbox : inboxTaken[m] = 1
                          THEN LET m == CHOOSE msg \in carriedInbox : inboxTaken[msg] = 1
                               IN /\ inboxTaken' = [inboxTaken EXCEPT ![m] = @ + 1]
                                  /\ UNCHANGED <<runVars, srcInbox, carriedInbox, unexpiredCarriedInbox, raceVars>>
                          ELSE UNCHANGED <<runVars, inboxVars>>
       ELSE IF runStatus = "paused"
         THEN /\ actRes' = "paused"
              /\ UNCHANGED <<runVars, inboxVars>>
       ELSE IF runStatus # "running"
         THEN /\ actRes' = "notAdmitted"
              /\ UNCHANGED <<runVars, inboxVars>>
       ELSE IF ~resumedAtCut /\ Guard /\ ~CutGuardMatches(curNode, curPred, curRoute)
         \* Cut guard fired!
         THEN IF DivergeInserts
                \* Fault rr-df-diverge-inserts: inserts pending row before failing
                THEN /\ nState' = [nState EXCEPT ![x] = "pending"]
                     /\ nPred' = [nPred EXCEPT ![x] = curPred]
                     /\ nRoute' = [nRoute EXCEPT ![x] = curRoute]
                     /\ newVisits' = newVisits \cup {x}
                     /\ runStatus' = "failed"
                     /\ failCode' = "rerun_diverged"
                     /\ events' = [events EXCEPT !.ended = @ + 1]
                     /\ actRes' = "notAdmitted"
                     /\ UNCHANGED <<nWinner, nOutcome, nResultKind, nOrigin, nDeadline, reusedSet, suppliedSet,
                                    resumedAtCut, firstNew, firstNewPred, firstNewRoute, firstNewHashOk,
                                    copyHitMismatch, downstreamReadSupplied, inboxVars>>
                ELSE /\ runStatus' = "failed"
                     /\ failCode' = "rerun_diverged"
                     /\ EndPendingNodes("controller")
                     /\ events' = [events EXCEPT !.ended = @ + 1]
                     /\ actRes' = "notAdmitted"
                     /\ UNCHANGED <<nPred, nRoute, nOrigin, nDeadline, reusedSet, suppliedSet, newVisits, resumedAtCut,
                                    firstNew, firstNewPred, firstNewRoute, firstNewHashOk, copyHitMismatch,
                                    downstreamReadSupplied, inboxVars>>
       ELSE \* Normal new admission (stamps rerun_resumed_at if first new visit)
            LET isExhausted == (x[1] = "S" /\ x[2] > MaxVisits)
                canTakeCarried == (x[1] = "R" /\ \E m \in carriedInbox : inboxTaken[m] = 0)
                st == IF isExhausted \/ canTakeCarried THEN "completed" ELSE "pending"
            IN
            /\ nState' = [nState EXCEPT ![x] = st]
            /\ nPred' = [nPred EXCEPT ![x] = curPred]
            /\ nRoute' = [nRoute EXCEPT ![x] = curRoute]
            /\ nWinner' = [nWinner EXCEPT ![x] = IF st = "completed" THEN "controller" ELSE "none"]
            /\ nOutcome' = [nOutcome EXCEPT ![x] = IF isExhausted THEN "exhausted"
                                                   ELSE IF canTakeCarried THEN "msg" ELSE "none"]
            /\ nResultKind' = [nResultKind EXCEPT ![x] = IF isExhausted THEN "runtime_error"
                                                         ELSE IF canTakeCarried THEN "business" ELSE "none"]
            /\ nOrigin' = [nOrigin EXCEPT ![x] = "wf3"]
            /\ nDeadline' = [nDeadline EXCEPT ![x] = IF x[1] = "R" THEN ReceiveAnchor ELSE "none"]
            /\ newVisits' = newVisits \cup {x}
            /\ IF ~resumedAtCut
                 THEN /\ resumedAtCut' = TRUE
                      /\ firstNew' = x
                      /\ firstNewPred' = curPred
                      /\ firstNewRoute' = curRoute
                      /\ firstNewHashOk' = ByteCheckOk
                 ELSE UNCHANGED <<resumedAtCut, firstNew, firstNewPred, firstNewRoute, firstNewHashOk>>
            /\ events' = [events EXCEPT !.stateStarted[x] = @ + 1]
            /\ IF canTakeCarried
                 THEN LET m == CHOOSE msg \in carriedInbox : inboxTaken[msg] = 0
                      IN /\ inboxTaken' = [inboxTaken EXCEPT ![m] = @ + 1]
                         /\ unexpiredCarriedInbox' = unexpiredCarriedInbox \ {m}
                 ELSE UNCHANGED <<inboxTaken, unexpiredCarriedInbox>>
            /\ actRes' = st
            /\ UNCHANGED <<runStatus, failCode, reusedSet, suppliedSet, copyHitMismatch, downstreamReadSupplied, srcInbox,
                           carriedInbox, raceVars>>
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, pc, curNode, curPred, curRoute, curPending, curCaught,
                   curSteps, planMaxSteps, retriedInPassOver, canInPassOver, effCmdVars, delVars>>

\* An enterNode activity's result is lost and the activity runs again: in the pass-over, and (RR-9, RetryAfterCut) after the
\* cut as well (the first new admission, a receive that took a carried message, any later admission).
AdmitRetry ==
    /\ AllowRetry
    /\ pc = "admit"
    /\ actRes # "none"
    /\ (RetryAfterCut \/ ~resumedAtCut)
    /\ ~retriedInPassOver
    /\ actRes' = "none"
    /\ retriedInPassOver' = TRUE
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, runVars, inboxVars,
                   pc, curNode, curPred, curRoute, curPending, curCaught, curSteps, planMaxSteps,
                   canInPassOver, effCmdVars, delVars>>

AdmitRecord ==
    /\ pc = "admit"
    /\ actRes # "none"
    /\ IF actRes = "paused"
         THEN /\ pc' = "poll"
              /\ UNCHANGED <<curNode, curPred, curRoute, curPending, curCaught, curSteps>>
       ELSE IF actRes = "notAdmitted"
         THEN /\ pc' = "done"
              /\ UNCHANGED <<curNode, curPred, curRoute, curPending, curCaught, curSteps>>
       ELSE IF curNode = TNode
         THEN /\ pc' = "finish"
              /\ curSteps' = curSteps + 1
              /\ curPending' = TNode
              /\ UNCHANGED <<curNode, curPred, curRoute, curCaught>>
       ELSE /\ curSteps' = curSteps + 1
            /\ curPending' = curNode
            /\ curCaught' = (curCaught \/ (curNode[1] = "H" /\ ~(DropsCatchAll /\ curNode \in reusedSet)))
            /\ pc' = IF actRes = "pending"
                       \/ (StartsDecided /\ curNode \in reusedSet)
                       \/ (StartsSupplied /\ curNode \in suppliedSet)
                       THEN "start"
                       ELSE "collect"
            /\ UNCHANGED <<curNode, curPred, curRoute>>
    /\ actRes' = "none"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, runVars, inboxVars, planMaxSteps,
                   retriedInPassOver, canInPassOver, effCmdVars, delVars>>

StartEffect ==
    /\ pc = "start"
    /\ curPending \in WorkNodes
    /\ eff' = [eff EXCEPT ![curPending] = IF @ = "absent" THEN "started" ELSE @]
    /\ agentSession' = [agentSession EXCEPT ![curPending] =
          IF NodeKindOf(curPending) = "script_or_agent" /\ @ = "absent" THEN "live" ELSE @]
    /\ newSpawnChildStatus' =
          IF (curPending = SPNode \/ (SourceKind = "spawn_lane" /\ curPending = PNode))
             /\ newSpawnChildStatus = "absent"
            THEN "active"
            ELSE newSpawnChildStatus
    /\ pc' = "collect"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, runVars, inboxVars,
                   curNode, curPred, curRoute, curPending, curCaught, curSteps, planMaxSteps, actRes,
                   retriedInPassOver, canInPassOver, oldChildStatus, q, pauseUsed, stopRequested, cancelSent, delVars>>

CollectExec ==
    /\ pc = "collect"
    /\ actRes = "none"
    /\ IF nState[curPending] = "completed"
         THEN actRes' = nOutcome[curPending]
         ELSE actRes' = "nothing"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, runVars, inboxVars,
                   pc, curNode, curPred, curRoute, curPending, curCaught, curSteps, planMaxSteps,
                   retriedInPassOver, canInPassOver, effCmdVars, delVars>>

CollectRecord ==
    /\ pc = "collect"
    /\ actRes # "none"
    /\ IF actRes = "nothing"
         THEN /\ pc' = "wait"
              /\ UNCHANGED <<curNode, curPred, curRoute, curPending, curCaught>>
       ELSE IF actRes = "cancelled"
         THEN /\ pc' = "done"
              /\ UNCHANGED <<curNode, curPred, curRoute, curPending, curCaught>>
       ELSE LET nxt == RouteTarget(curPending, actRes, curCaught, nState[HNode(1)] # "absent") IN
            IF nxt = NoNode
              THEN /\ pc' = "finishFail"
                   /\ UNCHANGED <<curNode, curPred, curRoute, curPending, curCaught>>
              ELSE /\ pc' = "poll"
                   /\ curPred' = curPending
                   /\ curRoute' = RouteLabelOf(curPending, actRes, curCaught)
                   /\ curNode' = nxt
                   /\ curPending' = NoNode
                   /\ curCaught' = curCaught
    /\ actRes' = "none"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, runVars, inboxVars, curSteps, planMaxSteps,
                   retriedInPassOver, canInPassOver, effCmdVars, delVars>>

WaitStep ==
    /\ pc = "wait"
    /\ IF q # <<>> /\ Head(q) = "cancel"
         THEN /\ pc' = "cancel"
              /\ q' = Tail(q)
         ELSE /\ nState[curPending] = "completed"
              /\ pc' = "collect"
              /\ q' = q
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, runVars, inboxVars,
                   curNode, curPred, curRoute, curPending, curCaught, curSteps, planMaxSteps, actRes,
                   retriedInPassOver, canInPassOver, eff, agentSession, oldChildStatus, newSpawnChildStatus,
                   pauseUsed, stopRequested, cancelSent, delVars>>

FinishExec ==
    /\ pc = "finish"
    /\ IF runStatus \in Active
         THEN /\ runStatus' = "completed"
              /\ nState' = [nState EXCEPT ![TNode] = "completed"]
              /\ nWinner' = [nWinner EXCEPT ![TNode] = "controller"]
              /\ nOutcome' = [nOutcome EXCEPT ![TNode] = "succeeded"]
              /\ nResultKind' = [nResultKind EXCEPT ![TNode] = "business"]
              /\ events' = [events EXCEPT !.ended = @ + 1]
         ELSE UNCHANGED <<runStatus, nState, nWinner, nOutcome, nResultKind, events>>
    /\ pc' = "done"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, failCode, nPred, nRoute, nOrigin, nDeadline,
                   reusedSet, suppliedSet, newVisits, resumedAtCut, firstNew, firstNewPred, firstNewRoute,
                   firstNewHashOk, copyHitMismatch, downstreamReadSupplied, inboxVars, curNode, curPred, curRoute,
                   curPending, curCaught, curSteps, planMaxSteps, actRes, retriedInPassOver, canInPassOver,
                   effCmdVars, delVars>>

FinishFailExec ==
    /\ pc = "finishFail"
    /\ IF runStatus \in Active
         THEN /\ runStatus' = "failed"
              /\ failCode' = "unhandled_error"
              /\ EndPendingNodes("controller")
              /\ events' = [events EXCEPT !.ended = @ + 1]
         ELSE UNCHANGED <<runStatus, failCode, nState, nWinner, nOutcome, nResultKind, events>>
    /\ pc' = "done"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, nPred, nRoute, nOrigin, nDeadline, reusedSet,
                   suppliedSet, newVisits, resumedAtCut, firstNew, firstNewPred, firstNewRoute, firstNewHashOk,
                   copyHitMismatch, downstreamReadSupplied, inboxVars, curNode, curPred, curRoute, curPending,
                   curCaught, curSteps, planMaxSteps, actRes, retriedInPassOver, canInPassOver,
                   effCmdVars, delVars>>

CancelTx ==
    /\ pc = "cancel"
    /\ IF runStatus \in Active
         THEN /\ runStatus' = "cancelled"
              /\ EndPendingNodes("cancel")
              /\ events' = [events EXCEPT !.ended = @ + 1]
         ELSE UNCHANGED <<runStatus, nState, nWinner, nOutcome, nResultKind, events>>
    /\ pc' = "done"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, failCode, nPred, nRoute, nOrigin, nDeadline,
                   reusedSet, suppliedSet, newVisits, resumedAtCut, firstNew, firstNewPred, firstNewRoute,
                   firstNewHashOk, copyHitMismatch, downstreamReadSupplied, inboxVars, curNode, curPred, curRoute,
                   curPending, curCaught, curSteps, planMaxSteps, actRes, retriedInPassOver, canInPassOver,
                   effCmdVars, delVars>>

EffFinish(x) ==
    /\ x \in WorkNodes
    /\ eff[x] = "started"
    /\ \E o \in NewWorkOutcomes(x) :
         IF nState[x] = "pending" /\ runStatus \in Active
           THEN /\ nState' = [nState EXCEPT ![x] = "completed"]
                /\ nWinner' = [nWinner EXCEPT ![x] = IF o = "elapsed" THEN "timer" ELSE "effect"]
                /\ nOutcome' = [nOutcome EXCEPT ![x] = o]
                /\ nResultKind' = [nResultKind EXCEPT ![x] = IF o = "error" THEN "runtime_error" ELSE "business"]
                /\ events' = [events EXCEPT !.stateCompleted[x] = @ + 1]
                /\ downstreamReadSupplied' = (downstreamReadSupplied \/ (suppliedSet # {} /\ x \in newVisits))
           ELSE UNCHANGED <<nState, nWinner, nOutcome, nResultKind, events, downstreamReadSupplied>>
    /\ eff' = [eff EXCEPT ![x] = "done"]
    /\ agentSession' = [agentSession EXCEPT ![x] = IF @ = "live" THEN "ended" ELSE @]
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, runStatus, failCode, nPred, nRoute, nOrigin,
                   nDeadline, reusedSet, suppliedSet, newVisits, resumedAtCut, firstNew, firstNewPred, firstNewRoute,
                   firstNewHashOk, copyHitMismatch, inboxVars, ctrlVars, oldChildStatus, newSpawnChildStatus,
                   q, pauseUsed, stopRequested, cancelSent, delVars>>

\* G-R2: #2's old spawn child winds down asynchronously via parent-end cancel (disabled by SkipParentEndCancel fault)
OldChildWindDown ==
    /\ ~SkipParentEndCancel
    /\ oldChildStatus \in {"active", "cancelling"}
    /\ oldChildStatus' = IF oldChildStatus = "active" THEN "cancelling" ELSE "cancelled"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, runVars, inboxVars, ctrlVars,
                   eff, agentSession, newSpawnChildStatus, q, pauseUsed, stopRequested, cancelSent, delVars>>

\* #3's newly spawned child settles to completed or cancelled
NewChildSettle ==
    /\ newSpawnChildStatus = "active"
    /\ newSpawnChildStatus' = IF runStatus \in {"cancelled", "stopped", "failed"} THEN "cancelled" ELSE "completed"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, runVars, inboxVars, ctrlVars,
                   eff, agentSession, oldChildStatus, q, pauseUsed, stopRequested, cancelSent, delVars>>

\* Unconsumed carried inbox messages in #3 expire by TTL once #3 finishes (S15)
ExpireCarriedInbox ==
    /\ unexpiredCarriedInbox # {}
    /\ (pc = "done" \/ runStatus \in Terminal \/ startPhase \in Refused)
    /\ \E m \in unexpiredCarriedInbox :
         unexpiredCarriedInbox' = unexpiredCarriedInbox \ {m}
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, runVars, srcInbox, carriedInbox, inboxTaken, raceVars,
                   ctrlVars, effCmdVars, delVars>>

PauseRun ==
    /\ AllowCtrlCmds
    /\ ~pauseUsed
    /\ runStatus = "running"
    /\ runStatus' = "paused"
    /\ pauseUsed' = TRUE
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, failCode, nState, nPred, nRoute, nWinner, nOutcome,
                   nResultKind, nOrigin, nDeadline, reusedSet, suppliedSet, newVisits, resumedAtCut, firstNew,
                   firstNewPred, firstNewRoute, firstNewHashOk, copyHitMismatch, downstreamReadSupplied, events,
                   inboxVars, ctrlVars, eff, agentSession, oldChildStatus, newSpawnChildStatus, q,
                   stopRequested, cancelSent, delVars>>

ResumeRun ==
    /\ AllowCtrlCmds
    /\ runStatus = "paused"
    /\ runStatus' = "running"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, failCode, nState, nPred, nRoute, nWinner, nOutcome,
                   nResultKind, nOrigin, nDeadline, reusedSet, suppliedSet, newVisits, resumedAtCut, firstNew,
                   firstNewPred, firstNewRoute, firstNewHashOk, copyHitMismatch, downstreamReadSupplied, events,
                   inboxVars, ctrlVars, effCmdVars, delVars>>

RequestStop ==
    /\ AllowCtrlCmds
    /\ ~stopRequested
    /\ runStatus = "running"
    /\ stopRequested' = TRUE
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, runVars, inboxVars, ctrlVars,
                   eff, agentSession, oldChildStatus, newSpawnChildStatus, q, pauseUsed, cancelSent, delVars>>

SendCancel ==
    /\ AllowCtrlCmds
    /\ ~cancelSent
    /\ runStatus \in Active
    /\ cancelSent' = TRUE
    /\ q' = Append(q, "cancel")
    /\ UNCHANGED <<lockVars, sessionVars, startVars, shellVars, runVars, inboxVars, ctrlVars,
                   eff, agentSession, oldChildStatus, newSpawnChildStatus, pauseUsed, stopRequested, delVars>>

SweeperSettled ==
    /\ sweeperPc \in {"idle", "done", "busy"}
    /\ sweeperSnapVersion = 0
    /\ ((startPhase = "crashed" /\ ~AllowResumeAfterCrash /\ AllowShellSweeper) => claimShellState = "soft_deleted")

InboxSettled ==
    unexpiredCarriedInbox = {}

Quiescent ==
    /\ ownerLock = "free" /\ defLock = "free" /\ srcLock = "free" /\ newLock = "free"
    /\ SweeperSettled
    /\ delWfPc \in {"idle", "done"}
    /\ ownerEndPc \in {"idle", "done"}
    /\ ((startPhase \in Refused /\ RefusalSettled)
        \/ (startPhase = "crashed" /\ ~AllowResumeAfterCrash /\ claimShellState = "soft_deleted")
        \/ (startPhase = "admitted" /\ pc = "done"))
    /\ \A x \in WorkNodes : eff[x] \in {"absent", "done"}
    /\ InboxSettled
    /\ newSpawnChildStatus \in {"absent", "completed", "cancelled"}
    /\ (~SkipParentEndCancel => oldChildStatus \in {"absent", "cancelled"})

Done ==
    /\ Quiescent
    /\ UNCHANGED vars

-----------------------------------------------------------------------------
(* Next-state relation & Fairness                                          *)

StartProgress ==
    \/ SourceEndRaceStep
    \/ ClaimRerun \/ ResumeAfterClaimCrash \/ CopyLockStep1 \/ CopyLockSrc \/ CopyLockStep2
    \/ CopyCommit \/ CopyFinishPartial \/ RefusalCleanup

DeleterCommit ==
    \/ SweeperCommit \/ DelWfCommit \/ OwnerEndLockDef \/ OwnerEndCommit

CtrlProgress ==
    \/ BeginExec \/ PollCommand \/ AdmitExec \/ AdmitRecord \/ StartEffect
    \/ CollectExec \/ CollectRecord \/ WaitStep \/ FinishExec \/ FinishFailExec \/ CancelTx
    \/ ResumeRun

LifecycleProgress ==
    \/ AdvanceClaimGrace \/ SweeperReadBareShell \/ SweeperCollectClaimShell
    \/ OldChildWindDown \/ NewChildSettle \/ ExpireCarriedInbox

EffProgress == \E x \in WorkNodes : EffFinish(x)

Next ==
    \/ StartProgress
    \/ SaveNewRevision \/ MutateRetrySupply \/ ClaimCrash \/ RefusalCleanupLost
    \/ DeleterObservesCopyLock \/ SweeperLockTarget \/ DelWfLock \/ OwnerEndLockOwner \/ DeleterCommit
    \/ CtrlProgress \/ ControllerCan \/ AdmitRetry \/ EffProgress
    \/ LifecycleProgress
    \/ PauseRun \/ RequestStop \/ SendCancel
    \/ Done

Fairness ==
    /\ WF_vars(StartProgress)
    /\ WF_vars(DeleterCommit)
    /\ WF_vars(CtrlProgress)
    /\ WF_vars(LifecycleProgress)
    /\ \A x \in WorkNodes : WF_vars(EffFinish(x))

Spec == Init /\ [][Next]_vars
LiveSpec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety Invariants & Properties                                          *)

Inv_ReusedNeverRuns ==
    \A x \in reusedSet \cap WorkNodes : eff[x] = "absent" /\ agentSession[x] = "absent"

Inv_SuppliedNeverRuns ==
    \A x \in suppliedSet \cap WorkNodes : eff[x] = "absent" /\ agentSession[x] = "absent"

Inv_SuppliedSingleton ==
    /\ ((Mode = "supply" /\ startPhase = "admitted") =>
          (Cardinality(suppliedSet) = 1 /\ suppliedSet \cap reusedSet = {}))
    /\ ((Mode # "supply") => suppliedSet = {})

Inv_SupplyAllowedStepOnly ==
    \A x \in suppliedSet : NodeKindOf(x) = "script_or_agent" /\ ~SupplyNever

Inv_SuppliedOutcomeDeclared ==
    \A x \in suppliedSet :
        /\ nState[x] = "completed"
        /\ nResultKind[x] = "business"
        /\ nWinner[x] = "supplied"
        /\ nOutcome[x] \in DeclaredOutcomes
        /\ SupplyNotePresent

Inv_AutoPickNoCancelledReuse ==
    (AutoPicked /\ ~ReqModeContinue /\ startPhase = "admitted") =>
        \A x \in reusedSet : ~IsCancelledOrNoticelessSpawn(x)

\* RR-4: once a refusal's own cleanup transaction ran, the claim shell is not left bare (the refusal step itself changes
\* nothing, so nothing is deleted at the refusal; a cleanup lost in a crash is the Sweeper's: Live_Quiesces).
Inv_RefusalCleanupLeavesNoBareShell ==
    (startPhase \in Refused /\ refusalCleanup = "done") => (claimShellState # "live_unadmitted")

\* R2-M1 safety invariant: a run is never admitted onto a swept shell, and an admitted shell is never swept
\* while owner is alive (replaces sticky-flag check so legal crash -> grace -> sweep -> late retry -> refused_workflow_deleted passes).
Inv_AdmittedNotSwept ==
    /\ ((startPhase = "admitted" /\ ~ownerEndedNew) => (claimShellState = "admitted"))
    /\ ((runStatus # "none" /\ ~ownerEndedNew) => (claimShellState = "admitted"))

\* R2-M1 / M8 step property: Sweeper deletes a bare shell only when grace elapsed, newLock was free, and no run exists;
\* and never deletes an admitted shell. Identifies OwnerEndCommit strictly by (ownerEndPc = "locked_def" /\ ownerEndPc' = "done")
\* so Sweeper deletions while OwnerEnd is parked at locked_def are still checked.
OwnerEndCommitsThisStep == (ownerEndPc = "locked_def" /\ ownerEndPc' = "done")

Prop_SweepRequiresLockAndNoRun ==
    [][
        /\ ((claimShellState = "live_unadmitted" /\ claimShellState' = "soft_deleted"
             /\ ~OwnerEndCommitsThisStep /\ startPhase' \notin Refused) =>
                (claimGraceElapsed /\ newLock = "free" /\ runStatus = "none"))
        /\ ((claimShellState = "admitted" /\ claimShellState' = "soft_deleted"
             /\ ~OwnerEndCommitsThisStep) => FALSE)
    ]_vars

Inv_QuiescentNoLive ==
    Quiescent =>
        /\ oldChildStatus # "active"
        /\ newSpawnChildStatus # "active"
        /\ (\A x \in WorkNodes : agentSession[x] # "live")
        /\ claimShellState # "live_unadmitted"
        /\ unexpiredCarriedInbox = {}

Inv_ReusedImmutable ==
    \A x \in reusedSet :
        /\ nState[x] = "completed"
        /\ nOutcome[x] = InitSrcNodes[x].outcome
        /\ nResultKind[x] = InitSrcNodes[x].kind

Inv_SourceUntouched ==
    srcNodes = InitSrcNodes

Inv_CopyAtomic ==
    (runStatus # "none") <=> (\A x \in ExpectedReused \cup ExpectedSupplied : nState[x] = "completed")

Inv_OriginRan ==
    \A x \in reusedSet : nOrigin[x] = ActualOrigin(x)

Inv_NoCopyFromDeleted ==
    (startPhase = "admitted") => copiedFromLive

Inv_PinnedChoice ==
    (startPhase = "admitted") =>
        /\ rerunPin.rev > 0
        /\ admittedRev = rerunPin.rev
        /\ (Mode = "supply" => admittedSupplied = rerunPin.supplied)

Inv_NoConsentReuse ==
    (HasApproval /\ startPhase = "admitted") => (Actor = "owner")

Inv_FirstNewAtCut ==
    resumedAtCut => (CutCoordMatches(firstNew, firstNewPred, firstNewRoute) /\ firstNewHashOk)

Inv_PassOverOnChain ==
    ~copyHitMismatch

Inv_NoWorkOnDiverge ==
    (runStatus = "failed" /\ failCode = "rerun_diverged") =>
        /\ \A x \in AllNodes \ (reusedSet \cup suppliedSet) : nState[x] = "absent"
        /\ \A x \in WorkNodes : eff[x] = "absent" /\ agentSession[x] = "absent"

\* Permissive guard safety: a valid or byte-check-exempt re-run never triggers rerun_diverged.
Inv_ValidNeverDiverges ==
    (Target \in {"same", "fix_chosen"} /\ (~ByteCheckRequired \/ ~InputHashMismatch)) =>
        ~(runStatus = "failed" /\ failCode = "rerun_diverged")

Inv_OrdinalsContinue ==
    /\ \A x \in newVisits : x \notin (reusedSet \cup suppliedSet)
    /\ \A x \in newVisits : \A y \in (reusedSet \cup suppliedSet) : x[1] = y[1] => x[2] > y[2]
    /\ \A i \in 2..3 : nState[SNode(i)] # "absent" => nState[SNode(i - 1)] # "absent"
    /\ nState[RNode(2)] # "absent" => nState[RNode(1)] # "absent"
    /\ nState[HNode(2)] # "absent" => nState[HNode(1)] # "absent"

Inv_CatchAllOnce ==
    nState[HNode(2)] = "absent"

Inv_VisitLimit ==
    MaxVisits < 3 =>
        /\ eff[SNode(MaxVisits + 1)] = "absent"
        /\ (nState[SNode(MaxVisits + 1)] = "completed" => nOutcome[SNode(MaxVisits + 1)] \in {"exhausted", "cancelled"})

Inv_StepLimit ==
    Cardinality({x \in AllNodes : nState[x] # "absent"}) <= StepLimit

Inv_TotalFromFirstNew ==
    (RNode(2) \in newVisits) => (nDeadline[RNode(2)] = "new")

Inv_CarriedWereWaiting ==
    \A m \in carriedInbox : EligibleCarry(m)

\* Exact carry (Design §5.4): once admitted, #3 carries exactly the unread messages a fresh run at the cut would still see,
\* no more (Inv_CarriedWereWaiting; a message any visit read, a dropped one included) and no fewer (an unread message
\* accepted exactly at the cut).
Inv_InboxCarryExact ==
    (startPhase = "admitted") => (carriedInbox = EligibleCarrySet)

\* Review RR-1: a second-generation re-run whose cut is a visit #2 copied from #1 loses no message, among rows carried into
\* the immediate source (#2), that waited at that cut in #1's history. The ground truth is EligibleCarry (first acceptance
\* and expiry in #1's history); the code side reads #2's stored accepted_at / origin_accepted_at (CodeAcceptAt). This is the
\* no-loss half of Inv_InboxCarryExact, for the copied-prefix cut only. A row of #1 that #2 did not carry is outside it: a
\* re-run reads its immediate source only, never an earlier ancestor.
Inv_NoWaitingLostAcrossGenerations ==
    (startPhase = "admitted" /\ SrcCarried) => (EligibleCarrySet \subseteq carriedInbox)

\* Review MSG-1: #2's stored end is not earlier than the stored acceptance of a message #2 accepted while it was active, so a
\* re-run that cuts at #2's end (accepted_at <= finished_at) sees it. A store-level property of the end's clock reading.
Inv_AcceptedBeforeEnd ==
    (accPc = "done" /\ endPc = "done") => (accAt <= srcEndAt)

Inv_TakeOnce ==
    \A m \in InboxMsgs : inboxTaken[m] <= 1

Inv_EventsOnce ==
    /\ events.started <= 1
    /\ events.ended <= 1
    /\ \A x \in AllNodes : events.stateStarted[x] <= 1 /\ events.stateCompleted[x] <= 1

Inv_AdmissionOrder ==
    /\ \A i \in 2..3 : (SNode(i) \in newVisits) => (nState[SNode(i - 1)] = "completed")
    /\ (TNode \in newVisits) =>
         \E x \in WorkNodes : nState[x] = "completed" /\ nOutcome[x] \in {"ok", "exhausted", "msg", "again", "started"}

Inv_CatchAllAfterUnhandled ==
    (nState[HNode(1)] # "absent") => (nState[SNode(1)] = "completed" /\ nOutcome[SNode(1)] = "error")
        \/ (nState[SNode(2)] = "completed" /\ nOutcome[SNode(2)] = "error")

Inv_CancelWinner ==
    \A x \in AllNodes : nWinner[x] \in {"cancel", "delete"} => runStatus = "cancelled"

Inv_CompletedHasTerminal ==
    runStatus = "completed" => nOutcome[TNode] = "succeeded"

Inv_NeverRouteCancelled ==
    ~(pc = "collect" /\ actRes = "cancelled" /\ runStatus \in Active)

CoreSafety ==
    /\ TypeOK
    /\ Inv_EventsOnce
    /\ Inv_AdmissionOrder
    /\ Inv_CatchAllAfterUnhandled
    /\ Inv_CancelWinner
    /\ Inv_CompletedHasTerminal
    /\ Inv_NeverRouteCancelled

Inv_TerminalNoPending ==
    runStatus \in Terminal => \A x \in AllNodes : nState[x] # "pending"

Prop_NoAdmissionAfterTerminal ==
    [][(runStatus \in Terminal => \A x \in AllNodes : nState[x] = "absent" => nState'[x] = "absent")]_vars

-----------------------------------------------------------------------------
(* Liveness Properties                                                     *)

\* General liveness under deleters/commands/unretried crash
Live_ReachesCut == <>(startPhase \in Refused \/ (startPhase = "crashed" /\ ~AllowResumeAfterCrash /\ claimShellState = "soft_deleted") \/ resumedAtCut \/ runStatus \in Terminal)
Live_Terminates == <>(startPhase \in Refused \/ (startPhase = "crashed" /\ ~AllowResumeAfterCrash /\ claimShellState = "soft_deleted") \/ runStatus \in Terminal)
Live_Quiesces == <>Quiescent

\* Strong liveness for valid/exempt re-runs (no deleters, no cancel/stop): MUST reach resumedAtCut (never rerun_diverged).
Live_ReachesCutOnly == <>resumedAtCut

\* Strong liveness for incompatible/mismatched-hash divergence cases: MUST reach rerun_diverged cleanly.
Live_DivergesCleanly == <>(runStatus = "failed" /\ failCode = "rerun_diverged")

-----------------------------------------------------------------------------
(* Non-Vacuity Witnesses (each expected VIOLATED, exit 12)                 *)

Wit_NeverResumes == ~resumedAtCut
Wit_NoReusedCatchAll == ~(startPhase = "admitted" /\ HNode(1) \in reusedSet)
Wit_NoFailAfterReusedCatchAll == ~(HNode(1) \in reusedSet /\ runStatus = "failed" /\ failCode = "unhandled_error")
Wit_NoExhausted == ~(\E x \in AllNodes : nOutcome[x] = "exhausted")
Wit_NoRetryInPassOver == ~retriedInPassOver
Wit_NoContinueAsNewInPassOver == ~canInPassOver
Wit_NoSecondGeneration == ~(Generations = 2 /\ runStatus = "completed" /\ nOrigin[SNode(1)] = "wf1")
Wit_NoDiverge == ~(runStatus = "failed" /\ failCode = "rerun_diverged")
Wit_NoSourceGone == ~(startPhase = "refused_source_gone")
Wit_NoDeleteAfterCopy == ~(deleterWaitedOnCopy /\ srcDeletedAfterCopy /\ runStatus = "completed")
Wit_NoApprovalRefusal == ~(startPhase = "refused_approval")
Wit_NoCarriedTake == ~(\E m \in WaitingAtCut : inboxTaken[m] = 1)
Wit_NoPinnedResume == ~(pinnedResumed /\ startPhase = "admitted" /\ admittedRev = rerunPin.rev /\ latestRev > rerunPin.rev)

\* Unit 3A-Supply witnesses (6 required, incl. R2-M1 wit.rr-no-late-retry-after-sweep)
Wit_NoSupplyDownstreamRead ==
    ~(Mode = "supply" /\ SNode(2) \in suppliedSet /\ downstreamReadSupplied /\ runStatus = "completed")

Wit_NoSupplyFirstVisit ==
    ~(Mode = "supply" /\ SourceKind = "supply_first" /\ reusedSet = {} /\ SNode(1) \in suppliedSet /\ runStatus = "completed")

Wit_NoSupplyToTerminal ==
    ~(Mode = "supply" /\ resumedAtCut /\ firstNew = TNode /\ runStatus = "completed")

Wit_NoSupplyRefusedStepType ==
    ~(Mode = "supply" /\ startPhase = "refused_supply_not_allowed")

Wit_NoLeakQuiescence ==
    ~(Quiescent /\ ~AllowOwnerEnd /\ everSweptShell /\ Gr1Active /\ oldChildStatus = "cancelled"
      /\ newSpawnChildStatus = "completed" /\ carriedInbox # {} /\ Inv_QuiescentNoLive)

\* RR-4: a refusal's cleanup transaction was lost in a crash, and the Sweeper collected the bare shell after its grace.
Wit_NoLostRefusalCleanupSwept ==
    ~(startPhase \in Refused /\ refusalCleanup = "lost" /\ everSweptShell /\ claimShellState = "soft_deleted")

Wit_NoLateRetryAfterSweep ==
    ~(pinnedResumed /\ everSweptShell /\ startPhase = "refused_workflow_deleted"
      /\ runStatus = "none" /\ claimShellState = "soft_deleted")

\* Task 6a-TLA+ generated-inbox witnesses: the exact-carry boundaries are reached, not vacuous.
\* A message accepted exactly at the cut is carried, taken by #3's new receive, and the run completes.
Wit_NoCarryAtCut ==
    ~(\E m \in OrdMsgs : srcInbox[m].accept = CutTime /\ m \in carriedInbox /\ inboxTaken[m] = 1 /\ runStatus = "completed")

\* Task R5: #3 starts before R2, the receive whose message #2 read. That message is not carried, R2 waits (pending) for a
\* new one, a new message arrives in #3 (R2's effect, winner effect, outcome msg) and the run completes.
Wit_NoNewMessageAfterRead ==
    ~(/\ \E m \in OrdMsgs : srcInbox[m].reader = DroppedReader /\ m \notin carriedInbox
      /\ RNode(2) \in newVisits /\ eff[RNode(2)] = "done" /\ nWinner[RNode(2)] = "effect" /\ nOutcome[RNode(2)] = "msg"
      /\ runStatus = "completed")

\* Task R5: the reused spawn child's WorkflowEnded@1 notice, read by #2's dropped receive R2, is not carried by an admitted
\* re-run (R2 runs again and waits for a new message).
Wit_NoReadNoticeLeft ==
    ~(startPhase = "admitted" /\ \E m \in ReusedNoticeMsgs : srcInbox[m].reader = DroppedReader /\ m \notin carriedInbox)

\* Task R5 (NoNewMessage): #3 starts before R2, R2's old message is not carried, nobody sends a new one, and R2 hits its
\* time limit: the run ends failed. No liveness property asks this run to complete.
Wit_NoReceiveTimedOut ==
    ~(/\ \E m \in OrdMsgs : srcInbox[m].reader = DroppedReader /\ m \notin carriedInbox
      /\ nWinner[RNode(2)] = "timer" /\ nOutcome[RNode(2)] = "elapsed" /\ runStatus = "failed")

\* An unconsumed message accepted before the cut that expires exactly at it is left behind by an admitted re-run.
Wit_NoExpiredAtCutLeft ==
    ~(startPhase = "admitted" /\ \E m \in OrdMsgs : srcInbox[m].accept < CutTime /\ srcInbox[m].expire = CutTime
                                                     /\ srcInbox[m].reader = NoNode /\ m \notin carriedInbox)

\* Fix wave R3 witnesses.
\* I-INBOX: an unread WorkflowEnded@1 notice of a child whose spawn #3 does not reuse, inside the ordinary time window, is
\* left behind by an admitted re-run.
Wit_NoStrayNoticeLeft ==
    ~(startPhase = "admitted" /\ \E m \in StrayNoticeMsgs : srcInbox[m].accept <= CutTime /\ srcInbox[m].expire > CutTime
                                                              /\ srcInbox[m].reader = NoNode /\ m \notin carriedInbox)

\* RR-1: a message carried through two generations, with #3's cut inside #2's copied prefix, is carried, taken by #3's
\* new receive, and the run completes.
Wit_NoCarryAcrossGenerations ==
    ~(SrcCarried /\ \E m \in OrdMsgs : m \in carriedInbox /\ inboxTaken[m] = 1 /\ runStatus = "completed")

\* MSG-1: #2's end began before m_late's acceptance read the clock (the race happens), and m_late is still carried, taken
\* by #3's new receive, and the run completes.
Wit_NoRacedAcceptCarried ==
    ~(accPc = "done" /\ endTxStart < accAt /\ "m_late" \in carriedInbox /\ inboxTaken["m_late"] = 1 /\ runStatus = "completed")

=============================================================================
