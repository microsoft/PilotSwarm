------------------------- MODULE WorkflowV2Receive -------------------------
(***************************************************************************)
(* Messaging receive states and typed input, as packages/sdk/src/workflow/ *)
(* v2 implements them in the commit of this file (README "Receive model"). *)
(* A run enters receive state 1 and, when that one received or elapsed,    *)
(* receive state 2. Both name the same sender (From: a session, or any     *)
(* sender) and may race a wait of Secs seconds in the store's clock. Two   *)
(* inputs are given at any time, each in two steps: the service's check    *)
(* (send_workflow_input) and the store's acceptance. A sender's session   *)
(* may be deleted; the run may be cancelled. clk is the store's clock; the *)
(* controller reads the same clock here (skew is the wait model's).        *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS
    Secs,           \* each receive's wait, in seconds (with HasWait)
    HasWait,        \* the receives race a wait
    Ttl,            \* how long an input that no receive took stays eligible, in seconds
    MaxPre,         \* the clock advances freely to MaxPre
    Matching,       \* the inputs (of 1..2) whose contract and correlation match the receives
    From,           \* the receives' sender: a session, "p" (the parent, or a named one) or "q", or "any"
    Sender1,        \* the session that gives input 1: "p" or "q"
    Sender2,        \* the session that gives input 2
    Authorized,     \* the sessions that the authority rule allows while they are live (authority.ts; a constant here)
    Deletes,        \* environment: a sender's session may be deleted
    Cancels,        \* environment: the run may be cancelled
    AdmitDecides,   \* fix 63f55d71: the admission decides the sender under the session locks; FALSE: the resolution's decision (6a2819f4)
    AcceptDecides,  \* fix 63f55d71: the acceptance decides the sender under the session locks; FALSE: the service's check (6a2819f4)
    OneReading,     \* fix 6a2819f4 (R3): one reading of the store's clock decides an entry; FALSE: selection and insert read it apart (ba01ef8e)
    Granule,        \* fix 6a2819f4 (R2): 1, exact times; 2, a deadline compared with a truncated acceptance time (ba01ef8e)
    ReceiptStored,  \* fix 6a2819f4 (R4): a repeat returns the acceptance's stored receipt; FALSE: the input's current claim (ba01ef8e)
    EntryClaim,     \* the code: a receive takes an eligible input when it is entered; FALSE is a deliberate fault
    IngressClaim,   \* the code: an input takes the waiting receive in its own transaction; FALSE is a deliberate fault
    DeadlineCheck,  \* the code: an input takes a receive only before its deadline; FALSE is a deliberate fault
    ConsumeOnClaim, \* the code: a taken input is marked consumed; FALSE is a deliberate fault
    EarliestFirst,  \* the code: an entry takes the earliest eligible input in the durable order; FALSE is a deliberate fault
    Cas             \* the code: the elapse is a compare-and-swap from pending; FALSE is a deliberate fault

ASSUME Secs \in Nat /\ Secs >= 1 /\ Ttl \in Nat /\ Ttl >= 1 /\ MaxPre \in Nat
ASSUME Matching \subseteq {1, 2}
ASSUME From \in {"p", "q", "any"} /\ Sender1 \in {"p", "q"} /\ Sender2 \in {"p", "q"} /\ Authorized \subseteq {"p", "q"}
ASSUME Granule \in {1, 2}
ASSUME {HasWait, Deletes, Cancels, AdmitDecides, AcceptDecides, OneReading, ReceiptStored, EntryClaim, IngressClaim,
        DeadlineCheck, ConsumeOnClaim, EarliestFirst, Cas} \subseteq BOOLEAN

M == {1, 2}
O == {1, 2}
Senders == {"p", "q"}
NoTime == -1
NoReply == -1
(* No step needs the clock past the second receive's latest deadline.      *)
ClockCap == MaxPre + 2 * Secs
Times == {NoTime} \cup 0..ClockCap
SenderOf(m) == IF m = 1 THEN Sender1 ELSE Sender2
(* An acceptance time as ba01ef8e compared it (a JavaScript Date).          *)
Trunc(t) == (t \div Granule) * Granule

VARIABLES
    clk,      \* the store's clock
    run,      \* "running" or "ended" (completed, cancelled, or failed by a refused receive)
    alive,    \* each session's row is live (not deleted)
    pc,       \* the controller: "resolve", "admit", "insert" (OneReading = FALSE only), "wait", "done"
    cur,      \* the receive the controller resolves, admits or waits for
    early,    \* the sender's authority as the resolution read it (AdmitDecides = FALSE uses it)
    sel,      \* the input an entry selected before its insert (OneReading = FALSE only; 0: none)
    seqNext,  \* the next durable order number (seq)
    mSt,      \* each input: "none", "checked" (the service allowed it), "accepted", "refused" (by the service),
              \* "late" (refused by the acceptance's own decision), "ended" (the run had ended)
    mAt,      \* its accepted_at
    mExp,     \* its expires_at
    mSeq,     \* its durable order
    mBy,      \* the receive that consumed it (0: none)
    mRcpt,    \* its receipt's claimedBy: the receive that took it in the acceptance's transaction (0: none)
    mOk,      \* ghost: its sender was live and allowed when it was accepted
    reply,    \* the claimedBy that the last answered repeat of it returned (NoReply: none yet)
    rSt,      \* each receive: "absent", "pending", "completed"
    rOut,     \* its outcome: "none", "received", "elapsed", "cancelled", "unavailable", "forbidden"
    rHow,     \* how it took its input: "none", "entry" (in its admission), "ingress" (in the input's acceptance)
    rEnt,     \* its entered_at
    rDl,      \* its deadline_at (NoTime: none)
    rTook,    \* the input it took (0: none)
    rEarly,   \* ghost: its resolution found its sender live and allowed
    rOk       \* ghost: "none", "ok" (admitted while its sender was live and allowed, or any sender), "dead"

ctlVars == <<pc, cur, early, sel>>
msgVars == <<seqNext, mSt, mAt, mExp, mSeq, mBy, mRcpt, mOk, reply>>
rcvVars == <<rSt, rOut, rHow, rEnt, rDl, rTook, rEarly, rOk>>
vars == <<clk, run, alive, ctlVars, msgVars, rcvVars>>

TypeOK ==
    /\ clk \in 0..ClockCap
    /\ run \in {"running", "ended"}
    /\ alive \in [Senders -> BOOLEAN]
    /\ pc \in {"resolve", "admit", "insert", "wait", "done"}
    /\ cur \in O
    /\ early \in {"none", "allowed", "unavailable", "forbidden"}
    /\ sel \in {0} \cup M
    /\ seqNext \in 1..3
    /\ mSt \in [M -> {"none", "checked", "accepted", "refused", "late", "ended"}]
    /\ mAt \in [M -> Times]
    /\ mExp \in [M -> {NoTime} \cup 0..(ClockCap + Ttl)]
    /\ mSeq \in [M -> 0..2]
    /\ mBy \in [M -> {0} \cup O]
    /\ mRcpt \in [M -> {0} \cup O]
    /\ mOk \in [M -> BOOLEAN]
    /\ reply \in [M -> {NoReply, 0} \cup O]
    /\ rSt \in [O -> {"absent", "pending", "completed"}]
    /\ rOut \in [O -> {"none", "received", "elapsed", "cancelled", "unavailable", "forbidden"}]
    /\ rHow \in [O -> {"none", "entry", "ingress"}]
    /\ rEnt \in [O -> Times]
    /\ rDl \in [O -> {NoTime} \cup 0..(ClockCap + Secs)]
    /\ rTook \in [O -> {0} \cup M]
    /\ rEarly \in [O -> BOOLEAN]
    /\ rOk \in [O -> {"none", "ok", "dead"}]

Init ==
    /\ clk = 0 /\ run = "running" /\ alive = [s \in Senders |-> TRUE]
    /\ pc = "resolve" /\ cur = 1 /\ early = "none" /\ sel = 0
    /\ seqNext = 1 /\ mSt = [m \in M |-> "none"] /\ mAt = [m \in M |-> NoTime] /\ mExp = [m \in M |-> NoTime]
    /\ mSeq = [m \in M |-> 0] /\ mBy = [m \in M |-> 0] /\ mRcpt = [m \in M |-> 0] /\ mOk = [m \in M |-> FALSE]
    /\ reply = [m \in M |-> NoReply]
    /\ rSt = [o \in O |-> "absent"] /\ rOut = [o \in O |-> "none"] /\ rHow = [o \in O |-> "none"]
    /\ rEnt = [o \in O |-> NoTime] /\ rDl = [o \in O |-> NoTime] /\ rTook = [o \in O |-> 0]
    /\ rEarly = [o \in O |-> FALSE] /\ rOk = [o \in O |-> "none"]

(* The authority rule (authority.ts decideTypedInputAuthority) on the      *)
(* current rows: a deleted session is unavailable; a live one is allowed   *)
(* when the rule allows it (Authorized).                                   *)
Decide(s) == IF ~alive[s] THEN "unavailable" ELSE IF s \in Authorized THEN "allowed" ELSE "forbidden"
SenderOk(s) == alive[s] /\ s \in Authorized

(* An input fits the receives: contract and correlation, and sender.       *)
Fits(m) == m \in Matching /\ (From = "any" \/ SenderOf(m) = From)
(* An input a receive may take at the store's reading t: accepted, fitting, *)
(* unexpired at t, unconsumed.                                             *)
EligibleAt(m, t) == mSt[m] = "accepted" /\ Fits(m) /\ mExp[m] > t /\ mBy[m] = 0
Pending(o) == rSt[o] = "pending"
Earliest(T) == CHOOSE m \in T : \A n \in T : mSeq[m] <= mSeq[n]
Latest(T) == CHOOSE m \in T : \A n \in T : mSeq[m] >= mSeq[n]
(* The input an entry at reading t takes (0: none).                        *)
Selected(t) ==
    IF EntryClaim /\ \E m \in M : EligibleAt(m, t)
    THEN (IF EarliestFirst THEN Earliest({m \in M : EligibleAt(m, t)}) ELSE Latest({m \in M : EligibleAt(m, t)}))
    ELSE 0

(* R resolveReceive in the enter activity: the receive's sender is         *)
(* resolved (the parent selector, or a named session) before the           *)
(* admission's transaction. 6a2819f4 also decided its authority here.      *)
Resolve ==
    /\ pc = "resolve"
    /\ run = "running"
    /\ early' = IF From = "any" THEN "allowed" ELSE Decide(From)
    /\ rEarly' = [rEarly EXCEPT ![cur] = (From = "any" \/ Decide(From) = "allowed")]
    /\ pc' = "admit"
    /\ UNCHANGED <<clk, run, alive, cur, sel, msgVars, rSt, rOut, rHow, rEnt, rDl, rTook, rOk>>

AdmitDecision == IF From = "any" THEN "allowed" ELSE IF AdmitDecides THEN Decide(From) ELSE early

(* The admission's record: entered at reading t, taking input m (0: none,  *)
(* then pending with its wait's deadline).                                 *)
Enter(m, t) ==
    /\ rSt' = [rSt EXCEPT ![cur] = IF m # 0 THEN "completed" ELSE "pending"]
    /\ rOut' = [rOut EXCEPT ![cur] = IF m # 0 THEN "received" ELSE "none"]
    /\ rHow' = [rHow EXCEPT ![cur] = IF m # 0 THEN "entry" ELSE "none"]
    /\ rEnt' = [rEnt EXCEPT ![cur] = t]
    /\ rDl' = [rDl EXCEPT ![cur] = IF m = 0 /\ HasWait THEN t + Secs ELSE NoTime]
    /\ rTook' = [rTook EXCEPT ![cur] = m]
    /\ rOk' = [rOk EXCEPT ![cur] = IF From = "any" \/ SenderOk(From) THEN "ok" ELSE "dead"]
    /\ mBy' = IF m # 0 /\ ConsumeOnClaim THEN [mBy EXCEPT ![m] = cur] ELSE mBy

(* A refused sender fails the receive at its admission: completed with     *)
(* the refusal, no deadline, nothing taken.                                *)
Refuse(d) ==
    /\ rSt' = [rSt EXCEPT ![cur] = "completed"]
    /\ rOut' = [rOut EXCEPT ![cur] = d]
    /\ rEnt' = [rEnt EXCEPT ![cur] = clk]
    /\ UNCHANGED <<rHow, rDl, rTook, rOk, mBy>>

(* S enterNode for a receive: after the session and run locks (the        *)
(* sender's row too, lockInputSessions) and the guards, one reading of the *)
(* store's clock decides the entry: the sender's authority, the input it   *)
(* takes (unexpired at that reading, earliest first), entered_at and the   *)
(* deadline. ba01ef8e selected at one reading and inserted at a later one. *)
Admit ==
    /\ pc = "admit"
    /\ run = "running"
    /\ IF AdmitDecision # "allowed"
       THEN (Refuse(AdmitDecision) /\ pc' = "wait" /\ UNCHANGED sel)
       ELSE IF OneReading
            THEN (Enter(Selected(clk), clk) /\ pc' = "wait" /\ UNCHANGED sel)
            ELSE (sel' = Selected(clk) /\ pc' = "insert" /\ UNCHANGED <<rSt, rOut, rHow, rEnt, rDl, rTook, rOk, mBy>>)
    /\ UNCHANGED <<clk, run, alive, cur, early, seqNext, mSt, mAt, mExp, mSeq, mRcpt, mOk, reply, rEarly>>

(* ba01ef8e's insert, at a later reading of the clock than its selection.  *)
AdmitInsert ==
    /\ pc = "insert"
    /\ Enter(sel, clk)
    /\ pc' = "wait"
    /\ sel' = 0
    /\ UNCHANGED <<clk, run, alive, cur, early, seqNext, mSt, mAt, mExp, mSeq, mRcpt, mOk, reply, rEarly>>

(* A run that ended admits nothing; the controller ends.                   *)
AdmitEnded ==
    /\ pc \in {"resolve", "admit"}
    /\ run # "running"
    /\ pc' = "done"
    /\ UNCHANGED <<clk, run, alive, cur, early, sel, msgVars, rcvVars>>

(* V sendWorkflowInputV2: the service checks the sender on the catalog's   *)
(* rows (typedInputAuthority) before it calls the store.                   *)
SendCheck(m) ==
    /\ mSt[m] = "none"
    /\ run = "running"
    /\ mSt' = [mSt EXCEPT ![m] = IF Decide(SenderOf(m)) = "allowed" THEN "checked" ELSE "refused"]
    /\ UNCHANGED <<clk, run, alive, ctlVars, seqNext, mAt, mExp, mSeq, mBy, mRcpt, mOk, reply, rcvVars>>

(* The acceptance's own decision of the sender (lockInputSessions); 6a2819f4 *)
(* relied on the service's check.                                          *)
AcceptOk(m) == IF AcceptDecides THEN Decide(SenderOf(m)) = "allowed" ELSE TRUE
(* The receive that waits for input m at reading clk: pending, fitting,    *)
(* before its deadline (DeadlineCheck, compared as Granule says).          *)
Waiting(m) == {o \in O : Pending(o) /\ Fits(m) /\ (~DeadlineCheck \/ rDl[o] = NoTime \/ rDl[o] > Trunc(clk))}
Taker(m) == IF IngressClaim /\ Waiting(m) # {} THEN CHOOSE o \in Waiting(m) : TRUE ELSE 0

(* S acceptInput, one transaction: the sender decided under the session    *)
(* locks, then one reading of the store's clock decides the input's        *)
(* accepted_at and expires_at and whether the waiting receive takes it;    *)
(* the receipt (claimedBy) is stored with the input.                       *)
SendAccept(m) ==
    /\ mSt[m] = "checked"
    /\ pc # "insert"
    /\ IF AcceptOk(m) /\ run = "running"
       THEN /\ mSt' = [mSt EXCEPT ![m] = "accepted"]
            /\ mAt' = [mAt EXCEPT ![m] = clk]
            /\ mExp' = [mExp EXCEPT ![m] = clk + Ttl]
            /\ mSeq' = [mSeq EXCEPT ![m] = seqNext]
            /\ seqNext' = seqNext + 1
            /\ mOk' = [mOk EXCEPT ![m] = SenderOk(SenderOf(m))]
            /\ mRcpt' = [mRcpt EXCEPT ![m] = Taker(m)]
            /\ mBy' = IF Taker(m) # 0 /\ ConsumeOnClaim THEN [mBy EXCEPT ![m] = Taker(m)] ELSE mBy
            /\ rSt' = IF Taker(m) # 0 THEN [rSt EXCEPT ![Taker(m)] = "completed"] ELSE rSt
            /\ rOut' = IF Taker(m) # 0 THEN [rOut EXCEPT ![Taker(m)] = "received"] ELSE rOut
            /\ rHow' = IF Taker(m) # 0 THEN [rHow EXCEPT ![Taker(m)] = "ingress"] ELSE rHow
            /\ rTook' = IF Taker(m) # 0 THEN [rTook EXCEPT ![Taker(m)] = m] ELSE rTook
       ELSE /\ mSt' = [mSt EXCEPT ![m] = IF ~AcceptOk(m) THEN "late" ELSE "ended"]
            /\ UNCHANGED <<seqNext, mAt, mExp, mSeq, mBy, mRcpt, mOk, rSt, rOut, rHow, rTook>>
    /\ UNCHANGED <<clk, run, alive, ctlVars, reply, rEnt, rDl, rEarly, rOk>>

(* A repeat of an accepted input's request, answered when the service's   *)
(* check allows its sender: the stored receipt (ba01ef8e: the current      *)
(* claim).                                                                 *)
Repeat(m) ==
    /\ mSt[m] = "accepted"
    /\ Decide(SenderOf(m)) = "allowed"
    /\ reply' = [reply EXCEPT ![m] = IF ReceiptStored THEN mRcpt[m] ELSE mBy[m]]
    /\ UNCHANGED <<clk, run, alive, ctlVars, seqNext, mSt, mAt, mExp, mSeq, mBy, mRcpt, mOk, rcvVars>>

(* cms_soft_delete_session of a sender's session. It does not end the      *)
(* workflow (its parent's deletion included); it waits for a transaction   *)
(* that holds that row's lock (an atomic step here).                       *)
Delete(s) ==
    /\ Deletes
    /\ alive[s]
    /\ alive' = [alive EXCEPT ![s] = FALSE]
    /\ UNCHANGED <<clk, run, ctlVars, msgVars, rcvVars>>

(* S elapseWait: the controller asks at the deadline (the same clock here) *)
(* and the store elapses a pending receive.                                *)
Elapse ==
    /\ pc = "wait"
    /\ rDl[cur] # NoTime
    /\ rDl[cur] <= clk
    /\ \/ Pending(cur)
       \/ ~Cas /\ rSt[cur] = "completed"
    /\ rSt' = [rSt EXCEPT ![cur] = "completed"]
    /\ rOut' = [rOut EXCEPT ![cur] = "elapsed"]
    /\ UNCHANGED <<clk, run, alive, ctlVars, msgVars, rHow, rEnt, rDl, rTook, rEarly, rOk>>

(* The controller collects the decided receive: after receive state 1      *)
(* received or elapsed it goes on to receive state 2; otherwise the run    *)
(* ends (a refusal fails it).                                              *)
Collect ==
    /\ pc = "wait"
    /\ rSt[cur] = "completed"
    /\ LET onward == run = "running" /\ cur = 1 /\ rOut[cur] \in {"received", "elapsed"}
       IN /\ pc' = IF onward THEN "resolve" ELSE "done"
          /\ cur' = IF onward THEN 2 ELSE cur
          /\ run' = IF onward THEN run ELSE "ended"
    /\ UNCHANGED <<clk, alive, early, sel, msgVars, rcvVars>>

(* The run's end (cancel or deletion of the workflow) decides a pending    *)
(* receive in its transaction.                                             *)
Cancel ==
    /\ Cancels
    /\ run = "running"
    /\ pc # "insert"
    /\ run' = "ended"
    /\ rSt' = [o \in O |-> IF Pending(o) THEN "completed" ELSE rSt[o]]
    /\ rOut' = [o \in O |-> IF Pending(o) THEN "cancelled" ELSE rOut[o]]
    /\ UNCHANGED <<clk, alive, ctlVars, msgVars, rHow, rEnt, rDl, rTook, rEarly, rOk>>

(* The store's clock advances freely to MaxPre, then while a pending       *)
(* receive's deadline is ahead.                                            *)
Tick ==
    /\ clk < ClockCap
    /\ \/ clk < MaxPre
       \/ \E o \in O : Pending(o) /\ rDl[o] # NoTime /\ clk < rDl[o]
    /\ clk' = clk + 1
    /\ UNCHANGED <<run, alive, ctlVars, msgVars, rcvVars>>

Next ==
    \/ Resolve \/ Admit \/ AdmitInsert \/ AdmitEnded \/ Elapse \/ Collect \/ Cancel \/ Tick
    \/ \E m \in M : (SendCheck(m) \/ SendAccept(m) \/ Repeat(m))
    \/ \E s \in Senders : Delete(s)

(* Weak fairness of the controller and the clock. Senders, repeats,        *)
(* deletions and the cancel are not fair.                                  *)
Fairness ==
    /\ WF_vars(Resolve) /\ WF_vars(Admit) /\ WF_vars(AdmitInsert) /\ WF_vars(AdmitEnded)
    /\ WF_vars(Elapse) /\ WF_vars(Collect) /\ WF_vars(Tick)

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)

(* A receive never waits before its deadline while an input it could take  *)
(* exists: one accepted before it was entered is taken at entry, one       *)
(* accepted while it waits is taken at once (R08).                         *)
Inv_NoMissedClaim ==
    \A o \in O : (Pending(o) /\ (rDl[o] = NoTime \/ clk < rDl[o])) => ~\E m \in M : EligibleAt(m, clk)

(* An input taken in its own acceptance was accepted before the receive's  *)
(* deadline, compared exactly (R2).                                        *)
Inv_NotLate == \A o \in O : (rHow[o] = "ingress" /\ rDl[o] # NoTime) => mAt[rTook[o]] < rDl[o]

(* An input taken at entry was accepted before the entry and was unexpired *)
(* at the entry's one reading, which is its entered_at (R3).               *)
Inv_EntryUnexpired == \A o \in O : rHow[o] = "entry" => (mAt[rTook[o]] <= rEnt[o] /\ mExp[rTook[o]] > rEnt[o])

(* An input is taken by at most one receive, which records it.             *)
Inv_TakeOnce ==
    /\ \A o, p \in O : (o # p /\ rTook[o] # 0) => rTook[o] # rTook[p]
    /\ \A m \in M : mBy[m] # 0 => rTook[mBy[m]] = m

(* A receive takes only an input that fits it.                             *)
Inv_TakeFits == \A o \in O : rTook[o] # 0 => Fits(rTook[o])

(* An entry takes the earliest eligible input: no input earlier in the     *)
(* durable order is still eligible.                                        *)
Inv_InOrder ==
    \A o \in O : rHow[o] = "entry" =>
        (\A n \in M : ((n # rTook[o] /\ mSt[n] = "accepted" /\ mSeq[n] < mSeq[rTook[o]]) => ~EligibleAt(n, clk)))

(* A receive is admitted only while its sender is live and allowed (R5).   *)
Inv_AdmittedSenderOk == \A o \in O : rOk[o] # "dead"

(* An input is accepted only while its sender is live and allowed (R5).    *)
Inv_AcceptedSenderOk == \A m \in M : mSt[m] = "accepted" => mOk[m]

(* A repeat returns the acceptance's receipt, whatever happened to the     *)
(* input since (R4).                                                       *)
Inv_RepeatReceipt == \A m \in M : reply[m] # NoReply => reply[m] = mRcpt[m]

(* A refused receive has no deadline and takes nothing.                    *)
Inv_RefusedBare == \A o \in O : rOut[o] \in {"unavailable", "forbidden"} => (rDl[o] = NoTime /\ rTook[o] = 0)

ReceiveSafety ==
    /\ TypeOK /\ Inv_NoMissedClaim /\ Inv_NotLate /\ Inv_EntryUnexpired /\ Inv_TakeOnce /\ Inv_TakeFits
    /\ Inv_InOrder /\ Inv_AdmittedSenderOk /\ Inv_AcceptedSenderOk /\ Inv_RepeatReceipt /\ Inv_RefusedBare

(* The first stored result of a receive is kept.                           *)
Prop_FirstResultKept ==
    [][\A o \in O : rSt[o] = "completed" => (rSt'[o] = "completed" /\ rOut'[o] = rOut[o] /\ rTook'[o] = rTook[o])]_vars

(* A pending receive is eventually decided (needs its wait, HasWait).      *)
Live_ReceiveDecided == \A o \in O : Pending(o) ~> (rSt[o] = "completed")

(* The controller eventually ends.                                         *)
Live_RunEnds == <>(pc = "done")

(***************************************************************************)
(* Witnesses: each is expected to be violated, which shows that its        *)
(* outcome is reachable.                                                   *)
(***************************************************************************)

Wit_EntryClaim == ~\E o \in O : rHow[o] = "entry"
Wit_IngressClaim == ~\E o \in O : rHow[o] = "ingress"
(* An input late for receive state 1 (its wait elapsed) is kept, and       *)
(* receive state 2 takes it.                                               *)
Wit_TimerWinKeepsInput == ~(rOut[1] = "elapsed" /\ rOut[2] = "received" /\ mAt[rTook[2]] >= rDl[1])
(* A sender that the resolution allowed is deleted before the admission,   *)
(* which fails the receive.                                                *)
Wit_RefusedAtAdmission == ~\E o \in O : rOut[o] = "unavailable" /\ rEarly[o]
(* A sender that the service's check allowed is refused by the acceptance. *)
Wit_RefusedAtAcceptance == ~\E m \in M : mSt[m] = "late"

=============================================================================
