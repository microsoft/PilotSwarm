--------------------- MODULE WorkflowSessionCommands ---------------------
(***************************************************************************)
(* A lifecycle command (cancel or delete) that a parent's durable session  *)
(* sends to its workflow child through the sendCommandToSession         *)
(* activity, as packages/sdk/src/workflow and session-proxy.ts          *)
(* implement it in the commit of this file (README "Session command        *)
(* model"). The activity is at least once: attempt 1 may stop after any    *)
(* step, and attempt 2 is its redelivery, which may overlap it. Attempt 3  *)
(* is a different request that reuses the command's id. The child's        *)
(* controller may begin its run, end it, and apply a queued command, and   *)
(* another path may delete the child. The command (done takes cancel's     *)
(* path) is a constant. With Legacy, an earlier build (9fda34bd) accepted  *)
(* this delete as queued for a begun run and its attempt stopped before    *)
(* the command was applied; the child is still live, its run running or   *)
(* already ended, and attempt 2 is this build's same-id repeat.            *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS
    Command,          \* "cancel" or "delete"
    Conflict,         \* environment: attempt 3, a different request with the command's id
    OtherDelete,      \* environment: another path deletes the child (with its facts)
    DeleteInStore,    \* fix 0f373abc: every new delete is applied in the store; FALSE is 9fda34bd (a begun run's delete was queued)
    ReplayRepair,     \* fix 0f373abc: a repeat of an accepted delete whose child is live deletes it; FALSE is a deliberate fault
    DeletedChildPath, \* fix b1d1d4b9: a deleted child, however seen, gets the receipt check and a delete's facts cleanup; FALSE is 31dc9888
    Legacy            \* history: "none", or an earlier build's queued delete receipt with the run "running" or "ended"

ASSUME Command \in {"cancel", "delete"}
ASSUME {Conflict, OtherDelete, DeleteInStore, ReplayRepair, DeletedChildPath} \subseteq BOOLEAN
ASSUME Legacy \in {"none", "running", "ended"}
ASSUME Legacy # "none" => Command = "delete"

Atts == {1, 2, 3}
Digest(a) == IF a = 3 THEN "d2" ELSE "d1"
ActiveStatus == {"admitted", "running"}

VARIABLES
    deleted,      \* the child session is soft-deleted
    facts,        \* the child's facts: "present", "cleaned"
    status,       \* the child's live run: "admitted" (not begun), "running", "completed", "cancelled"
    ctl,          \* the child's controller: "notBegun", "running", "done"
    queued,       \* the command waits in the controller's queue
    rcptDigest,   \* the receipt stored under the command's operation id: "none", "d1", "d2"
    rcptApplied,  \* how it was applied: "none", "store", "queued", "nothing"
    apc,          \* each attempt's step
    ares,         \* each attempt's receipt (applied) after its transaction
    aout,         \* each attempt's answer: "none", "applied", "enqueue", "refused"
    acceptedNotBegun, \* ghost: a cancel was accepted for a run that had not begun
    conflictApplied,  \* ghost: an attempt answered applied or enqueue for a request whose id has another receipt
    repaired          \* ghost: a repeat of an accepted delete deleted the live child (the replay repair branch)

rcptVars == <<rcptDigest, rcptApplied>>
attVars == <<apc, ares, aout>>
ghostVars == <<acceptedNotBegun, conflictApplied, repaired>>
vars == <<deleted, facts, status, ctl, queued, rcptVars, attVars, ghostVars>>

Steps == {"idle", "link", "tx", "deletedPath", "deletedPath2", "after", "cleanup", "enqueue", "returned", "refused", "lost"}

TypeOK ==
    /\ deleted \in BOOLEAN
    /\ facts \in {"present", "cleaned"}
    /\ status \in {"admitted", "running", "completed", "cancelled"}
    /\ ctl \in {"notBegun", "running", "done"}
    /\ queued \in BOOLEAN
    /\ rcptDigest \in {"none", "d1", "d2"}
    /\ rcptApplied \in {"none", "store", "queued", "nothing"}
    /\ apc \in [Atts -> Steps]
    /\ ares \in [Atts -> {"none", "store", "queued", "nothing"}]
    /\ aout \in [Atts -> {"none", "applied", "enqueue", "refused"}]
    /\ acceptedNotBegun \in BOOLEAN
    /\ conflictApplied \in BOOLEAN
    /\ repaired \in BOOLEAN

(* Without Legacy: a live child whose run has not begun, and no receipt.    *)
(* With Legacy: the earlier build's receipt (d1, queued) is stored, its     *)
(* attempt (1) stopped, the child is live and its run is running (the       *)
(* command may be queued) or already completed.                            *)
Init ==
    /\ deleted = FALSE /\ facts = "present"
    /\ status = CASE Legacy = "running" -> "running"
                 [] Legacy = "ended" -> "completed"
                 [] OTHER -> "admitted"
    /\ ctl = CASE Legacy = "running" -> "running"
              [] Legacy = "ended" -> "done"
              [] OTHER -> "notBegun"
    /\ queued \in (IF Legacy = "running" THEN BOOLEAN ELSE {FALSE})
    /\ rcptDigest = IF Legacy = "none" THEN "none" ELSE "d1"
    /\ rcptApplied = IF Legacy = "none" THEN "none" ELSE "queued"
    /\ apc = [a \in Atts |-> IF a = 1 /\ Legacy # "none" THEN "lost" ELSE "idle"]
    /\ ares = [a \in Atts |-> "none"] /\ aout = [a \in Atts |-> "none"]
    /\ acceptedNotBegun = FALSE /\ conflictApplied = FALSE /\ repaired = FALSE

(* Attempt 1 starts; attempt 2, its redelivery, may start any time after    *)
(* it; attempt 3 exists only with Conflict.                                 *)
StartAtt(a) ==
    /\ apc[a] = "idle"
    /\ a = 2 => apc[1] # "idle"
    /\ a = 3 => Conflict
    /\ apc' = [apc EXCEPT ![a] = "link"]
    /\ UNCHANGED <<deleted, facts, status, ctl, queued, rcptVars, ares, aout, ghostVars>>

(* S readSessionLink, before any lock.                                      *)
ReadLink(a) ==
    /\ apc[a] = "link"
    /\ apc' = [apc EXCEPT ![a] = IF deleted THEN "deletedPath" ELSE "tx"]
    /\ UNCHANGED <<deleted, facts, status, ctl, queued, rcptVars, ares, aout, ghostVars>>

(* S recordSessionCommand: one transaction under the session, definition    *)
(* and run locks. A deleted session fails it (WORKFLOW_DELETED); a receipt  *)
(* of another request fails it (OPERATION_CONFLICT); a repeat returns the   *)
(* stored receipt, as stored, and applies an accepted delete whose child is *)
(* live (ReplayRepair). A new delete soft-deletes the child (the trigger ends *)
(* an active run); a new cancel ends a run that has not begun, is queued    *)
(* for a run that has begun, and has nothing to apply otherwise.            *)
TxConflict(a) == rcptDigest \notin {"none", Digest(a)}
TxReplay(a) == rcptDigest = Digest(a)
TxFresh(a) == ~deleted /\ ~TxConflict(a) /\ ~TxReplay(a)
NewApplied == CASE Command = "delete" /\ (DeleteInStore \/ status # "running") -> "store"
                [] status = "running" -> "queued"
                [] status = "admitted" -> "store"
                [] OTHER -> "nothing"
SoftDeletes(a) ==
    /\ ~deleted
    /\ ~TxConflict(a)
    /\ Command = "delete"
    /\ \/ TxFresh(a) /\ NewApplied = "store"
       \/ TxReplay(a) /\ ReplayRepair
CancelsNow(a) == TxFresh(a) /\ Command = "cancel" /\ status = "admitted"

StoreTx(a) ==
    /\ apc[a] = "tx"
    /\ deleted' = (deleted \/ SoftDeletes(a))
    /\ status' = CASE SoftDeletes(a) /\ status \in ActiveStatus -> "cancelled"
                   [] CancelsNow(a) -> "cancelled"
                   [] OTHER -> status
    /\ rcptDigest' = IF TxFresh(a) THEN Digest(a) ELSE rcptDigest
    /\ rcptApplied' = IF TxFresh(a) THEN NewApplied ELSE rcptApplied
    /\ ares' = [ares EXCEPT ![a] = IF TxReplay(a) THEN rcptApplied ELSE NewApplied]
    /\ apc' = [apc EXCEPT ![a] = (CASE deleted -> "deletedPath2"
                                    [] TxConflict(a) -> "refused"
                                    [] OTHER -> "after")]
    /\ aout' = [aout EXCEPT ![a] = IF ~deleted /\ TxConflict(a) THEN "refused" ELSE aout[a]]
    /\ acceptedNotBegun' = (acceptedNotBegun \/ CancelsNow(a))
    /\ repaired' = (repaired \/ (TxReplay(a) /\ SoftDeletes(a)))
    /\ UNCHANGED <<facts, ctl, queued, conflictApplied>>

(* V applySessionCommandToWorkflow for a deleted child: "deletedPath" is  *)
(* the link read deleted, "deletedPath2" the transaction's WORKFLOW_DELETED.*)
(* With DeletedChildPath both read the receipt (another request's is        *)
(* refused) and a delete removes the facts. In 31dc9888 only the link path  *)
(* read the receipt, and it removed the facts only for its own receipt; the *)
(* transaction path answered applied with neither.                         *)
Checked(a) == DeletedChildPath \/ apc[a] = "deletedPath"
DcConflict(a) == Checked(a) /\ TxConflict(a)
DcCleans(a) == ~DcConflict(a) /\ Command = "delete"
               /\ (DeletedChildPath \/ (apc[a] = "deletedPath" /\ TxReplay(a)))

DeletedChild(a) ==
    /\ apc[a] \in {"deletedPath", "deletedPath2"}
    /\ facts' = IF DcCleans(a) THEN "cleaned" ELSE facts
    /\ apc' = [apc EXCEPT ![a] = IF DcConflict(a) THEN "refused" ELSE "returned"]
    /\ aout' = [aout EXCEPT ![a] = IF DcConflict(a) THEN "refused" ELSE "applied"]
    /\ conflictApplied' = (conflictApplied \/ (~DcConflict(a) /\ TxConflict(a)))
    /\ UNCHANGED <<deleted, status, ctl, queued, rcptVars, ares, acceptedNotBegun, repaired>>

(* After the transaction. 0f373abc and later: a delete removes the facts;  *)
(* a cancel queued for an active run is enqueued; otherwise the receipt is  *)
(* the answer. 9fda34bd: a queued command (a delete too) is enqueued while  *)
(* the run is active and otherwise answered without being applied; a        *)
(* delete applied in the store removes the facts.                          *)
AfterNext(a) ==
    IF DeleteInStore
    THEN (CASE Command = "delete" -> "cleanup"
            [] ares[a] = "queued" /\ status \in ActiveStatus -> "enqueue"
            [] OTHER -> "returned")
    ELSE (CASE ares[a] = "queued" /\ status \in ActiveStatus -> "enqueue"
            [] ares[a] = "store" /\ Command = "delete" -> "cleanup"
            [] OTHER -> "returned")

After(a) ==
    /\ apc[a] = "after"
    /\ apc' = [apc EXCEPT ![a] = AfterNext(a)]
    /\ aout' = [aout EXCEPT ![a] = IF AfterNext(a) = "returned" THEN "applied" ELSE aout[a]]
    /\ UNCHANGED <<deleted, facts, status, ctl, queued, rcptVars, ares, ghostVars>>

Cleanup(a) ==
    /\ apc[a] = "cleanup"
    /\ facts' = "cleaned"
    /\ apc' = [apc EXCEPT ![a] = "returned"]
    /\ aout' = [aout EXCEPT ![a] = "applied"]
    /\ UNCHANGED <<deleted, status, ctl, queued, rcptVars, ares, ghostVars>>

(* The activity's caller enqueues the command for the child's controller.   *)
Enqueue(a) ==
    /\ apc[a] = "enqueue"
    /\ queued' = TRUE
    /\ apc' = [apc EXCEPT ![a] = "returned"]
    /\ aout' = [aout EXCEPT ![a] = "enqueue"]
    /\ UNCHANGED <<deleted, facts, status, ctl, rcptVars, ares, ghostVars>>

(* Attempt 1 stops at any step (its redelivery is attempt 2).               *)
LoseFirst ==
    /\ apc[1] \in {"link", "tx", "deletedPath", "deletedPath2", "after", "cleanup", "enqueue"}
    /\ apc' = [apc EXCEPT ![1] = "lost"]
    /\ UNCHANGED <<deleted, facts, status, ctl, queued, rcptVars, ares, aout, ghostVars>>

(* The child's controller begins its run (S beginRun), or finds it ended.   *)
CtlBegin ==
    /\ ctl = "notBegun"
    /\ ctl' = IF ~deleted /\ status = "admitted" THEN "running" ELSE "done"
    /\ status' = IF ~deleted /\ status = "admitted" THEN "running" ELSE status
    /\ UNCHANGED <<deleted, facts, queued, rcptVars, attVars, ghostVars>>

(* The run's own end; the first run end stands.                            *)
RunEnd ==
    /\ ctl = "running"
    /\ status = "running"
    /\ status' = "completed"
    /\ ctl' = "done"
    /\ UNCHANGED <<deleted, facts, queued, rcptVars, attVars, ghostVars>>

(* The controller applies the queued command: the cancel activity ends the  *)
(* run, and for a delete it deletes the session (here with its facts).      *)
CtlApply ==
    /\ ctl = "running"
    /\ status = "running"
    /\ queued
    /\ status' = "cancelled"
    /\ deleted' = (deleted \/ Command = "delete")
    /\ facts' = IF Command = "delete" THEN "cleaned" ELSE facts
    /\ queued' = FALSE
    /\ ctl' = "done"
    /\ UNCHANGED <<rcptVars, attVars, ghostVars>>

(* A run that another transaction ended ends its controller.               *)
CtlExit ==
    /\ ctl = "running"
    /\ status # "running"
    /\ ctl' = "done"
    /\ UNCHANGED <<deleted, facts, status, queued, rcptVars, attVars, ghostVars>>

(* Another deletion path: soft delete (the trigger ends an active run),     *)
(* then its facts cleanup.                                                  *)
DeleteOther ==
    /\ OtherDelete
    /\ ~deleted
    /\ deleted' = TRUE
    /\ status' = IF status \in ActiveStatus THEN "cancelled" ELSE status
    /\ facts' = "cleaned"
    /\ UNCHANGED <<ctl, queued, rcptVars, attVars, ghostVars>>

Next ==
    \/ \E a \in Atts : (StartAtt(a) \/ ReadLink(a) \/ StoreTx(a) \/ DeletedChild(a) \/ After(a) \/ Cleanup(a) \/ Enqueue(a))
    \/ LoseFirst \/ CtlBegin \/ RunEnd \/ CtlApply \/ CtlExit \/ DeleteOther

(* Weak fairness of every attempt step, attempt 1's start, the redelivery   *)
(* of a lost attempt 1, and the controller. Losses, attempt 3, the run's    *)
(* begin and the other deletion are not fair.                              *)
Fairness ==
    /\ \A a \in Atts : WF_vars(ReadLink(a)) /\ WF_vars(StoreTx(a)) /\ WF_vars(DeletedChild(a))
    /\ \A a \in Atts : WF_vars(After(a)) /\ WF_vars(Cleanup(a)) /\ WF_vars(Enqueue(a))
    /\ WF_vars(StartAtt(1))
    /\ WF_vars(apc[1] = "lost" /\ StartAtt(2))
    /\ WF_vars(RunEnd) /\ WF_vars(CtlApply) /\ WF_vars(CtlExit)

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)

(* An attempt that answers applied for the delete has deleted the child and *)
(* removed its facts.                                                       *)
Inv_DeleteAnswerClean ==
    Command = "delete" => \A a \in {1, 2} : aout[a] = "applied" => (deleted /\ facts = "cleaned")

(* A request whose id another request's receipt holds is refused.           *)
Inv_ConflictRefused == ~conflictApplied

(* A cancel accepted before the run began wins (C1 for session commands).  *)
Inv_CancelBeforeBeginWins == acceptedNotBegun => status \notin {"running", "completed"}

CommandSafety == TypeOK /\ Inv_DeleteAnswerClean /\ Inv_ConflictRefused /\ Inv_CancelBeforeBeginWins

(* A stored receipt is never rewritten: a repeat that applies an earlier   *)
(* build's queued delete leaves it queued.                                  *)
Prop_ReceiptImmutable == [][(rcptDigest # "none" => (rcptDigest' = rcptDigest /\ rcptApplied' = rcptApplied))]_vars

(* The run's first end stands: a delete of a child whose run ended keeps    *)
(* that run's result.                                                      *)
Prop_RunEndKept == [][(status \in {"completed", "cancelled"} => status' = status)]_vars

(* Witness, expected to be violated: the replay repair branch is reached.   *)
Wit_ReplayRepair == ~repaired

(* An accepted delete takes effect: the child is deleted and its facts are  *)
(* removed, whatever its run does.                                          *)
Live_DeleteTakesEffect == (Command = "delete" /\ rcptDigest = "d1") ~> (deleted /\ facts = "cleaned")

=============================================================================
