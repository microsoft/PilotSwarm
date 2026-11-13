------------------------------ MODULE LeakChain ------------------------------
(***************************************************************************)
(* Chains of node types. The packet's per-hop model proves one hop; this    *)
(* one builds a legal chain of up to five sessions, one level per step, and *)
(* checks that authority never grows anywhere down the chain.               *)
(*                                                                          *)
(* Each level picks its own grant and ceiling, and its own EXECUTING worker *)
(* version from RolloutVersions. The whole run was ADMITTED under           *)
(* AdmitVersion. NoLeak compares what the executing worker gives against    *)
(* what the admitting version's rule allows, which is exactly where a mixed *)
(* fleet shows up.                                                          *)
(*                                                                          *)
(* Example chain, the one in the assignment:                                *)
(*   <<"spawnUnnamed","wf","namedStep","subUnnamed">>                       *)
(*   top -> unnamed child -> Workflow -> named step -> unnamed sub-agent    *)
(*   (nothing legal below a sub-agent of a step: Below says so)             *)
(***************************************************************************)
EXTENDS LeakCore

CONSTANTS
    ChainId,           \* names one of the shapes below (a .cfg cannot hold a tuple)
    TopTools,          \* the top-level session's capability tools
    AdmitVersion,      \* the version the run was admitted under
    RolloutVersions,   \* the versions a worker may be running when a level executes
    W1ToolNames,
    MutSubIgnoresCeiling,
    MutGrantUnchecked,
    MutTnSkipsCeiling,
    ConfineSpawn       \* TRUE: a 1.0.84 spawn turn only runs on a worker that advertises
                       \* the tool-composition tag, so it cannot land on W0 or WT

(* The shapes live here because TLC's configuration file accepts sets and   *)
(* strings but not tuples, so a case names a shape and the module holds it.  *)
ChainKinds ==
    CASE ChainId = "c1" -> <<"spawnUnnamed","wf","namedStep","subUnnamed">>
      [] ChainId = "c2" -> <<"spawnNamed","wf","inline","subNamed">>
      [] ChainId = "c3" -> <<"wf","namedStep","subNamed">>
      [] ChainId = "c4" -> <<"spawnUnnamed","spawnNamed","wf","script">>
      [] ChainId = "c5" -> <<"wf","inline","subUnnamed">>
      [] OTHER          -> <<"wf","namedStep">>

ASSUME IsLegalChain(ChainKinds)
ASSUME TopTools \subseteq Cap
ASSUME AdmitVersion \in Versions
ASSUME RolloutVersions \subseteq Versions

N == Len(ChainKinds)

ChainGrants == {[mode |-> "all", list |-> {}], [mode |-> "none", list |-> {}],
                [mode |-> "default", list |-> {}], [mode |-> "list", list |-> {"d1"}]}
ChainCeils  == {Off, [on |-> TRUE, set |-> {"spawn","wait","bash","cwn","d1"}]}
ChainDecls  == { {"pa"}, {"pb"} }
\* d2 sits OUTSIDE every ceiling below, which is what makes a bypass visible.
ChainTns    == { Off, [on |-> TRUE, set |-> {"d2"}] }

Flags == [grantUnchecked    |-> MutGrantUnchecked,
          ceilingCapsOnly   |-> FALSE,
          subIgnoresCeiling |-> MutSubIgnoresCeiling,
          noRequiredRefusal |-> FALSE,
          namedDefaultAll   |-> FALSE,
          mcpUnrestricted   |-> FALSE,
          tnSkipsCeiling    |-> MutTnSkipsCeiling]

VARIABLES
    lvl,      \* the next level to build, 1..N+1
    eff,      \* eff[i] : the tools level i holds under the executing worker
    ent,      \* ent[i] : the tools level i would hold under the admitting version
    decl,     \* decl[i] : that level's declared tools
    ceil,     \* ceil[i] : the ceiling in force at level i (inherited and narrowed)
    done      \* the chain stopped early because a level was refused

vars == <<lvl, eff, ent, decl, ceil, done>>

\* The ceiling in force at a level: a step's ceiling covers its whole subtree.
Narrow(outer, inner) ==
    IF ~outer.on THEN inner
    ELSE IF ~inner.on THEN outer
    ELSE [on |-> TRUE, set |-> outer.set \cap inner.set]

Init ==
    /\ lvl = 1
    /\ eff  = [i \in 1..N |-> {}]
    /\ ent  = [i \in 1..N |-> {}]
    /\ decl = [i \in 1..N |-> {}]
    /\ ceil = [i \in 1..N |-> Off]
    /\ done = FALSE

ParentCapImpl == IF lvl = 1 THEN TopTools ELSE eff[lvl-1] \cap Cap
ParentCapEnt  == IF lvl = 1 THEN TopTools ELSE ent[lvl-1] \cap Cap
OuterCeil     == IF lvl = 1 THEN Off ELSE ceil[lvl-1]

Build ==
    /\ ~done
    /\ lvl <= N
    /\ \E gg \in ChainGrants, cc0 \in ChainCeils, dd \in ChainDecls,
          wv \in RolloutVersions, tt0 \in ChainTns :
        \* A spawn is decided by the session orchestration, whose turns carry a
        \* routing tag (activity-routing.ts): a 1.0.84 turn reaches only a worker
        \* that advertises it. An AGENT STEP has no such tag - the Workflow
        \* controller did not change - so any worker may run one. That asymmetry
        \* is the difference between the two rolling cases below.
        /\ ~(ConfineSpawn /\ ChainKinds[lvl] \in SpawnKinds \cup SubKinds
             /\ wv # AdmitVersion)
        /\ LET k   == ChainKinds[lvl]
               cc  == Narrow(OuterCeil, IF k \in CeilKinds THEN cc0 ELSE Off)
               tt  == IF k \in TnKinds THEN tt0 ELSE Off
               \* Q3: a Workflow Start takes ALL of the starter and has no grant;
               \* a script step takes everything the Workflow session holds.
               gu  == IF k \in {"script","wf"} THEN [mode |-> "default", list |-> {}] ELSE gg
               ccOwn == IF k \in CeilKinds THEN cc0 ELSE Off
               rf  == RefuseOf(wv, k, ParentCapImpl, gu, cc, ccOwn, {}, tt, Flags, W1ToolNames)
           IN  IF rf
               THEN /\ done' = TRUE
                    /\ UNCHANGED <<eff, ent, decl, ceil>>
                    /\ lvl' = lvl
               ELSE /\ eff'  = [eff  EXCEPT ![lvl] =
                        EffOf(wv, k, ParentCapImpl, dd, gu, cc, FALSE, tt, Flags, W1ToolNames)]
                    /\ ent'  = [ent  EXCEPT ![lvl] =
                        EffOf(AdmitVersion, k, ParentCapEnt, dd, gu, cc, FALSE, tt, NoFlags, W1ToolNames)]
                    /\ decl' = [decl EXCEPT ![lvl] = Decl(k, dd)]
                    /\ ceil' = [ceil EXCEPT ![lvl] = cc]
                    /\ lvl'  = lvl + 1
                    /\ done' = done

Stop == /\ (done \/ lvl > N)
        /\ UNCHANGED vars

Next == Build \/ Stop
Spec == Init /\ [][Next]_vars

Built == {i \in 1..N : i < lvl}

(* ---------------- properties ---------------- *)

(* 1. NoLeak down a chain: no level holds more than the admitting version's  *)
(* rule allows it to hold.                                                   *)
Inv_NoLeak == \A i \in Built : eff[i] \subseteq ent[i]

(* 1'. The under-grant side, reported separately: a level holds FEWER tools  *)
(* than the admitting version's rule allows. Acceptable only where the docs  *)
(* say so, so it is a classifier, never a failure on its own.                *)
Inv_NoUnderGrant == \A i \in Built : ent[i] \subseteq eff[i]

(* 2. GrantChain, transitively: every capability tool a level holds came     *)
(* from its parent or from its own named agent's declaration.                *)
Inv_GrantChain ==
    \A i \in Built :
        (eff[i] \cap Cap) \subseteq
            ((IF i = 1 THEN TopTools ELSE eff[i-1] \cap Cap) \cup decl[i])

(* 3. CeilingCuts in the subtree: once a step limits its tools, no level at  *)
(* or below it holds anything outside that list.                             *)
Inv_CeilingCuts ==
    \A i \in Built :
        ceil[i].on =>
            eff[i] \subseteq (ceil[i].set \cup (IF ChainKinds[i] \in StepKinds THEN {CWN} ELSE {}))

Inv_Typed == \A i \in Built : eff[i] \subseteq AllTools
==============================================================================
