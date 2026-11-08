------------------------- MODULE WorkflowV2RequestCode -------------------------
(***************************************************************************)
(* Code model of the workflow v2 request store, derived from the source at *)
(* commit 8021c75e (packages/sdk/src/workflow/v2/store.ts,                 *)
(* authority.ts, runtime.ts; migrations workflow-v2-0087.ts and            *)
(* workflow-v2-0093.ts). It models what the code does, not what the       *)
(* design intends; the mapping to WorkflowV2RequestSpec is at the end.     *)
(*                                                                         *)
(* At 8021c75e the request is a disabled foundation: no runtime path      *)
(* enters a request state (the plan activity refuses it, runtime.ts 1376), *)
(* failDelivery and beginDelivery refuse a request message (store.ts 2985, *)
(* 3053, 3101), and there is no request-aware elapse, no observation and   *)
(* no wake dispatcher. The model therefore covers the store API on one     *)
(* request already entered pending (enterNode, store.ts 2240-2345): the    *)
(* response transaction (respondToRequest, store.ts 2779-2936), finishRun  *)
(* (3133), the session-deletion trigger (0087), changes to the responder,  *)
(* and, only when Caller = "store_api", the generic elapseWait (2442),     *)
(* which no runtime calls for a request node at this commit.               *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Deadline, MaxTime, Ops, Vals, MaxBindings, Caller

ASSUME Deadline \in Nat /\ MaxTime \in Nat /\ Deadline <= MaxTime
ASSUME MaxBindings \in Nat \ {0}
ASSUME Caller \in {"runtime_8021", "store_api"}

Actors     == {"responder", "other"}
Results    == {<<"response", v>> : v \in Vals} \cup {<<"decline", "reason">>}
DefaultRes == <<"decline", "reason">>
DefaultOp  == CHOOSE o \in Ops : TRUE
Sat(n)     == IF n >= 2 THEN 2 ELSE n

NoBind == [b |-> FALSE, res |-> DefaultRes, outcome |-> "none",
           status |-> "pending", count |-> 0]
NoResp == [has |-> FALSE, res |-> DefaultRes, op |-> DefaultOp, at |-> 0]
NoTxn  == [pc |-> "idle", a |-> "other", op |-> DefaultOp, res |-> DefaultRes,
           at |-> 0, pend |-> FALSE]

VARIABLES
    clock,     \* clock_timestamp()
    sReq,      \* the requester's session row: "live" or "deleted" (deleted_at set)
    sResp,     \* the responder's session row is live
    rel,       \* the responder passes decideTypedInputAuthority for the requester
    runSt,     \* the run: "active", "ended" (finishRun) or "cancelled" (deletion trigger)
    finished,  \* finishRun ended the run (history variable for the mapping)
    nd,        \* workflow_node_executions row of the request
    resp,      \* workflow_request_responses row
    ops,       \* workflow_request_operations rows
    wakeRow,   \* workflow_response_wakes row: "absent" or "pending" (nothing settles it here)
    txn,       \* the open respondToRequest transaction (holds the requester's row lock)
    lastCode,  \* the code the latest call returned
    leak       \* ghost: an answer other than NOT_FOUND to an actor the rule refuses

cvars == <<clock, sReq, sResp, rel, runSt, finished, nd, resp, ops, wakeRow,
           txn, lastCode, leak>>

NodeIdle == [st |-> "pending", outcome |-> "none", kind |-> "none",
             winner |-> "none", at |-> 0]

(* requestStatusOf (store.ts 761-776); "corrupt" stands for its throw.     *)
CStatus ==
    IF nd.st = "pending"
      THEN IF resp.has THEN "corrupt" ELSE "pending"
    ELSE IF nd.kind = "business"
      THEN IF nd.winner = "response" /\ nd.outcome = "responded" /\ resp.has
                /\ resp.res[1] = "response" THEN "responded"
           ELSE IF nd.winner = "response" /\ nd.outcome = "declined" /\ resp.has
                /\ resp.res[1] = "decline" THEN "declined"
           ELSE "corrupt"
    ELSE IF nd.kind = "runtime_error" /\ ~resp.has
      THEN IF nd.outcome = "cancelled" THEN "cancelled" ELSE "corrupt"
    ELSE "corrupt"

BoundCount == Cardinality({o \in Ops : ops[o].b})

(* decideRequestAuthority (authority.ts 89-99) on the rows lockSessionPair *)
(* found: the frozen responder, the requester row present (deleted kept),  *)
(* the typed-input rule with the requester taken as not deleted.           *)
CRule(a) == a = "responder" /\ sResp /\ rel

ReplayCode(o, r) ==
    IF ops[o].res # r
      THEN "OPERATION_CONFLICT"
      ELSE CASE ops[o].outcome \in {"decided", "same"} -> "RECEIPT"
             [] ops[o].outcome = "expired"            -> "REQUEST_EXPIRED"
             [] ops[o].outcome = "closed"             -> "REQUEST_CLOSED"
             [] OTHER                                 -> "RESPONSE_CONFLICT"

Answer(a, code) ==
    /\ lastCode' = code
    /\ leak' = (leak \/ (code # "REQUEST_NOT_FOUND" /\ ~CRule(a)))

TypeOK_C ==
    /\ clock \in 0..MaxTime
    /\ sReq \in {"live", "deleted"}
    /\ sResp \in BOOLEAN /\ rel \in BOOLEAN
    /\ runSt \in {"active", "ended", "cancelled"}
    /\ finished \in BOOLEAN
    /\ nd \in [st : {"pending", "completed"},
               outcome : {"none", "responded", "declined", "elapsed", "cancelled"},
               kind : {"none", "business", "runtime_error"},
               winner : {"none", "response", "controller", "cancel", "delete"},
               at : 0..MaxTime]
    /\ resp \in [has : BOOLEAN, res : Results, op : Ops, at : 0..MaxTime]
    /\ ops \in [Ops -> [b : BOOLEAN, res : Results,
                        outcome : {"none", "decided", "same", "expired", "closed", "conflict"},
                        status : {"pending", "responded", "declined", "timed_out", "cancelled", "failed"},
                        count : 0..2]]
    /\ wakeRow \in {"absent", "pending"}
    /\ txn \in [pc : {"idle", "locked", "read"}, a : Actors, op : Ops,
                res : Results, at : 0..MaxTime, pend : BOOLEAN]
    /\ lastCode \in {"none", "RECEIPT", "REQUEST_EXPIRED", "REQUEST_CLOSED",
                     "RESPONSE_CONFLICT", "OPERATION_CONFLICT", "OPERATION_LIMIT",
                     "REQUEST_NOT_FOUND", "WORKFLOW_STORE_CORRUPT"}
    /\ leak \in BOOLEAN

(* enterNode admitted the request pending at reading 0 with deadline_at =  *)
(* Deadline (store.ts 2284-2333); its outbox row stays pending.            *)
Init ==
    /\ clock = 0
    /\ sReq = "live" /\ sResp = TRUE /\ rel = TRUE
    /\ runSt = "active" /\ finished = FALSE
    /\ nd = NodeIdle
    /\ resp = NoResp
    /\ ops = [o \in Ops |-> NoBind]
    /\ wakeRow = "absent"
    /\ txn = NoTxn
    /\ lastCode = "none" /\ leak = FALSE

-----------------------------------------------------------------------------
CTick ==
    /\ clock < MaxTime
    /\ clock' = clock + 1
    /\ UNCHANGED <<sReq, sResp, rel, runSt, finished, nd, resp, ops, wakeRow,
                   txn, lastCode, leak>>

(* respondToRequest, step 1 (store.ts 2785-2795): read the request row,    *)
(* lockSessionPair (requester FOR NO KEY UPDATE, actor FOR SHARE), then    *)
(* the rule. A refusal is REQUEST_NOT_FOUND and the transaction ends.      *)
RLock(a, o, r) ==
    /\ txn.pc = "idle"
    /\ IF CRule(a)
         THEN /\ txn' = [pc |-> "locked", a |-> a, op |-> o, res |-> r,
                         at |-> 0, pend |-> FALSE]
              /\ UNCHANGED <<lastCode, leak>>
         ELSE /\ Answer(a, "REQUEST_NOT_FOUND")
              /\ UNCHANGED txn
    /\ UNCHANGED <<clock, sReq, sResp, rel, runSt, finished, nd, resp, ops,
                   wakeRow>>

(* Steps 2 to 7 up to the clock reading (store.ts 2797-2878). Validation   *)
(* failures write nothing and are not modeled. The known-operation branch  *)
(* (2817-2841), the deleted-requester branch (2844-2847) and the limit     *)
(* (2864-2870) end the transaction; otherwise the node row is locked and   *)
(* the clock read once.                                                    *)
RBody ==
    /\ txn.pc = "locked"
    /\ LET a == txn.a
           o == txn.op
           r == txn.res
       IN
       IF ops[o].b
         THEN /\ Answer(a, ReplayCode(o, r))
              /\ ops' = IF sReq = "live"
                          THEN [ops EXCEPT ![o].count = Sat(@ + 1)]
                          ELSE ops
              /\ txn' = NoTxn
       ELSE IF sReq # "live"
         THEN /\ Answer(a, "REQUEST_CLOSED")
              /\ UNCHANGED ops
              /\ txn' = NoTxn
       ELSE IF BoundCount >= MaxBindings
         THEN /\ Answer(a, "OPERATION_LIMIT")
              /\ UNCHANGED ops
              /\ txn' = NoTxn
       ELSE /\ txn' = [txn EXCEPT !.pc = "read", !.at = clock,
                                  !.pend = (nd.st = "pending")]
            /\ UNCHANGED <<ops, lastCode, leak>>
    /\ UNCHANGED <<clock, sReq, sResp, rel, runSt, finished, nd, resp, wakeRow>>

(* Step 7 after the reading (store.ts 2879-2935): the committed state      *)
(* checked whole, then the decision and the binding, in one commit.        *)
RCommit ==
    /\ txn.pc = "read"
    /\ LET o  == txn.op
           r  == txn.res
           at == txn.at
           st == CStatus
           nn == IF r[1] = "response" THEN "responded" ELSE "declined"
           Bind(oc, s) == ops' = [ops EXCEPT ![o] =
                              [b |-> TRUE, res |-> r, outcome |-> oc,
                               status |-> s, count |-> 1]]
       IN
       IF st = "corrupt"
         THEN /\ lastCode' = "WORKFLOW_STORE_CORRUPT"
              /\ UNCHANGED <<nd, resp, ops, wakeRow>>
       ELSE IF st = "pending" /\ at < Deadline
         THEN /\ nd' = [st |-> "completed", outcome |-> nn, kind |-> "business",
                        winner |-> "response", at |-> at]
              /\ resp' = [has |-> TRUE, res |-> r, op |-> o, at |-> at]
              /\ Bind("decided", nn)
              /\ wakeRow' = "pending"
              /\ lastCode' = "RECEIPT"
       ELSE IF st = "pending"
         THEN /\ Bind("expired", "pending")
              /\ lastCode' = "REQUEST_EXPIRED"
              /\ UNCHANGED <<nd, resp, wakeRow>>
       ELSE IF st \in {"responded", "declined"}
         THEN /\ Bind(IF r = resp.res THEN "same" ELSE "conflict", st)
              /\ lastCode' = IF r = resp.res THEN "RECEIPT" ELSE "RESPONSE_CONFLICT"
              /\ UNCHANGED <<nd, resp, wakeRow>>
       ELSE /\ Bind("closed", st)
            /\ lastCode' = "REQUEST_CLOSED"
            /\ UNCHANGED <<nd, resp, wakeRow>>
    /\ txn' = NoTxn
    /\ UNCHANGED <<clock, sReq, sResp, rel, runSt, finished, leak>>

(* finishRun (store.ts 3156-3189): lockLiveSession, lockRun; nothing when  *)
(* the requester is deleted or the run is not active; else every pending   *)
(* node becomes cancelled (runtime error) with endPending.winner.          *)
CFinishRun ==
    /\ txn.pc = "idle"
    /\ sReq = "live"
    /\ runSt = "active"
    /\ runSt' = "ended"
    /\ finished' = TRUE
    /\ IF nd.st = "pending"
         THEN \E w \in {"cancel", "controller"} :
                nd' = [st |-> "completed", outcome |-> "cancelled",
                       kind |-> "runtime_error", winner |-> w, at |-> clock]
         ELSE UNCHANGED nd
    /\ UNCHANGED <<clock, sReq, sResp, rel, resp, ops, wakeRow, txn, lastCode,
                   leak>>

(* Soft delete of the requester: its row update waits for the FOR NO KEY  *)
(* UPDATE lock; the 0087 trigger cancels pending nodes of an active run    *)
(* (winner delete) and cancels the run.                                    *)
CDelete ==
    /\ txn.pc = "idle"
    /\ sReq = "live"
    /\ sReq' = "deleted"
    /\ IF nd.st = "pending" /\ runSt = "active"
         THEN nd' = [st |-> "completed", outcome |-> "cancelled",
                     kind |-> "runtime_error", winner |-> "delete", at |-> clock]
         ELSE UNCHANGED nd
    /\ runSt' = IF runSt = "active" THEN "cancelled" ELSE runSt
    /\ UNCHANGED <<clock, sResp, rel, finished, resp, ops, wakeRow, txn,
                   lastCode, leak>>

(* The responder's row update waits for the FOR SHARE lock.                *)
CDeleteResponder ==
    /\ txn.pc = "idle"
    /\ sResp
    /\ sResp' = FALSE
    /\ UNCHANGED <<clock, sReq, rel, runSt, finished, nd, resp, ops, wakeRow,
                   txn, lastCode, leak>>

(* Assumption A-OWN: the authority inputs that lockSessionPair reads but  *)
(* does not lock (session_owners, users, the definition's parent) change   *)
(* only while no response transaction holds the session locks.            *)
CLoseAuthority ==
    /\ txn.pc = "idle"
    /\ rel
    /\ rel' = FALSE
    /\ UNCHANGED <<clock, sReq, sResp, runSt, finished, nd, resp, ops, wakeRow,
                   txn, lastCode, leak>>

(* elapseWait (store.ts 2442-2475) as written: lockLiveSession, then one   *)
(* statement completes ANY pending wait or messaging node whose            *)
(* deadline_at has passed, as business "elapsed", winner controller. Only *)
(* with Caller = "store_api": at 8021c75e no runtime path calls it for a   *)
(* request node.                                                           *)
CElapse ==
    /\ Caller = "store_api"
    /\ txn.pc = "idle"
    /\ sReq = "live"
    /\ nd.st = "pending"
    /\ clock >= Deadline
    /\ nd' = [st |-> "completed", outcome |-> "elapsed", kind |-> "business",
              winner |-> "controller", at |-> clock]
    /\ UNCHANGED <<clock, sReq, sResp, rel, runSt, finished, resp, ops, wakeRow,
                   txn, lastCode, leak>>

CNext ==
    \/ CTick
    \/ \E a \in Actors, o \in Ops, r \in Results : RLock(a, o, r)
    \/ RBody
    \/ RCommit
    \/ CFinishRun
    \/ CDelete
    \/ CDeleteResponder
    \/ CLoseAuthority
    \/ CElapse

CSpec == Init /\ [][CNext]_cvars

-----------------------------------------------------------------------------
(* Code-level checks.                                                      *)

(* requestStatusOf never throws on a committed state.                      *)
Inv_C_StatusMapped == CStatus # "corrupt"

(* No call ends in WORKFLOW_STORE_CORRUPT.                                  *)
Inv_C_NoCorruptAnswer == lastCode # "WORKFLOW_STORE_CORRUPT"

-----------------------------------------------------------------------------
(* Refinement mapping to the intent model. Concrete steps map as follows: *)
(*   CTick -> Tick; RLock refused -> Call (NOT_FOUND); RLock allowed ->    *)
(*   stutter; RBody -> Call; RCommit -> Commit; CFinishRun -> RunEnd;      *)
(*   CDelete -> DeleteRequester; CDeleteResponder -> DeleteResponder;      *)
(*   CLoseAuthority -> LoseAuthority. CElapse has no image: its node       *)
(*   result is not an intent-model result.                                 *)
(* Unimplemented intent actions (Elapse, Observe, Deliver, DeliveryFail,   *)
(* Purge, RespOrchEnd, Pause, Resume, Collect and every wake step) have no *)
(* concrete counterpart at 8021c75e; their variables map to constants.     *)

MapNode ==
    CASE nd.st = "pending"         -> "pending"
      [] nd.outcome = "responded"  -> "responded"
      [] nd.outcome = "declined"   -> "declined"
      [] nd.outcome = "cancelled"  -> "cancelled"
      [] OTHER                     -> "elapsed_unmapped"

MapLock ==
    IF txn.pc = "read"
      THEN [held |-> TRUE, op |-> txn.op, res |-> txn.res, at |-> txn.at,
            pend |-> txn.pend]
      ELSE [held |-> FALSE, op |-> DefaultOp, res |-> DefaultRes, at |-> 0,
            pend |-> FALSE]

MapWake ==
    IF wakeRow = "pending"
      THEN [st |-> "pending", tok |-> 0, att |-> 0, due |-> TRUE]
      ELSE [st |-> "absent", tok |-> 0, att |-> 0, due |-> FALSE]

A == INSTANCE WorkflowV2RequestSpec WITH
        Deadline <- Deadline, MaxTime <- MaxTime, Ops <- Ops, Vals <- Vals,
        MaxBindings <- MaxBindings, MaxAttempts <- 1, Workers <- {"w1"},
        AllowPurge <- FALSE, Fault <- "none",
        clock <- clock,
        node <- MapNode,
        winner <- IF nd.st = "pending" THEN "none" ELSE nd.winner,
        decidedAt <- nd.at,
        rec <- resp,
        bind <- ops,
        lock <- MapLock,
        lastCode <- lastCode,
        leak <- leak,
        reqState <- sReq,
        respLive <- sResp,
        related <- rel,
        respOrchEnded <- FALSE,
        delivery <- "pending",
        runEnded <- finished,
        paused <- FALSE,
        collected <- FALSE,
        wake <- MapWake,
        nextTok <- 1,
        held <- [w \in {"w1"} |-> [tok |-> 0, ph |-> "idle"]],
        enqueued <- 0,
        abandonEvents <- 0

(* Safety refinement: every concrete behavior, under the mapping, is a     *)
(* behavior of the intent model (with stuttering).                          *)
Refines == A!Spec

=============================================================================
