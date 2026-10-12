# Building Workflows

This guide explains what a PilotSwarm workflow is and how to author one.

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

For runtime invariants, provider contracts, registration, and execution
internals, read [Workflow Sessions](./developer/building/workflow-sessions.md).
