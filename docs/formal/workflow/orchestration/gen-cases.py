#!/usr/bin/env python3
"""Writes cases.tsv, cases.json and tlc-templates.json from one table (no TLC is run here). The .cfg files are
generated from these by run-tlc.sh (../../tlc_cases.py)."""
import json, os
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", ".."))
import tlc_cases   # docs/formal/tlc_cases.py: the settings (.cfg) are generated from the tables, not committed

G_INV = ["TypeOK", "Inv_StepsBound", "Inv_EndedNothingPending", "Inv_ControllerEndsOnlyEndedRun", "Inv_CatchAllOnce",
         "Inv_JoinAccountsAll", "Inv_JoinedOnlyAllSucceeded", "Inv_NoProtocolFault", "Inv_BranchConfined",
         "Inv_NoAdmissionAfterStop", "Inv_ParallelBranchesBounded", "Inv_OneReport"]
A_INV = ["TypeOK", "Inv_NoCompletionAfterDeadline", "Inv_PromptOnce", "Inv_EndOnlyDecided", "Inv_EndMatchesWinner",
         "Inv_ChildOnlyFromAttempt"]
P_INV = ["TypeOK", "Inv_EndedIsLast", "Inv_GivenOnce", "Inv_NotifiedAccepted", "Inv_SkipMeansNotGiven",
         "Inv_NotifiedXorSkipped", "Inv_NoDecisionAfterExpiry"]
P_INV_D1 = [i for i in P_INV if i != "Inv_NotifiedAccepted"]
R_INV = ["TypeOK", "Inv_RecoverEndsOnlyDeadController", "Inv_ChildEndedOnlyAfterRunEnd", "Inv_NotifierOnlyForEndedRun"]
W_INV = ["TypeOK", "Inv_NoAdmissionWhilePaused", "Inv_NoChildAfterTimeoutRouted"]

def g(plan, limit, k=1, conc=1, ff=False, cancel=True, stop=True, pause=True, deadline=True, delete=True, fault="none",
      cmd="queue", lose=False):
    return dict(Plan=f'"{plan}"', Limit=limit, K=k, Conc=conc, FailFast=ff, AllowCancel=cancel, AllowStop=stop,
                AllowPause=pause, AllowDeadline=deadline, AllowDelete=delete, Cmd=f'"{cmd}"', AllowLoseHint=lose, Fault=f'"{fault}"')
def a(crashes=2, invalid=2, refuse=True, exhaust=False, endfail=False, evict=False, runend=True, ask=True, fault="none", head="efe44835",
      turnfail=False, report="none", dfair=True, recover=False):
    return dict(MaxCrashes=crashes, MaxInvalid=invalid, AllowRefuse=refuse, AllowExhaust=exhaust, AllowEndFail=endfail,
                AllowEvict=evict, AllowRunEnd=runend, AllowAsk=ask, Fault=f'"{fault}"', Code=f'"{head}"',
                AllowTurnFail=turnfail, Report=f'"{report}"', DeadlineFair=dfair, AllowRecover=recover)
def p(kind="send", flag="omitted", crashes=1, ext=False, pcancel=True, pend=False, fifo=False, evict=False, fault="none",
      back=False, turnfails=1, head="efe44835", wait=False, zombie=False, notifiers=1, statusrace=True, ntzombie=False,
      recover=False, maxrec=0, recafter=False):
    return dict(MKind=f'"{kind}"', StartFlag=f'"{flag}"', MaxCrashes=crashes, AllowExternalEnd=ext, AllowParentCancel=pcancel,
                AllowParentEnd=pend, AllowFifoFull=fifo, AllowEvict=evict, AllowClockBack=back, MaxTurnFails=turnfails,
                Fault=f'"{fault}"', AllowWaitTimeout=wait, AllowZombie=zombie, NumNotifiers=notifiers,
                AllowStatusRace=statusrace, AllowNtZombie=ntzombie, AllowRecover=recover, MaxRecovers=maxrec, RecoverAfterRelease=recafter, Code=f'"{head}"')
def el(n=3, tdfail=True, shutdown=True, revoke=True, end=True, fault="none", dep=False):
    return dict(N=n, Dep=dep, AllowTeardownFail=tdfail, AllowShutdown=shutdown, AllowRevoke=revoke, AllowScriptEnd=end, Fault=f'"{fault}"')
def es(n=3, tdfail=True, shutdown=True, revoke=True, end=True, fault="none", dep=False, head="proposedE1b",
       unsettled=False, unattr=False, boundary=False, listfail=False):
    return dict(el(n, tdfail, shutdown, revoke, end, fault, dep), Code=f'"{head}"', AllowUnsettled=unsettled,
                AllowUnattributed=unattr, AllowBoundary=boundary, AllowListingFail=listfail)
S_INV8 = ["TypeOK", "Inv_NoCallForClosedOwner", "Inv_NoCallOnForeignSession", "Inv_RunningOwnerHolds", "Inv_NoSetupAfterFailedTeardown", "Inv_NoOrphanBackground"]
S_INV = ["TypeOK", "Inv_NoCallForClosedOwner", "Inv_NoCallOnForeignSession", "Inv_RunningOwnerActive", "Inv_NoSetupAfterFailedTeardown", "Inv_NoOrphanBackground"]
L_INV = ["TypeOK", "Inv_OneHolder", "Inv_NoCallOnForeignSession", "Inv_NoSetupAfterFailedTeardown", "Inv_NoForeignBackground"]
def r(head="efe44835", deaths=1, dieat="run", recovers=2, exhaust=False, endfail=False):
    return dict(Code=f'"{head}"', MaxDeaths=deaths, DieAt=f'"{dieat}"', MaxRecovers=recovers,
                AllowNotifierExhaust=exhaust, AllowEndFail=endfail)
def pg(head="efe44835", n=3, page=2, settled="{1, 2}", endfail=False, calls=1):
    return dict(Code=f'"{head}"', N=n, Page=page, Settled=settled, AllowEndFail=endfail, MaxCalls=calls)
def w(head="efe44835", resume=False, complete=False, endfail=False, first=True):
    return dict(Code=f'"{head}"', AllowResume=resume, AllowChildComplete=complete, AllowEndFail=endfail, PauseFirst=first)
def x(head="efe44835", overlap=True):
    return dict(Code=f'"{head}"', Overlap=overlap)
FIX = "1f7bdc77"   # final head: 1c117a47 (groups A-C) + group D
D1 = "1f7bdc77"
E3 = "proposedE3"
D = "proposedD"
A10 = "a10c2e07"   # final head after batch E3 (181daa7c) and the WFO-2 end rule (a10c2e07)
E2 = "a99cd382"    # RT-6 paused path collects and ends children (E2)
E1B = "8dd3eae1"   # E1b as committed
E1C = "412f7b00"   # E1c: ownership by task id, check before execute, lease per share
E3B = "fc6d7a65"   # E3b: a held notice lock fails the attempt; the activity retries

# r3 (2026-11-09): WfGraph, WfParent, WfPaused and WfExecShare bound to 9a8d0f66. Each file replaces its helper
# (new constants default to the earlier behaviour) and defines its new cases.
HERE = os.path.dirname(os.path.abspath(__file__))
for _m in ("graph", "parent", "paused", "execshare"):
    exec(open(os.path.join(HERE, f"r3-{_m}.py")).read())
# r4 (2026-11-09): the r3 findings' fixes bound to the branch head a9f60db7 (R3_IMPL; batch "r4").
exec(open(os.path.join(HERE, "r3-impl.py")).read())
# tf1 (2026-11-10): an agent child's turn that fails terminally (TF_AGENT; batch "tf1").
exec(open(os.path.join(HERE, "tf-agent.py")).read())

# id, module, mode, spec, constants, invariants, properties, expected, note
CASES = [
 # ---- WfGraph: reviewed-code holds ----
 ("graph.linear", "WfGraph", "reviewed", "Spec", g("linear", 4), G_INV, [], "PASS", "Routes, an unrouted outcome, every run end."),
 ("graph.catch", "WfGraph", "reviewed", "Spec", g("catch", 4), G_INV, [], "PASS", "The catch-all state: entered once, by an unhandled error or an invalid terminal output."),
 ("graph.catch-route", "WfGraph", "reviewed", "Spec", g("catchf", 4), G_INV, [], "PASS", "An explicit failure route into the catch-all state, and the catch-all's own route back to it."),
 ("graph.loop-limit", "WfGraph", "reviewed", "Spec", g("loop", 4), G_INV, [], "PASS", "A loop ended by maxNodeExecutions."),
 ("graph.par-failfast", "WfGraph", "reviewed", "Spec", g("par", 7, 2, 1, True), G_INV, [], "PASS", "Two branches, one at a time, failFast."),
 ("graph.par-failfast-conc2", "WfGraph", "reviewed", "Spec", g("par", 7, 2, 2, True), G_INV, [], "PASS", "Two branches at once, failFast: one batch may hold both results."),
 ("graph.par-all", "WfGraph", "reviewed", "Spec", g("par", 7, 2, 2, False), G_INV, [], "PASS", "Two branches at once, every branch runs to its end."),
 ("graph.par-catch", "WfGraph", "reviewed", "Spec", g("parc", 7, 2, 2, True), G_INV, [], "PASS", "A parallel state in a workflow with a catch-all state."),
 ("graph.par-k3", "WfGraph", "reviewed", "Spec", g("par", 8, 3, 2, True, pause=False, delete=False, deadline=False), G_INV, [], "PASS", "Three branches, two at a time, failFast: a not-started branch."),
 # ---- WfGraph: liveness ----
 ("graph.live-linear", "WfGraph", "reviewed", "LiveSpec", g("linear", 4), [], ["Prop_ControllerEnds", "Prop_RunEnds"], "PASS", "Every run ends and its controller ends."),
 ("graph.live-loop", "WfGraph", "reviewed", "LiveSpec", g("loop", 4), [], ["Prop_ControllerEnds", "Prop_RunEnds"], "PASS", "A loop ends at its limit at the latest."),
 ("graph.live-par", "WfGraph", "reviewed", "LiveSpec", g("par", 7, 2, 1, True), [], ["Prop_ControllerEnds", "Prop_RunEnds"], "PASS", "A parallel run ends with every environment choice."),
 ("graph.live-par-all", "WfGraph", "reviewed", "LiveSpec", g("par", 7, 2, 2, False), [], ["Prop_ControllerEnds", "Prop_RunEnds"], "PASS", "Both branches at once, no failFast."),
 # ---- WfGraph: witnesses ----
 ("wit.graph-failfast-cancels", "WfGraph", "reviewed", "Spec", g("par", 7, 2, 2, True), ["Wit_FailFastCancels"], [], "safety", "failFast cancels a running branch."),
 ("wit.graph-dropped-skipped", "WfGraph", "reviewed", "Spec", g("par", 7, 2, 2, True), ["Wit_DroppedResultSkipped"], [], "safety", "A dropped branch's result is in the batch being routed."),
 ("wit.graph-join-blocked", "WfGraph", "reviewed", "Spec", g("par", 7, 2, 2, False), ["Wit_JoinBlocked"], [], "safety", "A join is blocked."),
 ("wit.graph-joined", "WfGraph", "reviewed", "Spec", g("par", 7, 2, 2, False), ["Wit_Joined"], [], "safety", "A join succeeds."),
 ("wit.graph-limit", "WfGraph", "reviewed", "Spec", g("loop", 3), ["Wit_LimitEnds"], [], "safety", "The limit ends the run."),
 ("wit.graph-catchall", "WfGraph", "reviewed", "Spec", g("catch", 4), ["Wit_CatchAllEntered"], [], "safety", "The catch-all state is entered."),
 ("wit.graph-stopped-with-work", "WfGraph", "reviewed", "Spec", g("par", 7, 2, 2, True), ["Wit_StoppedWithWork"], [], "safety", "A stop ends a run with work still pending."),
 # ---- WfGraph: planned breaks ----
 ("fault.graph-no-limit", "WfGraph", "deliberate", "Spec", g("loop", 3, fault="no_limit"), ["Inv_StepsBound"], [], "safety", "Without the limit check."),
 ("fault.graph-branch-catchall", "WfGraph", "deliberate", "Spec", g("parc", 7, 2, 2, True, fault="branch_catchall"), ["Inv_BranchConfined"], [], "safety", "A branch's unrouted error goes to the catch-all."),
 ("fault.graph-join-early", "WfGraph", "deliberate", "Spec", g("par", 7, 2, 2, False, fault="join_early"), ["Inv_JoinAccountsAll"], [], "safety", "The join is called before every branch ended."),
 ("fault.graph-no-dropped", "WfGraph", "deliberate", "Spec", g("par", 7, 2, 2, True, fault="no_dropped"), ["Inv_NoProtocolFault"], [], "safety", "The dropped set is not consulted."),
 ("fault.graph-catchall-twice", "WfGraph", "deliberate", "Spec", g("catchf", 4, fault="catchall_twice"), ["Inv_CatchAllOnce"], [], "safety", "The catch-all state is entered again."),
 ("fault.graph-store-admits-stopping", "WfGraph", "deliberate", "Spec", g("linear", 4, fault="store_admits_stopping"), ["Inv_NoAdmissionAfterStop"], [], "safety", "The store admits a node of a stopping run."),
 # ---- WfAgent ----
 ("agent.safety", "WfAgent", "reviewed", "Spec", a(exhaust=True, endfail=True), A_INV, [], "PASS", "Every agent-state safety rule, with crashes, refusals, exhausted spawns and failed ends."),
 ("agent.live", "WfAgent", "reviewed", "LiveSpec", a(), [], ["Prop_StateDecided", "Prop_ChildReleased"], "PASS", "The state is decided and its child ends, with crashes and refusals."),
 ("agent.exhausted-orphan", "WfAgent", "reviewed", "LiveSpec", a(exhaust=True), [], ["Prop_ChildReleased"], "liveness", "Every spawn attempt after the child's creation fails."),
 ("agent.end-fails", "WfAgent", "reviewed", "LiveSpec", a(endfail=True), [], ["Prop_ChildReleased"], "liveness", "Both end commands fail (design limit: best effort, traced)."),
 ("agent.prompt-evicted", "WfAgent", "reviewed", "Spec", a(evict=True), ["Inv_PromptOnce"], [], "safety", "The child's 20-id window forgot the prompt's id before a retry."),
 ("wit.agent-completes", "WfAgent", "reviewed", "Spec", a(), ["Wit_ChildCompletes"], [], "safety", "The child completes its state."),
 ("wit.agent-timed-out-ended", "WfAgent", "reviewed", "Spec", a(), ["Wit_TimedOutChildEnded"], [], "safety", "A timed-out state's child is ended."),
 ("wit.agent-spawn-after-decision", "WfAgent", "reviewed", "Spec", a(), ["Wit_SpawnAfterDecision"], [], "safety", "A child created after its state was decided is ended."),
 ("wit.agent-invalid-exhausted", "WfAgent", "reviewed", "Spec", a(), ["Wit_InvalidExhausted"], [], "safety", "Invalid completions spend the correction budget."),
 ("fault.agent-no-end-after-spawn", "WfAgent", "deliberate", "LiveSpec", a(fault="no_end_after_spawn"), [], ["Prop_ChildReleased"], "liveness", "The spawn does not end a child created after the decision."),
 ("fault.agent-end-ignores-spawn", "WfAgent", "deliberate", "LiveSpec", a(fault="end_ignores_spawn"), [], ["Prop_ChildReleased"], "liveness", "The end after a spawn is skipped once an end was marked."),
 ("fault.agent-accept-late", "WfAgent", "deliberate", "Spec", a(fault="accept_after_deadline"), ["Inv_NoCompletionAfterDeadline"], [], "safety", "A completion is accepted past the deadline."),
 # ---- WfParent ----
 ("parent.safety", "WfParent", "reviewed", "Spec", p(), P_INV, [], "PASS", "The controller ends the run: the parent gets the message, then the end, once each."),
 ("parent.safety-request", "WfParent", "reviewed", "Spec", p("request", pcancel=False), P_INV, [], "safety", "The same with a request: its own deadline opens the WFO-1 gap (r1: predicted PASS, failed)."),
 ("parent.live-default-on", "WfParent", "reviewed", "LiveSpec", p(ext=True, pend=True), [], ["Prop_ParentLearnsEnd"], "PASS", "Notifications on by default (fe01b956): the parent learns the end."),
 ("parent.live-off", "WfParent", "reviewed", "LiveSpec", p(flag="false", ext=True, pend=True), [], ["Prop_ParentLearnsEnd"], "PASS", "Notifications off: the skip is recorded (61a622c2)."),
 ("parent.late-message", "WfParent", "reviewed", "Spec", p(ext=True), ["Inv_EndedIsLast"], [], "safety", "Another end while the send's delivery is between its begin and its enqueue."),
 ("parent.late-request", "WfParent", "reviewed", "Spec", p("request", ext=True), ["Inv_EndedIsLast"], [], "safety", "The same for a request: the parent is given it after the run's end."),
 ("wit.parent-answer-expired", "WfParent", "reviewed", "Spec", p("request", pcancel=False), ["Wit_AnswerExpired"], [], "safety", "The parent answers a pending request after the store's clock passed its deadline (REQUEST_EXPIRED)."),
 ("wit.parent-answer-closed", "WfParent", "reviewed", "Spec", p("request", ext=True, pcancel=False), ["Wit_AnswerClosed"], [], "safety", "The parent answers a request of a run that ended (REQUEST_CLOSED)."),
 ("wit.parent-answer-after-timeout", "WfParent", "reviewed", "Spec", p("request", pcancel=False), ["Wit_AnswerAfterTimeout"], [], "safety", "The parent answers a request the elapse decided timed_out (REQUEST_CLOSED, not EXPIRED; FR-4)."),
 ("wit.parent-answer-early", "WfParent", "reviewed", "Spec", p("request", pcancel=False), ["Wit_AnswerEarly"], [], "safety", "The parent's answer is accepted before the delivery was recorded (MF-1, FR-4)."),
 ("parent.expiry-durable", "WfParent", "reviewed", "Spec", p("request", pcancel=False, evict=True, back=True), ["Inv_NoDecisionAfterExpiry"], [], "PASS", "A bound expiry stands although the store's clock steps back and a second copy is answered."),
 ("parent.notified-lost", "WfParent", "reviewed", "Spec", p(pend=True), ["Inv_NotifiedAccepted"], [], "safety", "The parent ends between the authority read and the enqueue."),
 ("parent.fifo-lost", "WfParent", "reviewed", "LiveSpec", p(fifo=True), [], ["Prop_ParentLearnsEnd"], "liveness", "The parent's FIFO is full when the end arrives."),
 ("parent.skip-after-given", "WfParent", "reviewed", "Spec", p(pend=True), ["Inv_SkipMeansNotGiven"], [], "safety", "A retry after the parent ended records a skip of an end it was given."),
 ("parent.evicted-duplicate", "WfParent", "reviewed", "Spec", p(evict=True), ["Inv_GivenOnce"], [], "safety", "20 other messages between two copies (design limit)."),
 ("wit.parent-message-then-end", "WfParent", "reviewed", "Spec", p(), ["Wit_GivenMessageThenEnd"], [], "safety", "The normal order."),
 ("wit.parent-skip-recorded", "WfParent", "reviewed", "Spec", p(flag="false"), ["Wit_SkipRecorded"], [], "safety", "notify_on_completion false records the skip."),
 ("fault.parent-no-prior-check", "WfParent", "deliberate", "Spec", p(pend=True, fault="no_prior_check"), ["Inv_NotifiedXorSkipped"], [], "safety", "Without the per-run event check."),
 ("fault.parent-no-window", "WfParent", "deliberate", "Spec", p(fault="no_window"), ["Inv_GivenOnce"], [], "safety", "Without the parent's duplicate check."),
 ("fault.parent-no-durable-expiry", "WfParent", "deliberate", "Spec", p("request", pcancel=False, evict=True, back=True, fault="no_durable_expiry"), ["Inv_NoDecisionAfterExpiry"], [], "safety", "Without the durable expiry: a stepped-back clock lets a later copy be answered."),
 # ---- WfParent: group D fixes as proposed (WFO-1, WFO-3, WFO-4) ----
 ("parent.safety-request-D", "WfParent", "reviewed", "Spec", p("request", pcancel=False, head=D), P_INV, [], "PASS", "parent.safety-request with the proposed WFO-1 fix."),
 ("parent.late-message-D", "WfParent", "reviewed", "Spec", p(ext=True, head=D), ["Inv_EndedIsLast"], [], "PASS", "parent.late-message with the proposed WFO-1 fix."),
 ("parent.notified-lost-D", "WfParent", "reviewed", "Spec", p(pend=True, head=D), ["Inv_NotifiedAccepted"], [], "PASS", "parent.notified-lost with the proposed WFO-3 fix."),
 ("parent.skip-after-given-D", "WfParent", "reviewed", "Spec", p(pend=True, head=D), ["Inv_SkipMeansNotGiven"], [], "PASS", "parent.skip-after-given with the proposed WFO-4 fix."),
 ("parent.safety-D", "WfParent", "reviewed", "Spec", p("request", ext=True, pend=True, back=True, head=D), P_INV, [], "PASS", "Every parent rule with the proposed group D fixes, other ends, the parent's end and clock steps."),
 ("parent.live-D", "WfParent", "reviewed", "LiveSpec", p("request", ext=True, pend=True, head=D), [], ["Prop_ParentLearnsEnd"], "PASS", "The parent still learns the end with the proposed group D fixes."),
 # ---- WfAgent: group D fix as proposed (WFO-2) ----
 ("agent.exhausted-orphan-D", "WfAgent", "reviewed", "LiveSpec", a(exhaust=True, head=D), [], ["Prop_ChildReleased"], "PASS", "agent.exhausted-orphan with the proposed WFO-2 fix."),
 ("agent.safety-D", "WfAgent", "reviewed", "Spec", a(exhaust=True, endfail=True, head=D), A_INV, [], "PASS", "Every agent-state safety rule with the proposed WFO-2 fix."),
 ("agent.live-D", "WfAgent", "reviewed", "LiveSpec", a(head=D), [], ["Prop_StateDecided", "Prop_ChildReleased"], "PASS", "agent.live with the proposed WFO-2 fix."),
 # ---- group D as committed at 1f7bdc77 ----
 ("parent.late-message-1f7", "WfParent", "reviewed", "Spec", p(ext=True, head=D1, wait=True), ["Inv_EndedIsLast"], [], "safety", "WFO-1 at 1f7bdc77: a delivery that outlasts the notice's bounded wait still lands after the end (documented bound)."),
 ("parent.late-message-1f7-bound", "WfParent", "reviewed", "Spec", p(ext=True, head=D1), ["Inv_EndedIsLast"], [], "PASS", "WFO-1 at 1f7bdc77: every delivery in flight is recorded or fails within the wait's bound."),
 ("parent.late-request-1f7-bound", "WfParent", "reviewed", "Spec", p("request", ext=True, head=D1), ["Inv_EndedIsLast"], [], "PASS", "WFO-1 at 1f7bdc77 for a request (counted in flight too), within the bound."),
 ("parent.safety-request-1f7", "WfParent", "reviewed", "Spec", p("request", pcancel=False, head=D1, wait=True), P_INV, [], "safety", "parent.safety-request at 1f7bdc77 when the wait gives up (documented bound)."),
 ("parent.safety-request-1f7-bound", "WfParent", "reviewed", "Spec", p("request", pcancel=False, head=D1), P_INV, [], "PASS", "parent.safety-request at 1f7bdc77 within the wait's bound."),
 ("parent.notified-lost-1f7", "WfParent", "reviewed", "Spec", p(pend=True, head=D1), ["Inv_NotifiedAccepted"], [], "safety", "WFO-3 at 1f7bdc77: the parent ends between the status read and the enqueue (the race that remains)."),
 ("parent.skip-after-given-1f7", "WfParent", "reviewed", "Spec", p(pend=True, head=D1), ["Inv_SkipMeansNotGiven"], [], "PASS", "WFO-4 at 1f7bdc77: a retry after parent_notifying never records a skip."),
 ("parent.told-by-earlier-1f7", "WfParent", "reviewed", "Spec", p(pend=True, head=D1), ["Inv_ToldMeansAccepted"], [], "safety", "WFO-4 at 1f7bdc77: a crash between parent_notifying and the enqueue, then the parent ends: told byEarlierAttempt, nothing queued."),
 ("wit.parent-told-by-earlier", "WfParent", "reviewed", "Spec", p(pend=True, head=D1), ["Wit_ToldByEarlier"], [], "safety", "1f7bdc77 records parent_notified byEarlierAttempt."),
 ("parent.safety-1f7", "WfParent", "reviewed", "Spec", p("request", ext=True, pend=True, back=True, head=D1), ["TypeOK", "Inv_EndedIsLast", "Inv_GivenOnce", "Inv_SkipMeansNotGiven", "Inv_NotifiedXorSkipped", "Inv_NoDecisionAfterExpiry"], [], "PASS", "Every parent rule but notified-accepted at 1f7bdc77 within the wait's bound, with other ends, the parent's end and clock steps."),
 ("parent.live-1f7", "WfParent", "reviewed", "LiveSpec", p("request", ext=True, pend=True, head=D1, wait=True), [], ["Prop_ParentLearnsEnd"], "PASS", "The parent still learns the end at 1f7bdc77."),
 ("agent.exhausted-orphan-1f7", "WfAgent", "reviewed", "LiveSpec", a(exhaust=True, head=D1), [], ["Prop_ChildReleased"], "PASS", "WFO-2 at 1f7bdc77: agentSpawnFailed ends the child an attempt created."),
 ("agent.safety-1f7", "WfAgent", "reviewed", "Spec", a(exhaust=True, endfail=True, head=D1), A_INV, [], "PASS", "Every agent-state safety rule at 1f7bdc77."),
 ("agent.live-1f7", "WfAgent", "reviewed", "LiveSpec", a(head=D1), [], ["Prop_StateDecided", "Prop_ChildReleased"], "PASS", "agent.live at 1f7bdc77 (a spawn that never created a child leaves its row owed, and nothing to end)."),
 ("wit.agent-second-end", "WfAgent", "reviewed", "Spec", a(head=D1), ["Wit_SecondEndCommand"], [], "safety", "A child gets a second end command with the same id (also at efe44835: the end after a spawn)."),
 # ---- r2c: verification of group D (failed-row race, concurrent notifiers, D-R1) and batch E3 as proposed ----
 ("parent.zombie-1f7", "WfParent", "reviewed", "Spec", p(ext=True, head=D1, zombie=True), ["Inv_EndedIsLast"], [], "safety", "WFO-1 at 1f7bdc77: a retry fails the outbox row while the first attempt's enqueue still runs; the count drops to 0 and M lands after E."),
 ("parent.concurrent-1f7", "WfParent", "reviewed", "Spec", p(pend=True, head=D1, notifiers=2), ["Inv_SkipMeansNotGiven", "Inv_NotifiedXorSkipped"], [], "safety", "WFO-4 at 1f7bdc77: two notifier instances both read attempted false; one queues the end, the other records a skip."),
 ("parent.zombie-E3", "WfParent", "reviewed", "Spec", p(ext=True, head=E3, zombie=True), ["Inv_EndedIsLast"], [], "PASS", "proposedE3: rows decided after a recent attempt are counted; the zombie enqueue lands within the bound."),
 ("parent.zombie-E3-timeout", "WfParent", "reviewed", "Spec", p(ext=True, head=E3, zombie=True, wait=True), ["Inv_EndedIsLast"], [], "safety", "proposedE3: a zombie enqueue slower than the 15 s bound still lands after the end (documented bound)."),
 ("parent.concurrent-E3", "WfParent", "reviewed", "Spec", p(pend=True, head=E3, notifiers=2), ["Inv_SkipMeansNotGiven", "Inv_NotifiedXorSkipped"], [], "PASS", "proposedE3: the per-run lock serializes the two notifier instances."),
 ("parent.told-by-earlier-E3", "WfParent", "reviewed", "Spec", p(pend=True, head=E3), ["Inv_ToldMeansAccepted"], [], "safety", "D-R1 under proposedE3 (a proposal, never code): the case keeps the WFO-3 status-read race, so the parent can end between the status read and the enqueue and the notice is recorded as told; expected corrected from PASS (the README's prediction correction; parent.told-by-earlier-e3-norace isolates D-R1)."),
 ("parent.notified-lost-E3", "WfParent", "reviewed", "Spec", p(pend=True, head=E3), ["Inv_NotifiedAccepted"], [], "safety", "proposedE3 leaves the status-read race of WFO-3 as it is."),
 ("parent.safety-E3", "WfParent", "reviewed", "Spec", p("request", ext=True, pend=True, back=True, head=E3, zombie=True, notifiers=2), ["TypeOK", "Inv_EndedIsLast", "Inv_GivenOnce", "Inv_SkipMeansNotGiven", "Inv_NotifiedXorSkipped", "Inv_NoDecisionAfterExpiry"], [], "PASS", "Every parent rule but the accepted-copy rules under proposedE3, with a zombie enqueue and two notifier instances."),
 ("parent.live-E3", "WfParent", "reviewed", "LiveSpec", p("request", ext=True, pend=True, head=E3, wait=True, zombie=True, notifiers=2), [], ["Prop_ParentLearnsEnd"], "PASS", "The parent still learns the end under proposedE3."),
 # ---- WfExecLease (E1 0c3b4ceb: the exclusive native tool session) ----
 ("exec.e1-safety", "WfExecLease", "reviewed", "Spec", el(), L_INV, [], "PASS", "E1 at 0c3b4ceb: one holder; calls only on its own session; no setup after a failed teardown; no foreign background work."),
 ("exec.e1-live", "WfExecLease", "reviewed", "LiveSpec", el(), [], ["Prop_WaitersServed"], "PASS", "E1 at 0c3b4ceb: every waiter is served, refused or aborted, with scripts that end."),
 ("wit.exec-e1-after-abort", "WfExecLease", "reviewed", "Spec", el(), ["Wit_ServedAfterAbort"], [], "safety", "A waiter behind an aborted one is served after the holder."),
 ("fault.exec-e1-link-skips-aborted", "WfExecLease", "deliberate", "Spec", el(fault="link_skips_aborted"), ["Inv_OneHolder"], [], "safety", "An aborted waiter's link resolves at once: the next waiter holds beside the holder."),
 ("fault.exec-e1-no-recheck", "WfExecLease", "deliberate", "Spec", el(fault="no_recheck_after_wait"), ["Inv_NoSetupAfterFailedTeardown"], [], "safety", "No check after the wait: setup after a failed teardown (VR-2)."),
 ("exec.e1-dep", "WfExecLease", "reviewed", "LiveSpec", el(n=2, dep=True, tdfail=False, shutdown=False, revoke=False, end=False), [], ["Prop_BothComplete"], "liveness", "E1-R1 at 0c3b4ceb: the holder waits for its sibling's first call, which waits for the lease."),
 # ---- WfExecShare (E1b as proposed: shared session, one call at a time) ----
 ("exec.e1b-safety", "WfExecShare", "reviewed", "Spec", es(), S_INV, [], "PASS", "E1b as proposed: dequeue re-checks, own-call abort, release after calls settle, background cancel per owner, barrier re-checked."),
 ("exec.e1b-live", "WfExecShare", "reviewed", "LiveSpec", es(), [], ["Prop_WaitersServed"], "PASS", "E1b as proposed: every waiter is served, refused or aborted."),
 ("exec.e1b-dep", "WfExecShare", "reviewed", "LiveSpec", es(n=2, dep=True, tdfail=False, shutdown=False, revoke=False, end=False), [], ["Prop_BothComplete"], "PASS", "E1b as proposed: the sibling dependency of exec.e1-dep completes."),
 ("fault.exec-e1b-no-dequeue-recheck", "WfExecShare", "deliberate", "Spec", es(fault="no_dequeue_recheck"), ["Inv_NoCallForClosedOwner"], [], "safety", "Without the dequeue re-check, a closed or revoked owner's queued call runs (VR-1)."),
 ("fault.exec-e1b-no-barrier-recheck", "WfExecShare", "deliberate", "Spec", es(fault="no_barrier_recheck"), ["Inv_NoSetupAfterFailedTeardown"], [], "safety", "Without the barrier re-check after the wait, setup follows a failed teardown (VR-2)."),
 # ---- WfRecover (FR-1; RT-3, RT-4) ----
 ("recover.rt3-efe", "WfRecover", "reviewed", "LiveSpec", r(), [], ["Prop_ChildReleased"], "liveness", "RT-3 at efe44835: a recover ends the run, and its agent child is never ended."),
 ("recover.rt3-fixed", "WfRecover", "reviewed", "LiveSpec", r(FIX, endfail=True), [], ["Prop_RunEnds", "Prop_ChildReleased", "Prop_NoticePaid"], "PASS", "RT-3 at 1c117a47: the recover ends the child; a failed end is ended by the next recover."),
 ("recover.rt4-efe", "WfRecover", "reviewed", "LiveSpec", r(dieat="any"), [], ["Prop_NoticePaid"], "liveness", "RT-4 at efe44835: the controller dies after the terminal commit; no recover tells the parent."),
 ("recover.rt4-fixed", "WfRecover", "reviewed", "LiveSpec", r(FIX, dieat="any"), [], ["Prop_RunEnds", "Prop_ChildReleased", "Prop_NoticePaid"], "PASS", "RT-4 at 1c117a47: a recover pays the notice and child debts of any terminal run."),
 ("recover.rt4-exhaust-efe", "WfRecover", "reviewed", "LiveSpec", r(exhaust=True), [], ["Prop_NoticePaid"], "liveness", "RT-4 at efe44835: the recovered run's notifier runs out of attempts; a second start of it is ignored."),
 ("recover.rt4-exhaust-fixed", "WfRecover", "reviewed", "LiveSpec", r(FIX, dieat="any", exhaust=True, endfail=True), [], ["Prop_RunEnds", "Prop_ChildReleased", "Prop_NoticePaid"], "PASS", "RT-4 at 1c117a47: a later recover starts a notifier named for its operation id."),
 ("recover.nodeath-efe", "WfRecover", "reviewed", "LiveSpec", r(deaths=0), [], ["Prop_RunEnds", "Prop_ChildReleased", "Prop_NoticePaid"], "PASS", "Control: with no controller death, efe44835 pays every debt."),
 ("recover.safety-efe", "WfRecover", "reviewed", "Spec", r(dieat="any", exhaust=True), R_INV, [], "PASS", "Recover safety at efe44835."),
 ("recover.safety-fixed", "WfRecover", "reviewed", "Spec", r(FIX, dieat="any", exhaust=True, endfail=True), R_INV, [], "PASS", "Recover safety at 1c117a47."),
 ("wit.recover-ends-run", "WfRecover", "reviewed", "Spec", r(FIX), ["Wit_RecoverEnds"], [], "safety", "A recover ends a run whose controller died."),
 ("wit.recover-named-notifier", "WfRecover", "reviewed", "Spec", r(FIX, exhaust=True), ["Wit_RecoverNamedNotifier"], [], "safety", "A recover's own notifier tells the parent."),
 # ---- WfPaging (FR-3; RT-5) ----
 ("paging.rt5-efe", "WfPaging", "reviewed", "Spec", pg(), ["TypeOK", "Inv_CleanCallEndsAll"], [], "safety", "RT-5 at efe44835: a settled first page hides the owed third child (200 settled, 201st owed)."),
 ("paging.rt5-fixed", "WfPaging", "reviewed", "Spec", pg(FIX), ["TypeOK", "Inv_CleanCallEndsAll"], [], "PASS", "RT-5 at 1c117a47: only owed invocations are listed, page after page."),
 ("paging.rt5-fixed-live", "WfPaging", "reviewed", "LiveSpec", pg(FIX, settled="{}", endfail=True, calls=2), [], ["Prop_AllEnded", "Prop_CallEnds"], "PASS", "1c117a47: three owed children over two pages, one failed end retried."),
 ("paging.one-page-efe", "WfPaging", "reviewed", "Spec", pg(n=2, settled="{1}"), ["TypeOK", "Inv_CleanCallEndsAll"], [], "PASS", "Control: at efe44835 a run within one page is cleaned."),
 # ---- WfPaused (FR-2; RT-6) ----
 ("paused.rt6-efe", "WfPaused", "reviewed", "LiveSpec", w(), [], ["Prop_DeadlineEnforced"], "liveness", "RT-6 at efe44835: a permanently paused run with a ready branch never elapses the other branch's deadline."),
 ("paused.rt6-fixed", "WfPaused", "reviewed", "LiveSpec", w(FIX), [], ["Prop_DeadlineEnforced", "Prop_TimedOutChildEnded"], "PASS", "RT-6 at 1c117a47: the paused path elapses the state and ends its child."),
 ("paused.fixed-any", "WfPaused", "reviewed", "LiveSpec", w(FIX, resume=True, complete=True, first=False), [], ["Prop_DeadlineEnforced", "Prop_TimedOutChildEnded"], "PASS", "1c117a47 with the pause at any time, a resume and the child's own completion."),
 ("paused.safety-efe", "WfPaused", "reviewed", "Spec", w(resume=True, complete=True, endfail=True, first=False), W_INV, [], "PASS", "No admission while paused, efe44835."),
 ("paused.safety-fixed", "WfPaused", "reviewed", "Spec", w(FIX, resume=True, complete=True, endfail=True, first=False), W_INV, [], "PASS", "No admission while paused, 1c117a47."),
 ("paused.end-fails-fixed", "WfPaused", "reviewed", "LiveSpec", w(FIX, endfail=True), [], ["Prop_TimedOutChildEnded"], "liveness", "1c117a47 residual: an end that fails on the paused path is not retried while paused."),
 ("paused.done-child", "WfPaused", "reviewed", "LiveSpec", w(FIX, complete=True), [], ["Prop_DoneChildEnded"], "liveness", "Design question: a child that completed its state while the run is paused is ended only after the resume."),
 ("wit.paused-elapse", "WfPaused", "reviewed", "Spec", w(FIX), ["Wit_PausedElapse"], [], "safety", "The paused path elapses a state and ends its child before any routing."),
 # ---- WfExecutor (FR-5; RT-2) ----
 ("exec.rt2-refused-efe", "WfExecutor", "reviewed", "Spec", x(), ["Inv_NoRefusal"], [], "safety", "RT-2 at efe44835: the second parallel script state is refused."),
 ("exec.rt2-destroyed-efe", "WfExecutor", "reviewed", "Spec", x(), ["Inv_NoBrokenCall"], [], "safety", "RT-2 at efe44835: one state's close destroys the native session the other uses."),
 ("exec.rt2-fixed", "WfExecutor", "reviewed", "Spec", x(FIX), ["TypeOK", "Inv_NoRefusal", "Inv_NoBrokenCall"], [], "PASS", "RT-2 at 1c117a47: the share is reserved, shared and torn down by the last close."),
 ("exec.rt2-fixed-live", "WfExecutor", "reviewed", "LiveSpec", x(FIX), [], ["Prop_BothDone"], "PASS", "1c117a47: both states finish their tool call."),
 ("exec.sequential-efe", "WfExecutor", "reviewed", "Spec", x(overlap=False), ["TypeOK", "Inv_NoRefusal", "Inv_NoBrokenCall"], [], "PASS", "Control: one state after the other works at efe44835."),
 ("wit.exec-shared", "WfExecutor", "reviewed", "Spec", x(FIX), ["Wit_Shared"], [], "safety", "Both executors hold the shared native session at once."),
 # ======== r2e (after r2d): batch E3, E2 and E1b as committed ========
 # ---- WfParent a10c2e07 (batch E3 as committed: 181daa7c) ----
 ("parent.zombie-holder-a10", "WfParent", "reviewed", "LiveSpec", p(pcancel=False, head=A10, ntzombie=True), [], ["Prop_ParentLearnsEnd"], "liveness", "a10c2e07: an attempt that timed out holds the lock; the retry returns at the lock; the holder fails before its enqueue; no recover."),
 ("parent.zombie-holder-recover-a10", "WfParent", "reviewed", "LiveSpec", p(pcancel=False, head=A10, ntzombie=True, notifiers=2, recover=True, maxrec=3), [], ["Prop_ParentLearnsEnd"], "liveness", "a10c2e07: the same, and recover starts the notifier again while the notice is owed. Expected corrected from PASS: all three recovers can be spent while the timed-out holder still holds the notice lock, so no later attempt pays the notice (the code's limit at a10c2e07; r2g's parent.zombie-holder-recover-late-a10 recovers after the holder failed)."),
 ("parent.safety-a10", "WfParent", "reviewed", "Spec", p("request", ext=True, pend=True, back=True, zombie=True, notifiers=2, ntzombie=True, head=A10), P_INV_D1, [], "PASS", "Every parent rule but notified-accepted at a10c2e07: a delivery zombie, a concurrent notifier, a timed-out lock holder, other ends, the parent's end, clock steps."),
 ("parent.live-a10", "WfParent", "reviewed", "LiveSpec", p("request", ext=True, pend=True, wait=True, zombie=True, notifiers=2, head=A10), [], ["Prop_ParentLearnsEnd"], "PASS", "a10c2e07: the parent learns the end, with a concurrent notifier, crashes and the wait's bound."),
 ("parent.concurrent-a10", "WfParent", "reviewed", "Spec", p(pend=True, notifiers=2, head=A10), ["Inv_SkipMeansNotGiven", "Inv_NotifiedXorSkipped"], [], "PASS", "a10c2e07: two notifier instances; the try-lock lets one tell the parent."),
 ("parent.told-by-earlier-a10", "WfParent", "reviewed", "Spec", p(pend=True, statusrace=False, head=A10), ["Inv_ToldMeansAccepted"], [], "PASS", "D-R1 at a10c2e07, the status race excluded: a marker and a known refusal record a skip with earlierAttempt."),
 ("parent.told-by-earlier-1f7-norace", "WfParent", "reviewed", "Spec", p(pend=True, statusrace=False, head=FIX), ["Inv_ToldMeansAccepted"], [], "safety", "D-R1 at 1f7bdc77 alone (the status race excluded): told byEarlierAttempt with nothing queued."),
 ("parent.told-by-earlier-E3-norace", "WfParent", "reviewed", "Spec", p(pend=True, statusrace=False, head=E3), ["Inv_ToldMeansAccepted"], [], "PASS", "D-R1 under proposedE3 with the status race excluded (r2d's told-by-earlier-E3 did not exclude it)."),
 ("parent.notified-lost-a10", "WfParent", "reviewed", "Spec", p(pend=True, head=A10), ["Inv_NotifiedAccepted"], [], "safety", "a10c2e07 keeps WFO-3's race: the parent ends between the status read and the enqueue."),
 ("parent.zombie-a10", "WfParent", "reviewed", "Spec", p(ext=True, zombie=True, head=A10), ["Inv_EndedIsLast"], [], "PASS", "WFO-1 at a10c2e07: the count of failed rows keeps a zombie enqueue in front of the end, within the bound."),
 ("parent.zombie-a10-timeout", "WfParent", "reviewed", "Spec", p(ext=True, zombie=True, wait=True, head=A10), ["Inv_EndedIsLast"], [], "safety", "WFO-1 at a10c2e07: an enqueue slower than the 15 s wait still lands after the end (documented bound)."),
 ("wit.parent-skip-earlier-a10", "WfParent", "reviewed", "Spec", p(pend=True, head=A10), ["Wit_SkipEarlier"], [], "safety", "a10c2e07 records a skip with earlierAttempt."),
 # ---- WfAgent a10c2e07 (the end after a spawn only after NotFound) ----
 ("agent.safety-a10", "WfAgent", "reviewed", "Spec", a(exhaust=True, endfail=True, head=A10), A_INV, [], "PASS", "Every agent-state safety rule at a10c2e07."),
 ("agent.live-a10", "WfAgent", "reviewed", "LiveSpec", a(head=A10), [], ["Prop_StateDecided", "Prop_ChildReleased"], "PASS", "agent.live at a10c2e07."),
 ("agent.exhausted-orphan-a10", "WfAgent", "reviewed", "LiveSpec", a(exhaust=True, head=A10), [], ["Prop_ChildReleased"], "PASS", "WFO-2 at a10c2e07: a child an attempt created is still ended."),
 ("agent.second-end-a10", "WfAgent", "reviewed", "Spec", a(exhaust=True, head=A10), ["Wit_SecondEndCommand"], [], "PASS", "a10c2e07: no child gets a second end command (wit.agent-second-end breaks at 1f7bdc77)."),
 # ---- WfPaused a99cd382 (E2) ----
 ("paused.rt6-a99", "WfPaused", "reviewed", "LiveSpec", w(E2), [], ["Prop_DeadlineEnforced", "Prop_TimedOutChildEnded"], "PASS", "RT-6 at a99cd382: the paused path elapses the state; its collection ends the child."),
 ("paused.end-fails-a99", "WfPaused", "reviewed", "LiveSpec", w(E2, endfail=True), [], ["Prop_TimedOutChildEnded"], "PASS", "a99cd382: a failed end is tried again at the next paused wake (paused.end-fails-fixed breaks at 1f7bdc77)."),
 ("paused.done-child-a99", "WfPaused", "reviewed", "LiveSpec", w(E2, complete=True), [], ["Prop_DoneChildEnded"], "PASS", "a99cd382: a child that completed while paused is ended while paused (paused.done-child breaks at 1f7bdc77)."),
 ("paused.done-end-fails-a99", "WfPaused", "reviewed", "LiveSpec", w(E2, complete=True, endfail=True), [], ["Prop_DoneChildEnded"], "PASS", "a99cd382: the same with a failed end, tried again."),
 ("paused.safety-a99", "WfPaused", "reviewed", "Spec", w(E2, resume=True, complete=True, endfail=True, first=False), W_INV, [], "PASS", "No admission while paused, a99cd382."),
 ("paused.any-a99", "WfPaused", "reviewed", "LiveSpec", w(E2, resume=True, complete=True, first=False), [], ["Prop_DeadlineEnforced", "Prop_TimedOutChildEnded", "Prop_DoneChildEnded"], "PASS", "a99cd382 with the pause at any time, a resume and the child's completion."),
 ("wit.paused-done-ended-a99", "WfPaused", "reviewed", "Spec", w(E2, complete=True), ["Wit_PausedDoneEnded"], [], "safety", "a99cd382 ends a completed state's child while the run is still paused."),
 # ---- WfExecShare 8dd3eae1 (E1b as committed) ----
 ("exec.e1b-8dd-safety", "WfExecShare", "reviewed", "Spec", es(head=E1B, unsettled=True), S_INV8, [], "PASS", "E1b at 8dd3eae1: turn checks, close while queued and while running, an abort that does not settle, per-owner cancel, the barrier."),
 ("exec.e1b-8dd-live", "WfExecShare", "reviewed", "LiveSpec", es(head=E1B, unsettled=True), [], ["Prop_WaitersServed"], "PASS", "E1b at 8dd3eae1: every waiter is served, refused or aborted."),
 ("exec.e1b-8dd-dep", "WfExecShare", "reviewed", "LiveSpec", es(n=2, dep=True, tdfail=False, shutdown=False, revoke=False, end=False, head=E1B), [], ["Prop_BothComplete"], "PASS", "E1b at 8dd3eae1: the sibling dependency completes."),
 ("exec.e1b-8dd-unattributed", "WfExecShare", "reviewed", "Spec", es(head=E1B, unattr=True), ["Inv_NoOrphanBackgroundAll"], [], "safety", "8dd3eae1: a task without a readable start time is not cancelled at its owner's close (VR-3 gap)."),
 ("exec.e1b-8dd-boundary", "WfExecShare", "reviewed", "Spec", es(head=E1B, boundary=True), ["Inv_NoForeignCancel"], [], "safety", "8dd3eae1: a task started in the millisecond two windows share is cancelled by the other owner's close."),
 ("wit.exec-e1b-8dd-unsettled", "WfExecShare", "reviewed", "Spec", es(head=E1B, unsettled=True), ["Wit_CallAfterRelease"], [], "safety", "8dd3eae1: a call that did not settle after its abort still runs after its owner released; the barrier is set."),
 # ======== r2f: WfExecShare 412f7b00 (E1c); the WfExecLease cases rerun with the MF-2 fix ========
 ("exec.e1c-safety", "WfExecShare", "reviewed", "Spec", es(head=E1C, unsettled=True), S_INV8, [], "PASS", "E1c at 412f7b00: every E1b rule with an abort that does not settle."),
 ("exec.e1c-live", "WfExecShare", "reviewed", "LiveSpec", es(head=E1C, unsettled=True), [], ["Prop_WaitersServed"], "PASS", "E1c at 412f7b00: every waiter is served, refused or aborted."),
 ("exec.e1c-dep", "WfExecShare", "reviewed", "LiveSpec", es(n=2, dep=True, tdfail=False, shutdown=False, revoke=False, end=False, head=E1C), [], ["Prop_BothComplete"], "PASS", "E1c at 412f7b00: the sibling dependency completes."),
 ("exec.e1c-unattributed", "WfExecShare", "reviewed", "Spec", es(head=E1C, unattr=True), ["Inv_NoOrphanBackgroundAll"], [], "PASS", "E1c: a task without a readable start time is claimed by its id (exec.e1b-8dd-unattributed breaks at 8dd3eae1)."),
 ("exec.e1c-boundary", "WfExecShare", "reviewed", "Spec", es(head=E1C, boundary=True), ["Inv_NoForeignCancel"], [], "PASS", "E1c: ownership by id and half-open windows; no other owner's task is cancelled (exec.e1b-8dd-boundary breaks at 8dd3eae1)."),
 ("exec.e1c-unlisted", "WfExecShare", "reviewed", "Spec", es(head=E1C, unattr=True, boundary=True, listfail=True), ["Inv_NoOrphanBackgroundAll"], [], "safety", "E1c: a task no listing claimed and no window holds is left to the last owner's teardown (documented)."),
 # ======== r2g: E3-R1 after r2e2 (recover after the holder failed; E3b fc6d7a65) ========
 ("parent.zombie-holder-recover-late-a10", "WfParent", "reviewed", "LiveSpec", p(pcancel=False, head=A10, ntzombie=True, notifiers=2, recover=True, maxrec=3, recafter=True), [], ["Prop_ParentLearnsEnd"], "PASS", "a10c2e07: the zombie holder fails before its enqueue; a recover made after it released the lock pays the notice."),
 ("parent.zombie-holder-e3b", "WfParent", "reviewed", "LiveSpec", p(pcancel=False, head=E3B, ntzombie=True), [], ["Prop_ParentLearnsEnd"], "PASS", "E3b (fc6d7a65): the attempt that finds the lock held fails and runs again; no recover is needed."),
 ("parent.safety-e3b", "WfParent", "reviewed", "Spec", p("request", ext=True, pend=True, back=True, zombie=True, notifiers=2, ntzombie=True, head=E3B), P_INV_D1, [], "PASS", "Every parent rule but notified-accepted at fc6d7a65, as parent.safety-a10."),
 ("parent.live-e3b", "WfParent", "reviewed", "LiveSpec", p("request", ext=True, pend=True, wait=True, zombie=True, notifiers=2, ntzombie=True, head=E3B), [], ["Prop_ParentLearnsEnd"], "PASS", "fc6d7a65: the parent learns the end with a concurrent notifier, a timed-out holder, crashes and the wait's bound."),
 # ---- o3: R2-RT-1 (adversarial round 2, runtime): a pause committed while every cursor is pending ----
 ("graph.pause-pending-par", "WfGraph", "reviewed", "Spec", g("par", 7, 2, 2, True, cancel=False, stop=False, deadline=False, delete=False),
  ["TypeOK", "Inv_NoRouteWhilePaused"], [], "safety",
  "R2-RT-1 at 8d568890: with both branches pending, a pause is not seen; a failed branch is routed and failFast cancels its sibling."),
 ("graph.pause-pending-root", "WfGraph", "reviewed", "Spec", g("linear", 4, cancel=False, stop=False, deadline=False, delete=False),
  ["TypeOK", "Inv_NoRouteWhilePaused"], [], "safety",
  "R2-RT-1 at 8d568890: the root state pending, a pause, then an unhandled error ends the paused run."),
 ("cmp.graph-pause-on-collect", "WfGraph", "comparison", "Spec", g("par", 7, 2, 2, True, fault="fix_pause_on_collect"),
  G_INV + ["Inv_NoRouteWhilePaused"], [], "PASS",
  "The R2-RT-1 fix (batch S, not in code): the collection reads the paused status and routes nothing before the resume."),
 # ---- o4: S-RT1 07c29b05 (1.9.0) and S-RT1b c4481682 (1.8.0) ----
 ("graph.srt1-par", "WfGraph", "reviewed", "Spec", g("par", 7, 2, 2, True, fault="srt1"),
  G_INV + ["Inv_NoRouteWhilePaused", "Inv_NoFailWhilePaused"], [], "PASS",
  "S-RT1 at 07c29b05: a paused run routes nothing, also with every cursor waiting; the limit reads the run first."),
 ("graph.srt1-loop", "WfGraph", "reviewed", "Spec", g("loop", 4, fault="srt1"),
  G_INV + ["Inv_NoRouteWhilePaused", "Inv_NoFailWhilePaused"], [], "PASS",
  "S-RT1: a loop at its node limit is not ended while paused; it ends after the resume."),
 ("graph.srt1b-linear", "WfGraph", "reviewed", "Spec", g("linear", 4, fault="srt1b"),
  G_INV + ["Inv_NoRouteWhilePaused"], [], "PASS",
  "S-RT1b at c4481682 (1.8.0): a paused run's collection returns no result, so nothing is routed while paused."),
 ("graph.srt1b-loop-residual", "WfGraph", "reviewed", "Spec", g("loop", 4, cancel=False, stop=False, deadline=False, delete=False, fault="srt1b"),
  ["TypeOK", "Inv_NoFailWhilePaused"], [], "safety",
  "S-RT1b residual (stated by the commit): a pause between a collection and the next admission lets 1.8.0 end the run at its node limit."),
 ("cmp.graph-limit-paused-8d5", "WfGraph", "comparison", "Spec", g("loop", 4, cancel=False, stop=False, deadline=False, delete=False),
  ["TypeOK", "Inv_NoFailWhilePaused"], [], "safety",
  "Before S-RT1: the node limit ends a paused run at the next admission."),
 # ---- o5: S7-DX2 1ef53967 (on dbf99086): an accepted cancel or done ends a begun run in the store; queue = hints ----
 ("graph.dx2-linear", "WfGraph", "reviewed", "Spec", g("linear", 4, cmd="direct", lose=True),
  G_INV + ["Inv_NoAdmitAfterAccept", "Inv_NoCollectAfterEnd"], ["Prop_FirstEndWins"], "PASS",
  "S7-DX2: an accepted cancel or done ends the run at once (running, paused or stopping); nothing is admitted or collected after it; the first end wins. Hints may be lost."),
 ("graph.dx2-loop", "WfGraph", "reviewed", "Spec", g("loop", 4, cmd="direct", lose=True),
  G_INV + ["Inv_NoAdmitAfterAccept", "Inv_NoCollectAfterEnd"], ["Prop_FirstEndWins"], "PASS",
  "S7-DX2 on a loop that reaches its node limit: the same rules."),
 ("graph.dx2-par", "WfGraph", "reviewed", "Spec", g("par", 7, 2, 2, True, cmd="direct", lose=True),
  G_INV + ["Inv_NoAdmitAfterAccept", "Inv_NoCollectAfterEnd"], ["Prop_FirstEndWins"], "PASS",
  "S7-DX2 on a parallel state, two branches at once, failFast: the same rules."),
 ("graph.dx2-live-linear", "WfGraph", "reviewed", "LiveSpec", g("linear", 4, cmd="direct", lose=True),
  [], ["Prop_ControllerEnds", "Prop_RunEnds", "Prop_CommandEnds", "Prop_CommandTold"], "PASS",
  "S7-DX2: every accepted command ends the run by its own transaction; the controller ends and tells the parent, also with every hint lost."),
 ("graph.dx2-live-par", "WfGraph", "reviewed", "LiveSpec", g("par", 7, 2, 1, True, cmd="direct", lose=True),
  [], ["Prop_ControllerEnds", "Prop_RunEnds", "Prop_CommandEnds", "Prop_CommandTold"], "PASS",
  "S7-DX2 on a parallel state: the same progress rules."),
 ("wit.graph-dx2-command-ends", "WfGraph", "witness", "Spec", g("linear", 4, cmd="direct", lose=True),
  ["TypeOK", "Wit_CommandEndsBusyRun"], [], "safety",
  "S7-DX2: a command accepted after an admission ends the run, and the controller tells the parent once."),
 ("cmp.graph-queue-admits", "WfGraph", "comparison", "Spec", g("linear", 4, stop=False, pause=False, deadline=False, delete=False),
  ["TypeOK", "Inv_NoAdmitAfterAccept"], [], "safety",
  "Before S7-DX2 (queue): a cancel accepted while the controller is between reads; the next state is admitted first."),
 ("cmp.graph-queue-lost", "WfGraph", "comparison", "LiveSpec", g("linear", 4, stop=False, pause=False, deadline=False, delete=False, lose=True),
  [], ["Prop_CommandEnds"], "liveness",
  "Before S7-DX2 (queue): a queued cancel lost at continue-as-new (behind 100 unread messages) never ends the run."),
 ("cmp.graph-queue-terminal-first", "WfGraph", "comparison", "LiveSpec", g("linear", 4, stop=False, pause=False, deadline=False, delete=False),
  [], ["Prop_CommandEnds"], "liveness",
  "Before S7-DX2 (queue): a terminal admitted first finishes the run while the accepted cancel waits in the queue."),
 ("cmp.graph-queue-collect-after-delete", "WfGraph", "comparison", "Spec", g("linear", 4, cancel=False, stop=False, pause=False, deadline=False),
  ["TypeOK", "Inv_NoCollectAfterEnd"], [], "safety",
  "Before S7-DX2: 1.9.0's collect did not report an ended run, so a deleted run's results were collected for routing."),
]
R2E_IDS = None
R3_START = len(CASES)
R4_START = R3_START + len(R3_GRAPH) + len(R3_PARENT) + len(R3_PAUSED) + len(R3_EXECSHARE)
TF_START = R4_START + len(R3_IMPL)
CASES = r3_paused_patch(CASES + R3_GRAPH + R3_PARENT + R3_PAUSED + R3_EXECSHARE + R3_IMPL + TF_AGENT)

def val(v):
    if isinstance(v, bool): return "TRUE" if v else "FALSE"
    return str(v)

import os
IDS = [c[0] for c in CASES]
R2E_START = IDS.index("parent.zombie-holder-a10")
STARTS = [(R2E_START, "r2e"), (IDS.index("exec.e1c-safety"), "r2f"), (IDS.index("parent.zombie-holder-recover-late-a10"), "r2g"),
          (IDS.index("graph.pause-pending-par"), "o3"), (IDS.index("graph.srt1-par"), "o4"), (IDS.index("graph.dx2-linear"), "o5"),
          (R3_START, "r3"), (R4_START, "r4"), (TF_START, "tf1")]
def batch_of(n):
    b = "r2d"
    for start, name in STARTS:
        if n >= start: b = name
    return b
def head_of(cid, mod, consts, b):
    if b == "tf1": return TF_HEAD
    if "Code" in consts: return str(consts["Code"]).strip('"')   # r4: Code "a9f60db7" -> head a9f60db7
    if str(consts.get("Elsewhere", '"command"')).strip('"') == "a9f60db7": return "a9f60db7"   # r4: WfGraph at a9f60db7
    if mod != "WfGraph": return "efe44835"
    if b == "o3" or cid == "cmp.graph-limit-paused-8d5": return "8d568890"
    if b == "o4": return "c4481682" if cid.startswith("graph.srt1b") else "07c29b05"
    if b == "o5": return "dbf99086" if cid.startswith("cmp.graph-queue") else "1ef53967"
    if b == "r3": return "9a8d0f66" if str(consts.get("Elsewhere", '"command"')).strip('"') == "any" else "1ef53967"
    return "efe44835"
out, texts = [], []
for n, (cid, mod, mode, spec, consts, invs, props, expected, note) in enumerate(CASES):
    cid = cid.lower()   # the runner accepts ^[a-z0-9.-]+$ only
    lines = [f"\\* {cid} ({mode}; expected {expected}): {note}", f"SPECIFICATION {spec}", "CONSTANTS"]
    lines += [f"    {k} = {val(v)}" for k, v in consts.items()]
    if invs: lines += ["INVARIANTS"] + [f"    {i}" for i in invs]
    if props: lines += ["PROPERTIES"] + [f"    {x}" for x in props]
    lines += ["CHECK_DEADLOCK TRUE"]
    texts.append("\n".join(lines) + "\n")
    b = batch_of(n)
    head = head_of(cid, mod, consts, b)
    out.append({"id": cid, "module": mod, "mode": mode, "spec": spec, "config": f"{cid}.cfg", "head": head,
                "properties": invs + props, "expected": expected, "note": note, "batch": b})
templates = tlc_cases.attach(out, texts)
# Retired cases: the code they bind no longer exists; they move to cases-retired.json (kept for the record, never run).
RETIRED_WHY = ("Controller 1.8.0 (S-RT1b, c4481682) was removed when the Workflow orchestration versions were collapsed "
               "into one (controller 1.0.0, the former 1.9.0); the graph.srt1-* cases bind the surviving behaviour.")
RETIRED = {"graph.srt1b-linear": RETIRED_WHY, "graph.srt1b-loop-residual": RETIRED_WHY}
retired = [dict(c, retired=RETIRED[c["id"]]) for c in out if c["id"] in RETIRED]
out = [c for c in out if c["id"] not in RETIRED]
with open("cases.json", "w") as f: json.dump(out, f, indent=1)
tlc_cases.dump_json("cases-retired.json", retired, 1)
tlc_cases.dump_json("tlc-templates.json", templates, 2)
with open("cases.tsv", "w") as f:
    for c in out:
        only = [x for x in os.environ.get("ONLY", "").split(",") if x]
        if (c["id"] in only) if only else os.environ.get("BATCH") in (None, "", c["batch"]): f.write(f"{c['id']}\t{c['config']}\t{c['module']}\n")
print(len(out), "cases")
