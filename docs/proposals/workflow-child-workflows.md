# Child Workflows

| | |
|---|---|
| **Status** | IMPLEMENTED |
| **Date** | 2026-11-24 |
| **Formal Model** | [`workflow-child-workflows/formal/README.md`](workflow-child-workflows/formal/README.md) |

---

## 1. Summary

A Workflow can start another Workflow as its child and collect each child's result asynchronously without pausing its own loop.

This feature adds four capabilities:

1. **A `spawn` state.** It starts another Workflow as a child of the current Workflow and completes immediately with outcome `started` once the child run is admitted.
2. **A child-ended message (`WorkflowEnded@1`).** When a child run ends for any reason, the parent Workflow receives one typed `WorkflowEnded@1` message in its inbox.
3. **A `child_workflows` tool.** A Workflow's script states and direct agent steps can list, read, stop, and cancel that Workflow's own children. No other caller has access to it.
4. **One unified nesting level rule.** An agent step sits at the same level as its Workflow. Every other child is one level deeper than its parent, and no session exceeds level 2.

The implementation adds **no new tables, no new columns, and no Duroxide runtime changes** (one migration widens the existing `workflow_test_interceptions_operation_check` constraint to include `spawn` for test-mode interception). It reuses the keyed Start path, typed inbox, `receive` with `wait` and `carry`, `{ parent: true }` addressing, parent-only read/control authorization, the 50-child running budget, and end-of-run cleanup.

---

## 2. Problem

### 2.1 Motivation

Consider a periodic monitoring Workflow `service-monitor` running on a 5-minute loop:

```text
  collect_metrics -> triage_anomaly -> check_escalation -> deep_analysis -> publish_analysis -> wait_next_cycle
      (script)         (decision)         (script)        (agent, 600 s)      (script)         (wait, 300 s)
```

Running `deep_analysis` inline as an agent step inside the loop causes three limitations:

1. **Tight timeout budget.** Long investigations hit the inline step deadline and end `timed_out`, forcing prompts to restrict probes to a single short wave.
2. **Loop jitter.** The monitoring loop pauses while the agent works, pushing subsequent polls off schedule.
3. **No overlap.** A second anomaly detected while an investigation is active must wait or be skipped.

### 2.2 Requirements

| ID | Requirement |
|---|---|
| R1 | A Workflow starts another Workflow and does not wait for it. |
| R2 | Many children run concurrently; each can run for hours. |
| R3 | A child's result reaches the parent regardless of the parent's current state (timer, script, decision, agent). |
| R4 | The parent collects results in completion order, not spawn order. |
| R5 | The parent can inspect, stop, and cancel its own children from script states and direct agent steps only. |
| R6 | A child Workflow is a true child session: same tree, same budget, same lifecycle cleanup. |

### 2.3 Non-Goals

- Request/reply (`request`) handled by a Workflow.
- Cross-user child Workflows.
- Runtime-computed definition names on `spawn`.
- Whole-tree aggregate cost or token budgets.

---

## 3. Terms

| Term | Meaning |
|---|---|
| **Parent Workflow** | A Workflow session whose run enters a `spawn` state. |
| **Child Workflow** | The Workflow session started by a `spawn` state. Its `parent_session_id` is the parent Workflow. |
| **Definition owner** | The nearest ancestor session that is not a Workflow. Its saved definitions (and attached package definitions) are what a `spawn` state can name. |
| **Level** | A session's depth for the nesting limit (Section 6.5). |
| **Handle** | The output of a `spawn` state: `{ workflowId, runId, definition, revision }`. |
| **Ended message** | The `WorkflowEnded@1` message delivered into the parent Workflow's inbox when a child run ends. |
| **Agent step** | The agent session created by a Workflow's `type: agent` state. |
| **Start function** | `startSessionWorkflowDefinition` (`packages/sdk/src/workflow/session-definitions.ts`), which resolves the definition revision, enforces level and child budget limits, creates the Workflow session, admits the live run, and dispatches the controller. |
| **Effect helper** | The `workflow-effect` Duroxide orchestration (`1.0.0` script, `1.1.0` decision, `1.2.0` spawn). It runs the activity outside the controller turn, records the visit result, and wakes the controller. |

---

## 4. Architecture

### 4.1 Session Tree

```text
  Level 0   Chat session                            Definition owner (owns definitions:
                |                                   service-monitor, anomaly-investigation)
                |  starts (workflow_definition start)
                v
  Level 1   Workflow: service-monitor               Parent Workflow
                |                        ^
                |  spawn state           |  WorkflowEnded@1
                |  (starts a child,      |  (one typed inbox message per child,
                |   continues at once)   |   delivered when the child run ends)
                v                        |
  Level 2   Workflow: anomaly-investigation         Child Workflows: 0 to 50 running at a time
                |
                |  agent step (same level as its Workflow)
                v
  Level 2   Agent session: incident-analyst         Can run for hours; cannot spawn a sub-agent (level 3)
```

### 4.2 Design Rules

| Rule | Statement |
|---|---|
| **1. Parentage** | A child Workflow's parent session is the Workflow that spawned it. Existing `parent_session_id` mechanisms — session tree, running-child budget of 50, shared facts, `{ parent: true }` addressing, and parent-only authorization — apply uniformly. |
| **2. Spawn does not wait** | A `spawn` state completes with outcome `started` once the child run is admitted and its controller is dispatched. It never waits for the child to finish. |
| **3. An end is a message** | When a child run ends (`completed`, `failed`, `cancelled`, or `stopped`), the parent Workflow receives one `WorkflowEnded@1` message in its inbox, consumed via a standard `receive` state. |
| **4. A parent's end ends its children** | When a parent run ends for any reason, all active child Workflows are cancelled (or deleted when the parent is deleted). A parent that needs its children's results stays alive until it collects them. |
| **5. Unified level** | A root session is level 0. An agent step sits at its Workflow's level. Every other child is one level deeper than its parent. No session exceeds level 2. |

### 4.3 Design Decisions

- **Revision resolution:** A `spawn` state runs the newest valid revision of the named definition when the state is entered, unless an explicit `revision` number is specified. Running children keep the revision they started with.
- **Child lifecycle:** When a parent run ends for any reason, its active child Workflows are cancelled (Rule 4). A child's own `limits.timeoutSeconds` bounds its maximum lifetime.
- **Tool operations:** `child_workflows` exposes `list`, `read`, `stop`, and `cancel`.
- **Tool caller scope:** Only the parent Workflow's script states and direct agent steps can use `child_workflows`, and only on that Workflow's direct children. Chat agents use `read_workflow` and `update_workflow` on Workflows they started; humans inspect any visible session in the portal/TUI.

### 4.4 Reused Mechanisms

| Need | Existing mechanism | Location |
|---|---|---|
| Idempotent spawn retry | Keyed Start deriving child `workflowSessionId` from parent and internal spawn key (`nodeExecutionId`) | `workflow/session-definitions.ts`, `workflow/store.ts` |
| Single live run per Workflow | Unique live-run constraint `workflow_runs_one_live` | `workflow/store.ts` |
| Child-to-parent addressing | `{ parent: true }` resolves to definition's `parent_session_id` | `workflow/runtime.ts` |
| Typed inbox delivery | `recipientDecision` and `workflow_inbox` | `workflow/store.ts` |
| Timed receive preserving loop state | `receive` with `wait` and `carry` | `workflow/compiler.ts` |
| Parent-only read/control | `authorizeParent` | `workflow/tools.ts` |
| Running-child cap (50) | Counted by `parent_session_id` | `workflow/child-budget.ts` |
| Non-blocking effect execution | `workflow-effect` helper orchestration | `workflow/controller/index.ts`, `workflow/effect_1_2_0/index.ts` |
| Per-step tool grant derivation | Root grant inheritance at Start | `workflow/service.ts` |
| End notification | `notifyParent` activity | `workflow/runtime.ts` |
| End-of-run child cleanup | `endRunChildren` / `endAgents` activity | `workflow/controller/index.ts`, `workflow/runtime.ts` |

---

## 5. Components

| # | Component | Implementation | Key Files |
|---|---|---|---|
| C1 | **Level rule** | Unified session nesting rule (max level 2 across all chains); agent steps are stamped with their Workflow's level; removed `WORKFLOW_MAX_DESCENDANT_LEVEL` (3). | `workflow/input-policy.ts`, `workflow/session-definitions.ts`, `workflow/session-definition-store.ts`, `session-proxy.ts` |
| C2 | **Compiler** | Compiles `type: spawn` states (`definition`, `inputs`, `revision`, `agentModels`, `carry`, `transition`). Save warns when a literal definition is missing from the definition owner. Built-in reserved contract `WorkflowEnded@1` is accepted by `receive` without a `contracts:` entry, rejected in `contracts:` and `send`, and rejected on the ordinary runtime input path even for legacy pinned IR. | `workflow/compiler.ts`, `workflow/service.ts`, `workflow/store.ts` |
| C3 | **Controller 1.3.0** | Dispatches `workflow-effect` `1.2.0` for `spawn` states using the same non-blocking loop as `script` and `decision`. Frozen `1.0.0`, `1.1.0`, and `1.2.0` controllers stay registered for replay and continue-as-new handoff. | `workflow/controller/index.ts`, `workflow/controller/runtime.ts`, `workflow/controller_1_2_0/*`, `workflow/controller-version.ts`, `workflow/controller-registry.ts` |
| C4 | **`spawnChild` activity & effect `1.2.0`** | `effect_1_2_0` invokes `workflow.spawnChild` with bounded retry (`storeTagged`) for transient failures (such as controller START errors) before mapping exhausted retries to `execution_failed`, maps definite refusals directly to `invalid_input` / `unavailable` / `budget_exceeded` / `forbidden` / `cancelled`, records `started` + handle via `workflow.recordEffectResult`, and wakes the parent controller. | `workflow/effect_1_2_0/index.ts`, `workflow/runtime.ts`, `worker.ts` |
| C5 | **Start function & parent-run lock** | `startSessionWorkflowDefinition` accepts separate `ownerSessionId` (definition owner) and `parentSessionId` (spawning Workflow) plus an explicit internal `spawn: { nodeExecutionId }` mode. In the child-insert transaction: replay an existing receipt read-only first; otherwise lock the exact spawning run (`SELECT ... FOR UPDATE`), verify it is active, and verify via a plain read that the spawn node execution is still `pending` before inserting child rows. | `workflow/session-definitions.ts`, `workflow/service.ts`, `workflow/store.ts` |
| C6 | **End notice** | When the parent is a Workflow, `notifyParent` resolves the exact spawning run from the child's start operation and delivers a `WorkflowEnded@1` row to that run's inbox (only while that run is active). Bypasses the 100-message inbox cap only when verified in the store as `WorkflowEnded@1` from a direct child. Requester suppression applies to chat parents only. Outputs over 16 KB (or unwrappable payloads) omit `output` and set `outputTruncated: true`. | `workflow/runtime.ts`, `workflow/store.ts`, `workflow/service.ts` |
| C7 | **End-of-run & delete cleanup** | `endAgents` cancels active child Workflows (or deletes them when the parent is deleted), including cleaning up bare claimed sessions that have no run row yet. Per-session deletion in `PilotSwarmClient._deleteOneSession` and `PilotSwarmManagementClient._forceDeleteSession` soft-deletes every reached Workflow (direct or under an ancestor delete) first to block in-flight spawns, then scans and deletes direct child Workflows and bare claims before cancelling the parent controller. The sweeper prune (`cascade: false`) includes one level of child Workflows. | `workflow/runtime.ts`, `workflow/store.ts`, `client.ts`, `management-client.ts` |
| C8 | **`child_workflows` tool** | Exposed to Workflow script states (`callTool("child_workflows", ...)`) and direct agent steps (`workflowAgentChild`). Supports `list` (SQL-filtered/paged), `read` (`workflow_id`), `stop`, and `cancel` scoped strictly to the calling Workflow's direct children, returning `WORKFLOW_NOT_FOUND` otherwise. | `workflow/tools.ts`, `workflow/runtime.ts`, `workflow/store.ts`, `managed-session.ts`, `reserved-tool-names.ts` |
| C9 | **Read model and UI** | Adds `spawn` node kind, icon, and color token; shows spawned children links in node details and `spawnedBy` in child headers across portal and TUI; walks ancestor sessions to resolve the definition owner for nested Workflows. | `workflow/tools.ts`, `app/ui/core/src/*`, `app/ui/react/src/*`, `app/web/src/index.css` |
| C10 | **Test mode** | Migration `0103` widens `workflow_test_interceptions_operation_check` to include `spawn`. In test mode, `spawn` is a held call answered by a fixture or tester with a handle without creating a real child session; `WorkflowEnded@1` fixtures feed `receive` directly. | `migrations/workflow-child-workflows-0103.ts`, `workflow/test-mode.ts`, `workflow/definition-test.ts`, `workflow/runtime.ts` |
| C11 | **Skills** | Updated `workflow-authoring`, `workflow-reference`, `workflow-patterns`, and `workflow-tools` skills and `guidance.ts` to document `spawn`, `WorkflowEnded@1`, and `child_workflows`. | `packages/sdk/plugins/workflow/skills/*/SKILL.md`, `workflow/guidance.ts` |

---

## 6. Interfaces

### 6.1 The `spawn` State

```yaml
spawn_investigation:
  type: spawn
  definition: anomaly-investigation          # literal name or <package>/<name>; never a binding
  inputs:                                    # validated against the child's inputs.schema
    cycle: "${input.loopState.cycle}"
    snapshot: "${input.triageInput}"
  carry:                                     # optional; next state receives { carry, result }
    loopState: "${input.loopState}"
  transition:
    next:
      started: note_spawned
      failure: note_spawn_error
```

| Field | Required | Meaning |
|---|---|---|
| `definition` | Yes | Literal name of a definition owned by the definition owner, or `<package>/<name>` for an attached package definition. |
| `inputs` | No | Child Workflow inputs. Expression bindings are allowed in values. |
| `revision` | No | Fixed positive integer revision. When omitted, resolves the newest valid revision when the `spawn` state is entered. |
| `agentModels` | No | Per-state model overrides for the child's agent states, using the same parser and shape as `workflow_definition start`. |
| `carry` | No | Preserved state passed alongside `result` to the next state as `{ carry, result }`. |

**Outcome:** `started`, with handle output:

```json
{
  "workflowId": "9f41c8ab-0000-0000-0000-0000000001e4",
  "runId": "31e7021d-0000-0000-0000-000000000042",
  "definition": "anomaly-investigation",
  "revision": 2
}
```

**Error routes:** Standard runtime error codes route to a matching transition key or `failure`:

| Code | When |
|---|---|
| `invalid_input` | Inputs fail the child's `inputs.schema`. |
| `unavailable` | Definition does not exist, was deleted, or has no valid revision. |
| `budget_exceeded` | Parent Workflow already has 50 running children. |
| `forbidden` | Child would exceed nesting level 2. |

### 6.2 The `WorkflowEnded@1` Ended Message

Sent exclusively by the runtime when a child run ends. User definitions cannot declare it in `contracts:` or send it via `send` or ordinary runtime input. The sender is the child's session id and `correlation` is `{}`, so a `receive` without `correlate` accepts it.

```json
{
  "workflowId": "c4189a2b-0000-0000-0000-000000009a2b",
  "definition": "anomaly-investigation",
  "revision": 2,
  "spawnedBy": { "stateId": "spawn_investigation", "visit": 2 },
  "status": "completed",
  "outcome": "succeeded",
  "stateId": "done",
  "output": { "cycle": 49, "severity": "info", "summary": "Transient worker rollout spike" },
  "outputTruncated": false,
  "error": null
}
```

| Field | Meaning |
|---|---|
| `status` | Final run status: `completed`, `failed`, `cancelled`, or `stopped`. |
| `outcome`, `stateId` | Terminal state outcome and id, or `null` if the run did not finish at a terminal state. |
| `output` | Terminal output, omitted when larger than 16 KB (or not serializable within limits), in which case `outputTruncated: true` and the parent reads the full result via `child_workflows` `read`. |
| `error` | `{ code, message }` for failed or cancelled runs. Deadline expiration reports `status: "failed"` and `error.code: "timed_out"`. |

Rules:
- Exactly one message per child run, keyed by a fixed operation id (`ended:<runId>`).
- Exempt from the 100-message inbox cap when verified in the store as `WorkflowEnded@1` from a direct child.
- Always delivered to a Workflow parent while the spawning run is still active, including when cancelled by `child_workflows` `cancel` (even before the child began executing).
- A receive with no `from` does not take the end notice of a child that a cut parallel branch started; name the child with `from`, or give the receive a `wait`.
- Expires from the inbox after 24 hours; the child's result remains readable via `child_workflows` `read`.

### 6.3 Messaging Between Parent and Child

| Direction | Existing syntax | Notes |
|---|---|---|
| Child to parent (progress updates) | `recipient: { parent: true }` on `send` | Both definitions declare the same contract. |
| Parent to specific child | `recipient: "${input.result.workflowId}"` on `send` | Handle `workflowId` is a session id. |
| Parent receives from any child | `receive` with no `from` | Combine with `wait` and `carry`. |
| Parent receives from one child | `receive` with `from: "${input.result.workflowId}"` | Filters to that child session. |

### 6.4 The `child_workflows` Tool

Available only to a Workflow's script states (`callTool("child_workflows", ...)`) and direct agent steps. The calling Workflow identity is bound by the runtime and cannot be overridden. Sub-agents of an agent step and chat sessions do not have this tool.

Only direct child Workflows of the calling Workflow are visible; any other id returns `WORKFLOW_NOT_FOUND`.

| Operation | Arguments | Response |
|---|---|---|
| `list` | `status`: `active` (default), `ended`, or `all`; `definition` (optional); `limit` (1–100, default 50); `cursor` | `{ children: [...], nextCursor }`, newest first (filtered and paginated in SQL) |
| `read` | `workflow_id` | Same shape as `read_workflow` |
| `stop` | `workflow_id`, `operation_id`, `grace_seconds` (0–3600, default 60), `reason` | Same as `update_workflow` `stop` |
| `cancel` | `workflow_id`, `operation_id`, `reason` | Same as `update_workflow` `cancel` |

### 6.5 Nesting Level Rule

A root session is level 0. An agent step sits at its Workflow's level. Every other child is one level deeper than its parent. Maximum level is 2.

| Chain | Levels | Result |
|---|---|---|
| Chat → sub-agent → sub-agent | 0, 1, 2 | Allowed; level-2 sub-agent cannot spawn |
| Chat → Workflow → agent step → sub-agent | 0, 1, 1, 2 | Allowed; level-2 sub-agent cannot spawn |
| Chat → sub-agent → Workflow → agent step | 0, 1, 2, 2 | Allowed; level-2 agent step cannot spawn |
| Chat → Workflow → child Workflow → agent step | 0, 1, 2, 2 | **Allowed**; level-2 agent step cannot spawn |
| Chat → Workflow → child Workflow → child Workflow | 0, 1, 2, 3 | Refused (`forbidden`) |
| Chat → sub-agent → Workflow → child Workflow | 0, 1, 2, 3 | Refused (`forbidden`) |

### 6.6 Read Model Additions

- **`spawn` node details:** includes `children` (handles created by this state with live status).
- **Child Workflow read model:** includes `spawnedBy: { workflowId, stateId, visit }`.
- **Graph nodes:** includes `type: "spawn"` and target `definition`.

---

## 7. Data Model

No new tables or columns are added. Migration `0103` widens `workflow_test_interceptions_operation_check` to permit `spawn`.

| Fact | Existing storage |
|---|---|
| Child's parent Workflow | `sessions.parent_session_id` and `workflow_definitions.parent_session_id` |
| Child definition & revision | `workflow_definitions.session_definition_id`, `session_revision` |
| Definition owner | `sessionPin.ownerSessionId` in creation config |
| Spawning visit | `workflow_runs.start_operation_id` (`spawn:<nodeExecutionId>`) |
| Spawn handle | `workflow_node_executions.output` on the spawn visit |
| Ended message | `workflow_inbox` row (`contract = WorkflowEnded@1`, `operation_id = ended:<runId>`, `correlation = {}`) |
| End-notice dedupe | `runNoticeRecorded` on the child run |
| Child tool grant & workspace | Inherited from parent run's stored root grant at Start |

---

## 8. Execution Sequences

### 8.1 Spawn

```text
  Parent controller              Effect helper (1.2.0)         Child controller
        |
        |--- START ------------------>|
        |                             |  [DB: lock parent run FOR UPDATE & check pending visit;
        |                             |       create child Workflow + live run]
        |                             |--- START -------------------->|
        |                             |  [DB: spawn visit = started + handle]
        |<-------- ENQUEUE wake ------|                               |
        |                            END                              |
        |  [DB: read "started"]                                       |
        |  transitions to next state                                  |  (runs concurrently)
```

- Locking the exact spawning run (`FOR UPDATE`) and checking that the spawn visit is still pending in the same transaction that inserts child rows serializes spawn admission against parent termination without reversing the lock order of session-delete triggers.
- If `START` of the child controller throws a transient error after the child rows commit, `effect_1_2_0` retries `workflow.spawnChild`; the keyed Start replays the receipt read-only and dispatches the same controller instance id.

### 8.2 Child Ends

```text
  Child controller                                       Parent controller
        |                                                      |  (waiting or busy)
        |  [DB: child run = terminal]                          |
        |  [DB: WorkflowEnded@1 row in spawning run's inbox]   |
        |--- ENQUEUE wake ------------------------------------->|
       END                                                     |  [DB: consume message]
                                                               |  transitions to "received"
```

- If the parent is in a matching `receive`, the message completes that `receive` in the same transaction and the wake delivers it immediately.
- If the parent is busy in another state, the message waits in the inbox and the next `receive` consumes it immediately in FIFO arrival order.
- If the spawning run is already terminal, delivery is skipped.

### 8.3 Parent Run Ends or Is Deleted

```text
  Parent controller                                      Child controller (each active child)
        |  [DB: parent run = terminal]                         |
        |  [DB: child run = cancelled (or deleted)]            |
        |--- ENQUEUE wake ------------------------------------->|
       END                                                     |  [DB: sees terminal status]
                                                               |  ends its own agent step
                                                              END
```

- Every parent-ending path updates the parent's `workflow_runs` row before cleanup enumerates children, ensuring no in-flight spawn can commit after cleanup scans.
- `deleteSession` soft-deletes a Workflow parent before scanning and deleting child Workflows and before cancelling the parent controller.

---

## 9. Worked Example: `service-monitor` & `anomaly-investigation`

### 9.1 Authoring Lifecycle

1. Save `anomaly-investigation` (`workflow_definition save`) in the owning chat session.
2. Test `anomaly-investigation` standalone (`workflow_definition test`) or run it directly (when started by the chat, its end notice goes to the chat).
3. Save `service-monitor`, referencing `anomaly-investigation` in a `spawn` state.
4. Test `service-monitor` in test mode: `spawn` is a held call answered with a fixture handle, and `WorkflowEnded@1` is supplied by a fixture.
5. Start `service-monitor` live.

### 9.2 Child Definition (`anomaly-investigation`)

```yaml
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: anomaly-investigation, version: "1.0.0" }
inputs: { schema: { $ref: "#/schemas/InvestigationInputs" } }
initial: rca_deep_dive
limits: { timeoutSeconds: 14400 }            # 4 hours
states:
  rca_deep_dive:
    type: agent
    invoke: { agent: { name: incident-analyst } }
    grant: ["mcp:metrics", "mcp:incidents-readonly"]
    timeoutSeconds: 14000
    input: { task: "Investigate this anomaly and report root cause.", snapshot: "${inputs.snapshot}" }
    outputSchema: { $ref: "#/schemas/DeepAnalysisResult" }
    outcomes: [analyzed, benign_noise]
    transition: { next: { analyzed: done, benign_noise: done, failure: failed } }
  done:   { type: terminal, outcome: succeeded, output: { cycle: "${inputs.cycle}", analysis: "${input}" } }
  failed: { type: terminal, outcome: failed, output: "${runtime.error}" }
```

### 9.3 Parent Definition Excerpt (`service-monitor`)

```yaml
spawn_investigation:
  type: spawn
  definition: anomaly-investigation
  inputs: { cycle: "${input.loopState.cycle}", snapshot: "${input.triageInput}" }
  carry: { loopState: "${input.loopState}" }
  transition: { next: { started: note_spawned, failure: note_spawn_error } }

wait_or_collect:
  type: messaging
  mode: receive
  contract: WorkflowEnded@1
  carry: { loopState: "${input.loopState}" }
  wait: { seconds: "${input.remainingSeconds}" }
  transition: { next: { received: publish_investigation, elapsed: collect_metrics, failure: failed } }

publish_investigation:
  type: script
  outcomes: [wait_more, poll_due]
  source: |
    const { carry, result } = context.input;          // result is the WorkflowEnded@1 payload
    // Publish report from result, then resume remaining poll wait
    const left = Math.ceil((carry.loopState.nextPollDueMs - Date.now()) / 1000);
    if (left >= 1) await setResult("wait_more", { loopState: carry.loopState, remainingSeconds: left });
    else await setResult("poll_due", carry.loopState);
  transition: { next: { wait_more: wait_or_collect, poll_due: collect_metrics, failure: failed } }
```

---

## 10. Limits, Failure Modes, and Cleanup

| Scenario | Behaviour |
|---|---|
| Parent has 50 running children | `spawn` fails with `budget_exceeded`; parent transition handles it. |
| Unbounded `spawn` loop | Parent run's `maxNodeExecutions` terminates the loop. |
| Child definition updated while parent runs | Next `spawn` uses the newest valid revision (or fixed `revision`); running children keep their started revision. |
| Parent inbox at 100 waiting messages | Direct-child `WorkflowEnded@1` is still accepted. |
| Parent never receives `WorkflowEnded@1` | Inbox row expires after 24 hours; child result stays readable via `child_workflows` `read`. |
| Child output exceeds 16 KB | Notice sets `outputTruncated: true` and omits `output`; parent reads full output via `child_workflows` `read`. |
| Parent run ends while children run | Active children are cancelled (Rule 4). |
| Parent run ends while a `spawn` is in flight | Serialized by the parent-run `FOR UPDATE` lock: either child commits first and cleanup cancels it, or parent end commits first and spawn is refused (`RUN_ENDED`) with no child rows. Verified by the TLA+ model. |
| Parent or ancestor session deleted | Every reached Workflow is soft-deleted first (blocking in-flight spawns), its direct child Workflows and bare claims are scanned and deleted, and then its controller is cancelled. |
| Child controller START fails after all retries | The spawn takes `failure`; the child stays admitted with no controller, is visible in `list`, the parent can cancel it, and the parent's end cancels it. |
| Child is deleted directly (not cancelled or stopped) | A child that is deleted directly (not cancelled or stopped) sends no ended message. The parent's `receive` then takes its timeout. End a child with `cancel` or `stop`. |
| Fresh claim loses race to parent end, or worker crashes between claim and admission | A fresh claim created in that attempt that fails with `RUN_ENDED` is soft-deleted immediately; a resumed claim or a crash between session claim and admission of a visit that is then cut can leave an empty claim holding one budget slot until the parent is deleted. |
| Sweeper prune (`cascade: false`) | Includes one level of child Workflows when sweeping expired/deleted parent Workflows. |

---

## 11. Verification

### 11.1 Formal Verification (TLA+ / TLC)

See [`workflow-child-workflows/formal/README.md`](workflow-child-workflows/formal/README.md).

- **Original design:** TLC found a depth-7 counterexample violating `NoRunningAfterCleanup` (session claim → parent cancel + cleanup → child run insert).
- **Fixed design (parent-run lock):** Exhaustive TLC check passed with **11,922,657 states generated, 3,314,067 distinct states, depth 45, 0 errors, 0 deadlocks**, plus 4 witness traces (duplicate replay, worker stop after commit, out-of-order completion, and refused post-end admission).

### 11.2 Automated Test Coverage (T1–T23)

| ID | Area | Coverage |
|---|---|---|
| T1–T2 | Level rule | All 6 nesting chains and level-1 agent step spawning level-2 sub-agent |
| T3–T4 | Compiler | `spawn` fields/errors, `WorkflowEnded@1` built-in receive / rejected send & legacy runtime guard |
| T5–T7 | Store & Start | Parentage, budget count, idempotent replay & `OPERATION_CONFLICT`, budget/level/input refusals, package definitions, true claim-vs-cancel race, delete barrier |
| T8–T10 | Inbox & notice | Pending-receive vs queued FIFO delivery, duplicate notifier idempotency, 100-message cap bypass, 16 KB truncation & unwrappable fallback |
| T11–T18 | Runtime & faults | Out-of-order (2, 3, 1), poll loop schedule with concurrent child, failed/timed_out/pre-begin tool-cancelled child notices, all 6 parent end modes (complete, fail, cancel, stop, timeout, delete), real chat-end cascade, transient spawn retry, controller 1.2.0 → 1.3.0 handoff |
| T19–T21 | `child_workflows` tool | `list`/`read`/`stop`/`cancel` from script and agent step, coded `WORKFLOW_NOT_FOUND` outside own children, unavailable to chat/sub-agents |
| T22 | Test mode | Held `spawn` interception + `WorkflowEnded@1` fixture |
| T23 | UI | `spawn` node rendering, children links in details, `spawnedBy`, nested Workflow owner resolution |

---

## 12. Alternatives Considered

| Alternative | Why not chosen |
|---|---|
| Start children from a script tool call without a `spawn` state | Loses graph visibility and pushes idempotency keys onto every script author. |
| Poll with `child_workflows` `list` instead of `WorkflowEnded@1` | Delays collection by up to one poll interval and makes failed/timed-out children easy to miss; `notifyParent` already exists. |
| Store child Workflows as siblings under the chat via a new link table | Duplicates parentage, addressing, budgets, and authorization and adds a new table. |
| Pin child revisions when the parent starts | Prevents rolling out bug fixes to child definitions without restarting long-lived parent Workflows; fixed `revision` already covers strict pinning when needed. |
