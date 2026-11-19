------------------------- MODULE RecipientExposureCode -------------------------
(***************************************************************************)
(* Code-derived model of the exposure protocol at core pin c1bda7a2       *)
(* (tree 7cbd3a7c; store commit e047e769; base a9956bc2). Derived from     *)
(* the immutable source only, independently of the intent model           *)
(* RecipientExposureSpec (85e0b815, unchanged). Sources (c1bda7a2):        *)
(*  migrations/workflow-v2-0095.ts (insert-only exposure row, guard       *)
(*    trigger);                                                            *)
(*  workflow/store.ts exposeWorkflowIntake (admission), endWorkflowIntake*)
(*    (applied outcome, replay), cancelUnsentWorkflowIntake (cancelled     *)
(*    first, then exposure -> cancel_requested, exposed; final without     *)
(*    exposure is a broken invariant), lockIntakeInvocation (advisory      *)
(*    lock), transaction (READ COMMITTED);                                 *)
(*  workflow/intake-admission.ts (worker digest of the exact text,      *)
(*    in-place transient retries with the same request, typed answers);    *)
(*  managed-session.ts awaitIntakeAdmission + the send path (race with     *)
(*    guards and Stop/abort/forced settle; recheck; included(); send);     *)
(*  session-proxy.ts intakeAdmissionFor / withIntakeWitness (witness      *)
(*    sent, refused, or not sent);                                         *)
(*  orchestration_1_0_83/intake-wiring.ts beforeAttempt (one newGuid       *)
(*    attemptId per carrying attempt; sentBefore = own retry, asserted ==  *)
(*    sent), cancelInvocation, endInvocation;                              *)
(*  orchestration_1_0_83/intake-machine.ts applyIntakeAttempt (refused    *)
(*    exposed ends; refused settled is an invariant error),               *)
(*    applyIntakeEnded (only not_dispatched -> interrupted accepted),      *)
(*    applyIntakeInvocationCancelled (per-item exposed), latchCopies (no   *)
(*    latch on an unsent invocation that is ending), invocationWrite       *)
(*    (cancel write before the end).                                       *)
(*                                                                         *)
(* Abstractions and assumptions are listed in EXPOSURE-CODE-C1BDA7A2.md   *)
(* (A-MICRO, A-ACCEPT, A-END, A-NATIVE, A-LOCK, A-GUARD, A-RECOVERY,      *)
(* A-ONE, A-BATCH). Faults are deliberate source-branch removals.         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Items, MaxAtt, MaxExec, AllowAlt, Fault

ASSUME Items # {} /\ MaxAtt \in Nat \ {0} /\ MaxExec \in Nat \ {0}
ASSUME AllowAlt \in BOOLEAN
ASSUME Fault \in {"none", "no_coerce", "no_recheck", "latch_unsent_ending"}

Atts   == 1..MaxAtt
Execs  == 1..MaxExec
Outs   == {"none", "completed", "interrupted", "not_dispatched"}
Phases == {"idle", "await", "answered", "ended", "sent", "omitted", "crashed", "done"}
Answers == {"none", "allowed", "exposed", "settled", "fault"}
Wits   == {"none", "sent", "unsent", "exposed", "settled"}
NoEx   == [ph |-> "idle", infl |-> FALSE, ans |-> "none", own |-> FALSE,
           text |-> "canon", wit |-> "none"]
NoAtt  == [sb |-> FALSE, batch |-> {}, acc |-> 0, st |-> "none"]
NoInv  == [live |-> FALSE, sent |-> FALSE, items |-> {}, creqO |-> {}, cw |-> FALSE,
           settle |-> "none"]
Sat(n) == IF n >= 2 THEN 2 ELSE n

VARIABLES
    proc, creq, out, endReq, marker,     \* store (0094 rows, 0095 exposure)
    inv,       \* orchestration: the invocation (live, sent, batch, latched flags, cancel write pending, settle)
    ost,       \* orchestration: "ready", "carrying", "retry", "parked", "ending", "done", "failed"
    oout,      \* orchestration: the applied outcome its end received
    nAtt, att, ex,
    everLatch, cdone,
    phys, sends, badText, afterGuard, badSb, badOrigin, proto, coerced,
    storeBroken, settledFail, assertFail, guardPend, lateMarker, cancelExposed,
    latchWhileEnding

storeVars == <<proc, creq, out, endReq, marker>>
orchVars  == <<inv, ost, oout, everLatch, cdone>>
attVars   == <<nAtt, att, ex>>
ghostVars == <<phys, sends, badText, afterGuard, badSb, badOrigin, proto, coerced,
               storeBroken, settledFail, assertFail, guardPend, lateMarker, cancelExposed,
               latchWhileEnding>>
vars == <<storeVars, orchVars, attVars, ghostVars>>

TypeOK ==
    /\ proc \in [Items -> {"bound", "cancelled", "final"}]
    /\ creq \in [Items -> BOOLEAN]
    /\ out \in Outs /\ endReq \in Outs /\ oout \in Outs /\ marker \in 0..MaxAtt
    /\ inv \in [live : BOOLEAN, sent : BOOLEAN, items : SUBSET Items, creqO : SUBSET Items,
                cw : BOOLEAN, settle : Outs]
    /\ ost \in {"ready", "carrying", "retry", "parked", "ending", "done", "failed"}
    /\ nAtt \in 0..MaxAtt
    /\ att \in [Atts -> [sb : BOOLEAN, batch : SUBSET Items, acc : 0..MaxExec,
                         st : {"none", "run", "acc", "applied"}]]
    /\ ex \in [Atts -> [Execs -> [ph : Phases, infl : BOOLEAN, ans : Answers, own : BOOLEAN,
                                  text : {"canon", "alt"}, wit : Wits]]]
    /\ everLatch \subseteq Items /\ cdone \subseteq Items
    /\ phys \subseteq Items /\ sends \in 0..2
    /\ guardPend \subseteq (Atts \X Execs)

Init ==
    /\ proc = [i \in Items |-> "bound"] /\ creq = [i \in Items |-> FALSE]
    /\ out = "none" /\ endReq = "none" /\ marker = 0
    /\ inv = [NoInv EXCEPT !.live = TRUE, !.items = Items]
    /\ ost = "ready" /\ oout = "none"
    /\ nAtt = 0 /\ att = [k \in Atts |-> NoAtt] /\ ex = [k \in Atts |-> [e \in Execs |-> NoEx]]
    /\ everLatch = {} /\ cdone = {}
    /\ phys = {} /\ sends = 0
    /\ badText = FALSE /\ afterGuard = FALSE /\ badSb = FALSE /\ badOrigin = FALSE
    /\ proto = FALSE /\ coerced = FALSE /\ storeBroken = FALSE /\ settledFail = FALSE
    /\ assertFail = FALSE /\ guardPend = {} /\ lateMarker = FALSE /\ cancelExposed = FALSE
    /\ latchWhileEnding = FALSE

-----------------------------------------------------------------------------
(* Store: exposeWorkflowIntake (one READ COMMITTED transaction under the  *)
(* invocation's advisory lock). Cancelled-unsent members are set aside;   *)
(* a named cancelled one or any other non-bound member: settled; then the *)
(* named items must be exactly the active members and each text digest    *)
(* the stored one, else a broken invariant ("fault"); then the exposure   *)
(* row: insert, same attempt, own retry (sentBefore), or exposed.         *)
StoreAdmit(k, t) ==
    LET req    == att[k].batch
        active == {i \in Items : proc[i] # "cancelled"}
    IN IF (\E i \in req : proc[i] = "cancelled") \/ (\E i \in active : proc[i] # "bound")
         THEN "settled"
       ELSE IF req # active \/ t = "alt" THEN "fault"
       ELSE IF marker = 0 \/ marker = k \/ att[k].sb THEN "allowed"
       ELSE "exposed"

(* Store: cancelUnsentWorkflowIntake for item i (per item, own transaction). *)
UnsentAnswer(i) ==
    IF proc[i] = "cancelled" THEN "settled"
    ELSE IF marker # 0 THEN "exposed"
    ELSE IF proc[i] = "final" THEN "broken"
    ELSE "cancelled"

-----------------------------------------------------------------------------
(* Orchestration: a carrying attempt (beforeAttempt): an unsent invocation *)
(* with a latched cancel is not carried; a sent one only by its own retry; *)
(* one recorded attemptId (k); sentBefore = own retry, asserted == sent.  *)
StartAttempt ==
    /\ ost \in {"ready", "retry", "parked"} /\ nAtt < MaxAtt
    /\ inv.live /\ inv.settle = "none" /\ inv.items # {}
    /\ ~inv.sent => inv.creqO \cap inv.items = {}
    /\ inv.sent => ost = "retry"
    /\ LET k == nAtt + 1
           sb == (ost = "retry")
       IN /\ att' = [att EXCEPT ![k] = [sb |-> sb, batch |-> inv.items, acc |-> 0, st |-> "run"]]
          /\ nAtt' = k
          /\ assertFail' = (assertFail \/ sb # inv.sent)
    /\ ost' = "carrying"
    /\ UNCHANGED <<storeVars, inv, oout, everLatch, cdone, ex, phys, sends, badText, afterGuard,
                   badSb, badOrigin, proto, coerced, storeBroken, settledFail, guardPend,
                   lateMarker, cancelExposed, latchWhileEnding>>

(* Worker: an execution of attempt k (delivery, redelivery or duplicate,  *)
(* all with the scheduled input's attemptId, A-NATIVE). It asks for       *)
(* admission with the digest of the exact text it would compose.          *)
StartExec(k, e) ==
    /\ k <= nAtt /\ att[k].st = "run"
    /\ ex[k][e].ph = "idle"
    /\ IF e = 1 THEN TRUE ELSE ex[k][e - 1].ph # "idle"
    /\ \E t \in (IF AllowAlt THEN {"canon", "alt"} ELSE {"canon"}) :
         ex' = [ex EXCEPT ![k][e] = [NoEx EXCEPT !.ph = "await", !.infl = TRUE, !.text = t]]
    /\ UNCHANGED <<storeVars, orchVars, nAtt, att, ghostVars>>

(* The admission transaction commits; its answer travels back, or is lost *)
(* (a transient failure: admitWorkflowIntake asks again, same request).   *)
AdmitTxn(k, e, lost) ==
    /\ ex[k][e].infl
    /\ LET a == StoreAdmit(k, ex[k][e].text)
           x == ex[k][e]
       IN /\ marker' = IF a = "allowed" /\ marker = 0 THEN k ELSE marker
          /\ lateMarker' = (lateMarker \/ (<<k, e>> \in guardPend /\ a = "allowed" /\ marker = 0))
          /\ ex' = [ex EXCEPT ![k][e] =
                      IF lost THEN [x EXCEPT !.infl = FALSE]
                      ELSE IF x.ph = "await" THEN [x EXCEPT !.infl = FALSE, !.ph = "answered", !.ans = a]
                      ELSE [x EXCEPT !.infl = FALSE, !.ans = a]]
    /\ UNCHANGED <<proc, creq, out, endReq, orchVars, nAtt, att, phys, sends, badText,
                   afterGuard, badSb, badOrigin, proto, coerced, storeBroken, settledFail,
                   assertFail, guardPend, cancelExposed, latchWhileEnding>>

Reissue(k, e) ==
    /\ ex[k][e].ph = "await" /\ ~ex[k][e].infl
    /\ ex' = [ex EXCEPT ![k][e].infl = TRUE]
    /\ UNCHANGED <<storeVars, orchVars, nAtt, att, ghostVars>>

(* The run ends before its send: Stop, abort (activity cancellation),     *)
(* forced settle, turn timeout, inactivity watchdog, or the in-place      *)
(* retries exhausted (A-GUARD). A committed answer still in flight is     *)
(* ignored when it arrives.                                               *)
Guard(k, e) ==
    /\ ex[k][e].ph \in {"await", "answered"}
    /\ ex' = [ex EXCEPT ![k][e].ph = "ended"]
    /\ guardPend' = IF ex[k][e].infl THEN guardPend \cup {<<k, e>>} ELSE guardPend
    /\ UNCHANGED <<storeVars, orchVars, nAtt, att, phys, sends, badText, afterGuard, badSb,
                   badOrigin, proto, coerced, storeBroken, settledFail, assertFail, lateMarker,
                   cancelExposed, latchWhileEnding>>

(* The answer reaches the run. The race resolution, the recheck, included()*)
(* and the send are one microtask chain (A-MICRO): include -> the composed *)
(* prompt is sent; refused -> the prompt without the items; a broken       *)
(* invariant -> a non-retryable error, nothing sent. Fault no_recheck: an  *)
(* answer that arrives after the run ended still sends.                   *)
Deliver(k, e) ==
    /\ \/ ex[k][e].ph = "answered"
       \/ Fault = "no_recheck" /\ ex[k][e].ph = "ended" /\ ex[k][e].ans = "allowed"
    /\ LET x == ex[k][e] IN
       IF x.ans = "allowed"
         THEN /\ ex' = [ex EXCEPT ![k][e].ph = "sent", ![k][e].own = TRUE]
              /\ phys' = phys \cup att[k].batch
              /\ sends' = Sat(sends + 1)
              /\ badText' = (badText \/ x.text = "alt")
              /\ afterGuard' = (afterGuard \/ x.ph = "ended")
              /\ badSb' = (badSb \/ (marker # 0 /\ marker # k /\ ~att[k].sb))
              /\ UNCHANGED proto
       ELSE IF x.ans = "fault"
         THEN /\ ex' = [ex EXCEPT ![k][e].ph = "ended"]
              /\ proto' = TRUE
              /\ UNCHANGED <<phys, sends, badText, afterGuard, badSb>>
       ELSE /\ ex' = [ex EXCEPT ![k][e].ph = "omitted"]
            /\ UNCHANGED <<phys, sends, badText, afterGuard, badSb, proto>>
    /\ UNCHANGED <<storeVars, orchVars, nAtt, att, badOrigin, coerced, storeBroken, settledFail,
                   assertFail, guardPend, lateMarker, cancelExposed, latchWhileEnding>>

Crash(k, e) ==
    /\ ex[k][e].ph \in {"await", "answered", "ended", "sent", "omitted"}
    /\ ex' = [ex EXCEPT ![k][e].ph = "crashed"]
    /\ UNCHANGED <<storeVars, orchVars, nAtt, att, ghostVars>>

(* withIntakeWitness: sent if included() ran, refused with its reason,    *)
(* else not sent. The first completion of the attempt is accepted         *)
(* (A-ACCEPT).                                                             *)
Complete(k, e) ==
    /\ ex[k][e].ph \in {"sent", "omitted", "ended"}
    /\ LET w == IF ex[k][e].ph = "sent" THEN "sent"
                ELSE IF ex[k][e].ph = "omitted" THEN ex[k][e].ans
                ELSE "unsent"
       IN /\ ex' = [ex EXCEPT ![k][e].ph = "done", ![k][e].wit = w]
          /\ att' = IF att[k].st = "run" THEN [att EXCEPT ![k].acc = e, ![k].st = "acc"] ELSE att
    /\ UNCHANGED <<storeVars, orchVars, nAtt, ghostVars>>

(* applyIntakeAttempt on the accepted witness (attemptStep, refused).     *)
Apply ==
    /\ ost = "carrying" /\ nAtt > 0 /\ att[nAtt].st = "acc"
    /\ LET k == nAtt
           w == ex[k][att[k].acc].wit
       IN /\ att' = [att EXCEPT ![k].st = "applied"]
          /\ IF w = "settled"
               THEN /\ ost' = "failed" /\ settledFail' = TRUE
                    /\ UNCHANGED inv
             ELSE IF w = "exposed"
               THEN /\ inv' = [inv EXCEPT !.sent = TRUE, !.settle = "interrupted"]
                    /\ ost' = "ending"
                    /\ UNCHANGED settledFail
             ELSE IF w = "sent"
               THEN /\ \E ev \in {"result", "retry", "stopped"} :
                         /\ ev = "retry" => nAtt < MaxAtt
                         /\ inv' = [inv EXCEPT !.sent = TRUE,
                                     !.settle = IF ev = "result" THEN "completed"
                                                ELSE IF ev = "stopped" THEN "interrupted" ELSE "none"]
                         /\ ost' = IF ev = "retry" THEN "retry" ELSE "ending"
                    /\ UNCHANGED settledFail
             ELSE IF inv.sent
               THEN /\ \E ev \in {"retry", "end"} :
                         /\ ev = "retry" => nAtt < MaxAtt
                         /\ inv' = IF ev = "retry" THEN inv ELSE [inv EXCEPT !.settle = "interrupted"]
                         /\ ost' = IF ev = "retry" THEN "retry" ELSE "ending"
                    /\ UNCHANGED settledFail
             ELSE /\ \E ev \in {"ready", "stopped", "park"} :
                         /\ inv' = IF ev = "stopped" THEN [inv EXCEPT !.settle = "not_dispatched"] ELSE inv
                         /\ ost' = IF ev = "stopped" THEN "ending"
                                   ELSE IF ev = "park" THEN "parked" ELSE "ready"
                  /\ UNCHANGED settledFail
          /\ badOrigin' = (badOrigin \/ (inv'.settle = "completed" /\ w # "sent"))
    /\ UNCHANGED <<storeVars, oout, everLatch, cdone, nAtt, ex, phys, sends, badText, afterGuard,
                   badSb, proto, coerced, storeBroken, assertFail, guardPend, lateMarker,
                   cancelExposed, latchWhileEnding>>

-----------------------------------------------------------------------------
(* latchCopies: a tombstone latches an invocation item, except on an      *)
(* unsent invocation that is ending (never dispatched; the tombstone      *)
(* changes nothing). Drain runs between activities (not while carrying).  *)
Latch(i) ==
    /\ i \notin everLatch /\ ost # "carrying" /\ ost # "failed"
    /\ everLatch' = everLatch \cup {i}
    /\ LET may == inv.live /\ i \in inv.items /\ i \notin inv.creqO
                  /\ (Fault = "latch_unsent_ending" \/ ~(~inv.sent /\ inv.settle # "none"))
       IN /\ inv' = IF may THEN [inv EXCEPT !.creqO = @ \cup {i}, !.cw = TRUE] ELSE inv
          /\ latchWhileEnding' = (latchWhileEnding \/ (may /\ ost = "ending"))
    /\ UNCHANGED <<storeVars, ost, oout, cdone, attVars, phys, sends, badText, afterGuard, badSb,
                   badOrigin, proto, coerced, storeBroken, settledFail, assertFail, guardPend,
                   lateMarker, cancelExposed>>

(* cancelInvocation (the wake; the cancel write precedes the end): sent ->*)
(* request_cancel; unsent -> cancel_unsent per item. Its answer may be    *)
(* lost (the write is made again).                                        *)
CancelWrite(lost) ==
    /\ inv.live /\ inv.cw /\ ost \notin {"carrying", "failed"}
    /\ LET W == inv.creqO
           A == [i \in W |-> UnsentAnswer(i)]
           E == {i \in W : A[i] = "exposed"}
       IN /\ cdone' = cdone \cup W
          /\ IF inv.sent
               THEN /\ creq' = [i \in Items |-> IF i \in W THEN TRUE ELSE creq[i]]
                    /\ UNCHANGED <<proc, storeBroken, cancelExposed>>
                    /\ inv' = IF lost THEN inv ELSE [inv EXCEPT !.cw = FALSE]
                    /\ UNCHANGED ost
               ELSE /\ proc' = [i \in Items |-> IF i \in W /\ A[i] = "cancelled" THEN "cancelled" ELSE proc[i]]
                    /\ creq' = [i \in Items |-> IF i \in E THEN TRUE ELSE creq[i]]
                    /\ storeBroken' = (storeBroken \/ \E i \in W : A[i] = "broken")
                    /\ IF lost
                         THEN UNCHANGED <<inv, ost, cancelExposed>>
                         ELSE IF E # {}
                           THEN /\ inv' = [inv EXCEPT !.sent = TRUE, !.items = (inv.items \ W) \cup E,
                                                      !.cw = FALSE, !.settle = "interrupted"]
                                /\ ost' = "ending"
                                /\ cancelExposed' = TRUE
                         ELSE LET rest == inv.items \ W IN
                              /\ inv' = [inv EXCEPT !.items = rest, !.cw = FALSE,
                                                    !.settle = IF rest = {} THEN "not_dispatched" ELSE inv.settle]
                              /\ ost' = IF rest = {} THEN "ending" ELSE ost
                              /\ UNCHANGED cancelExposed
    /\ UNCHANGED <<out, endReq, marker, oout, everLatch, attVars, phys, sends, badText, afterGuard,
                   badSb, badOrigin, proto, coerced, settledFail, assertFail, guardPend,
                   lateMarker, latchWhileEnding>>

(* A delayed duplicate execution of an earlier unsent cancel (its answer  *)
(* goes nowhere). A broken-invariant throw there is not counted.          *)
CancelReplay(i) ==
    /\ i \in cdone
    /\ LET a == UnsentAnswer(i) IN
       /\ proc' = IF a = "cancelled" THEN [proc EXCEPT ![i] = "cancelled"] ELSE proc
       /\ creq' = IF a = "exposed" THEN [creq EXCEPT ![i] = TRUE] ELSE creq
    /\ UNCHANGED <<out, endReq, marker, orchVars, attVars, ghostVars>>

(* endInvocation (after the cancel write): the store applies the outcome, *)
(* coercing not_dispatched -> interrupted beside an exposure; a replay    *)
(* checks the call and answers the applied outcome. The answer may be    *)
(* lost (A-END). applyIntakeEnded: only that coercion is accepted; the   *)
(* invocation is cleared, or kept for a cancel write latched meanwhile.  *)
EndCall(lost) ==
    /\ ost = "ending" /\ ~inv.cw
    /\ LET req     == inv.settle
           applied == IF out # "none" THEN out
                      ELSE IF req = "not_dispatched" /\ marker # 0 /\ Fault # "no_coerce"
                             THEN "interrupted" ELSE req
       IN /\ IF out = "none"
               THEN /\ out' = applied /\ endReq' = req
                    /\ proc' = [i \in Items |-> IF i \in inv.items /\ proc[i] = "bound" THEN "final" ELSE proc[i]]
                    /\ storeBroken' = (storeBroken \/ (marker # 0 /\ inv.items = {}))
                    /\ coerced' = (coerced \/ applied # req)
               ELSE /\ storeBroken' = (storeBroken \/ req # endReq)
                    /\ UNCHANGED <<out, endReq, proc, coerced>>
          /\ IF lost
               THEN UNCHANGED <<inv, ost, oout>>
               ELSE /\ oout' = applied
                    /\ inv' = NoInv
                    /\ ost' = "done"
    /\ UNCHANGED <<creq, marker, everLatch, cdone, attVars, phys, sends, badText, afterGuard,
                   badSb, badOrigin, proto, settledFail, assertFail, guardPend, lateMarker,
                   cancelExposed, latchWhileEnding>>

Done == ost # "ending" /\ UNCHANGED vars

Next ==
    \/ StartAttempt \/ Apply \/ Done
    \/ \E lost \in BOOLEAN : EndCall(lost) \/ CancelWrite(lost)
    \/ \E k \in Atts, e \in Execs :
          \/ StartExec(k, e) \/ Reissue(k, e) \/ Guard(k, e) \/ Deliver(k, e)
          \/ Crash(k, e) \/ Complete(k, e)
          \/ \E lost \in BOOLEAN : AdmitTxn(k, e, lost)
    \/ \E i \in Items : Latch(i) \/ CancelReplay(i)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Code-level safety.                                                      *)
Inv_C_NotDispatchedTruthful == out = "not_dispatched" => phys = {}
Inv_C_ExposedImpliesMarker == phys # {} => marker # 0
Inv_C_CancelledStaysSettled == \A i \in Items : proc[i] = "cancelled" => (i \notin phys /\ ~creq[i])
Inv_C_NoSendAfterRunEnded == ~afterGuard
Inv_C_OnlyOwnRetryAfterExposure == ~badSb
Inv_C_SentCanonical == ~badText
Inv_C_CompletedFromOwnOrigin == ~badOrigin
Inv_C_NoProtocolFault == ~proto
Inv_C_NoStoreBroken == ~storeBroken
Inv_C_NoSettledRefusalAccepted == ~settledFail
Inv_C_SentBeforeIffSent == ~assertFail
Inv_C_CoercionOnly == (out # "none" /\ out # endReq) => (endReq = "not_dispatched" /\ out = "interrupted")
Inv_C_EndAnswerIsApplied == ost = "done" => oout = out

Prop_C_MarkerInsertOnly == [][marker # 0 => marker' = marker]_vars
Prop_C_OutFinal == [][out # "none" => out' = out]_vars
Prop_C_ProcFinal == [][\A i \in Items : proc[i] # "bound" => proc'[i] = proc[i]]_vars
Prop_C_CreqMonotone == [][\A i \in Items : creq[i] => creq'[i]]_vars

-----------------------------------------------------------------------------
(* Witnesses, EXPECTED to be violated (reachable).                        *)
Wit_C_LateCommitCoerced == ~(lateMarker /\ phys = {} /\ coerced /\ out = "interrupted")
Wit_C_DuplicateSends == sends < 2
Wit_C_RefusedExposed == ~(\E k \in Atts, e \in Execs : ex[k][e].wit = "exposed")
Wit_C_CancelExposed == ~(cancelExposed /\ ost = "done" /\ out = "interrupted")
Wit_C_SentLateCancel == ~(latchWhileEnding /\ ost = "done" /\ \E i \in Items : creq[i])

=============================================================================
