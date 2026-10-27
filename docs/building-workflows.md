# Building Workflows

This guide explains when to use a PilotSwarm workflow and how to author,
register, test, run, and debug one. It is written for workflow users and
authors; it does not require knowledge of PilotSwarm's orchestration internals.

## What is a workflow?

A workflow is a versioned state machine for durable, non-conversational work.
Its YAML declares:

- the inputs required to start the workflow;
- the states that perform work or wait for input;
- the outcomes each state may produce; and
- deterministic transitions from one state to the next.

Workflow execution survives process and worker replacement. PilotSwarm records
each accepted state result before evaluating its transition, so an author does
not need to implement persistence, retry orchestration, or recovery logic.

Authoring a workflow means creating its YAML, deterministic transition modules,
and any agents bundled with it. Environment-specific operations and credentials
belong behind deployment-registered providers rather than in the workflow
package.

### When is a workflow the right fit?

Use a workflow when the work has an explicit process that should:

- survive worker or process replacement;
- move through named, inspectable states;
- wait durably for a person or external condition;
- apply external actions with stable idempotency;
- follow deterministic, reviewable transition rules; or
- deduplicate repeated requests for the same logical entity.

Use a normal agent session instead when the task is exploratory, conversational,
or does not benefit from a predefined state machine. A workflow may still use
agents for individual states; the workflow owns control flow while each agent
owns the judgment required by its state.

### End-to-end lifecycle

1. Author the workflow package in source control.
2. Register a repository URL, Git ref, and workflow YAML path.
3. PilotSwarm resolves the ref to an immutable commit and returns a
   `definitionId`.
4. Start that definition directly, or give its ID to an agent that can call
   `spawn_workflow`.
5. Inspect the workflow projection, topology, and state executions while it
   runs.

## 1. Choose a package layout

A workflow directory contains the workflow YAML and every transition module it
references:

```text
approval-workflow/
├── workflow.yaml
├── transitions.mjs
├── plugin.json
└── agents/
    └── reviewer.agent.md
```

`plugin.json` and `agents/` are required only when the workflow bundles agents.
An external-package-only workflow may contain just its YAML, transition modules,
and any helper modules those transitions import.

When bundling agents, declare all shipped files in `plugin.json`:

```json
{
  "name": "approval-workflow-agents",
  "version": "1.0.0",
  "description": "Agents used by the approval workflow.",
  "agents": [
    "agents/reviewer.agent.md"
  ],
  "include": [
    "workflow.yaml",
    "transitions.mjs"
  ]
}
```

Agent packages follow the complete
[Building a Package for PilotSwarm](./building-agent-packages.md) contract.
At minimum, the bundled agent must declare the workflow result tool:

```markdown
---
name: reviewer
description: Reviews one workflow input and returns a declared outcome.
version: 1.0.0
schemaVersion: 1
tools:
  - submit_workflow_result
---

Review the supplied workflow input. Finish by calling
submit_workflow_result with one of the outcomes declared by the current state.
```

## 2. Author the workflow YAML

This example runs a bundled agent and then terminates:

```yaml
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow

metadata:
  name: approval-workflow
  version: 1.0.0

inputs:
  changeId:
    type: string
    required: true

identity:
  primaryKey:
    - inputs.changeId

initial: review

states:
  review:
    type: agent
    agent: reviewer
    input:
      changeId: ${inputs.changeId}
    result:
      schema: approval/review/v1
    completion:
      mode: one-shot
      outcomes:
        - approved
        - rejected
    transition:
      handler:
        module: ./transitions.mjs
        export: afterReview

  approved:
    type: terminal
    outcome: succeeded
    output: ${states.review.result}

  rejected:
    type: terminal
    outcome: blocked
    output: ${states.review.result}
```

Required top-level fields:

| Field | Meaning |
|---|---|
| `apiVersion` | Currently `pilotswarm.dev/v1alpha1`. |
| `kind` | Must be `Workflow`. |
| `metadata.name` | Stable workflow name. |
| `metadata.version` | Definition version. `name@version` is the graph identity. |
| `initial` | ID of the first state. |
| `states` | Non-empty map of state IDs to state declarations. |

`inputs` is optional. A declared input may be `string`, `number`, `integer`, or
`boolean`, and may be marked `required`. Templates may reference inputs as
`${inputs.changeId}`.

`identity.primaryKey` is optional. Its entries must reference required scalar
inputs. PilotSwarm uses the resulting value to detect duplicate logical
executions independently from request idempotency.

## 3. Write deterministic transitions

Every non-terminal state references a synchronous export. The export declares
all possible target states and returns an `advance` directive:

```javascript
export const afterReview = {
  allowedTargets: ["approved", "rejected"],
  handler: context => ({
    kind: "advance",
    target: context.stateOutcome === "approved"
      ? "approved"
      : "rejected"
  })
};
```

Transition handlers receive immutable workflow inputs, configuration, the
accepted state outcome and output, latest state outputs, and ordered execution
history. They must:

- be synchronous;
- return `{ kind: "advance", target: "<declared-target>" }`;
- select only a target in `allowedTargets`; and
- avoid external I/O, time, randomness, mutable globals, and credentials.

External I/O belongs in an `action` or `observed-condition` provider, not a
transition.

## 4. Choose agent package bindings

### Bundle an agent with the workflow

Omit `agentPackage`:

```yaml
review:
  type: agent
  agent: reviewer
  # ...
```

The workflow registration publishes the directory's `plugin.json` agent
package. The package inherits the workflow's user/shared scope and owner.

### Reference an independently registered package

Add an explicit logical package selector:

```yaml
review:
  type: agent
  agent: reviewer
  agentPackage:
    name: shared-review-agents
    scope: shared
  # ...
```

Publish that package first:

```text
pilotswarm agents push ./review-agents --shared
```

Registration verifies that the package is enabled and its active version
declares `reviewer`. It stores the logical package ID. Each workflow run then
pins an exact immutable package version, so activation of a newer package
version does not change an already admitted run.

A workflow may mix bundled and independently registered packages across its
agent states.

Ownership rules:

- a **user workflow** may use that owner's user packages and any shared package;
- a **shared workflow** may use shared packages only; and
- user package names are resolved only in the workflow owner's namespace.

## 5. Understand the supported states

| State | Purpose |
|---|---|
| `agent` | Starts a package-bound child agent and waits for a declared structured result. |
| `question` | Waits durably for a caller with session-write permission to answer. |
| `action` | Invokes a deployment-registered provider operation. |
| `observed-condition` | Polls a deployment-registered provider using durable timers. |
| `terminal` | Completes the workflow with an outcome and optional output. |

Action and observation provider names are deployment-defined opaque
identifiers. Workflow packages do not contain provider credentials. See
[Workflow Sessions](./developer/building/workflow-sessions.md) for the provider
contracts and execution model.

## 6. Store the workflow in source control

Commit the workflow YAML, transition modules, and bundled package files
together. Registration identifies the package with:

- a repository URL;
- a branch, tag, or commit in `gitRef`; and
- the path to the workflow YAML within the repository.

The workflow YAML's directory becomes the package root. PilotSwarm resolves the
requested ref to an immutable commit and snapshots the complete package.
Executions never fetch files from a moving branch.

Do not place credentials in the repository URL or registration request.
Deployments provide repository authentication through their configured source
resolver.

## 7. Register the workflow

Authenticate to the deployment and register the source-controlled package:

```text
pilotswarm workflows register \
  --api-url https://pilotswarm.example.test \
  --repo https://git.example.test/workflows.git \
  --ref refs/heads/main \
  --path approval-workflow/workflow.yaml \
  --user
```

Use `--shared` instead of `--user` to make the definition visible to every
authenticated user. User definitions are visible only to their owner and
administrators. Registration defaults to user scope.

The command returns an immutable `definitionId`. Save that ID in the
configuration or agent instructions that will invoke the workflow.

List and inspect definitions visible to you:

```text
pilotswarm workflows list
pilotswarm workflows show <definition-id> --json
```

The equivalent API request is:

```http
POST /api/v1/workflow-definitions
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "scope": "user",
  "source": {
    "kind": "git",
    "repositoryUrl": "https://git.example.test/workflows.git",
    "gitRef": "refs/heads/main",
    "workflowPath": "approval-workflow/workflow.yaml"
  }
}
```

Registration compiles and validates the package. Registering identical content
again is idempotent. A changed definition must use a new `metadata.version`;
PilotSwarm does not replace different content under the same scoped
`name@version`.

## 8. Test a workflow

### Test transitions as ordinary code

Transition handlers are synchronous functions. Unit-test them directly with
representative accepted outcomes and outputs:

```javascript
import assert from "node:assert/strict";
import { afterReview } from "./transitions.mjs";

assert.deepEqual(afterReview.handler({
  stateOutcome: "approved"
}), {
  kind: "advance",
  target: "approved"
});
```

Cover every declared outcome and verify that the handler selects only one of
its `allowedTargets`. Keep transitions free of network calls, clocks,
randomness, filesystem access, and mutable global state.

### Test the compiled package privately

Register a development branch with `--user`, then use
`pilotswarm workflows show <definition-id> --json` to verify:

- the resolved commit is the commit you intended to test;
- every state and transition appears in the compiled manifest;
- each agent state is bound to the expected logical package; and
- the workflow scope is `user`.

Start the definition with test inputs and a unique idempotency key. Inspect its
state executions as described below. Publish a shared definition only after the
user-scoped definition behaves as expected.

Registration is also the authoritative package-validation boundary. Invalid
YAML, missing transition exports, undeclared agents, invalid package ownership,
and unsupported state declarations fail before a definition can be started.

## 9. Start a standalone workflow

Use the `definitionId` returned by registration:

```http
POST /api/v1/workflows
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "definitionId": "<definition-id>",
  "inputs": {
    "changeId": "change-42"
  },
  "model": "team:gpt-5.3-codex",
  "idempotencyKey": "approval-change-42"
}
```

The SDK exposes the same operation:

```javascript
const started = await client.startWorkflow({
  definitionId,
  inputs: { changeId: "change-42" },
  model: "team:gpt-5.3-codex",
  idempotencyKey: "approval-change-42",
  visibility: "private"
});

console.log(started.sessionId);
```

`model` is optional. When supplied, PilotSwarm validates it for the caller,
persists the resolved provider-qualified model on the workflow session, and
uses it for every agent state in that run. The registered workflow definition
remains model-independent.

An idempotency key identifies a retry of the same start request. Reusing it for
different inputs or a different model is rejected. If the workflow declares
`identity.primaryKey`, PilotSwarm also deduplicates starts for the same logical
entity independently from request idempotency.

To intentionally rerun a workflow with a primary key, include a reason:

```json
{
  "rerun": {
    "reason": "Retry after repairing the external dependency."
  }
}
```

## 10. Start a workflow from an agent

Agents may start only previously registered workflow definitions. They cannot
submit inline workflow YAML or bypass registration.

The `spawn_workflow` tool accepts:

```json
{
  "definition": {
    "kind": "registered",
    "definition_id": "<definition-id>"
  },
  "inputs": {
    "changeId": "change-42"
  }
}
```

Put the stable definition ID and invocation guidance in the calling agent's
instructions. For example:

```markdown
When a change requires the approval process, call `spawn_workflow` with
registered definition `<definition-id>` and pass the change ID as
`inputs.changeId`.

Use `check_workflows` when you can continue other work while it runs. Use
`wait_for_workflows` when you cannot proceed until the workflow completes.
```

Workflows started through `spawn_workflow` inherit the calling session's
persisted model. The tool does not expose a separate model override, which
keeps the user-selected parent model consistent across the workflow run.

`spawn_workflow` creates a child workflow session and returns its session ID in
the agent's follow-up context. `check_workflows` reports current statuses and
available terminal results. `wait_for_workflows` durably suspends the parent
conversation until the selected workflow children complete.

The calling user must be able to see the registered definition. A private user
definition cannot be invoked by another user merely because its ID is known.

## 11. Inspect and debug executions

Use the workflow session ID returned by a standalone start or child invocation.

| Purpose | API |
|---|---|
| Current state, wait reason, and terminal result | `GET /api/v1/workflows/:sessionId` |
| Sanitized topology and per-state status | `GET /api/v1/workflows/:sessionId/overview` |
| Authoritative state executions in order | `GET /api/v1/workflows/:sessionId/executions` |
| Answer the currently pending question | `POST /api/v1/workflows/:sessionId/questions/:executionSequence/answer` |

The SDK management client exposes the corresponding methods:

```javascript
const current = await management.getWorkflow(sessionId);
const overview = await management.getWorkflowOverview(sessionId);
const executions = await management.listWorkflowExecutions(sessionId);
```

Start with the current projection:

- `currentStateId` identifies the active or last state;
- `currentExecutionSequence` identifies the current attempt;
- `waitingOn` explains whether the workflow is waiting on an agent, question,
  action, observation, or timer;
- `status` reports running or terminal state; and
- `terminalOutcome` and `result` are populated when complete.

Then inspect ordered executions to find the accepted outcome and output for
each state. Because transitions consume accepted state results, the execution
immediately before an unexpected transition is the primary debugging record.

For a pending question, answer the exact current execution sequence:

```javascript
await management.answerWorkflowQuestion(
  sessionId,
  current.currentExecutionSequence,
  "approved",
  { approvedBy: "operator" }
);
```

Common registration failures:

| Error | Meaning |
|---|---|
| `WORKFLOW_YAML_INVALID` | The workflow YAML could not be parsed. |
| `WORKFLOW_STATE_TYPE_UNSUPPORTED` | The compiler does not support a declared state type. |
| `WORKFLOW_TRANSITION_*` | A transition module, export, target, or result is invalid. |
| `WORKFLOW_AGENT_NOT_DECLARED` | The selected package does not declare the state's agent. |
| `WORKFLOW_AGENT_PACKAGE_UNAVAILABLE` | A selected package is missing, disabled, or has no active version. |
| `WORKFLOW_AGENT_PACKAGE_SCOPE_INVALID` | Workflow and agent-package ownership are incompatible. |
| `WORKFLOW_DEFINITION_CONFLICT` | Different content already uses the same scoped `name@version`. |
| `WORKFLOW_GIT_REPOSITORY_REFUSED` | The deployment does not allow the requested repository. |

For platform architecture, provider implementation contracts, and durability
invariants, read [Workflow Sessions](./developer/building/workflow-sessions.md).
