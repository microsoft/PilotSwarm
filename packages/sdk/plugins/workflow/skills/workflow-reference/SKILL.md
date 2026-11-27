---
name: workflow-reference
description: Workflow YAML fields, limits and guarantees for authors. Design in workflow-authoring.
---

# Workflow reference

Ids: letter, then at most 63 letters/digits/`_`/`-`; unique across bodies/branches.
Contracts: `Name@N` (`BuildEvent@1`).

Start `key` deduplicates. `workspace`: omit/object = record+defaults, `null` = defaults, `"none"` = neither; nodes cannot change it. See workflow-tools.

## Root keys

| Key | Rule |
|---|---|
| `apiVersion` | `pilotswarm.dev/v1` |
| `kind` | `Workflow` |
| `metadata` | `{ name, version, description? }`. Name: at most 128 characters. Version: quoted semver (`"1.0.0"`). |
| `description` | Text. |
| `notes` | Optional literal text; see States. |
| `inputs` | Optional `{ schema }`: the run's static inputs must match it. |
| `outputSchema` | Optional: the output of a `succeeded` terminal must match it. |
| `initial` | The first state; not a terminal. |
| `initialInput` | Optional JSON template (`inputs`, `kv`); first-state input; default null. |
| `limits` | Optional `{ maxNodeExecutions?, timeoutSeconds?, onExceeded? }`. `maxNodeExecutions`: 1 to 10,000 per run, default 1,000. `timeoutSeconds`: the run's deadline, 1 to 2,592,000 seconds from when it begins. `onExceeded`: `expired` (the only policy). |
| `catchAll` | Optional non-initial state for an unrouted runtime error; at most once per run. |
| `schemas` | Named JSON Schema 2020-12 documents; refer to one as `{ $ref: "#/schemas/Name" }`. |
| `contracts` | `Name@N: { schema, description?, response?: { schema, description? } }`; requests need `response`. |
| `states` | 1 to 100 states, body states included. |

Schema fields: inline, or `$ref` to `schemas`.

## Bindings

A binding is one whole string `"${root.path}"` or `"${root.path ?? <JSON literal>}"`.
Roots: `inputs`, `input`, `kv`, `runtime` (`runtime.error`), `branch`
(`branch.item`, `branch.index`; `branch.name` in named branches; branch
states only), `states` (`${states.<id>.output}`: latest result of `<id>` — failed visits
don't replace it; same branch or root only, else compile error; `null` if none;
frozen at entry). Path segments: `.name`,
`[index]`, `["any key"]`. A template is any JSON value whose strings may be
bindings.

A template is a YAML value: `{ fact: "..." }` is an object, quoted JSON is a
string (`WORKFLOW_INPUT_JSON_TEXT`). Literal input is checked at save
(`WORKFLOW_STATE_INPUT_INVALID`); incompatible unmapped producer/consumer
schemas get `WORKFLOW_INPUT_MISMATCH`.

## States

Every state except a terminal has `transition: { next: { <route>: <state> } }`.
A route is an outcome of the state, a runtime error code or `failure` (any
runtime error without its own route). All states take an optional
`description` (graph label; id stays visible). Root and states take optional
`notes`; `transition.notes: { <route>: <text> }` annotates existing routes.
Each note: at most 16 KiB UTF-8, no NUL/lone surrogates, never executed.
Notes are shared with graph readers; no secrets. Absent keys stay absent;
editing notes makes a new revision/hash, not a run change.

Nonterminals take `maxVisits` (1–10,000; forbids business outcome `exhausted`):
visit N+1 skips carry/input/effect and ends at entry with `exhausted` (route
required) and incoming value as output.
Nonterminals except approval take `carry`: load `workflow-carry`.

### approval

Owner consent: load `workflow-approval`. Agents cannot answer it.

### script

| Field | Rule |
|---|---|
| `source` | Required. Node ES module text; syntax errors are saved as `WORKFLOW_SCRIPT_SYNTAX` errors and refuse Start. Use top-level await, not top-level return. |
| `runtime` | Optional; `node` only. |
| `timeoutSeconds` | 1 to 3,600; default 300. |
| `input` | Optional template; default: the value that arrived. |
| `inputSchema`, `outputSchema` | Optional. |
| `outcomes` | Optional list; default: its routes that are not runtime routes. |

Output: the `setResult` output. Errors: `invalid_input`, `invalid_output`
(undeclared outcome, non-JSON or mismatched output), `execution_failed`
(non-zero exit without a result), `timed_out`, `cancelled`.

Await tools sequentially (`for...of`, not `Promise.all`); the runtime
refuses overlap. Diagnostics: `workflow-tools`.

### wait

| Field | Rule |
|---|---|
| `seconds` | 1 to 2,592,000 (30 days), or one binding (checked at entry: `invalid_input`). Required unless `at`. A literal longer than the run timeout warns. |
| `at` | Instead of `seconds`: `{ minute, hour?, day_of_week? (0-6, Sunday 0) or day_of_month? (1-31), tz }`; a day needs `hour`, and `minute` alone is every hour. Waits for the next such time in IANA zone `tz` (with daylight saving), decided at entry. |
| `input` | Optional template. |

Outcome: `elapsed` (route required). Output: its input.

### messaging, mode receive

| Field | Rule |
|---|---|
| `contract` | Required. One root contract (or `WorkflowEnded@1`), or a list of 2–8 distinct names. |
| `from` | Optional: `{ parent: true }`, session id, or `{ sessionId }` (binding ok); default any permitted sender. |
| `correlate` | Optional template object; a message's `correlation` must equal it. |
| `wait` | Optional `{ seconds }` (per visit) or `{ totalSeconds }` (never resets in a run/branch execution; binding read once on first start; use `seconds` in outer loops), 1–86,400; never both. |
| `input` | Optional template. |

One name: `received` (payload). List: each contract is an outcome (no `received`),
output `{ contract, from, payload }`, earliest match. With `wait`, `elapsed`
(input) is required; spent `totalSeconds` fires `elapsed` at entry.

### messaging, mode send

| Field | Rule |
|---|---|
| `contract` | Required. |
| `recipient` | Required: `{ parent: true }`, session id, or `{ sessionId }` (binding ok). |
| `correlate` | Optional template object. |
| `input` | Optional template; the message. At most 16 KB, valid for the contract. |

Outcome: `sent`: accepted, not read. An agent queues it at least once;
a workflow takes typed input once. Output is the receipt, not the message:
`exchangeId`,
`workflowSessionId`, `runId`, `nodeExecutionId`, `stateId`,
`recipientSessionId`, `recipientKind` (`agent` or `workflow`), `contract`,
`payloadSha256`, `clientMessageId` (agent) or `input` (workflow acceptance;
the other is null), `attempts`, `deliveredAt` (UTC). Errors:
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

Outcomes: `responded` (schema-valid response) and `declined` (`{ reason }`);
route both. Only that output reaches the next state. Deadline:
`timed_out`. Answer with `respond_session_request`, not session text.

### decision

Use this first-class state only when `workflows.decision.available` is `true`.
It takes `input` (optional template; default: the arrived value), optional
`inputSchema`, a required static `question`, optional `confidence`, and
`timeoutSeconds` (literal integer 1 to 86,400; default 30).
Instructions/descriptions are non-empty literal UTF-8 of at most 32 KiB; no
bindings or dynamic options. YAML never names a model.

| `question.type` | `criteria` | Exact business routes |
|---|---|---|
| `choice` | Object with at least two static route-label keys and descriptions. Keys cannot be `failure`, `uncertain`, `scored`, or a runtime code. | Every criterion; `uncertain` exactly when `confidence` exists. |
| `noul` | Omit, or exactly `{ true: <description>, false: <description> }`. | `yes`, `no`; `uncertain` exactly when `confidence` exists. |
| `score` | Ordered array of at least two distinct static labels. | `scored` only; `confidence` is invalid. |

Missing/extra business routes are invalid. Runtime routes and `failure` may be
added. `confidence` is `{ minimumProbability: <finite literal 0..1> }`.
Choice confidence is the selected label's returned probability, even if not the
largest. `noul` selects `yes` at provider `p >= 0.5`, else `no`, with confidence
`max(p, 1-p)`. Confidence strictly below the threshold takes `uncertain`;
equality does not. Score preserves the provider's finite score (`0..last level`)
and ordered levels; it is never banded or re-derived.

Every provider probability is finite in `0..1`. Choice requires exactly the
declared option keys. `noul` requires exactly raw `true`/`false`. Score requires
exactly level indexes `0..n-1`; a supplied legend must match the labels in order.

Exact semantic outputs (`qualified` is the effective `provider:model`):

| Type | Output |
|---|---|
| `choice` | `{ questionType: "choice", outcome: <label \| "uncertain">, selection: <label>, confidence, probabilities: { <label>: number }, policy: { minimumProbability: number \| null, uncertain }, model: { qualified } }` |
| `noul` | `{ questionType: "noul", outcome: "yes" \| "no" \| "uncertain", selection: "yes" \| "no", confidence, probability, probabilities: { yes, no }, policy: { minimumProbability: number \| null, uncertain }, model: { qualified } }` |
| `score` | `{ questionType: "score", outcome: "scored", score, levels: [{ label, probability }], model: { qualified } }` |

Score intentionally has no selection, confidence, raw probability object or
policy. Transport IDs/status/timing/usage/hashes/raw bodies never enter output;
scripts and agents receive the semantic result unchanged.

The Cluster Decision Default is a hard gate, not a fallback: without an
eligible default Save marks the revision invalid and fresh Start refuses with
`WORKFLOW_DECISION_MODEL_UNAVAILABLE`. An override must be in the current
Decision catalog, cannot bypass the default, and never falls back to chat or
first available. Start persists one effective map for every Decision node;
Run again reuses and revalidates it. `decision_models` is the additive,
Decision-only `{ model }` Start alias; the existing `agent_models` map can carry
the same shape for compatibility. Decision entries never take reasoning/context.
See workflow-tools for merge rules.

### agent

| Field | Rule |
|---|---|
| `invoke` | Required. `{ prompt: <text, at most 32 KB> }` or `{ agent: { name, package?, version?, interface? } }`; `version` and `interface` need `package`. |
| `timeoutSeconds` | Required. 1 to 86,400, or one binding. |
| `input` | Optional template; checked against `inputSchema`. |
| `inputSchema`, `outputSchema` | Optional. |
| `outcomes` | Optional list of business outcomes; default: its routes that are not runtime routes. |
| `session` | Optional. `continue` (default) or `new`. In a parallel body (For each or branch) only `new`, its default there. (`chat` is no longer a field.) |
| `tools` | `none`/tool names: the whole subtree's ceiling (plus `complete_workflow_node`). |
| `requiredTools` | Optional 1-16 exact tool names; call each per visit. See workflow-tools. |
| `grant` | `all`/`none`/selectors (tool, `package:`, `mcp:`); default named `none`, inline `all`. See workflow-tools. |

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

Multi-day work: short visits, a sleep outcome routed to a wait; call
`load_skill` with name `workflow-long-agent`. A timeout self-loop warns.

`interface: <name>@<version>` (for example `review_change@1`) names the
workflow interface its package agent exports. `ps_list_agents` lists it as
the entry's `workflowInterface` (`ref`, `outcomes`, `inputSchema`,
`outputSchema`, `digest`); set `package` to the entry's `namespace`. The
state must declare `outputSchema`. At publication and start, its outcomes,
`outputSchema` and (when the interface has one) `inputSchema` must equal
the interface's. Copy each interface
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
- With `timeoutSeconds`, only timely successes count; fewer than k ends `timed_out` (or `blocked` if k was already unreachable) with `timedOut: true`. Keep `concurrency` below `PILOTSWARM_WORKER_CONCURRENCY`.

### spawn

`definition` (literal name or `<package>/<name>`), `inputs` (object template), `revision` (fixed positive int, else newest valid at admission), `agentModels`, `carry`. Outcome `started` outputs `{ workflowId, runId, definition, revision }` (use `from: "${states.<spawn>.output.workflowId}"`). Every child end sends built-in `WorkflowEnded@1` while parent is active (success only if its `outcome` is `succeeded`; inbox order; correlate by `workflowId`; no `contracts:` entry; cannot `send`; exempt from 100-inbox cap; >16 KiB sets `outputTruncated: true`). Parent end cancels children; direct delete sends no notice (use `cancel`/`stop`).

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
`needs_input`, `execution_failed`. `runtime.error` is `{ code, message, details? }`;
`input` is that envelope unless the predecessor declared carry.

## Semantics

- **Durable.** The store keeps runs, visits, variables and accepted messages.
  Worker restarts resume saved work.
- **Order.** Starts at `initial`. Outside parallel branches, one state runs
  at a time and takes one route. Every visit counts toward
  `maxNodeExecutions`; exhaustion fails with `limit_exceeded`.
- **One result per visit.** The first saved result wins. Effects are not undone.

| Effect | On a retry or a worker restart |
|---|---|
| script | Restarts (`context.attempt` above 1), including tools: make effects safe to repeat. Canvas: absolute ticks and `put`s; a `CONFLICT` where `get` shows your value is success; draw once, then tick. |
| decision | Attempts 1–2 call the provider; attempt 3 records `unavailable`. First stored result wins. |
| spawn | Keyed Start (`spawn:<nodeExecutionId>`): retries replay the same child; never creates a second child. |
| agent | Same session, no repeated prompt. First accepted `complete_workflow_node` decides; later ones are refused. |
| send | Agents may get duplicates (recent ids deduplicate). Workflows take it once. |
| request | At least once, one id. First answer decides; none after deadline. |
| receive | Takes each message once, in the order the run accepted it. |
| wait | Elapses once, by the store's clock. |

- **Timers.** Deadlines are durable from start; restarts and pauses do not stop them.
- **Joins.** `forEach` runs up to `concurrency` branches; only timely successes count.
- **Pause / Stop / Cancel.** Pause holds new admissions; stop drains active work until grace expiry; cancel/delete end pending work and active child Workflows.
- **Failure.** Errors route by code, then `failure`, then `catchAll` once, else fail the run.
- **Versions.** Started revisions and agent pins stay fixed; only variables (`set_vars`) change.

## Not supported: do not write

`transition.function`, `transition.delaySeconds` (use a wait state), join
states, a parallel state in a body, `inputSchema` or `outputSchema` on a
receive, `parentNotification`, the request field `request` and the route
`timeout`, and text around a binding.

## Tools

`workflow-tools`: arguments/refusals, script canvas calls.
Use `read_workflow`, not `list_sessions`, for a Workflow's status.

## Example: bounded review

```yaml
# example: change-review
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: change-review, version: "1.0.0" }
description: Bounded review with accepted and rejected routes.
initial: review
states:
  review:
    type: agent
    invoke: { prompt: "Review the input and return accepted or rejected." }
    outcomes: [accepted, rejected]
    timeoutSeconds: 900
    transition: { next: { accepted: done, rejected: blocked, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  blocked: { type: terminal, outcome: blocked }
  failed: { type: terminal, outcome: failed }
```

## Example: child Workflow

```yaml
# example: child-dispatch
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: child-dispatch, version: "1.0.0" }
initial: go
states:
  go:
    type: spawn
    definition: worker-task
    inputs: { item: "alpha" }
    transition: { next: { started: wait, failure: fail } }
  wait:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    from: "${states.go.output.workflowId}"
    wait: { seconds: 300 }
    transition: { next: { received: done, elapsed: fail, failure: fail } } # check input.outcome
  done: { type: terminal, outcome: succeeded, output: "${input}" }
  fail: { type: terminal, outcome: failed, output: "${runtime.error}" }
```
