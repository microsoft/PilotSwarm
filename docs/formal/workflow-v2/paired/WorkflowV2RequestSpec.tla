------------------------- MODULE WorkflowV2RequestSpec -------------------------
(***************************************************************************)
(* Intent model of the workflow v2 messaging request (request and reply). *)
(*                                                                         *)
(* Derived ONLY from the design text                                       *)
(*   docs/proposals/workflow-messaging-request.md (revision 3, amended)    *)
(*   at commit 8021c75e, blob 3e9b7927.                                    *)
(* It is not derived from code. A separate code-derived model and an       *)
(* explicit refinement mapping to this module follow later.                *)
(*                                                                         *)
(* Scope: one request (one exchange id), its requester workflow, its       *)
(* frozen responder and one other actor. Modeled: the single node          *)
(* compare-and-swap among the response, the deadline elapse, the           *)
(* controller's responder observation, delivery failure, the run's end and *)
(* the requester's deletion; the one deciding clock reading; the request   *)
(* rule and the read-only deleted-requester branch; operation bindings and *)
(* their limit; the durable wake intent with lease tokens, stale holders,  *)
(* retries, moot and abandonment; pause and collection.                    *)
(*                                                                         *)
(* Not modeled: compiler and IR, schema validation (it binds nothing),     *)
(* JSON domain and hashing (a result is an opaque identity), credentials   *)
(* other than "live and related", versions and routing (Q8).               *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Deadline,      \* deadline_at as a clock value
    MaxTime,       \* the last clock value; it stands for all later time
    Ops,           \* operation ids
    Vals,          \* response values
    MaxBindings,   \* the per-request binding limit (50 in the design)
    MaxAttempts,   \* the wake attempt cap (100 in the design)
    Workers,       \* wake dispatchers (worker pass loops)
    AllowPurge,    \* a later retention policy may purge the requester's rows
    Fault          \* "none", or one deliberate deviation from the design

ASSUME Deadline \in Nat /\ MaxTime \in Nat /\ Deadline <= MaxTime
ASSUME MaxBindings \in Nat \ {0} /\ MaxAttempts \in Nat \ {0}
ASSUME AllowPurge \in BOOLEAN
ASSUME Fault \in {"none", "no_lock", "second_reading", "replay_first",
                  "bind_on_deleted", "wake_separate", "no_token",
                  "abandon_twice", "clock_backward"}

Actors      == {"responder", "other"}
Results     == {<<"response", v>> : v \in Vals} \cup {<<"decline", "reason">>}
DefaultRes  == <<"decline", "reason">>
DefaultOp   == CHOOSE o \in Ops : TRUE
NodeResults == {"pending", "responded", "declined", "timed_out", "cancelled",
                "unavailable", "forbidden", "delivery_failed"}
Winners     == {"none", "response", "controller", "cancel", "delete", "delivery"}
Statuses    == {"pending", "responded", "declined", "timed_out", "cancelled",
                "failed"}
Outcomes    == {"none", "decided", "same", "expired", "closed", "conflict"}
Codes       == {"none", "RECEIPT", "REQUEST_EXPIRED", "REQUEST_CLOSED",
                "RESPONSE_CONFLICT", "OPERATION_CONFLICT", "OPERATION_LIMIT",
                "REQUEST_NOT_FOUND"}
WakeStates  == {"absent", "pending", "leased", "dispatched", "moot", "abandoned"}
Settled     == {"dispatched", "moot", "abandoned"}
MaxTokens   == MaxAttempts
Sat(n)      == IF n >= 2 THEN 2 ELSE n

NoBind == [b |-> FALSE, res |-> DefaultRes, outcome |-> "none",
           status |-> "pending", count |-> 0]
NoRec  == [has |-> FALSE, res |-> DefaultRes, op |-> DefaultOp, at |-> 0]
NoLock == [held |-> FALSE, op |-> DefaultOp, res |-> DefaultRes, at |-> 0,
           pend |-> FALSE]
NoWake == [st |-> "absent", tok |-> 0, att |-> 0, due |-> FALSE]
Idle   == [tok |-> 0, ph |-> "idle"]

VARIABLES
    clock,         \* the store's clock (clock_timestamp())
    node,          \* the request node's result; the only decision
    winner,        \* the node's winner column
    decidedAt,     \* the deciding reading (meaningful when node # "pending")
    rec,           \* workflow_request_responses (at most one row)
    bind,          \* workflow_request_operations
    lock,          \* an open response transaction holding the session and node locks
    lastCode,      \* the code of the latest answered call (observation only)
    leak,          \* ghost: an answer other than NOT_FOUND reached a caller the rule refuses
    reqState,      \* the requester's session row: "live", "deleted" (soft) or "purged"
    respLive,      \* the responder's session row is live (and its credential valid)
    related,       \* the responder is the requester's parent or has its owner
    respOrchEnded, \* the responder's session orchestration is terminal
    delivery,      \* the request message: "pending", "delivered" or "failed"
    runEnded,      \* the requesting run has ended (finishRun)
    paused,        \* the requesting run is paused
    collected,     \* the controller has collected the decided node
    wake,          \* workflow_response_wakes (at most one row)
    nextTok,       \* the next fresh lease token
    held,          \* each dispatcher's in-memory lease
    enqueued,      \* wake hints enqueued to the controller (saturating)
    abandonEvents  \* workflow.response_wake_abandoned events (saturating)

nodeVars == <<node, winner, decidedAt, rec>>
callVars == <<bind, lock, lastCode, leak>>
envVars  == <<reqState, respLive, related, respOrchEnded, delivery, runEnded,
              paused>>
wakeVars == <<wake, nextTok, held, enqueued, abandonEvents>>
vars     == <<clock, nodeVars, callVars, envVars, collected, wakeVars>>

-----------------------------------------------------------------------------
(* Derived status (section 3); there is no stored status.                  *)
StatusOf(n) == CASE n = "pending"   -> "pending"
                 [] n = "responded" -> "responded"
                 [] n = "declined"  -> "declined"
                 [] n = "timed_out" -> "timed_out"
                 [] n = "cancelled" -> "cancelled"
                 [] OTHER           -> "failed"
Status == StatusOf(node)

BoundCount == Cardinality({o \in Ops : bind[o].b})

(* The request rule on the rows as they are under the session locks       *)
(* (section 6). Identity and credential verification precede it.          *)
RuleOK(a) == /\ a = "responder"
             /\ respLive
             /\ related
             /\ reqState # "purged"

(* Every node producer except a response waits for an open response       *)
(* transaction: it needs the requester's session row or the node row.     *)
LockBlocks == lock.held /\ Fault # "no_lock"

(* Table 7.1: a known operation, in any request state.                    *)
ReplayCode(o, r) ==
    IF bind[o].res # r
      THEN "OPERATION_CONFLICT"
      ELSE CASE bind[o].outcome \in {"decided", "same"} -> "RECEIPT"
             [] bind[o].outcome = "expired"            -> "REQUEST_EXPIRED"
             [] bind[o].outcome = "closed"             -> "REQUEST_CLOSED"
             [] OTHER                                  -> "RESPONSE_CONFLICT"

TypeOK ==
    /\ clock \in 0..MaxTime
    /\ node \in NodeResults
    /\ winner \in Winners
    /\ decidedAt \in 0..MaxTime
    /\ rec \in [has : BOOLEAN, res : Results, op : Ops, at : 0..MaxTime]
    /\ bind \in [Ops -> [b : BOOLEAN, res : Results, outcome : Outcomes,
                         status : Statuses, count : 0..2]]
    /\ lock \in [held : BOOLEAN, op : Ops, res : Results, at : 0..MaxTime,
                 pend : BOOLEAN]
    /\ lastCode \in Codes
    /\ leak \in BOOLEAN
    /\ reqState \in {"live", "deleted", "purged"}
    /\ respLive \in BOOLEAN
    /\ related \in BOOLEAN
    /\ respOrchEnded \in BOOLEAN
    /\ delivery \in {"pending", "delivered", "failed"}
    /\ runEnded \in BOOLEAN
    /\ paused \in BOOLEAN
    /\ collected \in BOOLEAN
    /\ wake \in [st : WakeStates, tok : 0..MaxTokens, att : 0..MaxAttempts,
                 due : BOOLEAN]
    /\ nextTok \in 1..(MaxTokens + 1)
    /\ held \in [Workers -> [tok : 0..MaxTokens,
                             ph : {"idle", "leased", "enqueued"}]]
    /\ enqueued \in 0..2
    /\ abandonEvents \in 0..2

Init ==
    /\ clock = 0
    /\ node = "pending"
    /\ winner = "none"
    /\ decidedAt = 0
    /\ rec = NoRec
    /\ bind = [o \in Ops |-> NoBind]
    /\ lock = NoLock
    /\ lastCode = "none"
    /\ leak = FALSE
    /\ reqState = "live"
    /\ respLive = TRUE
    /\ related = TRUE
    /\ respOrchEnded = FALSE
    /\ delivery = "pending"
    /\ runEnded = FALSE
    /\ paused = FALSE
    /\ collected = FALSE
    /\ wake = NoWake
    /\ nextTok = 1
    /\ held = [w \in Workers |-> Idle]
    /\ enqueued = 0
    /\ abandonEvents = 0

-----------------------------------------------------------------------------
(* Time.                                                                   *)
Tick ==
    /\ clock < MaxTime
    /\ clock' = clock + 1
    /\ UNCHANGED <<nodeVars, callVars, envVars, collected, wakeVars>>

(* Not the design: the store's clock steps back (for example a failover   *)
(* to a host whose clock is behind). Shows which properties need the      *)
(* monotone clock assumption A-CLK.                                       *)
ClockBack ==
    /\ Fault = "clock_backward"
    /\ clock > 0
    /\ clock' = clock - 1
    /\ UNCHANGED <<nodeVars, callVars, envVars, collected, wakeVars>>

-----------------------------------------------------------------------------
(* A response call (sections 6 and 7). Authentication of the tool's host  *)
(* session always succeeds in this model; actor "other" is an             *)
(* authenticated session that is not the frozen responder. Calls are      *)
(* serialized by the requester's session lock.                            *)

Answer(a, code) ==
    /\ lastCode' = code
    /\ leak' = (leak \/ (code # "REQUEST_NOT_FOUND" /\ ~RuleOK(a)))

BindOnDeleted ==
    (Fault = "bind_on_deleted") /\ (BoundCount < MaxBindings)

Call(a, o, r) ==
    /\ ~lock.held
    /\ IF Fault = "replay_first" /\ bind[o].b
         THEN \* Not the design: the replay branch before the request rule.
              /\ Answer(a, ReplayCode(o, r))
              /\ UNCHANGED <<bind, lock>>
       ELSE IF ~RuleOK(a)
         THEN /\ Answer(a, "REQUEST_NOT_FOUND")
              /\ UNCHANGED <<bind, lock>>
       ELSE IF reqState = "deleted"
         THEN \* Read-only: a replay without a counter change, or CLOSED.
              IF bind[o].b
                THEN /\ Answer(a, ReplayCode(o, r))
                     /\ UNCHANGED <<bind, lock>>
                ELSE /\ Answer(a, "REQUEST_CLOSED")
                     /\ bind' = IF BindOnDeleted
                                  THEN [bind EXCEPT ![o] =
                                          [b |-> TRUE, res |-> r,
                                           outcome |-> "closed",
                                           status |-> Status, count |-> 1]]
                                  ELSE bind
                     /\ UNCHANGED lock
       ELSE IF bind[o].b
         THEN \* Step 4: a known operation replays; only its count changes.
              /\ Answer(a, ReplayCode(o, r))
              /\ bind' = [bind EXCEPT ![o].count = Sat(@ + 1)]
              /\ UNCHANGED lock
       ELSE IF BoundCount >= MaxBindings
         THEN \* Step 6: backpressure; nothing written.
              /\ Answer(a, "OPERATION_LIMIT")
              /\ UNCHANGED <<bind, lock>>
       ELSE \* Step 7: the one clock reading, taken under the locks; the
            \* transaction stays open (the commit may come later).
            /\ lock' = [held |-> TRUE, op |-> o, res |-> r, at |-> clock,
                        pend |-> (node = "pending")]
            /\ UNCHANGED <<bind, lastCode, leak>>
    /\ UNCHANGED <<clock, nodeVars, envVars, collected, wakeVars>>

(* The commit of a new operation: table 7.2 at the reading taken above.   *)
Commit ==
    /\ lock.held
    /\ LET o  == lock.op
           r  == lock.res
           rd == IF Fault = "second_reading" THEN clock ELSE lock.at
           nn == IF r[1] = "response" THEN "responded" ELSE "declined"
       IN
       IF node = "pending" /\ rd < Deadline
         THEN /\ node' = nn
              /\ winner' = "response"
              /\ decidedAt' = rd
              /\ rec' = [has |-> TRUE, res |-> r, op |-> o, at |-> rd]
              /\ bind' = [bind EXCEPT ![o] =
                            [b |-> TRUE, res |-> r, outcome |-> "decided",
                             status |-> StatusOf(nn), count |-> 1]]
              /\ wake' = IF Fault = "wake_separate"
                           THEN wake
                           ELSE [st |-> "pending", tok |-> 0, att |-> 0,
                                 due |-> TRUE]
              /\ lastCode' = "RECEIPT"
       ELSE IF node = "pending"
         THEN /\ bind' = [bind EXCEPT ![o] =
                            [b |-> TRUE, res |-> r, outcome |-> "expired",
                             status |-> "pending", count |-> 1]]
              /\ lastCode' = "REQUEST_EXPIRED"
              /\ UNCHANGED <<nodeVars, wake>>
       ELSE IF node \in {"responded", "declined"}
         THEN /\ bind' = [bind EXCEPT ![o] =
                            [b |-> TRUE, res |-> r,
                             outcome |-> IF r = rec.res THEN "same"
                                                        ELSE "conflict",
                             status |-> Status, count |-> 1]]
              /\ lastCode' = IF r = rec.res THEN "RECEIPT"
                                            ELSE "RESPONSE_CONFLICT"
              /\ UNCHANGED <<nodeVars, wake>>
       ELSE /\ bind' = [bind EXCEPT ![o] =
                          [b |-> TRUE, res |-> r, outcome |-> "closed",
                           status |-> Status, count |-> 1]]
            /\ lastCode' = "REQUEST_CLOSED"
            /\ UNCHANGED <<nodeVars, wake>>
    /\ lock' = NoLock
    /\ UNCHANGED <<clock, leak, envVars, collected, nextTok, held, enqueued,
                   abandonEvents>>

(* Not the design: the wake intent inserted after the response commit, in *)
(* its own transaction. No fairness: a crash may lose it for ever.        *)
LateWakeInsert ==
    /\ Fault = "wake_separate"
    /\ rec.has
    /\ wake.st = "absent"
    /\ wake' = [st |-> "pending", tok |-> 0, att |-> 0, due |-> TRUE]
    /\ UNCHANGED <<clock, nodeVars, callVars, envVars, collected, nextTok,
                   held, enqueued, abandonEvents>>

-----------------------------------------------------------------------------
(* The other terminal producers (section 4.1).                             *)

(* The controller's request-aware elapse: one reading at or after the     *)
(* deadline. It may decide while the run is paused (D03, finding F5).     *)
Elapse ==
    /\ ~LockBlocks
    /\ node = "pending"
    /\ clock >= Deadline
    /\ node' = "timed_out"
    /\ winner' = "controller"
    /\ decidedAt' = clock
    /\ UNCHANGED <<clock, rec, callVars, envVars, collected, wakeVars>>

(* The controller's responder observation (4.4), only before the deadline. *)
Observe ==
    /\ ~LockBlocks
    /\ node = "pending"
    /\ clock < Deadline
    /\ (~respLive \/ respOrchEnded \/ ~related)
    /\ node' = IF ~respLive \/ respOrchEnded THEN "unavailable" ELSE "forbidden"
    /\ winner' = "controller"
    /\ decidedAt' = clock
    /\ UNCHANGED <<clock, rec, callVars, envVars, collected, wakeVars>>

(* The delivery record; a response may precede it.                        *)
Deliver ==
    /\ delivery = "pending"
    /\ delivery' = "delivered"
    /\ UNCHANGED <<clock, nodeVars, callVars, reqState, respLive, related,
                   respOrchEnded, runEnded, paused, collected, wakeVars>>

(* failDelivery, beginDelivery's refusals, or collection of an ended      *)
(* delivery orchestration with the message pending. Assumption L1: it     *)
(* serializes with an open response transaction (node row lock).          *)
DeliveryFail ==
    /\ ~LockBlocks
    /\ delivery = "pending"
    /\ delivery' = "failed"
    /\ IF node = "pending"
         THEN \E c \in {"unavailable", "forbidden", "delivery_failed"} :
                /\ node' = c
                /\ winner' = "delivery"
                /\ decidedAt' = clock
         ELSE UNCHANGED <<node, winner, decidedAt>>
    /\ UNCHANGED <<clock, rec, callVars, reqState, respLive, related,
                   respOrchEnded, runEnded, paused, collected, wakeVars>>

(* finishRun: cancel, recover, stop, or the run's later end.              *)
RunEnd ==
    /\ ~LockBlocks
    /\ ~runEnded
    /\ runEnded' = TRUE
    /\ IF node = "pending"
         THEN \E w \in {"cancel", "controller"} :
                /\ node' = "cancelled"
                /\ winner' = w
                /\ decidedAt' = clock
         ELSE UNCHANGED <<node, winner, decidedAt>>
    /\ UNCHANGED <<clock, rec, callVars, reqState, respLive, related,
                   respOrchEnded, delivery, paused, collected, wakeVars>>

(* Soft delete of the requesting workflow; the trigger cancels the        *)
(* pending node in the same transaction.                                  *)
DeleteRequester ==
    /\ ~LockBlocks
    /\ reqState = "live"
    /\ reqState' = "deleted"
    /\ IF node = "pending"
         THEN /\ node' = "cancelled"
              /\ winner' = "delete"
              /\ decidedAt' = clock
         ELSE UNCHANGED <<node, winner, decidedAt>>
    /\ UNCHANGED <<clock, rec, callVars, respLive, related, respOrchEnded,
                   delivery, runEnded, paused, collected, wakeVars>>

(* A later, separately reviewed retention policy (not in this design).    *)
Purge ==
    /\ AllowPurge
    /\ reqState = "deleted"
    /\ reqState' = "purged"
    /\ UNCHANGED <<clock, nodeVars, callVars, respLive, related, respOrchEnded,
                   delivery, runEnded, paused, collected, wakeVars>>

(* Changes to the responder: they wait on its FOR SHARE lock.             *)
DeleteResponder ==
    /\ ~LockBlocks
    /\ respLive
    /\ respLive' = FALSE
    /\ UNCHANGED <<clock, nodeVars, callVars, reqState, related, respOrchEnded,
                   delivery, runEnded, paused, collected, wakeVars>>

LoseAuthority ==
    /\ ~LockBlocks
    /\ related
    /\ related' = FALSE
    /\ UNCHANGED <<clock, nodeVars, callVars, reqState, respLive, respOrchEnded,
                   delivery, runEnded, paused, collected, wakeVars>>

RespOrchEnd ==
    /\ ~respOrchEnded
    /\ respOrchEnded' = TRUE
    /\ UNCHANGED <<clock, nodeVars, callVars, reqState, respLive, related,
                   delivery, runEnded, paused, collected, wakeVars>>

Pause ==
    /\ ~paused
    /\ ~runEnded
    /\ paused' = TRUE
    /\ UNCHANGED <<clock, nodeVars, callVars, reqState, respLive, related,
                   respOrchEnded, delivery, runEnded, collected, wakeVars>>

Resume ==
    /\ paused
    /\ paused' = FALSE
    /\ UNCHANGED <<clock, nodeVars, callVars, reqState, respLive, related,
                   respOrchEnded, delivery, runEnded, collected, wakeVars>>

(* The controller collects a decided node, on a wake hint or its backstop. *)
Collect ==
    /\ node # "pending"
    /\ ~paused
    /\ ~runEnded
    /\ ~collected
    /\ collected' = TRUE
    /\ UNCHANGED <<clock, nodeVars, callVars, envVars, wakeVars>>

-----------------------------------------------------------------------------
(* The durable wake intent (section 5). Time for the wake row is          *)
(* abstracted: WakeDue stands for next_attempt_at or lease_until passing.  *)

WakeLease(w) ==
    /\ held[w].ph = "idle"
    /\ wake.st \in {"pending", "leased"}
    /\ wake.due
    /\ wake.att < MaxAttempts
    /\ nextTok <= MaxTokens
    /\ wake' = [st |-> "leased", tok |-> nextTok, att |-> wake.att + 1,
                due |-> FALSE]
    /\ held' = [held EXCEPT ![w] = [tok |-> nextTok, ph |-> "leased"]]
    /\ nextTok' = nextTok + 1
    /\ UNCHANGED <<clock, nodeVars, callVars, envVars, collected, enqueued,
                   abandonEvents>>

WakeDue ==
    /\ wake.st \in {"pending", "leased"}
    /\ ~wake.due
    /\ wake' = [wake EXCEPT !.due = TRUE]
    /\ UNCHANGED <<clock, nodeVars, callVars, envVars, collected, nextTok, held,
                   enqueued, abandonEvents>>

(* Any holder, current or stale, may enqueue a hint: duplicates are       *)
(* harmless because collection is idempotent.                             *)
WakeEnqueue(w) ==
    /\ held[w].ph = "leased"
    /\ held' = [held EXCEPT ![w].ph = "enqueued"]
    /\ enqueued' = Sat(enqueued + 1)
    /\ UNCHANGED <<clock, nodeVars, callVars, envVars, collected, wake, nextTok,
                   abandonEvents>>

(* A holder's completion, conditioned on its token and state "leased".    *)
(*  dispatched: the enqueue returned;                                     *)
(*  retry: the enqueue or the lifecycle read failed or was unknown        *)
(*         (also after an enqueue whose acknowledgement was lost);        *)
(*  moot: a successful lifecycle read showed the run ended.               *)
WakeMatch(w) ==
    IF Fault = "no_token"
      THEN wake.st # "absent"
      ELSE (wake.st = "leased") /\ (wake.tok = held[w].tok)

WakeFinish(w, how) ==
    /\ held[w].ph \in {"leased", "enqueued"}
    /\ (how = "dispatched") => (held[w].ph = "enqueued")
    /\ (how = "moot") => runEnded
    /\ wake' = IF ~WakeMatch(w)
                 THEN wake
                 ELSE CASE how = "dispatched" ->
                             [wake EXCEPT !.st = "dispatched", !.tok = 0]
                        [] how = "moot" ->
                             [wake EXCEPT !.st = "moot", !.tok = 0]
                        [] OTHER ->
                             [wake EXCEPT !.st = "pending", !.tok = 0,
                                          !.due = FALSE]
    /\ held' = [held EXCEPT ![w] = Idle]
    /\ UNCHANGED <<clock, nodeVars, callVars, envVars, collected, nextTok,
                   enqueued, abandonEvents>>

(* A pass abandons a due row with the full attempt count: requester's     *)
(* session lock first, then the wake row with the unsettled condition.    *)
AbandonGuard ==
    IF Fault = "abandon_twice"
      THEN (wake.st # "absent") /\ (wake.att = MaxAttempts)
      ELSE /\ wake.st \in {"pending", "leased"}
           /\ wake.due
           /\ wake.att = MaxAttempts

WakeAbandon ==
    /\ ~LockBlocks
    /\ AbandonGuard
    /\ wake' = [wake EXCEPT !.st = "abandoned", !.tok = 0]
    /\ abandonEvents' = IF reqState = "live" THEN Sat(abandonEvents + 1)
                                            ELSE abandonEvents
    /\ UNCHANGED <<clock, nodeVars, callVars, envVars, collected, nextTok, held,
                   enqueued>>

-----------------------------------------------------------------------------
WakeFinishAny(w) ==
    \E how \in {"dispatched", "retry", "moot"} : WakeFinish(w, how)

Next ==
    \/ Tick
    \/ ClockBack
    \/ \E a \in Actors, o \in Ops, r \in Results : Call(a, o, r)
    \/ Commit
    \/ LateWakeInsert
    \/ Elapse
    \/ Observe
    \/ Deliver
    \/ DeliveryFail
    \/ RunEnd
    \/ DeleteRequester
    \/ Purge
    \/ DeleteResponder
    \/ LoseAuthority
    \/ RespOrchEnd
    \/ Pause
    \/ Resume
    \/ Collect
    \/ \E w \in Workers : WakeLease(w)
    \/ WakeDue
    \/ \E w \in Workers : WakeEnqueue(w)
    \/ \E w \in Workers : WakeFinishAny(w)
    \/ WakeAbandon

Spec == Init /\ [][Next]_vars

(* Liveness assumptions (README: A-SCHED, A-RESUME, A-BACKSTOP).           *)
Fairness ==
    /\ WF_vars(Tick)
    /\ WF_vars(Commit)
    /\ WF_vars(Elapse)
    /\ WF_vars(Resume)
    /\ SF_vars(Collect)
    /\ WF_vars(\E w \in Workers : WakeLease(w))
    /\ WF_vars(WakeDue)
    /\ \A w \in Workers : WF_vars(WakeEnqueue(w))
    /\ \A w \in Workers : WF_vars(WakeFinishAny(w))
    /\ WF_vars(WakeAbandon)

LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
(* Safety: state invariants.                                               *)

(* Section 3: the status mapping is total; no other combination exists.    *)
Inv_StatusTotal ==
    /\ (node = "pending") <=> (winner = "none")
    /\ rec.has <=> (node \in {"responded", "declined"})
    /\ rec.has => ((rec.res[1] = "response") <=> (node = "responded"))
    /\ (node \in {"responded", "declined"}) => (winner = "response")
    /\ (node = "timed_out") => (winner = "controller")
    /\ (node = "cancelled") => (winner \in {"cancel", "controller", "delete"})
    /\ (node \in {"unavailable", "forbidden"}) =>
          (winner \in {"controller", "delivery"})
    /\ (node = "delivery_failed") => (winner = "delivery")

(* Q2: one deciding reading; equality is late.                             *)
Inv_Deadline ==
    /\ (node \in {"responded", "declined"}) => (decidedAt < Deadline)
    /\ rec.has => (rec.at = decidedAt)
    /\ (node = "timed_out") => (decidedAt >= Deadline)
    /\ (winner = "controller" /\ node \in {"unavailable", "forbidden"})
          => (decidedAt < Deadline)

(* Q5: the winner is bound "decided" to its own result; at most one       *)
(* decided binding; the limit holds.                                      *)
Inv_WinnerBinding ==
    /\ rec.has => /\ bind[rec.op].b
                  /\ bind[rec.op].outcome = "decided"
                  /\ bind[rec.op].res = rec.res
    /\ \A o1, o2 \in Ops :
          (bind[o1].outcome = "decided" /\ bind[o2].outcome = "decided")
             => (o1 = o2)
    /\ (\E o \in Ops : bind[o].outcome = "decided") => rec.has
    /\ BoundCount <= MaxBindings

(* Section 7: "the winner is always the first binding": no response is    *)
(* decided after some operation was told REQUEST_EXPIRED. Needs A-CLK.    *)
Inv_NoDecisionAfterExpiry ==
    rec.has => (\A o \in Ops : bind[o].outcome # "expired")

(* Q4 and section 6: nothing but NOT_FOUND reaches a caller the rule refuses. *)
Inv_NoLeak == ~leak

(* Q7: the wake intent exists exactly when a response record exists.      *)
Inv_WakeWithRecord == rec.has <=> (wake.st # "absent")

(* Q7: at most one abandonment event.                                      *)
Inv_OneAbandonEvent == abandonEvents <= 1

-----------------------------------------------------------------------------
(* Safety: action properties.                                              *)

(* Q1: the first winner stays.                                            *)
Prop_NodeFinal ==
    [][(node # "pending") =>
         (node' = node /\ winner' = winner /\ decidedAt' = decidedAt)]_vars

(* Q5: the response record is immutable.                                  *)
Prop_RecordImmutable == [][rec.has => (rec' = rec)]_vars

(* Q5: no binding is replaced; only its count may change.                  *)
Prop_BindingImmutable ==
    [][\A o \in Ops :
         bind[o].b => (/\ bind'[o].b
                       /\ bind'[o].res = bind[o].res
                       /\ bind'[o].outcome = bind[o].outcome
                       /\ bind'[o].status = bind[o].status)]_vars

(* Section 6: with a deleted or purged requester every answer is          *)
(* read-only: no binding is added and no count changes.                   *)
Prop_DeletedRequesterReadOnly == [][(reqState # "live") => (bind' = bind)]_vars

(* Q4: a response decides only with a live requester and a live, allowed  *)
(* responder.                                                             *)
Prop_DecideNeedsLiveParties ==
    [][(~rec.has /\ rec'.has) =>
         (reqState = "live" /\ respLive /\ related)]_vars

(* 4.3, T061: a decision whose one reading is before the deadline wins,   *)
(* even when its commit comes after the deadline.                         *)
Prop_EarlyDecisionWins ==
    [][(lock.held /\ ~lock'.held /\ lock.pend /\ lock.at < Deadline)
         => (node' \in {"responded", "declined"})]_vars

(* Q7: a settled wake never changes.                                       *)
Prop_SettledWakeFinal == [][(wake.st \in Settled) => (wake' = wake)]_vars

(* Q6: no decision of the requesting side changes the peer's lifecycle.   *)
Prop_PeerUntouched ==
    [][(node' # node) =>
         (respLive' = respLive /\ respOrchEnded' = respOrchEnded
          /\ related' = related)]_vars

-----------------------------------------------------------------------------
(* Liveness (under Fairness, Fault = "none").                              *)

Live_Decides == <>(node # "pending")

Live_WakeSettles == rec.has ~> (wake.st \in Settled)

Live_Collected == (node # "pending") ~> (collected \/ runEnded)

-----------------------------------------------------------------------------
(* Witnesses: each is EXPECTED to be violated, which shows the situation  *)
(* is reachable and the safety PASS is not vacuous.                        *)

Wit_Responded  == node # "responded"
Wit_Declined   == node # "declined"
Wit_TimedOut   == node # "timed_out"
Wit_Observed   == ~(winner = "controller" /\ node = "unavailable")
Wit_OpLimit    == lastCode # "OPERATION_LIMIT"
Wit_OpConflict == lastCode # "OPERATION_CONFLICT"
Wit_Collected  == ~collected
(* A response transaction whose reading is before the deadline still open *)
(* after it (T061).                                                       *)
Wit_StraddleDeadline ==
    ~(lock.held /\ lock.pend /\ lock.at < Deadline /\ clock >= Deadline)
(* A holder whose lease was reclaimed still acts.                          *)
Wit_StaleHolder ==
    ~(\E w \in Workers : held[w].ph # "idle" /\ held[w].tok # wake.tok)
Wit_Abandoned  == wake.st # "abandoned"
Wit_Moot       == wake.st # "moot"
(* F3: "abandoned" after a hint was already enqueued.                      *)
Wit_AbandonedAfterEnqueue == ~(wake.st = "abandoned" /\ enqueued > 0)
(* F4: a delivery failure decides after the deadline, not timed_out.       *)
Wit_DeliveryFailedAfterDeadline ==
    ~(winner = "delivery" /\ decidedAt >= Deadline)
(* F2: a new operation after a response won and the requester was deleted. *)
Wit_ClosedAfterResponseThenDelete ==
    ~(lastCode = "REQUEST_CLOSED" /\ reqState = "deleted"
      /\ node \in {"responded", "declined"})
(* F5: timed_out decided while the run is paused.                          *)
Wit_TimedOutWhilePaused == ~(node = "timed_out" /\ paused /\ ~collected)

=============================================================================
