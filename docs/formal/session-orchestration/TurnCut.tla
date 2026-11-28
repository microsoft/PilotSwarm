------------------------------- MODULE TurnCut -------------------------------
(***************************************************************************)
(* A cut turn: worker A's runTurn attempt is cancelled, by a graceful      *)
(* shutdown's drain, a lost activity lock or a terminal cancel, and        *)
(* (unless the cancel was terminal) duroxide runs the same turn (the same  *)
(* turnKey) again, on worker B or, after a lost lock, on A. One session,   *)
(* one turn.                                                               *)
(*                                                                         *)
(* Mode "old" (v0.6.0, the first versioned-snapshot release, to 0.8.15):   *)
(* runTurnCommit saved every cut body under the turnKey with the result    *)
(* "cancelled", and the retry's already-committed recovery adopted it, so  *)
(* the orchestration ended the turn without running it (its case           *)
(* "cancelled" only traces). A commit that found that result under its key *)
(* adopted it the same way.                                                *)
(* Mode "main" (0.8.16 and 0.8.17, #367): a drain cut throws before the    *)
(* commit and marks the session cut (markTurnCut); a graceful shutdown's   *)
(* workspace release and every sweep skip a marked session. A lost lock    *)
(* outside a drain still saves "cancelled", sets no mark, and is adopted.  *)
(* Mode "head" (this branch before its review, 35a68656): the fix below,   *)
(* except that every sweep skips a marked session (during a drain or not), *)
(* no legacy path checks the files before it publishes them, the retry on  *)
(* A clears the mark before its preamble's probe, and destroySession keeps *)
(* the mark.                                                               *)
(* Mode "fix" (this branch), on top of "main":                             *)
(*  - runTurnCommit skips a cancelled result and leaves the sentinel dirty *)
(*    (session-lifecycle.ts runTurnCommit, unpublished "cancelled");       *)
(*  - recoverAlreadyCommitted never adopts a stored cancelled result: the  *)
(*    retry runs the turn on top of it;                                    *)
(*  - commitTurnSnapshot never adopts one: when an older worker's          *)
(*    cancelled commit wins, the retry returns its own result unpublished  *)
(*    ("foreign_cancelled_winner");                                        *)
(*  - a cancel the attempt latches before its commit marks the session cut *)
(*    (latchCancelled), before the attempt releases its run-turn lock: a   *)
(*    lost lock, and a terminal cancel, which the attempt cannot tell      *)
(*    apart;                                                               *)
(*  - the next attempt on A clears the mark once its preamble resolved the *)
(*    session from the store (a failed probe keeps it); destroySession     *)
(*    clears it (a terminal cancel or delete is never retried);            *)
(*  - a graceful shutdown's workspace release and sweep, and an eviction   *)
(*    sweep while A drains, skip a marked session; on a live worker the    *)
(*    eviction sweep reclaims it: it releases the workspace (cancelling    *)
(*    its shells), drops the warm handle, deletes the dir and then clears  *)
(*    the mark;                                                            *)
(*  - no legacy path (the eviction sweep, dehydrate, checkpoint) publishes *)
(*    a dir with a dirty turn sentinel or a cut mark (session-manager.ts   *)
(*    _legacyPublishBlocker): the mark blocks on its own, as a turn        *)
(*    without the lifecycle protocol writes no sentinel.                   *)
(* Modes "upgrade-main" and "upgrade-old": A runs "main" or "old", and B   *)
(* runs the fix.                                                           *)
(*                                                                         *)
(* The scenario is chosen at the start: the cut comes from a drain or not; *)
(* the turn is the session's first or not; it runs the lifecycle protocol  *)
(* (lc: snapshot coordinates and a versioned store) or not (no sentinel,   *)
(* no commit: the retry runs on B and publishes the legacy way); the       *)
(* cancel is terminal (term: no retry) or not. A shutdown may also begin   *)
(* after an ordinary cut (SdBegin): no new attempt starts on A from then   *)
(* on.                                                                     *)
(*                                                                         *)
(* Content: "empty" (a first turn: the store holds no snapshot), "base"    *)
(* (the last committed turn), "cut" (what the cut attempt wrote of the     *)
(* turn), "turn" (the completed turn), "cutturn" (the turn run on top of   *)
(* the cut attempt's content). storeVer counts commits since the cut       *)
(* attempt started; a legacy publish replaces the content without a        *)
(* version. heldA: A holds the session's workspace lease, its background   *)
(* shells and its warm handle. Workspace files are not modelled:           *)
(* "releasedCut" records that a shutdown released a drain-cut session's    *)
(* workspace cleanly, "releasedLateCut" the same for a shutdown that began *)
(* after an ordinary cut; either way the next worker gets no               *)
(* partial-changes note for what the cut attempt changed. "cutPublished"   *)
(* records that a legacy path wrote the cut attempt's files to the store.  *)
(* The live eviction sweep's release is a backstop that runs once the      *)
(* session has been idle for evictAfterMs (35 minutes by default); the     *)
(* model has no time and claims nothing about its order against B's attach *)
(* ("liveReclaim").                                                        *)
(*                                                                         *)
(* Not modelled: an attempt that completes before its cancel lands (a      *)
(* cancel latched after the commit does not mark; unit-tested), the        *)
(* orchestration's retry count and timers, more than one retry, a retry on *)
(* A while the retry on B still runs, a shutdown that begins while the     *)
(* retry runs on A (a second cut), a retry on A without the lifecycle      *)
(* protocol, a terminal cancel without it, a worker restart or an          *)
(* in-process stop and start (a new runtime generation clears every mark), *)
(* the session-store CAS details beyond the turnKey rule, and the          *)
(* dehydrate and checkpoint activities apart from the sweep (they share    *)
(* its publish rule, ReclaimA).                                            *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Mode,   \* "fix", "head", "main", "old", "upgrade-main", "upgrade-old"
    Fault   \* "none" or one protection of "fix" removed (Faults)

Faults == {"none", "commit-cut", "adopt-recover", "adopt-commit", "no-lock-mark",
           "no-release-skip", "no-sweep-skip", "sweep-skip-undrained", "no-publish-guard",
           "sentinel-only-guard", "clear-before-probe", "no-destroy-clear"}
ASSUME Mode \in {"fix", "head", "main", "old", "upgrade-main", "upgrade-old"}
ASSUME Fault \in Faults

VARIABLES
    \* the scenario, chosen at the start
    drain,       \* the cut comes from A's graceful shutdown (else a lost lock or a terminal cancel)
    first,       \* the turn is the session's first: the store holds no snapshot
    lc,          \* the turn runs the lifecycle protocol (a turn sentinel and a versioned commit)
    term,        \* the cancel is terminal (a cancel or delete): the turn is not retried
    \* worker A
    a1,          \* the cut attempt: "running", "cancelled" (cancel issued), "cut" (latched), "returned" (lock released)
    mark,        \* A's cut mark (markTurnCut)
    localA,      \* A's local dir: "none" or its content
    markerA,     \* A's dir holds a committed snapshot marker
    sentA,       \* A's turn sentinel: "clean", "dirty"
    heldA,       \* A holds the session's workspace lease, its background shells and its warm handle
    pfail,       \* the retry's preamble probe on A failed (once)
    destroyed,   \* destroySession ran on A
    sd,          \* A's shutdown: "none", "cutting" (draining), "released", "stopped"
    \* the retry
    a2,          \* "wait", "running", "ran", "done"
    where2,      \* "none", "A", "B"
    loc2,        \* the retry's working content
    base2,       \* the store version the retry resolved
    \* the session store
    storeC, storeKey, storeVer, storeLegacy,
    gh           \* ghost flags
vars == <<drain, first, lc, term, a1, mark, localA, markerA, sentA, heldA, pfail, destroyed, sd,
          a2, where2, loc2, base2, storeC, storeKey, storeVer, storeLegacy, gh>>
scen == <<drain, first, lc, term>>
retryVars == <<a2, where2, loc2, base2>>
storeVars == <<storeC, storeKey, storeVer, storeLegacy>>

Code(w) == CASE Mode = "upgrade-main" -> (IF w = "A" THEN "main" ELSE "fix")
             [] Mode = "upgrade-old" -> (IF w = "A" THEN "old" ELSE "fix")
             [] Mode = "head" -> "fix"
             [] OTHER -> Mode
(* A drain cut is not saved from "main" on (#367); a lost lock's cancelled *)
(* attempt only with the fix. The mark: a drain cut from "main" on; any    *)
(* latched cancel with the fix.                                            *)
SkipCutCommit == CASE Code("A") = "fix" -> drain \/ Fault # "commit-cut"
                   [] Code("A") = "main" -> drain
                   [] OTHER -> FALSE
MarkCut == CASE Code("A") = "fix" -> drain \/ Fault # "no-lock-mark"
              [] Code("A") = "main" -> drain
              [] OTHER -> FALSE
RecoverNoAdopt(w) == Code(w) = "fix" /\ Fault # "adopt-recover"
CommitNoAdopt(w) == Code(w) = "fix" /\ Fault # "adopt-commit"

Draining == sd # "none"
Locked == a1 \in {"running", "cancelled", "cut"}
ReleaseSkip == Fault # "no-release-skip"
(* The sweeps' skip of a marked session: from "main" to "head" always,     *)
(* with the fix only while A drains (_drainKeepsCut).                      *)
SweepSkips == IF Fault = "no-sweep-skip" THEN FALSE
              ELSE IF Mode = "fix" /\ Fault # "sweep-skip-undrained" THEN Draining /\ mark
              ELSE mark
(* The legacy publish guard (_legacyPublishBlocker): a dirty turn sentinel *)
(* or a cut mark.                                                          *)
Blocked == IF Mode # "fix" \/ Fault = "no-publish-guard" THEN FALSE
           ELSE IF Fault = "sentinel-only-guard" THEN sentA = "dirty"
           ELSE sentA = "dirty" \/ mark
ProbeClears == Code("A") = "fix" /\ (Mode # "fix" \/ Fault = "clear-before-probe")
DestroyClears == Mode = "fix" /\ Fault # "no-destroy-clear"

Advance(c) == IF c \in {"cut", "cutturn"} THEN "cutturn" ELSE "turn"
Aborted(c) == IF c \in {"cut", "cutturn"} THEN {"abortedBase"} ELSE {}

(* A sweep reclaims A's dir, after releasing A's workspace and dropping    *)
(* its handle. A committed marker or a versioned store chain means a plain *)
(* delete; so does a guarded dir (the fix); otherwise a legacy dehydrate   *)
(* publishes the dir. The fix clears the mark after that cleanup. The      *)
(* dehydrate and checkpoint activities use the same publish rule.          *)
Publishes == localA # "none" /\ ~markerA /\ storeVer = 0 /\ ~Blocked
ReclaimA ==
    /\ localA' = "none" /\ heldA' = FALSE
    /\ mark' = IF Mode = "fix" THEN FALSE ELSE mark
    /\ IF Publishes
       THEN /\ storeC' = localA /\ storeLegacy' = TRUE
            /\ UNCHANGED <<storeKey, storeVer>>
       ELSE UNCHANGED storeVars
PublishGhost == IF Publishes /\ localA \in {"cut", "cutturn"} THEN {"cutPublished"} ELSE {}
(* A clean release of A's workspace while A drains: of a drain-cut         *)
(* session, or of a session cut before a later shutdown began.             *)
ReleaseGhost == IF ~heldA THEN {} ELSE IF drain THEN {"releasedCut"} ELSE {"releasedLateCut"}

Init ==
    /\ drain \in BOOLEAN /\ first \in BOOLEAN /\ lc \in BOOLEAN /\ term \in BOOLEAN
    /\ term => (lc /\ ~drain)
    /\ a1 = "running" /\ mark = FALSE
    /\ localA = IF first THEN "empty" ELSE "base"
    /\ markerA = (lc /\ ~first) /\ sentA = IF lc THEN "dirty" ELSE "clean"
    /\ heldA = TRUE /\ pfail = FALSE /\ destroyed = FALSE
    /\ sd = IF drain THEN "cutting" ELSE "none"
    /\ a2 = "wait" /\ where2 = "none" /\ loc2 = "empty" /\ base2 = 0
    /\ storeC = IF first THEN "empty" ELSE "base"
    /\ storeKey = "none" /\ storeVer = 0 /\ storeLegacy = (~lc /\ ~first)
    /\ gh = {}

(* The drain, the lost lock or the terminal cancel cancels A's activity.   *)
(* Not fair: an external stimulus (C-5).                                   *)
A1Cancel ==
    /\ a1 = "running" /\ a1' = "cancelled"
    /\ UNCHANGED <<scen, mark, localA, markerA, sentA, heldA, pfail, destroyed, sd, retryVars, storeVars, gh>>

(* The body latches the cancel, having written part of the turn to the     *)
(* local dir, and marks the session where its code does.                   *)
A1Latch ==
    /\ a1 = "cancelled" /\ a1' = "cut"
    /\ localA' = "cut" /\ mark' = MarkCut
    /\ UNCHANGED <<scen, markerA, sentA, heldA, pfail, destroyed, sd, retryVars, storeVars, gh>>

(* The body's commit, then the lock is released. A skipped commit leaves   *)
(* the sentinel dirty. A saved one lands under the turnKey when the store  *)
(* is still at the version the attempt started from (else the store        *)
(* reports it committed or superseded, and nothing is written). Without    *)
(* the lifecycle protocol there is no commit.                              *)
A1Return ==
    /\ a1 = "cut" /\ a1' = "returned"
    /\ IF lc /\ ~SkipCutCommit /\ storeVer = 0
       THEN /\ storeC' = localA /\ storeKey' = "cancelled" /\ storeVer' = 1 /\ storeLegacy' = FALSE
            /\ sentA' = "clean" /\ markerA' = TRUE
       ELSE UNCHANGED <<storeVars, sentA, markerA>>
    /\ UNCHANGED <<scen, mark, localA, heldA, pfail, destroyed, sd, retryVars, gh>>

(* A graceful shutdown that begins after an ordinary cut (review SF-6): A  *)
(* drains from here on (beginDrain), and no new attempt starts on A. Not   *)
(* fair.                                                                   *)
SdBegin ==
    /\ sd = "none" /\ a1 # "running" /\ where2 # "A"
    /\ sd' = "cutting"
    /\ gh' = gh \cup (IF a1 = "returned" /\ ~term THEN {"lateShutdown"} ELSE {})
    /\ UNCHANGED <<scen, a1, mark, localA, markerA, sentA, heldA, pfail, destroyed, retryVars, storeVars>>

(* Graceful shutdown, once no attempt runs: releaseIdleWorkspaces skips a  *)
(* locked session and a marked one.                                        *)
SdRelease ==
    /\ sd = "cutting" /\ a1 # "running" /\ sd' = "released"
    /\ LET skip == Locked \/ (ReleaseSkip /\ mark) IN
         /\ heldA' = IF skip THEN heldA ELSE FALSE
         /\ gh' = gh \cup (IF skip THEN {} ELSE ReleaseGhost)
                     \cup (IF drain /\ a1 = "returned" THEN {"returnBeforeRelease"} ELSE {})
    /\ UNCHANGED <<scen, a1, mark, localA, markerA, sentA, pfail, destroyed, retryVars, storeVars>>

(* ... then sweepIdleSessions(1): a session it does not skip has its       *)
(* workspace released first, then its dir reclaimed.                       *)
SdSweep ==
    /\ sd = "released" /\ sd' = "stopped"
    /\ IF Locked \/ SweepSkips
       THEN UNCHANGED <<mark, localA, heldA, storeVars, gh>>
       ELSE /\ ReclaimA
            /\ gh' = gh \cup ReleaseGhost \cup PublishGhost
    /\ UNCHANGED <<scen, a1, markerA, sentA, pfail, destroyed, retryVars>>

(* A's ordinary eviction sweep, once the attempt returned, while A is live *)
(* or draining (its timer stops after the drain), unless the retry runs on *)
(* A (it holds the dir) or the sweep skips the session. Live, the fix      *)
(* reclaims a marked session (review MF-1); while draining, it skips one.  *)
EvSweep ==
    /\ sd \in {"none", "cutting"} /\ a1 = "returned" /\ where2 # "A"
    /\ (localA # "none" \/ heldA)
    /\ ~SweepSkips
    /\ ReclaimA
    /\ gh' = gh \cup PublishGhost
                \cup (IF Draining THEN ReleaseGhost ELSE IF mark THEN {"liveReclaim"} ELSE {})
    /\ UNCHANGED <<scen, a1, markerA, sentA, pfail, destroyed, sd, retryVars>>

(* A terminal cancel or delete: the orchestration's destroySession on A    *)
(* releases the workspace, drops the handle and (the fix) clears the mark; *)
(* the dir is left to the sweep. Not fair: the activity may run elsewhere. *)
Destroy ==
    /\ term /\ ~destroyed /\ a1 = "returned" /\ sd \in {"none", "cutting"}
    /\ destroyed' = TRUE /\ heldA' = FALSE
    /\ mark' = IF DestroyClears THEN FALSE ELSE mark
    /\ UNCHANGED <<scen, a1, localA, markerA, sentA, pfail, sd, retryVars, storeVars, gh>>

(* A retry may start on A after a lost lock, once A's attempt returned,    *)
(* while A is live (not in the upgrade modes: A runs the older release     *)
(* there).                                                                 *)
OnA == /\ ~drain /\ ~term /\ lc /\ sd = "none" /\ a1 = "returned"
       /\ Mode \notin {"upgrade-main", "upgrade-old"}

(* The retry's preamble probe on A fails (the store is unreachable): the   *)
(* activity fails before it resolved the session, so the cut files stay as *)
(* they were. "head" has cleared the mark already (review MF-2); the fix   *)
(* keeps it. Not fair.                                                     *)
A2Fail ==
    /\ a2 = "wait" /\ ~pfail /\ OnA
    /\ pfail' = TRUE
    /\ mark' = IF ProbeClears THEN FALSE ELSE mark
    /\ UNCHANGED <<scen, a1, localA, markerA, sentA, heldA, destroyed, sd, retryVars, storeVars, gh>>

(* The retry starts once the activity is cancelled, on B (even while the   *)
(* cut body still runs) or on A. It clears A's mark when it starts on A,   *)
(* once its preamble resolved the session. It resolves from the store (a   *)
(* dirty sentinel or no dir). A cancelled result stored under its turnKey  *)
(* is adopted by the older releases and re-run on top of by the fix.       *)
A2Start ==
    /\ a2 = "wait" /\ a1 # "running" /\ ~term
    /\ \E w \in {"A", "B"} :
        /\ w = "A" => OnA
        /\ where2' = w
        /\ mark' = IF w = "A" /\ Code("A") = "fix" THEN FALSE ELSE mark
        /\ IF lc /\ storeKey = "cancelled" /\ ~RecoverNoAdopt(w)
           THEN /\ a2' = "done" /\ gh' = gh \cup {"dropped"}
                /\ UNCHANGED <<loc2, base2>>
           ELSE /\ a2' = "running" /\ loc2' = storeC /\ base2' = storeVer
                /\ gh' = gh \cup Aborted(storeC)
    /\ UNCHANGED <<scen, a1, localA, markerA, sentA, heldA, pfail, destroyed, sd, storeVars>>

A2Finish ==
    /\ a2 = "running" /\ a2' = "ran" /\ loc2' = Advance(loc2)
    /\ UNCHANGED <<scen, a1, mark, localA, markerA, sentA, heldA, pfail, destroyed, sd, where2, base2,
                   storeVars, gh>>

(* The retry's commit (CAS on the version it resolved), or its legacy      *)
(* publish without the lifecycle protocol. If the cut attempt saved its    *)
(* cancelled result under the key since, the store reports the turn        *)
(* committed: the older releases adopt that result, the fix returns its    *)
(* own result unpublished (foreign_cancelled_winner; the stored content    *)
(* stays the cut one: the upgrade residual).                               *)
A2Commit ==
    /\ a2 = "ran" /\ a2' = "done"
    /\ CASE ~lc ->
              /\ storeC' = loc2 /\ storeLegacy' = TRUE /\ UNCHANGED <<storeKey, storeVer>>
              /\ gh' = gh \cup {"ran"}
         [] lc /\ storeVer = base2 ->
              /\ storeC' = loc2 /\ storeKey' = "ok" /\ storeVer' = storeVer + 1 /\ storeLegacy' = FALSE
              /\ gh' = gh \cup {"ran"}
         [] OTHER ->
              /\ UNCHANGED storeVars
              /\ gh' = gh \cup (IF storeKey = "cancelled" /\ ~CommitNoAdopt(where2)
                                THEN {"dropped"} ELSE {"ran", "residual"})
    /\ UNCHANGED <<scen, a1, mark, localA, markerA, sentA, heldA, pfail, destroyed, sd, where2, loc2, base2>>

Done ==
    /\ a1 = "returned" /\ (a2 = "done" \/ term) /\ sd \in {"none", "stopped"}
    /\ UNCHANGED vars

Next == A1Cancel \/ A1Latch \/ A1Return \/ SdBegin \/ SdRelease \/ SdSweep \/ EvSweep \/ Destroy
        \/ A2Fail \/ A2Start \/ A2Finish \/ A2Commit \/ Done
Spec == Init /\ [][Next]_vars
(* Fairness on the steps of the cut attempt after its cancel, the shutdown *)
(* once begun, the eviction sweep and the retry. The cancel, a later       *)
(* shutdown, destroySession and a failed probe are external and not fair   *)
(* (review C-5): the liveness properties are conditioned on them.          *)
Fairness ==
    /\ WF_vars(A1Latch) /\ WF_vars(A1Return)
    /\ WF_vars(SdRelease) /\ WF_vars(SdSweep) /\ WF_vars(EvSweep)
    /\ WF_vars(A2Start) /\ WF_vars(A2Finish) /\ WF_vars(A2Commit)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
Contents == {"empty", "base", "cut", "turn", "cutturn"}
TypeOK ==
    /\ drain \in BOOLEAN /\ first \in BOOLEAN /\ lc \in BOOLEAN /\ term \in BOOLEAN
    /\ a1 \in {"running", "cancelled", "cut", "returned"} /\ mark \in BOOLEAN
    /\ localA \in Contents \cup {"none"} /\ markerA \in BOOLEAN /\ sentA \in {"clean", "dirty"}
    /\ heldA \in BOOLEAN /\ pfail \in BOOLEAN /\ destroyed \in BOOLEAN
    /\ sd \in {"none", "cutting", "released", "stopped"}
    /\ a2 \in {"wait", "running", "ran", "done"} /\ where2 \in {"none", "A", "B"}
    /\ loc2 \in Contents /\ base2 \in 0..2
    /\ storeC \in Contents /\ storeKey \in {"none", "ok", "cancelled"}
    /\ storeVer \in 0..2 /\ storeLegacy \in BOOLEAN

(* A cut attempt is never saved.                                           *)
Inv_NoCancelledCommit == storeKey # "cancelled"
(* The retry never ends the turn without running it.                       *)
Inv_TurnNotDropped == "dropped" \notin gh
(* The retry never runs on what the cut attempt wrote.                     *)
Inv_NoAbortedHandOff == "abortedBase" \notin gh
(* A graceful shutdown never releases a cut session's workspace as if it   *)
(* were idle, whatever the order of the attempt's return and the release,  *)
(* and whether the drain cut it or it was cut before the shutdown began.   *)
Inv_ShutdownKeepsCut == "releasedCut" \notin gh /\ "releasedLateCut" \notin gh
(* The same for a drain cut only (what "main" already ensured).            *)
Inv_DrainKeepsCut == "releasedCut" \notin gh
(* No legacy path writes the cut attempt's files to the store.             *)
Inv_NoCutPublish == "cutPublished" \notin gh

(* Progress: a cut that is not terminal leads to the retry running the     *)
(* turn; a live A releases a cut session whose retry went to B (review     *)
(* MF-1); a session destroyed on A loses its dir (review SF-1).            *)
Prop_TurnRuns == (~term /\ a1 # "running") ~> ("ran" \in gh)
Prop_LiveRelease == (a1 = "returned" /\ where2 = "B") ~> (~heldA \/ Draining)
Prop_EndReclaims == destroyed ~> (localA = "none")

(* Witnesses (each expected to be violated: the scenario is reachable).    *)
W_NoReturnBeforeRelease == ~("returnBeforeRelease" \in gh /\ "ran" \in gh)
W_NoUpgradeResidual == "abortedBase" \notin gh /\ "residual" \notin gh
(* A cut by an ordinary lost lock is reachable (C-5); a shutdown that      *)
(* began after an ordinary cut keeps the session held while the retry ran  *)
(* on B (SF-6); the live sweep reclaims a cut session whose retry ran on B *)
(* (MF-1).                                                                 *)
W_NoLeaseCut == ~(~drain /\ ~term /\ a1 = "cut")
W_NoLateShutdown == ~("lateShutdown" \in gh /\ sd = "stopped" /\ heldA /\ where2 = "B" /\ "ran" \in gh)
W_NoLiveReclaim == ~("liveReclaim" \in gh /\ where2 = "B" /\ "ran" \in gh)
=============================================================================
