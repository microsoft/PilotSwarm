------------------------ MODULE RecipientIntakeSpec ------------------------
(***************************************************************************)
(* Intent model: cancellation and settlement of durable recipient intake. *)
(*                                                                         *)
(* Derived ONLY from the accepted design text                              *)
(*   docs/proposals/workflow-durable-intake.md (design A, revision 3,      *)
(*   amendment 2) at commit 66739e07, blob b8e927f4,                       *)
(* sections 2, 5.1-5.5 ("Latched cancels" included), 6.1 and 7 (I1-I3, I8, *)
(* I9, I11). It is written before the code was read. A separate code      *)
(* model and an explicit mapping follow.                                   *)
(*                                                                         *)
(* Scope (deliberately narrow): latched cancellation; transient failure    *)
(* and lost acknowledgement of every store write; the four places of a     *)
(* copy (unclaimed, held, bound-unsent, sent-ending); bounded tombstone    *)
(* eviction and consumption; store-only due retries (the wake), which      *)
(* never start a turn or unpark; and the identity of a cancel (exchange    *)
(* and canonical client id together). Not modeled: capacity and size       *)
(* refusals, duplicates of genuine copies, the sender, KV, continue-as-new *)
(* (carried state is the variables), session end.                          *)
(*                                                                         *)
(* A store write is committed by the store and then acknowledged to the   *)
(* orchestration; a lost acknowledgement is a commit with no ACK, and a   *)
(* retry of a committed write is idempotent. A failure before the commit  *)
(* changes nothing and is a stutter step here.                             *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Ex,          \* exchanges; the genuine copy of e has canonical client id e
    ForgedEx,    \* exchange named by one shape-valid conflicting copy, or "none"
    ForgedCid,   \* the client id that copy's envelope yields
    TombCap,     \* the bounded tombstone (cancel) set
    Fault        \* "none", or one deliberate deviation from the design

ASSUME TombCap \in Nat \ {0}
ASSUME Fault \in {"none", "drop_latch", "exchange_only", "end_before_creq",
                  "wake_unpark", "carry_latched"}

HasForged == ForgedEx \in Ex
Locs   == {"absent", "inflight", "unclaimed", "held", "settling", "inv", "done"}
Owes   == {"none", "cancel", "nd", "creq"}
Rows   == {"none", "holding", "admitted", "cancelled"}
Procs  == {"none", "bound", "not_dispatched", "nd_cancelled", "completed",
           "interrupted"}
Outs   == {"none", "completed", "interrupted", "not_dispatched"}
Acts   == {"init", "env", "decide", "wake", "turn"}
NoInv  == [st |-> "none", mem |-> {}, sent |-> FALSE, parked |-> FALSE,
           out |-> "none"]

VARIABLES
    tombs,     \* the bounded cancel set (canonical client ids)
    loc,       \* where each genuine copy is in the carried state
    latch,     \* the latched cancel decision of each genuine copy
    owed,      \* the cancel write each latched copy still owes the store
    floc,      \* the forged copy: "absent", "inflight", "unclaimed", "done"
    flatch,    \* its latched cancel
    inv,       \* the one invocation
    row,       \* store: workflow_intake.state
    proc,      \* store: processing ("nd_cancelled" = not_dispatched, reason cancelled)
    creq,      \* store: cancel_requested
    carried,   \* ghost: carried by some attempt
    sentEver,  \* ghost: an attempt that carried it sent or possibly sent it
    sawOwn,    \* ghost: its latch came from a tombstone for its own client id
    unsentLatch, \* ghost: latched while not sent
    badCarry,  \* ghost: carried after an unsent latch
    lastAct    \* ghost: which kind of step was last

storeV  == <<row, proc, creq>>
carryV  == <<loc, latch, owed, floc, flatch, inv>>
ghostV  == <<carried, sentEver, sawOwn, unsentLatch, badCarry>>
vars    == <<tombs, carryV, storeV, ghostV, lastAct>>

Recorded(e) == row[e] = "cancelled" \/ proc[e] = "nd_cancelled" \/ creq[e]

TypeOK ==
    /\ tombs \subseteq Ex /\ Cardinality(tombs) <= TombCap
    /\ loc \in [Ex -> Locs] /\ latch \in [Ex -> BOOLEAN]
    /\ owed \in [Ex -> Owes]
    /\ floc \in {"absent", "inflight", "unclaimed", "done"}
    /\ flatch \in BOOLEAN
    /\ inv \in [st : {"none", "formed", "bound"}, mem : SUBSET Ex,
                sent : BOOLEAN, parked : BOOLEAN, out : Outs]
    /\ row \in [Ex -> Rows] /\ proc \in [Ex -> Procs]
    /\ creq \in [Ex -> BOOLEAN]
    /\ carried \in [Ex -> BOOLEAN] /\ sentEver \in [Ex -> BOOLEAN]
    /\ sawOwn \in [Ex -> BOOLEAN] /\ unsentLatch \in [Ex -> BOOLEAN]
    /\ badCarry \in [Ex -> BOOLEAN]
    /\ lastAct \in Acts

Init ==
    /\ tombs = {}
    /\ loc = [e \in Ex |-> "absent"] /\ latch = [e \in Ex |-> FALSE]
    /\ owed = [e \in Ex |-> "none"]
    /\ floc = "absent" /\ flatch = FALSE
    /\ inv = NoInv
    /\ row = [e \in Ex |-> "none"] /\ proc = [e \in Ex |-> "none"]
    /\ creq = [e \in Ex |-> FALSE]
    /\ carried = [e \in Ex |-> FALSE] /\ sentEver = [e \in Ex |-> FALSE]
    /\ sawOwn = [e \in Ex |-> FALSE] /\ unsentLatch = [e \in Ex |-> FALSE]
    /\ badCarry = [e \in Ex |-> FALSE]
    /\ lastAct = "init"

-----------------------------------------------------------------------------
(* Environment: cancels, their bounded eviction or consumption, copies.    *)

TombArrive(c) ==
    /\ c \notin tombs /\ Cardinality(tombs) < TombCap
    /\ tombs' = tombs \cup {c}
    /\ lastAct' = "env"
    /\ UNCHANGED <<carryV, storeV, ghostV>>

(* Eviction from the bounded set, or consumption by an ordinary prompt's   *)
(* cancel check. Either may happen before or after a latch.                *)
TombDrop(c) ==
    /\ c \in tombs
    /\ tombs' = tombs \ {c}
    /\ lastAct' = "env"
    /\ UNCHANGED <<carryV, storeV, ghostV>>

Arrive(e) ==
    /\ loc[e] = "absent"
    /\ loc' = [loc EXCEPT ![e] = "inflight"]
    /\ lastAct' = "decide"
    /\ UNCHANGED <<tombs, latch, owed, floc, flatch, inv, storeV, ghostV>>

ArriveForged ==
    /\ HasForged /\ floc = "absent"
    /\ floc' = "inflight"
    /\ lastAct' = "decide"
    /\ UNCHANGED <<tombs, loc, latch, owed, flatch, inv, storeV, ghostV>>

-----------------------------------------------------------------------------
(* Claim (5.2, 5.3, 5.4). From "inflight" it is the arrival's claim; from  *)
(* "unclaimed" it is the wake's retry with the same claim id.              *)

ClaimStep(e) == IF loc[e] = "inflight" THEN "decide" ELSE "wake"

(* Accepted and acknowledged. A latched or currently cancelled copy is not *)
(* placed: it becomes a settling entry that owes its cancel.              *)
ClaimOk(e) ==
    /\ loc[e] \in {"inflight", "unclaimed"}
    /\ row' = [row EXCEPT ![e] = IF @ = "none" THEN "holding" ELSE @]
    /\ IF latch[e] \/ e \in tombs
         THEN /\ loc' = [loc EXCEPT ![e] = "settling"]
              /\ latch' = [latch EXCEPT ![e] = TRUE]
              /\ owed' = [owed EXCEPT ![e] = "cancel"]
              /\ sawOwn' = [sawOwn EXCEPT ![e] = IF latch[e] THEN @ ELSE TRUE]
              /\ unsentLatch' = [unsentLatch EXCEPT ![e] = TRUE]
         ELSE /\ loc' = [loc EXCEPT ![e] = "held"]
              /\ UNCHANGED <<latch, owed, sawOwn, unsentLatch>>
    /\ lastAct' = ClaimStep(e)
    /\ UNCHANGED <<tombs, floc, flatch, inv, proc, creq, carried, sentEver,
                   badCarry>>

(* Committed, acknowledgement lost; or failed before the commit. The copy *)
(* waits as an unclaimed entry with its claim id and a due time. When a   *)
(* tombstone names it now, its cancel may be latched in the same step     *)
(* (lat): the first time a tombstone names a copy (5.5).                  *)
ClaimNoAck(e, committed, lat) ==
    /\ loc[e] \in {"inflight", "unclaimed"}
    /\ lat => (e \in tombs /\ ~latch[e])
    /\ row' = IF committed /\ row[e] = "none"
                THEN [row EXCEPT ![e] = "holding"] ELSE row
    /\ loc' = [loc EXCEPT ![e] = "unclaimed"]
    /\ latch' = IF lat THEN [latch EXCEPT ![e] = TRUE] ELSE latch
    /\ sawOwn' = IF lat THEN [sawOwn EXCEPT ![e] = TRUE] ELSE sawOwn
    /\ unsentLatch' = IF lat THEN [unsentLatch EXCEPT ![e] = TRUE] ELSE unsentLatch
    /\ lastAct' = ClaimStep(e)
    /\ UNCHANGED <<tombs, owed, floc, flatch, inv, proc, creq, carried, sentEver,
                   badCarry>>

(* The forged copy: its claim answers "unverified" and the copy is        *)
(* retired, or the claim fails and the copy waits unclaimed, its cancel    *)
(* latched in the same step when a tombstone names its client id (lat).   *)
ForgedClaim(answered, lat) ==
    /\ floc \in {"inflight", "unclaimed"}
    /\ lat => (~answered /\ ForgedCid \in tombs /\ ~flatch)
    /\ floc' = IF answered THEN "done" ELSE "unclaimed"
    /\ flatch' = (flatch \/ lat)
    /\ lastAct' = IF floc = "inflight" THEN "decide" ELSE "wake"
    /\ UNCHANGED <<tombs, loc, latch, owed, inv, storeV, ghostV>>

-----------------------------------------------------------------------------
(* Latching (5.5 "Latched cancels"): the first time a tombstone names a   *)
(* copy, the decision is written into the carried state, before any store *)
(* write, and is never taken again from tombstones.                       *)

Sent(e) == e \in inv.mem /\ inv.sent

LatchPlaces(e) ==
    \/ loc[e] \in {"unclaimed", "held"}
    \/ /\ loc[e] = "inv"
       /\ inv.out = "none" \/ inv.sent   \* an unsent ending invocation is not cancelled

(* One latch step for tombstone c latches any of the copies it names that *)
(* are not latched yet: the genuine copy of c (g) and the forged copy when  *)
(* its client id is c (f). The forged copy's latch is keyed by its exchange *)
(* AND its client id; it never latches a genuine copy (5.5: "an exchange   *)
(* alone never carries a latch from one copy to another"). Fault           *)
(* "exchange_only" makes it latch the genuine copy of its exchange too.    *)
GenLatchable(c) == ~latch[c] /\ LatchPlaces(c)
ForgedLatchable(c) ==
    HasForged /\ ForgedCid = c /\ ~flatch /\ floc \in {"inflight", "unclaimed"}
XLatch(c, f) ==
    /\ f /\ Fault = "exchange_only" /\ ForgedEx # c
    /\ ~latch[ForgedEx] /\ loc[ForgedEx] \in {"unclaimed", "held"}

LatchBy(c, g, f) ==
    /\ c \in tombs /\ (g \/ f)
    /\ g => GenLatchable(c)
    /\ f => ForgedLatchable(c)
    /\ LET G == (IF g THEN {c} ELSE {}) \cup (IF XLatch(c, f) THEN {ForgedEx} ELSE {})
       IN /\ latch' = [e \in Ex |-> latch[e] \/ e \in G]
          /\ sawOwn' = [e \in Ex |-> sawOwn[e] \/ (g /\ e = c)]
          /\ unsentLatch' = [e \in Ex |-> IF e \in G THEN ~Sent(e) ELSE unsentLatch[e]]
          /\ owed' = [e \in Ex |->
                        IF e \notin G THEN owed[e]
                        ELSE CASE loc[e] = "held" -> "cancel"
                               [] loc[e] = "inv" /\ ~inv.sent -> "nd"
                               [] loc[e] = "inv" /\ inv.sent -> "creq"
                               [] OTHER -> "none"]
    /\ flatch' = (flatch \/ f)
    /\ lastAct' = "decide"
    /\ UNCHANGED <<tombs, loc, floc, inv, storeV, carried, sentEver, badCarry>>

(* Not the design: a latch is dropped once its tombstone is gone.         *)
DropLatch(e) ==
    /\ Fault = "drop_latch"
    /\ latch[e] /\ e \notin tombs /\ loc[e] \in {"held", "settling"}
    /\ latch' = [latch EXCEPT ![e] = FALSE]
    /\ owed' = [owed EXCEPT ![e] = "none"]
    /\ loc' = [loc EXCEPT ![e] = "held"]
    /\ lastAct' = "decide"
    /\ UNCHANGED <<tombs, floc, flatch, inv, storeV, ghostV>>

-----------------------------------------------------------------------------
(* Cancel writes (5.2 cancel rows; 5.4 the wake). Store writes only.      *)
(*  "cancel": holding(c) -> cancelled; the held or settling entry goes.    *)
(*  "nd":     admitted, bound -> not_dispatched (cancelled); the item     *)
(*            leaves the unsent batch. Needs the bind first.               *)
(*  "creq":   cancel_requested = true; also after an end committed.        *)

(* One write may name several owing copies (S); the store commits them   *)
(* item by item (C, possibly a part of S, then a failure); an acknowledged *)
(* write committed all of S. A repeated commit is the same result.         *)
CancelWrites(S, C, ack) ==
    /\ S # {} /\ C \subseteq S /\ (ack => C = S)
    /\ \A e \in S : owed[e] # "none" /\ (owed[e] = "nd" => inv.st = "bound")
    /\ row' = [e \in Ex |-> IF e \in C /\ owed[e] = "cancel" /\ row[e] = "holding"
                              THEN "cancelled" ELSE row[e]]
    /\ proc' = [e \in Ex |-> IF e \in C /\ owed[e] = "nd" /\ proc[e] = "bound"
                               THEN "nd_cancelled" ELSE proc[e]]
    /\ creq' = [e \in Ex |-> creq[e] \/ (e \in C /\ owed[e] = "creq")]
    /\ IF ack
         THEN LET ND == {e \in S : owed[e] = "nd"}
              IN /\ owed' = [e \in Ex |-> IF e \in S THEN "none" ELSE owed[e]]
                 /\ loc' = [e \in Ex |-> IF e \in S /\ owed[e] # "creq"
                                          THEN "done" ELSE loc[e]]
                 /\ inv' = IF ND = {} THEN inv
                          ELSE IF inv.mem \subseteq ND THEN NoInv
                          ELSE [inv EXCEPT !.mem = @ \ ND]
         ELSE UNCHANGED <<owed, loc, inv>>
    /\ lastAct' = "wake"
    /\ UNCHANGED <<tombs, latch, floc, flatch, ghostV>>

-----------------------------------------------------------------------------
(* The invocation (5.5).                                                    *)

Bindable == {e \in Ex : loc[e] = "held" /\ ~latch[e] /\ e \notin tombs}

Form ==
    /\ inv.st = "none" /\ Bindable # {}
    /\ inv' = [NoInv EXCEPT !.st = "formed", !.mem = Bindable]
    /\ loc' = [e \in Ex |-> IF e \in Bindable THEN "inv" ELSE loc[e]]
    /\ lastAct' = "decide"
    /\ UNCHANGED <<tombs, latch, owed, floc, flatch, storeV, ghostV>>

BindWrite(ack) ==
    /\ inv.st = "formed"
    /\ row' = [e \in Ex |-> IF e \in inv.mem /\ row[e] = "holding"
                              THEN "admitted" ELSE row[e]]
    /\ proc' = [e \in Ex |-> IF e \in inv.mem /\ proc[e] = "none"
                               THEN "bound" ELSE proc[e]]
    /\ inv' = IF ack THEN [inv EXCEPT !.st = "bound"] ELSE inv
    /\ lastAct' = "wake"
    /\ UNCHANGED <<tombs, loc, latch, owed, floc, flatch, creq, ghostV>>

(* One attempt of a turn that carries the invocation. Only a turn-starting *)
(* stimulus runs it, never the wake; a parked invocation rides only such  *)
(* an attempt (its resume stimuli; the step is labeled "turn"). An unsent *)
(* invocation with a latched or currently cancelled item is not carried.  *)
(*   w: the attempt's witness (sent); r: its result class.                 *)
Carryable ==
    /\ inv.st = "bound" /\ inv.out = "none"
    /\ \A m \in inv.mem : owed[m] # "nd"
    /\ ~inv.sent => \A m \in inv.mem : ~latch[m] /\ m \notin tombs

Attempt(w, r) ==
    /\ IF Fault = "carry_latched"
         THEN inv.st = "bound" /\ inv.out = "none"
         ELSE Carryable
    /\ LET s == inv.sent \/ w
           o == IF r = "retry" THEN "none"
                ELSE IF r = "ok" /\ w THEN "completed"
                ELSE IF s THEN "interrupted"
                ELSE IF r = "stop" THEN "not_dispatched"
                ELSE "none"                       \* ok or gate, never sent: parked
           p == r \in {"ok", "gate"} /\ ~s
       IN /\ inv' = [inv EXCEPT !.sent = s, !.out = o, !.parked = p]
          /\ sentEver' = [e \in Ex |-> sentEver[e] \/ (e \in inv.mem /\ s)]
    /\ carried' = [e \in Ex |-> carried[e] \/ e \in inv.mem]
    /\ badCarry' = [e \in Ex |-> badCarry[e] \/ (e \in inv.mem /\ unsentLatch[e])]
    /\ lastAct' = "turn"
    /\ UNCHANGED <<tombs, loc, latch, owed, floc, flatch, storeV, sawOwn,
                   unsentLatch>>

(* Not the design: the wake unparks.                                       *)
WakeUnpark ==
    /\ Fault = "wake_unpark" /\ inv.parked
    /\ inv' = [inv EXCEPT !.parked = FALSE]
    /\ lastAct' = "wake"
    /\ UNCHANGED <<tombs, loc, latch, owed, floc, flatch, storeV, ghostV>>

(* The end settlement: after every latched sent item's cancel_requested   *)
(* is recorded; outcome and membership unchanged.                          *)
EndWrite(ack) ==
    /\ inv.st = "bound" /\ inv.out # "none"
    /\ Fault # "end_before_creq" => \A m \in inv.mem : owed[m] # "creq"
    /\ proc' = [e \in Ex |-> IF e \in inv.mem /\ proc[e] = "bound"
                               THEN inv.out ELSE proc[e]]
    /\ IF ack
         THEN /\ inv' = NoInv
              /\ loc' = [e \in Ex |-> IF e \in inv.mem THEN "done" ELSE loc[e]]
         ELSE UNCHANGED <<inv, loc>>
    /\ lastAct' = "wake"
    /\ UNCHANGED <<tombs, latch, owed, floc, flatch, row, creq, ghostV>>

-----------------------------------------------------------------------------
Next ==
    \/ \E c \in Ex : TombArrive(c) \/ TombDrop(c)
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

Spec == Init /\ [][Next]_vars

(* A-STORE: the store eventually answers and acknowledges every due write *)
(* retried by the wake. No fairness on attempts, stimuli or arrivals: the *)
(* cancel writes must complete with no turn and no other stimulus.        *)
Fairness ==
    /\ \A e \in Ex : WF_vars(ClaimOk(e)) /\ WF_vars(CancelWrites({e}, {e}, TRUE))
    /\ WF_vars(BindWrite(TRUE))
    /\ WF_vars(EndWrite(TRUE))

LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
(* Safety.                                                                  *)

(* A cancel acts only on the copy whose own client id it names.            *)
Inv_LatchOwnId == \A e \in Ex : latch[e] => sawOwn[e]

(* The store records a cancel only for a latched copy.                     *)
Inv_StoreCancelLatched == \A e \in Ex : Recorded(e) => latch[e]

(* A latched copy that left the carried state left it by its cancel write,*)
(* or as a member of an ended invocation that recorded cancel_requested.   *)
Inv_DoneLatchedRecorded ==
    \A e \in Ex : (loc[e] = "done" /\ latch[e]) => Recorded(e)

(* An unsent latch is final: the copy is never carried afterwards.        *)
Inv_NoCarryAfterUnsentLatch == \A e \in Ex : ~badCarry[e]

(* I9: not_dispatched only when never sent.                                *)
Inv_TruthfulNotDispatched ==
    \A e \in Ex : proc[e] \in {"not_dispatched", "nd_cancelled"} => ~sentEver[e]

(* The decision stands across eviction, consumption, failure and lost ACK.*)
Prop_LatchStable == [][\A e \in Ex : latch[e] => latch'[e]]_vars

(* The end names a latched sent item only after its cancel_requested.      *)
EndCommits == \E m \in inv.mem : proc[m] = "bound"
                 /\ proc'[m] \in {"completed", "interrupted", "not_dispatched"}
Prop_EndAfterCancelRequested ==
    [][EndCommits => \A m \in inv.mem : (latch[m] /\ inv.sent) => creq[m]]_vars

(* I11 and 5.4: the wake writes only to the store.                          *)
Prop_WakeStoreOnly ==
    [][lastAct' = "wake" =>
         /\ carried' = carried /\ sentEver' = sentEver
         /\ inv'.parked = inv.parked \/ inv' = NoInv]_vars

(* I1: final store states stay final.                                       *)
Prop_StoreFinal ==
    [][\A e \in Ex :
         /\ row[e] \in {"admitted", "cancelled"} => row'[e] = row[e]
         /\ proc[e] \in {"not_dispatched", "nd_cancelled", "completed",
                         "interrupted"} => proc'[e] = proc[e]]_vars

(* Liveness: a latched cancel is recorded with no turn and no stimulus.    *)
Live_LatchRecorded == \A e \in Ex : latch[e] ~> Recorded(e)

-----------------------------------------------------------------------------
(* Witnesses: each is EXPECTED to be violated (the situation is reachable).*)

(* A latch whose tombstone is gone, then recorded.                         *)
Wit_RecordedAfterEviction ==
    ~(\E e \in Ex : latch[e] /\ e \notin tombs /\ Recorded(e) /\ row[e] = "cancelled")
(* An unsent invocation item cancelled after its bind.                     *)
Wit_UnsentCancelled == ~(\E e \in Ex : proc[e] = "nd_cancelled")
(* cancel_requested recorded on a sent item.                               *)
Wit_SentCancelRequested == ~(\E e \in Ex : creq[e] /\ sentEver[e])
(* A copy whose claim answer was lost or failed, latched while unclaimed. *)
Wit_UnclaimedLatched == ~(\E e \in Ex : latch[e] /\ loc[e] = "unclaimed")
(* The forged copy latched while the genuine copy is held and unlatched.  *)
Wit_ForgedLatchSeparate ==
    ~(flatch /\ HasForged /\ loc[ForgedEx] \in {"held", "inv"} /\ ~latch[ForgedEx])
(* A completed invocation.                                                 *)
Wit_Completed == ~(\E e \in Ex : proc[e] = "completed")

=============================================================================
