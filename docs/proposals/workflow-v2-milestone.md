# Workflow v2 milestone: implementation notes (inactive)

Status: **inactive**. Everything in this note runs only on controller 1.9.0
and the orchestrations it starts, which only tests register (the worker
option `workflowRequests`) and only a test host starts runs at
(`WorkflowV2Host.requests`). Production workers keep controller 1.8.0, its
activities and its tool surface unchanged. Nothing here is an activation, a
deployment or a qualification result.

The approved design is the execution package of 31 October 2026 (documents
01 to 11, requirements R01 to R28). Request states have their own design
note, [workflow-messaging-request.md](workflow-messaging-request.md). This
note records how the other milestone features are implemented and where the
implementation is narrower than the design.

## Graceful stop (design 02 run lifecycle, D03)

`update_workflow` operation `stop` (run id optional, `reason` optional,
`grace_seconds` 0 to 3600, default 60):

1. The store accepts the stop once per operation id
   (`WorkflowStore.requestRunStop`, migration 0096). One reading of the
   store's clock is the stop's time; the deadline is that reading plus the
   grace. A repeat returns the receipt; another stop of a stopping run is
   `RUN_ALREADY_STOPPING`.
2. Only a run admitted for a controller that stops is accepted. Each run
   now records the controller version its admission chose
   (`workflow_runs.controller_version`). Runs admitted for 1.8.0, and runs
   admitted before migration 0096, are refused with `RUN_STOP_UNSUPPORTED`;
   cancel still applies to them.
3. A stopping run admits no new node execution, paused or not
   (`enterNode` refuses `stopping`). Pause and resume refuse it
   (`RUN_STOPPING`). A cancel, a deletion and KV updates still apply, and
   the first run end stands.
4. Controller 1.9.0 learns of the stop from a refused admission or from its
   collection (which reports the stop's deadline after the results), and
   from then on routes no result: work it admitted settles and keeps its
   result, and no successor, catch-all state or unhandled-route failure
   follows from it.
5. When no work is pending, or at the deadline by the store's clock, the
   stop activity ends the run `stopped` (`finishStoppedRun`). Work still
   pending at the deadline is cancelled with winner `stop`; the effect of
   each such script is asked to stop (`workflow.cancel_requested`, `stop:
   true`), and a running script's liveness check stops it too. The run's
   terminal error records the stop: code `stopped`, its reason, actor and
   grace, whether the grace expired, and the node executions it cancelled.
6. The parent is told as for any other end. The session row shows
   `cancelled` (session statuses have no `stopped`); the run status is
   `stopped`, and `read_workflow` shows the stop with `settled` while the
   run is active.

Wait, receive and request states are work like any other here: a wait that
elapses within the grace settles, and one that does not is cancelled at the
deadline.

The tool takes `stop` only on a host that starts runs at 1.9.0; elsewhere it
is refused as an unknown operation, exactly as before. The tool's published
description and parameter enum are unchanged.

Not yet covered: the UI read model's `stopped` label, REST/MCP parity and
the formal lifecycle model's stop transitions.

## Agent states (design 03 agent node; R09 to R11, R14, R15, R23)

A state of `type: agent` runs an ordinary child agent session and is
finished only by that child's typed completion, raced against an outer
deadline. It compiles to IR 8 only when agent states are enabled (the
compile option `enableAgents`, set with `enableRequests` by a host that
starts 1.9.0 runs); elsewhere it stays unsupported, exactly as before. A
reader takes IR 8 only when asked to (`WORKFLOW_V2_MILESTONE_IR_VERSION`).

```yaml
review:
  type: agent
  invoke: { prompt: "Review this exact change. Do not edit source." }
  # or: invoke: { agent: { name: code-reviewer, package: review-kit, version: "1.2.0" } }
  inputSchema: { $ref: "#/schemas/ReviewInput" }
  outputSchema: { $ref: "#/schemas/ReviewResult" }
  timeoutSeconds: 900
  transition: { next: { accepted: done, changes_required: rework, needs_input: ask, timed_out: blocked, failure: failed } }
```

- **Task.** Exactly one of an inline `prompt` (at most 32 KiB) or a named
  `agent`. A package `version` needs its `package`. A package's
  `workflowInterface` is not supported yet: the state's own `inputSchema`
  and `outputSchema` are its contract.
- **Outcomes.** Declared with `outcomes`, or by default the state's routes
  that are not runtime routes. The agent may also report `needs_input` or
  `execution_failed`; every other runtime code (`timed_out`, `unavailable`,
  `forbidden`, `invalid_output`, `cancelled`) is decided by the workflow.
- **Admission.** The input is checked against `inputSchema`. The deadline
  is the admission's store-clock reading plus `timeoutSeconds` (a literal or
  one binding, checked on entry). The invocation record (migration 0097)
  freezes the child's session id (a UUID derived from the node execution,
  so a retry names the same session and a later occurrence another), the
  controlling parent agent (the workflow's parent), the task, the outcomes
  and the output schema.
- **The child.** The agent orchestration (`workflow-v2-agent` 1.0.0) asks the
  worker's agent host to create the child and send it one first prompt,
  the host-generated wrapper (`workflowAgentPrompt`), with a stable client
  message id, as the workflow (never as a human). The same wrapper serves
  an inline prompt and a named agent: how to finish the state, the
  validated input, the schemas, the outcomes, the deadline, the controlling
  parent agent, that humans cannot prompt it, then the task. The host
  (`agent-host.ts`) creates the child under the workflow, one level below
  it, at most level 3 (D02), owned as any spawned child is, with the
  controlling agent's model; a named agent is bound to the definition its
  owner sees, with that definition's own tools only. A refusal (unknown,
  system, mismatched pin, too deep) fails the state `unavailable` or
  `forbidden`; a worker without a host fails it `unavailable`.
- **Completion.** `complete_workflow_node` is given only to an agent state's
  child. The caller is the host-stamped session, never an argument. One
  transaction: the call's shape, the operation id (the same id and result
  replays its answer; another result is `OPERATION_CONFLICT`), the store's
  one clock reading against the deadline (durable expiry: once an operation
  was refused `NODE_EXPIRED`, every later one is too), then the contract.
  Field errors leave the state pending (`OUTPUT_INVALID`, with
  `attemptsLeft`); the third invalid completion fails it `invalid_output`.
  A valid one decides the state (winner `agent`) and wakes the controller.
  Final chat text never completes a state.
- **Deadline and end.** Only the controller's elapse decides `timed_out`.
  When the controller collects an agent state's result it ends the child:
  `done` after the agent's own completion, `cancel` after anything else.
  When the run ends (any end), the children of its decided agent states
  are ended too. The end is recorded once and sent while the child's
  session runs; a spawn that created the child after the end found no
  session sends it again.
- **Child chat (R23).** `read_workflow` shows each agent state's
  `agent.childSessionId`, the session a click on the state opens, and its
  lifecycle (spawned, end, end sent).

Not yet covered here: human-input denial and the depth allowance for the
node agent's own child (B5), the UI read model and click-through (B9), a
real-model run of an agent state, and package workflow interfaces.

## Human input and depth in an agent state's subtree (design 03; R12 to R14, R16)

A session is in an agent state's subtree when it, or one of its ancestors,
is an agent state's child. The store decides this from its own rows
(`readWorkflowLineage`: one recursive read of the session rows, deleted rows
included, joined to the agent states' immutable invocation records), never
from a caller's claim. Only controller 1.9.0 creates agent states' children,
so outside its tests no session is in such a subtree and nothing below
changes a session's behavior.

- **Human input is refused at the SDK chokepoints.** Every transport reaches
  them: the portal (through its transport), and the TUI and MCP direct modes.
  A person's prompt (the client session's send, which also carries canvas
  actions, and the management client's `sendMessage`), answer, steer, custom
  session event, canvas KV write and workspace command (`setSessionWorkspace`,
  `retrySessionWorkspace`) to such a session fails with 403
  `WORKFLOW_HUMAN_INPUT_DENIED` before anything is queued or started. The
  error names the workflow and its controlling parent agent. Input that the
  host stamps as an agent's (`sender.kind: "agent"`; the portal stamps every
  caller as a user and overwrites a client's claim) is not human input.
  Reading the session and its artifacts, and the workflow's own lifecycle
  controls, are unchanged.
- **Clients are told.** `getSessionAccess` adds `canSendPrompt`, `canAnswer`
  and `canSteer` (false) with the workflow and its controlling agent for
  such a session, separately from `canWrite`. The management client's
  `getWorkflowInputPolicy` gives the same answer.
- **The controlling parent agent may message it.** `message_agent` reaches,
  besides the caller's own sub-agents, a session in the subtree of an agent
  state whose controlling parent agent (recorded at admission) is the
  caller. The message is stamped as that agent's. `contract_patch` applies
  to own sub-agents only.
- **ask_user is refused** there with guidance: consult the controlling parent
  agent, or complete the state with `needs_input`. No input-required state
  is opened.
- **Depth.** In such a subtree, spawn_agent counts the stored level and allows
  level 3 (parent 0, workflow 1, node agent 2, its child 3); elsewhere the
  ordinary limit (2) and the session's own nesting level apply, as before.

These turn-side rules (the ask_user refusal, the depth allowance and the
`message_agent` route) apply on a turn of a worker that runs agent states
(the test-only switch). The 1.0.83 orchestration's own spawn path, used only
by a turn without the inline control bridge, keeps the ordinary limit.

Not covered here: the UI's composer and controls (B9), and denying a
person's artifact upload into such a session (not in the design's list).

## Parallel states and their join (design 02 parallel scope and join; D10; R21)

A state of `type: parallel` runs one branch per item of a work manifest
through a body graph of its own, and joins them. It compiles to IR 8 only
when parallel states are enabled (the compile option `enableParallel`, set
by a host that starts 1.9.0 runs); elsewhere it stays unsupported, exactly
as before.

```yaml
review_changes:
  type: parallel
  forEach: "${inputs.changes}"   # one binding that gives a list, or a list
  concurrency: 6                 # 1 to 16 active branches; default 1
  join: all_required             # the only join of this release (D10)
  failFast: false                # default: every branch ends, then the join
  inputSchema: { $ref: "#/schemas/ChangeManifest" }   # the whole manifest
  outputSchema: { $ref: "#/schemas/AcceptedReviews" } # the joined outputs
  body:
    initial: review
    states: { ... }              # any state except another parallel state
  transition:
    next: { joined: integrate, blocked: report, failure: failed }
```

- **The manifest is frozen at entry.** `forEach` is evaluated once, when the
  state is admitted, and stored as the state's input: a list of at most 64
  items that matches `inputSchema`. A value that is not a list, too many
  items, or a schema mismatch fails the state with `invalid_input`.
  Membership never changes afterwards; KV updates do not reach it.
- **Branches.** Each item runs as a branch with its own scope
  (`<parallel node execution>#<index>`), cursor, occurrence counters, input,
  output and pending work. A branch starts at `body.initial` with its item
  as its input; its states see `branch.item` and `branch.index` in their
  bindings (scripts see `context.branch`). `branch` is refused outside a
  body. Body routes stay in the body. State ids are unique across the
  workflow, body states included.
- **Concurrency is a ceiling.** At most `concurrency` branches are active;
  the next item starts when one ends.
- **A branch ends** at a body terminal (its output, checked against the
  terminal's own schema, with the terminal's outcome; `succeeded` is
  success, any other outcome is not), or when a result has no route in the
  body (a runtime error or an undeclared outcome ends the branch; it never
  reaches the workflow's catch-all state or fails the run).
- **The join is all_required.** When every branch ended, the state's node
  is decided in one compare-and-swap: `joined` when every branch succeeded
  (its output is their outputs in manifest order, checked against
  `outputSchema`; a mismatch is `invalid_output`), otherwise `blocked`. A
  blocked join's output lists every branch in manifest order: how it ended
  (`terminal`, `error`, `cancelled`, `not_started`), the node execution that
  ended it, its outcome and its output or error. No failed branch is
  silently excluded. An empty manifest joins at once with `[]`.
- **failFast.** Off by default: every branch ends before the join. With
  `failFast: true`, the first branch that does not succeed cancels the
  others: their pending states are decided `cancelled` with winner
  `fail_fast` (`cancelBranchScopes`, one transaction), the effect of each
  such script is asked to stop, the child of each such agent state is ended,
  and the items not started are reported `not_started`.
- **Lifecycle.** A cancel, deletion or stop of the run decides the pending
  parallel state with its branches' pending work. A parallel state's own
  pending node is not work: it neither holds a stop past its branches'
  settling nor counts as an expired grace, and `read_workflow`'s `settled`
  ignores it.
- **Reading.** `read_workflow`'s graph marks each body state with its
  `parallel` state; a branch's node execution shows its `scopeId` and
  `branch` (parallel node execution and index); a parallel node execution
  shows its number of `branches`.

Not covered here: explicit `join` states, quorum or any-of joins (refused,
D10), per-branch attempt/head/round identity (a definition carries that in
its items and outputs), the UI's branch view (B9) and the formal model of
the join.

## Test runs: intercepted tools, mocked agents and a virtual clock (design 05; R19, R20, R28)

A test run executes the exact current revision of a definition, draft or
published, with its scripts running normally and every framework effect
intercepted. It runs at controller 1.9.0 under its own controller instance
(`wft-<run id>`), with its own KV, inbox and outbox, beside the live run,
which it never changes. Any number of test runs may exist. Migration 0098
adds the run's virtual clock and fixtures and the interception records.

`update_workflow` operations (taken only by a host that starts 1.9.0 runs;
the tool's published description and operation enum are unchanged):

| Operation | Arguments | Effect |
|---|---|---|
| `test` | `expected_revision`, `definition_hash`, `inputs`, optional `vars`, `agent_mode` (`mocked`, the default), `fixtures` | Starts a test run of exactly that revision. `agent_mode: real` is refused (`TEST_AGENT_MODE_UNSUPPORTED`). |
| `test_respond` | `run_id`, `interception_id`, `response: { kind: success \| error \| cancel, value }` | Answers one intercepted effect, once. |
| `test_advance` | `run_id`, `seconds` (1 to 30 days) | Moves the run's virtual clock and decides what became due. |

- **Scripts run normally.** Their direct effects (network, files,
  processes, the clock, randomness) are real; a test run is not a sandbox,
  and `read_workflow` shows a permanent notice saying so. `context.mode`
  is `test`.
- **Tool calls are intercepted.** A script's n-th tool call becomes the
  interception `<node execution>/call-<n>`. The tool grant still decides
  which tools a script may call (`admittedWorkflowToolGrant`), and the live
  tool executor never opens: there is no live fallback. A fixture that
  names the tool and the exact hash of the arguments' canonical JSON
  answers the call at once; otherwise the parent is told (a system message
  with a stable client message id) and the script waits for the answer,
  within its own timeout. A retried attempt that reaches the same call
  with the same arguments gets the same answer; with other arguments it
  fails (`mismatch`), never answered from the earlier call.
- **Agent, send and request states are intercepted.** No child session is
  created, no message is delivered, and no request exchange starts; the
  interception (`<node execution>/agent`, `/send`, `/request`) records
  what the live effect would have used: the agent's input, task, outcomes
  and output schema; the message's recipient, contract, correlation and
  payload. The answer decides the state as the live effect would: an
  agent's `{ outcome, output }` must name one of its outcomes and match its
  output schema; a request's `{ response }` must match the contract's
  response schema, or `{ decline: { reason } }`; a send's success is
  `sent`; an error needs a runtime error code; a cancel is `cancelled`. The
  winner is `test`. A fixture for an agent, send or request names the
  state and the exact hash of its input or message.
- **Answers.** An invalid answer is refused with its field errors and the
  effect stays open. The same answer again is idempotent; a different one
  is `TEST_RESPONSE_CONFLICT`. An answer to an effect whose state was
  decided otherwise, or of a run that ended, is refused. The answer path
  is out of band: it is never itself intercepted.
- **The virtual clock.** A test run's clock starts at 9000-01-01T00:00:00Z,
  after any real time, so no decision by the store's clock ever finds a
  test run's deadline due. Every deadline of a test run (a wait, a
  receive's wait, a request's and an agent state's timeout) is counted
  from it. `test_advance` moves it monotonically, once per operation id,
  and in the same transaction decides what became due, in deadline order:
  a wait or a receive's wait elapses, a request or an agent state times
  out. A result that won first (typed input, an answer, a cancel) stands.
  Real time never races a virtual deadline. Typed input to a test run's
  receive (`send_workflow_input` with its `run_id`) is taken while the
  receive waits, so a message before the virtual deadline wins and one
  after it stays unclaimed.
- **Evidence.** `read_workflow` for a test run (`run_id`) shows the notice,
  its agent mode, the tested revision and whether a newer revision makes
  it stale, the virtual clock, every interception with its arguments, the
  schema an answer must match and its answer (kind, disposition, value,
  hash), and the coverage: the states entered and not entered, the routes
  taken, the outcomes seen, and the interceptions still unanswered. The
  run row keeps the revision and hashes, inputs and every KV revision.

Deviations and gaps: `agent_mode: real` (a real agent child whose tools
are intercepted, with the test context inherited by its descendants) is not
available; typed input's expiry (`ttl_seconds`) runs on real time; a test
run's interceptions are not deleted by any retention policy yet (B11); the
UI's test panel and mock editor are B9.
