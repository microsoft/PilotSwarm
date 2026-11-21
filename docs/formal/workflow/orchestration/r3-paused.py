# r3 (WfPaused bound to 9a8d0f66). exec() this after gen-cases.py's helpers (W_INV, E2, w, CASES).
# It replaces w() (the new constants default to the old behaviour), defines R3_PAUSED (new cases), and
# r3_paused_patch(cases), which completes the constants of the earlier WfPaused cases (the module now
# declares TimedJoin, AllowEndElsewhere, AllowCutFail and AllowPause, so every WfPaused .cfg must set them).

def w(head="efe44835", resume=False, complete=False, endfail=False, first=True,
      timed=False, endelse=False, cutfail=False, pause=True):
    return dict(Code=f'"{head}"', AllowResume=resume, AllowChildComplete=complete, AllowEndFail=endfail, PauseFirst=first,
                TimedJoin=timed, AllowEndElsewhere=endelse, AllowCutFail=cutfail, AllowPause=pause)

R3_PAUSED_DEFAULTS = dict(TimedJoin=False, AllowEndElsewhere=False, AllowCutFail=False, AllowPause=True)

def r3_paused_patch(cases):
    """Earlier WfPaused cases (built with the old w()) get the new constants at their defaults (old behaviour)."""
    out = []
    for c in cases:
        if c[1] == "WfPaused":
            consts = dict(c[4])
            for k, v in R3_PAUSED_DEFAULTS.items():
                consts.setdefault(k, v)
            c = (c[0], c[1], c[2], c[3], consts) + tuple(c[5:])
        out.append(c)
    return out

N9 = "9a8d0f66"      # PR head: controller 1.9.0 with S-RT1, S7-DX2/DX3, IR 9 timed joins, J1d
FIXR3 = "proposedR3"  # 9a8d0f66 + the cut also ends (or owes) a cut branch's decided agent state's child
W_INV_R3 = W_INV + ["Inv_NoRouteWhilePaused", "Inv_NoRouteAfterEnd", "Inv_TimedJoinCut",
                    "Inv_ParallelRoutedAfterCut", "Inv_CutNotRouted"]

# id, module, mode, spec, constants, invariants, properties, expected, note
R3_PAUSED = [
 # ---- safety at the new head ----
 ("paused.r3-safety", "WfPaused", "reviewed", "Spec",
  w(N9, resume=True, complete=True, endfail=True, first=False, timed=True, endelse=True, cutfail=True), W_INV_R3, [], "PASS",
  "9a8d0f66: nothing admitted or routed while paused (pause found by the admission or the collection), nothing routed after a run's end, a timed join's decision cuts at once and routes only after the cut, a cut result goes nowhere."),
 ("paused.r3-route-paused", "WfPaused", "reviewed", "Spec", w(N9, complete=True, first=False), ["TypeOK", "Inv_NoRouteWhilePaused"], [], "PASS",
  "S-RT1 at 9a8d0f66: with every cursor waiting on work, the collection reads the pause and routes nothing (cmp.paused-r3-route-paused-a99 breaks)."),
 ("paused.r3-ended-safety", "WfPaused", "reviewed", "Spec", w(N9, complete=True, first=False, endelse=True), ["TypeOK", "Inv_NoRouteAfterEnd"], [], "PASS",
  "S7-DX2/DX3 at 9a8d0f66: a collection that reads the run ended routes nothing and goes to endedElsewhere (cmp.paused-r3-ended-a99 breaks)."),
 # ---- liveness at the new head ----
 ("paused.r3-live-paused", "WfPaused", "reviewed", "LiveSpec", w(N9, complete=True, endfail=True), [],
  ["Prop_DeadlineEnforced", "Prop_TimedOutChildEnded", "Prop_DoneChildEnded"], "PASS",
  "9a8d0f66, no time limit, permanently paused: the paused pass elapses the state and ends its child, a failed end is tried again (as a99cd382)."),
 ("paused.r3-live-any", "WfPaused", "reviewed", "LiveSpec", w(N9, resume=True, complete=True, first=False), [],
  ["Prop_DeadlineEnforced", "Prop_TimedOutChildEnded", "Prop_DoneChildEnded"], "PASS",
  "9a8d0f66, no time limit, a pause at any time (found by the admission or, S-RT1, by the collection) and a resume."),
 ("paused.r3-timed-live", "WfPaused", "reviewed", "LiveSpec", w(N9, timed=True, cutfail=True), [],
  ["Prop_DeadlineEnforced", "Prop_TimedOutChildEnded", "Prop_TimedJoinDecided", "Prop_CutChildEnded", "Prop_OwedCutMade"], "PASS",
  "IR 9 Q2 and J1d at 9a8d0f66, permanently paused: the time limit decides the parallel state and cuts its branches while paused; a cut child's failed end is owed and made by the retries of later paused passes."),
 ("paused.r3-resume-routed", "WfPaused", "reviewed", "ResumeSpec",
  w(N9, resume=True, complete=True, endfail=True, first=False, timed=True, cutfail=True), [],
  ["Prop_DecidedRouted", "Prop_ParallelRouted", "Prop_TimedJoinDecided", "Prop_CutChildEnded", "Prop_OwedCutMade"], "PASS",
  "9a8d0f66 with a resume: a result read by the collection that found the pause stays in its cursor and is routed after the resume (or its branch was cut); the parallel state's own result is routed after the resume."),
 ("paused.r3-ended", "WfPaused", "reviewed", "LiveSpec",
  w(N9, resume=True, complete=True, endfail=True, first=False, timed=True, endelse=True, cutfail=True), [],
  ["Prop_EndedReported"], "PASS",
  "S7-DX3 at 9a8d0f66: a run another writer ended is found by the next admission, paused collection or collection, and reported (endedElsewhere)."),
 # ---- witnesses (reachability) ----
 ("paused.r3-wit-pause-at-collect", "WfPaused", "witness", "Spec", w(N9, complete=True, first=False), ["Wit_PauseAtCollect"], [], "safety",
  "S-RT1 is exercised: a collection that read a result finds the pause and hands it to the paused pass."),
 ("paused.r3-wit-paused-cut", "WfPaused", "witness", "Spec", w(N9, timed=True), ["Wit_PausedCut"], [], "safety",
  "IR 9 Q2 is exercised: a time limit decided while paused cuts the branches; the state's result waits for the resume."),
 # ---- finding R3-P1 at the new head ----
 ("paused.r3-cut-done-child", "WfPaused", "reviewed", "LiveSpec", w(N9, complete=True, timed=True), [], ["Prop_DoneChildEnded"], "liveness",
  "R3-P1: the child completes its branch state after the paused pass collected and before its time limit is elapsed; the cut drops the cursor and cancelBranchScopes lists only work a cut decided, so the child is never ended while paused."),
 ("paused.r3-cut-timedout-endfail", "WfPaused", "reviewed", "LiveSpec", w(N9, endfail=True, timed=True), [], ["Prop_TimedOutChildEnded"], "liveness",
  "R3-P1: a timed-out branch state's end fails on the paused pass, and the time limit cuts the branch in the same pass: the end is not tried again while paused (a99cd382's retry is lost)."),
 ("paused.r3-cut-done-running", "WfPaused", "reviewed", "LiveSpec", w(N9, complete=True, first=False, pause=False, timed=True), [], ["Prop_DoneChildEnded"], "liveness",
  "R3-P1 without a pause: step 2 asks the timed join before it collects, so a completed, uncollected branch state's child is not ended before the run's end (the model has no run end here)."),
 # ---- comparisons ----
 ("cmp.paused-r3-route-paused-a99", "WfPaused", "comparison", "Spec", w(E2, complete=True, first=False), ["TypeOK", "Inv_NoRouteWhilePaused"], [], "safety",
  "Before S-RT1 (a99cd382): with every cursor waiting on work only an admission finds the pause, so a result collected while paused is routed."),
 ("cmp.paused-r3-ended-a99", "WfPaused", "comparison", "Spec", w(E2, complete=True, first=False, endelse=True), ["TypeOK", "Inv_NoRouteAfterEnd"], [], "safety",
  "Before S7-DX2/DX3 (a99cd382): the collection does not read a run's end, so an ended run's result is routed."),
 ("cmp.paused-r3-fix-cut-paused", "WfPaused", "comparison", "LiveSpec", w(FIXR3, complete=True, endfail=True, timed=True, cutfail=True), [],
  ["Prop_DoneChildEnded", "Prop_TimedOutChildEnded", "Prop_CutChildEnded", "Prop_OwedCutMade", "Prop_TimedJoinDecided"], "PASS",
  "R3-P1 fix (proposed): the cut also ends, or owes, the child of a cut branch's decided agent state whose end is not recorded; the paused findings pass."),
 ("cmp.paused-r3-fix-cut-running", "WfPaused", "comparison", "LiveSpec", w(FIXR3, complete=True, first=False, pause=False, timed=True, cutfail=True), [],
  ["Prop_DoneChildEnded", "Prop_TimedOutChildEnded", "Prop_CutChildEnded", "Prop_OwedCutMade"], "PASS",
  "R3-P1 fix (proposed), running: a completed branch state's child is ended by the cut."),
 ("cmp.paused-r3-fix-safety", "WfPaused", "comparison", "Spec",
  w(FIXR3, resume=True, complete=True, endfail=True, first=False, timed=True, endelse=True, cutfail=True), W_INV_R3, [], "PASS",
  "R3-P1 fix (proposed): the safety rules still hold."),
]
