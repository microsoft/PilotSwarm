---
name: workflow-patterns
description: Load when one Workflow must run different nodes in its branches at the same time (a different prompt or model for each branch), or loops back to a state (a polling loop). Named branches, the router pattern, examples that compile.
---

# Workflow patterns

Call `load_skill` with name `workflow-authoring` first. This skill adds three patterns to it.

## Different work in each branch at once: named branches

When different branches must run different nodes at the same time (a
different prompt, or a different model for each), write ONE parallel state
with named `branches`. Do not split it into several Workflows.

- Each branch is its own graph: `initial`, `states` and an optional `input`
  template (else the value that arrived).
- Its routes stay inside it. Each end is a branch end: `succeeded` is
  success. A branch has no `catchAll`; an error it does not route ends it.
- State ids are unique across the Workflow, so each agent node has its own
  `agent_models` entry at start.
- `concurrency` defaults to the number of branches: all run at once. Above
  16 branches, set it (at most 16).
- `joined` gives `{ <name>: output }`. With `join: { first: k }` (k at most
  the branches) it holds the winners only; a `blocked` or `timed_out` report
  lists every branch with its `name`.
- `${branch.name}` (a script's `context.branch.name`) names the branch.
- Give the parallel state `timeoutSeconds` and a `timed_out` route when a
  branch runs an agent: without one, the join waits as long as the slowest
  branch (the compiler warns `WORKFLOW_BRANCH_UNBOUNDED`).

```yaml
# example: two-views
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: two-views, version: "1.0.0" }
description: Summarizes one text twice at once and joins both by name.
inputs:
  schema:
    type: object
    additionalProperties: false
    required: [text]
    properties:
      text: { type: string, minLength: 1 }
initial: views
initialInput: { text: "${inputs.text}" }
states:
  views:
    type: parallel
    timeoutSeconds: 2400 # bounds the join: a branch runs an agent
    branches:
      quick:
        initial: quick_summary
        states:
          quick_summary: # its own state id: its own agent_models entry
            type: agent
            invoke: { prompt: "Summarize the text in your input in one sentence." }
            outcomes: [done]
            timeoutSeconds: 600
            transition: { next: { done: quick_done, failure: quick_failed } }
          quick_done: { type: terminal, outcome: succeeded, output: "${input}" }
          quick_failed: { type: terminal, outcome: failed, output: "${runtime.error}" }
      careful:
        initial: careful_summary
        states:
          careful_summary:
            type: agent
            invoke: { prompt: "Read the text in your input closely and summarize it in one paragraph. Keep every number and name." }
            outcomes: [done]
            timeoutSeconds: 1800
            transition: { next: { done: careful_done, failure: careful_failed } }
          careful_done: { type: terminal, outcome: succeeded, output: "${input}" }
          careful_failed: { type: terminal, outcome: failed, output: "${runtime.error}" }
    transition:
      next: { joined: done, blocked: failed, timed_out: failed, failure: failed }
  done: { type: terminal, outcome: succeeded, output: "${input}" } # { quick: ..., careful: ... }
  failed: { type: terminal, outcome: failed, output: "${input}" }
```

## When the branches are data: the router pattern

The older form, for branches that come from a list (each item names its
lane): a parallel state over the list, with a router script first in the
body that sets its outcome to the lane and routes to that lane's node.
`concurrency` is the number of lanes and `join` is `all`. Every lane ends at
one item end whose output names the lane; the results arrive in the list's
order. The router decides nothing: it reads a lane written in the list, so it
is mechanical work, which scripts may do. Judgment still goes to an agent
node. There is no switch node type.

```yaml
# example: two-lane-summary
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: two-lane-summary, version: "1.0.0" }
description: Summarizes one text twice at once, one lane per item.
inputs:
  schema:
    type: object
    additionalProperties: false
    required: [text]
    properties:
      text: { type: string, minLength: 1 }
initial: lanes
states:
  lanes:
    type: parallel
    forEach: [{ lane: quick }, { lane: careful }] # one item per lane
    concurrency: 2 # every lane at once
    join: all
    body:
      initial: route
      states:
        route:
          type: script
          timeoutSeconds: 30
          outcomes: [quick, careful]
          source: |
            await setResult(context.branch.item.lane, { lane: context.branch.item.lane, text: context.inputs.text });
          transition:
            next: { quick: quick_summary, careful: careful_summary, failure: lane_failed }
        quick_summary:
          type: agent
          invoke: { prompt: "Summarize the text in your input in one sentence." }
          outcomes: [done]
          timeoutSeconds: 600
          transition: { next: { done: lane_done, failure: lane_failed } }
        careful_summary:
          type: agent
          invoke: { prompt: "Read the text in your input closely and summarize it in one paragraph. Keep every number and name." }
          outcomes: [done]
          timeoutSeconds: 1800
          transition: { next: { done: lane_done, failure: lane_failed } }
        lane_done:
          type: terminal
          outcome: succeeded
          output: { lane: "${branch.item.lane}", summary: "${input}" }
        lane_failed:
          type: terminal
          outcome: failed
          output: { lane: "${branch.item.lane}", error: "${runtime.error}" }
    transition:
      next: { joined: done, blocked: failed, failure: failed }
  done: { type: terminal, outcome: succeeded, output: "${input}" }
  failed: { type: terminal, outcome: failed, output: "${input}" }
```

## A polling loop

A route back to a state brings it the previous state's output. Here
`check_ci`'s closed `inputSchema` refuses `ciState`, so `wait_ci` maps the
output back with `input:`; KV is read with a default. `get_ci_state` stands
for a tool of your own.

```yaml
# example: ci-poll
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: ci-poll, version: "1.0.0" }
description: Checks CI until it is not pending.
initial: check_ci
initialInput: { checks: 0 }
states:
  check_ci:
    type: script
    inputSchema: { type: object, additionalProperties: false, required: [checks], properties: { checks: { type: integer } } }
    outcomes: [pending, done]
    source: |
      const checks = context.input.checks + 1;
      const { state } = await callTool("get_ci_state", {});
      const most = context.kv.maxChecks ?? 30; // KV may be unset
      await setResult(state === "pending" && checks < most ? "pending" : "done", { checks, ciState: state });
    transition: { next: { pending: wait_ci, done: done, failure: failed } }
  wait_ci:
    type: wait
    seconds: "${kv.pollSeconds ?? 60}"
    input: { checks: "${input.checks}" } # what check_ci takes, not ciState
    transition: { next: { elapsed: check_ci, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "${input}" }
  failed: { type: terminal, outcome: failed, output: "${runtime.error}" }
```

## Testing these patterns

A test's fixtures (`workflow-tools`) answer by state id, so each branch's
agent node has its own: `{ operation: agent, state: quick_summary, ... }`
and `{ operation: agent, state: careful_summary, ... }`. A For each body's
node runs once per item; one fixture answers every item, and `visit`
counts per item. In a loop, `visit: n` answers the n-th round of a state;
a fixture without `visit` answers the other rounds. A receive gets its
message from `{ operation: receive, state: <id>, visit?, response: { kind:
success, value: <message> } }`. The report's `path` names each step's
`branch` (its name, or `item N`) and `enteredBy`.
