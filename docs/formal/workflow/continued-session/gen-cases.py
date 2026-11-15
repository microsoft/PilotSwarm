#!/usr/bin/env python3
"""Cases of WfContinuedSession (the continued agent session lifecycle): writes cases.tsv, cases.json and tlc-templates.json.
Usage: gen-cases.py <bound commit>. The .cfg files are generated from these by run-tlc.sh (../../tlc_cases.py)."""
import json, os, sys
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", ".."))
import tlc_cases   # docs/formal/tlc_cases.py: the settings (.cfg) are generated from the tables, not committed
H = sys.argv[1] if len(sys.argv) > 1 else "a1772a01"
def b(x): return "TRUE" if x else "FALSE"
def q(x): return f'"{x}"'
def cc(v=3, person="none", stop=True, cancel=True, stopfail=False, failagentsession=0, recover=False,
       recheck=False, stopspawn=False, peragentsession=False, stopend=False, fault="none", seesending=True, endmark=False,
       split=False, checkall=False, fence="none", backstop=False, crash=False, marksplit=False, markfail="none",
       withdraw=False, outbox=False, carry=False, carrydelete="none",
       turnguard=False, markcreating=False, carrynotfound=False, turnfail=False, failreport="none", tofair=True, tfrecover=False):
    return dict(V=v, Person=q(person), AllowStop=b(stop), AllowCancel=b(cancel), AllowStopFail=b(stopfail), FailAgentSession=failagentsession,
                RecoverFair=b(recover), SpawnRecheck=b(recheck), RecheckSeesEnding=b(seesending), EndMark=b(endmark), StopBeforeSpawn=b(stopspawn), PerAgentSessionEnd=b(peragentsession),
                StopAtRunEnd=b(stopend), Fault=q(fault), SplitSpawn=b(split), CheckAll=b(checkall), Fence=q(fence),
                Backstop=b(backstop), AllowSpawnCrash=b(crash), MarkSplit=b(marksplit), MarkFail=q(markfail),
                Withdraw=b(withdraw), Outbox=b(outbox), Carry=b(carry), CarryDelete=q(carrydelete),
                TurnGuard=b(turnguard), MarkCreating=b(markcreating), CarryNotFound=b(carrynotfound),
                AllowTurnFail=b(turnfail), FailReport=q(failreport), TimeoutFair=b(tofair), AllowRecover=b(tfrecover))
M = "WfContinuedSession"
CORE = ["TypeOK", "Inv_OneLive", "Inv_ResultOwnVisit", "Inv_ReplaceOnlyEnded", "Inv_NoTurnForDecided", "Inv_EndOnce"]
ALL = CORE + ["Inv_PromptNotDropped", "Inv_NoLoudFail", "Inv_NoPromptBehindStaleTurn", "Inv_StopAtRunEnd"]
NOEND = [i for i in ALL if i != "Inv_StopAtRunEnd"]
LIVE = ["Prop_VisitsDecided", "Prop_AllEnded", "Prop_OwedSent"]
FIX = dict(recheck=True, stopspawn=True, peragentsession=True, stopend=True)
IMPL = dict(FIX, seesending=False)   # the fixes as written at a9f60db7 (feeb321e, 6ab43450, 1066e995, d227a0e6)
I = "a9f60db7"
G1B = os.environ.get("G1B_HEAD", "G1B")   # the developer's commit for the G1 residual
IMPL2 = dict(IMPL, endmark=True)
# DRR-1, DRR-2: the code at the G1-residual head with the spawn and a person's end in their separate steps
IMPL3 = dict(IMPL2, split=True, backstop=True, marksplit=True)
D = G1B
DRR1_FIX = "proposed"
DRR2_FIX = "proposed"
DRR1 = os.environ.get("DRR1_HEAD", "DRR1")   # the DRR-1 commit (create fence, every attempt checked, check after the send)
DRR2 = os.environ.get("DRR2_HEAD", "DRR2")   # the DRR-2 commit (the Workflow carries a mark's end)
DRR1B = os.environ.get("DRR1B_HEAD", "DRR1B")   # DRR-1b, the deletion carried (and condition 3, a test)
IMPLD1 = dict(IMPL3, checkall=True, fence="after")
IMPLD2 = dict(IMPLD1, carry=True)
IMPLD3 = dict(IMPLD2, carrydelete="visible")
DRR1C = os.environ.get("DRR1C_HEAD", "DRR1C")   # DRR-1c: the deletion's delete enqueued whatever the status says
IMPLD4 = dict(IMPLD2, carrydelete="queued")
DR2H = os.environ.get("DR2_HEAD", "9b2ca643")      # the code DR2 reviewed (DRR-1c at 9b2ca643)
DR2F = os.environ.get("DR2FIX_HEAD", "DR2FIX")     # the developer's DR2-001 and DR2-003 fixes
IMPLD5 = dict(IMPLD2, carrydelete="queued-race")
IMPLD6 = dict(IMPLD5, turnguard=True, carrynotfound=True)
FIXD1 = dict(IMPL3, checkall=True, fence="both")
FIXD2 = dict(FIXD1, outbox=True)
FIXC = dict(FIXD1, carry=True)   # the coordinator's choice for DRR-2: the Workflow carries a mark's end
SAFE = ALL + ["Inv_NoRevive"]
NOONE = [i for i in SAFE if i != "Inv_OneLive"]
DR2 = ["TypeOK", "Inv_OneLive", "Inv_NoAbandonedLive", "Inv_NoFailOnLive"]
CASES = [
 # the code as written, where no gap is triggered
 ("cc.safety", "reviewed", "confirmed", "Spec", cc(stopend=True), ALL, [], "PASS", True,
  f"{H}: three visits, stop and cancel, no person action, no failure (the run-end Stop of G5 assumed): one agent session goes on at a time, results bind to their own visit, ends are sent once."),
 ("cc.live", "reviewed", "confirmed", "LiveSpec", cc(), CORE, LIVE, "PASS", True,
  f"{H}: every visit is decided; after the run ends every agent session is ended; an owed end is sent."),
 ("cc.stop", "reviewed", "confirmed", "LiveSpec", cc(cancel=False), NOEND, LIVE, "PASS", True,
  f"{H}: a graceful stop: started visits finish, idle agent sessions are ended, then the run ends."),
 ("cc.cancel", "reviewed", "confirmed", "LiveSpec", cc(stop=False), CORE, LIVE, "PASS", True,
  f"{H}: a cancel decides pending visits; an agent session being created is owed and ended later."),
 ("cc.person-rest", "reviewed", "confirmed", "Spec", cc(person="any"), CORE, [], "PASS", True,
  f"{H}: a person ends or deletes the agent session: one goes on at a time, a replacement only after it ended, results bind to their own visit."),
 ("cc.person-live", "reviewed", "confirmed", "LiveSpec", cc(person="any"), CORE, LIVE, "PASS", True,
  f"{H}: with a person's end or delete, every visit is still decided and every agent session ended."),
 ("cc.late-reply-binding", "reviewed", "confirmed", "Spec", cc(stopfail=True), CORE, [], "PASS", True,
  f"{H}: a visit's turn runs on after its visit was decided (time limit, Stop not sent): its result is refused, never taken by the next visit."),
 # G1
 ("finding.g1-silent", "reviewed", "finding", "Spec", cc(person="delete"), ["Inv_PromptNotDropped"], [], "safety", False,
  f"G1 at {H}: the visit's agent session is chosen at admission and frozen; deleted before the spawn, it is brought back as a row that says running and the prompt is dropped; the visit waits out its time limit."),
 ("finding.g1-loud", "reviewed", "finding", "Spec", cc(person="end"), ["Inv_NoLoudFail"], [], "safety", False,
  f"G1 at {H}: ended before the spawn, the agent session refuses the prompt; the spawn retries about 31 minutes, then the visit fails unavailable."),
 ("fix.g1-recheck", "proposal", "proposed-fix", "Spec", cc(person="any", recheck=True, stopend=True), ALL, [], "PASS", True,
  "G1 fix: the spawn checks the frozen agent session before it sends; an ended or deleted one fails the visit at once."),
 # G2
 ("finding.g2-stale-turn", "reviewed", "finding", "Spec", cc(stopfail=True), ["Inv_NoPromptBehindStaleTurn"], [], "safety", False,
  f"G2 at {H}: a visit's cycle Stop fails past its retries; nothing sends it again during the run; the next visit's prompt waits behind the old turn."),
 ("fix.g2-stop-before-spawn", "proposal", "proposed-fix", "LiveSpec", cc(stopfail=True, stopspawn=True, stopend=True), ALL, LIVE, "PASS", True,
  "G2 fix: the next visit's spawn first sends the earlier visit's Stop again."),
 # G3
 ("finding.g3-other-chat", "reviewed", "finding", "LiveSpec", cc(person="end", failagentsession=1), CORE, ["Prop_OthersEnded"], "liveness", False,
  f"G3 at {H}: the first agent session's end fails past every retry; the loop stops there, so the replacement session is never ended."),
 ("limit.g3-failed-chat", "reviewed", "design-limit", "LiveSpec", cc(failagentsession=1, peragentsession=True), CORE, ["Prop_AllEnded"], "liveness", False,
  "The agent session whose end fails past every retry stays open until a person runs recover (recover is on request)."),
 ("fix.g3-per-chat", "proposal", "proposed-fix", "LiveSpec", cc(person="end", failagentsession=1, peragentsession=True, recover=True), CORE, ["Prop_OthersEnded", "Prop_AllEnded"], "PASS", True,
  "G3 fix: each agent session's end is tried on its own; the others are ended; a recover ends the failed one."),
 # G5
 ("finding.g5-no-stop-at-end", "reviewed", "finding", "Spec", cc(stop=False), ["Inv_StopAtRunEnd"], [], "safety", False,
  f"G5 at {H}: a run cancelled during a visit's turn sends no Stop; the end command waits for the turn's natural end."),
 ("fix.g5-stop-at-end", "proposal", "proposed-fix", "Spec", cc(stop=False, stopend=True), ALL, [], "PASS", True,
  "G5 fix: the visit's end at the run's end also stops its running turn."),
 # all fixes together
 ("fix.all", "proposal", "proposed-fix", "LiveSpec", cc(person="any", stopfail=True, failagentsession=0, **FIX), ALL, LIVE, "PASS", True,
  "Every proposed fix together, with a person's action and failing Stops."),
 # implementation: the fixes as written, bound to a9f60db7
 ("impl.cc-safety", "impl", "confirmed", "Spec", cc(person="delete", stopfail=True, **IMPL), ALL, [], "PASS", True,
  f"{I}: every fix, a person's delete, failing Stops: one agent session at a time, results bound, no prompt dropped, no 31-minute wait, no prompt behind a stale turn, the run's end stops a running turn."),
 ("impl.cc-live", "impl", "confirmed", "LiveSpec", cc(person="any", stopfail=True, **IMPL), CORE, LIVE, "PASS", True,
  f"{I}: with a person's end or delete and failing Stops, every visit is decided and every agent session ended."),
 ("impl.cc-g1", "impl", "confirmed", "Spec", cc(person="any", **IMPL), ["TypeOK", "Inv_NoLoudFail", "Inv_ReplaceOnlyEnded", "Inv_OneLive"], [], "PASS", True,
  f"G1 at {I} (feeb321e): an agent session ended or deleted after admission fails the visit at once; the next visit gets a replacement."),
 ("impl.cc-g1-deleted", "impl", "confirmed", "Spec", cc(person="delete", **IMPL), ["TypeOK", "Inv_PromptNotDropped"], [], "PASS", True,
  f"G1 at {I}: a deleted agent session gets no prompt and is not brought back."),
 ("limit.cc-g1-end-during-turn", "impl", "design-limit", "Spec", cc(person="end", **IMPL), ["Inv_PromptNotDropped"], [], "safety", False,
  f"Prediction at {I}: a person ends the agent session while a turn runs; the status stays Running until that turn ends, so the next visit's prompt is sent and then dropped when the end lands; the visit waits out its time limit."),
 # implementation of the G1 residual fix: a person's end is recorded before its command
 ("impl.cc-g1b-end-during-turn", "impl", "confirmed", "Spec", cc(person="end", **IMPL2), ["TypeOK", "Inv_PromptNotDropped", "Inv_OneLive", "Inv_ReplaceOnlyEnded"], [], "PASS", True,
  f"{G1B}: a person ends the agent session while a turn runs; the end is recorded before its command, so the next visit gets a replacement (or fails at once) and no prompt is dropped."),
 ("impl.cc-g1b-safety", "impl", "confirmed", "Spec", cc(person="any", stopfail=True, **IMPL2), ALL, [], "PASS", True,
  f"{G1B}: every fix, a person's end or delete, failing Stops: all safety properties."),
 ("impl.cc-g1b-live", "impl", "confirmed", "LiveSpec", cc(person="any", stopfail=True, **IMPL2), CORE, LIVE, "PASS", True,
  f"{G1B}: every visit decided, every agent session ended, owed ends sent."),
 ("impl.cc-g2", "impl", "confirmed", "LiveSpec", cc(stopfail=True, **IMPL), ALL, LIVE, "PASS", True,
  f"G2 at {I} (6ab43450): an earlier visit's Stop that failed is sent again before the next prompt, and at the run's end."),
 ("impl.cc-g3", "impl", "confirmed", "LiveSpec", cc(person="end", failagentsession=1, recover=True, **IMPL), CORE, ["Prop_OthersEnded", "Prop_AllEnded"], "PASS", True,
  f"G3 at {I} (d227a0e6): each agent session's end is tried on its own; the others are ended; a recover ends the failed one."),
 ("impl.cc-g5", "impl", "confirmed", "Spec", cc(stop=False, **IMPL), ALL, [], "PASS", True,
  f"G5 at {I} (1066e995): a run cancelled during a visit's turn stops that turn."),
 ("wit.cc-recheck-fails-visit", "impl", "witness", "Spec", cc(person="any", **IMPL), ["W_NoRecheckFail"], [], "safety", True,
  f"{I}: the spawn's check fails a visit whose agent session ended after admission."),
 # DRR-1: the spawn's check is a read, not a fence
 ("limit.cc-drr1-delete-after-check", "impl", "design-limit", "Spec", cc(v=2, person="delete", **IMPL3), ["TypeOK", "Inv_NoRevive"], [], "safety", False,
  f"DRR-1 at {D}: a person deletes the agent session after the spawn's check and before the child create; the create's upsert brings the deleted row back."),
 ("limit.cc-drr1-retry-revives", "impl", "design-limit", "Spec", cc(v=1, person="delete", crash=True, **IMPL3), ["TypeOK", "Inv_NoRevive"], [], "safety", False,
  f"DRR-1 at {D}: a first visit's attempt creates its agent session and fails before it is recorded; a person deletes the session; the retry is not checked and its create brings the row back."),
 ("limit.cc-drr1-end-after-check", "impl", "design-limit", "Spec", cc(v=2, person="end", stopfail=True, crash=True, **IMPL3), ["TypeOK", "Inv_PromptNotDropped", "Inv_NoLoudFail"], [], "safety", False,
  f"DRR-1 at {D}: a person ends the agent session after the spawn's check; the prompt is sent to an ended session (refused, the spawn retries) or queued behind the end (dropped)."),
 ("fix.cc-drr1-create-norevive", "proposal", "proposed-fix", "Spec", cc(v=2, person="delete", crash=True, stopfail=True, **dict(IMPL3, checkall=True, fence="create")), ["TypeOK", "Inv_NoRevive", "Inv_PromptNotDropped"], [], "PASS", True,
  f"DRR-1 fix ({DRR1_FIX}), the create part: a create refuses a deleted row without reviving it; every attempt is checked."),
 ("limit.cc-drr1-create-then-end", "proposal", "design-limit", "Spec", cc(v=2, person="end", stopfail=True, crash=True, **dict(IMPL3, checkall=True, fence="create")), ["TypeOK", "Inv_PromptNotDropped", "Inv_NoLoudFail"], [], "safety", False,
  f"DRR-1 fix ({DRR1_FIX}) with the create fenced but not the send: an end between the create and the send still meets the prompt."),
 ("fix.cc-drr1-fence", "proposal", "proposed-fix", "Spec", cc(v=2, person="any", stopfail=True, crash=True, **FIXD1), SAFE, [], "PASS", True,
  f"DRR-1 fix ({DRR1_FIX}): the create refuses a tombstone and the send is fenced with its check; every attempt checked: no revival, no prompt dropped, no 31-minute wait."),
 ("fix.cc-drr1-live", "proposal", "proposed-fix", "LiveSpec", cc(v=2, person="any", stopfail=True, crash=True, **FIXD1), CORE + ["Inv_NoRevive"], LIVE, "PASS", True,
  f"DRR-1 fix ({DRR1_FIX}): every visit decided, every agent session ended, owed ends sent."),
 # DRR-2: the end mark commits before its command
 ("cc.drr2-no-fail", "proposal", "confirmed", "Spec", cc(v=2, person="end", **FIXD1), DR2 + NOONE, [], "PASS", True,
  f"DRR-2 at {D} (with the DRR-1 fence): the mark before the command alone leaves no agent session abandoned and fails no visit on a live one."),
 ("limit.cc-drr2-throw", "impl", "design-limit", "Spec", cc(v=2, person="end", markfail="throw", **FIXD1), DR2, [], "safety", False,
  f"DRR-2 at {D}: the end's command fails after its mark; the mark stays; the next visit replaces a live agent session (abandoned) or fails at once on it."),
 ("limit.cc-drr2-throw-withdraw", "proposal", "design-limit", "Spec", cc(v=2, person="end", markfail="throw", withdraw=True, **FIXD1), DR2, [], "safety", False,
  "DRR-2 with a withdrawal on a thrown command: between the mark and its withdrawal a visit can still replace the live agent session or fail on it."),
 ("limit.cc-drr2-crash", "impl", "design-limit", "Spec", cc(v=2, person="end", markfail="crash", withdraw=True, **FIXD1), DR2, [], "safety", False,
  f"DRR-2 at {D}: the process stops after the mark; no command, no withdrawal: the agent session stays live and is abandoned for the rest of the run."),
 ("cc.drr2-crash-prompt", "impl", "confirmed", "Spec", cc(v=3, person="end", markfail="crash", stopfail=True, **FIXD1), NOONE, [], "PASS", True,
  f"DRR-2 at {D} (with the DRR-1 fence): the crash window drops no prompt, makes no visit wait out the spawn retries, and revives nothing."),
 ("cc.drr2-crash-live", "impl", "confirmed", "LiveSpec", cc(v=3, person="end", markfail="crash", stopfail=True, **FIXD1), [i for i in CORE if i != "Inv_OneLive"], LIVE, "PASS", True,
  f"DRR-2 at {D} (with the DRR-1 fence): after a crash window every visit is decided and the abandoned agent session is ended by the run's end."),
 ("fix.cc-drr2-outbox", "proposal", "proposed-fix", "Spec", cc(v=2, person="end", markfail="crash", stopfail=True, **FIXD2), DR2 + NOONE, [], "PASS", True,
  f"DRR-2 fix ({DRR2_FIX}), a durable outbox: the end command is sent after a crash; no agent session is abandoned and no visit fails on a live one."),
 ("fix.cc-drr2-outbox-throw", "proposal", "proposed-fix", "Spec", cc(v=2, person="end", markfail="throw", **FIXD2), DR2 + NOONE, [], "PASS", True,
  f"DRR-2 fix ({DRR2_FIX}), a durable outbox: the end command is sent after its enqueue failed."),
 ("fix.cc-drr2-outbox-live", "proposal", "proposed-fix", "LiveSpec", cc(v=2, person="any", markfail="crash", stopfail=True, **FIXD2), CORE, LIVE, "PASS", True,
  f"DRR-2 fix ({DRR2_FIX}): every visit decided, every agent session ended, owed ends sent."),
 ("fix.cc-drr2-carry-throw", "proposal", "proposed-fix", "Spec", cc(v=3, person="end", markfail="throw", stopfail=True, **FIXC), DR2 + NOONE, [], "PASS", True,
  f"DRR-2 fix ({DRR2_FIX}), the Workflow carries the end: the person's command failed; a visit that acts on the mark first queues its end, so no agent session is abandoned and no visit fails on a live one."),
 ("fix.cc-drr2-carry-crash", "proposal", "proposed-fix", "Spec", cc(v=3, person="end", markfail="crash", stopfail=True, **FIXC), DR2 + NOONE, [], "PASS", True,
  f"DRR-2 fix ({DRR2_FIX}), the Workflow carries the end after a crash between the mark and the command."),
 ("fix.cc-drr2-carry-live", "proposal", "proposed-fix", "LiveSpec", cc(v=3, person="any", markfail="crash", stopfail=True, **FIXC), CORE, LIVE, "PASS", True,
  f"DRR-2 fix ({DRR2_FIX}), the Workflow carries the end: every visit decided, every agent session ended, owed ends sent."),
 ("wit.cc-drr2-carried", "proposal", "witness", "Spec", cc(v=2, person="end", markfail="crash", **FIXC), ["W_NoCarry"], [], "safety", True,
  "A Workflow step carries a person's end whose command was lost."),
 # implementation of DRR-1 and DRR-2
 ("impl.cc-drr1-fence", "impl", "confirmed", "Spec", cc(v=2, person="any", stopfail=True, crash=True, **IMPLD1), SAFE, [], "PASS", True,
  f"DRR-1 at {DRR1}: the create refuses a deleted row (locked), every attempt is checked, and the check after the send decides the visit: no revival, no prompt dropped, no 31-minute wait."),
 ("impl.cc-drr1-live", "impl", "confirmed", "LiveSpec", cc(v=2, person="any", stopfail=True, crash=True, **IMPLD1), CORE + ["Inv_NoRevive"], LIVE, "PASS", True,
  f"DRR-1 at {DRR1}: every visit decided, every agent session ended, owed ends sent."),
 ("limit.cc-drr1-orphan-run", "impl", "design-limit", "Spec", cc(v=1, person="delete", **IMPLD2), ["TypeOK", "Inv_NoOrphanRun"], [], "safety", False,
  f"At {DRR2}: a person deletes a just-created agent session (row, no orchestration yet) between the create and the send; the send starts its orchestration, and the check after the send decides the visit but leaves that orchestration running."),
 ("fix.cc-drr1-carry-delete", "proposal", "proposed-fix", "Spec", cc(v=2, person="delete", crash=True, stopfail=True, carrydelete="owed", **IMPLD2), ["TypeOK", "Inv_NoOrphanRun", "Inv_NoRevive", "Inv_PromptNotDropped", "Inv_NoLoudFail"], [], "PASS", True,
  "Proposed (DRR-1b with the owed look): when the check after the send finds the session deleted, it ends an orchestration the send started, also when that start does not read as existing yet (the attempt retries until it does)."),
 ("impl.cc-drr2-carry-throw", "impl", "confirmed", "Spec", cc(v=3, person="end", markfail="throw", stopfail=True, **IMPLD2), DR2 + NOONE, [], "PASS", True,
  f"DRR-2 at {DRR2}: the person's command failed after its mark; the Workflow carries the end when it acts on the mark."),
 ("impl.cc-drr2-carry-crash", "impl", "confirmed", "Spec", cc(v=3, person="end", markfail="crash", stopfail=True, **IMPLD2), DR2 + NOONE, [], "PASS", True,
  f"DRR-2 at {DRR2}: the asker's process stopped after the mark; the Workflow carries the end."),
 ("impl.cc-drr2-carry-live", "impl", "confirmed", "LiveSpec", cc(v=3, person="any", markfail="crash", stopfail=True, **IMPLD2), CORE, LIVE, "PASS", True,
  f"DRR-2 at {DRR2}: every visit decided, every agent session ended, owed ends sent."),
 ("impl.cc-drr-safety", "impl", "confirmed", "Spec", cc(v=2, person="any", markfail="crash", stopfail=True, crash=True, **IMPLD2), DR2 + NOONE, [], "PASS", True,
  f"{DRR2}: DRR-1 and DRR-2 together, a person's end or delete, a lost command, a crashed spawn attempt, failing Stops: all safety properties."),
 # liveness at reduced size (the full-size cases above did not finish within 600 s in cc5d)
 ("fix.cc-drr1-live-n", "proposal", "proposed-fix", "LiveSpec", cc(v=2, person="delete", crash=True, **FIXD1), CORE + ["Inv_NoRevive"], LIVE, "PASS", True,
  "fix.cc-drr1-live reduced: a person's delete, a crashed spawn attempt, no failing Stops."),
 ("cc.drr2-crash-live-n", "impl", "confirmed", "LiveSpec", cc(v=2, person="end", markfail="crash", **FIXD1), [i for i in CORE if i != "Inv_OneLive"], LIVE, "PASS", True,
  "cc.drr2-crash-live reduced: two visits, no failing Stops."),
 ("fix.cc-drr2-carry-live-n", "proposal", "proposed-fix", "LiveSpec", cc(v=2, person="end", markfail="crash", **FIXC), CORE, LIVE, "PASS", True,
  "fix.cc-drr2-carry-live reduced: two visits, a person's end, no failing Stops."),
 ("impl.cc-drr1-live-n", "impl", "confirmed", "LiveSpec", cc(v=2, person="delete", crash=True, **IMPLD1), CORE + ["Inv_NoRevive"], LIVE, "PASS", True,
  f"impl.cc-drr1-live reduced ({DRR1}): a person's delete, a crashed spawn attempt, no failing Stops."),
 ("impl.cc-drr2-carry-live-n", "impl", "confirmed", "LiveSpec", cc(v=2, person="end", markfail="crash", **IMPLD2), CORE, LIVE, "PASS", True,
  f"impl.cc-drr2-carry-live reduced ({DRR2}): two visits, a person's end, no failing Stops."),
 # DRR-1b: the deletion carried by the check after the send
 ("limit.cc-drr1b-start-not-visible", "impl", "design-limit", "Spec", cc(v=1, person="delete", **IMPLD3), ["TypeOK", "Inv_NoOrphanRun"], [], "safety", False,
  f"At {DRR1B}: the check after the send finds the just-created session deleted; the start the send queued does not read as existing yet (NotFound), so the deletion is not carried and the orchestration runs on."),
 ("impl.cc-drr1b-orphan-ended", "impl", "confirmed", "LiveSpec", cc(v=2, person="delete", crash=True, **IMPLD3), CORE + ["Inv_NoRevive"], ["Prop_OrphanEnded"] + LIVE, "PASS", True,
  f"{DRR1B}: such an orchestration is ended at the latest by the run's end (endContinuedSessionLocked reads its status)."),
 ("impl.cc-drr1b-safety", "impl", "confirmed", "Spec", cc(v=2, person="any", markfail="crash", stopfail=True, crash=True, **IMPLD3), DR2 + NOONE, [], "PASS", True,
  f"{DRR1B}: DRR-1, DRR-1b and DRR-2 together: all safety properties but the orphan."),
 ("impl.cc-drr1b-live-n", "impl", "confirmed", "LiveSpec", cc(v=2, person="end", markfail="crash", **IMPLD3), CORE, LIVE, "PASS", True,
  f"{DRR1B}: every visit decided, every agent session ended, owed ends sent (two visits, a person's end)."),
 # DRR-1c: the delete enqueued behind the queued start
 ("impl.cc-drr1c-no-orphan", "impl", "confirmed", "Spec", cc(v=2, person="delete", crash=True, stopfail=True, **IMPLD4), ["TypeOK", "Inv_NoOrphanRun", "Inv_NoRevive", "Inv_PromptNotDropped", "Inv_NoLoudFail"], [], "PASS", True,
  f"{DRR1C}: the check after the send enqueues the deletion's delete even when the start does not read as existing yet; it is delivered with the start, before any turn."),
 ("impl.cc-drr1c-safety", "impl", "confirmed", "Spec", cc(v=2, person="any", markfail="crash", stopfail=True, crash=True, **IMPLD4), DR2 + NOONE + ["Inv_NoOrphanRun"], [], "PASS", True,
  f"{DRR1C}: DRR-1, DRR-1c and DRR-2 together: all safety properties."),
 ("impl.cc-drr1c-live-n", "impl", "confirmed", "LiveSpec", cc(v=2, person="delete", crash=True, **IMPLD4), CORE + ["Inv_NoRevive", "Inv_NoOrphanRun"], LIVE, "PASS", True,
  f"{DRR1C}: every visit decided, every agent session ended, owed ends sent (two visits, a person's delete)."),
 ("limit.cc-drr1c-clock-skew", "impl", "design-limit", "Spec", cc(v=1, person="delete", **dict(IMPLD4, carrydelete="queued-skew")), ["TypeOK", "Inv_NoOrphanRun"], [], "safety", False,
  f"{DRR1C}: when the event becomes visible before the start (hosts' clocks apart), it is fetched alone and dropped; the orchestration runs on."),
 ("impl.cc-drr1c-skew-ended", "impl", "confirmed", "LiveSpec", cc(v=2, person="delete", crash=True, **dict(IMPLD4, carrydelete="queued-skew")), CORE, ["Prop_OrphanEnded"] + LIVE, "PASS", True,
  f"{DRR1C}: even then the run's end ends it."),
 # DR2-001: the carried delete is queued behind the start and the prompt
 ("limit.cc-dr2-001-turn-before-delete", "impl", "design-limit", "Spec", cc(v=1, person="delete", **IMPLD5), ["TypeOK", "Inv_NoTurnOnDeleted"], [], "safety", False,
  f"DR2-001 at {DR2H}: a person deletes a just-created agent session before its send; the send queues the start and the prompt, the check after it queues the delete; a worker fetches the start and the prompt first and runs a model turn on the deleted session."),
 ("fix.cc-dr2-001-turn-guard", "impl", "confirmed", "Spec", cc(v=2, person="delete", crash=True, stopfail=True, **IMPLD6), ["TypeOK", "Inv_NoTurnOnDeleted", "Inv_NoRevive", "Inv_PromptNotDropped", "Inv_NoLoudFail"], [], "PASS", True,
  f"DR2-001 fix ({DR2F}): a turn's admission reads the row's deletion first; a deleted session runs no model turn and ends."),
 ("fix.cc-dr2-001-guard-skew", "impl", "confirmed", "Spec", cc(v=2, person="delete", crash=True, **dict(IMPLD6, carrydelete="queued-skew")), ["TypeOK", "Inv_NoTurnOnDeleted"], [], "PASS", True,
  f"DR2-001 fix ({DR2F}): the guard also covers a delete fetched alone and dropped (hosts' clocks apart)."),
 ("fix.cc-dr2-001-live-n", "impl", "confirmed", "LiveSpec", cc(v=2, person="delete", crash=True, **IMPLD6), CORE + ["Inv_NoRevive", "Inv_NoTurnOnDeleted"], ["Prop_OrphanEnded"] + LIVE, "PASS", True,
  f"DR2-001 fix ({DR2F}): every orchestration on a deleted session ends; every visit decided; every agent session ended."),
 # DR2-003: carryMarkedEnd skips NotFound
 ("limit.cc-dr2-003-mark-notfound", "impl", "design-limit", "Spec", cc(v=2, person="end", markfail="crash", markcreating=True, **IMPLD5), DR2, [], "safety", False,
  f"DR2-003 at {DR2H}: a parent's end is marked on an agent session whose start does not read as existing yet and its command is lost; the Workflow acts on the mark but carries nothing (NotFound), so the session goes on beside its replacement or a visit fails on it."),
 ("fix.cc-dr2-003-carry-notfound", "impl", "confirmed", "Spec", cc(v=2, person="end", markfail="crash", markcreating=True, **IMPLD6), DR2 + ["Inv_NoTurnOnDeleted"], [], "PASS", True,
  f"DR2-003 fix ({DR2F}): the marked end is queued to a session that reads NotFound too."),
 ("fix.cc-dr2-safety", "impl", "confirmed", "Spec", cc(v=2, person="any", markfail="crash", markcreating=True, stopfail=True, crash=True, **IMPLD6), DR2 + NOONE + ["Inv_NoTurnOnDeleted"], [], "PASS", True,
  f"{DR2F}: every DRR and DR2 fix together: all safety properties."),
 ("impl.cc-final-live", "impl", "confirmed", "LiveSpec", cc(v=2, person="any", markfail="crash", markcreating=True, crash=True, **IMPLD6), CORE + ["Inv_NoRevive", "Inv_NoTurnOnDeleted"], ["Prop_OrphanEnded"] + LIVE, "PASS", True,
  f"{DR2F}: every DRR and DR2 fix, a person's or a parent's end or delete, a lost command, a crashed spawn attempt: every visit decided, every agent session ended, owed ends sent, no orchestration left on a deleted session."),
 # tf1 (2026-11-10): a turn that fails terminally (its retries spent). The code before the fix sends no report, and
 # the visit waits for its time limit; the fix reports the failure and the store decides the turn's own visit
 # execution_failed while it is pending. TimeoutFair = FALSE: liveness must not rest on the time limit. Base: the
 # G1-G5 fixes and the end mark (IMPL2); the spawn as one step.
 ("tf.cc-turn-fails-waits", "reviewed", "finding", "LiveSpec", cc(v=2, turnfail=True, tofair=False, **IMPL2), CORE, ["Prop_FailedVisitDecided"], "liveness", True,
  "tf1 finding (the code before the fix): a visit whose turn failed terminally is never reported; without its time limit it stays pending."),
 ("tf.cc-turn-fails", "proposal", "proposed-fix", "LiveSpec", cc(v=2, turnfail=True, failreport="fix", tofair=False, **IMPL2), CORE, ["Prop_FailedVisitDecided"], "PASS", True,
  "tf1 fix: the failure report decides the turn's own visit execution_failed, without its time limit."),
 ("tf.cc-turn-fails-safety", "proposal", "proposed-fix", "Spec", cc(person="any", stopfail=True, turnfail=True, failreport="fix", **IMPL2), ALL, [], "PASS", True,
  "tf1 fix: every safety property with failing turns, a person's end or delete and failing Stops (a report decides only its own pending visit)."),
 ("tf.cc-turn-fails-live", "proposal", "proposed-fix", "LiveSpec", cc(v=2, person="any", stopfail=True, turnfail=True, failreport="fix", **IMPL2), CORE, LIVE + ["Prop_FailedVisitDecided"], "PASS", True,
  "tf1 fix: every visit decided, every agent session ended, owed ends sent, with failing turns."),
 ("tf.cc-stale-turn-fails", "proposal", "proposed-fix", "Spec", cc(stopfail=True, turnfail=True, failreport="fix", **IMPL2), ["TypeOK", "Inv_ResultOwnVisit", "Inv_NoPromptBehindStaleTurn"], [], "PASS", True,
  "tf1 fix: a decided visit's turn whose Stop failed (G2) fails terminally; its report changes nothing, and the next visit is not decided by it."),
 ("fault.cc-report-binds-newest", "deliberate", "deliberate", "Spec", cc(stopfail=True, turnfail=True, failreport="binds-newest", **IMPL2), ["Inv_ResultOwnVisit"], [], "safety", False,
  "A failure report that decides the session's newest pending visit: a stale turn's failure decides the next visit."),
 ("wit.cc-turn-fail-decided", "proposal", "witness", "Spec", cc(v=2, turnfail=True, failreport="fix", **IMPL2), ["W_NoFailDecided"], [], "safety", True,
  "tf1 fix: a failure report decides a visit execution_failed."),
 ("tf.cc-turn-fails-recovers", "proposal", "proposed-fix", "LiveSpec", cc(v=2, turnfail=True, failreport="fix", tfrecover=True, **IMPL2), CORE, LIVE + ["Prop_FailedVisitDecided"], "PASS", True,
  "tf1 fix with a later successful turn that drops an owed report (d3230de4): the visit is still decided, by the report, the agent's result or its time limit."),
 ("limit.cc-turn-fails-recovered-no-timeout", "proposal", "design-limit", "LiveSpec", cc(v=2, turnfail=True, failreport="fix", tfrecover=True, tofair=False, **IMPL2), CORE, ["Prop_FailedVisitDecided"], "liveness", True,
  "Design limit: after a dropped report, a visit the agent does not complete is left to its time limit (here not forced)."),
 ("wit.cc-dropped-then-result", "proposal", "witness", "Spec", cc(v=2, turnfail=True, failreport="fix", tfrecover=True, **IMPL2), ["W_NoDroppedThenResult"], [], "safety", True,
  "After a dropped report, the agent completes the visit in the successful turn."),
 ("wit.cc-dropped-then-timeout", "proposal", "witness", "Spec", cc(v=2, turnfail=True, failreport="fix", tfrecover=True, **IMPL2), ["W_NoDroppedThenTimeout"], [], "safety", True,
  "After a dropped report, the visit's time limit decides it."),
 ("wit.cc-reuse-after-fail", "proposal", "witness", "Spec", cc(v=2, turnfail=True, failreport="fix", **IMPL2), ["W_NoReuseAfterFail"], [], "safety", True,
  "tf1 fix: the next visit reuses the agent session whose turn failed (coordinator decision: no replacement)."),
 # faults
 ("fault.bind-newest", "deliberate", "deliberate", "Spec", cc(stopfail=True, fault="bind-newest"), ["Inv_ResultOwnVisit"], [], "safety", False,
  "A result bound to the newest pending visit instead of its own: an old turn decides the next visit."),
 ("fault.replace-without-check", "deliberate", "deliberate", "Spec", cc(fault="replace-without-check"), ["Inv_OneLive"], [], "safety", False,
  "A replacement agent session while the previous one goes on: two at once."),
 ("fault.no-owed-mark", "deliberate", "deliberate", "LiveSpec", cc(stop=False, fault="no-owed-mark"), CORE, ["Prop_AllEnded"], "liveness", False,
  "An agent session not visible yet at the run's end is marked ended instead of owed: it starts later and is never ended."),
 ("fault.end-without-lock", "deliberate", "deliberate", "Spec", cc(cancel=False, fault="end-without-lock"), ["Inv_EndOnce"], [], "safety", False,
  "Two lookers end the same agent session without the end lock: two end commands."),
 ("fault.run-decided", "deliberate", "deliberate", "Spec", cc(stopfail=True, fault="run-decided"), ["Inv_NoTurnForDecided"], [], "safety", False,
  "A turn starts for a visit already decided (no visit check at turn start)."),
 # witnesses
 ("wit.replacement", "reviewed", "witness", "Spec", cc(person="end"), ["W_NoReplacement"], [], "safety", True, "A replacement agent session after a person ended the previous one."),
 ("wit.owed-end", "reviewed", "witness", "Spec", cc(stop=False), ["W_NoOwedEnd"], [], "safety", True, "An agent session not visible yet at the run's end is owed."),
 ("wit.cycle-stop", "reviewed", "witness", "Spec", cc(), ["W_NoCycleStop"], [], "safety", True, "A cycle Stop ends a decided visit's running turn."),
 ("wit.skip-decided", "reviewed", "witness", "Spec", cc(), ["W_NoSkip"], [], "safety", True, "A queued prompt of a decided visit is skipped at turn start."),
]
def cfg(cid, spec, consts, invs, props, dl, note, exp):
    l = [f"\\* {cid} (expected {exp}): {note}", f"SPECIFICATION {spec}", "CONSTANTS"] + [f"    {k} = {v}" for k, v in consts.items()]
    if invs: l += ["INVARIANTS"] + [f"    {i}" for i in invs]
    if props: l += ["PROPERTIES"] + [f"    {p}" for p in props]
    l.append(f"CHECK_DEADLOCK {'TRUE' if dl else 'FALSE'}")
    return "\n".join(l) + "\n"
tsv, out, texts = [], [], []
for cid, mode, meaning, spec, consts, invs, props, exp, dl, note in CASES:
    texts.append(cfg(cid, spec, consts, invs, props, dl, note, exp))
    tsv.append(f"{cid}\t{cid}.cfg\t{M}")
    out.append(dict(id=cid, module=M, config=f"{cid}.cfg", mode=mode, meaning=meaning, spec=spec, expected=exp,
                    invariants=invs, properties=props, deadlock=dl, note=note))
templates = tlc_cases.attach(out, texts)
open("cases.tsv", "w").write("\n".join(tsv) + "\n"); json.dump(out, open("cases.json", "w"), indent=1)
tlc_cases.dump_json("tlc-templates.json", templates, 2); print(len(tsv), "cases")
