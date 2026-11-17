#!/usr/bin/env python3
"""Writes cases.tsv, cases.json and tlc-templates.json for the FB-005 carry model (no TLC is run here). The .cfg
files are generated from these by run-tlc.sh (../../tlc_cases.py)."""
import json
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", ".."))
import tlc_cases   # docs/formal/tlc_cases.py

BATCH = "ca2"
M = "WorkflowCarry"


def q(x):
    return f'"{x}"'


def caps(xs):
    return "{" + ", ".join(q(x) for x in sorted(xs)) + "}"


def c(nb=2, v=2, maxkv=1, crash=1, optin=True, gate=True, gateignored=False, errors=True, carryfail=False, inputfail=False, cancel=True,
      reeval=False, nonatomic=False, shared=False, replay=False, legacyerr=False, failedeffect=False):
    return dict(NB=nb, V=v, MaxKv=maxkv, MaxCrash=crash, OptIn=optin, Gate=gate, GateIgnored=gateignored, Errors=errors, CarryFail=carryfail,
                InputFail=inputfail, AllowCancel=cancel, ReevalAtCompletion=reeval, NonAtomic=nonatomic,
                SharedCarry=shared, ReevalOnReplay=replay, LegacyOnError=legacyerr, FailedCarryEffect=failedeffect)


SAFE = ["TypeOK", "Inv_SnapshotImmutable", "Inv_CarryIsAdmission", "Inv_NoSiblingCarry", "Inv_CarryOnError",
        "Inv_NoEffectBeforeAdmit", "Inv_FailedCarryNoEffect", "Inv_LegacyShape", "Inv_GateHolds"]

# id, group, spec, constants, invariants, properties, expected, deadlock, note
CASES = [
 # ---- the design ----
 ("ca.design", "design", "Spec", c(), SAFE, [], "PASS", False,
  "Two branches, two visits each, errors, a set_vars race, a crash and replay, a cancellation."),
 ("ca.design-carry-fails", "design", "Spec", c(carryfail=True), SAFE, [], "PASS", False,
  "A failed carry selection admits invalid_input with a null carry and no effect."),
 ("ca.design-input-fails", "design", "Spec", c(inputfail=True), SAFE, [], "PASS", False,
  "A failed input mapping after a valid selection keeps the snapshot with the immediate failure."),
 ("ca.legacy", "design", "Spec", c(optin=False), SAFE, [], "PASS", False,
  "No carry declared: no snapshot, the raw result arrives as today."),
 ("ca.live", "design", "LiveSpec", c(), ["TypeOK"], ["Prop_Progresses"], "PASS", False,
  "Every visit arrives unless the run is cancelled."),
 # ---- faults (the design's required negative mutants and more) ----
 ("fault.ca-reeval-at-completion", "fault", "Spec", c(nb=1, cancel=False, reeval=True), ["Inv_CarryIsAdmission"], [],
  "VIOLATION:Inv_CarryIsAdmission", False, "The carry is evaluated again at completion: a later set_vars changes it."),
 ("fault.ca-non-atomic", "fault", "Spec", c(nb=1, v=1, nonatomic=True), ["Inv_NoEffectBeforeAdmit"], [],
  "VIOLATION:Inv_NoEffectBeforeAdmit", False, "The snapshot is written after the node: the effect starts without it."),
 ("fault.ca-non-atomic-changes", "fault", "Spec", c(nb=1, v=1, nonatomic=True), ["Inv_SnapshotImmutable"], [],
  "VIOLATION:Inv_SnapshotImmutable", False, "The late snapshot write changes the admitted (null) snapshot."),
 ("fault.ca-shared-carry", "fault", "Spec", c(v=1, crash=0, cancel=False, shared=True), ["Inv_NoSiblingCarry"], [],
  "VIOLATION:Inv_NoSiblingCarry", False, "One snapshot per state and visit: a branch receives its sibling's carry."),
 ("fault.ca-reeval-on-replay", "fault", "Spec", c(nb=1, v=1, cancel=False, replay=True), ["Inv_SnapshotImmutable"], [],
  "VIOLATION:Inv_SnapshotImmutable", False, "A replayed admission overwrites the snapshot with a new evaluation."),
 ("fault.ca-legacy-on-error", "fault", "Spec", c(nb=1, v=1, legacyerr=True), ["Inv_CarryOnError"], [],
  "VIOLATION:Inv_CarryOnError", False, "Today's behaviour: an error replaces the carried data."),
 ("fault.ca-failed-carry-effect", "fault", "Spec", c(nb=1, v=1, carryfail=True, failedeffect=True),
  ["Inv_FailedCarryNoEffect"], [], "VIOLATION:Inv_FailedCarryNoEffect", False, "A failed selection still runs the effect."),
 # ---- witnesses ----
 ("wit.ca-carried-error", "witness", "Spec", c(nb=1), ["W_NoCarriedError"], [], "VIOLATION:W_NoCarriedError", False,
  "An error result arrives with its carry."),
 ("wit.ca-kv-changed-after-admission", "witness", "Spec", c(nb=1), ["W_NoKvChangeAfterAdmission"], [],
  "VIOLATION:W_NoKvChangeAfterAdmission", False, "The KV changes after the admission; the carry keeps the admitted value."),
 ("wit.ca-invalid-with-snapshot", "witness", "Spec", c(nb=1, inputfail=True), ["W_NoInvalidWithSnapshot"], [],
  "VIOLATION:W_NoInvalidWithSnapshot", False, "An input-mapping failure routes with the valid snapshot."),
 # ---- ca2: the controller 1.1.0 gate ----
 ("ca2.gate-off", "design", "Spec", c(gate=False), SAFE, [], "PASS", False,
  "Controller 1.0.0 with an IR that declares carry: raw results, no snapshot."),
 ("fault.ca2-gate-ignored", "fault", "Spec", c(nb=1, v=1, gate=False, gateignored=True), ["Inv_GateHolds"], [],
  "VIOLATION:Inv_GateHolds", False, "The controller honours an IR carry at 1.0.0."),
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
