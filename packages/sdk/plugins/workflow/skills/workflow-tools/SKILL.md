---
name: workflow-tools
description: Every argument of the Workflow tools, testing a revision, package definitions and the refusals you can fix. Load when a Workflow tool's short description is not enough.
---

# Workflow tools

The tools' declarations name their contract only; this skill has every
argument. `workflow-authoring` explains how to design a Workflow and
`workflow-reference` has every YAML field.

## workflow_definition

This session's definitions. Each has a name (its YAML's `metadata.name`) and
revisions 1, 2, 3: every save is a new revision, and a Workflow runs the
revision it started with.

| Operation | Arguments | Result |
|---|---|---|
| `list` | none | Your definitions, each with its `definition_id` and current revision; under `canStart`, the package definitions you may start (`newerVersion` when there is one). |
| `read` | `name` or `definition_id`, `revision?` (default the newest) | Its YAML, errors and the Workflows started from it. |
| `save` | `name`, `yaml`; to change one, `definition_id` and `expected_revision` | The next revision, with its errors. |
| `start` | `name` or `definition_id`, `revision?` (default the newest valid), `inputs`, `vars?`, `notify_on_completion?` (default true), `agent_models?`, `update?` | A new Workflow from that revision. |
| `test` | `name` or `definition_id`, `revision?`, `inputs`, `vars?`, `fixtures`, `expect?`, `test_id?` | A test report. |
| `card` | `name` (`<package>/<name>`) | A package definition's interface card. |

### Save

- A save based on an older revision is refused (`REVISION_STALE`): someone
  (the person, in the Workflow tab) saved since. Read again and redo your
  change on the newest revision.
- A revision with errors is saved and comes back with them; it cannot start.
  Fix the YAML and save again on that revision (its `expected_revision`).
  Never save under another name to get past an error, or to change or rerun
  a definition: a new name makes a new definition.
- When the person saves a revision in the Workflow tab, your next turn
  starts with a note saying so: read the definition before you change it.
- `metadata.version` is a label you may raise; revisions order the history.

### Start

- Each start makes another Workflow, and many Workflows of one definition
  may run at once. To run it again ("another one", "run it again"), call
  `start` again: a second Workflow never needs the first stopped.
- A running Workflow keeps the revision it started with. To run a change,
  start the new revision and tell the person it is a new Workflow of that
  revision, not an update of the running one. The old Workflow runs until it
  is stopped: ask the person whether to stop it.
- `notify_on_completion`: leave it true when you must handle the result; use
  false when the person only needs to look at the Workflow.
- `agent_models`: leave it out, so every agent node uses this session's model,
  reasoning effort and context. Give it only when the person asks for a
  model, or a package card's model hint for a node asks for a kind of model,
  reasoning or context. Map the agent node's id (its key under `states:`;
  one key covers every item of a For each) to `{ model, reasoning_effort?,
  context_tier? }`, with an exact `provider:model` from
  `list_available_models` and an effort or tier that model lists, and tell
  the person what you chose. The model is checked against the owning session's
  catalog (its agent nodes spend as that session's owner): an id that is not an
  agent node of that revision, or a model, effort or tier the catalog does
  not have, refuses the start.

### Package definitions

A package's definition is named `<package>/<name>` (such as
`release-tools/release-watch`) and is locked: you start it, you never save
it (`DEFINITION_LOCKED`). `list` shows the ones you may start under
`canStart`. Read its `card` first (what it does, its inputs with an
example, how it ends, what it asks and sends you), ask the person for any
input you lack, and start it by its `<package>/<name>`. `update: true`
starts the package's newer version when `list` shows `newerVersion`.

### Test a revision

Test only when the user asks (for example "test it before you start it")
or before you publish it in a package; never on your own, and `start`
never needs a test. `test` runs the revision to its end in a hidden test
that is not a Workflow: its scripts run for real (files, network), waits
pass at once, and each tool call, agent step, send and request takes a
prepared answer from `fixtures`. A call with no prepared answer fails the
test, which names it.

A fixture is `{ operation?, tool or state, arguments?, visit?, response:
{ kind, value } }`:

- `operation`: `tool.call` (the default; `tool` names the tool), `agent`,
  `send`, `request` or `receive` (`state` names the step). Without
  `arguments` it answers any call of that tool or step; an agent, send or
  request step's `arguments` are its input.
- `visit` (1 or more): it answers only the n-th time the run reaches that
  state (counted in its own branch or item); a tool call's visit is its
  script step's. A fixture with the visit wins over one without. Use it
  for loops: one answer per round.
- `receive`: the message a receive step gets, as `value` (no `arguments`).
  The test gives it as a real message (from the step's `from`, else you)
  before its wait passes. Without one, a receive with `wait` elapses at
  once; one without `wait` fails the test.
- `kind: success`, and the value has the shape of its step: a tool call's
  result; an agent step's `{ outcome, output }`; a request step's
  `{ response }` or `{ decline: { reason } }`; a send step's any value; a
  receive's message, as its contract's schema says.
- `kind: error`, value `{ code, message }` (a runtime error code such as
  `execution_failed`), or `kind: cancel`; a receive takes only success.

```yaml
- { operation: agent, state: classify, response: { kind: success, value: { outcome: bug, output: { label: "bug" } } } }
- { operation: request, state: approve, response: { kind: success, value: { response: { approved: true } } } }
- { operation: receive, state: await_event, visit: 2, response: { kind: success, value: { buildId: 7, state: succeeded } } }
- { tool: post_status, arguments: { text: done }, response: { kind: success, value: "posted" } }
```

A script's call of a tool this session does not have is answered by its
fixture too (no real call is made); the report lists it in
`needsToolAtRunTime`: a run of the revision needs that tool. Without a
fixture such a call fails as it would in a run. Control tools (such as
`spawn_agent`) are always refused.

`expect`: the terminal state id or the outcome (`succeeded`, `blocked`,
`failed`, `cancelled`) the test must end at; default outcome `succeeded`.
The test passes when it ends there with nothing unanswered or refused. An
`expect` the revision has no end for is refused before the test starts.

An answer of the wrong shape fails the test, which says the shape it needs.
The report gives the `path` taken (each step's `visit`, outcome and output;
`enteredBy`: the step and route it came from; `branch`: its named branch or
`item N` of a For each; `input`: a preview), the first error, `answeredCalls`,
`needsToolAtRunTime` and the time used. A call with no answer is in
`unanswered`, whose `fixture` is the exact fixture to add: replace its
`<...>` value. After a failed test, tell the person what failed. To fix it,
change the definition or its fixtures, save, and test again if the user
wants. Never say you fixed, saved or tested again when you did not: report
only what you ran. A test never tells you anything later:
its report is the answer. If it is still running, read it again with its
`test_id`.

## update_workflow

`workflow_id`, `operation`, `operation_id` (a new one for each change; a
retry reuses it) and the operation's arguments. It controls a Workflow's
run; to change or start a definition, use `workflow_definition`.

| Operation | Arguments | Effect |
|---|---|---|
| `set_vars` | `set?`, `delete?`, `expected_kv_revision`, `run_id?` | One atomic KV change. |
| `pause`, `resume`, `cancel` | `reason?`, `run_id?` | Run control. |
| `stop` | `reason?`, `grace_seconds?` (0 to 3,600, default 60), `run_id?` | Admits nothing new; admitted work settles; then the run ends `stopped`. |
| `recover` | `run_id?` | Ends or starts a run that `read_workflow` shows as `needsRecovery`. |

More on each operation:

- `set_vars`: `set` (`{ key: JSON value }`) and `delete` (keys) make one
  atomic change; `null` is a value, and deleting is explicit. A step that
  starts later reads the variables as `context.kv` or `${kv.key}`; a
  running step keeps the values it started with.
- `pause`: no new step starts; work already started finishes and keeps its
  result. `cancel`: a run that has not begun ends at once; otherwise
  `read_workflow` shows when it has ended.
- `recover`: a run whose controller stopped without ending it ends as
  failed (`controller_ended`) and its parent is told; a run accepted but
  never started is started; otherwise nothing changes.
- A repeated `operation_id` returns the original receipt; reusing it for
  another request is refused. A receipt shows the run as the command was
  accepted; `read_workflow` shows it now.

## read_workflow

`workflow_id`, `run_id?` (default live run),
`include_yaml?`, `limit?`, `cursor?` (a `run.pages` nextCursor: older
rows), `execution_id?` (its whole result). Shows the graph, runs, a
run's newest rows (open ones apart), KV, stop, `agent.childSessionId`,
branches. It is how you follow a run (`workflow-authoring`, Follow
a run): use it, not `list_sessions`, for a workflow's status.

Each section of a run (step executions, inbox, outbox)
holds its newest rows, oldest first, and lists its open rows apart however
old. `limit` sets the rows per page (default 200 executions, 50 inputs, 50
sent messages); give a section's `run.pages` `nextCursor` back as `cursor`
for its next, older page. Separate reads, each alone: `execution_id` (with
`run_id`: one step execution's whole output or error), `kv_revision` (that
revision of the variables; with `kv_key`, one variable whole),
`agent_versions` (the agent versions publishing would lock now),
`definition_revision` (one revision's YAML, hash and diagnostics) and
`step_input` (`{ state, input? }`: an agent step's input fields and where
each comes from; with `input`, the draft's YAML with only those inputs
changed). While a run is paused it shows `pausedFrom` and `pauseSettled`. A
delivered message was accepted by its recipient, not necessarily read.

## send_workflow_input

`workflow_id`, `contract` (`Name@version`, a message type a receive state
accepts), `payload` (valid for its schema), `correlation?` (equal to the
receive's `correlate` values), `run_id?` (default the live run),
`ttl_seconds?` (1 to 86,400, the default), `operation_id`. The input is
saved once per `operation_id`. A receive state that waits takes it now;
otherwise it stays, in order, until a receive state takes it or its time
passes, even if a receive elapsed first. You may send to the Workflows you
created, and to your user's when your session is that user's; a receive may
require a sender. The receipt: `messageId`, `requestSha256`,
`payloadSha256`, `acceptedAt`, `expiresAt` and `claimedBy` (the receive
state that took it, or null).

## respond_session_request

`request_id`, `operation_id`, and `response` or `decline: { reason }` (1 to
2,000 characters). Answer once, before the deadline; reply text is not an
answer. Refusals: `REQUEST_NOT_FOUND`, `REQUEST_EXPIRED`, `REQUEST_CLOSED`,
`RESPONSE_CONFLICT` (another answer came first), `OPERATION_CONFLICT`,
`RESPONSE_INVALID` and `OPERATION_LIMIT`.

## complete_workflow_node

An agent state's child finishes its state with it: `operation_id`, and
`outcome` with `output`, or `error: { code: needs_input or
execution_failed, message, details? }`.

## Refusals you can fix

| Code | Meaning |
|---|---|
| `DEFINITION_INVALID` | The revision has compile errors; read `diagnostics`. |
| `REVISION_STALE` | Someone saved since the revision you read; read the definition again and redo your change on the newest revision. |
| `SEMVER_IMMUTABLE`, `DEFINITION_IMMUTABLE` | A Workflow keeps its revision; it never changes. Save a new revision with `workflow_definition`, then start it. |
| `OPERATION_CONFLICT` | The `operation_id` was used for another request. |
| `LIVE_RUN_EXISTS` | This Workflow already has its live run. To run the definition again, `start` it again: each start is a new Workflow. |
| `WORKFLOW_YAML_TOO_LARGE`, `REVISION_LIMIT` | The YAML is over 256 KiB (save a shorter one), or the definition has 1,000 revisions, the most it keeps (nothing was saved; tell the person). |
| `KV_REVISION_CONFLICT` | Read `kvRevision` again. |
| `WORKFLOW_INPUT_INVALID`, `INPUT_INVALID` | Inputs or a payload do not match the schema; read the field errors. |
| `WORKFLOW_STORE_UNAVAILABLE` | The store cannot be reached or has no room now; try once more, then report the error as given. |
| `AGENT_UNAVAILABLE` | Publication could not pin a named agent. |
| `CONTRACT_MISMATCH` | The state is not exactly its agent's workflow interface; read `problems`. |
| `FORBIDDEN`, `WORKFLOW_NOT_FOUND` | `update_workflow` and `read_workflow` take only this session's Workflows: those started from its definitions, by you or the person. A person changes theirs in the Workflow tab. |
