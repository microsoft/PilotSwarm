------------------------------ MODULE WfPaging ------------------------------
(***************************************************************************)
(* r2 (fidelity FR-3; RT-5). The cleanup that ends the children of a run's *)
(* decided agent states (endAgents; endWorkflowV2RunAgents) when the run  *)
(* has more agent invocations than one page holds. N invocations, ids    *)
(* 1..N in creation (and node execution id) order, every state decided;  *)
(* Settled ones were ended earlier (end_sent_at set). Page scales the    *)
(* real 200 (N = Page + 1 scales the 201st invocation).                  *)
(*                                                                         *)
(*   efe44835: store.listAgentInvocations(runId): the run's FIRST page of *)
(*     invocations, ended or not, in creation order; each owed one in it  *)
(*     is ended; no further page is read (a retry reads the same page).   *)
(*   1c117a47: store.listOwedAgentInvocations(runId, after, Page): owed   *)
(*     ones only (end_sent_at IS NULL), by id after a cursor, page after  *)
(*     page until a short page; the cursor moves past one that stays      *)
(*     owed. A failed end is recorded and the call fails at its end (its  *)
(*     activity retries it, MaxCalls calls in all).                        *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Code, N, Page, Settled, AllowEndFail, MaxCalls

ASSUME Code \in {"efe44835", "1c117a47", "1f7bdc77"} /\ N \in Nat /\ Page \in 1..N /\ Settled \subseteq 1..N
Fixed == Code \in {"1c117a47", "1f7bdc77"}   \* 1f7bdc77 = 1c117a47 + group D; these paths are unchanged
Ids == 1..N

VARIABLES
    sent,     \* the invocations whose end was sent (end_sent_at)
    pc,       \* "list", "end", "done"
    listed,   \* the page as read (a sequence of ids)
    idx,      \* the next position of the page to end
    cursor,   \* 1c117a47: the last id of the previous page (0: none)
    failed,   \* ids whose end failed in this call
    calls,    \* activity calls (the first and its retries)
    failOnce  \* an end may fail once (a transient failure)

vars == <<sent, pc, listed, idx, cursor, failed, calls, failOnce>>

\* The ids of a finite set in ascending order.
RECURSIVE Sorted(_)
Sorted(S) == IF S = {} THEN <<>>
             ELSE LET m == CHOOSE x \in S : \A y \in S : x <= y IN <<m>> \o Sorted(S \ {m})
FirstK(s, k) == IF Len(s) <= k THEN s ELSE SubSeq(s, 1, k)

Init ==
    /\ sent = Settled /\ pc = "list" /\ listed = <<>> /\ idx = 1 /\ cursor = 0
    /\ failed = {} /\ calls = 1 /\ failOnce = FALSE

List ==
    /\ pc = "list"
    /\ listed' = IF Fixed THEN FirstK(Sorted({i \in Ids : i \notin sent /\ i > cursor}), Page)
                 ELSE FirstK(Sorted(Ids), Page)
    /\ idx' = 1 /\ pc' = "end"
    /\ UNCHANGED <<sent, cursor, failed, calls, failOnce>>

(* The next id of the page: a sent one is skipped; an owed one is ended   *)
(* (endAgentChild), or its end fails (once).                              *)
EndNext ==
    /\ pc = "end" /\ idx <= Len(listed)
    /\ LET i == listed[idx] IN
          \/ i \in sent /\ UNCHANGED <<sent, failed, failOnce>>
          \/ i \notin sent /\ sent' = sent \cup {i} /\ UNCHANGED <<failed, failOnce>>
          \/ /\ i \notin sent /\ AllowEndFail /\ ~failOnce
             /\ failed' = failed \cup {i} /\ failOnce' = TRUE /\ UNCHANGED sent
    /\ idx' = idx + 1
    /\ UNCHANGED <<pc, listed, cursor, calls>>

(* The page is done: 1c117a47 reads the next page after a full one.        *)
PageDone ==
    /\ pc = "end" /\ idx > Len(listed)
    /\ IF Fixed /\ Len(listed) = Page
         THEN pc' = "list" /\ cursor' = listed[Page]
         ELSE pc' = "done" /\ UNCHANGED cursor
    /\ UNCHANGED <<sent, listed, idx, failed, calls, failOnce>>

(* A call with a failed end fails; its activity retries it.               *)
Retry ==
    /\ pc = "done" /\ failed # {} /\ calls < MaxCalls
    /\ pc' = "list" /\ cursor' = 0 /\ failed' = {} /\ calls' = calls + 1
    /\ UNCHANGED <<sent, listed, idx, failOnce>>

Done ==
    /\ pc = "done" /\ (failed = {} \/ calls = MaxCalls)
    /\ UNCHANGED vars

Next == List \/ EndNext \/ PageDone \/ Retry \/ Done

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(List) /\ WF_vars(EndNext) /\ WF_vars(PageDone) /\ WF_vars(Retry)

----------------------------------------------------------------------------
TypeOK ==
    /\ sent \subseteq Ids /\ failed \subseteq Ids
    /\ pc \in {"list", "end", "done"}
    /\ idx \in 1..(Page + 1) /\ cursor \in 0..N /\ calls \in 1..MaxCalls /\ failOnce \in BOOLEAN

(* A call that ends without a failure ended every owed child.             *)
Inv_CleanCallEndsAll == (pc = "done" /\ failed = {}) => sent = Ids
(* Liveness: every owed child is ended.                                    *)
Prop_AllEnded == <>(sent = Ids)
(* The call ends.                                                          *)
Prop_CallEnds == <>(pc = "done")
=============================================================================
