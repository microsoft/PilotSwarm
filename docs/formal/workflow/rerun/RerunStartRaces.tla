--------------------------- MODULE RerunStartRaces ---------------------------
(***************************************************************************)
(* Re-run Start races (I7, audit RR-4 and RR-10): the claim, the admission *)
(* and the refusal cleanup of re-run Starts, as separate store            *)
(* transactions, racing each other and every actor that locks the same    *)
(* rows.                                                                   *)
(*                                                                         *)
(* Start processes and their identities (operationId + requestSha256):    *)
(* "a" and "b" are two deliveries of one request r1 with key k1 (one claim *)
(* shell: a retry, or one request sent from two surfaces); "d" is another  *)
(* request r2 for the same key k1 (the same target shell); "c" is a second *)
(* re-run of the same source #2, request r3 with key k2.                  *)
(*                                                                         *)
(* A Start: the plan's approval gate (session-definitions.ts: channel,    *)
(* owner, provenance count and deciders) refuses before any claim, with   *)
(* no shell. The claim transaction (service.ts createWorkflow ->          *)
(* catalog.createWorkflowSession) first locks the owner session row FOR   *)
(* NO KEY UPDATE (lockLiveParent, on every path; a deleted owner is       *)
(* refused), then inserts the shell or finds the key's row: another       *)
(* request's row is refused (WORKFLOW_EXISTS), a deleted one too          *)
(* (WORKFLOW_DELETED), its own admitted one is a replay. The admission    *)
(* transaction (store.ts createDefinition) first reads its receipt        *)
(* (priorReceipt, before any lock: a replay), then requireSessionStartLocked*)
(* takes the owner row FOR SHARE (an ended owner is refused at once) and   *)
(* the definition row FOR SHARE (a deleted definition is refused at once),*)
(* lockSessionPair takes #2 FOR SHARE and its own shell FOR NO KEY UPDATE *)
(* in ascending session id order, then the checks (shell deleted, #2 gone,*)
(* the re-check of the pinned approval identity) and the definition insert*)
(* (ON CONFLICT: the other delivery's receipt, or another request's row)  *)
(* and the commit, or the refusal, which rolls back. After a refusal, the *)
(* cleanup transaction (store.ts softDeleteRefusedClaimShell) locks its   *)
(* shell FOR NO KEY UPDATE and soft-deletes it only while it is bare and  *)
(* its claim records this request. One action per lock step and per      *)
(* transaction; a crash can happen after the claim, inside the admission  *)
(* (rollback) and between the refusal and its cleanup.                    *)
(*                                                                         *)
(* Other actors: the definition delete (session-definition-store.ts       *)
(* deleteDefinition: owner FOR NO KEY UPDATE, then the definition FOR      *)
(* UPDATE); the owner session completing (an UPDATE of the owner row, then *)
(* its trigger, migration 0096, locks the direct child Workflow rows FOR   *)
(* NO KEY UPDATE in ascending session id order, then their active runs,    *)
(* which no Start holds; it deletes nothing); the owner session deleted   *)
(* (0096: owner, definitions, then the child Workflow rows in ascending   *)
(* session id order, soft-deleting them); the source #2 deleted           *)
(* (DeleteWorkflow / SweeperDirect: #2 alone); the Sweeper's bare-shell   *)
(* collection (sweeper-tools.ts + store.ts sweeperSoftDelete: after the    *)
(* grace period, an unlocked read of the row version, then the shell FOR  *)
(* NO KEY UPDATE, the same version and no definition or run re-checked     *)
(* under the lock).                                                        *)
(*                                                                         *)
(* TLC chooses the session id order of #2, k1 and k2 (all 6 orders), so   *)
(* both lock orders of each pair are checked, and for each Start whether  *)
(* the approval gates pass, the plan's gate refuses, or the admission's   *)
(* re-check refuses (the provenance read at the admission no longer       *)
(* matches the identity pinned at the plan). A lock wait is a disabled    *)
(* action: a lock cycle is a TLC deadlock (CHECK_DEADLOCK TRUE).          *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Starts,                 \* subset of {"a", "b", "c", "d"}: the Start processes that run
    GateChoices,            \* subset of {"pass", "plan", "admit"}: per Start, the gates pass, the plan's gate refuses, or the
                            \* admission's re-check refuses (TLC chooses)
    AllowCrash,             \* TRUE = one crash: after the claim, inside the admission, or between a refusal and its cleanup
    AllowOwnerComplete,     \* the owner session completes (not deleted)
    AllowOwnerDelete,       \* the owner session is deleted (0096 trigger)
    AllowDefDelete,         \* the session's Workflow Definition is deleted
    AllowSourceDelete,      \* source #2 is deleted
    AllowSweeper,           \* the Sweeper's bare-shell collection after the grace period
    \* ---- faults ----
    CleanupCodeFilter,      \* the code before RR-4: only a claim this Start created, and only RUN_ENDED / RERUN_* refusals
    CleanupUnconditional,   \* the code before RR-4: the cleanup soft-deletes the shell with no re-check under its lock
    CleanupIgnoresIdentity, \* the cleanup deletes a bare shell whatever request claimed it (no operationId / requestSha256)
    ClaimIgnoresIdentity,   \* the claim continues on a row another request claimed (no WORKFLOW_EXISTS)
    PairBeforeOwner,        \* the second re-run "c" takes its pair locks before the owner and definition locks
    DefDeleteDefFirst,      \* the definition delete locks the definition row before the owner row
    SweeperNoRecheck        \* the Sweeper soft-deletes without the version / no-run re-check under the lock

ASSUME Starts \subseteq {"a", "b", "c", "d"} /\ Starts # {}
ASSUME GateChoices \subseteq {"pass", "plan", "admit"} /\ "pass" \in GateChoices
ASSUME {AllowCrash, AllowOwnerComplete, AllowOwnerDelete, AllowDefDelete, AllowSourceDelete, AllowSweeper,
        CleanupCodeFilter, CleanupUnconditional, CleanupIgnoresIdentity, ClaimIgnoresIdentity, PairBeforeOwner,
        DefDeleteDefFirst, SweeperNoRecheck} \subseteq BOOLEAN

Keys == {"k1", "k2"}
Reqs == {"r1", "r2", "r3"}
KeyOf(p) == IF p = "c" THEN "k2" ELSE "k1"
ReqOf(p) == CASE p = "c" -> "r3" [] p = "d" -> "r2" [] OTHER -> "r1"
Children == {"src", "k1", "k2"}           \* the owner's child Workflow rows: #2, the shell of k1, the shell of k2
Rows == {"owner", "def"} \cup Children
Actors == {"dd", "od", "oc"}             \* lock-holding actors besides the Starts: definition delete, owner delete, complete
Holders == Starts \cup Actors \cup {"none"}
Ranks == {r \in [Children -> 1..3] : \A x, y \in Children : x # y => r[x] # r[y]}

Codes == {"none", "WORKFLOW_DELETED", "WORKFLOW_EXISTS", "SESSION_NOT_LIVE", "SESSION_NOT_FOUND", "DEFINITION_DELETED",
          "RERUN_SOURCE_GONE", "RERUN_APPROVAL_REUSED"}
RerunCodes == {"RERUN_SOURCE_GONE", "RERUN_APPROVAL_REUSED"}
InFlight == {"claimed", "rc", "lk1", "lk2", "lk3", "lk4", "refused"}
Final == {"idle_never", "gate_refused", "exists_refused", "admitted", "replayed", "done_refused", "lost", "crashed",
          "wf_deleted", "plan_refused"}

VARIABLES
    rank,           \* session id order of #2, k1 and k2 (chosen by TLC)
    gate,           \* [Starts -> GateChoices] (chosen by TLC)
    exl,            \* [Rows -> Holders]: exclusive holder (FOR NO KEY UPDATE, FOR UPDATE, UPDATE)
    shl,            \* [Rows -> SUBSET Starts]: FOR SHARE holders
    st,             \* [Starts -> state]
    created,        \* [Starts -> BOOLEAN]: this Start's claim created the shell
    tookPair,       \* [Starts -> BOOLEAN]: this Start's admission took a lock of its pair (#2 or its shell)
    replayedHow,    \* [Starts -> "none" | "claim" | "receipt" | "insert"]: where a replay was answered
    code,           \* [Starts -> Codes]: the refusal
    shell,          \* [Keys -> "none" | "bare" | "admitted" | "deleted"]
    shellReq,       \* [Keys -> Reqs \cup {"none"}]: the request the shell's claim records (creation_config)
    admittedReq,    \* [Keys -> Reqs \cup {"none"}]: the request whose admission committed in this shell
    cleanedReq,     \* [Keys -> Reqs \cup {"none"}]: the request whose cleanup deleted this shell
    ver,            \* [Keys -> 0..2]: the shell row's version (xmin): 1 claimed, 2 admitted
    deletedBy,      \* [Keys -> "none" | "cleanup" | "sweeper" | "owner"]
    grace,          \* [Keys -> BOOLEAN]: the bare shell is older than the grace period
    snap,           \* [Keys -> 0..3]: the Sweeper's unlocked version read (0 = none; v + 1 otherwise)
    ownerLive, ownerDeleted, defDeleted, srcLive,
    ddPc,           \* definition delete: "idle" | "l1" | "l2" | "done"
    odPc,           \* owner delete: "idle" | "owner" | "def" | "c1" | "c2" | "c3" | "done"
    ocPc,           \* owner complete: "idle" | "owner" | "c1" | "c2" | "c3" | "done"
    crashes,        \* 0..1
    bothShared      \* witness: #2 held FOR SHARE by two re-run admissions of different keys at once

startVars == <<st, created, tookPair, replayedHow, code>>
keyVars == <<shell, shellReq, admittedReq, cleanedReq, ver, deletedBy, grace, snap>>
envVars == <<ownerLive, ownerDeleted, defDeleted, srcLive>>
actorVars == <<ddPc, odPc, ocPc>>
vars == <<rank, gate, exl, shl, startVars, keyVars, envVars, actorVars, crashes, bothShared>>

WasAdmitted(k) == admittedReq[k] # "none"

TypeOK ==
    /\ rank \in Ranks
    /\ gate \in [Starts -> GateChoices]
    /\ exl \in [Rows -> Holders] /\ shl \in [Rows -> SUBSET Starts]
    /\ st \in [Starts -> {"idle"} \cup InFlight \cup Final]
    /\ created \in [Starts -> BOOLEAN] /\ tookPair \in [Starts -> BOOLEAN]
    /\ replayedHow \in [Starts -> {"none", "claim", "receipt", "insert"}] /\ code \in [Starts -> Codes]
    /\ shell \in [Keys -> {"none", "bare", "admitted", "deleted"}]
    /\ shellReq \in [Keys -> Reqs \cup {"none"}] /\ admittedReq \in [Keys -> Reqs \cup {"none"}]
    /\ cleanedReq \in [Keys -> Reqs \cup {"none"}] /\ ver \in [Keys -> 0..2]
    /\ deletedBy \in [Keys -> {"none", "cleanup", "sweeper", "owner"}]
    /\ grace \in [Keys -> BOOLEAN] /\ snap \in [Keys -> 0..3]
    /\ {ownerLive, ownerDeleted, defDeleted, srcLive, bothShared} \subseteq BOOLEAN
    /\ ddPc \in {"idle", "l1", "l2", "done"} /\ odPc \in {"idle", "owner", "def", "c1", "c2", "c3", "done"}
    /\ ocPc \in {"idle", "owner", "c1", "c2", "c3", "done"}
    /\ crashes \in 0..1

Init ==
    /\ rank \in Ranks
    /\ gate \in [Starts -> GateChoices]
    /\ exl = [r \in Rows |-> "none"] /\ shl = [r \in Rows |-> {}]
    /\ st = [p \in Starts |-> "idle"]
    /\ created = [p \in Starts |-> FALSE] /\ tookPair = [p \in Starts |-> FALSE]
    /\ replayedHow = [p \in Starts |-> "none"] /\ code = [p \in Starts |-> "none"]
    /\ shell = [k \in Keys |-> "none"] /\ shellReq = [k \in Keys |-> "none"] /\ admittedReq = [k \in Keys |-> "none"]
    /\ cleanedReq = [k \in Keys |-> "none"] /\ ver = [k \in Keys |-> 0] /\ deletedBy = [k \in Keys |-> "none"]
    /\ grace = [k \in Keys |-> FALSE] /\ snap = [k \in Keys |-> 0]
    /\ ownerLive = TRUE /\ ownerDeleted = FALSE /\ defDeleted = FALSE /\ srcLive = TRUE
    /\ ddPc = "idle" /\ odPc = "idle" /\ ocPc = "idle" /\ crashes = 0 /\ bothShared = FALSE

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

OthersUnchanged == UNCHANGED <<rank, gate, envVars, actorVars, crashes>>

-----------------------------------------------------------------------------
(* Start: the plan's gate and the claim transaction                       *)

\* session-definitions.ts prepareRerunStart: the approval gate (channel, owner, provenance count, deciders) refuses before
\* any claim: no shell, no lock, nothing to clean up.
GateRefuse(p) ==
    /\ st[p] = "idle" /\ gate[p] = "plan"
    /\ st' = [st EXCEPT ![p] = "gate_refused"]
    /\ UNCHANGED <<exl, shl, created, tookPair, replayedHow, code, keyVars, bothShared>> /\ OthersUnchanged

\* createWorkflowSession: one transaction. lockLiveParent locks the owner row FOR NO KEY UPDATE first, on every path (a
\* deleted owner is refused: PARENT_DELETED). It inserts the shell (requireChildBudgetLocked needs a live owner) or finds
\* the key's row: a deleted row is WORKFLOW_DELETED, another request's row is WORKFLOW_EXISTS (fault
\* ClaimIgnoresIdentity: it continues), this request's admitted row is answered from its receipt, a bare one is resumed.
\* It holds no lock after its commit.
Claim(p) ==
    LET k == KeyOf(p) IN
    /\ st[p] = "idle" /\ gate[p] # "plan"
    /\ CanEx("owner", p)
    /\ IF ownerDeleted \/ (~ownerLive /\ shell[k] = "none")
         THEN /\ st' = [st EXCEPT ![p] = "idle_never"]                 \* refused before any shell (nothing to clean)
              /\ UNCHANGED <<created, replayedHow, code, keyVars>>
       ELSE IF shell[k] = "none"
         THEN /\ st' = [st EXCEPT ![p] = "claimed"]
              /\ created' = [created EXCEPT ![p] = TRUE]
              /\ shell' = [shell EXCEPT ![k] = "bare"]
              /\ shellReq' = [shellReq EXCEPT ![k] = ReqOf(p)]
              /\ ver' = [ver EXCEPT ![k] = 1]
              /\ UNCHANGED <<replayedHow, code, admittedReq, cleanedReq, deletedBy, grace, snap>>
       ELSE IF shell[k] = "deleted"
         THEN /\ st' = [st EXCEPT ![p] = "wf_deleted"]                 \* WORKFLOW_DELETED (404)
              /\ UNCHANGED <<created, replayedHow, code, keyVars>>
       ELSE IF shellReq[k] # ReqOf(p) /\ ~ClaimIgnoresIdentity
         THEN /\ st' = [st EXCEPT ![p] = "exists_refused"]             \* WORKFLOW_EXISTS: another request's Workflow
              /\ code' = [code EXCEPT ![p] = "WORKFLOW_EXISTS"]
              /\ UNCHANGED <<created, replayedHow, keyVars>>
       ELSE IF shell[k] = "admitted" /\ admittedReq[k] = ReqOf(p)
         THEN /\ st' = [st EXCEPT ![p] = "replayed"]                   \* answered from its receipt
              /\ replayedHow' = [replayedHow EXCEPT ![p] = "claim"]
              /\ UNCHANGED <<created, code, keyVars>>
         ELSE /\ st' = [st EXCEPT ![p] = "claimed"]                    \* a resumed claim (created = FALSE)
              /\ UNCHANGED <<created, replayedHow, code, keyVars>>
    /\ UNCHANGED <<exl, shl, tookPair, bothShared>> /\ OthersUnchanged

\* A resumed claim is planned again before its admission (replaySessionStart: prepareRerunStart, the tool grant, the
\* limits). A refusal there writes nothing and keeps the shell for a retry of the same key after a fix; an unretried one
\* is the Sweeper's after the grace period (S6). Only a claim this Start found is re-planned after the claim.
PlanRefuse(p) ==
    /\ st[p] = "claimed" /\ ~created[p]
    /\ st' = [st EXCEPT ![p] = "plan_refused"]
    /\ UNCHANGED <<exl, shl, created, tookPair, replayedHow, code, keyVars, bothShared>> /\ OthersUnchanged

-----------------------------------------------------------------------------
(* Start: admission transaction                                            *)

\* priorReceipt, before any lock: a Workflow this request already admitted (the other delivery) is answered from it.
ReceiptCheck(p) ==
    LET k == KeyOf(p) IN
    /\ st[p] = "claimed"
    /\ IF shell[k] = "admitted" /\ admittedReq[k] = ReqOf(p)
         THEN /\ st' = [st EXCEPT ![p] = "replayed"]
              /\ replayedHow' = [replayedHow EXCEPT ![p] = "receipt"]
         ELSE /\ st' = [st EXCEPT ![p] = "rc"]
              /\ UNCHANGED replayedHow
    /\ UNCHANGED <<exl, shl, created, tookPair, code, keyVars, bothShared>> /\ OthersUnchanged

\* One lock per action. requireSessionStartLocked refuses an ended owner right after its owner lock (SESSION_NOT_FOUND
\* when deleted, SESSION_NOT_LIVE when ended) and a deleted definition right after its definition lock, before the pair;
\* the refusal rolls back and releases every lock.
LockStep(p, i, from, to) ==
    LET r == LockRow(p, i)
        early == CASE r = "owner" /\ ownerDeleted -> "SESSION_NOT_FOUND"
                   [] r = "owner" /\ ~ownerLive   -> "SESSION_NOT_LIVE"
                   [] r = "def" /\ defDeleted     -> "DEFINITION_DELETED"
                   [] OTHER                       -> "none"
    IN
    /\ st[p] = from
    /\ CanLock(p, r)
    /\ IF early # "none"
         THEN /\ ReleaseAll(p)
              /\ st' = [st EXCEPT ![p] = "refused"]
              /\ code' = [code EXCEPT ![p] = early]
              /\ UNCHANGED <<tookPair, bothShared>>
         ELSE /\ TakeLock(p, r)
              /\ st' = [st EXCEPT ![p] = to]
              /\ tookPair' = IF r \in {"src", KeyOf(p)} THEN [tookPair EXCEPT ![p] = TRUE] ELSE tookPair
              /\ bothShared' = (bothShared \/ (r = "src" /\ \E q \in Starts : q # p /\ KeyOf(q) # KeyOf(p) /\ q \in shl["src"]))
              /\ UNCHANGED code
    /\ UNCHANGED <<created, replayedHow, keyVars>> /\ OthersUnchanged

Lock1(p) == LockStep(p, 1, "rc", "lk1")
Lock2(p) == LockStep(p, 2, "lk1", "lk2")
Lock3(p) == LockStep(p, 3, "lk2", "lk3")
Lock4(p) == LockStep(p, 4, "lk3", "lk4")

\* Every lock is held: the checks in code order, then the definition insert (ON CONFLICT: this request's receipt is a
\* replay, another request's row a refusal) and the commit, or the refusal (a rollback). Under these locks no other
\* transaction can change the owner, the definition, #2 or the shell, so the checks read stable values. The approval
\* re-check (store.ts verifyRerunLimitsAndApprovalsIn) compares each reused approval's provenance, read now, with the
\* identity the plan pinned (approvalOwnerCheck); gate[p] = "admit" is a provenance that no longer matches.
Commit(p) ==
    LET k == KeyOf(p)
        refusal ==
            IF shell[k] = "deleted" THEN "WORKFLOW_DELETED"
            ELSE IF ~srcLive THEN "RERUN_SOURCE_GONE"
            ELSE IF gate[p] = "admit" THEN "RERUN_APPROVAL_REUSED"
            ELSE IF shell[k] = "admitted" /\ admittedReq[k] # ReqOf(p) THEN "WORKFLOW_EXISTS"
            ELSE "none"
    IN
    /\ st[p] = "lk4"
    /\ ReleaseAll(p)
    /\ IF refusal = "none" /\ shell[k] = "admitted"
         THEN /\ st' = [st EXCEPT ![p] = "replayed"]
              /\ replayedHow' = [replayedHow EXCEPT ![p] = "insert"]
              /\ UNCHANGED <<code, keyVars>>
       ELSE IF refusal = "none"
         THEN /\ st' = [st EXCEPT ![p] = "admitted"]
              /\ shell' = [shell EXCEPT ![k] = "admitted"]
              /\ admittedReq' = [admittedReq EXCEPT ![k] = ReqOf(p)]
              /\ ver' = [ver EXCEPT ![k] = 2]
              /\ UNCHANGED <<replayedHow, code, shellReq, cleanedReq, deletedBy, grace, snap>>
         ELSE /\ st' = [st EXCEPT ![p] = "refused"]
              /\ code' = [code EXCEPT ![p] = refusal]
              /\ UNCHANGED <<replayedHow, keyVars>>
    /\ UNCHANGED <<created, tookPair, bothShared>> /\ OthersUnchanged

-----------------------------------------------------------------------------
(* Start: the refusal cleanup, a transaction of its own                   *)

\* service.ts createWorkflow catch (RR-4): a re-run Start's admission refusal is followed by softDeleteRefusedClaimShell,
\* which locks the shell FOR NO KEY UPDATE and soft-deletes it only while it is bare (a live Workflow session with no
\* definition and no run) and its claim records this request's operationId and requestSha256 (fault
\* CleanupIgnoresIdentity: any request's). The code before RR-4 is the two faults CleanupCodeFilter (only a claim this
\* Start created, only RUN_ENDED / RERUN_* refusals) and CleanupUnconditional (catalog.softDeleteSession: no re-check).
Cleanup(p) ==
    LET k == KeyOf(p)
        applies == ~CleanupCodeFilter \/ (created[p] /\ code[p] \in RerunCodes)
        deletes == IF CleanupUnconditional THEN shell[k] # "deleted"
                   ELSE shell[k] = "bare" /\ (CleanupIgnoresIdentity \/ shellReq[k] = ReqOf(p))
    IN
    /\ st[p] = "refused"
    /\ CanEx(k, p)
    /\ st' = [st EXCEPT ![p] = "done_refused"]
    /\ IF applies /\ deletes
         THEN /\ shell' = [shell EXCEPT ![k] = "deleted"]
              /\ deletedBy' = [deletedBy EXCEPT ![k] = "cleanup"]
              /\ cleanedReq' = [cleanedReq EXCEPT ![k] = ReqOf(p)]
              /\ UNCHANGED <<shellReq, admittedReq, ver, grace, snap>>
         ELSE UNCHANGED keyVars
    /\ UNCHANGED <<exl, shl, created, tookPair, replayedHow, code, bothShared>> /\ OthersUnchanged

\* Crashes (at most one): after the claim, inside the admission (the transaction rolls back and its locks go), or between
\* the refusal and its cleanup (the refusal stands; the shell is left to a retry or to the Sweeper).
Crash(p) ==
    /\ AllowCrash /\ crashes = 0
    /\ st[p] \in InFlight
    /\ crashes' = 1
    /\ st' = [st EXCEPT ![p] = IF st[p] = "refused" THEN "lost" ELSE "crashed"]
    /\ ReleaseAll(p)
    /\ UNCHANGED <<rank, gate, created, tookPair, replayedHow, code, keyVars, envVars, actorVars, bothShared>>

-----------------------------------------------------------------------------
(* Other actors                                                            *)

ActorUnchanged == UNCHANGED <<rank, gate, shl, startVars, crashes, bothShared>>

\* A child row the 0096 trigger locks: a live one (a shell no claim has made yet, or one deleted already, is not locked;
\* while the owner row is held no claim can make a shell, since every claim locks the owner row).
ChildAt(i) == CHOOSE x \in Children : rank[x] = i
ChildLive(x) == IF x = "src" THEN srcLive ELSE shell[x] \in {"bare", "admitted"}
LockChild(who, i) ==
    IF ChildLive(ChildAt(i))
      THEN /\ CanEx(ChildAt(i), who) /\ exl' = [exl EXCEPT ![ChildAt(i)] = who]
      ELSE UNCHANGED exl
ReleaseActor(who) == exl' = [r \in Rows |-> IF exl[r] = who THEN "none" ELSE exl[r]]

\* The owner session completes: an UPDATE of its row (it waits for FOR SHARE holders), then its 0096 trigger locks the
\* direct child Workflow rows in ascending session id order (and their active runs, which no Start holds); it cancels
\* active child runs and deletes no Workflow session.
OwnerCompleteLockOwner ==
    /\ AllowOwnerComplete /\ ocPc = "idle" /\ ownerLive /\ ~ownerDeleted
    /\ CanEx("owner", "oc")
    /\ exl' = [exl EXCEPT !["owner"] = "oc"] /\ ocPc' = "owner"
    /\ UNCHANGED <<keyVars, envVars, ddPc, odPc>> /\ ActorUnchanged
OwnerCompleteLockChild(i, from, to) ==
    /\ ocPc = from
    /\ LockChild("oc", i)
    /\ ocPc' = to
    /\ UNCHANGED <<keyVars, envVars, ddPc, odPc>> /\ ActorUnchanged
OwnerCompleteCommit ==
    /\ ocPc = "c3"
    /\ ocPc' = "done" /\ ownerLive' = FALSE
    /\ ReleaseActor("oc")
    /\ UNCHANGED <<keyVars, ownerDeleted, defDeleted, srcLive, ddPc, odPc>> /\ ActorUnchanged

\* Definition delete: owner FOR NO KEY UPDATE, then the definition FOR UPDATE (fault DefDeleteDefFirst: the reverse).
DdFirst == IF DefDeleteDefFirst THEN "def" ELSE "owner"
DdSecond == IF DefDeleteDefFirst THEN "owner" ELSE "def"
DefDeleteLock1 ==
    /\ AllowDefDelete /\ ddPc = "idle"
    /\ CanEx(DdFirst, "dd")
    /\ exl' = [exl EXCEPT ![DdFirst] = "dd"] /\ ddPc' = "l1"
    /\ UNCHANGED <<keyVars, envVars, odPc, ocPc>> /\ ActorUnchanged
DefDeleteLock2 ==
    /\ ddPc = "l1"
    /\ CanEx(DdSecond, "dd")
    /\ exl' = [exl EXCEPT ![DdSecond] = "dd"] /\ ddPc' = "l2"
    /\ UNCHANGED <<keyVars, envVars, odPc, ocPc>> /\ ActorUnchanged
DefDeleteCommit ==
    /\ ddPc = "l2"
    /\ ddPc' = "done"
    /\ defDeleted' = (defDeleted \/ ownerLive)     \* deleteDefinition requires a live owner (lockLiveOwnerSession)
    /\ ReleaseActor("dd")
    /\ UNCHANGED <<keyVars, ownerLive, ownerDeleted, srcLive, odPc, ocPc>> /\ ActorUnchanged

\* Owner deleted (0096 workflow_on_owner_session_ended): the owner row, the definitions, then its child Workflow rows in
\* ascending session id order (each FOR UPDATE), then every one is soft-deleted.
OwnerDeleteLockOwner ==
    /\ AllowOwnerDelete /\ odPc = "idle" /\ ~ownerDeleted
    /\ CanEx("owner", "od")
    /\ exl' = [exl EXCEPT !["owner"] = "od"] /\ odPc' = "owner"
    /\ UNCHANGED <<keyVars, envVars, ddPc, ocPc>> /\ ActorUnchanged
OwnerDeleteLockDef ==
    /\ odPc = "owner"
    /\ CanEx("def", "od")
    /\ exl' = [exl EXCEPT !["def"] = "od"] /\ odPc' = "def"
    /\ UNCHANGED <<keyVars, envVars, ddPc, ocPc>> /\ ActorUnchanged
OwnerDeleteLockChild(i, from, to) ==
    /\ odPc = from
    /\ LockChild("od", i)
    /\ odPc' = to
    /\ UNCHANGED <<keyVars, envVars, ddPc, ocPc>> /\ ActorUnchanged
OwnerDeleteCommit ==
    /\ odPc = "c3"
    /\ odPc' = "done"
    /\ ownerLive' = FALSE /\ ownerDeleted' = TRUE /\ defDeleted' = TRUE /\ srcLive' = FALSE
    /\ shell' = [k \in Keys |-> IF shell[k] \in {"bare", "admitted"} THEN "deleted" ELSE shell[k]]
    /\ deletedBy' = [k \in Keys |-> IF shell[k] \in {"bare", "admitted"} THEN "owner" ELSE deletedBy[k]]
    /\ ReleaseActor("od")
    /\ UNCHANGED <<shellReq, admittedReq, cleanedReq, ver, grace, snap, ddPc, ocPc>> /\ ActorUnchanged

\* Source #2 deleted (DeleteWorkflow, or SweeperDirect whose descendants are locked NOWAIT): #2's row alone.
SourceDelete ==
    /\ AllowSourceDelete /\ srcLive
    /\ CanEx("src", "sd_")
    /\ srcLive' = FALSE
    /\ UNCHANGED <<exl, keyVars, ownerLive, ownerDeleted, defDeleted, actorVars>> /\ ActorUnchanged

\* The Sweeper's bare-shell collection (R2-M1): the grace period passes, an unlocked read of the version, then under the
\* shell's FOR NO KEY UPDATE lock the same version and no definition or run (fault SweeperNoRecheck: no re-check).
SweeperUnchanged == UNCHANGED <<rank, gate, exl, shl, startVars, shellReq, admittedReq, cleanedReq, ver, envVars, actorVars,
                                crashes, bothShared>>
GracePasses(k) ==
    /\ AllowSweeper /\ shell[k] = "bare" /\ ~grace[k]
    /\ grace' = [grace EXCEPT ![k] = TRUE]
    /\ UNCHANGED <<shell, deletedBy, snap>> /\ SweeperUnchanged
SweeperRead(k) ==
    /\ AllowSweeper /\ grace[k] /\ shell[k] = "bare" /\ snap[k] = 0
    /\ snap' = [snap EXCEPT ![k] = ver[k] + 1]
    /\ UNCHANGED <<shell, deletedBy, grace>> /\ SweeperUnchanged
SweeperCollect(k) ==
    /\ snap[k] > 0
    /\ CanEx(k, "sw_")
    /\ snap' = [snap EXCEPT ![k] = 0]
    /\ IF (SweeperNoRecheck /\ shell[k] # "deleted") \/ (shell[k] = "bare" /\ ver[k] + 1 = snap[k])
         THEN /\ shell' = [shell EXCEPT ![k] = "deleted"]
              /\ deletedBy' = [deletedBy EXCEPT ![k] = "sweeper"]
         ELSE UNCHANGED <<shell, deletedBy>>
    /\ UNCHANGED grace /\ SweeperUnchanged

AllFinal ==
    /\ \A p \in Starts : st[p] \in Final
    /\ ddPc \in {"idle", "done"} /\ odPc \in {"idle", "done"} /\ ocPc \in {"idle", "done"}

Done == AllFinal /\ UNCHANGED vars

StartStep(p) == GateRefuse(p) \/ Claim(p) \/ PlanRefuse(p) \/ ReceiptCheck(p) \/ Lock1(p) \/ Lock2(p) \/ Lock3(p) \/ Lock4(p)
                \/ Commit(p) \/ Cleanup(p)
ActorStep ==
    \/ DefDeleteLock1 \/ DefDeleteLock2 \/ DefDeleteCommit
    \/ OwnerDeleteLockOwner \/ OwnerDeleteLockDef \/ OwnerDeleteLockChild(1, "def", "c1")
    \/ OwnerDeleteLockChild(2, "c1", "c2") \/ OwnerDeleteLockChild(3, "c2", "c3") \/ OwnerDeleteCommit
    \/ OwnerCompleteLockOwner \/ OwnerCompleteLockChild(1, "owner", "c1") \/ OwnerCompleteLockChild(2, "c1", "c2")
    \/ OwnerCompleteLockChild(3, "c2", "c3") \/ OwnerCompleteCommit
    \/ SourceDelete
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
    \A k \in Keys : (WasAdmitted(k) /\ shell[k] = "deleted") => deletedBy[k] = "owner"

\* RR-4 (a), (b): once a refused Start's cleanup ran, the shell its own request claimed is not bare, whatever the refusal
\* and whether the Start made the claim or resumed it. (A crash before the cleanup is "lost": the Sweeper's, see
\* Live_NoBareShellLeft.)
Inv_RefusalLeavesNoBareShell ==
    \A p \in Starts : (st[p] = "done_refused" /\ shellReq[KeyOf(p)] = ReqOf(p)) => shell[KeyOf(p)] # "bare"

\* RR-4: a shell is admitted only by the request its claim records (another request with the same key is refused).
Inv_ShellAdmittedByItsRequest ==
    \A k \in Keys : WasAdmitted(k) => admittedReq[k] = shellReq[k]

\* RR-4: a refusal's cleanup deletes only a shell whose claim records its own request.
Inv_CleanupDeletesOwnClaimOnly ==
    \A k \in Keys : deletedBy[k] = "cleanup" => cleanedReq[k] = shellReq[k]

\* RR-4 with crashes: every bare shell is eventually gone (the cleanup, an admission, or the Sweeper after its grace).
Live_NoBareShellLeft == <>[](\A k \in Keys : shell[k] # "bare")

\* Witnesses (each expected violated).
\* RR-4 (c): one delivery is refused by the admission's approval re-check after the other delivery's admission committed,
\* and its cleanup leaves the admitted Workflow.
Wit_NoRefusedAfterOtherAdmitted ==
    ~(\E p \in Starts : st[p] = "done_refused" /\ code[p] = "RERUN_APPROVAL_REUSED" /\ shell[KeyOf(p)] = "admitted")
\* RR-4 (b): a refusal that is not RUN_ENDED / RERUN_* (the owner completed, the definition deleted) removes the shell,
\* refused at its owner or definition lock, before it took either lock of its pair.
Wit_NoOtherCodeCleaned ==
    ~(\E p \in Starts : st[p] = "done_refused" /\ code[p] \in {"SESSION_NOT_LIVE", "DEFINITION_DELETED"}
                        /\ ~tookPair[p] /\ deletedBy[KeyOf(p)] = "cleanup")
\* RR-4 (b): a resumed claim (made by a delivery that crashed) refused and removed.
Wit_NoResumedClaimCleaned ==
    ~(\E p \in Starts : ~created[p] /\ st[p] = "done_refused" /\ deletedBy[KeyOf(p)] = "cleanup")
\* RR-4 (a): the cleanup was lost in a crash after the refusal, and the Sweeper collected the shell.
Wit_NoLostCleanupSwept ==
    ~(\E p \in Starts : st[p] = "lost" /\ deletedBy[KeyOf(p)] = "sweeper")
\* RR-4: the admission's re-check of the pinned approval identity refuses after the claim, and the cleanup removes the
\* shell this Start's request claimed.
Wit_NoRecheckRefusalCleaned ==
    ~(\E p \in Starts : code[p] = "RERUN_APPROVAL_REUSED" /\ st[p] = "done_refused" /\ deletedBy[KeyOf(p)] = "cleanup")
\* RR-4: a replay answered from the receipt before any admission lock.
Wit_NoReceiptReplay == ~(\E p \in Starts : replayedHow[p] = "receipt")
\* RR-4: another request for the same key is refused at its claim while the first request's Workflow lives.
Wit_NoOtherRequestRefused == ~(\E p \in Starts : st[p] = "exists_refused" /\ shell[KeyOf(p)] \in {"bare", "admitted"})
\* RR-10: two re-runs of one source held #2 FOR SHARE at the same time, and both were admitted.
Wit_NoTwoRerunsShareSource ==
    ~(bothShared /\ WasAdmitted("k1") /\ WasAdmitted("k2"))
\* RR-10: both pair orders are reached with an admission (#2 first, and the shell first).
Wit_NoAdmitSourceFirst == ~(\E p \in Starts : st[p] = "admitted" /\ PairFirst(p) = "src")
Wit_NoAdmitShellFirst == ~(\E p \in Starts : st[p] = "admitted" /\ PairFirst(p) # "src")
\* RR-10: the definition delete and the owner deletion both commit while re-runs ran.
Wit_NoDeletersCommitted == ~(ddPc = "done" /\ odPc = "done" /\ \E p \in Starts : st[p] \in {"admitted", "done_refused"})
\* RR-10: the owner's completion locked an admitted re-run's row (its 0096 child locks) and committed.
Wit_NoOwnerCompleteAfterAdmission == ~(ocPc = "done" /\ \E k \in Keys : shell[k] = "admitted")
\* RR-4 / RR-10: the Sweeper collected the first key's lost shell, and the owner's deletion removed the second re-run.
Wit_NoSweepAndOwnerDelete == ~(deletedBy["k1"] = "sweeper" /\ deletedBy["k2"] = "owner")

=============================================================================
