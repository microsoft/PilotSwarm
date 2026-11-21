------------------------------- MODULE MergeRule -------------------------------
(***************************************************************************)
(* decide's prompt batching (queue.ts collectMergeablePrompts):             *)
(* decide pops the first queued prompt and merges the prompts queued after *)
(* it into the same turn, stepping over queued timer and agents-done items *)
(* (they stay queued) and stopping at any other item or at a prompt it     *)
(* must not merge. It stops when exactly one of the two prompts is a      *)
(* person's. Sub-agent and Workflow updates still batch with each other.   *)
(* A cancelled peer is dropped (modelled in CarriedGiveBack), not here.    *)
(* Items: [id |-> n, o |-> "person" | "agent" | "workflow" | "timer"].     *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    N,        \* items that arrive
    Mode,     \* "fu9" (the fix) or "before" (merge any two prompts)
    Unstamped, \* an agent-written prompt may arrive with no sender (send_session_message, message_agent to an
               \* own sub-agent, runtime wakes at c9b23671): isPersonPrompt counts it as a person's
    Forgeable, \* a person's client may try to set an agent or system sender (sendSessionEvent)
    StampAll,  \* 2422c33e: every non-client prompt enqueue stamps its sender (agent or system)
    StripClientSender, \* 2422c33e: client.ts sendEvent drops any sender in the event and sets only opts.sender
    Legacy,     \* prompts queued on 1.0.82 (no sender stamped) may be drained on 1.0.83: "legacyRuntime" (a runtime
                \* prompt with its header: [SYSTEM:, [SESSION_MESSAGE, [WORKFLOW_UPDATE, ...) and "legacyParent" (an
                \* agent's plain message to its sub-agent)
    HeaderRule, \* a senderless prompt that starts with a runtime header: "none" (2422c33e: a person's),
                \* "notPerson" (91def26a, fb467403: not a person's), "barrier" (4ffbf909: unknown, a merge
                \* barrier that merges with nothing in either order)
    QuotedHeader \* a person's senderless text may start with a runtime header (a direct SDK caller)

ASSUME N \in 1..4 /\ Mode \in {"fu9", "before"} /\ Unstamped \in BOOLEAN /\ Forgeable \in BOOLEAN
ASSUME StampAll \in BOOLEAN /\ StripClientSender \in BOOLEAN /\ Legacy \in {"none", "runtime", "both"}
ASSUME HeaderRule \in {"none", "notPerson", "barrier"} /\ QuotedHeader \in BOOLEAN

(* "agentNoSender": written by an agent or the runtime, queued with no sender. *)
(* "forged": a person's words sent with a system sender.                   *)
Origins == {"person", "agent", "workflow", "timer"} \cup (IF Unstamped THEN {"agentNoSender"} ELSE {})
           \cup (IF Forgeable THEN {"forged"} ELSE {})
           \cup (IF Legacy # "none" THEN {"legacyRuntime"} ELSE {})
           \cup (IF Legacy = "both" THEN {"legacyParent"} ELSE {})
           \cup (IF QuotedHeader THEN {"quotedPerson"} ELSE {})

VARIABLES fifo, next, turns, gh
vars == <<fifo, next, turns, gh>>

Init == fifo = <<>> /\ next = 1 /\ turns = <<>> /\ gh = {}

Arrive ==
    /\ next <= N
    /\ \E o \in Origins : fifo' = Append(fifo, [id |-> next, o |-> o])
    /\ next' = next + 1
    /\ UNCHANGED <<turns, gh>>

(* Who wrote it (the property) and what the code sees (isPersonPrompt,     *)
(* queue.ts 1550-1553: no sender counts as a person's).                    *)
IsPerson(x) == x.o \in {"person", "forged", "quotedPerson"}
Headered(x) == x.o \in {"legacyRuntime", "quotedPerson"}
CodeSeesPerson(x) == \/ x.o = "person"
                     \/ (x.o = "agentNoSender" /\ ~StampAll)
                     \/ (x.o = "forged" /\ StripClientSender)
                     \/ (Headered(x) /\ HeaderRule = "none")
                     \/ x.o = "legacyParent"
(* The class the code gives a prompt (promptAuthorClass, queue.ts 1561-1565 *)
(* at 4ffbf909): a stamped sender decides; a senderless prompt with a       *)
(* runtime header (RUNTIME_PROMPT_HEADER 1550) is "unknown"; the merge stops *)
(* at an unknown peek or a class change (1624), so an unknown first merges  *)
(* with nothing either.                                                    *)
Unknown(x) == Headered(x) /\ HeaderRule = "barrier"
Mergeable(first, peek) == \/ Mode = "before"
                          \/ /\ ~Unknown(first) /\ ~Unknown(peek)
                             /\ CodeSeesPerson(first) = CodeSeesPerson(peek)

(* The index of the first prompt in the FIFO (timers wait behind prompts:  *)
(* people before timers), or 0.                                            *)
FirstPrompt == IF \E i \in 1..Len(fifo) : fifo[i].o # "timer"
               THEN CHOOSE i \in 1..Len(fifo) : fifo[i].o # "timer" /\ \A j \in 1..(i - 1) : fifo[j].o = "timer"
               ELSE 0

(* Indices after k that the scan takes: prompts until the first prompt it  *)
(* must not merge; timers are stepped over.                                *)
RECURSIVE Scan(_, _, _)
Scan(first, k, acc) ==
    IF k > Len(fifo) THEN acc
    ELSE IF fifo[k].o = "timer" THEN Scan(first, k + 1, acc)
    ELSE IF Mergeable(first, fifo[k]) THEN Scan(first, k + 1, acc \cup {k})
    ELSE acc

Decide ==
    /\ FirstPrompt > 0
    /\ LET f == FirstPrompt
           first == fifo[f]
           taken == {f} \cup Scan(first, f + 1, {})
           turn == [i \in 1..Cardinality(taken) |-> fifo[CHOOSE k \in taken : Cardinality({j \in taken : j < k}) = i - 1]]
       IN /\ turns' = Append(turns, turn)
          /\ fifo' = SelectSeq([i \in 1..Len(fifo) |-> IF i \in taken THEN [id |-> 0, o |-> "gone"] ELSE fifo[i]],
                               LAMBDA x : x.o # "gone")
          /\ gh' = gh \cup (IF Cardinality(taken) > 1 /\ ~CodeSeesPerson(first) THEN {"batched"} ELSE {})
    /\ UNCHANGED next

TimerRuns ==
    /\ fifo # <<>> /\ FirstPrompt = 0
    /\ turns' = Append(turns, <<fifo[1]>>) /\ fifo' = Tail(fifo)
    /\ UNCHANGED <<next, gh>>

Done == next > N /\ fifo = <<>> /\ UNCHANGED vars
Next == Arrive \/ Decide \/ TimerRuns \/ Done
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Decide) /\ WF_vars(TimerRuns) /\ WF_vars(Arrive)

-----------------------------------------------------------------------------
Delivered == UNION {{turns[t][i].id : i \in DOMAIN turns[t]} : t \in 1..Len(turns)}
Count(n) == Cardinality({<<t, i>> \in (1..Len(turns)) \X (1..N) : i \in DOMAIN turns[t] /\ turns[t][i].id = n})
Queued == {fifo[i].id : i \in DOMAIN fifo}
TypeOK == next \in 1..(N + 1) /\ Len(fifo) <= N /\ Len(turns) <= N
(* A person's prompt never shares a turn with a non-person prompt.         *)
Inv_NoMixedPersonMerge ==
    \A t \in 1..Len(turns) : \A i, j \in DOMAIN turns[t] :
        (turns[t][i].o # "timer" /\ turns[t][j].o # "timer") => IsPerson(turns[t][i]) = IsPerson(turns[t][j])
(* Every arrived item is queued or delivered, exactly once.                *)
Inv_NoLossNoDup == /\ \A n \in 1..(next - 1) : (n \in Queued) # (n \in Delivered)
                   /\ \A n \in Delivered : Count(n) = 1
(* Prompts reach the model in arrival order.                               *)
PromptSeq == [t \in 1..Len(turns) |-> SelectSeq(turns[t], LAMBDA x : x.o # "timer")]
Inv_PromptOrder ==
    \A t1, t2 \in 1..Len(turns) : \A i \in DOMAIN PromptSeq[t1], j \in DOMAIN PromptSeq[t2] :
        (t1 < t2 \/ (t1 = t2 /\ i < j)) => PromptSeq[t1][i].id < PromptSeq[t2][j].id
Prop_AllDelivered == <>[](next > N => \A n \in 1..N : n \in Delivered)

W_NoBatch == "batched" \notin gh
(* A senderless headered prompt runs alone.                                 *)
W_NoUnknownTurn == ~\E t \in 1..Len(turns) : Len(turns[t]) = 1 /\ Headered(turns[t][1])
=============================================================================
