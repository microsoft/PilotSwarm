---------------------------- MODULE TurnCommit ----------------------------
EXTENDS Naturals, FiniteSets
CONSTANT ReuseThrownKey
VARIABLES phase, key, savedKeys, commits, modelCalls, crashesLeft, adopted
vars == <<phase, key, savedKeys, commits, modelCalls, crashesLeft, adopted>>
Init ==
    /\ phase = "preamble" /\ key = 1 /\ savedKeys = {}
    /\ commits = 0 /\ modelCalls = 0 /\ crashesLeft = 1 /\ adopted = FALSE
\* The snapshot-store contract is assumed, not a proof of provider code.
Preamble ==
    /\ phase = "preamble"
    /\ IF key \in savedKeys
       THEN /\ phase' = "returned" /\ adopted' = TRUE
            /\ UNCHANGED modelCalls
       ELSE /\ phase' = "model" /\ modelCalls' = modelCalls + 1
            /\ UNCHANGED adopted
    /\ UNCHANGED <<key, savedKeys, commits, crashesLeft>>
Commit ==
    /\ phase = "model" /\ key \notin savedKeys
    /\ savedKeys' = savedKeys \cup {key} /\ commits' = commits + 1
    /\ phase' = "committed"
    /\ UNCHANGED <<key, modelCalls, crashesLeft, adopted>>
Crash ==
    /\ phase \in {"model","committed"} /\ crashesLeft > 0
    /\ crashesLeft' = crashesLeft - 1 /\ phase' = "retry"
    /\ UNCHANGED <<key, savedKeys, commits, modelCalls, adopted>>
Retry ==
    /\ phase = "retry" /\ phase' = "preamble"
    /\ key' = IF ReuseThrownKey THEN key ELSE key + 1
    /\ UNCHANGED <<savedKeys, commits, modelCalls, crashesLeft, adopted>>
Return ==
    /\ phase = "committed" /\ phase' = "returned"
    /\ UNCHANGED <<key, savedKeys, commits, modelCalls, crashesLeft, adopted>>
Next == Preamble \/ Commit \/ Crash \/ Retry \/ Return
TypeOK ==
    /\ phase \in {"preamble","model","committed","retry","returned"}
    /\ key \in 1..2 /\ savedKeys \subseteq 1..2
    /\ commits \in 0..2 /\ modelCalls \in 0..2
    /\ crashesLeft \in 0..1 /\ adopted \in BOOLEAN
OneCommittedTurn == commits <= 1
NoFalseAdoption == adopted => key \in savedKeys
ExactlyOneModelCall == modelCalls <= 1
Spec == Init /\ [][Next]_vars /\ WF_vars(Preamble)
        /\ WF_vars(Commit) /\ WF_vars(Retry) /\ WF_vars(Return)
EventuallyReturns == <>(phase = "returned")
=============================================================================
