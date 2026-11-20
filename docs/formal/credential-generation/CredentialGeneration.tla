-------------------------- MODULE CredentialGeneration --------------------------
EXTENDS Integers, FiniteSets

CONSTANTS N, MaxGeneration, MaxClock, MaxTurns, Lifetime, MinValidity, TurnLimit, Fault
ASSUME N \in 1..2 /\ MaxGeneration \in 1..3 /\ MaxClock \in 1..8 /\ MaxTurns \in 1..2
ASSUME Lifetime > MinValidity /\ MinValidity > TurnLimit /\ TurnLimit > 0
ASSUME Fault \in {"none", "scope-fallback", "expiry-bypass", "stop-busy", "detach-busy"}

S == 1..N
G == 0..MaxGeneration
None == -1
Offers == {"valid", "short", "foreign", "failed"}

VARIABLES
    clock, generation, expiry,
    phase, offer, bound, lease, scope, beganAt, attempts,
    live, workflow, discovery,
    bad

vars == <<clock, generation, expiry, phase, offer, bound, lease, scope,
          beganAt, attempts, live, workflow, discovery, bad>>

Init ==
    /\ clock = 0 /\ generation = 0
    /\ expiry = [g \in G |-> IF g = 0 THEN Lifetime ELSE 0]
    /\ phase = [s \in S |-> "idle"]
    /\ offer = [s \in S |-> "failed"]
    /\ bound = [s \in S |-> None] /\ lease = [s \in S |-> None]
    /\ scope = [s \in S |-> "expected"]
    /\ beganAt = [s \in S |-> 0] /\ attempts = [s \in S |-> 0]
    /\ live = {} /\ workflow = [s \in S |-> FALSE] /\ discovery = None /\ bad = {}

(* A newer callback result is published without changing active owners. *)
Publish ==
    /\ generation < MaxGeneration
    /\ generation' = generation + 1
    /\ expiry' = [expiry EXCEPT ![generation + 1] = clock + Lifetime]
    /\ UNCHANGED <<clock, phase, offer, bound, lease, scope, beganAt, attempts,
                   live, workflow, discovery, bad>>

Request(s) ==
    /\ phase[s] = "idle" /\ attempts[s] < MaxTurns
    /\ phase' = [phase EXCEPT ![s] = "acquiring"]
    /\ \E o \in Offers : offer' = [offer EXCEPT ![s] = o]
    /\ UNCHANGED <<clock, generation, expiry, bound, lease, scope, beganAt,
                   attempts, live, workflow, discovery, bad>>

Fresh == expiry[generation] - clock >= MinValidity
Allowed(s) == offer[s] = "valid" /\ Fresh

(* Reserve the process before any asynchronous SDK start/create/resume. *)
Admit(s) ==
    /\ phase[s] = "acquiring"
    /\ (Allowed(s)
        \/ (Fault = "scope-fallback" /\ offer[s] \in {"foreign", "failed"})
        \/ (Fault = "expiry-bypass" /\ offer[s] \in {"valid", "short"}))
    /\ lease' = [lease EXCEPT ![s] = generation]
    /\ scope' = [scope EXCEPT ![s] = IF offer[s] \in {"foreign", "failed"} THEN "ambient" ELSE "expected"]
    /\ phase' = [phase EXCEPT ![s] = "ready"]
    /\ live' = live \cup {generation}
    /\ bad' = bad \cup (IF ~Fresh \/ offer[s] = "short" THEN {"shortAdmission"} ELSE {})
    /\ UNCHANGED <<clock, generation, expiry, offer, bound, beganAt, attempts,
                   workflow, discovery>>

Reject(s) ==
    /\ phase[s] = "acquiring" /\ ~Allowed(s)
    /\ phase' = [phase EXCEPT ![s] = "idle"]
    /\ attempts' = [attempts EXCEPT ![s] = @ + 1]
    /\ UNCHANGED <<clock, generation, expiry, offer, bound, lease, scope,
                   beganAt, live, workflow, discovery, bad>>

(* Setup can take time; recheck lifetime before the actual model turn. *)
Begin(s) ==
    /\ phase[s] = "ready"
    /\ (bound[s] = lease[s] \/ ~workflow[s])
    /\ (expiry[lease[s]] - clock > TurnLimit \/ Fault = "expiry-bypass")
    /\ bound' = [bound EXCEPT ![s] = lease[s]]
    /\ phase' = [phase EXCEPT ![s] = "running"]
    /\ beganAt' = [beganAt EXCEPT ![s] = clock]
    /\ bad' = bad \cup (IF expiry[lease[s]] - clock <= TurnLimit THEN {"expiredRun"} ELSE {})
    /\ UNCHANGED <<clock, generation, expiry, offer, lease, scope, attempts,
                   live, workflow, discovery>>

RejectReady(s) ==
    /\ phase[s] = "ready" /\ expiry[lease[s]] - clock <= TurnLimit
    /\ phase' = [phase EXCEPT ![s] = "idle"]
    /\ lease' = [lease EXCEPT ![s] = None]
    /\ attempts' = [attempts EXCEPT ![s] = @ + 1]
    /\ UNCHANGED <<clock, generation, expiry, offer, bound, scope, beganAt,
                   live, workflow, discovery, bad>>

Finish(s) ==
    /\ phase[s] = "running"
    /\ phase' = [phase EXCEPT ![s] = "releasing"]
    /\ attempts' = [attempts EXCEPT ![s] = @ + 1]
    /\ UNCHANGED <<clock, generation, expiry, offer, bound, lease, scope,
                   beganAt, live, workflow, discovery, bad>>

Release(s) ==
    /\ phase[s] = "releasing"
    /\ phase' = [phase EXCEPT ![s] = "idle"]
    /\ lease' = [lease EXCEPT ![s] = None]
    /\ UNCHANGED <<clock, generation, expiry, offer, bound, scope, beganAt,
                   attempts, live, workflow, discovery, bad>>

AcquireDiscovery ==
    /\ discovery = None /\ Fresh
    /\ discovery' = generation /\ live' = live \cup {generation}
    /\ UNCHANGED <<clock, generation, expiry, phase, offer, bound, lease,
                   scope, beganAt, attempts, workflow, bad>>

ReleaseDiscovery ==
    /\ discovery # None /\ discovery' = None
    /\ UNCHANGED <<clock, generation, expiry, phase, offer, bound, lease,
                   scope, beganAt, attempts, live, workflow, bad>>

OpenWorkflow(s) ==
    /\ phase[s] = "idle" /\ bound[s] = generation /\ ~workflow[s]
    /\ workflow' = [workflow EXCEPT ![s] = TRUE]
    /\ UNCHANGED <<clock, generation, expiry, phase, offer, bound, lease,
                   scope, beganAt, attempts, live, discovery, bad>>

CloseWorkflow(s) ==
    /\ workflow[s] /\ workflow' = [workflow EXCEPT ![s] = FALSE]
    /\ UNCHANGED <<clock, generation, expiry, phase, offer, bound, lease,
                   scope, beganAt, attempts, live, discovery, bad>>

(* The per-session lock and workflow owners exclude a concurrent drop. *)
Detach(s) ==
    /\ bound[s] # None /\ bound[s] < generation
    /\ ((phase[s] = "idle" /\ ~workflow[s]) \/ Fault = "detach-busy")
    /\ bound' = [bound EXCEPT ![s] = None]
    /\ bad' = bad \cup (IF phase[s] = "running" \/ workflow[s] THEN {"ownerDropped"} ELSE {})
    /\ UNCHANGED <<clock, generation, expiry, phase, offer, lease, scope,
                   beganAt, attempts, live, workflow, discovery>>

Owned(g) ==
    \/ discovery = g
    \/ \E s \in S : lease[s] = g \/ bound[s] = g

Stop(g) ==
    /\ g \in live /\ g < generation
    /\ (~Owned(g) \/ Fault = "stop-busy")
    /\ live' = live \ {g}
    /\ UNCHANGED <<clock, generation, expiry, phase, offer, bound, lease,
                   scope, beganAt, attempts, workflow, discovery, bad>>

(* Ten-minute ticks; the host enforces the configured model-turn bound. *)
Tick ==
    /\ clock < MaxClock
    /\ \A s \in S : phase[s] = "running" => clock < beganAt[s] + TurnLimit
    /\ clock' = clock + 1
    /\ UNCHANGED <<generation, expiry, phase, offer, bound, lease, scope,
                   beganAt, attempts, live, workflow, discovery, bad>>

Idle == UNCHANGED vars
Next ==
    \/ Publish \/ Tick \/ AcquireDiscovery \/ ReleaseDiscovery
    \/ \E s \in S : Request(s) \/ Admit(s) \/ Reject(s) \/ Begin(s) \/ RejectReady(s)
                     \/ Finish(s) \/ Release(s) \/ OpenWorkflow(s) \/ CloseWorkflow(s) \/ Detach(s)
    \/ \E g \in G : Stop(g)
    \/ Idle

Spec == Init /\ [][Next]_vars
Fairness ==
    /\ WF_vars(ReleaseDiscovery)
    /\ \A s \in S : WF_vars(Admit(s) \/ Reject(s)) /\ WF_vars(Begin(s) \/ RejectReady(s))
                    /\ WF_vars(Finish(s)) /\ WF_vars(Release(s))
                    /\ WF_vars(CloseWorkflow(s)) /\ WF_vars(Detach(s))
    /\ \A g \in G : WF_vars(Stop(g))
LiveSpec == Spec /\ Fairness

TypeOK ==
    /\ clock \in 0..MaxClock /\ generation \in G /\ expiry \in [G -> 0..(MaxClock + Lifetime)]
    /\ phase \in [S -> {"idle", "acquiring", "ready", "running", "releasing"}]
    /\ offer \in [S -> Offers] /\ bound \in [S -> G \cup {None}] /\ lease \in [S -> G \cup {None}]
    /\ scope \in [S -> {"expected", "ambient"}] /\ beganAt \in [S -> 0..MaxClock]
    /\ attempts \in [S -> 0..MaxTurns] /\ live \subseteq G
    /\ workflow \in [S -> BOOLEAN] /\ discovery \in G \cup {None}
Inv_ActiveUsesLive ==
    /\ \A s \in S : lease[s] # None => lease[s] \in live
    /\ discovery # None => discovery \in live
Inv_WarmUsesLive == \A s \in S : bound[s] # None => bound[s] \in live
Inv_ScopeBound == \A s \in S : lease[s] # None => scope[s] = "expected"
Inv_FreshAdmission == "shortAdmission" \notin bad /\ "expiredRun" \notin bad
Inv_NoDroppedOwner == "ownerDropped" \notin bad
Inv_TurnBeforeExpiry == \A s \in S : phase[s] = "running" => clock < expiry[lease[s]]
Prop_OldClientsDrain == (generation = MaxGeneration) ~> (\A g \in 0..(MaxGeneration - 1) : g \notin live)
W_NoConcurrentGenerations == ~(\E a, b \in S : lease[a] # None /\ lease[b] # None /\ lease[a] # lease[b])
W_NoOwnedRetirement == ~(\E s \in S : workflow[s] /\ bound[s] # None /\ bound[s] < generation)
W_NoWarmResume == ~(\E s \in S : phase[s] = "ready" /\ bound[s] # None
                                  /\ lease[s] # None /\ bound[s] # lease[s])
=============================================================================
