---
name: workflow-patterns
description: Load when one Workflow must run different nodes in its branches at the same time (a different prompt, or a different model for each branch). It has named branches, the router pattern, and complete examples that compile.
---

# Workflow patterns

Load `workflow-authoring` first. This skill adds two patterns to it.

## Different work in each branch at once: named branches

When different branches must run different nodes at the same time (a
different prompt, or a different model for each), write ONE parallel state
with named `branches`. Do not split it into several Workflows.

- Each branch is its own small graph: `initial`, `states`, and an optional
  `input` template (without one, it gets the value that arrived).
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
description: Summarizes one text twice at once, quickly and carefully, each branch on its own agent node, then joins both by name.
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
    timeoutSeconds: 2400                             # bounds the join: a branch runs an agent
    branches:
      quick:
        initial: quick_summary
        states:
          quick_summary:                             # its own state id: its own agent_models entry
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
  done: { type: terminal, outcome: succeeded, output: "${input}" }   # { quick: ..., careful: ... }
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
description: Summarizes one text twice at once, quickly and carefully, each lane on its own agent node, then joins both.
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
    forEach: [{ lane: quick }, { lane: careful }]   # one item per lane, written here
    concurrency: 2                                   # every lane at once
    join: all
    body:
      initial: route
      states:
        route:                                       # routes on the lane written in the list: no judgment
          type: script
          timeoutSeconds: 30
          outcomes: [quick, careful]
          source: |
            await setResult(context.branch.item.lane, { lane: context.branch.item.lane, text: context.inputs.text });
          transition:
            next: { quick: quick_summary, careful: careful_summary, failure: lane_failed }
        quick_summary:                               # its own state id: its own agent_models entry
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
        lane_done:                                   # one item end for every lane; its output names the lane
          type: terminal
          outcome: succeeded
          output: { lane: "${branch.item.lane}", summary: "${input}" }
        lane_failed:
          type: terminal
          outcome: failed
          output: { lane: "${branch.item.lane}", error: "${runtime.error}" }
    transition:
      next: { joined: done, blocked: failed, failure: failed }
  done: { type: terminal, outcome: succeeded, output: "${input}" }   # [quick lane's result, careful lane's result]
  failed: { type: terminal, outcome: failed, output: "${input}" }
```
