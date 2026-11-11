------------------------------ MODULE RollingDeploy ------------------------------
(***************************************************************************)
(* A deploy that makes 1.0.83 the latest session version, with its tagged  *)
(* turns (runTurnV5, tag pilotswarm.workflow-request.v1). "83" stands for  *)
(* any orchestration version only new workers register (1.0.83, Workflow   *)
(* controller 1.9.0 and its tagged 1.1.0 orchestrations).                  *)
(* Duroxide has no version routing: any worker may fetch an instance's     *)
(* orchestration item. A worker that has not registered its version       *)
(* abandons it with backoff and, past max_attempts (10; MaxAttempts here), *)
(* poisons it, failing the instance (dispatchers/orchestration.rs 545-558, *)
(* 722-746). A tagged activity is fetched only by a worker whose tag      *)
(* filter has the tag, else it waits; a session-bound item goes to the     *)
(* session's owner worker until its lock lapses.                           *)
(* Strategy: "recreate" (every worker stopped, upgraded, started: the     *)
(* release's deploy) or "one-phase" (a rolling deploy: each worker in turn *)
(* gets 1.0.83, the tag and latest = 1.0.83). "two-phase" (register        *)
(* everywhere first, flip latest in a later release) is kept for reference.*)
(* Duroxide 0.1.32: abandon delays 1, 2, 4, 8, 16, 32, 60, 60, 60, 60 s    *)
(* (about 5 minutes) then poison past 10 attempts; MaxAttempts scales it.  *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Strategy,      \* "one-phase", "two-phase", "recreate"
    TagEverywhere, \* new workers register the V5 turns and the tag
    MaxAttempts,   \* abandon count before poison
    Fault          \* "none", "flip-before-register" (two-phase with phase 2 before phase 1 ended)

ASSUME Strategy \in {"one-phase", "two-phase", "recreate"} /\ TagEverywhere \in BOOLEAN /\ MaxAttempts \in 1..3
ASSUME Fault \in {"none", "flip-before-register"}

W == {"w1", "w2"}

VARIABLES
    reg,      \* worker -> registers 1.0.83
    tag,      \* worker -> serves the turn tag
    latest,   \* worker -> its latest version: "82" or "83"
    ver,      \* the session's execution version
    attempts, \* abandoned fetches of its current item
    poisoned,
    turn,     \* "none", "pending" (a tagged turn activity is queued), "done"
    owner,    \* the worker holding the session lock, or "none"
    gh
vars == <<reg, tag, latest, ver, attempts, poisoned, turn, owner, gh>>

Init ==
    /\ reg = [w \in W |-> FALSE] /\ tag = [w \in W |-> FALSE] /\ latest = [w \in W |-> "82"]
    /\ ver = "82" /\ attempts = 0 /\ poisoned = FALSE /\ turn = "none" /\ gh = {}
    \* the session lock is held by an old worker from its 1.0.82 turns
    /\ owner = "w1"

Phase1Done == \A w \in W : reg[w]

(* Deploy steps.                                                           *)
UpgradeOne ==
    /\ Strategy = "one-phase"
    /\ \E w \in W : ~reg[w] /\ reg' = [reg EXCEPT ![w] = TRUE] /\ tag' = [tag EXCEPT ![w] = TagEverywhere]
                     /\ latest' = [latest EXCEPT ![w] = "83"]
    /\ UNCHANGED <<ver, attempts, poisoned, turn, owner, gh>>
Register ==
    /\ Strategy = "two-phase"
    /\ \E w \in W : ~reg[w] /\ reg' = [reg EXCEPT ![w] = TRUE] /\ tag' = [tag EXCEPT ![w] = TagEverywhere]
    /\ UNCHANGED <<latest, ver, attempts, poisoned, turn, owner, gh>>
Flip ==
    /\ Strategy = "two-phase" /\ (Phase1Done \/ Fault = "flip-before-register")
    /\ \E w \in W : reg[w] /\ latest[w] = "82" /\ latest' = [latest EXCEPT ![w] = "83"]
    /\ UNCHANGED <<reg, tag, ver, attempts, poisoned, turn, owner, gh>>
Recreate ==
    /\ Strategy = "recreate" /\ ~Phase1Done
    /\ reg' = [w \in W |-> TRUE] /\ tag' = [w \in W |-> TagEverywhere] /\ latest' = [w \in W |-> "83"]
    /\ UNCHANGED <<ver, attempts, poisoned, turn, owner, gh>>

Live == ~poisoned

(* A worker fetches the session's orchestration item.                      *)
Fetch(w) ==
    /\ Live /\ turn = "none"
    /\ IF ver = "83" /\ ~reg[w]
       THEN /\ attempts' = attempts + 1
            /\ poisoned' = (attempts + 1 > MaxAttempts)
            /\ gh' = gh \cup {"abandoned"}
            /\ UNCHANGED <<ver, turn>>
       ELSE \* it runs: a 1.0.82 execution continues as new into this worker's latest version;
            \* a 1.0.83 execution schedules its next turn (tagged)
            /\ attempts' = 0 /\ UNCHANGED poisoned
            /\ IF ver = "82"
               THEN /\ ver' = latest[w] /\ UNCHANGED turn /\ gh' = gh \cup (IF latest[w] = "83" THEN {"moved"} ELSE {})
               ELSE /\ turn' = "pending" /\ UNCHANGED <<ver, gh>>
    /\ UNCHANGED owner

(* The tagged turn activity: only a worker with the tag; the session's     *)
(* owner first (its lock), any tagged worker once the lock lapsed.          *)
RunTurn(w) ==
    /\ Live /\ turn = "pending" /\ tag[w] /\ (owner = w \/ owner = "none")
    /\ turn' = "done" /\ owner' = w
    /\ UNCHANGED <<reg, tag, latest, ver, attempts, poisoned, gh>>
LockLapse ==
    /\ turn = "pending" /\ owner # "none" /\ ~tag[owner]
    /\ owner' = "none"
    /\ UNCHANGED <<reg, tag, latest, ver, attempts, poisoned, turn, gh>>

FetchAny == \E w \in W : Fetch(w) /\ UNCHANGED <<reg, tag, latest>>
Deployed == Phase1Done /\ \A w \in W : latest[w] = "83"
Done == (poisoned \/ turn = "done") /\ UNCHANGED vars

Next == UpgradeOne \/ Register \/ Flip \/ Recreate \/ FetchAny \/ (\E w \in W : RunTurn(w)) \/ LockLapse \/ Done
Spec == Init /\ [][Next]_vars
Fairness == WF_vars(UpgradeOne) /\ WF_vars(Register) /\ WF_vars(Flip) /\ WF_vars(Recreate)
            /\ WF_vars(FetchAny) /\ WF_vars(\E w \in W : RunTurn(w)) /\ WF_vars(LockLapse)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK == /\ reg \in [W -> BOOLEAN] /\ tag \in [W -> BOOLEAN] /\ latest \in [W -> {"82", "83"}]
          /\ ver \in {"82", "83"} /\ attempts \in 0..(MaxAttempts + 1) /\ poisoned \in BOOLEAN
          /\ turn \in {"none", "pending", "done"} /\ owner \in W \cup {"none"}
(* The session is never failed by a worker that lacks its version.         *)
Inv_NoPoison == ~poisoned
(* No worker ever fetches an item of a version it lacks.                   *)
Inv_NoAbandon == "abandoned" \notin gh
(* The session moves to 1.0.83 and its turn runs.                          *)
Prop_TurnRuns == <>(turn = "done")

W_NotMoved == "moved" \notin gh
=============================================================================
