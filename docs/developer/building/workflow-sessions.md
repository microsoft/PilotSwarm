# Workflow sessions

A **workflow session** runs a durable state machine instead of a
conversation. No LLM runs inside it. A workflow document names its
**states**, the **initial** state, and how each state's **outcome** leads to
the next state. A run ends at a **terminal** state, or, when its loop passes
through a **wait** state, runs until it is cancelled.

This version runs three state types:

| Type | What it does |
|---|---|
| `script` | Runs one Node, Python or PowerShell script. The script can call the tools of the agent that started the workflow, minus an excluded list; it reports an outcome, which picks the next state. |
| `wait` | Waits a fixed time, or until a clock time such as 02:00 every day, on a durable timer, then goes to its next state. No process runs and no model is called while it waits. This is how a workflow polls or repeats. |
| `terminal` | Ends the run with an outcome: `succeeded`, `blocked`, `failed` or `cancelled`, an optional summary and an optional output. |

Other state types of the workflow language (`agent`, `question`, `action`,
`observed-condition`), `transition.handler` and `identity` are planned; a
document that uses one is refused with "not supported yet" before any session
is created.

A workflow session is always the **child of an agent session**: an agent
starts it with `spawn_workflow`, and there is no top-level workflow. It has a
row in the session list (marked `⛓`) under its parent, the parent's owner,
sharing, and a transcript.

- The **live view** is the session's canvas. The worker draws the graph when
  the run starts and updates it after every step: the running state pulses,
  finished states show their outcome and time, taken transitions light up,
  the terminal state reached is marked, and a table lists recent steps. The
  portal opens it when you open the session.
- The **transcript** is the execution log: the graph, one line per state as
  it starts and ends (outcome, duration, tool calls, output preview), and the
  terminal state reached.

## Example

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
    runtime: node              # node (preferred) | python | powershell
    timeoutSeconds: 120        # optional, 1-3600, default 300
    source: |
      const facts = await callTool("read_facts", { key_pattern: context.inputs.keyPattern });
      await setResult(facts.count ? "found" : "empty", { count: facts.count });
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
| States | Ids are a letter, then up to 63 letters, digits, `_` or `-`; at most 100 states. `initial` must be a script or wait state. A workflow needs a terminal state, or a wait state if it runs until cancelled. |
| Transitions | `completion.outcomes` lists every outcome a script state may return; `transition.next` maps **each** of them to a state, and nothing else. An outcome not listed fails the run. |
| Inputs | `inputs` declares types (`string`, `number`, `integer`, `boolean`, `object`, `array`) and `required`. A run whose inputs do not match is refused; undeclared inputs pass through. |
| Terminal output | `output` may hold values that are exactly one `${inputs.x}`, `${configuration.x}` or `${states.<id>.result...}` expression (the latest output of that state). Inside a `{ }` flow mapping, quote it: `output: { total: "${states.sum.result}" }`. |
| Session status | A terminal outcome `succeeded` or `blocked` ends the session `completed`; `failed` ends it `failed`; `cancelled` ends it `cancelled`. |
| Size limits | YAML at most 256 KB. Each state's output at most 256 KB of JSON: store larger data as a fact or artifact and pass its key. |
| Wait states | Exactly one of `seconds` (a whole number from 60 to 604,800, which is 7 days) or `at` (a clock time, below); `transition: { next: <state id> }` (or `{ next: { elapsed: <state id> } }`). A wait has no `completion`. The script after a wait receives, as `context.input`, the output of the script before it. |
| Clock waits | `at` takes the fields of the agent `cron_at` tool: `minute`, `hour`, `day_of_week` (0-6, Sunday 0) or `day_of_month` (1-31), and `tz` (an IANA zone, required). `minute` alone is hourly; with `hour`, daily; add a day for weekly or monthly. The wait ends at the next such time **after** it starts, with the same daylight-saving rules as `cron_at`. |
| Run limit | At most 1,000 script-state executions between two waits. A loop that waits may run until it is cancelled; a loop of scripts with no wait fails, so it cannot spin. |

## Polling and repeating work

Put the schedule in the graph. "Every 10 minutes, check for failed builds and
handle them" is one workflow whose check loops back through a wait:

```yaml
initial: check
states:
  check:
    type: script
    runtime: node
    source: |
      const failed = await callTool("ci/list_failed_builds", {});
      await setResult(failed.length ? "found" : "idle", failed);
    completion: { outcomes: [found, idle] }
    transition: { next: { found: handle, idle: sleep } }
  handle:
    type: script
    runtime: node
    source: |
      await callTool("send_session_message", { session_id: context.inputs.triager, subject: "Failed builds", body: JSON.stringify(context.input) });
      await setResult("done", null);
    completion: { outcomes: [done] }
    transition: { next: { done: sleep } }
  sleep:
    type: wait
    seconds: 600
    transition: { next: check }
```

For "every night at 02:00", use a clock wait instead of `seconds`:

```yaml
  nightly:
    type: wait
    at: { hour: 2, minute: 0, tz: America/Los_Angeles }
    transition: { next: run-report }
```

An agent writes this once and calls `spawn_workflow` once. After that the
checks and the waits cost no model tokens; only the message that wakes an
agent when there is work does. Agent `cron` plus `spawn_workflow` on every
wake also works, but each wake costs a model turn, so the `spawn_workflow`
tool tells models to put polling inside the workflow instead. On workers that
run workflows, `cron` and `cron_at` describe themselves as being for wake-ups
that need the agent's own judgment, and send checks a script can do to
`spawn_workflow`. Elsewhere they keep their usual wording. Turn workflows on
for all workers of a deployment or none, so every session sees the same
wording.

A workflow like this runs until it is cancelled (`cancel_agent` from its
parent, or Cancel in the portal). Its canvas shows the wait state as
waiting, with the time it ends, and a `×N` counter on each state that ran more
than once. The orchestration continues as new every 20 states, so its history
stays small however long it runs; the session's event log grows by a few rows
per loop.

## What a script sees

The script's standard input is a JSON **context**, already parsed into a
variable named `context` (Python dict, JavaScript object, PowerShell object):

| Field | Value |
|---|---|
| `inputs` | The `inputs` object given when the workflow was created. |
| `input` | The previous state's output (`null` for the initial state). |
| `node` (the state id), `step`, `workflow`, `sessionId` | Where the script is running. |

Helpers, one set per runtime:

| | Call a tool | Report the result |
|---|---|---|
| Python | `call_tool(name, args)` | `set_result(outcome, output)` |
| Node (ES module, top-level `await`) | `await callTool(name, args)` | `await setResult(outcome, output)` |
| PowerShell 7 | `Invoke-PilotSwarmTool -Name -Arguments` | `Set-PilotSwarmResult -Outcome -Output` |

If a script reports nothing, its result comes from the last stdout line when
that is a JSON object with a string `outcome`; otherwise exit code 0 is
outcome `success` (output: the last 16 KB of stdout), any other exit code is
`failure` (output: `{ exitCode, stderr }`), and running past the timeout is
`timeout`. Route `failure` and `timeout` in `next` to handle them; otherwise
they fail the workflow. A state ends when its script exits: any process the
script started that is still running is killed then (on Linux and macOS, the
whole process group).

## Tools a script can call

**The rule: the workflow's tools are its parent agent's tools, minus an
excluded list.** (The design follows Affan Dar's parent-native tool
executor.)

1. When the agent calls `spawn_workflow`, the worker reads the tools the
   agent's live Copilot CLI session offers at that moment: the CLI's own
   tools (`bash` or `powershell`, `view`, `edit`, search, ...), its worker
   and package tools, and its MCP tools. It removes the excluded list below
   and the tools the agent itself has excluded, and saves the result (with
   the agent's session config and capability selections) next to the start
   request. A script can never add a tool: the saved set is never taken
   from the YAML, a tool argument or a public payload.
2. Each script state that calls a tool gets its own Copilot CLI **tool
   session**, configured like the parent (model provider, bound agent,
   tools, MCP servers, capability selections, working folder), limited to
   the saved tools, with no skills, custom agents, file hooks or custom
   instructions. **No prompt is ever sent to it**: the CLI runs each tool the
   script names through its normal tool and permission path. The session
   opens at the state's first tool call (a state that calls no tool starts
   none) and is closed when the state ends: its background shells are
   stopped, it is disconnected and its local state is removed.
3. Calls run one at a time, in the order the script makes them, at most 500
   per state, **as the workflow session**: facts are stored on that session
   and are visible across its spawn tree, inspect tools act as its owner,
   and messages are sent from it. `list_sessions`, `send_session_message`
   and `reply_session_message` return JSON, not the text an agent sees.

A script names a tool by its CLI name; an MCP tool also as
`<server>/<tool>`. A tool's result reaches the script as structured data
when the tool returns it (PilotSwarm's own tools do), otherwise as its text.

**Excluded list.** A script has no conversation and no turn, and it must not
change what its parent may do:

| Group | Tools | Why |
|---|---|---|
| Scheduling | `wait`, `wait_on_worker`, `cron`, `cron_at`, schedule tools | A script cannot pause or schedule wake-ups; a `wait` state is the workflow's pause. |
| Delegation | `task`, `spawn_agent`, `spawn_workflow`, `message_agent`, `complete_agent`, `cancel_agent`, `delete_agent`, `wait_for_agents`, ... | A script cannot start or manage agents or workflows. |
| Conversation | `ask_user`, `report_cycle`, `task_complete`, `send_message`, `send_and_wait` | There is no conversation to ask in or report to. |
| Lifecycle | `stop_session`, `delete_session`, `fork_session`, `regenerate_context`, `regenerate_agent`, cleanup tools | A script cannot stop, restart, fork or clean up sessions. |
| Capabilities | `set_session_model`, `use_package`, `load_agent`, `set_session_workspace`, factory and deployment tools | A script cannot change models, packages, agents, folders or deployment settings. |
| Sampling and context | `execute_sampling`, `mcp_sampling`, `context_health` | A script never asks a model for anything and has no model context. |

A name is matched on its last `/` or `.` segment too, so an MCP tool called
`wait` is excluded like the built-in one. Three arguments are refused even
for an allowed tool: `detach: true` on `bash` or `powershell` (a shell must
end with its state), `load_skill` with `path` or `unload`, and
`send_session_message` with `expects_response: true` (a workflow cannot
receive replies). The tool session's permission handler approves the
ordinary permission kinds (shell, read, write, MCP, URL, custom tool) once
per request and rejects MCP sampling and any unknown kind, so no tool can
start a model request.

**When a call fails.** Before every call the worker checks again that the
tool is still the parent's. The call is refused when:

| Code | When |
|---|---|
| `WORKFLOW_TOOL_EXCLUDED` | The tool is on the excluded list. |
| `WORKFLOW_TOOL_NOT_GRANTED` | The tool was not the parent's when it called `spawn_workflow`. |
| `WORKFLOW_TOOL_UNAVAILABLE` | The tool is no longer offered (for example its package dropped it). |
| `WORKFLOW_PARENT_AUTHORITY_LOST` | The parent agent session ended or was deleted. |
| `WORKFLOW_OWNER_CHANGED` | The owner of the parent or the workflow changed. |
| `WORKFLOW_CAPABILITY_REVOKED` | The parent's capability selection that gave this tool was removed. Other tools still work. |
| `WORKFLOW_TOOL_ARGUMENTS_REFUSED` | One of the arguments above. |

A new version of a tool's package, a changed bound-agent definition or a
changed input schema does **not** refuse a call: the call runs against the
current version. The saved set records each tool's schema hash and the
package revisions it was captured with, for reference only.

A failed or refused call is raised in the script (a JavaScript `Error`, a
Python `RuntimeError`, a PowerShell error) with the code at the start of
its message, so the script can catch it.

## Script languages

**Prefer `runtime: node`.** A node script runs on the worker's own Node
(a release in the SDK's engines range, `^24.22.1` or `>=26.12.1`) under
Node's permission model, with file reads and writes allowed only in the
state's scratch folder: it cannot read or write
other files, start processes or worker threads, or load native addons. Use
the tools (`view`, `edit`, `bash`) for files and commands; they run through
the parent's permissions. The permission model guards against a script
reaching the worker's files **by accident**; it is not a sandbox for hostile
code, and it does not limit network access.

**Python and PowerShell** scripts run as plain processes with the worker's
OS user, which is what a shell tool gives an agent. They are allowed only
when the parent's saved tools include a shell (`bash`, or `powershell` on
Windows). Otherwise `spawn_workflow` refuses the workflow before anything is
created, with `WORKFLOW_RUNTIME_REQUIRES_SHELL`: "Python and PowerShell
scripts need the parent agent to have a shell tool (bash or powershell);
use runtime: node."

## Starting a workflow

- **From an agent:** the `spawn_workflow(yaml, inputs?, notify_on_completion?, key?)`
  tool starts the workflow as a **child** of the agent session and returns at
  once. The agent receives the result as a system message when the workflow
  ends. A user can describe the steps in words; the agent writes the YAML.
- **On a schedule:** ask an agent to repeat it ("every night at 2, run ...").
  The agent writes one workflow that loops through a `wait` state (a clock
  time with `at`, or `seconds`) and calls `spawn_workflow` once; see
  [Polling and repeating work](#polling-and-repeating-work). Pass `key` only to
  guard against a repeated call: the same key names the same workflow session.
- **From the SDK (direct mode):**
  `client.createWorkflowSession({ yaml, inputs, parentSessionId, notifyParent?, sessionId? })`
  checks the request and the parent, but a new workflow also needs the
  parent's tools, captured from its live session by `spawn_workflow` on the
  parent's worker. Without them the call is refused with
  `WORKFLOW_PARENT_CONTEXT_REQUIRED`: there is no generic tool set to fall
  back to. Ask the agent to start the workflow instead. The Web API, the
  portal and the TUI do not start workflows; in web mode the method refuses.
  Registering a workflow from YAML in the portal is a possible later
  feature.

An invalid document or inputs that do not match its `inputs` schema are
refused with status 400 and a code such as `WORKFLOW_INVALID`,
`WORKFLOW_STATE_TYPE_UNSUPPORTED` or `WORKFLOW_INPUT_INVALID`. The parent is
checked when the workflow is created:

| Code | Status | When |
|---|---|---|
| `WORKFLOW_PARENT_REQUIRED` | 400 | No `parentSessionId`. |
| `WORKFLOW_PARENT_INVALID` | 400 | The parent does not exist or was deleted, has ended (`completed`, `failed` or `cancelled`), is itself a workflow session, or has a different owner than the caller; or the captured tools belong to another parent or owner. The message names the reason. |
| `WORKFLOW_PARENT_CONTEXT_REQUIRED` | 400 | No captured parent tools: the call did not come from `spawn_workflow` in the parent's turn (or a saved request has none). |
| `WORKFLOW_TOOLS_NOT_DELEGABLE` | 400 | The parent has in-memory hooks or a permission handler, which a workflow cannot carry to another worker. |
| `WORKFLOW_RUNTIME_REQUIRES_SHELL` | 400 | A Python or PowerShell state, and no shell among the parent's tools. |

The workflow's owner is the parent's owner (through its lineage, as for a
sub-agent). `spawn_workflow` reports each refusal to the agent as a
`[SYSTEM: spawn_workflow refused — ...]` line.

**The start request is saved.** The first create stores the full start
request (the YAML, the inputs, the parent and the notification setting) in
the session's creation config, and the run always starts from that saved
copy. A second create with the same session id compares its request with
the saved one (object key order does not matter):

- The same request returns the existing session without a second run. If
  the first create stopped before it started the run, the second one starts
  it from the saved copy.
- A different request is refused with `WORKFLOW_ADMISSION_CONFLICT` (409).
  For `spawn_workflow`, that is the same `key` with a different YAML, inputs
  or `notify_on_completion`.
- A deleted session id starts a new run. While the deleted run has not
  ended yet, the create is refused with `WORKFLOW_SESSION_ENDING` (409).

A workflow session does not accept chat messages, answers, steers or session
messages (refused with `WORKFLOW_SESSION_NOT_CONVERSATIONAL` or a clear
error) or regeneration (refused with `REGENERATE_UNSUPPORTED`). A workflow has
no turns, so a stop request answers `no_active_turn` without touching the run,
and the portal and TUI offer no Stop for it. Pause and resume are not supported
yet; cancel is the way to stop a run.

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

Workflows are **off** until an operator lists the state types a worker runs.
Script states run as child processes **on the worker**, so `script` is an
explicit choice:

| Setting | Effect |
|---|---|
| `PILOTSWARM_WORKFLOW_STATE_TYPES=script` or `new PilotSwarmWorker({ workflows: { stateTypes: ["script"] } })` | Run workflows with script states on this worker. Later state types join the list, for example `script,agent,question`. |
| Unset, blank or malformed | Workflows are off. A malformed list (an unknown or empty entry) is ignored with a warning in the worker log. `wait` and `terminal` states run nothing and are never listed. |
| `PILOTSWARM_WORKFLOW_PYTHON`, `PILOTSWARM_WORKFLOW_PWSH`, or `workflows.executables` | The program for python and powershell. Defaults: `python3`, `pwsh`. Node scripts always run on this worker's own Node (`^24.22.1` or `>=26.12.1`), so its permission model applies. |
| `PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS` | The shortest wait a document may declare (default 60). Lower it only for development and tests; set the same value on clients and workers, because both check documents. |

Set the **same list on every worker** of a deployment: any worker may run any
state. A worker that does not run a workflow's state types still runs the
controller, so the workflow fails there at its start, or at that state, with a
message that names the type and the setting instead of waiting. Agents on a
worker with workflows off are not shown `spawn_workflow`.

A script state that calls tools also starts one Copilot CLI tool session
for as long as it runs (see [Tools a script can call](#tools-a-script-can-call)).

Each running script state holds one of the worker's activity slots
(`PILOTSWARM_WORKER_CONCURRENCY`, 2 by default) for as long as its script
runs, and agent turns use the same slots. Raise the setting, or keep scripts
short, when workflows run beside busy agents.

Isolation, in this version:

- A script gets a fresh temporary directory as its working directory and
  `HOME`, and **none of the worker's environment** except `PATH` and locale
  variables. It reaches PilotSwarm only through a loopback endpoint guarded
  by a per-run token.
- A node script runs under Node's permission model: files only in its
  scratch folder, no child processes (see [Script languages](#script-languages)).
  This guards against accidents; it is not a sandbox.
- A Python or PowerShell script is **not** sandboxed at all: it runs as the
  worker's OS user, with its network access, which is why it needs a parent
  with a shell tool. Whatever that user can read, the script can read too,
  including the worker's own process environment and that of other running
  scripts (for example through `/proc` on Linux), so a script can reach the
  worker's credentials and act as another workflow that is running at the
  same time. Turn scripts on only where every user who can create a session
  may run code on the worker.

## Durability

Each workflow session is a duroxide orchestration (`workflow-session`,
version `1.0.0`), separate from the agent orchestration. The compiled graph
and every state's result are recorded in its history, so a worker restart
resumes at the state that was running: finished states are never run again,
and the state that was running is run again from its start. Write scripts so
that running one twice is safe. A wait is a durable timer in the
orchestration's history: its end time is worked out once, when it starts,
and recorded, so a restarted worker resumes it where it was and later
time-zone data cannot move it. One exception: duroxide timers count from when
they are created, so a restart in the moment between working out the end and
creating the timer makes that wait end late by the length of the outage. A
wait never ends early. A cancel ends a run that is waiting. The orchestration continues as new every
20 states to keep its history small.

## Testing

`npm run test:local:workflows` runs every workflow test that needs no model
and no deployment: the compiler and portal unit tests, the Duroxide runtime
tests, and real-worker runs on PostgreSQL with the real Copilot CLI and a
scripted model (no tokens): the parent is a live agent session, so its tools
can be captured. It needs `DATABASE_URL`; set
`PS_TEST_PWSH` to a PowerShell outside `PATH` if needed. One of these runs is a
synthetic workflow that uses Python, Node and PowerShell states, loops past
one continue-as-new, routes a non-zero exit and a timeout as outcomes, calls
tools, and checks that every state ran exactly once. Another runs a polling
loop through wait states to the end with no model, and one is cancelled while
it waits. Python and PowerShell states fall back to Node where those runtimes
are not installed. `workflow-tool-session.test.js` calls a worker tool, an
MCP tool and the CLI's `bash` and `view` and shows that no model request was
made; it also covers an excluded tool, a revoked capability and an ended
parent during a run, a cancel during a tool call (the background shell and
the tool session stop), and a node script refused a file outside its
scratch folder.

`test/local/workflow-live-model.test.js` checks that a real model turns a
polling request into one `spawn_workflow` with a wait loop and no `cron`. It
runs only where a model provider is configured, and skips otherwise.

The portal's workflow browser tests run with Playwright:
`npm run test:e2e --workspace=pilotswarm -- workflow-session`.
