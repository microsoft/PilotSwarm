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
| `prune_orchestrations`, session pass | The target and the Workflow sessions the owner trigger deletes with it | It skips the target when one of them is kept. |
| Final check (`sweeperSoftDelete`) | Exactly the sessions it has locked, and the target | It refuses with `WorkflowKept` when one of them is kept. It checks after it takes the locks, so a change after the tool's first check cannot slip through. |

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
**Run again…** read the store and the agent sessions, which are now kept.

### 3.5 Concurrency

The final check already runs under the target's row lock and NOWAIT locks on
every session it deletes, and it re-reads the set under those locks
(`workflow/store.ts:3800-3856`). The new check is one more read in that
transaction, after the locks. No new lock is taken.

- Sessions in the set cannot change state, gain a run or finish a run while the
  Sweeper holds their locks: admissions and run ends take the session row lock.
- Sessions above the target are read without a lock. A concurrent end of one of
  them can only make the Sweeper refuse; a later scan cleans.
- A session above the target that ended can run again in one case: a root whose
  orchestration was pruned accepts a new first message (`client.ts:1015-1030,
  1070-1076`). If that happens while a cleanup transaction runs, the cleanup's
  read of the root precedes the root's update, and the cleanup writes nothing
  the update reads, so the outcome is the same as the cleanup first, then the
  new message. The Workflow was not kept when it was deleted.

## 4. Alternatives considered

| Alternative | Why not |
|---|---|
| Keep only the Workflow session, not the sessions under it | The Log of an agent node reads the agent session (§2.1 step 6). Requirement 2 of the issue asks that the Log and the Node panel work as just after the run ended. |
| Decide "active" by each ancestor's orchestration status | The issue defines active by the session itself (not completed, cancelled or failed). It would add a duroxide read per ancestor, each of which can fail. |
| Treat the cleanup target as ended because its orchestration ended | Case 5: a session that never had a first message reads `NotFound` and would lose its Workflows, although it exists and has not ended. |
| A new session state, column or migration for "kept" | Not needed: the existing state already places the session in the `Terminated` row. A migration adds upgrade cost. |
| Exclude kept sessions from the scan only | `cleanup_session` with explicit ids and `prune_orchestrations` would still delete them. |
| Lock the sessions above the target in the final check | Not needed (§3.5). A NOWAIT lock on a busy active parent would refuse ordinary cleanups that hold no Workflow. |

## 5. Compatibility

- Tool names and parameters are unchanged. `cleanup_session` can return the new
  refusal status `WorkflowKept`; its results already carry a status string per
  target. The scan and the prune skip kept sessions without a new result field.
- No CMS migration, no session orchestration version, no Workflow controller
  version.
- Sessions with no finished Workflow above or below them are cleaned exactly as
  before.
- Behavior the issue asks to change: a finished Workflow session, and the
  sessions under it, are no longer cleaned while an ancestor is active, and an
  ended session that holds such a Workflow is kept too.

## 6. Risks and known limits

- Storage grows with a long-lived owner's finished Workflows and their agent
  sessions. The issue asks for no cap; a person can delete a finished Workflow.
- A session whose orchestration ended but whose state was never set to an ended
  state (for example a user abort of the orchestration) counts as active, so the
  finished Workflows under it are kept until it, or they, are deleted. This
  follows the issue's definition of active.
- The scan runs one more query per stale terminal candidate.

## 7. Quality gates

| Gate | Applies | Evidence |
|---|---|---|
| Database | Yes: a new read query in `WorkflowStore`; no schema change | Targeted local tests on a disposable PostgreSQL 16 (test-spec.md). |
| Prompts and skills | Yes: `sweeper.agent.md` and the Sweeper `SKILL.md` text | The SDK unit suite with its prompt and skill size budget tests. |
| Formal model | No: no new lock, state, message or orchestration step; one read inside the existing locked transaction (§3.5) | — |
| Portal and UX | No: no UI code change | — |
