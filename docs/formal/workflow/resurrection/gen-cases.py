#!/usr/bin/env python3
"""Writes cases.tsv, cases.json and tlc-templates.json for the FB-046 resurrection model (no TLC is run here). The .cfg
files are generated from these by run-tlc.sh (../../tlc_cases.py)."""
import json
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", ".."))
import tlc_cases   # docs/formal/tlc_cases.py

BATCH = "rs3"
M = "SessionResurrection"


def q(x):
    return f'"{x}"'


def c(new="P2", dlive=False, ylive=False, guard="locked", walk=True, pcheck=True, churn=False, t2="none", absent=False,
      alock="none", wf=False, wfcheck=True, adopt=False, aparent="X"):
    return dict(NewParent=q(new), DLive=dlive, YLive=ylive, GuardMode=q(guard), WalkDeleted=walk, ParentCheck=pcheck,
                Churn=churn, T2Target=q(t2), XAbsent=absent, AbsentLock=q(alock),
                WfCreate=wf, WfCheck=wfcheck, Adopt=adopt, AdoptParent=q(aparent))


SAFE = ["Inv_NoStaleSubtree", "Inv_NoCycle"]

# id, group, constants, invariants, expected, note
CASES = [
 ("rs.design-live-grandchild", "design", c(dlive=True), SAFE, "PASS",
  "X moves to P2 while its grandchild D is live under the deleted Y: the locked guard walks through Y and refuses."),
 ("rs.design-live-child", "design", c(ylive=True), SAFE, "PASS", "As above with the live child Y."),
 ("rs.design-t2-child", "design", c(t2="Y"), SAFE, "PASS",
  "Y is resurrected under X at the same time: it waits for X's lock and is refused (X deleted), or comes after the move with the new root."),
 ("rs.design-t2-grandchild", "design", c(t2="D"), SAFE, "PASS",
  "D is resurrected under the deleted Y at the same time: refused by the parent check."),
 ("rs.design-churn", "design", c(churn=True, t2="Y"), SAFE, "PASS",
  "X is resurrected under P1, Y under X, X deleted again, all around the move: the guard, under X's lock, sees Y."),
 ("rs.design-full", "design", c(dlive=True, churn=True, t2="Y"), SAFE, "PASS", "As rs.design-churn with D live from the start."),
 ("rs.design-same-parent", "design", c(new="P1", dlive=True, ylive=True), SAFE, "PASS",
  "A same-parent resurrection with live descendants is not refused, and keeps every root."),
 ("rs.design-own-child", "design", c(new="Y", ylive=True), SAFE, "PASS", "X under its own live child: the guard refuses."),
 ("rs.design-own-deleted-child", "design", c(new="Y"), SAFE, "PASS", "X under its own deleted child: the parent check refuses."),
 ("find.rs-no-guard", "finding", c(dlive=True, guard="none"), ["Inv_NoStaleSubtree"], "VIOLATION:Inv_NoStaleSubtree",
  "The code today: X moves to P2 and D, live below it, keeps P1's root."),
 ("find.rs-no-walk", "finding", c(dlive=True, walk=False), ["Inv_NoStaleSubtree"], "VIOLATION:Inv_NoStaleSubtree",
  "A guard that does not walk through deleted rows misses D below the deleted Y."),
 ("find.rs-preread", "finding", c(guard="preread", churn=True, t2="Y"), ["Inv_NoStaleSubtree"], "VIOLATION:Inv_NoStaleSubtree",
  "A guard read before X's lock: X is resurrected, Y made live under it, X deleted again, then the move."),
 ("find.rs-no-parent-check", "finding", c(pcheck=False, t2="D"), ["Inv_NoStaleSubtree"], "VIOLATION:Inv_NoStaleSubtree",
  "A resurrection that does not require a live parent makes D live under the deleted Y, after X moved, with P1's root."),
 ("find.rs-no-parent-check-cycle", "finding", c(new="Y", pcheck=False), ["Inv_NoCycle"], "VIOLATION:Inv_NoCycle",
  "Without the parent check, X is resurrected under its own deleted child: a cycle."),
 ("wit.rs-new-parent-moves", "witness", c(), ["W_NotMoved"], "VIOLATION:W_NotMoved",
  "A new-parent resurrection with no live descendant still moves X."),
 ("wit.rs-same-parent-moves", "witness", c(new="P1", dlive=True), ["W_NotMoved"], "VIOLATION:W_NotMoved",
  "A same-parent resurrection with a live descendant still moves X."),
 ("wit.rs-refused", "witness", c(dlive=True), ["W_NotRefused"], "VIOLATION:W_NotRefused", "The refusal is reachable."),
 # ---- rs2: X missing when the resurrecting transaction starts ----
 ("find.rs2-absent-row-lock", "finding", c(absent=True), ["Inv_NoStaleSubtree"], "VIOLATION:Inv_NoStaleSubtree",
  "X is missing: the row lock locks nothing; X is created under P1, given a live child and deleted; the upsert then resurrects X under P2 without the guard."),
 ("rs2.absent-advisory", "design", c(absent=True, alock="advisory"), SAFE, "PASS",
  "Every creator of X's id takes a transaction lock on the id first: the recreation waits, or comes first and the guard sees the child."),
 ("rs2.absent-insert-first", "design", c(absent=True, alock="insertFirst"), SAFE, "PASS",
  "INSERT ... ON CONFLICT DO NOTHING first, then lock the row, which now exists: a concurrent insert of the id waits."),
 ("wit.rs2-absent-created", "witness", c(absent=True, alock="advisory"), ["W_NotCreated"], "VIOLATION:W_NotCreated",
  "With the id lock, a missing X is created under its parent."),
 ("wit.rs2-absent-refused", "witness", c(absent=True, alock="advisory"), ["W_NotRefused"], "VIOLATION:W_NotRefused",
  "With the id lock, a recreation that commits first (with its live child) makes the resurrection refuse."),
 # ---- rs3: the Workflow-session create path (0094 scope) and adoption (FB-052) ----
 ("rs3.wf-create-checked", "design", c(wf=True), SAFE, "PASS",
  "A Workflow session is created under X while X is resurrected: it locks X FOR SHARE, so it is refused while X is deleted, or comes after the move with the new root."),
 ("rs3.wf-create-checked-churn", "design", c(wf=True, churn=True, t2="Y"), SAFE, "PASS",
  "As above with X resurrected under P1, Y made live and X deleted again around the move."),
 ("find.rs3-wf-create-unchecked", "finding", c(wf=True, wfcheck=False), ["Inv_NoStaleSubtree"], "VIOLATION:Inv_NoStaleSubtree",
  "cms_create_workflow_session today: X's root is read with no lock, X moves, then W is inserted with the old root."),
 ("wit.rs3-wf-created", "witness", c(wf=True), ["W_WfNotCreated"], "VIOLATION:W_WfNotCreated",
  "With the check, the Workflow session is still created (after the move)."),
 ("rs3.absent-parent-never-created", "design", c(absent=True, alock="insertFirst", adopt=True, aparent="Q"), SAFE, "PASS",
  "A session created under a parent id with no row (allowed), which is never created: its root is itself, and every rule holds."),
 ("find.fb052-adoption", "finding", c(absent=True, alock="insertFirst", adopt=True), ["Inv_NoStaleSubtree"], "VIOLATION:Inv_NoStaleSubtree",
  "FB-052, with the FB-046 design on: Z is created under X while X has no row (root Z); X is then created, and Z is adopted with a stale root."),
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
                         expected=expected, deadlock=True, note=note, batch=BATCH, head="design"))
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
