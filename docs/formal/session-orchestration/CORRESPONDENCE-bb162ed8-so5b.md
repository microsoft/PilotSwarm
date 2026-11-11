# Correspondence of the so5b batch (late-cancel give-back fixes) to `bb162ed8`

Code at `bb162ed8` (the so4b fixes, the same-pass rule and the idle-wake fix). `packages/sdk/src` is byte-identical at
`8aaf5435`, this line on v0.8.10. Line numbers at `bb162ed8`.

## `CarriedGiveBack` (`packages/sdk/src/orchestration_1_0_83/`)

| Model | Code |
|---|---|
| `DrainPrompt` text and markers | `queue.ts` 1340-1346 (`carriedByItem.set`; `markCarriedWork` 456 called at 1346) |
| `Chrono = "observed"` (F1a) | `observedChronology` 485 (a non-number or non-finite `observedAtMs` counts as 0); `restorePendingChildDigest` `lifecycle.ts` 486 (ties: pending newer) |
| `SkipQueued = "rank"` (F1b) | `giveBackDroppedPromptWork` 506; decide-fifo 1703-1705 (`later` = `queuedFifoItems` 271); decide-merge 1589-1590 (`later` = items after the dropped one; `runningNow` = the dispatched prompt and those merged so far, for the notice only) |
| `PassSkip = "rank"`, `PassNotice` (same-pass) | `giveBackCarriedWork` 413: a carried entry is skipped iff a later stash prompt not itself given back carries one for the same child of equal or higher `childUpdateRank`; the notice iff such a prompt, or a queued FIFO prompt's marker (421), carries one, or one is pending. Callers 1035 (tombstone), 1048 and 1357 (FIFO refusal) |
| `SweepCan = "requeue"` (F2) | `decide` 1685 `peekNextDispatchFifoItem` (259), sweep with the prompt still in KV, pop 1690; trace if they differ 1694 |
| `Restore`, `Buffer` | `lifecycle.ts` 486-512, 440-474 |

Not modelled: decide-merge (the dispatched and merged prompts precede the dropped peer, so their entries are older;
they count only for the notice). Model abstraction: in `PassCancel` the last two FIFO items stand for the pass's stash
and any earlier items for prompts queued in earlier passes (`cg.same-pass-queued` checks that they count only for
the notice).

## `RehydrationNotice`

so2's module, unchanged: the late-cancel give-back (`LateGiveBack`) at decide-fifo 1705 and decide-merge 1590.
