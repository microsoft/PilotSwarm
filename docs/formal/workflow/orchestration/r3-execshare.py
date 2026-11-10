# r3: WfExecShare at 9a8d0f66 (E1d: commit 2a372b5a, in the PR head through the squash d7c3ca68).
# Exec this after gen-cases.py's helpers (g, a, p, el, es, S_INV8, ...) and before CASES is written out:
#   - es(...) replaces the helper: two new constants, AllowLate and ListingRace, default FALSE, so every
#     earlier case keeps its r2 behaviour (its settings file only gains the two lines).
#   - R3_EXECSHARE lists the new cases in the CASES format.
# Every settings file of WfExecShare must be regenerated with this es(): the revised module declares the two
# constants, and TLC refuses a settings file that leaves a constant unassigned.

def es(n=3, tdfail=True, shutdown=True, revoke=True, end=True, fault="none", dep=False, head="proposedE1b",
       unsettled=False, unattr=False, boundary=False, listfail=False, late=False, listrace=False):
    return dict(el(n, tdfail, shutdown, revoke, end, fault, dep), Code=f'"{head}"', AllowUnsettled=unsettled,
                AllowUnattributed=unattr, AllowBoundary=boundary, AllowListingFail=listfail,
                AllowLate=late, ListingRace=listrace)

E1C = "412f7b00"   # E1c (r2f)
E1D = "9a8d0f66"   # E1d: barrier causes (E1c-R1), whole-turn close and late task cancel (E1c-R2)
R3_INV = S_INV8 + ["Inv_BarrierWhileCause", "Inv_CausesKept", "Inv_NoOrphanTask", "Inv_ReleasedTaskCancelled"]

# id, module, mode, spec, constants, invariants, properties, expected, note
R3_EXECSHARE = [
 # ---- 9a8d0f66: the code as written ----
 ("exec.r3-safety", "WfExecShare", "reviewed", "Spec", es(head=E1D, unsettled=True, late=True), R3_INV, [], "PASS",
  "E1d at 9a8d0f66: every E1c rule, an abort that does not settle, late catalog checks; the barrier is a set of causes, none lost or lifted by another's work."),
 ("exec.r3-race", "WfExecShare", "reviewed", "Spec", es(n=2, head=E1D, unsettled=True, unattr=True, late=True, listrace=True), R3_INV, [], "PASS",
  "E1c-R2 at 9a8d0f66: the listing after a call is its own step; a close waits for the whole turn, so a task with no start time is claimed and cancelled."),
 ("exec.r3-late-task", "WfExecShare", "reviewed", "Spec", es(n=2, head=E1D, unsettled=True, tdfail=False), ["TypeOK", "Inv_ReleasedTaskCancelled", "Inv_NoOrphanTask"], [], "PASS",
  "E1c-R2 at 9a8d0f66: a task the listing gives to an owner released after its abort did not settle is cancelled at once."),
 ("exec.r3-unlisted", "WfExecShare", "reviewed", "Spec", es(head=E1D, unattr=True, boundary=True, listfail=True), ["Inv_NoOrphanBackgroundAll"], [], "safety",
  "9a8d0f66 keeps the documented limit of exec.e1c-unlisted: a task no listing claimed and no window holds is left to the last owner's teardown."),
 ("exec.r3-live", "WfExecShare", "reviewed", "LiveSpec", es(n=2, head=E1D, unsettled=True, unattr=True, late=True, listrace=True), [], ["Prop_WaitersServed", "Prop_BarrierResolved"], "PASS",
  "9a8d0f66: every waiter is served, refused or aborted; a raised barrier is cleared or the share is torn down."),
 ("exec.r3-dep", "WfExecShare", "reviewed", "LiveSpec", es(n=2, dep=True, tdfail=False, shutdown=False, revoke=False, end=False, head=E1D, listrace=True), [], ["Prop_BothComplete"], "PASS",
  "9a8d0f66: the sibling dependency completes, with the listing after each call as its own step of the turn."),
 ("exec.r3-late-lifted", "WfExecShare", "reviewed", "LiveSpec", es(n=2, head=E1D, late=True, tdfail=False), [], ["Prop_BarrierCleared"], "PASS",
  "9a8d0f66: a late catalog check's cause is lifted when the check ends; with no failure cause the barrier always clears."),
 ("exec.r3-barrier-stays", "WfExecShare", "reviewed", "LiveSpec", es(n=2, head=E1D, unsettled=True, tdfail=False, shutdown=False, revoke=False, end=False), [], ["Prop_BarrierCleared"], "liveness",
  "9a8d0f66 (by design): the cause of a call that did not end is never lifted by the call's end; only a worker restart lifts it (not modeled)."),
 ("exec.r3-wit-before-cancel", "WfExecShare", "witness", "Spec", es(n=2, head=E1D, unsettled=True), ["Wit_TaskBeforeCancel"], [], "safety",
  "9a8d0f66: a task given to a released owner runs between the listing and its cancel (behind the cause of the call that did not end)."),
 # ---- 412f7b00: what changed ----
 ("cmp.exec-r3-slot-412", "WfExecShare", "comparison", "Spec", es(n=2, head=E1C, late=True), ["Inv_BarrierWhileCause"], [], "safety",
  "E1c-R1 at 412f7b00: two late catalog checks; the later one replaces the barrier and lifts it at its end while the earlier one still runs."),
 ("cmp.exec-r3-slot-setup-412", "WfExecShare", "comparison", "Spec", es(head=E1C, late=True), ["Inv_NoSetupAfterFailedTeardown"], [], "safety",
  "E1c-R1 at 412f7b00: a late check's barrier replaces a failed cancel's; its lift clears the barrier and a new share is set up (VR-2)."),
 ("cmp.exec-r3-race-412", "WfExecShare", "comparison", "Spec", es(n=2, head=E1C, unattr=True, listrace=True), ["Inv_NoOrphanTask"], [], "safety",
  "E1c-R2 at 412f7b00: a close between the call's end and its task listing does not wait; a task with no start time outlives its owner while the other holds the share, no barrier."),
 ("cmp.exec-r3-late-task-412", "WfExecShare", "comparison", "Spec", es(n=2, head=E1C, unsettled=True, tdfail=False), ["Inv_ReleasedTaskCancelled"], [], "safety",
  "E1c-R2 at 412f7b00: a task given to an owner released after an unsettled abort is never cancelled by it; it is left to the last owner's teardown (behind the barrier)."),
 # Smaller settings for the two liveness cases that did not finish in 300 s at N = 3 (r3 run): two owners.
 ("exec.e1b-8dd-live-n2", "WfExecShare", "reviewed", "LiveSpec", es(n=2, head=E1B, unsettled=True), [], ["Prop_WaitersServed"], "PASS",
  "E1b at 8dd3eae1 with two owners: every waiter is served, refused or aborted."),
 ("exec.e1c-live-n2", "WfExecShare", "reviewed", "LiveSpec", es(n=2, head=E1C, unsettled=True), [], ["Prop_WaitersServed"], "PASS",
  "E1c at 412f7b00 with two owners: every waiter is served, refused or aborted."),
]
