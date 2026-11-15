------------------------- MODULE RecipientExposureSpec -------------------------
(***************************************************************************)
(* Spec-first extension of the recipient intake intent: durable pre-send *)
(* exposure (protocol revision 2). Derived ONLY from the settled semantic  *)
(* contract, not from code:                                                *)
(*  - the intake exposure plan, revision r2;                              *)
(*  - the review agreement on r2, with its three binding clarifications;  *)
(*  - the design decision on the r2 implementation.                       *)
(* No implementation exists; a code-derived variant waits for a core pin. *)
(* RecipientTurnSpec (r1), R2 and the accepted RecipientTurnSpecG are not *)
(* changed; this module refines the meaning of SpecG's three-valued       *)
(* witness for one invocation (see EXPOSURE-SPEC.md).                     *)
(*                                                                         *)
(* One invocation of the items Items, carried by at most MaxAtt carrying  *)
(* activities (attempts, each with one recorded attemptId). Each attempt  *)
(* may run in up to MaxExec executions (native redelivery after a lost    *)
(* completion, or a duplicate execution); every execution of an attempt   *)
(* uses the same attemptId. Store transactions (admission, end, cancel)   *)
(* are atomic steps under the invocation lock (READ COMMITTED, lock order *)
(* unchanged).                                                             *)
(*                                                                         *)
(* Clarifications encoded:                                                  *)
(*  C1 the already-cancelled-unsent subset is excluded before the active   *)
(*     batch is validated, and a replayed cancel of such an item answers   *)
(*     "settled" BEFORE the marker is inspected;                          *)
(*  C2 a real Stop/cancellation/timeout guard races the awaited admission *)
(*     and is checked again before the send: after a guard, no send;      *)
(*  C3 the worker's digest of the exact text it composes is compared by    *)
(*     the store with its own canonical text hash (never with another     *)
(*     caller-supplied hash).                                             *)
(* Not modelled: a read on each negative result, a lineage table, a       *)
(* delivery-count API (all out of scope by decision); transport; the      *)
(* turn's own model events.                                               *)
(* Assumed canonical, NOT validated by this model: the batch's order, its *)
(* member claims and the recipient identity (att.batch is a set of items);*)
(* the text value "alt" stands only for a digest mismatch (C3), not for   *)
(* the hash function or the composed prompt.                              *)
(* Amendment a1 (parent review of 67ab1bbe): causal guard/late-commit     *)
(* ghosts; cancel acknowledgement order of plan 6; the end call split     *)
(* into the store transaction and the application of its (possibly lost) *)
(* answer, with the original call identity and the applied outcome.      *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Items, MaxAtt, MaxExec, AllowAlt, Fault

ASSUME Items # {} /\ MaxAtt \in Nat \ {0} /\ MaxExec \in Nat \ {0}
ASSUME AllowAlt \in BOOLEAN
ASSUME Fault \in {"none", "no_coerce", "no_recheck", "sb_any", "no_exclude",
                  "replay_marker", "caller_hashes", "origin_any", "send_unadmitted"}

Atts   == 1..MaxAtt
Execs  == 1..MaxExec
Outs   == {"none", "completed", "interrupted", "not_dispatched"}
Phases == {"idle", "await", "allowed", "refused", "guarded", "sent", "omitted",
           "crashed", "done"}
Wits   == {"none", "sent", "unsent", "exposed", "settled"}
NoEx   == [ph |-> "idle", infl |-> FALSE, ref |-> "none", own |-> FALSE,
           gd |-> FALSE, text |-> "canon", wit |-> "none"]
NoAtt  == [sb |-> FALSE, batch |-> {}, acc |-> 0, st |-> "none"]
Sat(n) == IF n >= 2 THEN 2 ELSE n

VARIABLES
    proc,      \* store: each member row "bound", "cancelled" (not_dispatched, reason cancelled) or "final"
    creq,      \* store: cancel_requested per item (monotone)
    out,       \* store: the applied end outcome ("none" while not ended)
    endReq,    \* store: the outcome the first end call requested (its identity for replays)
    marker,    \* store: the exposure row's attemptId (0: none); insert-only
    nAtt,      \* attempts (carrying activities) started
    att,       \* per attempt: sentBefore, requested batch, accepted execution, state
    ex,        \* per attempt and execution: the worker's state
    osent,     \* orchestration: cumulative sent (possibly sent)
    ost,       \* orchestration: "ready", "carrying", "retry", "parked", "ending", "ended", "failed"
    oend,      \* orchestration: the end outcome it requests
    ocanc,     \* orchestration: items whose unsent cancel it applied
    latched,   \* orchestration: latched cancels whose write is pending
    everLatch, \* items ever latched (a tombstone latches once)
    cdone,     \* items whose cancel write committed at least once (zombie replays allowed)
    oout,      \* orchestration: the applied outcome its end call received ("none" until then)
    phys,      \* ghost: items whose text reached a model request
    sends,     \* ghost: physical sends (saturating)
    badText, afterGuard, badSb, badOrigin, proto, coerced, replayWithMarker,
    guardPend, \* ghost: executions whose guard fired while their admission call was in flight
    lateMarker, \* ghost: such an in-flight admission committed AFTER the guard and inserted the marker
    cancelDuringEnd \* ghost: a cancel was written after the end committed and before its answer was applied

storeVars == <<proc, creq, out, endReq, marker>>
attVars   == <<nAtt, att, ex>>
orchVars  == <<osent, ost, oend, ocanc, latched, everLatch, cdone, oout>>
ghostVars == <<phys, sends, badText, afterGuard, badSb, badOrigin, proto, coerced,
               replayWithMarker, guardPend, lateMarker, cancelDuringEnd>>
vars      == <<storeVars, attVars, orchVars, ghostVars>>

TypeOK ==
    /\ proc \in [Items -> {"bound", "cancelled", "final"}]
    /\ creq \in [Items -> BOOLEAN]
    /\ out \in Outs /\ endReq \in Outs /\ oout \in Outs
    /\ marker \in 0..MaxAtt /\ nAtt \in 0..MaxAtt
    /\ att \in [Atts -> [sb : BOOLEAN, batch : SUBSET Items, acc : 0..MaxExec,
                         st : {"none", "run", "acc", "applied"}]]
    /\ ex \in [Atts -> [Execs -> [ph : Phases, infl : BOOLEAN,
                                  ref : {"none", "exposed", "settled"},
                                  own : BOOLEAN, gd : BOOLEAN,
                                  text : {"canon", "alt"}, wit : Wits]]]
    /\ osent \in BOOLEAN
    /\ ost \in {"ready", "carrying", "retry", "parked", "ending", "ended", "failed"}
    /\ oend \in Outs
    /\ ocanc \subseteq Items /\ latched \subseteq Items
    /\ everLatch \subseteq Items /\ cdone \subseteq Items
    /\ phys \subseteq Items /\ sends \in 0..2
    /\ guardPend \subseteq (Atts \X Execs) /\ lateMarker \in BOOLEAN
    /\ cancelDuringEnd \in BOOLEAN

Init ==
    /\ proc = [i \in Items |-> "bound"] /\ creq = [i \in Items |-> FALSE]
    /\ out = "none" /\ endReq = "none" /\ oout = "none" /\ marker = 0
    /\ nAtt = 0 /\ att = [k \in Atts |-> NoAtt]
    /\ ex = [k \in Atts |-> [e \in Execs |-> NoEx]]
    /\ osent = FALSE /\ ost = "ready" /\ oend = "none"
    /\ ocanc = {} /\ latched = {} /\ everLatch = {} /\ cdone = {}
    /\ phys = {} /\ sends = 0
    /\ badText = FALSE /\ afterGuard = FALSE /\ badSb = FALSE /\ badOrigin = FALSE
    /\ proto = FALSE /\ coerced = FALSE /\ replayWithMarker = FALSE
    /\ guardPend = {} /\ lateMarker = FALSE /\ cancelDuringEnd = FALSE

Active == {i \in Items : proc[i] = "bound"}

-----------------------------------------------------------------------------
(* Admission (plan 3, review 1): the answer under the invocation lock.    *)
(* "settled": the invocation ended or a requested item is no longer bound *)
(* (C1: the cancelled subset is not part of the active batch);            *)
(* "fault": a shape, membership or text mismatch (visible protocol fault);*)
(* "allowed" / "exposed" by the marker table.                              *)
AdmitAnswer(k, t) ==
    LET req == att[k].batch
        mem == IF Fault = "no_exclude" THEN {i \in Items : proc[i] # "final"}
               ELSE Active
    IN IF out # "none" \/ (\E i \in req : proc[i] # "bound") THEN "settled"
       ELSE IF req # mem THEN "fault"
       ELSE IF t = "alt" /\ Fault # "caller_hashes" THEN "fault"     \* C3
       ELSE IF marker = 0 \/ marker = k THEN "allowed"
       ELSE IF att[k].sb \/ Fault = "sb_any" THEN "allowed"
       ELSE "exposed"

(* A carrying activity starts: one recorded attemptId; sentBefore only    *)
(* when this is the own retry of a sent invocation. An unsent invocation  *)
(* with a latched cancel is not carried.                                  *)
StartAttempt ==
    /\ ost \in {"ready", "retry", "parked"} /\ nAtt < MaxAtt
    /\ ~osent => latched = {}
    /\ Items \ ocanc # {}
    /\ LET k == nAtt + 1 IN
       /\ att' = [att EXCEPT ![k] = [sb |-> (ost = "retry" /\ osent),
                                     batch |-> Items \ ocanc, acc |-> 0, st |-> "run"]]
       /\ nAtt' = k
    /\ ost' = "carrying"
    /\ UNCHANGED <<storeVars, ex, osent, oend, ocanc, latched, everLatch, cdone, oout,
                   ghostVars>>

(* An execution of attempt k: the first delivery, a redelivery after a    *)
(* lost completion, or a duplicate. Same attemptId. It issues admission.  *)
StartExec(k, e) ==
    /\ k <= nAtt /\ att[k].st = "run"
    /\ ex[k][e].ph = "idle"
    \* r1 correction: TLC explores each disjunct of an action-level \/ as its
    \* own branch (no short-circuit), so ex[k][0] was evaluated; an IF keeps
    \* the same meaning without the out-of-domain access.
    /\ IF e = 1 THEN TRUE ELSE ex[k][e - 1].ph # "idle"
    /\ \E t \in (IF AllowAlt THEN {"canon", "alt"} ELSE {"canon"}) :
         ex' = [ex EXCEPT ![k][e] = [NoEx EXCEPT !.ph = "await", !.infl = TRUE,
                                                !.text = t]]
    /\ UNCHANGED <<storeVars, nAtt, att, orchVars, ghostVars>>

(* The admission transaction commits; its answer may be lost. A guarded   *)
(* or crashed caller ignores the answer (the commit is still durable).    *)
AdmitTxn(k, e, lost) ==
    /\ ex[k][e].infl
    /\ LET a == AdmitAnswer(k, ex[k][e].text)
           x == ex[k][e]
       IN /\ marker' = IF a = "allowed" /\ marker = 0 THEN k ELSE marker
          /\ proto' = (proto \/ a = "fault")
          /\ lateMarker' = (lateMarker \/ (<<k, e>> \in guardPend /\ a = "allowed" /\ marker = 0))
          /\ ex' = [ex EXCEPT ![k][e] =
                      IF lost \/ x.ph # "await" THEN [x EXCEPT !.infl = FALSE]
                      ELSE IF a = "allowed" THEN [x EXCEPT !.infl = FALSE, !.ph = "allowed"]
                      ELSE IF a = "fault" THEN [x EXCEPT !.infl = FALSE, !.ph = "crashed"]
                      ELSE [x EXCEPT !.infl = FALSE, !.ph = "refused", !.ref = a]]
    /\ UNCHANGED <<proc, creq, out, endReq, nAtt, att, orchVars, phys, sends, badText,
                   afterGuard, badSb, badOrigin, coerced, replayWithMarker, guardPend,
                   cancelDuringEnd>>

(* A lost answer: reconfirm with the same attemptId; nothing is sent until *)
(* a positive answer arrives.                                             *)
Reissue(k, e) ==
    /\ ex[k][e].ph = "await" /\ ~ex[k][e].infl
    /\ ex' = [ex EXCEPT ![k][e].infl = TRUE]
    /\ UNCHANGED <<storeVars, nAtt, att, orchVars, ghostVars>>

(* C2: Stop, activity cancellation, the turn timeout or the inactivity    *)
(* watchdog fires while admission is awaited, or before the send.         *)
Guard(k, e) ==
    /\ ex[k][e].ph \in {"await", "allowed"} /\ ~ex[k][e].gd
    /\ ex' = [ex EXCEPT ![k][e].gd = TRUE,
                        ![k][e].ph = IF ex[k][e].ph = "await" \/ Fault # "no_recheck"
                                       THEN "guarded" ELSE ex[k][e].ph]
    /\ guardPend' = IF ex[k][e].infl THEN guardPend \cup {<<k, e>>} ELSE guardPend
    /\ UNCHANGED <<storeVars, nAtt, att, orchVars, phys, sends, badText, afterGuard, badSb,
                   badOrigin, proto, coerced, replayWithMarker, lateMarker, cancelDuringEnd>>

(* The composed prompt (items included) is sent: onIntakeIncluded sets the *)
(* run's own sent here. Fault send_unadmitted: send before the answer.    *)
Send(k, e) ==
    /\ \/ ex[k][e].ph = "allowed"
       \/ Fault = "send_unadmitted" /\ ex[k][e].ph = "await"
    /\ ex' = [ex EXCEPT ![k][e].ph = "sent", ![k][e].own = TRUE]
    /\ phys' = phys \cup att[k].batch
    /\ sends' = Sat(sends + 1)
    /\ badText' = (badText \/ ex[k][e].text = "alt")
    /\ afterGuard' = (afterGuard \/ ex[k][e].gd)
    /\ badSb' = (badSb \/ (marker # 0 /\ marker # k /\ ~att[k].sb))
    /\ UNCHANGED <<storeVars, nAtt, att, orchVars, badOrigin, proto, coerced,
                   replayWithMarker, guardPend, lateMarker, cancelDuringEnd>>

(* A refused execution sends the prompt without the intake items.         *)
Omit(k, e) ==
    /\ ex[k][e].ph = "refused"
    /\ ex' = [ex EXCEPT ![k][e].ph = "omitted"]
    /\ UNCHANGED <<storeVars, nAtt, att, orchVars, ghostVars>>

(* A worker crash or a lost completion: this execution never completes.   *)
Crash(k, e) ==
    /\ ex[k][e].ph \in {"await", "allowed", "refused", "guarded", "sent", "omitted"}
    /\ ex' = [ex EXCEPT ![k][e].ph = "crashed"]
    /\ UNCHANGED <<storeVars, nAtt, att, orchVars, ghostVars>>

(* An execution completes with its own witness. The first completion of   *)
(* the attempt is the accepted one (result origin); later ones are        *)
(* discarded.                                                             *)
Complete(k, e) ==
    /\ ex[k][e].ph \in {"sent", "omitted", "guarded"}
    /\ LET w == IF ex[k][e].ph = "sent" THEN "sent"
                ELSE IF ex[k][e].ph = "guarded" THEN "unsent"
                ELSE ex[k][e].ref
           first == att[k].st = "run"
       IN /\ ex' = [ex EXCEPT ![k][e].ph = "done", ![k][e].wit = w]
          /\ att' = IF first THEN [att EXCEPT ![k].acc = e, ![k].st = "acc"] ELSE att
    /\ UNCHANGED <<storeVars, nAtt, orchVars, ghostVars>>

-----------------------------------------------------------------------------
(* The orchestration applies the accepted result of its current attempt.  *)
AcceptedWit(k) ==
    IF Fault = "origin_any" /\ (\E e \in Execs : ex[k][e].own)
      THEN "sent" ELSE ex[k][att[k].acc].wit

Apply ==
    /\ ost = "carrying" /\ nAtt > 0 /\ att[nAtt].st = "acc"
    /\ LET k == nAtt
           w == AcceptedWit(k)
       IN /\ att' = [att EXCEPT ![k].st = "applied"]
          /\ IF w = "sent"
               THEN /\ osent' = TRUE
                    /\ \E ev \in {"result", "retry", "stopped"} :
                         /\ ev = "retry" => nAtt < MaxAtt
                         /\ ost' = IF ev = "retry" THEN "retry" ELSE "ending"
                         /\ oend' = IF ev = "result" THEN "completed"
                                    ELSE IF ev = "stopped" THEN "interrupted" ELSE oend
                    /\ badOrigin' = (badOrigin \/ ex[k][att[k].acc].wit # "sent")
                    /\ UNCHANGED proto
             ELSE IF w = "exposed"
               THEN /\ osent' = TRUE /\ ost' = "ending" /\ oend' = "interrupted"
                    /\ UNCHANGED <<badOrigin, proto>>
             ELSE IF w = "settled"
               THEN /\ ost' = "failed" /\ proto' = TRUE
                    /\ UNCHANGED <<osent, oend, badOrigin>>
             ELSE IF osent
               THEN /\ ost' = "ending" /\ oend' = "interrupted"
                    /\ UNCHANGED <<osent, badOrigin, proto>>
             ELSE \E ev \in {"stopped", "park"} :
                    /\ ost' = IF ev = "park" THEN "parked" ELSE "ending"
                    /\ oend' = IF ev = "stopped" THEN "not_dispatched" ELSE oend
                    /\ UNCHANGED <<osent, badOrigin, proto>>
    /\ UNCHANGED <<storeVars, nAtt, ex, ocanc, latched, everLatch, cdone, oout, phys, sends,
                   badText, afterGuard, badSb, coerced, replayWithMarker, guardPend,
                   lateMarker, cancelDuringEnd>>

(* The end call (plan 5, 6). The store transaction computes the applied  *)
(* outcome first; the only coercion is not_dispatched -> interrupted when *)
(* an exposure row exists; final rows are never rewritten. A replay of   *)
(* the same call (same requested outcome, the original call identity)    *)
(* returns the applied outcome and changes nothing. The answer may be    *)
(* lost: the orchestration stays "ending" and calls again; a cancel      *)
(* latched meanwhile is written in between (it records cancel_requested  *)
(* on the final rows) and the end then replays the applied outcome.      *)
EndCall(lost) ==
    /\ ost = "ending"
    /\ IF out = "none"
         THEN LET applied == IF oend = "not_dispatched" /\ marker # 0 /\ Fault # "no_coerce"
                               THEN "interrupted" ELSE oend
              IN /\ out' = applied
                 /\ endReq' = oend
                 /\ coerced' = (coerced \/ applied # oend)
                 /\ proc' = [i \in Items |-> IF proc[i] = "bound" THEN "final" ELSE proc[i]]
                 /\ proto' = (proto \/ (marker # 0 /\ Active = {}))
                 /\ IF lost THEN UNCHANGED <<ost, oout>>
                    ELSE /\ ost' = "ended" /\ oout' = applied
         ELSE \* replay: the original call identity is checked first
              /\ proto' = (proto \/ oend # endReq)
              /\ UNCHANGED <<out, endReq, coerced, proc>>
              /\ IF lost THEN UNCHANGED <<ost, oout>>
                 ELSE /\ ost' = "ended" /\ oout' = out
    /\ UNCHANGED <<creq, marker, attVars, osent, oend, ocanc, latched, everLatch, cdone,
                   phys, sends, badText, afterGuard, badSb, badOrigin, replayWithMarker,
                   guardPend, lateMarker, cancelDuringEnd>>

-----------------------------------------------------------------------------
(* Cancels. A tombstone latches an item once (orchestration state).       *)
Latch(i) ==
    /\ i \notin everLatch /\ ost \notin {"failed"}
    /\ latched' = latched \cup {i} /\ everLatch' = everLatch \cup {i}
    /\ UNCHANGED <<storeVars, attVars, osent, ost, oend, ocanc, cdone, oout, ghostVars>>

(* The store's unsent cancel of item i under the invocation lock; the    *)
(* per-item answer is "cancelled" (settled as not_dispatched, reason       *)
(* cancelled), "final" (settled by the invocation's end, no exposure) or  *)
(* "exposed" (cancel_requested recorded, monotone, also on a final row:   *)
(* plan 6, a replay after terminal processing returns the same answer).  *)
(* Order: C1 first (an item already cancelled unsent answers "cancelled"  *)
(* again, before the marker is read, and is never revived); then the     *)
(* marker; then a final row without exposure. No row's processing is      *)
(* rewritten.                                                             *)
UnsentAnswer(i) ==
    IF proc[i] = "cancelled" /\ ~(Fault = "replay_marker" /\ marker # 0) THEN "cancelled"
    ELSE IF marker # 0 THEN "exposed"
    ELSE IF proc[i] = "final" THEN "final"
    ELSE "cancelled"

StoreUnsentCancel(i) ==
    LET a == UnsentAnswer(i) IN
    /\ proc' = IF a = "cancelled" THEN [proc EXCEPT ![i] = "cancelled"] ELSE proc
    /\ creq' = IF a = "exposed" THEN [creq EXCEPT ![i] = TRUE] ELSE creq
    /\ replayWithMarker' = (replayWithMarker \/
                              (proc[i] = "cancelled" /\ marker # 0 /\ a = "cancelled"))

(* The orchestration's cancel write for a latched item, between attempts  *)
(* (the wake): unsent invocation -> cancel_unsent; sent -> request_cancel. *)
CancelWrite(i, lost) ==
    /\ i \in latched /\ ost # "carrying"
    /\ cdone' = cdone \cup {i}
    /\ cancelDuringEnd' = (cancelDuringEnd \/ (ost = "ending" /\ out # "none"))
    /\ IF osent
         THEN /\ creq' = [creq EXCEPT ![i] = TRUE]
              /\ latched' = IF lost THEN latched ELSE latched \ {i}
              /\ UNCHANGED <<proc, osent, ost, oend, ocanc, replayWithMarker>>
         ELSE LET a       == UnsentAnswer(i)
                  isOpen  == ost \notin {"ending", "ended"}
                  allGone == Items \subseteq (ocanc \cup {i})
              IN
              /\ StoreUnsentCancel(i)
              /\ IF lost
                   THEN UNCHANGED <<latched, osent, ost, oend, ocanc>>
                   ELSE /\ latched' = latched \ {i}
                        /\ ocanc' = IF a = "cancelled" THEN ocanc \cup {i} ELSE ocanc
                        /\ osent' = (osent \/ a = "exposed")
                        /\ IF a = "cancelled" /\ allGone /\ isOpen
                             THEN /\ ost' = "ending" /\ oend' = "not_dispatched"
                           ELSE IF a = "exposed" /\ isOpen
                             THEN /\ ost' = "ending" /\ oend' = "interrupted"
                           ELSE UNCHANGED <<ost, oend>>
    /\ UNCHANGED <<out, endReq, marker, attVars, everLatch, oout, phys, sends, badText,
                   afterGuard, badSb, badOrigin, proto, coerced, guardPend, lateMarker>>

(* A delayed duplicate execution of an earlier unsent cancel write (its   *)
(* answer goes nowhere): the case "cancel A, expose B, replay cancel A".  *)
CancelReplay(i) ==
    /\ i \in cdone
    /\ StoreUnsentCancel(i)
    /\ UNCHANGED <<out, endReq, marker, attVars, orchVars, phys, sends, badText, afterGuard,
                   badSb, badOrigin, proto, coerced, guardPend, lateMarker, cancelDuringEnd>>

(* The orchestration is waiting for nothing it controls (bounded: no more *)
(* attempts, deliveries or cancels): stutter.                            *)
Done ==
    /\ ost # "ending"
    /\ UNCHANGED vars

Next ==
    \/ StartAttempt \/ Apply \/ Done
    \/ \E lost \in BOOLEAN : EndCall(lost)
    \/ \E k \in Atts, e \in Execs :
          \/ StartExec(k, e) \/ Reissue(k, e) \/ Guard(k, e) \/ Send(k, e)
          \/ Omit(k, e) \/ Crash(k, e) \/ Complete(k, e)
          \/ \E lost \in BOOLEAN : AdmitTxn(k, e, lost)
    \/ \E i \in Items : Latch(i) \/ CancelReplay(i) \/ \E lost \in BOOLEAN : CancelWrite(i, lost)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Safety.                                                                  *)

(* not_dispatched only if no item ever reached a model request.            *)
Inv_NotDispatchedTruthful == out = "not_dispatched" => phys = {}
(* Every physical send was admitted first (the marker exists).            *)
Inv_ExposedImpliesMarker == phys # {} => marker # 0
(* C1: an item cancelled unsent is never sent, requested or revived.      *)
Inv_CancelledStaysSettled ==
    \A i \in Items : proc[i] = "cancelled" => (i \notin phys /\ ~creq[i])
(* completed only from the accepted result's own include (result origin).  *)
Inv_CompletedFromOwnOrigin == ~badOrigin
(* C2: no send after a guard won.                                         *)
Inv_NoSendAfterGuard == ~afterGuard
(* After a possible exposure by another attempt, only the own retry sends. *)
Inv_OnlyOwnRetryAfterExposure == ~badSb
(* C3: only the canonical stored text is ever sent.                       *)
Inv_SentCanonical == ~badText
(* No visible protocol fault in a correct environment (AllowAlt = FALSE). *)
Inv_NoProtocolFault == ~proto
(* The only coercion is not_dispatched -> interrupted.                    *)
Inv_CoercionOnly == (out # "none" /\ out # endReq) => (endReq = "not_dispatched" /\ out = "interrupted")
(* The orchestration's end ends with the store's applied outcome, also    *)
(* after a lost answer and a replay.                                      *)
Inv_EndAnswerIsApplied == ost = "ended" => oout = out

Prop_MarkerInsertOnly == [][marker # 0 => marker' = marker]_vars
Prop_OutFinal == [][out # "none" => out' = out]_vars
Prop_ProcFinal == [][\A i \in Items : proc[i] # "bound" => proc'[i] = proc[i]]_vars
Prop_CreqMonotone == [][\A i \in Items : creq[i] => creq'[i]]_vars

-----------------------------------------------------------------------------
(* Witnesses, EXPECTED to be violated (reachable).                        *)
Wit_Coerced == ~coerced
Wit_DuplicateSends == sends < 2
(* Causal: a guard fired while the admission call was in flight, THAT    *)
(* transaction committed afterwards and inserted the marker, nothing was  *)
(* sent, and the end not_dispatched was coerced to interrupted.           *)
Wit_GuardLateMarker == ~(lateMarker /\ phys = {} /\ coerced /\ out = "interrupted")
(* An end whose answer was lost, a cancel written while the end is in     *)
(* flight (cancel_requested on the final row), then the end replays the   *)
(* applied outcome.                                                       *)
Wit_LateCancelDuringEnd ==
    ~(cancelDuringEnd /\ coerced /\ ost = "ended" /\ oout = "interrupted"
      /\ \E i \in Items : creq[i])
Wit_RefusedExposed == ~(\E k \in Atts, e \in Execs : ex[k][e].ref = "exposed")
Wit_CancelAExposeBReplayA ==
    ~(\E i, j \in Items : i # j /\ proc[i] = "cancelled" /\ j \in phys /\ replayWithMarker)

=============================================================================
