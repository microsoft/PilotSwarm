------------------------------ MODULE LeakStore ------------------------------
(***************************************************************************)
(* Stored artifacts, package events and rollouts over time.                 *)
(*                                                                          *)
(* The per-hop and chain models ask "given these inputs, what does the rule *)
(* give?". This one asks the question that a rollout actually poses: a      *)
(* Workflow was STARTED by one worker version and its agent step RUNS on    *)
(* another, reading whatever that first version left in the database.       *)
(*                                                                          *)
(* Binding provenance, from source:                                         *)
(*   W0 start  -> prov "none":       no agentStepTools field at all.        *)
(*                On W1, readWorkflowAgentBinding returns null              *)
(*                (session-manager.ts:4077) -> declared tools only.         *)
(*   WT start  -> prov "selections": agentStepTools = "selections"          *)
(*                (session-manager.ts:3935) but agentStepBindings does not  *)
(*                exist at WT at all. On W1 workflowAgentStepBinding        *)
(*                returns the ROOT binding (tool-policy.ts:129), so         *)
(*                agentStepStateId is unset and session-manager.ts:2672-79  *)
(*                takes the legacy branch, where store.ts:6209 computes     *)
(*                   const grant = node.grant ?? "all";                     *)
(*   W1 start  -> prov "pinned":     agentStepBindings captured once at     *)
(*                Start (workflow/service.ts:817) and used verbatim.        *)
(*                                                                          *)
(* An absent grant STAYS ABSENT in the stored revision (spec 5.5), so       *)
(* irGrant = "absent" is the ordinary case, not a corner.                   *)
(***************************************************************************)
EXTENDS LeakCore

CONSTANTS
    StartVersions,     \* the versions the Workflow may have been started on
    RolloutVersions,   \* the versions a worker may be running later
    Monotone,          \* TRUE = stop-all: once every worker is W1 it never goes back
    IrGrants,          \* which stored grant forms this case enumerates
    StepKind,          \* "namedStep" or "inline"
    Starter,           \* the starting session's capability tools, captured at Start
    MutLegacyDefaultNone, \* the proposed fix: the legacy path uses the role default
    MutLivePin,           \* mutant: a child's tools follow the parent's live set
    IncludeHandOver       \* design-only handover is on hold: its event is reported on its own

ASSUME StartVersions \subseteq Versions
ASSUME RolloutVersions \subseteq Versions
ASSUME StepKind \in StepKinds
ASSUME Starter \subseteq Cap

IrGrantForms == {"absent", "none", "all", "listD1"}
ASSUME IrGrants \subseteq IrGrantForms

Decls == {"pa"}            \* the named step agent's own declared tool

GrantOfIr(f, k) ==
    CASE f = "none"   -> [mode |-> "none", list |-> {}]
      [] f = "all"    -> [mode |-> "all",  list |-> {}]
      [] f = "listD1" -> [mode |-> "list", list |-> {"d1"}]
      \* the signed default: none for a named step, all for an inline step
      [] OTHER        -> DefaultGrant(k, NoFlags)

VARIABLES
    stepLost,   \* the lost packages and the worker AS AT the moment the step ran
    stepWorker,
    stepEnt,    \* the three yardsticks, captured when the step ran, never later
    stepEntSpec,
    stepEntSigned,
    startVer,   \* the version that started the Workflow
    irGrant,    \* the stored grant form on the agent node
    workerVer,  \* the version of the worker running right now
    upgraded,   \* the fleet has reached W1 at least once
    live,       \* the parent's LIVE capability tools: package activation load and unload move this
    lostPkg,    \* packages whose pinned version was deleted, disabled or made private
    stepEff,    \* what the agent step holds the last time it ran
    ran,        \* the step has run at least once
    childEff,   \* a child spawned by that step: pinned at spawn
    childAt,    \* what it was given at spawn, kept for comparison
    spawned,
    handedOver  \* design-only handover moved the Workflow to a successor session

vars == <<startVer, irGrant, workerVer, upgraded, live, lostPkg,
          stepEff, stepLost, stepWorker, stepEnt, stepEntSpec, stepEntSigned, ran,
          childEff, childAt, spawned, handedOver>>

Prov(sv) == CASE sv = "W0" -> "none" [] sv = "WT" -> "selections" [] OTHER -> "pinned"

\* Only a lost package's own tools stop (spec 2.6).
Surviving(s) == IF "A" \in lostPkg THEN s \ PkgA ELSE s

(***************************************************************************)
(* What the step ACTUALLY gets, following the code paths above.            *)
(***************************************************************************)
StepEffective(sv, wv, ir) ==
    LET k == StepKind
        decls == Decls
    IN
    CASE wv = "W0" ->
            \* 0.8.11 has no agent-step delegation at all
            Role(k) \cup (IF k = "namedStep" THEN Surviving(decls) ELSE {})
      [] wv = "WT" ->
            \* WT knows nothing of grant, so a stored grant is simply dropped
            Role(k) \cup (IF k = "namedStep" THEN Surviving(decls) ELSE {}) \cup Surviving(Starter)
      [] OTHER ->
            CASE Prov(sv) = "none" ->
                    Role(k) \cup (IF k = "namedStep" THEN Surviving(decls) ELSE {})
              [] Prov(sv) = "pinned" ->
                    Role(k) \cup (IF k = "namedStep" THEN Surviving(decls) ELSE {})
                      \cup Surviving(GrantSet(GrantOfIr(ir, k), Starter, k, NoFlags))
              [] OTHER ->
                    \* the legacy path: store.ts:6209  node.grant ?? "all"
                    LET g == IF ir = "absent"
                             THEN (IF MutLegacyDefaultNone
                                   THEN DefaultGrant(k, NoFlags)
                                   ELSE [mode |-> "all", list |-> {}])
                             ELSE GrantOfIr(ir, k)
                    IN  Role(k) \cup (IF k = "namedStep" THEN Surviving(decls) ELSE {})
                          \cup Surviving(GrantSet(g, Starter, k, NoFlags))

(***************************************************************************)
(* Three yardsticks, deliberately kept apart.                              *)
(***************************************************************************)
\* a. the rule of the version that admitted the run
EntAdmit(sv, ir) ==
    LET k == StepKind IN
    CASE sv = "W0" -> Role(k) \cup (IF k = "namedStep" THEN Surviving(Decls) ELSE {})
      [] sv = "WT" -> Role(k) \cup (IF k = "namedStep" THEN Surviving(Decls) ELSE {}) \cup Surviving(Starter)
      [] OTHER     -> Role(k) \cup (IF k = "namedStep" THEN Surviving(Decls) ELSE {})
                        \cup Surviving(GrantSet(GrantOfIr(ir, k), Starter, k, NoFlags))

\* b. what spec 5.3 claims: a running Workflow's steps keep the 0.8.11 set
EntSpec53 == Role(StepKind) \cup (IF StepKind = "namedStep" THEN Surviving(Decls) ELSE {})

\* c. the signed rule itself: a named step defaults to none
EntSigned(ir) ==
    Role(StepKind) \cup (IF StepKind = "namedStep" THEN Surviving(Decls) ELSE {})
      \cup Surviving(GrantSet(GrantOfIr(ir, StepKind), Starter, StepKind, NoFlags))

Init ==
    /\ startVer \in StartVersions
    \* Neither 0.8.11 nor the intermediate build has a grant field in its compiler, so a
    \* revision they compiled cannot carry one. Only a Release A Start can.
    /\ irGrant \in (IF "W1" \in StartVersions THEN IrGrants ELSE {"absent"})
    /\ (startVer # "W1") => (irGrant = "absent")
    /\ workerVer \in RolloutVersions
    /\ upgraded = (workerVer = "W1")
    /\ live = Starter
    /\ lostPkg = {}
    /\ stepEff = {}
    /\ stepLost = {}
    /\ stepWorker = "none"
    /\ stepEnt = {}
    /\ stepEntSpec = {}
    /\ stepEntSigned = {}
    /\ ran = FALSE
    /\ childEff = {}
    /\ childAt = {}
    /\ spawned = FALSE
    /\ handedOver = FALSE

\* The worker that picks up the next turn. Stop-all: once the fleet is W1 no
\* old worker is left, so it can never go back.
ShiftWorker ==
    /\ \E w \in RolloutVersions :
        /\ ~(Monotone /\ upgraded /\ w # "W1")
        /\ workerVer' = w
        /\ upgraded' = (upgraded \/ w = "W1")
    /\ UNCHANGED <<startVer, irGrant, live, lostPkg, stepEff, stepLost, stepWorker, stepEnt, stepEntSpec, stepEntSigned, ran,
                   childEff, childAt, spawned, handedOver>>

RunStep ==
    /\ stepEff' = StepEffective(startVer, workerVer, irGrant)
    /\ stepLost' = lostPkg
    /\ stepWorker' = workerVer
    /\ stepEnt' = EntAdmit(startVer, irGrant)
    /\ stepEntSpec' = EntSpec53
    /\ stepEntSigned' = EntSigned(irGrant)
    /\ ran' = TRUE
    /\ UNCHANGED <<startVer, irGrant, workerVer, upgraded, live, lostPkg,
                   childEff, childAt, spawned, handedOver>>

\* package activation: the parent loads or unloads after the Start. Neither reaches
\* anything already pinned.
LoadPackage ==
    /\ live' = live \cup PkgB
    \* A correct pin ignores this entirely. The mutant lets the live set reach
    \* a child that already exists, which is exactly what rule 5 forbids.
    /\ childEff' = IF MutLivePin /\ spawned THEN childEff \cup PkgB ELSE childEff
    /\ UNCHANGED <<startVer, irGrant, workerVer, upgraded, lostPkg, stepEff, stepLost, stepWorker, stepEnt, stepEntSpec, stepEntSigned, ran,
                   childAt, spawned, handedOver>>
UnloadPackage ==
    /\ live' = live \ PkgA
    /\ UNCHANGED <<startVer, irGrant, workerVer, upgraded, lostPkg, stepEff, stepLost, stepWorker, stepEnt, stepEntSpec, stepEntSigned, ran,
                   childEff, childAt, spawned, handedOver>>

\* Republish alone changes nothing: the pin holds (spec 2.6 row 1).
Republish == UNCHANGED vars

\* The pinned version is deleted, disabled or made private: only that
\* package's tools stop.
LosePackage ==
    /\ lostPkg' = lostPkg \cup {"A"}
    /\ UNCHANGED <<startVer, irGrant, workerVer, upgraded, live, stepEff, stepLost, stepWorker, stepEnt, stepEntSpec, stepEntSigned, ran,
                   childEff, childAt, spawned, handedOver>>

\* The step spawns a sub-agent. Its tools are fixed here and never again.
SpawnChild ==
    /\ ran /\ ~spawned
    /\ childEff' = (stepEff \cap Cap) \cup Plat \cup Cli
    /\ childAt'  = (stepEff \cap Cap) \cup Plat \cup Cli
    /\ spawned' = TRUE
    /\ UNCHANGED <<startVer, irGrant, workerVer, upgraded, live, lostPkg,
                   stepEff, stepLost, stepWorker, stepEnt, stepEntSpec, stepEntSigned, ran, handedOver>>

\* design-only handover hands the Workflow to a successor. The grant stays pinned.
HandOver ==
    /\ IncludeHandOver
    /\ ~handedOver
    /\ handedOver' = TRUE
    /\ UNCHANGED <<startVer, irGrant, workerVer, upgraded, live, lostPkg,
                   stepEff, stepLost, stepWorker, stepEnt, stepEntSpec, stepEntSigned, ran, childEff, childAt, spawned>>

\* Continue-as-new moves the session to the newest orchestration version. It
\* does not recompute anything already stored.
ContinueAsNew ==
    /\ upgraded
    /\ UNCHANGED vars

Next == ShiftWorker \/ RunStep \/ LoadPackage \/ UnloadPackage \/ Republish
         \/ LosePackage \/ SpawnChild \/ HandOver \/ ContinueAsNew
Spec == Init /\ [][Next]_vars

(* ---------------- properties ---------------- *)

(* 1. NoLeak against the version that admitted the run.                     *)
Inv_NoLeak == ran => stepEff \subseteq stepEnt

(* 1b. The claim spec 5.3 makes: a Workflow that is running across the       *)
(* upgrade keeps the 0.8.11 set.                                            *)
Inv_SpecCarryOver == (ran /\ stepWorker = "W1" /\ startVer # "W1") => stepEff \subseteq stepEntSpec

(* 1c. The signed rule itself: a named step defaults to none.               *)
Inv_SignedDefault == (ran /\ stepWorker = "W1") => stepEff \subseteq stepEntSigned

(* 7. The under-grant side, reported apart from a leak.                     *)
Inv_NoUnderGrant == ran => stepEnt \subseteq stepEff

(* 5. PinImmobile. No later parent or package change ever adds a tool to an  *)
(* existing child.                                                          *)
Inv_PinImmobile == spawned => childEff \subseteq childAt

(* 2.6. A lost package stops only its own tools.                            *)
(* A step that RUNS while the pin is gone must not hold that package's      *)
(* tools. A step that ran BEFORE the loss keeps what it was given; the pin  *)
(* stops it at its next call, not retrospectively.                          *)
Inv_LostPackageScoped ==
    (ran /\ "A" \in stepLost) => (stepEff \cap PkgA) = {}
Inv_LostPackageNarrow ==
    (ran /\ lostPkg = {}) => (stepEff \cap Cap) \subseteq Cap

Inv_Typed == stepEff \subseteq AllTools /\ childEff \subseteq AllTools
==============================================================================
