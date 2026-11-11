------------------------- MODULE MCExposureCodeC1Runs -------------------------
(***************************************************************************)
(* Activity-level extension of RecipientExposureCode (c1bda7a2, unchanged)*)
(* for the code-review findings W1-W3 of the exposure code at c1bda7a2.  *)
(* It models the                                                          *)
(* c1bda7a2 worker AS WRITTEN; nothing here is the proposed correction.   *)
(* Base action bodies are reused; only Deliver, Complete and Apply are    *)
(* wrapped or re-stated. New, per execution (act[k][e]):                  *)
(*  cum      intakeSent: activity-scoped, never reset across recovery     *)
(*           runs (session-proxy.ts 1654-1703, 4644-4700).                *)
(*  ref      intakeRefused: activity-scoped, keeps the first refusal;     *)
(*           withIntakeWitness gives intakeSent priority (4704-4765).     *)
(*  runs     recovery runs started after live-session loss or transcript  *)
(*           corruption (runTurnWithPrompt again, same activity).         *)
(*  cancel   activityCtx.isCancelled() is true (native; AllowActCancel). *)
(*  polled   the 2 s poll observed it, aborted the current or no session  *)
(*           and cleared itself (4113-4123). A new run gets a fresh       *)
(*           RunInterrupt (managed-session.ts 1523-1524) and admission    *)
(*           does not consult the activity cancellation.                  *)
(*  gapPoll  that observation happened with no active run, after a       *)
(*           recovery-causing failure.                                     *)
(*  aborted  bare abort() hit the current run after its initial send.     *)
(*  corr     a corrective send (required-tool or tool-call-as-text       *)
(*           correction, managed-session.ts 4130-4188) happened in the    *)
(*           current run; runCorrection checks stopRequest only.          *)
(*  fin      the phase in which the completing run ended.                 *)
(* H-W1 (hypothesis, NOT established, AllowConcurrentSettle): an item may *)
(* be settled by another path while an attempt is carrying. The base      *)
(* model excludes it (drain between activities); no engine exclusion is   *)
(* established either way.                                                 *)
(***************************************************************************)
EXTENDS RecipientExposureCode

CONSTANTS AllowActCancel, AllowConcurrentSettle, MaxRecover

ASSUME AllowActCancel \in BOOLEAN /\ AllowConcurrentSettle \in BOOLEAN
ASSUME MaxRecover \in Nat

NoAct == [cancel |-> FALSE, polled |-> FALSE, gapPoll |-> FALSE, aborted |-> FALSE,
          cum |-> FALSE, ref |-> "none", runs |-> 0, corr |-> FALSE, fin |-> "none"]

VARIABLES act, sendWhileCancelled, sendAfterObservedCancel, recoverySendAfterGapPoll,
          correctionAfterAbort, legitCorrection, settledHidden, completedNoFinalInclude,
          loserSettledHidden

rghost == <<sendWhileCancelled, sendAfterObservedCancel, recoverySendAfterGapPoll,
            correctionAfterAbort, legitCorrection, settledHidden, completedNoFinalInclude,
            loserSettledHidden>>
rvars == <<act, rghost>>
allVars == <<vars, rvars>>

RInit ==
    /\ Init
    /\ act = [k \in Atts |-> [e \in Execs |-> NoAct]]
    /\ sendWhileCancelled = FALSE /\ sendAfterObservedCancel = FALSE
    /\ recoverySendAfterGapPoll = FALSE /\ correctionAfterAbort = FALSE
    /\ legitCorrection = FALSE /\ settledHidden = FALSE /\ completedNoFinalInclude = FALSE
    /\ loserSettledHidden = FALSE

Live(k, e) == k <= nAtt /\ ex[k][e].ph \notin {"done", "crashed"}

(* The native activity is cancelled (orchestration-side cancellation).    *)
ActCancel(k, e) ==
    /\ AllowActCancel /\ Live(k, e) /\ ~act[k][e].cancel
    /\ act' = [act EXCEPT ![k][e].cancel = TRUE]
    /\ UNCHANGED <<vars, rghost>>

(* The poll sees it once: an awaiting run ends (abort, as Guard); a run   *)
(* that has sent is aborted (bare abort, no requestStop); with no active  *)
(* run nothing is retained. The poll then stops.                          *)
Poll(k, e) ==
    /\ Live(k, e) /\ act[k][e].cancel /\ ~act[k][e].polled
    /\ LET ph == ex[k][e].ph IN
       /\ act' = [act EXCEPT ![k][e].polled = TRUE,
                             ![k][e].gapPoll = (ph = "idle" /\ act[k][e].runs > 0),
                             ![k][e].aborted = (ph = "sent")]
       /\ IF ph \in {"await", "answered"} THEN Guard(k, e) ELSE UNCHANGED vars
    /\ UNCHANGED rghost

(* The run fails with live-session loss or transcript corruption; the    *)
(* activity recovers with a new run (RecoverExec, same execution).       *)
(* intakeSent and intakeRefused are kept; the run interrupt is fresh.    *)
SessionLoss(k, e) ==
    /\ act[k][e].runs < MaxRecover
    /\ ex[k][e].ph \in {"await", "answered", "sent", "omitted"} /\ ~ex[k][e].infl
    /\ ex' = [ex EXCEPT ![k][e] = NoEx]
    /\ act' = [act EXCEPT ![k][e].runs = @ + 1, ![k][e].aborted = FALSE, ![k][e].corr = FALSE]
    /\ UNCHANGED <<storeVars, orchVars, nAtt, att, ghostVars, rghost>>

(* The recovery run asks for admission again with the same attemptId.   *)
(* Unlike StartExec it does not need the attempt to be still unaccepted: *)
(* a losing duplicate's activity keeps running.                          *)
RecoverExec(k, e) ==
    /\ k <= nAtt /\ act[k][e].runs > 0 /\ ex[k][e].ph = "idle"
    /\ ex' = [ex EXCEPT ![k][e] = [NoEx EXCEPT !.ph = "await", !.infl = TRUE]]
    /\ UNCHANGED <<storeVars, orchVars, nAtt, att, ghostVars, rvars>>

(* Deliver as written; any model request (include or omit) is a send.    *)
DeliverR(k, e) ==
    /\ Deliver(k, e)
    /\ LET x == ex[k][e]
           a == act[k][e]
           snd == x.ans \in {"allowed", "exposed", "settled"}
       IN /\ act' = [act EXCEPT ![k][e].cum = (a.cum \/ x.ans = "allowed"),
                                ![k][e].ref = IF x.ans \in {"exposed", "settled"} /\ a.ref = "none"
                                                THEN x.ans ELSE a.ref]
          /\ sendWhileCancelled' = (sendWhileCancelled \/ (snd /\ a.cancel))
          /\ sendAfterObservedCancel' = (sendAfterObservedCancel \/ (snd /\ a.polled))
          /\ recoverySendAfterGapPoll' = (recoverySendAfterGapPoll \/ (snd /\ a.gapPoll))
    /\ UNCHANGED <<correctionAfterAbort, legitCorrection, settledHidden, completedNoFinalInclude,
                   loserSettledHidden>>

(* One corrective send after the initial send of the current run.        *)
Correct(k, e) ==
    /\ ex[k][e].ph = "sent" /\ ~act[k][e].corr
    /\ act' = [act EXCEPT ![k][e].corr = TRUE]
    /\ correctionAfterAbort' = (correctionAfterAbort \/ act[k][e].aborted)
    /\ legitCorrection' = (legitCorrection \/ ~act[k][e].aborted)
    /\ UNCHANGED <<vars, sendWhileCancelled, sendAfterObservedCancel, recoverySendAfterGapPoll,
                   settledHidden, completedNoFinalInclude, loserSettledHidden>>

(* withIntakeWitness as written: intakeSent first, then the first refusal.*)
(* settledHidden: the accepted completion (A-ACCEPT, first) hides its    *)
(* final run's settled refusal; loserSettledHidden: a later completion.  *)
CompleteR(k, e) ==
    /\ ex[k][e].ph \in {"sent", "omitted", "ended"}
    /\ LET x == ex[k][e]
           a == act[k][e]
           own == IF x.ph = "sent" THEN "sent" ELSE IF x.ph = "omitted" THEN x.ans ELSE "unsent"
           w == IF a.cum THEN "sent" ELSE IF a.ref # "none" THEN a.ref ELSE own
       IN /\ ex' = [ex EXCEPT ![k][e].ph = "done", ![k][e].wit = w]
          /\ att' = IF att[k].st = "run" THEN [att EXCEPT ![k].acc = e, ![k].st = "acc"] ELSE att
          /\ act' = [act EXCEPT ![k][e].fin = x.ph]
          /\ LET hid == a.cum /\ x.ph = "omitted" /\ x.ans = "settled" IN
             /\ settledHidden' = (settledHidden \/ (hid /\ att[k].st = "run"))
             /\ loserSettledHidden' = (loserSettledHidden \/ (hid /\ att[k].st # "run"))
    /\ UNCHANGED <<storeVars, orchVars, nAtt, ghostVars, sendWhileCancelled,
                   sendAfterObservedCancel, recoverySendAfterGapPoll, correctionAfterAbort,
                   legitCorrection, completedNoFinalInclude>>

(* applyIntakeAttempt unchanged; a run that ended before its send yields *)
(* no model result, so it is never applied as a completion.              *)
ApplyR ==
    /\ Apply
    /\ LET e == att[nAtt].acc IN
       /\ act[nAtt][e].fin = "ended" => inv'.settle # "completed"
       /\ completedNoFinalInclude' =
            (completedNoFinalInclude \/ (inv'.settle = "completed" /\ act[nAtt][e].fin # "sent"))
    /\ UNCHANGED <<act, sendWhileCancelled, sendAfterObservedCancel, recoverySendAfterGapPoll,
                   correctionAfterAbort, legitCorrection, settledHidden, loserSettledHidden>>

(* H-W1 only: another path settles a carried item while it is carrying.  *)
ExternalSettle(i) ==
    /\ AllowConcurrentSettle /\ ost = "carrying" /\ proc[i] = "bound"
    /\ proc' = [proc EXCEPT ![i] = "final"]
    /\ UNCHANGED <<creq, out, endReq, marker, orchVars, attVars, ghostVars, rvars>>

RNext ==
    \/ (StartAttempt \/ Done) /\ UNCHANGED rvars
    \/ ApplyR
    \/ \E lost \in BOOLEAN : (EndCall(lost) \/ CancelWrite(lost)) /\ UNCHANGED rvars
    \/ \E k \in Atts, e \in Execs :
          \/ (\/ StartExec(k, e) \/ Reissue(k, e) \/ Guard(k, e) \/ Crash(k, e)
              \/ \E lost \in BOOLEAN : AdmitTxn(k, e, lost)) /\ UNCHANGED rvars
          \/ DeliverR(k, e) \/ CompleteR(k, e)
          \/ ActCancel(k, e) \/ Poll(k, e) \/ SessionLoss(k, e) \/ RecoverExec(k, e)
          \/ Correct(k, e)
    \/ \E i \in Items : \/ (Latch(i) \/ CancelReplay(i)) /\ UNCHANGED rvars
                        \/ ExternalSettle(i)

RSpec == RInit /\ [][RNext]_allVars

-----------------------------------------------------------------------------
(* Required by the accepted design and the pair review. At c1bda7a2 the  *)
(* W2/W3 ones are EXPECTED to be violated (source-backed findings, not    *)
(* injected faults); W1 ones depend on H-W1.                              *)
Inv_R_NoSendWhileCancelled == ~sendWhileCancelled              \* W2 (synchronous check)
Inv_R_NoSendAfterObservedCancel == ~sendAfterObservedCancel    \* W2
Inv_R_NoRecoverySendAfterGapPoll == ~recoverySendAfterGapPoll  \* W2 (recovery gap)
Inv_R_NoCorrectionAfterAbort == ~correctionAfterAbort          \* W3
Inv_R_SettledRefusalNotHidden == ~settledHidden                \* W1
Inv_R_CompletedFromFinalInclude == ~completedNoFinalInclude    \* W1

(* Positive controls, EXPECTED to be violated (reachable).               *)
Wit_R_LegitCorrection == ~legitCorrection
(* Diagnostic, EXPECTED to be violated without H-W1 (MaxExec 2): a losing *)
(* duplicate recovers after the winner ended the invocation, is refused   *)
(* settled, and still reports sent. Dropped under A-ACCEPT; relevant only *)
(* if acceptance is not first-completion or for the WIT4 overlay.        *)
Wit_R_LoserSettledHidden == ~loserSettledHidden
Wit_R_RecoveredInclude == ~(\E k \in Atts, e \in Execs : act[k][e].runs > 0 /\ ex[k][e].ph = "sent")

=============================================================================
