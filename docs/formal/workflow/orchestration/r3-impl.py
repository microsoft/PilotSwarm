# r4 (2026-11-09): the three r3 findings' fixes bound to the branch head a9f60db7 (a9f60db71e1c, on 9a8d0f66).
# exec() this after gen-cases.py's helpers and the four r3-*.py files (it reads R3_GRAPH, R3_PARENT, R3_PAUSED and
# their invariant lists). It defines R3_IMPL, new case tuples in the CASES format:
#   (id, module, mode, spec, constants, invariants, properties, expected, note)
# Each case copies the constants of an r3 case (so its settings are the same) and changes only the head:
#   WfGraph  Elsewhere = "a9f60db7": "any" (9a8d0f66, S7-DX3) plus the R3-GR1 fix (5a7be64b: observeEnd's `deleted`
#            only when the deletion ended the run, or the run is still active);
#   WfParent Code = "a9f60db7": proposedNoteTx as committed (R3-PA1, 30660458: store.keepNoticeAsNote);
#   WfPaused Code = "a9f60db7": proposedR3 as committed (R3-PS1, 0944f872: cancelBranchScopes returns the owed ones).
# No earlier case changes: the modules keep every earlier value's actions.

IMPL = "a9f60db7"

def _src(cases, cid):
    found = [c for c in cases if c[0] == cid]
    assert len(found) == 1, cid
    return found[0]

def _rebind(cases, cid, new_id, key, invs=None, props=None, note="", extra=None):
    """The r3 case `cid` with constant `key` set to the a9f60db7 value (and `extra` overrides), expected PASS."""
    c = _src(cases, cid)
    consts = dict(c[4])
    assert key in consts, (cid, key)
    consts[key] = f'"{IMPL}"'
    for k, v in (extra or {}).items():
        assert k in consts, (cid, k)
        consts[k] = v
    return (new_id, c[1], "reviewed", c[3], consts, list(c[5] if invs is None else invs),
            list(c[6] if props is None else props), "PASS", note)

R3_IMPL = [
 # ---- WfGraph: R3-GR1 fixed (5a7be64b) ----
 _rebind(R3_GRAPH, "graph.r3-delete-after-cmd", "impl.graph-delete-after-cmd", "Elsewhere",
  note="R3-GR1 at a9f60db7 (5a7be64b): a cancel accepted, then the workflow deleted before observeEnd; the run's end is the cancel's (not runEndedByDeletion), so the cancel's end is told."),
 _rebind(R3_GRAPH, "graph.r3-delete-after-retry", "impl.graph-delete-after-retry", "Elsewhere",
  note="R3-GR1 at a9f60db7, own end: the finish commits completed, the worker crashes, the workflow is deleted, the retry answers elsewhere; observeEnd reads a completed run, not deleted: the completion is told."),
 _rebind(R3_GRAPH, "graph.r3-linear", "impl.graph-linear", "Elsewhere",
  note="a9f60db7: graph.r3-linear's settings (every other end, deletions also after the end, retries): told at most once, only of an ended run, after its children, never of a deleted run, never by a losing command."),
 _rebind(R3_GRAPH, "graph.r3-loop", "impl.graph-loop", "Elsewhere",
  note="a9f60db7: graph.r3-loop's settings (a loop that reaches its node limit): the same rules."),
 _rebind(R3_GRAPH, "graph.r3-par", "impl.graph-par", "Elsewhere",
  note="a9f60db7: graph.r3-par's settings (a parallel state, two branches at once, failFast): the same rules."),
 _rebind(R3_GRAPH, "graph.r3-live-linear", "impl.graph-live-linear", "Elsewhere",
  note="a9f60db7: graph.r3-live-linear's settings: every end but a deletion is reported once after its children; a deletion ends the children only; the controller ends."),
 _rebind(R3_GRAPH, "graph.r3-live-loop", "impl.graph-live-loop", "Elsewhere",
  note="a9f60db7: graph.r3-live-loop's settings: the same progress rules."),
 _rebind(R3_GRAPH, "graph.r3-live-par", "impl.graph-live-par", "Elsewhere",
  note="a9f60db7: graph.r3-live-par's settings: the same progress rules."),
 _rebind(R3_GRAPH, "graph.r3-live-linear", "impl.graph-live-linear-all", "Elsewhere",
  extra={"OtherEnds": '{"chat", "retry", "delete_after"}'},
  note="a9f60db7: graph.r3-live-linear with a deletion after the end too (excluded at 9a8d0f66 by R3-GR1): every progress rule holds."),
 _rebind(R3_GRAPH, "graph.r3-chat-reported", "impl.graph-chat-reported", "Elsewhere",
  note="a9f60db7: the owning chat's end is reported by the controller (endedElsewhere -> reportEnded)."),
 _rebind(R3_GRAPH, "graph.r3-finish-deleted", "impl.graph-finish-deleted", "Elsewhere",
  note="a9f60db7: a finish that finds the run deleted (the deletion ended it: runEndedByDeletion) tells no one."),
 _rebind(R3_GRAPH, "graph.r3-queue-loser", "impl.graph-queue-loser", "Elsewhere",
  note="a9f60db7: a queued cancel that lost to the chat's end or a deletion: the stored end decides the notice."),
 # ---- WfParent: R3-PA1 fixed (30660458) ----
 _rebind(R3_PARENT, "parent.r3-told-twice", "impl.parent-told-once", "Code", invs=P_INV_R3 + ["Inv_ToldOnce"],
  note="R3-PA1 at a9f60db7 (30660458): the note and its skip are one transaction (keepNoticeAsNote), so a crash leaves neither; the end is given once."),
 _rebind(R3_PARENT, "parent.r3-safety-send", "impl.parent-safety-send", "Code", invs=P_INV_R3 + ["Inv_ToldOnce"],
  note="a9f60db7: parent.r3-safety-send's settings; every safety rule, told-once included."),
 _rebind(R3_PARENT, "parent.r3-safety-request", "impl.parent-safety-request", "Code", invs=P_INV_R3 + ["Inv_ToldOnce"],
  note="a9f60db7: parent.r3-safety-request's settings (a request, its deadline, clock steps); every safety rule, told-once included."),
 _rebind(R3_PARENT, "parent.r3-live-send", "impl.parent-live-send", "Code",
  note="a9f60db7: parent.r3-live-send's settings: a late parent is given the end through its note, a started one through the notice."),
 _rebind(R3_PARENT, "parent.r3-live-request-n1", "impl.parent-live-request-n1", "Code",
  note="a9f60db7: parent.r3-live-request-n1's settings (one notifier; the two-notifier case did not finish in 1,800 s at 9a8d0f66)."),
 _rebind(R3_PARENT, "parent.r3-live-off", "impl.parent-live-off", "Code",
  note="a9f60db7 with notifications off: the skip is recorded, no note is kept."),
 # ---- WfPaused: R3-PS1 fixed (0944f872) ----
 _rebind(R3_PAUSED, "paused.r3-cut-done-child", "impl.paused-cut-done-child", "Code",
  note="R3-PS1 at a9f60db7 (0944f872): a branch state completed after the paused collection and cut by the time limit: the cut returns it (completed, end_sent_at NULL) and ends its child while paused."),
 _rebind(R3_PAUSED, "paused.r3-cut-timedout-endfail", "impl.paused-cut-timedout-endfail", "Code",
  note="R3-PS1 at a9f60db7: a timed-out branch state whose end failed on the paused pass is ended by the cut of the same pass."),
 _rebind(R3_PAUSED, "paused.r3-cut-done-running", "impl.paused-cut-done-running", "Code",
  note="R3-PS1 at a9f60db7, no pause: a completed, uncollected branch state's child is ended by the cut."),
 _rebind(R3_PAUSED, "paused.r3-safety", "impl.paused-safety", "Code",
  note="a9f60db7: paused.r3-safety's settings: nothing admitted or routed while paused or after the end; a timed join cuts at once; a cut result goes nowhere."),
 _rebind(R3_PAUSED, "paused.r3-live-paused", "impl.paused-live-paused", "Code",
  note="a9f60db7, permanently paused: the paused pass elapses the state and ends its child; a failed end is tried again."),
 _rebind(R3_PAUSED, "paused.r3-live-any", "impl.paused-live-any", "Code",
  note="a9f60db7: a pause at any time and a resume; every deadline enforced and every decided child ended."),
 _rebind(R3_PAUSED, "paused.r3-timed-live", "impl.paused-timed-live", "Code",
  note="a9f60db7, permanently paused: the time limit decides and cuts; a cut child's failed end is owed and made."),
 _rebind(R3_PAUSED, "paused.r3-resume-routed", "impl.paused-resume-routed", "Code",
  note="a9f60db7 with a resume: a result the pause held is routed after the resume (or its branch was cut); the parallel state's own result too."),
 _rebind(R3_PAUSED, "paused.r3-ended", "impl.paused-ended", "Code",
  note="a9f60db7: a run another writer ended is found and reported (endedElsewhere)."),
]
