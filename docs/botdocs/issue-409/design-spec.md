# Issue 409: deleting a Workflow definition that has no active runs

Issue: [microsoft/PilotSwarm#409](https://github.com/microsoft/PilotSwarm/issues/409)

## Terms

- **Definition**: a session's saved Workflow Definition (table
  `session_workflow_definitions`), with numbered **revisions**
  (`session_workflow_revisions`).
- **Start**: making a new Workflow from one revision of a definition
  (`startSessionWorkflowDefinition`). It runs as two database transactions:
  1. the **claim**: it inserts the new Workflow's session row (kind `workflow`,
     a child of the owner session) and reserves one of the owner's 50 child
     slots;
  2. the **admission**: it stores the Workflow's own copy of the revision and
     its first run, after it checks under row locks that the definition is
     not deleted.
- **Active run**: a live run whose status is `admitted`, `running` or
  `paused`.
- **Delete**: a person's deletion of a definition
  (`deleteSessionWorkflowDefinition`). It is a soft delete: it sets
  `deleted_at` and keeps the row.
- **Orphan claim**: a claimed Workflow session that has no definition copy and
  no run, and that no retry can ever admit.

## What the issue asks, and what main already does

| Ask | Main today | Evidence |
|---|---|---|
| Delete a definition with no active run | Done | `session-definition-store.ts:755-789` |
| Refuse a delete while a run is active | Done: `DEFINITION_IN_USE` names the running Workflows | `session-definition-store.ts:767-777` |
| A run cannot start on a definition being deleted | Done for the run (row locks, see below). Not done for the Start's claim (see "The gap") | `session-definition-store.ts:761`, `:840-844`; `store.ts:2645` |
| Keep run history and revisions | Done: soft delete; revisions, Workflows and runs stay | `session-definition-store.ts:778-780`; `docs/developer/building/workflow-sessions.md:437-439` |

How the run admission and the delete are serialized (both transactions use
`READ COMMITTED`, `store.ts:2254`, `session-definition-store.ts:264`):

- Delete locks the definition row `FOR UPDATE` (`session-definition-store.ts:761`),
  then counts active runs (`:767-771`), then sets `deleted_at` (`:779`).
- Admission locks the same row `FOR SHARE` and refuses a deleted one with
  `DEFINITION_DELETED` (`session-definition-store.ts:840-844`, called from
  `store.ts:2645`) before it writes anything.

Example A (Start first): the admission holds `FOR SHARE`; the delete waits;
the admission commits its run; the delete wakes, counts one active run and is
refused `DEFINITION_IN_USE`. (If that run has already ended when the delete
counts, the delete succeeds, and the finished Workflow keeps its copy and its
history.)

Example B (Delete first): the delete holds `FOR UPDATE`; the admission waits;
the delete commits; the admission reads `deleted_at` and is refused
`DEFINITION_DELETED`. No run is made.

Both orders were forced on main with a lock hook, and a 40-round random race
ran; Start and Delete never both succeeded.

## The gap

In example B the Start's **claim** committed before the admission was refused
(`service.ts:1019`, then `store.ts:2645`). Nothing removes it. The refusal is
permanent (a deleted definition stays deleted), so the claim is an orphan:

- it keeps one of the owner's 50 child slots for as long as the owner session
  lives, because the budget counts "a Workflow a Start claimed and has not
  admitted yet" (`child-budget.ts:11-12`, `:33-35`);
- it stays a live child session of kind `workflow` with no definition and no
  run.

Measured on main: in 40 of 40 random races that the delete won, the losing
Start left one orphan claim.

A second path makes the same orphan: a Start is interrupted after its claim
(for example by a worker restart), and then the definition is deleted. The
claim holds its slot even if the Start is never retried. A retry is refused
`DEFINITION_DELETED`, and the claim still holds its slot.

Example: a session has 49 running children and one orphan claim. Its next
`spawn_agent` or Start is refused `CHILD_LIMIT` ("This session already has 50
running sub-agents and Workflows (max 50)"), although only 49 run.

## Design

The orphan does harm in one place only: the child budget count. So the fix is
in that count. A claim whose pinned definition is deleted is not counted
(`child-budget.ts`, `childBudgetCountSql`):

```sql
OR (c.creation_config -> 'workflow' ? 'sessionPin'
    AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.workflow_session_id = c.session_id)
    AND NOT EXISTS (SELECT 1 FROM session_workflow_definitions sd                       -- new
                     WHERE sd.definition_id = c.creation_config -> 'workflow' -> 'sessionPin' ->> 'definitionId'
                       AND sd.deleted_at IS NOT NULL))
```

Why this is correct:

- A deletion is permanent: no API clears `deleted_at`. The admission refuses a
  deleted definition (`session-definition-store.ts:844`). So such a claim can
  never become a running Workflow. Its slot reserves nothing.
- The count runs under the parent session's row lock `FOR NO KEY UPDATE`
  (`session-definition-store.ts:497`; the catalog's lock for `spawn_agent`). For
  a Start by the owner session, the parent is the owner, and a delete takes the
  owner's row `FOR SHARE` (`session-definition-store.ts:760`). The two conflict,
  so the count sees the delete either fully or not at all. For a claim made by
  a Workflow's spawn state, the parent is that Workflow; a count that runs at
  the same moment as the delete may still count the claim once, which is what
  main does today. It is never too low.
- A claim of a live definition is still counted, so an interrupted Start keeps
  its reservation, as before.
- The same function is the count for `spawn_agent` and for a Start, so both see
  the same number.

One retry rule keeps answers as they were. Once a claim is not counted,
another child can take its slot. Example: 49 children and one interrupted
claim; the definition is deleted; a new sub-agent takes the freed slot, so 50
other children run. A retry of the interrupted Start checks the budget first
(`replaySessionStart`, `session-definitions.ts:427`) and would be refused
`CHILD_LIMIT` ("wait for some to end"), although its definition can never run.
On main this state cannot happen, because the claim kept its slot, and the
retry was refused `DEFINITION_DELETED`. So in `replaySessionStart`, a
`CHILD_LIMIT` for a resumed claim whose pinned definition is deleted (read
again at that moment) is not returned; the flow goes on to `createWorkflow`,
whose existing checks answer as before: another request under the same key is
refused as a conflict, and the admission refuses `DEFINITION_DELETED`. Nothing
is written on that path: the claim exists already and the admission refuses
before it writes.

Nothing else changes: no session row is changed or deleted, no error code or
message changes, no lock or transaction changes, no migration.

The claim row itself stays, as it does on main for any interrupted Start. It is
not listed as a Workflow: the Workflow lists join a definition copy or a run
(`session-definition-store.ts:409-418`, `store.ts` `listChildWorkflows`).

## Rejected alternatives

- **Soft-delete the claim when the admission is refused `DEFINITION_DELETED`,
  and answer a retry before it reaches the claim.** This was the first
  implementation. An independent review found that it is unsafe: two attempts
  of the same Start can overlap. Attempt B admits the run, the run ends, the
  definition is deleted, and then attempt A is refused and soft-deletes B's
  finished Workflow and its history. It also changed refusal codes for some
  retries (`SESSION_EXISTS` instead of `DEFINITION_DELETED`, and
  `DEFINITION_DELETED` instead of `OPERATION_CONFLICT` for a keyed retry with
  other arguments). It also left the orphan when the Start was never retried.
- **Make the delete remove pending claims of its definition**, with a check of
  the definition under its lock when the claim is made. It needs a new query
  over `creation_config` JSON in the delete, a new lock order between the delete
  and the claim, and it still meets the overlapping-attempt cases above.
- **Check the definition inside the claim transaction** only (as test benches
  do with `requireBenchLiveLocked`). It narrows the window but does not close
  it: a delete can commit between the claim and the admission.
- **Count pending claims as "in use" in the delete.** A Start that crashed after
  its claim would then block the delete for ever.

## Compatibility and risks

- Compatible fix: the count can only go down, and only for claims that can never
  run. Every success path and refusal is unchanged, and a retry is answered as
  on main.
- Cost: one extra `NOT EXISTS` lookup on `session_workflow_definitions`, whose
  key is `definition_id`. The planner reaches it only for a child row that is a
  Workflow with a session pin and no run (an unadmitted claim); such rows are
  rare. The existing plan test (`workflow-migration-0088.test.js`) still checks
  that the count uses the sessions parent index.
- The orphan claim row is still in the catalog. It holds no slot and is not a
  listed Workflow. Removing it safely is a follow-up.
- No formal model change: the existing Workflow models do not model creation
  (`docs/formal/workflow/README.md:381`), and this fix changes no lock,
  transaction or state transition.
