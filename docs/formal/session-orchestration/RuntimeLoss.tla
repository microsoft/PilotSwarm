----------------------------- MODULE RuntimeLoss -----------------------------
(***************************************************************************)
(* Issue 329: the Copilot runtime child behind a pooled client dies (an    *)
(* OOM kill, for example) during a turn or between turns. One session, one *)
(* turn after a committed one (the store holds "base").                    *)
(*                                                                         *)
(* The fix (Mode "fix"):                                                   *)
(*  - the runtime's exit takes its client out of the pool at once          *)
(*    (session-manager.ts _onRuntimeLost; ensureClient and _startClient    *)
(*    refuse a lost client), so a resume runs on a fresh runtime;          *)
(*  - a turn running on it settles at the exit, not at the 300 s turn      *)
(*    inactivity watchdog (managed-session.ts runtime guard);              *)
(*  - the activity drops the warm session and does not commit the torn     *)
(*    turn, so the turn sentinel stays dirty (session-proxy.ts transport-  *)
(*    loss block; session-lifecycle.ts runTurnCommit);                     *)
(*  - a warm session whose runtime exited is never reused (session-        *)
(*    manager.ts _getOrCreateUnlocked, runtimeLost).                       *)
(* The retry's preamble hydrates the last committed snapshot whenever the  *)
(* sentinel is dirty or there is no local dir (another worker), dropping   *)
(* any warm session first (session-lifecycle.ts runTurnPreamble,           *)
(* resolveFromStore). Main before the fix (Mode "main") committed the     *)
(* torn turn (clearing the sentinel), reused the dead warm session, kept   *)
(* the dead client pooled and settled the running turn only at the        *)
(* watchdog. The SDK starts a client again only when it has no connection *)
(* object, and a closed one stays set, so every later session on the dead *)
(* client fails at once with "Connection is closed.".                     *)
(*                                                                         *)
(* Local and stored content: "base" (the last committed turn), "torn"      *)
(* (base plus what a dying runtime wrote of the turn), "turn" (base plus   *)
(* the completed turn), "tornturn" (a turn completed on torn content: the  *)
(* torn part twice), "none" (no local dir: a fresh worker).                *)
(*                                                                         *)
(* Timing assumption: the runtime's exit event reaches the turn within     *)
(* milliseconds, long before the 300 s watchdog, so with the exit watch    *)
(* the watchdog never settles a lost turn (SettleByWatchdog is disabled).  *)
(* Not modelled: the orchestration's retry count and its lossy hand-off    *)
(* (OwnedRetry.tla), a runtime that hangs without exiting (it keeps the    *)
(* watchdog), the bounded wait for the dropped session's disconnect, and a *)
(* first turn with an empty store.                                         *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    MaxTries,       \* attempts of the turn (the orchestration's retries)
    MaxLoss,        \* runtime deaths
    AllowIdleLoss,  \* the runtime may also die between attempts or after the turn ran
    AllowMove,      \* a retry may run on another worker (once)
    Mode,           \* "fix" (issue 329), "main" (before it)
    Fault           \* "none", "commit-on-loss", "reuse-warm", "keep-dead-client", "no-exit-watch"

ASSUME MaxTries \in 1..4 /\ MaxLoss \in 0..3 /\ AllowIdleLoss \in BOOLEAN /\ AllowMove \in BOOLEAN
ASSUME Mode \in {"fix", "main"}
ASSUME Fault \in {"none", "commit-on-loss", "reuse-warm", "keep-dead-client", "no-exit-watch"}

VARIABLES
    att,       \* "idle", "running", "lost" (its runtime died, not yet settled), "ran", "retry", "done"
    res,       \* the attempt's result: "none", "ok", "loss"
    tries,     \* attempts started
    losses,    \* runtime deaths so far
    rt,        \* this worker's pooled client's runtime: "none", "live", "dead"
    pooled,    \* that client is in the pool
    warm,      \* the session's warm handle: "none", "live", "dead" (its runtime died)
    local,     \* the session's local dir on this worker
    store,     \* the committed snapshot
    sentinel,  \* the turn sentinel in the local dir: "clean", "dirty"
    moved,     \* the session moved to another worker
    gh         \* ghost flags
vars == <<att, res, tries, losses, rt, pooled, warm, local, store, sentinel, moved, gh>>

Fixed(protection) == Mode = "fix" /\ Fault # protection
ExitWatch == Fixed("no-exit-watch")
SkipCommitOnLoss == Fixed("commit-on-loss")
DropDeadWarm == Fixed("reuse-warm")
EvictDeadClient == Fixed("keep-dead-client")

Committed == store \in {"turn", "tornturn"}
Torn(l) == IF l \in {"torn", "tornturn"} THEN l ELSE "torn"
Advance(l) == IF l \in {"torn", "tornturn"} THEN "tornturn" ELSE "turn"

Init ==
    /\ att = "idle" /\ res = "none" /\ tries = 0 /\ losses = 0
    /\ rt = "live" /\ pooled = TRUE /\ warm = "live"
    /\ local = "base" /\ store = "base" /\ sentinel = "clean" /\ moved = FALSE /\ gh = {}

(* An attempt starts. The preamble hydrates the store (dropping the warm   *)
(* handle) when the sentinel is dirty or there is no local dir; then the  *)
(* turn sentinel is written. getOrCreate reuses a live warm handle; a dead *)
(* one is dropped (fix) or reused (main); otherwise the session resumes on *)
(* the pooled client, or on a fresh one when none is pooled. A dead pooled *)
(* client (main; with the fix it left the pool at its exit) fails at once. *)
Start ==
    /\ att \in {"idle", "retry"} /\ tries < MaxTries /\ ~Committed
    /\ tries' = tries + 1 /\ sentinel' = "dirty"
    /\ LET hydrate == sentinel = "dirty" \/ local = "none"
           w == IF hydrate THEN "none" ELSE warm
       IN /\ local' = IF hydrate THEN store ELSE local
          /\ CASE w = "live" ->
                    /\ att' = "running" /\ res' = "none" /\ warm' = "live"
                    /\ UNCHANGED <<rt, pooled, gh>>
               [] w = "dead" /\ ~DropDeadWarm ->
                    \* a send on the dead handle's closed connection fails at once
                    /\ att' = "ran" /\ res' = "loss" /\ warm' = "dead"
                    /\ gh' = gh \cup {"reuseDeadWarm"}
                    /\ UNCHANGED <<rt, pooled>>
               [] OTHER ->
                    IF pooled /\ rt = "dead"
                    THEN /\ att' = "ran" /\ res' = "loss" /\ warm' = "none"
                         /\ gh' = gh \cup {"deadClientUse"}
                         /\ UNCHANGED <<rt, pooled>>
                    ELSE /\ att' = "running" /\ res' = "none" /\ warm' = "live"
                         /\ rt' = "live" /\ pooled' = TRUE
                         /\ UNCHANGED gh
    /\ UNCHANGED <<losses, store, moved>>

(* The runtime dies. A running turn is left in flight; the runtime may    *)
(* have written part of the turn to the local dir. With the fix its client *)
(* leaves the pool at the exit.                                           *)
Die ==
    /\ losses < MaxLoss /\ rt = "live"
    /\ (att = "running" \/ (AllowIdleLoss /\ att \in {"idle", "retry", "ran"}))
    /\ rt' = "dead" /\ losses' = losses + 1
    /\ warm' = IF warm = "live" THEN "dead" ELSE warm
    /\ pooled' = IF EvictDeadClient THEN FALSE ELSE pooled
    /\ IF att = "running"
       THEN /\ att' = "lost" /\ \E l \in {local, Torn(local)} : local' = l
            /\ gh' = gh \cup {"turnLoss"}
       ELSE /\ UNCHANGED <<att, local>>
            /\ gh' = gh \cup {"idleLoss"}
    /\ UNCHANGED <<res, tries, store, sentinel, moved>>

(* The model run completes on a live runtime.                             *)
Finish ==
    /\ att = "running" /\ rt = "live"
    /\ att' = "ran" /\ res' = "ok" /\ local' = Advance(local)
    /\ UNCHANGED <<tries, losses, rt, pooled, warm, store, sentinel, moved, gh>>

(* The lost turn settles at the runtime's exit (the fix) ...              *)
SettleOnExit ==
    /\ att = "lost" /\ ExitWatch
    /\ att' = "ran" /\ res' = "loss"
    /\ UNCHANGED <<tries, losses, rt, pooled, warm, local, store, sentinel, moved, gh>>

(* ... or only at the inactivity watchdog (main).                         *)
SettleByWatchdog ==
    /\ att = "lost" /\ ~ExitWatch
    /\ att' = "ran" /\ res' = "loss" /\ gh' = gh \cup {"watchdogSettle"}
    /\ UNCHANGED <<tries, losses, rt, pooled, warm, local, store, sentinel, moved>>

(* The activity's postamble. A completed turn is committed (the sentinel  *)
(* is cleared). A lost turn: the fix drops the warm handle and skips the   *)
(* commit, leaving the sentinel dirty; main commits the local dir.        *)
Postamble ==
    /\ att = "ran"
    /\ IF res = "ok"
       THEN /\ store' = local /\ sentinel' = "clean" /\ att' = "done"
            /\ UNCHANGED <<warm, gh>>
       ELSE /\ att' = "retry"
            /\ warm' = IF DropDeadWarm THEN "none" ELSE warm
            /\ IF SkipCommitOnLoss
               THEN UNCHANGED <<store, sentinel, gh>>
               ELSE /\ store' = local /\ sentinel' = "clean"
                    /\ gh' = gh \cup (IF local \in {"torn", "tornturn"} THEN {"tornCommit"} ELSE {})
    /\ UNCHANGED <<res, tries, losses, rt, pooled, local, moved>>

(* The retry runs on another worker: no local dir, no warm handle, its own *)
(* pool (the orchestration releases the affinity before its retry timer). *)
Move ==
    /\ AllowMove /\ ~moved /\ att = "retry"
    /\ moved' = TRUE /\ local' = "none" /\ warm' = "none" /\ sentinel' = "clean"
    /\ rt' = "none" /\ pooled' = FALSE
    /\ UNCHANGED <<att, res, tries, losses, store, gh>>

Done == (Committed \/ (att \in {"idle", "retry"} /\ tries = MaxTries)) /\ UNCHANGED vars

Next == Start \/ Die \/ Finish \/ SettleOnExit \/ SettleByWatchdog \/ Postamble \/ Move \/ Done
Spec == Init /\ [][Next]_vars
Fairness ==
    /\ WF_vars(Start) /\ WF_vars(Finish) /\ WF_vars(SettleOnExit)
    /\ WF_vars(SettleByWatchdog) /\ WF_vars(Postamble)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
Contents == {"none", "base", "torn", "turn", "tornturn"}
TypeOK ==
    /\ att \in {"idle", "running", "lost", "ran", "retry", "done"} /\ res \in {"none", "ok", "loss"}
    /\ tries \in 0..MaxTries /\ losses \in 0..MaxLoss
    /\ rt \in {"none", "live", "dead"} /\ pooled \in BOOLEAN /\ warm \in {"none", "live", "dead"}
    /\ local \in Contents /\ store \in Contents \ {"none"} /\ sentinel \in {"clean", "dirty"}
    /\ moved \in BOOLEAN

(* What a dying runtime wrote of its turn is never committed.             *)
Inv_StoreNeverTorn == store \in {"base", "turn"}
(* A warm handle whose runtime exited is never used again.                *)
Inv_NoDeadWarmReuse == "reuseDeadWarm" \notin gh
(* A client whose runtime exited is never used for a session again.       *)
Inv_NoDeadClientUse == "deadClientUse" \notin gh
(* A lost turn settles at its runtime's exit, never at the watchdog.      *)
Inv_PromptSettle == "watchdogSettle" \notin gh
(* After a lost turn the sentinel stays dirty, so the retry on this       *)
(* worker hydrates the last committed snapshot.                           *)
Inv_LossLeavesSentinelDirty == (att = "retry" /\ res = "loss" /\ local # "none") => sentinel = "dirty"

(* Progress: with fewer runtime deaths than attempts, the turn commits.   *)
Prop_TurnCommits == <>Committed

(* Witnesses (each expected to be violated: the scenario is reachable).   *)
W_NoTurnLossRecovered == ~(store = "turn" /\ "turnLoss" \in gh)
W_NoMovedRecovery == ~(store = "turn" /\ moved /\ "turnLoss" \in gh)
W_NoIdleLossRecovered == ~(store = "turn" /\ "idleLoss" \in gh /\ "turnLoss" \notin gh)
=============================================================================
