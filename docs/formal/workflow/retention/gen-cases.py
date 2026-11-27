#!/usr/bin/env python3
"""Writes cases.tsv, cases.json and tlc-templates.json for the issue 412 retention models (no TLC is run here). The .cfg
files are generated from these by run-tlc.sh (../../tlc_cases.py)."""
import json
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", ".."))
import tlc_cases   # docs/formal/tlc_cases.py

BATCH = "ret3"
HEAD = "pr415-round4"
M = "WorkflowRetention"
MP = "WorkflowPrune"


def q(x):
    return f'"{x}"'


def c(target="W", r="ended", w="finished", sweep=True, restart=False, runend=False, purge=False, anc=True, pmode="locked"):
    return dict(Target=q(target), RInit=q(r), WInit=q(w), Sweep=sweep, Restart=restart, RunEnd=runend, Purge=purge,
                AncLock=anc, PurgeMode=q(pmode))


SAFE = ["TypeOK", "Inv_Locks", "Inv_NoKeptDelete", "Inv_NoFinishedLogPurge"]

RESTART = c(restart=True)
RUNEND = c(target="A", r="active", w="active", runend=True)
PURGE_RUNEND = c(sweep=False, r="active", w="active", runend=True, purge=True)

# id, group, constants, invariants, expected, note
CASES = [
 ("ret.restart-cleanup-workflow", "design", RESTART, SAFE, "PASS",
  "R ended, W finished: the Sweeper cleans W (with A) while R restarts. R is held FOR SHARE: the restart commits before the check (kept), or waits until the delete commits."),
 ("ret.runend-cleanup-agent", "design", RUNEND, SAFE, "PASS",
  "R active, W running: the Sweeper cleans A while W's run ends. W is held FOR SHARE: the run ends before the check (A kept), or waits until A's delete commits."),
 ("ret.restart-runend-cleanup-agent", "design", c(target="A", w="active", restart=True, runend=True), SAFE, "PASS",
  "R ended, W running: R restarts and W's run ends while the Sweeper cleans A."),
 ("ret.purge-runend", "design", PURGE_RUNEND, SAFE, "PASS",
  "The purge runs while W's run ends: a held W's old events go only while its run has not ended; a W a writer holds is skipped."),
 ("ret.purge-finished", "design", c(sweep=False, purge=True), SAFE, "PASS",
  "A finished W's Log is kept whatever R's state."),
 ("ret.all-workflow", "design", c(w="active", restart=True, runend=True, purge=True), SAFE, "PASS",
  "Every change at once, the Sweeper cleaning W."),
 ("ret.all-agent", "design", c(target="A", w="active", restart=True, runend=True, purge=True), SAFE, "PASS",
  "Every change at once, the Sweeper cleaning A."),
 ("find.ret-r1-restart", "finding", c(restart=True, anc=False), ["Inv_NoKeptDelete"], "VIOLATION:Inv_NoKeptDelete",
  "Round 1 (17142cd0, review R1-1): the final check reads R with no lock; R restarts between the check and the commit, which deletes a kept W."),
 ("find.ret-r1-runend", "finding", c(target="A", r="active", w="active", runend=True, anc=False), ["Inv_NoKeptDelete"],
  "VIOLATION:Inv_NoKeptDelete",
  "Round 1: W's run ends between the check of A and its commit, which deletes a session the finished W keeps."),
 ("find.ret-r1-purge", "finding", c(sweep=False, r="active", purge=True, pmode="none"), ["Inv_NoFinishedLogPurge"],
  "VIOLATION:Inv_NoFinishedLogPurge", "Round 1 (review R1-2): purge_old_events deletes every old event, a finished W's Log too."),
 ("find.ret-purge-nolock", "finding", c(sweep=False, r="active", w="active", runend=True, purge=True, pmode="nolock"),
  ["Inv_NoFinishedLogPurge"], "VIOLATION:Inv_NoFinishedLogPurge",
  "A purge that protects a finished W but decides without holding it: the run ends between the decision and the commit."),
 ("wit.ret-deleted", "witness", RESTART, ["Wit_Deleted"], "VIOLATION:Wit_Deleted", "The Sweeper deletes W."),
 ("wit.ret-restart-after-delete", "witness", RESTART, ["Wit_RestartAfterDelete"], "VIOLATION:Wit_RestartAfterDelete",
  "R restarts after W's delete committed."),
 ("wit.ret-busy", "witness", RESTART, ["Wit_Busy"], "VIOLATION:Wit_Busy", "A restart that holds R first makes the Sweeper refuse (Busy)."),
 ("wit.ret-kept", "witness", RESTART, ["Wit_Kept"], "VIOLATION:Wit_Kept", "A restart that commits first makes the check keep W."),
 ("wit.ret-kept-runend", "witness", RUNEND, ["Wit_Kept"], "VIOLATION:Wit_Kept", "A run end that commits first makes the check keep A."),
 ("wit.ret-purged-then-ended", "witness", PURGE_RUNEND, ["Wit_PurgedThenEnded"], "VIOLATION:Wit_PurgedThenEnded",
  "The purge deletes a running W's old events, then the run ends."),
 ("wit.ret-kept-log-then-ended", "witness", PURGE_RUNEND, ["Wit_KeptLogThenEnded"], "VIOLATION:Wit_KeptLogThenEnded",
  "A run writer holds W, the purge skips it and keeps its Log, then the run ends."),
]


def p(w="finished", o=True, r=False, create=False, cmode="share", runend=False, check="locked", start=True):
    return dict(WInit=q(w), OActive=o, RActive=r, Create=create, CreateMode=q(cmode), RunEnd=runend, Check=q(check), StartCheck=start)


PSAFE = ["TypeOK", "Inv_Locks", "Inv_KeptShown"]
P_CREATE = p(w="none", create=True, runend=True)

# Review R2-1: the prune of R, with the ordinary session O between R and the Workflow W (module WorkflowPrune).
PRUNE_CASES = [
 ("ret.prune-finished", "design", p(r=True), PSAFE, "PASS",
  "R pending, O idle, W finished: the prune refuses (WorkflowBelow); W stays reachable."),
 ("ret.prune-runend", "design", p(w="active", runend=True), PSAFE, "PASS",
  "W's run ends while R is pruned: W is held; the run ends after the refusal, or the prune refuses at once (Busy)."),
 ("ret.prune-create-share", "design", P_CREATE, PSAFE, "PASS",
  "A Workflow is created under O (O locked FOR SHARE) and its run ends while R is pruned."),
 ("ret.prune-create-nku", "design", p(w="none", create=True, cmode="nku", runend=True), PSAFE, "PASS",
  "As above, the creation locking O FOR NO KEY UPDATE (the child budget's lock)."),
 ("ret.prune-ended", "design", p(o=False), PSAFE, "PASS",
  "O ended, R ended, W finished (W is not kept): the prune still refuses; a cascading cleanup removes the subtree."),
 ("find.ret-r2-prune", "finding", p(o=True, check="none"), ["Inv_KeptShown"], "VIOLATION:Inv_KeptShown",
  "Round 2 (7824eafc, review R2-1): the check reads only the target and its Workflow children; R is deleted and the kept W under O is no longer reachable."),
 ("find.ret-prune-kept-only", "finding", p(w="active", runend=True, check="kept"), ["Inv_KeptShown"],
  "VIOLATION:Inv_KeptShown",
  "A check that refuses only for a Workflow kept now: W's run has not ended, R is deleted, then the run ends and W is kept out of reach."),
 ("find.ret-prune-nolock", "finding", p(w="none", create=True, runend=True, check="nolock"), ["Inv_KeptShown"],
  "VIOLATION:Inv_KeptShown",
  "A check that does not lock the sessions it leaves: a Workflow created under O between the check and the commit, then its run ends."),
 ("find.ret-r3-start-after-prune", "finding", p(w="none", create=True, cmode="nku", runend=True, start=False), ["Inv_KeptShown"],
  "VIOLATION:Inv_KeptShown",
  "Round 3 (review of 35ef0302): a Start under O that does not read the sessions above O creates W after the prune deleted R; its run ends and W is kept out of reach."),
 ("wit.ret-prune-deleted", "witness", p(w="none"), ["Wit_Deleted"], "VIOLATION:Wit_Deleted",
  "With no Workflow under O, the prune deletes R as before."),
 ("wit.ret-prune-below", "witness", p(), ["Wit_Below"], "VIOLATION:Wit_Below", "The prune refuses (WorkflowBelow)."),
 ("wit.ret-prune-busy", "witness", P_CREATE, ["Wit_Busy"], "VIOLATION:Wit_Busy", "A creation that holds O first makes the prune refuse (Busy)."),
 ("wit.ret-prune-changed", "witness", P_CREATE, ["Wit_Changed"], "VIOLATION:Wit_Changed",
  "A Workflow created between the read and the locks makes the prune refuse (Changed)."),
 ("wit.ret-prune-start-refused", "witness", P_CREATE, ["Wit_StartRefused"], "VIOLATION:Wit_StartRefused",
  "A creation after the prune's delete reads R deleted and refuses: nothing is created."),
]


def cfg(cid, consts, invs, note, expected):
    lines = [f"\\* {cid} ({BATCH}; expected {expected}): {note}", "SPECIFICATION Spec", "CONSTANTS"]
    lines += [f"    {k} = {str(v).upper() if isinstance(v, bool) else v}" for k, v in consts.items()]
    lines += ["INVARIANTS"] + [f"    {i}" for i in invs]
    lines.append("CHECK_DEADLOCK TRUE")
    return "\n".join(lines) + "\n"


def main():
    rows, meta, texts = [], [], []
    for module, cases in ((M, CASES), (MP, PRUNE_CASES)):
        for cid, group, consts, invs, expected, note in cases:
            name = f"{cid}.cfg"
            texts.append(cfg(cid, consts, invs, note, expected))
            rows.append(f"{cid}\t{name}\t{module}")
            meta.append(dict(id=cid, module=module, group=group, spec="Spec", config=name, invariants=invs, properties=[],
                             expected=expected, deadlock=True, note=note, batch=BATCH, head=HEAD))
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
