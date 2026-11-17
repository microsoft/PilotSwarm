---------------------------- MODULE SignalHandoff ----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS RegistryOK, KeepCarry, FaultContract
ASSUME RegistryOK \in BOOLEAN /\ KeepCarry \in BOOLEAN /\ FaultContract \in BOOLEAN
Fields == {"fifo", "retry", "digest", "notice", "cron", "intake", "snapshot",
           "epoch", "workspace", "steers", "question", "waitTimer", "model",
           "budget", "failedTurn", "titleLock", "toolBindings", "unread1", "unread2"}
VARIABLES deployed, replayed, version, carry, signals, failed, legacySignals
vars == <<deployed, replayed, version, carry, signals, failed, legacySignals>>
Init == /\ deployed = FALSE /\ replayed = FALSE /\ version = 85
        /\ carry = Fields /\ signals = FALSE /\ failed = FALSE
        /\ legacySignals = FALSE
Deploy == /\ ~deployed /\ deployed' = TRUE
          /\ UNCHANGED <<replayed, version, carry, signals, failed, legacySignals>>
Replay == /\ deployed /\ ~replayed /\ version = 85
          /\ replayed' = TRUE /\ failed' = ~RegistryOK
          /\ legacySignals' = FaultContract
          /\ UNCHANGED <<deployed, version, carry, signals>>
ContinueAsNew == /\ deployed /\ replayed /\ ~failed /\ version = 85
                 /\ version' = 86 /\ signals' = TRUE
                 /\ carry' = IF KeepCarry THEN carry ELSE carry \ {"intake"}
                 /\ UNCHANGED <<deployed, replayed, failed, legacySignals>>
Next == Deploy \/ Replay \/ ContinueAsNew \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Deploy) /\ WF_vars(Replay) /\ WF_vars(ContinueAsNew)
TypeOK == /\ deployed \in BOOLEAN /\ replayed \in BOOLEAN /\ signals \in BOOLEAN
          /\ failed \in BOOLEAN /\ legacySignals \in BOOLEAN
          /\ version \in {85, 86} /\ carry \subseteq Fields
ReplayPinned == ~failed
HistoricalContract == ~legacySignals
CarryPreserved == carry = Fields
SignalsOnlyOnNew == signals = (version = 86)
Upgrades == <>(version = 86)
=============================================================================
