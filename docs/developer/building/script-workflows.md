# Script workflow sessions

A **script workflow session** runs a small state machine of **script nodes**
instead of a conversation. Each node runs one Python, Node or PowerShell
script; the script can call the same tools an agent session has; its
**outcome** picks the next node. No LLM runs inside the workflow.

A workflow session is a sibling of an agent session: it has a row in the
session list (marked `⛓`), an owner, sharing, and a transcript.

- The **live view** is the session's canvas. The worker draws the graph when
  the run starts and updates it after every step: the running node pulses,
  finished nodes show their outcome and time, taken transitions light up, and
  a table lists recent steps. The portal opens it when you open the session.
- The **transcript** is the execution log: the graph, one line per node as it
  starts and ends (outcome, duration, tool calls, output preview), and the
  final result.

Only `type: script` nodes exist. Agent nodes are deliberately not supported
yet; a definition that uses one is refused before any session is created.

## Example

```yaml
apiVersion: pilotswarm.dev/v1alpha1
kind: ScriptWorkflow
metadata:
  name: nightly-report
spec:
  entry: collect
  nodes:
    collect:
      type: script
      runtime: python          # python | node | powershell
      timeoutSeconds: 120      # optional, 1-3600, default 300
      source: |
        facts = call_tool("read_facts", {"key_pattern": context["inputs"]["keyPattern"]})
        set_result("found" if facts["count"] else "empty", {"count": facts["count"]})
      next:                    # outcome -> next node, or null to end with that outcome
        found: report
        empty: null
        failure: null
    report:
      type: script
      runtime: node
      source: |
        await callTool("store_fact", { key: "reports/latest", value: context.input });
        await setResult("done", context.input);
      next:
        done: null
```

| Rule | Detail |
|---|---|
| Node ids | A letter, then up to 63 letters, digits, `_` or `-`. At most 100 nodes. |
| Transitions | `next` maps each outcome a node may return to a node id or `null` (end). An outcome not listed fails the workflow. |
| Size limits | YAML at most 256 KB. Each node's output at most 256 KB of JSON: store larger data as a fact or artifact and pass its key. |
| Run limit | At most 1,000 node executions per run, so a loop in the graph cannot run forever. |

## What a script sees

The script's standard input is a JSON **context**, already parsed into a
variable named `context` (Python dict, JavaScript object, PowerShell object):

| Field | Value |
|---|---|
| `inputs` | The `inputs` object given when the workflow was created. |
| `input` | The previous node's output (`null` for the entry node). |
| `node`, `step`, `workflow`, `sessionId` | Where the script is running. |

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
| MCP servers | The deployment's default MCP servers (the set a generic agent gets), called as `<server>/<tool>`; each server's `tools` list applies. `list_mcp_tools` (optionally `{ "server": name }`) lists them. The worker connects to a server on a node's first call and closes the connection when the node ends. |

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
- **From the portal:** New session → *Script workflow* (in the agent chooser
  beside *Generic Session*, or *Script workflow instead* in the model step).
  The editor starts with a working example.
- **From the SDK or Web API:** `client.createScriptWorkflowSession({ yaml, inputs })`,
  or `POST /api/v1/sessions/workflow` (`createScriptWorkflowSession`).

A workflow session does not accept chat messages, answers, steers or session
messages (refused with `WORKFLOW_SESSION_NOT_CONVERSATIONAL` or a clear
error) or regeneration (refused with `REGENERATE_UNSUPPORTED`); a stop request
answers `no_active_turn`.

## Stopping a workflow

Cancel, complete and delete work as they do for an agent session: from the
portal, the management API (`cancelSession`, `completeSession`,
`deleteSession`), or a parent agent's `cancel_agent`, `complete_agent` or
`delete_agent`. The running node's script is killed (with every process it
started), the run ends as **cancelled** (complete also ends it as cancelled,
with reason "Stopped"), and the parent is told unless it asked. Delete also
removes the session.

The kill reaches the worker when the running node next renews its activity
lock, so it takes up to about half of `PILOTSWARM_WORKER_LOCK_TIMEOUT_MS`
(5 seconds by default). A command sent between two nodes stops the next node.

## Running workflows (operators)

Scripts run as child processes **on the worker**, so script workflows are
**off** until an operator turns them on:

| Setting | Effect |
|---|---|
| `PILOTSWARM_SCRIPT_WORKFLOWS=1` or `new PilotSwarmWorker({ scriptWorkflows: { enabled: true } })` | Run script workflows on this worker. |
| `PILOTSWARM_SCRIPT_WORKFLOW_PYTHON`, `PILOTSWARM_SCRIPT_WORKFLOW_PWSH`, or `scriptWorkflows.executables` | The program for a runtime. Defaults: this worker's Node, `python3`, `pwsh`. |

Turn workflows on for **every** worker of a deployment: any worker may run any
node. A worker with workflows off still runs the controller, so a node that
lands there fails the workflow with a message that names the setting, instead
of waiting. Agents on such a worker are not shown `spawn_workflow`.

Each running node holds one of the worker's activity slots
(`PILOTSWARM_WORKER_CONCURRENCY`, 2 by default) for as long as its script
runs, and agent turns use the same slots. Raise the setting, or keep nodes
short, when workflows run beside busy agents.

Isolation, in this version:

- A script gets a fresh temporary directory as its working directory and
  `HOME`, and **none of the worker's environment** except `PATH` and locale
  variables. It reaches PilotSwarm only through a loopback endpoint guarded
  by a per-run token.
- It is **not** a sandbox: the script runs as the worker's OS user, with its
  network access. Turn workflows on only where every user who can create a
  session may run code on the worker.

## Durability

Each workflow session is a duroxide orchestration (`script-workflow`,
version `1.0.0`), separate from the agent orchestration. The compiled graph
and every node result are recorded in its history, so a worker restart
resumes at the node that was running: finished nodes are never run again,
and the node that was running is run again from its start. Write nodes so
that running one twice is safe. The orchestration continues as new every 20
nodes to keep its history small.
