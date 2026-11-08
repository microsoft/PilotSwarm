---------------------- MODULE WorkflowV2RequestCodeAuth ----------------------
(***************************************************************************)
(* Authority-change interleavings for the code model at 8021c75e.         *)
(* It uses WorkflowV2RequestCode (checkpoint 2) unchanged, with one        *)
(* difference: CP2's CLoseAuthority, which assumes a change of authority   *)
(* waits for an open response transaction (A-OWN), is replaced by an       *)
(* environment chosen by AuthEnv:                                          *)
(*                                                                         *)
(*  "source_8021":   the authority changes that the source can make at     *)
(*                   8021c75e. A loss happens only through a session row    *)
(*                   that lockSessionPair locks, and the model already has  *)
(*                   it as CDeleteResponder (and CDelete for the           *)
(*                   requester). Changes to the unlocked inputs            *)
(*                   (session_owners, users, the definition's parent) can  *)
(*                   only add authority, and an entered request already    *)
(*                   has it, so they change nothing here                   *)
(*                   (CODE-AUTH-AUDIT.md).                                 *)
(*  "unlocked_loss": assumption removed. The responder loses authority at  *)
(*                   any time, also while a response transaction holds     *)
(*                   the session locks. The audit found no path at        *)
(*                   8021c75e that does this.                              *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Deadline, MaxTime, Ops, Vals, MaxBindings, Caller, AuthEnv

ASSUME AuthEnv \in {"source_8021", "unlocked_loss"}

VARIABLES clock, sReq, sResp, rel, runSt, finished, nd, resp, ops, wakeRow,
          txn, lastCode, leak

C == INSTANCE WorkflowV2RequestCode

(* Not reachable from the source at 8021c75e (audit): a loss of authority *)
(* through rows that lockSessionPair reads without a lock.                 *)
UnlockedLoss ==
    /\ AuthEnv = "unlocked_loss"
    /\ rel
    /\ rel' = FALSE
    /\ UNCHANGED <<clock, sReq, sResp, runSt, finished, nd, resp, ops, wakeRow,
                   txn, lastCode, leak>>

AuthNext ==
    \/ C!CTick
    \/ \E a \in C!Actors, o \in Ops, r \in C!Results : C!RLock(a, o, r)
    \/ C!RBody
    \/ C!RCommit
    \/ C!CFinishRun
    \/ C!CDelete
    \/ C!CDeleteResponder
    \/ C!CElapse
    \/ UnlockedLoss

AuthSpec == C!Init /\ [][AuthNext]_C!cvars

TypeOK_C              == C!TypeOK_C
Inv_C_StatusMapped    == C!Inv_C_StatusMapped
Inv_C_NoCorruptAnswer == C!Inv_C_NoCorruptAnswer

(* The refinement obligation of checkpoint 2, unchanged.                   *)
Refines == C!Refines

=============================================================================
