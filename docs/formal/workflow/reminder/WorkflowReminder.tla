------------------------- MODULE WorkflowReminder -------------------------
(***************************************************************************)
(* The in-turn step reminder of a workflow agent state's child (owner   *)
(* decision Q2), as 8d568890 implements it (chain 052c0174..8a5b0b7d):     *)
(* managed-session.ts _runTurnWithState (the trigger and the re-check      *)
(* 4403-4460, runCorrection 4195-4220), awaitStepReminderGate (1796-1836), *)
(* session-proxy.ts stepReminder.check (4876-4890: the published schedule, *)
(* then the store), and store.ts recordAgentReminder (5424-5466).          *)
(*                                                                          *)
(* One agent step and the turns of its child. A turn runs the model; a    *)
(* quiet end with nothing pending asks the gate; the gate's store          *)
(* transaction checks the step and records the reminder (at most Max per  *)
(* step, keyed by the turn index); the turn then checks its pending work  *)
(* again, sends the reminder prompt and runs it. Stop, interrupts, steers, *)
(* held controls, queued messages, the turn's guards, the step deadline,  *)
(* the child's end request, a busy sub-agent and an active schedule arrive *)
(* at any time. A turn's activity may run again after a crash (same turn  *)
(* index). JavaScript runs one synchronous block at a time: the re-check  *)
(* and the start of the send are one step.                                 *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    MaxTurns,       \* turns of the child within the step
    Max,            \* WORKFLOW_AGENT_MAX_REMINDERS (3)
    MaxRetry,       \* activity re-runs of a turn after a crash
    AllowStop, AllowInterrupt, AllowSteer, AllowHeld, AllowQueued, AllowGuard,
    AllowCron, AllowSub, AllowSendFail,
    AllowStoreHang, \* the gate's store call may never answer (not fair)
    AllowSendHang,  \* the CLI may never accept or refuse the prompt (not fair)
    Fault

Faults == {"none", "no-recheck", "event-before-send", "no-cap", "no-step-check", "turn-reuse", "gate-not-raced"}
ASSUME MaxTurns \in Nat /\ MaxTurns >= 1 /\ Max \in Nat /\ MaxRetry \in Nat
ASSUME {AllowStop, AllowInterrupt, AllowSteer, AllowHeld, AllowQueued, AllowGuard, AllowCron, AllowSub, AllowSendFail,
        AllowStoreHang, AllowSendHang} \subseteq BOOLEAN
ASSUME Fault \in Faults

Phases == {"idle", "run", "settled", "asking", "decide", "sending", "rrun", "done"}

VARIABLES
    \* the store and the environment
    node,       \* the agent state's node: "pending", "completed", "timed_out"
    deadline,   \* the store's clock passed the step's deadline
    records,    \* workflow.agent_reminded: the turn keys recorded, in order
    cronActive, \* the session's published status says a schedule is active
    subBusy,    \* the child has a sub-agent at work
    \* the turn
    turn,       \* the turn index (the session orchestration's iteration)
    ph,         \* the turn's phase
    quiet,      \* the run ended quietly (no control tool, no error, no completion, no question)
    stop, intr, steer, held, queued, guard,
    ask,        \* the gate's store call: "none", "inflight", "answered"
    gres,       \* its answer: "none", "remind", "refuse"
    sentAtt,    \* reminder sends in this attempt of the turn
    pub, acc,   \* this attempt published runtime.workflow_step_reminded / the SDK accepted the prompt
    retries,
    \* history
    sends,      \* every reminder send, as <<turn, attempt>>
    badSend, sendAfterDecided, recordAfterDecided, queuedSend, notSent

storeVars == <<node, deadline, records, cronActive, subBusy>>
turnVars == <<turn, ph, quiet, stop, intr, steer, held, queued, guard, ask, gres, sentAtt, pub, acc, retries>>
histVars == <<sends, badSend, sendAfterDecided, recordAfterDecided, queuedSend, notSent>>
vars == <<storeVars, turnVars, histVars>>

Range(s) == {s[j] : j \in 1..Len(s)}
WorkPending == stop \/ intr \/ steer \/ held
Active == ph \notin {"idle", "done"}
(* The store's key for a turn: its index (one record per turn).            *)
Key == IF Fault = "turn-reuse" THEN 1 ELSE turn

Init ==
    /\ node = "pending" /\ deadline = FALSE /\ records = <<>> /\ cronActive = FALSE /\ subBusy = FALSE
    /\ turn = 0 /\ ph = "idle" /\ quiet = FALSE
    /\ stop = FALSE /\ intr = FALSE /\ steer = FALSE /\ held = FALSE /\ queued = FALSE /\ guard = FALSE
    /\ ask = "none" /\ gres = "none" /\ sentAtt = 0 /\ pub = FALSE /\ acc = FALSE /\ retries = 0
    /\ sends = <<>> /\ badSend = FALSE /\ sendAfterDecided = FALSE /\ recordAfterDecided = FALSE
    /\ queuedSend = FALSE /\ notSent = FALSE

ResetTurn ==
    /\ ph' = "run" /\ quiet' = FALSE
    /\ stop' = FALSE /\ intr' = FALSE /\ steer' = FALSE /\ held' = FALSE /\ queued' = FALSE /\ guard' = FALSE
    /\ ask' = "none" /\ gres' = "none" /\ sentAtt' = 0 /\ pub' = FALSE /\ acc' = FALSE

(* The orchestration runs the child's next turn while the step is open.    *)
StartTurn ==
    /\ ph \in {"idle", "done"} /\ turn < MaxTurns /\ node = "pending" /\ ask # "inflight"
    /\ turn' = turn + 1 /\ ResetTurn
    /\ UNCHANGED <<storeVars, retries, histVars>>

(* A crash re-runs the turn's activity: the same turn index, a new attempt. *)
Retry ==
    /\ ph \in {"rrun", "done"} /\ turn >= 1 /\ retries < MaxRetry /\ node = "pending" /\ ask # "inflight"
    /\ retries' = retries + 1 /\ ResetTurn
    /\ UNCHANGED <<storeVars, turn, histVars>>

(* The model run ends: quietly, with a turn-ending action, an error, or by  *)
(* calling complete_workflow_node (the store decides the step).            *)
RunEnds ==
    /\ ph = "run" /\ ~stop /\ ~intr
    /\ \E o \in {"quiet", "action", "complete"} :
          /\ quiet' = (o = "quiet")
          /\ node' = IF o = "complete" /\ node = "pending" THEN "completed" ELSE node
    /\ ph' = "settled"
    /\ UNCHANGED <<deadline, records, cronActive, subBusy, turn, stop, intr, steer, held, queued, guard, ask, gres,
                   sentAtt, pub, acc, retries, histVars>>

(* Stop, an interrupt or a guard ends a running model run.                 *)
RunStops ==
    /\ ph \in {"run", "rrun"} /\ (stop \/ intr \/ guard)
    /\ ph' = "done"
    /\ UNCHANGED <<storeVars, turn, quiet, stop, intr, steer, held, queued, guard, ask, gres, sentAtt, pub, acc, retries, histVars>>

(* After the run: only a quiet end with nothing pending asks the gate.     *)
Settle ==
    /\ ph = "settled"
    /\ IF quiet /\ ~guard /\ ~WorkPending
       THEN /\ ph' = "asking" /\ ask' = "inflight"
       ELSE /\ ph' = "done" /\ UNCHANGED ask
    /\ UNCHANGED <<storeVars, turn, quiet, stop, intr, steer, held, queued, guard, gres, sentAtt, pub, acc, retries, histVars>>

(* The gate's call: the published schedule, then recordAgentReminder in    *)
(* one transaction (locks session > run > invocation > node, one clock     *)
(* reading). It runs to its end even when the turn stopped waiting.        *)
GateStore ==
    /\ ask = "inflight"
    /\ LET stepOpen == node = "pending" /\ ~deadline
           refuse == cronActive \/ subBusy \/ (~stepOpen /\ Fault # "no-step-check")
           repeat == Key \in Range(records)
           spent == Len(records) >= Max /\ Fault # "no-cap"
       IN IF refuse THEN /\ gres' = "refuse" /\ UNCHANGED <<records, recordAfterDecided>>
          ELSE IF repeat THEN /\ gres' = "remind" /\ UNCHANGED <<records, recordAfterDecided>>
          ELSE IF spent THEN /\ gres' = "refuse" /\ UNCHANGED <<records, recordAfterDecided>>
          ELSE /\ gres' = "remind" /\ records' = Append(records, Key)
               /\ recordAfterDecided' = (recordAfterDecided \/ ~stepOpen)
    /\ ask' = "answered"
    \* a late answer: the turn stopped waiting, but the reminder is recorded
    /\ notSent' = (notSent \/ (ph # "asking" /\ Len(records') > Len(records)))
    /\ UNCHANGED <<node, deadline, cronActive, subBusy, turn, ph, quiet, stop, intr, steer, held, queued, guard,
                   sentAtt, pub, acc, retries, sends, badSend, sendAfterDecided, queuedSend>>

(* The race in awaitStepReminderGate: a Stop, interrupt or guard settles   *)
(* it first; the gate's late answer is ignored.                            *)
GateInterrupted ==
    /\ ph = "asking" /\ (stop \/ intr \/ guard) /\ Fault # "gate-not-raced"
    /\ ph' = "done"
    /\ UNCHANGED <<storeVars, turn, quiet, stop, intr, steer, held, queued, guard, ask, gres, sentAtt, pub, acc, retries, histVars>>

GateAnswered ==
    /\ ph = "asking" /\ ask = "answered"
    /\ ph' = IF gres = "remind" THEN "decide" ELSE "done"
    /\ UNCHANGED <<storeVars, turn, quiet, stop, intr, steer, held, queued, guard, ask, gres, sentAtt, pub, acc, retries, histVars>>

(* One synchronous block: the re-check (review E1), runCorrection's own    *)
(* Stop check, beforeSend, and the start of the send.                      *)
Decide ==
    /\ ph = "decide"
    /\ IF guard \/ (WorkPending /\ Fault # "no-recheck") \/ stop
       THEN /\ ph' = "done" /\ notSent' = (notSent \/ ask = "answered")
            /\ UNCHANGED <<sentAtt, pub, sends, badSend, sendAfterDecided, queuedSend>>
       ELSE /\ ph' = "sending" /\ sentAtt' = sentAtt + 1
            /\ sends' = Append(sends, <<turn, retries>>)
            /\ badSend' = (badSend \/ WorkPending \/ guard)
            /\ sendAfterDecided' = (sendAfterDecided \/ node # "pending")
            /\ queuedSend' = (queuedSend \/ queued)
            /\ pub' = (pub \/ Fault = "event-before-send")
            /\ UNCHANGED notSent
    /\ UNCHANGED <<storeVars, turn, quiet, stop, intr, steer, held, queued, guard, ask, gres, acc, retries, recordAfterDecided>>

(* The SDK accepts the prompt: afterSend publishes the runtime event, then *)
(* the send gate opens (a held Stop or steer applies now).                 *)
SendAccept ==
    /\ ph = "sending"
    /\ ph' = "rrun" /\ acc' = TRUE /\ pub' = TRUE
    /\ UNCHANGED <<storeVars, turn, quiet, stop, intr, steer, held, queued, guard, ask, gres, sentAtt, retries, histVars>>

SendFails ==
    /\ ph = "sending" /\ AllowSendFail
    /\ ph' = "done"
    /\ UNCHANGED <<storeVars, turn, quiet, stop, intr, steer, held, queued, guard, ask, gres, sentAtt, pub, acc, retries, histVars>>

(* The reminder's run ends: the model completes the step or not.           *)
ReminderRunEnds ==
    /\ ph = "rrun" /\ ~stop /\ ~intr
    /\ \E done \in BOOLEAN : node' = IF done /\ node = "pending" THEN "completed" ELSE node
    /\ ph' = "done"
    /\ UNCHANGED <<deadline, records, cronActive, subBusy, turn, quiet, stop, intr, steer, held, queued, guard, ask, gres,
                   sentAtt, pub, acc, retries, histVars>>

(* The environment.                                                        *)
Arrive ==
    /\ Active
    /\ \/ AllowStop /\ ~stop /\ stop' = TRUE /\ UNCHANGED <<intr, steer, held, queued, guard>>
       \/ AllowInterrupt /\ ~intr /\ intr' = TRUE /\ UNCHANGED <<stop, steer, held, queued, guard>>
       \/ AllowSteer /\ ~steer /\ steer' = TRUE /\ UNCHANGED <<stop, intr, held, queued, guard>>
       \/ AllowHeld /\ ~held /\ held' = TRUE /\ UNCHANGED <<stop, intr, steer, queued, guard>>
       \/ AllowQueued /\ ~queued /\ queued' = TRUE /\ UNCHANGED <<stop, intr, steer, held, guard>>
       \/ AllowGuard /\ ~guard /\ guard' = TRUE /\ UNCHANGED <<stop, intr, steer, held, queued>>
    /\ UNCHANGED <<storeVars, turn, ph, quiet, ask, gres, sentAtt, pub, acc, retries, histVars>>

Schedule ==
    /\ AllowCron /\ ~cronActive /\ cronActive' = TRUE
    /\ UNCHANGED <<node, deadline, records, subBusy, turnVars, histVars>>
SubAgent ==
    /\ AllowSub /\ subBusy' = ~subBusy
    /\ UNCHANGED <<node, deadline, records, cronActive, turnVars, histVars>>

(* The step's deadline passes in the store, the controller elapses the    *)
(* step, and then ends the child (its running turn is interrupted).        *)
StoreTick ==
    /\ ~deadline /\ deadline' = TRUE
    /\ UNCHANGED <<node, records, cronActive, subBusy, turnVars, histVars>>
Expire ==
    /\ deadline /\ node = "pending" /\ node' = "timed_out"
    /\ UNCHANGED <<deadline, records, cronActive, subBusy, turnVars, histVars>>
EndChild ==
    /\ node # "pending" /\ Active /\ ~intr /\ intr' = TRUE
    /\ UNCHANGED <<storeVars, turn, ph, quiet, stop, steer, held, queued, guard, ask, gres, sentAtt, pub, acc, retries, histVars>>

Done == ph \in {"idle", "done"} /\ node # "pending" /\ ask # "inflight" /\ UNCHANGED vars

Next ==
    \/ StartTurn \/ Retry \/ RunEnds \/ RunStops \/ Settle \/ GateStore \/ GateInterrupted \/ GateAnswered
    \/ Decide \/ SendAccept \/ SendFails \/ ReminderRunEnds \/ Arrive \/ Schedule \/ SubAgent
    \/ StoreTick \/ Expire \/ EndChild \/ Done

Spec == Init /\ [][Next]_vars

Fairness ==
    /\ WF_vars(RunEnds) /\ WF_vars(RunStops) /\ WF_vars(Settle) /\ WF_vars(GateAnswered) /\ WF_vars(GateInterrupted)
    /\ WF_vars(~AllowStoreHang /\ GateStore) /\ WF_vars(Decide) /\ WF_vars(~AllowSendHang /\ SendAccept)
    /\ WF_vars(ReminderRunEnds) /\ WF_vars(StoreTick) /\ WF_vars(Expire) /\ WF_vars(EndChild)

LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK ==
    /\ node \in {"pending", "completed", "timed_out"} /\ {deadline, cronActive, subBusy} \subseteq BOOLEAN
    /\ records \in Seq(1..MaxTurns) /\ turn \in 0..MaxTurns /\ ph \in Phases
    /\ {quiet, stop, intr, steer, held, queued, guard, pub, acc} \subseteq BOOLEAN
    /\ ask \in {"none", "inflight", "answered"} /\ gres \in {"none", "remind", "refuse"}
    /\ sentAtt \in 0..2 /\ retries \in 0..MaxRetry
    /\ {badSend, sendAfterDecided, recordAfterDecided, queuedSend, notSent} \subseteq BOOLEAN

(* At most one reminder per attempt of a turn, one record per turn, Max   *)
(* records per step; every send has its turn's record.                     *)
Inv_OneSendPerAttempt == sentAtt <= 1
Inv_OneRecordPerTurn == \A a, b \in 1..Len(records) : a # b => records[a] # records[b]
Inv_RecordsCap == Len(records) <= Max
Inv_SendsBounded == Len(sends) <= Len(records) + retries
Inv_SendHasRecord == \A j \in 1..Len(sends) : sends[j][1] \in Range(records) \/ Fault = "turn-reuse"
(* No reminder is sent while work is pending or a guard expired.           *)
Inv_NoSendWhileWorkPending == ~badSend
(* The runtime event only once the SDK accepted the prompt (review E2).    *)
Inv_EventAfterAccept == pub => acc
(* No reminder is recorded for a decided or expired step.                  *)
Inv_NoRecordAfterDecided == ~recordAfterDecided

(* Witnesses: expected to be violated (the behavior is reachable).        *)
W_NoReminder == Len(sends) = 0
W_NotThree == Len(records) < 3
W_RecordedAlwaysSent == ~notSent
W_NoSendAfterDecided == ~sendAfterDecided
W_NoQueuedSend == ~queuedSend
W_OneSendPerTurn == \A a, b \in 1..Len(sends) : a # b => sends[a][1] # sends[b][1]

(* Progress, under Fairness.                                               *)
StalledFree == ph = "asking" /\ ask = "inflight" /\ node = "pending" /\ ~deadline /\ ~cronActive /\ ~subBusy
               /\ Len(records) < Max /\ ~WorkPending /\ ~guard
Prop_StalledReminded == StalledFree ~> (ph \in {"sending", "rrun"} \/ WorkPending \/ guard \/ node # "pending"
                                        \/ deadline \/ cronActive \/ subBusy)
Prop_StepEnds == (node = "pending") ~> (node # "pending")
Prop_StopTakesEffect == (Active /\ stop) ~> ~Active
=============================================================================
