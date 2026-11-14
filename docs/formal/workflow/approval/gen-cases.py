#!/usr/bin/env python3
"""Writes cases.tsv, cases.json and tlc-templates.json for the FB-007 approval model (no TLC is run here). The .cfg
files are generated from these by run-tlc.sh (../../tlc_cases.py)."""
import json
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", ".."))
import tlc_cases   # docs/formal/tlc_cases.py

BATCH = "ap4"
M = "WorkflowApproval"


def q(x):
    return f'"{x}"'


def caps(xs):
    return "{" + ", ".join(q(x) for x in sorted(xs)) + "}"


def reqs(xs):
    return "{" + ", ".join(q(x) for x in sorted(xs)) + "}"


def c(loop=False, rs=("ownA1",), pause=True, end=True, lose=True, dup=True, kept=True, reread=True, backstop=True,
      anyreader=False, atdl=False, nolock=False, bynode=False, noidem=False, noguard=False, whilepaused=False, d=2, maxt=3,
      rundl=9, mode="live", gate=True, stop=False, cut=False, ownerchange=False, can=False, canreread=True,
      pinnedonly=False, currentonly=False, nostopcheck=False, splitreceipt=False, fixturelive=False):
    return dict(D=d, MaxT=maxt, RunDl=rundl, Loop=loop, Reqs=reqs(rs), Mode=q(mode), Gate=gate, AllowPause=pause,
                AllowEnd=end, AllowStop=stop, AllowCut=cut, OwnerChange=ownerchange, AllowCan=can, LoseWake=lose,
                DupWake=dup, PausedWakeKept=kept, ResumeReread=reread, Backstop=backstop, CanReread=canreread,
                AnyReader=anyreader, AtDeadline=atdl, NoLock=nolock, MatchByNode=bynode, NoIdem=noidem,
                NoRouteGuard=noguard, RouteWhilePaused=whilepaused, PinnedOnly=pinnedonly, CurrentOnly=currentonly,
                NoStopCheck=nostopcheck, SplitReceipt=splitreceipt, FixtureLive=fixturelive)


SAFE = ["TypeOK", "Inv_OneDecision", "Inv_OnlyPinned", "Inv_BeforeDeadline", "Inv_ConsentFresh", "Inv_RoutedOnce",
        "Inv_NoStartUnlessRunning", "Inv_ReceiptStable", "Inv_OwnerAtDecision", "Inv_AuditAgrees",
        "Inv_NoAnswerAfterStop", "Inv_GateHolds"]
LIVE = ["Prop_Settles", "Prop_Routed"]
ALLR = ("ownA1", "ownConflict1", "readerA1", "agentA1", "newA1", "fixA1")
ENV = dict(stop=True, cut=True, ownerchange=True, can=True)
V1 = ("ownA1", "ownConflict1", "readerA1", "agentA1")
LP = ("ownA1", "ownR1", "ownA2", "ownR2")

# id, group, spec, constants, invariants, properties, expected, deadlock, note
CASES = [
 # ---- the design ----
 ("ap.design-v1", "design", "Spec", c(rs=V1), SAFE, [], "PASS", False,
  "One visit: the owner's approval, a conflicting reuse of its operation id, a reader and an agent; pause, end, lost and duplicate wakes."),
 ("ap.design-loop", "design", "Spec", c(loop=True, rs=LP), SAFE, [], "PASS", False,
  "A rejection routes back to a second visit with changed context; stale first-visit answers arrive late."),
 ("ap.live", "design", "LiveSpec", c(loop=True, rs=("ownA1", "ownR1", "ownA2")), ["TypeOK"], LIVE, "PASS", False,
  "Every record settles and every settled record of a live run is routed, with lost wakes and a pause."),
 ("ap.live-pause-reread", "design", "LiveSpec", c(kept=False), ["TypeOK"], LIVE, "PASS", False,
  "The controller forgets a wake taken while paused; the resume reads the record and routes it."),
 # ---- faults: each rule fails without its mechanism ----
 ("fault.ap-any-reader", "fault", "Spec", c(rs=("readerA1",), anyreader=True), ["Inv_OnlyPinned"], [],
  "VIOLATION:Inv_OnlyPinned", False, "A reader with Workflow access is allowed to decide."),
 ("fault.ap-at-deadline", "fault", "Spec", c(atdl=True), ["Inv_BeforeDeadline"], [], "VIOLATION:Inv_BeforeDeadline", False,
  "A decision at the deadline is accepted."),
 ("fault.ap-no-lock", "fault", "Spec", c(nolock=True), ["Inv_OneDecision"], [], "VIOLATION:Inv_OneDecision", False,
  "The decision checks, the timeout settles, then the decision writes over it."),
 ("fault.ap-match-by-node", "fault", "Spec", c(loop=True, rs=("ownR1", "ownA1"), bynode=True), ["Inv_ConsentFresh"], [],
  "VIOLATION:Inv_ConsentFresh", False, "An approval of the first visit's context, delivered late, approves the second visit."),
 ("fault.ap-no-idem", "fault", "Spec", c(noidem=True), ["Inv_ReceiptStable"], [], "VIOLATION:Inv_ReceiptStable", False,
  "No receipt per operation id: the retried approval is told it was refused."),
 ("fault.ap-no-route-guard", "fault", "Spec", c(noguard=True), ["Inv_RoutedOnce"], [], "VIOLATION:Inv_RoutedOnce", False,
  "A duplicate wake routes the decision twice."),
 ("fault.ap-route-while-paused", "fault", "Spec", c(whilepaused=True), ["Inv_NoStartUnlessRunning"], [],
  "VIOLATION:Inv_NoStartUnlessRunning", False, "A decision taken while paused starts the next step at once."),
 ("fault.ap-no-backstop", "fault", "LiveSpec", c(pause=False, backstop=False), ["TypeOK"], ["Prop_Routed"],
  "VIOLATION:Prop_Routed", False, "The wake is lost and the deadline timer only settles pending records: the run waits forever."),
 ("fault.ap-pause-forgets", "fault", "LiveSpec", c(kept=False, reread=False), ["TypeOK"], ["Prop_Routed"],
  "VIOLATION:Prop_Routed", False, "A wake taken while paused is forgotten and the resume does not read the record."),
 # ---- witnesses: each outcome is reachable ----
 ("wit.ap-approval", "witness", "Spec", c(), ["W_NoApproval"], [], "VIOLATION:W_NoApproval", False, "The owner approves."),
 ("wit.ap-second-visit", "witness", "Spec", c(loop=True, rs=LP), ["W_NoSecondVisitApproval"], [],
  "VIOLATION:W_NoSecondVisitApproval", False, "Rejected, then the changed context approved."),
 ("wit.ap-timeout-while-paused", "witness", "Spec", c(), ["W_NoTimeoutWhilePaused"], [],
  "VIOLATION:W_NoTimeoutWhilePaused", False, "Pausing does not extend the deadline."),
 ("wit.ap-accepted-then-ended", "witness", "Spec", c(), ["W_NoAcceptedThenEnded"], [], "VIOLATION:W_NoAcceptedThenEnded",
  False, "An accepted decision stays recorded when the run is cancelled, and starts nothing."),
 ("wit.ap-boundary-refusal", "witness", "Spec", c(), ["W_NoBoundaryRefusal"], [], "VIOLATION:W_NoBoundaryRefusal", False,
  "A decision delivered exactly at the deadline is refused."),
 # ---- ap2: the acknowledged contract e117753e and controller 1.1.0 ----
 ("ap2.design-contract", "design", "Spec", c(rs=ALLR, **ENV), SAFE, [], "PASS", False,
  "Live run: owner, conflicting reuse, reader, agent, a new owner and a test fixture answer; pause, stop, end, branch cut, owner change, continue-as-new, lost and duplicate wakes."),
 ("ap2.design-loop", "design", "Spec", c(loop=True, rs=("ownA1", "ownR1", "ownA2", "newA1"), dup=False, ownerchange=True,
  can=True), SAFE, [], "PASS", False,
  "Two visits with changed context, a late first-visit answer, an owner change and continue-as-new (stop and cut are in ap2.design-contract)."),
 ("ap2.test-mode", "design", "Spec", c(mode="test", rs=("ownA1", "fixA1"), **ENV), SAFE, [], "PASS", False,
  "A test run: the interception is decided only by a fixture; the owner's live answer is refused."),
 ("ap2.gate-off", "design", "Spec", c(gate=False, rs=ALLR), SAFE, [], "PASS", False, "Controller 1.0.0: no approval path."),
 ("ap2.run-deadline", "design", "Spec", c(rundl=1, rs=("ownA1",), stop=True), SAFE, [], "PASS", False,
  "The run's deadline is earlier than the approval's: it is the effective deadline."),
 ("ap2.live", "design", "LiveSpec", c(rs=("ownA1", "newA1"), **ENV), ["TypeOK"], LIVE + ["Prop_StopEnds"], "PASS", False,
  "Every row settles, every settled row of a running uncut run is routed, a stopping run ends."),
 ("fault.ap2-pinned-only", "fault", "Spec", c(rs=("ownA1",), ownerchange=True, pinnedonly=True), ["Inv_OwnerAtDecision"], [],
  "VIOLATION:Inv_OwnerAtDecision", False, "Only the pinned owner is checked: the former owner approves after the owner changed."),
 ("fault.ap2-current-only", "fault", "Spec", c(rs=("newA1",), ownerchange=True, currentonly=True), ["Inv_OnlyPinned"], [],
  "VIOLATION:Inv_OnlyPinned", False, "Only the current owner is checked: the new owner approves a proposal pinned to another."),
 ("fault.ap2-no-stop-check", "fault", "Spec", c(rs=("ownA1",), stop=True, nostopcheck=True), ["Inv_NoAnswerAfterStop"], [],
  "VIOLATION:Inv_NoAnswerAfterStop", False, "A fresh answer is accepted after an accepted stop."),
 ("fault.ap2-split-receipt", "fault", "Spec", c(rs=("ownA1",), splitreceipt=True), ["Inv_ReceiptStable"], [],
  "VIOLATION:Inv_ReceiptStable", False, "The receipt is not in the decision's transaction: the retry after a lost response is refused."),
 ("fault.ap2-split-audit", "fault", "Spec", c(rs=("ownA1",), splitreceipt=True), ["Inv_AuditAgrees"], [],
  "VIOLATION:Inv_AuditAgrees", False, "The same fault: node and audit say approved, no receipt exists."),
 ("fault.ap2-fixture-live", "fault", "Spec", c(rs=("fixA1",), fixturelive=True), ["Inv_OnlyPinned"], [],
  "VIOLATION:Inv_OnlyPinned", False, "A test fixture's answer settles a live approval."),
 ("fault.ap2-can-forgets", "fault", "LiveSpec", c(rs=("ownA1",), pause=False, can=True, canreread=False), ["TypeOK"],
  ["Prop_Routed"], "VIOLATION:Prop_Routed", False,
  "Continue-as-new drops what the controller knew and its start does not read the saved result: the run waits forever."),
 ("wit.ap2-paused-then-routed", "witness", "Spec", c(), ["W_NoApprovedWhilePausedThenRouted"], [],
  "VIOLATION:W_NoApprovedWhilePausedThenRouted", False, "Accepted while paused, routed once after the resume."),
 ("wit.ap2-run-deadline-first", "witness", "Spec", c(rundl=1), ["W_NoRunDeadlineFirst"], [],
  "VIOLATION:W_NoRunDeadlineFirst", False, "The earlier run deadline times the approval out."),
 ("wit.ap2-accepted-then-cut", "witness", "Spec", c(cut=True), ["W_NoAcceptedThenCut"], [],
  "VIOLATION:W_NoAcceptedThenCut", False, "An accepted decision in a branch that is then cut is kept and routes nothing."),
 ("wit.ap2-replayed-receipt", "witness", "Spec", c(), ["W_NoReplayedReceipt"], [], "VIOLATION:W_NoReplayedReceipt", False,
  "A lost response, then the exact retry, returns the accepted receipt."),
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
    rows, meta, texts = [], [], []
    for cid, group, spec, consts, invs, props, expected, deadlock, note in CASES:
        name = f"{cid}.cfg"
        texts.append(cfg(cid, spec, consts, invs, props, deadlock, note, expected))
        rows.append(f"{cid}\t{name}\t{M}")
        meta.append(dict(id=cid, module=M, group=group, spec=spec, config=name, invariants=invs, properties=props,
                         expected=expected, deadlock=deadlock, note=note, batch=BATCH, head="design"))
    assert len({r.split()[0] for r in rows}) == len(rows)
    tlc_cases.dump_json("tlc-templates.json", tlc_cases.attach(meta, texts), 2)
    with open("cases.tsv", "w") as f:
        f.write("\n".join(rows) + "\n")
    with open("cases.json", "w") as f:
        json.dump(meta, f, indent=1)
        f.write("\n")
    print(len(rows), "cases")


if __name__ == "__main__":
    main()
