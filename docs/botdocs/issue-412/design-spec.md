# Issue 412: keep finished Workflow sessions while an ancestor is active

Issue: [microsoft/PilotSwarm#412](https://github.com/microsoft/PilotSwarm/issues/412).
Base: `main` at `b79be29d1` (PilotSwarm 0.8.19 prepared). Line numbers below are
for that commit.

## 1. Terms

| Term | Meaning |
|---|---|
| Workflow session | The child session that one Start creates (`session_kind = 'workflow'`). It holds the run: its graph, every step visit with its input and output, the Log, the variables and the messages. |
| Owning session | The session that started the Workflow (its parent). |
| Ancestors | The owning session, its parent, and so on up to the root. |
| Ended session | A session whose state is `completed`, `cancelled` or `failed` (`SWEEPER_ENDED_SESSION_STATES`, `workflow/store.ts:76`). |
| Active session | A session row that exists, is not deleted and has not ended. An idle session is active. So are `pending` (no first message yet), `running`, `waiting` and `error`. |
| Finished Workflow session | A Workflow session that is not deleted, is not a definition test bench (`service_kind = 'workflow-test'`), has at least one live run, and has no run that is `admitted`, `running` or `paused`. |
| Kept session | A session S for which a finished Workflow session W exists that is S itself or an ancestor of S, and that has an active ancestor. This covers the Workflow session itself and every session under it: its agent node sessions, the sessions they started, and its child Workflows. |
| Sweeper | The system agent that cleans up sessions. Its tools are `scan_completed_sessions`, `cleanup_session` and `prune_orchestrations` (`sweeper-tools.ts`). |
| Final check | The transaction in which the Sweeper checks a target again under the target's row lock and then soft-deletes it (`WorkflowStore.sweeperSoftDelete`, `workflow/store.ts:3790-3871`). |
| Terminated row | The session list groups the ended children of a session in one row, labelled `Terminated` (`packages/app/ui/core/src/terminated-group.js:8, 25`). |
| Event purge | The Resource Manager's tool `purge_old_events`: it deletes session events older than a cutoff, 24 hours by default (`resourcemgr-tools.ts:526-565`). Its agent instructions run it every third monitoring pass (`resourcemgr.agent.md:101-104`). |
| Workflow tree | A Workflow session that is not a definition test bench, and every session under it. |

## 2. The problem on main

### 2.1 How a finished Workflow is lost

1. When a run ends, the controller sets the Workflow session's state to the run's
   status, for example `completed` (`workflow/runtime.ts:2742`). Its agent node
   sessions are ended with the run (`workflow/runtime.ts:1272-1290`,
   `endWorkflowRunAgentSessions`).
2. `scan_completed_sessions` lists every non-system session whose own
   orchestration is terminal and that was last updated more than 5 minutes ago
   (`sweeper-tools.ts:298-335`). For a Workflow session the store decides first:
   an active run keeps it, a draft with no live run keeps it, a test bench keeps
   it. A finished live Workflow is read by its controller (`session-<id>`), which
   is `Completed`, so it is listed (`sweeper-tools.ts:90-105, 227-236`). Its
   agent sessions are listed too: they are ordinary ended children.
3. `cleanup_session` deletes the target and all its descendants in the final
   check (`sweeper-tools.ts:385`, `workflow/store.ts:3819-3865`).
4. `prune_orchestrations` deletes terminal orchestration instances older than 5
   minutes (`sweeper-tools.ts:553-557`), including the Workflow controller. Then
   it soft-deletes each session row whose orchestration reads `NotFound`
   (`sweeper-tools.ts:565-600`). So a finished Workflow that the scan missed is
   removed by the next prune. Deleting an owner this way also deletes its
   Workflow children through the owner trigger
   (`migrations/workflow-outcome-retention-0096.ts:150-165`).
5. After the delete, `read_workflow` finds no session and falls back to the
   owner's retained terminal result (`workflow/tools.ts:1857-1867`). That model
   has `graph: null` and empty `nodeExecutions`, `inbox`, `outbox` and `kv`
   (`workflow/tools.ts:308-339`).
6. An agent node's Log reads the agent session's history
   (`packages/app/ui/react/src/workflow-tab.js:1405-1414`). Once the agent session
   is deleted, the Log has none of the agent's lines.
7. Even a session that is not deleted loses its Log: the event purge deletes
   every event older than its cutoff, whatever its session
   (`resourcemgr-tools.ts:551`). The Workflow Log reads the Workflow session's
   events and its agent sessions' histories
   (`packages/app/ui/react/src/workflow-tab.js:1392-1414`). Keeping the sessions
   alone (steps 2 to 4) would still leave a day-old Workflow with an empty Log
   (review round 1, finding 2).

### 2.2 Example

The owner session `O` is idle. It started Workflow `W` (`check-items #3`). `W`
ran the agent state `verify`, whose agent session is `A`, and ended at 23:32
with outcome `blocked` at its state `unverified`.

| Time | What happens on main |
|---|---|
| 23:32 | `W` ends: `W.state = completed`, `A.state = completed`. |
| 23:40 | The Sweeper scans: `W` and `A` are listed. It cleans both. |
| 08:00 next day | The owner opens `W`: the session is gone. `read_workflow` gives only the output text. The input and output of `verify`, and the agent's reasoning, cannot be read. |

## 3. Design

### 3.1 The rule

**The Sweeper never deletes a kept session.** This holds for every Sweeper path
that deletes:

| Path | What it would delete | Change |
|---|---|---|
| `scan_completed_sessions` | (lists candidates) | It does not list a candidate whose cleanup would delete a kept session. |
| `cleanup_session` | The target and all its descendants | It refuses, with status `WorkflowKept` and a reason, when one of them is kept. |
| `prune_orchestrations`, session pass | The target and the Workflow sessions the owner trigger deletes with it | It skips the target when one of them is kept, or when a Workflow lies under the target and the delete would leave it in place (§3.7). |
| Final check (`sweeperSoftDelete`) | Exactly the sessions it has locked, and the target | It refuses with `WorkflowKept` when one of them is kept. It checks after it takes the locks, so a change after the tool's first check cannot slip through. When a Workflow is among those sessions or above the target, it first holds every session above the target `FOR SHARE` (§3.5). Without cascade, it also refuses with `WorkflowBelow` when a Workflow lies under the target and the delete would leave it in place (§3.7). |

The event purge keeps the Log of a finished Workflow (§3.6).

Nothing else changes:

- An explicit delete (of the Workflow, or of any ancestor) deletes at once, as
  before (`client.ts:670-676`, migration 0096 triggers).
- A Workflow with an active run, a draft with no run, and a test bench keep
  their current rules. A test bench is not a finished Workflow session in this
  sense, so it neither is kept nor keeps other sessions.
- The owner's retained terminal result (migration 0096) is unchanged.
- The child budget already ignores finished Workflows (`child-budget.ts:1-35`),
  so a kept Workflow blocks no new sub-agent or Start.
- `prune_orchestrations` still deletes the ended controller instance of a kept
  Workflow. The run's record is in the store tables, and `read_workflow` reads
  the controller only for an active run (`workflow/tools.ts:1877-1882`).

### 3.2 How a kept session is found

A new `WorkflowStore` method gives the first kept session among the sessions a
Sweeper delete would remove:

```ts
sweeperKeptSession(input: { sessionId: string; cascade: boolean }): Promise<SweeperKeptSession | null>

interface SweeperKeptSession {
    sessionId: string;          // the kept session the delete would remove
    workflowSessionId: string;  // the finished Workflow that keeps it (itself or an ancestor)
    ancestorSessionId: string;  // an active session above that Workflow
    ancestorState: string;      // that session's state, e.g. "idle"
}
```

The set is the one the final check uses: with `cascade`, the session and all its
descendants (`cleanup_session`); without, the session and the Workflow sessions
the owner trigger deletes with it (`prune_orchestrations`). One SQL statement
walks up from each session of the set to the root (a recursive CTE over
`parent_session_id`). A session is kept when a finished Workflow session is on
its path (itself included), and an active session is above that Workflow on the
same path. The nearest such Workflow and the nearest active session above it are
reported.

The final check runs the same statement on exactly the sessions it is about to
soft-delete (the target and the descendants it locked).

### 3.3 Worked examples

`P` is the owner's parent, `O` the owner, `W` a finished Workflow of `O`, `A` an
agent session of `W`, `B` a definition test bench of `O`.

| Case | States | Sweeper target | Result |
|---|---|---|---|
| 1. Owner idle | `O` idle, `W` completed, `A` completed | `W` | Refused `WorkflowKept`: `W` is a finished Workflow and `O` is active. Not listed by the scan. |
| 2. Agent session of a kept Workflow | as 1 | `A` | Refused: `W` is above `A` and `O` is above `W`. |
| 3. Owner ended, its parent active | `P` idle, `O` completed, `W` completed | `O` | Refused: `W` is in `O`'s subtree and `P` is active. `O` and `W` stay. |
| 4. Everything ended | `P` completed (root), `O` completed, `W` completed, `A` completed | `P` | Cleaned with `O`, `W`, `A` (no active session above `W`). |
| 5. Owner never started | `O` pending (no first message), `W` completed | `O` (reads `NotFound`) | Refused: `O` is active. |
| 6. Only a test bench | `O` completed root, `B` ended test | `O` | Cleaned with `B`, as before. |
| 7. Active run under an ended owner | `O` completed root, `W2` running | `O` | Cleaned; the run is cancelled with the delete, as before. |
| 8. Explicit delete | `O` idle | (person deletes `O` or `W`) | Deleted at once, as before. |
| 9. Prune above an ordinary owner | `R` pending root (reads `NotFound`), `O` idle child of `R`, `W` completed | `R` (prune) | Skipped; the final check would refuse `WorkflowBelow` (§3.7). `R`, `O` and `W` stay listed. |
| 10. Prune with only ordinary sessions under it | `R` pending root, `O` idle child of `R` | `R` (prune) | Deleted, `O` left in place, as before. |

Trace of case 3 through `cleanup_session(O)`:

1. The tool reads `O`'s row version and status: `session-O` is `Completed`, the
   row is older than the grace. Eligible so far.
2. `sweeperKeptSession({ sessionId: O, cascade: true })`: the set is `O`, `W`.
   From `W`: `W` is finished at depth 0; `O` (completed) is at depth 1, `P` (idle)
   at depth 2. `P` is active and above `W`, so it answers
   `{ sessionId: W, workflowSessionId: W, ancestorSessionId: P, ancestorState: "idle" }`.
3. The tool returns `{ ok: false, refused: true, status: "WorkflowKept", error: "Refusing to clean session O: its cleanup would delete the finished Workflow W, which is kept while its ancestor P is active (state idle). ..." }`.
4. Nothing is deleted. When `P` ends, a later scan lists `P`, `O` and `W` and
   cleans them (case 4).

### 3.4 What the owner sees

Nothing in the UI changes. The kept Workflow session has the state its run
ended with (`completed`, `failed` or `cancelled`), so the session list shows it
in its owner's `Terminated` row (`terminated-group.js:8, 25`). Its run has ended,
so it runs no step; a run command on an ended run is recorded with that end and
changes nothing, as just after the end
(`docs/developer/building/workflow-sessions.md:1240-1241`). `read_workflow`, the graph, the timeline, the Log, the Node panel and
**Run again…** read the store, the agent sessions and their events, which are
now kept (§3.6).

### 3.5 Concurrency of the final check

The final check runs under the target's row lock and NOWAIT locks on every
session it deletes, and it re-reads the set under those locks
(`workflow/store.ts`, `sweeperSoftDelete`). Sessions in the set cannot change
state, gain a run or finish a run while the Sweeper holds their locks:
admissions and run ends take the session row lock first.

Whether a session in the set is kept also depends on sessions **above** the
target, which the set does not contain. Two changes there can make a session
kept while a cleanup runs:

- **A root restarts.** A root that ended and whose orchestration was pruned
  accepts a new first message: the client starts a new orchestration and sets
  the row `running` (`client.ts:1015-1078`, `_ensureOrchestrationAndSend`).
- **A Workflow above the target ends its run** (the target is, for example, an
  agent session of that Workflow). The run's writer holds the Workflow's row
  first (`lockLiveSession`, `FOR NO KEY UPDATE`).

Round 1 read those sessions without a lock. Review round 1 (finding 1) showed
the effect: the cleanup's check reads the root as ended; the root restarts and
commits; the owner reads the full Workflow; then the delete commits. No serial
order gives that sequence, and the restarted root saw the Workflow disappear.

The fix: before the kept check, when a Workflow that is not a test bench is the
target, is in the set, or is above the target, the final check holds **every
session above the target `FOR SHARE`, NOWAIT**. Each change above takes that
row's lock: a state update takes `FOR NO KEY UPDATE`, and a run end holds its
Workflow's row the same way. `FOR SHARE` conflicts with both. So each change
either committed before the lock (the check reads it and keeps the session) or
waits until the delete has committed (it then finds the session deleted, as if
the cleanup came first). A row that another transaction holds now refuses the
cleanup at once (`Busy`); a later scan tries again. The Sweeper never waits
while it holds a lock, as before, so no lock cycle can form.

A cleanup with no Workflow in or above it cannot delete a kept session, and no
change above it can make one kept: such a cleanup takes no new lock and behaves
as on `main`. Whether a session is a Workflow (and not a test bench) never
changes, so this test needs no lock.

The model `docs/formal/workflow/retention/WorkflowRetention.tla` checks this
with TLC: the round-1 check without the share locks reaches a delete of a kept
session (the counterexample is the sequence above); the fix does not (§7).

### 3.6 The event purge keeps a finished Workflow's Log

The event purge (`purge_old_events`) now calls
`WorkflowStore.purgeSessionEventsBefore(cutoff)`. It keeps the events of a
**finished Workflow session and of every session under it**, and deletes every
other old event as before. A finished Workflow session here is one the
Sweeper's rule can keep (not deleted, not a test bench, a live run and no
active run), whatever the states of the sessions above it. Its events go when
the session is deleted: by a person, or by the Sweeper once no session above it
is active.

It does not use the exact kept rule: that rule depends on the states above the
Workflow, and a root can restart (§3.5) after a purge has deleted the Log of a
Workflow it is about to keep again. The wider set depends only on the Workflow
itself, so the purge needs no lock on any session above it.

The purge is one transaction with two phases, so a failed statement rolls the
whole purge back and a failure deletes nothing, as the single `DELETE` on
`main` did (review round 2, finding 2):

1. One statement deletes the old events of every session that is **not in a
   Workflow tree**. Whether a session is in a Workflow tree never changes while
   it exists, so this phase takes no lock. It is the bulk of the events.
2. Then the Workflow trees. The transaction first holds `FOR SHARE`,
   `SKIP LOCKED`, every Workflow session (not a test bench) that has not
   finished: a draft, or one with an active run. Then it deletes the old events
   of the Workflow trees, except those of a Workflow that has finished or that
   it does not hold, and of every session under such a Workflow.

Phase 1 runs first, so the share locks of phase 2 are held only for phase 2's
two statements and the commit, not during the bulk delete.

A run can end while the purge runs. Every writer of a Workflow's runs holds the
Workflow's row first (`FOR NO KEY UPDATE`). So a Workflow that the purge holds
cannot end its run until the purge commits: its old events go as on `main` for
a running Workflow, and its run ends afterwards. A Workflow that a writer holds
now is skipped and keeps its events in this pass. The selection may read a run
end that committed just before the lock as not ended yet; the delete reads
again in a new statement under the lock and keeps that Workflow's Log. The
purge never waits for a lock.

Example. Owner `O` idle; finished Workflow `W` with agent session `A`; running
Workflow `W2` with agent session `A2`; ordinary session `X`. Every session has
one event two days old. After the purge, `W` and `A` keep theirs; `O`, `X`,
`W2` and `A2` lose theirs, as on `main`. After a person deletes `W`, the next
purge deletes the old events of `W` and `A`.

### 3.7 A prune never leaves a Workflow under a deleted session

The prune (`prune_orchestrations`, step 3) soft-deletes a session row whose
orchestration reads `NotFound` **without cascade**: it deletes the session and
the Workflow sessions that the owner trigger deletes with it (its Workflow
children, and theirs), and leaves every other session under it in place. That
is `main`'s behavior. The session list and the portal reach a session only
through its parent: the tree builder skips a child whose parent is not listed
(`packages/app/ui/core/src/session-tree.js:274-304`).

Review round 2 (finding 1) showed what that means for a kept Workflow.
Example: root `R` is pending (it never accepted a message, so it reads
`NotFound`), its ordinary child `O` is idle, and `O` started the Workflow `W`,
which has finished. `W` is kept: `O` (and `R`) are active. Round 2's final
check looked only at `R` and its Workflow children, so the prune deleted `R`.
`O` and `W` stayed stored, but no longer appeared in the session list or the
portal, so the owner could not open `W` under `Terminated`.

The rule: **a delete without cascade refuses while a Workflow session that is
not a test bench lies under its target and the delete would leave it in
place.** The refusal is `WorkflowBelow`. It does not depend on the Workflow's
run or on any session's state:

- A Workflow whose run has not ended (or a draft) becomes kept when its run
  ends while `O` is active. If the prune deleted `R` first, that Workflow would
  be kept out of reach. Model case `find.ret-prune-kept-only` shows this for a
  rule that refuses only for a Workflow kept now.
- When every session above the Workflow has ended, the cleanup that cascades
  removes the whole subtree once nothing in it is kept (§3.3, case 4). The
  prune does not need to.

How the final check applies it (`sweeperSoftDelete`, without cascade):

1. It reads the delete set (as before) and the sessions under the target that
   the delete leaves in place (`sweeperLeftBelow`: every live descendant that is
   not in the delete set).
2. It locks both, `FOR NO KEY UPDATE NOWAIT`, in one statement (a held one:
   `Busy`), and reads both again (a set that grew: `Changed`). This is the
   existing rule for the delete set (review DR-02) applied to the sessions it
   leaves: creation locks its parent first (`lockLiveParent`: `FOR SHARE`, or
   `FOR NO KEY UPDATE` under the child budget), so no Workflow can be created
   under them before the delete commits.
3. If a locked session it leaves is a Workflow that is not a test bench, it
   refuses (`WorkflowBelow`) and deletes nothing.

The prune also asks before its final check (`sweeperWorkflowLeftBelow`) and
skips such a row without a refusal, as it skips a row with a kept session.

When no session is left under the target (the usual prune), nothing changes.
When only ordinary sessions or test benches are left under it, the target is
deleted as on `main`; the only difference is the NOWAIT lock on them, so one
that another transaction holds at that moment refuses the prune (`Busy`) and a
later prune tries again.

A Workflow that a session under the target creates **after** the prune has
committed is created by a session that the prune already left without its
parent. That is `main`'s prune behavior for the sessions under its target, and
outside this issue. The model names this case (`Wit_CreatedAfter`) and leaves
it out of its invariant.

The model `docs/formal/workflow/retention/WorkflowPrune.tla` checks the rule
with TLC against a Workflow created under `O` and a run that ends during the
prune; round 2's check, a check that refuses only for a Workflow kept now, and
a check without the locks each reach a kept Workflow under a deleted `R` (§7).

## 4. Alternatives considered

| Alternative | Why not |
|---|---|
| Keep only the Workflow session, not the sessions under it | The Log of an agent node reads the agent session (§2.1 step 6). Requirement 2 of the issue asks that the Log and the Node panel work as just after the run ended. |
| Decide "active" by each ancestor's orchestration status | The issue defines active by the session itself (not completed, cancelled or failed). It would add a duroxide read per ancestor, each of which can fail. |
| Treat the cleanup target as ended because its orchestration ended | Case 5: a session that never had a first message reads `NotFound` and would lose its Workflows, although it exists and has not ended. |
| A new session state, column or migration for "kept" | Not needed: the existing state already places the session in the `Terminated` row. A migration adds upgrade cost. |
| Exclude kept sessions from the scan only | `cleanup_session` with explicit ids and `prune_orchestrations` would still delete them. |
| Read the sessions above the target without a lock (round 1) | Not serializable with a root's restart or a run's end above the target (§3.5, review round 1, finding 1). |
| Lock the sessions above the target in every final check | A NOWAIT lock on a busy active parent would refuse ordinary cleanups (for example completed sub-agents of a running parent) that hold no Workflow. Such cleanups cannot delete a kept session, so they take no new lock. |
| Wait for the locks above the target instead of NOWAIT | The Sweeper would wait while it holds the target's lock; a writer that locks parent before child could then form a lock cycle. NOWAIT keeps the existing rule: refuse, and a later scan tries again. |
| Event purge: keep exactly the kept sessions' events | It depends on the states above each Workflow, which change (a root restart), so the purge would need the share locks of §3.5 on every such session in a bulk delete. Keeping every finished Workflow's Log needs no lock above it, and the extra events (a finished Workflow whose ancestors all ended) go when the Sweeper cleans it. |
| Event purge: keep the events of every Workflow, also a running one | Changes the rule for active runs, which the issue keeps, and lets a long polling Workflow's events grow without limit while it runs. |
| Event purge: hold the active Workflows before the bulk delete | Every running Workflow would wait for the whole bulk delete. Phase 1 runs first in the same transaction and holds nothing. |
| Event purge: two transactions, phase 1 committed on its own (round 2) | A failure in phase 2 returned only an error after phase 1 had deleted events (review round 2, finding 2). One transaction rolls both back. |
| Event purge: decide without holding the active Workflows | A run that ends between the delete's decision and its commit loses its Log after it was seen (model case `find.ret-purge-nolock`). |
| Prune: refuse only when a kept Workflow is under the target | A Workflow whose run has not ended becomes kept later, under a deleted target (model case `find.ret-prune-kept-only`). |
| Prune: refuse whenever any session would be left under the target | Changes `main`'s prune of a session with only ordinary sessions under it, which the issue does not ask. |
| Prune: delete with cascade | Would delete active sessions under a root whose orchestration reads `NotFound`. |
| Prune: no lock on the sessions it leaves under the target | A Workflow created under one of them between the check and the commit is left under the deleted target (model case `find.ret-prune-nolock`). |

## 5. Compatibility

- Tool names and parameters are unchanged. `cleanup_session` can return the new
  refusal status `WorkflowKept`; its results already carry a status string per
  target. The scan and the prune skip kept sessions without a new result field.
- No CMS migration, no session orchestration version, no Workflow controller
  version.
- Sessions with no finished Workflow above or below them are cleaned exactly as
  before. A cleanup with no Workflow in or above it takes no new lock.
- A cleanup with a Workflow in or above it can now refuse `Busy` when a session
  above the target is being changed at that moment. `Busy` is an existing
  refusal; a later scan tries again.
- A prune whose target has sessions under it that the delete leaves in place
  locks them NOWAIT, so it can refuse `Busy` when one of them is being changed
  at that moment; a later prune tries again. With only ordinary sessions and
  test benches under it, the target is deleted as before. The prune's result
  counts a `WorkflowBelow` refusal of its final check in `cmsRefused`; a row it
  skips before that check is not counted, as a kept row.
- `purge_old_events` keeps its parameters and result shape (`eventsDeleted`,
  `cutoff`, `olderThanMinutes`). Its description says that a finished
  Workflow's Log is kept. A catalog without a Workflow store (a test double)
  deletes as before.
- Behavior the issue asks to change: a finished Workflow session, and the
  sessions under it, are no longer cleaned while an ancestor is active, an
  ended session that holds such a Workflow is kept too, and the Log of a
  finished Workflow is no longer purged while the session exists.

## 6. Risks and known limits

- Storage grows with a long-lived owner's finished Workflows and their agent
  sessions. The issue asks for no cap; a person can delete a finished Workflow.
- A session whose orchestration ended but whose state was never set to an ended
  state (for example a user abort of the orchestration) counts as active, so the
  finished Workflows under it are kept until it, or they, are deleted. This
  follows the issue's definition of active.
- The scan runs one more query per stale terminal candidate.
- The events of finished Workflows, and of the sessions under them, are no
  longer purged. A finished Workflow whose ancestors have all ended keeps its
  events until the Sweeper cleans it (its next scan, every 6 hours by default).
- Phase 2 of the purge holds the unfinished Workflows for the length of the
  delete of the Workflow trees' old events. A run writer of such a Workflow
  waits that long. Phase 1, the bulk, holds nothing.
- The purge is one transaction again, so the row locks of the deleted events
  are held until the whole purge commits, as with `main`'s single statement.
- A root that never accepts a message, with a Workflow under its ordinary child,
  is never pruned: it reads as active (pending) and is not a cleanup candidate.
  It stays with its subtree until a person deletes it. This follows the issue's
  definition of active, as case 5 does for a Workflow child of such a root.

## 7. Quality gates

| Gate | Applies | Evidence | Status |
|---|---|---|---|
| Database: targeted tests on disposable PostgreSQL 16 | Yes: new queries in `WorkflowStore` (no schema change, no migration) | test-spec.md: every targeted local file passes; every new regression failed before its fix | Run |
| Database: `--all-providers` matrix (PostgreSQL 16 and live HorizonDB) | Yes (new SQL: recursive CTEs, `FOR SHARE NOWAIT`, `FOR SHARE OF s SKIP LOCKED`, a `DELETE` with CTEs) | The task's rules for this step allow only the targeted tests and forbid HorizonDB. PostgreSQL 16 only. | Not run |
| Formal model (locks, concurrent deleters) | Yes: new share locks in the final check and the purge (§3.5, §3.6); the prune's rule and locks (§3.7) | `docs/formal/workflow/retention/` (`WorkflowRetention`, `WorkflowPrune`): batch ret2, 31 of 31 as expected with TLC 2.19 (12 PASS, 7 deliberate faults violated on their named invariant, the round-1 and round-2 behaviors among them, 12 witnesses reached). The raw output of the run (generated settings files, each case's TLC output, the run table) is kept with the review of round 3. | Run |
| Prompts and skills: size budgets | Yes: `sweeper.agent.md`, the Sweeper `SKILL.md`, tool descriptions of the Sweeper and `purge_old_events` | `npm run test:unit` (prompt and skill size budget tests) | Run |
| Prompts and skills: positive and negative live-model checks | Yes: the Sweeper's instructions describe the new `WorkflowKept` refusal | This step has no model access (a placeholder `GITHUB_TOKEN`), and its rules allow no live-model suite. | Not run |
| Portal and UX | No UI code change; the Terminated grouping is checked through the production list and tree builder (`workflow-kept-terminated.test.js`) | — | Not applicable |
