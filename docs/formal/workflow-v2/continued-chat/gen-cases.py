#!/usr/bin/env python3
"""Cases of WfContinuedChat (the continued agent session lifecycle). Usage: gen-cases.py <bound commit>"""
import json, sys
H = sys.argv[1] if len(sys.argv) > 1 else "a1772a01"
def b(x): return "TRUE" if x else "FALSE"
def q(x): return f'"{x}"'
def cc(v=3, person="none", stop=True, cancel=True, stopfail=False, failchat=0, recover=False,
       recheck=False, stopspawn=False, perchat=False, stopend=False, fault="none"):
    return dict(V=v, Person=q(person), AllowStop=b(stop), AllowCancel=b(cancel), AllowStopFail=b(stopfail), FailChat=failchat,
                RecoverFair=b(recover), SpawnRecheck=b(recheck), StopBeforeSpawn=b(stopspawn), PerChatEnd=b(perchat),
                StopAtRunEnd=b(stopend), Fault=q(fault))
M = "WfContinuedChat"
CORE = ["TypeOK", "Inv_OneLive", "Inv_ResultOwnVisit", "Inv_ReplaceOnlyEnded", "Inv_NoTurnForDecided", "Inv_EndOnce"]
ALL = CORE + ["Inv_PromptNotDropped", "Inv_NoLoudFail", "Inv_NoPromptBehindStaleTurn", "Inv_StopAtRunEnd"]
NOEND = [i for i in ALL if i != "Inv_StopAtRunEnd"]
LIVE = ["Prop_VisitsDecided", "Prop_AllEnded", "Prop_OwedSent"]
FIX = dict(recheck=True, stopspawn=True, perchat=True, stopend=True)
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
 ("finding.g3-other-chat", "reviewed", "finding", "LiveSpec", cc(person="end", failchat=1), CORE, ["Prop_OthersEnded"], "liveness", False,
  f"G3 at {H}: the first agent session's end fails past every retry; the loop stops there, so the replacement session is never ended."),
 ("limit.g3-failed-chat", "reviewed", "design-limit", "LiveSpec", cc(failchat=1, perchat=True), CORE, ["Prop_AllEnded"], "liveness", False,
  "The agent session whose end fails past every retry stays open until a person runs recover (recover is on request)."),
 ("fix.g3-per-chat", "proposal", "proposed-fix", "LiveSpec", cc(person="end", failchat=1, perchat=True, recover=True), CORE, ["Prop_OthersEnded", "Prop_AllEnded"], "PASS", True,
  "G3 fix: each agent session's end is tried on its own; the others are ended; a recover ends the failed one."),
 # G5
 ("finding.g5-no-stop-at-end", "reviewed", "finding", "Spec", cc(stop=False), ["Inv_StopAtRunEnd"], [], "safety", False,
  f"G5 at {H}: a run cancelled during a visit's turn sends no Stop; the end command waits for the turn's natural end."),
 ("fix.g5-stop-at-end", "proposal", "proposed-fix", "Spec", cc(stop=False, stopend=True), ALL, [], "PASS", True,
  "G5 fix: the visit's end at the run's end also stops its running turn."),
 # all fixes together
 ("fix.all", "proposal", "proposed-fix", "LiveSpec", cc(person="any", stopfail=True, failchat=0, **FIX), ALL, LIVE, "PASS", True,
  "Every proposed fix together, with a person's action and failing Stops."),
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
tsv, out = [], []
for cid, mode, meaning, spec, consts, invs, props, exp, dl, note in CASES:
    open(f"{cid}.cfg", "w").write(cfg(cid, spec, consts, invs, props, dl, note, exp))
    tsv.append(f"{cid}\t{cid}.cfg\t{M}")
    out.append(dict(id=cid, module=M, config=f"{cid}.cfg", mode=mode, meaning=meaning, spec=spec, expected=exp,
                    invariants=invs, properties=props, deadlock=dl, note=note))
open("cases.tsv", "w").write("\n".join(tsv) + "\n"); json.dump(out, open("cases.json", "w"), indent=1); print(len(tsv), "cases")
