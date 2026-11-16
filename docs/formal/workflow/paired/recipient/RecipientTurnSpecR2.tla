------------------------ MODULE RecipientTurnSpecR2 ------------------------
(***************************************************************************)
(* RecipientTurnSpec (unchanged, extended) with four ENVIRONMENT timing    *)
(* generalizations found while mapping the W2 code (5df032f1). r1 guarded *)
(* these steps more narrowly than the design text: the narrow guards were  *)
(* modelling choices of r1, not obligations of the design. No carry rule,  *)
(* no invariant and no ghost formula changes: Carries (with the gate row   *)
(* "gate_retry only") and every property are inherited as they are.       *)
(*                                                                         *)
(*  E1 AbandonHeldBusy: a held turn's retry is dropped while another turn  *)
(*     is active (design 5.5 clarification at 5df032f1: "Only another      *)
(*     turn's retry replaces a held pending prompt; that retry then never  *)
(*     runs, and the invocation ends interrupted"). r1 allowed abandoning  *)
(*     a held turn only with no current turn.                              *)
(*  E2 CancelUnsentWaiting: the cancel write of an unsent invocation while *)
(*     a turn waits for its retry (between attempts; design 5.5 Cancels,   *)
(*     the wake makes latched writes between turns).                       *)
(*  E3 OwnInterpose: decide's own turn for a READY invocation while a      *)
(*     turn's retry waits (an agent wait holds the pending prompt; design  *)
(*     5.5 "when nothing else is queued"). I11 ghost unchanged.            *)
(*  E4 BindWaiting: forming and binding before the next attempt while a    *)
(*     turn waits for its retry (design 5.5 Binding: "before it starts its *)
(*     next turn attempt").                                                *)
(*                                                                         *)
(* r1's first-run results (RESULTS-TURNSPEC-FIRST-R1.md) are for r1 only;  *)
(* this module needs its own safety run (rts2-hd-safety).                  *)
(***************************************************************************)
EXTENDS RecipientTurnSpec

AbandonHeldBusy ==
    /\ Active(cur) /\ Active(held)
    /\ held' = NoTurn
    /\ inv' = IF Live /\ inv.sent /\ held.id = firstSent
                THEN [inv EXCEPT !.out = "interrupted"] ELSE inv
    /\ UNCHANGED <<nTurns, cur, firstSent, interposed, badRide, badOwn, badLatched>>

CancelUnsentWaiting ==
    /\ Live /\ ~inv.sent /\ inv.latched /\ Active(cur) /\ cur.waiting
    /\ inv' = [inv EXCEPT !.out = "not_dispatched", !.parked = "none"]
    /\ UNCHANGED <<nTurns, cur, held, firstSent, interposed, badRide, badOwn, badLatched>>

OwnInterpose ==
    /\ Active(cur) /\ cur.waiting /\ ~Active(held) /\ nTurns < MaxTurns
    /\ Ready
    /\ held' = cur /\ cur' = NewTurn("own") /\ nTurns' = nTurns + 1
    /\ interposed' = (interposed \/ cur.id = firstSent)
    /\ badOwn' = (badOwn \/ ~Ready)
    /\ UNCHANGED <<inv, firstSent, badRide, badLatched>>

BindWaiting ==
    /\ inv.st = "none" /\ Active(cur) /\ cur.waiting
    /\ inv' = [inv EXCEPT !.st = "bound"]
    /\ UNCHANGED <<nTurns, cur, held, firstSent, interposed, badRide, badOwn, badLatched>>

Next2 == Next \/ AbandonHeldBusy \/ CancelUnsentWaiting \/ OwnInterpose \/ BindWaiting

Spec2 == Init /\ [][Next2]_vars

=============================================================================
