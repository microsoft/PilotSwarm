# Workflow sessions

A **workflow session** runs a durable state machine instead of a
conversation. No LLM runs inside it. A workflow document names its
**states**, the **initial** state, and how each state's **outcome** leads to
the next state; every run ends at a **terminal** state.

This version runs two state types:

| Type | What it does |
|---|---|
| `script` | Runs JavaScript on Node for a new workflow. It invokes the parent's captured permitted tools without a model turn and reports an outcome to select the next state. |
| `terminal` | Ends the run with an outcome: `succeeded`, `blocked`, `failed` or `cancelled`, an optional summary and an optional output. |

Other state types of the workflow language (`agent`, `question`, `action`,
`observed-condition`), `transition.handler` and `identity` are planned; a
document that uses one is refused with "not supported yet" before any session
is created.

A workflow session is a sibling of an agent session: it has a row in the
session list (a connected-steps icon in the portal, `◇` in the terminal), an owner,
sharing, and a transcript.

- The **live view** occupies the main pane instead of a chat conversation.
  The graph uses the immutable workflow definition and live execution state.
  It reads top to bottom: each step sits below the step that leads to it,
  sibling branches sit side by side, and the edge that closes a loop curves
  back up beside the loop's steps. Edges are curves that never pass through
  an unrelated step. The graph opens fitted to its area. Use **Zoom in**,
  **Zoom out** and **Fit to screen** at its bottom left. With **Move the
  graph** (the hand, on by default) drag the background to move the graph,
  and pinch or scroll to zoom; turn it off to keep the graph still while you
  scroll the page. A run's progress never moves the view; a new definition or
  revision fits it again.
  Select a node to inspect its outcome, tools, output and recent history in
  the right-hand canvas pane. Drag the divider between the workflow and that
  pane to resize it, use the divider's arrow keys, or double-click it to reset
  its width; the width is kept for this session. On a phone, node details open
  as a separate layer; return to Main to see the graph and log again. The
  worker's original canvas artifact remains available without changing
  running workflows.
- The pane shows the workflow's header and its graph. The **step log**, the
  run's **activity**, its **notices** and a test run's **calls** each open
  from their own button in the header (Notices and Test calls show how many
  there are), and close the same way. With the step log open, drag its
  divider, use the divider's arrow keys, or double-click to reset its height.
- The **transcript** starts with a compact, expandable definition. Repeated
  healthy self-loop checks update one progress row with an increasing count,
  the last outcome and check time. Expand it for the most recent 40 checks
  and latest output. Changes, errors and terminal results remain separate.
  Raw execution events are unchanged; partial history labels its count as
  loaded checks rather than claiming the whole run. The workflow screen has
  no message box: nobody types into a workflow.

## Example

The base instructions explain when to prefer a finite workflow over repeated
parent model turns, when an ordinary agent is needed, and how to choose
completion notifications. This guidance applies only when `spawn_workflow` is
available and never expands tool permissions or approval scope.

Scripts read the previous state's result as `context.input` and initial
parameters as `context.inputs`. A bare `input` variable is not defined. Each
script is a Node ES module: use `await setResult(...)`, not a top-level
`return`. Preserve data needed by later steps in the output you pass forward.

```yaml
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata:
  name: nightly-report
  version: 1.0.0
inputs:                        # optional; checked when a run is created
  keyPattern: { type: string, required: true }
initial: collect
states:
  collect:
    type: script
    runtime: node              # new admissions are JavaScript-only
    timeoutSeconds: 120        # optional, 1-3600, default 300
    source: |
      const facts = await callTool("read_facts", {key_pattern: context.inputs.keyPattern});
      await setResult(facts.count ? "found" : "empty", {count: facts.count});
    completion: { outcomes: [found, empty, failure] }
    transition:
      next: { found: report, empty: nothing, failure: failed }
  report:
    type: script
    runtime: node
    source: |
      await callTool("store_fact", { key: "reports/latest", value: context.input });
      await setResult("done", context.input);
    completion: { outcomes: [done] }
    transition:
      next: { done: published }
  published:
    type: terminal
    outcome: succeeded
    summary: Report published.
    output: ${states.report.result}
  nothing: { type: terminal, outcome: blocked, summary: No facts matched. }
  failed: { type: terminal, outcome: failed, summary: Could not read facts. }
```

| Rule | Detail |
|---|---|
| Document | `apiVersion: pilotswarm.dev/v1alpha1`, `kind: Workflow`, `metadata.name` and `metadata.version` are required. |
| States | Ids are a letter, then up to 63 letters, digits, `_` or `-`; at most 100 states. `initial` must be a script state; at least one terminal state is required. |
| Transitions | `completion.outcomes` lists every outcome a script state may return; `transition.next` maps **each** of them to a state, and nothing else. An outcome not listed fails the run. |
| Inputs | `inputs` declares types (`string`, `number`, `integer`, `boolean`, `object`, `array`) and `required`. A run whose inputs do not match is refused; undeclared inputs pass through. |
| Terminal output | `output` may hold values that are exactly one `${inputs.x}`, `${configuration.x}` or `${states.<id>.result...}` expression (the latest output of that state). Inside a `{ }` flow mapping, quote it: `output: { total: "${states.sum.result}" }`. |
| Session status | A terminal outcome `succeeded` or `blocked` ends the session `completed`; `failed` ends it `failed`; `cancelled` ends it `cancelled`. |
| Size limits | YAML at most 256 KB. Each state's output at most 256 KB of JSON: store larger data as a fact or artifact and pass its key. |
| Run limit | At most 1,000 script-state executions per run, so a loop in the graph cannot run forever. |
| Poll delay | New child workflows may declare `transition.delaySeconds: { unchanged: 30 }`. Keys must be declared outcomes; values are integer seconds from 1 to 3,600. The controller waits after that outcome, without occupying a script process or waking the parent. |

## What a script sees

The script's standard input is a JSON **context**, already parsed into a
variable named `context` (a JavaScript object for new runs):

| Field | Value |
|---|---|
| `inputs` | The `inputs` object given when the workflow was created. |
| `input` | The previous state's output (`null` for the initial state). |
| `node` (the state id), `step`, `workflow`, `sessionId` | Where the script is running. |

New runs use the Node helpers. Historical Python/PowerShell definitions remain
executable only for workflows admitted before the parent-tool policy:

| | Call a tool | Report the result |
|---|---|---|
| Python | `call_tool(name, args)` | `set_result(outcome, output)` |
| Node (ES module, top-level `await`) | `await callTool(name, args)` | `await setResult(outcome, output)` |
| PowerShell 7 | `Invoke-PilotSwarmTool -Name -Arguments` | `Set-PilotSwarmResult -Outcome -Output` |

If a script reports nothing, its result comes from the last stdout line when
that is a JSON object with a string `outcome`; otherwise exit code 0 is
outcome `success` (output: stdout), any other exit code is `failure` (output:
`{ exitCode, stderr }`), and running past the timeout is `timeout`. Route
`failure` and `timeout` in `next` to handle them; otherwise they fail the
workflow.

## Tools a script can call

Scripts call tools **as the workflow session**: facts are stored on that
session and are visible across its spawn tree, inspect tools act as its
owner, and messages are sent from it, exactly as for an agent session. The
set is captured from the actual parent's effective tool catalog, excluding
durable scheduling, delegation, lifecycle and capability-changing operations.
The worker creates a separate CLI execution handle; it does not borrow the
live parent handle or send a model prompt.

| Tools | Notes |
|---|---|
| Native Copilot tools | Actual shell, file, search and edit implementations through `session.rpc.tools.execute`, subject to normal permissions and workspace scope |
| Registered application and package tools | Only the captured parent-authorized binding; package access is not replaced with generic defaults |
| Fact tools, and graph tools when a graph store is configured | `store_fact`, `read_facts`, `facts_search`, ... |
| Session tools | `list_sessions` and `read_agent_events` (and the usage reads). `send_session_message` is one-way: a workflow session cannot receive replies. `reply_session_message` answers a request another session sent. These return JSON, not the text an agent sees. |
| MCP servers | Captured parent-authorized servers/tools through the CLI; `<server>/<tool>` aliases must resolve uniquely |

Not available: turn-control tools (`wait`, `cron`, `ask_user`, `spawn_agent`,
`spawn_workflow`, native `task`), lifecycle and capability-changing tools, and
`context_health`. Existing approved application tools retain their authority;
a generated confirmation flag is not human approval. Parent capability
removal or a changed source binding can stop later calls, but newly added
parent tools do not enlarge an admitted run.

MCP sampling is refused: an MCP tool cannot request an extra model turn.
Native shell `detach: true` is also refused. The captured workspace stays
fixed if the parent navigates to another folder. A terminal or deleted parent,
revoked capability, changed tool schema or changed package binding stops later
tool calls. A named parent's agent identity supplies the same authorization
context; the child session remains the source of execution events and facts.

Parent policies and tools that exist only as in-memory callbacks cannot be
delegated durably and are refused at admission. Use registered tool/policy
implementations. Native background shell handles belong to one script state;
they are stopped before that state's executor closes, not carried to another
state or worker.

A stdio MCP server is started with a small default environment (`PATH`,
`HOME`, ...) plus the `env` of its configuration, not the worker's full
environment; pass what a server needs through its configuration.

A failed tool call is raised in the script (a Python `RuntimeError`, a
JavaScript `Error`, a PowerShell error), so the script can catch it.

## Starting a workflow

- **From an agent:** the `spawn_workflow(yaml, inputs?, notify_on_completion?, key?)`
  tool starts the workflow as a **child** of the agent session and returns at
  once. The agent receives the result as a system message when the workflow
  ends. A user can describe the steps in words; the agent writes the YAML.
- **On a schedule:** ask an agent to repeat it ("every night at 2, run ...").
  The agent sets `cron`/`cron_at` and calls `spawn_workflow` on each wake-up;
  each run is its own child workflow session. Pass `key` to make a call
  idempotent (the same key returns the same workflow session).
- **New top-level creation is deferred:** ask an agent to start the child with
  `spawn_workflow`. The portal explains this requirement. New root SDK/API
  starts fail with `WORKFLOW_PARENT_REQUIRED`; no generic tool set is
  substituted for a missing parent. Already-admitted workflows retain their
  execution behavior.
- **Internal creation:** the inline bridge calls `createWorkflowSession`
  with its host-captured parent grant. An invalid
  document or inputs that do not match its `inputs` schema are refused with
  status 400 and a code such as `WORKFLOW_INVALID`,
  `WORKFLOW_STATE_TYPE_UNSUPPORTED` or `WORKFLOW_INPUT_INVALID`.

A workflow session does not accept chat messages, answers, steers or session
messages (refused with `WORKFLOW_SESSION_NOT_CONVERSATIONAL` or a clear
error) or regeneration (refused with `REGENERATE_UNSUPPORTED`); a stop request
answers `no_active_turn`.

The first admitted definition, inputs, owner, parent and tool grant are
immutable. Retrying a pending creation with the same key resumes its stored
start after a catalog/start interruption. A different definition or owner
conflicts; a completed run does not restart. There is no automatic sweep for
a pending creation that is never retried.

## Finite change watchers

A watcher can read a query and linked pull-request snapshot, retain the
baseline in `context.input`, and return `unchanged` until a meaningful
difference appears:

```yaml
completion: { outcomes: [unchanged, changed, expired] }
transition:
  next: { unchanged: poll, changed: report, expired: no_change }
  delaySeconds: { unchanged: 30 }
```

Only a terminal result wakes the parent. The watcher ends on the first change;
it does not automatically start again. Include an explicit poll-count or time
limit and a terminal `expired` path. The global 1,000-step bound is a final
safety limit, not a recommended watcher lifetime. Store a large delta as an
artifact and return its reference; the parent message contains a short preview.

Completion notification is on by default. `notify_on_completion: false`
disables it; a parent-requested stop does not send a redundant wake-up.
Delivery is a separate activity with up to three attempts over 40 seconds.
A durable child receipt prevents later re-delivery after success. If a worker
dies between enqueue and receipt, the parent's normal `clientMessageIds`
deduplication covers pending messages and its last 20 consumed IDs. This is
not an unbounded exactly-once guarantee. Delivery failures are recorded as
`workflow.parent_notification_failed`; they do not replace the workflow's
terminal result. A terminal, deleted or no-longer-authorized parent is skipped.
Workflow names and outputs arrive as escaped JSON explicitly marked untrusted,
not as executable instructions.

## Stopping a workflow

Cancel, complete and delete work as they do for an agent session: from the
portal, the management API (`cancelSession`, `completeSession`,
`deleteSession`), or a parent agent's `cancel_agent`, `complete_agent` or
`delete_agent`. The running script is killed (with every process it
started), the run ends as **cancelled** without reaching a terminal state
(complete also ends it as cancelled, with reason "Stopped"), and the parent
is told unless it asked. Delete also removes the session.

The kill reaches the worker when the running script state next renews its
activity lock, so it takes up to about half of
`PILOTSWARM_WORKER_LOCK_TIMEOUT_MS` (5 seconds by default). A command sent
between two states stops the next one.

## Running workflows (operators)

Scripts run as child processes **on the worker**, so script states are
**off** until an operator turns them on:

| Setting | Effect |
|---|---|
| `PILOTSWARM_WORKFLOW_SCRIPTS=1` or `new PilotSwarmWorker({ workflowScripts: { enabled: true } })` | Run workflow script states on this worker. |
| `PILOTSWARM_WORKFLOW_PYTHON`, `PILOTSWARM_WORKFLOW_PWSH`, or `workflowScripts.executables` | The program for a runtime. Defaults: this worker's Node, `python3`, `pwsh`. |

Turn scripts on for **every** worker of a deployment: any worker may run any
state. A worker with scripts off still runs the controller, so a workflow
with script states fails there at its start, or at its next script state,
with a message that names the setting instead of waiting. Agents on such a
worker are not shown `spawn_workflow`.

Upgrade workers before admitting new child workflows. New runs use controller
`workflow-session@1.1.0` and `workflow.child.*` activities; workers that only
know the old controller cannot execute them. Do not admit new runs into a
mixed-version worker fleet. Existing runs keep controller `1.0.0`, its activity
names and its version at continue-as-new, including historical runtimes.
The new delay completes before continue-as-new; irrelevant messages do not
restart a completed poll or reset its deadline.

Cleanup failures are explicit. The worker attempts native-task cancellation
and disconnect even when abort fails. If it cannot confirm that tasks stopped,
it retains the folder hold and blocks a new executor on that worker pending
recovery; it does not report a successful release.

Each running script state holds one of the worker's activity slots
(`PILOTSWARM_WORKER_CONCURRENCY`, 2 by default) for as long as its script
runs, and agent turns use the same slots. Raise the setting, or keep scripts
short, when workflows run beside busy agents.

Isolation, in this version:

- A script gets a fresh temporary directory as its working directory and
  `HOME`, and **none of the worker's environment** except `PATH` and locale
  variables. It reaches PilotSwarm only through a loopback endpoint guarded
  by a per-run token.
- New runs use Node's `--permission` with filesystem grants limited to their
  own bootstrap/scratch directory, without direct child-process, worker-thread
  or native-addon permission. This prevents accidental direct filesystem
  access; it is **not** a hostile-code or network sandbox.
- Native shell/file tools execute outside that script guardrail under their
  own captured permission and workspace policies. Granting a shell tool still
  grants its authorized effects. The script's Node flags do not restrict a
  brokered shell process.
- The persisted policy marker selects this behavior. Unmarked, already-admitted
  workflows keep the legacy runtime; a deployment must not change their
  Python/PowerShell history into Node implicitly. Old workers must be drained
  before admitting the new policy, because they do not enforce it.

## Durability

Each workflow session is a duroxide orchestration (`workflow-session`,
version `1.0.0`), separate from the agent orchestration. The compiled graph
and every state's result are recorded in its history, so a worker restart
resumes at the state that was running: finished states are never run again,
and the state that was running is run again from its start. Write scripts so
that running one twice is safe. The orchestration continues as new every 20
script states to keep its history small.
