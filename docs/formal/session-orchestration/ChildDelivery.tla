--------------------------- MODULE ChildDelivery ---------------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS Updates, Policy, ProtectRank, PreserveFirst, AttachToPrompt,
          RestoreQueuedDigest
FirstFinal == <<"final">>
FinalThenProgress == <<"final", "progress">>
VARIABLES next, wire, pending, payload, promptStage, sent, observed,
          suppressed, superseded, firstReported, forced, rankFloor
vars == <<next, wire, pending, payload, promptStage, sent, observed,
          suppressed, superseded, firstReported, forced, rankFloor>>
N == Len(Updates)
Ids == 1..N
Members(s) == {s[i] : i \in DOMAIN s}
Rank(i) == IF Updates[i] \in {"final", "terminal", "error"} THEN 2 ELSE 1
Allowed(i) ==
    Policy = "any" \/ Updates[i] \in {"terminal", "error"} \/
      (Policy = "material_change" /\ Updates[i] # "heartbeat")
Init ==
    /\ next = 1 /\ wire = <<>> /\ pending = 0 /\ payload = 0
    /\ promptStage = "none"
    /\ sent = {} /\ observed = {} /\ suppressed = {} /\ superseded = {}
    /\ firstReported = FALSE /\ forced = {} /\ rankFloor = 0
\* One tracked child. "final" is ordinary completed prose, not terminal.
ChildCompletes ==
    /\ next <= N
    /\ LET first == Updates[next] = "final" /\ ~firstReported
           notify == Allowed(next) \/ first
       IN /\ wire' = IF notify THEN Append(wire,next) ELSE wire
          /\ sent' = IF notify THEN sent \cup {next} ELSE sent
          /\ suppressed' = IF notify THEN suppressed ELSE suppressed \cup {next}
          /\ forced' = IF first THEN forced \cup {next} ELSE forced
          /\ firstReported' = (firstReported \/ (notify /\ Updates[next] = "final"))
    /\ next' = next + 1
    /\ UNCHANGED <<pending, payload, promptStage, observed, superseded, rankFloor>>
Receive ==
    /\ wire # <<>>
    /\ LET id == Head(wire)
           replace == pending = 0 \/ ~ProtectRank \/ Rank(id) >= Rank(pending)
       IN /\ pending' = IF replace THEN id ELSE pending
          /\ superseded' = superseded \cup
               (IF pending = 0 THEN {} ELSE IF replace THEN {pending} ELSE {id})
          /\ rankFloor' = IF pending = 0 THEN Rank(id)
                          ELSE IF Rank(id) > rankFloor THEN Rank(id) ELSE rankFloor
    /\ wire' = Tail(wire)
    /\ UNCHANGED <<next, payload, promptStage, sent, observed,
          suppressed, firstReported, forced>>
\* The batch wait is abstracted as a fair dispatch when no wire item remains.
DispatchDigest ==
    /\ pending # 0 /\ wire = <<>> /\ ~AttachToPrompt
    /\ LET wake == Allowed(pending) \/ (PreserveFirst /\ pending \in forced)
       IN /\ observed' = IF wake THEN observed \cup {pending} ELSE observed
          /\ suppressed' = IF wake THEN suppressed ELSE suppressed \cup {pending}
    /\ pending' = 0 /\ rankFloor' = 0
    /\ UNCHANGED <<next, wire, payload, promptStage, sent, superseded,
          firstReported, forced>>
\* Actual code folds a digest into prompt text and clears pendingChildDigest.
Attach ==
    /\ AttachToPrompt /\ pending # 0 /\ promptStage = "none"
    /\ payload' = pending /\ pending' = 0 /\ rankFloor' = 0
    /\ promptStage' = "stash"
    /\ UNCHANGED <<next, wire, sent, observed, suppressed, superseded,
          firstReported, forced>>
StorePrompt ==
    /\ promptStage = "stash" /\ promptStage' = "fifo"
    /\ UNCHANGED <<next, wire, pending, payload, sent, observed, suppressed,
          superseded, firstReported, forced, rankFloor>>
CancelInSamePass ==
    /\ promptStage = "stash" /\ pending = 0
    /\ pending' = payload /\ rankFloor' = Rank(payload)
    /\ payload' = 0 /\ promptStage' = "closed"
    /\ UNCHANGED <<next, wire, sent, observed, suppressed, superseded,
          firstReported, forced>>
CancelInLaterPass ==
    /\ promptStage = "fifo" /\ pending = 0
    /\ pending' = IF RestoreQueuedDigest THEN payload ELSE 0
    /\ rankFloor' = IF RestoreQueuedDigest THEN Rank(payload) ELSE 0
    /\ payload' = 0 /\ promptStage' = "closed"
    /\ UNCHANGED <<next, wire, sent, observed, suppressed, superseded,
          firstReported, forced>>
ConsumePrompt ==
    /\ promptStage = "fifo"
    /\ observed' = observed \cup {payload}
    /\ payload' = 0 /\ promptStage' = "closed"
    /\ UNCHANGED <<next, wire, pending, sent, suppressed, superseded,
          firstReported, forced, rankFloor>>
Next == ChildCompletes \/ Receive \/ DispatchDigest \/ Attach \/ StorePrompt
        \/ CancelInSamePass \/ CancelInLaterPass \/ ConsumePrompt
TypeOK ==
    /\ next \in 1..(N+1) /\ wire \in Seq(Ids)
    /\ pending \in 0..N /\ payload \in 0..N
    /\ promptStage \in {"none", "stash", "fifo", "closed"}
    /\ sent \subseteq Ids /\ observed \subseteq Ids
    /\ suppressed \subseteq Ids /\ superseded \subseteq Ids
    /\ forced \subseteq Ids /\ firstReported \in BOOLEAN /\ rankFloor \in 0..2
LifecycleRankPreserved == pending = 0 \/ Rank(pending) >= rankFloor
DigestAccounted ==
    sent \subseteq Members(wire) \cup ({pending,payload} \ {0})
                    \cup observed \cup suppressed \cup superseded
Spec == Init /\ [][Next]_vars /\ WF_vars(ChildCompletes)
        /\ WF_vars(Receive) /\ WF_vars(DispatchDigest)
FirstReportObserved == <>(1 \in observed)
=============================================================================
