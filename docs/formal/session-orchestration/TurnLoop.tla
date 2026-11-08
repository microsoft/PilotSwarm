---------------------------- MODULE TurnLoop ----------------------------
EXTENDS Integers, Sequences, FiniteSets
CONSTANTS InputKinds, QueueCap, InitiallyBlocked, KeepStash, KeepFIFO
MixedTraffic == <<"user", "session", "agent", "answer">>
BootstrapTraffic == <<"kickoff", "user", "session", "answer">>
CapacityTraffic == <<"user", "session", "agent">>
VARIABLES phase, sent, inbox, fifo, held, current, delivered, cancelled,
          refused, tombstones, gateClosed, timer, turnIndex, inFlight,
          epoch, badBatch
vars == <<phase, sent, inbox, fifo, held, current, delivered, cancelled,
          refused, tombstones, gateClosed, timer, turnIndex, inFlight,
          epoch, badBatch>>
N == Len(InputKinds)
Ids == 1..N
Members(s) == {s[i] : i \in DOMAIN s}
People(s) == SelectSeq(s, LAMBDA x : x # 0)
Kind(i) == IF i = 0 THEN "timer" ELSE InputKinds[i]
Bootstrap(i) == Kind(i) = "kickoff"
Count(s, i) == Cardinality({j \in DOMAIN s : s[j] = i})
Remove(s, items) == SelectSeq(s, LAMBDA x : x \notin items)

\* Model boundary: a drain/sweep is normalized into atomic FIFO admission.
\* IDs are unique here; DeliveryIdentity checks retransmission separately.
RECURSIVE Merge(_, _)
Merge(s, boot) ==
    IF s = <<>> THEN <<>>
    ELSE IF Head(s) = 0 THEN Merge(Tail(s), boot)
    ELSE IF Kind(Head(s)) = "answer" \/ Bootstrap(Head(s)) # boot
         THEN <<>>
    ELSE <<Head(s)>> \o Merge(Tail(s), boot)
Pick ==
    LET people == People(fifo)
    IN IF people = <<>> THEN IF fifo = <<>> THEN <<>> ELSE <<0>>
       ELSE IF Kind(Head(people)) = "answer" THEN <<Head(people)>>
       ELSE Merge(fifo, Bootstrap(Head(people)))

Init ==
    /\ phase = "ready"
    /\ sent = 0
    /\ inbox = <<>> /\ fifo = <<>> /\ held = <<>> /\ current = <<>>
    /\ delivered = <<>> /\ cancelled = <<>> /\ refused = <<>>
    /\ tombstones = {}
    /\ gateClosed = InitiallyBlocked
    /\ timer = "not-due"
    /\ turnIndex = 0 /\ inFlight = 0 /\ epoch = 0 /\ badBatch = FALSE

\* New ordinary input can arrive while a model activity is in flight.
\* session and agent messages use the same path as user prompts.
Send ==
    /\ sent < N
    /\ inbox' = Append(inbox, sent + 1) /\ sent' = sent + 1
    /\ UNCHANGED <<phase, fifo, held, current, delivered, cancelled,
          refused, tombstones, gateClosed, timer, turnIndex, inFlight,
          epoch, badBatch>>
Drain ==
    /\ phase = "ready" /\ inbox # <<>>
    /\ LET id == Head(inbox) IN
       /\ inbox' = Tail(inbox)
       /\ fifo' = IF Len(fifo) < QueueCap THEN Append(fifo, id) ELSE fifo
       /\ refused' = IF Len(fifo) < QueueCap THEN refused ELSE Append(refused, id)
    /\ UNCHANGED <<phase, sent, held, current, delivered, cancelled,
          tombstones, gateClosed, timer, turnIndex, inFlight, epoch, badBatch>>
Cancel ==
    /\ \E id \in Members(inbox) \cup Members(People(fifo)) :
         /\ Kind(id) = "user"
         /\ id \notin tombstones
         /\ tombstones' = tombstones \cup {id}
    /\ UNCHANGED <<phase, sent, inbox, fifo, held, current, delivered,
          cancelled, refused, gateClosed, timer, turnIndex, inFlight,
          epoch, badBatch>>
\* Eager removal abstracts a cancellation observed before dispatch.
DropCancelled ==
    /\ phase = "ready" /\ Members(People(fifo)) \cap tombstones # {}
    /\ cancelled' = cancelled \o SelectSeq(fifo, LAMBDA x : x \in tombstones)
    /\ fifo' = Remove(fifo, tombstones)
    /\ UNCHANGED <<phase, sent, inbox, held, current, delivered, refused,
          tombstones, gateClosed, timer, turnIndex, inFlight, epoch, badBatch>>
TimerDue ==
    /\ timer = "not-due" /\ timer' = "due"
    /\ UNCHANGED <<phase, sent, inbox, fifo, held, current, delivered,
          cancelled, refused, tombstones, gateClosed, turnIndex, inFlight,
          epoch, badBatch>>
CaptureTimer ==
    /\ phase = "ready" /\ timer = "due"
    /\ Len(fifo) < QueueCap
    /\ fifo' = Append(fifo, 0) /\ timer' = "queued"
    /\ UNCHANGED <<phase, sent, inbox, held, current, delivered, cancelled,
          refused, tombstones, gateClosed, turnIndex, inFlight, epoch, badBatch>>
Start ==
    /\ phase = "ready"
    /\ Members(People(fifo)) \cap tombstones = {}
    /\ fifo # <<>> \/ (held # <<>> /\ ~gateClosed)
    /\ current' = Pick /\ fifo' = Remove(fifo, Members(Pick))
    /\ badBatch' = (badBatch \/
         (\E a, b \in Members(People(Pick)) : Bootstrap(a) # Bootstrap(b)))
    /\ phase' = "attempt"
    /\ UNCHANGED <<sent, inbox, held, delivered, cancelled, refused,
          tombstones, gateClosed, timer, turnIndex, inFlight, epoch>>
GateRefuses ==
    /\ phase = "attempt" /\ gateClosed
    /\ held' = IF KeepStash THEN held \o People(current) ELSE held
    /\ timer' = IF 0 \in Members(current) THEN "done" ELSE timer
    /\ current' = <<>> /\ phase' = "ready"
    /\ UNCHANGED <<sent, inbox, fifo, delivered, cancelled, refused,
          tombstones, gateClosed, turnIndex, inFlight, epoch, badBatch>>
OpenGate ==
    /\ gateClosed /\ gateClosed' = FALSE
    /\ UNCHANGED <<phase, sent, inbox, fifo, held, current, delivered,
          cancelled, refused, tombstones, timer, turnIndex, inFlight,
          epoch, badBatch>>
Invoke ==
    /\ phase = "attempt" /\ ~gateClosed
    /\ current' = held \o current /\ held' = <<>>
    /\ phase' = "running" /\ inFlight' = inFlight + 1
    /\ UNCHANGED <<sent, inbox, fifo, delivered, cancelled, refused,
          tombstones, gateClosed, timer, turnIndex, epoch, badBatch>>
\* Completed and stopped turns both leave the sequential activity boundary.
Finish ==
    /\ phase = "running"
    /\ delivered' = delivered \o People(current)
    /\ timer' = IF 0 \in Members(current) THEN "done" ELSE timer
    /\ current' = <<>> /\ phase' = "ready"
    /\ inFlight' = inFlight - 1 /\ turnIndex' = turnIndex + 1
    /\ UNCHANGED <<sent, inbox, fifo, held, cancelled, refused, tombstones,
          gateClosed, epoch, badBatch>>
\* CAN/replay preserves committed state. This is a Duroxide boundary assumption.
\* Epoch is a two-value abstraction, not the implementation transcript epoch.
ContinueAsNew ==
    /\ phase = "ready"
    /\ epoch' = 1 - epoch
    /\ fifo' = IF KeepFIFO THEN fifo ELSE <<>>
    /\ UNCHANGED <<phase, sent, inbox, held, current, delivered, cancelled,
          refused, tombstones, gateClosed, timer, turnIndex, inFlight, badBatch>>
Next == Send \/ Drain \/ Cancel \/ DropCancelled \/ TimerDue \/ CaptureTimer
        \/ Start \/ GateRefuses \/ OpenGate \/ Invoke \/ Finish \/ ContinueAsNew
TypeOK ==
    /\ phase \in {"ready", "attempt", "running"} /\ sent \in 0..N
    /\ inbox \in Seq(Ids) /\ fifo \in Seq(Ids \cup {0})
    /\ held \in Seq(Ids) /\ current \in Seq(Ids \cup {0})
    /\ delivered \in Seq(Ids) /\ cancelled \in Seq(Ids) /\ refused \in Seq(Ids)
    /\ tombstones \subseteq Ids /\ gateClosed \in BOOLEAN
    /\ timer \in {"not-due", "due", "queued", "done"}
    /\ turnIndex \in 0..(N + 1) /\ inFlight \in 0..1 /\ epoch \in 0..1
    /\ badBatch \in BOOLEAN
InputAccounting ==
    \A id \in 1..sent :
      Count(inbox,id) + Count(fifo,id) + Count(held,id) + Count(current,id)
      + Count(delivered,id) + Count(cancelled,id) + Count(refused,id) = 1
SerialTurns == inFlight = IF phase = "running" THEN 1 ELSE 0
ArrivalOrder == \A i,j \in DOMAIN delivered : i < j => delivered[i] < delivered[j]
BootstrapBoundary == ~badBatch
CancellationSafety == phase = "running" =>
                        Members(People(current)) \cap tombstones = {}
TimerAccounting == (timer = "queued") <=>
                    (Count(fifo,0) + Count(current,0) = 1)
Settled == sent = N /\ inbox = <<>> /\ fifo = <<>> /\ held = <<>>
           /\ current = <<>> /\ phase = "ready" /\ timer = "done"
Spec == Init /\ [][Next]_vars
        /\ WF_vars(Send) /\ WF_vars(Drain) /\ WF_vars(DropCancelled)
        /\ WF_vars(TimerDue) /\ SF_vars(CaptureTimer)
        /\ WF_vars(Start) /\ WF_vars(GateRefuses) /\ WF_vars(OpenGate)
        /\ WF_vars(Invoke) /\ WF_vars(Finish)
FiniteInputProgress == <>Settled
=============================================================================
