---------------------------- MODULE SignalHandoff ----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS RegistryOK, KeepCarry
ASSUME RegistryOK \in BOOLEAN /\ KeepCarry \in BOOLEAN
Fields == {"fifo", "retry", "digest", "notice", "cron", "intake", "snapshot",
           "epoch", "workspace", "steers", "question", "waitTimer", "model",
           "budget", "failedTurn", "unread1", "unread2"}
VARIABLES deployed, replayed, version, carry, signals, failed
vars == <<deployed, replayed, version, carry, signals, failed>>
Init == /\ deployed = FALSE /\ replayed = FALSE /\ version = 83
        /\ carry = Fields /\ signals = FALSE /\ failed = FALSE
Deploy == /\ ~deployed /\ deployed' = TRUE
          /\ UNCHANGED <<replayed, version, carry, signals, failed>>
Replay == /\ deployed /\ ~replayed /\ version = 83
          /\ replayed' = TRUE /\ failed' = ~RegistryOK
          /\ UNCHANGED <<deployed, version, carry, signals>>
ContinueAsNew == /\ deployed /\ replayed /\ ~failed /\ version = 83
                 /\ version' = 84 /\ signals' = TRUE
                 /\ carry' = IF KeepCarry THEN carry ELSE carry \ {"intake"}
                 /\ UNCHANGED <<deployed, replayed, failed>>
Next == Deploy \/ Replay \/ ContinueAsNew \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Deploy) /\ WF_vars(Replay) /\ WF_vars(ContinueAsNew)
TypeOK == /\ deployed \in BOOLEAN /\ replayed \in BOOLEAN /\ signals \in BOOLEAN
          /\ failed \in BOOLEAN /\ version \in {83, 84} /\ carry \subseteq Fields
ReplayPinned == ~failed
CarryPreserved == carry = Fields
SignalsOnlyOnNew == signals = (version = 84)
Upgrades == <>(version = 84)
=============================================================================
