---
name: workflow-reference
description: Field reference for version 2 workflow YAML (root keys, every state type, outputs, runtime error codes) and the workflow tools and their refusals, with a complete review fan-out example. Load with workflow-authoring.
---

# Workflow reference

Exact fields for `apiVersion: pilotswarm.dev/v2-draft` definitions and the
workflow tools. `workflow-authoring` explains how to design with them.

Ids: a state id or an outcome is a letter, then at most 63 letters, digits,
`_` or `-`. State ids are unique in the whole workflow, body states
included. A contract name is `Name@N` (for example `BuildEvent@1`).

## Root keys

| Key | Rule |
|---|---|
| `apiVersion` | `pilotswarm.dev/v2-draft` |
| `kind` | `Workflow` |
| `metadata` | `{ name, version, description? }`. `name`: at most 128 characters. `version`: a semantic version string; quote it (`"1.0.0"`). |
| `description` | Optional text. |
| `inputs` | Optional `{ schema }`: the run's static inputs must match it. |
| `outputSchema` | Optional: the output of a `succeeded` terminal must match it. |
| `initial` | The first state; not a terminal. |
| `initialInput` | Optional JSON template (bindings: `inputs`, `kv`); the first state's input. Default null. |
| `limits` | Optional `{ maxNodeExecutions?, timeoutSeconds?, onExceeded? }`. `maxNodeExecutions`: 1 to 10,000, default 1,000 node executions per run. `timeoutSeconds`: the run's deadline, 1 to 2,592,000 seconds from when it begins; pause does not stop it. `onExceeded`: `expired` (the default and only policy): at the deadline the run's pending work is cancelled and the run ends failed with `timed_out`. |
| `catchAll` | Optional state that takes a runtime error no route takes; not `initial`; at most once per run. |
| `schemas` | Named JSON Schema 2020-12 documents; refer to one as `{ $ref: "#/schemas/Name" }`. |
| `contracts` | `Name@N: { schema, description?, response?: { schema, description? } }`. A request's contract needs `response`. |
| `states` | 1 to 100 states, body states included. |

Any schema field takes a `$ref` to `schemas` or an inline schema. Only local
references work; `$id`, `$schema`, `$anchor` and remote references are
refused.

## Bindings

A binding is one whole string `"${root.path}"` or `"${root.path ?? <JSON literal>}"`.
Roots: `inputs`, `input`, `kv`, `runtime` (`runtime.error`), `branch`
(`branch.item`, `branch.index`; body states only). Path segments: `.name`,
`[index]`, `["any key"]`. A template is any JSON value whose strings may be
bindings. Text around a binding is refused.

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
| `seconds` | Required. 1 to 86,400, or one binding (checked at entry: `invalid_input`). |
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
before the state starts is taken too, in the order the run accepted it.

### messaging, mode send

| Field | Rule |
|---|---|
| `contract` | Required. |
| `recipient` | Required: `{ parent: true }`, a session id, or `{ sessionId }` (may be a binding). |
| `correlate` | Optional template object. |
| `input` | Optional template; the message. At most 16 KB, valid for the contract. |

Outcome: `sent` (output: the delivery receipt): the recipient accepted the
message. That does not mean it was read. An agent session gets it in its
queue (at least once). A workflow gets it as typed input (once). Errors:
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
and `declined` (output: `{ reason }`). Routes for both are required. The
deadline is `timed_out`. The recipient answers with
`respond_session_request`; chat is not an answer. Use `input`, not
`request`, and the route `timed_out`, not `timeout`.

### agent

| Field | Rule |
|---|---|
| `invoke` | Required. `{ prompt: <text, at most 32 KB> }` or `{ agent: { name, package?, version?, interface? } }`; `version` and `interface` need `package`. |
| `timeoutSeconds` | Required. 1 to 86,400, or one binding. |
| `input` | Optional template; checked against `inputSchema`. |
| `inputSchema`, `outputSchema` | Optional. |
| `outcomes` | Optional list of business outcomes; default: its routes that are not runtime routes. |

Output: the agent's validated output. The agent may report `needs_input` or
`execution_failed`. The workflow decides `timed_out`, `invalid_output` (three
invalid completions), `unavailable`, `forbidden` and `cancelled`.

`interface: <name>@<version>` (for example `review_change@1`) names the
workflow interface that the package agent exports. `ps_list_agents` lists
it as the entry's `workflowInterface` (`ref`, `outcomes`, `inputSchema`,
`outputSchema`, `digest`); set `package` to the entry's `namespace`. The
state must declare `outputSchema`. At publication, and when a real-agent
test starts, the state's outcomes and `outputSchema` must be exactly the
interface's, and so must `inputSchema` when the interface has one. Copy
each interface schema into `schemas` without changes, and refer to it from
the state. Do not add a `$ref` inside the copy. A stricter or looser schema
does not match. A mismatch refuses with `CONTRACT_MISMATCH` and its
`problems`; a match pins the interface's digest with the package revision.

### parallel

| Field | Rule |
|---|---|
| `forEach` | Required. One binding that gives a list, or a list; at most 64 items. |
| `concurrency` | 1 to 16; default 1. |
| `join` | Optional; only `all_required`. |
| `failFast` | Optional boolean; default false. |
| `inputSchema` | Optional: checks the whole list. |
| `outputSchema` | Optional: checks the joined list. |
| `body` | Required: `{ initial, states }`. No parallel state inside. |

Outcomes: `joined` (output: the branch outputs in list order) and `blocked`
(output: `{ joined: false, total, succeeded, failFast, branches: [{ index,
ended, nodeExecutionId, outcome, resultKind, output or error }] }`, where
`ended` is `terminal`, `error`, `cancelled` or `not_started`). Routes for
both are required.

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

## Not supported: do not write

`transition.function`, `transition.delaySeconds` (version 1 only; use a wait
state), join states, quorum or any-of joins, a parallel state in a body, `inputSchema` or `outputSchema` on a receive,
`parentNotification`, the request field `request`
and the route `timeout`, and text around a binding.

## Tools

`spawn_workflow`: `yaml`, `state` (`draft`, the default, or `published`),
`start` (with `published`), `inputs`, `vars` (with `start`), `key`
(idempotency), `notify_on_completion` (default true). Returns the receipt:
`workflowId`, `revision`, `definitionHash`, `valid`, `diagnostics`.

`update_workflow`: `workflow_id`, `operation`, `operation_id`, and:

| Operation | Arguments | Effect |
|---|---|---|
| `replace_definition` | `yaml`, `expected_revision` | New draft revision; drafts only; same `metadata.version`. |
| `publish` | `expected_revision`, `definition_hash` | Publishes that exact revision and pins the exact version of every named agent; does not start. A run keeps the pinned agent version after its package is republished; publish a new workflow child to move to the new version. |
| `publish_and_start` | publish arguments, `inputs`, `vars?` | Publishes and starts the live run. |
| `start` | `definition_hash`, `inputs`, `vars?` | Starts the one live run of the published revision. |
| `set_vars` | `set?`, `delete?`, `expected_kv_revision`, `run_id?` | One atomic KV change. |
| `pause`, `resume`, `cancel` | `reason?`, `run_id?` | Run control. |
| `stop` | `reason?`, `grace_seconds?` (0 to 3,600, default 60), `run_id?` | Admits nothing new; admitted work settles; then the run ends `stopped`. |
| `recover` | `run_id?` | Ends or starts a run that `read_workflow` shows as `needsRecovery`. |
| `test` | `expected_revision`, `definition_hash`, `inputs`, `vars?`, `agent_mode?`, `fixtures?`, `scenario?` | Starts a mocked test run (`workflow-testing`). |
| `test_respond` | `run_id`, `interception_id`, `response` | Answers one intercepted effect. |
| `test_advance` | `run_id`, `seconds` | Moves a test run's virtual clock. |

`read_workflow`: `workflow_id`, `run_id?` (default: the live run),
`include_yaml?`. Shows the definition, the graph, the runs and one run's
node executions, KV, inbox and outbox, its stop, agent children
(`agent.childSessionId`), parallel branches, and a test run's evidence.

`send_workflow_input`: `workflow_id`, `contract`, `payload`,
`correlation?`, `run_id?`, `ttl_seconds?` (1 to 86,400, the default),
`operation_id`. Gives a run one typed input for its receive states.

`respond_session_request` (the recipient of a request): `request_id`,
`operation_id`, and `response` or `decline: { reason }`.

`complete_workflow_node` (an agent state's child): `operation_id`, and
`outcome` with `output`, or `error: { code: needs_input or
execution_failed, message, details? }`.

## Refusals you can fix

| Code | Meaning |
|---|---|
| `DEFINITION_INVALID` | The revision has compile errors; read `diagnostics`. |
| `REVISION_CONFLICT` | The current revision is not `expected_revision`; read it again. |
| `DEFINITION_HASH_MISMATCH` | `definition_hash` is not the hash of that revision. |
| `SEMVER_IMMUTABLE`, `DEFINITION_IMMUTABLE` | A published definition or its version does not change; use a new workflow child. |
| `OPERATION_CONFLICT` | The `operation_id` was used for another request. |
| `LIVE_RUN_EXISTS` | The workflow child already has its live run. |
| `KV_REVISION_CONFLICT` | Read `kvRevision` again. |
| `WORKFLOW_INPUT_INVALID`, `INPUT_INVALID` | Inputs or a payload do not match the schema; read the field errors. |
| `RUN_STOP_UNSUPPORTED` | The run's controller does not stop gracefully; cancel it. |
| `AGENT_UNAVAILABLE` | Publication could not pin a named agent. |
| `CONTRACT_MISMATCH` | The state is not exactly its agent's workflow interface; read `problems`. |
| `FORBIDDEN`, `WORKFLOW_NOT_FOUND` | Only the creating agent changes or reads its workflow child. |

## Example: review fan-out with bounded rework

```yaml
# example: change-review
apiVersion: pilotswarm.dev/v2-draft
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
      head: { type: string, pattern: "^[0-9a-f]{40}$" }
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
      head: { type: string, pattern: "^[0-9a-f]{40}$" }
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
blocked. The join waits for every branch; a blocked join ends at `stuck`
with every branch's result.
