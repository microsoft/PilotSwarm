----------------------------- MODULE WorkflowPrune -----------------------------
(***************************************************************************)
(* Issue 412, review R2-1: the Sweeper's prune (a delete without cascade)  *)
(* of a session R removes R and the Workflow sessions the owner trigger    *)
(* deletes with it, and leaves every other session under R in place.       *)
(* Lists and the portal reach a session through its parent, so a Workflow  *)
(* left under a deleted R is no longer shown, even while it is kept.       *)
(*                                                                         *)
(* Sessions: the prune target R (ordinary), its ordinary child O (idle or  *)
(* ended throughout), and the Workflow W under O. W exists from the start  *)
(* or is created under O. Concurrent changes:                              *)
(* - Create: W is created under O. Creation locks its parent O first       *)
(*   (lockLiveParent: FOR SHARE, or FOR NO KEY UPDATE when the child       *)
(*   budget takes it), then inserts W with a run that has not ended. With  *)
(*   StartCheck, it first reads the sessions above O and refuses when one  *)
(*   is deleted (review round 3: a Start after a prune).                   *)
(* - RunEnd: W's run ends. Its writer holds W's row (FOR NO KEY UPDATE)    *)
(*   first, then ends the run and commits.                                 *)
(* Each transaction's changes become visible at its commit. A row lock is  *)
(* "share" or "nku"; nku conflicts with both, share with nku only.         *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    WInit,      \* "none" (no Workflow under O at the start), "active" (its run has not ended) or "finished"
    OActive,    \* O is active (idle) throughout; FALSE: O has ended
    RActive,    \* R is active (a pending root that never accepted a message); FALSE: R has ended
    Create,     \* a Workflow is created under O (meaningful with WInit = "none")
    CreateMode, \* "share" or "nku": the lock the creation takes on O
    RunEnd,     \* W's run ends (meaningful with WInit = "active", or with Create)
    Check,      \* the final check: "locked" (the fix), "nolock" (reads the sessions left below without locking
                \* them), "kept" (refuses only when a kept Workflow is below), "none" (round 2: no check below)
    StartCheck  \* TRUE: a creation under its lock on O refuses when R is deleted (the fix); FALSE: round 3, no such check

Rows == {"R", "O", "W"}

VARIABLES w, deleted, locks, pcS, sResult, seen, pcC, pcE

vars == <<w, deleted, locks, pcS, sResult, seen, pcC, pcE>>

\* The sessions under R that the prune leaves in place, as the committed state has them.
Left == {"O"} \cup (IF w # "none" THEN {"W"} ELSE {})

\* The committed state keeps W: its run has ended and a session above it is active (a deleted one is not).
KeptW == w = "finished" /\ (OActive \/ (RActive /\ "R" \notin deleted))

Conflicts(m1, m2) == m1 = "nku" \/ m2 = "nku"
CanLock(tx, row, mode) == \A l \in locks[row] : l[1] = tx \/ ~Conflicts(l[2], mode)
CanLockAll(tx, rows, mode) == \A r \in rows : CanLock(tx, r, mode)
AcquireAll(L, tx, rows, mode) == [r \in Rows |-> IF r \in rows THEN L[r] \cup {<<tx, mode>>} ELSE L[r]]
ReleaseIn(L, tx) == [r \in Rows |-> {l \in L[r] : l[1] # tx}]

Init ==
    /\ w = WInit
    /\ deleted = {}
    /\ locks = [r \in Rows |-> {}]
    /\ pcS = "idle"
    /\ sResult = "none"
    /\ seen = {}
    /\ pcC = IF Create THEN "idle" ELSE "done"
    /\ pcE = IF RunEnd THEN "idle" ELSE "done"

(***************************************************************************)
(* The final check of the prune of R: R's row (waits); the sessions under  *)
(* R that the delete leaves in place are read (Left); with "locked", they  *)
(* are locked nku NOWAIT (a held one: Busy) and read again (a set that     *)
(* grew: Changed); the check on the committed state; the delete of R,      *)
(* visible at its commit.                                                  *)
(***************************************************************************)
S_LockTarget ==
    /\ pcS = "idle"
    /\ CanLock("sweeper", "R", "nku")
    /\ locks' = AcquireAll(locks, "sweeper", {"R"}, "nku")
    /\ pcS' = "target"
    /\ UNCHANGED <<w, deleted, sResult, seen, pcC, pcE>>

S_Read ==
    /\ pcS = "target"
    /\ seen' = Left
    /\ pcS' = "read"
    /\ UNCHANGED <<w, deleted, locks, sResult, pcC, pcE>>

S_LockLeft ==
    /\ pcS = "read"
    /\ IF Check # "locked"
          THEN /\ pcS' = "locked"
               /\ UNCHANGED <<locks, sResult>>
          ELSE IF CanLockAll("sweeper", seen, "nku")
                  THEN /\ locks' = AcquireAll(locks, "sweeper", seen, "nku")
                       /\ pcS' = "locked"
                       /\ UNCHANGED sResult
                  ELSE /\ locks' = ReleaseIn(locks, "sweeper")
                       /\ pcS' = "done"
                       /\ sResult' = "busy"
    /\ UNCHANGED <<w, deleted, seen, pcC, pcE>>

S_Check ==
    /\ pcS = "locked"
    /\ LET result == CASE Check = "locked" /\ ~(Left \subseteq seen) -> "changed"
                       [] Check \in {"locked", "nolock"} /\ w # "none" -> "below"
                       [] Check = "kept" /\ KeptW -> "kept"
                       [] OTHER -> "none"
       IN IF result # "none"
             THEN /\ locks' = ReleaseIn(locks, "sweeper")
                  /\ pcS' = "done"
                  /\ sResult' = result
             ELSE /\ pcS' = "checked"
                  /\ UNCHANGED <<locks, sResult>>
    /\ UNCHANGED <<w, deleted, seen, pcC, pcE>>

S_Commit ==
    /\ pcS = "checked"
    /\ deleted' = {"R"}
    /\ locks' = ReleaseIn(locks, "sweeper")
    /\ pcS' = "done"
    /\ sResult' = "deleted"
    /\ UNCHANGED <<w, seen, pcC, pcE>>

(* A Workflow created under O: O's row first (lockLiveParent), then, with StartCheck, the sessions above O are read (a   *)
(* deleted one: refused, nothing created), then the insert, visible at the commit.                                     *)
C_Lock ==
    /\ pcC = "idle"
    /\ CanLock("create", "O", CreateMode)
    /\ locks' = AcquireAll(locks, "create", {"O"}, CreateMode)
    /\ pcC' = "locked"
    /\ UNCHANGED <<w, deleted, pcS, sResult, seen, pcE>>

C_Commit ==
    /\ pcC = "locked"
    /\ IF StartCheck /\ "R" \in deleted
          THEN /\ pcC' = "refused"
               /\ pcE' = "done"   \* no Workflow, so no run to end
               /\ UNCHANGED w
          ELSE /\ pcC' = "done"
               /\ w' = "active"
               /\ UNCHANGED pcE
    /\ locks' = ReleaseIn(locks, "create")
    /\ UNCHANGED <<deleted, pcS, sResult, seen>>

(* The run's end: W's row first (lockLiveSession), once W exists with a run that has not ended. *)
E_Lock ==
    /\ pcE = "idle"
    /\ w = "active"
    /\ CanLock("runend", "W", "nku")
    /\ locks' = AcquireAll(locks, "runend", {"W"}, "nku")
    /\ pcE' = "locked"
    /\ UNCHANGED <<w, deleted, pcS, sResult, seen, pcC>>

E_Commit ==
    /\ pcE = "locked"
    /\ w' = "finished"
    /\ locks' = ReleaseIn(locks, "runend")
    /\ pcE' = "done"
    /\ UNCHANGED <<deleted, pcS, sResult, seen, pcC>>

AllDone == pcS = "done" /\ pcC \in {"done", "refused"} /\ pcE = "done"
Finished == AllDone /\ UNCHANGED vars

Next ==
    \/ S_LockTarget \/ S_Read \/ S_LockLeft \/ S_Check \/ S_Commit
    \/ C_Lock \/ C_Commit
    \/ E_Lock \/ E_Commit
    \/ Finished

Spec == Init /\ [][Next]_vars

(* Safety. *)
TypeOK ==
    /\ w \in {"none", "active", "finished"}
    /\ deleted \subseteq {"R"}
    /\ seen \subseteq {"O", "W"}
    /\ sResult \in {"none", "deleted", "busy", "changed", "below", "kept"}
Inv_Locks == \A r \in Rows : \A l1, l2 \in locks[r] : l1[1] # l2[1] => ~Conflicts(l1[2], l2[2])
\* A Workflow the committed state keeps is never left under a deleted R, also one created after the prune committed.
Inv_KeptShown == ~(KeptW /\ "R" \in deleted)

(* Witnesses: each is expected to be violated, which shows that the outcome is reachable. *)
Wit_Deleted == sResult # "deleted"
Wit_Below == sResult # "below"
Wit_Busy == sResult # "busy"
Wit_Changed == sResult # "changed"
Wit_StartRefused == pcC # "refused"
=============================================================================
