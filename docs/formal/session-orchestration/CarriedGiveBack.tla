---------------------------- MODULE CarriedGiveBack ----------------------------
(***************************************************************************)
(* 1.0.83 late-cancel give-back (orchestration_1_0_83/queue.ts; so5 adds  *)
(* the F1/F2 fixes as constants Chrono, SkipQueued, SweepCan).           *)
(* Base: 67fe212c.                                                          *)
(* 67fe212c). A queued prompt that took the pending child digest and the   *)
(* rehydration notice into its text (drain, 1263-1266) also carries them   *)
(* as markers on its FIFO item (markCarriedWork 408, called at 1269; the   *)
(* digest marker goes first, then the notice's, when the item would be too *)
(* large). A cancel that drops the prompt at dispatch (decide-merge 1512,  *)
(* decide-fifo 1615) gives them back (giveBackDroppedPromptWork 438): the  *)
(* digest merged per child with the pending one (restorePendingChildDigest,*)
(* lifecycle.ts 486: pending entries are newer; a lifecycle update         *)
(* outranks a progress note), the notice only while none is pending. The   *)
(* FIFO and its markers survive continue-as-new (KV).                      *)
(* Entries: [s |-> update number, r |-> 0 none, 1 progress, 2 lifecycle].  *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    Fix,          \* the give-back at the dispatch drops (FALSE: the code before 67fe212c)
    AllowBig,     \* a marker may be dropped because the item would be too large
    MaxUpd,       \* child updates in all
    MaxGen,       \* lossy hand-offs (rehydration notices) in all
    MaxPrompts,   \* prompts queued in all
    Fault,        \* "none", "merge-prefer-pending", "overwrite-notice", "can-drops-markers", "give-back-on-dispatch"
    Chrono,       \* "pending-newer": the restore counts the pending entry newer (67fe212c);
                  \* "observed": it orders entries by observedAtMs (the F1(a) fix)
    SkipQueued,   \* "none"; "rank": skip a carried entry when a still-queued prompt carries a later entry of
                  \* that child ranked at least as high, and the notice when one carries a notice (F1(b));
                  \* "any": skip on any later entry (must fail)
    AllowPassCancel, \* drain's same-pass give-back (giveBackCarriedWork; taken-order chronology)
    PassSkip,     \* "none" (3eebc211); "rank" (b8aa360f): skip what a later stash prompt carries (same rule)
    SweepCan      \* "none"; "lose": a set_model during the pre-dispatch sweep continues as new while decide
                  \* holds the popped head prompt (the code); "requeue": the head is put back first (proposed fix)

ASSUME Fix \in BOOLEAN /\ AllowBig \in BOOLEAN /\ MaxUpd \in 1..4 /\ MaxGen \in 1..2 /\ MaxPrompts \in 1..3
ASSUME Fault \in {"none", "merge-prefer-pending", "overwrite-notice", "can-drops-markers", "give-back-on-dispatch"}
ASSUME SweepCan \in {"none", "lose", "requeue"}
ASSUME AllowPassCancel \in BOOLEAN /\ PassSkip \in {"none", "rank"}
ASSUME Chrono \in {"pending-newer", "observed"} /\ SkipQueued \in {"none", "rank", "any"}

C == {"a", "b"}
None == [s |-> 0, r |-> 0]
Empty == [c \in C |-> None]
Entries == [s : 0..MaxUpd, r : 0..2]
MaxLen == IF MaxPrompts = 3 THEN 3 ELSE 2

VARIABLES seq, gen, pd, pn, fifo, prompts, delivered, dlvN, lastLc, cans, gh
vars == <<seq, gen, pd, pn, fifo, prompts, delivered, dlvN, lastLc, cans, gh>>

Init ==
    /\ seq = 0 /\ gen = 0 /\ pd = Empty /\ pn = 0 /\ fifo = <<>> /\ prompts = 0
    /\ delivered = {} /\ dlvN = {} /\ lastLc = [c \in C |-> 0] /\ cans = 0 /\ gh = {}

(* bufferChildUpdate: a lifecycle update outranks a progress note;          *)
(* otherwise the newer entry replaces the older.                          *)
Buffer(p, e) == IF p.r = 2 /\ e.r = 1 THEN p ELSE e
(* restorePendingChildDigest: the pending entry is newer; a carried         *)
(* lifecycle update outranks a pending progress note.                      *)
RestoreC(p, q, ch) ==
    IF q.r = 0 THEN p
    ELSE IF p.r = 0 THEN q
    ELSE IF Fault = "merge-prefer-pending" THEN p
    ELSE IF ch = "observed"
         THEN (IF p.s >= q.s THEN (IF p.r >= q.r THEN p ELSE q) ELSE (IF q.r >= p.r THEN q ELSE p))
    ELSE IF q.r > p.r THEN q ELSE p
Restore(p, q) == RestoreC(p, q, Chrono)
(* F1(b): a still-queued prompt (in rest) carries a later entry of c.        *)
LaterQueued(rest, c, q) ==
    \E i \in 1..Len(rest) : rest[i].md[c].s > q.s /\ (SkipQueued = "any" \/ rest[i].md[c].r >= q.r)
Carried(rest, c, q) ==
    IF q.r > 0 /\ SkipQueued # "none" /\ LaterQueued(rest, c, q) THEN None ELSE q
NoticeQueued(rest) == SkipQueued # "none" /\ \E i \in 1..Len(rest) : rest[i].mn > 0

ChildUpdate ==
    /\ seq < MaxUpd
    /\ \E c \in C, r \in {1, 2} :
         /\ pd' = [pd EXCEPT ![c] = Buffer(pd[c], [s |-> seq + 1, r |-> r])]
         /\ lastLc' = IF r = 2 THEN [lastLc EXCEPT ![c] = seq + 1] ELSE lastLc
    /\ seq' = seq + 1
    /\ UNCHANGED <<gen, pn, fifo, prompts, delivered, dlvN, cans, gh>>

Handoff ==
    /\ gen < MaxGen
    /\ gen' = gen + 1 /\ pn' = gen + 1
    /\ UNCHANGED <<seq, pd, fifo, prompts, delivered, dlvN, lastLc, cans, gh>>

(* drain: a prompt takes the pending digest and notice into its text and   *)
(* is queued; its markers may be dropped for size (digest first).          *)
DrainPrompt ==
    /\ prompts < MaxPrompts /\ Len(fifo) < MaxLen
    /\ \E big \in (IF AllowBig THEN 0..2 ELSE {0}) :
         fifo' = Append(fifo, [d |-> pd, n |-> pn,
                               md |-> IF big >= 1 THEN Empty ELSE pd,
                               mn |-> IF big = 2 THEN 0 ELSE pn])
    /\ pd' = Empty /\ pn' = 0 /\ prompts' = prompts + 1
    /\ UNCHANGED <<seq, gen, delivered, dlvN, lastLc, cans, gh>>

Deliver(d, n) ==
    /\ delivered' = delivered \cup {<<c, d[c].s, d[c].r>> : c \in {x \in C : d[x].r > 0}}
    /\ dlvN' = dlvN \cup (IF n > 0 THEN {n} ELSE {})
    /\ gh' = gh \cup (IF \E c \in C : d[c].r > 0 /\ <<c, d[c].s, d[c].r>> \in delivered THEN {"dup"} ELSE {})
                \cup (IF n > 0 /\ \E m \in dlvN : m >= n THEN {"staleNotice"} ELSE {})
                \cup (IF \E c \in C : d[c].r > 0 /\ \E e \in delivered : e[1] = c /\ e[2] > d[c].s /\ e[3] >= d[c].r
                      THEN {"staleDigest"} ELSE {})

(* decide: the head prompt runs; its text reaches the model.               *)
Dispatch ==
    /\ fifo # <<>>
    /\ Deliver(Head(fifo).d, Head(fifo).n)
    /\ fifo' = Tail(fifo)
    /\ pd' = IF Fault = "give-back-on-dispatch"
             THEN [c \in C |-> Restore(pd[c], Head(fifo).md[c])] ELSE pd
    /\ UNCHANGED <<seq, gen, pn, prompts, lastLc, cans>>

(* decide-fifo / decide-merge: a tombstone drops the head prompt.          *)
LateCancel ==
    /\ fifo # <<>>
    /\ LET it == Head(fifo)
           rest == Tail(fifo) IN
       /\ pd' = IF Fix THEN [c \in C |-> Restore(pd[c], Carried(rest, c, it.md[c]))] ELSE pd
       /\ pn' = IF Fix /\ it.mn > 0 /\ (pn = 0 \/ Fault = "overwrite-notice") /\ ~NoticeQueued(rest) THEN it.mn ELSE pn
       /\ gh' = gh \cup (IF Fix /\ \E c \in C : it.md[c].r > 0 THEN {"gaveDigest"} ELSE {})
                   \cup (IF Fix /\ it.mn > 0 /\ pn = 0 /\ ~NoticeQueued(rest) THEN {"gaveNotice"} ELSE {})
                   \cup (IF Fix /\ \E c \in C : it.md[c].r > 0 /\ Carried(rest, c, it.md[c]) = None THEN {"skipped"} ELSE {})
                   \cup (IF Fix /\ \E c \in C : it.md[c].r > 0 /\ pd[c].r > 0 THEN {"merged"} ELSE {})
    /\ fifo' = Tail(fifo)
    /\ UNCHANGED <<seq, gen, prompts, delivered, dlvN, lastLc, cans>>

(* drain-stash (queue.ts 951-960): a tombstone drops a prompt still in the  *)
(* pass's stash; giveBackCarriedWork restores what it took (carriedByItem, *)
(* by taken order) without looking at later stash items. Here the FIFO's  *)
(* two items stand for the pass's stash. b8aa360f (PassSkip = "rank"):     *)
(* a carried entry is skipped when the later stash prompt carries one for   *)
(* that child ranked at least as high; the notice when it carries one.      *)
(* The last two FIFO items stand for the pass's stash (the dropped prompt   *)
(* and a later one); any items before them were queued in earlier passes. *)
PassLater(c, e, nx) == PassSkip = "rank" /\ e.r > 0 /\ nx.d[c].s > e.s /\ nx.d[c].r >= e.r
PassNotice(k, nx) == PassSkip = "rank" /\ (nx.n > 0 \/ \E i \in 1..(k - 1) : fifo[i].mn > 0)
PassCancel ==
    /\ AllowPassCancel /\ Len(fifo) >= 2
    /\ LET k == Len(fifo) - 1
           it == fifo[k]
           nx == fifo[k + 1] IN
       /\ pd' = [c \in C |-> RestoreC(pd[c], IF PassLater(c, it.d[c], nx) THEN None ELSE it.d[c], "observed")]
       /\ pn' = IF it.n > 0 /\ pn = 0 /\ ~PassNotice(k, nx) THEN it.n ELSE pn
       /\ fifo' = SubSeq(fifo, 1, k - 1) \o <<nx>>
    /\ UNCHANGED <<seq, gen, prompts, delivered, dlvN, lastLc, cans, gh>>

(* With no prompt queued, the pending digest and notice reach the model    *)
(* on their own turn (the digest turn; the rehydrating timer).             *)
FlushPending ==
    /\ fifo = <<>> /\ (pn > 0 \/ \E c \in C : pd[c].r > 0)
    /\ Deliver(pd, pn)
    /\ pd' = Empty /\ pn' = 0
    /\ UNCHANGED <<seq, gen, fifo, prompts, lastLc, cans>>

ContinueAsNew ==
    /\ cans < 1 /\ cans' = 1
    /\ fifo' = IF Fault = "can-drops-markers"
               THEN [i \in 1..Len(fifo) |-> [fifo[i] EXCEPT !.md = Empty, !.mn = 0]]
               ELSE fifo
    /\ UNCHANGED <<seq, gen, pd, pn, prompts, delivered, dlvN, lastLc, gh>>

(* decide pops the head prompt from KV (queue.ts 1603, 243-244), then runs *)
(* the pre-dispatch sweep (1610); a set_model command there (1340) continues*)
(* as new (lifecycle.ts 860) with only state.pendingPrompt in the input: the*)
(* popped prompt, its text and its markers are gone.                       *)
SweepCommandCan ==
    /\ SweepCan # "none" /\ fifo # <<>> /\ cans < 1
    /\ cans' = 1
    /\ fifo' = IF SweepCan = "lose" THEN Tail(fifo) ELSE fifo
    /\ gh' = gh \cup (IF SweepCan = "lose" THEN {"promptLost"} ELSE {"requeued"})
    /\ UNCHANGED <<seq, gen, pd, pn, prompts, delivered, dlvN, lastLc>>

Quiet == fifo = <<>> /\ pd = Empty /\ pn = 0
Done == Quiet /\ UNCHANGED vars

Next == ChildUpdate \/ Handoff \/ DrainPrompt \/ Dispatch \/ LateCancel \/ PassCancel \/ FlushPending \/ ContinueAsNew \/ SweepCommandCan \/ Done
Spec == Init /\ [][Next]_vars
Fairness == WF_vars(Dispatch \/ LateCancel \/ PassCancel) /\ WF_vars(FlushPending)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
Item == [d : [C -> Entries], n : 0..MaxGen, md : [C -> Entries], mn : 0..MaxGen]
TypeOK == /\ seq \in 0..MaxUpd /\ gen \in 0..MaxGen /\ pd \in [C -> Entries] /\ pn \in 0..MaxGen
          /\ fifo \in Seq(Item) /\ Len(fifo) <= MaxLen /\ prompts \in 0..MaxPrompts /\ cans \in 0..1

InText(c, s, r) == \E i \in 1..Len(fifo) : fifo[i].d[c].s = s /\ fifo[i].d[c].r = r
(* The newest lifecycle update of each child is delivered, pending or in   *)
(* a queued prompt's text: never lost.                                     *)
Inv_LifecycleKept ==
    \A c \in C : lastLc[c] > 0 =>
        \/ <<c, lastLc[c], 2>> \in delivered
        \/ pd[c] = [s |-> lastLc[c], r |-> 2]
        \/ InText(c, lastLc[c], 2)
(* No digest entry reaches the model twice.                                *)
Inv_DeliveredOnce == "dup" \notin gh
(* The newest rehydration notice is delivered, pending or queued.          *)
Inv_NewestNoticeKept ==
    gen > 0 => (gen \in dlvN \/ pn = gen \/ \E i \in 1..Len(fifo) : fifo[i].n = gen)
(* No notice reaches the model after a newer (or the same) one did.        *)
Inv_NoticeOrder == "staleNotice" \notin gh

(* No child entry reaches the model after a newer entry of that child that *)
(* ranks at least as high (a lifecycle update after a later progress note *)
(* is allowed: bufferChildUpdate keeps the finish).                        *)
Inv_DigestOrder == "staleDigest" \notin gh

(* A queued prompt is run, dropped by a cancel, or still queued: never lost. *)
Inv_PromptNotLost == "promptLost" \notin gh

Prop_Settles == <>[]Quiet
Prop_LifecycleDelivered == <>[](\A c \in C : lastLc[c] > 0 => <<c, lastLc[c], 2>> \in delivered)
Prop_NoticeDelivered == <>[](gen > 0 => gen \in dlvN)

W_NoDigestGiveBack == "gaveDigest" \notin gh
W_NoNoticeGiveBack == "gaveNotice" \notin gh
W_NoMerge == "merged" \notin gh
W_NoSkip == "skipped" \notin gh
W_NoRequeue == "requeued" \notin gh
=============================================================================
