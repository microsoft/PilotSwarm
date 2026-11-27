---
name: workflow-limits
description: "The size limits a Workflow run meets, in one table: inputs, state outputs, joins, carry, messages, child results, variables and script tool calls. Load when data may be large or a fan-out collects child results."
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
| A child's output in its `WorkflowEnded@1` | 195,584 bytes (about 190 KiB) | left out: `outputTruncated: true` |
| `child_workflows` `read` | 2,000-character preview; `full_output: true` gives the whole output | |
| Variables (KV) | 1,000 keys of at most 128 characters; 256 KiB a value; 1 MiB in all | refused |
| A script's tool call: its arguments / its result | 1 MiB each | the call fails |
| Tool calls in one script visit (a live run) | 500 | the call fails |
| `read_workflow` value | whole up to 256 KiB, else a 4,000-character preview | |

## Fan-out: keep only what you need from each child

A child's output (up to 195,584 bytes) arrives whole. It fits the receiving
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
