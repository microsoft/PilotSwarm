------------------------------- MODULE WorkflowRerun -------------------------------
(***************************************************************************)
(* Formal model of Workflow Re-run from a Chosen Visit (I7 v1) for         *)
(* microsoft/PilotSwarm.                                                   *)
(*                                                                         *)
(* Restates the unchanged 1.3.0 controller loop (AdmitExec/AdmitRecord,    *)
(* CollectExec/CollectRecord, FinishExec/FinishFailExec, PollCommand,      *)
(* CancelTx) from WorkflowRun.tla starting from an atomically copied       *)
(* prefix of completed visits, coupled with:                               *)
(*   - Two-step Start: ClaimRerun (writes rerunPin) + crash/new-rev +      *)
(*     AdmitRerunCopy (owner FOR SHARE -> def FOR SHARE -> #2 FOR SHARE,   *)
(*     #3 FOR NO KEY UPDATE in ascending session_id order);                *)
(*   - Three deleters with exact SQL lock modes:                           *)
(*       * SweeperDirect: blocking FOR NO KEY UPDATE on target #2,         *)
(*         NOWAIT on descendants (store.ts sweeperSoftDelete);             *)
(*       * DeleteWorkflow: blocking FOR NO KEY UPDATE on #2                *)
(*         (store.ts lockLiveSession);                                     *)
(*       * OwnerEnded: blocking lock on owner, then child Workflows        *)
(*         (#2, #3) in ascending session_id order (migration 0088);        *)
(*   - Compatibility check (FitCheck), cut guard (Guard), same-IR hash     *)
(*     check, plan budget adjustment (StepLimit - rerun_unwalked),         *)
(*     per-step MaxVisits, catch-all once across reused + new, approval    *)
(*     owner consent gate, carried inbox messages, receive totalSeconds    *)
(*     anchor reset, and 2-generation origin flattening (#1 -> #2 -> #3).  *)
(*                                                                         *)
(* Lock waits are modeled as disabled actions so any lock cycle surfaces   *)
(* as a TLC deadlock (CHECK_DEADLOCK TRUE on every case).                  *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    SourceKind,         \* "loop" | "catchall" | "parallel" | "approval" | "inbox"
    Mode,               \* "run_again" | "continue"
    Target,             \* "same" | "fix_chosen" | "reroute_taken"
    Generations,        \* 1 or 2 (#1 -> #2 -> #3)
    Actor,              \* "owner" | "agent" | "admin"
    MaxVisits,          \* per-step visit limit for S (e.g. 2)
    StepLimit,          \* run limits.maxNodeExecutions (e.g. 3 or 5)
    AllowDeleters,      \* enable SweeperDirect, DeleteWorkflow, OwnerEnded
    AllowOwnerEnd,      \* enable OwnerEnded specifically (locks owner -> #2 -> #3)
    AllowClaimCrash,    \* allow crash + new revision saved between Claim and Admit
    AllowCtrlCmds,      \* allow Pause/Resume, Stop, Cancel during pass-over/run
    AllowRetry,         \* allow AdmitExec retry before AdmitRecord during pass-over
    AllowCan,           \* allow ContinueAsNew during pass-over
    FitCheck,           \* TRUE = checkRerunCompatibility enforced; FALSE = bypassed
    Guard,              \* TRUE = enterNode cut guard enforced; FALSE = bypassed
    PlanBudget,         \* TRUE = plan subtracts rerun_unwalked; FALSE = fault
    FlatOrigin,         \* TRUE = COALESCE(reused_from, id); FALSE = fault
    AtomicCopy,         \* TRUE = run + copies in one TX; FALSE = fault
    ApprovalGate,       \* TRUE = owner-only approval reuse; FALSE = fault
    StartsDecided,      \* fault: controller starts effect for completed reused visit
    CopyKeepsIds,       \* fault: copy mutates source rows/IDs
    OrdinalsRestart,    \* fault: new visit restarts at ordinal 1
    DropsCatchAll,      \* fault: copy drops catch-all visit (resets caught)
    NoSourceLock,       \* fault: copy reads source live without FOR SHARE
    RepickOnResume,     \* fault: resumed Start after claim crash repicks latestRev
    CopyKeepsDeadline,  \* fault: copied receive visit keeps source total deadline
    DivergeInserts,     \* fault: cut guard inserts pending row before failing
    CarryLateMessage,   \* fault: inbox carry copies post-cut message
    LockNewBeforeOwner  \* fault: copy locks #2/#3 before owner (deadlocks OwnerEnded)

ASSUME SourceKind \in {"loop", "catchall", "parallel", "approval", "inbox"}
ASSUME Mode \in {"run_again", "continue"}
ASSUME Target \in {"same", "fix_chosen", "reroute_taken"}
ASSUME Generations \in {1, 2}
ASSUME Actor \in {"owner", "agent", "admin"}
ASSUME MaxVisits \in 1..3
ASSUME StepLimit \in 2..6
ASSUME {AllowDeleters, AllowOwnerEnd, AllowClaimCrash, AllowCtrlCmds, AllowRetry, AllowCan,
        FitCheck, Guard, PlanBudget, FlatOrigin, AtomicCopy, ApprovalGate,
        StartsDecided, CopyKeepsIds, OrdinalsRestart, DropsCatchAll,
        NoSourceLock, RepickOnResume, CopyKeepsDeadline, DivergeInserts,
        CarryLateMessage, LockNewBeforeOwner} \subseteq BOOLEAN

-----------------------------------------------------------------------------
(* Node universe and static source run definition                          *)

NoNode == <<"none", 0>>
SNode(i) == <<"S", i>>
ANode == <<"A", 1>>
PNode == <<"P", 1>>
LNode == <<"L", 1>>     \* Unwalked lane visit inside P (scope "P#0")
RNode(i) == <<"R", i>>
HNode(i) == <<"H", i>>
TNode == <<"T", 1>>

TopNodes == {SNode(1), SNode(2), SNode(3), ANode, PNode, RNode(1), RNode(2), HNode(1), HNode(2), TNode}
LaneNodes == {LNode}
AllNodes == TopNodes \cup LaneNodes
WorkNodes == AllNodes \ {TNode}
InboxMsgs == {"m1", "m2"}
WaitingAtCut == {"m1"}  \* m1 was accepted before cut; m2 arrived after cut

Active == {"admitted", "running", "paused"}
Terminal == {"completed", "failed", "cancelled", "stopped"}
Refused == {"refused_source_gone", "refused_owner_ended", "refused_incompatible", "refused_approval"}

\* Initial state of the source run #2 (ended, immutable).
\* Each source visit has outcome, resultKind, and whether it had a source deadline.
SrcReusedTop ==
    CASE SourceKind = "loop" /\ Mode = "run_again" -> <<SNode(1)>>
      [] SourceKind = "loop" /\ Mode = "continue"  -> <<SNode(1), SNode(2)>>
      [] SourceKind = "catchall"                   -> <<SNode(1), HNode(1)>>
      [] SourceKind = "parallel"                   -> <<PNode>>
      [] SourceKind = "approval"                   -> <<ANode>>
      [] SourceKind = "inbox"                      -> <<RNode(1)>>

SrcReusedLanes == IF SourceKind = "parallel" THEN {LNode} ELSE {}

ExpectedReused ==
    {SrcReusedTop[i] : i \in 1..Len(SrcReusedTop)} \cup SrcReusedLanes

\* Unwalked lane visits count stored on workflow_runs.rerun_unwalked
UnwalkedCount == Cardinality(SrcReusedLanes)

HasApproval == ANode \in ExpectedReused

InitSrcOutcome(x) ==
    CASE SourceKind = "loop" /\ x = SNode(1)     -> "again"
      [] SourceKind = "loop" /\ x = SNode(2)     -> "again"
      [] SourceKind = "catchall" /\ x = SNode(1) -> "error"
      [] SourceKind = "catchall" /\ x = HNode(1) -> "ok"
      [] SourceKind = "parallel" /\ x = PNode    -> "ok"
      [] SourceKind = "parallel" /\ x = LNode    -> "ok"
      [] SourceKind = "approval" /\ x = ANode    -> "approved"
      [] SourceKind = "inbox" /\ x = RNode(1)    -> "again"
      [] OTHER -> "none"

InitSrcKind(x) ==
    CASE InitSrcOutcome(x) = "error" -> "runtime_error"
      [] InitSrcOutcome(x) = "none"  -> "none"
      [] OTHER -> "business"

InitSrcNodes == [x \in AllNodes |-> [outcome |-> InitSrcOutcome(x), kind |-> InitSrcKind(x)]]

\* Origin of each source visit: in gen 1, #2 actually ran it ("wf2");
\* in gen 2, #2 itself reused it from #1 ("wf1").
SrcOrigin(x) == IF Generations = 2 THEN "wf1" ELSE "wf2"
ActualOrigin(x) == IF Generations = 2 THEN "wf1" ELSE "wf2"

\* Initial step of the workflow definition
InitialStep ==
    CASE SourceKind = "parallel" -> PNode
      [] SourceKind = "approval" -> ANode
      [] SourceKind = "inbox"    -> RNode(1)
      [] OTHER -> SNode(1)

\* Expected cut coordinates recorded in rerun_resume
ExpectedCutNode ==
    CASE SourceKind = "loop" /\ Mode = "run_again" -> SNode(2)
      [] SourceKind = "loop" /\ Mode = "continue"  -> SNode(3)
      [] SourceKind = "catchall"                   -> SNode(2)
      [] SourceKind = "parallel"                   -> SNode(1)
      [] SourceKind = "approval"                   -> SNode(1)
      [] SourceKind = "inbox"                      -> RNode(2)

LastReusedTop == SrcReusedTop[Len(SrcReusedTop)]

\* Next step routing for a completed top-level visit x with outcome o under Target
RouteTarget(x, o, caught, h1Present) ==
    IF Target = "reroute_taken" /\ x = SNode(1) /\ o = "again"
      THEN TNode
    ELSE CASE x[1] = "S" /\ o = "again"     -> SNode(x[2] + 1)
           [] x[1] = "S" /\ o = "ok"        -> TNode
           [] x[1] = "S" /\ o = "exhausted" -> TNode
           [] x[1] = "S" /\ o = "error"     -> IF ~caught
                                                 THEN (IF h1Present /\ x = SNode(2) THEN HNode(2) ELSE HNode(1))
                                                 ELSE NoNode
           [] x[1] = "H" /\ o = "ok"        -> IF SourceKind = "catchall" THEN SNode(2) ELSE TNode
           [] x[1] = "H" /\ o = "error"     -> NoNode
           [] x[1] = "P" /\ o = "ok"        -> SNode(1)
           [] x[1] = "A" /\ o = "approved"  -> SNode(1)
           [] x[1] = "R" /\ o = "again"     -> RNode(x[2] + 1)
           [] x[1] = "R" /\ o = "msg"       -> TNode
           [] OTHER -> NoNode

\* Allowed outcomes when a non-reused work node executes
NewWorkOutcomes(x) ==
    CASE x[1] = "S" -> IF SourceKind = "catchall" THEN {"error", "ok"}
                       ELSE IF SourceKind = "parallel" THEN {"ok", "again"}
                       ELSE IF SourceKind = "approval" THEN {"ok"}
                       ELSE {"again", "ok", "error"}
      [] x[1] = "H" -> {"ok"}
      [] x[1] = "R" -> {"msg"}
      [] OTHER -> {"ok"}

\* Maximum ordinal of a step st among reused visits
MaxReusedOrd(st) ==
    LET ords == {x[2] : x \in {y \in ExpectedReused : y[1] = st}}
    IN IF ords = {} THEN 0 ELSE CHOOSE m \in ords : \A o \in ords : m >= o

-----------------------------------------------------------------------------
VARIABLES
    \* Session & lock state (owner, def, source #2, new #3)
    ownerLive,          \* owner session live
    srcLive,            \* source workflow #2 live
    srcNodes,           \* source #2 visit rows (must remain untouched)
    srcDeletedAfterCopy,\* witness tracker: deleter deleted #2 after #3 committed
    latestRev,          \* latest saved definition revision (1, incremented to 2 on save)
    ownerLock,          \* "free" | "copy_share" | "owner_ended_excl"
    defLock,            \* "free" | "copy_share"
    srcLock,            \* "free" | "copy_share" | "sweeper_excl" | "delwf_excl" | "owner_ended_excl"
    newLock,            \* "free" | "copy_excl" | "owner_ended_excl"

    \* Start & claim state
    startPhase,         \* "idle" | "claimed" | "crashed" | "lock_step1" | "lock_step2" | "partial_run" | "admitted" | Refused
    rerunPin,           \* [rev |-> 1..2, mode |-> Mode] or "none"
    admittedRev,        \* 0 | 1 | 2
    copySawSrcLive,     \* used only by NoSourceLock fault
    copiedFromLive,     \* whether srcLive was TRUE when Copy committed
    pinnedResumed,      \* witness tracker: Start resumed from claim crash

    \* Re-run #3 store state
    runStatus,          \* "none" | Active | Terminal
    failCode,           \* "none" | "rerun_diverged" | "unhandled_error" | "limit_exceeded"
    nState,             \* [AllNodes -> "absent" | "pending" | "completed"]
    nWinner,            \* [AllNodes -> "none" | "reused" | "effect" | "cancel" | "controller" | "delete"]
    nOutcome,           \* [AllNodes -> string]
    nResultKind,        \* [AllNodes -> "none" | "business" | "runtime_error"]
    nOrigin,            \* [AllNodes -> "none" | "wf1" | "wf2" | "wf3"]
    nDeadline,          \* [AllNodes -> "none" | "source" | "new"]
    reusedSet,          \* subset of AllNodes that are reused copies
    newVisits,          \* subset of AllNodes admitted fresh (not reused)
    resumedAtCut,       \* rerun_resumed_at IS NOT NULL
    firstNew,           \* first non-reused node admitted
    firstNewPred,       \* predecessor of first non-reused node
    events,             \* event counters for Inv_EventsOnce

    \* Carried inbox state for #3
    carriedInbox,       \* subset of InboxMsgs copied into #3
    inboxTaken,         \* [InboxMsgs -> 0..2]

    \* Controller state (1.3.0) for #3
    pc,                 \* "idle" | "begin" | "poll" | "admit" | "start" | "collect" | "wait" | "finish" | "finishFail" | "cancel" | "done"
    curNode,            \* current cursor node in TopNodes \cup {NoNode}
    curPred,            \* predecessor of current cursor
    curPending,         \* currently pending node in TopNodes \cup {NoNode}
    curCaught,          \* controller catchAllEntered flag
    curSteps,           \* controller walked steps counter
    planMaxSteps,       \* maxNodeExecutions returned by plan activity
    actRes,             \* result of latest activity Exec before Record
    retriedInPassOver,  \* witness tracker
    canInPassOver,      \* witness tracker

    \* Effects & commands
    eff,                \* [WorkNodes -> "absent" | "started" | "done"]
    q,                  \* controller command queue ("cancel")
    pauseUsed,          \* bound pause/resume to 1
    stopRequested,      \* stop requested flag
    cancelSent,         \* cancel sent flag

    \* Deleter state machines
    sweeperPc,          \* "idle" | "locked_target" | "done" | "busy"
    delWfPc,            \* "idle" | "locked_src" | "done"
    ownerEndPc          \* "idle" | "locked_owner" | "done"

lockVars == <<ownerLock, defLock, srcLock, newLock>>
sessionVars == <<ownerLive, srcLive, srcNodes, srcDeletedAfterCopy, latestRev>>
startVars == <<startPhase, rerunPin, admittedRev, copySawSrcLive, copiedFromLive, pinnedResumed>>
runVars == <<runStatus, failCode, nState, nWinner, nOutcome, nResultKind, nOrigin, nDeadline,
             reusedSet, newVisits, resumedAtCut, firstNew, firstNewPred, events>>
inboxVars == <<carriedInbox, inboxTaken>>
ctrlVars == <<pc, curNode, curPred, curPending, curCaught, curSteps, planMaxSteps, actRes,
              retriedInPassOver, canInPassOver>>
effCmdVars == <<eff, q, pauseUsed, stopRequested, cancelSent>>
delVars == <<sweeperPc, delWfPc, ownerEndPc>>
vars == <<lockVars, sessionVars, startVars, runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

-----------------------------------------------------------------------------
(* Type invariant                                                          *)

Outcomes == {"none", "again", "ok", "error", "approved", "msg", "exhausted", "cancelled", "succeeded"}

TypeOK ==
    /\ ownerLive \in BOOLEAN /\ srcLive \in BOOLEAN /\ srcDeletedAfterCopy \in BOOLEAN
    /\ srcNodes \in [AllNodes -> [outcome: Outcomes, kind: {"none", "business", "runtime_error"}]]
    /\ latestRev \in 1..2
    /\ ownerLock \in {"free", "copy_share", "owner_ended_excl"}
    /\ defLock \in {"free", "copy_share"}
    /\ srcLock \in {"free", "copy_share", "sweeper_excl", "delwf_excl", "owner_ended_excl"}
    /\ newLock \in {"free", "copy_excl", "owner_ended_excl"}
    /\ startPhase \in {"idle", "claimed", "crashed", "lock_step1", "lock_step2", "partial_run", "admitted"} \cup Refused
    /\ rerunPin \in [rev: 0..2, mode: {"none", "run_again", "continue"}]
    /\ admittedRev \in 0..2
    /\ copySawSrcLive \in BOOLEAN /\ copiedFromLive \in BOOLEAN /\ pinnedResumed \in BOOLEAN
    /\ runStatus \in {"none"} \cup Active \cup Terminal
    /\ failCode \in {"none", "rerun_diverged", "unhandled_error", "limit_exceeded"}
    /\ nState \in [AllNodes -> {"absent", "pending", "completed"}]
    /\ nWinner \in [AllNodes -> {"none", "reused", "effect", "cancel", "controller", "delete"}]
    /\ nOutcome \in [AllNodes -> Outcomes]
    /\ nResultKind \in [AllNodes -> {"none", "business", "runtime_error"}]
    /\ nOrigin \in [AllNodes -> {"none", "wf1", "wf2", "wf3"}]
    /\ nDeadline \in [AllNodes -> {"none", "source", "new"}]
    /\ reusedSet \subseteq AllNodes /\ newVisits \subseteq AllNodes
    /\ resumedAtCut \in BOOLEAN
    /\ firstNew \in AllNodes \cup {NoNode}
    /\ firstNewPred \in AllNodes \cup {NoNode}
    /\ events.started \in 0..2 /\ events.ended \in 0..2
    /\ events.stateStarted \in [AllNodes -> 0..2]
    /\ events.stateCompleted \in [AllNodes -> 0..2]
    /\ carriedInbox \subseteq InboxMsgs
    /\ inboxTaken \in [InboxMsgs -> 0..2]
    /\ pc \in {"idle", "begin", "poll", "admit", "start", "collect", "wait", "finish", "finishFail", "cancel", "done"}
    /\ curNode \in TopNodes \cup {NoNode}
    /\ curPred \in TopNodes \cup {NoNode}
    /\ curPending \in TopNodes \cup {NoNode}
    /\ curCaught \in BOOLEAN
    /\ curSteps \in 0..(StepLimit + 2)
    /\ planMaxSteps \in 0..(StepLimit + 2)
    /\ actRes \in {"none", "pending", "completed", "paused", "notAdmitted", "nothing", "ended"} \cup Outcomes
    /\ retriedInPassOver \in BOOLEAN /\ canInPassOver \in BOOLEAN
    /\ eff \in [WorkNodes -> {"absent", "started", "done"}]
    /\ q \in Seq({"cancel"})
    /\ pauseUsed \in BOOLEAN /\ stopRequested \in BOOLEAN /\ cancelSent \in BOOLEAN
    /\ sweeperPc \in {"idle", "locked_target", "done", "busy"}
    /\ delWfPc \in {"idle", "locked_src", "done"}
    /\ ownerEndPc \in {"idle", "locked_owner", "done"}

-----------------------------------------------------------------------------
(* Initial state                                                           *)

Init ==
    /\ ownerLive = TRUE
    /\ srcLive = TRUE
    /\ srcNodes = InitSrcNodes
    /\ srcDeletedAfterCopy = FALSE
    /\ latestRev = 1
    /\ ownerLock = "free" /\ defLock = "free" /\ srcLock = "free" /\ newLock = "free"
    /\ startPhase = "idle"
    /\ rerunPin = [rev |-> 0, mode |-> "none"]
    /\ admittedRev = 0
    /\ copySawSrcLive = FALSE
    /\ copiedFromLive = FALSE
    /\ pinnedResumed = FALSE
    /\ runStatus = "none"
    /\ failCode = "none"
    /\ nState = [x \in AllNodes |-> "absent"]
    /\ nWinner = [x \in AllNodes |-> "none"]
    /\ nOutcome = [x \in AllNodes |-> "none"]
    /\ nResultKind = [x \in AllNodes |-> "none"]
    /\ nOrigin = [x \in AllNodes |-> "none"]
    /\ nDeadline = [x \in AllNodes |-> "none"]
    /\ reusedSet = {}
    /\ newVisits = {}
    /\ resumedAtCut = FALSE
    /\ firstNew = NoNode
    /\ firstNewPred = NoNode
    /\ events = [started |-> 0, ended |-> 0,
                 stateStarted |-> [x \in AllNodes |-> 0],
                 stateCompleted |-> [x \in AllNodes |-> 0]]
    /\ carriedInbox = {}
    /\ inboxTaken = [m \in InboxMsgs |-> 0]
    /\ pc = "idle"
    /\ curNode = InitialStep
    /\ curPred = NoNode
    /\ curPending = NoNode
    /\ curCaught = FALSE
    /\ curSteps = 0
    /\ planMaxSteps = StepLimit
    /\ actRes = "none"
    /\ retriedInPassOver = FALSE
    /\ canInPassOver = FALSE
    /\ eff = [x \in WorkNodes |-> "absent"]
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

CopyOriginOf(x) ==
    IF FlatOrigin THEN SrcOrigin(x) ELSE "wf2"

CopyDeadlineOf(x) ==
    IF CopyKeepsDeadline /\ x = RNode(1) THEN "source" ELSE "none"

TargetInbox ==
    IF SourceKind = "inbox"
      THEN IF CarryLateMessage THEN InboxMsgs ELSE WaitingAtCut
      ELSE {}

ReleaseCopyLocks ==
    /\ ownerLock' = IF ownerLock = "copy_share" THEN "free" ELSE ownerLock
    /\ defLock' = IF defLock = "copy_share" THEN "free" ELSE defLock
    /\ srcLock' = IF srcLock = "copy_share" THEN "free" ELSE srcLock
    /\ newLock' = IF newLock = "copy_excl" THEN "free" ELSE newLock

-----------------------------------------------------------------------------
(* Phase 1: Two-step Start (ClaimRerun + Crash/NewRev + AdmitRerunCopy)    *)

ClaimRerun ==
    /\ startPhase = "idle"
    /\ IF ownerLive
         THEN /\ startPhase' = "claimed"
              /\ rerunPin' = [rev |-> latestRev, mode |-> Mode]
         ELSE /\ startPhase' = "refused_owner_ended"
              /\ UNCHANGED rerunPin
    /\ UNCHANGED <<lockVars, sessionVars, admittedRev, copySawSrcLive, copiedFromLive, pinnedResumed,
                   runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

SaveNewRevision ==
    /\ AllowClaimCrash
    /\ startPhase \in {"claimed", "crashed"}
    /\ latestRev = 1
    /\ latestRev' = 2
    /\ UNCHANGED <<lockVars, ownerLive, srcLive, srcNodes, srcDeletedAfterCopy, startVars,
                   runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

ClaimCrash ==
    /\ AllowClaimCrash
    /\ startPhase = "claimed"
    /\ ~pinnedResumed
    /\ startPhase' = "crashed"
    /\ UNCHANGED <<lockVars, sessionVars, rerunPin, admittedRev, copySawSrcLive, copiedFromLive, pinnedResumed,
                   runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

ResumeAfterClaimCrash ==
    /\ startPhase = "crashed"
    /\ startPhase' = "claimed"
    /\ pinnedResumed' = TRUE
    /\ UNCHANGED <<lockVars, sessionVars, rerunPin, admittedRev, copySawSrcLive, copiedFromLive,
                   runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

\* Normal lock acquisition order:
\*   Step 1: owner FOR SHARE -> def FOR SHARE (requireSessionStartLocked)
\*   Step 2: #2 FOR SHARE, #3 FOR NO KEY UPDATE in session_id ASC order (lockSessionPair)
\* Fault LockNewBeforeOwner reverses these two steps, deadlocking with OwnerEnded.
\* Fault NoSourceLock skips locking #2 (srcLock) and reads srcLive unlocked in Step 1.

CopyLockStep1 ==
    /\ startPhase = "claimed"
    /\ IF LockNewBeforeOwner
         THEN /\ srcLock = "free" /\ newLock = "free"
              /\ srcLock' = "copy_share" /\ newLock' = "copy_excl"
              /\ UNCHANGED <<ownerLock, defLock, copySawSrcLive>>
         ELSE /\ ownerLock = "free" /\ defLock = "free"
              /\ ownerLock' = "copy_share" /\ defLock' = "copy_share"
              /\ copySawSrcLive' = IF NoSourceLock THEN srcLive ELSE copySawSrcLive
              /\ UNCHANGED <<srcLock, newLock>>
    /\ startPhase' = "lock_step1"
    /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, copiedFromLive, pinnedResumed,
                   runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

CopyLockStep2 ==
    /\ startPhase = "lock_step1"
    /\ IF LockNewBeforeOwner
         THEN /\ ownerLock = "free" /\ defLock = "free"
              /\ ownerLock' = "copy_share" /\ defLock' = "copy_share"
              /\ UNCHANGED <<srcLock, newLock>>
         ELSE IF NoSourceLock
                THEN /\ newLock = "free"
                     /\ newLock' = "copy_excl"
                     /\ UNCHANGED <<ownerLock, defLock, srcLock>>
                ELSE /\ srcLock = "free" /\ newLock = "free"
                     /\ srcLock' = "copy_share" /\ newLock' = "copy_excl"
                     /\ UNCHANGED <<ownerLock, defLock>>
    /\ startPhase' = "lock_step2"
    /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, copySawSrcLive, copiedFromLive, pinnedResumed,
                   runVars, inboxVars, ctrlVars, effCmdVars, delVars>>

CopyCommit ==
    /\ startPhase = "lock_step2"
    /\ LET effectiveSrcLive == IF NoSourceLock THEN copySawSrcLive ELSE srcLive
           chosenRev == IF RepickOnResume /\ pinnedResumed THEN latestRev ELSE rerunPin.rev
       IN
       IF ~ownerLive
         THEN /\ startPhase' = "refused_owner_ended"
              /\ ReleaseCopyLocks
              /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, copySawSrcLive, copiedFromLive, pinnedResumed,
                             runVars, inboxVars, ctrlVars, effCmdVars, delVars>>
       ELSE IF ~effectiveSrcLive
         THEN /\ startPhase' = "refused_source_gone"
              /\ ReleaseCopyLocks
              /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, copySawSrcLive, copiedFromLive, pinnedResumed,
                             runVars, inboxVars, ctrlVars, effCmdVars, delVars>>
       ELSE IF FitCheck /\ Target = "reroute_taken"
         THEN /\ startPhase' = "refused_incompatible"
              /\ ReleaseCopyLocks
              /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, copySawSrcLive, copiedFromLive, pinnedResumed,
                             runVars, inboxVars, ctrlVars, effCmdVars, delVars>>
       ELSE IF ApprovalGate /\ HasApproval /\ Actor # "owner"
         THEN /\ startPhase' = "refused_approval"
              /\ ReleaseCopyLocks
              /\ UNCHANGED <<sessionVars, rerunPin, admittedRev, copySawSrcLive, copiedFromLive, pinnedResumed,
                             runVars, inboxVars, ctrlVars, effCmdVars, delVars>>
       ELSE IF ~AtomicCopy
         \* Fault rr-df-copy-not-atomic: run row commits before copies exist!
         THEN /\ startPhase' = "partial_run"
              /\ admittedRev' = chosenRev
              /\ copiedFromLive' = srcLive
              /\ runStatus' = "admitted"
              /\ ReleaseCopyLocks
              /\ UNCHANGED <<sessionVars, rerunPin, copySawSrcLive, pinnedResumed,
                             failCode, nState, nWinner, nOutcome, nResultKind, nOrigin, nDeadline,
                             reusedSet, newVisits, resumedAtCut, firstNew, firstNewPred, events,
                             inboxVars, ctrlVars, effCmdVars, delVars>>
       ELSE \* Normal atomic commit of run row + copied prefix + carried inbox
            /\ startPhase' = "admitted"
            /\ admittedRev' = chosenRev
            /\ copiedFromLive' = srcLive
            /\ runStatus' = "admitted"
            /\ nState' = [x \in AllNodes |-> IF x \in ExpectedReused THEN "completed" ELSE "absent"]
            /\ nWinner' = [x \in AllNodes |-> IF x \in ExpectedReused THEN "reused" ELSE "none"]
            /\ nOutcome' = [x \in AllNodes |-> IF x \in ExpectedReused THEN srcNodes[x].outcome ELSE "none"]
            /\ nResultKind' = [x \in AllNodes |-> IF x \in ExpectedReused THEN srcNodes[x].kind ELSE "none"]
            /\ nOrigin' = [x \in AllNodes |-> IF x \in ExpectedReused THEN CopyOriginOf(x) ELSE "none"]
            /\ nDeadline' = [x \in AllNodes |-> IF x \in ExpectedReused THEN CopyDeadlineOf(x) ELSE "none"]
            /\ reusedSet' = ExpectedReused
            /\ carriedInbox' = TargetInbox
            /\ srcNodes' = IF CopyKeepsIds
                             THEN [srcNodes EXCEPT ![LastReusedTop].outcome = "cancelled"]
                             ELSE srcNodes
            /\ pc' = "begin"
            /\ ReleaseCopyLocks
            /\ UNCHANGED <<ownerLive, srcLive, srcDeletedAfterCopy, latestRev, rerunPin, copySawSrcLive, pinnedResumed,
                           failCode, newVisits, resumedAtCut, firstNew, firstNewPred, events,
                           inboxTaken, curNode, curPred, curPending, curCaught, curSteps, planMaxSteps, actRes,
                           retriedInPassOver, canInPassOver, effCmdVars, delVars>>

CopyFinishPartial ==
    /\ startPhase = "partial_run"
    /\ startPhase' = "admitted"
    /\ nState' = [x \in AllNodes |-> IF x \in ExpectedReused THEN "completed" ELSE "absent"]
    /\ nWinner' = [x \in AllNodes |-> IF x \in ExpectedReused THEN "reused" ELSE "none"]
    /\ nOutcome' = [x \in AllNodes |-> IF x \in ExpectedReused THEN srcNodes[x].outcome ELSE "none"]
    /\ nResultKind' = [x \in AllNodes |-> IF x \in ExpectedReused THEN srcNodes[x].kind ELSE "none"]
    /\ nOrigin' = [x \in AllNodes |-> IF x \in ExpectedReused THEN CopyOriginOf(x) ELSE "none"]
    /\ nDeadline' = [x \in AllNodes |-> IF x \in ExpectedReused THEN CopyDeadlineOf(x) ELSE "none"]
    /\ reusedSet' = ExpectedReused
    /\ carriedInbox' = TargetInbox
    /\ pc' = "begin"
    /\ UNCHANGED <<lockVars, sessionVars, rerunPin, admittedRev, copySawSrcLive, copiedFromLive, pinnedResumed,
                   runStatus, failCode, newVisits, resumedAtCut, firstNew, firstNewPred, events,
                   inboxTaken, curNode, curPred, curPending, curCaught, curSteps, planMaxSteps, actRes,
                   retriedInPassOver, canInPassOver, effCmdVars, delVars>>

-----------------------------------------------------------------------------
(* Phase 2: Three Deleters (SweeperDirect, DeleteWorkflow, OwnerEnded)     *)

\* 1. SweeperDirect: blocking FOR NO KEY UPDATE on target #2, NOWAIT on descendants
SweeperLockTarget ==
    /\ AllowDeleters
    /\ sweeperPc = "idle"
    /\ srcLive
    /\ srcLock = "free"
    /\ srcLock' = "sweeper_excl"
    /\ sweeperPc' = "locked_target"
    /\ UNCHANGED <<ownerLock, defLock, newLock, sessionVars, startVars,
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
    /\ UNCHANGED <<ownerLock, defLock, newLock, ownerLive, srcNodes, latestRev,
                   startVars, runVars, inboxVars, ctrlVars, effCmdVars, delWfPc, ownerEndPc>>

\* 2. DeleteWorkflow (explicit delete): blocking FOR NO KEY UPDATE on #2
DelWfLock ==
    /\ AllowDeleters
    /\ delWfPc = "idle"
    /\ srcLive
    /\ srcLock = "free"
    /\ srcLock' = "delwf_excl"
    /\ delWfPc' = "locked_src"
    /\ UNCHANGED <<ownerLock, defLock, newLock, sessionVars, startVars,
                   runVars, inboxVars, ctrlVars, effCmdVars, sweeperPc, ownerEndPc>>

DelWfCommit ==
    /\ delWfPc = "locked_src"
    /\ srcLock' = "free"
    /\ delWfPc' = "done"
    /\ srcLive' = FALSE
    /\ srcDeletedAfterCopy' = (startPhase = "admitted")
    /\ UNCHANGED <<ownerLock, defLock, newLock, ownerLive, srcNodes, latestRev,
                   startVars, runVars, inboxVars, ctrlVars, effCmdVars, sweeperPc, ownerEndPc>>

\* 3. OwnerEnded (migration 0088 trigger): locks owner first, then child Workflows #2, #3 in ASC order
OwnerEndLockOwner ==
    /\ AllowOwnerEnd
    /\ ownerEndPc = "idle"
    /\ ownerLive
    /\ ownerLock = "free"
    /\ ownerLock' = "owner_ended_excl"
    /\ ownerEndPc' = "locked_owner"
    /\ UNCHANGED <<defLock, srcLock, newLock, sessionVars, startVars,
                   runVars, inboxVars, ctrlVars, effCmdVars, sweeperPc, delWfPc>>

OwnerEndCommit ==
    /\ ownerEndPc = "locked_owner"
    /\ srcLock = "free"
    /\ newLock = "free"
    /\ ownerLock' = "free"
    /\ ownerEndPc' = "done"
    /\ ownerLive' = FALSE
    /\ srcLive' = FALSE
    /\ IF runStatus \in Active
         THEN /\ runStatus' = "cancelled"
              /\ EndPendingNodes("delete")
         ELSE UNCHANGED <<runStatus, nState, nWinner, nOutcome, nResultKind>>
    /\ UNCHANGED <<defLock, srcLock, newLock, srcNodes, srcDeletedAfterCopy, latestRev,
                   startVars, failCode, nOrigin, nDeadline, reusedSet, newVisits, resumedAtCut,
                   firstNew, firstNewPred, events, inboxVars, ctrlVars, effCmdVars, sweeperPc, delWfPc>>

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
    /\ UNCHANGED <<lockVars, sessionVars, startVars, failCode, nState, nWinner, nOutcome, nResultKind,
                   nOrigin, nDeadline, reusedSet, newVisits, resumedAtCut, firstNew, firstNewPred,
                   inboxVars, curNode, curPred, curPending, curCaught, curSteps, actRes,
                   retriedInPassOver, canInPassOver, effCmdVars, delVars>>

PollCommand ==
    /\ pc = "poll"
    /\ IF q # <<>> /\ Head(q) = "cancel"
         THEN /\ pc' = "cancel"
              /\ q' = Tail(q)
              /\ UNCHANGED <<runVars, curNode, curPred, curPending, curCaught, curSteps, planMaxSteps, actRes,
                             retriedInPassOver, canInPassOver>>
       ELSE IF stopRequested /\ runStatus \in Active
         THEN /\ runStatus' = "stopped"
              /\ EndPendingNodes("controller")
              /\ events' = [events EXCEPT !.ended = @ + 1]
              /\ pc' = "done"
              /\ UNCHANGED <<q, failCode, nOrigin, nDeadline, reusedSet, newVisits, resumedAtCut,
                             firstNew, firstNewPred, curNode, curPred, curPending, curCaught, curSteps,
                             planMaxSteps, actRes, retriedInPassOver, canInPassOver>>
       ELSE IF runStatus = "paused"
         THEN FALSE
       ELSE IF runStatus \in Terminal
         THEN /\ pc' = "done"
              /\ UNCHANGED <<runVars, q, curNode, curPred, curPending, curCaught, curSteps, planMaxSteps,
                             actRes, retriedInPassOver, canInPassOver>>
       ELSE IF curSteps >= planMaxSteps
         THEN /\ runStatus' = "failed"
              /\ failCode' = "limit_exceeded"
              /\ EndPendingNodes("controller")
              /\ events' = [events EXCEPT !.ended = @ + 1]
              /\ pc' = "done"
              /\ UNCHANGED <<q, nOrigin, nDeadline, reusedSet, newVisits, resumedAtCut, firstNew, firstNewPred,
                             curNode, curPred, curPending, curCaught, curSteps, planMaxSteps, actRes,
                             retriedInPassOver, canInPassOver>>
       ELSE /\ pc' = "admit"
            /\ UNCHANGED <<runVars, q, curNode, curPred, curPending, curCaught, curSteps, planMaxSteps,
                           actRes, retriedInPassOver, canInPassOver>>
    /\ UNCHANGED <<lockVars, sessionVars, startVars, inboxVars, eff, pauseUsed, stopRequested, cancelSent, delVars>>

\* Optional ContinueAsNew during pass-over (preserves controller state)
ControllerCan ==
    /\ AllowCan
    /\ pc = "poll"
    /\ runStatus = "running"
    /\ curSteps >= 1
    /\ ~resumedAtCut
    /\ ~canInPassOver
    /\ canInPassOver' = TRUE
    /\ UNCHANGED <<lockVars, sessionVars, startVars, runVars, inboxVars,
                   pc, curNode, curPred, curPending, curCaught, curSteps, planMaxSteps, actRes,
                   retriedInPassOver, effCmdVars, delVars>>

\* Cut guard check (Design §5.2):
\*   run_again: curNode = ExpectedCutNode /\ curPred = LastReusedTop
\*   continue:  curPred = LastReusedTop
CutGuardMatches(x, pred) ==
    IF Mode = "run_again"
      THEN x = ExpectedCutNode /\ pred = LastReusedTop
      ELSE pred = LastReusedTop

\* Node to admit (OrdinalsRestart fault re-uses ordinal 1 for a step with reused visits)
AdmitCoord ==
    IF OrdinalsRestart /\ ~resumedAtCut /\ curNode[1] = "S" /\ MaxReusedOrd("S") > 0 /\ nState[curNode] = "absent"
      THEN SNode(1)
      ELSE curNode

\* Receive wait.totalSeconds anchor check (store.ts readReceiveTotalDeadline):
\* returns "source" if an earlier reused visit kept deadline_at != NULL, else "new".
ReceiveAnchor ==
    IF nDeadline[RNode(1)] = "source" THEN "source" ELSE "new"

AdmitExec ==
    /\ pc = "admit"
    /\ actRes = "none"
    /\ LET x == AdmitCoord IN
       IF nState[x] # "absent" /\ ~(OrdinalsRestart /\ x = SNode(1) /\ curNode = SNode(2))
         \* Pass-over hit on an existing copied row (idempotent read-only return)
         THEN /\ actRes' = nState[x]
              /\ UNCHANGED <<runVars, inboxVars>>
       ELSE IF runStatus = "paused"
         THEN /\ actRes' = "paused"
              /\ UNCHANGED <<runVars, inboxVars>>
       ELSE IF runStatus # "running"
         THEN /\ actRes' = "notAdmitted"
              /\ UNCHANGED <<runVars, inboxVars>>
       ELSE IF ~resumedAtCut /\ Guard /\ ~CutGuardMatches(curNode, curPred)
         \* Cut guard fired!
         THEN IF DivergeInserts
                \* Fault rr-df-diverge-inserts: inserts row before failing!
                THEN /\ nState' = [nState EXCEPT ![x] = "pending"]
                     /\ newVisits' = newVisits \cup {x}
                     /\ runStatus' = "failed"
                     /\ failCode' = "rerun_diverged"
                     /\ events' = [events EXCEPT !.ended = @ + 1]
                     /\ actRes' = "notAdmitted"
                     /\ UNCHANGED <<nWinner, nOutcome, nResultKind, nOrigin, nDeadline, reusedSet,
                                    resumedAtCut, firstNew, firstNewPred, inboxVars>>
                ELSE /\ runStatus' = "failed"
                     /\ failCode' = "rerun_diverged"
                     /\ EndPendingNodes("controller")
                     /\ events' = [events EXCEPT !.ended = @ + 1]
                     /\ actRes' = "notAdmitted"
                     /\ UNCHANGED <<nOrigin, nDeadline, reusedSet, newVisits, resumedAtCut,
                                    firstNew, firstNewPred, inboxVars>>
       ELSE \* Normal new admission (stamps rerun_resumed_at if first new visit!)
            LET isExhausted == (x[1] = "S" /\ x[2] > MaxVisits)
                canTakeCarried == (x[1] = "R" /\ \E m \in carriedInbox : inboxTaken[m] = 0)
                st == IF isExhausted \/ canTakeCarried THEN "completed" ELSE "pending"
            IN
            /\ nState' = [nState EXCEPT ![x] = st]
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
                 ELSE UNCHANGED <<resumedAtCut, firstNew, firstNewPred>>
            /\ events' = [events EXCEPT !.stateStarted[x] = @ + 1]
            /\ IF canTakeCarried
                 THEN LET m == CHOOSE msg \in carriedInbox : inboxTaken[msg] = 0
                      IN inboxTaken' = [inboxTaken EXCEPT ![m] = @ + 1]
                 ELSE UNCHANGED inboxTaken
            /\ actRes' = st
            /\ UNCHANGED <<runStatus, failCode, reusedSet, carriedInbox>>
    /\ UNCHANGED <<lockVars, sessionVars, startVars, pc, curNode, curPred, curPending, curCaught,
                   curSteps, planMaxSteps, retriedInPassOver, canInPassOver, effCmdVars, delVars>>

\* Retry of AdmitExec during pass-over (crash before AdmitRecord enters Duroxide history)
AdmitRetry ==
    /\ AllowRetry
    /\ pc = "admit"
    /\ actRes # "none"
    /\ ~resumedAtCut
    /\ ~retriedInPassOver
    /\ actRes' = "none"
    /\ retriedInPassOver' = TRUE
    /\ UNCHANGED <<lockVars, sessionVars, startVars, runVars, inboxVars,
                   pc, curNode, curPred, curPending, curCaught, curSteps, planMaxSteps,
                   canInPassOver, effCmdVars, delVars>>

AdmitRecord ==
    /\ pc = "admit"
    /\ actRes # "none"
    /\ IF actRes = "paused"
         THEN /\ pc' = "poll"
              /\ UNCHANGED <<curNode, curPred, curPending, curCaught, curSteps>>
       ELSE IF actRes = "notAdmitted"
         THEN /\ pc' = "done"
              /\ UNCHANGED <<curNode, curPred, curPending, curCaught, curSteps>>
       ELSE IF curNode = TNode
         THEN /\ pc' = "finish"
              /\ curSteps' = curSteps + 1
              /\ curPending' = TNode
              /\ UNCHANGED <<curNode, curPred, curCaught>>
       ELSE /\ curSteps' = curSteps + 1
            /\ curPending' = curNode
            /\ curCaught' = (curCaught \/ (curNode[1] = "H" /\ ~(DropsCatchAll /\ curNode \in reusedSet)))
            /\ pc' = IF actRes = "pending" \/ (StartsDecided /\ curNode \in reusedSet)
                       THEN "start"
                       ELSE "collect"
            /\ UNCHANGED <<curNode, curPred>>
    /\ actRes' = "none"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, runVars, inboxVars, planMaxSteps,
                   retriedInPassOver, canInPassOver, effCmdVars, delVars>>

StartEffect ==
    /\ pc = "start"
    /\ curPending \in WorkNodes
    /\ eff' = [eff EXCEPT ![curPending] = IF @ = "absent" THEN "started" ELSE @]
    /\ pc' = "collect"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, runVars, inboxVars,
                   curNode, curPred, curPending, curCaught, curSteps, planMaxSteps, actRes,
                   retriedInPassOver, canInPassOver, q, pauseUsed, stopRequested, cancelSent, delVars>>

CollectExec ==
    /\ pc = "collect"
    /\ actRes = "none"
    /\ IF nState[curPending] = "completed"
         THEN actRes' = nOutcome[curPending]
         ELSE actRes' = "nothing"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, runVars, inboxVars,
                   pc, curNode, curPred, curPending, curCaught, curSteps, planMaxSteps,
                   retriedInPassOver, canInPassOver, effCmdVars, delVars>>

CollectRecord ==
    /\ pc = "collect"
    /\ actRes # "none"
    /\ IF actRes = "nothing"
         THEN /\ pc' = "wait"
              /\ UNCHANGED <<curNode, curPred, curPending, curCaught>>
       ELSE IF actRes = "cancelled"
         THEN /\ pc' = "done"
              /\ UNCHANGED <<curNode, curPred, curPending, curCaught>>
       ELSE LET nxt == RouteTarget(curPending, actRes, curCaught, nState[HNode(1)] # "absent") IN
            IF nxt = NoNode
              THEN /\ pc' = "finishFail"
                   /\ UNCHANGED <<curNode, curPred, curPending, curCaught>>
              ELSE /\ pc' = "poll"
                   /\ curPred' = curPending
                   /\ curNode' = nxt
                   /\ curPending' = NoNode
                   /\ curCaught' = curCaught
    /\ actRes' = "none"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, runVars, inboxVars, curSteps, planMaxSteps,
                   retriedInPassOver, canInPassOver, effCmdVars, delVars>>

WaitStep ==
    /\ pc = "wait"
    /\ IF q # <<>> /\ Head(q) = "cancel"
         THEN /\ pc' = "cancel"
              /\ q' = Tail(q)
         ELSE /\ nState[curPending] = "completed"
              /\ pc' = "collect"
              /\ q' = q
    /\ UNCHANGED <<lockVars, sessionVars, startVars, runVars, inboxVars,
                   curNode, curPred, curPending, curCaught, curSteps, planMaxSteps, actRes,
                   retriedInPassOver, canInPassOver, eff, pauseUsed, stopRequested, cancelSent, delVars>>

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
    /\ UNCHANGED <<lockVars, sessionVars, startVars, failCode, nOrigin, nDeadline, reusedSet, newVisits,
                   resumedAtCut, firstNew, firstNewPred, inboxVars, curNode, curPred, curPending,
                   curCaught, curSteps, planMaxSteps, actRes, retriedInPassOver, canInPassOver,
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
    /\ UNCHANGED <<lockVars, sessionVars, startVars, nOrigin, nDeadline, reusedSet, newVisits,
                   resumedAtCut, firstNew, firstNewPred, inboxVars, curNode, curPred, curPending,
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
    /\ UNCHANGED <<lockVars, sessionVars, startVars, failCode, nOrigin, nDeadline, reusedSet, newVisits,
                   resumedAtCut, firstNew, firstNewPred, inboxVars, curNode, curPred, curPending,
                   curCaught, curSteps, planMaxSteps, actRes, retriedInPassOver, canInPassOver,
                   effCmdVars, delVars>>

\* Effect execution for a started non-reused work node (or faultily started reused node)
EffFinish(x) ==
    /\ x \in WorkNodes
    /\ eff[x] = "started"
    /\ \E o \in NewWorkOutcomes(x) :
         IF nState[x] = "pending" /\ runStatus \in Active
           THEN /\ nState' = [nState EXCEPT ![x] = "completed"]
                /\ nWinner' = [nWinner EXCEPT ![x] = "effect"]
                /\ nOutcome' = [nOutcome EXCEPT ![x] = o]
                /\ nResultKind' = [nResultKind EXCEPT ![x] = IF o = "error" THEN "runtime_error" ELSE "business"]
                /\ events' = [events EXCEPT !.stateCompleted[x] = @ + 1]
           ELSE UNCHANGED <<nState, nWinner, nOutcome, nResultKind, events>>
    /\ eff' = [eff EXCEPT ![x] = "done"]
    /\ UNCHANGED <<lockVars, sessionVars, startVars, runStatus, failCode, nOrigin, nDeadline,
                   reusedSet, newVisits, resumedAtCut, firstNew, firstNewPred, inboxVars, ctrlVars,
                   q, pauseUsed, stopRequested, cancelSent, delVars>>

\* External commands: Pause/Resume, Stop, Cancel
PauseRun ==
    /\ AllowCtrlCmds
    /\ ~pauseUsed
    /\ runStatus = "running"
    /\ runStatus' = "paused"
    /\ pauseUsed' = TRUE
    /\ UNCHANGED <<lockVars, sessionVars, startVars, failCode, nState, nWinner, nOutcome, nResultKind,
                   nOrigin, nDeadline, reusedSet, newVisits, resumedAtCut, firstNew, firstNewPred,
                   events, inboxVars, ctrlVars, eff, q, stopRequested, cancelSent, delVars>>

ResumeRun ==
    /\ AllowCtrlCmds
    /\ runStatus = "paused"
    /\ runStatus' = "running"
    /\ UNCHANGED <<lockVars, sessionVars, startVars, failCode, nState, nWinner, nOutcome, nResultKind,
                   nOrigin, nDeadline, reusedSet, newVisits, resumedAtCut, firstNew, firstNewPred,
                   events, inboxVars, ctrlVars, effCmdVars, delVars>>

RequestStop ==
    /\ AllowCtrlCmds
    /\ ~stopRequested
    /\ runStatus = "running"
    /\ stopRequested' = TRUE
    /\ UNCHANGED <<lockVars, sessionVars, startVars, runVars, inboxVars, ctrlVars,
                   eff, q, pauseUsed, cancelSent, delVars>>

SendCancel ==
    /\ AllowCtrlCmds
    /\ ~cancelSent
    /\ runStatus \in Active
    /\ cancelSent' = TRUE
    /\ q' = Append(q, "cancel")
    /\ UNCHANGED <<lockVars, sessionVars, startVars, runVars, inboxVars, ctrlVars,
                   eff, pauseUsed, stopRequested, delVars>>

\* Clean quiescence (no transaction holds any lock, Start is finished, controller & effects done)
Done ==
    /\ ownerLock = "free" /\ defLock = "free" /\ srcLock = "free" /\ newLock = "free"
    /\ sweeperPc \in {"idle", "done", "busy"}
    /\ delWfPc \in {"idle", "done"}
    /\ ownerEndPc \in {"idle", "done"}
    /\ (startPhase \in Refused \/ (startPhase = "admitted" /\ pc = "done"))
    /\ \A x \in WorkNodes : eff[x] \in {"absent", "done"}
    /\ UNCHANGED vars

-----------------------------------------------------------------------------
(* Next-state relation & Fairness                                          *)

StartProgress ==
    \/ ClaimRerun \/ ResumeAfterClaimCrash \/ CopyLockStep1 \/ CopyLockStep2
    \/ CopyCommit \/ CopyFinishPartial

DeleterCommit ==
    \/ SweeperCommit \/ DelWfCommit \/ OwnerEndCommit

CtrlProgress ==
    \/ BeginExec \/ PollCommand \/ AdmitExec \/ AdmitRecord \/ StartEffect
    \/ CollectExec \/ CollectRecord \/ WaitStep \/ FinishExec \/ FinishFailExec \/ CancelTx
    \/ ResumeRun

EffProgress == \E x \in WorkNodes : EffFinish(x)

Next ==
    \/ StartProgress
    \/ SaveNewRevision \/ ClaimCrash
    \/ SweeperLockTarget \/ DelWfLock \/ OwnerEndLockOwner \/ DeleterCommit
    \/ CtrlProgress \/ ControllerCan \/ AdmitRetry \/ EffProgress
    \/ PauseRun \/ RequestStop \/ SendCancel
    \/ Done

Fairness ==
    /\ WF_vars(StartProgress)
    /\ WF_vars(DeleterCommit)
    /\ WF_vars(CtrlProgress)
    /\ \A x \in WorkNodes : WF_vars(EffFinish(x))

Spec == Init /\ [][Next]_vars
LiveSpec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety Invariants & Properties                                          *)

\* 1. Reused set
Inv_ReusedNeverRuns ==
    \A x \in reusedSet \cap WorkNodes : eff[x] = "absent"

Inv_ReusedImmutable ==
    \A x \in reusedSet :
        /\ nState[x] = "completed"
        /\ nOutcome[x] = InitSrcNodes[x].outcome
        /\ nResultKind[x] = InitSrcNodes[x].kind

Inv_SourceUntouched ==
    srcNodes = InitSrcNodes

Inv_CopyAtomic ==
    (runStatus # "none") <=> (\A x \in ExpectedReused : nState[x] = "completed")

Inv_OriginRan ==
    \A x \in reusedSet : nOrigin[x] = ActualOrigin(x)

\* 2. Start
Inv_NoCopyFromDeleted ==
    (startPhase = "admitted") => copiedFromLive

Inv_PinnedChoice ==
    (startPhase = "admitted") => (rerunPin.rev > 0 /\ admittedRev = rerunPin.rev)

Inv_NoConsentReuse ==
    (HasApproval /\ startPhase = "admitted") => (Actor = "owner")

\* 3. Pass-over & cut
Inv_FirstNewAtCut ==
    resumedAtCut => CutGuardMatches(firstNew, firstNewPred)

Inv_NoWorkOnDiverge ==
    (runStatus = "failed" /\ failCode = "rerun_diverged") =>
        /\ \A x \in AllNodes \ reusedSet : nState[x] = "absent"
        /\ \A x \in WorkNodes : eff[x] = "absent"

Inv_OrdinalsContinue ==
    /\ \A x \in newVisits : x \notin reusedSet
    /\ \A x \in newVisits : \A y \in reusedSet : x[1] = y[1] => x[2] > y[2]
    /\ \A i \in 2..3 : nState[SNode(i)] # "absent" => nState[SNode(i - 1)] # "absent"
    /\ nState[RNode(2)] # "absent" => nState[RNode(1)] # "absent"
    /\ nState[HNode(2)] # "absent" => nState[HNode(1)] # "absent"

Inv_CatchAllOnce ==
    nState[HNode(2)] = "absent"

Inv_VisitLimit ==
    /\ eff[SNode(MaxVisits + 1)] = "absent"
    /\ (nState[SNode(MaxVisits + 1)] = "completed" => nOutcome[SNode(MaxVisits + 1)] \in {"exhausted", "cancelled"})

Inv_StepLimit ==
    Cardinality({x \in AllNodes : nState[x] # "absent"}) <= StepLimit

Inv_TotalFromFirstNew ==
    (RNode(2) \in newVisits) => (nDeadline[RNode(2)] = "new")

\* 4. Inbox
Inv_CarriedWereWaiting ==
    carriedInbox \subseteq WaitingAtCut

Inv_TakeOnce ==
    \A m \in InboxMsgs : inboxTaken[m] <= 1

\* 5. Unchanged from WorkflowRun.tla
Inv_EventsOnce ==
    /\ events.started <= 1
    /\ events.ended <= 1
    /\ \A x \in AllNodes : events.stateStarted[x] <= 1 /\ events.stateCompleted[x] <= 1

Inv_AdmissionOrder ==
    /\ \A i \in 2..3 : (SNode(i) \in newVisits) => (nState[SNode(i - 1)] = "completed")
    /\ (TNode \in newVisits) =>
         \E x \in WorkNodes : nState[x] = "completed" /\ nOutcome[x] \in {"ok", "exhausted", "msg", "again"}

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

Live_ReachesCut == <>(startPhase \in Refused \/ resumedAtCut \/ runStatus \in Terminal)

Live_Terminates == <>(startPhase \in Refused \/ runStatus \in Terminal)

-----------------------------------------------------------------------------
(* 13 Non-Vacuity Witnesses (each expected VIOLATED, exit 12)              *)

Wit_NeverResumes == ~resumedAtCut
Wit_NoReusedCatchAll == ~(startPhase = "admitted" /\ HNode(1) \in reusedSet)
Wit_NoFailAfterReusedCatchAll == ~(HNode(1) \in reusedSet /\ runStatus = "failed" /\ failCode = "unhandled_error")
Wit_NoExhausted == ~(\E x \in AllNodes : nOutcome[x] = "exhausted")
Wit_NoRetryInPassOver == ~retriedInPassOver
Wit_NoContinueAsNewInPassOver == ~canInPassOver
Wit_NoSecondGeneration == ~(Generations = 2 /\ runStatus = "completed")
Wit_NoDiverge == ~(runStatus = "failed" /\ failCode = "rerun_diverged")
Wit_NoSourceGone == ~(startPhase = "refused_source_gone")
Wit_NoDeleteAfterCopy == ~(srcDeletedAfterCopy /\ runStatus = "completed")
Wit_NoApprovalRefusal == ~(startPhase = "refused_approval")
Wit_NoCarriedTake == ~(\E m \in WaitingAtCut : inboxTaken[m] = 1)
Wit_NoPinnedResume == ~(pinnedResumed /\ startPhase = "admitted" /\ admittedRev = rerunPin.rev /\ latestRev > rerunPin.rev)

=============================================================================
