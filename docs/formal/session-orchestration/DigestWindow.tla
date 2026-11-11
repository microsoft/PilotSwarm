------------------------------ MODULE DigestWindow ------------------------------
(***************************************************************************)
(* The child-update batch window and the give-back (orchestration/ at      *)
(* 5d8eaa46, latest 1.0.83). A child update opens the pending digest with  *)
(* startedAtMs (bufferChildUpdate); the digest's own turn is due at        *)
(* startedAtMs + childUpdateBatchMs (nextTimerCandidate, queue.ts 577-596; *)
(* the drain race sets ready at the deadline, 943-975); a prompt the drain *)
(* queues takes the pending digest into its text earlier (1309-1315), and *)
(* a turn-running timer takes it too (turn.ts). A given-back digest is     *)
(* merged with startedAtMs = min of both (restorePendingChildDigest,       *)
(* lifecycle.ts), skipping an entry a later queued prompt carries newer.   *)
(* One child; entries 1..U arrive in order (a newer one supersedes); time *)
(* is in ticks, the window B ticks. Tick cannot pass a due digest (its     *)
(* timer fires on time; a queued prompt runs first, at once).              *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS U, B, T, MaxPrompts, Fault   \* Fault: "none", "fresh-window" (a give-back restarts the window)

ASSUME U \in 1..3 /\ B \in 1..3 /\ T \in 1..8 /\ MaxPrompts \in 1..3 /\ Fault \in {"none", "fresh-window"}

VARIABLES now, arr, nextU, pd, start, fifo, prompts, delivered, gh
vars == <<now, arr, nextU, pd, start, fifo, prompts, delivered, gh>>

Init == now = 0 /\ arr = [u \in 1..U |-> 0] /\ nextU = 1 /\ pd = 0 /\ start = 0 /\ fifo = <<>>
        /\ prompts = 0 /\ delivered = <<>> /\ gh = {}

Due == pd # 0 /\ (now >= start + B \/ now = T)   \* at the horizon T the timer fires too

Tick == now < T /\ ~Due /\ now' = now + 1 /\ UNCHANGED <<arr, nextU, pd, start, fifo, prompts, delivered, gh>>

Update ==
    /\ nextU <= U
    /\ arr' = [arr EXCEPT ![nextU] = now]
    /\ start' = IF pd = 0 THEN now ELSE start
    /\ pd' = nextU /\ nextU' = nextU + 1
    /\ UNCHANGED <<now, fifo, prompts, delivered, gh>>

(* The drain queues a prompt; it takes the pending digest into its text.   *)
Prompt ==
    /\ prompts < MaxPrompts /\ Len(fifo) < 2
    /\ fifo' = Append(fifo, [e |-> pd, s |-> start])
    /\ pd' = 0 /\ prompts' = prompts + 1
    /\ UNCHANGED <<now, arr, nextU, start, delivered, gh>>

Deliver(e) == delivered' = IF e = 0 THEN delivered ELSE Append(delivered, e)

(* A queued prompt runs.                                                   *)
Dispatch == fifo # <<>> /\ Deliver(Head(fifo).e) /\ fifo' = Tail(fifo)
            /\ UNCHANGED <<now, arr, nextU, pd, start, prompts, gh>>

(* A cancel drops the head prompt; its digest is given back unless a later *)
(* queued prompt carries a newer entry; the window keeps the older start.  *)
Cancel ==
    /\ fifo # <<>>
    /\ LET it == Head(fifo)
           later == \E i \in 2..Len(fifo) : fifo[i].e > it.e
           give == it.e # 0 /\ ~later
       IN /\ fifo' = Tail(fifo)
          /\ IF ~give THEN UNCHANGED <<pd, start, gh>>
             ELSE /\ pd' = IF pd = 0 \/ it.e > pd THEN it.e ELSE pd
                  /\ start' = IF Fault = "fresh-window" THEN now
                              ELSE IF pd = 0 THEN it.s ELSE (IF it.s < start THEN it.s ELSE start)
                  /\ gh' = gh \cup {"gaveBack"} \cup (IF it.s + B <= now THEN {"dueAtOnce"} ELSE {})
    /\ UNCHANGED <<now, arr, nextU, prompts, delivered>>

(* The digest's own turn, at its window's end, and only once the FIFO is  *)
(* drained (decide priority 4, queue.ts 1794-1800: after FIFO work).       *)
DigestTurn == Due /\ fifo = <<>> /\ Deliver(pd) /\ pd' = 0
              /\ gh' = gh \cup (IF "gaveBack" \in gh THEN {"windowTurn"} ELSE {})
              /\ UNCHANGED <<now, arr, nextU, start, fifo, prompts>>

Done == nextU > U /\ pd = 0 /\ fifo = <<>> /\ UNCHANGED vars
Next == Tick \/ Update \/ Prompt \/ Dispatch \/ Cancel \/ DigestTurn \/ Done
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Tick) /\ WF_vars(DigestTurn) /\ WF_vars(Dispatch)

-----------------------------------------------------------------------------
TypeOK == now \in 0..T /\ pd \in 0..U /\ start \in 0..T /\ Len(fifo) <= 2 /\ Len(delivered) <= U + MaxPrompts
(* Each entry reaches the model at most once, and never after a newer one. *)
Inv_OnceInOrder == \A i, j \in DOMAIN delivered : i < j => delivered[i] < delivered[j]
(* A give-back never extends the window: the pending digest's start is no  *)
(* later than its entry's arrival, so it is due no later than arrival + B  *)
(* (at once if that passed).                                               *)
Inv_WindowNotExtended == pd # 0 => start <= arr[pd]
Prop_PendingDelivered == (pd # 0) ~> (pd = 0)

W_NoWindowTurn == "windowTurn" \notin gh
W_NoDueAtOnce == "dueAtOnce" \notin gh
=============================================================================
