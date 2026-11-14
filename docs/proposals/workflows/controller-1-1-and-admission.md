Status: Design as implemented (describes the "Unreleased" section of `CHANGELOG.md`; source citations are pinned to PilotSwarm commit `77109baffc8dcc34a6fe74caaae90288a66e023b`; comparison base `8aa84d2c2c5fc5c2d55c6dd077141b75c58d3ea8`; not yet merged)

# Workflow controller 1.1.0, carry, owner approval and Start admission: design, implementation and test specification

This document covers every change in this release that alters a Workflow algorithm, a stored schema or a version, except tool composition. [Tool and package composition](tool-composition.md) owns `grant`, `tools`, `requiredTools`, a named agent's startup tool, the package pins of granted tools, the `tool_names` deprecation and the reasons for session orchestration 1.0.84. This document links to it where those topics meet.

Paths under `packages/sdk/src/` are written without that prefix. A citation `file:line` refers to commit `77109baf`.

Section 2's controller layout is updated for the subsequent freeze refactor:
1.0.0 is copied from main `8aa84d2c`; 1.1.0 retains the behavior at
`d0f5571b`. New links without line numbers describe that layout. The other
line-numbered citations retain their historical pin.

## 1. Problem and scope

### 1.1 Problems, one example each

| Feature | Feedback | Example of the problem at 0.8.11 |
|---|---|---|
| Frozen controller 1.0.0 and live 1.1.0 | - | A run started before an upgrade has a recorded controller history. New state behaviour must not change how that history replays. |
| Carry | FB-005 | A poll loop counts attempts in its input. The poll script throws. The `failure` route receives only `runtime.error`, so the attempt counter is lost. |
| Owner approval step | FB-007 | A Workflow drafts a release note and must wait for its owner's explicit yes before it publishes. No state can wait for a person's decision. |
| Waits up to 30 days; agent wake-up limits | FB-018 | A weekly check needs a 7-day wait, but `seconds` was capped at 86,400. An agent inside a 1-hour visit sets a 2-day `cron`; the wake arrives after the visit has closed. |
| Continued agents and stale schedules | FB-026 | A `session: continue` agent sets a `cron` in visit 1. It fires during visit 2, which never asked for it. |
| Script syntax check at Save | FB-016 | A script with a top-level `return` saves as valid and fails only when its state runs. |
| Concurrent tool-call warning | FB-017 | A script calls tools inside `Promise.all`. Overlapping calls fail at run time with "Concurrent workflow tool calls are not supported." |
| Literal script tool check at Start | FB-009 | A script calls `callTool("notes-read_note")`, but the starting session has not loaded that package. The Start succeeds and the run fails later. |
| Canvas tools in scripts | FB-014 | A script calls `draw_canvas`. Every such call fails: canvas tools need a live agent session. |
| Start without a captured grant | FB-008 | The starting session's tools cannot be captured. The Start succeeds; every script tool call then fails. |
| Start key | FB-001 | A caller retries a Start after a lost reply and creates a second Workflow. |
| Package checks | FB-032, FB-033 | A registry read times out for a moment; the script's tool call fails. A live registry reload rebuilds tool objects at the same revision; an object-identity check refuses the call. |
| Typed input deadlock | FB-028 | Three ordinary transactions form a lock cycle. PostgreSQL aborts `acceptInput`, and the model receives "deadlock detected". |
| Parent re-check under lock | - | A parent's cancel is authorized against an unlocked read of the parent, then written in another transaction. |
| Finished-Workflow retention | FB-011 | The Sweeper removes a finished Workflow before the user has read its result. |
| Run provenance | FB-013 | A reader cannot tell which saved revision of the owning session's definition a Workflow was started from. |
| Prompt pause | FB-021 to FB-025 | A pause takes effect only when the controller next reads its commands, not promptly. |
| Session orchestration 1.0.84 | - | `spawn_agent` gains `grant` and `tools`. Histories recorded at 1.0.83 must still replay. |

### 1.2 Out of scope

- **UX.** Portal and UI changes (labels, card fonts, graph layout, status words, links, the YAML toggle) are out of scope of this document.
- **Tool composition.** See [tool-composition.md](tool-composition.md).
- **Guidance text.** Changes to the Workflow skills (polling budgets, uncertain outcomes, the `workflow-carry`, `workflow-approval` and `workflow-long-agent` skills) and the YAML quoting fix that lets the CLI load the polling skill change no algorithm. They are listed in the CHANGELOG.
- **Succession (FB-002).** The gate `succession` exists and is off in every version ([`workflow/controller-features.ts:11-12`](../../../packages/sdk/src/workflow/controller-features.ts#L11-L12), [`workflow/controller-features.ts:22`](../../../packages/sdk/src/workflow/controller-features.ts#L22)). There is no hand-over in this release.

## 2. Versioning and compatibility

### 2.1 What has a version

| Part | Before | After | Where |
|---|---|---|---|
| Workflow controller (Duroxide orchestration `workflow-controller`) | 1.0.0 only | Frozen 1.0.0 and live 1.1.0 registered; new runs at 1.1.0 | [`workflow/controller-version.ts`](../../../packages/sdk/src/workflow/controller-version.ts), [`workflow/controller-registry.ts`](../../../packages/sdk/src/workflow/controller-registry.ts) |
| Session orchestration `durable-session-v2` | latest 1.0.83 | latest 1.0.84; 1.0.83 frozen | [`orchestration-version.ts:15`](../../../packages/sdk/src/orchestration-version.ts#L15), [`orchestration-registry.ts:84-85`](../../../packages/sdk/src/orchestration-registry.ts#L84-L85) |
| Turn activity contract of the latest session orchestration | `workflow-intake-v1` | `tool-composition-v1`, tag `pilotswarm.tool-composition.v1`, activities `runTurnV6` and `runTurnEpochV6` | [`orchestration/proxy-contract.ts:1`](../../../packages/sdk/src/orchestration/proxy-contract.ts#L1), [`activity-routing.ts:130-146`](../../../packages/sdk/src/activity-routing.ts#L130-L146) |
| Workflow IR | version 1 | version 1 (new fields are optional) | [`workflow/compiler.ts:26`](../../../packages/sdk/src/workflow/compiler.ts#L26) |
| CMS schema | migration 0089 | migrations 0090 and 0091 | [`cms-migrations.ts:425-426`](../../../packages/sdk/src/cms-migrations.ts#L425-L426) |

### 2.2 Why the controller has a new version

Carry changes what a successor state receives. Approval adds a state type and three activities (`workflow.enterApproval`, `workflow.elapseApproval`, `workflow.interceptApproval`, [`workflow/runtime.ts:256-258`](../../../packages/sdk/src/workflow/runtime.ts#L256-L258)). The controller generator schedules different activities for an approval state. A recorded 1.0.0 history replayed by a changed generator would not match. So every run records the version it was admitted at in `workflow_runs.controller_version`. Its first execution runs on that version, and each continue-as-new moves it to the latest controller (item 5); the record stays its admission version and keeps gating its features.

**Mechanism.**

1. Freeze main's 1.0.0 controller in [`workflow/controller_1_0_0/`](../../../packages/sdk/src/workflow/controller_1_0_0/). It owns its generator helpers, parsers, constants and command/branch helpers, and its own version stays the literal `"1.0.0"`. It imports no live runtime code. Its external imports are erased Duroxide types and, since FB-064, one value import of the shared latest version from [`workflow/controller-version.ts`](../../../packages/sdk/src/workflow/controller-version.ts), used only as its continue-as-new target (item 5). Activity names and inputs remain unchanged.
2. Keep live 1.1.0 in [`workflow/controller/`](../../../packages/sdk/src/workflow/controller/), with the same file structure. Its approval behavior is unconditional. [`workflow/controller-registry.ts`](../../../packages/sdk/src/workflow/controller-registry.ts) maps each version to its own handler; `registerWorkflow` iterates that registry. `workflowControllerFeatures` remains only for shared activity compatibility, not generator selection.
3. New runs are admitted at `WORKFLOW_CONTROLLER_VERSION` = 1.1.0, for live starts and for test runs ([`workflow/service.ts:411`](../../../packages/sdk/src/workflow/service.ts#L411), [`workflow/service.ts:1571`](../../../packages/sdk/src/workflow/service.ts#L1571)).
4. Start and recovery of a run's first execution use the run's stored version, not the build's newest (`requireRunsController`, [`workflow/service.ts:309-314`](../../../packages/sdk/src/workflow/service.ts#L309-L314)). A version the build does not run is refused with `CONTROLLER_UNAVAILABLE` before anything changes.
5. FB-064: each tree's `controlRun` continues as new at the shared latest version, `WORKFLOW_CONTROLLER_LATEST_VERSION`, as a session moves to the latest orchestration. A run admitted at 1.0.0 moves to 1.1.0 at its first continue-as-new. Duroxide records only the continue-as-new input in history, not its target, so the frozen 1.0.0 generator's history still replays; `ControllerInput` and its parser are identical in both versions, and for a plan that 1.0.0 can run the two generators schedule the same work.
6. Shared activities continue to check the run's stored version, not the worker's newest version. The arrival mapping and entry snapshot use the carry guard; approval admission, deadlines and interception use the approval guard. Store admission repeats the approval/interception constraints. A run with no stored version is treated as 1.0.0. The six helper orchestrations and all activity implementations retain their previous schedules and bodies.

`workflow-controller-freeze-1-0-0.test.mjs` pins every frozen file, forbids
every live import except that latest-version import (exactly one import line and
one use, the continue-as-new target), and permits only the registry to import
the frozen tree.
`orchestration-freeze-1-0-83.test.mjs` also pins the already-frozen session
tree. Recorded generator histories compare main 1.0.0 with the frozen
controller and the bound 1.1.0 with the live controller. A later controller
version must freeze the then-live tree and repeat these obligations; it
must not edit this frozen copy.

### 2.3 A 1.0.0 run whose definition declares a new feature

The 0.8.11 compiler refused unknown state keys and the `approval` type, so a run admitted by 0.8.11 has no such IR. The frozen parser and shared activity guards still refuse unsupported behavior:

| IR declares | 1.0.0 run does | Where |
|---|---|---|
| `carry` on a state | Writes no snapshot (`carry_snapshot` NULL) and routes the raw result or error, as 0.8.11 did. | [`workflow/runtime.ts:3367-3376`](../../../packages/sdk/src/workflow/runtime.ts#L3367-L3376), [`workflow/runtime.ts:3517-3523`](../../../packages/sdk/src/workflow/runtime.ts#L3517-L3523) |
| an `approval` state | Main's frozen plan parser fails the run visibly with `plan node <id> type is invalid`, before admission. The shared admission activity also refuses with `WORKFLOW_FEATURE_UNSUPPORTED`. | [`workflow/controller_1_0_0/runtime.ts`](../../../packages/sdk/src/workflow/controller_1_0_0/runtime.ts), [`workflow/runtime.ts`](../../../packages/sdk/src/workflow/runtime.ts) |

These gates read the run's stored admission version, not the version of the current execution. A 1.0.0 run that moved to 1.1.0 at a continue-as-new therefore still writes no snapshot; an approval plan fails in its first execution, before any continue-as-new, so it never moves. The formal carry model checks this as `Inv_GateHolds`: "Controller 1.0.0 (gate `carry` off) routes raw results and writes no snapshot, even when the IR declares carry". Its fault case `fault.ca2-gate-ignored`, which honours the IR at 1.0.0, violates the invariant in 3 steps ([carry README](../../formal/workflow/carry/README.md)). Honouring the IR at 1.0.0 would therefore break the gate's rule that 1.0.0 behaves exactly as before.

The gate covers carry and approval only. Other changes in this release act on 1.0.0 runs too: 30-day waits (section 3.3), the agent wake-up limit, the schedule reset, a named agent's startup tool, package checks, the deadlock retry and the retention rule.

### 2.4 Session orchestration 1.0.84 and the frozen 1.0.83

Why 1.0.84 exists, and what it changes in `spawn_agent`, is in [tool-composition.md section 5](tool-composition.md#5-versioning). The mechanics:

1. **Freeze.** The previous live tree `orchestration/` is copied to `orchestration_1_0_83/`. Eleven of its twelve files are byte-identical to `orchestration/` at the base commit. The one difference is `runtime.ts`, where `CURRENT_ORCHESTRATION_VERSION` becomes the literal `"1.0.83"` ([`orchestration_1_0_83/runtime.ts:23`](../../../packages/sdk/src/orchestration_1_0_83/runtime.ts#L23)). The frozen tree keeps the `workflow-intake-v1` contract.
2. **Registry.** `orchestration-registry.ts` imports 1.0.83 from the frozen tree and 1.0.84 from `orchestration/` ([`orchestration-registry.ts:38-39`](../../../packages/sdk/src/orchestration-registry.ts#L38-L39), [`orchestration-registry.ts:84-85`](../../../packages/sdk/src/orchestration-registry.ts#L84-L85)). A recorded history replays on the handler of its own version.
3. **One contract constant.** Every live session proxy and manager proxy in `orchestration/` takes `LIVE_SESSION_PROXY_CONTRACT` ([`orchestration/proxy-contract.ts:1`](../../../packages/sdk/src/orchestration/proxy-contract.ts#L1); for example [`orchestration/runtime.ts:176-177`](../../../packages/sdk/src/orchestration/runtime.ts#L176-L177), [`orchestration/lifecycle.ts:215`](../../../packages/sdk/src/orchestration/lifecycle.ts#L215), [`orchestration/turn.ts:486`](../../../packages/sdk/src/orchestration/turn.ts#L486)). At the base commit each site named `"workflow-intake-v1"` literally. One constant keeps every rebuild of the session proxy, for example after a workspace change or an affinity release, on the 1.0.84 contract.
4. **Worker tags.** Every worker adds `pilotswarm.tool-composition.v1` to its activity tags ([`workflow/milestone-worker.ts:35`](../../../packages/sdk/src/workflow/milestone-worker.ts#L35)), so only a worker of this release takes 1.0.84 turns.
5. **Movement.** A session moves to 1.0.84 at its next continue-as-new (see [tool-composition.md section 5.3](tool-composition.md#53-how-an-old-session-replays)).

### 2.5 Deployment: stop-all is a safety requirement

The CHANGELOG states:

> **Upgrade: stop every worker, the portal and the MCP server, deploy, then start them. Do not roll the workers.** New sessions start at session orchestration 1.0.84 and new Workflow runs at Workflow controller 1.1.0; a worker of 0.8.11 has neither. **This is a safety requirement: stop every worker before starting the new release.** A worker of an older release that runs alongside this one silently ignores `grant` and `requiredTools`, and can give an agent step more tools than its definition allows. Nothing else guards against it: the stored Workflow format keeps its version.

Why nothing else guards: the IR version stays 1 ([`workflow/compiler.ts:26`](../../../packages/sdk/src/workflow/compiler.ts#L26)). The 0.8.11 stored-IR reader rebuilds each agent state from the fields it knows, so it reads a new revision without error and drops `grant` and `requiredTools`. The new turn tag keeps 0.8.11 workers away from 1.0.84 turns only. This document did not trace which other activities a 0.8.11 worker could still take; it relies on the CHANGELOG statement above.

> **Rollback.** A rollback to 0.8.11 ignores `grant` and `requiredTools` on revisions saved with them: their agent steps then run with the 0.8.11 tool set. 0.8.11 refuses to save a revision that uses them. A Workflow run that continued as new on controller 1.1.0, like a run started at 1.1.0 and a session at 1.0.84, does not run on 0.8.11.

Migrations 0090 and 0091 are additive, so a rollback leaves them in place and 0.8.11 does not read them. 0.8.11 registers only Workflow controller 1.0.0 and session orchestrations up to 1.0.83, and Duroxide resolves an execution's requested version exactly. So a Workflow run on controller 1.1.0, whether admitted there or moved there by a continue-as-new (FB-064), and a session at 1.0.84 cannot run on 0.8.11. This follows from the source; it is not tested (section 6). Deployments therefore remain stop-all.

## 3. Features

### 3.1 Carry (FB-005)

**Design.** A nonterminal state may declare `carry`: an object template of bindings. The state's entry freezes it into a snapshot before input mapping. Every successor of a carrying state receives `{ carry: <snapshot>, result: <output or error> }`. `runtime.error` stays the original error envelope. A state without carry keeps its 0.8.11 result shape. Carry needs controller 1.1.0.

**Algorithm.** On entry of state S (`enter` activity, [`workflow/runtime.ts:3458`](../../../packages/sdk/src/workflow/runtime.ts#L3458)):

1. Read the predecessor's stored result. If the predecessor declares `carry` and the run's gate is on, the arriving value is `carryArrival(snapshot, result)` ([`workflow/runtime.ts:3367-3376`](../../../packages/sdk/src/workflow/runtime.ts#L3367-L3376), [`workflow/carry.ts:24-28`](../../../packages/sdk/src/workflow/carry.ts#L24-L28)). A wrapper over 256 KiB fails S with `invalid_input` before S's input mapping.
2. If S declares `carry` and the gate is on, evaluate the template against the same scope as `input:` (run inputs, KV, arriving value, `runtime.error`, branch item) and canonicalize it ([`workflow/runtime.ts:3517-3523`](../../../packages/sdk/src/workflow/runtime.ts#L3517-L3523), [`workflow/carry.ts:7-14`](../../../packages/sdk/src/workflow/carry.ts#L7-L14)). A binding error or a snapshot over 64 KiB admits S with an immediate `invalid_input` and a NULL snapshot; no effect starts.
3. Evaluate `input:` and the input schema as before. A failure here keeps the snapshot from step 2 with the immediate failure.
4. `store.enterNode` writes the node row with `carry_snapshot`, the input and the KV revision in one INSERT, in one transaction with the KV-revision check ([`workflow/store.ts:3819`](../../../packages/sdk/src/workflow/store.ts#L3819), [`workflow/store.ts:4044-4063`](../../../packages/sdk/src/workflow/store.ts#L4044-L4063)). If the KV revision moved, admission returns `kv_changed` and the controller evaluates input and carry again.
5. A repeated admission of the same node execution with the same KV basis must have the same input hash and the same snapshot, or it is refused with `NONDETERMINISTIC_ADMISSION`; with another basis, the stored row wins ([`workflow/store.ts:3830-3840`](../../../packages/sdk/src/workflow/store.ts#L3830-L3840)).

**Replay and isolation.** The snapshot is written once and never updated. A controller replay or an activity retry after the commit returns the stored row. Each node execution, and so each loop visit and each parallel branch, has its own row and snapshot. A parallel state's own carry wraps its join result; it does not enter branch manifests.

**Compile rules.** `carry` must be an object template ([`workflow/compiler.ts:1663-1666`](../../../packages/sdk/src/workflow/compiler.ts#L1663-L1666)). A terminal refuses it. An approval state refuses it with `WORKFLOW_FIELD_UNKNOWN` ([`workflow/compiler.ts:1660-1662`](../../../packages/sdk/src/workflow/compiler.ts#L1660-L1662)). The stored-IR reader validates carry again ([`workflow/compiler.ts:2415-2420`](../../../packages/sdk/src/workflow/compiler.ts#L2415-L2420)). The input-mismatch warning skips successors of a carrying state, because they receive the wrapper.

**Failure modes.**

| Case | Result |
|---|---|
| Carry binding fails, or snapshot over 64 KiB | S fails `invalid_input`, no effect, successor gets `{ carry: null, result: error }` |
| Input mapping fails after a valid carry | S fails `invalid_input`; snapshot kept |
| Wrapper over 256 KiB | Receiving state fails `invalid_input` before its input mapping |
| Script crashes after changing its own variables | Changes are lost; carry holds only entry data |
| Effect outcome is uncertain (a write may have happened) | Carry does not authorize a retry; reconcile first |

**Limits.** 64 KiB per snapshot (`WORKFLOW_CARRY_MAX_BYTES`, [`workflow/carry.ts:4`](../../../packages/sdk/src/workflow/carry.ts#L4)); 256 KiB per wrapper (`WORKFLOW_PAYLOAD_MAX_BYTES`, [`workflow/json.ts:19`](../../../packages/sdk/src/workflow/json.ts#L19)). The snapshot is canonical JSON text; NUL characters and lone surrogates survive. Reads do not show the snapshot; it is visible only through a successor's input.

### 3.2 Owner approval step (FB-007)

**Design.** A state `type: approval` asks the Workflow's owner one question about a frozen proposal and waits for `approved`, `rejected` or the deadline. Only the person who owned the Workflow when the state was entered, and still owns it, can answer, directly in the portal. Agents, MCP callers, shared readers and administrators cannot answer.

**YAML.** `question` (1 to 4,000 characters), optional `approver: owner`, `timeoutSeconds` (literal integer, 1 to 2,592,000), optional `input` and `inputSchema`, and `transition.next` with `approved`, `rejected` and `timed_out` routes, plus runtime error routes ([`workflow/compiler.ts:788-818`](../../../packages/sdk/src/workflow/compiler.ts#L788-L818)). A whole-run deadline not longer than the approval's interval warns `WORKFLOW_APPROVAL_RUN_DEADLINE` ([`workflow/compiler.ts:1676-1684`](../../../packages/sdk/src/workflow/compiler.ts#L1676-L1684)).

**Who may answer.**

| Check | Where |
|---|---|
| Actor is a person (`kind: "user"`) | [`workflow/approval.ts:121`](../../../packages/sdk/src/workflow/approval.ts#L121) |
| Person path, not through an agent session (`originatingSessionId` absent) | [`workflow/human-commands.ts:250-255`](../../../packages/sdk/src/workflow/human-commands.ts#L250-L255) |
| The MCP server refuses `approval_respond` with `FORBIDDEN` | [`packages/app/mcp/src/tools/workflows.ts:105-108`](../../../packages/app/mcp/src/tools/workflows.ts#L105-L108) |
| Actor is the Workflow's current owner, read under lock | [`workflow/approval.ts:126-129`](../../../packages/sdk/src/workflow/approval.ts#L126-L129) |
| Actor is the owner pinned when the state was entered | [`workflow/approval.ts:139-141`](../../../packages/sdk/src/workflow/approval.ts#L139-L141) |
| The answer names the visit (`approval_id` = node execution id) and the proposal digest (`context_sha256`) | [`workflow/approval.ts:17-30`](../../../packages/sdk/src/workflow/approval.ts#L17-L30), [`workflow/approval.ts:142`](../../../packages/sdk/src/workflow/approval.ts#L142) |

**Admission.** In the `enterApproval` activity ([`workflow/runtime.ts:3767`](../../../packages/sdk/src/workflow/runtime.ts#L3767)):

1. The state's input is evaluated and checked as for other states.
2. For a live run, the Workflow's lineage is read. If the Workflow sits inside a Workflow agent step's subtree, or has no authenticated owner, the state is admitted with an immediate runtime error `forbidden` ([`workflow/runtime.ts:3714-3747`](../../../packages/sdk/src/workflow/runtime.ts#L3714-L3747), [`workflow/store.ts:3870-3882`](../../../packages/sdk/src/workflow/store.ts#L3870-L3882)).
3. Otherwise the store reads its clock once and sets `deadline_at = LEAST(entered + timeoutSeconds, run deadline)` ([`workflow/store.ts:4033-4040`](../../../packages/sdk/src/workflow/store.ts#L4033-L4040)).
4. In the same transaction it inserts the `workflow_approvals` row: the pinned owner, the frozen snapshot (question, input, Workflow, run, approval id, revision, IR hash, saved-definition source, owner, activation and deadline times) and `context_sha256`, the SHA-256 of its canonical JSON ([`workflow/approval.ts:60-79`](../../../packages/sdk/src/workflow/approval.ts#L60-L79), [`workflow/store.ts:4066`](../../../packages/sdk/src/workflow/store.ts#L4066)).
5. The controller then treats the state as a timed wait ([`workflow/runtime.ts:1493-1499`](../../../packages/sdk/src/workflow/runtime.ts#L1493-L1499)).

**Answer** (`WorkflowApprovalStore.respond`, [`workflow/approval.ts:120-180`](../../../packages/sdk/src/workflow/approval.ts#L120-L180)). One transaction:

1. Lock the session; refuse a deleted Workflow. Read the current owner `FOR SHARE`.
2. If a receipt exists for this `operation_id`: the same request returns the stored receipt with `replayed: true`, even after the deadline or the run's end; a different request is `OPERATION_CONFLICT`.
3. Lock run, node and approval rows. Check pinned owner, digest (`APPROVAL_CONTEXT_CHANGED`), live mode, the gate, an active run (`admitted`, `running` or `paused`), no accepted stop, a pending node and no decision (`APPROVAL_CLOSED`). In a parallel branch, the branch's parallel state must still be pending and before its deadline.
4. Read the store clock once. If `deadline_at <= now`, record the timeout and answer `APPROVAL_EXPIRED`. Equality loses.
5. Otherwise write the node result (business outcome `approved` or `rejected`, `winner = 'approval_owner'`), the decision on the approval row, the operation receipt and the `workflow.state_completed` event.
6. After commit, wake the controller ([`workflow/service.ts:1442-1447`](../../../packages/sdk/src/workflow/service.ts#L1442-L1447)). The wake carries no authority.

**Deadline** (`elapseApproval`, [`workflow/runtime.ts:3768-3792`](../../../packages/sdk/src/workflow/runtime.ts#L3768-L3792); `expire`, [`workflow/approval.ts:182-197`](../../../packages/sdk/src/workflow/approval.ts#L182-L197)). The controller's durable timer fires at the deadline. Under the same locks, a still-pending row whose deadline has passed is completed as runtime error `timed_out` (`winner = 'approval_timeout'`). The approval row keeps `decision` NULL. A row already decided is simply collected, which also recovers a lost wake. Pausing does not move the deadline.

**State machine of one approval visit.**

| From | Event | To |
|---|---|---|
| (entry) | no owner, or inside an agent subtree | completed, runtime error `forbidden` |
| (entry) | owner present | pending |
| pending | pinned and current owner answers before the deadline | completed `approved` or `rejected` |
| pending | deadline timer, or an answer at or after the deadline | completed runtime error `timed_out` |
| pending | cancel, delete, stop or the run deadline | closed by the existing run-ending paths |
| completed | any new answer | refused `APPROVAL_CLOSED`; an identical retry replays its receipt |

**Test runs.** A test run creates an interception (`operation = 'approval'`) instead of a live record. Only a fixture `{ decision, reason? }` answers it ([`workflow/test-mode.ts:257-266`](../../../packages/sdk/src/workflow/test-mode.ts#L257-L266)). Its deadline runs on the virtual clock; a wall-clock timer never decides it ([`workflow/runtime.ts:3776-3787`](../../../packages/sdk/src/workflow/runtime.ts#L3776-L3787)).

**Limits.** One approver: the owner. Reason up to 2,000 characters; a rejection needs a nonblank reason. Approval state refuses carry. Ownership changes do not transfer a pending approval. A decision approves the proposal only, not later actions.

### 3.3 Waits up to 30 days and agent wake-up limits (FB-018)

**Design.** A wait state's `seconds` accepts 1 to 2,592,000 (`WAIT_MAX_SECONDS`, [`workflow/compiler.ts:28`](../../../packages/sdk/src/workflow/compiler.ts#L28)). Agent, request, receive and parallel timeouts keep 86,400 (`STATE_TIMEOUT_MAX_SECONDS`, [`workflow/compiler.ts:30`](../../../packages/sdk/src/workflow/compiler.ts#L30)). The whole-run deadline stays at most 30 days ([`workflow/compiler.ts:57`](../../../packages/sdk/src/workflow/compiler.ts#L57)).

**Algorithm.**

1. Compile: literal and bound `seconds` use the per-field maximum ([`workflow/compiler.ts:832`](../../../packages/sdk/src/workflow/compiler.ts#L832)). A bound value is checked again on entry with `WAIT_MAX_SECONDS` ([`workflow/runtime.ts:3583`](../../../packages/sdk/src/workflow/runtime.ts#L3583)). This applies to every run, including 1.0.0 runs: a bound value between 86,401 and 2,592,000 that failed before now waits.
2. Warnings: `WORKFLOW_AGENT_TIMEOUT_LOOP` when an agent routes `timed_out` to itself ([`workflow/compiler.ts:1168`](../../../packages/sdk/src/workflow/compiler.ts#L1168)); `WORKFLOW_WAIT_EXCEEDS_RUN_TIMEOUT` when a literal wait exceeds `limits.timeoutSeconds` ([`workflow/compiler.ts:1838-1845`](../../../packages/sdk/src/workflow/compiler.ts#L1838-L1845)).
3. Agent wake-ups: before `wait`, `wait_on_worker`, `cron` or `cron_at` queues anything, a direct Workflow agent child reads its visit's deadline from the store. A wake at or after the deadline is refused with an error that names the deadline and the sleep-outcome pattern ([`workflow/agent-scheduling.ts:8-22`](../../../packages/sdk/src/workflow/agent-scheduling.ts#L8-L22); callers [`managed-session.ts:2027`](../../../packages/sdk/src/managed-session.ts#L2027), [`managed-session.ts:2118`](../../../packages/sdk/src/managed-session.ts#L2118), [`managed-session.ts:2197`](../../../packages/sdk/src/managed-session.ts#L2197), [`managed-session.ts:2262`](../../../packages/sdk/src/managed-session.ts#L2262)). The deadline is the turn's captured visit ([`session-proxy.ts:3266-3274`](../../../packages/sdk/src/session-proxy.ts#L3266-L3274)). Ordinary sessions are unchanged. Cancelling a schedule does not read the deadline.
4. The agent prompts name the rule (`WORKFLOW_AGENT_SLEEP_WORDS`, [`workflow/agent-scheduling.ts:4-5`](../../../packages/sdk/src/workflow/agent-scheduling.ts#L4-L5)).

**Stale schedules (FB-026).** A turn of a `session: continue` agent resets the schedule when it starts a new visit, or when it is a late turn of a visit already closed (`resetsWorkflowSchedule`, [`session-proxy.ts:2442-2443`](../../../packages/sdk/src/session-proxy.ts#L2442-L2443)). The turn result then starts with `{ type: "cron", action: "cancel" }` before the turn's own actions ([`session-proxy.ts:5722-5725`](../../../packages/sdk/src/session-proxy.ts#L5722-L5725)). A stopped turn keeps only that cancellation ([`session-proxy.ts:2026-2033`](../../../packages/sdk/src/session-proxy.ts#L2026-L2033)). A turn inherited inside the same open visit keeps its schedule.

**Failure modes and limits.** The run deadline still ends a long wait, and pausing extends neither the wait nor the run deadline. The wake-up limit applies to direct agent children only; a descendant's `cron` is not checked.

### 3.4 Save and Start checks

All checks below run before a Workflow session or run is created.

**Script syntax (FB-016).** At Save, each script source, including those in parallel bodies, is parsed by acorn as an ES module with top-level `await` and without top-level `return` ([`workflow/script-analysis.ts:74-84`](../../../packages/sdk/src/workflow/script-analysis.ts#L74-L84)). A syntax error is `WORKFLOW_SCRIPT_SYNTAX`, with acorn's line and column of the script source ([`workflow/compiler.ts:661-662`](../../../packages/sdk/src/workflow/compiler.ts#L661-L662)). Read returns the same diagnostics; Start refuses the invalid revision with `DEFINITION_INVALID`. Nesting too deep for the analysis gives the warning `WORKFLOW_SCRIPT_UNCHECKED`, not an error ([`workflow/script-analysis.ts:81`](../../../packages/sdk/src/workflow/script-analysis.ts#L81), [`workflow/compiler.ts:663-664`](../../../packages/sdk/src/workflow/compiler.ts#L663-L664)). No script runs.

**acorn is pinned to exactly 8.16.0** ([`packages/sdk/package.json:101`](../../../packages/sdk/package.json#L101)). A published SDK install has no lockfile. acorn 8.19.0 reports deep nesting as a `SyntaxError`, which the analysis would show as an invented syntax failure instead of `WORKFLOW_SCRIPT_UNCHECKED`. The pin stays until the analysis handles that error.

**Concurrent tool calls (FB-017).** A `callTool` inside `Promise.all` or `Promise.allSettled` (not shadowed) warns `WORKFLOW_TOOLS_CONCURRENT` ([`workflow/script-analysis.ts:65-71`](../../../packages/sdk/src/workflow/script-analysis.ts#L65-L71), [`workflow/compiler.ts:665-666`](../../../packages/sdk/src/workflow/compiler.ts#L665-L666)). At run time the refusal text now says how to fix it ([`workflow/script-analysis.ts:3-4`](../../../packages/sdk/src/workflow/script-analysis.ts#L3-L4), [`workflow/tool-executor.ts:113`](../../../packages/sdk/src/workflow/tool-executor.ts#L113)).

**Literal tool names (FB-009) and canvas tools (FB-014).** The analysis collects literal first arguments of the runtime `callTool`, respecting local shadowing ([`workflow/script-analysis.ts:88-111`](../../../packages/sdk/src/workflow/script-analysis.ts#L88-L111)). `workflowToolDiagnostics` checks each name ([`workflow/tool-requirements.ts:25-83`](../../../packages/sdk/src/workflow/tool-requirements.ts#L25-L83)):

| Name is | Save and read | Start |
|---|---|---|
| a canvas tool (`draw_canvas`, `update_canvas`, ...) | warning `WORKFLOW_TOOL_LIVE_SESSION` | refused `WORKFLOW_TOOLS_UNAVAILABLE` |
| a Workflow control tool | warning `WORKFLOW_TOOL_NOT_GRANTED` | refused |
| missing, excluded or ambiguous in the captured grant | warning `WORKFLOW_TOOL_NOT_GRANTED` | refused |
| dynamic | warning `WORKFLOW_TOOLS_DYNAMIC` | starts; checked at run time |
| grant unknown at Save | warning `WORKFLOW_TOOLS_UNCHECKED` | checked against the captured grant |

`requireWorkflowToolRequirements` turns the blocking warnings into one refusal that names up to ten paths and tools; nothing is started ([`workflow/tool-requirements.ts:86-97`](../../../packages/sdk/src/workflow/tool-requirements.ts#L86-L97)). Canvas tools are also excluded from captured grants, and a stored old grant that names one is refused at run time ([`workflow/tool-policy.ts:194-199`](../../../packages/sdk/src/workflow/tool-policy.ts#L194-L199), [`workflow/tool-policy.ts:256`](../../../packages/sdk/src/workflow/tool-policy.ts#L256)).

**Grant capture (FB-008).** `startToolBinding` captures the starting session's tool grant ([`workflow/session-definitions.ts:392-405`](../../../packages/sdk/src/workflow/session-definitions.ts#L392-L405)). If the capture throws and the revision has script states, Start refuses with `WORKFLOW_PARENT_CONTEXT_UNAVAILABLE`, names up to five script states, and creates nothing. A revision without script states starts without a grant. The capture throws for a system session, so a system session cannot start a revision with script states ([`session-manager.ts:4032-4034`](../../../packages/sdk/src/session-manager.ts#L4032-L4034)). A definition test is not refused: it runs without the grant and its fixtures answer the calls ([`workflow/definition-tool.ts:335-337`](../../../packages/sdk/src/workflow/definition-tool.ts#L335-L337)).

**Start key (FB-001).** Algorithm:

1. `key` is optional: 1 to 128 characters, nonblank, valid Unicode, no NUL; otherwise `WORKFLOW_COMMAND_INVALID` ([`workflow/session-definitions.ts:150-157`](../../../packages/sdk/src/workflow/session-definitions.ts#L150-L157)).
2. With a key, the operation id becomes `definition-key:<sha256(key)>`, so the key, not the caller's tool call id, names the attempt. The owner is read from the owning session, so the agent tool and the person API share keys ([`workflow/session-definitions.ts:431-433`](../../../packages/sdk/src/workflow/session-definitions.ts#L431-L433)).
3. The Workflow session id is derived from the owning session and the operation id ([`workflow/session-definitions.ts:434`](../../../packages/sdk/src/workflow/session-definitions.ts#L434)), so concurrent repeats claim the same id.
4. If that Workflow exists, the replay path answers from the stored Start receipt with the original Workflow, run and revision ([`workflow/session-definitions.ts:287-381`](../../../packages/sdk/src/workflow/session-definitions.ts#L287-L381)). It uses the recorded grant, so a current capture failure does not refuse a repeat. Different arguments are `OPERATION_CONFLICT`; a deleted Workflow is `WORKFLOW_DELETED`; a Workflow that no longer belongs to this session and owner is `WORKFLOW_EXISTS`.
5. Without a key, behaviour is unchanged: each tool call is a new attempt.

### 3.5 Package checks (FB-032, FB-033)

The rules for which package version a tool is pinned to, and what stops a tool, are in [tool-composition.md section 2.6](tool-composition.md#26-what-stops-a-tool). This section covers how a check runs.

**Algorithm** (`retryWorkflowPackageCheck`, [`workflow/package-pins.ts:63-86`](../../../packages/sdk/src/workflow/package-pins.ts#L63-L86)):

1. One budget per tool call: 3 seconds, or less if the script state's deadline comes first. A stopped script stops the check.
2. Only `WorkflowPackageCheckError` is retried. Only registry and bundle reads create it ([`workflow/package-pins.ts:20-28`](../../../packages/sdk/src/workflow/package-pins.ts#L20-L28), [`workflow/package-pins.ts:43-60`](../../../packages/sdk/src/workflow/package-pins.ts#L43-L60)). A tool's own failure and an authority refusal are never retried.
3. At most 3 attempts, 1 second apart, inside the budget. Then the call fails with `WorkflowTemporaryToolError`: "The package is not lost. Call the tool again", with `retryable: true` ([`workflow/package-pins.ts:30-41`](../../../packages/sdk/src/workflow/package-pins.ts#L30-L41)).
4. A nested check inside an active budget does not start a second budget.

**Isolation from pooled resources.** The budget lives in an `AsyncLocalStorage` context. Pooled CLI clients and shared Workflow tool setup start outside it (`withoutWorkflowPackageCheck`, [`session-manager.ts:1653`](../../../packages/sdk/src/session-manager.ts#L1653), [`session-manager.ts:4401`](../../../packages/sdk/src/session-manager.ts#L4401)), so an expired budget of one call cannot fail a later call that reuses the pooled client. A script's tool-executor opening that failed a temporary check is not cached; the next call opens again ([`workflow/runtime.ts:4433-4437`](../../../packages/sdk/src/workflow/runtime.ts#L4433-L4437)). Permanent failures stay cached.

**Script failure channel.** A typed package refusal reaches the script as an ordinary error. If the script then exits with that uncaught error, the runner reports the typed message and details instead of the stderr tail ([`workflow/runtime.ts:5681`](../../../packages/sdk/src/workflow/runtime.ts#L5681)). The link uses a fourth pipe that carries only 32-hex identities issued by the runner's broker, bounded to 4 KiB ([`workflow/runner.ts:128-131`](../../../packages/sdk/src/workflow/runner.ts#L128-L131), [`workflow/runner.ts:482`](../../../packages/sdk/src/workflow/runner.ts#L482), [`workflow/runner.ts:590-596`](../../../packages/sdk/src/workflow/runner.ts#L590-L596)). Script output cannot forge host authority.

**Provider scoping.** A tool is attributed to the packages the binding selected, the bound agent's package, retained labels, static sources, or, only when exactly one matches, a published package in the binding's source revisions ([`workflow/package-pins.ts:133-167`](../../../packages/sdk/src/workflow/package-pins.ts#L133-L167)). An unselected package with a colliding export is ignored.

**Handler identity (FB-033).** A package tool call is authorized against the live export at the admitted revision, by name. The turn keeps its captured handler and its state ([`session-manager.ts:2748-2753`](../../../packages/sdk/src/session-manager.ts#L2748-L2753)). Before, a same-revision rebuild produced a new object and the identity check refused the call.

### 3.6 Typed input that loses a deadlock (FB-028)

Three ordinary transactions can form a lock cycle: a session ending waits for its Workflow child; that child's send to a second Workflow waits; a typed input into the second Workflow from the first session waits for the session. PostgreSQL aborts one with `40P01`. The controller's enter path and the session-ending update were already retried; `acceptInput` was not.

`acceptInput` now runs in `idempotentTransaction` ([`workflow/store.ts:4433`](../../../packages/sdk/src/workflow/store.ts#L4433)): on `40P01` only, it re-runs the whole transaction after 50, 200 and 800 ms, then lets the last error through ([`workflow/store.ts:171`](../../../packages/sdk/src/workflow/store.ts#L171), [`workflow/store.ts:2202-2212`](../../../packages/sdk/src/workflow/store.ts#L2202-L2212)). It qualifies because its work is SQL on one client, keyed by an operation id with a stored receipt, and its wakes are sent after it returns. `store.transaction` is not made to retry, and no global lock order is added.

### 3.7 A parent's lifecycle command is re-checked under the lock

`applyLifecycleCommandToWorkflow` authorizes a parent's command against an unlocked read. It now passes `expectedParentSessionId` ([`workflow/service.ts:1282`](../../../packages/sdk/src/workflow/service.ts#L1282)). `recordSessionCommand` takes the session and definition locks, then re-reads both parent columns and refuses with `FORBIDDEN` if either differs ([`workflow/store.ts:3144-3157`](../../../packages/sdk/src/workflow/store.ts#L3144-L3157)). An operator's command passes no expected parent and is unchanged. Nothing changes a Workflow's parent today; this closes the window for a later change that would.

### 3.8 Finished-Workflow retention (FB-011)

The Sweeper no longer removes Workflow sessions on its own:

- `scan_completed_sessions` and `prune` skip `session_kind = 'workflow'` ([`sweeper-tools.ts:309`](../../../packages/sdk/src/sweeper-tools.ts#L309), [`sweeper-tools.ts:587`](../../../packages/sdk/src/sweeper-tools.ts#L587)).
- `cleanup_session` refuses a Workflow target with `WorkflowRetained` ([`sweeper-tools.ts:215-222`](../../../packages/sdk/src/sweeper-tools.ts#L215-L222)).
- A finished Workflow stays until it is deleted, or until its owning session or another ancestor is deleted.
- The parent's end-of-run notice says so ([`workflow/runtime.ts:1958`](../../../packages/sdk/src/workflow/runtime.ts#L1958)).

Test benches keep their separate rule: when a test run ends, ended tests of its definition beyond the newest five are retired ([`workflow/runtime.ts:4014`](../../../packages/sdk/src/workflow/runtime.ts#L4014)).

### 3.9 Run provenance (FB-013)

The Workflow overview read adds `definition.source = { ownerSessionId, definitionId, revision }` from the existing columns `workflow_definitions.session_definition_id` and `session_revision` ([`workflow/tools.ts:1143-1145`](../../../packages/sdk/src/workflow/tools.ts#L1143-L1145)). `currentRevision` and `publishedRevision` still describe the Workflow's own copy. A later save of the owning definition does not change `source`. No column is added.

### 3.10 Pause and resume are noticed promptly (FB-021 to FB-025)

After `setRunPaused` commits, `controlWorkflowRun` reads the run and enqueues a `workflow-wake` on the controller's command queue ([`workflow/service.ts:1134-1145`](../../../packages/sdk/src/workflow/service.ts#L1134-L1145)):

- resume: when the run is in an admitting status, as before;
- pause: when the run is active and has begun (`runNotBegun`, [`workflow/store.ts:90-92`](../../../packages/sdk/src/workflow/store.ts#L90-L92)).

A run that has not begun has no controller instance yet. A message queued to a missing instance would be dropped and leave a stray execution row; that controller reads the pause when it begins. The wake is a hint only: the store holds the state, and a retry resends it. Pause does not cancel started work or its timers. The controller and its scheduling are unchanged.

### 3.11 Required tools and the startup tool

The rule, the defaults and the refusals are in [tool-composition.md sections 2 and 6](tool-composition.md#phase-a-agent-steps). Two implementation points matter for this document:

- Each required-tool call is a `workflow.agent_tool_called` session event keyed by the node execution, so the gate counts calls per visit and needs no migration ([`workflow/store.ts:6222-6228`](../../../packages/sdk/src/workflow/store.ts#L6222-L6228)). `complete_workflow_node` refuses an early outcome with `REQUIRED_TOOLS_NOT_CALLED` ([`workflow/store.ts:6910-6914`](../../../packages/sdk/src/workflow/store.ts#L6910-L6914), [`workflow/agent-node-service.ts:130-135`](../../../packages/sdk/src/workflow/agent-node-service.ts#L130-L135)).
- A named agent's `initialRequiredTool` is sent only when the step's session has run no turn yet. The host reads the session's turn watermark (`turnHigh`), because `currentIteration` is also zero after the first turn ([`workflow/agent-host.ts:217-221`](../../../packages/sdk/src/workflow/agent-host.ts#L217-L221)).

## 4. Schema and data model

### 4.1 Migration 0090 `workflow_carry`

From [`migrations/workflow-carry-0090.ts:1-9`](../../../packages/sdk/src/migrations/workflow-carry-0090.ts#L1-L9) (`${quoted}` is the quoted schema):

```sql
SET LOCAL lock_timeout = '5s';
ALTER TABLE ${quoted}.workflow_node_executions
    ADD COLUMN IF NOT EXISTS carry_snapshot TEXT;
```

Additive and nullable. No backfill: NULL means "no carry". TEXT, not JSONB, keeps NUL characters and lone surrogates; the reader validates the text and its bound ([`workflow/carry.ts:16-21`](../../../packages/sdk/src/workflow/carry.ts#L16-L21), [`workflow/store.ts:583`](../../../packages/sdk/src/workflow/store.ts#L583)).

### 4.2 Migration 0091 `workflow_approvals`

From [`migrations/workflow-approvals-0091.ts:1-43`](../../../packages/sdk/src/migrations/workflow-approvals-0091.ts#L1-L43) (`${s}` is the quoted schema):

```sql
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS ${s}.workflow_approvals (
    node_execution_id TEXT PRIMARY KEY REFERENCES ${s}.workflow_node_executions(node_execution_id),
    workflow_session_id TEXT NOT NULL REFERENCES ${s}.workflow_definitions(workflow_session_id),
    run_id TEXT NOT NULL REFERENCES ${s}.workflow_runs(run_id),
    owner_provider TEXT NOT NULL CHECK (length(owner_provider) > 0),
    owner_subject TEXT NOT NULL CHECK (length(owner_subject) > 0),
    snapshot TEXT NOT NULL,
    context_sha256 TEXT NOT NULL CHECK (context_sha256 ~ '^[0-9a-f]{64}$'),
    decision TEXT CHECK (decision IN ('approved', 'rejected')),
    reason TEXT CHECK (reason IS NULL OR length(reason) <= 2000),
    decided_by TEXT,
    decided_at TIMESTAMPTZ,
    operation_id TEXT,
    CONSTRAINT workflow_approvals_decision CHECK (
        (decision IS NULL AND reason IS NULL AND decided_by IS NULL AND decided_at IS NULL AND operation_id IS NULL)
        OR (decision IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND operation_id IS NOT NULL
            AND length(operation_id) > 0 AND (decision <> 'rejected' OR (reason IS NOT NULL AND length(btrim(reason)) > 0)))
    )
);
CREATE INDEX IF NOT EXISTS workflow_approvals_by_run ON ${s}.workflow_approvals(run_id, node_execution_id);
CREATE OR REPLACE FUNCTION ${s}.workflow_approval_immutable() RETURNS TRIGGER AS $$
BEGIN
    IF ROW(NEW.node_execution_id, NEW.workflow_session_id, NEW.run_id, NEW.owner_provider, NEW.owner_subject, NEW.snapshot, NEW.context_sha256)
        IS DISTINCT FROM ROW(OLD.node_execution_id, OLD.workflow_session_id, OLD.run_id, OLD.owner_provider, OLD.owner_subject, OLD.snapshot, OLD.context_sha256)
        OR (OLD.decision IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
        RAISE EXCEPTION 'a Workflow approval proposal or accepted decision is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS workflow_approval_immutable ON ${s}.workflow_approvals;
CREATE TRIGGER workflow_approval_immutable BEFORE UPDATE ON ${s}.workflow_approvals
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_approval_immutable();
ALTER TABLE ${s}.workflow_test_interceptions DROP CONSTRAINT IF EXISTS workflow_test_interceptions_operation_check;
ALTER TABLE ${s}.workflow_test_interceptions ADD CONSTRAINT workflow_test_interceptions_operation_check
    CHECK (operation IN ('tool.call', 'agent', 'send', 'request', 'approval'));
```

Additive: a new empty table, an index, a trigger, and a widened CHECK on `workflow_test_interceptions`. No backfill. Existing interception rows satisfy the wider CHECK. Notes:

- One row per approval visit; the key is the node execution id, which is also the `approval_id` in commands.
- `decided_by` holds canonical JSON `{ provider, subject, displayName }`.
- A timed-out or closed approval keeps `decision` NULL; its outcome is on the node execution row.
- The receipt of an answer is a `workflow_operations` row with `kind = 'approval_respond'`.

### 4.3 Definition and IR fields (IR version stays 1)

| YAML key | State types | IR field | Rule |
|---|---|---|---|
| `carry` | nonterminal, not approval | `carry` (object template) | Section 3.1; acts only at controller 1.1.0 |
| `type: approval` with `question`, `approver`, `timeoutSeconds`, `input`, `inputSchema` | approval | `WorkflowIRApproval` ([`workflow/compiler.ts:223-234`](../../../packages/sdk/src/workflow/compiler.ts#L223-L234)) | Section 3.2; stored-IR reader at [`workflow/compiler.ts:2249-2256`](../../../packages/sdk/src/workflow/compiler.ts#L2249-L2256) |
| `seconds` | wait | unchanged shape | 1 to 2,592,000 |
| `grant`, `requiredTools` | agent | `grant`, `requiredTools` | See [tool-composition.md](tool-composition.md) |
| `notes` (root and state), `transition.notes` | all; route notes not on terminals | `notes`, `routeNotes` | Literal text, at most 16 KiB each ([`workflow/compiler.ts:529`](../../../packages/sdk/src/workflow/compiler.ts#L529)); display only |

A graph without these fields compiles to the same IR as before. The compiler refuses them on 0.8.11, so a revision that uses them cannot be saved there.

### 4.4 Stored bindings and events (no migration)

| Value | Stored in | Owner |
|---|---|---|
| `toolGrant`, `toolCeiling` of a spawned child; `agentStepBindings` of a Workflow grant | `sessions.creation_config` | [tool-composition.md section 5.5](tool-composition.md#55-stored-data) |
| `workflowToolLabels` (`packagePins`, `toolSources`) | `sessions.creation_config`, written under a row lock only when the binding is unchanged ([`cms.ts:2479-2504`](../../../packages/sdk/src/cms.ts#L2479-L2504)) | Section 3.5 |
| `workflow.tools_delegated` (once per Workflow), `workflow.agent_tool_called` | session events | tool-composition.md |
| `workflow.state_completed` with `approval: true`; `workflow.state_failed` with `timed_out` | session events | Section 3.2 |

### 4.5 Read-model fields

| Field | Where | Section |
|---|---|---|
| `nodeExecutions[].approval`, `openExecutions[].approval`: `approvalId`, `question`, `context`, `contextSha256`, `owner`, `activatedAt`, `deadlineAt`, `status`, `decision` (live runs only) | [`workflow/approval.ts:199-216`](../../../packages/sdk/src/workflow/approval.ts#L199-L216) | 3.2 |
| `personCommands.approvals[]` with `mayAnswer` and `reason`; the management client always answers `mayAnswer: false` | [`management-client.ts:2065-2074`](../../../packages/sdk/src/management-client.ts#L2065-L2074) | 3.2 |
| `definition.source` | [`workflow/tools.ts:1143-1145`](../../../packages/sdk/src/workflow/tools.ts#L1143-L1145) | 3.9 |
| `pins`, `delegated` | [`workflow/tools.ts:685-688`](../../../packages/sdk/src/workflow/tools.ts#L685-L688), [`workflow/tools.ts:1136-1139`](../../../packages/sdk/src/workflow/tools.ts#L1136-L1139) | tool-composition.md |
| `warnings` on `workflow_definition` save, read and Start | [`workflow/definition-tool.ts:111-112`](../../../packages/sdk/src/workflow/definition-tool.ts#L111-L112), [`workflow/definition-tool.ts:137-138`](../../../packages/sdk/src/workflow/definition-tool.ts#L137-L138) | 3.4 |

## 5. Test specification

"GAP" means no test in this pull request proves the requirement. Tests marked "env-gated" are skipped unless the named source roots are set. Paths are relative to the repository root.

### 5.1 Versioning

| Requirement | Tests |
|---|---|
| V1 New runs start at 1.1.0; a 1.0.0 run starts at 1.0.0; an unknown version is refused | `packages/sdk/test/local/workflow-controller-versions.test.js`: "a new run is admitted and started at 1.1.0; a run admitted at 1.0.0 is started at 1.0.0; an unknown version is refused" |
| V2 A 1.0.0 run ignores declared carry | `packages/sdk/test/local/workflow-carry.test.js`: "a legacy %s run ignores declared carry, writes NULL, and routes raw errors" (1.0.0 and NULL) |
| V3 A 1.0.0 run cannot admit an approval | `packages/sdk/test/local/workflow-approval.test.js`: "does not admit an approval at 1.0.0"; `packages/sdk/test/unit/workflow-approval-controller.test.mjs`: "the approval path is unavailable to a controller admitted at 1.0.0" |
| V4 Gates are read from the feature table, not a literal version | `workflow-approval.test.js`: "uses the feature gate, not a literal version, for live and test admission and owner answers" |
| V5 1.0.83 is frozen; 1.0.84 is the live tree | `packages/sdk/test/unit/orchestration-intake-1-0-83.test.mjs`: "1.0.83 has its frozen replay tree; ..."; `packages/sdk/test/unit/orchestration-registry-modules.test.mjs`: "each registered version is its own module's handler, exactly; the latest (1.0.84) is the live tree"; `packages/sdk/test/unit/orchestration-freeze-1-0-82.test.mjs`: "the registry keeps 1.0.82 and 1.0.83 frozen and registers 1.0.84 from the live tree" |
| V6 Every live proxy uses the 1.0.84 contract | `packages/sdk/test/unit/orchestration-composition-contract.test.mjs`: "every live session and manager proxy uses the single 1.0.84 contract" |
| V7 A real 1.0.83 session continues into 1.0.84 | `packages/sdk/test/local/session-real-source-upgrade.test.js`: "continues an actual 1.0.83 session as new into 1.0.84 and dispatches composition turns" (env-gated); `packages/sdk/test/local/orchestration-version-upgrade.test.js`: "upgrades ${sourceVersion} snapshots into the latest orchestration" |
| V8 Stop-all deployment; no mixed fleet | GAP: no automated test (as [tool-composition.md 7.2 N7](tool-composition.md#72-one-test-for-each-cell-of-44)) |
| V9 Rollback to 0.8.11 | GAP |

### 5.2 Carry

| Requirement | Tests |
|---|---|
| C1 Freeze before input mapping; survive KV updates and replay; carry errors unchanged | `workflow-carry.test.js`: "freezes before input mapping, survives a KV update and activity replay, and carries errors unchanged" |
| C2 KV conflict re-evaluates input and carry together | `workflow-carry.test.js`: "re-evaluates input and carry together after a pre-admission KV conflict" |
| C3 Duplicates cannot change a snapshot | `workflow-carry.test.js`: "same-basis duplicate admissions cannot alter carry; a newer evaluation loses to the committed row" |
| C4 No carry keeps the raw shape at 1.1.0 | `workflow-carry.test.js`: "a state without carry retains its raw result shape at 1.1.0" |
| C5 Failed selection starts no effect; input failure keeps the snapshot | `workflow-carry.test.js`: "%s runs no effect and preserves only a successfully selected carry" |
| C6 Size bounds and JSON fidelity | `workflow-carry.test.js`: "64 KiB carry and 256 KiB combined boundaries are exact; ...", "oversize carry fails its own state; an oversize wrapper fails the receiver before input mapping", "canonical text survives real database storage without JSONB replacement" |
| C7 Branch isolation | `workflow-carry.test.js`: "outer carry does not enter branch manifests; each branch freezes its own snapshot, ...", "an empty manifest still preserves the outer snapshot" |
| C8 Real worker through crashes | `packages/sdk/test/local/workflow-carry-worker.test.js`: "the real worker keeps the attempt counter through two script crashes ..." |
| C9 Compile rules; approval refuses carry | `packages/sdk/test/unit/workflow-carry-compiler.test.mjs`: "carry is an object template, not a scalar or array; terminals refuse it", "stored carry shape cannot bypass validation", "an approval state refuses carry at save, ..." |
| C10 Migration 0090 | `packages/sdk/test/local/workflow-migration-0090.test.js`: "0090 upgrades without changing existing input, preserves snapshots on rerun, and agrees with fresh install" |

### 5.3 Approval

| Requirement | Tests |
|---|---|
| A1 Compile shape, routes, 30-day limit, run-deadline warning | `packages/sdk/test/unit/workflow-approval.test.mjs`: "owner approval compiles a 48-hour interval ...", "approval requires ${missing}", "approval permits the 30-day limit and warns about a shorter whole-run deadline" |
| A2 Pinned context; atomic decision, audit, receipt, event; replay and conflict | `workflow-approval.test.js`: "pins context, atomically accepts audit/result/receipt/event, replays after deadline and conflicts on reuse"; "accepts exactly one of two competing answers and rolls back every decision write if the event fails" |
| A3 Pinned and current owner; non-users refused | `workflow-approval.test.js`: "requires the same person to be both the pinned owner and the current owner", "refuses stale context, nonowners and non-user actors without deciding" |
| A4 Agents and MCP cannot answer | `workflow-approval.test.mjs`: "person dispatch refuses agent provenance and sends its wake only after the decision commits"; `packages/app/web/test/workflow-approval-mcp.test.mjs`: "generic MCP Workflow commands cannot forward a person's consent, in either provenance mode" |
| A5 Deadline: equality loses; one clock; run cutoff; stop and delete | `workflow-approval.test.js`: "deadline equality loses, and timeout/answer share the row lock and one clock", "serializes an answer against its deadline without two results", "uses the earlier run cutoff and refuses new answers after stop or deletion" |
| A6 Ownerless or agent-subtree admission fails visibly | `workflow-approval.test.js`: "ownerless or agent-subtree admission fails visibly: ..." |
| A7 Lost wake, pause, continue-as-new | `workflow-approval-controller.test.mjs`: "a lost approval wake is collected at the short backstop ...", "a decision seen while paused is re-read and routed once on resume", "continue-as-new preserves the visit ...", "the approval deadline uses its new activity, including a decided row whose wake was lost" |
| A8 Test mode: fixtures only, virtual time | `workflow-approval.test.js`: "expires a simulated %i-second approval on virtual time, with no live consent audit"; `workflow-approval-controller.test.mjs`: "the registered deadline activity never treats a virtual approval as live consent", "test mode creates an approval interception ..."; `workflow-approval.test.mjs`: "approval fixtures are visibly mocked and validate rejection reasons" |
| A9 Reads and person commands | `workflow-approval.test.js`: "keeps an old open approval readable outside the history page and in its detail", "renders real approval dates as portable UTC ISO ..."; `packages/app/web/test/workflow-command-runtime.test.mjs`: "approval reads distinguish owner consent from admin management and shared writing" |
| A10 Answer inside a parallel branch whose branch has closed | GAP |
| A11 Migration 0091 | `packages/sdk/test/local/workflow-migration-0091.test.js`: "upgrades the old interception CHECK, reruns, and matches fresh creation (prior ordinal ...)" |

### 5.4 Waits, wake-ups and schedules

| Requirement | Tests |
|---|---|
| W1 Wait bounds, other bounds unchanged, warnings | `packages/sdk/test/unit/workflow-long-agent-compiler.test.mjs`: all six "FB-018: ..." tests |
| W2 Bound waits at 86,401 and 2,592,000; 2,592,001 refused | `packages/sdk/test/local/workflow-clock-wait.test.js`: "accepts bound waits at 86401 and 2592000 seconds and refuses 2592001 on entry" |
| W3 30-day wait through pause | `workflow-clock-wait.test.js`: "keeps a 30-day wait deadline through pause, elapses while paused, and resumes only its successor" |
| W4 A 1.0.0 run accepts a long bound wait | GAP (W2 runs at the current controller) |
| W5 Wake-ups refused at the visit deadline | `packages/sdk/test/local/workflow-agent-scheduling.test.js`: "%s refuses at the deadline before queuing a wake", "%s accepts a first wake inside the deadline", "%s leaves ordinary sessions unchanged", "%s does not schedule when the deadline read fails" |
| W6 Schedule reset at visit boundaries | `packages/sdk/test/local/workflow-continued-schedule.test.js`: the "FB-026: ..." suite, including "a turn end reported stopped keeps the fenced turn's cancellation" and "an inherited turn inside the same open visit does not clear its schedule" |

### 5.5 Save and Start

| Requirement | Tests |
|---|---|
| S1 Syntax checked as ES modules, with line and column | `packages/sdk/test/unit/workflow-script-analysis.test.mjs`: "FB-016: each script is checked as a Node ES module without executing it", "FB-016: syntax diagnostics retain the original script line and column", "FB-016: invalid script sources in parallel bodies report their state too" |
| S2 Deep nesting is unchecked, not a syntax error | `workflow-script-analysis.test.mjs`: "deep source reports analysis limits, not an internal error or an invented syntax failure" |
| S3 acorn pin is exact | GAP: no test asserts the version; S2 fails if a newer acorn reports deep nesting as a syntax error |
| S4 Concurrency warning and refusal text | `workflow-script-analysis.test.mjs`: "FB-017: recognizable Promise combinators warn ..."; `packages/sdk/test/unit/workflow-tool-executor.test.mjs`: "FB-017: concurrent calls refuse with an actionable hint; ..." |
| S5 Literal tools checked at Save and Start | `packages/sdk/test/unit/workflow-tool-requirements.test.mjs`: the "FB-009: ..." tests; `packages/sdk/test/local/workflow-start-tool-requirements.test.js`: "warns at Save/read, refuses before a claim, and starts once the literal tool is granted", "refuses a literal control tool inside try/catch before creating or dispatching a Workflow", "FB-016/017: Save/read show script errors and concurrency warnings before Start" |
| S6 Canvas tools refused | `packages/sdk/test/unit/workflow-canvas-tool-policy.test.mjs`: both tests; `workflow-tool-requirements.test.mjs`: "FB-014: ..."; `workflow-start-tool-requirements.test.js`: "a canvas call refuses even an old grant, while dynamic names return a visible warning"; `workflow-tool-executor.test.mjs`: "FB-014: ..." |
| S7 No grant: script revision refused, wait-only starts | `packages/sdk/test/local/workflow-start-tool-grant.test.js`: "on a real worker: a script revision is refused and nothing is started; a wait-only revision starts", "on the store: refused before anything is written, ..." |
| S8 A system session cannot start a script revision | GAP |
| S9 Start key | `packages/sdk/test/unit/workflow-start-key.test.mjs`: both tests; `packages/sdk/test/local/workflow-start-key.test.js`: all four tests |
| T1 Required tools per visit; startup tool on the first turn only | `packages/sdk/test/local/workflow-agent-required-tools.test.js`: "refuses early outcomes, persists the refusal, and accepts after both exact calls in each visit"; `packages/sdk/test/local/workflow-agent-required-tools-worker.test.js`: "counts an errored package call and exact delegated MCP call anew on both continued visits"; `packages/sdk/test/local/workflow-agent-initial-tool.test.js`: "uses the real turn-control watermark, not the first completed turn's zero-based iteration". The full matrix is in [tool-composition.md section 7](tool-composition.md#7-test-specification) |

### 5.6 Package checks, deadlock, parent fence


| Requirement | Tests |
|---|---|
| P1 Budget, retry only checks, no poisoning | `packages/sdk/test/unit/workflow-package-pins.test.mjs`: "temporary check retries stop at the budget and never retry effects or authority failures", "a completed package check cannot poison later asynchronous-resource callbacks", "registry, identity and download faults are retries, never inferred loss" |
| P2 Pooled CLI isolation | `packages/sdk/test/local/workflow-tool-pins-authority.test.js`: "a fresh pooled CLI does not retain an expired package-call budget" |
| P3 Retry inside one script call; typed failure channel | `packages/sdk/test/local/workflow-script-runner.test.js`: "retries/stores temporary registry failure inside a single script call", "stores a host package refusal only for a failing exit, ...", "does not blame a caught package refusal ...", "ignores an invented failure identity ...", "bounds the plain failure pipe and exposes no IPC handle channel" |
| P4 Lost package stops only its tools | `packages/sdk/test/local/workflow-tool-package-pins.test.js`: "%s preserves the fixed grant except the lost package" (13 cases) |
| P5 Provider scoping | `workflow-package-pins.test.mjs`: "${provider} attribution ignores an unselected ${scope} package with colliding exports" |
| P6 Handler identity across reload | `packages/sdk/test/local/capability-tool-registry-reload.test.js`: "%s: %s: %s" (unchanged tool across a real registry watcher reload, and three refusal cases) |
| D1 Deadlock cycle exists; `acceptInput` recovers | `packages/sdk/test/local/workflow-three-session-deadlock.test.js`: "forces A -> W1 -> X -> A ..." (shows the defect); `packages/sdk/test/local/workflow-input-deadlock-retry.test.js`: "acceptInput is made the victim and still commits" |
| F1 Parent re-check | `packages/sdk/test/local/workflow-command-parent-fence.test.js`: both tests |

### 5.7 Retention, provenance, pause

| Requirement | Tests |
|---|---|
| R1 Finished Workflows are kept | `packages/sdk/test/local/sweeper-cleanup-guard.test.js`: "Workflow results stay after completion and controller pruning, even with zero grace", "all runs ended: saved results are retained for every controller status", "an ended test bench and its saved results are retained" |
| R2 Ancestor deletion still removes them | `sweeper-cleanup-guard.test.js`: "a finished owner session's cleanup removes its Workflow sessions with it"; `packages/sdk/test/local/workflow-sweeper-recover.test.js`: "every Sweeper pass preserves Workflow rows and recovery; ..." |
| M1 `definition.source` names the saved revision and does not move | `packages/sdk/test/local/workflow-session-definitions.test.js`: "revisions with author and base; ... start pins a revision ..." |
| Z1 Pause and resume wake the controller | `packages/sdk/test/unit/workflow-pause-wake.test.mjs`: "${WORKFLOW_CONTROLLER_VERSION}: pause and resume reach the waiting controller before any backstop timer fires", "accepted retries resend the hint; ...", "a failed wake surfaces its error after durable acceptance; ..." |
| Z2 A not-begun run gets no message | Existing, unchanged: `packages/sdk/test/local/workflow-control.test.js`: "starts a run paused before it began as paused, ..."; `packages/sdk/test/local/workflow-session-commands.test.js`: "ends or deletes a child whose run has not begun in the store, ..." |

### 5.8 Formal models

Both models are design models bound to commit `004eff4e` by their correspondence files. The carry, approval, controller-feature and migration source files have no changes between `004eff4e` and `77109baf`. The results below are the recorded runs; this document did not re-run TLC.

| Model | Proves | Cases | Recorded result |
|---|---|---|---|
| [`WorkflowCarry.tla`](../../formal/workflow/carry/README.md) | Snapshot immutability, carry equals admission, no sibling carry, carry on error, no effect before admission, failed carry starts no effect, legacy shape, `Inv_GateHolds` at 1.0.0, progress | 17 ([`cases.tsv`](../../formal/workflow/carry/cases.tsv)): 15 in batch ca1, 2 in ca2 | 17 of 17 as expected; `fault.ca2-gate-ignored` violates `Inv_GateHolds` |
| [`WorkflowApproval.tla`](../../formal/workflow/approval/README.md) | One decision, only the pinned owner, no acceptance at or after the deadline, no start while paused, route once, fresh consent on changed context, stable receipts, audit agreement, no answer after stop, `Inv_GateHolds`, stop ends, settles and routes | 35 ([`cases.tsv`](../../formal/workflow/approval/cases.tsv)): 18 in ap1, 17 in ap2 | ap4: 35 of 35 as expected |

Not modelled: payload sizes, the parallel state's outer carry, more than one approval state, the UI, refused-attempt audit records and clock skew.

## 6. Known limitations and open items

1. **Stop-all is the only guard against a mixed fleet.** The IR version does not change, and no worker checks another worker's release. An old worker beside a new one silently drops `grant` and `requiredTools`.
2. **Rollback is not tested.** The CHANGELOG describes only how 0.8.11 treats `grant` and `requiredTools`. Runs admitted at controller 1.1.0 and sessions at 1.0.84 have no handler on 0.8.11; this document could not verify what happens to them.
3. **Carry preserves entry data only.** It does not keep changes made inside a crashing script and does not make a retry of an uncertain write safe. Reads do not show the snapshot.
4. **Approval is single-approver.** Only the owner; no delegation, no transfer on an ownership change, and no carry on the approval state. An approval inside a Workflow agent's subtree, or in a Workflow without an authenticated owner, always fails `forbidden`. Refused answers write no audit record.
5. **The wake-up limit covers direct agent children only.** A descendant's `cron` is not checked against the visit deadline.
6. **Script analysis is syntactic.** Dynamic tool names are checked only at run time. Deeply nested scripts are not analyzed. acorn stays pinned to 8.16.0 until the analysis handles the 8.19 error; that work is tracked separately.
7. **Three paths have no tests:** a system session's refused Start (S8), an answer inside a closed parallel branch (A10) and a long bound wait in a 1.0.0 run (W4).
8. **Retention has no automatic cap.** Finished Workflows stay until explicit or ancestor deletion, so storage grows with use.
9. **The deadlock retry covers `acceptInput` only.** Other transactions in a cycle rely on their existing retries.
10. **Formal README wording is stale.** Both READMEs still say "no implementation exists yet", and the carry README says "nullable JSONB" where the code uses TEXT (the correspondence file records the TEXT change).
11. **Real-source upgrade tests are env-gated.** `session-real-source-upgrade.test.js` and `workflow-real-source-upgrade.test.js` run only when the `PS_UPGRADE_*` source roots are set.
