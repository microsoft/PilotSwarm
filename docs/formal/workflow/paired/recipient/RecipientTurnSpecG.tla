------------------------- MODULE RecipientTurnSpecG -------------------------
(***************************************************************************)
(* Amended intent proposal (r3) for W2 turn binding: the gate row of the  *)
(* resume table, with the gate's wait made explicit. Self-contained; the  *)
(* original intent (RecipientTurnSpec r1, and R2 = r1 + environment       *)
(* timing E1-E4) is kept unchanged beside it.                              *)
(*                                                                         *)
(* Same as R2 except:                                                      *)
(*  1. The gate environment is explicit (design 5.5 resume table, source  *)
(*     premises re-read at 5df032f1/009109e2): gateOpen (would the gates  *)
(*     admit an attempt now), gateWait (the gate's own timer is armed).   *)
(*     A refusal arms the wait; only the wait's own fire starts a         *)
(*     gate_retry turn; a message turn ends the wait; other events         *)
(*     (workspace commands, a digest or queued work) may end it            *)
(*     (GateWaitEnds); an ended wait is never re-armed except by a new    *)
(*     refusal.                                                            *)
(*  2. The gate check is part of every attempt (assumption A-GATE-FIRST,  *)
(*     an obligation on the worker, checked at source, not here): a       *)
(*     refusal happens only with the gate closed and reports "no"; a     *)
(*     confirmed send ("yes") and a model result happen only with the     *)
(*     gate open.                                                          *)
(*  3. The attempt's witness is the design's three-valued one: "yes"      *)
(*     (witness sent: true), "no" (witness sent: false), "unknown" (no    *)
(*     witness, or a throw): sent if not "no"; completed only on "yes".   *)
(*  4. GateResume chooses the gate row: "timer_only" is the design's      *)
(*     current row (the gate's own retry only); "revalidated" is the      *)
(*     proposed row (any attempt, since every attempt is re-checked by    *)
(*     the gates before any send). Every other carry row, I8, I11, the   *)
(*     latched rule and I9 are unchanged.                                  *)
(*  5. Inv_GateParkClearedOnPass (progress, stated as bounded safety): a   *)
(*     gate-parked invocation is not still gate-parked with the gate's    *)
(*     wait gone after an attempt got a model result (passed the gates)   *)
(*     since it was parked: no gate_retry can then come unless the gates  *)
(*     refuse again, and no active turn is eligible to carry it.          *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS MaxTurns, MaxRetries, MaxGateFlips, GateResume

ASSUME MaxTurns \in Nat \ {0} /\ MaxRetries \in Nat /\ MaxGateFlips \in Nat
ASSUME GateResume \in {"timer_only", "revalidated"}

Stimuli  == {"message", "timer", "arrival", "gate_retry", "other"}
Resume   == {"message", "timer", "arrival"}
Outs     == {"none", "completed", "interrupted", "not_dispatched", "failed_indeterminate"}
Results  == {"stopped", "gate", "retrying", "failed", "result", "hydration"}
Wit3     == {"yes", "no", "unknown"}
NoTurn   == [id |-> 0, stim |-> "other", retries |-> 0, waiting |-> FALSE]
Turns    == [id : 0..MaxTurns, stim : Stimuli \cup {"own"}, retries : 0..MaxRetries,
             waiting : BOOLEAN]

VARIABLES inv, nTurns, cur, held, firstSent, interposed, badRide, badOwn, badLatched,
          gateOpen, gateWait, flips, passed

vars == <<inv, nTurns, cur, held, firstSent, interposed, badRide, badOwn, badLatched,
          gateOpen, gateWait, flips, passed>>
gv   == <<gateOpen, gateWait, flips, passed>>

Active(t) == t.id # 0

TypeOK ==
    /\ inv \in [st : {"none", "bound"}, sent : BOOLEAN,
                parked : {"none", "gate", "other"}, latched : BOOLEAN, out : Outs]
    /\ nTurns \in 0..MaxTurns
    /\ cur \in Turns /\ held \in Turns
    /\ firstSent \in 0..MaxTurns
    /\ interposed \in BOOLEAN /\ badRide \in BOOLEAN
    /\ badOwn \in BOOLEAN /\ badLatched \in BOOLEAN
    /\ gateOpen \in BOOLEAN /\ gateWait \in BOOLEAN /\ flips \in 0..MaxGateFlips
    /\ passed \in BOOLEAN

Init ==
    /\ inv = [st |-> "none", sent |-> FALSE, parked |-> "none", latched |-> FALSE,
              out |-> "none"]
    /\ nTurns = 0 /\ cur = NoTurn /\ held = NoTurn /\ firstSent = 0
    /\ interposed = FALSE /\ badRide = FALSE /\ badOwn = FALSE /\ badLatched = FALSE
    /\ gateOpen \in (IF MaxGateFlips = 0 THEN {TRUE} ELSE BOOLEAN)
    /\ gateWait = FALSE /\ flips = 0 /\ passed = FALSE

Live  == inv.st = "bound" /\ inv.out = "none"
Ready == Live /\ ~inv.sent /\ inv.parked = "none" /\ ~inv.latched

-----------------------------------------------------------------------------
(* Invocation steps (r1 and R2 E2, E4).                                    *)

Bind ==
    /\ inv.st = "none" /\ (~Active(cur) \/ cur.waiting)
    /\ inv' = [inv EXCEPT !.st = "bound"]
    /\ UNCHANGED <<nTurns, cur, held, firstSent, interposed, badRide, badOwn, badLatched>>
    /\ UNCHANGED gv

Latch ==
    /\ inv.st = "bound" /\ ~inv.latched
    /\ inv' = [inv EXCEPT !.latched = TRUE]
    /\ UNCHANGED <<nTurns, cur, held, firstSent, interposed, badRide, badOwn, badLatched>>
    /\ UNCHANGED gv

CancelUnsent ==
    /\ Live /\ ~inv.sent /\ inv.latched /\ (~Active(cur) \/ cur.waiting)
    /\ inv' = [inv EXCEPT !.out = "not_dispatched", !.parked = "none"]
    /\ UNCHANGED <<nTurns, cur, held, firstSent, interposed, badRide, badOwn, badLatched>>
    /\ UNCHANGED gv

-----------------------------------------------------------------------------
(* Gate environment.                                                       *)

GateFlip ==
    /\ flips < MaxGateFlips
    /\ gateOpen' = ~gateOpen /\ flips' = flips + 1
    /\ UNCHANGED <<inv, nTurns, cur, held, firstSent, interposed, badRide, badOwn, badLatched,
                   gateWait, passed>>

\* A workspace command, a ready digest or released queued work ends the wait.
GateWaitEnds ==
    /\ gateWait /\ gateWait' = FALSE
    /\ UNCHANGED <<inv, nTurns, cur, held, firstSent, interposed, badRide, badOwn, badLatched,
                   gateOpen, flips, passed>>

\* How a turn-starting stimulus meets the gate's wait.
StimOK(s) == /\ s = "timer" => ~gateWait          \* the gate's wait is the active timer
             /\ s = "gate_retry" => gateWait       \* only the wait's own fire
WaitAfter(s) == IF s \in {"message", "gate_retry"} THEN FALSE ELSE gateWait

-----------------------------------------------------------------------------
(* Turns (r1, R2 E1, E3).                                                  *)

NewTurn(s) == [id |-> nTurns + 1, stim |-> s, retries |-> 0, waiting |-> FALSE]

StartTurn(s) ==
    /\ ~Active(cur) /\ ~Active(held) /\ nTurns < MaxTurns /\ StimOK(s)
    /\ cur' = NewTurn(s) /\ nTurns' = nTurns + 1 /\ gateWait' = WaitAfter(s)
    /\ UNCHANGED <<inv, held, firstSent, interposed, badRide, badOwn, badLatched,
                   gateOpen, flips, passed>>

OwnTurn ==
    /\ ~Active(cur) /\ ~Active(held) /\ nTurns < MaxTurns /\ Ready
    /\ cur' = NewTurn("own") /\ nTurns' = nTurns + 1
    /\ badOwn' = (badOwn \/ ~Ready)
    /\ UNCHANGED <<inv, held, firstSent, interposed, badRide, badLatched>> /\ UNCHANGED gv

Interpose(s) ==
    /\ Active(cur) /\ cur.waiting /\ ~Active(held) /\ nTurns < MaxTurns /\ StimOK(s)
    /\ held' = cur /\ cur' = NewTurn(s) /\ nTurns' = nTurns + 1 /\ gateWait' = WaitAfter(s)
    /\ interposed' = (interposed \/ cur.id = firstSent)
    /\ UNCHANGED <<inv, firstSent, badRide, badOwn, badLatched, gateOpen, flips, passed>>

OwnInterpose ==
    /\ Active(cur) /\ cur.waiting /\ ~Active(held) /\ nTurns < MaxTurns /\ Ready
    /\ held' = cur /\ cur' = NewTurn("own") /\ nTurns' = nTurns + 1
    /\ interposed' = (interposed \/ cur.id = firstSent)
    /\ badOwn' = (badOwn \/ ~Ready)
    /\ UNCHANGED <<inv, firstSent, badRide, badLatched>> /\ UNCHANGED gv

ResumeHeld ==
    /\ ~Active(cur) /\ Active(held)
    /\ cur' = held /\ held' = NoTurn
    /\ UNCHANGED <<inv, nTurns, firstSent, interposed, badRide, badOwn, badLatched>>
    /\ UNCHANGED gv

RetryReady ==
    /\ Active(cur) /\ cur.waiting
    /\ cur' = [cur EXCEPT !.waiting = FALSE]
    /\ UNCHANGED <<inv, nTurns, held, firstSent, interposed, badRide, badOwn, badLatched>>
    /\ UNCHANGED gv

Abandon ==
    /\ \/ Active(cur) /\ cur.waiting /\ cur' = NoTurn /\ held' = held
       \/ ~Active(cur) /\ Active(held) /\ held' = NoTurn /\ cur' = cur
       \/ Active(cur) /\ Active(held) /\ held' = NoTurn /\ cur' = cur     \* R2 E1
    /\ LET t == IF held' # held THEN held ELSE cur
       IN inv' = IF Live /\ inv.sent /\ t.id = firstSent
                   THEN [inv EXCEPT !.out = "interrupted"] ELSE inv
    /\ UNCHANGED <<nTurns, firstSent, interposed, badRide, badOwn, badLatched>>
    /\ UNCHANGED gv

-----------------------------------------------------------------------------
(* Who carries it (5.5). Only the gate row depends on GateResume.         *)
Carries(t) ==
    /\ Live
    /\ IF inv.sent
         THEN t.id = firstSent
         ELSE /\ ~inv.latched
              /\ \/ inv.parked = "none"
                 \/ /\ inv.parked = "gate"
                    /\ \/ GateResume = "revalidated"
                       \/ t.stim = "gate_retry" /\ t.retries = 0
                 \/ inv.parked = "other" /\ t.stim \in Resume /\ t.retries = 0

(* One attempt of the current turn; the gates are checked inside it.       *)
Attempt(w, r) ==
    /\ Active(cur) /\ ~cur.waiting
    /\ r = "gate" => (~gateOpen /\ w = "no")
    /\ r = "result" => gateOpen
    /\ w = "yes" => gateOpen
    /\ LET c      == Carries(cur)
           ran    == r # "hydration"
           s      == inv.sent \/ (c /\ ran /\ w # "no")
           retry  == r = "retrying" /\ cur.retries < MaxRetries
           ev     == IF r = "retrying" /\ ~retry THEN "failed" ELSE r
           o == IF ev = "retrying" THEN "none"
                ELSE IF ev = "result" /\ w = "yes" THEN "completed"
                ELSE IF s THEN (IF ev = "failed" THEN "failed_indeterminate"
                                ELSE "interrupted")
                ELSE IF ev = "stopped" THEN "not_dispatched"
                ELSE "none"
           p == IF s \/ ev \in {"retrying", "stopped"} THEN "none"
                ELSE IF ev = "gate" THEN "gate"
                ELSE "other"
           np == IF o = "none" /\ ev # "retrying" THEN p ELSE "none"
       IN /\ inv' = IF c THEN [inv EXCEPT !.sent = s, !.out = o, !.parked = np] ELSE inv
          /\ firstSent' = IF c /\ ~inv.sent /\ s THEN cur.id ELSE firstSent
          /\ badRide' = (badRide \/ (c /\ inv.sent /\ cur.id # firstSent))
          /\ badLatched' = (badLatched \/ (c /\ ~inv.sent /\ inv.latched))
          /\ cur' = IF retry THEN [cur EXCEPT !.retries = @ + 1, !.waiting = TRUE]
                    ELSE NoTurn
          /\ gateWait' = IF r = "gate" THEN TRUE ELSE gateWait
          /\ passed' = IF r = "result" THEN TRUE
                       ELSE IF c /\ np = "gate" THEN FALSE
                       ELSE passed
    /\ UNCHANGED <<nTurns, held, interposed, badOwn, gateOpen, flips>>

Done ==
    /\ ~Active(cur) /\ ~Active(held) /\ nTurns = MaxTurns
    /\ UNCHANGED vars

NextG ==
    \/ Bind \/ Latch \/ CancelUnsent \/ GateFlip \/ GateWaitEnds \/ Done
    \/ \E s \in Stimuli : StartTurn(s) \/ Interpose(s)
    \/ OwnTurn \/ OwnInterpose \/ ResumeHeld \/ RetryReady \/ Abandon
    \/ \E w \in Wit3, r \in Results : Attempt(w, r)

SpecG == Init /\ [][NextG]_vars

-----------------------------------------------------------------------------
(* Properties: r1's, unchanged, and the progress predicate.                *)
Inv_SentRidesOwnTurn == ~badRide
Inv_NoOwnTurnUnlessReady == ~badOwn
Inv_NoCarryLatchedUnsent == ~badLatched
Inv_Truthful ==
    /\ inv.out = "not_dispatched" => firstSent = 0
    /\ inv.out = "completed" => firstSent # 0
Prop_SentSticky == [][inv.sent => inv'.sent]_vars
Prop_OutFinal == [][inv.out # "none" => inv'.out = inv.out]_vars

\* Stranded: gate-parked, an attempt passed the gates since, the gate's wait
\* is gone (no gate_retry can come unless the gates refuse again), and no
\* active turn (current or held) is eligible to carry it. The last clause
\* (amended after review of d229a253) excludes a legitimate gate_retry turn
\* that has consumed the wait but not yet made its attempt.
Inv_GateParkClearedOnPass ==
    ~(/\ Live /\ ~inv.sent /\ inv.parked = "gate" /\ ~inv.latched /\ passed /\ ~gateWait
      /\ ~\E t \in {cur, held} : Active(t) /\ Carries(t))

=============================================================================
