#!/usr/bin/env python3
"""Generates every TLC settings file, cases.tsv and cases.json for the fork + join models (no TLC is run here)."""
import json, os

BATCH = "fj3"

def s(xs):
    return "{" + ", ".join(str(x) for x in sorted(xs)) + "}"

def q(x):
    return f'"{x}"'

# ---- option A design (WfForkJoin) ----
def a(nb=2, two=(), err=(), loop=(), agents=(1,), canfail=(1, 2), hang=(), k=1, all_=True, conc=None, ff=False,
      timer=False, routes="all", catchall=False, limit=6, pause=False, resumefair=True, stop=False, cancel=False,
      crash=0, entryerr=False, stopfence="fork", alljoin="store", fault="none"):
    conc = nb if conc is None else conc
    keep = lambda xs: s([x for x in xs if x <= nb])
    return dict(NB=nb, Two=keep(two), Err=keep(err), Loop=keep(loop), AgentBr=keep(agents), CanFail=keep(canfail),
                Hang=keep(hang), K=k, JoinAll=all_, Conc=conc, FailFast=ff, HasTimer=timer, ForkRoutes=q(routes),
                HasCatchAll=catchall, Limit=limit, AllowPause=pause, ResumeFair=resumefair, AllowStop=stop,
                AllowCancel=cancel, MaxCrash=crash, EntryErr=entryerr,
                StopFence=q(stopfence), AllJoinPath=q(alljoin), Fault=q(fault))

def ab(nb=3, kneed=1, ff=False, timer=True, runend=False, entryerr=False):
    return dict(NB=nb, Kneed=kneed, FailFast=ff, HasTimer=timer, AllowRunEnd=runend, AllowEntryError=entryerr)

def tk(graph="clean", sem="free", join="arcs", tends=True, err=False, maxtok=4, maxsteps=6):
    return dict(Graph=q(graph), Sem=q(sem), JoinWaits=q(join), TerminalEnds=tends, ErrOn=err, MaxTok=maxtok, MaxSteps=maxsteps)

SAFE = ["TypeOK", "Inv_OneDecision", "Inv_JoinedK", "Inv_WinnersCommitOrder", "Inv_WinnersOnTime", "Inv_VisitIsolated",
        "Inv_BlockedOnlyWhenImpossible", "Inv_FailFastFalseWaits", "Inv_ReportComplete", "Inv_ReportKeepsFinished",
        "Inv_NoStartAfterDecision", "Inv_NoRouteAfterDecision", "Inv_QueuedNeverStarted", "Inv_Concurrency",
        "Inv_StepsBound", "Inv_LimitExact", "Inv_BranchConfined", "Inv_RowsOwned", "Inv_ModelKeysDistinct",
        "Inv_StopLetsStartedFinish", "Inv_EndedNothingPending", "Inv_DroppedNoPending", "Inv_CutMeansAsked",
        "Inv_NoSettleAfterStop", "Inv_CutOnlyWithDecision"]
PROPS = ["Prop_ForkDecided", "Prop_RunEnds", "Prop_EffectsSettle", "Prop_StopEnds"]
ASAFE = ["ATypeOK", "AInv_Joined", "AInv_Decided", "AInv_WinnersOnlyWhenJoined", "AInv_TimedOutNotImpossible"]
BSAFE = ["TypeOK", "Inv_NoSiblingDiscarded", "Inv_ErrorBranchLocal", "Inv_JoinExact", "Inv_NoCross", "Inv_NoTwoOnNode",
         "Inv_NoLoopFork"]
REF = ["Prop_RefinesAbs"]

A, ABS, TOK = "WfForkJoin", "AbsForkJoin", "WfForkTokens"
# id, module, group, spec, constants, invariants, properties, expected, deadlock, note
CASES = [
 # ---- the intended specification itself ----
 ("abs.k1-timer", ABS, "abs", "ASpec", ab(), ASAFE, [], "PASS", True,
  "The abstract fork + join: first 1 of 3, a time limit, failFast false; no run end, so a stuck undecided state is a deadlock."),
 ("abs.all-ff", ABS, "abs", "ASpec", ab(kneed=3, ff=True, timer=False), ASAFE, [], "PASS", True,
  "Join all of 3, failFast true, no time limit."),
 ("abs.k2-noff", ABS, "abs", "ASpec", ab(kneed=2, ff=False, timer=False, runend=True), ASAFE, [], "PASS", True,
  "First 2 of 3, failFast false, no time limit, a run end."),
 ("abs.entry-error", ABS, "abs", "ASpec", ab(kneed=2, ff=True, timer=True, runend=True, entryerr=True), ASAFE, [], "PASS", True,
  "fj2: first 2 of 3 with an entry error, a time limit and a run end."),
 # ---- option A: the design holds (safety) ----
 ("a.one-all", A, "a-safety", "Spec", a(crash=1, pause=True), SAFE, [], "PASS", True,
  "Join all of two one-state branches (one an agent), errors possible, a crash after a transaction, a pause."),
 ("a.shapes-ff", A, "a-safety", "Spec", a(two=(1,), err=(2,), ff=True, limit=7), SAFE, [], "PASS", True,
  "Two different body graphs (W1 -> W2 -> End; W1 with a branch-local error route to E), join all, failFast."),
 ("a.loop-k1", A, "a-safety", "Spec", a(loop=(1,), k=1, all_=False), SAFE, [], "PASS", True,
  "First 1 of 2 with a branch-local loop; the global node limit bounds it."),
 ("a.k1-timer", A, "a-safety", "Spec", a(nb=3, k=1, all_=False, conc=2, timer=True, hang=(3,), agents=(1, 3), canfail=(1,), limit=7, crash=1),
  SAFE, [], "PASS", True, "First 1 of 3, two at a time, a time limit, a hung agent branch, a crash."),
 ("a.k2-ff-timer", A, "a-safety", "Spec", a(nb=3, k=2, all_=False, ff=True, timer=True, canfail=(1, 2, 3), limit=7),
  SAFE, [], "PASS", True, "First 2 of 3, failFast, a time limit: joined, blocked, due, timed_out and late all reachable."),
 ("a.stop-pause", A, "a-safety", "Spec", a(stop=True, pause=True, hang=(2,), agents=(2,)), SAFE, [], "PASS", True,
  "A graceful stop and a pause during the fork, with a hung agent branch."),
 ("a.cancel-timer", A, "a-safety", "Spec", a(k=1, all_=False, cancel=True, timer=True, agents=(1, 2), hang=(2,), crash=1),
  SAFE, [], "PASS", True, "Cancel now during the fork, a time limit, two agent branches, a crash."),
 ("a.retry-limit", A, "a-safety", "Spec", a(routes="retry", ff=True, limit=8), SAFE, [], "PASS", True,
  "blocked and the fork's error route lead back to the fork: a second visit; the global limit ends the run."),
 ("a.catchall", A, "a-safety", "Spec", a(entryerr=True, hang=(2,), routes="noTimeout", catchall=True, crash=1), SAFE, [], "PASS", True,
  "fj3 (NB-R6): timed_out always has its own route, so the catch-all is checked with the entry error; branch errors never reach it."),
 ("a.conc1", A, "a-safety", "Spec", a(nb=3, conc=1, k=2, all_=False, ff=True, canfail=(1, 2, 3), limit=8), SAFE, [], "PASS", True,
  "First 2 of 3, one at a time: queued branches become not_started."),
 # ---- option A refines the intended specification ----
 ("r.one-all", A, "a-refine", "Spec", a(crash=1, cancel=True), SAFE, REF, "PASS", True,
  "Refinement of AbsForkJoin: join all, a crash, cancel now."),
 ("r.k1-timer", A, "a-refine", "Spec", a(k=1, all_=False, timer=True, two=(1,), hang=(2,), limit=6), SAFE, REF, "PASS", True,
  "Refinement: first 1 of 2, a time limit, a two-state branch, a hung branch (due, late, timed_out)."),
 ("r.ff-stop", A, "a-refine", "Spec", a(ff=True, err=(1,), stop=True), SAFE, REF, "PASS", True,
  "Refinement: failFast, a branch-local error route, a graceful stop."),
 # ---- option A: progress ----
 ("l.one-all", A, "a-live", "LiveSpec", a(crash=1, pause=True), SAFE, PROPS, "PASS", True,
  "Join all: decided, the run ends, every effect settles; a crash and a pause."),
 ("l.k1-timer-hang", A, "a-live", "LiveSpec", a(k=1, all_=False, timer=True, hang=(2,), agents=(2,)), SAFE, PROPS, "PASS", True,
  "First 1 of 2 with a hung agent branch: the loser is cut and its child ended."),
 ("l.stop-hang", A, "a-live", "LiveSpec", a(stop=True, hang=(2,), agents=(2,)), SAFE, ["Prop_StopEnds", "Prop_StopSettles"], "PASS", True,
  "A graceful stop with a hung branch: its grace deadline ends the run and every effect settles (fj2, MF-FJ1: the stop is "
  "the environment's choice, so only properties conditioned on it are checked here; without a stop see cmp.a-hang-no-timer)."),
 ("l.retry", A, "a-live", "LiveSpec", a(routes="retry", ff=True, limit=7), SAFE, PROPS, "PASS", True,
  "The retry loop around the fork ends (the global limit)."),
 ("l.cancel-timer", A, "a-live", "LiveSpec", a(cancel=True, timer=True, hang=(2,), agents=(1, 2)), SAFE, PROPS, "PASS", True,
  "Cancel now or the time limit; every effect settles."),
 ("cmp.a-hang-no-timer", A, "a-cmp", "LiveSpec", a(hang=(2,)), SAFE, PROPS, "VIOLATION:Prop_ForkDecided", True,
  "Join all with a branch that never ends and no time limit: the join waits until someone cancels (design-true)."),
 # ---- option A witnesses (expected violated: the behavior is reachable) ----
 ("wit.a-joined", A, "a-wit", "Spec", a(), ["W_NotJoined"], [], "VIOLATION:W_NotJoined", True, "Joined."),
 ("wit.a-blocked", A, "a-wit", "Spec", a(ff=True), ["W_NotBlocked"], [], "VIOLATION:W_NotBlocked", True, "Blocked by failFast."),
 ("wit.a-timed-out", A, "a-wit", "Spec", a(timer=True, hang=(2,)), ["W_NotTimedOut"], [], "VIOLATION:W_NotTimedOut", True, "timed_out."),
 ("wit.a-due", A, "a-wit", "Spec", a(k=1, all_=False, timer=True), ["W_NoDue"], [], "VIOLATION:W_NoDue", True,
  "Past the time limit with a success committed in time but its terminal not admitted: join due."),
 ("wit.a-late", A, "a-wit", "Spec", a(timer=True), ["W_NoLate"], [], "VIOLATION:W_NoLate", True,
  "A branch ends after the time limit and is reported late."),
 ("wit.a-second-visit", A, "a-wit", "Spec", a(routes="retry", ff=True, limit=7), ["W_NoSecondVisit"], [], "VIOLATION:W_NoSecondVisit", True,
  "The fork is visited again."),
 ("wit.a-local-error-route", A, "a-wit", "Spec", a(err=(1,), canfail=(1,)), ["W_NoLocalErrorRoute"], [], "VIOLATION:W_NoLocalErrorRoute", True,
  "A branch error takes its branch-local error route."),
 ("wit.a-local-loop", A, "a-wit", "Spec", a(loop=(1,)), ["W_NoLocalLoop"], [], "VIOLATION:W_NoLocalLoop", True, "A branch-local loop."),
 ("wit.a-limit", A, "a-wit", "Spec", a(loop=(1,), limit=5), ["W_NoLimitEnd"], [], "VIOLATION:W_NoLimitEnd", True,
  "The global node limit ends the run."),
 ("wit.a-catchall", A, "a-wit", "Spec", a(entryerr=True, routes="noTimeout", catchall=True), ["W_NoCatchAll"], [],
  "VIOLATION:W_NoCatchAll", True, "The catch-all handles the entry error (fj3: timed_out is always routed)."),
 ("wit.a-not-started", A, "a-wit", "Spec", a(nb=3, conc=1, ff=True, canfail=(1, 2, 3), limit=7), ["W_NoNotStarted"], [],
  "VIOLATION:W_NoNotStarted", True, "A queued branch is not_started."),
 ("wit.a-cancelled-loser", A, "a-wit", "Spec", a(k=1, all_=False), ["W_NoCancelledLoser"], [], "VIOLATION:W_NoCancelledLoser", True,
  "A losing branch is cancelled."),
 ("wit.a-commit-order", A, "a-wit", "Spec", a(k=1, all_=False), ["W_WinnersIndexOrder"], [], "VIOLATION:W_WinnersIndexOrder", True,
  "The winner is branch 2, which committed first, though branch 1 also succeeded."),
 ("wit.a-stop-after-work", A, "a-wit", "Spec", a(stop=True), ["W_NoStopAfterWork"], [], "VIOLATION:W_NoStopAfterWork", True,
  "A stop lets started work finish, then ends the run."),
 ("wit.a-completed", A, "a-wit", "Spec", a(), ["W_NotCompleted"], [], "VIOLATION:W_NotCompleted", True, "The run completes."),
 # ---- option A deliberate faults (each must break its rule) ----
 ("fault.a-per-branch-limit", A, "a-fault", "Spec", a(limit=3, fault="per-branch-limit"), ["Inv_StepsBound"], [],
  "VIOLATION:Inv_StepsBound", False, "maxNodeExecutions counted per branch lets the run exceed it."),
 ("fault.a-exec-id", A, "a-fault", "Spec", a(fault="exec-id-unqualified"), ["Inv_RowsOwned"], [], "VIOLATION:Inv_RowsOwned", False,
  "Node ids without the branch scope: two branches share one node execution."),
 ("fault.a-model-key", A, "a-fault", "Spec", a(agents=(1, 2), fault="model-key-unqualified"), ["Inv_ModelKeysDistinct"], [],
  "VIOLATION:Inv_ModelKeysDistinct", False, "Per-node model choices keyed by the state name only: two branches share one."),
 ("fault.a-route-global", A, "a-fault", "Spec", a(fault="route-global"), ["Inv_BranchConfined"], [], "VIOLATION:Inv_BranchConfined", False,
  "Route targets resolved in one name space: a branch routes into another branch."),
 ("fault.a-branch-catchall", A, "a-fault", "Spec", a(canfail=(1,), catchall=True, fault="branch-catchall"), ["Inv_BranchConfined"], [],
  "VIOLATION:Inv_BranchConfined", False, "A branch error goes to the workflow's catch-all."),
 ("fault.a-no-cas", A, "a-fault", "Spec", a(crash=1, fault="no-cas"), ["Inv_OneDecision"], [], "VIOLATION:Inv_OneDecision", False,
  "The join's decision without compare-and-swap: a retried transaction decides twice."),
 ("fault.a-admit-after-decision", A, "a-fault", "Spec", a(k=1, all_=False, two=(1, 2), fault="admit-after-decision"),
  ["Inv_NoStartAfterDecision", "Inv_NoRouteAfterDecision"], [], "VIOLATION:Inv_NoStartAfterDecision|Inv_NoRouteAfterDecision", False,
  "The controller keeps the losers' cursors after the decision."),
 ("fault.a-cut-new-only", A, "a-fault", "Spec", a(k=1, all_=False, agents=(2,), hang=(2,), fault="cut-returns-new-only"),
  ["Inv_CutMeansAsked"], [], "VIOLATION:Inv_CutMeansAsked", False,
  "The cut returns only what it cancelled itself: the decision already cut the loser, whose child is never ended."),
 ("fault.a-stop-cuts", A, "a-fault", "Spec", a(stop=True, fault="stop-cuts-started"), ["Inv_StopLetsStartedFinish"], [],
  "VIOLATION:Inv_StopLetsStartedFinish", False, "A graceful stop that cancels started work at once."),
 ("fault.a-count-late", A, "a-fault", "Spec", a(k=1, all_=False, timer=True, fault="count-late"), ["Inv_WinnersOnTime"], [],
  "VIOLATION:Inv_WinnersOnTime", False, "A success committed after the time limit counts."),
 ("fault.a-winners-by-index", A, "a-fault", "Spec", a(k=1, all_=False, fault="winners-by-index"), ["Inv_WinnersCommitOrder"], [],
  "VIOLATION:Inv_WinnersCommitOrder", False, "First k by branch order, not commit order."),
 ("fault.a-old-visit", A, "a-fault", "Spec", a(routes="retry", ff=True, canfail=(2,), limit=8, fault="count-old-visit"),
  ["Inv_VisitIsolated"], [], "VIOLATION:Inv_VisitIsolated", False, "Branch scopes not per fork visit: a second visit counts the first one's success."),
 ("fault.a-no-cut", A, "a-fault", "Spec", a(k=1, all_=False, hang=(2,), fault="no-cut"), ["Inv_DroppedNoPending"], [],
  "VIOLATION:Inv_DroppedNoPending", False, "The losers are never cancelled."),
 # ---- fj2: implementation-shaped cases (da66611a) ----
 ("impl.past-cut", A, "impl", "Spec", a(two=(1, 2), k=1, all_=False, timer=True, limit=7), SAFE, [], "PASS", True,
  "Past the time limit the store refuses a branch's next work state; the controller ends the branch and asks the join."),
 ("impl.past-cut-refines", A, "impl", "Spec", a(two=(1,), timer=True, hang=(2,), limit=6), SAFE, REF, "PASS", True,
  "As above, against the intended specification."),
 ("impl.past-cut-live", A, "impl", "LiveSpec", a(two=(1,), k=1, all_=False, timer=True, limit=6), SAFE, PROPS[:3], "PASS", True,
  "As above: decided, ended, effects settled (fj3: smaller than fj2's, which timed out at 300 s with 51,100 distinct states)."),
 ("impl.entry-error", A, "impl", "Spec", a(entryerr=True, timer=True, crash=1), SAFE, [], "PASS", True,
  "A branch input or the inputSchema fails at entry: invalid_input, no branch starts, the fork's error route takes it."),
 ("impl.entry-error-catchall", A, "impl", "Spec", a(entryerr=True, routes="noTimeout", catchall=True), SAFE, [], "PASS", True,
  "The entry error with no error route: the catch-all, once."),
 ("impl.entry-error-refines", A, "impl", "Spec", a(entryerr=True, ff=True, timer=True, cancel=True), SAFE, REF, "PASS", True,
  "The entry error against the intended specification."),
 ("impl.entry-error-live", A, "impl", "LiveSpec", a(entryerr=True, routes="retry", ff=True, limit=6), SAFE, PROPS[:3], "PASS", True,
  "The entry error with a retry route back to the fork: the run ends."),
 ("wit.impl-past-cut", A, "impl-wit", "Spec", a(two=(1, 2), k=1, all_=False, timer=True, limit=7), ["W_NoPastCut"], [],
  "VIOLATION:W_NoPastCut", True, "A branch is refused past the time limit."),
 ("wit.impl-entry-error", A, "impl-wit", "Spec", a(entryerr=True), ["W_NoEntryError"], [], "VIOLATION:W_NoEntryError", True,
  "The fork fails at entry."),
 ("fault.impl-r2-stop-settles", A, "impl-fault", "Spec", a(k=1, all_=False, stop=True, timer=True, hang=(2,), stopfence="none"),
  ["Inv_NoSettleAfterStop"], [], "VIOLATION:Inv_NoSettleAfterStop", False,
  "NB-R2, code at 3f3e96fb: after an accepted graceful stop the fork's time limit (or join) still decides, cuts started work and writes a report."),
 ("impl.r2-stop-fenced", A, "impl", "Spec", a(k=1, all_=False, stop=True, timer=True, hang=(2,), crash=1), SAFE, [], "PASS", True,
  "NB-R2 rule: after an accepted stop the fork settles nothing; started work runs on; the stop cancels the fork without a report."),
 ("impl.r2-stop-fenced-ff", A, "impl", "Spec", a(ff=True, stop=True, canfail=(1, 2), two=(2,), limit=7), SAFE, [], "PASS", True,
  "NB-R2 rule with failFast: a branch failure after the stop does not decide the fork."),
 ("impl.r2-stop-fenced-refines", A, "impl", "Spec", a(k=1, all_=False, stop=True, timer=True, hang=(2,)), SAFE, REF, "PASS", True,
  "NB-R2 rule against the intended specification."),
 ("impl.r2-stop-fenced-live", A, "impl", "LiveSpec", a(k=1, all_=False, stop=True, timer=True, hang=(2,), agents=(2,)), SAFE,
  ["Prop_StopEnds", "Prop_StopSettles"], "PASS", True, "NB-R2 rule: a requested stop still ends the run and settles every effect."),
 ("fault.impl-r5-two-step", A, "impl-fault", "Spec", a(ff=True, canfail=(1, 2), alljoin="two-step"),
  ["Inv_CutOnlyWithDecision"], [], "VIOLATION:Inv_CutOnlyWithDecision", False,
  "NB-R5, code at 3f3e96fb: join all with failFast and no time limit cuts the other branches in one transaction and decides in a later one."),
 ("impl.r5-one-tx", A, "impl", "Spec", a(ff=True, canfail=(1, 2), two=(2,), crash=1, cancel=True, limit=7), SAFE, [], "PASS", True,
  "NB-R5 rule: the store's verdict, the cut and the decision in one transaction, with a crash and cancel now."),
 ("impl.r5-one-tx-stop", A, "impl", "Spec", a(ff=True, canfail=(1, 2), stop=True, hang=(2,)), SAFE, [], "PASS", True,
  "NB-R5 rule with a graceful stop between a branch failure and the decision."),
 ("impl.r5-one-tx-refines", A, "impl", "Spec", a(ff=True, canfail=(1, 2), crash=1), SAFE, REF, "PASS", True,
  "NB-R5 rule against the intended specification."),
 # ---- option B: the free token design ----
 ("b.clean-arcs", TOK, "b-safety", "Spec", tk(), BSAFE, [], "PASS", True, "A well-formed fork and join: no hazard."),
 ("b.chain-count", TOK, "b-safety", "Spec", tk(graph="chain", join="count"), BSAFE, [], "PASS", True,
  "A well-formed fork with a two-state branch, count join."),
 ("b.clean-live", TOK, "b-live", "LiveSpec", tk(), BSAFE, ["Prop_RunEnds"], "PASS", True, "The well-formed run ends."),
 ("b.dangling-ends", TOK, "b-hazard", "Spec", tk(graph="dangling"), ["Inv_NoSiblingDiscarded"], [],
  "VIOLATION:Inv_NoSiblingDiscarded", False, "A terminal inside a branch ends the run while the other branch runs."),
 ("b.dangling-waits", TOK, "b-hazard", "LiveSpec", tk(graph="dangling", tends=False), ["TypeOK"], ["Prop_RunEnds"],
  "VIOLATION:Prop_RunEnds", False, "The terminal ends only its token: the join waits forever for it."),
 ("b.loop-joins-mixed", TOK, "b-hazard", "Spec", tk(graph="loop", maxtok=5), ["Inv_JoinExact"], [], "VIOLATION:Inv_JoinExact", False,
  "A loop back over the fork: the join consumes tokens of two different fork visits."),
 ("b.loop-crosses-fork", TOK, "b-hazard", "Spec", tk(graph="loop", maxtok=5), ["Inv_NoLoopFork"], [], "VIOLATION:Inv_NoLoopFork", False,
  "A branch token re-enters the fork."),
 ("b.cross-count", TOK, "b-hazard", "Spec", tk(graph="cross", join="count"), ["Inv_JoinExact"], [], "VIOLATION:Inv_JoinExact", False,
  "A branch routes into the other branch: the count join fires with branch A's result missing."),
 ("b.cross-node", TOK, "b-hazard", "Spec", tk(graph="cross"), ["Inv_NoCross"], [], "VIOLATION:Inv_NoCross", False,
  "A branch routes into the other branch."),
 ("b.cross-twice", TOK, "b-hazard", "Spec", tk(graph="cross"), ["Inv_NoTwoOnNode"], [], "VIOLATION:Inv_NoTwoOnNode", False,
  "One state runs for two tokens at once."),
 ("b.cross-waits", TOK, "b-hazard", "LiveSpec", tk(graph="cross"), ["TypeOK"], ["Prop_RunEnds"], "VIOLATION:Prop_RunEnds", False,
  "The arcs join waits forever for branch A's arc."),
 ("b.error-escapes", TOK, "b-hazard", "Spec", tk(err=True), ["Inv_ErrorBranchLocal"], [], "VIOLATION:Inv_ErrorBranchLocal", False,
  "An unrouted error in one branch fails the run while the other runs."),
 # ---- option C: the compile check and the compiled semantics ----
 ("c.refuses-dangling", TOK, "c-compile", "Spec", tk(graph="dangling"), ["Inv_CompileRefuses"], [], "PASS", False, "Refused: a terminal inside a branch."),
 ("c.refuses-loop", TOK, "c-compile", "Spec", tk(graph="loop", maxtok=5), ["Inv_CompileRefuses"], [], "PASS", False, "Refused: a loop over the fork."),
 ("c.refuses-cross", TOK, "c-compile", "Spec", tk(graph="cross"), ["Inv_CompileRefuses"], [], "PASS", False, "Refused: a cross edge."),
 ("c.accepts-clean", TOK, "c-compile", "Spec", tk(), ["Inv_CompileAccepts"], [], "PASS", True, "Accepted."),
 ("c.accepts-chain", TOK, "c-compile", "Spec", tk(graph="chain"), ["Inv_CompileAccepts"], [], "PASS", True, "Accepted."),
 ("c.clean-refines", TOK, "c-refine", "Spec", tk(sem="compiled"), BSAFE, REF, "PASS", True,
  "Option C on an accepted graph refines AbsForkJoin (join all of two)."),
 ("c.chain-refines", TOK, "c-refine", "Spec", tk(graph="chain", sem="compiled"), BSAFE, REF, "PASS", True, "As above, a two-state branch."),
 ("c.error-refines", TOK, "c-refine", "Spec", tk(sem="compiled", err=True), BSAFE, REF, "PASS", True,
  "As above, with a branch error: branch-local, the join is blocked."),
 ("c.clean-live", TOK, "c-live", "LiveSpec", tk(sem="compiled", err=True), BSAFE, ["Prop_RunEnds"], "PASS", True, "The compiled run ends."),
 ("wit.c-blocked", TOK, "c-wit", "Spec", tk(sem="compiled", err=True), ["W_NotBlocked"], [], "VIOLATION:W_NotBlocked", True,
  "A compiled branch error blocks the join."),
]

def cfg(cid, spec, consts, invs, props, deadlock, note, expected):
    lines = [f"\\* {cid} ({BATCH}; expected {expected}): {note}", f"SPECIFICATION {spec}", "CONSTANTS"]
    lines += [f"    {k} = {str(v).upper() if isinstance(v, bool) else v}" for k, v in consts.items()]
    if invs:
        lines += ["INVARIANTS"] + [f"    {i}" for i in invs]
    if props:
        lines += ["PROPERTIES"] + [f"    {p}" for p in props]
    lines.append(f"CHECK_DEADLOCK {'TRUE' if deadlock else 'FALSE'}")
    return "\n".join(lines) + "\n"

def main():
    rows, meta = [], []
    for cid, mod, group, spec, consts, invs, props, expected, deadlock, note in CASES:
        name = f"{cid}.cfg"
        with open(name, "w") as f:
            f.write(cfg(cid, spec, consts, invs, props, deadlock, note, expected))
        rows.append(f"{cid}\t{name}\t{mod}")
        meta.append(dict(id=cid, module=mod, group=group, spec=spec, config=name, invariants=invs, properties=props,
                         expected=expected, deadlock=deadlock, note=note, batch=BATCH, head="design"))
    assert len({r.split()[0] for r in rows}) == len(rows)
    with open("cases.tsv", "w") as f:
        f.write("\n".join(rows) + "\n")
    with open("cases.json", "w") as f:
        json.dump(meta, f, indent=1)
    print(len(rows), "cases")

if __name__ == "__main__":
    main()
