---------------------------- MODULE DeleteCascade ----------------------------
(***************************************************************************)
(* Session delete cascade (FB-037/038/039), design-first.                   *)
(*                                                                          *)
(* A delete of session T runs in two layers:                                *)
(*   orch  - T's own orchestration (cancelSession, delete branch): lists T's *)
(*           live descendants, calls the deleteSession activity for each,   *)
(*           then for T itself, then answers the caller.                    *)
(*   act   - each deleteSession activity runs PilotSwarmClient.deleteSession:*)
(*           lists the target's live descendants again, soft-deletes each,  *)
(*           then the target.                                               *)
(* The listing (cms_get_descendant_session_ids) walks live rows only and has *)
(* no ORDER BY. A spawn takes the parent row FOR SHARE (0094) and refuses a  *)
(* deleted parent, so a spawn and a soft delete of its parent serialize:    *)
(* each is one atomic step here.                                            *)
(*                                                                          *)
(* Policies are constants so that today's code, the proposed fix and the     *)
(* frozen 1.0.84 caller are all cases of one model.                         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
    SpawnPar,            \* the parent of the late spawn 4 (1, 2 or 3)
    InitLive,            \* rows live at the start (the rest are absent)
    Spawnable,           \* absent rows that may be created during the delete
    PermFail,            \* rows whose soft delete always fails (e.g. a system session)
    MaxFaults,           \* transient faults the environment may inject in total
    Retries,             \* attempts per step inside an activity (>= 1)
    Budget,              \* the caller's patience, in attempts (65 s scaled)
    Frozen,              \* the caller is frozen 1.0.84 (answers "deleted" first, ignores errors)
    StrictGated,         \* the strict activity behaviour is used only when 1.0.85 asks for it
    EnumOnFail,          \* "empty": a failed listing is treated as no descendants (today); "fail"
    ActAbort,            \* activity: stop at the first failed descendant, skip the target
    OrchAbort,           \* orchestration: stop at the first failed descendant, skip T
    ReportSkipped,       \* a layer that carries on after a failed descendant still reports the failure (today: no)
    SkipBlocked,         \* act layer (strict): skip every ancestor of a failed node, and the target after a failure
    OrchSkip,            \* orchestration: "none"; "root" = never T after a failure; "all" = also skip listed ancestors
    Order,               \* "any" (no ORDER BY) or "bottomUp" (deepest first)
    Guard,               \* the soft delete refuses a row that still has a live child
    GuardShared,         \* the guard applies to every caller (one shared SQL function), not only strict ones
    MaxRecheck,          \* re-list attempts after a guard refusal
    DirectRoute,         \* the orchestration does not list: one deleteSession activity for T (delete_agent's
                         \* terminal-child route, or the single-layer shape)
    Hang,                \* an attempt may hang (a lock wait, a slow connection) instead of failing fast
    AttemptDeadline,     \* cost of a hung attempt when each attempt is bounded; 0 = no per-attempt bound
    SharedDeadline,      \* one deadline for the whole request, checked before every attempt and listing
    Cancellable          \* an attempt in progress is cut at the shared deadline (timeout = min(bound, remaining))

\* The tree: 1 = T; 2 child of 1; 3 child of 2; 4 = the late spawn.
Nodes == {1, 2, 3, 4}
Par == [n \in Nodes |-> CASE n = 1 -> 0 [] n = 2 -> 1 [] n = 3 -> 2 [] OTHER -> SpawnPar]
T == 1

ASSUME SpawnPar \in {1, 2, 3} /\ InitLive \subseteq Nodes /\ T \in InitLive
ASSUME Spawnable \cap InitLive = {}
ASSUME Retries \in Nat \ {0} /\ AttemptDeadline \in Nat

Ancestors(n) ==
    LET RECURSIVE A(_, _)
        A(m, k) == IF k = 0 \/ Par[m] = 0 THEN {} ELSE {Par[m]} \cup A(Par[m], k - 1)
    IN A(n, Cardinality(Nodes))
Subtree(n) == {m \in Nodes : m = n \/ n \in Ancestors(m)}
Depth(n) == Cardinality(Ancestors(n))

VARIABLES
    row,       \* [Nodes -> {"absent", "live", "deleted"}]
    stack,     \* frames, top = Head
    time,      \* attempts spent (the caller's clock)
    faults,    \* transient faults used
    replied,   \* "none" | "ok" | "error"   (what the caller is told)
    tOwnFail,  \* T's own soft delete was attempted and finally failed
    done       \* the orchestration has ended

vars == <<row, stack, time, faults, replied, tOwnFail, done>>

\* A hung attempt with no per-attempt bound outlasts any caller.
HangCost == IF AttemptDeadline > 0 THEN AttemptDeadline ELSE Budget + 1

\* What the activity layer does, for the caller in force.
Strict == ~Frozen \/ ~StrictGated
ActEnumFail == IF Strict THEN EnumOnFail ELSE "empty"
ActStop == IF Strict THEN ActAbort ELSE FALSE
ActReport == Strict /\ ReportSkipped
ActGuard == Guard /\ (Strict \/ GuardShared)
\* The shared deadline belongs to the strict path: the legacy path keeps today's behaviour.
Deadline == SharedDeadline /\ Strict
CanStart == ~Deadline \/ time < Budget
\* What a hung attempt costs: cut at the shared deadline only if the attempt can be cancelled.
HungCost == IF Deadline /\ Cancellable /\ Budget - time < HangCost THEN Budget - time ELSE HangCost

LiveDesc(n) ==
    {m \in Nodes \ {n} : row[m] = "live" /\ n \in Ancestors(m)
                         /\ \A a \in Ancestors(m) : n \in Ancestors(a) => row[a] = "live"}

Frame(layer, tgt) == [layer |-> layer, tgt |-> tgt, ph |-> "enum", todo |-> {}, ok |-> TRUE,
                      tries |-> 0, rechecks |-> 0, cur |-> 0, failed |-> {}]

Init ==
    /\ row = [n \in Nodes |-> IF n \in InitLive THEN "live" ELSE "absent"]
    /\ stack = <<IF DirectRoute THEN [Frame("orch", T) EXCEPT !.ph = "kids"] ELSE Frame("orch", T)>>
    /\ time = 0
    /\ faults = 0
    /\ replied = IF Frozen THEN "ok" ELSE "none"   \* 1.0.84 answers "Session deleted" before deleting
    /\ tOwnFail = FALSE
    /\ done = FALSE

Top == Head(stack)
SetTop(f) == stack' = <<f>> \o Tail(stack)

\* one attempt of a soft delete of n: TRUE = the row is gone afterwards
CanDelete(n) ==
    /\ n \notin PermFail
    /\ ~(ActGuard /\ \E c \in Nodes : Par[c] = n /\ row[c] = "live")

(* ---------------- listing ---------------- *)
EnumOk ==
    /\ ~done /\ stack # <<>> /\ Top.ph = "enum" /\ CanStart
    /\ time' = time + 1
    /\ SetTop([Top EXCEPT !.ph = "kids", !.todo = LiveDesc(Top.tgt), !.tries = 0])
    /\ UNCHANGED <<row, faults, replied, tOwnFail, done>>

EnumFault ==
    /\ ~done /\ stack # <<>> /\ Top.ph = "enum" /\ faults < MaxFaults /\ CanStart
    /\ \E cost \in (IF Hang THEN {1, HungCost} ELSE {1}) : time' = time + cost
    /\ faults' = faults + 1
    /\ LET f == Top
           onFail == IF f.layer = "orch" THEN (IF Frozen THEN "empty" ELSE EnumOnFail) ELSE ActEnumFail
       IN IF f.tries + 1 < Retries
          THEN SetTop([f EXCEPT !.tries = f.tries + 1])
          ELSE IF onFail = "empty"
               THEN SetTop([f EXCEPT !.ph = "kids", !.todo = {}, !.tries = 0])
               ELSE SetTop([f EXCEPT !.ph = "end", !.ok = FALSE])
    /\ UNCHANGED <<row, replied, tOwnFail, done>>

(* ---------------- descendants ---------------- *)
\* Choose the next listed descendant. "bottomUp": one with no deeper listed node below it.
Eligible(f) ==
    {d \in f.todo : Order = "any" \/ ~\E e \in f.todo : d \in Ancestors(e)}

\* orch: call the activity for d (a new frame); act: soft-delete d directly
\* A node is blocked when a failed node of this frame lies below it (or is it).
\* The policy is part of the strict path (act) or of the live orchestration (orch); frozen callers keep today's.
SkipAnc(f) == IF f.layer = "act" THEN SkipBlocked /\ Strict ELSE ~Frozen /\ OrchSkip = "all"
SkipTarget(f) == IF f.layer = "act" THEN SkipBlocked /\ Strict ELSE ~Frozen /\ OrchSkip \in {"root", "all"}
Blocked(f, d) == SkipAnc(f) /\ \E x \in f.failed : x = d \/ d \in Ancestors(x)

NextKid ==
    /\ ~done /\ stack # <<>> /\ Top.ph = "kids" /\ Top.cur = 0
    /\ IF Top.todo = {}
       THEN /\ IF SkipTarget(Top) /\ Top.failed # {}
               THEN SetTop([Top EXCEPT !.ph = "end", !.ok = FALSE])    \* never the target after a failure
               ELSE IF Top.layer = "orch"
               THEN stack' = <<Frame("act", T)>> \o <<[Top EXCEPT !.ph = "self"]>> \o Tail(stack)
               ELSE SetTop([Top EXCEPT !.ph = "self", !.tries = 0])
       ELSE \E d \in Eligible(Top) :
              IF Blocked(Top, d)
              THEN SetTop([Top EXCEPT !.todo = @ \ {d}, !.failed = @ \cup {d}, !.ok = FALSE])
              ELSE IF Top.layer = "orch"
              THEN stack' = <<Frame("act", d)>> \o <<[Top EXCEPT !.todo = @ \ {d}, !.cur = d]>> \o Tail(stack)
              ELSE SetTop([Top EXCEPT !.todo = @ \ {d}, !.cur = d, !.tries = 0])
    /\ UNCHANGED <<row, time, faults, replied, tOwnFail, done>>

\* act layer: one soft-delete attempt of the current descendant (or of the target, ph = "self")
Victim(f) == IF f.ph = "self" THEN f.tgt ELSE f.cur

ActAttempt ==
    /\ ~done /\ stack # <<>> /\ Top.layer = "act"
    /\ (Top.ph = "kids" /\ Top.cur # 0) \/ Top.ph = "self"
    /\ CanStart
    /\ LET f == Top
           v == Victim(f)
           success == row[v] = "deleted" \/ CanDelete(v)
       IN \E fault \in (IF faults < MaxFaults /\ success THEN {FALSE, TRUE} ELSE {FALSE}) :
          \E cost \in (IF fault /\ Hang THEN {1, HungCost} ELSE {1}) :
            LET ok1 == success /\ ~fault
                more == ~ok1 /\ f.tries + 1 < Retries
                guardHit == ~ok1 /\ ~more /\ v \notin PermFail /\ row[v] = "live"
                            /\ ActGuard /\ \E c \in Nodes : Par[c] = v /\ row[c] = "live"
            IN /\ time' = time + cost
               /\ faults' = faults + (IF fault THEN 1 ELSE 0)
               /\ row' = IF ok1 THEN [row EXCEPT ![v] = "deleted"] ELSE row
               \* only a failure that 1.0.84 would also meet today: not a guard refusal
               /\ tOwnFail' = (tOwnFail \/ (f.ph = "self" /\ v = T /\ ~ok1 /\ ~more /\ ~guardHit))
               /\ IF ok1
                  THEN SetTop(IF f.ph = "self" THEN [f EXCEPT !.ph = "end"]
                              ELSE [f EXCEPT !.cur = 0, !.tries = 0])
                  ELSE IF more
                  THEN SetTop([f EXCEPT !.tries = f.tries + 1])
                  ELSE IF f.ph = "self" /\ guardHit /\ f.rechecks < MaxRecheck
                  THEN SetTop([f EXCEPT !.ph = "enum", !.tries = 0, !.rechecks = f.rechecks + 1])
                  ELSE IF f.ph = "self"
                  THEN SetTop([f EXCEPT !.ph = "end", !.ok = FALSE])
                  ELSE IF ActStop
                  THEN SetTop([f EXCEPT !.ph = "end", !.ok = FALSE])
                  ELSE SetTop([f EXCEPT !.cur = 0, !.tries = 0, !.ok = (f.ok /\ ~ActReport),
                                        !.failed = @ \cup {v}])
    /\ UNCHANGED <<replied, done>>

\* The shared deadline is reached: the frame stops and reports failure.
Expire ==
    /\ ~done /\ stack # <<>> /\ ~CanStart
    /\ \/ Top.ph = "enum"
       \/ Top.layer = "act" /\ ((Top.ph = "kids" /\ Top.cur # 0) \/ Top.ph = "self")
    /\ SetTop([Top EXCEPT !.ph = "end", !.ok = FALSE])
    /\ UNCHANGED <<row, time, faults, replied, tOwnFail, done>>

\* act layer ends: its result returns to the orchestration frame below it
ActReturn ==
    /\ ~done /\ Len(stack) >= 2 /\ Top.layer = "act" /\ Top.ph = "end"
    /\ LET r == Top.ok
           o == stack[2]
           stop == ~Frozen /\ OrchAbort
           o2 == IF o.ph = "self"
                 THEN [o EXCEPT !.ph = "end", !.ok = o.ok /\ r]
                 ELSE IF r THEN [o EXCEPT !.cur = 0]
                 ELSE IF stop THEN [o EXCEPT !.ph = "end", !.ok = FALSE, !.cur = 0]
                 ELSE [o EXCEPT !.cur = 0, !.ok = (IF Frozen \/ ~ReportSkipped THEN o.ok ELSE FALSE),
                                !.failed = @ \cup {o.cur}]
       IN stack' = <<o2>> \o SubSeq(stack, 3, Len(stack))
    /\ UNCHANGED <<row, time, faults, replied, tOwnFail, done>>

\* the orchestration answers and ends
Answer ==
    /\ ~done /\ Len(stack) = 1 /\ Top.layer = "orch" /\ Top.ph = "end"
    /\ replied' = IF Frozen THEN replied ELSE IF Top.ok THEN "ok" ELSE "error"
    /\ done' = TRUE
    /\ stack' = <<>>
    /\ UNCHANGED <<row, time, faults, tOwnFail>>

\* another session spawns a child of a live parent (0094: refused under a deleted parent)
Spawn ==
    /\ \E n \in Spawnable :
        /\ row[n] = "absent" /\ Par[n] # 0 /\ row[Par[n]] = "live"
        /\ row' = [row EXCEPT ![n] = "live"]
    /\ UNCHANGED <<stack, time, faults, replied, tOwnFail, done>>

\* orch: when the listed descendants are done, it moves to T itself (frame pushed in NextKid)
Finished == done /\ UNCHANGED vars

Next == EnumOk \/ EnumFault \/ NextKid \/ ActAttempt \/ Expire \/ ActReturn \/ Answer \/ Spawn \/ Finished

Spec == Init /\ [][Next]_vars /\ WF_vars(EnumOk \/ NextKid \/ ActAttempt \/ Expire \/ ActReturn \/ Answer)

(* ---------------- properties ---------------- *)
TypeOK ==
    /\ row \in [Nodes -> {"absent", "live", "deleted"}]
    /\ replied \in {"none", "ok", "error"}

\* No live row under a deleted ancestor (none at the start).
Inv_NoNewOrphan ==
    \A n \in Nodes : row[n] = "live" => \A a \in Ancestors(n) : row[a] # "deleted"

\* "ok" means the whole subtree, including late spawns, is gone (1.0.85 only:
\* 1.0.84 answers before it acts, which FB-034 already records).
Inv_TruthfulReply ==
    (~Frozen /\ replied = "ok") => \A n \in Subtree(T) : row[n] # "live"

\* Frozen 1.0.84 is no worse than today: T's row survives only if T's own delete
\* failed for a reason 1.0.84 meets today (a guard refusal is new).
Inv_FrozenNoWorse ==
    (Frozen /\ done /\ row[T] = "live") => tOwnFail

\* The caller is answered within its patience.
Inv_InBudget == time <= Budget
Prop_Answers == <>done

(* Witnesses: each must be violated, showing the outcome is reachable. *)
W_NoOk == replied # "ok"
W_NoError == replied # "error"
W_NoLateSpawn == ~(done /\ \E n \in Spawnable : row[n] = "deleted")
==============================================================================
