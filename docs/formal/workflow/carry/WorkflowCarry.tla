---------------------------- MODULE WorkflowCarry ----------------------------
(***************************************************************************)
(* FB-005 design model: opt-in per-state carry (design notes               *)
(* valkyrie-workflow-loops-design.md, sha256 bfb1ca31, and                 *)
(* fb005-carry-storage-design.md, sha256 cce4d9ad). A state S with carry   *)
(* runs in NB branches (each its own execution rows) and is visited V      *)
(* times in a loop: S -> successor -> S.                                   *)
(*                                                                         *)
(* One visit e = <<branch, visit>>: the controller evaluates the carry     *)
(* selection from the arriving input and the pinned KV; the admission      *)
(* transaction checks that the KV revision is still the evaluated one (a   *)
(* set_vars conflict re-evaluates), then writes the node with its          *)
(* carry_snapshot, input and KV revision at once. A failed carry selection *)
(* or input mapping admits an immediate invalid_input failure with no      *)
(* effect. The effect (script, send or agent) ends with a result or an     *)
(* error, first result wins. The successor receives {carry: snapshot,      *)
(* result}. A controller crash replays the enter activity: the existing    *)
(* node wins. A cancellation stops admissions and routes; a late result   *)
(* is recorded and routes nothing.                                         *)
(*                                                                         *)
(* A carry value is <<branch, visit, kv>>: whose arriving input it         *)
(* selected, and the KV value it read. Payload byte limits are not         *)
(* modelled (unit and integration tests).                                  *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    NB,                 \* branches (1 or 2), each with its own execution rows
    V,                  \* visits of S per branch (the loop)
    MaxKv,              \* set_vars changes of the run KV
    MaxCrash,           \* controller crashes (replays)
    OptIn,              \* S's IR declares carry
    Gate,               \* the carry gate of the run's controller version (FALSE: 1.0.0, the raw legacy path)
    GateIgnored,        \* fault: the controller honours an IR carry at 1.0.0
    Errors,             \* the effect may end with a runtime error
    CarryFail,          \* the carry selection of branch 1, visit 1 fails
    InputFail,          \* the input mapping of branch 1, visit 1 fails after the carry selection succeeded
    AllowCancel,        \* the run may be cancelled
    ReevalAtCompletion, \* fault: the carry is evaluated again when the result arrives
    NonAtomic,          \* fault: the snapshot is written after the node, in another transaction
    SharedCarry,        \* fault: the snapshot is kept per state and visit, shared by the branches
    ReevalOnReplay,     \* fault: a replayed admission overwrites the snapshot with a new evaluation
    LegacyOnError,      \* fault: an error result arrives raw, without the carry (today's behaviour)
    FailedCarryEffect   \* fault: a failed carry selection still admits the effect

ASSUME NB \in 1..2 /\ V \in 1..3 /\ MaxKv \in Nat /\ MaxCrash \in Nat
ASSUME {OptIn, Gate, GateIgnored, Errors, CarryFail, InputFail, AllowCancel, ReevalAtCompletion, NonAtomic, SharedCarry, ReevalOnReplay,
        LegacyOnError, FailedCarryEffect} \subseteq BOOLEAN

E == (1..NB) \X (1..V)
(* Carry applies only where the IR declares it and the run's controller    *)
(* version enables it.                                                     *)
Carry == OptIn /\ (Gate \/ GateIgnored)
Unset == <<0, 0, 0>>      \* no node row yet
Null == <<0, 0, 1>>       \* a stored SQL NULL snapshot
Raw == <<0, 1, 0>>        \* a raw arrival: no wrapper
Val(e, k) == <<e[1], e[2], k + 2>>   \* the carry of visit e, read with KV value k
Key(e) == IF SharedCarry THEN <<1, e[2]>> ELSE e
Keys == {Key(e) : e \in E}
Fails(e) == CarryFail /\ e = <<1, 1>>
MapFails(e) == InputFail /\ e = <<1, 1>>

VARIABLES
    kv,        \* the run KV's value (its revision)
    ph,        \* each visit: "wait", "idle", "eval", "admitted", "running", "done", "arrived"
    ev,        \* the evaluated selection and the KV value it read: <<value, kv>>
    admVal,    \* ghost: the selection the admission committed
    store,     \* carry_snapshot per execution row (per Key)
    written,   \* ghost: the row's snapshot was written once
    firstSnap, \* ghost: the snapshot first written
    res,       \* the node's result: "none", "ok", "err", "invalid"
    eff,       \* the effect started
    arrC,      \* the carry the successor received
    arrR,      \* the result the successor received
    crashes,
    cancelled

vars == <<kv, ph, ev, admVal, store, written, firstSnap, res, eff, arrC, arrR, crashes, cancelled>>

Values == {Val(e, k) : e \in E, k \in 0..MaxKv} \cup {Unset, Null, Raw}

TypeOK ==
    /\ kv \in 0..MaxKv
    /\ ph \in [E -> {"wait", "idle", "eval", "admitted", "running", "done", "arrived"}]
    /\ ev \in [E -> Values \X (0..MaxKv)]
    /\ admVal \in [E -> Values]
    /\ store \in [Keys -> Values] /\ written \in [Keys -> BOOLEAN] /\ firstSnap \in [Keys -> Values]
    /\ res \in [E -> {"none", "ok", "err", "invalid"}]
    /\ eff \in [E -> BOOLEAN]
    /\ arrC \in [E -> Values] /\ arrR \in [E -> {"none", "ok", "err", "invalid"}]
    /\ crashes \in 0..MaxCrash /\ cancelled \in BOOLEAN

Init ==
    /\ kv = 0
    /\ ph = [e \in E |-> IF e[2] = 1 THEN "idle" ELSE "wait"]
    /\ ev = [e \in E |-> <<Unset, 0>>]
    /\ admVal = [e \in E |-> Unset]
    /\ store = [k \in Keys |-> Unset] /\ written = [k \in Keys |-> FALSE] /\ firstSnap = [k \in Keys |-> Unset]
    /\ res = [e \in E |-> "none"] /\ eff = [e \in E |-> FALSE]
    /\ arrC = [e \in E |-> Unset] /\ arrR = [e \in E |-> "none"]
    /\ crashes = 0 /\ cancelled = FALSE

Write(k, x) ==
    /\ store' = [store EXCEPT ![k] = x]
    /\ written' = [written EXCEPT ![k] = TRUE]
    /\ firstSnap' = IF written[k] THEN firstSnap ELSE [firstSnap EXCEPT ![k] = x]

(* Evaluate the selection against the arriving input and the KV now.       *)
Eval(e) ==
    /\ ph[e] = "idle" /\ ~cancelled
    /\ ev' = [ev EXCEPT ![e] = <<IF Fails(e) THEN Null ELSE Val(e, kv), kv>>]
    /\ ph' = [ph EXCEPT ![e] = "eval"]
    /\ UNCHANGED <<kv, admVal, store, written, firstSnap, res, eff, arrC, arrR, crashes, cancelled>>

(* The admission transaction. A KV revision that moved: re-evaluate. An    *)
(* existing row wins (first wins).                                         *)
Admit(e) ==
    /\ ph[e] = "eval" /\ ~cancelled
    /\ IF ev[e][2] # kv
       THEN /\ ph' = [ph EXCEPT ![e] = "idle"]
            /\ UNCHANGED <<admVal, store, written, firstSnap, res>>
       ELSE LET sel == ev[e][1]
                failed == Fails(e) \/ MapFails(e)
                effect == ~failed \/ (Fails(e) /\ ~MapFails(e) /\ FailedCarryEffect)
            IN /\ admVal' = [admVal EXCEPT ![e] = IF Carry THEN sel ELSE Unset]
               /\ IF ~Carry \/ written[Key(e)] THEN UNCHANGED <<store, written, firstSnap>>
                  ELSE IF NonAtomic /\ ~failed THEN Write(Key(e), Null)
                  ELSE Write(Key(e), sel)
               /\ res' = IF effect THEN res ELSE [res EXCEPT ![e] = "invalid"]
               /\ ph' = [ph EXCEPT ![e] = IF effect THEN "admitted" ELSE "done"]
    /\ UNCHANGED <<kv, ev, eff, arrC, arrR, crashes, cancelled>>

(* NonAtomic: the snapshot's own later write, evaluated again.             *)
LateSnap(e) ==
    /\ NonAtomic /\ Carry /\ ph[e] \in {"admitted", "running", "done"} /\ store[Key(e)] = Null /\ ~Fails(e)
    /\ store' = [store EXCEPT ![Key(e)] = Val(e, kv)]
    /\ UNCHANGED <<kv, ph, ev, admVal, written, firstSnap, res, eff, arrC, arrR, crashes, cancelled>>

Start(e) ==
    /\ ph[e] = "admitted" /\ ~cancelled
    /\ eff' = [eff EXCEPT ![e] = TRUE] /\ ph' = [ph EXCEPT ![e] = "running"]
    /\ UNCHANGED <<kv, ev, admVal, store, written, firstSnap, res, arrC, arrR, crashes, cancelled>>

(* The effect's result (also after a cancellation: a late result).         *)
Finish(e) ==
    /\ ph[e] = "running"
    /\ \E r \in (IF Errors THEN {"ok", "err"} ELSE {"ok"}) : res' = [res EXCEPT ![e] = r]
    /\ ph' = [ph EXCEPT ![e] = "done"]
    /\ UNCHANGED <<kv, ev, admVal, store, written, firstSnap, eff, arrC, arrR, crashes, cancelled>>

(* A controller crash while the enter activity's result is not recorded:   *)
(* before the admission it runs again from the start; after it, the        *)
(* replayed admission meets the existing row, which wins.                  *)
Crash(e) ==
    /\ crashes < MaxCrash /\ ph[e] \in {"eval", "admitted", "running"}
    /\ crashes' = crashes + 1
    /\ IF ph[e] = "eval"
       THEN /\ ph' = [ph EXCEPT ![e] = "idle"] /\ UNCHANGED <<store, written, firstSnap>>
       ELSE /\ UNCHANGED ph
            /\ IF ReevalOnReplay /\ Carry /\ ~Fails(e)
               THEN store' = [store EXCEPT ![Key(e)] = Val(e, kv)] /\ UNCHANGED <<written, firstSnap>>
               ELSE UNCHANGED <<store, written, firstSnap>>
    /\ UNCHANGED <<kv, ev, admVal, res, eff, arrC, arrR, cancelled>>

(* The result arrives at the successor, which routes back to S.            *)
Arrive(e) ==
    /\ ph[e] = "done" /\ ~cancelled
    /\ arrC' = [arrC EXCEPT ![e] =
                   IF ~Carry THEN Raw
                   ELSE IF LegacyOnError /\ res[e] = "err" THEN Raw
                   ELSE IF ReevalAtCompletion THEN (IF Fails(e) THEN Null ELSE Val(e, kv))
                   ELSE store[Key(e)]]
    /\ arrR' = [arrR EXCEPT ![e] = res[e]]
    /\ ph' = [x \in E |-> IF x = e THEN "arrived"
                          ELSE IF x[1] = e[1] /\ x[2] = e[2] + 1 THEN "idle" ELSE ph[x]]
    /\ UNCHANGED <<kv, ev, admVal, store, written, firstSnap, res, eff, crashes, cancelled>>

SetVars ==
    /\ kv < MaxKv /\ kv' = kv + 1
    /\ UNCHANGED <<ph, ev, admVal, store, written, firstSnap, res, eff, arrC, arrR, crashes, cancelled>>

Cancel ==
    /\ AllowCancel /\ ~cancelled /\ cancelled' = TRUE
    /\ UNCHANGED <<kv, ph, ev, admVal, store, written, firstSnap, res, eff, arrC, arrR, crashes>>

Done == UNCHANGED vars

Step(e) == Eval(e) \/ Admit(e) \/ LateSnap(e) \/ Start(e) \/ Finish(e) \/ Arrive(e)

Next == (\E e \in E : Step(e) \/ Crash(e)) \/ SetVars \/ Cancel \/ Done

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ \A e \in E : WF_vars(Step(e))

(* ---------------- properties ---------------- *)
Wrapped(e) == ph[e] = "arrived" /\ Carry
(* An admitted snapshot never changes.                                     *)
Inv_SnapshotImmutable == \A k \in Keys : written[k] => store[k] = firstSnap[k]
(* The successor's carry is the snapshot the admission committed; current  *)
(* KV cannot alter it.                                                      *)
Inv_CarryIsAdmission == \A e \in E : (Wrapped(e) /\ arrC[e] # Raw) => arrC[e] = admVal[e]
(* No sibling's (or another visit's) snapshot arrives.                     *)
Inv_NoSiblingCarry == \A e \in E : (Wrapped(e) /\ arrC[e] \notin {Raw, Null}) => (arrC[e][1] = e[1] /\ arrC[e][2] = e[2])
(* An error result still arrives with its carry; the result is the node's. *)
Inv_CarryOnError == \A e \in E : Wrapped(e) => (arrC[e] # Raw /\ arrR[e] = res[e])
(* No effect before a valid admission with its snapshot.                   *)
Inv_NoEffectBeforeAdmit ==
    \A e \in E : eff[e] => (admVal[e] # Null /\ (Carry => written[Key(e)] /\ store[Key(e)] # Null))
(* A failed carry selection admits no effect.                              *)
Inv_FailedCarryNoEffect == \A e \in E : Fails(e) => ~eff[e]
(* The legacy path: no snapshot, raw arrival.                              *)
Inv_LegacyShape == ~Carry => \A e \in E : (ph[e] = "arrived" => arrC[e] = Raw) /\ \A k \in Keys : ~written[k]
(* Controller 1.0.0 routes raw results and writes no snapshot, even when   *)
(* the IR declares carry.                                                  *)
Inv_GateHolds == ~Gate => \A e \in E : (ph[e] = "arrived" => arrC[e] = Raw) /\ \A k \in Keys : ~written[k]

Prop_Progresses == <>(cancelled \/ \A e \in E : ph[e] = "arrived")

(* Witnesses: each must be violated.                                       *)
W_NoCarriedError == ~\E e \in E : Wrapped(e) /\ arrR[e] = "err"
W_NoKvChangeAfterAdmission == ~\E e \in E : Wrapped(e) /\ arrC[e] \notin {Raw, Null} /\ arrC[e][3] # kv + 2
W_NoInvalidWithSnapshot == ~\E e \in E : Wrapped(e) /\ arrR[e] = "invalid" /\ arrC[e] \notin {Raw, Null}
=============================================================================
