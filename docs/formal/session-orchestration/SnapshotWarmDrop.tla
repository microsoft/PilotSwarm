--------------------------- MODULE SnapshotWarmDrop ---------------------------
(***************************************************************************)
(* One turn's snapshot step in the runTurn activity (session-proxy.ts at  *)
(* e76a6133), touchpoint T4 (review RT-F1): after a model run that aborted *)
(* following a turn-control failure that did not settle, the warm session *)
(* is dropped (invalidateWarmSession: destroyed, so the CLI stops and     *)
(* flushes; session-manager.ts 3633-3647) before the snapshot is committed *)
(* (runTurnCommit, session-proxy.ts 5610). If the drop fails, the attempt *)
(* fails (retryable) and nothing of it is saved (session-proxy.ts          *)
(* 5244-5259). Before RT-F1 (main) there was no drop.                      *)
(*                                                                         *)
(* A live warm session of an unsettled run can still write the session's   *)
(* local state; a snapshot committed then may miss or later disagree with  *)
(* those writes. Retried attempts of the same turn share its turn key;     *)
(* TurnCommit.tla checks the key, the model call and the adoption.         *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    MaxTries,       \* attempts of the turn (the activity's retries)
    MaxDropFail,    \* drops that may fail
    AllowUnsettled, \* a run may abort after an unsettled turn-control failure
    Mode,           \* "rt-f1" (e76a6133), "no-drop" (main, before RT-F1)
    Fault           \* "none", "commit-before-drop", "swallow-drop-failure"

ASSUME MaxTries \in 1..3 /\ MaxDropFail \in 0..2 /\ AllowUnsettled \in BOOLEAN
ASSUME Mode \in {"rt-f1", "no-drop"} /\ Fault \in {"none", "commit-before-drop", "swallow-drop-failure"}

VARIABLES
    att,        \* the current attempt: "idle", "running", "ran", "dropped", "failed", "done"
    tries,      \* attempts started
    unsettled,  \* this attempt's run aborted after an unsettled turn-control failure
    warm,       \* the attempt's warm session: "none", "live", "gone"
    committed,  \* the turn's snapshot was committed
    commitBy,   \* the attempt that committed it (0: none)
    failedSet,  \* attempts that failed
    dropFails,  \* failed drops so far
    gh          \* ghost flags
vars == <<att, tries, unsettled, warm, committed, commitBy, failedSet, dropFails, gh>>

Init ==
    /\ att = "idle" /\ tries = 0 /\ unsettled = FALSE /\ warm = "none" /\ committed = FALSE
    /\ commitBy = 0 /\ failedSet = {} /\ dropFails = 0 /\ gh = {}

(* An attempt starts: the session is hydrated or reused warm.             *)
Start ==
    /\ att \in {"idle", "failed"} /\ tries < MaxTries /\ ~committed
    /\ att' = "running" /\ tries' = tries + 1 /\ unsettled' = FALSE /\ warm' = "live"
    /\ UNCHANGED <<committed, commitBy, failedSet, dropFails, gh>>

(* The model run ends, normally or aborted after an unsettled failure.    *)
Run ==
    /\ att = "running"
    /\ \E u \in (IF AllowUnsettled THEN BOOLEAN ELSE {FALSE}) : unsettled' = u
    /\ att' = "ran"
    /\ UNCHANGED <<tries, warm, committed, commitBy, failedSet, dropFails, gh>>

(* A live warm session of an unsettled run may still write local state.   *)
WarmWrite ==
    /\ warm = "live" /\ unsettled /\ att \in {"ran", "dropped", "done"}
    /\ gh' = gh \cup (IF committed /\ commitBy = tries THEN {"writeAfterCommit"} ELSE {"write"})
    /\ UNCHANGED <<att, tries, unsettled, warm, committed, commitBy, failedSet, dropFails>>

(* RT-F1: an unsettled run's warm session is dropped before the commit.   *)
(* The handle is forgotten whatever fails; a failed drop fails the attempt.*)
Drop ==
    /\ Mode = "rt-f1" /\ att = "ran" /\ unsettled
    /\ \E fail \in (IF dropFails < MaxDropFail THEN BOOLEAN ELSE {FALSE}) :
         IF fail /\ Fault # "swallow-drop-failure"
         THEN /\ att' = "failed" /\ failedSet' = failedSet \cup {tries} /\ dropFails' = dropFails + 1
              /\ warm' = "gone"
         ELSE /\ att' = "dropped" /\ dropFails' = IF fail THEN dropFails + 1 ELSE dropFails
              /\ warm' = IF fail THEN "live" ELSE "gone"
              /\ UNCHANGED failedSet
    /\ UNCHANGED <<tries, unsettled, committed, commitBy, gh>>

(* runTurnCommit: the snapshot is committed (a compare-and-swap on the     *)
(* turn's base; the first commit of the turn wins).                       *)
CanCommit ==
    \/ att = "dropped"
    \/ (att = "ran" /\ (~unsettled \/ Mode = "no-drop" \/ Fault = "commit-before-drop"))
Commit ==
    /\ CanCommit /\ ~committed
    /\ committed' = TRUE /\ commitBy' = tries /\ att' = "done"
    /\ gh' = gh \cup (IF unsettled /\ warm = "live" THEN {"commitWhileWarm"} ELSE {})
    /\ UNCHANGED <<tries, unsettled, warm, failedSet, dropFails>>

(* commit-before-drop: the drop after the commit.                         *)
LateDrop ==
    /\ Fault = "commit-before-drop" /\ att = "done" /\ unsettled /\ warm = "live"
    /\ warm' = "gone"
    /\ UNCHANGED <<att, tries, unsettled, committed, commitBy, failedSet, dropFails, gh>>

Done == (committed \/ (att = "failed" /\ tries = MaxTries)) /\ UNCHANGED vars

Next == Start \/ Run \/ WarmWrite \/ Drop \/ Commit \/ LateDrop \/ Done
Spec == Init /\ [][Next]_vars
Fairness == WF_vars(Start) /\ WF_vars(Run) /\ WF_vars(Drop) /\ WF_vars(Commit) /\ WF_vars(LateDrop)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK ==
    /\ att \in {"idle", "running", "ran", "dropped", "failed", "done"} /\ tries \in 0..MaxTries
    /\ warm \in {"none", "live", "gone"} /\ {unsettled, committed} \subseteq BOOLEAN
    /\ commitBy \in 0..MaxTries /\ failedSet \subseteq 1..MaxTries /\ dropFails \in 0..MaxDropFail

(* T4: a snapshot is never committed while the unsettled run's warm       *)
(* session is live (it could still write).                                *)
Inv_NoCommitWhileWarm == "commitWhileWarm" \notin gh
(* T4: an attempt whose drop failed saves nothing.                        *)
Inv_FailedAttemptSavesNothing == commitBy \notin failedSet
(* No write of the committing attempt's warm session after its commit.    *)
Inv_NoWriteAfterCommit == "writeAfterCommit" \notin gh

(* Progress: with finitely many failed drops and enough attempts, the turn *)
(* is committed.                                                          *)
Prop_TurnCommits == <>committed

W_NoDropFailure == failedSet = {}
W_NoUnsettledCommit == ~(committed /\ unsettled)
=============================================================================
