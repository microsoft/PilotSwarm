---
name: workflow-limits
description: "Size limits, session/Workflow depth (max level 2), and parallel continued-session rules for Workflow runs: inputs, outputs, joins, carry, messages, child results, variables, and script tool calls."
---

# Workflow limits

Sizes are bytes of canonical JSON (UTF-8); 1 KiB = 1,024 bytes. A value over
a limit is refused: nothing is cut short. Store large data as an artifact or a
fact and pass its key.

| What | Limit | Over the limit |
|---|---|---|
| Run inputs (Start) | 256 KiB | Start refused |
| A state's input, after its `input:` mapping | 256 KiB | the state fails `invalid_input` |
| A state's output (script `setResult`, any state) | 256 KiB | the state fails `invalid_output` |
| An agent step's result (`complete_workflow_node`) | 256 KiB | refused; the agent is told to use an artifact |
| A parallel branch's output | 256 KiB | the branch fails `invalid_output` |
| A parallel join's output (all branches together) | 256 KiB | the parallel state fails `invalid_output` |
| A timed-out parallel state's report | 248 KiB | outputs and errors dropped, `truncated: true` |
| The run's output (terminal `output`) | 256 KiB | the run fails `invalid_output` |
| `carry` | 64 KiB | the state fails |
| `{ carry, result }` that a carry state passes on | 256 KiB | the receiving state fails `invalid_input` |
| JSON nesting, anywhere | 64 levels | refused |
| A `send` or `request` message (the state's input) | 16 KiB | the state fails `invalid_input` |
| `correlate` | 4 KiB | the state fails `invalid_input` |
| A request's response or decline | 16 KiB | `RESPONSE_INVALID` |
| Typed input (`send_workflow_input`); for a list receive, its `{ contract, from, payload }` too | 256 KiB | refused |
| A child's `WorkflowEnded@1`, measured whole as a list receive inside a carry passes it on (the output is a little less) | 195,584 bytes (about 190 KiB) | the output is left out: `outputTruncated: true` |
| `child_workflows` `read` | 2,000-character preview; `full_output: true` gives the whole output | |
| Variables (KV) | 1,000 keys of at most 128 characters; 256 KiB a value; 1 MiB in all | refused |
| A script's tool call: its arguments / its result | 1 MiB each | the call fails |
| Tool calls in one script visit (a live run) | 500 | the call fails |
| `read_workflow` with `execution_id`: one step's value | whole up to 256 KiB, else a 4,000-character preview | |
| `read_workflow` without it: `run.output` / `kv` and `inputs` | 2,000 / 4,000-character previews | |

## Fan-out: keep only what you need from each child

A child's output (up to about 190 KiB) arrives whole. It fits the receiving
state's input, but a later limit still applies: two 150 KiB children whose
branches end with `output: "${input}"` fail the join (256 KiB); a 20 KiB child
output sent on as it arrived fails the `send` (16 KiB); a run output or a
collecting script that holds several whole outputs fails at 256 KiB.

Keep only what you need from each child: in the branch,
`output: { outcome: "${input.outcome}", workflowId: "${input.workflowId}" }`;
in a list receive, `${input.payload.outcome}`. Read the full result with
`child_workflows` `read` `full_output: true` in a script, only where it is
needed. Saving warns `WORKFLOW_ENDED_WHOLE_OUTPUT` where a whole child output
reaches a join, a message or the run's output with no mapping in between.

A single child whose whole output is the run's output fits: no mapping is
needed there.

## Session and Workflow depth (max level 2)

Nothing goes past level 2: each sub-agent or Workflow is one level below
whoever started it, but the first Workflow in a chain is free (`+0`), and an
agent step sits at its Workflow's level (`+0`). Workflows may nest three deep
(`0 -> 1 -> 2`), and platform system sessions (and their system children) start again at level `0`.

| Session | Level |
|---|---|
| Top-level session | `0` |
| Sub-agent | parent's level `+ 1` |
| First Workflow in a chain | starter's level (`+0`, free) |
| Any later Workflow (`spawn` child) | starter's level `+ 1` |
| Workflow agent step | its Workflow's level (`+0`) |
| Platform system session (all-system ancestry) | resets to `0` |
| Native task | no level; cannot delegate |
| Anything above level `2` | refused |

In practice (effective levels in parentheses):
- Top-level Workflow: `person (0) -> Workflow (0, free) -> agent step (0) -> sub-agent (1) -> sub-agent (2)` (delegates two sub-agent levels down, matching a top-level session).
- Child Workflow: `person (0) -> batch Workflow (0, free) -> child Workflow (1) -> agent step (1) -> sub-agent (2)` (a child Workflow's agent step sits at level `1` and CAN spawn a level-`2` sub-agent with `spawn_agent`, such as an independent reviewer).
- Level-2 Workflow: `person (0) -> W1 (0, free) -> W2 (1) -> W3 (2) -> agent step (2)`, or `person (0) -> sub (1) -> sub (2) -> W1 (2, free) -> agent step (2)` (Workflows nest three deep; a level-2 Workflow's agent step sits at level `2` and cannot delegate further).
- Nothing inside a Workflow can save, change, or start a Workflow Definition
  (`WORKFLOW_DEFINITION_TOOLS_REFUSED`); declare child Workflows with `spawn` steps.
- Width limits apply alongside depth: at most 50 running sub-agents and active
  Workflows per session; 64 parallel branches (16 concurrent), 100 states, and
  1,000 state visits by default (10,000 max) per Workflow.

## Continued agent sessions in parallel states

- Named `branches:` allow explicit `session: continue` (omitting `session:` still defaults to `new`): one continued agent session per `(runId, stateId)` across both intra-branch loops and outer-loop re-entries of the enclosing `parallel` state.
- `forEach` bodies allow `session: new` only (`session: continue` is refused because items run side by side).
- Upgrade note: any revision saved invalid before `session: continue` in named `branches:` was allowed must be saved again as a new revision to start.
