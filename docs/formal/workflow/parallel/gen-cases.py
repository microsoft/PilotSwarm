#!/usr/bin/env python3
"""Writes cases.tsv, cases.json and tlc-templates.json for WorkflowParallel (no TLC is run here). The .cfg
files are generated from these by run-tlc.sh (../../tlc_cases.py)."""
import json, os
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", ".."))
import tlc_cases   # docs/formal/tlc_cases.py: the settings (.cfg) are generated from the tables, not committed

MOD = "WorkflowParallel"
HEAD = "design"   # p1: the design of 20:07Z; p2: with the decided answers of 20:33Z; J1 correspondence follows

def s(xs):
    return "{" + ", ".join(str(x) for x in sorted(xs)) + "}"

def c(n=3, k=1, all_=False, conc=3, ff=False, timer=True, agents=(2,), canfail=None, hang=(), skew=True, pause=True,
      pcancel="now", resumefair=True, runend=True, endfail=True, crash=1, can=0, cfirst=False, fault="none", rules="p1", tcount="work", jcheck="none", storecut=False, endretry=False, maxendfail=0, pauseseen="collect", budget="forced", forever=False, retryat="idle-paused", busy=False):
    idx = range(1, n + 1)
    canfail = idx if canfail is None else canfail
    return dict(N=n, K=k, JoinAll=all_, Conc=conc, FailFast=ff, HasTimer=timer,
                Agents=s([a for a in agents if a <= n]), CanFail=s([x for x in canfail if x <= n]),
                Hang=s([h for h in hang if h <= n]), AllowSkew=skew, AllowPause=pause, PausedCancel=f'"{pcancel}"',
                ResumeFair=resumefair, AllowRunEnd=runend, AllowEndFail=endfail, MaxCrash=crash, MaxCan=can,
                CancelFirst=cfirst, Rules=f'"{rules}"', TimeoutCounts=f'"{tcount}"', JoinCheck=f'"{jcheck}"',
                StoreCutsOnTimeout=storecut, EndFailRetries=endretry, MaxEndFail=maxendfail,
                PauseSeen=f'"{pauseseen}"', EndBudget=f'"{budget}"', EndForever=forever,
                RetryAt=f'"{retryat}"', BusyAfter=busy, Fault=f'"{fault}"')

SAFE = ["TypeOK", "Inv_OneDecision", "Inv_JoinedNeedsK", "Inv_WinnersFirstK", "Inv_BlockedOnlyWhenImpossible",
        "Inv_FailFastFalseWaits", "Inv_ReportKeepsFinished", "Inv_NoStartAfterDecision", "Inv_NoRouteAfterDecision",
        "Inv_QueuedNeverStarted", "Inv_Concurrency", "Inv_RoutedOnce", "Inv_NoEarlyTimeout", "Inv_DroppedBranchDecided",
        "Inv_CancelAckedMeansAsked"]
PROPS = ["Prop_Decided", "Prop_Routed", "Prop_CancelledStops", "Prop_BranchesSettle"]
def W(name): return ["TypeOK", name]
SAFE2 = SAFE + ["Inv_FinishedWorkWins", "Inv_BlockedStaysBlocked", "Inv_NoLateJoin", "Inv_WinnersCommitOrder", "Inv_LoserEndedBeforeRoute"]
# The decided rules (PJ-Q1 revised 20:39Z, Q2, Q3) on J1's structure: cancel before the join, the timeout's transaction
# cancels the branches' work, one work-based count in both compare-and-swaps.
J = dict(cfirst=False, storecut=True)   # J1b: decide, then cut; the time limit cancels the running work in its transaction
R2 = dict(endretry=True, maxendfail=1)   # J1-R2 (J1b): a failed child end fails the cancellation activity, which retries
D = dict(rules="decided", tcount="work", jcheck="work", pcancel="now", **J, **R2)
def L(**kw):  # progress cases: one crash and the clock skew only where named
    kw.setdefault("skew", False); kw.setdefault("crash", 0)
    return c(**kw)

# id, group, mode, spec, constants, invariants, properties, expected, note
CASES = [
 # ---- reviewed: the design holds (safety) ----
 ("par.k1-safety", "par-safety", "reviewed", "Spec", c(can=1), SAFE, [], "PASS",
  "first 1 of 3 (a race), failFast false, a timer, skewed clocks, a pause, a run end, a crash, continue-as-new, an agent branch whose end may fail."),
 ("par.k2-ff-safety", "par-safety", "reviewed", "Spec", c(k=2, conc=2, ff=True), SAFE, [], "PASS",
  "first 2 of 3, two at a time, failFast true."),
 ("par.k2-noff-safety", "par-safety", "reviewed", "Spec", c(k=2, ff=False), SAFE, [], "PASS",
  "first 2 of 3, failFast false: an impossible join waits for every branch."),
 ("par.all-ff-safety", "par-safety", "reviewed", "Spec", c(all_=True, conc=2, ff=True), SAFE, [], "PASS",
  "join all (k = n = 3), two at a time, failFast true."),
 ("par.all-noff-safety", "par-safety", "reviewed", "Spec", c(all_=True, ff=False), SAFE, [], "PASS",
  "join all, failFast false."),
 ("par.conc1-safety", "par-safety", "reviewed", "Spec", c(k=2, conc=1), SAFE, [], "PASS",
  "first 2 of 3, one at a time: queued branches become not_started."),
 ("par.cancel-first-safety", "par-safety", "reviewed", "Spec", c(k=2, conc=2, ff=True, cfirst=True), SAFE, [], "PASS",
  "The join path cancels the other branches before its decision, as failFast does at 8d568890."),
 ("par.crash2-safety", "par-safety", "reviewed", "Spec", c(n=2, conc=2, agents=(1, 2), crash=2, can=2), SAFE, [], "PASS",
  "Two crashes after a transaction and two continue-as-new, with two agent branches."),
 ("par.hang-safety", "par-safety", "reviewed", "Spec", c(hang=(2, 3)), SAFE, [], "PASS",
  "first 1 of 3 with two branches whose work never ends by itself."),
 ("par.paused-resume-safety", "par-safety", "reviewed", "Spec", c(k=2, hang=(3,), pcancel="resume"), SAFE, [], "PASS",
  "A timeout decided while paused cancels the branches at the resume."),
 # ---- reviewed: progress ----
 ("par.k1-live", "par-live", "reviewed", "LiveSpec", c(), SAFE, PROPS, "PASS",
  "first 1 of 3 with a crash and skewed clocks: decided, routed, every cancelled branch stops."),
 ("par.can-live", "par-live", "reviewed", "LiveSpec", c(n=2, conc=2, hang=(2,), crash=1, can=2), SAFE, PROPS, "PASS",
  "Two continue-as-new and a crash while a hung branch waits for the timer."),
 ("par.k2-ff-live", "par-live", "reviewed", "LiveSpec", L(k=2, conc=2, ff=True), SAFE, PROPS, "PASS",
  "first 2 of 3, failFast true."),
 ("par.all-live", "par-live", "reviewed", "LiveSpec", L(all_=True, conc=2, ff=False), SAFE, PROPS, "PASS",
  "join all, failFast false."),
 ("par.conc1-live", "par-live", "reviewed", "LiveSpec", L(k=2, conc=1, ff=True), SAFE, PROPS, "PASS",
  "first 2 of 3, one at a time."),
 ("par.hang-timer-live", "par-live", "reviewed", "LiveSpec", L(k=2, hang=(2, 3)), SAFE, PROPS, "PASS",
  "Two hung branches: only the timer decides, and the hung work stops."),
 ("par.no-timer-live", "par-live", "reviewed", "LiveSpec", L(k=2, ff=True, timer=False), SAFE, PROPS, "PASS",
  "No timeoutSeconds: the join alone decides."),
 ("par.agents-live", "par-live", "reviewed", "LiveSpec", L(agents=(1, 2, 3), hang=(3,)), SAFE, PROPS, "PASS",
  "Three agent branches, a failed child end: the run's end ends the child."),
 ("par.paused-resume-live", "par-live", "reviewed", "LiveSpec", L(k=2, hang=(2, 3), pcancel="resume"), SAFE, PROPS, "PASS",
  "The resume rule, with a resume in the end."),
 ("par.cancel-first-live", "par-live", "reviewed", "LiveSpec", L(k=2, conc=2, ff=True, cfirst=True), SAFE, PROPS, "PASS",
  "Cancel before the decision."),
 # ---- reviewed: edge cases ----
 ("par.n-below-k", "par-edge", "reviewed", "LiveSpec", L(n=1, k=2), SAFE, PROPS, "PASS",
  "first 2 with one item at run time: blocked at once."),
 ("par.n0-all", "par-edge", "reviewed", "LiveSpec", L(n=0, all_=True), SAFE, PROPS, "PASS",
  "join all with no items: joined with []."),
 ("par.n0-first", "par-edge", "reviewed", "LiveSpec", L(n=0, k=1), SAFE, PROPS, "PASS",
  "first 1 with no items: blocked."),
 # ---- witnesses: expected to be violated (the behavior is reachable) ----
 ("wit.par-joined-k1", "par-witness", "witness", "Spec", c(), W("W_NotJoined"), [], "safety", "A race is joined."),
 ("wit.par-winners-out-of-order", "par-witness", "witness", "Spec", c(k=2), W("W_WinnersInIndexOrder"), [], "safety",
  "The winners are in the order they finished, not in item order."),
 ("wit.par-blocked-ff", "par-witness", "witness", "Spec", c(k=2, ff=True), W("W_NotBlocked"), [], "safety",
  "failFast blocks once 2 of 3 cannot succeed."),
 ("wit.par-timed-out", "par-witness", "witness", "Spec", c(k=2, hang=(3,)), W("W_NotTimedOut"), [], "safety",
  "The timer decides."),
 ("wit.par-not-due", "par-witness", "witness", "Spec", c(n=2), W("W_NoNotDue"), [], "safety",
  "The controller's clock is ahead: the store answers not_due."),
 ("wit.par-timeout-with-k-stored", "par-witness", "witness", "Spec", c(n=2), W("W_TimeoutNotWithKStored"), [], "safety",
  "Design limit: timed_out although k branches' work stored succeeded before the timer, because the join counts routed terminals."),
 ("wit.par-timeout-while-paused", "par-witness", "witness", "Spec", c(n=2), W("W_NotTimedOutWhilePaused"), [], "safety",
  "Design limit: the timer runs while paused and decides, while no join can."),
 ("wit.par-timeout-after-impossible", "par-witness", "witness", "Spec", c(k=2, canfail=(1, 2), hang=(3,)),
  W("W_NoTimeoutAfterImpossible"), [], "safety",
  "failFast false: after k became impossible, the timer turns blocked into timed_out."),
 ("wit.par-loser-outlives-route", "par-witness", "witness", "Spec", c(agents=(1, 2, 3)), W("W_LoserNotRunningAfterRoute"), [], "safety",
  "Design limit: a losing agent child whose end failed still runs after the parallel state routed."),
 ("wit.par-finished-work-reported-cancelled", "par-witness", "witness", "Spec", c(k=2, ff=True),
  W("W_FinishedWorkNotReportedCancelled"), [], "safety",
  "A branch whose work succeeded but whose terminal was not admitted is reported cancelled."),
 ("wit.par-late-result-kept", "par-witness", "witness", "Spec", c(), W("W_LateResultNotStored"), [], "safety",
  "A loser's result stored before the cancellation is kept and never routed."),
 ("wit.par-n0-all-joined", "par-witness", "witness", "Spec", c(n=0, all_=True), W("W_NotJoined"), [], "safety",
  "n = 0 with all joins."),
 ("wit.par-n0-first-blocked", "par-witness", "witness", "Spec", c(n=0, k=1), W("W_NotBlocked"), [], "safety",
  "n = 0 with first 1 blocks."),
 ("wit.par-n-below-k-blocked", "par-witness", "witness", "Spec", c(n=1, k=2), W("W_NotBlocked"), [], "safety",
  "n < k at run time blocks."),
 # ---- deliberate faults: each must break its rule ----
 ("fault.par-failfast-first-failure", "par-fault", "fault", "Spec", c(ff=True, fault="failfast-first"),
  W("Inv_BlockedOnlyWhenImpossible"), [], "safety",
  "failFast cancels at the first failure (the 8d568890 rule) while 1 of 3 is still possible."),
 ("fault.par-ff-false-blocks-early", "par-fault", "fault", "Spec", c(k=2, fault="ff-false-early"),
  W("Inv_FailFastFalseWaits"), [], "safety", "failFast false blocks before every branch ended."),
 ("fault.par-no-store-guard", "par-fault", "fault", "Spec", c(n=2, fault="no-store-guard"),
  W("Inv_NoEarlyTimeout"), [], "safety", "The timeout trusts the controller's clock."),
 ("fault.par-no-cas", "par-fault", "fault", "Spec", c(n=2, fault="no-cas"),
  W("Inv_OneDecision"), [], "safety", "The timer stays armed after the join and its write is not a compare-and-swap."),
 ("fault.par-timeout-keeps-cursors", "par-fault", "fault", "Spec", c(n=2, fault="timeout-keeps-cursors"),
  W("Inv_NoRouteAfterDecision"), [], "safety", "The timeout leaves the branches' cursors: their results are routed after it."),
 ("fault.par-cancel-retry-forgets", "par-fault", "fault", "Spec", c(n=2, fault="cancel-retry-forgets"),
  W("Inv_CancelAckedMeansAsked"), [], "safety",
  "The cancellation returns only what this attempt decided: a retry after a crash sends no stop request."),
 ("fault.par-cancel-only-if-won", "par-fault", "fault", "Spec", c(n=2, fault="cancel-only-if-won"),
  W("Inv_DroppedBranchDecided"), [], "safety",
  "The controller cancels only when the decision's compare-and-swap reports won: a retry after a crash does not."),
 ("fault.par-can-drops-deadline", "par-fault", "fault", "LiveSpec", L(k=2, hang=(2, 3), can=1, fault="can-drops-deadline"),
  ["TypeOK"], ["Prop_Decided"], "liveness", "Continue-as-new drops the deadline: hung branches block the state forever."),
 ("fault.par-winners-by-index", "par-fault", "fault", "Spec", c(k=2, fault="winners-by-index"),
  W("Inv_WinnersFirstK"), [], "safety", "The output lists the winners in item order."),
 ("fault.par-no-conc-limit", "par-fault", "fault", "Spec", c(k=2, conc=1, fault="no-conc-limit"),
  W("Inv_Concurrency"), [], "safety", "startBranches ignores the concurrency."),
 # ---- comparisons ----
 ("cmp.par-timer-armed", "par-compare", "comparison", "Spec", c(n=2, fault="timer-armed"), SAFE, [], "PASS",
  "Control for fault.par-no-cas: the timer stays armed after the join; the compare-and-swap keeps one decision."),
 ("cmp.par-hang-no-timer", "par-compare", "comparison", "LiveSpec", L(k=2, hang=(2, 3), timer=False),
  ["TypeOK"], ["Prop_Decided"], "liveness", "Without timeoutSeconds, a hung branch blocks the join forever (the reason for the timer)."),
 ("cmp.par-paused-cancel-resume", "par-compare", "comparison", "LiveSpec",
  L(k=2, hang=(2, 3), pcancel="resume", resumefair=False, runend=False, endfail=False),
  ["TypeOK"], ["Prop_CancelledStops"], "liveness",
  "Rule choice: a timeout while paused that cancels only at the resume leaves hung work running while the run stays paused."),
 ("cmp.par-paused-cancel-now", "par-compare", "comparison", "LiveSpec",
  L(k=2, hang=(2, 3), pcancel="now", resumefair=False, runend=False, endfail=False),
  ["TypeOK"], ["Prop_CancelledStops"], "PASS", "Rule choice: cancelling at once stops the work while paused."),
]
P2 = [
 # ---- p2 reviewed: the decided rules ----
 ("par2.k1-safety", "par2-safety", "reviewed", "Spec", c(can=1, **D), SAFE2, [], "PASS",
  "Decided rules, first 1 of 3, every environment choice as par.k1-safety."),
 ("par2.k2-ff-safety", "par2-safety", "reviewed", "Spec", c(k=2, conc=2, ff=True, **D), SAFE2, [], "PASS", "Decided rules, first 2 of 3, failFast true."),
 ("par2.k2-noff-safety", "par2-safety", "reviewed", "Spec", c(k=2, **D), SAFE2, [], "PASS", "Decided rules, first 2 of 3, failFast false."),
 ("par2.k2-noff-limit-safety", "par2-safety", "reviewed", "Spec", c(k=2, canfail=(1, 2), hang=(3,), **D), SAFE2, [], "PASS",
  "PJ-Q3: k becomes impossible while a hung branch runs; the time limit keeps blocked."),
 ("par2.all-noff-safety", "par2-safety", "reviewed", "Spec", c(all_=True, **D), SAFE2, [], "PASS", "Decided rules, join all, failFast false."),
 ("par2.conc1-safety", "par2-safety", "reviewed", "Spec", c(k=2, conc=1, **D), SAFE2, [], "PASS", "Decided rules, one branch at a time."),
 ("par2.crash2-safety", "par2-safety", "reviewed", "Spec", c(n=2, conc=2, agents=(1, 2), crash=2, can=2, **D), SAFE2, [], "PASS",
  "Decided rules with two crashes and two continue-as-new."),
 ("par2.agents-safety", "par2-safety", "reviewed", "Spec", c(agents=(1, 2, 3), **D), SAFE2, [], "PASS",
  "J1-R2: three agent branches whose ends may fail; the retried cancellation ends every loser before the route."),
 ("par2.k1-live", "par2-live", "reviewed", "LiveSpec", c(**D), SAFE2, PROPS, "PASS", "Decided rules: decided, routed, cancelled work stops."),
 ("par2.all-live", "par2-live", "reviewed", "LiveSpec", L(all_=True, conc=2, **D), SAFE2, PROPS, "PASS", "Decided rules, join all."),
 ("par2.k2-noff-limit-live", "par2-live", "reviewed", "LiveSpec", L(k=2, canfail=(1, 2), hang=(3,), **D), SAFE2, PROPS, "PASS",
  "PJ-Q3: the hung branch is cancelled at the time limit and the state is routed blocked."),
 ("par2.hang-timer-live", "par2-live", "reviewed", "LiveSpec", L(k=2, hang=(2, 3), **D), SAFE2, PROPS, "PASS",
  "Decided rules with two hung branches, a pause and its resume."),
 ("par2.agents-live", "par2-live", "reviewed", "LiveSpec", L(agents=(1, 2, 3), hang=(3,), **D), SAFE2, PROPS, "PASS",
  "J1-R2: a hung losing agent child is ended after a failed end, by the activity's retry."),
 ("par2.paused-cancel-now", "par2-live", "reviewed", "LiveSpec",
  L(k=2, hang=(2, 3), resumefair=False, runend=False, endfail=False, **D), ["TypeOK"], ["Prop_CancelledStops"], "PASS",
  "PJ-Q2: a timeout while paused cancels at once, so work stops although the run stays paused."),
 ("par2.n-below-k", "par2-edge", "reviewed", "LiveSpec", L(n=1, k=2, **D), SAFE2, PROPS, "PASS",
  "Decided rules: first 2 with one item is blocked at once."),
 ("par2.n0-all", "par2-edge", "reviewed", "LiveSpec", L(n=0, all_=True, **D), SAFE2, PROPS, "PASS",
  "join all with no items is joined with []; MF-P1 fixed (no quantifier over an empty set in a temporal formula)."),
 ("par2.n0-first", "par2-edge", "reviewed", "LiveSpec", L(n=0, k=1, **D), SAFE2, PROPS, "PASS",
  "first 1 with no items is blocked; MF-P1 fixed."),
 ("wit.par2-join-due", "par2-witness", "witness", "Spec", c(n=2, **D), W("W_NoJoinDue"), [], "safety",
  "PJ-Q1: the timeout finds k successes stored by the deadline and answers join due."),
 ("wit.par2-commit-order-winners", "par2-witness", "witness", "Spec", c(k=2, **D), W("W_WinnersAdmissionOrder"), [], "safety",
  "J1b amendment 1: the winners follow commit order, which can differ from the order the controller admitted the terminals."),
 ("wit.par2-blocked-at-time-limit", "par2-witness", "witness", "Spec", c(k=2, canfail=(1, 2), hang=(3,), **D), W("W_NotBlockedByTimer"), [], "safety",
  "PJ-Q3: blocked with timedOut true is reachable."),
 ("wit.par2-timeout-while-paused", "par2-witness", "witness", "Spec", c(n=2, **D), W("W_NotTimedOutWhilePaused"), [], "safety",
  "PJ-Q2: the timer still decides while paused."),
 # ---- p2 comparisons ----
 ("cmp.par2-finished-work-p1", "par2-compare", "comparison", "Spec", c(n=2, **J), W("Inv_FinishedWorkWins"), [], "safety",
  "p1 rules: the timer wins over work stored succeeded before the deadline (was wit.par-timeout-with-k-stored)."),
 ("cmp.par2-finished-work-terminals", "par2-compare", "comparison", "Spec", c(n=2, **dict(D, tcount="terminals")),
  W("Inv_FinishedWorkWins"), [], "safety", "The timeout counting admitted terminals does not protect work stored before the deadline."),
 ("cmp.par2-join-check-winners", "par2-compare", "comparison", "Spec", c(n=2, **dict(D, jcheck="winners")),
  W("Inv_FinishedWorkWins"), [], "safety", "H1: a join check that counts only the controller's winners decides timed_out with k on-time successes stored."),
 ("cmp.par2-join-no-check", "par2-compare", "comparison", "Spec", c(n=2, **dict(D, jcheck="none")),
  W("Inv_NoLateJoin"), [], "safety", "Without the join's deadline check, a winner stored after the deadline joins."),
 ("cmp.par2-end-swallowed", "par2-compare", "comparison", "Spec", c(agents=(1, 2, 3), **dict(D, endretry=False, maxendfail=0)),
  W("Inv_LoserEndedBeforeRoute"), [], "safety", "J1-R2 at J1: a failed loser end is swallowed, so the child can outlive the route (was wit.par-loser-outlives-route)."),
 ("cmp.par2-impossible-p1", "par2-compare", "comparison", "Spec", c(k=2, canfail=(1, 2), hang=(3,), **J), W("Inv_BlockedStaysBlocked"), [], "safety",
  "p1 rules: the timer turns blocked into timed_out (was wit.par-timeout-after-impossible)."),
 ("cmp.par2-paused-cancel-resume", "par2-compare", "comparison", "LiveSpec",
  L(k=2, hang=(2, 3), resumefair=False, runend=False, endfail=False, **dict(D, pcancel="resume", storecut=False)), ["TypeOK"], ["Prop_CancelledStops"], "liveness",
  "The rejected resume rule, without J1's cut in the timeout transaction: hung work runs while the run stays paused."),
]


P3 = [
 # ---- p3: R2-RT-1 (adversarial round 2, runtime; fix in batch S): a pause committed while every cursor is pending ----
 ("par3.pause-pending", "par3-pause", "reviewed", "Spec", c(n=2, ff=True, pause=True, pauseseen="admission", **D), W("Inv_NoRouteWhilePaused"), [], "safety",
  "R2-RT-1 at 8d568890 and J1b: with every cursor pending, the pause is not seen and a branch result is routed while paused."),
 ("par3.pause-admission-safety", "par3-pause", "reviewed", "Spec", c(n=2, ff=True, pauseseen="admission", **D), SAFE2, [], "PASS",
  "Every other rule still holds with the late pause discovery of the code."),
 ("par3.pause-admission-live", "par3-pause", "reviewed", "LiveSpec", L(n=2, ff=True, hang=(2,), pauseseen="admission", **D), SAFE2, PROPS, "PASS",
  "Progress with the late pause discovery of the code."),
 ("cmp.par3-pause-on-collect", "par3-pause", "comparison", "Spec", c(n=2, ff=True, pauseseen="collect", **D), SAFE2 + ["Inv_NoRouteWhilePaused"], [], "PASS",
  "The R2-RT-1 fix (batch S): the collection reads the paused status; nothing is routed while paused."),
]

# J1d (874af832 on c4481682): the cancellation tries each loser end once; a branch still owed is answered, and the
# controller goes on at once. It retries owed ends between its steps, running or paused, and the run's end ends every
# owed child. Controller 1.9.0: the pause is read at the collection (S-RT1).
J1D = dict(D, budget="owe", maxendfail=0, forever=True)
SAFE4 = SAFE2 + ["Inv_WinnersNeverCut", "Inv_NoRouteWhilePaused"]
PROPS4 = PROPS + ["Prop_JoinRouted", "Prop_OwedEnded", "Prop_CommandTaken"]
P4 = [
 ("par4.end-owed-safety", "par4-owed", "reviewed", "Spec", c(agents=(1, 2, 3), **J1D), SAFE4, [], "PASS",
  "J1d: loser child ends keep failing; they are owed after one try and the decided join is routed. A winner's work is never cut."),
 ("par4.end-owed-k2-safety", "par4-owed", "reviewed", "Spec", c(k=2, conc=2, ff=True, agents=(1, 2, 3), **J1D), SAFE4, [], "PASS",
  "J1d with first 2 of 3, two at a time, failFast: owed ends, and the winners are never cut."),
 ("par4.end-owed-live", "par4-owed", "reviewed", "LiveSpec", L(agents=(1, 2, 3), hang=(3,), **J1D), SAFE4, PROPS4, "PASS",
  "J1d, ends that keep failing: the decided join is routed, a queued cancel is taken, and the run's end ends every owed child."),
 ("par4.owed-retry-live", "par4-owed", "reviewed", "LiveSpec", L(agents=(1, 2, 3), hang=(3,), **dict(J1D, forever=False)), SAFE4, PROPS4, "PASS",
  "J1d, an end that fails once: the controller's retry or the run's end completes every owed end."),
 ("wit.par4-owed", "par4-witness", "witness", "Spec", c(agents=(1, 2, 3), **J1D), W("W_NoOwed"), [], "safety",
  "J1d: a loser's failed end is recorded owed and the controller goes on."),
 ("wit.par4-owed-retried-paused", "par4-witness", "witness", "Spec", c(n=2, agents=(1, 2), **dict(J1D, forever=False)),
  W("W_OwedNotRetriedWhilePaused"), [], "safety", "J1d: the controller completes an owed end while the run is paused."),
 ("cmp.par4-end-fail-run", "par4-owed", "comparison", "LiveSpec", L(agents=(1, 2, 3), hang=(3,), **dict(J1D, budget="fail-run", maxendfail=1)),
  ["TypeOK"], ["Prop_JoinRouted"], "liveness",
  "J1c (J1C-1): after the retry budget the error fails the run, and the decided join is never routed."),
]

# J1e (68079fed on f5751acc): the owed retry runs at the top of every pass, busy or idle, and at once after
# continue-as-new. J1d-R1: a run that stays busy after the route never reaches J1d's idle wait.
J1E = dict(J1D, forever=False, retryat="every-pass")
LIVE5 = ["Prop_Decided", "Prop_CancelledStops", "Prop_BranchesSettle", "Prop_JoinRouted", "Prop_OwedEnded"]
P5 = [
 ("par5.owed-safety", "par5-owed", "reviewed", "Spec", c(agents=(1, 2, 3), **J1E), SAFE4, [], "PASS",
  "J1e: owed ends retried on every pass; every rule of p4 still holds."),
 ("par5.owed-live", "par5-owed", "reviewed", "LiveSpec", L(agents=(1, 2, 3), hang=(3,), **J1E), SAFE4, PROPS4, "PASS",
  "J1e on the p4 progress settings: the join is routed, a cancel is taken, every owed end is completed."),
 ("par5.busy-live", "par5-owed", "reviewed", "LiveSpec", L(n=2, agents=(1, 2), hang=(2,), runend=False, **dict(J1E, busy=True)),
  SAFE4, LIVE5, "PASS",
  "J1d-R1 fixed by J1e: the run stays busy after the route and never idles or ends; the owed end is still completed."),
 ("cmp.par5-busy-j1d", "par5-owed", "comparison", "LiveSpec", L(n=2, agents=(1, 2), hang=(2,), runend=False, **dict(J1E, busy=True, retryat="idle-paused")),
  ["TypeOK"], ["Prop_OwedEnded"], "liveness",
  "J1d-R1 at J1d: a busy run never reaches the idle wait, so an owed end is never tried again."),
]

def val(v):
    if isinstance(v, bool): return "TRUE" if v else "FALSE"
    return str(v)

out, texts = [], []
for batch, rows in (("p1", CASES), ("p2", P2), ("p3", P3), ("p4", P4), ("p5", P5)):
  for (cid, group, mode, spec, consts, invs, props, expected, note) in rows:
      assert cid == cid.lower()
      lines = [f"\\* {cid} ({mode}; expected {expected}): {note}", f"SPECIFICATION {spec}", "CONSTANTS"]
      lines += [f"    {k} = {val(v)}" for k, v in consts.items()]
      if invs: lines += ["INVARIANTS"] + [f"    {i}" for i in invs]
      if props: lines += ["PROPERTIES"] + [f"    {x}" for x in props]
      lines += ["CHECK_DEADLOCK TRUE"]
      texts.append("\n".join(lines) + "\n")
      out.append({"id": cid, "module": MOD, "group": group, "mode": mode, "spec": spec, "config": f"{cid}.cfg", "head": HEAD,
                  "properties": invs + props, "expected": expected, "note": note, "batch": batch})
only = [x for x in os.environ.get("ONLY", "").split(",") if x]
with open("cases.tsv", "w") as f:
    for c_ in out:
        if (c_["id"] in only) if only else os.environ.get("BATCH") in (None, "", c_["batch"]): f.write(f"{c_['id']}\t{c_['config']}\t{c_['module']}\n")
templates = tlc_cases.attach(out, texts)
with open("cases.json", "w") as f: json.dump(out, f, indent=1)
tlc_cases.dump_json("tlc-templates.json", templates, 2)
print(len(out), "cases")
