#!/usr/bin/env python3
"""Writes cases.tsv, cases.json and tlc-templates.json for WorkflowReminder (no TLC is run here). The .cfg
files are generated from these by run-tlc.sh (../../tlc_cases.py)."""
import json, os
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", ".."))
import tlc_cases   # docs/formal/tlc_cases.py: the settings (.cfg) are generated from the tables, not committed

MOD = "WorkflowReminder"
HEAD = "8d568890"   # the reminder chain 052c0174..8a5b0b7d, live in 8d568890

def c(turns=2, mx=3, retry=1, stop=True, intr=True, steer=True, held=True, queued=True, guard=True, cron=True, sub=True,
      sendfail=True, storehang=False, sendhang=False, fault="none"):
    return dict(MaxTurns=turns, Max=mx, MaxRetry=retry, AllowStop=stop, AllowInterrupt=intr, AllowSteer=steer, AllowHeld=held,
                AllowQueued=queued, AllowGuard=guard, AllowCron=cron, AllowSub=sub, AllowSendFail=sendfail,
                AllowStoreHang=storehang, AllowSendHang=sendhang, Fault=f'"{fault}"')
QUIET = dict(stop=False, intr=False, steer=False, held=False, queued=False, guard=False, cron=False, sub=False, sendfail=False)

SAFE = ["TypeOK", "Inv_OneSendPerAttempt", "Inv_OneRecordPerTurn", "Inv_RecordsCap", "Inv_SendsBounded", "Inv_SendHasRecord",
        "Inv_NoSendWhileWorkPending", "Inv_EventAfterAccept", "Inv_NoRecordAfterDecided"]
PROPS = ["Prop_StalledReminded", "Prop_StepEnds", "Prop_StopTakesEffect"]
def W(name): return ["TypeOK", name]

# id, group, mode, spec, constants, invariants, properties, expected, note
CASES = [
 ("rem.safety", "rem-safety", "reviewed", "Spec", c(), SAFE, [], "PASS",
  "Two turns and one activity re-run; Stop, interrupt, steer, held controls, queued message, guard, schedule, sub-agent, deadline, send failure at any point."),
 ("rem.retry-safety", "rem-safety", "reviewed", "Spec", c(retry=2), SAFE, [], "PASS", "Two activity re-runs of a turn."),
 ("rem.cap", "rem-safety", "reviewed", "Spec", c(turns=4, retry=0, **QUIET), SAFE, [], "PASS",
  "Four quiet turns: at most 3 reminders are recorded for the step."),
 ("rem.live", "rem-live", "reviewed", "LiveSpec", c(), SAFE, PROPS, "PASS",
  "A stalled step is reminded or decided; the step ends; Stop always ends the turn."),
 ("rem.store-hang-live", "rem-live", "reviewed", "LiveSpec", c(storehang=True), ["TypeOK"], ["Prop_StopTakesEffect"], "PASS",
  "The gate's store call may never answer: the race with Stop still ends the turn."),
 ("wit.rem-reminded", "rem-witness", "witness", "Spec", c(), W("W_NoReminder"), [], "safety", "A reminder is sent."),
 ("wit.rem-three", "rem-witness", "witness", "Spec", c(turns=3, retry=0, **QUIET), W("W_NotThree"), [], "safety", "Three reminders are recorded."),
 ("wit.rem-recorded-not-sent", "rem-witness", "witness", "Spec", c(), W("W_RecordedAlwaysSent"), [], "safety",
  "Design: a recorded reminder that a Stop (or pending work) keeps from being sent still counts toward the 3."),
 ("wit.rem-send-after-decided", "rem-witness", "witness", "Spec", c(), W("W_NoSendAfterDecided"), [], "safety",
  "Design limit: the step expires between the store's record and the send; the child gets a reminder for a decided step."),
 ("wit.rem-queued-message", "rem-witness", "witness", "Spec", c(), W("W_NoQueuedSend"), [], "safety",
  "Documented limit: a message queued for the child is not seen; the reminder is still sent."),
 ("wit.rem-two-sends-one-turn", "rem-witness", "witness", "Spec", c(retry=1), W("W_OneSendPerTurn"), [], "safety",
  "Design: an activity re-run of the same turn reminds again under its recorded number."),
 ("fault.rem-no-recheck", "rem-fault", "fault", "Spec", c(fault="no-recheck"), W("Inv_NoSendWhileWorkPending"), [], "safety",
  "Without the re-check after the gate (review E1), a steer that arrived while the gate decided is overtaken."),
 ("fault.rem-event-before-send", "rem-fault", "fault", "Spec", c(fault="event-before-send"), W("Inv_EventAfterAccept"), [], "safety",
  "The runtime event published before the SDK accepted the prompt (before review E2)."),
 ("fault.rem-no-cap", "rem-fault", "fault", "Spec", c(turns=4, retry=0, fault="no-cap", **QUIET), W("Inv_RecordsCap"), [], "safety",
  "The store does not count the step's reminders."),
 ("fault.rem-no-step-check", "rem-fault", "fault", "Spec", c(fault="no-step-check"), W("Inv_NoRecordAfterDecided"), [], "safety",
  "The store does not check the step is open and in time."),
 ("fault.rem-turn-reuse", "rem-fault", "fault", "Spec", c(turns=3, retry=0, fault="turn-reuse", **QUIET), W("Inv_SendsBounded"), [], "safety",
  "Every turn has the same index: the repeat path reminds without counting."),
 ("fault.rem-gate-not-raced", "rem-fault", "fault", "LiveSpec", c(storehang=True, fault="gate-not-raced"), ["TypeOK"], ["Prop_StopTakesEffect"], "liveness",
  "The gate is not raced with Stop (before review D2): a store call that never answers blocks Stop."),
 ("cmp.rem-send-hang", "rem-compare", "comparison", "LiveSpec", c(sendhang=True), ["TypeOK"], ["Prop_StopTakesEffect"], "liveness",
  "Assumption: send() of the reminder prompt is not raced with Stop; a CLI that never accepts or refuses holds Stop."),
]

def val(v):
    if isinstance(v, bool): return "TRUE" if v else "FALSE"
    return str(v)

out, texts = [], []
for (cid, group, mode, spec, consts, invs, props, expected, note) in CASES:
    assert cid == cid.lower()
    lines = [f"\\* {cid} ({mode}; expected {expected}): {note}", f"SPECIFICATION {spec}", "CONSTANTS"]
    lines += [f"    {k} = {val(v)}" for k, v in consts.items()]
    if invs: lines += ["INVARIANTS"] + [f"    {i}" for i in invs]
    if props: lines += ["PROPERTIES"] + [f"    {x}" for x in props]
    lines += ["CHECK_DEADLOCK TRUE"]
    texts.append("\n".join(lines) + "\n")
    out.append({"id": cid, "module": MOD, "group": group, "mode": mode, "spec": spec, "config": f"{cid}.cfg", "head": HEAD,
                "properties": invs + props, "expected": expected, "note": note, "batch": "r1"})
with open("cases.tsv", "w") as f:
    for c_ in out: f.write(f"{c_['id']}\t{c_['config']}\t{c_['module']}\n")
templates = tlc_cases.attach(out, texts)
with open("cases.json", "w") as f: json.dump(out, f, indent=1)
tlc_cases.dump_json("tlc-templates.json", templates, 2)
print(len(out), "cases")
