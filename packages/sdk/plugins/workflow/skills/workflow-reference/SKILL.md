---
name: workflow-reference
description: Field reference for Workflow YAML (root keys, every state type, bindings, outputs, runtime error codes), what the engine guarantees, and a review fan-out example. For design, call load_skill with name workflow-authoring.
---

# Workflow reference

Exact fields for `apiVersion: pilotswarm.dev/v1` definitions.
`workflow-authoring` explains how to design with them.

Ids: a state id or an outcome is a letter, then at most 63 letters, digits,
`_` or `-`. State ids are unique in the whole workflow, body and branch
states included. A contract name is `Name@N` (for example `BuildEvent@1`).

`workflow_definition` start has an optional exact `key`, 1-128 Unicode
characters, not blank and without NUL. It is scoped to the owning session,
across all definitions. The same key and start arguments return the original
Workflow, run and revision (`replayed: true`), including after a newer save
or an ended run, with the original tool grant. A different definition,
explicit revision, input, initial variable, completion notification or
chosen model conflicts. Use a fresh key, or no key on a new call, for
another attempt. This is a start argument, not a YAML field or an
idempotency guarantee for script effects.

## Root keys

| Key | Rule |
|---|---|
| `apiVersion` | `pilotswarm.dev/v1` |
| `kind` | `Workflow` |
| `metadata` | `{ name, version, description? }`. `name`: at most 128 characters. `version`: a semantic version string; quote it (`"1.0.0"`). |
| `description` | Optional text. |
| `inputs` | Optional `{ schema }`: the run's static inputs must match it. |
| `outputSchema` | Optional: the output of a `succeeded` terminal must match it. |
| `initial` | The first state; not a terminal. |
| `initialInput` | Optional JSON template (bindings: `inputs`, `kv`); the first state's input. Default null. |
| `limits` | Optional `{ maxNodeExecutions?, timeoutSeconds?, onExceeded? }`. `maxNodeExecutions`: 1 to 10,000 per run, default 1,000. `timeoutSeconds`: the run's deadline, 1 to 2,592,000 seconds from when it begins. `onExceeded`: `expired` (the only policy). |
| `catchAll` | Optional state that takes a runtime error no route takes; not `initial`; at most once per run. |
| `schemas` | Named JSON Schema 2020-12 documents; refer to one as `{ $ref: "#/schemas/Name" }`. |
| `contracts` | `Name@N: { schema, description?, response?: { schema, description? } }`. A request's contract needs `response`. |
| `states` | 1 to 100 states, body states included. |

Any schema field takes a `$ref` to `schemas` or an inline schema.

## Bindings

A binding is one whole string `"${root.path}"` or `"${root.path ?? <JSON literal>}"`.
Roots: `inputs`, `input`, `kv`, `runtime` (`runtime.error`), `branch`
(`branch.item`, `branch.index`; `branch.name` in named branches; branch
states only). Path segments: `.name`,
`[index]`, `["any key"]`. A template is any JSON value whose strings may be
bindings.

A template is a YAML value: an object is a map (`{ fact: "..." }`), not
JSON text in quotes (`'{"fact": "..."}'` is one string). A template with no
binding is checked against its contract or `inputSchema` when the draft is
saved (`WORKFLOW_STATE_INPUT_INVALID`); JSON written as text where an object
or array is expected gets the warning `WORKFLOW_INPUT_JSON_TEXT`. A state
with no `input:` whose closed `inputSchema` refuses a property that the
`outputSchema` of the state before it declares (a wait passes its input on),
or needs one it lacks, gets the warning `WORKFLOW_INPUT_MISMATCH`.

## States

Every state except a terminal has `transition: { next: { <route>: <state> } }`.
A route is an outcome of the state, a runtime error code or `failure` (any
runtime error that has no route of its own). All states take an optional
`description`.

### script

| Field | Rule |
|---|---|
| `source` | Required. Node ES module text. |
| `runtime` | Optional; `node` only. |
| `timeoutSeconds` | 1 to 3,600; default 300. |
| `input` | Optional template; default: the value that arrived. |
| `inputSchema`, `outputSchema` | Optional. |
| `outcomes` | Optional list; default: its routes that are not runtime routes. |

Output: the `setResult` output. Errors: `invalid_input`, `invalid_output`
(undeclared outcome, non-JSON or mismatched output), `execution_failed`
(non-zero exit without a result), `timed_out`, `cancelled`.

### wait

| Field | Rule |
|---|---|
| `seconds` | 1 to 86,400, or one binding (checked at entry: `invalid_input`). Required unless `at`. |
| `at` | Instead of `seconds`: `{ minute, hour?, day_of_week? (0-6, Sunday 0) or day_of_month? (1-31), tz }`; a day needs `hour`, and `minute` alone is every hour. Waits until the next such time in the IANA zone `tz` (daylight saving included), decided at entry. |
| `input` | Optional template. |

Outcome: `elapsed` (route required). Output: its input.

### messaging, mode receive

| Field | Rule |
|---|---|
| `contract` | Required. A root contract. |
| `from` | Optional: `{ parent: true }`, a session id, or `{ sessionId }` (may be a binding). Without it, any permitted sender. |
| `correlate` | Optional template object; a message's `correlation` must equal it. |
| `wait` | Optional `{ seconds }` (as a wait state's seconds): the receive races a durable timer. |
| `input` | Optional template. |

Outcomes: `received` (output: the message payload) and, with `wait`,
`elapsed` (output: its input). Routes for both are required. A message given
before the state starts is taken too.

### messaging, mode send

| Field | Rule |
|---|---|
| `contract` | Required. |
| `recipient` | Required: `{ parent: true }`, a session id, or `{ sessionId }` (may be a binding). |
| `correlate` | Optional template object. |
| `input` | Optional template; the message. At most 16 KB, valid for the contract. |

Outcome: `sent`: the recipient accepted it (not that it read it): an agent
session in its queue (at least once), a workflow as typed input (once). The
next state gets the delivery receipt, not the message: `exchangeId`,
`workflowSessionId`, `runId`, `nodeExecutionId`, `stateId`,
`recipientSessionId`, `recipientKind` (`agent` or `workflow`), `contract`,
`payloadSha256`, `clientMessageId` (an agent's) or `input` (a workflow's
acceptance; the other is null), `attempts`, `deliveredAt` (UTC). Errors:
`unavailable`, `forbidden`, `unsupported_contract`, `delivery_failed`,
`invalid_input`.

### messaging, mode request

| Field | Rule |
|---|---|
| `contract` | Required. Its contract declares `response`. |
| `recipient` | Required, as for send. |
| `timeoutSeconds` | Required. 1 to 86,400, or one binding. |
| `correlate` | Optional template object. |
| `input` | Optional template; the request payload. |

Outcomes: `responded` (output: the response, valid for the response schema)
and `declined` (output: `{ reason }`). The next state gets only that output:
nothing from before the request. Routes for both are required. The
deadline is `timed_out`. The recipient answers with
`respond_session_request`; session is not an answer.

### agent

| Field | Rule |
|---|---|
| `invoke` | Required. `{ prompt: <text, at most 32 KB> }` or `{ agent: { name, package?, version?, interface? } }`; `version` and `interface` need `package`. |
| `timeoutSeconds` | Required. 1 to 86,400, or one binding. |
| `input` | Optional template; checked against `inputSchema`. |
| `inputSchema`, `outputSchema` | Optional. |
| `outcomes` | Optional list of business outcomes; default: its routes that are not runtime routes. |
| `session` | Optional. `continue` (default) or `new`. In a parallel body (For each or branch) only `new`, its default there. (`chat` is no longer a field.) |
| `tools` | Optional. `none` or tool names: all the agent and its sub-agents get (plus `complete_workflow_node`). |

Output: the agent's validated output. The agent may report `needs_input` or
`execution_failed`. The workflow decides `timed_out`, `invalid_output` (three
invalid completions), `unavailable`, `forbidden` and `cancelled`.

`session: continue` (the default) keeps one agent session across the state's
visits in a Workflow: each later visit arrives as "cycle N" with the input,
the variables now, which changed, and the previous result. The step
remembers earlier cycles (no repeats, incremental work); its context grows,
so it costs more. Use `session: new` (a fresh agent session each visit: clean,
cheaper, no drift) only when the person asks for it, or the visits are
independent and the person wants that. In a For each or a parallel branch
each visit has its own agent session: `new` is the default there and
`continue` is refused. Another Workflow (Run again) starts new agent
sessions. Each completion gives `node_execution_id` from its prompt.
Session lifecycle: the time limit is per visit; the agent session ends with
the Workflow (a stop ends an idle one at once). An agent session that ended
on its own is replaced, and the prompt says so.

`interface: <name>@<version>` (for example `review_change@1`) names the
workflow interface its package agent exports. `ps_list_agents` lists it as
the entry's `workflowInterface` (`ref`, `outcomes`, `inputSchema`,
`outputSchema`, `digest`); set `package` to the entry's `namespace`. The
state must declare `outputSchema`. At publication and at start,
the state's outcomes and `outputSchema` must equal the interface's,
and `inputSchema` too when the interface has one. Copy each interface
schema into `schemas` unchanged (no `$ref` inside the copy) and refer to it
from the state; a stricter or looser schema does not match. A
mismatch refuses with `CONTRACT_MISMATCH` and its `problems`; a match pins
the interface's digest with the package revision.

### parallel

| Field | Rule |
|---|---|
| `forEach` | One binding that gives a list, or a list; at most 64 items. |
| `branches` | Instead of `forEach` and `body`: `{ <name>: { initial, states, input? } }`, 1 to 64, each its own graph from its `initial`, with its `input` (default: the value that arrived). `concurrency` defaults to their number; above 16, set it. |
| `concurrency` | 1 to 16; default 1. |
| `join` | Optional: `all` (default; `all_required` is the same) or `{ first: k }`, k from 1 to 64 and at most the items of a literal list. |
| `failFast` | Optional boolean; default false. Cancels the other branches once the join can no longer succeed. |
| `timeoutSeconds` | Optional: the state's own time limit, 1 to 86400 or one binding. Needs a `timed_out` route. |
| `inputSchema` | Optional: checks the whole list. |
| `outputSchema` | Optional: checks the joined output, never a report. |
| `body` | With `forEach`: `{ initial, states }`. No parallel state inside. |

Outcomes: `joined` and `blocked`. Routes for both are required.

- `joined` with `all`: the branch outputs in list order. With `{ first: k }`:
  `[{ index, output }]` of the first k successes, in the order the store
  saved them (ties: lower index first); the other branches are cancelled or
  not started. Named branches: `{ <name>: output }`, the winners only; a
  report's branches add `name`. Without `timeoutSeconds`, a named branch
  with an agent state, or a receive with no wait, warns
  `WORKFLOW_BRANCH_UNBOUNDED`.
- `blocked`: k successes can no longer happen (with `{ first: k }` and fewer
  than k items, at once). Output: `{ joined: false, timedOut, total, needed,
  succeeded, failFast, branches: [{ index, ended, nodeExecutionId, outcome,
  resultKind, output or error, cancelledBy?, late? }] }`. `ended` is
  `terminal`, `error`, `cancelled`, `not_started` or `finished` (its last
  step's result was saved, and kept, but its next step never started). `cancelledBy` is `failFast`, `join` or `timeout`. `late` marks a
  success saved after the time limit. A report too large to store drops
  every `output` and `error` and adds `truncated: true`.
- With `timeoutSeconds`: a success counts only when it was saved at or
  before the time limit. A branch step whose own deadline
  equals the time limit ends just after it, so it does not count. When the time limit passes with k such successes,
  the state still joins. With fewer, it ends with the runtime error
  `timed_out`, whose `details` is the same report with `timedOut: true`;
  if k could already no longer happen then, it is `blocked` with
  `timedOut: true` instead.
- Worker slots: each running script holds one of the worker's slots
  (`PILOTSWARM_WORKER_CONCURRENCY`; the duroxide default is 2) for its whole
  run, and the controller needs one too: keep `concurrency` below the slot
  count, with room to spare.

### terminal

| Field | Rule |
|---|---|
| `outcome` | Required: `succeeded`, `blocked`, `failed` or `cancelled`. |
| `output` | Optional template; default null. |
| `summary` | Optional text. |
| `outputSchema` | Optional, in addition to the root `outputSchema` for `succeeded`. |

## Runtime error codes

`invalid_input`, `invalid_output`, `timed_out`, `cancelled`, `forbidden`,
`unavailable`, `unsupported_contract`, `delivery_failed`, `budget_exceeded`,
`needs_input`, `execution_failed`. On an error route, `input` and
`runtime.error` are the envelope `{ code, message, details? }`.

## Semantics

What the engine guarantees. Do not rely on more.

- **Durable.** The store keeps the run, each visit (input, outcome,
  output), the variables, accepted messages and requests. After a worker
  restart the run goes on where it was.
- **Order.** The run starts at `initial`. Outside a parallel state one state
  runs at a time: its outcome, or its runtime error, takes one route, and the
  next state gets its output (or the error envelope). Every visit counts
  toward `maxNodeExecutions`; at the limit the run fails (`limit_exceeded`).
- **One result per visit.** The first result stored stands. Nothing is
  undone: side effects that happened stay.

| Effect | On a retry or a worker restart |
|---|---|
| script | Runs again from its start (`context.attempt` above 1), tool calls too: make it safe to repeat. |
| agent | Keeps the same agent session; its prompt is not given twice. The first accepted `complete_workflow_node` decides; later ones are refused. |
| send | An agent session may get it twice (a repeat is dropped while its id is recent). A workflow takes it once. |
| request | Reaches the responder at least once, under one id. The first answer decides; none after the deadline. |
| receive | Takes each message once, in the order the run accepted it. |
| wait | Elapses once, by the store's clock. |

- **Timers.** Every deadline (a wait, a receive's `wait`, a request, an agent
  or parallel `timeoutSeconds`, the run's `limits.timeoutSeconds`) is a
  durable timer, fixed when its state or run starts. Restarts and pauses do
  not stop it.
- **Joins.** `forEach` is read once, at entry. At most `concurrency`
  branches run at once. Only successes stored in time count. A cancelled
  branch's running script may still finish (stopping is best-effort), but
  its result does not count.
- **Pause.** No state starts and no result is routed until `resume`. Started
  work finishes and keeps its result; a state whose deadline passes
  meanwhile is routed after the resume.
- **Stop.** Nothing new starts; started work settles. The run ends `stopped`
  when nothing is pending, or at the end of its grace, cancelling the rest.
- **Cancel, delete.** The run ends when it is accepted: pending visits are
  cancelled, then scripts are stopped and agent sessions ended. A delete tells
  no one.
- **Run deadline.** Pending work is cancelled and the run fails `timed_out`,
  paused or not.
- **Failure.** A runtime error takes its code's route, else `failure`, else
  `catchAll` (once per run; a later route to it fails the run), else the
  run fails. In a branch it ends the branch without success. A run whose
  controller stopped shows `needsRecovery`; `recover` ends it failed.
- **Versions.** A Workflow runs the revision it started with, with its
  named agents' pinned versions; a later save never changes it. To run a
  change, start the new revision as another Workflow. Only its variables
  change (`set_vars`); a step reads them as of its start.

## Not supported: do not write

`transition.function`, `transition.delaySeconds` (use a wait state), join
states, a parallel state in a body, `inputSchema` or `outputSchema` on a
receive, `parentNotification`, the request field `request` and the route
`timeout`, and text around a binding.

## Tools

Start refuses a literal `callTool("name", ...)` when its captured grant
does not uniquely admit that tool. Save reports a warning when it can check
the current grant; read shows it. Dynamic tool names cannot be checked
statically, and all actual calls are checked at run time.

Script tool grants exclude `draw_canvas`, `update_canvas`, `show_canvas`,
`read_canvas`, `canvas_kv`, `publish_canvas_app` and `find_canvas_app`.
These tools need a live agent session's canvas bridge. A script does not
have it, even with `session_id`; use an agent step or send to the parent.

For every argument of the Workflow tools and the refusals you can fix, call
`load_skill` with name `workflow-tools`. Use `read_workflow`, not
`list_sessions`, for a Workflow's status.

## Example: review fan-out with bounded rework

```yaml
# example: change-review
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: change-review, version: "1.0.0" }
description: Reviews pinned changes in parallel with bounded rework, then asks the parent to approve the reviewed set.
inputs:
  schema: { $ref: "#/schemas/ReviewInputs" }
outputSchema: { $ref: "#/schemas/Decision" }
initial: review_changes
initialInput: "${inputs.changes}"
schemas:
  Change:
    type: object
    additionalProperties: false
    required: [workId, head, authorSessionId, round]
    properties:
      workId: { type: string, minLength: 1 }
      head: { type: string, minLength: 40, maxLength: 40 }
      authorSessionId: { type: string, minLength: 1 }
      round: { type: integer, minimum: 1, maximum: 3 }
  ReviewInputs:
    type: object
    additionalProperties: false
    required: [changes]
    properties:
      changes: { type: array, minItems: 1, maxItems: 16, items: { $ref: "#/schemas/Change" } }
  ReviewResult:
    type: object
    additionalProperties: false
    required: [workId, head, findings]
    properties:
      workId: { type: string }
      head: { type: string }
      findings: { type: array, items: { type: string } }
  NewHead:
    type: object
    additionalProperties: false
    required: [head]
    properties:
      head: { type: string, minLength: 40, maxLength: 40 }
  ReviewedSet:
    type: array
    items: { $ref: "#/schemas/ReviewResult" }
  Decision:
    type: object
    additionalProperties: false
    required: [approved]
    properties:
      approved: { type: boolean }
      note: { type: string }
contracts:
  Rework@1:
    schema: { $ref: "#/schemas/ReviewResult" }
    response: { schema: { $ref: "#/schemas/NewHead" } }
  Approve@1:
    schema: { $ref: "#/schemas/ReviewedSet" }
    response: { schema: { $ref: "#/schemas/Decision" } }
states:
  review_changes:
    type: parallel
    forEach: "${input}"
    concurrency: 4
    outputSchema: { $ref: "#/schemas/ReviewedSet" }
    body:
      initial: review
      states:
        review:
          type: agent
          invoke: { agent: { name: code-reviewer, package: review-kit, version: "1.2.0" } }
          inputSchema: { $ref: "#/schemas/Change" }
          outputSchema: { $ref: "#/schemas/ReviewResult" }
          outcomes: [accepted, changes_required]
          timeoutSeconds: 900
          transition:
            next: { accepted: accepted, changes_required: ask_rework, invalid_input: blocked, needs_input: blocked, failure: blocked }
        ask_rework:
          type: messaging
          mode: request
          contract: Rework@1
          recipient: { sessionId: "${branch.item.authorSessionId}" }
          timeoutSeconds: 3600
          transition:
            next: { responded: next_round, declined: blocked, failure: blocked }
        next_round:
          type: script
          timeoutSeconds: 120
          outcomes: [verified]
          source: |
            const item = context.branch.item;
            const checked = await callTool("verify_review_round", { workId: item.workId, head: context.input.head });
            await setResult("verified", { ...item, head: context.input.head, round: checked.round });
          transition:
            next: { verified: review, failure: blocked }
        accepted:
          type: terminal
          outcome: succeeded
          output: "${input}"
        blocked:
          type: terminal
          outcome: blocked
          output: "${input}"
    transition:
      next: { joined: approve, blocked: stuck, failure: failed }
  approve:
    type: messaging
    mode: request
    contract: Approve@1
    recipient: { parent: true }
    timeoutSeconds: 86400
    transition:
      next: { responded: decide, declined: rejected, timed_out: rejected, failure: failed }
  decide:
    type: script
    outcomes: [approved, rejected]
    source: |
      await setResult(context.input.approved ? "approved" : "rejected", context.input);
    transition:
      next: { approved: done, rejected: rejected, failure: failed }
  done:
    type: terminal
    outcome: succeeded
    output: "${input}"
  rejected:
    type: terminal
    outcome: blocked
    output: "${input}"
  stuck:
    type: terminal
    outcome: blocked
    output: "${input}"
  failed:
    type: terminal
    outcome: failed
    output: "${runtime.error}"
```

`code-reviewer` in `review-kit` and `verify_review_round` stand for an agent
and a tool of your own. The rework loop is bounded by the schema: a fourth
round fails `review`'s input check (`invalid_input`) and ends the branch
blocked; a blocked join ends at `stuck` with every branch's result.
