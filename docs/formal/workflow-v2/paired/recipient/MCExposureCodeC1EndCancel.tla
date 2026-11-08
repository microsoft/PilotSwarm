----------------------- MODULE MCExposureCodeC1EndCancel -----------------------
(***************************************************************************)
(* End and cancel-write ordering at core pin c1bda7a2, as written.        *)
(* EXTENDS RecipientExposureCode (unchanged) and replaces its EndCall and *)
(* CancelWrite, which each collapsed a store call and its answer into one *)
(* step (A-END; M6 atomic cancel write). Sources (c1bda7a2):              *)
(*  store.ts endWorkflowIntake: outcome = coerce(requested) under the     *)
(*    lock; rows already at that outcome are a replay (nothing written),  *)
(*    so both the original not_dispatched call and an interrupted call    *)
(*    replay a coerced end; any other value is a broken invariant; a      *)
(*    replay naming an unrecorded cancel is broken; the commit records    *)
(*    the named cancel flags.                                             *)
(*  store.ts cancelUnsentWorkflowIntake / requestCancelWorkflowIntake:    *)
(*    one transaction per item; intake-activities.ts settles the list     *)
(*    item by item, a retry repeats the whole list.                       *)
(*  intake-machine.ts invocationWrite (bind, then cancel write, then end),*)
(*    latchCopies (no latch on an unsent ending invocation),              *)
(*    applyIntakeEnded (answeredEnd: same outcome; a cancel latched while *)
(*    the end was in flight -> end_after_cancel: sent ||= coerced, settle *)
(*    := applied, end made again), applyIntakeInvocationCancelled         *)
(*    (answeredCancel: same kind; only named items acknowledged).         *)
(* r1 correction (pre-execution): every store write is a blocking yield  *)
(* of the wake (intake-wiring.ts intakeWrite 187-200, wakeOnce 400-418): *)
(* while a write is in flight the orchestration takes no other step      *)
(* (OrchFree); worker executions and duplicate store executions go on.   *)
(* A latch "while the end was in flight" therefore needs a failed (lost)  *)
(* end call first; end_after_cancel is a defensive branch.               *)
(* Store calls and answers are separate steps; an answer may be lost      *)
(* (the call is made again); a duplicate execution of an earlier end call *)
(* replays in the store (EndDup).                                         *)
(***************************************************************************)
EXTENDS RecipientExposureCode

Coerce(r) == IF r = "not_dispatched" /\ marker # 0 THEN "interrupted" ELSE r

NoEndFl == [on |-> FALSE, req |-> "none", app |-> "none"]
NoCwFl  == [on |-> FALSE, kind |-> "unsent", W |-> {}, todo |-> {}, E |-> {}]

VARIABLES endFl, cwFl, endIssued,
          machineErr, endAfterCancel, appliedReplay, coercedReplay, mixedCancel, cancelDuringEnd

eVars == <<endFl, cwFl, endIssued, machineErr, endAfterCancel, appliedReplay, coercedReplay,
           mixedCancel, cancelDuringEnd>>
eAllVars == <<vars, eVars>>

EInit ==
    /\ Init
    /\ endFl = NoEndFl /\ cwFl = NoCwFl /\ endIssued = {}
    /\ machineErr = FALSE /\ endAfterCancel = FALSE /\ appliedReplay = FALSE
    /\ coercedReplay = FALSE /\ mixedCancel = FALSE /\ cancelDuringEnd = FALSE

Named == inv.creqO \cap inv.items

(* No store write of the orchestration is in flight.                       *)
OrchFree == ~endFl.on /\ ~cwFl.on

(* The end activity's store transaction (the call fixed when it was made; *)
(* a latch between the call and its transaction does not change it).     *)
EndStore ==
    /\ ost = "ending" /\ ~inv.cw /\ OrchFree
    /\ LET req == inv.settle
           app == Coerce(req)
       IN /\ IF out = "none"
               THEN /\ out' = app /\ endReq' = req
                    /\ proc' = [i \in Items |-> IF i \in inv.items /\ proc[i] = "bound" THEN "final" ELSE proc[i]]
                    /\ creq' = [i \in Items |-> creq[i] \/ i \in Named]
                    /\ storeBroken' = (storeBroken \/ (marker # 0 /\ inv.items = {}))
                    /\ coerced' = (coerced \/ app # req)
                    /\ UNCHANGED <<appliedReplay, coercedReplay>>
               ELSE /\ storeBroken' = (storeBroken \/ app # out \/ \E i \in Named : ~creq[i])
                    /\ appliedReplay' = (appliedReplay \/ (app = out /\ req # endReq))
                    /\ coercedReplay' = (coercedReplay \/ (app = out /\ app # req))
                    /\ UNCHANGED <<out, endReq, proc, creq, coerced>>
          /\ endFl' = [on |-> TRUE, req |-> req, app |-> app]
          /\ endIssued' = endIssued \cup {req}
    /\ UNCHANGED <<marker, orchVars, attVars, phys, sends, badText, afterGuard, badSb, badOrigin,
                   proto, settledFail, assertFail, guardPend, lateMarker, cancelExposed,
                   latchWhileEnding, cwFl, machineErr, endAfterCancel, mixedCancel, cancelDuringEnd>>

(* A delayed duplicate execution of an earlier end call (answer unused). *)
EndDup(r) ==
    /\ r \in endIssued /\ out # "none"
    /\ storeBroken' = (storeBroken \/ Coerce(r) # out)
    /\ UNCHANGED <<proc, creq, out, endReq, marker, orchVars, attVars, phys, sends, badText,
                   afterGuard, badSb, badOrigin, proto, coerced, settledFail, assertFail,
                   guardPend, lateMarker, cancelExposed, latchWhileEnding, eVars>>

(* The end's answer reaches the orchestration, or is lost (made again).  *)
EndAnswer(lost) ==
    /\ endFl.on
    /\ endFl' = NoEndFl
    /\ IF lost
         THEN UNCHANGED <<inv, ost, oout, machineErr, endAfterCancel>>
       ELSE IF ~inv.live \/ inv.settle # endFl.req
         THEN /\ machineErr' = TRUE
              /\ UNCHANGED <<inv, ost, oout, endAfterCancel>>
       ELSE IF inv.cw
         THEN /\ inv' = [inv EXCEPT !.sent = (inv.sent \/ endFl.app # endFl.req), !.settle = endFl.app]
              /\ endAfterCancel' = TRUE
              /\ UNCHANGED <<ost, oout, machineErr>>
       ELSE /\ inv' = NoInv /\ ost' = "done" /\ oout' = endFl.app
            /\ UNCHANGED <<machineErr, endAfterCancel>>
    /\ UNCHANGED <<storeVars, everLatch, cdone, attVars, ghostVars, cwFl, endIssued, appliedReplay,
                   coercedReplay, mixedCancel, cancelDuringEnd>>

(* The cancel write is made: every latched item of the batch, kind by    *)
(* whether the invocation is sent.                                       *)
CancelCall ==
    /\ inv.live /\ inv.cw /\ OrchFree /\ ost \notin {"carrying", "failed"}
    /\ cwFl' = [on |-> TRUE, kind |-> IF inv.sent THEN "requested" ELSE "unsent",
                W |-> Named, todo |-> Named, E |-> {}]
    /\ UNCHANGED <<vars, endFl, endIssued, machineErr, endAfterCancel, appliedReplay,
                   coercedReplay, mixedCancel, cancelDuringEnd>>

(* One item's store transaction, in any order of the list.               *)
(* cancelDuringEnd (r1): the end committed and the invocation is not yet  *)
(* cleared (the intent's meaning; it needs a lost end answer).           *)
CancelItem(i) ==
    /\ cwFl.on /\ i \in cwFl.todo
    /\ cancelDuringEnd' = (cancelDuringEnd \/ (out # "none" /\ ost = "ending"))
    /\ IF cwFl.kind = "requested"
         THEN /\ creq' = [creq EXCEPT ![i] = TRUE]
              /\ cwFl' = [cwFl EXCEPT !.todo = @ \ {i}]
              /\ UNCHANGED <<proc, storeBroken, cdone>>
         ELSE LET a == UnsentAnswer(i) IN
              /\ proc' = IF a = "cancelled" THEN [proc EXCEPT ![i] = "cancelled"] ELSE proc
              /\ creq' = IF a = "exposed" THEN [creq EXCEPT ![i] = TRUE] ELSE creq
              /\ storeBroken' = (storeBroken \/ a = "broken")
              /\ cwFl' = [cwFl EXCEPT !.todo = @ \ {i}, !.E = IF a = "exposed" THEN @ \cup {i} ELSE @]
              /\ cdone' = cdone \cup {i}
    /\ UNCHANGED <<out, endReq, marker, inv, ost, oout, everLatch, attVars, phys, sends, badText,
                   afterGuard, badSb, badOrigin, proto, coerced, settledFail, assertFail, guardPend,
                   lateMarker, cancelExposed, latchWhileEnding, endFl, endIssued, machineErr,
                   endAfterCancel, appliedReplay, coercedReplay, mixedCancel>>

(* The list's answer reaches the orchestration, or is lost.               *)
CancelAnswer(lost) ==
    /\ cwFl.on /\ cwFl.todo = {}
    /\ cwFl' = NoCwFl
    /\ LET W == cwFl.W
           E == cwFl.E
           curKind == IF inv.sent THEN "requested" ELSE "unsent"
           left == (Named \ W) # {}
       IN IF lost
            THEN UNCHANGED <<inv, ost, machineErr, mixedCancel, cancelExposed>>
          ELSE IF ~inv.live \/ curKind # cwFl.kind \/ ~(W \subseteq Named)
            THEN /\ machineErr' = TRUE
                 /\ UNCHANGED <<inv, ost, mixedCancel, cancelExposed>>
          ELSE /\ mixedCancel' = (mixedCancel \/ (E # {} /\ W \ E # {}))
               /\ UNCHANGED machineErr
               /\ IF inv.sent
                    THEN /\ inv' = [inv EXCEPT !.cw = left]
                         /\ UNCHANGED <<ost, cancelExposed>>
                  ELSE LET keep == (inv.items \ W) \cup E IN
                       IF E # {}
                         THEN /\ inv' = [inv EXCEPT !.items = keep, !.sent = TRUE, !.cw = left,
                                                    !.settle = "interrupted"]
                              /\ ost' = "ending" /\ cancelExposed' = TRUE
                       ELSE IF keep = {}
                         THEN /\ inv' = [inv EXCEPT !.items = {}, !.cw = FALSE, !.settle = "not_dispatched"]
                              /\ ost' = "ending"
                              /\ UNCHANGED cancelExposed
                       ELSE /\ inv' = [inv EXCEPT !.items = keep, !.cw = left]
                            /\ UNCHANGED <<ost, cancelExposed>>
    /\ UNCHANGED <<storeVars, oout, everLatch, cdone, attVars, phys, sends, badText, afterGuard,
                   badSb, badOrigin, proto, coerced, storeBroken, settledFail, assertFail,
                   guardPend, lateMarker, latchWhileEnding, endFl, endIssued, endAfterCancel,
                   appliedReplay, coercedReplay, cancelDuringEnd>>

ENext ==
    \/ ((StartAttempt /\ OrchFree) \/ Apply \/ Done) /\ UNCHANGED eVars
    \/ EndStore \/ CancelCall
    \/ \E lost \in BOOLEAN : EndAnswer(lost) \/ CancelAnswer(lost)
    \/ \E r \in Outs : EndDup(r)
    \/ \E k \in Atts, e \in Execs :
          \/ (\/ StartExec(k, e) \/ Reissue(k, e) \/ Guard(k, e) \/ Deliver(k, e)
              \/ Crash(k, e) \/ Complete(k, e)
              \/ \E lost \in BOOLEAN : AdmitTxn(k, e, lost)) /\ UNCHANGED eVars
    \/ \E i \in Items : \/ ((Latch(i) /\ OrchFree) \/ CancelReplay(i)) /\ UNCHANGED eVars
                        \/ CancelItem(i)

ESpec == EInit /\ [][ENext]_eAllVars

-----------------------------------------------------------------------------
Inv_E_NoMachineError == ~machineErr     \* answeredEnd / answeredCancel never throw
Inv_E_NoMixedCancel == ~mixedCancel     \* an unsent write is all exposed or none (M6)

(* Witnesses, EXPECTED to be violated (reachable).                        *)
Wit_E_EndAfterCancel == ~(endAfterCancel /\ ost = "done")
Wit_E_CancelDuringEnd == ~(cancelDuringEnd /\ ost = "done")
Wit_E_CoercedReplay == ~coercedReplay
(* Diagnostic: a replay with another requested outcome that the store    *)
(* accepts (the applied interrupted after a coerced not_dispatched).      *)
Diag_E_AppliedReplay == ~appliedReplay

=============================================================================
