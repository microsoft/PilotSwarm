# Workflow v2 milestone: implementation notes (inactive)

Status: **inactive**. Everything in this note runs only on controller 1.9.0
and the orchestrations it starts, which only tests register (the worker
option `workflowRequests`) and only a test host starts runs at
(`WorkflowV2Host.requests`). Production workers keep controller 1.8.0, its
activities and its tool surface unchanged. One exception applies on every
worker: the names of the two workflow turn tools are reserved, so packages
and capabilities cannot export them ("The agent tools on a turn of a 1.9.0
worker" below). Nothing here is an activation, a deployment or a
qualification result.

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

Human-input denial and the depth allowance for the node agent's own child
(B5) and the UI read model and click-through (B9) have their own sections
below; so do package workflow interfaces ("Package workflow interfaces"). A
worker created with the test-only option
`testOptions.workflowRequests` runs agent states with its own agent host
("A worker that runs the milestone" below); an agent state has run there
with a scripted model, not yet with a live provider.

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
| `test` | `expected_revision`, `definition_hash`, `inputs`, optional `vars`, `agent_mode` (`mocked`, the default, or `real`), `fixtures` | Starts a test run of exactly that revision. |
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
- **Agent, send and request states are intercepted** (an agent state only
  in agent mode `mocked`; see "Real agents" below). No child session is
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

**Real agents (`agent_mode: real`; R19, R20, D08, T112).** A real-agent
test checks how a real agent behaves against mocked tools. It spends model
tokens, and its results vary as a model's do; mocked mode stays the
default.

- **Ordinary child sessions.** Each agent state gets its child as a live
  run's does (the agent orchestration and `agent-host.ts`): the same owner,
  depth limit, model, wrapper prompt and stable id, and the same refusals:
  an agent the workflow's owner cannot see is `unavailable`, a
  worker-managed system agent `forbidden`. Its deadline is on the run's
  virtual clock (the wrapper shows it), so only `test_advance` times it
  out. When the state is decided, or the run ends, the child is ended as a
  live run's is (`done` after its typed completion, `cancel` otherwise).
  The child completes the state with `complete_workflow_node`, checked as
  in a live run. A worker without an agent host fails the state
  `unavailable`; nothing is answered for it.
- **Pinned identity (R18).** The test pins its named agents when it is
  admitted (migration 0101, `workflow_runs.test_agent_pins`): a test of the
  published revision takes the publication's pins; a test of a draft is
  pinned as its publication would be, so an agent the publication could
  not pin (unavailable, a system agent, another package or version)
  refuses the test with `AGENT_UNAVAILABLE` before anything is written. A
  pin with a package revision runs that exact revision. A repeated test
  operation returns its receipt and pins nothing again. The hosts that run
  controller 1.9.0 pin with the agent registry ("Publication pins" below);
  a host without an agent resolver pins nothing, and the child is then
  bound by name when it is created, by the same visibility rules.
- **Framework tools are intercepted.** In every turn of the child, and of
  any session in its subtree, each framework tool call (a worker or
  package tool, a system tool such as `wait`, `cron`, `cron_at` or
  `spawn_agent`, a workflow tool) becomes the interception
  `<agent node execution>/call-<n>` instead of running
  (`test-agent-tools.ts`, `WorkflowStore.interceptAgentToolCall`). A
  `tool.call` fixture (the tool and the exact hash of the arguments)
  answers it at once; otherwise the parent is told and the call waits for
  the parent's answer for at most 3 minutes (a silent turn ends after 5),
  then fails without running. The answer is the tool's result: a success
  value, or an error. A call after the state was decided or the run ended
  is refused. Every call counts toward the run's limit of 1,000
  intercepted effects (`TEST_INTERCEPTION_LIMIT`), which bounds what a real
  agent can do in one test. Not intercepted: `complete_workflow_node` (the
  state's completion) and `ask_user`, which is refused as in a live run
  (R14). The model's own built-in tools (shell, files) are not framework
  calls: they run normally, as a script's direct effects do. MCP tools
  cannot be intercepted, so they are refused for such a session; none runs
  live. The test mode never adds a package, agent or tool that a live run
  would not have.
- **Fail closed.** On a worker that runs agent states, a session's lineage
  (and, under an agent state, its test run) is read before its turn; a
  read that fails fails the turn, which is retried, so a session in an
  agent state's subtree never runs without its human-input denial or,
  under a test, with live tools.
- **Evidence.** `read_workflow` labels the run `agentMode: real`, adds a
  notice that its agents are real and spend model tokens, and shows the
  agent pins. Each intercepted call is listed with the agent state it
  belongs to (`operation: tool.call`, `stateId` of the agent state), and
  `workflow.test_intercepted` events name the calling session.
- **Retention.** A real-agent test run keeps its agent states' invocation
  records, as a live run does (its children's denial and depth are read
  from them), so test-run retention never deletes it.

Deviations still open: typed input's expiry (`ttl_seconds`) runs on real
time. A tool call the parent answers after its wait ended is recorded and
changes nothing. Deployed enablement is an activation decision: the agent
host runs on a worker only behind a test-only option ("A worker that runs
the milestone" below).

**Retention (design 05 cleanup; D07 configurable defaults).** After each new
test admission, the workflow's ended test runs beyond the newest `keep`
(default 20) that ended at least `graceSeconds` ago (default 300) and whose
controller instance has finished are deleted, each in one transaction
(`WorkflowStore.pruneTestRun`): its interceptions, the typed input given to
it, its node executions, its KV revisions and its run row. A live run, an
active test run, a run within the grace, a run of a deleted workflow and a
run that owns a live record (an outbox message or a request, which a test
run never has, or an agent invocation, which a real-agent test run keeps)
are never deleted. Operation
receipts and the session's events stay as the audit trail
(`workflow.test_run_deleted`); a repeated test operation returns its
receipt and starts nothing. Retention is best effort: a failure is recorded
(`workflow.test_retention_failed`) and never refuses the admitted test. A
host sets other values with `WorkflowV2Host.testRetention`. Not deleted:
the finished controller orchestration's own history, which duroxide
keeps.

## Publication pins and test evidence (design 02 publication record, 03 package agents; R18, R28)

The draft and publication lifecycle (spawn a draft, replace it at an
expected revision under the one-semver rule, publish an exact revision and
hash, start one live run) was already in place. This milestone adds what
binds a publication and a test to the exact versions they used
(migration 0099):

- **Agent pins.** On a host that resolves agents (`WorkflowV2Host.resolveAgent`:
  the hosts that run controller 1.9.0, below), publication resolves every
  agent state that names an agent, for the workflow's parent, as its child
  would be bound. An agent
  that is missing, a worker-managed system agent, or not at the package or
  version the state names refuses the publication with `AGENT_UNAVAILABLE`
  and nothing is published (a definition created as published refuses
  before anything is written). Otherwise each pin (agent, package, package
  version, package id) is frozen with the publication
  (`workflow_definitions.published_agent_pins`), and `read_workflow` shows
  `publishedAgentPins`. An inline prompt is not pinned.
- **Live runs bind to the pins.** A run of the published revision (a live
  run, or a test run of that revision: design 05 pins a test as a live run)
  asks for the pinned package and version even when the definition names
  no version, so a package republished after publication is never picked
  up silently, and a new workflow child published later pins the new
  version explicitly.
- **A pinned revision keeps running after a republish (R18, T070).** When
  the agent resolver reports the content hash of the package version it
  resolved (`packageRevision`), publication pins it with the package id
  (`revision`), and the run's agent state asks for exactly that revision.
  The agent host binds the child to it (`<packageId>@<sha256>`,
  `agent-package-pins.ts`) whatever version the package is at now, as long
  as the workflow's owner still sees the agent in that same package
  (another package by that name, a disabled package or revoked access
  fails the state `unavailable`). The worker that runs the child's turn
  installs that exact version from the registry beside the active one, in
  a cache of its own (`PilotSwarmWorker.ensurePinnedAgentPackageRevision`),
  and serves it only to sessions bound to that id: the child gets that
  version's prompt, its own skills composed in, its own tool handlers and
  MCP servers. Nobody else sees it: it is no one's default copy, discovery
  and name resolution skip it, and it adds nothing to the shared skill
  catalog, the flat tool registry or the capability sources. The read view
  shows the revision on the agent state's task. A publication made before
  revisions were pinned keeps the earlier rule (its run is refused once its
  version is gone).
- **Resolution from the agent registry (`agent-resolver.ts`).** The hosts
  that run controller 1.9.0 resolve with it: a worker's turn with the
  test option `workflowRequests` (its `update_workflow` and
  `spawn_workflow` tools) and a management client created with
  `workflowCommands.requests` (a person's `updateWorkflow` from the portal,
  the Web API, MCP or the TUI). Other hosts set no resolver and pin
  nothing, as before. The name goes through `spawn_agent`'s own rule
  (`resolveAgentDefinitionForCaller`: owner privacy and the owner's own
  copy first, with the owner from the caller's lineage) over the
  registry's enabled packages at their active versions
  (`getAgentPackagesInstallManifest`), so a package agent's version and
  exact revision (the content hash of that version) come from the
  registry, never from a worker's installed copy, which can lag a
  republish. A state that names a package resolves among that package's
  agents only, so another package's agent of the same name never takes
  its place; the agent host asks the same way when it creates the child.
  A worker also resolves its own deployment agents and system agents by
  name, in a worker's order (deployment agents, then the registry's
  packages). A management client knows the registry only: a deployment
  agent's name refuses a person's publication with `AGENT_UNAVAILABLE`
  (`registryOnly`), saying that such a workflow is published by its parent
  agent. A registry that cannot be read refuses the publication with
  `AGENT_UNAVAILABLE` (`retryable`) before anything is written, without the
  failure's own text; the same request may then be sent again.
- **Test scenario labels.** `update_workflow` operation `test` takes an
  optional `scenario` name, kept with the test run
  (`workflow_runs.test_scenario`) and shown by `read_workflow` beside the
  tested revision and the stale flag. Test results, publication receipts
  and pins stay separate records; a test never stands in for publication.

Still open (not waived): a worker builds its agent host (the same
resolver, so a run binds what its publication pinned) only behind the
test-only option `testOptions.workflowRequests` ("A worker that runs the
milestone" below); no deployment sets it. The full worker test
(`workflow-v2-agent-worker.test.js`, the model scripted) runs a child bound
to an exact earlier package revision end to end on such a worker: the
publication pins the package's revision, the package is republished, the
run's child is bound to `<packageId>@<sha256>`, the worker installs that
revision for it beside the active one, and the child's real turn runs that
revision's prompt and completes the state; a later publication pins the new
revision and its run's child runs that one, while the first publication
keeps its pin and everyone else keeps the active version. A person's
publication pins package agents only (the management client does not see a
worker's deployment agents). A real-agent test run of a draft
revision is pinned when it is admitted, as its publication would be
(migration 0101; see "Real agents" above). A package agent's workflow
interface is matched and its digest pinned too ("Package workflow
interfaces" below). Not covered: a publication gate on declared test
scenarios (not in the YAML design).

## Package workflow interfaces (design 04 package-agent I/O export, 03, 09; R09, T011, T071, M17)

INACTIVE in effect: only Workflow V2 publication reads an interface, and
only the hosts that run controller 1.9.0 publish agent states. The package
format support below is in the loader and the package validator of this
build.

- **Declaration (`agent-loader.ts`).** A package agent declares the
  interface in its front matter, at `schemaVersion: 5`:
  `workflowInterface:` with two-space-indented `name`, `version` (a quoted
  label such as `"1"`), `outputSchema`, optional `inputSchema` (package
  files, relative to the package root) and `outcomes` (an inline list or
  `- item` lines). The loader parses the mapping out of the front matter as
  it does `nativeTaskTools`; a malformed or duplicate entry fails the
  agent's parse, and the package validator names that reason. A
  declaration under schemaVersion 1 to 4 is refused
  (`workflow_interface_requires_schema_v5`). Version 5 keeps what 2 to 4
  declare (`nativeTaskTools` and `initialRequiredTool` are taken at 5 too).
  A worker that does not know version 5 skips the agent, as for every new
  schemaVersion; nothing is dropped silently.
- **Export (`package-interface.ts`, `agent-package-format.ts`).** The
  package validator reads each schema file from the tree that is packed
  (the staged tree of a manifest layout, so its files must be listed under
  `include`): a relative path inside the package (no `..`, absolute path,
  URL scheme, backslash, symbolic link or directory, and its real path
  inside the package), at most 64 KiB of JSON, a workflow JSON Schema
  (`normalizeSchema`'s rules) that stands alone (no `$ref`) and compiles
  (strict Ajv). The outcomes are 1 to 32 distinct labels that are not
  runtime routes. A problem is a validation error
  (`invalid_workflow_interface` for the declaration's fields,
  `workflow_interface_schema` for a file), so no package is published with
  it. The manifest entry of that agent gets `workflowInterface: { name,
  version, inputSchema (or null), outputSchema, outcomes, digest }`, where
  `digest` is the SHA-256 of the canonical JSON of the other five fields.
  An agent without an interface has no such field: other manifests are
  unchanged.
- **Registry.** The manifest is kept with each published version, so the
  interface of an exact package revision never changes. The agent resolver
  carries the export of the revision it resolves (`workflowInterface` on
  the definition), unchecked; publication checks it.
- **Workflow.** An agent state names the interface:
  `invoke.agent.interface: <name>@<version>` (for example
  `review_change@1`). It needs `package` and an `outputSchema`
  (`WORKFLOW_FIELD_INVALID`, `WORKFLOW_FIELD_REQUIRED`). IR 8 keeps it as
  `invoke.agent.interface: { name, version }` only when it is named, so
  every other IR and its hash are as before; the stored-IR reader takes it
  (with a package) and refuses any other shape. IR 8 has not been released,
  so this needs no new IR version. The read view's graph shows it on the
  state's `invoke` (`interface: "review_change@1"`).
- **Publication (`service.ts` `publicationAgentPins`).** After the agent is
  resolved and its package and version are checked, a state that names an
  interface is pinned only when the agent exports that interface at the
  resolved revision and the state's contract is exactly the interface's:
  the same outcome set, the same output schema (`schemaDefs` of the state's
  `outputSchema`, compared as canonical JSON), and the same input schema
  when the interface has one. Nothing is inferred: a stricter or a looser
  schema, or a workflow schema that refers to another one, does not match.
  Otherwise the publication is refused with `CONTRACT_MISMATCH` (409)
  before anything is written; its details are the state, agent, package,
  named version, interface, the resolved package version and every
  problem (an agent that exports no interface, another name or version, a
  record whose digest does not match, the outcomes, either schema). A match
  adds `interface: { name, version, digest }` to the state's pin, beside the
  package id and exact revision. A real-agent test of a draft is pinned
  the same way, so it is refused the same way. A host that does not
  resolve agents refuses a state that names an interface
  (`AGENT_UNAVAILABLE`), since it cannot check it.
- **Runtime.** Unchanged: the run binds the child to the pinned revision
  (R18), whose interface cannot change, and checks the child's output
  against the state's own `outputSchema`, which is the interface's. On a
  real worker (`workflow-v2-agent-worker.test.js`, the scripted model): a
  publication of review_change@1 pins its digest with the revision; after
  the package is republished with review_change@2 (an input schema, another
  output schema, another outcome), the old name and the new name with the
  old contract are refused at publication (`CONTRACT_MISMATCH`) and stay
  drafts with no run, child or model turn; the first publication's run
  keeps its revision, its child's wrapper carries exactly @1's outcomes and
  output schema, a completion under @2's outcome is refused
  (`OUTPUT_INVALID`) and one under @1 decides the state; a later
  publication of @2 pins the new revision and digest, and its child's
  wrapper carries @2's input, input and output schemas and outcomes.
- **Discovery (`agent-discovery.ts`, `worker.ts`).** `ps_list_agents`
  lists, for a published agent whose installed active version exports an
  interface, `workflowInterface: { ref, name, version, outcomes,
  inputSchema, outputSchema, digest }`: what the state names (`ref`, with
  `package` set to the entry's `namespace`) and the schemas to copy. The
  worker reads each export from its installed version's install manifest
  (by package id and agent name), in the same snapshot as the agents, and
  checks it again (shape, schemas, digest); a record that is not well
  formed is not listed. The entry is otherwise unchanged, every other entry
  is unchanged, and the tool takes no new option. Visibility is the
  listing's: an agent the caller cannot see is not listed, with or without
  an interface. The listed interface is the installed version's; a worker
  that has not refreshed after a republish lists the previous one, and
  publication, which reads the registry, reports any mismatch.
- **Display (`workflow-v2-view.js`, the portal's node details, the TUI's
  workflow view).** An agent state's details show its agent and package,
  the interface it names, and what the shown run pins it to: the
  publication's pin for the published revision (`Pinned by publication`),
  a real-agent test run's own pin when it tested the graph's revision
  (`Pinned for this test`), or that a mocked test run's agent is mocked.
  A pin shows the package, version and the first 12 characters of the
  exact revision and of the interface's digest; a pin made before
  revisions shows `by version`, a deployment agent is pinned `by name`, and
  a state that names an interface whose pin has no digest shows
  `Not pinned`. A malformed pin shows only what it holds. The portal and
  the TUI use the same rows (`workflowV2AgentBindingRows`).
- **Compatibility.** A publication without an interface, its pins and its
  runs are as before (a pin's extra `interface` field is ignored by the
  binding). A package without a `workflowInterface`, at schemaVersion 1 to
  4, validates, publishes and installs as before.

Tests: `workflow-v2-package-interface.test.mjs` (declaration, export, files,
read-back, compiler and stored IR, the exact-match rules, front matter),
`agent-package-format.test.mjs` (the manifest export, the version and file
refusals, a manifest layout's `include`), `agent-mcp-servers.test.mjs`
(version 5 loads), `workflow-v2-agent-resolver.test.mjs` (the definition
carries the export), and on PostgreSQL `workflow-v2-agent-resolver.test.js`
(a person's publication: digest pinned with the revision; mismatch,
missing and forged exports refused; a republish keeps the pin; a real-agent
test refused) and `workflow-v2-agent-node.test.js` (the compiler).
Discovery: `agent-discovery.test.mjs` (listed, checked, visibility, the
snapshot, the tool) and on PostgreSQL `agent-package-worker-install.test.js`
(a published package's export in the registry manifest and in a real
worker's `ps_list_agents`, and a republish's). Display:
`workflow-v2-agent-binding.test.mjs` (the projection, the portal's details
and the TUI's view for publication, test, mocked, draft, older and
malformed pins).

Not covered (required, not waived): no adapter maps a workflow schema to an
interface other than exact equality (mock M17's "Edit input mapping" is
the draft editor only). The portal's agent picker and package views do not
show interfaces (the package manifest the registry APIs return holds them).
The interface schemas ride the install manifest that every worker reads (at
most 64 KiB per schema file).

## Surfaces: what each one shows and takes (design 04, 07; R13, R23, R26)

| Surface | Reads | Takes |
|---|---|---|
| Agent tools (the workflow's parent) | `read_workflow` | `update_workflow` (draft, publish, start, KV, pause, resume, cancel; on a 1.9.0 host also stop, test, test_respond, test_advance), `send_workflow_input` |
| Agent tools (a request's responder, an agent state's child) | — | `respond_session_request`, `complete_workflow_node` (in-process, bound by the host) |
| REST `GET /sessions/:id/workflow`, SDK and TUI `readWorkflow`, MCP `read_workflow`, portal | the same `readWorkflowV2View`: the view, a section's next page (`cursor`) or one execution's whole value (`executionId`); with `workflowCommands` (INACTIVE) the view also `personCommands` | nothing |
| Portal workflow view run controls (INACTIVE: only with `personCommands`) | `personCommands` and the shown run | a person's `pause`, `resume`, `stop`, `cancel` of the shown run, as `updateWorkflow` commands |
| Portal workflow view variables panel (INACTIVE: only with `personCommands`) | the shown run's `kv` preview and `kvRevision` | a person's `set_vars` of one variable (set, or remove after confirming) at the revision shown |
| Portal workflow view draft editor (INACTIVE: only with `personCommands.draft`) | the draft's current revision and YAML, for a caller who may change it | a person's `replace_definition` at the revision the edit started from |
| Portal workflow view test review (INACTIVE: only with `personCommands` listing `test`) | the definition's current revision, definition hash and validity | a person's `test` of that exact revision, with inputs, agent mode and an optional scenario name |
| Portal workflow view test answers and clock (INACTIVE: only with `personCommands` listing `test_respond` or `test_advance`) | the shown test run's interceptions, what each reached and must match, its virtual clock | a person's `test_respond` to one waiting interception, and `test_advance` of the run's virtual clock |
| Portal workflow view publication review (INACTIVE: only with `personCommands`) | the definition's state, revision, definition hash, validity and runs; each named agent as written and, once published, its pin; the tests of exactly that revision (information) | a person's `publish`, `publish_and_start` (exact revision and hash) or `start` (published hash), with JSON inputs and optional initial variables |
| Portal and TUI composer, management client, SDK client | session access (`canSendPrompt`, `canAnswer`, `canSteer`; the TUI's direct mode reads `getWorkflowInputPolicy`) | human input, refused for an agent state's subtree at the SDK (both composers are read-only there) |
| REST `POST /sessions/:id/workflow/commands`, SDK (direct and web) and TUI `updateWorkflow`, MCP `update_workflow` (INACTIVE: test-only option `workflowCommands`) | — | a person's `update_workflow` command (below) |
| Bootstrap (`GET /api/bootstrap`, `/api/v1/bootstrap`), SDK `getWorkflowCapabilities` (direct and web), both transports | `workflows`: the workflow support the deployment takes now (below) | nothing |
| TUI workflow view (`w` on a workflow session) | the states in graph order for the chosen run (←→), the selected state's details, transitions and history, one visit's own result (the latest, or an older visit chosen with [ ]; f reads its whole value; i compares the variables it applied with the accepted ones), the run's older history (o), an agent state's child session per occurrence, a test run's intercepted effects, and with `personCommands` (INACTIVE) the shown run's controls and variables, the definition's publication and test and, with `personCommands.draft`, the draft's revision and YAML (below) | a person's `pause`, `resume`, `stop`, `cancel` of the shown run (p, r, s, c; stop and cancel ask first), `set_vars` of one variable (v: set, or remove after confirming) or of several in one update (V: a JSON object to set and a JSON list to remove; an update that removes asks first), `replace_definition` of the draft (e: the editor; ctrl-o saves at the revision the edit started from), `publish`, `publish_and_start` or `start` of the exact revision and hash reviewed (P: the review; each asks first), `test` of the current revision and hash (t: the review, mocked or real agents; it asks first), and for a shown test run `test_respond` to one waiting effect (a) and `test_advance` of its virtual clock (+) as `updateWorkflow` commands; it opens a child session's chat to read |

All read surfaces serve one projection (`readWorkflowV2View`), so they show
the same agent child, branch, stop, test and pin fields. The shared UI
(`packages/app/ui`) now reads them:

- **Agent states.** The node shows its agent (name, package and version, or
  an inline prompt), outcomes and deadline, and, once its child exists, the
  child session with a button that opens its actual chat (read-only for
  people; R23). The node text says that only the typed result completes
  the state.
- **Parallel states.** The graph draws an edge from the parallel state to its
  body's first state ("each branch"); the node shows where branches start,
  the concurrency, the join and failFast, and the number of branches; a body
  state's execution names its branch.
- **Stop.** A run with an accepted stop reads "Stopping · admitted work may
  settle until …"; a stopped run is ended ("Stopped"), and the run picker
  names it.
- **Test runs.** The notice stays as a banner ("TEST — scripts run
  normally…"), with the stale flag, the virtual clock, the number of
  interceptions waiting for the parent and a read-only table of intercepted
  effects and their answers. Answers go through the parent's tools.
- **Human input.** A session whose access reports `canSendPrompt: false` has
  no composer; the note gives the reason and the controlling agent. The
  server refuses the input anyway.
- **Run controls, variables, the draft editor, publication and test starts
  (R03, R04, R05, R17 to R20, R26, R28; mocks M01 to M04, M15, M16, M18 to
  M20; INACTIVE).** See below.

**Capability advertisement (design 04 "Advertise capability/version in
bootstrap"; D11).** The bootstrap carries `workflows`, what the deployment
takes now, so a client gates its workflow surface before a call is refused
(`workflowCapabilities`, `human-commands.ts`; the management client's
`getWorkflowCapabilities`, which the portal runtime's bootstrap,
`NodeSdkTransport`, `HttpApiTransport` and the Web management client
expose). `v2.apiVersion` is the workflow document version; `v2.read` says
whether `readWorkflow` reads version 2 workflows (false without a workflow
store); `v2.create` and `v2.input` are false (a person creates no version 2
workflow and sends it no typed input; its parent agent does); `v2.commands`
is off as every deployment is configured today, naming the refusal each
command gets (501 `WORKFLOW_COMMANDS_UNAVAILABLE`), and, with the test-only
option `workflowCommands`, names the controller version the runs it starts
run at (1.8.0, or 1.9.0 with `requests`) and the operations a person may
send; `legacyCreate` says that `createWorkflowSession` keeps its version 1
semantics and never makes a version 2 draft. It reports configuration only:
it serves, registers and activates nothing, the route names are unchanged
(their final names stay API review item D11), and the server decides every
call again. An older server advertises none (null). The MCP server's
`get_capabilities` and its `pilotswarm://capabilities` resource carry the
same value as `workflows` (the management client's own answer: in direct
mode this process's configuration, in web mode the server's bootstrap;
null only from a host that advertises none: no getter, or a null answer; a
host that cannot be asked, or whose answer is not an object, is an error:
`get_capabilities` answers it as its error result and the resource read
fails, `WORKFLOW_CAPABILITIES_MALFORMED` for a malformed answer, and the web
clients' getters reject the same way), and beside it
`workflow_tools: { read, commands }`, the workflow tools that server
registers: `read_workflow` always, and `update_workflow` only with the
test-only option, so a client sees where the two differ.

**A person's workflow command (`updateWorkflow`; design 04, R26; INACTIVE).**
The direct management client takes a person's command to a workflow
session: the `update_workflow` tool's operations and arguments
(`replace_definition`, `publish`, `publish_and_start`, `start`,
`set_vars`, `pause`, `resume`, `cancel`; `stop` and the test operations
when the workers run controller 1.9.0), run by the tool's own
implementation (`runUpdateWorkflowCommand`, `human-commands.ts`), so the
receipts and refusals are the tool's. It is taken only by a client created
with the test-only option `workflowCommands`; otherwise it answers 501
`WORKFLOW_COMMANDS_UNAVAILABLE` and changes nothing.

- **Who.** The caller's access to the session is decided before the
  command runs: the portal's `session:manage` gate (owner or admin, with
  not-found privacy), enforced even while the ownership switch is off, as
  `session:share` is (a new capability); an admin outside the owner's
  visibility is audited as break-glass; the direct client is trusted. The
  recorded actor is the signed-in caller (a user), the TUI's own user in its
  direct mode, or the client itself (system) without one; a command never
  names its actor.
- **What.** The command targets the session it is sent to (a `workflow_id`
  naming another is refused), which must be a version 2 workflow (404
  otherwise). `recover` stays the agent's. A refusal carries its code and
  HTTP status: 404 for what does not exist, 403 forbidden, 400 an invalid
  command, 422 a value its contract refuses, 429 a limit, 409 a conflict
  with the workflow's state.
- **Human input to an agent state's subtree (R13).** A workflow inside a
  workflow agent state's subtree (for example, one that an agent state's
  child created) takes only a person's brakes: `pause`, `stop` and
  `cancel`. Anything else that changes or drives it (its definition, KV,
  runs or tests, `resume` included) is refused with 403
  `WORKFLOW_HUMAN_INPUT_DENIED`, naming its controlling agent. The workflow
  container above it takes every command.
- **Surfaces.** `POST /api/v1/sessions/:sessionId/workflow/commands` with
  `{ command }` (protocol operation `updateWorkflow`); the web management
  client and `HttpApiTransport` send it; the TUI's direct transport and the
  portal's transport run it through the management client; the MCP server
  registers `update_workflow` only with its test-only `workflowCommands`
  option. Over HTTP a refusal keeps its code and status, its `details` when
  the adapter marks them safe to show (`exposeDetails`: field errors, the
  conflicting state, the controlling agent), and the inactive 501's message;
  both HTTP-backed clients carry the details back on the error.
- **Inactive.** A deployment enables it only through the test-only
  `workflowCommands` option of the portal runtime, the TUI transport, the
  management client or the MCP server; none is set anywhere in production.

**Run controls in the workflow view (R17, R26; mocks M04, M16; INACTIVE).**
The portal's workflow view lets a person pause, resume, stop or cancel the
run it shows, through the transport's `updateWorkflow`, with no new route.

- **What the view offers.** A read model says which commands the workflow
  takes from people (`personCommands`, `human-commands.ts`): the management
  client adds it only with its test-only `workflowCommands` option, so
  without it there are no controls and the view stays read-only. It lists
  the operations the host takes from a person (`stop` and the test
  operations only on a 1.9.0 host); for a workflow in a workflow agent
  state's subtree only `pause`, `stop` and `cancel`, with a `restriction`
  that names the workflow holding the agent state and its controlling
  agent; and, for the shown run, whether it takes a graceful stop
  (`run.stop`; a run admitted for a controller that cannot stop gracefully
  can only be cancelled). The portal adds `viewer`: whether the signed-in
  caller may send them, decided as `updateWorkflow`'s own gate decides
  (`session:manage`, owner or admin, enforced whatever the ownership switch
  says), on the read's access. None of this grants anything; the server
  decides every command again.
- **What a person sees.** Beside the run picker: Pause while the run waits
  to start or runs, Resume while it is paused, Stop and Cancel until it
  ends; a stopping run shows only Cancel, an ended run none. A workflow in
  an agent state's subtree never shows Resume, and a note says that people
  can only pause, stop or cancel it and names its controlling agent. A
  control the caller may not use (not the owner or an admin; Stop on a run
  that cannot stop gracefully; any control while a command is being sent)
  is disabled and says why in its tooltip.
- **Sending.** A control is the shown run's command (`run_id` is that run,
  never "the live run now"), with an operation id of its own. Stop and
  Cancel ask first: neither undoes effects that already happened. While it
  is sent the control reads "Pausing…" (or the like) and the others wait.
  Accepted: the status line says what was accepted (an accepted stop or
  cancel is a request its controller applies; the run's status says when it
  ends) and the read model is read again at once. Refused (a 4xx answer, or
  501 where the deployment takes no person's commands): a notice gives the
  reason; nothing changed, and a conflict with the workflow's state (409:
  the run moved on, the variables changed) also reads the workflow again,
  so the view shows what the server saw. No answer (or a server failure): a notice says
  the command may not have arrived, and Retry sends it again with the same
  operation id, so the server answers with the first command's receipt
  instead of applying it twice.
- **Cancel's reason.** A person's cancel without a reason ends the run as
  "Cancelled by a person" (an operator's client without a principal:
  "Cancelled by an operator"); the agent tool's default stays "Cancelled by
  its parent".

**Variables in the workflow view (R04, R05, R26; mock M15; INACTIVE).** The
same view lets a person read and change the shown run's variables (its open
KV), through the same `updateWorkflow` transport, with no new route.

- **What a person sees.** A Variables button in the header opens a panel
  (only when the read model has `personCommands`): the revision, each name
  and its JSON value from the read model's preview of the map (canonical
  JSON, cut at 4,000 characters: a longer map shows only its start, and a
  variable can still be named), and a note that a new name needs no
  declaration, that a state reads the variables as they are when it
  starts, and that they cannot change the published definition,
  permissions, join receipts or request winners.
- **Who may change them.** A person may change them when the workflow takes
  `set_vars` from people (never in a workflow agent state's subtree: the
  panel is read-only there and names the controlling agent), the run has
  not ended, the caller may command the workflow (the portal's `viewer`),
  and the revision is known; otherwise the panel says why and has no form.
- **Changing one.** A form takes a name (1 to 128 characters, kept exactly
  as typed) and a JSON value (a string needs its quotes; `null` is a
  value); Edit copies a listed variable into it. Set sends one update at
  once; Remove asks first (states that start later do not see the
  variable; running work keeps the values it started with). Each is one
  `set_vars` of that run at the revision shown (`expected_kv_revision`), with
  its own operation id: if the variables changed meanwhile, the server
  refuses it (409 `KV_REVISION_CONFLICT`), the notice says so, and the view
  reads the workflow again, keeping what the person typed. A batch of
  several keys in one update goes through the API, MCP, the agent tool or
  the TUI's several-variables form (below); the portal's panel changes one
  at a time.

**Editing a draft's YAML (R03, R17, R26; mocks M01, M02; INACTIVE).** The
same view lets a person who may change a draft edit its YAML.

- **The YAML read.** The human read omits the YAML: it holds the scripts and
  prompts the graph does not show. A client created with `workflowCommands`
  adds the current revision's number, definition hash and YAML as
  `personCommands.draft`, only for a draft whose workflow takes
  `replace_definition` from people (never a published definition, never in a
  workflow agent state's subtree). The portal leaves it out for a caller who
  may not command the workflow (the same `session:manage` decision as
  `updateWorkflow`), so only the owner or an admin reads it.
- **Editing.** An Edit draft button opens the YAML. An edit starts from the
  revision shown and Save draft sends `replace_definition` at that revision
  (`expected_revision`) with the whole YAML (at most 256 KiB, not empty, and
  changed). Saving makes a new revision; it never overwrites one someone
  else saved meanwhile: the server refuses it (409 `REVISION_CONFLICT`), the
  notice says so, and the view reads the workflow again. When the draft has
  moved on while it was edited, the editor says which revisions differ and
  offers Load revision N (the edit is discarded) or Keep my edits on
  revision N (an explicit choice to save on top of it); edits are kept until
  then. The version cannot change: the editor says so, and a new
  `metadata.version` is refused (409 `SEMVER_IMMUTABLE`). A revision saved
  with compile errors is kept and reported; it cannot be published until
  they are fixed.

**Starting a test from the workflow view (R19, R20, R26, R28; mocks M18 to
M20; INACTIVE).** When the read model's `personCommands` lists `test` (a
host that runs controller 1.9.0; never in a workflow agent state's
subtree), a Test… button opens a review of exactly what is tested: the
definition's name and version, its current revision (draft or published),
the full definition hash and its validity, under the test notice (scripts
run normally and their direct effects are real, framework tools are mocked,
and a test result is not evidence that the definition is safe to run live).
Agent states are mocked by default; choosing real agents shows, before the
test starts, that they spend model tokens, that their results vary, that
their framework tool calls are mocked and their model's built-in tools run.
Start test sends `test` with that revision (`expected_revision`) and hash,
the inputs (a JSON object), optional initial variables, the agent mode and
an optional scenario name (at most 128 characters); the command names no
run, and once the test starts the view selects the new test run. A revision
that moved on is refused (409 `REVISION_CONFLICT` or
`DEFINITION_HASH_MISMATCH`) and the workflow read again; a revision with
compile errors, a caller who may not command the workflow, an unknown hash
or a command in flight disable it, with the reason. The live run is never
changed.

**Answering a test's effects and moving its clock (R08, R19, R20, R26; mocks
M18, M19; INACTIVE).** When the view shows a test run and its
`personCommands` lists `test_respond` or `test_advance` (a host that runs
controller 1.9.0; never in a workflow agent state's subtree), a person who
may command the workflow can drive the test:

- **Answers.** Each intercepted effect that waits for an answer
  (`awaiting_parent`) has an Answer button in the interceptions table. Its
  form shows what the effect reached (its arguments) and what the answer
  must match (its response schema), then sends the answer the person
  chose: success with a JSON value (an agent state's starts as
  `{ outcome, output }` with its first outcome, a request's as
  `{ response }`), error with `{ code, message, details? }`, or cancel. The
  JSON is checked in the view; the server checks it against the effect's
  contract and refuses it with the fields it rejects (422
  `TEST_RESPONSE_INVALID`, shown with its first problems or the state's
  outcomes); the same answer sent again is the same answer, and another is
  refused (409 `TEST_RESPONSE_CONFLICT`). `test_respond` names the run and
  the interception. Once accepted, the form closes and the view reads the
  workflow again.
- **The virtual clock.** The test run's clock shows how far it is from the
  test's start; Advance moves it by a whole number of seconds (1 to 30
  days), deciding whatever came due (`test_advance`), and says that script
  clocks are real.
- **Where not.** A test run that ended, or a viewer who may not command the
  workflow, keeps the interceptions readable with no Answer buttons and no
  clock control; a live run has neither.

**Publishing and starting from the workflow view (R17, R18, R26; mocks M01,
M03; INACTIVE).** The same view lets a person publish a draft and start its
live run, through the same `updateWorkflow` transport.

- **What a person sees.** When the read model has `personCommands`, a draft
  has a Publish… button and a published workflow without its live run a
  Start… button. Each opens a review that shows exactly what is published
  or started: the definition's name and version, the revision, its full
  definition hash, its validity, and when live effects happen; for a draft,
  that publishing freezes the revision (it no longer changes, a new version
  needs a new workflow) and starts no run, approves no repository write and
  grants no tool. Publishing and starting are separate, explicit choices:
  Publish only, Publish and start, or Start live run.
- **Who may.** The controls are offered only when the workflow takes them
  from people (never in a workflow agent state's subtree), and disabled,
  with the reason, for a revision with compile errors, a caller who may not
  command the workflow, an unknown revision or hash, and while a command is
  being sent. Once the workflow has its live run, nothing is offered.
- **Sending.** Publish sends the revision shown (`expected_revision`) and its
  exact definition hash; Publish and start adds the run's inputs (a JSON
  object, `{}` when empty) and optional initial variables (a JSON object);
  Start sends the published revision's hash with the inputs. A definition
  command names no run. A stale publish (the draft moved on, or the hash is
  not the revision's: 409 `REVISION_CONFLICT` or
  `DEFINITION_HASH_MISMATCH`) is refused, the notice says so, and the view
  reads the workflow again, keeping what the person typed; inputs the
  workflow's schema refuses are reported with their first problems (422
  `WORKFLOW_INPUT_INVALID`). An unanswered command is sent again with the
  same operation id.

Unfulfilled requirements (open, not waived; R26):

- **Human test-run and typed-input routes** (`/test-runs`, `/inbox`): a
  person's test operations travel as `updateWorkflow` commands (above);
  design 04's separate `/test-runs` and `/inbox` paths, and the final path
  names, are API review item D11.
- **The rest of the UI commands**: the portal sends every person's command
  (above). Test fixtures go through the API, MCP or the agent tool; a
  several-key variables update goes through them or the TUI. The TUI's
  workflow view (below) sends only a person's run controls, variable
  changes, draft saves, publication commands, test starts, test answers and
  virtual clock advances.

**The TUI's read-only workflow view (design 02 "Portal/TUI: graph, observed
state, read-only child chats"; T115).** On a workflow session, `w` (outside
the prompt) opens it: the same projection the portal's workflow pane draws
(`projectWorkflowV2`, or the legacy node views; `workflow-tui.js`), from the
same reads (`ensureWorkflowDefinition`, which also reads the v2 read model,
again while the view is open as new events arrive). The states come in graph
order: by layer as the portal lays the graph out (a loop is one layer), then
by position. Each row shows the observed state and the number of
executions. The selected state's details show its state, executions, last
outcome and description, its transitions (an outcome, a runtime-error
route, where a parallel state's branches start, and a transition inside a
loop marked as one), the result of one visit (below), and for an agent
state the child session of each occurrence, newest first. ↑↓ select a
state, ←→ choose the run it shows, Tab chooses an occurrence, Enter opens
that occurrence's actual chat (`loadSession`, as the portal's node details
open it) and Esc closes. The runs are the portal's run picker options (the
live run, then the workflow's runs; `workflowV2RunPickerModel`, now in
ui-core and re-exported unchanged by the portal's panels), with the same
labels and notes (a run still being read, a run that could not be read);
choosing one sets the same selection as the portal's picker
(`selectedRunId`) and reads that run's own model, so the view shows only
that run (its agent states' own children included). The selected state's
details end with its history, newest first, as the portal's History tab
lists it (a v2 state's visits with a loop's unchanged repeats combined,
`compactWorkflowV2Executions`; a legacy state's steps with their outcome and
duration), and, for a test run, that run's intercepted effects as the
portal's table lists them (the effect, its state, and its answer or that it
waits for the parent; those of the selected state marked), from that run's
own read model only. PgUp and PgDn (ctrl-u, ctrl-d) scroll the details a
page at a time, never past their last line; another state or run starts at
the top. Apart from the run controls below, the view sends nothing and
changes nothing (the run's parent agent, a fixture or a person in the
portal answers an intercepted effect); the server keeps refusing human
input to an agent state's subtree.

**The TUI's run controls (design 04, 07, mocks M04, M16; R17, R26;
INACTIVE: only a deployment that takes a person's workflow commands offers
any).** In the workflow view, p pauses, r resumes, s stops and c cancels the
run the view shows, and d dismisses the notice about the last command. They
are the portal's controls (`workflowV2RunControls`, from the shown run's own
read model and its `personCommands`), sent as the portal sends them (the
shared controller's `sendWorkflowRunCommand`, an `updateWorkflow` command
through the transport, for that run's id). The details list the controls
the run takes now, with their keys: pause while the run waits to start or
runs, resume while it is paused, stop and cancel until it ends, only cancel
while it stops. A control that is listed but not available now (a command
being sent, a controller that cannot stop gracefully, a viewer the portal
refuses) says why, and so does a key for a control the run does not take,
on the status line: the subtree rule (a workflow in an agent state's
subtree takes only pause, stop and cancel from people, with the
controlling agent named), a run that ended or is stopping, a run that is
not paused, or a deployment that takes no person's commands (the view then
lists no controls and stays read-only). Stop and cancel open the confirm
dialog first (neither undoes effects that already happened); it returns to
the view as it was, and closing it sends nothing. One command at a time:
the control being sent says so (`pausing…`), and the others wait. An
accepted command is said on the status line and the workflow is read again
at once. A refusal, and an answer that never came, are shown in the
details and on the status line; after an answer that never came, the same
control sends the same command again (the same operation id, so the server
applies it once). The server decides every command again (its session
gate, the subtree rule, the run's state). Long reasons and notices are
wrapped, not cut. Nothing about the run lifecycle changes.

**The TUI's run variables (design 02 open KV; R04, R05; mock M15;
INACTIVE likewise).** The workflow view's details list the shown run's
variables with their revision, as the portal's variables panel does
(`workflowV2RunVariables`: name = value, the first 8, with the note or the
start of a preview too long to list, and why a person cannot change them).
`v` opens the variables form for that run: a name field and a JSON value
field (Tab switches them; ←→, Home, End and Backspace edit the focused
one), the run's variables now (↑↓ copy one, its whole value, into the
fields), and the run's revision. Enter sets the name to the value
(`workflowV2VariableDraft`: the name exactly as typed, 1 to 128 characters,
kept as plain data whatever it is, `__proto__` included; the value any JSON);
ctrl-r removes the name (`workflowV2VariableRemoval`) after the confirm
dialog, which returns to the form. Each is one `set_vars` update of the run
the form was opened for, sent as the portal sends it
(`sendWorkflowRunCommand`), at the revision the view shows when it is
sent. What was typed is checked first and the form says what is wrong. The
form is not opened where the workflow (an agent state's subtree: people
only pause, stop or cancel it), the run (ended, or its revision unknown),
the viewer or the deployment does not allow a change; the status line says
why. The server decides every update anyway: its refusal (for example a
human-input denial) stays in the form and on the status line, with what was
typed. A changed revision is refused (`KV_REVISION_CONFLICT`) and the
workflow is read again, so the form shows the new variables and revision
and the next Enter uses it; an answer that never came is sent again as
itself (the same operation id). While an update is sent the form says so
and sends nothing else. A form whose run the view no longer shows (a new
live run) sends nothing. Accepted, the form returns to the view. While the
form is open, q is text, not the quit key. Nothing else about the open KV
changes.

**Several variables in one update (design 02 open KV: `set_vars` is one
atomic batch; R04, R05; INACTIVE likewise).** `V` in the workflow view
opens a second form for the shown run, where the variables form would
open (the same gate: `workflowViewVariablesFor`). It has two fields: Set,
a JSON object of names and their JSON values, and Remove, a JSON list of
names (Tab switches them). The shared `workflowV2VariableBatchDraft`
checks them: Set must be an object and Remove a list of strings, either
may be empty but not both, each name is 1 to 128 characters, kept exactly
as typed and plain data (`__proto__` included), and a name given twice in
Set (JSON would keep only the last), twice in Remove, or in both is
refused rather than guessed. The form reviews what Enter sends, from what
is typed: each name added, or replacing the value it has (whole, not
merged), or removed, at the revision the view shows; every other variable
stays as it is (where the variables are too long to list, it says set,
not add or replace). Enter sends it as one `set_vars` command (`set` and
`delete` together, `expected_kv_revision`), never as one command per
variable, through `sendWorkflowRunCommand`, so the server applies all of
it or none. An update that removes any asks first, in the shared confirm
dialog, which names what it sets and removes and returns to the form; one
that only sets is sent at once, as a single set is. Refusals, a changed
revision (read again; the next Enter uses the new revision), an answer
that never came (the same update sends the same operation id), one
command at a time, a run the view no longer shows and Esc behave as in
the variables form, and what was typed stays until the update is
accepted or the form is closed. The one-variable form (`v`) is unchanged;
an ordinary session has neither form.

**The TUI's draft editor (design 04 replace_definition; mocks M01, M02;
R03, R17, R26; INACTIVE likewise).** The workflow view's details name the
draft's revision and version when the read model gives this person the
draft's YAML (`personCommands.draft`: a draft, `replace_definition` offered,
a viewer who may change it), and an edit kept unsaved. `e` opens the editor
on that YAML: the portal's editor model (`workflowV2DraftEditor`,
`workflowV2DraftEdit`) as a terminal editor, with line numbers and the
cursor (a long line is shown around the cursor, never wrapped), the
revision the edit started from and the version, which cannot change (the
server refuses a new one). The YAML edits as text: Enter is a new line (a
pasted CR or CRLF too), Tab two spaces, the cursor keys, PgUp/PgDn ten
lines, Home/End, Backspace; q is text, not the quit key. ctrl-o saves the
edit as one `replace_definition` at the revision it started from, sent as
the portal sends it (`sendWorkflowRunCommand`); an edit with no change,
empty YAML or more than 256 KiB is not sent, and the editor says why.
Accepted, the editor stays open on the new revision, with anything typed
while it was sent kept as an edit of it; a revision with compile errors is
saved and its diagnostics are listed under the YAML, which stays. A revision
the view has not read yet is shown as saved, and the older YAML does not
come back. A draft someone else saved meanwhile is refused
(`REVISION_CONFLICT`) and the workflow is read again: the edit stays on the
revision it started from, saving waits, and the editor offers ctrl-r to load
the newer revision or ctrl-k to keep the edit on it. Outside a conflict
ctrl-r discards the edit, back to the revision it started from. Discarding
changes asks first in the confirm dialog, which returns to the editor. A refusal
(a new version, `SEMVER_IMMUTABLE`; a human-input denial) stays in the
editor and on the status line, with the edit. After an answer that never came,
ctrl-o sends the same save again (the same operation id). While a save is
sent the editor says so and nothing else is sent or discarded. Esc closes
the editor and keeps the edit in the view (`e` shows it again where it
was). The editor is not opened for a published definition, a workflow in an
agent state's subtree (with the controlling agent named), a caller the YAML
is not given to, or a deployment that takes no person's commands; the status
line says why, and an open editor whose draft is published meanwhile edits
and sends nothing. The server decides every save again.

**The TUI's publication review (design 04 publish, publish_and_start,
start; mocks M01, M03; R17, R18, R26, R28; INACTIVE likewise).** The
workflow view's details say what can be published or started (a draft's
revision, or a published revision without its live run) when the portal's
publication panel would offer it (`workflowV2DefinitionControls`). `P` opens
the review of exactly what the view shows then (its pin): the definition,
the revision and its full definition hash, its validity, what has live
effects, each named agent state's agent as written (package and version)
and, once published, what publication pinned for it (the package revision
and the interface digest), the tests of exactly this revision with their
status and outcome, shown as information (publishing requires no test: no
publication gate on test scenarios exists, inventory C6-2), and that
publication freezes the revision, starts no run, approves no repository
write and grants no tool (mock M03; R18, R28; the portal's review shows the
same rows, `workflowV2PublicationEvidenceRows`; nothing is resolved before
publishing: a pin preview is inventory C6-1). ctrl-p publishes only; ctrl-r
publishes and starts the live run, or starts a published definition's live
run, with the run's inputs and optional initial variables, two JSON object
fields (Tab switches them; inputs default to `{}`). Each action asks first:
the confirm dialog names the revision, the definition hash and the inputs
quoted, and returns to the review. Confirmed, the command is sent for that
revision and hash as the portal sends it (`sendWorkflowRunCommand`).
Accepted, the review returns to the view and the status line says what was
published or started. An action the workflow does not offer, or not now (a
revision with compile errors, a viewer the portal refuses, a command being
sent), and inputs or variables that are not JSON objects are not sent: the
review says why and keeps what was typed. A workflow that changed while the
review was open (a newer revision saved, or published elsewhere) is shown as
changed and nothing is sent for the old pin; ctrl-l reviews it as it is now,
keeping the fields. A refusal (a stale revision or hash, read again; inputs
the definition's schema refuses, with their problems) and an answer that
never came stay in the review with what was typed; after an answer that
never came, the same key sends the same command again once confirmed (the
same operation id). While a command is sent nothing else is. Enter sends
nothing; Esc goes back to the view; q is text. The review is not opened in
an agent state's subtree (with the controlling agent named), for a workflow
with its live run, or without a person's commands; the status line says why.
Publication and run semantics are unchanged: the server decides every
command again. The approved contract (design 04's operation table, mock M03,
T018 to T020) has no review of the definition's inputs schema; the review
does not show it, as the portal's does not, and the server's refusal names
the problems.

**The TUI's test review (design 05 test; mocks M18 to M20; R19, R20, R26,
R28; INACTIVE likewise).** The workflow view's details say that a test of
the current revision can start, where the portal's test review would offer
it (`workflowV2TestControls`: a host with controller 1.9.0, outside an
agent state's subtree). `t` opens the review of exactly the current revision
and its definition hash (its pin), draft or published. It shows the test
notice first (scripts run normally and their direct effects are real;
framework tools are mocked; a test result is not evidence that the
definition is safe to run live), then the definition, the revision, its
full hash and its validity, and the agent states: mocked to start with (the
parent answers each agent state); ctrl-a switches to real agents and back,
and real agents bring their own notice (they spend model tokens; their
framework tool calls are mocked; MCP tools are refused). Three fields
follow (Tab moves through them): the run's inputs (a JSON object, `{}` to
start with), its optional initial variables (a JSON object) and an optional
scenario name (1 to 128 characters). ctrl-t asks first: the confirm dialog
names the revision, the definition hash, the agent mode, the inputs,
variables and scenario quoted, and repeats the notices; it returns to the
review. Confirmed, the test is sent for that revision and hash as the
portal sends it (`sendWorkflowRunCommand`, `test`); started, the view shows
the new test run and reads its own model, as the portal's review does. A
test the portal's review would not start now (a revision with compile
errors, a viewer the portal refuses, a command being sent), and inputs,
variables or a scenario name it would refuse, are not sent: the review says
why and keeps what was typed. A workflow whose current revision changes
while the review is open is shown as changed and nothing is sent for the old
pin; ctrl-l reviews the current revision, keeping the fields and the agent
mode. Publishing the revision under review changes nothing that is tested.
A refusal (a stale revision or hash, read again; inputs the definition's
schema refuses, with their problems) and an answer that never came stay in
the review with what was typed; after an answer that never came, ctrl-t,
once confirmed, sends the same test again (the same operation id). While a
command is sent nothing else is. Enter sends nothing; Esc goes back; q is
text. The review is not opened in an agent state's subtree (with the
controlling agent named), by a host that takes no test from people, or
without a person's commands; the status line says why. Test semantics are
unchanged: the server decides every test again.

**The TUI's test answers and virtual clock (design 05 test_respond,
test_advance; mocks M18, M19; R08, R19, R20, R26; INACTIVE likewise).** For
a test run the view shows, its details say what a person may do there, as
the portal's answer form and clock allow it (`workflowV2TestResponder`, from
that run's own read model): `a` answers an intercepted effect that waits for
the parent, `+` advances the run's virtual clock; a run that ended or a
viewer the portal refuses says why instead, and the list of intercepted
effects says that a person may answer one there. `a` opens the answer form
bound to exactly that test run and one waiting effect (the selected state's,
else the first; ↑↓ binds it to another, starting from that effect's own
template). It shows the run's notices (a test, not a sandbox; its agent
states mocked or real, with the real-agent notice), the effect, its actual
state (waiting; answered, with what and by whom; or its state ended another
way), what it reached, the schema the answer must match and, for an agent
state, its outcomes. The answer is success with a JSON value, error with
`{ code, message, details? }` or cancel with no value (Tab changes it); what
was typed is checked first (`workflowV2TestResponseDraft`). Enter sends one
`test_respond` for that run and interception as the portal sends it
(`sendWorkflowRunCommand`); accepted, the form returns to the view and the
status line says how the state ended. The server decides the rest and the
form keeps what was typed: an answer its contract refuses names the fields
(`TEST_RESPONSE_INVALID`), another answer to an answered effect is refused
(`TEST_RESPONSE_CONFLICT`, read again) while the same answer again is
accepted as the same answer, a state that already ended refuses it
(`NODE_CLOSED`), and a run that ended refuses it (`RUN_ENDED`). `+` opens the
clock form bound to the run: how far its virtual clock is from the test's
start, what an advance decides (a wait or a receive's wait elapses, an
intercepted request or agent times out; a result that won first stands;
script clocks are real) and the seconds to advance by (a whole number from 1
to 30 days, `60` to start with). Enter sends one `test_advance`; accepted,
the form returns to the view and the status line names the deadlines that
came due and how each state ended. Nothing else moves the clock, and no
lifecycle rule changes. Neither form sends for a run the view no longer
shows, a run that ended, a viewer the portal refuses, or while a command is
sent; after an answer that never came, Enter sends the same command again
(the same operation id). Esc goes back; q is text. In an agent state's
subtree, by a host without controller 1.9.0, or without a person's
commands, neither is offered and the status line says why.

**The TUI composer of a session in an agent state's subtree (design 03
human-input denial; T115 "no human composer", T116 in the TUI).** It is
read-only, as the portal's is: it shows the server's reason and the
controlling agent. What a person may send comes from the server
(`ensureWorkflowInputPolicy`: the direct transport's
`getWorkflowInputPolicy`, the stored lineage; in API mode the session
access the Web API reports), read once per session (a session's lineage
never changes) and only for a session that may be in such a subtree by its
loaded ancestry (`workflowInputPolicyApplies`: an agent state's child is
created under its workflow session, so a root session, an ordinary agent
tree and a workflow session are never asked about; an ancestor that is not
loaded is asked about). A prompt, an answer or a steer to such a session is
not sent and its draft is kept. Until the server answered, or when the read
fails, the composer stays as it is and the server refuses the input
(403 `WORKFLOW_HUMAN_INPUT_DENIED`). Ordinary sessions, and the portal (which
reads the same policy through its session access), are unchanged.

Not in the TUI yet (open, not waived):
- the TUI refuses a person's prompt, answer and steer to an agent state's
  subtree locally; its other human input there (a workspace command, for
  one) is refused by the server only.

**Each execution's own result (R01 history; design 02 node occurrences;
mock M10 "Inspect typed output"; portal and TUI).** A state's visits stay
distinct, a loop's included, and each
shows its own result, never another's. The portal's History tab gives each
row of one execution a Result button: it chooses exactly that execution of
the shown run and state (`selectedExecution`: run, state, execution id)
and opens the Output tab, which then says which visit it shows, with a
button that shows the latest result again; a row of combined repeats has
none, and the full list below it chooses each of them. In the TUI, the
selected state's details show the result of one visit (the latest by
default), and `[` and `]` step to an older or newer visit of the shown run
(past the newest chosen visit, the latest result again). Both show that
visit's own output or runtime error (with its code and any effect status)
as the authorized read model already carries it (its bounded preview), or
that it has not ended or recorded no output; a preview the read cut short
says so. A choice applies only to that run and state: another run, even
with the same execution ids, or another state shows its own latest result.
A chosen execution that a newer read no longer lists is said to be missing,
and no other execution's result is shown in its place. A refused read shows
its error and no result from another run's model. Nothing new is read or
sent, and no read authorization or runtime behaviour changes; ordinary
sessions are untouched.

**A run's history in pages, and one execution's whole value (design 04
`read_workflow` "bounded history pagination"; R01, R26; mocks M04, M10
"Inspect typed output"; D07).** A read lists each section of a run (node
executions, inbox, outbox, and a test run's intercepted effects) newest
first, one bounded page at a time: by default 200 executions, 50 inputs, 50
sent messages and 200 effects, `limit` 1 to 200 for every section. Rows the
page does not hold that are still open (pending executions, unclaimed
input that has not expired, pending deliveries, effects that wait for an
answer) are listed apart (`openExecutions`, `openInbox`, `openOutbox`,
`test.openInterceptions`, at most 500 each), so a run's current state is
read however old it is. `run.pages` gives each section's `nextCursor`: given
back as `cursor`, it reads the next, older page. A cursor is bound to the
workflow, run, section, order and its format version, and holds the exact
key of the previous page's last row (an immutable time or sequence, then a
unique id); a cursor that is not one, or names another workflow or run, is
refused (`WORKFLOW_CURSOR_INVALID`); it grants nothing. Pages are separate
reads, not one snapshot: no row is listed twice, and over a stable result
set following the cursors lists each row once; a row committed later is
shown by a later read (one whose key sorts below a position already passed,
because its transaction read the clock or took its sequence earlier, by a
new pass); a page shows its rows as they are when it is read. A test run's
coverage is counted over all its executions. `execution_id` (the agent
tool) or `executionId` (the API) reads one node execution of the run (default
the live run) with its whole output or runtime error as stored (`result`:
kind, bytes, value), within the 256 KiB cap; a stored value larger than a
read returns (the runtime writes none) gives its bounded preview, marked
`whole: false`; an execution of another run or workflow is
`EXECUTION_NOT_FOUND`. The same read serves the agent tool (its arguments
are declared only on a 1.9.0 turn; every turn's handler pages), the
management client and `GET /sessions/{id}/workflow` (`cursor`, `executionId`
and `limit` in the query, under the same `session:read` gate and not-found
privacy; `personCommands` only with the view), the web clients and MCP's
`read_workflow`. A run of at most `limit` rows per section reads as before.

**A run's variables at any kept revision (design 02 open KV; R04, R05; mock
M15 "Inspect update", "Compare snapshots").** Every revision of a run's
open KV map is kept; `kv_revision` (the agent tool, MCP) or `kvRevision`
(the API), 1 to the run's `kvRevision`, reads that revision as it was:
its variables sorted by name, each with its size and the sha256 of its
canonical JSON (so two revisions compare exactly), whole when the map's
canonical text is at most 256 KiB, otherwise each value's 200-character
preview (`whole: false`), and the run's accepted revision now
(`acceptedRevision`). With `kv_key` / `kvKey`, one variable of that
revision, whole (a value is at most 256 KiB, the KV limit), or that it was
not set. Each node execution's `kvRevision` is the revision it applied. A
revision the run does not have is `KV_REVISION_NOT_FOUND` (404); a key
without a revision, or a KV read mixed with a page or an execution read,
`WORKFLOW_READ_INVALID`. Reading changes nothing. The portal's node Details show
the revision the current visit applied beside the run's accepted one, with
Compare with the accepted variables (or Inspect these variables when they
are the same); the TUI's details show the same for the visit they show, and
`i` compares them. A comparison lists each variable added, removed or
changed (by sha256) with its values before and after, as read, and counts
the unchanged ones, for exactly the shown run.

The portal and the TUI join older pages a person loads to the shown run's
own read model: the portal's History tab and test effects table have Load
older history, the TUI `o`; a newer read whose page no longer joins the
loaded rows hides them, says so, and reads older history again from its own
page, so no unread row is skipped; an older row that was open when it was
read and is no longer open is left out and counted. Every loaded visit of
a state is reachable (the former cap of 40 per state is gone). The portal's
Output tab reads the whole value of the execution it shows (Read the whole
value), the TUI `f`, for exactly the shown run and execution, never
another's in its place; the TUI shows at most 40,000 characters of it.

Not covered: the pages are bounded reads, not a snapshot of the run; the
inbox has no `(run_id, seq)` index (as before; no migration added); a
`cursor` or `limit` that is not JSON is refused 400 `INVALID_REQUEST` by the
route before the session gate (the existing JSON query convention, as
`listSessionsPage`). A server without pages (an older one) keeps its
first-200 notice.

**Responses and completions stay in process (owner scope, 2026-11-02).**
External agents are not in scope: agents run only within PilotSwarm, as
agent-to-agent communication does today. A request's responder answers with
its in-process `respond_session_request` tool, and an agent state's child
completes its state with `complete_workflow_node` (`request-service.ts`,
`agent-node-service.ts`). The host binds each call to the calling session
(the request's responder, the state's assigned child), never to a field of
the call, and the store decides it under its locks: the request or node must
be pending in an active run, within its deadline and contract, with an
operation id that makes a repeat return the first result, and human input
to an agent state's subtree stays refused. Design 04 accepts this trusted
in-process context for completions; its suggested REST routes
(`/session-requests/{request}/responses`, `/sessions/{id}/workflow-node/result`)
and the scoped invocation credentials it allows for them serve callers
outside a worker, so they are not part of this milestone. The credential
surface built for them earlier (migration 0102, the two routes, the
credential vault and the MCP tools over it) was removed from this candidate
before any deployment; no database outside disposable test schemas ran 0102.

## Authoring skills (design 04; R24, T124)

Three on-demand skills in `packages/sdk/plugins/workflow-v2/skills`:

- `workflow-authoring` (the core): when a workflow fits, how to choose each
  state type, bounded graphs, data flow and bindings, scripts, typed
  contracts, agent and parallel states, the draft, test, publish and start
  lifecycle, run control, failure diagnosis and review fan-out.
- `workflow-reference`: every root key and state field with its limits, each
  state's outputs, the runtime error codes, the tool operations and their
  arguments, the refusals an author can fix, and what is not supported.
- `workflow-testing`: the test operations, interception ids, valid answers,
  fixtures, the virtual clock, test evidence and scenario planning.

Each skill describes the implemented syntax only; the design examples'
`transition.function`, `request:` and `timeout` spellings are listed as not
supported; `interface` is documented with the agent state. Each complete example (`# example:` blocks) is
compiled by a unit test with the milestone options and has no diagnostics;
together they use every state type.

No worker tier loads the directory (`WORKFLOW_V2_SKILLS_DIR`); a test passes
it as a skill directory. The standard base adds a short discovery pointer
(`WORKFLOW_AUTHORING_POINTER`) after the workflow guidance only when the
worker loaded `workflow-authoring` from that directory, so every other prompt
is unchanged. The agent state's wrapper reaches its child without the skill.

## The agent tools on a turn of a 1.9.0 worker (R26, T125)

A turn of a worker that runs controller 1.9.0 (the test-only switch) gets a
workflow host that starts 1.9.0 runs (`requests`), so the parent's own
tools take what that controller runs: `spawn_workflow` and
`replace_definition` compile request, agent and parallel states, and
`update_workflow` takes `stop`, `test`, `test_respond` and `test_advance`.
The tool descriptions on such a turn say the same
(`SPAWN_WORKFLOW_MILESTONE_TOOL_SPEC`, `UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC`,
`READ_WORKFLOW_MILESTONE_TOOL_SPEC`, chosen by the bridge's
`workflowMilestone` flag), and an unknown operation's refusal names every
operation that host takes. Every other turn keeps the production
descriptions, parameters, refusals and host byte for byte. A unit test
checks the descriptions against the handler: each added operation and
argument is taken behind the same gate, refused elsewhere, and the
reference skill's operation table names exactly the operations the
description lists.

The model sees the same tools. The Copilot CLI shows the model only the
tools declared when its handle is created or resumed (session-manager,
`ManagedSession.subAgentToolDefs`); a turn's handlers only refresh the
handler map. So the turn's config carries the flags (set by the runTurn
activity, never kept from an earlier turn): `workflowMilestoneTurn` declares
the milestone descriptions and `respond_session_request`, and
`workflowAgentChild` (an agent state's own child, from its stored lineage,
read before the session is created or resumed) also declares
`complete_workflow_node`. A declared tool always has a handler, which
refuses without the turn's bridge. A turn whose flags differ from the
handle's gets a new handle at the turn boundary, as any declaration change
does. Every other session's declarations are unchanged. Unit tests check
the declarations of each flag and the handles a session gets as its flags
change; the native agent-state cases check that each turn gives the session
manager those flags (an agent state's own child `workflowAgentChild`, a
session outside every agent state never). The first full-worker run found
this gap: the child's model request had no `complete_workflow_node`,
because only its turn's handlers had it; the native-fixture tests call the
bridge directly and their session manager declares nothing, so they did not
see it.

Both names are reserved platform tool names (`WORKFLOW_TURN_TOOL_NAMES`,
`reserved-tool-names.ts`), whatever a session declares: an ordinary session
never declares them, so without that a package or capability tool of either
name would pass validation and then be declared twice beside the platform's
on a 1.9.0 turn. The worker quarantines a package whose worker module
exports one (as for every reserved name: its agents and tools are not
installed, and the worker's reported state names the conflict), and a
capability selection of one is refused (or, when not strict, unavailable as
a whole). Unlike the rest of the milestone, this reservation applies on
every worker, active or not: it refuses those two names only and grants
nothing, and ordinary sessions' declarations and permissions are
unchanged. Unit and local regressions check each path.

Such a turn's publications pin their named agents from the agent registry
(`resolveAgent`, `agent-resolver.ts`). A worker created with the test-only
option `testOptions.workflowRequests` also creates agent states' children
(below); on any other host an agent state fails `unavailable`. No deployed
worker enables controller 1.9.0: that is an activation decision.

## A worker that runs the milestone (test-only option; R09 to R11, R18)

`PilotSwarmWorkerOptions.testOptions.workflowRequests` (default off; the SDK
reads no environment variable for it; the deployed entry points set it only
for the test environment switch below) makes a `PilotSwarmWorker` run
controller 1.9.0. The worker then loads `workflow/v2/milestone-worker.ts`,
which nothing else imports, and:

- registers 1.9.0 with request, agent and parallel states
  (`registerWorkflowV2` `workflowRequests`), and declares the
  workflow-request activity tag those activities are routed with;
- builds the agent host of agent states: `createWorkflowAgentNodeHost` with
  the registry-backed resolver over the agent registry and this worker's
  own deployment and system agents (`agent-resolver.ts`, as its
  publications pin), and `clientWorkflowAgentChildCreator` over a
  `PilotSwarmClient` of the worker's own store;
- serves the durable intake's session orchestration (1.0.83, continuing as
  new to itself) with its turn activities (`runTurnV5`, which give an agent
  state's child `complete_workflow_node`) and its intake activities, and
  starts agent states' children at 1.0.83
  (`PilotSwarmClient._startSessionsAt`, internal; its default stays the
  latest version). Sessions started at the latest version (1.0.82) run and
  continue as new as before, and 1.0.83 stays out of the registry.

A full worker test (`workflow-v2-agent-worker.test.js`, the Copilot CLI with
a scripted model) runs a published workflow's agent state that names the
worker's deployment agent: the child is created under the workflow, owned as
its owner, bound to that agent, at 1.0.83; its real turn completes the state
through `complete_workflow_node`; the run completes; the controller ends the
child. Its second case runs a registry package agent pinned at an earlier
revision after a republish, and a later publication's child at the new
revision (R18, T070; "Publication pins and test evidence" above). The unit
guards that keep the durable intake inactive now allow
exactly this module: only it imports 1.0.83 and the intake activities, and
only it declares the tag for a worker (controller 1.9.0 routes its own
activities with it); the worker loads it once, dynamically, behind the
option.

Not an activation: duroxide cannot route orchestration items by version, so
every worker that can fetch 1.9.0 or 1.0.83 work must run the same option
(the request design's activation gate, 8.4, stays required).

**The test environment switch (test-only; isolated test environments
only).** `PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT`, exactly
`isolated-test-only` (no other spelling, no spaces), is read by the deployed
entry points and passes the options above (`test-environment.ts`,
`workflowV2TestEnvironmentFromEnv`): the headless worker
(`packages/sdk/examples/worker.js`, the `worker` image) and the portal's
embedded workers get `testOptions.workflowRequests`; the portal
(`packages/app/web/server.js`, `portalRuntimeOptions`) and the MCP server
(`workflowContextOptionsFromEnv`) get `workflowCommands: { requests: true }`,
so a person's commands, stop and the test operations included, are taken and
advertised (`workflows.v2.commands`). Unset, empty or any other value is
off, and every option is exactly as without it (unit tests prove it for the
worker, the portal, its embedded workers and MCP). Each entry point logs one
line when the variable is set (ON, or ignored). Production defaults,
`DURABLE_SESSION_LATEST_VERSION` (1.0.82) and the orchestration registry do
not change, so this is not an activation; every worker that shares the
environment's database must run the same image with the same value. Script
states still need `PILOTSWARM_WORKFLOW_SCRIPTS=1`. The deploy README
(`deploy/scripts/README.md`) and the configuration reference name it.

## Run deadline (design 02 run lifecycle, D03; canonical `limits`)

```yaml
limits: { maxNodeExecutions: 100, timeoutSeconds: 3600, onExceeded: expired }
```

- **Compile.** `limits.timeoutSeconds` (an integer from 1 to 2,592,000) and
  `onExceeded` (`expired`, the default and only policy) compile to IR 8 only
  with run limits enabled (`enableRunLimits`, set by a host that starts
  1.9.0 runs); elsewhere they are refused with
  `WORKFLOW_FEATURE_UNSUPPORTED`, so no definition that a 1.8.0 run would
  not enforce is published. A definition without a deadline keeps its IR
  byte for byte.
- **The deadline.** The begin transaction writes it once (migration 0100,
  `workflow_runs.deadline_at`): the run's clock when it begins plus the
  seconds. A test run counts on its virtual clock. Pause does not stop it
  (D03).
- **Enforcement, by the run's own clock.** Past the deadline the store admits
  no node execution (refusal `expired`, before a stop's refusal), and
  controller 1.9.0's collection reports it. The controller then asks the
  store to expire the run (`expireRun`): in one transaction every node
  execution still pending is cancelled with winner `deadline`, a pending
  send to a workflow is decided with it, and the run ends `failed` with the
  error `timed_out` (details: the limit, the seconds, the deadline, whether
  the run was paused or stopping, and what was cancelled). The effects of
  cancelled scripts are asked to stop, agent children are ended as for any
  end, and the parent is told. A live run's controller also times the
  deadline itself; when the store's clock has not reached it yet, the store
  reports the time left and the controller waits again. The first end
  stands: a cancel or a deletion that came first is kept.
- **Test runs.** `test_advance` never decides a deadline after the run's own:
  the run expires first and its expiry cancels those states. An answer to an
  interception after the expiry is refused (`RUN_ENDED`).
- **Reading.** `read_workflow` shows `run.deadline` for a run with one.

Not covered: another `onExceeded` policy (the design names only
`expired`), a deadline given by a binding, and the UI's display of the run
deadline.

## Version and capability fence (design 02 compatibility and rollout; T120 to T122)

Design 02 requires that reader support precede new writes, that an
unsupported capability refuses or queues work explicitly instead of being
partly interpreted, and that a new-version run is never pointed at a legacy
interpreter. This build adds the fence that the hosts of every build after
it rely on:

- **Admission by IR.** A host that starts 1.8.0 runs reads a revision's IR
  version without parsing it (`readRevisionIrVersion`) and refuses to
  publish (`publish`, `publish_and_start`) or start (`start`) a revision of
  IR 7 or 8 (request, agent or parallel states, or a run deadline) with
  `CONTROLLER_UNAVAILABLE` (the revision, its IR version and the controller
  it needs), before anything is written. Such a revision can exist only as a
  draft that a 1.9.0 host saved; a 1.9.0 host publishes and starts it. A
  definition of IR 6 or earlier is published and started as before.
- **A run keeps its controller version.** A run is started, recovered and
  reported at the controller version it recorded at admission (migration
  0096; a run admitted earlier recorded none and is a 1.8.0 run), never at
  the acting host's version: a 1.9.0 host recovers a 1.8.0 run at 1.8.0, and
  a 1.8.0 host refuses to start or recover a 1.9.0 run
  (`CONTROLLER_UNAVAILABLE`) before it records anything. Its notifier is its
  version's (1.0.0, or the tagged 1.1.0 for 1.9.0).
- **Unchanged and already explicit.** A build reads only the IR versions it
  runs (`parseWorkflowIr`'s `maxIrVersion`), refuses store rows it does not
  know (the outbox's request mode), never fetches tagged activity work it
  lacks, and fails the instances of pre-release controller versions with a
  reason (`needsRecovery`, then `recover`). Migrations are additive and run
  at every process start, so an older reader meets newer columns, which it
  ignores, never a missing one.

Still required before activation: duroxide 0.1.32 cannot route
orchestration items by version or tag, so a worker without controller 1.9.0
can still fetch, abandon and finally poison a 1.9.0 controller item. The
request design's activation gate (8.4: an enforced serving-set fence, or a
verified routing mechanism in the dependency) remains the open requirement
for that; an activity tag, a heartbeat advertisement or this admission
fence is not it. Replay of a history that a pre-release build wrote remains
blocked (fenced), not migrated.
