#!/usr/bin/env python3
"""Writes cases.tsv, cases.json and tlc-templates.json for the delete-cascade model (FB-037/038/039), batch dc1.
No TLC is run here. The .cfg files are generated from these by run-tlc.sh (../../tlc_cases.py)."""
import json
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", ".."))
import tlc_cases   # docs/formal/tlc_cases.py

BATCH = "dc4"
M = "DeleteCascade"


def q(x):
    return f'"{x}"'


def s(xs):
    return "{" + ", ".join(str(x) for x in sorted(xs)) + "}"


# Tree (fixed in the module): 1 = T; 2 child of 1; 3 child of 2; 4 = a late spawn, child of `spar` (1, 2 or 3).
def c(frozen=False, gated=True, enum="fail", act_abort=True, orch_abort=True, order="any", guard=True, shared=False,
      recheck=1, report=True, skip=False, orch_skip=None, direct=False, faults=1, retries=2, budget=16, perm=(), spawn=False, spar=1,
      hang=False, bound=3, deadline=True, cancellable=True):
    return dict(SpawnPar=spar, InitLive="{1, 2, 3}",
                Spawnable="{4}" if spawn else "{}", PermFail=s(perm), MaxFaults=faults, Retries=retries,
                Budget=budget, Frozen=frozen, StrictGated=gated, EnumOnFail=q(enum), ActAbort=act_abort,
                OrchAbort=orch_abort, Order=q(order), Guard=guard, GuardShared=shared, MaxRecheck=recheck, ReportSkipped=report, SkipBlocked=skip,
                OrchSkip=q(orch_skip if orch_skip else ("all" if skip else "none")),
                DirectRoute=direct, Hang=hang, AttemptDeadline=bound, SharedDeadline=deadline, Cancellable=cancellable)


TODAY = dict(enum="empty", act_abort=False, orch_abort=False, report=False, guard=False, deadline=False)
SAFE = ["TypeOK", "Inv_NoNewOrphan", "Inv_TruthfulReply", "Inv_InBudget"]
LIVE = ["Prop_Answers"]

# id, group, constants, invariants, properties, expected, note
CASES = [
 ("dc.design-faults", "design", c(faults=2, spawn=True), SAFE, LIVE, "PASS",
  "The fix: a failed listing fails the delete, the first failed descendant stops the activity and the orchestration, "
  "and the soft delete refuses a row with a live child. Two transient faults and a late spawn under T."),
 ("dc.design-perm-grandchild", "design", c(perm=[3], spawn=True), SAFE, LIVE, "PASS",
  "The grandchild cannot be deleted: the delete answers an error and leaves no orphan."),
 ("dc.design-perm-child", "design", c(perm=[2]), SAFE, LIVE, "PASS", "As above, for the child."),
 ("dc.design-spawn-deep", "design", c(spawn=True, spar=3), SAFE, LIVE, "PASS",
  "The late spawn lands under the grandchild, below the activity's listing."),
 ("dc.design-spawn-mid", "design", c(spawn=True, spar=2, faults=0), SAFE, LIVE, "PASS",
  "The late spawn lands under the child."),
 ("dc.design-bottomup", "design", c(order="bottomUp", perm=[3], spawn=True), SAFE, LIVE, "PASS",
  "Deepest-first order, with a failing grandchild and a late spawn."),
 ("dc.design-continue", "design", c(act_abort=False, orch_abort=False, perm=[3], spawn=True), SAFE, LIVE, "PASS",
  "Both layers carry on after a failed descendant but report it; the guard alone keeps every ancestor."),
 ("dc.design-no-recheck", "design", c(recheck=0, spawn=True), SAFE, LIVE, "PASS",
  "No re-listing after a guard refusal: a late spawn makes the delete answer an error, truthfully."),
 ("dc.design-hang", "design", c(hang=True, faults=2, spawn=True), SAFE, LIVE, "PASS",
  "Two attempts hang: each is bounded and cut at the shared deadline, which ends the delete with an error in time."),
 ("dc.design-hang-tight", "design", c(hang=True, faults=2, budget=7, perm=[3]), SAFE, LIVE, "PASS",
  "As above with a budget that the deadline actually reaches."),
 ("dc.design-single-layer", "design", c(direct=True, faults=2, spawn=True, spar=2, hang=True), SAFE, LIVE, "PASS",
  "The single-layer shape: the orchestration schedules one strict self-delete and the activity does the cascade."),
 ("dc.design-direct", "design", c(direct=True, perm=[3], spawn=True), SAFE, LIVE, "PASS",
  "FB-039: delete_agent's terminal-child route, one activity with bounded retries."),
 # ---- dc3: the implemented shape (Valkyrie, 21:54Z) ----
 ("dc3.impl", "design",
  c(act_abort=False, orch_abort=False, skip=True, order="bottomUp", recheck=0, hang=True, faults=2, perm=[3], spawn=True),
  SAFE, LIVE, "PASS",
  "As implemented: both layers carry on with independent siblings, skip every ancestor of a failed node and never "
  "attempt their own target after a failure; post-order; the guard with no re-listing; attempts cut at the shared deadline."),
 ("dc3.impl-any-order", "design",
  c(act_abort=False, orch_abort=False, skip=True, recheck=0, hang=True, faults=2, perm=[3], spawn=True, spar=2),
  SAFE, LIVE, "PASS", "As above with no ordering promise from the outer listing, and the late spawn under the child."),
 ("dc3.impl-tight", "design",
  c(act_abort=False, orch_abort=False, skip=True, order="bottomUp", recheck=0, hang=True, faults=2, budget=7, spawn=True),
  SAFE, LIVE, "PASS", "As implemented, with a budget the shared deadline reaches."),
 ("dc3.impl-1328", "design",
  c(direct=True, act_abort=False, orch_abort=False, skip=True, order="bottomUp", recheck=0, hang=True, faults=2,
    perm=[3], spawn=True, spar=3),
  SAFE, LIVE, "PASS", "delete_agent's terminal route (agents.ts 1328) with the strict input: one activity, the same policy."),
 # ---- dc4: exactly as committed at 30f31912 ----
 ("dc4.impl-30f31912", "design",
  c(act_abort=False, orch_abort=False, skip=True, orch_skip="root", order="bottomUp", recheck=0, hang=True, faults=2,
    perm=[3], spawn=True),
  SAFE, LIVE, "PASS",
  "30f31912: the activity skips blocked ancestors and its target after a failure; the orchestration calls the activity "
  "for every listed descendant, in any order, and skips only T after a failure."),
 ("dc4.impl-30f31912-spawn-mid", "design",
  c(act_abort=False, orch_abort=False, skip=True, orch_skip="root", order="bottomUp", recheck=0, hang=True, faults=2,
    spawn=True, spar=2),
  SAFE, LIVE, "PASS", "As above, a late spawn under the child and no permanent failure."),
 ("dc4.impl-30f31912-tight", "design",
  c(act_abort=False, orch_abort=False, skip=True, orch_skip="root", order="bottomUp", recheck=0, hang=True, faults=2,
    budget=7, perm=[2], spawn=True, spar=3),
  SAFE, LIVE, "PASS", "As above with a budget the deadline reaches and the child failing."),
 ("dc4.inner-skip-suffices", "design",
  c(act_abort=False, orch_abort=False, skip=True, orch_skip="none", order="bottomUp", recheck=0, guard=False, perm=[3],
    faults=1),
  ["TypeOK", "Inv_NoNewOrphan", "Inv_TruthfulReply"], LIVE, "PASS",
  "Defence in depth: even if the orchestration still asked for T after a failure, and with no guard, the activity's own "
  "post-order skip keeps every ancestor of a failed node. (Late spawns still need the guard: mut.dc-no-guard.)"),
 ("dc3.impl-frozen", "design",
  c(frozen=True, act_abort=False, orch_abort=False, skip=True, order="bottomUp", recheck=0, perm=[3], spawn=True),
  ["TypeOK", "Inv_FrozenNoWorse"], LIVE, "PASS", "Frozen 1.0.84 under the implemented build: the legacy path is untouched."),
 ("wit.dc3-sibling-deleted", "witness",
  c(act_abort=False, orch_abort=False, skip=True, order="bottomUp", recheck=0, perm=[3], spawn=True, spar=1),
  ["W_NoLateSpawn"], [], "VIOLATION:W_NoLateSpawn",
  "Carrying on: an independent sibling (the spawn under T) is still deleted while the grandchild fails."),
 ("mut.dc3-no-skip-no-guard", "mutant",
  c(act_abort=False, orch_abort=False, skip=False, guard=False, order="bottomUp", recheck=0, perm=[3], faults=0),
  ["Inv_NoNewOrphan"], [], "VIOLATION:Inv_NoNewOrphan",
  "Carrying on without skipping the blocked ancestors and without the guard deletes the failed node's parent."),
 ("dc.frozen-gated", "design", c(frozen=True, perm=[3], faults=1, spawn=True), ["TypeOK", "Inv_FrozenNoWorse"], LIVE, "PASS",
  "Frozen 1.0.84 calls the shared activity without the 1.0.85 flag: today's behaviour, and the guard is not applied to it."),
 ("dc.frozen-gated-guard-off", "design", c(frozen=True, guard=False, perm=[2], faults=1), ["TypeOK", "Inv_FrozenNoWorse"], LIVE, "PASS",
  "As above with no guard at all."),
 # ---- today's code ----
 ("find.dc-today-enum-empty", "finding", c(retries=1, **TODAY), ["Inv_NoNewOrphan"], [], "VIOLATION:Inv_NoNewOrphan",
  "Today: a failed listing is read as no descendants, and T is deleted over its live subtree."),
 ("find.dc-today-child-fail", "finding", c(faults=0, perm=[3], **TODAY), ["Inv_TruthfulReply"], [], "VIOLATION:Inv_TruthfulReply",
  "Today (FB-037): a descendant that cannot be deleted is traced and skipped, and the caller is told \"Session deleted\"."),
 ("find.dc-today-child-orphan", "finding", c(faults=0, perm=[3], **TODAY), ["Inv_NoNewOrphan"], [], "VIOLATION:Inv_NoNewOrphan",
  "Today: the same skipped grandchild is left live under its deleted parent."),
 ("find.dc-today-spawn", "finding", c(faults=0, spawn=True, **TODAY), ["Inv_NoNewOrphan"], [], "VIOLATION:Inv_NoNewOrphan",
  "Today: a spawn that commits after the listing is left live under a deleted parent."),
 # ---- one rule removed from the fix ----
 ("mut.dc-no-guard", "mutant", c(faults=0, spawn=True, guard=False), ["Inv_NoNewOrphan"], [], "VIOLATION:Inv_NoNewOrphan",
  "Stopping at the first failure is not enough: without the guard a late spawn is orphaned."),
 ("mut.dc-enum-empty", "mutant", c(retries=1, enum="empty", guard=False), ["Inv_NoNewOrphan"], [], "VIOLATION:Inv_NoNewOrphan",
  "Reading a failed listing as empty orphans the subtree when nothing else stops the delete."),
 ("mut.dc-continue-no-guard", "mutant", c(faults=0, perm=[3], act_abort=False, guard=False), ["Inv_NoNewOrphan"], [],
  "VIOLATION:Inv_NoNewOrphan", "Carrying on after a failed descendant, without the guard, deletes its parent."),
 ("mut.dc-frozen-ungated", "mutant", c(frozen=True, gated=False, perm=[3], faults=0), ["Inv_FrozenNoWorse"], [],
  "VIOLATION:Inv_FrozenNoWorse",
  "The strict activity applied to a frozen 1.0.84 caller: T is skipped after a failed descendant, but 1.0.84 has "
  "already answered \"Session deleted\" and ends: a live row with an ended orchestration."),
 ("mut.dc-frozen-guard-shared", "mutant", c(frozen=True, shared=True, perm=[3], faults=0), ["Inv_FrozenNoWorse"], [],
  "VIOLATION:Inv_FrozenNoWorse", "As above, when the guard is in the one SQL function every caller uses."),
 ("mut.dc-budget", "mutant", c(retries=3, budget=8, faults=2, deadline=False), ["Inv_InBudget"], [],
  "VIOLATION:Inv_InBudget", "No shared deadline: retries that the caller's patience cannot cover."),
 ("mut.dc-hang-unbounded", "mutant", c(hang=True, bound=0, cancellable=False), ["Inv_InBudget"], [],
  "VIOLATION:Inv_InBudget", "An attempt with no per-attempt bound that the deadline cannot cancel: one hang outlasts the caller."),
 ("mut.dc-hang-not-cancellable", "mutant", c(hang=True, bound=3, cancellable=False, faults=2, budget=7), ["Inv_InBudget"], [],
  "VIOLATION:Inv_InBudget", "Bounded attempts that the deadline cannot cut: one starting just before the deadline overruns it."),
 # ---- witnesses ----
 ("wit.dc-ok", "witness", c(spawn=True), ["W_NoOk"], [], "VIOLATION:W_NoOk", "The fixed delete can still succeed."),
 ("wit.dc-error", "witness", c(perm=[3]), ["W_NoError"], [], "VIOLATION:W_NoError", "It can answer an error."),
 ("wit.dc-late-spawn-deleted", "witness", c(spawn=True), ["W_NoLateSpawn"], [], "VIOLATION:W_NoLateSpawn",
  "A late spawn is found by the re-listing and deleted with the rest."),
]


def cfg(cid, consts, invs, props, note, expected):
    lines = [f"\\* {cid} ({BATCH}; expected {expected}): {note}", "SPECIFICATION Spec", "CONSTANTS"]
    lines += [f"    {k} = {str(v).upper() if isinstance(v, bool) else v}" for k, v in consts.items()]
    lines += ["INVARIANTS"] + [f"    {i}" for i in invs]
    if props:
        lines += ["PROPERTIES"] + [f"    {p}" for p in props]
    lines.append("CHECK_DEADLOCK TRUE")
    return "\n".join(lines) + "\n"


def main():
    rows, meta, texts = [], [], []
    for cid, group, consts, invs, props, expected, note in CASES:
        name = f"{cid}.cfg"
        texts.append(cfg(cid, consts, invs, props, note, expected))
        rows.append(f"{cid}\t{name}\t{M}")
        meta.append(dict(id=cid, module=M, group=group, spec="Spec", config=name, invariants=invs, properties=props,
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
