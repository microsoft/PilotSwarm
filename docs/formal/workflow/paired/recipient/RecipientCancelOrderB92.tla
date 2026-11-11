-------------------- MODULE RecipientCancelOrderB92 --------------------
(***************************************************************************)
(* The cancel branches of orchestration 1.0.83 at b92ff04b, in their real  *)
(* order, over the recipient code model (RecipientIntakeCode, unchanged:   *)
(* its serialized store-side mapping still describes b92ff04b, see         *)
(* WIRING-REVIEW-B92FF04B.md). The 667 model's free TombArrive, TombDrop   *)
(* and LatchCancels are replaced by what the queue branches do.            *)
(*                                                                         *)
(* Source at b92ff04b (packages/sdk/src/orchestration_1_0_83/):            *)
(*  queue.ts 830-855 (drain) and 1198-1216 (pre-dispatch sweep), on a      *)
(*  message with cancelPending:                                            *)
(*    1. addCancelledMessageIds (state.ts 486-494): each new id is added;  *)
(*       beyond 200 ids the oldest is evicted, possibly an id of the same  *)
(*       message;                                                          *)
(*    2. every prompt stashed in this pass whose ids meet the ids          *)
(*       cancelled in this pass is dropped with dropCancelledPrompt        *)
(*       (lifecycle.ts 414-421), which deletes those ids from the set      *)
(*       (consumption);                                                    *)
(*    3. latchIntakeTombstones (intake-wiring.ts) latches every intake     *)
(*       copy that an id still in the set names.                           *)
(*  queue.ts 958-970: an ordinary prompt whose id is in the set is         *)
(*    dropped (consumes it; dropCancelledPrompt also touches its ids into  *)
(*    the recent window, r2); one whose id is in the recent window or      *)
(*    pending in this pass is a duplicate; otherwise it is stashed.        *)
(*  queue.ts 882-887 and intake-wiring.ts 248: an enveloped copy takes the *)
(*    intake path, which does not consult the window; once held, its       *)
(*    canonical id enters the window.                                      *)
(*                                                                         *)
(* Environment assumptions, each a constant so a result names the ones it  *)
(* needs:                                                                  *)
(*  E-ID  (AllowOrdinary): an ordinary prompt may carry any client id,     *)
(*        the intake copy's canonical id included (ids are untrusted text).*)
(*  E-BIG (AllowBig): one cancelPending may carry more than 200 ids. It is *)
(*        abstracted: only the modeled id c is kept; `evictSelf` means c   *)
(*        is evicted by the message's own later ids, which (insertion      *)
(*        order) also evicts every older id; E is the older ids evicted    *)
(*        otherwise.                                                       *)
(*  E-WIN (AllowForget): the recent window forgets an id after 20 others.  *)
(*  E-PASS: a drain pass's stash and pending ids end with the pass         *)
(*        (DrainEnd); a prompt that reaches the FIFO is consumed later by   *)
(*        decide, after the latch of the same cancel, and is not modeled. *)
(* Not modeled: forming and carrying (not wired at b92ff04b; WithInvocation *)
(* is FALSE in the proposed configurations), dropConvertedMessages (adds   *)
(* steer ids; it may evict older, already latched ids), the sweep's use of *)
(* this message's ids rather than the pass's (the pass's set includes      *)
(* them, an over-approximation).                                           *)
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
    stage,     \* the cancel branch: "idle", "added", "consumed"
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
newV == <<window, pendIds, ordStash, passCan, stage, lost, flost>>
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
    /\ stage = "idle"
    /\ lost = [e \in Ex |-> FALSE] /\ flost = FALSE

-----------------------------------------------------------------------------
(* The intake store side, as in the code model, between messages.          *)

Keep == UNCHANGED newV

(* An accepted claim; a newly held copy's canonical id enters the window. *)
ClaimOkB(e) ==
    /\ Idle /\ C!ClaimOk(e)
    /\ window' = IF q'[e] = "held" THEN window \cup {e} ELSE window
    /\ UNCHANGED <<pendIds, ordStash, passCan, stage, lost, flost>>

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
(* Ordinary prompts (queue.ts 958-970), the window and the pass.           *)

OrdArrive(c) ==
    /\ Idle /\ NoClaimInFlight /\ AllowOrdinary /\ C!Live
    /\ IF c \in tombs
         THEN \* drain-incoming: dropped; dropCancelledPrompt consumes c and,
              \* revision r2 (caveat C2), touches it into the recent window
              /\ tombs' = tombs \ {c}
              /\ LostFor({c})
              /\ window' = window \cup {c}
              /\ UNCHANGED <<pendIds, ordStash, passCan, stage>>
         ELSE \* a duplicate changes nothing and is not a step here
              /\ c \notin window \cup pendIds
              /\ ordStash' = ordStash \cup {c} /\ pendIds' = pendIds \cup {c}
              /\ UNCHANGED <<tombs, window, passCan, stage, lost, flost>>
    /\ lastAct' = "env"
    /\ UNCHANGED <<q, ucan, hcan, fq, fcan, ist, items, cr, isent, iparked, iset,
                   cw, bm, flight, fsnap, fkind, fflag, broken, row, proc, creq,
                   pend, glatch, carried, sentEver, sawOwn, unsentLatch, badCarry>>

WindowForget(c) ==
    /\ Idle /\ AllowForget /\ c \in window
    /\ window' = window \ {c}
    /\ UNCHANGED <<codeV, pendIds, ordStash, passCan, stage, lost, flost>>

DrainEnd ==
    /\ Idle /\ NoClaimInFlight /\ (ordStash # {} \/ passCan # {} \/ pendIds # {})
    /\ ordStash' = {} /\ passCan' = {} /\ pendIds' = {}
    /\ UNCHANGED <<codeV, window, stage, lost, flost>>

-----------------------------------------------------------------------------
(* A message with cancelPending (queue.ts 830-855, 1198-1216).             *)

(* 1. addCancelledMessageIds for id c, with the abstracted >200 case.     *)
CancelAdd(c, big, evictSelf, E) ==
    /\ Idle /\ NoClaimInFlight /\ C!Live
    /\ big => AllowBig
    /\ ~big => (~evictSelf /\ E = {})
    /\ E \subseteq tombs \ {c}
    /\ evictSelf => E = tombs \ {c}
    /\ LET T == (tombs \ E) \ (IF evictSelf THEN {c} ELSE {})
           T2 == IF evictSelf THEN T ELSE T \cup {c}
       IN /\ tombs' = T2
          /\ LostFor(({c} \cup tombs) \ T2)
    /\ passCan' = passCan \cup {c}
    /\ stage' = "added"
    /\ lastAct' = "env"
    /\ UNCHANGED <<q, ucan, hcan, fq, fcan, ist, items, cr, isent, iparked, iset,
                   cw, bm, flight, fsnap, fkind, fflag, broken, row, proc, creq,
                   pend, glatch, carried, sentEver, sawOwn, unsentLatch, badCarry,
                   window, pendIds, ordStash>>

(* 2. Stashed prompts whose ids meet this pass's cancels are dropped; their *)
(*    ids leave the set.                                                    *)
CancelConsume ==
    /\ stage = "added"
    /\ LET D == ordStash \cap passCan
       IN /\ tombs' = tombs \ D
          /\ ordStash' = ordStash \ D
          /\ LostFor(tombs \cap D)
          /\ window' = window \cup D     \* r2, C2: dropCancelledPrompt touches the ids
    /\ stage' = "consumed"
    /\ UNCHANGED <<q, ucan, hcan, fq, fcan, ist, items, cr, isent, iparked, iset,
                   cw, bm, flight, fsnap, fkind, fflag, broken, row, proc, creq,
                   pend, glatch, carried, sentEver, sawOwn, unsentLatch, badCarry,
                   lastAct, pendIds, passCan>>

(* 3. latchIntakeTombstones: the code model's LatchCancels over the ids    *)
(*    still in the set, or nothing when nothing is newly named.            *)
NothingNew == C!NewU \cup C!NewH \cup C!NewI = {} /\ ~C!NewF

CancelLatch ==
    /\ stage = "consumed"
    /\ \/ C!LatchCancels
       \/ (NothingNew \/ broken) /\ UNCHANGED codeV
    /\ stage' = "idle"
    /\ UNCHANGED <<window, pendIds, ordStash, passCan, lost, flost>>

-----------------------------------------------------------------------------
Next ==
    \/ StoreNext
    \/ \E c \in Ex : OrdArrive(c) \/ WindowForget(c)
    \/ \E c \in Ex, big, ev \in BOOLEAN, E \in SUBSET Ex : CancelAdd(c, big, ev, E)
    \/ CancelConsume \/ CancelLatch \/ DrainEnd

Spec == Init /\ [][Next]_allV

(* The intent's independent safety predicate (RecipientCancelOrderSpec).  *)
Inv_NoCancelLost == (\A e \in Ex : ~lost[e]) /\ ~flost

(* Positive control, EXPECTED to be violated: a cancel is latched on a     *)
(* held copy by the cancel branch.                                          *)
Wit_B92Latched == ~(\E e \in Ex : q[e] = "held" /\ hcan[e])

=============================================================================
