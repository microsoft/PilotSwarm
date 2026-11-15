------------------------ MODULE DeliveryIdentity ------------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS Traffic, Window, HasClientIds
WithinWindow == <<"a", "a", "b", "b">>
RecencyRefresh == <<"a", "b", "a", "c", "a">>
EvictedRetry == <<"a", "b", "c", "a">>
ProductionEviction == <<0>> \o [i \in 1..20 |-> i] \o <<0>>
SessionRetry == <<"request-a", "request-a">>
VARIABLES next, recent, outcome, admissions
vars == <<next, recent, outcome, admissions>>
Ids == {Traffic[i] : i \in DOMAIN Traffic}
Members(s) == {s[i] : i \in DOMAIN s}
\* Move id to the newest end of the list. Keep only the newest Window ids.
Touch(s, id) ==
    LET t == Append(SelectSeq(s, LAMBDA x : x # id), id)
    IN IF Len(t) > Window THEN Tail(t) ELSE t
\* Other ids received strictly between envelopes i and j.
Between(i, j) == {Traffic[k] : k \in (i + 1)..(j - 1)} \ {Traffic[i]}

Init ==
    /\ next = 1 /\ recent = <<>> /\ outcome = <<>>
    /\ admissions = [id \in Ids |-> 0]

\* Admission into the session queue only. It is not a model call.
\* The logical id is ghost state when HasClientIds is FALSE.
Receive ==
    /\ next <= Len(Traffic)
    /\ LET id == Traffic[next]
           duplicate == HasClientIds /\ id \in Members(recent)
       IN /\ outcome' = Append(outcome,
                               IF duplicate THEN "suppressed" ELSE "admitted")
          /\ recent' = IF HasClientIds THEN Touch(recent, id) ELSE recent
          /\ admissions' = IF duplicate THEN admissions
                           ELSE [admissions EXCEPT ![id] = @ + 1]
    /\ next' = next + 1

Next == Receive

TypeOK ==
    /\ next \in 1..(Len(Traffic) + 1)
    /\ recent \in Seq(Ids) /\ Len(recent) <= Window
    /\ outcome \in Seq({"admitted", "suppressed"})
    /\ admissions \in [Ids -> 0..Len(Traffic)]

\* Every received envelope has one outcome, and the counts agree.
ReceiptAccounting ==
    /\ Len(outcome) = next - 1
    /\ \A id \in Ids :
         admissions[id] =
           Cardinality({k \in 1..Len(outcome) :
                          Traffic[k] = id /\ outcome[k] = "admitted"})

\* The code's promise: a resend is suppressed while fewer than Window
\* other ids arrived after an earlier copy.
WindowDeduplication ==
    HasClientIds =>
      \A i, j \in 1..Len(outcome) :
        (i < j /\ Traffic[i] = Traffic[j] /\ Cardinality(Between(i, j)) < Window)
          => outcome[j] = "suppressed"

\* A stronger rule that the code does not promise.
AtMostOnce == \A id \in Ids : admissions[id] <= 1

Spec == Init /\ [][Next]_vars /\ WF_vars(Receive)
AllEnvelopesClassified == <>(next = Len(Traffic) + 1)
=============================================================================
