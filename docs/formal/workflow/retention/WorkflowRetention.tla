--------------------------- MODULE WorkflowRetention ---------------------------
(***************************************************************************)
(* Issue 412: a finished Workflow session is kept while a session above    *)
(* it is active. Two deleters must decide on a state that cannot change    *)
(* before they commit:                                                     *)
(*                                                                         *)
(* - the Sweeper's final check (WorkflowStore.sweeperSoftDelete), which    *)
(*   deletes the target and the sessions under it;                         *)
(* - the event purge (WorkflowStore.purgeSessionEventsBefore), which       *)
(*   deletes old session events but keeps a finished Workflow's Log.       *)
(*                                                                         *)
(* Sessions: the root R (an ordinary session), the Workflow W under R, and *)
(* the agent session A under W. Concurrent changes:                        *)
(* - Restart: R has ended and its orchestration was pruned; a new first    *)
(*   message sets its row running (client.ts). One UPDATE: R's row lock    *)
(*   (FOR NO KEY UPDATE), then commit.                                     *)
(* - RunEnd: W's run ends. Its writer holds W's row (FOR NO KEY UPDATE)    *)
(*   first, then ends the run and commits.                                 *)
(* Each transaction's changes become visible at its commit. A row lock is  *)
(* "share" (FOR SHARE) or "nku" (FOR NO KEY UPDATE); nku conflicts with    *)
(* both, share with nku only.                                              *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Target,     \* "W" (cleanup of the Workflow, with A under it) or "A" (cleanup of the agent session)
    RInit,      \* "ended" or "active": R's state at the start
    WInit,      \* "finished" or "active": W's run at the start
    Sweep,      \* the Sweeper cleans Target
    Restart,    \* R restarts (meaningful with RInit = "ended")
    RunEnd,     \* W's run ends (meaningful with WInit = "active")
    Purge,      \* the event purge runs
    AncLock,    \* the final check holds the sessions above the target FOR SHARE, NOWAIT (the fix; FALSE: round 1)
    PurgeMode   \* "locked" (the fix), "nolock" (protects a finished Workflow, decided without a lock), "none" (round 1)

Rows == {"R", "W", "A"}

VARIABLES rState, wRun, deleted, eventsOld, locks, pcS, sResult, pcR, pcE, pcP, held, purgeDel, bad, bad2

vars == <<rState, wRun, deleted, eventsOld, locks, pcS, sResult, pcR, pcE, pcP, held, purgeDel, bad, bad2>>

\* The sessions the cleanup deletes with the target, and the sessions above the target.
SetOf == IF Target = "W" THEN {"A"} ELSE {}
AncOf == IF Target = "W" THEN {"R"} ELSE {"W", "R"}

\* The committed state keeps W, and A under it: W's run has ended, W exists, and R above it is active.
KeptW == wRun = "finished" /\ rState = "active" /\ "W" \notin deleted

Conflicts(m1, m2) == m1 = "nku" \/ m2 = "nku"
CanLock(tx, row, mode) == \A l \in locks[row] : l[1] = tx \/ ~Conflicts(l[2], mode)
CanLockAll(tx, rows, mode) == \A r \in rows : CanLock(tx, r, mode)
AcquireAll(L, tx, rows, mode) == [r \in Rows |-> IF r \in rows THEN L[r] \cup {<<tx, mode>>} ELSE L[r]]
ReleaseIn(L, tx) == [r \in Rows |-> {l \in L[r] : l[1] # tx}]

Init ==
    /\ rState = RInit
    /\ wRun = WInit
    /\ deleted = {}
    /\ eventsOld = {"W", "A"}
    /\ locks = [r \in Rows |-> {}]
    /\ pcS = IF Sweep THEN "idle" ELSE "done"
    /\ sResult = "none"
    /\ pcR = IF Restart THEN "idle" ELSE "done"
    /\ pcE = IF RunEnd THEN "idle" ELSE "done"
    /\ pcP = IF Purge THEN "idle" ELSE "done"
    /\ held = FALSE
    /\ purgeDel = FALSE
    /\ bad = FALSE
    /\ bad2 = FALSE

(***************************************************************************)
(* The Sweeper's final check: the target's row (waits), the sessions it    *)
(* deletes with it (NOWAIT: Busy), the sessions above it (share, NOWAIT:   *)
(* Busy; only with AncLock), the kept check on the committed state, the    *)
(* delete, visible at its commit. bad records a commit whose committed     *)
(* state keeps a session it deletes.                                       *)
(***************************************************************************)
S_LockTarget ==
    /\ pcS = "idle"
    /\ CanLock("sweeper", Target, "nku")
    /\ locks' = AcquireAll(locks, "sweeper", {Target}, "nku")
    /\ pcS' = "target"
    /\ UNCHANGED <<rState, wRun, deleted, eventsOld, sResult, pcR, pcE, pcP, held, purgeDel, bad, bad2>>

S_LockSet ==
    /\ pcS = "target"
    /\ IF CanLockAll("sweeper", SetOf, "nku")
          THEN /\ locks' = AcquireAll(locks, "sweeper", SetOf, "nku")
               /\ pcS' = "set"
               /\ UNCHANGED sResult
          ELSE /\ locks' = ReleaseIn(locks, "sweeper")
               /\ pcS' = "done"
               /\ sResult' = "busy"
    /\ UNCHANGED <<rState, wRun, deleted, eventsOld, pcR, pcE, pcP, held, purgeDel, bad, bad2>>

S_LockAncestors ==
    /\ pcS = "set"
    /\ IF ~AncLock
          THEN /\ pcS' = "ancestors"
               /\ UNCHANGED <<locks, sResult>>
          ELSE IF CanLockAll("sweeper", AncOf, "share")
                  THEN /\ locks' = AcquireAll(locks, "sweeper", AncOf, "share")
                       /\ pcS' = "ancestors"
                       /\ UNCHANGED sResult
                  ELSE /\ locks' = ReleaseIn(locks, "sweeper")
                       /\ pcS' = "done"
                       /\ sResult' = "busy"
    /\ UNCHANGED <<rState, wRun, deleted, eventsOld, pcR, pcE, pcP, held, purgeDel, bad, bad2>>

S_Check ==
    /\ pcS = "ancestors"
    /\ IF KeptW
          THEN /\ locks' = ReleaseIn(locks, "sweeper")
               /\ pcS' = "done"
               /\ sResult' = "kept"
          ELSE /\ pcS' = "checked"
               /\ UNCHANGED <<locks, sResult>>
    /\ UNCHANGED <<rState, wRun, deleted, eventsOld, pcR, pcE, pcP, held, purgeDel, bad, bad2>>

S_Commit ==
    /\ pcS = "checked"
    /\ deleted' = deleted \cup {Target} \cup SetOf
    /\ bad' = (bad \/ KeptW)
    /\ locks' = ReleaseIn(locks, "sweeper")
    /\ pcS' = "done"
    /\ sResult' = "deleted"
    /\ UNCHANGED <<rState, wRun, eventsOld, pcR, pcE, pcP, held, purgeDel, bad2>>

(* The root's restart: one UPDATE of its row. *)
R_Lock ==
    /\ pcR = "idle"
    /\ CanLock("restart", "R", "nku")
    /\ locks' = AcquireAll(locks, "restart", {"R"}, "nku")
    /\ pcR' = "locked"
    /\ UNCHANGED <<rState, wRun, deleted, eventsOld, pcS, sResult, pcE, pcP, held, purgeDel, bad, bad2>>

R_Commit ==
    /\ pcR = "locked"
    /\ rState' = "active"
    /\ locks' = ReleaseIn(locks, "restart")
    /\ pcR' = "done"
    /\ UNCHANGED <<wRun, deleted, eventsOld, pcS, sResult, pcE, pcP, held, purgeDel, bad, bad2>>

(* The run's end: W's row first (lockLiveSession); a deleted W ends nothing. *)
E_Lock ==
    /\ pcE = "idle"
    /\ CanLock("runend", "W", "nku")
    /\ locks' = AcquireAll(locks, "runend", {"W"}, "nku")
    /\ pcE' = "locked"
    /\ UNCHANGED <<rState, wRun, deleted, eventsOld, pcS, sResult, pcR, pcP, held, purgeDel, bad, bad2>>

E_Commit ==
    /\ pcE = "locked"
    /\ wRun' = IF "W" \in deleted THEN wRun ELSE "finished"
    /\ locks' = ReleaseIn(locks, "runend")
    /\ pcE' = "done"
    /\ UNCHANGED <<rState, deleted, eventsOld, pcS, sResult, pcR, pcP, held, purgeDel, bad, bad2>>

(***************************************************************************)
(* The event purge of W's tree (W's and A's old events). "locked": W is    *)
(* held FOR SHARE, SKIP LOCKED, when its run has not ended; the lock       *)
(* statement's selection may read a run end that committed just before    *)
(* the lock was taken as not yet ended (held anyway). The delete decides   *)
(* on the committed state at its start: W's events go only when W is       *)
(* deleted, or held with a run that has not ended. bad2 records a commit   *)
(* that deletes the old events of a finished Workflow that exists.         *)
(***************************************************************************)
P_Select ==
    /\ pcP = "idle"
    /\ IF PurgeMode = "locked" /\ "W" \notin deleted /\ CanLock("purge", "W", "share")
          THEN /\ held' \in (IF wRun # "finished" THEN {TRUE} ELSE {TRUE, FALSE})
               /\ locks' = IF held' THEN AcquireAll(locks, "purge", {"W"}, "share") ELSE locks
          ELSE /\ held' = FALSE
               /\ UNCHANGED locks
    /\ pcP' = "selected"
    /\ UNCHANGED <<rState, wRun, deleted, eventsOld, pcS, sResult, pcR, pcE, purgeDel, bad, bad2>>

P_Decide ==
    /\ pcP = "selected"
    /\ purgeDel' = CASE PurgeMode = "none" -> TRUE
                     [] PurgeMode = "nolock" -> ("W" \in deleted \/ wRun # "finished")
                     [] OTHER -> ("W" \in deleted \/ (held /\ wRun # "finished"))
    /\ pcP' = "decided"
    /\ UNCHANGED <<rState, wRun, deleted, eventsOld, locks, pcS, sResult, pcR, pcE, held, bad, bad2>>

P_Commit ==
    /\ pcP = "decided"
    /\ eventsOld' = IF purgeDel THEN {} ELSE eventsOld
    /\ bad2' = (bad2 \/ (purgeDel /\ "W" \notin deleted /\ wRun = "finished"))
    /\ locks' = ReleaseIn(locks, "purge")
    /\ pcP' = "done"
    /\ UNCHANGED <<rState, wRun, deleted, pcS, sResult, pcR, pcE, held, purgeDel, bad>>

AllDone == pcS = "done" /\ pcR = "done" /\ pcE = "done" /\ pcP = "done"
Finished == AllDone /\ UNCHANGED vars

Next ==
    \/ S_LockTarget \/ S_LockSet \/ S_LockAncestors \/ S_Check \/ S_Commit
    \/ R_Lock \/ R_Commit
    \/ E_Lock \/ E_Commit
    \/ P_Select \/ P_Decide \/ P_Commit
    \/ Finished

Spec == Init /\ [][Next]_vars

(* Safety. *)
TypeOK ==
    /\ rState \in {"ended", "active"}
    /\ wRun \in {"finished", "active"}
    /\ deleted \subseteq {"W", "A"}
    /\ eventsOld \subseteq {"W", "A"}
    /\ sResult \in {"none", "deleted", "busy", "kept"}
Inv_Locks == \A r \in Rows : \A l1, l2 \in locks[r] : l1[1] # l2[1] => ~Conflicts(l1[2], l2[2])
\* The Sweeper never commits a delete of a session that the committed state keeps.
Inv_NoKeptDelete == ~bad
\* The purge never deletes the Log of a finished Workflow that exists.
Inv_NoFinishedLogPurge == ~bad2

(* Witnesses: each is expected to be violated, which shows that the outcome is reachable. *)
Wit_Deleted == sResult # "deleted"
Wit_RestartAfterDelete == ~(sResult = "deleted" /\ rState = "active")
Wit_Busy == sResult # "busy"
Wit_Kept == sResult # "kept"
Wit_PurgedThenEnded == ~(pcP = "done" /\ purgeDel /\ wRun = "finished")
Wit_KeptLogThenEnded == ~(pcP = "done" /\ ~purgeDel /\ wRun = "finished" /\ pcE = "done" /\ RunEnd)
=============================================================================
