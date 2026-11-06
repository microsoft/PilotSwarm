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

## Sessions own their Workflows (Workflow Simplified, stage 1)

A session (a chat) owns its **Workflow Definitions** and its **Workflows**.
A Workflow is one execution of one revision of a definition; underneath, it is
still the workflow child session described here, and the engine is unchanged.
The screens use one word per idea: **Session**, **Workflow Definition**,
**Revision**, **Workflow**, **Node**, **Agent node**, **Item**, **Time limit**
and **Start**. A Workflow that was canceled reads **Canceled**; the stored
value stays `cancelled`.

- **Session list.** A Workflow is a row under its session, like a sub-agent
  (same listing, collapse and order), titled by its definition and number
  (`check-items #3`) with its state. A definition that never started has no
  row. An agent node's chat is a row under its Workflow (`summarize · agent`)
  and is read-only: `Read-only. To change this, message <the session>.`
- **Selecting a Workflow row keeps the chat.** The session's chat stays in
  the middle, and the right block switches to its **Workflow** tab on that
  Workflow. Selecting an agent node's chat shows that chat and its Workflow
  with the node selected. A link to a Workflow opens the same way.
- **The Workflow tab** sits beside the Canvas in the right block (the
  **Workflow** button in the toolbar, between Canvas and Diagnostics; one of
  the two shows at a time). Its count says how many Workflows wait for input
  or failed and were not opened yet. It toggles between **Definition** (the
  graph or the YAML of the newest revision, **Compare** for older ones,
  **Start…**) and **Workflows** (each Workflow's number, state, revision,
  start time and duration; select one to see its graph with **Node**,
  **Log** and **Variables** in a bottom panel). A failed Workflow shows its
  failure first. **Stop…** opens one dialog: **Let started nodes finish** or
  **Cancel now**; its close button says **Keep running**.
- **Start another… (Run again).** A definition that has started offers
  **Start another…** in its Definition view and its Workflows list. Its form
  asks for the inputs and sends the session's chat one message: start another
  Workflow from this definition with the same YAML, unchanged (no key or a new
  one; never renamed). The chat spawns it, and it is listed under the same
  definition as the next number. The base guidance and the authoring skill
  tell an agent the same when a person asks in words.
- **Nodes** show their type by icon, the start node, end rings, unreached
  nodes dimmed, For each counts with nouns (`2 ok · 1 failed`), failures in
  red and `ran 3 times` where a node repeated.
- **The Node panel** says, in plain words: what the node does in one
  sentence; **Now** (`Agent working since 17:43:01 · time limit 17:44:34`,
  `Done 17:42:05 · produced`); **Runs** (`Ran 3 times · last
  17:42:01–17:42:05 (4 s)`); its **Last result** as readable text; for an
  agent node its chat mode, **What the agent is told** (folded) and **Open
  the agent chat**; and **Next**, one line per outcome naming the next node,
  then what happens when it fails (`If it fails: the Workflow stops.`). It has
  no tabs of its own; the Log has the visits. The read model gives each graph
  state its `about` (description, inline prompt) and each visit its
  `enteredAt` and `endedAt` for this.
- **Agent node chats: `chat: new | continue`.** `new` (the default) gives
  each visit of an agent node a new chat. `continue` keeps one chat per
  Workflow and node (its id derived from the run and the node): each later
  visit's prompt arrives in that chat as cycle N, with the input, the
  variables now, which changed and the previous result. Every completion of
  a continued chat must name its visit (`node_execution_id`); a missing or
  foreign id is refused. A decided visit stops the chat's running turn, not
  the chat; the chat ends when the run ends, and a graceful stop ends an
  idle chat at once. If the chat ended on its own, the next open visit starts
  a new chat and says so. `continue` is refused inside a For each. Migration
  0106 drops the UNIQUE on `workflow_agent_invocations.child_session_id`.
  Each turn of a continued chat works for one visit, its turn visit: the
  open visit its prompt names, or, for a turn a timer or a sub-agent's update
  starts, the visit of the chat's newest visit prompt. A turn whose visit is
  already decided does not run (no model call). A decided visit's Stop
  (request id `workflow-cycle-stop:<visit>`) is applied only to a turn of that
  visit; a person's Stop applies as always. The step reminder and the
  completion name only the turn's own visit. When the run ends before the
  chat exists, but a spawn attempt began, the chat's end stays owed; the next
  check that finds the chat (the spawn's own, the run's cleanup, recovery)
  ends it.
  **Known limits:** after a visit times out, the next visit's prompt can wait
  behind the old turn until its abort lands, and the next visit's time limit
  runs during that wait. Results stay correct: each binds to its own visit.
  An update from a sub-agent or a timer that arrives between visits is
  recorded in the chat but is not given to the model; the next visit's prompt
  carries the current state.
- **Removed:** the Notices bell and the Publish review. Each notice moved to
  where it applies (the revision line, one line over the graph, the Workflow
  state, the Log) or went away.
- **Phone (390 px):** the Workflow tab opens as a sheet over the chat; in a
  panel, **← Graph** returns to the graph.
- **Terminal UI:** the same model. `w` opens the Workflow pane for the chat
  (its selected Workflow, an agent node chat's own Workflow at that node, else
  its newest Workflow); Esc goes back to the chat.
- **Inside a Workflow** (an agent node's chat and its sub-agents), sessions
  get no definition tools: `spawn_workflow` and `update_workflow` are not
  declared, and the server refuses them (`WORKFLOW_DEFINITION_TOOLS_REFUSED`).
  No other registry gives them either: such a session is offered no MCP
  server's `spawn_workflow` or `update_workflow` (for example the PilotSwarm
  MCP server's person-mode `update_workflow`), and a call of one is refused.
  A person's workflow command (management client, Web API
  `originatingSessionId`, MCP `originating_session_id` or an MCP server
  started with `PILOTSWARM_ORIGINATING_SESSION_ID`) that names the session it
  comes from is refused a definition operation (`replace_definition`,
  `publish`, `publish_and_start`, `start`) when that session is inside a
  Workflow (403 `WORKFLOW_DEFINITION_TOOLS_REFUSED`). Known limit: a caller
  that holds a person's credential and names no session acts as that person;
  the server cannot tell. A parent asked by its child to change a definition
  must decide on its own.
  Any other session may hand prescriptive work to a Workflow; the base
  guidance says so. Sessions inside a Workflow stop at level 3 below the
  top-level chat, and each refusal says so in words.
- **Test mode is hidden** (see [Test mode (hidden)](#test-mode-hidden)).

The rest of this page describes the workflow child underneath, its graph and
the workflow screen a Master of Agents panel still shows.

A workflow session is a sibling of an agent session: it has a row in the
session list (a connected-steps icon in the portal, `◇` in the terminal), an owner,
sharing, and a transcript. In the portal, the session details under the list
show a workflow's own rows instead of a chat's model, context, cron and agent:
**Workflow** (name and version), **Revision** (number, draft or published),
**Run** (the live run's status and outcome, or "No run yet"), **Started by**
(the parent agent's session, a link, or "You") and **Steps**; a value the
workflow screen has not read yet shows "—". Folded, the details line shows
the run. An agent session that runs a workflow step shows **Step of** (the
workflow, a link) instead of its cron.

- The **live view** occupies the main pane instead of a chat conversation.
  The graph uses the immutable workflow definition and live execution state.
  It reads top to bottom: each step sits below the step that leads to it,
  sibling branches sit side by side, and the edge that closes a loop curves
  back up beside the loop's steps. Edges are curves that never pass through
  an unrelated step. The graph is fitted to its area once, the first time it
  is shown. After that, when the area changes size (a pane opens, closes or is
  resized), the zoom stays and the graph's top-left stays in place; only **Fit
  to screen** fits it again. Its zoom and position are kept for this workflow,
  so switching tabs, panels or sessions and back shows it exactly as you left
  it. Use **Zoom in**, **Zoom out** and **Fit to screen** at its bottom left. With **Move the
  graph** (the hand, on by default) drag the background to move the graph,
  and pinch or scroll to zoom. Turn the hand off to keep the graph still while
  you scroll the page. A run's progress never moves the view; a new definition
  or revision is fitted once.
- Drag a step's box to move it, with the hand on or off; a click still
  selects the step, and a drag does not. The edges that touch a moved box
  follow it as smooth curves. Where you put the boxes is kept for you, per
  workflow, in your portal profile, and saved when you drop a box; it is kept
  through new revisions (a new step takes its automatic place). **Reset
  layout**, beside the graph's controls once a box has moved, puts every box
  back. **Fit to screen** fits the boxes where they are.
  Select a node to inspect its outcome, tools, output and recent history in
  the right-hand side pane (**Step details**). Drag the divider between the
  workflow and that pane to resize it, use the divider's arrow keys, or
  double-click it to reset its width; the width is kept for this session. On a
  phone, the side pane opens as a separate layer; return to Main to see the
  graph again. A workflow has no zen and no full screen: its side pane offers
  neither, and a workflow opened while either is on shows in the normal
  layout. On a desktop, returning to a chat brings them back as you left them;
  on a phone, opening a workflow leaves mobile zen. The worker's original canvas
  artifact remains available without changing running workflows.
- The main pane stays still: a compact header (the name, the status,
  **Graph | YAML**, the run picker and the icon tools) and, under it, the
  graph or the YAML, nothing else. The tab you choose is kept for this
  workflow. **YAML** edits a draft you may change at the tab's full height,
  with Save, Discard and its error marks; an unsaved edit is kept when you
  switch tabs or sessions. Any other revision (a published one, or a draft you
  may not change) shows read-only; its YAML is shown only to people who can
  change the workflow.
- Every panel opens in the side pane, one at a time, with its title and a
  way back to Step details: the publish or start review, the test review, a
  test run's **calls** and clock, **variables**, the draft's tools (compare
  versions, change an agent step's inputs; from the YAML tab), the run's
  **activity**, its **notices** (and a status that could not be read), and
  the **step log**. Its icon button in the header looks pressed while the
  side pane shows it; press it again for Step details. Notices and Test calls
  show how many there are. The Inputs box of a start or test review starts
  with sample data built from the workflow's input schema (examples,
  defaults, enum values, or a value by type and field name) while it is empty
  and untouched; **Sample** beside it fills it again. Selecting a step shows
  Step details again. When a
  command you sent is refused or may not have arrived, the side pane says so
  above what it shows. Until the workflow writes to the step log, it says "No
  step output yet." Before the first run, the header's status says "No run
  yet" and the run picker appears once a run exists.
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
disables it; a parent-requested stop does not send a redundant wake-up. For a
version 2 workflow, starting its live run (`update_workflow start` or
`publish_and_start`, by the agent or by a person) turns the notification on
again, even for a draft spawned with it off, unless that start passes
`notify_on_completion: false`; `read_workflow` shows the current setting as
`definition.notifyOnCompletion`.
Delivery is a separate activity with up to three attempts over 40 seconds.
A durable child receipt prevents later re-delivery after success. If a worker
dies between enqueue and receipt, the parent's normal `clientMessageIds`
deduplication covers pending messages and its last 20 consumed IDs. This is
not an unbounded exactly-once guarantee. Delivery failures are recorded as
`workflow.parent_notification_failed`; they do not replace the workflow's
terminal result. A terminal, deleted or no-longer-authorized parent is skipped.
When a version 2 live run ends and its parent is not told, the workflow records
`workflow.parent_notification_skipped` once, with the reason (`notifications
are off` or `parent is gone`); Run activity and the terminal show it ("The
parent agent was not told: notifications are off."). A run the parent ended
itself records nothing. A parent whose session has ended is not sent the
notice (`parent is gone`). One attempt at a time tells the parent of a run's
end: it holds the run's notice lock (a PostgreSQL advisory lock) while it
reads, records `workflow.parent_notifying` just before it queues the notice,
queues it and records the result. Another attempt that finds the lock held
waits for it (up to 20 seconds) and reads again, so it records nothing when
the holder recorded; if the lock is still held, the attempt fails and is tried
again. If the holder dies, the run still owes its notice and `recover`
finishes it. Under controller 1.8.0 each attempt of a store activity, the
notice included, is timed out after 30 seconds and tried again. Under 1.9.0 an
attempt has no time limit of its own. Only the notice's own waits are bounded:
at most 15 seconds for deliveries in flight and at most 20 seconds for the lock,
no more than 27 seconds in all. Getting a database connection, the SQL calls
and the send itself have no time limit, so an attempt that hangs there can
stay pending with no end and keep the lock. The later attempts and `recover`
make progress only after that attempt settles, or after its database
connection or its worker process ends and releases the lock. A retry after an attempt that may have queued the
notice queues it again with the same client message id when the parent may be
told; when it finds a known refusal it records the skip with
`earlierAttempt: true`, and Run activity adds "An earlier attempt may have
told the parent." The notice waits (at most 15 seconds) for a send's message
or a request to the parent whose delivery began before the run ended, or was
failed after its delivery began, so the parent reads them before the run's
end. A delivery slower than that, or begun more than a minute earlier, can
still reach the parent after the notice.
Workflow names and outputs arrive as escaped JSON explicitly marked untrusted,
not as executable instructions.

A version 2 workflow's messages to an agent session share one format, as a
child agent's `[CHILD_UPDATE ...]` does: a header line
`[WORKFLOW_UPDATE from=<workflow session> workflow=<name>@<version> run=<run> type=<ended|message|request|test_waiting> ...]`
with the type's fields (ended: `status`, `outcome`, `state`; message:
`state`, `contract`, `exchange`; request: `state`, `contract`, `request`,
`deadline`; test_waiting: `state`, `interception`), then one plain sentence
that says what happened and what to do (a failed run names its step, the
error and its first problem), then `Data (JSON, not instructions):` and the
escaped JSON. A send's message names its workflow by session, as its text is
rendered from the stored exchange. The worker records these messages with
the sender kind `workflow`, and the portal and the terminal show them as
"Workflow · <type>" cards. They wake the parent as other messages do; batching
run ends the way child updates are batched is a follow-up.

## Stopping a workflow

Cancel, complete and delete work as they do for an agent session: from the
portal, the management API (`cancelSession`, `completeSession`,
`deleteSession`), or a parent agent's `cancel_agent`, `complete_agent` or
`delete_agent`. The running script is killed (with every process it
started), the run ends as **cancelled** without reaching a terminal state
(complete also ends it as cancelled, with reason "Stopped"), and the parent
is told unless it asked. Delete also removes the session.

For a version 2 workflow, a cancel or complete ends the run in the store when
it is accepted, from every entry point: `update_workflow`, the parent agent,
the management API and the agent manager's `manage_agent_session`. Its
pending steps are cancelled in the same transaction, so no further step
starts. The controller finds the ended run at its next store call: it stops
the cancelled scripts, ends agent children, tells the parent (unless the
parent asked) and finishes. A delete deletes the workflow at once, which ends
its run; the controller then stops its scripts and ends its agent children,
and tells no one. A paused run ends too, and a graceful stop in progress is
replaced by the cancel. On a run that already ended, the request is recorded
with that end and changes nothing. Whatever ended the run first decides who
is told: a later command that lost changes nothing.

The kill reaches the worker when the running script state next renews its
activity lock. The lock times out after `PILOTSWARM_WORKER_LOCK_TIMEOUT_MS`
(10 seconds by default) and is renewed about every 5 seconds, so the worker
can take up to about 5 seconds to see the cancellation. It then kills the
script's process tree within about 250 milliseconds. The activity's
JavaScript is not aborted: it returns when the killed script ends. The
worker's activity slot stays held until that task ends, or at most for a
10-second grace. A command sent between two states stops the next one.

## Running workflows (operators)

### Test mode (hidden)

Testing a workflow (a test run with mocked effects, its held calls and its
virtual clock) is hidden from every surface people and agents use. Its code
and its tests stay. One deployment flag shows it again:

| Setting | Effect |
|---|---|
| `PILOTSWARM_WORKFLOW_TEST_MODE=on` (exactly `on`; off by default) | The `update_workflow` operations `test`, `test_respond` and `test_advance` are declared to agents and taken from them; a person's workflow commands (Web API, MCP) take them and the bootstrap lists them, so the portal and the terminal UI show test controls and test runs. The base guidance mentions the test notice. |

Off, agents are not declared the test operations, and an agent's tool answers
one exactly as an operation that does not exist (the unknown operation's
refusal, with no word of testing); so does a person's command (Web API, MCP).
"Absent" means an unknown operation, not an unknown route: there is no test
route, so `POST /api/v1/sessions/{id}/workflow/commands` with a test operation
answers `400 WORKFLOW_COMMAND_INVALID`, exactly as any unknown operation does
(an unknown route would be 404). The portal and the terminal UI show no test
control or test run. Stored test
runs are kept but not shown: the workflow read (SDK, Web API, MCP) does not
list them, and refuses a test run's id, as a run, a page cursor's run, an
execution's or a variables revision's, exactly as it refuses an unknown run's.
The MCP `read_workflow` description names no test part. The flag is separate
from `PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT` and changes nothing else; test
operations still need workers that run controller 1.9.0. The `workflow-testing`
guide is kept apart from the authoring skills, in
`packages/sdk/plugins/workflow-v2/test-mode-skills`, so an agent reads it only
where test mode is on. The SDK's local tests run with the flag on.

### Scripts
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

A version 2 parallel state that does not join ends with a report of its
branches (`joined: false`, `total`, `succeeded`, `failFast`, `branches`). The
report also has `timedOut` (whether the state's time limit ended it) and
`needed` (the successes its join needed). A run compiled before parallel time
limits existed (IR 8) gets both too, with `timedOut` always `false`; a report
already stored is not rewritten. These fields are added; none is removed or
changed, so read a report by the fields you use, not by its exact set of
fields. Version 2 workflows were not turned on before these fields came, so no
stored run depends on the shorter report.

Version 2 hides more secrets in workflow text than it did before. Events and
rows that were stored before this change are not rewritten. Such events and
rows exist only in development and test deployments. An old event can show a
list or object default of a binding, or part of a credential that was cut
before it was hidden. Before you share a version 2 test session from such a
deployment with other people, delete the session or create it again.

Cleanup failures are explicit. The worker attempts native-task cancellation
and disconnect even when abort fails. If it cannot confirm that tasks stopped,
it retains the folder hold and blocks a new executor on that worker pending
recovery; it does not report a successful release.

Each running script state holds one of the worker's activity slots
(`PILOTSWARM_WORKER_CONCURRENCY`, 2 by default) for as long as its script
runs, and agent turns use the same slots. Raise the setting, or keep scripts
short, when workflows run beside busy agents.

Size the slots for parallel states too. Each branch that runs a script holds
a slot until the script ends. The controller's own steps (collecting results,
admitting the next step, deciding a join, cancelling the other branches) need
a free slot as well. Keep a parallel state's `concurrency` below the worker's
slot count: set `PILOTSWARM_WORKER_CONCURRENCY` above the widest parallel
state's `concurrency` that runs scripts, plus some room for the controller and
for the agents that run there (the duroxide default is 2). With fewer slots
than running branches plus one, the branches run in waves and the controller
waits behind them, so a race's stop of its losers waits for a free slot.

Stopping a losing branch's script is best-effort, and a script runs at least
once: one whose worker loses its activity lock runs again from its start
(its attempt count goes up; see Durability). When the cancellation is
saved, the script's own liveness check usually stops it within about a
second. If both that check and the cancel request fail, the script can run
until recovery or until its own timeout (300 seconds by default, at most
3,600), and its side effects can happen. The result does not change: a join
of the first k still takes the first k successes that the store saved, in
the order it saved them, and a time limit is still decided by the store's
clock. But scheduling can change what is saved before a deadline: with too
few slots the decision comes later, and a branch that would have been
cancelled can finish first (it keeps its result and is not a winner). If a
cancelled branch's script or agent chat cannot be stopped at once, the
controller goes on and tries again at most once per wake period, also while
the run is busy with other steps and after it continues as new; the run's
end ends any agent chat still owed.

A version 2 run's controller is one duroxide orchestration, and these
duroxide limits shape it:

- It waits by racing its command queue against a durable timer. A queue
  read wins only when its message is already in the turn that duroxide
  fetched, and duroxide returns a fetched batch in the order the messages
  were stored, so the timer can win over a message that arrived before the
  timer was due. When a message wins, duroxide drops the timer from the race
  but does not remove it: the timer still fires later and adds a turn and a
  history entry. The
  controller continues as new after 25 admitted steps, or after 50 waits
  (a wait counts when its timer found nothing, and every wait counts while
  the run is paused). These counts bound the work that one execution
  repeats. They do not bound its history: wake messages, the timers that lost
  their races and the timers of retried store activities add entries that no
  count includes.
- The queue carries hints. An accepted cancel, complete or delete is store
  state: it has already ended the run, and the controller's next store call
  finds that (see Stopping a workflow). duroxide carries at most 100 unread
  queue messages into the next execution and drops the newer ones, so a
  continue-as-new can drop wake messages. It can also drop a command that an
  older build only queued, when at least 100 earlier unread messages are
  ahead of it.
- duroxide fails a turn that takes more than 100 queued messages in a row.
  The controller's read of the queue before an admission takes at most 32
  messages per batch, and a store activity comes before the next batch. A
  queued command behind more wake messages is read one or more passes later;
  a wait, a stop or the run deadline is not held back by them.
- duroxide fixes how a race between a queue read and a timer resolves when
  an execution starts, by the duroxide version that started it (the
  corrected behavior came in 0.1.31). An upgrade does not change an
  execution that an older version started; its next execution after a
  continue-as-new gets the current behavior. Version 2 workflows were added
  after PilotSwarm moved to duroxide 0.1.32 (duroxide-node 0.2.4), so no
  version 2 execution started with the older behavior. Executions of other
  orchestrations, such as version 1 workflows and agent sessions, that an
  older duroxide started keep the older behavior.

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
and the state that was running is run again from its start. A script can
also run again without a restart: when its worker stalls for longer than
its activity lock allows (`PILOTSWARM_WORKER_LOCK_TIMEOUT_MS`, renewed while
it runs), the lock is lost, that run is stopped, and another worker runs the
script from its start. Scripts run at least once, not exactly once: write
them so that running one twice is safe. The orchestration continues as new every 20
script states to keep its history small.
