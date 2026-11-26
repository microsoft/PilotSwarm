# Issue 412: implementation report

This is the last of the four documents for issue 412. The other three are
[design-spec.md](design-spec.md) (terms, rule and design),
[impl-spec.md](impl-spec.md) (steps) and [test-spec.md](test-spec.md) (tests).
This report uses the terms that design-spec.md §1 defines: *finished Workflow
session*, *active session*, *kept session*, and the Sweeper's *final check*.

## Open items

The independent review ran three rounds. Rounds 1 and 2 asked for changes, and
all their findings are fixed. Round 3 found one more blocker, and it is **not
fixed** in this pull request. The Workflow published the change after the third
round, as its rules say.

### Open finding (review round 3, blocker): a Workflow started after a prune is kept but not shown

**The reviewer's case.** Root session `R` is pending (it never accepted a
message), so its orchestration reads `NotFound`. Its ordinary child `O` is idle.
`O` has a saved Workflow Definition but has not started it yet, so no Workflow
session exists under `R`.

1. `prune_orchestrations` runs. The final check finds no Workflow session under
   `R`, so the prune soft-deletes `R` without cascade and leaves `O` in place.
2. `O` starts its saved definition. Start accepts this: it checks only that `O`
   itself is live (`session-definition-store.ts`, `lockLiveOwnerSession`), and
   its nesting-level query also counts `R`'s soft-deleted row
   (`session-definition-store.ts`, `nestingLevel`).
3. The run ends. The new Workflow session `W` is kept, because `O` is active.
4. The session list and the portal build their tree from parent links and skip
   a session whose parent is not listed (`packages/app/ui/core/src/session-tree.js`
   L274-L304). `R` is deleted, so `O` and `W` are not shown. The owner cannot
   open `W` under **Terminated**, which the issue requires (requirement 2).

A Start that is queued behind the prune reaches the same state. No race is
needed.

**Assessment.** The finding is correct; I confirmed each step in the code on
`main`. The design excluded this case on purpose. design-spec.md §3.7 calls it
`main`'s prune behavior, and the formal model names it `Wit_CreatedAfter` and
leaves it out of its invariant (`WorkflowPrune.tla` L169). But the issue makes
no such exception, so the exclusion does not hold.

The root cause is older than this change. On `main` the prune already leaves a
live ordinary session such as `O` under a deleted root, and the portal already
hides `O` from then on. This change stops the prune whenever a Workflow session
is already under its target (`WorkflowBelow`). It does not stop a session left
under a deleted target from starting a new Workflow later.

**Proposed fix (follow-up 1).** Make Start refuse when an ancestor of the
owning session is deleted:

- In `lockLiveOwnerSession`, also read the owner's ancestors and lock them
  `FOR SHARE`.
- If one of them is deleted, refuse with `SESSION_NOT_FOUND`.

The prune already locks the sessions that it leaves under its target
(NOWAIT) and reads them again before it commits (design-spec.md §3.7). So a
Start either commits before the prune, and the prune then refuses
`WorkflowBelow`, or starts after the prune, and the Start refuses.

Before the change, add this regression test:

1. Prune `R`.
2. Start `O`'s saved definition.
3. Expect the Start to be refused. If the design allows the Start instead,
   finish the run and expect the Workflow in `O`'s Terminated row.

Also extend `WorkflowPrune.tla` so that `Inv_KeptShown` covers a Workflow
created after the prune.

Another fix is to refuse every prune that would leave a live session under its
target. design-spec.md §4 rejected that because it changes `main`'s prune of
ordinary subtrees, and the issue does not ask for that.

### Quality gates not run

These gates apply but were not run in this step. Its rules allow only the
targeted tests, forbid HorizonDB, and give no model access.

| Gate | Why it applies |
|---|---|
| `--all-providers` matrix with PostgreSQL 16 and live HorizonDB | The change adds SQL: recursive CTEs, `FOR SHARE NOWAIT`, `FOR NO KEY UPDATE NOWAIT` on the sessions left under a prune target, `FOR SHARE OF s SKIP LOCKED`, and a `DELETE` with CTEs. It ran only on a local PostgreSQL 16. |
| Positive and negative live-model checks of the Sweeper's instructions | `sweeper.agent.md` and the Sweeper skill now describe the `WorkflowKept` refusal. |

## What changed and why

The Sweeper deleted a finished Workflow session like a completed sub-agent:
one scan, about 5 minutes after the run ended. So the graph, step visits, Log
and variables were lost while the session that started the Workflow was still
in use. The Sweeper now keeps such a session.

**The rule.** The Sweeper never deletes a *kept session*. A kept session is one
of these, when the Workflow has an active ancestor:

- a finished Workflow session that is not a test bench;
- a session under such a Workflow, for example its agent-node sessions and its
  child Workflows.

An active ancestor is a session above the Workflow that exists, is not deleted,
and is not completed, cancelled or failed. An idle session is active.

When the Workflow and every session above it have ended, the Sweeper cleans
them together through the existing cascade. Explicit deletes, test benches,
drafts and active runs keep their current rules. The change adds no migration
and no orchestration or controller version.

| Area | Change | Files |
|---|---|---|
| Finding kept sessions | New `WorkflowStore` queries find the kept sessions in a delete set and the active ancestors above them. | `packages/sdk/src/workflow/store.ts` |
| Scan, `cleanup_session`, `prune_orchestrations` | The scan does not list a session whose cleanup would delete a kept session. `cleanup_session` refuses it with the new status `WorkflowKept`, which names the Workflow, its active ancestor and that ancestor's state. The prune skips it. | `packages/sdk/src/sweeper-tools.ts` |
| Final check (`sweeperSoftDelete`) | Checks again under its locks. When a Workflow that is not a test bench is the target, is in the delete set, or is above the target, the check also holds every session above the target `FOR SHARE NOWAIT`. A held session gives `Busy`. This serializes the check with a root's restart and with a run's end above the target (round 1). | `packages/sdk/src/workflow/store.ts` |
| Prune without cascade | Locks the sessions that the delete leaves under its target together with the delete set (NOWAIT) and reads both again. A changed set gives `Changed`. If a Workflow that is not a test bench is among the sessions left in place, the check refuses with the new status `WorkflowBelow`. The prune asks first and skips such a row (round 2). | `packages/sdk/src/workflow/store.ts`, `packages/sdk/src/sweeper-tools.ts` |
| Event purge (`purge_old_events`) | `WorkflowStore.purgeSessionEventsBefore` keeps the events older than 24 hours of a finished Workflow session and of the sessions under it, because those events are its Log. It runs as one transaction: first the bulk delete outside Workflow trees, with no lock, then the Workflow trees with the unfinished Workflows held `FOR SHARE SKIP LOCKED`. A failure deletes nothing. Other old events are purged as before. | `packages/sdk/src/workflow/store.ts`, `packages/sdk/src/resourcemgr-tools.ts` |
| Sweeper instructions | Describe the `WorkflowKept` refusal. | `packages/sdk/plugins/mgmt/agents/sweeper.agent.md`, `packages/sdk/plugins/mgmt/skills/sweeper/SKILL.md` |
| Documents | Retention of finished Workflows, the event purge and the prune. | `docs/developer/building/workflow-sessions.md`, `docs/user-guide/workflows.md`, `docs/proposals/workflows/data-model.md`, `CHANGELOG.md` |
| Formal models | `WorkflowRetention.tla` (the final check and the event purge, against a root restart and a run end) and `WorkflowPrune.tla` (the prune, against a Workflow created under the ordinary child and a run end), with the case generator, runner, packet check and hashes. | `docs/formal/workflow/retention/`, `docs/formal/README.md` |
| Specifications | The four documents for this issue. | `docs/botdocs/issue-412/` |

## Deviations from the specifications

- The specifications were updated in every round, so the code matches their
  final text. Compared with the first version (commit `027f1d12`), the
  following parts were added after a review:
  - the locks above the target: design-spec.md §3.5, impl-spec.md step 6;
  - the event purge: design-spec.md §3.6, impl-spec.md steps 7, 8 and 12;
  - the prune rule `WorkflowBelow`: design-spec.md §3.7, impl-spec.md steps 10
    and 11;
  - the formal models: impl-spec.md steps 9 and 13.
- design-spec.md §3.7 excludes a Workflow that is created after a prune commits.
  Review round 3 rejects that exclusion (see Open items).
- Publish step: `origin/main` is still `b79be29d` (GitHub `main` and the repo
  cache agree), which is also the merge base. `git merge --no-edit upstream/main`
  reported `Already up to date.`, so the published branch has no merge commit.

## Tests run

Every run was on the dev builder pod, in the task worktree. Each run used a
disposable local PostgreSQL 16 on port 55412, with `PG*` and `AZURE_*` unset and
a placeholder `GITHUB_TOKEN`. test-spec.md has the exact environment.

| Visit (head) | Command | Result |
|---|---|---|
| Build (base `b79be29d`) | `vitest run` of the four existing Sweeper files (`sweeper-cleanup-guard`, `workflow-sweeper-recover`, `sweeper-final-check`, `sweeper-queued-start`) | 34 passed, 0 failed (baseline on `main`) |
| Build (`2c341256`, tests only) | `vitest run sweeper-cleanup-guard workflow-sweeper-recover -t "issue 412"` | 5 failed as expected, 15 skipped (red) |
| Build (`17142cd0`) | Same filter | 5 passed, 0 failed |
| Build (`17142cd0`) | `vitest run` of the five targeted local files (the four above and `facts`) | 50 passed, 0 failed |
| Build (`17142cd0`) | `npm run build && npm run test:unit` | 3,127 tests: 3,126 passed, 0 failed, 1 skipped |
| Build (`17142cd0`) | `node scripts/check-repository-privacy.mjs` | 3,412 files, 0 findings |
| Fix round 1 (`cc6d623d` on `17142cd0`) | The new round-2 tests | Each failed for the expected reason, except the guard for an ordinary cleanup, which passes on both heads by design |
| Fix round 1 (`7824eafc`) | `vitest run ... -t "issue 412"` | 15 passed, 0 failed |
| Fix round 1 (`7824eafc`) | `vitest run` of the seven targeted local files (adds `workflow-kept-terminated`, `resourcemgr-tools`) | 61 passed, 0 failed |
| Fix round 1 (`7824eafc`) | `npm run test:unit` | 3,127 tests: 3,126 passed, 0 failed, 1 skipped |
| Fix round 1 (`7824eafc`) | `check-repository-privacy.mjs` | 3,425 files, 0 findings |
| Fix round 1 (`7824eafc`) | `check-packet.sh && run-tlc.sh` (batch ret1) | 18 of 18 cases as expected |
| Fix round 2 (`5debc0d0` on `7824eafc`) | `vitest run sweeper-final-check -t "issue 412"` | The 7 new tests failed for the expected reason (red) |
| Fix round 2 (`95049a8d`) | `vitest run ... -t "issue 412"` | 16 passed, 0 failed |
| Fix round 2 (`95049a8d`) | `vitest run` of the seven targeted local files | 68 passed, 0 failed |
| Fix round 2 (`95049a8d`) | `npm run build && npm run test:unit` | 3,127 tests: 3,126 passed, 0 failed, 1 skipped |
| Fix round 2 (`95049a8d`) | `check-packet.sh && run-tlc.sh` (batch ret2, TLC 2.19, OpenJDK 21.0.13) | 31 of 31 as expected: 12 pass, 7 deliberate faults violate their named invariant, 12 witnesses reached |
| Fix round 2 (`95049a8d`) | `check-repository-privacy.mjs` | 3,426 files, 0 findings |
| Publish (`95049a8d`, after the no-op merge) | `npm run build`, then `vitest run` of the seven targeted local files | Build OK; 7 files, 68 passed, 0 failed |
| Publish (`95049a8d`) | `npm run test:unit` | 3,127 tests: 3,126 passed, 0 failed, 1 skipped |
| Publish (`95049a8d`) | `check-repository-privacy.mjs` | 3,426 files, 0 findings |
| Publish (with this report staged) | `npm run test:unit` and `check-repository-privacy.mjs` | 3,127 tests: 3,126 passed, 0 failed, 1 skipped; 3,427 files, 0 findings |

Not run, as the step rules require: the full local suite, the `--all-providers`
matrix, HorizonDB, integration suites, browser suites and live-model checks.

## Review rounds

| Round | Reviewed head | Verdict | Findings | What was done |
|---|---|---|---|---|
| 1 | `17142cd0` | Changes required | 1. The final check read the sessions above its target without a lock. So an ended root could restart, or a Workflow above could end its run, between the check and the commit. 2. `purge_old_events` deleted a kept Workflow's Log after 24 hours. 3. The tests checked proxies (the raw catalog list, "any `workflow.` event") instead of the production list, tree and Log. 4. The required gates had no evidence, including a formal model for the new locks. | All fixed in `7824eafc`, with failing tests first in `cc6d623d`. 1: share locks on the sessions above the target when a Workflow is in or above the delete set. 2: the purge keeps finished Workflow trees. 3: new `workflow-kept-terminated.test.js` (production `listSessions` and `buildSessionTree`, the agent session's Log) and the step's own Log event. 4: TLA+ batch ret1; the gates that were not run are marked Not run. |
| 2 | `7824eafc` | Changes required | 1 (blocker). A prune of a pending root hid an existing kept Workflow under the root's ordinary child. 2 (important). The two passes of the purge were separate transactions, so a failure in pass 2 left pass 1 committed. 3 (important). The formal evidence was not pinned, and the prune was not modelled. | All fixed in `95049a8d`, with failing tests first in `5debc0d0`. 1: `WorkflowBelow`, with the sessions left in place locked and read again. 2: one transaction. 3: `WorkflowPrune.tla` (batch ret2) and the raw TLC output kept with the review. |
| 3 | `95049a8d` | Changes required | 1 (blocker). A Workflow started after a prune is kept but not shown. | **Open.** See Open items. Three review rounds ended, so the Workflow published the change. |

## Existing tests changed

Each change replaces an assertion of the behavior that the issue replaces: a
finished Workflow cleaned while its owner is active, or an owner treated as
ended when only its orchestration ended. The issue defines an ended session by
its state.

| File, test | Change | Why |
|---|---|---|
| `sweeper-cleanup-guard.test.js`, `finished live Workflows are swept while their full owner outcome and test-bench policy remain` | The running owner's two finished live Workflows are now asserted kept: not listed, refused with `WorkflowKept` by `cleanup_session`, and skipped by the prune. The title now says they are kept. The test-bench, active, draft and mixed assertions are unchanged. | The issue: never clean a finished Workflow while an ancestor is active. |
| `sweeper-cleanup-guard.test.js`, `all runs ended: live Workflows are cleaned; test benches follow controller status and retention` | The running owner's finished live Workflow is now asserted kept: not listed, refused with `WorkflowKept`, and its controller not deleted. The title now says so. The test-bench assertions are unchanged. | Same. |
| `sweeper-cleanup-guard.test.js`, `a finished owner session's cleanup removes its Workflow sessions with it` | The owner's state is set to `completed` before its Workflows are created. The assertions are unchanged. | On `main`, the fixture's owner ended only in its orchestration status. Its state stayed `pending`, which the issue counts as active. |
| `workflow-sweeper-recover.test.js`, `every Sweeper pass preserves active Workflow recovery, cleans finished live Workflows, and lets ancestor deletion remove retained test benches` | The running owner's completed Workflow is now asserted kept: `WorkflowKept`, not deleted, and its owner outcome saved. When the owner's stand-in orchestration ends, its state is set to `completed`, as a session's end sets it. The owner's cleanup then also removes the completed Workflow. The title now says so. | Both reasons above. |

No other existing test was changed.

## Follow-ups

1. Fix the open round-3 blocker: Start refuses under a deleted ancestor (see
   Open items), with its regression test and the extended `WorkflowPrune.tla`
   invariant.
2. Run the `--all-providers` matrix with live HorizonDB on this branch.
3. Run positive and negative live-model checks of the Sweeper's edited
   instructions (the `WorkflowKept` refusal).
4. Separate from Workflows, and older than this change: on `main` the prune
   leaves live ordinary sessions under a deleted root, and the portal then
   hides them. Decide whether the prune should refuse that case, or whether the
   tree should show such sessions.
5. A session whose orchestration ended but whose state was never set to an
   ended state counts as active, so its finished Workflows are kept until a
   person deletes it or them (design-spec.md §6).
6. Storage grows with a long-lived owner's finished Workflows and their agent
   sessions. The issue asks for no cap. If one is needed later, it is a
   separate change.
