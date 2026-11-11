------------------------- MODULE RecipientTurnSpec -------------------------
(***************************************************************************)
(* Intent model: which turns carry the intake invocation (W2, turn         *)
(* binding). Derived from the design only (workflow-durable-intake.md at  *)
(* 66739e07, blob b8e927f4: 5.5 "Who carries it", the transition table,    *)
(* the resume stimuli, "Latched cancels"; section 7 I8, I9, I11), before   *)
(* any W2 code exists. The code model of the W2 checkpoint will be derived *)
(* separately and mapped to this module.                                   *)
(*                                                                         *)
(* One invocation (formed and bound by Bind) and a bounded number of       *)
(* turns. A turn is started by a stimulus; it makes attempts; an attempt   *)
(* that ends with "retrying" waits for that turn's retry (waiting). While  *)
(* a turn waits, another turn may run first (Interpose: for example a turn *)
(* that the session starts while the retry is held); the waiting turn     *)
(* resumes afterwards. The intent (I8): once an attempt sent or possibly   *)
(* sent the invocation, only attempts of that same turn carry it.          *)
(* Abandon models a turn whose retry never comes (its continue-as-new      *)
(* dropped it): the invocation ends interrupted.                           *)
(*                                                                         *)
(* Not modeled: items, texts, the store, binding failures, settlement      *)
(* writes (covered by RecipientIntakeSpec), sizes, liveness.               *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS MaxTurns, MaxRetries, Fault

ASSUME MaxTurns \in Nat \ {0} /\ MaxRetries \in Nat
ASSUME Fault \in {"none", "marker_any", "own_parked", "carry_latched"}

Stimuli  == {"message", "timer", "arrival", "gate_retry", "other"}
Resume   == {"message", "timer", "arrival"}
Outs     == {"none", "completed", "interrupted", "not_dispatched", "failed_indeterminate"}
Results  == {"stopped", "gate", "retrying", "failed", "result", "hydration"}
NoTurn   == [id |-> 0, stim |-> "other", retries |-> 0, waiting |-> FALSE]
Turns    == [id : 0..MaxTurns, stim : Stimuli \cup {"own"}, retries : 0..MaxRetries,
             waiting : BOOLEAN]

VARIABLES
    inv,        \* the invocation
    nTurns,     \* turns started so far
    cur,        \* the turn running now (NoTurn: none)
    held,       \* a turn whose retry waits while another turn runs
    firstSent,  \* the turn whose attempt first sent or possibly sent it; 0: none
    interposed, \* ghost: a turn ran while the first-sending turn waited
    badRide,    \* ghost: an attempt of another turn carried a sent invocation
    badOwn,     \* ghost: an own turn started for an invocation not ready
    badLatched  \* ghost: an unsent invocation with a latched cancel was carried

vars == <<inv, nTurns, cur, held, firstSent, interposed, badRide, badOwn, badLatched>>

Active(t) == t.id # 0

TypeOK ==
    /\ inv \in [st : {"none", "bound"}, sent : BOOLEAN,
                parked : {"none", "gate", "other"}, latched : BOOLEAN, out : Outs]
    /\ nTurns \in 0..MaxTurns
    /\ cur \in Turns /\ held \in Turns
    /\ firstSent \in 0..MaxTurns
    /\ interposed \in BOOLEAN /\ badRide \in BOOLEAN
    /\ badOwn \in BOOLEAN /\ badLatched \in BOOLEAN

Init ==
    /\ inv = [st |-> "none", sent |-> FALSE, parked |-> "none", latched |-> FALSE,
              out |-> "none"]
    /\ nTurns = 0 /\ cur = NoTurn /\ held = NoTurn /\ firstSent = 0
    /\ interposed = FALSE /\ badRide = FALSE /\ badOwn = FALSE /\ badLatched = FALSE

Live == inv.st = "bound" /\ inv.out = "none"

(* Ready (5.5): bound, unsent, not parked, no latched cancel.              *)
Ready == Live /\ ~inv.sent /\ inv.parked = "none" /\ ~inv.latched

-----------------------------------------------------------------------------
(* The invocation is formed and bound (the admission) before any attempt. *)
Bind ==
    /\ inv.st = "none" /\ ~Active(cur)
    /\ inv' = [inv EXCEPT !.st = "bound"]
    /\ UNCHANGED <<nTurns, cur, held, firstSent, interposed, badRide, badOwn, badLatched>>

(* A tombstone names an item: its cancel is latched (never undone).       *)
Latch ==
    /\ inv.st = "bound" /\ ~inv.latched
    /\ inv' = [inv EXCEPT !.latched = TRUE]
    /\ UNCHANGED <<nTurns, cur, held, firstSent, interposed, badRide, badOwn, badLatched>>

(* The cancel write of an unsent invocation (one item: the batch empties) *)
(* ends it not_dispatched. A sent one only records cancel_requested; its  *)
(* carrying is unchanged (not a step here).                                *)
CancelUnsent ==
    /\ Live /\ ~inv.sent /\ inv.latched /\ ~Active(cur)
    /\ inv' = [inv EXCEPT !.out = "not_dispatched", !.parked = "none"]
    /\ UNCHANGED <<nTurns, cur, held, firstSent, interposed, badRide, badOwn, badLatched>>

-----------------------------------------------------------------------------
(* Turns.                                                                  *)

NewTurn(s) == [id |-> nTurns + 1, stim |-> s, retries |-> 0, waiting |-> FALSE]

(* A turn-starting stimulus (a message, an answer or child update, a timer *)
(* turn, a newly claimed item, a gate's own retry, anything else).        *)
StartTurn(s) ==
    /\ ~Active(cur) /\ ~Active(held) /\ nTurns < MaxTurns
    /\ cur' = NewTurn(s) /\ nTurns' = nTurns + 1
    /\ UNCHANGED <<inv, held, firstSent, interposed, badRide, badOwn, badLatched>>

(* decide starts a turn for the invocation alone only when it is ready    *)
(* (5.5, I11).                                                              *)
OwnTurn ==
    /\ ~Active(cur) /\ ~Active(held) /\ nTurns < MaxTurns
    /\ \/ Ready
       \/ Fault = "own_parked" /\ Live /\ ~inv.sent
    /\ cur' = NewTurn("own") /\ nTurns' = nTurns + 1
    /\ badOwn' = (badOwn \/ ~Ready)
    /\ UNCHANGED <<inv, held, firstSent, interposed, badRide, badLatched>>

(* Another turn runs while the current turn waits for its retry.         *)
Interpose(s) ==
    /\ Active(cur) /\ cur.waiting /\ ~Active(held) /\ nTurns < MaxTurns
    /\ held' = cur /\ cur' = NewTurn(s) /\ nTurns' = nTurns + 1
    /\ interposed' = (interposed \/ cur.id = firstSent)
    /\ UNCHANGED <<inv, firstSent, badRide, badOwn, badLatched>>

ResumeHeld ==
    /\ ~Active(cur) /\ Active(held)
    /\ cur' = held /\ held' = NoTurn
    /\ UNCHANGED <<inv, nTurns, firstSent, interposed, badRide, badOwn, badLatched>>

(* The waiting turn's retry timer fires.                                   *)
RetryReady ==
    /\ Active(cur) /\ cur.waiting
    /\ cur' = [cur EXCEPT !.waiting = FALSE]
    /\ UNCHANGED <<inv, nTurns, held, firstSent, interposed, badRide, badOwn, badLatched>>

(* A waiting turn whose retry never comes (continue-as-new dropped it).   *)
(* Its sent invocation ends interrupted; it is never carried again.       *)
Abandon ==
    /\ \/ Active(cur) /\ cur.waiting /\ cur' = NoTurn /\ held' = held
       \/ ~Active(cur) /\ Active(held) /\ held' = NoTurn /\ cur' = cur
    /\ LET t == IF Active(cur) THEN cur ELSE held
       IN inv' = IF Live /\ inv.sent /\ t.id = firstSent
                   THEN [inv EXCEPT !.out = "interrupted"] ELSE inv
    /\ UNCHANGED <<nTurns, firstSent, interposed, badRide, badOwn, badLatched>>

-----------------------------------------------------------------------------
(* Who carries it (5.5).                                                   *)
Carries(t) ==
    /\ Live
    /\ IF inv.sent
         THEN \/ t.id = firstSent
              \/ /\ Fault = "marker_any"       \* the next turn takes the retry's place
                 /\ Active(held) /\ held.id = firstSent /\ t.retries = 0
         ELSE /\ (~inv.latched \/ Fault = "carry_latched")
              /\ \/ inv.parked = "none"
                 \/ inv.parked = "gate" /\ t.stim = "gate_retry" /\ t.retries = 0
                 \/ inv.parked = "other" /\ t.stim \in Resume /\ t.retries = 0

(* One attempt of the current turn. w: its witness (sent). r: how the     *)
(* turn goes on (the transition table's event column); "hydration" is an  *)
(* attempt that did not run (sent is not updated).                         *)
Attempt(w, r) ==
    /\ Active(cur) /\ ~cur.waiting
    /\ LET c      == Carries(cur)
           ran    == r # "hydration"
           s      == inv.sent \/ (c /\ ran /\ w)
           retry  == r = "retrying" /\ cur.retries < MaxRetries
           ev     == IF r = "retrying" /\ ~retry THEN "failed" ELSE r
           \* the first matching row of the table, sent already updated
           o == IF ev = "retrying" THEN "none"
                ELSE IF ev = "result" /\ w THEN "completed"
                ELSE IF s THEN (IF ev = "failed" THEN "failed_indeterminate"
                                ELSE "interrupted")
                ELSE IF ev = "stopped" THEN "not_dispatched"
                ELSE "none"                        \* unsent: parked
           p == IF s \/ ev \in {"retrying", "stopped"} THEN "none"
                ELSE IF ev = "gate" THEN "gate"
                ELSE "other"
       IN /\ inv' = IF c
                      THEN [inv EXCEPT !.sent = s, !.out = o,
                                       !.parked = IF o = "none" /\ ev # "retrying"
                                                    THEN p ELSE "none"]
                      ELSE inv
          /\ firstSent' = IF c /\ ~inv.sent /\ s THEN cur.id ELSE firstSent
          /\ badRide' = (badRide \/ (c /\ inv.sent /\ cur.id # firstSent))
          /\ badLatched' = (badLatched \/ (c /\ ~inv.sent /\ inv.latched))
          /\ cur' = IF retry THEN [cur EXCEPT !.retries = @ + 1, !.waiting = TRUE]
                    ELSE NoTurn
    /\ UNCHANGED <<nTurns, held, interposed, badOwn>>

-----------------------------------------------------------------------------
(* Nothing more can happen within the bounds: a stuttering end, so that   *)
(* the turn bound is not reported as a deadlock.                           *)
Done ==
    /\ ~Active(cur) /\ ~Active(held) /\ nTurns = MaxTurns
    /\ UNCHANGED vars

Next ==
    \/ Bind \/ Latch \/ CancelUnsent \/ Done
    \/ \E s \in Stimuli : StartTurn(s) \/ Interpose(s)
    \/ OwnTurn \/ ResumeHeld \/ RetryReady \/ Abandon
    \/ \E w \in BOOLEAN, r \in Results : Attempt(w, r)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Safety.                                                                  *)

(* I8: after an attempt sent or possibly sent it, only that turn carries it. *)
Inv_SentRidesOwnTurn == ~badRide

(* I11: decide starts an own turn only for a ready invocation.             *)
Inv_NoOwnTurnUnlessReady == ~badOwn

(* Latched cancels: an unsent invocation with a latched item is not carried. *)
Inv_NoCarryLatchedUnsent == ~badLatched

(* I9: not_dispatched only when no attempt sent it; completed only after a send. *)
Inv_Truthful ==
    /\ inv.out = "not_dispatched" => firstSent = 0
    /\ inv.out = "completed" => firstSent # 0

(* I9: sent is cumulative; an outcome is final.                            *)
Prop_SentSticky == [][inv.sent => inv'.sent]_vars
Prop_OutFinal == [][inv.out # "none" => inv'.out = inv.out]_vars

-----------------------------------------------------------------------------
(* Witnesses, EXPECTED to be violated (reachable).                        *)

(* A sent invocation completes in its own turn after another turn ran in  *)
(* between and did not carry it.                                           *)
Wit_CompletedAfterInterpose == ~(interposed /\ inv.out = "completed")

(* A gate-parked invocation completes after the gate's own retry turn.    *)
Wit_GateResumed == ~(inv.out = "completed" /\ firstSent # 0 /\ nTurns >= 2 /\ ~interposed)

(* An abandoned retry ends the invocation interrupted.                     *)
Wit_AbandonedInterrupted == ~(inv.out = "interrupted" /\ ~Active(cur) /\ ~Active(held)
                               /\ firstSent # 0)

=============================================================================
