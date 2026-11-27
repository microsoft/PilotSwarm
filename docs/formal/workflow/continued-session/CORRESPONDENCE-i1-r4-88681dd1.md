# WfContinuedSession i1 review R4 correspondence to 88681dd1

Code: `packages/sdk/src` at `88681dd1` (issue I1 with the fix of review R4); line numbers there. The model does not
change for R4; this note says why its atomic turn-start read is a faithful abstraction of the code at this commit.

| Model | Code at 88681dd1 |
|---|---|
| `TurnStart(s)` reads `vis[u].node` and skips a decided visit's turn (`skip`), in one step with the decision steps (`TurnReport`, `Timeout`, `EndVisit`'s decisions) ordered before or after it | Both admission paths call `decidedAtAdmission` (`session-proxy.ts` 4848-4853; used at 4873 and 4934). After `readTurnVisit` chose the turn's fixed visit (unchanged: a continued session's open or inherited visit), it reads that visit with `readNodeStateAfterWriters` (`workflow/store.ts` 4527-4533, `SELECT state ... FOR SHARE`), which waits for any decision that already holds its `FOR UPDATE` on the node row (until that transaction commits or rolls back, including a COMMIT in flight whose answer was lost) and then reads the latest committed state. A decision that takes the row lock after the read is ordered after it. So every decision is ordered either before the read or after it, as in the model's single step. A transaction's earlier `BEGIN` alone does not order it: only its row lock does. A read that times out (10 s) or fails throws: the turn fails and is retried, which the model's stuttering (no step) covers |

Review R4-1's case, a retry on another worker while the first worker's completion is still committing, is a decision
whose COMMIT lands after the retry's plain `readTurnVisit`. At `85af7dac` the retry ran on that plain read (an
interleaving the atomic `TurnStart` cannot show, so the model did not catch it); at `88681dd1` the admission read waits
for that COMMIT and skips the turn, matching `TurnStart`.

The recovery helper that drops a decided turn's lost session (`notRunAgain`, `session-proxy.ts` 5267-5273) now bounds
its disconnect at 5 s (`DROPPED_TURN_DESTROY_DEADLINE_MS`, 5269), as the forced-stop drops do (R3-3); not modelled, as
in `CORRESPONDENCE-i1-r3-19bd0cc1.md`.
