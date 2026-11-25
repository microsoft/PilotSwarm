---------------------------- MODULE SimplerLoops ----------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANT SplitCommit
VARIABLES inbox, claims, result, now, deadline, retried, observed

vars == <<inbox, claims, result, now, deadline, retried, observed>>
db == <<inbox, claims, result, deadline>>

Messages == {"p1", "p2", "e", "q"}
Contract == [m \in Messages |-> CASE m = "q" -> "Q"
                                 [] m = "e" -> "E"
                                 [] OTHER -> "P"]
Match == [s \in {"L", "O"} |-> IF s = "L" THEN {"P", "E"} ELSE {"Q"}]
MaxVisits == [s \in {"L", "O"} |-> IF s = "L" THEN 2 ELSE 1]
L1 == <<"L", 1>>
L2 == <<"L", 2>>
L3 == <<"L", 3>>
O1 == <<"O", 1>>
Visits == {L1, L2, L3, O1}
Names == {"P", "E", "Q"}
Indices == 1..Cardinality(Messages)

Receipt(outcome, via) == [outcome |-> outcome, via |-> via]
New == Receipt("new", "none")
Pending == Receipt("pending", "none")
Entered(v) == result[v] # New
Waiting == {v \in Visits : result[v] = Pending}
Accepted == {inbox[i] : i \in DOMAIN inbox}
Used(i) == \E v \in Visits : <<v, i>> \in claims
Taken(v) == {i \in Indices : <<v, i>> \in claims}
Eligible(v) == {i \in DOMAIN inbox : ~Used(i) /\ Contract[inbox[i]] \in Match[v[1]]}
DeadlineReached(v) == v[1] = "L" /\ deadline # 0 /\ now >= deadline
Recipients(m) == {v \in Waiting : ~DeadlineReached(v) /\ Contract[m] \in Match[v[1]]}

Init ==
    /\ inbox = <<>>
    /\ claims = {}
    /\ result = [v \in Visits |-> New]
    /\ now = 0
    /\ deadline = 0
    /\ retried = [entry |-> FALSE, accept |-> FALSE]
    /\ observed = [lateArrival |-> FALSE, spentEntry |-> FALSE]

Enter(v) ==
    /\ Waiting = {}
    /\ ~Entered(v)
    /\ \A i \in 1..(v[2] - 1) : Entered(<<v[1], i>>)
    /\ deadline' = IF v = L1 THEN now + 1 ELSE deadline
    /\ IF v[2] > MaxVisits[v[1]]
          THEN /\ result' = [result EXCEPT ![v] = Receipt("exhausted", "entry")]
               /\ UNCHANGED claims
          ELSE IF DeadlineReached(v)
               THEN /\ result' = [result EXCEPT ![v] = Receipt("elapsed", "entry")]
                    /\ UNCHANGED claims
               ELSE LET choices == Eligible(v) IN
                    IF choices = {}
                    THEN /\ result' = [result EXCEPT ![v] = Pending]
                         /\ UNCHANGED claims
                    ELSE LET i == CHOOSE k \in choices : \A j \in choices : k <= j IN
                         /\ claims' = claims \cup {<<v, i>>}
                         /\ result' = [result EXCEPT ![v] = Receipt(Contract[inbox[i]], "entry")]
    /\ observed' = [observed EXCEPT !.spentEntry =
           @ \/ (v = L2 /\ DeadlineReached(v) /\ Eligible(v) # {}
                        /\ result'[v] = Receipt("elapsed", "entry") /\ claims' = claims)]
    /\ UNCHANGED <<inbox, now, retried>>

Accept(m) ==
    /\ m \notin Accepted
    /\ inbox' = Append(inbox, m)
    /\ LET recipients == Recipients(m) IN
       IF recipients = {}
       THEN UNCHANGED <<claims, result>>
       ELSE LET v == CHOOSE w \in recipients : TRUE IN
            /\ claims' = claims \cup {<<v, Len(inbox')>>}
            /\ result' = [result EXCEPT ![v] = Receipt(Contract[m], "arrival")]
    /\ observed' = [observed EXCEPT !.lateArrival =
           @ \/ (L1 \in Waiting /\ DeadlineReached(L1) /\ Contract[m] \in Match["L"]
                               /\ result'[L1] = Pending /\ claims' = claims)]
    /\ UNCHANGED <<now, deadline, retried>>

\* Negative control only: an insert committed alone, then the worker stops.
AcceptThenStop(m) ==
    /\ SplitCommit
    /\ m \notin Accepted
    /\ Recipients(m) # {}
    /\ inbox' = Append(inbox, m)
    /\ UNCHANGED <<claims, result, now, deadline, retried, observed>>

Tick ==
    \* Allow two possible first-entry times without extending the one-tick budget.
    /\ now < (IF Entered(L1) THEN 2 ELSE 1)
    /\ now' = now + 1
    /\ UNCHANGED <<inbox, claims, result, deadline, retried, observed>>

Fire(v) ==
    /\ DeadlineReached(v)
    /\ v \in Waiting
    /\ result' = [result EXCEPT ![v] = Receipt("elapsed", "timer")]
    /\ UNCHANGED <<inbox, claims, now, deadline, retried, observed>>

RetryEntry(v) ==
    /\ Entered(v) /\ ~retried.entry
    /\ retried' = [retried EXCEPT !.entry = TRUE]
    /\ UNCHANGED <<db, now, observed>>

RetryAccept(m) ==
    /\ m \in Accepted /\ ~retried.accept
    /\ retried' = [retried EXCEPT !.accept = TRUE]
    /\ UNCHANGED <<db, now, observed>>

Finished == /\ \A v \in Visits : Entered(v)
            /\ Waiting = {}
            /\ Accepted = Messages

Next ==
    \/ \E v \in Visits : Enter(v) \/ Fire(v) \/ RetryEntry(v)
    \/ \E m \in Messages : Accept(m) \/ RetryAccept(m) \/ AcceptThenStop(m)
    \/ Tick
    \/ Finished /\ UNCHANGED vars

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ Len(inbox) <= Cardinality(Messages)
    /\ inbox \in [DOMAIN inbox -> Messages]
    /\ Cardinality(Accepted) = Len(inbox)
    /\ claims \subseteq (Visits \X Indices)
    /\ result \in [Visits -> [outcome : Names \cup {"new", "pending", "elapsed", "exhausted"},
                             via : {"none", "entry", "arrival", "timer"}]]
    /\ Cardinality(Waiting) <= 1
    /\ now \in 0..2
    /\ deadline \in 0..2
    /\ retried \in [entry : BOOLEAN, accept : BOOLEAN]
    /\ observed \in [lateArrival : BOOLEAN, spentEntry : BOOLEAN]

OncePerMessage ==
    \A i \in Indices : Cardinality({v \in Visits : i \in Taken(v)}) <= 1

VisitResult ==
    \A v \in Visits :
        /\ Cardinality(Taken(v)) <= 1
        /\ (Taken(v) # {}) <=> (result[v].outcome \in Names)
        /\ \A i \in Taken(v) :
               /\ i \in DOMAIN inbox
               /\ result[v].outcome = Contract[inbox[i]]

OnlyOwnContracts ==
    \A v \in Visits : \A i \in Taken(v) : Contract[inbox[i]] \in Match[v[1]]

IncreasingSequence ==
    \A v, w \in Visits :
        (v[1] = w[1] /\ v[2] < w[2]) =>
            \A i \in Taken(v) : \A j \in Taken(w) : i < j

Limits ==
    \A v \in Visits :
        /\ (result[v].outcome = "elapsed") => Taken(v) = {}
        /\ (Entered(v) /\ v[2] > MaxVisits[v[1]]) =>
               /\ result[v] = Receipt("exhausted", "entry")
               /\ Taken(v) = {}
        /\ (result[v].outcome = "exhausted") => v[2] > MaxVisits[v[1]]

NoLostDelivery == \A v \in Waiting : ~DeadlineReached(v) => Eligible(v) = {}

CommitRules ==
    /\ inbox = SubSeq(inbox', 1, Len(inbox))
    /\ claims \subseteq claims'
    /\ \A v \in Visits : (Entered(v) /\ v \notin Waiting) => result'[v] = result[v]
    /\ (retried' # retried) => UNCHANGED db
    /\ deadline' = IF ~Entered(L1) /\ result'[L1] # New THEN now + 1 ELSE deadline
    /\ \A c \in (claims' \ claims) :
           \A j \in 1..(c[2] - 1) :
               ~Used(j) => Contract[inbox'[j]] \notin Match[c[1][1]]
    /\ \A v \in Visits :
           (~Entered(v) /\ result'[v] # New /\ DeadlineReached(v)
             /\ v[2] <= MaxVisits["L"]) => result'[v] = Receipt("elapsed", "entry")

CommitSafety == [][CommitRules]_vars

\* A counterexample to one of these predicates is the requested witness.
NoPThenE == ~(result[L1].outcome = "P" /\ result[L2].outcome = "E")
NoArrival == ~(\E v \in {L1, L2} : result[v].via = "arrival")
NoEntryElapsed == ~(result[L2] = Receipt("elapsed", "entry") /\ Eligible(L2) # {})
NoExhausted == ~(result[L3] = Receipt("exhausted", "entry") /\ DeadlineReached(L3)
                                                           /\ Eligible(L3) # {})
NoDuplicateEntry == ~retried.entry
NoQWaiting == ~(\E v \in (Waiting \cap {L1, L2}) :
                   \E i \in DOMAIN inbox : inbox[i] = "q" /\ ~Used(i))
NoDuplicateAccept == ~retried.accept
NoTimerElapsed == ~(\E v \in {L1, L2} :
                      result[v] = Receipt("elapsed", "timer") /\ Eligible(v) # {})
NoLateArrivalThenTimer == ~(observed.lateArrival /\ result[L1] = Receipt("elapsed", "timer"))
NoSpentEntryWithMessage == ~observed.spentEntry
=============================================================================
