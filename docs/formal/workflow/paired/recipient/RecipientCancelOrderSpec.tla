-------------------- MODULE RecipientCancelOrderSpec --------------------
(***************************************************************************)
(* Cancel-order amendment to the recipient intent model (r3, unchanged).  *)
(*                                                                         *)
(* The design's latched-cancel rule (5.5, "Latched cancels") and the       *)
(* wiring obligation recorded in the review of 813de112 say: the first     *)
(* time a tombstone names a copy, the decision is written into the carried *)
(* state, and only then may the tombstone leave the bounded cancel set,    *)
(* whether it is evicted or consumed by an ordinary prompt. Model r3 let   *)
(* its environment drop a tombstone (TombDrop) before LatchBy, so it did    *)
(* not express that obligation.                                            *)
(*                                                                         *)
(* This module adds:                                                       *)
(*  - an independent safety predicate, Inv_NoCancelLost: no tombstone has  *)
(*    ever left the cancel set while a copy it names was present,          *)
(*    latchable and not latched (ghosts lost, flost, set when it happens); *)
(*  - the obligation as the intent's own guard on TombDrop                 *)
(*    (Obligation = TRUE). With Obligation = FALSE, TombDrop is r3's,      *)
(*    unguarded: the negative control that shows the predicate is not      *)
(*    implied by r3.                                                       *)
(* Every r3 definition, invariant, property and fairness condition is      *)
(* reused unchanged; Next is r3's Next with TombDrop replaced.             *)
(***************************************************************************)
EXTENDS RecipientIntakeSpec

CONSTANT Obligation

ASSUME Obligation \in BOOLEAN

VARIABLES lost, flost

coVars == <<vars, lost, flost>>

(* A tombstone c names these copies, present, latchable and not latched.  *)
OpenGen(c)    == GenLatchable(c)
OpenForged(c) == ForgedLatchable(c)

InitCO ==
    /\ Init
    /\ lost = [e \in Ex |-> FALSE]
    /\ flost = FALSE

(* Eviction or consumption of tombstone c. The domain obligation: only    *)
(* once every copy it names is latched.                                    *)
TombDropCO(c) ==
    /\ TombDrop(c)
    /\ Obligation => (~OpenGen(c) /\ ~OpenForged(c))
    /\ lost' = [lost EXCEPT ![c] = @ \/ OpenGen(c)]
    /\ flost' = (flost \/ OpenForged(c))

(* r3's Next without TombDrop, copied disjunct for disjunct.               *)
OtherNext ==
    \/ \E c \in Ex : TombArrive(c)
    \/ \E e \in Ex :
          \/ Arrive(e) \/ ClaimOk(e) \/ DropLatch(e)
          \/ \E b, l \in BOOLEAN : ClaimNoAck(e, b, l)
    \/ \E c \in Ex, g, f \in BOOLEAN : LatchBy(c, g, f)
    \/ \E S \in SUBSET Ex, C \in SUBSET Ex, b \in BOOLEAN : CancelWrites(S, C, b)
    \/ ArriveForged
    \/ \E b, l \in BOOLEAN : ForgedClaim(b, l)
    \/ Form \/ WakeUnpark
    \/ \E b \in BOOLEAN : BindWrite(b) \/ EndWrite(b)
    \/ \E w \in BOOLEAN, r \in {"ok", "gate", "stop", "retry"} : Attempt(w, r)

NextCO ==
    \/ OtherNext /\ UNCHANGED <<lost, flost>>
    \/ \E c \in Ex : TombDropCO(c)

SpecCO == InitCO /\ [][NextCO]_coVars

(* r3's fairness, unchanged (A-STORE only).                                *)
LiveSpecCO == SpecCO /\ Fairness

(* The independent safety predicate.                                       *)
Inv_NoCancelLost == (\A e \in Ex : ~lost[e]) /\ ~flost

(* Witness, EXPECTED to be violated: under the obligation a tombstone      *)
(* still leaves the set, after the copy it named was latched.              *)
Wit_DropAfterLatch ==
    ~(\E e \in Ex : latch[e] /\ sawOwn[e] /\ e \notin tombs
                    /\ loc[e] \in {"unclaimed", "held", "settling", "inv"})

=============================================================================
