------------------------- MODULE RecipientTurnCode -------------------------
(***************************************************************************)
(* Code model of the W2 turn binding at 5df032f1 (tree bc64334c, base      *)
(* 22a66ef7), derived from source only, then mapped to RecipientTurnSpecR2 *)
(* (refinement mapping at the end). Sources (5df032f1):                     *)
(*  intake-machine.ts carryIntakeInvocation 830-856, intakeOwnTurnStimulus *)
(*    859-866, attemptStep/applyIntakeAttempt 927-979;                     *)
(*  intake-wiring.ts beforeAttempt (marker taken only by the pending       *)
(*    dispatch), noteAttempt (retry_replaced), ownTurn, claimCopy arrivals;*)
(*  queue.ts decide priority 2 1467-1483 (intakePendingDispatch),       *)
(*    priority 5 own turn 1611, 1115 message ends a workspace wait, 1032-49 *)
(*    message interrupts a (budget) wait; turn.ts 806 a gate wait is never *)
(*    re-armed after a turn; turn.ts 1688/1810 gate_retry stimuli;         *)
(*    lifecycle.ts 963-971, 1149-1152 commands end a workspace wait into   *)
(*    the pending prompt; turn.ts 222-252 every retry CAN overrides the    *)
(*    pending prompt; lifecycle.ts 728-729 marker carried by every CAN;    *)
(*  session-proxy.ts budget gate 1931-1933 and workspace gate 2030 return  *)
(*    before runTurnWithPrompt sets intakeSent (4560); every result is     *)
(*    wrapped with the witness (4992).                                     *)
(*                                                                         *)
(* Abstractions (stated, not checked): A-ATOMIC the orchestration runs one *)
(* attempt at a time and no drain/decide/latch/cancel write interleaves    *)
(* inside processPrompt (Idle guards); A-SCHED decide's priorities are a   *)
(* nondeterministic choice (superset); A-RETRY the shared retryCount and   *)
(* thrownTurnKey are a per-turn retry cap with nondeterministic exhaustion *)
(* (superset); A-GATE one gate stands for budget and workspace, its state  *)
(* toggled by the environment; A-ONE one invocation of one item; settle,   *)
(* bind failure, stash and session end not modelled.                       *)
(*                                                                         *)
(* GateRule = "code" is 5df032f1 (a gate-parked invocation rides every     *)
(* attempt). GateRule = "design" is the design's resume table (only the    *)
(* gate's own retry) placed in the same code environment: a HYPOTHETICAL  *)
(* variant used to exhibit stranding, not shipped code. CodeFault =        *)
(* "marker_any" is a negative control: any attempt takes the retry marker  *)
(* (the pre-D-W2-1 plan).                                                   *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS MaxTurns, MaxRetries, MaxGateFlips, MaxArrivals, GateRule, CodeFault

ASSUME MaxTurns \in Nat \ {0} /\ MaxRetries \in Nat
ASSUME MaxGateFlips \in Nat /\ MaxArrivals \in Nat
ASSUME GateRule \in {"code", "design"} /\ CodeFault \in {"none", "marker_any"}

SStims  == {"message", "timer", "arrival", "gate_retry", "other", "own"}
Srcs    == {"pending", "message", "timer", "gate_retry", "own", "arrival"}
Results == {"stopped", "gate", "retrying", "failed", "result", "hydration"}
Wits    == {"notrun", "threw", "sent", "unsent", "none"}
Parks   == {"none", "gate", "other"}
Outs    == {"none", "completed", "interrupted", "not_dispatched", "failed_indeterminate"}

NoRun  == [phase |-> "none", id |-> 0, sstim |-> "other", retries |-> 0, pd |-> FALSE,
           carried |-> FALSE, pre |-> "none", w |-> "notrun"]
NoPend == [kind |-> "none", t |-> 0, sstim |-> "other", retries |-> 0]
Follow1 == [NoPend EXCEPT !.kind = "follow"]

VARIABLES
    inv,        \* state.intake.invocation (one item): bound, sent, parked cause, cancel latched, end outcome
    marker,     \* state.intakeRetryInvocationId # null
    pend,       \* state.pendingPrompt: none, a follow-up, or a turn's retry (ghost: its turn)
    run,        \* the attempt in flight (runtime.intakeAttempt and ghosts)
    gateOpen,   \* environment: would the gates admit an attempt now
    gateWait,   \* a gate's wait timer is armed (budget wait or workspace_retry)
    flips,      \* gate toggles so far
    arrivals,   \* runtime.intakeArrivals > 0 (execution-local)
    nArr,       \* arrivals so far
    nTurns,     \* ghost: turns started
    hT,         \* ghost: a held retry's turn awaits its (stuttering) resume after an interposed turn
    firstSent, interposed, badRide, badOwn, badLatched,  \* ghosts, as in the spec
    passed      \* ghost: an attempt returned a model result since the invocation was last parked for a gate

cvars == <<inv, marker, pend, run, gateOpen, gateWait, flips, arrivals, nArr, nTurns, hT,
           firstSent, interposed, badRide, badOwn, badLatched, passed>>
envv  == <<gateOpen, gateWait, flips, arrivals, nArr>>
ghv   == <<firstSent, interposed, badRide, badOwn, badLatched, passed>>

TypeOK ==
    /\ inv \in [st : {"none", "bound"}, sent : BOOLEAN, parked : Parks, latched : BOOLEAN, out : Outs]
    /\ marker \in BOOLEAN
    /\ pend \in [kind : {"none", "follow", "retry"}, t : 0..MaxTurns, sstim : SStims, retries : 0..MaxRetries]
    /\ run \in [phase : {"none", "running", "replacing"}, id : 0..MaxTurns, sstim : SStims,
                retries : 0..MaxRetries, pd : BOOLEAN, carried : BOOLEAN, pre : Parks, w : Wits]
    /\ gateOpen \in BOOLEAN /\ gateWait \in BOOLEAN /\ flips \in 0..MaxGateFlips
    /\ arrivals \in BOOLEAN /\ nArr \in 0..MaxArrivals
    /\ nTurns \in 0..MaxTurns /\ hT \in BOOLEAN
    /\ firstSent \in 0..MaxTurns
    /\ interposed \in BOOLEAN /\ badRide \in BOOLEAN /\ badOwn \in BOOLEAN
    /\ badLatched \in BOOLEAN /\ passed \in BOOLEAN

Init ==
    /\ inv = [st |-> "none", sent |-> FALSE, parked |-> "none", latched |-> FALSE, out |-> "none"]
    /\ marker = FALSE /\ pend = NoPend /\ run = NoRun
    /\ gateOpen \in (IF MaxGateFlips = 0 THEN {TRUE} ELSE BOOLEAN)
    /\ gateWait = FALSE /\ flips = 0 /\ arrivals = FALSE /\ nArr = 0
    /\ nTurns = 0 /\ hT = FALSE
    /\ firstSent = 0 /\ interposed = FALSE /\ badRide = FALSE /\ badOwn = FALSE
    /\ badLatched = FALSE /\ passed = FALSE

Idle  == run.phase = "none"
Live  == inv.st = "bound" /\ inv.out = "none"
\* intakeOwnTurnStimulus = "intake_turn"
CReady == Live /\ ~inv.sent /\ inv.parked = "none" /\ ~inv.latched

-----------------------------------------------------------------------------
(* Environment and store-side steps, between attempts.                     *)

\* decide's (or the own turn's) formIntakeInvocation + bind, before an attempt.
Bind ==
    /\ Idle /\ inv.st = "none"
    /\ inv' = [inv EXCEPT !.st = "bound"]
    /\ UNCHANGED <<marker, pend, run, nTurns, hT>> /\ UNCHANGED envv /\ UNCHANGED ghv

\* latchIntakeTombstones (drain or beforeAttempt): the item's cancel is latched.
Latch ==
    /\ Idle /\ inv.st = "bound" /\ ~inv.latched
    /\ inv' = [inv EXCEPT !.latched = TRUE]
    /\ UNCHANGED <<marker, pend, run, nTurns, hT>> /\ UNCHANGED envv /\ UNCHANGED ghv

\* The wake's invocation cancel write: the one-item unsent batch empties.
CancelWrite ==
    /\ Idle /\ Live /\ ~inv.sent /\ inv.latched
    /\ inv' = [inv EXCEPT !.out = "not_dispatched", !.parked = "none"]
    /\ UNCHANGED <<marker, pend, run, nTurns, hT>> /\ UNCHANGED envv /\ UNCHANGED ghv

GateFlip ==
    /\ flips < MaxGateFlips
    /\ gateOpen' = ~gateOpen /\ flips' = flips + 1
    /\ UNCHANGED <<inv, marker, pend, run, gateWait, arrivals, nArr, nTurns, hT>> /\ UNCHANGED ghv

\* claimCopy "held": a newly claimed item (runtime.intakeArrivals + 1).
Arrive ==
    /\ Idle /\ nArr < MaxArrivals
    /\ arrivals' = TRUE /\ nArr' = nArr + 1
    /\ UNCHANGED <<inv, marker, pend, run, gateOpen, gateWait, flips, nTurns, hT>> /\ UNCHANGED ghv

\* An agent follow-up or machine continuation becomes the pending prompt.
FollowUp ==
    /\ Idle /\ pend.kind = "none"
    /\ pend' = Follow1
    /\ UNCHANGED <<inv, marker, run, nTurns, hT>> /\ UNCHANGED envv /\ UNCHANGED ghv

\* retry_workspace / set_workspace: the workspace wait ends; its wake prompt
\* is merged into the pending prompt (dispatched by decide as "other").
WorkspaceCommand ==
    /\ Idle /\ gateWait
    /\ gateWait' = FALSE
    /\ pend' = IF pend.kind = "none" THEN Follow1 ELSE pend
    /\ UNCHANGED <<inv, marker, run, gateOpen, flips, arrivals, nArr, nTurns, hT>> /\ UNCHANGED ghv

\* Ghost-only stuttering step of the code: maps to the spec's ResumeHeld.
GResume ==
    /\ Idle /\ hT /\ hT' = FALSE
    /\ UNCHANGED <<inv, marker, pend, run, nTurns>> /\ UNCHANGED envv /\ UNCHANGED ghv

Done == Idle /\ UNCHANGED cvars

-----------------------------------------------------------------------------
(* An attempt starts: decide picks its source and stimulus, then           *)
(* beforeAttempt takes the marker (pending dispatch only) and applies       *)
(* carryIntakeInvocation.                                                   *)

CStim(src) == IF src = "own" THEN "intake_turn"
              ELSE IF src = "arrival" THEN "intake_arrival"
              ELSE IF src = "pending" THEN "other"
              ELSE src

Begin(src) ==
    /\ Idle /\ ~hT
    /\ LET isPend  == src = "pending"
           isRetry == isPend /\ pend.kind = "retry"
           cstim   == CStim(src)
           taken   == marker /\ (isPend \/ CodeFault = "marker_any")
           carries == IF ~Live THEN FALSE
                      ELSE IF taken THEN TRUE
                      ELSE IF inv.sent THEN FALSE
                      ELSE IF inv.latched THEN FALSE
                      ELSE IF inv.parked = "none" THEN TRUE
                      ELSE IF inv.parked = "gate" THEN (GateRule = "code" \/ cstim = "gate_retry")
                      ELSE cstim \in {"message", "timer", "intake_arrival"}
       IN /\ isPend => pend.kind # "none"
          /\ ~isRetry => nTurns < MaxTurns
          /\ src = "timer" => ~gateWait            \* the gate wait is the one active timer
          /\ src = "gate_retry" => gateWait
          /\ src = "own" => CReady
          /\ src = "arrival" => (Live /\ ~inv.sent /\ ~inv.latched
                                 /\ inv.parked = "other" /\ arrivals)
          /\ run' = [phase |-> "running",
                     id |-> IF isRetry THEN pend.t ELSE nTurns + 1,
                     sstim |-> IF isRetry THEN pend.sstim ELSE IF isPend THEN "other" ELSE src,
                     retries |-> IF isRetry THEN pend.retries ELSE 0,
                     pd |-> isPend, carried |-> carries, pre |-> inv.parked, w |-> "notrun"]
          /\ nTurns' = IF isRetry THEN nTurns ELSE nTurns + 1
          /\ pend' = IF isPend THEN NoPend ELSE pend
          /\ marker' = IF taken THEN FALSE ELSE marker
          /\ inv' = IF carries THEN [inv EXCEPT !.parked = "none"] ELSE inv
          /\ arrivals' = IF carries THEN FALSE ELSE arrivals
          /\ gateWait' = IF src \in {"message", "gate_retry"} THEN FALSE ELSE gateWait
          /\ interposed' = (interposed \/ (~isPend /\ pend.kind = "retry" /\ pend.t = firstSent))
          /\ badOwn' = (badOwn \/ (src = "own" /\ ~CReady))
    /\ UNCHANGED <<gateOpen, flips, nArr, hT, firstSent, badRide, badLatched, passed>>

-----------------------------------------------------------------------------
(* The attempt ends: its dispatch witness and the turn's event (design     *)
(* 5.5 table as applyIntakeAttempt implements it).                          *)

\* checkAttempt plus source facts about the gates (refusal before intakeSent).
Allowed(w, r) ==
    /\ r = "hydration" => w = "notrun"
    /\ w = "notrun" => r \in {"stopped", "failed", "hydration"}
    /\ w = "threw" => r \in {"retrying", "failed"}
    /\ r = "gate" => (w = "unsent" /\ ~gateOpen)
    /\ r = "result" => gateOpen
    /\ w = "sent" => gateOpen
    /\ r = "retrying" => run.retries < MaxRetries
    /\ ~run.carried => w \in {"notrun", "unsent"}

\* attemptStep, with sent updated first.
Step(w, r) ==
    LET s    == inv.sent \/ w \in {"threw", "sent", "none"}
        E(o) == [sent |-> s, out |-> o, parked |-> "none"]
        P(c) == [sent |-> s, out |-> "none", parked |-> c]
    IN IF r = "retrying" THEN E("none")
       ELSE IF r = "result" THEN (IF w = "sent" THEN E("completed")
                                  ELSE IF s THEN E("interrupted") ELSE P("other"))
       ELSE IF r = "failed" THEN (IF s THEN E("failed_indeterminate") ELSE P("other"))
       ELSE IF s THEN E("interrupted")
       ELSE IF r = "stopped" THEN E("not_dispatched")
       ELSE IF r = "gate" THEN P("gate")
       ELSE P("other")

\* noteAttempt with a record: the table; a sent invocation's retry sets the marker.
Apply(w, r) ==
    IF run.carried
      THEN LET st == Step(w, r)
           IN /\ inv' = [inv EXCEPT !.sent = st.sent, !.out = st.out, !.parked = st.parked]
              /\ marker' = (r = "retrying" /\ st.sent)
              /\ firstSent' = IF ~inv.sent /\ st.sent THEN run.id ELSE firstSent
              /\ badRide' = (badRide \/ (inv.sent /\ run.id # firstSent))
              /\ badLatched' = (badLatched \/ (~inv.sent /\ inv.latched))
      ELSE UNCHANGED <<inv, marker, firstSent, badRide, badLatched>>

PassedNext(w, r) ==
    IF r = "result" THEN TRUE
    ELSE IF run.carried /\ Step(w, r).parked = "gate" THEN FALSE
    ELSE passed

End(w, r) ==
    /\ run.phase = "running" /\ Allowed(w, r)
    /\ IF r = "retrying" /\ pend.kind = "retry"
         THEN \* another turn's retry is held: this retry's continue-as-new
              \* replaces it. First the replacement (noteAttempt with no
              \* record: retry_replaced ends an awaiting invocation), then
              \* the continue-as-new (CanAfterReplace).
              /\ run' = [run EXCEPT !.phase = "replacing", !.w = w]
              /\ pend' = NoPend
              /\ IF ~run.carried /\ marker
                   THEN /\ inv' = [inv EXCEPT !.out = "interrupted", !.parked = "none"]
                        /\ marker' = FALSE
                   ELSE UNCHANGED <<inv, marker>>
              /\ UNCHANGED <<nTurns, hT>> /\ UNCHANGED envv /\ UNCHANGED ghv
         ELSE /\ Apply(w, r)
              /\ run' = NoRun
              /\ pend' = IF r = "retrying"
                           THEN [kind |-> "retry", t |-> run.id, sstim |-> run.sstim,
                                 retries |-> run.retries + 1]
                           ELSE pend
              /\ hT' = (r # "retrying" /\ pend.kind = "retry")
              /\ arrivals' = IF r = "retrying" THEN FALSE ELSE arrivals   \* CAN: execution-local
              /\ gateWait' = IF r = "gate" THEN TRUE ELSE gateWait
              /\ passed' = PassedNext(w, r)
              /\ UNCHANGED <<nTurns, gateOpen, flips, nArr, interposed, badOwn>>

CanAfterReplace ==
    /\ run.phase = "replacing"
    /\ Apply(run.w, "retrying")
    /\ run' = NoRun
    /\ pend' = [kind |-> "retry", t |-> run.id, sstim |-> run.sstim, retries |-> run.retries + 1]
    /\ arrivals' = FALSE
    /\ UNCHANGED <<nTurns, hT, gateOpen, gateWait, flips, nArr, interposed, badOwn, passed>>

-----------------------------------------------------------------------------
Next ==
    \/ Bind \/ Latch \/ CancelWrite \/ GateFlip \/ Arrive \/ FollowUp
    \/ WorkspaceCommand \/ GResume \/ Done \/ CanAfterReplace
    \/ \E src \in Srcs : Begin(src)
    \/ \E w \in Wits, r \in Results : End(w, r)

Spec == Init /\ [][Next]_cvars

-----------------------------------------------------------------------------
(* Code-level safety (the spec's properties stated on the code ghosts),    *)
(* the D-W2-1 marker obligations, and the gate stranding predicate.        *)

Inv_C_SentRidesOwnTurn == ~badRide
Inv_C_NoOwnTurnUnlessReady == ~badOwn
Inv_C_NoCarryLatchedUnsent == ~badLatched
Inv_C_Truthful ==
    /\ inv.out = "not_dispatched" => firstSent = 0
    /\ inv.out = "completed" => firstSent # 0

\* restoreIntakeRetryInvocationId's precondition at every point a CAN can
\* happen: the marker is present exactly while a sent invocation awaits.
Inv_C_MarkerIffAwaiting == Idle => (marker <=> (Live /\ inv.sent))

\* The marker rides the first-sending turn's own retry prompt.
Inv_C_MarkerOnFirstSenderRetry == marker => (pend.kind = "retry" /\ pend.t = firstSent)

\* A gate-parked invocation does not stay parked, with the gate's wait gone,
\* after an attempt passed the gates (a model result). Under the design rule
\* this is the stranding: no own turn, and no gate retry unless the gates
\* refuse again. (Amended at the gate checkpoint: "with the wait gone"
\* added; a still-armed wait will start a gate_retry turn.)
Inv_C_GateParkClearedOnPass ==
    ~(Live /\ ~inv.sent /\ inv.parked = "gate" /\ ~inv.latched /\ passed /\ ~gateWait)

Prop_C_SentSticky == [][inv.sent => inv'.sent]_cvars
Prop_C_OutFinal == [][inv.out # "none" => inv'.out = inv.out]_cvars

-----------------------------------------------------------------------------
(* Refinement mapping to RecipientTurnSpecR2.                              *)
(*  - inv: the code invocation; while an attempt that carried it is in     *)
(*    flight, its parked value is the one before the carry (the spec       *)
(*    unparks in the same step as the attempt).                            *)
(*  - cur: the attempt in flight; else a turn's retry held as the pending  *)
(*    prompt (waiting), unless an interposed turn just ended (hT).         *)
(*  - held: a turn's retry held as the pending prompt while another turn   *)
(*    runs or just ran.                                                    *)
(* Step correspondence: Bind -> Bind/BindWaiting; Latch -> Latch;          *)
(* CancelWrite -> CancelUnsent/CancelUnsentWaiting; Begin(pending retry)   *)
(* -> RetryReady; Begin(own) -> OwnTurn/OwnInterpose; other Begin ->       *)
(* StartTurn/Interpose; End and CanAfterReplace -> Attempt; End's          *)
(* replacement -> AbandonHeldBusy; GResume -> ResumeHeld; the rest stutter. *)

TurnRec(i, s, k, wt) == [id |-> i, stim |-> s, retries |-> k, waiting |-> wt]
SNoTurn == TurnRec(0, "other", 0, FALSE)

sinv == [st |-> inv.st, sent |-> inv.sent,
         parked |-> IF run.phase # "none" /\ run.carried THEN run.pre ELSE inv.parked,
         latched |-> inv.latched, out |-> inv.out]
scur == IF run.phase # "none" THEN TurnRec(run.id, run.sstim, run.retries, FALSE)
        ELSE IF pend.kind = "retry" /\ ~hT THEN TurnRec(pend.t, pend.sstim, pend.retries, TRUE)
        ELSE SNoTurn
sheld == IF pend.kind = "retry" /\ (run.phase # "none" \/ hT)
           THEN TurnRec(pend.t, pend.sstim, pend.retries, TRUE) ELSE SNoTurn

S == INSTANCE RecipientTurnSpecR2 WITH
        inv <- sinv, nTurns <- nTurns, cur <- scur, held <- sheld,
        firstSent <- firstSent, interposed <- interposed, badRide <- badRide,
        badOwn <- badOwn, badLatched <- badLatched,
        MaxTurns <- MaxTurns, MaxRetries <- MaxRetries, Fault <- "none"

Refines == S!Spec2

=============================================================================
