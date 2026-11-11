-------------------------- MODULE RehydrationNotice --------------------------
(***************************************************************************)
(* The rehydration notice of the durable session orchestration, and the   *)
(* hydration-adjacent edits of 1.0.82 and 1.0.83 (touchpoints T1 to T3).  *)
(* Code: packages/sdk/src/orchestration/ (1.0.82, identical at 198ad79a,   *)
(* 7f81d217 and e76a6133) and orchestration_1_0_83/ at e76a6133.          *)
(*                                                                         *)
(* A lossy hand-off continues as new with a rehydration message           *)
(* (turn.ts 196); it becomes the pending notice (state.ts 715). The notice *)
(* is consumed by wrapWithResumeContext (lifecycle.ts 159-170) when a      *)
(* timer that was set with shouldRehydrate fires (turn.ts 1740, 1800) or a *)
(* prompt interrupts it in drain (queue.ts 1080-1130). A prompt that took *)
(* the notice into its text and is not queued in the same pass (the FIFO  *)
(* is full, or it is cancelled) gives it back (T2: giveBackCarriedWork,   *)
(* queue.ts 379-398; 907, 920, 1227); a note that would make the prompt   *)
(* too large is not added (queue.ts 1166-1171). The notice is carried     *)
(* across continue-as-new (lifecycle.ts 599). A timer item above the item *)
(* size cap is stored compact and keeps shouldRehydrate (T1:              *)
(* compactTimerItem, queue.ts 97-112 in 1.0.82, 99-114 in 1.0.83).        *)
(* When hydration is given up, the turn records an intake attempt instead *)
(* of sending (T3: turn.ts 512, 1.0.83; 1.0.82 returned without a record). *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    P,              \* user prompts that arrive
    FifoCap,        \* FIFO capacity
    AllowCancel,    \* a prompt may be cancelled in the drain pass that stashed it
    AllowLateCancel,\* a queued prompt may be cancelled before its dispatch (decide, queue.ts 1559-1562)
    LateGiveBack,   \* comparison: a prompt cancelled at dispatch gives back the notice it carried
    AllowTooLarge,  \* the timer note may not fit; the prompt is queued without it
    AllowCompact,   \* a timer item may be above the item size cap and stored compact
    AllowHydFail,   \* hydration may be given up (retries exhausted)
    Intake,         \* a Workflow intake item is owed to the next turn (1.0.83)
    Rearm,          \* a later wait with shouldRehydrate may be set after the first one ran
    Fault

Faults == {"none", "no-give-back", "give-back-dup", "compact-drops-flag", "send-while-hydrating",
           "unrecorded-wait", "can-drops-notice"}
ASSUME P \in 0..3 /\ FifoCap \in 1..3 /\ Fault \in Faults
ASSUME {AllowCancel, AllowLateCancel, LateGiveBack, AllowTooLarge, AllowCompact, AllowHydFail, Intake, Rearm} \subseteq BOOLEAN

NoItem == [k |-> "none", n |-> FALSE, sr |-> FALSE, cancel |-> FALSE, intr |-> FALSE]

VARIABLES
    issued,     \* a lossy hand-off issued the notice
    pend,       \* state.pendingRehydrationMessage is set
    prompts,    \* prompts still to arrive
    stash,      \* the current drain pass's stashed prompts
    fifo,       \* queued items
    cur,        \* the running turn's item
    curOn,      \* a turn runs
    hyd,        \* the running turn's hydration: "ok", "hydrating", "exhausted"
    needsHyd,   \* state.needsHydration
    timer,      \* the shouldRehydrate wait: "active", "interrupted", "queued", "done"
    delivered,  \* turns that delivered the notice to the model
    intake,     \* "none", "owed", "sent"
    attempts,   \* intake attempts recorded while waiting for hydration
    errored,    \* hydration given up: the session is in error
    cans,       \* continue-as-new taken
    gh          \* ghost flags
vars == <<issued, pend, prompts, stash, fifo, cur, curOn, hyd, needsHyd, timer, delivered, intake, attempts, errored, cans, gh>>

Init ==
    /\ issued = FALSE /\ pend = FALSE /\ prompts = P /\ stash = <<>> /\ fifo = <<>>
    /\ cur = NoItem /\ curOn = FALSE /\ hyd = "ok" /\ needsHyd = FALSE /\ timer = "active"
    /\ delivered = 0 /\ intake = (IF Intake THEN "owed" ELSE "none") /\ attempts = 0
    /\ errored = FALSE /\ cans = 0 /\ gh = {}

Idle == ~curOn /\ ~errored

(* A lossy hand-off: continue-as-new with the rehydration message; the    *)
(* session must hydrate on the next worker.                               *)
Handoff ==
    /\ Idle /\ ~issued /\ stash = <<>>
    /\ issued' = TRUE /\ pend' = TRUE /\ needsHyd' = TRUE
    /\ UNCHANGED <<prompts, stash, fifo, cur, curOn, hyd, timer, delivered, intake, attempts, errored, cans, gh>>

(* Continue-as-new between passes carries the pending notice.             *)
ContinueAsNew ==
    /\ Idle /\ stash = <<>> /\ cans < 1
    /\ cans' = cans + 1
    /\ pend' = IF Fault = "can-drops-notice" THEN FALSE ELSE pend
    /\ UNCHANGED <<issued, prompts, stash, fifo, cur, curOn, hyd, needsHyd, timer, delivered, intake, attempts, errored, gh>>

(* drain: a prompt arrives. If the shouldRehydrate wait is active, the    *)
(* prompt interrupts it and takes the pending notice into its text.       *)
DrainPrompt ==
    /\ Idle /\ prompts > 0
    /\ LET intr == timer = "active"
           takes == intr /\ pend
       IN \E tooLarge \in (IF AllowTooLarge /\ takes THEN BOOLEAN ELSE {FALSE}) :
          \E cancel \in (IF AllowCancel THEN BOOLEAN ELSE {FALSE}) :
            /\ stash' = Append(stash, [k |-> "prompt", n |-> takes /\ ~tooLarge, sr |-> FALSE, cancel |-> cancel, intr |-> intr])
            /\ pend' = IF takes /\ ~tooLarge THEN FALSE ELSE pend
            /\ timer' = IF intr THEN "interrupted" ELSE timer
            /\ gh' = gh \cup (IF tooLarge THEN {"tooLarge"} ELSE {})
    /\ prompts' = prompts - 1
    /\ UNCHANGED <<issued, fifo, cur, curOn, hyd, needsHyd, delivered, intake, attempts, errored, cans>>

(* appendPromptStashToFifo, then giveBackCarriedWork for the items not    *)
(* queued (cancelled in the pass, or no room).                            *)
RECURSIVE Flush(_, _)
Flush(s, room) ==
    IF s = <<>> THEN [q |-> <<>>, lost |-> <<>>]
    ELSE LET h == Head(s)
             rest == Flush(Tail(s), IF ~h.cancel /\ room > 0 THEN room - 1 ELSE room)
         IN IF ~h.cancel /\ room > 0
            THEN [q |-> <<h>> \o rest.q, lost |-> rest.lost]
            ELSE [q |-> rest.q, lost |-> <<h>> \o rest.lost]
Carries(s) == \E i \in 1..Len(s) : s[i].n
Interrupted(s) == \E i \in 1..Len(s) : s[i].intr

EndDrain ==
    /\ Idle /\ stash # <<>>
    /\ LET f == Flush(stash, FifoCap - Len(fifo))
           lostNotice == Carries(f.lost)
           giveBack == lostNotice /\ ~pend /\ Fault # "no-give-back"
           dupBack == Fault = "give-back-dup" /\ Carries(f.q) /\ ~pend
       IN /\ fifo' = fifo \o f.q
          /\ pend' = (pend \/ giveBack \/ dupBack)
          \* a lost prompt that interrupted the wait gives it back (settleQueuedWorkAfterDecide)
          /\ timer' = IF Interrupted(f.lost) /\ ~Interrupted(f.q) /\ timer = "interrupted" THEN "active" ELSE timer
          /\ gh' = gh \cup (IF giveBack THEN {"gaveBack"} ELSE {})
    /\ stash' = <<>>
    /\ UNCHANGED <<issued, prompts, cur, curOn, hyd, needsHyd, delivered, intake, attempts, errored, cans>>

(* A queued prompt is cancelled at its dispatch (decide).                 *)
LateCancel ==
    /\ Idle /\ AllowLateCancel /\ stash = <<>> /\ fifo # <<>> /\ Head(fifo).k = "prompt"
    /\ LET it == Head(fifo)
           back == LateGiveBack /\ it.n /\ ~pend
       IN /\ fifo' = Tail(fifo)
          /\ pend' = (pend \/ back)
          /\ timer' = IF it.intr /\ timer = "interrupted" THEN "active" ELSE timer
          /\ gh' = gh \cup {"lateCancel"}
    /\ UNCHANGED <<issued, prompts, stash, cur, curOn, hyd, needsHyd, delivered, intake, attempts, errored, cans>>

(* The wait fires; its timer item may be stored compact (T1).             *)
TimerFires ==
    /\ Idle /\ timer = "active" /\ stash = <<>> /\ Len(fifo) < FifoCap
    /\ \E compact \in (IF AllowCompact THEN BOOLEAN ELSE {FALSE}) :
         /\ fifo' = Append(fifo, [NoItem EXCEPT !.k = "timer", !.sr = ~(compact /\ Fault = "compact-drops-flag")])
         /\ gh' = gh \cup (IF compact THEN {"compacted"} ELSE {})
    /\ timer' = "queued"
    /\ UNCHANGED <<issued, pend, prompts, stash, cur, curOn, hyd, needsHyd, delivered, intake, attempts, errored, cans>>

(* A later wait set with shouldRehydrate (an environment assumption).     *)
RearmTimer ==
    /\ Idle /\ Rearm /\ timer = "done" /\ pend
    /\ timer' = "active"
    /\ UNCHANGED <<issued, pend, prompts, stash, fifo, cur, curOn, hyd, needsHyd, delivered, intake, attempts, errored, cans, gh>>

(* decide: the head item's turn starts. A shouldRehydrate timer's prompt  *)
(* is wrapped with the resume context, which consumes the notice.         *)
StartTurn ==
    /\ Idle /\ stash = <<>> /\ fifo # <<>>
    /\ LET it == Head(fifo)
           wrap == it.k = "timer" /\ it.sr
       IN /\ cur' = IF wrap THEN [it EXCEPT !.n = pend] ELSE it
          /\ pend' = IF wrap THEN FALSE ELSE pend
          /\ timer' = IF it.k = "timer" THEN "done" ELSE timer
          /\ gh' = gh \cup (IF it.k = "timer" /\ ~it.sr THEN {"srLost"} ELSE {})
    /\ fifo' = Tail(fifo) /\ curOn' = TRUE
    /\ hyd' = IF needsHyd THEN "hydrating" ELSE "ok"
    /\ UNCHANGED <<issued, prompts, stash, needsHyd, delivered, intake, attempts, errored, cans>>

Hydrate ==
    /\ curOn /\ hyd = "hydrating"
    /\ \E fail \in (IF AllowHydFail THEN BOOLEAN ELSE {FALSE}) :
         IF fail THEN /\ hyd' = "exhausted" /\ UNCHANGED needsHyd
         ELSE /\ hyd' = "ok" /\ needsHyd' = FALSE
    /\ UNCHANGED <<issued, pend, prompts, stash, fifo, cur, curOn, timer, delivered, intake, attempts, errored, cans, gh>>

(* The turn runs: the model gets the notice if the prompt carried it; an  *)
(* owed intake item is sent with it.                                      *)
FinishTurn ==
    /\ curOn /\ hyd = "ok"
    /\ delivered' = delivered + (IF cur.n THEN 1 ELSE 0)
    /\ intake' = IF intake = "owed" THEN "sent" ELSE intake
    /\ gh' = gh \cup (IF intake = "owed" /\ needsHyd THEN {"sentWhileHydrating"} ELSE {})
    /\ timer' = IF cur.intr /\ timer = "interrupted" THEN "active" ELSE timer
    /\ curOn' = FALSE /\ cur' = NoItem
    /\ UNCHANGED <<issued, pend, prompts, stash, fifo, hyd, needsHyd, attempts, errored, cans>>

(* Hydration given up: the turn ends without a send; 1.0.83 records the   *)
(* intake attempt (T3). The session is in error.                          *)
GiveUp ==
    /\ curOn /\ hyd = "exhausted"
    /\ IF intake = "owed"
       THEN IF Fault = "send-while-hydrating"
            THEN /\ intake' = "sent" /\ attempts' = attempts
                 /\ gh' = gh \cup {"sentWhileHydrating"}
            ELSE IF Fault = "unrecorded-wait"
            THEN /\ UNCHANGED <<intake, attempts>> /\ gh' = gh \cup {"waitUnrecorded"}
            ELSE /\ attempts' = attempts + 1 /\ UNCHANGED <<intake, gh>>
       ELSE UNCHANGED <<intake, attempts, gh>>
    /\ errored' = TRUE /\ curOn' = FALSE /\ cur' = NoItem
    /\ UNCHANGED <<issued, pend, prompts, stash, fifo, hyd, needsHyd, timer, delivered, cans>>

Done == (errored \/ (prompts = 0 /\ stash = <<>> /\ fifo = <<>> /\ ~curOn)) /\ UNCHANGED vars

Next == Handoff \/ ContinueAsNew \/ DrainPrompt \/ EndDrain \/ LateCancel \/ TimerFires \/ RearmTimer
        \/ StartTurn \/ Hydrate \/ FinishTurn \/ GiveUp \/ Done
Spec == Init /\ [][Next]_vars
Fairness ==
    /\ WF_vars(DrainPrompt) /\ WF_vars(EndDrain) /\ WF_vars(TimerFires) /\ WF_vars(RearmTimer)
    /\ WF_vars(StartTurn) /\ WF_vars(Hydrate) /\ WF_vars(FinishTurn) /\ WF_vars(GiveUp)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
Count(s) == Cardinality({i \in 1..Len(s) : s[i].n})
Copies == (IF pend THEN 1 ELSE 0) + Count(stash) + Count(fifo) + (IF curOn /\ cur.n THEN 1 ELSE 0) + delivered

TypeOK ==
    /\ {issued, pend, curOn, needsHyd, errored} \subseteq BOOLEAN
    /\ prompts \in 0..P /\ delivered \in 0..2 /\ attempts \in 0..2 /\ cans \in 0..1
    /\ hyd \in {"ok", "hydrating", "exhausted"} /\ timer \in {"active", "interrupted", "queued", "done"}
    /\ intake \in {"none", "owed", "sent"} /\ Len(fifo) <= FifoCap

(* At most one notice, never lost, never duplicated: once issued, exactly *)
(* one copy exists (pending, carried by a prompt or timer, or delivered).  *)
(* A session in error after a given-up hydration is excluded.             *)
Inv_NoticeAccounted == (issued /\ ~errored) => Copies = 1
Inv_DeliveredAtMostOnce == delivered <= 1
(* T1: a timer set with shouldRehydrate keeps it when compacted.          *)
Inv_SrTimerResumes == "srLost" \notin gh
(* T3: nothing is sent to the model while hydration is owed.              *)
Inv_NoSendWhileHydrating == "sentWhileHydrating" \notin gh
(* T3: a turn that waited for hydration records the intake attempt.       *)
Inv_HydrationWaitRecorded == "waitUnrecorded" \notin gh

(* Progress: an issued notice reaches the model (with a later rehydrating *)
(* wait available, Rearm, and no given-up hydration).                     *)
Prop_NoticeDelivered == issued ~> (delivered = 1 \/ errored)
Prop_IntakeSettles == (intake = "owed") ~> (intake = "sent" \/ errored)

(* Witnesses: expected to be violated (reachable).                        *)
W_NoGiveBack == "gaveBack" \notin gh
W_NotDelivered == delivered = 0
W_NoCompaction == "compacted" \notin gh
W_NoTooLarge == "tooLarge" \notin gh
W_NoHydrationWait == attempts = 0
=============================================================================
