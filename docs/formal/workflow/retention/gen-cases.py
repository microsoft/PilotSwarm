#!/usr/bin/env python3
"""Writes cases.tsv, cases.json and tlc-templates.json for the issue 412 retention model (no TLC is run here). The .cfg
files are generated from these by run-tlc.sh (../../tlc_cases.py)."""
import json
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", ".."))
import tlc_cases   # docs/formal/tlc_cases.py

BATCH = "ret1"
HEAD = "issue-412-r2"
M = "WorkflowRetention"


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


def cfg(cid, consts, invs, note, expected):
    lines = [f"\\* {cid} ({BATCH}; expected {expected}): {note}", "SPECIFICATION Spec", "CONSTANTS"]
    lines += [f"    {k} = {str(v).upper() if isinstance(v, bool) else v}" for k, v in consts.items()]
    lines += ["INVARIANTS"] + [f"    {i}" for i in invs]
    lines.append("CHECK_DEADLOCK TRUE")
    return "\n".join(lines) + "\n"


def main():
    rows, meta, texts = [], [], []
    for cid, group, consts, invs, expected, note in CASES:
        name = f"{cid}.cfg"
        texts.append(cfg(cid, consts, invs, note, expected))
        rows.append(f"{cid}\t{name}\t{M}")
        meta.append(dict(id=cid, module=M, group=group, spec="Spec", config=name, invariants=invs, properties=[],
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
