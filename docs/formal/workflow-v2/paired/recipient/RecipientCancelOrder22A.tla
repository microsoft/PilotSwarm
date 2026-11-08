-------------------- MODULE RecipientCancelOrder22A --------------------
(***************************************************************************)
(* The cancel branches of orchestration 1.0.83 at the corrective           *)
(* checkpoint 22a66ef747db3ba1e7b8320fd96d87f6329dbf6c (tree 01ca1f78),    *)
(* derived from that source separately from the b92ff04b model            *)
(* (RecipientCancelOrderB92 r2, kept unchanged as the negative control).  *)
(* Same base code model, obligation, predicate, environment constants and *)
(* bounds; only the cancel branch differs.                                 *)
(*                                                                         *)
(* Source at 22a66ef7 (packages/sdk/src/orchestration_1_0_83/), on a       *)
(* message with cancelPending, drain (queue.ts 850-878) and sweep          *)
(* (1220-1239):                                                            *)
(*    1. latchIntakeTombstones(runtime, validCancelIds) (queue.ts 861,     *)
(*       1225; intake-wiring.ts cancelCheck): every intake copy named by   *)
(*       an id of the cancel set OR of this message is latched, first;    *)
(*    2. addCancelledMessageIds (862, 1226; state.ts 486-494, unchanged):  *)
(*       add, evicting the oldest beyond 200;                              *)
(*    3. stashed prompts whose ids meet this pass's (drain) or this        *)
(*       message's (sweep) cancels are dropped with dropCancelledPrompt    *)
(*       (872, 1235; lifecycle.ts 414-421, unchanged), which deletes their *)
(*       ids from the set and touches them into the recent window.         *)
(*    No latch after the drop (the b92ff04b late latch is removed).        *)
(*  queue.ts 982-990: drain-incoming consumption and duplicates, as at     *)
(*    b92ff04b (window touched on consumption).                            *)
(*  queue.ts 904 and intake-wiring.ts 277: the intake path ignores the     *)
(*    window; a held copy's canonical id enters it.                        *)
(*  The wake's one-call-per-wake and race-first changes (P2-3) and the    *)
(*  non-retryable marking (P2-2) do not change any modeled transition:    *)
(*  the model already makes one store write per step at any time.          *)
(*                                                                         *)
(* Environment assumptions as in RecipientCancelOrderB92: E-ID            *)
(* (AllowOrdinary), E-BIG (AllowBig, abstracted), E-WIN (AllowForget),     *)
(* E-PASS (DrainEnd). One thing at a time: while an arrival's claim is     *)
(* awaited only its answer happens (NoClaimInFlight). No instance          *)
(* definition is primed (codeV).                                           *)
(* Not modeled, as before: forming and carrying (WithInvocation = FALSE),  *)
(* dropConvertedMessages, FIFO prompts consumed by decide, a second        *)
(* ordinary prompt with the same id in a later pass after dispatch.        *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Ex, ForgedEx, ForgedCid, AllowOrdinary, AllowBig, AllowForget, WithInvocation

ASSUME AllowOrdinary \in BOOLEAN /\ AllowBig \in BOOLEAN
ASSUME AllowForget \in BOOLEAN /\ WithInvocation \in BOOLEAN

VARIABLES
    tombs, q, ucan, hcan, fq, fcan, ist, items, cr, isent, iparked, iset, cw,
    bm, flight, fsnap, fkind, fflag, broken, row, proc, creq,
    pend, glatch, carried, sentEver, sawOwn, unsentLatch, badCarry, lastAct,
    window,    \* recentClientMessageIds (the canonical ids of held copies)
    pendIds,   \* ordinary prompt ids pending in this drain pass
    ordStash,  \* client ids of ordinary prompts stashed in this pass
    passCan,   \* cancelledThisDrain
    stage,     \* the cancel branch: "idle", "latched", "added"
    cur,       \* the id of the cancel message being handled
    lost,      \* ghost: a tombstone left while this genuine copy, named by
               \* it, was latchable and not latched
    flost      \* ghost: the same for the forged copy

C == INSTANCE RecipientIntakeCode WITH TombCap <- 2, Wiring <- "serialized", LatchFirst <- TRUE

(* The code model's variables, listed here as this module's own variables. *)
(* Revision r2: the first run (TLC 2.19) stopped with "the identifier      *)
(* tombs is either undefined or not an operator" while evaluating          *)
(* UNCHANGED <<C!cvars, ...>> (DrainEnd), i.e. the primed instance         *)
(* definition C!cvars. Unprimed instance expressions (C!Live) and the      *)
(* instance's own actions (C!Arrive, C!ClaimOk, ...) evaluated in the same *)
(* run. This module no longer primes any instance definition: every        *)
(* UNCHANGED and the stuttering subscript name these variables directly.   *)
codeV == <<tombs, q, ucan, hcan, fq, fcan, ist, items, cr, isent, iparked, iset,
           cw, pend, bm, flight, fsnap, fkind, fflag, broken, row, proc, creq,
           glatch, carried, sentEver, sawOwn, unsentLatch, badCarry, lastAct>>
newV == <<window, pendIds, ordStash, passCan, stage, cur, lost, flost>>
allV == <<codeV, newV>>

Idle == stage = "idle"

(* The orchestration does one thing at a time: while an arrival's claim  *)
(* activity is awaited, nothing else is dequeued and no other store write *)
(* is made; only that claim's answer is applied (revision r2, caveat C1:  *)
(* r1 let another arrival and other writes interleave).                    *)
NoClaimInFlight == (\A e \in Ex : q[e] # "inflight") /\ fq # "inflight"
Serial(e)       == NoClaimInFlight \/ q[e] = "inflight"
SerialForged    == NoClaimInFlight \/ fq = "inflight"

(* A copy that an id x names, present, latchable and not latched.          *)
OpenGen(x) ==
    \/ q[x] = "unclaimed" /\ ~ucan[x]
    \/ q[x] = "held" /\ ~hcan[x]
    \/ q[x] = "item" /\ ~cr[x] /\ C!InvLatchable
OpenForged(x) == C!HasForged /\ ForgedCid = x /\ fq = "unclaimed" /\ ~fcan

(* The ghosts for the ids L that leave the set (or never stay in it).      *)
LostFor(L) ==
    /\ lost' = [e \in Ex |-> lost[e] \/ (e \in L /\ OpenGen(e))]
    /\ flost' = (flost \/ \E x \in L : OpenForged(x))

Init ==
    /\ C!Init
    /\ window = {} /\ pendIds = {} /\ ordStash = {} /\ passCan = {}
    /\ stage = "idle" /\ cur = CHOOSE e \in Ex : TRUE
    /\ lost = [e \in Ex |-> FALSE] /\ flost = FALSE

-----------------------------------------------------------------------------
(* The intake store side, as in the code model, between messages.          *)

Keep == UNCHANGED newV

(* An accepted claim; a newly held copy's canonical id enters the window. *)
ClaimOkB(e) ==
    /\ Idle /\ C!ClaimOk(e)
    /\ window' = IF q'[e] = "held" THEN window \cup {e} ELSE window
    /\ UNCHANGED <<pendIds, ordStash, passCan, stage, cur, lost, flost>>

StoreNext ==
    /\ Idle
    /\ \/ \E e \in Ex : NoClaimInFlight /\ C!Arrive(e) /\ Keep
       \/ \E e \in Ex : Serial(e) /\ ClaimOkB(e)
       \/ \E e \in Ex, b \in BOOLEAN : Serial(e) /\ C!ClaimNoAnswer(e, b) /\ Keep
       \/ \E e \in Ex, b \in BOOLEAN : NoClaimInFlight /\ C!HolderSettle(e, b) /\ Keep
       \/ NoClaimInFlight /\ C!ArriveForged /\ Keep
       \/ \E b \in BOOLEAN : SerialForged /\ C!ForgedClaim(b) /\ Keep
       \/ \E S \in SUBSET Ex, b \in BOOLEAN : NoClaimInFlight /\ C!HeldCancel(S, b) /\ Keep
       \/ /\ WithInvocation /\ NoClaimInFlight
          /\ \/ C!Form
             \/ \E b \in BOOLEAN : C!Bind(b) \/ C!EndWrite(b)
             \/ \E S \in SUBSET Ex, b \in BOOLEAN : C!InvCancel(S, b)
             \/ \E w \in BOOLEAN, r \in {"stopped", "gate", "retrying", "result"} : C!Attempt(w, r)
          /\ Keep

-----------------------------------------------------------------------------
(* Ordinary prompts (queue.ts 982-990 at 22a66ef7), the window, the pass.  *)

OrdArrive(c) ==
    /\ Idle /\ NoClaimInFlight /\ AllowOrdinary /\ C!Live
    /\ IF c \in tombs
         THEN \* drain-incoming: dropped; dropCancelledPrompt consumes c and,
              \* revision r2 (caveat C2), touches it into the recent window
              /\ tombs' = tombs \ {c}
              /\ LostFor({c})
              /\ window' = window \cup {c}
              /\ UNCHANGED <<pendIds, ordStash, passCan, stage, cur>>
         ELSE \* a duplicate changes nothing and is not a step here
              /\ c \notin window \cup pendIds
              /\ ordStash' = ordStash \cup {c} /\ pendIds' = pendIds \cup {c}
              /\ UNCHANGED <<tombs, window, passCan, stage, cur, lost, flost>>
    /\ lastAct' = "env"
    /\ UNCHANGED <<q, ucan, hcan, fq, fcan, ist, items, cr, isent, iparked, iset,
                   cw, bm, flight, fsnap, fkind, fflag, broken, row, proc, creq,
                   pend, glatch, carried, sentEver, sawOwn, unsentLatch, badCarry>>

WindowForget(c) ==
    /\ Idle /\ AllowForget /\ c \in window
    /\ window' = window \ {c}
    /\ UNCHANGED <<codeV, pendIds, ordStash, passCan, stage, cur, lost, flost>>

DrainEnd ==
    /\ Idle /\ NoClaimInFlight /\ (ordStash # {} \/ passCan # {} \/ pendIds # {})
    /\ ordStash' = {} /\ passCan' = {} /\ pendIds' = {}
    /\ UNCHANGED <<codeV, window, stage, cur, lost, flost>>

-----------------------------------------------------------------------------
(* A message with cancelPending (queue.ts at 22a66ef7: 850-878, 1220-1239). *)

(* The copies an id set T names that are not latched: latchCopies with    *)
(* isCancelled = (in the cancel set) or (in this message), cancelCheck.   *)
NewUT(T) == {e \in Ex : q[e] = "unclaimed" /\ ~ucan[e] /\ e \in T}
NewHT(T) == {e \in Ex : q[e] = "held" /\ ~hcan[e] /\ e \in T}
NewIT(T) == IF C!InvLatchable THEN {e \in items : ~cr[e] /\ e \in T} ELSE {}
NewFT(T) == C!HasForged /\ fq = "unclaimed" /\ ~fcan /\ ForgedCid \in T

(* 1. latchIntakeTombstones(runtime, validCancelIds), first.               *)
CancelLatchFirst(c) ==
    /\ Idle /\ NoClaimInFlight /\ C!Live
    /\ LET T  == tombs \cup {c}
           NU == NewUT(T)
           NH == NewHT(T)
           NI == NewIT(T)
           N  == NU \cup NH \cup NI
       IN /\ ucan' = [e \in Ex |-> ucan[e] \/ e \in NU]
          /\ hcan' = [e \in Ex |-> hcan[e] \/ e \in NH]
          /\ cr' = [e \in Ex |-> cr[e] \/ e \in NI]
          /\ cw' = IF NI # {} THEN ist = "bound" ELSE cw
          /\ pend' = pend \cup NI
          /\ fcan' = (fcan \/ NewFT(T))
          /\ glatch' = [e \in Ex |-> glatch[e] \/ e \in N]
          /\ sawOwn' = [e \in Ex |-> sawOwn[e] \/ e \in N]
          /\ unsentLatch' = [e \in Ex |-> IF e \in N
                                         THEN ~(e \in items /\ isent)
                                         ELSE unsentLatch[e]]
    /\ cur' = c
    /\ stage' = "latched"
    /\ lastAct' = "decide"
    /\ UNCHANGED <<tombs, q, fq, ist, items, isent, iparked, iset, bm, flight,
                   fsnap, fkind, fflag, broken, row, proc, creq, carried,
                   sentEver, badCarry, window, pendIds, ordStash, passCan,
                   lost, flost>>

(* 2. addCancelledMessageIds for the message's id, with the abstracted    *)
(*    >200 case (as in RecipientCancelOrderB92).                            *)
CancelAdd(big, evictSelf, E) ==
    /\ stage = "latched"
    /\ big => AllowBig
    /\ ~big => (~evictSelf /\ E = {})
    /\ E \subseteq tombs \ {cur}
    /\ evictSelf => E = tombs \ {cur}
    /\ LET T == (tombs \ E) \ (IF evictSelf THEN {cur} ELSE {})
           T2 == IF evictSelf THEN T ELSE T \cup {cur}
       IN /\ tombs' = T2
          /\ LostFor(({cur} \cup tombs) \ T2)
    /\ passCan' = passCan \cup {cur}
    /\ stage' = "added"
    /\ lastAct' = "env"
    /\ UNCHANGED <<q, ucan, hcan, fq, fcan, ist, items, cr, isent, iparked, iset,
                   cw, bm, flight, fsnap, fkind, fflag, broken, row, proc, creq,
                   pend, glatch, carried, sentEver, sawOwn, unsentLatch, badCarry,
                   window, pendIds, ordStash, cur>>

(* 3. Stashed prompts whose ids meet this pass's cancels are dropped; their *)
(*    ids leave the set and enter the window. The branch ends.             *)
CancelConsume ==
    /\ stage = "added"
    /\ LET D == ordStash \cap passCan
       IN /\ tombs' = tombs \ D
          /\ ordStash' = ordStash \ D
          /\ LostFor(tombs \cap D)
          /\ window' = window \cup D
    /\ stage' = "idle"
    /\ UNCHANGED <<q, ucan, hcan, fq, fcan, ist, items, cr, isent, iparked, iset,
                   cw, bm, flight, fsnap, fkind, fflag, broken, row, proc, creq,
                   pend, glatch, carried, sentEver, sawOwn, unsentLatch, badCarry,
                   lastAct, pendIds, passCan, cur>>

-----------------------------------------------------------------------------
Next ==
    \/ StoreNext
    \/ \E c \in Ex : OrdArrive(c) \/ WindowForget(c)
    \/ \E c \in Ex : CancelLatchFirst(c)
    \/ \E big, ev \in BOOLEAN, E \in SUBSET Ex : CancelAdd(big, ev, E)
    \/ CancelConsume \/ DrainEnd

Spec == Init /\ [][Next]_allV

(* The code model's type and no-broken-invariant checks, on this module.   *)
TypeOK_C == C!TypeOK_C
Inv_C_NotBroken == ~broken

(* The intent's independent safety predicate (RecipientCancelOrderSpec).  *)
Inv_NoCancelLost == (\A e \in Ex : ~lost[e]) /\ ~flost

(* Positive control, EXPECTED to be violated: a cancel is latched on a     *)
(* held copy by the cancel branch.                                          *)
Wit_22ALatched == ~(\E e \in Ex : q[e] = "held" /\ hcan[e])

(* Positive control, EXPECTED to be violated: with E-ID, a cancel latched *)
(* first is then consumed by a stashed ordinary prompt of the same id.    *)
Wit_22ALatchedThenConsumed ==
    ~(\E e \in Ex : q[e] = "held" /\ hcan[e] /\ e \notin tombs /\ e \in window
                    /\ e \notin ordStash /\ stage = "idle" /\ e \in passCan)

=============================================================================
