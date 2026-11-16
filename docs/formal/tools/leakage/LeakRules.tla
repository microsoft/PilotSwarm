------------------------------ MODULE LeakRules ------------------------------
(***************************************************************************)
(* Tool leakage, ONE HOP. Does a single child, step or sub-agent ever end   *)
(* up holding a capability tool that the signed rule for its worker version *)
(* does not allow?                                                          *)
(*                                                                          *)
(* The state does not change: every input combination is an initial state   *)
(* and the invariants are checked on each one. The mutant flags are         *)
(* CONSTANTS, so a case that turns one on must violate the property it is   *)
(* paired with. That is how each property is shown to be able to fail.      *)
(***************************************************************************)
EXTENDS LeakCore

CONSTANTS
    KindsChecked,         \* which child kinds this case enumerates
    VersionsChecked,      \* which worker versions this case enumerates
    W1ToolNames,          \* "keep" = owner decision K; "refuse" = A2 as built
    MutGrantUnchecked,    \* mutant: a grant list is not checked against the parent
    MutCeilingCapsOnly,   \* mutant: the ceiling cuts only capability tools
    MutSubIgnoresCeiling, \* mutant: a sub-agent does not inherit the step's ceiling
    MutNoRequiredRefusal, \* mutant: a ceiling that omits a required tool does not refuse
    MutNamedDefaultAll,   \* mutant: a named agent's default grant is all
    MutMcpUnrestricted,   \* mutant: a grant passes a restricted MCP server to anyone
    MutTnSkipsCeiling     \* mutant: a tool_names spawn skips the inherited ceiling

ASSUME KindsChecked \subseteq Kinds
ASSUME VersionsChecked \subseteq Versions
ASSUME W1ToolNames \in {"keep","refuse"}

ParentSets == { {}, {"d1"}, {"d1","pa"}, {"pa","mr"}, {"d1","d2","pa","pb","mr"} }
DeclSets   == { {}, {"pa"}, {"pb"}, {"pb","mr"}, {"d2"} }
CeilSets   == { {}, {"d1"}, {"spawn","bash","d1"}, {"bash","d1","d2","pa","pb","mr"} }
Ceils      == {Off} \cup {[on |-> TRUE, set |-> s] : s \in CeilSets}
GrantLists == { {"d1"}, {"pa"}, {"pb"}, {"d1","pa"}, {"mr"} }
Grants     == {[mode |-> "all", list |-> {}], [mode |-> "none", list |-> {}],
               [mode |-> "default", list |-> {}]}
              \cup {[mode |-> "list", list |-> s] : s \in GrantLists}
TNs        == {Off} \cup {[on |-> TRUE, set |-> s] : s \in { {"d1"}, {"d2"}, {"pa"} }}
Reqs       == { {}, {"d1"}, {"pa"} }

VARIABLES v, kind, pc, d, g, c, cInh, r, tn, adm
vars == <<v, kind, pc, d, g, c, cInh, r, tn, adm>>

Init ==
    /\ v \in VersionsChecked
    /\ kind \in KindsChecked
    /\ c \in (IF kind \in CeilKinds THEN Ceils ELSE {Off})
    \* TRUE when the ceiling in force came from an ancestor rather than from
    \* this call. A sub-agent is always under its step's; a spawned child may
    \* be under one too. It cuts either way, but only its OWN refuses with K.
    /\ cInh \in (IF c.on /\ kind \notin {"wf","script"} THEN BOOLEAN ELSE {FALSE})
    \* a sub-agent's parent is its step, whose tools already sit inside the ceiling
    /\ pc \in {s \in ParentSets : (kind \in SubKinds /\ c.on) => s \subseteq c.set}
    /\ d  \in (IF kind \in NamedKinds THEN DeclSets ELSE {{}})
    /\ g  \in (IF kind = "script" THEN {[mode |-> "default", list |-> {}]} ELSE Grants)
    /\ r  \in (IF kind \in NamedKinds \cup StepKinds THEN Reqs ELSE {{}})
    /\ tn \in (IF kind \in TnKinds THEN TNs ELSE {Off})
    \* a restricted MCP server matches on a bound agent identity; an unnamed child has none
    /\ adm \in (IF kind \in NamedKinds THEN BOOLEAN ELSE {FALSE})

Next == UNCHANGED vars
Spec == Init /\ [][Next]_vars

Flags == [grantUnchecked    |-> MutGrantUnchecked,
          ceilingCapsOnly   |-> MutCeilingCapsOnly,
          subIgnoresCeiling |-> MutSubIgnoresCeiling,
          noRequiredRefusal |-> MutNoRequiredRefusal,
          namedDefaultAll   |-> MutNamedDefaultAll,
          mcpUnrestricted   |-> MutMcpUnrestricted,
          tnSkipsCeiling    |-> MutTnSkipsCeiling]

BaseImpl == BaseOf(v, kind, pc, d, g, adm, tn, Flags, W1ToolNames)
EffImpl == EffOf(v, kind, pc, d, g, c, adm, tn, Flags, W1ToolNames)
EffPure == EffOf(v, kind, pc, d, g, c, adm, tn, NoFlags, W1ToolNames)
COwn == IF cInh THEN Off ELSE c
RefImpl == RefuseOf(v, kind, pc, g, c, COwn, r, tn, Flags, W1ToolNames)
RefPure == RefuseOf(v, kind, pc, g, c, COwn, r, tn, NoFlags, W1ToolNames)

(* ---------------- properties ---------------- *)

(* 1. NoLeak. What the implementation gives stays inside what the signed    *)
(* rule for that same version allows.                                       *)
(*                                                                          *)
(* the review hazard (co1 review, 2026-11-13): this invariant's guard must    *)
(* not be the only thing standing between a mutant and a pass. A mutant     *)
(* that stops REFUSING makes RefImpl false while RefPure stays true, and    *)
(* the guard would then simply exclude exactly the states that mutant       *)
(* reaches. So acceptance divergence is stated separately, below, and       *)
(* every mutant case is an expected VIOLATION, never a silent pass.         *)
Inv_NoLeak == (~RefImpl /\ ~RefPure) => EffImpl \subseteq EffPure

(* 1b. The other direction of the same comparison: wherever the signed rule *)
(* REFUSES, the implementation must refuse too. A spawn the rule would have *)
(* turned away but the code lets through is a leak even when the resulting  *)
(* tool set looks ordinary.                                                 *)
Inv_NoExtraAccept == RefPure => RefImpl

(* 2. GrantChain, one hop: the granted part never exceeds the parent's      *)
(* capability tools. A named agent's declared tools are a separate source.  *)
Inv_GrantChain == (v = "W1" /\ ~RefImpl) => GrantSet(g, pc, kind, Flags) \subseteq pc

(* 3. CeilingCuts. Nothing outside the ceiling is reachable in the subtree  *)
(* of a limited step; only the step's own session keeps complete_workflow_node. *)
Inv_CeilingCuts ==
    (~RefImpl /\ c.on /\ CeilApplies(v, kind)) =>
        EffImpl \subseteq (c.set \cup (IF kind \in StepKinds THEN {CWN} ELSE {}))

(* 3b. A spawn or Start that goes ahead keeps every required tool it would  *)
(* otherwise have held. A ceiling that would drop one must refuse instead.  *)
(* Rule 4 arrives WITH Release A. 0.8.11 and the intermediate build simply cut a    *)
(* required tool and let the step fail at its first call, so this is scoped  *)
(* to W1 rather than reported as a defect of the older versions.             *)
Inv_RequiredKept ==
    (v = "W1" /\ ~RefImpl /\ c.on /\ CeilApplies(v, kind)) =>
        (r \cap BaseImpl) \subseteq EffImpl

(* 4. RestrictedMCP (Q2). A server the deployment restricts by allowedAgents *)
(* never reaches a child the deployment does not admit.                      *)
(* Q3 carves out Start: a Workflow session and its script steps take ALL of  *)
(* the starter's tools and have no agent identity to match on, so they are   *)
(* measured by Inv_McpNotViaStart instead, which is a question, not a goal.  *)
Inv_RestrictedMCP ==
    (~RefImpl /\ kind \notin {"wf","script"}) => (~adm => (EffImpl \cap Mcp) = {})

(* The Q2/Q3 interaction, stated so a case can answer it: does a restricted  *)
(* MCP server reach a Workflow session or a script step through Start?       *)
Inv_McpNotViaStart == (kind \in {"wf","script"}) => (EffImpl \cap Mcp) = {}

(* 6. LegacyToolNames. Classification, not a design goal: every capability  *)
(* tool a child holds came from its parent or from its own declaration.     *)
(* tool_names is the only way to break this.                                *)
Inv_LegacyToolNames ==
    ~RefImpl => (EffImpl \cap Cap) \subseteq (pc \cup Decl(kind, d))

Inv_Typed == EffImpl \subseteq AllTools
==============================================================================
