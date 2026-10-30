# Workflow sessions

A **workflow session** runs a durable state machine instead of a
conversation. No LLM runs inside it. A workflow document names its
**states**, the **initial** state, and how each state's **outcome** leads to
the next state; every run ends at a **terminal** state.

This version runs two state types:

| Type | What it does |
|---|---|
| `script` | Runs one Python, Node or PowerShell script. The script can call the same tools an agent session has; it reports an outcome, which picks the next state. |
| `terminal` | Ends the run with an outcome: `succeeded`, `blocked`, `failed` or `cancelled`, an optional summary and an optional output. |

Other state types of the workflow language (`agent`, `question`, `action`,
`observed-condition`), `transition.handler` and `identity` are planned; a
document that uses one is refused with "not supported yet" before any session
is created.

A workflow session is a sibling of an agent session: it has a row in the
session list (marked `⛓`), an owner, sharing, and a transcript.

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
    runtime: python            # python | node | powershell
    timeoutSeconds: 120        # optional, 1-3600, default 300
    source: |
      facts = call_tool("read_facts", {"key_pattern": context["inputs"]["keyPattern"]})
      set_result("found" if facts["count"] else "empty", {"count": facts["count"]})
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
outcome `success` (output: stdout), any other exit code is `failure` (output:
`{ exitCode, stderr }`), and running past the timeout is `timeout`. Route
`failure` and `timeout` in `next` to handle them; otherwise they fail the
workflow.

## Tools a script can call

Scripts call tools **as the workflow session**: facts are stored on that
session and are visible across its spawn tree, inspect tools act as its
owner, and messages are sent from it, exactly as for an agent session. The
set is what a generic agent session has:

| Tools | Notes |
|---|---|
| The worker tools the deployment's base and default agents list | `registerTools` plus the default agent's `tools:`, for example `write_artifact`, `read_artifact`, `ps_list_agents` |
| Fact tools, and graph tools when a graph store is configured | `store_fact`, `read_facts`, `facts_search`, ... |
| Session tools | `list_sessions` and `read_agent_events` (and the usage reads). `send_session_message` is one-way: a workflow session cannot receive replies. `reply_session_message` answers a request another session sent. These return JSON, not the text an agent sees. |
| MCP servers | The deployment's default MCP servers (the set a generic agent gets), called as `<server>/<tool>`; each server's `tools` list applies. `list_mcp_tools` (optionally `{ "server": name }`) lists them. The worker connects to a server on a script state's first call and closes the connection when that state ends. |

Not available: turn-control tools (`wait`, `cron`, `ask_user`, `spawn_agent`,
`spawn_workflow`, canvas tools), because a script has no conversation turn;
tools from agent packages and MCP servers granted only to named agents,
because they belong to those agents; and `context_health`, which reports on
an LLM context.

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
- **From the portal:** New session → *Workflow* (in the agent chooser
  beside *Generic Session*, or *Workflow instead* in the model step).
  The editor starts with a working example.
- **From the SDK or Web API:** `client.createWorkflowSession({ yaml, inputs })`,
  or `POST /api/v1/sessions/workflow` (`createWorkflowSession`). An invalid
  document or inputs that do not match its `inputs` schema are refused with
  status 400 and a code such as `WORKFLOW_INVALID`,
  `WORKFLOW_STATE_TYPE_UNSUPPORTED` or `WORKFLOW_INPUT_INVALID`.

A workflow session does not accept chat messages, answers, steers or session
messages (refused with `WORKFLOW_SESSION_NOT_CONVERSATIONAL` or a clear
error) or regeneration (refused with `REGENERATE_UNSUPPORTED`); a stop request
answers `no_active_turn`.

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

Each running script state holds one of the worker's activity slots
(`PILOTSWARM_WORKER_CONCURRENCY`, 2 by default) for as long as its script
runs, and agent turns use the same slots. Raise the setting, or keep scripts
short, when workflows run beside busy agents.

Isolation, in this version:

- A script gets a fresh temporary directory as its working directory and
  `HOME`, and **none of the worker's environment** except `PATH` and locale
  variables. It reaches PilotSwarm only through a loopback endpoint guarded
  by a per-run token.
- It is **not** a sandbox: the script runs as the worker's OS user, with its
  network access. Turn scripts on only where every user who can create a
  session may run code on the worker.

## Durability

Each workflow session is a duroxide orchestration (`workflow-session`,
version `1.0.0`), separate from the agent orchestration. The compiled graph
and every state's result are recorded in its history, so a worker restart
resumes at the state that was running: finished states are never run again,
and the state that was running is run again from its start. Write scripts so
that running one twice is safe. The orchestration continues as new every 20
script states to keep its history small.
