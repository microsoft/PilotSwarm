---------------------------- MODULE RetirementPass ----------------------------
EXTENDS Integers, FiniteSets

CONSTANT FaultLostRequest
ASSUME FaultLostRequest \in BOOLEAN

Clients == {"a", "b"}
None == "none"
Order == <<"a", "b">>

VARIABLES live, owners, phase, cursor, stopping, requested, overlap
vars == <<live, owners, phase, cursor, stopping, requested, overlap>>

Init ==
    /\ live = Clients /\ owners = {"a"}
    /\ phase = "scan" /\ cursor = 1 /\ stopping = None
    /\ requested = FALSE /\ overlap = FALSE

(* Releasing a skipped owner during another client's awaited stop must request a new pass. *)
ReleaseOwner ==
    /\ owners = {"a"} /\ owners' = {}
    /\ overlap' = (overlap \/ (phase = "await" /\ cursor = 2))
    /\ requested' = IF phase = "idle" THEN FALSE ELSE ~FaultLostRequest
    /\ phase' = IF phase = "idle" THEN "scan" ELSE phase
    /\ cursor' = IF phase = "idle" THEN 1 ELSE cursor
    /\ UNCHANGED <<live, stopping>>

Scan ==
    /\ phase = "scan" /\ cursor <= 2
    /\ IF Order[cursor] \in owners \/ Order[cursor] \notin live
       THEN /\ cursor' = cursor + 1
            /\ UNCHANGED <<phase, stopping>>
       ELSE /\ phase' = "await" /\ stopping' = Order[cursor]
            /\ UNCHANGED cursor
    /\ UNCHANGED <<live, owners, requested, overlap>>

StopCompletes ==
    /\ phase = "await" /\ stopping \notin owners
    /\ live' = live \ {stopping} /\ stopping' = None
    /\ phase' = "scan" /\ cursor' = cursor + 1
    /\ UNCHANGED <<owners, requested, overlap>>

FinishPass ==
    /\ phase = "scan" /\ cursor = 3
    /\ phase' = IF requested THEN "scan" ELSE "idle"
    /\ cursor' = 1 /\ requested' = FALSE
    /\ UNCHANGED <<live, owners, stopping, overlap>>

Idle == UNCHANGED vars
Next == ReleaseOwner \/ Scan \/ StopCompletes \/ FinishPass \/ Idle
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Scan) /\ WF_vars(StopCompletes) /\ WF_vars(FinishPass)

TypeOK ==
    /\ live \subseteq Clients /\ owners \subseteq live
    /\ phase \in {"idle", "scan", "await"} /\ cursor \in 1..3
    /\ stopping \in Clients \cup {None}
    /\ requested \in BOOLEAN /\ overlap \in BOOLEAN
Inv_StopUnowned == phase = "await" => stopping \notin owners
Prop_ReleasedClientsDrain == (owners = {}) ~> (live = {})
W_NoReleaseDuringStop == ~overlap
=============================================================================
