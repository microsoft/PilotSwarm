------------------------- MODULE SessionResurrection -------------------------
(***************************************************************************)
(* FB-046: cms_create_session's conflict branch resurrects a soft-deleted  *)
(* session id (WHERE deleted_at IS NOT NULL) and takes the requested       *)
(* parent and root, but moves nothing below it. A live session below the   *)
(* resurrected one then keeps the old root (stale visibility), and a       *)
(* Workflow below it can land under another Workflow's step. The fix:      *)
(* refuse a resurrection that changes the parent while any descendant is   *)
(* live, walking through deleted rows.                                      *)
(*                                                                         *)
(* Sessions: P1 and P2 are top-level and live. X is soft-deleted, under    *)
(* P1. Y is X's child, D is Y's child. Stored roots start at P1.            *)
(* Transactions (each a process; READ COMMITTED; row locks to commit):     *)
(*  T1  resurrect X under NewParent: lock the parent FOR SHARE and require *)
(*      it live (ParentCheck), lock X FOR UPDATE, the guard (GuardMode),   *)
(*      then the upsert: only if X is still deleted.                        *)
(*  T3  resurrect X under P1 (same parent), when Churn.                    *)
(*  T4  soft-delete X again (the cascade leaves its children), when Churn. *)
(*  T2  resurrect T2Target ("Y" or "D") under its own parent: lock the     *)
(*      parent FOR SHARE and require it live (ParentCheck), lock the row,  *)
(*      take the parent's stored root.                                      *)
(*  T5  (rs2) create X under P1, create Y under X (live), delete X; each  *)
(*      its own transaction.                                                *)
(* rs2 (FB-046 review, 2026-11-13): X may not exist when T1 starts         *)
(* (XAbsent). A row lock on a missing row locks nothing, so without more,  *)
(* T5 can run between T1's read and its upsert, which then resurrects X   *)
(* under its new parent without the guard. AbsentLock: "none"; "advisory" *)
(* (a transaction-scoped lock on X's id first, taken by every creator of   *)
(* that id, as the refuseDeleted path does); "insertFirst" (INSERT ... ON  *)
(* CONFLICT DO NOTHING first, then lock the row, which now exists).        *)
(* rs3 (FB-046 scope, FB-052): T6 creates a Workflow session W under X    *)
(* (cms_create_workflow_session, an insert that never resurrects); with   *)
(* WfCheck it locks X FOR SHARE and refuses a deleted X, as the widened   *)
(* 0094 requires; without, it reads X's root unlocked (the SQL today). T7  *)
(* creates Z under AdoptParent, which does not exist: an absent parent is *)
(* allowed (Z's root is Z itself). If that id is created later, Z is       *)
(* adopted with a stale root (FB-052, outside FB-046).                     *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    NewParent,     \* T1's requested parent: "P2" (a new parent), "P1" (the same), "Y" (its own child)
    DLive,         \* D is live at the start (left by a best-effort cascade)
    YLive,         \* Y is live at the start
    GuardMode,     \* "locked" (the design: after X's row lock), "preread" (before any lock), "none"
    WalkDeleted,   \* the guard's descendant scan goes through deleted rows
    ParentCheck,   \* every resurrection locks its parent FOR SHARE and refuses a deleted one
    Churn,         \* T3 and T4 run: X resurrected under P1, then deleted again
    T2Target,      \* "none", "Y" or "D"
    XAbsent,       \* rs2: X, Y and D do not exist at the start; T5 runs
    AbsentLock,    \* rs2: "none", "advisory" or "insertFirst"
    WfCreate,      \* rs3: T6 creates the Workflow session W under X
    WfCheck,       \* rs3: T6 locks X FOR SHARE and refuses a deleted X (absent allowed)
    Adopt,         \* rs3: T7 creates Z under AdoptParent, which does not exist
    AdoptParent    \* rs3: "X" (later created by T1 or T5) or "Q" (never created)

ASSUME NewParent \in {"P2", "P1", "Y"} /\ GuardMode \in {"locked", "preread", "none"}
ASSUME {DLive, YLive, WalkDeleted, ParentCheck, Churn} \subseteq BOOLEAN /\ T2Target \in {"none", "Y", "D"}
ASSUME XAbsent \in BOOLEAN /\ AbsentLock \in {"none", "advisory", "insertFirst"}
ASSUME XAbsent => (~Churn /\ T2Target = "none" /\ ~DLive /\ ~YLive /\ NewParent = "P2")
ASSUME {WfCreate, WfCheck, Adopt} \subseteq BOOLEAN /\ AdoptParent \in {"X", "Q"}
ASSUME (WfCreate => ~XAbsent) /\ (Adopt => XAbsent)

Nodes == {"P1", "P2", "X", "Y", "D", "W", "Z", "Q"}
Par0 == [n \in Nodes |-> CASE n = "X" -> "P1" [] n = "Y" -> "X" [] n = "D" -> "Y" [] n = "W" -> "X"
                            [] n = "Z" -> AdoptParent [] OTHER -> "none"]
Procs == {"t1"} \cup (IF Churn THEN {"t3", "t4"} ELSE {}) \cup (IF T2Target # "none" THEN {"t2"} ELSE {})
         \cup (IF XAbsent THEN {"t5"} ELSE {}) \cup (IF WfCreate THEN {"t6"} ELSE {}) \cup (IF Adopt THEN {"t7"} ELSE {})

VARIABLES par, del, root, lk, pc, pre, res, ex, adv, note, wroot, zroot
vars == <<par, del, root, lk, pc, pre, res, ex, adv, note, wroot, zroot>>

Init ==
    /\ par = Par0
    /\ del = [n \in Nodes |-> CASE n = "X" -> TRUE [] n = "Y" -> ~YLive [] n = "D" -> ~DLive [] OTHER -> FALSE]
    /\ root = [n \in Nodes |-> IF n = "P2" THEN "P2" ELSE "P1"]
    /\ lk = [n \in Nodes |-> {}]
    /\ pc = [p \in Procs |-> "start"]
    /\ pre = FALSE
    /\ res = [p \in Procs |-> "none"]
    /\ ex = [n \in Nodes |-> n \notin {"W", "Z", "Q"} /\ ~(XAbsent /\ n \in {"X", "Y", "D"})]
    /\ wroot = "none" /\ zroot = "none"
    /\ adv = "none"
    /\ note = "none"

Conflict(m1, m2) == m1 = "upd" \/ m2 = "upd"
CanLock(p, n, m) == \A x \in lk[n] : x[1] = p \/ ~Conflict(x[2], m)
Lock(p, n, m) == lk' = [lk EXCEPT ![n] = @ \cup {<<p, m>>}]
Release(p) == [n \in Nodes |-> {x \in lk[n] : x[1] # p}]
Finish(p, r) == /\ lk' = Release(p) /\ pc' = [pc EXCEPT ![p] = "done"] /\ res' = [res EXCEPT ![p] = r]
                 /\ adv' = IF adv = p THEN "none" ELSE adv

(* The guard: X's parent changes and a descendant of X is live.           *)
Kids(S) == {n \in Nodes : ex[n] /\ par[n] \in S}
Desc1 == Kids({"X"})
Desc2 == Kids({n \in Desc1 : WalkDeleted \/ ~del[n]})
Desc3 == Kids({n \in Desc2 : WalkDeleted \/ ~del[n]})
LiveDesc == \E n \in (Desc1 \cup Desc2 \cup Desc3) \ {"X"} : ex[n] /\ ~del[n]
Guard == par["X"] # NewParent /\ LiveDesc

(* ---------------- T1: resurrect X under NewParent ---------------- *)
T1Start ==
    /\ pc["t1"] = "start"
    /\ (AbsentLock = "advisory" => adv = "none")
    /\ adv' = IF AbsentLock = "advisory" THEN "t1" ELSE adv
    /\ pre' = (GuardMode = "preread" /\ Guard)
    /\ pc' = [pc EXCEPT !["t1"] = IF ParentCheck THEN "lockP" ELSE "lockX"]
    /\ UNCHANGED <<par, del, root, lk, res, ex, note>>

T1LockP ==
    /\ pc["t1"] = "lockP" /\ CanLock("t1", NewParent, "sh")
    /\ IF del[NewParent]
       THEN Finish("t1", "refused") /\ UNCHANGED <<par, del, root, pre, ex, note>>
       ELSE Lock("t1", NewParent, "sh") /\ pc' = [pc EXCEPT !["t1"] = "lockX"] /\ UNCHANGED <<par, del, root, pre, res, ex, adv, note>>

(* A row lock on a missing row locks nothing. insertFirst inserts X first *)
(* (under NewParent), so the row exists and is locked; a concurrent insert *)
(* of the same id waits for it.                                             *)
T1LockX ==
    /\ pc["t1"] = "lockX" /\ CanLock("t1", "X", "upd")
    /\ IF ex["X"]
       THEN Lock("t1", "X", "upd") /\ UNCHANGED <<par, del, root, ex, note>>
       ELSE IF AbsentLock = "insertFirst"
       THEN /\ Lock("t1", "X", "upd") /\ ex' = [ex EXCEPT !["X"] = TRUE] /\ del' = [del EXCEPT !["X"] = FALSE]
            /\ par' = [par EXCEPT !["X"] = NewParent] /\ root' = [root EXCEPT !["X"] = root[NewParent]]
            /\ note' = "created"
       ELSE UNCHANGED <<lk, par, del, root, ex>> /\ note' = "absent"
    /\ pc' = [pc EXCEPT !["t1"] = "commit"]
    /\ UNCHANGED <<pre, res, adv>>

T1Commit ==
    /\ pc["t1"] = "commit"
    /\ IF note = "created"
       THEN Finish("t1", "created") /\ UNCHANGED <<par, del, root, pre, ex>>
       ELSE IF ~ex["X"]
       THEN /\ ex' = [ex EXCEPT !["X"] = TRUE] /\ del' = [del EXCEPT !["X"] = FALSE]
            /\ par' = [par EXCEPT !["X"] = NewParent] /\ root' = [root EXCEPT !["X"] = root[NewParent]]
            /\ Finish("t1", "created") /\ UNCHANGED pre
       ELSE IF ~del["X"]
       THEN Finish("t1", "noop") /\ UNCHANGED <<par, del, root, pre, ex>>   \* a live row is never re-parented
       \* A guard decided on a missing row (note = "absent") is not run: the upsert resurrects without it.
       ELSE IF note # "absent" /\ ((GuardMode = "locked" /\ Guard) \/ (GuardMode = "preread" /\ pre))
       THEN Finish("t1", "refused") /\ UNCHANGED <<par, del, root, pre, ex>>
       ELSE /\ par' = [par EXCEPT !["X"] = NewParent] /\ del' = [del EXCEPT !["X"] = FALSE]
            /\ root' = [root EXCEPT !["X"] = root[NewParent]]
            /\ Finish("t1", "moved") /\ UNCHANGED <<pre, ex>>
    /\ UNCHANGED note

(* ---------------- T3: resurrect X under P1; T4: delete X again ---------------- *)
T3Lock ==
    /\ pc["t3"] = "start" /\ CanLock("t3", "P1", "sh") /\ CanLock("t3", "X", "upd")
    /\ lk' = [lk EXCEPT !["P1"] = @ \cup {<<"t3", "sh">>}, !["X"] = @ \cup {<<"t3", "upd">>}]
    /\ pc' = [pc EXCEPT !["t3"] = "commit"]
    /\ UNCHANGED <<par, del, root, pre, res, ex, adv, note>>
T3Commit ==
    /\ pc["t3"] = "commit"
    /\ IF del["X"] /\ par["X"] = "P1"
       THEN /\ del' = [del EXCEPT !["X"] = FALSE] /\ root' = [root EXCEPT !["X"] = root["P1"]] /\ Finish("t3", "moved")
       ELSE UNCHANGED <<del, root>> /\ Finish("t3", "noop")
    /\ UNCHANGED <<par, pre, ex, note>>

T4Lock ==
    /\ pc["t4"] = "start" /\ pc["t3"] = "done" /\ CanLock("t4", "X", "upd")
    /\ Lock("t4", "X", "upd") /\ pc' = [pc EXCEPT !["t4"] = "commit"]
    /\ UNCHANGED <<par, del, root, pre, res, ex, adv, note>>
T4Commit ==
    /\ pc["t4"] = "commit"
    /\ del' = [del EXCEPT !["X"] = TRUE] /\ Finish("t4", "deleted")
    /\ UNCHANGED <<par, root, pre, ex, note>>

(* ---------------- T2: resurrect T2Target under its own parent ---------------- *)
T2P == par[T2Target]
T2LockP ==
    /\ pc["t2"] = "start"
    /\ IF ~ParentCheck THEN pc' = [pc EXCEPT !["t2"] = "lockR"] /\ UNCHANGED <<lk, res, adv>>
       ELSE /\ CanLock("t2", T2P, "sh")
            /\ IF del[T2P] THEN Finish("t2", "refused")
               ELSE Lock("t2", T2P, "sh") /\ pc' = [pc EXCEPT !["t2"] = "lockR"] /\ UNCHANGED <<res, adv>>
    /\ UNCHANGED <<par, del, root, pre, ex, note>>
T2LockR ==
    /\ pc["t2"] = "lockR" /\ CanLock("t2", T2Target, "upd")
    /\ Lock("t2", T2Target, "upd") /\ pc' = [pc EXCEPT !["t2"] = "commit"]
    /\ UNCHANGED <<par, del, root, pre, res, ex, adv, note>>
T2Commit ==
    /\ pc["t2"] = "commit"
    /\ IF del[T2Target]
       THEN /\ del' = [del EXCEPT ![T2Target] = FALSE] /\ root' = [root EXCEPT ![T2Target] = root[T2P]]
            /\ Finish("t2", "moved")
       ELSE UNCHANGED <<del, root>> /\ Finish("t2", "noop")
    /\ UNCHANGED <<par, pre, ex, note>>

(* ---------------- T5 (rs2): create X under P1, Y under X, delete X ---------------- *)
\* Creating X takes X's id lock under "advisory"; a create of an id that exists changes nothing here.
T5CreateX ==
    /\ pc["t5"] = "start" /\ (AbsentLock = "advisory" => adv = "none") /\ CanLock("t5", "P1", "sh")
    /\ IF ex["X"] THEN UNCHANGED <<ex, del, par, root>>
       ELSE /\ ex' = [ex EXCEPT !["X"] = TRUE] /\ del' = [del EXCEPT !["X"] = FALSE]
            /\ par' = [par EXCEPT !["X"] = "P1"] /\ root' = [root EXCEPT !["X"] = root["P1"]]
    /\ pc' = [pc EXCEPT !["t5"] = "createY"]
    /\ UNCHANGED <<lk, pre, res, adv, note>>
\* Y under X: the parent X locked FOR SHARE and required live (ParentCheck).
T5CreateY ==
    /\ pc["t5"] = "createY" /\ (ParentCheck => CanLock("t5", "X", "sh"))
    /\ IF ex["X"] /\ (~del["X"] \/ ~ParentCheck)
       THEN /\ ex' = [ex EXCEPT !["Y"] = TRUE] /\ del' = [del EXCEPT !["Y"] = FALSE]
            /\ par' = [par EXCEPT !["Y"] = "X"] /\ root' = [root EXCEPT !["Y"] = root["X"]]
       ELSE UNCHANGED <<ex, del, par, root>>
    /\ pc' = [pc EXCEPT !["t5"] = "deleteX"]
    /\ UNCHANGED <<lk, pre, res, adv, note>>
T5DeleteX ==
    /\ pc["t5"] = "deleteX" /\ CanLock("t5", "X", "upd")
    /\ del' = IF ex["X"] THEN [del EXCEPT !["X"] = TRUE] ELSE del
    /\ pc' = [pc EXCEPT !["t5"] = "done"] /\ res' = [res EXCEPT !["t5"] = "done"]
    /\ UNCHANGED <<par, root, lk, pre, ex, adv, note>>

(* ---------------- T6 (rs3): create the Workflow session W under X ---------------- *)
T6Read ==
    /\ pc["t6"] = "start"
    /\ IF ~WfCheck
       THEN wroot' = (IF ex["X"] THEN root["X"] ELSE "W") /\ pc' = [pc EXCEPT !["t6"] = "insert"] /\ UNCHANGED <<lk, res, adv>>
       ELSE /\ CanLock("t6", "X", "sh")
            /\ IF ex["X"] /\ del["X"] THEN Finish("t6", "refused") /\ UNCHANGED wroot
               ELSE /\ (IF ex["X"] THEN Lock("t6", "X", "sh") ELSE UNCHANGED lk)
                    /\ wroot' = (IF ex["X"] THEN root["X"] ELSE "W")
                    /\ pc' = [pc EXCEPT !["t6"] = "insert"] /\ UNCHANGED <<res, adv>>
    /\ UNCHANGED <<par, del, root, pre, ex, note, zroot>>
T6Insert ==
    /\ pc["t6"] = "insert"
    /\ ex' = [ex EXCEPT !["W"] = TRUE] /\ del' = [del EXCEPT !["W"] = FALSE]
    /\ root' = [root EXCEPT !["W"] = wroot] /\ Finish("t6", "created")
    /\ UNCHANGED <<par, pre, note, wroot, zroot>>

(* ---------------- T7 (rs3): create Z under a parent with no row ---------------- *)
T7Read ==
    /\ pc["t7"] = "start" /\ CanLock("t7", AdoptParent, "sh")
    /\ IF ex[AdoptParent] /\ del[AdoptParent] THEN Finish("t7", "refused") /\ UNCHANGED zroot
       ELSE /\ (IF ex[AdoptParent] THEN Lock("t7", AdoptParent, "sh") ELSE UNCHANGED lk)
            /\ zroot' = (IF ex[AdoptParent] THEN root[AdoptParent] ELSE "Z")
            /\ pc' = [pc EXCEPT !["t7"] = "insert"] /\ UNCHANGED <<res, adv>>
    /\ UNCHANGED <<par, del, root, pre, ex, note, wroot>>
T7Insert ==
    /\ pc["t7"] = "insert"
    /\ ex' = [ex EXCEPT !["Z"] = TRUE] /\ del' = [del EXCEPT !["Z"] = FALSE]
    /\ root' = [root EXCEPT !["Z"] = zroot] /\ Finish("t7", "created")
    /\ UNCHANGED <<par, pre, note, wroot, zroot>>

Step(p) ==
    CASE p = "t1" -> T1Start \/ T1LockP \/ T1LockX \/ T1Commit
      [] p = "t3" -> T3Lock \/ T3Commit
      [] p = "t4" -> T4Lock \/ T4Commit
      [] p = "t5" -> T5CreateX \/ T5CreateY \/ T5DeleteX
      [] p = "t6" -> T6Read \/ T6Insert
      [] p = "t7" -> T7Read \/ T7Insert
      [] OTHER -> T2LockP \/ T2LockR \/ T2Commit

AllDone == \A p \in Procs : pc[p] = "done"
Frame(p) == IF p \in {"t6", "t7"} THEN TRUE ELSE UNCHANGED <<wroot, zroot>>
Next == (\E p \in Procs : Step(p) /\ Frame(p)) \/ (AllDone /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars

(* ---------------- properties ---------------- *)
RECURSIVE ChainRoot(_, _)
\* A session whose parent has no row resolves to itself (as cms_create_session stamps it).
ChainRoot(n, k) == IF par[n] = "none" \/ ~ex[par[n]] THEN n ELSE IF k = 0 THEN "cycle" ELSE ChainRoot(par[n], k - 1)

(* No live session sits in a parent cycle.                                  *)
Inv_NoCycle == \A n \in Nodes : (ex[n] /\ ~del[n]) => ChainRoot(n, 6) # "cycle"

(* Every live session's stored root is the root its parent chain reaches   *)
(* (authorization and visibility resolve through the stored root).          *)
Inv_NoStaleSubtree == \A n \in Nodes : (ex[n] /\ ~del[n] /\ ChainRoot(n, 6) # "cycle") => root[n] = ChainRoot(n, 6)

(* Witnesses: each must be violated (the outcome is reachable).            *)
W_NotMoved == res["t1"] # "moved"
W_NotRefused == res["t1"] # "refused"
W_NotCreated == res["t1"] # "created"
W_WfNotCreated == res["t6"] # "created"
=============================================================================
