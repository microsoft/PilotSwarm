------------------------------- MODULE TurnCut -------------------------------
(***************************************************************************)
(* A cut turn: worker A's runTurn attempt is cancelled, by a graceful      *)
(* shutdown's drain or a lost activity lock, and duroxide runs the same    *)
(* turn (the same turnKey) again, on worker B or, after a lost lock, on A. *)
(* One session, one turn.                                                  *)
(*                                                                         *)
(* Mode "old" (releases up to 0.8.15): runTurnCommit saved every cut body  *)
(* under the turnKey with the result "cancelled", and the retry's          *)
(* already-committed recovery adopted it, so the orchestration ended the   *)
(* turn without running it (its case "cancelled" only traces). A commit   *)
(* that found that result under its key adopted it the same way.          *)
(* Mode "main" (0.8.16 and 0.8.17, #367): a drain cut throws before the    *)
(* commit and marks the session cut (markTurnCut); a graceful shutdown's   *)
(* workspace release and every sweep skip a marked session. A lost lock   *)
(* outside a drain still saves "cancelled", sets no mark, and is adopted. *)
(* Mode "fix" (this branch), on top of "main":                             *)
(*  - runTurnCommit skips a cancelled result and leaves the sentinel dirty *)
(*    (session-lifecycle.ts runTurnCommit, unpublished "cancelled");       *)
(*  - recoverAlreadyCommitted never adopts a stored cancelled result: the  *)
(*    retry runs the turn on top of it (session-lifecycle.ts);             *)
(*  - commitTurnSnapshot never adopts one: it returns its own result;      *)
(*  - a lost lock marks the session cut when the attempt latches the       *)
(*    cancel (latchCancelled), before it releases its run-turn lock; the   *)
(*    next attempt of the session clears the mark when it starts on A      *)
(*    (clearTurnCut).                                                      *)
(* Modes "upgrade-main" and "upgrade-old": A runs "main" or "old", and B   *)
(* runs the fix.                                                           *)
(*                                                                         *)
(* Content: "empty" (a first turn: the store holds no snapshot), "base"    *)
(* (the last committed turn), "cut" (what the cut attempt wrote of the     *)
(* turn), "turn" (the completed turn), "cutturn" (the turn run on top of   *)
(* the cut attempt's content). storeVer counts commits since the cut       *)
(* attempt started; a legacy publish replaces the content without a       *)
(* version. Workspace files are not modelled: "releasedCut" records that   *)
(* a shutdown released the cut session's workspace cleanly, so the next    *)
(* worker gets no partial-changes note for what the cut attempt changed.  *)
(*                                                                         *)
(* Not modelled: an attempt that completes before its cancel lands, the    *)
(* orchestration's retry count and timers, more than one retry, a retry    *)
(* on A while the retry on B still runs, a worker restart (a new runtime   *)
(* generation clears every mark), the session-store CAS details beyond     *)
(* the turnKey rule, and the eviction sweep's workspace release.           *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Mode,   \* "fix", "main", "old", "upgrade-main", "upgrade-old"
    Fault   \* "none", "commit-cut", "adopt-recover", "adopt-commit",
            \* "no-lock-mark", "no-release-skip", "no-sweep-skip"

ASSUME Mode \in {"fix", "main", "old", "upgrade-main", "upgrade-old"}
ASSUME Fault \in {"none", "commit-cut", "adopt-recover", "adopt-commit",
                  "no-lock-mark", "no-release-skip", "no-sweep-skip"}

VARIABLES
    \* the scenario, chosen at the start
    drain,       \* the cut comes from A's graceful shutdown (else a lost lock)
    first,       \* the turn is the session's first: the store holds no snapshot
    \* worker A
    a1,          \* the cut attempt: "running", "cancelled" (cancel issued), "cut" (latched), "returned" (lock released)
    mark,        \* A's cut mark (markTurnCut)
    localA,      \* A's local dir: "none" or its content
    markerA,     \* A's dir holds a committed snapshot marker
    sentA,       \* A's turn sentinel: "clean", "dirty"
    sd,          \* A's shutdown: "none" (no drain), "cutting", "released", "stopped"
    \* the retry
    a2,          \* "wait", "running", "ran", "done"
    where2,      \* "none", "A", "B"
    loc2,        \* the retry's working content
    base2,       \* the store version the retry resolved
    \* the session store
    storeC, storeKey, storeVer, storeLegacy,
    gh           \* ghost flags
vars == <<drain, first, a1, mark, localA, markerA, sentA, sd, a2, where2, loc2, base2,
          storeC, storeKey, storeVer, storeLegacy, gh>>
storeVars == <<storeC, storeKey, storeVer, storeLegacy>>

Code(w) == CASE Mode = "upgrade-main" -> (IF w = "A" THEN "main" ELSE "fix")
             [] Mode = "upgrade-old" -> (IF w = "A" THEN "old" ELSE "fix")
             [] OTHER -> Mode
(* A drain cut is not saved from "main" on (#367); a lost lock's cancelled *)
(* attempt only with the fix.                                              *)
SkipCutCommit == CASE Code("A") = "fix" -> drain \/ Fault # "commit-cut"
                   [] Code("A") = "main" -> drain
                   [] OTHER -> FALSE
MarkCut == CASE Code("A") = "fix" -> drain \/ Fault # "no-lock-mark"
              [] Code("A") = "main" -> drain
              [] OTHER -> FALSE
ReleaseSkip == Fault # "no-release-skip"
SweepSkip == Fault # "no-sweep-skip"
RecoverNoAdopt(w) == Code(w) = "fix" /\ Fault # "adopt-recover"
CommitNoAdopt(w) == Code(w) = "fix" /\ Fault # "adopt-commit"

Locked == a1 \in {"running", "cancelled", "cut"}
Advance(c) == IF c \in {"cut", "cutturn"} THEN "cutturn" ELSE "turn"
Aborted(c) == IF c \in {"cut", "cutturn"} THEN {"abortedBase"} ELSE {}

Init ==
    /\ drain \in BOOLEAN /\ first \in BOOLEAN
    /\ a1 = "running" /\ mark = FALSE
    /\ localA = IF first THEN "empty" ELSE "base"
    /\ markerA = ~first /\ sentA = "dirty"
    /\ sd = IF drain THEN "cutting" ELSE "none"
    /\ a2 = "wait" /\ where2 = "none" /\ loc2 = "empty" /\ base2 = 0
    /\ storeC = IF first THEN "empty" ELSE "base"
    /\ storeKey = "none" /\ storeVer = 0 /\ storeLegacy = FALSE
    /\ gh = {}

(* The drain or the lost lock cancels A's activity.                       *)
A1Cancel ==
    /\ a1 = "running" /\ a1' = "cancelled"
    /\ UNCHANGED <<drain, first, mark, localA, markerA, sentA, sd, a2, where2, loc2, base2, storeVars, gh>>

(* The body latches the cancel, having written part of the turn to the    *)
(* local dir, and marks the session where its code does: a drain cut      *)
(* from "main" on, a lost lock with the fix.                               *)
A1Latch ==
    /\ a1 = "cancelled" /\ a1' = "cut"
    /\ localA' = "cut" /\ mark' = MarkCut
    /\ UNCHANGED <<drain, first, markerA, sentA, sd, a2, where2, loc2, base2, storeVars, gh>>

(* The body's commit, then the lock is released. A skipped commit leaves  *)
(* the sentinel dirty. A saved one lands under the turnKey when the store  *)
(* is still at the version the attempt started from (else the store       *)
(* reports it committed or superseded, and nothing is written).            *)
A1Return ==
    /\ a1 = "cut" /\ a1' = "returned"
    /\ IF ~SkipCutCommit /\ storeVer = 0
       THEN /\ storeC' = localA /\ storeKey' = "cancelled" /\ storeVer' = 1 /\ storeLegacy' = FALSE
            /\ sentA' = "clean" /\ markerA' = TRUE
       ELSE UNCHANGED <<storeVars, sentA, markerA>>
    /\ UNCHANGED <<drain, first, mark, localA, sd, a2, where2, loc2, base2, gh>>

(* A sweep reclaims A's dir: a committed marker or a versioned store       *)
(* chain means a plain delete; otherwise a legacy dehydrate publishes the  *)
(* dir. The mark is not cleared.                                           *)
ReclaimA ==
    /\ localA' = "none"
    /\ IF localA = "none" \/ markerA \/ storeVer > 0
       THEN UNCHANGED storeVars
       ELSE /\ storeC' = localA /\ storeLegacy' = TRUE
            /\ UNCHANGED <<storeKey, storeVer>>

(* Graceful shutdown, after the drain cut the attempt:                    *)
(* releaseIdleWorkspaces skips a locked session and a marked one.         *)
SdRelease ==
    /\ sd = "cutting" /\ a1 # "running" /\ sd' = "released"
    /\ gh' = gh \cup (IF a1 = "returned" THEN {"returnBeforeRelease"} ELSE {})
                \cup (IF Locked \/ (ReleaseSkip /\ mark) THEN {} ELSE {"releasedCut"})
    /\ UNCHANGED <<drain, first, a1, mark, localA, markerA, sentA, a2, where2, loc2, base2, storeVars>>

(* ... then sweepIdleSessions(1): a session it does not skip has its      *)
(* workspace released first, then its dir reclaimed.                       *)
SdSweep ==
    /\ sd = "released" /\ sd' = "stopped"
    /\ IF Locked \/ (SweepSkip /\ mark)
       THEN UNCHANGED <<localA, storeVars, gh>>
       ELSE /\ ReclaimA
            /\ gh' = gh \cup {"releasedCut"}
    /\ UNCHANGED <<drain, first, a1, mark, markerA, sentA, a2, where2, loc2, base2>>

(* Without a drain, A's ordinary eviction sweep may reclaim the dir once  *)
(* the attempt returned, unless the session is marked (a retry running on  *)
(* A holds the dir: not swept).                                            *)
EvSweep ==
    /\ ~drain /\ a1 = "returned" /\ localA # "none" /\ where2 # "A"
    /\ ~(SweepSkip /\ mark)
    /\ ReclaimA
    /\ UNCHANGED <<drain, first, a1, mark, markerA, sentA, sd, a2, where2, loc2, base2, gh>>

(* The retry starts once the activity is cancelled, on B (even while the  *)
(* cut body still runs) or, after a lost lock, on A once A's attempt       *)
(* returned (not in the upgrade modes: A runs the older release there).    *)
(* It clears A's mark when it starts on A. It resolves from the store (a   *)
(* dirty sentinel or no dir). A cancelled result stored under its turnKey  *)
(* is adopted by the older releases and re-run on top of by the fix.       *)
A2Start ==
    /\ a2 = "wait" /\ a1 # "running"
    /\ \E w \in {"A", "B"} :
        /\ w = "A" => (~drain /\ a1 = "returned" /\ Mode \notin {"upgrade-main", "upgrade-old"})
        /\ where2' = w
        /\ mark' = IF w = "A" /\ Code("A") = "fix" THEN FALSE ELSE mark
        /\ IF storeKey = "cancelled" /\ ~RecoverNoAdopt(w)
           THEN /\ a2' = "done" /\ gh' = gh \cup {"dropped"}
                /\ UNCHANGED <<loc2, base2>>
           ELSE /\ a2' = "running" /\ loc2' = storeC /\ base2' = storeVer
                /\ gh' = gh \cup Aborted(storeC)
    /\ UNCHANGED <<drain, first, a1, localA, markerA, sentA, sd, storeVars>>

A2Finish ==
    /\ a2 = "running" /\ a2' = "ran" /\ loc2' = Advance(loc2)
    /\ UNCHANGED <<drain, first, a1, mark, localA, markerA, sentA, sd, where2, base2, storeVars, gh>>

(* The retry's commit (CAS on the version it resolved). If the cut        *)
(* attempt saved its cancelled result under the key since, the store       *)
(* reports the turn committed: the older releases adopt that result, the   *)
(* fix returns its own (the stored content stays the cut one: the upgrade  *)
(* residual).                                                              *)
A2Commit ==
    /\ a2 = "ran" /\ a2' = "done"
    /\ IF storeVer = base2
       THEN /\ storeC' = loc2 /\ storeKey' = "ok" /\ storeVer' = storeVer + 1 /\ storeLegacy' = FALSE
            /\ gh' = gh \cup {"ran"}
       ELSE /\ UNCHANGED storeVars
            /\ gh' = gh \cup (IF storeKey = "cancelled" /\ ~CommitNoAdopt(where2)
                              THEN {"dropped"} ELSE {"ran", "residual"})
    /\ UNCHANGED <<drain, first, a1, mark, localA, markerA, sentA, sd, where2, loc2, base2>>

Done ==
    /\ a2 = "done" /\ a1 = "returned" /\ sd \in {"none", "stopped"}
    /\ UNCHANGED vars

Next == A1Cancel \/ A1Latch \/ A1Return \/ SdRelease \/ SdSweep \/ EvSweep
        \/ A2Start \/ A2Finish \/ A2Commit \/ Done
Spec == Init /\ [][Next]_vars
Fairness ==
    /\ WF_vars(A1Cancel) /\ WF_vars(A1Latch) /\ WF_vars(A1Return)
    /\ WF_vars(SdRelease) /\ WF_vars(SdSweep)
    /\ WF_vars(A2Start) /\ WF_vars(A2Finish) /\ WF_vars(A2Commit)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
Contents == {"empty", "base", "cut", "turn", "cutturn"}
TypeOK ==
    /\ drain \in BOOLEAN /\ first \in BOOLEAN
    /\ a1 \in {"running", "cancelled", "cut", "returned"} /\ mark \in BOOLEAN
    /\ localA \in Contents \cup {"none"} /\ markerA \in BOOLEAN /\ sentA \in {"clean", "dirty"}
    /\ sd \in {"none", "cutting", "released", "stopped"}
    /\ a2 \in {"wait", "running", "ran", "done"} /\ where2 \in {"none", "A", "B"}
    /\ loc2 \in Contents /\ base2 \in 0..2
    /\ storeC \in Contents /\ storeKey \in {"none", "ok", "cancelled"}
    /\ storeVer \in 0..2 /\ storeLegacy \in BOOLEAN

(* A cut attempt is never saved.                                          *)
Inv_NoCancelledCommit == storeKey # "cancelled"
(* The retry never ends the turn without running it.                     *)
Inv_TurnNotDropped == "dropped" \notin gh
(* The retry never runs on what the cut attempt wrote.                    *)
Inv_NoAbortedHandOff == "abortedBase" \notin gh
(* A graceful shutdown never releases the cut session's workspace as if   *)
(* it were idle, whatever the order of the attempt's return and the       *)
(* release.                                                               *)
Inv_ShutdownKeepsCut == "releasedCut" \notin gh

(* Progress: the retry runs the turn.                                     *)
Prop_TurnRuns == <>("ran" \in gh)

(* Witnesses (each expected to be violated: the scenario is reachable).   *)
W_NoReturnBeforeRelease == ~("returnBeforeRelease" \in gh /\ "ran" \in gh)
W_NoUpgradeResidual == "abortedBase" \notin gh /\ "residual" \notin gh
(* The documented cost: after a lost lock whose retry ran on B, A keeps    *)
(* the mark and its local copy of the session (until A restarts or the     *)
(* session returns to it).                                                 *)
W_NoLingeringMark == ~(a2 = "done" /\ where2 = "B" /\ ~drain /\ mark /\ localA # "none")
=============================================================================
