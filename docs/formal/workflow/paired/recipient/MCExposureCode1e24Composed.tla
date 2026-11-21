---------------------- MODULE MCExposureCode1e24Composed ----------------------
(***************************************************************************)
(* Composition at core pin 1e240b0f: the repaired worker runs              *)
(* (MCExposureCode1e24Runs) with the source-faithful end and cancel-write  *)
(* ordering (MCExposureCodeC1EndCancel; store, migration and machine are   *)
(* unchanged from c1bda7a2 to 1e240b0f). Both extend RecipientExposureCode;*)
(* each action is taken from exactly one of them, and the other's         *)
(* variables are left unchanged:                                          *)
(*  worker and attempt application: MCExposureCode1e24Runs;               *)
(*  end, its answer, duplicate ends, cancel call, per-item cancel         *)
(*    transactions, cancel answer: MCExposureCodeC1EndCancel;             *)
(*  StartAttempt, Done, Latch, CancelReplay: the base.                    *)
(* Orchestration steps wait while a store write is in flight (OrchFree). *)
(* The base EndCall/CancelWrite and the base Apply/Deliver/Complete/      *)
(* StartExec/AdmitTxn are not used.                                       *)
(***************************************************************************)
EXTENDS MCExposureCode1e24Runs, MCExposureCodeC1EndCancel

cVars == <<vars, rvars, eVars>>

CInit == RInit /\ EInit

WorkerStep(k, e) ==
    \/ (Reissue(k, e) \/ Guard(k, e) \/ Crash(k, e)) /\ UNCHANGED <<rvars, eVars>>
    \/ (\/ \E lost \in BOOLEAN : AdmitTxnR(k, e, lost)
        \/ StartExecR(k, e) \/ StartBlocked(k, e) \/ RecoverExec(k, e) \/ SessionLoss(k, e)
        \/ DeliverR(k, e) \/ DeliverBlocked(k, e) \/ CompleteR(k, e)
        \/ ActCancel(k, e) \/ Poll(k, e) \/ Correct(k, e)) /\ UNCHANGED eVars

CNext ==
    \/ ((StartAttempt /\ OrchFree) \/ Done) /\ UNCHANGED <<rvars, eVars>>
    \/ ApplyX /\ UNCHANGED eVars
    \/ (EndStore \/ CancelCall) /\ UNCHANGED rvars
    \/ \E lost \in BOOLEAN : (EndAnswer(lost) \/ CancelAnswer(lost)) /\ UNCHANGED rvars
    \/ \E r \in Outs : EndDup(r) /\ UNCHANGED rvars
    \/ \E k \in Atts, e \in Execs : WorkerStep(k, e)
    \/ \E i \in Items : \/ ((Latch(i) /\ OrchFree) \/ CancelReplay(i)) /\ UNCHANGED <<rvars, eVars>>
                        \/ CancelItem(i) /\ UNCHANGED rvars
                        \/ ExternalSettle(i) /\ UNCHANGED eVars

CSpec == CInit /\ [][CNext]_cVars

=============================================================================
