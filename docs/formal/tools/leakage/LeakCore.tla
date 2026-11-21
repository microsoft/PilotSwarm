------------------------------ MODULE LeakCore -------------------------------
(***************************************************************************)
(* The composition rule itself, as pure operators, shared by every module   *)
(* in this packet. No CONSTANTS: every switch is an argument, so one        *)
(* definition of the rule serves the per-hop, chain and stored-artifact     *)
(* models and they cannot drift apart.                                      *)
(*                                                                          *)
(* Source: docs/proposals/workflows/tool-composition.md, sections 2-5 and 8 *)
(* W0: baseline; WT: intermediate Workflow build; W1: Release A.           *)
(***************************************************************************)
EXTENDS FiniteSets, Naturals, Sequences

(* ---------------- the tool universe ---------------- *)
Plat == {"spawn", "wait"}
Cli  == {"bash"}
CWN  == "cwn"
Dep  == {"d1", "d2"}
PkgA == {"pa"}
PkgB == {"pb"}
Mcp  == {"mr"}
Pkg  == PkgA \cup PkgB
Cap  == Dep \cup Pkg \cup Mcp
AllTools == Plat \cup Cli \cup Cap \cup {CWN}

Kinds == {"spawnUnnamed","spawnNamed","wf","script","inline","namedStep","subUnnamed","subNamed"}
NamedKinds        == {"spawnNamed","namedStep","subNamed"}
StepKinds         == {"inline","namedStep"}
SubKinds          == {"subUnnamed","subNamed"}
SpawnKinds        == {"spawnUnnamed","spawnNamed"}
UnnamedSpawnKinds == {"spawnUnnamed","subUnnamed"}
CeilKinds         == Kinds \ {"wf","script"}
OldCeilKinds      == StepKinds \cup SubKinds
TnKinds           == UnnamedSpawnKinds
Versions          == {"W0","WT","W1"}

Off == [on |-> FALSE, set |-> {}]

NoFlags == [grantUnchecked    |-> FALSE, ceilingCapsOnly   |-> FALSE,
            subIgnoresCeiling |-> FALSE, noRequiredRefusal |-> FALSE,
            namedDefaultAll   |-> FALSE, mcpUnrestricted   |-> FALSE,
            tnSkipsCeiling    |-> FALSE]

(* ---------------- shared pieces ---------------- *)
Role(k) == CASE k \in SpawnKinds \cup SubKinds -> Plat \cup Cli
             [] k \in {"wf","script"}          -> {}
             [] k \in StepKinds                -> Plat \cup Cli \cup {CWN}
             [] OTHER                          -> {}

Decl(k, dd)      == IF k \in NamedKinds THEN dd ELSE {}
OwnDecl(k, dd)   == IF k \in NamedKinds THEN dd \ PkgB ELSE {}

(* Q2: a server the deployment restricts by allowedAgents reaches only a    *)
(* child the deployment admits. Q3 carves Start out of that: a Workflow     *)
(* Start is not a grant, it captures ALL of the starter's capabilities, and *)
(* a Workflow session has no agent identity for an allowlist to match on.   *)
(* So the gate is open for a Workflow session and its script steps.         *)
McpGate(k, a, mu, s) ==
    IF k \in {"wf","script"} \/ a \/ mu THEN s ELSE s \ Mcp

(* ---------------- the new rule (W1) ---------------- *)
DefaultMode(k, f) == IF k \in NamedKinds /\ ~f.namedDefaultAll THEN "none" ELSE "all"
DefaultGrant(k, f) == [mode |-> DefaultMode(k, f), list |-> {}]

(* "default" means the caller gave no grant at all, which is the ordinary   *)
(* case and the only one in which the default rule is observable.           *)
GrantSet(gg, p, k, f) ==
    CASE gg.mode = "all"     -> p
      [] gg.mode = "none"    -> {}
      [] gg.mode = "default" -> (IF DefaultMode(k, f) = "all" THEN p ELSE {})
      [] OTHER               -> gg.list

NewBase(k, p, dd, gg, a, f) ==
    McpGate(k, a, f.mcpUnrestricted, Role(k) \cup Decl(k, dd) \cup GrantSet(gg, p, k, f))

CeilOnNew(k, cc, f) == cc.on /\ k \in CeilKinds /\ ~(f.subIgnoresCeiling /\ k \in SubKinds)
CutBy(k, cc, base, f) ==
    (base \cap (IF f.ceilingCapsOnly THEN cc.set \cup Plat \cup Cli \cup {CWN} ELSE cc.set))
      \cup (IF k \in StepKinds THEN {CWN} ELSE {})

NewEff(k, p, dd, gg, cc, a, f) ==
    LET b == NewBase(k, p, dd, gg, a, f)
    IN  IF CeilOnNew(k, cc, f) THEN CutBy(k, cc, b, f) ELSE b

(* Option K (owner 04:01Z): tool_names keeps its exact 0.8.11 meaning on    *)
(* orchestration 1.0.84. It REPLACES the child's agent tool list and any    *)
(* registered tool name binds, even one the parent does not hold.           *)
(* The spawn path that takes tool_names must still be cut by the ceiling    *)
(* the child inherited. f.tnSkipsCeiling models the defect the review found at  *)
(* pre-fix snapshot: a child limited to tools: [a] spawns a grandchild with         *)
(* tool_names: [d], and that path never applied the inherited ceiling.      *)
W1Eff(k, p, dd, gg, cc, a, t, f, tnPolicy) ==
    IF t.on /\ k \in TnKinds /\ tnPolicy = "keep"
    THEN LET b == Role(k) \cup (t.set \ (Pkg \cup Mcp))
         IN  IF CeilOnNew(k, cc, f) /\ ~f.tnSkipsCeiling THEN CutBy(k, cc, b, f) ELSE b
    ELSE NewEff(k, p, dd, gg, cc, a, f)

(* ccOwn is the ceiling this very call passed; cc is the one in force, which *)
(* may have been inherited from an ancestor. Decision K refuses tool_names   *)
(* only when the SAME call also passes tools:. An inherited ceiling does not *)
(* refuse - it must simply cut, which is the whole point of pre-fix snapshot.        *)
W1Refuse(k, p, gg, cc, ccOwn, rr, t, f, tnPolicy) ==
    \/ (gg.mode = "list" /\ ~(gg.list \subseteq p) /\ ~f.grantUnchecked)
    \/ (CeilOnNew(k, cc, f) /\ ~(rr \subseteq cc.set) /\ ~f.noRequiredRefusal)
    \/ (t.on /\ k \in TnKinds /\ tnPolicy = "refuse")
    \/ (t.on /\ k \in TnKinds /\ tnPolicy = "keep" /\ (gg.mode # "default" \/ ccOwn.on))
    \/ (t.on /\ k \in TnKinds /\ tnPolicy = "keep" /\ (t.set \cap Pkg) # {})

(* ---------------- 0.8.11 (W0) and the intermediate build (WT) ---------------- *)
OldSpawnSrc(p, t) == IF t.on THEN t.set ELSE p
OldBase(ver, k, p, dd, a, t, f) ==
    CASE k \in UnnamedSpawnKinds ->
            Role(k) \cup (OldSpawnSrc(p, t) \ (Pkg \cup Mcp))
      [] k \in NamedKinds ->
            McpGate(k, a, f.mcpUnrestricted, Role(k) \cup OwnDecl(k, dd))
              \cup (IF ver = "WT" /\ k = "namedStep"
                    THEN McpGate(k, a, f.mcpUnrestricted, p) ELSE {})
      [] k \in {"wf","script"} -> p
      [] k = "inline" ->
            Role(k) \cup (IF ver = "WT" THEN McpGate(k, a, f.mcpUnrestricted, p) ELSE {})
      [] OTHER -> Role(k)

OldEff(ver, k, p, dd, cc, a, t, f) ==
    LET b == OldBase(ver, k, p, dd, a, t, f)
    IN  IF cc.on /\ k \in OldCeilKinds
        THEN (b \cap cc.set) \cup (IF k \in StepKinds THEN {CWN} ELSE {})
        ELSE b

OldRefuse(k, t) == k \in TnKinds /\ t.on /\ (t.set \cap Pkg) # {}

(* ---------------- dispatch ---------------- *)
EffOf(ver, k, p, dd, gg, cc, a, t, f, tnPolicy) ==
    IF ver = "W1" THEN W1Eff(k, p, dd, gg, cc, a, t, f, tnPolicy)
                  ELSE OldEff(ver, k, p, dd, cc, a, t, f)
RefuseOf(ver, k, p, gg, cc, ccOwn, rr, t, f, tnPolicy) ==
    IF ver = "W1" THEN W1Refuse(k, p, gg, cc, ccOwn, rr, t, f, tnPolicy) ELSE OldRefuse(k, t)

(* The tools a child would hold BEFORE the ceiling cuts. Rule 4 is about    *)
(* exactly this set: a ceiling may not silently drop a required tool.       *)
BaseOf(ver, k, p, dd, gg, a, t, f, tnPolicy) ==
    IF ver = "W1"
    THEN (IF t.on /\ k \in TnKinds /\ tnPolicy = "keep"
          THEN Role(k) \cup (t.set \ (Pkg \cup Mcp))
          ELSE NewBase(k, p, dd, gg, a, f))
    ELSE OldBase(ver, k, p, dd, a, t, f)

CeilApplies(ver, k) == IF ver = "W1" THEN k \in CeilKinds ELSE k \in OldCeilKinds

(* ---------------- legal chains of node types ---------------- *)
(* Who may appear directly below whom. A Workflow session is started by a   *)
(* session; its steps hang off it; a step may spawn sub-agents; a sub-agent *)
(* of a step may not spawn further (spec row 8).                            *)
Below(k) ==
    CASE k = "top"          -> {"spawnUnnamed","spawnNamed","wf"}
      [] k = "spawnUnnamed" -> {"spawnUnnamed","spawnNamed","wf"}
      [] k = "spawnNamed"   -> {"spawnUnnamed","spawnNamed","wf"}
      [] k = "wf"           -> {"script","inline","namedStep"}
      [] k = "script"       -> {}
      [] k = "inline"       -> {"subUnnamed","subNamed"}
      [] k = "namedStep"    -> {"subUnnamed","subNamed"}
      [] OTHER              -> {}

IsLegalChain(ch) ==
    /\ Len(ch) > 0
    /\ ch[1] \in Below("top")
    /\ \A i \in 2..Len(ch) : ch[i] \in Below(ch[i-1])
==============================================================================
