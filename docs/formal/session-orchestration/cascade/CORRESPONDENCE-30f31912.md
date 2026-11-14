# DeleteCascade correspondence to 30f31912 (candidate)

Code at `30f31912fdae5d46d1811392254adfb2bb31c4bf` (Valkyrie's `valkyrie-delete-cascade`, base Release C `1bc1f3cb`).
A candidate: Valkyrie is still adding deadline and abort tests, documents and a GPT-family review. Paths are under
`packages/sdk/src/`; line numbers are at `30f31912`. Frozen trees, the registry and the version file are unchanged
(`git diff 1bc1f3cb 30f31912` touches none of `orchestration_1_0_8*`, `orchestration-registry.ts`,
`orchestration-version.ts`); no migration.

## Recorded orchestration actions (live 1.0.85 only)

| Site | Change | Replay |
|---|---|---|
| `orchestration/agents.ts` 599 | `utcNow` at the start of the delete branch; deadline = start + 50 s | terminal branch; no 1.0.85 history exists (Ace, option (i): one TEST deploy after the cascade) |
| 605 | `getDescendantSessionIds {sessionId, strictCascade: true, deadlineAtMs}` | as above |
| 614 | descendant `deleteSession {sessionId, reason, strictCascade, deadlineAtMs}` (no `selfDelete`) | as above |
| 630-636 | the root `deleteSession {..., selfDelete: true, strictCascade, deadlineAtMs}` only when nothing failed | as above |
| 648 onward | the FB-034 failure branch, unchanged: response, then failed custom status, then failed CMS state | as bound at `1bc1f3cb` |
| 1334-1335 | delete_agent's terminal route: `utcNow`, then `deleteSession {sessionId, reason, strictCascade, deadlineAtMs}` | not terminal; safe only because no 1.0.85 history exists (option (i)) |

The proxy adds each optional key only when set (`session-proxy.ts` 1312, 1330): frozen 1.0.84 still sends
`{sessionId}` and `{sessionId, reason}`.

## Model to code

| Model (`DeleteCascade.tla`) | Code at 30f31912 |
|---|---|
| `Strict`, `StrictGated` | `session-proxy.ts` 7238 (listing) and 7301-7309 (delete): the strict path only when `strictCascade === true`; otherwise the legacy listing (`cmsRetryCritical`, as before) and the legacy client cascade with `strictCascade: false` (7348), whose body is the `1bc1f3cb` code (`client.ts` 608, 667) |
| `GuardShared = FALSE` | the guard runs only under `requireNoLiveChildren`, passed only by the strict paths (`client.ts` 653-662; `management-client.ts` 1072) |
| `EnumOnFail = "fail"` | `agents.ts` 605: a listing error sets `deleted = false`; the root is not attempted (630). In the activity, `deleteSessionSubtree` throws before any deletion when the listing or a row read fails, or the snapshot changed (`session-delete.ts` 63 onward) |
| act layer, `SkipBlocked`, `Order = "bottomUp"` | `deleteSessionSubtree`: post-order over the snapshot; a failure blocks every ancestor (114); independent siblings continue; any failure throws, so the target (an ancestor of every node) is never deleted after a failure |
| orch layer, `OrchSkip = "root"`, `OrchAbort = FALSE`, `ReportSkipped` | `agents.ts` 609-620: each listed descendant is still asked for, a failure sets `deleted = false`; the root is skipped (630) and the failure branch answers |
| `Guard`, `MaxRecheck = 0` | `cms.ts` 2343-2360: one READ COMMITTED transaction (`cms-delete-transaction.ts` 44-48); `FOR NO KEY UPDATE` on the target, then a separate statement for a live direct child, refusal `SESSION_HAS_LIVE_CHILDREN`; no re-listing |
| spawns atomic with the guard | creators lock the parent before inserting: 0094's `FOR SHARE` (`cms_create_session`, `cms_create_workflow_session`), and the TypeScript create paths' parent lock (`cms.ts` 1843, 1880, 1980; `FOR NO KEY UPDATE` where a claim follows). Both conflict with the guard's `FOR NO KEY UPDATE`; Valkyrie's tests cover both orders |
| `SharedDeadline`, `Cancellable`, `AttemptDeadline` | `SessionDeleteBudget` (`session-delete.ts` 9 onward): one deadline from the orchestration's `utcNow` (or the direct caller's clock); each attempt `min(3 s, remaining)` and aborted at it, the retry pauses also cut at the deadline; the server side has `SET LOCAL statement_timeout` and `lock_timeout` (`cms-delete-transaction.ts` 46); a connection acquired after the end is released unused (41) |
| `Hang` | a lock wait or a slow statement: ended by `lock_timeout`/`statement_timeout` and by the client abort |
| self-delete (bound at `1bc1f3cb`) | the strict client skips the cancel for the target only when `selfDelete` (`session-proxy.ts` 7309 onward; `client.ts` 608) |

Not modeled, checked by reading:

- A cancel that times out never leads to a soft delete (`endSessionBeforeDelete`, `session-delete.ts` 129 onward); a
  non-timeout cancel error proceeds only if the instance is already ended or absent.
- A COMMIT whose answer is lost may have committed: the node is then reported failed and its ancestors are kept. This
  is conservative (never a false success); a repeat delete is idempotent (a missing root returns at once).
- A guard refusal after a successful cancel leaves that node cancelled but live; the error text says so and that a
  repeat delete completes it. On the management client the "cancel" is `deleteInstance` (the history is purged): the
  row is then live with no instance, and its status read takes the terminal fast path on a retry.
- Clock skew between the worker that ran `utcNow` and the one that runs the activity is inside the 15 s margin.

## Results

dc3 (36/36) covers the implemented policy with `OrchSkip = "all"`. dc4 (40/40, 2026-11-13 22:08Z) adds the exact
`OrchSkip = "root"` shape: `dc4.impl-30f31912` (796 distinct states), `-spawn-mid` (1,126) and `-tight` (528) pass
`Inv_NoNewOrphan`, `Inv_TruthfulReply`, `Inv_InBudget` and `Prop_Answers`; `dc4.inner-skip-suffices` shows the
activity's post-order skip alone keeps every ancestor of a failed node; `dc3.impl-frozen` and the `dc.frozen-*` cases
show frozen 1.0.84 is no worse than today.

`8810ba8d` adds tests and documents only (`packages/sdk/src` identical to `30f31912`); its budget and atomic tests
exercise the abort, late-acquisition, lost-COMMIT and shared-deadline rows above.

## Verdict

Bound at `30f31912` (source), candidate. Final binding re-pins to Valkyrie's final head if `packages/sdk/src` is
unchanged; any production change needs a re-read.

## Final pin

`d8afdf78fd113414cab23689da6a66fcb445225a` (`waldemort/valkyrie-delete-cascade-reviewed`), one commit on `1bc1f3cb`.
`packages/sdk/src` is tree `15e20127d26538e48ad499849be10cbecca3a034`, identical to `30f31912`, so every row above holds
at the same line numbers; the whole tree is `d294de2b` (equal to Valkyrie's `4e265a1f`, which adds tests and documents
only). Frozen trees, registry and version file unchanged. Bound.

Re-pinned to `6a229b64112f30c5885d6fcb844ff695993fbc88` (`waldemort/valkyrie-delete-cascade-final`), one commit on
`1bc1f3cb`: the only difference from `d8afdf78` is 13 lines of `docs/architecture/orchestration/design.md`, which now
state the two documented limits (management `deleteInstance` can leave a live row with no runtime, recovered by a
retry; a running management delete can still end in the generic 65 s settle timeout). `packages/sdk/src` tree
`15e20127` and `packages/sdk/test` tree `f15351df` are unchanged. Bound.

FB-058 (`a46213ad`, merged in Release C) narrows the second limit above. After the delete command is sent, a
management delete of a running session keeps the same 65 s budget, reserving its last 3 s to read the correlated
command reply. A readable correlated failure reply supplies the failure and its cause. Otherwise the original wait or
read outcome stands: a missing, unreadable or late reply leaves the generic settle timeout; a status-read error during
the wait is reported as that read error; and a success that completes after the observation window ends (62 to 65 s)
still ends in the timeout, a known false failure. Calls before the command is sent are not bounded by this budget.
Source change in `management-client.ts` only; the bound cascade source is otherwise unchanged.
