--------------------- MODULE MCExposureCodeRefines1e24 ---------------------
(***************************************************************************)
(* Checked code -> intent correspondence at core pin 1e240b0f (source      *)
(* 49ad1394 has the same SDK runtime source). Code: MCExposureCode1e24Composed *)
(* (base + repaired worker runs + source-faithful end/cancel ordering).    *)
(* Intent: RecipientExposureSpec (85e0b815, unchanged), Fault = "none".   *)
(*                                                                         *)
(* History variables (read by no code action) record what the intent's    *)
(* state names but the code does not keep: the cumulative possible send  *)
(* (osent), the requested end outcome after the invocation is cleared,   *)
(* the items cancelled unsent, the latched cancels whose write is still  *)
(* unacknowledged, sent items whose cancel was written, and the intent's *)
(* per-execution ref/gd fields and ghosts. Each is a deterministic        *)
(* function of the code steps; HNext is CNext with each action tagged.   *)
(*                                                                         *)
(* Ref_Step requires every code step to be an intent step (or a stutter) *)
(* under the mapping. Ref_StepGapped allows, in addition, ONLY the named  *)
(* gaps G1-G8, each a specific code action under a stated condition. A   *)
(* gap is a recorded code/intent difference, not a defect verdict; any   *)
(* other mismatch is a finding.                                          *)
(***************************************************************************)
EXTENDS MCExposureCode1e24Composed

VARIABLES hSent, hOend, hOcanc, hPend, hReqW, hRWM, hCDE, hRef, hGd

hVars == <<hSent, hOend, hOcanc, hPend, hReqW, hRWM, hCDE, hRef, hGd>>
specH == <<hPend, hReqW, hRWM, hCDE, hRef, hGd>>
hAll == <<cVars, hVars>>

HInit ==
    /\ CInit
    /\ hSent = FALSE /\ hOend = "none" /\ hOcanc = {} /\ hPend = {} /\ hReqW = {}
    /\ hRWM = FALSE /\ hCDE = FALSE
    /\ hRef = [k \in Atts |-> [e \in Execs |-> "none"]]
    /\ hGd = [k \in Atts |-> [e \in Execs |-> FALSE]]

(* Generic histories, conjoined to every step. They read the primed      *)
(* inv, so they are conjoined AFTER the step (r3 correction: TLC assigns  *)
(* primed variables left to right; r2 put GenH first and stopped with    *)
(* "identifier inv is either undefined", exit 75).                       *)
GenH ==
    /\ hSent' = (hSent \/ inv'.sent)
    /\ hOend' = IF inv'.live /\ inv'.settle # "none" THEN inv'.settle ELSE hOend
    /\ hOcanc' = IF inv.live /\ inv'.live THEN hOcanc \cup (inv.items \ inv'.items) ELSE hOcanc

ResetRun(k, e) ==
    /\ hRef' = [hRef EXCEPT ![k][e] = "none"] /\ hGd' = [hGd EXCEPT ![k][e] = FALSE]
    /\ UNCHANGED <<hPend, hReqW, hRWM, hCDE>>
SetGd(k, e) ==
    /\ hGd' = [hGd EXCEPT ![k][e] = TRUE]
    /\ UNCHANGED <<hPend, hReqW, hRWM, hCDE, hRef>>

CancelValid(lost) ==
    /\ ~lost /\ inv.live /\ cwFl.W \subseteq Named
    /\ (IF inv.sent THEN "requested" ELSE "unsent") = cwFl.kind
Acked(lost) == IF CancelValid(lost) THEN cwFl.W \cap hPend ELSE {}

HWorker(k, e) ==
    \/ /\ Reissue(k, e) /\ UNCHANGED <<rvars, eVars>> /\ UNCHANGED specH
    \/ /\ Crash(k, e) /\ UNCHANGED <<rvars, eVars>> /\ UNCHANGED specH
    \/ /\ Guard(k, e) /\ UNCHANGED <<rvars, eVars>> /\ SetGd(k, e)
    \/ /\ \E lost \in BOOLEAN :
            /\ AdmitTxnR(k, e, lost)
            /\ LET a == StoreAdmit(k, ex[k][e].text) IN
               hRef' = IF ~lost /\ ex[k][e].ph = "await" /\ a \in {"exposed", "settled"}
                         THEN [hRef EXCEPT ![k][e] = a] ELSE hRef
       /\ UNCHANGED eVars /\ UNCHANGED <<hPend, hReqW, hRWM, hCDE, hGd>>
    \/ /\ (StartExecR(k, e) \/ RecoverExec(k, e) \/ SessionLoss(k, e)) /\ UNCHANGED eVars
       /\ ResetRun(k, e)
    \/ /\ StartBlocked(k, e) /\ UNCHANGED eVars
       /\ hRef' = [hRef EXCEPT ![k][e] = "none"] /\ hGd' = [hGd EXCEPT ![k][e] = TRUE]
       /\ UNCHANGED <<hPend, hReqW, hRWM, hCDE>>
    \/ /\ (DeliverBlocked(k, e) \/ (Poll(k, e) /\ ex[k][e].ph \in {"await", "answered"}))
       /\ UNCHANGED eVars /\ SetGd(k, e)
    \/ /\ \/ DeliverR(k, e) \/ CompleteR(k, e) \/ ActCancel(k, e) \/ Correct(k, e)
          \/ Poll(k, e) /\ ex[k][e].ph \notin {"await", "answered"}
       /\ UNCHANGED eVars /\ UNCHANGED specH

HStep ==
    \/ ((StartAttempt /\ OrchFree) \/ Done) /\ UNCHANGED <<rvars, eVars>> /\ UNCHANGED specH
    \/ ApplyX /\ UNCHANGED eVars /\ UNCHANGED specH
    \/ (EndStore \/ CancelCall) /\ UNCHANGED rvars /\ UNCHANGED specH
    \/ \E lost \in BOOLEAN : EndAnswer(lost) /\ UNCHANGED rvars /\ UNCHANGED specH
    \/ \E r \in Outs : EndDup(r) /\ UNCHANGED rvars /\ UNCHANGED specH
    \/ \E lost \in BOOLEAN :
         /\ CancelAnswer(lost) /\ UNCHANGED rvars
         /\ LET A == Acked(lost) IN
            /\ hPend' = hPend \ A
            /\ hReqW' = IF cwFl.kind = "requested" THEN hReqW \cup A ELSE hReqW
            /\ hCDE' = (hCDE \/ (A # {} /\ ost = "ending" /\ out # "none"))
            /\ hRWM' = (hRWM \/ (cwFl.kind = "unsent" /\
                                 \E i \in A : proc[i] = "cancelled" /\ marker # 0))
         /\ UNCHANGED <<hRef, hGd>>
    \/ \E k \in Atts, e \in Execs : HWorker(k, e)
    \/ \E i \in Items :
         \/ /\ Latch(i) /\ OrchFree /\ UNCHANGED <<rvars, eVars>>
            /\ hPend' = hPend \cup (inv'.creqO \ inv.creqO)
            /\ UNCHANGED <<hReqW, hRWM, hCDE, hRef, hGd>>
         \/ /\ CancelReplay(i) /\ UNCHANGED <<rvars, eVars>>
            /\ hRWM' = (hRWM \/ (proc[i] = "cancelled" /\ marker # 0))
            /\ UNCHANGED <<hPend, hReqW, hCDE, hRef, hGd>>
         \/ /\ CancelItem(i) /\ UNCHANGED rvars
            /\ LET p == i \in hPend IN
               /\ hReqW' = IF p /\ cwFl.kind = "requested" THEN hReqW \cup {i} ELSE hReqW
               /\ hRWM' = (hRWM \/ (p /\ cwFl.kind = "unsent" /\ proc[i] = "cancelled" /\ marker # 0))
               /\ hCDE' = (hCDE \/ (p /\ ost = "ending" /\ out # "none"))
            /\ UNCHANGED <<hPend, hRef, hGd>>
         \/ /\ ExternalSettle(i) /\ UNCHANGED eVars /\ UNCHANGED specH


HNext == HStep /\ GenH

HSpec == HInit /\ [][HNext]_hAll

-----------------------------------------------------------------------------
(* The refinement mapping.                                                 *)
MapPh(x) ==
    IF x.ph = "answered"
      THEN (IF x.ans = "allowed" THEN "allowed"
            ELSE IF x.ans = "fault" THEN "crashed" ELSE "refused")
    ELSE IF x.ph = "ended" THEN "guarded"
    ELSE x.ph

IEx == [k \in Atts |-> [e \in Execs |->
          [ph |-> MapPh(ex[k][e]), infl |-> ex[k][e].infl, ref |-> hRef[k][e],
           own |-> ex[k][e].own, gd |-> hGd[k][e], text |-> ex[k][e].text,
           wit |-> ex[k][e].wit]]]

IOst == IF ost = "done" THEN "ended" ELSE ost
IProto == proto \/ storeBroken \/ settledFail \/ machineErr

I == INSTANCE RecipientExposureSpec WITH
        proc <- proc, creq <- creq, out <- out, endReq <- endReq, marker <- marker,
        nAtt <- nAtt, att <- att, ex <- IEx,
        osent <- hSent, ost <- IOst, oend <- hOend, ocanc <- hOcanc, latched <- hPend,
        everLatch <- everLatch, cdone <- cdone \cup hReqW, oout <- oout,
        phys <- phys, sends <- sends, badText <- badText, afterGuard <- afterGuard,
        badSb <- badSb, badOrigin <- badOrigin, proto <- IProto, coerced <- coerced,
        replayWithMarker <- hRWM, guardPend <- guardPend, lateMarker <- lateMarker,
        cancelDuringEnd <- hCDE,
        Items <- Items, MaxAtt <- MaxAtt, MaxExec <- MaxExec, AllowAlt <- AllowAlt,
        Fault <- "none"

-----------------------------------------------------------------------------
(* Named gaps: each a code step under a stated condition.                  *)
AccW == ex[nAtt][att[nAtt].acc].wit
AccX == act[nAtt][att[nAtt].acc]

(* G1 in-activity recovery (the intent has no recovery run): a session    *)
(* loss, or a recovery run's start.                                       *)
G1 == \E k \in Atts, e \in Execs : SessionLoss(k, e) \/ RecoverExec(k, e)
(* G2 a run start that reads the activity cancelled: no admission at all  *)
(* (the intent starts an execution, then guards it).                      *)
G2 == \E k \in Atts, e \in Execs : StartBlocked(k, e)
(* G3 a guard after a refusal answer and before the omitted send (the    *)
(* intent guards only an awaiting or allowed execution).                 *)
G3 == \E k \in Atts, e \in Execs :
        /\ ex[k][e].ph = "answered" /\ ex[k][e].ans \in {"exposed", "settled"}
        /\ (Guard(k, e) \/ DeliverBlocked(k, e) \/ Poll(k, e))
(* G4 a guarded run's witness carries its refusal (the intent: unsent).  *)
G4 == \E k \in Atts, e \in Execs :
        CompleteR(k, e) /\ ex[k][e].ph = "ended" /\ act[k][e].runRef # "none"
(* G5 an unsent accepted witness applied as a retry or as ready (the      *)
(* intent: interrupted when possibly sent, else stopped or parked).      *)
G5 == ApplyX /\ AccW = "unsent" /\ ~AccX.wx /\ ost' \in {"retry", "ready"}
(* G6 the exposed (not refused) witness of a run after a recovery.      *)
G6 == ApplyX /\ AccX.wx
(* G7 a latch the code ignores (an unsent ending invocation, an item not  *)
(* in the batch, or no live invocation; the intent latches it).          *)
G7 == \E i \in Items : Latch(i) /\ inv'.creqO = inv.creqO
(* G8 one cancel answer acknowledging two or more latched items (the     *)
(* intent acknowledges one item per step).                               *)
G8 == \E lost \in BOOLEAN : CancelAnswer(lost) /\ Cardinality(Acked(lost)) >= 2

Gaps == G1 \/ G2 \/ G3 \/ G4 \/ G5 \/ G6 \/ G7 \/ G8

Ref_Init == I!Init
IVars == I!vars
Ref_Step == [][I!Next]_IVars
Ref_StepGapped == [][I!Next \/ Gaps]_IVars

(* The intent's safety on the mapped state.                               *)
RInv_TypeOK == I!TypeOK
RInv_NotDispatchedTruthful == I!Inv_NotDispatchedTruthful
RInv_ExposedImpliesMarker == I!Inv_ExposedImpliesMarker
RInv_CancelledStaysSettled == I!Inv_CancelledStaysSettled
RInv_CompletedFromOwnOrigin == I!Inv_CompletedFromOwnOrigin
RInv_NoSendAfterGuard == I!Inv_NoSendAfterGuard
RInv_OnlyOwnRetryAfterExposure == I!Inv_OnlyOwnRetryAfterExposure
RInv_SentCanonical == I!Inv_SentCanonical
RInv_NoProtocolFault == I!Inv_NoProtocolFault
RInv_CoercionOnly == I!Inv_CoercionOnly
RInv_EndAnswerIsApplied == I!Inv_EndAnswerIsApplied
RProp_MarkerInsertOnly == I!Prop_MarkerInsertOnly
RProp_OutFinal == I!Prop_OutFinal
RProp_ProcFinal == I!Prop_ProcFinal
RProp_CreqMonotone == I!Prop_CreqMonotone

=============================================================================
