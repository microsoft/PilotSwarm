------------------------ MODULE RecipientIntakeCode ------------------------
(***************************************************************************)
(* Code model: cancellation and settlement of durable recipient intake as  *)
(* the code at commit 66739e07 implements it, derived from                 *)
(*   packages/sdk/src/orchestration_1_0_83/intake-machine.ts (01e58de6)    *)
(*   packages/sdk/src/orchestration_1_0_83/intake-state.ts   (b8d11c9e)    *)
(*   packages/sdk/src/workflow/v2/intake-activities.ts       (c89407f3)    *)
(*   packages/sdk/src/workflow/v2/store.ts (the intake claim, bind, end,    *)
(*   cancel_held, cancel_unsent and request_cancel transactions)            *)
(* and mapped to the intent model RecipientIntakeSpec at the end.          *)
(*                                                                         *)
(* The machine is pure and NOTHING CALLS IT at 66739e07: the drain, sweep, *)
(* decide and turn wiring is a later slice. This model therefore keeps     *)
(* two things apart:                                                       *)
(*  - the pure machine's behavior (each function's guard and result), and  *)
(*  - assumptions about the FUTURE wiring, named as constants:             *)
(*      Wiring = "serialized": each store write's call and its answer are  *)
(*        one step; nothing latches between them.                          *)
(*      Wiring = "concurrent": a hypothetical caller that lets the session *)
(*        latch a tombstone while the invocation's cancel write or its end *)
(*        is in flight, and reports the answer to the machine as it is.    *)
(*      LatchFirst: decide calls latchIntakeCancels before it forms or     *)
(*        carries (the module's stated precondition, intake-machine.ts     *)
(*        586-593, 683-687).                                               *)
(*    A violation that needs Wiring = "concurrent" or ~LatchFirst is about *)
(*    an unwired hypothetical caller, not a shipped defect.                *)
(*                                                                         *)
(* Abstractions: retry due times are dropped (the wake may make any due   *)
(* write at any time); a write that fails before any commit is a stutter   *)
(* and is omitted; capacity and size refusals are out of scope (caps are   *)
(* never reached with these bounds); attempt results are the "stopped",    *)
(* "gate", "retrying" and "result" rows with a witness (no hydration, no   *)
(* exhausted or credential failure).                                       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Ex, ForgedEx, ForgedCid, TombCap, Wiring, LatchFirst

ASSUME TombCap \in Nat \ {0}
ASSUME Wiring \in {"serialized", "concurrent"}
ASSUME LatchFirst \in BOOLEAN

HasForged == ForgedEx \in Ex
Outs == {"none", "completed", "interrupted", "not_dispatched"}

VARIABLES
    tombs,
    q,        \* genuine copy: "none", "inflight" (claim call), "unclaimed",
              \* "settling", "held", "item" (invocation item), "gone"
    ucan,     \* IntakeUnclaimedEntry.cancel
    hcan,     \* IntakeHeldEntry.cancel
    fq,       \* the forged copy: "absent", "inflight", "unclaimed", "done"
    fcan,     \* its unclaimed entry's cancel
    ist,      \* invocation: "none", "unbound", "bound"
    items,    \* IntakeInvocation.items (by exchange)
    cr,       \* IntakeInvocationItem.cancelRequested
    isent, iparked,
    iset,     \* IntakeInvocation.settle.outcome, or "none"
    cw,       \* IntakeInvocation.cancelWrite # null
    bm,       \* store: the ACTIVE invocation's membership, written by its first
              \* bind; each Form starts a new invocation id with none (one
              \* active slot; sequential invocations are distinct ids)
    flight,   \* Wiring "concurrent" only: "none", "cancel_inv", "end"
    fsnap,    \* the in-flight call's items
    fkind,    \* the in-flight cancel call's kind: "unsent" or "requested"
    fflag,    \* the in-flight end call's cancelRequested items
    broken,   \* an IntakeInvariantError was thrown: the execution failed
    row, proc, creq,
    pend,     \* ghost: items latched and not yet answered by a cancel write
    glatch, carried, sentEver, sawOwn, unsentLatch, badCarry, lastAct

invV   == <<ist, items, cr, isent, iparked, iset, cw, pend>>
flyV   == <<flight, fsnap, fkind, fflag>>
storeV == <<row, proc, creq, bm>>
ghostV == <<glatch, carried, sentEver, sawOwn, unsentLatch, badCarry>>
cvars  == <<tombs, q, ucan, hcan, fq, fcan, invV, flyV, broken, storeV, ghostV,
            lastAct>>

TypeOK_C ==
    /\ tombs \subseteq Ex /\ Cardinality(tombs) <= TombCap
    /\ q \in [Ex -> {"none", "inflight", "unclaimed", "settling", "held", "item", "gone"}]
    /\ ucan \in [Ex -> BOOLEAN] /\ hcan \in [Ex -> BOOLEAN]
    /\ fq \in {"absent", "inflight", "unclaimed", "done"} /\ fcan \in BOOLEAN
    /\ ist \in {"none", "unbound", "bound"} /\ items \subseteq Ex
    /\ cr \in [Ex -> BOOLEAN] /\ isent \in BOOLEAN /\ iparked \in BOOLEAN
    /\ iset \in Outs /\ cw \in BOOLEAN /\ bm \subseteq Ex /\ pend \subseteq Ex
    /\ flight \in {"none", "cancel_inv", "end"} /\ fsnap \subseteq Ex
    /\ fkind \in {"unsent", "requested"} /\ fflag \subseteq Ex
    /\ broken \in BOOLEAN
    /\ row \in [Ex -> {"none", "holding", "admitted", "cancelled"}]
    /\ proc \in [Ex -> {"none", "bound", "not_dispatched", "nd_cancelled",
                        "completed", "interrupted"}]
    /\ creq \in [Ex -> BOOLEAN]

Init ==
    /\ tombs = {}
    /\ q = [e \in Ex |-> "none"] /\ ucan = [e \in Ex |-> FALSE]
    /\ hcan = [e \in Ex |-> FALSE]
    /\ fq = "absent" /\ fcan = FALSE
    /\ ist = "none" /\ items = {} /\ cr = [e \in Ex |-> FALSE]
    /\ isent = FALSE /\ iparked = FALSE /\ iset = "none" /\ cw = FALSE
    /\ bm = {} /\ pend = {}
    /\ flight = "none" /\ fsnap = {} /\ fkind = "unsent" /\ fflag = {}
    /\ broken = FALSE
    /\ row = [e \in Ex |-> "none"] /\ proc = [e \in Ex |-> "none"]
    /\ creq = [e \in Ex |-> FALSE]
    /\ glatch = [e \in Ex |-> FALSE] /\ carried = [e \in Ex |-> FALSE]
    /\ sentEver = [e \in Ex |-> FALSE] /\ sawOwn = [e \in Ex |-> FALSE]
    /\ unsentLatch = [e \in Ex |-> FALSE] /\ badCarry = [e \in Ex |-> FALSE]
    /\ lastAct = "init"

Live == ~broken
Quiet == flight = "none"     \* the orchestration is not awaiting a split call

-----------------------------------------------------------------------------
(* Environment.                                                            *)

TombArrive(c) ==
    /\ c \notin tombs /\ Cardinality(tombs) < TombCap
    /\ tombs' = tombs \cup {c} /\ lastAct' = "env"
    /\ UNCHANGED <<q, ucan, hcan, fq, fcan, invV, flyV, broken, storeV, ghostV>>

TombDrop(c) ==
    /\ c \in tombs
    /\ tombs' = tombs \ {c} /\ lastAct' = "env"
    /\ UNCHANGED <<q, ucan, hcan, fq, fcan, invV, flyV, broken, storeV, ghostV>>

Arrive(e) ==
    /\ Live /\ Quiet /\ q[e] = "none"
    /\ q' = [q EXCEPT ![e] = "inflight"] /\ lastAct' = "decide"
    /\ UNCHANGED <<tombs, ucan, hcan, fq, fcan, invV, flyV, broken, storeV, ghostV>>

ArriveForged ==
    /\ Live /\ Quiet /\ HasForged /\ fq = "absent"
    /\ fq' = "inflight" /\ lastAct' = "decide"
    /\ UNCHANGED <<tombs, q, ucan, hcan, fcan, invV, flyV, broken, storeV, ghostV>>

-----------------------------------------------------------------------------
(* Claim: applyIntakeClaim (intake-machine.ts 442-495). The store answers  *)
(* accepted for a new or its own holding row (5.2).                         *)

ClaimAct(e) == IF q[e] = "inflight" THEN "decide" ELSE "wake"

(* Accepted and answered. `inherited` is a waiting unclaimed copy of the   *)
(* same message (exchange and canonical id) with its cancel latched: here *)
(* the copy's own entry (no genuine duplicates in scope).                   *)
ClaimOk(e) ==
    /\ Live /\ Quiet /\ q[e] \in {"inflight", "unclaimed"}
    /\ row' = [row EXCEPT ![e] = IF @ = "none" THEN "holding" ELSE @]
    /\ LET inherited == q[e] = "unclaimed" /\ ucan[e]
       IN IF inherited \/ e \in tombs
            THEN /\ q' = [q EXCEPT ![e] = "settling"]
                 /\ glatch' = [glatch EXCEPT ![e] = TRUE]
                 /\ sawOwn' = [sawOwn EXCEPT ![e] = IF inherited THEN @ ELSE TRUE]
                 /\ unsentLatch' = [unsentLatch EXCEPT ![e] = TRUE]
            ELSE /\ q' = [q EXCEPT ![e] = "held"]
                 /\ UNCHANGED <<glatch, sawOwn, unsentLatch>>
    /\ ucan' = [ucan EXCEPT ![e] = FALSE]
    /\ hcan' = [hcan EXCEPT ![e] = FALSE]
    /\ lastAct' = ClaimAct(e)
    /\ UNCHANGED <<tombs, fq, fcan, invV, flyV, broken, proc, creq, bm, carried,
                   sentEver, badCarry>>

(* The activity threw after committing (lost answer) or with nothing       *)
(* committed: keepUnclaimed (398-412) latches the copy's cancel when a     *)
(* tombstone names its canonical id now.                                   *)
ClaimNoAnswer(e, committed) ==
    /\ Live /\ Quiet /\ q[e] \in {"inflight", "unclaimed"}
    /\ row' = IF committed /\ row[e] = "none"
                THEN [row EXCEPT ![e] = "holding"] ELSE row
    /\ LET newly == e \in tombs /\ ~(q[e] = "unclaimed" /\ ucan[e])
       IN /\ ucan' = [ucan EXCEPT ![e] = (q[e] = "unclaimed" /\ @) \/ e \in tombs]
          /\ glatch' = IF newly THEN [glatch EXCEPT ![e] = TRUE] ELSE glatch
          /\ sawOwn' = IF newly THEN [sawOwn EXCEPT ![e] = TRUE] ELSE sawOwn
          /\ unsentLatch' = IF newly THEN [unsentLatch EXCEPT ![e] = TRUE] ELSE unsentLatch
    /\ q' = [q EXCEPT ![e] = "unclaimed"]
    /\ lastAct' = ClaimAct(e)
    /\ UNCHANGED <<tombs, hcan, fq, fcan, invV, flyV, broken, proc, creq, bm,
                   carried, sentEver, badCarry>>

(* The forged copy: unverified (passOn latches only copies with ITS         *)
(* exchange and client id, 455-456: no genuine copy), or a failed claim.    *)
ForgedClaim(answered) ==
    /\ Live /\ Quiet /\ fq \in {"inflight", "unclaimed"}
    /\ fq' = IF answered THEN "done" ELSE "unclaimed"
    /\ fcan' = IF answered THEN fcan
               ELSE (fq = "unclaimed" /\ fcan) \/ ForgedCid \in tombs
    /\ lastAct' = IF fq = "inflight" THEN "decide" ELSE "wake"
    /\ UNCHANGED <<tombs, q, ucan, hcan, invV, flyV, broken, storeV, ghostV>>

-----------------------------------------------------------------------------
(* latchIntakeCancels / latchCopies (526-563): every copy a current         *)
(* tombstone names, at once. Under Wiring "concurrent" it may run while a   *)
(* split call is in flight.                                                 *)

InvLatchable == ist # "none" /\ ~(ist = "bound" /\ ~isent /\ iset # "none")

NewU == {e \in Ex : q[e] = "unclaimed" /\ ~ucan[e] /\ e \in tombs}
NewH == {e \in Ex : q[e] = "held" /\ ~hcan[e] /\ e \in tombs}
NewI == IF InvLatchable THEN {e \in items : ~cr[e] /\ e \in tombs} ELSE {}
NewF == HasForged /\ fq = "unclaimed" /\ ~fcan /\ ForgedCid \in tombs

LatchCancels ==
    /\ Live /\ (Wiring = "serialized" => Quiet)
    /\ NewU \cup NewH \cup NewI # {} \/ NewF
    /\ ucan' = [e \in Ex |-> ucan[e] \/ e \in NewU]
    /\ hcan' = [e \in Ex |-> hcan[e] \/ e \in NewH]
    /\ cr' = [e \in Ex |-> cr[e] \/ e \in NewI]
    /\ cw' = IF NewI # {} THEN ist = "bound" ELSE cw
    /\ pend' = pend \cup NewI
    /\ fcan' = (fcan \/ NewF)
    /\ LET N == NewU \cup NewH \cup NewI
       IN /\ glatch' = [e \in Ex |-> glatch[e] \/ e \in N]
          /\ sawOwn' = [e \in Ex |-> sawOwn[e] \/ e \in N]
          /\ unsentLatch' = [e \in Ex |-> IF e \in N
                                         THEN ~(e \in items /\ isent)
                                         ELSE unsentLatch[e]]
    /\ lastAct' = "decide"
    /\ UNCHANGED <<tombs, q, fq, ist, items, isent, iparked, iset, flyV, broken,
                   storeV, carried, sentEver, badCarry>>

-----------------------------------------------------------------------------
(* The wake's store writes (intakeDueWork, 614-640): store-only.           *)

(* A settling entry's holder settle (cancelled): applyIntakeHolderSettle.  *)
HolderSettle(e, answered) ==
    /\ Live /\ Quiet /\ q[e] = "settling"
    /\ row' = [row EXCEPT ![e] = IF @ = "holding" THEN "cancelled" ELSE @]
    /\ q' = IF answered THEN [q EXCEPT ![e] = "gone"] ELSE q
    /\ lastAct' = "wake"
    /\ UNCHANGED <<tombs, ucan, hcan, fq, fcan, invV, flyV, broken, proc, creq,
                   bm, ghostV>>

(* The latched held cancels as one write (cancel_held), item by item; the  *)
(* answer names its items (applyIntakeHeldCancelled 658-662).              *)
HeldLatched == {e \in Ex : q[e] = "held" /\ hcan[e]}

HeldCancel(C, answered) ==
    /\ Live /\ Quiet /\ HeldLatched # {} /\ C \subseteq HeldLatched /\ C # {}
    /\ answered => C = HeldLatched
    /\ row' = [e \in Ex |-> IF e \in C /\ row[e] = "holding" THEN "cancelled" ELSE row[e]]
    /\ q' = IF answered THEN [e \in Ex |-> IF e \in HeldLatched THEN "gone" ELSE q[e]]
            ELSE q
    /\ lastAct' = "wake"
    /\ UNCHANGED <<tombs, ucan, hcan, fq, fcan, invV, flyV, broken, proc, creq,
                   bm, ghostV>>

-----------------------------------------------------------------------------
(* The invocation (formIntakeInvocation, the bind, carry, attempts).        *)

FormSet == {e \in Ex : q[e] = "held" /\ ~hcan[e]}

Form ==
    /\ Live /\ Quiet /\ ist = "none" /\ FormSet # {}
    /\ LatchFirst => \A e \in FormSet : e \notin tombs
    /\ ist' = "unbound" /\ items' = FormSet
    /\ cr' = [e \in Ex |-> FALSE] /\ isent' = FALSE /\ iparked' = FALSE
    /\ iset' = "none" /\ cw' = FALSE /\ pend' = {}
    /\ bm' = {}
    /\ q' = [e \in Ex |-> IF e \in FormSet THEN "item" ELSE q[e]]
    /\ lastAct' = "decide"
    /\ UNCHANGED <<tombs, ucan, hcan, fq, fcan, flyV, broken, row, proc, creq,
                   ghostV>>

(* bindWorkflowIntake, then applyIntakeBound (726-754): a cancel latched    *)
(* before the bind has its cancel write due once bound.                     *)
Bind(answered) ==
    /\ Live /\ Quiet /\ ist = "unbound"
    /\ row' = [e \in Ex |-> IF e \in items /\ row[e] = "holding" THEN "admitted" ELSE row[e]]
    /\ proc' = [e \in Ex |-> IF e \in items /\ proc[e] = "none" THEN "bound" ELSE proc[e]]
    /\ bm' = IF bm = {} THEN items ELSE bm
    /\ IF answered
         THEN /\ ist' = "bound"
              /\ cw' = (\E e \in items : cr[e])
         ELSE UNCHANGED <<ist, cw>>
    /\ lastAct' = "wake"
    /\ UNCHANGED <<tombs, q, ucan, hcan, fq, fcan, items, cr, isent, iparked, iset,
                   pend, flyV, broken, creq, ghostV>>

(* carryIntakeInvocation (812-840) and applyIntakeAttempt (931-961) in one *)
(* step: the orchestration awaits the turn between them, so no carried     *)
(* state changes in between. A parked invocation rides only a resume       *)
(* stimulus, which this step stands for. w: the witness's sent.            *)
Attempt(w, r) ==
    /\ Live /\ Quiet /\ ist = "bound" /\ iset = "none" /\ items # {}
    /\ ~isent => \A e \in items : ~cr[e]
    /\ LatchFirst => (~isent => \A e \in items : e \notin tombs)
    /\ LET s == isent \/ w
           o == IF r = "retrying" THEN "none"
                ELSE IF r = "result" /\ w THEN "completed"
                ELSE IF s THEN "interrupted"
                ELSE IF r = "stopped" THEN "not_dispatched"
                ELSE "none"
       IN /\ isent' = s /\ iset' = o
          /\ iparked' = (r \in {"result", "gate"} /\ ~s)
          /\ sentEver' = [e \in Ex |-> sentEver[e] \/ (e \in items /\ s)]
    /\ carried' = [e \in Ex |-> carried[e] \/ e \in items]
    /\ badCarry' = [e \in Ex |-> badCarry[e] \/ (e \in items /\ unsentLatch[e])]
    /\ lastAct' = "turn"
    /\ UNCHANGED <<tombs, q, ucan, hcan, fq, fcan, ist, items, cr, cw, pend, flyV,
                   broken, storeV, glatch, sawOwn, unsentLatch>>

-----------------------------------------------------------------------------
(* The invocation's cancel write (intakeInvocationCancelCall 1028-1045,    *)
(* applyIntakeInvocationCancelled 1047-1057; store cancel_unsent,           *)
(* request_cancel, item by item).                                           *)

CancelItems == {e \in items : cr[e]}

(* Store effect of a cancel write of kind k for the committed items C;     *)
(* a precondition the store checks fails as a broken invariant.            *)
StoreCancel(k, C) ==
    /\ proc' = [e \in Ex |-> IF k = "unsent" /\ e \in C /\ proc[e] = "bound"
                               THEN "nd_cancelled" ELSE proc[e]]
    /\ creq' = [e \in Ex |-> creq[e] \/ (k = "requested" /\ e \in C)]
    /\ broken' = (broken \/ \E e \in C : row[e] # "admitted" \/ e \notin bm
                          \/ (k = "unsent" /\ proc[e] \notin {"bound", "nd_cancelled"}))

(* The machine's answer: it clears every item latched NOW.                 *)
AfterCancelAnswer ==
    /\ pend' = {}
    /\ IF isent
      THEN /\ cw' = FALSE
           /\ UNCHANGED <<items, iset, iparked, q>>
      ELSE /\ cw' = FALSE
           /\ items' = items \ CancelItems
           /\ q' = [e \in Ex |-> IF e \in CancelItems THEN "gone" ELSE q[e]]
           /\ IF items \subseteq CancelItems
                THEN iset' = "not_dispatched" /\ iparked' = FALSE
                ELSE UNCHANGED <<iset, iparked>>

(* Wiring "serialized": call and answer in one step.                       *)
InvCancel(C, answered) ==
    /\ Live /\ Quiet /\ Wiring = "serialized"
    /\ ist = "bound" /\ cw /\ C \subseteq CancelItems /\ C # {}
    /\ answered => C = CancelItems
    /\ StoreCancel(IF isent THEN "requested" ELSE "unsent", C)
    /\ IF answered THEN AfterCancelAnswer ELSE UNCHANGED <<cw, pend, items, iset, iparked, q>>
    /\ lastAct' = "wake"
    /\ UNCHANGED <<tombs, ucan, hcan, fq, fcan, ist, cr, isent, flyV, row, bm, ghostV>>

(* Wiring "concurrent": the call, then the answer, with latches between.  *)
InvCancelCall ==
    /\ Live /\ Quiet /\ Wiring = "concurrent"
    /\ ist = "bound" /\ cw
    /\ flight' = "cancel_inv" /\ fsnap' = CancelItems
    /\ fkind' = IF isent THEN "requested" ELSE "unsent"
    /\ UNCHANGED <<tombs, q, ucan, hcan, fq, fcan, invV, fflag, broken, storeV,
                   ghostV, lastAct>>

InvCancelAnswer(C, answered) ==
    /\ Live /\ flight = "cancel_inv" /\ C \subseteq fsnap
    /\ answered => C = fsnap
    /\ C # {} \/ ~answered
    /\ StoreCancel(fkind, C)
    /\ IF answered THEN AfterCancelAnswer ELSE UNCHANGED <<cw, pend, items, iset, iparked, q>>
    /\ flight' = "none"
    /\ lastAct' = IF C = {} /\ ~answered THEN lastAct ELSE "wake"
    /\ UNCHANGED <<tombs, ucan, hcan, fq, fcan, ist, cr, isent, fsnap, fkind,
                   fflag, row, bm, ghostV>>

-----------------------------------------------------------------------------
(* The end (intakeEndCall 979-994, applyIntakeEnded 996-1002; the store's  *)
(* endWorkflowIntake). The machine refuses to report an end while a cancel *)
(* write is pending (endingInvocation 963-977).                             *)

(* The store's end with outcome iset for the named items N with flags F.   *)
StoreEndEff(N, F) ==
    /\ proc' = [e \in Ex |-> IF e \in N /\ proc[e] = "bound" THEN iset ELSE proc[e]]
    /\ creq' = [e \in Ex |-> creq[e] \/ (e \in N /\ e \in F /\ proc[e] = "bound")]
StoreEndBroken(N, F) ==
    \/ \E m \in bm : proc[m] # "nd_cancelled" /\ m \notin N
    \/ \E e \in N : e \in F /\ proc[e] = iset /\ ~creq[e]

AfterEndAnswer ==
    /\ ist' = "none" /\ items' = {} /\ cr' = [e \in Ex |-> FALSE]
    /\ isent' = FALSE /\ iparked' = FALSE /\ iset' = "none" /\ cw' = FALSE
    /\ pend' = {}
    /\ q' = [e \in Ex |-> IF e \in items THEN "gone" ELSE q[e]]

EndWrite(answered) ==
    /\ Live /\ Quiet /\ Wiring = "serialized"
    /\ ist = "bound" /\ iset # "none" /\ ~cw
    /\ StoreEndEff(items, CancelItems)
    /\ broken' = (broken \/ StoreEndBroken(items, CancelItems))
    /\ IF answered THEN AfterEndAnswer ELSE UNCHANGED <<invV, q>>
    /\ lastAct' = IF items = {} THEN lastAct ELSE "wake"
    /\ UNCHANGED <<tombs, ucan, hcan, fq, fcan, flyV, row, bm, ghostV>>

EndCall ==
    /\ Live /\ Quiet /\ Wiring = "concurrent"
    /\ ist = "bound" /\ iset # "none" /\ ~cw
    /\ flight' = "end" /\ fsnap' = items /\ fflag' = CancelItems
    /\ UNCHANGED <<tombs, q, ucan, hcan, fq, fcan, invV, fkind, broken, storeV,
                   ghostV, lastAct>>

(* The answer (committed; answered or lost). Answered with no cancel       *)
(* latched while in flight: the invocation is cleared.                     *)
EndAnswer(answered) ==
    /\ Live /\ flight = "end" /\ (answered => ~cw)
    /\ StoreEndEff(fsnap, fflag)
    /\ broken' = (broken \/ StoreEndBroken(fsnap, fflag))
    /\ IF answered THEN AfterEndAnswer ELSE UNCHANGED <<invV, q>>
    /\ flight' = "none"
    /\ lastAct' = IF fsnap = {} THEN lastAct ELSE "wake"
    /\ UNCHANGED <<tombs, ucan, hcan, fq, fcan, fsnap, fkind, fflag, row, bm,
                   ghostV>>

(* Answered while a cancel was latched in flight: applyIntakeEnded throws  *)
(* (endingInvocation); the store's end has committed. Concurrent caller   *)
(* only. Its store commit does NOT refine: a cancel latched in flight is  *)
(* owed (cw), and the intent end waits for it. The throw (broken) has no  *)
(* intent image.                                                           *)
EndAnswerThrows ==
    /\ Live /\ flight = "end" /\ cw
    /\ StoreEndEff(fsnap, fflag)
    /\ broken' = TRUE /\ flight' = "none"
    /\ lastAct' = IF fsnap = {} THEN lastAct ELSE "wake"
    /\ UNCHANGED <<tombs, q, ucan, hcan, fq, fcan, invV, fsnap, fkind, fflag,
                   row, bm, ghostV>>

-----------------------------------------------------------------------------
CNext ==
    \/ \E c \in Ex : TombArrive(c) \/ TombDrop(c)
    \/ \E e \in Ex :
          \/ Arrive(e) \/ ClaimOk(e)
          \/ \E b \in BOOLEAN : ClaimNoAnswer(e, b) \/ HolderSettle(e, b)
    \/ ArriveForged \/ \E b \in BOOLEAN : ForgedClaim(b)
    \/ LatchCancels
    \/ \E C \in SUBSET Ex, b \in BOOLEAN :
          HeldCancel(C, b) \/ InvCancel(C, b) \/ InvCancelAnswer(C, b)
    \/ Form \/ InvCancelCall \/ EndCall \/ EndAnswerThrows
    \/ \E b \in BOOLEAN : Bind(b) \/ EndWrite(b) \/ EndAnswer(b)
    \/ \E w \in BOOLEAN, r \in {"stopped", "gate", "retrying", "result"} : Attempt(w, r)

CSpec == Init /\ [][CNext]_cvars

(* A-STORE for the code: every due write eventually succeeds and is       *)
(* answered. No fairness on attempts, arrivals or stimuli.                 *)
CFairness ==
    /\ \A e \in Ex : WF_cvars(ClaimOk(e)) /\ WF_cvars(HolderSettle(e, TRUE))
    /\ WF_cvars(\E C \in SUBSET Ex : HeldCancel(C, TRUE))
    /\ WF_cvars(\E C \in SUBSET Ex : InvCancel(C, TRUE))
    /\ WF_cvars(Bind(TRUE)) /\ WF_cvars(EndWrite(TRUE))

CLiveSpec == CSpec /\ CFairness

(* No fault of the machine or the store is hit (no IntakeInvariantError).  *)
Inv_C_NotBroken == ~broken

-----------------------------------------------------------------------------
(* Refinement mapping to the intent model.                                 *)
(*   TombArrive/TombDrop -> same; Arrive, ArriveForged -> same;            *)
(*   ClaimOk -> ClaimOk; ClaimNoAnswer -> ClaimNoAck (latching in the same  *)
(*   step); ForgedClaim -> ForgedClaim (latching in the same step);        *)
(*   LatchCancels -> LatchBy (one                                           *)
(*   tombstone at a time: TombCap = 1); HolderSettle, HeldCancel,           *)
(*   InvCancel, InvCancelAnswer -> CancelWrites; Form -> Form; Bind ->     *)
(*   BindWrite; Attempt -> Attempt; EndWrite, EndAnswer -> EndWrite (an     *)
(*   end of an empty batch is a stutter); InvCancelCall, EndCall -> stutter *)
(*   (internal). EndAnswerThrows (Wiring "concurrent" only) commits the    *)
(*   store's end while a cancel is owed: no intent step; it is expected to *)
(*   break Refines, as InvCancelAnswer clearing an unwritten latch is.      *)

MapLoc(e) ==
    CASE q[e] = "none" -> "absent"
      [] q[e] = "item" -> "inv"
      [] q[e] = "gone" -> "done"
      [] OTHER -> q[e]

MapOwed(e) ==
    CASE q[e] = "held" /\ hcan[e] -> "cancel"
      [] q[e] = "settling" -> "cancel"
      [] q[e] = "item" /\ e \in pend -> IF isent THEN "creq" ELSE "nd"
      [] OTHER -> "none"

MapInv ==
    IF ist = "none" \/ items = {}
      THEN [st |-> "none", mem |-> {}, sent |-> FALSE, parked |-> FALSE, out |-> "none"]
      ELSE [st |-> IF ist = "unbound" THEN "formed" ELSE "bound",
            mem |-> items, sent |-> isent, parked |-> iparked, out |-> iset]

A == INSTANCE RecipientIntakeSpec WITH
        Ex <- Ex, ForgedEx <- ForgedEx, ForgedCid <- ForgedCid,
        TombCap <- TombCap, Fault <- "none",
        tombs <- tombs,
        loc <- [e \in Ex |-> MapLoc(e)],
        latch <- glatch,
        owed <- [e \in Ex |-> MapOwed(e)],
        floc <- fq, flatch <- fcan,
        inv <- MapInv,
        row <- row, proc <- proc, creq <- creq,
        carried <- carried, sentEver <- sentEver, sawOwn <- sawOwn,
        unsentLatch <- unsentLatch, badCarry <- badCarry,
        lastAct <- lastAct

(* Safety refinement obligation: every behavior of the code model, mapped, *)
(* is a behavior of the intent model.                                       *)
Refines == A!Spec

(* The intent invariants on the mapped state.                              *)
Inv_Mapped ==
    /\ A!TypeOK /\ A!Inv_LatchOwnId /\ A!Inv_StoreCancelLatched
    /\ A!Inv_DoneLatchedRecorded /\ A!Inv_NoCarryAfterUnsentLatch
    /\ A!Inv_TruthfulNotDispatched
Inv_Mapped_DoneLatchedRecorded == A!Inv_DoneLatchedRecorded

(* Liveness, mapped: a latched cancel is recorded with no turn.            *)
Live_LatchRecorded == A!Live_LatchRecorded

-----------------------------------------------------------------------------
(* Positive controls: EXPECTED to be violated (reachable).                 *)
Wit_C_UnsentCancelWritten == ~(\E e \in Ex : proc[e] = "nd_cancelled")
Wit_C_SentCancelThenEnd ==
    ~(\E e \in Ex : creq[e] /\ proc[e] \in {"completed", "interrupted"})
Wit_C_HeldCancelBoth == ~(\A e \in Ex : row[e] = "cancelled")
Wit_C_LatchedUnclaimedSettled ==
    ~(\E e \in Ex : row[e] = "cancelled" /\ ~carried[e] /\ e \notin tombs)

=============================================================================
