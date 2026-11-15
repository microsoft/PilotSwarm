------------------------ MODULE MCExposureCode1e24Runs ------------------------
(***************************************************************************)
(* Activity-level model of the REPAIRED worker at core pin 1e240b0f       *)
(* (tree 9ff6cef4; after c1bda7a2: e966b418 native redelivery tests,       *)
(* 50291121 definite assignment, 1e240b0f W1-W3 fixes). Derived from the   *)
(* source diff c1bda7a2..1e240b0f, not from the review's suggestions.     *)
(* EXTENDS RecipientExposureCode (unchanged: store, migration and machine  *)
(* logic are unchanged at 1e240b0f; the machine diff is a comment only).  *)
(* Its c1bda7a2 companion is MCExposureCodeC1Runs (kept, defective).       *)
(* Per execution (act[k][e]):                                             *)
(*  any      intakeIncludedAny: activity-scoped (session-proxy.ts 1676).  *)
(*  runInc, runRef  the current run's own evidence {included, refused},    *)
(*           a new object at each run start (4646-4647), set by included()*)
(*           and by admit (1703-1714).                                    *)
(*  cancel   activityCtx.isCancelled() is true (native; AllowActCancel). *)
(*  latched  the activity's `cancelled` flag: set by the poll (4129-4130) *)
(*           or by eligible() reading isCancelled() (4650-4652); never     *)
(*           cleared.                                                      *)
(*  aborted  the current run's interrupt was set by the poll's abort after*)
(*           the initial send (a fresh interrupt per run).                *)
(* Repaired sends (eligible = ~latched after reading cancel):             *)
(*  run start: a cancelled activity starts no run; error, nothing sent    *)
(*    (4654-4657); admit re-reads eligible before the store (1703);       *)
(*  the final synchronous recheck refuses include and omit alike          *)
(*    (managed-session.ts 4088);                                          *)
(*  a corrective send needs no interrupt and eligibility (4031);         *)
(*  steers need eligibility (1530-1531, 1610; steers not modelled).       *)
(* Witness (1686-1689): the latest run's own include -> sent; else its    *)
(* refusal; else exposed (sent false) when any earlier run included; else *)
(* not sent. applyIntakeAttempt (machine 999): exposed -> possibly sent;  *)
(* completed only with the run's own sent. H-W1 as in C1Runs.            *)
(***************************************************************************)
EXTENDS RecipientExposureCode

CONSTANTS AllowActCancel, AllowConcurrentSettle, MaxRecover

ASSUME AllowActCancel \in BOOLEAN /\ AllowConcurrentSettle \in BOOLEAN
ASSUME MaxRecover \in Nat

NoAct == [cancel |-> FALSE, latched |-> FALSE, polled |-> FALSE, gapPoll |-> FALSE,
          aborted |-> FALSE, any |-> FALSE, runInc |-> FALSE, runRef |-> "none",
          wx |-> FALSE, runs |-> 0, corr |-> FALSE, fin |-> "none"]

VARIABLES act, sendWhileCancelled, sendAfterObservedCancel, recoverySendAfterGapPoll,
          correctionAfterAbort, legitCorrection, settledHidden, completedNoFinalInclude,
          loserSettledHidden, eligibilityBlocked, exposedWitnessApplied

rghost == <<sendWhileCancelled, sendAfterObservedCancel, recoverySendAfterGapPoll,
            correctionAfterAbort, legitCorrection, settledHidden, completedNoFinalInclude,
            loserSettledHidden, eligibilityBlocked, exposedWitnessApplied>>
rvars == <<act, rghost>>
allVars == <<vars, rvars>>

RInit ==
    /\ Init
    /\ act = [k \in Atts |-> [e \in Execs |-> NoAct]]
    /\ sendWhileCancelled = FALSE /\ sendAfterObservedCancel = FALSE
    /\ recoverySendAfterGapPoll = FALSE /\ correctionAfterAbort = FALSE
    /\ legitCorrection = FALSE /\ settledHidden = FALSE /\ completedNoFinalInclude = FALSE
    /\ loserSettledHidden = FALSE /\ eligibilityBlocked = FALSE /\ exposedWitnessApplied = FALSE

Live(k, e) == k <= nAtt /\ ex[k][e].ph \notin {"done", "crashed"}
Eligible(k, e) == ~act[k][e].cancel /\ ~act[k][e].latched

ActCancel(k, e) ==
    /\ AllowActCancel /\ Live(k, e) /\ ~act[k][e].cancel
    /\ act' = [act EXCEPT ![k][e].cancel = TRUE]
    /\ UNCHANGED <<vars, rghost>>

(* The poll: latches `cancelled`; aborts an awaiting run (as Guard) or a  *)
(* run that has sent; then stops.                                         *)
Poll(k, e) ==
    /\ Live(k, e) /\ act[k][e].cancel /\ ~act[k][e].polled
    /\ LET ph == ex[k][e].ph IN
       /\ act' = [act EXCEPT ![k][e].polled = TRUE, ![k][e].latched = TRUE,
                             ![k][e].gapPoll = (ph = "idle" /\ act[k][e].runs > 0),
                             ![k][e].aborted = (ph = "sent")]
       /\ IF ph \in {"await", "answered"} THEN Guard(k, e) ELSE UNCHANGED vars
    /\ UNCHANGED rghost

(* A run start that reads the activity cancelled: no run, error, nothing  *)
(* sent; the new run object has no evidence. Same gates as StartExec      *)
(* (first run) or RecoverExec (recovery run).                             *)
StartBlocked(k, e) ==
    /\ ~Eligible(k, e)
    /\ \/ /\ act[k][e].runs = 0 /\ k <= nAtt /\ att[k].st = "run" /\ ex[k][e].ph = "idle"
          /\ IF e = 1 THEN TRUE ELSE ex[k][e - 1].ph # "idle"
       \/ k <= nAtt /\ act[k][e].runs > 0 /\ ex[k][e].ph = "idle"
    /\ ex' = [ex EXCEPT ![k][e] = [NoEx EXCEPT !.ph = "ended"]]
    /\ act' = [act EXCEPT ![k][e].latched = TRUE, ![k][e].runInc = FALSE, ![k][e].runRef = "none"]
    /\ UNCHANGED <<storeVars, orchVars, nAtt, att, ghostVars, rghost>>

StartExecR(k, e) ==
    /\ act[k][e].runs = 0 /\ Eligible(k, e) /\ StartExec(k, e)
    /\ act' = [act EXCEPT ![k][e].runInc = FALSE, ![k][e].runRef = "none"]
    /\ UNCHANGED rghost

RecoverExec(k, e) ==
    /\ k <= nAtt /\ act[k][e].runs > 0 /\ ex[k][e].ph = "idle" /\ Eligible(k, e)
    /\ ex' = [ex EXCEPT ![k][e] = [NoEx EXCEPT !.ph = "await", !.infl = TRUE]]
    /\ act' = [act EXCEPT ![k][e].runInc = FALSE, ![k][e].runRef = "none"]
    /\ UNCHANGED <<storeVars, orchVars, nAtt, att, ghostVars, rghost>>

SessionLoss(k, e) ==
    /\ act[k][e].runs < MaxRecover
    /\ ex[k][e].ph \in {"await", "answered", "sent", "omitted"} /\ ~ex[k][e].infl
    /\ ex' = [ex EXCEPT ![k][e] = NoEx]
    /\ act' = [act EXCEPT ![k][e].runs = @ + 1, ![k][e].aborted = FALSE, ![k][e].corr = FALSE]
    /\ UNCHANGED <<storeVars, orchVars, nAtt, att, ghostVars, rghost>>

(* The final synchronous segment with eligibility: an eligible run sends  *)
(* (include or omit) as Deliver; otherwise the run ends, nothing sent.   *)
DeliverR(k, e) ==
    /\ Eligible(k, e) \/ ex[k][e].ans = "fault"
    /\ Deliver(k, e)
    /\ LET x == ex[k][e]
           a == act[k][e]
           snd == x.ans \in {"allowed", "exposed", "settled"}
       IN /\ act' = [act EXCEPT ![k][e].any = (a.any \/ x.ans = "allowed"),
                                ![k][e].runInc = (x.ans = "allowed"),
                                ![k][e].runRef = IF x.ans \in {"exposed", "settled"} THEN x.ans ELSE "none"]
          /\ sendWhileCancelled' = (sendWhileCancelled \/ (snd /\ a.cancel))
          /\ sendAfterObservedCancel' = (sendAfterObservedCancel \/ (snd /\ a.polled))
          /\ recoverySendAfterGapPoll' = (recoverySendAfterGapPoll \/ (snd /\ a.gapPoll))
    /\ UNCHANGED <<correctionAfterAbort, legitCorrection, settledHidden, completedNoFinalInclude,
                   loserSettledHidden, eligibilityBlocked, exposedWitnessApplied>>

DeliverBlocked(k, e) ==
    /\ ~Eligible(k, e)
    /\ ex[k][e].ph = "answered" /\ ex[k][e].ans # "fault"
    /\ ex' = [ex EXCEPT ![k][e].ph = "ended"]
    /\ act' = [act EXCEPT ![k][e].latched = TRUE,
                          ![k][e].runRef = IF ex[k][e].ans \in {"exposed", "settled"}
                                             THEN ex[k][e].ans ELSE "none"]
    /\ eligibilityBlocked' = TRUE
    /\ UNCHANGED <<storeVars, orchVars, nAtt, att, ghostVars, sendWhileCancelled,
                   sendAfterObservedCancel, recoverySendAfterGapPoll, correctionAfterAbort,
                   legitCorrection, settledHidden, completedNoFinalInclude, loserSettledHidden,
                   exposedWitnessApplied>>

(* The admission's answer: as AdmitTxn. admit sets run.refused when the  *)
(* answer arrives (session-proxy 1709), before the race is resolved, so a *)
(* guard after the answer keeps the refusal; it also reaches the run's    *)
(* evidence when the run already ended (admitWorkflowIntake returns after *)
(* the store whatever the signal), if the witness is not taken yet.       *)
(* r1 correction (pre-execution): the refusal was set only for an ended   *)
(* run, so answered -> Guard lost it.                                     *)
AdmitTxnR(k, e, lost) ==
    /\ AdmitTxn(k, e, lost)
    /\ LET a == StoreAdmit(k, ex[k][e].text) IN
       act' = IF ~lost /\ ex[k][e].ph \in {"await", "ended"} /\ a \in {"exposed", "settled"}
                THEN [act EXCEPT ![k][e].runRef = a] ELSE act
    /\ UNCHANGED rghost

Correct(k, e) ==
    /\ ex[k][e].ph = "sent" /\ ~act[k][e].corr
    /\ ~act[k][e].aborted /\ Eligible(k, e)
    /\ act' = [act EXCEPT ![k][e].corr = TRUE]
    /\ correctionAfterAbort' = (correctionAfterAbort \/ act[k][e].aborted)
    /\ legitCorrection' = (legitCorrection \/ ~act[k][e].aborted)
    /\ UNCHANGED <<vars, sendWhileCancelled, sendAfterObservedCancel, recoverySendAfterGapPoll,
                   settledHidden, completedNoFinalInclude, loserSettledHidden, eligibilityBlocked,
                   exposedWitnessApplied>>

(* withIntakeWitness at 1e240b0f.                                          *)
CompleteR(k, e) ==
    /\ ex[k][e].ph \in {"sent", "omitted", "ended"}
    /\ LET x == ex[k][e]
           a == act[k][e]
           w == IF a.runInc THEN "sent" ELSE IF a.runRef # "none" THEN a.runRef ELSE "unsent"
           wx == ~a.runInc /\ a.runRef = "none" /\ a.any
       IN /\ ex' = [ex EXCEPT ![k][e].ph = "done", ![k][e].wit = w]
          /\ att' = IF att[k].st = "run" THEN [att EXCEPT ![k].acc = e, ![k].st = "acc"] ELSE att
          /\ act' = [act EXCEPT ![k][e].fin = x.ph, ![k][e].wx = wx]
          /\ LET hid == x.ph = "omitted" /\ x.ans = "settled" /\ w # "settled" IN
             /\ settledHidden' = (settledHidden \/ (hid /\ att[k].st = "run"))
             /\ loserSettledHidden' = (loserSettledHidden \/ (hid /\ att[k].st # "run"))
    /\ UNCHANGED <<storeVars, orchVars, nAtt, ghostVars, sendWhileCancelled,
                   sendAfterObservedCancel, recoverySendAfterGapPoll, correctionAfterAbort,
                   legitCorrection, completedNoFinalInclude, eligibilityBlocked,
                   exposedWitnessApplied>>

(* applyIntakeAttempt at 1e240b0f; the base Apply plus the exposed-not-    *)
(* refused witness (possibly sent, never completed; machine 999-1010).   *)
ApplyX ==
    /\ ost = "carrying" /\ nAtt > 0 /\ att[nAtt].st = "acc"
    /\ LET k == nAtt
           e == att[k].acc
           w == ex[k][e].wit
           wx == act[k][e].wx
       IN /\ att' = [att EXCEPT ![k].st = "applied"]
          /\ IF wx
               THEN /\ \E ev \in {"retry", "end"} :
                         /\ ev = "retry" => nAtt < MaxAtt
                         /\ inv' = IF ev = "retry" THEN [inv EXCEPT !.sent = TRUE]
                                   ELSE [inv EXCEPT !.sent = TRUE, !.settle = "interrupted"]
                         /\ ost' = IF ev = "retry" THEN "retry" ELSE "ending"
                    /\ exposedWitnessApplied' = TRUE
                    /\ UNCHANGED settledFail
             ELSE IF w = "settled"
               THEN /\ ost' = "failed" /\ settledFail' = TRUE
                    /\ UNCHANGED <<inv, exposedWitnessApplied>>
             ELSE IF w = "exposed"
               THEN /\ inv' = [inv EXCEPT !.sent = TRUE, !.settle = "interrupted"]
                    /\ ost' = "ending"
                    /\ UNCHANGED <<settledFail, exposedWitnessApplied>>
             ELSE IF w = "sent"
               THEN /\ \E ev \in {"result", "retry", "stopped"} :
                         /\ ev = "retry" => nAtt < MaxAtt
                         /\ act[k][e].fin = "ended" => ev # "result"
                         /\ inv' = [inv EXCEPT !.sent = TRUE,
                                     !.settle = IF ev = "result" THEN "completed"
                                                ELSE IF ev = "stopped" THEN "interrupted" ELSE "none"]
                         /\ ost' = IF ev = "retry" THEN "retry" ELSE "ending"
                    /\ UNCHANGED <<settledFail, exposedWitnessApplied>>
             ELSE IF inv.sent
               THEN /\ \E ev \in {"retry", "end"} :
                         /\ ev = "retry" => nAtt < MaxAtt
                         /\ inv' = IF ev = "retry" THEN inv ELSE [inv EXCEPT !.settle = "interrupted"]
                         /\ ost' = IF ev = "retry" THEN "retry" ELSE "ending"
                    /\ UNCHANGED <<settledFail, exposedWitnessApplied>>
             ELSE /\ \E ev \in {"ready", "stopped", "park"} :
                         /\ inv' = IF ev = "stopped" THEN [inv EXCEPT !.settle = "not_dispatched"] ELSE inv
                         /\ ost' = IF ev = "stopped" THEN "ending"
                                   ELSE IF ev = "park" THEN "parked" ELSE "ready"
                  /\ UNCHANGED <<settledFail, exposedWitnessApplied>>
          /\ badOrigin' = (badOrigin \/ (inv'.settle = "completed" /\ w # "sent"))
          /\ completedNoFinalInclude' =
               (completedNoFinalInclude \/ (inv'.settle = "completed" /\ act[k][e].fin # "sent"))
    /\ UNCHANGED <<storeVars, oout, everLatch, cdone, nAtt, ex, phys, sends, badText, afterGuard,
                   badSb, proto, coerced, storeBroken, assertFail, guardPend, lateMarker,
                   cancelExposed, latchWhileEnding, act, sendWhileCancelled, sendAfterObservedCancel,
                   recoverySendAfterGapPoll, correctionAfterAbort, legitCorrection, settledHidden,
                   loserSettledHidden, eligibilityBlocked>>

ExternalSettle(i) ==
    /\ AllowConcurrentSettle /\ ost = "carrying" /\ proc[i] = "bound"
    /\ proc' = [proc EXCEPT ![i] = "final"]
    /\ UNCHANGED <<creq, out, endReq, marker, orchVars, attVars, ghostVars, rvars>>

RNext ==
    \/ (StartAttempt \/ Done) /\ UNCHANGED rvars
    \/ ApplyX
    \/ \E lost \in BOOLEAN : (EndCall(lost) \/ CancelWrite(lost)) /\ UNCHANGED rvars
    \/ \E k \in Atts, e \in Execs :
          \/ (Reissue(k, e) \/ Guard(k, e) \/ Crash(k, e)) /\ UNCHANGED rvars
          \/ \E lost \in BOOLEAN : AdmitTxnR(k, e, lost)
          \/ StartExecR(k, e) \/ StartBlocked(k, e) \/ RecoverExec(k, e) \/ SessionLoss(k, e)
          \/ DeliverR(k, e) \/ DeliverBlocked(k, e) \/ CompleteR(k, e)
          \/ ActCancel(k, e) \/ Poll(k, e) \/ Correct(k, e)
    \/ \E i \in Items : \/ (Latch(i) \/ CancelReplay(i)) /\ UNCHANGED rvars
                        \/ ExternalSettle(i)

RSpec == RInit /\ [][RNext]_allVars

-----------------------------------------------------------------------------
(* Same requirements as MCExposureCodeC1Runs; at 1e240b0f predicted to   *)
(* HOLD (predictions, not results).                                       *)
Inv_R_NoSendWhileCancelled == ~sendWhileCancelled
Inv_R_NoSendAfterObservedCancel == ~sendAfterObservedCancel
Inv_R_NoRecoverySendAfterGapPoll == ~recoverySendAfterGapPoll
Inv_R_NoCorrectionAfterAbort == ~correctionAfterAbort
Inv_R_SettledRefusalNotHidden == ~settledHidden
Inv_R_CompletedFromFinalInclude == ~completedNoFinalInclude
Inv_R_LoserSettledNotHidden == ~loserSettledHidden

(* Positive controls, EXPECTED to be violated (reachable).               *)
Wit_R_LegitCorrection == ~legitCorrection
Wit_R_RecoveredInclude == ~(\E k \in Atts, e \in Execs : act[k][e].runs > 0 /\ ex[k][e].ph = "sent")
Wit_R_EligibilityBlocked == ~eligibilityBlocked
Wit_R_ExposedWitnessApplied == ~exposedWitnessApplied

=============================================================================
