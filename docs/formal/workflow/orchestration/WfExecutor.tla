------------------------------ MODULE WfExecutor ------------------------------
(***************************************************************************)
(* r2 (fidelity FR-5; RT-2). Two script states of one workflow on one     *)
(* worker (two parallel branches, or one after the other), each opening   *)
(* a workflow tool executor (session-manager.ts openWorkflowToolExecutor),*)
(* using it for one tool call and closing it. The native tool session is *)
(* keyed by the workflow session id (getOrCreate), so both share it.      *)
(*                                                                         *)
(*   efe44835: one executor per workflow session. open checks the map    *)
(*     (refusal "A workflow tool executor is already active."), then     *)
(*     awaits authorization and setup (getOrCreate: the existing native   *)
(*     session or a new one), and registers itself only at the end. A    *)
(*     close (dispose) destroys the native session and unregisters.       *)
(*   1c117a47: each state its own executor over one per-session share:    *)
(*     reserved (owner count) before anything is awaited; set up once,    *)
(*     after the previous share's teardown; the last close tears it down. *)
(* A native session that was destroyed under an executor fails that       *)
(* executor's tool call (broken).                                          *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Code, Overlap

ASSUME Code \in {"efe44835", "1c117a47", "1f7bdc77"} /\ Overlap \in BOOLEAN
Fixed == Code \in {"1c117a47", "1f7bdc77"}   \* 1f7bdc77 = 1c117a47 + group D; these paths are unchanged
Users == {1, 2}

VARIABLES
    upc,       \* per state: "idle", "auth", "setup", "register", "wait", "use", "close", "done", "refused"
    mine,      \* the native session generation each state's executor holds (0: none)
    broken,    \* states whose tool call found their native session destroyed
    gen,       \* generation of the native session (0: none yet)
    live,      \* a native session exists
    regd,      \* efe44835: the map has an executor for the session
    share,     \* 1c117a47: "none", "setting", "ready"
    owners,    \* 1c117a47: the share's owners
    tearing    \* 1c117a47: the previous share's teardown is in progress

vars == <<upc, mine, broken, gen, live, regd, share, owners, tearing>>

Init ==
    /\ upc = [u \in Users |-> "idle"] /\ mine = [u \in Users |-> 0] /\ broken = {}
    /\ gen = 0 /\ live = FALSE /\ regd = FALSE /\ share = "none" /\ owners = 0 /\ tearing = FALSE

(* Without overlap the second state opens only after the first closed.    *)
MayStart(u) == Overlap \/ u = 1 \/ upc[1] = "done"

----------------------------------------------------------------------------
(* efe44835.                                                                *)
OpenEfe(u) ==
    /\ ~Fixed /\ upc[u] = "idle" /\ MayStart(u)
    /\ upc' = [upc EXCEPT ![u] = IF regd THEN "refused" ELSE "auth"]
    /\ UNCHANGED <<mine, broken, gen, live, regd, share, owners, tearing>>

AuthEfe(u) ==
    /\ ~Fixed /\ upc[u] = "auth"
    /\ upc' = [upc EXCEPT ![u] = "setup"]
    /\ UNCHANGED <<mine, broken, gen, live, regd, share, owners, tearing>>

SetupEfe(u) ==           \* getOrCreate: the existing native session, or a new one
    /\ ~Fixed /\ upc[u] = "setup"
    /\ IF live THEN mine' = [mine EXCEPT ![u] = gen] /\ UNCHANGED <<gen, live>>
       ELSE /\ gen' = gen + 1 /\ live' = TRUE /\ mine' = [mine EXCEPT ![u] = gen + 1]
    /\ upc' = [upc EXCEPT ![u] = "register"]
    /\ UNCHANGED <<broken, regd, share, owners, tearing>>

RegisterEfe(u) ==
    /\ ~Fixed /\ upc[u] = "register"
    /\ regd' = TRUE /\ upc' = [upc EXCEPT ![u] = "use"]
    /\ UNCHANGED <<mine, broken, gen, live, share, owners, tearing>>

CloseEfe(u) ==           \* dispose: destroy the native session, unregister
    /\ ~Fixed /\ upc[u] = "close"
    /\ live' = FALSE /\ regd' = FALSE /\ upc' = [upc EXCEPT ![u] = "done"]
    /\ UNCHANGED <<mine, broken, gen, share, owners, tearing>>

----------------------------------------------------------------------------
(* 1c117a47.                                                                *)
OpenFix(u) ==            \* reserve: create the share, or join it
    /\ Fixed /\ upc[u] = "idle" /\ MayStart(u)
    /\ IF share = "none" THEN share' = "setting" /\ owners' = 1
       ELSE UNCHANGED share /\ owners' = owners + 1
    /\ upc' = [upc EXCEPT ![u] = "auth"]
    /\ UNCHANGED <<mine, broken, gen, live, regd, tearing>>

AuthFix(u) ==
    /\ Fixed /\ upc[u] = "auth"
    /\ upc' = [upc EXCEPT ![u] = "wait"]
    /\ UNCHANGED <<mine, broken, gen, live, regd, share, owners, tearing>>

SetupFix ==              \* the share's setup, after the previous teardown
    /\ Fixed /\ share = "setting" /\ ~tearing
    /\ share' = "ready" /\ gen' = gen + 1 /\ live' = TRUE
    /\ UNCHANGED <<upc, mine, broken, regd, owners, tearing>>

ReadyFix(u) ==
    /\ Fixed /\ upc[u] = "wait" /\ share = "ready"
    /\ mine' = [mine EXCEPT ![u] = gen] /\ upc' = [upc EXCEPT ![u] = "use"]
    /\ UNCHANGED <<broken, gen, live, regd, share, owners, tearing>>

CloseFix(u) ==           \* release: the last owner starts the teardown
    /\ Fixed /\ upc[u] = "close"
    /\ owners' = owners - 1
    /\ IF owners = 1 THEN share' = "none" /\ tearing' = TRUE
       ELSE UNCHANGED <<share, tearing>>
    /\ upc' = [upc EXCEPT ![u] = "done"]
    /\ UNCHANGED <<mine, broken, gen, live, regd>>

TeardownFix ==
    /\ Fixed /\ tearing
    /\ live' = FALSE /\ tearing' = FALSE
    /\ UNCHANGED <<upc, mine, broken, gen, regd, share, owners>>

----------------------------------------------------------------------------
(* One tool call on the executor's native session.                         *)
Use(u) ==
    /\ upc[u] = "use"
    /\ broken' = IF live /\ mine[u] = gen THEN broken ELSE broken \cup {u}
    /\ upc' = [upc EXCEPT ![u] = "close"]
    /\ UNCHANGED <<mine, gen, live, regd, share, owners, tearing>>

Done ==
    /\ \A u \in Users : upc[u] \in {"done", "refused"} /\ ~tearing
    /\ UNCHANGED vars

UserStep(u) == OpenEfe(u) \/ AuthEfe(u) \/ SetupEfe(u) \/ RegisterEfe(u) \/ CloseEfe(u)
            \/ OpenFix(u) \/ AuthFix(u) \/ ReadyFix(u) \/ CloseFix(u) \/ Use(u)

Next == (\E u \in Users : UserStep(u)) \/ SetupFix \/ TeardownFix \/ Done

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ (\A u \in Users : WF_vars(UserStep(u))) /\ WF_vars(SetupFix) /\ WF_vars(TeardownFix)

----------------------------------------------------------------------------
TypeOK ==
    /\ upc \in [Users -> {"idle", "auth", "setup", "register", "wait", "use", "close", "done", "refused"}]
    /\ mine \in [Users -> 0..2] /\ broken \subseteq Users
    /\ gen \in 0..2 /\ live \in BOOLEAN /\ regd \in BOOLEAN
    /\ share \in {"none", "setting", "ready"} /\ owners \in 0..2 /\ tearing \in BOOLEAN

(* Safety rules.                                                           *)
Inv_NoRefusal == \A u \in Users : upc[u] # "refused"
Inv_NoBrokenCall == broken = {}
(* Liveness: both states finish their tool call.                           *)
Prop_BothDone == <>(\A u \in Users : upc[u] = "done")
(* Witness, EXPECTED to be violated: both executors hold the session.    *)
Wit_Shared == ~(\A u \in Users : upc[u] = "use")
=============================================================================
