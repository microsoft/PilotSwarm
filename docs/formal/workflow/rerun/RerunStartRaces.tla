--------------------------- MODULE RerunStartRaces ---------------------------
(***************************************************************************)
(* Re-run Start races (I7, audit RR-4 and RR-10): the claim, the admission *)
(* and the refusal cleanup of re-run Starts, as separate store            *)
(* transactions, racing each other and every actor that locks the same    *)
(* rows.                                                                   *)
(*                                                                         *)
(* Start processes: "a" and "b" are two deliveries of one keyed Start      *)
(* (one claim shell, key k1: a retry, or one key used from two surfaces); *)
(* "c" is a second re-run of the same source #2 with another key (k2).    *)
(* Each Start is: the claim transaction (service.ts createWorkflow ->      *)
(* catalog.createWorkflowSession: it creates the shell, or finds it), then *)
(* the admission transaction (store.ts createDefinition: priorReceipt,     *)
(* requireSessionStartLocked takes the owner session row FOR SHARE and the *)
(* definition row FOR SHARE, lockSessionPair takes #2 FOR SHARE and its    *)
(* own shell FOR NO KEY UPDATE in ascending session id order, then the     *)
(* checks and the commit or the refusal, which rolls back), then, after a  *)
(* refusal, the cleanup transaction (store.ts softDeleteRefusedClaimShell: *)
(* its own shell FOR NO KEY UPDATE, soft-deleted only while it is bare).  *)
(* One action per lock step and per transaction; a crash can happen after  *)
(* the claim, inside the admission (rollback) and between the refusal and *)
(* its cleanup.                                                            *)
(*                                                                         *)
(* Other actors: the definition delete (session-definition-store.ts       *)
(* deleteDefinition: owner FOR NO KEY UPDATE, then the definition FOR      *)
(* UPDATE), the owner session completing (an UPDATE of the owner row; its *)
(* trigger cancels active child runs and deletes nothing), the owner       *)
(* session deleted (migration 0096 workflow_on_owner_session_ended: owner, *)
(* definitions, then the child Workflow rows in ascending session id      *)
(* order, soft-deleting them), the source #2 deleted (DeleteWorkflow /     *)
(* SweeperDirect: #2 alone), and the Sweeper's bare-shell collection      *)
(* (sweeper-tools.ts + store.ts sweeperSoftDelete: after the grace period, *)
(* an unlocked read of the row version, then the shell FOR NO KEY UPDATE,  *)
(* the same version and no definition or run re-checked under the lock).  *)
(*                                                                         *)
(* TLC chooses the session id order of #2, k1 and k2 (all 6 orders), so   *)
(* both lock orders of each pair are checked, and which deliveries the    *)
(* approval-reuse gate refuses (another actor or channel). A lock wait is  *)
(* a disabled action: a lock cycle is a TLC deadlock (CHECK_DEADLOCK TRUE).*)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Starts,                 \* subset of {"a", "b", "c"}: the Start processes that run
    ApprovalVaries,         \* TRUE = TLC chooses, per Start, whether the approval-reuse gate refuses it
    AllowCrash,             \* TRUE = one crash: after the claim, inside the admission, or between a refusal and its cleanup
    AllowOwnerComplete,     \* the owner session completes (not deleted)
    AllowOwnerDelete,       \* the owner session is deleted (0096 trigger)
    AllowDefDelete,         \* the session's Workflow Definition is deleted
    AllowSourceDelete,      \* source #2 is deleted
    AllowSweeper,           \* the Sweeper's bare-shell collection after the grace period
    \* ---- faults ----
    CleanupCodeFilter,      \* the code before RR-4: only a claim this Start created, and only RUN_ENDED / RERUN_* refusals
    CleanupUnconditional,   \* the code before RR-4: the cleanup soft-deletes the shell with no re-check under its lock
    PairBeforeOwner,        \* the second re-run "c" takes its pair locks before the owner and definition locks
    DefDeleteDefFirst,      \* the definition delete locks the definition row before the owner row
    SweeperNoRecheck        \* the Sweeper soft-deletes without the version / no-run re-check under the lock

ASSUME Starts \subseteq {"a", "b", "c"} /\ Starts # {}
ASSUME {ApprovalVaries, AllowCrash, AllowOwnerComplete, AllowOwnerDelete, AllowDefDelete, AllowSourceDelete, AllowSweeper,
        CleanupCodeFilter, CleanupUnconditional, PairBeforeOwner, DefDeleteDefFirst, SweeperNoRecheck} \subseteq BOOLEAN

Keys == {"k1", "k2"}
KeyOf(p) == IF p = "c" THEN "k2" ELSE "k1"
Children == {"src", "k1", "k2"}           \* the owner's child Workflow rows: #2, the shell of k1, the shell of k2
Rows == {"owner", "def"} \cup Children
Actors == {"dd", "od"}                   \* lock-holding actors besides the Starts: definition delete, owner delete
Holders == Starts \cup Actors \cup {"none"}
Ranks == {r \in [Children -> 1..3] : \A x, y \in Children : x # y => r[x] # r[y]}

Codes == {"none", "WORKFLOW_DELETED", "SESSION_NOT_LIVE", "DEFINITION_DELETED", "RERUN_SOURCE_GONE", "RERUN_APPROVAL_REUSED"}
RerunCodes == {"RERUN_SOURCE_GONE", "RERUN_APPROVAL_REUSED"}
InFlight == {"claimed", "lk1", "lk2", "lk3", "lk4", "refused"}
Final == {"idle_never", "admitted", "replayed", "done_refused", "lost", "crashed", "wf_deleted", "plan_refused"}

VARIABLES
    rank,           \* session id order of #2, k1 and k2 (chosen by TLC)
    gateRefuses,    \* [Starts -> BOOLEAN]: the approval-reuse gate refuses this Start (chosen by TLC)
    exl,            \* [Rows -> Holders]: exclusive holder (FOR NO KEY UPDATE, FOR UPDATE, UPDATE)
    shl,            \* [Rows -> SUBSET Starts]: FOR SHARE holders
    st,             \* [Starts -> state]
    created,        \* [Starts -> BOOLEAN]: this Start's claim created the shell
    sawAdmitted,    \* [Starts -> BOOLEAN]: priorReceipt at the admission's start found the Workflow admitted
    code,           \* [Starts -> Codes]: the refusal
    shell,          \* [Keys -> "none" | "bare" | "admitted" | "deleted"]
    ver,            \* [Keys -> 0..2]: the shell row's version (xmin): 1 claimed, 2 admitted
    wasAdmitted,    \* [Keys -> BOOLEAN]
    deletedBy,      \* [Keys -> "none" | "cleanup" | "sweeper" | "owner"]
    grace,          \* [Keys -> BOOLEAN]: the bare shell is older than the grace period
    snap,           \* [Keys -> 0..3]: the Sweeper's unlocked version read (0 = none; v + 1 otherwise)
    ownerLive, ownerDeleted, defDeleted, srcLive,
    ddPc,           \* definition delete: "idle" | "l1" | "l2" | "done"
    odPc,           \* owner delete: "idle" | "owner" | "def" | "c1" | "c2" | "c3" | "done"
    crashes,        \* 0..1
    bothShared      \* witness: #2 held FOR SHARE by two re-run admissions of different keys at once

startVars == <<st, created, sawAdmitted, code>>
keyVars == <<shell, ver, wasAdmitted, deletedBy, grace, snap>>
envVars == <<ownerLive, ownerDeleted, defDeleted, srcLive>>
vars == <<rank, gateRefuses, exl, shl, startVars, keyVars, envVars, ddPc, odPc, crashes, bothShared>>

TypeOK ==
    /\ rank \in Ranks
    /\ gateRefuses \in [Starts -> BOOLEAN]
    /\ exl \in [Rows -> Holders] /\ shl \in [Rows -> SUBSET Starts]
    /\ st \in [Starts -> {"idle"} \cup InFlight \cup Final]
    /\ created \in [Starts -> BOOLEAN] /\ sawAdmitted \in [Starts -> BOOLEAN] /\ code \in [Starts -> Codes]
    /\ shell \in [Keys -> {"none", "bare", "admitted", "deleted"}] /\ ver \in [Keys -> 0..2]
    /\ wasAdmitted \in [Keys -> BOOLEAN] /\ deletedBy \in [Keys -> {"none", "cleanup", "sweeper", "owner"}]
    /\ grace \in [Keys -> BOOLEAN] /\ snap \in [Keys -> 0..3]
    /\ {ownerLive, ownerDeleted, defDeleted, srcLive, bothShared} \subseteq BOOLEAN
    /\ ddPc \in {"idle", "l1", "l2", "done"} /\ odPc \in {"idle", "owner", "def", "c1", "c2", "c3", "done"}
    /\ crashes \in 0..1

Init ==
    /\ rank \in Ranks
    /\ gateRefuses \in [Starts -> IF ApprovalVaries THEN BOOLEAN ELSE {FALSE}]
    /\ exl = [r \in Rows |-> "none"] /\ shl = [r \in Rows |-> {}]
    /\ st = [p \in Starts |-> "idle"]
    /\ created = [p \in Starts |-> FALSE] /\ sawAdmitted = [p \in Starts |-> FALSE] /\ code = [p \in Starts |-> "none"]
    /\ shell = [k \in Keys |-> "none"] /\ ver = [k \in Keys |-> 0]
    /\ wasAdmitted = [k \in Keys |-> FALSE] /\ deletedBy = [k \in Keys |-> "none"]
    /\ grace = [k \in Keys |-> FALSE] /\ snap = [k \in Keys |-> 0]
    /\ ownerLive = TRUE /\ ownerDeleted = FALSE /\ defDeleted = FALSE /\ srcLive = TRUE
    /\ ddPc = "idle" /\ odPc = "idle" /\ crashes = 0 /\ bothShared = FALSE

-----------------------------------------------------------------------------
(* Locks                                                                   *)

CanSh(r, p) == exl[r] \in {"none", p}
CanEx(r, p) == exl[r] \in {"none", p} /\ shl[r] \subseteq {p}
ReleaseAll(p) ==
    /\ exl' = [r \in Rows |-> IF exl[r] = p THEN "none" ELSE exl[r]]
    /\ shl' = [r \in Rows |-> shl[r] \ {p}]

\* The pair (#2 FOR SHARE, own shell FOR NO KEY UPDATE) in ascending session id order.
PairFirst(p) == IF rank["src"] < rank[KeyOf(p)] THEN "src" ELSE KeyOf(p)
PairSecond(p) == IF PairFirst(p) = "src" THEN KeyOf(p) ELSE "src"
\* The rows of a Start's admission, in the order it locks them.
LockRow(p, i) ==
    IF PairBeforeOwner /\ p = "c"
      THEN CASE i = 1 -> PairFirst(p) [] i = 2 -> PairSecond(p) [] i = 3 -> "owner" [] OTHER -> "def"
      ELSE CASE i = 1 -> "owner" [] i = 2 -> "def" [] i = 3 -> PairFirst(p) [] OTHER -> PairSecond(p)
Exclusive(p, r) == r = KeyOf(p)
CanLock(p, r) == IF Exclusive(p, r) THEN CanEx(r, p) ELSE CanSh(r, p)
TakeLock(p, r) ==
    IF Exclusive(p, r)
      THEN /\ exl' = [exl EXCEPT ![r] = p] /\ UNCHANGED shl
      ELSE /\ shl' = [shl EXCEPT ![r] = @ \cup {p}] /\ UNCHANGED exl

-----------------------------------------------------------------------------
(* Start: claim transaction                                                *)

\* createWorkflowSession: one transaction that inserts the shell (or finds the key's row). A claim that creates the shell
\* also takes the owner session row FOR NO KEY UPDATE in afterClaim (requireChildBudgetLocked; a live owner); one that
\* finds the row takes no lock. It holds no lock after its commit.
Claim(p) ==
    LET k == KeyOf(p) IN
    /\ st[p] = "idle"
    /\ shell[k] = "none" => CanEx("owner", p)
    /\ IF ~ownerLive /\ shell[k] = "none"
         THEN /\ st' = [st EXCEPT ![p] = "idle_never"]          \* refused before any shell (nothing to clean)
              /\ UNCHANGED <<created, keyVars>>
       ELSE IF shell[k] = "none"
         THEN /\ st' = [st EXCEPT ![p] = "claimed"]
              /\ created' = [created EXCEPT ![p] = TRUE]
              /\ shell' = [shell EXCEPT ![k] = "bare"]
              /\ ver' = [ver EXCEPT ![k] = 1]
              /\ UNCHANGED <<wasAdmitted, deletedBy, grace, snap>>
       ELSE IF shell[k] = "bare"
         THEN /\ st' = [st EXCEPT ![p] = "claimed"]                \* a resumed claim (created = FALSE)
              /\ UNCHANGED <<created, keyVars>>
       ELSE IF shell[k] = "admitted"
         THEN /\ st' = [st EXCEPT ![p] = "replayed"]               \* replaySessionStart: answered from its receipt
              /\ UNCHANGED <<created, keyVars>>
         ELSE /\ st' = [st EXCEPT ![p] = "wf_deleted"]             \* WORKFLOW_DELETED (404): the shell was deleted
              /\ UNCHANGED <<created, keyVars>>
    /\ UNCHANGED <<rank, gateRefuses, exl, shl, sawAdmitted, code, envVars, ddPc, odPc, crashes, bothShared>>

\* A resumed claim is planned again before its admission (replaySessionStart: prepareRerunStart, the tool grant, the
\* limits). A refusal there writes nothing and keeps the shell for a retry of the same key after a fix; an unretried one
\* is the Sweeper's after the grace period (S6). Only a claim this Start found is re-planned after the claim.
PlanRefuse(p) ==
    /\ st[p] = "claimed" /\ ~created[p]
    /\ st' = [st EXCEPT ![p] = "plan_refused"]
    /\ UNCHANGED <<rank, gateRefuses, exl, shl, created, sawAdmitted, code, keyVars, envVars, ddPc, odPc, crashes, bothShared>>

-----------------------------------------------------------------------------
(* Start: admission transaction, one action per lock                      *)

LockStep(p, i, from, to) ==
    LET r == LockRow(p, i) IN
    /\ st[p] = from
    /\ CanLock(p, r)
    /\ TakeLock(p, r)
    /\ st' = [st EXCEPT ![p] = to]
    \* priorReceipt (the admission's first read): a Workflow the other delivery already admitted is answered from it.
    /\ sawAdmitted' = IF i = 1 THEN [sawAdmitted EXCEPT ![p] = (shell[KeyOf(p)] = "admitted")] ELSE sawAdmitted
    /\ bothShared' = (bothShared \/ (r = "src" /\ \E q \in Starts : q # p /\ KeyOf(q) # KeyOf(p) /\ q \in shl["src"]))
    /\ UNCHANGED <<rank, gateRefuses, created, code, keyVars, envVars, ddPc, odPc, crashes>>

Lock1(p) == LockStep(p, 1, "claimed", "lk1")
Lock2(p) == LockStep(p, 2, "lk1", "lk2")
Lock3(p) == LockStep(p, 3, "lk2", "lk3")
Lock4(p) == LockStep(p, 4, "lk3", "lk4")

\* Every lock is held: the checks in code order, then the commit or the refusal (a rollback). Under these locks no other
\* transaction can change the owner, the definition, #2 or the shell, so the checks read stable values.
Commit(p) ==
    LET k == KeyOf(p)
        refusal ==
            IF sawAdmitted[p] THEN "none"
            ELSE IF ~ownerLive THEN "SESSION_NOT_LIVE"
            ELSE IF defDeleted THEN "DEFINITION_DELETED"
            ELSE IF shell[k] = "deleted" THEN "WORKFLOW_DELETED"
            ELSE IF ~srcLive THEN "RERUN_SOURCE_GONE"
            ELSE IF gateRefuses[p] THEN "RERUN_APPROVAL_REUSED"
            ELSE "none"
    IN
    /\ st[p] = "lk4"
    /\ ReleaseAll(p)
    /\ IF sawAdmitted[p] \/ (refusal = "none" /\ shell[k] = "admitted")
         THEN \* a replay: the receipt the other delivery stored (definition insert ON CONFLICT -> priorReceipt)
              /\ st' = [st EXCEPT ![p] = "replayed"]
              /\ UNCHANGED <<code, keyVars>>
       ELSE IF refusal = "none"
         THEN /\ st' = [st EXCEPT ![p] = "admitted"]
              /\ shell' = [shell EXCEPT ![k] = "admitted"]
              /\ ver' = [ver EXCEPT ![k] = 2]
              /\ wasAdmitted' = [wasAdmitted EXCEPT ![k] = TRUE]
              /\ UNCHANGED <<code, deletedBy, grace, snap>>
         ELSE /\ st' = [st EXCEPT ![p] = "refused"]
              /\ code' = [code EXCEPT ![p] = refusal]
              /\ UNCHANGED keyVars
    /\ UNCHANGED <<rank, gateRefuses, created, sawAdmitted, envVars, ddPc, odPc, crashes, bothShared>>

-----------------------------------------------------------------------------
(* Start: the refusal cleanup, a transaction of its own                   *)

\* service.ts createWorkflow catch (RR-4): a re-run Start's refusal is followed by softDeleteRefusedClaimShell, which locks
\* the shell FOR NO KEY UPDATE and soft-deletes it only while it is bare (a live Workflow session with no definition and no
\* run, whose claim records this request). The code before RR-4 is the two faults: CleanupCodeFilter (only a claim this
\* Start created, only RUN_ENDED / RERUN_* refusals) and CleanupUnconditional (catalog.softDeleteSession: no re-check).
Cleanup(p) ==
    LET k == KeyOf(p)
        applies == ~CleanupCodeFilter \/ (created[p] /\ code[p] \in RerunCodes)
        deletes == IF CleanupUnconditional THEN shell[k] # "deleted" ELSE shell[k] = "bare"
    IN
    /\ st[p] = "refused"
    /\ CanEx(k, p)
    /\ st' = [st EXCEPT ![p] = "done_refused"]
    /\ IF applies /\ deletes
         THEN /\ shell' = [shell EXCEPT ![k] = "deleted"]
              /\ deletedBy' = [deletedBy EXCEPT ![k] = "cleanup"]
              /\ UNCHANGED <<ver, wasAdmitted, grace, snap>>
         ELSE UNCHANGED keyVars
    /\ UNCHANGED <<rank, gateRefuses, exl, shl, created, sawAdmitted, code, envVars, ddPc, odPc, crashes, bothShared>>

\* Crashes (at most one): after the claim, inside the admission (the transaction rolls back and its locks go), or between
\* the refusal and its cleanup (the refusal stands; the shell is left to a retry or to the Sweeper).
Crash(p) ==
    /\ AllowCrash /\ crashes = 0
    /\ st[p] \in {"claimed", "lk1", "lk2", "lk3", "lk4", "refused"}
    /\ crashes' = 1
    /\ st' = [st EXCEPT ![p] = IF st[p] = "refused" THEN "lost" ELSE "crashed"]
    /\ ReleaseAll(p)
    /\ UNCHANGED <<rank, gateRefuses, created, sawAdmitted, code, keyVars, envVars, ddPc, odPc, bothShared>>

-----------------------------------------------------------------------------
(* Other actors                                                            *)

\* The owner session completes: an UPDATE of its row (it waits for FOR SHARE holders); its trigger cancels active child runs
\* and deletes no Workflow session.
OwnerComplete ==
    /\ AllowOwnerComplete /\ ownerLive /\ ~ownerDeleted
    /\ CanEx("owner", "oc_")
    /\ ownerLive' = FALSE
    /\ UNCHANGED <<rank, gateRefuses, exl, shl, startVars, keyVars, ownerDeleted, defDeleted, srcLive, ddPc, odPc, crashes, bothShared>>

\* Definition delete: owner FOR NO KEY UPDATE, then the definition FOR UPDATE (fault DefDeleteDefFirst: the reverse).
DdFirst == IF DefDeleteDefFirst THEN "def" ELSE "owner"
DdSecond == IF DefDeleteDefFirst THEN "owner" ELSE "def"
DefDeleteLock1 ==
    /\ AllowDefDelete /\ ddPc = "idle"
    /\ CanEx(DdFirst, "dd")
    /\ exl' = [exl EXCEPT ![DdFirst] = "dd"] /\ ddPc' = "l1"
    /\ UNCHANGED <<rank, gateRefuses, shl, startVars, keyVars, envVars, odPc, crashes, bothShared>>
DefDeleteLock2 ==
    /\ ddPc = "l1"
    /\ CanEx(DdSecond, "dd")
    /\ exl' = [exl EXCEPT ![DdSecond] = "dd"] /\ ddPc' = "l2"
    /\ UNCHANGED <<rank, gateRefuses, shl, startVars, keyVars, envVars, odPc, crashes, bothShared>>
DefDeleteCommit ==
    /\ ddPc = "l2"
    /\ ddPc' = "done"
    /\ defDeleted' = (defDeleted \/ ownerLive)     \* deleteDefinition requires a live owner (lockLiveOwnerSession)
    /\ exl' = [r \in Rows |-> IF exl[r] = "dd" THEN "none" ELSE exl[r]]
    /\ UNCHANGED <<rank, gateRefuses, shl, startVars, keyVars, ownerLive, ownerDeleted, srcLive, odPc, crashes, bothShared>>

\* Owner deleted (0096 workflow_on_owner_session_ended): the owner row, the definitions, then its child Workflow rows in
\* ascending session id order (each FOR UPDATE), then every one is soft-deleted.
ChildAt(i) == CHOOSE x \in Children : rank[x] = i
\* A child row the trigger locks: a live one (a shell no claim has made yet, or one deleted already, is not locked; while
\* the owner row is held no claim can make a shell, since a creating claim locks the owner row).
ChildLive(x) == IF x = "src" THEN srcLive ELSE shell[x] \in {"bare", "admitted"}
OwnerDeleteLockOwner ==
    /\ AllowOwnerDelete /\ odPc = "idle" /\ ~ownerDeleted
    /\ CanEx("owner", "od")
    /\ exl' = [exl EXCEPT !["owner"] = "od"] /\ odPc' = "owner"
    /\ UNCHANGED <<rank, gateRefuses, shl, startVars, keyVars, envVars, ddPc, crashes, bothShared>>
OwnerDeleteLockDef ==
    /\ odPc = "owner"
    /\ CanEx("def", "od")
    /\ exl' = [exl EXCEPT !["def"] = "od"] /\ odPc' = "def"
    /\ UNCHANGED <<rank, gateRefuses, shl, startVars, keyVars, envVars, ddPc, crashes, bothShared>>
OwnerDeleteLockChild(i, from, to) ==
    /\ odPc = from
    /\ IF ChildLive(ChildAt(i))
         THEN /\ CanEx(ChildAt(i), "od")
              /\ exl' = [exl EXCEPT ![ChildAt(i)] = "od"]
         ELSE UNCHANGED exl
    /\ odPc' = to
    /\ UNCHANGED <<rank, gateRefuses, shl, startVars, keyVars, envVars, ddPc, crashes, bothShared>>
OwnerDeleteCommit ==
    /\ odPc = "c3"
    /\ odPc' = "done"
    /\ ownerLive' = FALSE /\ ownerDeleted' = TRUE /\ defDeleted' = TRUE /\ srcLive' = FALSE
    /\ shell' = [k \in Keys |-> IF shell[k] \in {"bare", "admitted"} THEN "deleted" ELSE shell[k]]
    /\ deletedBy' = [k \in Keys |-> IF shell[k] \in {"bare", "admitted"} THEN "owner" ELSE deletedBy[k]]
    /\ exl' = [r \in Rows |-> IF exl[r] = "od" THEN "none" ELSE exl[r]]
    /\ UNCHANGED <<rank, gateRefuses, shl, startVars, ver, wasAdmitted, grace, snap, ddPc, crashes, bothShared>>

\* Source #2 deleted (DeleteWorkflow, or SweeperDirect whose descendants are locked NOWAIT): #2's row alone.
SourceDelete ==
    /\ AllowSourceDelete /\ srcLive
    /\ CanEx("src", "sd_")
    /\ srcLive' = FALSE
    /\ UNCHANGED <<rank, gateRefuses, exl, shl, startVars, keyVars, ownerLive, ownerDeleted, defDeleted, ddPc, odPc, crashes, bothShared>>

\* The Sweeper's bare-shell collection (R2-M1): the grace period passes, an unlocked read of the version, then under the
\* shell's FOR NO KEY UPDATE lock the same version and no definition or run (fault SweeperNoRecheck: no re-check).
GracePasses(k) ==
    /\ AllowSweeper /\ shell[k] = "bare" /\ ~grace[k]
    /\ grace' = [grace EXCEPT ![k] = TRUE]
    /\ UNCHANGED <<rank, gateRefuses, exl, shl, startVars, shell, ver, wasAdmitted, deletedBy, snap, envVars, ddPc, odPc, crashes, bothShared>>
SweeperRead(k) ==
    /\ AllowSweeper /\ grace[k] /\ shell[k] = "bare" /\ snap[k] = 0
    /\ snap' = [snap EXCEPT ![k] = ver[k] + 1]
    /\ UNCHANGED <<rank, gateRefuses, exl, shl, startVars, shell, ver, wasAdmitted, deletedBy, grace, envVars, ddPc, odPc, crashes, bothShared>>
SweeperCollect(k) ==
    /\ snap[k] > 0
    /\ CanEx(k, "sw_")
    /\ snap' = [snap EXCEPT ![k] = 0]
    /\ IF (SweeperNoRecheck /\ shell[k] # "deleted") \/ (shell[k] = "bare" /\ ver[k] + 1 = snap[k])
         THEN /\ shell' = [shell EXCEPT ![k] = "deleted"]
              /\ deletedBy' = [deletedBy EXCEPT ![k] = "sweeper"]
         ELSE UNCHANGED <<shell, deletedBy>>
    /\ UNCHANGED <<rank, gateRefuses, exl, shl, startVars, ver, wasAdmitted, grace, envVars, ddPc, odPc, crashes, bothShared>>

AllFinal ==
    /\ \A p \in Starts : st[p] \in Final
    /\ ddPc \in {"idle", "done"} /\ odPc \in {"idle", "done"}

Done == AllFinal /\ UNCHANGED vars

StartStep(p) == Claim(p) \/ PlanRefuse(p) \/ Lock1(p) \/ Lock2(p) \/ Lock3(p) \/ Lock4(p) \/ Commit(p) \/ Cleanup(p)
ActorStep ==
    \/ DefDeleteLock1 \/ DefDeleteLock2 \/ DefDeleteCommit
    \/ OwnerDeleteLockOwner \/ OwnerDeleteLockDef \/ OwnerDeleteLockChild(1, "def", "c1")
    \/ OwnerDeleteLockChild(2, "c1", "c2") \/ OwnerDeleteLockChild(3, "c2", "c3") \/ OwnerDeleteCommit
    \/ OwnerComplete \/ SourceDelete
SweeperStep(k) == GracePasses(k) \/ SweeperRead(k) \/ SweeperCollect(k)

Next ==
    \/ \E p \in Starts : StartStep(p) \/ Crash(p)
    \/ ActorStep
    \/ \E k \in Keys : SweeperStep(k)
    \/ Done

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ (\A p \in Starts : WF_vars(StartStep(p))) /\ WF_vars(ActorStep) /\ (\A k \in Keys : WF_vars(SweeperStep(k)))

-----------------------------------------------------------------------------
(* Properties                                                              *)

\* RR-4 (c): a refusal's cleanup (or the Sweeper) never deletes an admitted Workflow; only the owner's deletion does.
Inv_AdmittedNeverDeleted ==
    \A k \in Keys : (wasAdmitted[k] /\ shell[k] = "deleted") => deletedBy[k] = "owner"

\* RR-4 (a), (b): once a refused Start's cleanup ran, its key's shell is not bare, whatever the refusal and whether the
\* Start made the claim or resumed it. (A crash before the cleanup is "lost": the Sweeper's, see Live_NoBareShellLeft.)
Inv_RefusalLeavesNoBareShell ==
    \A p \in Starts : st[p] = "done_refused" => shell[KeyOf(p)] # "bare"

\* RR-4 with crashes: every bare shell is eventually gone (the cleanup, an admission, or the Sweeper after its grace).
Live_NoBareShellLeft == <>[](\A k \in Keys : shell[k] # "bare")

\* Witnesses (each expected violated).
\* RR-4 (c): one delivery is refused with RERUN_APPROVAL_REUSED after it waited for the other's admission, and its cleanup
\* leaves the admitted Workflow.
Wit_NoRefusedAfterOtherAdmitted ==
    ~(\E p \in Starts : st[p] = "done_refused" /\ code[p] = "RERUN_APPROVAL_REUSED" /\ shell[KeyOf(p)] = "admitted")
\* RR-4 (b): a refusal that is not RUN_ENDED / RERUN_* (the owner completed, the definition deleted) removes the shell.
Wit_NoOtherCodeCleaned ==
    ~(\E p \in Starts : st[p] = "done_refused" /\ code[p] \in {"SESSION_NOT_LIVE", "DEFINITION_DELETED"}
                        /\ deletedBy[KeyOf(p)] = "cleanup")
\* RR-4 (b): a resumed claim (made by a delivery that crashed) refused and removed.
Wit_NoResumedClaimCleaned ==
    ~(\E p \in Starts : ~created[p] /\ st[p] = "done_refused" /\ deletedBy[KeyOf(p)] = "cleanup")
\* RR-4 (a): the cleanup was lost in a crash after the refusal, and the Sweeper collected the shell.
Wit_NoLostCleanupSwept ==
    ~(\E p \in Starts : st[p] = "lost" /\ deletedBy[KeyOf(p)] = "sweeper")
\* RR-10: two re-runs of one source held #2 FOR SHARE at the same time, and both were admitted.
Wit_NoTwoRerunsShareSource ==
    ~(bothShared /\ wasAdmitted["k1"] /\ wasAdmitted["k2"])
\* RR-10: both pair orders are reached with an admission (#2 first, and the shell first).
Wit_NoAdmitSourceFirst == ~(\E p \in Starts : st[p] = "admitted" /\ PairFirst(p) = "src")
Wit_NoAdmitShellFirst == ~(\E p \in Starts : st[p] = "admitted" /\ PairFirst(p) # "src")
\* RR-10: the definition delete and the owner deletion both commit while re-runs ran.
Wit_NoDeletersCommitted == ~(ddPc = "done" /\ odPc = "done" /\ \E p \in Starts : st[p] \in {"admitted", "done_refused"})

=============================================================================
