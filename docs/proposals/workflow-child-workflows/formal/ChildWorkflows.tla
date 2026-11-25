--------------------------- MODULE ChildWorkflows ---------------------------
EXTENDS Naturals, FiniteSets, Sequences

Visits == 1..2
Children == 1..2
Status == {"absent", "claimed", "running", "ended", "cancelled"}
PC == {"dispatch", "claim", "rows", "start", "result", "wake", "done", "refused"}
ParentMode == {"ready", "spawn", "busy", "receive", "received", "ended", "cleaned"}

VARIABLES p, v, c, inbox, receipts, waiting, hint, endedOrder, agentSteps
vars == <<p, v, c, inbox, receipts, waiting, hint, endedOrder, agentSteps>>
Visit == [pc : PC, attempts : 0..2, cut : {"none"} \cup PC, down : BOOLEAN,
          result : 0..2]
Child == [key : 0..2, level : 0..3, status : Status, controller : BOOLEAN]
TypeOK ==
    /\ p \in ParentMode /\ v \in [Visits -> Visit] /\ c \in [Children -> Child]
    /\ inbox \in UNION {[1..n -> Children] : n \in 0..2}
    /\ receipts \in UNION {[1..n -> Children] : n \in 0..2}
    /\ endedOrder \in UNION {[1..n -> Visits] : n \in 0..2}
    /\ waiting \in 0..2 /\ hint \in {"none", "queued", "lost", "wake", "timer"}
    /\ agentSteps \in [Children -> 0..3]

Init ==
    /\ p = "ready"
    /\ v = [i \in Visits |-> [pc |-> "done", attempts |-> 0, cut |-> "none",
                              down |-> FALSE, result |-> 0]]
    /\ c = [j \in Children |-> [key |-> 0, level |-> 0, status |-> "absent",
                                controller |-> FALSE]]
    /\ inbox = <<>> /\ receipts = <<>> /\ endedOrder = <<>>
    /\ waiting = 0 /\ hint = "none"
    /\ agentSteps = [j \in Children |-> 0]

Live == p \notin {"ended", "cleaned"}
Keys(i) == {j \in Children : c[j].key = i}
RangeOf(s) == {s[k] : k \in DOMAIN s}
Count(s, x) == Cardinality({k \in DOMAIN s : s[k] = x})
Pending == {k \in DOMAIN inbox : inbox[k] \notin RangeOf(receipts)}
FirstPending == CHOOSE k \in Pending : \A n \in Pending : k <= n
Running == {j \in Children : c[j].status = "running"}
CanCreateAt(level) == level <= 2
Ready(i, phase) == v[i].attempts > 0 /\ ~v[i].down /\ v[i].pc = phase

\* Spawn visit admitted; starting the effect helper is a different commit.
AdmitSpawn(i) ==
    /\ p = "ready" /\ v[i].attempts = 0
    /\ (i = 1 \/ v[1].result # 0)
    /\ p' = "spawn" /\ waiting' = i /\ hint' = "none"
    /\ v' = [v EXCEPT ![i].pc = "dispatch"]
    /\ UNCHANGED <<c, inbox, receipts, endedOrder, agentSteps>>

DispatchSpawn(i) ==
    /\ p = "spawn" /\ waiting = i /\ v[i].pc = "dispatch"
    /\ v' = [v EXCEPT ![i].pc = "claim", ![i].attempts = 1]
    /\ UNCHANGED <<p, c, inbox, receipts, waiting, hint, endedOrder, agentSteps>>

\* CMS session claim is independent of the subsequent run admission.
ClaimSession(i, j) ==
    /\ Ready(i, "claim")
    /\ IF Keys(i) # {} THEN
          /\ j \in Keys(i) /\ UNCHANGED c
       ELSE
          /\ Live /\ c[j].status = "absent" /\ CanCreateAt(1 + 1)
          /\ c' = [c EXCEPT ![j].key = i, ![j].level = 1 + 1, ![j].status = "claimed"]
    /\ v' = [v EXCEPT ![i].pc = "rows"]
    /\ UNCHANGED <<p, inbox, receipts, waiting, hint, endedOrder, agentSteps>>

\* Lookup by key returns an existing receipt before locking or checking the parent.
ReplayChildRows(i, j) ==
    /\ Ready(i, "rows") /\ j \in Keys(i) /\ c[j].status # "claimed"
    /\ v' = [v EXCEPT ![i].pc = "start"]
    /\ UNCHANGED <<p, c, inbox, receipts, waiting, hint, endedOrder, agentSteps>>

\* Lock the parent run; check active and commit definition, run and receipt together.
\* ParentEnd updates the same run row and must serialize with this transaction.
WriteChildRows(i, j) ==
    /\ Ready(i, "rows") /\ j \in Keys(i) /\ c[j].status = "claimed" /\ Live
    /\ c' = [c EXCEPT ![j].status = "running"]
    /\ v' = [v EXCEPT ![i].pc = "start"]
    /\ UNCHANGED <<p, inbox, receipts, waiting, hint, endedOrder, agentSteps>>

RefuseSpawn(i, j) ==
    /\ Ready(i, "rows") /\ j \in Keys(i) /\ c[j].status = "claimed" /\ ~Live
    /\ v' = [v EXCEPT ![i].pc = "refused"]
    /\ UNCHANGED <<p, c, inbox, receipts, waiting, hint, endedOrder, agentSteps>>

\* Duroxide START by durable controller instance id. A terminal run stays terminal.
StartChildController(i, j) ==
    /\ Ready(i, "start") /\ j \in Keys(i)
    /\ c' = IF j \in Running THEN [c EXCEPT ![j].controller = TRUE] ELSE c
    /\ v' = [v EXCEPT ![i].pc = "result"]
    /\ UNCHANGED <<p, inbox, receipts, waiting, hint, endedOrder, agentSteps>>

StoreSpawnResult(i, j) ==
    /\ Ready(i, "result") /\ j \in Keys(i)
    /\ v' = [v EXCEPT ![i].pc = "wake",
                      ![i].result = IF Live /\ @ = 0 THEN j ELSE @]
    /\ UNCHANGED <<p, c, inbox, receipts, waiting, hint, endedOrder, agentSteps>>

WakeSpawn(i) ==
    /\ Ready(i, "wake")
    /\ v' = [v EXCEPT ![i].pc = "done"]
    /\ hint' = IF p = "spawn" /\ waiting = i /\ hint = "none" THEN "queued" ELSE hint
    /\ UNCHANGED <<p, c, inbox, receipts, waiting, endedOrder, agentSteps>>

\* At-least-once delivery: the response to START can be lost before acknowledgement.
DuplicateSpawn(i) ==
    /\ Ready(i, "result") /\ v[i].attempts = 1
    /\ v' = [v EXCEPT ![i].pc = "claim", ![i].attempts = 2]
    /\ UNCHANGED <<p, c, inbox, receipts, waiting, hint, endedOrder, agentSteps>>

\* One stop per visit, independently selectable at each boundary; durable writes survive.
WorkerStop(i) ==
    /\ v[i].attempts > 0 /\ v[i].cut = "none"
    /\ v' = [v EXCEPT ![i].down = TRUE, ![i].cut = v[i].pc]
    /\ UNCHANGED <<p, c, inbox, receipts, waiting, hint, endedOrder, agentSteps>>

WorkerRestart(i) ==
    /\ v[i].down
    /\ v' = [v EXCEPT ![i].down = FALSE,
             ![i].pc = IF v[i].pc \in {"rows", "start", "result"} THEN "claim" ELSE @,
             ![i].attempts = IF v[i].pc \in {"rows", "start", "result"} THEN 2 ELSE @]
    /\ UNCHANGED <<p, c, inbox, receipts, waiting, hint, endedOrder, agentSteps>>

\* ENQUEUE and waking the receiver are separate; a missing hint loses no DB row.
WakeParent ==
    /\ Live /\ hint = "queued"
    /\ hint' \in {"wake", "lost"}
    /\ UNCHANGED <<p, v, c, inbox, receipts, waiting, endedOrder, agentSteps>>

Timer ==
    /\ p \in {"spawn", "receive", "received"} /\ hint \in {"none", "lost", "queued"}
    /\ hint' = "timer"
    /\ UNCHANGED <<p, v, c, inbox, receipts, waiting, endedOrder, agentSteps>>

CollectSpawn ==
    /\ p = "spawn" /\ waiting \in Visits /\ v[waiting].result # 0
    /\ hint \in {"wake", "timer"}
    /\ p' = IF waiting = 1 THEN "ready" ELSE "busy"
    /\ waiting' = 0 /\ hint' = "none"
    /\ UNCHANGED <<v, c, inbox, receipts, endedOrder, agentSteps>>

ChildEnd(j) ==
    /\ j \in Running /\ c[j].controller
    /\ c' = [c EXCEPT ![j].status = "ended"]
    /\ endedOrder' = Append(endedOrder, c[j].key)
    /\ UNCHANGED <<p, v, inbox, receipts, waiting, hint, agentSteps>>

\* Fixed ended:<child run id> key; inbox insertion and optional claim share a tx.
\* A second delivery runs the same action and is a durable no-op.
WriteEnded(j) ==
    /\ Live /\ c[j].status = "ended"
    /\ LET fresh == j \notin RangeOf(inbox)
           claim == fresh /\ p = "receive"
       IN /\ inbox' = IF fresh THEN Append(inbox, j) ELSE inbox
          /\ receipts' = IF claim THEN Append(receipts, j) ELSE receipts
          /\ p' = IF claim THEN "received" ELSE p
    /\ UNCHANGED <<v, c, waiting, hint, endedOrder, agentSteps>>

EnqueueEndedWake ==
    /\ p = "received" /\ hint = "none"
    /\ hint' = "queued"
    /\ UNCHANGED <<p, v, c, inbox, receipts, waiting, endedOrder, agentSteps>>

\* Receive entry transaction claims the oldest available notice or becomes pending.
ParentReceive ==
    /\ p = "busy" /\ Len(receipts) < 2
    /\ IF Pending = {} THEN
           /\ p' = "receive" /\ UNCHANGED receipts
       ELSE
           /\ receipts' = Append(receipts, inbox[FirstPending]) /\ p' = "received"
    /\ hint' = "none"
    /\ UNCHANGED <<v, c, inbox, waiting, endedOrder, agentSteps>>

CollectReceive ==
    /\ p = "received" /\ hint \in {"timer", "wake"}
    /\ p' = "busy" /\ hint' = "none"
    /\ UNCHANGED <<v, c, inbox, receipts, waiting, endedOrder, agentSteps>>

ParentEnd ==
    /\ Live /\ p' = "ended"
    /\ UNCHANGED <<v, c, inbox, receipts, waiting, hint, endedOrder, agentSteps>>

\* One child's cancellation transaction. "Running" means the DB run is active.
CleanupChild(j) ==
    /\ p = "ended" /\ j \in Running
    /\ c' = [c EXCEPT ![j].status = "cancelled"]
    /\ UNCHANGED <<p, v, inbox, receipts, waiting, hint, endedOrder, agentSteps>>

FinishCleanup ==
    /\ p = "ended" /\ Running = {}
    /\ p' = "cleaned"
    /\ UNCHANGED <<v, c, inbox, receipts, waiting, hint, endedOrder, agentSteps>>

\* Level-2 workflows admit same-level agent steps but refuse deeper sessions.
CreateDescendant(j, offset) ==
    /\ j \in Running /\ c[j].controller /\ agentSteps[j] = 0
    /\ CanCreateAt(c[j].level + offset)
    /\ agentSteps' = [agentSteps EXCEPT ![j] = c[j].level + offset]
    /\ UNCHANGED <<p, v, c, inbox, receipts, waiting, hint, endedOrder>>

Quiesce == p = "cleaned" /\ Running = {} /\ UNCHANGED vars
Next ==
    \/ ParentEnd \/ FinishCleanup \/ Quiesce
    \/ Timer \/ WakeParent \/ CollectSpawn
    \/ ParentReceive \/ EnqueueEndedWake \/ CollectReceive
    \/ \E i \in Visits :
           AdmitSpawn(i) \/ DispatchSpawn(i) \/ DuplicateSpawn(i) \/ WorkerStop(i) \/
           WorkerRestart(i) \/ WakeSpawn(i)
    \/ \E i \in Visits, j \in Children :
           ClaimSession(i, j) \/ WriteChildRows(i, j) \/ ReplayChildRows(i, j) \/
           RefuseSpawn(i, j) \/ StartChildController(i, j) \/ StoreSpawnResult(i, j)
    \/ \E j \in Children : ChildEnd(j) \/ WriteEnded(j) \/ CleanupChild(j)
    \/ \E j \in Children, offset \in {0, 1} : CreateDescendant(j, offset)

OneChildPerVisit == \A i \in Visits : Cardinality(Keys(i)) <= 1
OneEndedPerChild == \A j \in Children : Count(inbox, j) <= 1
ReceiveAtMostOnce ==
    /\ RangeOf(receipts) \subseteq RangeOf(inbox)
    /\ \A j \in Children : Count(receipts, j) <= 1
    /\ \A k \in DOMAIN receipts : receipts[k] = inbox[k]
NoRunningAfterCleanup == p = "cleaned" => Running = {}
NoLevelAboveTwo ==
    \A j \in Children : c[j].level <= 2 /\ agentSteps[j] <= 2
NoStrandedWaiter ==
    /\ p = "receive" => Pending = {}
    /\ (p = "received" \/ (p = "spawn" /\ waiting \in Visits /\ v[waiting].result # 0))
       => (hint \in {"timer", "wake"} \/ ENABLED Timer)
StableEffects ==
    /\ \A i \in Visits : v[i].result # 0 => v[i].result \in Keys(i)
    /\ \A j \in RangeOf(inbox) : c[j].status = "ended"
    /\ \A i \in Visits : v[i].pc = "refused" =>
           /\ ~Live /\ v[i].result = 0
           /\ \A j \in Keys(i) : c[j].status = "claimed" /\ ~c[j].controller

CanaryDuplicate == ~(\E i \in Visits :
    v[i].attempts = 2 /\ v[i].cut = "none" /\ v[i].result # 0)
CanaryStop == ~(\E i \in Visits :
    v[i].cut = "start" /\ ~v[i].down /\ v[i].result # 0)
CanaryOutOfOrder == ~(endedOrder = <<2, 1>> /\ Len(receipts) = 2 /\
                      c[receipts[1]].key = 2 /\ c[receipts[2]].key = 1)
CanaryRefused == ~(\E i \in Visits : v[i].pc = "refused")
=============================================================================
