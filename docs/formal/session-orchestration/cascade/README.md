# Session delete cascade (FB-037/038/039), batch dc4

`DeleteCascade.tla` models a delete of session T in its two layers. The orchestration layer is `cancelSession`'s
delete branch: it lists T's live descendants, calls the `deleteSession` activity for each, then for T, then answers.
The activity layer is `PilotSwarmClient.deleteSession`: it lists the target's live descendants again, soft-deletes
each, then the target. The listing (`cms_get_descendant_session_ids`) walks live rows only and has no `ORDER BY`. A spawn
takes its parent FOR SHARE and refuses a deleted parent (0094), so a spawn and a soft delete of its parent are atomic
steps here. Code read at Release C `1bc1f3cb`; no implementation exists yet for the fix.

Policies are constants, so today's code, the proposed fix and the frozen 1.0.84 caller are cases of one model:

| Constant | Today (1bc1f3cb) | Proposed fix (live 1.0.85) |
|---|---|---|
| `EnumOnFail` | `"empty"`: a failed listing is read as no descendants | `"fail"`: the delete fails |
| `ActAbort`, `OrchAbort` | FALSE: a failed descendant is traced and skipped | stop at the first failure, or carry on (both pass with the guard) |
| `ReportSkipped` | FALSE: the skipped failure is not reported | TRUE: a layer that carries on still reports the failure |
| `SkipBlocked` | n/a | the activity (strict) carries on with independent siblings, skips every ancestor of a failed node and never deletes its target after a failure |
| `OrchSkip` | `"none"` | `"root"` at `30f31912`: the orchestration still asks for every listed descendant but never for T after a failure (`"all"`, dc3, also skips listed ancestors) |
| `Guard` | FALSE | the soft delete refuses a row that still has a live child, atomically with spawns |
| `MaxRecheck` | none | re-list after a guard refusal, within the budget |
| `StrictGated` | n/a | strict behaviour only when the 1.0.85 caller asks for it, by an optional, omitted-when-absent activity input |
| `GuardShared` | n/a | FALSE: the guard is not applied to frozen 1.0.84 callers |
| `SharedDeadline`, `Cancellable`, `AttemptDeadline` | none | one request deadline on the strict path, checked before every listing and attempt; each attempt bounded and cut at the deadline |
| `Hang` | n/a | environment: an attempt may hang (a lock wait) instead of failing fast |
| `DirectRoute` | delete_agent's terminal route | also the single-layer shape: one strict self-delete, the activity does the cascade |

The tree is fixed in the module (1 = T, 2 its child, 3 a grandchild, 4 a late spawn under `SpawnPar`); dc1 passed it
as a tuple constant, which TLC's configuration files do not accept, so no dc1 case was checked.

Properties:

- `Inv_NoNewOrphan`: no live row under a deleted ancestor.
- `Inv_TruthfulReply`: a 1.0.85 "ok" means the whole subtree, late spawns included, is gone.
- `Inv_FrozenNoWorse`: under a frozen 1.0.84 caller, T's row survives only for a reason 1.0.84 meets today.
- `Inv_InBudget`: time spent stays within the caller's budget (the 65 s, scaled). Fails without the shared deadline, with an
  unbounded attempt, or with bounded attempts the deadline cannot cut.
- `Prop_Answers`: the delete answers.

Expected: the fix passes every design case; today's code violates `Inv_NoNewOrphan` (failed listing, skipped
descendant, late spawn) and `Inv_TruthfulReply` (FB-037); the strict activity or the guard applied to a frozen 1.0.84
caller violates `Inv_FrozenNoWorse`.

Not modeled: cancellation of orchestrations (bound in `../CORRESPONDENCE-latest-1085.md`), the other client callers
(portal, agent tools, regen worker, Workflow delete), and the cleanup of orphans that exist already.

Run: `python3 gen-cases.py`, then `./run-tlc.sh <out>` (v1.7.4).

## Results

| Batch | Run | Outcome |
|---|---|---|
| dc1 | 2026-11-13 21:4xZ | Not checked: the tuple constant `Par` is not accepted in a TLC configuration file (all 24 cases stopped at line 5). Fixed in dc2 |
| dc2 | 2026-11-13 21:46Z, TLC 2.19, two workers, 300 s per case | 29 of 29 as expected: 14 PASS (largest `dc.design-hang`, 1,869 distinct states), 15 VIOLATION each on its named property; no timeouts or errors |
| dc3 | 2026-11-13 21:57Z, as dc2 | 36 of 36 as expected: 19 PASS, 17 VIOLATION. New: `dc3.impl` 512, `-any-order` 1,437, `-tight` 647, `-1328` 151, `-frozen` 235 distinct states. dc2's design cases keep their counts except `dc.design-continue` (495 to 496): the new per-frame `failed` set is state even where the policy is off, and that case reaches one more distinct frame |
| dc4 | 2026-11-13 22:08Z, as dc2 | 40 of 40 as expected: 23 PASS, 17 VIOLATION. New: `dc4.impl-30f31912` 796, `-spawn-mid` 1,126, `-tight` 528, `dc4.inner-skip-suffices` 51 distinct states. Every dc3 PASS count unchanged |

The implemented shape (Valkyrie, 21:54Z): two layers that carry on with independent siblings, skip every ancestor of a
failed node and never attempt their own target after a failure; post-order; the guard with a distinct error and no
re-listing; a shared deadline with attempts cut at it; the same strict input on delete_agent's terminal route. dc3 adds
it as the `dc3.*` cases.
