# Workflow Loop Simplification

| | |
|---|---|
| Status | IMPLEMENTED |
| Scope | Multi-contract `receive`, `${states.<id>.output}` bindings, `maxVisits`, and `wait.totalSeconds` |

## 1. Problem

A **bookkeeping state** is a script state that calls no tool and makes no decision. It exists only to reshape or copy data so that a later state can read it.

Four engine rules caused bookkeeping states in polling and child-tracking loops:

1. Each state's output replaced its input. Preserving data across a state required `carry`, wrapping the next state's input as `{ carry, result }` and forcing an unwrap script on every round.
2. A `receive` state accepted only one contract, forcing separate receive states or timeouts when a parent listened for both progress messages and `WorkflowEnded@1`.
3. States had no per-state visit cap (only run-wide `limits.maxNodeExecutions`), forcing a script to count rounds.
4. A `receive` state's `wait.seconds` reset on every visit, forcing a script to compute remaining time across a loop.

## 2. The Three Changes

### A. Multi-contract `receive`

`contract` on `type: messaging, mode: receive` accepts either one contract name (unchanged in behavior and stored IR) or a list of 2 to 8 distinct contract names (each a declared root contract or the built-in `WorkflowEnded@1`).

```yaml
wait_child:
  type: messaging
  mode: receive
  contract: [Progress@1, WorkflowEnded@1]
  from: "${states.spawn_worker.output.workflowId}"
  transition:
    next:
      Progress@1: record_progress
      WorkflowEnded@1: done
      failure: failed
```

- **Outcomes:** With a list, each listed contract name is an outcome that requires a route in `transition.next`, plus `elapsed` when `wait` is set. `received` is rejected for list form.
- **Output:** `{ contract, from, payload }`, where `from` is the sender's session ID.
- **Selection:** Entry claims the earliest accepted, unconsumed inbox message whose contract is in the list (`from` and `correlate` apply to every listed contract). An arriving message completes a pending receive when its contract is in the list; unlisted contracts remain unclaimed. A message that arrives at or after a receive's deadline is queued, not taken; the visit ends `elapsed`; the message stays in the inbox until its TTL.
- **Single-contract form:** Unchanged (`received` outcome, raw payload output, unchanged stored IR).
- **Test mode:** A `receive` fixture for a multi-contract receive supplies `{ contract, payload }` naming one of the listed contracts.
- **UI:** Shared portal and TUI views list all contracts on the node, display contract names on edges, and show the contract and resolved sender name (omitting raw session IDs when unnamed) on each visit.

### B. Read the Latest Output of an Earlier State (`${states.<id>.output}`)

A new binding root `states` exposes `${states.<id>.output}` (with optional nested path segments and `?? <JSON literal>` defaults):

- **Validation:** Save rejects unknown state IDs, `states` in `initialInput`, any member other than `.output`, and any reference to a state inside a parallel body from outside that exact branch (root states, root terminals, or sibling branches fail at compile time).
- **Value:** The result of the most recent visit of state `<id>` that finished with a business result (a failed visit does not replace it), visible from the reader's own parallel branch or the root scope outside the parallel state; `null` (or the `??` default) when none exists.
- **Freezing:** Evaluated once at state entry and frozen for that visit, alongside `input:` and `carry`.
- **Scripts:** Scripts receive earlier outputs through the state's existing `input:` mapping (for example `input: { child: "${states.spawn_worker.output}" }`). No `context.states` object is added to the script runtime.
- **`carry`:** Unchanged; continue using `carry` for values that must remain frozen across failures or overwrites.

### C. Per-State Visit Cap and Total Wait on Receive

| Field | Rule |
|---|---|
| `maxVisits: N` (any non-terminal state) | Integer `1` to `10,000`. Decided first at entry, before `carry` and `input:` evaluation: visit `N + 1` does not run `carry`, `input:`, or its effect, and finishes immediately at entry with outcome `exhausted` and the state's incoming value as output. Requires an `exhausted` route in `transition.next` (routed out of the loop); collides with any business outcome or Decision choice label named `exhausted`. |
| `wait: { totalSeconds: N }` (`receive`) | Integer `1` to `86,400`, or one whole-string binding. Mutually exclusive with `wait.seconds`. The total budget starts at the first visit and never resets in a run; the binding is read on the first visit only and stored as visit 1's absolute `deadline_at` (even if visit 1 completes at entry); a receive inside an outer loop uses per-visit `wait.seconds`. On later visits, if no time remains, the state finishes immediately with `elapsed` (emitting `workflow.state_completed`); otherwise the timer runs for the remaining duration. |

## 3. Worked Example: Child Progress Tracker

**Before (7 states, 2 bookkeeping scripts):** `spawn_worker`, `init_tracker`, `wait_progress`, `record_progress`, `wait_ended`, `done`, `failed`.

**After (5 states, 1 script doing list accumulation — complete compilable definition):**

```yaml
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: child-progress-tracker
  version: "1.0.0"
contracts:
  Progress@1:
    schema:
      type: object
      required: [step, of, note]
      properties:
        step: { type: integer }
        of: { type: integer }
        note: { type: string }
initial: spawn_worker
states:
  spawn_worker:
    type: spawn
    definition: progress-worker
    transition: { next: { started: wait_child, failure: failed } }
  wait_child:
    type: messaging
    mode: receive
    contract: [Progress@1, WorkflowEnded@1]
    from: "${states.spawn_worker.output.workflowId}"
    wait: { totalSeconds: 120 }
    transition:
      next: { Progress@1: record_progress, WorkflowEnded@1: done, elapsed: failed, failure: failed }
  record_progress:
    type: script
    input: { before: "${states.record_progress.output.progress ?? []}", item: "${input.payload}" }
    outcomes: [more]
    source: |
      const { before, item } = context.input;
      await setResult("more", { progress: [...before, item] });
    transition: { next: { more: wait_child, failure: failed } }
  done:
    type: terminal
    outcome: succeeded
    output:
      progress: "${states.record_progress.output.progress ?? []}"
      childStatus: "${input.payload.status}"
      childOutput: "${input.payload.output ?? null}"
  failed: { type: terminal, outcome: failed, output: "${runtime.error}" }
```

If the child fails after step 1, visit 2 of `wait_child` receives `WorkflowEnded@1` immediately without waiting for a progress timeout.

## 4. State Reduction Summary

| Example Workflow | Before | After | Removed Bookkeeping |
|---|---|---|---|
| `child-progress-tracker` | 7 states, 2 scripts | 5 states, 1 script | Initializer script, second receive, and `carry` unwrap/re-pack |
| `child-command-monitor` | 13 states, 4 scripts | 11 states, 2 scripts | Two state-copying scripts and three `carry` blocks; `maxVisits` bounds polling rounds |
| `multi-child-collector` | 9 states, 3 scripts | 8–9 states, 2 scripts | Deadline initializer script (`wait.totalSeconds`) and `carry` unwrapping |

## 5. Compatibility and Storage

- **No schema migration:** `workflow_node_executions.receive_contract` stores a single contract as `"Name@1"` and a multi-contract list as comma-joined `"Progress@1,WorkflowEnded@1"` (contract names cannot contain commas). Visit 1 of a `wait.totalSeconds` receive stores its fixed absolute deadline in the existing `deadline_at` column.
- **No controller orchestration change:** Immediate completion at entry (`exhausted`, expired `wait.totalSeconds`, pre-queued list-receive claims) and `${states.<id>.output}` evaluation happen in node entry and store admission, keeping controller version `1.3.0`.
- **Formal model:** Bounded TLA+ model and TLC scripts live under `docs/proposals/workflow-simpler-loops/formal/`.
- **Non-goals:** General expression evaluation (append, arithmetic, comparisons), list-form `spawn`, and multi-sender lists on `from`.
